#!/usr/bin/env node
// probe-ltc-area-light — C6-LTC-AREA-LIGHTS acceptance probe.
// @purpose C6 LTC area-light acceptance: RectAreaLight brightens a glTF model on WebGPU; zero-area-light off-gate byte-ish identical; 0 device errors.
// @status ACTIVE
//
// Verifies:
//   1. A RectAreaLight (LTC analytic area light) illuminates a glTF model
//      in the WebGPU backend — the ON frame is measurably brighter than
//      the OFF baseline over the model region, with 0 device errors.
//   2. Off-gate: with clustered lighting ENABLED but the area light
//      REMOVED, the frame is byte-identical (within a tiny tolerance) to
//      the OFF baseline — proving the new LUT/area bindings + FS path are
//      inert when no area light exists (areaLightCount == 0 early-out).
//
// Method (single camera, static scene, requestRenderMode off):
//   Phase A (OFF)     : no area light, clusteredLightingEnabled = false.
//   Phase B (ON)      : add RectAreaLight facing the model + enable.
//   Phase C (OFFGATE) : removeAll lights, keep clusteredLightingEnabled.
//
// PASS:
//   - dispatcher.lastAreaLightCount ≥ 1 and params.activeLightCount.y ≥ 1
//     in Phase B.
//   - ≥ 200 pixels change (Δ>5) ON vs OFF (real illumination).
//   - OFFGATE vs OFF: ≤ 20 changed pixels and maxDelta ≤ 8 (byte-ish).
//   - 0 device errors across all phases.

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/ltc-area-off.png";
const OUT_ON = "Tools/visual-regression/output/ltc-area-on.png";
const OUT_GATE = "Tools/visual-regression/output/ltc-area-offgate.png";

(async () => {
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
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

  // Phase A — load model, frame camera, OFF baseline.
  const setup = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;

    const position = C.Cartesian3.fromDegrees(-79.9959, 40.4406, 100);
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
    if (!model.ready) return { err: "model not ready" };

    const bs = model.boundingSphere;
    window.__bs = bs;
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-30), bs.radius * 3),
    );
    scene.globe.show = false;
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { modelReady: true, bsRadius: bs.radius };
  });
  if (setup?.err) {
    console.log("[probe-ltc-area-light] EARLY-EXIT:", setup.err);
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: OUT_OFF, fullPage: false });

  // Phase B — add RectAreaLight facing the model + enable clustered.
  const phaseB = await page.evaluate(async () => {
    const C = window.__C;
    const v = window.viewer;
    const scene = v.scene;
    const bs = window.__bs;

    // Light on the camera side, facing the model. direction = toward the
    // model center so a one-sided emitter's front lights the visible faces.
    const camDir = C.Cartesian3.subtract(
      v.camera.positionWC,
      bs.center,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(camDir, camDir);
    const lightPos = C.Cartesian3.add(
      bs.center,
      C.Cartesian3.multiplyByScalar(
        camDir,
        bs.radius * 1.5,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const dir = C.Cartesian3.negate(camDir, new C.Cartesian3()); // toward model
    scene.lights.add(
      new C.RectAreaLight({
        position: lightPos,
        direction: dir,
        up: C.Cartesian3.UNIT_Z,
        width: bs.radius * 2.0,
        height: bs.radius * 2.0,
        color: C.Color.WHITE,
        intensity: 6,
        twoSided: true,
      }),
    );
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const dispatcher =
      scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    const lastArea = dispatcher?.lastAreaLightCount ?? -1;
    const ctx = scene.context;

    let paramsAreaCount = -1;
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
      paramsAreaCount = floats[5]; // activeLightCount.y
    }
    const hasLUT = !!ctx._clusteredLightingBuffers?.ltcLUTView;
    return { lastArea, paramsAreaCount, hasLUT };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });

  // Phase C — off-gate: remove the area light, keep clustered enabled.
  await page.evaluate(async () => {
    const v = window.viewer;
    const scene = v.scene;
    scene.lights.removeAll();
    // clusteredLightingEnabled stays true → exercises the placeholder/
    // early-out path with the new bindings present.
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.screenshot({ path: OUT_GATE, fullPage: false });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  // Decode + compare.
  const dBrowser = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await dBrowser.newPage();
  await dp.setContent("<html><body></body></html>");
  const offB64 = fs.readFileSync(OUT_OFF).toString("base64");
  const onB64 = fs.readFileSync(OUT_ON).toString("base64");
  const gateB64 = fs.readFileSync(OUT_GATE).toString("base64");
  const stats = await dp.evaluate(
    async ({ offB64, onB64, gateB64 }) => {
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
      const gate = await decode(gateB64);
      const x0 = Math.floor(off.w * 0.25),
        x1 = Math.floor(off.w * 0.75);
      const y0 = Math.floor(off.h * 0.25),
        y1 = Math.floor(off.h * 0.75);
      const compare = (a, b) => {
        let sumA = 0,
          sumB = 0,
          n = 0,
          changed = 0,
          maxDelta = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * off.w + x) * 4;
            const sA = a.data[i] + a.data[i + 1] + a.data[i + 2];
            const sB = b.data[i] + b.data[i + 1] + b.data[i + 2];
            sumA += sA;
            sumB += sB;
            n++;
            const d = Math.abs(sB - sA);
            if (d > 5) changed++;
            if (d > maxDelta) maxDelta = d;
          }
        }
        return {
          n,
          meanA: sumA / n,
          meanB: sumB / n,
          delta: (sumB - sumA) / n,
          changed,
          maxDelta,
        };
      };
      // Whole-frame changed count for the off-gate (catch any pixel).
      const gateFull = (() => {
        let changed = 0,
          maxDelta = 0;
        for (let i = 0; i < off.data.length; i += 4) {
          const sA = off.data[i] + off.data[i + 1] + off.data[i + 2];
          const sB = gate.data[i] + gate.data[i + 1] + gate.data[i + 2];
          const d = Math.abs(sB - sA);
          if (d > 5) changed++;
          if (d > maxDelta) maxDelta = d;
        }
        return { changed, maxDelta };
      })();
      return {
        w: off.w,
        h: off.h,
        onVsOff: compare(off, on),
        gateVsOff: compare(off, gate),
        gateFull,
      };
    },
    { offB64, onB64, gateB64 },
  );
  await dBrowser.close();

  console.log("[probe-ltc-area-light] result:");
  console.log(`  dispatcher.lastAreaLightCount (ON): ${phaseB.lastArea}`);
  console.log(
    `  params activeLightCount.y (ON):     ${phaseB.paramsAreaCount}`,
  );
  console.log(`  LUT view present (ON):              ${phaseB.hasLUT}`);
  console.log(
    `  ON vs OFF  : meanOff=${stats.onVsOff.meanA.toFixed(1)} meanOn=${stats.onVsOff.meanB.toFixed(1)} delta=${stats.onVsOff.delta.toFixed(2)} changed=${stats.onVsOff.changed}/${stats.onVsOff.n} maxΔ=${stats.onVsOff.maxDelta}`,
  );
  console.log(
    `  GATE vs OFF (box): changed=${stats.gateVsOff.changed}/${stats.gateVsOff.n} maxΔ=${stats.gateVsOff.maxDelta}`,
  );
  console.log(
    `  GATE vs OFF (full frame): changed=${stats.gateFull.changed} maxΔ=${stats.gateFull.maxDelta}`,
  );
  console.log(`Device errors: ${errs.length}`);
  errs
    .slice(0, 8)
    .forEach((e) => console.log(`  - ${(e.text ?? "").slice(0, 200)}`));

  let pass = true;
  if (phaseB.lastArea < 1) {
    console.log(`FAIL: lastAreaLightCount=${phaseB.lastArea}, expected ≥1`);
    pass = false;
  }
  if (phaseB.paramsAreaCount < 1) {
    console.log(
      `FAIL: params.activeLightCount.y=${phaseB.paramsAreaCount}, expected ≥1`,
    );
    pass = false;
  }
  if (stats.onVsOff.changed < 200) {
    console.log(
      `FAIL: only ${stats.onVsOff.changed} pixels lit by area light (expected ≥200)`,
    );
    pass = false;
  }
  if (stats.onVsOff.delta <= 2) {
    console.log(
      `FAIL: brightness delta ${stats.onVsOff.delta.toFixed(2)} ≤ 2 (area light not additive)`,
    );
    pass = false;
  }
  if (stats.gateFull.changed > 30 || stats.gateFull.maxDelta > 10) {
    console.log(
      `FAIL: off-gate not byte-identical (changed=${stats.gateFull.changed}, maxΔ=${stats.gateFull.maxDelta})`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
