#!/usr/bin/env node
// build-geoid-undulation-grid.mjs — offline bake for C6-FFT-OCEAN-TIDE-DATUM
// (Design A slice 1: the FFT-ocean vertical-datum anchor).
//
// Produces the bundled coarse EGM2008 geoid-undulation grid
// `packages/engine/Source/Assets/Geoid/egm2008-0p5deg.i16`, consumed at
// runtime by `Core/GeoidUndulationGrid.js` when the ocean vertical datum
// resolves to GEOID (`scene.globe.water.oceanVerticalDatum`).
//
// WHY THIS EXISTS
// ---------------
// `probe-ocean-datum.mjs` (Batch 759) measured Cesium World Terrain's ocean
// lid at six open-ocean sites and classified it GEOID: the baked sea tracks
// the EGM2008 undulation, while `OceanSurfacePrimitive` anchored its FFT
// patch at ELLIPSOIDAL height 0. At the Sri Lanka coast that is a measured
// 101.64 m disagreement — the patch floats as a raised water plateau above
// the baked sea. Fixing it needs an in-engine geoid model; the engine had
// none. This script bakes one.
//
// SOURCE + LICENCE
// ----------------
//   https://cdn.proj.org/us_nga_egm08_25.tif
//   (mirror: https://raw.githubusercontent.com/OSGeo/PROJ-data/master/us_nga/us_nga_egm08_25.tif)
//   sha256 4191d471eefebf24091b56dbc604353cb3b8cf8cc70e448bb9ae56a272bef17a
//   80,585,622 bytes, 8640 x 4321 float32, 2.5' node-registered, EPSG:4979 ->
//   EPSG:3855 (EGM2008 height).
//
// The file's own TIFF Copyright tag (33432) reads verbatim:
//   "Derived from work by NGA. Public Domain"
// and its ImageDescription reads:
//   "WGS 84 (EPSG:4979) to EGM2008 height (EPSG:3855). Converted from
//    egm08_25.gtx (last modified at 2018/10/08)"
//
// EGM2008 itself: Pavlis, Holmes, Kenyon & Factor, "The development and
// evaluation of the Earth Gravitational Model 2008 (EGM2008)", J. Geophys.
// Res. 117, B04406 (2012). NGA publishes the model and its derived geoid
// grids as US Government work in the public domain — no attribution
// obligation, no share-alike. Safe to preprocess and bundle in this MIT
// repository. The 80 MB source is NEVER bundled; only the ~508 KiB decimated
// output is committed. See LICENSE.md "Bundled Engine Assets".
//
// OUTPUT FORMAT (little-endian, magic "EGM1", 32-byte header)
// -----------------------------------------------------------
//   uint32 magic          0x314D4745 ("EGM1")
//   uint16 version        1
//   uint16 unitsPerMetre  100  (samples are int16 CENTIMETRES)
//   uint32 nx             lon nodes, west..east INCLUSIVE of both seams
//   uint32 ny             lat nodes, north..south inclusive
//   int32  westMicroDeg   -180000000
//   int32  northMicroDeg  +90000000
//   uint32 stepMicroDeg   500000 (0.5 deg)
//   uint32 reserved       0
//   int16[nx*ny]          row-major, north row first, west node first
//
// The east seam column (index nx-1, lon +180) DUPLICATES the west column
// (lon -180) so the runtime sampler is a plain clamp with no wrap branch.
// int16 centimetres covers the model's full range (-106.91 m .. +85.82 m)
// with 1 cm quantization — four orders of magnitude below the interpolation
// error, so it contributes nothing measurable to the budget.
//
// ERROR BUDGET (measured by this script against ALL 37,333,440 source nodes)
// --------------------------------------------------------------------------
// Bilinear interpolation of the 0.5 deg grid vs the full 2.5' model:
//
//   region        RMS       max      >1 m      >2 m
//   global        0.195 m   6.640 m  0.597 %   0.047 %
//   open water    0.110 m   3.598 m  0.079 %   0.0045 %
//
// "open water" = source nodes inside a level-6 tile whose MAXIMUM terrain
// height in the in-tree `Assets/approximateTerrainHeights.json` is <= 0 —
// i.e. tiles that contain no land at all (4,164,346 nodes). The consumer of
// this grid is the OCEAN anchor, so that is the governing column. Both global
// extrema sit on land in extreme relief (6.64 m at 73.67W/10.79N, the Sierra
// Nevada de Santa Marta — a 5,700 m massif 42 km from the sea); the open-water
// worst case is the Vitoria-Trindade seamount chain off Brazil.
//
// Alternative resolutions, same encoding, measured the same way:
//
//   step     nodes       size        global RMS / max     water RMS / max
//   1.0 deg  361 x 181   127.6 KiB   0.473 / 15.169 m     0.229 / 5.155 m
//   0.5 deg  721 x 361   508.4 KiB   0.195 /  6.640 m     0.110 / 3.598 m
//   0.25 deg 1441 x 721  2029.2 KiB  0.071 /  2.671 m     0.046 / 1.373 m
//
// 0.5 deg is the shipped default: 4x the bytes buys 2.2 m of worst-case error
// in high-relief LAND the ocean anchor never evaluates, against a defect of
// 101.64 m being removed. Regenerate at 0.25 deg with `--step 0.25` if a
// land-side consumer ever needs the tighter global bound.
//
// Usage:
//   node Tools/build-geoid-undulation-grid.mjs                # download + bake
//   node Tools/build-geoid-undulation-grid.mjs --input <tif>  # use a local copy
//   node Tools/build-geoid-undulation-grid.mjs --step 0.25    # finer grid
//   node Tools/build-geoid-undulation-grid.mjs --out <file>
//   node Tools/build-geoid-undulation-grid.mjs --no-verify    # skip the
//       full-resolution error sweep (fast; the sweep is ~40 s and is the only
//       thing that justifies the budget quoted above)
import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";
import zlib from "zlib";

const SOURCE_URL = "https://cdn.proj.org/us_nga_egm08_25.tif";
const SOURCE_SHA256 =
  "4191d471eefebf24091b56dbc604353cb3b8cf8cc70e448bb9ae56a272bef17a";
const SOURCE_BYTES = 80585622;
const DEFAULT_OUT = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "Geoid",
  "egm2008-0p5deg.i16",
);
const APPROX_HEIGHTS = path.join(
  "packages",
  "engine",
  "Source",
  "Assets",
  "approximateTerrainHeights.json",
);
const MAGIC = 0x314d4745; // "EGM1"
const UNITS_PER_METRE = 100; // int16 centimetres

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    stepDeg: 0.5,
    verify: true,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") {
      args.input = argv[++i];
    } else if (argv[i] === "--out") {
      args.out = argv[++i];
    } else if (argv[i] === "--step") {
      args.stepDeg = Number(argv[++i]);
    } else if (argv[i] === "--no-verify") {
      args.verify = false;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!(args.stepDeg > 0)) {
    throw new Error("--step must be a positive number of degrees");
  }
  // 2.5' source spacing is 1/24 deg; the step must be an integer multiple so
  // decimation is an exact node subset (no resampling error introduced here).
  const dec = args.stepDeg * 24;
  if (Math.abs(dec - Math.round(dec)) > 1e-9) {
    throw new Error(`--step ${args.stepDeg} is not an integer multiple of 2.5'`);
  }
  if (args.out === null) {
    args.out =
      args.stepDeg === 0.5
        ? DEFAULT_OUT
        : DEFAULT_OUT.replace(
            "0p5deg",
            `${String(args.stepDeg).replace(".", "p")}deg`,
          );
  }
  return args;
}

async function loadSource(input) {
  if (input) {
    console.log(`reading ${input} ...`);
    return fs.readFileSync(input);
  }
  console.log(`downloading ${SOURCE_URL} (${SOURCE_BYTES} bytes) ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${SOURCE_URL}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Minimal GeoTIFF reader, scoped to exactly this product ────────────────
// Little-endian, tiled, single float32 sample, Adobe-Deflate (compression 8)
// with the TIFF floating-point predictor (317 == 3). Anything else throws —
// this is deliberately NOT a general TIFF decoder, so a silently different
// source file fails loudly instead of producing a plausible wrong grid.
function readIfd(b) {
  if (b.readUInt16LE(0) !== 0x4949 || b.readUInt16LE(2) !== 42) {
    throw new Error("not a little-endian classic TIFF");
  }
  const ifdOff = b.readUInt32LE(4);
  const n = b.readUInt16LE(ifdOff);
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const p = ifdOff + 2 + i * 12;
    tags.set(b.readUInt16LE(p), {
      type: b.readUInt16LE(p + 2),
      count: b.readUInt32LE(p + 4),
      value: b.readUInt32LE(p + 8),
    });
  }
  return tags;
}

function readLongArray(b, entry) {
  if (entry.count === 1) {
    return [entry.value];
  }
  const out = new Array(entry.count);
  for (let i = 0; i < entry.count; i++) {
    out[i] = b.readUInt32LE(entry.value + i * 4);
  }
  return out;
}

function readAscii(b, entry) {
  return b
    .toString("latin1", entry.value, entry.value + entry.count)
    .replace(/\0+$/, "");
}

function decodeEgm2008Tiff(b) {
  const tags = readIfd(b);
  const need = (tag, name) => {
    const e = tags.get(tag);
    if (!e) {
      throw new Error(`TIFF tag ${tag} (${name}) missing`);
    }
    return e;
  };
  const width = need(256, "ImageWidth").value;
  const height = need(257, "ImageLength").value;
  const bits = need(258, "BitsPerSample").value;
  const compression = need(259, "Compression").value;
  const samples = need(277, "SamplesPerPixel").value;
  const predictor = need(317, "Predictor").value;
  const sampleFormat = need(339, "SampleFormat").value;
  const tileWidth = need(322, "TileWidth").value;
  const tileHeight = need(323, "TileLength").value;
  const tileOffsets = readLongArray(b, need(324, "TileOffsets"));
  const tileByteCounts = readLongArray(b, need(325, "TileByteCounts"));

  if (
    bits !== 32 ||
    samples !== 1 ||
    sampleFormat !== 3 ||
    compression !== 8 ||
    predictor !== 3
  ) {
    throw new Error(
      `unsupported TIFF layout: bits=${bits} samples=${samples} ` +
        `sampleFormat=${sampleFormat} compression=${compression} predictor=${predictor}`,
    );
  }

  // Georeferencing. GTRasterTypeGeoKey (1025) == 2 => RasterPixelIsPoint, so
  // sample (i, j) IS the value AT (west + i*scaleX, north - j*scaleY).
  const pixelScale = need(33550, "ModelPixelScale");
  const scaleX = b.readDoubleLE(pixelScale.value);
  const scaleY = b.readDoubleLE(pixelScale.value + 8);
  const tiepoint = need(33922, "ModelTiepoint");
  const rasterX = b.readDoubleLE(tiepoint.value);
  const rasterY = b.readDoubleLE(tiepoint.value + 8);
  const west = b.readDoubleLE(tiepoint.value + 24);
  const north = b.readDoubleLE(tiepoint.value + 32);
  if (rasterX !== 0 || rasterY !== 0) {
    throw new Error("unexpected non-origin model tiepoint");
  }
  const step = 1 / 24;
  if (
    Math.abs(scaleX - step) > 1e-12 ||
    Math.abs(scaleY - step) > 1e-12 ||
    west !== -180 ||
    north !== 90
  ) {
    throw new Error(
      `unexpected georeferencing: scale=(${scaleX},${scaleY}) origin=(${west},${north})`,
    );
  }
  if (width !== 8640 || height !== 4321) {
    throw new Error(`unexpected raster size ${width}x${height}`);
  }

  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  if (tileOffsets.length !== tilesAcross * tilesDown) {
    throw new Error("tile offset count does not match the tile grid");
  }

  const grid = new Float32Array(width * height);
  const rowBytes = tileWidth * 4;
  const row = Buffer.alloc(rowBytes);
  for (let ty = 0; ty < tilesDown; ty++) {
    for (let tx = 0; tx < tilesAcross; tx++) {
      const idx = ty * tilesAcross + tx;
      const data = zlib.inflateSync(
        b.subarray(tileOffsets[idx], tileOffsets[idx] + tileByteCounts[idx]),
      );
      if (data.length !== rowBytes * tileHeight) {
        throw new Error(`tile ${idx} inflated to ${data.length} bytes`);
      }
      for (let r = 0; r < tileHeight; r++) {
        const base = r * rowBytes;
        // Predictor 3, stage 1: byte-wise horizontal accumulate over the row.
        for (let i = 1; i < rowBytes; i++) {
          data[base + i] = (data[base + i] + data[base + i - 1]) & 0xff;
        }
        // Stage 2: de-shuffle the byte planes. libtiff stores the MOST
        // significant byte plane first; on a little-endian target the output
        // byte j comes from plane (3 - j).
        for (let c = 0; c < tileWidth; c++) {
          row[c * 4] = data[base + 3 * tileWidth + c];
          row[c * 4 + 1] = data[base + 2 * tileWidth + c];
          row[c * 4 + 2] = data[base + tileWidth + c];
          row[c * 4 + 3] = data[base + c];
        }
        const gy = ty * tileHeight + r;
        if (gy >= height) {
          continue;
        }
        for (let c = 0; c < tileWidth; c++) {
          const gx = tx * tileWidth + c;
          if (gx >= width) {
            continue;
          }
          grid[gy * width + gx] = row.readFloatLE(c * 4);
        }
      }
    }
  }

  return {
    grid,
    width,
    height,
    west,
    north,
    step,
    description: tags.has(270) ? readAscii(b, tags.get(270)) : null,
    copyright: tags.has(33432) ? readAscii(b, tags.get(33432)) : null,
  };
}

// ── Decimation ────────────────────────────────────────────────────────────
function decimate(src, stepDeg) {
  const dec = Math.round(stepDeg * 24);
  const nx = Math.round(360 / stepDeg) + 1; // both seams present
  const ny = Math.round(180 / stepDeg) + 1;
  const out = new Int16Array(nx * ny);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < ny; j++) {
    const sy = j * dec;
    for (let i = 0; i < nx; i++) {
      // i === nx-1 is lon +180, which wraps onto source column 0 (lon -180).
      const sx = (i * dec) % src.width;
      const v = src.grid[sy * src.width + sx];
      if (v < min) {
        min = v;
      }
      if (v > max) {
        max = v;
      }
      out[j * nx + i] = Math.round(v * UNITS_PER_METRE);
    }
  }
  return { values: out, nx, ny, stepDeg, minM: min, maxM: max };
}

function sampleCoarse(c, lonDeg, latDeg) {
  const x = (lonDeg + 180) / c.stepDeg;
  const y = (90 - latDeg) / c.stepDeg;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  if (x0 < 0) {
    x0 = 0;
  }
  if (x0 > c.nx - 2) {
    x0 = c.nx - 2;
  }
  if (y0 < 0) {
    y0 = 0;
  }
  if (y0 > c.ny - 2) {
    y0 = c.ny - 2;
  }
  const fx = x - x0;
  const fy = y - y0;
  const g = c.values;
  const a = g[y0 * c.nx + x0];
  const b = g[y0 * c.nx + x0 + 1];
  const d = g[(y0 + 1) * c.nx + x0];
  const e = g[(y0 + 1) * c.nx + x0 + 1];
  return (
    (a * (1 - fx) * (1 - fy) +
      b * fx * (1 - fy) +
      d * (1 - fx) * fy +
      e * fx * fy) /
    UNITS_PER_METRE
  );
}

// Open-water mask from the in-tree level-6 approximate terrain heights: a tile
// whose MAXIMUM height is at or below sea level contains no land at all. Coarse
// (2.8 deg tiles) but zero-download, deterministic and already shipped.
function makeOceanMask() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(APPROX_HEIGHTS, "utf8"));
  } catch {
    return null;
  }
  const NX = 128;
  const NY = 64;
  const mask = new Uint8Array(NX * NY);
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const e = json[`6-${x}-${y}`];
      mask[y * NX + x] = e && e[1] <= 0 ? 1 : 0;
    }
  }
  return (lonDeg, latDeg) => {
    let x = Math.floor(((lonDeg + 180) / 360) * NX);
    let y = Math.floor(((90 - latDeg) / 180) * NY);
    x = x < 0 ? 0 : x >= NX ? NX - 1 : x;
    y = y < 0 ? 0 : y >= NY ? NY - 1 : y;
    return mask[y * NX + x] === 1;
  };
}

function measureError(src, coarse) {
  const isOcean = makeOceanMask();
  const groups = {
    global: { n: 0, s2: 0, max: 0, at: null, o1: 0, o2: 0 },
    openWater: { n: 0, s2: 0, max: 0, at: null, o1: 0, o2: 0 },
  };
  for (let j = 0; j < src.height; j++) {
    const lat = src.north - j * src.step;
    for (let i = 0; i < src.width; i++) {
      const lon = src.west + i * src.step;
      const err = sampleCoarse(coarse, lon, lat) - src.grid[j * src.width + i];
      const a = Math.abs(err);
      const keys =
        isOcean && isOcean(lon, lat) ? ["global", "openWater"] : ["global"];
      for (const k of keys) {
        const s = groups[k];
        s.n++;
        s.s2 += err * err;
        if (a > s.max) {
          s.max = a;
          s.at = [Number(lon.toFixed(4)), Number(lat.toFixed(4))];
        }
        if (a > 1) {
          s.o1++;
        }
        if (a > 2) {
          s.o2++;
        }
      }
    }
  }
  for (const k of Object.keys(groups)) {
    const s = groups[k];
    s.rms = s.n > 0 ? Math.sqrt(s.s2 / s.n) : null;
    s.over1Pct = s.n > 0 ? (s.o1 / s.n) * 100 : null;
    s.over2Pct = s.n > 0 ? (s.o2 / s.n) * 100 : null;
  }
  return groups;
}

function pack(coarse) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt16LE(1, 4); // version
  header.writeUInt16LE(UNITS_PER_METRE, 6);
  header.writeUInt32LE(coarse.nx, 8);
  header.writeUInt32LE(coarse.ny, 12);
  header.writeInt32LE(-180000000, 16);
  header.writeInt32LE(90000000, 20);
  header.writeUInt32LE(Math.round(coarse.stepDeg * 1e6), 24);
  header.writeUInt32LE(0, 28);
  return Buffer.concat([header, Buffer.from(coarse.values.buffer.slice(0))]);
}

async function main() {
  const args = parseArgs(process.argv);
  const raw = await loadSource(args.input);
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  console.log(`source: ${raw.length} bytes, sha256 ${sha}`);
  if (!args.input) {
    if (raw.length !== SOURCE_BYTES || sha !== SOURCE_SHA256) {
      throw new Error(
        "downloaded source does not match the pinned size/sha256 — the upstream " +
          "file changed; re-verify its provenance and licence before updating " +
          "the constants in this script.",
      );
    }
  } else if (sha !== SOURCE_SHA256) {
    console.warn(
      `WARNING: local input sha256 differs from the pinned ${SOURCE_SHA256}`,
    );
  }

  const src = decodeEgm2008Tiff(raw);
  console.log(`TIFF description: ${src.description}`);
  console.log(`TIFF copyright:   ${src.copyright}`);

  const coarse = decimate(src, args.stepDeg);
  console.log(
    `grid: ${coarse.nx} x ${coarse.ny} @ ${args.stepDeg} deg, ` +
      `range ${coarse.minM.toFixed(3)} .. ${coarse.maxM.toFixed(3)} m`,
  );

  if (args.verify) {
    const stats = measureError(src, coarse);
    for (const [name, s] of Object.entries(stats)) {
      console.log(
        `error ${name.padEnd(10)} n=${s.n} rms=${s.rms.toFixed(4)} m ` +
          `max=${s.max.toFixed(3)} m @ ${s.at} ` +
          `>1m=${s.over1Pct.toFixed(4)}% >2m=${s.over2Pct.toFixed(5)}%`,
      );
    }
  }

  const out = pack(coarse);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, out);
  console.log(
    `wrote ${args.out} (${out.length} bytes, ${(out.length / 1024).toFixed(1)} KiB), ` +
      `sha256 ${crypto.createHash("sha256").update(out).digest("hex")}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
