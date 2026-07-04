/**
 * PREREQ-MODEL-SCENE2D-STAGE-GUARD acceptance probe.
 *
 * SceneMode2DPipelineStage (SCENE code) runs whenever `model._projectTo2D` is
 * true and the scene is non-3D. Under WebGL it projects the source positions
 * to a 2D vertex buffer AND sets `positionAttribute.typedArray = undefined`
 * (SceneMode2DPipelineStage.js:107), destroying the CPU-side positions.
 *
 * The guard added here routes that strip through the backend-agnostic
 * capability `GraphicsContext.requiresVertexTypedArrayRetention` (false on
 * WebGL, true on WebGPU). This probe proves, by RUNTIME INTROSPECTION of the
 * scene graph (no isWebGPU branch in scene code):
 *
 *   (a) WebGPU SCENE3D — the stage never runs in 3D (use2D is false), so no
 *       positionBuffer2D is ever created and the typedArray is intact. 3D
 *       renders (non-empty coverage) with 0 device/console errors.
 *   (b) WebGPU SCENE2D (projectTo2D:true) — the strip is SKIPPED: every
 *       POSITION attribute keeps `typedArray` defined, and NO WebGL stub
 *       positionBuffer2D is allocated (runtimePrimitive.positionBuffer2D is
 *       undefined). 0 device/console errors.
 *   (c) WebGL SCENE2D (projectTo2D:true) — UNCHANGED: the typedArray is
 *       stripped (undefined) and positionBuffer2D IS allocated, exactly as
 *       before this change.
 *
 * Usage: node Tools/visual-regression/probe-model-scene2d-stage-guard.mjs
 *   PROBE_BASE (default http://localhost:8080)
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";
const W = 800;
const H = 600;

// modeId: 2=SCENE2D, 3=SCENE3D
async function run(renderer, modeId) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const info = await page.evaluate(
    async ({ modelUrl, modeId }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      // Capture Cesium render-loop errors directly — a thrown DeveloperError
      // (e.g. an invalid draw command) aborts the frame and shows the viewer
      // error dialog; the console-pattern gate does not always match it.
      const renderErrors = [];
      scene.renderError.addEventListener((s, e) => {
        renderErrors.push((e && (e.message || String(e))) || "unknown");
      });
      window.__renderErrors = renderErrors;

      const lon = -75;
      const lat = 40;
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(lon, lat, 0),
      );
      // projectTo2D:true — the exact opt-in that runs SceneMode2DPipelineStage.
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 4.0,
        projectTo2D: true,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (modeId === 2) {
        scene.morphTo2D(0);
      }
      for (let i = 0; i < 12; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      if (modeId === 3) {
        v.camera.viewBoundingSphere(
          model.boundingSphere,
          new C.HeadingPitchRange(0.6, -0.3, model.boundingSphere.radius * 3.0),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      } else {
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, 250.0),
        });
      }

      // Render enough frames that buildDrawCommands (and the stage) has run
      // for the active mode.
      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      scene.canvas.setAttribute("data-cs", "1");

      // Runtime introspection of the scene graph: for every runtime primitive,
      // find the POSITION attribute and record whether its typedArray survived
      // and whether a 2D buffer was allocated.
      const sg = model.sceneGraph;
      const nodes = sg._runtimeNodes;
      let posWithTypedArray = 0;
      let posTotal = 0;
      let buffers2D = 0;
      let prims = 0;
      for (let n = 0; n < nodes.length; n++) {
        const rn = nodes[n];
        if (!rn || !rn.runtimePrimitives) {
          continue;
        }
        for (let p = 0; p < rn.runtimePrimitives.length; p++) {
          const rp = rn.runtimePrimitives[p];
          prims++;
          if (C.defined(rp.positionBuffer2D)) {
            buffers2D++;
          }
          const attrs = rp.primitive.attributes;
          for (let a = 0; a < attrs.length; a++) {
            if (attrs[a].semantic === "POSITION") {
              posTotal++;
              if (C.defined(attrs[a].typedArray)) {
                posWithTypedArray++;
              }
            }
          }
        }
      }

      return {
        ready: !!model.ready,
        sceneMode: scene.mode,
        prims,
        posTotal,
        posWithTypedArray,
        buffers2D,
        renderErrors: window.__renderErrors.slice(0, 3),
        renderErrorCount: window.__renderErrors.length,
      };
    },
    { modelUrl: MODEL, modeId },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  // Coverage: does the model actually render (non-empty)?
  const png = await page
    .locator('canvas[data-cs="1"]')
    .screenshot({ type: "png" });
  const cov = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let y = 60 * bmp.width * 4; y < d.length; y += 4) {
      if (d[y] + d[y + 1] + d[y + 2] > 12) {
        n++;
      }
    }
    return { w: bmp.width, h: bmp.height, pixels: n };
  }, Buffer.from(png).toString("base64"));

  const fs = await import("fs");
  const out = `Tools/visual-regression/output/model-scene2d-guard-${renderer}-${modeId === 2 ? "2d" : "3d"}.png`;
  fs.writeFileSync(out, png);

  await browser.close();
  return {
    ...info,
    coverage: cov.pixels,
    outPng: out,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
  };
}

function line(label, r) {
  console.log(
    `${label.padEnd(18)} mode=${r.sceneMode} prims=${r.prims} pos=${r.posWithTypedArray}/${r.posTotal} buf2D=${r.buffers2D} cov=${r.coverage} err=${r.gateErrors.length}/${r.consoleFaults.length} renderErr=${r.renderErrorCount} lost=${r.deviceLost} -> ${r.outPng}`,
  );
  if (r.renderErrorCount > 0) {
    console.log(`    renderError[0]: ${r.renderErrors[0]}`);
  }
}

const gpu2d = await run("webgpu", 2);
const gpu3d = await run("webgpu", 3);
const gl2d = await run("webgl", 2);

console.log("\n=== PREREQ-MODEL-SCENE2D-STAGE-GUARD ===");
line("webgpu 2D", gpu2d);
line("webgpu 3D", gpu3d);
line("webgl  2D", gl2d);

const errs = (r) =>
  r.gateErrors.length +
  r.consoleFaults.length +
  r.renderErrorCount +
  (r.deviceLost ? 1 : 0);

// (b) WebGPU 2D: strip skipped -> all POSITION typedArrays retained, NO 2D buffer.
const bRetained = gpu2d.posTotal > 0 && gpu2d.posWithTypedArray === gpu2d.posTotal;
const bNoStub = gpu2d.buffers2D === 0;
const bClean = errs(gpu2d) === 0 && gpu2d.coverage > 0;
// (a) WebGPU 3D: stage never runs -> typedArrays intact, no 2D buffer, renders.
const aClean = errs(gpu3d) === 0 && gpu3d.coverage > 0 && gpu3d.buffers2D === 0;
// (c) WebGL 2D unchanged: typedArray stripped + 2D buffer allocated.
const cStripped = gl2d.posTotal > 0 && gl2d.posWithTypedArray === 0;
const cStub = gl2d.buffers2D > 0;

console.log("\n--- gates ---");
console.log(`(b) WebGPU 2D typedArray retained (${gpu2d.posWithTypedArray}/${gpu2d.posTotal}): ${bRetained ? "PASS" : "FAIL"}`);
console.log(`(b) WebGPU 2D no stub buffer (buf2D=${gpu2d.buffers2D}): ${bNoStub ? "PASS" : "FAIL"}`);
console.log(`(b) WebGPU 2D clean+renders (cov=${gpu2d.coverage}, err=${errs(gpu2d)}): ${bClean ? "PASS" : "FAIL"}`);
console.log(`(a) WebGPU 3D off-gate (cov=${gpu3d.coverage}, buf2D=${gpu3d.buffers2D}, err=${errs(gpu3d)}): ${aClean ? "PASS" : "FAIL"}`);
console.log(`(c) WebGL 2D stripped (${gl2d.posWithTypedArray}/${gl2d.posTotal}): ${cStripped ? "PASS" : "FAIL"}`);
console.log(`(c) WebGL 2D stub allocated (buf2D=${gl2d.buffers2D}): ${cStub ? "PASS" : "FAIL"}`);

const pass = bRetained && bNoStub && bClean && aClean && cStripped && cStub;
console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
