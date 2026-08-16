#!/usr/bin/env node
// Control for probe-hiz-occlusion-consumer.mjs.
// @purpose Control leg: same 3600-box scene with gpuCullingHint='never' to prove any dense-scene failure is the Hi-Z compute path, not primitive count
// @status ACTIVE
//
// Same dense 3600-box WebGPU scene, but sets scene.gpuCullingHint = 'never'
// BEFORE rendering. That short-circuits the Hi-Z / gpuCuller / gpuSort
// activation gates to false (see WebGPUSceneRenderer `forceOff`). If the
// black-screen + GPU validation errors DISAPPEAR with the gate forced off,
// the Hi-Z compute-pass path is conclusively the cause (not just "3600
// primitives is too many for WebGPU").
//
// Output: Tools/visual-regression/output/hiz-occlusion-control-webgpu.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";
const GRID = Number(process.env.PROBE_GRID || 60);

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
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  const buildInfo = await page.evaluate(async (grid) => {
    const Cesium = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    // *** The control knob: force all high-density GPU gates OFF. ***
    scene.gpuCullingHint = "never";
    const prims = scene.primitives;
    const lon0 = -105.0,
      lat0 = 39.0,
      span = 0.6;
    const boxDim = new Cesium.Cartesian3(6000.0, 6000.0, 90000.0);
    const geom = Cesium.BoxGeometry.fromDimensions({
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      dimensions: boxDim,
    });
    let created = 0;
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const lon = lon0 + (i / grid) * span;
        const lat = lat0 + (j / grid) * span;
        const height = 50000 + ((i * 7 + j * 13) % 11) * 8000;
        const pos = Cesium.Cartesian3.fromDegrees(lon, lat, height);
        const inst = new Cesium.GeometryInstance({
          geometry: geom,
          modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(pos),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromHsl((created % 360) / 360, 0.7, 0.55, 1.0),
            ),
          },
        });
        prims.add(
          new Cesium.Primitive({
            geometryInstances: inst,
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: false,
              closed: true,
            }),
            asynchronous: false,
          }),
        );
        created++;
      }
    }
    const center = Cesium.Cartesian3.fromDegrees(
      lon0 + span / 2,
      lat0 + span / 2,
      50000,
    );
    scene.camera.lookAt(
      center,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(20),
        Cesium.Math.toRadians(-18),
        180000,
      ),
    );
    scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    return {
      created,
      primCount: prims.length,
      gpuCullingHint: scene.gpuCullingHint,
    };
  }, GRID);

  const stats = await page.evaluate(async () => {
    const scene = window.viewer.scene;
    for (let i = 0; i < 180; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const renderer = scene._alternateSceneRenderer;
    const s =
      renderer && renderer.getHighDensityCullStats
        ? renderer.getHighDensityCullStats()
        : null;
    return s
      ? { hiZActive: s.hiZ.activeAnyFrustum, hiZDispatches: s.hiZ.dispatches }
      : null;
  });

  await page.waitForTimeout(500);
  const dataUrl = await page.evaluate(async () => {
    const v = window.viewer;
    v.scene.render();
    await new Promise((r) => requestAnimationFrame(r));
    v.scene.render();
    return v.scene.canvas.toDataURL("image/png");
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "hiz-occlusion-control-webgpu.png");
  fs.writeFileSync(
    outPath,
    Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
  );

  const pixelStats = await page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (lum > 12) nonBg++;
    }
    return { total: c.width * c.height, nonBg };
  }, dataUrl);

  const gate = await collectGateErrors(page);
  await browser.close();

  console.log("[control] built:", JSON.stringify(buildInfo));
  console.log("[control] stats:", JSON.stringify(stats));
  console.log(
    `[control] pixels: nonBg=${pixelStats.nonBg}/${pixelStats.total} (${((100 * pixelStats.nonBg) / pixelStats.total).toFixed(1)}%)`,
  );
  console.log("[control] png:", outPath);
  console.log(
    `[control] gate: errors=${gate.errors.length} deviceLost=${gate.deviceLost} | consoleErrors=${consoleErrors.length}`,
  );
})();
