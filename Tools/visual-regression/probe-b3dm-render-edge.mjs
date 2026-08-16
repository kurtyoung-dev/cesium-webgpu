#!/usr/bin/env node
/**
 * Probe: does the BatchTableHierarchy b3dm tileset actually RENDER (not black)
 * on WebGPU/Edge — and does it match WebGL?
 * @purpose Re-verifies the stale NEW-BG-CONSOLIDATION claim: b3dm renders non-black on Edge WebGPU and matches WebGL, ellipsoid terrain to rule out occlusion.
 * @status ACTIVE
 *
 * Re-verifies the inventory claim NEW-BG-CONSOLIDATION ("ModelPBR declares 8
 * bind groups; spec default 4 → b3dm renders as black on Edge/Vulkan"), which
 * is suspected STALE now that per-feature b3dm pick shipped working.
 *
 * Loads BatchTableHierarchy with EllipsoidTerrainProvider (so real terrain
 * elevation can't occlude the sample buildings — the Batch 204 correction),
 * zooms in, renders, samples a coarse grid of canvas pixels, and arms the
 * WebGPU error/crash gate. Captures both backends to unique PNGs.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8134 node Tools/visual-regression/probe-b3dm-render-edge.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

async function captureRenderer(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await armWebGPUDevices(page);

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Force ellipsoid terrain so real CWT elevation can't occlude the sample
    // buildings (Batch 204 correction).
    v.terrainProvider = new C.EllipsoidTerrainProvider();

    const tileset = await C.Cesium3DTileset.fromUrl(
      "/Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json",
    );
    v.scene.primitives.add(tileset);

    // Render until the tileset reports features / bounding sphere.
    let waited = 0;
    while (waited < 600) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      waited++;
      if (tileset.statistics?.numberOfFeaturesLoaded > 0) break;
    }

    // Position camera above the tileset center, looking straight down, far
    // enough that the whole footprint is in frame.
    const bs = tileset.boundingSphere;
    if (bs) {
      const cart = C.Cartographic.fromCartesian(bs.center);
      v.camera.setView({
        destination: C.Cartesian3.fromRadians(
          cart.longitude,
          cart.latitude,
          cart.height + bs.radius * 2.5,
        ),
        orientation: { heading: 0, pitch: -1.5708, roll: 0 },
      });
    }
    for (let i = 0; i < 120; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Walk the tileset to find the first loaded model.
    let model = null;
    function walk(tile) {
      if (model) return;
      if (tile?.content?._model) {
        model = tile.content._model;
        return;
      }
      if (tile?.children) for (const c of tile.children) walk(c);
    }
    walk(tileset.root);

    // Sample the full canvas in a coarse grid. Count pixels that are NOT the
    // (dark blue) Cesium sky/background. Buildings are mid-grey -> high nonBg.
    const sample = (() => {
      const canvas = v.canvas;
      const w = canvas.width;
      const h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext("2d");
      try {
        tctx.drawImage(canvas, 0, 0);
        const px = tctx.getImageData(0, 0, w, h).data;
        let nonSky = 0;
        let total = 0;
        let nearBlack = 0;
        let rSum = 0,
          gSum = 0,
          bSum = 0;
        // Step by 4px in each axis to keep the loop cheap.
        for (let y = 0; y < h; y += 4) {
          for (let x = 0; x < w; x += 4) {
            const i = (y * w + x) * 4;
            const r = px[i],
              g = px[i + 1],
              b = px[i + 2];
            total++;
            rSum += r;
            gSum += g;
            bSum += b;
            // Sky = bluish (b notably > r,g) and not bright.
            const isSky = b > r + 15 && b > g + 15 && r < 120;
            if (!isSky) nonSky++;
            if (r < 16 && g < 16 && b < 16) nearBlack++;
          }
        }
        return {
          w,
          h,
          total,
          nonSky,
          nonSkyPct: ((nonSky / total) * 100).toFixed(1),
          nearBlack,
          nearBlackPct: ((nearBlack / total) * 100).toFixed(1),
          avgRGB: [
            Math.round(rSum / total),
            Math.round(gSum / total),
            Math.round(bSum / total),
          ],
          // Center 200x200 region average — where the buildings should be.
          centerAvg: (() => {
            let cr = 0,
              cg = 0,
              cb = 0,
              cn = 0;
            const cx = Math.floor(w / 2),
              cy = Math.floor(h / 2);
            for (let y = cy - 100; y < cy + 100; y += 2) {
              for (let x = cx - 100; x < cx + 100; x += 2) {
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                const i = (y * w + x) * 4;
                cr += px[i];
                cg += px[i + 1];
                cb += px[i + 2];
                cn++;
              }
            }
            return cn
              ? [Math.round(cr / cn), Math.round(cg / cn), Math.round(cb / cn)]
              : null;
          })(),
        };
      } catch (e) {
        return { error: String(e).slice(0, 200) };
      }
    })();

    return {
      renderer: v.scene.context?.rendererType,
      tilesetReady: tileset.ready,
      featuresLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      tilesLoaded: tileset.statistics?.numberOfTilesProcessedTotal,
      modelFound: !!model,
      modelReady: model?.ready,
      sceneMode: v.scene.mode,
      cameraHeight: v.camera.positionCartographic?.height,
      sample,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  const gate = await collectGateErrors(page);
  await browser.close();
  return { result, gate, consoleErrors, screenshot: buf };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`\n=== Capturing ${renderer.toUpperCase()} ===`);
    const cap = await captureRenderer(renderer);
    const out = `Tools/visual-regression/output/b3dm-render-edge-${renderer}.png`;
    fs.writeFileSync(out, cap.screenshot);
    console.log(JSON.stringify(cap.result, null, 2));
    console.log(`PNG: ${out} (${cap.screenshot.length} bytes)`);
    console.log(
      `GATE: armed=${cap.gate.armedDevices} uncaptured=${cap.gate.errors.length} deviceLost=${cap.gate.deviceLost || "no"}`,
    );
    if (cap.gate.errors.length)
      console.log("  gate errors:", cap.gate.errors.slice(0, 6));
    if (cap.consoleErrors.length)
      console.log(
        `  console faults (${cap.consoleErrors.length}):`,
        cap.consoleErrors.slice(0, 6),
      );
  }
})();
