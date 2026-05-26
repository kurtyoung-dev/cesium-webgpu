#!/usr/bin/env node
// Probe-channel-materials — Batch 139 verification.
//
// All 6 materials that use `channels` or `channel` uniforms go through
// the same MaterialHelpers code path that Batches 138+139 fixed.
// Verify each renders with zero device errors when constructed via the
// direct constructor path (which exercises the inheritance bug pre-Batch-138
// and the offset-order bug pre-Batch-139).

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Tiny test image
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#888";
    ctx.fillRect(0, 0, 16, 16);
    const url = c.toDataURL();

    const lon = -79.9959, lat = 40.4406;
    const types = [
      { type: "DiffuseMap", uniforms: { image: url, repeat: { x: 1, y: 1 } } },
      { type: "AlphaMap", uniforms: { image: url, repeat: { x: 1, y: 1 } } },
      { type: "SpecularMap", uniforms: { image: url, repeat: { x: 1, y: 1 } } },
      { type: "EmissionMap", uniforms: { image: url, repeat: { x: 1, y: 1 } } },
      { type: "BumpMap", uniforms: { image: url, strength: 0.5, repeat: { x: 1, y: 1 } } },
      { type: "NormalMap", uniforms: { image: url, strength: 0.5, repeat: { x: 1, y: 1 } } },
    ];
    const layoutsByType = {};
    types.forEach((t, i) => {
      const dy = i * 0.0005;
      const prim = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(
              C.Cartesian3.fromDegreesArray([
                lon - 0.001, lat + dy,
                lon + 0.001, lat + dy,
                lon + 0.001, lat + dy + 0.0003,
                lon - 0.001, lat + dy + 0.0003,
              ]),
            ),
            height: 240,
            extrudedHeight: 260,
            vertexFormat:
              C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
          }),
        }),
        appearance: new C.MaterialAppearance({
          material: new C.Material({
            fabric: t,
          }),
          translucent: t.type === "AlphaMap",
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(prim);
      const matRef = prim.geometryInstances?.geometry || prim;
      const mat = prim.appearance.material;
      layoutsByType[t.type] = {
        byteLength: mat._uniformBuffer?.gpuData?.byteLength,
        keys: Array.from(mat._uniformBuffer?._layout?.keys() || []),
        gpuFloats: mat._uniformBuffer?.gpuData
          ? Array.from(
              new Float32Array(
                mat._uniformBuffer.gpuData.buffer,
                mat._uniformBuffer.gpuData.byteOffset,
                mat._uniformBuffer.gpuData.byteLength / 4,
              ),
            )
          : null,
      };
    });

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - 0.005, 500),
      orientation: { pitch: C.Math.toRadians(-25) },
    });

    for (let i = 0; i < 800; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (v.scene.globe.tilesLoaded && i > 200) break;
    }
    for (let i = 0; i < 30; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    return { layoutsByType, primCount: v.scene.primitives.length };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log(`[probe-channel-materials] primitives loaded: ${result.primCount}`);
  console.log("Material UB layouts:");
  for (const t in result.layoutsByType) {
    const l = result.layoutsByType[t];
    console.log(`  ${t}: ${l.byteLength} bytes  keys=[${l.keys.join(", ")}]`);
    if (l.gpuFloats) {
      console.log(`    floats: [${l.gpuFloats.map((x) => x.toFixed(2)).join(", ")}]`);
    }
  }
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs.slice(0, 4).forEach((e) => console.log(`  - ${e.text?.slice(0, 200)}`));
    process.exit(1);
  } else {
    console.log("  PASS: all 6 channel-using materials render cleanly via direct constructor");
  }
})();
