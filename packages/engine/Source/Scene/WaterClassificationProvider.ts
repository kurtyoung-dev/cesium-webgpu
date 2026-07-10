/**
 * WaterClassificationProvider — the WATER-epic Phase-1 seam (C7-LAKE-WATER-MASK).
 *
 * A water classification provider augments the terrain provider's per-tile
 * water mask with a supplementary client-side water dataset. Phase 1 ships
 * one concrete implementation, {@link LakeWaterClassificationProvider},
 * which composites Natural Earth 1:10m lake polygons (public domain) over
 * the provider mask so large inland lakes (Great Lakes, Great Salt Lake,
 * Baikal, Victoria, …) get the animated water-mask effect that Cesium
 * World Terrain's ocean-only mask denies them.
 *
 * Known dataset limitation: Natural Earth classes the Caspian Sea as
 * OCEAN — it is absent from the lakes files, so `lakeWaterMask` does not
 * add it. Largest bundled bodies: Baikal, the Great Lakes, Great
 * Bear/Slave, Winnipeg, Tanganyika, Victoria, Balkhash.
 *
 * The seam is deliberately renderer-agnostic: it operates on the CPU-side
 * mask BYTES inside the single shared upload point
 * (`GlobeSurfaceTile.js` → `createWaterMaskTextureIfNeeded`, unified for
 * both backends in Batch 512), so WebGL and WebGPU consume identical
 * texels by construction. Wired behind the opt-in `globe.lakeWaterMask`
 * flag — DEFAULT OFF and byte-identical when off.
 *
 * Later WATER-epic phases can add providers backed by finer datasets
 * (e.g. the ~30m public-domain SRTMSWBD raster — research lane
 * R-LAKE-SRTMSWBD) behind the same interface.
 */

/**
 * Minimal structural shape of a geographic rectangle in RADIANS —
 * matches `Core/Rectangle` without needing its (untyped) import.
 */
export interface GeographicRectangle {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * The Phase-1 water classification seam. Implementations rasterize
 * supplementary water coverage into a tile's water-mask texels.
 */
export interface WaterClassificationProvider {
  /** True once the backing dataset is decoded and usable. */
  readonly ready: boolean;

  /**
   * Fast bounding-box test: does any supplementary water body intersect
   * the tile rectangle (radians)? Used to keep the all-land 1-byte
   * fast path for the (vast majority of) tiles with no lake.
   */
  intersectsRectangle(rectangle: GeographicRectangle): boolean;

  /**
   * OR-composite supplementary water coverage over the terrain
   * provider's mask for the tile rectangle. NEVER mutates the input —
   * the provider mask may be shared with (or upsampled into) other
   * tiles. Returns a NEW combined mask, or `undefined` when the
   * composite would change nothing (caller keeps the original mask and
   * its fast paths).
   *
   * A 1-byte all-land mask expands to `expandedSize`² when a lake
   * intersects; an N×N provider mask keeps its resolution.
   */
  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined;
}

interface LakePolygon {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Flattened [lon0, lat0, lon1, lat1, …] radians, closing point removed. */
  rings: Float64Array[];
}

const MAGIC_LWM1 = 0x314d574c;
const DEFAULT_EXPANDED_SIZE = 256;

/**
 * Phase-1 concrete implementation backed by the packed Natural Earth
 * 1:10m lakes asset (`Assets/WaterMask/ne10mLakes.bin`, produced by
 * `Tools/build-lake-water-mask.mjs`; format documented there).
 *
 * Rasterization is scanline even-odd at water-mask texel centers, in
 * geographic (linear-in-lat/lon) space — matching how the globe shaders
 * map water-mask UVs over a terrain tile's rectangle (row 0 = north,
 * the same orientation the provider masks use; the WebGL shader V-flip
 * and the WebGPU south-origin row reversal both key off that
 * convention, see `WebGPUGlobeSurfaceTextures.getOrCreateWaterMaskTexture`).
 */
export class LakeWaterClassificationProvider implements WaterClassificationProvider {
  private _polygons: LakePolygon[] = [];
  private _ready = false;
  // Whole-dataset bounds for a single cheap early-out per tile.
  private _west = Infinity;
  private _south = Infinity;
  private _east = -Infinity;
  private _north = -Infinity;

  /**
   * @param buffer The fetched `ne10mLakes.bin` payload.
   * @throws Error when the buffer is not an LWM1 asset.
   */
  constructor(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC_LWM1) {
      throw new Error(
        "LakeWaterClassificationProvider: not an LWM1 lake-mask asset",
      );
    }
    const polygonCount = view.getUint32(4, true);
    let o = 8;
    const polygons: LakePolygon[] = new Array(polygonCount);
    for (let p = 0; p < polygonCount; p++) {
      const west = view.getFloat64(o, true);
      const south = view.getFloat64(o + 8, true);
      const east = view.getFloat64(o + 16, true);
      const north = view.getFloat64(o + 24, true);
      o += 32;
      const lonSpan = (east - west) / 65535.0;
      const latSpan = (north - south) / 65535.0;
      const ringCount = view.getUint32(o, true);
      o += 4;
      const rings: Float64Array[] = new Array(ringCount);
      for (let r = 0; r < ringCount; r++) {
        const vertexCount = view.getUint32(o, true);
        o += 4;
        const ring = new Float64Array(vertexCount * 2);
        for (let i = 0; i < vertexCount; i++) {
          ring[i * 2] = west + view.getUint16(o, true) * lonSpan;
          ring[i * 2 + 1] = south + view.getUint16(o + 2, true) * latSpan;
          o += 4;
        }
        rings[r] = ring;
      }
      polygons[p] = { west, south, east, north, rings };
      if (west < this._west) this._west = west;
      if (south < this._south) this._south = south;
      if (east > this._east) this._east = east;
      if (north > this._north) this._north = north;
    }
    this._polygons = polygons;
    this._ready = true;
  }

  get ready(): boolean {
    return this._ready;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (!this._ready) return false;
    if (
      rectangle.east < this._west ||
      rectangle.west > this._east ||
      rectangle.north < this._south ||
      rectangle.south > this._north
    ) {
      return false;
    }
    const polygons = this._polygons;
    for (let i = 0; i < polygons.length; i++) {
      const p = polygons[i];
      if (
        rectangle.east >= p.west &&
        rectangle.west <= p.east &&
        rectangle.north >= p.south &&
        rectangle.south <= p.north
      ) {
        return true;
      }
    }
    return false;
  }

  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined {
    if (!this._ready) return undefined;
    // 1-byte all-WATER fast path: nothing to add.
    if (providerMask.length === 1 && providerMask[0] !== 0) return undefined;

    const candidates: LakePolygon[] = [];
    const polygons = this._polygons;
    for (let i = 0; i < polygons.length; i++) {
      const p = polygons[i];
      if (
        rectangle.east >= p.west &&
        rectangle.west <= p.east &&
        rectangle.north >= p.south &&
        rectangle.south <= p.north
      ) {
        candidates.push(p);
      }
    }
    if (candidates.length === 0) return undefined;

    const size =
      providerMask.length === 1
        ? (expandedSize ?? DEFAULT_EXPANDED_SIZE)
        : Math.round(Math.sqrt(providerMask.length));
    const out = new Uint8Array(size * size);
    if (providerMask.length === 1) {
      // all-land (value 0): `out` is already zero-filled.
    } else {
      out.set(providerMask);
    }

    let changed = false;
    for (const polygon of candidates) {
      if (rasterizePolygon(polygon, rectangle, size, out)) changed = true;
    }
    return changed ? out : undefined;
  }
}

/**
 * Scanline even-odd fill of one lake polygon (outer ring + holes share
 * parity) into a north-first size×size mask over `rectangle`. Texel
 * centers are sampled; crossings use the half-open `[yLow, yHigh)` rule
 * so shared ring vertices count exactly once. Returns true when any
 * texel changed. Row 0 = north (image order — the provider-mask
 * convention, see class doc).
 */
function rasterizePolygon(
  polygon: LakePolygon,
  rectangle: GeographicRectangle,
  size: number,
  out: Uint8Array,
): boolean {
  const west = rectangle.west;
  const north = rectangle.north;
  const dLon = (rectangle.east - rectangle.west) / size;
  const dLat = (rectangle.north - rectangle.south) / size;
  if (!(dLon > 0) || !(dLat > 0)) return false;

  // Per-row crossing longitudes, allocated lazily (most rows of a
  // partially-covered tile have none).
  const rows: Array<number[] | undefined> = new Array(size);

  for (const ring of polygon.rings) {
    const vertexCount = ring.length / 2;
    for (let i = 0; i < vertexCount; i++) {
      const j = (i + 1) % vertexCount;
      const x0 = ring[i * 2];
      const y0 = ring[i * 2 + 1];
      const x1 = ring[j * 2];
      const y1 = ring[j * 2 + 1];
      if (y0 === y1) continue;
      const yLow = Math.min(y0, y1);
      const yHigh = Math.max(y0, y1);
      // Rows whose center latitude lies within [yLow, yHigh):
      // centerLat(r) = north − (r + 0.5)·dLat.
      let rStart = Math.ceil((north - yHigh) / dLat - 0.5);
      let rEnd = Math.floor((north - yLow) / dLat - 0.5);
      if (rStart < 0) rStart = 0;
      if (rEnd > size - 1) rEnd = size - 1;
      const invDy = 1.0 / (y1 - y0);
      for (let r = rStart; r <= rEnd; r++) {
        const lat = north - (r + 0.5) * dLat;
        // Half-open crossing rule (even-odd).
        if ((y0 <= lat && y1 > lat) || (y1 <= lat && y0 > lat)) {
          const lon = x0 + (lat - y0) * invDy * (x1 - x0);
          (rows[r] ??= []).push(lon);
        }
      }
    }
  }

  let changed = false;
  for (let r = 0; r < size; r++) {
    const crossings = rows[r];
    if (crossings === undefined || crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    const rowOffset = r * size;
    // Pair up crossings; an odd trailing crossing (degenerate ring) is
    // dropped rather than filling to the tile edge.
    const pairCount = crossings.length - (crossings.length % 2);
    for (let k = 0; k < pairCount; k += 2) {
      const lonEnter = crossings[k];
      const lonExit = crossings[k + 1];
      // Texel columns whose center lies within [lonEnter, lonExit):
      // centerLon(c) = west + (c + 0.5)·dLon.
      let cStart = Math.ceil((lonEnter - west) / dLon - 0.5);
      let cEnd = Math.ceil((lonExit - west) / dLon - 0.5) - 1;
      if (cStart < 0) cStart = 0;
      if (cEnd > size - 1) cEnd = size - 1;
      for (let c = cStart; c <= cEnd; c++) {
        if (out[rowOffset + c] !== 255) {
          out[rowOffset + c] = 255;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export default LakeWaterClassificationProvider;
