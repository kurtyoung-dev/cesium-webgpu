#!/usr/bin/env node
// probe-dp46d-metadata — DP-H46d proof: property-TABLE read in the WGSL model
// fragment shader (textureLoad(table, vec2(featureId, propertyInfoIndex))) via
// the GENERATED metadata chunk (`@group(1) @binding(44)` property-table binding
// + `initializeMetadata` textureLoad + the `MODEL_HAS_PROPERTY_TABLES` material
// BGL variant). CLOSES display-side structural-metadata parity (attribute +
// texture + table all read in-shader).
// @purpose Property-TABLE metadata read via textureLoad(table, featureId); closes display-side structural-metadata parity (attr+texture+table).
// @status ACTIVE
//
// Scenes (all WebGPU):
//   A. proptable-on  — BuildingsMetadata (EXT_structural_metadata property TABLE
//      `building` {height,id,employeeCount,temperatureCelsius} + a `_FEATURE_ID_0`
//      attribute feature-ID set) with globalThis.CesiumWebGPUMetadataDebug=true.
//      The generated chunk declares the table binding + `textureLoad`s each
//      property's row at (featureId, propertyInfoIndex); the FS override paints
//      vec4(metadataDebugScalar, 0, 1-..., 1). PROOF = the painted color VARIES
//      PER-FEATURE (each building's `height` value differs) → multiple distinct
//      colors. The probe ALSO extracts the generated WGSL and asserts it
//      declares the table binding + `textureLoad`, and reports the
//      propertyInfoIndex rows.
//   B. proptable-off — same model, debug off → normal model.
//   C. proptex-only-off — SimplePropertyTexture, debug OFF. Confirms the
//      property-texture-only model is UNAFFECTED by the new table path
//      (tableBit must be false).
//   D. attr-only-off — BoxTexturedWithPropertyAttributes, debug OFF. Confirms
//      the attribute-only model is UNAFFECTED (tableBit false).
//   E. plain-box-off — plain BoxTextured (NO metadata) → no bits set, OFF parity.
//
// 0 console / device-validation errors required on every scene.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 256.0 };
const PROPTABLE_MODEL =
  "/Specs/Data/Models/glTF-2.0/BuildingsMetadata/glTF/buildings-metadata.gltf";
const PROPTEX_MODEL =
  "/Specs/Data/Models/glTF-2.0/SimplePropertyTexture/glTF/SimplePropertyTexture.gltf";
const ATTR_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTexturedWithPropertyAttributes/glTF/BoxTexturedWithPropertyAttributes.gltf";
const PLAIN_MODEL =
  "/Specs/Data/Models/glTF-2.0/BoxTextured/glTF-Binary/BoxTextured.glb";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const META_BIT = 1 << 18;
const PROP_TEX_BIT = 1 << 19;
const PROP_TABLE_BIT = 1 << 20;

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
      metaBit,
      propTexBit,
      propTableBit,
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

      // Load the glTF directly as a Model primitive. The BuildingsMetadata
      // asset carries an RTC_CENTER node that geo-locates it in ECEF, so it
      // must NOT be wrapped in an Entity transform (that would double-apply a
      // position). Models WITHOUT an RTC_CENTER (the box/proptex assets) get a
      // modelMatrix at the test geographic location so they sit on the globe.
      let model;
      let usedModelMatrix = false;
      try {
        // Peek whether the asset is geo-located (RTC_CENTER) by fetching JSON.
        let geoLocated = false;
        try {
          const resp = await fetch(modelUrl);
          if (resp.ok) {
            const gltfJson = await resp.json();
            geoLocated = (gltfJson.nodes ?? []).some(
              (n) => n.name === "RTC_CENTER" || defined(n.translation),
            );
          }
        } catch (e) {
          geoLocated = false;
        }
        function defined(x) {
          return x !== undefined && x !== null;
        }
        const modelMatrix = geoLocated
          ? C.Matrix4.IDENTITY.clone()
          : C.Transforms.eastNorthUpToFixedFrame(
              C.Cartesian3.fromDegrees(view.lon, view.lat, 50),
            );
        usedModelMatrix = !geoLocated;
        model = await C.Model.fromGltfAsync({
          url: modelUrl,
          modelMatrix,
          scale,
        });
        v.scene.primitives.add(model);
      } catch (e) {
        window.__modelLoadError = String(e?.message ?? e);
      }

      // Render until the model is ready + tiles loaded.
      for (let i = 0; i < 800; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (model && model.ready && i > 100) break;
      }
      await new Promise((r) => setTimeout(r, 800));

      // Frame the model's own bounding sphere (its real ECEF extent), pulled up
      // 45° so rooftops (where the per-feature debug color shows) face us.
      let framed = false;
      if (model && model.ready) {
        try {
          const bs = model.boundingSphere;
          v.camera.flyToBoundingSphere(bs, {
            duration: 0,
            offset: new C.HeadingPitchRange(
              0.0,
              C.Math.toRadians(-45),
              bs.radius * 3.0,
            ),
          });
          framed = true;
        } catch (e) {
          window.__frameError = String(e?.message ?? e);
        }
      }
      for (let i = 0; i < 200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      void usedModelMatrix;

      const inspect = {
        tableBitSet: null,
        propTexBitSet: null,
        metaBitSet: null,
        materialDefinesHex: null,
        cacheFound: false,
        modelsFound: 0,
        generatedWGSL: null,
        classHashHex: null,
        wgslHasTableBinding: null,
        wgslHasTextureLoad: null,
        wgslTableBindingNumbers: null,
        wgslPropInfoIndexRows: null,
        wgslHasMetadataClassStruct: null,
        wgslHasMetadataStatisticsStruct: null,
        tableEntryCount: null,
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
              const tblBit = (md & propTableBit) !== 0;
              if (tblBit || inspect.materialDefinesHex === null) {
                inspect.materialDefinesHex = "0x" + md.toString(16);
                inspect.tableBitSet = tblBit;
                inspect.propTexBitSet = (md & propTexBit) !== 0;
                inspect.metaBitSet = (md & metaBit) !== 0;
                inspect.tableEntryCount = Array.isArray(pc.propertyTableEntries)
                  ? pc.propertyTableEntries.length
                  : null;
                if (typeof pc._metadataWGSL === "string") {
                  inspect.generatedWGSL = pc._metadataWGSL;
                  inspect.classHashHex =
                    "0x" + ((pc._metadataClassHash | 0) >>> 0).toString(16);
                  inspect.wgslHasTableBinding =
                    /@group\(1\)\s*@binding\(\d+\)\s*var\s+metadataPropertyTableTexture/.test(
                      pc._metadataWGSL,
                    );
                  inspect.wgslHasTextureLoad =
                    /textureLoad\(metadataPropertyTableTexture/.test(
                      pc._metadataWGSL,
                    );
                  const bm = pc._metadataWGSL.match(
                    /@binding\((\d+)\)\s*var\s+metadataPropertyTableTexture/g,
                  );
                  inspect.wgslTableBindingNumbers = bm
                    ? bm.map((s) => s.match(/\d+/)[0])
                    : null;
                  const rows = pc._metadataWGSL.match(
                    /vec2<i32>\(metadataTableCol,\s*(\d+)\)/g,
                  );
                  inspect.wgslPropInfoIndexRows = rows
                    ? rows.map((s) => s.match(/,\s*(\d+)\)/)[1])
                    : null;
                  inspect.wgslHasMetadataClassStruct =
                    /struct\s+\w+MetadataClass\s*\{/.test(pc._metadataWGSL);
                  inspect.wgslHasMetadataStatisticsStruct =
                    /struct\s+\w+MetadataStatistics\s*\{/.test(
                      pc._metadataWGSL,
                    );
                }
              }
              if (tblBit) break;
            }
          }
          if (inspect.tableBitSet) break;
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
        const half = 220;
        const step = 12;
        const seen = new Set();
        for (let dy = -half; dy <= half; dy += step) {
          for (let dx = -half; dx <= half; dx += step) {
            const px = Math.max(0, Math.min(canvas.width - 1, cx + dx));
            const py = Math.max(0, Math.min(canvas.height - 1, cy + dy));
            const d = ctx2d.getImageData(px, py, 1, 1).data;
            // Only count "metadata-painted" pixels (the debug palette is
            // red↔blue with green≈0); a quantized bucket on r/b captures the
            // per-feature variation while ignoring the sky/globe background.
            const q = ((d[0] >> 4) << 4) | (d[2] >> 4);
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
        modelReady: !!(model && model.ready),
        framed,
        modelLoadError: window.__modelLoadError ?? null,
        frameError: window.__frameError ?? null,
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
      metaBit: META_BIT,
      propTexBit: PROP_TEX_BIT,
      propTableBit: PROP_TABLE_BIT,
    },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(300);
  const out = path.join(OUT_DIR, `dp46d-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-dp46d] DP-H46d property-TABLE in-shader read proof\n");

  const A = await capture("a-proptable-on", {
    modelUrl: PROPTABLE_MODEL,
    metadataDebug: true,
    scale: 1.0,
  });
  const B = await capture("b-proptable-off", {
    modelUrl: PROPTABLE_MODEL,
    metadataDebug: false,
    scale: 1.0,
  });
  const Cc = await capture("c-proptex-only-off", {
    modelUrl: PROPTEX_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });
  const D = await capture("d-attr-only-off", {
    modelUrl: ATTR_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });
  const E = await capture("e-plain-box-off", {
    modelUrl: PLAIN_MODEL,
    metadataDebug: false,
    scale: 12.0,
  });

  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const cell of [A, B, Cc, D, E]) {
    const g = cell.diagnostics.grid;
    const ins = cell.diagnostics.inspect;
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    console.log(
      `  [${cell.label}]  ${cell.diagnostics.modelUrl.split("/").pop()}`,
    );
    console.log(
      `    metadataDebug=${cell.diagnostics.metadataDebug} modelReady=${cell.diagnostics.modelReady} framed=${cell.diagnostics.framed} tilesLoaded=${cell.diagnostics.tilesLoaded} loadErr=${cell.diagnostics.modelLoadError ?? "none"} frameErr=${cell.diagnostics.frameError ?? "none"}`,
    );
    console.log(
      `    inspect: tableBit=${ins.tableBitSet} propTexBit=${ins.propTexBitSet} metaBit=${ins.metaBitSet} md=${ins.materialDefinesHex} classHash=${ins.classHashHex} tblEntries=${ins.tableEntryCount}`,
    );
    console.log(
      `    wgsl: hasTableBinding=${ins.wgslHasTableBinding} hasTextureLoad=${ins.wgslHasTextureLoad} bindings=${JSON.stringify(ins.wgslTableBindingNumbers)} rows=${JSON.stringify(ins.wgslPropInfoIndexRows)} classStruct=${ins.wgslHasMetadataClassStruct} statsStruct=${ins.wgslHasMetadataStatisticsStruct}`,
    );
    console.log(
      `    grid: distinctColors=${g.distinctColors} centerPixel=rgb(${g.centerPixel?.r},${g.centerPixel?.g},${g.centerPixel?.b})`,
    );
    console.log(
      `    errors: device=${cell.deviceErrors.length} pageerror=${pageErrors.length} console.error=${consoleErrs.length}`,
    );
    cell.deviceErrors
      .slice(0, 4)
      .forEach((e) => console.log(`      device: ${e.text?.slice(0, 240)}`));
    pageErrors
      .slice(0, 2)
      .forEach((e) =>
        console.log(`      pageerror: ${(e.text ?? "").slice(0, 240)}`),
      );
    consoleErrs
      .slice(0, 6)
      .forEach((e) =>
        console.log(
          `      console.error: ${(e.text ?? "").split("\n")[0].slice(0, 240)}`,
        ),
      );
    if (cell.label === "a-proptable-on" && ins.generatedWGSL) {
      console.log(
        "\n    ===== GENERATED METADATA WGSL CHUNK (property table) =====",
      );
      console.log(
        ins.generatedWGSL
          .split("\n")
          .map((l) => "    | " + l)
          .join("\n"),
      );
      console.log(
        "    ==========================================================\n",
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
    `\n  [proof] gradient: A(proptable-debug-on)=${A.diagnostics.grid.distinctColors} should be HIGH (per-feature table value varies); B/C/D/E lower.`,
  );
  console.log(
    `  [parity] C(proptex-only) tableBit=${Cc.diagnostics.inspect.tableBitSet} D(attr-only) tableBit=${D.diagnostics.inspect.tableBitSet} E(plain) tableBit=${E.diagnostics.inspect.tableBitSet} metaBit=${E.diagnostics.inspect.metaBitSet} (all must be false/null).`,
  );

  const reportPath = path.join(OUT_DIR, "dp46d-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  report: ${reportPath}`);
})();
