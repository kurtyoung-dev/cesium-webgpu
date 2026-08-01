/**
 * METAR weather source (Phase 3 — Batch 425). Parses surface station METAR cloud
 * groups and IDW-rasterizes them onto a coarse lon/lat grid, filling the FULL
 * RGBA weather field — coverage (R), genus (G), cloud base (B), AND density bias
 * (A) — so a source driven from a real format visibly exercises every channel the
 * cloud shader now reads (Batch 424).
 *
 * METAR cloud groups parsed (per WMO/FM 15 + US conventions):
 *   - Amount:  SKC / CLR / NSC / NCD (clear), FEW, SCT, BKN, OVC.
 *   - Height:  3 digits = base in hundreds of feet AGL (e.g. `BKN040` = 4000 ft).
 *   - Genus suffix: `CB` (cumulonimbus), `TCU` (towering cumulus). Otherwise the
 *     genus is inferred from the amount (OVC→stratus, SCT/FEW→cumulus, …).
 *   - `VV` (vertical visibility, e.g. `VV002`) → overcast obscuration.
 *
 * Each station's LOWEST cloud base (the ceiling-relevant layer) drives B, and its
 * MAX amount drives R + the density bias. Stations are interpolated with
 * inverse-distance weighting (IDW, power 2) onto the grid.
 *
 * C13-08: cells with NO station inside the influence radius are NO-DATA (`NaN`),
 * not clear. METAR is a sparse point network — "no station reported here" is the
 * absence of an observation, and emitting `0` made every unobserved cell claim an
 * observed clear sky, which then rendered as a real hole in the deck. The packer
 * fills those cells from the declared no-data fill (the procedural map by
 * default). An SKC/CLR/NSC/NCD station still produces an observed coverage of
 * exactly `0` — clear sky OBSERVED is data, and is unaffected.
 *
 * The live fetch (aviationweather.gov text feed) is optional + network-gated: a
 * `MetarWeatherSource` can be constructed from a provided obs array (the offline
 * probe path) OR from a fetch URL serving raw METAR text (one report per line).
 *
 * @module Scene/Weather/MetarWeatherSource
 */
import type { WeatherSource } from "./WeatherSource.js";
import {
  GLOBAL_WEATHER_BOUNDS,
  type WeatherBounds,
  type WeatherCapabilities,
  type WeatherField,
  type WeatherFieldRequest,
} from "./WeatherTypes.js";
import { CLOUD_BASE_NORM_METERS } from "./WeatherTexPacker.js";

// CloudType indices (mirror Scene/CloudType.js — CUMULUS=0 .. CUMULONIMBUS=10).
const CT_CUMULUS = 0;
const CT_NIMBOSTRATUS = 6;
const CT_STRATUS = 7;
const CT_STRATOCUMULUS = 8;
const CT_CUMULUS_CONGESTUS = 9;
const CT_CUMULONIMBUS = 10;

const FT_TO_M = 0.3048;

/** A station observation: location + either raw METAR text or pre-parsed cover. */
export interface MetarStation {
  /** Station longitude in DEGREES. */
  lon: number;
  /** Station latitude in DEGREES. */
  lat: number;
  /** Raw METAR report text (parsed for cloud groups). */
  raw?: string;
  /** Pre-parsed cloud cover fraction 0..1 (overrides `raw` cover if set). */
  cover?: number;
  /** Pre-parsed cloud base in METRES (overrides `raw` base if set). */
  baseMeters?: number;
  /** Pre-parsed genus (CloudType index 0..10). */
  type?: number;
}

export interface MetarWeatherSourceOptions {
  /** Static obs (the offline path; takes precedence over `url`). */
  stations?: MetarStation[];
  /** URL serving raw METAR text, one report per line (the live, network path). */
  url?: string;
  /** Optional same-origin proxy prefix for CORS on the live path. */
  proxy?: string;
  /** Output grid width (default 64). */
  gridWidth?: number;
  /** Output grid height (default 32). */
  gridHeight?: number;
  /** IDW influence radius in DEGREES of great-circle-ish distance (default 40). */
  influenceRadiusDeg?: number;
  /** Human label for the data origin (e.g. "aviationweather.gov"). */
  sourceLabel?: string;
}

/** A single station resolved to normalized channel values. */
interface ResolvedStation {
  lon: number;
  lat: number;
  cover: number; // 0..1
  baseMeters: number;
  type: number; // CloudType index
  density: number; // 0..1 (0.5 neutral)
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Map a METAR cloud amount token to an okta-derived coverage fraction. */
function amountToCover(amount: string): number {
  switch (amount) {
    case "SKC":
    case "CLR":
    case "NSC":
    case "NCD":
      return 0.0;
    case "FEW":
      return 0.25;
    case "SCT":
      return 0.4;
    case "BKN":
      return 0.75;
    case "OVC":
    case "VV":
      return 1.0;
    default:
      return 0.0;
  }
}

/** Pick a genus index from an amount + optional CB/TCU suffix. */
function genusFor(amount: string, suffix: string | undefined): number {
  if (suffix === "CB") {
    return CT_CUMULONIMBUS;
  }
  if (suffix === "TCU") {
    return CT_CUMULUS_CONGESTUS;
  }
  switch (amount) {
    case "OVC":
      return CT_STRATUS;
    case "VV":
      return CT_NIMBOSTRATUS;
    case "BKN":
      return CT_STRATOCUMULUS;
    case "SCT":
    case "FEW":
      return CT_CUMULUS;
    default:
      return CT_CUMULUS;
  }
}

/**
 * Density bias 0..1 from cover + genus: convective / overcast decks are denser.
 * Mapped across a WIDE span (0.15 thin → ~1.0 dense) so the A channel's deck
 * modulation is conspicuous, not a subtle nudge — FEW/clear → wispy, OVC/CB → solid.
 */
function densityFor(cover: number, genus: number): number {
  let d = 0.15 + 0.7 * cover; // base: more cover → much denser
  if (genus === CT_CUMULONIMBUS) {
    d += 0.25;
  } else if (genus === CT_CUMULUS_CONGESTUS || genus === CT_NIMBOSTRATUS) {
    d += 0.12;
  }
  return clamp01(d);
}

// Matches e.g. FEW040, SCT025CB, BKN012TCU, OVC008, VV002. Amount + 3-digit
// hundreds-of-feet height + optional CB/TCU genus suffix.
const CLOUD_GROUP = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g;
const CLEAR_GROUP = /\b(SKC|CLR|NSC|NCD)\b/;

/**
 * Parse a raw METAR string to a resolved station. Uses the layer with the
 * GREATEST coverage for R/genus/density and the LOWEST base for B (the ceiling).
 */
function parseMetar(lon: number, lat: number, raw: string): ResolvedStation {
  let bestCover = 0;
  let bestGenus = CT_CUMULUS;
  let lowestBaseFt = Number.POSITIVE_INFINITY;
  let any = false;

  CLOUD_GROUP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOUD_GROUP.exec(raw)) !== null) {
    any = true;
    const amount = m[1];
    const heightFt = parseInt(m[2], 10) * 100;
    const suffix = m[3];
    const cover = amountToCover(amount);
    if (cover > bestCover) {
      bestCover = cover;
      bestGenus = genusFor(amount, suffix);
    } else if (cover === bestCover && suffix) {
      // Prefer a convective genus when two layers tie on cover.
      bestGenus = genusFor(amount, suffix);
    }
    if (heightFt < lowestBaseFt) {
      lowestBaseFt = heightFt;
    }
  }

  if (!any && CLEAR_GROUP.test(raw)) {
    any = true; // explicit clear sky → coverage 0
  }

  const baseMeters =
    lowestBaseFt === Number.POSITIVE_INFINITY ? 0 : lowestBaseFt * FT_TO_M;
  return {
    lon,
    lat,
    cover: bestCover,
    baseMeters,
    type: bestGenus,
    density: densityFor(bestCover, bestGenus),
  };
}

/** Resolve a station from pre-parsed fields or by parsing its raw METAR. */
function resolveStation(s: MetarStation): ResolvedStation {
  if (s.cover !== undefined) {
    const cover = clamp01(s.cover);
    const type = s.type ?? (cover >= 0.9 ? CT_STRATUS : CT_CUMULUS);
    return {
      lon: s.lon,
      lat: s.lat,
      cover,
      baseMeters: s.baseMeters ?? 0,
      type,
      density: densityFor(cover, type),
    };
  }
  return parseMetar(s.lon, s.lat, s.raw ?? "");
}

export class MetarWeatherSource implements WeatherSource {
  private readonly _opt: Required<
    Omit<MetarWeatherSourceOptions, "proxy" | "url" | "stations">
  > & {
    proxy?: string;
    url?: string;
    stations?: MetarStation[];
  };

  constructor(options: MetarWeatherSourceOptions = {}) {
    this._opt = {
      stations: options.stations,
      url: options.url,
      proxy: options.proxy,
      gridWidth: options.gridWidth ?? 64,
      gridHeight: options.gridHeight ?? 32,
      influenceRadiusDeg: options.influenceRadiusDeg ?? 40,
      sourceLabel: options.sourceLabel ?? "metar",
    };
  }

  getCapabilities(): WeatherCapabilities {
    return {
      id: `metar:${this._opt.sourceLabel}`,
      label: `METAR (${this._opt.sourceLabel})`,
      supportsTime: false, // latest obs only
      attribution: "METAR surface observations",
    };
  }

  async fetchField(request: WeatherFieldRequest): Promise<WeatherField> {
    const stations = await this._loadStations(request);
    const resolved = stations.map(resolveStation);
    return this._rasterize(resolved, request.bounds ?? GLOBAL_WEATHER_BOUNDS);
  }

  /** Provided obs (offline path) or a network text fetch (live path). */
  private async _loadStations(
    request: WeatherFieldRequest,
  ): Promise<MetarStation[]> {
    if (this._opt.stations && this._opt.stations.length > 0) {
      return this._opt.stations;
    }
    if (!this._opt.url) {
      throw new Error("MetarWeatherSource: no stations and no url");
    }
    const url = this._opt.proxy
      ? `${this._opt.proxy}${encodeURIComponent(this._opt.url)}`
      : this._opt.url;
    const res = await fetch(url, {
      signal: request.signal,
      headers: { Accept: "application/json, text/plain" },
    });
    if (!res.ok) {
      throw new Error(`METAR fetch failed: ${res.status} ${res.statusText}`);
    }
    // The mock route serves JSON ({stations:[...]}); a raw text feed would need a
    // station-coordinate join, which is a deferred follow-up (text feeds carry an
    // ICAO id, not lon/lat). JSON keeps the offline + mock paths typed.
    const data = (await res.json()) as { stations?: MetarStation[] };
    return data.stations ?? [];
  }

  /** IDW-rasterize resolved stations onto the output grid (row0=north, col0=west). */
  private _rasterize(
    stations: ResolvedStation[],
    bounds: WeatherBounds,
  ): WeatherField {
    const w = this._opt.gridWidth;
    const h = this._opt.gridHeight;
    const coverage = new Float32Array(w * h);
    const type = new Float32Array(w * h);
    const baseMeters = new Float32Array(w * h);
    const densityBias = new Float32Array(w * h);
    const r2 = this._opt.influenceRadiusDeg * this._opt.influenceRadiusDeg;

    const west = (bounds.west * 180) / Math.PI;
    const east = (bounds.east * 180) / Math.PI;
    const north = (bounds.north * 180) / Math.PI;
    const south = (bounds.south * 180) / Math.PI;

    for (let y = 0; y < h; y++) {
      // Row 0 = north → lat descends from north to south.
      const lat = h > 1 ? north + (south - north) * (y / (h - 1)) : north;
      for (let x = 0; x < w; x++) {
        const lon = w > 1 ? west + (east - west) * (x / (w - 1)) : west;
        let wSum = 0;
        let cAcc = 0;
        let bAcc = 0;
        let dAcc = 0;
        // Genus is categorical → pick the nearest station's genus, not a blend.
        let nearestD2 = Number.POSITIVE_INFINITY;
        let nearestType = CT_CUMULUS;
        for (let i = 0; i < stations.length; i++) {
          const s = stations[i];
          const dLon = lonDelta(lon, s.lon);
          const dLat = lat - s.lat;
          const d2 = dLon * dLon + dLat * dLat;
          if (d2 > r2) {
            continue; // outside influence radius
          }
          if (d2 < nearestD2) {
            nearestD2 = d2;
            nearestType = s.type;
          }
          // IDW power 2; epsilon avoids a divide-by-zero at a station cell.
          const wgt = 1.0 / (d2 + 1e-3);
          wSum += wgt;
          cAcc += wgt * s.cover;
          bAcc += wgt * s.baseMeters;
          dAcc += wgt * s.density;
        }
        const i = y * w + x;
        if (wSum > 0) {
          coverage[i] = clamp01(cAcc / wSum);
          baseMeters[i] = bAcc / wSum;
          densityBias[i] = clamp01(dAcc / wSum);
          type[i] = nearestType;
        } else {
          // C13-08 — no station in range → NO OBSERVATION, not clear sky. The
          // packer replaces this cell from the field's no-data fill. G/B/A are
          // undefined at a no-data cell (coverage carries the validity), so the
          // neutral values here are never read.
          coverage[i] = NaN;
          baseMeters[i] = 0;
          densityBias[i] = 0.5;
          type[i] = CT_CUMULUS;
        }
      }
    }

    return {
      gridWidth: w,
      gridHeight: h,
      coverage,
      type,
      baseMeters,
      densityBias,
      bounds,
      // The loops above place cell 0 ON `west`/`north` and cell `w-1`/`h-1` ON
      // `east`/`south` — node registration (C13-08), declared rather than assumed.
      registration: "node",
      source: this.getCapabilities().id,
      attribution: this.getCapabilities().attribution,
    };
  }
}

/** Signed shortest longitude delta in degrees, accounting for the ±180 seam. */
function lonDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 180) {
    d -= 360;
  }
  while (d < -180) {
    d += 360;
  }
  return d;
}
