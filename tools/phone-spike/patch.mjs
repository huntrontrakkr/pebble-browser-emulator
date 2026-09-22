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

// libpebble3 and the annotation module it compiles against both need the target;
// round 1 stopped at blobannotations having none.
const addBrowserTarget = (s) =>
  s.replace(
    /^([ \t]*)jvm\(\)[ \t]*$/m,
    '$1jvm()\n$1@OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)\n$1wasmJs { browser() }',
  );
await edit('libpebble3/build.gradle.kts', addBrowserTarget);
await edit('blobannotations/build.gradle.kts', addBrowserTarget);

// Round 3: the four libraries with no browser variant (Room, its paging add-on,
// bundled SQLite and kmp-io) move to a source set only the native targets use,
// so the browser compile names every file that depends on them.
const nonWeb = [
  'implementation(libs.room.runtime)',
  'api(libs.room.paging)',
  'implementation(libs.sqlite.bundled)',
  'implementation(libs.kmpio)',
];
await edit('libpebble3/build.gradle.kts', (s) => {
  for (const line of nonWeb)
    s = s.replace(new RegExp('^\\s*' + line.replace(/[().]/g, '\\$&') + '\\s*\\n', 'm'), '');
  return s.replace(
    /(\n\s*commonTest\.dependencies \{)/,
    `
        val nonWebMain by creating {
            dependsOn(commonMain.get())
            dependencies {
${nonWeb.map((l) => '                ' + l).join('\n')}
            }
        }
        androidMain.get().dependsOn(nonWebMain)
        jvmMain.get().dependsOn(nonWebMain)
        findByName("iosMain")?.dependsOn(nonWebMain)
$1`,
  );
});
