# Generic-board watchdog and the v4.39.0 boot failure

## Diagnosis

At emulator commit `91530b47231075429ba1dc57ae9b5a1fecea1021`, official v4.39.0
faulted on all three generic boards within milliseconds. The first failing access
was the watchdog unlock write at `0x40013c00`, an unmapped peripheral. The CPU
reported CFSR `0x00008200` and HFSR `0x40000000`, then ran the guest HardFault
handler. Accepting that exception cleared the bus adapter's pending-fault latch,
so the checker continued waiting for readiness until its two-minute deadline.
Increasing that deadline would not repair boot.

The [v4.39.0 initialization](https://github.com/coredevices/PebbleOS/blob/v4.39.0/soc/qemu/init.c)
starts the [new QEMU watchdog driver](https://github.com/coredevices/PebbleOS/blob/v4.39.0/fw/drivers/watchdog/qemu.c).
v4.38.4 selected a no-op watchdog stub and passed the same local boot/continuation
checks on the unmodified emulator. This is an emulator compatibility gap exposed
by the new firmware, not evidence of a flaky runner or a broken firmware image.
The failed [v4.39.0 job](https://github.com/huntrontrakkr/pebble-browser-emulator/actions/runs/37338643926/job/111859764820)
and successful [v4.38.4 job](https://github.com/huntrontrakkr/pebble-browser-emulator/actions/runs/37205083446/job/111444488010)
used the same emulator revision.

## Reference contract and implementation scope

The original Rust model uses the behavior of coredevices/QEMU at immutable commit
`af38a82d208d4cfb7be03ffa95cc12780fbd2965` as its reference. No QEMU C implementation
is copied. References:

- [CMSDK watchdog registers and state transitions](https://github.com/coredevices/qemu/blob/af38a82d208d4cfb7be03ffa95cc12780fbd2965/hw/watchdog/cmsdk-apb-watchdog.c)
- [Pebble board mapping, clocks, and wiring](https://github.com/coredevices/qemu/blob/af38a82d208d4cfb7be03ffa95cc12780fbd2965/hw/arm/pebble_generic.c)
- [Reset-cause register](https://github.com/coredevices/qemu/blob/af38a82d208d4cfb7be03ffa95cc12780fbd2965/hw/misc/pebble_sysctrl.c)
- [Timer rounding and reload policies](https://github.com/coredevices/qemu/blob/af38a82d208d4cfb7be03ffa95cc12780fbd2965/hw/core/ptimer.c)
- [Independent watchdog test expectations](https://github.com/coredevices/qemu/blob/af38a82d208d4cfb7be03ffa95cc12780fbd2965/tests/qtest/cmsdk-apb-watchdog-test.c)

The watchdog occupies `0x40013000..0x40013fff`, clocked at 1 MHz (64 board ticks).
LOAD/VALUE, interrupt/reset enables, interrupt clear/feed, raw/masked status,
locking, integration-test outputs, and peripheral/component IDs are modeled.
Byte/halfword accesses use padded register lanes. Reserved and write-only reads
return zero only according to this device's reference contract; other unknown
peripherals still fault.

The first expiry raises raw status; after one reload clock and a second countdown,
the second expiry latches reset status and stops the counter. RESEN gates reset.
Feeding clears raw status and reloads the counter but does not clear a latched
reset. Enabling INTEN reloads; disabling freezes the visible count. LOAD=0 does
not immediately expire. Counter readback includes the reference's exact-edge
rounding and zero interval. The timer participates in WFI/WFE fast-forwarding.

The timeout line feeds SYSCTRL, **not an NVIC interrupt**. SYSCTRL `0x40007014`
starts with POR=1 and accumulates SOFT=2 or WDOG=4 across resets; writes clear the
specified bits. Reset classification samples the watchdog output before devices
reset, including integration-test output. A keyed AIRCR SYSRESETREQ also resets
the board. Guest resets retain SRAM, SPI flash, and RTC backup registers; the
existing explicit host restart retains its clean-SRAM/backup behavior. Virtual
RTC time and subsecond phase remain continuous under the emulator's existing
clock contract. This is not a new claim of physical-watch reset fidelity.

Checkpoint format advances from internal version 2 to 3 and serializes every
watchdog field, timer phase, visible count, and reset cause. Incompatible old
snapshots are rejected rather than silently defaulting these fields. Startup
checkpoint identities include the core hash; the normal build regenerates them.

## Boot diagnostics

The checker now checks CFSR/HFSR as well as the bus adapter failure signal after
each boot quantum. A guest-handled fault therefore fails promptly. Both faults
and timeouts produce `tmp/startup-checkpoints/failure.json` with the profile,
firmware version, core hash, elapsed time, PC/registers, CFSR/HFSR, BFAR and its
validity bit, board ticks, frames, and a bounded UART tail. The release workflow
retains that file on failure. Diagnostics do not alter guest state or readiness.
Candidate output remains restricted to `tmp`, including on Windows.

## Local verification, 2026-10-05

Final tested core SHA-256:
`5b917b9aa8153a03f1b9221316140ed0b57c7830ed2ac8ede9b7352249ecf069`.
Official candidate images were checked against release SHA-256 digests. Each
cell below passed cold boot, complete restored-state equality, and continuation
comparisons for framebuffers, UART, buttons, and battery input.

| Firmware | Flint cold boot | Emery cold boot | Gabbro cold boot |
| --- | ---: | ---: | ---: |
| v4.39.0 | 8.763 s | 8.757 s | 8.819 s |
| v4.38.4 | 8.659 s | 8.338 s | 8.421 s |
| bundled v4.37.0 | 9.199 s | 9.031 s | 8.829 s |

These are local wall-clock measurements, not physical performance claims.
Each v4.39.0 profile also continued from its checkpoint for 65 virtual seconds
(more than two complete watchdog timeouts) with no fault or observed reset.
The bundled firmware remains v4.37.0; candidate binaries are not deployment
inputs. No hosted workflow was rerun and nothing was pushed or deployed.

`cargo test --workspace --locked` (193 tests), formatting, Clippy with warnings denied, and
`npm run build:wasm` pass. There are 11 new Rust watchdog/reset tests and three
boot-diagnostics tests, including a real compiled-Wasm guest HardFault whose bus
adapter latch has already cleared.

On this Windows executor, `npm test` records 516 tests: 497 pass, 8 fail, 11 skip.
All eight failures also reproduce on unchanged commit 91530b4: three census
path-separator failures, three compiler-worker symlink-permission failures, and
two suite-runner path-separator failures. Exact tracked bytes were restored for
unchanged provenance fixtures to avoid Git's Windows newline conversion affecting
their hashes. The companion Gradle/bash build cannot run here. Angular production
compilation succeeds, but `build:web` subsequently stops at PWA packaging because
the companion output is missing. The full browser suite remains unverified.

### Ubuntu WSL follow-up

An existing Ubuntu WSL2 distribution recovered the platform-dependent checks
without installing packages or changing security settings. Its Node dependency
lock matches exactly. Rust workspace tests (193), formatting, Clippy, and the
Linux Wasm build pass. The full Node suite passes with 505 passes and 11 explicit
skips. A concurrent run during browser load recorded one QuickJS phone-clock
interruption; the final uncontended rerun again passes 505 tests with no failures
and 11 skips.

The existing companion's source archive covers all 50 tracked phone files. All
49 other files match exactly; the Gradle wrapper properties differ only in
download timeout/retry settings, not distribution, compiler, or runtime inputs.
All nine artifact sizes and SHA-256 hashes match its build manifest. Reusing that
build permits complete `build:web`/PWA packaging and browser execution. This is
not a fresh companion compilation. The configured JDK path under
`/tmp/pebble-phone-tools` has disappeared, no `java` is available on Ubuntu PATH,
and Windows `bash` resolves to an unusable WindowsApps alias. The smallest step
for a fresh build is to provide a working JDK 17 via `JAVA_HOME` and run
`npm run build:phone` in Ubuntu; the Gradle 9.6.1 distribution is already cached.

With the existing Chromium dependency directory selected only for the test
process, the discovered Chromium suite passes **14 gates, fails none, and
explicitly skips 12 of 26**. It includes three-profile demo/settings, companion,
Clay contract, WebSocket, preview/input, offline PWA, real resource download/cache,
and weather gates. Missing fixture/native-reference and deliberate manual gates
remain skipped. This browser run used the originally validated Windows-built
Wasm hash above. A separate Linux rebuild has SHA-256
`464797bd12b5572c757529722600523a1f450ab0e730fdb432ae2125bf39fe8d`.
Its v4.39.0 boot/checkpoint-continuation checks also pass on all three profiles:
Flint 8.994 s, Emery 8.823 s, and Gabbro 8.987 s.

The watchdog checks use pinned reference source and independent qtest expectations;
no live native-QEMU differential run was available. The separate Python Unicorn
reference check also could not run because Unicorn is not installed. These
limits remain explicit; do not promote the default firmware based solely on
same-core continuation checks. Final diff review found no additional watchdog,
reset, or checkpoint correction necessary.
