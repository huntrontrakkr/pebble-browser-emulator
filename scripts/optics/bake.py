"""Offline spectral/Mueller evaluation, compact LUT, and independent numerical checks.

Uses original parameter assumptions in time2.json. There are no watch photographs,
CAD derivatives, firmware images, or learned weights in the generated asset.
GPU evaluation is explicit: failure never silently substitutes a CPU benchmark.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import drjit as dr
import mitsuba as mi
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RECIPE = Path(__file__).with_name("time2.json")


def fresnel(mu, ior):
    """Unpolarized air/dielectric power reflectance, evaluated independently in FP64."""
    transmitted = np.sqrt(1 - (1 - np.asarray(mu) ** 2) / ior**2)
    rs = ((mu - ior * transmitted) / (mu + ior * transmitted)) ** 2
    rp = ((ior * mu - transmitted) / (ior * mu + transmitted)) ** 2
    return (rs + rp) * 0.5


def slab(mu, wavelength, p, gpu):
    cosine = np.asarray(mu, dtype=np.float64).reshape(-1, 1)
    wave = wavelength.reshape(1, -1)
    if gpu:
        c = mi.Float(np.broadcast_to(cosine, (len(cosine), len(wavelength))).ravel())
        w = mi.Float(np.broadcast_to(wave, (len(cosine), len(wavelength))).ravel())
        internal = dr.sqrt(1 - (1 - c * c) / p["glass_ior"] ** 2)
        phase = 2 * math.pi * p["retarder_delay_nm"] / (w * internal)
        polarizer = mi.mueller.linear_polarizer(mi.Float(1))
        analyzer = mi.mueller.rotated_element(math.pi / 2, polarizer)
        retarder = mi.mueller.rotated_element(math.pi / 4, mi.mueller.linear_retarder(phase))
        # Entry (0,0) is intensity for incident unpolarized Stokes [1,0,0,0].
        opened = (analyzer @ retarder @ polarizer)[0, 0]
        opened = opened * (1 - p["polarizer_leak"]) + 0.5 * p["polarizer_leak"]
        attenuation = dr.exp(-p["bulk_optical_depth"] / internal)
        opened *= attenuation
        closed = 0.5 * p["polarizer_leak"] * attenuation
        dr.eval(opened, closed)
        return (np.asarray(opened).reshape(len(cosine), -1).astype(np.float64),
                np.asarray(closed).reshape(len(cosine), -1).astype(np.float64))
    # Independent closed-form crossed-polarizer law, rather than the GPU matrix code.
    internal = np.sqrt(1 - (1 - cosine**2) / p["glass_ior"] ** 2)
    half_phase = math.pi * p["retarder_delay_nm"] / (wave * internal)
    attenuation = np.exp(-p["bulk_optical_depth"] / internal)
    opened = 0.5 * ((1 - p["polarizer_leak"]) * np.sin(half_phase) ** 2 + p["polarizer_leak"])
    return opened * attenuation, np.broadcast_to(0.5 * p["polarizer_leak"] * attenuation, opened.shape)


class Reference:
    def __init__(self, p):
        self.p = p
        first, last, step = p["wavelength_nm"]
        self.wavelength = np.arange(first, last + step / 2, step, dtype=np.float64)
        xyz = np.asarray(mi.cie1931_xyz(mi.Float(self.wavelength))).T.astype(np.float64)
        # Standard linear-sRGB / XYZ D65 matrix. Equal-energy illuminant is explicit.
        matrix = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415],
                           [0.0557, -0.2040, 1.0570]])
        weights = xyz @ matrix.T
        weights[[0, -1]] *= 0.5
        weights *= step
        wave = self.wavelength[:, None]
        filters = p["filter_leak"] + (1 - p["filter_leak"]) * np.exp(
            -0.5 * ((wave - p["filter_centers_nm"]) / p["filter_widths_nm"]) ** 2)
        # Transfer through each filter twice for reflection, once for backlight.
        self.reflection_weights = filters[:, :, None] ** 2 * weights[:, None, :] / 3
        led = np.exp(-0.5 * ((wave[:, 0] - 450) / 20) ** 2) + 1.8 * np.exp(
            -0.5 * ((wave[:, 0] - 560) / 90) ** 2)
        self.backlight_weights = filters[:, :, None] * (weights * led[:, None])[:, None, :] / 3
        opened, _ = slab([1], self.wavelength, p, False)
        normal_r = np.einsum("w,wpc->c", opened[0] ** 2, self.reflection_weights)
        normal_b = np.einsum("w,wpc->c", opened[0], self.backlight_weights)
        self.reflection_weights *= np.array(p["normal_white_reflectance_rgb"]) / normal_r
        self.backlight_weights *= np.array(p["normal_white_backlight_rgb"]) / normal_b
        self.levels = np.array([[(i >> 4) & 3, (i >> 2) & 3, i & 3] for i in range(64)]) / 3
        self.averages = {}

    def colors(self, opened, closed, weights):
        primary_on = np.einsum("...w,wpc->...pc", opened, weights)
        primary_off = np.einsum("...w,wpc->...pc", closed, weights)
        rgb = np.einsum("kp,...pc->k...c", self.levels, primary_on - primary_off)
        rgb += np.sum(primary_off, axis=-2)
        # Negative linear RGB from out-of-gamut spectra is clipped explicitly.
        return np.clip(rgb, 0, 1)

    def tables(self, angles, gpu):
        opened, closed = slab(angles, self.wavelength, self.p, gpu)
        direct = self.colors(opened[:, None, :] * opened[None, :, :],
                             closed[:, None, :] * closed[None, :, :], self.reflection_weights)
        # Midpoint integration of isotropic hemisphere with cosine measure, 2 mu dmu.
        avg_on, avg_off = self.hemisphere(gpu)
        diffuse = self.colors(opened * avg_on, closed * avg_off, self.reflection_weights)
        backlight = self.colors(opened, closed, self.backlight_weights)
        # k=color, y=view cosine, x=incident cosine followed by diffuse and backlight columns.
        return np.concatenate([direct, diffuse[:, :, None, :], backlight[:, :, None, :]], axis=2)

    def hemisphere(self, gpu):
        if gpu not in self.averages:
            n = self.p["hemisphere_samples"]
            incoming = (np.arange(n) + 0.5) / n
            io, ic = slab(incoming, self.wavelength, self.p, gpu)
            measure = 2 * incoming * (1 - fresnel(incoming, self.p["glass_ior"])) / n
            self.averages[gpu] = (measure @ io, measure @ ic)
        return self.averages[gpu]

    def held_out(self, views, lights, kind="direct"):
        vo, vc = slab(views, self.wavelength, self.p, False)
        if kind == "backlight":
            return self.colors(vo, vc, self.backlight_weights)
        if kind == "diffuse":
            io, ic = self.hemisphere(False)
            return self.colors(vo * io, vc * ic, self.reflection_weights)
        io, ic = slab(lights, self.wavelength, self.p, False)
        return self.colors(vo * io, vc * ic, self.reflection_weights)


def pack(values):
    colors, rows, columns, _ = values.shape
    atlas = np.zeros((rows * 8, columns * 8, 4), dtype=np.uint8)
    encoded = np.rint(np.sqrt(np.clip(values, 0, 1)) * 255).astype(np.uint8)
    for color in range(colors):
        y, x = divmod(color, 8)
        atlas[y * rows:(y + 1) * rows, x * columns:(x + 1) * columns, :3] = encoded[color]
    atlas[:, :, 3] = 255
    return atlas


def interpolate(atlas, colors, views, lights, n, kind="direct"):
    # Matches normalized, texel-centered WebGL linear filtering in encoded space.
    x = np.clip(lights, 0, 1) * (n - 1)
    if kind != "direct":
        x = np.full(len(colors), n + (kind == "backlight"))
    y = np.clip(views, 0, 1) * (n - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, n + 1), np.minimum(y0 + 1, n - 1)
    base_x, base_y = (colors % 8) * (n + 2), (colors // 8) * n
    def sample(xx, yy):
        return atlas[base_y + yy, base_x + xx, :3] / 255
    top = sample(x0, y0) * (1 - (x - x0)[:, None]) + sample(x1, y0) * (x - x0)[:, None]
    bottom = sample(x0, y1) * (1 - (x - x0)[:, None]) + sample(x1, y1) * (x - x0)[:, None]
    return (top * (1 - (y - y0)[:, None]) + bottom * (y - y0)[:, None]) ** 2


def srgb(linear):
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["cuda", "llvm"], default="cuda")
    parser.add_argument("--out", type=Path, default=ROOT / "tmp/optics-bake")
    parser.add_argument("--publish", action="store_true", help="Write the reviewed runtime table and metadata into the checkout.")
    args = parser.parse_args()
    started = time.perf_counter()
    mi.set_variant(args.backend + "_ad_spectral_polarized")
    recipe_bytes = RECIPE.read_bytes()
    p = json.loads(recipe_bytes)
    reference = Reference(p)
    n = p["angle_samples"]
    angles = np.linspace(0, 1, n)
    table = reference.tables(angles, True)
    dr.sync_thread()
    bake_seconds = time.perf_counter() - started
    check_started = time.perf_counter()
    cpu = reference.tables(angles, False)
    matrix_error = float(np.max(np.abs(cpu - table)))
    assert matrix_error < 2e-5, f"GPU Mueller / FP64 closed-form disagreement: {matrix_error}"
    assert np.all(np.isfinite(table)) and np.all(table >= 0) and np.all(table <= 1)
    atlas = pack(table)
    # Non-grid test samples include every color, both extrema, and grazing angles.
    rng = np.random.default_rng(20260918)
    colors = np.tile(np.arange(64), 64)
    views, lights = rng.random(len(colors)), rng.random(len(colors))
    colors = np.concatenate([colors, np.tile(np.arange(64), 4)])
    views = np.concatenate([views, np.repeat([0, 0, 1, 1], 64)])
    lights = np.concatenate([lights, np.repeat([0, 1, 0, 1], 64)])
    errors, fixtures, images = {}, [], []
    for kind in ["direct", "diffuse", "backlight"]:
        exact = reference.held_out(views, lights, kind)[colors, np.arange(len(colors))]
        compact = interpolate(atlas, colors, views, lights, n, kind)
        error = np.abs(srgb(compact) - srgb(exact)) * 255
        max_error, rms = float(error.max()), float(np.sqrt(np.mean(error ** 2)))
        assert max_error < 3.0 and rms < 0.8, f"{kind} table error {max_error=} {rms=}"
        errors[kind] = {"maxSrgb255Error": max_error, "rmsSrgb255Error": rms}
        fixtures.extend({"kind": kind, "color": int(colors[i]), "view": float(views[i]),
                         "light": float(lights[i]), "rgb": exact[i].tolist()}
                        for i in range(0, len(colors), 31))
        images.append((exact[:4096], compact[:4096]))
    # Separate reference charts, explicitly material test input rather than firmware output.
    args.out.mkdir(parents=True, exist_ok=True)
    for name, channel in [("reference", 0), ("compact", 1)]:
        chart = np.concatenate([srgb(pair[channel]).reshape(64, 64, 3) for pair in images], axis=1)
        image = (chart * 255).round().astype(np.uint8)
        Image.fromarray(image).resize((1152, 384), Image.Resampling.NEAREST).save(args.out / (name + ".png"))
    # A manageable, independent FP64 fixture for the actual browser shader.
    (args.out / "reference.json").write_text(json.dumps(fixtures, indent=2) + "\n")
    data = atlas.tobytes()
    sha = hashlib.sha256(data).hexdigest()
    filename = f"time2-v1-{sha[:12]}.rgba"
    manifest = {"id": p["id"], "calibration": p["calibration"], "path": "optics/" + filename,
                "sha256": sha, "bytes": len(data), "width": atlas.shape[1], "height": atlas.shape[0],
                "angles": n, "glassIor": p["glass_ior"], "glassRoughness": p["glass_roughness"],
                "recipeSha256": hashlib.sha256(recipe_bytes).hexdigest()}
    report = {"backend": mi.variant(), "mitsuba": mi.__version__, "drjit": dr.__version__,
              "numpy": np.__version__, "spectralSamples": len(reference.wavelength),
              "hemisphereSamples": p["hemisphere_samples"], "bakeSeconds": bake_seconds,
              "checkSeconds": time.perf_counter() - check_started,
              "matrixVsClosedFormMaxLinearError": matrix_error,
              "heldOutSamplesPerPath": len(colors), "heldOutErrors": errors, "manifest": manifest,
              "scope": "Numerical approximation of assumed optics, not validation against a physical watch."}
    (args.out / filename).write_bytes(data)
    (args.out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if args.publish:
        (ROOT / "public/optics" / filename).write_bytes(data)
        (ROOT / "src/app/watch-optics-profile.ts").write_text(
            "// Generated by scripts/optics/bake.py from explicit, unmeasured assumptions.\n"
            "export const TIME2_OPTICS = " + json.dumps(manifest, indent=2) + " as const;\n")
        (ROOT / "docs/evidence/time2-optics-reference.json").write_text(json.dumps({
            "recipeSha256": manifest["recipeSha256"], "scope": report["scope"],
            "samples": fixtures}, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
