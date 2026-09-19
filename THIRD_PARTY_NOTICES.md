# Third-party notices

## Inter

`public/fonts/inter-latin-wght-normal.woff2` is the latin subset of the Inter variable
font, taken from the `@fontsource-variable/inter` 5.3.0 package, under the
**SIL Open Font License 1.1**. Its licence is kept beside it at
`public/fonts/INTER-LICENSE.txt`. The font is self-hosted so the static application needs
no font service; nothing is fetched at runtime.

## Companion browser port

`phone-app` contains adapted Core Devices mobileapp source pinned at
`333877b80baf77b11fad35520cf139a2b13ac75f`, under **GPL-3.0-only**. Its original source,
checksums, extraction patch, license and browser changes remain in that directory.
It is compiled separately to Kotlin/Wasm/Compose and loaded on demand through a browser
frame; it is not linked into the Rust hardware core. This module is not Apache-licensed.
The deployed `phone-app/source.zip` contains its corresponding source and build scripts;
`phone-app/LICENSE`, `phone-app/DEPENDENCIES.md`, `phone-app/licenses/` and `build.json`
provide redistribution notices, dependency sources and artifact hashes.

Runtime dependencies include Kotlin, Compose, Ktor and kotlinx libraries (Apache-2.0),
Skiko (Apache-2.0), Skia and its native dependencies (individual permissive licenses),
and js-joda (BSD-3-Clause). The module's dependency lockfiles record exact versions.
No Android APK, Android system image, account service or proprietary phone binary is bundled.

Original project source is Apache-2.0; see LICENSE. Dependencies retain their own licenses.

## Preview example

`public/examples/clock-{emery,flint,gabbro}.pbw` are compiled versions of the Apache-2.0
source in `examples/preview-clock`, built with the pinned browser compiler and official
SDK 4.33.1 ABI library. They contain the application's code and SDK API linkage, with no
firmware, SDK archive or system font data. The new configurable Clock package includes its
Apache-2.0 PKJS script and embedded settings HTML. Reproduction instructions accompany
the source; package hashes are recorded in the root `pebble-preview.json`.

## Rust CPU

`vendor/rp2350-emu` is version 0.2.6 of [picoem](https://github.com/0x4D44/picoem),
MIT OR Apache-2.0, with both license files preserved. Local changes correct
acquire/release decoding, priority byte accesses, exception return writeback, ITSTATE, and
active stack reads, and CPS interrupt-mask selection; see `vendor/rp2350-emu/LOCAL_CHANGES.md`, `docs/evidence`, and the Rust
regression tests. Upstream test fixture binaries are
not included, and their optional test targets are removed from the vendored manifest.
The generic Pebble board adapter is original code. No QEMU implementation source is copied
or linked into the shipped application. `picoem-common` is pinned through Cargo.lock.
The original checkpoint codec enumerates CPU/PPB state explicitly and changes no instruction
execution semantics; its reviewable patch and restore tests accompany the source.

## Compiler

`public/compiler/vendor` contains the unchanged browser JavaScript bundle from
microbit-clang-wasm 21.11.0-alpha.1. Its provenance, SHA-256, component notices, ISC license,
and Apache/LLVM exceptions are preserved beside it. The large compiler Wasm and resource
archive are downloaded from exact versioned URLs, checked by size and SHA-256, and cached
on the user's device. Resource archive license files remain inside that archive.

The portable metadata/resource/PBW implementations follow the Apache-2.0 PebbleOS SDK
format code, copyright 2024 Google LLC. Their SPDX attribution is retained. Golden test
constants were independently generated with the official SDK. The user imports SDK
headers/libraries; this repository does not redistribute those binaries.

## Phone, graphics, UI, and archives

QuickJS and quickjs-emscripten retain their upstream MIT licenses; the production JS build
emits dependency notices copied into the hosted `licenses` directory. Rust dependency
license texts and QuickJS notices are included there as well. QuickJS Wasm is copied from the installed pinned package during
build. Three.js and fflate are MIT. Angular, RxJS, tslib, and tooling retain their published
licenses. Exact versions are recorded in package-lock.json.

The geometry Worker uses the unmodified meshoptimizer 1.1 simplifier distributed with
Three.js 0.186.0, copyright 2016–2026 Arseny Kapoulkine, under MIT. Its full license from
https://github.com/zeux/meshoptimizer/blob/v1.1/LICENSE.md is preserved in
`vendor/licenses/MESHOPTIMIZER.txt` and shipped as `licenses/MESHOPTIMIZER.txt`.

The 3D watch geometry is fetched from Core Devices' official hardware repository at pinned
commit cb50db8e68c053e7dd595188313dd54aba693bc9, verified by SHA-256, and not committed here.
The upstream README grants use for researching, learning, coding, and hacking on its gadgets;
it does not identify an SPDX license. Geometry attribution appears in the interface.

## Protocol and firmware

Protocol code is original and based on documented wire formats. Reference vectors use
MIT-licensed libpebble2, copyright 2015 Pebble Technology, commit
23e2eb92cfc084e6f9e8c718711ac994ef606d18. SDK CRC/packaging references also retain their
Google/Apache attribution in the relevant source files.

`public/firmware/v4.37.0` distributes unchanged official Core Devices `qemu_emery`,
`qemu_flint` and `qemu_gabbro` emulator images, gzip-compressed for transport. See the
[component notices and corresponding source](public/firmware/v4.37.0/NOTICE.md) and
[provenance review](docs/evidence/default-firmware-provenance.json). These exact QEMU
configurations exclude the hardware-specific nonfree components; the included runtime,
libraries, fonts and artwork retain the licenses in the packaged notice inventory.
This is not a blanket redistribution determination for physical firmware or other releases.
Generated `public/checkpoints` artifacts contain pristine runtime states derived from those
same reviewed images. Their embedded firmware/font/artwork bytes retain the same notices
and corresponding sources. Candidate states for other releases remain temporary test inputs.
Official QEMU and Unicorn are separate local verification oracles only, never linked into
or used as a backend for this application.

## JavaScript bundling and resource conversion

esbuild-wasm 0.28.2 is MIT, copyright Evan Wallace. Its browser API and Wasm binary are copied
from the locked npm dependency during the site build; full license text ships at
`licenses/ESBUILD.txt`. Visitor scripts are parsed/bundled with Wasm inside the compiler Worker.

`public/compiler/vendor/pako.esm.mjs` is unmodified pako 2.1.0 (MIT), copyright Vitaly Puzrin
and Andrey Tupitsin. Its license is retained alongside it. The SHA-256 and SDK source provenance
for the original resource-format port are recorded in `docs/BROWSER_COMPILER.md`.
The generated dependency-archive helper bundles our existing archive validation with MIT fflate;
its license is included in the generated JavaScript notices.

Imported npm packages remain user-selected build inputs and retain their own licenses.
The fast compiler does not execute package scripts. The optional Linux/Wasm build runs user
commands in an isolated VM. Imported package sources and SDK files are not redistributed here.

## Linux build sandbox and sensor reference

`@bjorn3/browser_wasi_shim` 0.4.2 is dual MIT/Apache-2.0; its MIT license is shipped at
`licenses/WASI-SHIM.txt`. `yaml` 2.9.1 is ISC and is included in the generated JavaScript
license inventory. These dependencies provide the browser WASI host and recipe parser.
The quota, clock-poll and memory-ceiling adapters are original project code.

Linux build images and imported toolchains remain user-supplied. container2wasm, Bochs,
Linux, Python and GCC are independent upstream projects with their own licenses. Local
acceptance image/package hashes and source links are recorded in `docs/evidence/linux-build-gate.json`.
This repository does not redistribute those images or toolchain archives. The unverified
Docker preparation recipe does not resolve redistribution obligations for a resulting image.

Sensor protocol and preference layouts were checked against Apache-2.0 PebbleOS v4.37.0.
The native QEMU touch implementation was used as a behavioral reference only; its GPL code
was not copied into the Rust core. Frame comparisons execute the unchanged official images.
