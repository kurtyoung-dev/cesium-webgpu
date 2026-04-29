#!/usr/bin/env node
/**
 * Canvas-black-screen narrow-down probe. Tests three render paths and
 * reports which (if any) produce non-black canvas pixels:
 *
 *   1. Default WebGPU render path (multi-stage post-process chain).
 *   2. `debugShowDepthAsColor` — bypasses the chain with a single
 *      depth-overlay pass.
 *   3. `debugShowFrustums` — bypasses with a frustum-tint pass.
 *
 * If 2 or 3 produce non-black output but 1 doesn't, the bug is in the
 * post-process chain. If all three produce black, the bug is in
 * canvas swap-chain wiring (or our toDataURL test infra).
 *
 * Usage:
 *   node Tools/visual-regression/canvas-black-narrow.mjs
 */
import { chromium } from "playwright";

const BASE = "http://localhost:8080";

async function probe(label, modeFn) {
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
  const allMsgs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    allMsgs.push({ type: m.type(), text: m.text() });
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForFunction(() => !!window.viewer, {
    timeout: 90_000,
    polling: 500,
  });

  const result = await page.evaluate(async (modeName) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.5, 40.0, 5_000_000),
    });

    if (modeName === "depthAsColor") {
      v.scene.debugShowDepthAsColor = true;
    } else if (modeName === "frustums") {
      v.scene.debugShowFrustums = true;
    } else if (modeName === "forceIdentity") {
      // Force identity blit (skip tonemap and other stages) — if this
      // is non-black while default is black, the chain is the culprit.
      const pp = v.scene.context.postProcessPipeline;
      if (pp) pp._diagForceIdentity = true;
    }

    for (let i = 0; i < 90; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const canvas = v.scene.canvas;
    let result = {};
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
    } catch (e) {
      result.error = e.message;
    }
    return result;
  }, label);

  await browser.close();
  return { result, errors: errors.length, allMsgs };
}

(async () => {
  for (const mode of ["default", "depthAsColor", "frustums", "forceIdentity"]) {
    const { result, errors, allMsgs } = await probe(mode);
    console.log(
      `${mode.padEnd(14)}: nonBlack=${result.nonBlackCount}/50  avg=${result.avg}  errs=${errors}`,
    );
    for (const m of allMsgs) {
      if (m.text.startsWith("[CANVAS-BLACK") || m.text.includes("PostProcess]") || m.text.includes("MISSING")) {
        console.log(`   ↳ [${m.type}] ${m.text.slice(0, 250)}`);
      }
    }
    // Print warnings/errors with anything that mentions WebGPU or validation
    for (const m of allMsgs) {
      if (
        (m.type === "warning" || m.type === "error") &&
        (m.text.toLowerCase().includes("invalid") ||
          m.text.toLowerCase().includes("validation") ||
          m.text.toLowerCase().includes("pipeline") ||
          m.text.toLowerCase().includes("bind") ||
          m.text.toLowerCase().includes("vertex"))
      ) {
        console.log(`   ⚠️ [${m.type}] ${m.text.slice(0, 350)}`);
      }
    }
  }
})();
