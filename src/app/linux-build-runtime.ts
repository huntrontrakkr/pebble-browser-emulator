import {
  WASI,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
  type Inode,
} from '@bjorn3/browser_wasi_shim';
import { boundBuildMemory } from './wasm-memory-limit.ts';
import { safePath } from './projects.ts';
import { parseBuildRecipe, recipeScript, shellQuote } from './build-recipe.ts';

export const BUILD_LIMITS = {
  memoryPages: 24576,
  filesystemBytes: 256 * 1048576,
  files: 20000,
  descriptors: 4096,
  outputBytes: 64 * 1048576,
  logBytes: 2 * 1048576,
} as const;
export interface LinuxBuildInput {
  image: Uint8Array;
  recipe: string;
  platform: string;
  sourceFiles: Record<string, Uint8Array>;
  inputs?: Record<string, Uint8Array>;
}
export const digestBytes = async (b: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b.slice().buffer)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');

/** Batch console: no terminal input, sockets, host files, or host JavaScript execution.
 * Polling uses WASI's 48-byte subscription / 32-byte event layouts. The Linux console
 * stays open while its guest entrypoint runs. Parent Worker termination cancels waits. */
export function installBatchPoll(wasi: WASI): void {
  wasi.wasiImport['poll_oneoff'] = (
    input: number,
    output: number,
    count: number,
    result: number,
  ) => {
    const view = new DataView(wasi.inst.exports.memory.buffer);
    if (count < 1 || count > 64) return 28;
    const now = performance.now();
    let deadline = Infinity;
    const events: { userdata: bigint; type: number; error: number; end: number; ready: boolean }[] =
      [];
    for (let i = 0; i < count; i++) {
      const p = input + i * 48,
        type = view.getUint8(p + 8);
      const event = {
        userdata: view.getBigUint64(p, true),
        type,
        error: 0,
        end: Infinity,
        ready: false,
      };
      if (type === 0) {
        const clock = view.getUint32(p + 16, true),
          flags = view.getUint16(p + 40, true);
        if (clock > 1 || flags > 1) return 28;
        const timeout = Number(view.getBigUint64(p + 24, true)) / 1e6;
        event.end = flags ? (clock === 0 ? now + timeout - Date.now() : timeout) : now + timeout;
        deadline = Math.min(deadline, event.end);
      } else if (type === 1 || type === 2) {
        const fd = view.getUint32(p + 16, true);
        if (!wasi.fds[fd]) {
          event.error = 8;
          event.ready = true;
        } else if (type === 2 || fd !== 0) event.ready = true;
      } else return 28;
      events.push(event);
    }
    if (!events.some((e) => e.ready)) {
      if (!Number.isFinite(deadline)) return 6;
      // Synchronous Wasm requires a synchronous wait. This code only runs in the
      // disposable build Worker; it does not require SharedArrayBuffer or block UI.
      while (performance.now() < deadline) {}
    }
    let n = 0;
    for (const e of events)
      if (e.ready || performance.now() >= e.end) {
        const p = output + n++ * 32;
        new Uint8Array(view.buffer, p, 32).fill(0);
        view.setBigUint64(p, e.userdata, true);
        view.setUint16(p + 8, e.error, true);
        view.setUint8(p + 10, e.type);
      }
    view.setUint32(result, n, true);
    return 0;
  };
}

/** Enforce growth limits before the shim allocates file buffers. The virtual filesystem
 * is private to this invocation. No OPFS handles or user directory handles are exposed. */
export function limitFilesystem(wasi: WASI, initialBytes: number, initialFiles: number): void {
  let total = initialBytes,
    creations = initialFiles;
  const wrapped = new WeakSet<OpenFile>();
  const wrap = () => {
    for (const fd of wasi.fds)
      if (fd instanceof OpenFile && !wrapped.has(fd)) {
        wrapped.add(fd);
        for (const method of [
          'fd_allocate',
          'fd_filestat_set_size',
          'fd_write',
          'fd_pwrite',
        ] as const) {
          const original = (fd[method] as Function).bind(fd);
          (fd as any)[method] = (...args: any[]) => {
            const old = fd.file.data.length;
            const requested =
              method === 'fd_allocate'
                ? args[0] + args[1]
                : method === 'fd_filestat_set_size'
                  ? args[0]
                  : (method === 'fd_pwrite' ? args[1] : fd.file_pos) + BigInt(args[0].length);
            const size = Number(requested),
              growth = Math.max(0, size - old);
            if (
              !Number.isSafeInteger(size) ||
              size < 0 ||
              size > BUILD_LIMITS.filesystemBytes ||
              total + growth > BUILD_LIMITS.filesystemBytes
            )
              return method === 'fd_write' || method === 'fd_pwrite'
                ? { ret: 51, nwritten: 0 }
                : 51;
            if (fd.file.readonly)
              return method === 'fd_write' || method === 'fd_pwrite' ? { ret: 8, nwritten: 0 } : 8;
            const result = original(...args);
            // pwrite calls fd_write internally; account only in the inner write.
            if (method !== 'fd_pwrite') total += fd.file.data.length - old;
            return result;
          };
        }
      }
  };
  wrap();
  const open = wasi.wasiImport['path_open']!,
    mkdir = wasi.wasiImport['path_create_directory']!;
  wasi.wasiImport['path_open'] = (...args: any[]) => {
    if (wasi.fds.length >= BUILD_LIMITS.descriptors) return 33;
    if (args[4] & 1 && ++creations > BUILD_LIMITS.files) return 51;
    const result = open(...args);
    wrap();
    return result;
  };
  wasi.wasiImport['path_create_directory'] = (...args: any[]) =>
    ++creations > BUILD_LIMITS.files ? 51 : mkdir(...args);
}

function filesystem(files: Record<string, Uint8Array>): {
  root: Map<string, Inode>;
  bytes: number;
  count: number;
} {
  const root = new Map<string, Inode>();
  let bytes = 0,
    count = 0;
  for (const [path, data] of Object.entries(files)) {
    if (!safePath(path) || path.length > 4096 || !(data instanceof Uint8Array))
      throw new Error('Invalid sandbox input path: ' + path);
    bytes += data.length;
    count++;
    if (bytes > BUILD_LIMITS.filesystemBytes || count > BUILD_LIMITS.files)
      throw new Error('Sandbox inputs exceed the filesystem quota.');
    const parts = path.split('/');
    let dir = root;
    for (const name of parts.slice(0, -1)) {
      let inode = dir.get(name);
      if (!inode) {
        inode = new Directory(new Map());
        dir.set(name, inode);
        count++;
        if (count > BUILD_LIMITS.files)
          throw new Error('Sandbox input directory count exceeds its quota.');
      }
      if (!(inode instanceof Directory))
        throw new Error('Input file overlaps a directory: ' + path);
      dir = inode.contents;
    }
    const name = parts.at(-1)!;
    if (dir.has(name)) throw new Error('Duplicate sandbox file: ' + path);
    dir.set(name, new File(data.slice()));
  }
  return { root, bytes, count };
}
async function fileManifest(files: Record<string, Uint8Array>) {
  const entries = [];
  for (const path of Object.keys(files).sort())
    entries.push({ path, bytes: files[path]!.length, sha256: await digestBytes(files[path]!) });
  return {
    sha256: await digestBytes(new TextEncoder().encode(JSON.stringify(entries))),
    files: entries,
  };
}

export async function runLinuxBuild(input: LinuxBuildInput, log: (text: string) => void) {
  const recipe = parseBuildRecipe(input.recipe);
  if (!/^[a-z0-9_-]{1,32}$/.test(input.platform)) throw new Error('Invalid build platform.');
  if (input.image.length > 512 * 1048576) throw new Error('Build image exceeds 512 MiB.');
  const imageHash = await digestBytes(input.image);
  if (recipe.imageSha256 && recipe.imageSha256 !== imageHash)
    throw new Error('Build image SHA-256 does not match the recipe.');
  const bounded = boundBuildMemory(input.image, BUILD_LIMITS.memoryPages);
  const [module, boundedHash] = await Promise.all([
    WebAssembly.compile(bounded.slice().buffer),
    digestBytes(bounded),
  ]);
  if (
    WebAssembly.Module.imports(module).some(
      (i) => i.module !== 'wasi_snapshot_preview1' || i.kind !== 'function',
    )
  )
    throw new Error('Build image may only import WASI functions.');
  // Run on the guest's POSIX filesystem, then copy explicitly declared artifacts out.
  // This permits chmod, symlinks, subprocesses and native tools inside Linux.
  const outputs = new Map<string, Inode>();
  if (Object.hasOwn(input.inputs ?? {}, 'build.sh'))
    throw new Error('build.sh is reserved for the sandbox launcher.');
  const source = filesystem(input.sourceFiles),
    imports = filesystem(input.inputs ?? {});
  if (
    source.bytes + imports.bytes > BUILD_LIMITS.filesystemBytes ||
    source.count + imports.count > BUILD_LIMITS.files
  )
    throw new Error('Combined inputs exceed the filesystem quota.');
  const sourceManifest = await fileManifest(input.sourceFiles),
    inputManifest = await fileManifest(input.inputs ?? {});
  const guestScript = recipeScript(recipe, input.platform).replace(
    "cd '/work",
    "cd '/tmp/pebble-project",
  );
  const script = [
    'set -eu',
    'mkdir -p /tmp/pebble-project',
    'cp -R /work/. /tmp/pebble-project/',
    guestScript,
    ...recipe.outputs.map((path, i) => `cp -- ${shellQuote(path)} /outputs/${i}`),
    'printf complete > /outputs/complete',
    '',
  ].join('\n');
  imports.root.set('build.sh', new File(new TextEncoder().encode(script), { readonly: true }));
  let logged = 0;
  const decoder = new TextDecoder();
  const stdout = new ConsoleStdout((bytes) => {
    const remaining = BUILD_LIMITS.logBytes - logged;
    if (remaining > 0) log(decoder.decode(bytes.subarray(0, remaining), { stream: true }));
    logged += bytes.length;
    if (remaining > 0 && logged >= BUILD_LIMITS.logBytes) log('\n[Build log limit reached]\n');
  });
  const wasi = new WASI(
    ['pebble-build', '-no-stdin', '-entrypoint', '/bin/sh', '--', '/inputs/build.sh'],
    [],
    [
      new OpenFile(new File([])),
      stdout,
      stdout,
      new PreopenDirectory('/work', source.root),
      new PreopenDirectory('/inputs', imports.root),
      new PreopenDirectory('/outputs', outputs),
    ],
    { debug: false },
  );
  installBatchPoll(wasi);
  limitFilesystem(
    wasi,
    source.bytes + imports.bytes + script.length,
    source.count + imports.count + 1,
  );
  for (const i of WebAssembly.Module.imports(module))
    if (!wasi.wasiImport[i.name]) throw new Error('Unsupported WASI import: ' + i.name);
  log('Starting local Linux build…\n');
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(instance as Parameters<WASI['start']>[0]);
  if (exitCode !== 0) throw new Error('Linux build exited with status ' + exitCode + '.');
  const completion = outputs.get('complete');
  if (!(completion instanceof File) || new TextDecoder().decode(completion.data) !== 'complete')
    throw new Error(
      'Linux exited before completing the build recipe. Check its log and guest memory/disk limits.',
    );
  const artifacts: Record<string, Uint8Array> = Object.create(null);
  let outputBytes = 0;
  recipe.outputs.forEach((name, i) => {
    const file = outputs.get(String(i));
    if (!(file instanceof File)) throw new Error('Build did not produce ' + name + '.');
    outputBytes += file.data.length;
    if (outputBytes > BUILD_LIMITS.outputBytes) throw new Error('Build artifacts exceed 64 MiB.');
    artifacts[name] = file.data.slice();
  });
  return {
    artifacts,
    record: {
      version: 1,
      backend: 'linux-wasi',
      imageHash,
      boundedHash,
      platform: input.platform,
      recipe,
      exitCode,
      limits: BUILD_LIMITS,
      sourceManifest,
      inputManifest,
      outputManifest: await fileManifest(artifacts),
    },
  };
}
