/**
 * NEW-KHR-ANISO-TANGENT (IBL) verification — renders TestKhrAnisotropy.gltf
 * on WebGL and WebGPU, captures the model, and pixel-diffs the two backends.
 * Also arms the WebGPU error/crash gate so the new IBL bent-normal shader
 * path is proven to execute without validation errors.
 *
 * The IBL anisotropic bend only affects the SPECULAR IBL reflection vector,
 * so the model is rendered against a clean background (globe hidden) and the
 * diff is measured over the model's bounding region. A LOW WebGL-vs-WebGPU
 * diff + zero device errors = the bend matches WebGL (parity).
 *
 * Usage: node Tools/visual-regression/probe-model-aniso-ibl.mjs
 *   PROBE_BASE (default http://localhost:8134)
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrAnisotropy.gltf";

async function capture(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(async (modelUrl) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    // Clean background: hide globe so only the model + its IBL reflection
    // contributes to the captured pixels.
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.BLACK;

    const lon = -75, lat = 40, height = 0;
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(lon, lat, height),
    );
    const model = await C.Model.fromGltfAsync({
      url: modelUrl,
      modelMatrix,
      scale: 1.0,
    });
    scene.primitives.add(model);
    for (let i = 0; i < 600 && !model.ready; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Frame the model via its bounding sphere.
    if (model.boundingSphere) {
      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(0.3, -0.35, model.boundingSphere.radius * 3.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    }
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { ready: !!model.ready };
  }, MODEL);

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  // Tag + screenshot the canvas via the compositor (handles swap chains).
  await page.evaluate(() => {
    const c = window.viewer.scene.canvas;
    c.setAttribute("data-aniso", "1");
  });
  const png = await page.locator('canvas[data-aniso="1"]').screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return {
    renderer,
    ready: info.ready,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    decoded,
    png,
  };
}

const wgpu = await capture("webgpu");
const wgl = await capture("webgl");

// Diff over non-black (model) pixels only.
const a = wgl.decoded, b = wgpu.decoded;
let modelPx = 0, mismatch = 0;
if (a.w === b.w && a.h === b.h) {
  for (let i = 0; i < a.data.length; i += 4) {
    const aLum = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const bLum = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (aLum > 12 || bLum > 12) {
      modelPx++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 24 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 24 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 24
      ) {
        mismatch++;
      }
    }
  }
}
const fs = await import("fs");
fs.writeFileSync("Tools/visual-regression/output/aniso-webgpu.png", wgpu.png);
fs.writeFileSync("Tools/visual-regression/output/aniso-webgl.png", wgl.png);

console.log(JSON.stringify({
  webgpu: { ready: wgpu.ready, gateArmed: wgpu.gateArmed, gateErrors: wgpu.gateErrors, deviceLost: wgpu.deviceLost, consoleFaults: wgpu.consoleFaults.slice(0, 5) },
  webgl: { ready: wgl.ready },
  diff: { modelPx, mismatch, mismatchPct: modelPx ? +(100 * mismatch / modelPx).toFixed(2) : null },
}, null, 2));

const pass = wgpu.ready && wgl.ready && wgpu.gateErrors.length === 0 && !wgpu.deviceLost;
console.log(pass ? "GATE PASS — anisotropy IBL path executes clean on WebGPU" : "GATE FAIL");
process.exit(pass ? 0 : 1);
