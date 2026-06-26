/**
 * OGC API - EDR weather source (Phase 1 MVP). Pulls a gridded cloud-cover field
 * from an EDR `cube` query returning CoverageJSON, and normalizes it into a
 * {@link WeatherField} — no GRIB2/NetCDF binary decode (CoverageJSON parses
 * natively in the browser). Default target: NOAA/NWS-MDL (free, no-auth,
 * public-domain), GFS, total cloud cover.
 *
 * NOTE (see migration_doc/WEATHER_DATA_INGEST_ROADMAP.md): the NWS-MDL endpoint
 * is a dev-lab prototype and its CORS headers are not guaranteed — so this
 * source supports an optional same-origin `proxy` and an `AbortSignal`, and the
 * {@link WeatherProvider} treats a rejected fetch as "no data" (the cloud
 * renderer falls back to its procedural map). Verified end-to-end against
 * {@link SyntheticWeatherSource}; the live call is opt-in.
 *
 * @module Scene/Weather/EdrWeatherSource
 */
import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherBounds,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";

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

interface CovJsonAxis {
  values?: number[];
  start?: number;
  stop?: number;
  num?: number;
}

interface CoverageJSON {
  domain?: {
    axes?: { x?: CovJsonAxis; y?: CovJsonAxis };
  };
  ranges?: Record<string, { values?: (number | null)[]; shape?: number[] }>;
}

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
    return this._parse(cov, request.bounds ?? GLOBAL_WEATHER_BOUNDS);
  }

  /** Parse CoverageJSON into a normalized WeatherField (row0=north, col0=west). */
  private _parse(cov: CoverageJSON, bounds: WeatherBounds): WeatherField {
    const xAxis = cov.domain?.axes?.x;
    const yAxis = cov.domain?.axes?.y;
    const xs = axisValues(xAxis);
    const ys = axisValues(yAxis);
    if (!xs || !ys || xs.length === 0 || ys.length === 0) {
      throw new Error("EDR CoverageJSON: missing x/y axis values");
    }
    const range =
      cov.ranges?.[this._opt.parameterName] ??
      (cov.ranges ? cov.ranges[Object.keys(cov.ranges)[0]] : undefined);
    const values = range?.values;
    if (!values) {
      throw new Error("EDR CoverageJSON: missing range values");
    }
    const gw = xs.length;
    const gh = ys.length;
    if (values.length < gw * gh) {
      throw new Error(
        `EDR CoverageJSON: range ${values.length} < grid ${gw}x${gh}`,
      );
    }
    // Orient so row 0 = north (lat descending), col 0 = west (lon ascending).
    const yDescending = ys[0] > ys[ys.length - 1];
    const xAscending = xs[0] < xs[xs.length - 1];
    const norm = this._opt.coverageUnits === "percent" ? 1 / 100 : 1;
    const coverage = new Float32Array(gw * gh);
    for (let oy = 0; oy < gh; oy++) {
      const sy = yDescending ? oy : gh - 1 - oy; // source row for north-first output
      for (let ox = 0; ox < gw; ox++) {
        const sx = xAscending ? ox : gw - 1 - ox;
        const v = values[sy * gw + sx];
        coverage[oy * gw + ox] =
          v === null || v === undefined
            ? 0
            : Math.max(0, Math.min(1, v * norm));
      }
    }
    return {
      gridWidth: gw,
      gridHeight: gh,
      coverage,
      bounds,
      source: this.getCapabilities().id,
      attribution: this.getCapabilities().attribution,
    };
  }
}

/** Resolve a CoverageJSON axis to an explicit value list (handles start/stop/num). */
function axisValues(axis: CovJsonAxis | undefined): number[] | null {
  if (!axis) {
    return null;
  }
  if (axis.values && axis.values.length > 0) {
    return axis.values;
  }
  if (
    typeof axis.start === "number" &&
    typeof axis.stop === "number" &&
    typeof axis.num === "number" &&
    axis.num > 0
  ) {
    const out: number[] = [];
    const step = axis.num > 1 ? (axis.stop - axis.start) / (axis.num - 1) : 0;
    for (let i = 0; i < axis.num; i++) {
      out.push(axis.start + i * step);
    }
    return out;
  }
  return null;
}
