#!/usr/bin/env node
/**
 * FOCUSED TEST: is the WebGPU 12 Mm "cage" (dark radial wedge-gaps) a REAL
 * render artifact, or a PROBE-SETTLE artifact — i.e. the WebGPU capture taken on
 * a coarse-LOD frame (level-0/1 tiles, shared edges disagree → gaps) BEFORE the
 * fine tiles + pipelines materialize, because scene.globe.tilesLoaded goes
 * vacuously true on WebGPU?
 * @purpose Answered whether the 12 Mm 'cage' (dark radial wedge gaps) was a real render defect or a coarse-LOD probe-settle artifact via a fixed long settle
 * @status INVESTIGATION
 *
 * METHOD: boot WebGPU, set the EXACT h12 down atmoOff view, then render a FIXED
 * LONG settle (no early break) so fine tiles + pipelines fully materialize, and
 * log the rendered tile-level histogram at intervals. Capture at the end.
 *
 * If the cage FILLS IN with the long settle (and the level histogram shifts to
 * finer levels) -> it's a settle artifact; fix the probe settle, the RTC fix is
 * fine. If the cage PERSISTS at full refinement -> it's a real artifact.
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
  await page.evaluate(() => {
    window.viewer.scene.requestRenderMode = false;
  });
  return { page, errs };
}

async function setup(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    v.scene.globe.terrainProvider = v.terrainProvider;
    v.clock.shouldAnimate = false;
    // atmoOff silhouette setup (magenta bg).
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
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-95, 40, 12_000_000),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
    });
    return { rendererType: v.scene.context.rendererType };
  });
}

/** Render a FIXED number of frames; log the rendered tile-level histogram. */
async function longSettle(page, frames) {
  return await page.evaluate(async (frames) => {
    const v = window.viewer;
    const scene = v.scene;
    const levelHist = () => {
      const hist = {};
      let total = 0;
      try {
        const surf = scene.globe._surface;
        const list = surf._tilesToRender || [];
        for (const t of list) {
          hist[t.level] = (hist[t.level] || 0) + 1;
          total++;
        }
      } catch (e) {
        return { err: String(e) };
      }
      return { total, hist };
    };
    const snaps = [];
    for (let i = 0; i < frames; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (i === 30 || i === 100 || i === 250 || i === frames - 1) {
        snaps.push({
          frame: i,
          tilesLoaded: scene.globe.tilesLoaded,
          ...levelHist(),
        });
      }
    }
    return snaps;
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
  const s = await setup(gpu.page);
  console.error("setup:", JSON.stringify(s));
  // Short settle (mimics the farcam probe's early break ~frame 40-60).
  const short = await longSettle(gpu.page, 60);
  await capture(gpu.page, path.join(OUT_DIR, "h12-short-webgpu.png"));
  // Long settle (fine tiles + pipelines should fully materialize).
  const long = await longSettle(gpu.page, 600);
  await capture(gpu.page, path.join(OUT_DIR, "h12-long-webgpu.png"));
  console.error("SHORT settle level snaps:", JSON.stringify(short, null, 2));
  console.error("LONG  settle level snaps:", JSON.stringify(long, null, 2));
  console.error("errs:", JSON.stringify(gpu.errs.slice(0, 8)));
  await browser.close();
})();
