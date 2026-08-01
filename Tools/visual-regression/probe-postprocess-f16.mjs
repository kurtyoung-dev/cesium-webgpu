#!/usr/bin/env node
// Probe (PARITY-F16-POSTPROCESS): f16 post-process shader variants.
//
// Two WebGPU passes on the standard CesiumViewer page:
//   OFF — default (`context.useShaderF16` stays false). Asserts the
//         byte-identical off-gate at runtime: ZERO shader modules
//         containing `enable f16` are compiled, and the context flag
//         defaults to false.
//   ON  — sets `scene.context.useShaderF16 = true` BEFORE enabling the
//         lazily-initialized effects (bloom, AO, DoF, god rays, SSR).
//
// Per pass, six captures on a deterministic scene (pinned clock, no
// imagery, ellipsoid terrain, solid globe color, a bright white point
// primitive as a stable bloom/god-ray source): base (no optional
// effects), then each effect toggled on alone.
//
// If the device grants `shader-f16` (it's in DESIRED_FEATURES, so
// granted iff the adapter supports it):
//   (A) ON pass compiled f16 modules for BrightPass / GaussianBlur /
//       BloomComposite / AO generate+modulate / DoF / GodRay
//       generate+composite / SSR (detected via a
//       GPUDevice.createShaderModule hook checking `enable f16`).
//   (B) OFF pass compiled ZERO f16 modules (runtime off-gate).
//   (C) Per-effect f16-vs-f32 closeness: for each capture pair the
//       mean per-channel abs diff < 2.5 AND the fraction of pixels
//       with any channel diff > 12 is < 2%.
//   (D) 0 console errors, 0 GPU uncapturederrors, and no
//       "f16 variant rejected" fallback message in either pass.
// If NOT granted: the ON pass must still select f32 (zero f16 modules
// compiled — the double gate), render unchanged (same closeness bounds)
// with 0 errors; the probe reports support honestly and passes.
//
// NOTE (reported, not asserted): FXAA's runtime addFXAA() call does not
// receive the f16 flag, so that variant is compile-verified only.
// ColorGrading gained a runtime caller (WIRE-COLORGRADING-CALLER, Batch
// 482: `scene.colorGradingEnabled` + `scene.colorGradingConfig`) which
// DOES thread useShaderF16 into addColorGrading; its runtime f16 path is
// covered by probe-colorgrading-wired.mjs + the compile check here.
//
// Usage: node Tools/visual-regression/probe-postprocess-f16.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "output",
  "postprocess-f16",
);
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const EFFECTS = ["bloom", "ao", "dof", "godray", "ssr"];

async function runPass(enableF16) {
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

  const out = await page.evaluate(async (f16On) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const context = scene.context;

    // ---- instrumentation (BEFORE any lazy effect init) ----
    window.__wgslModules = [];
    const origCSM = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (desc) {
      window.__wgslModules.push({
        label: (desc && desc.label) || "",
        f16: /enable\s+f16\s*;/.test((desc && desc.code) || ""),
      });
      return origCSM.call(this, desc);
    };
    window.__gpuErrors = [];
    const dev = context._device || context.device;
    if (dev && dev.addEventListener) {
      dev.addEventListener("uncapturederror", (e) => {
        window.__gpuErrors.push(String(e.error && e.error.message));
      });
    }

    const supportsF16 = !!(
      context.hasFeature && context.hasFeature("shader-f16")
    );
    const defaultFlag = context.useShaderF16; // must be false (off-gate)
    if (f16On) {
      context.useShaderF16 = true;
    }

    // ---- deterministic scene ----
    scene.requestRenderMode = false;
    v.clock.shouldAnimate = false;
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T08:00:00Z");
    scene.fog.enabled = false;
    scene.globe.showGroundAtmosphere = false;
    scene.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.showWaterEffect = false;
    scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
    v.imageryLayers.removeAll();

    // Bright stable "sun" stand-in directly ahead: white 200 px point
    // ~78 km east at 30 km altitude (same trick as probe-bloom-parity —
    // point primitives render deterministically). The real sun (June 21
    // 08:00 UTC, ~27 deg alt ENE) is also near the top of the frame.
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
    // Readback inside postRender (WebGPU canvas clears on present).
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

    // CesiumViewer adds its default ion imagery asynchronously — strip
    // every frame until tiles settle (see probe-bloom-parity history).
    let stable = 0;
    for (let i = 0; i < 600 && stable < 5; i++) {
      if (v.imageryLayers.length > 0) v.imageryLayers.removeAll();
      await oncePostRender();
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
    }
    await renderFrames(30); // let auto-exposure converge

    const pp = scene.postProcessStages;
    // DoF stage added up-front (disabled) so the collection's
    // czm_depth_of_field lookup finds it when toggled.
    const dofStage = pp.add(
      C.PostProcessStageLibrary.createDepthOfFieldStage(),
    );
    dofStage.enabled = false;
    await renderFrames(2);

    const captures = {};
    captures.base = await grab();

    const setEffect = (name, on) => {
      if (name === "bloom") pp.bloom.enabled = on;
      else if (name === "ao") pp.ambientOcclusion.enabled = on;
      else if (name === "dof") dofStage.enabled = on;
      else if (name === "godray") scene.godRayEnabled = on;
      else if (name === "ssr") scene.enableSSR = on;
    };

    for (const name of ["bloom", "ao", "dof", "godray", "ssr"]) {
      setEffect(name, true);
      await renderFrames(15);
      captures[name] = await grab();
      setEffect(name, false);
      await renderFrames(3);
    }

    return {
      captures,
      supportsF16,
      defaultFlag,
      flagNow: context.useShaderF16,
      deviceFeatures: dev ? Array.from(dev.features) : [],
      modules: window.__wgslModules,
      gpuErrors: window.__gpuErrors,
    };
  }, enableF16);

  await page.close();
  return { ...out, consoleErrors: errors };
}

// ---- metrics ----
function diffStats(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  let big = 0;
  let channels = 0;
  const px = n / 4;
  for (let p = 0; p < px; p++) {
    const i = 4 * p;
    let anyBig = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      channels++;
      if (d > 12) anyBig = true;
    }
    if (anyBig) big++;
  }
  return { meanAbs: sum / channels, fracBig: big / px };
}

function savePng(name, img) {
  writeFileSync(
    join(OUT_DIR, name),
    Buffer.from(img.png.split(",")[1], "base64"),
  );
}

console.log("=== Pass 1: f16 OFF (default) ===");
const off = await runPass(false);
console.log("=== Pass 2: f16 ON (context.useShaderF16 = true) ===");
const on = await runPass(true);
await browser.close();

const supportsF16 = off.supportsF16;
console.log(
  `device shader-f16 granted: ${supportsF16} (features: ${off.deviceFeatures.join(", ")})`,
);
console.log(
  `context.useShaderF16 default: ${off.defaultFlag} (must be false); ON-pass flag: ${on.flagNow}`,
);

for (const [tag, r] of [
  ["off", off],
  ["on", on],
]) {
  for (const k of ["base", ...EFFECTS])
    savePng(`${tag}-${k}.png`, r.captures[k]);
}

const offF16Modules = off.modules.filter((m) => m.f16);
const onF16Modules = on.modules.filter((m) => m.f16);
console.log(
  `f16 modules compiled: OFF pass = ${offF16Modules.length}, ON pass = ${onF16Modules.length}`,
);
if (onF16Modules.length) {
  console.log(
    `  ON-pass f16 module labels: ${onF16Modules.map((m) => m.label || "(unlabeled)").join(" | ")}`,
  );
}

// (B) runtime off-gate: default flag false + zero f16 modules in OFF pass.
const bOK = off.defaultFlag === false && offF16Modules.length === 0;
console.log(
  `(B) off-gate: default flag false + 0 f16 modules in OFF pass: ${bOK ? "OK" : "FAIL"}`,
);

// (A) f16 module coverage in the ON pass (only when device supports it).
let aOK;
if (supportsF16) {
  const labels = onF16Modules.map((m) => m.label.toLowerCase());
  const expect = [
    ["bloom-brightpass", "brightpass"],
    ["bloom-blur", "gaussianblur", "blur"],
    ["bloom-composite", "bloomcomposite"],
    ["ao-generate", "ambientocclusion"],
    ["ao-modulate", "modulate"],
    ["dof", "depthoffield", "depth-of-field"],
    ["godray"],
    ["ssr"],
  ];
  const missing = expect.filter(
    (alts) => !labels.some((l) => alts.some((a) => l.includes(a))),
  );
  aOK = missing.length === 0;
  console.log(
    `(A) ON pass compiled f16 modules for all lazily-wired effects: ${aOK ? "OK" : `FAIL (missing: ${missing.map((m) => m[0]).join(", ")})`}`,
  );
} else {
  // Double gate: opted in but device lacks the feature => f32 selected.
  aOK = onF16Modules.length === 0;
  console.log(
    `(A) [no device shader-f16] ON pass gracefully selected f32 (0 f16 modules): ${aOK ? "OK" : "FAIL"}`,
  );
}

// (C) per-effect closeness OFF vs ON.
let cOK = true;
for (const k of ["base", ...EFFECTS]) {
  const s = diffStats(off.captures[k], on.captures[k]);
  // effect magnitude within the OFF pass (is the effect visually live?)
  const mag =
    k === "base" ? null : diffStats(off.captures.base, off.captures[k]);
  const pairOK = s.meanAbs < 2.5 && s.fracBig < 0.02;
  cOK = cOK && pairOK;
  console.log(
    `(C) ${k.padEnd(6)} off-vs-on: meanAbs=${s.meanAbs.toFixed(3)} fracBig=${(100 * s.fracBig).toFixed(3)}%` +
      (mag
        ? ` | effect magnitude (off pass, vs base): fracBig=${(100 * mag.fracBig).toFixed(3)}%`
        : "") +
      ` ${pairOK ? "OK" : "FAIL"}`,
  );
}

// (D) zero errors, no f16 fallback rejection.
const allErrors = [
  ...off.consoleErrors,
  ...off.gpuErrors,
  ...on.consoleErrors,
  ...on.gpuErrors,
];
const rejected = allErrors.filter((e) => /f16 variant rejected/i.test(e));
const dOK = allErrors.length === 0 && rejected.length === 0;
console.log(
  `(D) errors: console off=${off.consoleErrors.length} on=${on.consoleErrors.length}, ` +
    `gpu off=${off.gpuErrors.length} on=${on.gpuErrors.length}, f16-rejected=${rejected.length} ${dOK ? "OK" : "FAIL"}`,
);
allErrors.slice(0, 10).forEach((e) => console.log("  ERR:", e.slice(0, 300)));

console.log(`PNGs: ${OUT_DIR}`);
const pass = aOK && bOK && cOK && dOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
