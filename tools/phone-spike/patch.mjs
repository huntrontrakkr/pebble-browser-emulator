// Applies the spike's changes to an upstream checkout: only libpebble3 and the
// two modules it builds from are included, and libpebble3 gains a browser target.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: patch.mjs <upstream checkout>');
const edit = async (path, change) => {
  const file = join(dir, path);
  const before = await readFile(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`Spike patch did not apply to ${path}`);
  await writeFile(file, after);
};

// The app, iOS and AI modules need Firebase, CocoaPods and native toolchains the
// spike does not; libpebble3 depends only on these two.
await edit('settings.gradle.kts', (s) =>
  s.replace(/^include\(":(?!libpebble3"|blobdbgen"|blobannotations")[^"]+"\)\n/gm, ''),
);

await edit('libpebble3/build.gradle.kts', (s) =>
  s.replace(
    /^(\s*)jvm\(\)\s*$/m,
    '$1jvm()\n$1@OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)\n$1wasmJs { browser() }',
  ),
);
