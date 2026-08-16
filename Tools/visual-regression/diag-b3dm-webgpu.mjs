#!/usr/bin/env node
/**
 * WebGPU-only deep diagnostic — why is the canvas black even though
 * the b3dm tileset loads, the model is ready, and primitive cache
 * populates?
 * @purpose Deep WebGPU-only diagnostic for a black canvas despite a loaded b3dm tileset, ready model and populated primitive cache.
 * @status INVESTIGATION
 *
 */
import { chromium } from "playwright";
const BASE = "http://localhost:8080";

(async () => {
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
  page.on("console", (m) => {
    const t = m.type();
    const txt = m.text();
    if (t === "error") errors.push(txt.slice(0, 600));
  });
  page.on("pageerror", (err) =>
    errors.push(`pageerror: ${err.message}`.slice(0, 600)),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
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

    await v.zoomTo(tileset);

    let waited = 0;
    while (waited < 600) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      waited++;
      if (tileset.statistics?.numberOfFeaturesLoaded > 0) break;
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

    // Read canvas pixels in many regions to identify where any drawing is.
    const canvas = v.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(canvas, 0, 0, w, h);
    const fullData = tctx.getImageData(0, 0, w, h).data;
    let nonBlackCount = 0;
    let nonBlackSample = null;
    for (let i = 0; i < fullData.length; i += 4) {
      const r = fullData[i],
        g = fullData[i + 1],
        b = fullData[i + 2],
        a = fullData[i + 3];
      if (r > 5 || g > 5 || b > 5) {
        nonBlackCount++;
        if (!nonBlackSample) {
          const px = i / 4;
          nonBlackSample = { x: px % w, y: Math.floor(px / w), r, g, b, a };
        }
      }
    }

    // Check command list & scene state
    const ctx = v.scene._context;
    const sceneRenderer = ctx?._sceneRenderer;
    const wgpuCache = model?._webgpuCache;
    const sg = model?._sceneGraph;
    const runtimeNodes = sg?._runtimeNodes;
    const firstRP = runtimeNodes?.find((n) => n?.runtimePrimitives?.length)
      ?.runtimePrimitives?.[0];

    // Camera vs bounding sphere
    const cam = v.camera;
    const camPos = cam.positionWC;
    const bs = tileset.boundingSphere;
    const dist = bs ? C.Cartesian3.distance(camPos, bs.center) : null;

    // Log frustum culling
    const cmds = v.scene.frameState?.commandList?.length ?? 0;

    return {
      tilesFeaturesLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      modelFound: !!model,
      modelReady: model?.ready,
      modelShow: model?.show,
      modelBS: model?.boundingSphere
        ? {
            center: [
              model.boundingSphere.center.x,
              model.boundingSphere.center.y,
              model.boundingSphere.center.z,
            ],
            radius: model.boundingSphere.radius,
          }
        : null,
      tilesetBS: bs
        ? {
            center: [bs.center.x, bs.center.y, bs.center.z],
            radius: bs.radius,
          }
        : null,
      cameraPos: [camPos.x, camPos.y, camPos.z],
      distanceToTilesetCenter: dist,
      cameraHeight: cam.positionCartographic?.height,
      cameraFrustumNear: cam.frustum?.near,
      cameraFrustumFar: cam.frustum?.far,
      sceneFramestate_commandList_count: cmds,
      pixelsNonBlack: nonBlackCount,
      pixelsTotal: fullData.length / 4,
      firstNonBlackPx: nonBlackSample,
      hasWebgpuCache: !!wgpuCache,
      primCacheKeyCount: wgpuCache
        ? Object.keys(wgpuCache.primitives ?? {}).length
        : null,
      runtimeNodesCount: runtimeNodes?.length,
      firstRPExists: !!firstRP,
      // Did the scene framebuffer get blitted to the canvas?
      sceneRendererInfo: sceneRenderer
        ? {
            sceneFramebuffer: !!sceneRenderer._sceneFramebuffer,
            canvasTexView: !!sceneRenderer._canvasTextureView,
            postProcessActive: !!sceneRenderer._postProcess,
            executeCommandsCount: sceneRenderer._diagExecuteCount,
          }
        : null,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  console.log(`Errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 10));

  const buf = await page.screenshot({ omitBackground: false });
  const fs = await import("fs");
  fs.writeFileSync("Tools/visual-regression/output/diag-b3dm-webgpu.png", buf);

  await browser.close();
})();
