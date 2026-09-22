// Applies the spike's changes to an upstream checkout: only libpebble3 and the
// two modules it builds from are included, and libpebble3 gains a browser target.
//
// PHONE_SPIKE_ROOM selects storage for the browser:
//   2 (default)  upstream keeps the Room 2 it ships; only the browser build uses a
//                Room 2 compiled from Room's released sources (room2-web/).
//   3            rounds 6-12: upstream storage rewritten for Room 3 on every target.
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: patch.mjs <upstream checkout>');
const room = process.env.PHONE_SPIKE_ROOM ?? '2';
if (room !== '2' && room !== '3') throw new Error(`PHONE_SPIKE_ROOM must be 2 or 3, not ${room}`);
const roomProcessor = process.env.PHONE_SPIKE_ROOM_PROCESSOR !== 'off';
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

// Libraries with no browser variant move to a source set only the Android,
// desktop and iOS targets use (round 3), so the browser compile names every file
// that depends on them. Room stays in common code as upstream has it: blobdbgen's
// common pass needs its annotations (round 19 generated 4 of 9 entities without).
const nonWeb = [
  'implementation(libs.sqlite.bundled)',
  'implementation(libs.kmpio)',
];
const browserDependencies =
  room === '2' ? ['implementation(project(":room2web"))'] : ['implementation(libs.sqlite.web)'];

if (room === '3') {
  // Round 6: Room 3 (androidx.room3) ships wasmJs and js, and androidx.sqlite has a
  // web driver: same annotations and DAOs under a renamed package.
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
    if (/\bandroidx\.room\./.test(source))
      await edit(file, (s) =>
        s
          .replace(/\bandroidx\.room\./g, 'androidx.room3.')
          // Room 3 renamed the column converter annotations (round 10).
          .replace(/\bTypeConverters\b/g, 'ColumnTypeConverters')
          .replace(/\bTypeConverter\b/g, 'ColumnTypeConverter'),
      );
  }
  // Room 3's Gradle extension is named room3 (round 6 stopped here).
  await edit('libpebble3/build.gradle.kts', (s) => s.replace(/^room \{/m, 'room3 {'));
} else {
  // Round 16: the shim is a module of this build, compiled only for the browser
  // from Room's and androidx.sqlite's released sources (room2-sources.sh).
  const here = dirname(fileURLToPath(import.meta.url));
  await cp(join(here, 'room2-web'), join(dir, 'room2web'), { recursive: true });
  const sources = resolve(process.env.ROOM2_SOURCES ?? 'tmp/phone-spike/room2');
  await writeFile(join(dir, 'room2web', 'sources.path'), sources + '\n');
  await edit('settings.gradle.kts', (s) => s + '\ninclude(":room2web")\n');
  // Only the browser build resolves Room and androidx.sqlite to the shim; the
  // processor classpaths (ksp*) keep the real Room compiler.
  await edit('libpebble3/build.gradle.kts', (s) =>
    s +
      `
// Phone spike: Room 2 has no browser build, so the browser target resolves it to
// room2web, built from Room's and androidx.sqlite's released sources.
configurations.matching { it.name.startsWith("wasmJs") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        listOf(
            "androidx.room:room-runtime",
            "androidx.room:room-common",
            "androidx.room:room-paging",
            "androidx.sqlite:sqlite",
        ).forEach {
            substitute(module(it)).using(project(":room2web")).because("no browser build of Room 2")
        }
    }
}
`,
  );
  // Browser adapters for libpebble3 itself, in a source set upstream never edits.
  await cp(join(here, 'libpebble3-web'), join(dir, 'libpebble3/src/wasmJsMain/kotlin'), {
    recursive: true,
  });
}

await edit('libpebble3/build.gradle.kts', (s) => {
  for (const line of nonWeb)
    s = s.replace(new RegExp('^\\s*' + line.replace(/[().]/g, '\\$&') + '\\s*\\n', 'm'), '');
  return (
    s
      .replace(
        /(\n\s*commonTest\.dependencies \{)/,
        `
        wasmJsMain.dependencies {
${browserDependencies.map((l) => '            ' + l).join('\n')}
        }
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
      )
      // Room's processor needs the entities blobdbgen generates first, as the
      // Android and iOS processors already do (round 7).
      .replace(
        /(\n\s*tasks\.named\("kspAndroidMain"\) \{\n\s*dependsOn\("kspCommonMainKotlinMetadata"\)\n\s*\})/,
        '$1\n    tasks.matching { it.name == "kspKotlinWasmJs" }.configureEach {\n        dependsOn("kspCommonMainKotlinMetadata")\n    }',
      )
      // Round 10: with PHONE_SPIKE_ROOM_PROCESSOR=off the browser build skips
      // Room's processor, so the compiler names the types it reports missing.
      .replace(/(\n\s*add\("kspAndroid", libs\.room\.compiler\))/, (line) =>
        roomProcessor ? line + '\n    add("kspWasmJs", libs.room.compiler)' : line,
      )
  );
});
