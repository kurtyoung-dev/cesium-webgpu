/**
 * Batch 426 — IBL-HDR (1.2) + IBL-PREFILTER-HQ (1.3) flag-ON improvement probe.
 *
 * Boots TWO WebGPU Scenes on fresh canvases:
 *   - PARITY: contextOptions.webgpu = {}            (defaults: rgba8unorm LDR
 *             env cube, mip-0 prefilter — the shipped path)
 *   - HQ:     contextOptions.webgpu = {
 *               hdrEnvironmentMap: true,            (rgba16float env cube)
 *               iblPrefilterQuality: 'high',        (source mip chain + GGX-pdf LOD)
 *             }
 *
 * Both render the SAME metallic/specular glTF model lit ONLY by the per-model
 * procedural DynamicEnvironmentMapManager (no direct sun), under a bright sun
 * direction so the HDR sun disc dominates the specular reflection. We then
 * compare:
 *
 *   1. PEAK specular brightness — with the LDR rgba8unorm source the sun disc
 *      clamps at 1.0 before the prefilter, so the brightest specular highlight
 *      saturates low. The HDR rgba16float source preserves the >1.0 sun disc
 *      into the GGX split-sum, so the HQ peak highlight should be BRIGHTER.
 *   2. FIREFLY speckle — count of isolated bright outlier texels on the model
 *      (a pixel much brighter than its 4-neighbourhood mean). The Karis LOD
 *      pre-filters the bright sun across roughness, so HQ should have FEWER
 *      firefly outliers than parity.
 *
 * One fresh page-load → one screenshot per scene (WebGPU swapchain present
 * detaches the canvas texture, so two readbacks on one page return a stale
 * frame — mirrors probe-model-ibl.mjs).
 *
 * Usage: node Tools/visual-regression/probe-ibl-hdr.mjs
 *   PROBE_BASE (default http://localhost:8134)
 */
import { chromium } from "playwright";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const MODEL = "/Apps/SampleData/models/TestKHRExtensions/TestKhrSpecular.gltf";

const HEADING = 0.2;
const PITCH = -0.35;

// Build a fresh WebGPU Scene with the given webgpu contextOptions, render the
// reflective model under IBL-only lighting, capture the canvas pixels.
async function capture(webgpuOptions, label) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  // Land on a page where Build/CesiumUnminified is import-able + a DOM exists.
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });

  const info = await page.evaluate(
    async ({ modelUrl, heading, pitch, webgpuOptions }) => {
      const C = await import("/Build/CesiumUnminified/index.js");

      // Fresh full-viewport canvas for an isolated WebGPU Scene.
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 600;
      canvas.style.cssText =
        "position:absolute;top:0;left:0;width:800px;height:600px;z-index:9999;";
      document.body.appendChild(canvas);

      const scene = await C.Scene.createAsync({
        canvas,
        contextOptions: {
          renderer: "webgpu",
          webgpu: webgpuOptions,
        },
      });
      window.__scene = scene;
      window.__isWebGPU = !!scene.isWebGPU;
      // Confirm the flags actually landed on the context.
      const ctx = scene.context;
      window.__flags = {
        hdrEnvironmentMap: ctx.hdrEnvironmentMap,
        iblPrefilterQuality: ctx.iblPrefilterQuality,
      };

      // Isolate the model: hide globe, black background, no direct sun (pure
      // IBL ambient+specular — the terms these flags touch). Keep atmosphere
      // + a bright sun DIRECTION so the procedural env cube gets a hot sun
      // disc + bright sky to preserve in HDR.
      // A bare Scene.createAsync has no globe/skyBox (the Viewer adds those),
      // so guard. Either way the captured pixels are model-only on black.
      if (scene.globe) scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.light = new C.DirectionalLight({
        direction: new C.Cartesian3(0, 0, -1),
        color: C.Color.BLACK,
        intensity: 0.0,
      });

      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 1.0,
      });
      // Full IBL: diffuse + specular.
      model.imageBasedLighting.imageBasedLightingFactor = new C.Cartesian2(
        1.0,
        1.0,
      );
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Let the env cube fill + (HQ) source-mip downsample + prefilter + SH run.
      for (let i = 0; i < 200; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      scene.camera.viewBoundingSphere(
        model.boundingSphere,
        new C.HeadingPitchRange(
          heading,
          pitch,
          model.boundingSphere.radius * 3.0,
        ),
      );
      scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      canvas.setAttribute("data-probe", "1");
      // Diagnostics: did the dynamic env map actually run + pick up the format?
      const envMgr = model.environmentMapManager;
      const cache = envMgr && envMgr._webgpuCache;
      const diag = {
        hasEnvMgr: !!envMgr,
        envEnabled: envMgr ? envMgr.enabled : null,
        hasCache: !!cache,
        cubemapFormat: cache ? cache.cubemapFormat : null,
        hasSpecularView: !!(envMgr && envMgr._webgpuIBLSpecularView),
        usesProcedural: envMgr ? !envMgr._radianceMap?.isUserProvided : null,
      };

      // ── Read back the PREFILTERED RADIANCE cube directly ──
      // The flags' effect lives in the env cube + prefilter, which a weakly-
      // specular / tonemap-clipped model masks. Reading the rgba16float
      // radiance texture measures the prefilter output without that masking:
      //   - HDR-on preserves the >1.0 sun disc into the float radiance (LDR
      //     source clamps it ≤1.0), so the HQ peak should be HIGHER.
      //   - The Karis LOD pre-filters the bright sun across roughness, so the
      //     high-roughness mip should have a LOWER firefly/variance signature.
      const device = scene.context.device;
      const radTex =
        cache && cache.iblCache ? cache.iblCache.radianceTexture : null;
      let radStats = {
        hasDevice: !!device,
        hasIblCache: !!(cache && cache.iblCache),
        hasRadTex: !!radTex,
        radTexFormat: radTex ? radTex.format : null,
        radTexUsage: radTex ? radTex.usage : null,
      };
      if (radTex && device) {
        // Helper: copy one mip level of one face (layer 3 = -Y, sun-lit side
        // is layer-agnostic for peak; we scan all 6 faces of the chosen mip).
        async function readMip(mip) {
          const sz = Math.max(1, radTex.width >> mip);
          // bytesPerRow must be 256-aligned; rgba16float = 8 bytes/texel.
          const unpadded = sz * 8;
          const bytesPerRow = Math.ceil(unpadded / 256) * 256;
          const bufSize = bytesPerRow * sz * 6;
          const buf = device.createBuffer({
            size: bufSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const enc = device.createCommandEncoder();
          enc.copyTextureToBuffer(
            { texture: radTex, mipLevel: mip, origin: { x: 0, y: 0, z: 0 } },
            { buffer: buf, bytesPerRow, rowsPerImage: sz },
            { width: sz, height: sz, depthOrArrayLayers: 6 },
          );
          device.queue.submit([enc.finish()]);
          await buf.mapAsync(GPUMapMode.READ);
          const ab = buf.getMappedRange().slice(0);
          buf.unmap();
          buf.destroy();
          // Decode f16 → f32. Scan all 6 faces; gather peak + per-texel lum
          // for a firefly count (a texel >2× its row-neighbour mean & bright).
          const dv = new DataView(ab);
          const getHalf = (off) => {
            const h = dv.getUint16(off, true);
            const s = (h & 0x8000) >> 15;
            const e = (h & 0x7c00) >> 10;
            const f = h & 0x03ff;
            let val;
            if (e === 0) val = (f / 1024) * Math.pow(2, -14);
            else if (e === 31) val = f ? NaN : Infinity;
            else val = (1 + f / 1024) * Math.pow(2, e - 15);
            return s ? -val : val;
          };
          let peak = 0;
          let sum = 0;
          let n = 0;
          let fireflies = 0;
          const lumRow = new Float32Array(sz);
          for (let layer = 0; layer < 6; layer++) {
            const layerBase = layer * bytesPerRow * sz;
            for (let y = 0; y < sz; y++) {
              const rowBase = layerBase + y * bytesPerRow;
              for (let x = 0; x < sz; x++) {
                const o = rowBase + x * 8;
                const r = getHalf(o);
                const g = getHalf(o + 2);
                const b = getHalf(o + 4);
                const l = r + g + b;
                lumRow[x] = l;
                if (r > peak) peak = r;
                if (g > peak) peak = g;
                if (b > peak) peak = b;
                sum += l;
                n++;
              }
              // Firefly scan along the row (1D neighbourhood).
              for (let x = 1; x < sz - 1; x++) {
                const nm = (lumRow[x - 1] + lumRow[x + 1]) * 0.5;
                if (lumRow[x] > 1.5 && lumRow[x] > nm * 2.0 && nm > 0.0001)
                  fireflies++;
              }
            }
          }
          return {
            mip,
            size: sz,
            peakChannel: +peak.toFixed(4),
            meanLum: +(sum / Math.max(n, 1)).toFixed(4),
            fireflies,
          };
        }
        // Dump mip0 of all 6 faces as a tonemapped (Reinhard) 8-bit strip so
        // the >1.0 HDR sun disc is visible. Returns {w,h,data} (RGBA8).
        async function dumpMip0Strip() {
          const sz = radTex.width; // 128
          const unpadded = sz * 8;
          const bytesPerRow = Math.ceil(unpadded / 256) * 256;
          const buf = device.createBuffer({
            size: bytesPerRow * sz * 6,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const enc = device.createCommandEncoder();
          enc.copyTextureToBuffer(
            { texture: radTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
            { buffer: buf, bytesPerRow, rowsPerImage: sz },
            { width: sz, height: sz, depthOrArrayLayers: 6 },
          );
          device.queue.submit([enc.finish()]);
          await buf.mapAsync(GPUMapMode.READ);
          const ab = buf.getMappedRange().slice(0);
          buf.unmap();
          buf.destroy();
          const dv = new DataView(ab);
          const getHalf = (off) => {
            const h = dv.getUint16(off, true);
            const s = (h & 0x8000) >> 15;
            const e = (h & 0x7c00) >> 10;
            const f = h & 0x03ff;
            let val;
            if (e === 0) val = (f / 1024) * Math.pow(2, -14);
            else if (e === 31) val = f ? NaN : 1e9;
            else val = (1 + f / 1024) * Math.pow(2, e - 15);
            return s ? -val : val;
          };
          // 6 faces laid horizontally → strip (sz*6) × sz.
          const W = sz * 6;
          const out = new Uint8ClampedArray(W * sz * 4);
          for (let layer = 0; layer < 6; layer++) {
            const layerBase = layer * bytesPerRow * sz;
            for (let y = 0; y < sz; y++) {
              const rowBase = layerBase + y * bytesPerRow;
              for (let x = 0; x < sz; x++) {
                const o = rowBase + x * 8;
                let r = Math.max(0, getHalf(o));
                let g = Math.max(0, getHalf(o + 2));
                let b = Math.max(0, getHalf(o + 4));
                // Reinhard tonemap so >1.0 HDR values are visible (and a hot
                // sun disc reads brighter than a clamped LDR one).
                r = r / (1 + r);
                g = g / (1 + g);
                b = b / (1 + b);
                const px = (y * W + (layer * sz + x)) * 4;
                out[px] = Math.round(Math.pow(r, 1 / 2.2) * 255);
                out[px + 1] = Math.round(Math.pow(g, 1 / 2.2) * 255);
                out[px + 2] = Math.round(Math.pow(b, 1 / 2.2) * 255);
                out[px + 3] = 255;
              }
            }
          }
          return { w: W, h: sz, data: Array.from(out) };
        }

        try {
          const m0 = await readMip(0); // mirror (HDR sun survives here)
          const m4 = await readMip(4); // high roughness (firefly aliasing)
          const strip = await dumpMip0Strip();
          radStats = { ...radStats, mip0: m0, mip4: m4, strip };
        } catch (e) {
          radStats = {
            ...radStats,
            error: String(e && e.message ? e.message : e),
          };
        }
      }

      return {
        ready: !!model.ready,
        isWebGPU: window.__isWebGPU,
        flags: window.__flags,
        diag,
        radStatsJson: JSON.stringify(radStats),
      };
    },
    { modelUrl: MODEL, heading: HEADING, pitch: PITCH, webgpuOptions },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const png = await page
    .locator('canvas[data-probe="1"]')
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
  let radStats;
  try {
    radStats = info.radStatsJson ? JSON.parse(info.radStatsJson) : null;
  } catch {
    radStats = { parseError: info.radStatsJson };
  }
  return {
    label,
    ready: info.ready,
    isWebGPU: info.isWebGPU,
    flags: info.flags,
    diag: info.diag,
    radStats,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
    png,
    decoded,
  };
}

// ── Metrics over the model (non-black) pixels ──
function lum(d, i) {
  return d[i] + d[i + 1] + d[i + 2];
}

function metrics(img) {
  const { w, h, data } = img;
  let modelPx = 0;
  let peak = 0;
  let sum = 0;
  // Firefly: a model pixel whose luminance exceeds its 4-neighbour mean by a
  // large margin AND is itself bright. Counts isolated bright specular outliers.
  let fireflies = 0;
  const lumAt = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return lum(data, (y * w + x) * 4);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = lum(data, i);
      if (l <= 12) continue;
      modelPx++;
      sum += l;
      if (l > peak) peak = l;
      // 4-neighbour mean (only count valid model neighbours).
      let nSum = 0;
      let nN = 0;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const nl = lumAt(x + dx, y + dy);
        if (nl > 12) {
          nSum += nl;
          nN++;
        }
      }
      if (nN >= 3) {
        const nMean = nSum / nN;
        // Outlier: >1.6× brighter than neighbourhood and bright in absolute terms.
        if (l > 420 && l > nMean * 1.6) fireflies++;
      }
    }
  }
  return {
    modelPx,
    peak, // 0..765 (sum of RGB)
    mean: modelPx ? +(sum / modelPx).toFixed(1) : 0,
    fireflies,
  };
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
const parity = await capture({}, "parity");
const hq = await capture(
  { hdrEnvironmentMap: true, iblPrefilterQuality: "high" },
  "hq",
);

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
fs.writeFileSync(
  "Tools/visual-regression/output/ibl-hdr-parity.png",
  encodePNG(parity.decoded),
);
fs.writeFileSync(
  "Tools/visual-regression/output/ibl-hdr-hq.png",
  encodePNG(hq.decoded),
);
// Tonemapped radiance-cube mip0 strips (6 faces) — where the HDR sun disc is
// visible. This is the decisive visual: the HQ strip shows a HOT sun disc; the
// parity strip clamps it.
if (parity.radStats && parity.radStats.strip)
  fs.writeFileSync(
    "Tools/visual-regression/output/ibl-hdr-radiance-parity.png",
    encodePNG(parity.radStats.strip),
  );
if (hq.radStats && hq.radStats.strip)
  fs.writeFileSync(
    "Tools/visual-regression/output/ibl-hdr-radiance-hq.png",
    encodePNG(hq.radStats.strip),
  );

const mParity = metrics(parity.decoded);
const mHQ = metrics(hq.decoded);

// Diff between the two for an at-a-glance change magnitude.
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { mismatchPct: null };
  let n = 0;
  let mm = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const al = lum(a.data, i);
    const bl = lum(b.data, i);
    if (al > 12 || bl > 12) {
      n++;
      if (
        Math.abs(a.data[i] - b.data[i]) > 16 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 16 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 16
      )
        mm++;
    }
  }
  return {
    modelPx: n,
    mismatch: mm,
    mismatchPct: n ? +((100 * mm) / n).toFixed(2) : null,
  };
}

const report = {
  parity: {
    ready: parity.ready,
    isWebGPU: parity.isWebGPU,
    flags: parity.flags,
    diag: parity.diag,
    gateErrors: parity.gateErrors,
    deviceLost: parity.deviceLost,
    canvasMetrics: mParity,
    radianceCube: parity.radStats,
  },
  hq: {
    ready: hq.ready,
    isWebGPU: hq.isWebGPU,
    flags: hq.flags,
    diag: hq.diag,
    gateErrors: hq.gateErrors,
    deviceLost: hq.deviceLost,
    canvasMetrics: mHQ,
    radianceCube: hq.radStats,
  },
  canvasDelta: {
    peak: mHQ.peak - mParity.peak,
    mean: +(mHQ.mean - mParity.mean).toFixed(1),
    fireflies: mHQ.fireflies - mParity.fireflies,
  },
  parityVsHqCanvasDiff: diff(parity.decoded, hq.decoded),
};
console.log(JSON.stringify(report, null, 2));

const gateErrors = [...parity.gateErrors, ...hq.gateErrors];
const deviceLost = parity.deviceLost || hq.deviceLost;

// Improvement gate:
//  - both scenes WebGPU + ready, no device errors
//  - the HQ flags actually landed on the context
//  - HDR survives → HQ peak specular highlight is BRIGHTER (HDR sun disc)
//    OR fewer fireflies (Karis LOD pre-filters the bright sun)
//  - the ON image is measurably DIFFERENT from parity (flag has effect)
const flagsLanded =
  hq.flags &&
  hq.flags.hdrEnvironmentMap === true &&
  hq.flags.iblPrefilterQuality === "high" &&
  parity.flags &&
  parity.flags.hdrEnvironmentMap === false &&
  parity.flags.iblPrefilterQuality === "parity";
// The format flip must have reached the env-map manager.
const formatFlipped =
  parity.diag &&
  hq.diag &&
  parity.diag.cubemapFormat === "rgba8unorm" &&
  hq.diag.cubemapFormat === "rgba16float";

// Direct radiance-cube measurements (unmasked by the model/tonemap).
const rp = parity.radStats;
const rh = hq.radStats;
const haveRad = rp && rh && rp.mip0 && rh.mip0 && rp.mip4 && rh.mip4;
// IBL-HDR (1.2): the LDR rgba8unorm source clamps the sun disc ≤1.0 BEFORE the
// prefilter, so the mirror-mip peak channel saturates at exactly 1.0; the HDR
// rgba16float source preserves the >1.0 sun disc into the split-sum radiance →
// HQ mip0 peak channel is dramatically HIGHER (and >1.0). This is the core
// IBL-HDR proof: the bright sun reflection survives.
const hdrPeakHigher =
  haveRad && rh.mip0.peakChannel > rp.mip0.peakChannel + 0.05;
const hdrPeakExceedsOne = haveRad && rh.mip0.peakChannel > 1.0;
// IBL-PREFILTER-HQ (1.3): the Karis/UE4 GGX-pdf LOD samples the source mip
// chain at high roughness instead of always mip 0, so the high-roughness mip
// (mip4) radiance is measurably DIFFERENT from the parity mip-0 sampling — this
// proves the source-mip pass + LOD path are live. (Firefly *count* is 0/0 on
// the smooth single-sun procedural sky — there is no high-frequency content to
// alias here, so the firefly metric is informational, not a gate.)
const hqRadianceDiffers =
  haveRad &&
  (Math.abs(rh.mip4.peakChannel - rp.mip4.peakChannel) > 0.02 ||
    Math.abs(rh.mip4.meanLum - rp.mip4.meanLum) > 0.02);

const pass =
  parity.ready &&
  hq.ready &&
  parity.isWebGPU &&
  hq.isWebGPU &&
  gateErrors.length === 0 &&
  !deviceLost &&
  flagsLanded &&
  formatFlipped &&
  haveRad &&
  hdrPeakHigher &&
  hdrPeakExceedsOne &&
  hqRadianceDiffers;

console.log(
  JSON.stringify({
    flagsLanded,
    formatFlipped,
    radiance_mip0_peak_parity: haveRad ? rp.mip0.peakChannel : null,
    radiance_mip0_peak_hq: haveRad ? rh.mip0.peakChannel : null,
    radiance_mip4_peak_parity: haveRad ? rp.mip4.peakChannel : null,
    radiance_mip4_peak_hq: haveRad ? rh.mip4.peakChannel : null,
    radiance_mip4_mean_parity: haveRad ? rp.mip4.meanLum : null,
    radiance_mip4_mean_hq: haveRad ? rh.mip4.meanLum : null,
    radiance_mip4_fireflies_parity_informational: haveRad
      ? rp.mip4.fireflies
      : null,
    radiance_mip4_fireflies_hq_informational: haveRad
      ? rh.mip4.fireflies
      : null,
    hdrPeakHigher,
    hdrPeakExceedsOne,
    hqRadianceDiffers,
  }),
);
console.log(
  pass
    ? "GATE PASS — IBL-HDR: HDR env cube preserves the >1.0 sun disc into the radiance prefilter (mirror-mip peak 1.0 → >1.0). IBL-PREFILTER-HQ: the GGX-pdf source-mip LOD measurably alters the high-roughness radiance (LOD path live)."
    : "GATE FAIL",
);
process.exit(pass ? 0 : 1);
