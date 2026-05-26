#!/usr/bin/env node
// Probe-clustered-per-frame — Slice 5d Batch 151 verification.
//
// Loads a real CesiumViewer scene, adds a PointLight + DirectionalLight
// to scene.lights, toggles scene.clusteredLightingEnabled = true, and
// renders 60 frames. Verifies:
//   1. SceneRenderer's `_dispatchClusteredLighting` hook runs without
//      device errors.
//   2. The dispatcher instance is lazily constructed.
//   3. After rendering, the perClusterLightCount storage buffer
//      contains non-zero values (proves the compute passes actually
//      ran with the supplied lights).
//   4. Toggling `clusteredLightingEnabled = false` zeros out the
//      activeLightCount uniform on the next render.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
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
    const lon = -79.9959;
    const lat = 40.4406;
    scene.lights.add(
      new C.PointLight({
        position: C.Cartesian3.fromDegrees(lon, lat, 200),
        color: C.Color.YELLOW,
        intensity: 5,
        range: 500,
      }),
    );
    scene.lights.add(
      new C.DirectionalLight({
        direction: new C.Cartesian3(0, -1, -1),
        color: C.Color.WHITE,
        intensity: 1,
      }),
    );

    // Position the camera so the point light is in the frustum.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - 0.003, 600),
      orientation: { pitch: C.Math.toRadians(-20) },
    });

    // Render 60 frames with clustered lighting OFF first to establish
    // a baseline (dispatcher should construct but report 0 active
    // lights since the toggle is false).
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 30; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const dispatcherAfterOffPhase =
      v.scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    const dispatcherFoundEvenWhenOff = !!dispatcherAfterOffPhase;
    const lastActiveOff = dispatcherAfterOffPhase?.lastActiveLightCount ?? -1;

    // Toggle on. Render 60 more frames.
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const dispatcher = v.scene._alternateSceneRenderer?._clusteredLightingDispatcher;
    const lastActiveOn = dispatcher?.lastActiveLightCount ?? -1;

    // Read back per-cluster light count to confirm compute actually ran.
    const device = scene.context._device;
    const TOTAL = 16 * 9 * 24;
    const COUNT_BYTES = TOTAL * 4;
    let totalOverlap = -1;
    let max = -1;
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
      totalOverlap = 0;
      max = 0;
      for (let i = 0; i < TOTAL; i++) {
        totalOverlap += counts[i];
        if (counts[i] > max) max = counts[i];
      }
    }

    // Toggle back off. Render a few more frames.
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 10; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const lastActiveOffAgain = dispatcher?.lastActiveLightCount ?? -1;

    return {
      sceneLightsCount: scene.lights.length,
      dispatcherFoundEvenWhenOff,
      lastActiveOff,
      lastActiveOn,
      totalOverlap,
      max,
      lastActiveOffAgain,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-clustered-per-frame] result:");
  if (result.earlyExitErr) {
    console.log(`  EARLY-EXIT: ${result.earlyExitErr}`);
    process.exit(1);
  }
  const r = result;
  console.log(`  scene.lights.length: ${r.sceneLightsCount}`);
  console.log(`  dispatcher constructed when off: ${r.dispatcherFoundEvenWhenOff}`);
  console.log(`  dispatcher.lastActiveLightCount when OFF:    ${r.lastActiveOff}`);
  console.log(`  dispatcher.lastActiveLightCount when ON:     ${r.lastActiveOn}`);
  console.log(`  dispatcher.lastActiveLightCount after RE-OFF: ${r.lastActiveOffAgain}`);
  console.log(`  perClusterLightCount: totalOverlap=${r.totalOverlap}/${16 * 9 * 24}  max=${r.max}`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    const seen = new Set();
    errs.slice(0, 10).forEach((e) => {
      const k = (e.text ?? "").slice(0, 100);
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`  - ${(e.text ?? "").slice(0, 250)}`);
    });
  }

  let pass = true;
  if (r.sceneLightsCount !== 2) {
    console.log(`FAIL: scene.lights.length = ${r.sceneLightsCount}, expected 2`);
    pass = false;
  }
  if (!r.dispatcherFoundEvenWhenOff) {
    console.log(`FAIL: dispatcher not constructed during off-phase rendering (should be lazy-constructed on first executeCommands regardless of toggle)`);
    pass = false;
  }
  if (r.lastActiveOff !== 0) {
    console.log(`FAIL: lastActiveLightCount when OFF = ${r.lastActiveOff}, expected 0`);
    pass = false;
  }
  if (r.lastActiveOn !== 2) {
    console.log(`FAIL: lastActiveLightCount when ON = ${r.lastActiveOn}, expected 2`);
    pass = false;
  }
  if (r.lastActiveOffAgain !== 0) {
    console.log(`FAIL: lastActiveLightCount after RE-OFF = ${r.lastActiveOffAgain}, expected 0`);
    pass = false;
  }
  if (r.totalOverlap < 16 * 9 * 24) {
    console.log(`FAIL: totalOverlap = ${r.totalOverlap}, expected ≥${16 * 9 * 24} (directional should reach every cluster)`);
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log("\nPASS: per-frame clustered-lighting dispatch works end-to-end + 0 device errors");
  }
  process.exit(pass ? 0 : 1);
})();
