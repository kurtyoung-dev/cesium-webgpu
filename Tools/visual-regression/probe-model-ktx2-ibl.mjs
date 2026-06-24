/**
 * NEW-MODEL-IBL-KTX2-CUBEMAP-WEBGPU (item 375) verification.
 *
 * Before this batch, authored KTX2 specular environment maps never loaded on
 * the WebGPU context: ImageBasedLighting.update() early-returns to the WebGPU
 * feature renderer before the WebGL-only createSpecularEnvironmentCubeMap()
 * runs, so `ibl._specularEnvironmentCubeMap` was never created and the model
 * IBL consumer fell back to the procedural 1x1 placeholder. Batch wires a
 * WebGPU producer (WebGPUSpecularEnvironmentCubeMap.ts) + the FR lifecycle so
 * the KTX2 base mip becomes an rgba16float source cube and generateIBLMaps
 * prefilters it on-device.
 *
 * 3-way capture of a metallic model lit ONLY by IBL (globe/sky hidden, black
 * bg, direct sun zeroed):
 *   - webgl  + KTX2  (reference)
 *   - webgpu + KTX2  (the fix)
 *   - webgpu + procedural (no env map) — the previous WebGPU behavior
 *
 * Gates:
 *   (A) LOAD PROOF — webgpu KTX2: ibl._specularEnvironmentCubeMap.ready &&
 *       (ibl._webgpuMaxMipLevel ?? 0) > 0  (the producer built the cube +
 *       generateIBLMaps ran).
 *   (B) PARITY — webgpu-KTX2 vs webgl-KTX2 model-pixel mismatch < 12%.
 *   (C) CONSUME PROOF — webgpu-KTX2 vs webgpu-procedural mismatch > 3% (the
 *       authored env map actually changes the render vs the procedural fallback).
 *   (D) no WebGPU device errors / deviceLost.
 *
 * Usage: node Tools/visual-regression/probe-model-ktx2-ibl.mjs
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
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";
const KTX2 = "/Specs/Data/EnvironmentMap/kiara_6_afternoon_2k_ibl.ktx2";
const HEADING = 0.2;
const PITCH = -0.35;

// One fresh page → one screenshot. `envUrl` null = procedural (no env map).
async function capture(renderer, envUrl) {
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
    async ({ modelUrl, envUrl, heading, pitch }) => {
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
        document.querySelectorAll(sel).forEach((e) => (e.style.display = "none"));
      }
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.light = new C.DirectionalLight({
        direction: new C.Cartesian3(0, 0, -1),
        color: C.Color.BLACK,
        intensity: 0.0,
      });

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({ url: modelUrl, modelMatrix, scale: 1.0 });
      const ibl = model.imageBasedLighting;
      ibl.imageBasedLightingFactor = new C.Cartesian2(1.0, 1.0);
      // The KTX2 path: set the authored specular env map URL.
      if (envUrl) {
        ibl.specularEnvironmentMaps = envUrl;
      }
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Let the KTX2 load + cube build + generateIBLMaps prefilter (or the
      // procedural env-manager bake) spread across frames.
      for (let i = 0; i < 320; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // LOAD PROOF for the KTX2 path: the FR built the explicit cube +
      // published a non-zero max mip level (RADIANCE_MIP_LEVELS-1).
      const specCube = ibl._specularEnvironmentCubeMap;
      const ktx2Loaded = !!(
        specCube &&
        specCube.ready &&
        (ibl._webgpuMaxMipLevel ?? 0) > 0
      );

      v.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(heading, pitch, model.boundingSphere.radius * 3.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-ibl", "1");
      return { ready: !!model.ready, ktx2Loaded };
    },
    { modelUrl: MODEL, envUrl, heading: HEADING, pitch: PITCH },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page.locator('canvas[data-ibl="1"]').screenshot({ type: "png" });
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
    ktx2Loaded: info.ktx2Loaded,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    decoded,
  };
}

function diffModelPixels(a, b) {
  let modelPx = 0,
    mismatch = 0;
  if (a.w !== b.w || a.h !== b.h) return { modelPx: 0, mismatch: 0, mismatchPct: null };
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePNG({ w, h, data }) {
  const bpr = w * 4;
  const raw = Buffer.alloc((bpr + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (bpr + 1)] = 0;
    Buffer.from(data.slice(y * bpr, (y + 1) * bpr)).copy(raw, y * (bpr + 1) + 1);
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
const wgpuKtx2 = await capture("webgpu", KTX2);
const wgpuProc = await capture("webgpu", null);
const wglKtx2 = await capture("webgl", KTX2);

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync("Tools/visual-regression/output/ktx2-ibl-webgpu.png", encodePNG(wgpuKtx2.decoded));
fs.writeFileSync("Tools/visual-regression/output/ktx2-ibl-webgpu-noenv.png", encodePNG(wgpuProc.decoded));
fs.writeFileSync("Tools/visual-regression/output/ktx2-ibl-webgl.png", encodePNG(wglKtx2.decoded));

const parity = diffModelPixels(wglKtx2.decoded, wgpuKtx2.decoded);
const consumeProof = diffModelPixels(wgpuKtx2.decoded, wgpuProc.decoded);
const gateErrors = [...wgpuKtx2.gateErrors, ...wgpuProc.gateErrors];
const deviceLost = wgpuKtx2.deviceLost || wgpuProc.deviceLost;

console.log(JSON.stringify({
  webgpuKtx2: { ready: wgpuKtx2.ready, ktx2Loaded: wgpuKtx2.ktx2Loaded, gateArmed: wgpuKtx2.gateArmed, gateErrors: gateErrors.slice(0, 4), deviceLost },
  webglKtx2: { ready: wglKtx2.ready },
  parity_webgpuKtx2_vs_webglKtx2: parity,
  consumeProof_webgpuKtx2_vs_procedural: consumeProof,
}, null, 2));

const PARITY_MAX = 12.0;
const CONSUME_MIN = 3.0;
const a = wgpuKtx2.ktx2Loaded;
const b = parity.mismatchPct !== null && parity.mismatchPct < PARITY_MAX;
const c = consumeProof.mismatchPct !== null && consumeProof.mismatchPct > CONSUME_MIN;
const d = gateErrors.length === 0 && !deviceLost;
console.log(`(A) KTX2 cube loaded on WebGPU (ready + maxMip>0): ${a ? "PASS" : "FAIL"}`);
console.log(`(B) parity webgpu-KTX2 vs webgl-KTX2 < ${PARITY_MAX}% (${parity.mismatchPct}): ${b ? "PASS" : "FAIL"}`);
console.log(`(C) consume proof webgpu-KTX2 vs procedural > ${CONSUME_MIN}% (${consumeProof.mismatchPct}): ${c ? "PASS" : "FAIL"}`);
console.log(`(D) no WebGPU device errors: ${d ? "PASS" : "FAIL"}`);
const pass = wgpuKtx2.ready && wglKtx2.ready && a && b && c && d;
console.log(pass ? "GATE PASS — authored KTX2 specular env map loads + drives WebGPU model IBL, matching WebGL" : "GATE FAIL");
process.exit(pass ? 0 : 1);
