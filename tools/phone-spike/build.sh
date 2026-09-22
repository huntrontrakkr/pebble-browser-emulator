#!/usr/bin/env bash
# Compiles a prepared checkout's libpebble3 for the browser, logging to $2.
#
# blobdbgen runs in libpebble3's common-code pass, which only sees libraries that
# support every target. Room 2 has no browser build, so once the browser target
# exists that pass cannot resolve Room and skips the entities that use it
# (round 20). Its output depends only on upstream's sources, so it is generated
# once from upstream's own targets and reused by the browser build.
set -uo pipefail
checkout="$1"
log="$(realpath -m "$2")"
generated=tmp/phone-spike/blobdbgen-common
if [ ! -d "$generated" ]; then
  PHONE_SPIKE_BROWSER=off bash tools/phone-spike/prepare.sh tmp/phone-spike/native >/dev/null
  (cd tmp/phone-spike/native &&
    ./gradlew :libpebble3:kspCommonMainKotlinMetadata --no-daemon --console=plain \
      > ../blobdbgen.log 2>&1) || { echo "blobdbgen pass failed"; tail -40 tmp/phone-spike/blobdbgen.log; }
  mkdir -p "$generated"
  cp -r tmp/phone-spike/native/libpebble3/build/generated/ksp/metadata/commonMain/. "$generated/" 2>/dev/null
  echo "blobdbgen generated $(find "$generated" -name '*.kt' | wc -l) files from upstream's own targets"
fi
target="$checkout/libpebble3/build/generated/ksp/metadata/commonMain"
mkdir -p "$target" && cp -r "$generated/." "$target/"
(cd "$checkout" &&
  ./gradlew :libpebble3:compileKotlinWasmJs -x :libpebble3:kspCommonMainKotlinMetadata \
    --continue --no-daemon --console=plain > "$log" 2>&1)
echo "gradle exit $?"
