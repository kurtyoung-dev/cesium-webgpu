// stbn-asset.spec.mjs — C13-11: pins the bundled spatiotemporal blue-noise
// mask, the spectral evidence that certifies it, and the provenance record
// that says it has no third party.
// @purpose Pins the bundled STBN blue-noise atlas: byte/manifest SHA-256, re-measured spectra, histogram uniformity, provenance, with mutant controls.
// @status ACTIVE
//
// These tests fail if:
//   - the shipped atlas goes missing, changes dimensions or tile layout, or
//     stops being 8-bit greyscale PNG. All three are load-bearing: the loader
//     stub and the eventual shader both index slice `t` by tile position, so a
//     re-encode that reflowed the tiles would silently return a different
//     slice for every frame;
//   - the shipped bytes drift from the manifest. The manifest is NOT trusted
//     on its own — the spec re-derives the file's SHA-256 and the SHA-256 of
//     the volume decoded out of it, and rejects the manifest if either
//     disagrees;
//   - the mask stops being blue. The spectra are RE-MEASURED here from the
//     shipped pixels rather than read out of the manifest, and checked against
//     the bars in `Tools/stbn-bake/stbn-spectrum.mjs`. A regenerated asset
//     that quietly lost its temporal structure fails here even though its
//     hash, dimensions and histogram are all still perfectly plausible;
//   - the manifest's recorded numbers stop matching what the asset actually
//     measures, which is how a hand-edited manifest gets caught;
//   - the CERTIFICATION ITSELF stops discriminating. Three mutants derived by
//     exact transformations of the shipped volume must each fail the specific
//     criterion they are built to violate. Without this block, a bug that made
//     `certify()` return `pass: true` unconditionally would leave every test
//     above green;
//   - the per-slice value histogram stops being uniform, which would make it a
//     biased dither mask no matter how good its spectrum looked;
//   - the provenance record loses its "no third-party entry required" claim or
//     its citations, or `LICENSE.md` grows a third-party entry for this asset
//     (there must not be one — the asset is generated in-repo).
//
// Run: node --test Tools/visual-regression/stbn-asset.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { unpackAtlas } from "../stbn-bake/stbn-core.mjs";
import { decodeGray8 } from "../stbn-bake/stbn-png.mjs";
import {
  BARS,
  certify,
  mutantSpatialOnlyBlue,
  mutantTemporalOnlyBlue,
  mutantWhite,
  spatialSpectrum,
  temporalSpectrum,
} from "../stbn-bake/stbn-spectrum.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const MANIFEST_REL = "Tools/stbn-bake/stbn-manifest.json";

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, MANIFEST_REL), "utf8"),
);

const assetRel = manifest.asset.installed;
const assetPath = path.join(root, assetRel);
const assetBytes = fs.readFileSync(assetPath);

const { width, height, frames } = manifest.volume;

/** Decoded once — every test below reads these. */
const decoded = decodeGray8(assetBytes);
const volume = unpackAtlas(
  decoded.pixels,
  decoded.width,
  width,
  height,
  frames,
  manifest.asset.atlasCols,
);

/**
 * @param {Buffer|Uint8Array} buf bytes
 * @returns {string} lowercase hex SHA-256
 */
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// The asset itself
// ─────────────────────────────────────────────────────────────────────────────

test("the STBN atlas is bundled where the manifest says it is", () => {
  assert.ok(
    assetRel.startsWith("packages/engine/Source/Assets/Textures/"),
    `asset must ship inside the engine package, got ${assetRel}`,
  );
  assert.ok(assetBytes.length > 0, "asset is empty");
});

test("the shipped bytes match the manifest hash", () => {
  assert.equal(
    sha256(assetBytes),
    manifest.asset.sha256,
    "shipped PNG SHA-256 differs from the manifest — re-run " +
      "`node Tools/stbn-bake/bake-stbn.mjs --install` rather than editing the manifest",
  );
  assert.equal(assetBytes.length, manifest.asset.bytes);
});

test("the atlas is 8-bit greyscale PNG at the declared tile layout", () => {
  // decodeGray8 throws on any other bit depth, colour type or interlace, so
  // reaching this point already proves the format. What is left is the shape.
  assert.equal(decoded.width, manifest.asset.atlasWidth);
  assert.equal(decoded.height, manifest.asset.atlasHeight);
  assert.equal(decoded.width, manifest.asset.atlasCols * width);
  assert.equal(decoded.height, manifest.asset.atlasRows * height);
  assert.ok(
    manifest.asset.atlasCols * manifest.asset.atlasRows >= frames,
    "atlas has fewer tiles than the volume has frames",
  );
});

test("the decoded volume matches the manifest raw hash", () => {
  assert.equal(volume.length, width * height * frames);
  assert.equal(volume.length, manifest.volume.rawBytes);
  assert.equal(
    sha256(volume),
    manifest.volume.rawSha256,
    "the volume decoded out of the atlas differs from the one the bake certified",
  );
});

test("every slice has an exactly uniform 8-bit histogram", () => {
  // A dither mask with a lopsided histogram biases the quantity it dithers no
  // matter how blue its spectrum is. The bake's quantisation makes this exact
  // — `sliceSize / 256` occurrences of every byte value — so an approximate
  // assertion here would be weaker than the property actually held.
  const sliceSize = width * height;
  const expected = sliceSize / 256;
  assert.ok(
    Number.isInteger(expected),
    "slice size is not a multiple of 256; the histogram cannot be uniform",
  );
  for (let t = 0; t < frames; t++) {
    const counts = new Int32Array(256);
    for (let i = 0; i < sliceSize; i++) {
      counts[volume[t * sliceSize + i]]++;
    }
    for (let v = 0; v < 256; v++) {
      assert.equal(
        counts[v],
        expected,
        `slice ${t}: byte value ${v} occurs ${counts[v]} times, expected ${expected}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The spectra — re-measured, not read out of the manifest
// ─────────────────────────────────────────────────────────────────────────────

test("the shipped mask certifies as spatiotemporal blue noise", () => {
  const verdict = certify(volume, width, height, frames);
  assert.deepEqual(
    verdict.failures,
    [],
    `certification failed: ${verdict.failures.join("; ")}`,
  );
  assert.ok(verdict.pass);
});

test("the manifest's recorded spectra match what the asset measures", () => {
  const spatial = spatialSpectrum(volume, width, height, frames);
  const temporal = temporalSpectrum(volume, width, height, frames);
  // The manifest rounds to six decimals; anything beyond that is float noise.
  const tol = 1e-5;
  assert.ok(
    Math.abs(spatial.low - manifest.certification.spatial.low) < tol,
    `spatial low ${spatial.low} vs manifest ${manifest.certification.spatial.low}`,
  );
  assert.ok(
    Math.abs(spatial.high - manifest.certification.spatial.high) < tol,
    `spatial high ${spatial.high} vs manifest ${manifest.certification.spatial.high}`,
  );
  assert.ok(
    Math.abs(temporal.low - manifest.certification.temporal.low) < tol,
    `temporal low ${temporal.low} vs manifest ${manifest.certification.temporal.low}`,
  );
  assert.ok(
    Math.abs(temporal.high - manifest.certification.temporal.high) < tol,
    `temporal high ${temporal.high} vs manifest ${manifest.certification.temporal.high}`,
  );
});

test("the radial spatial spectrum rises monotonically across the bands", () => {
  // The two band bars can both be met by a spectrum with a dip in the middle;
  // the published characterisation is about the SHAPE, so it is checked
  // separately from the levels.
  const s = spatialSpectrum(volume, width, height, frames);
  assert.ok(s.low < s.mid, `low ${s.low} should be below mid ${s.mid}`);
  assert.ok(s.mid < s.high, `mid ${s.mid} should be below high ${s.high}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL — the mutants
// ─────────────────────────────────────────────────────────────────────────────
// Each mutant is an EXACT transformation of the shipped volume whose spectral
// consequence follows from the transformation itself, so a failure here is
// unambiguous: it means the criterion stopped discriminating, not that some
// second generator happened to be bad.

test("MUTANT white noise fails BOTH criteria", () => {
  const mutant = mutantWhite(volume, width, height, frames);
  const verdict = certify(mutant, width, height, frames);
  assert.ok(!verdict.pass, "white noise passed the certification");

  const s = spatialSpectrum(mutant, width, height, frames);
  const t = temporalSpectrum(mutant, width, height, frames);
  assert.ok(
    s.low > BARS.spatialLowMax,
    `white noise spatial low ${s.low} should exceed the bar ${BARS.spatialLowMax}`,
  );
  assert.ok(
    t.low > BARS.temporalLowMax,
    `white noise temporal low ${t.low} should exceed the bar ${BARS.temporalLowMax}`,
  );
  // Both bands should sit at the null, which is what makes the bars readable
  // as "distance from white".
  assert.ok(Math.abs(s.low - 1) < 0.1, `white spatial low ${s.low} != ~1.0`);
  assert.ok(Math.abs(t.low - 1) < 0.1, `white temporal low ${t.low} != ~1.0`);
});

test("MUTANT spatial-only blue passes SPATIAL and fails TEMPORAL", () => {
  // Every slice is a toroidal shift of slice 0, so the spatial power spectrum
  // is preserved exactly while each pixel's time line becomes 64 readings of
  // the mask at unrelated positions. This is the mutant the whole temporal
  // half of the gate exists to reject — a stack of independent blue-noise
  // slices is the thing that is easy to build by accident.
  const mutant = mutantSpatialOnlyBlue(volume, width, height, frames);
  const s = spatialSpectrum(mutant, width, height, frames);
  const t = temporalSpectrum(mutant, width, height, frames);

  assert.ok(
    s.low <= BARS.spatialLowMax,
    `spatial-only mutant should still pass the spatial bar (${s.low})`,
  );
  assert.ok(
    s.high >= BARS.spatialHighMin,
    `spatial-only mutant should still pass the spatial high bar (${s.high})`,
  );
  assert.ok(
    t.low > BARS.temporalLowMax,
    `spatial-only mutant temporal low ${t.low} should exceed the bar ` +
      `${BARS.temporalLowMax} — the temporal criterion is not discriminating`,
  );
  assert.ok(
    t.high < BARS.temporalHighMin,
    `spatial-only mutant temporal high ${t.high} should fall below the bar ` +
      `${BARS.temporalHighMin}`,
  );

  const verdict = certify(mutant, width, height, frames);
  assert.ok(!verdict.pass, "a spatially-blue, temporally-white volume passed");
});

test("MUTANT temporal-only blue passes TEMPORAL and fails SPATIAL", () => {
  // One global pixel permutation applied to every slice: each pixel's time
  // line moves intact to a new position, so the temporal spectrum is
  // unchanged, while the spatial arrangement is scrambled. Proves the spatial
  // half of the gate fires, which neither mutant above can show.
  const mutant = mutantTemporalOnlyBlue(volume, width, height, frames);
  const s = spatialSpectrum(mutant, width, height, frames);
  const t = temporalSpectrum(mutant, width, height, frames);

  assert.ok(
    t.low <= BARS.temporalLowMax,
    `temporal-only mutant should still pass the temporal bar (${t.low})`,
  );
  assert.ok(
    s.low > BARS.spatialLowMax,
    `temporal-only mutant spatial low ${s.low} should exceed the bar ` +
      `${BARS.spatialLowMax} — the spatial criterion is not discriminating`,
  );

  const verdict = certify(mutant, width, height, frames);
  assert.ok(!verdict.pass, "a spatially-white, temporally-blue volume passed");
});

test("MUTANT spatial-only blue is temporally IDENTICAL to white noise", () => {
  // The sharpest statement of the point: a stack of independent blue-noise
  // slices and pure white noise are indistinguishable along the time axis. If
  // these two ever diverge, the temporal measurement has started reading
  // something other than the time line.
  const spatialOnly = mutantSpatialOnlyBlue(volume, width, height, frames);
  const white = mutantWhite(volume, width, height, frames);
  const a = temporalSpectrum(spatialOnly, width, height, frames);
  const b = temporalSpectrum(white, width, height, frames);
  assert.ok(
    Math.abs(a.low - b.low) < 0.05,
    `temporal low: spatial-only ${a.low} vs white ${b.low}`,
  );
  assert.ok(
    Math.abs(a.high - b.high) < 0.05,
    `temporal high: spatial-only ${a.high} vs white ${b.high}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

test("the manifest records in-repo provenance and needs no third-party entry", () => {
  const p = manifest.provenance;
  assert.equal(p.thirdPartyLicenseEntryRequired, false);
  assert.match(p.origin, /generated in-repo/i);
  assert.match(p.ruling, /R-2026-08-10-5/);
  assert.match(p.excluded, /NVIDIA/i);
  assert.ok(
    Array.isArray(p.algorithms) && p.algorithms.length >= 3,
    "the three source algorithms must stay cited",
  );
  const dois = p.algorithms.map((a) => a.doi);
  assert.ok(dois.includes("10.1117/12.152707"), "Ulichney 1993 citation lost");
  assert.ok(
    dois.includes("10.1145/2897839.2927430"),
    "Georgiev-Fajardo 2016 citation lost",
  );
  assert.ok(dois.includes("10.2312/sr.20221161"), "Wolfe 2022 citation lost");
});

test("both LICENSE.md copies record the asset as generated, not licensed", () => {
  // The ABSENCE of a third-party grant is the point of this row, and an
  // absence is invisible to an auditor — so the section instead carries an
  // explicit "grants nothing, reserves nothing" note. Pinning it here means a
  // future change that quietly swapped in a downloaded mask would have to
  // delete a test to get away with it. Both copies are checked because
  // LICENSE.md's own mirror rule requires the engine package's copy to move in
  // the same change, and nothing else in the repository enforces that for this
  // entry.
  const assetName = path.basename(assetRel);
  for (const rel of ["LICENSE.md", "packages/engine/LICENSE.md"]) {
    const license = fs.readFileSync(path.join(root, rel), "utf8");
    assert.ok(
      license.includes(assetName),
      `${rel} does not mention the bundled STBN atlas ${assetName}`,
    );
    assert.ok(
      license.includes(manifest.asset.sha256),
      `${rel} does not carry the shipped atlas SHA-256`,
    );
    assert.match(
      license,
      /generated in this repository \(no third-party terms\)/,
      `${rel} lost the "no third-party terms" heading for the STBN asset`,
    );
    assert.match(
      license,
      /Explicitly not used: NVIDIA's STBN SDK/,
      `${rel} lost the record of which source was rejected and why`,
    );
  }
});

test("the engine seam module pins the same asset as the manifest", () => {
  // Three independent statements of the same fact — the bytes on disk, the
  // manifest, and the engine constant — are cross-checked here. Any one of
  // them being updated alone is the realistic failure: dropping in a
  // regenerated PNG without re-running the bake, or re-running the bake
  // without touching the module.
  const seamRel = "packages/engine/Source/Scene/StbnNoiseVolume.js";
  const seam = fs.readFileSync(path.join(root, seamRel), "utf8");

  assert.ok(
    seam.includes(manifest.asset.sha256),
    `${seamRel} does not pin the shipped atlas SHA-256 ${manifest.asset.sha256}`,
  );

  const assetSuffix = assetRel.replace("packages/engine/Source/", "");
  assert.ok(
    seam.includes(assetSuffix),
    `${seamRel} does not resolve ${assetSuffix}`,
  );

  for (const [name, value] of [
    ["WIDTH", width],
    ["HEIGHT", height],
    ["FRAMES", frames],
    ["ATLAS_COLUMNS", manifest.asset.atlasCols],
    ["ATLAS_ROWS", manifest.asset.atlasRows],
  ]) {
    assert.match(
      seam,
      new RegExp(`StbnNoiseVolume\\.${name}\\s*=\\s*${value};`),
      `${seamRel}: ${name} must be ${value} to match the shipped volume`,
    );
  }
});

test("the bake tool declares its provenance discipline in-source", () => {
  // The rule that keeps this asset clean lives in a comment, and comments rot.
  // Pin the two claims that matter so a rewrite has to consciously drop them.
  const core = fs.readFileSync(
    path.join(root, "Tools/stbn-bake/stbn-core.mjs"),
    "utf8",
  );
  assert.match(core, /PROVENANCE DISCIPLINE/);
  assert.match(core, /NVIDIA/);
  assert.match(core, /10\.1117\/12\.152707/);
  assert.match(core, /10\.1145\/2897839\.2927430/);
  assert.match(core, /10\.2312\/sr\.20221161/);
});
