#!/usr/bin/env bash
# Feasibility spike: clones a tagged release of the upstream companion app and
# adds a browser (wasmJs) target to libpebble3, so a build reports what stands
# between the real phone stack and the browser. Nothing here ships.
set -euo pipefail
tag="${PHONE_UPSTREAM_TAG:-1.13.0.2}"
dir="${1:-tmp/phone-spike/upstream}"
rm -rf "$dir"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" https://github.com/coredevices/mobileapp.git "$dir"
node tools/phone-spike/patch.mjs "$dir"
echo "Prepared upstream $tag at $dir ($(git -C "$dir" rev-parse HEAD))"
