/**
 * A water classification provider augments the terrain provider's per-tile
 * water mask with a supplementary client-side water dataset. Concrete
 * implementations: {@link LakeWaterClassificationProvider} (Natural Earth 1:10m
 * lakes), {@link GlobalCoastlineWaterClassificationProvider} (vector coastline),
 * {@link RiverWaterClassificationProvider} (river centerlines),
 * {@link CompositeWaterClassificationProvider} (combines the others plus the
 * bathymetry prior and user regions) and two experimental tile-streaming
 * providers ({@link PMTilesWaterAndBathymetryProvider},
 * {@link CloudTiledWaterAndBathymetryProvider}).
 *
 * The lake provider composites Natural Earth 1:10m lake polygons (public
 * domain) over the provider mask so large inland lakes — the Great Lakes,
 * Great Salt Lake, Baikal, Victoria and so on — get the animated water-mask
 * effect that Cesium World Terrain's ocean-only mask denies them.
 *
 * Natural Earth classes the Caspian Sea as ocean, so it is absent from the
 * lakes files and `lakeWaterMask` does not add it. The largest bundled bodies
 * are Baikal, the Great Lakes, Great Bear, Great Slave, Winnipeg, Tanganyika,
 * Victoria and Balkhash.
 *
 * The seam is renderer-agnostic by construction: it operates on the CPU-side
 * mask bytes inside the single upload point both backends share
 * (`GlobeSurfaceTile.js` → `createWaterMaskTextureIfNeeded`), so WebGL and
 * WebGPU consume identical texels. It sits behind the opt-in
 * `globe.lakeWaterMask` flag, which defaults off.
 *
 * Providers backed by finer datasets, such as the ~30 m public-domain SRTMSWBD
 * raster, can be added behind the same interface.
 */

import {
  GlobalCoastlineWaterClassificationProvider,
  applyCoastalSignedDistanceField,
  coastalSdfPadTexels,
} from "./GlobalCoastlineWaterClassificationProvider.js";
import {
  getGlobalBundledBathymetryTensor,
  wmtsCoordAtLonLat,
  wmtsTileRectangle,
} from "./BathymetryTensorMap.js";

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
   * provider's mask for the tile rectangle. The input is never mutated,
   * because the provider mask may be shared with, or upsampled into,
   * other tiles. Returns a new combined mask, or `undefined` when the
   * composite would change nothing, in which case the caller keeps the
   * original mask and its fast paths.
   *
   * A 1-byte all-land mask expands to `expandedSize`² when a lake
   * intersects; an N×N provider mask keeps its resolution.
   */
  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined;

  /**
   * Generates a base water mask for a tile that does not possess one
   * (e.g., EllipsoidTerrainProvider or terrain without baked water masks).
   *
   * @param rectangle Geographic tile bounds in radians.
   * @param size Mask dimension (width and height), default 256.
   * @returns Generated 1-byte or size×size mask.
   */
  generateWaterMask?(rectangle: GeographicRectangle, size?: number): Uint8Array;
}

export interface WaterMaskWithHydroData extends Uint8Array {
  _rgbaHydroData?: Uint8Array;
  _hasOceanWater?: boolean;
}

const LAKE_SUBBOX_CHUNK = 32;

interface LakePolygon {
  west: number;
  south: number;
  east: number;
  north: number;
  waterTypeCode: number;
  sqrtMaxDepthQ8: number;
  /** Flattened [lon0, lat0, lon1, lat1, …] radians, closing point removed. */
  rings: Float64Array[];
  ringSubBoxes?: (Float64Array | undefined)[];
}

function buildLakeRingSubBoxes(ring: Float64Array): Float64Array | undefined {
  const vertexCount = ring.length / 2;
  if (vertexCount <= 64) {
    return undefined;
  }
  const numChunks = Math.ceil(vertexCount / LAKE_SUBBOX_CHUNK);
  const rBoxes = new Float64Array(numChunks * 4);
  for (let c = 0; c < numChunks; c++) {
    let bW = Infinity;
    let bS = Infinity;
    let bE = -Infinity;
    let bN = -Infinity;
    const start = c * LAKE_SUBBOX_CHUNK;
    const end = Math.min(vertexCount, start + LAKE_SUBBOX_CHUNK + 1);
    for (let i = start; i < end; i++) {
      const x = ring[i * 2];
      const y = ring[i * 2 + 1];
      if (x < bW) {
        bW = x;
      }
      if (x > bE) {
        bE = x;
      }
      if (y < bS) {
        bS = y;
      }
      if (y > bN) {
        bN = y;
      }
    }
    if (start + LAKE_SUBBOX_CHUNK >= vertexCount && vertexCount > 0) {
      const x0 = ring[0];
      const y0 = ring[1];
      if (x0 < bW) {
        bW = x0;
      }
      if (x0 > bE) {
        bE = x0;
      }
      if (y0 < bS) {
        bS = y0;
      }
      if (y0 > bN) {
        bN = y0;
      }
    }
    const bOff = c * 4;
    rBoxes[bOff] = bW;
    rBoxes[bOff + 1] = bS;
    rBoxes[bOff + 2] = bE;
    rBoxes[bOff + 3] = bN;
  }
  return rBoxes;
}

function getLakeRingSubBoxes(
  poly: LakePolygon,
  rIdx: number,
): Float64Array | undefined {
  return poly.ringSubBoxes?.[rIdx];
}

const MAGIC_LWM1 = 0x314d574c;
const MAGIC_LWM2 = 0x324d574c;
const DEFAULT_EXPANDED_SIZE = 256;

/**
 * LWM2 water-type codes the lake provider skips: 5 (playa) and 8 (widened
 * coral-reef strip). `globe.lakeWaterMask` shipped painting lakes and
 * reservoirs only; the playa and reef polygons joined the asset later, and
 * whether the flag should paint them is an open maintainer ruling (MQ-10).
 * They stay in the asset, which the bathymetry tensor builder reads offline,
 * so lifting this set is the whole change once the ruling allows it.
 */
const LAKE_MASK_EXCLUDED_WATER_TYPES: ReadonlySet<number> = new Set([5, 8]);

const SPATIAL_GRID_COLS = 36;
const SPATIAL_GRID_ROWS = 18;
const MAX_COMPOSITE_TILE_CACHE = 1024;
/**
 * Upper bound on composite cache bytes. An entry is a mask plus its optional
 * rgba hydro data (up to 64 KiB + 256 KiB at 256x256), so the count bound alone
 * would allow about 330 MB.
 */
const MAX_COMPOSITE_TILE_CACHE_BYTES = 64 * 1024 * 1024;

// Padded lake scratch (292 = 256 + 2 * (15 + 1 + 2): the field radius and the
// smoothing radius); grown on first use, never at import.
const PADDED_LAKE_SCRATCH_MAX = 292 * 292;
let _scratchPaddedLakeMask = new Uint8Array(0);
let _scratchPaddedMetaG = new Uint8Array(0);

function ensurePaddedLakeScratch(): void {
  if (_scratchPaddedLakeMask.length === 0) {
    _scratchPaddedLakeMask = new Uint8Array(PADDED_LAKE_SCRATCH_MAX);
    _scratchPaddedMetaG = new Uint8Array(PADDED_LAKE_SCRATCH_MAX);
  }
}

/**
 * Diagnostic: bytes currently held by the module-scope padded lake scratch.
 * Zero until the first padded lake tile is rasterised.
 *
 * @internal
 */
export function getPaddedLakeScratchBytes(): number {
  return _scratchPaddedLakeMask.byteLength + _scratchPaddedMetaG.byteLength;
}

function lonToGridCol(lonRad: number): number {
  const norm = (lonRad + Math.PI) / (2.0 * Math.PI);
  const col = Math.floor(norm * SPATIAL_GRID_COLS);
  return col < 0 ? 0 : col >= SPATIAL_GRID_COLS ? SPATIAL_GRID_COLS - 1 : col;
}

function latToGridRow(latRad: number): number {
  const norm = (latRad + Math.PI * 0.5) / Math.PI;
  const row = Math.floor(norm * SPATIAL_GRID_ROWS);
  return row < 0 ? 0 : row >= SPATIAL_GRID_ROWS ? SPATIAL_GRID_ROWS - 1 : row;
}

class SpatialBoundingGridIndex {
  private _cells: number[][];
  private _seenStamp: Uint32Array;
  private _currentStamp = 0;

  constructor(boundsList: ReadonlyArray<GeographicRectangle>) {
    const cells: number[][] = new Array(SPATIAL_GRID_COLS * SPATIAL_GRID_ROWS);
    for (let i = 0; i < cells.length; i++) {
      cells[i] = [];
    }
    for (let idx = 0; idx < boundsList.length; idx++) {
      const b = boundsList[idx];
      const c0 = lonToGridCol(b.west);
      const c1 = lonToGridCol(b.east);
      const r0 = latToGridRow(b.south);
      const r1 = latToGridRow(b.north);
      for (let r = r0; r <= r1; r++) {
        const rowBase = r * SPATIAL_GRID_COLS;
        for (let c = c0; c <= c1; c++) {
          cells[rowBase + c].push(idx);
        }
      }
    }
    this._cells = cells;
    this._seenStamp = new Uint32Array(boundsList.length);
  }

  query(rect: GeographicRectangle): number[] {
    const c0 = lonToGridCol(rect.west);
    const c1 = lonToGridCol(rect.east);
    const r0 = latToGridRow(rect.south);
    const r1 = latToGridRow(rect.north);
    if (c0 === c1 && r0 === r1) {
      return this._cells[r0 * SPATIAL_GRID_COLS + c0];
    }
    this._currentStamp = (this._currentStamp + 1) >>> 0;
    if (this._currentStamp === 0) {
      this._seenStamp.fill(0);
      this._currentStamp = 1;
    }
    const stamp = this._currentStamp;
    const seen = this._seenStamp;
    const out: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const rowBase = r * SPATIAL_GRID_COLS;
      for (let c = c0; c <= c1; c++) {
        const bucket = this._cells[rowBase + c];
        for (let i = 0; i < bucket.length; i++) {
          const idx = bucket[i];
          if (seen[idx] !== stamp) {
            seen[idx] = stamp;
            out.push(idx);
          }
        }
      }
    }
    return out;
  }
}

/**
 * Lake water classification backed by the packed Natural Earth 1:10m lakes
 * asset (`Assets/WaterMask/ne10mLakes.bin`, produced by
 * `Tools/build-lake-water-mask.mjs`; format documented there).
 *
 * Rasterization is scanline even-odd at water-mask texel centers, in
 * geographic (linear-in-lat/lon) space — matching how the globe shaders
 * map water-mask UVs over a terrain tile's rectangle (row 0 = north,
 * the same orientation the provider masks use; the WebGL shader V-flip
 * and the WebGPU south-origin row reversal both key off that
 * convention, see `WebGPUGlobeSurfaceTextures.getOrCreateWaterMaskTexture`).
 *
 * The playa (type 5) and widened coral-reef (type 8) entries that were
 * added to the asset after the flag shipped are skipped at parse time
 * (`LAKE_MASK_EXCLUDED_WATER_TYPES`), so the flag still paints what it
 * shipped with. Whether it should paint those two types is an open
 * maintainer ruling (MQ-10, fix item DE-13).
 */
export class LakeWaterClassificationProvider implements WaterClassificationProvider {
  private _polygons: LakePolygon[] = [];
  private _spatialGrid?: SpatialBoundingGridIndex;
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
    const magic = view.getUint32(0, true);
    if (magic !== MAGIC_LWM1 && magic !== MAGIC_LWM2) {
      throw new Error(
        "LakeWaterClassificationProvider: not an LWM1/LWM2 lake-mask asset",
      );
    }
    const isLwm2 = magic === MAGIC_LWM2;
    const polygonCount = view.getUint32(4, true);
    let o = 8;
    const polygons: LakePolygon[] = [];
    const coordArena = new Float64Array(Math.ceil(buffer.byteLength / 2));
    let coordOffset = 0;
    for (let p = 0; p < polygonCount; p++) {
      let west: number;
      let south: number;
      let east: number;
      let north: number;
      let waterTypeCode = 1;
      let sqrtMaxDepthQ8 = 45;
      let ringCount: number;
      if (isLwm2) {
        west = view.getFloat32(o, true);
        south = view.getFloat32(o + 4, true);
        east = view.getFloat32(o + 8, true);
        north = view.getFloat32(o + 12, true);
        waterTypeCode = view.getUint8(o + 16);
        sqrtMaxDepthQ8 = view.getUint8(o + 17);
        ringCount = view.getUint16(o + 18, true);
        o += 20;
      } else {
        west = view.getFloat64(o, true);
        south = view.getFloat64(o + 8, true);
        east = view.getFloat64(o + 16, true);
        north = view.getFloat64(o + 24, true);
        o += 32;
        ringCount = view.getUint32(o, true);
        o += 4;
      }
      if (LAKE_MASK_EXCLUDED_WATER_TYPES.has(waterTypeCode)) {
        // Step over the rings without decoding them: an excluded polygon
        // takes no arena space and never reaches the grid or the bounds.
        for (let r = 0; r < ringCount; r++) {
          o += 4 + view.getUint32(o, true) * 4;
        }
        continue;
      }
      const lonSpan = (east - west) / 65535.0;
      const latSpan = (north - south) / 65535.0;
      const rings: Float64Array[] = new Array(ringCount);
      let ringSubBoxes: (Float64Array | undefined)[] | undefined;
      for (let r = 0; r < ringCount; r++) {
        const vertexCount = view.getUint32(o, true);
        o += 4;
        const coordCount = vertexCount * 2;
        const ring = coordArena.subarray(coordOffset, coordOffset + coordCount);
        coordOffset += coordCount;
        for (let i = 0; i < vertexCount; i++) {
          ring[i * 2] = west + view.getUint16(o, true) * lonSpan;
          ring[i * 2 + 1] = south + view.getUint16(o + 2, true) * latSpan;
          o += 4;
        }
        rings[r] = ring;
        if (vertexCount > 64) {
          if (ringSubBoxes === undefined) {
            ringSubBoxes = new Array(ringCount);
          }
          ringSubBoxes[r] = buildLakeRingSubBoxes(ring);
        }
      }
      polygons.push({
        west,
        south,
        east,
        north,
        waterTypeCode,
        sqrtMaxDepthQ8,
        rings,
        ringSubBoxes,
      });
      if (west < this._west) {
        this._west = west;
      }
      if (south < this._south) {
        this._south = south;
      }
      if (east > this._east) {
        this._east = east;
      }
      if (north > this._north) {
        this._north = north;
      }
    }
    this._polygons = polygons;
    this._spatialGrid = new SpatialBoundingGridIndex(polygons);
    this._ready = true;
  }

  get ready(): boolean {
    return this._ready;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (!this._ready || !this._spatialGrid) {
      return false;
    }
    if (
      rectangle.east < this._west ||
      rectangle.west > this._east ||
      rectangle.north < this._south ||
      rectangle.south > this._north
    ) {
      return false;
    }
    const polygons = this._polygons;
    const candidateIndices = this._spatialGrid.query(rectangle);
    for (let i = 0; i < candidateIndices.length; i++) {
      const p = polygons[candidateIndices[i]];
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
    if (!this._ready || !this._spatialGrid) {
      return undefined;
    }
    // 1-byte all-WATER fast path: nothing to add.
    if (providerMask.length === 1 && providerMask[0] !== 0) {
      return undefined;
    }

    const size =
      providerMask.length === 1
        ? (expandedSize ?? DEFAULT_EXPANDED_SIZE)
        : Math.round(Math.sqrt(providerMask.length));
    const dLon = (rectangle.east - rectangle.west) / Math.max(size, 1);
    const dLat = (rectangle.north - rectangle.south) / Math.max(size, 1);
    const tileSpanMeters = Math.max(
      (rectangle.north - rectangle.south) * 6378137.0,
      1.0,
    );
    const texelMeters = tileSpanMeters / Math.max(size, 1);
    const sdfRadius =
      size === DEFAULT_EXPANDED_SIZE
        ? Math.max(8.0, Math.min(15.0, 480.0 / texelMeters))
        : 6.0;
    const pad = coastalSdfPadTexels(sdfRadius, size);
    const paddedSize = size + 2 * pad;
    const paddedRect: GeographicRectangle =
      pad > 0
        ? {
            west: rectangle.west - pad * dLon,
            south: rectangle.south - pad * dLat,
            east: rectangle.east + pad * dLon,
            north: rectangle.north + pad * dLat,
          }
        : rectangle;

    const invDLon = 1.0 / Math.max(dLon, 1e-12);
    const invDLat = 1.0 / Math.max(dLat, 1e-12);
    const candidates: LakePolygon[] = [];
    const polygons = this._polygons;
    const candidateIndices = this._spatialGrid.query(paddedRect);
    for (let i = 0; i < candidateIndices.length; i++) {
      const p = polygons[candidateIndices[i]];
      if (
        paddedRect.east >= p.west &&
        paddedRect.west <= p.east &&
        paddedRect.north >= p.south &&
        paddedRect.south <= p.north &&
        Math.ceil((paddedRect.north - p.north) * invDLat - 0.5) <=
          Math.floor((paddedRect.north - p.south) * invDLat - 0.5) &&
        Math.ceil((p.west - paddedRect.west) * invDLon - 0.5) <
          Math.ceil((p.east - paddedRect.west) * invDLon - 0.5)
      ) {
        candidates.push(p);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }

    const paddedLen = paddedSize * paddedSize;
    const useScratch = pad > 0 && paddedLen <= PADDED_LAKE_SCRATCH_MAX;
    if (useScratch) {
      ensurePaddedLakeScratch();
    }
    const paddedLakeMask = useScratch
      ? _scratchPaddedLakeMask.subarray(0, paddedLen)
      : new Uint8Array(paddedLen);
    const paddedMetaG = useScratch
      ? _scratchPaddedMetaG.subarray(0, paddedLen)
      : new Uint8Array(paddedLen);
    if (pad > 0) {
      paddedLakeMask.fill(0);
      paddedMetaG.fill(0);
    }
    let dominantMetaG = 1 | (3 << 4);

    let changed = false;
    for (const polygon of candidates) {
      const depthNibble = Math.max(
        1,
        Math.min(15, Math.round((polygon.sqrtMaxDepthQ8 ?? 45) / 17)),
      );
      const polyMetaG =
        ((polygon.waterTypeCode ?? 1) & 0x0f) | (depthNibble << 4);
      if (
        rasterizePolygon(
          polygon,
          paddedRect,
          paddedSize,
          paddedLakeMask,
          paddedMetaG,
          polyMetaG,
        )
      ) {
        dominantMetaG = polyMetaG;
        changed = true;
      }
    }
    if (!changed) {
      return undefined;
    }

    if (size >= 32) {
      applyCoastalSignedDistanceField(paddedLakeMask, paddedSize, sdfRadius);
    }

    if (pad > 0) {
      let anyNonZero = false;
      outerScan: for (let r = 0; r < size; r++) {
        const srcRow = (r + pad) * paddedSize + pad;
        for (let c = 0; c < size; c++) {
          if (paddedLakeMask[srcRow + c] !== 0) {
            anyNonZero = true;
            break outerScan;
          }
        }
      }
      if (!anyNonZero) {
        return undefined;
      }
    }

    const out: WaterMaskWithHydroData =
      pad === 0 && providerMask.length === 1
        ? paddedLakeMask
        : new Uint8Array(size * size);
    const prevHydro = (providerMask as WaterMaskWithHydroData)._rgbaHydroData;
    const rgba = new Uint8Array(size * size * 4);
    const hasPrevHydro =
      prevHydro !== undefined && prevHydro.length === size * size * 4;
    const isPureLandBase = providerMask.length === 1 && providerMask[0] === 0;
    out._hasOceanWater = isPureLandBase
      ? false
      : ((providerMask as WaterMaskWithHydroData)._hasOceanWater ?? true);

    if (isPureLandBase && !hasPrevHydro) {
      new Uint32Array(rgba.buffer, rgba.byteOffset, size * size).fill(
        0x7d800000,
      );
      if (pad === 0) {
        for (let i = 0; i < size * size; i++) {
          const lVal = paddedLakeMask[i];
          if (lVal > 0) {
            const o4 = i * 4;
            rgba[o4] = lVal;
            rgba[o4 + 1] = paddedMetaG[i] || dominantMetaG;
          }
        }
      } else {
        for (let r = 0; r < size; r++) {
          const srcRow = (r + pad) * paddedSize + pad;
          const dstRow = r * size;
          for (let c = 0; c < size; c++) {
            const lVal = paddedLakeMask[srcRow + c];
            if (lVal > 0) {
              const i = dstRow + c;
              out[i] = lVal;
              const o4 = i * 4;
              rgba[o4] = lVal;
              rgba[o4 + 1] = paddedMetaG[srcRow + c] || dominantMetaG;
            }
          }
        }
      }
    } else {
      for (let r = 0; r < size; r++) {
        const srcRow = (r + pad) * paddedSize + pad;
        const dstRow = r * size;
        for (let c = 0; c < size; c++) {
          const i = dstRow + c;
          const lVal = paddedLakeMask[srcRow + c];
          const pVal = providerMask.length === 1 ? 0 : providerMask[i];
          const finalSdf = lVal >= pVal ? lVal : pVal;
          out[i] = finalSdf;
          const o4 = i * 4;
          rgba[o4] = finalSdf;
          if (lVal > 0 && lVal >= pVal) {
            const mG = paddedMetaG[srcRow + c] || dominantMetaG;
            rgba[o4 + 1] = mG;
            rgba[o4 + 2] = 128;
            rgba[o4 + 3] = 125;
          } else if (hasPrevHydro) {
            rgba[o4 + 1] = prevHydro[o4 + 1];
            rgba[o4 + 2] = prevHydro[o4 + 2];
            rgba[o4 + 3] = prevHydro[o4 + 3];
          } else {
            rgba[o4 + 1] = 0;
            rgba[o4 + 2] = 128;
            rgba[o4 + 3] = 125;
          }
        }
      }
    }
    out._rgbaHydroData = rgba;
    return out;
  }
}

const _scratchLakeRows: number[][] = [];

function getLakeRowList(r: number): number[] {
  let list = _scratchLakeRows[r];
  if (list === undefined) {
    list = [];
    _scratchLakeRows[r] = list;
  }
  return list;
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
  outMetaG?: Uint8Array,
  polyMetaG: number = 1,
): boolean {
  const west = rectangle.west;
  const north = rectangle.north;
  const south = rectangle.south;
  const dLon = (rectangle.east - rectangle.west) / size;
  const dLat = (rectangle.north - rectangle.south) / size;
  if (!(dLon > 0) || !(dLat > 0)) {
    return false;
  }

  const invDLon = 1.0 / dLon;
  const invDLat = 1.0 / dLat;
  let hasCrossings = false;
  let minRowTouched = size;
  let maxRowTouched = -1;

  const rings = polygon.rings;
  for (let rIdx = 0; rIdx < rings.length; rIdx++) {
    const ring = rings[rIdx];
    const vertexCount = ring.length / 2;
    const rBoxes = getLakeRingSubBoxes(polygon, rIdx);

    if (rBoxes !== undefined) {
      const numChunks = rBoxes.length / 4;
      for (let c = 0; c < numChunks; c++) {
        const bIdx = c * 4;
        const bS = rBoxes[bIdx + 1];
        const bN = rBoxes[bIdx + 3];
        if (bN <= south || bS >= north) {
          continue;
        }
        if (
          Math.ceil((north - bN) * invDLat - 0.5) >
          Math.floor((north - bS) * invDLat - 0.5)
        ) {
          continue;
        }
        const start = c * LAKE_SUBBOX_CHUNK;
        const end = Math.min(vertexCount, start + LAKE_SUBBOX_CHUNK);
        for (let i = start; i < end; i++) {
          const j = i + 1 === vertexCount ? 0 : i + 1;
          const x0 = ring[i * 2];
          const y0 = ring[i * 2 + 1];
          const x1 = ring[j * 2];
          const y1 = ring[j * 2 + 1];
          if (y0 === y1) {
            continue;
          }
          const yLow = y0 < y1 ? y0 : y1;
          const yHigh = y0 > y1 ? y0 : y1;
          if (yHigh <= south || yLow >= north) {
            continue;
          }
          let rStart = Math.ceil((north - yHigh) * invDLat - 0.5);
          let rEnd = Math.floor((north - yLow) * invDLat - 0.5);
          if (rStart > rEnd) {
            continue;
          }
          if (rStart < 0) {
            rStart = 0;
          }
          if (rEnd > size - 1) {
            rEnd = size - 1;
          }
          if (rStart > rEnd) {
            continue;
          }
          const invDy = (x1 - x0) / (y1 - y0);
          for (let r = rStart; r <= rEnd; r++) {
            const lat = north - (r + 0.5) * dLat;
            if ((y0 <= lat && y1 > lat) || (y1 <= lat && y0 > lat)) {
              const lon = x0 + (lat - y0) * invDy;
              getLakeRowList(r).push(lon);
              if (r < minRowTouched) {
                minRowTouched = r;
              }
              if (r > maxRowTouched) {
                maxRowTouched = r;
              }
              hasCrossings = true;
            }
          }
        }
      }
    } else {
      for (let i = 0; i < vertexCount; i++) {
        const j = i + 1 === vertexCount ? 0 : i + 1;
        const x0 = ring[i * 2];
        const y0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const y1 = ring[j * 2 + 1];
        if (y0 === y1) {
          continue;
        }
        const yLow = y0 < y1 ? y0 : y1;
        const yHigh = y0 > y1 ? y0 : y1;
        if (yHigh <= south || yLow >= north) {
          continue;
        }
        // Rows whose center latitude lies within [yLow, yHigh):
        // centerLat(r) = north − (r + 0.5)·dLat.
        let rStart = Math.ceil((north - yHigh) * invDLat - 0.5);
        let rEnd = Math.floor((north - yLow) * invDLat - 0.5);
        if (rStart > rEnd) {
          continue;
        }
        if (rStart < 0) {
          rStart = 0;
        }
        if (rEnd > size - 1) {
          rEnd = size - 1;
        }
        if (rStart > rEnd) {
          continue;
        }
        const invDy = (x1 - x0) / (y1 - y0);
        for (let r = rStart; r <= rEnd; r++) {
          const lat = north - (r + 0.5) * dLat;
          // Half-open crossing rule (even-odd).
          if ((y0 <= lat && y1 > lat) || (y1 <= lat && y0 > lat)) {
            const lon = x0 + (lat - y0) * invDy;
            getLakeRowList(r).push(lon);
            if (r < minRowTouched) {
              minRowTouched = r;
            }
            if (r > maxRowTouched) {
              maxRowTouched = r;
            }
            hasCrossings = true;
          }
        }
      }
    }
  }

  if (!hasCrossings) {
    return false;
  }

  let changed = false;
  for (let r = minRowTouched; r <= maxRowTouched; r++) {
    const crossings = _scratchLakeRows[r];
    if (crossings === undefined) {
      continue;
    }
    const len = crossings.length;
    if (len < 2) {
      crossings.length = 0;
      continue;
    }
    if (len === 2) {
      if (crossings[0] > crossings[1]) {
        const tmp = crossings[0];
        crossings[0] = crossings[1];
        crossings[1] = tmp;
      }
    } else {
      crossings.sort((a, b) => a - b);
    }
    const rowOffset = r * size;
    // Pair up crossings; an odd trailing crossing (degenerate ring) is
    // dropped rather than filling to the tile edge.
    const pairCount = len - (len % 2);
    for (let k = 0; k < pairCount; k += 2) {
      const lonEnter = crossings[k];
      const lonExit = crossings[k + 1];
      // Texel columns whose center lies within [lonEnter, lonExit):
      // centerLon(c) = west + (c + 0.5)·dLon.
      let cStart = Math.ceil((lonEnter - west) * invDLon - 0.5);
      let cEnd = Math.ceil((lonExit - west) * invDLon - 0.5) - 1;
      if (cStart < 0) {
        cStart = 0;
      }
      if (cEnd > size - 1) {
        cEnd = size - 1;
      }
      for (let c = cStart; c <= cEnd; c++) {
        const idx = rowOffset + c;
        if (out[idx] !== 255) {
          out[idx] = 255;
          changed = true;
        }
        if (outMetaG !== undefined) {
          outMetaG[idx] = polyMetaG;
        }
      }
    }
    crossings.length = 0;
  }
  return changed;
}

/**
 * A composite water classification provider that coordinates multiple
 * water datasets (e.g. global ocean coastlines and inland lakes) into a
 * unified water mask without data conflicts or duplication.
 */
function makeCompositeTileCacheKey(
  rect: GeographicRectangle,
  size: number,
): string {
  return `${size}:${rect.west.toFixed(10)}:${rect.south.toFixed(10)}:${rect.east.toFixed(10)}:${rect.north.toFixed(10)}`;
}

function mapWaterTypeStringToCode(waterType: string | undefined): number {
  switch (String(waterType ?? "").toUpperCase()) {
    case "OCEAN":
    case "SEA":
      return 0;
    case "DEEP_GLACIAL_LAKE":
      return 2;
    case "ANCIENT_RIFT_LAKE":
      return 3;
    case "HYPERSALINE_LAKE":
      return 4;
    case "SWAMP":
    case "WETLAND":
    case "BLACKWATER_RIVER":
    case "ESTUARY":
      return 6;
    case "RIVER_AREA":
    case "RIVER_LINE":
      return 9;
    default:
      return 1;
  }
}

export interface BathymetryGridSource {
  width: number;
  height: number;
  bathymetryBytes: Uint8Array;
  west?: number;
  south?: number;
  east?: number;
  north?: number;
}

export interface WaterRegionOverrideItem {
  west: number;
  south: number;
  east: number;
  north: number;
  waterType?: string;
  jerlovType?: number;
  maxDepthMeters?: number;
}

export interface WaterRegionOverrideCollection {
  readonly length?: number;
  /**
   * Monotonically increasing edit counter bumped by add, remove, clear and
   * in-place edits. When present it is the whole cache-invalidation signature.
   */
  readonly version?: number;
  readonly _regions?: WaterRegionOverrideItem[];
  query?(lonRad: number, latRad: number): WaterRegionOverrideItem | undefined;
}

function computeWaterRegionsSignature(
  regions: WaterRegionOverrideCollection | undefined,
): string {
  if (regions === undefined) {
    return "";
  }
  const list = regions._regions;
  const count = Array.isArray(list) ? list.length : 0;
  if (typeof regions.version === "number") {
    return `v${regions.version}:${count}`;
  }
  if (!Array.isArray(list) || count === 0) {
    return "";
  }
  // No version counter: fall back to every region's bounds and attributes, so
  // an edit anywhere in the list (not only the first or last entry) is seen.
  let signature = `${count}`;
  for (let i = 0; i < count; i++) {
    const r = list[i];
    signature += `|${r.west}:${r.south}:${r.east}:${r.north}:${r.waterType ?? ""}:${r.jerlovType ?? ""}:${r.maxDepthMeters ?? ""}`;
  }
  return signature;
}

function cachedMaskBytes(mask: Uint8Array): number {
  return (
    mask.byteLength +
    ((mask as WaterMaskWithHydroData)._rgbaHydroData?.byteLength ?? 0)
  );
}

const _scratchBathyColMap = new Int32Array(256);

export class CompositeWaterClassificationProvider implements WaterClassificationProvider {
  private _providers: WaterClassificationProvider[];
  private _tileCache = new Map<string, Uint8Array>();
  private _tileCacheBytes = 0;
  private _bathymetryTensor?: BathymetryGridSource;
  private _waterRegions?: WaterRegionOverrideCollection;
  private _waterRegionsSignature = "";

  constructor(
    providers: (WaterClassificationProvider | undefined)[],
    options?: {
      bathymetryTensor?: BathymetryGridSource;
      waterRegions?: WaterRegionOverrideCollection;
    },
  ) {
    this._providers = providers.filter(
      (p): p is WaterClassificationProvider => p !== undefined && p !== null,
    );
    this._bathymetryTensor = options?.bathymetryTensor;
    this._waterRegions = options?.waterRegions;
    this._waterRegionsSignature = computeWaterRegionsSignature(
      options?.waterRegions,
    );
  }

  get providers(): WaterClassificationProvider[] {
    return this._providers;
  }

  get bathymetryTensor(): BathymetryGridSource | undefined {
    return this._bathymetryTensor ?? getGlobalBundledBathymetryTensor();
  }

  setBathymetryTensor(tensor: BathymetryGridSource | undefined): void {
    if (this._bathymetryTensor !== tensor) {
      this._bathymetryTensor = tensor;
      this._clearTileCache();
    }
  }

  setWaterRegions(regions: WaterRegionOverrideCollection | undefined): void {
    this._waterRegions = regions;
    this._refreshRegionsSignature();
  }

  private _clearTileCache(): void {
    this._tileCache.clear();
    this._tileCacheBytes = 0;
  }

  /**
   * Re-reads the regions signature and drops the tile cache when it changed.
   * Called on every tile request, so an edit made after `setWaterRegions` is
   * seen by the next tile (O(1) when the collection carries a `version`).
   */
  private _refreshRegionsSignature(): void {
    const nextSig = computeWaterRegionsSignature(this._waterRegions);
    if (this._waterRegionsSignature !== nextSig) {
      this._waterRegionsSignature = nextSig;
      this._clearTileCache();
    }
  }

  private _cacheStore(key: string, mask: Uint8Array): void {
    const bytes = cachedMaskBytes(mask);
    const replaced = this._tileCache.get(key);
    if (replaced !== undefined) {
      this._tileCache.delete(key);
      this._tileCacheBytes -= cachedMaskBytes(replaced);
    }
    while (
      this._tileCache.size > 0 &&
      (this._tileCache.size >= MAX_COMPOSITE_TILE_CACHE ||
        this._tileCacheBytes + bytes > MAX_COMPOSITE_TILE_CACHE_BYTES)
    ) {
      const oldestKey = this._tileCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this._tileCacheBytes -= cachedMaskBytes(this._tileCache.get(oldestKey)!);
      this._tileCache.delete(oldestKey);
    }
    this._tileCache.set(key, mask);
    this._tileCacheBytes += bytes;
  }

  get ready(): boolean {
    return this._providers.length > 0 && this._providers.every((p) => p.ready);
  }

  get cachedTileCount(): number {
    return this._tileCache.size;
  }

  /** Bytes held by the tile cache (masks plus rgba hydro data). */
  get cachedTileBytes(): number {
    return this._tileCacheBytes;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    const regions = this._waterRegions?._regions;
    if (Array.isArray(regions)) {
      for (let i = 0; i < regions.length; i++) {
        const reg = regions[i];
        if (
          rectangle.east >= reg.west &&
          rectangle.west <= reg.east &&
          rectangle.north >= reg.south &&
          rectangle.south <= reg.north
        ) {
          return true;
        }
      }
    }
    for (let i = 0; i < this._providers.length; i++) {
      if (this._providers[i].intersectsRectangle(rectangle)) {
        return true;
      }
    }
    return false;
  }

  private _applyBathymetryAndRegionMetadata(
    mask: Uint8Array,
    rectangle: GeographicRectangle,
    size: number,
  ): Uint8Array {
    const tensor = this.bathymetryTensor;
    const regionsList = this._waterRegions?._regions;
    const overlappingRegions: WaterRegionOverrideItem[] = [];
    if (Array.isArray(regionsList)) {
      for (let i = 0; i < regionsList.length; i++) {
        const reg = regionsList[i];
        if (
          rectangle.east >= reg.west &&
          rectangle.west <= reg.east &&
          rectangle.north >= reg.south &&
          rectangle.south <= reg.north
        ) {
          overlappingRegions.push(reg);
        }
      }
    }

    if (!tensor && overlappingRegions.length === 0) {
      return mask;
    }

    const hydroMask = mask as WaterMaskWithHydroData;

    // 1-byte pure land or pure open-ocean tile with no regional override stays 1-byte
    // so GlobeSurfaceTile takes its all-land path (no texture) or reuses the shared
    // allWaterTexture, without allocating per-tile GPU textures during quadtree zoom traversal.
    if (mask.length === 1 && overlappingRegions.length === 0) {
      return mask;
    }

    // Pure coastline SDF mask with no lakes, coral reefs, rivers, or regional overrides
    // stays 1-channel Uint8Array (4x smaller GPU upload, zero 65,536-texel JS loop).
    if (
      overlappingRegions.length === 0 &&
      hydroMask._rgbaHydroData === undefined
    ) {
      return mask;
    }

    // Expand 1-byte mask if overlapping regions exist
    const actualSize =
      mask.length === 1 ? size : Math.round(Math.sqrt(mask.length));
    // Copy-on-write: `mask` can be a sub-provider's cached tile or the terrain
    // provider's own mask, both shared. Everything below writes into `out` and
    // `rgba`, never into `mask`, and never attaches hydro data to `mask`.
    let out: WaterMaskWithHydroData;
    let prevRgba: Uint8Array | undefined;
    if (mask.length === 1) {
      out = new Uint8Array(actualSize * actualSize);
      if (mask[0] !== 0) {
        out.fill(mask[0]);
      }
    } else {
      out = new Uint8Array(mask);
      out._hasOceanWater = hydroMask._hasOceanWater;
      prevRgba = hydroMask._rgbaHydroData;
    }

    let rgba: Uint8Array;
    if (
      prevRgba !== undefined &&
      prevRgba.length === actualSize * actualSize * 4
    ) {
      rgba = new Uint8Array(prevRgba);
    } else {
      rgba = new Uint8Array(actualSize * actualSize * 4);
      for (let i = 0; i < actualSize * actualSize; i++) {
        const o4 = i * 4;
        rgba[o4] = out[i];
        rgba[o4 + 1] = 0;
        rgba[o4 + 2] = 128;
        rgba[o4 + 3] = 125;
      }
    }
    out._rgbaHydroData = rgba;

    const dLon = (rectangle.east - rectangle.west) / actualSize;
    const dLat = (rectangle.north - rectangle.south) / actualSize;

    // Populate Ocean / Shelf bathymetry on water pixels with hydroTypeCode == 0
    if (
      tensor &&
      !(mask.length === 1 && mask[0] === 0) &&
      out._hasOceanWater !== false
    ) {
      const tw = tensor.width;
      const th = tensor.height;
      const tWest = tensor.west ?? -Math.PI;
      const tEast = tensor.east ?? Math.PI;
      const tSouth = tensor.south ?? -Math.PI * 0.5;
      const tNorth = tensor.north ?? Math.PI * 0.5;
      const tLonSpan = Math.max(tEast - tWest, 1e-9);
      const tLatSpan = Math.max(tNorth - tSouth, 1e-9);
      const tBytes = tensor.bathymetryBytes;
      const colMap =
        actualSize <= _scratchBathyColMap.length
          ? _scratchBathyColMap
          : new Int32Array(actualSize);
      for (let c = 0; c < actualSize; c++) {
        const lon = rectangle.west + (c + 0.5) * dLon;
        colMap[c] = Math.max(
          0,
          Math.min(tw - 1, Math.floor(((lon - tWest) / tLonSpan) * tw)),
        );
      }
      for (let r = 0; r < actualSize; r++) {
        const lat = rectangle.north - (r + 0.5) * dLat;
        const tr = Math.max(
          0,
          Math.min(th - 1, Math.floor(((tNorth - lat) / tLatSpan) * th)),
        );
        const tRowOff = tr * tw;
        const rowOff = r * actualSize;
        for (let c = 0; c < actualSize; c++) {
          const idx = rowOff + c;
          const waterVal = out[idx];
          const o4 = idx * 4;
          rgba[o4] = waterVal;
          if (waterVal > 0 && (rgba[o4 + 1] & 0x0f) === 0) {
            const tIdx = (tRowOff + colMap[c]) * 4;
            const depthByte = tBytes[tIdx];
            const jerlovByte = tBytes[tIdx + 1];
            const substrateType = Math.min(
              3,
              Math.round((tBytes[tIdx + 2] / 255.0) * 4.0),
            );
            const tidalClass = Math.min(
              3,
              Math.round((tBytes[tIdx + 3] / 255.0) * 3.0),
            );
            const upperNibble =
              (substrateType & 0x03) | ((tidalClass & 0x03) << 2);
            rgba[o4 + 1] = (upperNibble << 4) | 0;
            rgba[o4 + 2] = depthByte;
            rgba[o4 + 3] = Math.max(
              1,
              Math.min(249, Math.round((1.0 - jerlovByte / 255.0) * 248) + 1),
            );
          }
        }
      }
    }

    // Apply user-authored WaterRegionCollection spatial overrides
    for (let i = 0; i < overlappingRegions.length; i++) {
      const reg = overlappingRegions[i];
      const code = mapWaterTypeStringToCode(reg.waterType);
      const depthM = reg.maxDepthMeters ?? 45.0;
      const depthNibble = Math.max(
        1,
        Math.min(
          15,
          Math.round(Math.sqrt(Math.max(depthM, 0.0) / 1650.0) * 15),
        ),
      );
      const jerlov = reg.jerlovType ?? 2;
      const clarityByte = Math.max(
        1,
        Math.min(249, Math.round((1.0 - jerlov / 9.0) * 248) + 1),
      );
      const c0 = Math.max(0, Math.floor((reg.west - rectangle.west) / dLon));
      const c1 = Math.min(
        actualSize - 1,
        Math.ceil((reg.east - rectangle.west) / dLon) - 1,
      );
      const r0 = Math.max(0, Math.floor((rectangle.north - reg.north) / dLat));
      const r1 = Math.min(
        actualSize - 1,
        Math.ceil((rectangle.north - reg.south) / dLat) - 1,
      );
      for (let r = r0; r <= r1; r++) {
        const rowOff = r * actualSize;
        for (let c = c0; c <= c1; c++) {
          const idx = rowOff + c;
          if (out[idx] < 128) {
            out[idx] = 255;
          }
          const o4 = idx * 4;
          rgba[o4] = out[idx];
          rgba[o4 + 1] = (code & 0x0f) | (depthNibble << 4);
          rgba[o4 + 2] = Math.round(
            Math.sqrt(Math.min(depthM, 11000.0) / 11000.0) * 255,
          );
          rgba[o4 + 3] = clarityByte;
        }
      }
    }

    return out;
  }

  generateWaterMask(
    rectangle: GeographicRectangle,
    size: number = DEFAULT_EXPANDED_SIZE,
  ): Uint8Array {
    this._refreshRegionsSignature();
    const cacheKey = makeCompositeTileCacheKey(rectangle, size);
    const cached = this._tileCache.get(cacheKey);
    if (cached !== undefined) {
      this._tileCache.delete(cacheKey);
      this._tileCache.set(cacheKey, cached);
      return cached;
    }

    let mask: Uint8Array | undefined;
    let generatorIndex = -1;
    for (let i = 0; i < this._providers.length; i++) {
      const p = this._providers[i];
      if (typeof p.generateWaterMask === "function") {
        mask = p.generateWaterMask(rectangle, size);
        generatorIndex = i;
        break;
      }
    }
    if (!mask) {
      mask = new Uint8Array([0]);
    }

    for (let i = 0; i < this._providers.length; i++) {
      if (i === generatorIndex) {
        continue;
      }
      const p = this._providers[i];
      if (p.intersectsRectangle(rectangle)) {
        const augmented = p.augmentWaterMask(mask, rectangle, size);
        if (augmented) {
          mask = augmented;
        }
      }
    }
    mask = this._applyBathymetryAndRegionMetadata(mask, rectangle, size);
    this._cacheStore(cacheKey, mask);
    return mask;
  }

  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined {
    this._refreshRegionsSignature();
    let currentMask: Uint8Array | Uint8ClampedArray = providerMask;
    let anyChanged = false;
    for (let i = 0; i < this._providers.length; i++) {
      const p = this._providers[i];
      if (p.intersectsRectangle(rectangle)) {
        const augmented = p.augmentWaterMask(
          currentMask,
          rectangle,
          expandedSize,
        );
        if (augmented) {
          currentMask = augmented;
          anyChanged = true;
        }
      }
    }
    const size = expandedSize ?? DEFAULT_EXPANDED_SIZE;
    const withMeta = this._applyBathymetryAndRegionMetadata(
      currentMask as Uint8Array,
      rectangle,
      size,
    );
    if (
      anyChanged ||
      (withMeta as WaterMaskWithHydroData)._rgbaHydroData !== undefined
    ) {
      return withMeta;
    }
    return undefined;
  }
}

interface RiverPolyline {
  west: number;
  south: number;
  east: number;
  north: number;
  baseHalfWidthRad: number;
  strahlerOrder: number;
  /** Flattened [lon0, lat0, hw0, lon1, lat1, hw1, ...] in radians. */
  vertices: Float64Array;
}

const MAGIC_NE1R = 0x5231454e;

/**
 * Water classification provider backed by the packed Natural Earth 1:10m
 * river and delta centerlines asset (`Assets/WaterMask/ne10mRivers.bin`,
 * produced by `Tools/build-global-river-binary.mjs`).
 *
 * Rasterizes variable-width river channels and estuary deltas with
 * sub-texel anti-aliased signed distance falloff so major continental
 * rivers (Amazon, Nile, Yangtze, Mississippi, Ganges, Danube, Rhine, etc.)
 * receive specular sun glint and surface wave animation from orbit down to
 * river level.
 */
export class RiverWaterClassificationProvider implements WaterClassificationProvider {
  private _rivers: RiverPolyline[] = [];
  private _spatialGrid?: SpatialBoundingGridIndex;
  private _ready = false;
  private _west = Infinity;
  private _south = Infinity;
  private _east = -Infinity;
  private _north = -Infinity;

  constructor(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC_NE1R) {
      throw new Error(
        "RiverWaterClassificationProvider: not an NE1R river-mask asset",
      );
    }
    const riverCount = view.getUint32(4, true);
    let o = 8;
    const rivers: RiverPolyline[] = new Array(riverCount);
    const vertArena = new Float64Array(Math.ceil(buffer.byteLength / 2));
    let vertOffset = 0;
    for (let r = 0; r < riverCount; r++) {
      const west = view.getFloat64(o, true);
      const south = view.getFloat64(o + 8, true);
      const east = view.getFloat64(o + 16, true);
      const north = view.getFloat64(o + 24, true);
      o += 32;
      const baseHalfWidthRad = view.getFloat32(o, true);
      o += 4;
      const rawVertexCount = view.getUint32(o, true);
      o += 4;
      const vertexCount = rawVertexCount & 0x0fffffff;
      const strahlerOrder = (rawVertexCount >>> 28) & 0x0f || 6;
      const lonSpan = (east - west) / 65535.0;
      const latSpan = (north - south) / 65535.0;
      const elemCount = vertexCount * 3;
      const vertices = vertArena.subarray(vertOffset, vertOffset + elemCount);
      vertOffset += elemCount;
      for (let i = 0; i < vertexCount; i++) {
        const u = view.getUint16(o, true);
        const v = view.getUint16(o + 2, true);
        const wQ = view.getUint16(o + 4, true);
        o += 6;
        vertices[i * 3] = west + u * lonSpan;
        vertices[i * 3 + 1] = south + v * latSpan;
        vertices[i * 3 + 2] = baseHalfWidthRad * (wQ / 65535.0);
      }
      rivers[r] = {
        west,
        south,
        east,
        north,
        baseHalfWidthRad,
        strahlerOrder,
        vertices,
      };
      if (west < this._west) {
        this._west = west;
      }
      if (south < this._south) {
        this._south = south;
      }
      if (east > this._east) {
        this._east = east;
      }
      if (north > this._north) {
        this._north = north;
      }
    }
    this._rivers = rivers;
    this._spatialGrid = new SpatialBoundingGridIndex(rivers);
    this._ready = true;
  }

  get ready(): boolean {
    return this._ready;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (!this._ready || !this._spatialGrid) {
      return false;
    }
    const tileSpanRad = Math.max(
      rectangle.east - rectangle.west,
      rectangle.north - rectangle.south,
    );
    // Coarse orbital tiles (> 6.8 deg span, Level 0-3) skip polyline river rasterization
    // so sub-texel inland rivers do not inflate into 10-50 km wide canals from space.
    if (tileSpanRad > 0.12) {
      return false;
    }
    if (
      rectangle.east < this._west ||
      rectangle.west > this._east ||
      rectangle.north < this._south ||
      rectangle.south > this._north
    ) {
      return false;
    }
    const minStrahler = tileSpanRad > 0.06 ? 9 : tileSpanRad > 0.025 ? 7 : 0;
    const rivers = this._rivers;
    const candidateIndices = this._spatialGrid.query(rectangle);
    for (let i = 0; i < candidateIndices.length; i++) {
      const r = rivers[candidateIndices[i]];
      if ((r.strahlerOrder ?? 6) < minStrahler) {
        continue;
      }
      if (
        rectangle.east >= r.west &&
        rectangle.west <= r.east &&
        rectangle.north >= r.south &&
        rectangle.south <= r.north
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
    if (!this._ready || !this._spatialGrid) {
      return undefined;
    }
    if (providerMask.length === 1 && providerMask[0] === 255) {
      return undefined;
    }
    const tileSpanRad = Math.max(
      rectangle.east - rectangle.west,
      rectangle.north - rectangle.south,
    );
    if (tileSpanRad > 0.12) {
      return undefined;
    }
    const minStrahler = tileSpanRad > 0.06 ? 9 : tileSpanRad > 0.025 ? 7 : 0;

    const candidates: RiverPolyline[] = [];
    const rivers = this._rivers;
    const candidateIndices = this._spatialGrid.query(rectangle);
    for (let i = 0; i < candidateIndices.length; i++) {
      const r = rivers[candidateIndices[i]];
      if ((r.strahlerOrder ?? 6) < minStrahler) {
        continue;
      }
      if (
        rectangle.east >= r.west &&
        rectangle.west <= r.east &&
        rectangle.north >= r.south &&
        rectangle.south <= r.north
      ) {
        candidates.push(r);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }

    const size =
      providerMask.length === 1
        ? (expandedSize ?? DEFAULT_EXPANDED_SIZE)
        : Math.round(Math.sqrt(providerMask.length));
    const out: WaterMaskWithHydroData = new Uint8Array(size * size);
    if (providerMask.length === 1) {
      if (providerMask[0] !== 0) {
        out.fill(providerMask[0]);
      }
    } else {
      out.set(providerMask);
    }

    const isPureLandBase = providerMask.length === 1 && providerMask[0] === 0;
    const prevHydro = (providerMask as WaterMaskWithHydroData)._rgbaHydroData;
    const rgba = new Uint8Array(size * size * 4);
    if (prevHydro !== undefined && prevHydro.length === size * size * 4) {
      rgba.set(prevHydro);
    } else if (isPureLandBase) {
      new Uint32Array(rgba.buffer, rgba.byteOffset, size * size).fill(
        0x7d800900,
      );
    } else {
      for (let i = 0; i < size * size; i++) {
        const o4 = i * 4;
        rgba[o4] = out[i];
        rgba[o4 + 1] = 0;
        rgba[o4 + 2] = 128;
        rgba[o4 + 3] = 125;
      }
    }

    let changed = false;
    for (let i = 0; i < candidates.length; i++) {
      if (rasterizeRiverPolyline(candidates[i], rectangle, size, out, rgba)) {
        changed = true;
      }
    }
    if (!changed) {
      return undefined;
    }
    out._hasOceanWater = isPureLandBase
      ? false
      : ((providerMask as WaterMaskWithHydroData)._hasOceanWater ?? true);
    out._rgbaHydroData = rgba;
    return out;
  }
}

function rasterizeRiverPolyline(
  river: RiverPolyline,
  rectangle: GeographicRectangle,
  size: number,
  out: Uint8Array,
  rgba?: Uint8Array,
): boolean {
  const west = rectangle.west;
  const north = rectangle.north;
  const dLon = (rectangle.east - rectangle.west) / size;
  const dLat = (rectangle.north - rectangle.south) / size;
  if (!(dLon > 0) || !(dLat > 0)) {
    return false;
  }

  const midLat = (rectangle.south + rectangle.north) * 0.5;
  const cosLat = Math.max(Math.cos(midLat), 0.05);
  const invCosLat = 1.0 / cosLat;
  const texelRad = Math.hypot(dLon * cosLat, dLat);
  const aaBandRad = Math.max(texelRad * 0.85, 1e-6);
  const tileSpanRad = Math.max(
    rectangle.east - rectangle.west,
    rectangle.north - rectangle.south,
  );
  const isCoarseTile = tileSpanRad > 0.04;

  const verts = river.vertices;
  const count = verts.length / 3;
  const riverMetaG = 9 | (((river.strahlerOrder ?? 6) & 0x0f) << 4);
  let changed = false;

  for (let i = 0; i < count - 1; i++) {
    const lon0 = verts[i * 3];
    const lat0 = verts[i * 3 + 1];
    const hw0 = verts[i * 3 + 2];
    const lon1 = verts[(i + 1) * 3];
    const lat1 = verts[(i + 1) * 3 + 1];
    const hw1 = verts[(i + 1) * 3 + 2];

    const maxHw = Math.max(hw0, hw1) + aaBandRad;
    const padLon = maxHw * invCosLat;
    const segWest = Math.min(lon0, lon1) - padLon;
    const segEast = Math.max(lon0, lon1) + padLon;
    const segSouth = Math.min(lat0, lat1) - maxHw;
    const segNorth = Math.max(lat0, lat1) + maxHw;

    if (
      segEast < rectangle.west ||
      segWest > rectangle.east ||
      segNorth < rectangle.south ||
      segSouth > rectangle.north
    ) {
      continue;
    }

    let cStart = Math.floor((segWest - west) / dLon);
    let cEnd = Math.ceil((segEast - west) / dLon);
    let rStart = Math.floor((north - segNorth) / dLat);
    let rEnd = Math.ceil((north - segSouth) / dLat);
    if (cStart < 0) {
      cStart = 0;
    }
    if (cEnd > size - 1) {
      cEnd = size - 1;
    }
    if (rStart < 0) {
      rStart = 0;
    }
    if (rEnd > size - 1) {
      rEnd = size - 1;
    }

    const dx = (lon1 - lon0) * cosLat;
    const dy = lat1 - lat0;
    const segLenSq = dx * dx + dy * dy;
    const segLen = Math.sqrt(Math.max(segLenSq, 1e-24));
    const tx = dx / segLen;
    const ty = dy / segLen;
    const txByte = Math.max(
      0,
      Math.min(255, Math.round((tx * 0.5 + 0.5) * 255)),
    );
    const tyByte = Math.max(
      1,
      Math.min(249, Math.round((ty * 0.5 + 0.5) * 248) + 1),
    );

    for (let r = rStart; r <= rEnd; r++) {
      const lat = north - (r + 0.5) * dLat;
      const py = lat - lat0;
      const rowOffset = r * size;
      for (let c = cStart; c <= cEnd; c++) {
        const idx = rowOffset + c;
        if (out[idx] === 255) {
          continue;
        }
        const lon = west + (c + 0.5) * dLon;
        const px = (lon - lon0) * cosLat;
        let t = 0.0;
        if (segLenSq > 1e-18) {
          t = Math.max(0.0, Math.min(1.0, (px * dx + py * dy) / segLenSq));
        }
        const projX = dx * t;
        const projY = dy * t;
        const distRad = Math.hypot(px - projX, py - projY);
        const rawHw = hw0 + (hw1 - hw0) * t;
        const localHw = Math.max(
          rawHw,
          texelRad * (isCoarseTile ? 0.28 : 0.45),
        );
        if (distRad < localHw + aaBandRad) {
          const subPixelAtten = isCoarseTile
            ? Math.min(1.0, (rawHw / Math.max(texelRad * 0.35, 1e-7)) * 0.72)
            : 1.0;
          const coverage =
            Math.max(
              0.0,
              Math.min(1.0, 0.5 + (localHw - distRad) / (2.0 * aaBandRad)),
            ) * subPixelAtten;
          const byteVal = Math.round(coverage * 255);
          if (byteVal > out[idx]) {
            out[idx] = byteVal;
            if (rgba !== undefined) {
              const o4 = idx * 4;
              rgba[o4] = byteVal;
              rgba[o4 + 1] = riverMetaG;
              rgba[o4 + 2] = txByte;
              rgba[o4 + 3] = tyByte;
            }
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

export interface PMTilesHydrographyTileEntry {
  level: number;
  x: number;
  y: number;
  size: number;
  rectangle: GeographicRectangle;
  mask: Uint8Array;
  rgbaHydroData: Uint8Array;
  upsampledFromParent: boolean;
}

/**
 * On-demand quadtree streaming provider (`Z8–Z14`) for high-resolution hydrography
 * and bathymetry tiles (`.pmtiles` / HTTP Range / tile URL templates), with bounded
 * LRU caching, asynchronous tile prefetching, and automatic parent-tile CLOD upsampling.
 *
 * @experimental No runtime consumer yet: `Globe` never constructs it, and no
 * hosted PMTiles hydrography archive exists. Only specs exercise it. It is
 * scaffolding; the API may change or move out of the barrel.
 */
export class PMTilesWaterAndBathymetryProvider implements WaterClassificationProvider {
  private _tileSize: number;
  private _maxCachedTiles: number;
  private _minStreamingLevel: number;
  private _maxStreamingLevel: number;
  private _tileCache = new Map<string, PMTilesHydrographyTileEntry>();
  private _tileFetcher?: (
    level: number,
    x: number,
    y: number,
    rectangle: GeographicRectangle,
  ) =>
    | Promise<Uint8Array | ArrayBuffer | undefined>
    | Uint8Array
    | ArrayBuffer
    | undefined;
  private _fallbackProvider?: WaterClassificationProvider;
  private _ready = true;

  constructor(options?: {
    tileSize?: number;
    maxCachedTiles?: number;
    minStreamingLevel?: number;
    maxStreamingLevel?: number;
    fallbackProvider?: WaterClassificationProvider;
    tileFetcher?: (
      level: number,
      x: number,
      y: number,
      rectangle: GeographicRectangle,
    ) =>
      | Promise<Uint8Array | ArrayBuffer | undefined>
      | Uint8Array
      | ArrayBuffer
      | undefined;
  }) {
    this._tileSize = Math.max(16, Math.min(256, options?.tileSize ?? 64));
    this._maxCachedTiles = Math.max(8, options?.maxCachedTiles ?? 128);
    this._minStreamingLevel = options?.minStreamingLevel ?? 8;
    this._maxStreamingLevel = options?.maxStreamingLevel ?? 14;
    this._fallbackProvider = options?.fallbackProvider;
    this._tileFetcher = options?.tileFetcher;
  }

  get ready(): boolean {
    return this._ready && (this._fallbackProvider?.ready ?? true);
  }

  get cachedTileCount(): number {
    return this._tileCache.size;
  }

  get minStreamingLevel(): number {
    return this._minStreamingLevel;
  }

  get maxStreamingLevel(): number {
    return this._maxStreamingLevel;
  }

  private _cacheSet(
    key: string,
    entry: PMTilesHydrographyTileEntry,
  ): PMTilesHydrographyTileEntry {
    if (this._tileCache.size >= this._maxCachedTiles) {
      const oldest = this._tileCache.keys().next().value;
      if (oldest !== undefined) {
        this._tileCache.delete(oldest);
      }
    }
    this._tileCache.set(key, entry);
    return entry;
  }

  /**
   * Registers a decoded quadtree tile `(level, x, y)` into the LRU cache.
   */
  putTile(
    level: number,
    x: number,
    y: number,
    rgbaOrLwmBytes: Uint8Array | ArrayBuffer,
  ): PMTilesHydrographyTileEntry {
    const rect = wmtsTileRectangle(x, y, level);
    const size = this._tileSize;
    const raw =
      rgbaOrLwmBytes instanceof Uint8Array
        ? rgbaOrLwmBytes
        : new Uint8Array(rgbaOrLwmBytes);

    let mask: WaterMaskWithHydroData;
    let rgbaHydroData: Uint8Array;

    if (raw.byteLength === size * size * 4) {
      mask = new Uint8Array(size * size);
      rgbaHydroData = new Uint8Array(raw);
      for (let i = 0; i < size * size; i++) {
        mask[i] = rgbaHydroData[i * 4];
        if (rgbaHydroData[i * 4 + 3] === 0 || rgbaHydroData[i * 4 + 3] >= 250) {
          rgbaHydroData[i * 4 + 3] = 125;
        }
      }
      mask._rgbaHydroData = rgbaHydroData;
    } else {
      const buf = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      const subProvider = new LakeWaterClassificationProvider(
        buf as ArrayBuffer,
      );
      const augmented =
        subProvider.augmentWaterMask(new Uint8Array([0]), rect, size) ??
        new Uint8Array(size * size);
      mask = augmented as WaterMaskWithHydroData;
      rgbaHydroData = mask._rgbaHydroData ?? new Uint8Array(size * size * 4);
      mask._rgbaHydroData = rgbaHydroData;
    }

    const entry: PMTilesHydrographyTileEntry = {
      level,
      x,
      y,
      size,
      rectangle: rect,
      mask,
      rgbaHydroData,
      upsampledFromParent: false,
    };
    return this._cacheSet(`L${level}_X${x}_Y${y}`, entry);
  }

  /**
   * Asynchronously prefetches a quadtree tile `(level, x, y)` into the LRU cache.
   */
  async prefetchTile(
    x: number,
    y: number,
    level: number,
  ): Promise<PMTilesHydrographyTileEntry | undefined> {
    const key = `L${level}_X${x}_Y${y}`;
    const hit = this._tileCache.get(key);
    if (hit !== undefined) {
      this._tileCache.delete(key);
      this._tileCache.set(key, hit);
      return hit;
    }
    if (!this._tileFetcher) {
      return undefined;
    }
    const rect = wmtsTileRectangle(x, y, level);
    const payload = await this._tileFetcher(level, x, y, rect);
    if (!payload) {
      return undefined;
    }
    return this.putTile(level, x, y, payload);
  }

  /**
   * Bilinearly upsamples a cached ancestor tile into child `(childLevel, childX, childY)`.
   */
  upsampleParentTile(
    parent: PMTilesHydrographyTileEntry,
    childX: number,
    childY: number,
    childLevel: number,
  ): PMTilesHydrographyTileEntry {
    const levelDelta = Math.max(0, childLevel - parent.level);
    const scale = 1.0 / Math.pow(2, levelDelta);
    const localX = childX - (parent.x << levelDelta);
    const localY = childY - (parent.y << levelDelta);
    const uOffset = Math.max(0.0, Math.min(1.0 - scale, localX * scale));
    const vOffset = Math.max(0.0, Math.min(1.0 - scale, localY * scale));

    const size = parent.size;
    const srcRgba = parent.rgbaHydroData;
    const dstMask: WaterMaskWithHydroData = new Uint8Array(size * size);
    const dstRgba = new Uint8Array(size * size * 4);

    for (let r = 0; r < size; r++) {
      const v = vOffset + ((r + 0.5) / size) * scale;
      const fy = Math.max(0.0, Math.min(size - 1.0, v * size - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(y0 + 1, size - 1);
      const wy = fy - y0;
      for (let c = 0; c < size; c++) {
        const u = uOffset + ((c + 0.5) / size) * scale;
        const fx = Math.max(0.0, Math.min(size - 1.0, u * size - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(x0 + 1, size - 1);
        const wx = fx - x0;

        const i00 = (y0 * size + x0) * 4;
        const i10 = (y0 * size + x1) * 4;
        const i01 = (y1 * size + x0) * 4;
        const i11 = (y1 * size + x1) * 4;
        const idx = r * size + c;
        const o4 = idx * 4;

        const sdfTop = srcRgba[i00] * (1.0 - wx) + srcRgba[i10] * wx;
        const sdfBot = srcRgba[i01] * (1.0 - wx) + srcRgba[i11] * wx;
        const sdf = Math.round(sdfTop * (1.0 - wy) + sdfBot * wy);
        dstMask[idx] = sdf;
        dstRgba[o4] = sdf;
        dstRgba[o4 + 1] = srcRgba[i00 + 1];
        dstRgba[o4 + 2] = Math.round(
          (srcRgba[i00 + 2] * (1.0 - wx) + srcRgba[i10 + 2] * wx) * (1.0 - wy) +
            (srcRgba[i01 + 2] * (1.0 - wx) + srcRgba[i11 + 2] * wx) * wy,
        );
        dstRgba[o4 + 3] = Math.max(
          1,
          Math.min(
            249,
            Math.round(
              (srcRgba[i00 + 3] * (1.0 - wx) + srcRgba[i10 + 3] * wx) *
                (1.0 - wy) +
                (srcRgba[i01 + 3] * (1.0 - wx) + srcRgba[i11 + 3] * wx) * wy,
            ),
          ),
        );
      }
    }
    dstMask._rgbaHydroData = dstRgba;
    return {
      level: childLevel,
      x: childX,
      y: childY,
      size,
      rectangle: wmtsTileRectangle(childX, childY, childLevel),
      mask: dstMask,
      rgbaHydroData: dstRgba,
      upsampledFromParent: true,
    };
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (this._tileCache.size > 0) {
      return true;
    }
    return this._fallbackProvider?.intersectsRectangle(rectangle) ?? true;
  }

  generateWaterMask(
    rectangle: GeographicRectangle,
    size: number = DEFAULT_EXPANDED_SIZE,
  ): Uint8Array {
    const midLon = (rectangle.west + rectangle.east) * 0.5;
    const midLat = (rectangle.south + rectangle.north) * 0.5;
    const latSpan = Math.max(rectangle.north - rectangle.south, 1e-9);
    const estLevel = Math.max(
      0,
      Math.min(
        this._maxStreamingLevel,
        Math.round(Math.log2(Math.PI / latSpan)),
      ),
    );
    const coord = wmtsCoordAtLonLat(midLon, midLat, estLevel);
    const exactKey = `L${coord.level}_X${coord.x}_Y${coord.y}`;
    const exactHit = this._tileCache.get(exactKey);
    if (exactHit !== undefined) {
      this._tileCache.delete(exactKey);
      this._tileCache.set(exactKey, exactHit);
      return exactHit.mask;
    }

    // Walk ancestor quadtree levels for immediate CLOD upsampling while child streams
    for (let pLevel = coord.level - 1; pLevel >= 0; pLevel--) {
      const shift = coord.level - pLevel;
      const px = coord.x >> shift;
      const py = coord.y >> shift;
      const parentHit = this._tileCache.get(`L${pLevel}_X${px}_Y${py}`);
      if (parentHit !== undefined) {
        if (this._tileFetcher && coord.level >= this._minStreamingLevel) {
          void this.prefetchTile(coord.x, coord.y, coord.level);
        }
        return this.upsampleParentTile(parentHit, coord.x, coord.y, coord.level)
          .mask;
      }
    }

    if (this._tileFetcher && coord.level >= this._minStreamingLevel) {
      void this.prefetchTile(coord.x, coord.y, coord.level);
    }
    if (this._fallbackProvider?.generateWaterMask) {
      return this._fallbackProvider.generateWaterMask(rectangle, size);
    }
    return new Uint8Array([255]);
  }

  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined {
    const generated = this.generateWaterMask(
      rectangle,
      expandedSize ?? this._tileSize,
    );
    if (
      generated.length > 1 ||
      (generated as WaterMaskWithHydroData)._rgbaHydroData !== undefined
    ) {
      return generated;
    }
    return this._fallbackProvider?.augmentWaterMask(
      providerMask,
      rectangle,
      expandedSize,
    );
  }
}

/** Magic header (`0x31545743` = `"CWT1"`) for `Assets/WaterMask/globalHydrographyTileArchive.bin`. */
export const MAGIC_CWT1 = 0x31545743;

export interface CWT1DirectoryEntry {
  col: number;
  row: number;
  offset: number;
  length: number;
  flags: number;
  featureCount: number;
}

export interface DecodedCWT1Cell {
  col: number;
  row: number;
  byteLength: number;
  composite: CompositeWaterClassificationProvider;
}

/**
 * Cloud-Optimized Per-Tile Hydrography & Bathymetry Streaming Provider (`CWT1` Spatial Range Archive).
 *
 * Parses a compact `10.1 KiB` (`36 x 18`) root spatial directory and streams or slices
 * self-contained `10 deg x 10 deg` hydrography + `0.5 deg` bathymetry cell chunks on demand
 * via HTTP `Range` byte requests (`rangeFetcher(offset, length)`) or zero-copy `ArrayBuffer`
 * slicing, with per-frame synchronous rasterization budgeting so fast camera motion never stalls
 * the main render thread.
 *
 * @experimental No runtime consumer yet: `Globe` never constructs it, and the
 * `globalHydrographyTileArchive.bin` it reads is not wired to any flag. Only
 * specs exercise it. It is scaffolding for a tiled hydrography stream.
 */
export class CloudTiledWaterAndBathymetryProvider implements WaterClassificationProvider {
  private _gridCols = 36;
  private _gridRows = 18;
  private _directory: CWT1DirectoryEntry[] = [];
  private _archiveBuffer?: ArrayBuffer;
  private _rangeFetcher?: (
    offset: number,
    length: number,
  ) => Promise<ArrayBuffer | Uint8Array>;
  private _decodedCells = new Map<number, DecodedCWT1Cell>();
  private _inFlightCells = new Map<
    number,
    Promise<DecodedCWT1Cell | undefined>
  >();
  private _tileCache = new Map<string, Uint8Array>();
  private _maxCachedCells: number;
  private _maxCachedTiles: number;
  private _frameBudgetEnabled: boolean;
  private _maxTilesPerFrame: number;
  private _frameTileCount = 0;
  private _waterRegions?: WaterRegionOverrideCollection;
  private _bytesStreamed = 0;

  constructor(options?: {
    directoryOrArchiveBuffer?: ArrayBuffer;
    rangeFetcher?: (
      offset: number,
      length: number,
    ) => Promise<ArrayBuffer | Uint8Array>;
    maxCachedCells?: number;
    maxCachedTiles?: number;
    frameBudgetEnabled?: boolean;
    maxTilesPerFrame?: number;
    waterRegions?: WaterRegionOverrideCollection;
  }) {
    this._maxCachedCells = Math.max(8, options?.maxCachedCells ?? 64);
    this._maxCachedTiles = Math.max(16, options?.maxCachedTiles ?? 256);
    this._frameBudgetEnabled = options?.frameBudgetEnabled ?? false;
    this._maxTilesPerFrame = Math.max(1, options?.maxTilesPerFrame ?? 12);
    this._rangeFetcher = options?.rangeFetcher;
    this._waterRegions = options?.waterRegions;
    if (options?.directoryOrArchiveBuffer) {
      this.loadDirectory(options.directoryOrArchiveBuffer);
    }
  }

  /**
   * Loads the `CWT1` root spatial directory (10,384 bytes) or a full `CWT1` archive buffer.
   */
  loadDirectory(buffer: ArrayBuffer): void {
    if (buffer.byteLength < 16) {
      throw new Error("CloudTiledWaterAndBathymetryProvider: buffer < 16B");
    }
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== MAGIC_CWT1) {
      throw new Error(
        `CloudTiledWaterAndBathymetryProvider: invalid magic 0x${magic.toString(16)}`,
      );
    }
    const cols = view.getUint16(4, true);
    const rows = view.getUint16(6, true);
    const dirOffset = view.getUint32(8, true);
    const totalCells = view.getUint32(12, true);
    if (
      cols === 0 ||
      rows === 0 ||
      totalCells === 0 ||
      totalCells > cols * rows
    ) {
      throw new Error(
        `CloudTiledWaterAndBathymetryProvider: invalid directory header (cols=${cols}, rows=${rows}, totalCells=${totalCells})`,
      );
    }
    const requiredDirEnd = dirOffset + totalCells * 16;
    if (buffer.byteLength < requiredDirEnd) {
      throw new Error(
        `CloudTiledWaterAndBathymetryProvider: directory truncated (${buffer.byteLength} < ${requiredDirEnd})`,
      );
    }
    this._gridCols = cols;
    this._gridRows = rows;
    this._directory = new Array(totalCells);
    let maxEndOffset = requiredDirEnd;
    for (let i = 0; i < totalCells; i++) {
      const dOff = dirOffset + i * 16;
      const offset = view.getUint32(dOff, true);
      const length = view.getUint32(dOff + 4, true);
      const flags = view.getUint32(dOff + 8, true);
      const featureCount = view.getUint32(dOff + 12, true);
      this._directory[i] = {
        col: i % cols,
        row: Math.floor(i / cols),
        offset,
        length,
        flags,
        featureCount,
      };
      if (offset + length > maxEndOffset) {
        maxEndOffset = offset + length;
      }
    }
    this._bytesStreamed += requiredDirEnd;
    if (buffer.byteLength >= maxEndOffset) {
      this._archiveBuffer = buffer;
    }
  }

  get ready(): boolean {
    return this._directory.length > 0;
  }

  get gridCols(): number {
    return this._gridCols;
  }

  get gridRows(): number {
    return this._gridRows;
  }

  get decodedCellCount(): number {
    return this._decodedCells.size;
  }

  get cachedTileCount(): number {
    return this._tileCache.size;
  }

  get bytesStreamed(): number {
    return this._bytesStreamed;
  }

  get frameBudgetEnabled(): boolean {
    return this._frameBudgetEnabled;
  }

  set frameBudgetEnabled(v: boolean) {
    this._frameBudgetEnabled = v === true;
  }

  /**
   * Resets the per-frame synchronous tile rasterization counter at the start of a frame.
   */
  beginFrameBudget(maxTilesPerFrame?: number): void {
    this._frameTileCount = 0;
    if (maxTilesPerFrame !== undefined && maxTilesPerFrame > 0) {
      this._maxTilesPerFrame = maxTilesPerFrame;
    }
  }

  setWaterRegions(regions: WaterRegionOverrideCollection | undefined): void {
    const prevSig = computeWaterRegionsSignature(this._waterRegions);
    const nextSig = computeWaterRegionsSignature(regions);
    this._waterRegions = regions;
    if (prevSig === nextSig) {
      return;
    }
    for (const cell of this._decodedCells.values()) {
      cell.composite.setWaterRegions(regions);
    }
    this._tileCache.clear();
  }

  /**
   * Resolves a cartographic `(lonRad, latRad)` to its `(col, row, cellIndex)` in the `CWT1` directory.
   */
  lonLatToCellCoord(
    lonRad: number,
    latRad: number,
  ): { col: number; row: number; cellIndex: number } {
    const col = Math.max(
      0,
      Math.min(
        this._gridCols - 1,
        Math.floor(((lonRad + Math.PI) / (2.0 * Math.PI)) * this._gridCols),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        this._gridRows - 1,
        Math.floor(((Math.PI * 0.5 - latRad) / Math.PI) * this._gridRows),
      ),
    );
    return { col, row, cellIndex: row * this._gridCols + col };
  }

  private _decodeCellPayload(
    col: number,
    row: number,
    cellBytes: Uint8Array,
  ): DecodedCWT1Cell {
    const cellIdx = row * this._gridCols + col;
    const view = new DataView(
      cellBytes.buffer,
      cellBytes.byteOffset,
      cellBytes.byteLength,
    );
    const coastLen = view.getUint32(0, true);
    const lakeLen = view.getUint32(4, true);
    const riverLen = view.getUint32(8, true);
    const bathyLen = view.getUint32(12, true);

    let pOff = 16;
    const providers: WaterClassificationProvider[] = [];

    if (coastLen > 0) {
      const coastSlice = cellBytes.buffer.slice(
        cellBytes.byteOffset + pOff,
        cellBytes.byteOffset + pOff + coastLen,
      ) as ArrayBuffer;
      providers.push(
        new GlobalCoastlineWaterClassificationProvider(coastSlice),
      );
      pOff += coastLen;
    }
    if (lakeLen > 0) {
      const lakeSlice = cellBytes.buffer.slice(
        cellBytes.byteOffset + pOff,
        cellBytes.byteOffset + pOff + lakeLen,
      ) as ArrayBuffer;
      providers.push(new LakeWaterClassificationProvider(lakeSlice));
      pOff += lakeLen;
    }
    if (riverLen > 0) {
      const riverSlice = cellBytes.buffer.slice(
        cellBytes.byteOffset + pOff,
        cellBytes.byteOffset + pOff + riverLen,
      ) as ArrayBuffer;
      providers.push(new RiverWaterClassificationProvider(riverSlice));
      pOff += riverLen;
    }

    let bathySource: BathymetryGridSource | undefined;
    if (bathyLen >= 12) {
      const bView = new DataView(
        cellBytes.buffer,
        cellBytes.byteOffset + pOff,
        bathyLen,
      );
      const bw = bView.getUint16(4, true);
      const bh = bView.getUint16(6, true);
      const dLon = (2.0 * Math.PI) / this._gridCols;
      const dLat = Math.PI / this._gridRows;
      const west = -Math.PI + col * dLon;
      const east = west + dLon;
      const north = Math.PI * 0.5 - row * dLat;
      const south = north - dLat;
      bathySource = {
        width: bw,
        height: bh,
        bathymetryBytes: new Uint8Array(
          cellBytes.buffer,
          cellBytes.byteOffset + pOff + 12,
          bw * bh * 4,
        ),
        west,
        south,
        east,
        north,
      };
    }

    const composite = new CompositeWaterClassificationProvider(providers, {
      bathymetryTensor: bathySource,
      waterRegions: this._waterRegions,
    });

    const decoded: DecodedCWT1Cell = {
      col,
      row,
      byteLength: cellBytes.byteLength,
      composite,
    };

    if (this._decodedCells.size >= this._maxCachedCells) {
      const oldest = this._decodedCells.keys().next().value;
      if (oldest !== undefined) {
        this._decodedCells.delete(oldest);
      }
    }
    this._decodedCells.set(cellIdx, decoded);
    this._bytesStreamed += cellBytes.byteLength;
    return decoded;
  }

  /**
   * Asynchronously fetches and decodes a single `10 deg x 10 deg` spatial cell via HTTP `Range` byte slicing.
   */
  async prefetchCell(
    col: number,
    row: number,
  ): Promise<DecodedCWT1Cell | undefined> {
    if (!this.ready) {
      return undefined;
    }
    const cellIdx = row * this._gridCols + col;
    const cached = this._decodedCells.get(cellIdx);
    if (cached !== undefined) {
      this._decodedCells.delete(cellIdx);
      this._decodedCells.set(cellIdx, cached);
      return cached;
    }
    const entry = this._directory[cellIdx];
    if (!entry) {
      return undefined;
    }

    if (this._archiveBuffer) {
      const slice = new Uint8Array(
        this._archiveBuffer,
        entry.offset,
        entry.length,
      );
      return this._decodeCellPayload(col, row, slice);
    }

    if (!this._rangeFetcher) {
      return undefined;
    }
    let inFlight = this._inFlightCells.get(cellIdx);
    if (!inFlight) {
      inFlight = this._rangeFetcher(entry.offset, entry.length)
        .then((bufOrBytes) => {
          this._inFlightCells.delete(cellIdx);
          const bytes =
            bufOrBytes instanceof Uint8Array
              ? bufOrBytes
              : new Uint8Array(bufOrBytes);
          return this._decodeCellPayload(col, row, bytes);
        })
        .catch((): DecodedCWT1Cell | undefined => {
          this._inFlightCells.delete(cellIdx);
          return undefined;
        });
      this._inFlightCells.set(cellIdx, inFlight);
    }
    return inFlight;
  }

  private _getOrDecodeCellSync(
    col: number,
    row: number,
  ): DecodedCWT1Cell | undefined {
    const cellIdx = row * this._gridCols + col;
    const cached = this._decodedCells.get(cellIdx);
    if (cached !== undefined) {
      this._decodedCells.delete(cellIdx);
      this._decodedCells.set(cellIdx, cached);
      return cached;
    }
    const entry = this._directory[cellIdx];
    if (!entry) {
      return undefined;
    }
    if (this._archiveBuffer) {
      const slice = new Uint8Array(
        this._archiveBuffer,
        entry.offset,
        entry.length,
      );
      return this._decodeCellPayload(col, row, slice);
    }
    if (this._rangeFetcher) {
      void this.prefetchCell(col, row);
    }
    return undefined;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (!this.ready) {
      return false;
    }
    const midLon = (rectangle.west + rectangle.east) * 0.5;
    const midLat = (rectangle.south + rectangle.north) * 0.5;
    const { cellIndex } = this.lonLatToCellCoord(midLon, midLat);
    const entry = this._directory[cellIndex];
    return entry !== undefined && entry.flags !== 0;
  }

  generateWaterMask(
    rectangle: GeographicRectangle,
    size: number = DEFAULT_EXPANDED_SIZE,
  ): Uint8Array {
    if (!this.ready) {
      return new Uint8Array([0]);
    }
    const key = `${rectangle.west.toFixed(10)}_${rectangle.south.toFixed(10)}_${rectangle.east.toFixed(10)}_${rectangle.north.toFixed(10)}_${size}`;
    const hit = this._tileCache.get(key);
    if (hit !== undefined) {
      this._tileCache.delete(key);
      this._tileCache.set(key, hit);
      return hit;
    }

    const midLon = (rectangle.west + rectangle.east) * 0.5;
    const midLat = (rectangle.south + rectangle.north) * 0.5;
    const { col, row } = this.lonLatToCellCoord(midLon, midLat);
    const cell = this._getOrDecodeCellSync(col, row);
    if (!cell) {
      return new Uint8Array([255]);
    }

    // Per-frame rasterization budget guard: if exceeded during fast camera motion,
    // return an instant 1x1 preview without caching so the tile upgrades on a subsequent frame.
    if (
      this._frameBudgetEnabled &&
      this._frameTileCount >= this._maxTilesPerFrame
    ) {
      return cell.composite.generateWaterMask(rectangle, 1);
    }
    this._frameTileCount++;

    const mask = cell.composite.generateWaterMask(rectangle, size);
    if (this._tileCache.size >= this._maxCachedTiles) {
      const oldest = this._tileCache.keys().next().value;
      if (oldest !== undefined) {
        this._tileCache.delete(oldest);
      }
    }
    this._tileCache.set(key, mask);
    return mask;
  }

  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize: number = DEFAULT_EXPANDED_SIZE,
  ): Uint8Array | undefined {
    if (!this.ready) {
      return undefined;
    }
    const midLon = (rectangle.west + rectangle.east) * 0.5;
    const midLat = (rectangle.south + rectangle.north) * 0.5;
    const { col, row } = this.lonLatToCellCoord(midLon, midLat);
    const cell = this._getOrDecodeCellSync(col, row);
    if (!cell) {
      return undefined;
    }
    if (
      this._frameBudgetEnabled &&
      this._frameTileCount >= this._maxTilesPerFrame
    ) {
      return undefined;
    }
    this._frameTileCount++;
    return cell.composite.augmentWaterMask(
      providerMask,
      rectangle,
      expandedSize,
    );
  }
}

export {
  GlobalCoastlineWaterClassificationProvider,
  applyCoastalSignedDistanceField,
};

export default LakeWaterClassificationProvider;
