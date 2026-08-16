#!/usr/bin/env node
// Diagnostic for the south-pole black-hole on WebGPU. At south-pole-close
// view (lat=-89, alt=3Mm), WebGL renders Antarctic imagery + tile labels
// in the central ~2° around -90°; WebGPU shows solid black there.
// @purpose Dumps per-tile selection/mesh/renderable state at lat -89 to find why WebGPU rendered a black hole around the south pole.
// @status INVESTIGATION
//
// Capture state on both backends:
//   - tilesToRender count + per-tile (level, x, y, rectangle)
//   - whether each tile has mesh + index buffer
//   - whether the tile is "renderable"
//   - per-tile center / boundingSphere
//
// Look for tiles that are:
//   (a) selected on WebGL but missing on WebGPU
//   (b) selected on both but mesh state differs
//   (c) selected on both but rendered with different result

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

async function inspect(renderer) {
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

  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const vm = v.baseLayerPicker.viewModel;
    const wgs84 = vm.terrainProviderViewModels.find((t) =>
      String(t.name || "")
        .toLowerCase()
        .includes("wgs84"),
    );
    if (wgs84) vm.selectedTerrain = wgs84;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(0, -89, 3_000_000),
    });
    for (let i = 0; i < 1500; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 300) break;
    }

    const tiles = v.scene._globe?._surface?._tilesToRender ?? [];
    const summary = tiles.map((t) => {
      const rect = t?.rectangle;
      const m = t?.data?.mesh;
      return {
        L: t.level,
        X: t.x,
        Y: t.y,
        rect: rect
          ? `S${((rect.south * 180) / Math.PI).toFixed(2)}°,W${((rect.west * 180) / Math.PI).toFixed(2)}°,N${((rect.north * 180) / Math.PI).toFixed(2)}°,E${((rect.east * 180) / Math.PI).toFixed(2)}°`
          : null,
        renderable: t.renderable,
        hasMesh: !!m,
        meshVerts: m?.vertices?.length,
        meshIdx: m?.indices?.length,
        encStride: m?.encoding?.stride,
        hasNormals: !!m?.encoding?.hasVertexNormals,
        hasWebMercT: !!m?.encoding?.hasWebMercatorT,
        centerMag: m?.center
          ? Math.hypot(m.center.x, m.center.y, m.center.z).toFixed(0)
          : null,
      };
    });

    // Find tiles whose rectangle touches latitude < -88° (the polar cap)
    const polarTiles = summary.filter(
      (t) =>
        t.rect &&
        t.rect.startsWith("S") &&
        parseFloat(t.rect.match(/S(-?[\d.]+)/)?.[1]) < -85,
    );

    return {
      totalTiles: tiles.length,
      polarTileCount: polarTiles.length,
      polarTiles: polarTiles.slice(0, 10),
      firstFewTiles: summary.slice(0, 5),
    };
  });
}

(async () => {
  console.log("[south-pole-diag] WGS84 at lat=-89 alt=3Mm");
  for (const renderer of ["webgl", "webgpu"]) {
    const info = await inspect(renderer);
    console.log(
      `\n[${renderer}] ${info.totalTiles} tiles, ${info.polarTileCount} polar (south < -85°)`,
    );
    console.log(`  polarTiles:`, JSON.stringify(info.polarTiles, null, 2));
    console.log(
      `  firstFewTiles:`,
      JSON.stringify(info.firstFewTiles, null, 2),
    );
  }
})();
