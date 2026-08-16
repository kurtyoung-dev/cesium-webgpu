#!/usr/bin/env node
// probe-dp46c-metadata — DP-H46c proof: property-TEXTURE read in the WGSL
// model fragment shader (textureSample at the interpolated texCoord), via the
// GENERATED metadata chunk (`@group(1) @binding(39..)` property-texture
// bindings + `initializeMetadata` sampling + the
// `MODEL_HAS_PROPERTY_TEXTURES` material BGL variant).
// @purpose Property-TEXTURE metadata read in the model FS via the generated chunk's bindings + textureSample and the property-textures BGL variant.
// @status ACTIVE
//
// Scenes (all WebGPU):
//   A. proptex-on   — SimplePropertyTexture with
//      globalThis.CesiumWebGPUMetadataDebug = true. The generated chunk
//      declares the property texture binding + samples it; the FS override
//      paints vec4(metadataDebugScalar, 0, 1-..., 1). PROOF = the painted
//      color VARIES across the surface (the property-texture image's
//      insideTemperature channel) → many distinct colors. The probe ALSO
//      extracts the generated WGSL and asserts it declares the
//      property-texture binding(s) + `textureSample`.
//   B. proptex-off  — same model, debug off → normal textured box.
//   C. attr-only-off— BoxTexturedWithPropertyAttributes (DP-H46a/b attribute
//      model), debug OFF. Confirms the attribute-only model is UNAFFECTED by
//      the new property-texture path (no property-texture bindings, renders
//      normally). materialDefines must NOT carry MODEL_HAS_PROPERTY_TEXTURES.
//   D. plain-box-off— plain BoxTextured (NO metadata) → neither bit set, OFF
//      parity baseline.
//
// 0 console / device-validation errors required on every scene.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 256.0 };
const PROPTEX_MODEL =
  "/Specs/Data/Models/glTF-2.0/SimplePropertyTexture/glTF/SimplePropertyTexture.gltf";
const ATTR_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTexturedWithPropertyAttributes/glTF/BoxTexturedWithPropertyAttributes.gltf";
const PLAIN_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const PROP_TEX_BIT = 1 << 19;
const META_BIT = 1 << 18;

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
    async ({
      view,
      clockUTC,
      modelUrl,
      metadataDebug,
      scale,
      propTexBit,
      metaBit,
    }) => {
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

      const inspect = {
        propTexBitSet: null,
        metaBitSet: null,
        materialDefinesHex: null,
        cacheFound: false,
        modelsFound: 0,
        generatedWGSL: null,
        classHashHex: null,
        wgslHasPropTexBinding: null,
        wgslHasTextureSample: null,
        wgslPropTexBindingNumbers: null,
        propTexEntryCount: null,
      };
      try {
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
              const ptBit = (md & propTexBit) !== 0;
              if (ptBit || inspect.materialDefinesHex === null) {
                inspect.materialDefinesHex = "0x" + md.toString(16);
                inspect.propTexBitSet = ptBit;
                inspect.metaBitSet = (md & metaBit) !== 0;
                inspect.propTexEntryCount = Array.isArray(
                  pc.propertyTextureEntries,
                )
                  ? pc.propertyTextureEntries.length
                  : null;
                if (typeof pc._metadataWGSL === "string") {
                  inspect.generatedWGSL = pc._metadataWGSL;
                  inspect.classHashHex =
                    "0x" + ((pc._metadataClassHash | 0) >>> 0).toString(16);
                  inspect.wgslHasPropTexBinding =
                    /@group\(1\)\s*@binding\(\d+\)\s*var\s+metadataPropertyTexture/.test(
                      pc._metadataWGSL,
                    );
                  inspect.wgslHasTextureSample = /textureSampleLevel\(/.test(
                    pc._metadataWGSL,
                  );
                  const bm = pc._metadataWGSL.match(
                    /@binding\((\d+)\)\s*var\s+metadataPropertyTexture/g,
                  );
                  inspect.wgslPropTexBindingNumbers = bm
                    ? bm.map((s) => s.match(/\d+/)[0])
                    : null;
                }
              }
              if (ptBit) break;
            }
          }
          if (inspect.propTexBitSet) break;
        }
        inspect.modelsFound = models.length;
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

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
        const half = 180;
        const step = 15;
        const seen = new Set();
        for (let dy = -half; dy <= half; dy += step) {
          for (let dx = -half; dx <= half; dx += step) {
            const px = Math.max(0, Math.min(canvas.width - 1, cx + dx));
            const py = Math.max(0, Math.min(canvas.height - 1, cy + dy));
            const d = ctx2d.getImageData(px, py, 1, 1).data;
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
        inspect,
        grid,
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      modelUrl,
      metadataDebug,
      scale,
      propTexBit: PROP_TEX_BIT,
      metaBit: META_BIT,
    },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(300);
  const out = path.join(OUT_DIR, `dp46c-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-dp46c] DP-H46c property-TEXTURE in-shader read proof\n");

  const A = await capture("a-proptex-on", {
    modelUrl: PROPTEX_MODEL,
    metadataDebug: true,
    scale: 12.0,
  });
  const B = await capture("b-proptex-off", {
    modelUrl: PROPTEX_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });
  const Cc = await capture("c-attr-only-off", {
    modelUrl: ATTR_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });
  const D = await capture("d-plain-box-off", {
    modelUrl: PLAIN_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });

  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const cell of [A, B, Cc, D]) {
    const g = cell.diagnostics.grid;
    const ins = cell.diagnostics.inspect;
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    console.log(
      `  [${cell.label}]  ${cell.diagnostics.modelUrl.split("/").pop()}`,
    );
    console.log(
      `    metadataDebug=${cell.diagnostics.metadataDebug} entities=${cell.diagnostics.entityCount}`,
    );
    console.log(
      `    inspect: propTexBit=${ins.propTexBitSet} metaBit=${ins.metaBitSet} md=${ins.materialDefinesHex} classHash=${ins.classHashHex} ptEntries=${ins.propTexEntryCount}`,
    );
    console.log(
      `    wgsl: hasPropTexBinding=${ins.wgslHasPropTexBinding} hasTextureSample=${ins.wgslHasTextureSample} bindings=${JSON.stringify(ins.wgslPropTexBindingNumbers)}`,
    );
    console.log(
      `    grid: distinctColors=${g.distinctColors} centerPixel=rgb(${g.centerPixel?.r},${g.centerPixel?.g},${g.centerPixel?.b})`,
    );
    console.log(
      `    errors: device=${cell.deviceErrors.length} pageerror=${pageErrors.length} console.error=${consoleErrs.length}`,
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
      .slice(0, 4)
      .forEach((e) =>
        console.log(
          `      console.error: ${(e.text ?? "").split("\n")[0].slice(0, 200)}`,
        ),
      );
    if (cell.label === "a-proptex-on" && ins.generatedWGSL) {
      console.log(
        "\n    ===== GENERATED METADATA WGSL CHUNK (property texture) =====",
      );
      console.log(
        ins.generatedWGSL
          .split("\n")
          .map((l) => "    | " + l)
          .join("\n"),
      );
      console.log(
        "    ============================================================\n",
      );
    }
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

  console.log(
    `\n  [proof] gradient: A(proptex-debug-on)=${A.diagnostics.grid.distinctColors} should be HIGH (sampled texture varies); B/C/D low.`,
  );
  console.log(
    `  [parity] C(attr-only) propTexBit=${Cc.diagnostics.inspect.propTexBitSet} (must be false); D(plain) propTexBit=${D.diagnostics.inspect.propTexBitSet} metaBit=${D.diagnostics.inspect.metaBitSet} (both must be false/null).`,
  );

  const reportPath = path.join(OUT_DIR, "dp46c-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  report: ${reportPath}`);
})();
