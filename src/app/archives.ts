import { APP_PLATFORMS, LEGACY_APP_CHOICES, type AppPlatform } from './watch-profiles.ts';
import { Gunzip, Unzip, UnzipInflate } from 'fflate';
import { stm32Crc } from './pebble-transport.ts';
import { crc32, zipDirectory } from './integrity.ts';
import { safePath } from './projects.ts';
export const MAX_ARCHIVE = 80 * 1024 * 1024,
  MAX_EXPANDED = 128 * 1024 * 1024;
export function unzipBounded(bytes: Uint8Array, limit = MAX_EXPANDED): Record<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE) throw new Error('Archive exceeds 80 MiB.');
  const directory = zipDirectory(bytes, limit);
  const files: Record<string, Uint8Array> = Object.create(null);
  let total = 0,
    count = 0;
  const complete = new Set<string>();
  let error: Error | undefined;
  const archive = new Unzip((file) => {
    if (file.name.endsWith('/')) {
      if (!safePath(file.name.slice(0, -1)))
        error = new Error('Archive contains an unsafe directory path.');
      return;
    }
    const entry = directory.get(file.name);
    if (!entry) {
      error = new Error('ZIP local entry is not listed in its directory.');
      return;
    }
    if (!safePath(file.name) || Object.hasOwn(files, file.name)) {
      error = new Error('Archive contains an unsafe or duplicate path.');
      return;
    }
    if (++count > 4096 || (file.originalSize ?? 0) > limit) {
      error = new Error('Archive exceeds extraction limits.');
      return;
    }
    files[file.name] = new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (failure, data, final) => {
      if (failure) {
        error = failure;
        return;
      }
      total += data.length;
      size += data.length;
      if (total > limit) {
        file.terminate();
        error = new Error('Expanded archive exceeds size limit.');
        return;
      }
      chunks.push(data);
      if (final) {
        const result = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          result.set(c, offset);
          offset += c.length;
        }
        if (result.length !== entry.size || crc32(result) !== entry.crc) {
          error = new Error('ZIP entry size or CRC is invalid: ' + file.name);
          return;
        }
        files[file.name] = result;
        complete.add(file.name);
      }
    };
    try {
      file.start();
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
  });
  archive.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 32768) {
    archive.push(bytes.subarray(i, i + 32768), i + 32768 >= bytes.length);
    if (error) throw error;
  }
  if ([...directory.keys()].some((p) => !p.endsWith('/') && !complete.has(p)))
    throw new Error('ZIP contains incomplete file data.');
  return files;
}
export function untarGzip(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > MAX_ARCHIVE) throw new Error('SDK archive exceeds 80 MiB.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > MAX_EXPANDED) throw new Error('Expanded SDK exceeds 128 MiB.');
    chunks.push(chunk);
  });
  for (let i = 0; i < bytes.length; i += 32768)
    gunzip.push(bytes.subarray(i, i + 32768), i + 32768 >= bytes.length);
  const tar = new Uint8Array(total);
  let cursor = 0;
  for (const c of chunks) {
    tar.set(c, cursor);
    cursor += c.length;
  }
  if (
    bytes.length < 18 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      bytes.length - 8,
      true,
    ) !== crc32(tar) ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      bytes.length - 4,
      true,
    ) !==
      tar.length >>> 0
  )
    throw new Error('SDK gzip checksum or size is invalid.');
  const decoder = new TextDecoder();
  const string = (start: number, length: number) =>
    decoder.decode(tar.subarray(start, start + length)).split('\0')[0];
  const files: Record<string, Uint8Array> = Object.create(null);
  let count = 0;
  for (let at = 0; at + 512 <= tar.length;) {
    if (tar.subarray(at, at + 512).every((v) => v === 0)) break;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : tar[at + i];
    if (checksum !== parseInt(string(at + 148, 8).trim(), 8))
      throw new Error('TAR header checksum is invalid.');
    const size = parseInt(string(at + 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
      throw new Error('Malformed TAR entry.');
    const name = string(at, 100);
    const prefix = string(at + 345, 155);
    const path = (prefix ? prefix + '/' : '') + name;
    const type = tar[at + 156];
    if ((type === 0 || type === 48) && !path.endsWith('/')) {
      if (!safePath(path) || Object.hasOwn(files, path) || ++count > 12000)
        throw new Error('SDK contains unsafe/duplicate paths or too many files.');
      files[path] = tar.slice(at + 512, at + 512 + size);
    }
    // Directories and archive metadata are not executable source. Links are never followed.
    if (type === 49 || type === 50)
      throw new Error('SDK archive contains symbolic/hard links; use a resolved archive.');
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    !Object.keys(files).some((p) =>
      /(?:^|\/)pebble\/(aplite|basalt|chalk|diorite|emery|flint|gabbro)\/include\/pebble\.h$/.test(
        p,
      ),
    )
  )
    throw new Error('No Pebble SDK headers found in this archive.');
  return files;
}
export interface PackageInfo {
  kind: 'app' | 'firmware';
  name: string;
  platforms: string[];
  manifest: Record<string, unknown>;
  files: Record<string, Uint8Array>;
}
export function inspectPackage(bytes: Uint8Array): PackageInfo {
  const files = unzipBounded(bytes);
  const decoder = new TextDecoder();
  const manifests = Object.keys(files).filter(
    (p) => p === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(p),
  );
  if (!manifests.length) throw new Error('Package has no manifest.json.');
  const parsed = manifests.map((p) => {
    const m = JSON.parse(decoder.decode(files[p]));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Invalid manifest.');
    return { path: p, value: m };
  });
  const firmware = parsed.find((m) => m.value.firmware);
  const appinfo = files['appinfo.json'] ? JSON.parse(decoder.decode(files['appinfo.json'])) : null;
  return {
    kind: firmware ? 'firmware' : 'app',
    name:
      appinfo?.shortName ??
      appinfo?.longName ??
      firmware?.value.firmware?.friendlyVersion ??
      'Imported package',
    platforms: parsed.map((m) => (m.path.includes('/') ? m.path.split('/')[0] : 'root')),
    manifest: firmware?.value ?? parsed[0].value,
    files,
  };
}

/** Select the requested platform and verify each part before UART installation. */
export function appPackage(
  bytes: Uint8Array,
  platform: AppPlatform,
): {
  app: Uint8Array;
  resources?: Uint8Array;
  worker?: Uint8Array;
  script: string;
  appinfo: Record<string, any>;
  selectedPlatform: AppPlatform | 'root';
  compatibility: 'native' | 'legacy';
} {
  const info = inspectPackage(bytes);
  if (info.kind !== 'app') throw new Error('Select an app PBW, not a firmware PBZ.');
  const files = info.files;
  if (!Object.hasOwn(APP_PLATFORMS, platform)) throw new Error('Unknown app platform.');
  // Current generic firmware can install older builds unchanged. Prefer the
  // closest display family, while keeping the actual source platform visible.
  const native = !!files[platform + '/manifest.json'];
  const legacyChoice = LEGACY_APP_CHOICES[platform]?.find(
    (candidate) => !!files[candidate + '/manifest.json'],
  );
  const selectedPlatform: AppPlatform | 'root' = native
    ? platform
    : (legacyChoice ??
      (platform !== 'gabbro' && LEGACY_APP_CHOICES[platform] && files['manifest.json']
        ? 'root'
        : platform));
  const prefix = selectedPlatform === 'root' ? '' : selectedPlatform + '/';
  if (!files[prefix + 'manifest.json'])
    throw new Error('This PBW has no ' + platform + ' manifest.');
  const legacy = selectedPlatform !== platform;
  const appinfo = files['appinfo.json']
    ? JSON.parse(new TextDecoder().decode(files['appinfo.json']))
    : {};
  if (legacy) {
    const declared = appinfo.targetPlatforms;
    if (
      declared !== undefined &&
      (!Array.isArray(declared) ||
        (selectedPlatform !== 'root' && !declared.includes(selectedPlatform)))
    )
      throw new Error('Legacy PBW manifest conflicts with its declared target platforms.');
    const sdk = appinfo.sdkVersion;
    if (sdk !== undefined && !['2', '3'].includes(String(sdk)))
      throw new Error('Legacy PBW requires an SDK 2/3 source package.');
  }
  const manifest = JSON.parse(new TextDecoder().decode(files[prefix + 'manifest.json']));
  const part = (key: string, required = false): Uint8Array | undefined => {
    const descriptor = manifest[key];
    if (!descriptor) {
      if (required) throw new Error('PBW has no application binary.');
      return;
    }
    if (typeof descriptor.name !== 'string' || !safePath(descriptor.name))
      throw new Error('Invalid PBW part path.');
    const data = files[prefix + descriptor.name];
    if (!data || data.length !== descriptor.size || stm32Crc(data) !== descriptor.crc)
      throw new Error('PBW part size or CRC mismatch: ' + key);
    return data;
  };
  const app = part('application', true)!;
  const validate = (binary: Uint8Array, label: string) => {
    if (binary.length < 130 || ![80, 66, 76, 65, 80, 80, 0, 0].every((v, i) => binary[i] === v))
      throw new Error('Invalid PBW ' + label + ' header.');
    const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
    const flags = view.getUint32(96, true);
    const encodedPlatform = (flags >> 6) & 15;
    const expected = selectedPlatform === 'root' ? 1 : APP_PLATFORMS[selectedPlatform].id;
    if (encodedPlatform !== expected && !(encodedPlatform === 0 && legacy))
      throw new Error(
        'This ' +
          label +
          ' targets a different watch platform; ' +
          selectedPlatform +
          ' is required.',
      );
    return flags;
  };
  const flags = validate(app, 'application');
  const worker = part('worker');
  if (Boolean(flags & 0x10) !== Boolean(worker))
    throw new Error('PBW background worker flag does not match its contents.');
  if (worker) {
    const workerFlags = validate(worker, 'worker');
    if (!(workerFlags & 0x10) || !app.subarray(104, 120).every((v, i) => worker[104 + i] === v))
      throw new Error('PBW worker does not belong to this application.');
  }
  return {
    app,
    resources: part('resources'),
    worker,
    script: files['pebble-js-app.js'] ? new TextDecoder().decode(files['pebble-js-app.js']) : '',
    appinfo,
    selectedPlatform,
    compatibility: legacy ? 'legacy' : 'native',
  };
}

/** Compatibility alias for existing callers. */
export const emeryAppPackage = (bytes: Uint8Array) => appPackage(bytes, 'emery');
