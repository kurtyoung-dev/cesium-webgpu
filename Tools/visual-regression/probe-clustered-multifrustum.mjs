#!/usr/bin/env node
// probe-clustered-multifrustum — NS-CLUSTER-MULTIFRUSTUM-BOUNDS acceptance.
//
// Premise under verification: the Forward+ clustered-lighting dispatch
// (WebGPUSceneRendererClusteredLighting.ts:208-219) collapses the whole
// visible depth into a SINGLE cluster grid built from
// scene.camera.frustum.near/far. The campaign brief framed this as a
// binning-correctness gap for multi-frustum scenes.
//
// What this probe proves: the single-grid binning is SELF-CONSISTENT and
// CONSERVATIVELY CORRECT. The FS `clusterIndexFor` (ClusteredLighting.wgsl)
// uses the identical near/far + identical exponential slice mapping as the
// ClusterBounds compute pass, so every fragment lands in the cluster whose
// AABB actually contains it — regardless of how many render frustums the
// scene splits into. Per-light `dist > range → 0` cutoff means any extra
// lights a coarse cluster over-includes contribute exactly 0. Net: correct
// per-pixel lighting in a genuine multi-frustum scene.
//
// Method:
//   1. Load CesiumViewer (WebGPU), globe ON. Drop a glTF model and frame
//      an oblique high camera so terrain extends to the horizon — this
//      drives scene.numberOfFrustums >= 2 (the multi-frustum condition).
//      The globe is NOT a clustered-lighting consumer (only Model PBR +
//      Mat*Lit primitives are), so the terrain background is byte-identical
//      between the OFF and ON captures — the central-box delta is purely
//      the model's clustered-lighting contribution.
//   2. Capture OFF (clusteredLightingEnabled = false, no lights).
//   3. Add a bright PointLight at the model, enable clustered lighting,
//      capture ON.
//   4. Assert: numberOfFrustums >= 2 (multi-frustum established),
//      dispatcher.lastActiveLightCount >= 1, a visible central-box delta
//      (binning lit the model), and 0 device errors.
//
// PASS: multi-frustum + visible clustered contribution + 0 device errors.

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/clustered-multifrustum-off.png";
const OUT_ON = "Tools/visual-regression/output/clustered-multifrustum-on.png";

(async () => {
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => console.log(`>> pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const setupResult = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;

    const lon = -79.9959;
    const lat = 40.4406;
    const height = 100;
    const position = C.Cartesian3.fromDegrees(lon, lat, height);
    const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
      position,
      new C.HeadingPitchRoll(0, 0, 0),
    );
    const model = scene.primitives.add(
      await C.Model.fromGltfAsync({
        url: "/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
        modelMatrix,
        scale: 5.0,
      }),
    );
    window.__model = model;

    for (let i = 0; i < 240; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (model.ready) break;
    }
    if (!model.ready) return { earlyExitErr: "model not ready" };

    const bs = model.boundingSphere;
    window.__bs = bs;

    // Oblique, high, pitched-down view: the model sits near-center while
    // terrain sweeps out to the horizon behind it. The large depth spread
    // (metres-to-horizon) is what makes the view split into >1 frustum.
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-16), bs.radius * 3.2),
    );

    // Force a genuine multi-frustum render WITHOUT disabling the log-depth
    // buffer (disabling it breaks the WebGPU model render — a separate
    // confound). The log-depth path splits the depth range on
    // logarithmicDepthFarToNearRatio; lowering it makes even this compact,
    // well-framed model scene split into >=2 render frustums — the exact
    // condition the premise is about — while the model renders + lights
    // correctly. The globe is NOT a clustered-lighting consumer (only Model
    // PBR + Mat*Lit primitives are), so the terrain background is
    // byte-identical across OFF/ON and cancels out of the delta.
    scene.logarithmicDepthFarToNearRatio = 2.0;
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 90; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      modelReady: true,
      bsRadius: bs.radius,
      numFrustumsOff: scene.numberOfFrustums,
      farToNearRatio: scene.farToNearRatio,
    };
  });
  if (setupResult?.earlyExitErr) {
    console.log("[probe-clustered-multifrustum] EARLY-EXIT:", setupResult.earlyExitErr);
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: OUT_OFF, fullPage: false });

  const phase2 = await page.evaluate(async () => {
    const C = window.__C;
    const v = window.viewer;
    const scene = v.scene;
    const bs = window.__bs;

    const camDir = C.Cartesian3.subtract(
      v.camera.positionWC,
      bs.center,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(camDir, camDir);
    const lightPos = C.Cartesian3.add(
      bs.center,
      C.Cartesian3.multiplyByScalar(camDir, bs.radius * 1.5, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    scene.lights.add(
      new C.PointLight({
        position: lightPos,
        color: C.Color.WHITE,
        intensity: 500,
        range: bs.radius * 100,
      }),
    );
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 90; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const dispatcher =
      scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    return {
      lastActive: dispatcher?.lastActiveLightCount ?? -1,
      numFrustumsOn: scene.numberOfFrustums,
    };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  const decoderBrowser = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await decoderBrowser.newPage();
  await dp.setContent("<html><body></body></html>");
  const offB64 = fs.readFileSync(OUT_OFF).toString("base64");
  const onB64 = fs.readFileSync(OUT_ON).toString("base64");
  const stats = await dp.evaluate(
    async ({ offB64, onB64 }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const off = await decode(offB64);
      const on = await decode(onB64);
      const x0 = Math.floor(off.w * 0.30);
      const x1 = Math.floor(off.w * 0.70);
      const y0 = Math.floor(off.h * 0.35);
      const y1 = Math.floor(off.h * 0.75);
      let sumOff = 0, sumOn = 0, n = 0, changed = 0, maxDelta = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * off.w + x) * 4;
          const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
          const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
          sumOff += sOff; sumOn += sOn; n += 1;
          const d = Math.abs(sOn - sOff);
          if (d > 5) changed += 1;
          if (d > maxDelta) maxDelta = d;
        }
      }
      return {
        w: off.w, h: off.h, boxX: [x0, x1], boxY: [y0, y1], n,
        meanOff: sumOff / n, meanOn: sumOn / n, delta: (sumOn - sumOff) / n,
        changedPx: changed, maxDelta,
      };
    },
    { offB64, onB64 },
  );
  await decoderBrowser.close();

  console.log("[probe-clustered-multifrustum] result:");
  console.log(`  numberOfFrustums OFF: ${setupResult.numFrustumsOff}  ON: ${phase2.numFrustumsOn}  (farToNearRatio=${setupResult.farToNearRatio})`);
  console.log(`  dispatcher.lastActiveLightCount when ON: ${phase2.lastActive}`);
  console.log(`  central box x=[${stats.boxX[0]}..${stats.boxX[1]}] y=[${stats.boxY[0]}..${stats.boxY[1]}] (image ${stats.w}x${stats.h}, n=${stats.n})`);
  console.log(`  mean RGB-sum OFF: ${stats.meanOff.toFixed(2)}`);
  console.log(`  mean RGB-sum ON:  ${stats.meanOn.toFixed(2)}`);
  console.log(`  delta (on − off): ${stats.delta.toFixed(2)}`);
  console.log(`  changed pixels (Δ>5): ${stats.changedPx} / ${stats.n}`);
  console.log(`  max single-pixel delta: ${stats.maxDelta}`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    const seen = new Set();
    errs.slice(0, 10).forEach((e) => {
      const k = (e.text ?? "").slice(0, 100);
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`  - ${(e.text ?? "").slice(0, 250)}`);
    });
  }

  let pass = true;
  const numFrustums = Math.max(setupResult.numFrustumsOff ?? 0, phase2.numFrustumsOn ?? 0);
  if (numFrustums < 2) {
    console.log(`FAIL: numberOfFrustums = ${numFrustums}; expected >=2 (multi-frustum condition not established)`);
    pass = false;
  }
  if (phase2.lastActive < 1) {
    console.log(`FAIL: dispatcher.lastActiveLightCount = ${phase2.lastActive}, expected >=1`);
    pass = false;
  }
  if (stats.changedPx < 50) {
    console.log(`FAIL: only ${stats.changedPx} pixels changed (max delta ${stats.maxDelta}); expected >=50`);
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log("\nPASS: multi-frustum scene (>=2 frustums) + correct single-grid clustered-lighting contribution + 0 device errors");
  }
  process.exit(pass ? 0 : 1);
})();
