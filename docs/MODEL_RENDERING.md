# Watch switching, model size and optical rendering

## Behavior and root cause

Changing the Watch selector used to cancel the running preview and update only the selector.
The old firmware/profile remained paused, so the 3D view correctly continued to show the old
case. Reproduction started Clock on 2 Duo, selected Round 2 and observed the paused Duo;
pressing Try example again finally booted Round 2. Selection now reopens the active example,
GitHub preview or uploaded PBW on the selected profile. Unsupported packages still fail
explicitly rather than appearing to run on another board.

Once firmware accepts a profile, the renderer replaces the case, screen dimensions and
projected button anchors before redrawing. One WebGL canvas, camera and renderer survive
switches. Obsolete loads are canceled by terminating their geometry Worker; stale completion
cannot dispose or overwrite the replacement. Inactive GPU geometry is disposed. The same
lifecycle also applies when returning to the separate diagnostic profile.

CAD fetching, SHA-256 verification, STL parsing, simplification and compaction run in a
dedicated Worker. A 12 MiB LRU retains prepared CPU arrays; IndexedDB stores one derived
entry per profile, keyed by the pinned CAD/specification and simplification version. Storage
failure falls back to downloading and verifying the source. The first visit still downloads
the original CAD and pays the additional simplification cost. Later opens reuse the mesh.
The app does not redistribute the upstream STL or a preprocessed derivative.

## Decimation

Meshoptimizer 1.1, already bundled with Three.js, simplifies indexed geometry with position
and normal attributes. Normal weights are 0.5; the target triangle ratio is 0.1, constrained
by an absolute combined-error limit of 0.025 in the CAD's millimetre scale. This is the
simplifier's error metric, **not a guaranteed maximum surface distance**. It may stop above
the requested ratio. Small disconnected components are not explicitly pruned. The screen
mesh, native framebuffer dimensions, sampling and button anchor coordinates are unchanged.

| Model | Original triangles | Simplified triangles | Reduction | Original geometry bytes | Simplified geometry bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Time 2 | 197,374 | 34,381 | 82.6% | 14,210,928 | 2,088,420 |
| 2 Duo | 99,772 | 12,156 | 87.8% | 7,183,584 | 648,504 |
| Round 2 | 11,766 | 8,056 | 31.5% | 847,152 | 567,960 |

Combined geometry storage falls from 22,241,664 to 3,304,884 bytes (85.1%). These numbers
cover positions/normals/indices, not total process memory or reflection textures. An earlier
more aggressive setting reduced highlights poorly; the retained setting prioritizes shading.
Four views per model, rendered with the original materials to isolate geometry changes,
have silhouette intersection-over-union of at least 99.934% and mean absolute RGB difference
below 1.33/255 over intersecting silhouettes. Individual edge/highlight pixels can differ
more. This is a visual regression check, not a proof of physical accuracy.

## Lighting and display

Time 2 additionally has an experimental offline-baked layered display, selected through
**Display optics**. **Standard** retains the material described below; Duo and Round continue
to use it. See [the optical prototype](OPTICAL_MODEL.md) for the separate numerical reference,
asset format, performance measurements and unmeasured assumptions.

Select **3D watch**, then choose **Lighting**, **Light direction**, **Ambient light** and
**Backlight**. Studio, daylight and warm-room environments contain procedural softboxes/
windows and ground reflection. They are generated once per renderer/preset at 128-pixel
cube-face resolution and reused; there is no HDR download or per-frame reflection capture.

The LCD is a diffuse reflective surface beneath a clearcoat cover, using Three.js's physical
material and view-dependent reflections. The case uses metal or plastic shading. Ambient
light controls reflected illumination; the separate backlight term illuminates the display
in darkness without making the case glow. The raw screen texture remains at the selected
watch's actual resolution and uses nearest-neighbor sampling. Lighting does not recolor
that texture every frame. The 2D Reflective view combines ambient and backlight in linear
light; both at zero now produces darkness rather than an arbitrary brightness floor.

Optics remain **uncalibrated**. The cover index/roughness, pigment palette, environment,
exposure and backlight spectrum/intensity are representative settings, not measurements of
a particular physical watch. The controls are independent of sensor injection and firmware
LED state. Polarizer/viewing-cone behavior, measured color-filter transmission, panel
nonuniformity, optical bonding and exact lens geometry are not calibrated. No claims of
photographic equivalence, lux, physical battery drain or certified color accuracy follow
from this presentation layer. The official [backlight explanation](https://help.repebble.com/en/articles/15277496-backlight)
and [Time 2 construction notes](https://repebble.com/blog/pebble-time-2-is-in-mass-production)
inform the reflective-display/cover model; [Three.js material documentation](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)
describes the rendering model and its performance tradeoff.

[Clock on Time 2 in studio lighting](evidence/model-lighting-clock.png) and
[the lighting controls with Clock on 2 Duo](evidence/model-lighting-controls.png) show the
actual firmware preview at a mobile viewport.

## Performance and acceptance

Repeated identical firmware frames produce no texture upload or WebGL draw. Camera/resize
changes update the projected button positions, rather than every screen repaint. Hidden
models stop rendering. On high-DPI displays, orbit motion renders at pixel ratio 1 and
returns to the normal cap of 1.5 after 180 ms without camera changes; the watch framebuffer
and CAD remain unchanged. Richer lighting adds fragment-shader work, especially on Round 2;
the interaction resolution limits that cost while keeping stationary detail.

Three alternating paired trials in Chromium 153 with SwiftShader at a 390 × 460 CSS-pixel
viewport give these medians (milliseconds per completed render, including readback):

| Model | Original, full detail | New lighting, full detail | Original at interaction resolution | New at interaction resolution |
| --- | ---: | ---: | ---: | ---: |
| Time 2 | 45.8 | 24.2 | 45.2 | 16.7 |
| 2 Duo | 27.3 | 19.9 | 27.8 | 13.1 |
| Round 2 | 6.3 | 17.0 | 6.4 | 10.4 |

Full detail uses pixel ratio 1.5 for both versions. The original also used 1.5 during
interaction; the new version uses 1, restoring 1.5 afterward. Full-detail timings aggregate
four angles; interaction timings use the front angle. These isolated software-renderer
measurements include GPU readback overhead and exclude concurrent firmware execution.
They are not browser FPS or a physical-phone benchmark. Round 2 becomes more expensive
with these optical effects; the change is not a speedup for every model/workload.

Cold preparation with local CAD responses takes approximately 1.74 s, 1.04 s and 0.35 s
respectively, versus 0.18 s, 0.09 s and 0.02 s previously. Simplification adds first-use work
in the cancellable Worker; cached reopening avoids it. WebGL/material/environment setup
still occurs on the UI thread and can cause a first-use hitch, particularly with software
rendering. Moving CAD work off-thread does not eliminate all browser/GPU startup costs.

The browser gates cover actual Clock firmware running through Duo → Round → Time → Duo,
renderer identity, correct button locations, one CAD fetch per profile, persisted cache
reuse after reload, cancellation, duplicate frames, hidden rendering, restoration of detail
after motion, and lighting controls that leave the framebuffer/pigment pixels unchanged.
Separate optical checks cover all three watches and lighting states in Chromium, Firefox
and WebKit. Their plain white screen is explicit material-test input, not firmware output.
Screenshots of Clock use actual bundled firmware. Unit tests cover lifecycle ordering,
cancellation/error propagation and a synthetic mesh with a small separate button.

The Rust/Wasm hardware core remains byte-identical at SHA-256
`67b6dfc41fadb7865cdc10d73f917b13abda443cb2ed542076893aa302d649ec`.
The complete unit suite passes 355 tests with 9 optional fixture skips. CPU execution,
virtual time, sensors and phone protocols are unchanged. Headless desktop render timings
must not be treated as Pixel 9 Pro XL frame rates; physical-phone acceptance remains open.

The first CI run also exposed a pre-existing test timing dependency: the phone interruption
test's 20 ms budget expired during trusted bootstrap setup under runner contention, before
the guest loop began. That test now freezes its setup clock and restores real wall time
before executing the infinite guest script. It still asserts real interruption and refuses
to resume the stopped VM; production timeout/sandbox behavior is unchanged.

Reproduce with a production build:

```sh
npm run build
npm test
PEBBLE_BROWSERS=chromium,firefox,webkit node scripts/verify-model-browser.mjs
PEBBLE_BROWSERS=chromium,firefox,webkit node scripts/verify-optics-browser.mjs
```

The scripts fetch and checksum official CAD into ignored `tmp/model-cad`, or accept
`PEBBLE_CAD_DIR` for a local fixture directory. Browser/geometry records and renderer
measurements are stored in [model evidence](evidence/model-rendering.json). For a paired
benchmark, provide an earlier production build (baseline: commit `6cbfba0`):

```sh
PEBBLE_MODEL_BASELINE=/path/to/baseline/dist/client \
PEBBLE_MODEL_COMPARE_IMAGES=0 node scripts/benchmark-model-browser.mjs
```

The benchmark alternates three before/after trials, warms each view, and forces GPU
completion with a one-pixel readback instead of timing command submission. It uses pattern
pixels as explicit renderer input. RGB equality is disabled when comparing different
lighting models; the separate geometry-only record uses identical original materials.
