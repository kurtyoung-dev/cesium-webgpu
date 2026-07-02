#!/usr/bin/env node
// probe-metadata-table-texture — METADATA-TABLE-SOURCES acceptance probe.
//
// Property tables keyed by TEXTURE- and IMPLICIT-sourced feature IDs on
// WebGPU (previously only ATTRIBUTE-sourced feature IDs keyed a table).
// The generated WGSL metadata chunk now samples the model's feature-ID
// texture (group-1 binding 26 — the same resource the batch-styling path
// uploads) and unpacks the ID for the table column when the referencing
// feature-ID set is texture-sourced; implicit ranges ride the synthesized
// `featureId0` vertex slot (Batch 188).
//
// Test asset (authored for this probe):
//   Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources/glTF-Embedded/
//     FeatureIdTexturePropertyTable.gltf  — 10x10 quad (glTF XZ plane,
//       Y-up), 2x2 feature-ID texture (R = IDs 0..3, one per quadrant),
//       property table 'region.intensity' = [10.25, 20.5, 30.75, 40.0]
//     FeatureIdImplicitPropertyTable.gltf — same quad/table, implicit
//       feature IDs (ID = vertex index)
//
// Cells:
//   A. texture-debug-on (WebGPU)  — CesiumWebGPUMetadataDebug paints the
//      table value per fragment (vec4(fract(v),0,1-fract(v),1)). PROOF: the
//      4 screen quadrants show 4 DISTINCT debug colors whose red ordering
//      matches fract(intensity) = [.25,.5,.75,0]; the generated WGSL
//      contains the feature-ID texture sample + unpack + table textureLoad;
//      MODEL_HAS_PROPERTY_TABLES bit set.
//   B. feature pick parity — scene.pick at the 4 quadrant centers returns a
//      ModelFeature whose getProperty('intensity') equals the authored
//      per-region value, on BOTH backends (WebGPU resolves the feature via
//      the feature-ID TEXTURE in the pick FS — C-R9-MODEL-FEATURE-PICK).
//      ALSO asserts scene.pickMetadata returns undefined on BOTH backends —
//      upstream getMetadataProperty resolves only property TEXTURES
//      (CesiumGS/cesium#12225), so table pickMetadata is orchestration-
//      unreachable on WebGL too; parity = identical undefined.
//   C. implicit-debug-on (WebGPU) — implicit-sourced table displays
//      per-feature-varying debug colors + tableBit set + WGSL uses the
//      i32(metadataFeatureId) column path (no texture sample).
//   D. texture-debug-off (WebGPU) — normal render (white quad), no
//      metadata paint, 0 errors (opt-in gate).
//
// The globe + sky atmosphere are hidden: Cesium World Terrain sits ~300 m
// above the ellipsoid at the test location and occludes a low quad on the
// backend that loads it; the quad alone is the subject under test.
//
// 0 console/page/device-validation errors required on every cell.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const TEX_MODEL =
  "/Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources/glTF-Embedded/FeatureIdTexturePropertyTable.gltf";
const IMPL_MODEL =
  "/Specs/Data/Models/glTF-2.0/PropertyTableFeatureIdSources/glTF-Embedded/FeatureIdImplicitPropertyTable.gltf";
const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";
const AUTHORED = [10.25, 20.5, 30.75, 40.0];

const META_BIT = 1 << 18;
const PROP_TABLE_BIT = 1 << 20;

async function capture(label, { renderer, modelUrl, metadataDebug, doPick }) {
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
    async ({ view, clockUTC, modelUrl, metadataDebug, doPick, metaBit, propTableBit }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      globalThis.CesiumWebGPUMetadataDebug = metadataDebug === true;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.scene.globe.enableLighting = false;
      // Isolate the quad: terrain at the test location sits well above the
      // ellipsoid and would occlude/depth-fight a low-flying quad.
      v.scene.globe.show = false;
      if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = false;

      // Place the quad flat on the local ENU tangent plane and look straight
      // down: local +x (east) → screen right, local +y (north) → screen up,
      // so feature-ID texture row 0 (IDs 0,1) lands in the top half.
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
      // Deterministic framing: camera 22 m directly above the quad center,
      // with an EXPLICIT direction/up basis (heading at pitch -90 is gimbal-
      // ambiguous): look straight down the local up axis with screen-up =
      // local north, so quadrant NW = (west, north) = uv region (0,0).
      const east = C.Matrix4.getColumn(modelMatrix, 0, new C.Cartesian4());
      const north = C.Matrix4.getColumn(modelMatrix, 1, new C.Cartesian4());
      const up = C.Matrix4.getColumn(modelMatrix, 2, new C.Cartesian4());
      void east;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, 122),
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

      // Inspect the WebGPU primitive cache (WebGPU renderer only).
      const inspect = {
        tableBitSet: null,
        metaBitSet: null,
        materialDefinesHex: null,
        wgslSamplesFidTexture: null,
        wgslUnpacksFeatureId: null,
        wgslHasTableLoad: null,
        wgslUsesAttributeCol: null,
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
                inspect.wgslSamplesFidTexture =
                  /textureSampleLevel\(featureIdTexture,\s*featureIdSampler/.test(
                    pc._metadataWGSL,
                  );
                inspect.wgslUnpacksFeatureId = /unpackFeatureId\(/.test(
                  pc._metadataWGSL,
                );
                inspect.wgslHasTableLoad =
                  /textureLoad\(metadataPropertyTableTexture/.test(pc._metadataWGSL);
                inspect.wgslUsesAttributeCol =
                  /let metadataTableCol = i32\(metadataFeatureId\);/.test(
                    pc._metadataWGSL,
                  );
              }
            }
          }
        }
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

      // Sample the 4 screen quadrants. Camera 22 m above a 10 m quad,
      // default 60° fov → the quad spans roughly ±40% of the half-viewport;
      // sample at ~15% so the point sits near each 5 m-quadrant's center.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const off = Math.floor(Math.min(cx, cy) * 0.15);
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

      // Per-region feature pick: scene.pick → ModelFeature →
      // getProperty('intensity'). WebGPU pick readback is async — poll to
      // convergence (dp46e pattern). Also record scene.pickMetadata (expected
      // undefined on BOTH backends for table properties — upstream #12225).
      let picks = null;
      let pickMetadataValues = null;
      if (doPick) {
        picks = {};
        pickMetadataValues = {};
        for (const [k, p] of Object.entries(quadrants)) {
          // WebGPU pick readback is async AND the early reads at a new
          // position return the STALE value of the previous position's pass
          // (the same stale value repeats until the fresh readback lands, so
          // "two consecutive equal" alone is not enough). Warm up: arm the
          // pick and render a few frames DISCARDING the results, then
          // require three consecutive identical non-null reads.
          const readAt = () => {
            let picked;
            try {
              picked = v.scene.pick(new C.Cartesian2(p.x, p.y));
            } catch (e) {
              return `PICKERR:${String(e?.message ?? e)}`;
            }
            if (picked && typeof picked.getProperty === "function") {
              const raw = picked.getProperty("intensity");
              if (raw !== undefined) {
                return typeof raw === "number" ? Number(raw.toFixed(4)) : raw;
              }
            }
            return null;
          };
          for (let i = 0; i < 6; i++) {
            readAt(); // arm only — discard stale results
            await render();
            await render();
          }
          let val = null;
          let streak = 0;
          let prev = null;
          for (let i = 0; i < 40; i++) {
            const cur = readAt();
            if (typeof cur === "string" && cur.startsWith("PICKERR")) {
              val = cur;
              break;
            }
            streak = cur !== null && cur === prev ? streak + 1 : 0;
            if (cur !== null && streak >= 2) {
              val = cur;
              break;
            }
            prev = cur;
            await render();
          }
          picks[k] = val;
          let pmv = "unset";
          try {
            pmv = v.scene.pickMetadata(
              new C.Cartesian2(p.x, p.y),
              "TestSchema",
              "region",
              "intensity",
            );
          } catch (e) {
            pmv = `ERR:${String(e?.message ?? e)}`;
          }
          pickMetadataValues[k] = pmv === undefined ? null : pmv;
          await render();
        }
      }

      return {
        modelReady: !!(model && model.ready),
        modelLoadError: window.__modelLoadError ?? null,
        inspect,
        pixels,
        picks,
        pickMetadataValues,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, modelUrl, metadataDebug, doPick, metaBit: META_BIT, propTableBit: PROP_TABLE_BIT },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  const out = path.join(OUT_DIR, `metadata-table-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  const pageErrors = messages.filter((m) => m.t === "pageerror");
  const consoleErrs = messages.filter((m) => m.t === "error");
  return { label, renderer, out, diagnostics, deviceErrors, pageErrors, consoleErrs };
}

function distinctPixelCount(pixels) {
  const s = new Set(Object.values(pixels).map((p) => `${p.r >> 3},${p.g >> 3},${p.b >> 3}`));
  return s.size;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-metadata-table-texture] METADATA-TABLE-SOURCES acceptance\n");

  const cells = [];
  cells.push(
    await capture("a-texture-webgpu-debug", {
      renderer: "webgpu",
      modelUrl: TEX_MODEL,
      metadataDebug: true,
      doPick: false,
    }),
  );
  cells.push(
    await capture("b1-texture-webgpu-pick", {
      renderer: "webgpu",
      modelUrl: TEX_MODEL,
      metadataDebug: false,
      doPick: true,
    }),
  );
  cells.push(
    await capture("b2-texture-webgl-pick", {
      renderer: "webgl",
      modelUrl: TEX_MODEL,
      metadataDebug: false,
      doPick: true,
    }),
  );
  cells.push(
    await capture("c-implicit-webgpu-debug", {
      renderer: "webgpu",
      modelUrl: IMPL_MODEL,
      metadataDebug: true,
      doPick: false,
    }),
  );
  cells.push(
    await capture("d-texture-webgpu-off", {
      renderer: "webgpu",
      modelUrl: TEX_MODEL,
      metadataDebug: false,
      doPick: false,
    }),
  );

  let pass = true;
  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const c of cells) {
    const d = c.diagnostics;
    console.log(`  [${c.label}] renderer=${c.renderer}`);
    console.log(
      `    modelReady=${d.modelReady} loadErr=${d.modelLoadError ?? "none"} md=${d.inspect.materialDefinesHex} tableBit=${d.inspect.tableBitSet}`,
    );
    console.log(
      `    wgsl: fidTexSample=${d.inspect.wgslSamplesFidTexture} unpack=${d.inspect.wgslUnpacksFeatureId} tableLoad=${d.inspect.wgslHasTableLoad} attrCol=${d.inspect.wgslUsesAttributeCol}`,
    );
    console.log(
      `    pixels: ${Object.entries(d.pixels)
        .map(([k, p]) => `${k}=(${p.r},${p.g},${p.b})`)
        .join(" ")} distinct=${distinctPixelCount(d.pixels)}`,
    );
    if (d.picks) console.log(`    feature picks: ${JSON.stringify(d.picks)}`);
    if (d.pickMetadataValues)
      console.log(`    pickMetadata (expect null): ${JSON.stringify(d.pickMetadataValues)}`);
    console.log(
      `    errors: device=${c.deviceErrors.length} page=${c.pageErrors.length} console=${c.consoleErrs.length}`,
    );
    c.deviceErrors.slice(0, 3).forEach((e) => console.log(`      device: ${e.text?.slice(0, 220)}`));
    c.pageErrors.slice(0, 3).forEach((e) => console.log(`      page: ${e.text?.slice(0, 220)}`));
    c.consoleErrs.slice(0, 5).forEach((e) => console.log(`      console: ${e.text?.split("\n")[0].slice(0, 220)}`));
    if (c.deviceErrors.length || c.pageErrors.length || c.consoleErrs.length) pass = false;
    report.cells.push({ label: c.label, renderer: c.renderer, screenshot: c.out, ...d });
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  const A = cells[0].diagnostics;
  const B1 = cells[1].diagnostics;
  const B2 = cells[2].diagnostics;
  const Cc = cells[3].diagnostics;
  const D = cells[4].diagnostics;

  const check = (name, ok) => {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}`);
    if (!ok) pass = false;
  };

  console.log("");
  check("A: MODEL_HAS_PROPERTY_TABLES bit set (texture-sourced)", A.inspect.tableBitSet === true);
  check("A: generated WGSL samples featureIdTexture + unpackFeatureId", A.inspect.wgslSamplesFidTexture === true && A.inspect.wgslUnpacksFeatureId === true);
  check("A: generated WGSL loads the property table", A.inspect.wgslHasTableLoad === true);
  check("A: 4 distinct quadrant debug colors", distinctPixelCount(A.pixels) === 4);
  // Region → screen mapping: Cesium applies the glTF axis correction
  // (Y_UP_TO_Z_UP then Z_UP_TO_X_UP), so glTF +X → local north and glTF +Z →
  // local east. With the authored quad (u along glTF x, v along glTF z) that
  // puts texel (1,0)=ID1 at NW, (1,1)=ID3 at NE, (0,0)=ID0 at SW, (0,1)=ID2
  // at SE — confirmed identical by WebGL feature picks (the reference).
  // Debug paint = vec4(fract(v),0,1-fract(v),1): red ordering follows
  // fract(intensity): NE(id3, fract 0) < SW(id0,.25) < NW(id1,.5) < SE(id2,.75).
  check(
    "A: quadrant red ordering matches authored fract(intensity)",
    A.pixels.NE.r < A.pixels.SW.r && A.pixels.SW.r < A.pixels.NW.r && A.pixels.NW.r < A.pixels.SE.r,
  );

  const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.01;
  // Same axis-corrected mapping as cell A (see comment above).
  const expected = { NW: AUTHORED[1], NE: AUTHORED[3], SW: AUTHORED[0], SE: AUTHORED[2] };
  for (const k of ["NW", "NE", "SW", "SE"]) {
    check(
      `B1 WebGPU feature pick ${k}.intensity == ${expected[k]}`,
      near(B1.picks?.[k], expected[k]),
    );
    check(
      `B2 WebGL  feature pick ${k}.intensity == ${expected[k]}`,
      near(B2.picks?.[k], expected[k]),
    );
  }
  check(
    "B: pickMetadata for a TABLE property is undefined on BOTH backends (upstream #12225 parity)",
    ["NW", "NE", "SW", "SE"].every(
      (k) => B1.pickMetadataValues?.[k] === null && B2.pickMetadataValues?.[k] === null,
    ),
  );

  check("C: implicit-sourced tableBit set", Cc.inspect.tableBitSet === true);
  check("C: implicit WGSL uses attribute column (no fid-texture sample)", Cc.inspect.wgslUsesAttributeCol === true && Cc.inspect.wgslSamplesFidTexture === false);
  check("C: implicit debug paint varies (≥2 distinct colors)", distinctPixelCount(Cc.pixels) >= 2);

  // D (off-gate): debug off → no metadata paint. The debug palette always has
  // g == 0; the lit white quad has g ≈ r ≈ b, so a green channel well above 0
  // in all quadrants proves the override is off.
  check("D: debug off → normal render (no red/blue metadata paint)", Object.values(D.pixels).every((p) => p.g > 40));

  fs.writeFileSync(
    path.join(OUT_DIR, "metadata-table-texture-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`\n  overall: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
