#!/usr/bin/env node
// Probe (WIRE-COLORGRADING-CALLER): the ColorGrading stage is reachable at
// RUNTIME via the scene-level opt-in (`scene.colorGradingEnabled = true`,
// optional `scene.colorGradingConfig`), wired through
// configureWebGPUPostProcessPipeline like godRay/coldOptics. Before this
// task `addColorGrading` had ZERO runtime call sites — the Batch 478/479
// shader work was unreachable except by probes poking the pipeline object.
// @purpose ColorGrading runtime-wiring acceptance: off by default, enable adds the pass, config swap re-grades, disable returns identical.
// @status ACTIVE
//
// Asserts:
//   (A) DEFAULT: no PostProcess-ColorGrading pass is recorded on an
//       untouched scene (stage never added — off by default).
//   (B) ENABLE: `scene.colorGradingEnabled = true` with a strong warm
//       grade → the ColorGrading pass appears in the frame's render-pass
//       labels AND the frame visibly differs from the default capture.
//   (C) RUNTIME CONFIG: assigning a NEW `scene.colorGradingConfig` object
//       (grayscale) re-grades the frame (updateColorGradingUniforms path).
//   (D) DISABLE: flipping the flag off returns the frame BYTE-IDENTICAL
//       to the default capture (clean bypass).
//   (E) 0 console errors + 0 GPU uncapturederrors across the whole run.
//   (F) OFF-GATE vs pre-change build: the default capture byte-matches a
//       baseline captured on the build WITHOUT this wiring
//       (run `--baseline` on the pre-change build first).
//
// Usage:
//   node Tools/visual-regression/probe-colorgrading-wired.mjs --baseline
//   node Tools/visual-regression/probe-colorgrading-wired.mjs
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
  "colorgrading-wired",
);
mkdirSync(OUT_DIR, { recursive: true });

// Strong, obviously-visible warm grade for the enable pass.
const WARM_GRADE = {
  exposure: 0.3,
  contrast: 1.2,
  saturation: 1.4,
  temperature: 0.6,
  tint: 0.1,
  highlightsTint: { r: 1.0, g: 0.8, b: 0.5, w: 0.3 },
};
// Second config for the runtime-update pass — full desaturation.
const GRAY_GRADE = { saturation: 0.0 };

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(
  async ({ warm, gray }) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    const context = scene.context;

    // ---- instrumentation ----
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

    // ---- deterministic scene (same recipe as probe-hdr-pp-math) ----
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
    const passLabelsOneFrame = async () => {
      await oncePostRender();
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
    await renderFrames(60);

    // Settle to a TRUE steady state before capturing: terrain/tile
    // refinement keeps mutating the frame for a while after tilesLoaded
    // first flips true, and captures taken at different points of that
    // transition are not comparable. Require tilesLoaded AND two grabs
    // 10 frames apart to be byte-identical.
    const bytesEqual = (a, b) => {
      if (a.data.length !== b.data.length) return false;
      for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== b.data[i]) return false;
      }
      return true;
    };
    const settleAndGrab = async () => {
      let prev = await grab();
      for (let i = 0; i < 60; i++) {
        await renderFrames(10);
        const cur = await grab();
        if (scene.globe.tilesLoaded && bytesEqual(prev, cur)) return cur;
        prev = cur;
      }
      return prev;
    };

    const captures = {};

    // (A) default — the opt-in flag is untouched.
    captures.default = await settleAndGrab();
    const defaultLabels = await passLabelsOneFrame();

    // (B) enable via the SCENE-LEVEL flags (the wiring under test — the
    // pipeline object is never touched directly by this probe).
    scene.colorGradingEnabled = true;
    scene.colorGradingConfig = warm;
    await renderFrames(5);
    captures.warm = await settleAndGrab();
    const warmLabels = await passLabelsOneFrame();

    // (C) runtime config swap — NEW object triggers the uniform update.
    scene.colorGradingConfig = gray;
    await renderFrames(5);
    captures.gray = await settleAndGrab();

    // (D) disable — back to baseline.
    scene.colorGradingEnabled = false;
    await renderFrames(5);
    captures.disabled = await settleAndGrab();
    const disabledLabels = await passLabelsOneFrame();

    return {
      captures,
      defaultLabels,
      warmLabels,
      disabledLabels,
      gpuErrors: window.__gpuErrors,
    };
  },
  { warm: WARM_GRADE, gray: GRAY_GRADE },
);

await page.close();
await browser.close();

if (!out || !out.captures) {
  console.error("FATAL: no captures");
  process.exit(1);
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
function diffImgs(a, b) {
  const A = a.data;
  const B = b.data;
  if (A.length !== B.length) return { fracDiff: 1, note: "size mismatch" };
  let diffBytes = 0;
  let maxDelta = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
  }
  return { diffBytes, maxDelta, fracDiff: diffBytes / A.length };
}
function diffVsBin(img, binPath) {
  const base = readFileSync(binPath);
  const cur = Buffer.from(Uint8Array.from(img.data));
  if (base.length !== cur.length) {
    return { identical: false, note: `size ${base.length} vs ${cur.length}` };
  }
  let diffBytes = 0;
  let maxDelta = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = Math.abs(cur[i] - base[i]);
    if (d > 0) diffBytes++;
    if (d > maxDelta) maxDelta = d;
  }
  return { identical: diffBytes === 0, diffBytes, maxDelta };
}

// ================= baseline mode =================
if (BASELINE_MODE) {
  savePng("baseline-default.png", out.captures.default);
  saveBin("baseline-default.bin", out.captures.default);
  console.log(
    `default labels: ${out.defaultLabels.filter((l) => l.startsWith("PostProcess")).join(" | ")}`,
  );
  console.log(
    `errors: console=${consoleErrors.length} gpu=${out.gpuErrors.length}`,
  );
  consoleErrors.slice(0, 5).forEach((e) => console.log("  ERR:", e));
  console.log(`Baseline saved to ${OUT_DIR}`);
  process.exit(0);
}

// ================= verify mode =================
savePng("default.png", out.captures.default);
savePng("warm.png", out.captures.warm);
savePng("gray.png", out.captures.gray);
savePng("disabled.png", out.captures.disabled);

const pp = (ls) => ls.filter((l) => l.startsWith("PostProcess"));
console.log(`default  labels: ${pp(out.defaultLabels).join(" | ")}`);
console.log(`warm     labels: ${pp(out.warmLabels).join(" | ")}`);
console.log(`disabled labels: ${pp(out.disabledLabels).join(" | ")}`);

// (A) default: no ColorGrading pass.
const aOK = !out.defaultLabels.some((l) => l.includes("ColorGrading"));
console.log(
  `(A) default frame has NO ColorGrading pass: ${aOK ? "OK" : "FAIL"}`,
);

// (B) enabled: pass present + visibly graded.
const hasCG = out.warmLabels.some((l) =>
  l.includes("PostProcess-ColorGrading"),
);
const dWarm = diffImgs(out.captures.warm, out.captures.default);
const bOK = hasCG && dWarm.fracDiff > 0.05;
console.log(
  `(B) warm grade: pass=${hasCG} fracDiff-vs-default=${(100 * dWarm.fracDiff).toFixed(2)}% maxDelta=${dWarm.maxDelta} ${bOK ? "OK" : "FAIL"}`,
);

// (C) runtime config swap re-grades the frame.
const dGray = diffImgs(out.captures.gray, out.captures.warm);
const cOK = dGray.fracDiff > 0.05;
console.log(
  `(C) gray re-grade: fracDiff-vs-warm=${(100 * dGray.fracDiff).toFixed(2)}% ${cOK ? "OK" : "FAIL"}`,
);

// (D) disabled: byte-identical to default + no ColorGrading pass.
const dDis = diffImgs(out.captures.disabled, out.captures.default);
const disHasCG = out.disabledLabels.some((l) => l.includes("ColorGrading"));
const dOK = dDis.diffBytes === 0 && !disHasCG;
console.log(
  `(D) disabled vs default: ${dDis.diffBytes === 0 ? "BYTE-IDENTICAL" : `diffBytes=${dDis.diffBytes} maxDelta=${dDis.maxDelta}`}, pass-present=${disHasCG} ${dOK ? "OK" : "FAIL"}`,
);

// (E) zero errors.
const eOK = consoleErrors.length === 0 && out.gpuErrors.length === 0;
console.log(
  `(E) errors: console=${consoleErrors.length} gpu=${out.gpuErrors.length} ${eOK ? "OK" : "FAIL"}`,
);
[...consoleErrors, ...out.gpuErrors]
  .slice(0, 10)
  .forEach((e) => console.log("  ERR:", e.slice(0, 300)));

// (F) off-gate vs pre-change baseline.
let fOK;
const binPath = join(OUT_DIR, "baseline-default.bin");
if (!existsSync(binPath)) {
  console.log(
    `(F) NO BASELINE (${binPath}) — run --baseline on the pre-change build`,
  );
  fOK = false;
} else {
  const d = diffVsBin(out.captures.default, binPath);
  fOK = d.identical;
  console.log(
    `(F) default vs pre-change baseline: ${d.identical ? "BYTE-IDENTICAL" : `diffBytes=${d.diffBytes} maxDelta=${d.maxDelta}${d.note ? ` (${d.note})` : ""}`} ${fOK ? "OK" : "FAIL"}`,
  );
}

console.log(`PNGs: ${OUT_DIR}`);
const pass = aOK && bOK && cOK && dOK && eOK && fOK;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
