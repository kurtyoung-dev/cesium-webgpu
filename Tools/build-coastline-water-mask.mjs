#!/usr/bin/env node
// build-coastline-water-mask.mjs — offline preprocess for global vector coastlines.
// @purpose Converts Natural Earth 1:10m land, minor-island and Antarctic ice-shelf polygons into the packed LWM2 binary bundled for GlobalCoastlineWaterClassificationProvider.
// @status ACTIVE
//
// Converts the Natural Earth 1:10m land, minor-island and Antarctic ice-shelf
// polygon datasets into the compact packed-polygon binary bundled at
// `packages/engine/Source/Assets/WaterMask/ne50mCoastlines.bin` (the file name
// is historical; the content is 1:10m land, not the 1:50m ocean) and consumed at
// runtime by `Scene/GlobalCoastlineWaterClassificationProvider.ts`
// when global water is enabled.
//
// LICENSE: Natural Earth is PUBLIC DOMAIN — no attribution, no share-alike
// (https://www.naturalearthdata.com/about/terms-of-use/). Safe to preprocess
// and bundle in this repository.
//
// Source pinning: the downloads read natural-earth-vector at the commit pinned in
// `Tools/lib/natural-earth-pinned.mjs`, and a download whose SHA-256 differs from
// the pinned one is refused. A rebuild from those sources reproduces the bundled
// bytes exactly (checked 2026-10-22). Pass --input <dir> with a local copy to
// rebuild offline; a local file that is not the pinned one is built with a warning.
//
// Minimum area filter: a source polygon part whose outer ring encloses less than
// MIN_PART_AREA_DEG2 = 1e-4 square degrees (a 0.01-degree square, about 1.2 km2 at
// the equator) is dropped before packing. The filter exists because the land set
// carries a four-vertex 1 km square at 0 N, 0 E ("Null Island") that painted land
// in the open Gulf of Guinea. It is measured on the whole source part, before
// the 15-degree grid clip, so clipped slivers of large polygons are never dropped.
// Override with --min-area-deg2 <n>. The bundled binary was produced from the
// network build by the deterministic offline refilter (--refilter, below) at this
// threshold: 9,641 polygons before, 7,897 after.
//
// Format (little-endian, magic "LWM2"):
//   uint32 magic 0x324D574C ("LWM2")
//   uint32 polygonCount
//   per polygon (each island and continental mass is an independent polygon;
//   masses wider than 15 degrees are clipped to a 15-degree grid, one polygon
//   per cell):
//     float32 west, south, east, north   (RADIANS, padded by 1e-7 rad)
//     uint8   featureCode                (1 = land / island / ice shelf)
//     uint8   reserved                   (0)
//     uint16  ringCount                  (ring 0 = outer, 1..n = inner holes;
//                                         the tool throws above 65535)
//     per ring:
//       uint32 vertexCount               (closing duplicate point removed)
//       vertexCount × (uint16 u, uint16 v)  quantized against the stored float32
//                                            bbox: lon = west + u/65535·(east−west)
//
// Usage:
//   node Tools/build-coastline-water-mask.mjs                # download + convert
//   node Tools/build-coastline-water-mask.mjs --input <dir>  # use pre-downloaded
//       <dir>/ne_10m_land.geojson, <dir>/ne_10m_minor_islands.geojson and
//       <dir>/ne_10m_antarctic_ice_shelves_polys.geojson
//   node Tools/build-coastline-water-mask.mjs --out <file>   # override output path
//   node Tools/build-coastline-water-mask.mjs --min-area-deg2 <n>  # override the area filter
//   node Tools/build-coastline-water-mask.mjs --refilter <file.bin>  # no network: read an LWM2
//       file, drop polygons whose outer ring is under the threshold, keep every other
//       polygon byte for byte, and write to --out (default: the input file, in place)
import fs from "fs";
import path from "path";
import process from "process";
import {
  fetchPinnedNaturalEarthSource,
  readNaturalEarthSource,
} from "./lib/natural-earth-pinned.mjs";

const SOURCES = [
  "ne_10m_land.geojson",
  "ne_10m_minor_islands.geojson",
  "ne_10m_antarctic_ice_shelves_polys.geojson",
];
const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "WaterMask",
  "ne50mCoastlines.bin",
);
const MAGIC = 0x324d574c; // "LWM2"
const RAD = Math.PI / 180.0;
const DP_TOL_DEG = 0.0012;
const GRID_CELL_DEG = 15.0;
const MIN_PART_AREA_DEG2 = 1e-4;
const MAX_RING_COUNT = 0xffff;

function dpSimplify(pts, sqTol) {
  if (pts.length <= 4) return pts;
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

function pointInRingDeg(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ringAreaDeg(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a * 0.5);
}

function dedupRing(ring) {
  if (ring.length < 3) return [];
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (
      out.length === 0 ||
      Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) >
        1e-9
    ) {
      out.push(p);
    }
  }
  if (
    out.length > 1 &&
    Math.hypot(
      out[0][0] - out[out.length - 1][0],
      out[0][1] - out[out.length - 1][1],
    ) <= 1e-9
  ) {
    out.pop();
  }
  return out;
}

function clipRingHalfPlane(ring, axis, bound, keepMin) {
  const n = ring.length;
  if (n < 3) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n];
    const curr = ring[i];
    const prevIn = keepMin ? prev[axis] >= bound : prev[axis] <= bound;
    const currIn = keepMin ? curr[axis] >= bound : curr[axis] <= bound;
    if (currIn !== prevIn) {
      const t = (bound - prev[axis]) / (curr[axis] - prev[axis]);
      const pt =
        axis === 0
          ? [bound, prev[1] + t * (curr[1] - prev[1])]
          : [prev[0] + t * (curr[0] - prev[0]), bound];
      out.push(pt);
    }
    if (currIn) out.push(curr);
  }
  return out;
}

function clipRingToBox(ring, w, s, e, n) {
  let r = clipRingHalfPlane(ring, 0, w, true);
  if (r.length < 3) return [];
  r = clipRingHalfPlane(r, 0, e, false);
  if (r.length < 3) return [];
  r = clipRingHalfPlane(r, 1, s, true);
  if (r.length < 3) return [];
  r = clipRingHalfPlane(r, 1, n, false);
  r = dedupRing(r);
  return r.length >= 3 && ringAreaDeg(r) > 1e-10 ? r : [];
}

function clipPolygonToBox(rings, cw, cs, ce, cn) {
  const outRings = [];
  let fullBoxParity = 0;
  const midX = (cw + ce) * 0.5;
  const midY = (cs + cn) * 0.5;
  for (const ring of rings) {
    const cr = clipRingToBox(ring, cw, cs, ce, cn);
    if (cr.length >= 3) {
      outRings.push(cr);
    } else if (pointInRingDeg(midX, midY, ring)) {
      fullBoxParity ^= 1;
    }
  }
  if (fullBoxParity === 1) {
    outRings.unshift([
      [cw, cs],
      [ce, cs],
      [ce, cn],
      [cw, cn],
    ]);
  }
  return outRings;
}

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    refilter: null,
    minAreaDeg2: MIN_PART_AREA_DEG2,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--refilter") args.refilter = argv[++i];
    else if (argv[i] === "--min-area-deg2")
      args.minAreaDeg2 = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!(args.minAreaDeg2 >= 0)) {
    throw new Error("--min-area-deg2 must be a number >= 0");
  }
  return args;
}

async function loadGeojson(name, inputDir) {
  const bytes = inputDir
    ? readNaturalEarthSource(path.join(inputDir, name), name)
    : await fetchPinnedNaturalEarthSource(name);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function packPolygon(rings) {
  const cleaned = rings
    .map((ring) => {
      if (ring.length < 3) return [];
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
    rings: packedRings,
  };
}

// Reads an LWM2 file and keeps every polygon record byte for byte except those
// whose outer ring (ring 0) encloses less than minAreaDeg2 square degrees.
function refilterLwm2(inputPath, outPath, minAreaDeg2) {
  const src = fs.readFileSync(inputPath);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error(`${inputPath} is not an LWM2 file`);
  }
  const count = view.getUint32(4, true);
  const kept = [];
  let dropped = 0;
  let o = 8;
  for (let p = 0; p < count; p++) {
    const start = o;
    const west = view.getFloat32(o, true) / RAD;
    const south = view.getFloat32(o + 4, true) / RAD;
    const east = view.getFloat32(o + 8, true) / RAD;
    const north = view.getFloat32(o + 12, true) / RAD;
    const ringCount = view.getUint16(o + 18, true);
    o += 20;
    let outer = null;
    for (let r = 0; r < ringCount; r++) {
      const vc = view.getUint32(o, true);
      o += 4;
      if (r === 0) {
        outer = new Array(vc);
        for (let i = 0; i < vc; i++) {
          outer[i] = [
            west + (view.getUint16(o + i * 4, true) / 65535) * (east - west),
            south +
              (view.getUint16(o + i * 4 + 2, true) / 65535) * (north - south),
          ];
        }
      }
      o += vc * 4;
    }
    if (outer && ringAreaDeg(outer) < minAreaDeg2) {
      dropped++;
    } else {
      kept.push(src.subarray(start, o));
    }
  }
  if (o !== src.byteLength) {
    throw new Error(`${inputPath}: parsed ${o} bytes of ${src.byteLength}`);
  }
  const header = Buffer.alloc(8);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(kept.length, 4);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([header, ...kept]));
  console.log(
    `Refiltered ${inputPath} -> ${outPath}: ${count} -> ${kept.length} polygons (${dropped} under ${minAreaDeg2} deg2)`,
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.refilter) {
    refilterLwm2(args.refilter, args.out ?? args.refilter, args.minAreaDeg2);
    return;
  }
  const outPath = args.out ?? DEFAULT_OUT;
  const polygons = [];
  let droppedByArea = 0;
  const sqTol = DP_TOL_DEG * DP_TOL_DEG;
  for (const srcName of SOURCES) {
    const geojson = await loadGeojson(srcName, args.input);
    for (const feature of geojson.features || []) {
      const geom = feature.geometry;
      if (!geom) continue;
      const parts =
        geom.type === "Polygon"
          ? [geom.coordinates]
          : geom.type === "MultiPolygon"
            ? geom.coordinates
            : [];
      for (const part of parts) {
        const simplified = part
          .map((ring) => dpSimplify(ring, sqTol))
          .filter((ring) => ring.length >= 3);
        if (simplified.length === 0) continue;
        if (ringAreaDeg(simplified[0]) < args.minAreaDeg2) {
          droppedByArea++;
          continue;
        }
        let w = Infinity;
        let s = Infinity;
        let e = -Infinity;
        let n = -Infinity;
        for (const ring of simplified) {
          for (const [lon, lat] of ring) {
            if (lon < w) w = lon;
            if (lon > e) e = lon;
            if (lat < s) s = lat;
            if (lat > n) n = lat;
          }
        }
        if (e - w <= GRID_CELL_DEG && n - s <= GRID_CELL_DEG) {
          const packed = packPolygon(simplified);
          if (packed) polygons.push(packed);
        } else {
          const c0 = Math.max(0, Math.floor((w + 180.0) / GRID_CELL_DEG));
          const c1 = Math.min(
            Math.floor(360.0 / GRID_CELL_DEG) - 1,
            Math.floor((e + 180.0 - 1e-9) / GRID_CELL_DEG),
          );
          const r0 = Math.max(0, Math.floor((s + 90.0) / GRID_CELL_DEG));
          const r1 = Math.min(
            Math.floor(180.0 / GRID_CELL_DEG) - 1,
            Math.floor((n + 90.0 - 1e-9) / GRID_CELL_DEG),
          );
          for (let r = r0; r <= r1; r++) {
            const cs = -90.0 + r * GRID_CELL_DEG;
            const cn = cs + GRID_CELL_DEG;
            for (let c = c0; c <= c1; c++) {
              const cw = -180.0 + c * GRID_CELL_DEG;
              const ce = cw + GRID_CELL_DEG;
              const cellRings = clipPolygonToBox(simplified, cw, cs, ce, cn);
              if (cellRings.length > 0) {
                const packed = packPolygon(cellRings);
                if (packed) polygons.push(packed);
              }
            }
          }
        }
      }
    }
  }
  // Serialize to LWM2 binary format (16B float32 bbox + 2B metadata + 2B ringCount = 20B per polygon)
  let byteLength = 8;
  for (const p of polygons) {
    byteLength += 4 * 4 + 4;
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
    view.setUint8(o, 1); // land/island featureCode
    view.setUint8(o + 1, 0);
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

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(buffer));
  console.log(
    `Wrote ${outPath}: ${polygons.length} polygons (${droppedByArea} parts under ${args.minAreaDeg2} deg2 dropped), ${(byteLength / 1024).toFixed(0)} KiB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
