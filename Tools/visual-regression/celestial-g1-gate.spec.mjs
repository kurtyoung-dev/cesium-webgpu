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
  EXIT_CODE,
  MODULATION_ENGAGED_MIN_ABS_DELTA,
  SKY_FLOOR_ABS_TOLERANCE,
  STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
  buildG1Summary,
  computeFramingReached,
  evaluateCubemapParityLane,
  evaluateStarModulationLane,
  foldG1Verdict,
  inBand,
  ratio,
  skyFloorAgrees,
} from "./lib/celestial-g1-gate.mjs";

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
  ...over,
});

const cubemapLane = (over = {}) => ({
  id: "orbital-cubemap-parity",
  role: "cubemap + sprite parity",
  // The real orbital camera: sun at the zenith, sky brightness identically 0.
  skyBrightness: { webgl: 0, webgpu: 0 },
  sunElevationDeg: { webgl: 90, webgpu: 90 },
  countModes: ["cubemap-only", "sprites-only"],
  perMode: {
    default: healthyMode(),
    "cubemap-only": healthyMode(),
    "sprites-only": healthyMode(),
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
  "a count mode blind on BOTH backends is STRUCTURAL, not FAIL": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthyMode({
      webglM1Count: 0,
      webgpuM1Count: 0,
      m1CountRatio: null,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.STRUCTURAL);
    assert.equal(folded.failures.length, 0);
    assert.ok(folded.structural.some((s) => s.includes("sprites-only")));
  },
  "a count mode blind on ONE backend is a real FAIL": (impl) => {
    const lane = cubemapLane();
    lane.perMode["sprites-only"] = healthyMode({
      webglM1Count: 55,
      webgpuM1Count: 0,
      m1CountRatio: 0,
    });
    const folded = evaluate(impl, { cubemap: lane });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
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
  "a blind count mode scored as a defect": {
    ...REAL,
    evaluateCubemapParityLane: (lane) => {
      const evaluated = evaluateCubemapParityLane(lane);
      for (const mode of evaluated.structuralModes) {
        evaluated.criteria[`${mode}_m1CountRatio_ge_0_90`] = false;
      }
      return { ...evaluated, structuralModes: [] };
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
