#!/usr/bin/env node
// Probe: verify the WGSL ground-atmosphere inline analytic fallback
// matches WebGL when the LUT is unavailable. Documented (Batch 78) as
// untested — the WGSL adds a Phase 4 LUT path that's an intentional
// enhancement; the inline fallback should still match WebGL line-for-
// line. This probe forces `ensureAtmosphereLUTResources` to return
// null on the WebGPU side, then diffs against an unmodified WebGL run
// at three atmosphere-prominent views.
// @purpose Verifies the WGSL ground-atmosphere inline analytic fallback matches WebGL when the LUT is forced unavailable, 3 views, pinned clock.
// @status ACTIVE
//
// CLOCK PINNING (Batch 70+) — same fixed UTC as polar-multi-plain so
// the terminator falls in the same place across runs.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const VIEWS = [
  // Mid-orbit view where ground atmosphere is most prominent (limb
  // halo + horizon glow). LUT-off path runs continuously here.
  { name: "lut-off-orbit", lon: 0, lat: 0, height: 18_000_000 },
  // Close-camera atmosphere — fog density should fall into the inline
  // analytic path at this altitude too.
  { name: "lut-off-mid", lon: -100, lat: 40, height: 3_000_000 },
  // High latitude — both backends should produce the same inscatter
  // here on the LUT-off fallback.
  { name: "lut-off-northlat", lon: 0, lat: 60, height: 5_000_000 },
];

async function capture(renderer, view, disableLut) {
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(
    async ({ view, clockUTC, disableLut }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "")
          .toLowerCase()
          .includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      // Pin clock
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Disable the LUT on the WebGPU performance manager. The renderer
      // reads LUT views from `context.performanceManager.ensureAtmosphereLUTResources`
      // each frame; returning null forces the inline analytic fallback.
      if (disableLut) {
        const ctx = v.scene.context;
        const pm = ctx && ctx.performanceManager;
        if (pm && typeof pm.ensureAtmosphereLUTResources === "function") {
          pm.ensureAtmosphereLUTResources = () => null;
          console.log("[probe-atmo-lut-off] LUT disabled on perf manager");
        } else {
          console.log("[probe-atmo-lut-off] no perf manager (WebGL run?)");
        }
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      });
      // Render long enough for tiles + atmosphere to converge with
      // LUT-off (no pre-baked inscatter — the inline ray-march runs
      // every frame).
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }
    },
    { view, clockUTC: FIXED_CLOCK_UTC, disableLut },
  );
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `atmo-lut-off-${view.name}-${renderer}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

// Reuse the canvas-decode pixel diff from probe-saved-view.mjs — no
// Node-side PNG dep needed.
async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0,
        sum = 0,
        sumDR = 0,
        sumDG = 0,
        sumDB = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const ra = a.data[i],
          ga = a.data[i + 1],
          ba2 = a.data[i + 2];
        const rb = b.data[i],
          gb = b.data[i + 1],
          bb2 = b.data[i + 2];
        const dr = Math.abs(ra - rb);
        const dg = Math.abs(ga - gb);
        const db = Math.abs(ba2 - bb2);
        const d = dr + dg + db;
        sum += d;
        if (d > 30) mismatch++;
        sumDR += rb - ra;
        sumDG += gb - ga;
        sumDB += bb2 - ba2;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
        meanSignedDR: sumDR / total,
        meanSignedDG: sumDG / total,
        meanSignedDB: sumDB / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-atmo-lut-off] WebGPU LUT forced OFF; comparing to WebGL inline analytic",
  );
  const results = [];
  for (const view of VIEWS) {
    console.log(`  ${view.name}`);
    const gl = await capture("webgl", view, false);
    const gpu = await capture("webgpu", view, true);
    const diff = await diffPngs(gl, gpu);
    console.log(
      `    mismatchPct=${diff.mismatchPct.toFixed(3)}  meanDelta=${diff.meanDelta.toFixed(3)}  signedRGB=(${diff.meanSignedDR.toFixed(2)}, ${diff.meanSignedDG.toFixed(2)}, ${diff.meanSignedDB.toFixed(2)})`,
    );
    results.push({ view: view.name, ...diff });
  }
  const reportPath = path.join(OUT_DIR, "atmo-lut-off-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(`[probe-atmo-lut-off] report: ${reportPath}`);
})();
