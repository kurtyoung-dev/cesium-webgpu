/**
 * C4-MODEL-WGSL-CUSTOMSHADER-MODIFY acceptance probe (Q31 slice A).
 * @purpose MODIFY_MATERIAL ordering acceptance: WGSL customShader runs pre-lighting, so constant diffuse gets shaded and converges with WebGL.
 * @status ACTIVE
 *
 * Proves the WebGPU model customShader now runs PRE-lighting for
 * CustomShaderMode.MODIFY_MATERIAL, matching WebGL ModelFS's
 * customShaderStage → lightingStage order (B473 injected POST-lighting).
 *
 * A single CustomShader carries BOTH a GLSL `fragmentShaderText` (consumed by
 * the WebGL CustomShaderPipelineStage) and an equivalent WGSL
 * `wgslFragmentShaderText` (consumed by CustomShaderWGSLPipelineStage). Both set
 * `material.diffuse` to a CONSTANT uniform tint (position-INDEPENDENT so the
 * two backends' differing positionMC seed can't confound the comparison) and
 * leave specular/roughness untouched.
 *
 *   - PRE-lighting (correct / WebGL + fixed WebGPU): the constant diffuse is
 *     SHADED by the PBR integral → luminance varies strongly across the model
 *     (light-facing vs shadowed facets) AND the two backends CONVERGE.
 *   - POST-lighting (B473 WebGPU): the constant diffuse overwrote the already-lit
 *     color → a FLAT tint with near-zero luminance variation that DIVERGES from
 *     WebGL's shaded render.
 *
 * Gate:
 *   1. CONVERGENCE  — WebGL-vs-WebGPU model-pixel mismatch < 25% for the MODIFY
 *      customShader (post-lighting would push this far higher).
 *   2. SHADING      — WebGPU model luminance coefficient-of-variation > 0.18,
 *      i.e. the constant diffuse is genuinely lit, not a flat fill.
 *   3. CLEAN        — every capture ready, no WebGPU device errors / crashes.
 *
 * Usage: node Tools/visual-regression/probe-custom-shader-modify.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

const HEADING = 0.6;
const PITCH = -0.3;
const TINT = [0.85, 0.15, 0.15]; // red-ish constant diffuse

// Position-INDEPENDENT constant-diffuse overrides. MODIFY_MATERIAL (default):
// materialStage runs, then this modifies material.diffuse, then lighting shades.
const GLSL_FRAGMENT = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  material.diffuse = u_tint.rgb;
  material.alpha = 1.0;
}
`;
const WGSL_FRAGMENT = `
fn czm_customFragmentMain(fsInput: czm_customFragmentInput, material: ptr<function, czm_customModelMaterial>) {
  (*material).diffuse = czm_customUniforms.u_tint.rgb;
  (*material).alpha = 1.0;
}
`;

async function capture(renderer, useCustomShader) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({
      modelUrl,
      heading,
      pitch,
      useCustomShader,
      tint,
      glslFrag,
      wgslFrag,
    }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      for (const sel of [
        ".cesium-viewer-toolbar",
        ".cesium-viewer-animationContainer",
        ".cesium-viewer-timelineContainer",
        ".cesium-viewer-bottom",
        ".cesium-navigation-help",
        ".cesium-viewer-fullscreenContainer",
      ]) {
        document
          .querySelectorAll(sel)
          .forEach((e) => (e.style.display = "none"));
      }

      // Isolate the model on a black background. Keep default sun lighting so the
      // PRE-lighting diffuse actually gets shaded.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      let customShader;
      if (useCustomShader) {
        customShader = new C.CustomShader({
          mode: C.CustomShaderMode.MODIFY_MATERIAL,
          uniforms: {
            u_tint: {
              type: C.UniformType.VEC4,
              value: new C.Cartesian4(tint[0], tint[1], tint[2], 1.0),
            },
          },
          fragmentShaderText: glslFrag,
          wgslFragmentShaderText: wgslFrag,
        });
      }

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4.0,
        customShader,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(
          heading,
          pitch,
          model.boundingSphere.radius * 3.0,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");
      return { ready: !!model.ready };
    },
    {
      modelUrl: MODEL,
      heading: HEADING,
      pitch: PITCH,
      useCustomShader,
      tint: TINT,
      glslFrag: GLSL_FRAGMENT,
      wgslFrag: WGSL_FRAGMENT,
    },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page
    .locator('canvas[data-cs="1"]')
    .screenshot({ type: "png" });
  const decoded = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { w: bmp.width, h: bmp.height, data: Array.from(d) };
  }, Buffer.from(png).toString("base64"));

  await browser.close();
  return {
    ready: info.ready,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    png,
    decoded,
  };
}

// Diff two decoded images over their non-black (model) pixels.
function diffModelPixels(a, b) {
  let modelPx = 0,
    mismatch = 0;
  if (a.w !== b.w || a.h !== b.h) {
    return { modelPx: 0, mismatch: 0, mismatchPct: null };
  }
  for (let i = 0; i < a.data.length; i += 4) {
    const aLum = a.data[i] + a.data[i + 1] + a.data[i + 2];
    const bLum = b.data[i] + b.data[i + 1] + b.data[i + 2];
    if (aLum > 12 || bLum > 12) {
      modelPx++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 24 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 24 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 24
      ) {
        mismatch++;
      }
    }
  }
  return {
    modelPx,
    mismatch,
    mismatchPct: modelPx ? +((100 * mismatch) / modelPx).toFixed(2) : null,
  };
}

// Luminance mean + coefficient-of-variation over non-black model pixels. A flat
// (post-lighting) fill has CoV≈0; a shaded (pre-lighting) render has CoV≫0.
function lumStats(img) {
  const lums = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const sum = img.data[i] + img.data[i + 1] + img.data[i + 2];
    if (sum <= 12) continue;
    lums.push(
      0.2126 * img.data[i] +
        0.7152 * img.data[i + 1] +
        0.0722 * img.data[i + 2],
    );
  }
  if (lums.length === 0) return { n: 0, mean: 0, cov: 0 };
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const varr =
    lums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lums.length;
  const cov = mean > 0 ? Math.sqrt(varr) / mean : 0;
  return { n: lums.length, mean: +mean.toFixed(1), cov: +cov.toFixed(3) };
}

function meanColor(img) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] + img.data[i + 1] + img.data[i + 2] <= 12) continue;
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
    n++;
  }
  return n
    ? {
        r: +(r / n).toFixed(1),
        g: +(g / n).toFixed(1),
        b: +(b / n).toFixed(1),
        n,
      }
    : { r: 0, g: 0, b: 0, n: 0 };
}

// ── PNG encoder (zlib stored deflate) — zero external dep ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(
      raw,
      y * (bpr + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tb, body])), 0);
    return Buffer.concat([len, tb, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Captures ──
const glCustom = await capture("webgl", true);
const gpuCustom = await capture("webgpu", true);
// Also capture the no-customShader baselines to confirm cross-backend parity is
// already good WITHOUT the customShader (isolates the customShader delta).
const glBase = await capture("webgl", false);
const gpuBase = await capture("webgpu", false);

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/cs-modify-webgl.png",
  encodePNG(glCustom.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cs-modify-webgpu.png",
  encodePNG(gpuCustom.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cs-modify-webgl-base.png",
  encodePNG(glBase.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cs-modify-webgpu-base.png",
  encodePNG(gpuBase.decoded),
);

const crossCustom = diffModelPixels(glCustom.decoded, gpuCustom.decoded);
const crossBase = diffModelPixels(glBase.decoded, gpuBase.decoded);
const gpuLum = lumStats(gpuCustom.decoded);
const glLum = lumStats(glCustom.decoded);

const gateErrors = [
  ...glCustom.gateErrors,
  ...gpuCustom.gateErrors,
  ...glBase.gateErrors,
  ...gpuBase.gateErrors,
];
const deviceLost =
  glCustom.deviceLost ||
  gpuCustom.deviceLost ||
  glBase.deviceLost ||
  gpuBase.deviceLost;

const report = {
  webglCustom: {
    ready: glCustom.ready,
    mean: meanColor(glCustom.decoded),
    lum: glLum,
  },
  webgpuCustom: {
    ready: gpuCustom.ready,
    mean: meanColor(gpuCustom.decoded),
    lum: gpuLum,
  },
  crossBackend_customShader_diffPct: crossCustom.mismatchPct,
  crossBackend_baseline_diffPct: crossBase.mismatchPct,
  webgpu_shading_cov: gpuLum.cov,
  gateErrors,
  deviceLost,
  consoleFaults: [
    ...glCustom.consoleFaults,
    ...gpuCustom.consoleFaults,
    ...glBase.consoleFaults,
    ...gpuBase.consoleFaults,
  ].slice(0, 6),
};
console.log(JSON.stringify(report, null, 2));

const converged =
  crossCustom.mismatchPct !== null && crossCustom.mismatchPct < 25;
const shaded = gpuLum.cov > 0.18;
const pass =
  glCustom.ready &&
  gpuCustom.ready &&
  glBase.ready &&
  gpuBase.ready &&
  gateErrors.length === 0 &&
  !deviceLost &&
  converged &&
  shaded;

console.log(
  JSON.stringify({
    converged,
    shaded,
    crossCustom: crossCustom.mismatchPct,
    gpuCov: gpuLum.cov,
  }),
);
console.log(
  pass
    ? "GATE PASS — MODIFY customShader runs pre-lighting on WebGPU: the constant diffuse is SHADED (WebGPU CoV > 0.18) and CONVERGES with the WebGL render (< 25% cross-backend mismatch), device-error-free"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
