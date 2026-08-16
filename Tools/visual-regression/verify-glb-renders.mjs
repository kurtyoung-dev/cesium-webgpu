#!/usr/bin/env node
/**
 * Hypothesis check: does any glTF model populate cache.primitives on
 * WebGPU? Loads CesiumAir.glb (a simple aircraft, definitely works on
 * WebGL) and probes the WebGPU model cache.
 * @purpose Hypothesis check from the early model-rendering bug: loads CesiumAir.glb on WebGPU and probes whether the model cache populates primitives.
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
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") {
      console.log(`[${t}] ${m.text().slice(0, 600)}`);
    }
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    const model = await C.Model.fromGltfAsync({
      url: "/Apps/SampleData/models/CesiumAir/Cesium_Air.glb",
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75.61, 40.04, 100.0),
      ),
      scale: 4.0,
    });
    v.scene.primitives.add(model);
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    // Position camera using the model's bounding sphere.
    const bs = model.boundingSphere;
    if (bs) {
      const cart = C.Cartographic.fromCartesian(bs.center);
      v.camera.setView({
        destination: C.Cartesian3.fromRadians(
          cart.longitude,
          cart.latitude,
          cart.height + bs.radius * 4,
        ),
        orientation: { heading: 0, pitch: -1.0, roll: 0 },
      });
    }
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const wgpuCache = model._webgpuCache;
    const sg = model._sceneGraph;
    const rp0 = sg?._runtimeNodes?.find((n) => n?.runtimePrimitives?.length)
      ?.runtimePrimitives?.[0];
    const ctx = v.scene._context;
    const dev = ctx?._device;
    const adapter = ctx?._adapter;
    return {
      adapterMaxBindGroups: adapter?.limits?.maxBindGroups,
      deviceMaxBindGroups: dev?.limits?.maxBindGroups,
      modelReady: model.ready,
      hasWebgpuCache: !!wgpuCache,
      primCacheKeys: wgpuCache ? Object.keys(wgpuCache.primitives ?? {}) : null,
      runtimePrimitiveExists: !!rp0,
      rpHasRenderResources: rp0?.renderResources !== undefined,
      rpHasUnderscoreRenderResources: rp0?._renderResources !== undefined,
      // Check if attributes have typedArrays now (post-fix)
      gltfPrimAttrShape: rp0?.primitive?.attributes?.[0]
        ? {
            semantic: rp0.primitive.attributes[0].semantic,
            hasTypedArray: !!rp0.primitive.attributes[0].typedArray,
            hasBuffer: !!rp0.primitive.attributes[0].buffer,
            typedArrayLen: rp0.primitive.attributes[0].typedArray?.length,
          }
        : null,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  const buf = await page.screenshot({ omitBackground: false });
  const fs = await import("fs");
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-glb-renders.png",
    buf,
  );
  console.log(`PNG: ${buf.length} bytes`);
  await browser.close();
})();
