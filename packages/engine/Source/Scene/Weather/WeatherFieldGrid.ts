/**
 * The one place that decides how a {@link WeatherField} is placed onto the
 * global equirectangular weather texture, and what a texel holds where the
 * field has no observation. {@link WeatherMapSeam} owns the matching contract
 * on the texture side.
 *
 * Registration — a source grid is node-centred by default.
 *
 * A {@link WeatherField} grid is node-centred, also called
 * gridline-registered: `bounds.west` and `bounds.north` are the coordinates of
 * column 0 and row 0, and `bounds.east` and `bounds.south` are the coordinates
 * of column `gridWidth-1` and row `gridHeight-1`. The samples sit on the
 * boundary, not inside it.
 *
 * A `"cell"` (pixel-registered) alternative is supported and must be declared
 * per field through `WeatherField.registration`: sample `k` sits at
 * `west + (k + 0.5) * cellSize`, and the bounds are the outer edges of the
 * raster.
 *
 * Node-centred is the default because:
 *
 *   1. It is what the packer does — it resamples the texel centre over the
 *      closed index range `[0, gridWidth-1]` — so defaulting to it leaves every
 *      existing global field byte-identical.
 *   2. It matches the wire formats the shipped sources read. CoverageJSON
 *      `domain.axes.x/y` carry the sample coordinates, which are nodes, and the
 *      model output behind them is gridline-registered: GFS at 0.25 deg runs
 *      lon `0.00 .. 359.75` and lat `+90 .. -90`, inclusive of both poles.
 *   3. Only a node-centred global grid actually samples the poles. The polar
 *      low-pass collapses the two cap rows on the assumption that a value
 *      exists at the pole, and a cell-centred global grid has none.
 *   4. `"cell"` still has to exist, because pixel-registered rasters — GeoTIFF
 *      and OGC-Coverages tiles, radar mosaics — genuinely are half a cell
 *      offset, and treating one as node-centred smears the whole regional field
 *      by half a cell.
 *
 * The texture is cell-centred, because a `linear` sampler reconstructs the
 * stored value at the texel centre, while the field is node-centred by default.
 * They are different objects with different registrations, and the packer
 * converts between them explicitly:
 *
 *   texel index -> texel-centre UV -> lon/lat -> normalized position inside the
 *   field's bounds -> fractional source-grid index under the field's registration
 *
 * No-data — an absence of data is not an observation of clear sky.
 *
 * A texel is no-data when either
 *
 *   - its lon/lat falls outside the field's `bounds`, since a regional field
 *     covers a rectangle of the planet rather than the planet, or
 *   - every source cell that would contribute to it is a declared no-data
 *     value.
 *
 * A coverage sample is an observation when it is finite and, where the field
 * declares `noDataValue`, is not that sentinel. `NaN` is always no-data and
 * needs no declaration; it is the normalized sentinel every source should emit.
 *
 * Coverage (R) carries the validity for the whole cell: genus, base and density
 * at a no-data cell are undefined and are never read, because all three are
 * derived from the same observation that produced coverage.
 *
 * No-data texels are written from a declared {@link WeatherNoDataFill}:
 *
 *   - `"procedural"`, the default — the same {@link buildProceduralWeatherMap}
 *     bytes the renderer shows when there is no provider at all. It is the only
 *     fill continuous with the no-provider case, and the only one that cannot
 *     be mistaken for an observation: a constant-clear fill would assert an
 *     observed clear sky over the 99% of the planet a regional feed never saw,
 *     and a constant-overcast fill would assert the opposite.
 *   - `"constant"` — an explicitly declared coverage, genus, base and density
 *     quad, for callers that want a flat and obviously synthetic backdrop
 *     instead.
 *
 * Precedence: the packer's explicit option beats `WeatherField.noDataFill`,
 * which beats the procedural default.
 *
 * This module places one field. Composing several overlapping regional sources
 * by priority, feathering the boundary between an observed region and its fill,
 * and per-tile bounds and no-data with gutters and LOD all sit outside it, and
 * it must not be presented as a substitute for any of them.
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
 *   - `"node"` — samples on the bounds (gridline-registered); the default.
 *   - `"cell"` — samples at cell centres, with the bounds as outer edges.
 */
export type WeatherGridRegistration = "node" | "cell";

/** The registration assumed when a field does not declare one. */
export const DEFAULT_WEATHER_GRID_REGISTRATION: WeatherGridRegistration =
  "node";

/**
 * What the packer writes into a texel the field does not observe. This module's
 * header carries the reason `"procedural"` is the default.
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
      /** Optional cloud base in metres (B); omitted → 0. */
      readonly baseMeters?: number;
      /** Optional density bias 0..1 (A); omitted → the neutral 128. */
      readonly densityBias?: number;
    };

/** The default fill: the procedural map the renderer shows with no provider. */
export const PROCEDURAL_NO_DATA_FILL: WeatherNoDataFill = Object.freeze({
  kind: "procedural",
});

/**
 * Antimeridian-aware longitude span of a bounds rectangle, in radians.
 *
 * `east - west` is taken modulo 2*PI so a rectangle that straddles +-180 deg
 * (`west = 170 deg`, `east = -170 deg`) reports its true 20 deg width instead of
 * a negative one. A difference of 2*PI or more, a difference of zero, or a
 * non-finite bound all mean all longitudes: the rectangle closes around the
 * planet, which is the global case.
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
 * Latitude span in radians. Latitude does not wrap, so a degenerate span —
 * zero or inverted — means all latitudes rather than an empty rectangle.
 */
export function weatherFieldLatSpan(bounds: WeatherBounds): number {
  const span = bounds.north - bounds.south;
  return span > 0 ? span : WEATHER_MAP_LAT_RANGE;
}

/** True when the field's longitude window is the texture's longitude window. */
export function isGlobalLonWindow(bounds: WeatherBounds): boolean {
  return (
    bounds.west === WEATHER_MAP_MIN_LON &&
    weatherFieldLonSpan(bounds) === WEATHER_MAP_LON_RANGE
  );
}

/** True when the field's latitude window is the texture's latitude window. */
export function isGlobalLatWindow(bounds: WeatherBounds): boolean {
  return (
    bounds.north === WEATHER_MAP_MAX_LAT &&
    weatherFieldLatSpan(bounds) === WEATHER_MAP_LAT_RANGE
  );
}

/** True when the field covers the whole texture — the global case. */
export function isGlobalWeatherWindow(bounds: WeatherBounds): boolean {
  return isGlobalLonWindow(bounds) && isGlobalLatWindow(bounds);
}

/**
 * Normalized west-to-east position, inside the field's longitude window, of the
 * texel whose centre is at texture coordinate `texelU`.
 *
 * `0` is `bounds.west` and `1` is `bounds.east`; anything outside `[0, 1]` is
 * outside the field. The result is wrap-aware, so an antimeridian-straddling
 * window is a single contiguous `[0, 1]` interval rather than two pieces.
 *
 * When the window is the texture's own window, `texelU` is returned unchanged.
 * That is not merely a speed-up: routing the global case through
 * `lon = MIN_LON + u * LON_RANGE` and back would perturb the last bit and could
 * flip a rounded byte, and the global path has to stay byte-identical.
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
 * Normalized north-to-south position, inside the field's latitude window, of the
 * texel whose centre is at texture coordinate `texelV`. `0` is `bounds.north`
 * and `1` is `bounds.south`; outside `[0, 1]` is outside the field. Latitude
 * never wraps. The global window returns `texelV` unchanged, for the same
 * bit-exactness reason as {@link weatherFieldU}.
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
 * of `count` samples. This is the single expression that encodes the
 * registration convention.
 *
 *   - `"node"`: `s * (count - 1)`, so `s = 0` lands exactly on sample 0 and
 *     `s = 1` exactly on sample `count - 1`.
 *   - `"cell"`: `s * count - 0.5`, so `s = 0` lands half a cell outside sample 0,
 *     at the outer edge; the caller clamps or wraps that half-cell.
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
 * True when a bilinear fetch on this field can actually reach a longitude index
 * outside `[0, count-1]`, meaning wrapping is reachable rather than theoretical.
 *
 * Only a cell-registered full-circle window qualifies: its coordinate range is
 * `[-0.5, count-0.5]`, so the outer half-cells straddle the antimeridian. A
 * node-registered full-circle window has its first and last column on one
 * meridian and a coordinate range of exactly `[0, count-1]`, so the extra tap is
 * only ever reached with weight zero and a wrap-aware fetch would change
 * nothing. A regional window in either registration is clamped, because there is
 * no data beyond its edge to wrap to.
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
 * Whether this coverage sample is an observation. A non-finite value (`NaN` or
 * `Infinity`) is always no-data; a field may declare one extra sentinel, such as
 * `-9999`, for wire formats that carry one instead of nulls.
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
