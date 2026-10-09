#!/usr/bin/env node
// Probe-clustered-per-frame — Slice 5d Batch 151 verification.
// @purpose Per-frame hook check: lazy dispatcher construction, compute passes run with scene.lights, disable zeroes counts exactly once.
// @status ACTIVE
//
// Loads a real CesiumViewer scene, adds a PointLight + DirectionalLight
// to scene.lights, toggles scene.clusteredLightingEnabled = true, and
// renders 60 frames. Verifies:
//   1. SceneRenderer's `_dispatchClusteredLighting` hook runs without
//      device errors.
//   2. The dispatcher is not constructed while the feature stays disabled and
//      is lazily constructed on the first enabled frame.
//   3. After rendering, the perClusterLightCount storage buffer
//      contains non-zero values (proves the compute passes actually
//      ran with the supplied lights).
//   4. Toggling `clusteredLightingEnabled = false` zeros out the
//      activeLightCount uniform exactly once; stable disabled frames do not
//      keep dispatching or splitting the render pass. (What is counted is
//      dispatcher calls; render-pass splits are not observed by this probe.)
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The scene is
// the rig `clustered-per-frame-pittsburgh`, read from `rigs/`; the browser,
// the origin (`--port`, a governed port, never 8080), the served-build
// preflight, the Edge slot and the receipt belong to `lib/probe-runtime.mjs`,
// which launches Edge with this probe's own Vulkan flags (recorded in the
// runtime receipt). The per-cluster count readback is returned whole and
// reduced in Node by `lib/metrics/cluster-light-counts.mjs`
// (`metrics-clustered.spec.mjs` holds it equal to the in-page loop it
// replaced); its sha256 is recorded, so two builds' readbacks can be compared
// byte for byte. Device errors are the shared WebGPU error gate's
// (`Tools/lib/webgpu-error-gate.mjs`), which owns the same
// `onuncapturederror` slot the private hook used and also reports a lost
// device. Nothing in this probe reads pixels, so nothing is captured.
//
// Usage: node Tools/visual-regression/probe-clustered-per-frame.mjs [--port 8094]
// @runtime lib/probe-runtime.mjs

import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./lib/capture.mjs";
import {
  CLUSTER_GRID,
  summariseClusterLightCounts,
} from "./lib/metrics/cluster-light-counts.mjs";
import {
  ProbeRefusal,
  isEntryPoint,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import rig from "./rigs/clustered-per-frame-pittsburgh.mjs";

/** The original's expected counts. */
export const EXPECTED_SCENE_LIGHTS = 2;
export const EXPECTED_ACTIVE_ON = 2;
export const EXPECTED_ACTIVE_RE_OFF = 0;
export const EXPECTED_TRANSITION_DISPATCHES = 1;

/**
 * Page side: two lights in scene.lights, render with clustered lighting off,
 * on, then off again, counting dispatcher calls across the transition and
 * reading the per-cluster counts back. Unchanged from the in-page original
 * apart from reading the rig and returning the readback whole.
 *
 * @param {{camera: object, dials: object, cells: number}} input The rig's camera and dials, and the grid size.
 * @returns {Promise<object>} The original's record, or `{earlyExitErr}`.
 */
async function pagePerFrame({ camera, dials, cells }) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const C = mod;
  const v = window.viewer;
  const scene = v.scene;

  // Sanity-check that the dispatcher is reachable through the
  // public API even though end-user code never instantiates it.
  if (typeof mod.WebGPUClusteredLightingDispatcher !== "function") {
    return { earlyExitErr: "Dispatcher class not in main bundle" };
  }
  if (typeof scene.clusteredLightingEnabled !== "boolean") {
    return { earlyExitErr: "scene.clusteredLightingEnabled not a boolean" };
  }

  // Add 2 lights to scene.lights.
  const point = dials.pointLight;
  scene.lights.add(
    new C.PointLight({
      position: C.Cartesian3.fromDegrees(point.lon, point.lat, point.height),
      color: C.Color[point.colorName],
      intensity: point.intensity,
      range: point.range,
    }),
  );
  scene.lights.add(
    new C.DirectionalLight({
      direction: new C.Cartesian3(...dials.directionalLight.direction),
      color: C.Color[dials.directionalLight.colorName],
      intensity: dials.directionalLight.intensity,
    }),
  );

  // Position the camera so the point light is in the frustum (the rig's
  // camera: the light's longitude, its latitude less 0.003 degrees, 600 m,
  // pitched 20 degrees down, no heading given).
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat,
      camera.height,
    ),
    orientation: { pitch: camera.pitch },
  });

  // Render with clustered lighting OFF first. The disabled fast path must
  // use shared placeholders without allocating a dispatcher.
  scene.clusteredLightingEnabled = false;
  for (let i = 0; i < dials.offFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const dispatcherAfterOffPhase =
    v.scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
  const dispatcherFoundEvenWhenOff = !!dispatcherAfterOffPhase;
  const lastActiveOff = dispatcherAfterOffPhase?.lastActiveLightCount ?? -1;

  // Toggle on. Render 60 more frames.
  scene.clusteredLightingEnabled = true;
  for (let i = 0; i < dials.onFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const dispatcher =
    v.scene._alternateSceneRenderer?._clusteredLightingDispatcher;
  const lastActiveOn = dispatcher?.lastActiveLightCount ?? -1;

  // Read back per-cluster light count to confirm compute actually ran.
  // 16 * 9 * 24 cells (CLUSTER_GRID); with no dispatcher there is no
  // readback, which Node reads as the original's totalOverlap of -1.
  const device = scene.context._device;
  const TOTAL = cells;
  const COUNT_BYTES = TOTAL * 4;
  let countsReadback = null;
  if (dispatcher) {
    const staging = device.createBuffer({
      size: COUNT_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder({ label: "perframe-readback" });
    enc.copyBufferToBuffer(
      dispatcher.perClusterLightCountBuffer,
      0,
      staging,
      0,
      COUNT_BYTES,
    );
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const counts = new Uint32Array(staging.getMappedRange().slice());
    staging.unmap();
    // The totalOverlap / max reduction moved to Node
    // (`lib/metrics/cluster-light-counts.mjs`).
    countsReadback = Array.from(counts);
  }

  // Count dispatcher calls across the enabled -> disabled transition. The
  // first disabled render must publish one zero-count params update so stale
  // bindings cannot observe old lights; subsequent disabled renders must be
  // stable no-ops.
  let transitionDispatchCount = 0;
  if (dispatcher) {
    const originalDispatch = dispatcher.dispatch.bind(dispatcher);
    dispatcher.dispatch = (...args) => {
      transitionDispatchCount++;
      return originalDispatch(...args);
    };
  }

  // Toggle back off. Render the transition frame, then stable disabled frames.
  scene.clusteredLightingEnabled = false;
  scene.render();
  await new Promise((r) => requestAnimationFrame(r));
  const dispatchCallsAfterTransition = transitionDispatchCount;
  for (let i = 0; i < dials.stableOffFrames; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const dispatchCallsAfterStableOff = transitionDispatchCount;
  const lastActiveOffAgain = dispatcher?.lastActiveLightCount ?? -1;

  return {
    sceneLightsCount: scene.lights.length,
    dispatcherFoundEvenWhenOff,
    lastActiveOff,
    lastActiveOn,
    countsReadback,
    lastActiveOffAgain,
    dispatchCallsAfterTransition,
    dispatchCallsAfterStableOff,
  };
}

/**
 * The original's clauses, per run, with its bars: the dispatcher class is in
 * the bundle and `scene.clusteredLightingEnabled` is a boolean (its two
 * EARLY-EXITs exited 1); scene.lights holds 2 lights; no dispatcher exists
 * after the disabled phase and none is exposed; 2 active lights when on; 0
 * after turning off again; exactly 1 dispatch on the transition frame and no
 * further dispatch over the stable disabled frames; the summed per-cluster
 * count is at least the cluster count (the directional light reaches every
 * cluster; with no dispatcher there is no readback and the clause fails, as
 * the original's -1 did); no uncaptured device error. A lost device is the
 * shared error gate's addition.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluatePerFrame(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.earlyExit === null;
    const not = `not measured: ${cell.earlyExit}`;
    const check = (id, label, value, pass, detail) => {
      verdicts.push({
        id: `${id}/${suffix}`,
        claim: measured ? `${label}: ${value}` : `${label}: ${not}`,
        pass: measured && pass,
        ...(detail === undefined ? {} : { detail }),
      });
    };
    verdicts.push({
      id: `runtime-api-present/${suffix}`,
      claim: `the dispatcher class is in the bundle and the scene toggle is a boolean${measured ? "" : ` (${cell.earlyExit})`}`,
      pass: measured,
    });
    check(
      "scene-lights",
      "scene.lights.length",
      `${cell.sceneLightsCount} (${EXPECTED_SCENE_LIGHTS})`,
      cell.sceneLightsCount === EXPECTED_SCENE_LIGHTS,
    );
    check(
      "lazy-while-off",
      "dispatcher constructed during the disabled phase",
      `${cell.dispatcherFoundEvenWhenOff} (false)`,
      cell.dispatcherFoundEvenWhenOff === false,
    );
    check(
      "off-phase-exposes-no-state",
      "lastActiveLightCount seen in the disabled phase",
      `${cell.lastActiveOff} (-1: no dispatcher)`,
      cell.lastActiveOff === -1,
    );
    check(
      "on-count",
      "lastActiveLightCount when on",
      `${cell.lastActiveOn} (${EXPECTED_ACTIVE_ON})`,
      cell.lastActiveOn === EXPECTED_ACTIVE_ON,
    );
    check(
      "re-off-count",
      "lastActiveLightCount after turning off again",
      `${cell.lastActiveOffAgain} (${EXPECTED_ACTIVE_RE_OFF})`,
      cell.lastActiveOffAgain === EXPECTED_ACTIVE_RE_OFF,
    );
    check(
      "transition-dispatches-once",
      "dispatcher calls on the enabled-to-disabled transition frame",
      `${cell.dispatchCallsAfterTransition} (${EXPECTED_TRANSITION_DISPATCHES})`,
      cell.dispatchCallsAfterTransition === EXPECTED_TRANSITION_DISPATCHES,
    );
    check(
      "stable-off-adds-none",
      "dispatcher calls after the stable disabled frames",
      `${cell.dispatchCallsAfterStableOff} (${EXPECTED_TRANSITION_DISPATCHES} in total)`,
      cell.dispatchCallsAfterStableOff === EXPECTED_TRANSITION_DISPATCHES,
    );
    check(
      "directional-reaches-every-cluster",
      "per-cluster totalOverlap",
      `${cell.counts?.total ?? -1}/${CLUSTER_GRID.cells} (max ${cell.counts?.max ?? -1}) (>= ${CLUSTER_GRID.cells})`,
      (cell.counts?.total ?? -1) >= CLUSTER_GRID.cells,
      { counts: cell.counts ?? null },
    );
    verdicts.push(
      {
        id: `device-errors/${suffix}`,
        claim: `uncaptured device errors: ${cell.deviceErrors.length}`,
        pass: cell.deviceErrors.length === 0,
        detail: { errors: cell.deviceErrors.slice(0, 10) },
      },
      {
        id: `device-not-lost/${suffix}`,
        claim: `device lost: ${cell.deviceLost ?? "no"}`,
        pass: cell.deviceLost === null,
      },
    );
  }
  return verdicts;
}

/** The rig's page on the run's origin, on the WebGPU backend. */
function sceneUrl(origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", "webgpu");
  return url.href;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "clustered-per-frame",
  title:
    "Clustered lighting's per-frame hook — lazy while off, counts when on, one sync on the way off",
  outputSubdirectory: "clustered-per-frame",
  // Nothing banked a JSON receipt before the migration, so no reader keys off
  // a probe-owned field set; one runtime document is the honest shape.
  receiptEnvelope: "runtime",
  args: { defaults: { renderers: ["webgpu"] } },
  // The CesiumViewer page and the in-page import both read this module.
  servedArtifacts: ["Build/CesiumUnminified/index.js"],
  // The original's own launch flags, kept as a recorded measurement condition.
  launchArgs: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan",
  ],
  async cells({ browser, run, options, origin }) {
    if (!options.renderers.includes("webgpu")) {
      throw new ProbeRefusal(
        "renderer-unavailable",
        "the clustered-lighting per-frame hook is WebGPU-only, so this probe " +
          `has nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({ viewport: { ...rig.viewport } });
    try {
      const page = await context.newPage();
      await page.addInitScript(errorGateInit);
      await page.goto(sceneUrl(origin), { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);
      const result = await page.evaluate(pagePerFrame, {
        camera: rig.camera,
        dials: rig.dials,
        cells: CLUSTER_GRID.cells,
      });
      const gate = await collectGateErrors(page);
      const counts = Array.isArray(result.countsReadback)
        ? {
            ...summariseClusterLightCounts(result.countsReadback),
            sha256: sha256(
              Buffer.from(Uint32Array.from(result.countsReadback).buffer),
            ),
          }
        : null;
      return [
        {
          run,
          earlyExit: result.earlyExitErr ?? null,
          sceneLightsCount: result.sceneLightsCount,
          dispatcherFoundEvenWhenOff: result.dispatcherFoundEvenWhenOff,
          lastActiveOff: result.lastActiveOff,
          lastActiveOn: result.lastActiveOn,
          lastActiveOffAgain: result.lastActiveOffAgain,
          dispatchCallsAfterTransition: result.dispatchCallsAfterTransition,
          dispatchCallsAfterStableOff: result.dispatchCallsAfterStableOff,
          counts,
          deviceErrors: gate.errors,
          deviceLost: gate.deviceLost,
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluatePerFrame(cells);
  },
  receipt(cells, context) {
    for (const verdict of context.verdicts) {
      console.log(`  [${verdict.pass ? "PASS" : "FAIL"}] ${verdict.claim}`);
    }
    return { rig: rig.id, cells, verdicts: context.verdicts };
  },
};

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runProbe(descriptor);
}
