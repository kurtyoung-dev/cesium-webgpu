// celestial-g1-gate.spec.mjs — browser-free guard for the C12-G1F2 G1 repair.
//
// The three repairs this pins are all repairs to a GATE, so a spec that only
// exercised the correct implementation would be worth nothing: the pre-repair
// code also "passed" — it just passed vacuously. Every rule below is therefore
// stated once and then run twice, against the real implementation and against a
// battery of MUTANTS, each of which is the plausible wrong implementation
// somebody would actually write. `mutant rejection` requires each mutant to be
// caught by at least one rule.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { srgbToLinear } from "./lib/celestial-metrics.mjs";
import {
  CUBEMAP_CERTIFYING_MODE,
  EXIT_CODE,
  MODE_ROLE,
  MODULATION_ENGAGED_MIN_ABS_DELTA,
  SKY_FLOOR_ABS_TOLERANCE,
  SPRITE_DIFFERING_FRACTION_MAX,
  SPRITE_MAX_CHANNEL_DELTA,
  STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
  buildG1Summary,
  computeFramingReached,
  evaluateCubemapParityLane,
  evaluateStarModulationLane,
  foldG1Verdict,
  inBand,
  modeIsBlank,
  modeIsBlind,
  ratio,
  skyFloorAgrees,
} from "./lib/celestial-g1-gate.mjs";
import { DR01_LIVE_MAX_RESOLVED_SOURCES } from "./lib/celestial-source-split.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");
const PROBE = readNormalized(
  "Tools/visual-regression/probe-celestial-gates.mjs",
);
// Executable lines only. The header deliberately NAMES the retired proxy in
// prose ("NOT `sunElevationDeg >= 25`"), so an assertion that the proxy is gone
// has to look at code, not at the comment explaining its removal.
const PROBE_CODE = PROBE.split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** One 8-bit sRGB code value, in linear light. */
const ONE_CODE = srgbToLinear(1 / 255);
/** Two code values — "one code value too large" for the M2e bound. */
const TWO_CODES = srgbToLinear(2 / 255);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const healthyMode = (over = {}) => ({
  m1CountRatio: 1,
  m2aRatio: 1,
  m2bRatio: 1,
  m3ChromaRatio: 1,
  meanLumRatio: 1,
  stddevRatio: 1,
  webglMean: 0.02,
  webgpuMean: 0.02,
  webglStddev: 0.05,
  webgpuStddev: 0.05,
  webglM1Count: 55,
  webgpuM1Count: 55,
  webglSkyFloor: 0,
  webgpuSkyFloor: 0,
  // POST-DR-01 Lane-A instruments (CO-3 re-scope). A healthy mode draws
  // content, the two backends agree pixel for pixel, and the sprite chroma is
  // measurable.
  litPixelRatio: 1,
  webglLitPixels: 40000,
  webgpuLitPixels: 40000,
  webglPeakLuminance: 0.02,
  webgpuPeakLuminance: 0.02,
  differingPixels: 0,
  differingFraction: 0,
  maxChannelDelta: 0,
  bitIdentical: true,
  webglMedianSaturation: 0.3,
  webgpuMedianSaturation: 0.3,
  webglChromaSamples: 200,
  ...over,
});

// The HEALTHY post-DR-01 `cubemap-only` mode: the diffuse bake censuses ZERO
// resolved sources by construction. That reading used to route the mode to
// STRUCTURAL; it is now the assertion.
const healthyDiffuseMode = (over = {}) =>
  healthyMode({
    webglM1Count: 0,
    webgpuM1Count: 0,
    m1CountRatio: null,
    ...over,
  });

// The HEALTHY post-DR-01 `sprites-only` mode. It ALSO censuses zero: the sprite
// exposure anchors a vmag-3.6 star at 15.3/255 while `m1PointSourceCensus`
// needs a local rise of 12/255 in LINEAR light (~code 61), and the measured
// sprites-only peak in this framing is code 36. That is the reading that made
// the pre-re-scope lane structural, and it is what any fixture claiming to
// describe HEAD has to carry.
const healthySpriteMode = (over = {}) =>
  healthyMode({
    webglM1Count: 0,
    webgpuM1Count: 0,
    m1CountRatio: null,
    ...over,
  });

const cubemapLane = (over = {}) => ({
  id: "orbital-cubemap-parity",
  role: "cubemap + sprite parity",
  // The real orbital camera: sun at the zenith, sky brightness identically 0.
  skyBrightness: { webgl: 0, webgpu: 0 },
  sunElevationDeg: { webgl: 90, webgpu: 90 },
  countModes: ["cubemap-only", "sprites-only"],
  certifyingMode: "default",
  modeRoles: {
    default: MODE_ROLE.COMPOSITE,
    "cubemap-only": MODE_ROLE.DIFFUSE,
    "sprites-only": MODE_ROLE.SPRITES,
  },
  perMode: {
    default: healthyMode(),
    "cubemap-only": healthyDiffuseMode(),
    "sprites-only": healthySpriteMode(),
  },
  ...over,
});

const columnLane = (over = {}) => ({
  id: "in-column-star-modulation",
  role: "C11-176 star modulation",
  skyBrightness: { webgl: 1, webgpu: 1 },
  sunElevationDeg: { webgl: 90, webgpu: 90 },
  countModes: [],
  perMode: {
    "modulation-off": healthyMode({ webglMean: 0.3, webgpuMean: 0.3 }),
    "modulation-on": healthyMode({ webglMean: 0.1, webgpuMean: 0.1 }),
  },
  ...over,
});

const REAL = {
  SKY_FLOOR_ABS_TOLERANCE,
  skyFloorAgrees,
  computeFramingReached,
  evaluateCubemapParityLane,
  evaluateStarModulationLane,
  foldG1Verdict,
  buildG1Summary,
};

const evaluate = (impl, { cubemap = cubemapLane(), column = columnLane() }) => {
  const lanes = {
    cubemapParity: impl.evaluateCubemapParityLane(cubemap),
    starModulation: impl.evaluateStarModulationLane(column),
  };
  return { lanes, ...impl.foldG1Verdict(lanes) };
};

// ---------------------------------------------------------------------------
// RULES — each must hold for the real implementation and must be capable of
// failing. Stated as closures over `impl` so mutants can be run through them.
// ---------------------------------------------------------------------------

const RULES = {
  // ---- ITEM 2: M2e, the pedestal discriminator ----------------------------
  "M2e bound is exactly one 8-bit code value in linear light": (impl) => {
    assert.equal(impl.SKY_FLOOR_ABS_TOLERANCE, ONE_CODE);
    // Sanity on the derivation itself: sRGB is linear below its cutoff, so the
    // bound is (1/255)/12.92 and lands near 3.0e-4.
    assert.ok(Math.abs(impl.SKY_FLOOR_ABS_TOLERANCE - 1 / 255 / 12.92) < 1e-12);
    assert.ok(impl.SKY_FLOOR_ABS_TOLERANCE > 2.9e-4);
    assert.ok(impl.SKY_FLOOR_ABS_TOLERANCE < 3.2e-4);
  },
  "M2e accepts agreement at one code value and rejects two": (impl) => {
    assert.equal(impl.skyFloorAgrees(0, 0), true);
    assert.equal(impl.skyFloorAgrees(0, ONE_CODE), true);
    // One code value TOO LARGE — the synthetic pedestal.
    assert.equal(impl.skyFloorAgrees(0, TWO_CODES), false);
    assert.equal(impl.skyFloorAgrees(TWO_CODES, 0), false);
  },
  "M2e is absolute, not a ratio": (impl) => {
    // Two identically-zero floors are agreement, but 0/0 is not a ratio.
    assert.equal(impl.skyFloorAgrees(0, 0), true);
    // Proportionally close but absolutely far: a ratio test would pass this.
    assert.equal(inBand(ratio(0.0105, 0.01)), true);
    assert.equal(impl.skyFloorAgrees(0.01, 0.0105), false);
  },
  "M2e certifies — a two-code pedestal FAILS the gate": (impl) => {
    const lane = cubemapLane();
    lane.perMode.default = healthyMode({ webgpuSkyFloor: TWO_CODES });
    const evaluated = impl.evaluateCubemapParityLane(lane);
    assert.equal(
      evaluated.criteria.default_m2e_skyFloor_within_quantization,
      false,
      "M2e must be a CRITERION, not a diagnostic",
    );
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    assert.ok(
      folded.failures.some((f) => f.includes("m2e")),
      "the M2e failure must be named in failures[]",
    );
  },

  // ---- ITEM 3: reachability on the DRIVING variable -----------------------
  "framingReached is false when skyBrightness is 0": (impl) => {
    assert.equal(
      impl.computeFramingReached({ webgl: 0, webgpu: 0 }),
      false,
      "the vacuous case must be detected",
    );
    assert.equal(impl.computeFramingReached({ webgl: 1, webgpu: 1 }), true);
    assert.equal(
      impl.computeFramingReached({
        webgl: STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
        webgpu: STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
      }),
      false,
      "the threshold is strict",
    );
  },
  "framingReached ignores solar elevation entirely": (impl) => {
    // The exact recorded orbital state: sun at the zenith, sky brightness 0.
    // The pre-repair `sunElevationDeg >= 25` said REACHED here.
    assert.equal(impl.computeFramingReached({ webgl: 0, webgpu: 0 }), false);
  },
  "framingReached requires BOTH backends": (impl) => {
    assert.equal(impl.computeFramingReached({ webgl: 1, webgpu: 0 }), false);
    assert.equal(impl.computeFramingReached({ webgl: 0, webgpu: 1 }), false);
  },
  "framingReached rejects absent measurements": (impl) => {
    assert.equal(impl.computeFramingReached({}), false);
    assert.equal(
      impl.computeFramingReached({ webgl: null, webgpu: null }),
      false,
    );
    assert.equal(
      impl.computeFramingReached({ webgl: NaN, webgpu: NaN }),
      false,
    );
  },
  "an unreachable star-modulation lane is STRUCTURAL, never PASS or FAIL": (
    impl,
  ) => {
    const column = columnLane({ skyBrightness: { webgl: 0, webgpu: 0 } });
    const folded = evaluate(impl, { column });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.notEqual(folded.exitCode, EXIT_CODE.PASS);
    assert.notEqual(folded.exitCode, EXIT_CODE.FAIL);
    assert.equal(folded.verdict, "STRUCTURAL");
    assert.equal(folded.failures.length, 0);
    assert.ok(folded.structural.some((s) => s.includes("skyBrightness")));
  },
  "a modulation term that never moved a pixel is STRUCTURAL": (impl) => {
    // Reachable framing, but OFF and ON render identically: the lane saw
    // nothing even though it was pointed at the right thing.
    const column = columnLane();
    column.perMode["modulation-off"] = healthyMode({
      webglMean: 0.3,
      webgpuMean: 0.3,
    });
    column.perMode["modulation-on"] = healthyMode({
      webglMean: 0.3,
      webgpuMean: 0.3,
    });
    const folded = evaluate(impl, { column });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.ok(folded.structural.some((s) => s.includes("never moved a pixel")));
  },
  "a reachable, engaged, divergent lane is a real FAIL": (impl) => {
    // WebGPU removes twice the star energy WebGL does — the C11-176 shape.
    const column = columnLane();
    column.perMode["modulation-on"] = healthyMode({
      webglMean: 0.2,
      webgpuMean: 0.1,
    });
    const evaluated = impl.evaluateStarModulationLane(column);
    assert.equal(evaluated.framingReached, true);
    assert.equal(evaluated.modulationEngaged, true);
    assert.equal(evaluated.structural, false);
    assert.equal(evaluated.criteria.starEnergyRatio_in_band, false);
    const folded = evaluate(impl, { column });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  },
  "a healthy two-lane run passes": (impl) => {
    const folded = evaluate(impl, {});
    assert.equal(folded.exitCode, EXIT_CODE.PASS);
    assert.equal(folded.verdict, "PASS");
  },
  "a split mode BLANK on BOTH backends is STRUCTURAL, not FAIL": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthySpriteMode({
      webglLitPixels: 0,
      webgpuLitPixels: 0,
      litPixelRatio: null,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.equal(folded.failures.length, 0);
    assert.ok(folded.structural.some((s) => s.includes("sprites-only")));
  },
  "a split mode blank on ONE backend is a real FAIL": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthySpriteMode({
      webglLitPixels: 40000,
      webgpuLitPixels: 0,
      litPixelRatio: 0,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    assert.ok(
      folded.failures.some((f) => f.includes("litPixelRatio")),
      "the one-sided darkness must be named by the lit-extent criterion",
    );
  },

  // ---- CO-3: THE PRE-DR-01 STAR-THRESHOLD RE-SCOPE -------------------------
  //
  // The point of the re-scope is that a ZERO CENSUS on the cube map went from
  // being the lane's blindness to being its assertion. Both directions have to
  // be pinned, or the change is indistinguishable from deleting a criterion.
  "a zero cube-map census is the HEALTHY reading, not blindness": (impl) => {
    const lane = cubemapLane();
    const evaluated = impl.evaluateCubemapParityLane(lane);
    assert.equal(
      evaluated.criteria[
        `cubemapOnly_dr01_resolvedSources_le_${DR01_LIVE_MAX_RESOLVED_SOURCES}`
      ],
      true,
      "the DR-01 seam must be a CRITERION that a zero census SATISFIES",
    );
    assert.equal(
      evaluated.structuralModes.includes("cubemap-only"),
      false,
      "a diffuse cube map with no resolved sources is not a blind mode",
    );
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.PASS);
  },
  "a cube map that REGAINS resolved sources fails the DR-01 seam": (impl) => {
    // What a re-bake without the low-pass, or a default flipped back to the
    // un-blurred faces, looks like from the live frame.
    for (const over of [
      { webglM1Count: 55, webgpuM1Count: 55, m1CountRatio: 1 },
      { webglM1Count: 0, webgpuM1Count: 55, m1CountRatio: null },
      { webglM1Count: 55, webgpuM1Count: 0, m1CountRatio: 0 },
    ]) {
      const lane = cubemapLane();
      lane.perMode["cubemap-only"] = healthyDiffuseMode(over);
      const folded = evaluate(impl, { cubemap: lane });
      assert.equal(
        folded.exitCode,
        EXIT_CODE.FAIL,
        `a cube map censusing ${JSON.stringify(over)} must FAIL the seam`,
      );
      assert.ok(
        folded.failures.some((f) => f.includes("dr01_resolvedSources")),
        "the seam failure must be named",
      );
    }
  },
  "the DR-01 seam cannot be satisfied by a BLACK cube-map frame": (impl) => {
    // The vacuity this re-scope had to design against: "no resolved sources" is
    // also what a frame with nothing in it says.
    const lane = cubemapLane();
    lane.perMode["cubemap-only"] = healthyDiffuseMode({
      webglLitPixels: 0,
      webgpuLitPixels: 0,
      litPixelRatio: null,
      webglPeakLuminance: 0,
      webgpuPeakLuminance: 0,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.notEqual(
      folded.exitCode,
      EXIT_CODE.PASS,
      "a black cube map satisfies the zero census and must NOT read as a pass",
    );
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.ok(folded.structural.some((s) => s.includes("cubemap-only")));
  },
  "the sprite pass certifies on per-pixel agreement, and the bound has teeth": (
    impl,
  ) => {
    const at = (over) => {
      const lane = cubemapLane();
      lane.perMode["sprites-only"] = healthySpriteMode(over);
      return impl.evaluateCubemapParityLane(lane);
    };
    // Bit-identical (what Batch 873 measured) passes.
    assert.equal(at({}).pass, true);
    // One code value over the bound on ONE channel fails.
    const overDelta = at({ maxChannelDelta: SPRITE_MAX_CHANNEL_DELTA + 1 });
    assert.equal(
      overDelta.criteria[
        `spritesOnly_maxChannelDelta_le_${SPRITE_MAX_CHANNEL_DELTA}`
      ],
      false,
    );
    // A fraction just over the bound fails.
    const overFraction = at({
      differingFraction: SPRITE_DIFFERING_FRACTION_MAX * 1.0001,
    });
    assert.equal(
      overFraction.criteria.spritesOnly_differingFraction_within_bound,
      false,
    );
    // ...and just under it passes, so the bound is a bound and not a tautology.
    assert.equal(
      at({ differingFraction: SPRITE_DIFFERING_FRACTION_MAX * 0.9999 }).criteria
        .spritesOnly_differingFraction_within_bound,
      true,
    );
  },
  "an unmeasurable sprite chroma is STRUCTURAL, never a scored 0/0": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthySpriteMode({
      webglChromaSamples: 0,
      webglMedianSaturation: 0,
      webgpuMedianSaturation: 0,
      m3ChromaRatio: null,
    });
    const evaluated = impl.evaluateCubemapParityLane(lane);
    assert.equal(
      Object.hasOwn(evaluated.criteria, "spritesOnly_chromaRatio_ge_0_85"),
      false,
      "a 0/0 chroma must be DROPPED, not scored — null >= 0.85 is a confident false",
    );
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.equal(folded.failures.length, 0);
    assert.ok(folded.structural.some((s) => s.includes("chroma")));
  },
  "a measurable sprite chroma still certifies": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthySpriteMode({ m3ChromaRatio: 0.5 });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    assert.ok(folded.failures.some((f) => f.includes("chromaRatio")));
  },
  "modeIsBlank is zero-barred and per-mode; modeIsBlind is retained": (
    impl,
  ) => {
    assert.equal(modeIsBlank({ webglLitPixels: 0, webgpuLitPixels: 0 }), true);
    assert.equal(modeIsBlank({ webglLitPixels: 1, webgpuLitPixels: 0 }), false);
    assert.equal(modeIsBlank({ webglLitPixels: 0, webgpuLitPixels: 1 }), false);
    assert.equal(modeIsBlank({}), true, "absent measurements read as blank");
    // The superseded predicate is still exported, still has the same polarity,
    // and is NOT what the lane routes on any more.
    assert.equal(modeIsBlind({ webglM1Count: 0, webgpuM1Count: 0 }), true);
    const lane = cubemapLane();
    assert.equal(modeIsBlind(lane.perMode["cubemap-only"]), true);
    assert.equal(
      impl.evaluateCubemapParityLane(lane).structuralModes.length,
      0,
      "the mode modeIsBlind calls blind is exactly the mode the gate now certifies",
    );
  },

  // ---- AUDIT ITEM 4: one-sided modulation death is the DEFECT --------------
  //
  // The C11-176 shape is a star-brightness modulation that is live on one
  // backend and inert on the other. If the lane's non-vacuity control ANDs the
  // two backends, that shape reads as "the term never moved a pixel" and the
  // gate prints "this is NOT a pass and NOT a defect" over a shipped one-sided
  // regression. Both directions are exercised because the historical defect ran
  // WebGPU-only and the C12-29 S6 / ruling E3 WebGL half can regress the other
  // way.
  "a modulation term dead on ONE backend is a real FAIL, not STRUCTURAL": (
    impl,
  ) => {
    for (const [live, dead] of [
      ["webgl", "webgpu"],
      ["webgpu", "webgl"],
    ]) {
      const column = columnLane();
      column.perMode["modulation-off"] = healthyMode({
        [`${live}Mean`]: 0.3,
        [`${dead}Mean`]: 0.1,
      });
      column.perMode["modulation-on"] = healthyMode({
        webglMean: 0.1,
        webgpuMean: 0.1,
      });
      const evaluated = impl.evaluateStarModulationLane(column);
      assert.equal(
        evaluated.framingReached,
        true,
        `${dead}-dead: the lane still reaches its failure state`,
      );
      assert.equal(
        evaluated.structural,
        false,
        `${dead}-dead: a one-sided dead term is a DEFECT, not blindness`,
      );
      const folded = evaluate(impl, { column });
      assert.equal(
        folded.exitCode,
        EXIT_CODE.FAIL,
        `${dead}-dead: must be FAIL, got ${folded.verdict}`,
      );
      assert.ok(
        folded.failures.some((f) =>
          f.includes("modulationEngaged_on_both_backends"),
        ),
        `${dead}-dead: the failure must NAME the side that went inert, not be ` +
          `implied by an out-of-band ratio`,
      );
    }
  },
  "the per-backend engagement flags distinguish blindness from a one-sided defect":
    (impl) => {
      const bothDead = impl.evaluateStarModulationLane(
        columnLane({
          perMode: {
            "modulation-off": healthyMode({ webglMean: 0.3, webgpuMean: 0.3 }),
            "modulation-on": healthyMode({ webglMean: 0.3, webgpuMean: 0.3 }),
          },
        }),
      );
      assert.equal(bothDead.glModulationEngaged, false);
      assert.equal(bothDead.gpuModulationEngaged, false);
      assert.equal(bothDead.structural, true);

      const oneDead = impl.evaluateStarModulationLane(
        columnLane({
          perMode: {
            "modulation-off": healthyMode({ webglMean: 0.3, webgpuMean: 0.1 }),
            "modulation-on": healthyMode({ webglMean: 0.1, webgpuMean: 0.1 }),
          },
        }),
      );
      assert.equal(oneDead.glModulationEngaged, true);
      assert.equal(oneDead.gpuModulationEngaged, false);
      assert.equal(oneDead.structural, false);
    },

  // ---- AUDIT ITEM 5: the CERTIFYING mode needs the blindness rule too ------
  //
  // Every criterion the cubemap lane folds into its verdict is measured on the
  // certifying mode. `ratio()` returns null when the WebGL denominator is 0, and
  // `null >= 0.9` / `inBand(null)` are both false, so a doubly-blind certifying
  // mode produced four confident FALSE criteria and exit 1 — a phantom defect
  // over a scene where no source was censused at all.
  "the CERTIFYING cubemap mode blank on BOTH backends is STRUCTURAL, never a verdict":
    (impl) => {
      const lane = cubemapLane();
      lane.perMode.default = healthyMode({
        webglLitPixels: 0,
        webgpuLitPixels: 0,
        litPixelRatio: null,
        m2aRatio: null,
        m2bRatio: null,
        m3ChromaRatio: null,
      });
      const folded = evaluate(impl, { cubemap: lane });
      assert.equal(
        folded.exitCode,
        EXIT_CODE.STRUCTURAL,
        `a doubly-blank certifying mode must not produce a verdict, got ${folded.verdict}`,
      );
      assert.notEqual(folded.exitCode, EXIT_CODE.PASS);
      assert.notEqual(folded.exitCode, EXIT_CODE.FAIL);
      assert.equal(folded.failures.length, 0);
      assert.ok(
        folded.structural.some((s) => s.includes(CUBEMAP_CERTIFYING_MODE)),
        "the blank CERTIFYING mode must be named in structural[]",
      );
    },
  "the CERTIFYING cubemap mode blank on ONE backend is a real FAIL": (impl) => {
    const lane = cubemapLane();
    lane.perMode.default = healthyMode({
      webglLitPixels: 40000,
      webgpuLitPixels: 0,
      litPixelRatio: 0,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(
      folded.exitCode,
      EXIT_CODE.FAIL,
      `one-sided darkness on the certifying mode is the defect, got ${folded.verdict}`,
    );
    assert.ok(
      folded.failures.some((f) => f.includes("litPixelRatio")),
      "the lit-extent criterion must be named in failures[]",
    );
  },
  "a real defect outranks a structural lane": (impl) => {
    const lane = cubemapLane();
    lane.perMode.default = healthyMode({ m2aRatio: 2.0 });
    const column = columnLane({ skyBrightness: { webgl: 0, webgpu: 0 } });
    const folded = evaluate(impl, { cubemap: lane, column });
    assert.equal(
      folded.exitCode,
      EXIT_CODE.FAIL,
      "a measurable defect must not be downgraded to STRUCTURAL",
    );
    assert.ok(folded.structural.length > 0, "but the blindness is still named");
  },

  // ---- ITEM 1: the summary carries both attribution factors ---------------
  "the printed summary carries BOTH m2a attribution factors": (impl) => {
    const summary = impl.buildG1Summary(evaluate(impl, {}));
    const text = JSON.stringify(summary);
    for (const laneKey of [
      "orbital-cubemap-parity",
      "in-column-star-modulation",
    ]) {
      const lane = summary.lanes[laneKey];
      assert.ok(lane, `${laneKey} must appear in the summary`);
      for (const [mode, m] of Object.entries(lane.perMode)) {
        assert.ok(
          Object.hasOwn(m, "meanLumRatio"),
          `${laneKey}/${mode} must report the mean factor`,
        );
        assert.ok(
          Object.hasOwn(m, "stddevRatio"),
          `${laneKey}/${mode} must report the sigma factor`,
        );
        assert.ok(
          Object.hasOwn(m, "m2aRatio"),
          `${laneKey}/${mode} must still report m2aRatio itself`,
        );
      }
    }
    // Belt and braces: the strings must actually be in the printed payload,
    // because that payload is what a human reads when the gate goes red.
    assert.match(text, /"meanLumRatio"/);
    assert.match(text, /"stddevRatio"/);
  },
  "the summary states the M2e tolerance and the reachability threshold": (
    impl,
  ) => {
    const summary = impl.buildG1Summary(evaluate(impl, {}));
    assert.equal(summary.skyFloorAbsTolerance, ONE_CODE);
    assert.equal(
      summary.starModulationSkyBrightnessThreshold,
      STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
    );
  },
  "the summary reports the absolute sky-floor delta, not just the floors": (
    impl,
  ) => {
    const lane = cubemapLane();
    lane.perMode.default = healthyMode({ webgpuSkyFloor: TWO_CODES });
    const summary = impl.buildG1Summary(evaluate(impl, { cubemap: lane }));
    const mode = summary.lanes["orbital-cubemap-parity"].perMode.default;
    assert.ok(Math.abs(mode.skyFloorAbsDelta - TWO_CODES) < 1e-12);
  },
};

// ---------------------------------------------------------------------------
// MUTANTS — the plausible wrong implementation of each repair.
// ---------------------------------------------------------------------------

const MUTANTS = {
  // ITEM 2 mutants.
  "M2e as a ratio in the parity band": {
    ...REAL,
    skyFloorAgrees: (gl, gpu) => inBand(ratio(gpu, gl)),
  },
  "M2e tolerance loosened to two code values": {
    ...REAL,
    SKY_FLOOR_ABS_TOLERANCE: TWO_CODES,
    skyFloorAgrees: (gl, gpu) => Math.abs(gpu - gl) <= TWO_CODES,
  },
  "M2e tolerance fitted to a measurement": {
    ...REAL,
    SKY_FLOOR_ABS_TOLERANCE: 0.01,
    skyFloorAgrees: (gl, gpu) => Math.abs(gpu - gl) <= 0.01,
  },
  "M2e reported but not gated (the pre-repair shape)": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      delete evaluated.criteria.default_m2e_skyFloor_within_quantization;
      return evaluated;
    },
  },

  // ITEM 3 mutants.
  "framingReached on the solar-elevation proxy (the pre-repair shape)": {
    ...REAL,
    computeFramingReached: (_sky, lane) => (lane?.sunElevationDeg ?? 90) >= 25,
    evaluateStarModulationLane: (lane) => {
      const evaluated = evaluateStarModulationLane(lane);
      const framingReached = (lane.sunElevationDeg?.webgl ?? 90) >= 25;
      return {
        ...evaluated,
        framingReached,
        structural: !framingReached || !evaluated.modulationEngaged,
      };
    },
  },
  "framingReached satisfied by EITHER backend": {
    ...REAL,
    computeFramingReached: (sky) =>
      (sky?.webgl ?? 0) > STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD ||
      (sky?.webgpu ?? 0) > STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
  },
  "framingReached treats an absent measurement as reached": {
    ...REAL,
    computeFramingReached: (sky) =>
      !(sky?.webgl <= STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD) &&
      !(sky?.webgpu <= STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD),
  },
  "an unreachable lane reported as PASS (the false green)": {
    ...REAL,
    foldG1Verdict: (lanes) => {
      const folded = foldG1Verdict(lanes);
      return folded.verdict === "STRUCTURAL"
        ? { ...folded, verdict: "PASS", exitCode: EXIT_CODE.PASS }
        : folded;
    },
  },
  "an unreachable lane reported as FAIL (the phantom defect)": {
    ...REAL,
    foldG1Verdict: (lanes) => {
      const folded = foldG1Verdict(lanes);
      return folded.verdict === "STRUCTURAL"
        ? { ...folded, verdict: "FAIL", exitCode: EXIT_CODE.FAIL }
        : folded;
    },
  },
  "no non-vacuity control on the modulation term": {
    ...REAL,
    evaluateStarModulationLane: (lane) => {
      const evaluated = evaluateStarModulationLane(lane);
      return {
        ...evaluated,
        modulationEngaged: true,
        structural: !evaluated.framingReached,
      };
    },
  },
  "star-modulation certified on the ON-state ratio alone": {
    ...REAL,
    evaluateStarModulationLane: (lane) => {
      const on = lane.perMode["modulation-on"];
      const criteria = {
        modulationOn_meanLumRatio_in_band: inBand(on.meanLumRatio),
      };
      return {
        ...lane,
        framingReached: computeFramingReached(lane.skyBrightness),
        modulationEngaged: true,
        structural: false,
        criteria,
        pass: Object.values(criteria).every(Boolean),
      };
    },
  },
  "a blank split mode scored as a defect": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      for (const mode of evaluated.structuralModes) {
        evaluated.criteria[`${mode}_litPixelRatio_in_band`] = false;
      }
      return { ...evaluated, structuralModes: [] };
    },
  },

  // ---- CO-3 mutants — the plausible wrong re-scopes ------------------------
  "the DR-01 seam asserted with NO not-blank control (the false green)": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      // Keeps the zero-census assertion, drops everything that would notice the
      // frame is empty. This is the shape a hurried re-scope produces.
      const criteria = { ...evaluated.criteria };
      delete criteria.cubemapOnly_litPixelRatio_in_band;
      delete criteria.cubemapOnly_peakLuminance_within_quantization;
      const structuralModes = evaluated.structuralModes.filter(
        (m) => m !== "cubemap-only",
      );
      criteria[
        `cubemapOnly_dr01_resolvedSources_le_${DR01_LIVE_MAX_RESOLVED_SOURCES}`
      ] = true;
      return {
        ...evaluated,
        criteria,
        structuralModes,
        pass: !evaluated.certifyingModeBlank,
      };
    },
  },
  "the census loosened toward a brightness threshold (EXPLICITLY PROHIBITED)": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      // The forbidden move: stop asserting the seam and go back to comparing
      // COUNTS between the backends. A cube map that regained every star scores
      // a perfect 1.0 count ratio and sails through.
      const criteria = { ...evaluated.criteria };
      delete criteria[
        `cubemapOnly_dr01_resolvedSources_le_${DR01_LIVE_MAX_RESOLVED_SOURCES}`
      ];
      const m = (lane.perMode ?? {})["cubemap-only"] ?? {};
      criteria.cubemapOnly_m1CountRatio_ge_0_90 = !(m.m1CountRatio < 0.9);
      return {
        ...evaluated,
        criteria,
        pass:
          !evaluated.certifyingModeBlank &&
          Object.values(criteria).every(Boolean),
      };
    },
  },
  "the sprite pass still certified on the retired M1 count ratio": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      const m = (lane.perMode ?? {})["sprites-only"] ?? {};
      const criteria = {
        ...evaluated.criteria,
        // At HEAD this is 0/0 -> null -> a confident false on a healthy scene:
        // exactly the phantom defect the re-scope exists to remove.
        spritesOnly_m1CountRatio_ge_0_90: m.m1CountRatio >= 0.9,
      };
      return {
        ...evaluated,
        criteria,
        pass:
          !evaluated.certifyingModeBlank &&
          Object.values(criteria).every(Boolean),
      };
    },
  },
  "sprite chroma scored as 0/0 instead of dropped": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      const m = (lane.perMode ?? {})["sprites-only"] ?? {};
      const criteria = {
        ...evaluated.criteria,
        spritesOnly_chromaRatio_ge_0_85: m.m3ChromaRatio >= 0.85,
      };
      return {
        ...evaluated,
        criteria,
        structuralNotes: [],
        pass:
          !evaluated.certifyingModeBlank &&
          Object.values(criteria).every(Boolean),
      };
    },
  },

  // AUDIT ITEM 4 mutants — the non-vacuity control at the wrong scope.
  "modulation non-vacuity ANDs the two backends (the shipped pre-repair shape)":
    {
      ...REAL,
      evaluateStarModulationLane: (lane) => {
        const evaluated = evaluateStarModulationLane(lane);
        // Verbatim reconstruction of the pre-repair arithmetic: EITHER side
        // going dead declares the whole lane blind.
        const structural =
          !evaluated.framingReached || !evaluated.modulationEngaged;
        const criteria = { ...evaluated.criteria };
        delete criteria.modulationEngaged_on_both_backends;
        return {
          ...evaluated,
          structural,
          criteria,
          pass: !structural && Object.values(criteria).every(Boolean),
        };
      },
    },
  "one-sided modulation death implied only by an out-of-band ratio": {
    ...REAL,
    evaluateStarModulationLane: (lane) => {
      const evaluated = evaluateStarModulationLane(lane);
      // Keeps the FAIL but drops the criterion that says WHICH side went
      // inert, so the report cannot be attributed.
      const criteria = {
        ...evaluated.criteria,
        modulationEngaged_on_both_backends: true,
      };
      return {
        ...evaluated,
        criteria,
        pass: !evaluated.structural && Object.values(criteria).every(Boolean),
      };
    },
  },

  // AUDIT ITEM 5 mutants — the blindness rule skipping the certifying mode.
  "the certifying mode's criteria built unconditionally (the pre-repair shape)":
    {
      ...REAL,
      evaluateCubemapParityLane: (lane) => {
        const modes = lane.perMode ?? {};
        const def = modes.default ?? {};
        const criteria = {
          default_m1CountRatio_ge_0_90: def.m1CountRatio >= 0.9,
          default_m2a_in_band: inBand(def.m2aRatio),
          default_m2b_in_band: inBand(def.m2bRatio),
          default_m3Chroma_ge_0_85: def.m3ChromaRatio >= 0.85,
          default_m2e_skyFloor_within_quantization: skyFloorAgrees(
            def.webglSkyFloor,
            def.webgpuSkyFloor,
          ),
        };
        const structuralModes = [];
        for (const mode of lane.countModes ?? []) {
          if (modeIsBlind(modes[mode])) {
            structuralModes.push(mode);
            continue;
          }
          criteria[
            `${mode.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase())}_m1CountRatio_ge_0_90`
          ] = modes[mode]?.m1CountRatio >= 0.9;
        }
        return {
          ...lane,
          criteria,
          structuralModes,
          framingReached: computeFramingReached(lane.skyBrightness),
          pass: Object.values(criteria).every(Boolean),
        };
      },
    },
  "a blank certifying mode reported as PASS (the false green)": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      if (!evaluated.certifyingModeBlank) {
        return evaluated;
      }
      return {
        ...evaluated,
        certifyingModeBlank: false,
        structuralModes: evaluated.structuralModes.filter(
          (m) => m !== CUBEMAP_CERTIFYING_MODE,
        ),
        pass: true,
      };
    },
  },
  "ANY dark backend declares the certifying mode blank (the over-correction)": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      const def = (lane.perMode ?? {}).default ?? {};
      const blank =
        (def.webglLitPixels ?? 0) === 0 || (def.webgpuLitPixels ?? 0) === 0;
      if (!blank) {
        return evaluated;
      }
      return {
        ...evaluated,
        certifyingModeBlank: true,
        criteria: {},
        structuralModes: [
          ...new Set([...evaluated.structuralModes, CUBEMAP_CERTIFYING_MODE]),
        ],
        pass: false,
      };
    },
  },

  // ITEM 1 mutants.
  "summary omits the sigma factor (the pre-repair shape)": {
    ...REAL,
    buildG1Summary: (result) => {
      const summary = buildG1Summary(result);
      for (const lane of Object.values(summary.lanes)) {
        for (const mode of Object.values(lane?.perMode ?? {})) {
          delete mode.stddevRatio;
        }
      }
      return summary;
    },
  },
  "summary omits the mean factor": {
    ...REAL,
    buildG1Summary: (result) => {
      const summary = buildG1Summary(result);
      for (const lane of Object.values(summary.lanes)) {
        for (const mode of Object.values(lane?.perMode ?? {})) {
          delete mode.meanLumRatio;
        }
      }
      return summary;
    },
  },
  "summary omits the sky-floor delta": {
    ...REAL,
    buildG1Summary: (result) => {
      const summary = buildG1Summary(result);
      for (const lane of Object.values(summary.lanes)) {
        for (const mode of Object.values(lane?.perMode ?? {})) {
          delete mode.skyFloorAbsDelta;
        }
      }
      return summary;
    },
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

for (const [name, rule] of Object.entries(RULES)) {
  test(name, () => rule(REAL));
}

// One subtest per mutant, so the run itself is the evidence that every wrong
// implementation is caught — an aggregate assertion would hide which ones.
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
      `this wrong implementation passed every rule — the rules do not constrain it`,
    );
  });
}

// ---------------------------------------------------------------------------
// ITEM 4 — capture ordering and settle, pinned in the probe source.
// ---------------------------------------------------------------------------

test("settle is a wall-clock budget covering the measured compile cost", () => {
  const match = PROBE.match(/const SETTLE_BUDGET_MS = (\d+);/);
  assert.ok(match, "SETTLE_BUDGET_MS must exist");
  assert.ok(
    Number(match[1]) >= 2674,
    `settle budget ${match[1]} ms is below the measured 2674 ms async pipeline compile`,
  );
  // The yield must be setTimeout, not requestAnimationFrame: a starved rAF in a
  // headless browser would silently shorten the budget.
  assert.match(
    PROBE,
    /await new Promise\(\(r\) => setTimeout\(r, settleYieldMs\)\)/,
  );
  assert.doesNotMatch(PROBE, /const SETTLE_FRAMES = /);
});

test("every capture is preceded by a discarded warm-up capture", () => {
  assert.match(PROBE, /WARM-UP CAPTURE/);
  assert.match(
    PROBE,
    /const warmupFrames = await settle\(\);\s*\n\s*grab\(\);/,
  );
  assert.match(PROBE, /warmupDiscarded: true/);
  // The warm-up must come BEFORE the measured capture.
  assert.ok(
    PROBE.indexOf("const warmupFrames = await settle();") <
      PROBE.indexOf("const full = grab();"),
  );
});

test("the certifying mode is captured LAST, not against the coldest cache", () => {
  const match = PROBE.match(/const G1_MODE_CAPTURE_ORDER = \[([^\]]+)\]/);
  assert.ok(match, "the capture order must be an explicit named constant");
  const order = match[1]
    .split(",")
    .map((s) => s.trim().replaceAll('"', ""))
    .filter(Boolean);
  assert.deepEqual(order, ["cubemap-only", "sprites-only", "default"]);
  assert.equal(
    order.at(-1),
    "default",
    "the only certifying mode must not be captured first",
  );
  assert.match(PROBE, /const G1_CERTIFYING_MODE = "default";/);
});

test("the probe reaches the shared gate lib rather than re-deriving it", () => {
  assert.match(PROBE, /from "\.\/lib\/celestial-g1-gate\.mjs"/);
  assert.match(PROBE, /buildG1Summary\(result\)/);
  assert.match(PROBE, /exitCode = result\.exitCode;/);
  // The proxy assertion must be gone from the probe's executable body.
  assert.doesNotMatch(PROBE_CODE, /sunElevationDeg >= 25/);
  assert.doesNotMatch(PROBE_CODE, /framingReached =\s*$/m);
});

test("the in-column lane exists and sits inside the atmospheric column", () => {
  const match = PROBE.match(/const IN_COLUMN_HEIGHT_M = (\d+);/);
  assert.ok(match, "the in-column lane needs an explicit camera height");
  assert.ok(
    Number(match[1]) < 60000,
    "camera must be below ATMOSPHERIC_COLUMN_FADE_START (60 km) or the column factor zeroes skyBrightness",
  );
  assert.match(PROBE, /id: "in-column-star-modulation"/);
  // The lane must turn the sky atmosphere ON — CubeMapPanorama gates the whole
  // star-modulation term on frameState.skyAtmosphereVisible === true.
  assert.match(PROBE, /skyAtmosphereOn: true/);
  assert.match(PROBE, /const COLUMN_MODE_CAPTURE_ORDER = \[/);
});

test("the engine constants the lane design depends on are still true", () => {
  const skyBrightness = readNormalized(
    "packages/engine/Source/Scene/SkyBrightness.js",
  );
  assert.match(
    skyBrightness,
    /const ATMOSPHERIC_COLUMN_FADE_START = 60000\.0;/,
  );
  assert.match(skyBrightness, /const ATMOSPHERIC_COLUMN_FADE_END = 111000\.0;/);
  assert.match(
    skyBrightness,
    /return clamped \* computeAtmosphericColumnFactor\(cameraHeight\);/,
  );
  const panorama = readNormalized(
    "packages/engine/Source/Scene/CubeMapPanorama.js",
  );
  assert.match(panorama, /frameState\.skyAtmosphereVisible === true;/);
});

test("the DR-01 re-scope did NOT lower the point-source census floor", () => {
  // The explicit prohibition, recorded at Batch 848 and repeated in
  // `PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS`: lowering the floor puts
  // candidates back inside the diffuse band's own 8-bit range and re-creates
  // the brightness count the census replaced. Asserted against SOURCE TEXT,
  // because the only way to break it is to pass a `threshold` override at a
  // call site — which no amount of fixture-driven testing can see.
  const metrics = readNormalized(
    "Tools/visual-regression/lib/celestial-metrics.mjs",
  );
  assert.match(
    metrics,
    /const threshold = options\.threshold \?\? 12 \/ 255;/,
    "the shipped M1 default floor moved",
  );
  const census = readNormalized("Tools/skybox-bake/starmap-census.mjs");
  assert.match(
    census,
    /minPeak: 40,/,
    "the shared detector's minPeak moved — the sibling probe's scope note is now false",
  );
  // No caller in the celestial fleet may hand a detector a lowered floor. This
  // is a TRIPWIRE on the literal option names, not a proof — it catches the
  // edit somebody would actually make (`{ threshold: 6 / 255 }`) rather than
  // every conceivable indirection.
  for (const rel of [
    "Tools/visual-regression/probe-celestial-gates.mjs",
    "Tools/visual-regression/lib/celestial-source-split.mjs",
    "Tools/visual-regression/lib/celestial-g1-gate.mjs",
  ]) {
    const src = readNormalized(rel);
    for (const option of ["threshold", "peakRatio", "minPeak", "minContrast"]) {
      assert.doesNotMatch(
        src,
        new RegExp(String.raw`\b${option}\s*:\s*[0-9(]`),
        `${rel} passes a ${option} override — the census floor may not be re-tuned`,
      );
    }
  }
});

test("the probe declares a role for every Lane-A mode", () => {
  // A mode with no role silently falls back to the composite criteria, which
  // would drop the DR-01 seam assertion without anything going red.
  const match = PROBE.match(
    /const G1_MODE_ROLES = Object\.freeze\(\{([^}]*)\}/,
  );
  assert.ok(match, "G1_MODE_ROLES must be an explicit named constant");
  for (const mode of ["default", "cubemap-only", "sprites-only"]) {
    assert.ok(
      match[1].includes(mode),
      `mode ${mode} has no declared post-DR-01 role`,
    );
  }
  assert.match(PROBE, /modeRoles: G1_MODE_ROLES/);
});

test("the non-vacuity floor is derived from quantization, not from brightness", () => {
  // Absolute, and equal to the instrument's own resolution. A RELATIVE floor
  // would be a floor on star-energy-over-sky-energy, so a brighter atmosphere
  // shell — which this lane REQUIRES in order to reach the failure state — could
  // push the lane structural for a reason unrelated to the modulation term.
  assert.equal(MODULATION_ENGAGED_MIN_ABS_DELTA, ONE_CODE);
  const bright = columnLane({
    perMode: {
      "modulation-off": healthyMode({ webglMean: 0.9, webgpuMean: 0.9 }),
      "modulation-on": healthyMode({
        webglMean: 0.9 - 0.005,
        webgpuMean: 0.9 - 0.005,
      }),
    },
  });
  const evaluated = evaluateStarModulationLane(bright);
  assert.equal(
    evaluated.modulationEngaged,
    true,
    "a 0.005 swing on a 0.9 mean is 0.6% relative — a 2% relative floor would have called this dead",
  );
  assert.equal(evaluated.structural, false);
});
