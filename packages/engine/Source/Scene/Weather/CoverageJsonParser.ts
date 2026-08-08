/**
 * Shared CoverageJSON-to-grid parse. Both the OGC API-EDR source
 * ({@link EdrWeatherSource}) and the OGC API-Coverages source
 * ({@link WcsCoveragesWeatherSource}) read the same wire shape, so orientation,
 * null handling and units are fixed in one place. CoverageJSON parses natively
 * in the browser, so neither source needs a GRIB2, NetCDF or GeoTIFF binary
 * decoder.
 *
 * Output orientation matches the {@link WeatherField} convention: row 0 is north
 * with latitude descending, column 0 is west with longitude ascending, so the
 * packer is a straight resample.
 *
 * Two parts of the bounds and no-data contract are settled on this, the provider,
 * side:
 *
 *   1. The field's `bounds` are derived from `domain.axes.x/y`, the coverage's
 *      own sample coordinates, rather than stamped with the bbox the caller
 *      requested. A server is free to snap a request to its native grid, and
 *      since the packer places a field on its true rectangle, the requested bbox
 *      would be the wrong answer. `options.bounds` remains the fallback for a
 *      coverage whose axes are degenerate or outside the valid lon/lat range.
 *      CoverageJSON axis values are CRS84 degrees for these collections, which
 *      is also the unit both shipped sources put in their `bbox` query.
 *   2. A `null` range value is no-data (`NaN`), not `0`. Zero is an observation
 *      of clear sky, a gap in the coverage is not, and the packer has to tell
 *      them apart.
 *
 * Axis values are sample coordinates, so the parsed field is node-registered;
 * {@link WeatherFieldGrid} defines what that means.
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
  /**
   * Fallback bounds, used only when `domain.axes.x/y` cannot yield a usable
   * rectangle. The field's real bounds come from the axis values.
   */
  bounds: WeatherBounds;
  /** Source id stamped on the field + used for attribution lookup. */
  source?: string;
  attribution?: string;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Degrees -> radians. Written so `+-180` and `+-90` land on exact `+-PI`/`+-PI/2`. */
const toRadians = (deg: number): number => (deg * Math.PI) / 180.0;

const FULL_LONGITUDE_DEGREES = 360.0;
const HALF_LONGITUDE_DEGREES = 180.0;
const LONGITUDE_EPSILON_DEGREES = 1e-6;

interface UnwrappedLongitudeAxis {
  /** Axis coordinates on one continuous longitude branch, in source order. */
  values: number[];
  /** True when at least one adjacent pair crossed the +-180-degree seam. */
  crossedSeam: boolean;
}

/**
 * Put a cyclic CRS84 longitude axis on one continuous branch.
 *
 * CoverageJSON keeps each coordinate in the conventional wrapped domain, so an
 * eastward axis can read `170, 175, 180, -175, -170`. Comparing those raw values
 * says the axis is descending and taking raw min/max says it spans 355 degrees.
 * Both conclusions are wrong. Resolve each seam jump to its adjacent equivalent
 * before either orientation or bounds are derived.
 *
 * Exact full-circle jumps (`-180 -> 180`, `0 -> 360`) are deliberately retained.
 * They are valid global two-node axes, not zero-width regional axes.
 */
function unwrapLongitudeAxis(xs: number[]): UnwrappedLongitudeAxis | null {
  if (xs.length === 0 || !Number.isFinite(xs[0])) {
    return null;
  }

  let rawWest = xs[0];
  let rawEast = xs[0];
  for (let i = 1; i < xs.length; i++) {
    const value = xs[i];
    if (!Number.isFinite(value)) {
      return null;
    }
    rawWest = Math.min(rawWest, value);
    rawEast = Math.max(rawEast, value);
  }
  if (rawEast - rawWest >= FULL_LONGITUDE_DEGREES - LONGITUDE_EPSILON_DEGREES) {
    // The raw coordinates already prove this is a complete (or invalidly wider)
    // longitude domain. Preserve it exactly; taking the shortest adjacent arc
    // could collapse a coarse `0, 270, 360` global axis into a regional wedge.
    return { values: xs.slice(), crossedSeam: false };
  }

  const values = new Array<number>(xs.length);
  values[0] = xs[0];
  let crossedSeam = false;
  for (let i = 1; i < xs.length; i++) {
    const current = xs[i];
    const previous = xs[i - 1];
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      return null;
    }

    let delta = current - previous;
    if (
      delta > HALF_LONGITUDE_DEGREES &&
      delta < FULL_LONGITUDE_DEGREES - LONGITUDE_EPSILON_DEGREES
    ) {
      delta -= FULL_LONGITUDE_DEGREES;
      crossedSeam = true;
    } else if (
      delta < -HALF_LONGITUDE_DEGREES &&
      delta > -FULL_LONGITUDE_DEGREES + LONGITUDE_EPSILON_DEGREES
    ) {
      delta += FULL_LONGITUDE_DEGREES;
      crossedSeam = true;
    }
    values[i] = values[i - 1] + delta;
  }
  return { values, crossedSeam };
}

/** Canonical branch for a regional interval that crossed the longitude seam. */
function canonicalWrappedWest(west: number): number {
  const wrapped =
    ((((west + HALF_LONGITUDE_DEGREES) % FULL_LONGITUDE_DEGREES) +
      FULL_LONGITUDE_DEGREES) %
      FULL_LONGITUDE_DEGREES) -
    HALF_LONGITUDE_DEGREES;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Derives the field's true bounds from the coverage's own axis values.
 *
 * Axis values are node coordinates in CRS84 degrees, so the rectangle is
 * `[min(x), max(x)] x [min(y), max(y)]` — the west, east, south and north
 * samples themselves. Returns null when the axes cannot describe a rectangle,
 * meaning a single sample on either axis, non-finite values, or a latitude range
 * outside +-90, in which case the caller falls back to the requested bbox.
 *
 * A grid that straddles the antimeridian legitimately carries longitudes beyond
 * +-180, such as `170 .. 190`. That is preserved, and `weatherFieldLonSpan`
 * reads it correctly as a 20-degree window.
 */
function boundsFromAxes(
  longitudeAxis: UnwrappedLongitudeAxis,
  ys: number[],
): WeatherBounds | null {
  const xs = longitudeAxis.values;
  if (xs.length < 2 || ys.length < 2) {
    return null;
  }
  let west = Infinity;
  let east = -Infinity;
  for (const x of xs) {
    if (!Number.isFinite(x)) {
      return null;
    }
    west = Math.min(west, x);
    east = Math.max(east, x);
  }
  let south = Infinity;
  let north = -Infinity;
  for (const y of ys) {
    if (!Number.isFinite(y)) {
      return null;
    }
    south = Math.min(south, y);
    north = Math.max(north, y);
  }
  if (east - west <= 0 || north - south <= 0) {
    return null;
  }
  if (east - west > 360 + 1e-6 || south < -90 - 1e-6 || north > 90 + 1e-6) {
    return null;
  }
  // A descending seam-crossing axis unwraps onto the neighbouring negative
  // branch (for example -170 .. -190). Rebase only seam-crossing REGIONAL axes
  // so forward and reverse encodings derive the same 170 .. 190 rectangle.
  // Ordinary and global axes retain their historical numeric bounds exactly.
  if (
    longitudeAxis.crossedSeam &&
    east - west < FULL_LONGITUDE_DEGREES - LONGITUDE_EPSILON_DEGREES
  ) {
    const span = east - west;
    west = canonicalWrappedWest(west);
    east = west + span;
  }
  return {
    west: toRadians(west),
    south: toRadians(south),
    east: toRadians(east),
    north: toRadians(north),
  };
}

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
  const longitudeAxis = unwrapLongitudeAxis(xs);
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
  const xAscending =
    longitudeAxis !== null
      ? longitudeAxis.values[0] <
        longitudeAxis.values[longitudeAxis.values.length - 1]
      : xs[0] < xs[xs.length - 1];
  const norm = opt.units === "fraction" ? 1 : 1 / 100;
  const coverage = new Float32Array(gw * gh);
  for (let oy = 0; oy < gh; oy++) {
    const sy = yDescending ? oy : gh - 1 - oy; // source row for north-first output
    for (let ox = 0; ox < gw; ox++) {
      const sx = xAscending ? ox : gw - 1 - ox;
      const v = values[sy * gw + sx];
      // A null, absent or non-finite range value is no-data, not clear sky.
      coverage[oy * gw + ox] =
        v === null || v === undefined || !Number.isFinite(v)
          ? NaN
          : clamp01(v * norm);
    }
  }
  return {
    gridWidth: gw,
    gridHeight: gh,
    coverage,
    bounds:
      (longitudeAxis !== null ? boundsFromAxes(longitudeAxis, ys) : null) ??
      opt.bounds,
    registration: "node",
    source: opt.source,
    attribution: opt.attribution,
  };
}
