/**
 * OGC API - Coverages weather source. Pulls a gridded cloud-cover field from MSC
 * GeoMet's OGC API-Coverages endpoint, requesting CoverageJSON rather than
 * binary WCS GeoTIFF so it can reuse the {@link parseCoverageJson} helper that
 * {@link EdrWeatherSource} uses; no GeoTIFF or NetCDF binary decoder is needed in
 * the browser, and none is implemented.
 *
 * The default target is MSC GeoMet, the Environment and Climate Change Canada
 * open-data service, and its GDPS total-cloud-cover collection, which serves the
 * OGC API-Coverages `/collections/{id}/coverage` operation with a `bbox` and
 * `f=json` query. The source fills the R coverage channel; G, B and A are left to
 * the packer defaults unless the collection later provides genus, base and
 * density ranges.
 *
 * The live call is opt-in and gated on CORS. The source supports an optional
 * same-origin `proxy` and an `AbortSignal`, and the {@link WeatherProvider}
 * treats a rejected fetch as no data, so the cloud renderer falls back to its
 * procedural map. A committed mock fixture at `/mock-wcs` exercises the path
 * end to end without the network.
 *
 * @module Scene/Weather/WcsCoveragesWeatherSource
 */
import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";
import { type CoverageJSON, parseCoverageJson } from "./CoverageJsonParser.js";

export interface WcsCoveragesWeatherSourceOptions {
  /** OGC API-Coverages base, e.g. "https://api.weather.gc.ca". */
  baseUrl?: string;
  /** Collection (coverage) id, e.g. a GDPS total-cloud-cover product. */
  collection?: string;
  /** Range/parameter key within the returned CoverageJSON (collection-dependent). */
  parameterName?: string;
  /** Coverage units: "percent" (0-100) or "fraction" (0-1). */
  coverageUnits?: "percent" | "fraction";
  /** Query value for the CoverageJSON format (server-dependent: "json" or "CoverageJSON"). */
  format?: string;
  /** Optional same-origin proxy prefix (prepended to the request URL) for CORS. */
  proxy?: string;
}

const DEFAULTS: Required<Omit<WcsCoveragesWeatherSourceOptions, "proxy">> = {
  baseUrl: "https://api.weather.gc.ca",
  collection: "gdps-cloud-cover",
  parameterName: "TCDC",
  coverageUnits: "percent",
  format: "json",
};

export class WcsCoveragesWeatherSource implements WeatherSource {
  private readonly _opt: Required<
    Omit<WcsCoveragesWeatherSourceOptions, "proxy">
  > & { proxy?: string };

  constructor(options: WcsCoveragesWeatherSourceOptions = {}) {
    this._opt = {
      baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
      collection: options.collection ?? DEFAULTS.collection,
      parameterName: options.parameterName ?? DEFAULTS.parameterName,
      coverageUnits: options.coverageUnits ?? DEFAULTS.coverageUnits,
      format: options.format ?? DEFAULTS.format,
      proxy: options.proxy,
    };
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `wcs:msc-geomet:${this._opt.collection}`,
      label: `MSC GeoMet ${this._opt.collection} (${this._opt.parameterName})`,
      // OGC API-Coverages supports a `datetime` query, but until a temporal
      // dimension is wired through this source serves the latest coverage only.
      supportsTime: false,
      attribution:
        "Environment and Climate Change Canada — MSC GeoMet (Open Government Licence — Canada)",
    };
  }

  /** Build the OGC API-Coverages `/coverage` request URL for the given request. */
  buildUrl(request: WeatherFieldRequest): string {
    const b = request.bounds ?? GLOBAL_WEATHER_BOUNDS;
    const deg = (r: number): number => (r * 180) / Math.PI;
    const bbox = [deg(b.west), deg(b.south), deg(b.east), deg(b.north)]
      .map((v) => v.toFixed(4))
      .join(",");
    const params = new URLSearchParams({
      bbox,
      f: this._opt.format,
    });
    const url = `${this._opt.baseUrl}/collections/${this._opt.collection}/coverage?${params.toString()}`;
    return this._opt.proxy
      ? `${this._opt.proxy}${encodeURIComponent(url)}`
      : url;
  }

  async fetchField(request: WeatherFieldRequest): Promise<WeatherField> {
    const url = this.buildUrl(request);
    const res = await fetch(url, {
      signal: request.signal,
      headers: { Accept: "application/prs.coverage+json, application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `OGC Coverages fetch failed: ${res.status} ${res.statusText}`,
      );
    }
    const cov = (await res.json()) as CoverageJSON;
    const caps = this.getCapabilities();
    return parseCoverageJson(cov, {
      parameterName: this._opt.parameterName,
      units: this._opt.coverageUnits === "percent" ? "percent" : "fraction",
      bounds: request.bounds ?? GLOBAL_WEATHER_BOUNDS,
      source: caps.id,
      attribution: caps.attribution,
    });
  }
}
