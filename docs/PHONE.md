# Virtual phone network and configuration contract

The virtual phone runtime remains an original implementation. `network-bootstrap.ts` executes inside QuickJS. `phone-network.ts` validates plain JSON and provides an optional browser-side CORS fetch adapter. No browser, DOM, Node, fetch, or AbortController host object enters the app VM. The separate GPL-3.0-only `phone-app` module now ports the actual upstream Kotlin/Compose settings screen and navigation handler; see [companion port scope](COMPANION_PORT.md).

## Start message

Existing fields remain unchanged. Additional optional fields:

```ts
{
  watchInfo: {
    platform: 'flint' | 'emery' | 'gabbro' | string,
    model: string,
    language: string,
    firmware: { major: number, minor: number, patch: number, suffix: string }
  } | null,
  appInfo: { /* package appinfo JSON */ },
  accountToken: string,
  watchToken: string,
  network: {
    mode: 'disabled' | 'fixtures' | 'cors',
    fixtures: [{
      url: 'https://weather.example/forecast',
      method: 'GET',       // defaults GET
      // body: null,      // optional exact body match; omission matches any body
      delayMs: 250,       // virtual time, defaults zero
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"temperature":23}'
      }
      // Or response: { error: 'network' | 'timeout' | 'abort' | 'disabled' | 'limit', message?: string }
    }]
  }
}
```

Default network mode is `disabled`. Unmatched fixtures fail; HTTP 4xx/5xx remain HTTP responses, with XHR `load` and fetch `ok === false`. Fixtures are exact URL/method matches, checked in array order, and do not make network calls. CORS mode uses real browser `fetch` with `mode: 'cors'`, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`; it cannot bypass mixed-content, private-network, CSP, or CORS browser rules.

Default watchInfo is null. Tokens default to empty strings, never fabricated real credentials. Supply stable simulator identities explicitly; watch tokens should be scoped to the simulated watch and app. App metadata defaults to `{uuid: appId}`. `getAppInfo()` is an emulator compatibility extension: it does not appear in the current official Pebble API documentation or mobile startup implementation.

## Observable messages and cancellation

Worker emits `{type:'event', phoneGeneration, event}`. New runtime events:

```ts
{ type:'network-request', timestamp, request:{id,method,url,headers,body,timeoutMs} }
{ type:'network-cancel', timestamp, requestId }
{ type:'configuration', timestamp, requestId, url }
```

For CORS completions, Worker also emits `{type:'network-result', phoneGeneration, requestId, accepted, status?, responseBytes?, error?, message?}`. The Worker handles CORS requests internally; UI must not send them a second time. A direct `VirtualPhone` host can supply a bounded result with `deliverNetworkResponse(id,result)`. It returns false if already completed, canceled, or timed out. The runtime retains no host response object.

Worker stop/replacement disposes and aborts its network session. Completion callbacks check both generation and VirtualPhone identity. IDs may restart in a new app but stale responses cannot cross that boundary. AppMessage ACK ownership, location injection, and storage remain separate and retain existing tests.

## Configuration flow

Send `{type:'configuration'}` to dispatch `showConfiguration`. The app calls `Pebble.openURL(url)`, emitting a new configuration request ID. The UI opens or displays the requested page and returns:

```ts
{ type:'configurationClosed', phoneGeneration, requestId, response: string | null }
```

The runtime forwards this response string unchanged. The new companion port uses the pinned
upstream interceptor's **single URL decode**, matching that native handler; it does not
re-encode its result. The manual debug field still forwards the exact entered string.
`null` means cancellation. Duplicate/stale request IDs and stale supplied generations are
ignored. Legacy uncorrelated response calls remain accepted by the API for compatibility;
the UI always supplies both identifiers and verifies page/app identity.

`openURL` accepts HTTP(S) or HTML data URLs, including large Clay-generated pages. Preview
renders them in the separate companion module's opaque sandbox. Local literal close targets
are translated to a static callback; external pages must use `return_to`. Arbitrary remote
custom-scheme navigation cannot be observed by a generic browser parent. An explicit new-tab
button handles embedding restrictions without a proxy. PKJS storage now persists locally by
app ID, with legacy session storage as a fallback. WebView storage is scoped separately.

## Limits and explicit gaps

Defaults: 8 pending HTTP requests, 8 KiB serialized requests, 1 MiB decoded response text, 30 s maximum request duration, 128 fixtures and at most 4 MiB aggregate fixture JSON (also capped by half of VM memory), 512 KiB configuration URL/response, 1 MiB queued event output. Existing 16 MiB QuickJS memory, execution deadline, timer, output, and message limits remain enforced. XHR timeouts and fixtures use virtual time; real browser fetch also has a wall-clock timeout.

SDK array message keys reserve named blocks first from 10000, then single keys in declaration order. `window` aliases only the isolated QuickJS global, matching official mobile startup.

Implemented: asynchronous XHR readyState, property/event-listener handlers, status/headers, text/JSON responses, timeout/abort, progress/completion events; fetch text/JSON response promises, Headers, clone/body consumption, AbortController/Signal; injected watch/app metadata/tokens; configuration request/return correlation.

Not implemented: complete Android/iOS app emulation, DOM/WebView execution in QuickJS, WebSocket, fetch Request/streams/binary/form data, XHR sync/binary/XML/MIME override/upload progress, credentialed requests/cookies, modifying XHR timeout during flight, automatic external configuration interception, real account/timeline/AppGlance/notification services. Unsupported operations reject or throw; they do not report successful physical/network effects. Fetch is a useful compatibility addition, not a guarantee of historical iOS PKJS availability.

## Primary sources checked

- Official [PebbleKit JS API](https://developer.repebble.com/docs/pebblekit-js/Pebble/): watch info, tokens, configuration event payloads, and actual watch ACK requirement.
- Official [static configuration guide](https://developer.repebble.com/guides/user-interfaces/app-configuration-static/): encoded close fragments and `return_to`.
- Official [emulator configuration explanation](https://developer.repebble.com/blog/2015/01/30/Pebble-Emulator-JavaScript-Simulation/): native URL interception versus browser callback convention.
- Current official mobile source pinned to `d1cffc9e2cfa995ab81487c776cef08d99765997`: [startup API](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/androidMain/assets/startup.js), [watch-info construction](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/ActivePebbleWatchInfo.kt), [token scoping](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/PKJSInterface.kt), [model strings](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/metadata/WatchColor.kt).

Current verified models: Flint `pebble_2_duo_black` / `pebble_2_duo_white`; current Emery `pebble_time_2_black_gray`, `pebble_time_2_black_red`, `pebble_time_2_silver_blue`, `pebble_time_2_silver_gray`; Gabbro `pebble_round_2_black`, `pebble_round_2_silver`, `pebble_round_2_gold`, `pebble_round_2_silver_14`. Firmware version is not inferred from these names and must be injected from verified image metadata or an explicit user context override.

## Validation

Passed: 12 runtime tests (including SDK block-key allocation); 16 network/context/config tests; 3 actual phone Worker tests; 5 prior phone lifecycle tests; strict TypeScript check. Worker tests use a controlled fetch harness to verify cancellation and exact CORS options without external HTTP dependencies. Real browser CORS is supplied by the browser fetch implementation, not emulated by the Node harness.


## Shared watch clock and sensor fixtures

When a firmware watch is active, its virtual clock owns phone timers. The watch runs at most
10 ms of virtual time per coupled quantum, sends its clock boundary, and waits for QuickJS
and the host bridge to acknowledge the matching sequence. Phone AppMessages are queued before
that acknowledgement. A late sequence from a previous firmware generation cannot release the
new watch. Engine startup holds the first phase; location inputs received during startup are
queued with their virtual timestamps. Pause stops both runtimes. Standalone phone tests retain
their independent clock.

Watch restart and an explicit RTC change stop the phone script; start it again to establish
the new clock origin. Application storage remains saved. This is not a whole-session snapshot.
Real CORS responses remain external events with nondeterministic completion times. Seeded
`Math.random`, network fixtures and a supplied initial watch/phone state are required for
repeatable input scenarios; full session recording/replay is still pending.

Location fixtures accept altitude, altitude accuracy, clockwise heading and speed. Permission
denied, position unavailable and timeout errors can be injected; watcher callbacks recover
when a later coordinate is supplied. These errors do not fabricate physical GPS hardware.
`getCurrentPosition` timeout/maximumAge/permission lifecycles are not fully modeled.

Health preferences use actual BlobDB database 7 writes. The synthetic user preset is 170 cm,
70 kg, age 30, unspecified gender. Activity tracking must be enabled before the firmware
accepts metric overrides. Heart-rate input is a service sample; raw BPM and filtered BPM are
different firmware outputs. Compass currently reports unavailable in the verified 4.37.0
builds, matching the native reference.
