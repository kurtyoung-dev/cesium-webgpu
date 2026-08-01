#!/usr/bin/env node
/**
 * bake-lroc-color.mjs — reproducible lunar-albedo bake (Campaign-12 C12-24).
 *
 * Input : NASA/GSFC SVS 4720 "CGI Moon Kit", 2019 colour map,
 *         `lroc_color_poles_2k.tif` — 2048x1024 equirectangular (plate carree),
 *         24-bit RGB, centred on 0 deg longitude, north at the top.
 *           URL   : https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif
 *           SHA256: 13b797422e8c4b8607ff2b2623ac3a046a6da0132d567c2d272d92fad7052c4a
 *           Bytes : 3,339,438
 *
 * Stages:
 *   1. Verify   — pinned SHA-256 of the source + 2048x1024 dimension assert.
 *                 A silent SVS re-issue must fail loudly, not re-bake.
 *   2. Transfer — NONE. Unlike the SVS 3572 star map (which SVS documents as
 *                 SMPTE gamma 1.8 and which therefore needed a transfer fix in
 *                 Tools/skybox-bake), SVS states no non-sRGB colour standard
 *                 for the 2019 CGI Moon Kit colour map, and the file carries no
 *                 ICC profile. It is consumed as sRGB, which is also how the
 *                 engine treats it. See README section 3 for the measurement
 *                 that shows no exposure match is needed either.
 *   3. Resample — NONE. SVS publishes this product at exactly 2048x1024, which
 *                 is the shipped size, so the bake introduces no resampling
 *                 kernel of its own. (The 4k/8k/16k/27360 members of the same
 *                 family exist; taking the official 2k avoids adding a
 *                 downsample step whose filter would have to be defended.)
 *   4. Encode   — JPEG quality 90, 4:4:4 chroma. Same encode settings as the
 *                 C12-10 star faces (Tools/skybox-bake), which are the fork's
 *                 precedent for bundled NASA celestial imagery. 4:2:0 is
 *                 rejected: chroma subsampling smears the (already subtle)
 *                 mare colour differences that are the entire point of using a
 *                 colour map rather than a grey one.
 *   5. Verify   — decode the ENCODED bytes back and run the landmark alignment
 *                 checks in lunar-landmarks.mjs. A 180 deg longitude phase
 *                 error, an east/west mirror, or a north/south mirror each
 *                 fail a specific named check. Nothing installs unless every
 *                 check passes.
 *   6. Manifest — write moon-albedo-manifest.json (checked in) recording the
 *                 provenance, the encode settings, the shipped file's SHA-256,
 *                 and the measured landmark luminances. The spec re-derives
 *                 the shipped file's hash and refuses to trust the manifest if
 *                 they disagree, so the evidence cannot drift from the asset.
 *
 * KTX2: not produced. No KTX2/Basis encoder is available in this repo or on
 * the build machine (`toktx`, `ktx`, `basisu` are all absent; `ktx-parse` is a
 * container parser, not an encoder). Tracked as MOON-ALBEDO-KTX2 in
 * migration_doc/DEFERRED_WORK.md — see README section 6.1.
 *
 * Usage:
 *   node Tools/moon-albedo-bake/bake-lroc-color.mjs             # bake to out/
 *   node Tools/moon-albedo-bake/bake-lroc-color.mjs --install   # + copy into Assets
 *   node Tools/moon-albedo-bake/bake-lroc-color.mjs --verify    # re-check the
 *                                                               # INSTALLED asset only
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
import { measureLandmarks, runAlignmentChecks } from "./lunar-landmarks.mjs";

sharp.cache(false);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(REPO, "packages/engine/Source/Assets/Textures/Moon");

// ---- Pinned source provenance -----------------------------------------
const SOURCE = Object.freeze({
  product: "NASA/GSFC SVS 4720 — CGI Moon Kit, 2019 colour map",
  file: "lroc_color_poles_2k.tif",
  url: "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_2k.tif",
  page: "https://svs.gsfc.nasa.gov/4720/",
  sha256: "13b797422e8c4b8607ff2b2623ac3a046a6da0132d567c2d272d92fad7052c4a",
  bytes: 3339438,
  width: 2048,
  height: 1024,
  retrieved: "2026-08-01",
});

const OUTPUT_NAME = "lroc_color_poles_2k.jpg";
const ENCODE = Object.freeze({ quality: 90, chromaSubsampling: "4:4:4" });

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
  skipHashCheck: arg("skip-hash-check", false) === true,
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

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
      `   ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(26)} ${String(c.value).padStart(8)} (need ${c.threshold})`,
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
  const result = runAlignmentChecks(
    raw.pixels,
    raw.width,
    raw.height,
    raw.channels,
  );
  console.log("\nAlignment checks:");
  reportChecks(result);
  if (!result.ok) {
    throw new Error("Alignment checks FAILED on the installed asset.");
  }
  console.log("\nAll alignment checks passed.");
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

  // --- 2/3/4. no transfer, no resample, encode --------------------------
  const jpeg = await sharp(OPT.input)
    .removeAlpha()
    .jpeg({ ...ENCODE, mozjpeg: false })
    .toBuffer();
  const jpegHash = sha256(jpeg);
  console.log(
    `\nEncoded: JPEG q${ENCODE.quality} ${ENCODE.chromaSubsampling} -> ${jpeg.length} bytes (${(jpeg.length / 1024).toFixed(1)} KB)`,
  );
  console.log(`  sha256 ${jpegHash}`);

  // --- 5. verify the ENCODED bytes --------------------------------------
  const raw = await decodeRaw(jpeg);
  const result = runAlignmentChecks(
    raw.pixels,
    raw.width,
    raw.height,
    raw.channels,
  );
  console.log("\nAlignment checks (on the encoded JPEG):");
  reportChecks(result);
  if (!result.ok) {
    throw new Error("Alignment checks FAILED — nothing written.");
  }
  const landmarks = measureLandmarks(
    raw.pixels,
    raw.width,
    raw.height,
    raw.channels,
  );

  // --- 6. write ---------------------------------------------------------
  fs.mkdirSync(OPT.out, { recursive: true });
  fs.writeFileSync(path.join(OPT.out, OUTPUT_NAME), jpeg);
  console.log(`\nWrote ${path.join(OPT.out, OUTPUT_NAME)}`);

  const manifest = {
    $comment:
      "Generated by Tools/moon-albedo-bake/bake-lroc-color.mjs. Checked in as the " +
      "provenance + alignment evidence for the bundled lunar albedo. " +
      "Tools/visual-regression/moon-albedo-asset.spec.mjs re-derives the shipped " +
      "file's sha256 and rejects this manifest if they disagree.",
    source: SOURCE,
    encode: ENCODE,
    transfer: "none (sRGB in, sRGB out; no ICC profile on the source)",
    resample: "none (SVS publishes this product at exactly 2048x1024)",
    output: {
      file: `packages/engine/Source/Assets/Textures/Moon/${OUTPUT_NAME}`,
      bytes: jpeg.length,
      sha256: jpegHash,
      width: raw.width,
      height: raw.height,
    },
    projection: {
      type: "equirectangular (plate carree)",
      centerLongitudeDeg: 0,
      longitudePositive: "east",
      rowZero: "north (+90 deg latitude)",
    },
    landmarkLuminance: landmarks,
    alignmentChecks: result.checks,
  };
  const manifestPath = path.join(__dirname, "moon-albedo-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);

  if (OPT.install) {
    fs.mkdirSync(ASSETS, { recursive: true });
    const dest = path.join(ASSETS, OUTPUT_NAME);
    fs.writeFileSync(dest, jpeg);
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
