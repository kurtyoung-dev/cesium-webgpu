#!/usr/bin/env node
// Probe-all-materials — Batch 140 broad material UB audit.
// @purpose Audits every Material.fromType lit material renders on WebGPU without device errors; reports JS-packed UB layout/size vs WGSL structs.
// @status ACTIVE
//
// Tests every Material.fromType-supported lit material renders without
// device errors and reports JS-packed UB layout + size for comparison
// against WGSL struct declarations.
//
// Each material is loaded as a separate primitive over Pittsburgh
// terrain. Pre-Batch-139 some of these would fail (channels-uniform,
// chunk-marker, imageDimensions bugs). Post-fixes, they should all
// render cleanly.

import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

// Path = "fromType" (canonical) or "direct" (constructor with partial
// uniforms — the path Batch 139's reorder fix targets).
const MATERIALS = [
  // fromType variants (defaults)
  { type: "Color", path: "fromType" },
  { type: "Image", path: "fromType" },
  { type: "DiffuseMap", path: "fromType" },
  { type: "AlphaMap", path: "fromType" },
  { type: "SpecularMap", path: "fromType" },
  { type: "EmissionMap", path: "fromType" },
  { type: "BumpMap", path: "fromType" },
  { type: "NormalMap", path: "fromType" },
  { type: "Grid", path: "fromType" },
  { type: "Stripe", path: "fromType" },
  { type: "Checkerboard", path: "fromType" },
  { type: "Dot", path: "fromType" },
  { type: "Water", path: "fromType" },
  { type: "RimLighting", path: "fromType" },
  { type: "Fade", path: "fromType" },
  { type: "ElevationContour", path: "fromType" },
  { type: "ElevationRamp", path: "fromType" },
  { type: "SlopeRamp", path: "fromType" },
  { type: "AspectRamp", path: "fromType" },
  { type: "ElevationBand", path: "fromType" },
  { type: "WaterMask", path: "fromType" },
  // direct-constructor variants — partial uniforms (forces combine() merge)
  { type: "NormalMap", path: "direct", partial: { strength: 0.75 } },
  { type: "Grid", path: "direct", partial: { cellAlpha: 0.5 } },
  { type: "Stripe", path: "direct", partial: { offset: 0.25 } },
  { type: "Water", path: "direct", partial: { frequency: 5.0 } },
  { type: "Fade", path: "direct", partial: { maximumDistance: 0.75 } },
];

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  const allMessages = [];
  page.on("pageerror", (e) =>
    allMessages.push({ t: "pageerror", text: e.message }),
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

  const result = await page.evaluate(
    async ({ materials }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      v.scene.globe.enableLighting = true;

      const lon = -79.9959;
      const lat = 40.4406;
      const results = [];

      for (let i = 0; i < materials.length; i++) {
        const m = materials[i];
        let material;
        let constructorError;
        try {
          if (m.path === "direct") {
            material = new C.Material({
              fabric: { type: m.type, uniforms: m.partial ?? {} },
            });
          } else {
            material = C.Material.fromType(m.type);
          }
        } catch (e) {
          constructorError = String(e?.message ?? e);
          results.push({
            type: `${m.type}(${m.path})`,
            error: constructorError,
            layoutKeys: null,
            byteSize: null,
            errors_before: 0,
            errors_after: 0,
          });
          continue;
        }

        const dy = i * 0.0004;
        const errsBefore = window.__probeErrors.length;
        let primError = null;
        let prim;
        try {
          prim = new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.PolygonGeometry({
                polygonHierarchy: new C.PolygonHierarchy(
                  C.Cartesian3.fromDegreesArray([
                    lon - 0.0008,
                    lat + dy,
                    lon + 0.0008,
                    lat + dy,
                    lon + 0.0008,
                    lat + dy + 0.0003,
                    lon - 0.0008,
                    lat + dy + 0.0003,
                  ]),
                ),
                height: 240,
                extrudedHeight: 250,
                vertexFormat:
                  C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
              }),
            }),
            appearance: new C.MaterialAppearance({
              material,
              translucent: false,
            }),
            asynchronous: false,
          });
          v.scene.primitives.add(prim);
        } catch (e) {
          primError = String(e?.message ?? e);
        }

        if (i === 0) {
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(lon, lat - 0.004, 600),
            orientation: { pitch: C.Math.toRadians(-25) },
          });
          for (let j = 0; j < 600; j++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
            if (v.scene.globe.tilesLoaded && j > 200) break;
          }
        }
        // Render a few frames specifically with THIS primitive
        for (let j = 0; j < 8; j++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }

        const errsAfter = window.__probeErrors.length;
        const ub = material._uniformBuffer;
        const layoutKeys = ub?._layout ? Array.from(ub._layout.keys()) : null;
        const layoutDetails = ub?._layout
          ? Array.from(ub._layout.entries()).map(([k, v]) => ({
              k,
              offset: v.offset,
              size: v.size,
              type: v.type,
            }))
          : null;
        const byteSize = ub?.gpuData?.byteLength ?? null;
        const totalFloats = ub?._totalFloats ?? null;

        results.push({
          type: `${m.type}(${m.path})`,
          primError,
          layoutKeys,
          layoutDetails,
          byteSize,
          totalFloats,
          errors_before: errsBefore,
          errors_after: errsAfter,
          newErrors: errsAfter - errsBefore,
        });
      }

      return results;
    },
    { materials: MATERIALS },
  );

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-all-materials] results:\n");
  let totalErrors = 0;
  for (const r of result) {
    const status = r.error
      ? "CONSTRUCT-FAIL"
      : r.primError
        ? "PRIM-FAIL"
        : r.newErrors > 0
          ? `${r.newErrors} DEVICE-ERRS`
          : "OK";
    console.log(
      `  ${status.padEnd(20)} ${r.type.padEnd(20)} ${r.byteSize ? r.byteSize + "B" : "(no UB)"}  keys=[${r.layoutKeys?.join(", ") ?? "n/a"}]`,
    );
    if (r.layoutDetails && r.layoutDetails.length > 0) {
      r.layoutDetails.forEach((d) => {
        if (d.size > 0) {
          console.log(
            `      ${d.k.padEnd(18)} offset=${d.offset.toString().padStart(2)}  size=${d.size}  type=${d.type}`,
          );
        }
      });
    }
    if (r.error) console.log(`      ERR: ${r.error.slice(0, 200)}`);
    if (r.primError)
      console.log(`      PRIM-ERR: ${r.primError.slice(0, 200)}`);
    totalErrors += r.newErrors || 0;
  }

  console.log(`\n[probe-all-materials] total device errors: ${totalErrors}`);
  if (errs.length) {
    console.log(`\nFirst 5 device error messages:`);
    errs
      .slice(0, 5)
      .forEach((e) => console.log(`  - ${e.text?.slice(0, 220)}`));
  }
  fs.writeFileSync(
    "Tools/visual-regression/output/all-materials-report.json",
    JSON.stringify(
      { result, totalErrors, sampleErrors: errs.slice(0, 10) },
      null,
      2,
    ),
  );
  console.log(
    `\nReport: Tools/visual-regression/output/all-materials-report.json`,
  );
})();
