#!/usr/bin/env node
/**
 * Probe whether the GroundPolyline volume is rasterizing.
 * Forces ALL fragments to opaque cyan via FS override; if cyan
 * shows up where the polyline should be, the VS is producing
 * on-screen geometry. If still empty, the volume isn't rasterizing.
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
    if (t === "error" || (t === "warning" && m.text().includes("validation"))) {
      console.log(`[${t}] ${m.text().slice(0, 250)}`);
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
      debugShowShadowVolume: true,
    });
    v.scene.groundPrimitives.add(polyline);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-75.25, 40.25, 50000),
      orientation: { heading: 0, pitch: -1.57, roll: 0 },
    });
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const cache = polyline._webgpuPolylineCache;
    const _scene = v.scene;
    return {
      cacheVertexCount: cache?.vertexCount,
      cacheIndexCount: cache?.indexCount,
      bs: polyline._boundingSpheres?.[0]
        ? {
            center: polyline._boundingSpheres[0].center?.toString?.(),
            radius: polyline._boundingSpheres[0].radius,
          }
        : "no bs",
      cull: polyline.cull,
      show: polyline.show,
      ready: polyline.ready,
      cameraPosition: v.camera.position?.toString?.(),
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
