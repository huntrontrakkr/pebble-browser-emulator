# Hosting

The public application uses GitHub Pages at
<https://huntrontrakkr.github.io/pebble-browser-emulator/>. No custom domain or external
hosting account is required. The existing Sites deployment is separate and is not updated
by this workflow.

## Releases

`.github/workflows/ci.yml` builds and tests the Rust/Wasm core, companion, Angular frontend,
production PWA, models and reference execution before packaging `dist/client` for Pages.
Only `main` pushes or manual runs on `main` can deploy. Pull requests are tested without
publishing. Main runs are serialized so ordinary successive pushes cannot publish out of
order. The `github-pages` deployment environment and GitHub's short-lived workflow token
handle publishing; no additional API secret is needed.

The deploy job publishes the already tested artifact without rebuilding. A failed build or
test leaves the previous deployment in place. After publication, `verify-hosted-site.mjs`
checks every PWA inventory file plus the service worker against that artifact's exact sizes
and SHA-256 values, along with executable MIME types and the worker's cache policy. It retries
briefly for CDN propagation. A failed post-publication check marks the run failed; it does
not automatically roll back a deployment that has already happened.

For a manual release, open **Actions → Verify → Run workflow**, selecting `main`.
For a rollback, revert the problematic change on `main`; the normal checks and deployment
then publish the corrected build. Avoid rerunning an old successful workflow to roll back:
that would publish an older revision without changing the current source branch.

## Browser behavior

The relative base URL, scoped service worker and fragment-based preview routes support the
repository subdirectory. Firmware, startup checkpoints, examples and runtime modules are
static files. Visitors' emulation, phone scripts and compilation run in their browsers.
The existing PWA update flow continues to govern already-open or installed copies.

Saved files, offline downloads and settings belong to the site's origin. They do not migrate
automatically from the previous Sites address, or to a future custom domain. Reimport local
files and download the desired offline watch at the new address.

## Publishing at your own domain

A subdomain, not an apex: a subdomain is a single `CNAME` record, while an apex needs Pages'
`A`/`AAAA` addresses and has to be revisited whenever they change.

1. At the DNS provider for the domain, add

   ```
   pebble.example.com.   CNAME   huntrontrakkr.github.io.
   ```

   The target is the account's Pages host, not the project path, and it keeps the trailing
   dot if the provider expects fully qualified names.

2. Set the repository variable `PEBBLE_SITE_DOMAIN` to the bare hostname, `pebble.example.com`.
   The next `main` deploy writes the `CNAME` file Pages needs into the artifact and repoints
   the absolute link-preview URLs. Leaving the variable unset publishes at the default
   address and changes nothing.

3. In **Settings → Pages**, set the custom domain to the same hostname, wait for the DNS
   check, then enable **Enforce HTTPS**. The certificate is issued automatically and can take
   a few minutes.

Order matters only in that the DNS record should exist before the Pages check runs;
publishing the `CNAME` file first is harmless.

The application itself needs no change. Its base URL is relative, the service worker is
scoped, and preview routes are fragments, so a domain root works exactly as the repository
subdirectory did. Two consequences are worth stating plainly. Saved files, offline downloads
and settings belong to an origin and do **not** follow the move; visitors reimport at the new
address. And `verify-hosted-site.mjs` checks whatever `page_url` the deployment reports, so it
follows the custom domain without configuration.

## Optional service and domains

The relay and download service is a Node process and GitHub Pages cannot run it, so it needs
a host of its own -- `relay.example.com` alongside the site, on any platform that runs a
container or a Node process. Do not move it to an edge runtime: its SSRF defence replaces DNS
resolution at connect time, which those runtimes do not offer, and porting it there drops that
protection silently. Its `RESOURCE_ALLOWED_ORIGINS` must name the site's new origin exactly,
and `PEBBLE_SERVICE_ENDPOINT` plus `PEBBLE_RELAY_KEY` point the published copy at it. Read the
operational cost in [optional services](OPTIONAL_SERVICES.md) before exposing one publicly.

GitHub Pages does not run the Node download/cache service. The hosted application keeps it
disabled by default. Browser downloads work when upstream CORS permits them; local files,
previously cached resources and bundled examples remain usable. See
[optional download service](OPTIONAL_SERVICES.md) for the separate deployment contract.

A custom domain can be attached later without moving the app to another host. Domain/DNS
configuration and a production host/cache/rate-limit policy for the optional service remain
separate decisions.
