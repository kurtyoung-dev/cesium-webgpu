#!/usr/bin/env node
// Probe-clustered-dispatcher — Slice 5d Batch 150 verification.
//
// Validates WebGPUClusteredLightingDispatcher end-to-end:
//   1. Construct the dispatcher.
//   2. Build a small world-space light list (1 directional + 1 point).
//   3. Build a view matrix that places the point light at a known
//      eye-space position.
//   4. Dispatch with `enabled=false` → packed activeLightCount=0.
//   5. Dispatch with `enabled=true` → packed activeLightCount=2.
//   6. Dispatch again with same inputs → cluster-bounds + cluster-
//      assign both skip via dirty tracking.
//   7. Read back the params uniform buffer + per-cluster light count
//      buffer; verify activeLightCount updates correctly + per-cluster
//      counts reflect the directional baseline + point overlap.
//   8. Toggle to enabled=false again → activeLightCount goes back to 0.
//   9. Also verifies the scene.clusteredLightingEnabled toggle exists
//      on a live Scene instance.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const result = await page.evaluate(async () => {
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
    const W = 640;
    const H = 360;
    const near = 1.0;
    const far = 1000.0;
    const projection = C.Matrix4.computePerspectiveFieldOfView(
      Math.PI / 3,
      W / H,
      near,
      far,
      new C.Matrix4(),
    );
    const invProj = C.Matrix4.inverse(projection, new C.Matrix4());
    const invProjArr = Array.from(invProj);
    // Identity view matrix so world-space == eye-space.
    const viewArr = Array.from(C.Matrix4.IDENTITY);

    const lights = [
      {
        lightType: 0, // DIRECTIONAL
        posOrDirWC: { x: 0, y: -1, z: -1 },
        color: { r: 1, g: 1, b: 1 },
        intensity: 1,
        range: 0,
      },
      {
        lightType: 1, // POINT
        posOrDirWC: { x: 0, y: 0, z: -50 },
        color: { r: 1, g: 0.5, b: 0.2 },
        intensity: 5,
        range: 80,
      },
    ];

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

    // Read back per-cluster light count.
    const TOTAL = 16 * 9 * 24;
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

    let totalOverlap = 0;
    let max = 0;
    for (let i = 0; i < TOTAL; i++) {
      totalOverlap += counts[i];
      if (counts[i] > max) max = counts[i];
    }

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
      totalOverlap,
      max,
      TOTAL,
      // ClusterParams.activeLightCount is the second vec4. Its .x punctual
      // count is float 4; float 5 is the independently packed LTC area-light
      // count. This probe predates the area-light split and used the stale .y
      // offset, which made a healthy two-punctual-light dispatch look disabled.
      paramsEnabledActiveLightCount: params[4],
      paramsDisabledActiveLightCount: params2[4],
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-clustered-dispatcher] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  const r = result;
  console.log(`  scene.clusteredLightingEnabled:`);
  console.log(
    `    initial=${r.initialToggle} after-set-true=${r.afterSetToggle} after-set-false=${r.afterUnsetToggle}`,
  );
  console.log(
    `  dispatch return values: disabled=${r.c1} enabled=${r.c2} cacheHit=${r.c3} reDisabled=${r.c4}`,
  );
  console.log(
    `  per-cluster: totalOverlap=${r.totalOverlap}/${r.TOTAL}  max=${r.max}`,
  );
  console.log(
    `  params.activeLightCount: enabled=${r.paramsEnabledActiveLightCount}  disabled=${r.paramsDisabledActiveLightCount}`,
  );
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs
      .slice(0, 3)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
  }

  let pass = true;
  if (r.initialToggle !== false) {
    console.log(
      `FAIL: initial clusteredLightingEnabled = ${r.initialToggle}, expected false`,
    );
    pass = false;
  }
  if (r.afterSetToggle !== true) {
    console.log(`FAIL: clusteredLightingEnabled didn't accept true`);
    pass = false;
  }
  if (r.c1 !== 0) {
    console.log(`FAIL: disabled dispatch returned ${r.c1}, expected 0`);
    pass = false;
  }
  if (r.c2 !== 2) {
    console.log(`FAIL: enabled dispatch returned ${r.c2}, expected 2`);
    pass = false;
  }
  if (r.c3 !== 2) {
    console.log(
      `FAIL: cache-hit dispatch returned ${r.c3}, expected 2 (still active)`,
    );
    pass = false;
  }
  if (r.c4 !== 0) {
    console.log(`FAIL: re-disabled dispatch returned ${r.c4}, expected 0`);
    pass = false;
  }
  // Directional light reaches every cluster → totalOverlap >= TOTAL.
  if (r.totalOverlap < r.TOTAL) {
    console.log(
      `FAIL: totalOverlap ${r.totalOverlap} < ${r.TOTAL} — directional should hit every cluster`,
    );
    pass = false;
  }
  // params uniform should reflect the active count.
  if (r.paramsEnabledActiveLightCount !== 2) {
    console.log(
      `FAIL: enabled-frame activeLightCount = ${r.paramsEnabledActiveLightCount}, expected 2`,
    );
    pass = false;
  }
  if (r.paramsDisabledActiveLightCount !== 0) {
    console.log(
      `FAIL: disabled-frame activeLightCount = ${r.paramsDisabledActiveLightCount}, expected 0`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: dispatcher orchestrates compute passes correctly + scene toggle works + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
