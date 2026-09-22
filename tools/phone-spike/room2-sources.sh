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
