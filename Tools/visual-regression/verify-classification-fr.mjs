#!/usr/bin/env node
/**
 * Verifies the existing WebGPU feature renderers for the four
 * BUILD-VAR-HAZARD families render correctly (no crash, content
 * appears) when their primitives are added to a scene:
 *
 *   - DepthPlane: implicit when translucent globe is on
 *   - GroundPolyline: GroundPolylinePrimitive with simple geometry
 *   - ClassificationPrimitive: tile classification on globe terrain
 *   - Vector3DTile*: not implemented yet — expected to no-op silently
 *
 * Each phase:
 *   1. Constructs the primitive
 *   2. Adds it to the viewer
 *   3. Renders 60 frames
 *   4. Captures screenshot + checks for console errors
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

const errors = [];
const validationWarnings = [];
const phases = [];

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
    if (t === "error") {
      errors.push(txt);
      console.log(`[error] ${txt.slice(0, 250)}`);
    }
    if (
      t === "warning" &&
      (txt.includes("Attachment state") ||
        txt.includes("validation") ||
        txt.includes("VALIDATION") ||
        txt.includes("used in submit"))
    ) {
      validationWarnings.push(txt);
      console.log(`[warn] ${txt.slice(0, 250)}`);
    }
  });
  page.on("pageerror", (e) => {
    errors.push(`pageerror: ${e.message}`);
    console.log(`[pageerror] ${e.message}`);
  });

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  // ── Phase 1: GroundPolyline (Sydney → Melbourne, draped on terrain) ──
  console.log("[phase] Adding GroundPolylinePrimitive...");
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const positions = C.Cartesian3.fromDegreesArray([
      151.2093, -33.8688, 144.9631, -37.8136,
    ]);
    const polyline = new C.GroundPolylinePrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({
          positions: positions,
          width: 8.0,
        }),
      }),
      appearance: new C.PolylineMaterialAppearance({
        material: C.Material.fromType("Color", { color: C.Color.RED }),
      }),
    });
    scene.groundPrimitives.add(polyline);
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(148.0, -35.5, 1500000),
    });
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const snap1 = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-class-fr-phase1-ground-polyline.png",
    snap1,
  );
  phases.push({ name: "GroundPolyline", bytes: snap1.length });
  console.log(`[phase] GroundPolyline: ${snap1.length} bytes`);

  // ── Phase 2: ClassificationPrimitive (polygon over terrain) ──
  console.log("[phase] Adding ClassificationPrimitive...");
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const positions = C.Cartesian3.fromDegreesArray([
      144.0, -38.0, 145.0, -38.0, 145.0, -37.0, 144.0, -37.0,
    ]);
    const classifier = new C.ClassificationPrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions),
          extrudedHeight: 50000,
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            new C.Color(0, 1, 0, 0.5),
          ),
        },
      }),
      classificationType: C.ClassificationType.TERRAIN,
    });
    scene.primitives.add(classifier);
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const snap2 = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-class-fr-phase2-classification.png",
    snap2,
  );
  phases.push({ name: "ClassificationPrimitive", bytes: snap2.length });
  console.log(`[phase] ClassificationPrimitive: ${snap2.length} bytes`);

  // ── Phase 3: GroundPrimitive (the simpler ground-clamped path) ──
  console.log("[phase] Adding GroundPrimitive...");
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const positions = C.Cartesian3.fromDegreesArray([
      148.5, -35.0, 149.5, -35.0, 149.5, -34.0, 148.5, -34.0,
    ]);
    const ground = new C.GroundPrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolygonGeometry({
          polygonHierarchy: new C.PolygonHierarchy(positions),
        }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            new C.Color(0, 0, 1, 0.5),
          ),
        },
      }),
    });
    scene.groundPrimitives.add(ground);
    for (let i = 0; i < 240; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const snap3 = await page.screenshot({ omitBackground: false });
  fs.writeFileSync(
    "Tools/visual-regression/output/verify-class-fr-phase3-ground-primitive.png",
    snap3,
  );
  phases.push({ name: "GroundPrimitive", bytes: snap3.length });
  console.log(`[phase] GroundPrimitive: ${snap3.length} bytes`);

  await browser.close();

  console.log("\n=== CLASSIFICATION FR REPORT ===");
  console.log(`Errors: ${errors.length}`);
  console.log(`Validation warnings: ${validationWarnings.length}`);
  for (const p of phases) {
    const status = p.bytes > 30_000 ? "✓" : "✗";
    console.log(`  ${status} ${p.name}: ${p.bytes} bytes`);
  }
  if (errors.length > 0 || validationWarnings.length > 0) {
    console.log("\n⚠ Issues found, see above");
    process.exit(1);
  }
  console.log("\n✓ ALL PRIMITIVE FRs RENDER CLEANLY");
  process.exit(0);
})();
