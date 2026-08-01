#!/usr/bin/env node
// probe-metadata-multicomponent — METADATA-MULTICOMPONENT proof: VEC2/3/4
// property ATTRIBUTES transport EVERY component to the WGSL shader (vec4
// slot-9 transport replacing DP-H46a's `.x`-only f32), and the generated
// `metadataDebugColor` paints the RAW per-component values as RGB.
//
// Asset: Specs/Data/Models/glTF-2.0/BoxVec3PropertyAttributes — a cube whose
// `_FACE_COLOR` VEC3 FLOAT32 property attribute is CONSTANT per face (all 4
// verts of a face share the value), so @interpolate(flat) yields exactly the
// authored vec3 for every fragment of that face. Authored palette (RGB 0-255):
//   +X (255, 77, 26)   -X (26, 255, 77)   +Y (51, 102, 255)
//   -Y (255, 255, 51)  +Z (255, 51, 255)  -Z (51, 255, 255)
// Every face has a LARGE green and/or blue component — under the old
// `.x`-only transport the paint would be (r, 0, 0): pure dark reds. Matching
// ≥3 authored colors on screen is therefore conclusive multi-component proof.
//
// Scenes (all WebGPU):
//   A. vec3-debug-on  — CesiumWebGPUMetadataDebug=true → faces painted with
//      the authored RGB. PASS = ≥3 distinct authored colors matched on the
//      model + generated WGSL declares `metadataValue: vec4<f32>` transport,
//      a `faceColor: vec3<f32>` field populated from `.xyz`, and
//      `fn metadataDebugColor`.
//   B. vec3-debug-off — same model, debug off → normally-lit white box; no
//      authored-palette match (paint path gated off), 0 errors.
//
// 0 console / device-validation errors required on every scene.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 256.0 };
const MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxVec3PropertyAttributes/glTF-Embedded/BoxVec3PropertyAttributes.gltf";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

// Authored per-face VEC3 values (0-255 space), from make_vec3_box.py.
const EXPECTED = [
  { name: "+X", rgb: [255, 77, 26] },
  { name: "-X", rgb: [26, 255, 77] },
  { name: "+Y", rgb: [51, 102, 255] },
  { name: "-Y", rgb: [255, 255, 51] },
  { name: "+Z", rgb: [255, 51, 255] },
  { name: "-Z", rgb: [51, 255, 255] },
];

async function capture(label, { metadataDebug }) {
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
    messages.push({ t: "pageerror", text: e.message, stack: e.stack ?? null }),
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
      window.__probeErrors.push({ text: ev?.error?.message ?? "no message" });
    };
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, modelUrl, metadataDebug, expected }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      globalThis.CesiumWebGPUMetadataDebug = metadataDebug === true;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      v.scene.globe.enableLighting = false;

      const scale = 12.0;
      const modelHeight = 400;
      const modelPos = C.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        modelHeight,
      );
      const orientation = C.Transforms.headingPitchRollQuaternion(
        modelPos,
        new C.HeadingPitchRoll(0, 0, 0),
      );
      const entity = v.entities.add({
        position: modelPos,
        orientation,
        model: { uri: modelUrl, scale, minimumPixelSize: 128 },
      });

      for (let i = 0; i < 600; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        // Heading/pitch chosen so THREE faces are visible at once.
        await v.zoomTo(
          entity,
          new C.HeadingPitchRange(
            C.Math.toRadians(45),
            C.Math.toRadians(-35),
            scale * 3.0,
          ),
        );
      } catch (e) {
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(
            view.lon,
            view.lat,
            modelHeight + scale * 4,
          ),
          orientation: { heading: 0, pitch: C.Math.toRadians(-30) },
        });
      }
      for (let i = 0; i < 300; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Inspect the generated metadata WGSL on the model's primitive cache.
      const inspect = {
        metadataBitSet: null,
        hasMetadataBuffer: null,
        materialDefinesHex: null,
        cacheFound: false,
        generatedWGSL: null,
        wgslVec4Transport: null,
        wgslVec3Field: null,
        wgslXyzSwizzle: null,
        wgslHasDebugColor: null,
        wgslHasDebugScalar: null,
      };
      try {
        const META_BIT = 1 << 18;
        const models = [];
        const visit = (p, depth) => {
          if (!p || depth > 6) return;
          if (p._webgpuCache && p._webgpuCache.primitives) models.push(p);
          if (typeof p.length === "number" && typeof p.get === "function") {
            for (let i = 0; i < p.length; i++) visit(p.get(i), depth + 1);
          }
          if (p._model) visit(p._model, depth + 1);
          if (p._primitive) visit(p._primitive, depth + 1);
        };
        visit(v.scene.primitives, 0);
        const dsd = v.dataSourceDisplay;
        if (dsd?._primitives) visit(dsd._primitives, 0);
        if (dsd?.defaultDataSource?._primitives)
          visit(dsd.defaultDataSource._primitives, 0);

        for (const model of models) {
          const prims = model._webgpuCache.primitives;
          for (const pk of Object.keys(prims)) {
            const pc = prims[pk];
            if (pc && typeof pc.materialDefines === "number") {
              inspect.cacheFound = true;
              const md = pc.materialDefines >>> 0;
              const bit = (md & META_BIT) !== 0;
              if (bit || inspect.materialDefinesHex === null) {
                inspect.materialDefinesHex = "0x" + md.toString(16);
                inspect.metadataBitSet = bit;
                inspect.hasMetadataBuffer = !!pc._metadataBuffer;
                if (typeof pc._metadataWGSL === "string") {
                  const w = pc._metadataWGSL;
                  inspect.generatedWGSL = w;
                  inspect.wgslVec4Transport =
                    /initializeMetadata\(metadataValue:\s*vec4<f32>/.test(w);
                  inspect.wgslVec3Field = /faceColor:\s*vec3<f32>/.test(w);
                  inspect.wgslXyzSwizzle =
                    /metadata\.faceColor\s*=\s*metadataValue\.xyz/.test(w);
                  inspect.wgslHasDebugColor = /fn\s+metadataDebugColor\b/.test(
                    w,
                  );
                  inspect.wgslHasDebugScalar =
                    /fn\s+metadataDebugScalar\b/.test(w);
                }
              }
              if (bit) break;
            }
          }
          if (inspect.metadataBitSet) break;
        }
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

      // Sample a grid over the model and classify against the authored
      // palette. Tolerance is generous (post-process may nudge values) but
      // far tighter than the palette spacing.
      const canvas = v.canvas;
      const grid = {
        matchedFaces: {},
        matchedFaceCount: 0,
        totalSamples: 0,
        matchedSamples: 0,
        greenOrBlueDominant: 0,
        distinctColors: 0,
        centerPixel: null,
      };
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const half = 200;
        const step = 8;
        const TOL = 70; // per-channel
        const seen = new Set();
        for (let dy = -half; dy <= half; dy += step) {
          for (let dx = -half; dx <= half; dx += step) {
            const px = Math.max(0, Math.min(canvas.width - 1, cx + dx));
            const py = Math.max(0, Math.min(canvas.height - 1, cy + dy));
            const d = ctx2d.getImageData(px, py, 1, 1).data;
            grid.totalSamples++;
            seen.add(((d[0] >> 4) << 8) | ((d[1] >> 4) << 4) | (d[2] >> 4));
            for (const face of expected) {
              if (
                Math.abs(d[0] - face.rgb[0]) <= TOL &&
                Math.abs(d[1] - face.rgb[1]) <= TOL &&
                Math.abs(d[2] - face.rgb[2]) <= TOL
              ) {
                grid.matchedFaces[face.name] =
                  (grid.matchedFaces[face.name] ?? 0) + 1;
                grid.matchedSamples++;
                break;
              }
            }
            // Any sample whose G or B channel dominates R proves a non-.x
            // component reached the shader (the .x-only regression paints
            // (r, 0, 0) dark reds only).
            if (d[1] > 140 || d[2] > 140) {
              if (d[1] > d[0] + 30 || d[2] > d[0] + 30) {
                grid.greenOrBlueDominant++;
              }
            }
          }
        }
        // Faces with a meaningful sample count (>=4 samples ≈ not noise).
        grid.matchedFaceCount = Object.values(grid.matchedFaces).filter(
          (n) => n >= 4,
        ).length;
        grid.distinctColors = seen.size;
        const cd = ctx2d.getImageData(cx, cy, 1, 1).data;
        grid.centerPixel = { r: cd[0], g: cd[1], b: cd[2], a: cd[3] };
      } catch (e) {
        grid.error = String(e?.message ?? e);
      }

      return {
        modelUrl,
        metadataDebug: globalThis.CesiumWebGPUMetadataDebug,
        tilesLoaded: v.scene.globe.tilesLoaded,
        inspect,
        grid,
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      modelUrl: MODEL,
      metadataDebug,
      expected: EXPECTED,
    },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(300);
  const out = path.join(OUT_DIR, `metadata-multicomponent-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-metadata-multicomponent] VEC3 property-attribute full-component transport\n",
  );

  const A = await capture("a-debug-on", { metadataDebug: true });
  const B = await capture("b-debug-off", { metadataDebug: false });

  const fails = [];
  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const cell of [A, B]) {
    const g = cell.diagnostics.grid;
    const ins = cell.diagnostics.inspect;
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    console.log(`  [${cell.label}]`);
    console.log(
      `    inspect: bit=${ins.metadataBitSet} buf=${ins.hasMetadataBuffer} md=${ins.materialDefinesHex}`,
    );
    console.log(
      `    wgsl: vec4Transport=${ins.wgslVec4Transport} vec3Field=${ins.wgslVec3Field} xyzSwizzle=${ins.wgslXyzSwizzle} debugColor=${ins.wgslHasDebugColor} debugScalar=${ins.wgslHasDebugScalar}`,
    );
    console.log(
      `    grid: matchedFaces=${JSON.stringify(g.matchedFaces)} faceCount=${g.matchedFaceCount} matched=${g.matchedSamples}/${g.totalSamples} gbDominant=${g.greenOrBlueDominant} distinct=${g.distinctColors}`,
    );
    console.log(
      `    center=rgb(${g.centerPixel?.r},${g.centerPixel?.g},${g.centerPixel?.b}) errors: device=${cell.deviceErrors.length} pageerror=${pageErrors.length} console.error=${consoleErrs.length}`,
    );
    cell.deviceErrors
      .slice(0, 3)
      .forEach((e) => console.log(`      device: ${e.text?.slice(0, 200)}`));
    pageErrors
      .slice(0, 2)
      .forEach((e) =>
        console.log(`      pageerror: ${(e.text ?? "").slice(0, 200)}`),
      );
    consoleErrs
      .slice(0, 3)
      .forEach((e) =>
        console.log(
          `      console.error: ${(e.text ?? "").split("\n")[0].slice(0, 200)}`,
        ),
      );
    if (
      cell.deviceErrors.length > 0 ||
      pageErrors.length > 0 ||
      consoleErrs.length > 0
    ) {
      fails.push(`${cell.label}: errors present`);
    }
    report.cells.push({
      label: cell.label,
      screenshot: cell.out,
      metadataDebug: cell.diagnostics.metadataDebug,
      inspect: { ...ins, generatedWGSL: undefined },
      grid: {
        matchedFaces: g.matchedFaces,
        matchedFaceCount: g.matchedFaceCount,
        matchedSamples: g.matchedSamples,
        totalSamples: g.totalSamples,
        greenOrBlueDominant: g.greenOrBlueDominant,
        distinctColors: g.distinctColors,
        centerPixel: g.centerPixel,
      },
      deviceErrorCount: cell.deviceErrors.length,
      pageErrorCount: pageErrors.length,
      consoleErrorCount: consoleErrs.length,
    });
  }

  const insA = A.diagnostics.inspect;
  const gA = A.diagnostics.grid;
  const gB = B.diagnostics.grid;
  if (insA.metadataBitSet !== true) fails.push("A: MODEL_HAS_METADATA not set");
  if (insA.wgslVec4Transport !== true)
    fails.push("A: generated WGSL lacks vec4<f32> transport signature");
  if (insA.wgslVec3Field !== true)
    fails.push("A: generated WGSL lacks faceColor: vec3<f32> field");
  if (insA.wgslXyzSwizzle !== true)
    fails.push("A: faceColor not populated from metadataValue.xyz");
  if (insA.wgslHasDebugColor !== true)
    fails.push("A: generated WGSL lacks metadataDebugColor");
  if (gA.matchedFaceCount < 3)
    fails.push(
      `A: only ${gA.matchedFaceCount} authored face colors matched (need >=3 — multi-component transport broken?)`,
    );
  if (gA.greenOrBlueDominant < 20)
    fails.push(
      `A: only ${gA.greenOrBlueDominant} green/blue-dominant samples — .yz components not reaching the shader?`,
    );
  if (gB.matchedFaceCount > 0)
    fails.push("B: authored palette visible with debug OFF (gate broken)");

  if (A.diagnostics.inspect.generatedWGSL) {
    console.log("\n    ===== GENERATED METADATA WGSL CHUNK (scene A) =====");
    console.log(
      A.diagnostics.inspect.generatedWGSL
        .split("\n")
        .map((l) => "    | " + l)
        .join("\n"),
    );
    console.log("    ===================================================\n");
  }

  report.pass = fails.length === 0;
  report.fails = fails;
  const reportPath = path.join(OUT_DIR, "metadata-multicomponent-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  report: ${reportPath}`);
  console.log(
    fails.length === 0
      ? "\n  RESULT: PASS"
      : `\n  RESULT: FAIL\n    - ${fails.join("\n    - ")}`,
  );
  process.exit(fails.length === 0 ? 0 : 1);
})();
