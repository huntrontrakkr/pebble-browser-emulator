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
// Room 3's processor handles the browser target; Room 2's code is generated for
// the desktop target and reused (see PHONE_SPIKE_BROWSER below).
const roomProcessor = (process.env.PHONE_SPIKE_ROOM_PROCESSOR ?? (room === '3' ? 'on' : 'off')) === 'on';
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

// PHONE_SPIKE_BROWSER=off stops here with upstream's own targets, for the
// generated code the browser build reuses (build.sh): blobdbgen's entities, and
// Room 2's code generated for the desktop (JVM) target, which uses the same
// multiplatform runtime as the browser. Room 2's processor cannot process the
// browser target itself: it reads Kotlin/Wasm's internal Any._hashCode as a
// column of every entity (round 21).
if (process.env.PHONE_SPIKE_BROWSER === 'off') {
  await edit('libpebble3/build.gradle.kts', (s) =>
    s
      .replace(/^\/\/(\s*add\("kspJvm", libs\.room\.compiler\))/m, '$1')
      .replace(
        /(\n\s*tasks\.named\("kspAndroidMain"\) \{\n\s*dependsOn\("kspCommonMainKotlinMetadata"\)\n\s*\})/,
        '$1\n    tasks.named("kspKotlinJvm") {\n        dependsOn("kspCommonMainKotlinMetadata")\n    }',
      ),
  );
  process.exit(0);
}

// libpebble3 and the annotation module it compiles against both need the target;
// round 1 stopped at blobannotations having none.
const addBrowserTarget = (s) =>
  s.replace(
    /^([ \t]*)jvm\(\)[ \t]*$/m,
    '$1jvm()\n$1@OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)\n$1wasmJs { browser() }',
  );
// libpebble3's browser target also links a library bundle, for its size (round 28).
await edit('libpebble3/build.gradle.kts', (s) =>
  addBrowserTarget(s).replace('wasmJs { browser() }', 'wasmJs { browser(); binaries.library() }'),
);
await edit('blobannotations/build.gradle.kts', addBrowserTarget);

// Round 26: shared code imports libpebble3's own runBlocking and Dispatchers.IO
// (util/PlatformBlocking.kt), which delegate to kotlinx.coroutines on Android,
// desktop and iOS and have browser versions. Only import lines change. Round 27
// does the same for Okio's FileSystem.SYSTEM and openZip (util/PlatformFileSystem.kt).
{
  const here = dirname(fileURLToPath(import.meta.url));
  await cp(join(here, 'libpebble3-common'), join(dir, 'libpebble3/src/commonMain/kotlin'), { recursive: true });
  await cp(join(here, 'libpebble3-nonweb'), join(dir, 'libpebble3/src/nonWebMain/kotlin'), { recursive: true });
  const files = async function* (path) {
    for (const entry of await readdir(join(dir, path), { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) yield* files(child);
      else if (entry.name.endsWith('.kt')) yield child;
    }
  };
  for await (const file of files('libpebble3/src/commonMain/kotlin')) {
    const source = await readFile(join(dir, file), 'utf8');
    const swapped = /^import (?:kotlinx\.coroutines\.(runBlocking|IO)|okio\.(SYSTEM|openZip))$/gm;
    if (swapped.test(source))
      await edit(file, (s) =>
        s.replace(swapped, (_, coroutines, okio) => `import io.rebble.libpebblecommon.util.${coroutines ?? okio}`),
      );
  }

  // Round 29: the browser's platform layer starts from upstream's desktop (JVM)
  // one, which is small and mostly stubs; files that use Java APIs, or that the
  // browser gives real values, come from libpebble3-web instead.
  const browserOwn = [
    'io/rebble/libpebblecommon/database/Database.jvm.kt',
    'util/DataBuffer.kt',
    'io/rebble/libpebblecommon/plugin/BundledPlugins.jvm.kt',
    'io/rebble/libpebblecommon/locker/Locker.jvm.kt',
    'io/rebble/libpebblecommon/util/TempFile.jvm.kt',
    'io/rebble/libpebblecommon/web/FirmwareDownloader.jvm.kt',
    'io/rebble/libpebblecommon/connection/devconnection/DevConnectionTransport.jvm.kt',
  ];
  const jvmMain = join(dir, 'libpebble3/src/jvmMain/kotlin');
  await cp(jvmMain, join(dir, 'libpebble3/src/wasmJsMain/kotlin'), {
    recursive: true,
    filter: (source) => !browserOwn.some((own) => source === join(jvmMain, own)),
  });

  // Round 27: kmp-io has no browser build either. Upstream uses only its byte
  // buffers, BitSet and byte-array extensions, which kmpio-web compiles from kmp-io's
  // released sources; the browser target resolves kmp-io to it, as with Room.
  await cp(join(here, 'kmpio-web'), join(dir, 'kmpioweb'), { recursive: true });
  const kmpio = resolve(process.env.KMPIO_SOURCES ?? 'tmp/phone-spike/room2/kmpio');
  await writeFile(join(dir, 'kmpioweb', 'sources.path'), kmpio + '\n');
  await edit('settings.gradle.kts', (s) => s + '\ninclude(":kmpioweb")\n');
  await edit('libpebble3/build.gradle.kts', (s) =>
    s +
      `
// Phone spike: kmp-io has no browser build; the browser target resolves it to kmpioweb.
configurations.matching { it.name.startsWith("wasmJs") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("io.github.skolson:kmp-io")).using(project(":kmpioweb")).because("no browser build of kmp-io")
    }
}
`,
  );
}

// Round 28: kotlinx-datetime 0.8 deprecates kotlinx.datetime.Instant for
// kotlin.time.Instant. The two are interchangeable on Android, desktop and iOS,
// where upstream compiles; in the browser they are distinct, and this file's
// rounding helper declares the old type but computes the new one. It moves to the
// new type, as kotlinx-datetime's migration asks.
await edit('libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/health/HealthDateTimeUtils.kt', (s) =>
  s.replace(/^import kotlinx\.datetime\.Instant$/m, 'import kotlin.time.Instant'),
);

// Libraries with no browser variant move to a source set only the Android,
// desktop and iOS targets use (round 3), so the browser compile names every file
// that depends on them. Room stays in common code as upstream has it: blobdbgen's
// common pass needs its annotations (round 19 generated 4 of 9 entities without).
const nonWeb = ['implementation(libs.sqlite.bundled)'];
const browserDependencies = [
  room === '2' ? 'implementation(project(":room2web"))' : 'implementation(libs.sqlite.web)',
  // The in-memory file system behind the browser's FileSystem.SYSTEM (round 27).
  'implementation("com.squareup.okio:okio-fakefilesystem:${libs.versions.okio.get()}")',
];

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
