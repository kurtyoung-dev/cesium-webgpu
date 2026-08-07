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
  AZIMUTH_HEADINGS,
  CONTROL_LANES,
  EXIT_CODE,
  PREDICT,
  PRESENT_MARKER,
  STAGE,
  STRUCTURAL_PRECONDITIONS,
  angleBetweenDegrees,
  classifyWebgpuPresence,
  evaluateAzimuthLane,
  evaluateCovarianceControl,
  evaluateParity,
  evaluateReferenceLeg,
  evaluateShOffControl,
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
    // C15-G4b — a healthy lane reached the determinism pair with the splat sort
    // already quiet. Defaulting this to `true` in the fixture is safe ONLY
    // because the violation table below drives it to `false` and requires the
    // `sort-quiesced` precondition to be the one that fires.
    sortQuiesced: true,
    sortQuiesceMs: 2_100,
    sortSignatureAtCapture: "4/1/4/286868/1/0",
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
      // C15-G4b — a run that never reached sort quiescence must be refused by
      // its OWN precondition. Note the determinism number stays perfect here:
      // a scene that is still re-ordering itself can absolutely produce two
      // identical captures by luck, which is why quiescence is asserted
      // separately instead of being inferred from a good determinism reading.
      "sort-quiesced": { sortQuiesced: false, sortQuiesceMs: 120_000 },
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

/**
 * The `//>>ifdef` axes `SPLAT_WGSL` can be compiled with. Order is irrelevant;
 * completeness is not — the Naga matrix enumerates the power set of this list
 * and cross-checks it against the flags the shader text actually gates on.
 */
const SHADER_AXES = [
  "LOG_DEPTH",
  "SPLAT_PACKED_WASM",
  "SPLAT_SPHERICAL_HARMONICS",
];

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
  // C15-G5 — the matrix is now the FULL power set of the three axes the
  // renderer can combine (LOG_DEPTH x SPLAT_PACKED_WASM x
  // SPLAT_SPHERICAL_HARMONICS), enumerated rather than listed, so adding a
  // fourth axis to SHADER_AXES cannot leave half the combinations unvalidated.
  const combinations = [];
  for (let mask = 0; mask < 1 << SHADER_AXES.length; mask++) {
    combinations.push(SHADER_AXES.filter((_, bit) => mask & (1 << bit)));
  }
  assert.equal(
    combinations.length,
    8,
    "the splat shader has three independent //>>ifdef axes; every one of the 8 combinations is reachable at runtime",
  );
  // Every axis the SHADER actually gates on must be in the enumerated list, or
  // the matrix silently stops covering it.
  const gatedFlags = new Set(
    [...wgsl.matchAll(/^\s*\/\/>>ifdef ([A-Z_][A-Z0-9_]*)$/gm)].map(
      (m) => m[1],
    ),
  );
  for (const flag of gatedFlags) {
    assert.ok(
      SHADER_AXES.includes(flag),
      `SPLAT_WGSL gates on ${flag}, which is not in the enumerated Naga variant matrix`,
    );
  }
  for (const flags of combinations) {
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
  // registry. `C15-G5` widened this to an OR of two hi-word axes; both arms
  // are pinned so neither can be dropped or swapped for a lo-word bit.
  assert.match(
    renderer,
    /const layoutDefinesHi =\s*\n?\s*\(packedWasmLayout \? ShaderDefineHi\.SPLAT_PACKED_WASM : 0\) \|\s*\n?\s*\(sphericalHarmonics \? ShaderDefineHi\.SPLAT_SPHERICAL_HARMONICS : 0\);/,
    `${RENDERER_PATH}: the layout / SH axes no longer resolve to ShaderDefineHi bits`,
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
    /GaussianSplat color pipeline \[ld=\$\{[^}]*\}\/ms=\$\{sampleCount\}\/packed=\$\{layoutMarker\}\/sh=\$\{shMarker\}\]/,
    /GaussianSplat depth-write pipeline \[ld=\$\{[^}]*\}\/ms=\$\{sampleCount\}\/packed=\$\{layoutMarker\}\/sh=\$\{shMarker\}\]/,
    /GaussianSplat pick pipeline \[packed=\$\{layoutMarker\}\/sh=\$\{shMarker\}\]/,
    /GaussianSplat velocity pipeline \[ld=\$\{[\s\S]{0,80}?\}\/packed=\$\{cache\.layoutPacked \? 1 : 0\}\/sh=\$\{cache\.shEnabled \? 1 : 0\}\]/,
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
  // C15-G4 widened the cast to carry the permutation's provenance alongside it,
  // so the anchor is on the READ, not on the cast's one-field shape.
  assert.match(
    renderer,
    /_indexes\?: Uint32Array;/,
    `${RENDERER_PATH}: the shared radix-sort permutation is no longer read`,
  );
  assert.match(
    renderer,
    /const indexes = fields\._indexes;/,
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

// ────────────────────────────────────────────────────────────────────────────
// NEW-WEBGPU-SPLAT-OIT-FALLBACK-UNUSABLE — both halves.
//
// `WebGPUSceneRendererTranslucentPass` (`:165-205`) builds an OIT pipeline for
// any command carrying `_shaderCode` but no `_oitPipeline`. The splat command
// is one of only two `_shaderCode` producers in the tree, and it was
// mis-configured in two independent ways:
//
//   1. the RAW `//>>ifdef`-bearing template was assigned (WGSL reads those as
//      comments, so both branches of every block would compile — two
//      `fragmentMain` definitions). FIXED at `C15-G3`;
//   2. no `_pipelineConfig`, so the fallback substituted `layout: "auto"` while
//      the command's cached bind groups were built against an EXPLICIT
//      `GPUPipelineLayout` — a validation error, not a visual difference.
//      FIXED here.
//
// `C15-G5` then added a third: the inline re-derivation of the define mask
// carried the layout axis but NOT `SPLAT_SPHERICAL_HARMONICS`, so the fallback
// would have composited the base colour while the colour pass composited the
// view-dependent one. The repair is structural — both halves are published as a
// PAIR from the same resource build the bind-group layout came from, so a
// future axis cannot reach one and miss the other.
// ────────────────────────────────────────────────────────────────────────────

const OIT_FALLBACK_ANCHORS = [
  {
    label:
      "the fallback shader source is preprocessed for the FULL define mask",
    pattern:
      /const oitFallbackShaderCode = preprocess\(SPLAT_WGSL, 0, layoutDefinesHi\);/,
    why: "a mask re-derived from one axis drops every other axis the compiled OIT module carries",
  },
  {
    // Deliberately EXACT and contiguous rather than `[\s\S]*?`-separated: a
    // lazy gap runs past the object's closing brace and can satisfy itself on
    // an unrelated `layout,` later in the file, which is exactly how the first
    // draft of this anchor let the `layout: "auto"` mutant survive.
    label:
      "the fallback config carries the EXPLICIT pipeline layout and the splat vertex buffers",
    pattern:
      /const oitFallbackConfig: WebGPUPipelineConfig = \{\n {4}label: [^\n]*\n {4}layout,\n {4}vertexBuffers: SPLAT_VERTEX_BUFFERS,\n/,
    why: '`layout: "auto"` derives a different layout object, and binding the command\'s cached bind groups to it is a validation error; the vertex buffers must match the ones the command binds',
  },
  {
    label: "the command publishes BOTH halves, from the cache, as a pair",
    pattern:
      /cmd\._shaderCode = cache\.oitFallbackShaderCode \?\? undefined;\s*\n\s*cmd\._pipelineConfig = cache\.oitFallbackConfig \?\? undefined;/,
    why: "publishing one without the other is exactly the state this row found",
  },
  {
    label: "both halves come from the SAME resource build",
    pattern:
      /cache\.oitFallbackShaderCode = resources\.oitFallbackShaderCode;\s*\n\s*cache\.oitFallbackConfig = resources\.oitFallbackConfig;/,
    why: "a shader mask from one build and a layout from another is the drift the pairing exists to prevent",
  },
];

function assertOitFallbackAnchors(source) {
  for (const anchor of OIT_FALLBACK_ANCHORS) {
    assert.match(source, anchor.pattern, `${anchor.label}: ${anchor.why}`);
  }
  assert.doesNotMatch(
    source,
    /cmd\._shaderCode = SPLAT_WGSL;/,
    "the raw ifdef-bearing template is assigned to _shaderCode again",
  );
  // The fallback config must be built OUTSIDE the try/catch that produces
  // `oitDescriptor`: a null descriptor means the injection threw, which is one
  // of the two states in which the fallback is actually reached.
  const buildAt = source.indexOf("const oitFallbackShaderCode = preprocess(");
  const catchAt = source.indexOf(
    "// OIT variant creation is non-fatal — falls back to standard alpha blending",
  );
  assert.ok(
    buildAt !== -1 && catchAt !== -1 && buildAt > catchAt,
    "the fallback config is built inside the OIT try/catch — it would be null in exactly the case the fallback exists for",
  );
}

test("HEAD: the dynamic-OIT fallback carries a preprocessed source AND the explicit layout", () => {
  assertOitFallbackAnchors(readNormalized(RENDERER_PATH));
});

test("HEAD: the translucent pass really does fall back to layout:auto without a config", () => {
  // The premise. If the consumer stopped substituting `layout: "auto"`, the
  // whole row would be moot — and the anchors above would keep passing while
  // pinning something that no longer matters.
  const pass = readNormalized(
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererTranslucentPass.ts",
  );
  assert.match(
    pass,
    /const pipelineConfig = cmd\._pipelineConfig as/,
    "the fallback no longer reads _pipelineConfig off the command",
  );
  assert.match(
    pass,
    /pipelineConfig \?\? \{[\s\S]*?layout: "auto",/,
    'the fallback no longer substitutes layout: "auto" — re-read the row before changing the producer side',
  );
});

const OIT_FALLBACK_MUTANTS = [
  {
    name: "the fallback mask is re-derived from the layout axis alone (the C15-G5 shape)",
    mutate: (source) =>
      source.replace(
        "const oitFallbackShaderCode = preprocess(SPLAT_WGSL, 0, layoutDefinesHi);",
        "const oitFallbackShaderCode = preprocess(\n    SPLAT_WGSL,\n    0,\n    packedWasmLayout ? ShaderDefineHi.SPLAT_PACKED_WASM : 0,\n  );",
      ),
  },
  {
    name: 'the fallback config falls back to layout: "auto"',
    mutate: (source) =>
      source.replace(
        "  const oitFallbackConfig: WebGPUPipelineConfig = {\n    label: `GaussianSplat [packed=${layoutMarker}/sh=${shMarker}]`,\n    layout,",
        '  const oitFallbackConfig: WebGPUPipelineConfig = {\n    label: `GaussianSplat [packed=${layoutMarker}/sh=${shMarker}]`,\n    layout: "auto",',
      ),
  },
  {
    name: "only the shader half is published on the command",
    mutate: (source) =>
      source.replace(
        "    cmd._pipelineConfig = cache.oitFallbackConfig ?? undefined;",
        "",
      ),
  },
  {
    name: "the raw template is assigned again",
    mutate: (source) =>
      source.replace(
        "    cmd._shaderCode = cache.oitFallbackShaderCode ?? undefined;",
        "    cmd._shaderCode = SPLAT_WGSL;",
      ),
  },
];

test("HEAD: the OIT-fallback anchors reject every plausible half-fix", () => {
  const real = readNormalized(RENDERER_PATH);
  assertOitFallbackAnchors(real);
  for (const mutant of OIT_FALLBACK_MUTANTS) {
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      `mutant "${mutant.name}" changed nothing — its target text moved`,
    );
    assert.throws(
      () => assertOitFallbackAnchors(mutated),
      `mutant "${mutant.name}" survived the anchors`,
    );
  }
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
    // `String.replace` hits the FIRST occurrence, which is vertexMain's Sigma
    // — the one `parseWgslPackedDecode` reads.
    mutate: (wgsl) =>
      wgsl.replace(
        "vec3<f32>(s.covA.z, s.covB.y, s.covB.z),",
        "vec3<f32>(s.covA.z, s.covB.x, s.covB.z),",
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

// ────────────────────────────────────────────────────────────────────────────
// C15-G3b — the two defects the FIRST real Edge run surfaced.
//
// (1) `cache.splatCount` read 0 on a run whose scored frame painted 61% of the
//     canvas. Not a contradiction: the probe sampled a RENDERER-owned field the
//     frame the SHARED signal went true, and at that instant the splat pipeline
//     was still compiling so the feature renderer had returned early.
// (2) The WebGPU splat footprint was ~3.5x WebGL's AREA — not SH, not the
//     record decode (which is bit-exact and pinned above), but two conventions
//     the Batch-288 shader never matched: a 3-sigma square support where WebGL
//     uses a sqrt(2)-sigma oriented quad, and the true gaussian where WebGL
//     renders exp(-4*dot(corner,corner)).
// ────────────────────────────────────────────────────────────────────────────

test("HEAD: the buffer commit sits ABOVE the pipeline gate", () => {
  // The Batch-881 mechanism. `tryResolveSplatPipelines` legitimately returns
  // early for however long a cold variant compiles (~2.7 s on this fork). With
  // the commit below it, `cache.splatCount` — the renderer's own "is the data
  // resident" signal — stayed 0 for that whole window even though the shared
  // pipeline had committed the snapshot. Uploading attribute bytes needs the
  // device, not a pipeline.
  const source = readNormalized(RENDERER_PATH);
  const commit = source.indexOf("// ── C15-G3 — commit the attribute bytes.");
  const gate = source.indexOf("    !tryResolveSplatPipelines(");
  const countGuard = source.indexOf("if (cache.splatCount === 0) {");
  assert.notEqual(commit, -1, `${RENDERER_PATH}: the commit block is gone`);
  assert.notEqual(gate, -1, `${RENDERER_PATH}: the pipeline gate is gone`);
  assert.notEqual(countGuard, -1, `${RENDERER_PATH}: the count guard is gone`);
  assert.ok(
    commit < gate,
    `${RENDERER_PATH}: the attribute-buffer commit is BELOW the pipeline gate again — cache.splatCount will read 0 for the whole duration of a cold pipeline compile, which is exactly what Batch 881 measured`,
  );
  assert.ok(
    gate < countGuard,
    `${RENDERER_PATH}: the count guard moved above the pipeline gate — pipelines would then only start compiling after data arrives, delaying first pixels by a full compile`,
  );
});

test("probe: renderer-owned stats are sampled at the SCORED frame", () => {
  // `classifyWebgpuPresence` folds `cacheSplatCount` in as its `dataCommitted`
  // signal, so the sample must describe the frame the pixels were measured on.
  // Batch 881 exited 1 on precisely this: a stat read during readiness, a
  // verdict rendered against a frame captured much later.
  assert.match(
    PROBE_CODE,
    /const sampleRendererStats = \(\) => \{/,
    "the renderer-owned stat read must be a reusable sampler, not a one-shot",
  );
  const samples = [...PROBE_CODE.matchAll(/^\s*sampleRendererStats\(\);$/gm)];
  assert.ok(
    samples.length >= 2,
    `the renderer stats must be sampled at least twice (once at readiness, once at the scored frame); found ${samples.length}`,
  );
  // The scored sample must come AFTER the ON capture and the command counts,
  // with no intervening yield — same task, fleet doctrine.
  const onCapture = PROBE_CODE.indexOf("const onA = captureNow();");
  const commandCount = PROBE_CODE.indexOf("record.commandListSplatCommands");
  const lastSample = PROBE_CODE.lastIndexOf("sampleRendererStats();");
  assert.notEqual(onCapture, -1, "the scored ON capture moved");
  assert.ok(
    onCapture < commandCount && commandCount < lastSample,
    "the final renderer-stat sample must follow the scored capture and the command counts, in the same task",
  );
  const between = PROBE_CODE.slice(commandCount, lastSample);
  assert.doesNotMatch(
    between,
    /await |settleMs\(/,
    "a yield between the scored frame and the renderer-stat sample makes them different frames again",
  );
  // And the renderer commit gets its own wall-clock budget, gated to the
  // backend that HAS a renderer cache.
  assert.match(PROBE_CODE, /record\.rendererCommitted = true;/);
  assert.match(
    PROBE_CODE,
    /if \(rendererType === "webgpu"\) \{/,
    "the renderer-commit budget must be gated to WebGPU — the WebGL leg has no _webgpuCache and would burn the whole budget",
  );
});

// ── Footprint parity: WebGL's quad + falloff, ported and EXECUTED ───────────
//
// Both implementations below are transcriptions, so each is anchored to the
// shader text it claims to mirror; the mutants at the end break those anchors.

/** PrimitiveGaussianSplatVS.glsl's calcCovVectors tail, verbatim (NaN and all). */
function glslQuadAxes(diagonal1, offDiagonal, diagonal2) {
  const mid = 0.5 * (diagonal1 + diagonal2);
  const radius = Math.hypot((diagonal1 - diagonal2) * 0.5, offDiagonal);
  const lambda1 = mid + radius;
  const lambda2 = Math.max(mid - radius, 0.1);
  const rawX = offDiagonal;
  const rawY = lambda1 - diagonal1;
  const length = Math.hypot(rawX, rawY);
  // GLSL `normalize` of a zero vector is 0/0 = NaN. Reproduced deliberately.
  const dir = [rawX / length, rawY / length];
  const majorLen = Math.min(Math.sqrt(2.0 * lambda1), 1024.0);
  const minorLen = Math.min(Math.sqrt(2.0 * lambda2), 1024.0);
  return {
    major: [majorLen * dir[0], majorLen * dir[1]],
    minor: [minorLen * dir[1], minorLen * -dir[0]],
    lambda1,
    lambda2,
  };
}

/** The shipped WGSL `splatQuadAxes`, with its one documented deviation. */
function wgslQuadAxes(diagonal1, offDiagonal, diagonal2) {
  const mid = 0.5 * (diagonal1 + diagonal2);
  const radius = Math.hypot((diagonal1 - diagonal2) * 0.5, offDiagonal);
  const lambda1 = mid + radius;
  const lambda2 = Math.max(mid - radius, 0.1);
  const rawX = offDiagonal;
  const rawY = lambda1 - diagonal1;
  const length = Math.hypot(rawX, rawY);
  const dir =
    length > 1e-12
      ? [rawX / Math.max(length, 1e-20), rawY / Math.max(length, 1e-20)]
      : [1.0, 0.0];
  const majorLen = Math.min(Math.sqrt(2.0 * lambda1), 1024.0);
  const minorLen = Math.min(Math.sqrt(2.0 * lambda2), 1024.0);
  return {
    major: [majorLen * dir[0], majorLen * dir[1]],
    minor: [minorLen * dir[1], minorLen * -dir[0]],
    lambda1,
    lambda2,
  };
}

/**
 * Projected 2D covariances to run both through. Each is a plausible
 * `(diagonal1, offDiagonal, diagonal2)` after the +0.3 dilation, including the
 * exactly-axis-aligned cases where the GLSL's `normalize` is undefined.
 */
const COVARIANCE_CASES = [
  { label: "anisotropic, rotated", cov: [42.0, 11.5, 17.25] },
  { label: "anisotropic, strongly rotated", cov: [9.5, -7.25, 30.75] },
  { label: "near-circular with a nudge", cov: [12.3, 0.05, 12.31] },
  { label: "large, clamped by the 1024 cap", cov: [4.2e6, 3.1e5, 2.7e6] },
  { label: "tiny (sub-pixel)", cov: [0.31, 0.0004, 0.3] },
  // The two the GLSL cannot express: offDiagonal exactly 0 with the major
  // eigenvalue collapsing onto diagonal1.
  { label: "EXACTLY isotropic", cov: [12.3, 0.0, 12.3], glslUndefined: true },
  {
    label: "axis-aligned, d1 > d2",
    cov: [40.0, 0.0, 12.0],
    glslUndefined: true,
  },
];

test("HEAD: the WGSL quad axes reproduce the GLSL's wherever the GLSL is defined", () => {
  let undefinedSeen = 0;
  for (const testCase of COVARIANCE_CASES) {
    const [d1, od, d2] = testCase.cov;
    const glsl = glslQuadAxes(d1, od, d2);
    const wgsl = wgslQuadAxes(d1, od, d2);
    // The eigenvalues are the same arithmetic in both and must agree exactly.
    assert.equal(wgsl.lambda1, glsl.lambda1, `${testCase.label}: lambda1`);
    assert.equal(wgsl.lambda2, glsl.lambda2, `${testCase.label}: lambda2`);

    const glslFinite =
      Number.isFinite(glsl.major[0]) && Number.isFinite(glsl.major[1]);
    if (!glslFinite) {
      undefinedSeen++;
      assert.ok(
        testCase.glslUndefined,
        `${testCase.label}: the GLSL went NaN on a case not marked glslUndefined`,
      );
      // The port must NOT inherit the NaN — a synthetic isotropic covariance is
      // exactly what probe-splat-sort.mjs feeds this shader.
      for (const value of [...wgsl.major, ...wgsl.minor]) {
        assert.ok(
          Number.isFinite(value),
          `${testCase.label}: the WGSL port inherited the GLSL's NaN`,
        );
      }
      // ...and it must still produce the right EXTENTS, just on an arbitrary
      // (correct, for a circular footprint) pair of axes.
      assert.ok(
        Math.abs(
          Math.hypot(...wgsl.major) -
            Math.min(Math.sqrt(2 * glsl.lambda1), 1024),
        ) < 1e-9,
        `${testCase.label}: major extent wrong in the degenerate branch`,
      );
      continue;
    }
    assert.ok(
      testCase.glslUndefined !== true,
      `${testCase.label}: expected the GLSL to be undefined here`,
    );
    for (const key of ["major", "minor"]) {
      for (let i = 0; i < 2; i++) {
        assert.ok(
          Math.abs(wgsl[key][i] - glsl[key][i]) <=
            1e-12 * Math.max(1, Math.abs(glsl[key][i])),
          `${testCase.label}: ${key}[${i}] diverged — ${wgsl[key][i]} vs ${glsl[key][i]}`,
        );
      }
    }
  }
  assert.ok(
    undefinedSeen >= 2,
    "the battery must actually exercise the degenerate cases, or the deviation is untested",
  );
});

test("HEAD: the pre-C15-G3b footprint really was ~3.5x WebGL's area (the attribution)", () => {
  // The arithmetic the row records, executed rather than asserted in prose.
  //
  // OLD WGSL: square quad of half-side ceil(3*sqrt(eigenMax)) around the splat
  // centre, with the TRUE gaussian exp(-0.5 * r^2 / sigma^2) — support runs to
  // the 3-sigma quad edge (the 1/255 alpha cutoff is at 3.33 sigma, so the quad
  // binds first).
  // GLSL: oriented rectangle of half-extents sqrt(2*lambda_i), i.e. sqrt(2)
  // sigma_i, with exp(-4*dot(corner,corner)) — support IS the quad.
  //
  // For an isotropic projected covariance (sigma per axis), the supported
  // areas are: old = the disc of radius 3*sigma clipped to its bounding square
  // = pi*(3 sigma)^2; GLSL = the square of half-side sqrt(2)*sigma.
  const sigma = 4.0;
  const oldArea = Math.PI * Math.pow(3 * sigma, 2);
  const glslArea = Math.pow(2 * Math.SQRT2 * sigma, 2);
  const ratio = oldArea / glslArea;
  assert.ok(
    ratio > 3.4 && ratio < 3.7,
    `expected the pre-fix/GLSL area ratio near 3.5; computed ${ratio}`,
  );
  // Batch 881 measured 61.096% added on WebGPU against 19.141% on WebGL = 3.19,
  // BELOW the per-splat ratio because 27 overlapping footprints union
  // sublinearly and the larger ones overlap more. Direction and magnitude both
  // agree, which is what makes the attribution a measurement rather than a
  // story — and it independently corroborates the covariance decode: a decode
  // at the wrong scale would not land within 10% of the convention-only
  // prediction.
  const measured = 61.096 / 19.141;
  assert.ok(
    measured < ratio && measured > ratio * 0.85,
    `the measured ratio ${measured} should sit just below the per-splat prediction ${ratio}`,
  );
});

test("HEAD: the pre-C15-G3b footprint really was ~3.5x WebGL's area (the attribution)", () => {
  // The arithmetic the row records, executed rather than asserted in prose.
  //
  // PRE-FIX WGSL: an axis-aligned square quad of half-side ceil(3*sqrt(eigenMax))
  // in HALF-viewport pixel units, evaluating the TRUE gaussian
  // exp(-0.5 * r^2 / sigma^2). The 1/255 alpha cutoff sits at 3.33 sigma, so
  // the 3-sigma quad binds first and the support IS the quad.
  // GLSL: an oriented rectangle of half-extents sqrt(2*lambda_i) = sqrt(2)
  // sigma_i, evaluating exp(-4*dot(corner,corner)) — support IS the quad, and
  // the quad edge sits at exp(-4) = 1.8% of peak alpha.
  //
  // For an isotropic projected covariance the supported areas are the disc of
  // radius 3*sigma (clipped by its bounding square, which does not bind) and
  // the square of half-side sqrt(2)*sigma.
  const sigma = 4.0;
  const preFixArea = Math.PI * Math.pow(3 * sigma, 2);
  const glslArea = Math.pow(2 * Math.SQRT2 * sigma, 2);
  const ratio = preFixArea / glslArea;
  assert.ok(
    ratio > 3.4 && ratio < 3.7,
    `expected the pre-fix/GLSL area ratio near 3.5; computed ${ratio}`,
  );

  // Batch 881 measured 61.096% added on the WebGPU leg against 19.141% on
  // WebGL = 3.19x. That sits just BELOW the per-splat prediction because 27
  // overlapping footprints union sublinearly and the larger ones overlap more.
  // Direction and magnitude both agree, which is what makes this an
  // attribution rather than a story — and it independently corroborates the
  // covariance decode: a decode at the wrong SCALE would not land within 10%
  // of a convention-only prediction.
  const measured = 61.096 / 19.141;
  assert.ok(
    measured < ratio && measured > ratio * 0.85,
    `the measured ratio ${measured} should sit just below the per-splat prediction ${ratio}`,
  );

  // And the thing this rules OUT, stated as arithmetic: spherical harmonics
  // are a COLOUR term. They cannot move coverage, because the quad extent is
  // computed from the covariance alone — no SH input reaches it in either
  // shader. So "the WGSL has no SH yet" was never available as an explanation
  // for a 3.2x area difference.
  const glslVs = readNormalized(GLSL_VS_PATH);
  assert.match(
    glslVs,
    /v_splatColor\.rgb \+= evaluateSH\(texIdx, viewDirModel\)\.rgb;/,
    `${GLSL_VS_PATH}: SH must apply to colour only — if it ever reaches the quad extent, the coverage attribution above is void`,
  );
  const covVectorCall = glslVs.indexOf("calcCovVectors(splatViewPos.xyz, Vrk)");
  assert.ok(
    covVectorCall !== -1 && covVectorCall < glslVs.indexOf("evaluateSH(texIdx"),
    `${GLSL_VS_PATH}: the footprint is computed before SH is evaluated, so SH cannot influence it`,
  );
});

/**
 * Every load-bearing footprint constant, asserted against a renderer SOURCE
 * STRING so the mutants below can run the identical battery over a mutated
 * copy in memory. Nothing here writes to disk.
 */
function assertFootprintAnchors(rendererSource) {
  const wgsl = extractSplatWgsl(rendererSource);

  // Focal convention: FULL viewport. The factor of 2 is not cosmetic — the
  // +0.3 dilation and the 1024 clamp are ABSOLUTE constants, so a half-focal
  // covariance inflates every small splat against them.
  assert.match(
    rendererSource,
    /vpData\[2\] = proj\[0\] \* viewportW;/,
    `${RENDERER_PATH}: focalX is no longer the FULL-viewport focal the GLSL uses`,
  );
  assert.match(rendererSource, /vpData\[3\] = proj\[5\] \* viewportH;/);
  assert.doesNotMatch(
    rendererSource,
    /vpData\[2\] = proj\[0\] \* \(viewportW \* 0\.5\);/,
    `${RENDERER_PATH}: the half-viewport focal is back — the projected covariance drops 4x against an unchanged +0.3 dilation`,
  );

  // Dilation, eigen extents, minor-eigenvalue floor.
  for (const [pattern, why] of [
    [/max\(mid - radius, 0\.1\)/, "the lambda2 floor"],
    [/min\(sqrt\(2\.0 \* lambda1\), 1024\.0\)/, "the major-axis extent"],
    [/min\(sqrt\(2\.0 \* lambda2\), 1024\.0\)/, "the minor-axis extent"],
  ]) {
    assert.match(wgsl, pattern, `${RENDERER_PATH}: ${why} is gone`);
  }
  assert.equal(
    (wgsl.match(/\+ 0\.3;/g) ?? []).length,
    2,
    `${RENDERER_PATH}: both covariance diagonals must carry the +0.3 dilation, exactly as the GLSL does`,
  );

  // The expansion: divide by the viewport, multiply by w, NO factor of 2.
  assert.match(
    wgsl,
    /\/ u\.viewportSize \* clipPos\.w;/,
    `${RENDERER_PATH}: the quad expansion no longer matches the GLSL`,
  );
  assert.doesNotMatch(
    wgsl,
    /\/ u\.viewportSize \* 2\.0 \*/,
    `${RENDERER_PATH}: the historical *2.0 expansion is back — against the full-viewport focal that doubles every footprint`,
  );

  // WebGL's whole-splat rejections.
  assert.match(wgsl, /let clipLimit = 1\.2 \* clipPos\.w;/);
  assert.match(
    wgsl,
    /dot\(axes\.major, axes\.major\) < 4\.0\s*\n?\s*&& dot\(axes\.minor, axes\.minor\) < 4\.0;/,
  );

  // The falloff: BOTH the 4x sharpening and the support, and no extra cap.
  assert.match(wgsl, /let A = -dot\(input\.vertPos, input\.vertPos\);/);
  assert.match(wgsl, /if \(A < -4\.0\) \{ discard; \}/);
  // Checked BEFORE the count below, so a re-introduced cap is reported as a
  // cap rather than as a missing twin.
  assert.doesNotMatch(
    wgsl,
    /min\(0\.99, input\.color\.a/,
    `${RENDERER_PATH}: the 0.99 alpha cap is back — WebGL has none, and it diverges visibly for opaque splats`,
  );
  // COUNT, not match: the colour FS and the pick FS carry the same line, and a
  // single assert.match is satisfied by whichever twin was left alone.
  assert.equal(
    (wgsl.match(/let alpha = exp\(A \* 4\.0\) \* input\.color\.a;/g) ?? [])
      .length,
    2,
    `${RENDERER_PATH}: the falloff lost WebGL's 4x exponent sharpening — the profile widens back to the true gaussian`,
  );
  assert.doesNotMatch(
    wgsl,
    /input\.conic/,
    `${RENDERER_PATH}: the conic falloff is back — it renders the true gaussian to 3 sigma where WebGL renders exp(-4*dot) to sqrt(2) sigma`,
  );

  // The velocity VS must SHARE the helpers. Two copies of one footprint is how
  // colour and velocity coverage silently desynchronize.
  assert.equal(
    (wgsl.match(/let axes = splatQuadAxes\(cov\);/g) ?? []).length,
    2,
    `${RENDERER_PATH}: the colour and velocity vertex shaders must both go through splatQuadAxes`,
  );
  assert.equal(
    (wgsl.match(/projectSplatCovariance\(Sigma, R, t\.xyz\)/g) ?? []).length,
    2,
    `${RENDERER_PATH}: the colour and velocity vertex shaders must both go through projectSplatCovariance`,
  );
}

test("HEAD: the WGSL footprint math is anchored to the GLSL it transcribes", () => {
  assertFootprintAnchors(readNormalized(RENDERER_PATH));

  // ...and the GLSL side, so a change to the REFERENCE is caught here rather
  // than as an unexplained parity drift months later.
  const glsl = readNormalized(GLSL_VS_PATH);
  const fs = readNormalized(
    "packages/engine/Source/Shaders/PrimitiveGaussianSplatFS.glsl",
  );
  assert.match(
    glsl,
    /vec2 focal = vec2\(czm_projection\[0\]\[0\] \* czm_viewport\.z, czm_projection\[1\]\[1\] \* czm_viewport\.w\);/,
    `${GLSL_VS_PATH}: the focal convention changed`,
  );
  assert.match(glsl, /min\(sqrt\(2\.0 \* lambda1\), 1024\.0\)/);
  assert.match(glsl, /max\(mid - radius, 0\.1\)/);
  assert.match(
    glsl,
    /\/ czm_viewport\.zw \* gl_Position\.w/,
    `${GLSL_VS_PATH}: the quad expansion changed`,
  );
  assert.match(glsl, /float clip = 1\.2 \* clipPosition\.w;/);
  assert.match(
    glsl,
    /dot\(covVectors\.xy, covVectors\.xy\) < 4\.0 && dot\(covVectors\.zw, covVectors\.zw\) < 4\.0/,
  );
  assert.match(fs, /float A = -dot\(v_vertPos, v_vertPos\);/);
  assert.match(fs, /if \(A < -4\.\) \{/);
  assert.match(fs, /float B = exp\(A \* 4\.\) \* v_splatColor\.a ;/);
});

// Footprint mutants, applied to a COPY of the renderer source in memory.
const FOOTPRINT_MUTANTS = [
  {
    name: "the historical *2.0 quad expansion returns",
    mutate: (source) =>
      source.replace(
        "             / u.viewportSize * clipPos.w;",
        "             / u.viewportSize * 2.0 * clipPos.w;",
      ),
    // Either rejection is correct and names the same defect: the positive
    // anchor stops matching, and/or the negative one starts.
    because:
      /quad expansion no longer matches the GLSL|historical \*2\.0 expansion is back/,
  },
  {
    name: "the half-viewport focal returns",
    mutate: (source) =>
      source.replace(
        "vpData[2] = proj[0] * viewportW;",
        "vpData[2] = proj[0] * (viewportW * 0.5);",
      ),
    because: /no longer the FULL-viewport focal/,
  },
  {
    name: "the falloff loses WebGL's 4x sharpening",
    mutate: (source) =>
      source.replace(
        "let alpha = exp(A * 4.0) * input.color.a;",
        "let alpha = exp(A) * input.color.a;",
      ),
    because: /lost WebGL's 4x exponent sharpening/,
  },
  {
    name: "the 0.99 alpha cap returns",
    mutate: (source) =>
      source.replace(
        "let alpha = exp(A * 4.0) * input.color.a;",
        "let alpha = min(0.99, input.color.a * exp(A * 4.0));",
      ),
    because: /0\.99 alpha cap is back/,
  },
  {
    name: "the dilation is applied to only one diagonal",
    mutate: (source) =>
      source.replace(
        "let diagonal2 = J1.y*J1.y*d + 2.0*J1.y*J2.y*e + J2.y*J2.y*f + 0.3;",
        "let diagonal2 = J1.y*J1.y*d + 2.0*J1.y*J2.y*e + J2.y*J2.y*f;",
      ),
    because: /both covariance diagonals must carry the \+0\.3 dilation/,
  },
  {
    name: "the minor-axis extent is widened past WebGL's",
    mutate: (source) =>
      source.replace(
        "  axes.minor = min(sqrt(2.0 * lambda2), 1024.0)",
        "  axes.minor = min(3.0 * sqrt(lambda2), 1024.0)",
      ),
    because: /the minor-axis extent is gone/,
  },
  {
    name: "the velocity VS keeps its own footprint copy",
    mutate: (source) => {
      const marker = "  let axes = splatQuadAxes(cov);";
      const last = source.lastIndexOf(marker);
      return (
        source.slice(0, last) +
        "  var axes: SplatQuadAxes; axes.major = vec2<f32>(3.0, 0.0);" +
        source.slice(last + marker.length)
      );
    },
    because: /must both go through splatQuadAxes/,
  },
];

for (const mutant of FOOTPRINT_MUTANTS) {
  test(`footprint mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(RENDERER_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      "the mutation did not apply — the anchor text moved and this mutant proves nothing",
    );
    assert.throws(
      () => assertFootprintAnchors(mutated),
      mutant.because,
      `${mutant.name}: the footprint anchors accepted it, or rejected it for the wrong reason`,
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G3c — `probe-splat-globe-occlusion` check 3 went red after `C15-G3b`.
//
// It is not a splat defect and it is not `C15-G3b`. The arithmetic below is
// executed rather than argued, because the whole question is whether a
// footprint change can manufacture leak pixels — and it provably cannot: the
// new falloff makes every leak pixel LESS countable, by exactly 4x in area.
// What actually changed is that the globe is no longer present over the splat,
// and the probe had no way to notice.
// ────────────────────────────────────────────────────────────────────────────

const OCCLUSION_PROBE_PATH =
  "Tools/visual-regression/probe-splat-globe-occlusion.mjs";

/**
 * The probe counts a pixel green when `g > 150` with `r < 90` and `b < 90`.
 * Compositing is premultiplied over-blend, so the green channel lands at
 * `alpha + dstG * (1 - alpha)` for a splat whose green is 1.0. Solving for the
 * alpha at which a pixel starts counting, then inverting each falloff, gives
 * the radius of the COUNTABLE disc in units of the projected sigma.
 */
function countableGreenRadiusSigmas(exponentScale, dstG, splatAlpha = 0.95) {
  const threshold = 150 / 255;
  const alphaThreshold = (threshold - dstG) / (1.0 - dstG);
  // alpha(r) = splatAlpha * exp(-exponentScale * (r/sigma)^2)
  return Math.sqrt(-Math.log(alphaThreshold / splatAlpha) / exponentScale);
}

test("HEAD: the C15-G3b falloff can only SHRINK a leak, never manufacture one", () => {
  // Pre-C15-G3b (Batch 288): the conic form evaluated the TRUE gaussian,
  // alpha = a * exp(-0.5 * (r/sigma)^2), over a 3-sigma square support.
  // Post-C15-G3b: WebGL's alpha = a * exp(-4 * dot(corner,corner)) with the
  // quad edge at sqrt(2) sigma, i.e. alpha = a * exp(-2 * (r/sigma)^2).
  const PRE_EXPONENT = 0.5;
  const POST_EXPONENT = 2.0;

  // The post exponent is read out of the shipped shader, not assumed.
  const wgsl = extractSplatWgsl(readNormalized(RENDERER_PATH));
  assert.match(
    wgsl,
    /let alpha = exp\(A \* 4\.0\) \* input\.color\.a;/,
    `${RENDERER_PATH}: the falloff changed; re-derive the ratio below before trusting it`,
  );
  // exp(A*4) with A = -dot(v,v) and |v| = 1 at sqrt(2)*sigma gives
  // exp(-4 * r^2 / (2 sigma^2)) = exp(-2 (r/sigma)^2).
  assert.equal(POST_EXPONENT, 4 / 2);

  // The ratio is INDEPENDENT of the globe colour behind the splat: both
  // profiles are gaussians differing only by a constant factor in the
  // exponent, so the countable radius always halves and the area always
  // quarters, whatever threshold the blend produces.
  for (const dstG of [0.15, 0.2, 0.25, 0.3, 0.35]) {
    const pre = countableGreenRadiusSigmas(PRE_EXPONENT, dstG);
    const post = countableGreenRadiusSigmas(POST_EXPONENT, dstG);
    assert.ok(
      Math.abs(pre / post - 2.0) < 1e-9,
      `dstG=${dstG}: countable radius ratio ${pre / post}, expected exactly 2`,
    );
    assert.ok(
      Math.abs((pre / post) ** 2 - 4.0) < 1e-9,
      `dstG=${dstG}: countable AREA ratio must be exactly 4`,
    );
  }

  // Therefore, for ANY fixed depth-test outcome, the post-G3b green count is a
  // quarter of the pre-G3b one. A footprint change that strictly reduces both
  // the support and the per-pixel opacity cannot create a pixel that was not
  // already there. Mechanism (1) — "the sharper falloff pushed sub-threshold
  // leak pixels over the bar" — is refuted, with a number.
  const measured = 1436;
  assert.ok(
    measured * 4 > 5000,
    "the same leak under the pre-G3b footprint would have counted ~5,743 px, far above the <50 bar — so it was never a threshold effect",
  );
});

test("HEAD: greenPx=1436 is the FULLY UNOCCLUDED footprint, not a partial leak", () => {
  // The probe's geometry, from its own source: a 600 m isotropic splat 3 km
  // below the surface, nadir camera at 8 km, 1024x700 viewport.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(probe, /const R = 600\.0;/, "the splat radius moved");
  assert.match(probe, /makeSplatPrim\(-3000\.0, \[0\.05, 1\.0, 0\.05\]\)/);
  assert.match(probe, /fromDegrees\(LON, LAT, 8000\.0\)/);
  assert.match(probe, /viewport: \{ width: 1024, height: 700 \}/);

  const W = 1024;
  const H = 700;
  const fov = Math.PI / 3; // Cesium's default PerspectiveFrustum fov
  const p00 = 1 / ((W / H) * Math.tan(fov / 2));
  const focalPx = (p00 * W) / 2;
  // Camera 8 km above the surface, splat 3 km below it -> 11 km along the ray.
  const sigmaPx = (600 * focalPx) / 11000;
  assert.ok(
    Math.abs(sigmaPx - 33.07) < 0.5,
    `projected sigma ${sigmaPx}, expected ~33.1 px`,
  );

  // The globe under the splat is `globe.baseColor` (0.35, 0.25, 0.15) tinted by
  // a GridImageryProvider, so its green sits in the 0.2-0.3 band.
  assert.match(probe, /new C\.Color\(0\.35, 0\.25, 0\.15, 1\.0\)/);
  const areaFor = (dstG) =>
    Math.PI * (countableGreenRadiusSigmas(2.0, dstG) * sigmaPx) ** 2;
  const low = areaFor(0.2);
  const high = areaFor(0.3);
  assert.ok(
    low < 1436 && 1436 <= high * 1.02,
    `a FULLY VISIBLE green splat counts ${low.toFixed(0)}-${high.toFixed(0)} px; the run measured 1436, which is that number, not the tail of a partial occlusion`,
  );
  // A partial leak would have to be an annulus or a crescent; the measured
  // value landing inside the fully-visible band (and the PNG showing a filled
  // disc) means the depth test rejected NOTHING.
});

test("HEAD: the quad expansion cannot move clip-space z or w", () => {
  // Mechanism (2): "the new quad axes move where fragments land relative to
  // the globe's depth". The expansion writes x and y ONLY, and the log-depth
  // varying is derived from the splat CENTRE's clip position, not from the
  // expanded corner — so every fragment of the quad carries the centre's
  // depth, exactly as before.
  const wgsl = extractSplatWgsl(readNormalized(RENDERER_PATH));
  assert.match(
    wgsl,
    /var fp = clipPos;\s*\n\s*fp\.x = fp\.x \+ ndcOff\.x; fp\.y = fp\.y \+ ndcOff\.y;/,
    `${RENDERER_PATH}: the quad expansion no longer writes x/y only — if it touches z or w the splat's depth becomes position-dependent across the quad`,
  );
  assert.doesNotMatch(
    wgsl,
    /fp\.z = fp\.z \+|fp\.w = fp\.w \+/,
    `${RENDERER_PATH}: the expansion writes clip z or w`,
  );
  assert.match(
    wgsl,
    /output\.v_logDepth = csm_vertexLogDepth\(clipPos, u\.logDepthNear\);/,
    `${RENDERER_PATH}: the log-depth varying must come from the splat CENTRE clip position`,
  );
  // Same for the velocity VS's expansion.
  assert.match(
    wgsl,
    /var fp = currCenterClip;\s*\n\s*fp\.x = fp\.x \+ ndcOff\.x;\s*\n\s*fp\.y = fp\.y \+ ndcOff\.y;/,
    `${RENDERER_PATH}: the velocity expansion no longer writes x/y only`,
  );
});

/**
 * The occlusion probe's contract, asserted against a SOURCE STRING so the
 * mutants can run the same battery over a mutated copy in memory.
 */
function assertOcclusionProbeContract(source) {
  // The globe must be measured on its OWN frame, with the splats hidden.
  // Deriving it as `nonBlack - red - green` counted the red splat's own
  // sub-threshold halo and the viewer chrome as globe, so check (1) could not
  // fail for "the globe did not render" — which is the exact state the
  // Batch-882 run was in.
  assert.match(
    source,
    /const globeOnly = await snap\(\);/,
    `${OCCLUSION_PROBE_PATH}: the globe-only reference frame is gone`,
  );
  assert.match(
    source,
    /setSplatsVisible\(false\);/,
    `${OCCLUSION_PROBE_PATH}: the reference frame is no longer captured with the splats hidden`,
  );
  assert.match(
    source,
    /const globePixels = globeOnlyPixels;/,
    `${OCCLUSION_PROBE_PATH}: globePixels is derived by subtraction again — the red splat's halo and the viewer chrome would count as globe`,
  );
  assert.doesNotMatch(
    source,
    /const globePixels = nonBlack - red - green;/,
    `${OCCLUSION_PROBE_PATH}: the subtraction-derived globe count is back`,
  );

  // The green verdict must be split per pixel by what is BEHIND it.
  assert.match(source, /greenOverGlobe\+\+;/);
  assert.match(source, /greenOverVoid\+\+;/);
  assert.match(
    source,
    /out\.greenPaintedOverGlobe < 50/,
    `${OCCLUSION_PROBE_PATH}: check 3 scores total green again — a splat drawn over EMPTY SPACE would be filed as a depth-compare leak`,
  );
  assert.doesNotMatch(
    source,
    /"3",\s*\n\s*out\.green(?!Painted) < 50/,
    `${OCCLUSION_PROBE_PATH}: check 3 is back on the undifferentiated green count`,
  );
  // ...and the missing-globe case must be STRUCTURAL, never a product verdict.
  assert.match(
    source,
    /precondition\(\s*\n?\s*"P1",\s*\n?\s*out\.greenPaintedOverVoid === 0,/,
    `${OCCLUSION_PROBE_PATH}: the globe-coverage precondition is gone`,
  );
  assert.match(
    source,
    /process\.exit\(ok \? \(structural \? 3 : 0\) : 1\);/,
    `${OCCLUSION_PROBE_PATH}: a structural run must exit 3 — never 0 (which would certify an unevaluated subject) and never 1 (which would file it as a splat defect)`,
  );
  // Check 2 keeps its ORIGINAL meaning — the splat is rendered, not dropped
  // (the C7-SPLAT-DEPTH-COMPOSE guard) — and the "over the globe" half of its
  // claim becomes a precondition, because a splat drawn over empty space is
  // not a splat defect either. Turning it into a hard FAIL would file the
  // missing globe against the splat, which is the same error in the opposite
  // direction.
  assert.match(
    source,
    /precondition\(\s*\n?\s*"P2",\s*\n?\s*out\.redPainted > 2000 && out\.globePixels > 20000,/,
    `${OCCLUSION_PROBE_PATH}: the compose-over-globe precondition is gone`,
  );
  assert.match(
    source,
    /"2",\s*\n\s*out\.redPainted > 2000,/,
    `${OCCLUSION_PROBE_PATH}: check 2 no longer guards the never-drop defect it was written for`,
  );
  // Chrome hidden, and the viewer loaded offline so a missing ion token cannot
  // change what is on the canvas.
  assert.match(source, /\.cesium-navigation-help/);
  assert.match(source, /renderer=webgpu&offline=true/);
}

test("HEAD: the occlusion probe can tell a depth leak from a missing globe", () => {
  assertOcclusionProbeContract(readNormalized(OCCLUSION_PROBE_PATH));
});

const OCCLUSION_PROBE_MUTANTS = [
  {
    name: "globePixels derived by subtraction again",
    mutate: (source) =>
      source.replace(
        "const globePixels = globeOnlyPixels;",
        "const globePixels = nonBlack - red - green;",
      ),
    because: /globePixels is derived by subtraction again/,
  },
  {
    name: "check 3 scores undifferentiated green",
    mutate: (source) =>
      source.replace("out.greenPaintedOverGlobe < 50", "out.green < 50"),
    because: /check 3 scores total green again/,
  },
  {
    name: "the missing-globe case is folded back into the product verdict",
    mutate: (source) =>
      source.replace(
        "process.exit(ok ? (structural ? 3 : 0) : 1);",
        "process.exit(ok ? 0 : 1);",
      ),
    because: /a structural run must exit 3/,
  },
  {
    name: "the globe-coverage precondition is deleted",
    mutate: (source) =>
      source.replace('precondition(\n  "P1",', 'noop(\n  "P1",'),
    because: /globe-coverage precondition is gone/,
  },
  {
    name: "the reference frame is captured with the splats still visible",
    mutate: (source) => source.replace("setSplatsVisible(false);", ""),
    because: /captured with the splats hidden/,
  },
];

for (const mutant of OCCLUSION_PROBE_MUTANTS) {
  test(`occlusion-probe mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(OCCLUSION_PROBE_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      "the mutation did not apply — the anchor text moved and this mutant proves nothing",
    );
    assert.throws(
      () => assertOcclusionProbeContract(mutated),
      mutant.because,
      `${mutant.name}: the contract accepted it, or rejected it for the wrong reason`,
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G3d — the "inversion" was two ABSOLUTE colour predicates misreporting a
// scene they were never calibrated for. One real defect survives: the
// below-surface splat is not occluded by the globe.
// ────────────────────────────────────────────────────────────────────────────

/** Premultiplied over-blend, the composite both splats go through. */
function overBlend(splat, alpha, dst) {
  return splat.map((c, k) => c * alpha + dst[k] * (1 - alpha));
}
const isRedAbs = ([r, g, b]) => r > 150 / 255 && g < 90 / 255 && b < 90 / 255;

test("HEAD: `redOverGlobe=33` is a PREDICATE artifact, not an occluded splat", () => {
  // The probe's `isRed` needs r>150 AND g<90 AND b<90. Over BLACK (the
  // Batch-882 scene, where the globe was absent) that is a wide band. Over the
  // olive globe it is still wide — so the collapse to 33 px is NOT the
  // background alone. What closes it is the GREEN splat drawn on top: its
  // premultiplied veil lifts g back over the 90 bar exactly where the red
  // annulus would otherwise qualify.
  const RED = [1.0, 0.05, 0.05];
  const GREEN = [0.05, 1.0, 0.05];
  const OLIVE = [0.3, 0.3, 0.15]; // globe.baseColor tinted by the grid imagery
  const BLACK = [0, 0, 0];

  // Over black, a mid-alpha red fragment is unambiguously "red".
  assert.ok(isRedAbs(overBlend(RED, 0.74, BLACK)));
  // Over the olive globe, ALONE, it still is.
  assert.ok(isRedAbs(overBlend(RED, 0.74, OLIVE)));
  // ...but veil it with the green splat that sits on top at that radius and it
  // stops qualifying, without the red splat having changed at all.
  const redOverGlobe = overBlend(RED, 0.74, OLIVE);
  const veiled = overBlend(GREEN, 0.304, redOverGlobe);
  assert.ok(
    !isRedAbs(veiled),
    `the veiled fragment should fail isRed; got ${veiled.map((v) => Math.round(v * 255)).join("/")}`,
  );
  // And it does not become "green" either — it falls in the gap between the two
  // absolute predicates, which is why BOTH counts read low and the run looked
  // like an inversion.
  const isGreenAbs = ([r, g, b]) =>
    g > 150 / 255 && r < 90 / 255 && b < 90 / 255;
  assert.ok(!isGreenAbs(veiled), "the veiled fragment is not green either");

  // The delta classifier the probe now uses is immune: relative to the
  // globe-only frame this pixel moved most in RED.
  const dr = veiled[0] - OLIVE[0];
  const dg = veiled[1] - OLIVE[1];
  const db = veiled[2] - OLIVE[2];
  assert.ok(
    dr >= dg && dr >= db,
    `delta classification must call this red: d=${[dr, dg, db].map((v) => v.toFixed(3)).join("/")}`,
  );
});

test("HEAD: the globe's own grid lines can no longer count as leaked splat", () => {
  // `isGreen` is satisfied by a pale-green GridImageryProvider line with no
  // splat present at all. Under the delta classifier such a pixel is unchanged
  // from the globe-only frame and is classified `null`.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(
    probe,
    /const PAINT_DELTA = 12;/,
    `${OCCLUSION_PROBE_PATH}: the delta threshold is gone`,
  );
  assert.match(
    probe,
    /const paintedBy = \(i\) => \{/,
    `${OCCLUSION_PROBE_PATH}: the delta classifier is gone`,
  );
  assert.match(
    probe,
    /out\.greenPaintedOverGlobe < 50/,
    `${OCCLUSION_PROBE_PATH}: check 3 is back on an ABSOLUTE colour predicate — the globe's own green grid counts as a leak again`,
  );
  assert.match(
    probe,
    /out\.redPainted > 2000/,
    `${OCCLUSION_PROBE_PATH}: check 2 is back on an ABSOLUTE colour predicate — a composed splat reads as 33 px over a coloured globe`,
  );
  assert.match(
    probe,
    /out\.greenPaintedOverVoid === 0/,
    `${OCCLUSION_PROBE_PATH}: P1 no longer uses the delta classifier`,
  );
});

test("HEAD: the splat depth CONVENTION matches the fleet, so the leak is not a flipped compare", () => {
  // Candidate 1, refuted at the census level. A reversed-Z migration would have
  // flipped the whole fleet; `less-equal` is overwhelmingly the convention and
  // the splat pipelines are inside it. And a flipped compare produces the
  // OPPOSITE signature to the one observed: it hides the NEAR splat. The near
  // (above-surface) splat is NOT hidden — it composes over the globe, as the
  // PNG and the predicate arithmetic above both show.
  const renderer = readNormalized(RENDERER_PATH);
  const compares = [...renderer.matchAll(/depthCompare: "([a-z-]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(compares.length >= 4, "the splat depth states moved");
  for (const compare of compares) {
    assert.equal(
      compare,
      "less-equal",
      `${RENDERER_PATH}: a splat pipeline uses "${compare}" — the fleet convention is less-equal with a 1.0 depth clear; a reversed-Z pipeline here would hide the NEAR splat, which is not the observed signature`,
    );
  }
  // Candidate 2, refuted: the record-layout define selects a shader MODULE and
  // a descriptor NAME. It does not reach the depth state.
  const colorDescriptor = renderer.slice(
    renderer.indexOf("const colorDescriptor: WebGPURenderPipelineDescriptor"),
    renderer.indexOf("// GS-WSR: OIT pipeline variant"),
  );
  assert.match(colorDescriptor, /depthCompare: "less-equal",/);
  assert.doesNotMatch(
    colorDescriptor,
    /layoutMarker[\s\S]{0,200}depthCompare|depthCompare[\s\S]{0,200}layoutMarker/,
    `${RENDERER_PATH}: the layout marker now sits inside the depth state`,
  );
});

test("HEAD: the probe records the log-depth inputs BOTH producers encode from", () => {
  // The surviving defect is that every splat fragment beats the globe, near and
  // far alike — the signature of an ENCODE-SPACE mismatch, not of a compare.
  // Naming WHICH mismatch needs the inputs, and one run should be enough.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  for (const field of [
    "logDepthWriteEnabled",
    "useLogDepth",
    "currentFrustumNear",
    "currentFrustumFar",
    "oneOverLog2FarDepthFromNearPlusOne",
    "stashedEncodeNearFar",
    "stashedEncodeFactor",
  ]) {
    assert.ok(
      probe.includes(field),
      `${OCCLUSION_PROBE_PATH}: the ${field} diagnostic is gone — the next run cannot discriminate the encode candidates`,
    );
  }
  assert.match(
    probe,
    /console\.log\(\s*\n?\s*`\(diag\) log depth/,
    `${OCCLUSION_PROBE_PATH}: the diagnostics are collected but never printed`,
  );
  // Both producers read the same two UniformState fields, so the probe's
  // reading of them is the reading both encoders get.
  const splat = readNormalized(RENDERER_PATH);
  const globeUB = readNormalized(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
  );
  for (const source of [splat, globeUB]) {
    assert.match(source, /currentFrustum\?\.x \?\? 0\.0/);
    assert.match(source, /oneOverLog2FarDepthFromNearPlusOne \?\? 0\.0/);
  }
});

const OCCLUSION_G3D_MUTANTS = [
  {
    name: "check 3 reverts to the absolute green predicate",
    mutate: (source) =>
      source.replace(
        "out.greenPaintedOverGlobe < 50",
        "out.greenOverGlobe < 50",
      ),
    because: /check 3 is back on an ABSOLUTE colour predicate/,
  },
  {
    name: "check 2 reverts to the absolute red predicate",
    mutate: (source) =>
      source.replaceAll("out.redPainted > 2000", "out.red > 2000"),
    because: /check 2 is back on an ABSOLUTE colour predicate/,
  },
  {
    name: "the delta classifier is deleted",
    mutate: (source) =>
      source.replace(
        "const paintedBy = (i) => {",
        "const paintedByX = (i) => {",
      ),
    because: /the delta classifier is gone/,
  },
];

for (const mutant of OCCLUSION_G3D_MUTANTS) {
  test(`occlusion-probe C15-G3d mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(OCCLUSION_PROBE_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => {
        assert.match(mutated, /const PAINT_DELTA = 12;/);
        assert.match(
          mutated,
          /const paintedBy = \(i\) => \{/,
          "the delta classifier is gone",
        );
        assert.match(
          mutated,
          /out\.greenPaintedOverGlobe < 50/,
          "check 3 is back on an ABSOLUTE colour predicate",
        );
        assert.match(
          mutated,
          /out\.redPainted > 2000/,
          "check 2 is back on an ABSOLUTE colour predicate",
        );
      },
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G6e — the encode hypothesis, EXECUTED against the pinned runtime
// constants, and REFUTED. `NEW-SPLAT-DEPTH-ENCODE-MISMATCH-VS-GLOBE` was my
// own filing at C15-G3d and it is wrong: the two producers encode identically,
// from identical inputs, and their outputs interleave correctly.
// ────────────────────────────────────────────────────────────────────────────

const GLOBE_WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const CANONICAL_WRITE_CHUNK =
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_writeLogDepth.wgsl";
const CANONICAL_VERTEX_CHUNK =
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_vertexLogDepth.wgsl";

/**
 * The runtime values BOTH encoders were measured consuming, identical across
 * three bit-identical Batch-885 runs.
 */
const DIAG = Object.freeze({
  near: 0.1,
  far: 1e8,
  factor: 0.037628749439612946,
});

test("HEAD: the pinned factor is exactly 1/log2(far - near + 1)", () => {
  // Not a coincidence to be assumed — it identifies WHICH quantity the runtime
  // value is, and therefore that both producers derived it the same way.
  assert.equal(1 / Math.log2(DIAG.far - DIAG.near + 1), DIAG.factor);
});

test("HEAD: at the probe's geometry the two encodes INTERLEAVE CORRECTLY", () => {
  // csm_vertexLogDepth -> csm_writeLogDepth, the formula all three copies share.
  const encode = (w) => Math.log2(w - DIAG.near + 1.0) * DIAG.factor;
  // Camera 8 km nadir; splats at +2 km and -3 km relative to the surface.
  const above = encode(6000);
  const globe = encode(8000);
  const below = encode(11000);

  assert.ok(
    above < globe && globe < below,
    `expected above < globe < below; got ${above} / ${globe} / ${below}`,
  );
  // ...and therefore, under the `less-equal` compare every splat pipeline
  // declares, the CORRECT visibility falls out of the arithmetic:
  assert.ok(above <= globe, "the above-surface splat must pass the depth test");
  assert.ok(!(below <= globe), "the below-surface splat must FAIL it");

  // Magnitudes, so a future reader can check the claim without re-deriving.
  assert.ok(Math.abs(above - 0.472277) < 1e-5);
  assert.ok(Math.abs(globe - 0.487892) < 1e-5);
  assert.ok(Math.abs(below - 0.505179) < 1e-5);

  // The refutation, stated as the test's purpose: an ENCODE mismatch cannot be
  // the cause of "every splat fragment beats the globe", because at the values
  // both producers actually consumed, they do not.
});

/** Strip comments/blank lines so only the executable formula is compared. */
function formulaBody(source, fnName) {
  const at = source.indexOf(`fn ${fnName}(`);
  assert.notEqual(at, -1, `${fnName} not found`);
  let depth = 0;
  let i = source.indexOf("{", at);
  const from = i;
  do {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  } while (depth > 0);
  return source
    .slice(from, i)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .join(" ");
}

test("HEAD: splat, globe and canonical chunk share ONE log-depth formula", () => {
  // The splat and the globe each carry an inline copy (neither uses the
  // #import chunk system). "Keep them in sync" is a comment; this is the test.
  // If they ever diverge, THAT is when an encode mismatch becomes possible —
  // and it is the only way it can happen.
  const splat = extractSplatWgsl(readNormalized(RENDERER_PATH));
  const globe = readNormalized(GLOBE_WGSL_PATH);
  const canonicalWrite = readNormalized(CANONICAL_WRITE_CHUNK);
  const canonicalVertex = readNormalized(CANONICAL_VERTEX_CHUNK);

  for (const [fn, canonical] of [
    ["csm_vertexLogDepth", canonicalVertex],
    ["csm_writeLogDepth", canonicalWrite],
    ["csm_updatePositionDepth", canonicalVertex],
  ]) {
    const fromCanonical = formulaBody(canonical, fn);
    const fromSplat = formulaBody(splat, fn);
    const fromGlobe = formulaBody(globe, fn);
    assert.equal(
      fromSplat,
      fromCanonical,
      `${RENDERER_PATH}: the inline ${fn} diverged from ${CANONICAL_WRITE_CHUNK.replace(/[^/]*$/, "")}${fn}.wgsl`,
    );
    assert.equal(
      fromGlobe,
      fromCanonical,
      `${GLOBE_WGSL_PATH}: the inline ${fn} diverged from the canonical chunk`,
    );
  }

  // No stray scale factor on either side — the classic way this family breaks
  // (WebGL's czm_writeLogDepth carries a 0.5 for its [-1,1] NDC; WebGPU's
  // [0,1] range must NOT).
  assert.match(
    formulaBody(splat, "csm_writeLogDepth"),
    /^\{ return log2\(depthFromNearPlusOne\) \* oneOverLog2FarDepthFromNearPlusOne; \}$/,
    `${RENDERER_PATH}: the splat's log-depth write grew or lost a factor`,
  );
  assert.equal(
    formulaBody(splat, "csm_writeLogDepth"),
    formulaBody(globe, "csm_writeLogDepth"),
  );
});

test("HEAD: both producers read the SAME uniform lanes for near and factor", () => {
  // Identical formulas fed different numbers would still diverge. The diag
  // proves the numbers matched at runtime; this pins that they come from the
  // same two UniformState fields on the CPU side.
  const splat = readNormalized(RENDERER_PATH);
  const globeUB = readNormalized(
    "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
  );
  for (const source of [splat, globeUB]) {
    assert.match(source, /currentFrustum\?\.x \?\? 0\.0/);
    assert.match(source, /oneOverLog2FarDepthFromNearPlusOne \?\? 0\.0/);
    assert.match(source, /Math\.log2\(ldFar - ldNear \+ 1\.0\)/);
  }
});

test("HEAD: the probe carries a NON-SPLAT control at the same below-surface point", () => {
  // With the encode refuted, the live hypotheses are all about the splat PASS
  // (its depth attachment, its placement, its declared state). A second
  // log-depth producer at the same position separates "splat-specific" from
  // "the globe's depth is not in this buffer at all" in ONE run.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(
    probe,
    /new C\.PointPrimitiveCollection\(\)/,
    `${OCCLUSION_PROBE_PATH}: the non-splat control is gone — the next round loses its subsystem discriminator`,
  );
  assert.match(
    probe,
    /position: C\.Cartesian3\.fromDegrees\(LON, LAT, -3000\.0\)/,
  );
  assert.match(
    probe,
    /out\.bluePaintedOverGlobe < 50/,
    `${OCCLUSION_PROBE_PATH}: the control is not checked`,
  );
  // It must be hidden alongside the splats for the globe-only reference frame,
  // or it would pollute the very baseline the classifier differences against.
  assert.match(probe, /bluePoint\.show = visible;/);
  // ...and classified before red/green, since a blue-dominant delta is neither.
  const classifier = probe.slice(
    probe.indexOf("const paintedBy = (i) => {"),
    probe.indexOf('return "other";'),
  );
  assert.ok(
    classifier.indexOf('return "blue"') < classifier.indexOf('return "red"'),
    `${OCCLUSION_PROBE_PATH}: the blue control must be classified before red`,
  );
});

const G6E_MUTANTS = [
  {
    name: "the splat's log-depth write grows WebGL's 0.5 NDC factor",
    mutate: (source) =>
      source.replace(
        "return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;\n}\n//>>endif",
        "return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne * 0.5;\n}\n//>>endif",
      ),
    because: /log-depth write grew or lost a factor|diverged from/,
  },
  {
    name: "the splat's vertex log depth loses the near subtraction",
    mutate: (source) =>
      source.replace(
        "  return (clipPosition.w - near) + 1.0;",
        "  return clipPosition.w + 1.0;",
      ),
    because: /diverged from/,
  },
];

for (const mutant of G6E_MUTANTS) {
  test(`log-depth formula mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(RENDERER_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    const splat = extractSplatWgsl(mutated);
    const canonicalWrite = readNormalized(CANONICAL_WRITE_CHUNK);
    const canonicalVertex = readNormalized(CANONICAL_VERTEX_CHUNK);
    assert.throws(
      () => {
        assert.equal(
          formulaBody(splat, "csm_writeLogDepth"),
          formulaBody(canonicalWrite, "csm_writeLogDepth"),
          "diverged from the canonical chunk",
        );
        assert.equal(
          formulaBody(splat, "csm_vertexLogDepth"),
          formulaBody(canonicalVertex, "csm_vertexLogDepth"),
          "diverged from the canonical chunk",
        );
        assert.match(
          formulaBody(splat, "csm_writeLogDepth"),
          /^\{ return log2\(depthFromNearPlusOne\) \* oneOverLog2FarDepthFromNearPlusOne; \}$/,
          "the splat's log-depth write grew or lost a factor",
        );
      },
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G6f — "a depth CLEAR between the OPAQUE pass and the splat pass"
//
// With the encode refuted at `C15-G6e`, the leading hypothesis became a depth
// CLEAR sitting between the two producers: the blue PointPrimitive control
// draws in `Pass.OPAQUE` and IS occluded, the splat draws in
// `Pass.GAUSSIAN_SPLATS` and is not, and a clear between them explains that
// asymmetry exactly. It was a good hypothesis. It is false, and the source
// says so without a browser — so it is pinned here rather than re-argued.
//
// Three facts, each executed below:
//
//   1. `_resumeScenePass` — the resume used by every intra-frustum end/resume
//      site in the loop — re-opens with `depthLoadOp: "load"`. It cannot clear.
//   2. `_clearDepthStencil` IS the depth-clearing re-open (it forwards
//      `getDepthStencilAttachment()`, whose default load op is "clear"), and
//      BOTH of its frustum-loop call sites are ABOVE `_executeOpaquePass`.
//      Any clear that fires is therefore upstream of the blue control too, so
//      a clear cannot produce the observed asymmetry.
//   3. Between the opaque pass and the splat dispatch the loop touches the
//      pass boundary exactly once (the DP-H45 depth repack), and that block
//      resumes through `_resumeScenePass`.
//
// The mutants below are the shapes the hypothesis would have to take to be
// true. All must be rejected — which is what makes this a refutation rather
// than a restatement of the current code.
// ────────────────────────────────────────────────────────────────────────────

const SCENE_RENDERER_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts";
const FRUSTUM_LOOP_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts";
const GLOBE_DEPTH_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeDepth.ts";

/**
 * Extract a brace-balanced TypeScript block starting at `header`.
 */
function tsBlock(source, header) {
  const at = source.indexOf(header);
  assert.notEqual(at, -1, `block header not found: ${header}`);
  let i = source.indexOf("{", at);
  const from = i;
  let depth = 0;
  do {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  } while (depth > 0);
  return source.slice(from, i);
}

/** Executable lines only, so a comment naming a load op cannot satisfy a rule. */
const codeOnly = (block) =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");

function assertResumeLoadsDepth(sceneRendererSource) {
  const body = codeOnly(
    tsBlock(
      sceneRendererSource,
      "public _resumeScenePass(context: WebGPUContext)",
    ),
  );
  assert.match(
    body,
    /depthLoadOp: "load"/,
    `${SCENE_RENDERER_PATH}: _resumeScenePass no longer re-opens with depthLoadOp "load" — every intra-frustum end/resume now wipes depth`,
  );
  assert.match(
    body,
    /stencilLoadOp: "load"/,
    `${SCENE_RENDERER_PATH}: _resumeScenePass no longer preserves stencil across the re-open`,
  );
  assert.doesNotMatch(
    body,
    /depthLoadOp: "clear"/,
    `${SCENE_RENDERER_PATH}: _resumeScenePass clears depth`,
  );
}

test("G6f: _resumeScenePass re-opens the scene pass with depthLoadOp load", () => {
  assertResumeLoadsDepth(readNormalized(SCENE_RENDERER_PATH));
});

test("G6f: _clearDepthStencil is the only depth-CLEARING re-open", () => {
  const source = readNormalized(SCENE_RENDERER_PATH);
  const clearBody = codeOnly(
    tsBlock(source, "public _clearDepthStencil(context: WebGPUContext)"),
  );
  // It clears by FORWARDING the attachment unmodified — `getDepthStencilAttachment`
  // defaults to depthLoadOp "clear". That is the whole mechanism, and it is what
  // makes this method (and only this method) able to reset depth.
  assert.match(
    clearBody,
    /const depthStencilAttachment = colorTarget\.getDepthStencilAttachment\?\.\(\);/,
    `${SCENE_RENDERER_PATH}: _clearDepthStencil no longer forwards the default (clearing) depth attachment`,
  );
  // ...and the default really is "clear", at the producer.
  const targetSource = readNormalized(
    "packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts",
  );
  assert.match(
    targetSource,
    /depthLoadOp: GPULoadOp = "clear"/,
    "WebGPURenderTarget.getDepthStencilAttachment no longer defaults depthLoadOp to clear — the two re-open sites' semantics just inverted",
  );
});

function assertClearsAreUpstreamOfOpaque(loopSource) {
  const opaqueAt = loopSource.indexOf("host._executeOpaquePass(");
  assert.notEqual(
    opaqueAt,
    -1,
    `${FRUSTUM_LOOP_PATH}: opaque dispatch not found`,
  );
  const clearSites = [];
  let from = 0;
  for (;;) {
    const at = loopSource.indexOf("host._clearDepthStencil(context)", from);
    if (at === -1) break;
    clearSites.push(at);
    from = at + 1;
  }
  assert.ok(
    clearSites.length >= 2,
    `${FRUSTUM_LOOP_PATH}: expected the per-frustum clear AND the clearGlobeDepth clear; found ${clearSites.length}`,
  );
  for (const at of clearSites) {
    assert.ok(
      at < opaqueAt,
      `${FRUSTUM_LOOP_PATH}: a _clearDepthStencil call now fires AFTER the opaque pass. ` +
        `The blue PointPrimitive control draws in Pass.OPAQUE and the splat in Pass.GAUSSIAN_SPLATS, ` +
        `so a clear between them would make the control's "occluded" reading meaningless.`,
    );
  }
}

test("G6f: every _clearDepthStencil call site is UPSTREAM of the opaque pass", () => {
  assertClearsAreUpstreamOfOpaque(readNormalized(FRUSTUM_LOOP_PATH));
});

function assertNoClearBetweenOpaqueAndSplats(loopSource) {
  const from = loopSource.indexOf("host._executeOpaquePass(");
  const to = loopSource.indexOf("Pass.GAUSSIAN_SPLATS");
  assert.ok(
    from !== -1 && to !== -1 && from < to,
    `${FRUSTUM_LOOP_PATH}: pass order changed`,
  );
  const between = codeOnly(loopSource.slice(from, to));
  assert.doesNotMatch(
    between,
    /_clearDepthStencil/,
    `${FRUSTUM_LOOP_PATH}: a depth clear now separates OPAQUE from GAUSSIAN_SPLATS`,
  );
  assert.doesNotMatch(
    between,
    /resumeDefaultRenderPass/,
    `${FRUSTUM_LOOP_PATH}: a canvas-pass resume now separates OPAQUE from GAUSSIAN_SPLATS — ` +
      `the splats would depth-test against the CANVAS depth, not the scene framebuffer's`,
  );
  // The one pass boundary that DOES sit there is the DP-H45 depth repack, and
  // it resumes through the loading helper.
  assert.match(
    between,
    /context\.endCurrentRenderPass\?\.\(\);[\s\S]*host\._globeDepth\.executeUpdateDepth\([\s\S]*host\._resumeScenePass\(context\);/,
    `${FRUSTUM_LOOP_PATH}: the DP-H45 repack between OPAQUE and GAUSSIAN_SPLATS no longer ends+repacks+resumes as a unit`,
  );
}

test("G6f: nothing between OPAQUE and GAUSSIAN_SPLATS can reset scene depth", () => {
  assertNoClearBetweenOpaqueAndSplats(readNormalized(FRUSTUM_LOOP_PATH));
});

test("G6f: the depth-repack's own pass cannot touch scene depth", () => {
  // `executeUpdateDepth` opens a render pass on `_depthCopyTarget`. If that
  // target ever gained a depth-stencil attachment, `getLoadPassDescriptor()`
  // would forward `getDepthStencilAttachment()` — default load op "clear" —
  // and the repack WOULD wipe depth between the two producers. It has none.
  const source = readNormalized(GLOBE_DEPTH_PATH);
  const block = source.slice(
    source.indexOf(`name: "GlobeDepth-DepthCopy"`),
    source.indexOf(`name: "GlobeDepth-TempDepthCopy"`),
  );
  assert.ok(
    block.length > 0,
    `${GLOBE_DEPTH_PATH}: depth-copy target not found`,
  );
  assert.doesNotMatch(
    block,
    /depthStencilFormat/,
    `${GLOBE_DEPTH_PATH}: the depth-copy target gained a depth attachment — its load-pass descriptor now clears it, ` +
      `and the DP-H45 repack sits between the OPAQUE and GAUSSIAN_SPLATS producers`,
  );
});

const G6F_MUTANTS = [
  {
    name: "_resumeScenePass re-opens with depthLoadOp clear",
    path: SCENE_RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        `          depthLoadOp: "load" as GPULoadOp,`,
        `          depthLoadOp: "clear" as GPULoadOp,`,
      ),
    check: assertResumeLoadsDepth,
    because: /no longer re-opens with depthLoadOp "load"|clears depth/,
  },
  {
    name: "a depth clear is inserted between OPAQUE and GAUSSIAN_SPLATS",
    path: FRUSTUM_LOOP_PATH,
    mutate: (source) =>
      source.replace(
        `    // Pass 11: GAUSSIAN_SPLATS`,
        `    host._clearDepthStencil(context);\n    // Pass 11: GAUSSIAN_SPLATS`,
      ),
    check: (source) => {
      assertClearsAreUpstreamOfOpaque(source);
      assertNoClearBetweenOpaqueAndSplats(source);
    },
    because:
      /fires AFTER the opaque pass|separates OPAQUE from GAUSSIAN_SPLATS/,
  },
  {
    name: "the post-opaque repack falls through to the CANVAS pass resume",
    path: FRUSTUM_LOOP_PATH,
    mutate: (source) =>
      source.replace(
        `        host._globeDepth.executeUpdateDepth(enc, depthSource);\n        host._resumeScenePass(context);`,
        `        host._globeDepth.executeUpdateDepth(enc, depthSource);\n        context.resumeDefaultRenderPass?.();`,
      ),
    check: (source) => assertNoClearBetweenOpaqueAndSplats(source),
    because:
      /canvas-pass resume now separates OPAQUE from GAUSSIAN_SPLATS|no longer ends\+repacks\+resumes as a unit/,
  },
];

for (const mutant of G6F_MUTANTS) {
  test(`G6f mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(mutant.path);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
  });
}

test("G6f: check 7 carries a POSITIVE control, so a zero cannot mean 'never drew'", () => {
  // `bluePaintedOverGlobe = 0` is produced BOTH by "the control is correctly
  // occluded" and by "the control painted nothing at all" — and check 7's whole
  // purpose is to name the subsystem the next round works in, so a vacuous
  // green there sends that round into the wrong renderer. The positive control
  // shows the SAME point with its depth test disabled: it then has nothing that
  // can hide it and MUST paint.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(
    probe,
    /bluePoint\.disableDepthTestDistance = Number\.POSITIVE_INFINITY;/,
    `${OCCLUSION_PROBE_PATH}: the positive control for check 7 is gone — a zero blue count is unreadable again`,
  );
  assert.match(
    probe,
    /bluePoint\.disableDepthTestDistance = 0\.0;/,
    `${OCCLUSION_PROBE_PATH}: the positive control must RESTORE the depth test, or check 7 measures a point that cannot be occluded`,
  );
  assert.match(
    probe,
    /out\.bluePositiveControlPx > 500/,
    `${OCCLUSION_PROBE_PATH}: the positive control is measured but never asserted`,
  );
  // It is a PRECONDITION (exit 3), never a product verdict: an instrument that
  // cannot see its own control has not measured the product either way.
  const at = probe.indexOf("out.bluePositiveControlPx > 500");
  const opener = probe.lastIndexOf("precondition(", at);
  const wrongOpener = probe.lastIndexOf("check(", at);
  assert.ok(
    opener !== -1 && opener > wrongOpener,
    `${OCCLUSION_PROBE_PATH}: the positive control must be a precondition (exit 3), not a check (exit 1)`,
  );
  // The control differences against the SAME globe-only frame at the SAME
  // sensitivity as check 7 — a control measured at another threshold certifies
  // nothing about the check it is supposed to certify. `PAINT_DELTA` is
  // declared once and both classifiers close over it, so the two cannot drift.
  assert.match(
    probe,
    /let bluePositiveControlPx = 0;/,
    `${OCCLUSION_PROBE_PATH}: the positive control's counter is gone`,
  );
  const controlLoop = probe.slice(
    probe.indexOf("let bluePositiveControlPx = 0;"),
    probe.indexOf("if (db >= dr && db >= dg) bluePositiveControlPx++;"),
  );
  assert.match(
    controlLoop,
    /bluePositive\.data\[i\] - globeOnly\.data\[i\]/,
    `${OCCLUSION_PROBE_PATH}: the positive control no longer differences against the globe-only frame`,
  );
  assert.match(
    controlLoop,
    /< PAINT_DELTA/,
    `${OCCLUSION_PROBE_PATH}: the positive control uses its own threshold — it no longer certifies check 7`,
  );
  assert.equal(
    (probe.match(/const PAINT_DELTA = /g) ?? []).length,
    1,
    `${OCCLUSION_PROBE_PATH}: PAINT_DELTA is declared more than once — the control and the check can now drift apart`,
  );
});

// ────────────────────────────────────────────────────────────────────────────
// C15-G6g — the STASH-vs-LIVE split in the renderer-wide log-depth fleet
//
// `C15-G3d` established that the splat and the globe read the SAME two
// `UniformState` fields, and concluded from that that their encodes match.
// That inference does not hold, and the fleet already knows it does not: the
// collections fleet and the depth plane deliberately do NOT read those fields
// directly. They prefer the STASHED full-camera-frustum encode
// (`uniformState._logDepthEncodeNearFar`) and RECOMPUTE the factor from that
// pair, and `WebGPUPointPrimitiveRenderer.js` states exactly why —
//
//     "reading the live `currentFrustum` would encode log depth against the
//      SLICE's narrow near/far — a different curve than the globe's — so the
//      point's frag_depth no longer compares correctly against the globe and
//      the point loses the depth test"
//
// — which is a verbatim description of the reported splat defect, written by
// the renderer that does NOT have it.
//
// The Gaussian-splat renderer is on the other side of that rule, and its own
// comment block argues the opposite ("using the stashed full-frustum pair …
// over-deepens the splat"). One of the two rationales is wrong. Which one is a
// runtime question — the two pairs coincide whenever nothing re-slices the
// frustum between the packs — so this group does NOT assert a winner. It pins
// the SPLIT, so that it is visible, attributed, and cannot be quietly changed
// on either side while the question is open; and it pins the instrument that
// answers it in one run.
// ────────────────────────────────────────────────────────────────────────────

const LOG_DEPTH_MODULE_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPULogDepth.ts";
const GLOBE_CAMERA_UB_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts";
const POINT_RENDERER_PATH =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPointPrimitiveRenderer.js";

/** Producers that prefer the stashed full-camera-frustum encode. */
const STASH_SIDE = [
  POINT_RENDERER_PATH,
  "packages/engine/Source/Renderer/WebGPU/WebGPUBillboardRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPULabelRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUPolylineRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEllipsoidPrimitiveRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUDepthPlane.ts",
];

test("G6g: the collections fleet + depth plane PREFER the stashed full-frustum encode", () => {
  // If this ever stops being true, the "the splat is the outlier" framing below
  // is no longer the right description of the defect and the whole G6g line of
  // reasoning has to be re-derived rather than quietly inherited.
  for (const path of STASH_SIDE) {
    const source = readNormalized(path);
    assert.match(
      source,
      /_logDepthEncodeNearFar/,
      `${path}: no longer reads the stashed full-frustum encode`,
    );
    assert.match(
      source,
      /ldNear = ldEncode\[0\]/,
      `${path}: no longer PREFERS the stashed pair over the live currentFrustum — ` +
        `it just moved onto the splat's side of the split that C15-G6g is investigating`,
    );
  }
});

test("G6g: the splat is the OUTLIER — it reads the live currentFrustum only", () => {
  // Stated as an observation with a citation, NOT as a verdict: whether the
  // live read is wrong depends on whether the two pairs coincide at runtime,
  // which `recordLogDepthEncoder` now measures. What must not happen is this
  // asymmetry being edited away — in EITHER direction — without the run.
  const splat = readNormalized(RENDERER_PATH);
  assert.match(
    splat,
    /const ldNear = lds\.currentFrustum\?\.x \?\? 0\.0;/,
    `${RENDERER_PATH}: the splat's log-depth source changed while C15-G6g is open — ` +
      `if this was the fix, it must land WITH the probe run that convicts it`,
  );
  assert.doesNotMatch(
    splat,
    /ldNear = ldEncode\[0\]/,
    `${RENDERER_PATH}: the splat moved onto the stash side — that is the CANDIDATE FIX, ` +
      `and it may not land without the occlusion probe's acceptance numbers`,
  );
  // The globe — the reference every other producer is compared against — is on
  // the same (live) side as the splat. That is why "they read the same fields"
  // looked conclusive, and why only the BAKED VALUES can settle it.
  const globeUB = readNormalized(GLOBE_CAMERA_UB_PATH);
  assert.match(globeUB, /const ldNear = usLog\.currentFrustum\?\.x \?\? 0\.0;/);
});

test("G6g: all three producers publish the pair they actually baked", () => {
  // The quantity that decides the depth compare is neither the FIELDS a
  // producer reads (identical in source since C15-G3d, which is what made the
  // wrong inference so persuasive) nor a post-render `uniformState` sample
  // (that is the last frustum SLICE). It is the baked pair. Three call sites,
  // one per side of the comparison the probe scores.
  const helper = readNormalized(LOG_DEPTH_MODULE_PATH);
  assert.match(
    helper,
    /export function recordLogDepthEncoder\(/,
    `${LOG_DEPTH_MODULE_PATH}: the baked-pair recorder is gone`,
  );
  // Pragma-stripped, so release builds pay nothing for it.
  const body = helper.slice(
    helper.indexOf("export function recordLogDepthEncoder("),
    helper.indexOf("Pack the per-frustum log-depth scalars"),
  );
  assert.match(
    body,
    /includeStart\('debug', pragmas\.debug\)/,
    `${LOG_DEPTH_MODULE_PATH}: recordLogDepthEncoder's body is no longer pragma-stripped — ` +
      `it now costs release builds a per-tile object write`,
  );
  for (const [path, producer] of [
    [RENDERER_PATH, "splat"],
    [GLOBE_CAMERA_UB_PATH, "globe"],
    [POINT_RENDERER_PATH, "collection"],
  ]) {
    const source = readNormalized(path);
    assert.match(
      source,
      new RegExp(`recordLogDepthEncoder\\([^)]*"${producer}"`),
      `${path}: no longer publishes its baked "${producer}" pair — the three-way ` +
        `comparison loses a leg and the run stops being decisive`,
    );
  }
});

test("G6g: the probe reconstructs each producer's frag_depth from its OWN pair", () => {
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(
    probe,
    /_diagLogDepthEncoders/,
    `${OCCLUSION_PROBE_PATH}: the probe no longer reads the baked pairs back`,
  );
  // Each geometry term must be reconstructed with the pair belonging to the
  // producer that draws it — reconstructing the splat's depth with the globe's
  // pair is precisely the assumption C15-G3d made and C15-G6g is testing.
  assert.match(probe, /globeAt8km: encodeWith\(baked\.globe, 8000\)/);
  assert.match(probe, /redSplatAt6km: encodeWith\(baked\.splat, 6000\)/);
  assert.match(probe, /greenSplatAt11km: encodeWith\(baked\.splat, 11000\)/);
  assert.match(
    probe,
    /bluePointAt11km: encodeWith\(baked\.collection, 11000\)/,
  );
  // A missing diagnostic must announce itself rather than read as "no problem".
  assert.match(
    probe,
    /baked encode triples UNAVAILABLE/,
    `${OCCLUSION_PROBE_PATH}: an absent diagnostic is now silent — the same vacuity ` +
      `shape as C15-G3b.1 / C15-G3c.1 / C15-G6f.1`,
  );
});

test("G6g: the reconstruction formula is the one the shaders execute", () => {
  // `encodeWith` must be log2(d - near + 1) * factor — the same
  // csm_vertexLogDepth -> csm_writeLogDepth composition the WGSL runs. A
  // reconstruction that drifts from the shader would produce a confident
  // wrong verdict, which is worse than no diagnostic.
  const probe = readNormalized(OCCLUSION_PROBE_PATH);
  assert.match(
    probe,
    /pair \? Math\.log2\(eyeDistance - pair\[0\] \+ 1\.0\) \* pair\[2\] : null/,
    `${OCCLUSION_PROBE_PATH}: the CPU reconstruction diverged from the shader formula`,
  );
  // And it agrees with the WGSL, executed: same inputs, same output.
  const splat = extractSplatWgsl(readNormalized(RENDERER_PATH));
  assert.equal(
    formulaBody(splat, "csm_vertexLogDepth"),
    "{ return (clipPosition.w - near) + 1.0; }",
  );
  assert.equal(
    formulaBody(splat, "csm_writeLogDepth"),
    "{ return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne; }",
  );
  const encodeWith = (pair, d) => Math.log2(d - pair[0] + 1.0) * pair[2];
  const pair = [0.1, 1e8, 1 / Math.log2(1e8 - 0.1 + 1)];
  assert.ok(Math.abs(encodeWith(pair, 8000) - 0.487892) < 1e-5);
});

const G6G_MUTANTS = [
  {
    name: "the point renderer drops its stash preference (joins the splat's side)",
    path: POINT_RENDERER_PATH,
    mutate: (source) =>
      source.replace("    ldNear = ldEncode[0];", "    ldNear = ldFrustum.x;"),
    check: (source) => {
      assert.match(
        source,
        /ldNear = ldEncode\[0\]/,
        "no longer PREFERS the stashed pair over the live currentFrustum",
      );
    },
    because: /no longer PREFERS the stashed pair/,
  },
  {
    name: "the splat silently switches to the stash without a probe run",
    path: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        "  const ldNear = lds.currentFrustum?.x ?? 0.0;",
        "  let ldNear = lds.currentFrustum?.x ?? 0.0;\n  ldNear = ldEncode[0];",
      ),
    check: (source) => {
      assert.match(
        source,
        /const ldNear = lds\.currentFrustum\?\.x \?\? 0\.0;/,
        "the splat's log-depth source changed while C15-G6g is open",
      );
      assert.doesNotMatch(
        source,
        /ldNear = ldEncode\[0\]/,
        "the splat moved onto the stash side",
      );
    },
    because: /log-depth source changed|moved onto the stash side/,
  },
  {
    name: "a baked-pair publication is dropped",
    path: GLOBE_CAMERA_UB_PATH,
    mutate: (source) =>
      source.replace(
        'recordLogDepthEncoder(uniformState, "globe", ldNear, ldFar, ldFactor);',
        "",
      ),
    check: (source) => {
      assert.match(
        source,
        /recordLogDepthEncoder\([^)]*"globe"/,
        'no longer publishes its baked "globe" pair',
      );
    },
    because: /no longer publishes its baked "globe" pair/,
  },
];

for (const mutant of G6G_MUTANTS) {
  test(`G6g mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(mutant.path);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G6h — the command bounding volume, and the multifrustum leak it closes
//
// MECHANISM (measured at Batch 888, after the encode was excluded with numbers):
// `View.createPotentiallyVisibleSet` gives a command with no `boundingVolume`
// the camera's WORST-CASE span (`View.js:382-392`). Under log depth that is
// [0.1, 1e10]; its 1e11 ratio splits into two depth slices and the command bins
// into BOTH, while the globe's tiles — which carry real bounding volumes — bin
// into the near one only. The frustum loop clears depth between slices and
// preserves colour (`WebGPUSceneRendererFrustumLoop.ts:251-253`), so the
// far-slice execution composites against a depth buffer with no globe in it.
//
// B647 added `boundingVolume: tileset.boundingSphere` for real content and the
// `C15-G6` row records that it has never executed, because every exerciser of
// this path is a synthetic primitive with no `_tileset`. The fix derives the
// volume when no tileset offers one, so no producer can inherit the worst-case
// span. These rules execute the derivation, not just its source text.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract `computeLocalSplatBoundingSphere` from the renderer and make it
 * callable: the function is pure and touches only Math / Float32Array / Number
 * plus two module constants and two Core classes, all injected here. Executing
 * the REAL source is the point — a spec that re-implemented the algorithm would
 * pass just as happily against a broken engine.
 */
function loadDerivedBoundsFn(rendererSource) {
  const text = tsBlock(
    rendererSource,
    "function computeLocalSplatBoundingSphere(",
  );
  const header = rendererSource.slice(
    rendererSource.indexOf("function computeLocalSplatBoundingSphere("),
    rendererSource.indexOf(text),
  );
  assert.match(
    header,
    /view: ArrayBufferView,\s*count: number,\s*packed: boolean,/,
    "computeLocalSplatBoundingSphere's signature changed — the extractor is stale",
  );
  // Stub the two Core classes with plain shapes; the assertions below only read
  // `center.{x,y,z}` and `radius`. Same compile-the-extracted-source technique
  // `loadPayloadPredicate` above already uses — executing the REAL function is
  // the whole point, and a `.ts` source cannot be imported directly here.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "PACKED_SPLAT_RECORD_WORDS",
    "LEGACY_SPLAT_RECORD_FLOATS",
    "BoundingSphere",
    "Cartesian3",
    `return function computeLocalSplatBoundingSphere(view, count, packed) ${text};`,
  );
  return factory(
    8,
    16,
    class {
      constructor(center, radius) {
        this.center = center;
        this.radius = radius;
      }
    },
    class {
      constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      }
    },
  );
}

/** Legacy 16-f32 record: positionHigh(0..2) + positionLow(3..5), rest unused. */
function legacyBuffer(points) {
  const out = new Float32Array(points.length * 16);
  points.forEach(([x, y, z], i) => {
    const b = i * 16;
    // Split each coordinate across the high/low lanes so the test proves the
    // RTE recombination, not just that lane 0 was read.
    out[b] = x - 0.25;
    out[b + 1] = y - 0.25;
    out[b + 2] = z - 0.25;
    out[b + 3] = 0.25;
    out[b + 4] = 0.25;
    out[b + 5] = 0.25;
  });
  return out;
}

/** Packed WASM 8-u32 record: position in words 0..2, bitcast to f32. */
function packedBuffer(points) {
  const f32 = new Float32Array(points.length * 8);
  points.forEach(([x, y, z], i) => {
    const b = i * 8;
    f32[b] = x;
    f32[b + 1] = y;
    f32[b + 2] = z;
  });
  return new Uint32Array(f32.buffer);
}

test("G6h: the derived bounding sphere is correct, EXECUTED, in both layouts", () => {
  const derive = loadDerivedBoundsFn(readNormalized(RENDERER_PATH));
  // A deliberately ASYMMETRIC, FLAT cloud: a symmetric one would pass even if
  // the centre were computed as a plain average, and a non-flat one would hide
  // an over-bounding radius.
  const points = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 4, 0],
    [0, 4, 0],
  ];
  for (const [label, view, packed] of [
    ["legacy", legacyBuffer(points), false],
    ["packed", packedBuffer(points), true],
  ]) {
    const sphere = derive(view, points.length, packed);
    assert.ok(sphere, `${label}: no sphere derived`);
    assert.ok(Math.abs(sphere.center.x - 5) < 1e-4, `${label}: centre x`);
    assert.ok(Math.abs(sphere.center.y - 2) < 1e-4, `${label}: centre y`);
    assert.ok(Math.abs(sphere.center.z - 0) < 1e-4, `${label}: centre z`);
    // Exact radius about the AABB centre = sqrt(5^2 + 2^2). Half the AABB
    // DIAGONAL would be sqrt(5^2+2^2+0^2) too here, so the flat case alone does
    // not separate them — the z-extruded case below does.
    assert.ok(
      Math.abs(sphere.radius - Math.sqrt(29)) < 1e-4,
      `${label}: radius ${sphere.radius} != sqrt(29)`,
    );
  }
  // Empty and short inputs must return null rather than a poisoned sphere: a
  // NaN centre would flow into the scene near/far accumulators and re-slice the
  // frustum for EVERY other command in the frame.
  assert.equal(derive(legacyBuffer([]), 0, false), null);
  assert.equal(derive(new Float32Array(4), 1, false), null, "short buffer");
  const nonFinite = legacyBuffer([[0, 0, 0]]);
  nonFinite[0] = Number.NaN;
  assert.equal(derive(nonFinite, 1, false), null, "all-NaN cloud");
});

test("G6h: the radius is exact about the centre, not half the AABB diagonal", () => {
  const derive = loadDerivedBoundsFn(readNormalized(RENDERER_PATH));
  // No point sits at an AABB CORNER: the x-extremes are at mid-height and the
  // y-extremes are at mid-span. Half the AABB diagonal then strictly
  // over-bounds, so this separates the two formulas — a cloud whose extremes
  // happen to be corners does not, which is why the flat case above cannot
  // stand in for this one. Over-bounding widens the scene FAR plane for every
  // command in the frame, which is how a "harmless" bounding volume re-slices
  // the frustum.
  const points = [
    [-5, 0.5, 0],
    [5, 0.5, 0],
    [0, 0, 0],
    [0, 1, 0],
  ];
  const sphere = derive(legacyBuffer(points), points.length, false);
  const halfDiagonal = Math.sqrt(5 * 5 + 0.5 * 0.5);
  assert.ok(Math.abs(sphere.center.y - 0.5) < 1e-4);
  assert.ok(
    sphere.radius < halfDiagonal,
    `radius ${sphere.radius} is not tighter than the half-diagonal ${halfDiagonal}`,
  );
  assert.ok(Math.abs(sphere.radius - 5) < 1e-4);
});

test("G6h: the command's bounding volume is derived, and in WORLD space", () => {
  const renderer = readNormalized(RENDERER_PATH);
  // Fallback order: tileset sphere (WebGL parity, covers non-resident tiles)
  // then the derived sphere. Losing either leg re-opens the leak for a
  // different class of producer.
  assert.match(
    renderer,
    /let commandBoundingVolume = parityFields\._tileset\?\.boundingSphere;/,
    `${RENDERER_PATH}: the tileset bounding sphere is no longer the first source — that is B647's WebGL-parity path`,
  );
  assert.match(
    renderer,
    /if \(!commandBoundingVolume && cache\.localBoundingSphere\)/,
    `${RENDERER_PATH}: the derived-bounds fallback is gone — BV-less commands inherit the camera worst-case span again and re-open C15-G6h`,
  );
  // C15-G3's lesson: the splat's model frame is `_rootTransform` for real
  // content and `modelMatrix` for synthetic primitives. A volume left in model
  // space bins against the camera as though the tileset sat at the geocentre.
  assert.match(
    renderer,
    /BoundingSphere\.transform\(\s*cache\.localBoundingSphere,\s*commandModelMatrix,/,
    `${RENDERER_PATH}: the derived sphere is no longer transformed to world space by the command's own matrix`,
  );
  // Derived exactly where the bytes it describes are uploaded, so the two can
  // never disagree — and so the O(n) scan cannot migrate into the per-frame path.
  const commitBlock = renderer.slice(
    renderer.indexOf("cache.splatSourceToken = source.token;"),
    renderer.indexOf("cache.instanceDataRevision++"),
  );
  assert.match(
    commitBlock,
    /cache\.localBoundingSphere = computeLocalSplatBoundingSphere\(/,
    `${RENDERER_PATH}: the bounds derivation left the attribute-commit block`,
  );
  assert.equal(
    (renderer.match(/computeLocalSplatBoundingSphere\(/g) ?? []).length,
    2,
    `${RENDERER_PATH}: computeLocalSplatBoundingSphere has more than its definition + single commit-block call site — an extra call is a per-frame O(n) scan`,
  );
});

const G6H_MUTANTS = [
  {
    name: "the derived-bounds fallback is removed (BV-less commands return)",
    mutate: (source) =>
      source.replace(
        "if (!commandBoundingVolume && cache.localBoundingSphere) {",
        "if (false && cache.localBoundingSphere) {",
      ),
    check: (source) =>
      assert.match(
        source,
        /if \(!commandBoundingVolume && cache\.localBoundingSphere\)/,
        "the derived-bounds fallback is gone",
      ),
    because: /derived-bounds fallback is gone/,
  },
  {
    name: "the derived sphere is left in MODEL space (transform dropped)",
    mutate: (source) =>
      source.replace(
        /BoundingSphere\.transform\(\s*cache\.localBoundingSphere,\s*commandModelMatrix,\s*cache\.worldBoundingSphere,\s*\)/,
        "cache.localBoundingSphere",
      ),
    check: (source) =>
      assert.match(
        source,
        /BoundingSphere\.transform\(\s*cache\.localBoundingSphere,\s*commandModelMatrix,/,
        "the derived sphere is no longer transformed to world space",
      ),
    because: /no longer transformed to world space/,
  },
  {
    name: "the legacy RTE recombination drops the low word",
    mutate: (source) =>
      source.replace(
        "    const x = packed ? f32[base] : f32[base] + f32[base + 3];",
        "    const x = f32[base];",
      ),
    check: (source) => {
      const derive = loadDerivedBoundsFn(source);
      const sphere = derive(legacyBuffer([[10, 0, 0]]), 1, false);
      assert.ok(
        Math.abs(sphere.center.x - 10) < 1e-4,
        `centre x ${sphere.center.x} lost the RTE low word`,
      );
    },
    because: /lost the RTE low word/,
  },
  {
    name: "the O(n) scan is hoisted out of the commit block into every frame",
    mutate: (source) =>
      source.replace(
        "  let commandBoundingVolume = parityFields._tileset?.boundingSphere;",
        "  cache.localBoundingSphere = computeLocalSplatBoundingSphere(source.view, source.count, source.packed);\n  let commandBoundingVolume = parityFields._tileset?.boundingSphere;",
      ),
    check: (source) =>
      assert.equal(
        (source.match(/computeLocalSplatBoundingSphere\(/g) ?? []).length,
        2,
        "an extra call is a per-frame O(n) scan",
      ),
    because: /per-frame O\(n\) scan/,
  },
];

for (const mutant of G6H_MUTANTS) {
  test(`G6h mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(RENDERER_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
  });
}

test("G6h: the per-frustum depth clear that makes binning load-bearing is still there", () => {
  // The leak needs BOTH halves: a command in a slice it does not belong in, AND
  // depth being reset between slices while colour accumulates. If the second
  // half ever changes, the bounding volume stops being a correctness fix and
  // becomes a performance one — a future reader must not inherit the wrong
  // reason for this code.
  const loop = readNormalized(FRUSTUM_LOOP_PATH);
  assert.match(
    loop,
    /Clear depth\/stencil per frustum \(but not color — color accumulates across frustums\)\./,
    `${FRUSTUM_LOOP_PATH}: the per-frustum depth-clear contract changed`,
  );
  assert.match(loop, /host\._clearDepthStencil\(context\);/);
  const view = readNormalized("packages/engine/Source/Scene/View.js");
  assert.match(
    view,
    /If command has no bounding volume we need to use the camera's[\s\S]{0,120}worst-case near and far planes/,
    "View.js no longer gives BV-less commands the camera worst-case span — re-derive C15-G6h before trusting it",
  );
});

// ── C15-G4 — the asynchronous WASM radix sort, consumed ─────────────────────
//
// The row's claim is a NEGATIVE one — "no synchronous main-thread sort runs on
// production content" — and a negative claim is exactly the kind that goes
// vacuously green. Three ways it could:
//
//   * the comparator is skipped because the splat count is 0, not because the
//     worker's permutation arrived (nothing drew, so nothing sorted);
//   * the worker's permutation IS uploaded, but a superseded one can overwrite
//     it afterwards, so the draw order silently regresses to an older camera;
//   * the upload happens before the resolution check, so the buffer is written
//     from whatever `_indexes` happened to hold — including nothing.
//
// So the guard below does not assert "the comparator did not run". It EXECUTES
// the real swap function over an ordered sequence of resolutions and asserts
// which bytes are resident afterwards, and it re-runs every rule against
// mutated copies of the real engine source. Nothing here touches the tree: the
// mutants are in-memory copies, compiled and thrown away.

/**
 * Extract the real `uploadProvidedSortOrder` and compile it. The only TS in the
 * body is the one `as unknown as` cast, which erases to the identity.
 */
function loadUploadProvidedSortOrder(rendererSource) {
  const at = rendererSource.indexOf("function uploadProvidedSortOrder(");
  assert.notEqual(
    at,
    -1,
    `${RENDERER_PATH}: uploadProvidedSortOrder is gone — C15-G4's consume half`,
  );
  const body = tsBlock(rendererSource, "function uploadProvidedSortOrder(");
  const header = rendererSource.slice(at, rendererSource.indexOf(body, at));
  assert.match(
    header,
    /device: GPUDevice,\s*primitive: CesiumObjectWithWebGPUCache,\s*cache: GaussianSplatCache,/,
    "uploadProvidedSortOrder's signature changed — the extractor is stale",
  );
  const js = body.replace(/ as unknown as \{[\s\S]*?\}/, "");
  assert.ok(
    !js.includes(" as unknown as"),
    "an unhandled TS cast survived into the extracted body",
  );
  // eslint-disable-next-line no-new-func
  return new Function(
    `return function uploadProvidedSortOrder(device, primitive, cache) ${js};`,
  )();
}

/** A stand-in GPU buffer whose resident bytes the rules can read back. */
function fakeSortBuffer(count) {
  return { label: "sortedIndices", resident: new Uint32Array(count) };
}

function fakeDevice(options = {}) {
  const writes = [];
  return {
    writes,
    queue: {
      writeBuffer(buffer, offset, data) {
        if (options.throwOnWrite) {
          throw new Error("device write rejected");
        }
        writes.push({ buffer, offset, data: Uint32Array.from(data) });
        buffer.resident.set(data, offset);
      },
    },
  };
}

function sortCache(count, overrides = {}) {
  return {
    splatCount: count,
    sortedIndexBuffer: fakeSortBuffer(count),
    providedIndexSource: null,
    providedIndexSequence: -1,
    providedIndexGeneration: -1,
    comparatorSorts: 0,
    providedSortUploads: 0,
    supersededSortUploads: 0,
    lastSortCameraDir: {},
    sortRequestPending: true,
    ...overrides,
  };
}

/** A primitive as the producer stamps it: permutation + provenance. */
function sortedPrimitive(order, sequence, dataGeneration) {
  return {
    _indexes: Uint32Array.from(order),
    _indexesSortSequence: sequence,
    _indexesDataGeneration: dataGeneration,
  };
}

test("G4: the worker's permutation is uploaded and becomes the resident order", () => {
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  const consumed = upload(device, sortedPrimitive([2, 0, 1], 7, 3), cache);
  assert.equal(consumed, true, "a resolved permutation must be consumed");
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [2, 0, 1]);
  assert.equal(cache.providedSortUploads, 1);
  assert.equal(cache.providedIndexSequence, 7);
  assert.equal(cache.providedIndexGeneration, 3);
});

test("G4: a re-upload of the SAME array is not re-written", () => {
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  const primitive = sortedPrimitive([2, 0, 1], 7, 3);
  upload(device, primitive, cache);
  const consumed = upload(device, primitive, cache);
  assert.equal(consumed, true);
  assert.equal(
    device.writes.length,
    1,
    "the same permutation re-uploaded every frame is 1.1 MB/frame on tower",
  );
});

test("G4 GENERATION GUARD: an out-of-order resolution does NOT regress the buffer", () => {
  // The row's correctness point, executed. Sort B (newer camera) resolves
  // first; sort A (older camera, LOWER sequence, same data) resolves after.
  // The late arrival must not put the older order back on the GPU, and it must
  // not hand control to the synchronous comparator either.
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();

  upload(device, sortedPrimitive([2, 1, 0], 9, 3), cache);
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [2, 1, 0]);

  const consumed = upload(device, sortedPrimitive([0, 1, 2], 8, 3), cache);
  assert.equal(
    consumed,
    true,
    "a refused resolution must still report the order as resident — falling " +
      "through to the synchronous comparator is the outcome G4 removes",
  );
  assert.deepEqual(
    Array.from(cache.sortedIndexBuffer.resident),
    [2, 1, 0],
    "the superseded sort regressed the resident draw order",
  );
  assert.equal(device.writes.length, 1, "the stale permutation was written");
  assert.equal(cache.supersededSortUploads, 1);
  assert.equal(cache.providedIndexSequence, 9, "provenance moved backwards");
});

test("G4 GENERATION GUARD: re-delivering the SAME sequence is refused", () => {
  // Equal is not newer. Without the `<=` this is an accepted re-write of an
  // order that is already resident — harmless in bytes, but it means the guard
  // is comparing the wrong thing and the strictly-older case is one edit away.
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  upload(device, sortedPrimitive([2, 1, 0], 9, 3), cache);
  upload(device, sortedPrimitive([0, 1, 2], 9, 3), cache);
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [2, 1, 0]);
  assert.equal(cache.supersededSortUploads, 1);
});

test("G4 GENERATION GUARD: an OLDER data generation is refused even with a higher sequence", () => {
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  upload(device, sortedPrimitive([2, 1, 0], 9, 4), cache);
  upload(device, sortedPrimitive([0, 1, 2], 99, 3), cache);
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [2, 1, 0]);
  assert.equal(cache.supersededSortUploads, 1);
});

test("G4 GENERATION GUARD: a NEWER data generation wins even with a lower sequence", () => {
  // The counter-case that stops the guard from being a plain `sequence >`
  // monotonic counter. A rebuild re-bases the data; its permutation must land.
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  upload(device, sortedPrimitive([2, 1, 0], 90, 3), cache);
  const consumed = upload(device, sortedPrimitive([1, 0, 2], 4, 4), cache);
  assert.equal(consumed, true);
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [1, 0, 2]);
  assert.equal(cache.providedIndexGeneration, 4);
});

test("G4: no upload before the sort has resolved", () => {
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  const consumed = upload(device, { _indexes: undefined }, cache);
  assert.equal(
    consumed,
    false,
    "with no permutation there is nothing to be resident",
  );
  assert.equal(device.writes.length, 0, "wrote the buffer before resolution");
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [0, 0, 0]);
});

test("G4: a permutation that does not describe the resident buffer is refused", () => {
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  const consumed = upload(device, sortedPrimitive([1, 0], 7, 3), cache);
  assert.equal(consumed, false, "a length mismatch must not be consumed");
  assert.equal(device.writes.length, 0);
});

test("G4: an UNSTAMPED producer keeps the historical identity-only behaviour", () => {
  // The three synthetic probes hand this renderer a hand-rolled object. They
  // carry no `_indexes` at all today, but the surface is public enough that a
  // producer supplying one without provenance must not be locked out.
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice();
  upload(device, { _indexes: Uint32Array.from([2, 1, 0]) }, cache);
  upload(device, { _indexes: Uint32Array.from([0, 2, 1]) }, cache);
  assert.deepEqual(Array.from(cache.sortedIndexBuffer.resident), [0, 2, 1]);
  assert.equal(cache.providedSortUploads, 2);
});

test("G4: a failed write does not leave the cache claiming residency", () => {
  // Bookkeeping ahead of the write is the classic version of this bug: the
  // cache says permutation P is resident, the GPU still holds the old one, and
  // the identity short-circuit then refuses to ever correct it.
  const upload = loadUploadProvidedSortOrder(readNormalized(RENDERER_PATH));
  const cache = sortCache(3);
  const device = fakeDevice({ throwOnWrite: true });
  assert.throws(() => upload(device, sortedPrimitive([2, 1, 0], 7, 3), cache));
  assert.equal(
    cache.providedIndexSource,
    null,
    "the cache recorded a permutation the GPU never received",
  );
  assert.equal(cache.providedIndexSequence, -1);
  assert.equal(cache.providedSortUploads, 0);
});

// ── C15-G4 source anchors: the schedule → resolve → consume chain ───────────

test("G4 SCHEDULE: the WASM radix sort is scheduled above the backend branch", () => {
  // If the schedule sat below the feature-renderer dispatch, WebGPU would never
  // get a permutation and the comparator would be load-bearing again. This is
  // the C15-G2 extraction that G4 depends on; it must not be reverted.
  const primitive = readNormalized(PRIMITIVE_PATH);
  const update = tsBlock(primitive, "  update(frameState) {");
  const dataAt = update.indexOf("this._updateSplatData(frameState);");
  const dispatchAt = update.indexOf("fr.update(this, frameState);");
  assert.ok(dataAt !== -1 && dispatchAt !== -1, "the update chain changed");
  assert.ok(
    dataAt < dispatchAt,
    "the shared data pipeline (which schedules the sort) must run BEFORE the " +
      "feature renderer, or WebGPU never sees `_indexes`",
  );
  const shared = tsBlock(primitive, "  _updateSplatData(frameState) {");
  assert.ok(
    shared.includes("GaussianSplatSorter.radixSortIndexes({"),
    "the worker sort is no longer scheduled from the backend-neutral half",
  );
  assert.ok(
    !shared.includes("Array.prototype.sort"),
    "a synchronous sort appeared in the shared per-frame path",
  );
});

test("G4 PUBLISH: the steady sort publishes through the sequence guard", () => {
  const primitive = readNormalized(PRIMITIVE_PATH);
  const steady = tsBlock(primitive, "async function resolveSteadySort(");
  assert.ok(
    steady.includes("publishSortedIndexes("),
    "resolveSteadySort no longer routes through the sequence guard",
  );
  assert.ok(
    !/primitive\._indexes = sortedData/.test(steady),
    "resolveSteadySort assigns `_indexes` directly, bypassing the guard",
  );
  const commit = tsBlock(primitive, "function commitSnapshot(");
  assert.ok(
    commit.includes("primitive._indexesSortSequence =") &&
      commit.includes("primitive._indexesDataGeneration ="),
    "the atomic commit no longer stamps the permutation's provenance — a " +
      "consumer cannot order what carries no sequence",
  );
});

test("G4 CONSUME: the async permutation is tried before the comparator", () => {
  const renderer = readNormalized(RENDERER_PATH);
  const provided = renderer.indexOf(
    "if (!uploadProvidedSortOrder(device, primitive, cache)) {",
  );
  assert.notEqual(provided, -1, "the sort chain's entry point moved");
  const comparator = renderer.indexOf(
    "maybeSortSplats(device, primitive, frameState, cache);",
    provided,
  );
  assert.ok(
    comparator > provided,
    "the synchronous comparator must be reachable only when no provided " +
      "permutation describes the resident buffer",
  );
});

test("G4 RETIREMENT: maybeSortSplats survives, but cannot run on packed content", () => {
  // Principle 7. The comparator's three exercisers are synthetic legacy-layout
  // probes, one of which (probe-splat-sort) is the Batch-288 sort-consume
  // evidence. Deleting it turns a green instrument red for an unrelated reason.
  const renderer = readNormalized(RENDERER_PATH);
  const body = tsBlock(renderer, "function maybeSortSplats(");
  assert.ok(
    body.includes("if (cache.layoutPacked) {\n    return;\n  }"),
    "the packed early-out is gone — the synchronous main-thread sort is back " +
      "on the production path",
  );
  const guardAt = body.indexOf("if (cache.layoutPacked)");
  const sortAt = body.indexOf("Array.prototype.sort.call(");
  assert.ok(
    guardAt !== -1 && sortAt !== -1 && guardAt < sortAt,
    "the packed guard no longer dominates the sort",
  );
  assert.ok(
    body.includes("cache.comparatorSorts++"),
    "the exit gate's observable is gone — 'the comparator never runs' would " +
      "be an inference again, not a measurement",
  );
  for (const probe of [
    "probe-splat-sort.mjs",
    "probe-splat-globe-occlusion.mjs",
    "probe-oit-transparency.mjs",
  ]) {
    assert.ok(
      existsSync(resolve(ROOT, "Tools/visual-regression", probe)),
      `${probe} is gone — re-derive whether maybeSortSplats still has an exerciser`,
    );
  }
});

test("G4 OBSERVABLE: the probe samples and prints the comparator counter", () => {
  // Without this the row's exit gate is unreadable: "the comparator never ran"
  // would be re-derived from source shape on every future run instead of
  // measured on the run being judged. `providedSortUploads` rides along as the
  // liveness partner — comparatorSorts=0 with providedSortUploads=0 means
  // nothing sorted at all, which is the vacuous green.
  assert.match(
    PROBE_CODE,
    /record\.cacheComparatorSorts =\s*\n?\s*p\?\._webgpuCache\?\.comparatorSorts \?\? null;/,
    `${PROBE_PATH}: the C15-G4 exit-gate observable is not sampled`,
  );
  assert.match(
    PROBE_CODE,
    /record\.cacheProvidedSortUploads =/,
    `${PROBE_PATH}: the comparator counter lost its liveness partner`,
  );
  assert.match(
    PROBE_CODE,
    /record\.cacheSupersededSortUploads =/,
    `${PROBE_PATH}: the sequence guard's refusal counter is not sampled`,
  );
  assert.match(
    PROBE,
    /comparatorSorts=\$\{/,
    `${PROBE_PATH}: the exit-gate observable is sampled but never printed`,
  );
});

const G4_MUTANTS = [
  {
    name: "the synchronous comparator is restored on the WebGPU packed path",
    file: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        "  if (cache.layoutPacked) {\n    return;\n  }\n  const splatData",
        "  const splatData",
      ),
    check: (source) => {
      const body = tsBlock(source, "function maybeSortSplats(");
      assert.ok(
        body.includes("if (cache.layoutPacked) {\n    return;\n  }"),
        "the packed early-out is gone",
      );
    },
    because: /packed early-out is gone/,
  },
  {
    name: "the consumer's generation guard is removed",
    file: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        / {4}if \(\n {6}generation < cache\.providedIndexGeneration \|\|[\s\S]*?\n {4}\) \{\n {6}cache\.supersededSortUploads\+\+;\n {6}return true;\n {4}\}\n/,
        "",
      ),
    check: (source) => {
      const upload = loadUploadProvidedSortOrder(source);
      const cache = sortCache(3);
      const device = fakeDevice();
      upload(device, sortedPrimitive([2, 1, 0], 9, 3), cache);
      upload(device, sortedPrimitive([0, 1, 2], 8, 3), cache);
      assert.deepEqual(
        Array.from(cache.sortedIndexBuffer.resident),
        [2, 1, 0],
        "the superseded sort regressed the resident draw order",
      );
    },
    because: /regressed the resident draw order/,
  },
  {
    name: "the upload is hoisted above the resolution check",
    file: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        "  const indexes = fields._indexes;\n  const count = cache.splatCount;",
        "  const indexes = fields._indexes;\n  const count = cache.splatCount;\n  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indexes ?? []);",
      ),
    check: (source) => {
      const upload = loadUploadProvidedSortOrder(source);
      const cache = sortCache(3);
      const device = fakeDevice();
      upload(device, { _indexes: undefined }, cache);
      assert.equal(
        device.writes.length,
        0,
        "wrote the buffer before the sort resolved",
      );
    },
    because: /before the sort resolved/,
  },
  {
    name: "the cache records residency before the write succeeds",
    file: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        "  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indexes);\n  // Bookkeeping AFTER the write",
        "  cache.providedIndexSource = indexes;\n  device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indexes);\n  // Bookkeeping AFTER the write",
      ),
    check: (source) => {
      const upload = loadUploadProvidedSortOrder(source);
      const cache = sortCache(3);
      const device = fakeDevice({ throwOnWrite: true });
      assert.throws(() =>
        upload(device, sortedPrimitive([2, 1, 0], 7, 3), cache),
      );
      assert.equal(
        cache.providedIndexSource,
        null,
        "the cache recorded a permutation the GPU never received",
      );
    },
    because: /the GPU never received/,
  },
  {
    name: "the exit gate's comparator counter is deleted",
    file: RENDERER_PATH,
    mutate: (source) => source.replace("  cache.comparatorSorts++;\n", ""),
    check: (source) => {
      const body = tsBlock(source, "function maybeSortSplats(");
      assert.ok(
        body.includes("cache.comparatorSorts++"),
        "the exit gate's observable is gone",
      );
    },
    because: /exit gate's observable is gone/,
  },
  {
    name: "the steady sort publishes `_indexes` directly again",
    file: PRIMITIVE_PATH,
    mutate: (source) =>
      source.replace(
        / {4}if \(\n {6}!publishSortedIndexes\([\s\S]*?\n {4}\) \{\n {6}primitive\._sorterPromise = undefined;\n {6}primitive\._sorterState = GaussianSplatSortingState\.IDLE;\n {6}return;\n {4}\}\n/,
        "    primitive._indexes = sortedData;\n",
      ),
    check: (source) => {
      const steady = tsBlock(source, "async function resolveSteadySort(");
      assert.ok(
        steady.includes("publishSortedIndexes("),
        "resolveSteadySort no longer routes through the sequence guard",
      );
    },
    because: /no longer routes through the sequence guard/,
  },
  {
    name: "the commit stops stamping the permutation's provenance",
    file: PRIMITIVE_PATH,
    mutate: (source) =>
      source.replace(
        / {2}primitive\._indexesSortSequence = snapshot\.indexesSortSequence \?\? 0;\n {2}primitive\._indexesDataGeneration =\n {4}snapshot\.indexesDataGeneration \?\? primitive\._splatDataGeneration;\n/,
        "",
      ),
    check: (source) => {
      const commit = tsBlock(source, "function commitSnapshot(");
      assert.ok(
        commit.includes("primitive._indexesSortSequence =") &&
          commit.includes("primitive._indexesDataGeneration ="),
        "the atomic commit no longer stamps the permutation's provenance",
      );
    },
    because: /no longer stamps the permutation's provenance/,
  },
  {
    name: "the shared schedule is moved below the feature-renderer dispatch",
    file: PRIMITIVE_PATH,
    mutate: (source) =>
      source.replace(
        "    this._updateSplatData(frameState);\n\n    if (defined(fr)) {\n      fr.update(this, frameState);\n    }",
        "    if (defined(fr)) {\n      fr.update(this, frameState);\n    }\n\n    this._updateSplatData(frameState);",
      ),
    check: (source) => {
      const update = tsBlock(source, "  update(frameState) {");
      assert.ok(
        update.indexOf("this._updateSplatData(frameState);") <
          update.indexOf("fr.update(this, frameState);"),
        "the shared data pipeline no longer runs before the feature renderer",
      );
    },
    because: /no longer runs before the feature renderer/,
  },
];

for (const mutant of G4_MUTANTS) {
  test(`G4 mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(mutant.file);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
    // And the rule passes on the real source — otherwise the mutant proves
    // nothing about the shipped code.
    mutant.check(real);
  });
}

// ── C15-G4b — the determinism pair is sort-quiesced and same-task ───────────
//
// Batch 890's `tower` run exited 3 on `reference:capture-determinism` — the
// WEBGL leg measured 0.052% (410 px) against a 0.050% bar, with WebGPU at 329
// px. `sh_unit_cube` read 0.000% on both. The defect scaled with splat COUNT
// (286,868 vs 27), not with footprint area, and the scored footprint is only
// ~32,000 px — so ~1.3% of the drawn splat pixels differed between two captures
// of a scene whose clock is pinned, camera frozen, TAA and HDR off, and globe,
// sky, sun and moon hidden.
//
// The fix is structural rather than mechanism-specific, and deliberately so:
// with every synchronous source of variance already excluded by the scene
// setup, what remains is asynchronous work landing on event-loop yields, and
// the old pair had `await settleMs(2000)` — thousands of yields — between its
// two captures. Taking both captures in ONE TASK removes the entire class by
// the JS execution model, not by a timing hope. The quiescence wait then makes
// "the sort was quiet when we scored" an asserted precondition instead of an
// assumption, and preserves the temporal-stability check the old window used to
// provide.
//
// The 0.050% bar is NOT widened. It is what caught this.

/**
 * Extract and compile the real `waitForSortQuiescence`. It closes over exactly
 * four things, all injectable: `renderNow`, `sortSignature`, `sortInFlight` and
 * the global clock/timer.
 */
function loadQuiescenceWait(probeSource) {
  const header =
    "const waitForSortQuiescence = async (windowMs, budgetMs) => {";
  const at = probeSource.indexOf(header);
  assert.notEqual(
    at,
    -1,
    `${PROBE_PATH}: waitForSortQuiescence is gone — C15-G4b's precondition`,
  );
  const body = tsBlock(probeSource, header);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "performance",
    "renderNow",
    "sortSignature",
    "sortInFlight",
    "setTimeout",
    `return async function waitForSortQuiescence(windowMs, budgetMs) ${body};`,
  );
  return (deps) =>
    factory(
      deps.performance,
      deps.renderNow,
      deps.sortSignature,
      deps.sortInFlight,
      deps.setTimeout,
    );
}

/** A clock that advances a fixed step on every read — no real timers. */
function fakeClock(stepMs = 10) {
  let t = 0;
  return {
    now: () => {
      t += stepMs;
      return t;
    },
  };
}

function quiescenceDeps(overrides = {}) {
  return {
    performance: fakeClock(),
    renderNow: () => {},
    sortSignature: () => "stable",
    sortInFlight: () => false,
    setTimeout: (fn) => fn(),
    ...overrides,
  };
}

test("G4b QUIESCE: a settled sort signature quiesces", async () => {
  const wait = loadQuiescenceWait(readNormalized(PROBE_PATH));
  const result = await wait(quiescenceDeps())(200, 20_000);
  assert.equal(result.quiesced, true, "a stable, idle sort never quiesced");
  assert.equal(result.signature, "stable");
});

test("G4b QUIESCE: a sort that keeps resolving NEVER quiesces", async () => {
  // The case the row exists for. If this returned `quiesced: true` the
  // precondition would wave through exactly the scene it is meant to refuse.
  const wait = loadQuiescenceWait(readNormalized(PROBE_PATH));
  let n = 0;
  const result = await wait(
    quiescenceDeps({ sortSignature: () => `seq-${n++}` }),
  )(200, 20_000);
  assert.equal(
    result.quiesced,
    false,
    "a sort still publishing new permutations was reported as quiescent",
  );
});

test("G4b QUIESCE: an in-flight sort blocks quiescence even with a stable signature", async () => {
  // A promise that has not resolved yet has not CHANGED the signature either.
  // Signature-stability alone would call that quiet, and it is the opposite:
  // it is a resolution about to land.
  const wait = loadQuiescenceWait(readNormalized(PROBE_PATH));
  const result = await wait(quiescenceDeps({ sortInFlight: () => true }))(
    200,
    20_000,
  );
  assert.equal(
    result.quiesced,
    false,
    "an unresolved sort promise was reported as quiescent",
  );
});

test("G4b QUIESCE: a sort that settles LATE still quiesces before the budget", async () => {
  // Anti-vacuity for the two refusals above: the wait must be able to succeed
  // after churn, or "never quiesces" would pass by being unsatisfiable.
  const wait = loadQuiescenceWait(readNormalized(PROBE_PATH));
  let calls = 0;
  const result = await wait(
    quiescenceDeps({
      sortSignature: () => (calls++ < 30 ? `seq-${calls}` : "settled"),
    }),
  )(200, 20_000);
  assert.equal(result.quiesced, true, "the wait cannot succeed at all");
  assert.equal(result.signature, "settled");
});

test("G4b PAIR: the determinism captures are taken back-to-back in ONE task", () => {
  // The structural fix. Any `await` between the two captures re-opens the
  // window in which a worker message, a promise continuation or a timer can
  // land — which is the entire class of causes the scene setup has not already
  // excluded.
  const from = PROBE_CODE.indexOf("const onA = captureNow();");
  assert.notEqual(from, -1, `${PROBE_PATH}: the scored capture moved`);
  const to = PROBE_CODE.indexOf(
    "record.determinismChanged = changedPixelCount(onA.image, onB.image);",
    from,
  );
  assert.ok(to > from, `${PROBE_PATH}: the determinism pair moved`);
  const between = PROBE_CODE.slice(from, to);
  assert.ok(
    between.includes("const onB = captureNow();"),
    "the repeat capture is no longer adjacent to the scored one",
  );
  assert.doesNotMatch(
    between,
    /\bawait\b/,
    `${PROBE_PATH}: an await reappeared between the determinism captures — a ` +
      `resolved WASM radix sort can land on that yield and re-order an ` +
      `order-dependent premultiplied blend`,
  );
});

test("G4b PAIR: quiescence is waited for BEFORE the pair, not after", () => {
  const waitAt = PROBE_CODE.indexOf("await waitForSortQuiescence(");
  const pairAt = PROBE_CODE.indexOf("const onA = captureNow();");
  assert.ok(waitAt !== -1, `${PROBE_PATH}: the quiescence wait is not called`);
  assert.ok(
    waitAt < pairAt,
    "quiescing after the pair proves nothing about the pair",
  );
});

test("G4b SIGNATURE: quiescence is BACKEND-NEUTRAL", () => {
  // The leg that failed at Batch 890 was WEBGL, which has no `_webgpuCache`.
  // A signature built only from the WebGPU counters would leave the failing
  // leg completely unprotected while reading green.
  const signature = tsBlock(
    readNormalized(PROBE_PATH),
    "const sortSignature = () => {",
  );
  assert.ok(
    signature.includes("_indexesSortSequence"),
    "the quiescence signature dropped the backend-neutral sort provenance — " +
      "the WebGL leg would be unprotected",
  );
  assert.ok(
    signature.includes("_indexesDataGeneration"),
    "the quiescence signature dropped the data generation",
  );
  const inFlight = tsBlock(
    readNormalized(PROBE_PATH),
    "const sortInFlight = () => {",
  );
  for (const slot of [
    "_sorterPromise",
    "_pendingSortPromise",
    "_pendingSnapshot",
  ]) {
    assert.ok(
      inFlight.includes(slot),
      `sortInFlight no longer covers ${slot} — an unresolved sort would read as quiet`,
    );
  }
});

test("G4b BAR: the determinism threshold is NOT widened", () => {
  // The whole finding rests on the bar. 0.052% failed against 0.050%; relaxing
  // the number would have "fixed" the run by deleting the instrument.
  assert.equal(
    PREDICT.determinismFraction,
    0.0005,
    "the determinism bar moved — C15-G4b fixes the apparatus, not the threshold",
  );
});

const G4B_MUTANTS = [
  {
    name: "a settle window is reintroduced between the two captures",
    file: PROBE_PATH,
    mutate: (source) =>
      source.replace(
        "  const onA = captureNow();\n  const onB = captureNow();",
        "  const onA = captureNow();\n  await settleMs(predict.settleMs);\n  const onB = captureNow();",
      ),
    check: (source) => {
      const code = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      const from = code.indexOf("const onA = captureNow();");
      const to = code.indexOf(
        "record.determinismChanged = changedPixelCount(onA.image, onB.image);",
        from,
      );
      assert.doesNotMatch(
        code.slice(from, to),
        /\bawait\b/,
        "an await reappeared between the determinism captures",
      );
    },
    because: /await reappeared between the determinism captures/,
  },
  {
    name: "the quiescence wait is dropped",
    file: PROBE_PATH,
    mutate: (source) =>
      source.replace(
        "  const quiescence = await waitForSortQuiescence(\n    predict.settleMs,\n    quiesceBudgetMs,\n  );",
        "  const quiescence = { quiesced: true, ms: 0, signature: null };",
      ),
    check: (source) => {
      // POSITION-SPECIFIC, not a bare `includes`. CO-12 added quiescence waits
      // to the orbit and to both vacuity controls, all of them AFTER the scored
      // pair — so "is the name mentioned anywhere?" stopped discriminating the
      // moment those landed, and this mutant survived. The claim the rule
      // actually makes is that the SCORED pair is quiesced, so the check has to
      // be about the first wait's position relative to that pair.
      const waitAt = source.indexOf("await waitForSortQuiescence(");
      const pairAt = source.indexOf("const onA = captureNow();");
      assert.ok(
        waitAt !== -1 && pairAt !== -1 && waitAt < pairAt,
        "the quiescence wait is not called before the scored determinism pair",
      );
    },
    because: /quiescence wait is not called before the scored determinism pair/,
  },
  {
    name: "the quiescence wait reports success when its budget expires",
    file: PROBE_PATH,
    mutate: (source) =>
      source.replace(
        "    return {\n      quiesced: false,\n      ms: performance.now() - start,\n      signature: sortSignature(),\n    };",
        "    return {\n      quiesced: true,\n      ms: performance.now() - start,\n      signature: sortSignature(),\n    };",
      ),
    check: async (source) => {
      const wait = loadQuiescenceWait(source);
      let n = 0;
      const result = await wait(
        quiescenceDeps({ sortSignature: () => `seq-${n++}` }),
      )(200, 20_000);
      assert.equal(
        result.quiesced,
        false,
        "a sort still publishing new permutations was reported as quiescent",
      );
    },
    because: /was reported as quiescent/,
  },
  {
    name: "the quiescence signature is narrowed to the WebGPU counters",
    file: PROBE_PATH,
    mutate: (source) =>
      source.replace(
        "      p?._indexesSortSequence ?? -1,\n      p?._indexesDataGeneration ?? -1,",
        "",
      ),
    check: (source) => {
      const signature = tsBlock(source, "const sortSignature = () => {");
      assert.ok(
        signature.includes("_indexesSortSequence"),
        "the quiescence signature dropped the backend-neutral sort provenance",
      );
    },
    because: /dropped the backend-neutral sort provenance/,
  },
  {
    name: "the in-flight test stops blocking quiescence",
    file: PROBE_PATH,
    mutate: (source) =>
      source.replace(
        "      if (next !== signature || sortInFlight()) {",
        "      if (next !== signature) {",
      ),
    check: async (source) => {
      const wait = loadQuiescenceWait(source);
      const result = await wait(quiescenceDeps({ sortInFlight: () => true }))(
        200,
        20_000,
      );
      assert.equal(
        result.quiesced,
        false,
        "an unresolved sort promise was reported as quiescent",
      );
    },
    because: /unresolved sort promise was reported as quiescent/,
  },
  {
    name: "the determinism bar is widened to swallow the Batch-890 reading",
    file: "Tools/visual-regression/lib/gsplat-parity-model.mjs",
    mutate: (source) =>
      source.replace(
        /determinismFraction: 0\.0005,/,
        "determinismFraction: 0.001,",
      ),
    check: (source) => {
      assert.match(
        source,
        /determinismFraction: 0\.0005,/,
        "the determinism bar moved",
      );
    },
    because: /determinism bar moved/,
  },
  {
    name: "`sort-quiesced` is dropped from the structural precondition list",
    file: "Tools/visual-regression/lib/gsplat-parity-model.mjs",
    mutate: (source) => source.replace('  "sort-quiesced",\n', ""),
    check: (source) => {
      // Scoped to the DECLARED list. `"sort-quiesced"` also appears as the
      // `name:` of the check itself, so a bare `source.includes` survives the
      // very mutation this is meant to catch — the list can be emptied while
      // the implementation still reads as present.
      // `tsBlock` brace-matches `{}`; this declaration is an array literal, so
      // slice it explicitly rather than grabbing the next unrelated block.
      const at = source.indexOf("export const STRUCTURAL_PRECONDITIONS =");
      assert.notEqual(at, -1, "the precondition list declaration is gone");
      const list = source.slice(at, source.indexOf("]);", at));
      assert.ok(
        list.includes('"sort-quiesced"'),
        "the quiescence precondition is no longer declared structural",
      );
      assert.ok(
        list.indexOf('"sort-quiesced"') < list.indexOf('"capture-determinism"'),
        "quiescence must be checked BEFORE determinism — it is a precondition of it",
      );
    },
    because: /no longer declared structural/,
  },
];

for (const mutant of G4B_MUTANTS) {
  test(`G4b mutant rejected: ${mutant.name}`, async () => {
    const real = readNormalized(mutant.file);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    await assert.rejects(
      async () => await mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
    await mutant.check(real);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// C15-G5 — spherical harmonics degree 1-3 in WGSL.
//
// The row closes the recorded 2.574% cross-backend colour residual: WebGL
// evaluates SH bands 1-3 per splat and the WGSL evaluated none. Everything
// below is EXTRACTED FROM SOURCE and EXECUTED — the two shaders' basis
// functions are parsed out of their own text, compiled as JS and required to
// agree numerically, so a sign, a constant, a band offset or a polynomial that
// drifts in one language shows up as a number, not as a comment that stopped
// being true.
//
// The one thing this section pins hardest is the DC term. In 3DGS the degree-0
// band is folded into the base RGB before it ever reaches a shader
// (GltfSpzLoader.js:23-24), and both the writer's per-degree offsets and both
// shaders' evaluations start at band 1. Re-applying DC in the WGSL would
// roughly DOUBLE every splat and still look "plausible" in a screenshot, so it
// gets a dedicated mutant that must fail.
// ────────────────────────────────────────────────────────────────────────────

const CONTENT_PATH =
  "packages/engine/Source/Scene/GaussianSplat3DTileContent.js";

/** Strip `//` line comments without touching string content (there is none). */
function stripShaderComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

/** Slice the balanced `{ ... }` body that follows `signature`. */
function sliceBalancedBody(source, signature, label) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `${label}: "${signature}" is gone`);
  const open = source.indexOf("{", at);
  assert.ok(open > at, `${label}: no body brace after "${signature}"`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${label}: unbalanced body for "${signature}"`);
}

/** Slice `(` ... `)` starting at the first paren after `from`. */
function sliceBalancedParens(source, from, label) {
  const open = source.indexOf("(", from);
  assert.notEqual(open, -1, `${label}: no opening paren`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${label}: unbalanced parens`);
}

/**
 * Normalize a shader dialect down to the ONE grammar the term parser reads.
 * Deliberately minimal: the SH bodies are written so the only differences are
 * the constant PREFIX, the float literal suffix and the degree-uniform name.
 * Anything else that appears has to be translated explicitly rather than
 * silently mis-parsed — `assertShTermsParsed` below refuses a term it cannot
 * resolve to a known scalar symbol.
 */
function normalizeShDialect(source) {
  return stripShaderComments(source)
    .replaceAll("SPLAT_SH_C", "SH_C")
    .replaceAll("u_sphericalHarmonicsDegree", "degree")
    .replace(/(\d)f\b/g, "$1");
}

/** Split a product-of-factors sum at top level, carrying each term's sign. */
function splitTopLevelTerms(expression) {
  const terms = [];
  let depth = 0;
  let current = "";
  let sign = 1;
  let pendingSign = 1;
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) terms.push({ sign, text: trimmed });
    current = "";
    sign = pendingSign;
  };
  for (const ch of expression) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && (ch === "+" || ch === "-")) {
      pendingSign = ch === "-" ? -1 : 1;
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return terms;
}

const SH_SCALAR_SYMBOLS = [
  "x",
  "y",
  "z",
  "xx",
  "yy",
  "zz",
  "xy",
  "yz",
  "xz",
  "SH_C1",
  "SH_C2",
  "SH_C3",
];

function compileShScalar(text, label) {
  // Every identifier in a scalar factor must be one this harness supplies.
  // An unknown one means the shader grew a term the parser is silently
  // dropping, which is exactly how a "lockstep" check stops checking.
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    assert.ok(
      SH_SCALAR_SYMBOLS.includes(token),
      `${label}: SH scalar factor "${text}" uses unknown symbol "${token}"`,
    );
  }
  // eslint-disable-next-line no-new-func
  return new Function(...SH_SCALAR_SYMBOLS, `return (${text});`);
}

/**
 * Parse one shader's SH evaluator into (constants, band table, coefficient
 * index map, guard thresholds, per-band terms) and compile the terms as JS.
 */
function parseShEvaluator(source, dialect) {
  const label = dialect === "wgsl" ? RENDERER_PATH : GLSL_VS_PATH;
  const norm = normalizeShDialect(source);

  // ── constants ────────────────────────────────────────────────────────────
  const c1Match = norm.match(/SH_C1(?::\s*f32)?\s*=\s*(-?[0-9.]+)\s*;/);
  assert.ok(c1Match, `${label}: SH_C1 is gone`);
  const readConstArray = (name, count) => {
    const at = norm.indexOf(`${name}`);
    assert.notEqual(at, -1, `${label}: ${name} is gone`);
    const eq = norm.indexOf("=", at);
    assert.notEqual(eq, -1, `${label}: ${name} has no initializer`);
    const body = sliceBalancedParens(norm, eq, `${label}:${name}`);
    const values = body
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .map(Number);
    assert.equal(
      values.length,
      count,
      `${label}: ${name} must carry exactly ${count} coefficients`,
    );
    for (const value of values) {
      assert.ok(
        Number.isFinite(value),
        `${label}: ${name} has a non-numeric entry`,
      );
    }
    return values;
  };
  const constants = {
    SH_C1: Number(c1Match[1]),
    SH_C2: readConstArray("SH_C2", 5),
    SH_C3: readConstArray("SH_C3", 7),
  };

  // ── band-count table (GLSL's coefficientCount[3], WGSL's helper fn) ──────
  let bandCounts;
  if (dialect === "glsl") {
    const at = norm.indexOf("coefficientCount");
    assert.notEqual(at, -1, `${label}: the coefficientCount table is gone`);
    const body = sliceBalancedParens(
      norm,
      norm.indexOf("=", at),
      `${label}:counts`,
    );
    bandCounts = body
      .split(",")
      .map((token) => Number(token.trim().replace(/u$/, "")));
  } else {
    const body = sliceBalancedBody(norm, "fn splatShCoefficientCount(", label);
    const guarded = [
      ...body.matchAll(/if \(degree >= ([0-9.]+)\)\s*\{\s*return (\d+)u;/g),
    ];
    const fallthrough = body.match(/return (\d+)u;\s*$/m);
    assert.ok(fallthrough, `${label}: splatShCoefficientCount has no default`);
    bandCounts = [1, 2, 3].map((degree) => {
      const hit = guarded.find((m) => degree >= Number(m[1]));
      return hit ? Number(hit[2]) : Number(fallthrough[1]);
    });
  }
  assert.equal(
    bandCounts.length,
    3,
    `${label}: the band table must cover degrees 1-3`,
  );

  // ── evaluator body ───────────────────────────────────────────────────────
  const body = sliceBalancedBody(
    norm,
    dialect === "wgsl" ? "fn evaluateSplatSH(" : "vec3 evaluateSH(",
    label,
  );

  // Coefficient index map. GLSL walks a `coeffIndex++` counter; the WGSL names
  // the index literally. Both must land on the same shN -> global index map.
  const coefficientIndex = {};
  if (dialect === "glsl") {
    let running = 0;
    for (const m of body.matchAll(
      /vec3 (sh\d+) = loadAndExpandSHCoeff\(splatID, coeffIndex\+\+\);/g,
    )) {
      coefficientIndex[m[1]] = running++;
    }
  } else {
    for (const m of body.matchAll(
      /let (sh\d+) = loadSplatShCoefficient\(splatID, dims, (\d+)u\);/g,
    )) {
      coefficientIndex[m[1]] = Number(m[2]);
    }
  }
  assert.equal(
    Object.keys(coefficientIndex).length,
    15,
    `${label}: expected 15 SH coefficient loads (bands 1-3), found ${Object.keys(coefficientIndex).length}`,
  );

  // Degree guards, in source order.
  const guards = [...body.matchAll(/if \(degree >= ([0-9.]+)\)/g)].map((m) =>
    Number(m[1]),
  );

  // Accumulates, in source order — one per band.
  const accumulates = [...body.matchAll(/result \+= ([^;]+);/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );

  const bands = accumulates.map((expression, band) => ({
    minDegree: guards[band],
    terms: splitTopLevelTerms(expression).map((term) => {
      const shMatch = term.text.match(/\bsh(\d+)\b/);
      assert.ok(
        shMatch,
        `${label}: SH term "${term.text}" does not multiply a coefficient`,
      );
      const name = `sh${shMatch[1]}`;
      assert.ok(
        coefficientIndex[name] !== undefined,
        `${label}: SH term references unloaded coefficient ${name}`,
      );
      const scalarText = term.text
        .replace(/\*\s*\b(sh\d+)\b/, "")
        .replace(/\b(sh\d+)\b\s*\*/, "")
        .trim()
        .replace(/\*\s*$/, "")
        .trim();
      return {
        sign: term.sign,
        coefficient: coefficientIndex[name],
        scalar: compileShScalar(scalarText, label),
        scalarText,
      };
    }),
  }));

  return { constants, bandCounts, coefficientIndex, guards, bands, label };
}

/** Build the JS evaluator for a parsed shader. */
function makeShEvaluator(parsed) {
  return (degree, direction, coefficients) => {
    const [x, y, z] = direction;
    const scalarArgs = [
      x,
      y,
      z,
      x * x,
      y * y,
      z * z,
      x * y,
      y * z,
      x * z,
      parsed.constants.SH_C1,
      parsed.constants.SH_C2,
      parsed.constants.SH_C3,
    ];
    const result = [0, 0, 0];
    for (const band of parsed.bands) {
      if (degree < band.minDegree) break;
      for (const term of band.terms) {
        const weight = term.sign * term.scalar(...scalarArgs);
        const coefficient = coefficients[term.coefficient];
        result[0] += weight * coefficient[0];
        result[1] += weight * coefficient[1];
        result[2] += weight * coefficient[2];
      }
    }
    return result;
  };
}

/** Deterministic direction + coefficient fixtures (no Math.random). */
function shFixtures() {
  let seed = 0x5f3759df;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const directions = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ];
  for (let i = 0; i < 40; i++) {
    const v = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1];
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length < 1e-3) continue;
    directions.push([v[0] / length, v[1] / length, v[2] / length]);
  }
  const coefficients = [];
  for (let i = 0; i < 15; i++) {
    coefficients.push([next() * 2 - 1, next() * 2 - 1, next() * 2 - 1]);
  }
  return { directions, coefficients };
}

// ── The reader/writer layout, executed at the offset level ─────────────────

/** Extract a whole `function name(...) { ... }` from a JS source. */
function extractJsFunction(source, name, label) {
  const marker = `function ${name}(`;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${label}: function ${name} is gone`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${label}: unbalanced body for ${name}`);
}

/**
 * Compile the REAL SH writer out of `GaussianSplat3DTileContent.js`. This is
 * the producer half of the layout contract: whatever it emits is what both
 * backends read, so pinning the WGSL against a transcription would prove
 * nothing.
 */
function loadShWriter() {
  const source = readNormalized(CONTENT_PATH);
  const halfConsts = source.match(
    /const buffer = new ArrayBuffer\(4\);\nconst floatView = new Float32Array\(buffer\);\nconst intView = new Uint32Array\(buffer\);/,
  );
  assert.ok(
    halfConsts,
    `${CONTENT_PATH}: the f16 conversion scratch views moved — the extracted writer would not compile`,
  );
  const body = [
    halfConsts[0],
    extractJsFunction(source, "float32ToFloat16", CONTENT_PATH),
    extractJsFunction(source, "getShAttributePrefix", CONTENT_PATH),
    extractJsFunction(source, "extractSHDegreeAndCoef", CONTENT_PATH),
    extractJsFunction(source, "packSphericalHarmonicsData", CONTENT_PATH),
    "return { packSphericalHarmonicsData, float32ToFloat16 };",
  ].join("\n\n");
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const SH_BANDS_PER_DEGREE = [3, 5, 7];
const SH_TOTAL_BANDS = [3, 8, 15];
const SH_FLOATS_PER_SPLAT = [9, 24, 45];

/** A synthetic tile content shaped exactly like the real loader's output. */
function makeShTileContent(pointsLength, degree, valueAt) {
  const attributes = [];
  for (let l = 1; l <= degree; l++) {
    for (let n = 0; n < SH_BANDS_PER_DEGREE[l - 1]; n++) {
      const typedArray = new Float32Array(pointsLength * 3);
      for (let j = 0; j < pointsLength; j++) {
        typedArray[j * 3] = valueAt(j, l, n, 0);
        typedArray[j * 3 + 1] = valueAt(j, l, n, 1);
        typedArray[j * 3 + 2] = valueAt(j, l, n, 2);
      }
      attributes.push({
        name: `KHR_gaussian_splatting:SH_DEGREE_${l}_COEF_${n}`,
        typedArray,
      });
    }
  }
  return {
    pointsLength,
    sphericalHarmonicsDegree: degree,
    sphericalHarmonicsCoefficientCount: SH_FLOATS_PER_SPLAT[degree - 1],
    gltfPrimitive: { attributes },
  };
}

/** The WGSL reader's address arithmetic + channel decode, read from source. */
function parseShReader(wgsl) {
  const body = sliceBalancedBody(
    stripShaderComments(wgsl),
    "fn loadSplatShCoefficient(",
    RENDERER_PATH,
  );
  const baseMatch = body.match(
    /let base = splatID \* dims \* (\d+)u \+ index \* (\d+)u;/,
  );
  assert.ok(
    baseMatch,
    `${RENDERER_PATH}: loadSplatShCoefficient's address arithmetic is gone`,
  );
  const lowMatch = body.match(
    /let rg = unpack2x16float\(shCoefficients\[base\]\);/,
  );
  assert.ok(lowMatch, `${RENDERER_PATH}: the (r, g) word read moved`);
  const highMatch = body.match(
    /let b = unpack2x16float\(shCoefficients\[base \+ (\d+)u\]\);/,
  );
  assert.ok(highMatch, `${RENDERER_PATH}: the b word read moved`);
  const returnMatch = body.match(
    /return vec3<f32>\(rg\.([xy]), rg\.([xy]), b\.([xy])\);/,
  );
  assert.ok(returnMatch, `${RENDERER_PATH}: the SH channel assembly moved`);
  return {
    strideFactor: Number(baseMatch[1]),
    indexFactor: Number(baseMatch[2]),
    highWordOffset: Number(highMatch[1]),
    channels: [returnMatch[1], returnMatch[2], returnMatch[3]],
  };
}

/** Decode one coefficient the way the WGSL does, from the flat writer output. */
function readShCoefficient(packed, reader, splatID, dims, index) {
  const base =
    splatID * dims * reader.strideFactor + index * reader.indexFactor;
  const low = packed[base];
  const high = packed[base + reader.highWordOffset];
  const halves = {
    lowWord: [fromHalfBits(low & 0xffff), fromHalfBits((low >>> 16) & 0xffff)],
    highWord: [
      fromHalfBits(high & 0xffff),
      fromHalfBits((high >>> 16) & 0xffff),
    ],
  };
  const pick = (source, component) => halves[source][component === "x" ? 0 : 1];
  return [
    pick("lowWord", reader.channels[0]),
    pick("lowWord", reader.channels[1]),
    pick("highWord", reader.channels[2]),
  ];
}

// ── The reusable contract battery (so the mutants can re-run it verbatim) ───

function assertShContract(wgsl, glsl) {
  const w = parseShEvaluator(wgsl, "wgsl");
  const g = parseShEvaluator(glsl, "glsl");

  // 1. Constants, term for term.
  assert.equal(w.constants.SH_C1, g.constants.SH_C1, "SH_C1 diverged");
  assert.deepEqual(w.constants.SH_C2, g.constants.SH_C2, "SH_C2 diverged");
  assert.deepEqual(w.constants.SH_C3, g.constants.SH_C3, "SH_C3 diverged");

  // 2. Band-count table. 3 / 8 / 15 is the DC-EXCLUSIVE count; 4 / 9 / 16
  //    would be the DC-inclusive one, i.e. a layout that expects a degree-0
  //    coefficient the writer never emits.
  assert.deepEqual(w.bandCounts, g.bandCounts, "the band-count table diverged");
  assert.deepEqual(
    w.bandCounts,
    SH_TOTAL_BANDS,
    "SH bands per degree must be 3 / 8 / 15 (bands 1-3, NO degree-0 term)",
  );

  // 3. Coefficient index map.
  assert.deepEqual(
    w.coefficientIndex,
    g.coefficientIndex,
    "the shN -> coefficient index map diverged",
  );
  const indices = Object.values(w.coefficientIndex).sort((a, b) => a - b);
  assert.deepEqual(
    indices,
    Array.from({ length: 15 }, (_, i) => i),
    "the 15 SH coefficients must be indices 0..14 — index 0 is band 1, not a DC term",
  );

  // 4. Degree guards.
  assert.deepEqual(
    w.guards,
    [1, 2, 3],
    "the WGSL degree guards must be >= 1 / 2 / 3",
  );
  assert.deepEqual(
    g.guards,
    [1, 2, 3],
    "the GLSL degree guards must be >= 1 / 2 / 3",
  );

  // 5. THE HEADLINE — numeric agreement over a direction sweep, per degree.
  const evalW = makeShEvaluator(w);
  const evalG = makeShEvaluator(g);
  const { directions, coefficients } = shFixtures();
  for (const degree of [1, 2, 3]) {
    for (const direction of directions) {
      const a = evalW(degree, direction, coefficients);
      const b = evalG(degree, direction, coefficients);
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(a[c] - b[c]) <= 1e-6,
          `SH degree ${degree} channel ${c} disagrees at dir ${direction.map((v) => v.toFixed(4))}: WGSL ${a[c]} vs GLSL ${b[c]}`,
        );
      }
    }
    // ...and a degree must actually CHANGE the answer, or "agreement" could be
    // two evaluators that both return zero.
    const nonZero = directions.some((direction) =>
      evalW(degree, direction, coefficients).some((v) => Math.abs(v) > 1e-3),
    );
    assert.ok(
      nonZero,
      `SH degree ${degree} evaluates to zero everywhere — vacuous agreement`,
    );
  }
  // Higher degrees must add something, or a dropped band would agree trivially.
  for (const [lower, higher] of [
    [1, 2],
    [2, 3],
  ]) {
    const changed = directions.some((direction) => {
      const a = evalW(lower, direction, coefficients);
      const b = evalW(higher, direction, coefficients);
      return a.some((v, i) => Math.abs(v - b[i]) > 1e-3);
    });
    assert.ok(changed, `degree ${higher} does not differ from degree ${lower}`);
  }

  // 6. NO DC TERM anywhere in either evaluation path.
  const wgslSh = stripShaderComments(wgsl);
  for (const forbidden of [/SH_C0/, /0\.28209/, /\bsh0\b/]) {
    assert.doesNotMatch(
      wgslSh,
      forbidden,
      `${RENDERER_PATH}: a degree-0 (DC) SH term appeared. The DC band is ALREADY in the base RGBA8 (GltfSpzLoader.js:23-24); adding it here roughly doubles every splat`,
    );
  }

  // 7. Colour composition: SH is ADDED to rgb, alpha is untouched, and nothing
  //    else joins the sum. This is where a DC double-count actually gets
  //    written, so it is anchored exactly rather than loosely.
  const compact = (text) => text.replace(/\s+/g, "");
  // Anchored on the SH CALL and walked back to its constructor: `vertexMain`
  // also writes `output.color = vec4<f32>(0.0)` on the early-out path, and
  // scoring that one would make every composition rule vacuous.
  const shCall = wgslSh.indexOf("evaluateSplatSH(splatIdx");
  assert.notEqual(
    shCall,
    -1,
    `${RENDERER_PATH}: vertexMain no longer evaluates SH at all`,
  );
  const compositionAt = wgslSh.lastIndexOf("output.color = vec4<f32>(", shCall);
  assert.notEqual(
    compositionAt,
    -1,
    `${RENDERER_PATH}: the SH result is not composed into output.color`,
  );
  const compositionArgs = sliceBalancedParens(
    wgslSh,
    compositionAt,
    RENDERER_PATH,
  );
  const args = splitTopLevelArgs(compositionArgs);
  assert.equal(
    args.length,
    2,
    `${RENDERER_PATH}: the SH colour composition must be vec4(rgb, a)`,
  );
  assert.equal(
    compact(args[0]),
    "s.color.rgb+evaluateSplatSH(splatIdx,u.shDegree,shViewDir)",
    `${RENDERER_PATH}: the splat colour is no longer exactly "base + SH". Any extra term here is a double-count`,
  );
  assert.equal(
    compact(args[1]),
    "s.color.a",
    `${RENDERER_PATH}: SH must not touch alpha`,
  );
  assert.match(
    stripShaderComments(glsl).replace(/\s+/g, ""),
    /v_splatColor\.rgb\+=evaluateSH\(texIdx,viewDirModel\)\.rgb;/,
    `${GLSL_VS_PATH}: the reference composition moved — re-derive the WGSL anchor`,
  );

  // 8. View direction: the ROTATED residual, not the raw one.
  assert.match(
    wgslSh,
    /let shViewDir = normalize\(u\.shViewRotation \* posRTE\);/,
    `${RENDERER_PATH}: the SH view direction is no longer the model-frame residual rotated into the SH training frame — WebGL evaluates against normalize(u_inverseModelRotation * (splatWC - cameraWC)) and this is the only thing that reproduces it`,
  );

  // 9. Writer -> reader, at the offset level, EXECUTED.
  const reader = parseShReader(wgsl);
  const { packSphericalHarmonicsData } = loadShWriter();
  const value = (splat, l, n, channel) =>
    // Distinct per (splat, band, channel) and f16-exact, so a swapped word, a
    // swapped half or an off-by-one band is a wrong NUMBER, not a near miss.
    splat * 4 + l + n * 0.25 + channel * 0.0625;
  for (const degree of [1, 2, 3]) {
    const points = 5;
    const packed = packSphericalHarmonicsData(
      makeShTileContent(points, degree, value),
    );
    const dims = SH_TOTAL_BANDS[degree - 1];
    assert.equal(
      packed.length,
      points * dims * 2,
      `the writer's per-splat stride must be dims * 2 u32 (degree ${degree})`,
    );
    for (let splat = 0; splat < points; splat++) {
      let global = 0;
      for (let l = 1; l <= degree; l++) {
        for (let n = 0; n < SH_BANDS_PER_DEGREE[l - 1]; n++) {
          const got = readShCoefficient(packed, reader, splat, dims, global);
          for (let channel = 0; channel < 3; channel++) {
            assert.equal(
              got[channel],
              value(splat, l, n, channel),
              `degree ${degree} splat ${splat} coefficient ${global} (l=${l}, n=${n}) channel ${channel}: the WGSL reader does not land on the word the writer wrote`,
            );
          }
          global++;
        }
      }
      assert.equal(global, dims, "band walk did not cover the declared dims");
    }
  }
}

/** Split a comma-separated argument list at top level. */
function splitTopLevelArgs(text) {
  const args = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current);
  return args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

test("C15-G5: the WGSL and GLSL spherical-harmonics evaluators agree", () => {
  assertShContract(
    extractSplatWgsl(readNormalized(RENDERER_PATH)),
    readNormalized(GLSL_VS_PATH),
  );
});

test("C15-G5: the base colour ALREADY carries the DC band (the no-double-count premise)", () => {
  // Three independent in-tree statements of the same fact. If any one of them
  // stops being true the WGSL's "add bands 1-3 to the base" is wrong and this
  // spec must be re-derived rather than quietly kept green.
  const loader = readNormalized(
    "packages/engine/Source/Scene/GltfSpzLoader.js",
  );
  assert.match(
    loader,
    /Degree 0 has no extra SH data \(base color is stored separately in\n\/\/ the "colors" attribute\)/,
    "GltfSpzLoader no longer states that degree 0 lives in the colour attribute",
  );
  const content = readNormalized(CONTENT_PATH);
  assert.match(
    content,
    /const base = \[0, 9, 24\];/,
    `${CONTENT_PATH}: the per-degree float offsets must start at band 1 (l=1 -> 0). A DC-carrying layout would start at 3`,
  );
  assert.match(
    content,
    /case 15:\s*\n\s*return \{ l: 3, n: 45 \};/,
    `${CONTENT_PATH}: degree 3 must be 15 SH ATTRIBUTES and 45 floats = 15 bands x 3 channels (DC-exclusive; DC-inclusive would be 16 / 48)`,
  );
  // And the WebGL reference ADDS rather than replaces.
  assert.match(
    readNormalized(GLSL_VS_PATH),
    /v_splatColor\.rgb \+= evaluateSH\(texIdx, viewDirModel\)\.rgb;/,
    `${GLSL_VS_PATH}: the reference no longer ADDS SH to the base colour`,
  );
});

test("C15-G5: the WebGL SH texture is a pure regrouping of the same flat array", () => {
  // This is what makes "consume _shData verbatim" bit-exact rather than merely
  // equivalent: the row copy the WebGL path performs, and the texel address
  // the GLSL fetches, compose back to the FLAT index the WGSL computes.
  const primitive = readNormalized(PRIMITIVE_PATH);
  assert.match(
    primitive,
    /const splatsPerRow = Math\.floor\(width \/ dims\);/,
    `${PRIMITIVE_PATH}: the SH row width formula changed — re-derive the regrouping proof`,
  );
  assert.match(
    primitive,
    /const floatsPerRow = splatsPerRow \* \(dims \* 2\);/,
    `${PRIMITIVE_PATH}: the SH row length formula changed`,
  );
  assert.match(
    primitive,
    /for \(let i = 0; dataIndex < snapshot\.shData\.length; i \+= width \* 2\) \{/,
    `${PRIMITIVE_PATH}: the SH row copy stride changed`,
  );
  const glsl = readNormalized(GLSL_VS_PATH);
  assert.match(
    glsl,
    /uint splatsPerRow = uint\(shTexSize\.x\) \/ dims;/,
    `${GLSL_VS_PATH}: the SH row width the shader assumes changed`,
  );
  assert.match(
    glsl,
    /uint shIndex = \(splatID%splatsPerRow\) \* dims \+ uint\(index\);/,
    `${GLSL_VS_PATH}: the SH texel index changed`,
  );
  assert.match(
    glsl,
    /ivec2 shPosCoord = ivec2\(shIndex, splatID \/ splatsPerRow\);/,
    `${GLSL_VS_PATH}: the SH texel row changed`,
  );

  const reader = parseShReader(extractSplatWgsl(readNormalized(RENDERER_PATH)));
  for (const width of [2048, 4096, 8192, 16384]) {
    for (const dims of SH_TOTAL_BANDS) {
      const splatsPerRow = Math.floor(width / dims);
      const floatsPerRow = splatsPerRow * (dims * 2);
      for (const splatID of [
        0,
        1,
        splatsPerRow - 1,
        splatsPerRow,
        splatsPerRow * 3 + 7,
      ]) {
        for (const index of [0, 1, dims - 1]) {
          const row = Math.floor(splatID / splatsPerRow);
          const column = splatID % splatsPerRow;
          // Word offset in the TEXTURE, expanded from the row copy:
          //   texBuf row r starts at r*width*2 and holds shData[r*floatsPerRow ...]
          const textureWord =
            row * width * 2 +
            (column * dims + index) * 2 -
            row * width * 2 +
            row * floatsPerRow;
          const flatWord =
            splatID * dims * reader.strideFactor + index * reader.indexFactor;
          assert.equal(
            textureWord,
            flatWord,
            `width=${width} dims=${dims} splat=${splatID} index=${index}: the GLSL texel does not resolve to the WGSL flat word, so consuming _shData verbatim is NOT bit-exact`,
          );
        }
      }
    }
  }
});

/**
 * The SH budget must be decided ABOVE the backend branch, INSIDE
 * `processGeneratedSplatTextureData`. Both halves matter: the file has other
 * `_featureRenderer` checks, so a whole-file `indexOf` would compare against
 * an unrelated one and could never fail.
 */
function assertShBudgetAboveBranch(source) {
  const body = extractJsFunction(
    source,
    "processGeneratedSplatTextureData",
    PRIMITIVE_PATH,
  );
  const budgetCall = body.indexOf("applySphericalHarmonicsBudget(");
  const branch = body.indexOf("if (defined(primitive._featureRenderer))");
  assert.notEqual(
    budgetCall,
    -1,
    `${PRIMITIVE_PATH}: the SH budget call is gone from processGeneratedSplatTextureData`,
  );
  assert.notEqual(branch, -1, `${PRIMITIVE_PATH}: the backend branch is gone`);
  assert.ok(
    budgetCall < branch,
    `${PRIMITIVE_PATH}: the SH budget is decided BELOW the backend branch again — the native path would keep a degree WebGL just dropped`,
  );
}

test("C15-G5: the SH degree fallback is decided ONCE, for both backends", () => {
  // NEW-SPLAT-SH-DEGREE-BACKEND-DEPENDENT. Before this row the degrade-to-0
  // decision lived below the backend branch, so WebGL would drop to base colour
  // for a very large cloud while WebGPU (storage buffer, no height bound) kept
  // degree 3 — a silent divergence no gate would ever be run large enough to
  // observe.
  const source = readNormalized(PRIMITIVE_PATH);
  assertShBudgetAboveBranch(source);
  // The WebGL-only half must no longer carry a second copy of the decision.
  const body = extractJsFunction(
    source,
    "processGeneratedSplatTextureData",
    PRIMITIVE_PATH,
  );
  const webglHalf = body.slice(
    body.indexOf("if (defined(primitive._featureRenderer))"),
  );
  assert.doesNotMatch(
    webglHalf,
    /if \(shHeight > width\)/,
    `${PRIMITIVE_PATH}: the height decision was re-inlined into the WebGL half`,
  );

  const budget = loadShBudget();
  const observed = [];
  for (const maxTex of [2048, 4096, 8192, 16384]) {
    for (const degree of [1, 2, 3]) {
      const dims = SH_TOTAL_BANDS[degree - 1];
      const coefficients = SH_FLOATS_PER_SPLAT[degree - 1];
      const splatsPerRow = Math.floor(maxTex / dims);
      const limit = maxTex * splatsPerRow;
      const at = {
        shData: new Uint32Array(1),
        sphericalHarmonicsDegree: degree,
        shCoefficientCount: coefficients,
        numSplats: limit,
      };
      const layout = budget(at, maxTex);
      assert.ok(
        layout,
        `maxTex=${maxTex} degree=${degree}: SH must survive at exactly the limit`,
      );
      assert.equal(layout.height, maxTex);
      assert.equal(
        at.sphericalHarmonicsDegree,
        degree,
        "the degree must be untouched at the limit",
      );

      const over = {
        shData: new Uint32Array(1),
        sphericalHarmonicsDegree: degree,
        shCoefficientCount: coefficients,
        numSplats: limit + splatsPerRow,
      };
      assert.equal(
        budget(over, maxTex),
        undefined,
        `maxTex=${maxTex} degree=${degree}: SH must degrade past the limit`,
      );
      assert.equal(
        over.sphericalHarmonicsDegree,
        0,
        "the degrade must be published as degree 0 — the ONE signal both backends read",
      );
      if (degree === 3) observed.push(`maxTex=${maxTex}: ${limit}`);
    }
  }
  // Recorded, not asserted as a product requirement: the divergence condition
  // for the gate assets. `tower` is 286,868 splats — three orders of magnitude
  // under the smallest of these.
  assert.ok(
    observed.length === 4,
    `degree-3 divergence thresholds: ${observed.join(", ")}`,
  );
  // No SH -> no layout, and no spurious degrade.
  const none = { sphericalHarmonicsDegree: 0, numSplats: 10 };
  assert.equal(budget(none, 16384), undefined);
});

function loadShBudget() {
  const source = readNormalized(PRIMITIVE_PATH);
  const fn = extractJsFunction(
    source,
    "applySphericalHarmonicsBudget",
    PRIMITIVE_PATH,
  );
  // eslint-disable-next-line no-new-func
  return new Function(
    "defined",
    "console",
    `${fn}\nreturn applySphericalHarmonicsBudget;`,
  )((value) => value !== undefined && value !== null, { warn() {} });
}

test("C15-G5: the SH axis is a registered hi-word define on bit 3", () => {
  const defines = readNormalized(DEFINES_PATH);
  assert.match(
    defines,
    /SPLAT_SPHERICAL_HARMONICS: hiDefineBit\(3\),/,
    `${DEFINES_PATH}: SPLAT_SPHERICAL_HARMONICS must stay on hi bit 3 — the registry is ADD-ONLY`,
  );
  // The three bits claimed before it must not have moved.
  assert.match(defines, /HI_WORD_PROBE: hiDefineBit\(0\),/);
  assert.match(defines, /ENHANCED_OCEAN: hiDefineBit\(1\),/);
  assert.match(defines, /SPLAT_PACKED_WASM: hiDefineBit\(2\),/);

  const renderer = readNormalized(RENDERER_PATH);
  assert.match(
    extractSplatWgsl(renderer),
    /\/\/>>ifdef SPLAT_SPHERICAL_HARMONICS/,
    `${RENDERER_PATH}: nothing in SPLAT_WGSL gates on the SH define`,
  );
  // Single flip point, and it feeds the SAME definesHi every module fetch uses.
  assert.match(
    renderer,
    /activeShEnabled,\s*\n\s*\);/,
    `${RENDERER_PATH}: the SH axis no longer reaches buildSplatPipelineResources`,
  );
  assert.match(
    renderer,
    /const shFlipped =\s*\n?\s*cache\.initialized && cache\.resourcesShEnabled !== activeShEnabled;/,
    `${RENDERER_PATH}: an SH flip no longer invalidates the compiled pipelines — the shader would keep evaluating a retired palette`,
  );
  assert.match(
    renderer,
    /layoutFlipped \|\|\s*\n\s*shFlipped\)/,
    `${RENDERER_PATH}: shFlipped is computed but not consumed by the invalidation sweep`,
  );
});

test("C15-G5: the SH binding does NOT change the bind-group topology", () => {
  const renderer = readNormalized(RENDERER_PATH);
  const wgsl = extractSplatWgsl(renderer);
  // The declaration must sit OUTSIDE every //>>ifdef, so both variants resolve
  // to the same layout. Checked by resolving the shader with the SH flag CLEAR
  // and requiring the binding to still be there.
  const withoutSh = resolveDirectives(wgsl, new Set(["SPLAT_PACKED_WASM"]));
  assert.match(
    withoutSh,
    /@group\(0\) @binding\(4\) var<storage, read> shCoefficients: array<u32>;/,
    `${RENDERER_PATH}: the SH binding is inside an //>>ifdef — the two variants would need two different bind-group layouts, which is exactly what the C15-G3 discipline forbids`,
  );
  // BGL and every bind-group build site must carry it.
  assert.match(
    renderer,
    /storageBuffer\(4, Stage\.VERTEX, \{ readOnly: true \}\),/,
    `${RENDERER_PATH}: the BGL has no binding-4 entry`,
  );
  const bindSites = [
    ...renderer.matchAll(
      /binding: 4, resource: \{ buffer: cache\.shBuffer!? \}/g,
    ),
  ];
  assert.equal(
    bindSites.length,
    3,
    `${RENDERER_PATH}: expected all three bind-group build sites to bind the SH buffer; found ${bindSites.length}`,
  );
  // A placeholder must exist for non-SH content, or the bind group is invalid.
  assert.match(
    renderer,
    /label: "GaussianSplat SH coefficients \(placeholder\)",/,
    `${RENDERER_PATH}: non-SH content has no buffer to bind at slot 4`,
  );
  assert.match(
    renderer,
    /cache\.shBuffer\?\.destroy\(\);/,
    `${RENDERER_PATH}: the SH buffer leaks on destroy`,
  );
});

test("C15-G5: the SH uniform tail lands where the CPU writes it", () => {
  const renderer = readNormalized(RENDERER_PATH);
  const wgsl = stripShaderComments(extractSplatWgsl(renderer));
  const struct = sliceBalancedBody(wgsl, "struct Uniforms", RENDERER_PATH);
  const fields = [
    ...struct.matchAll(/(\w+):\s*([A-Za-z0-9_<>,\s]+?),\s*(?:\n|$)/g),
  ].map((m) => [m[1], m[2].replace(/\s+/g, "")]);
  const SIZES = {
    "mat4x4<f32>": [16, 64],
    "mat3x3<f32>": [16, 48],
    "vec4<f32>": [16, 16],
    "vec3<f32>": [16, 12],
    "vec2<f32>": [8, 8],
    f32: [4, 4],
    u32: [4, 4],
  };
  let offset = 0;
  let structAlign = 1;
  const offsets = {};
  for (const [name, type] of fields) {
    const spec = SIZES[type];
    assert.ok(
      spec,
      `${RENDERER_PATH}: unmodelled uniform field type "${type}"`,
    );
    const [align, size] = spec;
    structAlign = Math.max(structAlign, align);
    offset = Math.ceil(offset / align) * align;
    offsets[name] = offset;
    offset += size;
  }
  const structSize = Math.ceil(offset / structAlign) * structAlign;
  // Every pre-existing CPU write offset must fall out of the same calculator,
  // or the calculator is wrong and its verdict on the new tail is worthless.
  assert.equal(
    offsets.viewportSize,
    160,
    "the calculator disagrees with the known vpData offset",
  );
  assert.equal(
    offsets.pickColor,
    176,
    "the calculator disagrees with the known pickColor offset",
  );
  assert.equal(offsets.prevViewProjection, 192);
  assert.equal(offsets.modelMatrix, 256);
  // ...and then the new tail.
  assert.equal(
    offsets.shViewRotation,
    320,
    "shViewRotation must sit at byte 320",
  );
  assert.equal(offsets.shDegree, 368, "shDegree must sit at byte 368");
  assert.equal(structSize, 384, "the splat UBO must be 384 bytes");

  assert.match(
    renderer,
    /cache\.uniformBuffer = device\.createBuffer\(\{\s*\n\s*size: 384,/,
    `${RENDERER_PATH}: the splat UBO allocation does not match the WGSL struct size`,
  );
  assert.match(
    renderer,
    /device\.queue\.writeBuffer\(cache\.uniformBuffer!, 320, shRotationData\);/,
    `${RENDERER_PATH}: the SH tail is not written at byte 320`,
  );
  // float 12 of the 16-float tail block = byte 320 + 48 = 368.
  assert.match(
    renderer,
    /shRotationData\[12\] = cache\.shEnabled \? cache\.shDegree : 0\.0;/,
    `${RENDERER_PATH}: shDegree is not written at float 12 of the tail block (byte 368), or a stale degree can survive a flip`,
  );
  // mat3x3 columns are 16-byte strided; the pack must skip the pad lane.
  assert.match(
    renderer,
    /shRotationData\[column \* 4 \+ 3\] = 0\.0;/,
    `${RENDERER_PATH}: the mat3x3 column pad lane is not written — columns would mis-stride`,
  );
});

/** The CPU-side view-direction fold, as a re-runnable predicate. */
function assertShViewDirectionFold(renderer) {
  assert.match(
    renderer,
    /Matrix4\.getMatrix3\(mm, scratchModelRotation\);\s*\n\s*Matrix3\.multiply\(\s*\n?\s*shInverseRotation,\s*\n?\s*scratchModelRotation,\s*\n?\s*scratchShRotation,?\s*\n?\s*\);/,
    `${RENDERER_PATH}: the SH rotation is not inverse(SH frame) * mat3(modelMatrix), in that order. Reversing the operands rotates the view direction into the wrong space and the SH lobes point somewhere else entirely`,
  );
  assert.match(
    renderer,
    /\)\._shInverseRotation;/,
    `${RENDERER_PATH}: the SH frame no longer comes from the primitive's _shInverseRotation — the same matrix the WebGL uniform reads`,
  );
}

test("C15-G5: the view direction is built in WebGL's space", () => {
  const renderer = readNormalized(RENDERER_PATH);
  assertShViewDirectionFold(renderer);
  // The primitive must still be the producer of that matrix, and must still
  // build it from the SAME chain the WebGL uniform documents.
  assert.match(
    readNormalized(PRIMITIVE_PATH),
    /Matrix4\.getRotation\(\s*\n?\s*Matrix4\.inverse\(shFwd, shFwd\),\s*\n?\s*this\._shInverseRotation,\s*\n?\s*\);/,
    `${PRIMITIVE_PATH}: _shInverseRotation is no longer the inverse of computedTransform x axisCorrection x worldTransform`,
  );

  // EXECUTED: the algebraic identity the WGSL port rests on —
  //   mat3(M) * (p - M^-1 c)  ==  M*p - c
  // for ANY invertible M, which is why the RTE residual can stand in for a
  // world-space camera->splat vector without ever materializing one.
  const multiply4 = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
  const linear = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
  const solve = (m, target) => {
    // Solve mat3(m) * u = target - translation, by Cramer's rule.
    const b = [target[0] - m[12], target[1] - m[13], target[2] - m[14]];
    const a = [
      [m[0], m[4], m[8]],
      [m[1], m[5], m[9]],
      [m[2], m[6], m[10]],
    ];
    const det = (n) =>
      n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) -
      n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0]) +
      n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]);
    const base = det(a);
    return [0, 1, 2].map((column) => {
      const copy = a.map((row) => row.slice());
      for (let r = 0; r < 3; r++) copy[r][column] = b[r];
      return det(copy) / base;
    });
  };
  // A rigid ENU-like frame at planetary scale, and a deliberately non-rigid
  // one (scale + shear) so the identity is proven generally, not for the easy
  // case the gate assets happen to use.
  const matrices = [
    [0, 1, 0, 0, -0.5, 0, 0.866, 0, 0.866, 0, 0.5, 0, 4.2e6, 1.1e6, 4.6e6, 1],
    [
      1.5, 0.2, 0, 0, -0.3, 2.1, 0.4, 0, 0.05, 0.1, 0.7, 0, -3.1e6, 5.2e6,
      2.4e6, 1,
    ],
  ];
  for (const m of matrices) {
    const cameraWorld = [4.20001e6, 1.10002e6, 4.60003e6];
    const cameraModel = solve(m, cameraWorld);
    for (const p of [
      [0, 0, 0],
      [12.5, -3.25, 7],
      [-400, 250, 900],
    ]) {
      const posRTE = [
        p[0] - cameraModel[0],
        p[1] - cameraModel[1],
        p[2] - cameraModel[2],
      ];
      const viaResidual = linear(m, posRTE);
      const world = multiply4(m, p);
      const viaWorld = [
        world[0] - cameraWorld[0],
        world[1] - cameraWorld[1],
        world[2] - cameraWorld[2],
      ];
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(viaResidual[c] - viaWorld[c]) <=
            1e-6 * Math.max(1, Math.abs(viaWorld[c])),
          `mat3(M) * posRTE must equal splatWC - cameraWC (component ${c}): ${viaResidual[c]} vs ${viaWorld[c]}`,
        );
      }
    }
  }
});

test("C15-G5: the SH commit cannot serve stale coefficients", () => {
  const renderer = readNormalized(RENDERER_PATH);
  // Producer identity is the dirty signal, not the count: `_shData` is a fresh
  // subarray over a REUSED scratch buffer on every snapshot rebuild, so a
  // rebuild landing on the same count and degree still changes the bytes.
  assert.match(
    renderer,
    /cache\.shSourceToken !== shSource\.token \|\|/,
    `${RENDERER_PATH}: the SH commit no longer keys on producer identity — a same-count rebuild would keep the old palette resident forever`,
  );
  assert.match(
    renderer,
    /cache\.shBuffer\.size !== \(shSource\.view\.byteLength \|\| 16\)/,
    `${RENDERER_PATH}: the SH commit no longer checks the resident buffer size`,
  );
  // A short payload must disable SH loudly rather than read out of bounds.
  assert.match(
    renderer,
    /GaussianSplat SH payload is short:/,
    `${RENDERER_PATH}: the short-SH-payload sentinel is gone`,
  );
  assert.match(
    renderer,
    /if \(shData\.length < words\) \{/,
    `${RENDERER_PATH}: the SH payload length is no longer validated against count x bands x 2`,
  );
  // Withdrawal must retire the term, not leave it evaluating a dead palette.
  assert.match(
    renderer,
    /cache\.shSourceToken = null;\s*\n\s*cache\.shDegree = 0;\s*\n\s*cache\.shEnabled = false;/,
    `${RENDERER_PATH}: SH state is not retired when the cloud is withdrawn`,
  );
  // The commit must sit above the pipeline gate, for the Batch-881 reason.
  const shCommit = renderer.indexOf(
    "// ── C15-G5 — commit the SH coefficients.",
  );
  const gate = renderer.indexOf("    !tryResolveSplatPipelines(");
  assert.notEqual(
    shCommit,
    -1,
    `${RENDERER_PATH}: the SH commit block is gone`,
  );
  assert.ok(
    shCommit < gate,
    `${RENDERER_PATH}: the SH upload sits BELOW the pipeline gate — it would not start until a cold variant finished compiling`,
  );
});

test("C15-G5: the probe can distinguish an unimplemented port from an unexecuted one", () => {
  // The row's silent failure mode: if the SH variant never compiles, the
  // colour residual stays exactly where it was and the run reads as "the port
  // did not help" rather than "the port did not run". These observables are
  // what separate the two, so they are sampled with the rest of the
  // renderer-owned stats (i.e. at the SCORED frame) and printed.
  for (const field of [
    "record.cacheShEnabled = p?._webgpuCache?.shEnabled",
    "record.cacheShDegree = p?._webgpuCache?.shDegree",
    "record.primitiveShDegree = p?._sphericalHarmonicsDegree",
    "record.primitiveShWords = p?._shData?.length",
  ]) {
    assert.ok(
      PROBE.includes(field),
      `${PROBE_PATH}: the SH observable "${field}" is not sampled`,
    );
  }
  const samplerStart = PROBE.indexOf("const sampleRendererStats = () => {");
  assert.notEqual(samplerStart, -1, `${PROBE_PATH}: the sampler is gone`);
  const samplerBody = PROBE.slice(
    samplerStart,
    PROBE.indexOf("\n  };", samplerStart),
  );
  for (const field of ["record.cacheShEnabled", "record.cacheShDegree"]) {
    assert.ok(
      samplerBody.includes(field),
      `${PROBE_PATH}: "${field}" must live INSIDE sampleRendererStats, or it describes a different frame than the pixels`,
    );
  }
  assert.match(
    PROBE,
    /sh: enabled=\$\{webgpu\?\.cacheShEnabled/,
    `${PROBE_PATH}: the SH observables are collected but never printed`,
  );
});

// ── Mutants ────────────────────────────────────────────────────────────────
// Each is applied to an in-memory COPY of the real shader; `assertShContract`
// must reject it, and must still ACCEPT the real source (so a rule that has
// started throwing unconditionally cannot masquerade as a working gate).

const SH_WGSL_MUTANTS = [
  {
    name: "SH_C1 sign flipped on the y band",
    mutate: (wgsl) =>
      wgsl.replace(
        "result += -SPLAT_SH_C1 * y * sh1 +",
        "result += SPLAT_SH_C1 * y * sh1 +",
      ),
  },
  {
    name: "degree-2 basis pair swapped (yz <-> xz)",
    mutate: (wgsl) =>
      wgsl
        .replace("SPLAT_SH_C2[1] * yz * sh5", "SPLAT_SH_C2[1] * xz * sh5")
        .replace("SPLAT_SH_C2[3] * xz * sh7", "SPLAT_SH_C2[3] * yz * sh7"),
  },
  {
    // SH_C3[0] and SH_C3[6] are the SAME value (-0.59004358), as are [2] and
    // [4]; swapping those is numerically a no-op and would make a vacuous
    // mutant. This pair is genuinely distinct (2.890611442 vs 1.445305721).
    name: "degree-3 constant index swapped",
    mutate: (wgsl) =>
      wgsl.replace(
        "SPLAT_SH_C3[1] * xy * z * sh10",
        "SPLAT_SH_C3[5] * xy * z * sh10",
      ),
  },
  {
    name: "degree-3 polynomial 4*zz weakened to 3*zz",
    mutate: (wgsl) =>
      wgsl.replace(
        "SPLAT_SH_C3[2] * y * (4.0 * zz - xx - yy) * sh11",
        "SPLAT_SH_C3[2] * y * (3.0 * zz - xx - yy) * sh11",
      ),
  },
  {
    name: "degree-2 coefficient index off by one",
    mutate: (wgsl) =>
      wgsl.replace(
        "let sh4 = loadSplatShCoefficient(splatID, dims, 3u);",
        "let sh4 = loadSplatShCoefficient(splatID, dims, 4u);",
      ),
  },
  {
    name: "coefficient stride widened to 3 words",
    mutate: (wgsl) =>
      wgsl.replace(
        "let base = splatID * dims * 2u + index * 2u;",
        "let base = splatID * dims * 3u + index * 2u;",
      ),
  },
  {
    name: "b channel read from the high half of its word",
    mutate: (wgsl) =>
      wgsl.replace(
        "return vec3<f32>(rg.x, rg.y, b.x);",
        "return vec3<f32>(rg.x, rg.y, b.y);",
      ),
  },
  {
    name: "band table made DC-inclusive (16 / 9 / 4)",
    mutate: (wgsl) =>
      wgsl
        .replace(
          "if (degree >= 3.0) { return 15u; }",
          "if (degree >= 3.0) { return 16u; }",
        )
        .replace(
          "if (degree >= 2.0) { return 8u; }",
          "if (degree >= 2.0) { return 9u; }",
        )
        .replace("  return 3u;\n}", "  return 4u;\n}"),
  },
  {
    name: "degree guard shifted (band 2 evaluated at degree 1)",
    mutate: (wgsl) =>
      wgsl.replace("    if (degree >= 2.0) {", "    if (degree >= 1.0) {"),
  },
  {
    name: "view direction left in the model frame (rotation dropped)",
    mutate: (wgsl) =>
      wgsl.replace(
        "let shViewDir = normalize(u.shViewRotation * posRTE);",
        "let shViewDir = normalize(posRTE);",
      ),
  },
  {
    name: "DC band double-counted at the colour composition",
    mutate: (wgsl) =>
      wgsl.replace(
        "    s.color.rgb + evaluateSplatSH(splatIdx, u.shDegree, shViewDir),",
        "    s.color.rgb + 0.2820947917738781 * s.color.rgb + evaluateSplatSH(splatIdx, u.shDegree, shViewDir),",
      ),
  },
  {
    name: "SH added to alpha as well as rgb",
    mutate: (wgsl) =>
      wgsl.replace(
        "    s.color.a,\n  );",
        "    s.color.a + evaluateSplatSH(splatIdx, u.shDegree, shViewDir).r,\n  );",
      ),
  },
];

for (const mutant of SH_WGSL_MUTANTS) {
  test(`C15-G5 mutant rejected: ${mutant.name}`, () => {
    const real = extractSplatWgsl(readNormalized(RENDERER_PATH));
    const glsl = readNormalized(GLSL_VS_PATH);
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      "the mutation did not apply — the anchor text moved and this mutant now proves nothing",
    );
    assert.throws(
      () => assertShContract(mutated, glsl),
      undefined,
      `${mutant.name}: the SH contract battery accepted the mutated shader`,
    );
    // ...and the battery must still pass on the real source.
    assertShContract(real, glsl);
  });
}

const SH_SOURCE_MUTANTS = [
  {
    name: "the SH rotation fold is applied in the wrong order",
    file: RENDERER_PATH,
    mutate: (source) =>
      source.replace(
        "    Matrix3.multiply(\n      shInverseRotation,\n      scratchModelRotation,\n      scratchShRotation,\n    );",
        "    Matrix3.multiply(\n      scratchModelRotation,\n      shInverseRotation,\n      scratchShRotation,\n    );",
      ),
    check: (source) => assertShViewDirectionFold(source),
    because: /inverse\(SH frame\) \* mat3\(modelMatrix\)/,
  },
  {
    name: "the SH budget is moved back below the backend branch",
    file: PRIMITIVE_PATH,
    mutate: (source) => {
      const call =
        "    const shLayout = applySphericalHarmonicsBudget(\n      snapshot,\n      maximumTextureSize,\n    );\n";
      assert.ok(source.includes(call), "the budget call anchor moved");
      const moved = source.replace(call, "");
      return moved.replace(
        "    if (defined(snapshot.shData) && snapshot.sphericalHarmonicsDegree > 0) {",
        `${call}    if (defined(snapshot.shData) && snapshot.sphericalHarmonicsDegree > 0) {`,
      );
    },
    check: (source) => assertShBudgetAboveBranch(source),
    because: /BELOW the backend branch/,
  },
];

for (const mutant of SH_SOURCE_MUTANTS) {
  test(`C15-G5 source mutant rejected: ${mutant.name}`, () => {
    const real = readNormalized(mutant.file);
    const mutated = mutant.mutate(real);
    assert.notEqual(mutated, real, "the mutation did not apply");
    assert.throws(
      () => mutant.check(mutated),
      mutant.because,
      `${mutant.name}: accepted, or rejected for the wrong reason`,
    );
    mutant.check(real);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CO-12 (2026-08-07)
//
// Three deliverables land their pins here:
//
//   * `NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY` — the WebGL-shaped liveness
//     term in the shared frame-skip short-circuit;
//   * `NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT` — stale numeric `Pass`
//     literals in the collection feature renderers;
//   * the probe's three added lanes (three azimuths + two vacuity controls),
//     which are what `C15-G8` needs before it can gate honestly.
//
// Same doctrine as everything above: every predicate is executed rather than
// grepped where execution is possible, and every rule is run against the
// plausible wrong implementation as well as the real one.
// ════════════════════════════════════════════════════════════════════════════

// ── NEW-SPLAT-PENDING-WORK-DRAWCOMMAND-PROXY ────────────────────────────────

/** Compile the extracted `hasDrawableResult` with its one real dependency. */
function loadDrawableResultPredicate(source) {
  const payloadText = extractFunction(source, "hasSnapshotRenderPayload");
  const drawableText = extractFunction(source, "hasDrawableResult");
  // eslint-disable-next-line no-new-func
  return new Function(
    "defined",
    `${payloadText}\n${drawableText}\nreturn hasDrawableResult;`,
  )(definedShim);
}

const DRAW_COMMAND = { id: "a DrawCommand" };

/**
 * The truth table, and the reason it has six rows rather than two.
 *
 * The WEBGPU rows are the defect: `_drawCommand` is built only by
 * `buildGSplatDrawCommand`, which `C15-G2` gated off on native backends, so the
 * old term read "no drawable result" forever and the settled-scene early return
 * was structurally unreachable. The WEBGL rows are the invariant the fix must
 * not weaken — "just delete the term" satisfies the WebGPU rows and breaks
 * these, and "always return true" satisfies neither set honestly.
 */
const DRAWABLE_TRUTH_TABLE = [
  {
    label: "WebGL, a DrawCommand exists -> drawable",
    primitive: { _drawCommand: DRAW_COMMAND, _snapshot: undefined },
    expected: true,
  },
  {
    label: "WebGL, no DrawCommand yet -> not drawable (there IS work to do)",
    primitive: { _drawCommand: undefined, _snapshot: { data: 1 } },
    expected: false,
  },
  {
    label:
      "WebGPU, snapshot committed with the packed payload -> drawable (the fix)",
    primitive: {
      _featureRenderer: {},
      _drawCommand: undefined,
      _snapshot: { packedSplatTextureData: PAYLOAD },
    },
    expected: true,
  },
  {
    label: "WebGPU, snapshot committed with NO payload -> not drawable",
    primitive: {
      _featureRenderer: {},
      _drawCommand: undefined,
      _snapshot: { packedSplatTextureData: undefined },
    },
    expected: false,
  },
  {
    label: "WebGPU, nothing committed at all -> not drawable",
    primitive: { _featureRenderer: {}, _drawCommand: undefined },
    expected: false,
  },
  {
    label:
      "WebGPU must NOT be satisfied by a WebGL DrawCommand it could never own",
    primitive: {
      _featureRenderer: {},
      _drawCommand: DRAW_COMMAND,
      _snapshot: { packedSplatTextureData: undefined },
    },
    expected: false,
  },
];

function assertDrawableTruthTable(source) {
  const predicate = loadDrawableResultPredicate(source);
  for (const row of DRAWABLE_TRUTH_TABLE) {
    assert.equal(
      predicate(row.primitive),
      row.expected,
      `hasDrawableResult: ${row.label}`,
    );
  }
  // Both call sites must route through it. The `isBootstrap` site is not
  // cosmetic: leaving the raw `_drawCommand` term there would keep a
  // WebGL-shaped question inside a decision that runs on both backends.
  assert.match(
    source,
    /const isBootstrap =\n\s*!defined\(this\._snapshot\) &&\n\s*!defined\(this\._pendingSnapshot\) &&\n\s*!hasDrawableResult\(this\);/,
    `${PRIMITIVE_PATH}: the bootstrap test still asks a WebGL-only question`,
  );
  assert.match(
    source,
    /defined\(this\._pendingSortPromise\) \|\|\n(?:\s*\/\/[^\n]*\n)*\s*!hasDrawableResult\(this\);/,
    `${PRIMITIVE_PATH}: hasPendingWork still reads _drawCommand directly — the early return is unreachable on a native backend`,
  );
}

test("CO-12: the frame-skip liveness proxy is backend-neutral (executed, not grepped)", () => {
  assertDrawableTruthTable(readNormalized(PRIMITIVE_PATH));
});

const DRAWABLE_MUTANTS = [
  {
    name: "the term reverts to the WebGL-shaped proxy",
    mutate: (source) =>
      source.replace(
        "function hasDrawableResult(primitive) {\n  if (defined(primitive._featureRenderer)) {",
        "function hasDrawableResult(primitive) {\n  if (false) {",
      ),
  },
  {
    name: "the native arm ignores the payload and trusts the snapshot alone",
    mutate: (source) =>
      source.replace(
        "    return (\n      defined(primitive._snapshot) &&\n      hasSnapshotRenderPayload(primitive, primitive._snapshot)\n    );",
        "    return defined(primitive._snapshot);",
      ),
  },
  {
    name: "the WebGL arm is widened to the snapshot too",
    mutate: (source) =>
      source.replace(
        "  return defined(primitive._drawCommand);\n}",
        "  return defined(primitive._drawCommand) || defined(primitive._snapshot);\n}",
      ),
  },
  {
    name: "the bootstrap call site is reverted",
    mutate: (source) =>
      source.replace(
        "        !defined(this._pendingSnapshot) &&\n        !hasDrawableResult(this);",
        "        !defined(this._pendingSnapshot) &&\n        !defined(this._drawCommand);",
      ),
  },
];

test("CO-12: the liveness-proxy battery rejects every plausible wrong fix", () => {
  const real = readNormalized(PRIMITIVE_PATH);
  assertDrawableTruthTable(real);
  for (const mutant of DRAWABLE_MUTANTS) {
    const mutated = mutant.mutate(real);
    assert.notEqual(
      mutated,
      real,
      `mutant "${mutant.name}" changed nothing — its target text moved`,
    );
    assert.throws(
      () => assertDrawableTruthTable(mutated),
      `mutant "${mutant.name}" survived the battery`,
    );
  }
});

// ── NEW-WEBGPU-COLLECTION-PASS-LITERAL-DRIFT ────────────────────────────────
//
// `packages/engine/Source/Renderer/Pass.js` is this fork's authority and it has
// been INSERTED INTO TWICE (`CESIUM_3D_TILE_EDGES: 4`,
// `CESIUM_3D_TILE_PLANAR_FILL_ID: 5`). Numeric pass literals written against an
// earlier state of that enum keep compiling, keep their now-false
// `/* Pass.X */` comments, and silently name a different slot. The class is
// only detectable by comparing the literal against the enum, which is what this
// block does.

const PASS_PATH = "packages/engine/Source/Renderer/Pass.js";
const WEBGPU_RENDERER_DIR = "packages/engine/Source/Renderer/WebGPU";

/** Parse `Pass.js` into a name -> value map by executing its object literal. */
function loadPassEnum() {
  const source = readNormalized(PASS_PATH);
  const open = source.indexOf("const Pass = {");
  assert.notEqual(open, -1, `${PASS_PATH}: the Pass object literal moved`);
  const close = source.indexOf("\n};", open);
  assert.ok(
    close > open,
    `${PASS_PATH}: the Pass object literal is unbalanced`,
  );
  const body = source.slice(open + "const Pass = ".length, close + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${body}`)();
}

const PASS = loadPassEnum();

/** Every `.js`/`.ts` file under the WebGPU renderer directory. */
function webgpuRendererSources() {
  const dir = resolve(ROOT, WEBGPU_RENDERER_DIR);
  return readdirSync(dir)
    .filter((name) => /\.(js|ts)$/.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => ({
      name: name,
      relative: `${WEBGPU_RENDERER_DIR}/${name}`,
      // Comment lines are stripped so an assertion about CODE cannot be
      // satisfied — or violated — by prose describing the bug.
      code: readNormalized(`${WEBGPU_RENDERER_DIR}/${name}`)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .filter((line) => !line.trimStart().startsWith("*"))
        .join("\n"),
    }));
}

test("CO-12: the fork's Pass enum is the one these literals drifted against", () => {
  // If this ever changes, every recorded "actually is" below changes with it,
  // and the drift table must be re-derived rather than re-blessed.
  assert.equal(PASS.CESIUM_3D_TILE, 6);
  assert.equal(PASS.CESIUM_3D_TILE_CLASSIFICATION, 7);
  assert.equal(PASS.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW, 8);
  assert.equal(PASS.OPAQUE, 9);
  assert.equal(PASS.TRANSLUCENT, 10);
  assert.equal(PASS.GAUSSIAN_SPLATS, 12);
});

test("CO-12: no numeric pass literal survives under Source/Renderer/WebGPU", () => {
  const offenders = [];
  for (const file of webgpuRendererSources()) {
    for (const [index, line] of file.code.split("\n").entries()) {
      // `pass: <number>` in a command construction, and the
      // `<number> /* Pass.X */` comparison shape the class was found in.
      if (/\bpass:\s*[0-9]/.test(line) || /[0-9]+\s*\/\*\s*Pass\./.test(line)) {
        offenders.push(`${file.relative}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `numeric pass literals are back — CLAUDE.md's enumerated-keys rule forbids them, and this fork's Pass enum has already been inserted into twice:\n${offenders.join("\n")}`,
  );
});

test("CO-12: the collection feature renderers select their pass from the enum", () => {
  const expected = {
    "WebGPUPointPrimitiveRenderer.js": "pointPass",
    "WebGPUBillboardRenderer.js": "billboardPass",
    "WebGPULabelRenderer.js": "labelPass",
    "WebGPUPolylineRenderer.js": "polylinePass",
  };
  for (const [file, variable] of Object.entries(expected)) {
    const code = readNormalized(`${WEBGPU_RENDERER_DIR}/${file}`);
    // Batch 917 (NEW-WEBGPU-COLLECTION-PASS-DEFAULT-REGRESSION) — this
    // assertion USED to pin the SHAPE `? Pass.OPAQUE : Pass.TRANSLUCENT`,
    // i.e. the branch ORDER. That is precisely what let the default-row
    // inversion ship green: a shape assertion cannot tell a correct mapping
    // from its inverse, so it certified the very swap it was written to
    // prevent. It now pins only that the bin comes from the enum at all; the
    // ROUTING TRUTH TABLE (which blend option lands in which bin, scored
    // against mutants that reintroduce the Batch-889 and Batch-914 forms)
    // lives in Tools/visual-regression/collection-pass-routing.spec.mjs.
    // The bin is now a CONSTANT `Pass.OPAQUE` — WebGL routes the collapsed
    // single command there under every blend option (the
    // `!opaqueAndTranslucent` clause in PointPrimitiveCollection.js:827 /
    // BillboardCollection.js:1204 sends BlendOption.TRANSLUCENT there too),
    // so requiring both arms here would re-pin the defect.
    const declaration = code.match(new RegExp(`const ${variable} =([^;]*);`));
    assert.ok(declaration, `${file}: the ${variable} declaration moved`);
    assert.match(
      declaration[1],
      /Pass\.[A-Z_]+/,
      `${file}: ${variable} is no longer chosen from the Pass enum`,
    );
    assert.match(
      code,
      /import Pass from "\.\.\/Pass\.js";/,
      `${file}: the Pass import is gone`,
    );
  }
});

test("CO-12: collection PICK commands land in a pass the WebGPU pick loop executes", () => {
  // The consequence the DEFERRED entry did not name. `pass: 8` is
  // `CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW` on this fork, and the WebGPU
  // pick pass never executes that slot — so the collection pick commands, each
  // of which is a dedicated `pickOnly` draw and therefore the ONLY carrier of
  // its collection's pick IDs, were binned where nothing dispatches them.
  const pickPass = readNormalized(
    "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererPickPass.ts",
  );
  const executed = new Set(
    [...pickPass.matchAll(/execute\(Pass\.([A-Z0-9_]+)\)/g)].map((m) => m[1]),
  );
  assert.ok(
    executed.has("OPAQUE"),
    "the pick loop no longer executes Pass.OPAQUE — the collection pick commands need a new home",
  );
  assert.equal(
    executed.has("CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW"),
    false,
    "the pick loop now executes the IGNORE_SHOW slot; the premise of this fix changed and the row must be re-read",
  );
  for (const file of [
    "WebGPUPointPrimitiveRenderer.js",
    "WebGPUBillboardRenderer.js",
    "WebGPUPolylineRenderer.js",
  ]) {
    const code = readNormalized(`${WEBGPU_RENDERER_DIR}/${file}`);
    assert.match(
      code,
      /pass: Pass\.OPAQUE,\n\s*owner: collection,/,
      `${file}: the pick command's pass is not Pass.OPAQUE — its own comment says pick always runs in the OPAQUE pass`,
    );
  }
});

/**
 * NEW-WEBGPU-CLASSIFIER-PASS-SLOT-DRIFT — the SECOND half of the class, filed
 * rather than fixed, and pinned by VALUE so it cannot move unnoticed.
 *
 * The `DEFERRED_WORK` entry called these sites "comment-only" drift on the
 * strength of a doc comment in `WebGPUSceneRenderer3DTilePasses.ts` that says
 * "each pushes a `pass = 7` stencil-write command". The CODE a few lines away
 * calls `runPass(Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW)` — 8 — and
 * reads `frustumCommands.indices[...IGNORE_SHOW]` to decide whether the invert
 * pass has stencil data at all. So the comment is the stale artifact, not the
 * label: these are the SAME off-by-one, and the four classifier renderers are
 * pushing one slot low.
 *
 * They are NOT corrected here. Moving them changes 3D-Tile classification and
 * invert-classification dispatch across four renderers, and this lane has no
 * browser to verify that with. What CO-12 did do is replace each literal with
 * the enum member it ACTUALLY equals — value-identical, drift now readable —
 * and pin that state below, so the row gets closed deliberately instead of
 * drifting a third time.
 */
const CLASSIFIER_DRIFT_SITES = [
  {
    file: "WebGPUGroundPrimitiveRenderer.js",
    text: "groundPasses.push(Pass.CESIUM_3D_TILE);",
    intended: "CESIUM_3D_TILE_CLASSIFICATION",
  },
  {
    file: "WebGPUGroundPrimitiveRenderer.js",
    text: "pass: Pass.CESIUM_3D_TILE_CLASSIFICATION,",
    intended: "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
  },
  {
    file: "WebGPUGroundPolylineRenderer.js",
    text: "groundPasses.push(Pass.CESIUM_3D_TILE);",
    intended: "CESIUM_3D_TILE_CLASSIFICATION",
  },
  {
    file: "WebGPUGroundPolylineRenderer.js",
    text: "pass: Pass.CESIUM_3D_TILE_CLASSIFICATION,",
    intended: "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
  },
  {
    file: "WebGPUVector3DTilePrimitiveRenderer.js",
    text: "groundPasses.push(Pass.CESIUM_3D_TILE);",
    intended: "CESIUM_3D_TILE_CLASSIFICATION",
  },
  {
    file: "WebGPUVector3DTilePrimitiveRenderer.js",
    text: "pass: Pass.CESIUM_3D_TILE_CLASSIFICATION,",
    intended: "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
  },
  {
    file: "WebGPUVector3DTileClampedPolylinesRenderer.js",
    text: "const PASS_CESIUM_3D_TILE_CLASSIFICATION_DRIFTED = Pass.CESIUM_3D_TILE;",
    intended: "CESIUM_3D_TILE_CLASSIFICATION",
  },
  {
    file: "WebGPUVector3DTileClampedPolylinesRenderer.js",
    text: "pass: Pass.CESIUM_3D_TILE_CLASSIFICATION,",
    intended: "CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW",
  },
];

test("CO-12: the classifier pass-slot drift is recorded, marked, and still exactly one slot low", () => {
  for (const site of CLASSIFIER_DRIFT_SITES) {
    const code = readNormalized(`${WEBGPU_RENDERER_DIR}/${site.file}`);
    assert.ok(
      code.includes(site.text),
      `${site.file}: expected the recorded drifted site \`${site.text}\`. If it was CORRECTED, that is good news — update this table and the DEFERRED_WORK row together.`,
    );
    // The drift is exactly one slot, every time. That is the whole reason to
    // believe it is one insertion's worth of rot rather than eight independent
    // mistakes, and it is what makes the fix mechanical.
    const actualName = site.text.match(/Pass\.([A-Z0-9_]+)/)[1];
    assert.equal(
      PASS[site.intended] - PASS[actualName],
      1,
      `${site.file}: ${actualName} is no longer exactly one slot below the intended ${site.intended}; the drift changed shape and the fix is no longer mechanical`,
    );
  }
  for (const file of new Set(CLASSIFIER_DRIFT_SITES.map((s) => s.file))) {
    assert.match(
      readNormalized(`${WEBGPU_RENDERER_DIR}/${file}`),
      /NEW-WEBGPU-CLASSIFIER-PASS-SLOT-DRIFT/,
      `${file}: the drift marker is gone — a reader would see a plausible-looking enum member with no warning`,
    );
  }
});

// ── CO-12: the three added probe lanes ──────────────────────────────────────
//
// `C15-G5` certified with ONE camera and NEITHER of the two controls its own
// exit gate declared mandatory; `C15-G8`'s gate text names lanes the probe
// could not run. The lanes exist now, so what has to be pinned is that they
// cannot be satisfied by the wrong world:
//
//   * three captures at ONE camera diff to nothing and look like a perfect
//     orbit;
//   * an SH-off control that never actually switched SH off reports the same
//     0.000% the SH-on run did, which is the BEST score the gate can print;
//   * a corruption control that never reached the GPU reports "no change",
//     which is indistinguishable from "the covariance does not matter".
//
// Each of those is a rule below, and each has a mutant that commits it.

const AZIMUTH_PITCH_DEGREES = -30;

/** The view direction the probe's own camera derivation produces. */
function azimuthDirection(headingDegrees) {
  const p = (AZIMUTH_PITCH_DEGREES * Math.PI) / 180;
  const h = (headingDegrees * Math.PI) / 180;
  return [Math.cos(p) * Math.cos(h), Math.cos(p) * Math.sin(h), Math.sin(p)];
}

function azimuthLeg(overrides = {}) {
  const added = Math.round(CANVAS_PIXELS * 0.19141);
  return {
    canvasPixels: CANVAS_PIXELS,
    azimuths: AZIMUTH_HEADINGS.map((heading, index) => ({
      headingDegrees: heading,
      pngKey: `k${heading}`,
      viewDirection: azimuthDirection(heading),
      canvasPixels: CANVAS_PIXELS,
      backgroundForeground: 0,
      added: { changed: added, edgeFraction: 0.08, luminanceStdDev: 32 },
      determinismChanged: 0,
      sortQuiesced: true,
      // A 120 deg orbit re-projects the whole cloud; half the footprint moving
      // is a deliberately unremarkable healthy value.
      changedVsPrevious: index === 0 ? null : Math.round(added * 0.5),
    })),
    ...overrides,
  };
}

const azimuthDiffs = (fractions) =>
  AZIMUTH_HEADINGS.map((heading, index) => ({
    headingDegrees: heading,
    mismatchFraction: fractions[index],
  }));

function azimuthInput(overrides = {}) {
  return {
    expectWebgpu: true,
    referenceBlind: false,
    presenceState: "present",
    asset: ASSET,
    reference: azimuthLeg(),
    webgpu: azimuthLeg(),
    diffs: azimuthDiffs([0.0, 0.0002, 0.0001]),
    ...overrides,
  };
}

function shOffControl(overrides = {}) {
  return {
    supported: true,
    why: "",
    canvasPixels: CANVAS_PIXELS,
    originalDegree: 3,
    flipMs: 3_100,
    azimuths: AZIMUTH_HEADINGS.map((heading) => ({
      headingDegrees: heading,
      // The recorded pre-C15-G5 residual: SH off means the WebGPU leg is the
      // pre-G5 renderer again, so the cross-backend diff comes back.
      crossBackendMismatch: 0.02574,
      sameBackendMismatch: 0.02574,
    })),
    restored: true,
    restoredChanged: 0,
    ...overrides,
  };
}

function shOffInput(overrides = {}) {
  return {
    expectWebgpu: true,
    referenceBlind: false,
    presenceState: "present",
    asset: ASSET,
    control: shOffControl(),
    ...overrides,
  };
}

function covarianceControl(overrides = {}) {
  return {
    supported: true,
    why: "",
    canvasPixels: CANVAS_PIXELS,
    splatsCorruptedSingle: 1,
    splatsCorruptedBulk: 14,
    numSplats: 27,
    cleanAddedChanged: Math.round(CANVAS_PIXELS * 0.19141),
    // One splat of 27 at 4x area, comfortably over the 10x-determinism floor.
    singleChanged: Math.round(CANVAS_PIXELS * 0.012),
    // Half the cloud at 4x area, comfortably over the 1% cube gate.
    bulkChanged: Math.round(CANVAS_PIXELS * 0.09),
    restored: true,
    restoredChanged: 0,
    ...overrides,
  };
}

function covarianceInput(overrides = {}) {
  return {
    expectWebgpu: true,
    referenceBlind: false,
    presenceState: "present",
    asset: ASSET,
    control: covarianceControl(),
    ...overrides,
  };
}

const ARMED_STAGE = Object.freeze({
  ...STAGE,
  id: "C15-G8-fixture",
  controls: Object.freeze({
    ...STAGE.controls,
    azimuth: Object.freeze({
      scored: true,
      deferredTo: null,
      reason: "fixture",
    }),
  }),
});

const CO12_REAL = Object.freeze({
  evaluateAzimuthLane,
  evaluateShOffControl,
  evaluateCovarianceControl,
});

const CO12_RULES = {
  "three captures at ONE camera are STRUCTURAL, not a perfect orbit": (
    impl,
  ) => {
    const frozen = azimuthLeg();
    for (const entry of frozen.azimuths) {
      entry.viewDirection = azimuthDirection(0);
    }
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({ reference: frozen, webgpu: frozen }),
    );
    assert.ok(
      lane.structural.some((item) => /cameras-not-separated/.test(item)),
      `expected cameras-not-separated; got ${JSON.stringify(lane.structural)}`,
    );
    assert.equal(lane.failures.length, 0, "a blind lane does not file defects");
  },

  "an orbit that did not change the picture is STRUCTURAL": (impl) => {
    const stuck = azimuthLeg();
    for (const entry of stuck.azimuths) {
      if (entry.changedVsPrevious !== null) entry.changedVsPrevious = 3;
    }
    const lane = impl.evaluateAzimuthLane(azimuthInput({ reference: stuck }));
    assert.ok(
      lane.structural.some((item) => /frames-not-distinct/.test(item)),
      `expected frames-not-distinct; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "a partial orbit is STRUCTURAL, not two thirds of a gate": (impl) => {
    const short = azimuthLeg();
    short.azimuths = short.azimuths.slice(0, 2);
    const lane = impl.evaluateAzimuthLane(azimuthInput({ webgpu: short }));
    assert.ok(
      lane.structural.some((item) => /azimuth:incomplete/.test(item)),
      `expected azimuth:incomplete; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "an azimuth with no cross-backend diff is STRUCTURAL": (impl) => {
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({ diffs: azimuthDiffs([0.0, null, 0.0001]) }),
    );
    assert.ok(
      lane.structural.some((item) => /azimuth:no-diff-measured/.test(item)),
      `expected azimuth:no-diff-measured; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "the azimuth lane refuses against a WebGPU leg that drew nothing": (impl) => {
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({ presenceState: "absent" }),
    );
    assert.equal(lane.scored, false);
    assert.equal(lane.failures.length, 0);
    assert.equal(lane.structural.length, 0);
  },

  "the azimuth lane refuses against a blind reference": (impl) => {
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({ referenceBlind: true }),
    );
    assert.ok(lane.structural.some((item) => /reference-blind/.test(item)));
  },

  "an over-threshold azimuth is a FAIL once the stage arms it": (impl) => {
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({
        stage: ARMED_STAGE,
        diffs: azimuthDiffs([0.0, 0.0002, 0.031]),
      }),
    );
    assert.equal(lane.gated, true);
    assert.ok(
      lane.failures.some((item) =>
        /mismatch-above-threshold@240deg/.test(item),
      ),
      `expected the 240 deg azimuth to fail; got ${JSON.stringify(lane.failures)}`,
    );
  },

  "the SHIPPED stage records the azimuth numbers without gating them": (
    impl,
  ) => {
    const lane = impl.evaluateAzimuthLane(
      azimuthInput({ diffs: azimuthDiffs([0.031, 0.031, 0.031]) }),
    );
    assert.equal(lane.gated, false);
    assert.equal(lane.failures.length, 0);
    assert.equal(lane.notes.length, 1);
    assert.match(lane.notes[0], /RECORDED, NOT GATED/);
  },

  "an SH-off leg that still matches WebGL is a FAIL, not a perfect score": (
    impl,
  ) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({
        control: shOffControl({
          azimuths: AZIMUTH_HEADINGS.map((heading) => ({
            headingDegrees: heading,
            crossBackendMismatch: 0,
            sameBackendMismatch: 0,
          })),
        }),
      }),
    );
    assert.ok(
      lane.failures.some((item) => /sh-term-vacuous/.test(item)),
      `expected sh-term-vacuous; got ${JSON.stringify(lane.failures)}`,
    );
  },

  "one risen azimuth out of three is not enough": (impl) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({
        control: shOffControl({
          azimuths: [
            { headingDegrees: 0, crossBackendMismatch: 0.02574 },
            { headingDegrees: 120, crossBackendMismatch: 0.0001 },
            { headingDegrees: 240, crossBackendMismatch: 0.0 },
          ],
        }),
      }),
    );
    assert.ok(lane.failures.some((item) => /sh-term-vacuous/.test(item)));
  },

  "two risen azimuths out of three IS enough (the row's own wording)": (
    impl,
  ) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({
        control: shOffControl({
          azimuths: [
            { headingDegrees: 0, crossBackendMismatch: 0.02574 },
            { headingDegrees: 120, crossBackendMismatch: 0.021 },
            // A view-dependent term is allowed to vanish at one camera.
            { headingDegrees: 240, crossBackendMismatch: 0.0001 },
          ],
        }),
      }),
    );
    assert.equal(lane.failures.length, 0);
    assert.equal(lane.gated, true);
  },

  "an SH-off control that did not execute is STRUCTURAL, never silence": (
    impl,
  ) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({ control: { supported: false, why: "no SH to switch off" } }),
    );
    assert.ok(
      lane.structural.some((item) => /sh-off:not-executed/.test(item)),
      `expected sh-off:not-executed; got ${JSON.stringify(lane.structural)}`,
    );
    assert.equal(lane.failures.length, 0);
  },

  "an SH-off control that does not restore the renderer is STRUCTURAL": (
    impl,
  ) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({
        control: shOffControl({
          restored: true,
          restoredChanged: Math.round(CANVAS_PIXELS * 0.05),
        }),
      }),
    );
    assert.ok(
      lane.structural.some((item) => /sh-off:not-restored/.test(item)),
      `expected sh-off:not-restored; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "the SH-off control is recorded but NOT gated on tower": (impl) => {
    const lane = impl.evaluateShOffControl(
      shOffInput({
        asset: ASSETS.tower,
        control: shOffControl({
          azimuths: AZIMUTH_HEADINGS.map((heading) => ({
            headingDegrees: heading,
            crossBackendMismatch: 0,
          })),
        }),
      }),
    );
    assert.equal(
      lane.failures.length,
      0,
      "tower has no derived floor to gate on",
    );
    assert.equal(lane.notes.length, 1);
    assert.match(lane.notes[0], /RECORDED, NOT GATED/);
  },

  "a corruption the parity gate cannot see is a FAIL": (impl) => {
    const lane = impl.evaluateCovarianceControl(
      covarianceInput({
        control: covarianceControl({
          bulkChanged: Math.round(CANVAS_PIXELS * 0.004),
        }),
      }),
    );
    assert.ok(
      lane.failures.some((item) => /gate-cannot-fail/.test(item)),
      `expected gate-cannot-fail; got ${JSON.stringify(lane.failures)}`,
    );
  },

  "an invisible single-triple corruption is a FAIL on the tight leg": (
    impl,
  ) => {
    const lane = impl.evaluateCovarianceControl(
      covarianceInput({
        control: covarianceControl({ singleChanged: 12 }),
      }),
    );
    assert.ok(
      lane.failures.some((item) => /single-triple-invisible/.test(item)),
      `expected single-triple-invisible; got ${JSON.stringify(lane.failures)}`,
    );
  },

  "the single-triple arm is NOT gated on tower (it is below the resolution)": (
    impl,
  ) => {
    const lane = impl.evaluateCovarianceControl(
      covarianceInput({
        asset: ASSETS.tower,
        control: covarianceControl({
          numSplats: ASSETS.tower.expectedSplats,
          cleanAddedChanged: Math.round(CANVAS_PIXELS * 0.0408),
          singleChanged: 0,
          bulkChanged: Math.round(CANVAS_PIXELS * 0.05),
        }),
      }),
    );
    assert.equal(
      lane.failures.length,
      0,
      "one splat of 286,868 cannot move a measurable number of pixels; gating it would gate noise",
    );
  },

  "an irreversible corruption is STRUCTURAL": (impl) => {
    const lane = impl.evaluateCovarianceControl(
      covarianceInput({
        control: covarianceControl({
          restoredChanged: Math.round(CANVAS_PIXELS * 0.02),
        }),
      }),
    );
    assert.ok(
      lane.structural.some((item) => /covariance:not-restored/.test(item)),
      `expected covariance:not-restored; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "a corruption that never became resident is STRUCTURAL": (impl) => {
    const lane = impl.evaluateCovarianceControl(
      covarianceInput({
        control: { supported: false, why: "never became resident" },
      }),
    );
    assert.ok(
      lane.structural.some((item) => /covariance:not-executed/.test(item)),
      `expected covariance:not-executed; got ${JSON.stringify(lane.structural)}`,
    );
  },

  "every lane folds into the verdict": (impl) => {
    const failing = impl.evaluateCovarianceControl(
      covarianceInput({
        control: covarianceControl({ bulkChanged: 0 }),
      }),
    );
    const folded = foldGsplatVerdict({
      reference: { failures: [], structural: [] },
      webgpu: { failures: [], structural: [], notes: [] },
      controls: [failing],
    });
    assert.equal(folded.exitCode, EXIT_CODE.FAIL);
    const structural = impl.evaluateShOffControl(
      shOffInput({ control: { supported: false, why: "x" } }),
    );
    assert.equal(
      foldGsplatVerdict({
        reference: { failures: [], structural: [] },
        webgpu: { failures: [], structural: [], notes: [] },
        controls: [structural],
      }).exitCode,
      EXIT_CODE.STRUCTURAL,
    );
  },
};

for (const [name, rule] of Object.entries(CO12_RULES)) {
  test(`CO-12 rule: ${name}`, () => rule(CO12_REAL));
}

function firstCo12RuleThatRejects(impl) {
  for (const [ruleName, rule] of Object.entries(CO12_RULES)) {
    try {
      rule(impl);
    } catch {
      return ruleName;
    }
  }
  return null;
}

test("CO-12 meta: the real lane implementations survive every rule", () => {
  assert.equal(firstCo12RuleThatRejects(CO12_REAL), null);
});

const CO12_MUTANTS = {
  "the azimuth lane drops the camera-separation guard": {
    ...CO12_REAL,
    evaluateAzimuthLane(input) {
      const real = CO12_REAL.evaluateAzimuthLane(input);
      if (real.structural.some((item) => /cameras-not-separated/.test(item))) {
        return CO12_REAL.evaluateAzimuthLane({
          ...input,
          reference: azimuthLeg(),
          webgpu: azimuthLeg(),
        });
      }
      return real;
    },
  },
  "the azimuth lane drops the picture-changed guard": {
    ...CO12_REAL,
    evaluateAzimuthLane(input) {
      const real = CO12_REAL.evaluateAzimuthLane(input);
      if (real.structural.some((item) => /frames-not-distinct/.test(item))) {
        return CO12_REAL.evaluateAzimuthLane({
          ...input,
          reference: azimuthLeg(),
        });
      }
      return real;
    },
  },
  "a partial orbit is quietly scored on whatever arrived": {
    ...CO12_REAL,
    evaluateAzimuthLane(input) {
      const real = CO12_REAL.evaluateAzimuthLane(input);
      if (real.structural.some((item) => /azimuth:incomplete/.test(item))) {
        return { ...real, structural: [], failures: [], scored: true };
      }
      return real;
    },
  },
  "an unexecuted SH-off control passes silently": {
    ...CO12_REAL,
    evaluateShOffControl(input) {
      const real = CO12_REAL.evaluateShOffControl(input);
      if (real.structural.some((item) => /sh-off:not-executed/.test(item))) {
        return { ...real, structural: [], failures: [] };
      }
      return real;
    },
  },
  "the SH-off control accepts a single risen azimuth": {
    ...CO12_REAL,
    evaluateShOffControl(input) {
      const real = CO12_REAL.evaluateShOffControl(input);
      if (real.failures.some((item) => /sh-term-vacuous/.test(item))) {
        const risen = (input.control?.azimuths ?? []).filter(
          (a) => (a.crossBackendMismatch ?? 0) > 0,
        );
        if (risen.length >= 1) return { ...real, failures: [] };
      }
      return real;
    },
  },
  "the SH-off restoration arm is dropped": {
    ...CO12_REAL,
    evaluateShOffControl(input) {
      const real = CO12_REAL.evaluateShOffControl(input);
      if (real.structural.some((item) => /sh-off:not-restored/.test(item))) {
        return CO12_REAL.evaluateShOffControl({
          ...input,
          control: { ...input.control, restoredChanged: 0 },
        });
      }
      return real;
    },
  },
  "the covariance bulk arm is dropped, leaving only the single one": {
    ...CO12_REAL,
    evaluateCovarianceControl(input) {
      const real = CO12_REAL.evaluateCovarianceControl(input);
      return {
        ...real,
        failures: real.failures.filter(
          (item) => !/gate-cannot-fail/.test(item),
        ),
      };
    },
  },
  "the covariance single arm is gated on EVERY asset": {
    ...CO12_REAL,
    evaluateCovarianceControl(input) {
      const real = CO12_REAL.evaluateCovarianceControl(input);
      const single = (input.control?.singleChanged ?? 0) / CANVAS_PIXELS;
      if (
        real.gated &&
        single < PREDICT.negativeControlMargin * PREDICT.determinismFraction &&
        !real.failures.some((item) => /single-triple-invisible/.test(item))
      ) {
        return {
          ...real,
          failures: [...real.failures, "covariance:single-triple-invisible"],
        };
      }
      return real;
    },
  },
  "an irreversible corruption is treated as a pass": {
    ...CO12_REAL,
    evaluateCovarianceControl(input) {
      const real = CO12_REAL.evaluateCovarianceControl(input);
      if (
        real.structural.some((item) => /covariance:not-restored/.test(item))
      ) {
        return { ...real, structural: [] };
      }
      return real;
    },
  },
};

for (const [mutantName, impl] of Object.entries(CO12_MUTANTS)) {
  test(`CO-12 mutant rejected: ${mutantName}`, () => {
    assert.notEqual(
      firstCo12RuleThatRejects(impl),
      null,
      `mutant "${mutantName}" survived every CO-12 rule`,
    );
  });
}

// ── CO-12: the numbers that must stay DERIVED, not adjusted ─────────────────

test("CO-12 DERIVED: the azimuth separation is computed from the probe's own camera", () => {
  // Re-derived here from the formula rather than copied: if someone changes the
  // pitch or the heading step in the probe and not the prediction, this is what
  // notices. `acos(cos^2 p cos d + sin^2 p)` at p = -30, d = 120.
  const p = (AZIMUTH_PITCH_DEGREES * Math.PI) / 180;
  const d = ((AZIMUTH_HEADINGS[1] - AZIMUTH_HEADINGS[0]) * Math.PI) / 180;
  const derived =
    (Math.acos(Math.cos(p) ** 2 * Math.cos(d) + Math.sin(p) ** 2) * 180) /
    Math.PI;
  assert.ok(
    Math.abs(derived - PREDICT.azimuthSeparationDegrees) < 1e-9,
    `PREDICT.azimuthSeparationDegrees (${PREDICT.azimuthSeparationDegrees}) is not the angle the probe's camera actually produces (${derived})`,
  );
  // And it must agree with the vector helper the lane uses.
  assert.ok(
    Math.abs(
      angleBetweenDegrees(azimuthDirection(0), azimuthDirection(120)) - derived,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      angleBetweenDegrees(azimuthDirection(120), azimuthDirection(240)) -
        derived,
    ) < 1e-9,
  );
  assert.equal(PREDICT.azimuthSeparationDegrees > 90, true);
});

test("CO-12: angleBetweenDegrees never lets an unmeasured camera satisfy the guard", () => {
  for (const bad of [
    [undefined, [1, 0, 0]],
    [[1, 0, 0], null],
    [
      [0, 0, 0],
      [1, 0, 0],
    ],
    [
      [Number.NaN, 0, 0],
      [1, 0, 0],
    ],
    [
      [1, 0],
      [1, 0, 0],
    ],
  ]) {
    const value = angleBetweenDegrees(bad[0], bad[1]);
    assert.equal(Number.isNaN(value), true);
    assert.equal(
      Math.abs(value - PREDICT.azimuthSeparationDegrees) <=
        PREDICT.azimuthSeparationToleranceDegrees,
      false,
    );
  }
});

test("CO-12 DERIVED: the single-triple arm is gated exactly where it is resolvable", () => {
  // The arithmetic that decides which assets carry the single arm, restated so
  // the choice is checkable rather than asserted. One corrupted splat can only
  // move pixels inside its own footprint.
  const floor = PREDICT.negativeControlMargin * PREDICT.determinismFraction;
  const perSplat = {
    sh_unit_cube: 0.19141 / ASSETS.sh_unit_cube.expectedSplats,
    tower: 0.0408 / ASSETS.tower.expectedSplats,
  };
  assert.ok(
    perSplat.sh_unit_cube > floor,
    `the cube's per-splat footprint (${perSplat.sh_unit_cube}) must exceed the ${floor} floor, or the single arm gates noise`,
  );
  assert.ok(
    perSplat.tower < floor / 100,
    `tower's per-splat footprint (${perSplat.tower}) is orders below the floor — gating it would gate noise`,
  );
  assert.deepEqual(STAGE.controls.covariance.singleArmGatedAssets, [
    "sh_unit_cube",
  ]);
  assert.deepEqual(STAGE.controls.shOff.gatedAssets, ["sh_unit_cube"]);
});

test("CO-12: the corruption factor is an exact half-float exponent shift", () => {
  // 4 = +2 exponent. A non-power-of-two would make the corrupter's exponent
  // arithmetic approximate, and an approximate corruption is not a control.
  const shift = Math.log2(PREDICT.covarianceScaleFactor);
  assert.equal(Number.isInteger(shift), true);
  assert.equal(shift > 0, true);
  assert.equal(PREDICT.covarianceBulkStride >= 2, true);
});

test("CO-12: the lane vocabulary is pinned", () => {
  assert.deepEqual(CONTROL_LANES, [
    "azimuth",
    "sh-off-vacuity",
    "covariance-vacuity",
  ]);
  assert.deepEqual(AZIMUTH_HEADINGS, [0, 120, 240]);
  assert.equal(
    AZIMUTH_HEADINGS[0],
    0,
    "heading 0 must stay FIRST — every recorded C15-G* number was taken there",
  );
});

// ── CO-12: probe-source anchors for the added lanes ─────────────────────────

test("CO-12 probe: every azimuth gets its own reference frame and its own quiescence", () => {
  const from = PROBE_CODE.indexOf(
    "for (let i = 1; i < azimuthHeadings.length; i++) {",
  );
  assert.notEqual(from, -1, `${PROBE_PATH}: the orbit loop is gone`);
  const to = PROBE_CODE.indexOf("if (!runControls) {", from);
  assert.ok(to > from, `${PROBE_PATH}: the orbit loop lost its terminator`);
  const body = PROBE_CODE.slice(from, to);
  assert.match(body, /frameCameraAt\(heading\)/);
  assert.match(
    body,
    /tileset\.show = false;[\s\S]*?const off = captureNow\(\);/,
    "an azimuth scored against another azimuth's reference frame measures the camera move, not the splats",
  );
  assert.match(
    body,
    /await waitForSortQuiescence\(/,
    "a 120 deg camera move is exactly what triggers a steady sort; without re-quiescing, C15-G4b's defect returns at azimuths 1 and 2",
  );
  assert.match(
    body,
    /const a = captureNow\(\);\n\s*const b = captureNow\(\);/,
    "the per-azimuth determinism pair must be same-task too",
  );
  assert.match(body, /changedVsPrevious: changedPixelCount\(/);
});

test("CO-12 probe: the SH-off control flips the ENGINE's own SH seam and puts it back", () => {
  assert.match(
    PROBE_CODE,
    /controlled\._sphericalHarmonicsDegree = 0;/,
    "the control must drive the degree the engine resolves SH from, not a probe-local flag",
  );
  assert.match(
    PROBE_CODE,
    /controlled\._sphericalHarmonicsDegree = originalDegree;/,
    "the control must be withdrawn",
  );
  assert.match(
    PROBE_CODE,
    /resourcesShEnabled === false &&\s*\n?\s*!!controlled\._webgpuCache\?\.pipeline/,
    "waiting only on the flag would capture during the cold variant compile, when nothing draws at all",
  );
  assert.match(PROBE_CODE, /restoredChanged: changedPixelCount\(/);
});

test("CO-12 probe: the corruption is applied to a COPY, never in place", () => {
  assert.match(
    PROBE_CODE,
    /const data = payload\.data\.slice\(\);/,
    "the payload must be copied — an in-place corruption cannot be withdrawn, and the restore arm would be measuring nothing",
  );
  assert.doesNotMatch(
    PROBE_CODE,
    /payload\.data\[[^\]]+\] =/,
    "an in-place write to the real payload destroys the data every later reading depends on",
  );
  assert.match(
    PROBE_CODE,
    /controlled\._webgpuCache\?\.splatSourceToken === nextPayload/,
    "residency must be waited on through the engine's own producer-identity dirty signal, not a frame count",
  );
  assert.match(
    PROBE_CODE,
    /const restoredUpload = await publish\(payload\);/,
    "the original payload object must be republished, so the restore is a reference swap",
  );
  // The corrupter must not manufacture Inf/NaN: an exploded quad would satisfy
  // this control for a reason unrelated to the covariance being read.
  assert.match(PROBE_CODE, /if \(exponent === 0 \|\| exponent === 0x1f\) \{/);
  assert.match(
    PROBE_CODE,
    /Math\.min\(30, Math\.max\(1, exponent \+ expDelta\)\)/,
  );
});

test("CO-12 probe: the controls are WebGPU-only and flip-mode-only", () => {
  assert.match(
    PROBE_CODE,
    /const webgpu = await runBackend\(\s*\n\s*browser,\s*\n\s*"webgpu",\s*\n\s*asset,\s*\n\s*derivedBudget,\s*\n\s*EXPECT_WEBGPU,\s*\n\s*\);/,
    "the controls must ride the flip flag, not run in the default current-state mode",
  );
  const webglCall = PROBE_CODE.slice(
    PROBE_CODE.indexOf("const webgl = await runBackend("),
    PROBE_CODE.indexOf("const derivedBudget"),
  );
  assert.match(
    webglCall,
    /\n\s*false,\n\s*\);/,
    "the WebGL leg is the REFERENCE — corrupting it would be corrupting the thing the measurement is against",
  );
  assert.match(PROBE_CODE, /runControls: runControls === true,/);
});

test("CO-12 probe: the three lanes are evaluated and folded, not merely printed", () => {
  assert.match(PROBE_CODE, /const azimuth = evaluateAzimuthLane\(\{/);
  assert.match(PROBE_CODE, /const shOff = evaluateShOffControl\(\{/);
  assert.match(PROBE_CODE, /const covariance = evaluateCovarianceControl\(\{/);
  assert.match(
    PROBE_CODE,
    /controls: \[azimuth, shOff, covariance\],/,
    "a lane that is evaluated and not folded cannot change the exit code",
  );
  // Each lane must inherit the same two gatekeepers the parity leg has.
  for (const lane of [
    "evaluateAzimuthLane",
    "evaluateShOffControl",
    "evaluateCovarianceControl",
  ]) {
    const at = PROBE_CODE.indexOf(`${lane}({`);
    const block = PROBE_CODE.slice(at, PROBE_CODE.indexOf("});", at));
    assert.match(block, /referenceBlind: reference\.blind/, `${lane}`);
    assert.match(block, /presenceState: webgpuLeg\.presence\.state/, `${lane}`);
  }
});
