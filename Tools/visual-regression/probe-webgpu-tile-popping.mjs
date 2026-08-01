#!/usr/bin/env node
// NS-WEBGPU-TILE-POPPING-SKIRTS acceptance probe.
//
// Bug: at certain zoom/LOD levels the WebGPU globe transiently showed thin
// BLACK triangular/skirt/wedge slivers on terrain during cold LOD refine that
// WebGL never showed. Root cause: the per-tile GPU vertex/index buffer cache
// (WebGPUGlobeSurfaceTileBuffers) keyed only on `level_x_y` with a dead
// `meshGeneration` (nothing bumps `mesh._webgpuGeneration`), so when
// `GlobeSurfaceTile.renderedMesh` swapped a fill/upsampled mesh for the real
// terrain mesh (same tile coords) the cache kept serving the stale vertex
// buffer — decoded with the current mesh's uniforms it flung vertices to
// Earth-radius distance, drawing an atmosphere-tinted black spike. Fix: also
// require the cached buffers' source `mesh.vertices` array to match.
//
// This probe has two parts, both run headless on Edge against :8080:
//   PART A (pass/fail, CONFOUND-FREE) — fly a continuous COLD zoom into Alaska
//     mountains on each backend and, per frame, count near-black pixels that
//     are surrounded by lit day-side terrain (an intra-frame wedge is
//     self-evidently wrong — no cross-backend timing/UI-chrome confound). The
//     gate: WebGPU wedge-frames must not exceed WebGL's.
//   PART B (visual) — capture WebGL vs WebGPU screenshots across a NEAR-GROUND
//     + mid-orbit-limb + high-orbit altitude sweep for a human to READ.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function makePage(browser, renderer) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 30000 });
  await page.evaluate(async () => {
    const v = window.viewer;
    try {
      const vm = v.baseLayerPicker && v.baseLayerPicker.viewModel;
      const world =
        vm &&
        vm.terrainProviderViewModels.find((t) =>
          String(t.name || "")
            .toLowerCase()
            .includes("world"),
        );
      if (world) vm.selectedTerrain = world;
    } catch (e) {
      /* ignore */
    }
    v.scene.globe.showSkirts = true;
  });
  return { page, errs };
}

// ── PART A: confound-free intra-frame black-wedge burst ──────────────────
async function wedgeBurst(page) {
  const regions = [
    { lon: -150.0, lat: 62.5 },
    { lon: -143.0, lat: 60.5 },
    { lon: -137.0, lat: 59.0 },
    { lon: -152.5, lat: 61.0 },
  ];
  const all = [];
  for (const reg of regions) {
    const frames = await page.evaluate(
      async ({ reg }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer;
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(reg.lon, reg.lat, 900000),
          orientation: { heading: 0, pitch: C.Math.toRadians(-35), roll: 0 },
        });
        for (let i = 0; i < 8; i++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        const out = [];
        const steps = 34;
        for (let s = 0; s < steps; s++) {
          const t = s / (steps - 1);
          const h = 900000 * Math.pow(30000 / 900000, t); // 900k -> 30k
          const pitch = -35 + t * 18;
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(reg.lon, reg.lat, h),
            orientation: {
              heading: 0,
              pitch: C.Math.toRadians(pitch),
              roll: 0,
            },
          });
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          v.scene.render();
          const cvs = v.scene.canvas;
          const off = document.createElement("canvas");
          off.width = cvs.width;
          off.height = cvs.height;
          const g = off.getContext("2d");
          g.drawImage(cvs, 0, 0);
          const w = off.width,
            h2 = off.height;
          const d = g.getImageData(0, 0, w, h2).data;
          const LIT = 60,
            BLACK = 26;
          const litAt = (x, y) => {
            const i = (y * w + x) * 4;
            return d[i] > LIT || d[i + 1] > LIT || d[i + 2] > LIT;
          };
          let wedge = 0;
          const x0 = 20,
            x1 = w - 260,
            y0 = 40,
            y1 = h2 - 60; // avoid UI panels
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * w + x) * 4;
              if (!(d[i] <= BLACK && d[i + 1] <= BLACK && d[i + 2] <= BLACK))
                continue;
              let ln = 0;
              for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  if (litAt(x + dx, y + dy)) ln++;
                }
              if (ln >= 7) wedge++;
            }
          }
          out.push({ region: `${reg.lon},${reg.lat}`, step: s, wedge });
        }
        return out;
      },
      { reg },
    );
    all.push(...frames);
  }
  const framesWithWedge = all.filter((f) => f.wedge >= 8).length;
  const max = Math.max(...all.map((f) => f.wedge));
  const total = all.reduce((a, b) => a + b.wedge, 0);
  const top = all
    .slice()
    .sort((a, b) => b.wedge - a.wedge)
    .slice(0, 5);
  return { frames: all.length, framesWithWedge, max, total, top };
}

// ── PART B: altitude-sweep visual capture ────────────────────────────────
const BANDS = [
  { name: "high9m", lon: -150, lat: 63, h: 9_000_000, pitch: -90 },
  { name: "limb2m", lon: -150, lat: 63, h: 2_200_000, pitch: -32 },
  { name: "ground3k", lon: -151.0, lat: 62.9, h: 3_000, pitch: -12 },
];

async function settle(page, band) {
  await page.evaluate(
    async ({ band }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(band.lon, band.lat, band.h),
        orientation: {
          heading: 0,
          pitch: C.Math.toRadians(band.pitch),
          roll: 0,
        },
      });
      for (let i = 0; i < 400; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 120) break;
      }
    },
    { band },
  );
  await page.waitForTimeout(300);
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

  // PART A — pass/fail (fresh page per backend so caches start cold)
  const glA = await makePage(browser, "webgl");
  const glWedge = await wedgeBurst(glA.page);
  await glA.page.close();
  const gpuA = await makePage(browser, "webgpu");
  const gpuWedge = await wedgeBurst(gpuA.page);
  await gpuA.page.close();

  console.log("=== NS-WEBGPU-TILE-POPPING-SKIRTS acceptance ===");
  console.log("PART A (confound-free intra-frame black-wedge burst):");
  console.log("  WebGL :", JSON.stringify(glWedge));
  console.log("  WebGPU:", JSON.stringify(gpuWedge));

  // PART B — visual sweep
  const gl = await makePage(browser, "webgl");
  const gpu = await makePage(browser, "webgpu");
  for (const band of BANDS) {
    await settle(gl.page, band);
    await settle(gpu.page, band);
    await gl.page.screenshot({
      path: path.join(OUT_DIR, `popping-${band.name}-webgl.png`),
    });
    await gpu.page.screenshot({
      path: path.join(OUT_DIR, `popping-${band.name}-webgpu.png`),
    });
  }
  console.log(
    "PART B: wrote popping-{high9m,limb2m,ground3k}-{webgl,webgpu}.png",
  );
  console.log("GL console errors:", gl.errs.slice(0, 5));
  console.log("GPU console errors:", gpu.errs.slice(0, 5));
  await browser.close();

  // Gate: WebGPU must not exceed WebGL in wedge-frames or peak wedge size.
  const pass =
    gpuWedge.framesWithWedge <= glWedge.framesWithWedge &&
    gpuWedge.max <= glWedge.max + 2;
  console.log(
    pass
      ? "RESULT: PASS (WebGPU at parity with WebGL)"
      : "RESULT: FAIL (WebGPU-only black wedges present)",
  );
  process.exit(pass ? 0 : 1);
})();
