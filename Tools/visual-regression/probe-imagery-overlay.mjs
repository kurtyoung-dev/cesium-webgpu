#!/usr/bin/env node
// Regression probe for Batch 56 Fix 1 (alpha=1.0 force in
// WebGPUImageryReprojection FS). Adds a transparent imagery overlay
// (TileCoordinatesImageryProvider — labels are opaque, rest of each
// tile is transparent) on top of Bing aerial and captures WebGL +
// WebGPU side by side. If the alpha=1.0 fix accidentally crushed
// overlay transparency, the WebGPU output will be a solid colored
// box per tile instead of just the labels.
//
// Pass criteria (manual inspection):
//   - WebGL: Bing aerial visible with X/Y/Level labels overlaid
//   - WebGPU: same — labels visible, no opaque colored box
//
// If the fix regressed transparent imagery the WebGPU side will show
// solid Bing-aerial-tinted boxes covering everything except where the
// labels are.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  // Add the TileCoordinates overlay on top of the default Bing aerial.
  // TileCoordinatesImageryProvider is the canonical transparent-overlay
  // test case: labels are opaque, tile boundaries are translucent, rest
  // is fully transparent. If our alpha=1 reprojection fix broke
  // transparent compositing, every tile becomes an opaque colored box
  // and the underlying Bing aerial is invisible.
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.imageryLayers.addImageryProvider(new C.TileCoordinatesImageryProvider());
    // Mid-orbit view so multiple tiles are visible
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-100, 40, 12000000),
    });
    for (let i = 0; i < 600; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 60) break;
    }
  });
  await page.waitForTimeout(2000);

  const out = path.join(OUT_DIR, `imagery-overlay-${rendererArg}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errors: errs };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-imagery-overlay] Bing + TileCoordinates overlay`);
  console.log(`  webgl`);
  const wgl = await capture("webgl");
  console.log(`    out: ${wgl.out} (${wgl.errors.length} errors)`);
  console.log(`  webgpu`);
  const wgpu = await capture("webgpu");
  console.log(`    out: ${wgpu.out} (${wgpu.errors.length} errors)`);

  console.log(
    `\nManual check: open both PNGs side by side. Both should show Bing aerial ` +
      `with X/Y/Level labels overlaid. If WebGPU shows opaque colored boxes ` +
      `over Bing, the alpha=1 reprojection fix has regressed transparent imagery.`,
  );
})();
