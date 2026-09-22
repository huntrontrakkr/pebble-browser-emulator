// Applies the spike's changes to an upstream checkout: only libpebble3 and the
// two modules it builds from are included, and libpebble3 gains a browser target.
import { readdir, readFile, writeFile } from 'node:fs/promises';
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

// Round 6: Room 2 has no browser build, but Room 3 (androidx.room3) ships
// wasmJs and js, and androidx.sqlite has a web driver. Storage moves to Room 3
// for every target: same annotations and DAOs under a renamed package.
await edit('gradle/libs.versions.toml', (s) =>
  s
    .replace(/^room = "[^"]+"/m, 'room = "3.0.3"')
    .replace(/^sqlite = "[^"]+"/m, 'sqlite = "2.7.1"')
    .replace('id = "androidx.room"', 'id = "androidx.room3"')
    .replace(/"androidx\.room:room-/g, '"androidx.room3:room3-')
    .replace(
      /^(sqlite-bundled = .*)$/m,
      '$1\nsqlite-web = { module = "androidx.sqlite:sqlite-web", version.ref = "sqlite" }',
    ),
);
await edit('blobdbgen/src/main/kotlin/coredev/BlobDbEntityProcessor.kt', (s) =>
  // Every generated reference, including the ForeignKey import added with
  // addImport (round 10 found generated entities still importing androidx.room).
  s.replaceAll('"androidx.room"', '"androidx.room3"'),
);
const kotlinFiles = async function* (path) {
  for (const entry of await readdir(join(dir, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* kotlinFiles(child);
    else if (entry.name.endsWith('.kt')) yield child;
  }
};
for await (const file of kotlinFiles('libpebble3/src')) {
  const source = await readFile(join(dir, file), 'utf8');
  if (/\bandroidx\.room\./.test(source)) await edit(file, (s) => s.replace(/\bandroidx\.room\./g, 'androidx.room3.'));
}
await edit('libpebble3/build.gradle.kts', (s) =>
  s
    // Room 3's Gradle extension is named room3 (round 6 stopped here).
    .replace(/^room \{/m, 'room3 {')
    // Room's processor needs the entities blobdbgen generates first, as the
    // Android and iOS processors already do (round 7 stopped here).
    .replace(
      /(\n\s*tasks\.named\("kspAndroidMain"\) \{\n\s*dependsOn\("kspCommonMainKotlinMetadata"\)\n\s*\})/,
      '$1\n    tasks.matching { it.name == "kspKotlinWasmJs" }.configureEach {\n        dependsOn("kspCommonMainKotlinMetadata")\n    }',
    )
    // Round 10: with PHONE_SPIKE_ROOM_PROCESSOR=off the browser build skips
    // Room's processor, so the compiler names the types it reports missing.
    .replace(/(\n\s*add\("kspAndroid", libs\.room\.compiler\))/, (line) =>
      process.env.PHONE_SPIKE_ROOM_PROCESSOR === 'off'
        ? line
        : line + '\n    add("kspWasmJs", libs.room.compiler)',
    )
    .replace(
      /(\n\s*commonTest\.dependencies \{)/,
      '\n        wasmJsMain.dependencies {\n            implementation(libs.sqlite.web)\n        }\n$1',
    ),
);

// Round 3: libraries with no browser variant (now bundled SQLite and kmp-io)
// move to a source set only the native targets use, so the browser compile
// names every file that depends on them.
const nonWeb = [
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
