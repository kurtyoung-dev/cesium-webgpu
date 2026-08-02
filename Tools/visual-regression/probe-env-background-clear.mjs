#!/usr/bin/env node
// probe-env-background-clear.mjs — NEW-WEBGPU-ENV-PASS-DROP (background-clear
// member). Automates the executor's manual bisection: with all environment
// content hidden, does `scene.backgroundColor` still reach the framebuffer as
// content is progressively removed?
//
// WHAT THIS GATES
// ---------------
// The "background control response": set `scene.backgroundColor` to black,
// capture; set it to white, capture; response = meanWhite - meanBlack over the
// measured region, normalized to 0..1. On a frame whose measured region is
// entirely background the response is ~1 on a correct renderer, and 0 when the
// background never reaches the canvas. WebGL is the reference at every step.
//
// DEFECT UNDER TEST (root-caused by source trace before this probe was written):
//   `WebGPUContext.clear` DROPS the background `ClearCommand` on the C9-07 /
//   FAR-405-C0 deferred-canvas-clear path (`WebGPUContext.ts:3828-3835`) on the
//   promise that the pending first canvas open delivers the same
//   `_clearColor` / `_clearDepth` / `_clearStencil`. Nothing ever wrote
//   `_clearColor` from a clear command — WebGL does it implicitly through
//   `gl.clearColor` (`Renderer/Context.js:1298-1304`) — so it stayed at its
//   constructor value, transparent black, for the life of the context.
//   On a frame with zero frustums and no environmental-effect demand,
//   `WebGPUSceneRenderer.executeCommands` early-returns
//   (`WebGPUSceneRenderer.ts:1591-1593`) BEFORE `setupSceneFramebufferRenderPass`
//   — the only other consumer of `frameState.backgroundColor` — so the
//   `endFrame` present fallback (`WebGPUContext.ts:2608-2620`) is the sole
//   writer of the canvas and it presents that transparent black.
//   WebGL has no equivalent hole: `FramebufferOrchestrator` executes the
//   background clear straight against the default framebuffer before any
//   frustum work exists.
//
// PRE-FIX vs POST-FIX EXPECTATIONS (what this probe reports against the
// unfixed engine — the reason it is an acceptance gate and not a formality):
//   steps 1-3 (`enableLighting`, `+baseColor`, `+showGroundAtmosphere`): the sun
//     is still shown and pushes a binned `Pass.ENVIRONMENT` copy, so
//     `sawEnvironmentNoBV` restores the camera window, frustums exist, the
//     scene-FB pass opens with `clearValue = frameState.backgroundColor` and the
//     post-process blit carries it to the canvas. response ~1 on BOTH backends,
//     `frustumCount >= 1`.
//   step 4 (`+sunOff`) and everything after: no environment element emits,
//     `hasInjectedEnvironmentContent` correctly returns false, `frustumCount`
//     goes to 0, and PRE-FIX the WebGPU response collapses to ~0 while WebGL
//     stays ~1 — `responseDelta` ~1.0, far past the 0.1 gate, so those three
//     steps FAIL (exit 1). POST-FIX all six steps read ~1 on both backends.
//   the `globe-in-view` step reads LOW on both backends in both states — it
//     proves the metric is not stuck at 1. It is ALSO the globe verdict's
//     subject, and reads low for the right reason only once the globe has
//     actually rendered; see the readiness discussion below.
//
// TWO INDEPENDENT VERDICTS (NEW-WEBGPU-OFFLINE-GLOBE-ZERO-FRUSTUMS)
// -----------------------------------------------------------------
// The six background-only steps and the globe step answer DIFFERENT questions
// and are scored separately, so neither can mask or be blamed for the other:
//
//   BACKGROUND gate — steps 1-6. "Does `scene.backgroundColor` reach the
//     WebGPU framebuffer everywhere WebGL shows it?" This is the
//     NEW-WEBGPU-ENV-PASS-DROP acceptance.
//   GLOBE gate — the `globe-in-view` step. "With the globe filling the frame,
//     does the WebGPU globe actually render?" Scored on globe READINESS
//     (>= 1 binned Pass.GLOBE command) plus the same cross-backend response
//     agreement.
//
// The globe step keeps its original second job as the background gate's
// non-vacuity control (it must read LOW on the reference, proving the metric is
// background-specific), but a globe-lane problem now reports as a globe-lane
// problem instead of appearing as a background-clear FAIL.
//
// WHY THE GLOBE LANE NEEDS ITS OWN READINESS GATE (root cause, traced in source)
// ----------------------------------------------------------------------------
// The first execution of this probe reported WebGL frustums 1 / WebGPU
// frustums 0 with the globe in view, filed as
// NEW-WEBGPU-OFFLINE-GLOBE-ZERO-FRUSTUMS. That is the already-traced
// cold-pipeline-variant skip, not a frustum-accumulation defect:
//
//   1. `WebGPUGlobeSurfacePipelines.selectPipeline` →
//      `resolveGlobePipelineEntry` → `pipelineCache.getPipelineSync(...)`,
//      a pure `cache.get` that never creates. On a miss it marks the entry
//      pending, kicks off `createRenderPipelineAsync`, and returns NULL.
//   2. `WebGPUGlobeSurfaceRenderer` hits `if (!pipeline) { continue; }` — the
//      tile contributes NO command descriptor.
//   3. `addWebGPUDrawCommandsForTile` returns on `cmdDescs.length === 0`
//      BEFORE `frameState.commandList.push(command)`.
//   4. With no GLOBE command carrying a bounding volume, `near`/`far` in
//      `View.createPotentiallyVisibleSet` never leave their +/-MAX sentinels,
//      `updateFrustums` clamps them to near === far, and
//      `numFrustums = ceil(log(1)/log(ratio)) = 0` — `frustumCommandsList`
//      is emptied. Zero frustums is the SYMPTOM of the skipped tile.
//
// WebGL has no analogue: `addDrawCommandsForTile` pushes the command with a
// `ShaderProgram` that compiles synchronously at execute time, so its frustum
// count reflects tile VISIBILITY only, never GPU resource readiness.
//
// The previous step (`ellipsoidTerrain`) swaps the terrain provider, which
// changes the vertex encoding class (quantized BITS12 → uncompressed) and
// therefore the globe pipeline cache key — so the globe step is measured
// against a guaranteed-cold variant. Eight settle frames (~130 ms) is nowhere
// near `createRenderPipelineAsync`'s ~1-2 s. This is the same harness race that
// produced the C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO false positive
// (DEFERRED_WORK, 2026-07-10), whose closure established the fleet gate this
// step now uses: poll until `globe.tilesLoaded` AND >= 1 binned Pass.GLOBE
// command, yielding on the LOADING side only.
//
// GATE
//   FAIL (exit 1): BACKGROUND — any of steps 1-6 where
//     |webgpuResponse - webglResponse| > 0.10. GLOBE — the globe step's
//     response delta exceeds the same bar after both backends reached globe
//     readiness.
//   STRUCTURAL (exit 2): a step never measured; a renderer mismatch or a WebGPU
//     lane that is not genuinely WebGPU; a WebGL reference response below 0.80
//     on a background-only step (a broken reference is never an engine gate);
//     the globe step failing to darken on the REFERENCE; the WebGPU lane
//     never once reaching `frustumCount === 0` (the background defect's own
//     precondition — without it the probe never entered the condition it
//     claims to test); or either backend failing to reach globe readiness
//     inside the budget (an unrendered globe cannot be compared, and a
//     never-ready globe is a finding in its own right, not a quiet FAIL).
//   PASS (exit 0): otherwise.
//
// PROBE RULES (fleet convention): pinned clock on every `scene.render(t)`;
// bounded settle loops that yield ONLY on the loading side; same-task capture
// (render + getImageData with no await between); canvas ELEMENT screenshots;
// rendererType / isWebGPU / device recorded and hard-failed on mismatch;
// reference-derived floors, never inherited constants; output artifacts deleted
// before the run; unref'd force-exit watchdog; bounded loops everywhere.
// EVERY helper used inside a page.evaluate callback is defined INSIDE it.
//
// CONSOLIDATION NOTE: the fused render+read primitives here are written inline
// because `Tools/visual-regression/lib/same-task-capture.mjs` is not on main yet
// (it arrives with the eclipse lane). When it lands, fold `measureResponse`'s
// capture half onto that shared module rather than keeping a second copy.
//
// Usage: node Tools/visual-regression/probe-env-background-clear.mjs
//   (requires the dev server on localhost:8080 and a current gulp build)
//   PROBE_BASE=http://localhost:8080 overrides the server.

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const REPORT_PATH = path.join(OUT_DIR, "env-background-clear.json");
const VIEWPORT = { width: 1280, height: 720 };

// A pinned epoch keeps the sun geometry (and therefore the step-4 transition)
// identical between the two backend lanes and between runs.
const EPOCH_ISO = "2026-08-01T12:00:00Z";

// Cross-backend agreement bar for the response, and the floor the WebGL
// reference must itself clear before a step may gate anything.
const RESPONSE_DELTA_MAX = 0.1;
const REFERENCE_RESPONSE_FLOOR = 0.8;
// The control step must be clearly darker than a background-only step ON THE
// REFERENCE, otherwise the metric is not measuring the background at all.
const CONTROL_RESPONSE_CEILING = 0.5;

// Globe-readiness budget for the `globe-in-view` step, per backend. Sized
// against `createRenderPipelineAsync`'s measured ~1-2 s for the ~239 KB
// GlobeTerrain module plus terrain re-load after the provider swap, with a wide
// margin so a slow machine reports a real result rather than a timeout. The
// poll yields with `setTimeout`, not `requestAnimationFrame`: headless wall
// clock must actually elapse while the pipeline cooks (the gate the
// C7-GROUNDPRIM-TEXTURED-CLASSIFY-ZERO closure landed).
const GLOBE_READY_TIMEOUT_MS = 45000;
const GLOBE_READY_POLL_MS = 50;

// Two backend lanes x up to one 45 s globe-readiness wait each, on top of the
// six background steps' bounded settles and page loads.
const HARD_LIMIT_MS = 540000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-env-background-clear] WATCHDOG FIRED (${HARD_LIMIT_MS / 1000}s) — forcing exit`,
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1000) / 1000;

// ── The bisection, in the executor's order. Each step is CUMULATIVE. ─────────
// `lane` picks which of the two independent verdicts a step is scored under.
// `control` marks the trailing step that is NOT a background-only frame; it is
// the same-run control that proves the metric can read low, AND the subject of
// the globe verdict.
const LANE_BACKGROUND = "background";
const LANE_GLOBE = "globe";
const STEPS = [
  { id: "enableLighting", control: false, lane: LANE_BACKGROUND },
  { id: "baseColor", control: false, lane: LANE_BACKGROUND },
  { id: "showGroundAtmosphere", control: false, lane: LANE_BACKGROUND },
  { id: "sunOff", control: false, lane: LANE_BACKGROUND },
  { id: "imageryOff", control: false, lane: LANE_BACKGROUND },
  { id: "ellipsoidTerrain", control: false, lane: LANE_BACKGROUND },
  { id: "globe-in-view", control: true, lane: LANE_GLOBE },
];

const SCREENSHOT_STEPS = new Set(["enableLighting", "sunOff", "globe-in-view"]);

// ── Provenance ──────────────────────────────────────────────────────────────
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function provenance(runStartedAtMs) {
  const sources = {};
  for (const rel of [
    "packages/engine/Source/Renderer/WebGPU/WebGPUCanvasClearState.ts",
    "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  ]) {
    try {
      const bytes = fs.readFileSync(rel);
      sources[rel] = { byteLength: bytes.byteLength, sha256: sha256(bytes) };
    } catch {
      sources[rel] = null; // pre-fix tree — the module does not exist yet.
    }
  }

  const bundleDir = "Build/CesiumUnminified";
  const candidates = [];
  let newestBundleMtimeMs = 0;
  const collect = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (name.endsWith(".js")) {
        candidates.push(full);
        try {
          newestBundleMtimeMs = Math.max(
            newestBundleMtimeMs,
            fs.statSync(full).mtimeMs,
          );
        } catch {
          /* unreadable entry — ignored, bundlePresent covers the empty case */
        }
      }
    }
  };
  collect(bundleDir);
  collect(path.join(bundleDir, "chunks"));

  // Fix token — REPORTED, never gated, so a pre-fix baseline run still reaches
  // the step measurements instead of exiting structural.
  const token = "canvasClearStateUpdate";
  let fixPresent = false;
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes(token)) {
      fixPresent = true;
      break;
    }
  }
  return {
    sources,
    bundlePresent: candidates.length > 0,
    newestBundleMtime: newestBundleMtimeMs
      ? new Date(newestBundleMtimeMs).toISOString()
      : null,
    // A build that finishes DURING the run means the pixels read may predate it.
    buildRacedTheRun: newestBundleMtimeMs > runStartedAtMs,
    fixToken: token,
    fixPresentInBuild: fixPresent,
  };
}

// ── In-page: park a ground-level observer under the sun, environment hidden ──
const SETUP = async ({ iso }) => {
  // ALL helpers live inside this callback (serialization boundary).
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  viewer.useDefaultRenderLoop = false;
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601(iso);
  scene.requestRenderMode = false;
  const T = () => viewer.clock.currentTime;

  // "All environment content hidden" — the state the bisection started from.
  // The sun is deliberately LEFT ON: it is the element the bisection turns off
  // at step 4, and the only one still emitting by then.
  if (scene.skyBox) {
    scene.skyBox.show = false;
    if (scene.skyBox.starField) {
      scene.skyBox.starField.show = false;
    }
  }
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }
  if (scene.moon) {
    scene.moon.show = false;
  }
  if (scene.fog) {
    scene.fog.enabled = false;
  }
  if (scene.sun) {
    scene.sun.show = true;
  }

  // Bounded sun-direction settle (ICRF / earth-orientation data load async).
  // This is the LOADING side — yielding here is safe; nothing is being read.
  let prev = null;
  let stableRun = 0;
  let settleIterations = 0;
  for (let i = 0; i < 180 && stableRun < 10; i++) {
    settleIterations = i + 1;
    scene.render(T());
    const cur = C.Cartesian3.clone(
      scene.context.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    );
    if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) {
      stableRun++;
    } else {
      stableRun = 0;
    }
    prev = cur;
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (stableRun < 10) {
    return { structuralError: "sun direction never settled" };
  }

  // Ground observer at the SUB-SOLAR point looking straight up: the sun is in
  // frame and visible for steps 1-3 (so it emits the binned Pass.ENVIRONMENT
  // copy that keeps a frustum alive), the globe is entirely behind the camera,
  // and no ephemeris luck is required.
  const up = C.Cartesian3.normalize(
    C.Cartesian3.clone(
      scene.context.uniformState.sunDirectionWC,
      new C.Cartesian3(),
    ),
    new C.Cartesian3(),
  );
  const surface = C.Ellipsoid.WGS84.scaleToGeodeticSurface(
    C.Cartesian3.multiplyByScalar(up, 6378137.0, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  if (!surface) {
    return { structuralError: "sub-solar surface point did not solve" };
  }
  const surfaceUp = C.Ellipsoid.WGS84.geodeticSurfaceNormal(
    surface,
    new C.Cartesian3(),
  );
  const camPos = C.Cartesian3.add(
    surface,
    C.Cartesian3.multiplyByScalar(surfaceUp, 2.0, new C.Cartesian3()),
    new C.Cartesian3(),
  );

  // page.evaluate callbacks do not share module scope — stash the frame.
  window.__envBgClear = { C, camPos, surfaceUp, surface };

  const context = scene.context;
  return {
    rendererType: context.rendererType,
    isWebGPU: context.isWebGPU === true,
    hasDevice: !!context.device,
    settleIterations,
  };
};

// ── In-page: apply one cumulative step, then measure the response ────────────
const MEASURE_STEP = async ({
  stepId,
  settleFrames,
  awaitGlobe,
  globeTimeoutMs,
  globePollMs,
}) => {
  const shared = window.__envBgClear;
  if (!shared) {
    return { structuralError: "setup did not run" };
  }
  const { C, camPos, surfaceUp, surface } = shared;
  const viewer = window.viewer;
  const scene = viewer.scene;
  const T = () => viewer.clock.currentTime;

  // --- helpers (all inside the callback) ---
  const aim = (direction) => {
    const seed =
      Math.abs(direction.z) < 0.9
        ? new C.Cartesian3(0, 0, 1)
        : new C.Cartesian3(1, 0, 0);
    const right = C.Cartesian3.normalize(
      C.Cartesian3.cross(direction, seed, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const camUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(right, direction, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.camera.setView({
      destination: camPos,
      orientation: { direction, up: camUp },
    });
  };
  const spin = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render(T());
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  // The readiness signal indexes the frustum bins by `Pass.GLOBE`. If that
  // export ever moves, `indices[undefined]` is NaN, `| 0` makes it 0, and the
  // gate would time out on EVERY lane while looking like a real finding —
  // exactly the class of silent instrument failure the fleet keeps paying for.
  // Fail loudly instead.
  if (!C.Pass || !Number.isInteger(C.Pass.GLOBE)) {
    return {
      structuralError:
        "Pass.GLOBE is not an integer on the engine barrel — the globe " +
        "readiness signal cannot be computed",
    };
  }

  // The globe's own structural read-out: how many commands binned into the
  // Pass.GLOBE slot (index 2) across the frustum list. It is ZERO both when no
  // tile is visible and when every visible tile was skipped for an unresolved
  // pipeline — which is exactly why it, and not `tilesLoaded`, is the readiness
  // signal. Backend-neutral: WebGL and WebGPU bin into the same list.
  const globeCommandCount = () => {
    const view = scene._view;
    const list = view && view.frustumCommandsList;
    if (!list) {
      return null;
    }
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const indices = list[i] && list[i].indices;
      total += indices ? indices[C.Pass.GLOBE] | 0 : 0;
    }
    return total;
  };

  // Bounded, wall-clock readiness gate for the globe step. LOADING side only —
  // nothing is read here, so yielding is safe (and mandatory: the WebGPU globe
  // pipeline promise cannot settle without a yield). `setTimeout` rather than
  // `requestAnimationFrame` so headless wall time actually elapses.
  const awaitGlobeReady = async (timeoutMs, pollMs) => {
    const t0 = performance.now();
    let frames = 0;
    let ready = false;
    while (performance.now() - t0 < timeoutMs) {
      scene.render(T());
      frames++;
      if (scene.globe && scene.globe.tilesLoaded && globeCommandCount() > 0) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return {
      ready,
      frames,
      waitedMs: Math.round(performance.now() - t0),
    };
  };

  // SAME-TASK capture: set the background, render, and read WITHOUT a single
  // await in between. WebGPU invalidates the swap-chain texture after
  // presentation, so any yield here reads a stale or blank surface.
  const meanLuminance = (color) => {
    scene.backgroundColor = color;
    scene.render(T());
    const canvas = scene.canvas;
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let sum = 0;
    const total = tmp.width * tmp.height;
    for (let i = 0, p = 0; p < total; p++, i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / total / 255;
  };

  // --- apply this step's change, cumulatively ---
  const globe = scene.globe;
  if (stepId === "enableLighting") {
    aim(surfaceUp); // straight up: the globe is entirely behind the camera
    if (globe) {
      globe.enableLighting = true;
    }
  } else if (stepId === "baseColor") {
    if (globe) {
      globe.baseColor = C.Color.BLACK;
    }
  } else if (stepId === "showGroundAtmosphere") {
    if (globe) {
      globe.showGroundAtmosphere = false;
    }
  } else if (stepId === "sunOff") {
    if (scene.sun) {
      scene.sun.show = false;
    }
  } else if (stepId === "imageryOff") {
    viewer.imageryLayers.removeAll();
  } else if (stepId === "ellipsoidTerrain") {
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
  } else if (stepId === "globe-in-view") {
    // Control: aim back DOWN at the globe so geometry fills the frame. The
    // response must collapse — this is what proves the metric reads the
    // background specifically and is not pinned at 1.
    aim(
      C.Cartesian3.normalize(
        C.Cartesian3.subtract(
          C.Cartesian3.multiplyByScalar(surface, 0.5, new C.Cartesian3()),
          camPos,
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      ),
    );
    scene.camera.setView({
      destination: C.Cartesian3.multiplyByScalar(
        surfaceUp,
        6378137.0 + 8.0e6,
        new C.Cartesian3(),
      ),
      orientation: {
        direction: C.Cartesian3.negate(surfaceUp, new C.Cartesian3()),
        up: new C.Cartesian3(0, 0, 1),
      },
    });
    if (scene.globe) {
      scene.globe.show = true;
    }
  } else {
    return { structuralError: `unknown step ${stepId}` };
  }

  // Globe readiness FIRST, then the ordinary settle. On WebGPU a cold globe
  // pipeline variant makes every visible tile emit nothing, which collapses the
  // frustum list to zero and reads back as "the globe did not render" — see the
  // header. Waiting here is the difference between measuring the globe and
  // measuring an async pipeline compile.
  let globeGate = null;
  if (awaitGlobe === true) {
    globeGate = await awaitGlobeReady(globeTimeoutMs, globePollMs);
  }

  // Settle on the LOADING side only.
  await spin(settleFrames);

  const meanBlack = meanLuminance(new C.Color(0.0, 0.0, 0.0, 1.0));
  const meanWhite = meanLuminance(new C.Color(1.0, 1.0, 1.0, 1.0));

  const view = scene._view;
  const context = scene.context;
  return {
    rendererType: context.rendererType,
    isWebGPU: context.isWebGPU === true,
    hasDevice: !!context.device,
    // The mechanism read-out: the zero-frustum condition the defect needs.
    frustumCount:
      view && view.frustumCommandsList ? view.frustumCommandsList.length : null,
    // The globe's structural read-out, recorded on EVERY step so a frustum
    // count can always be attributed to globe commands vs environment-only
    // demand rather than guessed at.
    globeCommands: globeCommandCount(),
    tilesLoaded: scene.globe ? scene.globe.tilesLoaded === true : null,
    globeReady: globeGate ? globeGate.ready : null,
    globeWaitMs: globeGate ? globeGate.waitedMs : null,
    globeWaitFrames: globeGate ? globeGate.frames : null,
    meanBlack,
    meanWhite,
    response: meanWhite - meanBlack,
  };
};

async function runBackend(browser, renderer) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  const out = { renderer, steps: {}, consoleErrors };
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    // Readiness is a GATE, not a recorded field: nothing proceeds until the
    // viewer + context exist.
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );

    const setup = await page.evaluate(SETUP, { iso: EPOCH_ISO });
    out.setup = setup;
    if (setup.structuralError) {
      return out;
    }
    if (setup.rendererType !== renderer) {
      out.backendMismatch = `requested ${renderer}, got ${setup.rendererType}`;
      return out;
    }
    // A silent WebGL fallback would make the WebGPU lane read as passing.
    if (renderer === "webgpu" && !(setup.isWebGPU && setup.hasDevice)) {
      out.backendMismatch = `webgpu lane is not genuinely WebGPU (isWebGPU=${setup.isWebGPU}, hasDevice=${setup.hasDevice})`;
      return out;
    }

    for (const step of STEPS) {
      const m = await page.evaluate(MEASURE_STEP, {
        stepId: step.id,
        settleFrames: 8,
        // Only the globe lane waits on globe readiness. The background steps
        // face the sky deliberately — waiting for globe commands there would
        // never resolve and would say nothing about the background clear.
        awaitGlobe: step.lane === LANE_GLOBE,
        globeTimeoutMs: GLOBE_READY_TIMEOUT_MS,
        globePollMs: GLOBE_READY_POLL_MS,
      });
      out.steps[step.id] = m;
      if (m && m.rendererType && m.rendererType !== renderer) {
        out.backendMismatch = `requested ${renderer}, got ${m.rendererType} at ${step.id}`;
      }
      if (SCREENSHOT_STEPS.has(step.id)) {
        const canvasHandle = await page.$("canvas");
        if (canvasHandle) {
          // Canvas ELEMENT screenshot — a page screenshot would include widgets.
          await canvasHandle
            .screenshot({
              path: path.join(
                OUT_DIR,
                `env-background-clear-${step.id}-${renderer}.png`,
              ),
            })
            .catch(() => {});
        }
      }
    }
    return out;
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  const runStartedAtMs = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Delete this probe's artifacts before the run so nothing stale can be read
  // back as evidence.
  try {
    fs.rmSync(REPORT_PATH, { force: true });
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (name.startsWith("env-background-clear-") && name.endsWith(".png")) {
        fs.rmSync(path.join(OUT_DIR, name), { force: true });
      }
    }
  } catch {
    /* nothing to clean */
  }

  const prov = provenance(runStartedAtMs);
  if (!prov.bundlePresent) {
    console.error(
      "[probe-env-background-clear] STRUCTURAL — Build/CesiumUnminified is missing; run `npx gulp build`",
    );
    clearTimeout(watchdog);
    process.exit(2);
  }

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let gl;
  let gpu;
  try {
    gl = await runBackend(browser, "webgl");
    gpu = await runBackend(browser, "webgpu");
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const structuralNotes = [];
  let structural = false;
  const note = (s) => {
    structuralNotes.push(s);
    structural = true;
  };
  if (gl.error) {
    note(`webgl: ${gl.error}`);
  }
  if (gpu.error) {
    note(`webgpu: ${gpu.error}`);
  }
  if (gl.backendMismatch) {
    note(`webgl: ${gl.backendMismatch}`);
  }
  if (gpu.backendMismatch) {
    note(`webgpu: ${gpu.backendMismatch}`);
  }
  if (gl.setup?.structuralError) {
    note(`webgl setup: ${gl.setup.structuralError}`);
  }
  if (gpu.setup?.structuralError) {
    note(`webgpu setup: ${gpu.setup.structuralError}`);
  }
  if (prov.buildRacedTheRun) {
    note("a build finished during the run — the pixels read may predate it");
  }

  // Per-lane verdict accumulators — a background failure and a globe failure
  // are never summed into one number.
  let backgroundFail = false;
  let globeFail = false;
  const globeNotes = [];
  let sawZeroFrustumOnWebGPU = false;
  const stepReports = {};
  for (const step of STEPS) {
    const a = gl.steps[step.id];
    const b = gpu.steps[step.id];
    const entry = { control: step.control, lane: step.lane };
    stepReports[step.id] = entry;
    if (!a || a.structuralError || !b || b.structuralError) {
      entry.structural = {
        webgl: a ? (a.structuralError ?? "missing") : "missing",
        webgpu: b ? (b.structuralError ?? "missing") : "missing",
      };
      note(`step ${step.id} never measured`);
      continue;
    }
    if (b.frustumCount === 0) {
      sawZeroFrustumOnWebGPU = true;
    }

    const delta = Math.abs(b.response - a.response);
    const side = (m) => ({
      response: r3(m.response),
      meanBlack: r3(m.meanBlack),
      meanWhite: r3(m.meanWhite),
      frustumCount: m.frustumCount,
      globeCommands: m.globeCommands,
      tilesLoaded: m.tilesLoaded,
      globeReady: m.globeReady,
      globeWaitMs: m.globeWaitMs,
      globeWaitFrames: m.globeWaitFrames,
    });
    entry.webgl = side(a);
    entry.webgpu = side(b);
    entry.responseDelta = r3(delta);

    if (step.lane === LANE_GLOBE) {
      // ── GLOBE VERDICT ──────────────────────────────────────────────────
      // (1) The reference must darken — this is also the background gate's
      //     non-vacuity control, so a failure here is STRUCTURAL for the whole
      //     run, not merely a globe FAIL.
      entry.referenceOk = a.response <= CONTROL_RESPONSE_CEILING;
      if (!entry.referenceOk) {
        note(
          `globe step did not darken on WebGL (response ${r3(a.response)} > ${CONTROL_RESPONSE_CEILING}) — the metric is not background-specific`,
        );
      }
      // (2) Readiness, per backend. An unrendered globe cannot be compared to
      //     a rendered one, so a readiness miss is reported as its own
      //     structural finding rather than being scored as a pixel FAIL.
      for (const [name, m] of [
        ["webgl", a],
        ["webgpu", b],
      ]) {
        if (m.globeReady !== true) {
          const detail = `globeCommands=${m.globeCommands} tilesLoaded=${m.tilesLoaded} waited=${m.globeWaitMs}ms/${m.globeWaitFrames} frames`;
          globeNotes.push(
            `${name}: globe never reached readiness inside ${GLOBE_READY_TIMEOUT_MS}ms (${detail})`,
          );
          note(
            `globe step: ${name} never reached globe readiness (${detail}) — ` +
              `no Pass.GLOBE command ever binned, so the globe was not measured`,
          );
        }
      }
      entry.globeReadyBoth = a.globeReady === true && b.globeReady === true;
      entry.PASS = entry.globeReadyBoth && delta <= RESPONSE_DELTA_MAX;
      if (!entry.PASS) {
        globeFail = true;
      }
    } else {
      // ── BACKGROUND VERDICT ─────────────────────────────────────────────
      // Reference floor is derived from this same run, not inherited: a WebGL
      // lane that cannot itself show the background is a broken instrument,
      // never an engine gate.
      entry.referenceOk = a.response >= REFERENCE_RESPONSE_FLOOR;
      if (!entry.referenceOk) {
        note(
          `step ${step.id}: WebGL reference response ${r3(a.response)} < ${REFERENCE_RESPONSE_FLOOR} — the reference itself did not show the background`,
        );
      }
      entry.PASS = delta <= RESPONSE_DELTA_MAX;
      if (!entry.PASS) {
        backgroundFail = true;
      }
    }
  }
  const anyFail = backgroundFail || globeFail;

  // Non-vacuity: the defect lives in the zero-frustum frame. If no step ever
  // reached `frustumCount === 0` on WebGPU, this run never entered the
  // condition it claims to gate and must not be read as a PASS.
  if (!sawZeroFrustumOnWebGPU && !structural) {
    note(
      "no step reached frustumCount === 0 on WebGPU — the run never entered the zero-frustum condition under test (camera/scene setup drifted)",
    );
  }

  // Two named verdicts. The overall GATE is their conjunction, but each is
  // reported on its own so a reader never has to guess which concern moved it.
  const BACKGROUND_GATE = structural
    ? "STRUCTURAL — not scored"
    : backgroundFail
      ? "FAIL — scene.backgroundColor does not reach the WebGPU framebuffer at every background-only step WebGL does"
      : "PASS — the background control response tracks WebGL at every background-only bisection step";
  const GLOBE_GATE = structural
    ? "STRUCTURAL — not scored"
    : globeFail
      ? "FAIL — with the globe in view the two backends disagree after both reached globe readiness"
      : "PASS — both backends render the globe (>= 1 binned Pass.GLOBE command) and agree on the response";

  const GATE = structural
    ? "STRUCTURAL — a step never measured, a lane was not the requested renderer, the WebGL reference failed its own floor, the zero-frustum condition was never entered, or a backend never reached globe readiness"
    : anyFail
      ? `FAIL — background: ${backgroundFail ? "FAIL" : "PASS"}, globe: ${globeFail ? "FAIL" : "PASS"}`
      : "PASS — background clear and globe rendering both track WebGL";

  const manifest = {
    probe: "probe-env-background-clear",
    task: "NEW-WEBGPU-ENV-PASS-DROP (background-clear member) + NEW-WEBGPU-OFFLINE-GLOBE-ZERO-FRUSTUMS (globe lane)",
    date: new Date().toISOString(),
    provenance: prov,
    viewport: VIEWPORT,
    epoch: EPOCH_ISO,
    thresholds: {
      RESPONSE_DELTA_MAX,
      REFERENCE_RESPONSE_FLOOR,
      CONTROL_RESPONSE_CEILING,
      GLOBE_READY_TIMEOUT_MS,
      GLOBE_READY_POLL_MS,
    },
    steps: stepReports,
    sawZeroFrustumOnWebGPU,
    globeNotes,
    structuralNotes,
    BACKGROUND_GATE,
    GLOBE_GATE,
    GATE,
    raw: { gl, gpu },
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        fixPresentInBuild: prov.fixPresentInBuild,
        sawZeroFrustumOnWebGPU,
        steps: Object.fromEntries(
          Object.entries(stepReports).map(([id, e]) => [
            id,
            e.structural
              ? { structural: e.structural }
              : `[${e.lane}] ${e.PASS ? "PASS" : "FAIL"} | gl=${e.webgl.response} (frustums ${e.webgl.frustumCount}, globeCmds ${e.webgl.globeCommands}) gpu=${e.webgpu.response} (frustums ${e.webgpu.frustumCount}, globeCmds ${e.webgpu.globeCommands}) delta=${e.responseDelta}`,
          ]),
        ),
        globeNotes,
        structuralNotes,
        BACKGROUND_GATE,
        GLOBE_GATE,
        GATE,
      },
      null,
      2,
    ),
  );
  console.log(`\n[full report: ${REPORT_PATH}]`);

  const exitCode = structural ? 2 : anyFail ? 1 : 0;
  console.log(`EXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-env-background-clear] FATAL", e);
  clearTimeout(watchdog);
  process.exit(2);
});
