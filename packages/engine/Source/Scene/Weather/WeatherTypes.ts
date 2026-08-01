/**
 * Weather-ingest types (Phase 0 — backend-agnostic Scene layer).
 *
 * A {@link WeatherSource} fetches a normalized {@link WeatherField} (a coarse
 * geographic grid of cloud cover, today; type/base/density later) which the
 * {@link WeatherTexPacker} bakes into the WebGPU cloud renderer's weather-map
 * texture (the C2-16 seam). NOTHING here imports the renderer — the packer just
 * emits the rgba8 byte layout the renderer already uploads.
 *
 * See migration_doc/WEATHER_DATA_INGEST_ROADMAP.md.
 */
import type {
  WeatherGridRegistration,
  WeatherNoDataFill,
} from "./WeatherFieldGrid.js";

/**
 * Geographic bounds in RADIANS.
 *
 * C13-08: these are LOAD-BEARING — the packer places the field on exactly this
 * rectangle of the global weather texture. What the bounds mean relative to the
 * grid samples (node-centred vs cell-centred) and what happens outside them is
 * decided in ONE place: {@link WeatherFieldGrid}. `west > east` is legal and
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
 * A normalized weather grid. MVP carries cloud COVERAGE only (the only channel
 * the cloud shader reads today); `type`/`base`/`densityBias` are optional and
 * fill the G/B/A channels in a later phase.
 *
 * Row 0 is the NORTH edge and column 0 is the WEST edge, matching the weather
 * texture's row0 = north-pole convention, so the packer is a straight resample.
 */
export interface WeatherField {
  gridWidth: number;
  gridHeight: number;
  /** `coverage[y*gridWidth + x]` in [0,1]. */
  coverage: Float32Array;
  /** Optional cloud-type index per cell (CloudType enum), 0..10. */
  type?: Float32Array;
  /** Optional cloud-base height per cell, METRES. */
  baseMeters?: Float32Array;
  /** Optional density bias per cell in [0,1] (0.5 = neutral). */
  densityBias?: Float32Array;
  /**
   * Optional PRESENT-WEATHER code per cell, WMO Table 4677 `ww` (00..99). Drives
   * the data-driven precipitation path (PRECIP-DATA, Batch 444): the cell's `ww`
   * code maps to a {@link PrecipitationType} + intensity. NaN / undefined cell →
   * "no observation" (treated as no precipitation). Optional so the legacy
   * coverage-only field is unchanged when a source doesn't carry it.
   */
  ww?: Float32Array;
  /**
   * Optional aggregate horizontal VISIBILITY of the field, KILOMETRES. Couples to
   * particle density / fog in the data-driven precip path (low visibility → denser
   * particles). A field-level scalar (not per-cell) because the precip override is
   * an aggregate present-weather read; sources without it leave it undefined and
   * the visibility coupling is a no-op (multiplier 1).
   */
  visibilityKm?: number;
  /**
   * Optional aggregate / representative PRESENT-WEATHER code (WMO `ww`, 00..99)
   * for the whole field. The data-driven precip override reads THIS scalar (a
   * single dominant `ww`) rather than re-sampling the per-cell `ww` grid at the
   * camera — the particle system is a single global type/intensity. Sources that
   * fill the per-cell `ww` grid should also set this to the dominant code.
   */
  representativeWw?: number;
  bounds: WeatherBounds;
  /**
   * C13-08 — where this grid's samples sit relative to {@link bounds}. Omitted →
   * `"node"` (gridline-registered), the convention every shipped source uses.
   * See {@link WeatherFieldGrid} for the decision and its rationale.
   */
  registration?: WeatherGridRegistration;
  /**
   * C13-08 — an extra no-data sentinel for wire formats that carry one (e.g.
   * `-9999`). `NaN` is ALWAYS no-data and needs no declaration; prefer emitting
   * `NaN` from a source over declaring a sentinel.
   */
  noDataValue?: number;
  /**
   * C13-08 — what the packer writes into texels this field does not observe
   * (outside {@link bounds}, or no-data inside them). Omitted → the procedural
   * map, i.e. the same bytes the renderer shows with no provider at all. NEVER
   * silently "clear": a gap is not an observation of clear sky.
   */
  noDataFill?: WeatherNoDataFill;
  /**
   * C13-08 — relative precedence when several sources cover the same texel
   * (higher wins). DECLARED here so the packer/provider contract carries it;
   * the composition that CONSUMES it is `C13-20` and is not built yet, so a
   * single field's priority currently has no effect.
   */
  priority?: number;
  /**
   * ISO-8601 valid time of the data (for caching / display). This doubles as the
   * field's REVISION in the C13-08 contract: two packs of the same source with
   * the same `validTime` describe the same observation.
   */
  validTime?: string;
  /** Source id (e.g. "edr:noaa-gfs"). */
  source?: string;
  /** Mandatory attribution string for licensed feeds (e.g. ECMWF CC-BY). */
  attribution?: string;
}

/**
 * The temporal stance the {@link WeatherProvider} takes when resolving a slice
 * (Phase 2). `null` (the provider default) = the legacy single-request behavior
 * (whatever `WeatherFieldRequest.time` holds, usually `"latest"`).
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
 * data-driven precipitation path (PRECIP-DATA, Batch 444). A single dominant
 * `ww` code + an aggregate visibility describe the field's precipitation as one
 * global type/intensity (the particle system isn't per-cell). `ww` undefined →
 * the active field carries no present-weather → the data-driven override is a
 * no-op and the manual/auto precip selection stands.
 */
export interface WeatherPresentWeather {
  /** Dominant WMO Table 4677 `ww` code (00..99), or undefined if not carried. */
  ww?: number;
  /** Aggregate horizontal visibility, KILOMETRES, or undefined if not carried. */
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
