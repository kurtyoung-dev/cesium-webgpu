#!/usr/bin/env node
/**
 * Deep probe of the GroundPolyline render pipeline:
 * @purpose GroundPolyline bring-up deep-dump: UBO floats, interleaved vertices, red-pixel footprint — from when the shadow volume rendered nothing
 * @status INVESTIGATION
 *
 *  - Dumps the UBO Float32Array (first 96 floats — 6 mat4 + scalars + flags)
 *  - Dumps the first 4 interleaved vertices (47 floats each) from cache buffer
 *  - Pulls the canvas to a buffer and counts (R > G+B+10) pixels — i.e. red
 *  - Reports whether the polyline left ANY red footprint on screen
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
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const cache = polyline._webgpuPolylineCache;
    const uniformData = cache?.uniformData;
    const ud = uniformData ? Array.from(uniformData.slice(0, 96)) : null;

    // Read canvas red pixels.
    const canvas = v.canvas;
    const w = canvas.width,
      h = canvas.height;
    // Use a 2D draw-image trick: copy the WebGPU canvas to a 2D canvas
    // so we can getImageData (WebGPU canvases don't support it directly).
    const c2 = document.createElement("canvas");
    c2.width = w;
    c2.height = h;
    const ctx = c2.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const pixels = img.data;

    let redPixels = 0;
    let strongRedPixels = 0;
    let firstRedXY = null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = pixels[i],
          g = pixels[i + 1],
          b = pixels[i + 2];
        if (r > g + 10 && r > b + 10 && r > 50) {
          redPixels++;
          if (r > 180 && g < 80 && b < 80) {
            strongRedPixels++;
            if (!firstRedXY) firstRedXY = [x, y, r, g, b];
          }
        }
      }
    }

    return {
      cacheState: {
        vertexCount: cache?.vertexCount,
        indexCount: cache?.indexCount,
        batchInstanceCount: cache?.batchInstanceCount,
      },
      uboFirst96Floats: ud,
      uboKeyFields: ud
        ? {
            mvRTE_diag: [ud[0], ud[5], ud[10], ud[15]],
            proj_diag: [ud[16], ud[21], ud[26], ud[31]],
            normal0: ud.slice(48, 52),
            camH: ud.slice(60, 64),
            camL: ud.slice(64, 68),
            viewport: ud.slice(68, 72),
            color: ud.slice(72, 76),
            misc_widthPixels_globeMinAlt_geomTol: [ud[80], ud[82], ud[83]],
            flags_debugVolume_batchCount_is3D_morphTime: ud.slice(84, 88),
          }
        : null,
      pixels: { redPixels, strongRedPixels, firstRedXY, totalPixels: w * h },
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
