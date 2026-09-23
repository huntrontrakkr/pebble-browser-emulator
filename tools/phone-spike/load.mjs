// Loads the linked libpebble3 library as a page would: the SQLite Wasm build and fflate
// published first, then the entry module. Shared by run.mjs and e2e.mjs.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asLibPebbleModule, provideLibPebbleDependencies } from '../../src/app/libpebble-host.ts';

/** `dist` is the library distribution; `deps` holds @sqlite.org/sqlite-wasm and fflate. */
export async function loadPhone(dist, deps) {
  // Bare specifiers resolve from the importing file, so the imports live beside the packages.
  const loader = join(deps, 'deps.mjs');
  await writeFile(
    loader,
    "export { default as sqlite3InitModule } from '@sqlite.org/sqlite-wasm';\nexport * as fflate from 'fflate';\n",
  );
  const { sqlite3InitModule, fflate } = await import(pathToFileURL(resolve(loader)));
  provideLibPebbleDependencies({ sqlite3: await sqlite3InitModule(), fflate });
  console.log('SQLite', globalThis.sqlite3.version.libVersion);

  const entries = [];
  for (const name of await readdir(dist)) {
    if (!name.endsWith('.mjs') || name.includes('uninstantiated')) continue;
    if ((await readFile(join(dist, name), 'utf8')).includes('phoneStart')) entries.push(name);
  }
  if (entries.length !== 1) throw new Error(`expected one entry module in ${dist}: ${entries}`);
  // Compose's ImageBitmap brings imports from skiko, the Compose graphics runtime, which a
  // library distribution does not ship. List what the bundle imports from it and stand in
  // with functions that throw when called, so a use of it fails loudly instead of passing.
  const present = new Set(await readdir(dist));
  for (const name of present) {
    if (!name.endsWith('.import-object.mjs')) continue;
    const source = await readFile(join(dist, name), 'utf8');
    const missing = new Map();
    const add = (module, names) =>
      missing.set(module, new Set([...(missing.get(module) ?? []), ...names]));
    for (const [, binding, module] of source.matchAll(
      /import \* as (\w+) from '\.\/([\w.-]+\.mjs)'/g,
    ))
      if (!present.has(module))
        add(
          module,
          [...source.matchAll(new RegExp(binding + '\\.(\\w+)', 'g'))].map((m) => m[1]),
        );
    for (const [, list, module] of source.matchAll(/import \{([^}]*)\} from '\.\/([\w.-]+\.mjs)'/g))
      if (!present.has(module))
        add(
          module,
          list
            .split(',')
            .map((n) => n.trim().split(/\s+as\s+/)[0])
            .filter(Boolean),
        );
    for (const [module, set] of missing) {
      const names = [...set].sort();
      console.log(`missing ${module}: ${names.length} imports: ${names.join(' ')}`);
      await writeFile(
        join(dist, module),
        names
          .map(
            (n) => `export function ${n}() { throw new Error('${module} is not loaded: ${n}'); }`,
          )
          .join('\n') + '\n',
      );
    }
  }
  const phone = await import(pathToFileURL(resolve(dist, entries[0])));
  console.log('exports', Object.keys(phone).sort().join(', '));
  return asLibPebbleModule(phone);
}
