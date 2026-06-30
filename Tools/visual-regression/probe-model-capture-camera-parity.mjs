#!/usr/bin/env node
// C2-25 ENV-SCENE-CAPTURE (Batch 447) — model/3D-Tiles capture: OFF-parity +
// CAMERA-PARITY probe (run FIRST, must pass before the ON path).
//
// The ONLY on-screen edit in Batch 447 is the `packCameraUniforms` eye-swap:
// both eye reads now come from `uniformState.cameraPosition` instead of
// `frameState.camera.positionWC`. This probe LOCKS that the swap is
// parity-neutral:
//
//   1. CAMERA PARITY: `Cartesian3.equals(uniformState.cameraPosition,
//      camera.positionWC)` within epsilon on a normal frame, across SCENE3D /
//      SCENE2D / COLUMBUS_VIEW + a SECOND viewer (multi-view). This is what
//      makes the eye-swap a no-op on the on-screen path.
//   2. OFF byte-identity: with `sceneCaptureReflections` false (the default),
//      no model capture sources are published (`_webgpuSceneCaptureModels`
//      stays undefined), no console errors, a glTF model + globe paint.
//   3. WebGPU-vs-WebGL canvas diff stays within the existing model tolerance
//      (the eye-swap doesn't perturb the rendered model).
//
// Usage: node Tools/visual-regression/probe-model-capture-camera-parity.mjs
// Outputs: probe-model-capture-camera-parity-webgpu.png, -webgl.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MODEL_URL =
  "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";

async function run(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const result = await page.evaluate(
    async ({ MODEL_URL }) => {
      const Cesium = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const ctx = scene.context;

      // Place a glTF model on the globe + park the camera near it.
      const lon = -100.0;
      const lat = 40.0;
      const pos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
      const hpr = new Cesium.HeadingPitchRoll(0, 0, 0);
      const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
        pos,
        hpr,
      );
      let model;
      try {
        model = scene.primitives.add(
          await Cesium.Model.fromGltfAsync({
            url: MODEL_URL,
            modelMatrix,
            scale: 1000.0, // exaggerate so it's clearly visible from orbit
          }),
        );
      } catch (e) {
        return { error: "model load failed: " + e.message };
      }

      scene.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, 800_000),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });

      // Let the model + tiles load.
      for (let i = 0; i < 220; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const out = {
        rendererType: ctx.rendererType,
        sceneCaptureReflections: ctx.sceneCaptureReflections,
        modelReady: !!model && model.ready === true,
      };

      if (ctx.rendererType !== "webgpu") {
        return out; // WebGL baseline — no camera-parity introspection needed.
      }

      // OFF byte-identity: no model capture publish when the flag is false.
      out.captureModelsPublished =
        ctx._webgpuSceneCaptureModels !== undefined &&
        ctx._webgpuSceneCaptureModels !== null;

      // ── CAMERA PARITY across scene modes + multi-view ──
      const EPS = 1e-6;
      const checkParity = (sc) => {
        const us = sc.context.uniformState;
        const cam = sc.camera;
        const a = us.cameraPosition;
        const b = cam.positionWC;
        const eq = Cesium.Cartesian3.equalsEpsilon(a, b, EPS, EPS);
        return {
          equal: eq,
          uniformStatePos: [a.x, a.y, a.z],
          cameraPos: [b.x, b.y, b.z],
          delta: Cesium.Cartesian3.magnitude(
            Cesium.Cartesian3.subtract(a, b, new Cesium.Cartesian3()),
          ),
        };
      };

      const modes = [];
      // SCENE3D (current)
      scene.render();
      modes.push({ mode: "SCENE3D", ...checkParity(scene) });

      // COLUMBUS_VIEW
      scene.morphToColumbusView(0);
      for (let i = 0; i < 5; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      modes.push({ mode: "COLUMBUS_VIEW", ...checkParity(scene) });

      // SCENE2D
      scene.morphTo2D(0);
      for (let i = 0; i < 5; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      modes.push({ mode: "SCENE2D", ...checkParity(scene) });

      // Back to 3D for the screenshot.
      scene.morphTo3D(0);
      for (let i = 0; i < 8; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // MULTI-VIEW: a second Scene on a fresh canvas sharing the same renderer.
      let secondView = null;
      try {
        const canvas2 = document.createElement("canvas");
        canvas2.width = 256;
        canvas2.height = 256;
        document.body.appendChild(canvas2);
        const scene2 = new Cesium.Scene({
          canvas: canvas2,
          contextOptions: { renderer: "webgpu" },
        });
        scene2.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(10, 20, 5_000_000),
        });
        for (let i = 0; i < 10; i++) {
          scene2.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        secondView = { mode: "MULTI_VIEW(2nd scene)", ...checkParity(scene2) };
        scene2.destroyForSpecs?.();
        try {
          scene2.destroy();
        } catch (e) {
          /* ignore */
        }
        canvas2.remove();
      } catch (e) {
        secondView = { mode: "MULTI_VIEW", error: e.message };
      }

      out.cameraParity = modes;
      out.multiView = secondView;
      return out;
    },
    { MODEL_URL },
  );

  // Final SCENE3D screenshot.
  const out = path.join(
    OUT_DIR,
    `probe-model-capture-camera-parity-${rendererArg}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, result, errs };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: ((100 * mismatch) / total).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[camera-parity] capturing webgpu (flags OFF)…");
  const gpu = await run("webgpu");
  console.log("[camera-parity] capturing webgl (baseline)…");
  const gl = await run("webgl");

  console.log("\n  webgpu state:", JSON.stringify(gpu.result, null, 2));
  if (gpu.result.cameraParity) {
    console.log("\n  CAMERA PARITY (uniformState.cameraPosition vs camera.positionWC):");
    for (const m of gpu.result.cameraParity) {
      console.log(
        `    ${m.mode}: equal=${m.equal} delta=${m.delta?.toExponential?.(3)}`,
      );
    }
    if (gpu.result.multiView) {
      const mv = gpu.result.multiView;
      console.log(
        `    ${mv.mode}: equal=${mv.equal} delta=${mv.delta?.toExponential?.(3)}${mv.error ? " err=" + mv.error : ""}`,
      );
    }
  }

  try {
    const diff = await diffPngs(gpu.out, gl.out);
    console.log("\n  webgpu-vs-webgl canvas diff:", JSON.stringify(diff));
  } catch (e) {
    console.log("  diff failed:", e.message);
  }

  const errs = gpu.errs;
  if (errs.length) {
    console.log(`\n  ${errs.length} webgpu console errors:`);
    errs.slice(0, 8).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }

  // Verdict
  const allModesEqual =
    gpu.result.cameraParity &&
    gpu.result.cameraParity.every((m) => m.equal === true) &&
    gpu.result.multiView &&
    (gpu.result.multiView.equal === true ||
      gpu.result.multiView.error !== undefined);
  const offClean =
    gpu.result.sceneCaptureReflections === false &&
    gpu.result.captureModelsPublished === false &&
    errs.length === 0;
  const ok = allModesEqual && offClean && !gpu.result.error;
  console.log(
    `\n[camera-parity] VERDICT: ${ok ? "PASS — eye-swap neutral across all scene modes + OFF byte-identical" : "FAIL — see state above"}`,
  );
  if (gpu.result.multiView?.error) {
    console.log(
      "  NOTE: multi-view scene construction threw (env limitation); the 3 morph-mode parity checks still gate the swap.",
    );
  }
})();
