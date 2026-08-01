/**
 * C13-08 — the ONE place that decides how a {@link WeatherField} is placed onto
 * the global equirectangular weather texture, and what a texel holds where the
 * field has no observation.
 *
 * C13-07 fixed the TEXTURE side of the seam contract ({@link WeatherMapSeam}) and
 * deliberately left the SOURCE-GRID side open. This module closes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISION 1 — the source-grid coordinate reference is NODE-CENTRED by default
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A {@link WeatherField} grid is **node-centred** (a.k.a. gridline-registered):
 * `bounds.west` / `bounds.north` are the coordinates OF column 0 / row 0, and
 * `bounds.east` / `bounds.south` are the coordinates OF column `gridWidth-1` /
 * row `gridHeight-1`. The samples sit ON the boundary, not inside it.
 *
 * A `"cell"` (pixel-registered) alternative is supported and must be DECLARED per
 * field (`WeatherField.registration`): sample `k` sits at
 * `west + (k + 0.5) * cellSize` and the bounds are the OUTER edges of the raster.
 *
 * Why node-centred is the default:
 *
 *   1. It is what the shipped packer already did — C13-07 resamples the texel
 *      centre over the closed index range `[0, gridWidth-1]`. Defaulting to it
 *      keeps every existing global field byte-identical.
 *   2. It matches the wire formats the shipped sources actually read.
 *      CoverageJSON `domain.axes.x/y` carry the sample COORDINATES (nodes), and
 *      the model output behind them is gridline-registered (GFS 0.25 deg is
 *      lon `0.00 .. 359.75`, lat `+90 .. -90` INCLUSIVE of both poles).
 *   3. Only a node-centred global grid actually samples the poles. C13-07's
 *      polar low-pass collapses the two cap rows on the assumption that a value
 *      exists AT the pole; a cell-centred global grid has none.
 *   4. `"cell"` still has to exist because pixel-registered rasters (GeoTIFF /
 *      OGC-Coverages tiles, radar mosaics) genuinely are half a cell offset, and
 *      silently treating them as node-centred smears every regional field by
 *      half a cell — the same class of error C13-07 fixed on the texture side.
 *
 * Note that the TEXTURE is cell-centred (a `linear` sampler reconstructs the
 * stored value at the texel CENTRE — that is C13-07's contract) while the FIELD
 * is node-centred by default. They are different objects with different
 * registrations, and the packer converts explicitly:
 *
 *   texel index -> texel-centre UV -> lon/lat -> normalized position inside the
 *   field's bounds -> fractional source-grid index under the field's registration
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISION 2 — no-data is NOT an observation of clear sky
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A texel is NO-DATA when either
 *
 *   - its lon/lat falls OUTSIDE the field's `bounds` (a regional field covers a
 *     rectangle of the planet, not the planet), or
 *   - every source cell that would contribute to it is a declared no-data value.
 *
 * A coverage sample is an OBSERVATION iff it is finite AND (when the field
 * declares `noDataValue`) is not that sentinel. `NaN` is ALWAYS no-data and needs
 * no declaration — it is the normalized sentinel every source should emit.
 *
 * Coverage (R) carries the validity for the whole cell: genus / base / density at
 * a no-data cell are undefined and are never read. That is deliberate — those
 * three channels are derived from the same observation that produced coverage.
 *
 * No-data texels are written from a declared {@link WeatherNoDataFill}:
 *
 *   - `"procedural"` (THE DEFAULT) — the same {@link buildProceduralWeatherMap}
 *     bytes the renderer already shows when there is no provider at all. This is
 *     the only fill that is continuous with the no-provider case and that cannot
 *     be mistaken for an observation: a constant-clear fill would assert "clear
 *     sky observed" over the 99% of the planet a regional feed never saw, and a
 *     constant-overcast fill would assert the opposite.
 *   - `"constant"` — an explicitly declared coverage/genus/base/density quad, for
 *     callers that want a flat, obviously-synthetic backdrop instead.
 *
 * Precedence: the packer's explicit option beats `WeatherField.noDataFill`, which
 * beats the procedural default.
 *
 * SCOPE (deliberate): this is the bounded W1 correction the Campaign 13 queue
 * scopes. Composing SEVERAL overlapping regional sources with priority, and
 * feathering the boundary between an observed region and its fill, are `C13-20`;
 * per-tile bounds/no-data with gutters and LOD are `C13-14`. This module must not
 * be presented as a substitute for either.
 *
 * @module Scene/Weather/WeatherFieldGrid
 */
import {
  WEATHER_MAP_LAT_RANGE,
  WEATHER_MAP_LON_RANGE,
  WEATHER_MAP_MIN_LAT,
  WEATHER_MAP_MIN_LON,
} from "./WeatherMapSeam.js";
import type { WeatherBounds } from "./WeatherTypes.js";

const TWO_PI = 2.0 * Math.PI;
/** Latitude of texture row 0's outer edge — the north pole. */
const WEATHER_MAP_MAX_LAT = WEATHER_MAP_MIN_LAT + WEATHER_MAP_LAT_RANGE;
/**
 * A longitude window within this of 0 or 2*PI is "all longitudes". Bounds arrive
 * from wire formats in degrees, so the radian round-trip is never bit-exact.
 */
const LON_SPAN_EPSILON = 1e-9;

/**
 * Where a source grid's samples sit relative to its `bounds`.
 *   - `"node"` — samples ON the bounds (gridline-registered). THE DEFAULT.
 *   - `"cell"` — samples at cell CENTRES, bounds are the outer edges.
 */
export type WeatherGridRegistration = "node" | "cell";

/** The registration assumed when a field does not declare one. */
export const DEFAULT_WEATHER_GRID_REGISTRATION: WeatherGridRegistration =
  "node";

/**
 * What the packer writes into a texel the field does not observe. See DECISION 2
 * in this module's header for why `"procedural"` is the default.
 */
export type WeatherNoDataFill =
  | { readonly kind: "procedural" }
  | {
      /** A flat, explicitly-synthetic backdrop. */
      readonly kind: "constant";
      /** Cloud coverage 0..1 (R). */
      readonly coverage: number;
      /** Optional genus index 0..10 (G); omitted → the neutral 128. */
      readonly type?: number;
      /** Optional cloud base in METRES (B); omitted → 0. */
      readonly baseMeters?: number;
      /** Optional density bias 0..1 (A); omitted → the neutral 128. */
      readonly densityBias?: number;
    };

/** The default fill: the procedural map the renderer shows with no provider. */
export const PROCEDURAL_NO_DATA_FILL: WeatherNoDataFill = Object.freeze({
  kind: "procedural",
});

/**
 * Longitude span of a bounds rectangle in RADIANS, ANTIMERIDIAN-AWARE.
 *
 * `east - west` is taken modulo 2*PI so a rectangle that straddles +-180 deg
 * (`west = 170 deg`, `east = -170 deg`) reports its true 20 deg width instead of
 * a negative one. A difference of 2*PI or more, a difference of zero, or a
 * non-finite bound all mean "all longitudes" — the rectangle closes around the
 * planet, which is the legacy global case.
 */
export function weatherFieldLonSpan(bounds: WeatherBounds): number {
  const raw = bounds.east - bounds.west;
  if (!(raw < TWO_PI - LON_SPAN_EPSILON)) {
    return TWO_PI;
  }
  const wrapped = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
  return wrapped <= LON_SPAN_EPSILON ? TWO_PI : wrapped;
}

/**
 * Latitude span in RADIANS. Latitude does not wrap, so a degenerate (zero or
 * inverted) span means "all latitudes" rather than an empty rectangle.
 */
export function weatherFieldLatSpan(bounds: WeatherBounds): number {
  const span = bounds.north - bounds.south;
  return span > 0 ? span : WEATHER_MAP_LAT_RANGE;
}

/** True when the field's longitude window IS the texture's longitude window. */
export function isGlobalLonWindow(bounds: WeatherBounds): boolean {
  return (
    bounds.west === WEATHER_MAP_MIN_LON &&
    weatherFieldLonSpan(bounds) === WEATHER_MAP_LON_RANGE
  );
}

/** True when the field's latitude window IS the texture's latitude window. */
export function isGlobalLatWindow(bounds: WeatherBounds): boolean {
  return (
    bounds.north === WEATHER_MAP_MAX_LAT &&
    weatherFieldLatSpan(bounds) === WEATHER_MAP_LAT_RANGE
  );
}

/** True when the field covers the whole texture — the legacy global case. */
export function isGlobalWeatherWindow(bounds: WeatherBounds): boolean {
  return isGlobalLonWindow(bounds) && isGlobalLatWindow(bounds);
}

/**
 * Normalized WEST->EAST position, inside the field's longitude window, of the
 * texel whose centre is at texture coordinate `texelU`.
 *
 * `0` is `bounds.west`, `1` is `bounds.east`; anything outside `[0, 1]` is
 * outside the field. The result is wrap-aware, so an antimeridian-straddling
 * window is a single contiguous `[0, 1]` interval rather than two pieces.
 *
 * When the window IS the texture's window the texel's own `texelU` is returned
 * unchanged. That is not just a speed-up: routing the global case through
 * `lon = MIN_LON + u * LON_RANGE` and back would perturb the last bit and could
 * flip a rounded byte, and the global path must stay byte-identical.
 */
export function weatherFieldU(texelU: number, bounds: WeatherBounds): number {
  if (isGlobalLonWindow(bounds)) {
    return texelU;
  }
  const lon = WEATHER_MAP_MIN_LON + texelU * WEATHER_MAP_LON_RANGE;
  const offset = (((lon - bounds.west) % TWO_PI) + TWO_PI) % TWO_PI;
  return offset / weatherFieldLonSpan(bounds);
}

/**
 * Normalized NORTH->SOUTH position, inside the field's latitude window, of the
 * texel whose centre is at texture coordinate `texelV`. `0` is `bounds.north`,
 * `1` is `bounds.south`; outside `[0, 1]` is outside the field. Latitude never
 * wraps. The global window returns `texelV` unchanged, for the same bit-exactness
 * reason as {@link weatherFieldU}.
 */
export function weatherFieldV(texelV: number, bounds: WeatherBounds): number {
  if (isGlobalLatWindow(bounds)) {
    return texelV;
  }
  const lat = WEATHER_MAP_MIN_LAT + (1.0 - texelV) * WEATHER_MAP_LAT_RANGE;
  return (bounds.north - lat) / weatherFieldLatSpan(bounds);
}

/**
 * Fractional source-grid index for a normalized `[0, 1]` position along an axis
 * of `count` samples — the ONE expression that encodes DECISION 1.
 *
 *   - `"node"`: `s * (count - 1)`, so `s = 0` lands exactly on sample 0 and
 *     `s = 1` exactly on sample `count - 1`.
 *   - `"cell"`: `s * count - 0.5`, so `s = 0` lands half a cell OUTSIDE sample 0
 *     (the outer edge) — the caller clamps or wraps that half-cell.
 */
export function weatherFieldGridCoordinate(
  s: number,
  count: number,
  registration: WeatherGridRegistration,
): number {
  if (count <= 1) {
    return 0;
  }
  return registration === "cell" ? s * count - 0.5 : s * (count - 1);
}

/**
 * True when a bilinear fetch on this field can actually reach an index outside
 * `[0, count-1]` in LONGITUDE, i.e. when wrapping is reachable rather than
 * theoretical.
 *
 * Only a CELL-registered full-circle window qualifies: its coordinate range is
 * `[-0.5, count-0.5]`, so the outer half-cells straddle the antimeridian. A
 * NODE-registered full-circle window has its first and last column on the SAME
 * meridian and a coordinate range of exactly `[0, count-1]`, so the extra tap is
 * only ever reached with weight zero — which is why C13-07 correctly declined to
 * add a wrap-aware fetch. A regional window in either registration is clamped:
 * there is no data beyond its edge to wrap TO.
 */
export function weatherFieldWrapsLongitude(
  bounds: WeatherBounds,
  registration: WeatherGridRegistration,
): boolean {
  return (
    registration === "cell" &&
    weatherFieldLonSpan(bounds) === WEATHER_MAP_LON_RANGE
  );
}

/**
 * Is this coverage sample an OBSERVATION? Non-finite (`NaN`/`Infinity`) is always
 * no-data; a field may declare one extra sentinel (e.g. `-9999`) for wire formats
 * that carry one instead of nulls.
 */
export function isWeatherSampleObserved(
  value: number,
  sentinel: number | undefined,
): boolean {
  return (
    Number.isFinite(value) && (sentinel === undefined || value !== sentinel)
  );
}

/** Positive integer modulo (JS `%` keeps the sign of the dividend). */
export function wrapGridIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}
