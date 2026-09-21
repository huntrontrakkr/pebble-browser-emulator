# Weather

The watch gets weather from the phone. Until now this emulator's phone never sent any, so
PebbleOS logged `service_weather: No weather support on phone` and the Weather app had
nothing to draw. Two separate things were missing: the capability that gates the service,
and the database records that carry the forecast.

## Capabilities

The firmware asks the phone what it supports on endpoint `0x11`, once, during a full boot.
Leaving that request unanswered leaves the cached capability word at zero, and every
capability-gated service refuses.

Answering it is not enough on its own. A restored startup checkpoint never sees the
request, because the boot that would have made it already happened. `session_remote_version.c`
handles a `CommSessionVersionCommandResponse` with no matching request, and
`comm_session_set_capabilities` writes the cached copy that `weather_service` reads, so the
phone announces itself on every link-up instead of waiting to be asked.

The response is `VersionsPhoneResponseV3`. The firmware picks the format by payload length
and only reads `protocol_capabilities` when `response_version` is exactly `2` — an older
Android app doubled its response, and the check exists to reject that. `platform_bitfield`
passes through `ntohl` and is big-endian; `protocol_capabilities` is read straight out of
the packed struct and is little-endian.

This phone claims two bits, counting `run_state_support` as bit 0:

| Bit | Name                  | Why                                                                                                                                                                               |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `run_state_support`   | App state on endpoint `0x34`. Without it the firmware falls back to the deprecated launcher endpoint `0x31`, which the installer does not wait on, so every app launch times out. |
| 11  | `weather_app_support` | The forecast records below.                                                                                                                                                       |

Bit 24, `weather_db_v4_support`, is deliberately left clear: it means "the phone writes the
v4 record", and this phone writes v3. Claiming a capability we do not serve leaves the
firmware waiting for data that never arrives.

## Records

A forecast is two records that are only useful together. `weather_service` skips a database
entry whose key is not in the location list, so the list is written after the entry and
emptied before it is deleted.

**Forecast** — `BlobDBIdWeather` (5), key is a 16-byte `Uuid`, value is `WeatherDBEntry`
version 3. Every field is little-endian, nothing is aligned, and `WeatherType` is one byte
because the firmware builds with `-fshort-enums`.

| Offset | Type     | Field                                                                      |
| ------ | -------- | -------------------------------------------------------------------------- |
| 0      | `uint8`  | `version`, must be 3                                                       |
| 1      | `int16`  | `current_temp`                                                             |
| 3      | `uint8`  | `current_weather_type`                                                     |
| 4      | `int16`  | `today_high_temp`                                                          |
| 6      | `int16`  | `today_low_temp`                                                           |
| 8      | `uint8`  | `tomorrow_weather_type`                                                    |
| 9      | `int16`  | `tomorrow_high_temp`                                                       |
| 11     | `int16`  | `tomorrow_low_temp`                                                        |
| 13     | `int32`  | `last_update_time_utc`                                                     |
| 17     | `uint8`  | `is_current_location`                                                      |
| 18     | `uint16` | serialized string bytes                                                    |
| 20     |          | location name, then condition phrase, each a `uint16` length and its bytes |

`MIN_ENTRY_SIZE` is 20 and `MAX_ENTRY_SIZE` is 116, which is why the location name is capped
at 62 bytes and the phrase at 30: each string spends two of its allowance on its own length.

**Location list** — `BlobDBIdWatchAppPrefs` (9), key `weatherApp`, value is a count byte
followed by that many 16-byte keys. This is not `BlobDBIdPrefs` (7), where the health
preferences live; sending it there is refused with `BLOB_DB_INVALID_DATA`.

The delivery time is stamped from the watch's own clock, not the browser's, because that is
the clock `weather_service` compares against when it decides an entry is older than
yesterday and drops it.

## Where the numbers come from

Live readings come from Open-Meteo: no key, no account, CORS headers, so the static build
needs no service of ours. The request asks for `current=temperature_2m,weather_code` and
`daily=weather_code,temperature_2m_max,temperature_2m_min` over two days, with
`temperature_unit` set from the units control. The firmware prints whatever integer it is
given next to a degree sign and converts nothing, so the unit is the phone's decision.

WMO 4677 present-weather codes are mapped onto the ten `WeatherType` values the firmware can
draw. A code outside that table is reported as `Unknown`, not guessed at.

Manual mode sets every field by hand and needs no network. Off withdraws both records.

The preview ships a sample forecast in the **Simulated inputs** drawer, beside the sample
battery, messages and calendar events, so the Weather app has something to draw without
anyone hunting for a switch. It is plainly simulated and fully editable, and **Use live
weather for this location** replaces it with the real forecast for the sample coordinates,
once, when pressed. Opening the preview reaches no third party on its own.

The sample forecast does not travel with the rest of the demo data. That is applied while
restored startup state is still settling, and at that point the weather database refuses a
record with `BLOB_DB_INVALID_DATABASE_ID` while accepting the identical one later in the
same session, so the forecast is published when the preview reports itself ready.

Nothing here invents a reading. A temperature the forecast omits is stored as
`WEATHER_SERVICE_LOCATION_FORECAST_UNKNOWN_TEMP` (`INT16_MAX`), which the watch draws as
`--°`, and a failed request is reported with nothing written to the watch.

## What is verified

`npm test` covers the record layout against vectors packed independently of the encoder, the
size and range refusals, the WMO mapping, the request shape and the failure paths.

`node scripts/verify-weather-browser.mjs` boots `qemu_emery` from a restored checkpoint in
the production UI. It first asserts that a visitor who configures nothing still gets the
sample forecast into the watch, which is what the publication timing above protects. It
then publishes a manual forecast and withdraws it, and asserts the firmware's
own BlobDB answers: both records accepted with `BLOB_DB_SUCCESS`, written to databases 5 and
9, withdrawn list-first and record-second. It leaves a watch screenshot beside its results as
evidence; the drawn forecast is checked by eye, not asserted.

Observed on `qemu_emery` 4.37.0: the launcher lists `Palo Alto / 68° - Sunny` with the sun
icon, and the Weather app draws the location, current temperature, condition, date and the
two-day high/low chart with the values that were sent. On a phone-sized viewport with no
stored settings and nothing clicked, it draws the sample forecast the same way.

The live path is verified against Open-Meteo's published OpenAPI schema and through an
injected transport. It has **not** been run against the live service, because the
development environment's egress policy blocks `api.open-meteo.com`.

## Not done

- The v4 record, which carries seven days of daily forecast, twenty-four hours of hourly
  data and per-day precipitation, wind and UV. The watch renders `--` for those today.
  Writing it means claiming bit 24 and filling every field it defines.
- More than one location. The emulator owns a single key so an update replaces the previous
  reading rather than accumulating stale forecasts.
- Reverse geocoding. A live reading with no name given is titled with its coordinates.

## References

PebbleOS v4.37.0, pinned at `9399f564fb5035057a9174025d2c6c625e942285`:

- [Weather record layout](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/blob_db/weather_db.h)
- [BlobDB IDs](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/blob_db/api.h)
- [Capability bit order](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/comm_session/session_remote_version.h)
- [Location list format](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/weather/weather_service_private.h)
- [WeatherType IDs](https://github.com/coredevices/PebbleOS/blob/9399f564fb5035057a9174025d2c6c625e942285/include/pbl/services/weather/weather_types.h)

Upstream Pebble firmware, for the service and endpoint behavior the headers do not show:

- [Capability gate and staleness rule](https://github.com/google/pebble/blob/main/src/fw/services/normal/weather/weather_service.c)
- [Version response handling](https://github.com/google/pebble/blob/main/src/fw/services/common/comm_session/session_remote_version.c)
- [Run state endpoint choice](https://github.com/google/pebble/blob/main/src/fw/process_management/app_run_state.c)
- [Endpoint 49 is the deprecated launcher](https://github.com/google/pebble/blob/main/src/fw/services/common/comm_session/protocol_endpoints_table.json)
- [Location list validation](https://github.com/google/pebble/blob/main/src/fw/services/normal/blob_db/watch_app_prefs_db.c)
- [Weather record validation](https://github.com/google/pebble/blob/main/src/fw/services/normal/blob_db/weather_db.c)

Open-Meteo:

- [Forecast API schema](https://github.com/open-meteo/open-meteo/blob/main/openapi/forecast.yml)
