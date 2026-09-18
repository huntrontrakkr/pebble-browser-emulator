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

## Optional service and domains

GitHub Pages does not run the Node download/cache service. The hosted application keeps it
disabled by default. Browser downloads work when upstream CORS permits them; local files,
previously cached resources and bundled examples remain usable. See
[optional download service](OPTIONAL_SERVICES.md) for the separate deployment contract.

A custom domain can be attached later without moving the app to another host. Domain/DNS
configuration and a production host/cache/rate-limit policy for the optional service remain
separate decisions.
