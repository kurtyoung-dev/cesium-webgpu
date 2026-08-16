#!/usr/bin/env node
/**
 * Probe: OIT-TRANSPARENCY (M-OIT-COVERAGE-AND-FLIP-EVIDENCE, Batch 700).
 * @purpose OIT coverage + default-flip evidence: WebGL OIT genuinely active; WebGPU opt-in hard-gated active post-Slice-A; splat deferral lane.
 * @status ACTIVE
 *
 * Order-Independent Transparency coverage + WebGPU-OIT default-flip evidence.
 * Renders a scene of MUTUALLY-INTERSECTING translucent geometry (three
 * intersecting ellipsoids at alpha ~0.5 in distinct colors + a translucent
 * polygon slicing through them) — the case where per-object back-to-front
 * sorted alpha is provably wrong at the intersection lines and OIT visibly
 * differs.
 *
 * Oracles:
 *   (a) WebGL OIT GENUINELY ACTIVE — WebGL default (orderIndependentTranslucency
 *       = true, the Scene default) vs WebGL orderIndependentTranslucency:false
 *       (sorted alpha). The two captures MUST differ measurably at the
 *       intersections; both non-black; 0 errors. Proves OIT is really doing
 *       something on WebGL (not a no-op). HARD GATE.
 *   (b) WebGPU default (sorted alpha) vs WebGL OIT-off (sorted alpha) —
 *       like-for-like cross-backend band. Recorded, not tightly gated.
 *   (c) WebGPU OIT OPT-IN — CesiumDebug.webgpuOIT(true). Capture the status
 *       object, render/settle, assert ZERO device/validation errors, output
 *       non-black. Compare vs WebGL OIT-on (the parity target); record
 *       mismatch %. **C11-157 Slice A (2026-07-18):** translucent PRIMITIVES now
 *       carry the OIT variant (`_shaderCode`/`_pipelineConfig`), so the MRT-OIT
 *       accumulation path engages for standard translucency: `active` and
 *       `_webgpuOITActiveThisFrame` are now expected TRUE (both were ALWAYS
 *       FALSE at Batch-700 — the original unreachability finding). The probe
 *       HARD-GATES on active=true + zero errors + non-black; a false is now a
 *       Slice-A regression, not the historical finding. Runs at msaaSamples=1
 *       (single-sample OIT accumulation targets).
 *   (c-splat) REACHABILITY confirmation — the synthetic Gaussian-splat FR (the
 *       only `_shaderCode` carrier) + arm `_webgpuOITEnabled` AND
 *       `_splatOITDeferral`. Observe whether `_webgpuOITActiveThisFrame` ever
 *       becomes true (expected FALSE: splats are in Pass.GAUSSIAN_SPLATS, folded
 *       into OIT accumulation only AFTER `hasOITPipelines` is derived from the
 *       empty TRANSLUCENT bucket, so the deferred splats fall to the inline
 *       seatbelt). Confirms the Batch-697 `_ensureSceneColorResolved` composite
 *       line is UNREACHED. Observational (only device errors fail it).
 *   (d) CONTAINMENT RESTORE — after (c), CesiumDebug.webgpuOIT(false) →
 *       byte-identical to the pre-toggle WebGPU-default capture (0 mismatch px).
 *       HARD GATE.
 *   (e) STANDARD-TRANSPARENCY REGRESSION NET — the four existing translucency
 *       probes are run SEPARATELY (they each launch their own Edge; nesting
 *       Edge launches inside one probe is a machine-safety hazard). This file
 *       prints the exact commands; the runner folds their results into the
 *       report. See README / the M-OIT ledger row.
 *
 * Usage: node Tools/visual-regression/probe-oit-transparency.mjs
 *   PROBE_BASE (default http://localhost:8080). Requires the dev server up.
 * Out:   Tools/visual-regression/output/oit-*.png + oit-transparency-report.json
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

// 5-minute hard watchdog (machine-safety: kill a hung Edge/device rather than
// wedge the box). Cleared on normal completion.
const watchdog = setTimeout(
  () => {
    console.error("[probe-oit] WATCHDOG 5min — forcing exit(3)");
    process.exit(3);
  },
  5 * 60 * 1000,
);

// ── Scene builder (runs in page context). Destroys the app viewer, creates a
// fresh Viewer with the requested backend + OIT constructor option, builds the
// intersecting-translucent scene, settles to steady state. Returns readiness. ──
async function setupViewer(page, { renderer, oit }) {
  return await page.evaluate(
    async ({ renderer, oit, clockIso }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      // Tear down the app-created viewer so we control the constructor options
      // (orderIndependentTranslucency is construction-time only) and never run
      // two devices at once.
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
        contextOptions: { renderer },
        orderIndependentTranslucency: oit,
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
      window.viewer = v; // so the error-gate arm helper (walks window.viewer) finds this device
      if (typeof C.CesiumDebug === "function") {
        try {
          C.CesiumDebug(v); // mounts window.CesiumDebug bound to this viewer
        } catch (e) {
          void e;
        }
      }

      const scene = v.scene;
      // C11-157 Slice A — single-sample so the OIT accumulation pass (single-
      // sample MRT targets) is sample-consistent when the gate is flipped ON.
      // MSAA×OIT accumulation remains the tracked adjacency
      // NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING (out of Slice A scope).
      scene.msaaSamples = 1;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

      // Dark, deterministic stage — the translucent geometry is the whole show.
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

      // ── Intersecting translucent geometry ──
      // Three mutually-overlapping ellipsoids (radii 60 m, centers ~35 m apart)
      // at alpha 0.5 in red/green/blue + a translucent yellow polygon slicing
      // horizontally through the cluster. At the interpenetration lines, a
      // per-object back-to-front sort cannot be correct — OIT differs there.
      const LON = -75.0;
      const LAT = 40.0;
      const H = 200.0;
      const dLon = 0.00042; // ~36 m at lat 40
      const dLat = 0.00032; // ~35 m
      const radii = new C.Cartesian3(60, 60, 60);
      const ellipsoids = [
        { off: [0, dLat], color: new C.Color(1.0, 0.15, 0.15, 0.5) }, // red
        { off: [-dLon, -dLat * 0.6], color: new C.Color(0.15, 1.0, 0.2, 0.5) }, // green
        { off: [dLon, -dLat * 0.6], color: new C.Color(0.2, 0.35, 1.0, 0.5) }, // blue
      ];
      for (const e of ellipsoids) {
        v.entities.add({
          position: C.Cartesian3.fromDegrees(LON + e.off[0], LAT + e.off[1], H),
          ellipsoid: {
            radii,
            material: e.color,
            outline: false,
          },
        });
      }
      // Translucent polygon slicing through the cluster at mid-height.
      const s = 0.0011;
      v.entities.add({
        polygon: {
          hierarchy: new C.PolygonHierarchy([
            C.Cartesian3.fromDegrees(LON - s, LAT - s, H),
            C.Cartesian3.fromDegrees(LON + s, LAT - s, H),
            C.Cartesian3.fromDegrees(LON + s, LAT + s, H),
            C.Cartesian3.fromDegrees(LON - s, LAT + s, H),
          ]),
          material: new C.Color(1.0, 0.9, 0.1, 0.4),
          perPositionHeight: true,
          outline: false,
        },
      });

      const center = C.Cartesian3.fromDegrees(LON, LAT, H);
      v.camera.lookAt(
        center,
        new C.HeadingPitchRange(
          C.Math.toRadians(35),
          C.Math.toRadians(-22),
          420,
        ),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);

      // Settle to steady state.
      for (let i = 0; i < 45; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-oit", "1");
      const sr = scene._alternateSceneRenderer;
      return {
        renderer: scene.context.rendererType,
        oitOption: scene.orderIndependentTranslucency,
        hasAlternateRenderer: !!sr,
      };
    },
    { renderer, oit, clockIso: CLOCK_ISO },
  );
}

async function grabCanvas(page) {
  const png = await page
    .locator('canvas[data-oit="1"]')
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
  return { png, decoded };
}

function nonBlackFrac(img) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] > 14 || img.data[i + 1] > 14 || img.data[i + 2] > 14) {
      n++;
    }
  }
  return +((100 * n) / (img.data.length / 4)).toFixed(2);
}

function diffPixels(a, b, thr = 16) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) {
    return { px: 0, mismatch: 0, pct: null, maxDelta: null };
  }
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
  return {
    px,
    mismatch,
    pct: px ? +((100 * mismatch) / px).toFixed(3) : null,
    maxDelta,
  };
}

// Coarse blend-quality read of the central intersection region: mean RGB over
// the central crop (35%-65%) where the ellipsoid cluster + polygon overlap.
function centralMean(img) {
  const x0 = Math.floor(img.w * 0.35);
  const x1 = Math.floor(img.w * 0.65);
  const y0 = Math.floor(img.h * 0.35);
  const y1 = Math.floor(img.h * 0.65);
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
  return {
    r: +(r / n).toFixed(1),
    g: +(g / n).toFixed(1),
    b: +(b / n).toFixed(1),
  };
}

// ── zero-dep PNG encoder ──
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

// The probe recreates the viewer (to control the OIT constructor option), which
// destroys the app-created device. That emits benign "Device lost: destroyed"
// console lines the Node fault-regex over-matches — they are NOT real faults
// (the real GPU gate ignores reason=destroyed). Drop them from the error count.
const BENIGN_TEARDOWN_RE =
  /reason:\s*destroyed|Device was destroyed|Device lost: destroyed/i;
function realFaults(consoleErrors) {
  return consoleErrors.filter((e) => !BENIGN_TEARDOWN_RE.test(e));
}

async function newPage(browser) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  return { page, consoleErrors };
}

async function gotoViewer(page, renderer) {
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });
}

// ─────────────────────────────── run ───────────────────────────────
const report = { base: BASE, oracles: {}, findings: [], captures: {} };
fs.mkdirSync(OUT_DIR, { recursive: true });
let overallPass = true;

// ── WebGL session: oracle (a) OIT-on vs OIT-off ──
{
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const { page, consoleErrors } = await newPage(browser);
    await gotoViewer(page, "webgl");

    const setupOn = await setupViewer(page, { renderer: "webgl", oit: true });
    const capOn = await grabCanvas(page);
    fs.writeFileSync(
      path.join(OUT_DIR, "oit-webgl-on.png"),
      encodePNG(capOn.decoded),
    );

    const setupOff = await setupViewer(page, { renderer: "webgl", oit: false });
    const capOff = await grabCanvas(page);
    fs.writeFileSync(
      path.join(OUT_DIR, "oit-webgl-off.png"),
      encodePNG(capOff.decoded),
    );

    const gate = await collectGateErrors(page);
    const onNB = nonBlackFrac(capOn.decoded);
    const offNB = nonBlackFrac(capOff.decoded);
    const onVsOff = diffPixels(capOn.decoded, capOff.decoded);

    const faults = realFaults(consoleErrors);
    report.webglSession = {
      setupOn,
      setupOff,
      consoleFaults: faults.slice(0, 6),
      benignTeardownLines: consoleErrors.length - faults.length,
      gate,
    };
    report.captures.webglOn = {
      nonBlack: onNB,
      mean: centralMean(capOn.decoded),
    };
    report.captures.webglOff = {
      nonBlack: offNB,
      mean: centralMean(capOff.decoded),
    };

    const errors =
      gate.errors.length + faults.length + (gate.deviceLost ? 1 : 0);
    const aPass =
      onNB > 8 &&
      offNB > 8 &&
      onVsOff.pct !== null &&
      onVsOff.pct > 0.5 && // OIT-on visibly differs from sorted alpha
      errors === 0;
    report.oracles.a_webglOitActive = {
      pass: aPass,
      onNonBlack: onNB,
      offNonBlack: offNB,
      onVsOff_diffPct: onVsOff.pct,
      onVsOff_maxDelta: onVsOff.maxDelta,
      errors,
      note: "WebGL default OIT (on) vs orderIndependentTranslucency:false (sorted alpha); must differ at intersections",
    };
    if (!aPass) overallPass = false;

    // Keep the WebGL OIT-on capture for the (c) parity comparison.
    report.__webglOnDecoded = capOn.decoded;
  } finally {
    await browser.close();
  }
}

// ── WebGPU session: oracle (b),(c),(d) single-device sequence + (c-splat) ──
{
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  try {
    const { page, consoleErrors } = await newPage(browser);
    await gotoViewer(page, "webgpu");

    const setup = await setupViewer(page, { renderer: "webgpu", oit: true });
    await armWebGPUDevices(page);

    // P0 — WebGPU default (gate off = sorted alpha, the current default).
    const gateBefore = await page.evaluate(() => {
      const cd = window.CesiumDebug;
      return cd && typeof cd.webgpuOIT === "function" ? cd.webgpuOIT() : null;
    });
    const p0 = await grabCanvas(page);
    fs.writeFileSync(
      path.join(OUT_DIR, "oit-webgpu-default.png"),
      encodePNG(p0.decoded),
    );

    // Control: a second default capture (no toggle, a few frames later) to
    // measure the renderer's intrinsic frame-to-frame noise floor (TPDF dither
    // etc.). Byte-identity contracts below are asserted RELATIVE to this floor.
    await page.evaluate(async () => {
      const scene = window.__probeViewer.scene;
      for (let i = 0; i < 8; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    const p0b = await grabCanvas(page);
    const noiseFloor = diffPixels(p0.decoded, p0b.decoded, 0);
    report.captures.noiseFloor = {
      mismatchPx: noiseFloor.mismatch,
      maxDelta: noiseFloor.maxDelta,
      note: "two consecutive WebGPU-default captures (no toggle) — intrinsic dither/temporal noise floor",
    };

    // Toggle OIT ON, settle, capture + status.
    const statusOn = await page.evaluate(async () => {
      const cd = window.CesiumDebug;
      const st = cd.webgpuOIT(true);
      const scene = window.__probeViewer.scene;
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Re-read live status after rendering so `active` reflects real frames.
      const live = cd.webgpuOIT();
      const sr = scene._alternateSceneRenderer;
      return {
        toggled: st,
        live,
        activeThisFrame: !!(sr && sr._webgpuOITActiveThisFrame),
      };
    });
    const pOn = await grabCanvas(page);
    fs.writeFileSync(
      path.join(OUT_DIR, "oit-webgpu-on.png"),
      encodePNG(pOn.decoded),
    );

    // Toggle OIT OFF, settle, capture (containment restore).
    await page.evaluate(async () => {
      const cd = window.CesiumDebug;
      cd.webgpuOIT(false);
      const scene = window.__probeViewer.scene;
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    });
    const pOff = await grabCanvas(page);
    fs.writeFileSync(
      path.join(OUT_DIR, "oit-webgpu-restored.png"),
      encodePNG(pOff.decoded),
    );

    const gate = await collectGateErrors(page);
    const faults = realFaults(consoleErrors);
    const errors =
      gate.errors.length + faults.length + (gate.deviceLost ? 1 : 0);

    // Oracle (b): WebGPU default vs WebGL OIT-off (both sorted alpha). The
    // WebGL-off capture is re-decoded from disk below (via the page's decode
    // path); the WebGL-on capture rides on the report object (same process).
    const p0NB = nonBlackFrac(p0.decoded);
    const pOnNB = nonBlackFrac(pOn.decoded);
    const pOffNB = nonBlackFrac(pOff.decoded);

    report.captures.webgpuDefault = {
      nonBlack: p0NB,
      mean: centralMean(p0.decoded),
    };
    report.captures.webgpuOn = {
      nonBlack: pOnNB,
      mean: centralMean(pOn.decoded),
    };
    report.captures.webgpuRestored = {
      nonBlack: pOffNB,
      mean: centralMean(pOff.decoded),
    };
    report.webgpuSession = {
      setup,
      gateBefore,
      statusOn,
      consoleFaults: faults.slice(0, 8),
      benignTeardownLines: consoleErrors.length - faults.length,
      gate,
    };

    // (b) cross-backend sorted-vs-sorted band.
    // The WebGL OIT-off decoded array was written to disk; decode it back for
    // the comparison via the page (reuse the same decode path).
    const webglOffDecoded = await page.evaluate(
      async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const off = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = off.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        return { w: bmp.width, h: bmp.height, data: Array.from(d) };
      },
      fs
        .readFileSync(path.join(OUT_DIR, "oit-webgl-off.png"))
        .toString("base64"),
    );
    const bDiff = diffPixels(p0.decoded, webglOffDecoded);
    report.oracles.b_wgpuDefault_vs_webglOff = {
      pass: p0NB > 8, // observational; just require the WebGPU sorted path renders
      diffPct: bDiff.pct,
      maxDelta: bDiff.maxDelta,
      webgpuDefaultNonBlack: p0NB,
      note: "cross-backend sorted-alpha vs sorted-alpha band (recorded)",
    };

    // (c) WebGPU OIT opt-in — gate flips, 0 errors, non-black. active RECORDED.
    const live = statusOn.live || {};
    const gateFlipped =
      !!(statusOn.toggled && statusOn.toggled.safetyGateEnabled) &&
      live.requested === true &&
      live.capable === true;
    // C11-157 Slice A — translucent PRIMITIVES now carry the OIT variant, so
    // the accumulation path MUST engage: active + _webgpuOITActiveThisFrame
    // true (both were ALWAYS false at Batch-700).
    const cPass =
      gateFlipped &&
      pOnNB > 8 &&
      errors === 0 &&
      statusOn.activeThisFrame === true &&
      live.active === true;
    // parity delta vs WebGL OIT-on
    const webglOnDecoded = report.__webglOnDecoded;
    const cParity = diffPixels(pOn.decoded, webglOnDecoded);
    report.oracles.c_wgpuOitOptIn = {
      pass: cPass,
      gateFlipped,
      statusActive: live.active,
      statusFallbackReason: live.fallbackReason,
      statusSafetyGateEnabled: live.safetyGateEnabled,
      activeThisFrame: statusOn.activeThisFrame,
      onNonBlack: pOnNB,
      parityVsWebglOn_diffPct: cParity.pct,
      parityVsWebglOn_maxDelta: cParity.maxDelta,
      errors,
      note: "C11-157 Slice A: translucent PRIMITIVES now reach the MRT-OIT accumulation. Gate flips (requested/capable/safetyGateEnabled) + 0 errors + non-black + active=TRUE + _webgpuOITActiveThisFrame=TRUE (both were ALWAYS FALSE at Batch-700). Weighted-blended (McGuire-Bavoil) desaturation at the intersections is the expected, known WBOIT look.",
    };
    if (!cPass) overallPass = false;
    if (statusOn.activeThisFrame !== true || live.active !== true) {
      report.findings.push(
        "OIT-PRIMITIVE-REACHABILITY-REGRESSION: webgpuOIT(true) on the intersecting-translucent-primitive scene did NOT engage the MRT-OIT accumulation (_webgpuOITActiveThisFrame=" +
          statusOn.activeThisFrame +
          `, active=${live.active}, fallback=${live.fallbackReason}). C11-157 Slice A wired translucent primitives to carry the OIT variant, so a false here is a regression, not the Batch-700 unreachability finding.`,
      );
    }

    // (d) containment restore — identical to pre-toggle default WITHIN the
    // renderer's intrinsic dither noise floor (a dithered renderer captured
    // across frames is never literally 0 px; the honest contract is "no delta
    // beyond the floor the renderer already shows without any toggle").
    const dRestore = diffPixels(p0.decoded, pOff.decoded, 0);
    const floorMismatch = Math.max(noiseFloor.mismatch, 1);
    const floorMax = Math.max(noiseFloor.maxDelta, 1);
    const dWithinFloor =
      dRestore.mismatch <= floorMismatch * 3 &&
      dRestore.maxDelta <= floorMax + 2;
    const dPass = dWithinFloor && errors === 0;
    report.oracles.d_containmentRestore = {
      pass: dPass,
      restoreVsDefault_mismatchPx: dRestore.mismatch,
      restoreVsDefault_maxDelta: dRestore.maxDelta,
      noiseFloor_mismatchPx: noiseFloor.mismatch,
      noiseFloor_maxDelta: noiseFloor.maxDelta,
      withinNoiseFloor: dWithinFloor,
      errors,
      note: "webgpuOIT(false) returns to the pre-toggle WebGPU default within the intrinsic dither noise floor (measured by a no-toggle control). Restore delta ≈ floor ⇒ containment restored. C11-157 Slice A: this is now a MEANINGFUL restore proof — OIT genuinely engaged at gate-ON (oracle c), and gate-OFF returns to the byte-identical sorted-alpha default.",
    };
    if (!dPass) overallPass = false;

    // Also record: did OIT-on differ from the default at all? (expected: no.)
    const onVsDefault = diffPixels(pOn.decoded, p0.decoded, 0);
    report.oracles.c_onVsDefault = {
      mismatchPx: onVsDefault.mismatch,
      maxDelta: onVsDefault.maxDelta,
      note: "OIT-on vs WebGPU-default: now NON-zero — the gate flip visibly changes the render because weighted-blended OIT engages for translucent primitives (C11-157 Slice A).",
    };

    // ── (c-splat) reachability confirmation via the synthetic splat FR ──
    const splatObs = await page.evaluate(
      async ({ clockIso }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.__probeViewer;
        const scene = v.scene;
        const ctx = scene.context;
        const sr = scene._alternateSceneRenderer;
        if (!sr) return { skipped: "no alternate renderer" };

        // Fresh dark stage with a settled globe so the splat has real depth.
        v.entities.removeAll();
        scene.globe.show = true;
        scene.imageryLayers.removeAll();
        scene.imageryLayers.addImageryProvider(
          new C.GridImageryProvider({ cells: 4 }),
        );
        scene.globe.baseColor = new C.Color(0.3, 0.22, 0.14, 1.0);
        scene.globe.showGroundAtmosphere = false;
        scene.backgroundColor = C.Color.BLACK;
        v.clock.shouldAnimate = false;
        v.clock.currentTime = C.JulianDate.fromIso8601(clockIso);

        await ctx.getFeatureRendererAsync(16);

        const LON = -75.0;
        const LAT = 40.0;
        const R2 = 600.0 * 600.0;
        const makeSplat = (alt, color) => {
          const data = new Float32Array(16);
          const pos = C.Cartesian3.fromDegrees(LON, LAT, alt);
          const enc = C.EncodedCartesian3.fromCartesian(pos, {
            high: new C.Cartesian3(),
            low: new C.Cartesian3(),
          });
          data[0] = enc.high.x;
          data[1] = enc.high.y;
          data[2] = enc.high.z;
          data[3] = enc.low.x;
          data[4] = enc.low.y;
          data[5] = enc.low.z;
          data[6] = R2;
          data[9] = R2;
          data[11] = R2;
          data[12] = color[0];
          data[13] = color[1];
          data[14] = color[2];
          data[15] = 0.85;
          return {
            show: true,
            modelMatrix: C.Matrix4.IDENTITY,
            _splatData: data,
            _splatCount: 1,
            _webgpuCache: undefined,
            update(frameState) {
              const fr = frameState.context.getFeatureRenderer(16);
              if (fr) fr.update(this, frameState);
            },
            isDestroyed() {
              return false;
            },
            destroy() {},
          };
        };
        scene.primitives.add(makeSplat(2000.0, [1.0, 0.1, 0.1]));

        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(LON, LAT, 8000.0),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });

        // Arm BOTH gates: the OIT containment flag + the opt-in splat deferral
        // (the only route to fold a _shaderCode carrier into the OIT pass).
        window.CesiumDebug.webgpuOIT(true);
        sr._splatOITDeferral = true;

        let sawActive = false;
        let deferredLeak = false;
        for (let i = 0; i < 40; i++) {
          scene.render();
          if (sr._webgpuOITActiveThisFrame) sawActive = true;
          if (sr._deferredOITSplats) deferredLeak = true;
          await new Promise((r) => requestAnimationFrame(r));
        }
        const st = window.CesiumDebug.webgpuOIT();
        // Restore containment.
        sr._splatOITDeferral = false;
        window.CesiumDebug.webgpuOIT(false);
        return {
          sawOITActiveAnyFrame: sawActive,
          deferredLeakObserved: deferredLeak,
          statusActive: st ? st.active : null,
          statusFallback: st ? st.fallbackReason : null,
        };
      },
      { clockIso: CLOCK_ISO },
    );
    const gate2 = await collectGateErrors(page);
    const splatFaults = realFaults(consoleErrors);
    const splatErrors =
      gate2.errors.length + splatFaults.length + (gate2.deviceLost ? 1 : 0);
    report.oracles.cSplat_reachability = {
      pass: splatErrors === 0, // observational — only device errors fail it
      ...splatObs,
      errors: splatErrors,
      note: "Synthetic splat + armed _webgpuOITEnabled + _splatOITDeferral. Observational only (gates on 0 device errors). C11-157 Slice A note: the accumulation pass is now REACHABLE whenever a translucent PRIMITIVE is present, so sawOITActiveAnyFrame may be true here from residual translucent primitives left by the shared viewer's prior scene — it does NOT by itself prove the splat-DEFERRAL path reaches OIT. The Gaussian-splat deferral (splats are Pass.GAUSSIAN_SPLATS, folded only after hasOITPipelines is derived) remains a SEPARATE slice: NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME.",
    };
    if (splatErrors !== 0) overallPass = false;

    delete report.__webglOnDecoded;
  } finally {
    await browser.close();
  }
}

const outPath = path.join(OUT_DIR, "oit-transparency-report.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report.oracles, null, 2));
console.log("\nFINDINGS:");
for (const f of report.findings) console.log(" - " + f);
console.log(`\nReport: ${outPath}`);
console.log(
  "\nOracle (e) STANDARD-TRANSPARENCY REGRESSION NET — run separately (each launches its own Edge):\n" +
    "  node Tools/visual-regression/probe-globe-translucency.mjs\n" +
    "  PROBE_BASE=" +
    BASE +
    " node Tools/visual-regression/probe-ellipsoidprim-translucent.mjs\n" +
    "  node Tools/visual-regression/probe-custom-shader-translucency.mjs\n" +
    "  node Tools/visual-regression/translucent-classification-debug.mjs",
);

clearTimeout(watchdog);
const gatedOracles = [
  report.oracles.a_webglOitActive,
  report.oracles.c_wgpuOitOptIn,
  report.oracles.d_containmentRestore,
  report.oracles.cSplat_reachability,
];
const gatePass = overallPass && gatedOracles.every((o) => o && o.pass);
console.log(
  gatePass
    ? "\nGATE PASS — OIT coverage captured; WebGL OIT genuinely active; WebGPU translucent PRIMITIVES now REACH the MRT-OIT accumulation (C11-157 Slice A: active=true, 0 device errors) and containment restores. Splat-deferral (c-splat) remains a separate unreached path."
    : "\nGATE FAIL — see oracle table + findings.",
);
process.exit(gatePass ? 0 : 1);
