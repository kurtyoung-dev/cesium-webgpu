#!/usr/bin/env node
// Probe-clustered-litmat — Slice 5d Batch 154 verification.
// @purpose Clustered consumer on the primitive Mat*Lit path: lit MaterialAppearance primitive brightens under a PointLight when ON.
// @status ACTIVE
//
// Confirms the Forward+ clustered-lighting consumer works on the primitive
// "Mat*Lit" path (material appearance with lighting), the same way
// probe-clustered-visible.mjs verifies the glTF Model PBR path.
//
// Method:
//   1. Add a lit MaterialAppearance primitive (Color material, flat:false →
//      the `matColorLit` shader, effects BGL at @group(2)).
//   2. Frame the camera, disable the globe, capture baseline (clustered off).
//   3. Add a bright PointLight close in front, enable clustered, re-capture.
//   4. Decode both screenshots, assert a brightness delta over the primitive.
//
// PASS: 0 device errors + ON brighter than OFF by ≥ a threshold over a
// meaningful pixel count (a no-op consumer / wrong group would give 0).

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/clustered-litmat-off.png";
const OUT_ON = "Tools/visual-regression/output/clustered-litmat-on.png";

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

  const setup = await page.evaluate(async () => {
    const mod = await import("/Build/CesiumUnminified/index.js");
    const C = mod;
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;

    const lon = -79.9959;
    const lat = 40.4406;
    const height = 150;
    const center = C.Cartesian3.fromDegrees(lon, lat, height);
    window.__center = center;

    // Lit material primitive: a box with a Color MaterialAppearance,
    // flat:false → the `matColorLit` shader (effects BGL at @group(2)).
    // Keep the box small so the light (placed at ~1.5×radius) stays in
    // the same close/bright distance regime the Model PBR probe uses —
    // a large box pushes the light far enough that 1/dist² falloff drops
    // the contribution below the Δ>5 detection threshold.
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(center);
    const dimensions = new C.Cartesian3(40.0, 40.0, 40.0);
    // Use a vertex format WITH normals — the matColorLit shader is only
    // selected when `hasNormals && !flat` (selectMaterialShader's
    // `useLighting`). MaterialSupport.BASIC lacks normals and would fall
    // back to matColorFlat (unlit), where clustered lighting never applies.
    const boxGeom = C.BoxGeometry.fromDimensions({
      vertexFormat: C.MaterialAppearance.MaterialSupport.ALL.vertexFormat,
      dimensions,
    });
    const prim = scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: boxGeom,
          modelMatrix,
        }),
        appearance: new C.MaterialAppearance({
          material: C.Material.fromType("Color", {
            color: C.Color.fromBytes(180, 180, 180, 255),
          }),
          flat: false,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );
    window.__prim = prim;

    for (let i = 0; i < 120; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (prim.ready) break;
    }
    if (!prim.ready) return { earlyExitErr: "primitive not ready" };

    const bs = new C.BoundingSphere(center, 35.0);
    window.__bs = bs;
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-30), bs.radius * 3),
    );
    scene.globe.show = false;

    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { primReady: true };
  });
  if (setup?.earlyExitErr) {
    console.log("[probe-clustered-litmat] EARLY-EXIT:", setup.earlyExitErr);
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: OUT_OFF, fullPage: false });

  const phase2 = await page.evaluate(async () => {
    const C = window.__C;
    const v = window.viewer;
    const scene = v.scene;
    const bs = window.__bs;

    // Light close in front of the box, on the camera side.
    const camDir = C.Cartesian3.subtract(
      v.camera.positionWC,
      bs.center,
      new C.Cartesian3(),
    );
    C.Cartesian3.normalize(camDir, camDir);
    const lightPos = C.Cartesian3.add(
      bs.center,
      C.Cartesian3.multiplyByScalar(
        camDir,
        bs.radius * 1.5,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    // High intensity: the matte box (F0=0.04, roughness=0.5, no specular
    // punch) is a harder target than the glTF model probe — a point light
    // a couple box-radii away delivers a weak diffuse term after 1/dist²
    // falloff. The contribution scales linearly with intensity (verified:
    // ~40× intensity → ~40× pixel delta), so a large value cleanly clears
    // the Δ>5 detection threshold. probe-clustered-visible.mjs covers the
    // realistic-intensity behavior on the Model PBR path.
    scene.lights.add(
      new C.PointLight({
        position: lightPos,
        color: C.Color.WHITE,
        intensity: 20000,
        range: bs.radius * 100,
      }),
    );
    scene.clusteredLightingEnabled = true;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const dispatcher =
      scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    return {
      lastActive: dispatcher?.lastActiveLightCount ?? -1,
      clusteredActive: scene.context._clusteredLightingActive === true,
    };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  const decoderBrowser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });
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
        return {
          w: c.width,
          h: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      };
      const off = await decode(offB64);
      const on = await decode(onB64);
      const x0 = Math.floor(off.w * 0.3);
      const x1 = Math.floor(off.w * 0.7);
      const y0 = Math.floor(off.h * 0.3);
      const y1 = Math.floor(off.h * 0.7);
      let sumOff = 0,
        sumOn = 0,
        n = 0,
        changed = 0,
        maxDelta = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * off.w + x) * 4;
          const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
          const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
          sumOff += sOff;
          sumOn += sOn;
          n += 1;
          const d = Math.abs(sOn - sOff);
          if (d > 5) changed += 1;
          if (d > maxDelta) maxDelta = d;
        }
      }
      return {
        w: off.w,
        h: off.h,
        n,
        meanOff: sumOff / n,
        meanOn: sumOn / n,
        delta: (sumOn - sumOff) / n,
        changedPx: changed,
        maxDelta,
      };
    },
    { offB64, onB64 },
  );
  await decoderBrowser.close();

  console.log("[probe-clustered-litmat] result:");
  console.log(
    `  dispatcher.lastActiveLightCount when ON: ${phase2.lastActive}`,
  );
  console.log(`  context._clusteredLightingActive: ${phase2.clusteredActive}`);
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
  if (phase2.lastActive < 1) {
    console.log(
      `FAIL: lastActiveLightCount = ${phase2.lastActive}, expected ≥1`,
    );
    pass = false;
  }
  if (stats.changedPx < 50) {
    console.log(
      `FAIL: only ${stats.changedPx} pixels changed (max ${stats.maxDelta}); expected ≥50`,
    );
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`FAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log(
      "\nPASS: visible clustered lighting on primitive Mat*Lit + 0 device errors",
    );
  }
  process.exit(pass ? 0 : 1);
})();
