// The linked libpebble3 library as one browser module, shared by the spike's browser run
// (bundle.mjs) and the application's copy (../publish.mjs).
import { build } from 'esbuild-wasm';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stubMissingModules } from '../load.mjs';

/** Bundles the distribution at `dist` into `out/libpebble3.js`, with its .wasm beside it. */
export async function bundleLibrary(dist, out) {
  await mkdir(out, { recursive: true });
  // The library imports npm modules by name, which a browser cannot resolve, so it is
  // bundled with them. `ws` is Node's WebSocket; in a browser ktor uses the page's own,
  // so it stands in as an empty module. skiko stands in as functions that throw.
  // Round 40: the import object also reaches Node's own modules; see `external` below.
  await stubMissingModules(dist);
  const entry = [];
  for (const name of await readdir(dist)) {
    if (!name.endsWith('.mjs') || name.includes('.import-object') || name.includes('js-builtins'))
      continue;
    if ((await readFile(join(dist, name), 'utf8')).includes('phoneStart')) entry.push(name);
  }
  if (entry.length !== 1) throw new Error(`expected one entry module in ${dist}: ${entry}`);
  const wsStub = join(await mkdtemp(join(tmpdir(), 'libpebble3-')), 'ws.mjs');
  await writeFile(wsStub, 'export default {};\n');
  await build({
    entryPoints: { libpebble3: join(dist, entry[0]) },
    outdir: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: { ws: wsStub },
    // Node's own modules, which the library's runtime imports only when it runs under
    // Node (ktor's sockets, the require shim). Left as imports, a browser reaching one
    // fails loudly there.
    external: ['node:*'],
    logLevel: 'warning',
  });
  for (const name of await readdir(dist))
    if (name.endsWith('.wasm')) await cp(join(dist, name), join(out, name));
}
