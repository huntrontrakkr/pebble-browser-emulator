# Physical watch reference measurements

A physical watch is useful for validating timing and behavior; it does not replace the
source-backed device models. Record the product, board revision, firmware version, app
hash, cold/warm boot, battery/charging state and collection method with every capture.
Do not label an emulator estimate as a hardware measurement.

## Start with an ordinary test app

Use the normal app installation path, keeping the installed OS. Measure repeated timer
callback intervals, input-to-redraw behavior, accelerometer delivery and phone round trips.
Record distributions and lost events, not only averages. Compare the same app and input
scenario in the emulator. Phone timestamps include transport/scheduling delays; screen
recordings include camera/display latency. Neither measures CPU cycles or the early boot
handoff. A normal SDK app cannot be assumed to have access to privileged SoC registers.

Once the exact watch model is known, select its supported SDK target and logging transport.
No firmware update, debug attachment or watch access has been performed by this change.

## Boot measurements need a separate capture method

For current Time 2 (Obelix) and Round 2 (Getafix), first determine whether an existing
serial/debug log exposes the needed state. Reading memory through a supported debug
interface is preferable to modifying firmware. Reset/halt capture changes timing; record
that explicitly. Opening the case, soldering, replacing firmware or enabling debug access
requires a separate decision about the actual device. Do not assume USB exposes SWD.

The first useful capture is the state at the application reset vector, before `SystemInit`:

- CPU security/privilege, MSP, MSPLIM, VTOR and interrupt enable/pending state.
- HPSYS_RCC CSR/CFGR, HPSYS_AON ACR/ISSR and RTC backup registers.
- LPSYS_AON PMR/SLP_CTRL and LPSYS_RCC RSTR1, including whether LCPU is halted.
- Board/SoC revision and the bootloader image/version responsible for this handoff.

Next capture ACR and the counter/timebase immediately before requesting HXT48 and when
RDY becomes set. Capture the source-switch order and actual clock frequency. An app that
runs later cannot reconstruct oscillator startup time. Store raw samples, timebase units,
frequency/calibration, wrap handling and uncertainty. The emulator's configurable default
of 48,000 nominal 48MHz ticks (1ms) is an assumption, not a measured value.

Avoid publishing unique device identifiers or complete EFUSE dumps. Factory calibration
and security data must be separated before considering a redistributable fixture.

## Remaining source-backed boot sequence

The pinned [PebbleOS early initialization](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/soc/sf32lb/sf32lb52x/init.c)
and [SiFli HAL reset routine](https://github.com/coredevices/SiFli-SDK/blob/bfee83c7adc0b19c2923f1788238def50f0a9dce/drivers/hal/bf0_hal_rcc.c)
define the next dependencies:

| Stage | Current state | Acceptance needed |
| --- | --- | --- |
| Reset copies/BSS, MPU/caches, entry to main | Executes unchanged firmware in both revisions | Hardware handoff/cache reference still needed |
| HXT48 request/switch, LCPU wake request and 230us/30us delays | Executes with functional clocks and estimated DWT cycles | Measured readiness/timing; slow/failing crystal tests already run |
| LCPU reset/halt | Executes with CPUWAIT retained under explicit active-domain assumption | Capture real entry state; LCPU execution and sleep still absent |
| BSP configuration / EFUSE | Timed transfers, trim latches and NOR/OTP reads modeled; synthetic board configuration passes | Supply matched EFUSE/identity/flash data; verify the actual part and nonempty factory records |
| Global timer, RC32K, watchdog, DLL and HCLK setup | Source-backed digital sequence reaches USART1; oscillator/DLL/watchdog timing is unmeasured | Capture timer rates, oscillator startup, DLL lock and watchdog handoff on both revisions |
| SiP pins and HPAON wake enables | Register sequence modeled through all 13 analog pad transitions and four early wake sources | Verify electrical state and bootloader handoff on hardware |
| USART, remaining board devices, scheduler, display and phone | Not accepted | Device models and independent boot/frame/protocol captures |

The published [SiFli startup flow](https://docs.sifli.com/projects/sdk/latest/en/sf32lb52x/app_development/startup_flow.html)
explains ROM boot, a second-stage bootloader and application startup. Directly entering the
application bypasses the first two stages; known register layouts alone do not establish
the values those stages leave behind. Full boot must remain unaccepted until the unchanged
firmware reaches scheduler/display operation with independently supported device behavior.

See [the factory-data contract](SIFLI_FACTORY_DATA.md) for local bank import and the
distinction between synthetic transfer tests and physical calibration.
