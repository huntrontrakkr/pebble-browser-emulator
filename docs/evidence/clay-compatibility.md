# Clay 1.0.4 compatibility evidence

The actual registry package was checked against its published SHA-512 integrity, its SDK `dist.zip` was resolved by the browser package loader, and esbuild WebAssembly produced a 155,434-byte companion. That companion executed in the real QuickJS runtime.

A single `input` setting with key `NAME` generated an 83,180-character HTML data URL through `Pebble.openURL`. Returning the raw URI-encoded `{NAME:{value:'Lin',type:'string'}}` value through `webviewclosed` persisted `clay-settings` as `{"NAME":"Lin"}` and emitted AppMessage key10000/value`Lin`. An explicit host ACK settled the pending transaction once; a duplicate ACK was ignored. This proves bundling, runtime execution, configuration event handling, storage and message intent. The test does not render the configuration DOM or claim a physical/firmware watch ACK.

`clay-compatibility-evidence.json` records archive/bundle hashes and the exact fixture. No Clay archive or compiled third-party bundle needs to be committed.

Reproduce with the pinned registry archive supplied locally:

```sh
PEBBLE_CLAY_ARCHIVE=/path/to/pebble-clay-1.0.4.tgz \
  node --test tests/sdk-pkjs-compat.test.mjs
```

Ordinary tests cover SDK `app_package.json` aliases and `Pebble.on/off` without downloading anything. The actual Clay case is opt-in and rejects an archive with different integrity.
