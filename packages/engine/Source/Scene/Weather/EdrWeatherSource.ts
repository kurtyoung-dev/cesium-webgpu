/**
 * OGC API - EDR weather source. Pulls a gridded cloud-cover field from an EDR
 * `cube` query returning CoverageJSON and normalizes it into a
 * {@link WeatherField}. No GRIB2 or NetCDF binary decode is involved, because
 * CoverageJSON parses natively in the browser. The default target is the free,
 * no-auth, public-domain NOAA/NWS-MDL service, GFS total cloud cover.
 *
 * The NWS-MDL endpoint is a prototype and its CORS headers are not guaranteed,
 * so this source supports an optional same-origin `proxy` and an `AbortSignal`,
 * and the {@link WeatherProvider} treats a rejected fetch as no data, leaving
 * the cloud renderer on its procedural map. {@link SyntheticWeatherSource}
 * exercises the same path end to end without the network; the live call is
 * opt-in.
 *
 * @module Scene/Weather/EdrWeatherSource
 */
import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";
import { type CoverageJSON, parseCoverageJson } from "./CoverageJsonParser.js";

export interface EdrWeatherSourceOptions {
  /** EDR API base, e.g. "https://data-api.mdl.nws.noaa.gov/EDR-API". */
  baseUrl?: string;
  /** Collection id (a model run product). */
  collection?: string;
  /** Parameter name (total cloud cover). */
  parameterName?: string;
  /** Coverage units: "percent" (TCDC 0-100) or "fraction" (0-1). */
  coverageUnits?: "percent" | "fraction";
  /** Optional same-origin proxy prefix (prepended to the request URL) for CORS. */
  proxy?: string;
  /** Requested grid resolution (server may ignore and return native). */
  resolution?: { x: number; y: number };
}

const DEFAULTS: Required<Omit<EdrWeatherSourceOptions, "proxy">> = {
  baseUrl: "https://data-api.mdl.nws.noaa.gov/EDR-API",
  collection: "automated_gfs",
  parameterName: "TCDC",
  coverageUnits: "percent",
  resolution: { x: 96, y: 48 },
};

export class EdrWeatherSource implements WeatherSource {
  private readonly _opt: Required<Omit<EdrWeatherSourceOptions, "proxy">> & {
    proxy?: string;
  };

  constructor(options: EdrWeatherSourceOptions = {}) {
    this._opt = {
      baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
      collection: options.collection ?? DEFAULTS.collection,
      parameterName: options.parameterName ?? DEFAULTS.parameterName,
      coverageUnits: options.coverageUnits ?? DEFAULTS.coverageUnits,
      resolution: options.resolution ?? DEFAULTS.resolution,
      proxy: options.proxy,
    };
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `edr:${this._opt.collection}:${this._opt.parameterName}`,
      label: `EDR ${this._opt.collection} ${this._opt.parameterName}`,
      supportsTime: true,
      attribution: "NOAA/NWS (public domain)",
    };
  }

  /** Build the EDR `cube` request URL for the given request. */
  buildUrl(request: WeatherFieldRequest): string {
    const b = request.bounds ?? GLOBAL_WEATHER_BOUNDS;
    const deg = (r: number): number => (r * 180) / Math.PI;
    const bbox = [deg(b.west), deg(b.south), deg(b.east), deg(b.north)]
      .map((v) => v.toFixed(4))
      .join(",");
    const params = new URLSearchParams({
      bbox,
      "parameter-name": this._opt.parameterName,
      f: "CoverageJSON",
      "resolution-x": String(this._opt.resolution.x),
      "resolution-y": String(this._opt.resolution.y),
    });
    if (request.time && request.time !== "latest") {
      params.set("datetime", request.time.toISOString());
    }
    const url = `${this._opt.baseUrl}/collections/${this._opt.collection}/cube?${params.toString()}`;
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
      throw new Error(`EDR fetch failed: ${res.status} ${res.statusText}`);
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
