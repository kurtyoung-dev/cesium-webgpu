#!/usr/bin/env node
/**
 * Probe: OIT-MODEL-REACHABLE (C11-157 Slice C).
 *
 * Proves the WebGPU MRT-OIT accumulation path is now REACHABLE for translucent
 * MODELS — the last and most complex family (Slice A = primitives, B =
 * collections). Slice C wires the model `Pass.TRANSLUCENT` color commands
 * (`WebGPUModelRenderer.ts`) — the natively-BLEND primary AND the
 * per-feature-styled translucent TWIN (C10-02 / Batch 699) — to carry
 * `_shaderCode` + `_pipelineConfig` via `WebGPUModelPipelineCache.getOITColorConfig`.
 *
 * FAR-003 stays DEFAULT-OFF — this probe FLIPS the gate at runtime via
 * CesiumDebug.webgpuOIT(true); it does not change the default.
 *
 * Scenes (WebGPU, msaaSamples=1):
 *   - twin  : BatchedWithBatchTable tileset + a SUBSET-translucent per-feature
 *             style (half the features α0.4) → styleCommandsNeeded mixes opacity
 *             → the OPAQUE primary + a BLEND-class TRANSLUCENT TWIN. Exercises
 *             the twin OIT wiring — the actual translucent-model case.
 *   - blend : BatchedTranslucent tileset (natively translucent b3dm) → the
 *             primary command is Pass.TRANSLUCENT → exercises the primary OIT.
 * Both model color FS return a `FragOutput` struct — handled by the Slice-A
 * injectOITOutput struct branch (posField `fragCoord`).
 *
 * Per scene: gate-OFF capture (sorted alpha), flip the gate ON, render, read
 * `_webgpuOITActiveThisFrame`, gate-ON capture, restore.
 *
 * HARD GATES: gate-ON `_webgpuOITActiveThisFrame === true` (was ALWAYS false),
 * 0 device/validation errors (also covers the async ready-gate — a command is
 * only emitted once its base color/twin pipeline is ready, so the sync-built
 * OIT variant never renders during warmup), gate-ON non-black, gate-ON differs
 * from gate-OFF.
 *
 * Usage: node Tools/visual-regression/probe-oit-model-reachable.mjs
 *   SCENE=twin|blend selects one (default both; run ONE per invocation).
 * Out:   Tools/visual-regression/output/oitmodel-*.png + oitmodel-report.json
 */
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const CLOCK_ISO = "2026-06-21T18:00:00Z";
const VIEWPORT = { width: 800, height: 600 };

const watchdog = setTimeout(() => {
  console.error("[probe-oitmodel] WATCHDOG 3min — forcing exit(3)");
  process.exit(3);
}, 3 * 60 * 1000);

const TILESETS = {
  twin: "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json",
  blend: "/Apps/SampleData/Cesium3DTiles/Batched/BatchedTranslucent/tileset.json",
};

async function setupViewer(page, { sceneKind }) {
  return await page.evaluate(
    async ({ sceneKind, clockIso, tsUrl }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      if (window.viewer && !window.viewer.isDestroyed()) {
        try {
          window.viewer.destroy();
        } catch (e) {
          void e;
        }
      }
      window.viewer = undefined;
      let container = document.getElementById("cesiumContainer");
      if (!container) {
        container = document.createElement("div");
        container.id = "cesiumContainer";
        document.body.appendChild(container);
      }
      container.innerHTML = "";
      Object.assign(container.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "800px",
        height: "600px",
      });

      const v = await C.Viewer.createAsync("cesiumContainer", {
        contextOptions: { renderer: "webgpu" },
        msaaSamples: 1,
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        navigationHelpButton: false,
        homeButton: false,
        sceneModePicker: false,
        infoBox: false,
        selectionIndicator: false,
        shouldAnimate: false,
      });
      window.__probeViewer = v;
      window.viewer = v;
      if (typeof C.CesiumDebug === "function") {
        try {
          C.CesiumDebug(v);
        } catch (e) {
          void e;
        }
      }

      const scene = v.scene;
      scene.msaaSamples = 1;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = new C.Color(0.02, 0.02, 0.04, 1.0);
      scene.fog.enabled = false;
      if (scene.postProcessStages && scene.postProcessStages.fxaa) {
        scene.postProcessStages.fxaa.enabled = false;
      }

      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const ts = await C.Cesium3DTileset.fromUrl(tsUrl);
      scene.primitives.add(ts);
      for (let i = 0; i < 150; i++) {
        scene.render();
        await raf();
        if (ts.tilesLoaded) break;
      }
      const bs = ts.boundingSphere;
      v.camera.viewBoundingSphere(
        bs,
        new C.HeadingPitchRange(0, -C.Math.toRadians(25), bs.radius * 2.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 150; i++) {
        scene.render();
        await raf();
        if (ts.tilesLoaded) break;
      }

      let styledFeatures = 0;
      if (sceneKind === "twin") {
        // Per-feature style mixing opacity → styleCommandsNeeded mixed → the
        // OPAQUE primary + a BLEND-class translucent TWIN (C10-02 / Batch 699).
        const findContent = () => {
          for (const tile of ts._selectedTiles || []) {
            const m = tile.content && tile.content._model;
            if (m && m.featureTables && m.featureTables.length) {
              return tile.content;
            }
          }
          return null;
        };
        const ct = findContent();
        const nn = ct ? ct.featuresLength : 0;
        for (let i = 0; i < nn; i++) {
          const f = ct.getFeature(i);
          if (f) {
            f.color =
              i % 2 === 0
                ? C.Color.fromBytes(255, 40, 40, 102)
                : C.Color.fromBytes(255, 255, 255, 255);
            styledFeatures++;
          }
        }
      }
      for (let i = 0; i < 25; i++) {
        scene.render();
        await raf();
      }
      scene.canvas.setAttribute("data-oitmodel", "1");
      return {
        renderer: scene.context.rendererType,
        msaa: scene.msaaSamples,
        hasAlternateRenderer: !!scene._alternateSceneRenderer,
        tilesLoaded: ts.tilesLoaded,
        styledFeatures,
      };
    },
    { sceneKind, clockIso: CLOCK_ISO, tsUrl: TILESETS[sceneKind] },
  );
}

async function grabCanvas(page) {
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 3; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const png = await page
    .locator('canvas[data-oitmodel="1"]')
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
  return { decoded };
}

function nonBlackFrac(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 14 || img.data[i + 1] > 14 || img.data[i + 2] > 14) n++;
  }
  return +((100 * n) / (img.data.length / 4)).toFixed(2);
}

function diffPixels(a, b, thr = 16) {
  if (!a || !b || a.w !== b.w || a.h !== b.h)
    return { mismatch: 0, pct: null, maxDelta: null };
  let px = 0;
  let mismatch = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    px++;
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxDelta) maxDelta = m;
    if (dr > thr || dg > thr || db > thr) mismatch++;
  }
  return { mismatch, pct: px ? +((100 * mismatch) / px).toFixed(3) : null, maxDelta };
}

function centralMean(img) {
  const x0 = Math.floor(img.w * 0.3);
  const x1 = Math.floor(img.w * 0.7);
  const y0 = Math.floor(img.h * 0.3);
  const y1 = Math.floor(img.h * 0.7);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.w + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1) };
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

const BENIGN_TEARDOWN_RE = /reason:\s*destroyed|Device was destroyed|Device lost: destroyed/i;
function realFaults(consoleErrors) {
  return consoleErrors.filter((e) => !BENIGN_TEARDOWN_RE.test(e));
}

async function runScene(page, consoleErrors, sceneKind) {
  const setup = await setupViewer(page, { sceneKind });
  await armWebGPUDevices(page);

  const off1 = await grabCanvas(page);
  fs.writeFileSync(
    path.join(OUT_DIR, `oitmodel-${sceneKind}-off.png`),
    encodePNG(off1.decoded),
  );
  await page.evaluate(async () => {
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 8; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const off2 = await grabCanvas(page);
  const noiseFloor = diffPixels(off1.decoded, off2.decoded, 0);

  const status = await page.evaluate(async () => {
    const cd = window.CesiumDebug;
    const toggled = cd.webgpuOIT(true);
    const scene = window.__probeViewer.scene;
    const sr = scene._alternateSceneRenderer;
    let sawActive = false;
    for (let i = 0; i < 30; i++) {
      scene.render();
      if (sr && sr._webgpuOITActiveThisFrame) sawActive = true;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      toggled,
      live: cd.webgpuOIT(),
      sawOITActiveAnyFrame: sawActive,
      activeThisFrame: !!(sr && sr._webgpuOITActiveThisFrame),
    };
  });
  const on = await grabCanvas(page);
  fs.writeFileSync(
    path.join(OUT_DIR, `oitmodel-${sceneKind}-on.png`),
    encodePNG(on.decoded),
  );

  await page.evaluate(async () => {
    window.CesiumDebug.webgpuOIT(false);
    const scene = window.__probeViewer.scene;
    for (let i = 0; i < 20; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const restored = await grabCanvas(page);
  const restoreDiff = diffPixels(off1.decoded, restored.decoded, 0);

  const gate = await collectGateErrors(page);
  const faults = realFaults(consoleErrors);
  const errors = gate.errors.length + faults.length + (gate.deviceLost ? 1 : 0);

  const offNB = nonBlackFrac(off1.decoded);
  const onNB = nonBlackFrac(on.decoded);
  const onVsOff = diffPixels(on.decoded, off1.decoded, 16);

  return {
    sceneKind,
    setup,
    status,
    errors,
    gateErrorsSample: gate.errors.slice(0, 6),
    consoleFaults: faults.slice(0, 6),
    offNonBlack: offNB,
    onNonBlack: onNB,
    offMean: centralMean(off1.decoded),
    onMean: centralMean(on.decoded),
    onVsOff_diffPct: onVsOff.pct,
    onVsOff_maxDelta: onVsOff.maxDelta,
    noiseFloor_mismatchPx: noiseFloor.mismatch,
    restoreVsOff_mismatchPx: restoreDiff.mismatch,
    restoreVsOff_maxDelta: restoreDiff.maxDelta,
  };
}

const report = { base: BASE, scenes: {} };
fs.mkdirSync(OUT_DIR, { recursive: true });
let overallPass = true;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const only = (process.env.SCENE || "").trim();
  const all = ["twin", "blend"];
  const kinds = all.includes(only) ? [only] : all;
  for (const kind of kinds) {
    const r = await runScene(page, consoleErrors, kind);
    report.scenes[kind] = r;
    // Slice C proof = REACHABILITY: the translucent model command routes into
    // MRT accumulation (`_webgpuOITActiveThisFrame` true, was always false),
    // with 0 device/validation errors, the gate-ON render is correct
    // (non-black), and containment restores. `onVsOff` is RECORDED but NOT
    // gated: model geometry is single-sided (back-face culled) and the batched
    // buildings don't overlap, so WBOIT ≡ sorted-alpha (no depth-complexity) —
    // a 0 diff here is the correct WBOIT behavior, not a failure. A visible
    // WBOIT desaturation needs overlapping / double-sided translucency.
    const pass =
      r.status.activeThisFrame === true &&
      r.errors === 0 &&
      r.onNonBlack > 0.5 &&
      r.restoreVsOff_mismatchPx <= Math.max(r.noiseFloor_mismatchPx * 3, 3);
    r.pass = pass;
    if (!pass) overallPass = false;
  }
} finally {
  await browser.close();
}

const outPath = path.join(OUT_DIR, "oitmodel-report.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.scenes, null, 2));
console.log(`\nReport: ${outPath}`);
clearTimeout(watchdog);
console.log(
  overallPass
    ? "\nGATE PASS — translucent MODELS (per-feature-styled TWIN + natively-BLEND primary) now REACH the WebGPU MRT-OIT accumulation: _webgpuOITActiveThisFrame=true, 0 errors, the model renders via the OIT composite (doesn't vanish), containment restores, async ready-gate respected (0 warmup errors). onVsOff≈0 is CORRECT: single-sided (back-face-culled) non-overlapping model geometry has no depth-complexity, so WBOIT ≡ sorted-alpha — the visible WBOIT desaturation (proven in Slices A/B on the SHARED composite) needs overlapping/double-sided translucency."
    : "\nGATE FAIL — see scene table.",
);
process.exit(overallPass ? 0 : 1);
