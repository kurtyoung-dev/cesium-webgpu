/**
 * Shared CoverageJSON → grid parse (Weather Phase 3 — Batch 425). Extracted from
 * {@link EdrWeatherSource} so BOTH the OGC API-EDR source AND the OGC API-Coverages
 * (WCS) source ({@link WcsCoveragesWeatherSource}) parse the SAME wire shape — no
 * copy-paste, one place to fix orientation / null-handling / units. CoverageJSON
 * parses natively in the browser, so neither source needs a GRIB2/NetCDF/GeoTIFF
 * binary decoder.
 *
 * Output orientation matches the {@link WeatherField} convention: row 0 = NORTH
 * (lat descending), column 0 = WEST (lon ascending), so the packer is a straight
 * resample.
 *
 * @module Scene/Weather/CoverageJsonParser
 */
import { type WeatherBounds, type WeatherField } from "./WeatherTypes.js";

export interface CovJsonAxis {
  values?: number[];
  start?: number;
  stop?: number;
  num?: number;
}

export interface CovJsonRange {
  values?: (number | null)[];
  shape?: number[];
}

export interface CoverageJSON {
  domain?: {
    axes?: { x?: CovJsonAxis; y?: CovJsonAxis };
  };
  ranges?: Record<string, CovJsonRange>;
}

export interface CoverageJsonParseOptions {
  /** Range/parameter key to read; falls back to the first range if absent. */
  parameterName?: string;
  /** Source units: "percent" (0-100) → scaled by 1/100, or "fraction" (0-1). */
  units?: "percent" | "fraction";
  /** Bounds to stamp on the resulting field. */
  bounds: WeatherBounds;
  /** Source id stamped on the field + used for attribution lookup. */
  source?: string;
  attribution?: string;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Resolve a CoverageJSON axis to an explicit value list (handles start/stop/num). */
export function axisValues(axis: CovJsonAxis | undefined): number[] | null {
  if (!axis) {
    return null;
  }
  if (axis.values && axis.values.length > 0) {
    return axis.values;
  }
  if (
    typeof axis.start === "number" &&
    typeof axis.stop === "number" &&
    typeof axis.num === "number" &&
    axis.num > 0
  ) {
    const out: number[] = [];
    const step = axis.num > 1 ? (axis.stop - axis.start) / (axis.num - 1) : 0;
    for (let i = 0; i < axis.num; i++) {
      out.push(axis.start + i * step);
    }
    return out;
  }
  return null;
}

/**
 * Parse a CoverageJSON `Coverage` into a normalized {@link WeatherField}'s
 * COVERAGE channel (R). G/B/A are not derived here — sources that have genus /
 * base / density data add those channels themselves (e.g. METAR), since
 * CoverageJSON cloud feeds carry only a cloud-cover range.
 *
 * @throws if x/y axes or the range are missing, or the range is shorter than the grid.
 */
export function parseCoverageJson(
  cov: CoverageJSON,
  opt: CoverageJsonParseOptions,
): WeatherField {
  const xs = axisValues(cov.domain?.axes?.x);
  const ys = axisValues(cov.domain?.axes?.y);
  if (!xs || !ys || xs.length === 0 || ys.length === 0) {
    throw new Error("CoverageJSON: missing x/y axis values");
  }
  const ranges = cov.ranges;
  const range =
    (opt.parameterName ? ranges?.[opt.parameterName] : undefined) ??
    (ranges ? ranges[Object.keys(ranges)[0]] : undefined);
  const values = range?.values;
  if (!values) {
    throw new Error("CoverageJSON: missing range values");
  }
  const gw = xs.length;
  const gh = ys.length;
  if (values.length < gw * gh) {
    throw new Error(`CoverageJSON: range ${values.length} < grid ${gw}x${gh}`);
  }
  // Orient so row 0 = north (lat descending), col 0 = west (lon ascending).
  const yDescending = ys[0] > ys[ys.length - 1];
  const xAscending = xs[0] < xs[xs.length - 1];
  const norm = opt.units === "fraction" ? 1 : 1 / 100;
  const coverage = new Float32Array(gw * gh);
  for (let oy = 0; oy < gh; oy++) {
    const sy = yDescending ? oy : gh - 1 - oy; // source row for north-first output
    for (let ox = 0; ox < gw; ox++) {
      const sx = xAscending ? ox : gw - 1 - ox;
      const v = values[sy * gw + sx];
      coverage[oy * gw + ox] =
        v === null || v === undefined ? 0 : clamp01(v * norm);
    }
  }
  return {
    gridWidth: gw,
    gridHeight: gh,
    coverage,
    bounds: opt.bounds,
    source: opt.source,
    attribution: opt.attribution,
  };
}
