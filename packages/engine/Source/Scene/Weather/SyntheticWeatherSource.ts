/**
 * Deterministic synthetic weather source (Phase 0 — testing / offline). Emits a
 * known global coverage field so the ingest pipeline (source -> packer ->
 * weatherTex -> clouds) can be verified end-to-end WITHOUT depending on the live
 * (dev-lab, CORS-uncertain) EDR endpoint. Patterns:
 *   - "uniform"  : a flat coverage value everywhere.
 *   - "eastwest" : a west(0) -> east(1) longitude gradient (clearly spatial).
 *   - "bands"    : alternating latitude bands.
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

export type SyntheticPattern = "uniform" | "eastwest" | "bands";

export class SyntheticWeatherSource implements WeatherSource {
  private readonly _pattern: SyntheticPattern;
  private readonly _value: number;
  private readonly _w: number;
  private readonly _h: number;

  /**
   * @param pattern Spatial pattern.
   * @param value For "uniform", the coverage 0..1 (default 0.8).
   * @param gridWidth Field grid width (default 64).
   * @param gridHeight Field grid height (default 32).
   */
  constructor(
    pattern: SyntheticPattern = "uniform",
    value: number = 0.8,
    gridWidth: number = 64,
    gridHeight: number = 32,
  ) {
    this._pattern = pattern;
    this._value = value;
    this._w = gridWidth;
    this._h = gridHeight;
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `synthetic:${this._pattern}`,
      label: `Synthetic (${this._pattern})`,
      supportsTime: false,
    };
  }

  fetchField(_request: WeatherFieldRequest): Promise<WeatherField> {
    const w = this._w;
    const h = this._h;
    const coverage = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c: number;
        if (this._pattern === "eastwest") {
          c = w > 1 ? x / (w - 1) : this._value;
        } else if (this._pattern === "bands") {
          c =
            Math.floor(y / Math.max(1, Math.floor(h / 6))) % 2 === 0
              ? 0.9
              : 0.05;
        } else {
          c = this._value;
        }
        coverage[y * w + x] = c;
      }
    }
    return Promise.resolve({
      gridWidth: w,
      gridHeight: h,
      coverage,
      bounds: GLOBAL_WEATHER_BOUNDS,
      validTime: undefined,
      source: `synthetic:${this._pattern}`,
    });
  }
}
