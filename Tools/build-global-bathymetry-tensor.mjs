#!/usr/bin/env node
/**
 * @purpose Bakes the 0.5-degree PROCEDURAL depth-and-optics prior (GBT1 RGBA8 tensor) from the coast, lake, river and EGM2008 geoid assets.
 * @status ACTIVE
 *
 * Builds the bundled global depth-and-optics tensor asset
 * (`packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin`) from:
 *   1. `Assets/WaterMask/ne50mCoastlines.bin` (7,897 land/island/ice-shelf polygons -> 2D Euclidean coastal distance)
 *   2. `Assets/Geoid/egm2008-0p5deg.i16` (721x361 EGM2008 geoid undulation & its discrete Laplacian)
 *   3. `Assets/WaterMask/ne10mLakes.bin` (4,421 polygons including 1,043 coral reef tracts & inland basins)
 *   4. `Assets/WaterMask/ne10mRivers.bin` (1,993 rivers -> scalerank-weighted estuarine sediment plumes & delta fans)
 *
 * WHAT THIS IS NOT. The output is a PROCEDURAL PRIOR, not survey data and not
 * GEBCO or ETOPO. Depth is a formula of distance-to-coast (in 0.5-degree grid
 * units, ignoring cos(lat)) plus the geoid Laplacian; tidal range, Jerlov water
 * type and substrate are rules of the same inputs. Trench and ridge depths are
 * therefore approximate shapes, not measurements, and its land cells carry
 * shelf-start values, so a consumer must gate on the water mask. The only third-party inputs are Natural Earth and
 * EGM2008. The tool is deterministic: the shipped file equals this tool run on the
 * shipped coast, lake, river and geoid files (pinned by
 * `Tools/visual-regression/water-mask-assets.spec.mjs`).
 *
 * Usage:
 *   node Tools/build-global-bathymetry-tensor.mjs                # rewrite the bundled file
 *   node Tools/build-global-bathymetry-tensor.mjs --out <file>   # write elsewhere
 *
 * Binary format (`GBT1`, little-endian):
 *   - uint32 magic: 0x31544247 ("GBT1")
 *   - uint16 width: 720 (0.5 deg longitude step)
 *   - uint16 height: 360 (0.5 deg latitude step)
 *   - uint32 flags: 1 (RGBA8 encoded: R=sqrtDepth, G=JerlovType, B=SubstrateType, A=TidalRange)
 *   - Uint8Array[width * height * 4]: row-major north-to-south, -180 to +180 deg
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
const GEOID_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/Geoid/egm2008-0p5deg.i16",
);
const OUT_PATH = path.join(
  ROOT,
  "packages/engine/Source/Assets/WaterMask/globalBathymetryTensor.bin",
);

const MAGIC_GBT1 = 0x31544247; // "GBT1"
const MAGIC_LWM1 = 0x314d574c;
const MAGIC_LWM2 = 0x324d574c;
const MAGIC_NE1R = 0x5231454e;

const WIDTH = 720;
const HEIGHT = 360;
const BATHYMETRY_MAX_DEPTH_M = 11000.0;
const MAX_TIDAL_RANGE_M = 16.0;

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function encodeDepth(depthMeters) {
  const clamped = clamp(depthMeters, 0.0, BATHYMETRY_MAX_DEPTH_M);
  return Math.round(Math.sqrt(clamped / BATHYMETRY_MAX_DEPTH_M) * 255);
}

function encodeJerlovType(typeIndex) {
  return Math.round((clamp(typeIndex, 0, 9) / 9.0) * 255);
}

function encodeSubstrate(substrateIndex) {
  return Math.round((clamp(substrateIndex, 0, 4) / 4.0) * 255);
}

function encodeTidalRange(tidalRangeMeters) {
  return Math.round(
    (clamp(tidalRangeMeters, 0.0, MAX_TIDAL_RANGE_M) / MAX_TIDAL_RANGE_M) * 255,
  );
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
    for (let i = 0; i < vc; i++) {
      verts[i * 2] = west + view.getUint16(off, true) * lonSpan;
      verts[i * 2 + 1] = south + view.getUint16(off + 2, true) * latSpan;
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
    };
  }
  return rivers;
}

function rasterizePolygonsToGrid(polys, grid, w, h, fillValueFn) {
  const west = -Math.PI;
  const north = Math.PI * 0.5;
  const dLon = (2.0 * Math.PI) / w;
  const dLat = Math.PI / h;

  for (const poly of polys) {
    const rMin = Math.max(0, Math.floor((north - poly.north) / dLat - 1));
    const rMax = Math.min(h - 1, Math.ceil((north - poly.south) / dLat + 1));
    const rows = new Array(rMax - rMin + 1);
    for (const ring of poly.rings) {
      const vc = ring.length / 2;
      for (let i = 0; i < vc; i++) {
        const j = (i + 1) % vc;
        const x0 = ring[i * 2];
        const y0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const y1 = ring[j * 2 + 1];
        if (y0 === y1) continue;
        const yLow = Math.min(y0, y1);
        const yHigh = Math.max(y0, y1);
        const r0 = Math.max(rMin, Math.ceil((north - yHigh) / dLat - 0.5));
        const r1 = Math.min(rMax, Math.floor((north - yLow) / dLat - 0.5));
        const invDy = 1.0 / (y1 - y0);
        for (let r = r0; r <= r1; r++) {
          const lat = north - (r + 0.5) * dLat;
          if ((y0 <= lat && y1 > lat) || (y1 <= lat && y0 > lat)) {
            const lon = x0 + (lat - y0) * invDy * (x1 - x0);
            (rows[r - rMin] ??= []).push(lon);
          }
        }
      }
    }
    const val = fillValueFn(poly);
    for (let r = rMin; r <= rMax; r++) {
      const crossings = rows[r - rMin];
      if (!crossings || crossings.length < 2) continue;
      crossings.sort((a, b) => a - b);
      const pairCount = crossings.length - (crossings.length % 2);
      const rowOff = r * w;
      for (let k = 0; k < pairCount; k += 2) {
        const c0 = Math.max(0, Math.ceil((crossings[k] - west) / dLon - 0.5));
        const c1 = Math.min(
          w - 1,
          Math.ceil((crossings[k + 1] - west) / dLon - 0.5) - 1,
        );
        for (let c = c0; c <= c1; c++) {
          grid[rowOff + c] = val;
        }
      }
    }
  }
}

function edt1d(f, d, v, z, n) {
  const INF = 1e12;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let vk = v[k];
    let s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const vk = v[k];
    const dx = q - vk;
    d[q] = dx * dx + f[vk];
  }
}

function computeDistanceTransform2D(binaryMask, w, h) {
  const INF = 1e12;
  const distSq = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    distSq[i] = binaryMask[i] ? 0.0 : INF;
  }
  const maxDim = Math.max(w * 2, h);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  // Horizontal pass with periodic wrap across +-180 deg
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w * 2; x++) {
      f[x] = distSq[rowOff + (x % w)];
    }
    edt1d(f, d, v, z, w * 2);
    for (let x = 0; x < w; x++) {
      distSq[rowOff + x] = Math.min(d[x], d[x + w]);
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      f[y] = distSq[y * w + x];
    }
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) {
      distSq[y * w + x] = d[y];
    }
  }
  return distSq;
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
  const geoidBuf = fs.readFileSync(GEOID_PATH);
  const geoidView = new DataView(
    geoidBuf.buffer,
    geoidBuf.byteOffset,
    geoidBuf.byteLength,
  );
  const geoidW = 721;
  const geoidH = 361;

  // 1. Rasterize land mask (1 = land, 0 = ocean)
  const landMask = new Uint8Array(WIDTH * HEIGHT);
  rasterizePolygonsToGrid(coastPolys, landMask, WIDTH, HEIGHT, () => 1);

  // Also mark coastline border cells so small islands register in the 0.5-deg grid
  for (const poly of coastPolys) {
    for (const ring of poly.rings) {
      const vc = ring.length / 2;
      for (let i = 0; i < vc; i++) {
        const lon = ring[i * 2];
        const lat = ring[i * 2 + 1];
        const c = clamp(
          Math.floor(((lon + Math.PI) / (2.0 * Math.PI)) * WIDTH),
          0,
          WIDTH - 1,
        );
        const r = clamp(
          Math.floor(((Math.PI * 0.5 - lat) / Math.PI) * HEIGHT),
          0,
          HEIGHT - 1,
        );
        landMask[r * WIDTH + c] = 1;
      }
    }
  }

  // 2. Compute 2D Euclidean distance to nearest coastline in grid texels (1 texel = 0.5 deg ~ 55.6 km)
  const distToLandSq = computeDistanceTransform2D(landMask, WIDTH, HEIGHT);

  // 3. Rasterize coral reefs and inland lakes from ne10mLakes.bin
  const reefMask = new Uint8Array(WIDTH * HEIGHT);
  const lakeDepthGrid = new Float32Array(WIDTH * HEIGHT);
  const lakeTypeGrid = new Uint8Array(WIDTH * HEIGHT);

  for (const poly of lakePolys) {
    const maxDepth = Math.pow(poly.sqrtMaxDepthQ8 / 255.0, 2) * 1650.0;
    const midLon = (poly.west + poly.east) * 0.5;
    const midLat = (poly.south + poly.north) * 0.5;
    const cCenter = clamp(
      Math.floor(((midLon + Math.PI) / (2.0 * Math.PI)) * WIDTH),
      0,
      WIDTH - 1,
    );
    const rCenter = clamp(
      Math.floor(((Math.PI * 0.5 - midLat) / Math.PI) * HEIGHT),
      0,
      HEIGHT - 1,
    );
    if (poly.waterTypeCode === 8) {
      reefMask[rCenter * WIDTH + cCenter] = 1;
      for (const ring of poly.rings) {
        const vc = ring.length / 2;
        for (let i = 0; i < vc; i++) {
          const c = clamp(
            Math.floor(((ring[i * 2] + Math.PI) / (2.0 * Math.PI)) * WIDTH),
            0,
            WIDTH - 1,
          );
          const r = clamp(
            Math.floor(((Math.PI * 0.5 - ring[i * 2 + 1]) / Math.PI) * HEIGHT),
            0,
            HEIGHT - 1,
          );
          reefMask[r * WIDTH + c] = 1;
        }
      }
    } else {
      const idx = rCenter * WIDTH + cCenter;
      if (maxDepth > lakeDepthGrid[idx]) {
        lakeDepthGrid[idx] = maxDepth;
        lakeTypeGrid[idx] = poly.waterTypeCode;
      }
    }
  }
  rasterizePolygonsToGrid(
    lakePolys.filter((p) => p.waterTypeCode !== 8),
    lakeTypeGrid,
    WIDTH,
    HEIGHT,
    (p) => p.waterTypeCode,
  );
  rasterizePolygonsToGrid(
    lakePolys.filter((p) => p.waterTypeCode !== 8),
    lakeDepthGrid,
    WIDTH,
    HEIGHT,
    (p) => Math.pow(p.sqrtMaxDepthQ8 / 255.0, 2) * 1650.0,
  );

  // 4. Accumulate river estuarine sediment plumes at river mouths (last vertex of each river)
  const riverPlumeGrid = new Float32Array(WIDTH * HEIGHT);
  for (const river of rivers) {
    const vc = river.verts.length / 2;
    if (vc < 2) continue;
    const mouthLon = river.verts[(vc - 1) * 2];
    const mouthLat = river.verts[(vc - 1) * 2 + 1];
    const cMouth = clamp(
      Math.floor(((mouthLon + Math.PI) / (2.0 * Math.PI)) * WIDTH),
      0,
      WIDTH - 1,
    );
    const rMouth = clamp(
      Math.floor(((Math.PI * 0.5 - mouthLat) / Math.PI) * HEIGHT),
      0,
      HEIGHT - 1,
    );
    const plumeStrength = clamp((river.strahlerOrder - 3) / 9.0, 0.15, 1.0);
    const radiusCells = Math.ceil(plumeStrength * 4);
    for (let dr = -radiusCells; dr <= radiusCells; dr++) {
      const rr = clamp(rMouth + dr, 0, HEIGHT - 1);
      for (let dc = -radiusCells; dc <= radiusCells; dc++) {
        const cc = (cMouth + dc + WIDTH) % WIDTH;
        const dist = Math.hypot(dc, dr);
        if (dist <= radiusCells) {
          const w = plumeStrength * (1.0 - dist / (radiusCells + 0.5));
          const idx = rr * WIDTH + cc;
          if (w > riverPlumeGrid[idx]) riverPlumeGrid[idx] = w;
        }
      }
    }
  }

  // 5. Synthesize RGBA8 geophysical bathymetry tensor
  const outBytes = new Uint8Array(12 + WIDTH * HEIGHT * 4);
  const outHeader = new DataView(outBytes.buffer, 0, 12);
  outHeader.setUint32(0, MAGIC_GBT1, true);
  outHeader.setUint16(4, WIDTH, true);
  outHeader.setUint16(6, HEIGHT, true);
  outHeader.setUint32(8, 1, true);

  const rgba = new Uint8Array(outBytes.buffer, 12, WIDTH * HEIGHT * 4);

  for (let r = 0; r < HEIGHT; r++) {
    const latDeg = 90.0 - (r + 0.5) * 0.5;
    const absLat = Math.abs(latDeg);
    const gRow = clamp(r, 0, geoidH - 1);
    const gRowN = clamp(r - 1, 0, geoidH - 1);
    const gRowS = clamp(r + 1, 0, geoidH - 1);

    for (let c = 0; c < WIDTH; c++) {
      const idx = r * WIDTH + c;
      const gCol = clamp(c, 0, geoidW - 1);
      const gColW = (c - 1 + WIDTH) % WIDTH;
      const gColE = (c + 1) % WIDTH;

      // Geoid undulation in meters and discrete 5-point Laplacian (gravity gradient proxy)
      const nCenter =
        geoidView.getInt16((gRow * geoidW + gCol) * 2, true) * 0.01;
      const nNorth =
        geoidView.getInt16((gRowN * geoidW + gCol) * 2, true) * 0.01;
      const nSouth =
        geoidView.getInt16((gRowS * geoidW + gCol) * 2, true) * 0.01;
      const nWest =
        geoidView.getInt16((gRow * geoidW + gColW) * 2, true) * 0.01;
      const nEast =
        geoidView.getInt16((gRow * geoidW + gColE) * 2, true) * 0.01;
      const geoidLaplacian = nNorth + nSouth + nWest + nEast - 4.0 * nCenter;
      const geoidSlope = Math.hypot(nEast - nWest, nNorth - nSouth);

      const distCells = Math.sqrt(distToLandSq[idx]);
      const distKm = distCells * 55.6;
      const plume = riverPlumeGrid[idx];
      const isReef = reefMask[idx] === 1;
      const lakeType = lakeTypeGrid[idx];

      // Every branch below assigns all four.
      let depthM;
      let jerlov;
      let substrate;
      let tidalRange;

      if (lakeType > 0) {
        depthM = Math.max(2.5, lakeDepthGrid[idx] || 28.0);
        if (lakeType === 2) {
          // Glacial / Alpine
          jerlov = 1;
          substrate = 3;
          tidalRange = 0.05;
        } else if (lakeType === 3) {
          // Tectonic Rift
          jerlov = 0;
          substrate = 3;
          tidalRange = 0.05;
        } else if (lakeType === 4 || lakeType === 5) {
          // Endorheic / Playa
          jerlov = 6;
          substrate = 0;
          tidalRange = 0.02;
        } else if (lakeType === 6) {
          // Wetland / Swamp
          jerlov = 9;
          substrate = 1;
          tidalRange = 0.1;
        } else {
          jerlov = 5;
          substrate = 1;
          tidalRange = 0.08;
        }
      } else if (isReef) {
        depthM = clamp(4.0 + distCells * 6.0, 2.5, 28.0);
        jerlov = 1; // TYPE_IA
        substrate = 2; // CORAL_REEF
        tidalRange = 1.6;
      } else {
        // Active vs passive continental margin shelf width from geoid slope
        const shelfWidthKm = clamp(
          185.0 - geoidSlope * 18.0 + plume * 95.0,
          35.0,
          280.0,
        );
        const slopeWidthKm = shelfWidthKm + 190.0;

        if (distKm <= shelfWidthKm) {
          const t = distKm / Math.max(shelfWidthKm, 1.0);
          depthM = 4.0 + Math.pow(t, 1.35) * 196.0;
          substrate = plume > 0.25 ? 1 : absLat < 30.0 && t < 0.45 ? 2 : 0;
          jerlov = Math.round(clamp(7.0 - t * 3.0 + plume * 2.5, 3, 9));
          const latTidal = Math.max(
            0.25,
            Math.cos((absLat - 45.0) * (Math.PI / 90.0)),
          );
          tidalRange = clamp(
            1.8 + (1.0 - t) * 4.8 * latTidal + plume * 1.4,
            0.5,
            14.5,
          );
        } else if (distKm <= slopeWidthKm) {
          const t = (distKm - shelfWidthKm) / 190.0;
          depthM = 200.0 + Math.pow(t, 1.2) * 3400.0;
          substrate = t < 0.5 ? 1 : 4;
          jerlov = Math.round(clamp(4.0 - t * 2.0 + plume * 1.5, 1, 6));
          tidalRange = clamp(1.6 * (1.0 - t) + 0.5, 0.4, 3.0);
        } else {
          // Open ocean: abyssal plain modulated by EGM2008 geoid Laplacian (trenches vs mid-ocean ridges)
          const trenchBoost = clamp(
            Math.max(0.0, -geoidLaplacian - 0.08) * 320.0,
            0.0,
            6200.0,
          );
          const ridgeLift = clamp(
            Math.max(0.0, geoidLaplacian - 0.08) * 160.0,
            0.0,
            1350.0,
          );
          depthM = clamp(
            3950.0 + trenchBoost - ridgeLift + (nCenter < -25.0 ? 650.0 : 0.0),
            2600.0,
            10920.0,
          );
          substrate = depthM > 5800.0 || ridgeLift > 450.0 ? 3 : 4;
          jerlov = absLat < 32.0 && distKm > 650.0 ? 0 : absLat > 52.0 ? 3 : 1;
          tidalRange = 0.45;
        }
      }

      const o4 = idx * 4;
      rgba[o4] = encodeDepth(depthM);
      rgba[o4 + 1] = encodeJerlovType(jerlov);
      rgba[o4 + 2] = encodeSubstrate(substrate);
      rgba[o4 + 3] = encodeTidalRange(tidalRange);
    }
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, outBytes);
  console.log(
    `wrote ${args.out}: ${WIDTH}x${HEIGHT} RGBA8 procedural depth-and-optics prior (${(outBytes.byteLength / 1024).toFixed(1)} KiB)`,
  );
}

main();
