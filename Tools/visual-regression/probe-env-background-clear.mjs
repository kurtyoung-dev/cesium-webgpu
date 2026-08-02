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
//   the `globe-in-view` control step reads LOW on both backends in both states
//     — it exists to prove the metric is not stuck at 1.
//
// GATE
//   FAIL (exit 1): any step where |webgpuResponse - webglResponse| > 0.10.
//   STRUCTURAL (exit 2): a step never measured; a renderer mismatch or a WebGPU
//     lane that is not genuinely WebGPU; a WebGL reference response below 0.80
//     on a background-only step (a broken reference is never an engine gate);
//     the control step failing to darken on the REFERENCE; or the WebGPU lane
//     never once reaching `frustumCount === 0` — in that case the probe never
//     entered the condition it claims to test and must not report PASS.
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

const HARD_LIMIT_MS = 420000;
const watchdog = setTimeout(() => {
  console.error(
    "[probe-env-background-clear] WATCHDOG FIRED (420s) — forcing exit",
  );
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) =>
  x === null || x === undefined || !Number.isFinite(x)
    ? null
    : Math.round(x * 1000) / 1000;

// ── The bisection, in the executor's order. Each step is CUMULATIVE. ─────────
// `control` marks the trailing step that is NOT a background-only frame; it is
// the same-run control that proves the metric can read low.
const STEPS = [
  { id: "enableLighting", control: false },
  { id: "baseColor", control: false },
  { id: "showGroundAtmosphere", control: false },
  { id: "sunOff", control: false },
  { id: "imageryOff", control: false },
  { id: "ellipsoidTerrain", control: false },
  { id: "globe-in-view", control: true },
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
const MEASURE_STEP = async ({ stepId, settleFrames }) => {
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

  let anyFail = false;
  let sawZeroFrustumOnWebGPU = false;
  const stepReports = {};
  for (const step of STEPS) {
    const a = gl.steps[step.id];
    const b = gpu.steps[step.id];
    const entry = { control: step.control };
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
    entry.webgl = {
      response: r3(a.response),
      meanBlack: r3(a.meanBlack),
      meanWhite: r3(a.meanWhite),
      frustumCount: a.frustumCount,
    };
    entry.webgpu = {
      response: r3(b.response),
      meanBlack: r3(b.meanBlack),
      meanWhite: r3(b.meanWhite),
      frustumCount: b.frustumCount,
    };
    entry.responseDelta = r3(delta);

    if (step.control) {
      // The control's job is to prove the instrument can read LOW. That claim
      // is made against the REFERENCE — if WebGL does not darken here, the
      // metric is not measuring the background and no step's ~1 means anything.
      entry.referenceOk = a.response <= CONTROL_RESPONSE_CEILING;
      if (!entry.referenceOk) {
        note(
          `control step did not darken on WebGL (response ${r3(a.response)} > ${CONTROL_RESPONSE_CEILING}) — the metric is not background-specific`,
        );
      }
    } else {
      // Reference floor is derived from this same run, not inherited: a WebGL
      // lane that cannot itself show the background is a broken instrument,
      // never an engine gate.
      entry.referenceOk = a.response >= REFERENCE_RESPONSE_FLOOR;
      if (!entry.referenceOk) {
        note(
          `step ${step.id}: WebGL reference response ${r3(a.response)} < ${REFERENCE_RESPONSE_FLOOR} — the reference itself did not show the background`,
        );
      }
    }

    entry.PASS = delta <= RESPONSE_DELTA_MAX;
    if (!entry.PASS) {
      anyFail = true;
    }
  }

  // Non-vacuity: the defect lives in the zero-frustum frame. If no step ever
  // reached `frustumCount === 0` on WebGPU, this run never entered the
  // condition it claims to gate and must not be read as a PASS.
  if (!sawZeroFrustumOnWebGPU && !structural) {
    note(
      "no step reached frustumCount === 0 on WebGPU — the run never entered the zero-frustum condition under test (camera/scene setup drifted)",
    );
  }

  const GATE = structural
    ? "STRUCTURAL — a step never measured, a lane was not the requested renderer, the WebGL reference failed its own floor, or the zero-frustum condition was never entered"
    : anyFail
      ? "FAIL — scene.backgroundColor does not reach the WebGPU framebuffer at every step WebGL does"
      : "PASS — the background control response tracks WebGL at every bisection step";

  const manifest = {
    probe: "probe-env-background-clear",
    task: "NEW-WEBGPU-ENV-PASS-DROP (background-clear member)",
    date: new Date().toISOString(),
    provenance: prov,
    viewport: VIEWPORT,
    epoch: EPOCH_ISO,
    thresholds: {
      RESPONSE_DELTA_MAX,
      REFERENCE_RESPONSE_FLOOR,
      CONTROL_RESPONSE_CEILING,
    },
    steps: stepReports,
    sawZeroFrustumOnWebGPU,
    structuralNotes,
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
              : `${e.PASS ? "PASS" : "FAIL"} | gl=${e.webgl.response} (frustums ${e.webgl.frustumCount}) gpu=${e.webgpu.response} (frustums ${e.webgpu.frustumCount}) delta=${e.responseDelta}`,
          ]),
        ),
        structuralNotes,
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
