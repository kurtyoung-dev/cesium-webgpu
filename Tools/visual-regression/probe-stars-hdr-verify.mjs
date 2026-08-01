#!/usr/bin/env node
/**
 * Verify the WebGPU baked-SkyBox HDR decode fix. Bug: under highDynamicRange,
 * the WebGPU cubemap was NOT sRGB->linear decoded (WebGL does czm_gammaCorrect),
 * so the faint baked starfield background read ~85x too dim vs the linear
 * StarField catalog points — invisible. Fix gates a pow(2.2) decode on hdrParams.x.
 *
 * Captures, looking up into the night starfield:
 *   stars-hdr-webgpu.png / stars-hdr-webgl.png  (HDR+bloom — the bug path)
 *   stars-sdr-webgpu.png                          (SDR — must be unchanged/no-op)
 *
 * READ the PNGs: HDR WebGPU should now show the faint star dusting like WebGL
 * (not just the ~80 bright catalog points on black); SDR WebGPU is the control.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");

async function boot(browser, renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1000 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });
  return { page, errs };
}

async function setup(page, hdr) {
  return await page.evaluate(
    async ({ hdr }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      // Local night at lon 0 so the starfield is at full brightness.
      v.clock.currentTime = C.JulianDate.fromIso8601("2024-01-01T03:00:00Z");
      s.skyAtmosphere.show = false; // remove the day-glow so stars read cleanly
      s.fog.enabled = false;
      s.globe.show = false; // hide the globe — we only want the sky/stars
      s.highDynamicRange = !!hdr;
      try {
        if (s.postProcessStages && s.postProcessStages.bloom)
          s.postProcessStages.bloom.enabled = !!hdr;
      } catch (e) {
        /* noop */
      }
      // Look up off the limb into the densest sky.
      s.camera.setView({
        destination: C.Cartesian3.fromDegrees(0, 0, 9_000_000),
        orientation: { heading: 0, pitch: C.Math.toRadians(55), roll: 0 },
      });
      return { rendererType: s.context.rendererType, hdr: s.highDynamicRange };
    },
    { hdr },
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
    let lastSig = 0;
    const sign = () => {
      try {
        sctx.clearRect(0, 0, SW, SH);
        sctx.drawImage(scene.canvas, 0, 0, SW, SH);
        const d = sctx.getImageData(0, 0, SW, SH).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 16)
          s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
        lastSig = s;
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
    return { finalSig: lastSig };
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
  // HDR path (the bug).
  console.error("hdr gpu:", JSON.stringify(await setup(gpu.page, true)));
  console.error("hdr gl :", JSON.stringify(await setup(gl.page, true)));
  await settle(gpu.page, 500);
  await settle(gl.page, 300);
  await capture(gpu.page, path.join(OUT_DIR, "stars-hdr-webgpu.png"));
  await capture(gl.page, path.join(OUT_DIR, "stars-hdr-webgl.png"));
  // SDR control (must be unchanged on WebGPU).
  console.error("sdr gpu:", JSON.stringify(await setup(gpu.page, false)));
  await settle(gpu.page, 300);
  await capture(gpu.page, path.join(OUT_DIR, "stars-sdr-webgpu.png"));
  console.error("gpu errs:", JSON.stringify(gpu.errs.slice(0, 5)));
  await browser.close();
})();
