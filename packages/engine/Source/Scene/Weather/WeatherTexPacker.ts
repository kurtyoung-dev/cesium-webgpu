/**
 * Bakes a normalized {@link WeatherField} into the WebGPU cloud renderer's
 * weather-map texture bytes (Phase 0). The output byte layout EXACTLY matches
 * {@link buildProceduralWeatherMap} (Scene/Weather/ProceduralWeatherMap.ts) — a
 * 256x128 (default) rgba8unorm equirectangular texture, row 0 = north:
 *   R = coverage (0..1 -> 0..255)   — the only channel the shader reads today
 *   G = cloud type / genus (scaffolding, default 128)
 *   B = cloud base, normalized      (scaffolding, default 0)
 *   A = density bias (0.5 neutral)  (scaffolding, default 128)
 *
 * ALL unit conversions live here so a WeatherSource only emits normalized data.
 *
 * @module Scene/Weather/WeatherTexPacker
 */
import type { WeatherField } from "./WeatherTypes.js";
import { applyEquirectPolarLowPass } from "./WeatherMapSeam.js";

/** 12 km covers cirrus; cloud base metres normalize into [0,1] over this band. */
export const CLOUD_BASE_NORM_METERS = 12000.0;

function bilinear(
  data: Float32Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
): number {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return (
    a * (1 - tx) * (1 - ty) +
    b * tx * (1 - ty) +
    c * (1 - tx) * ty +
    d * tx * ty
  );
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Resample a {@link WeatherField} to a `texW x texH` rgba8 weather texture.
 * Assumes the field spans the texture's extent (MVP: a global field into the
 * global weatherTexBounds). Honouring `WeatherField.bounds` for REGIONAL fields
 * is `C13-08`; the seam/pole convention below is `C13-07`.
 *
 * @param field The normalized weather grid.
 * @param texW Texture width (default 256, matches WEATHER_TEX_W).
 * @param texH Texture height (default 128, matches WEATHER_TEX_H).
 * @returns rgba8 bytes, length `texW*texH*4`.
 */
export function packWeatherField(
  field: WeatherField,
  texW: number = 256,
  texH: number = 128,
): Uint8Array {
  const out = new Uint8Array(texW * texH * 4);
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  const hasType = field.type !== undefined && field.type.length === gw * gh;
  const hasBase =
    field.baseMeters !== undefined && field.baseMeters.length === gw * gh;
  const hasDensity =
    field.densityBias !== undefined && field.densityBias.length === gw * gh;

  for (let ty = 0; ty < texH; ty++) {
    // Row 0 = north in both the field and the texture, so the v axes align.
    // C13-07: resample at TEXEL CENTRES — `(ty + 0.5) / texH` — not at texel
    // indices normalized over `texH - 1`. A `linear` sampler reconstructs the
    // stored value at the texel CENTRE, so the old edge-anchored mapping put the
    // field up to half a texel off in longitude, which is exactly the pair of
    // values `addressModeU: "repeat"` blends across the antimeridian.
    const fy = ((ty + 0.5) / texH) * (gh - 1);
    for (let tx = 0; tx < texW; tx++) {
      const fx = ((tx + 0.5) / texW) * (gw - 1);
      const i = (ty * texW + tx) * 4;

      out[i] = Math.round(
        clamp01(bilinear(field.coverage, gw, gh, fx, fy)) * 255,
      );
      // G: cloud-type index (CloudType 0..10) packed as index/10 → 0..255, so the
      // shader recovers the genus via round(G/255 * 10). Scaffolding until the
      // shader reads G; default 128 (mid) when no type is provided (matches the
      // procedural map's G).
      out[i + 1] = hasType
        ? Math.round(
            clamp01(
              bilinear(field.type as Float32Array, gw, gh, fx, fy) / 10.0,
            ) * 255,
          )
        : 128;
      out[i + 2] = hasBase
        ? Math.round(
            clamp01(
              bilinear(field.baseMeters as Float32Array, gw, gh, fx, fy) /
                CLOUD_BASE_NORM_METERS,
            ) * 255,
          )
        : 0;
      out[i + 3] = hasDensity
        ? Math.round(
            clamp01(
              bilinear(field.densityBias as Float32Array, gw, gh, fx, fy),
            ) * 255,
          )
        : 128;
    }
  }
  // C13-07 — pole-safe: collapse the polar-cap rows to a single longitude value
  // and taper the longitudinal over-sampling below them, so a straight-down polar
  // camera does not read a different cell per azimuth. Exact no-op below ~59 deg.
  return applyEquirectPolarLowPass(out, texW, texH);
}
