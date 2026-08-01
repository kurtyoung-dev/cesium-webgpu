#!/usr/bin/env node
// build-lake-water-mask.mjs — offline preprocess for C7-LAKE-WATER-MASK
// (WaterClassificationProvider Phase-1 seed).
//
// Converts the Natural Earth 1:10m "Lakes + Reservoirs" polygon datasets
// (the global file PLUS the North America supplement) into the compact
// packed-polygon binary bundled at
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
// Format (little-endian, magic "LWM1"):
//   uint32 magic 0x314D574C ("LWM1")
//   uint32 polygonCount
//   per polygon (MultiPolygon parts are flattened to independent polygons,
//   each with its own bounding box for fast tile culling):
//     float64 west, south, east, north   (RADIANS)
//     uint32  ringCount                  (ring 0 = outer, 1..n = holes;
//                                         runtime even-odd fill treats them
//                                         uniformly)
//     per ring:
//       uint32 vertexCount               (closing duplicate point removed)
//       vertexCount × (uint16 u, uint16 v)  quantized against the polygon
//                                            bbox: lon = west + u/65535·(east−west)
//
// Quantization error for the largest bboxes (Caspian ≈ 10°) is ≈ 17 m —
// well inside the 1:10m dataset's own cartographic accuracy.
//
// Usage:
//   node Tools/build-lake-water-mask.mjs                # download + convert
//   node Tools/build-lake-water-mask.mjs --input <dir>  # use pre-downloaded
//       <dir>/ne_10m_lakes.geojson and <dir>/ne_10m_lakes_north_america.geojson
//   node Tools/build-lake-water-mask.mjs --out <file>   # override output path
//   node Tools/build-lake-water-mask.mjs --min-area-km2 <n>  # drop tiny lakes
import fs from "fs";
import path from "path";
import process from "process";

const SOURCES = ["ne_10m_lakes.geojson", "ne_10m_lakes_north_america.geojson"];
const BASE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "WaterMask",
  "ne10mLakes.bin",
);
const MAGIC = 0x314d574c; // "LWM1"
const RAD = Math.PI / 180.0;

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
  if (inputDir) {
    const p = path.join(inputDir, name);
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  const url = BASE_URL + name;
  console.log(`downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
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

// One GeoJSON polygon (array of rings, each ring an array of [lon, lat]
// degrees) → packed record with radian bbox + uint16-quantized rings.
function packPolygon(rings) {
  // Drop the GeoJSON closing duplicate point; the runtime rasterizer wraps.
  const cleaned = rings
    .map((ring) => {
      const first = ring[0];
      const last = ring[ring.length - 1];
      const closed = first[0] === last[0] && first[1] === last[1];
      return closed ? ring.slice(0, -1) : ring.slice();
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
  const lonSpan = east - west;
  const latSpan = north - south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null; // degenerate

  const packedRings = cleaned.map((ring) => {
    const q = new Uint16Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      q[i * 2] = Math.round(((ring[i][0] - west) / lonSpan) * 65535);
      q[i * 2 + 1] = Math.round(((ring[i][1] - south) / latSpan) * 65535);
    }
    return q;
  });

  return {
    west: west * RAD,
    south: south * RAD,
    east: east * RAD,
    north: north * RAD,
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
      const parts =
        geom.type === "Polygon"
          ? [geom.coordinates]
          : geom.type === "MultiPolygon"
            ? geom.coordinates
            : [];
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
        const packed = packPolygon(rings);
        if (packed) polygons.push(packed);
      }
    }
  }

  // Serialize.
  let byteLength = 8; // magic + polygonCount
  for (const p of polygons) {
    byteLength += 4 * 8 + 4; // bbox + ringCount
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
    view.setFloat64(o, p.west, true);
    view.setFloat64(o + 8, p.south, true);
    view.setFloat64(o + 16, p.east, true);
    view.setFloat64(o + 24, p.north, true);
    o += 32;
    view.setUint32(o, p.rings.length, true);
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
