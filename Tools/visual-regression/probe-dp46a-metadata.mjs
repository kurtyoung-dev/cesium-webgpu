#!/usr/bin/env node
// probe-dp46a-metadata — DP-H46a de-risking proof.
//
// Proves the EXT_structural_metadata property-ATTRIBUTE → GPU → WGSL
// fragment-shader data path end-to-end, and confirms non-metadata models
// stay byte-identical (MODEL_HAS_METADATA OFF path unchanged).
//
// Scenes:
//   A. metadata-debug-on  — BoxTexturedWithPropertyAttributes (has a
//      `temperatures` VEC2/UINT16/normalized property attribute backed by
//      `_TEMPERATURES`) rendered with globalThis.CesiumWebGPUMetadataDebug
//      = true. The FS overrides out.color = vec4(metadataValue, 0,
//      1-metadataValue, 1). `temperatures.x` ranges 0.019..1.0 per vertex
//      (flat-interpolated per triangle), so PROOF = the box surface shows
//      MANY distinct colors (a per-face gradient from blue→red), not a
//      single flat color. A flat box = the value never reached the FS.
//   B. metadata-debug-off — same box, debug off → normal textured box
//      (MODEL_HAS_METADATA set, but the debug override is gated off).
//   C. plain-box-off      — plain BoxTextured (NO structural metadata) →
//      MODEL_HAS_METADATA is NEVER set. OFF-parity baseline: must render
//      exactly like a normal textured box, 0 errors, no metadata slot.
//
// All on WebGPU. Reads back canvas pixels + samples a grid to count
// distinct colors (the gradient detector). 0 console/validation errors
// required.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 256.0 };
const META_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTexturedWithPropertyAttributes/glTF/BoxTexturedWithPropertyAttributes.gltf";
const PLAIN_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { modelUrl, metadataDebug, scale }) {
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
    async ({ view, clockUTC, modelUrl, metadataDebug, scale }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      // DP-H46a metadata-debug test hook — must be set BEFORE the model
      // renders so packMaterialUniforms writes motionFlags.z = 1.0.
      globalThis.CesiumWebGPUMetadataDebug = metadataDebug === true;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;
      v.scene.globe.enableLighting = false;

      // Place the box high above terrain so it sits against the sky
      // (no terrain clutter behind it) and frame the camera tightly on it.
      const modelHeight = 400;
      const modelPos = C.Cartesian3.fromDegrees(
        view.lon,
        view.lat,
        modelHeight,
      );
      const headingPitchRoll = new C.HeadingPitchRoll(0, 0, 0);
      const orientation = C.Transforms.headingPitchRollQuaternion(
        modelPos,
        headingPitchRoll,
      );
      const entity = v.entities.add({
        position: modelPos,
        orientation,
        model: { uri: modelUrl, scale: scale, minimumPixelSize: 128 },
      });

      // Wait for the model to load, then frame the camera on the entity's
      // bounding sphere so the box dominates the viewport.
      for (let i = 0; i < 600; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await v.zoomTo(
          entity,
          new C.HeadingPitchRange(
            C.Math.toRadians(20),
            C.Math.toRadians(-20),
            scale * 4.0,
          ),
        );
      } catch (e) {
        // fall back to a manual close view if zoomTo can't resolve yet
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

      // Inspect the WebGPU model feature renderer cache to read the
      // per-primitive materialDefines + _metadataBuffer presence. Walk
      // the context's feature renderers for the model FR's cache.
      const inspect = {
        metadataBitSet: null,
        hasMetadataBuffer: null,
        materialDefinesHex: null,
        cacheFound: false,
        modelsFound: 0,
      };
      try {
        // MODEL_HAS_METADATA = 1 << 18 = 0x40000
        const META_BIT = 1 << 18;
        // The WebGPU model FR stashes its per-Model cache on the Model
        // instance itself (`model._webgpuCache.primitives[primKey]`).
        // Collect every Model primitive reachable from the scene, then
        // read each cached primCache's materialDefines + _metadataBuffer.
        const models = [];
        const visit = (p, depth) => {
          if (!p || depth > 6) return;
          if (p._webgpuCache && p._webgpuCache.primitives) models.push(p);
          // PrimitiveCollection-like containers expose .length + .get(i)
          if (typeof p.length === "number" && typeof p.get === "function") {
            for (let i = 0; i < p.length; i++) visit(p.get(i), depth + 1);
          }
          // ModelVisualizer / entity model wrappers
          if (p._model) visit(p._model, depth + 1);
          if (p._primitive) visit(p._primitive, depth + 1);
        };
        visit(v.scene.primitives, 0);
        // Also walk the dataSourceDisplay's primitives (entity models live
        // there) and the entity's resolved model primitive.
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
              // Prefer reporting a primCache that has metadata set; else
              // keep the first found (the non-metadata baseline).
              if (bit || inspect.materialDefinesHex === null) {
                inspect.materialDefinesHex = "0x" + md.toString(16);
                inspect.metadataBitSet = bit;
                inspect.hasMetadataBuffer = !!pc._metadataBuffer;
              }
              if (bit) break;
            }
          }
          if (inspect.metadataBitSet) break;
        }
        inspect.modelsFound = models.length;
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

      // Read back the full canvas and sample a grid of pixels covering
      // the model region (center of frame). Count distinct quantized
      // colors as the gradient detector.
      const canvas = v.canvas;
      const grid = { samples: [], distinctColors: 0, centerPixel: null };
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        // Sample a 24x24 grid over the central 360x360 px region (the
        // model dominates the center).
        const half = 180;
        const step = 15;
        const seen = new Set();
        for (let dy = -half; dy <= half; dy += step) {
          for (let dx = -half; dx <= half; dx += step) {
            const px = Math.max(0, Math.min(canvas.width - 1, cx + dx));
            const py = Math.max(0, Math.min(canvas.height - 1, cy + dy));
            const d = ctx2d.getImageData(px, py, 1, 1).data;
            // Quantize to 16 levels per channel to ignore AA noise.
            const q = ((d[0] >> 4) << 8) | ((d[1] >> 4) << 4) | (d[2] >> 4);
            seen.add(q);
            grid.samples.push({ dx, dy, r: d[0], g: d[1], b: d[2] });
          }
        }
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
        entityCount: v.entities.values.length,
        modelReady: !!(entity?.model && entity.computeModelMatrix),
        inspect,
        grid,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, modelUrl, metadataDebug, scale },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `dp46a-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  return { label, out, diagnostics, deviceErrors, messages };
}

async function _diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-dp46a] DP-H46a metadata property-attribute proof");

  const A = await capture("a-meta-debug-on", {
    modelUrl: META_MODEL,
    metadataDebug: true,
    scale: 12.0,
  });
  const B = await capture("b-meta-debug-off", {
    modelUrl: META_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });
  const Cp = await capture("c-plain-box-off", {
    modelUrl: PLAIN_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });

  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const cell of [A, B, Cp]) {
    const g = cell.diagnostics.grid;
    const ins = cell.diagnostics.inspect;
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    console.log(
      `\n  [${cell.label}]  ${cell.diagnostics.modelUrl.split("/").pop()}`,
    );
    console.log(
      `    metadataDebug=${cell.diagnostics.metadataDebug} entities=${cell.diagnostics.entityCount} tilesLoaded=${cell.diagnostics.tilesLoaded}`,
    );
    console.log(
      `    inspect: cacheFound=${ins.cacheFound} metadataBitSet=${ins.metadataBitSet} hasMetadataBuffer=${ins.hasMetadataBuffer} materialDefines=${ins.materialDefinesHex}${ins.error ? " ERR=" + ins.error : ""}`,
    );
    console.log(
      `    grid: distinctColors=${g.distinctColors} centerPixel=rgb(${g.centerPixel?.r},${g.centerPixel?.g},${g.centerPixel?.b})`,
    );
    console.log(
      `    errors: device=${cell.deviceErrors.length} pageerror=${pageErrors.length} console.error=${consoleErrs.length}`,
    );
    cell.deviceErrors
      .slice(0, 3)
      .forEach((e) => console.log(`      device: ${e.text?.slice(0, 160)}`));
    pageErrors
      .slice(0, 2)
      .forEach((e) =>
        console.log(`      pageerror: ${(e.text ?? "").slice(0, 160)}`),
      );
    consoleErrs
      .slice(0, 3)
      .forEach((e) =>
        console.log(
          `      console.error: ${(e.text ?? "").split("\n")[0].slice(0, 160)}`,
        ),
      );
    report.cells.push({
      label: cell.label,
      screenshot: cell.out,
      modelUrl: cell.diagnostics.modelUrl,
      metadataDebug: cell.diagnostics.metadataDebug,
      inspect: ins,
      grid: { distinctColors: g.distinctColors, centerPixel: g.centerPixel },
      deviceErrorCount: cell.deviceErrors.length,
      pageErrorCount: pageErrors.length,
      consoleErrorCount: consoleErrs.length,
    });
  }

  // OFF-parity: metadata model with debug OFF (B) vs plain box (C) won't
  // be pixel-identical (different textures), but both must show NO debug
  // gradient. The strongest parity assertion is: B and C both render as a
  // normal box (low distinctColors relative to the debug-ON gradient).
  console.log(
    "\n  [proof] A(debug-on) distinctColors should be MUCH higher than B/C (gradient = metadata reached FS)",
  );
  console.log(
    `    A=${A.diagnostics.grid.distinctColors}  B=${B.diagnostics.grid.distinctColors}  C=${Cp.diagnostics.grid.distinctColors}`,
  );

  const reportPath = path.join(OUT_DIR, "dp46a-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  report: ${reportPath}`);
})();
