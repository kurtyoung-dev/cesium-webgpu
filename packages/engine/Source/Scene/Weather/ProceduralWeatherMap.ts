/**
 * The default global weather map: a coarse procedural cloud-cover field that
 * gives the volumetric cloud deck geographic weather with no data pipeline at
 * all. A {@link WeatherProvider} carrying real data overwrites the same texture
 * bytes.
 *
 * It lives here, outside `Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts`, so
 * that the procedural producer and the real-data {@link packWeatherField}
 * producer share one seam and pole convention (`WeatherMapSeam`) and can be
 * pinned by a pure-Node contract rather than only by a GPU probe. Nothing here
 * imports the renderer.
 *
 * Byte layout, which must stay identical to the packer's:
 *   R = coverage, G = cloud type/genus (128 neutral), B = cloud base, A = density
 *   bias (128 neutral). 256x128 rgba8unorm equirectangular, row 0 = north.
 *
 * @module Scene/Weather/ProceduralWeatherMap
 */
import { applyEquirectPolarLowPass, periodicFbm2D } from "./WeatherMapSeam.js";

// Lattice periods of the two octave stacks, in cells per full longitude wrap.
// Integers so every octave of `periodicFbm2D` wraps on an exact lattice boundary
// — that is what makes the map continuous across the antimeridian.
const COARSE_CYCLES = 6;
const FINE_CYCLES = 18;

/** smoothstep(0, 1) on an already-normalized value. */
function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Build the procedural global weather map.
 *
 * Two octave stacks give continental cloudy and clear regions with finer
 * internal variation; the high-contrast smoothstep keeps clear regions genuinely
 * clear (R near 0) and storm regions genuinely overcast (R near 1), rather than
 * a gentle wash.
 *
 * The noise is evaluated at texel centres, the convention the GPU's `linear`
 * sampler reconstructs, is exactly periodic in longitude, and the result is run
 * through the pole-safe wrap-aware low-pass. An fBM that is aperiodic in `u`
 * leaves texel 0 and texel `w-1` — which `addressModeU: "repeat"` filters
 * together — holding unrelated values, and the antimeridian then shows a
 * full-contrast wall of cloud.
 *
 * @param w Texture width in texels.
 * @param h Texture height in texels.
 * @returns rgba8 bytes, length `w * h * 4`.
 */
export function buildProceduralWeatherMap(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Texel-centre parameters. `v` is not periodic (latitude does not wrap).
    const vv = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const big = periodicFbm2D(u * COARSE_CYCLES, vv * 6, COARSE_CYCLES);
      const fine = periodicFbm2D(u * FINE_CYCLES, vv * 18, FINE_CYCLES);
      const f = big * 0.7 + fine * 0.3;
      const coverage = smoothstep01((f - 0.42) / 0.18);
      const i = (y * w + x) * 4;
      data[i] = Math.round(coverage * 255); // R coverage
      data[i + 1] = 128; // G type-y (mid)
      data[i + 2] = 0; // B base/deck
      data[i + 3] = 128; // A density-bias
    }
  }
  return applyEquirectPolarLowPass(data, w, h);
}
