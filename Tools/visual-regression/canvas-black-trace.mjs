#!/usr/bin/env node
/**
 * Canvas-black trace probe. Loads the WebGPU viewer, renders 60 frames,
 * captures ALL `[WebGPU:` console messages plus any pageerrors / warnings.
 * Goal: pin down whether globe commands are being submitted, whether the
 * render pass exists when they execute, and whether validation rejects
 * any of them.
 */
import { chromium } from "playwright";

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
  const page = await browser.newPage();
  const messages = [];
  page.on("pageerror", (e) =>
    messages.push({ type: "pageerror", text: e.message }),
  );
  page.on("console", (m) => {
    messages.push({ type: m.type(), text: m.text() });
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
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

    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Capture some scene state
    const scene = v.scene;
    const ctx = scene.context;
    const fbo = ctx.sceneFramebuffer || ctx._sceneFramebuffer;
    const dump = {
      isWebGPU: !!ctx.isWebGPU,
      hasDevice: !!ctx._device,
      canvasFormat: ctx.canvasFormat || ctx.presentationFormat || null,
      depthFormat: ctx.depthFormat || null,
      hasSceneFramebuffer: !!fbo,
      sceneFramebuffer: fbo
        ? {
            colorFormat: fbo.colorFormat,
            depthFormat: fbo.depthFormat,
            width: fbo.width,
            height: fbo.height,
          }
        : null,
      frameNumber: scene.frameState?.frameNumber,
      commandList: scene.frameState?.commandList?.length || 0,
    };
    // Capture canvas pixels
    const canvas = scene.canvas;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const dataUrl = canvas.toDataURL("image/png");
    const img = new Image();
    img.src = dataUrl;
    await new Promise((r) => (img.onload = r));
    const ctx2 = off.getContext("2d");
    ctx2.drawImage(img, 0, 0);
    const sum = [0, 0, 0, 0];
    let nz = 0;
    for (let y = 0; y < off.height; y += 32) {
      for (let x = 0; x < off.width; x += 32) {
        const px = ctx2.getImageData(x, y, 1, 1).data;
        sum[0] += px[0];
        sum[1] += px[1];
        sum[2] += px[2];
        sum[3] += px[3];
        if (px[0] + px[1] + px[2] > 5) nz++;
      }
    }
    dump.canvasAvg = sum.map((v) =>
      Math.round(
        v /
          Math.max(1, Math.floor(off.width / 32) * Math.floor(off.height / 32)),
      ),
    );
    dump.canvasNonBlack = nz;

    return dump;
  });

  await browser.close();

  console.log("=== Scene state ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("\n=== WebGPU console messages ===");
  for (const m of messages) {
    const t = m.text;
    if (
      t.startsWith("[WebGPU") ||
      t.startsWith("[CesiumJS") ||
      t.includes("validation") ||
      t.includes("invalid") ||
      m.type === "error" ||
      m.type === "pageerror"
    ) {
      console.log(`  [${m.type}] ${t.slice(0, 400)}`);
    }
  }
})();
