/**
 * Bakes a normalized {@link WeatherField} into the WebGPU cloud renderer's
 * weather-map texture bytes (Phase 0). The output byte layout EXACTLY matches
 * {@link buildProceduralWeatherMap} (Scene/Weather/ProceduralWeatherMap.ts) — a
 * 256x128 (default) rgba8unorm equirectangular texture, row 0 = north:
 *   R = coverage (0..1 -> 0..255)   — the only channel the shader reads today
 *   G = cloud type / genus (scaffolding, default 128)
 *   B = cloud base, normalized      (scaffolding, default 0)
 *   A = density bias (0.5 neutral)  (scaffolding, default 128)
 *
 * ALL unit conversions live here so a WeatherSource only emits normalized data.
 *
 * C13-08: the texture stays GLOBAL — the renderer keeps packing the fixed global
 * `weatherTexBounds`, and REGIONAL placement happens HERE, by writing the field
 * only into the texels its `bounds` actually cover. That is the placement that
 * keeps a repeating-U / clamping-V sampler meaningful; re-pointing
 * `weatherTexBounds` at a regional rectangle would instead TILE the region across
 * the planet. Texels the field does not observe are written from a declared
 * {@link WeatherNoDataFill}. Both the source-grid coordinate reference and the
 * no-data semantics are decided in {@link WeatherFieldGrid}, not here.
 *
 * @module Scene/Weather/WeatherTexPacker
 */
import { GLOBAL_WEATHER_BOUNDS, type WeatherField } from "./WeatherTypes.js";
import { applyEquirectPolarLowPass } from "./WeatherMapSeam.js";
import { buildProceduralWeatherMap } from "./ProceduralWeatherMap.js";
import {
  DEFAULT_WEATHER_GRID_REGISTRATION,
  isGlobalWeatherWindow,
  isWeatherSampleObserved,
  PROCEDURAL_NO_DATA_FILL,
  weatherFieldGridCoordinate,
  weatherFieldU,
  weatherFieldV,
  weatherFieldWrapsLongitude,
  wrapGridIndex,
  type WeatherGridRegistration,
  type WeatherNoDataFill,
} from "./WeatherFieldGrid.js";

/** 12 km covers cirrus; cloud base metres normalize into [0,1] over this band. */
export const CLOUD_BASE_NORM_METERS = 12000.0;

/** Per-call packing overrides. */
export interface WeatherPackOptions {
  /**
   * Overrides `WeatherField.noDataFill`. Precedence is
   * option > field > {@link PROCEDURAL_NO_DATA_FILL}.
   */
  noDataFill?: WeatherNoDataFill;
}

/** What {@link packWeatherFieldDetailed} reports about a pack. */
export interface WeatherPackResult {
  /** rgba8 bytes, length `texW*texH*4` — what {@link packWeatherField} returns. */
  bytes: Uint8Array;
  /** Texels written from at least one observation. */
  observedTexels: number;
  /** Texels written from the no-data fill. */
  filledTexels: number;
  /** The registration actually used (the field's, or the default). */
  registration: WeatherGridRegistration;
  /** The fill actually used. */
  fillKind: WeatherNoDataFill["kind"];
  /** True when the field's bounds cover the whole texture (the legacy case). */
  global: boolean;
}

/**
 * Bilinear tap set for ONE output texel, reused across the four channels so
 * genus / base / density inherit COVERAGE's validity instead of re-deciding it.
 */
interface BilinearTaps {
  i00: number;
  i10: number;
  i01: number;
  i11: number;
  tx: number;
  ty: number;
  v00: boolean;
  v10: boolean;
  v01: boolean;
  v11: boolean;
  /** How many of the four taps are observations (0..4). */
  valid: number;
  /** Sum of the VALID taps' bilinear weights (used to renormalize). */
  weightSum: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Encode a normalized channel value to a byte; non-finite falls back. */
function encodeChannel(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.round(clamp01(value) * 255) : fallback;
}

/**
 * Resolve the four source cells a texel samples, and which of them are
 * observations. Longitude wraps only where {@link weatherFieldWrapsLongitude}
 * says it is reachable; everything else clamps, which is the historical
 * behaviour and the only defined answer at a regional field's edge.
 */
function resolveTaps(
  taps: BilinearTaps,
  coverage: Float32Array,
  gw: number,
  gh: number,
  fx: number,
  fy: number,
  wrapX: boolean,
  sentinel: number | undefined,
): void {
  let x0: number;
  let x1: number;
  let tx: number;
  if (wrapX) {
    const ix = Math.floor(fx);
    tx = fx - ix;
    x0 = wrapGridIndex(ix, gw);
    x1 = wrapGridIndex(ix + 1, gw);
  } else {
    // A cell-registered field maps its outer half-cells to coordinates in
    // [-0.5, 0) and (count-1, count-0.5]. Clamp the CONTINUOUS coordinate,
    // not only the integer index: retaining a negative fraction extrapolates
    // past the west edge and can give a diagonally-opposite observation a
    // positive bilinear weight at the north-west no-data corner.
    const clampedFx = Math.max(0, Math.min(gw - 1, fx));
    x0 = Math.floor(clampedFx);
    x1 = Math.min(gw - 1, x0 + 1);
    tx = clampedFx - x0;
  }
  // Latitude never wraps, so its outer half-cells always clamp. As above, the
  // fractional coordinate must clamp with the indices to avoid extrapolation.
  const clampedFy = Math.max(0, Math.min(gh - 1, fy));
  const y0 = Math.floor(clampedFy);
  const y1 = Math.min(gh - 1, y0 + 1);
  const ty = clampedFy - y0;

  taps.i00 = y0 * gw + x0;
  taps.i10 = y0 * gw + x1;
  taps.i01 = y1 * gw + x0;
  taps.i11 = y1 * gw + x1;
  taps.tx = tx;
  taps.ty = ty;
  taps.v00 = isWeatherSampleObserved(coverage[taps.i00], sentinel);
  taps.v10 = isWeatherSampleObserved(coverage[taps.i10], sentinel);
  taps.v01 = isWeatherSampleObserved(coverage[taps.i01], sentinel);
  taps.v11 = isWeatherSampleObserved(coverage[taps.i11], sentinel);
  taps.valid =
    (taps.v00 ? 1 : 0) +
    (taps.v10 ? 1 : 0) +
    (taps.v01 ? 1 : 0) +
    (taps.v11 ? 1 : 0);
  if (taps.valid === 4 || taps.valid === 0) {
    taps.weightSum = taps.valid === 4 ? 1 : 0;
    return;
  }
  let sum = 0;
  if (taps.v00) {
    sum += (1 - tx) * (1 - ty);
  }
  if (taps.v10) {
    sum += tx * (1 - ty);
  }
  if (taps.v01) {
    sum += (1 - tx) * ty;
  }
  if (taps.v11) {
    sum += tx * ty;
  }
  taps.weightSum = sum;
  if (!(sum > 0)) {
    // Every observation among the taps carries ZERO bilinear weight — the texel
    // sits exactly on a no-data node. Renormalizing would divide 0 by 0 and the
    // NaN would encode as byte 0, i.e. a fabricated clear sky. Treat it as the
    // no-data texel it is.
    taps.valid = 0;
  }
}

/**
 * Evaluate one channel over an already-resolved tap set.
 *
 * The all-valid branch is the historical expression, character for character and
 * in the historical association order, so a field with no gaps packs to the same
 * bytes it always did. The partial branch drops no-data taps and RENORMALIZES
 * over the ones that remain, so the fill never bleeds inward across a data edge
 * and a no-data neighbour never dilutes a real observation toward zero.
 */
function evaluateTaps(data: Float32Array, taps: BilinearTaps): number {
  const a = data[taps.i00];
  const b = data[taps.i10];
  const c = data[taps.i01];
  const d = data[taps.i11];
  const tx = taps.tx;
  const ty = taps.ty;
  if (taps.valid === 4) {
    return (
      a * (1 - tx) * (1 - ty) +
      b * tx * (1 - ty) +
      c * (1 - tx) * ty +
      d * tx * ty
    );
  }
  let acc = 0;
  if (taps.v00) {
    acc += a * (1 - tx) * (1 - ty);
  }
  if (taps.v10) {
    acc += b * tx * (1 - ty);
  }
  if (taps.v01) {
    acc += c * (1 - tx) * ty;
  }
  if (taps.v11) {
    acc += d * tx * ty;
  }
  return acc / taps.weightSum;
}

// One procedural fill per texture size. The fill is only ever READ from here;
// building it is a full two-stack fBM evaluation and a regional pack would
// otherwise redo it on every fetched slice.
let proceduralFillCache: {
  w: number;
  h: number;
  bytes: Uint8Array;
} | null = null;

function proceduralFillBytes(texW: number, texH: number): Uint8Array {
  if (
    proceduralFillCache === null ||
    proceduralFillCache.w !== texW ||
    proceduralFillCache.h !== texH
  ) {
    proceduralFillCache = {
      w: texW,
      h: texH,
      bytes: buildProceduralWeatherMap(texW, texH),
    };
  }
  return proceduralFillCache.bytes;
}

/** The four bytes a `"constant"` fill writes, in the packer's own encoding. */
function constantFillQuad(fill: WeatherNoDataFill): Uint8Array {
  const quad = new Uint8Array(4);
  if (fill.kind !== "constant") {
    return quad;
  }
  quad[0] = encodeChannel(fill.coverage, 0);
  quad[1] =
    fill.type !== undefined ? encodeChannel(fill.type / 10.0, 128) : 128;
  quad[2] =
    fill.baseMeters !== undefined
      ? encodeChannel(fill.baseMeters / CLOUD_BASE_NORM_METERS, 0)
      : 0;
  quad[3] =
    fill.densityBias !== undefined ? encodeChannel(fill.densityBias, 128) : 128;
  return quad;
}

/**
 * Resample a {@link WeatherField} onto the `texW x texH` GLOBAL rgba8 weather
 * texture, honouring the field's `bounds`, registration, and no-data — and
 * report what it did.
 *
 * A GLOBAL field (bounds == the texture's window, node-registered, no gaps) takes
 * exactly the historical code path and produces exactly the historical bytes.
 *
 * @param field The normalized weather grid.
 * @param texW Texture width (default 256, matches WEATHER_TEX_W).
 * @param texH Texture height (default 128, matches WEATHER_TEX_H).
 * @param options Per-call overrides (currently the no-data fill).
 */
export function packWeatherFieldDetailed(
  field: WeatherField,
  texW: number = 256,
  texH: number = 128,
  options?: WeatherPackOptions,
): WeatherPackResult {
  const out = new Uint8Array(texW * texH * 4);
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  const hasType = field.type !== undefined && field.type.length === gw * gh;
  const hasBase =
    field.baseMeters !== undefined && field.baseMeters.length === gw * gh;
  const hasDensity =
    field.densityBias !== undefined && field.densityBias.length === gw * gh;
  // `bounds` is required by the type, but `packWeatherField` is a PUBLIC export
  // and pre-C13-08 callers never had to supply meaningful ones (nothing read
  // them). A bounds-less field therefore keeps its historical global behaviour
  // rather than throwing.
  const bounds = field.bounds ?? GLOBAL_WEATHER_BOUNDS;
  const registration = field.registration ?? DEFAULT_WEATHER_GRID_REGISTRATION;
  const sentinel = field.noDataValue;
  const fill =
    options?.noDataFill ?? field.noDataFill ?? PROCEDURAL_NO_DATA_FILL;
  const wrapX = weatherFieldWrapsLongitude(bounds, registration);
  const constantQuad = fill.kind === "constant" ? constantFillQuad(fill) : null;
  let fillMap: Uint8Array | null = null;

  const taps: BilinearTaps = {
    i00: 0,
    i10: 0,
    i01: 0,
    i11: 0,
    tx: 0,
    ty: 0,
    v00: false,
    v10: false,
    v01: false,
    v11: false,
    valid: 0,
    weightSum: 0,
  };
  let observedTexels = 0;
  let filledTexels = 0;

  for (let ty = 0; ty < texH; ty++) {
    // Row 0 = north in both the field and the texture, so the v axes align.
    // C13-07: resample at TEXEL CENTRES — `(ty + 0.5) / texH` — not at texel
    // indices normalized over `texH - 1`. A `linear` sampler reconstructs the
    // stored value at the texel CENTRE, so the old edge-anchored mapping put the
    // field up to half a texel off in longitude, which is exactly the pair of
    // values `addressModeU: "repeat"` blends across the antimeridian.
    const texelV = (ty + 0.5) / texH;
    // C13-08: ...and THEN place that texel inside the field's own window. For a
    // global field this is the identity, so the expression below is still the
    // historical `((ty + 0.5) / texH) * (gh - 1)`.
    const fv = weatherFieldV(texelV, bounds);
    const insideLat = fv >= 0 && fv <= 1;
    const fy = weatherFieldGridCoordinate(fv, gh, registration);
    for (let tx = 0; tx < texW; tx++) {
      const texelU = (tx + 0.5) / texW;
      const fu = weatherFieldU(texelU, bounds);
      const i = (ty * texW + tx) * 4;

      taps.valid = 0;
      if (insideLat && fu >= 0 && fu <= 1) {
        const fx = weatherFieldGridCoordinate(fu, gw, registration);
        resolveTaps(taps, field.coverage, gw, gh, fx, fy, wrapX, sentinel);
      }

      if (taps.valid === 0) {
        // Outside the field's bounds, or every contributing cell is no-data.
        filledTexels++;
        if (constantQuad !== null) {
          out[i] = constantQuad[0];
          out[i + 1] = constantQuad[1];
          out[i + 2] = constantQuad[2];
          out[i + 3] = constantQuad[3];
        } else {
          fillMap = fillMap ?? proceduralFillBytes(texW, texH);
          out[i] = fillMap[i];
          out[i + 1] = fillMap[i + 1];
          out[i + 2] = fillMap[i + 2];
          out[i + 3] = fillMap[i + 3];
        }
        continue;
      }

      observedTexels++;
      out[i] = encodeChannel(evaluateTaps(field.coverage, taps), 0);
      // G: cloud-type index (CloudType 0..10) packed as index/10 → 0..255, so the
      // shader recovers the genus via round(G/255 * 10). Scaffolding until the
      // shader reads G; default 128 (mid) when no type is provided (matches the
      // procedural map's G).
      out[i + 1] = hasType
        ? encodeChannel(
            evaluateTaps(field.type as Float32Array, taps) / 10.0,
            128,
          )
        : 128;
      out[i + 2] = hasBase
        ? encodeChannel(
            evaluateTaps(field.baseMeters as Float32Array, taps) /
              CLOUD_BASE_NORM_METERS,
            0,
          )
        : 0;
      out[i + 3] = hasDensity
        ? encodeChannel(
            evaluateTaps(field.densityBias as Float32Array, taps),
            128,
          )
        : 128;
    }
  }

  // C13-07 — pole-safe: collapse the polar-cap rows to a single longitude value
  // and taper the longitudinal over-sampling below them, so a straight-down polar
  // camera does not read a different cell per azimuth. Exact no-op below ~59 deg.
  applyEquirectPolarLowPass(out, texW, texH);
  return {
    bytes: out,
    observedTexels,
    filledTexels,
    registration,
    fillKind: fill.kind,
    global: isGlobalWeatherWindow(bounds),
  };
}

/**
 * Resample a {@link WeatherField} to a `texW x texH` rgba8 weather texture.
 *
 * Thin wrapper over {@link packWeatherFieldDetailed} — same work, bytes only.
 *
 * @param field The normalized weather grid.
 * @param texW Texture width (default 256, matches WEATHER_TEX_W).
 * @param texH Texture height (default 128, matches WEATHER_TEX_H).
 * @param options Per-call overrides (currently the no-data fill).
 * @returns rgba8 bytes, length `texW*texH*4`.
 */
export function packWeatherField(
  field: WeatherField,
  texW: number = 256,
  texH: number = 128,
  options?: WeatherPackOptions,
): Uint8Array {
  return packWeatherFieldDetailed(field, texW, texH, options).bytes;
}
