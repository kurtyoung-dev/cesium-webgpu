#!/usr/bin/env node
// probe-metadata-mat — NEW-MODEL-METADATA-MAT3-MAT4 proof: MAT3 (9) / MAT4
// (16) property ATTRIBUTES transport EVERY component to the WGSL shader via
// the widened four-vec4 slot-9 layout (arrayStride 64, shader locations 9-12)
// and reassemble into the full matrix in the generated initializeMetadata.
//
// Assets: Specs/Data/Models/glTF-2.0/BoxMat{3,4}PropertyAttributes — cubes
// whose per-face-constant MAT3/MAT4 FLOAT32 property attribute is authored so
// COLUMN SUMS encode a distinct per-face RGB palette (elements within a
// column split 1/2:1/3:1/6 for MAT3, 0.4:0.3:0.2:0.1 for MAT4). The SHARED
// readout function both backends compute:
//   MAT3: rgb = fract(abs(colSum0..2))
//   MAT4: rgb = fract(abs(colSum{0,1,2} + colSum3))
// Under the PRE-FIX transport (only the first 4 of 9/16 components; tail
// zero-filled) colSum1 halves and colSum2/3 vanish — every face color shifts
// far outside tolerance, so a palette match is conclusive full-transport
// proof.
//
// Readout mechanisms (cross-backend, per the B14 acceptance row):
//   - WebGL: CustomShader (GLSL, UNLIT) reading fsInput.metadata.faceMatN and
//     painting the column sums — the native WebGL metadata consumer.
//   - WebGPU: CesiumWebGPUMetadataDebug=true → the GENERATED
//     metadataDebugColor paints the identical column-sum function.
// PASS requires >=3 faces matched on EACH backend AND every face matched on
// both backends to agree within a per-channel tolerance (same camera).
//
// Scenes:
//   A. mat3-webgpu (debug paint)     C. mat4-webgpu (debug paint)
//   B. mat3-webgl  (custom shader)   D. mat4-webgl  (custom shader)
//   E. mat3-webgpu-off — debug OFF -> no palette (off-gate visual), 0 errors.
//
// WGSL structural asserts (A/C): extended 7-arg initializeMetadata signature,
// full-matrix construction referencing metadataValue2.x (MAT3 element 8) /
// metadataValue3.w (MAT4 element 15), primCache._metadataMatTransport true.
//
// 0 console / device-validation errors required on every scene.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const VIEW = { lon: -79.9959, lat: 40.4406, height: 400.0 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

const ASSETS = {
  mat3: {
    url: "/Specs/Data/Models/glTF-2.0/BoxMat3PropertyAttributes/glTF-Embedded/BoxMat3PropertyAttributes.gltf",
    propertyName: "faceMat3",
    // Column-sum palette (0-255) from make_mat_boxes.mjs.
    expected: [
      { name: "+X", rgb: [230, 77, 26] },
      { name: "-X", rgb: [26, 230, 77] },
      { name: "+Y", rgb: [51, 102, 230] },
      { name: "-Y", rgb: [230, 230, 51] },
      { name: "+Z", rgb: [230, 51, 230] },
      { name: "-Z", rgb: [51, 230, 230] },
    ],
    glsl: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  mat3 m = fsInput.metadata.faceMat3;
  float s0 = m[0][0] + m[0][1] + m[0][2];
  float s1 = m[1][0] + m[1][1] + m[1][2];
  float s2 = m[2][0] + m[2][1] + m[2][2];
  // Pre-invert the UNLIT path's czm_linearToSrgb (pow 1/2.2, LightingStageFS
  // :203) so the framebuffer bytes equal the raw column-sum paint — directly
  // comparable to WebGPU's metadataDebugColor (which writes the raw values).
  material.diffuse =
    pow(vec3(fract(abs(s0)), fract(abs(s1)), fract(abs(s2))), vec3(2.2));
  material.alpha = 1.0;
}`,
    // Element 8 (last MAT3 element) rides transport vec 2 component x.
    wgslTailRef: /metadataValue2\.x/,
  },
  mat4: {
    url: "/Specs/Data/Models/glTF-2.0/BoxMat4PropertyAttributes/glTF-Embedded/BoxMat4PropertyAttributes.gltf",
    propertyName: "faceMat4",
    expected: [
      { name: "+X", rgb: [230, 77, 64] },
      { name: "-X", rgb: [64, 230, 77] },
      { name: "+Y", rgb: [77, 102, 230] },
      { name: "-Y", rgb: [179, 179, 38] },
      { name: "+Z", rgb: [191, 38, 191] },
      { name: "-Z", rgb: [38, 191, 191] },
    ],
    glsl: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  mat4 m = fsInput.metadata.faceMat4;
  float s0 = m[0][0] + m[0][1] + m[0][2] + m[0][3];
  float s1 = m[1][0] + m[1][1] + m[1][2] + m[1][3];
  float s2 = m[2][0] + m[2][1] + m[2][2] + m[2][3];
  float s3 = m[3][0] + m[3][1] + m[3][2] + m[3][3];
  // Pre-invert czm_linearToSrgb (see MAT3 shader comment).
  material.diffuse = pow(
    vec3(fract(abs(s0 + s3)), fract(abs(s1 + s3)), fract(abs(s2 + s3))),
    vec3(2.2));
  material.alpha = 1.0;
}`,
    // Element 15 (last MAT4 element) rides transport vec 3 component w.
    wgslTailRef: /metadataValue3\.w/,
  },
};

async function capture(label, { renderer, asset, metadataDebug, customShader }) {
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

  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    { waitUntil: "networkidle" },
  );
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
    async ({ view, clockUTC, assetDef, metadataDebug, customShader, expected }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      globalThis.CesiumWebGPUMetadataDebug = metadataDebug === true;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Black background — nothing but the painted box can match the palette.
      const scene = v.scene;
      scene.globe.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;

      const center = C.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
      const model = await C.Model.fromGltfAsync({
        url: assetDef.url,
        modelMatrix,
        scale: 1.0,
      });
      if (customShader) {
        model.customShader = new C.CustomShader({
          lightingModel: C.LightingModel.UNLIT,
          fragmentShaderText: assetDef.glsl,
        });
      }
      scene.primitives.add(model);

      let ready = false;
      model.readyEvent.addEventListener(() => {
        ready = true;
      });
      for (let i = 0; i < 600; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (ready && i > 30) break;
      }

      // Deterministic framing: identical on both backends.
      v.camera.lookAt(
        center,
        new C.HeadingPitchRange(
          C.Math.toRadians(45),
          C.Math.toRadians(-35),
          3.0,
        ),
      );
      for (let i = 0; i < 120; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // WGSL / cache inspection (WebGPU only; harmless no-op on WebGL).
      const inspect = {
        cacheFound: false,
        metadataBitSet: null,
        matTransportFlag: null,
        generatedWGSL: null,
        wgslExtendedSignature: null,
        wgslTailRef: null,
      };
      try {
        const META_BIT = 1 << 18;
        const cache = model._webgpuCache;
        if (cache && cache.primitives) {
          for (const pk of Object.keys(cache.primitives)) {
            const pc = cache.primitives[pk];
            if (pc && typeof pc.materialDefines === "number") {
              inspect.cacheFound = true;
              inspect.metadataBitSet = ((pc.materialDefines >>> 0) & META_BIT) !== 0;
              inspect.matTransportFlag = pc._metadataMatTransport === true;
              if (typeof pc._metadataWGSL === "string") {
                const w = pc._metadataWGSL;
                inspect.generatedWGSL = w;
                inspect.wgslExtendedSignature =
                  /initializeMetadata\(metadataValue: vec4<f32>, metadataValue1: vec4<f32>, metadataValue2: vec4<f32>, metadataValue3: vec4<f32>,/.test(
                    w,
                  );
                inspect.wgslTailRef = new RegExp(assetDef.wgslTailRefSrc).test(
                  w,
                );
              }
              break;
            }
          }
        }
      } catch (e) {
        inspect.error = String(e?.message ?? e);
      }

      // Sample a grid over the model, classify against the palette.
      const canvas = v.canvas;
      const grid = {
        matchedFaces: {},
        faceMeans: {},
        matchedFaceCount: 0,
        totalSamples: 0,
        matchedSamples: 0,
        centerPixel: null,
      };
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const half = 240;
        const step = 6;
        const TOL = 70;
        const sums = {};
        for (let dy = -half; dy <= half; dy += step) {
          for (let dx = -half; dx <= half; dx += step) {
            const px = Math.max(0, Math.min(canvas.width - 1, cx + dx));
            const py = Math.max(0, Math.min(canvas.height - 1, cy + dy));
            const o = (py * canvas.width + px) * 4;
            const r = img[o];
            const g = img[o + 1];
            const b = img[o + 2];
            grid.totalSamples++;
            for (const face of expected) {
              if (
                Math.abs(r - face.rgb[0]) <= TOL &&
                Math.abs(g - face.rgb[1]) <= TOL &&
                Math.abs(b - face.rgb[2]) <= TOL
              ) {
                grid.matchedFaces[face.name] =
                  (grid.matchedFaces[face.name] ?? 0) + 1;
                const s = (sums[face.name] ??= { r: 0, g: 0, b: 0, n: 0 });
                s.r += r;
                s.g += g;
                s.b += b;
                s.n++;
                grid.matchedSamples++;
                break;
              }
            }
          }
        }
        for (const [name, s] of Object.entries(sums)) {
          grid.faceMeans[name] = [
            Math.round(s.r / s.n),
            Math.round(s.g / s.n),
            Math.round(s.b / s.n),
          ];
        }
        grid.matchedFaceCount = Object.values(grid.matchedFaces).filter(
          (n) => n >= 4,
        ).length;
        const co = (cy * canvas.width + cx) * 4;
        grid.centerPixel = { r: img[co], g: img[co + 1], b: img[co + 2] };
      } catch (e) {
        grid.error = String(e?.message ?? e);
      }

      return { ready, inspect, grid };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      assetDef: {
        url: asset.url,
        glsl: asset.glsl,
        wgslTailRefSrc: asset.wgslTailRef.source,
      },
      metadataDebug,
      customShader,
      expected: asset.expected,
    },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  const out = path.join(OUT_DIR, `metadata-mat-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

function errCounts(cell) {
  const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
  const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
  return { pageErrors, consoleErrs };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-metadata-mat] MAT3/MAT4 property-attribute full-component transport (WebGPU debug paint vs WebGL custom-shader readout)\n",
  );

  const cells = {};
  cells.A = await capture("a-mat3-webgpu", {
    renderer: "webgpu",
    asset: ASSETS.mat3,
    metadataDebug: true,
    customShader: false,
  });
  cells.B = await capture("b-mat3-webgl", {
    renderer: "webgl",
    asset: ASSETS.mat3,
    metadataDebug: false,
    customShader: true,
  });
  cells.C = await capture("c-mat4-webgpu", {
    renderer: "webgpu",
    asset: ASSETS.mat4,
    metadataDebug: true,
    customShader: false,
  });
  cells.D = await capture("d-mat4-webgl", {
    renderer: "webgl",
    asset: ASSETS.mat4,
    metadataDebug: false,
    customShader: true,
  });
  cells.E = await capture("e-mat3-webgpu-off", {
    renderer: "webgpu",
    asset: ASSETS.mat3,
    metadataDebug: false,
    customShader: false,
  });

  const fails = [];
  const report = { runAt: new Date().toISOString(), cells: [] };
  for (const [k, cell] of Object.entries(cells)) {
    const g = cell.diagnostics.grid;
    const ins = cell.diagnostics.inspect;
    const { pageErrors, consoleErrs } = errCounts(cell);
    console.log(`  [${k}: ${cell.label}] ready=${cell.diagnostics.ready}`);
    console.log(
      `    inspect: bit=${ins.metadataBitSet} matFlag=${ins.matTransportFlag} extSig=${ins.wgslExtendedSignature} tailRef=${ins.wgslTailRef}`,
    );
    console.log(
      `    grid: faces=${JSON.stringify(g.matchedFaces)} means=${JSON.stringify(g.faceMeans)} matched=${g.matchedSamples}/${g.totalSamples}`,
    );
    console.log(
      `    center=rgb(${g.centerPixel?.r},${g.centerPixel?.g},${g.centerPixel?.b}) errors: device=${cell.deviceErrors.length} pageerror=${pageErrors.length} console.error=${consoleErrs.length}`,
    );
    cell.deviceErrors
      .slice(0, 3)
      .forEach((e) => console.log(`      device: ${e.text?.slice(0, 200)}`));
    pageErrors
      .slice(0, 2)
      .forEach((e) => console.log(`      pageerror: ${(e.text ?? "").slice(0, 200)}`));
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
      fails.push(`${k}: errors present`);
    }
    report.cells.push({
      key: k,
      label: cell.label,
      screenshot: cell.out,
      inspect: { ...ins, generatedWGSL: undefined },
      grid: g,
      deviceErrorCount: cell.deviceErrors.length,
      pageErrorCount: pageErrors.length,
      consoleErrorCount: consoleErrs.length,
    });
  }

  // Structural asserts (WebGPU scenes).
  for (const k of ["A", "C"]) {
    const ins = cells[k].diagnostics.inspect;
    if (ins.metadataBitSet !== true)
      fails.push(`${k}: MODEL_HAS_METADATA not set`);
    if (ins.matTransportFlag !== true)
      fails.push(`${k}: primCache._metadataMatTransport not true`);
    if (ins.wgslExtendedSignature !== true)
      fails.push(`${k}: generated WGSL lacks the extended 7-arg signature`);
    if (ins.wgslTailRef !== true)
      fails.push(
        `${k}: generated WGSL does not reference the tail transport element`,
      );
  }

  // Palette-match asserts per scene + cross-backend agreement per pair.
  const pairs = [
    ["A", "B", "mat3"],
    ["C", "D", "mat4"],
  ];
  for (const [gpuKey, glKey, name] of pairs) {
    const gGpu = cells[gpuKey].diagnostics.grid;
    const gGl = cells[glKey].diagnostics.grid;
    if (gGpu.matchedFaceCount < 3)
      fails.push(
        `${gpuKey} (${name} WebGPU): only ${gGpu.matchedFaceCount} faces matched (need >=3)`,
      );
    if (gGl.matchedFaceCount < 3)
      fails.push(
        `${glKey} (${name} WebGL): only ${gGl.matchedFaceCount} faces matched (need >=3)`,
      );
    // Cross-backend: faces solidly matched on both must agree per channel.
    const XTOL = 40;
    let compared = 0;
    for (const [face, meanGpu] of Object.entries(gGpu.faceMeans)) {
      const meanGl = gGl.faceMeans[face];
      if (!meanGl) continue;
      if ((gGpu.matchedFaces[face] ?? 0) < 4 || (gGl.matchedFaces[face] ?? 0) < 4)
        continue;
      compared++;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(meanGpu[c] - meanGl[c]) > XTOL) {
          fails.push(
            `${name} face ${face}: WebGPU mean ${JSON.stringify(meanGpu)} vs WebGL ${JSON.stringify(meanGl)} differ > ${XTOL}`,
          );
          break;
        }
      }
    }
    if (compared < 3)
      fails.push(
        `${name}: only ${compared} faces comparable across backends (need >=3)`,
      );
  }

  // Off-gate visual: debug OFF paints no palette.
  const gE = cells.E.diagnostics.grid;
  if (gE.matchedFaceCount > 0)
    fails.push("E: authored palette visible with debug OFF (gate broken)");

  if (cells.A.diagnostics.inspect.generatedWGSL) {
    console.log("\n    ===== GENERATED METADATA WGSL CHUNK (scene A, MAT3) =====");
    console.log(
      cells.A.diagnostics.inspect.generatedWGSL
        .split("\n")
        .map((l) => "    | " + l)
        .join("\n"),
    );
    console.log("    =========================================================\n");
  }

  report.pass = fails.length === 0;
  report.fails = fails;
  const reportPath = path.join(OUT_DIR, "metadata-mat-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  report: ${reportPath}`);
  console.log(
    fails.length === 0
      ? "\n  RESULT: PASS"
      : `\n  RESULT: FAIL\n    - ${fails.join("\n    - ")}`,
  );
  process.exit(fails.length === 0 ? 0 : 1);
})();
