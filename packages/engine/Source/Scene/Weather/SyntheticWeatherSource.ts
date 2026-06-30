/**
 * Deterministic synthetic weather source (Phase 0 — testing / offline). Emits a
 * known global coverage field so the ingest pipeline (source -> packer ->
 * weatherTex -> clouds) can be verified end-to-end WITHOUT depending on the live
 * (dev-lab, CORS-uncertain) EDR endpoint. Patterns:
 *   - "uniform"  : a flat coverage value everywhere.
 *   - "eastwest" : a west(0) -> east(1) longitude gradient (clearly spatial).
 *   - "bands"    : alternating latitude bands.
 *   - "drift"    : a sinusoidal cloud band whose longitude phase advances with
 *                  `request.time` — a deterministic TIME-VARYING field for the
 *                  Phase-2 time model (no network). Same time -> same field.
 *   - "rich"     : Phase 3 — a high, near-uniform R coverage with INDEPENDENTLY
 *                  spatially-varying G (genus, by longitude quadrant), B (cloud
 *                  base, north->south), and A (density bias, west->east), so a
 *                  probe can prove the shader applies G/B/A, not just R.
 *
 * @module Scene/Weather/SyntheticWeatherSource
 */
import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";
import { CLOUD_BASE_NORM_METERS } from "./WeatherTexPacker.js";

export type SyntheticPattern =
  | "uniform"
  | "eastwest"
  | "bands"
  | "drift"
  | "rich";

const HOUR_MS = 3600000;
// "drift" parameters: 3 longitude bands that complete one full rotation per day.
const DRIFT_SPATIAL_CYCLES = 3;
const DRIFT_PERIOD_HOURS = 24;

/** Optional present-weather the synthetic field carries (PRECIP-DATA, Batch 444). */
export interface SyntheticPresentWeather {
  /** Uniform WMO `ww` present-weather code (00..99) across the field. */
  ww?: number;
  /** Aggregate visibility, KILOMETRES (low → denser data-driven precip). */
  visibilityKm?: number;
}

export class SyntheticWeatherSource implements WeatherSource {
  private readonly _pattern: SyntheticPattern;
  private readonly _value: number;
  private readonly _w: number;
  private readonly _h: number;
  private readonly _present: SyntheticPresentWeather | undefined;

  /**
   * @param pattern Spatial pattern.
   * @param value For "uniform", the coverage 0..1 (default 0.8).
   * @param gridWidth Field grid width (default 64).
   * @param gridHeight Field grid height (default 32).
   * @param present Optional present-weather (WMO `ww` + visibility) the field
   *   carries. Used by the data-driven precipitation path (PRECIP-DATA, Batch
   *   444) to drive a KNOWN `ww` code offline. Omitted → coverage-only field,
   *   byte-identical to the pre-444 synthetic source.
   */
  constructor(
    pattern: SyntheticPattern = "uniform",
    value: number = 0.8,
    gridWidth: number = 64,
    gridHeight: number = 32,
    present?: SyntheticPresentWeather,
  ) {
    this._pattern = pattern;
    this._value = value;
    this._w = gridWidth;
    this._h = gridHeight;
    this._present = present;
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `synthetic:${this._pattern}`,
      label: `Synthetic (${this._pattern})`,
      // "drift" honors request.time; the static patterns ignore it. Advertising
      // time support lets the provider's time model resolve slices off this source.
      supportsTime: this._pattern === "drift",
    };
  }

  fetchField(request: WeatherFieldRequest): Promise<WeatherField> {
    const w = this._w;
    const h = this._h;
    const coverage = new Float32Array(w * h);
    // Phase 3 — the "rich" pattern also fills the genus/base/density channels with
    // INDEPENDENT spatial patterns (each varies along a different axis) so a probe
    // can isolate the shader's G/B/A response from R coverage.
    const isRich = this._pattern === "rich";
    const type = isRich ? new Float32Array(w * h) : undefined;
    const baseMeters = isRich ? new Float32Array(w * h) : undefined;
    const densityBias = isRich ? new Float32Array(w * h) : undefined;
    // "drift": phase from request.time (fixed reference when "latest"/absent).
    const timeMs = request.time instanceof Date ? request.time.getTime() : 0;
    const phase = (timeMs / (DRIFT_PERIOD_HOURS * HOUR_MS)) * 2.0 * Math.PI;
    for (let y = 0; y < h; y++) {
      const v = h > 1 ? y / (h - 1) : 0; // 0 = north, 1 = south
      for (let x = 0; x < w; x++) {
        const u = w > 1 ? x / (w - 1) : 0; // 0 = west, 1 = east
        let c: number;
        if (this._pattern === "eastwest") {
          c = w > 1 ? x / (w - 1) : this._value;
        } else if (this._pattern === "bands") {
          c =
            Math.floor(y / Math.max(1, Math.floor(h / 6))) % 2 === 0
              ? 0.9
              : 0.05;
        } else if (this._pattern === "drift") {
          const du = w > 1 ? x / w : 0;
          c =
            0.5 +
            0.5 * Math.sin(2.0 * Math.PI * DRIFT_SPATIAL_CYCLES * du - phase);
        } else if (isRich) {
          // High, near-flat R so the deck is present EVERYWHERE — the G/B/A
          // variation (not coverage) is what the probe must detect.
          c = 0.85;
        } else {
          c = this._value;
        }
        coverage[y * w + x] = c;
        if (isRich && type && baseMeters && densityBias) {
          const i = y * w + x;
          // A (density bias, 0.5 neutral) — west(thin 0.05) -> east(thick 0.95),
          // so the east half of the field is conspicuously denser than the west.
          densityBias[i] = 0.05 + 0.9 * u;
          // B (cloud base, metres over the 12 km band) — north(low ~0) ->
          // south(high), so southern clouds sit higher in the shell.
          baseMeters[i] = v * CLOUD_BASE_NORM_METERS * 0.85;
          // G (genus index 0..10) — flat SLAB (STRATUS=7) on the west longitudes,
          // towering CUMULONIMBUS=10 on the east, so the deck shape changes by
          // quadrant. Packer stores type/10, shader biases the height profile.
          type[i] = u < 0.5 ? 7.0 : 10.0;
        }
      }
    }
    // PRECIP-DATA (Batch 444) — carry present-weather when configured. A uniform
    // `ww` grid + the field-level `representativeWw`/`visibilityKm` let the
    // data-driven precip path read a known code offline (no network).
    let ww: Float32Array | undefined;
    if (this._present?.ww !== undefined) {
      ww = new Float32Array(w * h);
      ww.fill(this._present.ww);
    }

    return Promise.resolve({
      gridWidth: w,
      gridHeight: h,
      coverage,
      type,
      baseMeters,
      densityBias,
      ww,
      representativeWw: this._present?.ww,
      visibilityKm: this._present?.visibilityKm,
      bounds: GLOBAL_WEATHER_BOUNDS,
      validTime:
        request.time instanceof Date ? request.time.toISOString() : undefined,
      source: `synthetic:${this._pattern}`,
    });
  }
}
