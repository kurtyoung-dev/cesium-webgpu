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
  await page.evaluate(async (label) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const blp = v.baseLayerPicker;
    const vm = blp.viewModel;
    const wgs84Tvm = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "").toLowerCase().includes("wgs84"),
    );
    if (wgs84Tvm) {
      vm.selectedTerrain = wgs84Tvm;
    }
    // Zoom-in scenarios to force higher-LOD tiles (smaller vertex magnitudes)
    if (label.includes("close")) {
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(-100, 40, 1000000), // 1Mm altitude
      });
    }
    // Extended settle for orbit (level-0 tiles take longer to reproject)
    const renderLoops = label.includes("orbit") ? 1200 : 360;
    for (let i = 0; i < renderLoops; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, scenarioLabel);
  await page.waitForTimeout(2500);

  const stats = await page.evaluate(() => {
    const v = window.viewer;
    const t = v.scene._globe?._surface?._tilesToRender?.[0];
    const tileImagery = t?.data?.imagery?.[0];
    const ri = tileImagery?.readyImagery;
    return {
      mode: v.scene.mode,
      terrainProvider: v.terrainProvider?.constructor?.name,
      imageryLayerCount: v.scene.imageryLayers.length,
      imageryProvider: v.scene.imageryLayers.get(0)?.imageryProvider?.constructor?.name,
      imageryProjection: v.scene.imageryLayers.get(0)?.imageryProvider?.tilingScheme?.projection?.constructor?.name,
      terrainProjection: v.terrainProvider?.tilingScheme?.projection?.constructor?.name,
      tilesToRender: v.scene._globe?._surface?._tilesToRender?.length,
      sampleTileMesh: (() => {
        if (!t?.data?.mesh) return null;
        const m = t.data.mesh;
        const e = m.encoding;
        return {
          ctor: m.constructor.name,
          encoding: e?.constructor?.name,
          quantization: e?.quantization,
          hasNormals: !!e?.hasVertexNormals,
          hasWebMercatorT: !!e?.hasWebMercatorT,
          hasGeodeticSurfaceNormals: !!e?.hasGeodeticSurfaceNormals,
          stride: e?.stride,
          centerMagnitude: m.center ? Math.hypot(m.center.x, m.center.y, m.center.z) : null,
        };
      })(),
      sampleTileImagery: tileImagery ? {
        useWebMercatorT: tileImagery.useWebMercatorT,
        hasTextureTranslationAndScale: !!tileImagery.textureTranslationAndScale,
        hasTextureCoordinateRectangle: !!tileImagery.textureCoordinateRectangle,
        readyImageryReady: ri ? ri.state === 8 /* ImageryState.READY */ : null,
        hasReprojected: !!ri?._webgpuReprojectedTexture,
        hasMercTexture: !!ri?.textureWebMercator,
        hasNormalTexture: !!ri?.texture,
        imageryRectIsGeographic: ri?.rectangle ? (typeof ri.rectangle.west === "number") : null,
      } : null,
      // ALL tiles summary: count tiles by (useWebMercatorT, hasReprojected) combos
      allTilesSummary: (() => {
        const tiles = v.scene._globe?._surface?._tilesToRender || [];
        const buckets = {};
        let withImagery = 0;
        let withoutImagery = 0;
        for (const tile of tiles) {
          const ti = tile?.data?.imagery?.[0];
          if (!ti) { withoutImagery++; continue; }
          withImagery++;
          const ri2 = ti.readyImagery;
          const key = `useMercT=${ti.useWebMercatorT}|reproj=${!!ri2?._webgpuReprojectedTexture}|riReady=${ri2?.state === 8}`;
          buckets[key] = (buckets[key] || 0) + 1;
        }
        return { total: tiles.length, withImagery, withoutImagery, buckets };
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
  console.log(`[probe-wgs84] WebGPU + WGS84 ellipsoid (orbit)`);
  await capture("webgpu", "orbit");
  console.log(`[probe-wgs84] WebGL + WGS84 ellipsoid (orbit)`);
  await capture("webgl", "orbit");
  console.log(`[probe-wgs84] WebGPU + WGS84 ellipsoid (close 1Mm)`);
  await capture("webgpu", "close");
  console.log(`[probe-wgs84] WebGL + WGS84 ellipsoid (close 1Mm)`);
  await capture("webgl", "close");
  console.log(`[probe-wgs84] done`);
})();
