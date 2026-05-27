#!/usr/bin/env node
// Probe-clustered-phong — Slice 5d Batch 157 verification.
//
// Two-in-one check, both enabled by the Batch 156 MSAA fix + the Batch 157
// "decode before shader-select" fix:
//   1. A flat:false PerInstanceColorAppearance box now routes to the LIT
//      `phong` shader (was the unlit `basic` before Batch 157).
//   2. The Forward+ clustered-lighting consumer wired into the Phong
//      shaders (Batch 156) produces a visible per-pixel contribution.
//
// Captures baseline (clustered off) vs a scene-PointLight frame (clustered
// on); a brightness delta proves BOTH the phong routing + clustered eval
// (basic is unlit → would give exactly 0). PASS = delta + 0 device errors.

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_OFF = "Tools/visual-regression/output/clustered-phong-off.png";
const OUT_ON = "Tools/visual-regression/output/clustered-phong-on.png";

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
    if (dev)
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const setup = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    const scene = v.scene;
    scene.globe.show = false;
    const center = C.Cartesian3.fromDegrees(-79.9959, 40.4406, 150);
    window.__center = center;
    const prim = scene.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: C.BoxGeometry.fromDimensions({
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions: new C.Cartesian3(40, 40, 40),
          }),
          modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              C.Color.fromBytes(150, 150, 150, 255),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          flat: false,
          translucent: false,
          closed: true,
        }),
        asynchronous: false,
      }),
    );
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
      new C.HeadingPitchRange(0, C.Math.toRadians(-30), bs.radius * 3),
    );
    scene.clusteredLightingEnabled = false;
    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { primReady: true };
  });
  if (setup?.earlyExitErr) {
    console.log("[probe-clustered-phong] EARLY-EXIT:", setup.earlyExitErr);
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
    scene.lights.add(
      new C.PointLight({
        position: C.Cartesian3.add(
          bs.center,
          C.Cartesian3.multiplyByScalar(camDir, bs.radius * 1.5, new C.Cartesian3()),
          new C.Cartesian3(),
        ),
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
    const d = scene._alternateSceneRenderer?._clusteredLightingDispatcher ?? null;
    return {
      lastActive: d?.lastActiveLightCount ?? -1,
      clusteredActive: scene.context._clusteredLightingActive === true,
    };
  });
  await page.screenshot({ path: OUT_ON, fullPage: false });
  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  const db = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await db.newPage();
  await dp.setContent("<html><body></body></html>");
  const offB64 = fs.readFileSync(OUT_OFF).toString("base64");
  const onB64 = fs.readFileSync(OUT_ON).toString("base64");
  const stats = await dp.evaluate(
    async ({ offB64, onB64 }) => {
      const dec = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const off = await dec(offB64);
      const on = await dec(onB64);
      const x0 = (off.w * 0.3) | 0,
        x1 = (off.w * 0.7) | 0,
        y0 = (off.h * 0.3) | 0,
        y1 = (off.h * 0.7) | 0;
      let so = 0, sn = 0, n = 0, ch = 0, md = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * off.w + x) * 4;
          const a = off.data[i] + off.data[i + 1] + off.data[i + 2];
          const b = on.data[i] + on.data[i + 1] + on.data[i + 2];
          so += a; sn += b; n++;
          const dd = Math.abs(b - a);
          if (dd > 5) ch++;
          if (dd > md) md = dd;
        }
      return { meanOff: so / n, meanOn: sn / n, delta: (sn - so) / n, changedPx: ch, maxDelta: md, n };
    },
    { offB64, onB64 },
  );
  await db.close();

  console.log("[probe-clustered-phong] result:");
  console.log(`  lastActiveLightCount: ${phase2.lastActive}`);
  console.log(`  clusteredLightingActive: ${phase2.clusteredActive}`);
  console.log(`  mean RGB-sum OFF: ${stats.meanOff.toFixed(2)}`);
  console.log(`  mean RGB-sum ON:  ${stats.meanOn.toFixed(2)}`);
  console.log(`  delta (on − off): ${stats.delta.toFixed(2)}`);
  console.log(`  changed pixels (Δ>5): ${stats.changedPx} / ${stats.n}`);
  console.log(`  max single-pixel delta: ${stats.maxDelta}`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    const seen = new Set();
    errs.slice(0, 10).forEach((e) => {
      const k = (e ?? "").slice(0, 120);
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`  - ${(e ?? "").slice(0, 900)}`);
    });
  }
  let pass = true;
  if (phase2.lastActive < 1) { console.log(`FAIL: lastActiveLightCount = ${phase2.lastActive}`); pass = false; }
  if (stats.changedPx < 50) { console.log(`FAIL: only ${stats.changedPx} px changed (max ${stats.maxDelta}) — phong likely still routing to unlit basic`); pass = false; }
  if (errs.length) { console.log(`FAIL: ${errs.length} device errors`); pass = false; }
  if (pass) console.log("\nPASS: PerInstanceColorAppearance routes to lit phong + clustered lighting visible + 0 device errors");
  process.exit(pass ? 0 : 1);
})();
