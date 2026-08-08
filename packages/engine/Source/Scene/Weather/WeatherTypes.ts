/**
 * Weather-ingest types, in the backend-agnostic Scene layer.
 *
 * A {@link WeatherSource} fetches a normalized {@link WeatherField} — a coarse
 * geographic grid carrying cloud cover today, with type, base height and
 * density reserved for later — which the {@link WeatherTexPacker} bakes into
 * the WebGPU cloud renderer's weather-map texture. Nothing here imports the
 * renderer; the packer emits the rgba8 byte layout the renderer already
 * uploads.
 */
import type {
  WeatherGridRegistration,
  WeatherNoDataFill,
} from "./WeatherFieldGrid.js";

/**
 * Geographic bounds in radians.
 *
 * These are load-bearing: the packer places the field on exactly this rectangle
 * of the global weather texture. What the bounds mean relative to the grid
 * samples — node-centred against cell-centred — and what happens outside them
 * is decided in one place, {@link WeatherFieldGrid}. `west > east` is legal and
 * means the rectangle straddles the antimeridian.
 */
export interface WeatherBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Whole-globe bounds (the weather-map default; weatherTexBounds = -PI..PI / -PI/2..PI/2). */
export const GLOBAL_WEATHER_BOUNDS: WeatherBounds = {
  west: -Math.PI,
  south: -Math.PI / 2,
  east: Math.PI,
  north: Math.PI / 2,
};

/**
 * A normalized weather grid. Only cloud coverage is carried, because it is the
 * only channel the cloud shader reads; `type`, `base` and `densityBias` are
 * optional and fill the G, B and A channels once consumers for them exist.
 *
 * Row 0 is the north edge and column 0 is the west edge, matching the weather
 * texture's row-0-is-north-pole convention, so the packer is a straight
 * resample.
 */
export interface WeatherField {
  gridWidth: number;
  gridHeight: number;
  /** `coverage[y*gridWidth + x]` in [0,1]. */
  coverage: Float32Array;
  /** Optional cloud-type index per cell (CloudType enum), 0..10. */
  type?: Float32Array;
  /** Optional cloud-base height per cell, in metres. */
  baseMeters?: Float32Array;
  /** Optional density bias per cell in [0,1] (0.5 = neutral). */
  densityBias?: Float32Array;
  /**
   * Optional present-weather code per cell, WMO Table 4677 `ww` (00..99). Drives
   * the data-driven precipitation path: the cell's `ww` code maps to a
   * {@link PrecipitationType} and an intensity. A NaN or undefined cell means no
   * observation, which is treated as no precipitation. Optional, so a
   * coverage-only field is unaffected when a source does not carry it.
   */
  ww?: Float32Array;
  /**
   * Optional aggregate horizontal visibility of the field, in kilometres.
   * Couples to particle density and fog in the data-driven precipitation path,
   * where lower visibility means denser particles. It is a field-level scalar
   * rather than per-cell because the precipitation override is an aggregate
   * present-weather read; sources without it leave it undefined and the
   * visibility coupling becomes a multiplier of 1.
   */
  visibilityKm?: number;
  /**
   * Optional aggregate present-weather code (WMO `ww`, 00..99) for the whole
   * field. The data-driven precipitation override reads this single dominant
   * scalar rather than re-sampling the per-cell `ww` grid at the camera, because
   * the particle system carries one global type and intensity. A source that
   * fills the per-cell `ww` grid should also set this to the dominant code.
   */
  representativeWw?: number;
  bounds: WeatherBounds;
  /**
   * Where this grid's samples sit relative to {@link bounds}. Omitting it means
   * `"node"` (gridline-registered), the convention every shipped source uses.
   * {@link WeatherFieldGrid} owns that decision and its rationale.
   */
  registration?: WeatherGridRegistration;
  /**
   * An extra no-data sentinel for wire formats that carry one, such as `-9999`.
   * `NaN` is always no-data and needs no declaration, so a source should prefer
   * emitting `NaN` over declaring a sentinel.
   */
  noDataValue?: number;
  /**
   * What the packer writes into texels this field does not observe — outside
   * {@link bounds}, or no-data inside them. Omitting it selects the procedural
   * map, which is the same bytes the renderer shows with no provider attached at
   * all. A gap is never filled with clear sky, because an absence of data is not
   * an observation of a clear sky.
   */
  noDataFill?: WeatherNoDataFill;
  /**
   * Relative precedence when several sources cover the same texel; higher wins.
   * It is declared here so the packer and provider contract carries it, but
   * nothing composes multiple sources yet, so a single field's priority has no
   * effect.
   */
  priority?: number;
  /**
   * ISO-8601 valid time of the data, for caching and display. It doubles as the
   * field's revision: two packs of the same source with the same `validTime`
   * describe the same observation.
   */
  validTime?: string;
  /** Source id (e.g. "edr:noaa-gfs"). */
  source?: string;
  /** Mandatory attribution string for licensed feeds (e.g. ECMWF CC-BY). */
  attribution?: string;
}

/**
 * The temporal stance the {@link WeatherProvider} takes when resolving a slice.
 * `null`, the provider default, issues one request for whatever
 * `WeatherFieldRequest.time` holds, usually `"latest"`.
 *   - `"live"`       : the latest analysis, advanced by `tick(now)`.
 *   - `"historical"` : a fixed past instant set via `setTime(date)`.
 *   - `"projected"`  : `now + forecastOffset`, advanced by `tick(now)`.
 */
export type WeatherTimeMode = "live" | "historical" | "projected";

/** What a {@link WeatherSource} is asked to return. */
export interface WeatherFieldRequest {
  /** `"latest"` analysis, or a specific instant (historical / projected). */
  time?: Date | "latest";
  /** Optional sub-region; omitted → the source's natural/global extent. */
  bounds?: WeatherBounds;
  /** Abort an in-flight fetch (page nav, source swap). */
  signal?: AbortSignal;
}

/**
 * Aggregate present-weather read the {@link WeatherProvider} exposes for the
 * data-driven precipitation path. A single dominant `ww` code and an aggregate
 * visibility describe the field's precipitation as one global type and
 * intensity, because the particle system is not per-cell. An undefined `ww`
 * means the active field carries no present weather, so the data-driven
 * override does nothing and the manual or automatic precipitation selection
 * stands.
 */
export interface WeatherPresentWeather {
  /** Dominant WMO Table 4677 `ww` code (00..99), or undefined if not carried. */
  ww?: number;
  /** Aggregate horizontal visibility in kilometres, or undefined if not carried. */
  visibilityKm?: number;
}

/** Capability advertisement so the provider can gate time/region requests. */
export interface WeatherCapabilities {
  id: string;
  /** Human label for UI. */
  label: string;
  /** Supports a specific historical/projected instant (vs latest-only). */
  supportsTime: boolean;
  /** Earliest/latest valid times available, if known. */
  validRange?: { start: string; end: string };
  attribution?: string;
}
