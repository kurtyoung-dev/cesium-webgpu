#!/usr/bin/env node
// build-lake-water-mask.mjs — offline preprocess for C7-LAKE-WATER-MASK
// (WaterClassificationProvider Phase-1 seed).
// @purpose Converts Natural Earth 1:10m lakes, playas and reefs into the packed LWM2 binary bundled for LakeWaterClassificationProvider (globe.lakeWaterMask).
// @status ACTIVE
//
// Converts the Natural Earth 1:10m "Lakes + Reservoirs" polygon datasets
// (the global file PLUS the North America and Europe supplements) and the
// 1:10m playa polygons and reef lines into the compact packed-polygon binary
// bundled at
// `packages/engine/Source/Assets/WaterMask/ne10mLakes.bin` and consumed at
// runtime by `Scene/WaterClassificationProvider.ts`
// (`LakeWaterClassificationProvider`) when `globe.lakeWaterMask` is enabled.
//
// LICENSE: Natural Earth is PUBLIC DOMAIN — no attribution, no share-alike
// (https://www.naturalearthdata.com/about/terms-of-use/). Safe to preprocess
// and bundle in this MIT repository. Verified 2026-07-06 (C7 deep-research,
// 24/25 claims confirmed). The public-domain v2 upgrade path is the ~30m
// SRTMSWBD raster (research lane R-LAKE-SRTMSWBD).
//
// Format (little-endian, magic "LWM2"; the 20-byte polygon header replaces the
// LWM1 float64 bbox + uint32 ringCount, which the loaders still accept):
//   uint32 magic 0x324D574C ("LWM2")
//   uint32 polygonCount
//   per polygon (MultiPolygon parts are flattened to independent polygons,
//   each with its own bounding box for fast tile culling):
//     float32 west, south, east, north   (RADIANS, padded by 1e-7 rad)
//     uint8   waterTypeCode              (1 lake, 2 glacial/alpine, 3 rift,
//                                         4 alkaline, 5 playa, 6 wetland,
//                                         7 reservoir, 8 coral reef)
//     uint8   sqrtMaxDepthQ8             (round(sqrt(maxDepthM / 1650) * 255))
//     uint16  ringCount                  (ring 0 = outer, 1..n = holes;
//                                         runtime even-odd fill treats them
//                                         uniformly; the tool throws above 65535)
//     per ring:
//       uint32 vertexCount               (closing duplicate point removed)
//       vertexCount × (uint16 u, uint16 v)  quantized against the STORED float32
//                                            bbox (the same pattern as the coast
//                                            tool): lon = west + u/65535·(east−west)
//
// Quantization error for the largest bboxes (Caspian ≈ 10°) is ≈ 17 m —
// well inside the 1:10m dataset's own cartographic accuracy.
//
// Source pinning: the downloads read natural-earth-vector at the commit pinned in
// `Tools/lib/natural-earth-pinned.mjs`, and a download whose SHA-256 differs from
// the pinned one is refused. The bundled binary was baked from exactly those
// sources by the previous revision of this tool (a rebuild with that revision is
// byte-identical, checked 2026-10-22). This revision quantises against the
// float32 bbox instead, so its output moves vertices by up to about 1.5 m; the
// re-bake with this revision is a follow-up (DEFERRED_WORK
// NEW-WATER-NATURAL-EARTH-SOURCES-UNPINNED).
//
// Usage:
//   node Tools/build-lake-water-mask.mjs                # download + convert
//   node Tools/build-lake-water-mask.mjs --input <dir>  # use pre-downloaded
//       <dir>/ne_10m_lakes.geojson, ne_10m_lakes_north_america.geojson,
//       ne_10m_lakes_europe.geojson, ne_10m_playas.geojson and ne_10m_reefs.geojson
//   node Tools/build-lake-water-mask.mjs --out <file>   # override output path
//   node Tools/build-lake-water-mask.mjs --min-area-km2 <n>  # drop tiny lakes
import fs from "fs";
import path from "path";
import process from "process";
import {
  fetchPinnedNaturalEarthSource,
  readNaturalEarthSource,
} from "./lib/natural-earth-pinned.mjs";

const SOURCES = [
  "ne_10m_lakes.geojson",
  "ne_10m_lakes_north_america.geojson",
  "ne_10m_lakes_europe.geojson",
  "ne_10m_playas.geojson",
  "ne_10m_reefs.geojson",
];
const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "WaterMask",
  "ne10mLakes.bin",
);
const MAGIC = 0x324d574c; // "LWM2"
const RAD = Math.PI / 180.0;
const DP_TOL_DEG = 0.0008;
const MAX_RING_COUNT = 0xffff;

function dpSimplifyRing(pts, sqTol) {
  if (pts.length <= 64) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxSqDist = 0;
    let index = 0;
    const x0 = pts[first][0];
    const y0 = pts[first][1];
    const dx = pts[last][0] - x0;
    const dy = pts[last][1] - y0;
    const lenSq = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      let px = pts[i][0] - x0;
      let py = pts[i][1] - y0;
      if (lenSq > 0) {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
        px -= t * dx;
        py -= t * dy;
      }
      const d = px * px + py * py;
      if (d > maxSqDist) {
        index = i;
        maxSqDist = d;
      }
    }
    if (maxSqDist > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out.length >= 4 ? out : pts;
}

// Heuristic hydrographic classification from Natural Earth featurecla, scalerank, and basin geometry
// (latitude, elongation and area thresholds; the depths are estimates, not surveyed values):
// 1 = Freshwater Lake, 2 = Glacial/Alpine Lake, 3 = Tectonic Rift Graben,
// 4 = Alkaline/Hypersaline Lake, 5 = Intermittent Playa, 6 = Wetland/Swamp Basin,
// 7 = Reservoir, 8 = Coral Reef Platform
function classifyWaterPolygon(
  feature,
  srcName,
  west,
  south,
  east,
  north,
  areaKm2,
) {
  const props = feature.properties || {};
  const fcla = String(props.featurecla || "");
  const scalerank = Number(props.scalerank ?? 5);
  const midLat = (south + north) * 0.5;
  const absLat = Math.abs(midLat);
  const cosLat = Math.max(Math.cos(midLat * RAD), 0.1);
  const widthDeg = Math.max((east - west) * cosLat, 1e-5);
  const heightDeg = Math.max(north - south, 1e-5);
  const widthKm = widthDeg * 111.32;
  const heightKm = heightDeg * 111.32;
  const diagKmSq = widthKm * widthKm + heightKm * heightKm;
  const diagSlenderness = Math.sqrt(diagKmSq / Math.max(areaKm2, 1e-3));
  const elongation = Math.max(
    widthDeg / heightDeg,
    heightDeg / widthDeg,
    diagSlenderness * 0.92,
  );

  if (srcName.includes("reefs") || fcla.includes("Reef")) {
    return { waterTypeCode: 8, maxDepthMeters: 8.0 };
  }
  if (srcName.includes("playas") || fcla.includes("Playa")) {
    return { waterTypeCode: 5, maxDepthMeters: 1.5 };
  }
  if (fcla.includes("Alkaline")) {
    return { waterTypeCode: 4, maxDepthMeters: 35.0 };
  }
  if (fcla.includes("Reservoir")) {
    return { waterTypeCode: 7, maxDepthMeters: 45.0 };
  }
  if (areaKm2 > 1800.0 && elongation > 3.2 && absLat < 58.0) {
    return { waterTypeCode: 3, maxDepthMeters: 680.0 };
  }
  if (absLat >= 44.0 && areaKm2 < 4500.0 && elongation > 1.8) {
    return { waterTypeCode: 2, maxDepthMeters: 240.0 };
  }
  if (absLat < 32.0 && scalerank >= 3 && areaKm2 < 2500.0 && elongation < 2.2) {
    return { waterTypeCode: 6, maxDepthMeters: 4.5 };
  }
  const estDepth = Math.min(
    450.0,
    Math.max(12.0, Math.sqrt(Math.max(areaKm2, 1.0)) * 2.8),
  );
  return { waterTypeCode: 1, maxDepthMeters: estDepth };
}

function parseArgs(argv) {
  const args = { input: null, out: DEFAULT_OUT, minAreaKm2: 0 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--min-area-km2") args.minAreaKm2 = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function loadGeojson(name, inputDir) {
  const bytes = inputDir
    ? readNaturalEarthSource(path.join(inputDir, name), name)
    : await fetchPinnedNaturalEarthSource(name);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

// Approximate polygon area in km² (spherical excess is overkill for a
// filter; planar shoelace with cos(lat) longitude scaling is plenty).
function approxAreaKm2(outerRing) {
  const R = 6371.0;
  let latSum = 0;
  for (const [, lat] of outerRing) latSum += lat;
  const cosLat = Math.cos((latSum / outerRing.length) * RAD);
  let a = 0;
  for (let i = 0, n = outerRing.length; i < n; i++) {
    const [x0, y0] = outerRing[i];
    const [x1, y1] = outerRing[(i + 1) % n];
    a += (x0 * cosLat * y1 - x1 * cosLat * y0) * RAD * RAD;
  }
  return Math.abs(a * 0.5) * R * R;
}

// Convert a reef LineString (either a closed atoll ring or an open barrier-reef
// crest polyline) into a closed polygon ring in [lon, lat] degrees.
function lineStringToPolygonRing(coords, halfWidthDeg = 0.025) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (
    coords.length >= 4 &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.02
  ) {
    return coords;
  }
  const left = [];
  const right = [];
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const pPrev = coords[Math.max(0, i - 1)];
    const pNext = coords[Math.min(n - 1, i + 1)];
    const dx = pNext[0] - pPrev[0];
    const dy = pNext[1] - pPrev[1];
    const len = Math.hypot(dx, dy);
    const nx = len > 1e-9 ? -dy / len : 0.0;
    const ny = len > 1e-9 ? dx / len : 1.0;
    left.push([
      coords[i][0] + nx * halfWidthDeg,
      coords[i][1] + ny * halfWidthDeg,
    ]);
    right.push([
      coords[i][0] - nx * halfWidthDeg,
      coords[i][1] - ny * halfWidthDeg,
    ]);
  }
  right.reverse();
  const ring = left.concat(right);
  ring.push(ring[0]);
  return ring;
}

// One GeoJSON polygon (array of rings, each ring an array of [lon, lat]
// degrees) → packed record with radian bbox + uint16-quantized rings.
function packPolygon(rings, feature, srcName) {
  const sqTol = DP_TOL_DEG * DP_TOL_DEG;
  // Drop the GeoJSON closing duplicate point; the runtime rasterizer wraps.
  const cleaned = rings
    .map((ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      const closed = first[0] === last[0] && first[1] === last[1];
      const openRing = closed ? ring.slice(0, -1) : ring.slice();
      return dpSimplifyRing(openRing, sqTol);
    })
    .filter((ring) => ring.length >= 3);
  if (cleaned.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of cleaned) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  if (!(east - west > 0) || !(north - south > 0)) return null; // degenerate

  const areaKm2 = approxAreaKm2(cleaned[0]);
  const { waterTypeCode, maxDepthMeters } = classifyWaterPolygon(
    feature,
    srcName,
    west,
    south,
    east,
    north,
    areaKm2,
  );
  const sqrtMaxDepthQ8 = Math.max(
    1,
    Math.min(
      255,
      Math.round(Math.sqrt(Math.max(maxDepthMeters, 0.0) / 1650.0) * 255),
    ),
  );

  // Quantise against the exact float32 bbox that is stored (padded by 1e-7 rad),
  // as the coast tool does, so a decoded vertex carries no bbox rounding error.
  const westF32 = Math.fround(west * RAD - 1e-7);
  const southF32 = Math.fround(south * RAD - 1e-7);
  const eastF32 = Math.fround(east * RAD + 1e-7);
  const northF32 = Math.fround(north * RAD + 1e-7);
  const lonSpanRad = eastF32 - westF32;
  const latSpanRad = northF32 - southF32;
  if (!(lonSpanRad > 0) || !(latSpanRad > 0)) return null;

  const packedRings = cleaned.map((ring) => {
    const q = new Uint16Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      q[i * 2] = Math.max(
        0,
        Math.min(
          65535,
          Math.round(((ring[i][0] * RAD - westF32) / lonSpanRad) * 65535),
        ),
      );
      q[i * 2 + 1] = Math.max(
        0,
        Math.min(
          65535,
          Math.round(((ring[i][1] * RAD - southF32) / latSpanRad) * 65535),
        ),
      );
    }
    return q;
  });

  return {
    west: westF32,
    south: southF32,
    east: eastF32,
    north: northF32,
    waterTypeCode,
    sqrtMaxDepthQ8,
    rings: packedRings,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const polygons = [];
  let featureCount = 0;
  let droppedByArea = 0;

  for (const name of SOURCES) {
    const geojson = await loadGeojson(name, args.input);
    for (const feature of geojson.features) {
      const geom = feature.geometry;
      if (!geom) continue;
      let parts = [];
      if (geom.type === "Polygon") {
        parts = [geom.coordinates];
      } else if (geom.type === "MultiPolygon") {
        parts = geom.coordinates;
      } else if (geom.type === "LineString") {
        const ring = lineStringToPolygonRing(geom.coordinates);
        if (ring) parts = [[ring]];
      } else if (geom.type === "MultiLineString") {
        parts = geom.coordinates
          .map((line) => lineStringToPolygonRing(line))
          .filter(Boolean)
          .map((ring) => [ring]);
      }
      if (parts.length === 0) continue;
      featureCount++;
      for (const rings of parts) {
        if (
          args.minAreaKm2 > 0 &&
          rings.length > 0 &&
          approxAreaKm2(rings[0]) < args.minAreaKm2
        ) {
          droppedByArea++;
          continue;
        }
        const packed = packPolygon(rings, feature, name);
        if (packed) polygons.push(packed);
      }
    }
  }

  // Serialize LWM2: float32[4] bbox (16B) + uint8 waterTypeCode + uint8 sqrtMaxDepthQ8 + uint16 ringCount (4B) = 20B header per polygon.
  let byteLength = 8; // magic + polygonCount
  for (const p of polygons) {
    byteLength += 4 * 4 + 4; // float32[4] bbox + metadata/ringCount
    for (const ring of p.rings) byteLength += 4 + ring.length * 2;
  }
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  let o = 0;
  view.setUint32(o, MAGIC, true);
  o += 4;
  view.setUint32(o, polygons.length, true);
  o += 4;
  for (const p of polygons) {
    view.setFloat32(o, p.west, true);
    view.setFloat32(o + 4, p.south, true);
    view.setFloat32(o + 8, p.east, true);
    view.setFloat32(o + 12, p.north, true);
    o += 16;
    view.setUint8(o, p.waterTypeCode);
    view.setUint8(o + 1, p.sqrtMaxDepthQ8);
    if (p.rings.length > MAX_RING_COUNT) {
      throw new Error(
        `LWM2 ringCount is uint16: a polygon has ${p.rings.length} rings (max ${MAX_RING_COUNT})`,
      );
    }
    view.setUint16(o + 2, p.rings.length, true);
    o += 4;
    for (const ring of p.rings) {
      const vertexCount = ring.length / 2;
      view.setUint32(o, vertexCount, true);
      o += 4;
      for (let i = 0; i < ring.length; i++) {
        view.setUint16(o, ring[i], true);
        o += 2;
      }
    }
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, Buffer.from(buffer));
  console.log(
    `wrote ${args.out}: ${polygons.length} polygons from ${featureCount} features` +
      ` (${droppedByArea} parts dropped by --min-area-km2 ${args.minAreaKm2}),` +
      ` ${(byteLength / 1024).toFixed(0)} KiB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
