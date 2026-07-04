#!/usr/bin/env node
// probe-metadata-table-instance — PARITY-METADATA-TABLE-INSTANCE-SOURCE probe.
//
// Property tables keyed by INSTANCE-sourced feature IDs on WebGPU
// (EXT_mesh_gpu_instancing + EXT_instance_features). Previously only
// primitive ATTRIBUTE / TEXTURE / IMPLICIT feature-ID sources keyed a table
// (METADATA-TABLE-SOURCES, Batch 500). This closes the instance source: the
// renderer packs the per-instance feature ID into the instance-transform pad
// slot (translationHigh.w), the VS forwards it to the flat `featureId0`
// varying, and the generated WGSL keys the table column with
// `i32(metadataFeatureId)` exactly like the attribute/implicit path.
//
// Test asset (authored for this probe):
//   Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources/glTF-Embedded/
//     InstanceFeatureIdPropertyTable.gltf — a 3x3 quad, 4 EXT_mesh_gpu_
//     instancing instances in a 2x2 grid, implicit EXT_instance_features
//     (instance feature ID = instance index), property table
//     'region.intensity' = [10.25, 20.5, 30.75, 40.0].
//
// Cells:
//   A. debug-on (WebGPU) — CesiumWebGPUMetadataDebug paints each instance's
//      table value: metadataDebugColor = vec4(s, 0, 1-s, 1) where
//      s = fract(abs(intensity)). PROOF: the 4 quads show 4 DISTINCT colors
//      whose red channels form the set {0.25, 0.5, 0.75, 0.0}×255 ≈
//      {64,128,191,0}; MODEL_HAS_PROPERTY_TABLES bit set; generated WGSL
//      contains the table textureLoad + the i32(metadataFeatureId) column
//      path (instance source rides featureId0, NOT the FID-texture sample).
//   B. debug-off (WebGPU) — normal render (white quads), 0 metadata paint,
//      0 errors (opt-in default-off gate).
//   C. WebGL baseline — same scene, 4 quads render (geometry parity screenshot).
//
// 0 console/page/device errors required on every WebGPU cell.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL =
  "/Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources/glTF-Embedded/InstanceFeatureIdPropertyTable.gltf";
const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";
const AUTHORED = [10.25, 20.5, 30.75, 40.0];
const PROP_TABLE_BIT = 1 << 20;
const META_BIT = 1 << 18;

async function capture(label, { renderer, metadataDebug }) {
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
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (dev) {
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push({ text: ev?.error?.message ?? "no message" });
    }
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, modelUrl, metadataDebug, metaBit, propTableBit }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      globalThis.CesiumWebGPUMetadataDebug = metadataDebug === true;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.scene.globe.enableLighting = false;
      v.scene.globe.show = false;
      if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = false;

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(view.lon, view.lat, 100),
      );
      let model;
      try {
        model = await C.Model.fromGltfAsync({ url: modelUrl, modelMatrix });
        v.scene.primitives.add(model);
      } catch (e) {
        window.__modelLoadError = String(e?.message ?? e);
      }
      const render = () =>
        new Promise((r) => {
          v.scene.render();
          requestAnimationFrame(r);
        });
      for (let i = 0; i < 600; i++) {
        await render();
        if (model && model.ready && i > 60) break;
      }

      // Look straight down: screen-right = east, screen-up = north.
      const north = C.Matrix4.getColumn(modelMatrix, 1, new C.Cartesian4());
      const up = C.Matrix4.getColumn(modelMatrix, 2, new C.Cartesian4());
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, 120),
        orientation: {
          direction: C.Cartesian3.negate(
            new C.Cartesian3(up.x, up.y, up.z),
            new C.Cartesian3(),
          ),
          up: new C.Cartesian3(north.x, north.y, north.z),
        },
      });
      for (let i = 0; i < 120; i++) {
        await render();
      }

      // Inspect the WebGPU primitive cache.
      const inspect = {
        tableBitSet: null,
        metaBitSet: null,
        materialDefinesHex: null,
        wgslHasTableLoad: null,
        wgslUsesAttributeCol: null,
        wgslSamplesFidTexture: null,
      };
      try {
        const models = [];
        const visit = (p, depth) => {
          if (!p || depth > 6) return;
          if (p._webgpuCache && p._webgpuCache.primitives) models.push(p);
          if (typeof p.length === "number" && typeof p.get === "function") {
            for (let i = 0; i < p.length; i++) visit(p.get(i), depth + 1);
          }
        };
        visit(v.scene.primitives, 0);
        for (const m of models) {
          const prims = m._webgpuCache.primitives;
          for (const pk of Object.keys(prims)) {
            const pc = prims[pk];
            if (pc && typeof pc.materialDefines === "number") {
              const md = pc.materialDefines >>> 0;
              inspect.materialDefinesHex = "0x" + md.toString(16);
              inspect.tableBitSet = (md & propTableBit) !== 0;
              inspect.metaBitSet = (md & metaBit) !== 0;
              if (typeof pc._metadataWGSL === "string") {
                inspect.wgslHasTableLoad =
                  /textureLoad\(metadataPropertyTableTexture/.test(pc._metadataWGSL);
                inspect.wgslUsesAttributeCol =
                  /let metadataTableCol = i32\(metadataFeatureId\);/.test(
                    pc._metadataWGSL,
                  );
                inspect.wgslSamplesFidTexture =
                  /textureSampleLevel\(featureIdTexture/.test(pc._metadataWGSL);
              }
            }
          }
        }
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

      // Sample the 4 quadrant centers. Instances at ±2.5 m, quad 3 m; camera
      // 20 m up @ 60° fov → 2.5 m ≈ 0.22 of the half-viewport.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const off = Math.floor(Math.min(cx, cy) * 0.22);
      const quadrants = {
        NW: { x: cx - off, y: cy - off },
        NE: { x: cx + off, y: cy - off },
        SW: { x: cx - off, y: cy + off },
        SE: { x: cx + off, y: cy + off },
      };
      const pixels = {};
      for (const [k, p] of Object.entries(quadrants)) {
        const d = ctx2d.getImageData(p.x, p.y, 1, 1).data;
        pixels[k] = { r: d[0], g: d[1], b: d[2] };
      }

      return {
        modelReady: !!(model && model.ready),
        modelLoadError: window.__modelLoadError ?? null,
        inspect,
        pixels,
        probeErrors: window.__probeErrors ?? [],
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      modelUrl: MODEL,
      metadataDebug,
      metaBit: META_BIT,
      propTableBit: PROP_TABLE_BIT,
    },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const pngPath = path.join(OUT_DIR, `metadata-table-instance-${label}.png`);
  await page.screenshot({ path: pngPath });

  const errors = messages.filter(
    (m) => m.t === "error" || m.t === "pageerror",
  );
  await browser.close();
  return { diagnostics, errors, pngPath };
}

function nearAny(r, set, tol) {
  return set.some((t) => Math.abs(r - t) <= tol);
}

(async () => {
  const results = {};
  results.debugOn = await capture("webgpu-debug-on", {
    renderer: "webgpu",
    metadataDebug: true,
  });
  results.debugOff = await capture("webgpu-debug-off", {
    renderer: "webgpu",
    metadataDebug: false,
  });
  results.webgl = await capture("webgl-baseline", {
    renderer: "webgl",
    metadataDebug: false,
  });

  const on = results.debugOn.diagnostics;
  const off = results.debugOff.diagnostics;

  // Expected red channels = fract(intensity)*255.
  const expectedReds = AUTHORED.map((v) => Math.round((v - Math.trunc(v)) * 255));
  const onReds = Object.values(on.pixels).map((p) => p.r);

  const checks = [];
  checks.push(["model ready (WebGPU)", on.modelReady === true]);
  checks.push(["MODEL_HAS_PROPERTY_TABLES set", on.inspect.tableBitSet === true]);
  checks.push(["WGSL has property-table textureLoad", on.inspect.wgslHasTableLoad === true]);
  checks.push([
    "WGSL keys column via i32(metadataFeatureId) (instance→featureId0)",
    on.inspect.wgslUsesAttributeCol === true,
  ]);
  checks.push([
    "WGSL does NOT sample a feature-ID texture (instance is not texture-sourced)",
    on.inspect.wgslSamplesFidTexture === false,
  ]);

  // Each authored red value appears in some quadrant (± tol); and there are
  // at least 3 distinct red buckets (proves per-instance variation).
  const tol = 18;
  const matchedAll = expectedReds.every((er) =>
    onReds.some((or) => Math.abs(or - er) <= tol),
  );
  checks.push([
    `each authored fract-red ${JSON.stringify(expectedReds)} present in quads ${JSON.stringify(onReds)}`,
    matchedAll,
  ]);
  const distinct = new Set(onReds.map((r) => Math.round(r / 20))).size;
  checks.push([`>=3 distinct debug reds (got ${distinct})`, distinct >= 3]);
  // Every debug pixel must be a table-derived color (not the plain white quad).
  const allTableColored = Object.values(on.pixels).every((p) =>
    nearAny(p.r, expectedReds, tol) && p.b > 40,
  );
  checks.push(["all 4 quads painted with table debug color", allTableColored]);

  // Off-gate: debug-off quads render the plain (lit) white material — the
  // metadata debug paint is a red/blue gradient (r != b, g == 0), so the
  // off-gate signal is ACHROMATIC (r ~= g ~= b, all non-zero): no debug paint.
  const offAchromatic = Object.values(off.pixels).every(
    (p) =>
      p.r > 20 &&
      Math.abs(p.r - p.g) < 24 &&
      Math.abs(p.r - p.b) < 24 &&
      Math.abs(p.g - p.b) < 24,
  );
  checks.push(["off-gate: debug-off renders achromatic (no debug paint)", offAchromatic]);
  checks.push([
    "off-gate: 0 WebGPU errors (debug-off)",
    results.debugOff.errors.length === 0 &&
      (off.probeErrors?.length ?? 0) === 0,
  ]);
  checks.push([
    "0 WebGPU errors (debug-on)",
    results.debugOn.errors.length === 0 &&
      (on.probeErrors?.length ?? 0) === 0,
  ]);
  checks.push(["WebGL baseline model ready", results.webgl.diagnostics.modelReady === true]);

  console.log("\n=== PARITY-METADATA-TABLE-INSTANCE-SOURCE probe ===");
  console.log("materialDefines (on):", on.inspect.materialDefinesHex);
  console.log("expected fract-reds:", expectedReds);
  console.log("debug-on quad pixels:", JSON.stringify(on.pixels));
  console.log("debug-off quad pixels:", JSON.stringify(off.pixels));
  console.log("wgsl:", JSON.stringify(on.inspect, null, 0));
  if (on.modelLoadError) console.log("MODEL LOAD ERROR (on):", on.modelLoadError);
  console.log("");
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log("\nPNGs:");
  console.log(" ", results.debugOn.pngPath);
  console.log(" ", results.debugOff.pngPath);
  console.log(" ", results.webgl.pngPath);
  console.log(`\n${allPass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  process.exit(allPass ? 0 : 1);
})();
