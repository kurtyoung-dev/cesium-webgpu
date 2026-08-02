#!/usr/bin/env node
// C11-212 Scene.snap on WebGPU — browser acceptance probe (Batch 812+).
//
// Runs the orchestrator checklist from the C11-212 landing, per backend:
//
//   Gate A — FUNCTIONAL: `scene.snap()` at a model's screen center returns a
//     hit whose world position is within 50 m of the model's placement. WebGPU
//     readback is asynchronous and is published only with its immutable
//     camera/frustum/viewport provenance, so the probe polls a cold query with
//     renders between calls until a relevant completed payload is available.
//   Gate B — MISS: snapping at a screen corner showing only sky/globe returns
//     no model hit (upstream snap is Model-pipeline-only on both backends).
//   Gate C — LAZY-IDENTITY (WebGPU): before the first `snap()` call the
//     context must not report prior snap use (`_snapEnabled !== true`); after
//     it, the ever-used diagnostic must be latched. Current command demand is
//     independently gated by `frameState.passes.snap`. WebGL has no latch.
//   Gate D — CLEAN: zero console errors and zero WebGPU validation errors
//     across the whole run (an attachment-format drift silently empties every
//     query, so the error channel is load-bearing).
//
// Scene: CesiumMilkTruck glTF from the repo's sample data, 100 m above the
// ellipsoid at a fixed lon/lat, offline-friendly camera 300 m out. Edge only.
//
// Usage: node Tools/visual-regression/probe-scene-snap.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const VIEW = { width: 1024, height: 768 };
const MODEL_URL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
  });
  const page = await browser.newPage({ viewport: VIEW });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ modelUrl, view }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const s = v.scene;
      s.globe.depthTestAgainstTerrain = true;
      const dev = s.context?._device;
      const de = [];
      if (dev) {
        dev.onuncapturederror = (ev) =>
          de.push(String(ev?.error?.message ?? "").slice(0, 200));
      }

      const lon = -105.0;
      const lat = 40.0;
      const height = 100.0;
      const center = C.Cartesian3.fromDegrees(lon, lat, height);
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 20.0,
      });
      s.primitives.add(model);

      // Ready-gate: model.ready, then settle for pipeline warmup.
      for (let i = 0; i < 240; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (model.ready) break;
      }
      v.camera.lookAt(center, new C.HeadingPitchRange(0.3, -0.4, 300.0));
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      for (let i = 0; i < 60; i++) {
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Gate C precondition (WebGPU): snap must not be latched before use.
      const latchedBefore = s.context?._snapEnabled === true;

      const screenCenter = new C.Cartesian2(view.width / 2, view.height / 2);
      // Cold asynchronous-readback contract: call snap with renders between
      // until a matching completed payload lands (or the budget runs out).
      let hit;
      let calls = 0;
      for (let i = 0; i < 10; i++) {
        calls++;
        hit = s.snap(screenCenter);
        if (hit) break;
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const latchedAfter = s.context?._snapEnabled === true;

      let hitDistance = null;
      if (hit?.position) {
        hitDistance = C.Cartesian3.distance(hit.position, center);
      }

      // Gate B — a corner point showing only sky/globe must return no model
      // hit. Same retry shape so a cold WebGPU readback cannot fake a pass.
      let missHit;
      for (let i = 0; i < 4; i++) {
        missHit = s.snap(new C.Cartesian2(8, 8));
        if (missHit) break;
        s.requestRender();
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        modelReady: model.ready,
        hitFound: !!hit,
        hitCalls: calls,
        hitDistance,
        hitIsEdge: hit?.isEdge ?? null,
        missFound: !!missHit,
        latchedBefore,
        latchedAfter,
        deviceErrs: de,
      };
    },
    { modelUrl: MODEL_URL, view: VIEW },
  );

  await browser.close();
  return { ...result, consoleErrs: errs };
}

const gl = await run("webgl");
const gpu = await run("webgpu");

console.log("=== C11-212 Scene.snap acceptance ===");
for (const [name, r] of [
  ["WebGL ", gl],
  ["WebGPU", gpu],
]) {
  console.log(
    `${name}: ready=${r.modelReady} hit=${r.hitFound} calls=${r.hitCalls} dist=${
      r.hitDistance === null ? "n/a" : r.hitDistance.toFixed(1) + "m"
    } isEdge=${r.hitIsEdge} miss=${r.missFound} latch ${r.latchedBefore}->${r.latchedAfter} devErrs=${r.deviceErrs.length} conErrs=${r.consoleErrs.length}`,
  );
}

const gateA =
  gl.hitFound &&
  gpu.hitFound &&
  gl.hitDistance !== null &&
  gl.hitDistance < 50 &&
  gpu.hitDistance !== null &&
  gpu.hitDistance < 50;
const gateB = !gl.missFound && !gpu.missFound;
const gateC = gpu.latchedBefore === false && gpu.latchedAfter === true;
const allErrs = [
  ...gl.consoleErrs,
  ...gl.deviceErrs,
  ...gpu.consoleErrs,
  ...gpu.deviceErrs,
];
const gateD = allErrs.length === 0;
console.log(
  `\nGate A functional: ${gateA ? "PASS" : "FAIL"} | Gate B miss: ${gateB ? "PASS" : "FAIL"} | Gate C latch: ${gateC ? "PASS" : "FAIL"} | Gate D clean: ${gateD ? "PASS" : "FAIL"}`,
);
if (!gateD) {
  console.log(allErrs.slice(0, 8).join("\n"));
}
const pass = gateA && gateB && gateC && gateD;
console.log(`\nGATE ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
