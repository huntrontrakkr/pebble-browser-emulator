# Configuration save investigation

The report described an error while saving a setting such as Clock's dark background,
without an error string or browser/address. Fresh online saves succeeded on both localhost
and the public site. The following is a reproduced failure mode, not a confirmed identification
of that original browser's error.

## Interrupted return

The local HTML adapter rewrote `pebblejs://close` into an HTTP callback URL. Even a bundled
settings form therefore needed another navigation to return its values. Disconnecting the
network after opening the form caused that navigation to fail, left the settings pane on a
browser error page, and delivered no configuration result or settings AppMessage.

Local close URLs now become an absolute `about:srcdoc` fragment. The page sends that fragment's
unchanged native close URL to its parent through the existing session-bound message channel.
The compiled upstream Kotlin interceptor still performs the single decode, PKJS still sends
the settings, and only the watch firmware can acknowledge the AppMessage. The opaque origin,
scripts/forms-only sandbox, size limits, sender checks and app/session ownership remain.
External HTTP(S) settings retain the existing `return_to` callback and browser restrictions.

`scripts/verify-phone-app-browser.mjs` disconnects networking before the first Save and
requires no callback request, a real firmware ACK, changed watch pixels, cancellation and
persistence after reload. The production PWA gate also rejects callback requests from the
local form. Unit coverage includes encoded/Unicode values, legacy close delimiters and
cancellation; the real JustTheTime PBW exercises its bundled Clay form.

## Separate development startup failure

A fresh development preview also failed with `incorrect header check`. Angular's server
serves `.bin.gz` firmware with `Content-Encoding: gzip`; Fetch already expands that HTTP
encoding, and the loader attempted a second expansion. Previously cached firmware hid it.

The loader now checks the first two body bytes before choosing gzip expansion or direct
streaming. It still bounds the output to the expected size and verifies the published SHA-256
of every image. Tests cover compressed and HTTP-decoded bodies, a split gzip header,
corruption, truncation, oversize and cancellation at each streaming stage.

See [browser results and unchanged core hash](evidence/configuration-save.json). These are
desktop browser engine tests, not measurements or direct inspection of the reporting device.
