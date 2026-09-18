# SiFli reset and factory-data contract

The isolated physical probe now executes LCPU reset/halt and the EFUSE read path. It can
apply caller-supplied trim data through the unchanged firmware's calibration code. This is
not complete board boot, calibrated analog simulation, or a working physical-watch profile.

## Reset and halt

`LPSYS_AON.PMR.CPUWAIT` holds LCPU while `LPSYS_RCC.RSTR1` asserts/releases reset. The
modeled reset bits follow the pinned SF32LB52x header. Repeated assertion does not count
as a new edge. Clearing reset leaves CPUWAIT asserted; releasing CPUWAIT fails with
`MissingLcpuState`, since LCPU ROM/RAM/execution are not supplied. Other LCPU peripherals
remain inaccessible, including while their reset bits are asserted. AON is outside this
reset domain. The entry contract assumes an active, nonsleeping LCPU domain awaiting reset;
it is not a capture of a physical bootloader handoff. Sleep/wakeup transitions are unsupported.

## EFUSE and calibration

EFUSE models the documented control, timing, W1C completion status and bank data latches.
Four independent 32-byte banks may be supplied. Reads transfer the selected bank into its
latches after a functional estimate of `512 + THRCK` PCLK cycles; MMIO polling never advances
time. RCC gating pauses the transfer; peripheral reset cancels it and clears controller
latches without erasing supplied OTP. Programming, interrupt mode and unknown registers
fail explicitly. The documented zero reset value of the DATA latches is distinct from
missing OTP: starting a read without that bank returns `MissingFactoryCalibration`.

The HPSYS_CFG identity register has no fabricated default (`MissingChipIdentity`). PMUC
trim fields for buck, retention, AON bandgap, peripheral LDO and HP/LP output selection use
documented reset values and masks. Unsupported power-control changes fail. Analog voltage,
settling, battery and thermal behavior are not inferred from these digital trim latches.

Wasm ABI 4 accepts inputs only before execution. Existing firmware allocation/loading is
unchanged. After `sifli_load`, an embedding application can provide a captured bank:

```js
// bankBytes must be exactly 32 bytes from the selected bank, with known provenance.
if (bankBytes.length !== 32) throw new Error('Expected one 32-byte EFUSE bank');
const p = e.sifli_efuse_input();
new Uint8Array(e.memory.buffer, p, 32).set(bankBytes);
if (!e.sifli_load_efuse_bank(bankNumber)) throw new Error('Bank rejected');
// Use a captured HPSYS_CFG.IDR, not a guessed silicon/device identifier.
if (!e.sifli_set_chip_id(capturedIdr)) throw new Error('Identity rejected');
```

Staging is single-use, invalid bank indices consume it, and loading another firmware clears
all factory data and staged input. Replacing a running session's data is rejected. Reports
identify inputs as `caller-supplied-unverified`; providing bytes does not make them verified.
No physical-watch calibration image is bundled or assumed. Use the
[measurement guide](PHYSICAL_MEASUREMENTS.md) to establish capture provenance.

`sifli_read_byte` inspects backing memory. `sifli_read_cpu_byte` instead includes dirty
D-cache data without filling, evicting or cleaning cache lines. Both return `0xffffffff`
for unavailable bytes. The distinction is required when checking firmware calibration
buffers: stores can still be in the write-back cache.

## Acceptance and next dependency

The existing physical-reset runner now checks that both unchanged 4.37.0 images assert
and release LCPU reset once, retain CPUWAIT and stop explicitly at missing EFUSE bank data.
Two separate synthetic tests then verify all 32 bank bytes copied to the ELF's `conf_sys`
buffer, rejection of missing chip identity, and the PMUC trim values independently decoded
from the pinned SDK field mappings. Chromium, Firefox and WebKit also run the synthetic
transfer/trim case. These records are labeled synthetic, never physical calibration.

With synthetic bank/identity inputs, both images proceed to `HAL_FLASH_PreInit` and stop at
MPI2 TIMR (`0x50042084`). `BSP_System_Config` still needs the external NOR command controller,
flash identification and system/user/customer OTP pages. Global timers, remaining clock/power
controllers, watchdogs, interrupts and complete board boot remain separate unfinished gates.
