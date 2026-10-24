#!/usr/bin/env node
// build-global-river-binary.mjs
// @purpose Generates the packed NE1R global river & delta centerlines binary (packages/engine/Source/Assets/WaterMask/ne10mRivers.bin) for RiverWaterClassificationProvider.
// @status ACTIVE
//
// Converts the Natural Earth 1:10m rivers + lake centerlines (PUBLIC DOMAIN) plus
// the 22 embedded CANONICAL_WORLD_RIVERS trunks into the compact NE1R binary
// (`packages/engine/Source/Assets/WaterMask/ne10mRivers.bin`) consumed by
// `RiverWaterClassificationProvider` (`globe.riverWaterMask`).
//
// The 22 canonical trunks are AUTHORED approximations: their coordinate tables and
// mouth half-widths were typed in by hand in this repository and are not generated
// from Natural Earth by this tool. Only the records added from the downloaded or
// `--input` file are Natural Earth data.
//
// Failure behaviour: the build never writes a silent canonical-only file. If the
// Natural Earth download fails (or `--input` cannot be read) the tool prints the
// error and exits non-zero without writing. A canonical-only file is written only
// when `--fallback-canonical` is passed, and the tool prints a banner saying so.
//
// Source pinning: the download reads natural-earth-vector at the commit pinned in
// `Tools/lib/natural-earth-pinned.mjs`, and a download whose SHA-256 differs from
// the pinned one is refused. The bundled binary was baked from exactly that
// source by the previous revision of this tool (a rebuild with that revision is
// byte-identical, checked 2026-10-22). This revision tapers the width of the
// authored trunks only, so its output differs; the re-bake with this revision is
// a follow-up (DEFERRED_WORK NEW-WATER-NATURAL-EARTH-SOURCES-UNPINNED). A local
// --input that is not the pinned file is built with a warning.
//
// Usage:
//   node Tools/build-global-river-binary.mjs                      # download + convert
//   node Tools/build-global-river-binary.mjs --input <file>       # a local
//       ne_10m_rivers_lake_centerlines.geojson (offline rebuild)
//   node Tools/build-global-river-binary.mjs --out <file>         # override output path
//   node Tools/build-global-river-binary.mjs --fallback-canonical # 22 authored trunks only
//
// Width taper: the 0.3 -> 1.0 downstream width ramp is applied to the authored
// trunks only (each runs headwater to mouth). A Natural Earth piece is a fragment
// of a river with no known direction, so it keeps one constant width.
//
// Format (little-endian, magic "NE1R" = 0x5231454E):
//   uint32 magic 0x5231454E ("NE1R")
//   uint32 riverCount
//   per river segment:
//     float64 west, south, east, north   (RADIANS, padded by max halfWidthRad)
//     float32 baseHalfWidthRad           (RADIANS, mouth/trunk half-width)
//     uint32  vertexCount
//     vertexCount × (uint16 u, uint16 v, uint16 widthScaleQ16)
//       6 bytes/vertex:
//         lon = west + (u / 65535) * (east - west)
//         lat = south + (v / 65535) * (north - south)
//         halfWidthRad = baseHalfWidthRad * (widthScaleQ16 / 65535)

import fs from "node:fs";
import path from "node:path";
import {
  fetchPinnedNaturalEarthSource,
  readNaturalEarthSource,
} from "./lib/natural-earth-pinned.mjs";

const MAGIC_NE1R = 0x5231454e; // "NE1R"
const RAD = Math.PI / 180.0;
const EARTH_RADIUS_M = 6378137.0;

const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "WaterMask",
  "ne10mRivers.bin",
);

/**
 * Authored major world river trunks and distributaries (hand-typed approximations;
 * see the file header for provenance). Coordinates are [lonDeg, latDeg] ordered from
 * headwaters to mouth/delta so channel width tapers naturally from source to estuary.
 */
const CANONICAL_WORLD_RIVERS = [
  {
    name: "Amazon Mainstem",
    mouthHalfWidthMeters: 6500,
    coords: [
      [-73.25, -3.75],
      [-70.02, -4.22],
      [-67.95, -3.15],
      [-65.1, -2.55],
      [-62.6, -3.8],
      [-60.15, -3.26],
      [-59.95, -3.175],
      [-59.75, -3.11],
      [-59.45, -3.13],
      [-58.45, -3.12],
      [-56.73, -2.4],
      [-55.5, -2.1],
      [-54.71, -2.42],
      [-52.95, -1.75],
      [-51.2, -1.15],
      [-50.1, -0.15],
    ],
  },
  {
    name: "Rio Negro",
    mouthHalfWidthMeters: 4200,
    coords: [
      [-64.0, -0.5],
      [-61.8, -1.9],
      [-60.75, -2.85],
      [-60.48, -3.02],
      [-60.18, -3.1],
      [-59.95, -3.16],
    ],
  },
  {
    name: "Amazon South Delta (Para)",
    mouthHalfWidthMeters: 5200,
    coords: [
      [-52.95, -1.75],
      [-51.4, -1.85],
      [-49.8, -1.72],
      [-48.5, -1.45],
      [-48.0, -0.75],
    ],
  },
  {
    name: "Nile Mainstem",
    mouthHalfWidthMeters: 1800,
    coords: [
      [32.88, 0.42],
      [32.3, 2.25],
      [31.58, 4.85],
      [31.65, 9.52],
      [32.75, 13.18],
      [32.53, 15.6],
      [33.98, 17.68],
      [31.8, 18.55],
      [30.5, 19.15],
      [31.38, 21.85],
      [32.89, 24.09],
      [32.65, 25.7],
      [31.18, 27.18],
      [31.23, 30.05],
      [30.36, 31.45],
    ],
  },
  {
    name: "Nile Damietta Delta Branch",
    mouthHalfWidthMeters: 1400,
    coords: [
      [31.23, 30.05],
      [31.38, 30.72],
      [31.81, 31.51],
    ],
  },
  {
    name: "Mississippi Mainstem",
    mouthHalfWidthMeters: 2400,
    coords: [
      [-95.2, 47.24],
      [-93.26, 44.98],
      [-91.25, 43.8],
      [-90.58, 41.51],
      [-90.19, 38.63],
      [-89.15, 36.98],
      [-90.05, 35.15],
      [-91.05, 33.4],
      [-91.4, 31.55],
      [-91.19, 30.45],
      [-90.07, 29.95],
      [-89.25, 29.15],
    ],
  },
  {
    name: "Atchafalaya River",
    mouthHalfWidthMeters: 2200,
    coords: [
      [-91.8, 30.98],
      [-91.68, 30.45],
      [-91.52, 30.05],
      [-91.457, 29.875],
      [-91.38, 29.68],
      [-91.28, 29.48],
    ],
  },
  {
    name: "Missouri River",
    mouthHalfWidthMeters: 1500,
    coords: [
      [-111.5, 45.93],
      [-108.5, 47.6],
      [-104.0, 48.0],
      [-100.78, 46.81],
      [-97.4, 42.85],
      [-95.86, 41.26],
      [-94.58, 39.1],
      [-92.17, 38.58],
      [-90.19, 38.82],
    ],
  },
  {
    name: "Yangtze (Chang Jiang)",
    mouthHalfWidthMeters: 4200,
    coords: [
      [97.2, 33.0],
      [101.7, 26.55],
      [104.62, 28.77],
      [106.55, 29.56],
      [108.4, 30.8],
      [111.28, 30.69],
      [113.1, 29.45],
      [114.3, 30.59],
      [116.0, 29.72],
      [117.65, 30.95],
      [118.78, 32.06],
      [120.88, 31.98],
      [121.85, 31.45],
    ],
  },
  {
    name: "Ganges-Padma-Meghna",
    mouthHalfWidthMeters: 4800,
    coords: [
      [78.16, 29.95],
      [80.33, 26.45],
      [81.85, 25.43],
      [83.01, 25.32],
      [85.14, 25.61],
      [87.95, 24.8],
      [89.7, 23.85],
      [90.65, 23.15],
      [90.82, 22.35],
    ],
  },
  {
    name: "Brahmaputra-Jamuna",
    mouthHalfWidthMeters: 4200,
    coords: [
      [91.1, 29.3],
      [94.3, 29.5],
      [95.3, 27.8],
      [93.7, 26.65],
      [91.74, 26.19],
      [89.95, 25.75],
      [89.7, 23.85],
    ],
  },
  {
    name: "Danube",
    mouthHalfWidthMeters: 1600,
    coords: [
      [9.99, 48.4],
      [12.1, 49.02],
      [14.29, 48.31],
      [16.37, 48.21],
      [17.11, 48.15],
      [19.04, 47.5],
      [18.88, 45.55],
      [20.45, 44.82],
      [22.67, 44.63],
      [25.97, 43.85],
      [28.03, 45.43],
      [29.68, 45.16],
    ],
  },
  {
    name: "Rhine",
    mouthHalfWidthMeters: 1200,
    coords: [
      [9.52, 47.15],
      [7.59, 47.56],
      [7.79, 48.58],
      [8.27, 50.0],
      [7.6, 50.36],
      [6.96, 50.94],
      [6.77, 51.23],
      [5.86, 51.85],
      [4.48, 51.9],
      [4.1, 51.98],
    ],
  },
  {
    name: "Mekong",
    mouthHalfWidthMeters: 2800,
    coords: [
      [100.1, 20.35],
      [102.13, 19.89],
      [102.6, 17.97],
      [104.8, 16.55],
      [105.8, 15.12],
      [105.95, 13.95],
      [104.92, 11.56],
      [105.8, 10.25],
      [106.65, 9.8],
    ],
  },
  {
    name: "Congo",
    mouthHalfWidthMeters: 4500,
    coords: [
      [25.88, -1.95],
      [25.2, 0.52],
      [21.5, 2.15],
      [18.28, 0.05],
      [16.18, -3.15],
      [15.27, -4.32],
      [13.45, -5.85],
      [12.4, -6.05],
    ],
  },
  {
    name: "Parana-Rio de la Plata",
    mouthHalfWidthMeters: 4800,
    coords: [
      [-51.4, -20.4],
      [-54.58, -25.52],
      [-58.83, -27.47],
      [-60.53, -31.73],
      [-60.64, -32.95],
      [-58.4, -34.35],
      [-57.5, -34.85],
    ],
  },
  {
    name: "Volga",
    mouthHalfWidthMeters: 2200,
    coords: [
      [35.9, 56.86],
      [39.87, 57.63],
      [44.0, 56.33],
      [49.12, 55.79],
      [49.4, 53.5],
      [46.03, 51.53],
      [44.51, 48.71],
      [48.04, 46.35],
      [47.9, 45.75],
    ],
  },
  {
    name: "St. Lawrence",
    mouthHalfWidthMeters: 3800,
    coords: [
      [-76.3, 44.23],
      [-74.8, 45.0],
      [-73.56, 45.51],
      [-72.55, 46.35],
      [-71.21, 46.81],
      [-69.7, 47.85],
      [-68.5, 48.6],
      [-66.4, 49.45],
    ],
  },
  {
    name: "Columbia",
    mouthHalfWidthMeters: 2100,
    coords: [
      [-117.8, 48.6],
      [-119.9, 47.4],
      [-119.2, 45.93],
      [-121.18, 45.6],
      [-122.68, 45.62],
      [-123.83, 46.19],
    ],
  },
  {
    name: "Niger",
    mouthHalfWidthMeters: 2400,
    coords: [
      [-9.3, 11.4],
      [-8.0, 12.65],
      [-4.2, 16.25],
      [-1.5, 16.95],
      [2.11, 13.51],
      [4.65, 9.8],
      [6.73, 7.8],
      [6.45, 5.4],
      [6.05, 4.32],
    ],
  },
  {
    name: "Orinoco",
    mouthHalfWidthMeters: 3400,
    coords: [
      [-67.6, 5.65],
      [-67.45, 7.89],
      [-65.4, 7.65],
      [-63.55, 8.12],
      [-62.65, 8.35],
      [-60.85, 8.6],
    ],
  },
  {
    name: "Thames Estuary",
    mouthHalfWidthMeters: 1600,
    coords: [
      [-1.25, 51.75],
      [-0.97, 51.46],
      [-0.48, 51.44],
      [-0.12, 51.5],
      [0.37, 51.45],
      [0.82, 51.49],
    ],
  },
];

function densifyCoords(coords, maxStepDeg = 0.25) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon0, lat0] = coords[i];
    const [lon1, lat1] = coords[i + 1];
    const dist = Math.hypot(lon1 - lon0, lat1 - lat0);
    const steps = Math.max(1, Math.ceil(dist / maxStepDeg));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t]);
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

function packRiverRecord(river) {
  const dense = densifyCoords(river.coords, 0.2);
  if (dense.length < 2) {
    return null;
  }
  const baseHalfWidthRad = river.mouthHalfWidthMeters / EARTH_RADIUS_M;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lonDeg, latDeg] of dense) {
    const lon = lonDeg * RAD;
    const lat = latDeg * RAD;
    if (lon < west) west = lon;
    if (lat < south) south = lat;
    if (lon > east) east = lon;
    if (lat > north) north = lat;
  }
  const pad = baseHalfWidthRad * 2.5 + 1e-4;
  west -= pad;
  south -= pad;
  east += pad;
  north += pad;

  const lonSpan = Math.max(east - west, 1e-9);
  const latSpan = Math.max(north - south, 1e-9);

  const vertices = [];
  const n = dense.length;
  for (let i = 0; i < n; i++) {
    const [lonDeg, latDeg] = dense[i];
    const lon = lonDeg * RAD;
    const lat = latDeg * RAD;
    const u = Math.max(
      0,
      Math.min(65535, Math.round(((lon - west) / lonSpan) * 65535)),
    );
    const v = Math.max(
      0,
      Math.min(65535, Math.round(((lat - south) / latSpan) * 65535)),
    );
    // Downstream width progression from 0.30 at headwater to 1.0 at mouth/estuary,
    // for the authored trunks only; a Natural Earth piece keeps a constant width.
    const progress = n > 1 ? i / (n - 1) : 1.0;
    const widthScale =
      river.taper === false ? 1.0 : 0.3 + 0.7 * Math.pow(progress, 0.75);
    const wQ = Math.max(1, Math.min(65535, Math.round(widthScale * 65535)));
    vertices.push([u, v, wQ]);
  }

  const strahlerOrder =
    river.strahlerOrder ??
    Math.max(
      2,
      Math.min(
        12,
        Math.round(
          Math.log2(Math.max(river.mouthHalfWidthMeters, 25) / 20) + 3,
        ),
      ),
    );

  return {
    west,
    south,
    east,
    north,
    baseHalfWidthRad,
    strahlerOrder,
    vertices,
  };
}

function dpSimplifyLine(pts, sqTol) {
  if (pts.length <= 2) return pts;
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
    if (keep[i]) out.push([Number(pts[i][0]), Number(pts[i][1])]);
  }
  return out;
}

function buildRiverBinary(outPath = DEFAULT_OUT, extraRivers = []) {
  const allRivers = [...CANONICAL_WORLD_RIVERS, ...extraRivers];
  const records = allRivers.map(packRiverRecord).filter(Boolean);
  let totalBytes = 8; // magic + riverCount
  for (const rec of records) {
    totalBytes += 32 + 4 + 4 + rec.vertices.length * 6;
  }

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC_NE1R, true);
  view.setUint32(4, records.length, true);

  let o = 8;
  for (const rec of records) {
    view.setFloat64(o, rec.west, true);
    view.setFloat64(o + 8, rec.south, true);
    view.setFloat64(o + 16, rec.east, true);
    view.setFloat64(o + 24, rec.north, true);
    o += 32;
    view.setFloat32(o, rec.baseHalfWidthRad, true);
    o += 4;
    const packedCountAndOrder =
      (((rec.strahlerOrder ?? 6) & 0x0f) << 28) |
      (rec.vertices.length & 0x0fffffff);
    view.setUint32(o, packedCountAndOrder >>> 0, true);
    o += 4;
    for (const [u, v, wQ] of rec.vertices) {
      view.setUint16(o, u, true);
      view.setUint16(o + 2, v, true);
      view.setUint16(o + 4, wQ, true);
      o += 6;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(buf));
  return { outPath, riverCount: records.length, totalBytes };
}

import { pathToFileURL } from "node:url";

// Converts a parsed ne_10m_rivers_lake_centerlines GeoJSON into river records.
function naturalEarthRiversFromGeojson(data) {
  const extra = [];
  const sqTol = 0.002 * 0.002;
  for (const f of data.features || []) {
    const p = f.properties || {};
    if (typeof p.featurecla === "string" && p.featurecla.includes("Lake")) {
      continue;
    }
    const sr = Number(p.scalerank ?? 10);
    if (sr > 9) continue;
    const g = f.geometry;
    if (!g) continue;
    const parts =
      g.type === "LineString"
        ? [g.coordinates]
        : g.type === "MultiLineString"
          ? g.coordinates
          : [];
    const strokeWeight = Number(p.strokeweig ?? 0.5);
    const strahlerOrder = Math.max(2, Math.min(11, 11 - sr));
    const mouthHalfWidthMeters = Math.max(
      35,
      Math.min(
        3200,
        Math.round(
          1100 *
            Math.pow(0.68, Math.max(0, sr - 1)) *
            Math.max(0.65, Math.min(2.2, strokeWeight * 1.45)),
        ),
      ),
    );
    for (const part of parts) {
      const simp = dpSimplifyLine(part, sqTol);
      if (simp.length >= 2) {
        extra.push({
          mouthHalfWidthMeters,
          strahlerOrder,
          taper: false,
          coords: simp,
        });
      }
    }
  }
  return extra;
}

const RIVER_SOURCE = "ne_10m_rivers_lake_centerlines.geojson";

async function fetchNaturalEarthRivers() {
  const bytes = await fetchPinnedNaturalEarthSource(RIVER_SOURCE);
  return naturalEarthRiversFromGeojson(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
}

function parseArgs(argv) {
  const args = { input: null, out: DEFAULT_OUT, fallbackCanonical: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--fallback-canonical") args.fallbackCanonical = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  let extra = [];
  if (args.fallbackCanonical) {
    console.warn(
      "WARNING: --fallback-canonical: writing the 22 authored canonical trunks ONLY. No Natural Earth data is included.",
    );
  } else if (args.input) {
    extra = naturalEarthRiversFromGeojson(
      JSON.parse(
        Buffer.from(readNaturalEarthSource(args.input, RIVER_SOURCE)).toString(
          "utf8",
        ),
      ),
    );
  } else {
    extra = await fetchNaturalEarthRivers();
  }
  const result = buildRiverBinary(args.out, extra);
  console.log(
    `Wrote ${result.outPath} (${result.riverCount} rivers, ${result.totalBytes} bytes; ${extra.length} from Natural Earth, ${result.riverCount - extra.length} authored/other)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main(process.argv).catch((e) => {
    console.error(`build-global-river-binary failed: ${e?.message ?? e}`);
    process.exit(1);
  });
}

export { buildRiverBinary, MAGIC_NE1R };
