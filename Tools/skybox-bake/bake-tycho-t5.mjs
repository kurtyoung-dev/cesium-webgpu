#!/usr/bin/env node
/**
 * bake-tycho-t5.mjs — reproducible star-map bake pipeline (Campaign-12 C12-10).
 *
 * Input : NASA SVS 3572 "Tycho Catalog Skymap v2.0", TychoSkymapII.t5_16384x08192
 *         equirectangular (RA/Dec plate carrée). Highest-fidelity offered is the
 *         16384x8192 TIFF (8-bit RGB, no ICC profile).
 *           URL   : https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_16384x08192.tif
 *           SHA256: 2eb9baf5796c62bb04d8c87625b93356cd5ff4172bc56d6b731df554393de04f
 *
 * Stages (see README.md for the full derivation of every constant here):
 *   1. Transfer  — decode SMPTE gamma-1.8, re-encode sRGB (fixes the "too dark /
 *                  flat" look; the shipped JPEGs carry no ICC profile so the
 *                  engine treats them as sRGB — a gamma-1.8 file shown as sRGB
 *                  darkens). Applied as a per-channel 256->256 LUT.
 *   2. Reproject — equirect -> six GL cube faces. Face orientation matches the
 *                  existing tycho2t3_80_* faces; convention was DERIVED
 *                  empirically (see README "Face orientation") and is:
 *                     sphereDir = negate-X of the GL face direction, with the
 *                     face v-axis flipped, sampled as lon=atan2(y,x),
 *                     lat=asin(z), equirect row 0 = +Z (north celestial pole).
 *   3. Emit      — un-blurred faces at 4096 and 2048; PLUS a blurred
 *                  "diffuse-only" variant (DR-01: low-pass strong enough to
 *                  destroy point sources) at 4096 and 2048. Both variants are
 *                  kept so the DR-01 seam decision is reversible without a
 *                  re-bake.
 *
 * Outputs (all under --out, gitignored):
 *   tycho2t5_80_diffuse_{face}.jpg      2048 blurred     (the SHIPPED DEFAULT faces, DR-01)
 *   tycho2t5_80_diffuse_4096_{face}.jpg 4096 blurred     (opt-in / VRAM policy)
 *   tycho2t5_80_{face}.jpg              2048 un-blurred  (DR-01 reversal artifact, also shipped)
 *   tycho2t5_80_4096_{face}.jpg         4096 un-blurred  (opt-in / VRAM policy)
 *
 * BOTH 2048 sets are checked into the engine assets dir: --install-diffuse
 * copies the diffuse set (SkyBox.Variant.TYCHO_T5_DIFFUSE, the default since
 * C12-11) and --install copies the un-blurred set (TYCHO_T5), which DR-01
 * requires stay bundled so the seam is reversible without a re-bake.
 *
 * --manifest-only re-derives skybox-manifest.json — the per-face point-source
 * census, band structure, and SHA-256 of every shipped face — from an existing
 * out/, and REFUSES to write it unless the DR-01 contract holds.
 *
 * Dependency: `sharp` (image ops), an explicit devDependency at the repo root.
 *
 * Usage:
 *   node Tools/skybox-bake/bake-tycho-t5.mjs                      # bake all variants to out/
 *   node Tools/skybox-bake/bake-tycho-t5.mjs --install-diffuse    # + install the DEFAULT faces
 *   node Tools/skybox-bake/bake-tycho-t5.mjs --install            # + install the reversal faces
 *   node Tools/skybox-bake/bake-tycho-t5.mjs --manifest-only      # re-derive the manifest
 *   node Tools/skybox-bake/bake-tycho-t5.mjs --sigma 28           # override diffuse blur sigma
 *   node Tools/skybox-bake/bake-tycho-t5.mjs --only-diffuse       # re-run just the blur variant
 */
// Node ESM offline tooling. Linted by the `Tools/**` block in
// eslint.config.js, which supplies the Node (and browser) global sets.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";

import {
  bandStructure,
  checkDr01,
  pointSourceCensus,
  toLuminance,
} from "./starmap-census.mjs";

sharp.cache(false);
sharp.concurrency(0); // libvips picks nproc

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(REPO, "packages/engine/Source/Assets/Textures/SkyBox");

// ---- CLI ---------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    return def;
  }
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const OPT = {
  input: arg(
    "input",
    path.join(__dirname, "work", "TychoSkymapII.t5_16384x08192.tif"),
  ),
  out: arg("out", path.join(__dirname, "out")),
  faceSize: parseInt(arg("faceSize", "4096"), 10), // master reproject size
  shipSize: parseInt(arg("shipSize", "2048"), 10), // checked-in face size
  quality: parseInt(arg("quality", "90"), 10),
  chroma: arg("chroma", "4:4:4"),
  // Diffuse low-pass sigma, in *source-equirect pixels* (16384 wide => 45.5 px/deg).
  // Default 20 px => FWHM 2.355*20 = 47 px = 1.03 deg, which annihilates point
  // sources (Tycho stars render <0.1 deg) while preserving the degrees-scale
  // Milky Way band. See README "Blurred (diffuse-only) variant".
  sigma: parseFloat(arg("sigma", "20")),
  install: !!arg("install", false),
  // C12-11 / DR-01: install the 2048 *diffuse* faces as the shipped default
  // set. Kept as its own flag rather than folded into --install so the
  // un-blurred reversal artifact can never be replaced by accident.
  installDiffuse: !!arg("install-diffuse", false),
  onlyDiffuse: !!arg("only-diffuse", false),
  onlyUnblurred: !!arg("only-unblurred", false),
  // Recompute the census + provenance manifest from an existing out/ without
  // re-running the ~10 min reprojection.
  manifestOnly: !!arg("manifest-only", false),
};

const FACES = ["px", "mx", "py", "my", "pz", "mz"];

// ---- Stage 1: SMPTE gamma-1.8 -> sRGB transfer LUT ---------------------
// v in [0,1] authored for a gamma-1.8 display  ->  linear light  ->  sRGB OETF.
//   L      = v ^ 1.8                                   (decode SMPTE gamma 1.8)
//   sRGB   = 12.92*L                    if L <= 0.0031308
//          = 1.055*L^(1/2.4) - 0.055    otherwise      (encode sRGB)
function srgbOetf(L) {
  return L <= 0.0031308 ? 12.92 * L : 1.055 * Math.pow(L, 1 / 2.4) - 0.055;
}
function buildTransferLut() {
  const lut = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const L = Math.pow(v, 1.8);
    lut[i] = Math.max(0, Math.min(255, Math.round(srgbOetf(L) * 255)));
  }
  return lut;
}

// ---- Stage 2: reprojection --------------------------------------------
// Face pixel (col i, row j) at size N -> unit sphere direction, in the convention
// derived to match tycho2t3_80_*. sc across columns, tc down rows.
function faceSphereDir(face, sc, tc, out) {
  switch (face) {
    case "px":
      out[0] = -1;
      out[1] = tc;
      out[2] = -sc;
      break;
    case "mx":
      out[0] = 1;
      out[1] = tc;
      out[2] = sc;
      break;
    case "py":
      out[0] = -sc;
      out[1] = 1;
      out[2] = -tc;
      break;
    case "my":
      out[0] = -sc;
      out[1] = -1;
      out[2] = tc;
      break;
    case "pz":
      out[0] = -sc;
      out[1] = tc;
      out[2] = 1;
      break;
    case "mz":
      out[0] = sc;
      out[1] = tc;
      out[2] = -1;
      break;
  }
}

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// Bilinear sample of an equirect uint8 RGB buffer (wrap in lon, clamp in lat).
function reprojectFace(eq, EW, EH, face, N) {
  const outBuf = Buffer.alloc(N * N * 3);
  const d = [0, 0, 0];
  for (let j = 0; j < N; j++) {
    const tc = (2 * (j + 0.5)) / N - 1;
    for (let i = 0; i < N; i++) {
      const sc = (2 * (i + 0.5)) / N - 1;
      faceSphereDir(face, sc, tc, d);
      const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      const x = d[0] / len,
        y = d[1] / len,
        z = d[2] / len;
      let lon = Math.atan2(y, x);
      if (lon < 0) {
        lon += TWO_PI;
      }
      const lat = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z);
      const fx = (lon / TWO_PI) * EW - 0.5;
      const fy = ((HALF_PI - lat) / Math.PI) * EH - 0.5;
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy);
      const dx = fx - x0,
        dy = fy - y0;
      const x0w = ((x0 % EW) + EW) % EW;
      const x1w = (((x0 + 1) % EW) + EW) % EW;
      const y0c = y0 < 0 ? 0 : y0 >= EH ? EH - 1 : y0;
      const y1c = y0 + 1 < 0 ? 0 : y0 + 1 >= EH ? EH - 1 : y0 + 1;
      const o = (j * N + i) * 3;
      const w00 = (1 - dx) * (1 - dy),
        w10 = dx * (1 - dy);
      const w01 = (1 - dx) * dy,
        w11 = dx * dy;
      const p00 = (y0c * EW + x0w) * 3,
        p10 = (y0c * EW + x1w) * 3;
      const p01 = (y1c * EW + x0w) * 3,
        p11 = (y1c * EW + x1w) * 3;
      for (let c = 0; c < 3; c++) {
        outBuf[o + c] = Math.round(
          eq[p00 + c] * w00 +
            eq[p10 + c] * w10 +
            eq[p01 + c] * w01 +
            eq[p11 + c] * w11,
        );
      }
    }
  }
  return outBuf;
}

// Horizontal-wrap Gaussian blur of an equirect (so RA=0/360 has no seam).
//
// The wrap padding is built with explicit Buffer copies rather than sharp's
// `composite()`. That is not a style preference — `composite()` is applied at
// the END of sharp's pipeline, AFTER `blur()`, regardless of the order the
// calls are chained in. The previous implementation therefore blurred the empty
// black `create` base and then pasted the un-blurred strips on top of it, so
// the "diffuse" output was bit-for-bit as sharp as the input: a total no-op
// that left every resolved star in place. It also returned RGBA (libvips adds
// an alpha band for the `over` blend), which the caller read back with a
// 3-byte stride, rotating the channels against the pixel grid.
//
// Both defects were silent: the file sizes stayed plausible and the mean was
// roughly conserved, and a mean is invariant under blur anyway, so only a PEAK
// or point-source metric can tell a real low-pass from a skipped one. See
// `starmap-census.mjs` for the metrics that now assert this.
async function blurEquirectWrapped(eq, EW, EH, sigmaPx) {
  const pad = Math.ceil(sigmaPx * 3);
  const wideW = EW + 2 * pad;
  const wide = Buffer.alloc(wideW * EH * 3);
  for (let y = 0; y < EH; y++) {
    const s = y * EW * 3;
    const d = y * wideW * 3;
    eq.copy(wide, d, s + (EW - pad) * 3, s + EW * 3); // left pad  <- right edge
    eq.copy(wide, d + pad * 3, s, s + EW * 3); // centre
    eq.copy(wide, d + (pad + EW) * 3, s, s + pad * 3); // right pad <- left edge
  }

  const out = await sharp(wide, {
    raw: { width: wideW, height: EH, channels: 3 },
  })
    .blur(sigmaPx)
    .extract({ left: pad, top: 0, width: EW, height: EH })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Permanent sentinels: both failure modes above were invisible in the output
  // size, so assert the stride contract explicitly instead of trusting it.
  if (out.info.channels !== 3) {
    throw new Error(
      `[bake] blurEquirectWrapped produced ${out.info.channels} channels, expected 3 — ` +
        `reprojectFace() indexes with a 3-byte stride and would silently misread it.`,
    );
  }
  if (out.data.length !== EW * EH * 3) {
    throw new Error(
      `[bake] blurEquirectWrapped produced ${out.data.length} bytes, expected ${EW * EH * 3}.`,
    );
  }
  return out.data;
}

async function writeFace(faceBuf, N, targetSize, filePath) {
  let img = sharp(faceBuf, { raw: { width: N, height: N, channels: 3 } });
  if (targetSize !== N) {
    img = img.resize(targetSize, targetSize, { kernel: "lanczos3" });
  }
  await img
    .jpeg({
      quality: OPT.quality,
      chromaSubsampling: OPT.chroma,
      mozjpeg: true,
    })
    .toFile(filePath);
  return fs.statSync(filePath).size;
}

// ---- Census + provenance manifest (C12-11) -----------------------------
const MANIFEST = path.join(__dirname, "skybox-manifest.json");

const sha256File = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * Decode one baked face and measure it with the shared, dependency-free
 * metrics in `starmap-census.mjs`. `sharp` lives on this side of the fence so
 * the spec that re-checks these numbers can stay pure Node.
 */
async function measureFace(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lum = toLuminance(data, info.width, info.height);
  const points = pointSourceCensus(lum, info.width, info.height);
  const band = bandStructure(lum, info.width, info.height, 128);
  return {
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
    width: info.width,
    height: info.height,
    points: points.count,
    peakLuminance: +points.peakMax.toFixed(2),
    strongestContrast: +points.strongest.toFixed(2),
    bandStdDev: +band.stdDev.toFixed(4),
    bandMean: +band.mean.toFixed(4),
  };
}

/**
 * Write the checked-in provenance + DR-01 evidence manifest, and REFUSE to
 * write it if the measured faces do not satisfy the seam contract. The bake is
 * the only place with decoded pixels, so this is where the contract is
 * enforced; `skybox-diffuse-seam.spec.mjs` then re-derives every SHA-256 here
 * against the installed assets so the evidence can never drift from the bytes
 * it describes.
 */
async function writeManifest() {
  console.log(`[bake] census: measuring faces for the DR-01 manifest`);
  const diffuse = {};
  const unblurred = {};
  const installed = {};

  for (const f of FACES) {
    unblurred[f] = await measureFace(
      path.join(OPT.out, `tycho2t5_80_${f}.jpg`),
    );
    diffuse[f] = await measureFace(
      path.join(OPT.out, `tycho2t5_80_diffuse_${f}.jpg`),
    );
    console.log(
      `[bake]   ${f}: unblurred points=${unblurred[f].points} bandStd=${unblurred[f].bandStdDev}  ` +
        `diffuse points=${diffuse[f].points} bandStd=${diffuse[f].bandStdDev} bandMean=${diffuse[f].bandMean}`,
    );
  }

  // Enforce DR-01 per face before anything is recorded as evidence.
  const failures = [];
  for (const f of FACES) {
    const r = checkDr01(
      { points: diffuse[f].points, bandStdDev: diffuse[f].bandStdDev },
      { points: unblurred[f].points, bandStdDev: unblurred[f].bandStdDev },
    );
    r.failures.forEach((m) => failures.push(`${f}: ${m}`));
    diffuse[f].bandRatio = +r.bandRatio.toFixed(4);
  }
  if (failures.length > 0) {
    throw new Error(
      `[bake] DR-01 seam contract FAILED — manifest not written:\n  ` +
        failures.join("\n  "),
    );
  }

  for (const f of FACES) {
    const p = path.join(ASSETS, `tycho2t5_80_diffuse_${f}.jpg`);
    if (fs.existsSync(p)) {
      installed[f] = { bytes: fs.statSync(p).size, sha256: sha256File(p) };
    }
  }

  const manifest = {
    $comment:
      "Generated by Tools/skybox-bake/bake-tycho-t5.mjs. Checked in as the DR-01 provenance + seam evidence for the bundled star-map cube faces. Tools/visual-regression/skybox-diffuse-seam.spec.mjs re-derives each shipped file's sha256 and rejects this manifest if they disagree.",
    decision:
      "Campaign 12 DR-01 (QUEUE_2026-07-19_CAMPAIGN12.md §6c): the cubemap carries DIFFUSE Milky Way light only; every RESOLVED star comes from the sprite catalogue (Scene/StarField + BrightStarCatalog).",
    source: {
      product:
        'NASA/GSFC SVS 3572 — "The Tycho Catalog Skymap, Version 2.0", t5 variant',
      file: path.basename(OPT.input),
      url: "https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_16384x08192.tif",
      page: "https://svs.gsfc.nasa.gov/3572/",
      sha256:
        "2eb9baf5796c62bb04d8c87625b93356cd5ff4172bc56d6b731df554393de04f",
      bytes: 402653312,
      width: 16384,
      height: 8192,
      retrieved: "2026-08-06",
    },
    transfer:
      "SMPTE gamma 1.8 -> linear -> sRGB OETF, per-channel 256->256 LUT",
    reproject: "equirect -> 6 GL cube faces at 4096, bilinear, lon-wrapped",
    encode: {
      faceSize: OPT.shipSize,
      masterSize: OPT.faceSize,
      resample: "lanczos3",
      quality: OPT.quality,
      chromaSubsampling: OPT.chroma,
      mozjpeg: true,
    },
    diffuse: {
      lowPass: `wrapped Gaussian on the corrected equirect, sigma=${OPT.sigma} source px`,
      sigmaDegrees: +((OPT.sigma / (16384 / 360)) * 1).toFixed(4),
      fwhmDegrees: +((2.355 * OPT.sigma) / (16384 / 360)).toFixed(4),
      prefix: "tycho2t5_80_diffuse",
      variant: "SkyBox.Variant.TYCHO_T5_DIFFUSE (default since C12-11)",
      faces: diffuse,
      installed,
    },
    unblurredReversalArtifact: {
      note: "Retained + bundled so DR-01's reversal plan needs no re-bake; selectable as SkyBox.Variant.TYCHO_T5.",
      prefix: "tycho2t5_80",
      faces: unblurred,
    },
  };

  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[bake] manifest -> ${MANIFEST}`);
}

// ---- Main --------------------------------------------------------------
async function main() {
  fs.mkdirSync(OPT.out, { recursive: true });

  // --manifest-only re-measures an existing out/ without re-baking.
  if (OPT.manifestOnly) {
    await writeManifest();
    return;
  }
  if (!fs.existsSync(OPT.input)) {
    console.error(
      `[bake] input not found: ${OPT.input}\n` +
        `Download it first:\n  curl -L -o "${OPT.input}" ` +
        `https://svs.gsfc.nasa.gov/vis/a000000/a003500/a003572/TychoSkymapII.t5_16384x08192.tif`,
    );
    process.exit(1);
  }

  console.log(`[bake] input : ${OPT.input}`);
  const meta = await sharp(OPT.input, { limitInputPixels: false }).metadata();
  const EW = meta.width,
    EH = meta.height;
  console.log(`[bake] equirect ${EW}x${EH} ${meta.channels}ch ${meta.depth}`);

  // Stage 1: load + apply gamma-1.8 -> sRGB transfer (per-channel LUT).
  console.log(`[bake] stage 1: gamma-1.8 -> sRGB transfer LUT`);
  const lut = buildTransferLut();
  const raw = await sharp(OPT.input, { limitInputPixels: false })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  for (let i = 0; i < raw.length; i++) {
    raw[i] = lut[raw[i]];
  }
  const N = OPT.faceSize;
  const report = { unblurred: {}, diffuse: {} };

  // Stage 2/3a: un-blurred faces.
  if (!OPT.onlyDiffuse) {
    console.log(`[bake] stage 2: reproject un-blurred faces @ ${N}`);
    for (const f of FACES) {
      const faceBuf = reprojectFace(raw, EW, EH, f, N);
      const p4096 = path.join(OPT.out, `tycho2t5_80_4096_${f}.jpg`);
      const p2048 = path.join(OPT.out, `tycho2t5_80_${f}.jpg`);
      const s4096 = await writeFace(faceBuf, N, N, p4096);
      const s2048 = await writeFace(faceBuf, N, OPT.shipSize, p2048);
      report.unblurred[f] = { s4096, s2048 };
      console.log(
        `[bake]   ${f}: 4096=${(s4096 / 1048576).toFixed(2)}MB  ` +
          `${OPT.shipSize}=${(s2048 / 1048576).toFixed(2)}MB`,
      );
    }
  }

  // Stage 3b: blurred diffuse-only faces (DR-01).
  if (!OPT.onlyUnblurred) {
    console.log(
      `[bake] stage 3: blur equirect (sigma=${OPT.sigma}px) -> diffuse faces`,
    );
    const blurred = await blurEquirectWrapped(raw, EW, EH, OPT.sigma);
    for (const f of FACES) {
      const faceBuf = reprojectFace(blurred, EW, EH, f, N);
      const p4096 = path.join(OPT.out, `tycho2t5_80_diffuse_4096_${f}.jpg`);
      const p2048 = path.join(OPT.out, `tycho2t5_80_diffuse_${f}.jpg`);
      const s4096 = await writeFace(faceBuf, N, N, p4096);
      const s2048 = await writeFace(faceBuf, N, OPT.shipSize, p2048);
      report.diffuse[f] = { s4096, s2048 };
      console.log(
        `[bake]   ${f}: diffuse 4096=${(s4096 / 1048576).toFixed(2)}MB  ` +
          `${OPT.shipSize}=${(s2048 / 1048576).toFixed(2)}MB`,
      );
    }
  }

  // Optional: install the 2048 un-blurred faces into the engine assets dir.
  if (OPT.install && !OPT.onlyDiffuse) {
    console.log(
      `[bake] install: copying ${OPT.shipSize} un-blurred faces -> ${ASSETS}`,
    );
    fs.mkdirSync(ASSETS, { recursive: true });
    for (const f of FACES) {
      fs.copyFileSync(
        path.join(OPT.out, `tycho2t5_80_${f}.jpg`),
        path.join(ASSETS, `tycho2t5_80_${f}.jpg`),
      );
    }
  }

  // C12-11 / DR-01: install the 2048 diffuse faces alongside (never over) the
  // un-blurred set, which stays bundled as the ratified reversal artifact.
  if (OPT.installDiffuse && !OPT.onlyUnblurred) {
    console.log(
      `[bake] install-diffuse: copying ${OPT.shipSize} diffuse faces -> ${ASSETS}`,
    );
    fs.mkdirSync(ASSETS, { recursive: true });
    for (const f of FACES) {
      fs.copyFileSync(
        path.join(OPT.out, `tycho2t5_80_diffuse_${f}.jpg`),
        path.join(ASSETS, `tycho2t5_80_diffuse_${f}.jpg`),
      );
    }
  }

  // Totals.
  const sumShip = FACES.reduce(
    (a, f) => a + (report.unblurred[f]?.s2048 || 0),
    0,
  );
  console.log(
    `[bake] DONE. Shipped set (${OPT.shipSize}/face un-blurred): ` +
      `${(sumShip / 1048576).toFixed(2)} MB total across 6 faces.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
