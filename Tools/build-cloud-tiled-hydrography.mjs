#!/usr/bin/env node
/**
 * @purpose Builds the CWT1 per-tile hydrography spatial archive (one 10-degree cell per HTTP Range slice) from the coast, lake, river and bathymetry-tensor assets.
 * @status ACTIVE
 *
 * Builds the Cloud-Optimized Per-Tile Hydrography & Bathymetry Spatial Archive
 * (`packages/engine/Source/Assets/WaterMask/globalHydrographyTileArchive.bin`,
 * magic `0x31545743` = `"CWT1"`).
 *
 * The archive is a pure derivative of the four other WaterMask binaries and embeds
 * the tensor, so it must be rebuilt after any of them changes. No runtime code
 * fetches it yet (the `CloudTiledWaterAndBathymetryProvider` is scaffolding).
 *
 * Architecture:
 *   - Partitions the planet into a `36 x 18` (`10 deg x 10 deg`) spatial directory
 *     (`648` cells, `16 B` header + `648 x 16 B` directory = `10,384 B ≈ 10.1 KiB`).
 *   - For each `10 deg x 10 deg` cell `(col, row)`:
 *     1. Clips all intersecting land/island polygons (`ne50mCoastlines.bin`) to the
 *        padded cell box `[west - 0.25 deg, south - 0.25 deg, east + 0.25 deg, north + 0.25 deg]`
 *        using Sutherland-Hodgman 2D box clipping, encoding a self-contained `LWM2` buffer.
 *     2. Clips/filters all intersecting lake, playa, wetland, and coral-reef polygons
 *        (`ne10mLakes.bin`) into a self-contained `LWM2` buffer with hydrological metadata.
 *     3. Clips/filters all intersecting river polylines (`ne10mRivers.bin`) into a
 *        self-contained `NE1R` buffer preserving Strahler order and downstream flow tangents.
 *     4. Extracts the exact `20 x 20` (`0.5 deg`) RGBA8 geophysical bathymetry, Jerlov
 *        clarity, seabed substrate, and tidal range sub-tensor (`1,600 B`, `GBT1` format).
 *
 * This enables true HTTP `Range` byte-slice per-tile streaming (`7.6-10.1 KiB` directory
 * + `1-18 KiB` per visible cell) with zero upfront whole-planet download and faster
 * per-tile scanline rasterization.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const COAST_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin",
);
const LAKES_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne10mLakes.bin",
);
const RIVERS_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/ne10mRivers.bin",
);
const BATHY_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin",
);
const OUT_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/globalHydrographyTileArchive.bin",
);

const MAGIC_CWT1 = 0x31545743; // "CWT1"
const MAGIC_LWM1 = 0x314d574c;
const MAGIC_LWM2 = 0x324d574c;
const MAGIC_NE1R = 0x5231454e;
const MAGIC_GBT1 = 0x31544247;

const GRID_COLS = 36; // 10 deg longitude per cell
const GRID_ROWS = 18; // 10 deg latitude per cell
const PAD_RAD = (0.25 * Math.PI) / 180.0;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function parseLwmPolygons(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  const isV2 = magic === MAGIC_LWM2;
  if (!isV2 && magic !== MAGIC_LWM1) {
    throw new Error(`Invalid LWM magic: 0x${magic.toString(16)}`);
  }
  const count = view.getUint32(4, true);
  let off = 8;
  const polys = new Array(count);
  for (let p = 0; p < count; p++) {
    let west,
      south,
      east,
      north,
      waterTypeCode = 1,
      sqrtMaxDepthQ8 = 64,
      ringCount;
    if (isV2) {
      west = view.getFloat32(off, true);
      south = view.getFloat32(off + 4, true);
      east = view.getFloat32(off + 8, true);
      north = view.getFloat32(off + 12, true);
      waterTypeCode = view.getUint8(off + 16);
      sqrtMaxDepthQ8 = view.getUint8(off + 17);
      ringCount = view.getUint16(off + 18, true);
      off += 20;
    } else {
      west = view.getFloat64(off, true);
      south = view.getFloat64(off + 8, true);
      east = view.getFloat64(off + 16, true);
      north = view.getFloat64(off + 24, true);
      ringCount = view.getUint32(off + 32, true);
      off += 36;
    }
    const lonSpan = (east - west) / 65535.0;
    const latSpan = (north - south) / 65535.0;
    const rings = new Array(ringCount);
    for (let r = 0; r < ringCount; r++) {
      const vc = view.getUint32(off, true);
      off += 4;
      const ring = new Float64Array(vc * 2);
      for (let i = 0; i < vc; i++) {
        ring[i * 2] = west + view.getUint16(off, true) * lonSpan;
        ring[i * 2 + 1] = south + view.getUint16(off + 2, true) * latSpan;
        off += 4;
      }
      rings[r] = ring;
    }
    polys[p] = {
      west,
      south,
      east,
      north,
      waterTypeCode,
      sqrtMaxDepthQ8,
      rings,
    };
  }
  return polys;
}

function parseNe1rRivers(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== MAGIC_NE1R) {
    throw new Error("Invalid NE1R magic");
  }
  const count = view.getUint32(4, true);
  let off = 8;
  const rivers = new Array(count);
  for (let r = 0; r < count; r++) {
    const west = view.getFloat64(off, true);
    const south = view.getFloat64(off + 8, true);
    const east = view.getFloat64(off + 16, true);
    const north = view.getFloat64(off + 24, true);
    off += 32;
    const baseHalfWidthRad = view.getFloat32(off, true);
    off += 4;
    const rawVc = view.getUint32(off, true);
    off += 4;
    const vc = rawVc & 0x0fffffff;
    const strahlerOrder = (rawVc >>> 28) & 0x0f || 6;
    const lonSpan = (east - west) / 65535.0;
    const latSpan = (north - south) / 65535.0;
    const verts = new Float64Array(vc * 2);
    const widths = new Uint16Array(vc);
    for (let i = 0; i < vc; i++) {
      verts[i * 2] = west + view.getUint16(off, true) * lonSpan;
      verts[i * 2 + 1] = south + view.getUint16(off + 2, true) * latSpan;
      widths[i] = view.getUint16(off + 4, true);
      off += 6;
    }
    rivers[r] = {
      west,
      south,
      east,
      north,
      baseHalfWidthRad,
      strahlerOrder,
      verts,
      widths,
    };
  }
  return rivers;
}

/**
 * Sutherland-Hodgman 2D polygon clipping against an axis-aligned rectangle `[minX, minY, maxX, maxY]`.
 */
function clipRingToBox(ring, minX, minY, maxX, maxY) {
  let pts = [];
  const n0 = ring.length / 2;
  for (let i = 0; i < n0; i++) {
    pts.push(ring[i * 2], ring[i * 2 + 1]);
  }

  const clipEdge = (inPts, insideFn, intersectFn) => {
    const count = inPts.length / 2;
    if (count === 0) return [];
    const out = [];
    let sx = inPts[(count - 1) * 2];
    let sy = inPts[(count - 1) * 2 + 1];
    let sInside = insideFn(sx, sy);
    for (let i = 0; i < count; i++) {
      const ex = inPts[i * 2];
      const ey = inPts[i * 2 + 1];
      const eInside = insideFn(ex, ey);
      if (eInside) {
        if (!sInside) {
          const [ix, iy] = intersectFn(sx, sy, ex, ey);
          out.push(ix, iy);
        }
        out.push(ex, ey);
      } else if (sInside) {
        const [ix, iy] = intersectFn(sx, sy, ex, ey);
        out.push(ix, iy);
      }
      sx = ex;
      sy = ey;
      sInside = eInside;
    }
    return out;
  };

  // Left: x >= minX
  pts = clipEdge(
    pts,
    (x) => x >= minX,
    (x1, y1, x2, y2) => [
      minX,
      y1 + ((minX - x1) / (x2 - x1 || 1e-12)) * (y2 - y1),
    ],
  );
  // Right: x <= maxX
  pts = clipEdge(
    pts,
    (x) => x <= maxX,
    (x1, y1, x2, y2) => [
      maxX,
      y1 + ((maxX - x1) / (x2 - x1 || 1e-12)) * (y2 - y1),
    ],
  );
  // Bottom: y >= minY
  pts = clipEdge(
    pts,
    (_, y) => y >= minY,
    (x1, y1, x2, y2) => [
      x1 + ((minY - y1) / (y2 - y1 || 1e-12)) * (x2 - x1),
      minY,
    ],
  );
  // Top: y <= maxY
  pts = clipEdge(
    pts,
    (_, y) => y <= maxY,
    (x1, y1, x2, y2) => [
      x1 + ((maxY - y1) / (y2 - y1 || 1e-12)) * (x2 - x1),
      maxY,
    ],
  );

  if (pts.length < 6) return null;
  // Deduplicate consecutive identical points
  const dedup = [];
  const m = pts.length / 2;
  for (let i = 0; i < m; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    const prevIdx = dedup.length - 2;
    if (
      prevIdx < 0 ||
      Math.abs(x - dedup[prevIdx]) > 1e-8 ||
      Math.abs(y - dedup[prevIdx + 1]) > 1e-8
    ) {
      dedup.push(x, y);
    }
  }
  if (dedup.length < 6) return null;
  return new Float64Array(dedup);
}

function serializeLwm2Polygons(polys) {
  if (polys.length === 0) return new Uint8Array(0);
  let byteLen = 8;
  for (const p of polys) {
    byteLen += 20;
    for (const r of p.rings) {
      byteLen += 4 + (r.length / 2) * 4;
    }
  }
  const out = new Uint8Array(byteLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC_LWM2, true);
  view.setUint32(4, polys.length, true);
  let off = 8;
  for (const p of polys) {
    view.setFloat32(off, p.west, true);
    view.setFloat32(off + 4, p.south, true);
    view.setFloat32(off + 8, p.east, true);
    view.setFloat32(off + 12, p.north, true);
    view.setUint8(off + 16, p.waterTypeCode ?? 1);
    view.setUint8(off + 17, p.sqrtMaxDepthQ8 ?? 64);
    view.setUint16(off + 18, p.rings.length, true);
    off += 20;
    const lonSpan = Math.max(p.east - p.west, 1e-9);
    const latSpan = Math.max(p.north - p.south, 1e-9);
    for (const r of p.rings) {
      const vc = r.length / 2;
      view.setUint32(off, vc, true);
      off += 4;
      for (let i = 0; i < vc; i++) {
        const qx = clamp(
          Math.round(((r[i * 2] - p.west) / lonSpan) * 65535),
          0,
          65535,
        );
        const qy = clamp(
          Math.round(((r[i * 2 + 1] - p.south) / latSpan) * 65535),
          0,
          65535,
        );
        view.setUint16(off, qx, true);
        view.setUint16(off + 2, qy, true);
        off += 4;
      }
    }
  }
  return out;
}

function serializeNe1rRivers(rivers) {
  if (rivers.length === 0) return new Uint8Array(0);
  let byteLen = 8;
  for (const r of rivers) {
    byteLen += 40 + (r.verts.length / 2) * 6;
  }
  const out = new Uint8Array(byteLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC_NE1R, true);
  view.setUint32(4, rivers.length, true);
  let off = 8;
  for (const r of rivers) {
    view.setFloat64(off, r.west, true);
    view.setFloat64(off + 8, r.south, true);
    view.setFloat64(off + 16, r.east, true);
    view.setFloat64(off + 24, r.north, true);
    off += 32;
    view.setFloat32(off, r.baseHalfWidthRad, true);
    off += 4;
    const vc = r.verts.length / 2;
    const packedVc = ((r.strahlerOrder & 0x0f) << 28) | (vc & 0x0fffffff);
    view.setUint32(off, packedVc >>> 0, true);
    off += 4;
    const lonSpan = Math.max(r.east - r.west, 1e-9);
    const latSpan = Math.max(r.north - r.south, 1e-9);
    for (let i = 0; i < vc; i++) {
      const qx = clamp(
        Math.round(((r.verts[i * 2] - r.west) / lonSpan) * 65535),
        0,
        65535,
      );
      const qy = clamp(
        Math.round(((r.verts[i * 2 + 1] - r.south) / latSpan) * 65535),
        0,
        65535,
      );
      view.setUint16(off, qx, true);
      view.setUint16(off + 2, qy, true);
      view.setUint16(off + 4, r.widths[i], true);
      off += 6;
    }
  }
  return out;
}

function clipPolygonsToCell(polys, minLon, minLat, maxLon, maxLat) {
  const out = [];
  for (const p of polys) {
    if (
      p.east < minLon ||
      p.west > maxLon ||
      p.north < minLat ||
      p.south > maxLat
    ) {
      continue;
    }
    const clippedRings = [];
    let cWest = Infinity;
    let cSouth = Infinity;
    let cEast = -Infinity;
    let cNorth = -Infinity;
    for (const r of p.rings) {
      const cr = clipRingToBox(r, minLon, minLat, maxLon, maxLat);
      if (cr) {
        clippedRings.push(cr);
        const vc = cr.length / 2;
        for (let i = 0; i < vc; i++) {
          const x = cr[i * 2];
          const y = cr[i * 2 + 1];
          if (x < cWest) cWest = x;
          if (x > cEast) cEast = x;
          if (y < cSouth) cSouth = y;
          if (y > cNorth) cNorth = y;
        }
      }
    }
    if (
      clippedRings.length > 0 &&
      cEast > cWest + 1e-8 &&
      cNorth > cSouth + 1e-8
    ) {
      out.push({
        west: cWest,
        south: cSouth,
        east: cEast,
        north: cNorth,
        waterTypeCode: p.waterTypeCode,
        sqrtMaxDepthQ8: p.sqrtMaxDepthQ8,
        rings: clippedRings,
      });
    }
  }
  return out;
}

function filterRiversForCell(rivers, minLon, minLat, maxLon, maxLat) {
  const out = [];
  for (const r of rivers) {
    if (
      r.east < minLon ||
      r.west > maxLon ||
      r.north < minLat ||
      r.south > maxLat
    ) {
      continue;
    }
    // Keep contiguous sub-chains that intersect the padded cell box
    const vc = r.verts.length / 2;
    const subVerts = [];
    const subWidths = [];
    let cWest = Infinity;
    let cSouth = Infinity;
    let cEast = -Infinity;
    let cNorth = -Infinity;
    for (let i = 0; i < vc; i++) {
      const x = r.verts[i * 2];
      const y = r.verts[i * 2 + 1];
      const prevIn =
        i > 0 &&
        r.verts[(i - 1) * 2] >= minLon &&
        r.verts[(i - 1) * 2] <= maxLon &&
        r.verts[(i - 1) * 2 + 1] >= minLat &&
        r.verts[(i - 1) * 2 + 1] <= maxLat;
      const nextIn =
        i + 1 < vc &&
        r.verts[(i + 1) * 2] >= minLon &&
        r.verts[(i + 1) * 2] <= maxLon &&
        r.verts[(i + 1) * 2 + 1] >= minLat &&
        r.verts[(i + 1) * 2 + 1] <= maxLat;
      const curIn = x >= minLon && x <= maxLon && y >= minLat && y <= maxLat;
      if (curIn || prevIn || nextIn) {
        subVerts.push(x, y);
        subWidths.push(r.widths[i]);
        if (x < cWest) cWest = x;
        if (x > cEast) cEast = x;
        if (y < cSouth) cSouth = y;
        if (y > cNorth) cNorth = y;
      }
    }
    if (subVerts.length >= 4) {
      out.push({
        west: cWest,
        south: Math.min(cSouth, cNorth - 1e-6),
        east: Math.max(cEast, cWest + 1e-6),
        north: cNorth,
        baseHalfWidthRad: r.baseHalfWidthRad,
        strahlerOrder: r.strahlerOrder,
        verts: new Float64Array(subVerts),
        widths: new Uint16Array(subWidths),
      });
    }
  }
  return out;
}

function extractBathySubTensor(bathyRgba, bathyW, bathyH, col, row) {
  const subW = Math.floor(bathyW / GRID_COLS); // 20
  const subH = Math.floor(bathyH / GRID_ROWS); // 20
  const out = new Uint8Array(12 + subW * subH * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC_GBT1, true);
  view.setUint16(4, subW, true);
  view.setUint16(6, subH, true);
  view.setUint32(8, 1, true);
  const payload = new Uint8Array(out.buffer, 12, subW * subH * 4);
  const startC = col * subW;
  const startR = row * subH;
  for (let r = 0; r < subH; r++) {
    const srcOff = ((startR + r) * bathyW + startC) * 4;
    const dstOff = r * subW * 4;
    payload.set(bathyRgba.subarray(srcOff, srcOff + subW * 4), dstOff);
  }
  return out;
}

function parseArgs(argv) {
  const args = { out: OUT_PATH };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const coastPolys = parseLwmPolygons(fs.readFileSync(COAST_PATH));
  const lakePolys = parseLwmPolygons(fs.readFileSync(LAKES_PATH));
  const rivers = parseNe1rRivers(fs.readFileSync(RIVERS_PATH));
  const bathyBuf = fs.readFileSync(BATHY_PATH);
  const bathyView = new DataView(
    bathyBuf.buffer,
    bathyBuf.byteOffset,
    bathyBuf.byteLength,
  );
  if (bathyView.getUint32(0, true) !== MAGIC_GBT1) {
    throw new Error("Invalid GBT1 magic in globalBathymetryTensor.bin");
  }
  const bathyW = bathyView.getUint16(4, true);
  const bathyH = bathyView.getUint16(6, true);
  const bathyRgba = new Uint8Array(
    bathyBuf.buffer,
    bathyBuf.byteOffset + 12,
    bathyW * bathyH * 4,
  );

  const totalCells = GRID_COLS * GRID_ROWS;
  const dirOffset = 16;
  const dirByteLen = totalCells * 16; // offset(u32), length(u32), flags(u32), counts(u32)
  const cellPayloads = new Array(totalCells);

  const dLon = (2.0 * Math.PI) / GRID_COLS;
  const dLat = Math.PI / GRID_ROWS;

  let currentOffset = dirOffset + dirByteLen;
  const dirEntries = new Array(totalCells);

  for (let row = 0; row < GRID_ROWS; row++) {
    const north = Math.PI * 0.5 - row * dLat;
    const south = north - dLat;
    const pSouth = Math.max(-Math.PI * 0.5, south - PAD_RAD);
    const pNorth = Math.min(Math.PI * 0.5, north + PAD_RAD);

    for (let col = 0; col < GRID_COLS; col++) {
      const west = -Math.PI + col * dLon;
      const east = west + dLon;
      const pWest = Math.max(-Math.PI, west - PAD_RAD);
      const pEast = Math.min(Math.PI, east + PAD_RAD);

      const cellCoast = clipPolygonsToCell(
        coastPolys,
        pWest,
        pSouth,
        pEast,
        pNorth,
      );
      const cellLakes = clipPolygonsToCell(
        lakePolys,
        pWest,
        pSouth,
        pEast,
        pNorth,
      );
      const cellRivers = filterRiversForCell(
        rivers,
        pWest,
        pSouth,
        pEast,
        pNorth,
      );

      const coastBytes = serializeLwm2Polygons(cellCoast);
      const lakeBytes = serializeLwm2Polygons(cellLakes);
      const riverBytes = serializeNe1rRivers(cellRivers);
      const bathyBytes = extractBathySubTensor(
        bathyRgba,
        bathyW,
        bathyH,
        col,
        row,
      );

      // Cell chunk header: 16 bytes -> coastLen(u32), lakeLen(u32), riverLen(u32), bathyLen(u32)
      const cellLen =
        16 +
        coastBytes.byteLength +
        lakeBytes.byteLength +
        riverBytes.byteLength +
        bathyBytes.byteLength;
      const cellBuf = new Uint8Array(cellLen);
      const cellHeader = new DataView(cellBuf.buffer, 0, 16);
      cellHeader.setUint32(0, coastBytes.byteLength, true);
      cellHeader.setUint32(4, lakeBytes.byteLength, true);
      cellHeader.setUint32(8, riverBytes.byteLength, true);
      cellHeader.setUint32(12, bathyBytes.byteLength, true);

      let pOff = 16;
      cellBuf.set(coastBytes, pOff);
      pOff += coastBytes.byteLength;
      cellBuf.set(lakeBytes, pOff);
      pOff += lakeBytes.byteLength;
      cellBuf.set(riverBytes, pOff);
      pOff += riverBytes.byteLength;
      cellBuf.set(bathyBytes, pOff);

      const flags =
        (cellCoast.length > 0 ? 1 : 0) |
        (cellLakes.length > 0 ? 2 : 0) |
        (cellRivers.length > 0 ? 4 : 0) |
        8; // bathymetry always present

      const cellIdx = row * GRID_COLS + col;
      cellPayloads[cellIdx] = cellBuf;
      dirEntries[cellIdx] = {
        offset: currentOffset,
        length: cellLen,
        flags,
        featureCount: cellCoast.length + cellLakes.length + cellRivers.length,
      };
      currentOffset += cellLen;
    }
  }

  const archive = new Uint8Array(currentOffset);
  const headerView = new DataView(archive.buffer, 0, dirOffset + dirByteLen);
  headerView.setUint32(0, MAGIC_CWT1, true);
  headerView.setUint16(4, GRID_COLS, true);
  headerView.setUint16(6, GRID_ROWS, true);
  headerView.setUint32(8, dirOffset, true);
  headerView.setUint32(12, totalCells, true);

  for (let i = 0; i < totalCells; i++) {
    const e = dirEntries[i];
    const dOff = dirOffset + i * 16;
    headerView.setUint32(dOff, e.offset, true);
    headerView.setUint32(dOff + 4, e.length, true);
    headerView.setUint32(dOff + 8, e.flags, true);
    headerView.setUint32(dOff + 12, e.featureCount, true);
    archive.set(cellPayloads[i], e.offset);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, archive);

  const avgCellKiB =
    (currentOffset - (dirOffset + dirByteLen)) / totalCells / 1024;
  console.log(
    `wrote ${args.out}: ${GRID_COLS}x${GRID_ROWS} (${totalCells} cells) CWT1 cloud archive, total ${(archive.byteLength / 1024).toFixed(1)} KiB (directory=${((dirOffset + dirByteLen) / 1024).toFixed(1)} KiB, avg cell=${avgCellKiB.toFixed(2)} KiB)`,
  );
}

main();
