#!/usr/bin/env node
/**
 * RE-TEST the far-camera distances in ISOLATION with a LONG FIXED settle.
 * @purpose Long-fixed-settle retest of far-camera views proving the 'cage/ring' was a partially-materialized capture artifact, not a precision bug. — ARCHIVED-CANDIDATE: lesson promoted to DEBUGGING_GUIDE.md, “Instrument-defect lessons (from archived probes)”.
 * @status INVESTIGATION
 *
 * Discovery: the farcam-distortion sweep captures WebGPU on a PARTIALLY-
 * materialized frame (tiles report loaded + coverage > 25%, but the WebGPU
 * pipelines are still compiling, so the globe is black/partial → dark radial
 * "cage"/"ring" bands). A 600-frame settle at 12 Mm renders a CLEAN globe. So
 * the "12 Mm cage" was a materialization artifact, NOT a precision bug — and the
 * h20/h35/h50 "residual ring" may be the same thing.
 *
 * This probe sets ONE view at a time (down, atmosphere-off) and renders a LONG
 * FIXED settle (no early break) before capturing, on BOTH backends, so we can
 * compare WebGPU vs WebGL at FULL materialization at every distance.
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");
const HEIGHTS_MM = [12, 20, 35, 50];

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
  await page.evaluate(async () => {
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
    if (v.scene.skyBox) {
      v.scene.skyBox.show = false;
      v.scene.skyBox = undefined;
    }
    v.scene.backgroundColor = new C.Color(40 / 255, 0, 40 / 255, 1);
  });
  return { page, errs };
}

async function setViewAndSettle(page, heightMm, frames) {
  return await page.evaluate(
    async ({ heightMm, frames }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-95, 40, heightMm * 1_000_000),
        orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      });
      let lastCov = 0;
      const sampler = document.createElement("canvas");
      sampler.width = 200;
      sampler.height = 200;
      const sctx = sampler.getContext("2d", { willReadFrequently: true });
      const sample = () => {
        try {
          sctx.clearRect(0, 0, 200, 200);
          sctx.drawImage(v.scene.canvas, 0, 0, 200, 200);
          const d = sctx.getImageData(0, 0, 200, 200).data;
          let nb = 0;
          for (let i = 0; i < d.length; i += 4)
            if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12) nb++;
          lastCov = nb / (200 * 200);
        } catch (e) {
          lastCov = -1;
        }
      };
      const remove = v.scene.postRender.addEventListener(sample);
      for (let i = 0; i < frames; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      remove();
      return {
        tilesLoaded: v.scene.globe.tilesLoaded,
        lastCov: +lastCov.toFixed(3),
      };
    },
    { heightMm, frames },
  );
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
  // Warm-up: first view needs ~600 frames for WebGPU pipeline compilation.
  await setViewAndSettle(gpu.page, 12, 600);
  await setViewAndSettle(gl.page, 12, 200);
  for (const h of HEIGHTS_MM) {
    const sgpu = await setViewAndSettle(gpu.page, h, 400);
    const sgl = await setViewAndSettle(gl.page, h, 200);
    await capture(gpu.page, path.join(OUT_DIR, `iso-h${h}-webgpu.png`));
    await capture(gl.page, path.join(OUT_DIR, `iso-h${h}-webgl.png`));
    console.error(
      `h${h}: gpu cov=${sgpu.lastCov} tl=${sgpu.tilesLoaded} | gl cov=${sgl.lastCov}`,
    );
  }
  console.error("gpu errs:", JSON.stringify(gpu.errs.slice(0, 6)));
  await browser.close();
})();
