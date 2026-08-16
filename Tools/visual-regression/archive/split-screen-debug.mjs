#!/usr/bin/env node
import { chromium } from "playwright";

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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log(`[pageerror]`, e.message));

  await page.goto(
    "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
    { waitUntil: "networkidle", timeout: 60_000 },
  );

  // Click "Launch Both"
  await page.click("#btnLaunch");

  // Wait for both viewers to come up
  await page.waitForFunction(
    () => !!(window.webglViewer && window.webgpuViewer),
    null,
    { timeout: 60_000 },
  );

  // Render some frames
  await page.evaluate(async () => {
    for (let i = 0; i < 240; i++) {
      window.webglViewer.scene.render();
      window.webgpuViewer.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  // Capture both canvases
  const result = await page.evaluate(() => {
    function grab(c) {
      const off = new OffscreenCanvas(c.width, c.height);
      const ctx = off.getContext("2d");
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    }
    const wgl = window.webglViewer.scene.canvas;
    const wgpu = window.webgpuViewer.scene.canvas;
    const a = grab(wgl);
    const b = grab(wgpu);

    let diffPx = 0;
    let total = 0;
    let webglNonBlack = 0;
    let webgpuNonBlack = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      total++;
      const r1 = a.data[i],
        g1 = a.data[i + 1],
        b1 = a.data[i + 2];
      const r2 = b.data[i],
        g2 = b.data[i + 1],
        bz = b.data[i + 2];
      if (r1 + g1 + b1 > 30) webglNonBlack++;
      if (r2 + g2 + bz > 30) webgpuNonBlack++;
      const dr = Math.abs(r1 - r2);
      const dg = Math.abs(g1 - g2);
      const db = Math.abs(b1 - bz);
      if (dr > 16 || dg > 16 || db > 16) diffPx++;
    }
    return {
      total,
      diffPx,
      diffRatio: diffPx / total,
      webglNonBlackRatio: webglNonBlack / total,
      webgpuNonBlackRatio: webgpuNonBlack / total,
      width: wgl.width,
      height: wgl.height,
    };
  });

  console.log("Split-screen pixel result:", result);

  await browser.close();
})();
