#!/usr/bin/env bash
# Compiles a prepared checkout's libpebble3 for the browser, logging to $2.
#
# Two passes need upstream's own targets, so they run once on a checkout without
# the browser target and their output is reused:
# - blobdbgen runs in the common-code pass, which only sees libraries that support
#   every target; with the browser target it cannot see Room 2 and skips the
#   entities that use it (round 20).
# - Room 2's processor reads Kotlin/Wasm's internal Any._hashCode as a column of
#   every entity (round 21). Its code for the desktop (JVM) target uses the same
#   multiplatform runtime as the browser, so that code is reused.
set -uo pipefail
checkout="$1"
log="$(realpath -m "$2")"
native=tmp/phone-spike/native
common=tmp/phone-spike/generated/blobdbgen
room=tmp/phone-spike/generated/room
if [ ! -d "$common" ]; then
  PHONE_SPIKE_BROWSER=off bash tools/phone-spike/prepare.sh "$native" >/dev/null
  (cd "$native" &&
    ./gradlew :libpebble3:kspCommonMainKotlinMetadata :libpebble3:kspKotlinJvm \
      --no-daemon --console=plain > ../generate.log 2>&1) ||
    { echo "generation pass failed"; grep -E '^e: |What went wrong' -A 3 tmp/phone-spike/generate.log | head -40; }
  mkdir -p "$common" "$room"
  cp -r "$native/libpebble3/build/generated/ksp/metadata/commonMain/kotlin/." "$common/" 2>/dev/null
  cp -r "$native/libpebble3/build/generated/ksp/jvm/jvmMain/kotlin/." "$room/" 2>/dev/null
  echo "upstream's targets generated $(find "$common" -name '*.kt' | wc -l) blobdbgen and $(find "$room" -name '*.kt' | wc -l) Room files"
fi
mkdir -p "$checkout/libpebble3/build/generated/ksp/metadata/commonMain/kotlin"
cp -r "$common/." "$checkout/libpebble3/build/generated/ksp/metadata/commonMain/kotlin/"
if [ "${PHONE_SPIKE_ROOM:-2}" = 2 ]; then
  mkdir -p "$checkout/libpebble3/src/wasmJsMain/kotlin/generated-room"
  cp -r "$room/." "$checkout/libpebble3/src/wasmJsMain/kotlin/generated-room/"
fi
(cd "$checkout" &&
  ./gradlew :libpebble3:compileKotlinWasmJs -x :libpebble3:kspCommonMainKotlinMetadata \
    --continue --no-daemon --console=plain > "$log" 2>&1)
echo "gradle exit $?"
