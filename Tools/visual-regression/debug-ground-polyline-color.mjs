#!/usr/bin/env node
/**
 * Diagnose GroundPolyline visibility on WebGPU.
 * @purpose Instruments the GroundPolyline renderer cache to find why per-instance color didn't reach the FS (dim-rectangle diagnosis, 2026-04-30).
 * @status INVESTIGATION
 *
 * Prior diagnosis (2026-04-30) said vsMain produces vertices outside NDC.
 * Re-running the zoom test in 2026-04-30 actually shows DIM rectangles —
 * the volume IS rasterizing. So the geometry is on-screen; the bug must
 * be in the FS color path (likely the per-instance color is not
 * resolving to the expected red).
 *
 * This script instruments the renderer cache and prints (a) the batch
 * snapshot's CPU-side color array, (b) the FR's `_lastFeatureRenderer`
 * binding, (c) the actual buffer contents we'd expect the shader to read.
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
    const txt = m.text();
    if (t === "error") console.log(`[error] ${txt.slice(0, 250)}`);
    if (t === "warning" && txt.includes("validation"))
      console.log(`[warn] ${txt.slice(0, 250)}`);
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

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
          width: 32.0,
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
    const innerPrim = polyline._primitive;
    const batchTable = innerPrim?._batchTable;
    const attrIndices = innerPrim?._batchTableAttributeIndices;

    let batchColorsSample = null;
    if (cache?.batchColors) {
      batchColorsSample = Array.from(cache.batchColors.slice(0, 8));
    }
    let batchTableSample = null;
    if (batchTable && attrIndices?.color !== undefined) {
      const scratch = {};
      const colorVal = batchTable.getBatchedAttribute(
        0,
        attrIndices.color,
        scratch,
      );
      batchTableSample = {
        type: typeof colorVal,
        red: colorVal?.red,
        green: colorVal?.green,
        blue: colorVal?.blue,
        alpha: colorVal?.alpha,
        x: colorVal?.x,
        y: colorVal?.y,
        z: colorVal?.z,
        w: colorVal?.w,
      };
    }

    return {
      hasCache: !!cache,
      batchInstanceCount: cache?.batchInstanceCount,
      batchSnapshotTaken: cache?._batchSnapshotTaken,
      batchColorsSample,
      batchTableSample,
      attrIndicesColor: attrIndices?.color,
      attrIndicesWidth: attrIndices?.width,
      hasBatchTable: !!batchTable,
      batchTableNumInstances: batchTable?._numberOfInstances,
      vertexCount: cache?.vertexCount,
      indexCount: cache?.indexCount,
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
