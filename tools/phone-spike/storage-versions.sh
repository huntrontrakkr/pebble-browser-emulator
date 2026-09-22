#!/usr/bin/env bash
# For each storage library libpebble3 uses, prints the newest releases on
# Google's Maven repository and which Kotlin targets the newest one ships
# (from its Gradle module metadata), so a browser-capable version is visible.
set -uo pipefail
maven=https://dl.google.com/android/maven2
# Round 4 found browser builds of androidx.sqlite (2.8.0-alpha01, plus the
# sqlite-web driver) but none of androidx.room 2.8.x; the next Room major may
# be published under its own group, so those names are checked too.
for artifact in androidx/room/room-runtime androidx/room/room-paging \
  androidx/room3/room3-runtime androidx/room3/room3-paging androidx/room3/room3-compiler \
  androidx/sqlite/sqlite androidx/sqlite/sqlite-bundled androidx/sqlite/sqlite-web; do
  name=${artifact##*/}
  versions=$(curl -fsS "$maven/$artifact/maven-metadata.xml" 2>/dev/null |
    grep -o '<version>[^<]*' | cut -d'>' -f2)
  if [ -z "$versions" ]; then
    echo "$artifact: not published"
    continue
  fi
  latest=$(echo "$versions" | tail -1)
  echo "$artifact: newest $(echo "$versions" | tail -4 | tr '\n' ' ')"
  curl -fsS "$maven/$artifact/$latest/$name-$latest.module" 2>/dev/null |
    grep -o '"org.jetbrains.kotlin.platform.type": "[a-z_]*"\|"org.jetbrains.kotlin.wasm.target": "[a-z]*"\|"org.jetbrains.kotlin.js.compiler": "[a-z]*"' |
    sort | uniq -c | sed "s/^/    $latest /"
done

# Anything else under the androidx.room3 group, in case the names differ.
curl -fsS "$maven/androidx/room3/group-index.xml" 2>/dev/null | head -30 ||
  echo "androidx/room3: no group index"
