// gsplat-harness.spec.mjs — browser-free guard for the C15-G1 Gaussian-splat
// probe harness.
//
// The thing this pins is a GATE, so a spec that only exercised the correct
// implementation would be worth nothing — the WRONG implementation also
// "passes", it just passes vacuously. Every rule below is stated once and run
// twice: against the real `lib/gsplat-parity-model.mjs`, and against a battery
// of MUTANTS, each the plausible wrong implementation somebody would actually
// write while "simplifying" the dual-mode logic. Each mutant must be caught by
// at least one rule.
//
// The three vacuity modes this exists to prevent, all silent:
//
//   * absence keeps printing "expected" AFTER --expect-webgpu is on, so the row
//     that was supposed to prove splats appeared exits 0 having proved nothing;
//   * presence arrives while the probe is still in default mode and the run
//     goes green on a contract that no longer describes the product;
//   * the parity leg diffs two BLANK canvases and prints 0.000% — the best
//     score the gate can produce, for a renderer that drew nothing.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ABSENCE_BLOCKERS,
  ABSENT_MARKER,
  ASSETS,
  EXIT_CODE,
  PREDICT,
  PRESENT_MARKER,
  STAGE,
  STRUCTURAL_PRECONDITIONS,
  classifyWebgpuPresence,
  evaluateParity,
  evaluateReferenceLeg,
  evaluateWebgpuLeg,
  foldGsplatVerdict,
  fractionOf,
  precheckPreconditions,
  recognizedBlockers,
} from "./lib/gsplat-parity-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const readNormalized = (relative) =>
  readFileSync(resolve(ROOT, relative), "utf8").replaceAll("\r\n", "\n");

const PROBE_PATH = "Tools/visual-regression/probe-gsplat-parity.mjs";
const PROBE = readNormalized(PROBE_PATH);
// Executable lines only. The header deliberately NAMES things in prose (the
// absent marker, the flip flag), so an assertion about code has to look at
// code, not at the comment explaining it.
const PROBE_CODE = PROBE.split("\n")
  .filter((line) => !line.trimStart().startsWith("*"))
  .filter((line) => !line.trimStart().startsWith("//"))
  .filter((line) => !line.trimStart().startsWith("/*"))
  .join("\n");

const CANVAS_PIXELS = 1024 * 768;

// ── Fixtures ────────────────────────────────────────────────────────────────
// Deliberately built from the numbers the probe actually reports, so a change
// to the record shape breaks the fixtures rather than quietly making every
// rule test an object the probe no longer produces.

function preconditionsHealthy(overrides = {}) {
  return {
    navigationOk: true,
    passEnumOk: true,
    passGaussianSplats: 12,
    tilesetFetchOk: true,
    tilesetFetchStatus: 200,
    contentReady: true,
    contentReadyMs: 3_200,
    canvasPixels: CANVAS_PIXELS,
    framing: { centerOnScreen: true, radiusPx: 400 },
    captureLivenessForeground: CANVAS_PIXELS,
    captureLivenessMean: [64, 128, 192],
    backgroundForeground: 0,
    determinismChanged: 0,
    negativeControlChanged: 0,
    errors: [],
    ...overrides,
  };
}

/** A healthy WebGL reference leg on `sh_unit_cube`. */
function referenceLane(overrides = {}) {
  return {
    requested: "webgl",
    rendererType: "webgl",
    ...preconditionsHealthy(),
    dataReady: true,
    dataReadyMs: 5_400,
    dataBudgetMs: PREDICT.dataReadyBudgetMs,
    numSplats: 27,
    isStable: true,
    indexesLength: 27,
    splatPassCommands: 1,
    commandListSplatCommands: 1,
    absenceBlockers: [],
    added: {
      changed: Math.round(CANVAS_PIXELS * 0.045),
      edgeFraction: 0.08,
      luminanceStdDev: 32,
    },
    ...overrides,
  };
}

/** The WebGPU leg as HEAD actually behaves: nothing, for named reasons. */
function webgpuAbsentLane(overrides = {}) {
  return {
    requested: "webgpu",
    rendererType: "webgpu",
    ...preconditionsHealthy(),
    // POST-C15-G2 SHAPE. The splat data pipeline now runs above the backend
    // branch, so the WebGPU leg commits the same snapshot the WebGL leg does:
    // `numSplats`/`indexesLength`/`isStable`/`dataReady` all read like the
    // reference. What is still missing is the WebGPU-side buffer, which is why
    // `cacheSplatCount` is 0 (not `null` — the renderer now gets past its
    // visibility guard and allocates the cache) and nothing is drawn.
    dataReady: true,
    dataReadyMs: 6_800,
    dataBudgetMs: 30_000,
    numSplats: 27,
    isStable: true,
    indexesLength: 27,
    splatPassCommands: 0,
    commandListSplatCommands: 0,
    cacheSplatCount: 0,
    featureRendererKind: "ready",
    absenceBlockers: ["no-splat-data-fields", "cache-splat-count-zero"],
    added: {
      changed: 0,
      edgeFraction: Number.NaN,
      luminanceStdDev: Number.NaN,
    },
    ...overrides,
  };
}

/** The post-C15-G3 world: WebGPU renders splats. */
function webgpuPresentLane(overrides = {}) {
  return {
    ...webgpuAbsentLane(),
    dataReady: true,
    dataReadyMs: 6_100,
    numSplats: 27,
    isStable: true,
    indexesLength: 27,
    splatPassCommands: 1,
    commandListSplatCommands: 1,
    cacheSplatCount: 27,
    absenceBlockers: [],
    added: {
      changed: Math.round(CANVAS_PIXELS * 0.044),
      edgeFraction: 0.079,
      luminanceStdDev: 31,
    },
    ...overrides,
  };
}

const ASSET = ASSETS.sh_unit_cube;

/**
 * The `C15-G2` stage, frozen as a FIXTURE.
 *
 * `C15-G3` retired the last two named blockers, so the SHIPPED `STAGE.required`
 * is now empty and default mode can no longer certify anything. That is the
 * right product behaviour and it is pinned below — but if the stage machinery
 * were only ever exercised against the shipped stage, every rule that tests the
 * both-directions blocker contract would go VACUOUS the moment `required`
 * emptied: loops over an empty array assert nothing and still report green.
 *
 * So the mechanism keeps being tested against a non-empty stage forever, and
 * the shipped stage is pinned separately. This is why `evaluateWebgpuLeg`
 * takes `options.stage` at all.
 */
const G2_STAGE = Object.freeze({
  id: "C15-G2",
  retired: Object.freeze([
    "primitive-show-undefined",
    "primitive-numsplats-zero",
  ]),
  required: Object.freeze(["no-splat-data-fields", "cache-splat-count-zero"]),
  parity: Object.freeze({
    scored: false,
    deferredTo: "C15-G5",
    reason: "fixture",
  }),
});

/**
 * A stage whose parity leg IS a gate — the `C15-G5`+ shape. Used to keep the
 * threshold arithmetic under test while `C15-G3` ships with parity recorded
 * rather than gated.
 */
const PARITY_SCORED_STAGE = Object.freeze({
  ...G2_STAGE,
  id: "C15-G5-fixture",
  parity: Object.freeze({ scored: true, deferredTo: null, reason: "fixture" }),
});

const REAL = Object.freeze({
  precheckPreconditions,
  classifyWebgpuPresence,
  evaluateReferenceLeg,
  evaluateWebgpuLeg,
  evaluateParity,
  foldGsplatVerdict,
});

// ── Rules ───────────────────────────────────────────────────────────────────
// Each rule takes the implementation under test, so the mutant battery can
// swap one function and re-run every rule against it.

const RULES = {
  "absence under --expect-webgpu is a product FAIL, not a marker": (impl) => {
    const leg = impl.evaluateWebgpuLeg(webgpuAbsentLane(), ASSET, PREDICT, {
      expectWebgpu: true,
    });
    assert.equal(leg.presence.state, "absent");
    assert.ok(
      leg.failures.length > 0,
      "the flip must turn the documented absence into a real failure",
    );
    assert.equal(
      leg.notes.length,
      0,
      "the expected-absence marker must not survive the flip",
    );
    const folded = impl.foldGsplatVerdict({
      reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
      webgpu: leg,
    });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
  },

  "absence in default mode is green AND carries the greppable marker": (
    impl,
  ) => {
    const leg = impl.evaluateWebgpuLeg(webgpuAbsentLane(), ASSET, PREDICT, {
      expectWebgpu: false,
      stage: G2_STAGE,
    });
    assert.equal(leg.failures.length, 0);
    assert.equal(leg.structural.length, 0);
    assert.equal(leg.notes.length, 1);
    assert.match(
      leg.notes[0],
      /WEBGPU-SPLATS-ABSENT \(expected until C15-G3\)/,
    );
    const folded = impl.foldGsplatVerdict({
      reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
      webgpu: leg,
    });
    assert.equal(folded.exitCode, EXIT_CODE.PASS);
    assert.ok(folded.notes.some((note) => note.includes(ABSENT_MARKER)));
  },

  "an absence nobody can attribute is STRUCTURAL, never green": (impl) => {
    const leg = impl.evaluateWebgpuLeg(
      webgpuAbsentLane({ absenceBlockers: [] }),
      ASSET,
      PREDICT,
      { expectWebgpu: false, stage: G2_STAGE },
    );
    assert.equal(leg.notes.length, 0, "no marker without an attribution");
    // The REASON is asserted, not merely "something was structural": an
    // implementation that manufactures blockers and then trips a different
    // structural check would otherwise satisfy a bare length assertion while
    // having invented the attribution this rule exists to forbid.
    assert.ok(
      leg.structural.some((item) => /absence-unattributed/.test(item)),
      `expected absence-unattributed; got ${JSON.stringify(leg.structural)}`,
    );
    assert.equal(
      impl.foldGsplatVerdict({
        reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
        webgpu: leg,
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
  },

  "a blocker name the model does not recognize is not an attribution": (
    impl,
  ) => {
    const leg = impl.evaluateWebgpuLeg(
      webgpuAbsentLane({ absenceBlockers: ["vibes"] }),
      ASSET,
      PREDICT,
      { expectWebgpu: false, stage: G2_STAGE },
    );
    assert.equal(leg.notes.length, 0);
    assert.ok(leg.structural.some((item) => /absence-unattributed/.test(item)));
  },

  "the SHARED data commit is not evidence the WebGPU renderer did anything": (
    impl,
  ) => {
    // The C15-G2 trap. Before the scene-logic extraction, `_numSplats > 0` on
    // the WebGPU leg could only mean the WebGPU path had run. It is now the
    // shared snapshot commit and reads 286,868 on a leg that drew nothing — so
    // a classifier that still folds it in scores every healthy post-G2 run
    // "ambiguous" and exits 3 on a working engine.
    const lane = webgpuAbsentLane({
      numSplats: ASSETS.tower.expectedSplats,
      indexesLength: ASSETS.tower.expectedSplats,
      cacheSplatCount: 0,
      splatPassCommands: 0,
    });
    const presence = impl.classifyWebgpuPresence(lane, PREDICT);
    assert.equal(
      presence.state,
      "absent",
      "a populated SHARED snapshot with no renderer cache, no command and no pixels is ABSENT",
    );
    assert.equal(presence.dataCommitted, false);
    const leg = impl.evaluateWebgpuLeg(lane, ASSETS.tower, PREDICT, {
      expectWebgpu: false,
      stage: G2_STAGE,
    });
    assert.equal(leg.structural.length, 0);
    assert.equal(leg.notes.length, 1);
  },

  "a blocker C15-G2 retired, observed again, is a REGRESSION not an attribution":
    (impl) => {
      for (const retired of G2_STAGE.retired) {
        const leg = impl.evaluateWebgpuLeg(
          webgpuAbsentLane({
            absenceBlockers: [...G2_STAGE.required, retired],
          }),
          ASSET,
          PREDICT,
          { expectWebgpu: false, stage: G2_STAGE },
        );
        assert.equal(
          leg.notes.length,
          0,
          `${retired} returning must not print the expected-absence marker`,
        );
        assert.ok(
          leg.structural.some((item) => /blocker-regression/.test(item)),
          `${retired} returning must be reported as a regression; got ${JSON.stringify(
            leg.structural,
          )}`,
        );
      }
    },

  "a required blocker missing means the absence has some OTHER cause": (
    impl,
  ) => {
    for (const required of G2_STAGE.required) {
      const remaining = G2_STAGE.required.filter((name) => name !== required);
      const leg = impl.evaluateWebgpuLeg(
        webgpuAbsentLane({ absenceBlockers: remaining }),
        ASSET,
        PREDICT,
        { expectWebgpu: false, stage: G2_STAGE },
      );
      assert.equal(
        leg.notes.length,
        0,
        `missing ${required} must not print the expected-absence marker`,
      );
      assert.ok(
        leg.structural.some((item) => /blocker-contract-stale/.test(item)),
        `missing ${required} must be reported as a stale contract; got ${JSON.stringify(
          leg.structural,
        )}`,
      );
    }
  },

  "the stage sets are disjoint and drawn from the declared vocabulary": (
    impl,
  ) => {
    void impl;
    for (const stage of [STAGE, G2_STAGE]) {
      for (const name of [...stage.required, ...stage.retired]) {
        assert.ok(
          ABSENCE_BLOCKERS.includes(name),
          `${stage.id}: ${name} is not in ABSENCE_BLOCKERS, so recognizedBlockers can never surface it`,
        );
      }
      for (const name of stage.required) {
        assert.ok(
          !stage.retired.includes(name),
          `${stage.id}: ${name} cannot be both required and retired`,
        );
      }
    }
    assert.ok(
      G2_STAGE.required.length > 0,
      "the stage FIXTURE must keep a non-empty required set or every " +
        "both-directions rule below loops over nothing and asserts nothing",
    );
  },

  "C15-G3 retired EVERY blocker, so default mode cannot certify at all": (
    impl,
  ) => {
    // The shipped stage, pinned. `required` empty is the contract that turns
    // default mode structural — and it must fire for the RIGHT reason. A run
    // that instead reported `absence-unattributed` would be blaming the probe
    // for a world that moved on, and one that reported `blocker-regression`
    // would be blaming the wrong row.
    assert.equal(STAGE.id, "C15-G3");
    assert.equal(STAGE.required.length, 0);
    assert.deepEqual([...STAGE.retired].sort(), [...ABSENCE_BLOCKERS].sort());

    // Absent with no blockers (a genuinely broken renderer), absent WITH a
    // retired blocker (a regression), and the healthy present case: all three
    // must refuse to be green in default mode.
    for (const blockers of [
      [],
      ["cache-splat-count-zero"],
      ["no-splat-data-fields", "cache-splat-count-zero"],
    ]) {
      const leg = impl.evaluateWebgpuLeg(
        webgpuAbsentLane({ absenceBlockers: blockers }),
        ASSET,
        PREDICT,
        { expectWebgpu: false },
      );
      assert.equal(
        leg.notes.length,
        0,
        `blockers=${JSON.stringify(blockers)} must not print an expected-absence marker`,
      );
      assert.ok(
        leg.structural.some((item) =>
          /stage-requires-expect-webgpu/.test(item),
        ),
        `blockers=${JSON.stringify(blockers)} must name the stage, not the probe; got ${JSON.stringify(
          leg.structural,
        )}`,
      );
      assert.equal(
        impl.foldGsplatVerdict({
          reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
          webgpu: leg,
        }).exitCode,
        EXIT_CODE.STRUCTURAL,
      );
    }
  },

  "under --expect-webgpu a rendering WebGPU leg passes and says so": (impl) => {
    const leg = impl.evaluateWebgpuLeg(webgpuPresentLane(), ASSET, PREDICT, {
      expectWebgpu: true,
    });
    assert.equal(leg.presence.state, "present");
    assert.deepEqual(leg.failures, []);
    assert.equal(leg.structural.length, 0);
    assert.ok(
      leg.notes.some((note) => note.includes(PRESENT_MARKER)),
      `the flip's success must be greppable; got ${JSON.stringify(leg.notes)}`,
    );
    // The criteria the row actually gates on — the reference leg's own
    // structure battery, applied to the WebGPU leg, plus count equality.
    for (const name of [
      "splatCount",
      "splatPassCommands",
      "addedPixels",
      "structureEdges",
      "structureVariance",
      "negativeControlMargin",
      "clean",
    ]) {
      assert.equal(
        leg.criteria[name],
        true,
        `${name} must be a scored criterion on the WebGPU leg`,
      );
    }
    assert.equal(
      impl.foldGsplatVerdict({
        reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
        webgpu: leg,
      }).exitCode,
      EXIT_CODE.PASS,
    );
  },

  "a rendering WebGPU leg with the WRONG splat count still FAILS": (impl) => {
    // Count equality is the half of the C15-G3 gate that the pixel metrics
    // cannot see: a decode at the wrong stride draws SOMETHING structured, and
    // a truncated commit draws a smaller but perfectly plausible cloud.
    const leg = impl.evaluateWebgpuLeg(
      webgpuPresentLane({ numSplats: ASSET.expectedSplats - 1 }),
      ASSET,
      PREDICT,
      { expectWebgpu: true },
    );
    assert.equal(leg.presence.state, "present");
    assert.ok(leg.failures.some((item) => /splatCount/.test(item)));
    assert.equal(
      leg.notes.length,
      0,
      "a failing leg must not print the marker",
    );
  },

  "C15-G3 records the parity diff but does NOT gate on it": (impl) => {
    // Both gate assets are SH degree 3 and the WGSL has no SH term until
    // C15-G5, so a cross-backend diff scores the missing view-dependent colour
    // rather than the record decode this row ships. The number is evidence,
    // not a verdict — and the thresholds must survive untouched.
    assert.equal(STAGE.parity.scored, false);
    assert.equal(STAGE.parity.deferredTo, "C15-G5");
    const parity = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      // Deliberately far ABOVE the threshold — the SH-shaped magnitude.
      mismatchFraction: ASSET.parityThresholdFraction * 12,
      asset: ASSET,
    });
    assert.equal(parity.scored, false, "parity must not be scored at C15-G3");
    assert.equal(parity.pass, null);
    assert.equal(
      parity.structural,
      null,
      "a deferred gate is not an instrument gap",
    );
    assert.equal(
      parity.mismatchFraction,
      ASSET.parityThresholdFraction * 12,
      "the measured number must still be REPORTED — it is the SH signal C15-G5 removes",
    );
    assert.match(parity.reason, /NOT\s+GATED/);
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
        parity,
      }).exitCode,
      EXIT_CODE.PASS,
    );
    // And the SAME input, at a stage where parity IS the gate, must fail —
    // otherwise "deferred" would be indistinguishable from "deleted".
    const gated = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: ASSET.parityThresholdFraction * 12,
      asset: ASSET,
      stage: PARITY_SCORED_STAGE,
    });
    assert.equal(gated.scored, true);
    assert.equal(gated.pass, false);
  },

  "a missing diff is STRUCTURAL even while parity is deferred": (impl) => {
    // Deferring the GATE must not defer the MEASUREMENT: if both legs claim
    // splats and no diff was produced, the comparison never happened and the
    // evidence this row owes C15-G5 is missing.
    const parity = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: undefined,
      asset: ASSET,
    });
    assert.equal(parity.scored, false);
    assert.equal(parity.structural, "parity:no-diff-measured");
  },

  "absence while the lazy FR never loaded is STRUCTURAL, not expected": (
    impl,
  ) => {
    for (const kind of ["loading", "failed", "unsupported", null]) {
      const leg = impl.evaluateWebgpuLeg(
        webgpuAbsentLane({ featureRendererKind: kind }),
        ASSET,
        PREDICT,
        { expectWebgpu: false, stage: G2_STAGE },
      );
      assert.equal(leg.notes.length, 0, `kind=${kind} must not print a marker`);
      assert.ok(
        leg.structural.some((item) => /feature-renderer-readiness/.test(item)),
        `kind=${kind} must report the FR readiness gap`,
      );
    }
  },

  "presence in DEFAULT mode is STRUCTURAL — a stale contract is not a pass": (
    impl,
  ) => {
    const leg = impl.evaluateWebgpuLeg(webgpuPresentLane(), ASSET, PREDICT, {
      expectWebgpu: false,
      stage: G2_STAGE,
    });
    assert.equal(leg.presence.state, "present");
    assert.equal(leg.failures.length, 0, "splats appearing is not a defect");
    assert.ok(
      leg.structural.some((item) => /absent-contract-stale/.test(item)),
    );
    assert.equal(
      impl.foldGsplatVerdict({
        reference: impl.evaluateReferenceLeg(referenceLane(), ASSET, PREDICT),
        webgpu: leg,
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
  },

  "a half-landed data path never folds into absent or present": (impl) => {
    // Data committed, no command, no pixels — exactly what a partial C15-G3
    // produces. Folding it into "absent" would let the flip gate fail for the
    // wrong reason; folding it into "present" would score parity on a blank.
    const halfLanded = webgpuAbsentLane({
      numSplats: 27,
      cacheSplatCount: 27,
      absenceBlockers: [],
    });
    assert.equal(
      impl.classifyWebgpuPresence(halfLanded, PREDICT).state,
      "ambiguous",
    );
    const lenient = impl.evaluateWebgpuLeg(halfLanded, ASSET, PREDICT, {
      expectWebgpu: false,
      stage: G2_STAGE,
    });
    assert.equal(lenient.notes.length, 0);
    assert.ok(
      lenient.structural.some((item) => /partial-splat-state/.test(item)),
    );
    const strict = impl.evaluateWebgpuLeg(halfLanded, ASSET, PREDICT, {
      expectWebgpu: true,
    });
    assert.ok(strict.failures.some((item) => /partial-splat-state/.test(item)));
  },

  "parity refuses to score a diff against a WebGPU leg with no splats": (
    impl,
  ) => {
    // Two blank canvases diff to 0.000% — the best score this gate can print.
    const parity = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "absent",
      mismatchFraction: 0.0,
      asset: ASSET,
    });
    assert.equal(parity.scored, false);
    assert.equal(parity.pass, null);
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
        parity,
      }).exitCode,
      EXIT_CODE.PASS,
      "an unscored parity leg contributes nothing on its own",
    );
  },

  "parity refuses to score against a blind reference leg": (impl) => {
    const parity = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: true,
      presenceState: "present",
      mismatchFraction: 0.0,
      asset: ASSET,
    });
    assert.equal(parity.scored, false);
    assert.equal(parity.structural, "parity:reference-blind");
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
        parity,
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
  },

  "parity above the C15-G8 threshold is a FAIL, below it is a PASS": (impl) => {
    const under = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: ASSET.parityThresholdFraction * 0.5,
      asset: ASSET,
      stage: PARITY_SCORED_STAGE,
    });
    assert.equal(under.scored, true);
    assert.equal(under.pass, true);
    const over = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: ASSET.parityThresholdFraction * 1.5,
      asset: ASSET,
      stage: PARITY_SCORED_STAGE,
    });
    assert.equal(over.scored, true);
    assert.equal(over.pass, false);
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
        parity: over,
      }).exitCode,
      EXIT_CODE.FAIL,
    );
  },

  "parity is never scored in default mode": (impl) => {
    const parity = impl.evaluateParity({
      expectWebgpu: false,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: 0.9,
      asset: ASSET,
    });
    assert.equal(parity.scored, false);
    assert.equal(parity.pass, null);
  },

  "a blind WebGL reference is STRUCTURAL, never a WebGPU defect": (impl) => {
    // The recorded risk for this row: the WASM splat workers may not resolve
    // under Playwright. If they do not, the reference leg cannot see its own
    // subject — filing that as a FAIL invents a defect that does not exist.
    const blind = impl.evaluateReferenceLeg(
      referenceLane({
        dataReady: false,
        dataReadyMs: null,
        numSplats: 0,
        isStable: false,
        indexesLength: null,
        splatPassCommands: 0,
        added: {
          changed: 0,
          edgeFraction: Number.NaN,
          luminanceStdDev: Number.NaN,
        },
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(blind.blind, true);
    assert.equal(blind.failures.length, 0, "a blind leg files no defects");
    assert.equal(blind.criteria, null);
    assert.ok(blind.structural.some((item) => /splat-data-commit/.test(item)));
    assert.equal(
      impl.foldGsplatVerdict({
        reference: blind,
        webgpu: { failures: [], structural: [], notes: [] },
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
  },

  "a reference leg that renders the wrong thing IS a FAIL": (impl) => {
    // The mirror of the rule above: data committed, camera framed, background
    // blank — and still no pixels. That leg CAN see its subject, so zero
    // pixels is a product observation, not an instrument gap.
    const red = impl.evaluateReferenceLeg(
      referenceLane({
        added: { changed: 0, edgeFraction: 0.1, luminanceStdDev: 20 },
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(red.blind, false);
    assert.ok(red.failures.includes("reference:addedPixels"));
  },

  "a flood fill cannot satisfy the added-pixel floor": (impl) => {
    // 60% of the canvas changed, no boundary, no luminance spread — a wrong
    // clear colour or a garbage composite. Exactly the failure the pixel
    // count alone would score as a pass.
    const flood = impl.evaluateReferenceLeg(
      referenceLane({
        added: {
          changed: Math.round(CANVAS_PIXELS * 0.6),
          edgeFraction: 0.0004,
          luminanceStdDev: 0.2,
        },
      }),
      ASSET,
      PREDICT,
    );
    assert.ok(flood.failures.includes("reference:structureEdges"));
    assert.ok(flood.failures.includes("reference:structureVariance"));
  },

  "the splat count is asserted, not merely non-zero": (impl) => {
    const wrongCount = impl.evaluateReferenceLeg(
      referenceLane({ numSplats: 26 }),
      ASSET,
      PREDICT,
    );
    assert.ok(wrongCount.failures.includes("reference:splatCount"));
  },

  "a signal that does not beat the hidden-tileset control is a FAIL": (
    impl,
  ) => {
    // The whole point of the negative control: not "the control is small" but
    // "the ON measurement beats the control by a margin, same metric, same
    // reference frame". Here both sit just under the blank floors, so every
    // precondition passes and only the margin can catch it.
    const controlPixels = Math.round(CANVAS_PIXELS * 0.0009);
    const marginal = impl.evaluateReferenceLeg(
      referenceLane({
        negativeControlChanged: controlPixels,
        added: {
          changed: controlPixels * 2,
          edgeFraction: 0.3,
          luminanceStdDev: 20,
        },
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(marginal.blind, false, "preconditions must all hold here");
    assert.ok(
      marginal.failures.includes("reference:negativeControlMargin") ||
        marginal.failures.includes("reference:addedPixels"),
      `expected the margin (or the floor) to reject it; got ${JSON.stringify(marginal.failures)}`,
    );
    // And specifically: the margin criterion must EXIST and must be false.
    assert.equal(marginal.criteria.negativeControlMargin, false);
  },

  "a dead canvas readback is STRUCTURAL, never a WebGL defect": (impl) => {
    // The nastiest false-defect shape available to this probe: data committed
    // (numSplats=27), camera framed, background "blank" — because the readback
    // returns solid black for everything. Without the liveness control the
    // reference leg is NOT blind by any other test and files
    // `reference:addedPixels` against a renderer that is working fine.
    const deadReadback = impl.evaluateReferenceLeg(
      referenceLane({
        captureLivenessForeground: 0,
        captureLivenessMean: [0, 0, 0],
        added: {
          changed: 0,
          edgeFraction: Number.NaN,
          luminanceStdDev: Number.NaN,
        },
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(deadReadback.blind, true);
    assert.equal(deadReadback.failures.length, 0);
    assert.ok(
      deadReadback.structural.some((item) => /capture-liveness/.test(item)),
    );
  },

  "a polluted reference frame is STRUCTURAL, not a measurement": (impl) => {
    const polluted = impl.evaluateReferenceLeg(
      referenceLane({
        backgroundForeground: Math.round(CANVAS_PIXELS * 0.05),
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(polluted.blind, true);
    assert.ok(
      polluted.structural.some((item) => /background-blank/.test(item)),
    );
  },

  "a non-deterministic capture makes every threshold unresolvable": (impl) => {
    const jittery = impl.evaluateReferenceLeg(
      referenceLane({
        determinismChanged: Math.round(CANVAS_PIXELS * 0.02),
      }),
      ASSET,
      PREDICT,
    );
    assert.equal(jittery.blind, true);
    assert.ok(
      jittery.structural.some((item) => /capture-determinism/.test(item)),
    );
  },

  "a lane that silently fell back to the other backend is STRUCTURAL": (
    impl,
  ) => {
    const fellBack = impl.evaluateWebgpuLeg(
      webgpuAbsentLane({ rendererType: "webgl" }),
      ASSET,
      PREDICT,
      { expectWebgpu: false, stage: G2_STAGE },
    );
    assert.equal(fellBack.notes.length, 0);
    assert.ok(
      fellBack.structural.some((item) => /backend-identity/.test(item)),
    );
  },

  "every named structural precondition rejects its own violation": (impl) => {
    const violations = {
      "server-reachable": { navigationOk: false },
      "tileset-fetch": { tilesetFetchOk: false, tilesetFetchStatus: 404 },
      "pass-enum-exported": { passEnumOk: false, passGaussianSplats: null },
      "backend-identity": { rendererType: "webgpu" },
      "tileset-content-readiness": {
        contentReady: false,
        contentReadyMs: null,
      },
      "camera-framing": { framing: { centerOnScreen: true, radiusPx: 3 } },
      "capture-liveness": {
        captureLivenessForeground: 0,
        captureLivenessMean: [0, 0, 0],
      },
      "background-blank": {
        backgroundForeground: Math.round(CANVAS_PIXELS * 0.5),
      },
      "capture-determinism": {
        determinismChanged: Math.round(CANVAS_PIXELS * 0.5),
      },
      "negative-control-returns": {
        negativeControlChanged: Math.round(CANVAS_PIXELS * 0.5),
      },
    };
    const names = impl
      .precheckPreconditions(referenceLane(), PREDICT)
      .map((check) => check.name);
    assert.deepEqual(
      names,
      [...STRUCTURAL_PRECONDITIONS],
      "the probe's precondition list drifted from the declared one",
    );
    // Healthy lane: every precondition holds.
    for (const check of impl.precheckPreconditions(referenceLane(), PREDICT)) {
      assert.equal(check.ok, true, `healthy lane failed ${check.name}`);
    }
    // Each violation is caught by ITS OWN precondition, not merely by some
    // other one — a precondition that never fires protects nothing.
    for (const [name, override] of Object.entries(violations)) {
      const checks = impl.precheckPreconditions(
        referenceLane(override),
        PREDICT,
      );
      const own = checks.find((check) => check.name === name);
      assert.ok(own, `precondition ${name} is missing from the list`);
      assert.equal(own.ok, false, `precondition ${name} did not fire`);
    }
  },

  "a leg with console/device errors fails the clean criterion": (impl) => {
    const dirty = impl.evaluateReferenceLeg(
      referenceLane({ errors: ["uncaptured GPU error: boom"] }),
      ASSET,
      PREDICT,
    );
    assert.ok(dirty.failures.includes("reference:clean"));
  },

  "FAIL outranks STRUCTURAL, and STRUCTURAL never collapses to exit 0": (
    impl,
  ) => {
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: ["reference:camera-framing"] },
        webgpu: { failures: [], structural: [], notes: [] },
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: ["reference:addedPixels"], structural: ["x"] },
        webgpu: { failures: [], structural: [], notes: [] },
      }).exitCode,
      EXIT_CODE.FAIL,
    );
    assert.equal(
      impl.foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
      }).exitCode,
      EXIT_CODE.PASS,
    );
  },
};

// ── The real implementation satisfies every rule ────────────────────────────

for (const [name, rule] of Object.entries(RULES)) {
  test(`rule: ${name}`, () => rule(REAL));
}

/**
 * Apply the mutant-rejection procedure. Returns the rule that caught the
 * implementation, or null when it survived every rule.
 */
function firstRuleThatRejects(impl) {
  for (const [ruleName, rule] of Object.entries(RULES)) {
    try {
      rule(impl);
    } catch {
      return ruleName;
    }
  }
  return null;
}

test("meta: the mutant-rejection procedure can report survival", () => {
  // If the rejection loop could not fail, every "mutant rejected" test below
  // would be a tautology. The real implementation is the null mutant: it must
  // survive, which is exactly the condition those tests treat as a failure.
  assert.equal(firstRuleThatRejects(REAL), null);
});

// ── Mutants: each must be caught by at least one rule ───────────────────────

const MUTANTS = {
  "absence reported as a pass under --expect-webgpu": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const real = REAL.evaluateWebgpuLeg(lane, asset, predict, options);
      if (options?.expectWebgpu && real.presence.state === "absent") {
        return {
          ...real,
          failures: [],
          structural: [],
          notes: [ABSENT_MARKER],
        };
      }
      return real;
    },
  },

  "presence silently accepted in default mode": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const real = REAL.evaluateWebgpuLeg(lane, asset, predict, options);
      if (!options?.expectWebgpu && real.presence.state === "present") {
        return { ...real, structural: [], failures: [], notes: [] };
      }
      return real;
    },
  },

  // The literal pre-C15-G2 classifier. It was correct while the splat data
  // pipeline sat below the FR dispatch; carrying it forward past the
  // scene-logic extraction turns every healthy run into exit 3.
  "presence classified from the SHARED snapshot commit": {
    ...REAL,
    classifyWebgpuPresence(lane, predict) {
      const real = REAL.classifyWebgpuPresence(lane, predict);
      const dataCommitted =
        (lane?.numSplats ?? 0) > 0 || (lane?.cacheSplatCount ?? 0) > 0;
      const positive = [dataCommitted, real.commands, real.pixels].filter(
        Boolean,
      ).length;
      return {
        ...real,
        dataCommitted,
        state:
          positive === 0 ? "absent" : positive === 3 ? "present" : "ambiguous",
      };
    },
  },

  // "Any known blocker attributes the absence" — the pre-G2 contract. It keeps
  // printing the same green marker after a row removes a blocker, and cannot
  // tell a retired blocker's RETURN from business as usual.
  "stage contract dropped: any known blocker still attributes the absence": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const activeStage = options?.stage ?? STAGE;
      const stripped = {
        ...lane,
        absenceBlockers: (lane?.absenceBlockers ?? []).filter((name) =>
          activeStage.required.includes(name),
        ),
      };
      const real = REAL.evaluateWebgpuLeg(stripped, asset, predict, options);
      // Re-run with the full required set so a missing/retired blocker can
      // never reach the stage checks — exactly what "just keep the old
      // one-of-any rule" does.
      if (
        !options?.expectWebgpu &&
        real.structural.some((item) =>
          /blocker-regression|blocker-contract-stale/.test(item),
        )
      ) {
        return REAL.evaluateWebgpuLeg(
          { ...lane, absenceBlockers: [...activeStage.required] },
          asset,
          predict,
          options,
        );
      }
      return real;
    },
  },

  "unattributed absence treated as the expected absence": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      return REAL.evaluateWebgpuLeg(
        {
          ...lane,
          absenceBlockers: lane?.absenceBlockers?.length
            ? lane.absenceBlockers
            : [...ABSENCE_BLOCKERS],
        },
        asset,
        predict,
        options,
      );
    },
  },

  // C15-G3 — "the stage emptied its required set, so just keep attributing
  // absences the old way". Default mode then reports `absence-unattributed` or
  // `blocker-regression` — still structural, still exit 3, so a bare "is it
  // structural?" assertion would never notice. It names the wrong thing: the
  // probe, or a row that did not regress, instead of a contract the track has
  // moved past. The G3 rule asserts the REASON, which is what catches this.
  "empty-required stage still routed through the absence attribution": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const activeStage = options?.stage ?? STAGE;
      if (options?.expectWebgpu || activeStage.required.length > 0) {
        return REAL.evaluateWebgpuLeg(lane, asset, predict, options);
      }
      // Re-run against a stage that still has a required set, which is exactly
      // what "skip the empty check and fall through" produces.
      return REAL.evaluateWebgpuLeg(lane, asset, predict, {
        ...options,
        stage: {
          ...activeStage,
          required: [...ABSENCE_BLOCKERS].slice(0, 1),
          retired: [],
        },
      });
    },
  },

  // C15-G3 — parity DELETED rather than DEFERRED: the gate stops scoring for
  // every stage, not just this one, so `C15-G5` would silently inherit a
  // thresholdless gate. Indistinguishable from the real thing at C15-G3 and
  // only at C15-G3, which is why the rule also drives a parity-scored stage.
  "parity deferral applied unconditionally, not per stage": {
    ...REAL,
    evaluateParity(input) {
      const real = REAL.evaluateParity(input);
      if (!real.scored) return real;
      return {
        ...real,
        scored: false,
        pass: null,
        threshold: null,
        reason: `${real.reason} (deferred)`,
      };
    },
  },

  // C15-G3 — the flip's success marker printed regardless of the criteria, so
  // a WebGPU leg with the wrong splat count reads as a certified pass in the
  // log even though the exit code disagrees. Logs are what get pasted into
  // rows; a marker that can appear next to a red is worse than no marker.
  "present marker printed even when the product criteria are red": {
    ...REAL,
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const real = REAL.evaluateWebgpuLeg(lane, asset, predict, options);
      if (real.presence.state !== "present" || !options?.expectWebgpu) {
        return real;
      }
      return {
        ...real,
        notes: [`${PRESENT_MARKER} — ${real.presence.why}`],
      };
    },
  },

  "ambiguous half-landed state folded into absent": {
    ...REAL,
    classifyWebgpuPresence(lane, predict) {
      const real = REAL.classifyWebgpuPresence(lane, predict);
      return real.state === "ambiguous" ? { ...real, state: "absent" } : real;
    },
    evaluateWebgpuLeg(lane, asset, predict, options) {
      const real = REAL.evaluateWebgpuLeg(lane, asset, predict, options);
      if (real.presence.state !== "ambiguous") return real;
      // What "just treat it as absent" actually looks like downstream.
      return REAL.evaluateWebgpuLeg(
        { ...lane, numSplats: 0, cacheSplatCount: null },
        asset,
        predict,
        options,
      );
    },
  },

  "parity scored against an absent WebGPU leg": {
    ...REAL,
    evaluateParity(input) {
      if (!input?.expectWebgpu) return REAL.evaluateParity(input);
      const threshold = input.asset.parityThresholdFraction;
      const mismatch = Number(input.mismatchFraction ?? 0);
      return {
        scored: true,
        pass: mismatch <= threshold,
        threshold,
        mismatchFraction: mismatch,
        structural: null,
        reason: "scored unconditionally",
      };
    },
  },

  "parity threshold ignored": {
    ...REAL,
    evaluateParity(input) {
      const real = REAL.evaluateParity(input);
      return real.scored ? { ...real, pass: true } : real;
    },
  },

  "structural folded into a pass": {
    ...REAL,
    foldGsplatVerdict(evaluated) {
      const real = REAL.foldGsplatVerdict(evaluated);
      return real.verdict === "STRUCTURAL"
        ? { ...real, verdict: "PASS", exitCode: EXIT_CODE.PASS }
        : real;
    },
  },

  "blind reference leg filed as a product defect": {
    ...REAL,
    evaluateReferenceLeg(lane, asset, predict) {
      const real = REAL.evaluateReferenceLeg(lane, asset, predict);
      return real.blind
        ? {
            criteria: null,
            structural: [],
            failures: real.structural,
            blind: false,
          }
        : real;
    },
  },

  "negative-control margin criterion removed": {
    ...REAL,
    evaluateReferenceLeg(lane, asset, predict) {
      const real = REAL.evaluateReferenceLeg(lane, asset, predict);
      if (!real.criteria) return real;
      const { negativeControlMargin: _dropped, ...criteria } = real.criteria;
      return {
        ...real,
        criteria,
        failures: real.failures.filter(
          (name) => name !== "reference:negativeControlMargin",
        ),
      };
    },
  },

  "structure criteria removed (pixel count alone)": {
    ...REAL,
    evaluateReferenceLeg(lane, asset, predict) {
      const real = REAL.evaluateReferenceLeg(lane, asset, predict);
      if (!real.criteria) return real;
      const {
        structureEdges: _edges,
        structureVariance: _variance,
        ...criteria
      } = real.criteria;
      return {
        ...real,
        criteria,
        failures: real.failures.filter(
          (name) =>
            name !== "reference:structureEdges" &&
            name !== "reference:structureVariance",
        ),
      };
    },
  },

  "precondition list truncated": {
    ...REAL,
    precheckPreconditions(lane, predict) {
      return REAL.precheckPreconditions(lane, predict).slice(0, 2);
    },
  },

  "splat count relaxed to non-zero": {
    ...REAL,
    evaluateReferenceLeg(lane, asset, predict) {
      const real = REAL.evaluateReferenceLeg(lane, asset, predict);
      if (!real.criteria) return real;
      const criteria = { ...real.criteria, splatCount: lane.numSplats > 0 };
      return {
        ...real,
        criteria,
        failures: real.failures.filter(
          (name) => name !== "reference:splatCount",
        ),
      };
    },
  },
};

for (const [mutantName, impl] of Object.entries(MUTANTS)) {
  test(`mutant rejected: ${mutantName}`, () => {
    const caughtBy = firstRuleThatRejects(impl);
    assert.notEqual(
      caughtBy,
      null,
      `mutant "${mutantName}" survived every rule — the gate does not actually forbid it`,
    );
  });
}

// ── Arithmetic that must not be re-derivable by accident ────────────────────

test("fractionOf never lets an unmeasured canvas satisfy a threshold", () => {
  for (const bad of [
    [10, 0],
    [10, Number.NaN],
    [Number.NaN, 100],
    [10, undefined],
  ]) {
    const value = fractionOf(bad[0], bad[1]);
    assert.equal(Number.isNaN(value), true);
    assert.equal(value >= PREDICT.minAddedFraction, false);
    assert.equal(value <= PREDICT.blankFraction, false);
  }
  assert.equal(fractionOf(786432 * 0.02, 786432), 0.02);
});

test("recognizedBlockers intersects with the declared list, never trusts the page", () => {
  assert.deepEqual(recognizedBlockers({ absenceBlockers: ["vibes"] }), []);
  assert.deepEqual(recognizedBlockers({}), []);
  assert.deepEqual(
    recognizedBlockers({
      absenceBlockers: ["no-splat-data-fields", "vibes"],
    }),
    ["no-splat-data-fields"],
  );
});

test("the C15-G8 parity thresholds are the ones the track committed to", () => {
  assert.equal(ASSETS.tower.parityThresholdFraction, 0.03);
  assert.equal(ASSETS.sh_unit_cube.parityThresholdFraction, 0.01);
  assert.equal(ASSETS.tower.expectedSplats, 286868);
  assert.equal(ASSETS.sh_unit_cube.expectedSplats, 27);
});

// ── In-tree assets ──────────────────────────────────────────────────────────

test("both gate tilesets are in-tree and served from the repo root", () => {
  for (const asset of Object.values(ASSETS)) {
    const onDisk = resolve(ROOT, asset.url.replace(/^\//, ""));
    assert.equal(
      existsSync(onDisk),
      true,
      `${asset.name}: ${asset.url} is the probe's URL and must exist on disk — server.js statics the repo root`,
    );
  }
  const server = readNormalized("server.js");
  assert.match(
    server,
    /express\.static\(path\.resolve\("\."\)\)/,
    "the repo-root static mount is what lets the probe reach Specs/Data without Ion or network",
  );
});

// ── Source anchors on the engine facts (CRLF-normalized) ────────────────────
//
// These are TRIPWIRES. They pin the C15-G2 structure — the FR dispatch sits
// BELOW the shared data pipeline, and `show` resolves to real visibility — and
// when C15-G3 lands they SHOULD break, loudly, so whoever breaks them has to
// flip the probe to --expect-webgpu rather than let the harness silently
// change meaning underneath a green run.
//
// Each anchor is a PURE PREDICATE over source text, so the same check runs
// against the real file AND against deliberately mutated copies of it. An
// anchor that only ever sees the correct source proves nothing about what it
// would reject: the MUTANT-SOURCE group below re-introduces the pre-G2 shape
// and requires the predicate to fail.

const PRIMITIVE_PATH = "packages/engine/Source/Scene/GaussianSplatPrimitive.js";
const RENDERER_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts";

/**
 * C15-G2 structure check over `GaussianSplatPrimitive.js` source text. Throws
 * with a named reason when the scene-logic extraction is not in place.
 */
function assertDispatchBelowDataCommit(source) {
  const updateStart = source.indexOf("  update(frameState) {");
  assert.notEqual(
    updateStart,
    -1,
    `${PRIMITIVE_PATH}: GaussianSplatPrimitive#update moved`,
  );

  // The pre-G2 shape: dispatch-and-return as the first branch of update().
  assert.equal(
    source.indexOf(
      "if (fr) {\n      fr.update(this, frameState);\n      this._featureRenderer = fr;\n      return;\n    }",
      updateStart,
    ),
    -1,
    `${PRIMITIVE_PATH}: the pre-C15-G2 dispatch-and-return block is back — the entire data path is below it again`,
  );

  const sharedCall = source.indexOf(
    "this._updateSplatData(frameState);",
    updateStart,
  );
  assert.notEqual(
    sharedCall,
    -1,
    `${PRIMITIVE_PATH}: the shared data pipeline call is gone from update()`,
  );
  const dispatch = source.indexOf("fr.update(this, frameState);", updateStart);
  assert.notEqual(dispatch, -1, `${PRIMITIVE_PATH}: the FR dispatch is gone`);
  assert.ok(
    dispatch > sharedCall,
    `${PRIMITIVE_PATH}: the FR dispatch must sit BELOW the shared data pipeline — that ordering is the whole of C15-G2`,
  );

  // The data pipeline itself must still be inside the SHARED half, i.e. its
  // definition must open before the dispatch is reached. Ordering is asserted
  // on the CALL SITES the shared half performs, not on helper declarations.
  const sharedStart = source.indexOf("  _updateSplatData(frameState) {");
  assert.notEqual(
    sharedStart,
    -1,
    `${PRIMITIVE_PATH}: _updateSplatData is gone`,
  );
  for (const call of [
    "GaussianSplatPrimitive.generateSplatTexture(",
    "GaussianSplatSorter.radixSortIndexes({",
  ]) {
    assert.notEqual(
      source.indexOf(call, sharedStart),
      -1,
      `${PRIMITIVE_PATH}: ${call} is no longer reached from the shared half`,
    );
  }

  // The DRAW half stays gated. Both `buildGSplatDrawCommand` call sites must
  // be behind a `_featureRenderer`-absent check, or the WebGPU path would
  // construct WebGL VertexArray/ShaderProgram objects it cannot use.
  const buildCalls = [
    ...source.matchAll(/GaussianSplatPrimitive\.buildGSplatDrawCommand\(/g),
  ];
  assert.ok(
    buildCalls.length >= 2,
    `${PRIMITIVE_PATH}: expected the two buildGSplatDrawCommand call sites; found ${buildCalls.length}`,
  );
  for (const match of buildCalls) {
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    assert.match(
      before,
      /if\s*\(!defined\((?:this|primitive)\._featureRenderer\)\)\s*\{[^{}]*$/,
      `${PRIMITIVE_PATH}: a buildGSplatDrawCommand call at offset ${match.index} is not gated on _featureRenderer being absent`,
    );
  }

  // The neutral/GL boundary inside the texture pipeline: the WebGL `Texture`
  // constructors must sit behind the same branch.
  // Anchored on the branch BODY, not on `if (defined(primitive._featureRenderer))`
  // alone: `hasSnapshotRenderPayload` now opens with the same condition earlier
  // in the file, and a bare `indexOf` would silently start matching THAT one —
  // an anchor pointing at the wrong site passes forever. (Caught by the mutant
  // battery when the predicate landed.)
  const textureBranch = source.indexOf(
    "if (defined(primitive._featureRenderer)) {\n      snapshot.packedSplatTextureData = effectiveTextureData;",
  );
  const firstTextureCreate = source.indexOf(
    "snapshot.gaussianSplatTexture = createGaussianSplatTexture(",
  );
  assert.notEqual(
    textureBranch,
    -1,
    `${PRIMITIVE_PATH}: the backend branch in processGeneratedSplatTextureData is gone`,
  );
  assert.notEqual(
    firstTextureCreate,
    -1,
    `${PRIMITIVE_PATH}: createGaussianSplatTexture call moved`,
  );
  assert.ok(
    textureBranch < firstTextureCreate,
    `${PRIMITIVE_PATH}: the WebGL Texture upload must sit BELOW the backend branch`,
  );

  // ...and the neutral half above it must still be shared, not duplicated.
  assert.match(
    source,
    /function computeSplatTextureLayout\(/,
    `${PRIMITIVE_PATH}: the neutral trim/pad/row-mask half was re-inlined`,
  );
}

/**
 * C15-G2 visibility check: `GaussianSplatPrimitive` resolves `show`, and it
 * resolves it from the tileset rather than inventing a second source of truth.
 */
function assertShowResolvesFromTileset(source) {
  assert.match(
    source,
    /^\s*get show\(\) \{\n\s*return this\._tileset\?\.show \?\? false;\n\s*\}/m,
    `${PRIMITIVE_PATH}: the C15-G2 \`show\` accessor is gone or no longer proxies tileset.show — the WebGPU renderer's first statement fires again for every production primitive`,
  );
  // A settable member would be the SECOND source of truth this decision
  // deliberately rejected: the WebGL path gates on `tileset.show`, so the two
  // backends would then honour different signals.
  assert.doesNotMatch(
    source,
    /^\s*(?:this\.show\s*=|set show\()/m,
    `${PRIMITIVE_PATH}: \`show\` became settable — visibility now has two sources of truth`,
  );
  // The WebGL path's own gate must still read the tileset directly, which is
  // what makes the accessor a proxy rather than a divergence.
  assert.match(
    source,
    /if \(!tileset\.show\) \{/,
    `${PRIMITIVE_PATH}: the WebGL visibility gate moved; re-verify what \`show\` proxies`,
  );
}

test("HEAD: the FR dispatch sits BELOW the shared data commit (C15-G2)", () => {
  assertDispatchBelowDataCommit(readNormalized(PRIMITIVE_PATH));
});

test("HEAD: `show` resolves from the owning tileset (C15-G2)", () => {
  assertShowResolvesFromTileset(readNormalized(PRIMITIVE_PATH));
});

// ── The snapshot-readiness predicate — the C15-G2 follow-up defect ───────────
//
// `_updateSplatData` re-checks the snapshot's payload after
// `SnapshotState.TEXTURE_READY` before it schedules the sort. The check used to
// read `pending.gaussianSplatTexture` unconditionally, which is a WebGL object
// the native branch deliberately never creates — so the native path reached
// TEXTURE_READY with no texture BY DESIGN, the guard fired every frame forever,
// the sort was never scheduled, `commitSnapshot` never ran, and `_numSplats`
// stayed 0 on WebGPU while WebGL was unaffected. That is a whole class of bug
// the C15-G2 boundary analysis can produce: a readiness PREDICATE written in
// terms of a backend-specific artifact, sitting in the shared half.
//
// Regex anchors alone would be weak here, so the real function is EXTRACTED
// from the engine file and EXECUTED against its truth table — the same
// mutate-a-copy-of-the-engine-source shape `pipeline-key-aliasing.spec.mjs`
// uses for its fold.

/** Cesium's `defined`, verbatim (`Core/defined.js`). */
const definedShim = (value) => value !== undefined && value !== null;

/**
 * Slice a top-level `function <name>(...) {...}` out of source text by
 * balanced-brace scan, so the extracted unit is the real bytes, not a copy.
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${PRIMITIVE_PATH}: function ${name} is gone`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

/** Compile the extracted predicate with a `defined` shim and hand it back. */
function loadPayloadPredicate(source) {
  const text = extractFunction(source, "hasSnapshotRenderPayload");
  // eslint-disable-next-line no-new-func
  return new Function("defined", `${text}\nreturn hasSnapshotRenderPayload;`)(
    definedShim,
  );
}

const PAYLOAD = { width: 1, height: 1, data: new Uint32Array(8) };
const FAKE_TEXTURE = { destroy() {} };

/**
 * The truth table. Two cells are the fix; the other two are the invariants the
 * fix must NOT weaken — "just delete the guard" satisfies neither.
 */
const PAYLOAD_TRUTH_TABLE = [
  {
    label: "WebGL, texture present → ready",
    primitive: { _featureRenderer: undefined },
    snapshot: {
      gaussianSplatTexture: FAKE_TEXTURE,
      packedSplatTextureData: undefined,
    },
    expected: true,
  },
  {
    label:
      "WebGL, texture MISSING → NOT ready (the original invariant, unweakened)",
    primitive: { _featureRenderer: undefined },
    snapshot: {
      gaussianSplatTexture: undefined,
      packedSplatTextureData: PAYLOAD,
    },
    expected: false,
  },
  {
    label: "native, packed payload present → ready (the C15-G2 fix)",
    primitive: { _featureRenderer: {} },
    snapshot: {
      gaussianSplatTexture: undefined,
      packedSplatTextureData: PAYLOAD,
    },
    expected: true,
  },
  {
    label: "native, packed payload MISSING → NOT ready",
    primitive: { _featureRenderer: {} },
    snapshot: {
      gaussianSplatTexture: FAKE_TEXTURE,
      packedSplatTextureData: undefined,
    },
    expected: false,
  },
];

function assertPayloadTruthTable(source) {
  const predicate = loadPayloadPredicate(source);
  for (const row of PAYLOAD_TRUTH_TABLE) {
    assert.equal(
      predicate(row.primitive, row.snapshot),
      row.expected,
      `hasSnapshotRenderPayload: ${row.label}`,
    );
  }
}

test("HEAD: the snapshot-readiness predicate is backend-aware (executed, not grepped)", () => {
  assertPayloadTruthTable(readNormalized(PRIMITIVE_PATH));
});

test("HEAD: the TEXTURE_READY guard calls the predicate, not the WebGL texture", () => {
  const source = readNormalized(PRIMITIVE_PATH);
  assert.match(
    source,
    /pending\.state === SnapshotState\.TEXTURE_READY &&\n\s*!hasSnapshotRenderPayload\(this, pending\)/,
    `${PRIMITIVE_PATH}: the TEXTURE_READY readiness guard no longer routes through hasSnapshotRenderPayload — the native path stalls forever the moment it reads a WebGL object directly`,
  );
  assert.doesNotMatch(
    source,
    /TEXTURE_READY &&\n\s*!defined\(pending\.gaussianSplatTexture\)/,
    `${PRIMITIVE_PATH}: the pre-fix unconditional texture read is back`,
  );
});

// MUTANT-SOURCE group. Each mutation is applied to a COPY of the real file and
// the corresponding predicate must REJECT it. Without this, an anchor that
// silently stopped matching anything would pass forever.
const SOURCE_MUTANTS = [
  {
    name: "pre-G2 ordering: dispatch-and-return restored as update()'s first branch",
    predicate: assertDispatchBelowDataCommit,
    because: /pre-C15-G2 dispatch-and-return block is back/,
    mutate: (source) =>
      source.replace(
        "    this._updateSplatData(frameState);\n\n    if (defined(fr)) {\n      fr.update(this, frameState);\n    }",
        "    if (fr) {\n      fr.update(this, frameState);\n      this._featureRenderer = fr;\n      return;\n    }\n    this._updateSplatData(frameState);",
      ),
  },
  {
    name: "the draw-command build is un-gated (WebGL objects built on WebGPU)",
    predicate: assertDispatchBelowDataCommit,
    because: /is not gated on _featureRenderer being absent/,
    mutate: (source) =>
      source.replace(
        "      if (!defined(this._featureRenderer)) {\n        GaussianSplatPrimitive.buildGSplatDrawCommand(this, frameState);\n      }",
        "      GaussianSplatPrimitive.buildGSplatDrawCommand(this, frameState);",
      ),
  },
  {
    name: "the WebGL Texture upload is no longer behind the backend branch",
    predicate: assertDispatchBelowDataCommit,
    because: /backend branch in processGeneratedSplatTextureData is gone/,
    mutate: (source) =>
      source.replace(
        "if (defined(primitive._featureRenderer)) {\n      snapshot.packedSplatTextureData = effectiveTextureData;",
        "if (false) {\n      snapshot.packedSplatTextureData = effectiveTextureData;",
      ),
  },
  {
    name: "the show guard is deleted rather than answered",
    predicate: assertShowResolvesFromTileset,
    because: /accessor is gone or no longer proxies tileset\.show/,
    mutate: (source) =>
      source.replace(
        "  get show() {\n    return this._tileset?.show ?? false;\n  }",
        "",
      ),
  },
  {
    // THE DEFECT ITSELF. This is exactly what shipped in Batch 878 and it made
    // the WebGPU leg stall at `numSplats=0` for 30 s while WebGL was green.
    name: "readiness reads the WebGL texture unconditionally (the Batch-878 stall)",
    predicate: assertPayloadTruthTable,
    because: /native, packed payload present/,
    mutate: (source) =>
      source.replace(
        "  if (defined(primitive._featureRenderer)) {\n    return defined(snapshot.packedSplatTextureData);\n  }\n  return defined(snapshot.gaussianSplatTexture);",
        "  return defined(snapshot.gaussianSplatTexture);",
      ),
  },
  {
    // The obvious wrong fix: "the guard is in the way, delete it."
    name: "readiness always true (guard deleted rather than made backend-aware)",
    predicate: assertPayloadTruthTable,
    because: /texture MISSING/,
    mutate: (source) =>
      source.replace(
        "  if (defined(primitive._featureRenderer)) {\n    return defined(snapshot.packedSplatTextureData);\n  }\n  return defined(snapshot.gaussianSplatTexture);",
        "  return true;",
      ),
  },
  {
    name: "readiness branches inverted (each backend checks the other's payload)",
    predicate: assertPayloadTruthTable,
    because: /texture present/,
    mutate: (source) =>
      source.replace(
        "  if (defined(primitive._featureRenderer)) {\n    return defined(snapshot.packedSplatTextureData);\n  }\n  return defined(snapshot.gaussianSplatTexture);",
        "  if (defined(primitive._featureRenderer)) {\n    return defined(snapshot.gaussianSplatTexture);\n  }\n  return defined(snapshot.packedSplatTextureData);",
      ),
  },
  {
    name: "show becomes a settable own-property (second source of truth)",
    predicate: assertShowResolvesFromTileset,
    because: /accessor is gone or no longer proxies tileset\.show/,
    mutate: (source) =>
      source.replace(
        "  get show() {\n    return this._tileset?.show ?? false;\n  }",
        "  get show() {\n    return this._show;\n  }\n\n  set show(value) {\n    this._show = value;\n  }",
      ),
  },
];

for (const mutant of SOURCE_MUTANTS) {
  test(`HEAD mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(PRIMITIVE_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      "the mutation did not apply — the anchored text moved, so this mutant proves nothing",
    );
    // The REASON is pinned too. `assert.throws` alone would be satisfied by an
    // anchor that happened to break on some unrelated assertion, which is how a
    // mutation test quietly stops testing the mutation.
    assert.throws(
      () => mutant.predicate(mutated),
      mutant.because,
      `the anchor accepted the mutated source, or rejected it for the wrong reason; it is not actually pinning ${mutant.name}`,
    );
  });
}

test("HEAD: the synthetic splat probes' hand-rolled primitives still satisfy the renderer's guard", () => {
  // C15-G2 changed how PRODUCTION primitives resolve `show`. The three probes
  // that reach the WebGPU splat data path do so with plain object literals, so
  // the accessor cannot affect them — but only while they keep declaring it.
  for (const probe of [
    "Tools/visual-regression/probe-splat-sort.mjs",
    "Tools/visual-regression/probe-splat-globe-occlusion.mjs",
    "Tools/visual-regression/probe-oit-transparency.mjs",
  ]) {
    const source = readNormalized(probe);
    assert.match(
      source,
      /^\s*show: true,$/m,
      `${probe}: the hand-rolled splat primitive no longer declares show: true, so it exits at the renderer's first statement`,
    );
    assert.match(
      source,
      /_splatData:/,
      `${probe}: the hand-rolled splat primitive no longer assigns _splatData`,
    );
  }
});

test("HEAD: the WebGPU renderer cannot reach its synchronous JS sort with no splat data", () => {
  // C15-G2 makes the shared pipeline run for WebGPU, which means `_positions`
  // and `_indexes` now exist on the WebGPU leg for a 286,868-splat tileset.
  // The in-renderer `maybeSortSplats` is a synchronous main-thread
  // Array.prototype.sort and must NOT start paying that per frame for data it
  // cannot draw. It is structurally unreachable because the splatCount-zero
  // return precedes it; C15-G4 replaces it with the WASM sort.
  const source = readNormalized(RENDERER_PATH);
  const zeroReturn = source.indexOf("if (cache.splatCount === 0) {");
  const sortCall = source.indexOf("maybeSortSplats(device, primitive");
  assert.notEqual(
    zeroReturn,
    -1,
    `${RENDERER_PATH}: the splatCount-zero early return is gone`,
  );
  assert.notEqual(sortCall, -1, `${RENDERER_PATH}: maybeSortSplats call moved`);
  assert.ok(
    zeroReturn < sortCall,
    `${RENDERER_PATH}: the synchronous JS sort is now reachable with an empty cache — a 286k-element sort per frame for data the WebGPU path cannot yet draw (C15-G4)`,
  );
});

test("HEAD: nothing in the engine produces splat data for the WebGPU renderer", () => {
  const producers = [
    /\b_splatData\s*=[^=]/,
    /_renderResources\s*(?:\?\.)?\s*\.\s*splatBuffer\s*=[^=]/,
    /\b_splatCount\s*=[^=]/,
  ];
  const hits = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      // Shaders are string modules; ThirdParty is vendored.
      if (entry === "Shaders" || entry === "ThirdParty") continue;
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:js|ts)$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      const source = readFileSync(full, "utf8").replaceAll("\r\n", "\n");
      for (const pattern of producers) {
        if (pattern.test(source)) {
          hits.push(`${full}: ${pattern}`);
        }
      }
    }
  };
  walk(resolve(ROOT, "packages/engine/Source"));
  assert.deepEqual(
    hits,
    [],
    `a splat data producer appeared in the engine:\n  ${hits.join("\n  ")}\n` +
      `C15-G3 deliberately did NOT create one: Option B consumes the WASM ` +
      `generate_splat_texture output verbatim instead of repacking it into the ` +
      `16-float record. A producer here means somebody chose Option A (a full ` +
      `CPU pass per snapshot and 2x the GPU memory) without recording it, and ` +
      `the two layouts would then both be live.`,
  );
});

test("HEAD: the WebGPU renderer's splat source IS produced, in the packed layout", () => {
  // The positive half of the anchor above. `C15-G3` closes
  // NEW-WEBGPU-SPLAT-DATA-PRODUCER by consuming a producer that already
  // existed rather than by adding one, so "no legacy producer" on its own
  // would be satisfied by the pre-G3 world too — it must be paired with proof
  // that the packed payload is committed AND read.
  const primitive = readNormalized(PRIMITIVE_PATH);
  assert.match(
    primitive,
    /primitive\._packedSplatTextureData = snapshot\.packedSplatTextureData;/,
    `${PRIMITIVE_PATH}: commitSnapshot no longer publishes the packed WASM payload — the WebGPU renderer has no data source`,
  );
  assert.match(
    primitive,
    /snapshot\.packedSplatTextureData = effectiveTextureData;/,
    `${PRIMITIVE_PATH}: the native branch no longer retains the packed payload`,
  );

  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    renderer,
    /_packedSplatTextureData\?: PackedSplatTextureData;/,
    `${RENDERER_PATH}: the renderer no longer declares the packed payload field`,
  );
  assert.match(
    renderer,
    /const payload = fields\._packedSplatTextureData;/,
    `${RENDERER_PATH}: resolveSplatSource no longer reads the packed payload`,
  );
  // Consumed VERBATIM — a `subarray` slice, not a re-pack. Any `new
  // Float32Array(count * 16)` here would be Option A arriving by the back door.
  assert.match(
    renderer,
    /payload\.data\.subarray\(0, words\)/,
    `${RENDERER_PATH}: the packed payload is no longer sliced verbatim — check for a CPU repack (Option A) that the row rejected`,
  );
  assert.doesNotMatch(
    renderer,
    /new Float32Array\(\s*(?:count|words|revision)\s*\*\s*16\s*\)/,
    `${RENDERER_PATH}: a 16-float repack appeared — that is Option A, which the row rejected for 2x memory and a per-snapshot CPU pass`,
  );
});

test("HEAD: Pass.GAUSSIAN_SPLATS is exported and the probe reads it by name", () => {
  const passSource = readNormalized("packages/engine/Source/Renderer/Pass.js");
  assert.match(passSource, /GAUSSIAN_SPLATS:\s*\d+,/);
  assert.match(
    PROBE_CODE,
    /C\.Pass\.GAUSSIAN_SPLATS/,
    "the probe must read the enum, not a hardcoded pass index",
  );
  assert.doesNotMatch(
    PROBE_CODE,
    /indices\[\s*1[12]\s*\]/,
    "a hardcoded pass index silently mis-bins when Pass.js is renumbered",
  );
});

// ── Probe-source anchors: the conventions that make the numbers mean something

test("probe: dual mode is a flag, and the marker comes from the model", () => {
  assert.match(PROBE_CODE, /--expect-webgpu/);
  assert.match(
    PROBE_CODE,
    /expectWebgpu:\s*EXPECT_WEBGPU/,
    "the flip must be threaded into the model, not re-decided inline",
  );
  // The marker string itself must exist in exactly one place: the model.
  const literalInProbeCode = PROBE_CODE.includes(
    "WEBGPU-SPLATS-ABSENT (expected until C15-G3)",
  );
  assert.equal(
    literalInProbeCode,
    false,
    "the probe must print ABSENT_MARKER from the model, not its own copy of the string",
  );
  assert.match(PROBE_CODE, /ABSENT_MARKER/);
});

test("probe: pinned clock, same-task capture, watchdog, structural exits", () => {
  assert.match(
    PROBE_CODE,
    /scene\.render\(frameTime\)/,
    "the probe must render its declared fixed time, not JulianDate.now()",
  );
  assert.doesNotMatch(
    PROBE_CODE,
    /\bscene\.render\(\s*\)/,
    "an unpinned render silently substitutes wall-clock time",
  );
  assert.match(PROBE_CODE, /viewer\.clock\.shouldAnimate = false/);
  assert.match(PROBE_CODE, /viewer\.useDefaultRenderLoop = false/);
  assert.match(PROBE_CODE, /scene\.requestRenderMode = false/);
  // Same-task capture: drawImage + getImageData + toDataURL with no await in
  // between. `captureNow` must not be async.
  assert.match(
    PROBE_CODE,
    /const captureNow = \(\) => \{[\s\S]*?scratchContext\.drawImage\(canvas, 0, 0\);[\s\S]*?canvas\.toDataURL\("image\/png"\)/,
    "capture must render and read in one synchronous task",
  );
  assert.doesNotMatch(
    PROBE_CODE,
    /const captureNow = async/,
    "an async capture yields between render and read, which is invalid on both backends",
  );
  assert.match(PROBE_CODE, /WATCHDOG_MS/);
  assert.match(PROBE_CODE, /process\.exit\(EXIT_CODE\.ERROR\)/);
  assert.match(PROBE_CODE, /process\.exitCode = verdict\.exitCode/);
  assert.match(
    PROBE_CODE,
    /offline=true/,
    "the scene must not reach for network imagery or terrain",
  );
  assert.match(PROBE_CODE, /channel: "msedge"/);
});

test("probe: readiness is wall clock, never a frame count", () => {
  assert.match(PROBE_CODE, /performance\.now\(\) - contentStart </);
  assert.match(PROBE_CODE, /performance\.now\(\) - dataStart < dataBudgetMs/);
  assert.doesNotMatch(
    PROBE_CODE,
    /for \(let frame = 0; frame < \d+; frame\+\+\)/,
    "a frame budget silently under-runs a cold pipeline compile plus two WASM workers",
  );
  // The WebGPU absence budget is DERIVED from what the reference actually
  // needed, so the claim is "4x the reference" rather than a number we picked.
  assert.match(PROBE_CODE, /Math\.max\(30_000, 4 \* webgl\.dataReadyMs\)/);
});

test("probe: the negative control uses the SAME metric and the SAME reference", () => {
  assert.match(
    PROBE_CODE,
    /record\.added = analyzeAdded\(onA\.image, offA\.image\)/,
  );
  assert.match(
    PROBE_CODE,
    /record\.negativeControlChanged = analyzeAdded\(offB\.image, offA\.image\)\.changed/,
    "the control must be the same function against the same reference frame, or it is measuring something else",
  );
  assert.match(
    PROBE_CODE,
    /record\.determinismChanged = changedPixelCount\(onA\.image, onB\.image\)/,
    "the determinism control must bracket the scored ON capture",
  );
  // Capture liveness must be measured against a KNOWN non-background colour,
  // independent of splats — otherwise a dead readback reads as "drew nothing".
  assert.match(
    PROBE_CODE,
    /scene\.backgroundColor = C\.Color\.fromBytes\(64, 128, 192, 255\)/,
  );
  assert.match(
    PROBE_CODE,
    /record\.captureLivenessForeground = foregroundCount\(liveness\.image\)/,
  );
  assert.match(
    PROBE_CODE,
    /scene\.backgroundColor = C\.Color\.BLACK/,
    "the liveness repaint must be restored before the scored frames",
  );
});

test("probe: the camera is derived from the tileset, not hardcoded", () => {
  assert.match(PROBE_CODE, /tileset\.boundingSphere/);
  assert.match(PROBE_CODE, /sphere\.radius \* rangeScale/);
  assert.doesNotMatch(
    PROBE_CODE,
    /Cartesian3\.fromDegrees\(/,
    "a hardcoded camera position stops framing the asset the moment the asset changes",
  );
});

test("probe: evidence lands where the row says it does", () => {
  assert.match(PROBE_CODE, /Tools\/visual-regression\/output\/gsplat-parity/);
  assert.match(PROBE_CODE, /manifest\.json/);
});

// ────────────────────────────────────────────────────────────────────────────
// C15-G3 — the packed WASM record: layout, decode, and both ends of the pin.
//
// The row's whole risk is a STRIDE/OFFSET disagreement between the producer
// (the WASM `generate_splat_texture`, whose only in-tree consumer is
// `PrimitiveGaussianSplatVS.glsl`) and the new WGSL consumer. That class of bug
// draws SOMETHING — structured, plausible, wrong — so no pixel metric catches
// it, and there is no CPU pack function to unit-test because Option B has no
// CPU pack at all. What CAN be tested is that the two shader decodes name the
// SAME word and the SAME f16 half for every term.
//
// So both ends are PARSED, not transcribed: the GLSL mapping is derived from
// the GLSL source, the WGSL mapping from the WGSL source, and they must agree
// element by element. A hardcoded reference table here would only pin the WGSL
// against one person's reading of the GLSL.
// ────────────────────────────────────────────────────────────────────────────

const GLSL_VS_PATH =
  "packages/engine/Source/Shaders/PrimitiveGaussianSplatVS.glsl";
const PREPROCESSOR_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts";
const DEFINES_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts";

/** Extract the inline `SPLAT_WGSL` template literal from the renderer. */
function extractSplatWgsl(source) {
  const marker = "const SPLAT_WGSL = `";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${RENDERER_PATH}: SPLAT_WGSL template is gone`);
  const end = source.indexOf("\n`;", start);
  assert.notEqual(
    end,
    -1,
    `${RENDERER_PATH}: SPLAT_WGSL template is unterminated`,
  );
  const body = source.slice(start + marker.length, end);
  // A backtick inside the literal terminates it early — the file can still
  // parse as *something*, which is how it silently stops being WGSL.
  assert.ok(
    !body.includes("`"),
    `${RENDERER_PATH}: SPLAT_WGSL contains a backtick, which terminates the template literal early`,
  );
  return body;
}

/**
 * Resolve `//>>ifdef` / `//>>else` / `//>>endif` the way
 * `WebGPUShaderPreprocessor.preprocess` does.
 *
 * This is a re-implementation, and the honest limitation is that a divergence
 * from the engine's would make the Naga check validate text the engine never
 * emits. Two things bound that: `assertDirectiveVocabulary` refuses any `//>>`
 * line SPLAT_WGSL uses that is not one of the three forms handled here, and
 * the engine's own directive grammar is anchored, so a fourth form cannot be
 * introduced without this spec going red first.
 */
function resolveDirectives(source, flags) {
  const out = [];
  const stack = [];
  const emitting = () => stack.every((frame) => frame.taken);
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//>>ifdef ")) {
      stack.push({
        taken: flags.has(trimmed.slice("//>>ifdef ".length).trim()),
      });
      return;
    }
    if (trimmed === "//>>else") {
      assert.ok(
        stack.length > 0,
        `//>>else without ifdef at line ${index + 1}`,
      );
      const top = stack[stack.length - 1];
      top.taken = !top.taken;
      return;
    }
    if (trimmed === "//>>endif") {
      assert.ok(
        stack.length > 0,
        `//>>endif without ifdef at line ${index + 1}`,
      );
      stack.pop();
      return;
    }
    if (emitting()) out.push(line);
  });
  assert.equal(stack.length, 0, "unterminated //>>ifdef in SPLAT_WGSL");
  return out.join("\n");
}

function assertDirectiveVocabulary(wgsl) {
  for (const line of wgsl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//>>")) continue;
    assert.ok(
      /^\/\/>>ifdef [A-Z_][A-Z0-9_]*$/.test(trimmed) ||
        trimmed === "//>>else" ||
        trimmed === "//>>endif",
      `SPLAT_WGSL uses a directive this spec's resolver does not implement: "${trimmed}". ` +
        `Either it is a typo the engine would throw on, or the resolver here has drifted ` +
        `from WebGPUShaderPreprocessor and the Naga check below is validating text the ` +
        `engine never emits.`,
    );
  }
}

/** Half-float helpers — the WASM record stores covariance as packed f16 pairs. */
const HALF_VIEW = new DataView(new ArrayBuffer(4));
function toHalfBits(value) {
  const f = Math.fround(value);
  HALF_VIEW.setFloat32(0, f);
  const bits = HALF_VIEW.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) {
    return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  }
  const e = exponent - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - e;
    let half = mantissa >>> shift;
    if ((mantissa >>> (shift - 1)) & 1) half += 1;
    return sign | half;
  }
  let half = (e << 10) | (mantissa >>> 13);
  if ((mantissa >>> 12) & 1) half += 1;
  return sign | half;
}
function fromHalfBits(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}
const packHalf2 = (low, high) =>
  ((toHalfBits(high) << 16) | toHalfBits(low)) >>> 0;
const unpackHalf2 = (word) => [
  fromHalfBits(word & 0xffff),
  fromHalfBits((word >>> 16) & 0xffff),
];
const BITS_VIEW = new DataView(new ArrayBuffer(4));
const floatToBits = (value) => {
  BITS_VIEW.setFloat32(0, value);
  return BITS_VIEW.getUint32(0);
};

/**
 * Derive the WGSL packed decode from the WGSL source: which u32 word, and which
 * half of it, every term comes out of.
 */
function parseWgslPackedDecode(wgsl) {
  const packed = resolveDirectives(wgsl, new Set(["SPLAT_PACKED_WASM"]));
  const loadSplat = packed.slice(
    packed.indexOf("fn loadSplat("),
    packed.indexOf("fn loadPrevSplatModelPosition("),
  );
  assert.ok(
    loadSplat.length > 0,
    "loadSplat is missing from the packed variant",
  );

  const strideMatch = loadSplat.match(/let base = index \* (\d+)u;/);
  assert.ok(
    strideMatch,
    "the packed loadSplat has no `base = index * Nu` stride",
  );
  const stride = Number(strideMatch[1]);

  const positionBlock = loadSplat.slice(
    loadSplat.indexOf("s.positionHigh"),
    loadSplat.indexOf("s.positionLow"),
  );
  const positionWords = [
    ...positionBlock.matchAll(/bitcast<f32>\(splats\[base(?: \+ (\d+)u)?\]\)/g),
  ].map((m) => Number(m[1] ?? 0));

  const covWords = {};
  for (const m of loadSplat.matchAll(
    /let (cov\d) = unpack2x16float\(splats\[base \+ (\d+)u\]\);/g,
  )) {
    covWords[m[1]] = Number(m[2]);
  }

  const readVec3 = (field) => {
    const m = loadSplat.match(
      new RegExp(`s\\.${field} = vec3<f32>\\(([^;]*)\\);`),
    );
    assert.ok(m, `the packed loadSplat does not assign s.${field}`);
    return m[1]
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
  };

  const colorWordMatch = loadSplat.match(
    /let packedColor = splats\[base \+ (\d+)u\];/,
  );
  assert.ok(colorWordMatch, "the packed loadSplat does not read a colour word");
  const colorBlock = loadSplat.slice(loadSplat.indexOf("s.color = vec4<f32>("));
  const colorShifts = [
    ...colorBlock.matchAll(/packedColor(?: >> (\d+)u\))? & 0xffu/g),
  ].map((m) => Number(m[1] ?? 0));
  assert.match(
    colorBlock,
    /\/ 255\.0/,
    "the packed colour is no longer normalized to 0..1 by 255",
  );

  // The symmetric-matrix arrangement, read out of vertexMain rather than
  // assumed: this is where a swapped covariance half actually bites.
  const sigmaMatch = packed.match(
    /let Sigma = mat3x3<f32>\(\s*vec3<f32>\(([^)]*)\),\s*vec3<f32>\(([^)]*)\),\s*vec3<f32>\(([^)]*)\),\s*\);/,
  );
  assert.ok(
    sigmaMatch,
    "vertexMain no longer builds Sigma from a mat3x3 of vec3s",
  );
  const sigma = sigmaMatch
    .slice(1, 4)
    .map((column) => column.split(",").map((token) => token.trim()));

  return {
    stride,
    positionWords,
    covWords,
    covA: readVec3("covA"),
    covB: readVec3("covB"),
    sigma,
    colorWord: Number(colorWordMatch[1]),
    colorShifts,
  };
}

/**
 * Derive the SAME mapping from the shipped GLSL VS, the in-tree authority on
 * what the WASM writer produced.
 *
 * The GLSL addresses two texels per splat: `posCoord` = texel 2i (words 0-3)
 * and `covCoord` = texel 2i+1 (words 4-7), so `covariance.x/.y/.z/.w` are
 * words 4/5/6/7.
 */
function parseGlslDecode(glsl) {
  const componentWord = { x: 4, y: 5, z: 6, w: 7 };
  const uWords = {};
  for (const m of glsl.matchAll(
    /vec2 (u\d) = unpackHalf2x16\(covariance\.([xyzw])\)\s*;/g,
  )) {
    uWords[m[1]] = componentWord[m[2]];
  }
  const vrkMatch = glsl.match(/mat3 Vrk = mat3\(([^)]*)\);/);
  assert.ok(vrkMatch, `${GLSL_VS_PATH}: the Vrk mat3 construction is gone`);
  const vrkArgs = vrkMatch[1].split(",").map((token) => token.trim());
  assert.equal(vrkArgs.length, 9, `${GLSL_VS_PATH}: Vrk is not a 9-arg mat3`);
  const sigma = [vrkArgs.slice(0, 3), vrkArgs.slice(3, 6), vrkArgs.slice(6, 9)];

  // `covariance.w & 0xffu` for the low byte; `(covariance.w >> 8) & 0xffu` for
  // the rest — note the closing paren the shifted form carries.
  const colorShifts = [
    ...glsl
      .slice(glsl.indexOf("v_splatColor = vec4("))
      .matchAll(/covariance\.w(?: >> (\d+)\))? & 0xffu/g),
  ].map((m) => Number(m[1] ?? 0));

  return { uWords, sigma, colorShifts, positionWords: [0, 1, 2], colorWord: 7 };
}

/** Resolve a decode expression like `cov0.y` / `u1.x` to `[word, half]`. */
function resolveTerm(expression, wordsByName) {
  const [name, component] = expression.split(".");
  assert.ok(
    wordsByName[name] !== undefined,
    `unknown decode source "${name}" in "${expression}"`,
  );
  assert.ok(
    component === "x" || component === "y",
    `an unpacked f16 pair has only .x/.y; got "${expression}"`,
  );
  return [wordsByName[name], component === "x" ? 0 : 1];
}

/**
 * The WGSL Sigma columns are written in terms of `s.covA` / `s.covB`
 * components; flatten those to the underlying `cov0.x`-style expressions.
 */
function wgslSigmaTerms(map) {
  const byField = { covA: map.covA, covB: map.covB };
  const index = { x: 0, y: 1, z: 2 };
  return map.sigma.map((column) =>
    column.map((token) => {
      const m = token.match(/^s\.(covA|covB)\.([xyz])$/);
      assert.ok(m, `Sigma term "${token}" is not an s.covA/s.covB component`);
      return byField[m[1]][index[m[2]]];
    }),
  );
}

/** The full decode-agreement battery, so the mutants can re-run it verbatim. */
function assertDecodeAgreement(wgsl, glsl) {
  const map = parseWgslPackedDecode(wgsl);
  const glslMap = parseGlslDecode(glsl);
  assert.equal(
    map.stride,
    8,
    "the WASM record is 8 u32 (32 bytes) per splat — two RGBA32UI texels",
  );
  assert.deepEqual(
    map.positionWords,
    glslMap.positionWords,
    "position must come out of words 0-2 in both decodes",
  );
  assert.equal(map.colorWord, glslMap.colorWord);
  assert.deepEqual(
    map.colorShifts,
    glslMap.colorShifts,
    "the RGBA8 byte order must match the GLSL decode",
  );
  assert.deepEqual(map.colorShifts, [0, 8, 16, 24]);

  const mine = wgslSigmaTerms(map);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) {
      const a = resolveTerm(mine[column][row], map.covWords);
      const b = resolveTerm(glslMap.sigma[column][row], glslMap.uWords);
      assert.deepEqual(
        a,
        b,
        `covariance element [${column}][${row}] disagrees: WGSL reads ` +
          `${mine[column][row]} → word ${a[0]} half ${a[1]}, GLSL reads ` +
          `${glslMap.sigma[column][row]} → word ${b[0]} half ${b[1]}. ` +
          `A swapped half here draws a plausible but wrongly-oriented cloud ` +
          `that no pixel-count metric can catch.`,
      );
    }
  }
  return map;
}

test("HEAD: SPLAT_WGSL uses only the three preprocessor directives this spec resolves", () => {
  assertDirectiveVocabulary(extractSplatWgsl(readNormalized(RENDERER_PATH)));
  assert.match(
    readNormalized(PREPROCESSOR_PATH),
    /\(ifdef\|else\|endif\)/,
    `${PREPROCESSOR_PATH}: the directive grammar changed; this spec's resolver mirrors the three-form version`,
  );
});

test("HEAD: the packed WGSL decode and the GLSL decode name the same words and halves", () => {
  assertDecodeAgreement(
    extractSplatWgsl(readNormalized(RENDERER_PATH)),
    readNormalized(GLSL_VS_PATH),
  );
});

test("HEAD: a known (scale, rotation) covariance round-trips through the packed record", () => {
  // The exit gate's "known triple". Option B has no JS-side pack to test, so
  // the round-trip runs through the layout the WGSL says it reads: build Sigma
  // from a scale + quaternion, write the 8-u32 record the way the WASM writer
  // does, then decode with the WGSL's OWN parsed word/half mapping.
  const scale = [0.35, 0.08, 1.25];
  const angle = (37 * Math.PI) / 180;
  const axis = [1, 2, 3];
  const axisLength = Math.hypot(...axis);
  const sinHalf = Math.sin(angle / 2) / axisLength;
  const x = axis[0] * sinHalf;
  const y = axis[1] * sinHalf;
  const z = axis[2] * sinHalf;
  const w = Math.cos(angle / 2);
  // Column-major rotation matrix from the quaternion.
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
  // M = R * diag(scale); Sigma = M * M^T (symmetric by construction).
  const M = R.map((column, c) => column.map((value) => value * scale[c]));
  const sigma = [0, 1, 2].map((r) =>
    [0, 1, 2].map((c) =>
      [0, 1, 2].reduce((sum, k) => sum + M[k][r] * M[k][c], 0),
    ),
  );

  const record = new Uint32Array(8);
  const position = [12.5, -3.25, 0.125];
  record[0] = floatToBits(position[0]);
  record[1] = floatToBits(position[1]);
  record[2] = floatToBits(position[2]);
  record[3] = 0;
  // (Sxx, Sxy), (Sxz, Syy), (Syz, Szz) — the order the GLSL decode implies.
  record[4] = packHalf2(sigma[0][0], sigma[0][1]);
  record[5] = packHalf2(sigma[0][2], sigma[1][1]);
  record[6] = packHalf2(sigma[1][2], sigma[2][2]);
  const color = [200, 128, 64, 255];
  record[7] =
    (color[0] | (color[1] << 8) | (color[2] << 16) | (color[3] << 24)) >>> 0;

  const map = assertDecodeAgreement(
    extractSplatWgsl(readNormalized(RENDERER_PATH)),
    readNormalized(GLSL_VS_PATH),
  );
  const unpacked = {};
  for (const [name, word] of Object.entries(map.covWords)) {
    unpacked[name] = unpackHalf2(record[word]);
  }
  const decodedSigma = wgslSigmaTerms(map).map((column) =>
    column.map((token) => {
      const [, half] = resolveTerm(token, map.covWords);
      return unpacked[token.split(".")[0]][half];
    }),
  );

  // f16 carries ~3 decimal digits and these terms are O(1), so 1e-3 is tight
  // while still separating "decoded correctly" from "decoded off by a half":
  // the closest pair of distinct terms here differs by more than 0.05.
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      assert.ok(
        Math.abs(decodedSigma[c][r] - sigma[c][r]) < 1e-3,
        `Sigma[${c}][${r}]: decoded ${decodedSigma[c][r]} vs expected ${sigma[c][r]}`,
      );
    }
  }
  // Symmetry is what the 6-term packing assumes; a mis-mapped decode generally
  // stops reconstructing a symmetric matrix.
  assert.ok(Math.abs(decodedSigma[0][1] - decodedSigma[1][0]) < 1e-9);
  assert.ok(Math.abs(decodedSigma[0][2] - decodedSigma[2][0]) < 1e-9);
  assert.ok(Math.abs(decodedSigma[1][2] - decodedSigma[2][1]) < 1e-9);

  const decodedPosition = map.positionWords.map((word) => {
    BITS_VIEW.setUint32(0, record[word]);
    return BITS_VIEW.getFloat32(0);
  });
  assert.deepEqual(decodedPosition, position);
  const decodedColor = map.colorShifts.map(
    (shift) => (record[map.colorWord] >>> shift) & 0xff,
  );
  assert.deepEqual(decodedColor, color);
});

test("HEAD: the WASM texture layout really is a flat count*8 run (the slice's premise)", () => {
  // `resolveSplatSource` slices `data.subarray(0, count * 8)`. That is only
  // correct because the GLSL row addressing collapses to texel 2*i — an
  // ALGEBRAIC fact about the mask/shift the engine computes, not a comment.
  // Both halves are read out of the engine here rather than assumed.
  const primitive = readNormalized(PRIMITIVE_PATH);
  assert.match(
    primitive,
    /const splatRowShift = Math\.log2\(maxTex \/ 2\);/,
    `${PRIMITIVE_PATH}: the row shift formula changed — re-derive the flat-run proof`,
  );
  assert.match(
    primitive,
    /const splatRowMask = maxTex \/ 2 - 1;/,
    `${PRIMITIVE_PATH}: the row mask formula changed — re-derive the flat-run proof`,
  );
  assert.match(
    primitive,
    /const optimalWidth = maxTex;/,
    `${PRIMITIVE_PATH}: the texture width is no longer maximumTextureSize`,
  );
  assert.match(
    readNormalized(GLSL_VS_PATH),
    /ivec2 posCoord = ivec2\(int\(\(texIdx & rowMask\) << 1\), int\(texIdx >> rowShift\)\);/,
    `${GLSL_VS_PATH}: the row addressing changed — the flat count*8 slice may no longer be valid`,
  );

  for (const maxTex of [2048, 4096, 8192, 16384]) {
    const rowShift = Math.log2(maxTex / 2);
    const rowMask = maxTex / 2 - 1;
    for (const i of [0, 1, 26, 4095, 4096, 286867, maxTex * 3 + 7]) {
      assert.equal(
        (i >>> rowShift) * maxTex + ((i & rowMask) << 1),
        2 * i,
        `maxTex=${maxTex} i=${i}: the row-addressed texel is not 2*i, so the ` +
          `splat records are NOT a flat run and subarray(0, count*8) is wrong`,
      );
    }
  }
});

test("HEAD: every SPLAT_WGSL variant passes Naga WGSL validation", async () => {
  const wgsl = extractSplatWgsl(readNormalized(RENDERER_PATH));
  assertDirectiveVocabulary(wgsl);
  const nagaDirectory = join(ROOT, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: readFileSync(
      join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  for (const flags of [
    [],
    ["LOG_DEPTH"],
    ["SPLAT_PACKED_WASM"],
    ["LOG_DEPTH", "SPLAT_PACKED_WASM"],
  ]) {
    const code = resolveDirectives(wgsl, new Set(flags));
    assert.doesNotThrow(
      () => naga.validate_wgsl(code),
      `SPLAT_WGSL variant [${flags.join("+") || "none"}] does not validate`,
    );
  }
});

test("HEAD: the layout axis is a registered hi-word define, consumed by the shader", () => {
  const defines = readNormalized(DEFINES_PATH);
  assert.match(
    defines,
    /SPLAT_PACKED_WASM: hiDefineBit\(2\),/,
    `${DEFINES_PATH}: SPLAT_PACKED_WASM must stay on hi bit 2 — the registry is ADD-ONLY, and renumbering silently aliases cached shader modules`,
  );
  // The two bits already claimed must not have moved.
  assert.match(defines, /HI_WORD_PROBE: hiDefineBit\(0\),/);
  assert.match(defines, /ENHANCED_OCEAN: hiDefineBit\(1\),/);

  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    extractSplatWgsl(renderer),
    /\/\/>>ifdef SPLAT_PACKED_WASM/,
    `${RENDERER_PATH}: nothing in SPLAT_WGSL gates on the layout define`,
  );
  // The module cache must receive it as `definesHi`, not folded into the lo
  // mask — the lo word is full and a lo/hi mix-up resolves against the wrong
  // registry.
  assert.match(
    renderer,
    /const layoutDefinesHi = packedWasmLayout\s*\n?\s*\?\s*ShaderDefineHi\.SPLAT_PACKED_WASM\s*\n?\s*:\s*0;/,
    `${RENDERER_PATH}: the layout axis no longer resolves to a ShaderDefineHi bit`,
  );
  // Every `getOrCreate` call site, sliced by argument-list balance rather than
  // by a regex that would have to guess at prettier's line breaking (the three
  // sites are formatted differently: one statement, two ternary arms).
  const moduleCalls = [];
  const needle = "moduleCache.getOrCreate(";
  for (
    let at = renderer.indexOf(needle);
    at !== -1;
    at = renderer.indexOf(needle, at + 1)
  ) {
    let depth = 0;
    let end = at + needle.length - 1;
    do {
      const ch = renderer[end];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      end++;
    } while (depth > 0 && end < renderer.length);
    moduleCalls.push(renderer.slice(at, end));
  }
  assert.equal(
    moduleCalls.length,
    3,
    `${RENDERER_PATH}: expected exactly the base/log/pick shader-module fetches; found ${moduleCalls.length}`,
  );
  for (const call of moduleCalls) {
    assert.match(
      call,
      /layoutDefinesHi,?\s*\)$/,
      `${RENDERER_PATH}: a shader-module fetch does not pass the layout axis as its LAST argument (definesHi) — that variant would decode at the wrong stride:\n${call}`,
    );
  }
  // ...and the pipeline descriptor names carry it, so `describeCacheKey()` and
  // devtools can tell the two variants apart (CLAUDE.md: keep every marker).
  for (const marker of [
    /GaussianSplat color pipeline \[ld=\$\{[^}]*\}\/ms=\$\{sampleCount\}\/packed=\$\{layoutMarker\}\]/,
    /GaussianSplat depth-write pipeline \[ld=\$\{[^}]*\}\/ms=\$\{sampleCount\}\/packed=\$\{layoutMarker\}\]/,
    /GaussianSplat pick pipeline \[packed=\$\{layoutMarker\}\]/,
    /GaussianSplat velocity pipeline \[ld=\$\{[\s\S]{0,80}?\}\/packed=\$\{cache\.layoutPacked \? 1 : 0\}\]/,
  ]) {
    assert.match(
      renderer,
      marker,
      `${RENDERER_PATH}: a splat pipeline descriptor name lost its packed= marker`,
    );
  }
});

test("HEAD: the packed path preserves the RTE cancellation structure", () => {
  const wgsl = extractSplatWgsl(readNormalized(RENDERER_PATH));
  const packed = resolveDirectives(wgsl, new Set(["SPLAT_PACKED_WASM"]));
  // CLAUDE.md, 64-Bit Precision & RTE: never `mvp * position`; always subtract
  // the encoded camera FIRST and transform the small residual.
  assert.match(
    packed,
    /let posRTE = \(positionHigh - u\.encodedCameraHigh\)\s*\n?\s*\+ \(positionLow - u\.encodedCameraLow\);/,
    `${RENDERER_PATH}: the packed variant no longer subtracts the encoded camera before transforming`,
  );
  assert.match(
    packed,
    /let clipPos = u\.mvpRelativeToEye \* vec4<f32>\(posRTE, 1\.0\);/,
    `${RENDERER_PATH}: the packed variant projects something other than the RTE residual`,
  );
  // The named decision: positionLow is ZERO because the WASM record has no low
  // word, and the lane is kept rather than deleted so the cancellation shape is
  // identical in both variants.
  assert.match(
    packed,
    /s\.positionLow = vec3<f32>\(0\.0, 0\.0, 0\.0\);/,
    `${RENDERER_PATH}: the packed variant's positionLow lane was dropped instead of zeroed — the RTE structure is what makes the camera-side split worth anything`,
  );
  assert.doesNotMatch(
    packed,
    /mvpRelativeToEye \* vec4<f32>\(positionHigh/,
    `${RENDERER_PATH}: a raw model-space position reached the MVP multiply`,
  );
  // ...and the camera really is encoded high/low in the primitive's model frame
  // on the CPU side, which is the half that buys the precision here.
  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    renderer,
    /const camM = Matrix4\.multiplyByPoint\(invM, camWorld, new Cartesian3\(\)\);\s*\n\s*EncodedCartesian3\.fromCartesian\(camM, scratchEncoded\);/,
    `${RENDERER_PATH}: the camera is no longer transformed into model space and split high/low`,
  );
});

test("HEAD: the renderer transforms splats by _rootTransform, not a missing modelMatrix", () => {
  const renderer = readNormalized(RENDERER_PATH);
  // A production GaussianSplatPrimitive has NO modelMatrix; its WebGL command
  // uses _rootTransform. Reading modelMatrix alone puts the cloud at the
  // geocentre — invisible to every count-based check, and catastrophic on screen.
  assert.match(
    renderer,
    /return fields\._rootTransform \?\? fields\.modelMatrix \?\? Matrix4\.IDENTITY;/,
    `${RENDERER_PATH}: splatModelMatrix no longer prefers _rootTransform`,
  );
  for (const site of [
    /const mm = splatModelMatrix\(primitive\);\s*\n\s*Matrix4\.multiply\(us\.view, mm, scratchMV\);/,
    /const mm = splatModelMatrix\(primitive\);\s*\n\s*Matrix4\.multiply\(us\.view, mm, scratchSortMV\);/,
  ]) {
    assert.match(
      renderer,
      site,
      `${RENDERER_PATH}: a modelView build bypasses splatModelMatrix`,
    );
  }
  assert.doesNotMatch(
    renderer,
    /const mm = primitive\.modelMatrix \?\? Matrix4\.IDENTITY;/,
    `${RENDERER_PATH}: the pre-C15-G3 modelMatrix-only read is back`,
  );
  // The WebGL side this mirrors, pinned so a change there is caught here.
  assert.match(
    readNormalized(PRIMITIVE_PATH),
    /const modelMatrix = Matrix4\.clone\(\s*\n?\s*primitive\._rootTransform,/,
    `${PRIMITIVE_PATH}: the WebGL DrawCommand no longer uses _rootTransform as its modelMatrix`,
  );
});

test("HEAD: the WASM sort permutation is consumed, and the JS comparator cannot see it", () => {
  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    renderer,
    /_indexes\?: Uint32Array \}\)\._indexes;/,
    `${RENDERER_PATH}: the shared radix-sort permutation is no longer read`,
  );
  assert.match(
    renderer,
    /device\.queue\.writeBuffer\(cache\.sortedIndexBuffer, 0, indexes\);/,
    `${RENDERER_PATH}: primitive._indexes is read but never uploaded`,
  );
  // Length equality is not optional: a permutation of a different length would
  // index outside the splat buffer (WebGPU clamps to 0 — one splat drawn N
  // times, which reads as a rendering bug rather than a data bug).
  assert.match(
    renderer,
    /indexes\.length !== count/,
    `${RENDERER_PATH}: the provided permutation is uploaded without a length check`,
  );
  // The comparator must be structurally unreachable for packed data: it is a
  // synchronous main-thread Array.prototype.sort and `tower` is 286,868
  // elements per re-sort.
  assert.match(
    renderer,
    /if \(cache\.layoutPacked\) \{\s*\n\s*return;\s*\n\s*\}/,
    `${RENDERER_PATH}: maybeSortSplats no longer refuses the packed layout — a 286k-element JS sort is back on the main thread`,
  );
  assert.match(
    renderer,
    /if \(!uploadProvidedSortOrder\(device, primitive, cache\)\) \{\s*\n\s*maybeSortSplats\(device, primitive, frameState, cache\);\s*\n\s*\}/,
    `${RENDERER_PATH}: the comparator is no longer gated behind the provided-permutation upload`,
  );
});

test("HEAD: buffer sizes come from the resident record stride, never a literal", () => {
  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    renderer,
    /const requiredBytes = cache\.splatCount \* cache\.splatRecordBytes;/,
    `${RENDERER_PATH}: the velocity prev-buffer size is not derived from the resident layout`,
  );
  assert.doesNotMatch(
    renderer,
    /cache\.splatCount \* 64/,
    `${RENDERER_PATH}: a hardcoded 64-byte stride is back — it over-allocates and over-copies against a 32-byte packed buffer`,
  );
  assert.match(renderer, /const PACKED_SPLAT_RECORD_BYTES = 32;/);
  assert.match(renderer, /const LEGACY_SPLAT_RECORD_BYTES = 64;/);
  // The commit's dirty signal must include the producer identity: a snapshot
  // rebuild landing on the SAME count produces a new payload and nothing else
  // changes, so a count-only check leaves the old cloud resident forever.
  assert.match(
    renderer,
    /cache\.splatSourceToken !== source\.token/,
    `${RENDERER_PATH}: the buffer commit's dirty signal no longer includes the producer identity`,
  );
  // ...and the layout is a pipeline-invalidation axis, not just a decode flag.
  assert.match(
    renderer,
    /const layoutFlipped =\s*\n?\s*cache\.initialized && cache\.resourcesLayoutPacked !== activeLayoutPacked;/,
    `${RENDERER_PATH}: a layout change no longer invalidates the pipeline resources — the first-built variant would be served for the other stride`,
  );
  // The flip must compare against the layout the PIPELINES were built for, not
  // the buffer's: the buffer commit sits below `tryResolveSplatPipelines`'s
  // early return, so comparing the buffer would re-invalidate and re-request
  // the pipelines on every frame of a cold compile.
  assert.match(
    renderer,
    /cache\.resourcesLayoutPacked = activeLayoutPacked;/,
    `${RENDERER_PATH}: the pipeline resources no longer record which layout they compiled for`,
  );
  // Withdrawal path: the tileset can unload, and a cloud whose source is gone
  // must stop drawing rather than rasterize stale bytes forever.
  assert.match(
    renderer,
    /\} else if \(!splatData && cache\.splatCount > 0 && cache\.layoutPacked\) \{/,
    `${RENDERER_PATH}: the packed source-withdrawal path is gone — an unloaded tileset keeps drawing`,
  );
});

test("HEAD: the dynamic-OIT shader source is preprocessed, not the raw template", () => {
  // `WebGPUSceneRendererTranslucentPass` compiles `_shaderCode` directly when a
  // command has no `_oitPipeline`. WGSL reads `//>>ifdef` as a comment, so the
  // raw template would compile with BOTH branches of every block present — two
  // `fragmentMain` definitions — and here, with the wrong record stride.
  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    renderer,
    /cmd\._shaderCode = preprocess\(\s*\n\s*SPLAT_WGSL,\s*\n\s*0,\s*\n\s*cache\.layoutPacked \? ShaderDefineHi\.SPLAT_PACKED_WASM : 0,\s*\n\s*\);/,
    `${RENDERER_PATH}: _shaderCode is not the preprocessed source for the resident layout`,
  );
  assert.doesNotMatch(
    renderer,
    /cmd\._shaderCode = SPLAT_WGSL;/,
    `${RENDERER_PATH}: the raw ifdef-bearing template is assigned to _shaderCode again`,
  );
});

// WGSL-source mutants. Each is applied to a COPY of the extracted shader and
// the decode-agreement battery must reject it. Without these, an anchor that
// silently stopped matching anything would pass forever.
const WGSL_MUTANTS = [
  {
    name: "covariance halves swapped within a word (Syz <-> Szz)",
    mutate: (wgsl) =>
      wgsl.replace(
        "s.covB = vec3<f32>(cov1.y, cov2.x, cov2.y);",
        "s.covB = vec3<f32>(cov1.y, cov2.y, cov2.x);",
      ),
  },
  {
    name: "covariance halves swapped across words (Sxz <-> Syy)",
    mutate: (wgsl) =>
      wgsl
        .replace(
          "s.covA = vec3<f32>(cov0.x, cov0.y, cov1.x);",
          "s.covA = vec3<f32>(cov0.x, cov0.y, cov1.y);",
        )
        .replace(
          "s.covB = vec3<f32>(cov1.y, cov2.x, cov2.y);",
          "s.covB = vec3<f32>(cov1.x, cov2.x, cov2.y);",
        ),
  },
  {
    name: "colour read from the wrong word",
    mutate: (wgsl) =>
      wgsl.replace(
        "let packedColor = splats[base + 7u];",
        "let packedColor = splats[base + 6u];",
      ),
  },
  {
    name: "colour channels byte-reversed (BGRA)",
    mutate: (wgsl) =>
      wgsl.replace(
        "    f32(packedColor & 0xffu),\n    f32((packedColor >> 8u) & 0xffu),\n    f32((packedColor >> 16u) & 0xffu),",
        "    f32((packedColor >> 16u) & 0xffu),\n    f32((packedColor >> 8u) & 0xffu),\n    f32(packedColor & 0xffu),",
      ),
  },
  {
    name: "packed stride left at the legacy 16 words",
    mutate: (wgsl) =>
      wgsl.replace("  let base = index * 8u;", "  let base = index * 16u;"),
  },
  {
    name: "position words shifted by one",
    mutate: (wgsl) =>
      wgsl.replace(
        "    bitcast<f32>(splats[base]),\n    bitcast<f32>(splats[base + 1u]),\n    bitcast<f32>(splats[base + 2u]),\n  );\n  s.positionLow = vec3<f32>(0.0, 0.0, 0.0);",
        "    bitcast<f32>(splats[base + 1u]),\n    bitcast<f32>(splats[base + 2u]),\n    bitcast<f32>(splats[base + 3u]),\n  );\n  s.positionLow = vec3<f32>(0.0, 0.0, 0.0);",
      ),
  },
  {
    name: "Sigma rebuilt asymmetrically (covB.y dropped from the off-diagonal)",
    mutate: (wgsl) =>
      wgsl.replace(
        "    vec3<f32>(s.covA.z, s.covB.y, s.covB.z),\n  );\n  let SV = R * Sigma * transpose(R);\n  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];\n  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];\n  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;\n  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;\n  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;\n  let det = c00*c11 - c01*c01;\n  if (det <= 0.0) {\n    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);",
        "    vec3<f32>(s.covA.z, s.covB.x, s.covB.z),\n  );\n  let SV = R * Sigma * transpose(R);\n  let a = SV[0][0]; let b = SV[1][0]; let c = SV[2][0];\n  let d = SV[1][1]; let e = SV[2][1]; let f = SV[2][2];\n  let c00 = J00*J00*a + 2.0*J00*J02*c + J02*J02*f + 0.3;\n  let c01 = J00*J11*b + J02*J11*e + J00*J12*c + J02*J12*f;\n  let c11 = J11*J11*d + 2.0*J11*J12*e + J12*J12*f + 0.3;\n  let det = c00*c11 - c01*c01;\n  if (det <= 0.0) {\n    output.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);",
      ),
  },
];

for (const mutant of WGSL_MUTANTS) {
  test(`WGSL mutant rejected: ${mutant.name}`, () => {
    const real = extractSplatWgsl(readNormalized(RENDERER_PATH));
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      `the mutation did not apply — the anchor text moved and this mutant now proves nothing`,
    );
    const glsl = readNormalized(GLSL_VS_PATH);
    assert.throws(
      () => assertDecodeAgreement(mutated, glsl),
      undefined,
      `${mutant.name}: the decode-agreement battery accepted the mutated shader`,
    );
  });
}
