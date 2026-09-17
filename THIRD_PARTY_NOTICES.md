# Third-party notices

Original project source is Apache-2.0; see LICENSE. Dependencies retain their own licenses.

## Preview example

`public/examples/clock-{emery,flint,gabbro}.pbw` are compiled versions of the Apache-2.0
source in `examples/preview-clock`, built with the pinned browser compiler and official
SDK 4.33.1 ABI library. They contain the application's code and SDK API linkage, with no
firmware, SDK archive, system font data or phone script. Reproduction instructions accompany
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
