#!/usr/bin/env node
// Probe (NEW-PICK-RAY-ASYNC, Batch 284; supersedes the FQ-5 Batch-254 honesty
// assertion): sampleHeight/clampToHeight now WORK on WebGPU via main-scene-depth
// reuse (the Batch-252 pickPosition reconstruction), not just emit a warning.
// @purpose Asserts sampleHeight/clampToHeight work on WebGPU via main-scene-depth reuse (cold-cache converges) with WebGL behavior unchanged.
// @status ACTIVE
//
// Background: scene.sampleHeightSupported / clampToHeightSupported gate on
// context.depthTexture (true on WebGPU). The offscreen ray-render depth path
// (PickingRayHelpers.getRayIntersection) cannot reconstruct a position from the
// LOG-encoded main-camera globe-depth, so Picking now routes sampleHeight /
// clampToHeight through _reconstructHeightSurfaceWebGPU: it projects the target
// into the live view and reads the rendered surface beneath it via the proven
// pickPosition path. One-frame-stale sync cache (cold query → undefined →
// converges 1-2 frames). pickFromRay over an ARBITRARY ray stays scoped out
// (object hit but no position; oneTimeWarning).
//
// What it asserts:
//  WebGL leg (behavior MUST be unchanged):
//   1. sampleHeightSupported / clampToHeightSupported === true.
//   2. sampleHeight returns a real finite number (the reference height).
//   3. clampToHeight returns a finite Cartesian3.
//   4. Zero console errors.
//  WebGPU leg:
//   5. sampleHeightSupported / clampToHeightSupported report true.
//   6. sampleHeight cold-cache: first call undefined, then a finite number.
//   7. clampToHeight cold-cache: first call undefined, then a Cartesian3.
//   8. Converged WebGPU height within tolerance of WebGL (main-scene-depth
//      reuse at a near-nadir view).
//   9. Zero console errors on both legs.
//
// Usage: node Tools/visual-regression/probe-sampleheight-webgpu.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 1_500_000.0;

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
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
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

      // Warm up until tiles loaded (no pick call yet — that would arm the
      // readback and break the cold-cache assertion). Then settle frames.
      const MAX_WARMUP_FRAMES = 600;
      let tilesLoadedAt = -1;
      for (let i = 0; i < MAX_WARMUP_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (scene.globe && scene.globe.tilesLoaded) {
          tilesLoadedAt = i;
          break;
        }
      }
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const target = C.Cartographic.fromDegrees(LON, LAT);
      const targetCart = C.Cartesian3.fromDegrees(LON, LAT, 50000.0);

      const describe = (res) => {
        if (res === undefined) return { kind: "undefined", value: null };
        if (typeof res === "number")
          return { kind: isFinite(res) ? "number" : "number-NaN", value: res };
        if (res && typeof res.x === "number")
          return {
            kind: isFinite(res.x) ? "Cartesian3" : "Cartesian3-NaN",
            value: { x: res.x, y: res.y, z: res.z },
          };
        return { kind: typeof res, value: null };
      };

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
        tilesLoadedAt,
        sampleHeightResults,
        clampResults,
      };
    },
    { LON, LAT, HEIGHT },
  );

  await page.close();
  return { ...out, errors };
}

// ---- run both legs ----
const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

// ---- report ----
function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(
    `sampleHeightSupported=${leg.sampleHeightSupported}  clampToHeightSupported=${leg.clampToHeightSupported}  pickPositionSupported=${leg.pickPositionSupported}  useLogDepth=${leg.useLogDepth}  tilesLoadedAt=${leg.tilesLoadedAt}`,
  );
  leg.sampleHeightResults.forEach((r, i) =>
    console.log(
      `  sampleHeight[${i}]: ${r.kind}` +
        (typeof r.value === "number" ? ` = ${r.value.toFixed(2)}` : ""),
    ),
  );
  leg.clampResults.forEach((r, i) =>
    console.log(`  clampToHeight[${i}]: ${r.kind}`),
  );
  console.log(`  console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

// ---- assertions ----
const failures = [];

// --- WebGL leg ---
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
if (webgl.errors.length > 0)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);

// --- WebGPU leg ---
if (!webgpu.isWebGPU) failures.push("WebGPU leg did not report isWebGPU");
if (webgpu.sampleHeightSupported !== true)
  failures.push("WebGPU sampleHeightSupported should be true");
if (webgpu.clampToHeightSupported !== true)
  failures.push("WebGPU clampToHeightSupported should be true");

// Cold cache: first sample undefined, then converges to a finite number.
if (webgpu.sampleHeightResults[0].kind !== "undefined")
  failures.push(
    `WebGPU sampleHeight cold-cache: frame 0 expected undefined, got ${webgpu.sampleHeightResults[0].kind}`,
  );
const gpuHeightHit = webgpu.sampleHeightResults.find(
  (r) => r.kind === "number",
);
if (!gpuHeightHit)
  failures.push("WebGPU sampleHeight never converged to a finite number");
if (webgpu.clampResults[0].kind !== "undefined")
  failures.push(
    `WebGPU clampToHeight cold-cache: frame 0 expected undefined, got ${webgpu.clampResults[0].kind}`,
  );
const gpuClampHit = webgpu.clampResults.find((r) => r.kind === "Cartesian3");
if (!gpuClampHit)
  failures.push("WebGPU clampToHeight never converged to a Cartesian3");

// Cross-backend height match.
if (glHeightHit && gpuHeightHit) {
  const dH = Math.abs(glHeightHit.value - gpuHeightHit.value);
  console.log(
    `\ncross-backend sampleHeight delta: dH=${dH.toFixed(1)} m (WebGL=${glHeightHit.value.toFixed(1)} WebGPU=${gpuHeightHit.value.toFixed(1)})`,
  );
  if (dH > 1500)
    failures.push(`sampleHeight dHeight ${dH.toFixed(1)} m > 1500 m`);
}

if (webgpu.errors.length > 0)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: sampleHeight/clampToHeight WORK on WebGPU (main-scene-depth reuse), WebGL unchanged",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
