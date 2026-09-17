# Sensor inputs and frame comparisons

Load matching firmware and install `examples/sensor-test`. In **Inputs**, set individual
values or schedule a scenario. The current focus is the three modern generic emulator
boards. Inputs are delivered to firmware or the companion script; no watchface readings
are drawn by the host.

| Input          | Units / behavior                                                                                | Implemented destination                                    |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Acceleration   | Signed X/Y/Z millig, −32768…32767                                                               | QEMU sample input; all three boards                        |
| Tap            | X/Y/Z, direction −1/+1                                                                          | QEMU tap input; all three boards                           |
| Compass        | Counterclockwise degrees, calibration −1…2                                                      | QEMU input; verified 4.37 apps still report unavailable    |
| Health         | Steps, active seconds, resting/active calories, distance in metres, sleep/restful-sleep seconds | Firmware service overrides; enable activity tracking first |
| Heart rate     | 0…255 BPM, quality −1…4                                                                         | Emery raw HR service input; firmware controls filtering    |
| Touch          | Display pixel X/Y, contact/release                                                              | Emery/Gabbro touch-controller registers and interrupt      |
| Buttons        | Four-bit pressed mask                                                                           | Board GPIO                                                 |
| Battery        | Percent and charging state                                                                      | Firmware battery input; no chemistry model                 |
| Connection     | Connected/disconnected                                                                          | Logical link state; no RF model                            |
| Location       | Latitude/longitude, accuracy, altitude, altitude accuracy, heading and speed                    | Isolated phone geolocation callbacks                       |
| Location error | Permission denied, unavailable or timeout                                                       | Isolated phone error callbacks                             |
| Settings       | Time format, content size, timeline peek                                                        | Documented firmware emulator channels                      |

**Apply health settings** sends real BlobDB preferences and waits for firmware acknowledgment.
The fixture is age 30, height 170 cm, weight 70 kg and unspecified gender. Overrides are
separate from raw optical PPG and physical sensor processing. The sensor example displays
raw BPM deliberately; the firmware's filtered value can differ. Select on the example
requests vibration, which appears as a real output event in the input panel.

Microphone/audio and raw physical gyro, light, temperature and optical controllers remain
unimplemented. A board descriptor with no input route rejects the signal. A transmitted
compass packet cannot enable a compass service absent from a firmware build.

## Synthetic scenarios

Stationary, walking, running and rotation presets generate acceleration samples with a
specified seed and optional noise. They are synthetic functions, not recorded human motion.
Export JSON to retain the exact samples. Every input in the table can be scheduled in the
JSON editor, including phone locations and errors:

```json
{
  "version": 1,
  "name": "Location loss and low battery",
  "seed": 1,
  "events": [
    { "atUs": 0, "signal": { "kind": "battery", "percent": 15, "charging": false } },
    {
      "atUs": 1000000,
      "signal": { "kind": "location-error", "code": 2, "message": "Location unavailable" }
    },
    {
      "atUs": 3000000,
      "signal": {
        "kind": "location",
        "latitude": 40.71,
        "longitude": -74,
        "accuracy": 5,
        "altitude": 10,
        "heading": 90,
        "speed": 1.4
      }
    }
  ]
}
```

`atUs` is relative to the virtual watch time when **Schedule** is pressed. Equal timestamps
retain file order. Pausing the watch freezes playback and the coupled phone. Cancel removes
future events; reset removes the scenario. Acceleration CSV uses exactly
`time_ms,x_mg,y_mg,z_mg`. Limits are 100,000 events, a 24-hour timeline and 16 MiB imports.

The event log reports queueing, UART delivery, controller application or phone forwarding.
These stages do not claim the app consumed every sample. Firmware selects its sampling
rate; use app callbacks and frame comparisons for observed output. This format does not
include a full RAM/flash/phone snapshot. Replay requires the same initial state and fixtures.

## Compare frames

Pause at the desired state. Under the watch, open **Frame comparison** and save a PBF file,
or load a reference PBF/raw `.bin`. The tool captures the current frame when you open the
reference and compares every canonical pixel, including round display corners. It displays
the difference count, first difference, hashes and a red difference map. Export the JSON
report to retain the result. Optical previews do not affect comparison.

PBF1 is a 12-byte header followed by one ARGB2222 byte per pixel: ASCII `PBF1`, little-endian
u16 width and height, and u32 format value 8. Raw `.bin` references use the current dimensions.
Flint's packed hardware framebuffer is expanded into canonical black/white ARGB2222 first.
PNG reference import and photographed-screen calibration are not implemented.

## Reproduce the sensor gate

Build the example with the existing Wasm compiler, then supply your own unchanged firmware:

```sh
PEBBLE_PROFILE=qemu_emery \
PEBBLE_FIRMWARE_DIR=/path/to/firmware PEBBLE_SENSOR_PBW=/path/to/emery/watchface.pbw \
node --test tests/sensors.integration.test.mjs

PEBBLE_QEMU=/path/to/qemu-pebble PEBBLE_PROFILE=qemu_emery \
PEBBLE_FIRMWARE_DIR=/path/to/firmware PEBBLE_SENSOR_PBW=/path/to/emery/watchface.pbw \
PEBBLE_TRACE_DIR=tmp/native-sensor node scripts/verify-sensor-reference.mjs
```

Use matching Flint or Gabbro assets for the other profiles. See the exact recorded artifacts
in [sensor evidence](evidence/sensor-service-gate.json).
