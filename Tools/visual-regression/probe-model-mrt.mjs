#!/usr/bin/env node
// Probe-model-mrt — Slice 5c-B Batch 119 verification.
// @purpose Model G-buffer verification: 4-cell ao-x-deferred matrix on Milk Truck; perturbed normals + roughness in slot 1 widen the AO signal.
// @status ACTIVE
//
// Loads a glTF model (Cesium Milk Truck — has normal map, base color
// texture, metallic-roughness) and runs the 4-cell ao×deferred matrix.
//
// Why Models are the highest-ROI primitive for the G-buffer:
//   - When FLAG_HAS_NORMAL_TEXTURE is set, the Model FS perturbs the
//     interpolated vertex normal via perturbNormal() using the
//     tangent-space normal map. The result is fundamentally divergent
//     from the depth-derived approximation that the AO consumer
//     fallback computes via central differences. The Cesium Milk
//     Truck's normal map gives the textured panels their bump shading.
//   - Real material roughness (metallicRoughnessTexture .g × material
//     .roughnessFactor) lands in slot 1 .w. Future SSR will read this
//     for proper specular response.
//
// Expected post-Batch-119: C-vs-D Slice 4 signal substantially wider
// than the 0.094% the Ellipsoid probe measured (smooth analytical
// normals vs depth-derived; the Model's normal-map perturbations diverge
// much further from depth-reconstruction across textured surface area).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// View positioned with a CesiumMilkTruck-sized model dominating the
// frame. Camera ~8m above terrain (~248m ellipsoid), truck at 250m
// ellipsoid (so truck is just above ground). Truck is ~4m long → at
// 8m camera height looking down it fills ~50% of viewport diameter.
const VIEW = { lon: -79.9959, lat: 40.4406, height: 258.0 };
const MODEL_URL = "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function capture(label, { ao, deferred }) {
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({
      t: "pageerror",
      text: e.message,
      stack: e.stack ?? null,
    }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "no message" });
    };
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, ao, deferred, modelUrl }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.deferredLighting = deferred;
      v.scene.globe.enableLighting = true;

      const aoStage = v.scene.postProcessStages?.ambientOcclusion;
      if (aoStage) {
        aoStage.enabled = ao;
        if (aoStage.uniforms) {
          aoStage.uniforms.intensity = 6.0;
          aoStage.uniforms.lengthCap = 0.4;
        }
      }

      // Place model on terrain at ~250m ellipsoid altitude (Pittsburgh
      // terrain). Truck is ~4m long, camera at view.height looking
      // down → truck dominates ~30% of viewport.
      const modelPos = C.Cartesian3.fromDegrees(view.lon, view.lat, 250);
      const headingPitchRoll = new C.HeadingPitchRoll(0, 0, 0);
      const orientation = C.Transforms.headingPitchRollQuaternion(
        modelPos,
        headingPitchRoll,
      );
      const entity = v.entities.add({
        position: modelPos,
        orientation,
        model: { uri: modelUrl, scale: 1.0, minimumPixelSize: 0 },
      });

      // Camera looking down at the model from slightly above.
      // Pitch -45° so we see the side of the truck (silhouette where
      // normal maps would diverge most from depth-derived).
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-45),
        },
      });

      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 600) break;
      }

      // Wait extra for model load — getModel returns a promise.
      await new Promise((r) => setTimeout(r, 1500));
      for (let i = 0; i < 200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = v.canvas;
      let centerPixel;
      try {
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const data = ctx2d.getImageData(cx, cy, 1, 1).data;
        centerPixel = { r: data[0], g: data[1], b: data[2], a: data[3] };
      } catch (e) {
        centerPixel = { error: String(e?.message ?? e) };
      }

      return {
        ao_requested: ao,
        deferred_requested: deferred,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
        centerPixel,
        entityCount: v.entities.values.length,
        modelReady: !!(entity?.model && entity.computeModelMatrix),
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      ao,
      deferred,
      modelUrl: MODEL_URL,
    },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `model-mrt-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  return { label, out, diagnostics, deviceErrors, messages };
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
      let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "[probe-model-mrt] capturing 4-cell matrix with milk truck model",
  );

  const cells = [];
  cells.push(await capture("a-ao-off-def-off", { ao: false, deferred: false }));
  cells.push(await capture("b-ao-off-def-on", { ao: false, deferred: true }));
  cells.push(await capture("c-ao-on-def-off", { ao: true, deferred: false }));
  cells.push(await capture("d-ao-on-def-on", { ao: true, deferred: true }));

  console.log("\n[probe-model-mrt] per-cell summary:");
  for (const cell of cells) {
    console.log(`\n  [${cell.label}]`);
    console.log(
      `    canvas center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
        cell.diagnostics.centerPixel?.g ?? "?"
      }, ${cell.diagnostics.centerPixel?.b ?? "?"})`,
    );
    console.log(
      `    def=${cell.diagnostics.sceneDeferredLighting} envFlag=${cell.diagnostics.env_useDeferredLighting} entities=${cell.diagnostics.entityCount}`,
    );
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 2)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
    const pageErrors = (cell.messages ?? []).filter((m) => m.t === "pageerror");
    const consoleErrs = (cell.messages ?? []).filter((m) => m.t === "error");
    if (pageErrors.length || consoleErrs.length) {
      console.log(
        `    ✗ ${pageErrors.length} pageerrors, ${consoleErrs.length} console.error events`,
      );
      pageErrors.slice(0, 1).forEach((e) => {
        console.log(`      pageerror: ${(e.text ?? "").slice(0, 200)}`);
      });
      consoleErrs.slice(0, 2).forEach((e) => {
        const firstLine = (e.text ?? "").split("\n")[0];
        console.log(`      console.error: ${firstLine.slice(0, 200)}`);
      });
    }
  }

  console.log("\n[probe-model-mrt] diffs:");
  const aoDiff = await diffPngs(cells[0].out, cells[2].out);
  console.log(
    `  [A vs C] AO engagement: mismatch=${aoDiff.mismatchPct.toFixed(3)}% meanDelta=${aoDiff.meanDelta.toFixed(3)}`,
  );
  const slice4Diff = await diffPngs(cells[2].out, cells[3].out);
  console.log(
    `  [C vs D] Slice 4 signal (depth-fallback vs MRT G-buffer): ` +
      `mismatch=${slice4Diff.mismatchPct.toFixed(3)}% meanDelta=${slice4Diff.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    Ellipsoid baseline (Batch 118): 0.094% — analytical sphere normals at silhouette`,
  );
  console.log(
    `    Model with normal map (Batch 119): expected substantially wider due to per-fragment normal-map divergence from depth`,
  );

  const reportPath = path.join(OUT_DIR, "model-mrt-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        modelUrl: MODEL_URL,
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        diffs: { aoEngagement: aoDiff, slice4Signal: slice4Diff },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
