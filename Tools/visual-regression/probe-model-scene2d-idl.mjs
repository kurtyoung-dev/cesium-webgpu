/**
 * C-MODEL-2DIDL-DUPLICATE-RELAND acceptance probe.
 *
 * WebGL's ModelDrawCommand derives a second, y-shifted "2D" draw command
 * (`derive2DCommand` + `updateModelMatrix2D`) whenever a non-projectTo2D model
 * straddles the antimeridian (IDL) in SCENE2D, so the half of the model clipped
 * by one viewport is drawn wrapped into the other. WebGPU previously emitted
 * only the primary command, so the crossing (wrapped) half was 0 px.
 *
 * This probe, in SCENE2D with the whole map framed:
 *   - places a large model exactly on the IDL (lon 180) so its 2D bounding
 *     sphere straddles +-piR. The primary command renders the on-map half at
 *     the RIGHT edge; the duplicate renders the wrapped half at the LEFT edge.
 *   - measures model coverage in the far-left and far-right columns.
 *
 * GATE (WebGPU crossing): BOTH left-edge AND right-edge coverage > 0 — the
 * crossing half now renders (was 0 px on the wrapped edge). WebGL is captured
 * as the parity reference (both edges > 0).
 *
 * OFF-GATE (WebGPU, lon 0, not crossing): the model renders only near center;
 * left/right edge coverage ~= 0. The full PNG is saved so an off-IDL byte diff
 * against the pre-change build can confirm byte-identical emission.
 *
 * Usage: node Tools/visual-regression/probe-model-scene2d-idl.mjs
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
const PIPELINE_SETTLE_MS = Number(process.env.PROBE_PIPELINE_SETTLE_MS ?? 0);

// lonMode: "idl" -> model on the antimeridian (crossing); "center" -> lon 0.
async function run(renderer, lonMode) {
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
    async ({ modelUrl, lonMode, pipelineSettleMs }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;

      scene.globe.show = false;
      scene.skyBox.show = false;
      scene.skyAtmosphere.show = false;
      scene.backgroundColor = C.Color.BLACK;

      const renderErrors = [];
      scene.renderError.addEventListener((s, e) => {
        renderErrors.push((e && (e.message || String(e))) || "unknown");
      });
      window.__renderErrors = renderErrors;

      const lon = lonMode === "idl" ? 180.0 : 0.0;
      const lat = 0.0;
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(lon, lat, 0),
      );
      // Large scale so the model is visible at whole-map 2D zoom and its 2D
      // bounding sphere clearly straddles the IDL. NOT projectTo2D — this is
      // exactly the path WebGL `shouldUse2DCommands` covers.
      const model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 400000.0,
      });
      scene.primitives.add(model);
      for (let i = 0; i < 600 && !model.ready; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      scene.morphTo2D(0);
      for (let i = 0; i < 20; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Frame the whole 2D map so both edges (and center) are on screen.
      v.camera.setView({
        destination: C.Rectangle.fromDegrees(-179.9, -75, 179.9, 75),
      });

      for (let i = 0; i < 60; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (pipelineSettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pipelineSettleMs));
        for (let i = 0; i < 10; i++) {
          scene.render();
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }

      // Read the CANVAS FRAMEBUFFER directly (drawImage into a 2D context) so
      // no DOM widget chrome is included — element screenshots would composite
      // the CesiumViewer toolbar/timeline/help overlay on top of the canvas.
      // Force one final synchronous render immediately before the read so the
      // WebGL back buffer (no preserveDrawingBuffer) still holds the frame.
      scene.render();
      const canvas = scene.canvas;
      const w = canvas.width;
      const h = canvas.height;
      const off = new OffscreenCanvas(w, h);
      const octx = off.getContext("2d");
      octx.drawImage(canvas, 0, 0);
      const d = octx.getImageData(0, 0, w, h).data;
      const yMax = Math.floor(h * 0.9);
      let left = 0;
      let right = 0;
      let center = 0;
      for (let y = 0; y < yMax; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (d[i] + d[i + 1] + d[i + 2] > 24) {
            const fx = x / w;
            if (fx < 0.12) {
              left++;
            } else if (fx > 0.88) {
              right++;
            } else if (fx > 0.4 && fx < 0.6) {
              center++;
            }
          }
        }
      }
      const blob = await off.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let b64 = "";
      for (let i = 0; i < buf.length; i++) {
        b64 += String.fromCharCode(buf[i]);
      }
      const pngB64 = btoa(b64);

      const bs2D = model.sceneGraph._boundingSphere2D;
      const modelCommands = scene._frameState.commandList.filter(
        (command) => command?.owner === model,
      );
      const commandDiagnostics = modelCommands.slice(0, 6).map((command) => ({
        pass: command.pass,
        pipeline: command.pipeline?.label ?? null,
        matrixTranslation: command.modelMatrix
          ? [command.modelMatrix[12], command.modelMatrix[13], command.modelMatrix[14]]
          : null,
        boundingCenter: command.boundingVolume?.center
          ? [
              command.boundingVolume.center.x,
              command.boundingVolume.center.y,
              command.boundingVolume.center.z,
            ]
          : null,
        boundingRadius: command.boundingVolume?.radius ?? null,
        cull: command.cull ?? null,
      }));
      const runtimePrimitives = model.sceneGraph._runtimeNodes.flatMap((node) =>
        node?.runtimePrimitives ?? [],
      );
      const nativePrimitiveCaches = Object.values(
        model._webgpuCache?.primitives ?? {},
      );
      const nativePipelineCache = model._webgpuCache?.pipelineCache;
      return {
        ready: !!model.ready,
        sceneMode: scene.mode,
        drawCommandsBackend: model._drawCommandsBackend,
        nativeCommandCount: modelCommands.length,
        commandDiagnostics,
        runtimeDescriptorCount: runtimePrimitives.filter(
          (primitive) => primitive.backendNeutralDescriptor,
        ).length,
        runtimeDrawCommandCount: runtimePrimitives.filter(
          (primitive) => primitive.drawCommand,
        ).length,
        nativeCacheCount: nativePrimitiveCaches.length,
        nativePendingPipelineCount:
          nativePipelineCache?._pendingColorPipelines?.size ?? null,
        nativeResolvedPipelineCount:
          nativePipelineCache?._pipelines?.size ?? null,
        centralPipelineStats:
          scene.context.webgpuPipelineCache?.getStats?.() ?? null,
        nativePipelines: nativePrimitiveCaches.map((primitive) => ({
          pipeline: primitive.pipeline?.label ?? null,
          refetch: primitive._pipelineNeedsRefetch ?? null,
          vertexCount: primitive.vertexCount ?? null,
          indexCount: primitive.indexCount ?? null,
        })),
        bs2DcenterY: bs2D ? bs2D.center.y : null,
        bs2Dradius: bs2D ? bs2D.radius : null,
        w,
        h,
        left,
        right,
        center,
        pngB64,
        renderErrors: window.__renderErrors.slice(0, 3),
        renderErrorCount: window.__renderErrors.length,
      };
    },
    { modelUrl: MODEL, lonMode, pipelineSettleMs: PIPELINE_SETTLE_MS },
  );

  const gateArm = await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  const gate = await collectGateErrors(page);

  const fs = await import("fs");
  const out = `Tools/visual-regression/output/model-2didl-${renderer}-${lonMode}.png`;
  fs.writeFileSync(out, Buffer.from(info.pngB64, "base64"));
  delete info.pngB64;

  await browser.close();
  return {
    ...info,
    outPng: out,
    gateArmed: gateArm.armed,
    gateErrors: gate.errors,
    deviceLost: gate.deviceLost,
    consoleFaults: consoleErrors,
  };
}

function line(label, r) {
  console.log(
    `${label.padEnd(16)} mode=${r.sceneMode} L=${r.left} C=${r.center} R=${r.right} bs2D(y=${r.bs2DcenterY?.toFixed(0)},r=${r.bs2Dradius?.toFixed(0)}) err=${r.gateErrors.length}/${r.consoleFaults.length} renderErr=${r.renderErrorCount} lost=${r.deviceLost} -> ${r.outPng}`,
  );
  if (r.renderErrorCount > 0) {
    console.log(`    renderError[0]: ${r.renderErrors[0]}`);
  }
  console.log(
    `    backend=${r.drawCommandsBackend} nativeCommands=${r.nativeCommandCount} descriptors=${r.runtimeDescriptorCount} legacy=${r.runtimeDrawCommandCount} nativeCaches=${r.nativeCacheCount} localPending=${r.nativePendingPipelineCount} localResolved=${r.nativeResolvedPipelineCount}`,
  );
  if (r.centralPipelineStats) {
    console.log(`    centralPipelines: ${JSON.stringify(r.centralPipelineStats)}`);
  }
  if (r.commandDiagnostics.length > 0) {
    console.log(`    command[0]: ${JSON.stringify(r.commandDiagnostics[0])}`);
  }
  if (r.nativePipelines.length > 0) {
    console.log(`    nativePipeline[0]: ${JSON.stringify(r.nativePipelines[0])}`);
  }
}

const errs = (r) =>
  r.gateErrors.length +
  r.consoleFaults.length +
  r.renderErrorCount +
  (r.deviceLost ? 1 : 0);

const gpuIdl = await run("webgpu", "idl");
const gpuCenter = await run("webgpu", "center");
const glIdl = await run("webgl", "idl");

console.log("\n=== C-MODEL-2DIDL-DUPLICATE-RELAND ===");
line("webgpu IDL", gpuIdl);
line("webgpu lon0", gpuCenter);
line("webgl  IDL", glIdl);

// GATE: WebGPU crossing renders BOTH edges (the wrapped half is no longer 0 px),
// clean, and matches WebGL (which also renders both edges).
const gpuBothEdges = gpuIdl.left > 0 && gpuIdl.right > 0;
const glBothEdges = glIdl.left > 0 && glIdl.right > 0;
const gpuClean = errs(gpuIdl) === 0;
// OFF-GATE: WebGPU lon0 renders in the center only; edges ~ empty; clean.
const offGate =
  gpuCenter.center > 0 &&
  gpuCenter.left === 0 &&
  gpuCenter.right === 0 &&
  errs(gpuCenter) === 0;

// C-MODEL-2DSPLIT-PRIMARY-CULL parity gate: the crossing render must draw BOTH
// halves at ~= WebGL coverage (not just >0). The Scene-level two-viewport split
// (`execute2DViewportCommands`, backend-agnostic in ViewportExecutor.js) already
// executes both viewport halves for WebGPU, so total crossing coverage (L+R)
// tracks WebGL within the model-level conservative-2D-BV margin. Was ~0.48 if the
// primary (unshifted) half were dropped; a regression there collapses this ratio.
const gpuCrossPx = gpuIdl.left + gpuIdl.right;
const glCrossPx = glIdl.left + glIdl.right;
const crossRatio = glCrossPx > 0 ? gpuCrossPx / glCrossPx : 0;
const primaryCullParity = crossRatio >= 0.9;

console.log("\n--- gates ---");
console.log(
  `GATE WebGPU crossing both edges (L=${gpuIdl.left}, R=${gpuIdl.right}): ${gpuBothEdges ? "PASS" : "FAIL"}`,
);
console.log(
  `GATE WebGPU crossing clean (err=${errs(gpuIdl)}): ${gpuClean ? "PASS" : "FAIL"}`,
);
console.log(
  `REF  WebGL crossing both edges (L=${glIdl.left}, R=${glIdl.right}): ${glBothEdges ? "PASS" : "FAIL"}`,
);
console.log(
  `OFF  WebGPU lon0 center-only (C=${gpuCenter.center}, L=${gpuCenter.left}, R=${gpuCenter.right}, err=${errs(gpuCenter)}): ${offGate ? "PASS" : "FAIL"}`,
);
console.log(
  `GATE WebGPU crossing px ~= WebGL (ratio=${crossRatio.toFixed(3)}, gpu=${gpuCrossPx}, gl=${glCrossPx}): ${primaryCullParity ? "PASS" : "FAIL"}`,
);

const pass =
  gpuBothEdges && gpuClean && glBothEdges && offGate && primaryCullParity;
console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
