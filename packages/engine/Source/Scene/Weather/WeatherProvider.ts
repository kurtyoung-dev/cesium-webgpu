/**
 * Orchestrates weather ingest (Phase 1): holds the active {@link WeatherSource},
 * fetches a {@link WeatherField} asynchronously, bakes it into the weather-map
 * bytes via {@link packWeatherField}, and exposes a SYNCHRONOUS accessor the
 * WebGPU cloud renderer calls each frame. A cache miss kicks a background fetch
 * and returns null (the renderer keeps its procedural map until data arrives, so
 * there's no overcast-everywhere flash). Swapping the source is how the user
 * switches between open data sources at runtime.
 *
 * Set it on `globe.weatherProvider`; the renderer auto-enables the weather map
 * once real bytes are ready.
 *
 * @module Scene/Weather/WeatherProvider
 */
import { packWeatherField } from "./WeatherTexPacker.js";
import type { WeatherSource } from "./WeatherSource.js";
import type { WeatherFieldRequest } from "./WeatherTypes.js";

export class WeatherProvider {
  private _source: WeatherSource | null;
  private _request: WeatherFieldRequest;
  private _packed: Uint8Array | null = null;
  private _version = 0;
  private _fetching = false;
  private _lastError: string | null = null;
  private _validTime: string | undefined = undefined;
  // Bumped ONLY by setSource/setRequest/refresh (NOT by a successful fetch). An
  // in-flight fetch captures it and discards its result if it changed mid-flight,
  // so swapping the source during a slow (network) fetch can't apply stale data.
  private _invalidation = 0;

  constructor(
    source: WeatherSource | null = null,
    request: WeatherFieldRequest = { time: "latest" },
  ) {
    this._source = source;
    this._request = request;
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

  /** Swap the active source (runtime source-switch). Drops the cache. */
  setSource(source: WeatherSource | null): void {
    this._source = source;
    this._packed = null;
    this._lastError = null;
    this._invalidation++;
    this._version++;
  }

  /** Change the request (time / region). Drops the cache. */
  setRequest(request: WeatherFieldRequest): void {
    this._request = request;
    this._packed = null;
    this._invalidation++;
    this._version++;
  }

  /** Force a re-fetch (e.g. a live-refresh tick). */
  refresh(): void {
    this._packed = null;
    this._invalidation++;
    this._version++;
  }

  /**
   * The renderer's per-frame accessor. Returns cached packed bytes, or null on a
   * miss (which starts a background fetch). Never throws; a failed fetch leaves
   * this null and records {@link lastError}.
   */
  getPackedTexture(texW: number, texH: number): Uint8Array | null {
    if (this._packed) {
      return this._packed;
    }
    void this._ensureFetch(texW, texH);
    return null;
  }

  private async _ensureFetch(texW: number, texH: number): Promise<void> {
    if (this._fetching || !this._source) {
      return;
    }
    this._fetching = true;
    // Capture the source/request/generation NOW; a setSource/setRequest/refresh
    // during the await must NOT have its result clobbered by this in-flight one.
    const gen = this._invalidation;
    const source = this._source;
    const request = this._request;
    try {
      const field = await source.fetchField(request);
      if (this._invalidation === gen) {
        this._packed = packWeatherField(field, texW, texH);
        this._validTime = field.validTime;
        this._lastError = null;
        this._version++;
      }
      // else: superseded — drop the stale result; the next getPackedTexture()
      // sees _packed === null and kicks a fresh fetch with the new source.
    } catch (e) {
      if (this._invalidation === gen) {
        this._lastError = (e as Error)?.message ?? String(e);
      }
      // leave _packed null → renderer falls back to the procedural map
    } finally {
      // Always release the lock so a superseding source can fetch next frame.
      this._fetching = false;
    }
  }
}
