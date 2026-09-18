# Virtual phone network and configuration contract

The virtual phone runtime remains an original implementation. `network-bootstrap.ts` and `websocket-bootstrap.ts` execute inside QuickJS. `phone-network.ts` and `phone-websocket.ts` validate plain messages and provide optional browser fetch/WebSocket adapters. No browser, DOM, Node, socket, fetch, or AbortController host object enters the app VM. The separate GPL-3.0-only `phone-app` module now ports the actual upstream Kotlin/Compose settings screen and navigation handler; see [companion port scope](COMPANION_PORT.md).

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
  timelineToken: string, // optional explicit test token; empty by default
  language: 'en-US', // optional phone locale; independent of watchInfo.language
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
      // Binary XHR fixture: { status: 200, bodyBase64: 'AP+ACg==', headers: {'content-type':'image/png'} }
      // Or response: { error: 'network' | 'timeout' | 'abort' | 'disabled' | 'limit', message?: string }
    }]
  }
}
```

Default network mode is `disabled`. Unmatched fixtures fail; HTTP 4xx/5xx remain HTTP responses, with XHR `load` and fetch `ok === false`. Fixtures are exact URL/method matches, checked in array order, and do not make network calls. CORS mode uses real browser `fetch` with `mode: 'cors'`, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`; it cannot bypass mixed-content, private-network, CSP, or CORS browser rules.

Default watchInfo is null. Tokens default to empty strings, never fabricated real credentials. Supply stable simulator identities explicitly; watch tokens should be scoped to the simulated watch and app. App metadata defaults to `{uuid: appId}`. `getAppInfo()` is an emulator compatibility extension: it does not appear in the current official Pebble API documentation or mobile startup implementation.

`Pebble.getTimelineToken(onSuccess,onFailure)` calls the failure callback when no token is
supplied. An explicitly entered test token takes the success path. No timeline account or
server is synthesized, and a test token does not authorize Pebble's public timeline API.

`navigator.language` and the frozen one-element `navigator.languages` expose the phone locale.
The browser Worker defaults to its browser locale; standalone/deterministic runs default to
`en-US`. This does not change the simulated watch language.

## WebSockets

Select **Network access → Browser network (HTTP + WebSocket)** for real connections.
The persisted mode name remains `cors`; WebSocket handshakes use browser security and server
Origin rules, not HTTP fetch CORS. HTTPS hosting generally requires `wss:` endpoints.
No backend is required, and no proxy bypasses authentication or browser restrictions.

Implemented: absolute WS(S)/HTTP(S) URL normalization, subprotocol negotiation, ready states,
property/listener events, text/ArrayBuffer/typed-array/Blob sends, incoming text and Blob or
ArrayBuffer messages, buffered amount, error and clean/abnormal close events. The isolated
Blob surface supports construction, size/type, slice, text and arrayBuffer; it is not the
entire Blob/File/stream API. Relative URLs, URL credentials and custom handshake headers
are unsupported. The browser manages any applicable handshake credentials.

Defaults are four sockets, 64 KiB per message, 128 KiB buffered output and a 30-second
connection/close deadline. VM allocation/execution/output bounds also apply. Restart/stop
closes real sockets and quarantines late callbacks. Connection timeout uses virtual time
inside the VM and wall time in the browser adapter. Live response timing is nondeterministic.

Disabled and HTTP-fixture modes expose WebSocket but asynchronously report error and
abnormal close (1006); they never fabricate a successful connection or server message.
Worker diagnostics include `websocket-command` and `websocket-result`; the UI truncates
individual displayed network records explicitly at 8 KiB. Direct hosts can route commands
through `PhoneWebSocketNetwork` and return bounded events through `deliverWebSocketEvent`.

## Binary HTTP and callback errors

XHR supports `responseType = 'arraybuffer'` and `'blob'` with exact binary bytes. Live
responses are streamed and capped at 256 KiB before base64 transfer into QuickJS; text
responses retain their 1 MiB limit. Binary fixtures use `bodyBase64`, checked before the
VM receives it. `responseText` is unavailable for binary/JSON response types. Browser
fetch is invoked with its proper Worker context. The real browser gate exercises both
binary response types across the Worker/QuickJS boundary.

Incoming `appmessage` payloads are ordinary objects with `hasOwnProperty`, while each
received key is defined as an own data property to prevent prototype mutation.
`window.addEventListener` and `removeEventListener` register listeners on the isolated
phone global; `beforeunload`/`unload` fire when that VM is disposed. There is no DOM.
Exceptions in app event handlers and timers are recorded as phone errors, and subsequent
events can run. Execution-budget and memory failures still stop the VM. An app that parses
an empty configuration cancellation as JSON therefore remains visibly erroneous without
freezing the whole simulated phone.

## Observable messages and cancellation

Worker emits `{type:'event', phoneGeneration, event}`. New runtime events:

```ts
{ type:'network-request', timestamp, request:{id,method,url,headers,body,timeoutMs,responseType?} }
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
Host `null` means cancellation and becomes `event.response === ''` inside PebbleKit JS,
matching the documented mobile cancellation behavior. Duplicate/stale request IDs and stale supplied generations are
ignored. Legacy uncorrelated response calls remain accepted by the API for compatibility;
the UI always supplies both identifiers and verifies page/app identity.

`openURL` accepts HTTP(S) or HTML data URLs, including large Clay-generated pages. Preview
renders them in the separate companion module's opaque sandbox. Local literal close targets
are translated to a static callback; external pages must use `return_to`. Arbitrary remote
custom-scheme navigation cannot be observed by a generic browser parent. An explicit new-tab
button handles embedding restrictions without a proxy. PKJS storage now persists locally by
app ID, with legacy session storage as a fallback. WebView storage is scoped separately.

## Limits and explicit gaps

Defaults: 8 pending HTTP requests, 8 KiB serialized requests, 1 MiB decoded response text, 256 KiB binary responses, 30 s maximum request duration, 128 fixtures and at most 4 MiB aggregate fixture JSON (also capped by half of VM memory), 512 KiB configuration URL/response, 1 MiB queued event output. Existing 16 MiB QuickJS memory, execution deadline, timer, output, and message limits remain enforced. XHR timeouts and fixtures use virtual time; real browser fetch also has a wall-clock timeout.

SDK array message keys reserve named blocks first from 10000, then single keys in declaration order. `window` aliases only the isolated QuickJS global, matching official mobile startup.

Implemented: asynchronous XHR readyState, property/event-listener handlers, status/headers, text/JSON/ArrayBuffer/Blob responses, timeout/abort, progress/completion events; fetch text/JSON response promises, Headers, clone/body consumption, AbortController/Signal; injected watch/app metadata/tokens; configuration request/return correlation and the token failure callback.

Not implemented: complete Android/iOS app emulation, DOM/WebView execution in QuickJS, fetch Request/streams/binary/form data, XHR sync/XML/MIME override/upload progress, credentialed HTTP requests/cookie management, modifying XHR timeout during flight, automatic external configuration interception, real account/timeline/AppGlance/notification services. Unsupported operations reject or throw; they do not report successful physical/network effects. Fetch is a useful compatibility addition, not a guarantee of historical iOS PKJS availability.

## Primary sources checked

- Official [Pebble JavaScript tips](https://developer.repebble.com/blog/2013/12/20/Pebble-Javascript-Tips-and-Tricks/): canceled configuration returns an empty string.
- Official retained [internationalization guide](https://developer.rebble.io/guides/tools-and-resources/internationalization/): phone `navigator.language`, separate from watch locale.
- [WebSocket standard](https://websockets.spec.whatwg.org/): URL/protocol/state, binary payloads, buffering and close contracts. This is a bounded implementation, not a complete conformance claim.
- Official [PebbleKit JS API](https://developer.repebble.com/docs/pebblekit-js/Pebble/): watch info, tokens, configuration event payloads, and actual watch ACK requirement.
- Official [advanced communication guide](https://developer.repebble.com/guides/communication/advanced-communication/): binary image downloads require XHR `arraybuffer` and Uint8Array conversion.
- Official [static configuration guide](https://developer.repebble.com/guides/user-interfaces/app-configuration-static/): encoded close fragments and `return_to`.
- Official [emulator configuration explanation](https://developer.repebble.com/blog/2015/01/30/Pebble-Emulator-JavaScript-Simulation/): native URL interception versus browser callback convention.
- Current official mobile source pinned to `d1cffc9e2cfa995ab81487c776cef08d99765997`: [startup API](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/androidMain/assets/startup.js), [watch-info construction](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/ActivePebbleWatchInfo.kt), [token scoping](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/PKJSInterface.kt), [model strings](https://github.com/coredevices/mobileapp/blob/d1cffc9e2cfa995ab81487c776cef08d99765997/libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/metadata/WatchColor.kt).

Current verified models: Flint `pebble_2_duo_black` / `pebble_2_duo_white`; current Emery `pebble_time_2_black_gray`, `pebble_time_2_black_red`, `pebble_time_2_silver_blue`, `pebble_time_2_silver_gray`; Gabbro `pebble_round_2_black`, `pebble_round_2_silver`, `pebble_round_2_gold`, `pebble_round_2_silver_14`. Firmware version is not inferred from these names and must be injected from verified image metadata or an explicit user context override.

## Validation

Passed: 12 runtime tests (including SDK block-key allocation); 16 network/context/config tests; 3 actual phone Worker tests; 5 prior phone lifecycle tests; strict TypeScript check. Worker tests use a controlled fetch harness to verify cancellation and exact CORS options without external HTTP dependencies. Real browser CORS is supplied by the browser fetch implementation, not emulated by the Node harness.

Eight additional phone/WebSocket tests cover locale/cancellation, URL normalization, offline
failure, text/binary/blob transfer, bounds, timeout and stale callbacks. The actual browser
Worker/QuickJS bridge passes a local real-socket fixture in Chromium, Firefox and WebKit:
text/binary round trips, negotiated protocol, clean close, offline blocking and restart
cleanup. Reproduce with `node scripts/verify-phone-websocket-browser.mjs`; set
`PEBBLE_BROWSERS=chromium` for the CI subset. External app servers are not certified by this fixture.
The same browser gate now checks exact binary XHR and Blob results in all three engines.


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
