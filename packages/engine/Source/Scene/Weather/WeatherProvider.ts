/**
 * Orchestrates weather ingest: holds the active {@link WeatherSource}, fetches a
 * {@link WeatherField} asynchronously, bakes it into the weather-map bytes via
 * {@link packWeatherField}, and exposes a SYNCHRONOUS accessor the WebGPU cloud
 * renderer calls each frame. A cache miss kicks a background fetch and returns
 * null (the renderer keeps its procedural map until data arrives, so there's no
 * overcast-everywhere flash). Swapping the source is how the user switches
 * between open data sources at runtime.
 *
 * Phase 2 — TIME MODEL. By default the provider serves a single request
 * (`time: "latest"`, the legacy behavior). Engaging a {@link WeatherTimeMode}
 * (`setTimeMode` / `setTime` / `setForecastOffsetHours`) makes it resolve a
 * quantized time SLICE each frame: `live` = the latest analysis advanced by
 * `tick(now)`, `historical` = a fixed past instant, `projected` = `now + offset`.
 * Slices are quantized (default 1 h) + held in a small LRU cache so scrubbing
 * reuses already-fetched data, and `version` bumps ONLY when the active slice's
 * bytes change (not every tick) so the renderer re-uploads only when needed.
 *
 * Set it on `globe.weatherProvider`; the renderer auto-enables the weather map
 * once real bytes are ready.
 *
 * @module Scene/Weather/WeatherProvider
 */
import { packWeatherField } from "./WeatherTexPacker.js";
import type { WeatherSource } from "./WeatherSource.js";
import type {
  WeatherField,
  WeatherFieldRequest,
  WeatherPresentWeather,
  WeatherTimeMode,
} from "./WeatherTypes.js";

const HOUR_MS = 3600000;

export class WeatherProvider {
  private _source: WeatherSource | null;
  private _request: WeatherFieldRequest;
  private _packed: Uint8Array | null = null;
  private _version = 0;
  private _fetching = false;
  private _lastError: string | null = null;
  private _validTime: string | undefined = undefined;
  // PRECIP-DATA (Batch 444) — the aggregate present-weather read of the LAST
  // successfully-applied field. `applyAtmosphericConditions` reads this (when the
  // data-driven precip flag is set) to override the precip type/intensity. Null
  // until the first field carrying `representativeWw` lands; stays null for
  // coverage-only sources so the data-driven override is a no-op for them.
  private _presentWeather: WeatherPresentWeather | null = null;
  // Bumped ONLY by setSource/setRequest/refresh (NOT by a successful fetch). An
  // in-flight fetch captures it and discards its result if it changed mid-flight,
  // so swapping the source during a slow (network) fetch can't apply stale data.
  private _invalidation = 0;

  // --- Phase 2 time model (entirely inactive while _timeMode === null) ---
  private _timeMode: WeatherTimeMode | null = null;
  private _explicitTime: Date | null = null;
  private _forecastOffsetMs = 0;
  private _quantizeMs = HOUR_MS;
  private _nowMs: number;
  private _effectiveKey: string | null = null;
  private _effectiveTime: Date | "latest" = "latest";
  // LRU cache of packed slices keyed by quantized-time. Scrubbing historical /
  // projected times reuses already-fetched+packed slices instead of re-fetching.
  private readonly _cache = new Map<string, Uint8Array>();
  private _cacheLimit = 8;
  private _cacheW = 0;
  private _cacheH = 0;

  constructor(
    source: WeatherSource | null = null,
    request: WeatherFieldRequest = { time: "latest" },
  ) {
    this._source = source;
    this._request = request;
    this._nowMs = Date.now();
  }

  /** Bumps whenever the packed bytes change — the renderer re-uploads on change. */
  get version(): number {
    return this._version;
  }
  get hasData(): boolean {
    return this._packed !== null;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  get validTime(): string | undefined {
    return this._validTime;
  }
  getSource(): WeatherSource | null {
    return this._source;
  }
  /**
   * PRECIP-DATA (Batch 444) — the aggregate present-weather (dominant WMO `ww` +
   * visibility) of the active field, or null if the active source carries none.
   * The data-driven precipitation path reads this to override precip
   * type/intensity. Returns null in legacy / coverage-only setups, so the
   * override is a no-op and the manual/auto precip selection stands.
   */
  getPresentWeather(): WeatherPresentWeather | null {
    return this._presentWeather;
  }
  /** The active time stance, or null in the legacy single-request mode. */
  getTimeMode(): WeatherTimeMode | null {
    return this._timeMode;
  }
  /** The resolved instant of the active slice (a Date), or `"latest"` in legacy mode. */
  getEffectiveTime(): Date | "latest" {
    return this._effectiveTime;
  }

  /** Swap the active source (runtime source-switch). Drops the cache. */
  setSource(source: WeatherSource | null): void {
    this._source = source;
    this._packed = null;
    this._presentWeather = null;
    this._lastError = null;
    this._cache.clear();
    this._effectiveKey = null;
    this._invalidation++;
    this._version++;
  }

  /** Change the request (time / region). Drops the cache. */
  setRequest(request: WeatherFieldRequest): void {
    this._request = request;
    this._packed = null;
    this._cache.clear();
    this._effectiveKey = null;
    this._invalidation++;
    this._version++;
  }

  /** Force a re-fetch (e.g. a live-refresh tick). Drops the cache. */
  refresh(): void {
    this._packed = null;
    this._cache.clear();
    this._effectiveKey = null;
    this._invalidation++;
    this._version++;
  }

  // ── Phase 2 time-model controls ──────────────────────────────────────────

  /** Engage live / historical / projected time resolution. */
  setTimeMode(mode: WeatherTimeMode): void {
    if (mode === this._timeMode) {
      return;
    }
    this._timeMode = mode;
    this._effectiveKey = null;
    this._refreshSlice();
  }

  /** Set the historical instant (also switches to `historical` if in legacy mode). */
  setTime(date: Date): void {
    this._explicitTime = date;
    if (this._timeMode === null) {
      this._timeMode = "historical";
    }
    this._effectiveKey = null;
    this._refreshSlice();
  }

  /** Set the projected forecast offset in hours (switches to `projected` if legacy). */
  setForecastOffsetHours(hours: number): void {
    this._forecastOffsetMs = hours * HOUR_MS;
    if (this._timeMode === null) {
      this._timeMode = "projected";
    }
    this._effectiveKey = null;
    this._refreshSlice();
  }

  /** Slice quantization in hours (default 1). Smaller = finer scrubbing, more fetches. */
  setQuantizeHours(hours: number): void {
    this._quantizeMs = hours > 0 ? hours * HOUR_MS : 0;
    this._effectiveKey = null;
    this._refreshSlice();
  }

  /**
   * Advance "now" for `live` + `projected` modes (the app calls this on a timer;
   * a test passes a controlled value). No-op in `historical` / legacy mode.
   */
  tick(nowMs: number = Date.now()): void {
    this._nowMs = nowMs;
    if (this._timeMode === "live" || this._timeMode === "projected") {
      this._refreshSlice();
    }
  }

  /**
   * The renderer's per-frame accessor. Returns cached packed bytes, or null on a
   * miss (which starts a background fetch). Never throws; a failed fetch leaves
   * this null and records {@link lastError}.
   */
  getPackedTexture(texW: number, texH: number): Uint8Array | null {
    // In time-model mode a texture-size change invalidates the cached slices.
    if (
      this._timeMode !== null &&
      (this._cacheW !== texW || this._cacheH !== texH) &&
      (this._cacheW !== 0 || this._cacheH !== 0)
    ) {
      this._cache.clear();
      this._packed = null;
      this._effectiveKey = null;
      this._cacheW = texW;
      this._cacheH = texH;
      this._refreshSlice();
    }
    if (this._packed) {
      return this._packed;
    }
    void this._ensureFetch(texW, texH);
    return null;
  }

  /** Resolve the effective slice for the current state; swap from cache or flag a fetch. */
  private _refreshSlice(): void {
    if (this._timeMode === null) {
      return; // legacy path is untouched
    }
    const { time, key } = this._resolveEffectiveTime(this._nowMs);
    if (key === this._effectiveKey) {
      return; // same slice → no byte change, no version bump
    }
    this._effectiveKey = key;
    this._effectiveTime = time;
    const cached = this._cache.get(key);
    if (cached) {
      this._cache.delete(key);
      this._cache.set(key, cached); // LRU bump
      this._packed = cached;
      this._validTime = time instanceof Date ? time.toISOString() : undefined;
      this._version++;
    } else {
      this._packed = null; // miss → getPackedTexture() kicks the fetch
    }
  }

  private _resolveEffectiveTime(nowMs: number): {
    time: Date | "latest";
    key: string;
  } {
    if (this._timeMode === null) {
      return { time: this._request.time ?? "latest", key: "latest" };
    }
    let ms: number;
    if (this._timeMode === "historical") {
      ms = this._explicitTime ? this._explicitTime.getTime() : nowMs;
    } else if (this._timeMode === "projected") {
      ms = nowMs + this._forecastOffsetMs;
    } else {
      ms = nowMs; // live
    }
    const q =
      this._quantizeMs > 0
        ? Math.floor(ms / this._quantizeMs) * this._quantizeMs
        : ms;
    return { time: new Date(q), key: String(q) };
  }

  private async _ensureFetch(texW: number, texH: number): Promise<void> {
    if (this._fetching || !this._source) {
      return;
    }
    this._fetching = true;
    // Capture the source/request/generation/slice NOW; a setSource/setRequest/
    // refresh during the await must NOT have its result clobbered, and a slice
    // scrub must not mis-activate this slice's bytes.
    const gen = this._invalidation;
    const source = this._source;
    const timed = this._timeMode !== null;
    const key = this._effectiveKey;
    const request: WeatherFieldRequest = timed
      ? { ...this._request, time: this._effectiveTime }
      : this._request;
    try {
      const field = await source.fetchField(request);
      if (this._invalidation !== gen) {
        return; // superseded by a source/request swap — drop it
      }
      const packed = packWeatherField(field, texW, texH);
      const present = extractPresentWeather(field);
      if (!timed) {
        this._packed = packed;
        this._validTime = field.validTime;
        this._presentWeather = present;
        this._version++;
      } else {
        if (key !== null) {
          this._cache.set(key, packed);
          this._evictLru();
          this._cacheW = texW;
          this._cacheH = texH;
        }
        // Activate only if this is still the live slice (the user may have scrubbed).
        if (key === this._effectiveKey) {
          this._packed = packed;
          this._presentWeather = present;
          this._validTime =
            field.validTime ??
            (this._effectiveTime instanceof Date
              ? this._effectiveTime.toISOString()
              : undefined);
          this._version++;
        }
      }
      this._lastError = null;
    } catch (e) {
      if (this._invalidation === gen) {
        this._lastError = (e as Error)?.message ?? String(e);
      }
      // leave _packed null → renderer falls back to the procedural map
    } finally {
      this._fetching = false;
    }
  }

  private _evictLru(): void {
    while (this._cache.size > this._cacheLimit) {
      const oldest = this._cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this._cache.delete(oldest);
    }
  }
}

/**
 * PRECIP-DATA (Batch 444) — distill a field's present-weather into the aggregate
 * the data-driven precip path reads. Prefers the field-level `representativeWw`;
 * if absent but a per-cell `ww` grid is present, picks the cell with the
 * STRONGEST precip `ww` (the max code among precip ranges 50..99) so a sparse but
 * intense system still registers. Returns null when no present-weather is carried
 * (coverage-only sources) so the override stays a no-op for them.
 */
function extractPresentWeather(
  field: WeatherField,
): WeatherPresentWeather | null {
  let ww = field.representativeWw;
  if (ww === undefined && field.ww && field.ww.length > 0) {
    let best = NaN;
    for (let i = 0; i < field.ww.length; i++) {
      const c = field.ww[i];
      // Precip codes are 40..99 (fog/precip/showers/thunderstorm); pick the max
      // so the most significant present weather drives the single global type.
      if (Number.isFinite(c) && c >= 40 && (Number.isNaN(best) || c > best)) {
        best = c;
      }
    }
    if (Number.isFinite(best)) {
      ww = best;
    }
  }
  if (ww === undefined && field.visibilityKm === undefined) {
    return null;
  }
  return { ww, visibilityKm: field.visibilityKm };
}
