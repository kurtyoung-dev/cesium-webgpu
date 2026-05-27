#!/usr/bin/env node
// Probe-clustered-visible — Slice 5d Batch 153 verification.
//
// Confirms the Forward+ clustered lighting consumer (ModelPBRComplete +
// the ClusteredLighting FS chunk reading @group(3) bindings 18..22 via
// the effects bind group) actually contributes per-pixel light to a
// glTF model.
//
// Method:
//   1. Load CesiumViewer, drop a glTF model at a known position and
//      zoom the camera to its bounding sphere.
//   2. Capture a baseline page.screenshot with
//      `scene.clusteredLightingEnabled = false` (no lights).
//   3. Add a bright PointLight at the model's bounding sphere, enable
//      clustered lighting, capture a second screenshot.
//   4. Decode both PNGs and compute the mean brightness over the
//      central canvas region; the ON sample should be brighter than
//      OFF by a measurable margin.
//
// PASS criteria:
//   - 0 device errors across both phases.
//   - Brightness delta on > off by ≥ ~5 LSBs (a no-op consumer
//     would produce a 0 delta).

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/clustered-visible-off.png";
const OUT_ON = "Tools/visual-regression/output/clustered-visible-on.png";

(async () => {
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", (e) => console.log(`>> pageerror: ${e.message}`));
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

  // Phase 1 — load model + frame the camera.
  const setupResult = await page.evaluate(async () => {
    const mod = await import("/Build/CesiumUnminified/index.js");
    const C = mod;
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;

    const lon = -79.9959;
    const lat = 40.4406;
    const height = 100;
    const position = C.Cartesian3.fromDegrees(lon, lat, height);

    const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
      position,
      new C.HeadingPitchRoll(0, 0, 0),
    );
    const model = scene.primitives.add(
      await C.Model.fromGltfAsync({
        url: "/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
        modelMatrix,
        scale: 5.0,
      }),
    );
    window.__model = model;

    for (let i = 0; i < 240; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (model.ready) break;
    }
    if (!model.ready) return { earlyExitErr: "model not ready" };

    const bs = model.boundingSphere;
    window.__bs = bs;
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-30), bs.radius * 3),
    );

    // Disable globe so the background is uniform (sky) and any change
    // we observe must come from the model lighting, not terrain
    // shading drift.
    scene.globe.show = false;

    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { modelReady: true, bsRadius: bs.radius };
  });
  if (setupResult?.earlyExitErr) {
    console.log("[probe-clustered-visible] EARLY-EXIT:", setupResult.earlyExitErr);
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: OUT_OFF, fullPage: false });

  // Phase 2 — add light + enable clustered + re-screenshot.
  const phase2 = await page.evaluate(async () => {
    const C = window.__C;
    const v = window.viewer;
    const scene = v.scene;
    const bs = window.__bs;

    // Place the light just in front of the model on the camera side,
    // close to the surface. Pointing from the camera direction
    // guarantees camera-visible front faces have NdotL > 0 (avoids the
    // failure mode where an arbitrary ECEF offset lights hidden faces —
    // local "up" near Pittsburgh is a diagonal ECEF vector, not +Z).
    // Close distance keeps the 1/dist² falloff from dimming the
    // contribution below the noise floor; high intensity + large range
    // make the per-pixel diffuse+specular unambiguous.
    const camDir = C.Cartesian3.subtract(
      v.camera.positionWC,
      bs.center,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(camDir, camDir);
    const lightPos = C.Cartesian3.add(
      bs.center,
      C.Cartesian3.multiplyByScalar(camDir, bs.radius * 1.5, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.lights.add(
      new C.PointLight({
        position: lightPos,
        color: C.Color.WHITE,
        intensity: 500,
        range: bs.radius * 100,
      }),
    );
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const dispatcher =
      v.scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    const lastActive = dispatcher?.lastActiveLightCount ?? -1;
    const ctx = scene.context;
    const stashKeys = ctx._clusteredLightingBuffers
      ? Object.keys(ctx._clusteredLightingBuffers).sort().join(",")
      : "<absent>";

    let paramsActiveCount = -1;
    if (dispatcher && ctx._clusteredLightingBuffers) {
      const device = ctx._device;
      const staging = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(
        ctx._clusteredLightingBuffers.params,
        0,
        staging,
        0,
        32,
      );
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const floats = new Float32Array(staging.getMappedRange().slice());
      staging.unmap();
      paramsActiveCount = floats[4];
    }

    return { lastActive, stashKeys, paramsActiveCount };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  // Decode both PNGs and compute mean brightness across a central window.
  const decoderBrowser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });
  const dp = await decoderBrowser.newPage();
  await dp.setContent("<html><body></body></html>");
  const offB64 = fs.readFileSync(OUT_OFF).toString("base64");
  const onB64 = fs.readFileSync(OUT_ON).toString("base64");
  const stats = await dp.evaluate(
    async ({ offB64, onB64 }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const off = await decode(offB64);
      const on = await decode(onB64);
      // Central 50% × 50% — should cover the model bounding sphere
      // after the camera frame.
      const x0 = Math.floor(off.w * 0.25);
      const x1 = Math.floor(off.w * 0.75);
      const y0 = Math.floor(off.h * 0.25);
      const y1 = Math.floor(off.h * 0.75);
      let sumOff = 0,
        sumOn = 0,
        n = 0;
      // Also count pixels that changed meaningfully — robust to camera
      // jitter (entire-frame delta).
      let changed = 0;
      let maxDelta = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * off.w + x) * 4;
          const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
          const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
          sumOff += sOff;
          sumOn += sOn;
          n += 1;
          const d = Math.abs(sOn - sOff);
          if (d > 5) changed += 1;
          if (d > maxDelta) maxDelta = d;
        }
      }
      return {
        w: off.w,
        h: off.h,
        boxX: [x0, x1],
        boxY: [y0, y1],
        n,
        meanOff: sumOff / n,
        meanOn: sumOn / n,
        delta: (sumOn - sumOff) / n,
        changedPx: changed,
        maxDelta,
      };
    },
    { offB64, onB64 },
  );
  await decoderBrowser.close();

  console.log("[probe-clustered-visible] result:");
  console.log(`  dispatcher.lastActiveLightCount when ON: ${phase2.lastActive}`);
  console.log(
    `  context._clusteredLightingBuffers keys: ${phase2.stashKeys}`,
  );
  console.log(
    `  params buffer activeLightCount (GPU readback): ${phase2.paramsActiveCount}`,
  );
  console.log(
    `  screenshot box: x=[${stats.boxX[0]}..${stats.boxX[1]}] y=[${stats.boxY[0]}..${stats.boxY[1]}] (image ${stats.w}x${stats.h}, n=${stats.n} px)`,
  );
  console.log(`  mean RGB-sum OFF: ${stats.meanOff.toFixed(2)}`);
  console.log(`  mean RGB-sum ON:  ${stats.meanOn.toFixed(2)}`);
  console.log(`  delta (on − off): ${stats.delta.toFixed(2)}`);
  console.log(`  changed pixels (Δ>5): ${stats.changedPx} / ${stats.n}`);
  console.log(`  max single-pixel delta: ${stats.maxDelta}`);
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
  if (phase2.lastActive < 1) {
    console.log(
      `FAIL: dispatcher.lastActiveLightCount = ${phase2.lastActive}, expected ≥1`,
    );
    pass = false;
  }
  if (stats.changedPx < 50) {
    console.log(
      `FAIL: only ${stats.changedPx} pixels changed (max delta ${stats.maxDelta}); expected ≥50 changed pixels`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: visible per-pixel clustered lighting contribution + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
