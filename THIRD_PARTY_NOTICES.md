# Third-party notices

Original project source is Apache-2.0; see LICENSE. Dependencies retain their own licenses.

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

No Pebble firmware is distributed here. Some production images contain separately licensed
vendor components; the open PebbleOS top-level license does not settle all component terms.
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
Package scripts are not executed; package source/firmware/SDK files are not redistributed by this repository.
