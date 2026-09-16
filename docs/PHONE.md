# Virtual phone network and configuration contract

Original implementation; no upstream implementation code is bundled. `network-bootstrap.ts` executes inside QuickJS. `phone-network.ts` validates plain JSON and provides an optional browser-side CORS fetch proxy. No browser, DOM, Node, fetch, or AbortController host object enters the app VM.

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

Preserve the raw encoded response fragment; PKJS commonly calls `decodeURIComponent` itself. `null` means cancellation. Duplicate/stale request IDs and stale supplied generations are ignored. Legacy uncorrelated response calls remain accepted for compatibility, so the UI should always echo both identifiers. `openURL` accepts HTTP(S) or HTML data URLs, including large Clay-generated pages, and never opens or evaluates them itself. Any page rendered by the host must remain isolated from the emulator app. A cross-origin configuration page's `pebblejs://close#...` navigation is not observable by a generic browser parent; use an explicit manual return, or a page supporting the official emulator `return_to` convention and a controlled callback page.

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
