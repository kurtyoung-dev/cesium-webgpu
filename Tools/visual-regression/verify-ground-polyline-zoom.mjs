#!/usr/bin/env node
/**
 * Targeted GroundPolyline test — zoom in close so even thin lines
 * are visible, and add the polyline as a primitive (not via
 * `groundPrimitives`) using the simpler upstream demo pattern.
 */
import { chromium } from "playwright";
import fs from "fs";

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
    if (t === "error") console.log(`[error] ${m.text().slice(0, 250)}`);
    if (
      t === "warning" &&
      (m.text().includes("Attachment state") || m.text().includes("validation"))
    )
      console.log(`[warn] ${m.text().slice(0, 250)}`);
    if (
      m.text().includes("GroundPolyline") ||
      m.text().includes("GroundPoly") ||
      m.text().includes("GP-DIAG")
    )
      console.log(`[info] ${m.text().slice(0, 250)}`);
  });

  const renderer = process.argv[2] || "webgpu";
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  // Add a thick red ground polyline + zoom in close.
  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const positions = C.Cartesian3.fromDegreesArray([
      -75.5, 40.0, -75.0, 40.0, -75.0, 40.5, -75.5, 40.5,
    ]);
    const polyline = new C.GroundPolylinePrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({
          positions: positions,
          width: 32.0, // very thick line
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.RED),
        },
      }),
      appearance: new C.PolylineColorAppearance(),
      classificationType: C.ClassificationType.TERRAIN,
    });
    v.scene.groundPrimitives.add(polyline);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.25, 40.25, 50000),
      orientation: { heading: 0, pitch: -1.57, roll: 0 },
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const cache = polyline._webgpuPolylineCache;
    return {
      hasColorPipeline: !!cache?.colorPipeline,
      hasPickPipeline: !!cache?.pickPipeline,
      hasUniformBuffer: !!cache?.uniformBuffer,
      hasBatchInstanceBuffer: !!cache?.batchInstanceBuffer,
      hasVertexGPUBuffer: !!cache?.vertexGPUBuffer,
      hasIndexGPUBuffer: !!cache?.indexGPUBuffer,
      indexCount: cache?.indexCount,
      vertexCount: cache?.vertexCount,
      batchInstanceCount: cache?.batchInstanceCount,
      batchSnapshotTaken: cache?._batchSnapshotTaken,
      hasBindGroup: !!cache?.bindGroup,
      hasMaterialBindGroup: !!cache?.materialBindGroup,
      hasDepthSampleBindGroup: !!cache?.depthSampleBindGroup,
      depthSampleViewRef: cache?.depthSampleViewRef ? "set" : "null",
      pickCommandHasPipeline: !!cache?.pickCommand?.pipeline,
    };
  });

  console.log(`[result] ${JSON.stringify(result, null, 2)}`);

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    `Tools/visual-regression/output/verify-gp-zoom-${renderer}.png`,
    buf,
  );
  console.log(`PNG bytes: ${buf.length}`);
  await browser.close();
})();
