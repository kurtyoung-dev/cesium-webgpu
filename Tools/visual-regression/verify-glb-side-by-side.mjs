#!/usr/bin/env node
/**
 * Side-by-side comparison: render CesiumAir.glb on WebGL and WebGPU,
 * compare. WebGL is the reference; WebGPU renders 3 tiny dots, so we
 * need to know what the model SHOULD look like.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:8080";

async function captureModel(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 400));
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    const lon = -75.61, lat = 40.04, h = 100.0;
    const model = await C.Model.fromGltfAsync({
      url: "/Apps/SampleData/models/CesiumAir/Cesium_Air.glb",
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(lon, lat, h)),
      scale: 4.0,
    });
    v.scene.primitives.add(model);

    // Wait for model to load
    while (!model.ready) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Aim camera at the model from above with a tilt
    const offset = new C.HeadingPitchRange(0, -C.Math.PI_OVER_FOUR, model.boundingSphere.radius * 4);
    v.camera.viewBoundingSphere(model.boundingSphere, offset);

    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const bs = model.boundingSphere;
    const cam = v.camera;
    const distToModel = C.Cartesian3.distance(cam.positionWC, bs.center);

    // Pixel histogram
    const canvas = v.canvas;
    const w = canvas.width, h2 = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h2;
    tmp.getContext("2d").drawImage(canvas, 0, 0);
    const px = tmp.getContext("2d").getImageData(0, 0, w, h2).data;
    const buckets = {};
    for (let i = 0; i < px.length; i += 16) {
      const k = `${px[i]},${px[i+1]},${px[i+2]}`;
      buckets[k] = (buckets[k] || 0) + 1;
    }
    const top = Object.entries(buckets).sort((a,b)=>b[1]-a[1]).slice(0, 8);

    return {
      modelReady: model.ready,
      modelBSCenter: [bs.center.x, bs.center.y, bs.center.z],
      modelBSRadius: bs.radius,
      cameraPos: [cam.positionWC.x, cam.positionWC.y, cam.positionWC.z],
      distToModel,
      cameraHeight: cam.positionCartographic?.height,
      modelMatrix: Array.from(model.modelMatrix),
      modelScale: model.scale,
      topColors: top,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  await browser.close();
  return { result, errors, screenshot: buf };
}

(async () => {
  const fs = await import("fs");
  console.log("=== WebGL ===");
  const wgl = await captureModel("webgl");
  fs.writeFileSync("Tools/visual-regression/output/glb-webgl.png", wgl.screenshot);
  console.log(JSON.stringify(wgl.result, null, 2));
  if (wgl.errors.length) console.log(`WebGL errors (${wgl.errors.length}):`, wgl.errors.slice(0, 3));

  console.log("\n=== WebGPU ===");
  const wgp = await captureModel("webgpu");
  fs.writeFileSync("Tools/visual-regression/output/glb-webgpu.png", wgp.screenshot);
  console.log(JSON.stringify(wgp.result, null, 2));
  if (wgp.errors.length) console.log(`WebGPU errors (${wgp.errors.length}):`, wgp.errors.slice(0, 3));
})();
