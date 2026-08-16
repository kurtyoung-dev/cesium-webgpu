/**
 * Q31-CUSTOMSHADER-SLICE-B-MATERIAL-FIELDS acceptance probe.
 * @purpose WGSL CustomShader exposes metalness/occlusion/normalEC and they re-drive lighting; untouched-fields shader stays identical.
 * @status ACTIVE
 *
 * Proves the WGSL CustomShader `czm_customModelMaterial` bridge now exposes the
 * extra material fields — metalness, occlusion, normalEC — and that writing them
 * from a NATIVE-WGSL customShader actually re-drives the WebGPU model lighting:
 *
 *   - metalness (MODIFY mode) re-splits diffuse/F0 from baseColor,
 *   - occlusion scales the ambient/IBL term,
 *   - normalEC re-derives the direct + IBL lighting from the perturbed normal.
 *
 * Three WebGPU captures + the OFF-gate check:
 *   1. gpuNew       — customShader that sets ALL THREE new fields (metalness 1.0,
 *                     occlusion 0.2, tilted normalEC). Must DIFFER strongly from
 *                     the no-customShader baseline (the fields take effect).
 *   2. gpuBase      — NO customShader (the pre-slice-B render).
 *   3. gpuUntouched — customShader whose body touches NONE of the new fields
 *                     (only re-asserts alpha). Must match gpuBase (OFF-gate: the
 *                     new seed/writeback is a no-op when the fields are untouched).
 *
 * Gate:
 *   1. EFFECT   — gpuNew vs gpuBase model-pixel mismatch > 10% (fields wired).
 *   2. OFFGATE  — gpuUntouched vs gpuBase model-pixel mismatch < 2% (byte-ident.
 *                 when the new fields are not written).
 *   3. CLEAN    — every capture ready, no WebGPU device errors / crashes.
 *
 * Usage: node Tools/visual-regression/probe-custom-shader-material-fields.mjs
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

// Sets ALL THREE new material fields. metalness 1.0 → fully metallic (diffuse
// collapses, F0 = baseColor); occlusion 0.2 → strong ambient darkening;
// normalEC tilted → the lit facets shift. Position-independent so the effect is
// a global, unambiguous change from the baseline render.
const WGSL_NEW_FIELDS = `
fn czm_customFragmentMain(fsInput: czm_customFragmentInput, material: ptr<function, czm_customModelMaterial>) {
  (*material).metalness = 1.0;
  (*material).occlusion = 0.2;
  (*material).normalEC = normalize((*material).normalEC + vec3<f32>(0.6, 0.0, 0.0));
}
`;

// OFF-gate: touches NONE of metalness/occlusion/normalEC. Only re-asserts alpha
// to its seed, a genuine no-op, so the render must equal the no-customShader
// baseline.
const WGSL_UNTOUCHED = `
fn czm_customFragmentMain(fsInput: czm_customFragmentInput, material: ptr<function, czm_customModelMaterial>) {
  (*material).alpha = (*material).alpha;
}
`;

async function capture(renderer, wgslFrag) {
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
    async ({ modelUrl, heading, pitch, wgslFrag }) => {
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

      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      let customShader;
      if (wgslFrag) {
        customShader = new C.CustomShader({
          mode: C.CustomShaderMode.MODIFY_MATERIAL,
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
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, wgslFrag },
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
const gpuNew = await capture("webgpu", WGSL_NEW_FIELDS);
const gpuBase = await capture("webgpu", null);
const gpuUntouched = await capture("webgpu", WGSL_UNTOUCHED);

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/cs-fields-new.png",
  encodePNG(gpuNew.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cs-fields-base.png",
  encodePNG(gpuBase.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/cs-fields-untouched.png",
  encodePNG(gpuUntouched.decoded),
);

const effect = diffModelPixels(gpuNew.decoded, gpuBase.decoded);
const offgate = diffModelPixels(gpuUntouched.decoded, gpuBase.decoded);

const gateErrors = [
  ...gpuNew.gateErrors,
  ...gpuBase.gateErrors,
  ...gpuUntouched.gateErrors,
];
const deviceLost =
  gpuNew.deviceLost || gpuBase.deviceLost || gpuUntouched.deviceLost;

const report = {
  gpuNew: { ready: gpuNew.ready, mean: meanColor(gpuNew.decoded) },
  gpuBase: { ready: gpuBase.ready, mean: meanColor(gpuBase.decoded) },
  gpuUntouched: {
    ready: gpuUntouched.ready,
    mean: meanColor(gpuUntouched.decoded),
  },
  effect_new_vs_base_diffPct: effect.mismatchPct,
  offgate_untouched_vs_base_diffPct: offgate.mismatchPct,
  gateErrors,
  deviceLost,
  consoleFaults: [
    ...gpuNew.consoleFaults,
    ...gpuBase.consoleFaults,
    ...gpuUntouched.consoleFaults,
  ].slice(0, 6),
};
console.log(JSON.stringify(report, null, 2));

const hasEffect = effect.mismatchPct !== null && effect.mismatchPct > 10;
const offGateHolds = offgate.mismatchPct !== null && offgate.mismatchPct < 2;
const pass =
  gpuNew.ready &&
  gpuBase.ready &&
  gpuUntouched.ready &&
  gateErrors.length === 0 &&
  !deviceLost &&
  hasEffect &&
  offGateHolds;

console.log(
  JSON.stringify({
    hasEffect,
    offGateHolds,
    effect: effect.mismatchPct,
    offgate: offgate.mismatchPct,
  }),
);
console.log(
  pass
    ? "GATE PASS — metalness/occlusion/normalEC drive the WebGPU model render (new-vs-base > 10%) AND an untouched customShader is a no-op (untouched-vs-base < 2%), device-error-free"
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
