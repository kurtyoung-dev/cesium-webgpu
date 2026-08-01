#!/usr/bin/env node
/**
 * Probe the actual commandList contents during a b3dm tileset render
 * on WebGPU to find out why the canvas is uniform dark gray (no model
 * or globe pixels visible).
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
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error") console.log(`[err] ${m.text().slice(0, 400)}`);
  });

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

    // Look at the actual model's bounding sphere — point camera at it
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

    const bs = model?.boundingSphere;
    if (bs) {
      // Place camera 3x radius away looking at center
      const offset = new C.HeadingPitchRange(
        0,
        -C.Math.PI_OVER_FOUR,
        bs.radius * 3,
      );
      v.camera.viewBoundingSphere(bs, offset);
    }
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Inspect the commandList AFTER zoom-to-model
    const fs = v.scene.frameState;
    const cmds = fs?.commandList ?? [];
    const cmdInfo = cmds.slice(0, 20).map((c, i) => ({
      i,
      ctor: c.constructor?.name,
      pass: c.pass,
      owner: c.owner?.constructor?.name ?? null,
      hasShader: !!c.shaderProgram,
      hasPipeline: !!c._pipeline,
      hasVA: !!c.vertexArray,
      hasGPUBuffer: !!c._gpuBuffers || !!c.gpuBuffers,
      bs: c.boundingVolume ? "yes" : "no",
      pickOnly: c.pickOnly,
      cull: c.cull,
    }));

    // Inspect WebGPU model render — does it actually call renderModel?
    const wgpuCache = model?._webgpuCache;
    const sg = model?._sceneGraph;
    const runtimeNodes = sg?._runtimeNodes;
    const firstNode = runtimeNodes?.find((n) => n?.runtimePrimitives?.length);
    const firstRP = firstNode?.runtimePrimitives?.[0];
    const primCacheVal = firstRP
      ? Object.values(wgpuCache?.primitives ?? {})[0]
      : null;

    // Sample canvas pixels at model center (canvas center)
    const canvas = v.canvas;
    const w = canvas.width,
      h = canvas.height;
    const cx = Math.floor(w / 2),
      cy = Math.floor(h / 2);
    const tmp = document.createElement("canvas");
    tmp.width = 4;
    tmp.height = 4;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(canvas, cx - 2, cy - 2, 4, 4, 0, 0, 4, 4);
    const px = tctx.getImageData(0, 0, 4, 4).data;
    const samples = [];
    for (let i = 0; i < px.length; i += 4) {
      samples.push([px[i], px[i + 1], px[i + 2], px[i + 3]]);
    }

    // Also probe wider — diagonal
    const wideTmp = document.createElement("canvas");
    wideTmp.width = w;
    wideTmp.height = h;
    wideTmp.getContext("2d").drawImage(canvas, 0, 0, w, h);
    const wide = wideTmp.getContext("2d").getImageData(0, 0, w, h).data;
    const colorBuckets = {};
    for (let i = 0; i < wide.length; i += 16) {
      const key = `${wide[i]},${wide[i + 1]},${wide[i + 2]}`;
      colorBuckets[key] = (colorBuckets[key] || 0) + 1;
    }
    const topColors = Object.entries(colorBuckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return {
      tilesFeaturesLoaded: tileset.statistics?.numberOfFeaturesLoaded,
      modelFound: !!model,
      modelReady: model?.ready,
      modelShow: model?.show,
      cameraHeight: v.camera.positionCartographic?.height,
      commandListCount: cmds.length,
      cmdInfo,
      hasWebgpuCache: !!wgpuCache,
      primCacheKeyCount: wgpuCache
        ? Object.keys(wgpuCache.primitives ?? {}).length
        : null,
      primCacheValue: primCacheVal
        ? {
            keys: Object.keys(primCacheVal).slice(0, 30),
            hasOpaquePipeline: !!primCacheVal.opaquePipeline,
            hasTranslucentPipeline: !!primCacheVal.translucentPipeline,
            hasMaterialBG: !!primCacheVal.materialBG, // Old API — should be undefined
            hasMergedMaterialBG:
              !!primCacheVal._mergedMaterialBG ||
              !!primCacheVal.mergedMaterialBG,
            hasMergedInstanceBG:
              !!primCacheVal._mergedInstanceBG ||
              !!primCacheVal.mergedInstanceBG,
            opaqueDrawCount: primCacheVal.opaqueDrawCount,
            translucentDrawCount: primCacheVal.translucentDrawCount,
          }
        : null,
      runtimeNodesCount: runtimeNodes?.length,
      firstRPExists: !!firstRP,
      centerCanvasPx: samples,
      topColorsHistogram: topColors,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  const buf = await page.screenshot({ omitBackground: false });
  const fs = await import("fs");
  fs.writeFileSync("Tools/visual-regression/output/diag-b3dm-cmds.png", buf);
  await browser.close();
})();
