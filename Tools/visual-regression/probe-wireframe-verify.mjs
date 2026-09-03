#!/usr/bin/env node
/**
 * Verify the WebGPU globe debug WIREFRAME fix: with debugShowWireframe on, the
 * WebGPU globe should draw an IMAGERY-COLORED triangle line-mesh (matching
 * WebGL), NOT a black screen. Bug was: the wireframe path fed an EMPTY imagery
 * layer set so fragmentMain's composite was skipped and lines emitted the navy
 * base color (~black). Fix feeds the ready imagery layers.
 * @purpose Acceptance for the WebGPU debugShowWireframe fix: wireframe draws an imagery-colored line mesh (not black), settled by frame-signature stability.
 * @status ACTIVE
 *
 * Settle by FRAME-SIGNATURE STABILITY (Batch 350 lesson): the WebGPU wireframe
 * line-list pipeline materializes over many frames; coverage/tilesLoaded lie.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { attachPageDiagnostics } from "../lib/attach-page-diagnostics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");

async function boot(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1000 },
  });
  // Keep only console errors (drop log/warning/info) and every page error —
  // the same selection the hand-rolled listener pair made.
  const diagnostics = attachPageDiagnostics(page, {
    filter: (record) => record.type === "error" || record.type === "pageerror",
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });
  return { page, diagnostics };
}

/**
 * Re-derive the original `["text" | "PAGEERR:" + text, ...]` string list,
 * merged back into arrival order by seq (not timestamp — millisecond
 * resolution ties same-tick console/pageerror pairs; attachPageDiagnostics
 * keeps console and page errors in two arrays, the hand-rolled version
 * pushed both into one).
 */
function errorStrings(diagnostics) {
  return [...diagnostics.console, ...diagnostics.errors]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => (r.type === "pageerror" ? "PAGEERR:" + r.text : r.text));
}

async function setup(page, wireframe) {
  return await page.evaluate(
    async ({ wireframe }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.requestRenderMode = false;
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.scene.globe.terrainProvider = v.terrainProvider;
      v.clock.shouldAnimate = false;
      v.scene.globe.enableLighting = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.fog.enabled = false;
      v.scene.skyAtmosphere.show = false;
      if (v.scene.sun) v.scene.sun.show = false;
      if (v.scene.moon) v.scene.moon.show = false;
      v.scene.backgroundColor = new C.Color(0, 0, 0, 1);
      // Moderate altitude over North America so tiles + triangle edges are big
      // enough to read in the screenshot.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-95, 40, 4_000_000),
        orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      });
      // Render a few frames so imagery layers attach before enabling wireframe.
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Enable the globe debug wireframe through the documented internal flag.
      let how = "none";
      try {
        const tp = v.scene.globe._surface.tileProvider;
        if (tp && tp._debug) {
          tp._debug.wireframe = !!wireframe;
          how = "tileProvider._debug.wireframe";
        }
      } catch (e) {
        how = "err:" + String(e);
      }
      return { rendererType: v.scene.context.rendererType, wireframe, how };
    },
    { wireframe },
  );
}

async function settle(page, frames) {
  return await page.evaluate(async (frames) => {
    const v = window.viewer;
    const scene = v.scene;
    const SW = 200,
      SH = 200;
    const sampler = document.createElement("canvas");
    sampler.width = SW;
    sampler.height = SH;
    const sctx = sampler.getContext("2d", { willReadFrequently: true });
    let lastSig = 0,
      nonBlackFrac = 0;
    const sign = () => {
      try {
        sctx.clearRect(0, 0, SW, SH);
        sctx.drawImage(scene.canvas, 0, 0, SW, SH);
        const d = sctx.getImageData(0, 0, SW, SH).data;
        let s = 0,
          nb = 0;
        for (let i = 0; i < d.length; i += 16)
          s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
        for (let i = 0; i < d.length; i += 4)
          if (d[i] > 16 || d[i + 1] > 16 || d[i + 2] > 16) nb++;
        lastSig = s;
        nonBlackFrac = nb / (SW * SH);
      } catch (e) {
        lastSig = -1;
      }
    };
    const remove = scene.postRender.addEventListener(sign);
    let prev = -1,
      stable = 0;
    for (let i = 0; i < frames; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      const rel =
        prev <= 0
          ? Infinity
          : Math.abs(lastSig - prev) / Math.max(1, Math.abs(prev));
      if (rel < 0.0015) stable++;
      else stable = 0;
      prev = lastSig;
      if (i >= 120 && stable >= 30) break;
    }
    remove();
    for (let i = 0; i < 10; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { nonBlackFrac: +nonBlackFrac.toFixed(4) };
  }, frames);
}

async function capture(page, outPath) {
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    return await new Promise((resolve) => {
      const remove = v.scene.postRender.addEventListener(() => {
        remove();
        try {
          resolve(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          resolve(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
  });
  if (!b64) return false;
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return true;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
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
  const gpu = await boot(browser, "webgpu");
  const gl = await boot(browser, "webgl");
  const sgpu = await setup(gpu.page, true);
  const sgl = await setup(gl.page, true);
  const stgpu = await settle(gpu.page, 600);
  const stgl = await settle(gl.page, 300);
  await capture(gpu.page, path.join(OUT_DIR, "wireframe-webgpu.png"));
  await capture(gl.page, path.join(OUT_DIR, "wireframe-webgl.png"));
  console.error(
    "gpu setup:",
    JSON.stringify(sgpu),
    "settle:",
    JSON.stringify(stgpu),
  );
  console.error(
    "gl  setup:",
    JSON.stringify(sgl),
    "settle:",
    JSON.stringify(stgl),
  );
  console.error(
    "gpu errs:",
    JSON.stringify(errorStrings(gpu.diagnostics).slice(0, 5)),
  );
  gpu.diagnostics.detach();
  gl.diagnostics.detach();
  await browser.close();
})();
