#!/usr/bin/env node
/**
 * Sanity check: load CesiumViewer in BOTH WebGL and WebGPU modes,
 * sample the canvas, and report whether each renderer produces
 * non-black pixels. The intent is to validate the test infra (do
 * non-black pixels reach toDataURL?) before drawing conclusions
 * about the canvas-black-screen bug.
 *
 * Usage:
 *   node Tools/visual-regression/webgl-vs-webgpu-pixel-check.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";

async function probe(rendererMode) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererMode}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!window.viewer, {
    timeout: 90_000,
    polling: 500,
  });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const canvas = v.scene.canvas;
    let result = { rendererType: v.scene.context.rendererType };
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const img = new Image();
      img.src = dataUrl;
      await new Promise((r) => (img.onload = r));
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const samples = [];
      for (let i = 0; i < 50; i++) {
        const x = Math.floor((i / 50) * off.width);
        const y = Math.floor((i / 50) * off.height);
        const px = ctx.getImageData(x, y, 1, 1).data;
        samples.push([px[0], px[1], px[2], px[3]]);
      }
      const sum = samples.reduce(
        (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]],
        [0, 0, 0, 0],
      );
      result.avg = sum.map((c) => Math.round(c / samples.length));
      result.nonBlackCount = samples.filter(
        (s) => s[0] > 5 || s[1] > 5 || s[2] > 5,
      ).length;
      result.dataUrlLen = dataUrl.length;
    } catch (e) {
      result.error = e.message;
    }
    return result;
  });

  await browser.close();
  return { result, errors };
}

(async () => {
  console.log("WebGL probe...");
  const webgl = await probe("webgl");
  console.log("WebGL:", JSON.stringify(webgl.result, null, 2));
  console.log("Errors:", webgl.errors.length);

  console.log("\nWebGPU probe...");
  const webgpu = await probe("webgpu");
  console.log("WebGPU:", JSON.stringify(webgpu.result, null, 2));
  console.log("Errors:", webgpu.errors.length);

  console.log("\n=== Summary ===");
  console.log(
    `WebGL:  nonBlack=${webgl.result.nonBlackCount}/50 avg=${webgl.result.avg}`,
  );
  console.log(
    `WebGPU: nonBlack=${webgpu.result.nonBlackCount}/50 avg=${webgpu.result.avg}`,
  );
})();
