#!/usr/bin/env node
// Probe-khr-meshopt — NEW-UPSTREAM-SYNC-1143 acceptance (Batch: v1.143 merge).
//
// Upstream v1.143 (PR #13553) added KHR_meshopt_compression support:
// `findMeshoptExtension` resolves either EXT_meshopt_compression or the
// KHR ratified variant on a bufferView, and the loader accepts the KHR
// name in extensionsRequired. The fork additionally lazy-loads the
// MeshoptDecoder (dynamic import) rather than paying the static cost.
//
// This probe loads upstream's MeshoptCubeTest fixture (extensionsRequired:
// [KHR_mesh_quantization, KHR_meshopt_compression]) on BOTH backends:
//   1. Asserts Model.fromGltfAsync resolves (KHR name accepted, meshopt
//      buffer views decoded via the lazy decoder path).
//   2. Asserts the model renders visible non-background pixels.
//   3. Zero console/device errors on either backend.
//   4. Cross-backend screenshot mismatch below threshold (parity gate).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-khr-meshopt.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "output",
);
const MODEL_URL =
  "/Specs/Data/Models/glTF-2.0/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf";
const MISMATCH_THRESHOLD_PCT = 12.0; // model AA/edge differences allowed

async function captureBackend(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });

  const diag = await page.evaluate(
    async ({ modelUrl }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const lon = -79.9959;
      const lat = 40.4406;
      const height = 200;

      v.scene.globe.show = false;
      if (v.scene.skyBox) {
        v.scene.skyBox.show = false;
      }
      v.scene.skyAtmosphere.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.backgroundColor = C.Color.BLACK;

      let loadErr = null;
      let model;
      try {
        const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(lon, lat, height),
        );
        model = await C.Model.fromGltfAsync({
          url: modelUrl,
          modelMatrix,
          scale: 20.0,
        });
        v.scene.primitives.add(model);
      } catch (e) {
        loadErr = String(e?.message ?? e);
      }

      let ready = false;
      if (!loadErr) {
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat - 0.0016, height + 60),
          orientation: {
            heading: 0,
            pitch: C.Math.toRadians(-25),
            roll: 0,
          },
        });
        for (let i = 0; i < 900; i++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          if (model?.ready) {
            ready = true;
            break;
          }
        }
        for (let i = 0; i < 40; i++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      }

      // Count non-black pixels on the canvas.
      const canvas = v.scene.canvas;
      const gl2 = document.createElement("canvas");
      gl2.width = canvas.width;
      gl2.height = canvas.height;
      const ctx = gl2.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, gl2.width, gl2.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) {
          lit++;
        }
      }
      return {
        loadErr,
        ready,
        litPixels: lit,
        totalPixels: data.length / 4,
        rendererType: v.scene.context.rendererType ?? "unknown",
      };
    },
    { modelUrl: MODEL_URL },
  );

  const shotPath = path.join(OUT_DIR, `khr-meshopt-${renderer}.png`);
  await page
    .locator("canvas")
    .first()
    .screenshot({ path: shotPath });
  await browser.close();
  return { diag, consoleErrors, shotPath };
}

async function diffScreenshots(pathA, pathB) {
  // Canvas-decode diff — no Node PNG dependency (probe-saved-view pattern).
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  const b64A = fs.readFileSync(pathA).toString("base64");
  const b64B = fs.readFileSync(pathB).toString("base64");
  const result = await page.evaluate(
    async ({ a, b }) => {
      function load(b64) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${b64}`;
        });
      }
      const [imgA, imgB] = await Promise.all([load(a), load(b)]);
      const w = Math.min(imgA.width, imgB.width);
      const h = Math.min(imgA.height, imgB.height);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(imgA, 0, 0);
      const dA = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(imgB, 0, 0);
      const dB = ctx.getImageData(0, 0, w, h).data;
      let mismatch = 0;
      for (let i = 0; i < dA.length; i += 4) {
        const dr = Math.abs(dA[i] - dB[i]);
        const dg = Math.abs(dA[i + 1] - dB[i + 1]);
        const db = Math.abs(dA[i + 2] - dB[i + 2]);
        if (dr > 24 || dg > 24 || db > 24) {
          mismatch++;
        }
      }
      return { mismatch, total: dA.length / 4 };
    },
    { a: b64A, b: b64B },
  );
  await browser.close();
  return (result.mismatch / result.total) * 100;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let pass = true;

  const results = {};
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`\n[probe-khr-meshopt] renderer=${renderer} ...`);
    const { diag, consoleErrors, shotPath } = await captureBackend(renderer);
    results[renderer] = { diag, consoleErrors, shotPath };
    const litPct = (diag.litPixels / diag.totalPixels) * 100;
    console.log(
      `  load=${diag.loadErr ? `FAIL(${diag.loadErr})` : "ok"} ready=${diag.ready} ` +
        `lit=${diag.litPixels}px (${litPct.toFixed(2)}%) ctx=${diag.rendererType} ` +
        `consoleErrors=${consoleErrors.length}`,
    );
    if (diag.loadErr || !diag.ready) {
      console.log(`  FAIL — model did not load/ready on ${renderer}`);
      pass = false;
    }
    if (diag.litPixels < 2000) {
      console.log(`  FAIL — too few lit pixels (${diag.litPixels})`);
      pass = false;
    }
    if (consoleErrors.length > 0) {
      console.log(`  FAIL — console errors:`);
      for (const e of consoleErrors.slice(0, 5)) {
        console.log(`    ${e.slice(0, 200)}`);
      }
      pass = false;
    }
  }

  if (pass) {
    const mismatchPct = await diffScreenshots(
      results.webgl.shotPath,
      results.webgpu.shotPath,
    );
    console.log(
      `\n[probe-khr-meshopt] cross-backend mismatch: ${mismatchPct.toFixed(2)}% ` +
        `(threshold ${MISMATCH_THRESHOLD_PCT}%)`,
    );
    if (mismatchPct > MISMATCH_THRESHOLD_PCT) {
      console.log("  FAIL — parity gate exceeded");
      pass = false;
    }
  }

  console.log(`\n[probe-khr-meshopt] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
