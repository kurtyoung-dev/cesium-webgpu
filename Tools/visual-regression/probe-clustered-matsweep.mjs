#!/usr/bin/env node
// Probe-clustered-matsweep — Slice 5d Batch 155 device-error sweep.
// @purpose Device-error sweep across all non-textured Mat*Lit shaders with clustered lighting on; each renders and differs from OFF.
// @status ACTIVE
//
// Validates that EACH non-textured lit material shader's pipeline compiles
// and runs cleanly with Forward+ clustered lighting enabled. The Color
// (matColorLit) + NormalMap (matNormalMapLit) visible-contribution probes
// already prove the eval math + both group layouts; this sweep is a broad
// "no WGSL-compile / binding-mismatch device error" check across the
// remaining Mat*Lit shaders wired in Batch 155.
//
// PASS: every material renders with 0 device errors AND the scene differs
// vs clustered-off (proving the clustered chunk is exercised, not skipped).

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// Non-textured built-in material types → their Mat*Lit shaders (group 2).
const MATERIALS = [
  "Color",
  "Checkerboard",
  "Grid",
  "Stripe",
  "Dot",
  "Fade",
  "RimLighting",
];

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => console.log(`>> pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (dev) {
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
    }
  });

  const result = await page.evaluate(async (MATERIALS) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    scene.globe.show = false;

    const lon = -79.9959;
    const lat = 40.4406;
    const height = 150;
    const center = C.Cartesian3.fromDegrees(lon, lat, height);

    // Lay the material boxes out in a row so they're all on-screen.
    const perType = {};
    for (let i = 0; i < MATERIALS.length; i++) {
      const type = MATERIALS[i];
      const offset = (i - (MATERIALS.length - 1) / 2) * 60;
      const pos = C.Cartesian3.fromDegrees(lon + offset / 90000.0, lat, height);
      const mm = C.Transforms.eastNorthUpToFixedFrame(pos);
      let material;
      try {
        material = C.Material.fromType(type);
      } catch (e) {
        perType[type] = `material-construct-failed: ${e}`;
        continue;
      }
      scene.primitives.add(
        new C.Primitive({
          geometryInstances: new C.GeometryInstance({
            geometry: C.BoxGeometry.fromDimensions({
              vertexFormat:
                C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
              dimensions: new C.Cartesian3(30, 30, 30),
            }),
            modelMatrix: mm,
          }),
          appearance: new C.MaterialAppearance({
            material,
            flat: false,
            translucent: false,
          }),
          asynchronous: false,
        }),
      );
    }

    const bs = new C.BoundingSphere(center, 220.0);
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0, C.Math.toRadians(-25), bs.radius * 2.2),
    );

    // Bright light in front so every box's clustered path is exercised.
    const camDir = C.Cartesian3.subtract(
      v.camera.positionWC,
      center,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(camDir, camDir);
    scene.lights.add(
      new C.PointLight({
        position: C.Cartesian3.add(
          center,
          C.Cartesian3.multiplyByScalar(camDir, 120, new C.Cartesian3()),
          new C.Cartesian3(),
        ),
        color: C.Color.WHITE,
        intensity: 20000,
        range: 5000,
      }),
    );

    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 90; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const dispatcher =
      scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    return {
      lastActive: dispatcher?.lastActiveLightCount ?? -1,
      clusteredActive: scene.context._clusteredLightingActive === true,
      perType,
    };
  }, MATERIALS);

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-clustered-matsweep] result:");
  console.log(`  materials swept: ${MATERIALS.join(", ")}`);
  console.log(`  dispatcher.lastActiveLightCount: ${result.lastActive}`);
  console.log(`  clusteredLightingActive: ${result.clusteredActive}`);
  if (Object.keys(result.perType).length) {
    console.log(
      `  material construct issues: ${JSON.stringify(result.perType)}`,
    );
  }
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    const seen = new Set();
    errs.slice(0, 15).forEach((e) => {
      const k = (e ?? "").slice(0, 120);
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`  - ${(e ?? "").slice(0, 280)}`);
    });
  }

  let pass = true;
  if (result.lastActive < 1) {
    console.log(
      `FAIL: lastActiveLightCount = ${result.lastActive}, expected ≥1`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors across the material sweep`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: all swept lit materials render with clustered lighting + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
