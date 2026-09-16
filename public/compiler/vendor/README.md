# Browser ARM compiler runtime

`bundle.js` is copied unchanged from `microbit-clang-wasm@21.11.0-alpha.1` (`gen/bundle.js`). Its SHA-256 is `360573c46f4cbbeedfddc756f5a761f02514acda1bedb26ad3507b15f91cd6e9`; size 260,652 bytes. No remote JavaScript is imported by the browser worker. The bundle contains all JavaScript dependencies; its only dynamic imports are `node:fs/promises` on Node-only branches. Runtime WebAssembly and sysroot assets are fetched separately through the worker's pinned size/SHA-256 verifier.

The package is maintained by Carlos Pereira Atencio and derives from Catherine (whitequark)'s YoWASP/clang and YoWASP/runtime. See `COMPONENT-LICENSES.md` for the publisher's component attribution. JavaScript is ISC; the exact license from pinned `@yowasp/runtime@11.0.67` is in `LICENSE-ISC.txt`. `JCO-LICENSE.txt` retains the generator package's Apache-2.0 with LLVM exception notice. `LICENSE-APACHE-2.0.txt` is the original microbit package's Apache text for LLVM. The downloaded sysroot retains its individual notices under `usr/share/licenses/` inside `llvm-resources.tar`.

Immutable package source and file hashes are recorded in `provenance.json`. Upstream source: https://github.com/carlosperate/microbit-clang-wasm . LLVM release: `release-21.1.1-ATfE`, commit `0bac08d50952133963671eeeb8c3e67695a32f49` from https://github.com/arm/arm-toolchain .
