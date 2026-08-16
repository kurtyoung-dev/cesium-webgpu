#!/usr/bin/env node
// INVESTIGATION + ACCEPTANCE probe for NS-LARGE-LAKE-WATER-MASK (BUG 3).
// @purpose Root-caused flat Great Lakes by querying the terrain provider's waterMask directly at lake/ocean/land points, plus a render check on both backends
// @status INVESTIGATION
//
// User report: large inland lakes (Great Lakes) render FLAT with NO
// water-mask wave effect on BOTH backends, while oceans animate.
//
// ROOT-CAUSE STEP (i): does the Cesium World Terrain water mask actually
// MARK large lakes as water? This probe queries the terrain provider
// DIRECTLY (requestTileGeometry -> terrainData.waterMask) at points inside
// Lake Superior / Lake Michigan / Lake Huron, plus an OCEAN control
// (N. Atlantic) and a LAND control (Nebraska). It reports the raw water
// mask value (0=land ... 255=water) at each point.
//
// If lakes read ~0 (land) while ocean reads ~255, the flat-lake symptom is
// a DATA limitation in the provider mask, not a shader gate (Principle 9).
//
// STEP (ii) render check: capture a Lake Michigan view on both backends so
// the PNGs can be READ to confirm whether any wave effect shows.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Test points: [name, lon, lat, expectedKind]
const POINTS = [
  ["Lake Superior (center)", -87.5, 47.6, "lake"],
  ["Lake Michigan (center)", -87.0, 43.3, "lake"],
  ["Lake Huron (center)", -82.4, 44.8, "lake"],
  ["Great Salt Lake", -112.5, 41.15, "lake"],
  ["N. Atlantic (ocean control)", -60.0, 40.0, "ocean"],
  ["Nebraska (land control)", -99.8, 41.5, "land"],
];

async function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
}

async function sampleWaterMask() {
  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const results = await page.evaluate(async (points) => {
    const v = window.viewer;
    const provider = v.terrainProvider;
    // Wait for the provider to be ready (fromWorldTerrain is async).
    let tries = 0;
    while (!provider.tilingScheme && tries < 100) {
      await new Promise((r) => setTimeout(r, 100));
      tries++;
    }
    // Grab constructors off live objects to avoid relying on a global.
    const tilingScheme = provider.tilingScheme;
    const CartographicCtor = v.camera.positionCartographic.constructor;

    const out = [];
    for (const [name, lon, lat, kind] of points) {
      const carto = CartographicCtor.fromDegrees(lon, lat);
      // Find the deepest available level with a water mask for this point.
      let picked = null;
      for (const level of [11, 10, 9, 8, 7]) {
        try {
          const xy = tilingScheme.positionToTileXY(carto, level);
          if (!xy) continue;
          const avail =
            typeof provider.getTileDataAvailable === "function"
              ? provider.getTileDataAvailable(xy.x, xy.y, level)
              : true;
          if (avail === false) continue;
          const req = provider.requestTileGeometry(xy.x, xy.y, level);
          if (!req) continue;
          const data = await req;
          if (!data) continue;
          const wm = data.waterMask;
          if (wm === undefined) {
            picked = { level, note: "no waterMask on tile" };
            continue;
          }
          // Compute UV within tile rectangle.
          const rect = tilingScheme.tileXYToRectangle(xy.x, xy.y, level);
          const u = (carto.longitude - rect.west) / (rect.east - rect.west);
          const vv = (carto.latitude - rect.south) / (rect.north - rect.south);
          let value = null;
          let size = null;
          let kindStr = null;
          if (wm instanceof ImageBitmap) {
            // Decode via canvas.
            const c = document.createElement("canvas");
            c.width = wm.width;
            c.height = wm.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(wm, 0, 0);
            const px = Math.min(
              wm.width - 1,
              Math.max(0, Math.floor(u * wm.width)),
            );
            // Mask texture is sampled with y flipped in-shader; row 0 = north.
            const py = Math.min(
              wm.height - 1,
              Math.max(0, Math.floor((1 - vv) * wm.height)),
            );
            const d = ctx.getImageData(px, py, 1, 1).data;
            value = d[0];
            size = `${wm.width}x${wm.height}`;
            kindStr = "ImageBitmap";
          } else if (wm.length === 1) {
            value = wm[0];
            size = "1x1";
            kindStr = "uniform";
          } else {
            const n = Math.round(Math.sqrt(wm.length));
            const px = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
            const py = Math.min(n - 1, Math.max(0, Math.floor((1 - vv) * n)));
            value = wm[py * n + px];
            size = `${n}x${n}`;
            kindStr = "Uint8Array";
            // Also compute max over the whole tile to know if ANY water present.
            let mx = 0;
            for (let i = 0; i < wm.length; i++) if (wm[i] > mx) mx = wm[i];
            kindStr += ` tileMax=${mx}`;
          }
          picked = {
            level,
            value,
            size,
            kindStr,
            u: +u.toFixed(3),
            v: +vv.toFixed(3),
          };
          break;
        } catch (e) {
          picked = { level, error: String(e && e.message ? e.message : e) };
        }
      }
      out.push({
        name,
        lon,
        lat,
        kind,
        hasWaterMask: provider.hasWaterMask,
        result: picked,
      });
    }
    return out;
  }, POINTS);

  await browser.close();
  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { results, errs };
}

async function captureView(rendererArg, view, label) {
  const browser = await launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}&${view}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(async () => {
    const v = window.viewer;
    v.scene.requestRenderMode = false;
    const JulianDate = v.clock.currentTime.constructor;
    const iso = "2026-07-03T17:00:00Z";
    for (let i = 0; i < 200; i++) {
      v.clock.currentTime = JulianDate.fromIso8601(iso);
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(1500);
  const p = path.join(OUT_DIR, `large-lake-${label}-${rendererArg}.png`);
  await page.screenshot({ path: p, fullPage: false });
  await browser.close();
  return p;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    "== STEP (i): sample terrain-provider water mask at test points ==",
  );
  const { results, errs } = await sampleWaterMask();
  for (const r of results) {
    console.log(`  ${r.name} [${r.kind}]  hasWaterMask=${r.hasWaterMask}`);
    console.log(`      ${JSON.stringify(r.result)}`);
  }
  if (errs.length)
    errs.slice(0, 4).forEach((e) => console.log(`    ${e.t}: ${e.text}`));

  console.log("\n== STEP (ii): capture Lake Michigan view (both backends) ==");
  // Low-oblique view over southern Lake Michigan looking north.
  const VIEW = "view=-87.0,42.6,25000,0,-25,0";
  const gl = await captureView("webgl", VIEW, "michigan");
  const gpu = await captureView("webgpu", VIEW, "michigan");
  console.log("  PNGs:", gl, gpu);
  console.log("done");
})();
