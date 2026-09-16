// SPDX-License-Identifier: Apache-2.0
// Project JavaScript is parsed into an IIFE; it is never evaluated by this worker.
const decoder = new TextDecoder();
const asText = (value) => (typeof value === 'string' ? value : decoder.decode(value));
export function normalizePath(path) {
  if (typeof path !== 'string' || path.includes('\\') || /[\0-\x1f]/.test(path))
    throw new Error('Invalid module path.');
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Module path escapes the project.');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
const directory = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
function packageMain(meta) {
  // Match the common Browserify package entry convention used by Pebble projects.
  if (meta.browser && typeof meta.browser !== 'string')
    throw new Error(
      'Package browser path mappings need explicit support; use a bundled companion file.',
    );
  return meta.browser || meta.main || 'index.js';
}
export async function bundlePhone({ sourceFiles, esbuild, messageKeys = {}, log = () => {} }) {
  const files = Object.create(null);
  for (const [name, bytes] of Object.entries(sourceFiles)) {
    const path = normalizePath(name);
    if (path !== name || Object.hasOwn(files, path))
      throw new Error('Unsafe or duplicate module path: ' + name);
    files[path] = bytes;
  }
  const entry = files['src/pkjs/index.js']
    ? 'src/pkjs/index.js'
    : files['src/js/app.js']
      ? 'src/js/app.js'
      : null;
  if (!entry) {
    if (Object.keys(files).some((p) => /^src\/(?:pkjs|js)\/.*\.(?:[cm]?js|json)$/.test(p)))
      throw new Error('Companion entry must be src/pkjs/index.js or src/js/app.js.');
    return '';
  }
  const resolveFile = (path, seen = new Set()) => {
    path = normalizePath(path);
    if (seen.has(path)) throw new Error('Recursive package main: ' + path);
    seen.add(path);
    for (const suffix of ['', '.js', '.json', '.mjs', '.cjs'])
      if (Object.hasOwn(files, path + suffix)) return path + suffix;
    if (files[path + '/package.json']) {
      const metadata = JSON.parse(asText(files[path + '/package.json']));
      const main = metadata.pebble ? 'dist/js' : packageMain(metadata);
      if (typeof main !== 'string' || main.startsWith('/') || main.includes('..'))
        throw new Error('Invalid package main.');
      const candidate = resolveFile(path + '/' + main, seen);
      if (candidate) return candidate;
    }
    for (const suffix of ['/index.js', '/index.json', '/index.mjs', '/index.cjs'])
      if (Object.hasOwn(files, path + suffix)) return path + suffix;
    return undefined;
  };
  const resolveModule = (specifier, importer) => {
    if (specifier === 'message_keys') return '@pebble/message-keys';
    if (specifier === 'app_package.json') {
      const metadata = files['package.json']
        ? 'package.json'
        : files['appinfo.json']
          ? 'appinfo.json'
          : null;
      if (!metadata) throw new Error('SDK app_package.json alias requires project metadata.');
      return metadata;
    }
    if (specifier.startsWith('.')) return resolveFile(directory(importer) + '/' + specifier);
    if (specifier.startsWith('/') || specifier.includes(':'))
      throw new Error('External module URLs and Node built-ins are unavailable: ' + specifier);
    let current = directory(importer);
    for (;;) {
      const found = resolveFile((current ? current + '/' : '') + 'node_modules/' + specifier);
      if (found) return found;
      if (!current) break;
      current = directory(current);
    }
    throw new Error(
      'Module not found: ' +
        specifier +
        '. Import package-lock.json (v2/v3) with dependencies pinned to registry.npmjs.org.',
    );
  };
  log('Bundling PebbleKit JS modules in WebAssembly');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2015'],
    logLevel: 'silent',
    logOverride: {
      'unsupported-require-call': 'warning',
      'unsupported-dynamic-import': 'warning',
      'require-resolve-not-external': 'warning',
    },
    legalComments: 'inline',
    sourcemap: false,
    plugins: [
      {
        name: 'pebble-memory-files',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const path =
              args.kind === 'entry-point'
                ? resolveFile(args.path)
                : resolveModule(args.path, args.importer);
            if (!path) throw new Error('Module not found: ' + args.path + ' from ' + args.importer);
            return { path, namespace: 'pebble-project' };
          });
          build.onLoad({ filter: /.*/, namespace: 'pebble-project' }, (args) => {
            if (args.path === '@pebble/message-keys')
              return { contents: 'module.exports = ' + JSON.stringify(messageKeys), loader: 'js' };
            if (!/\.(?:[cm]?js|json)$/.test(args.path))
              throw new Error('Unsupported companion module type: ' + args.path);
            return {
              contents: asText(files[args.path]),
              loader: args.path.endsWith('.json') ? 'json' : 'js',
            };
          });
        },
      },
    ],
  });
  for (const warning of result.warnings) {
    // A dynamic require would otherwise fail only after the app was installed.
    if (
      [
        'unsupported-require-call',
        'unsupported-dynamic-import',
        'require-resolve-not-external',
      ].includes(warning.id)
    )
      throw new Error('Dynamic module loading is not supported: ' + warning.text);
    log('JavaScript warning: ' + warning.text);
  }
  const output = result.outputFiles[0].text;
  if (new TextEncoder().encode(output).length > 2 * 1048576)
    throw new Error('Bundled companion exceeds 2 MiB.');
  return output;
}
