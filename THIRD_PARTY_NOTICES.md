# Third-party notices

Original project source is Apache-2.0 (see LICENSE).

Runtime/build dependencies retain their own licenses. Angular, RxJS, tslib, and the
JavaScript tooling are installed from npm; the production Angular build emits its
license inventory. Rust dependencies and exact versions are recorded in Cargo.lock;
serde, serde_json, and associated crates retain their declared MIT/Apache-2.0 licenses.

No PebbleOS firmware, SDK binaries, QEMU code, or third-party ARM CPU implementation is
included. The protocol is implemented originally using documented wire formats.
Protocol golden vectors were generated with MIT-licensed libpebble2, Copyright 2015
Pebble Technology, at commit 23e2eb92cfc084e6f9e8c718711ac994ef606d18.

Unicorn is an optional developer-only reference emulator installed separately for
validation. It is not linked into or distributed with the browser application.
