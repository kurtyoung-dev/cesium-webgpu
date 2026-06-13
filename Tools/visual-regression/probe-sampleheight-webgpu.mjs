#!/usr/bin/env node
// Probe (FQ-5, Batch 254): sampleHeight/clampToHeight honesty on WebGPU.
//
// Background: scene.sampleHeightSupported / clampToHeightSupported gate only on
// context.depthTexture, which is true on WebGPU. But the synchronous ray-pick
// depth path (PickingRayHelpers.getRayIntersection) cannot reconstruct a
// position from the LOG-encoded WebGPU globe-depth via the per-frustum LINEAR
// formula, so sampleHeight / clampToHeight silently returned undefined with NO
// warning. The full async ray-pick path is Phase 6 (NEW-PICK-RAY-ASYNC,
// deferred). This batch adds a oneTimeWarning so the limitation is no longer
// silent.
//
// What it asserts:
//  WebGL leg (behavior MUST be unchanged):
//   1. sampleHeightSupported / clampToHeightSupported === true.
//   2. sampleHeight returns a real finite number (the reference height).
//   3. clampToHeight returns a finite Cartesian3.
//   4. NO "WebGPU.rayPick.unsupported" warning is emitted.
//   5. Zero console errors.
//  WebGPU leg:
//   6. sampleHeightSupported / clampToHeightSupported still report true
//      (pickPosition works via Batch 252; the getter is not down-gated).
//   7. sampleHeight returns undefined (the SAFE pre-fix behavior, preserved).
//   8. clampToHeight returns undefined.
//   9. EXACTLY ONE "WebGPU.rayPick.unsupported" console warning is emitted
//      across many sampleHeight + clampToHeight calls (oneTimeWarning dedupe).
//  10. Zero console errors on both legs.
//
// Usage: node Tools/visual-regression/probe-sampleheight-webgpu.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 2_000_000.0;
const WARN_ID_SUBSTRING = "synchronous ray-pick depth path is not yet";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runLeg(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  const warnings = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning") warnings.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ LON, LAT, HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      // Let the globe load + render so the depth texture is populated.
      for (let i = 0; i < 90; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const target = C.Cartographic.fromDegrees(LON, LAT);
      const targetCart = C.Cartesian3.fromDegrees(LON, LAT, 0.0);

      const describe = (res) => {
        if (res === undefined) return { kind: "undefined", value: null };
        if (typeof res === "number") {
          return { kind: isFinite(res) ? "number" : "number-NaN", value: res };
        }
        if (res && typeof res.x === "number") {
          return {
            kind: isFinite(res.x) ? "Cartesian3" : "Cartesian3-NaN",
            value: { x: res.x, y: res.y, z: res.z },
          };
        }
        return { kind: typeof res, value: null };
      };

      // Call sampleHeight + clampToHeight several times each across frames.
      // On WebGPU each call routes through getRayIntersection → exactly ONE
      // warning total (oneTimeWarning dedupe).
      const sampleHeightResults = [];
      const clampResults = [];
      for (let i = 0; i < 6; i++) {
        let sh, ch;
        try {
          sh = scene.sampleHeight(C.Cartographic.clone(target));
        } catch (e) {
          sh = `THREW: ${e}`;
        }
        try {
          ch = scene.clampToHeight(C.Cartesian3.clone(targetCart));
        } catch (e) {
          ch = `THREW: ${e}`;
        }
        sampleHeightResults.push(
          typeof sh === "string" ? { kind: sh, value: null } : describe(sh),
        );
        clampResults.push(
          typeof ch === "string" ? { kind: ch, value: null } : describe(ch),
        );
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        rendererType: scene.context?.rendererType,
        isWebGPU: scene.context?.isWebGPU === true,
        sampleHeightSupported: scene.sampleHeightSupported,
        clampToHeightSupported: scene.clampToHeightSupported,
        pickPositionSupported: scene.pickPositionSupported,
        useLogDepth: scene.frameState?.useLogDepth,
        sampleHeightResults,
        clampResults,
      };
    },
    { LON, LAT, HEIGHT },
  );

  await page.close();
  const rayWarnings = warnings.filter((w) => w.includes(WARN_ID_SUBSTRING));
  return { ...out, errors, warnings, rayWarnings };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(
    `sampleHeightSupported=${leg.sampleHeightSupported}  clampToHeightSupported=${leg.clampToHeightSupported}  pickPositionSupported=${leg.pickPositionSupported}  useLogDepth=${leg.useLogDepth}`,
  );
  leg.sampleHeightResults.forEach((r, i) =>
    console.log(
      `  sampleHeight[${i}]: ${r.kind}` +
        (typeof r.value === "number" ? ` = ${r.value.toFixed(2)}` : ""),
    ),
  );
  leg.clampResults.forEach((r, i) => console.log(`  clampToHeight[${i}]: ${r.kind}`));
  console.log(`  rayPick warnings: ${leg.rayWarnings.length}`);
  leg.rayWarnings.slice(0, 2).forEach((w) => console.log("   WARN:", w.slice(0, 90)));
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

// --- WebGL leg: behavior MUST be unchanged ---
if (webgl.sampleHeightSupported !== true)
  failures.push("WebGL sampleHeightSupported should be true");
if (webgl.clampToHeightSupported !== true)
  failures.push("WebGL clampToHeightSupported should be true");

const glHeightHit = webgl.sampleHeightResults.find((r) => r.kind === "number");
if (!glHeightHit)
  failures.push("WebGL sampleHeight never returned a finite number");

const glClampHit = webgl.clampResults.find((r) => r.kind === "Cartesian3");
if (!glClampHit)
  failures.push("WebGL clampToHeight never returned a finite Cartesian3");

if (webgl.rayWarnings.length !== 0)
  failures.push(
    `WebGL must NOT emit the rayPick warning (got ${webgl.rayWarnings.length})`,
  );

if (webgl.errors.length > 0)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);

// --- WebGPU leg ---
if (!webgpu.isWebGPU) failures.push("WebGPU leg did not report isWebGPU");

// Getter not down-gated (pickPosition works via Batch 252).
if (webgpu.sampleHeightSupported !== true)
  failures.push("WebGPU sampleHeightSupported should remain true");
if (webgpu.clampToHeightSupported !== true)
  failures.push("WebGPU clampToHeightSupported should remain true");

// SAFE behavior preserved: undefined, never NaN/garbage, never a thrown error.
const gpuBadSample = webgpu.sampleHeightResults.find(
  (r) => r.kind !== "undefined",
);
if (gpuBadSample)
  failures.push(
    `WebGPU sampleHeight expected undefined, got ${gpuBadSample.kind}`,
  );
const gpuBadClamp = webgpu.clampResults.find((r) => r.kind !== "undefined");
if (gpuBadClamp)
  failures.push(`WebGPU clampToHeight expected undefined, got ${gpuBadClamp.kind}`);

// THE honesty fix: exactly one warning across all the calls.
if (webgpu.rayWarnings.length === 0)
  failures.push(
    "WebGPU emitted NO rayPick warning (the silent-failure the fix targets)",
  );
else if (webgpu.rayWarnings.length > 1)
  failures.push(
    `WebGPU emitted ${webgpu.rayWarnings.length} rayPick warnings (oneTimeWarning must dedupe to 1)`,
  );

if (webgpu.errors.length > 0)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: sampleHeight/clampToHeight honesty — one warning on WebGPU, WebGL unchanged",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
