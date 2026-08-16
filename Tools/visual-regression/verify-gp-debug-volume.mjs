#!/usr/bin/env node
/**
 * Like verify-ground-polyline-zoom but with `_debugShowShadowVolume`
 * enabled on the polyline so the FS visualizes the swept volume in
 * translucent dark red (the discard branch). Helps differentiate
 * between "VS produces no on-screen geometry" and "classifier discards
 * everything".
 * @purpose Differential GP diagnostic: renders with _debugShowShadowVolume to split 'VS emits nothing' from 'classifier discards everything'.
 * @status INVESTIGATION
 *
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  await page.evaluate(async () => {
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
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });

  const buf = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-gp-debug-volume.png",
    buf,
  );
  console.log(`PNG bytes: ${buf.length}`);
  await browser.close();
})();
