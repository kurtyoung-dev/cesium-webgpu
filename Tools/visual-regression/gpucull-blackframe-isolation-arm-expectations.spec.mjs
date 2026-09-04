// gpucull-blackframe-isolation-arm-expectations.spec.mjs — browser-free
// behaviour pin for the arm table `probe-gpucull-blackframe-isolation.mjs`
// reports against (Q-20 / Q-48, Q-153's sibling row). Pure Node: no
// browser, no GPU, no build.
//
// @purpose Pins the REAL `WebGPUSceneRenderer#_maybeGPUCullTranslucent`'s raw inclusive count-vs-threshold boundary decision against `lib/gpucull-blackframe-isolation-gate.mjs`'s ARMS table, pins that the margin-adjusted `expectDispatch` the gate module derives cannot regress to a false STRUCTURAL refusal on the boundary arm (C6), and that `judgeIsolationResults` reports the documented exit-code verdict.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// The isolation probe's prior version read only `gpuCullerOpaque` — always 0
// for this scene, whose commands are translucent by construction (see the
// probe's own file header) — so its `cullDispatches` field read 0 in every
// arm regardless of whether the translucent GPU cull the probe exists to
// isolate actually fired. A probe reading the right counter is necessary but
// not sufficient: the ARM TABLE's own claim about which arms should dispatch
// also has to be true of the real engine, or a future threshold change could
// silently make the "should dispatch" arms wrong while this file's own
// bookkeeping stays self-consistent. This spec closes part of that gap by
// driving the REAL `_maybeGPUCullTranslucent` (not a description of it)
// against every arm in `ARMS` (B1/B2/B3) and independently pins
// `judgeIsolationResults`' verdict behaviour (C1-C6), including the exact
// false-refusal shape a prior version of this gate produced for the
// boundary arm (C6) — but B1 does NOT (and cannot, without simulating real
// frustum culling) validate `expectDispatch` for that boundary arm; see the
// next paragraph.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// Same technique as `translucent-cull-render-pass-bracket.spec.mjs`:
// `WebGPUSceneRenderer.ts` is bundled with esbuild through the shared
// stub-dependency bundler (`lib/engine-stub-bundler.mjs`), every sibling
// import replaced with an inert Proxy stub, and the REAL prototype methods
// (`_maybeGPUCullTranslucent`, `gpuCullCommandsForTranslucent`,
// `_updateActivationGate`, `_resumeScenePass`) run unmodified against a bare
// `Object.create`'d instance and a fake `WebGPUContext` whose
// `gpuCullerTranslucent.dispatch` records whether it fired.
//
// B1 drives every `ARMS` entry through the real method, feeding `arm.n`
// directly as the command count (this fixture builds no scene and applies no
// frustum culling — see `makeCullInputs`), and asserts the observed
// dispatch-fired decision against `rawThresholdCrossed(arm)`
// (`hint === "always" && n >= GPU_CULL_THRESHOLD_HI`, inclusive). This is
// DELIBERATELY NOT the same claim as the gate module's `arm.expectDispatch`:
// `expectDispatch` predicts what the real, frustum-culled Edge probe should
// observe, with a strict margin (`n > HI`) specifically because a count fed
// directly (as this fixture does) is not what the real scene delivers — see
// `lib/gpucull-blackframe-isolation-gate.mjs`'s module header for the
// evidence that `n384-always`'s post-cull count lands under the threshold
// even though `384 >= GPU_CULL_THRESHOLD_HI`. B1 therefore pins the engine's
// raw, inclusive `count >= hi` boundary decision in isolation — a real and
// useful claim, corroborated by B2 — without claiming to validate
// `expectDispatch` for the boundary arm; only a live Edge leg (recording
// `translucentCommandsSeen`) can do that. For every non-boundary arm the two
// predicates agree, so B1 still exercises the full `ARMS` table.
//
// B2 cross-checks the gate module's mirrored `GPU_CULL_THRESHOLD_HI`/`_LO`
// against the real static class fields, so a threshold change in the engine
// without an update to the gate module's mirror fails here, not silently.
// B3 is the inertness mutant (Principle 10 / SR-7): `mutateOrFail` disables
// the activation gate's high-threshold check on a COPY of the real source
// (the file on disk is never touched) and requires every arm whose
// `expectDispatch` is true (n448-always, n600-always — the margin excludes
// the boundary arm) to stop dispatching. C1-C5 pin `judgeIsolationResults`
// against synthetic per-arm results, independently of both the probe and
// the engine. C6 pins the exact scenario a prior version of the gate module
// got wrong: the boundary arm (`n384-always`) reporting the banked
// pre-render-pass-bracket evidence's healthy zero-dispatch result must PASS,
// not refuse STRUCTURAL; its own mutation control reverts the gate module's
// margin fix on an in-memory copy (never the file on disk — same technique
// as `build-source-identity.spec.mjs`'s suffix-match mutant) and requires
// C6's scenario to regress to a false STRUCTURAL refusal.
//
// Run: node --test Tools/visual-regression/gpucull-blackframe-isolation-arm-expectations.spec.mjs

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";
import {
  ARMS,
  GPU_CULL_THRESHOLD_HI,
  GPU_CULL_THRESHOLD_LO,
  judgeIsolationResults,
} from "./lib/gpucull-blackframe-isolation-gate.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const SCENE_RENDERER_PATH = resolve(
  repoRoot,
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
);

/**
 * Reads a source file and normalises its line terminators, so anchors here
 * match regardless of the checkout's autocrlf setting.
 *
 * @param {string} path Absolute path to read.
 * @returns {Promise<string>} LF-normalised source.
 */
async function readSource(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

const SCENE_RENDERER_SOURCE = await readSource(SCENE_RENDERER_PATH);

/**
 * Bundles `WebGPUSceneRenderer.ts` with every import stubbed, optionally
 * through a source mutation, and returns its `WebGPUSceneRenderer` export.
 *
 * @param {Function} [mutate] Passed through to `bundle`'s `mutate` option.
 * @returns {Promise<Function>} The real `WebGPUSceneRenderer` class.
 */
async function importSceneRenderer(mutate) {
  const namespace = await bundle({
    path: SCENE_RENDERER_PATH,
    source: SCENE_RENDERER_SOURCE,
    real: [],
    mutate,
    label: "disable translucent-cull activation high threshold",
  });
  return namespace.WebGPUSceneRenderer;
}

/**
 * Wraps the activation gate's high-threshold check in `false &&` — inert,
 * never deleted (Principle 10 / SR-7). Applied to a COPY of the source
 * passed to `bundle`'s `mutate` option; the file on disk is untouched. Once
 * this fires, `_updateActivationGate` can never transition an inactive gate
 * to active, so `_maybeGPUCullTranslucent` never reaches its dispatch call
 * at ANY command count.
 *
 * @param {string} source LF-normalised `WebGPUSceneRenderer.ts` source.
 * @returns {string} The mutated source.
 */
function disableActivationHighThreshold(source) {
  return source.replace(
    "if (active) return count >= lo;\n    return count >= hi;",
    "if (active) return count >= lo;\n    return false && count >= hi;",
  );
}

/**
 * A minimal fake `WebGPUContext` sufficient for
 * `_maybeGPUCullTranslucent` → `gpuCullCommandsForTranslucent` →
 * `_resumeScenePass`'s no-scene-framebuffer fallback. `dispatchCount` is the
 * one observable this spec reads: whether the translucent culler's compute
 * dispatch actually fired.
 *
 * @returns {{context: object, dispatchCount: {value: number}}}
 */
function makeFakeContext() {
  const dispatchCount = { value: 0 };
  const context = {
    _currentRenderPassEncoder: { __kind: "fakeRenderPassEncoder" },
    _currentCommandEncoder: { __kind: "fakeCommandEncoder" },
    endCurrentRenderPass() {
      context._currentRenderPassEncoder = null;
    },
    resumeDefaultRenderPass() {
      context._currentRenderPassEncoder = { __kind: "fakeRenderPassEncoder" };
    },
    gpuCullerTranslucent: {
      initialized: true,
      uploadBoundingSpheres() {},
      uploadFrustumPlanes() {},
      dispatch() {
        dispatchCount.value++;
      },
      prepareReadback() {},
      readResults() {
        // Never resolves within the synchronous call this spec drives — see
        // the identical note in translucent-cull-render-pass-bracket.spec.mjs.
        return new Promise(() => {});
      },
    },
  };
  return { context, dispatchCount };
}

/**
 * Builds the `commands` / `count` / `config` arguments
 * `_maybeGPUCullTranslucent` reads for one arm.
 *
 * @param {object} context The fake context from {@link makeFakeContext}.
 * @param {number} count Translucent command count.
 * @param {"auto"|"always"|"never"} hint `scene.gpuCullingHint`.
 * @returns {{commands: Array<object>, count: number, config: object}} Args.
 */
function makeCullInputs(context, count, hint) {
  const commands = [];
  for (let i = 0; i < count; i++) {
    commands.push({
      boundingVolume: { center: { x: i, y: 0, z: 0 }, radius: 10 },
    });
  }
  const planes = [];
  for (let i = 0; i < 6; i++) {
    planes.push({ x: 1, y: 0, z: 0, w: -1000 - i });
  }
  const config = {
    picking: false,
    context,
    scene: {
      gpuCullingHint: hint,
      _frameState: { cullingVolume: { planes } },
    },
  };
  return { commands, count, config };
}

/**
 * Constructs a bare `WebGPUSceneRenderer` instance (`Object.create`, never
 * `new`) with exactly the instance fields `_maybeGPUCullTranslucent` and its
 * callees read, so every method call below runs the REAL prototype
 * implementation. Identical fixture shape to
 * `translucent-cull-render-pass-bracket.spec.mjs`.
 *
 * @param {Function} WebGPUSceneRenderer The bundled class.
 * @returns {object} The bare instance.
 */
function makeBareRenderer(WebGPUSceneRenderer) {
  const renderer = Object.create(WebGPUSceneRenderer.prototype);
  renderer._currentFrustumIndex = 0;
  renderer._gpuCullTranslucentActiveByFrustum = new Map();
  renderer._gpuCullTranslucentDispatchCount = 0;
  renderer._lastCullResultsTranslucent = undefined;
  renderer._sceneFramebuffer = undefined;
  return renderer;
}

/**
 * Drives `_maybeGPUCullTranslucent` for one arm on a fresh fixture (a fresh
 * page in the real probe) and reports whether the translucent culler's
 * dispatch fired.
 *
 * @param {Function} WebGPUSceneRenderer The bundled class.
 * @param {{n: number, hint: string}} arm
 * @returns {boolean} Whether `gpuCullerTranslucent.dispatch` was called.
 */
function dispatchFiredForArm(WebGPUSceneRenderer, arm) {
  const { context, dispatchCount } = makeFakeContext();
  const { commands, count, config } = makeCullInputs(context, arm.n, arm.hint);
  const renderer = makeBareRenderer(WebGPUSceneRenderer);
  WebGPUSceneRenderer.prototype._maybeGPUCullTranslucent.call(
    renderer,
    commands,
    count,
    config,
  );
  return dispatchCount.value > 0;
}

/**
 * The engine's raw, inclusive threshold decision for an arm's `n` fed
 * directly as the command count — i.e. what `_maybeGPUCullTranslucent`
 * decides with NO frustum culling applied, since this fixture builds no
 * scene. Deliberately a different predicate than `arm.expectDispatch` (see
 * this file's header comment): `expectDispatch` predicts the real,
 * frustum-culled probe's observation with a strict margin; this predicts
 * the method's own `count >= GPU_CULL_THRESHOLD_HI` boundary in isolation.
 * The two differ only for the boundary arm (`n === GPU_CULL_THRESHOLD_HI`).
 *
 * @param {{n: number, hint: string}} arm
 * @returns {boolean} Whether the real method should dispatch when fed
 *   `arm.n` directly as the command count.
 */
function rawThresholdCrossed(arm) {
  return arm.hint === "always" && arm.n >= GPU_CULL_THRESHOLD_HI;
}

test("B1: every ARMS entry's raw count-fed-directly dispatch decision matches the engine's inclusive count >= GPU_CULL_THRESHOLD_HI boundary", async () => {
  const WebGPUSceneRenderer = await importSceneRenderer();
  for (const arm of ARMS) {
    const fired = dispatchFiredForArm(WebGPUSceneRenderer, arm);
    const expected = rawThresholdCrossed(arm);
    assert.equal(
      fired,
      expected,
      `${arm.name} (n=${arm.n}, hint="${arm.hint}"): the real engine's ` +
        `translucent-cull dispatch fired=${fired} when fed count=${arm.n} ` +
        `directly (no frustum culling applied), but the inclusive raw ` +
        `threshold predicts ${expected}. This pins the engine's boundary ` +
        "decision only — it does not by itself validate arm.expectDispatch " +
        "for the boundary arm, whose real count is post-frustum-cull (see " +
        "this file's header comment and the gate module's).",
    );
  }
});

test("B2: the gate module's mirrored thresholds match the real static class fields", async () => {
  const WebGPUSceneRenderer = await importSceneRenderer();
  assert.equal(
    WebGPUSceneRenderer.GPU_CULL_THRESHOLD_HI,
    GPU_CULL_THRESHOLD_HI,
  );
  assert.equal(
    WebGPUSceneRenderer.GPU_CULL_THRESHOLD_LO,
    GPU_CULL_THRESHOLD_LO,
  );
});

test("B3 MUTATION: disabling the activation high threshold stops the arms B1 proved dispatch", async () => {
  const WebGPUSceneRenderer = await importSceneRenderer(
    disableActivationHighThreshold,
  );
  const shouldDispatch = ARMS.filter((arm) => arm.expectDispatch);
  assert.ok(
    shouldDispatch.length > 0,
    "the arm table must contain at least one expectDispatch arm for this " +
      "mutation to be able to prove anything",
  );
  for (const arm of shouldDispatch) {
    const fired = dispatchFiredForArm(WebGPUSceneRenderer, arm);
    assert.equal(
      fired,
      false,
      `${arm.name}: with the activation high threshold disabled, the ` +
        "dispatch must not fire at any count — if it still fires, B1's " +
        "assertion for this arm is not anchored to the threshold check " +
        "the mutant disables",
    );
  }
});

test("mutateOrFail rejects an identity rewrite (control for the B3 harness)", () => {
  assert.throws(
    () => mutateOrFail(SCENE_RENDERER_SOURCE, (source) => source, "identity"),
    { name: "AssertionError" },
    "an anchor that changes nothing must fail loudly rather than let B3 " +
      "pass vacuously",
  );
});

// ── judgeIsolationResults: independent of both the probe and the engine ────

/**
 * Builds a minimal per-arm result matching what the probe writes to
 * `isolation-round2.json`, defaulting to a clean, correctly-dispatching run.
 *
 * @param {string} name An `ARMS` entry's name.
 * @param {object} [overrides] Fields to override on the result.
 * @returns {object} One result entry.
 */
function makeResult(name, overrides = {}) {
  const arm = ARMS.find((entry) => entry.name === name);
  return {
    name,
    n: arm.n,
    hint: arm.hint,
    stats: { cullDispatches: arm.expectDispatch ? 1 : 0 },
    nonBlackPct: 100,
    validationErrorCount: 0,
    ...overrides,
  };
}

test("C1: a fully clean, correctly-dispatching run reports PASS (exit 0)", () => {
  const results = ARMS.map((arm) => makeResult(arm.name));
  const verdict = judgeIsolationResults(results);
  assert.deepEqual(verdict, { exitCode: 0, verdict: "PASS", reasons: [] });
});

test("C2: an expectDispatch arm reporting cullDispatches=0 refuses STRUCTURAL (exit 3), naming the arm", () => {
  const dispatchArm = ARMS.find((arm) => arm.expectDispatch);
  const results = ARMS.map((arm) =>
    arm.name === dispatchArm.name
      ? makeResult(arm.name, { stats: { cullDispatches: 0 } })
      : makeResult(arm.name),
  );
  const verdict = judgeIsolationResults(results);
  assert.equal(verdict.exitCode, 3);
  assert.equal(verdict.verdict, "STRUCTURAL");
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], new RegExp(dispatchArm.name));
  assert.match(verdict.reasons[0], /cullDispatches=0/);
});

test("C3: a black-frame/validation regression reports FAIL (exit 1), outranking a STRUCTURAL refusal on another arm", () => {
  const dispatchArm = ARMS.find((arm) => arm.expectDispatch);
  const otherArm = ARMS.find((arm) => arm.name !== dispatchArm.name);
  const results = ARMS.map((arm) => {
    if (arm.name === dispatchArm.name) {
      // This arm is ALSO missing its dispatch — a pure-STRUCTURAL case would
      // report exit 3 for it. FAIL from the other arm must still win.
      return makeResult(arm.name, { stats: { cullDispatches: 0 } });
    }
    if (arm.name === otherArm.name) {
      return makeResult(arm.name, {
        nonBlackPct: 0,
        validationErrorCount: 1,
      });
    }
    return makeResult(arm.name);
  });
  const verdict = judgeIsolationResults(results);
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.verdict, "FAIL");
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], new RegExp(otherArm.name));
});

test("C4: a per-arm harness error reports HARNESS FAULT (exit 2), outranking everything", () => {
  const [first, ...rest] = ARMS;
  const results = [
    { name: first.name, error: "page crashed" },
    ...rest.map((arm) => makeResult(arm.name)),
  ];
  const verdict = judgeIsolationResults(results);
  assert.equal(verdict.exitCode, 2);
  assert.equal(verdict.verdict, "HARNESS FAULT");
  assert.match(verdict.reasons[0], /page crashed/);
});

test("C5: a result naming an arm absent from ARMS is a harness fault, not a silent skip", () => {
  const results = [makeResult(ARMS[0].name), { name: "not-a-real-arm" }];
  const verdict = judgeIsolationResults(results);
  assert.equal(verdict.exitCode, 2);
  assert.match(verdict.reasons[0], /not-a-real-arm/);
});

/**
 * Builds the exact per-arm result set the banked pre-render-pass-bracket
 * evidence recorded (`probe-gpucull-blackframe-isolation.mjs`'s file
 * header): `n256/n320/n384-always` and `n600-auto-recheck` clean with zero
 * dispatches, `n448/n600-always` dispatching. This is a HEALTHY build's
 * result set — the boundary arm never dispatched even before the render-pass
 * bracket fix landed, which is only possible if its post-frustum-cull count
 * never reached the threshold.
 *
 * @returns {Array<object>} One result per `ARMS` entry.
 */
function healthyPreBracketResults() {
  const dispatchingArmNames = new Set(["n448-always", "n600-always"]);
  return ARMS.map((arm) =>
    makeResult(arm.name, {
      stats: {
        cullDispatches: dispatchingArmNames.has(arm.name) ? 1 : 0,
      },
    }),
  );
}

const GATE_LIB_PATH = resolve(
  directory,
  "lib/gpucull-blackframe-isolation-gate.mjs",
);

test("C6: the n384-always boundary arm reporting the banked healthy zero-dispatch result does not refuse STRUCTURAL", () => {
  const boundaryArm = ARMS.find((arm) => arm.name === "n384-always");
  assert.ok(boundaryArm, "the n384-always boundary arm must exist in ARMS");
  assert.equal(
    boundaryArm.expectDispatch,
    false,
    "n384-always's post-frustum-cull count is demonstrably below " +
      "GPU_CULL_THRESHOLD_HI (see the gate module's header for the banked " +
      "evidence) — expectDispatch must not be derived from the raw " +
      "n >= HI comparison alone",
  );
  const verdict = judgeIsolationResults(healthyPreBracketResults());
  assert.deepEqual(
    verdict,
    { exitCode: 0, verdict: "PASS", reasons: [] },
    "a healthy build matching the banked pre-render-pass-bracket evidence " +
      "(boundary arm never dispatches) must PASS, not refuse STRUCTURAL",
  );
});

// Mutation check (CLAUDE.md Principle 10 / SR-7): revert the gate module's
// margin fix (`n > GPU_CULL_THRESHOLD_HI`) back to the inclusive comparison
// it replaced, on an in-memory copy — the file on disk is never touched,
// same technique as `build-source-identity.spec.mjs`'s suffix-match mutant
// — and require C6's exact scenario to regress to the false STRUCTURAL
// refusal this fix round exists to close.
test("C6 MUTATION control: reverting the margin fix reproduces the false STRUCTURAL refusal on a healthy build", async () => {
  const original = await readFile(GATE_LIB_PATH, "utf8");
  const anchor =
    'expectDispatch: arm.hint === "always" && arm.n > GPU_CULL_THRESHOLD_HI,';
  const mutatedLine =
    'expectDispatch: arm.hint === "always" && arm.n >= GPU_CULL_THRESHOLD_HI,';
  assert.ok(
    original.includes(anchor),
    "the mutation anchor must exist in the live source, or this mutation " +
      "is not exercising the real derivation",
  );
  const mutatedSource = original.replace(anchor, mutatedLine);
  assert.notEqual(
    mutatedSource,
    original,
    "the mutation must actually change the source",
  );

  const scratchDir = await mkdtemp(
    join(tmpdir(), "gpucull-isolation-gate-mutant-"),
  );
  try {
    const mutantPath = join(
      scratchDir,
      "gpucull-blackframe-isolation-gate.mutant.mjs",
    );
    await writeFile(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);

    const boundaryArm = mutant.ARMS.find((arm) => arm.name === "n384-always");
    assert.equal(
      boundaryArm.expectDispatch,
      true,
      "the mutant's reverted (>=) comparison must flip the boundary arm's " +
        "expectDispatch back to true, or this mutation does not reproduce " +
        "the original defect",
    );

    const dispatchingArmNames = new Set(["n448-always", "n600-always"]);
    const results = mutant.ARMS.map((arm) => ({
      name: arm.name,
      n: arm.n,
      hint: arm.hint,
      stats: {
        cullDispatches: dispatchingArmNames.has(arm.name) ? 1 : 0,
      },
      nonBlackPct: 100,
      validationErrorCount: 0,
    }));
    const verdict = mutant.judgeIsolationResults(results);
    assert.equal(
      verdict.exitCode,
      3,
      "with the margin fix reverted, the banked healthy pre-bracket " +
        "result set must regress to a STRUCTURAL refusal on n384-always " +
        "— if it does not, C6 is not anchored to the margin fix",
    );
    assert.equal(verdict.verdict, "STRUCTURAL");
    assert.match(verdict.reasons[0], /n384-always/);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
});

// Mutation check (CLAUDE.md Principle 10): a judge that only checks
// `validationErrorCount` (ignoring `nonBlackPct === 0`) would miss a
// validation-error-free black frame. Prove both signals are read.
test("mutant check: a black frame with zero validation errors still reports FAIL", () => {
  const arm = ARMS.find((entry) => !entry.expectDispatch) ?? ARMS[0];
  const results = ARMS.map((entry) =>
    entry.name === arm.name
      ? makeResult(entry.name, { nonBlackPct: 0, validationErrorCount: 0 })
      : makeResult(entry.name),
  );
  const verdict = judgeIsolationResults(results);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.reasons[0], new RegExp(arm.name));
});
