#!/usr/bin/env bash
# For each storage library libpebble3 uses, prints the newest releases on
# Google's Maven repository and which Kotlin targets the newest one ships
# (from its Gradle module metadata), so a browser-capable version is visible.
set -uo pipefail
maven=https://dl.google.com/android/maven2
for artifact in androidx/room/room-runtime androidx/room/room-paging \
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
