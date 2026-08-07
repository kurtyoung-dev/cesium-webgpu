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
import { fileURLToPath } from "node:url";

import {
  ABSENCE_BLOCKERS,
  ABSENT_MARKER,
  ASSETS,
  EXIT_CODE,
  PREDICT,
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
      { expectWebgpu: false },
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
      { expectWebgpu: false },
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
    });
    assert.equal(leg.structural.length, 0);
    assert.equal(leg.notes.length, 1);
  },

  "a blocker C15-G2 retired, observed again, is a REGRESSION not an attribution":
    (impl) => {
      for (const retired of STAGE.retired) {
        const leg = impl.evaluateWebgpuLeg(
          webgpuAbsentLane({
            absenceBlockers: [...STAGE.required, retired],
          }),
          ASSET,
          PREDICT,
          { expectWebgpu: false },
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
    for (const required of STAGE.required) {
      const remaining = STAGE.required.filter((name) => name !== required);
      const leg = impl.evaluateWebgpuLeg(
        webgpuAbsentLane({ absenceBlockers: remaining }),
        ASSET,
        PREDICT,
        { expectWebgpu: false },
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
    for (const name of [...STAGE.required, ...STAGE.retired]) {
      assert.ok(
        ABSENCE_BLOCKERS.includes(name),
        `${name} is not in ABSENCE_BLOCKERS, so recognizedBlockers can never surface it`,
      );
    }
    for (const name of STAGE.required) {
      assert.ok(
        !STAGE.retired.includes(name),
        `${name} cannot be both required and retired`,
      );
    }
    assert.ok(
      STAGE.required.length > 0,
      "an empty required set means the absence contract is over — run --expect-webgpu",
    );
  },

  "absence while the lazy FR never loaded is STRUCTURAL, not expected": (
    impl,
  ) => {
    for (const kind of ["loading", "failed", "unsupported", null]) {
      const leg = impl.evaluateWebgpuLeg(
        webgpuAbsentLane({ featureRendererKind: kind }),
        ASSET,
        PREDICT,
        { expectWebgpu: false },
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
    });
    assert.equal(under.scored, true);
    assert.equal(under.pass, true);
    const over = impl.evaluateParity({
      expectWebgpu: true,
      referenceBlind: false,
      presenceState: "present",
      mismatchFraction: ASSET.parityThresholdFraction * 1.5,
      asset: ASSET,
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
      { expectWebgpu: false },
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
      const stripped = {
        ...lane,
        absenceBlockers: (lane?.absenceBlockers ?? []).filter((name) =>
          STAGE.required.includes(name),
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
          { ...lane, absenceBlockers: [...STAGE.required] },
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
  const textureBranch = source.indexOf(
    "if (defined(primitive._featureRenderer)) {",
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
        "if (defined(primitive._featureRenderer)) {",
        "if (false) {",
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
      `That is the C15-G3 deliverable. Re-run probe-gsplat-parity.mjs with --expect-webgpu, ` +
      `and update this anchor to assert the producer instead of its absence.`,
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
