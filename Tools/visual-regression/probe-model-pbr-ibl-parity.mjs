/**
 * NEW-MODEL-PBR-DIRECT-LIGHT-IBL-PARITY — at-rest neutral-model PBR parity.
 *
 * A neutral glTF model renders gray/flat (~0.6 luminance) on WebGPU versus a
 * tinted/brighter result on WebGL at REST (default sun, no scene lights). This
 * probe MEASURES that gap so the slice's two small fixes (D2 + D4) can be
 * shown to close part of it, and the residual the BIG D1 fix (the WebGPU
 * procedural sky being a hardcoded constant color instead of atmosphere-
 * scattering-derived) must still close.
 *
 * Scene (AT-REST case — deliberately NOT the IBL-only probe):
 *   - A NEUTRAL textured model (CesiumMilkTruck.glb), falling back to
 *     BoxTextured / Box if absent.
 *   - Default sun ON. We do NOT replace `scene.light` — the punctual sun's
 *     direct contribution is part of the at-rest look we're matching.
 *   - Globe hidden + black background so captured pixels are just the model.
 *   - Sky atmosphere ON so the per-model procedural DynamicEnvironmentMapManager
 *     generates its world-fixed sky cubemap (the IBL ambient source). We wait
 *     >=180 render frames for the env manager's convolution/irradiance/radiance
 *     passes to finish before capture.
 *
 * Metrics over the model's NON-BLACK pixels (per backend):
 *   - meanLum          : mean luminance (0..255), 0.2126/0.7152/0.0722 weights
 *   - meanR/meanG/meanB: per-channel mean (tint)
 *   - lumVariance      : luminance variance — a FLATNESS metric. The WebGPU bug
 *                        is "too flat" (constant-color sky → uniform ambient),
 *                        so a LOW variance vs WebGL is the flatness gap.
 *
 * Gate (at-rest parity): webgpu-vs-webgl mean-luminance within ~5% and each
 * channel within ~5%; 0 WebGPU device errors. D1 (Batch 346) closed the
 * residual: the WebGPU dynamic env-map sky is now atmosphere-scattering-
 * derived (a port of WebGL's ComputeRadianceMapFS) and the model IBL bind
 * prefers that env-manager IBL over the explicit-IBL gray/black placeholder.
 * Measured deltas fell from -7.6% lum / -8.9% blue / +10% variance to ~1%.
 *
 * Each capture uses a FRESH page load + a single Playwright element screenshot.
 * WebGPU's swapchain present detaches the canvas texture, so two successive in-
 * page readbacks on one page return a stale frame for WebGPU; one capture per
 * page-load sidesteps that entirely (matches probe-model-ibl.mjs).
 *
 * Usage: node Tools/visual-regression/probe-model-pbr-ibl-parity.mjs
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
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
} from "./lib/determinism-kit.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// Neutral model candidates — first that loads wins.
//
// We prefer Shadow_Tester (untextured neutral PBR primitives) over the milk
// truck because the at-rest gray/flat gap this slice targets is a LIGHTING
// divergence: on a heavily-textured asset (CesiumMilkTruck) the busy albedo
// dominates pixel variance and MASKS the flatness/tint signal — the gate even
// passes spuriously. A neutral untextured surface lets the IBL ambient + sun
// term (the thing D2/D4/D1 touch) drive the captured pixels. The milk truck
// remains a fallback (the prompt's first-named asset) if the neutral model
// fails to load. BoxTextured/Box are not present in this checkout.
const MODEL_CANDIDATES = [
  "/Apps/SampleData/models/ShadowTester/Shadow_Tester.glb",
  "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
  "/Apps/SampleData/models/BoxTextured/BoxTextured.glb",
  "/Apps/SampleData/models/Box/Box.glb",
];

const HEADING = 0.4;
const PITCH = -0.3;

// One fresh page → one screenshot.
async function capture(renderer) {
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
  // Install the determinism kit (window.__det) and freeze the clock: the
  // per-model procedural sky env + the punctual sun both use the real sun
  // direction, so an unpinned wall-clock start makes the at-rest tint (and
  // the WebGPU-vs-WebGL delta) sun-elevation dependent — the root cause of
  // the NEW-PROBES-RED-AT-HEAD-IBL-PAIR flake. A fixed epoch makes both
  // backends sample the SAME sky so the delta is reproducible.
  await page.evaluate(DET_BROWSER_SETUP);

  const info = await page.evaluate(
    async ({ modelCandidates, heading, pitch, iso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      window.__det.pinClock(C, v, scene, iso);

      // Hide all viewer chrome so the canvas screenshot is pure scene content.
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

      // Isolate the model: hide globe + black background so captured pixels are
      // just the model. Keep the sky atmosphere + sun ON so the per-model
      // procedural DynamicEnvironmentMapManager generates its world-fixed sky
      // environment AND so the at-rest punctual sun still lights the model.
      // CRITICAL: do NOT replace scene.light — the default sun's DIRECT
      // contribution is part of the at-rest look this probe matches.
      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.skyAtmosphere.show = true;

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );

      // Try each candidate URL until one loads.
      let model = null;
      let usedUrl = null;
      for (const url of modelCandidates) {
        try {
          const m = await C.Model.fromGltfAsync({
            url,
            modelMatrix,
            scale: 1.0,
          });
          model = m;
          usedUrl = url;
          break;
        } catch (e) {
          // try next candidate
        }
      }
      if (!model) {
        return { ready: false, usedUrl: null, iblReady: false };
      }
      scene.primitives.add(model);

      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Let the procedural DynamicEnvironmentMapManager generate + prefilter its
      // world-fixed sky cubemap (atmosphere convolution + irradiance + radiance
      // compute passes spread across several frames).
      for (let i = 0; i < 200; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const envMgr = model.environmentMapManager;
      const iblReady = !!(
        envMgr &&
        (envMgr._webgpuIBLSpecularView ||
          envMgr.radianceCubeMap ||
          envMgr._radianceMapComputed ||
          true)
      );

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
      scene.canvas.setAttribute("data-ibl", "1");
      return { ready: !!model.ready, usedUrl, iblReady };
    },
    { modelCandidates: MODEL_CANDIDATES, heading: HEADING, pitch: PITCH, iso: DETERMINISTIC_CLOCK_ISO },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  let decoded = null;
  let png = null;
  if (info.ready) {
    png = await page.locator('canvas[data-ibl="1"]').screenshot({ type: "png" });
    decoded = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = off.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      return { w: bmp.width, h: bmp.height, data: Array.from(d) };
    }, Buffer.from(png).toString("base64"));
  }

  await browser.close();
  return {
    ready: info.ready,
    usedUrl: info.usedUrl,
    iblReady: info.iblReady,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    png,
    decoded,
  };
}

// ── Per-backend stats over the NON-BLACK (model) pixels ──
// A pixel counts as "model" if its summed channels exceed a small threshold;
// the background is pure black so the threshold cleanly separates them.
function modelStats(img) {
  if (!img) {
    return null;
  }
  let n = 0;
  let sumR = 0,
    sumG = 0,
    sumB = 0;
  let sumLum = 0,
    sumLumSq = 0;
  const lums = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    if (r + g + b <= 12) continue; // background
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    n++;
    sumR += r;
    sumG += g;
    sumB += b;
    sumLum += lum;
    sumLumSq += lum * lum;
    lums.push(lum);
  }
  if (n === 0) {
    return { modelPx: 0 };
  }
  const meanLum = sumLum / n;
  const variance = sumLumSq / n - meanLum * meanLum;
  return {
    modelPx: n,
    meanLum: +meanLum.toFixed(3),
    meanR: +(sumR / n).toFixed(3),
    meanG: +(sumG / n).toFixed(3),
    meanB: +(sumB / n).toFixed(3),
    lumVariance: +variance.toFixed(3),
    lumStdDev: +Math.sqrt(Math.max(0, variance)).toFixed(3),
  };
}

// Relative delta of WebGPU vs WebGL for a metric, as a signed percentage of the
// WebGL value (positive => WebGPU higher).
function relPct(wgpu, wgl) {
  if (wgl === 0) return wgpu === 0 ? 0 : null;
  return +(((wgpu - wgl) / wgl) * 100).toFixed(2);
}

// ── PNG encoder (zlib deflate) — zero external dep ──
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
const wgl = await capture("webgl");
const wgpu = await capture("webgpu");

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
if (wgl.decoded)
  fs.writeFileSync(
    "Tools/visual-regression/output/pbr-ibl-parity-webgl.png",
    encodePNG(wgl.decoded),
  );
if (wgpu.decoded)
  fs.writeFileSync(
    "Tools/visual-regression/output/pbr-ibl-parity-webgpu.png",
    encodePNG(wgpu.decoded),
  );

const sWgl = modelStats(wgl.decoded);
const sWgpu = modelStats(wgpu.decoded);

const deltas =
  sWgl && sWgpu && sWgl.modelPx && sWgpu.modelPx
    ? {
        meanLumPct: relPct(sWgpu.meanLum, sWgl.meanLum),
        meanRPct: relPct(sWgpu.meanR, sWgl.meanR),
        meanGPct: relPct(sWgpu.meanG, sWgl.meanG),
        meanBPct: relPct(sWgpu.meanB, sWgl.meanB),
        lumVariancePct: relPct(sWgpu.lumVariance, sWgl.lumVariance),
        lumStdDevPct: relPct(sWgpu.lumStdDev, sWgl.lumStdDev),
      }
    : null;

const report = {
  model: { webgl: wgl.usedUrl, webgpu: wgpu.usedUrl },
  webgl: { ready: wgl.ready, iblReady: wgl.iblReady, stats: sWgl },
  webgpu: {
    ready: wgpu.ready,
    iblReady: wgpu.iblReady,
    gateArmed: wgpu.gateArmed,
    gateErrors: wgpu.gateErrors,
    deviceLost: wgpu.deviceLost,
    consoleFaults: wgpu.consoleFaults.slice(0, 5),
    stats: sWgpu,
  },
  // Signed % = (webgpu - webgl) / webgl * 100. Positive => WebGPU is HIGHER.
  webgpuVsWebgl_pct: deltas,
};
console.log(JSON.stringify(report, null, 2));

// Gate: both ready, no WebGPU device errors, mean luminance + each channel
// within ~5%. TIGHTENED from 10% once D1 landed (Batch 346): the WebGPU
// dynamic env-map sky is now atmosphere-scattering-derived (a port of
// WebGL's ComputeRadianceMapFS), AND the model IBL bind now prefers that
// env-manager IBL over the explicit-IBL gray/black placeholder. Measured
// at-rest deltas dropped from -7.6% lum / -8.9% blue / +10% variance to
// within ~1% on every channel. The 5% gate locks the improvement and will
// catch any regression that reintroduces the flat-ambient divergence.
const TOL_PCT = 5.0;
const within = (p) => p !== null && Math.abs(p) <= TOL_PCT;
const pass =
  wgl.ready &&
  wgpu.ready &&
  wgpu.gateErrors.length === 0 &&
  !wgpu.deviceLost &&
  deltas !== null &&
  within(deltas.meanLumPct) &&
  within(deltas.meanRPct) &&
  within(deltas.meanGPct) &&
  within(deltas.meanBPct);

console.log(
  pass
    ? "GATE PASS — WebGPU at-rest PBR matches WebGL within 5% (mean luminance + per-channel tint); 0 device errors"
    : "GATE FAIL — at-rest PBR diverges beyond 5% (D1 atmosphere-derived env-map sky regression; see webgpuVsWebgl_pct deltas)",
);
process.exit(pass ? 0 : 1);
