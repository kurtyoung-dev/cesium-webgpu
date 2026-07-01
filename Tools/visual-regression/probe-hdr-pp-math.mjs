#!/usr/bin/env node
// Probe (PARITY-HDR-PP-MATH): HDR-aware ColorGrading + FXAA math on the
// tonemap-bypass (HDR canvas output) path.
//
// Before this task, `_skipSDRStagesForHDR` dropped ColorGrading + FXAA
// entirely whenever `scene.useHDRCanvasOutput && scene.highDynamicRange`.
// Now both stages RUN in HDR mode with HDR-aware math (Reinhard-compressed
// working space for the grade pivots / FXAA luma), gated by an `hdrMode`
// uniform that is 0 on the default SDR path.
//
// Passes:
//   SDR  — default renderer path on a deterministic scene. Captures
//          `sdr-default` (stock stages) and `sdr-graded` (ColorGrading
//          added with a fixed visible grade + FXAA). Compared byte-wise
//          against a pre-change baseline (run `--baseline` on the OLD
//          build first) to prove the SDR path is unchanged.
//   HDR  — same scene with `scene.highDynamicRange = true` +
//          `scene.useHDRCanvasOutput = true`. Asserts:
//          (A) the HDR canvas path actually engaged on this device
//              (context.hdrCanvasOutput true after settling — otherwise
//              the probe reports DEVICE-BLOCKED and skips the on-path
//              assertions honestly);
//          (B) PostProcess-ColorGrading-Pass and PostProcess-FXAA-Pass
//              are recorded per frame (stages RUN, not skipped) while
//              PostProcess-Tonemap-Pass is ABSENT (tonemap bypass);
//          (C) output is plausible: not black, not blown out, alpha
//              intact (a NaN-poisoned chain shows up as black/zero);
//          (D) 0 console errors + 0 GPU uncapturederrors.
//   WGSL — compiles all four shader sources (f32 + f16 variants) straight
//          from packages/engine/Source on the live device and asserts 0
//          compilation errors (f16 files only when shader-f16 granted).
//
// Usage:
//   node Tools/visual-regression/probe-hdr-pp-math.mjs --baseline  # old build
//   node Tools/visual-regression/probe-hdr-pp-math.mjs             # verify
// Env: PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const BASELINE_MODE = process.argv.includes("--baseline");
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "hdr-pp-math",
);
mkdirSync(OUT_DIR, { recursive: true });

// Fixed, visible grade — identical in baseline + verify runs and in the
// SDR + HDR passes so captures are comparable.
const GRADE = {
  exposure: 0.1,
  contrast: 1.15,
  saturation: 1.3,
  temperature: 0.25,
  tint: -0.1,
  gamma: 1.05,
  highlightsTint: { r: 1.0, g: 0.9, b: 0.7, w: 0.15 },
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runPass(hdrOn) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ hdr, grade }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const context = scene.context;

      // ---- instrumentation (before any rendering we depend on) ----
      window.__passLabels = [];
      const origBRP = GPUCommandEncoder.prototype.beginRenderPass;
      GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
        window.__passLabels.push((desc && desc.label) || "");
        return origBRP.call(this, desc);
      };
      window.__gpuErrors = [];
      const dev = context._device || context.device;
      if (dev && dev.addEventListener) {
        dev.addEventListener("uncapturederror", (e) => {
          window.__gpuErrors.push(String(e.error && e.error.message));
        });
      }

      // ---- HDR canvas output (the feature under test) ----
      if (hdr) {
        scene.highDynamicRange = true;
        scene.useHDRCanvasOutput = true;
      }

      // ---- deterministic scene (same recipe as probe-postprocess-f16) ----
      scene.requestRenderMode = false;
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
      scene.fog.enabled = false;
      scene.globe.showGroundAtmosphere = false;
      scene.terrainProvider = new C.EllipsoidTerrainProvider();
      scene.globe.showWaterEffect = false;
      scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
      v.imageryLayers.removeAll();

      const points = scene.primitives.add(new C.PointPrimitiveCollection());
      points.add({
        position: C.Cartesian3.fromDegrees(0.7, 0.0, 30000.0),
        color: C.Color.WHITE,
        pixelSize: 200,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });

      scene.morphTo3D(0);
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(0.0, 0.0, 20000.0),
        orientation: {
          heading: C.Math.toRadians(90.0),
          pitch: C.Math.toRadians(-10.0),
          roll: 0.0,
        },
      });

      const oncePostRender = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
        });
      const renderFrames = async (n) => {
        for (let i = 0; i < n; i++) await oncePostRender();
      };
      const grab = () =>
        new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const c = scene.canvas;
            const off = document.createElement("canvas");
            off.width = c.width;
            off.height = c.height;
            const cx = off.getContext("2d");
            cx.drawImage(c, 0, 0);
            resolve({
              data: Array.from(
                new Uint8Array(
                  cx.getImageData(0, 0, c.width, c.height).data.buffer,
                ),
              ),
              png: off.toDataURL("image/png"),
              w: c.width,
              h: c.height,
            });
          });
        });
      // Record all render-pass labels of exactly one frame.
      const passLabelsOneFrame = async () => {
        await oncePostRender(); // align to a frame boundary
        window.__passLabels.length = 0;
        await oncePostRender();
        return window.__passLabels.slice();
      };

      // Strip the async default ion imagery until tiles settle.
      let stable = 0;
      for (let i = 0; i < 600 && stable < 5; i++) {
        if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
        await oncePostRender();
        stable = scene.globe.tilesLoaded ? stable + 1 : 0;
      }
      await renderFrames(20);

      // Post-process pipeline is (re)created by ensureResources — grab it
      // AFTER the settle frames so the HDR recreate (hdr flag flip) is done.
      const renderer = scene._alternateSceneRenderer;
      const pp = renderer && renderer._postProcess;
      if (!pp) {
        return { fatal: "no post-process pipeline" };
      }

      const captures = {};
      captures.default = await grab();
      const defaultLabels = await passLabelsOneFrame();

      // Add ColorGrading with the fixed grade (no runtime caller adds it
      // by default — the pipeline API is the supported entry point) and
      // enable FXAA so both stages under test are in the chain.
      pp.addColorGrading(
        pp._device,
        context.presentationFormat ?? "bgra8unorm",
        grade,
      );
      scene.postProcessStages.fxaa.enabled = true;
      await renderFrames(5);
      captures.graded = await grab();
      const gradedLabels = await passLabelsOneFrame();

      return {
        captures,
        defaultLabels,
        gradedLabels,
        hdrFlags: {
          sceneUseHDRCanvasOutput: scene.useHDRCanvasOutput,
          contextHDRCanvasOutput: !!context.hdrCanvasOutput,
          sceneHighDynamicRange: scene.highDynamicRange,
          ppHdr: !!pp._hdr,
          ppHdrOutputMode: !!pp._hdrOutputMode,
          presentationFormat: context.presentationFormat,
        },
        supportsF16: !!(context.hasFeature && context.hasFeature("shader-f16")),
        gpuErrors: window.__gpuErrors,
      };
    },
    { hdr: hdrOn, grade: GRADE },
  );

  // WGSL compile validation on the live device (verify run, HDR page only
  // would be enough, but it's cheap — do it on every page).
  const wgsl = await page.evaluate(async () => {
    const v = window.viewer;
    const dev = v.scene.context._device || v.scene.context.device;
    if (!dev) return { skipped: "no device" };
    const hasF16 = dev.features.has("shader-f16");
    const files = [
      "ColorGrading.wgsl",
      "FXAA.wgsl",
      "ColorGrading_f16.wgsl",
      "FXAA_f16.wgsl",
    ];
    const results = [];
    for (const f of files) {
      if (f.includes("_f16") && !hasF16) {
        results.push({ file: f, skipped: "no shader-f16" });
        continue;
      }
      const src = await (
        await fetch(
          `/packages/engine/Source/Shaders/WebGPU/PostProcess/${f}`,
        )
      ).text();
      const mod = dev.createShaderModule({ label: `probe-${f}`, code: src });
      const info = await mod.getCompilationInfo();
      results.push({
        file: f,
        errors: info.messages
          .filter((m) => m.type === "error")
          .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`),
      });
    }
    return { hasF16, results };
  });

  await page.close();
  return { ...out, wgsl, consoleErrors: errors };
}

// ---- helpers ----
function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}
function saveBin(name, img) {
  writeFileSync(join(OUT_DIR, name), Buffer.from(Uint8Array.from(img.data)));
}
function diffVsBin(img, binPath) {
  const base = readFileSync(binPath);
  const cur = Buffer.from(Uint8Array.from(img.data));
  if (base.length !== cur.length) {
    return { identical: false, note: `size ${base.length} vs ${cur.length}` };
  }
  let diffBytes = 0;
  let maxDelta = 0;
  let sum = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = Math.abs(cur[i] - base[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
    sum += d;
  }
  return {
    identical: diffBytes === 0,
    diffBytes,
    maxDelta,
    meanAbs: sum / cur.length,
    fracDiff: diffBytes / cur.length,
  };
}
function imgStats(img) {
  let sum = 0;
  let black = 0;
  let white = 0;
  let alphaBad = 0;
  const px = img.data.length / 4;
  for (let p = 0; p < px; p++) {
    const i = 4 * p;
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    sum += (r + g + b) / 3;
    if (r + g + b <= 6) black++;
    if (r >= 250 && g >= 250 && b >= 250) white++;
    if (img.data[i + 3] < 255) alphaBad++;
  }
  return {
    mean: sum / px,
    fracBlack: black / px,
    fracWhite: white / px,
    fracAlphaBad: alphaBad / px,
  };
}

// ================= baseline mode =================
if (BASELINE_MODE) {
  console.log("=== BASELINE capture (SDR pass, current build) ===");
  const sdr = await runPass(false);
  await browser.close();
  if (sdr.fatal) {
    console.error("FATAL:", sdr.fatal);
    process.exit(1);
  }
  savePng("baseline-sdr-default.png", sdr.captures.default);
  savePng("baseline-sdr-graded.png", sdr.captures.graded);
  saveBin("baseline-sdr-default.bin", sdr.captures.default);
  saveBin("baseline-sdr-graded.bin", sdr.captures.graded);
  console.log(
    `SDR default labels: ${sdr.defaultLabels.filter((l) => l.startsWith("PostProcess")).join(" | ")}`,
  );
  console.log(
    `SDR graded  labels: ${sdr.gradedLabels.filter((l) => l.startsWith("PostProcess")).join(" | ")}`,
  );
  console.log(
    `errors: console=${sdr.consoleErrors.length} gpu=${sdr.gpuErrors.length}`,
  );
  sdr.consoleErrors.slice(0, 5).forEach((e) => console.log("  ERR:", e));
  console.log(`Baseline saved to ${OUT_DIR}`);
  process.exit(0);
}

// ================= verify mode =================
console.log("=== Pass 1: SDR (default path — off-gate) ===");
const sdr = await runPass(false);
console.log("=== Pass 2: HDR canvas output (feature path) ===");
const hdr = await runPass(true);
await browser.close();

if (sdr.fatal || hdr.fatal) {
  console.error("FATAL:", sdr.fatal || hdr.fatal);
  process.exit(1);
}

savePng("sdr-default.png", sdr.captures.default);
savePng("sdr-graded.png", sdr.captures.graded);
savePng("hdr-default.png", hdr.captures.default);
savePng("hdr-graded.png", hdr.captures.graded);

const ppLabels = (ls) => ls.filter((l) => l.startsWith("PostProcess"));
console.log(`SDR graded labels: ${ppLabels(sdr.gradedLabels).join(" | ")}`);
console.log(`HDR graded labels: ${ppLabels(hdr.gradedLabels).join(" | ")}`);
console.log("HDR flags:", JSON.stringify(hdr.hdrFlags));

// (A) HDR path engaged?
const engaged =
  hdr.hdrFlags.sceneUseHDRCanvasOutput &&
  hdr.hdrFlags.contextHDRCanvasOutput &&
  hdr.hdrFlags.ppHdrOutputMode;
console.log(
  `(A) HDR canvas path engaged on this device: ${engaged ? "OK" : "DEVICE-BLOCKED (canvas demoted to SDR)"}`,
);

// (B) stages RUN under HDR, tonemap bypassed.
let bOK = true;
if (engaged) {
  const labels = hdr.gradedLabels;
  const hasCG = labels.some((l) => l.includes("PostProcess-ColorGrading"));
  const hasFXAA = labels.some((l) => l.includes("PostProcess-FXAA"));
  const hasTonemap = labels.some((l) => l.includes("PostProcess-Tonemap"));
  bOK = hasCG && hasFXAA && !hasTonemap;
  console.log(
    `(B) HDR frame: ColorGrading=${hasCG} FXAA=${hasFXAA} Tonemap(bypassed)=${!hasTonemap} ${bOK ? "OK" : "FAIL"}`,
  );
} else {
  console.log("(B) skipped (device-blocked)");
}

// (C) plausible HDR output (non-NaN/black/blown).
let cOK = true;
if (engaged) {
  const s = imgStats(hdr.captures.graded);
  cOK =
    s.mean > 4 &&
    s.mean < 250 &&
    s.fracBlack < 0.9 &&
    s.fracWhite < 0.9 &&
    s.fracAlphaBad < 0.01;
  console.log(
    `(C) HDR graded stats: mean=${s.mean.toFixed(2)} fracBlack=${(100 * s.fracBlack).toFixed(2)}% ` +
      `fracWhite=${(100 * s.fracWhite).toFixed(2)}% fracAlphaBad=${(100 * s.fracAlphaBad).toFixed(2)}% ${cOK ? "OK" : "FAIL"}`,
  );
} else {
  console.log("(C) skipped (device-blocked)");
}

// (D) zero errors across both passes.
const allErrors = [
  ...sdr.consoleErrors,
  ...sdr.gpuErrors,
  ...hdr.consoleErrors,
  ...hdr.gpuErrors,
];
const dOK = allErrors.length === 0;
console.log(
  `(D) errors: sdr console=${sdr.consoleErrors.length} gpu=${sdr.gpuErrors.length}, ` +
    `hdr console=${hdr.consoleErrors.length} gpu=${hdr.gpuErrors.length} ${dOK ? "OK" : "FAIL"}`,
);
allErrors.slice(0, 10).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

// (E) WGSL compile validation (f32 + f16 variants) on the live device.
let eOK = true;
for (const r of hdr.wgsl.results || []) {
  if (r.skipped) {
    console.log(`(E) ${r.file}: skipped (${r.skipped})`);
    continue;
  }
  const ok = r.errors.length === 0;
  eOK = eOK && ok;
  console.log(`(E) ${r.file}: ${ok ? "compiles clean" : "ERRORS"}`);
  r.errors.forEach((e) => console.log("    ", e));
}

// (F) SDR off-gate: byte-compare vs pre-change baseline.
let fOK = true;
for (const k of ["default", "graded"]) {
  const binPath = join(OUT_DIR, `baseline-sdr-${k}.bin`);
  if (!existsSync(binPath)) {
    console.log(`(F) sdr-${k}: NO BASELINE (${binPath}) — run --baseline on the pre-change build`);
    fOK = false;
    continue;
  }
  const d = diffVsBin(sdr.captures[k], binPath);
  // Byte-identical is the expectation; tolerate nothing beyond it.
  const ok = d.identical;
  fOK = fOK && ok;
  console.log(
    `(F) sdr-${k} vs baseline: ${d.identical ? "BYTE-IDENTICAL" : `diffBytes=${d.diffBytes} (${(100 * d.fracDiff).toFixed(4)}%) maxDelta=${d.maxDelta} meanAbs=${d.meanAbs?.toFixed(5)}`} ${ok ? "OK" : "FAIL"}`,
  );
}

console.log(`PNGs: ${OUT_DIR}`);
const pass = bOK && cOK && dOK && eOK && fOK;
if (!engaged) {
  console.log(
    "NOTE: HDR canvas path did not engage — on-path assertions skipped; " +
      "treat as DEVICE-BLOCKED and rely on (E) WGSL validation + off-gate (F).",
  );
}
console.log(pass ? (engaged ? "PASS" : "PASS (DEVICE-BLOCKED for on-path)") : "FAIL");
process.exit(pass ? 0 : 1);
