/**
 * A swappable weather data backend (Phase 0). Implementations:
 *   - {@link EdrWeatherSource}      — OGC API-EDR cube -> CoverageJSON (the MVP).
 *   - {@link SyntheticWeatherSource} — a deterministic test field, no network.
 *   - (later) WCS / SensorThings / GRIB2-file backends.
 *
 * The {@link WeatherProvider} holds the active source; swapping it is how the
 * user switches between open data sources at runtime.
 *
 * @module Scene/Weather/WeatherSource
 */
import type {
  WeatherCapabilities,
  WeatherField,
  WeatherFieldRequest,
} from "./WeatherTypes.js";

export interface WeatherSource {
  /** What this source can serve (time support, valid range, attribution). */
  getCapabilities(): WeatherCapabilities;
  /** Fetch a normalized field. Rejects on network/parse/abort. */
  fetchField(request: WeatherFieldRequest): Promise<WeatherField>;
}
