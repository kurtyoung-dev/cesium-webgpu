#!/usr/bin/env node
/**
 * bake-lola-normals.mjs — reproducible lunar NORMAL-map bake (Campaign-12 C12-25).
 *
 * Sibling of bake-lroc-color.mjs (C12-24): same verify / derive / encode /
 * verify-the-encoded-bytes / manifest / install structure, same repo-root
 * anchoring, same "nothing installs unless every check passes" contract.
 *
 * Input : NASA/GSFC SVS 4720 "CGI Moon Kit", LOLA displacement map
 *         `ldem_16.tif` — 5760x2880 equirectangular (plate carree), float32
 *         KILOMETRES relative to a 1737.4 km sphere, centred on 0 deg
 *         longitude, north at the top.
 *           URL   : https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif
 *           SHA256: 1ea42bf44f7e9d694f79c3afa7145f97fbf06cc67372067d9fe73dce43bad796
 *           Bytes : 66,378,634
 *
 * PREMISE CORRECTION (recorded here because the C12-25 brief assumed
 * otherwise): SVS publishes **no 2K displacement map**. The `ldem_*` family
 * is 4 / 16 / 64 pixels per degree only — 1440x720, 5760x2880, 23040x11520 —
 * each in a float32 km and a uint16 half-metre variant. Verified by direct
 * HEAD request: `ldem_2k.tif`, `ldem_1k.tif` and `ldem_512.tif` all 404 while
 * all six real members return 200. So the shipped normal map is DERIVED:
 * `ldem_16` (the smallest member finer than the target) is area-averaged down
 * to the output grid and the normals are taken there. `ldem_4` was rejected as
 * the source because at 1440x720 it is COARSER than the output, so using it
 * would have upsampled invented detail.
 *
 * Output is 1024x512 by default rather than matching the 2048x1024 albedo:
 * neither backend mipmaps the moon (C12-33), so a 2048-wide map is ~64:1
 * minification off mip 0 at the default ~16 px disc, and normal aliasing
 * flickers the LIGHTING rather than the colour. See README section 7.4.
 * `--width 2048` re-bakes the larger map once C12-33 lands.
 *
 * Stages:
 *   1. Verify   — pinned SHA-256 of the source + 5760x2880 dimension assert
 *                 + a physical range assert (LOLA's real relief is about
 *                 -9.1 to +10.8 km; a decode that silently normalized to
 *                 0..1 or 0..255 would sail past a dimension check alone).
 *   2. Downsample — exact area-weighted average to the output grid. See
 *                 lunar-relief.mjs `areaDownsample` for why an area average
 *                 and not a Lanczos: the very next stage differentiates the
 *                 field, and any ringing at a crater rim becomes a false
 *                 slope reversal.
 *   3. Derive   — central differences with the correct metres-per-texel at
 *                 the lunar radius, and a longitude stencil that widens as
 *                 1/cos(lat) so the derivative baseline stays a constant
 *                 GROUND distance instead of shearing toward the poles.
 *                 Rows past a pole wrap ACROSS it to the antipodal
 *                 longitude, so neither pole grows a ring of false slope.
 *   4. Encode   — PNG. Normal maps and chroma subsampling are incompatible
 *                 (the x and y components live in the chroma planes after
 *                 the RGB->YCbCr rotation, so 4:2:0 halves the resolution of
 *                 exactly the two channels that carry the relief), and even
 *                 4:4:4 JPEG's DCT rings across crater rims. Sizes and the
 *                 measured normal-tilt error for every candidate are
 *                 tabulated in README section 7.5.
 *   5. Verify   — decode the ENCODED bytes back and run the relief checks in
 *                 lunar-relief.mjs. A mirrored red or green channel, an x/y
 *                 swap, or a flat map each fail a specific named check.
 *                 Nothing installs unless every check passes.
 *   6. Manifest — write moon-normal-manifest.json (checked in) recording the
 *                 provenance, the derivation constants, the shipped file's
 *                 SHA-256, the slope statistics, and the measured crater
 *                 relief. Tools/visual-regression/moon-normal-map-asset.spec.mjs
 *                 re-derives the shipped hash and rejects the manifest if
 *                 they disagree, so the evidence cannot drift from the asset.
 *
 * Usage:
 *   node Tools/moon-albedo-bake/bake-lola-normals.mjs             # bake to out/
 *   node Tools/moon-albedo-bake/bake-lola-normals.mjs --install   # + copy into Assets
 *   node Tools/moon-albedo-bake/bake-lola-normals.mjs --verify    # re-check the
 *                                                                 # INSTALLED asset only
 *   node Tools/moon-albedo-bake/bake-lola-normals.mjs --encodings # size comparison table
 *
 * Dependency: `sharp` (declared in the root package.json devDependencies).
 */
// Node ESM offline tooling. Linted by the `Tools/**` block in eslint.config.js,
// which supplies the Node (and browser) global sets.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  LUNAR_RADIUS_M,
  areaDownsample,
  decodeNormalsRGB8,
  encodeNormalsRGB16,
  encodeNormalsRGB8,
  heightsToNormals,
  measureCraters,
  runReliefChecks,
} from "./lunar-relief.mjs";

sharp.cache(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(REPO, "packages/engine/Source/Assets/Textures/Moon");

// ---- Pinned source provenance -----------------------------------------
const SOURCE = Object.freeze({
  product: "NASA/GSFC SVS 4720 — CGI Moon Kit, LOLA displacement map",
  file: "ldem_16.tif",
  url: "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif",
  page: "https://svs.gsfc.nasa.gov/4720/",
  sha256: "1ea42bf44f7e9d694f79c3afa7145f97fbf06cc67372067d9fe73dce43bad796",
  bytes: 66378634,
  width: 5760,
  height: 2880,
  pixelsPerDegree: 16,
  units: "float32 kilometres relative to a 1737.4 km sphere",
  retrieved: "2026-08-02",
});

// Published LOLA relief extremes, used as a decode sanity assert. The real
// range is about -9.1 km (Antoniadi) to +10.8 km (the Engel'gardt highlands);
// anything outside these brackets means the decode is not in kilometres.
const EXPECTED_MIN_KM = [-10, -8];
const EXPECTED_MAX_KM = [9, 12];

const OUT_WIDTH = Number(arg("width", 1024));
const OUT_HEIGHT = OUT_WIDTH / 2;
const OUTPUT_NAME = `ldem_normal_${OUT_WIDTH / 1024}k.png`;
const ENCODE = Object.freeze({
  format: "png",
  bitDepth: 8,
  channels: 3,
  compressionLevel: 9,
});

// ---- CLI ---------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const OPT = {
  input: arg("input", path.join(__dirname, "work", SOURCE.file)),
  out: arg("out", path.join(__dirname, "out")),
  install: arg("install", false) === true,
  verify: arg("verify", false) === true,
  encodings: arg("encodings", false) === true,
  skipHashCheck: arg("skip-hash-check", false) === true,
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Decode the float32 height TIFF as a single-channel metre field. */
async function decodeHeightsMeters(input) {
  const { data, info } = await sharp(input)
    .toColorspace("b-w")
    .raw({ depth: "float" })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) {
    throw new Error(
      `expected 1 channel after b-w conversion, got ${info.channels}`,
    );
  }
  const km = new Float32Array(
    data.buffer,
    data.byteOffset,
    data.byteLength / 4,
  );
  if (km.length !== info.width * info.height) {
    throw new Error(
      `decoded ${km.length} samples for a ${info.width}x${info.height} image`,
    );
  }
  let mn = Infinity;
  let mx = -Infinity;
  const meters = new Float64Array(km.length);
  for (let i = 0; i < km.length; i++) {
    const v = km[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    meters[i] = v * 1000;
  }
  return {
    meters,
    width: info.width,
    height: info.height,
    minKm: mn,
    maxKm: mx,
  };
}

/** Decode an installed/encoded PNG back to tightly packed 8-bit RGB. */
async function decodeRaw(input) {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function reportChecks(result) {
  for (const c of result.checks) {
    console.log(
      `   ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(26)} ${String(c.value).padStart(10)} (need ${c.threshold})`,
    );
    console.log(`         ${c.detail}`);
  }
}

async function verifyInstalled() {
  const installed = path.join(ASSETS, OUTPUT_NAME);
  if (!fs.existsSync(installed)) {
    throw new Error(
      `No installed asset at ${installed}. Run without --verify first.`,
    );
  }
  const buf = fs.readFileSync(installed);
  console.log(`Installed asset: ${installed}`);
  console.log(`  bytes  ${buf.length}`);
  console.log(`  sha256 ${sha256(buf)}`);
  const raw = await decodeRaw(buf);
  console.log(`  pixels ${raw.width}x${raw.height} (${raw.channels} ch)`);
  const { nx, ny, nz } = decodeNormalsRGB8(
    raw.pixels,
    raw.width,
    raw.height,
    raw.channels,
  );
  const result = runReliefChecks(nx, ny, nz, raw.width, raw.height);
  console.log("\nRelief checks:");
  reportChecks(result);
  if (!result.ok) {
    throw new Error("Relief checks FAILED on the installed asset.");
  }
  console.log("\nAll relief checks passed.");
}

/**
 * Encode-format comparison. Normal maps are not photographs: the payload is
 * a smooth vector field whose two informative channels end up in JPEG's
 * chroma planes, so the usual "JPEG wins on photographic sources" reasoning
 * inverts. Measured, not assumed — README section 10 carries the table.
 */
async function measureEncodings(nx, ny, nz) {
  const rgb8 = encodeNormalsRGB8(nx, ny, nz);
  const rgb16 = encodeNormalsRGB16(nx, ny, nz);
  const raw8 = { width: OUT_WIDTH, height: OUT_HEIGHT, channels: 3 };
  const raw16 = { ...raw8, depth: "ushort" };

  const rows = [];
  const png8 = await sharp(rgb8, { raw: raw8 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  rows.push(["PNG 8-bit RGB (level 9)", png8.length]);

  const png16 = await sharp(Buffer.from(rgb16), { raw: raw16 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  rows.push(["PNG 16-bit RGB (level 9)", png16.length]);

  const jpeg444 = await sharp(rgb8, { raw: raw8 })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: false })
    .toBuffer();
  rows.push(["JPEG q90 4:4:4", jpeg444.length]);

  const jpeg420 = await sharp(rgb8, { raw: raw8 })
    .jpeg({ quality: 90, chromaSubsampling: "4:2:0", mozjpeg: false })
    .toBuffer();
  rows.push(["JPEG q90 4:2:0", jpeg420.length]);

  const webpLossless = await sharp(rgb8, { raw: raw8 })
    .webp({ lossless: true })
    .toBuffer();
  rows.push(["WebP lossless", webpLossless.length]);

  // Fidelity of each candidate, in DEGREES OF TILT ERROR — the unit that
  // matters, since the whole payload is the direction of the normal. Both
  // sides are normalized first, because that is what the shaders do: an
  // 8-bit round trip returns a slightly short vector, and scoring it without
  // renormalizing charges the encoding for an error the runtime removes.
  const angErr = (d) => {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < nx.length; i++) {
      const l = Math.sqrt(
        d.nx[i] * d.nx[i] + d.ny[i] * d.ny[i] + d.nz[i] * d.nz[i],
      );
      const inv = l > 1e-9 ? 1 / l : 0;
      const dot = Math.max(
        -1,
        Math.min(
          1,
          (nx[i] * d.nx[i] + ny[i] * d.ny[i] + nz[i] * d.nz[i]) * inv,
        ),
      );
      const err = (Math.acos(dot) * 180) / Math.PI;
      sum += err;
      if (err > max) max = err;
    }
    return {
      meanTiltErrorDeg: Math.round((sum / nx.length) * 1000) / 1000,
      maxTiltErrorDeg: Math.round(max * 1000) / 1000,
    };
  };
  const fidelity = {};
  for (const [name, buf] of [
    // The shipped PNG is lossless in the file, so its only error is the 8-bit
    // quantization the encoder was handed — measured here too, for honesty.
    ["PNG 8-bit RGB (level 9)", png8],
    ["JPEG q90 4:4:4", jpeg444],
    ["JPEG q90 4:2:0", jpeg420],
  ]) {
    const raw = await decodeRaw(buf);
    fidelity[name] = angErr(
      decodeNormalsRGB8(raw.pixels, raw.width, raw.height, raw.channels),
    );
  }

  console.log("\nEncoding comparison:");
  for (const [name, bytes] of rows) {
    const f = fidelity[name];
    console.log(
      `  ${name.padEnd(26)} ${String(bytes).padStart(9)} B  ${(bytes / 1024).toFixed(1).padStart(8)} KB` +
        (f
          ? `   tilt err mean ${f.meanTiltErrorDeg} deg / max ${f.maxTiltErrorDeg} deg`
          : ""),
    );
  }
  return { rows, fidelity, png8 };
}

async function bake() {
  // --- 1. verify source -------------------------------------------------
  if (!fs.existsSync(OPT.input)) {
    throw new Error(
      `Source not found: ${OPT.input}\n\nFetch it with:\n  curl -L -o ${OPT.input} \\\n    ${SOURCE.url}`,
    );
  }
  const srcBuf = fs.readFileSync(OPT.input);
  const srcHash = sha256(srcBuf);
  console.log(`Source : ${OPT.input}`);
  console.log(`  bytes  ${srcBuf.length} (expected ${SOURCE.bytes})`);
  console.log(`  sha256 ${srcHash}`);
  if (!OPT.skipHashCheck && srcHash !== SOURCE.sha256) {
    throw new Error(
      `Source SHA-256 mismatch.\n  expected ${SOURCE.sha256}\n  actual   ${srcHash}\n` +
        `The pinned SVS product changed (or the download is corrupt). Do NOT re-bake ` +
        `blindly — re-derive the provenance, update SOURCE here and the LICENSE.md ` +
        `entry, then re-run. Use --skip-hash-check only for a deliberate re-pin.`,
    );
  }

  const meta = await sharp(OPT.input).metadata();
  if (meta.width !== SOURCE.width || meta.height !== SOURCE.height) {
    throw new Error(
      `Source is ${meta.width}x${meta.height}, expected ${SOURCE.width}x${SOURCE.height}.`,
    );
  }
  console.log(
    `  pixels ${meta.width}x${meta.height}, ${meta.channels} ch, depth ${meta.depth}, ICC ${meta.icc ? "present" : "none"}`,
  );

  const src = await decodeHeightsMeters(OPT.input);
  console.log(
    `  relief ${src.minKm.toFixed(3)} km .. ${src.maxKm.toFixed(3)} km`,
  );
  if (
    src.minKm < EXPECTED_MIN_KM[0] ||
    src.minKm > EXPECTED_MIN_KM[1] ||
    src.maxKm < EXPECTED_MAX_KM[0] ||
    src.maxKm > EXPECTED_MAX_KM[1]
  ) {
    throw new Error(
      `Decoded relief range ${src.minKm}..${src.maxKm} km is outside the published ` +
        `LOLA extremes. The decode is not in kilometres — refusing to derive normals ` +
        `from it (a rescaled height field silently produces a plausible-looking but ` +
        `wrongly-scaled normal map).`,
    );
  }

  // --- 2. downsample to the shipped grid --------------------------------
  console.log(
    `\nDownsampling ${src.width}x${src.height} -> ${OUT_WIDTH}x${OUT_HEIGHT} (exact area average)…`,
  );
  const heights = areaDownsample(
    src.meters,
    src.width,
    src.height,
    OUT_WIDTH,
    OUT_HEIGHT,
  );

  // --- 3. derive normals ------------------------------------------------
  console.log("Deriving tangent-space normals…");
  const { nx, ny, nz, stats } = heightsToNormals(
    heights,
    OUT_WIDTH,
    OUT_HEIGHT,
    LUNAR_RADIUS_M,
  );
  console.log(
    `  ground scale: ${stats.dNorthMetersPerTexel.toFixed(1)} m/texel north, ` +
      `${stats.dEastEquatorMetersPerTexel.toFixed(1)} m/texel east at the equator`,
  );
  console.log(
    `  slope |grad h|: median ${stats.medianSlope}, p90 ${stats.p90Slope}, ` +
      `p99 ${stats.p99Slope}, max ${stats.maxSlope}`,
  );
  console.log(
    `  tilt: mean ${stats.meanTiltDeg} deg, p99 ${stats.p99TiltDeg} deg, ` +
      `max ${stats.maxTiltDeg} deg`,
  );

  // --- 4. encode --------------------------------------------------------
  const enc = await measureEncodings(nx, ny, nz);
  const png = enc.png8;
  const pngHash = sha256(png);
  console.log(
    `\nEncoded: PNG ${ENCODE.bitDepth}-bit RGB level ${ENCODE.compressionLevel} -> ${png.length} bytes (${(png.length / 1024).toFixed(1)} KB)`,
  );
  console.log(`  sha256 ${pngHash}`);

  if (OPT.encodings) {
    return;
  }

  // --- 5. verify the ENCODED bytes --------------------------------------
  const raw = await decodeRaw(png);
  const dec = decodeNormalsRGB8(
    raw.pixels,
    raw.width,
    raw.height,
    raw.channels,
  );
  const result = runReliefChecks(dec.nx, dec.ny, dec.nz, raw.width, raw.height);
  console.log("\nRelief checks (on the encoded PNG):");
  reportChecks(result);
  if (!result.ok) {
    throw new Error("Relief checks FAILED — nothing written.");
  }
  const craters = measureCraters(dec.nx, dec.ny, dec.nz, raw.width, raw.height);

  // --- 6. write ---------------------------------------------------------
  fs.mkdirSync(OPT.out, { recursive: true });
  fs.writeFileSync(path.join(OPT.out, OUTPUT_NAME), png);
  console.log(`\nWrote ${path.join(OPT.out, OUTPUT_NAME)}`);

  const manifest = {
    $comment:
      "Generated by Tools/moon-albedo-bake/bake-lola-normals.mjs. Checked in as the " +
      "provenance + relief evidence for the bundled lunar normal map. " +
      "Tools/visual-regression/moon-normal-map-asset.spec.mjs re-derives the shipped " +
      "file's sha256 and rejects this manifest if they disagree.",
    source: SOURCE,
    derivation: {
      referenceRadiusMeters: LUNAR_RADIUS_M,
      downsample:
        "exact area-weighted average (mean elevation of the ground each output texel covers)",
      differencing:
        "central difference; longitude stencil widened to round(1/cos(lat)) texels so the east baseline stays a constant GROUND distance",
      poleHandling:
        "rows past a pole wrap ACROSS it to the antipodal longitude on the same row (one latitude step over the top), never clamped",
      tangentFrame: "east / north / up (geodetic surface normal)",
      encoding: "stored = n * 0.5 + 0.5, so flat is (128, 128, 255)",
      ...stats,
    },
    encode: ENCODE,
    encodingCandidates: Object.fromEntries(
      enc.rows.map(([name, bytes]) => [
        name,
        { bytes, ...(enc.fidelity[name] ?? {}) },
      ]),
    ),
    output: {
      file: `packages/engine/Source/Assets/Textures/Moon/${OUTPUT_NAME}`,
      bytes: png.length,
      sha256: pngHash,
      width: raw.width,
      height: raw.height,
    },
    projection: {
      type: "equirectangular (plate carree)",
      centerLongitudeDeg: 0,
      longitudePositive: "east",
      rowZero: "north (+90 deg latitude)",
    },
    craterRelief: craters,
    reliefChecks: result.checks,
  };
  const manifestPath = path.join(__dirname, "moon-normal-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);

  if (OPT.install) {
    fs.mkdirSync(ASSETS, { recursive: true });
    const dest = path.join(ASSETS, OUTPUT_NAME);
    fs.writeFileSync(dest, png);
    console.log(`Installed ${dest}`);
  } else {
    console.log(
      "\n(Not installed — re-run with --install to copy into the engine Assets dir.)",
    );
  }
}

try {
  if (OPT.verify) {
    await verifyInstalled();
  } else {
    await bake();
  }
} catch (e) {
  console.error(`\nERROR: ${e.message}`);
  process.exitCode = 1;
}
