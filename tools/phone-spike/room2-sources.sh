#!/usr/bin/env bash
# Can the Room 2 release upstream ships run in the browser? Room 2.8.x publishes no
# browser build, but its multiplatform runtime is Kotlin over androidx.sqlite, which
# does. This lists, from the released sources jars, each source set and the
# platform-only APIs its non-Android code uses, and checks what the annotation
# processor says about platforms.
set -uo pipefail
version="${ROOM2_VERSION:-2.8.4}"
maven=https://dl.google.com/android/maven2/androidx/room
work=tmp/phone-spike/room2
rm -rf "$work" && mkdir -p "$work"

for module in room-common room-runtime room-paging; do
  jar="$work/$module-sources.jar"
  if ! curl -fsS -o "$jar" "$maven/$module/$version/$module-$version-sources.jar"; then
    echo "$module $version: no sources jar"
    continue
  fi
  dir="$work/$module"
  mkdir -p "$dir" && unzip -q -o "$jar" -d "$dir"
  echo "== $module $version source sets (Kotlin files)"
  find "$dir" -name '*.kt' | sed "s|^$dir/||" | cut -d/ -f1 | sort | uniq -c | sed 's/^/  /'
  echo "-- platform-only imports outside Android and JVM source sets"
  find "$dir" -name '*.kt' -not -path "*/androidMain/*" -not -path "*/jvmMain/*" \
    -not -path "*/jvmAndroidMain/*" -print0 |
    xargs -0 grep -hoE '^import (kotlinx\.cinterop|platform\.|java\.|javax\.|android\.)[A-Za-z0-9_.]*' 2>/dev/null |
    sort | uniq -c | sort -rn | head -30 | sed 's/^/  /'
  echo "-- expect declarations in common code"
  find "$dir" -path '*commonMain*' -name '*.kt' -print0 |
    xargs -0 grep -hE '^\s*(internal |public )?expect ' 2>/dev/null | sed 's/^\s*/  /' | head -60
done

compiler="$work/room-compiler.jar"
if curl -fsS -o "$compiler" "$maven/room-compiler/$version/room-compiler-$version.jar"; then
  echo "== room-compiler $version: messages that mention platforms or targets"
  unzip -q -o "$compiler" -d "$work/compiler"
  find "$work/compiler" -name '*.class' -print0 |
    xargs -0 strings -n 20 2>/dev/null |
    grep -iE 'non-android|platform|kotlin/js|wasm|native target|not supported' |
    sort -u | head -40 | sed 's/^/  /'
fi

# Round 13 found only posix file locking outside common code. Round 14: does the
# shared JVM/native runtime block (a browser cannot), and does the SQLite API that
# Room 2 calls keep blocking statements on the browser, or only suspending ones?
echo "== room-runtime $version blocking calls outside Android"
find "$work/room-runtime" -name '*.kt' -not -path '*/androidMain/*' -print0 |
  xargs -0 grep -nE 'runBlocking|Thread\.sleep|\.await\(\)|Dispatchers\.IO' 2>/dev/null |
  sed "s|^$work/room-runtime/||" | head -30 | sed 's/^/  /'
echo "-- room-runtime $version jvmNativeMain files"
find "$work/room-runtime" -path '*jvmNativeMain*' -name '*.kt' | sed "s|^$work/room-runtime/||" | sed 's/^/  /'
# Room 2.8.4 was built against androidx.sqlite before 2.7 moved the blocking API out
# of common code (round 16), so the shim uses the newest 2.6 release.
sqlite="${SQLITE_VERSION:-$(curl -fsS https://dl.google.com/android/maven2/androidx/sqlite/sqlite/maven-metadata.xml |
  grep -o '<version>2\.6\.[0-9]*</version>' | sed 's/<[^>]*>//g' | tail -1)}"
echo "== androidx.sqlite for the shim: $sqlite"
for module in sqlite sqlite-web; do
  jar="$work/$module-sources.jar"
  curl -fsS -o "$jar" "https://dl.google.com/android/maven2/androidx/sqlite/$module/$sqlite/$module-$sqlite-sources.jar" || {
    echo "$module $sqlite: no sources jar"; continue; }
  dir="$work/$module" && mkdir -p "$dir" && unzip -q -o "$jar" -d "$dir"
  echo "== androidx $module $sqlite source sets"
  find "$dir" -name '*.kt' | sed "s|^$dir/||" | cut -d/ -f1 | sort | uniq -c | sed 's/^/  /'
  echo "-- driver, connection and statement API per source set"
  find "$dir" -name '*.kt' -print0 |
    xargs -0 grep -nE '(fun|interface|class) .*(SQLiteDriver|SQLiteConnection|SQLiteStatement)|fun (open|prepare|step|close|execSQL)\b' 2>/dev/null |
    sed "s|^$dir/||" | head -60 | sed 's/^/  /'
done

# Round 15: the shim needs the exact platform files it replaces for the browser, and
# each module's dependencies on its non-Android, non-JVM variant.
for module in room-common room-runtime room-paging sqlite; do
  dir="$work/$module"
  [ -d "$dir" ] || continue
  for set in nativeMain; do
    find "$dir/$set" -name '*.kt' 2>/dev/null | sort | while read -r file; do
      echo "===== FILE $module/${file#$dir/}"
      grep -vE '^\s*$|^ \*|^/\*|^\s*\*' "$file"
    done
  done
done
for module in room/room-common room/room-runtime room/room-paging sqlite/sqlite; do
  name=${module#*/}
  ver=$version
  [ "$name" = sqlite ] && ver=$sqlite
  echo "===== DEPS $name $ver linuxX64"
  curl -fsS "https://dl.google.com/android/maven2/androidx/$module/$ver/$name-$ver.module" |
    node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const v=m.variants.find(v=>/linuxX64.*Api|linuxx64.*api/i.test(v.name))||m.variants.find(v=>/linux/i.test(v.name));
      console.log("  variant", v&&v.name);
      for (const d of (v&&v.dependencies)||[]) console.log("  ", d.group+":"+d.module, d.version&&(d.version.requires||d.version.strictly||d.version.prefers));'
done

# Round 27: kmp-io's released sources (Apache-2.0, Maven Central) for kmpio-web.
kmpio="${KMPIO_VERSION:-0.3.0}"
echo "== kmp-io $kmpio sources"
mkdir -p "$work/kmpio"
curl -fsS -o "$work/kmpio-sources.jar" \
  "https://repo1.maven.org/maven2/io/github/skolson/kmp-io/$kmpio/kmp-io-$kmpio-sources.jar" &&
  unzip -q -o "$work/kmpio-sources.jar" -d "$work/kmpio" &&
  find "$work/kmpio" -name '*.kt' | sed "s|^$work/kmpio/||" | cut -d/ -f1 | sort | uniq -c | sed 's/^/  /'

# Round 34: kotlinx-io's released wasmJs sources (Apache-2.0, Maven Central) for
# kotlinxio-web. patch.mjs checks this is the version upstream pins.
kotlinxio="${KOTLINXIO_VERSION:-0.9.1}"
echo "== kotlinx-io $kotlinxio wasmJs sources"
mkdir -p "$work/kotlinxio"
curl -fsS --retry 4 --retry-delay 10 -o "$work/kotlinxio-sources.jar" \
  "https://repo1.maven.org/maven2/org/jetbrains/kotlinx/kotlinx-io-core-wasm-js/$kotlinxio/kotlinx-io-core-wasm-js-$kotlinxio-sources.jar" &&
  unzip -q -o "$work/kotlinxio-sources.jar" -d "$work/kotlinxio" &&
  echo "$kotlinxio" > "$work/kotlinxio.version" &&
  find "$work/kotlinxio" -name '*.kt' | sed "s|^$work/kotlinxio/||" | cut -d/ -f1 | sort | uniq -c | sed 's/^/  /'
