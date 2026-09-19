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

Wasm ABI 5 accepts inputs only before execution. Existing firmware allocation/loading is
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

With only synthetic bank/identity inputs, both images now stop explicitly at missing NOR
identity. The NOR/OTP fixture below additionally completes `BSP_System_Config`. Global timers,
remaining clock/power controllers, watchdogs, interrupts and complete board boot remain
separate unfinished gates.

## NOR/OTP startup reads (ABI 5)

MPI2 now executes the NOR identification, status, volatile protection update and security
register read sequence used by `HAL_FLASH_PreInit` and `HAL_QSPI_READ_OTP`. The supported
part profile is explicitly selected W25Q128JV (`EF 40 18`); it is not a claim about the part
fitted to either watch. Other JEDEC identities are rejected rather than aliased to this part.
Missing identity and missing security pages report `MissingNorState` / `MissingFlashOtp`.

```js
// Initial status bytes must correspond to the selected part/capture.
if (!e.sifli_configure_nor(0xef4018, capturedSr1, capturedSr2)) {
  throw new Error('Unsupported NOR profile or session already running');
}
for (let page = 1; page <= 3; page++) {
  const bytes = capturedSecurityPages[page - 1];
  if (bytes.length !== 256) throw new Error('Expected a 256-byte security register');
  const p = e.sifli_otp_input();
  new Uint8Array(e.memory.buffer, p, 256).set(bytes);
  if (!e.sifli_load_otp(page)) throw new Error('OTP input rejected');
}
```

Inputs must be loaded before execution, staging is single-use, and firmware reload clears
all imported factory state. Re-selecting a valid flash profile starts a new device state
and clears its previously supplied OTP pages. Invalid profile selection leaves the old
configuration intact. Security pages are never inferred from slot firmware or filled with
erased bytes by default.

The controller models bounded 64-byte transfers, serial clock/dummy/address phases, FIFO
packing, transfer completion/W1C, abort, RCC gating and controller reset. Polling does not
advance time. Unused high lanes of the last FIFO word are deterministically padded; another
read of an empty FIFO faults. Whole-transfer buffering and final-word packing are functional
model choices, not captured bus traces. The 50ns volatile-status refresh is rounded up to
three nominal 48MHz ticks; device reset waits the datasheet's approximate 30us. These and
instruction costs are not measured silicon timing.

A peripheral reset aborts the controller without erasing device state or OTP. A device
reset requires the enable/reset sequence and restores the supplied power-on status. Security
page reads wrap within that page; missing pages fail. Normal/fast array reads use only the
supplied slot bytes at chip offset `0x20000`; unbacked bytes fail. The diagnostic CPU still
uses its separate immutable slot/XIP mapping: this is not full MPI AHB/prefetch/cache/bus
arbitration simulation. DMA, IRQs, command chaining, other bus modes, nonvolatile status
programming, array/OTP program/erase and other NOR parts remain unsupported and explicit.

The acceptance runner tests missing-page rejection separately. Three synthetic pages then
let both unchanged 4.37.0 images return from `BSP_System_Config`. Fourteen completed commands
transfer 544 OTP bytes (32 system + 256 user + 256 customer); every destination byte is checked
through the non-mutating CPU-visible view, including the system buffer on the stack. The
fixture uses an end-of-list marker for optional OTP settings, so this does not establish
crystal-trim or other nonempty factory-record behavior. The same fixture now proceeds through
the bounded physical clock, PMU, watchdog, SiP-pad and wake-source startup slice. Both images
stop explicitly at the first USART1 access (`0x50084000`). Firmware remains unchanged and a
full boot remains unaccepted. Chromium and Firefox Worker evidence covers this boundary;
WebKit still needs a host with its native GTK/GStreamer runtime.
