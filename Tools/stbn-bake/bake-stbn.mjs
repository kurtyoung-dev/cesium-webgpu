#!/usr/bin/env node
/**
 * bake-stbn.mjs — reproducible spatiotemporal blue-noise (STBN) bake.
 * @purpose Reproducible spatiotemporal blue-noise bake: deterministic generate, quantise, spectral certify (abort on fail), encode raw .bin + tile-atlas PNG.
 * @status ACTIVE
 *
 * Campaign-13 row C13-11, unblocked by maintainer ruling R-2026-08-10-5.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PROVENANCE. This asset has no third party. There is no source download, no
 * pinned upstream hash and no `LICENSE.md` third-party entry to add, because
 * nothing here was obtained from anyone: the volume is COMPUTED from published
 * algorithm descriptions by the code in `stbn-core.mjs`, whose header names
 * the three papers and the choices we made where those papers leave a free
 * parameter. In particular NVIDIA's STBN SDK — textures and generator alike —
 * is out of bounds under its non-commercial licence (research lane R-STBN,
 * 2026-07-06), and nothing here descends from it.
 *
 * That inverts the usual shape of a bake tool in this repository. Its siblings
 * under `Tools/moon-albedo-bake/` and `Tools/skybox-bake/` spend their first
 * stage proving that a downloaded input is the one they think it is. This tool
 * has no input to verify, so the trust has to come from the other end: the
 * output is certified against the PUBLISHED SPECTRAL CHARACTERISATION of blue
 * noise, and nothing installs unless it passes.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * STAGES
 *   1. Generate — 64 independent void-and-cluster slices (Ulichney 1993),
 *                 then a separable spatiotemporal energy descent
 *                 (Georgiev-Fajardo 2016 energy, Wolfe et al. 2022 criterion).
 *                 Deterministic: same seed and parameters give byte-identical
 *                 output, on any machine, on any Node version. The randomness
 *                 is AES-256-CTR over zeros keyed by SHA-256 of the seed
 *                 string, not a JS PRNG.
 *   2. Quantise — ranks to the 8-bit texels the GPU reads. Exact and
 *                 histogram-preserving.
 *   3. Certify  — radially-averaged spatial power spectrum per slice, temporal
 *                 power spectrum per pixel time line, cross-pixel temporal
 *                 correlation. Bars in `stbn-spectrum.mjs`. FAILING HERE
 *                 ABORTS THE INSTALL.
 *   4. Encode   — the slice-major volume as a raw `.bin`, and as the 8x8 tile
 *                 atlas PNG the engine loads. The PNG is re-decoded and
 *                 compared byte-for-byte against the raw volume before either
 *                 is written, so an encoder bug cannot ship.
 *   5. Manifest — `stbn-manifest.json` (checked in) records every parameter,
 *                 both hashes, every measured spectrum number against its bar,
 *                 and the wall-clock cost. Written ONLY under `--install`: it
 *                 is the evidence for the SHIPPED asset, so an experimental
 *                 `--width 64` run must not leave it describing a volume
 *                 nobody installed.
 *                 `Tools/visual-regression/stbn-asset.spec.mjs` re-derives the
 *                 shipped file's hash and re-measures its spectra, and rejects
 *                 the manifest if either disagrees — so the evidence cannot
 *                 drift away from the asset.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * USAGE
 *   node Tools/stbn-bake/bake-stbn.mjs                # bake + certify to out/
 *   node Tools/stbn-bake/bake-stbn.mjs --install      # + install into Assets
 *   node Tools/stbn-bake/bake-stbn.mjs --verify       # re-certify the INSTALLED asset
 *   node Tools/stbn-bake/bake-stbn.mjs --repro        # bake twice, assert identical sha256
 *   node Tools/stbn-bake/bake-stbn.mjs --width 64 --height 64 --frames 32 --sweeps 20
 *
 * SCALING THE VOLUME. `--width/--height/--frames` must be powers of two and
 * `width*height` must be a multiple of 256 (so the 8-bit histogram stays
 * uniform). Cost is roughly linear in the voxel count for both stages; the
 * shipped 128x128x64 takes about three minutes on the development machine, so
 * a 256x256x64 volume would take about twelve. Nothing in the tool or the spec
 * hard-codes 128 or 64.
 *
 * No dependencies beyond Node built-ins. Linted by the `Tools/**` block in
 * eslint.config.js.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PARAMS,
  generateStbn,
  packAtlas,
  quantiseToBytes,
  unpackAtlas,
} from "./stbn-core.mjs";
import { decodeGray8, encodeGray8 } from "./stbn-png.mjs";
import { BARS, certify } from "./stbn-spectrum.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(here, "out");
const manifestPath = path.join(here, "stbn-manifest.json");

/** Install destination, relative to the repository root. */
export const ASSET_DIR_REL = "packages/engine/Source/Assets/Textures/Noise";

/**
 * @param {Buffer|Uint8Array} buf bytes
 * @returns {string} lowercase hex SHA-256
 */
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Round for the manifest so a re-bake on another machine does not churn the
 * file over floating-point noise in the last digits.
 * @param {number} v value
 * @param {number} [dp=6] decimal places
 * @returns {number} rounded value
 */
function round(v, dp = 6) {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/**
 * Parse `--flag value` / `--flag` argv into an options object.
 * @param {Array<string>} argv arguments after the script name
 * @returns {Record<string, string|boolean>} parsed options
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Canonical file names for a given volume shape.
 * @param {number} width slice width
 * @param {number} height slice height
 * @param {number} frames temporal depth
 * @returns {{base: string, png: string, bin: string}} names
 */
export function assetNames(width, height, frames) {
  const base = `stbn_scalar_${width}x${height}x${frames}`;
  return { base, png: `${base}.png`, bin: `${base}.bin` };
}

/**
 * Generate, quantise, certify and encode. Does not touch the filesystem.
 *
 * @param {Partial<import("./stbn-core.mjs").StbnParams>} overrides parameters
 * @param {(msg: string) => void} log progress sink
 * @returns {object} everything the caller might want to write out
 */
function bake(overrides, log) {
  const started = Date.now();
  const { volume, params, stats } = generateStbn(overrides, log);
  const bytes = quantiseToBytes(volume);
  const { width, height, frames } = params;

  log("  certifying spectra ...");
  const verdict = certify(bytes, width, height, frames);

  const atlas = packAtlas(bytes, width, height, frames);
  const png = encodeGray8(atlas.pixels, atlas.width, atlas.height);

  // Round-trip the PNG before anything is written. A silent encoder or
  // decoder bug here would ship a texture whose spectra were never actually
  // measured — the numbers above describe `bytes`, and this is the only thing
  // that proves the shipped file still contains `bytes`.
  const decoded = decodeGray8(png);
  if (decoded.width !== atlas.width || decoded.height !== atlas.height) {
    throw new Error("PNG round-trip changed the atlas dimensions");
  }
  const roundTripped = unpackAtlas(
    decoded.pixels,
    decoded.width,
    width,
    height,
    frames,
    atlas.cols,
  );
  if (Buffer.compare(Buffer.from(roundTripped), Buffer.from(bytes)) !== 0) {
    throw new Error("PNG round-trip did not reproduce the volume bytes");
  }

  const totalSeconds = (Date.now() - started) / 1000;
  return {
    params,
    stats,
    bytes,
    verdict,
    atlas,
    png,
    rawSha256: sha256(bytes),
    pngSha256: sha256(png),
    totalSeconds,
  };
}

/**
 * Format the certification for the console.
 * @param {ReturnType<typeof certify>} verdict the verdict
 * @returns {string} a report block
 */
function formatVerdict(verdict) {
  const s = verdict.spatial;
  const t = verdict.temporal;
  const c = verdict.crossCorrelation;
  const lines = [
    "  spectrum certification (white noise scores 1.000 on every band)",
    `    spatial   low  ${s.low.toFixed(4)}  (bar <= ${BARS.spatialLowMax})`,
    `    spatial   mid  ${s.mid.toFixed(4)}`,
    `    spatial   high ${s.high.toFixed(4)}  (bar >= ${BARS.spatialHighMin})`,
    `    spatial   anisotropy ${s.anisotropyDb.toFixed(2)} dB (diagnostic)`,
    `    temporal  low  ${t.low.toFixed(4)}  (bar <= ${BARS.temporalLowMax})`,
    `    temporal  high ${t.high.toFixed(4)}  (bar >= ${BARS.temporalHighMin})`,
    `    cross-pixel temporal correlation ${c.ratio.toFixed(3)}x chance ` +
      `(bar <= ${BARS.crossCorrelationRatioMax}x)`,
    verdict.pass
      ? "    VERDICT: PASS"
      : `    VERDICT: FAIL — ${verdict.failures.join("; ")}`,
  ];
  return lines.join("\n");
}

/**
 * Build the checked-in manifest object.
 * @param {ReturnType<typeof bake>} result bake result
 * @param {string} assetRel installed asset path, repo-relative
 * @returns {object} the manifest
 */
function buildManifest(result, assetRel) {
  const { params, stats, verdict, atlas } = result;
  const names = assetNames(params.width, params.height, params.frames);
  return {
    $comment:
      "Generated by Tools/stbn-bake/bake-stbn.mjs. Checked in as the provenance " +
      "and spectral evidence for the bundled spatiotemporal blue-noise mask. " +
      "Tools/visual-regression/stbn-asset.spec.mjs re-derives the shipped file's " +
      "sha256 AND re-measures its spectra, and rejects this manifest if either " +
      "disagrees.",
    provenance: {
      origin: "generated in-repo; no third-party asset or source code",
      ruling: "R-2026-08-10-5 (migration_doc/MAINTAINER_RULINGS_2026-08-10.md)",
      row: "C13-11 (migration_doc/QUEUE_2026-07-23_CAMPAIGN13.md)",
      thirdPartyLicenseEntryRequired: false,
      excluded:
        "NVIDIA STBN SDK textures and generator (non-commercial licence; " +
        "research lane R-STBN, 2026-07-06) — not used, not consulted, not derived from",
      algorithms: [
        {
          use: "per-slice spatial mask",
          method: "void-and-cluster",
          citation:
            "R. A. Ulichney, 'The void-and-cluster method for dither array generation', " +
            "Proc. SPIE 1913, Human Vision, Visual Processing, and Digital Display IV, " +
            "1993, pp. 332-343",
          doi: "10.1117/12.152707",
        },
        {
          use: "pairwise energy minimised by swaps",
          method: "blue-noise dithered sampling energy",
          citation:
            "I. Georgiev, M. Fajardo, 'Blue-noise dithered sampling', " +
            "ACM SIGGRAPH 2016 Talks, article 35",
          doi: "10.1145/2897839.2927430",
        },
        {
          use: "separable spatiotemporal criterion and its spectral characterisation",
          method: "spatiotemporal blue noise",
          citation:
            "A. Wolfe, N. Morrical, T. Akenine-Moller, R. Ramamoorthi, " +
            "'Spatiotemporal Blue Noise Masks', Eurographics Symposium on Rendering 2022",
          doi: "10.2312/sr.20221161",
        },
      ],
      randomness:
        "AES-256-CTR (FIPS 197, NIST SP 800-38A) over a zero plaintext, keyed by " +
        "SHA-256 (FIPS 180-4) of the seed string, via node:crypto. Chosen over a " +
        "hand-rolled JS PRNG so the stream is byte-identical across machines, " +
        "operating systems and Node versions, and so no PRNG implementation had " +
        "to be copied from anywhere.",
    },
    asset: {
      installed: assetRel,
      atlasWidth: atlas.width,
      atlasHeight: atlas.height,
      atlasCols: atlas.cols,
      atlasRows: atlas.rows,
      format:
        "PNG, 8-bit greyscale (colour type 0), non-interlaced, filter None",
      layout:
        "Slice t occupies tile (t % atlasCols, floor(t / atlasCols)) with the " +
        "origin at the top-left; within a tile the texels are row-major. " +
        "Both axes and the time axis are toroidal, so the mask tiles across " +
        "the screen and loops in time with no seam.",
      sha256: result.pngSha256,
      bytes: result.png.length,
    },
    volume: {
      width: params.width,
      height: params.height,
      frames: params.frames,
      channels: 1,
      encoding:
        "8-bit unorm; texel = floor(rank * 256 / (width*height)), so every byte " +
        "value occurs exactly (width*height/256) times per slice",
      rawFile: names.bin,
      rawBytes: result.bytes.length,
      rawSha256: result.rawSha256,
      rawLayout: "slice-major: slice 0 rows 0..h-1, then slice 1, ...",
    },
    parameters: params,
    generation: {
      voidAndClusterSeconds: round(stats.vcSeconds, 2),
      annealSeconds: round(stats.annealSeconds, 2),
      totalSeconds: round(result.totalSeconds, 2),
      swapsProposed: stats.proposed,
      swapsAccepted: stats.accepted,
      acceptRate: round(stats.acceptRate, 6),
      energyBefore: {
        spatial: round(stats.energyBefore.spatial),
        temporal: round(stats.energyBefore.temporal),
      },
      energyAfter: {
        spatial: round(stats.energyAfter.spatial),
        temporal: round(stats.energyAfter.temporal),
      },
    },
    certification: {
      $comment:
        "Every band figure is normalised by the spectrum's own mean, so white " +
        "noise scores exactly 1.000 on all of them. Bars live in " +
        "Tools/stbn-bake/stbn-spectrum.mjs.",
      bars: BARS,
      spatial: {
        low: round(verdict.spatial.low),
        mid: round(verdict.spatial.mid),
        high: round(verdict.spatial.high),
        anisotropyDb: round(verdict.spatial.anisotropyDb),
        radial: Array.from(verdict.spatial.radial, (v) => round(v, 5)),
      },
      temporal: {
        low: round(verdict.temporal.low),
        high: round(verdict.temporal.high),
        radial: Array.from(verdict.temporal.radial, (v) => round(v, 5)),
      },
      crossPixelTemporalCorrelation: {
        rms: round(verdict.crossCorrelation.rms),
        chance: round(verdict.crossCorrelation.chance),
        ratio: round(verdict.crossCorrelation.ratio),
      },
      pass: verdict.pass,
    },
  };
}

/**
 * `--verify`: re-certify whatever is currently installed, using only the
 * manifest's declared shape. Does not regenerate anything.
 * @returns {number} process exit code
 */
function verifyInstalled() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`No manifest at ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assetPath = path.join(repoRoot, manifest.asset.installed);
  if (!fs.existsSync(assetPath)) {
    console.error(`Installed asset missing: ${manifest.asset.installed}`);
    return 1;
  }
  const png = fs.readFileSync(assetPath);
  const hash = sha256(png);
  console.log(`asset  ${manifest.asset.installed}`);
  console.log(`sha256 ${hash}`);
  if (hash !== manifest.asset.sha256) {
    console.error(`  MISMATCH — manifest records ${manifest.asset.sha256}`);
    return 1;
  }

  const decoded = decodeGray8(png);
  const { width, height, frames } = manifest.volume;
  const bytes = unpackAtlas(
    decoded.pixels,
    decoded.width,
    width,
    height,
    frames,
    manifest.asset.atlasCols,
  );
  const rawHash = sha256(bytes);
  if (rawHash !== manifest.volume.rawSha256) {
    console.error(
      `  decoded volume sha256 ${rawHash} != manifest ${manifest.volume.rawSha256}`,
    );
    return 1;
  }
  const verdict = certify(bytes, width, height, frames);
  console.log(formatVerdict(verdict));
  return verdict.pass ? 0 : 1;
}

/**
 * Entry point.
 * @returns {Promise<number>} process exit code
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) {
    return verifyInstalled();
  }

  /** @type {Partial<import("./stbn-core.mjs").StbnParams>} */
  const overrides = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    if (args[key] === undefined) {
      continue;
    }
    const raw = args[key];
    overrides[key] = key === "seed" ? String(raw) : Number(raw);
  }

  const log = (/** @type {string} */ msg) => console.log(msg);

  console.log("STBN bake — C13-11 (in-repo generation, no third-party input)");
  console.log(
    `  params ${JSON.stringify({ ...DEFAULT_PARAMS, ...overrides }, null, 0)}`,
  );

  const result = bake(overrides, log);
  const { params } = result;
  const names = assetNames(params.width, params.height, params.frames);

  console.log(
    `  volume  ${params.width}x${params.height}x${params.frames} ` +
      `(${result.bytes.length} bytes)  sha256 ${result.rawSha256}`,
  );
  console.log(
    `  atlas   ${result.atlas.width}x${result.atlas.height} ` +
      `(${result.atlas.cols}x${result.atlas.rows} tiles), PNG ${result.png.length} bytes  ` +
      `sha256 ${result.pngSha256}`,
  );
  console.log(formatVerdict(result.verdict));
  console.log(`  wall clock ${result.totalSeconds.toFixed(1)}s`);

  if (args.repro) {
    console.log("  --repro: regenerating to confirm byte-identical output ...");
    const second = bake(overrides, () => {});
    const same =
      second.rawSha256 === result.rawSha256 &&
      second.pngSha256 === result.pngSha256;
    console.log(
      `  second bake raw sha256 ${second.rawSha256}\n` +
        `  second bake png sha256 ${second.pngSha256}\n` +
        `  REPRODUCIBLE: ${same ? "YES" : "NO"}`,
    );
    if (!same) {
      return 1;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, names.bin), result.bytes);
  fs.writeFileSync(path.join(outDir, names.png), result.png);
  console.log(
    `  wrote ${path.relative(repoRoot, outDir)}/{${names.bin},${names.png}}`,
  );

  if (!result.verdict.pass) {
    console.error(
      "  certification FAILED — nothing installed, manifest not written",
    );
    return 1;
  }

  const assetRel = `${ASSET_DIR_REL}/${names.png}`;
  if (!args.install) {
    // The manifest is the evidence for the INSTALLED asset, and the spec binds
    // the two together by hash. Writing it from a bake that installed nothing
    // would leave the checked-in evidence describing a volume that is not the
    // shipped one — which is exactly what an experimental
    // `--width 64 --frames 32` run would do, silently, while every console
    // line said PASS. So the manifest moves only when the asset does.
    console.log(
      `  (not installed — pass --install to write ${assetRel} and update ` +
        `${path.relative(repoRoot, manifestPath)})`,
    );
    return 0;
  }

  const dest = path.join(repoRoot, assetRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result.png);
  console.log(`  installed ${assetRel}`);

  const manifest = buildManifest(result, assetRel);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  wrote ${path.relative(repoRoot, manifestPath)}`);

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
