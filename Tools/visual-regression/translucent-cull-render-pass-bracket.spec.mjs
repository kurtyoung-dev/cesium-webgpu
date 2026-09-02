// translucent-cull-render-pass-bracket.spec.mjs — browser-free contract for
// the translucent GPU-cull render-pass bracket (Q-20 / Q-48 / Q-50). Pure
// Node: no browser, no GPU, no build.
//
// @purpose Pins that `WebGPUSceneRenderer#_maybeGPUCullTranslucent` ends the open scene render pass before dispatching the translucent GPU-cull compute pass and resumes it afterward, exactly like the verbatim opaque-pass bracket.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// Q-20 found `gpuCullCommandsForTranslucent`'s `beginComputePass` dispatch
// reached, through `_maybeGPUCullTranslucent`, with no
// `endCurrentRenderPass()` / `_resumeScenePass()` bracket around the call
// site — unlike the opaque-pass cull call site in `_executeOpaquePass`,
// which carries the identical bracket. WebGPU refuses `beginComputePass` on
// an encoder that still has an open `RenderPassEncoder`
// ("CommandEncoder is locked while RenderPassEncoder is open"), and the
// scene render pass IS open at this call site (the frustum loop has already
// opened it for the opaque/translucent draws in this frustum) — so every
// scene that reaches the translucent cull gate (`Scene.gpuCullingHint ===
// 'always'` and the translucent command count crosses the shared
// `GPU_CULL_THRESHOLD_HI` gate) hit that validation error and blanked the
// frame, reported separately as Q-48. Q-50 (a Hi-Z latch pixel leg) was
// blocked transitively: its own scene reaches the same crash path once
// `gpuCullingHint` is forced on.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// `WebGPUSceneRenderer.ts` is bundled with esbuild through the shared
// stub-dependency bundler (`lib/engine-stub-bundler.mjs`): the file itself is
// real, every one of its ~25 sibling-module imports is replaced with an
// inert Proxy stub. `_maybeGPUCullTranslucent` and `gpuCullCommandsForTranslucent`
// reach nothing through those imports (verified by reading both methods —
// they touch only `this`, `config`, `commands`, and WebGPU-shaped objects
// this file constructs), so stubbing the rest of the renderer graph changes
// nothing the assertions below observe.
//
// The fixture models the WebGPU command-encoder's own pass-exclusivity
// invariant directly: a `_currentRenderPassEncoder` slot on a fake context,
// started OPEN (as it is at the real call site), an `endCurrentRenderPass`
// that nulls it, a `resumeDefaultRenderPass` that reopens it, and a fake
// translucent culler whose `dispatch` records whether the slot was open AT
// THE MOMENT it fired — the exact precondition the real WebGPU
// `beginComputePass` validates. The real `WebGPUSceneRenderer.prototype`
// methods run unmodified (`Object.create` + `.call`, never a hand-copied
// fragment): `_maybeGPUCullTranslucent`, `gpuCullCommandsForTranslucent`,
// `_updateActivationGate`, and `_resumeScenePass` (steered onto its
// `resumeDefaultRenderPass` fallback branch by leaving `_sceneFramebuffer`
// unset — the same fallback the opaque-pass bracket relies on when no scene
// framebuffer exists yet).
//
// A1 pins the ordering behaviour on the current source. A2 is the inertness
// mutant (Principle 10 / SR-7): `mutateOrFail` wraps the two bracket
// statements in `if (false) { ... }` on a COPY of the real source (the file
// on disk is never touched), re-runs the SAME assertion helper, and requires
// it to fail — proving the assertion is actually anchored to the fix and not
// satisfiable by construction.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the source is
// LF-normalised before bundling and before anchor matching.
//
// Run: node --test Tools/visual-regression/translucent-cull-render-pass-bracket.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";

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
 * Wraps the two bracket statements `_maybeGPUCullTranslucent` uses to keep
 * the translucent GPU-cull dispatch off an open render pass in
 * `if (false) { ... }` — inert, never deleted (Principle 10 / SR-7). Applied
 * to a COPY of the source passed to `bundle`'s `mutate` option; the file on
 * disk is untouched.
 *
 * @param {string} source LF-normalised `WebGPUSceneRenderer.ts` source.
 * @returns {string} The mutated source.
 */
function stripTranslucentCullBracket(source) {
  let out = source.replace(
    "const wgpuCtx = config.context;\n    wgpuCtx.endCurrentRenderPass?.();\n",
    "const wgpuCtx = config.context;\n    if (false) {\n      wgpuCtx.endCurrentRenderPass?.();\n    }\n",
  );
  out = out.replace(
    "this._resumeScenePass(wgpuCtx);\n    if (filtered === commands) {",
    "if (false) {\n      this._resumeScenePass(wgpuCtx);\n    }\n    if (filtered === commands) {",
  );
  return out;
}

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
    label: "strip translucent-cull render-pass bracket",
  });
  return namespace.WebGPUSceneRenderer;
}

/**
 * A minimal fake `WebGPUContext` sufficient for
 * `_maybeGPUCullTranslucent` → `gpuCullCommandsForTranslucent` →
 * `_resumeScenePass`'s no-scene-framebuffer fallback. Models the real
 * command-encoder's pass-exclusivity invariant: `_currentRenderPassEncoder`
 * starts OPEN (matching the real call site, reached mid-frustum with the
 * scene render pass already active), `endCurrentRenderPass` closes it,
 * `resumeDefaultRenderPass` reopens it. `events` records call order plus,
 * for `dispatch`, whether the pass was open at the moment it fired.
 *
 * @returns {{context: object, events: Array<string>}} The fake context and
 *   its shared event log.
 */
function makeFakeContext() {
  const events = [];
  const OPEN_PASS = { __kind: "fakeRenderPassEncoder" };
  const context = {
    _currentRenderPassEncoder: OPEN_PASS,
    _currentCommandEncoder: { __kind: "fakeCommandEncoder" },
    endCurrentRenderPass() {
      events.push("endCurrentRenderPass");
      context._currentRenderPassEncoder = null;
    },
    resumeDefaultRenderPass() {
      events.push("resumeDefaultRenderPass");
      context._currentRenderPassEncoder = OPEN_PASS;
    },
    gpuCullerTranslucent: {
      initialized: true,
      uploadBoundingSpheres() {},
      uploadFrustumPlanes() {},
      dispatch() {
        events.push("dispatch");
        events.push(
          context._currentRenderPassEncoder === null
            ? "dispatch-saw-pass-closed"
            : "dispatch-saw-pass-OPEN",
        );
      },
      prepareReadback() {},
      readResults() {
        // Never resolves within the synchronous call this spec drives —
        // `gpuCullCommandsForTranslucent`'s `.then()` handler runs on a
        // later microtask this test does not need (it only exercises the
        // synchronous dispatch-ordering path, matching every real frame
        // before the first readback lands).
        return new Promise(() => {});
      },
    },
  };
  return { context, events };
}

/**
 * Builds the `commands` / `count` / `config` arguments
 * `_maybeGPUCullTranslucent` reads, sized to cross
 * `GPU_CULL_THRESHOLD_HI` (384) with headroom above the hysteresis LO (192)
 * gate so the translucent cull activates on the very first call.
 *
 * @param {object} context The fake context from {@link makeFakeContext}.
 * @param {number} count Translucent command count.
 * @returns {{commands: Array<object>, count: number, config: object}} Args.
 */
function makeCullInputs(context, count) {
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
      gpuCullingHint: "always",
      _frameState: { cullingVolume: { planes } },
    },
  };
  return { commands, count, config };
}

/**
 * Constructs a bare `WebGPUSceneRenderer` instance (`Object.create`, never
 * `new` — the constructor allocates real GPU/scene resources this spec has
 * no use for) with exactly the instance fields the exercised methods read,
 * so every method call below runs the REAL prototype implementation.
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
  // `_resumeScenePass`'s no-scene-framebuffer branch is the one every
  // instance of this fixture takes — leaving it unset steers the REAL
  // method onto `context.resumeDefaultRenderPass?.()`, the same fallback
  // the opaque-pass bracket relies on before the scene framebuffer exists.
  renderer._sceneFramebuffer = undefined;
  return renderer;
}

/**
 * Drives `_maybeGPUCullTranslucent` on a fresh fixture and returns the fake
 * context's event log, so both the nominal test and the mutation control
 * exercise the identical call shape.
 *
 * @param {Function} WebGPUSceneRenderer The bundled class.
 * @returns {{events: Array<string>, result: {commands: Array, count: number}}}
 */
function driveTranslucentCull(WebGPUSceneRenderer) {
  const { context, events } = makeFakeContext();
  const { commands, count, config } = makeCullInputs(context, 500);
  const renderer = makeBareRenderer(WebGPUSceneRenderer);
  const result = WebGPUSceneRenderer.prototype._maybeGPUCullTranslucent.call(
    renderer,
    commands,
    count,
    config,
  );
  return { events, result, context };
}

test("A1: the translucent cull closes the render pass before dispatch and reopens it after", async () => {
  const WebGPUSceneRenderer = await importSceneRenderer();
  const { events, context } = driveTranslucentCull(WebGPUSceneRenderer);

  assert.deepEqual(
    events,
    [
      "endCurrentRenderPass",
      "dispatch",
      "dispatch-saw-pass-closed",
      "resumeDefaultRenderPass",
    ],
    "the render pass must close before the compute dispatch and reopen " +
      "after it — the exact ordering WebGPU's own pass-exclusivity rule " +
      "requires, and the opaque-pass cull call site already follows",
  );
  assert.notEqual(
    context._currentRenderPassEncoder,
    null,
    "the scene render pass must be reopened before control returns to the " +
      "translucent-pass caller (OIT accumulation / back-to-front sort)",
  );
});

test("A2 MUTATION: stripping the bracket makes the dispatch see an open pass", async () => {
  const WebGPUSceneRenderer = await importSceneRenderer(
    stripTranslucentCullBracket,
  );
  const { events } = driveTranslucentCull(WebGPUSceneRenderer);

  assert.notDeepEqual(
    events,
    [
      "endCurrentRenderPass",
      "dispatch",
      "dispatch-saw-pass-closed",
      "resumeDefaultRenderPass",
    ],
    "A1's exact ordering assertion must fail against the mutated source — " +
      "if it still matches, the mutant did not reach the code A1 pins",
  );
  assert.ok(
    events.includes("dispatch-saw-pass-OPEN"),
    "with the bracket stripped, the compute dispatch must observe the " +
      "render pass still open — the exact validation-error precondition " +
      "Q-48 reported ('CommandEncoder locked while RenderPassEncoder is " +
      "open'). If this assertion does not fire, A1 is not anchored to the " +
      "fix it claims to pin",
  );
  assert.ok(
    !events.includes("endCurrentRenderPass"),
    "the mutant must make the close call unreachable, not merely reorder it",
  );
  assert.ok(
    !events.includes("resumeDefaultRenderPass"),
    "the mutant must make the resume call unreachable, not merely reorder it",
  );
});

test("mutateOrFail rejects an identity rewrite (control for the A2 harness)", () => {
  assert.throws(
    () => mutateOrFail(SCENE_RENDERER_SOURCE, (source) => source, "identity"),
    { name: "AssertionError" },
    "an anchor that changes nothing must fail loudly rather than let A2 " +
      "pass vacuously",
  );
});
