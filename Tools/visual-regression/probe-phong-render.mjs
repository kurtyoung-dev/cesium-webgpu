#!/usr/bin/env node
// Probe-phong-render — diagnostic: does a lit Phong primitive render at all
// on WebGPU? No clustered lighting involved — pure "is the phong /
// PerInstanceColorAppearance scene-FB path working" check.
// @purpose Bring-up diagnostic: does a lit Phong box render at all on WebGPU (brightness + device errors + scene-FB MRT state dump)
// @status INVESTIGATION
//
// Adds ONE PerInstanceColorAppearance box (flat:false → the `phong`
// shader: normals, no st), frames it, renders, and reports mean brightness
// + device errors + the scene FB MRT state. Black + attachment errors ⇒
// pre-existing rendering issue (independent of clustered lighting).

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT = "Tools/visual-regression/output/phong-render.png";

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

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    scene.globe.show = false;

    const center = C.Cartesian3.fromDegrees(-79.9959, 40.4406, 150);
    const instance = new C.GeometryInstance({
      geometry: C.BoxGeometry.fromDimensions({
        vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
        dimensions: new C.Cartesian3(40, 40, 40),
      }),
      modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
      attributes: {
        color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.ORANGE),
      },
    });
    const prim = scene.primitives.add(
      new C.Primitive({
        geometryInstances: instance,
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
    const bs = new C.BoundingSphere(center, 35.0);
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(0, C.Math.toRadians(-30), bs.radius * 3),
    );
    for (let i = 0; i < 40; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    const ctx = scene.context;
    return {
      primReady: prim.ready,
      // Surface scene-FB MRT state if exposed.
      sceneFbMrt:
        ctx._sceneFBMrtMode ??
        ctx.sceneFBMrtMode ??
        ctx._sceneColorFormat ??
        "unknown",
      scenePipelineFormat: ctx.scenePipelineFormat ?? "unknown",
    };
  });
  await page.screenshot({ path: OUT, fullPage: false });
  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  // Decode + mean brightness over center.
  const db = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await db.newPage();
  await dp.setContent("<html><body></body></html>");
  const b64 = fs.readFileSync(OUT).toString("base64");
  const mean = await dp.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const x0 = (c.width * 0.35) | 0,
      x1 = (c.width * 0.65) | 0,
      y0 = (c.height * 0.35) | 0,
      y1 = (c.height * 0.65) | 0;
    let s = 0,
      n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * c.width + x) * 4;
        s += d[i] + d[i + 1] + d[i + 2];
        n++;
      }
    return s / n;
  }, b64);
  await db.close();

  console.log("[probe-phong-render] result:");
  console.log(`  primitive.ready: ${result.primReady}`);
  console.log(`  scenePipelineFormat: ${result.scenePipelineFormat}`);
  console.log(`  sceneFB MRT/color hint: ${JSON.stringify(result.sceneFbMrt)}`);
  console.log(`  mean RGB-sum (center, box region): ${mean.toFixed(2)}`);
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    const seen = new Set();
    errs.slice(0, 12).forEach((e) => {
      const k = (e ?? "").slice(0, 130);
      if (seen.has(k)) return;
      seen.add(k);
      console.log(`  - ${(e ?? "").slice(0, 320)}`);
    });
  }
  const rendered = mean > 30;
  console.log(
    `\n${rendered && errs.length === 0 ? "RENDERS OK" : "BROKEN"}: phong primitive ${rendered ? "visible" : "BLACK"}, ${errs.length} device errors`,
  );
  process.exit(0);
})();
