#!/usr/bin/env node
// Probe-clustered-dispatcher — Slice 5d Batch 150 verification.
// @purpose Dispatcher lifecycle check: disabled/enabled/repeated/re-disabled dispatch counts, the packed activeLightCount in the params readback, a directional light in every cluster, and the scene toggle; whether a repeated dispatch's passes skip is not observed.
// @status ACTIVE
//
// Validates WebGPUClusteredLightingDispatcher end-to-end:
//   1. Construct the dispatcher.
//   2. Build a small world-space light list (1 directional + 1 point).
//   3. Build a view matrix that places the point light at a known
//      eye-space position.
//   4. Dispatch with `enabled=false` → packed activeLightCount=0.
//   5. Dispatch with `enabled=true` → packed activeLightCount=2.
//   6. Dispatch again with same inputs → cluster-bounds + cluster-
//      assign both skip via dirty tracking. (Intent, not a bar: the probe
//      asserts only that this dispatch still returns 2; whether the passes
//      skipped is not observed.)
//   7. Read back the params uniform buffer + per-cluster light count
//      buffer; verify activeLightCount updates correctly + per-cluster
//      counts reflect the directional baseline + point overlap.
//   8. Toggle to enabled=false again → activeLightCount goes back to 0.
//   9. Also verifies the scene.clusteredLightingEnabled toggle exists
//      on a live Scene instance.
//
// ON THE SHARED RUNTIME (probe-kit harvest, clustered family). The synthetic
// inputs are the rig `clustered-dispatcher-synthetic`, read from `rigs/`; the
// browser, the origin (`--port`, a governed port, never 8080), the
// served-build preflight, the Edge slot and the receipt belong to
// `lib/probe-runtime.mjs`, which launches Edge with this probe's own Vulkan
// flags (recorded in the runtime receipt). The per-cluster count readback is
// returned whole and reduced in Node by `lib/metrics/cluster-light-counts.mjs`
// (`metrics-clustered.spec.mjs` holds it equal to the in-page loop it
// replaced); its sha256 is recorded, so two builds' readbacks can be compared
// byte for byte. Device errors are the shared WebGPU error gate's
// (`Tools/lib/webgpu-error-gate.mjs`), which owns the same
// `onuncapturederror` slot the private hook used and also reports a lost
// device. Nothing is drawn, so nothing is captured.
//
// Usage: node Tools/visual-regression/probe-clustered-dispatcher.mjs [--port 8094]
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
import rig from "./rigs/clustered-dispatcher-synthetic.mjs";

/** The original's expected counts: two lights when enabled, none when not. */
export const EXPECTED_ACTIVE_ENABLED = 2;
export const EXPECTED_ACTIVE_DISABLED = 0;

/**
 * Page side: build a standalone dispatcher on the page's device, dispatch it
 * disabled / enabled / enabled again / disabled again, and read the GPU
 * buffers back. Unchanged from the in-page original apart from reading the
 * rig's dials and returning the count readback whole for Node to reduce.
 *
 * @param {{dials: object, cells: number}} input The rig's dials and the grid size.
 * @returns {Promise<object>} The original's record, or `{earlyExitErr}`.
 */
async function pageDispatch({ dials, cells }) {
  const mod = await import("/Build/CesiumUnminified/index.js");
  const device = window.viewer.scene.context._device;
  const scene = window.viewer.scene;

  const DispatcherCtor = mod.WebGPUClusteredLightingDispatcher;
  if (typeof DispatcherCtor !== "function") {
    return {
      earlyExitErr: `dispatcher missing — typeof=${typeof DispatcherCtor}. Dev-server bundle cache likely stale.`,
    };
  }
  const C = mod;

  // Scene toggle check.
  const initialToggle = scene.clusteredLightingEnabled;
  scene.clusteredLightingEnabled = true;
  const afterSetToggle = scene.clusteredLightingEnabled;
  scene.clusteredLightingEnabled = false;
  const afterUnsetToggle = scene.clusteredLightingEnabled;

  // Build inputs.
  const W = dials.projection.viewportWidth;
  const H = dials.projection.viewportHeight;
  const near = dials.projection.near;
  const far = dials.projection.far;
  const projection = C.Matrix4.computePerspectiveFieldOfView(
    dials.projection.fovYRadians,
    W / H,
    near,
    far,
    new C.Matrix4(),
  );
  const invProj = C.Matrix4.inverse(projection, new C.Matrix4());
  const invProjArr = Array.from(invProj);
  // Identity view matrix so world-space == eye-space.
  const viewArr = Array.from(C.Matrix4.IDENTITY);

  // [0] DIRECTIONAL (lightType 0), [1] POINT (lightType 1).
  const lights = dials.lights;

  const dispatcher = new DispatcherCtor(device);

  // Dispatch 1: disabled → expect 0 active.
  const e1 = device.createCommandEncoder({ label: "d1-disabled" });
  const c1 = dispatcher.dispatch(e1, {
    enabled: false,
    lights,
    viewportWidth: W,
    viewportHeight: H,
    near,
    far,
    inverseProjection: invProjArr,
    viewMatrix: viewArr,
  });
  device.queue.submit([e1.finish()]);

  // Dispatch 2: enabled → expect 2 active.
  const e2 = device.createCommandEncoder({ label: "d2-enabled" });
  const c2 = dispatcher.dispatch(e2, {
    enabled: true,
    lights,
    viewportWidth: W,
    viewportHeight: H,
    near,
    far,
    inverseProjection: invProjArr,
    viewMatrix: viewArr,
  });
  device.queue.submit([e2.finish()]);

  // Dispatch 3: same inputs → dispatcher still returns 2 but compute
  // passes should skip via their internal dirty tracking. We can't
  // observe the dispatch-or-not directly from the dispatcher's
  // return, but no error + same outputs is enough validation.
  const e3 = device.createCommandEncoder({ label: "d3-cache-hit" });
  const c3 = dispatcher.dispatch(e3, {
    enabled: true,
    lights,
    viewportWidth: W,
    viewportHeight: H,
    near,
    far,
    inverseProjection: invProjArr,
    viewMatrix: viewArr,
  });
  device.queue.submit([e3.finish()]);

  // Read back per-cluster light count (16 * 9 * 24 cells, CLUSTER_GRID).
  const TOTAL = cells;
  const COUNT_BYTES = TOTAL * 4;
  const countStaging = device.createBuffer({
    size: COUNT_BYTES,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const cre = device.createCommandEncoder({ label: "count-readback" });
  cre.copyBufferToBuffer(
    dispatcher.perClusterLightCountBuffer,
    0,
    countStaging,
    0,
    COUNT_BYTES,
  );
  device.queue.submit([cre.finish()]);
  await countStaging.mapAsync(GPUMapMode.READ);
  const counts = new Uint32Array(countStaging.getMappedRange().slice());
  countStaging.unmap();

  // Read back the params uniform (just first 8 floats).
  const paramsStaging = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const pre = device.createCommandEncoder({ label: "params-readback" });
  pre.copyBufferToBuffer(dispatcher.paramsBuffer, 0, paramsStaging, 0, 32);
  device.queue.submit([pre.finish()]);
  await paramsStaging.mapAsync(GPUMapMode.READ);
  const params = new Float32Array(paramsStaging.getMappedRange().slice());
  paramsStaging.unmap();

  // The totalOverlap / max reduction moved to Node
  // (`lib/metrics/cluster-light-counts.mjs`); the readback goes back whole.

  // Dispatch 4: toggle back to disabled.
  const e4 = device.createCommandEncoder({ label: "d4-redisabled" });
  const c4 = dispatcher.dispatch(e4, {
    enabled: false,
    lights,
    viewportWidth: W,
    viewportHeight: H,
    near,
    far,
    inverseProjection: invProjArr,
    viewMatrix: viewArr,
  });
  device.queue.submit([e4.finish()]);

  // Re-read params for active=0 confirmation.
  const params2Staging = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const pre2 = device.createCommandEncoder({ label: "params-readback-2" });
  pre2.copyBufferToBuffer(dispatcher.paramsBuffer, 0, params2Staging, 0, 32);
  device.queue.submit([pre2.finish()]);
  await params2Staging.mapAsync(GPUMapMode.READ);
  const params2 = new Float32Array(params2Staging.getMappedRange().slice());
  params2Staging.unmap();

  return {
    initialToggle,
    afterSetToggle,
    afterUnsetToggle,
    c1,
    c2,
    c3,
    c4,
    counts: Array.from(counts),
    TOTAL,
    // ClusterParams.activeLightCount is the second vec4. Its .x punctual
    // count is float 4; float 5 is the independently packed LTC area-light
    // count. This probe predates the area-light split and used the stale .y
    // offset, which made a healthy two-punctual-light dispatch look disabled.
    paramsEnabledActiveLightCount: params[4],
    paramsDisabledActiveLightCount: params2[4],
  };
}

/**
 * The original's clauses, per run, with its bars: the dispatcher class is in
 * the bundle (its EARLY-EXIT exited 1); the scene toggle starts false and
 * accepts true; the four dispatches return 0 / 2 / 2 / 0 (disabled, enabled,
 * repeated, disabled again); the summed per-cluster count is at least the
 * cluster count (the directional light reaches every cluster); the params
 * readback's punctual count is 2 after the enabled dispatch and 0 after the
 * re-disabled one; no uncaptured device error. A lost device is the shared
 * error gate's addition. Whether the repeated dispatch's compute passes
 * skipped is not observed, as the original's own comment said.
 *
 * Pure and exported so `clustered-probe-verdicts.spec.mjs` can put a cell on
 * either side of every bar without a browser.
 *
 * @param {Array<object>} cells
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateDispatcher(cells) {
  const verdicts = [];
  for (const cell of cells) {
    const suffix = `run${cell.run}`;
    const measured = cell.earlyExit === null;
    const not = `not measured: ${cell.earlyExit}`;
    const check = (id, claim, pass, detail) => {
      verdicts.push({
        id: `${id}/${suffix}`,
        claim: measured ? claim : `${claim.split(":")[0]}: ${not}`,
        pass: measured && pass,
        ...(detail === undefined ? {} : { detail }),
      });
    };
    verdicts.push({
      id: `dispatcher-exported/${suffix}`,
      claim: `WebGPUClusteredLightingDispatcher is in the bundle${measured ? "" : ` (${cell.earlyExit})`}`,
      pass: measured,
    });
    check(
      "toggle-initially-off",
      `scene.clusteredLightingEnabled initially: ${cell.initialToggle} (false)`,
      cell.initialToggle === false,
    );
    check(
      "toggle-accepts-true",
      `scene.clusteredLightingEnabled after set true: ${cell.afterSetToggle} (true)`,
      cell.afterSetToggle === true,
    );
    check(
      "disabled-dispatch",
      `disabled dispatch returned: ${cell.c1} (${EXPECTED_ACTIVE_DISABLED})`,
      cell.c1 === EXPECTED_ACTIVE_DISABLED,
    );
    check(
      "enabled-dispatch",
      `enabled dispatch returned: ${cell.c2} (${EXPECTED_ACTIVE_ENABLED})`,
      cell.c2 === EXPECTED_ACTIVE_ENABLED,
    );
    check(
      "repeat-dispatch-stays-active",
      `repeated (cache-hit) dispatch returned: ${cell.c3} (${EXPECTED_ACTIVE_ENABLED})`,
      cell.c3 === EXPECTED_ACTIVE_ENABLED,
    );
    check(
      "redisabled-dispatch",
      `re-disabled dispatch returned: ${cell.c4} (${EXPECTED_ACTIVE_DISABLED})`,
      cell.c4 === EXPECTED_ACTIVE_DISABLED,
    );
    check(
      "directional-reaches-every-cluster",
      `per-cluster totalOverlap: ${cell.counts?.total}/${CLUSTER_GRID.cells} (max ${cell.counts?.max}) (>= ${CLUSTER_GRID.cells})`,
      cell.counts?.total >= CLUSTER_GRID.cells,
      { counts: cell.counts ?? null },
    );
    check(
      "params-enabled-count",
      `params activeLightCount after the enabled dispatch: ${cell.paramsEnabledActiveLightCount} (${EXPECTED_ACTIVE_ENABLED})`,
      cell.paramsEnabledActiveLightCount === EXPECTED_ACTIVE_ENABLED,
    );
    check(
      "params-disabled-count",
      `params activeLightCount after the re-disabled dispatch: ${cell.paramsDisabledActiveLightCount} (${EXPECTED_ACTIVE_DISABLED})`,
      cell.paramsDisabledActiveLightCount === EXPECTED_ACTIVE_DISABLED,
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
function hostUrl(origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  url.searchParams.set("renderer", "webgpu");
  return url.href;
}

/** The descriptor the shared runtime executes. */
export const descriptor = {
  name: "clustered-dispatcher",
  title:
    "Clustered-lighting dispatcher lifecycle — dispatch counts, params readback and the scene toggle",
  outputSubdirectory: "clustered-dispatcher",
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
        "the clustered-lighting dispatcher is WebGPU-only, so this probe has " +
          `nothing to measure on ${options.renderers.join(",")}`,
        { renderers: options.renderers },
      );
    }
    const context = await browser.newContext({ viewport: { ...rig.viewport } });
    try {
      const page = await context.newPage();
      await page.addInitScript(errorGateInit);
      await page.goto(hostUrl(origin), { waitUntil: "networkidle" });
      await page.waitForFunction(() => !!window.viewer);
      await armWebGPUDevices(page);
      const result = await page.evaluate(pageDispatch, {
        dials: rig.dials,
        cells: CLUSTER_GRID.cells,
      });
      const gate = await collectGateErrors(page);
      const counts = Array.isArray(result.counts)
        ? {
            ...summariseClusterLightCounts(result.counts),
            sha256: sha256(Buffer.from(Uint32Array.from(result.counts).buffer)),
          }
        : null;
      return [
        {
          run,
          earlyExit: result.earlyExitErr ?? null,
          initialToggle: result.initialToggle,
          afterSetToggle: result.afterSetToggle,
          afterUnsetToggle: result.afterUnsetToggle,
          c1: result.c1,
          c2: result.c2,
          c3: result.c3,
          c4: result.c4,
          counts,
          paramsEnabledActiveLightCount: result.paramsEnabledActiveLightCount,
          paramsDisabledActiveLightCount: result.paramsDisabledActiveLightCount,
          deviceErrors: gate.errors,
          deviceLost: gate.deviceLost,
        },
      ];
    } finally {
      await context.close();
    }
  },
  verdicts(cells) {
    return evaluateDispatcher(cells);
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
