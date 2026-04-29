#!/usr/bin/env node
/**
 * BUG-11 imagery probe — captures the per-tile imagery diagnostic
 * dump from WebGPUGlobeSurfaceRenderer with debugShowImageryProbe
 * enabled, plus a canvas pixel sample to confirm whether anything is
 * being rendered. Prints the dump so the operator can narrow down on
 * one of the three hypothesized root causes:
 *
 *   A) Reprojection clear alpha=0 collapsing tex.a * effectiveAlpha.
 *      (Defensively fixed in WebGPUImageryReprojection — alpha=1 — but
 *      verify nothing in the pipeline reintroduces alpha=0.)
 *   B) tileImagery.textureCoordinateRectangle = (0,0,0,0) instead of
 *      undefined; texCoordsAlpha mask returns 0 for every fragment.
 *   C) Stale view in _imageryTextureCache after the underlying
 *      GPUTexture was recreated.
 *
 * Usage:
 *   node Tools/visual-regression/bug-11-imagery-probe.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

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
  const page = await browser.newPage();

  const consoleMessages = [];
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  console.log(`Loading ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!window.viewer, {
    timeout: 90_000,
    polling: 500,
  });

  // Settle, fly to a place with imagery, enable probe, render some frames.
  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    // Enable the probe BEFORE the first imagery loads so we catch the
    // reproject-texture path while it's still in flight (it's a
    // one-shot, runs once per imagery instance when state transitions
    // TEXTURE_LOADED → READY).
    v.scene.debugShowImageryProbe = true;

    // Bing Maps Aerial baseline by default.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Move camera deeper to force new tiles and a fresh reprojection.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 1_000_000),
    });
    for (let i = 0; i < 30; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    v.scene.debugShowImageryProbe = false;

    // Sample canvas pixels via Cesium's own screenshot method, which
    // handles WebGPU correctly. drawImage of a WebGPU canvas to a 2D
    // context can fail silently and return uniform black.
    const canvas = v.scene.canvas;
    let canvasSample = null;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      // Decode PNG via offscreen canvas (this works even for WebGPU
      // because toDataURL forces the GPU to flush to the canvas).
      const img = new Image();
      img.src = dataUrl;
      await new Promise((r) => (img.onload = r));
      const offscreen = document.createElement("canvas");
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      const ctx = offscreen.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const w = offscreen.width;
      const h = offscreen.height;
      const samples = [];
      for (let i = 0; i < 25; i++) {
        const x = Math.floor((i / 25) * w);
        const y = Math.floor((i / 25) * h);
        const px = ctx.getImageData(x, y, 1, 1).data;
        samples.push([px[0], px[1], px[2], px[3]]);
      }
      const avg = samples.reduce(
        (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]],
        [0, 0, 0, 0],
      );
      canvasSample = {
        method: "toDataURL+Image",
        avg: avg.map((c) => Math.round(c / samples.length)),
        nonBlackCount: samples.filter(
          (s) => s[0] > 5 || s[1] > 5 || s[2] > 5,
        ).length,
        firstFew: samples.slice(0, 5),
        dataUrlLen: dataUrl.length,
      };
    } catch (e) {
      canvasSample = { error: e.message };
    }
    return {
      rendererType: v.scene.context.rendererType,
      canvasSize: [canvas.width, canvas.height],
      canvasSample,
    };
  });

  await new Promise((r) => setTimeout(r, 1500));
  await browser.close();

  console.log("\n=== Result ===");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== Imagery probe dump ===");
  const tileLogs = consoleMessages.filter((m) =>
    m.text.startsWith("[WebGPU:GlobeTile]"),
  );
  for (const l of tileLogs.slice(0, 60)) {
    console.log(l.text);
  }

  console.log("\n=== BUG-11 reproject diagnostics ===");
  const reprojectLogs = consoleMessages.filter((m) =>
    m.text.startsWith("[BUG-11"),
  );
  for (const m of reprojectLogs.slice(0, 30)) {
    console.log(`[${m.type}] ${m.text}`);
  }

  console.log("\n=== Errors / warnings (non-BUG-11) ===");
  for (const m of consoleMessages.filter(
    (m) =>
      (m.type === "error" || m.type === "warning") &&
      !m.text.startsWith("[BUG-11"),
  )) {
    console.log(`[${m.type}] ${m.text.slice(0, 300)}`);
  }
})();
