#!/usr/bin/env node
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

(async () => {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  // Capture WebGPU
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const webgpuShot = await page.screenshot({ omitBackground: false });
  fs.writeFileSync("Tools/visual-regression/output/webgpu-current.png", webgpuShot);
  console.log("WebGPU shot saved:", webgpuShot.length, "bytes");

  // Capture WebGL
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const webglShot = await page.screenshot({ omitBackground: false });
  fs.writeFileSync("Tools/visual-regression/output/webgl-current.png", webglShot);
  console.log("WebGL shot saved:", webglShot.length, "bytes");

  await browser.close();
})();
