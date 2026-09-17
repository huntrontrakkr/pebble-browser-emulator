# PebbleOS 4.37.0 emulator firmware

These are the **unchanged official emulator images** for `qemu_emery`, `qemu_flint`
and `qemu_gabbro`, published by Core Devices. They are gzip-compressed for delivery;
decompression restores the exact published bytes. They are not physical-watch images.
This project is independent of Core Devices and does not claim authorship of PebbleOS.

- [Official release and original downloads](https://github.com/coredevices/PebbleOS/releases/tag/v4.37.0)
- [Complete firmware source at the release commit](https://github.com/coredevices/PebbleOS/tree/9399f564fb5035057a9174025d2c6c625e942285)
- [Source archive](https://github.com/coredevices/PebbleOS/archive/9399f564fb5035057a9174025d2c6c625e942285.tar.gz)
- [Published build workflow](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/.github/workflows/build-qemu.yml)
- [Checksums, sizes, original URLs and notice inventory](manifest.json)
- [Full component license and copyright notices](LICENSES.txt)

The main firmware source is Apache-2.0 (Google LLC, Core Devices LLC and other
PebbleOS contributors). The included runtime, libraries, fonts and artwork retain
their own terms; the combined notice file preserves these. Moddable runtime code in
Emery and Gabbro is LGPL-3.0-or-later with retained Apache notices for incorporated
Kinoma/Marvell code. The LGPL and GPL texts are included, along with the permissive
CMSIS, nanopb, TinyMT, QR code, Speex, C library and resource licenses. The firmware
is provided without warranty under those licenses.

## Corresponding source and rebuilding

The complete application source is the pinned PebbleOS checkout above. Its
[submodule list](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/.gitmodules)
records external source repositories; the checkout pins their exact commits.
In particular, the LGPL runtime's corresponding source is
[coredevices/moddable at ae34f417e6c5ae31bba6160e68b30d24338254c6](https://github.com/coredevices/moddable/tree/ae34f417e6c5ae31bba6160e68b30d24338254c6)
([source archive](https://github.com/coredevices/moddable/archive/ae34f417e6c5ae31bba6160e68b30d24338254c6.tar.gz)).
This source and the firmware's CMake definitions allow rebuilding and relinking with
a modified runtime. There are no local firmware modifications or signing restrictions
in this browser emulator. Use **Developer tools → Firmware** to load your rebuilt pair.

Using the environment and dependencies in the pinned upstream build workflow:

```sh
git clone https://github.com/coredevices/PebbleOS.git
cd PebbleOS
git checkout 9399f564fb5035057a9174025d2c6c625e942285
git submodule update --init --recursive
pbl configure --board qemu_emery
pbl build qemu_image_micro qemu_image_spi
```

Select `qemu_flint` or `qemu_gabbro` for the other emulator boards. These are upstream
build instructions, not a claim of a locally reproduced byte-identical firmware build.
The shipped bytes instead match GitHub's official release SHA-256 digests exactly.

## Scope of the component review

At this exact release, resolving each board's Kconfig defaults selects the QEMU
Bluetooth transport. Nordic and SiFli HALs, NimBLE, Nordic fuel-gauge libraries,
CST816 firmware and Goodix algorithm libraries are disabled. The `nonfree`
subdirectory's imports are guarded by those disabled configuration options. The
proprietary physical-device components therefore do not block these emulator images.
This review does not authorize redistribution of other firmware versions or boards.

Source-level configuration evidence and review references are recorded in
`docs/evidence/default-firmware-provenance.json` in the browser emulator repository.
Each original notice is also preserved separately under `licenses/`; Japanese
notices retain their original encoding. No firmware is patched or substituted to
hide emulator limitations.
