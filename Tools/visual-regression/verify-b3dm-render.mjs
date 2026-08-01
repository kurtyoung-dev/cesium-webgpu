#!/usr/bin/env node
/**
 * Visual end-to-end verification of b3dm Model rendering on WebGPU.
 *
 * Loads BatchedWithBatchTable.json (the canonical b3dm fixture) on both
 * WebGL and WebGPU, captures screenshots, and reports any visible
 * differences or rendering errors. This closes the loop on the
 * NEW-BG-CONSOLIDATION refactor — confirms b3dm Models actually render.
 */
import { chromium } from "playwright";
const BASE = "http://localhost:8080";

async function captureRenderer(renderer) {
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
  const errors = [];
  const warnings = [];
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") errors.push(txt.slice(0, 400));
    else if (
      t === "warning" &&
      (txt.includes("validation") || txt.includes("WebGPU"))
    ) {
      warnings.push(txt.slice(0, 400));
    }
  });
  page.on("pageerror", (err) =>
    errors.push(`pageerror: ${err.message}`.slice(0, 400)),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    const tileset = await C.Cesium3DTileset.fromUrl(
      "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json",
    );
    v.scene.primitives.add(tileset);

    // Use viewer.zoomTo which positions camera using tileset's offset.
    await v.zoomTo(tileset);

    // Wait for tiles to actually load — render until features come in
    // OR a timeout fires.
    let waited = 0;
    while (waited < 600) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      waited++;
      if (tileset.statistics?.numberOfFeaturesLoaded > 0) break;
    }
    // Re-position camera much further from the bounding sphere so the
    // whole model is in the frustum (default zoomTo lands inside the BS
    // for this fixture, leaving the building behind/around the camera).
    const bs = tileset.boundingSphere;
    if (bs) {
      v.camera.viewBoundingSphere(
        bs,
        new C.HeadingPitchRange(0, -C.Math.PI_OVER_FOUR, bs.radius * 4),
      );
    }
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

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

    const wgpuCache = model?._webgpuCache;
    const sg = model?._sceneGraph;
    const runtimeNodes = sg?._runtimeNodes;
    const firstNode = runtimeNodes?.find((n) => n?.runtimePrimitives?.length);
    const firstRP = firstNode?.runtimePrimitives?.[0];

    return {
      tilesetReady: tileset.ready,
      tilesFeaturesLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      tilesetTilesLoaded: tileset.statistics?.numberOfTilesProcessedTotal,
      modelFound: !!model,
      modelReady: model?.ready,
      sceneMode: v.scene.mode,
      cameraHeight: v.camera.positionCartographic?.height,
      hasWebgpuCache: !!wgpuCache,
      primCacheKeyCount: wgpuCache
        ? Object.keys(wgpuCache.primitives ?? {}).length
        : null,
      runtimeNodesCount: runtimeNodes?.length,
      firstRPExists: !!firstRP,
      firstRPHasAttrs: firstRP?.primitive?.attributes?.length ?? 0,
      // Sample a few canvas pixels — count non-background-blue pixels
      pixelsSampled: (() => {
        const canvas = v.canvas;
        const w = canvas.width;
        const h = canvas.height;
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        // Read center 200x200 region from the canvas via a 2D copy
        const tmp = document.createElement("canvas");
        tmp.width = 200;
        tmp.height = 200;
        const tctx = tmp.getContext("2d");
        try {
          tctx.drawImage(canvas, cx - 100, cy - 100, 200, 200, 0, 0, 200, 200);
          const px = tctx.getImageData(0, 0, 200, 200).data;
          let nonBg = 0;
          let bgBlueish = 0;
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i],
              g = px[i + 1],
              b = px[i + 2];
            // Cesium default sky is pretty dark blue → high B, low R/G
            if (b > r + 20 && b > g + 20 && r < 100) bgBlueish++;
            else nonBg++;
          }
          return { nonBg, bgBlueish, totalPx: px.length / 4 };
        } catch (e) {
          return { error: String(e).slice(0, 100) };
        }
      })(),
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  await browser.close();
  return { result, errors, warnings, screenshot: buf };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  console.log("=== Capturing WebGL ===");
  const wgl = await captureRenderer("webgl");
  fs.writeFileSync(
    "Tools/visual-regression/output/b3dm-webgl.png",
    wgl.screenshot,
  );
  console.log(JSON.stringify(wgl.result, null, 2));
  console.log(`PNG: ${wgl.screenshot.length} bytes`);
  if (wgl.errors.length)
    console.log(`WebGL errors (${wgl.errors.length}):`, wgl.errors.slice(0, 5));

  console.log("\n=== Capturing WebGPU ===");
  const wgp = await captureRenderer("webgpu");
  fs.writeFileSync(
    "Tools/visual-regression/output/b3dm-webgpu.png",
    wgp.screenshot,
  );
  console.log(JSON.stringify(wgp.result, null, 2));
  console.log(`PNG: ${wgp.screenshot.length} bytes`);
  if (wgp.errors.length)
    console.log(
      `WebGPU errors (${wgp.errors.length}):`,
      wgp.errors.slice(0, 8),
    );
  if (wgp.warnings.length)
    console.log(
      `WebGPU warnings (${wgp.warnings.length}):`,
      wgp.warnings.slice(0, 5),
    );

  console.log("\n=== Compare ===");
  console.log(`WebGL non-bg pixels:  ${wgl.result.pixelsSampled?.nonBg}`);
  console.log(`WebGPU non-bg pixels: ${wgp.result.pixelsSampled?.nonBg}`);
})();
