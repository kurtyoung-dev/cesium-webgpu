// skybox-diffuse-seam.spec.mjs — C12-11 / DR-01: pins the star-map seam.
// @purpose Standing DR-01 proof: diffuse skybox faces stay low-passed (no resolved points), band structure + TYCHO_T5 reversal intact, hashes re-derived.
// @status ACTIVE
//
// DR-01 (QUEUE_2026-07-19_CAMPAIGN12.md §6c, decided 2026-07-19) assigns one
// physical owner to each celestial signal: the cube map carries DIFFUSE Milky
// Way light only, and every RESOLVED star comes from the sprite catalogue. This
// spec is the standing proof that the SHIPPED bytes and the SHIPPED default
// still honour that split.
//
// It fails if:
//   - the bundled diffuse faces go missing, change geometry, stop being square,
//     or lose their 4:4:4 chroma;
//   - a diffuse face regains resolved point sources — i.e. the low-pass was
//     skipped, weakened, or run on the wrong input. This is the failure that
//     actually shipped: the C12-10 helper chained `.blur()` onto a
//     `composite()` pipeline, and sharp applies `composite` LAST, so the blur
//     hit an empty base and the un-blurred strips were pasted over it. The
//     output was a bit-for-bit no-op whose file size and mean both looked fine;
//   - a diffuse face loses its degree-scale band structure — the opposite
//     failure, where the map is blacked out or flattened instead of low-passed;
//   - the un-blurred `TYCHO_T5` reversal artifact stops being bundled, or stops
//     being visibly different from the diffuse set (DR-01 promises reversal
//     without a re-bake, which is empty if the two variants are the same map);
//   - `SkyBox.defaultVariant` drifts off the diffuse variant, or a variant is
//     registered without a descriptor (a typo there 404s the sky silently);
//   - the manifest's recorded evidence drifts away from the bytes it describes
//     (every SHA-256 is re-derived here);
//   - the LICENSE.md "Bundled Engine Assets" entry stops covering the new faces.
//
// WHY THE METRICS ARE SHAPED THIS WAY. A whole-face MEAN cannot see this bug in
// either direction: blurring conserves it, so it is invariant under the very
// operation being verified — and the Batch-815 census hit the same trap from
// the other side, where a faint additive sprite field over a large band moved a
// band mean by less than its own noise. So the two signals get two orthogonal
// metrics from `Tools/skybox-bake/starmap-census.mjs`: a POINT metric (strict
// local maxima that rise above a LOCAL ring background) for resolved stars, and
// a SCALE metric (spread of coarse block means) for the diffuse band. The
// SYNTHETIC group below runs both against images with known ground truth, and
// the MUTATION group breaks the detector to prove those tests have teeth.
//
// Pure Node: no browser, no image decode, no network. The heavyweight pixel
// pass runs in the bake (which already has `sharp`) and lands in
// `Tools/skybox-bake/skybox-manifest.json`; this spec re-derives the hashes so
// that evidence cannot silently drift, and independently re-validates the
// detector that produced it.
//
// Run: node --test Tools/visual-regression/skybox-diffuse-seam.spec.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bandStructure,
  CENSUS_DEFAULTS,
  checkDr01,
  DR01_LIMITS,
  pointSourceCensus,
  toLuminance,
} from "../skybox-bake/starmap-census.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ASSET_DIR = "packages/engine/Source/Assets/Textures/SkyBox";
const MANIFEST_REL = "Tools/skybox-bake/skybox-manifest.json";
const CENSUS_REL = "Tools/skybox-bake/starmap-census.mjs";
const SKYBOX_REL = "packages/engine/Source/Scene/SkyBox.js";
const BAKE_REL = "Tools/skybox-bake/bake-tycho-t5.mjs";

const FACES = ["px", "mx", "py", "my", "pz", "mz"];
const DIFFUSE_PREFIX = "tycho2t5_80_diffuse";
const UNBLURRED_PREFIX = "tycho2t5_80";
const T3_PREFIX = "tycho2t3_80";

const abs = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(abs(rel));
// Normalize CRLF to LF. The repo checks out with core.autocrlf=true, so every
// source file on a Windows clone has Windows line endings while the MUTATION
// targets below are written with bare newlines - a multi-line target simply
// stops matching, and the mutation would prove nothing. The guard in those
// tests catches that and FAILS rather than passing vacuously, which is how
// this surfaced; normalizing here is the fix. Same class as the
// texture-mip-queue-safety false-green (REPO-TOOLING-SOURCE-ANCHOR-FRAGILITY).
const readText = (rel) =>
  fs.readFileSync(abs(rel), "utf8").split("\r\n").join("\n");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const faceRel = (prefix, f) => `${ASSET_DIR}/${prefix}_${f}.jpg`;

const manifest = JSON.parse(readText(MANIFEST_REL));

// ---------------------------------------------------------------------------
// Dependency-free JPEG frame reader — walks the marker chain to SOF for
// dimensions and per-component sampling factors, without decoding an MCU.
// (Same approach as moon-albedo-asset.spec.mjs.)
// ---------------------------------------------------------------------------
function readJpegFrame(buf) {
  assert.equal(buf[0], 0xff, "not a JPEG (missing SOI)");
  assert.equal(buf[1], 0xd8, "not a JPEG (missing SOI)");
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    const length = buf.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const p = i + 4;
      const height = buf.readUInt16BE(p + 1);
      const width = buf.readUInt16BE(p + 3);
      const numComponents = buf[p + 5];
      const components = [];
      for (let c = 0; c < numComponents; c++) {
        const q = p + 6 + c * 3;
        components.push({
          id: buf[q],
          h: buf[q + 1] >> 4,
          v: buf[q + 1] & 0x0f,
        });
      }
      return { width, height, numComponents, components };
    }
    i += 2 + length;
  }
  throw new Error("no SOF marker found in JPEG");
}

// ─── group 1: the shipped asset set ─────────────────────────────────────────

test("all six diffuse faces are bundled, square, and 4:4:4", () => {
  for (const f of FACES) {
    const rel = faceRel(DIFFUSE_PREFIX, f);
    assert.ok(fs.existsSync(abs(rel)), `${rel} is missing`);
    const frame = readJpegFrame(read(rel));
    assert.equal(frame.width, frame.height, `${rel} is not square`);
    assert.equal(
      frame.width,
      manifest.encode.faceSize,
      `${rel} is ${frame.width}px, manifest says ${manifest.encode.faceSize}`,
    );
    assert.equal(frame.numComponents, 3, `${rel} is not 3-component`);
    for (const c of frame.components) {
      assert.equal(
        `${c.h}${c.v}`,
        "11",
        `${rel} is chroma-subsampled; the C12 G3 gate requires 4:4:4`,
      );
    }
  }
});

test("the un-blurred reversal artifact and the historical t3 set stay bundled", () => {
  // DR-01's reversal plan is only real if the un-blurred faces are still here.
  for (const f of FACES) {
    assert.ok(
      fs.existsSync(abs(faceRel(UNBLURRED_PREFIX, f))),
      `${faceRel(UNBLURRED_PREFIX, f)} is missing — DR-01 requires the un-blurred ` +
        `reversal artifact stay bundled so the seam can be reversed without a re-bake`,
    );
    assert.ok(
      fs.existsSync(abs(faceRel(T3_PREFIX, f))),
      `${faceRel(T3_PREFIX, f)} is missing — the maintainer's C12-10 amendment ` +
        `requires t3 remain available offline`,
    );
  }
});

test("manifest hashes match the shipped bytes (evidence cannot drift)", () => {
  for (const f of FACES) {
    const installed = manifest.diffuse.installed[f];
    assert.ok(installed, `manifest records no installed diffuse face for ${f}`);
    const bytes = read(faceRel(DIFFUSE_PREFIX, f));
    assert.equal(
      sha256(bytes),
      installed.sha256,
      `${faceRel(DIFFUSE_PREFIX, f)} does not match its manifest SHA-256 — the ` +
        `recorded census below describes different bytes than the ones shipped`,
    );
    assert.equal(bytes.length, installed.bytes, `${f} byte count drifted`);

    // The installed face must be the very file the census measured.
    assert.equal(
      installed.sha256,
      manifest.diffuse.faces[f].sha256,
      `installed ${f} is not the baked artifact that was measured`,
    );
  }
});

test("the diffuse and un-blurred sets are genuinely different assets", () => {
  for (const f of FACES) {
    assert.notEqual(
      sha256(read(faceRel(DIFFUSE_PREFIX, f))),
      sha256(read(faceRel(UNBLURRED_PREFIX, f))),
      `${f}: the diffuse and un-blurred faces are byte-identical — the low-pass ` +
        `did not run, so the seam is not implemented`,
    );
  }
});

// ─── group 2: the DR-01 contract over the recorded census ───────────────────

test("every diffuse face has ZERO resolved point sources", () => {
  for (const f of FACES) {
    const m = manifest.diffuse.faces[f];
    assert.equal(
      m.points,
      0,
      `diffuse face ${f} retains ${m.points} resolved point source(s) ` +
        `(strongest local contrast ${m.strongestContrast}); DR-01 gives every ` +
        `resolved star to the sprite catalogue`,
    );
  }
});

test("every diffuse face KEEPS its degree-scale Milky Way band", () => {
  // The complement of the test above: proving stars are gone is worthless if
  // the map was simply blacked out. Measured against the SAME face's un-blurred
  // twin, because band strength depends on where the face points (px/mx look
  // away from the galactic centre and carry ~2.5x less structure than mz), not
  // on the bake.
  for (const f of FACES) {
    const d = manifest.diffuse.faces[f];
    const u = manifest.unblurredReversalArtifact.faces[f];
    assert.ok(
      d.bandStdDev >= DR01_LIMITS.diffuseMinBandStdDev,
      `diffuse face ${f} band structure ${d.bandStdDev} is below the absolute floor`,
    );
    const ratio = d.bandStdDev / u.bandStdDev;
    assert.ok(
      ratio >= DR01_LIMITS.diffuseMinBandRatio,
      `diffuse face ${f} kept only ${(ratio * 100).toFixed(1)}% of its un-blurred ` +
        `band structure — the Milky Way was destroyed, not low-passed`,
    );
  }
});

test("the diffuse faces are dramatically darker at the PEAK but not at the band", () => {
  // The signature of a genuine low-pass, and the single number that most
  // directly falsifies the defect that shipped: an un-blurred face peaks at
  // ~255 because a star saturates a texel; a correctly low-passed one cannot
  // peak anywhere near that, while its BAND survives (asserted above).
  for (const f of FACES) {
    const d = manifest.diffuse.faces[f];
    const u = manifest.unblurredReversalArtifact.faces[f];
    assert.ok(
      d.peakLuminance < u.peakLuminance * 0.5,
      `diffuse face ${f} still peaks at ${d.peakLuminance} against the un-blurred ` +
        `${u.peakLuminance} — point sources survived the low-pass`,
    );
  }
});

test("the reversal artifact is still unmistakably a resolved-star map", () => {
  for (const f of FACES) {
    const m = manifest.unblurredReversalArtifact.faces[f];
    assert.ok(
      m.points >= DR01_LIMITS.unblurredMinPointSources,
      `un-blurred face ${f} has only ${m.points} point sources`,
    );
  }
});

test("the low-pass is wide enough to annihilate a point source", () => {
  // Tycho stars render under 0.1 deg. The kernel must be comfortably wider,
  // otherwise "zero point sources" would be a threshold artifact rather than
  // a physical consequence.
  assert.ok(
    manifest.diffuse.fwhmDegrees >= 0.5,
    `diffuse FWHM ${manifest.diffuse.fwhmDegrees} deg is too narrow to erase ` +
      `sub-0.1 deg point sources`,
  );
  assert.ok(
    manifest.diffuse.fwhmDegrees <= 3.0,
    `diffuse FWHM ${manifest.diffuse.fwhmDegrees} deg would smear the band itself`,
  );
});

test("checkDr01 accepts the shipped set and rejects each failure mode", () => {
  for (const f of FACES) {
    const d = manifest.diffuse.faces[f];
    const u = manifest.unblurredReversalArtifact.faces[f];
    assert.equal(
      checkDr01(
        { points: d.points, bandStdDev: d.bandStdDev },
        { points: u.points, bandStdDev: u.bandStdDev },
      ).pass,
      true,
      `${f} fails the DR-01 contract`,
    );
  }

  // Adversarial: each failure mode must be caught, so the acceptance above is
  // not vacuous.
  const good = { points: 5000, bandStdDev: 1.0 };
  assert.equal(
    checkDr01({ points: 1, bandStdDev: 0.9 }, good).pass,
    false,
    "a diffuse face retaining a star must be rejected",
  );
  assert.equal(
    checkDr01({ points: 0, bandStdDev: 0.01 }, good).pass,
    false,
    "a blacked-out diffuse face must be rejected",
  );
  assert.equal(
    checkDr01({ points: 0, bandStdDev: 0.4 }, good).pass,
    false,
    "a diffuse face that lost most of its band must be rejected (ratio 0.40 < 0.60)",
  );
  assert.equal(
    checkDr01({ points: 0, bandStdDev: 0.9 }, { points: 3, bandStdDev: 1.0 })
      .pass,
    false,
    "a reversal artifact with no stars must be rejected",
  );
  assert.equal(
    checkDr01({ points: 0, bandStdDev: 0 }, { points: 5000, bandStdDev: 0 })
      .pass,
    false,
    "two blacked-out sets must not satisfy the ratio vacuously (0/0)",
  );
});

// ─── group 3: SYNTHETIC — the detector actually measures what it claims ──────

const SYN = 256;

/**
 * Smooth diffuse band across a face — a broad diagonal lobe modulated along its
 * length, so the field varies in BOTH axes and genuinely contains smooth local
 * maxima. A band that is constant along each row would be rejected by the
 * isolation test alone (equal neighbours are never a strict maximum), which
 * would let the orthogonality test pass for the wrong reason and leave the
 * local-background subtraction untested.
 */
function synthBand(w, h, amplitude = 60) {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const along = x / w;
      // Band centre drifts across the face, so it is not row-aligned.
      const centre = h * (0.5 + 0.18 * Math.sin(along * Math.PI * 2));
      const d = (y - centre) / (h * 0.22);
      const lobe = Math.exp(-d * d);
      // Slow brightness modulation along the band -> real, gentle maxima.
      const along2 = 0.65 + 0.35 * Math.sin(along * Math.PI * 6);
      // A couple of LSBs of deterministic dither, standing in for the decode
      // noise every real JPEG face carries. Without it the quantized field is
      // all flat integer plateaus and contains no strict local maxima at all,
      // so the isolation test alone would suppress everything and the
      // local-background subtraction would never be exercised. With it, the
      // band contains MANY tiny maxima — exactly the false positives that
      // condition 3 exists to reject.
      const dither = ((x * 7 + y * 13) % 5) - 2;
      const v = Math.round(amplitude * lobe * along2) + dither;
      const i = (y * w + x) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = Math.max(0, Math.min(255, v));
    }
  }
  return rgb;
}

/**
 * Add bright point sources with a small PSF core, the way the star map actually
 * renders them (a saturated centre with a couple of bright neighbours) rather
 * than as lone texels. The footprint is what makes the isolation test
 * load-bearing: without it, only the exact centre pixel could ever qualify and
 * removing the strict-local-maximum condition would change nothing.
 */
function addStars(rgb, w, h, n, value = 250) {
  const core = [
    [0, 0, 1.0],
    [-1, 0, 0.55],
    [1, 0, 0.55],
    [0, -1, 0.55],
    [0, 1, 0.55],
    [-1, -1, 0.3],
    [1, -1, 0.3],
    [-1, 1, 0.3],
    [1, 1, 0.3],
  ];
  for (let s = 0; s < n; s++) {
    // Spread deterministically, keeping clear of the border the census skips.
    const x = 12 + ((s * 37) % (w - 24));
    const y = 12 + ((s * 71) % (h - 24));
    for (const [dx, dy, k] of core) {
      const i = ((y + dy) * w + (x + dx)) * 3;
      const v = Math.max(rgb[i], Math.round(value * k));
      rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
    }
  }
  return rgb;
}

/** Separable box blur, repeated — a cheap dependency-free approximation of a
 *  Gaussian, used only to build synthetic ground truth. */
function boxBlur(rgb, w, h, radius, passes = 3) {
  const src = Float32Array.from(rgb);
  let dst = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          let m = 0;
          for (let d = -radius; d <= radius; d++) {
            const xx = Math.min(w - 1, Math.max(0, x + d));
            sum += src[(y * w + xx) * 3 + c];
            m++;
          }
          dst[(y * w + x) * 3 + c] = sum / m;
        }
      }
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          let sum = 0;
          let m = 0;
          for (let d = -radius; d <= radius; d++) {
            const yy = Math.min(h - 1, Math.max(0, y + d));
            sum += dst[(yy * w + x) * 3 + c];
            m++;
          }
          src[(y * w + x) * 3 + c] = sum / m;
        }
      }
    }
    dst = new Float32Array(src.length);
  }
  return Uint8Array.from(src, (v) => Math.round(v));
}

const censusOf = (rgb) =>
  pointSourceCensus(toLuminance(rgb, SYN, SYN), SYN, SYN);
const bandOf = (rgb) => bandStructure(toLuminance(rgb, SYN, SYN), SYN, SYN, 32);

test("SYNTHETIC — the point census FINDS stars on a bright diffuse band", () => {
  const withStars = addStars(synthBand(SYN, SYN), SYN, SYN, 120);
  const { count } = censusOf(withStars);
  assert.ok(
    count >= 100,
    `expected ~120 synthetic stars, detected ${count} — the detector under-reports, ` +
      `so "zero on the diffuse faces" would be meaningless`,
  );
});

test("SYNTHETIC — a bright band with NO stars yields a zero census", () => {
  // This is the orthogonality claim: brightness alone must never register.
  const { count } = censusOf(synthBand(SYN, SYN, 200));
  assert.equal(
    count,
    0,
    `a smooth band produced ${count} phantom point sources — the metric is ` +
      `responding to diffuse brightness instead of to resolved sources`,
  );
});

test("SYNTHETIC — low-passing a starred band collapses the census but keeps the band", () => {
  const withStars = addStars(synthBand(SYN, SYN), SYN, SYN, 120);
  const before = censusOf(withStars);
  const beforeBand = bandOf(withStars);

  const blurred = boxBlur(withStars, SYN, SYN, 8);
  const after = censusOf(blurred);
  const afterBand = bandOf(blurred);

  assert.ok(before.count >= 100, `setup: only ${before.count} stars detected`);
  assert.equal(
    after.count,
    0,
    `${after.count} point source(s) survived the low-pass in the synthetic control`,
  );
  // ...and the band is still there, which is what separates a low-pass from a wipe.
  assert.ok(
    afterBand.stdDev > beforeBand.stdDev * 0.5,
    `band structure collapsed ${beforeBand.stdDev.toFixed(3)} -> ${afterBand.stdDev.toFixed(3)}`,
  );
});

test("SYNTHETIC — a blacked-out face collapses the BAND metric", () => {
  const black = new Uint8Array(SYN * SYN * 3);
  assert.ok(
    bandOf(black).stdDev < DR01_LIMITS.diffuseMinBandStdDev,
    "an all-black face must fail the band-structure floor",
  );
});

test("SYNTHETIC — a whole-face MEAN cannot tell the two apart (why it is not used)", () => {
  // Guards the rationale itself: if someone replaces these metrics with a mean,
  // this test documents exactly why that regresses to undetectable.
  const withStars = addStars(synthBand(SYN, SYN), SYN, SYN, 120);
  const blurred = boxBlur(withStars, SYN, SYN, 8);
  const meanBefore = bandOf(withStars).mean;
  const meanAfter = bandOf(blurred).mean;
  const relative = Math.abs(meanAfter - meanBefore) / meanBefore;
  assert.ok(
    relative < 0.05,
    `the mean moved ${(relative * 100).toFixed(1)}% under a low-pass; this test ` +
      `asserts it is nearly INVARIANT, which is why the point census exists`,
  );
});

// ─── group 4: MUTATION — prove group 3 has teeth ────────────────────────────

/**
 * Import a MUTATED copy of the census module from a temp dir, so nothing under
 * Tools/ is touched. Mirrors `importMutated` in pipeline-key-aliasing.spec.mjs.
 */
async function importMutatedCensus(mutate, label) {
  const file = abs(CENSUS_REL);
  // CRLF -> LF before mutating. The mutation targets below are multi-line
  // string literals written with bare newlines; on a Windows checkout
  // (core.autocrlf=true) they cannot match, the mutation silently becomes a
  // no-op, and every SYNTHETIC result it underwrites becomes unfalsifiable.
  // The notEqual guard right below is what catches that — it is why this
  // failed loudly instead of passing vacuously.
  const original = (await readFile(file, "utf8")).split("\r\n").join("\n");
  const mutated = mutate(original);
  assert.notEqual(
    mutated,
    original,
    `the ${label} mutation did not change ${CENSUS_REL} — its target text has ` +
      `moved, so this MUTATION test would pass vacuously and the SYNTHETIC ` +
      `results above would be unfalsifiable`,
  );
  const dir = await mkdtemp(path.join(tmpdir(), "cesium-starmap-census-"));
  const out = path.join(dir, "Mutant.mjs");
  await writeFile(out, mutated, "utf8");
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("MUTATION — dropping the local-background subtraction makes the band read as stars", async () => {
  // Condition 3 (`contrast >= minContrast`) is what makes the census orthogonal
  // to diffuse brightness. Remove it and a smooth bright band must start
  // producing phantom sources — which is precisely the "SYNTHETIC — a bright
  // band with NO stars yields a zero census" guarantee being broken.
  const mutant = await importMutatedCensus(
    (src) => src.replace("if (contrast >= minContrast) {", "if (true) {"),
    "local-background removal",
  );
  const band = synthBand(SYN, SYN, 200);
  const lum = mutant.toLuminance(band, SYN, SYN);
  const { count } = mutant.pointSourceCensus(lum, SYN, SYN);
  assert.ok(
    count > 0,
    "with the local-background test removed the smooth band MUST register " +
      "phantom sources; it did not, so that condition is not what makes the " +
      "orthogonality test pass and the real detector is untested",
  );
});

test("MUTATION — dropping the strict-local-maximum test inflates the census", async () => {
  const mutant = await importMutatedCensus(
    (src) =>
      src.replace(
        "if (!isMax) {\n        continue;\n      }",
        "if (false) {\n        continue;\n      }",
      ),
    "local-maximum removal",
  );
  const withStars = addStars(synthBand(SYN, SYN), SYN, SYN, 120);
  const lum = mutant.toLuminance(withStars, SYN, SYN);
  const mutated = mutant.pointSourceCensus(lum, SYN, SYN).count;
  const honest = censusOf(withStars).count;
  assert.ok(
    mutated > honest,
    `without the isolation test the census (${mutated}) must exceed the honest ` +
      `count (${honest}) — it does not, so isolation is not being enforced`,
  );
});

test("MUTATION — a census blind to bright pixels cannot certify the diffuse faces", async () => {
  // If minPeak were raised past the map's own peak, every face would trivially
  // report zero sources and the DR-01 test would pass vacuously.
  const mutant = await importMutatedCensus(
    (src) => src.replace("minPeak: 40,", "minPeak: 100000,"),
    "minPeak neutering",
  );
  const withStars = addStars(synthBand(SYN, SYN), SYN, SYN, 120);
  const lum = mutant.toLuminance(withStars, SYN, SYN);
  assert.equal(
    mutant.pointSourceCensus(lum, SYN, SYN).count,
    0,
    "the neutered detector should see nothing",
  );
  // ...and the real one must NOT be neutered.
  assert.ok(
    CENSUS_DEFAULTS.minPeak < 256,
    `the shipped minPeak (${CENSUS_DEFAULTS.minPeak}) must be reachable by an ` +
      `8-bit face, or every DR-01 assertion passes vacuously`,
  );
  assert.ok(
    manifest.unblurredReversalArtifact.faces.px.peakLuminance >
      CENSUS_DEFAULTS.minPeak,
    "the real map's peak must exceed minPeak, otherwise the detector is blind " +
      "to the very asset it certifies",
  );
});

// ─── group 5: the runtime seam ──────────────────────────────────────────────

test("SkyBox registers the diffuse variant and defaults to it", () => {
  const src = readText(SKYBOX_REL);
  assert.match(
    src,
    /TYCHO_T5_DIFFUSE:\s*"TYCHO_T5_DIFFUSE"/,
    "SkyBox.Variant is missing TYCHO_T5_DIFFUSE",
  );
  assert.match(
    src,
    /SkyBox\.defaultVariant\s*=\s*SkyBox\.Variant\.TYCHO_T5_DIFFUSE/,
    "SkyBox.defaultVariant must be the diffuse variant — DR-01 requires the " +
      "cubemap ship diffuse-only by DEFAULT, not merely offer it",
  );
  assert.match(
    src,
    new RegExp(`prefix:\\s*"${DIFFUSE_PREFIX}"`),
    "no descriptor maps the diffuse variant to its face prefix",
  );
});

test("every registered SkyBox.Variant has a descriptor and bundled faces", () => {
  // A variant without a descriptor 404s the sky at runtime; a descriptor whose
  // prefix has no bundled faces does the same. Both are silent until rendered.
  const src = readText(SKYBOX_REL);
  const variants = [
    ...src.matchAll(/^\s{2}(TYCHO_[A-Z0-9_]+):\s*"([A-Z0-9_]+)"/gm),
  ].map((m) => m[1]);
  assert.ok(
    variants.length >= 3,
    `expected >= 3 variants, found ${variants.length}`,
  );

  const prefixes = [...src.matchAll(/prefix:\s*"([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(
    prefixes.length,
    variants.length,
    `${variants.length} variants but ${prefixes.length} descriptors — ` +
      `a variant with no descriptor renders no sky`,
  );
  for (const prefix of prefixes) {
    for (const f of FACES) {
      assert.ok(
        fs.existsSync(abs(`${ASSET_DIR}/${prefix}_${f}.jpg`)),
        `variant prefix "${prefix}" has no bundled ${f} face`,
      );
    }
  }
});

test("the sprite catalogue is still ON by default (it now owns every resolved star)", () => {
  // With the cubemap low-passed, the catalogue is the ONLY source of resolved
  // stars. Defaulting it off would leave a starless sky.
  const src = readText(SKYBOX_REL);
  assert.match(
    src,
    /showStarCatalog\s*\?\?\s*true/,
    "SkyBox must default its StarField on — after C12-11 it is the sole " +
      "source of resolved stars on both backends",
  );
});

// ─── group 6: bake tooling + provenance ─────────────────────────────────────

test("the bake pins the same source the manifest records", () => {
  const src = readText(BAKE_REL);
  assert.ok(
    src.includes(manifest.source.sha256),
    "the bake script no longer pins the manifest's source SHA-256",
  );
  assert.match(
    src,
    /--install-diffuse|installDiffuse/,
    "no diffuse install path",
  );
});

test("the bake cannot silently return a mis-strided or un-blurred buffer", () => {
  // Both shipped defects were invisible in the output size. The sentinels and
  // the composite-free padding are what stop them recurring.
  const src = readText(BAKE_REL);
  assert.match(
    src,
    /blurEquirectWrapped produced \$\{out\.info\.channels\} channels/,
    "the channel sentinel is gone from blurEquirectWrapped",
  );
  assert.ok(
    !/\.composite\(/.test(src),
    "blurEquirectWrapped must not use sharp's composite(): it is applied AFTER " +
      "blur() regardless of chain order, which silently skips the low-pass",
  );
});

test("LICENSE.md covers the diffuse faces under Bundled Engine Assets", () => {
  const license = readText("LICENSE.md");
  const idx = license.indexOf("# Bundled Engine Assets");
  assert.ok(idx > 0, "LICENSE.md has no Bundled Engine Assets section");
  const section = license.slice(idx);
  assert.ok(
    section.includes(DIFFUSE_PREFIX),
    `the Bundled Engine Assets section does not name ${DIFFUSE_PREFIX} — every ` +
      `bundled binary must carry its terms`,
  );
  assert.ok(
    section.includes(manifest.source.sha256),
    "the section no longer records the pinned source hash",
  );
  assert.ok(
    /Credit: ESA/.test(section) && /NASA\/Goddard/.test(section),
    "the required NASA + ESA attributions are missing",
  );
});
