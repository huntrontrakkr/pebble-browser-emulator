# Optional public downloads

The static application remains independently usable. Store catalogs/packages, GitHub raw
files, local PBWs/firmware, saved downloads, the virtual phone and local compilation do not
require this service. A failed direct public download can fall back to a user-configured
endpoint. The default is **disabled**, and shared preview links cannot change it.

## Local setup

Use Node 24.15 or later:

```sh
npm run dev:resources
```

The adapter binds only to `127.0.0.1:4318`. In the app, open **Preferences → Download service**,
enter `http://127.0.0.1:4318`, enable **Use a download service**, and select **Test connection**.
Remote endpoints require HTTPS. The same Preferences section can disable the service or
clear the separate device cache of public downloads.

| Setting                    | Default                                                                                   | Meaning                                |
| -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `RESOURCE_PORT`            | `4318`                                                                                    | Local HTTP port                        |
| `RESOURCE_ALLOWED_ORIGINS` | `http://localhost:4201,http://127.0.0.1:4201,http://localhost:4202,http://127.0.0.1:4202` | Comma-separated exact frontend origins |
| `RESOURCE_CACHE_DIR`       | `tmp/resource-service-cache`                                                              | Local disk cache directory             |

For Angular's default port 4200, include its exact origin in `RESOURCE_ALLOWED_ORIGINS`.
An HTTPS site needs an HTTPS endpoint rather than a localhost HTTP service. Deployment,
domains and durable hosting storage are intentionally deferred.

## Request path and cache

1. Try the original public URL in the browser, omitting credentials.
2. If the network request fails or returns 403/429/502/503/504, consult the enabled service.
3. Validate download size and any expected SHA-256 before use. Installation retains its
   normal PBW/platform/firmware protocol checks.
4. Save successful public bytes in IndexedDB, bounded to 48 entries/96 MiB. Catalog entries
   refresh after five minutes; valid cached data can be used when a refresh fails.
   Pinned package hashes avoid needing a catalog request on reopening.

The Node service caches up to 256 MiB/512 entries on disk using content-addressed files.
Catalog TTL is one minute and asset TTL is one hour. Private/no-store upstream responses
are not stored. Cache failures do not turn a successful download into a failed import.
The portable Fetch handler has an optional bounded 16 MiB memory cache; artifacts larger
than that still download but are not retained in memory. Edge hosting and its memory limits
have not been validated.

| Endpoint                 | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `GET /v1/status`         | Versioned protocol/capability discovery                               |
| `GET /v1/resource?url=…` | Approved public resource, with SHA-256, ETag and cache status headers |
| `GET /v1/blobs/{sha256}` | Immutable content lookup while those bytes remain cached              |

Only GET/HEAD/OPTIONS are supported. The service permits specific GitHub API/raw/release and
Pebble store/asset hosts and paths. Every redirect is checked, including known GitHub release
and Pebble asset storage hosts. Requests are bounded to 32 MiB, 30 seconds, two concurrent
upstream operations and a shared replenishing request budget. The optional edge entry point
limits concurrency to one. Incoming cookies, authorization headers and request bodies are
never forwarded. CORS uses an exact configured origin list; it is not authentication.

Remote HTML is rejected and responses are attachments with `nosniff`. The endpoint is not
an arbitrary URL proxy. It does not host configuration pages, execute repositories, compile
PBWs or run firmware. Relaying a watchface's own phone requests is a **separate** endpoint
with separate rules, described below, and a service may offer downloads while refusing it. It receives the public URLs it handles, so enable
only a service you trust. No service endpoint, credential or token is included in preview links.

## Relaying a watchface's phone requests

A watchface's phone script can only reach sites that permit browser requests. On a real
Pebble its JavaScript ran inside a native app, where no such rule exists, so authors had no
reason to send CORS headers and most did not. In a browser those requests fail, and no
amount of work inside this application can change that: it is enforced outside our reach.

`/v1/app-fetch` is the way out, and it is off unless a relay key is configured. A request
the browser refuses is retried through it; with no key, the request simply fails and nothing
is sent anywhere. That is the contract the static application keeps.

Configure it in **Preferences → Download service** by entering the service URL and its relay
key. A hosted copy may supply its own by serving `service-config.json` beside the
application; a visitor's own entry wins over it. An endpoint and a key are always taken as a
pair from the same source, never mixed, because a key is issued for one service and pairing
it with another's endpoint would hand that service a credential it was not given.

The key is not a password. A hosted copy ships one to every visitor's browser, so treat it
as a revocation handle: publishing a new file rotates it. It exists to make casual use of
someone else's relay inconvenient, not to authenticate anyone.

Relayed requests are `GET`/`HEAD` only, bounded to 1 MiB and 20 seconds, spend a request
budget separate from the download allowance, and never carry cookies, authorization headers
or request bodies. Because a watchface may call any weather or transit API, the relay cannot
allowlist hosts; the protection is the address it ends up talking to, not the name it asked
for. Every connection resolves through a lookup that refuses private, loopback, link-local,
carrier and cloud-metadata space, and each redirect hop is validated the same way. This
needs connection-level control, so the relay is Node-only: moving it to an edge runtime
would silently drop that defence.

Two things it cannot do. It cannot revive a backend that no longer exists -- a dead host
returns 502 through the relay and the watchface still shows nothing, which at least says
plainly whose server failed. And running one publicly means operating an open proxy:
requests leave your address, so abuse is attributed to you. Read `docs/HOSTING.md` before
pointing the public at one.

### Publishing a copy that uses a relay

Set the repository variable `PEBBLE_SERVICE_ENDPOINT` and the secret `PEBBLE_RELAY_KEY`. The
deploy writes `service-config.json` only when both are present; with either missing it
publishes a copy with no service and says so in the log. A malformed value fails the build
rather than reaching visitors. The file is absent from the repository by design.

## Firmware and package workflows

**Browse watchfaces** includes watchfaces and apps, a direct store-link field, and platform
selection. Store fetches currently work directly where the publisher supplies CORS headers.
The frontend checks each entry's declared platforms itself because the upstream catalog
can return incompatible apps despite its hardware query; pagination still advances over them.
GitHub preview also accepts an exact release tag and PBW attachment; those downloads can
use the optional service. A pinned link verifies its SHA-256 even if the release asset is
later replaced.

**Developer tools → Firmware** accepts an exact tag/source. **Load selected firmware**
downloads matching normal QEMU micro/SPI images together, excluding SDK-shell and physical
board images. The frontend checks metadata, exact URLs, size limits and published hashes.
Local image/bundle import and SDK import remain available. Arbitrary firmware compatibility,
source compilation and remote configuration behavior retain their separate acceptance gates.

Prepared startup files are served by the static website, not the download service. They
remain useful with the service disabled: [startup checkpoint preparation](STARTUP_CHECKPOINTS.md).

## Verification

`tests/resource-service.test.mjs` covers opt-in routing, direct success, cancellation,
credentials, host/redirect restrictions, byte limits, cache eviction, checksums, and pinned
store/release links. Live browser checks deliberately remain separate from offline unit CI:

```sh
node scripts/verify-resource-preview-browser.mjs
node scripts/verify-resource-service-browser.mjs
```

Serve the app on port 4201, or set `PEBBLE_BROWSER_URL`. Start the optional local service for
the second check; `PEBBLE_RESOURCE_SERVICE` overrides its address. The first check installs
the real JustTheTime store PBW, uses prepared boot, reopens a pinned link with remote fetches
blocked, and forces a normal boot. The second downloads real official firmware via the
service, then disables it and reloads the cached firmware with both download routes blocked.
Evidence is recorded under `tmp/resource-preview-browser` and `tmp/resource-service-browser`.
