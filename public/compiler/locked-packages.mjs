// SPDX-License-Identifier: Apache-2.0
// Only immutable, integrity-checked npm archives are read. Lifecycle scripts never run.
import { unzipBounded } from './archive-tools.mjs';
import { normalizePath } from './pkjs-bundler.mjs';
const text = new TextDecoder();
const MAX_COMPRESSED = 8 * 1048576,
  MAX_EXPANDED = 32 * 1048576;
async function readBounded(stream, limit) {
  if (!stream) throw new Error('Package response has no body.');
  const reader = stream.getReader(),
    chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Package exceeds size limit.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
export async function verifyIntegrity(bytes, integrity) {
  const matches = String(integrity ?? '')
    .split(/\s+/)
    .map((v) => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(v))
    .filter(Boolean);
  if (!matches.length)
    throw new Error('Package needs SHA-256, SHA-384, or SHA-512 integrity in package-lock.json.');
  const ranks = { sha512: 3, sha384: 2, sha256: 1 };
  matches.sort((a, b) => ranks[b[1]] - ranks[a[1]]);
  const strongest = matches[0][1];
  const hash = new Uint8Array(await crypto.subtle.digest(strongest.replace('sha', 'SHA-'), bytes));
  const actual = btoa(String.fromCharCode(...hash));
  if (!matches.some((m) => m[1] === strongest && m[2] === actual))
    throw new Error('Package integrity mismatch.');
}
export async function unpackPackage(bytes) {
  if (bytes.length > MAX_COMPRESSED) throw new Error('Package exceeds compressed size limit.');
  const tar = await readBounded(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    MAX_EXPANDED,
  );
  const files = Object.create(null);
  const string = (at, size) => text.decode(tar.subarray(at, at + size)).split('\0')[0];
  let count = 0,
    terminated = false;
  for (let at = 0; at + 512 <= tar.length;) {
    if (tar.subarray(at, at + 512).every((v) => v === 0)) {
      terminated = true;
      break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : tar[at + i];
    if (checksum !== parseInt(string(at + 148, 8).trim(), 8))
      throw new Error('Invalid package TAR checksum.');
    const size = parseInt(string(at + 124, 12).trim(), 8),
      type = tar[at + 156];
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
      throw new Error('Truncated package TAR entry.');
    const prefix = string(at + 345, 155),
      name = (prefix ? prefix + '/' : '') + string(at, 100);
    if (type === 0 || type === 48) {
      if (!name.startsWith('package/')) throw new Error('Unexpected npm archive root.');
      const path = name.slice(8);
      if (!path || normalizePath(path) !== path || Object.hasOwn(files, path) || ++count > 2048)
        throw new Error('Unsafe, duplicate, or excessive npm archive paths.');
      files[path] = tar.slice(at + 512, at + 512 + size);
    } else if (type !== 53) {
      throw new Error('Unsupported npm archive entry; links and extended paths are not followed.');
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated || !files['package.json']) throw new Error('Incomplete npm package archive.');
  return files;
}
export async function loadLockedPackages({ sourceFiles, request = fetch, signal, log = () => {} }) {
  const root = sourceFiles['package.json']
    ? JSON.parse(text.decode(sourceFiles['package.json']))
    : {};
  if (!Object.keys(root.dependencies ?? {}).length) return sourceFiles;
  if (!sourceFiles['package-lock.json'])
    throw new Error(
      'JavaScript dependencies require package-lock.json v2/v3. Generate and commit the lockfile, then re-import.',
    );
  const lock = JSON.parse(text.decode(sourceFiles['package-lock.json']));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.[''])
    throw new Error('Use package-lock.json version 2 or 3.');
  for (const [name, version] of Object.entries(root.dependencies)) {
    if (
      lock.packages[''].dependencies?.[name] !== version ||
      !lock.packages['node_modules/' + name]
    )
      throw new Error('package-lock.json does not match dependency ' + name + '.');
  }
  const candidates = Object.entries(lock.packages).filter(([path, value]) => path && !value.dev);
  if (candidates.length > 64) throw new Error('JavaScript dependency graph exceeds 64 packages.');
  const files = Object.assign(Object.create(null), sourceFiles);
  let total = 0,
    count = 0;
  for (const [path, pkg] of candidates) {
    if (
      !/^node_modules\/(?:@[\w.-]+\/)?[\w.-]+(?:\/node_modules\/(?:@[\w.-]+\/)?[\w.-]+)*$/.test(
        path,
      ) ||
      normalizePath(path) !== path ||
      pkg.link
    )
      throw new Error('Only registry npm dependencies are supported: ' + path);
    const url = new URL(pkg.resolved);
    if (
      url.origin !== 'https://registry.npmjs.org' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('.tgz')
    )
      throw new Error('Dependencies must use immutable registry.npmjs.org tarball URLs.');
    log('Reading locked dependency ' + path.slice(13) + '@' + pkg.version);
    const response = await request(url.href, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Dependency download failed: HTTP ' + response.status);
    const bytes = await readBounded(response.body, MAX_COMPRESSED);
    await verifyIntegrity(bytes, pkg.integrity);
    const contents = await unpackPackage(bytes);
    const meta = JSON.parse(text.decode(contents['package.json']));
    if (meta.version !== pkg.version)
      throw new Error('Dependency version does not match lockfile.');
    if (contents['binding.gyp'] || meta.gypfile)
      throw new Error('Native npm addons cannot run inside PebbleKit JS.');
    if (meta.pebble) {
      if (!contents['dist.zip'])
        throw new Error('Pebble dependency lacks the SDK dist.zip package: ' + meta.name);
      const built = unzipBounded(contents['dist.zip'], MAX_EXPANDED);
      for (const [name, data] of Object.entries(built)) {
        const destination = name.startsWith('dist/') ? name : 'dist/' + name;
        if (Object.hasOwn(contents, destination))
          throw new Error('Duplicate Pebble dependency output.');
        contents[destination] = data;
      }
      const nonemptyNative = Object.entries(contents).some(
        ([p, data]) =>
          p.startsWith('dist/binaries/') &&
          (data.length !== 8 || text.decode(data) !== '!<arch>\n'),
      );
      if (
        nonemptyNative ||
        Object.keys(contents).some((p) => /^dist\/(?:c|resources)\//.test(p)) ||
        (meta.pebble.resources?.media?.length ?? 0) ||
        Object.keys(meta.pebble.messageKeys ?? {}).length
      )
        throw new Error(
          'Native C and resource dependencies need the package-library build profile: ' + meta.name,
        );
    }
    for (const [name, data] of Object.entries(contents)) {
      total += data.length;
      if (total > MAX_EXPANDED || ++count > 8192)
        throw new Error('Expanded dependency graph exceeds size limit.');
      const destination = path + '/' + name;
      if (Object.hasOwn(files, destination))
        throw new Error('Dependency would overwrite an imported file.');
      files[destination] = data;
    }
  }
  return files;
}
