# CPU support and next validation gate

The present target is the **generic qemu_emery software board**, running unchanged official firmware on a Rust interpreter. A successful boot and app install establish useful compatibility; they do not establish complete Arm architectural conformance or physical Obelix hardware fidelity.

## Profile facts

The current official [generic board definitions](https://github.com/coredevices/qemu/blob/pebble-10.1/hw/arm/pebble_generic.c) select Cortex-M33 for Emery and Gabbro, and Cortex-M4 for Flint. Emery uses a 64 MHz system clock, a 1 MHz reference clock, 4 MiB code space and 512 KiB SRAM. Therefore the M33 ISA choice matches this Emery target. It must not silently stand in for the M4 or older STM32 profiles.

The borrowed `rp2350-emu` core hardcodes three NVIC priority bits (`0xe0`). That happens to match the official generic Pebble board, whose source explicitly sets `num-prio-bits=3` to prevent BASEPRI critical-section violations. Three bits are a **board configuration**, not a universal Cortex-M33 property. CPUID, interrupt count, MPU/SAU capabilities, optional DSP/FPU features, cache behavior and timing still inherit RP2350 assumptions and need explicit per-profile definitions before broader firmware support.

## Supported by focused evidence

| Area                       | Evidence and limits                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base instruction execution | Unchanged official Emery firmware boots; actual WASM-Clang-built PBW installs and executes. This exercises many instructions but is not an exhaustive ISA test.                                                                                                                                                                                                                  |
| Exclusive accesses         | Eight focused tests cover word/byte/halfword LDREX/STREX, LDAEX/STLEX, CLREX, monitor replacement, exception entry/return and an MSR-PSP task switch. Reservations do not leak into the new task. Single-core ordinary memory operations execute synchronously.                                                                                                                  |
| Exception stack return     | POP.W and post-index LDR-PC writeback fixes are tested with MSP and PSP. Sixteen wake/return tests pass with the isolated patches, versus thirteen failures in the original adapter.                                                                                                                                                                                             |
| Interrupt priorities       | Four tests cover all modeled NVIC priority byte lanes, SHPR lanes, neighboring-lane preservation and PendSV/SysTick masking by BASEPRI. The priority-byte patch is essential: the previous implementation dropped CMSIS STRB writes, leaving interrupt priorities at zero.                                                                                                       |
| Sleep and time             | WFE tests cover SEV, eligible interrupts, masked/disabled cases and SEVONPEND. Ten WFI tests cover latched NVIC pending, PRIMASK wake without delivery, BASEPRI/FAULTMASK/current-priority restrictions, NMI and both encodings. Already-pending wake does not advance sleep time. SysTick uses the selected 64 MHz/1 MHz clock source; timing/power is not hardware-calibrated. |
| Live stack register reads  | Three tests verify MRS MSP/PSP reports the current active r13 after ordinary stack changes and preserves the inactive bank. The supplied sync fix resolves two previously failing cases.                                                                                                                                                                                         |

[Arm's CMSIS M33 implementation](https://github.com/ARM-software/CMSIS_6/blob/main/CMSIS/Core/Include/core_cm33.h) declares priority arrays as byte registers and implements NVIC_SetPriority/GetPriority using those byte lanes. Generalizing all PPB accesses to word-only was incorrect.

Independent native-QEMU comparison also validated the priority-byte fix end to end: with RTC 08:00, battery 57% and GPS 40.71 aligned, the current browser-built demo's completed Rust framebuffer matches native QEMU in all 45,600 bytes (SHA-256 `ff5e62857b3d6e14c4a2d7cbc57a57e64f3f89471c483f09c599c4d3ea3b470b`). This is a strong specific rendering oracle. It does not cover every frame, app or firmware version. The comparison uses committed display frames to avoid sampling a framebuffer while guest drawing is in progress.

## Known gaps and unvalidated behavior

- **PPB widths and side effects:** priority bytes now have explicit support. Other PPB byte accesses mostly return zero/drop writes; halfword accesses use broad read/modify/write logic. This is not a register-specific transfer-width model. ICSR does not synthesize VECTACTIVE/VECTPENDING, and AIRCR.PRIGROUP is stored without complete priority-group semantics.
- **Sleep modes:** the supplied WFI patch resolves already-merged NVIC pending and mask-aware wake behavior. SLEEPONEXIT, deep sleep and a hardware wake interrupt controller remain outside this acceptance.
- **MPU, privilege and security:** MPU/SAU registers and TT queries exist, but the adapter's ordinary RAM/code bus paths do not enforce their access permissions. Some Secure/Non-secure transitions and banked registers exist; exception security behavior is explicitly partial. Do not advertise MPU isolation or TrustZone support.
- **FPU:** single-precision arithmetic, FPSCR bookkeeping and lazy exception-state code exist upstream, but no Pebble-specific FPU acceptance has been performed. For example, ordinary arithmetic uses host float operations rather than universally honoring FPSCR directed rounding. Nested/lazy FP frames and context switches need an independent oracle. Presence of code is not a fidelity guarantee.
- **Decoder and faults:** packed 8-bit saturating/halving arithmetic and SSAT16/USAT16 gaps were identified. No credible executed sites were found in the inspected firmware image; that is not a compatibility guarantee for other applications. Reserved instructions, faults, alignment, bit-band aliases and self-modifying executable RAM require broader conformance tests.
- **Timing:** upstream RP2350 instruction costs, cache assumptions and the generic device timers have not been measured against Pebble hardware. Battery, Bluetooth radio timing, analog behavior and physical peripherals are outside this CPU result.

## Next architectural gate

Build a firmware-independent, deterministic differential suite that runs the **same small Thumb ELF vectors** on this Rust core and a pinned native official QEMU model. Compare registers, memory, xPSR/IT state, MSP/PSP, exception selection and relevant MMIO at named checkpoints. Start with PPB byte/halfword/word semantics, BASEPRI/PRIMASK/FAULTMASK plus priority grouping, nested exceptions and tail chaining, interrupted IT blocks, PSP switching, WFI/WFE and exclusives. Add MPU/privilege fault injection and FP context/rounding before claiming those features. Gate each board profile separately.

Then run a repeated unchanged-firmware scenario: fresh boot, install, launch, app message exchange, back/home navigation, reinstall and several minutes of virtual clock/timer activity. Compare visible frames and packet events with native QEMU. This catches scheduler/lost-wake regressions that a single successful screenshot cannot establish.

## Reproducible focused test set

With the delivered patches, 45 tests pass in the isolated crate: `wakeup_exception.rs` (16), `priority_bytes.rs` (4), `exclusive_context.rs` (8), `special_stack_reads.rs` (3), and `wfi_pending.rs` (10), and `cps_masks.rs` (4). All are synthetic vectors with no SDK/firmware dependency. The WFI set had seven failures before its patch; the priority-byte set had four failures before its patch.

```sh
cargo test -p emulator-qemu --release --test wakeup_exception --test priority_bytes --test exclusive_context --test special_stack_reads --test wfi_pending --test cps_masks
```

WFI ignores PRIMASK for wake eligibility while exception delivery remains masked; BASEPRI, FAULTMASK and active exception priority still constrain wake. This follows [Arm's Armv8-M power-management documentation](https://documentation-service.arm.com/static/5ef9fe8ecafe527e86f55b41) and [CMSIS instruction documentation](https://arm-software.github.io/CMSIS_6/v6.0.0/Core/group__intrinsic__CPU__gr.html). The board wrapper checks before execution and immediately after WFI, preventing a virtual-time jump when the pending condition already existed.

CPS I/F mask selection is also corrected: literal CPSID i must set PRIMASK, not FAULTMASK.
Four regression tests cover I, F, both masks, and the firmware sleep/unmask sequence. The
correct WFI mask handling exposed this decoder defect during real-firmware validation.
