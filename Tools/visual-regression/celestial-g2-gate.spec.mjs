// celestial-g2-gate.spec.mjs — browser-free guard for the Campaign-12 G2 lane
// (`probe-celestial-gates.mjs --g2`).
//
// G2 is a gate, so a spec that only ran the correct implementation would be
// worth nothing — the wrong implementations of every rule below also "pass",
// they just pass vacuously. Every rule is stated once and then run twice: once
// against the real module and once against a battery of MUTANTS, each of which
// is the plausible wrong implementation somebody would actually write.
//
// The spec has three jobs:
//
//   1. PROVE THE DISPLAY-TRANSFORM INVERSION. Every G2 criterion is a ratio
//      taken across decades of a radial profile, which can only be read off a
//      LINEAR image. The bracket used to stitch `v/255/f`; the shipped chain is
//      `exposure -> PBR Neutral -> pow(x, 1/2.2)`. The inversion is round-tripped
//      against a forward model transcribed from the shipped shader sources, and
//      the shader sources themselves are re-read so the constants cannot drift.
//
//   2. PROVE THE PSF PREDICATE DISCRIMINATES. The adversarial case is the OLD
//      shader — the truncated Gaussian that produced the white blobs this whole
//      wave exists to remove — pushed through the identical simulated pipeline.
//      A bar that both profiles clear is not a gate. Measured through the
//      simulated instrument: NEW 7.20, OLD 1.79, bar 4.0.
//
//   3. PROVE THE COMPOSITION RULES. `{}.every(Boolean)` is vacuously true, a
//      structural leg is neither a pass nor a defect, and a pass on ONE backend
//      is a FAIL for a gate over shared code (campaign principle 5).
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { m4RadialFalloff } from "./lib/celestial-metrics.mjs";
import {
  BRACKET_SATURATION_CODE,
  CLIPPED_PIXELS_MAX,
  CLIP_LEVEL_LINEAR,
  DISPLAY_GAMMA,
  EXIT_CODE,
  GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS,
  GLARE_MIN_LIT_PIXELS,
  GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS,
  GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION,
  MAGNITUDE_MIN_MATCHED,
  MAGNITUDE_SPEARMAN_MIN,
  PBRN_DESATURATION,
  PBRN_START_COMPRESSION,
  PSF_MIN_SUBFLOOR_RECOVERED,
  PSF_RATIO_1E3_MIN,
  PSF_SLOPE_AGREEMENT_MAX,
  PSF_SLOPE_BAND,
  RENDERED_RANGE_MIN,
  buildG2Summary,
  displayToLinear,
  evaluateG2Backend,
  evaluateGlareSubLane,
  evaluateMagnitudeSubLane,
  evaluatePsfSubLane,
  foldG2Verdict,
  pbrNeutralTonemap,
  pbrNeutralTonemapInverse,
  stitchBracketLinear,
} from "./lib/celestial-g2-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const PROBE = readNormalized(
  "Tools/visual-regression/probe-celestial-gates.mjs",
);
// The page/settle/capture recipe is shared by the whole celestial fleet and
// lives in `lib/celestial-capture-harness.mjs`. Assertions that pin CAMERA
// PLACEMENT or per-lane state restoration read the HARNESS; assertions about
// what the G2 lanes ASK FOR still read the probe.
const HARNESS = readNormalized(
  "Tools/visual-regression/lib/celestial-capture-harness.mjs",
);

// ---------------------------------------------------------------------------
// FORWARD MODEL — transcribed from the shipped chain, used to round-trip the
// inversion and to synthesize the two PSF fixtures.
// ---------------------------------------------------------------------------

function encode8(rgbLinear, exposure) {
  const exposed = rgbLinear.map((v) => v * exposure);
  const t = pbrNeutralTonemap(exposed);
  return t.map((v) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(255 * Math.pow(Math.max(v, 0), 1 / DISPLAY_GAMMA)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// PSF FIXTURES — the shipped Moffat core+wing and the OLD truncated Gaussian it
// replaced, rendered onto a patch through the display chain at the probe's own
// TELESCOPE framing, then stitched back. Constants are read from the shipped
// sources below, so a shader edit that changes the profile changes this spec.
// ---------------------------------------------------------------------------

const REF = {
  SIGMA: 0.12,
  ALPHA: 0.15,
  BETA: 2.0,
  K_HALO: 0.08,
  WINDOW_INNER: 0.92,
  BASE_QUAD_DIAMETER_RAD: 0.006,
  GLARE_MAX_DIAMETER_RAD: 0.017453292519943295,
  FAINT_ANCHOR_MAG: 3.6,
  FAINT_ANCHOR_PEAK: 0.06,
  BRIGHTEST_VMAG: -1.46,
};
// The historical (pre-C12-05) shader — the blob.
const OLD = {
  GAUSS_K: 2.2,
  WINDOW_INNER: 0.45,
  HI: 2.0,
  BASE_HALF_RAD: 0.0042,
};

const VIEWPORT = { width: 1280, height: 720 };
const TELESCOPE_FOV_X_DEG = 6.0;

const EXPOSURE_CONSTANT =
  (REF.FAINT_ANCHOR_PEAK / (1.0 + REF.K_HALO)) *
  Math.pow(10.0, 0.4 * REF.FAINT_ANCHOR_MAG);
const intensity = (vmag) => EXPOSURE_CONSTANT * Math.pow(10.0, -0.4 * vmag);
const MAX_QUAD_SCALE = REF.GLARE_MAX_DIAMETER_RAD / REF.BASE_QUAD_DIAMETER_RAD;
const quadScale = (flux) =>
  flux > 1.0 ? Math.min(Math.sqrt(flux), MAX_QUAD_SCALE) : 1.0;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function pixelScale(fovXDeg) {
  const fovX = (fovXDeg * Math.PI) / 180;
  const fovY =
    2 * Math.atan(Math.tan(fovX / 2) * (VIEWPORT.height / VIEWPORT.width));
  const proj5 = 1 / Math.tan(fovY / 2);
  return {
    basePxHalf:
      (REF.BASE_QUAD_DIAMETER_RAD / 2) * proj5 * (VIEWPORT.height / 2),
    oldBasePxHalf: OLD.BASE_HALF_RAD * proj5 * (VIEWPORT.height / 2),
  };
}

const SCALE = pixelScale(TELESCOPE_FOV_X_DEG);
const I_MAX = intensity(REF.BRIGHTEST_VMAG);

function newProfilePx(rp) {
  const qs = quadScale(I_MAX);
  const quadHalf = SCALE.basePxHalf * qs;
  const r = rp / quadHalf;
  if (r >= 1) {
    return 0;
  }
  const core = Math.exp(
    -Math.pow(rp / SCALE.basePxHalf, 2) / (2 * REF.SIGMA * REF.SIGMA),
  );
  const q = r / REF.ALPHA;
  const halo = Math.pow(1 + q * q, -REF.BETA);
  return (
    I_MAX * (core + REF.K_HALO * halo) * smoothstep(1, REF.WINDOW_INNER, r)
  );
}

function oldProfilePx(rp) {
  const r = rp / SCALE.oldBasePxHalf;
  if (r >= 1) {
    return 0;
  }
  return (
    OLD.HI * Math.exp(-r * r * OLD.GAUSS_K) * smoothstep(1, OLD.WINDOW_INNER, r)
  );
}

const PATCH_N = 261; // odd, centred; > 2 x the modelled quad half-extent (88.8 px)
const PATCH_C = (PATCH_N - 1) / 2;
const PSF_MAX_RADIUS_PX = 120;

function renderPatch(profile, exposure) {
  const data = new Uint8ClampedArray(PATCH_N * PATCH_N * 4);
  for (let y = 0; y < PATCH_N; y++) {
    for (let x = 0; x < PATCH_N; x++) {
      const v = encode8(
        (() => {
          const L = profile(Math.hypot(x - PATCH_C, y - PATCH_C));
          return [L, L, L];
        })(),
        exposure,
      );
      const i = 4 * (y * PATCH_N + x);
      data[i] = v[0];
      data[i + 1] = v[1];
      data[i + 2] = v[2];
      data[i + 3] = 255;
    }
  }
  return { data, width: PATCH_N, height: PATCH_N, exposureFactor: exposure };
}

function bracketFor(profile) {
  return [1, 8, 64].map((f) => renderPatch(profile, f));
}

// The NAIVE stitch the C12-02 bracket used — kept here as the adversarial
// mutant, not as an alternative.
function stitchNaive(captures) {
  const { width, height } = captures[0];
  const n = width * height * 4;
  const out = new Float64Array(n);
  const ordered = captures
    .slice()
    .sort((a, b) => b.exposureFactor - a.exposureFactor);
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      let linear = 0;
      for (const cap of ordered) {
        const v = cap.data[i + c];
        if (v < BRACKET_SATURATION_CODE) {
          linear = v / 255 / cap.exposureFactor;
          break;
        }
      }
      if (linear === 0) {
        const lowest = ordered[ordered.length - 1];
        linear = lowest.data[i + c] / 255 / lowest.exposureFactor;
      }
      out[i + c] = linear;
    }
    out[i + 3] = 1;
  }
  return { data: out, width, height, saturatedPixels: 0 };
}

function measure(profile, stitch) {
  const composite = stitch(bracketFor(profile));
  return m4RadialFalloff(
    composite,
    { x: PATCH_C, y: PATCH_C },
    { alreadyLinear: true, maxRadius: PSF_MAX_RADIUS_PX },
  );
}

// ---------------------------------------------------------------------------
// Sub-lane fixtures
// ---------------------------------------------------------------------------

const healthyPsf = (over = {}) => ({
  hdrEngaged: true,
  sources: 1,
  subFloorPixelsRecovered: 5200,
  rCore: 4.906,
  r1e3: 35.34,
  ratio1e3: 7.203,
  slopeInner: -3.56,
  slopeOuter: -3.633,
  ...over,
});

const healthyMagnitude = (over = {}) => ({
  matched: 18,
  matchedUnclipped: 15,
  spearman: 0.98,
  renderedRange: 16.8,
  clippedPixels: 7,
  ...over,
});

const healthyGlare = (over = {}) => ({
  onStrength: 1.0,
  offStrength: 0,
  farLitPixels: 640000,
  farAaDifferingPixels: 0,
  farDifferingPixels: 0,
  nearEnergyDropFraction: 0.061,
  nearDifferingPixels: 240000,
  nearBrightenedPixels: 0,
  ...over,
});

const healthyBackend = (renderer, over = {}) => ({
  renderer,
  psf: healthyPsf(over.psf),
  magnitude: healthyMagnitude(over.magnitude),
  glare: healthyGlare(over.glare),
});

const REAL = {
  evaluatePsfSubLane,
  evaluateMagnitudeSubLane,
  evaluateGlareSubLane,
  evaluateG2Backend,
  foldG2Verdict,
  buildG2Summary,
  stitchBracketLinear,
};

const foldFor = (impl, { gl = {}, gpu = {} } = {}) =>
  impl.foldG2Verdict({
    webgl: impl.evaluateG2Backend(healthyBackend("webgl", gl)),
    webgpu: impl.evaluateG2Backend(healthyBackend("webgpu", gpu)),
  });

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

const RULES = {
  // ---- the display-transform inversion ------------------------------------
  "the inversion round-trips the shipped forward model": () => {
    for (const L of [
      1e-4, 1e-3, 0.01, 0.06, 0.1, 0.3, 0.5, 0.9, 1.5, 3, 6.34,
    ]) {
      const t = pbrNeutralTonemap([L, L, L]);
      const back = pbrNeutralTonemapInverse(t);
      assert.ok(
        Math.abs(back[0] - L) <= 1e-9 * Math.max(L, 1),
        `PBR Neutral inversion failed at L=${L}: got ${back[0]}`,
      );
    }
    // Coloured pixels exercise the desaturation mix, which the neutral case
    // cannot reach.
    for (const rgb of [
      [0.02, 0.05, 0.2],
      [1.4, 0.9, 0.3],
      [3.0, 2.0, 5.0],
    ]) {
      const back = pbrNeutralTonemapInverse(pbrNeutralTonemap(rgb));
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(back[c] - rgb[c]) <= 1e-8 * Math.max(rgb[c], 1),
          `coloured inversion failed at ${JSON.stringify(rgb)}: ${back}`,
        );
      }
    }
  },
  "displayToLinear undoes exposure, gamma and the tonemap together": () => {
    for (const exposure of [1, 8, 64]) {
      for (const L of [1e-3, 0.01, 0.06, 0.2]) {
        const v = encode8([L, L, L], exposure);
        if (Math.max(...v) >= BRACKET_SATURATION_CODE) {
          continue;
        }
        const back = displayToLinear(v[0], v[1], v[2], exposure);
        // 8-bit quantization dominates; require agreement to a few percent,
        // which is far tighter than the factor the naive stitch is out by.
        assert.ok(
          Math.abs(back[0] - L) <= 0.05 * L + 1e-4,
          `exposure ${exposure}, L=${L}: recovered ${back[0]}`,
        );
      }
    }
  },
  "the naive stitch turns the SHIPPED PSF into a phantom defect": () => {
    // This is the whole justification for inverting the display chain, and it
    // is a stronger statement than "the numbers differ". Measured through the
    // simulated instrument at the telescope framing:
    //
    //   linearized : r_core 4.906 px, ratio 7.203, slopes -3.560 / -3.633
    //   naive      : r_core 12.070 px, ratio 6.802, slopes -1.910 / -6.783
    //
    // The ratio survives (both clear the bar), but the naive stitch reports a
    // core 2.5x too wide and TWO SLOPES THAT STRADDLE THE BAND IN OPPOSITE
    // DIRECTIONS — an inverse-square inner wing and a near-inverse-seventh
    // outer one for a profile that is a single power law. Three of the four PSF
    // criteria would go red on a perfectly healthy renderer.
    const linear = measure(newProfilePx, stitchBracketLinear);
    const naive = measure(newProfilePx, stitchNaive);
    const inBandSlope = (s) =>
      Number.isFinite(s) && s >= PSF_SLOPE_BAND.lo && s <= PSF_SLOPE_BAND.hi;
    assert.equal(inBandSlope(linear.slopeInner), true);
    assert.equal(inBandSlope(linear.slopeOuter), true);
    assert.equal(
      inBandSlope(naive.slopeInner) && inBandSlope(naive.slopeOuter),
      false,
      `the naive stitch produced in-band slopes ${naive.slopeInner} / ` +
        `${naive.slopeOuter} — the inversion would then be unnecessary`,
    );
    assert.ok(
      Math.abs(naive.slopeInner - naive.slopeOuter) > PSF_SLOPE_AGREEMENT_MAX,
      "the naive stitch's two slopes agree, so the agreement criterion would " +
        "not have caught it either",
    );
    assert.ok(
      naive.rCore / linear.rCore > 2.0,
      `the naive core is only ${(naive.rCore / linear.rCore).toFixed(2)}x wide`,
    );
  },

  // ---- the PSF predicate discriminates ------------------------------------
  "the shipped PSF clears the G2 bar and the OLD blob does not": () => {
    const shipped = measure(newProfilePx, stitchBracketLinear);
    const blob = measure(oldProfilePx, stitchBracketLinear);
    assert.ok(
      shipped.ratio1e3 >= PSF_RATIO_1E3_MIN,
      `shipped PSF ratio ${shipped.ratio1e3} < bar ${PSF_RATIO_1E3_MIN}`,
    );
    assert.ok(
      blob.ratio1e3 < PSF_RATIO_1E3_MIN,
      `the OLD truncated Gaussian scored ${blob.ratio1e3}, at or above the bar ` +
        `${PSF_RATIO_1E3_MIN} — the criterion does not discriminate`,
    );
    // ...and with margin on BOTH sides, so the bar is not sitting on either.
    assert.ok(shipped.ratio1e3 / PSF_RATIO_1E3_MIN >= 1.5);
    assert.ok(PSF_RATIO_1E3_MIN / blob.ratio1e3 >= 1.5);
  },
  "the shipped PSF's two log-log slopes are in band and agree": () => {
    const shipped = measure(newProfilePx, stitchBracketLinear);
    for (const s of [shipped.slopeInner, shipped.slopeOuter]) {
      assert.ok(
        Number.isFinite(s) && s >= PSF_SLOPE_BAND.lo && s <= PSF_SLOPE_BAND.hi,
        `slope ${s} outside ${JSON.stringify(PSF_SLOPE_BAND)}`,
      );
    }
    const gap = Math.abs(shipped.slopeInner - shipped.slopeOuter);
    assert.ok(
      gap <= PSF_SLOPE_AGREEMENT_MAX,
      `slopes disagree by ${gap} > ${PSF_SLOPE_AGREEMENT_MAX}`,
    );
    // The blob has no power-law wing: its slopes are unmeasurable or out of
    // band. Either way the criteria must refuse it.
    const blob = measure(oldProfilePx, stitchBracketLinear);
    const blobOk =
      Number.isFinite(blob.slopeInner) &&
      blob.slopeInner >= PSF_SLOPE_BAND.lo &&
      blob.slopeInner <= PSF_SLOPE_BAND.hi;
    assert.equal(
      blobOk,
      false,
      `the truncated Gaussian produced an in-band inner slope ${blob.slopeInner}`,
    );
  },
  "the PSF sub-lane accepts the modelled measurement and rejects a blob": (
    impl,
  ) => {
    const shipped = measure(newProfilePx, stitchBracketLinear);
    const good = impl.evaluatePsfSubLane(
      healthyPsf({
        ratio1e3: shipped.ratio1e3,
        rCore: shipped.rCore,
        r1e3: shipped.r1e3,
        slopeInner: shipped.slopeInner,
        slopeOuter: shipped.slopeOuter,
      }),
    );
    assert.equal(good.pass, true, JSON.stringify(good.criteria));
    const blob = measure(oldProfilePx, stitchBracketLinear);
    const bad = impl.evaluatePsfSubLane(
      healthyPsf({
        ratio1e3: blob.ratio1e3,
        rCore: blob.rCore,
        r1e3: blob.r1e3,
        slopeInner: blob.slopeInner,
        slopeOuter: blob.slopeOuter,
      }),
    );
    assert.equal(bad.pass, false, "the blob must not pass the PSF sub-lane");
    assert.equal(bad.criteria.psf_ratio1e3_ge_4, false);
  },

  // ---- structural handling ------------------------------------------------
  "a PSF sub-lane that saw no source is STRUCTURAL, not FAIL": (impl) => {
    const r = impl.evaluatePsfSubLane(healthyPsf({ sources: 0 }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.criteria, {}, "a blind leg must score nothing");
    assert.ok(r.structural.length > 0);
    const folded = impl.foldG2Verdict({
      webgl: impl.evaluateG2Backend({
        renderer: "webgl",
        psf: healthyPsf({ sources: 0 }),
        magnitude: healthyMagnitude(),
        glare: healthyGlare(),
      }),
      webgpu: impl.evaluateG2Backend(healthyBackend("webgpu")),
    });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.equal(folded.failures.length, 0);
  },
  "a bracket that recovered nothing below the 8-bit floor FAILS": (impl) => {
    const r = impl.evaluatePsfSubLane(
      healthyPsf({ subFloorPixelsRecovered: PSF_MIN_SUBFLOOR_RECOVERED - 1 }),
    );
    assert.equal(r.criteria.psf_rangeExtended, false);
    assert.equal(r.pass, false);
  },
  "a magnitude sub-lane with too few matches is STRUCTURAL": (impl) => {
    const r = impl.evaluateMagnitudeSubLane(
      healthyMagnitude({ matched: MAGNITUDE_MIN_MATCHED - 1 }),
    );
    assert.deepEqual(r.criteria, {});
    assert.ok(r.structural.length > 0);
    assert.equal(r.pass, false);
    // ...and so is one where the matches are all CLIPPED, because a rank
    // correlation over ties measures nothing.
    const tied = impl.evaluateMagnitudeSubLane(
      healthyMagnitude({ matchedUnclipped: 1 }),
    );
    assert.deepEqual(tied.criteria, {});
    assert.ok(tied.structural.some((s) => s.includes("UNCLIPPED")));
  },
  "a glare lane whose veil resolved to strength 0 is STRUCTURAL": (impl) => {
    // The vacuity trap: with strength 0 every consumer skips its block, so the
    // far-field byte-identity criterion passes for a reason that has nothing to
    // do with the 90-degree support.
    const r = impl.evaluateGlareSubLane(healthyGlare({ onStrength: 0 }));
    assert.deepEqual(r.criteria, {});
    assert.ok(r.structural.some((s) => s.includes("strength")));
    assert.equal(r.pass, false);
  },
  "a far-field byte-identity claim over a BLACK frame is STRUCTURAL": (
    impl,
  ) => {
    const r = impl.evaluateGlareSubLane(
      healthyGlare({ farLitPixels: GLARE_MIN_LIT_PIXELS - 1 }),
    );
    assert.deepEqual(r.criteria, {});
    assert.ok(r.structural.some((s) => s.includes("black frames")));
  },
  "a failing A/A control voids the byte-identity claim, it does not fail it": (
    impl,
  ) => {
    const r = impl.evaluateGlareSubLane(
      healthyGlare({ farAaDifferingPixels: 12 }),
    );
    assert.deepEqual(r.criteria, {});
    assert.ok(r.structural.some((s) => s.includes("A/A")));
    assert.equal(r.pass, false);
  },

  // ---- C12-27's own acceptance criterion ----------------------------------
  "the far field is BYTE-IDENTICAL — one differing pixel is a FAIL": (impl) => {
    assert.equal(GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS, 0);
    const ok = impl.evaluateGlareSubLane(healthyGlare());
    assert.equal(ok.criteria.glare_farField_byteIdentical, true);
    const bad = impl.evaluateGlareSubLane(
      healthyGlare({ farDifferingPixels: 1 }),
    );
    assert.equal(bad.criteria.glare_farField_byteIdentical, false);
    assert.equal(bad.pass, false);
  },
  "the near field must dim measurably, and may never brighten a pixel": (
    impl,
  ) => {
    const under = impl.evaluateGlareSubLane(
      healthyGlare({
        nearEnergyDropFraction:
          GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION * 0.999,
      }),
    );
    assert.equal(under.criteria.glare_nearField_energyDrop_ge_bound, false);
    const thin = impl.evaluateGlareSubLane(
      healthyGlare({
        nearDifferingPixels: GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS - 1,
      }),
    );
    assert.equal(thin.criteria.glare_nearField_changedPixels_ge_bound, false);
    const brighter = impl.evaluateGlareSubLane(
      healthyGlare({ nearBrightenedPixels: 1 }),
    );
    assert.equal(brighter.criteria.glare_nearField_noPixelBrightened, false);
  },

  // ---- both backends, identically -----------------------------------------
  "a healthy two-backend run passes": (impl) => {
    const folded = foldFor(impl);
    assert.equal(folded.exitCode, EXIT_CODE.PASS, JSON.stringify(folded));
  },
  "a pass on ONE backend is a FAIL for the gate": (impl) => {
    for (const failing of ["gl", "gpu"]) {
      const folded = foldFor(impl, {
        [failing]: { psf: { ratio1e3: 1.8 } },
      });
      assert.equal(
        folded.exitCode,
        EXIT_CODE.FAIL,
        `a ${failing}-only regression must fail the gate`,
      );
      const renderer = failing === "gl" ? "webgl" : "webgpu";
      assert.ok(
        folded.failures.some((f) => f.startsWith(`${renderer}:`)),
        "the failure must NAME the backend it happened on",
      );
    }
  },
  "the two backends' PSF measurements must agree (shared code)": (impl) => {
    const folded = foldFor(impl, { gpu: { psf: { ratio1e3: 7.203 * 1.4 } } });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    assert.ok(
      folded.failures.some((f) => f.includes("psf_ratio1e3_parity")),
      "a cross-backend PSF divergence must be named",
    );
  },
  "an empty criteria set is not a clean sheet": (impl) => {
    // `{}.every(Boolean)` is true. Every composition point has to exclude the
    // empty case explicitly.
    const b = impl.evaluateG2Backend({
      renderer: "webgl",
      psf: healthyPsf({ sources: 0 }),
      magnitude: healthyMagnitude({ matched: 0 }),
      glare: healthyGlare({ onStrength: 0 }),
    });
    assert.equal(b.pass, false);
    assert.deepEqual(b.criteria, {});
    const folded = impl.foldG2Verdict({
      webgl: b,
      webgpu: impl.evaluateG2Backend(healthyBackend("webgpu")),
    });
    assert.notEqual(folded.exitCode, EXIT_CODE.PASS);
  },
  "a real defect outranks a structural leg": (impl) => {
    const folded = impl.foldG2Verdict({
      webgl: impl.evaluateG2Backend({
        renderer: "webgl",
        psf: healthyPsf({ ratio1e3: 1.8 }),
        magnitude: healthyMagnitude(),
        glare: healthyGlare(),
      }),
      webgpu: impl.evaluateG2Backend({
        renderer: "webgpu",
        psf: healthyPsf({ sources: 0 }),
        magnitude: healthyMagnitude(),
        glare: healthyGlare(),
      }),
    });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    assert.ok(folded.structural.length > 0, "the blindness is still named");
  },

  // ---- the printed summary carries its bounds -----------------------------
  "the summary prints every bound alongside its verdict": (impl) => {
    const folded = foldFor(impl);
    const summary = impl.buildG2Summary({
      ...folded,
      backends: {
        webgl: impl.evaluateG2Backend(healthyBackend("webgl")),
        webgpu: impl.evaluateG2Backend(healthyBackend("webgpu")),
      },
    });
    for (const key of [
      "PSF_RATIO_1E3_MIN",
      "PSF_SLOPE_BAND",
      "PSF_SLOPE_AGREEMENT_MAX",
      "CLIPPED_PIXELS_MAX",
      "RENDERED_RANGE_MIN",
      "GLARE_FAR_FIELD_MAX_DIFFERING_PIXELS",
      "GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION",
    ]) {
      assert.ok(
        Object.hasOwn(summary.bounds, key),
        `${key} must travel with the verdict`,
      );
    }
    assert.equal(summary.gate, "G2");
    assert.ok(summary.backends.webgl && summary.backends.webgpu);
  },
};

// ---------------------------------------------------------------------------
// MUTANTS — the plausible wrong implementation of each rule.
// ---------------------------------------------------------------------------

const MUTANTS = {
  "the naive v/255/f stitch (the pre-CO-3 shape)": {
    ...REAL,
    stitchBracketLinear: stitchNaive,
    // The gate then reads a gamma-encoded profile. Model the consequence
    // directly, since the sub-lane takes numbers rather than pixels.
    evaluatePsfSubLane: (m) =>
      evaluatePsfSubLane({
        ...m,
        ratio1e3: measure(newProfilePx, stitchNaive).ratio1e3,
        slopeInner: measure(newProfilePx, stitchNaive).slopeInner,
        slopeOuter: measure(newProfilePx, stitchNaive).slopeOuter,
      }),
  },
  "the G2 bar loosened until the blob passes": {
    ...REAL,
    evaluatePsfSubLane: (m) => {
      const r = evaluatePsfSubLane(m);
      if (Object.keys(r.criteria).length === 0) {
        return r;
      }
      const criteria = { ...r.criteria, psf_ratio1e3_ge_4: m.ratio1e3 >= 1.5 };
      return { ...r, criteria, pass: Object.values(criteria).every(Boolean) };
    },
  },
  "the slope criteria dropped (the wing never checked)": {
    ...REAL,
    evaluatePsfSubLane: (m) => {
      const r = evaluatePsfSubLane(m);
      const criteria = { ...r.criteria };
      delete criteria.psf_slopeInner_in_band;
      delete criteria.psf_slopeOuter_in_band;
      delete criteria.psf_slopes_agree;
      return { ...r, criteria, pass: Object.values(criteria).every(Boolean) };
    },
  },
  "a blind PSF leg scored as a defect (the phantom)": {
    ...REAL,
    evaluatePsfSubLane: (m) => {
      const r = evaluatePsfSubLane(m);
      if (r.structural.length === 0) {
        return r;
      }
      return {
        ...r,
        structural: [],
        criteria: { psf_ratio1e3_ge_4: false },
        pass: false,
      };
    },
  },
  "a blind PSF leg scored as a pass (the false green)": {
    ...REAL,
    evaluatePsfSubLane: (m) => {
      const r = evaluatePsfSubLane(m);
      if (r.structural.length === 0) {
        return r;
      }
      return { ...r, structural: [], criteria: {}, pass: true };
    },
  },
  "the empty criteria set folded as a clean sheet": {
    ...REAL,
    evaluateG2Backend: (backend) => {
      const b = evaluateG2Backend(backend);
      return { ...b, pass: Object.values(b.criteria).every(Boolean) };
    },
    foldG2Verdict: (evaluated) => {
      const folded = foldG2Verdict(evaluated);
      return folded.verdict === "STRUCTURAL"
        ? { ...folded, verdict: "PASS", exitCode: EXIT_CODE.PASS }
        : folded;
    },
  },
  "the far-field claim made without the not-blank control": {
    ...REAL,
    evaluateGlareSubLane: (m) =>
      evaluateGlareSubLane({ ...m, farLitPixels: Number.MAX_SAFE_INTEGER }),
  },
  "the far-field claim made without the A/A control": {
    ...REAL,
    evaluateGlareSubLane: (m) =>
      evaluateGlareSubLane({ ...m, farAaDifferingPixels: 0 }),
  },
  "the far-field byte-identity relaxed to 'close enough'": {
    ...REAL,
    evaluateGlareSubLane: (m) => {
      const r = evaluateGlareSubLane(m);
      if (Object.keys(r.criteria).length === 0) {
        return r;
      }
      const criteria = {
        ...r.criteria,
        glare_farField_byteIdentical: (m.farDifferingPixels ?? 0) <= 5000,
      };
      return { ...r, criteria, pass: Object.values(criteria).every(Boolean) };
    },
  },
  "the glare veil allowed to BRIGHTEN pixels": {
    ...REAL,
    evaluateGlareSubLane: (m) => {
      const r = evaluateGlareSubLane(m);
      const criteria = { ...r.criteria };
      delete criteria.glare_nearField_noPixelBrightened;
      return { ...r, criteria, pass: Object.values(criteria).every(Boolean) };
    },
  },
  "a WebGPU-only pass carried the gate": {
    ...REAL,
    foldG2Verdict: (evaluated) => {
      const folded = foldG2Verdict(evaluated);
      return evaluated?.webgpu?.pass
        ? {
            verdict: "PASS",
            exitCode: EXIT_CODE.PASS,
            failures: [],
            structural: [],
          }
        : folded;
    },
  },
  "cross-backend PSF parity never checked": {
    ...REAL,
    foldG2Verdict: (evaluated) => {
      const folded = foldG2Verdict(evaluated);
      return {
        ...folded,
        failures: folded.failures.filter(
          (f) => !f.includes("psf_ratio1e3_parity"),
        ),
        exitCode: folded.failures.filter(
          (f) => !f.includes("psf_ratio1e3_parity"),
        ).length
          ? folded.exitCode
          : EXIT_CODE.PASS,
        verdict: folded.failures.filter(
          (f) => !f.includes("psf_ratio1e3_parity"),
        ).length
          ? folded.verdict
          : "PASS",
      };
    },
  },
  "the magnitude lane certified over CLIPPED ties": {
    ...REAL,
    evaluateMagnitudeSubLane: (m) =>
      evaluateMagnitudeSubLane({ ...m, matchedUnclipped: m.matched }),
  },
  "the summary stopped printing its bounds": {
    ...REAL,
    buildG2Summary: (result) => {
      const s = buildG2Summary(result);
      return { ...s, bounds: {} };
    },
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

for (const [name, rule] of Object.entries(RULES)) {
  test(name, () => rule(REAL));
}

for (const [name, impl] of Object.entries(MUTANTS)) {
  test(`mutant rejected: ${name}`, () => {
    const caughtBy = [];
    for (const [ruleName, rule] of Object.entries(RULES)) {
      try {
        rule(impl);
      } catch {
        caughtBy.push(ruleName);
      }
    }
    assert.ok(
      caughtBy.length > 0,
      "this wrong implementation passed every rule — the rules do not constrain it",
    );
  });
}

// ---------------------------------------------------------------------------
// Source-text pins — the things a fixture cannot see.
// ---------------------------------------------------------------------------

test("the inversion's constants match the shipped shaders", () => {
  const glsl = readNormalized(
    "packages/engine/Source/Shaders/Builtin/Functions/pbrNeutralTonemapping.glsl",
  );
  const wgsl = readNormalized(
    "packages/engine/Source/Shaders/WebGPU/PostProcess/Tonemapping.wgsl",
  );
  const stage = readNormalized(
    "packages/engine/Source/Shaders/PostProcessStages/PbrNeutralTonemapping.glsl",
  );
  const scene = readNormalized("packages/engine/Source/Scene/Scene.js");

  assert.match(glsl, /const float startCompression = 0\.8 - 0\.04;/);
  assert.match(glsl, /const float desaturation = 0\.15;/);
  assert.equal(PBRN_START_COMPRESSION, 0.8 - 0.04);
  assert.equal(PBRN_DESATURATION, 0.15);
  // The offset branch this inversion solves for.
  assert.match(glsl, /x < 0\.08, x - 6\.25 \* x \* x, 0\.04/);
  assert.match(wgsl, /startCompression|0\.76/);
  // The stage applies the tonemap and THEN the inverse gamma. If that order
  // ever changes, the inversion's order is wrong.
  const tonemapAt = stage.indexOf("czm_pbrNeutralTonemapping(color)");
  const gammaAt = stage.indexOf("czm_inverseGamma(color)");
  assert.ok(tonemapAt > 0 && gammaAt > tonemapAt, "tonemap must precede gamma");
  assert.match(scene, /this\.gamma = 2\.2;/);
  assert.equal(DISPLAY_GAMMA, 2.2);
});

test("the G2 lane binds the M4/M5 metrics C12-02 wired as diagnostic", () => {
  // C12-02's row: "M4/M5 wired as DIAGNOSTIC until G2/G4 bind them (per wave
  // structure)". This is the batch that binds them, so the probe must actually
  // reach both.
  assert.match(PROBE, /m4RadialFalloff\(/);
  assert.match(PROBE, /m5MagnitudeFidelity\(/);
  assert.match(PROBE, /const G2 = process\.argv\.includes\("--g2"\);/);
  assert.match(PROBE, /foldG2Verdict\(backends\)/);
  assert.match(PROBE, /buildG2Summary\(result\)/);
});

test("the G2 glare legs both sit on the SUNLIT side of the Earth", () => {
  // If the near-field leg were placed anti-sunward, the Earth would occlude the
  // Sun, `sunVisibleFraction` would resolve 0, the veil strength would be 0 and
  // every glare criterion would pass vacuously. Pinned in source because it is
  // a property of the CAMERA PLACEMENT, which no fixture can observe.
  assert.match(HARNESS, /aimMode === "sun-facing" \|\| aimMode === "anti-sun"/);
  const block = HARNESS.slice(
    HARNESS.indexOf('aimMode === "sun-facing" || aimMode === "anti-sun"'),
    HARNESS.indexOf("} else {", HARNESS.indexOf('aimMode === "sun-facing"')),
  );
  assert.match(
    block,
    /const position = C\.Cartesian3\.multiplyByScalar\(\s*axis,\s*dist,/,
    "both glare legs must place the camera at +sunDir * dist",
  );
  assert.doesNotMatch(
    block,
    /negate\(\s*axis,\s*new C\.Cartesian3\(\)\s*\),\s*\n\s*dist/,
    "the camera must not be moved to the anti-solar side",
  );
});

test("the G2 telescope framing is narrow enough to resolve the core", () => {
  const match = PROBE.match(/const G2_TELESCOPE_FOV_X_DEG = ([0-9.]+);/);
  assert.ok(match, "the telescope FOV must be an explicit named constant");
  const fov = Number(match[1]);
  const scale = pixelScale(fov);
  const coreHwhmPx = REF.SIGMA * Math.sqrt(2 * Math.log(2)) * scale.basePxHalf;
  // M4's slope windows are [2 r_core, 5 r_core] and [5 r_core, 15 r_core] in
  // INTEGER radii. Two samples in the inner window needs r_core >= ~0.7 px; the
  // assertion is much stronger than that because a two-point fit is not a
  // slope measurement.
  assert.ok(
    coreHwhmPx >= 3.0,
    `core HWHM ${coreHwhmPx.toFixed(2)} px at fovX ${fov} deg leaves M4's slope ` +
      "windows with too few integer radii to fit",
  );
  // ...and the whole quad must still fit inside the crop.
  const quadHalfPx = scale.basePxHalf * quadScale(I_MAX);
  assert.ok(
    quadHalfPx < 320,
    `quad half-extent ${quadHalfPx.toFixed(1)} px does not fit the 640 px crop height`,
  );
});

test("the clipped-pixel budget is evaluated at the LDR white point", () => {
  // NOT at 8-bit code 250. Under PBR Neutral a scene radiance of 1.0 renders as
  // code 239 and code 250 is radiance ~2.6, so a code-based census would move
  // the criterion by a factor of ~2.6 without anyone editing the number.
  assert.equal(CLIP_LEVEL_LINEAR, 1.0);
  const atWhite = encode8([1, 1, 1], 1)[0];
  const atSaturation = displayToLinear(
    BRACKET_SATURATION_CODE,
    BRACKET_SATURATION_CODE,
    BRACKET_SATURATION_CODE,
    1,
  )[0];
  assert.ok(
    atWhite < BRACKET_SATURATION_CODE,
    `radiance 1.0 renders at code ${atWhite}, which is already >= the ` +
      "saturation code — the two definitions would coincide",
  );
  // Measured: code 250 inverts to radiance 1.911, i.e. 1.9x the LDR white
  // point. A code-based clipped-pixel census would therefore be measuring a
  // different criterion than the one the queue states.
  assert.ok(
    atSaturation > 1.5,
    `code ${BRACKET_SATURATION_CODE} is radiance ${atSaturation}, not ~1.0`,
  );
  assert.match(PROBE, /peak >= CLIP_LEVEL_LINEAR/);
  assert.equal(CLIPPED_PIXELS_MAX, 25);
});

test("the delivered-range bar matches the shipped exposure anchor", () => {
  // `StarFieldMath.ts` anchors the exposure so `1.0 / FAINT_ANCHOR_PEAK` clears
  // the queue's 15:1. If either constant moves, this bar stops describing the
  // shipped renderer.
  const mathTs = readNormalized(
    "packages/engine/Source/Scene/StarFieldMath.ts",
  );
  assert.match(mathTs, /const FAINT_ANCHOR_MAG = 3\.6;/);
  assert.match(mathTs, /const FAINT_ANCHOR_PEAK = 0\.06;/);
  assert.ok(
    1.0 / REF.FAINT_ANCHOR_PEAK >= RENDERED_RANGE_MIN,
    "the shipped anchor no longer clears the G2 range bar",
  );
  assert.equal(RENDERED_RANGE_MIN, 15);
  assert.equal(MAGNITUDE_SPEARMAN_MIN, 0.9);
});

test("multi-lane state is restored, not left behind", () => {
  // `runBackendLanes` drives four lanes on ONE page. Two settings leak across
  // lanes if they are only ever set in one direction, and both leaks are
  // silent: a narrowed FOV would hand the telescope framing to the magnitude
  // and glare lanes, and a left-on HDR path would put the tonemap +
  // inverse-gamma stage in front of the glare legs, which read RAW 8-bit codes
  // on the stated grounds that the SDR canvas carries clamp(linear).
  assert.match(HARNESS, /window\.__probeOriginalFovRad/);
  assert.match(
    HARNESS,
    /frustum\.fov = Number\.isFinite\(fovX\)\s*\?\s*C\.Math\.toRadians\(fovX\)\s*:\s*window\.__probeOriginalFovRad;/,
    "the FOV must be RESTORED when a lane requests no override",
  );
  assert.match(
    HARNESS,
    /\} else \{\s*\n\s*scene\.highDynamicRange = false;/,
    "highDynamicRange must be set in BOTH directions",
  );
  assert.match(
    HARNESS,
    /scene\.postProcessStages\.exposure = 1\.0;/,
    "the exposure must be reset — the last bracket step is 64x",
  );
  // ...and the glare metrics must therefore be reading SDR codes.
  assert.match(PROBE, /function sdrLuma\(data, i\)/);
  for (const lane of ["glare-near", "glare-far"]) {
    const at = PROBE.indexOf(`key: "${lane}"`);
    assert.ok(at > 0, `${lane} lane must exist`);
    const block = PROBE.slice(at, at + 700);
    assert.doesNotMatch(
      block,
      /hdr: true/,
      `${lane} must capture in SDR — its criteria read raw 8-bit codes`,
    );
  }
});

test("the G2 probe carries a watchdog and closes the browser in finally", () => {
  // CO-24 added the G3 arm ahead of these two and CO-27 added G4 ahead of that.
  // The G2 and default budgets are pinned UNCHANGED — the assertion is still
  // that G2 gets 1,200,000 ms and a default run gets 600,000; the match is now
  // written per-arm so a new sibling budget cannot fail this test while leaving
  // both pinned values intact.
  assert.match(PROBE, /const HARD_LIMIT_MS = /);
  assert.match(PROBE, /G2 \? 1200000 : 600000;/);
  assert.match(PROBE, /WATCHDOG FIRED/);
  assert.match(PROBE, /if \(watchdog\.unref\)/);
  assert.match(PROBE, /await browser\.close\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(PROBE, /await context\.close\(\)\.catch\(\(\) => \{\}\);/);
});
