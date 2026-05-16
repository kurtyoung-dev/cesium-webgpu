#!/usr/bin/env node
// Probe: WGS84 ellipsoid + various imagery combos. Reproduces the
// "globe explodes into black wedges with RGB-streak tile edges"
// symptom reported when picking "WGS84 Ellipsoid" from the terrain
// picker on the WebGPU viewer.
//
// `WGS84 Ellipsoid` uses EllipsoidTerrainProvider — unquantized, no
// normals, no webMercatorT — the simplest tile mesh format. The
// catastrophic rendering implies the WebGPU shader entry point for
// that format is mis-wired, or imagery sampling fails when no
// webMercatorT attribute is present.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function capture(rendererArg, scenarioLabel) {
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Swap to WGS84 EllipsoidTerrainProvider — index 0 in default picker.
  await page.evaluate(async () => {
    const v = window.viewer;
    const blp = v.baseLayerPicker;
    const vm = blp.viewModel;
    // Find the terrain provider model whose name contains "WGS84"
    const wgs84Tvm = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
    );
    if (wgs84Tvm) {
      vm.selectedTerrain = wgs84Tvm;
    } else {
      console.log("[probe-wgs84] no WGS84 terrain VM found");
    }
    // Let the terrain swap settle
    for (let i = 0; i < 360; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page.waitForTimeout(2500);

  const stats = await page.evaluate(() => {
    const v = window.viewer;
    return {
      mode: v.scene.mode,
      terrainProvider: v.terrainProvider?.constructor?.name,
      imageryLayerCount: v.scene.imageryLayers.length,
      imageryProvider: v.scene.imageryLayers.get(0)?.imageryProvider?.constructor?.name,
      tilesToRender: v.scene._globe?._surface?._tilesToRender?.length,
      // Sample tile mesh info
      sampleTile: (() => {
        const t = v.scene._globe?._surface?._tilesToRender?.[0];
        if (!t) return null;
        const m = t.data?.mesh;
        if (!m) return null;
        return {
          ctor: m.constructor.name,
          encoding: m.encoding?.constructor?.name,
          hasNormals: !!m.encoding?.hasWebMercatorT,
          quantization: m.encoding?.quantization,
          stride: m.encoding?.stride,
        };
      })(),
    };
  });
  console.log(`  ${scenarioLabel} stats:`, JSON.stringify(stats));

  const out = path.join(OUT_DIR, `probe-wgs84-${scenarioLabel}-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} errors:`);
    errs.slice(0, 5).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return out;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[probe-wgs84] WebGPU + WGS84 ellipsoid`);
  await capture("webgpu", "default-imagery");
  console.log(`[probe-wgs84] WebGL + WGS84 ellipsoid`);
  await capture("webgl", "default-imagery");
  console.log(`[probe-wgs84] done`);
})();
