# Time 2 optical prototype

Select **Pebble Time 2 → 3D watch → Display optics**. **Layered (experimental)** is
the initial Time 2 selection; **Standard** selects the previous Three.js physical
material for comparison. Lighting, light direction and backlight remain interactive.
The case geometry and the other two watches' materials are unchanged.

This is a numerically checked approximation of **assumed** optics. It is not a measured
Time 2 panel, a reconstruction of its proprietary layer stack, or evidence of better
firmware compatibility. The existing uncalibrated-preview label applies to both modes.

## Offline model

`scripts/optics/time2.json` contains every optical assumption. Mitsuba 3.7.1 / Dr.Jit 1.2.0
evaluate an ideal crossed-polarizer / 45-degree retarder stack on the GPU using Mueller
matrices and unpolarized incident light. Snell refraction sets the path length through
a homogeneous slab; Beer attenuation represents bulk loss. The effective retarder delay,
polarizer leakage, RGB filter spectra and normal-incidence white response are assumptions.

The bake samples 471 wavelengths from 360 to 830 nm at 1 nm intervals. It integrates
spectra with Mitsuba's CIE 1931 observer and converts XYZ to linear sRGB. Negative or
out-of-gamut RGB components are explicitly clipped. Reflection passes through each
Gaussian color filter twice; backlight passes once and uses an assumed blue-plus-phosphor
spectrum. Each primary's two-bit value weights open/closed subpixel areas. This does not
claim knowledge of the physical pixel arrangement or voltage-to-retardance relationship.

There are three response paths:

- **Direct reflection:** outgoing and incoming angle, with 32 samples per cosine axis.
- **Diffuse reflection:** 4,096 incoming cosine samples, integrated with the cosine-weighted
  hemisphere measure. Incoming glass transmission is included here.
- **Backlight:** independent outgoing-angle and color response, with a separate assumed
  normalization. The UI percentage is not luminance or LED power.

The reflector is treated as diffuse and depolarizing. The model is rotationally symmetric;
it omits azimuthal birefringence, detailed liquid-crystal dynamics, multiple internal
reflections, pixel diffraction, lens curvature, bonding interfaces and panel nonuniformity.
The normal white response is normalized to explicit unmeasured RGB targets, not inferred
from the GPU computation. No neural model or training dataset is involved.

This is a flat-layer transport calculation, **not** a full path-traced CAD scene. The
[Mitsuba polarization documentation](https://mitsuba.readthedocs.io/en/stable/src/key_topics/polarization.html)
describes the matrix conventions, and its
[variant documentation](https://mitsuba.readthedocs.io/en/stable/src/key_topics/variants.html)
describes GPU spectral/polarized evaluation. Our recipe and integration code are original;
the output contains no upstream CAD, firmware, photographs or toolchain binaries.

## Browser material

The versioned, checksummed RGBA8 asset occupies **278,528 bytes (272 KiB)**. It is a
272 × 256 atlas containing 64 color tiles, each 34 × 32 texels. The first 32 columns
cover incoming cosine; the last two contain diffuse and backlight response. RGB stores
the square root of linear response to preserve dark values with eight-bit quantization.
Texel-centered coordinates keep interpolation inside one color tile.

A specialized shader samples the native ARGB2222 framebuffer with nearest-neighbor
filtering and looks up three response values. It separately evaluates the dielectric
cover's Fresnel reflection, a GGX direct-light highlight and the existing prefiltered
environment reflection. The cover's outgoing transmission multiplies panel light once;
incoming transmission multiplies direct reflection once. Diffuse response already
contains incoming transmission. Environment lighting uses an isotropic-response/RGB
approximation, not a spectral reconstruction of arbitrary environments.

The 45,600-byte native Time 2 texture is separate from the existing presentation texture
used by Standard. Raw firmware state and frame comparisons never pass through either
optical model. There is no per-frame CPU spectral work or response-table generation.
The existing render-on-change and reduced resolution during orbit remain in effect.

The asset loads from the application's own base URL, including a GitHub Pages subdirectory.
It is included with the Time 2 offline download. Size, hash and cancellation checks precede
GPU allocation. Failed loading or a 10-second timeout reports a Standard fallback. Replacing a watch releases its
optical GPU resources; the small verified CPU table can be reused. The model specification
has an optional optical-profile identifier; Duo and Round have no assigned layered model.

## Reproduce

Python/Mitsuba are optional development tools. Normal builds and CI use the checked-in
asset and reference fixtures and require no GPU or Python optics packages.

```sh
uv venv --python 3.11 tmp/optics-venv
uv pip install --python tmp/optics-venv/bin/python -r scripts/optics/requirements.txt
tmp/optics-venv/bin/python scripts/optics/bake.py --publish
```

`--publish` writes the runtime table, generated TypeScript descriptor and independent
numerical fixture. Without it, all results remain in `tmp/optics-bake`. `--backend llvm`
explicitly selects CPU matrix evaluation; a failed CUDA initialization never silently
changes backends.

On this WSL host the system Linux CUDA library shadowed the working WSL driver. The bake
ran with `LD_LIBRARY_PATH=/usr/lib/wsl/lib`; no driver or system configuration was changed.
The verified device was an RTX 3090 with 24 GiB VRAM. The local CPU was an i9-12900KF
with 24 logical processors and 94 GiB visible RAM.

```sh
npm run build
npm test
PEBBLE_BROWSERS=chromium,firefox,webkit node scripts/verify-layered-optics.mjs
PEBBLE_OPTICS_BENCHMARK=1 node scripts/verify-layered-optics.mjs
node scripts/verify-model-browser.mjs
```

The numerical gate compares GPU Mueller evaluation with a separate FP64 closed-form
crossed-polarizer calculation. It then checks the quantized/interpolated response on
4,352 non-grid and endpoint samples for each of the three paths. All 64 colors occur.
The frozen fixture exercises the actual browser shader's native color decoding and LUT
sampling against that FP64 reference. Fixtures and colored charts are explicitly synthetic
material inputs, not watchface output. Lighting, dark/backlit behavior, corruption fallback,
duplicate uploads and disposal have browser checks. Existing actual-firmware model tests
exercise watch switching, screen contact, frame preservation and the comparison control.

Benchmark runs alternate Standard and Layered, warm each shader, use the same renderer,
geometry, lighting and framebuffer, and wait for GPU completion with a one-pixel readback.
They isolate rendering from firmware execution. Desktop/software-renderer measurements
do not establish Pixel 9 performance or sustained emulator frame rate.

## Recorded results

The RTX 3090 bake evaluated about 1.94 million wavelength/direction combinations. GPU
Mueller evaluation and the separate FP64 transfer formula differed by at most
1.59 × 10⁻⁷ in linear RGB. Quantized/interpolated table error stayed below 0.89/255 in
sRGB on each of the three response paths. The actual browser shader's 423 reference
probes stayed below 0.96/255 in Chromium and 1.64/255 in Firefox and Linux WebKit.
These are errors relative to the assumed model, not to a measured watch.

Three alternating paired trials in Chromium 153 / SwiftShader, at a 390 × 460 CSS-pixel
viewport with front, straight and side views, produced the following median completed
draw times (including a one-pixel readback):

| Rendering resolution | Standard | Layered | Reduction |
| --- | ---: | ---: | ---: |
| Interaction, pixel ratio 1 | 16.5 ms | 15.5 ms | 6.1% |
| Stationary, pixel ratio 1.5 | 24.2 ms | 22.8 ms | 5.8% |

This is a modest local rendering improvement, not a measured emulator-throughput gain.
Per-view reductions ranged from 3.4% to 9.5%. The first download additionally transfers
272 KiB; a cached table avoids that download. Physical phone rendering remains unmeasured.

The [Layered](evidence/time2-clock-layered.png) and
[Standard](evidence/time2-clock-standard.png) captures show the same paused, actual Clock
firmware frame. Switching materials preserves every framebuffer pixel in Chromium,
Firefox and WebKit. The core Wasm SHA-256 is unchanged. The production build, 376 JS/Wasm
tests (nine optional fixture skips), 87 Rust tests, loader failures, model switching and
optical browser checks pass. [Numerical, browser and benchmark records](evidence/time2-optics.json).

## Physical calibration still needed

Controlled photographs or panel measurements should cover a color/gray test chart,
several viewing and lighting angles, fixed exposure/white balance and separate ambient
and backlight conditions. Some samples must be withheld from fitting. Accuracy against
those held-out observations is a different gate from the numerical compression error.
Phone rendering cost, sustained emulator throughput and thermal behavior also need a
physical-device measurement. Increasing simulated sample counts cannot resolve unknown
material properties.
