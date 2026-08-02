// NEW-WEBGPU-ENV-PASS-DROP (background-clear member) — Node spec for the two
// pure decisions that together determine whether `scene.backgroundColor`
// reaches the WebGPU framebuffer on a frame with no content.
//
// WHAT WAS ACTUALLY WRONG (traced, not assumed)
// ---------------------------------------------
// The machine bisection put the transition exactly at `scene.sun.show = false`
// with all other environment content already hidden. The tempting reading is
// that `hasInjectedEnvironmentContent` under-reports there. It does not — and
// PART A of this spec is the evidence: with every environment element off, the
// frame genuinely has nothing to inject, the predicate correctly returns false,
// and zero frustums is the CORRECT outcome. Manufacturing a frustum to carry a
// clear would pay a full per-frustum scaffold for an empty pass.
//
// The defect is one level down, in the clear path:
//
//   `FramebufferOrchestrator.updateAndClearFramebuffers` hands the background
//   `ClearCommand` to `WebGPUContext.updateAndClearFramebuffers`, which
//   executes it. `WebGPUContext.clear` then DROPS it — the C9-07 / FAR-405-C0
//   deferred-canvas-clear return fires because no pass is active and the canvas
//   is untouched, on the premise that the pending first open "delivers the same
//   `_clearColor` / `_clearDepth` / `_clearStencil` values". Nothing ever wrote
//   `_clearColor` from a clear command (WebGL does this implicitly via
//   `gl.clearColor` in `Renderer/Context.js`), so it stayed at its constructor
//   value — transparent black — for the life of the context. On a zero-frustum
//   frame `WebGPUSceneRenderer.executeCommands` early-returns before the
//   scene-framebuffer pass — the only other consumer of
//   `frameState.backgroundColor` — ever opens, so the `endFrame` present
//   fallback is the sole writer of the canvas and it presents that transparent
//   black.
//
//   (Line references were deliberately dropped when this was extracted onto
//   main on 2026-08-01. The original cited `WebGPUContext.ts:3828-3835` etc.
//   against a tree ~28 batches older; every one of those numbers had drifted.
//   PART D pins the same facts by SHAPE, which does not rot.)
//
// PART B tests the fix module (`WebGPUCanvasClearState`) directly. PART B'
// pins its absence contract. PART C drives the frame timeline through it.
// PART D pins the call-site wiring, since a correct module that nothing calls
// fixes nothing.
//
// SCOPE HONESTY: parts A/B execute REAL engine source. Part C models the frame
// timeline in this file and feeds it the real module — the decision under test
// is real, the surrounding sequence is a model. Cross-backend pixel behaviour is
// gated by `probe-env-background-clear.mjs`, not here.
//
// Run: node --test Tools/visual-regression/env-background-clear.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const enginePath = (relative) =>
  resolve(directory, "../../packages/engine/Source", relative);

// Both modules are TypeScript bundled into the engine barrel (no per-file JS
// build output), so they are transpiled with esbuild and imported from a data:
// URL — the pattern established by `env-frustum-demand.spec.mjs` and
// `attachment-demand-registry.spec.mjs`.
async function importEngineModule(relative) {
  const tsSource = await readFile(enginePath(relative), "utf8");
  const { code } = await transform(tsSource, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const { hasInjectedEnvironmentContent, needsEnvironmentOnlyFrustum } =
  await importEngineModule("Scene/EnvironmentFrustumDemand.ts");
const {
  canvasClearStateUpdate,
  isClearChannelRequested,
  hasCanvasClearStateUpdate,
  NO_CANVAS_CLEAR_STATE_UPDATE,
} = await importEngineModule("Renderer/WebGPU/WebGPUCanvasClearState.ts");

// Read as TEXT (not just imported) because PART B'6 pins the module's stated
// contract, and a contract nobody wrote down is what produced the caveat.
const clearStateSource = await readFile(
  enginePath("Renderer/WebGPU/WebGPUCanvasClearState.ts"),
  "utf8",
);

const SENTINEL_NEAR = Number.MAX_VALUE;
const SENTINEL_FAR = -Number.MAX_VALUE;

const drawCommand = () => ({ execute() {} });

// ───────────────────────────────────────────────────────────────────────────
// PART A — the predicate is NOT the defect.
//
// The bisection axes, mapped onto what `_environmentState` actually holds:
//   sun        on  -> `sunDrawCommand` + `isSunVisible`
//   skybox     on  -> `skyBoxCommand` (inject-only; no binned copy)
//   starfield  visible -> `starFieldCommand` present.
//              faded   -> ABSENT. The daytime fade is what removes the command
//              entirely, which is exactly why the star field could not be
//              relied on to keep a frustum alive (C12-G1F1, Batch 756).
//   atmosphere on  -> `skyAtmosphereCommand` + `isSkyAtmosphereVisible`
// ───────────────────────────────────────────────────────────────────────────

function makeInjectionScene() {
  return {
    _alternateSceneRenderer: {},
    _environmentState: {
      skyBoxCommand: undefined,
      starFieldCommand: undefined,
      skyAtmosphereCommand: undefined,
      sunDrawCommand: undefined,
      moonCommand: undefined,
      isSkyAtmosphereVisible: false,
      isSunVisible: false,
      isMoonVisible: false,
    },
    _frameState: {
      passes: { render: true },
      panoramaCommandList: [],
    },
  };
}

const BISECTION_AXES = {
  sun: (scene) => {
    scene._environmentState.sunDrawCommand = drawCommand();
    scene._environmentState.isSunVisible = true;
  },
  skybox: (scene) => {
    scene._environmentState.skyBoxCommand = drawCommand();
  },
  starfieldVisible: (scene) => {
    scene._environmentState.starFieldCommand = drawCommand();
  },
  atmosphere: (scene) => {
    scene._environmentState.skyAtmosphereCommand = drawCommand();
    scene._environmentState.isSkyAtmosphereVisible = true;
  },
};

test("A1: sun x skybox x starfield x atmosphere — demand iff any content exists", () => {
  const names = Object.keys(BISECTION_AXES);
  let sawTrue = 0;
  let sawFalse = 0;
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const scene = makeInjectionScene();
    const on = [];
    for (let bit = 0; bit < names.length; bit++) {
      if (mask & (1 << bit)) {
        BISECTION_AXES[names[bit]](scene);
        on.push(names[bit]);
      }
    }
    const expected = on.length > 0;
    assert.equal(
      hasInjectedEnvironmentContent(scene),
      expected,
      `cell {${on.join(",") || "all-off"}}: demand mismatch`,
    );
    assert.equal(
      needsEnvironmentOnlyFrustum(SENTINEL_NEAR, SENTINEL_FAR, false, scene),
      expected,
      `cell {${on.join(",") || "all-off"}}: frustum restore mismatch`,
    );
    if (expected) {
      sawTrue++;
    } else {
      sawFalse++;
    }
  }
  // Non-vacuity: the matrix must exercise BOTH answers, or it proves nothing.
  assert.equal(sawTrue, 15);
  assert.equal(sawFalse, 1);
});

test("A2: the bisection transition step is a correct 'false', not an under-report", () => {
  // The exact state at the observed transition: everything already hidden, and
  // the sun — the last element still emitting — turned off.
  const beforeSunOff = makeInjectionScene();
  BISECTION_AXES.sun(beforeSunOff);
  assert.equal(hasInjectedEnvironmentContent(beforeSunOff), true);

  const afterSunOff = makeInjectionScene();
  assert.equal(
    hasInjectedEnvironmentContent(afterSunOff),
    false,
    "with every element off there is genuinely nothing to inject",
  );
  assert.equal(
    needsEnvironmentOnlyFrustum(
      SENTINEL_NEAR,
      SENTINEL_FAR,
      false,
      afterSunOff,
    ),
    false,
    "so zero frustums is the CORRECT outcome — the background clear must not " +
      "depend on a frustum existing",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// PART B — the clear-state contract (the actual fix).
// ───────────────────────────────────────────────────────────────────────────

const WHITE = { red: 1, green: 1, blue: 1, alpha: 1 };
const TRANSPARENT_BLACK = { red: 0, green: 0, blue: 0, alpha: 0 };

test("B1: a canvas-targeted color clear is captured", () => {
  const update = canvasClearStateUpdate({ color: WHITE, stencil: 0 }, true);
  assert.deepEqual(update.color, WHITE);
  assert.equal(update.stencil, 0, "stencil 0 is a value, not an absence");
  assert.equal(update.depth, null, "depth was not part of this clear");
});

test("B2: an offscreen-framebuffer clear never redefines the canvas", () => {
  const update = canvasClearStateUpdate({ color: WHITE }, false);
  assert.equal(update.color, null);
  assert.equal(update.depth, null);
  assert.equal(update.stencil, null);
});

test("B3: `false` means do-not-clear; 0 means clear-to-zero", () => {
  assert.equal(isClearChannelRequested(false), false);
  assert.equal(isClearChannelRequested(undefined), false);
  assert.equal(isClearChannelRequested(0), true);
  assert.equal(isClearChannelRequested(TRANSPARENT_BLACK), true);

  const update = canvasClearStateUpdate(
    { color: false, depth: 0, stencil: false },
    true,
  );
  assert.equal(update.color, null, "an explicit color:false must not capture");
  assert.equal(update.depth, 0, "depth 0 is a requested value");
  assert.equal(update.stencil, null);
});

test("B4: missing / empty requests are safe", () => {
  for (const request of [undefined, null, {}]) {
    const update = canvasClearStateUpdate(request, true);
    assert.equal(update.color, null);
    assert.equal(update.depth, null);
    assert.equal(update.stencil, null);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PART B' — the ABSENCE CONTRACT.
//
// Recorded caveat at extraction (2026-08-01): the module used `undefined`,
// `false` and `null` for absence across its two halves without stating which
// meant what. Three spellings of "nothing here" in one 130-line module is how a
// caller ends up writing `if (update.color)` and silently dropping a legitimate
// transparent-black capture — which is EXACTLY the value this whole fix exists
// to stop dropping.
//
// The contract is now: INPUT is tri-state (`T | false | undefined`, inherited
// from `ClearCommand` and not this module's choice), collapsed in exactly ONE
// place; OUTPUT is two-state with `null` as the sole absence sentinel and
// `undefined` never appearing. These tests are that contract's teeth.
// ───────────────────────────────────────────────────────────────────────────

const CHANNELS = ["color", "depth", "stencil"];

test("B'1: every returned field is a value or null — `undefined` never appears", () => {
  // The whole point of picking one sentinel. If a field can be `undefined`, a
  // caller's `!== null` test passes on an absent channel and writes garbage.
  const cases = [
    [{ color: WHITE, depth: 0, stencil: 0 }, true],
    [{ color: false, depth: false, stencil: false }, true],
    [{}, true],
    [{ color: WHITE }, false],
    [undefined, true],
    [null, true],
    [undefined, false],
  ];
  for (const [request, targetsCanvas] of cases) {
    const update = canvasClearStateUpdate(request, targetsCanvas);
    for (const channel of CHANNELS) {
      assert.ok(
        channel in update,
        `${channel} key missing for ${JSON.stringify(request)} — a missing key ` +
          `is indistinguishable from an absent value to \`in\`-based callers`,
      );
      assert.notEqual(
        update[channel],
        undefined,
        `${channel} is \`undefined\` for ${JSON.stringify(request)}; \`null\` is ` +
          `the only permitted absence in the output contract`,
      );
    }
  }
});

test("B'2: `false` and `undefined` on INPUT both collapse to `null` on OUTPUT", () => {
  // The two input spellings of not-requested must be indistinguishable
  // downstream — that is what "collapsed in exactly one place" buys.
  const fromFalse = canvasClearStateUpdate(
    { color: false, depth: false, stencil: false },
    true,
  );
  const fromUndefined = canvasClearStateUpdate(
    { color: undefined, depth: undefined, stencil: undefined },
    true,
  );
  assert.deepEqual(fromFalse, fromUndefined);
  assert.deepEqual(fromFalse, { color: null, depth: null, stencil: null });
});

test("B'3: falsy-but-real values survive — the bug a truthiness test would cause", () => {
  // `{r:0,g:0,b:0,a:0}` and `0` are all falsy in a `if (update.x)` test. Each is
  // a legitimate captured value, and dropping the first is the original defect.
  const update = canvasClearStateUpdate(
    { color: TRANSPARENT_BLACK, depth: 0, stencil: 0 },
    true,
  );
  assert.deepEqual(update.color, TRANSPARENT_BLACK);
  assert.equal(update.depth, 0);
  assert.equal(update.stencil, 0);
  for (const channel of CHANNELS) {
    assert.notEqual(
      update[channel],
      null,
      `${channel} was captured but reads as absent`,
    );
  }
  assert.equal(hasCanvasClearStateUpdate(update), true);
});

test("B'4: the canonical empty value is the shape a no-capture actually returns", () => {
  assert.deepEqual(
    canvasClearStateUpdate(undefined, true),
    NO_CANVAS_CLEAR_STATE_UPDATE,
  );
  assert.deepEqual(
    canvasClearStateUpdate({ color: WHITE }, false),
    NO_CANVAS_CLEAR_STATE_UPDATE,
  );
  assert.equal(hasCanvasClearStateUpdate(NO_CANVAS_CLEAR_STATE_UPDATE), false);
  // And it is frozen, so a caller cannot corrupt the shared constant.
  assert.ok(Object.isFrozen(NO_CANVAS_CLEAR_STATE_UPDATE));
});

test("B'5: hasCanvasClearStateUpdate agrees with the per-channel nulls", () => {
  const partial = canvasClearStateUpdate({ depth: 1 }, true);
  assert.equal(hasCanvasClearStateUpdate(partial), true);
  assert.equal(partial.color, null);
  assert.equal(partial.depth, 1);
  assert.equal(
    hasCanvasClearStateUpdate(canvasClearStateUpdate({}, true)),
    false,
  );
});

test("B'6: the module DOCUMENTS the contract, not just implements it", () => {
  // The caveat was that the two halves disagreed silently. A future edit that
  // reintroduces an undocumented third spelling should trip here, because the
  // fix was as much "say which one" as "pick one".
  assert.ok(
    /ABSENCE HAS EXACTLY TWO SPELLINGS/.test(clearStateSource),
    "the absence contract section is gone from WebGPUCanvasClearState",
  );
  assert.ok(
    /ClearChannelSlot/.test(clearStateSource),
    "the input tri-state is no longer named",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// PART C — the frame timeline, driven by the real module.
//
// MODEL BOUNDARY: the sequence below is written here; every decision inside it
// comes from the imported engine module. `capture: false` reproduces the
// pre-fix engine (the deferral with no state capture) and exists ONLY to show
// the harness can distinguish the two states — it is not an assertion that the
// broken behaviour is desirable.
// ───────────────────────────────────────────────────────────────────────────

function simulateWebGPUFrame({
  backgroundColor,
  sceneWritesCanvas,
  capture = true,
}) {
  // Context clear-state, as `WebGPUContext` holds it. Constructor value is
  // transparent black (`WebGPUContext.ts:1051`).
  const state = {
    clearColor: { ...TRANSPARENT_BLACK },
    clearDepth: 1.0,
    clearStencil: 0,
  };
  // `beginFrame` acquires the swap view and resets the touched flags; C9-07
  // means NO render pass is opened here.
  let canvasColorTouched = false;

  // `WebGPUContext.updateAndClearFramebuffers` executes
  // `scene._clearColorCommand` (color + stencil; Scene.js:341-345).
  const backgroundClear = { color: backgroundColor, stencil: 0 };
  if (capture) {
    const update = canvasClearStateUpdate(backgroundClear, true);
    if (update.color !== null) {
      state.clearColor = { ...update.color };
    }
    if (update.depth !== null) {
      state.clearDepth = update.depth;
    }
    if (update.stencil !== null) {
      state.clearStencil = update.stencil;
    }
  }
  // ...and the deferred-canvas-clear return then drops the clear itself: no
  // active pass, canvas untouched. Unchanged by the fix.

  // `WebGPUSceneRenderer.executeCommands`: a frame with frustums opens the
  // scene-FB pass (cleared to `frameState.backgroundColor`) and the
  // post-process chain blits it, marking the canvas touched. A zero-frustum
  // frame with no environmental-effect demand early-returns and touches
  // nothing.
  let presented = null;
  if (sceneWritesCanvas) {
    canvasColorTouched = true;
    presented = { ...backgroundColor };
  }

  // `endFrame` present fallback — `_beginDefaultRenderPass` clears the swap
  // texture to `_clearColor`.
  if (!canvasColorTouched) {
    presented = { ...state.clearColor };
  }
  return { presented, clearState: state };
}

test("C1: TEETH — a zero-frustum frame presents scene.backgroundColor", () => {
  const { presented } = simulateWebGPUFrame({
    backgroundColor: WHITE,
    sceneWritesCanvas: false,
  });
  assert.deepEqual(
    presented,
    WHITE,
    "the present fallback must deliver the requested background; this is the " +
      "assertion that fails if `canvasClearStateUpdate` stops capturing",
  );
});

test("C2: TEETH — the black/white background control response is ~1", () => {
  // The executor's bisection metric, reduced to its decisive quantity:
  // meanWhite - meanBlack over a frame that is entirely background.
  const meanOf = (c) =>
    (0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue) * c.alpha;
  const black = simulateWebGPUFrame({
    backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
    sceneWritesCanvas: false,
  }).presented;
  const white = simulateWebGPUFrame({
    backgroundColor: WHITE,
    sceneWritesCanvas: false,
  }).presented;
  const response = meanOf(white) - meanOf(black);
  assert.ok(
    response > 0.99,
    `background control response must be ~1, got ${response}`,
  );
});

test("C3: the harness can see the pre-fix state (negative control)", () => {
  // Same frame, capture bypassed = the engine before the fix. If this produced
  // the background too, C1/C2 would be structurally incapable of failing.
  const { presented } = simulateWebGPUFrame({
    backgroundColor: WHITE,
    sceneWritesCanvas: false,
    capture: false,
  });
  assert.deepEqual(
    presented,
    TRANSPARENT_BLACK,
    "without the capture the fallback presents transparent black — this is " +
      "the reproduced defect, and its inequality with C1 is what gives C1 teeth",
  );
});

test("C4: frames that DO have content are untouched by the fix", () => {
  for (const capture of [true, false]) {
    const { presented } = simulateWebGPUFrame({
      backgroundColor: WHITE,
      sceneWritesCanvas: true,
      capture,
    });
    assert.deepEqual(
      presented,
      WHITE,
      "the scene-FB clear + post-process blit already carried the background",
    );
  }
});

test("C5: an offscreen clear cannot repaint the canvas background", () => {
  // e.g. an OIT / globe-depth accumulation clear. Capture must be canvas-only.
  const state = { clearColor: { ...TRANSPARENT_BLACK } };
  const update = canvasClearStateUpdate({ color: WHITE }, false);
  if (update.color !== null) {
    state.clearColor = { ...update.color };
  }
  assert.deepEqual(state.clearColor, TRANSPARENT_BLACK);
});

// ───────────────────────────────────────────────────────────────────────────
// PART D — call-site wiring. A correct module nothing calls fixes nothing, and
// a capture placed AFTER the deferral return would be dead code.
// ───────────────────────────────────────────────────────────────────────────

const contextSource = await readFile(
  enginePath("Renderer/WebGPU/WebGPUContext.ts"),
  "utf8",
);

test("D1: WebGPUContext imports the clear-state module", () => {
  assert.ok(
    contextSource.includes('from "./WebGPUCanvasClearState.js"'),
    "WebGPUContext must import the clear-state contract",
  );
});

test("D2: TEETH — the capture runs BEFORE the deferred-clear early return", () => {
  const callIndex = contextSource.indexOf("= canvasClearStateUpdate(");
  const deferralIndex = contextSource.indexOf("!hadActivePass &&");
  assert.ok(callIndex > 0, "no `canvasClearStateUpdate` call site in clear()");
  assert.ok(deferralIndex > 0, "deferred-canvas-clear guard not found");
  assert.ok(
    callIndex < deferralIndex,
    "the capture must precede the deferral return, or the background clear is " +
      "dropped before its value is ever recorded",
  );
});

test("D3: the capture writes the three clear-state fields", () => {
  for (const field of ["_clearColor", "_clearDepth", "_clearStencil"]) {
    assert.ok(
      contextSource.includes(`this.${field} =`) ||
        contextSource.includes(`${field})`),
      `clear-state field ${field} is not written from the capture`,
    );
  }
});

test("D4: the present fallback still sources its clearValue from _clearColor", () => {
  // If `_beginDefaultRenderPass` ever hardcodes its clear value, the captured
  // state stops reaching the canvas and the fix silently dies.
  assert.ok(
    contextSource.includes("r: this._clearColor.red"),
    "_beginDefaultRenderPass must clear to the captured `_clearColor`",
  );
  assert.ok(
    contextSource.includes(
      'this._beginDefaultRenderPass("Canvas Demand Clear Pass")',
    ),
    "the endFrame present fallback must still exist",
  );
});
