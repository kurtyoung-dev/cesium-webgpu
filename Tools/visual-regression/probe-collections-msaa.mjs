#!/usr/bin/env node
// Probe-collections-msaa — Batch 134 verification.
// @purpose MSAA=4 pipeline regression: collection + ground-primitive pipelines must bake multisample count 4 (pre-B134 validation errors).
// @status ACTIVE
//
// Loads billboards + labels + polylines + point primitives + ground
// primitive + ground polyline simultaneously, with MSAA=4 active.
// Pre-Batch-134 the descriptor builders dropped the `multisample` field,
// defaulting to sampleCount=1 against the MSAA=4 scene FB pass and
// producing 1846-class validation errors. Post-Batch-134 these pipelines
// bake `multisample: { count: 4 }` from `context._msaaSamples`.
//
// Expected: 0 device errors across the matrix.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

async function run() {
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
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
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

  const diagnostics = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Confirm MSAA=4 is on (default Scene.msaaSamples = 4).
    const msaa = v.scene.msaaSamples;

    // Spawn ALL 6 collection types over Pittsburgh.
    const lon = -79.9959;
    const lat = 40.4406;
    const h = 500;

    // Billboards (3, with PNG image).
    const billboards = new C.BillboardCollection();
    const tex = document.createElement("canvas");
    tex.width = 32;
    tex.height = 32;
    const ctx = tex.getContext("2d");
    ctx.fillStyle = "yellow";
    ctx.fillRect(0, 0, 32, 32);
    const pngUrl = tex.toDataURL("image/png");
    for (let i = -1; i <= 1; i++) {
      billboards.add({
        position: C.Cartesian3.fromDegrees(lon + i * 0.001, lat, h),
        image: pngUrl,
        width: 24,
        height: 24,
      });
    }
    v.scene.primitives.add(billboards);

    // Labels.
    const labels = new C.LabelCollection();
    for (let i = -1; i <= 1; i++) {
      labels.add({
        position: C.Cartesian3.fromDegrees(lon + i * 0.001, lat + 0.0005, h),
        text: `L${i}`,
        font: "16px sans-serif",
        fillColor: C.Color.WHITE,
      });
    }
    v.scene.primitives.add(labels);

    // Point primitives.
    const points = new C.PointPrimitiveCollection();
    for (let i = -1; i <= 1; i++) {
      points.add({
        position: C.Cartesian3.fromDegrees(lon + i * 0.001, lat - 0.0005, h),
        color: C.Color.CYAN,
        pixelSize: 8,
      });
    }
    v.scene.primitives.add(points);

    // Polyline.
    const polylines = new C.PolylineCollection();
    polylines.add({
      positions: C.Cartesian3.fromDegreesArrayHeights([
        lon - 0.002,
        lat + 0.001,
        h,
        lon + 0.002,
        lat + 0.001,
        h,
      ]),
      width: 3,
      material: C.Material.fromType("Color", { color: C.Color.MAGENTA }),
    });
    v.scene.primitives.add(polylines);

    // Ground polyline (uses GroundPolylineGeometry / classification primitive).
    const groundPolyline = new C.GroundPolylinePrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({
          positions: C.Cartesian3.fromDegreesArray([
            lon - 0.003,
            lat - 0.001,
            lon + 0.003,
            lat - 0.001,
          ]),
          width: 4.0,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            new C.Color(1.0, 0.5, 0.0, 1.0),
          ),
        },
      }),
      appearance: new C.PolylineColorAppearance(),
      asynchronous: false,
    });
    v.scene.groundPrimitives.add(groundPolyline);

    // Camera.
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - 0.005, h + 500),
      orientation: { pitch: C.Math.toRadians(-30) },
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

    return {
      msaa,
      billboardCount: billboards.length,
      labelCount: labels.length,
      pointCount: points.length,
      polylineCount: polylines.length,
      groundPrimitiveCount: v.scene.groundPrimitives.length,
    };
  });

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, "collections-msaa.png");
  await page.screenshot({ path: out });
  await browser.close();

  console.log("[probe-collections-msaa] diagnostics:", diagnostics);
  console.log(`[probe-collections-msaa] device errors: ${deviceErrors.length}`);
  if (deviceErrors.length) {
    deviceErrors
      .slice(0, 5)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 240)}`));
  } else {
    console.log(
      "  PASS: zero device errors with MSAA=4 + all 6 collection types",
    );
  }
  console.log(`[probe-collections-msaa] screenshot: ${out}`);

  // Look for pipeline / multisample related console errors too.
  const interesting = messages.filter(
    (m) =>
      /multisample|sampleCount|validation|render pass|pipeline/i.test(m.text) &&
      m.t !== "log",
  );
  if (interesting.length) {
    console.log("[probe-collections-msaa] pipeline-related console messages:");
    interesting
      .slice(0, 8)
      .forEach((m) => console.log(`  [${m.t}] ${m.text.slice(0, 240)}`));
  }

  process.exit(deviceErrors.length ? 1 : 0);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await run();
})();
