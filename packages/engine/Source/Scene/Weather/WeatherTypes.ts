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

/** Geographic bounds in RADIANS. */
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
  bounds: WeatherBounds;
  /** ISO-8601 valid time of the data (for caching / display). */
  validTime?: string;
  /** Source id (e.g. "edr:noaa-gfs"). */
  source?: string;
  /** Mandatory attribution string for licensed feeds (e.g. ECMWF CC-BY). */
  attribution?: string;
}

/** What a {@link WeatherSource} is asked to return. */
export interface WeatherFieldRequest {
  /** `"latest"` analysis, or a specific instant (historical / projected). */
  time?: Date | "latest";
  /** Optional sub-region; omitted → the source's natural/global extent. */
  bounds?: WeatherBounds;
  /** Abort an in-flight fetch (page nav, source swap). */
  signal?: AbortSignal;
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
