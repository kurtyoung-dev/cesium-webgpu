import {
  type GeographicRectangle,
  type WaterClassificationProvider,
} from "./WaterClassificationProvider.js";
import { antimeridianWrapPasses } from "./GlobalCoastlineAntimeridian.js";

const MAGIC_LWM1 = 0x314d574c;
const MAGIC_LWM2 = 0x324d574c;
const DEFAULT_EXPANDED_SIZE = 256;
const SDF_INT_INF = 10000;
const DEFAULT_COASTAL_SDF_RADIUS_TEXELS = 6.0;
const SDF_LUT_CAPACITY = 1024;

/**
 * Radius, in texels, of the separable binomial smoothing (weights 1 4 6 4 1)
 * applied to the transition band of every coastal and lake distance field
 * (water round 5, FND-1). The distance field is built from texel-centre
 * classification, so its 0.5 isoline follows the raster's staircase; at the
 * Great Lakes camera a 128-texel tile spans about three screen pixels per
 * texel, and that staircase drew a serrated shore on both renderers. The
 * smoothing rounds the steps off. A symmetric kernel leaves a straight shore
 * where it is (the field is linear across it), and only texels already inside
 * the band change, so land and open water beyond the radius stay exactly 0 and
 * 255.
 */
export const COASTAL_SDF_SMOOTHING_RADIUS_TEXELS = 2;

/**
 * Texels a tile mask is padded by on every side before its distance field is
 * built: the field's radius, one texel, and the smoothing radius, so the
 * border texels of two neighbouring tiles see the same neighbourhood and no
 * seam shows. Masks under 32 texels get no field and no padding.
 *
 * @param sdfRadiusTexels The distance field's radius.
 * @param size The tile mask's side length.
 * @returns The padding, in texels.
 */
export function coastalSdfPadTexels(
  sdfRadiusTexels: number,
  size: number,
): number {
  return size >= 32
    ? Math.ceil(sdfRadiusTexels) + 1 + COASTAL_SDF_SMOOTHING_RADIUS_TEXELS
    : 0;
}

const SUBBOX_CHUNK = 32;

function buildRingSubBoxes(ring: Float64Array): Float64Array | undefined {
  const vertCount = ring.length / 2;
  if (vertCount <= 64) {
    return undefined;
  }
  const numChunks = Math.ceil(vertCount / SUBBOX_CHUNK);
  const rBoxes = new Float64Array(numChunks * 4);
  for (let c = 0; c < numChunks; c++) {
    let bW = Infinity;
    let bS = Infinity;
    let bE = -Infinity;
    let bN = -Infinity;
    const start = c * SUBBOX_CHUNK;
    const end = Math.min(vertCount, start + SUBBOX_CHUNK + 1);
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
    if (start + SUBBOX_CHUNK >= vertCount && vertCount > 0) {
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

interface CoastlinePolygon {
  west: number;
  south: number;
  east: number;
  north: number;
  rings: Float64Array[];
  ringSubBoxes?: (Float64Array | undefined)[];
}

function getCoastRingSubBoxes(
  poly: CoastlinePolygon,
  rIdx: number,
): Float64Array | undefined {
  return poly.ringSubBoxes?.[rIdx];
}

/**
 * Point-in-polygon test for a single ring using the ray casting algorithm.
 *
 * @param x Longitude in radians.
 * @param y Latitude in radians.
 * @param ring Interleaved [lon, lat] coordinates in radians.
 * @param ringBoxes Optional 32-vertex bounding boxes [bW, bS, bE, bN].
 * @returns True if the point is inside the ring.
 */
function pointInRing(
  x: number,
  y: number,
  ring: Float64Array,
  ringBoxes?: Float64Array,
): boolean {
  let inside = false;
  const len = ring.length / 2;
  if (ringBoxes !== undefined) {
    const numChunks = ringBoxes.length / 4;
    for (let c = 0; c < numChunks; c++) {
      const bIdx = c * 4;
      if (
        y < ringBoxes[bIdx + 1] ||
        y >= ringBoxes[bIdx + 3] ||
        x >= ringBoxes[bIdx + 2]
      ) {
        continue;
      }
      const start = c * SUBBOX_CHUNK;
      const end = Math.min(len, start + SUBBOX_CHUNK);
      for (let i = start; i < end; i++) {
        const j = i + 1 === len ? 0 : i + 1;
        const xi = ring[i * 2];
        const yi = ring[i * 2 + 1];
        const xj = ring[j * 2];
        const yj = ring[j * 2 + 1];
        const intersect =
          yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) {
          inside = !inside;
        }
      }
    }
    return inside;
  }

  for (let i = 0, j = len - 1; i < len; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Point-in-polygon test across exterior and interior (hole) rings using even-odd parity.
 */
function pointInPolygon(x: number, y: number, poly: CoastlinePolygon): boolean {
  let inside = false;
  const rings = poly.rings;
  for (let r = 0; r < rings.length; r++) {
    if (pointInRing(x, y, rings[r], getCoastRingSubBoxes(poly, r))) {
      inside = !inside;
    }
  }
  return inside;
}

const _scratchCoastRows: number[][] = [];
// Grown on first coastal use (never at import); 292 = 256 + 2 * (15 + 1 + 2),
// the largest tile padded by the largest field radius and the smoothing radius.
const PADDED_COAST_SCRATCH_MAX = 292 * 292;
let _scratchPaddedCoastMask = new Uint8Array(0);

function getPaddedCoastScratch(length: number): Uint8Array | undefined {
  if (length > PADDED_COAST_SCRATCH_MAX) {
    return undefined;
  }
  if (_scratchPaddedCoastMask.length < length) {
    _scratchPaddedCoastMask = new Uint8Array(PADDED_COAST_SCRATCH_MAX);
  }
  return _scratchPaddedCoastMask.subarray(0, length);
}

function getCoastRowList(r: number): number[] {
  let list = _scratchCoastRows[r];
  if (list === undefined) {
    list = [];
    _scratchCoastRows[r] = list;
  }
  return list;
}

/**
 * Scanline even-odd rasterization of land polygons into a 256x256 water mask.
 * Water is 255; land is 0.
 *
 * @param polygon Land polygon to rasterize.
 * @param rectangle Geographic tile bounds in radians.
 * @param size Mask dimension (width and height).
 * @param out Output Uint8Array of size * size.
 * @returns True if any texel was modified.
 */
function rasterizeLandPolygon(
  polygon: CoastlinePolygon,
  rectangle: GeographicRectangle,
  size: number,
  out: Uint8Array,
): boolean {
  const west = rectangle.west;
  const north = rectangle.north;
  const south = rectangle.south;
  const dLon = (rectangle.east - rectangle.west) / size;
  const dLat = (rectangle.north - rectangle.south) / size;
  if (!(dLon > 0) || !(dLat > 0)) {
    return false;
  }

  const invDLat = 1.0 / dLat;
  if (
    Math.floor((north - polygon.north) * invDLat - 0.5) ===
    Math.floor((north - polygon.south) * invDLat - 0.5)
  ) {
    return false;
  }

  let hasCrossings = false;
  let minRowTouched = size;
  let maxRowTouched = -1;

  const rings = polygon.rings;
  for (let rIdx = 0; rIdx < rings.length; rIdx++) {
    const ring = rings[rIdx];
    const vertexCount = ring.length / 2;
    const rBoxes = getCoastRingSubBoxes(polygon, rIdx);

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
          Math.floor((north - bN) * invDLat - 0.5) ===
          Math.floor((north - bS) * invDLat - 0.5)
        ) {
          continue;
        }
        const start = c * SUBBOX_CHUNK;
        const end = Math.min(vertexCount, start + SUBBOX_CHUNK);
        for (let i = start; i < end; i++) {
          const j = i + 1 === vertexCount ? 0 : i + 1;
          const x0 = ring[i * 2];
          const y0 = ring[i * 2 + 1];
          const x1 = ring[j * 2];
          const y1 = ring[j * 2 + 1];

          const yMin = y0 < y1 ? y0 : y1;
          const yMax = y0 > y1 ? y0 : y1;
          if (yMax <= south || yMin >= north) {
            continue;
          }
          const r0 = Math.floor((north - yMax) * invDLat - 0.5);
          const r1 = Math.floor((north - yMin) * invDLat - 0.5);
          if (r0 === r1) {
            continue;
          }

          const rStart = r0 + 1 < 0 ? 0 : r0 + 1;
          const rEnd = r1 >= size ? size - 1 : r1;
          if (rStart > rEnd) {
            continue;
          }
          const invSlope = (x1 - x0) / (y1 - y0);

          for (let r = rStart; r <= rEnd; r++) {
            const yRow = north - (r + 0.5) * dLat;
            if (yRow >= yMin && yRow < yMax) {
              const xIntersect = x0 + invSlope * (yRow - y0);
              getCoastRowList(r).push(xIntersect);
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

        const yMin = y0 < y1 ? y0 : y1;
        const yMax = y0 > y1 ? y0 : y1;
        if (yMax <= south || yMin >= north) {
          continue;
        }
        const r0 = Math.floor((north - yMax) * invDLat - 0.5);
        const r1 = Math.floor((north - yMin) * invDLat - 0.5);
        if (r0 === r1) {
          continue;
        }

        const rStart = r0 + 1 < 0 ? 0 : r0 + 1;
        const rEnd = r1 >= size ? size - 1 : r1;
        if (rStart > rEnd) {
          continue;
        }
        const invSlope = (x1 - x0) / (y1 - y0);

        for (let r = rStart; r <= rEnd; r++) {
          const yRow = north - (r + 0.5) * dLat;
          if (yRow >= yMin && yRow < yMax) {
            const xIntersect = x0 + invSlope * (yRow - y0);
            getCoastRowList(r).push(xIntersect);
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
    const crossings = _scratchCoastRows[r];
    if (!crossings) {
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
    for (let c = 0; c + 1 < len; c += 2) {
      const xLeft = crossings[c];
      const xRight = crossings[c + 1];
      let colStart = Math.floor((xLeft - west) / dLon);
      let colEnd = Math.floor((xRight - west) / dLon);
      if (colEnd < 0 || colStart >= size) {
        continue;
      }
      if (colStart < 0) {
        colStart = 0;
      }
      if (colEnd >= size) {
        colEnd = size - 1;
      }
      const rowOffset = r * size;
      for (let col = colStart; col <= colEnd; col++) {
        if (out[rowOffset + col] !== 0) {
          out[rowOffset + col] = 0;
          changed = true;
        }
      }
    }
    crossings.length = 0;
  }

  return changed;
}

const SPATIAL_GRID_COLS = 36;
const SPATIAL_GRID_ROWS = 18;
const MAX_TILE_CACHE_ENTRIES = 1024;
/** Upper bound on cached mask bytes (1024 full 256x256 masks would be 64 MiB). */
const MAX_TILE_CACHE_BYTES = 32 * 1024 * 1024;

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

function makeTileCacheKey(rect: GeographicRectangle, size: number): string {
  return `${size}:${rect.west.toFixed(10)}:${rect.south.toFixed(10)}:${rect.east.toFixed(10)}:${rect.north.toFixed(10)}`;
}

function coastalSdfRadiusTexels(
  rectangle: GeographicRectangle,
  size: number,
): number {
  if (size !== DEFAULT_EXPANDED_SIZE) {
    return DEFAULT_COASTAL_SDF_RADIUS_TEXELS;
  }
  const tileSpanMeters = Math.max(
    (rectangle.north - rectangle.south) * 6378137.0,
    1.0,
  );
  const texelMeters = tileSpanMeters / Math.max(size, 1);
  return Math.max(8.0, Math.min(15.0, 480.0 / texelMeters));
}

/**
 * A global water classification provider backed by packed vector coastline
 * and island polygons (the bundled LWM2 asset is built from Natural Earth
 * 1:10m land, minor islands and ice shelves; public domain).
 *
 * Provides accurate, seamless water masks for any terrain tile across the globe,
 * enabling natural planetary oceans, bays, and coastlines even when the underlying
 * terrain provider has no built-in water mask.
 */
export class GlobalCoastlineWaterClassificationProvider implements WaterClassificationProvider {
  private _polygons: CoastlinePolygon[] = [];
  private _ready = false;
  private _west = Infinity;
  private _south = Infinity;
  private _east = -Infinity;
  private _north = -Infinity;
  private _gridCells: number[][] = [];
  private _seenStamp: Uint32Array = new Uint32Array(0);
  private _currentStamp = 0;
  private _tileCache = new Map<string, Uint8Array>();
  private _tileCacheBytes = 0;

  /**
   * @param buffer The fetched `ne50mCoastlines.bin` payload.
   * @throws Error when the buffer is not a valid LWM1 asset.
   */
  constructor(buffer: ArrayBuffer) {
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    if (magic !== MAGIC_LWM1 && magic !== MAGIC_LWM2) {
      throw new Error(
        "GlobalCoastlineWaterClassificationProvider: invalid LWM1/LWM2 asset",
      );
    }
    const isLwm2 = magic === MAGIC_LWM2;

    const polygonCount = view.getUint32(4, true);
    let offset = 8;
    const polygons: CoastlinePolygon[] = new Array(polygonCount);
    const gridCells: number[][] = new Array(
      SPATIAL_GRID_COLS * SPATIAL_GRID_ROWS,
    );
    for (let i = 0; i < gridCells.length; i++) {
      gridCells[i] = [];
    }

    const coordArena = new Float64Array(Math.ceil(buffer.byteLength / 2));
    let coordOffset = 0;

    for (let p = 0; p < polygonCount; p++) {
      let west: number;
      let south: number;
      let east: number;
      let north: number;
      let ringCount: number;
      if (isLwm2) {
        west = view.getFloat32(offset, true);
        south = view.getFloat32(offset + 4, true);
        east = view.getFloat32(offset + 8, true);
        north = view.getFloat32(offset + 12, true);
        ringCount = view.getUint16(offset + 18, true);
        offset += 20;
      } else {
        west = view.getFloat64(offset, true);
        south = view.getFloat64(offset + 8, true);
        east = view.getFloat64(offset + 16, true);
        north = view.getFloat64(offset + 24, true);
        offset += 32;
        ringCount = view.getUint32(offset, true);
        offset += 4;
      }

      const lonSpan = (east - west) / 65535.0;
      const latSpan = (north - south) / 65535.0;

      const rings: Float64Array[] = new Array(ringCount);
      let ringSubBoxes: (Float64Array | undefined)[] | undefined;
      for (let r = 0; r < ringCount; r++) {
        const vertexCount = view.getUint32(offset, true);
        offset += 4;
        const coordCount = vertexCount * 2;
        const ring = coordArena.subarray(coordOffset, coordOffset + coordCount);
        coordOffset += coordCount;
        for (let i = 0; i < vertexCount; i++) {
          ring[i * 2] = west + view.getUint16(offset, true) * lonSpan;
          ring[i * 2 + 1] = south + view.getUint16(offset + 2, true) * latSpan;
          offset += 4;
        }
        rings[r] = ring;
        if (vertexCount > 64) {
          if (ringSubBoxes === undefined) {
            ringSubBoxes = new Array(ringCount);
          }
          ringSubBoxes[r] = buildRingSubBoxes(ring);
        }
      }

      polygons[p] = {
        west,
        south,
        east,
        north,
        rings,
        ringSubBoxes,
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

      const c0 = lonToGridCol(west);
      const c1 = lonToGridCol(east);
      const r0 = latToGridRow(south);
      const r1 = latToGridRow(north);
      for (let r = r0; r <= r1; r++) {
        const rowBase = r * SPATIAL_GRID_COLS;
        for (let c = c0; c <= c1; c++) {
          gridCells[rowBase + c].push(p);
        }
      }
    }

    this._polygons = polygons;
    this._gridCells = gridCells;
    this._seenStamp = new Uint32Array(polygonCount);
    this._ready = true;
  }

  get ready(): boolean {
    return this._ready;
  }

  get cachedTileCount(): number {
    return this._tileCache.size;
  }

  /** Bytes currently held by the tile cache (bounded by MAX_TILE_CACHE_BYTES). */
  get cachedTileBytes(): number {
    return this._tileCacheBytes;
  }

  private _cacheGet(key: string): Uint8Array | undefined {
    const hit = this._tileCache.get(key);
    if (hit !== undefined) {
      this._tileCache.delete(key);
      this._tileCache.set(key, hit);
    }
    return hit;
  }

  private _cacheSet(key: string, mask: Uint8Array): Uint8Array {
    const replaced = this._tileCache.get(key);
    if (replaced !== undefined) {
      this._tileCache.delete(key);
      this._tileCacheBytes -= replaced.byteLength;
    }
    while (
      this._tileCache.size > 0 &&
      (this._tileCache.size >= MAX_TILE_CACHE_ENTRIES ||
        this._tileCacheBytes + mask.byteLength > MAX_TILE_CACHE_BYTES)
    ) {
      const oldestKey = this._tileCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this._tileCacheBytes -= this._tileCache.get(oldestKey)!.byteLength;
      this._tileCache.delete(oldestKey);
    }
    this._tileCache.set(key, mask);
    this._tileCacheBytes += mask.byteLength;
    return mask;
  }

  /**
   * Queries the 2D spatial grid index for candidate polygon indices overlapping `rect`.
   */
  private _querySpatialGrid(rect: GeographicRectangle): number[] {
    const c0 = lonToGridCol(rect.west);
    const c1 = lonToGridCol(rect.east);
    const r0 = latToGridRow(rect.south);
    const r1 = latToGridRow(rect.north);
    if (c0 === c1 && r0 === r1) {
      return this._gridCells[r0 * SPATIAL_GRID_COLS + c0];
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
        const bucket = this._gridCells[rowBase + c];
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

  /**
   * Fast bounding-box and sub-box intersection test against candidate land masses.
   */
  private _intersectsTile(
    poly: CoastlinePolygon,
    rect: GeographicRectangle,
  ): boolean {
    if (
      rect.east < poly.west ||
      rect.west > poly.east ||
      rect.north < poly.south ||
      rect.south > poly.north
    ) {
      return false;
    }
    if (
      poly.west >= rect.west &&
      poly.east <= rect.east &&
      poly.south >= rect.south &&
      poly.north <= rect.north
    ) {
      return true;
    }
    const rings = poly.rings;
    let hasBoxes = false;
    for (let r = 0; r < rings.length; r++) {
      const s = getCoastRingSubBoxes(poly, r);
      if (s !== undefined) {
        hasBoxes = true;
        const count = s.length / 4;
        for (let i = 0; i < count; i++) {
          const bOff = i * 4;
          if (!(
            rect.east < s[bOff] ||
            rect.west > s[bOff + 2] ||
            rect.north < s[bOff + 1] ||
            rect.south > s[bOff + 3]
          )) {
            return true;
          }
        }
      }
    }
    return !hasBoxes;
  }

  // The coast polygons beyond the antimeridian that a padded rectangle reaches,
  // grouped with the shifted rectangle to rasterize them over. Empty unless the
  // pad crosses +-PI (see antimeridianWrapPasses).
  private _collectAntimeridianPolygons(
    paddedRect: GeographicRectangle,
    invDLat: number,
  ): { rasterRect: GeographicRectangle; polygons: CoastlinePolygon[] }[] {
    const groups: {
      rasterRect: GeographicRectangle;
      polygons: CoastlinePolygon[];
    }[] = [];
    for (const pass of antimeridianWrapPasses(paddedRect)) {
      const matched: CoastlinePolygon[] = [];
      const candidates = this._querySpatialGrid(pass.queryRect);
      for (let i = 0; i < candidates.length; i++) {
        const poly = this._polygons[candidates[i]];
        if (
          Math.floor((paddedRect.north - poly.north) * invDLat - 0.5) ===
          Math.floor((paddedRect.north - poly.south) * invDLat - 0.5)
        ) {
          continue;
        }
        if (this._intersectsTile(poly, pass.queryRect)) {
          matched.push(poly);
        }
      }
      if (matched.length > 0) {
        groups.push({ rasterRect: pass.rasterRect, polygons: matched });
      }
    }
    return groups;
  }

  intersectsRectangle(rectangle: GeographicRectangle): boolean {
    if (!this._ready) {
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
    const candidates = this._querySpatialGrid(rectangle);
    for (let i = 0; i < candidates.length; i++) {
      if (this._intersectsTile(polygons[candidates[i]], rectangle)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Generates a complete water mask for a tile rectangle.
   *
   * @param rectangle Geographic tile bounds in radians.
   * @param size Mask resolution (default 256).
   * @returns Uint8Array water mask: 1-byte for pure ocean [255] or pure land [0], or 256x256 for coast.
   */
  generateWaterMask(
    rectangle: GeographicRectangle,
    size: number = DEFAULT_EXPANDED_SIZE,
  ): Uint8Array {
    if (!this._ready) {
      return new Uint8Array([255]); // Fallback to ocean while loading
    }

    const cacheKey = makeTileCacheKey(rectangle, size);
    const cached = this._cacheGet(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const dLon = (rectangle.east - rectangle.west) / Math.max(size, 1);
    const dLat = (rectangle.north - rectangle.south) / Math.max(size, 1);
    const sdfRadius = coastalSdfRadiusTexels(rectangle, size);
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

    const invDLat = 1.0 / Math.max(dLat, 1e-12);
    const intersecting: CoastlinePolygon[] = [];
    const polygons = this._polygons;
    const candidateIndices = this._querySpatialGrid(paddedRect);
    for (let i = 0; i < candidateIndices.length; i++) {
      const poly = polygons[candidateIndices[i]];
      if (
        Math.floor((paddedRect.north - poly.north) * invDLat - 0.5) ===
        Math.floor((paddedRect.north - poly.south) * invDLat - 0.5)
      ) {
        continue;
      }
      if (this._intersectsTile(poly, paddedRect)) {
        intersecting.push(poly);
      }
    }
    const acrossSeam = this._collectAntimeridianPolygons(paddedRect, invDLat);

    // Fast Path 1: Completely outside all coastline chunks
    if (intersecting.length === 0 && acrossSeam.length === 0) {
      const midLon = (rectangle.west + rectangle.east) * 0.5;
      const midLat = (rectangle.south + rectangle.north) * 0.5;
      const midCellBucket =
        this._gridCells[
          latToGridRow(midLat) * SPATIAL_GRID_COLS + lonToGridCol(midLon)
        ];
      // Check if inside deep continental interior (even-odd across exterior and inland-sea hole rings)
      for (let i = 0; i < midCellBucket.length; i++) {
        const p = polygons[midCellBucket[i]];
        if (
          midLon >= p.west &&
          midLon <= p.east &&
          midLat >= p.south &&
          midLat <= p.north &&
          pointInPolygon(midLon, midLat, p)
        ) {
          return this._cacheSet(cacheKey, new Uint8Array([0]));
        }
      }
      return this._cacheSet(cacheKey, new Uint8Array([255])); // 1-byte all-ocean
    }

    // Coastal Path: Start with all-water (255) and carve out land polygons (0)
    const paddedLen = paddedSize * paddedSize;
    const paddedOut =
      (pad > 0 ? getPaddedCoastScratch(paddedLen) : undefined) ??
      new Uint8Array(paddedLen);
    paddedOut.fill(255);

    let changed = false;
    for (const polygon of intersecting) {
      if (rasterizeLandPolygon(polygon, paddedRect, paddedSize, paddedOut)) {
        changed = true;
      }
    }
    for (const group of acrossSeam) {
      for (const polygon of group.polygons) {
        if (
          rasterizeLandPolygon(polygon, group.rasterRect, paddedSize, paddedOut)
        ) {
          changed = true;
        }
      }
    }

    if (!changed) {
      // If no crossings intersected inside padded tile, classify by center point
      const midLon = (rectangle.west + rectangle.east) * 0.5;
      const midLat = (rectangle.south + rectangle.north) * 0.5;
      const midCellBucket =
        this._gridCells[
          latToGridRow(midLat) * SPATIAL_GRID_COLS + lonToGridCol(midLon)
        ];
      for (let i = 0; i < midCellBucket.length; i++) {
        const p = polygons[midCellBucket[i]];
        if (
          midLon >= p.west &&
          midLon <= p.east &&
          midLat >= p.south &&
          midLat <= p.north &&
          pointInPolygon(midLon, midLat, p)
        ) {
          return this._cacheSet(cacheKey, new Uint8Array([0]));
        }
      }
      return this._cacheSet(cacheKey, new Uint8Array([255]));
    }

    let hasWater = false;
    for (let i = 0; i < paddedOut.length; i++) {
      if (paddedOut[i] !== 0) {
        hasWater = true;
        break;
      }
    }
    if (!hasWater) {
      return this._cacheSet(cacheKey, new Uint8Array([0]));
    }

    applyCoastalSignedDistanceField(paddedOut, paddedSize, sdfRadius);
    if (pad === 0) {
      return this._cacheSet(cacheKey, paddedOut);
    }

    const out = new Uint8Array(size * size);
    let allZero = true;
    for (let r = 0; r < size; r++) {
      const srcRow = (r + pad) * paddedSize + pad;
      const dstRow = r * size;
      for (let c = 0; c < size; c++) {
        const val = paddedOut[srcRow + c];
        out[dstRow + c] = val;
        if (val !== 0) {
          allZero = false;
        }
      }
    }
    if (allZero) {
      return this._cacheSet(cacheKey, new Uint8Array([0]));
    }
    return this._cacheSet(cacheKey, out);
  }

  augmentWaterMask(
    providerMask: Uint8Array | Uint8ClampedArray,
    rectangle: GeographicRectangle,
    expandedSize?: number,
  ): Uint8Array | undefined {
    if (!this._ready) {
      return undefined;
    }
    // If provider mask is missing or 1-byte all-land, generate full mask
    if (providerMask.length === 1) {
      return this.generateWaterMask(
        rectangle,
        expandedSize ?? DEFAULT_EXPANDED_SIZE,
      );
    }

    const size = Math.round(Math.sqrt(providerMask.length));
    const dLon = (rectangle.east - rectangle.west) / Math.max(size, 1);
    const dLat = (rectangle.north - rectangle.south) / Math.max(size, 1);
    // Pad exactly like generateWaterMask: the distance field must see coast
    // beyond the tile border, otherwise adjacent augmented tiles disagree on
    // the border texels and the seam shows.
    const sdfRadius = coastalSdfRadiusTexels(rectangle, size);
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
    const invDLat = 1.0 / Math.max(dLat, 1e-12);
    const intersecting: CoastlinePolygon[] = [];
    const polygons = this._polygons;
    const candidateIndices = this._querySpatialGrid(paddedRect);
    for (let i = 0; i < candidateIndices.length; i++) {
      const poly = polygons[candidateIndices[i]];
      if (
        Math.floor((paddedRect.north - poly.north) * invDLat - 0.5) ===
        Math.floor((paddedRect.north - poly.south) * invDLat - 0.5)
      ) {
        continue;
      }
      if (this._intersectsTile(poly, paddedRect)) {
        intersecting.push(poly);
      }
    }
    const acrossSeam = this._collectAntimeridianPolygons(paddedRect, invDLat);
    if (intersecting.length === 0 && acrossSeam.length === 0) {
      return undefined;
    }

    const paddedLen = paddedSize * paddedSize;
    const padded =
      (pad > 0 ? getPaddedCoastScratch(paddedLen) : undefined) ??
      new Uint8Array(paddedLen);
    if (pad === 0) {
      padded.set(providerMask);
    } else {
      // The provider has no data beyond the tile, so extend its edge texels
      // outward; the coast polygons are then carved over the whole padded area.
      for (let r = 0; r < paddedSize; r++) {
        const srcRow = Math.min(Math.max(r - pad, 0), size - 1) * size;
        const dstRow = r * paddedSize;
        for (let c = 0; c < paddedSize; c++) {
          padded[dstRow + c] =
            providerMask[srcRow + Math.min(Math.max(c - pad, 0), size - 1)];
        }
      }
    }
    let changed = false;
    for (const polygon of intersecting) {
      if (rasterizeLandPolygon(polygon, paddedRect, paddedSize, padded)) {
        changed = true;
      }
    }
    for (const group of acrossSeam) {
      for (const polygon of group.polygons) {
        if (
          rasterizeLandPolygon(polygon, group.rasterRect, paddedSize, padded)
        ) {
          changed = true;
        }
      }
    }
    if (!changed) {
      return undefined;
    }
    applyCoastalSignedDistanceField(padded, paddedSize, sdfRadius);
    if (pad === 0) {
      return padded;
    }
    const out = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) {
      const srcRow = (r + pad) * paddedSize + pad;
      out.set(padded.subarray(srcRow, srcRow + size), r * size);
    }
    return out;
  }
}

let _scratchSize = 0;
let _scratchHDistSq = new Int32Array(0);
let _scratchBinaryMask = new Uint8Array(0);
let _scratchSmoothRows = new Uint16Array(0);
const _lutWater = new Uint8Array(SDF_LUT_CAPACITY);
const _lutLand = new Uint8Array(SDF_LUT_CAPACITY);
let _lastLutRadius = -1.0;

function ensureSdfScratch(size: number): void {
  if (_scratchSize >= size) {
    return;
  }
  const total = size * size;
  _scratchSize = size;
  _scratchHDistSq = new Int32Array(total);
  _scratchBinaryMask = new Uint8Array(total);
  _scratchSmoothRows = new Uint16Array(total);
}

/**
 * Smooths the transition band of a distance field in place with the
 * separable binomial kernel 1 4 6 4 1 (sum 16 per axis), over the rows and
 * columns that hold the band plus the kernel radius. Only texels whose value
 * is strictly between 0 and 255 are rewritten, and they stay in [1, 254], so
 * the exact land and water interiors, and the band's own extent, are kept.
 * The horizontal pass is read from the unmodified field, so the result does
 * not depend on the scan order.
 */
function smoothCoastalTransitionBand(
  mask: Uint8Array,
  size: number,
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): void {
  const r = COASTAL_SDF_SMOOTHING_RADIUS_TEXELS;
  const last = size - 1;
  const y0 = Math.max(0, rowStart - r);
  const y1 = Math.min(last, rowEnd + r);
  const x0 = Math.max(0, colStart - r);
  const x1 = Math.min(last, colEnd + r);
  const hy0 = Math.max(0, y0 - r);
  const hy1 = Math.min(last, y1 + r);
  const rows = _scratchSmoothRows;
  for (let y = hy0; y <= hy1; y++) {
    const rowOff = y * size;
    for (let x = x0; x <= x1; x++) {
      const xm2 = x - 2 < 0 ? 0 : x - 2;
      const xm1 = x - 1 < 0 ? 0 : x - 1;
      const xp1 = x + 1 > last ? last : x + 1;
      const xp2 = x + 2 > last ? last : x + 2;
      rows[rowOff + x] =
        mask[rowOff + xm2] +
        4 * mask[rowOff + xm1] +
        6 * mask[rowOff + x] +
        4 * mask[rowOff + xp1] +
        mask[rowOff + xp2];
    }
  }
  for (let y = y0; y <= y1; y++) {
    const ym2 = (y - 2 < hy0 ? hy0 : y - 2) * size;
    const ym1 = (y - 1 < hy0 ? hy0 : y - 1) * size;
    const yc = y * size;
    const yp1 = (y + 1 > hy1 ? hy1 : y + 1) * size;
    const yp2 = (y + 2 > hy1 ? hy1 : y + 2) * size;
    for (let x = x0; x <= x1; x++) {
      const value = mask[yc + x];
      if (value === 0 || value === 255) {
        continue;
      }
      const sum =
        rows[ym2 + x] +
        4 * rows[ym1 + x] +
        6 * rows[yc + x] +
        4 * rows[yp1 + x] +
        rows[yp2 + x];
      const smoothed = Math.round(sum / 256);
      mask[yc + x] = smoothed < 1 ? 1 : smoothed > 254 ? 254 : smoothed;
    }
  }
}

function ensureSdfLut(sdfRadiusTexels: number, maxDSqInt: number): void {
  if (_lastLutRadius === sdfRadiusTexels) {
    return;
  }
  _lastLutRadius = sdfRadiusTexels;
  const invDoubleRadius = 0.5 / sdfRadiusTexels;
  const limit = Math.min(SDF_LUT_CAPACITY - 1, maxDSqInt);
  for (let dSq = 0; dSq <= limit; dSq++) {
    const dist = Math.sqrt(dSq) - 0.5;
    _lutWater[dSq] = Math.max(
      1,
      Math.min(254, Math.round((0.5 + dist * invDoubleRadius) * 255)),
    );
    _lutLand[dSq] = Math.max(
      1,
      Math.min(254, Math.round((0.5 - dist * invDoubleRadius) * 255)),
    );
  }
}

/**
 * Converts a binary or partially-classified coastal water mask in-place into a
 * band-limited Signed Distance Field (SDF) centered at 0.5 (128).
 * Interior land beyond `sdfRadiusTexels` remains exact 0, open water beyond
 * `sdfRadiusTexels` remains exact 255, and coastal transition texels encode
 * continuous signed distance in [1..254], smoothed across
 * {@link COASTAL_SDF_SMOOTHING_RADIUS_TEXELS} so the shore does not follow the
 * raster's staircase.
 */
export function applyCoastalSignedDistanceField(
  mask: Uint8Array,
  size: number,
  sdfRadiusTexels: number = DEFAULT_COASTAL_SDF_RADIUS_TEXELS,
): Uint8Array {
  const total = size * size;
  if (mask.length !== total || size <= 1 || sdfRadiusTexels <= 0) {
    return mask;
  }

  let hasWater = false;
  let hasLand = false;
  for (let i = 0; i < total; i++) {
    if (mask[i] >= 128) {
      hasWater = true;
    } else {
      hasLand = true;
    }
    if (hasWater && hasLand) {
      break;
    }
  }
  if (!hasWater || !hasLand) {
    return mask;
  }

  ensureSdfScratch(size);
  const hDistSq = _scratchHDistSq;
  const binMask = _scratchBinaryMask;
  for (let i = 0; i < total; i++) {
    binMask[i] = mask[i] >= 128 ? 1 : 0;
  }

  const maxRawDist = sdfRadiusTexels + 0.5;
  const maxRawDistSq = maxRawDist * maxRawDist;
  const maxR = Math.ceil(maxRawDist);
  const maxDSqInt = Math.ceil(maxRawDistSq);
  ensureSdfLut(sdfRadiusTexels, maxDSqInt);

  let minActiveRow = size;
  let maxActiveRow = -1;
  let minActiveCol = size;
  let maxActiveCol = -1;

  for (let y = 0; y < size; y++) {
    const rowOff = y * size;
    const first = binMask[rowOff];
    let mixed = false;
    for (let x = 1; x < size; x++) {
      if (binMask[rowOff + x] !== first) {
        mixed = true;
        break;
      }
    }
    if (!mixed) {
      hDistSq.fill(SDF_INT_INF, rowOff, rowOff + size);
      if (y > 0 && binMask[rowOff] !== binMask[rowOff - size]) {
        if (y - 1 < minActiveRow) {
          minActiveRow = y - 1;
        }
        if (y > maxActiveRow) {
          maxActiveRow = y;
        }
        minActiveCol = 0;
        maxActiveCol = size - 1;
      }
      continue;
    }

    if (y < minActiveRow) {
      minActiveRow = y;
    }
    if (y > maxActiveRow) {
      maxActiveRow = y;
    }
    if (y > 0) {
      if (binMask[rowOff] !== binMask[rowOff - size]) {
        minActiveCol = 0;
      }
      if (binMask[rowOff + size - 1] !== binMask[rowOff - 1]) {
        maxActiveCol = size - 1;
      }
    }

    let dToLand = first === 0 ? 0 : SDF_INT_INF;
    let dToWater = first === 1 ? 0 : SDF_INT_INF;
    hDistSq[rowOff] = SDF_INT_INF;
    let prev = first;
    for (let x = 1; x < size; x++) {
      const cur = binMask[rowOff + x];
      if (cur !== prev) {
        if (x - 1 < minActiveCol) {
          minActiveCol = x - 1;
        }
        if (x > maxActiveCol) {
          maxActiveCol = x;
        }
        prev = cur;
      }
      if (cur === 1) {
        dToWater = 0;
        dToLand++;
        hDistSq[rowOff + x] = dToLand <= maxR ? dToLand * dToLand : SDF_INT_INF;
      } else {
        dToLand = 0;
        dToWater++;
        hDistSq[rowOff + x] =
          dToWater <= maxR ? dToWater * dToWater : SDF_INT_INF;
      }
    }

    dToLand = binMask[rowOff + size - 1] === 0 ? 0 : SDF_INT_INF;
    dToWater = binMask[rowOff + size - 1] === 1 ? 0 : SDF_INT_INF;
    for (let x = size - 2; x >= 0; x--) {
      const idx = rowOff + x;
      if (binMask[idx] === 1) {
        dToWater = 0;
        dToLand++;
        if (dToLand <= maxR) {
          const sq = dToLand * dToLand;
          if (sq < hDistSq[idx]) {
            hDistSq[idx] = sq;
          }
        }
      } else {
        dToLand = 0;
        dToWater++;
        if (dToWater <= maxR) {
          const sq = dToWater * dToWater;
          if (sq < hDistSq[idx]) {
            hDistSq[idx] = sq;
          }
        }
      }
    }
  }

  const yStart = Math.max(0, minActiveRow - maxR);
  const yEnd = Math.min(size - 1, maxActiveRow + maxR);
  const xStart = Math.max(0, minActiveCol - maxR);
  const xEnd = Math.min(size - 1, maxActiveCol + maxR);

  for (let y = 0; y < yStart; y++) {
    const rowOff = y * size;
    const fillVal = binMask[rowOff] === 1 ? 255 : 0;
    mask.fill(fillVal, rowOff, rowOff + size);
  }

  for (let y = yStart; y <= yEnd; y++) {
    const rowOff = y * size;
    const dyMin = Math.max(0, y - maxR);
    const dyMax = Math.min(size - 1, y + maxR);
    if (xStart > 0) {
      const leftVal = binMask[rowOff] === 1 ? 255 : 0;
      mask.fill(leftVal, rowOff, rowOff + xStart);
    }
    for (let x = xStart; x <= xEnd; x++) {
      const idx = rowOff + x;
      const isWater = binMask[idx];
      let best = hDistSq[idx];
      for (let ny = dyMin; ny <= dyMax; ny++) {
        if (ny === y) {
          continue;
        }
        const dy = ny - y;
        const dy2 = dy * dy;
        if (dy2 >= best) {
          continue;
        }
        const nIdx = ny * size + x;
        if (binMask[nIdx] !== isWater) {
          best = dy2;
        } else {
          const cand = dy2 + hDistSq[nIdx];
          if (cand < best) {
            best = cand;
          }
        }
      }
      if (best >= maxRawDistSq) {
        mask[idx] = isWater === 1 ? 255 : 0;
      } else {
        mask[idx] = isWater === 1 ? _lutWater[best] : _lutLand[best];
      }
    }
    if (xEnd < size - 1) {
      const rightVal = binMask[rowOff + size - 1] === 1 ? 255 : 0;
      mask.fill(rightVal, rowOff + xEnd + 1, rowOff + size);
    }
  }

  for (let y = yEnd + 1; y < size; y++) {
    const rowOff = y * size;
    const fillVal = binMask[rowOff] === 1 ? 255 : 0;
    mask.fill(fillVal, rowOff, rowOff + size);
  }

  smoothCoastalTransitionBand(mask, size, yStart, yEnd, xStart, xEnd);

  return mask;
}

/**
 * Diagnostic: current side length of the SDF scratch buffers. Zero until the
 * first coastal distance field is built (nothing is allocated at import).
 *
 * @internal
 */
export function getCoastalSdfScratchSize(): number {
  return _scratchSize;
}

export default GlobalCoastlineWaterClassificationProvider;
