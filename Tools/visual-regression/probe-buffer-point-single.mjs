#!/usr/bin/env node
// Probe (NEW-BUFFERPOINT-WEBGL-SINGLE-VERTEX-DROPOUT) — exercises the WebGL
// single-vertex BufferPointCollection path: one gl.POINTS vertex rendered, then
// moved via a count==1 copyAttributeFromRange sub-data update.
//
// Background: WebGL repacks only the dirty range of a BufferPointCollection via
// VertexArray.copyAttributeFromRange(index, array, vertexOffset, vertexCount).
// For a single-point collection the first frame uploads the whole VA; a later
// position change drives a count==1 sub-data update. WebGPU uploads the whole
// buffer every dirty frame, so any single-vertex range bug would be WebGL-only.
//
// STATUS: the DEFERRED_WORK entry describes a FLAKY/intermittent dropout of the
// lone vertex on this path. It did NOT reproduce in CesiumViewer's standard
// render loop across multiple faithful attempts (this probe passes — the common
// single-point path works). The probe is retained as a regression gate that
// documents the working behavior; if a future scene reproduces the flaky
// dropout deterministically, tighten this probe to capture it before fixing.
//
// Strategy (WebGL only — the regression is WebGL-specific):
//   - One cyan point at LON0, look straight down, render to a repacked state,
//     snapshot (frame A): assert the lone point is visible.
//   - Move the SAME point to LON1 (sub-data update, count==1), render 2 frames,
//     snapshot (frame B): assert the point is STILL visible and moved.
//   - 0 console / validation errors throughout.
//
// Usage: node Tools/visual-regression/probe-buffer-point-single.mjs
// Env:   PROBE_BASE (default http://localhost:8134)
// Out:   Tools/visual-regression/output/buffer-point-single-webgl-{A,B}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

const CYAN_MIN = 60; // a ~22px point quad covers well over this many pixels
const MOVE_MIN = 80; // px of centroid X shift expected between lon0 and lon1

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runWebGL() {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    v.clock.shouldAnimate = false;

    scene.globe.show = false;
    scene.imageryLayers.removeAll();
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = C.Color.BLACK;

    const frame = async (n) => {
      for (let i = 0; i < n; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    const snap = () =>
      new Promise((resolve) => {
        const remove = scene.postRender.addEventListener(() => {
          remove();
          const c = scene.canvas;
          const off = document.createElement("canvas");
          off.width = c.width;
          off.height = c.height;
          const cx = off.getContext("2d");
          cx.drawImage(c, 0, 0);
          resolve({
            data: cx.getImageData(0, 0, c.width, c.height).data,
            w: c.width,
            h: c.height,
            png: off.toDataURL("image/png"),
          });
        });
        scene.render();
      });

    const isCyan = (d, i) => d[i] < 110 && d[i + 1] > 150 && d[i + 2] > 150;
    const stats = (img, pred) => {
      let n = 0;
      let sumX = 0;
      for (let p = 0; p < img.w * img.h; p++) {
        if (pred(img.data, 4 * p)) {
          n++;
          sumX += p % img.w;
        }
      }
      return { count: n, cx: n > 0 ? sumX / n : -1 };
    };

    const LAT = 40.0;
    const LON0 = -75.2;
    const LON1 = -74.8;
    const ALT = 300.0;

    // EXACTLY ONE point in the collection.
    const points = scene.primitives.add(
      new C.BufferPointCollection({ primitiveCountMax: 8 }),
    );
    const cyanMat = new C.BufferPointMaterial({
      color: new C.Color(0.1, 1.0, 1.0, 1.0),
      size: 22,
      outlineWidth: 0,
    });
    // Add with the cyan material in the add() options so the ONLY post-add
    // mutation is setPosition — the documented flaky path is a pure position
    // sub-data update on a lone vertex with no other re-dirtying.
    const movingPoint = points.add({
      position: C.Cartesian3.fromDegrees(LON0, LAT, ALT),
      material: cyanMat,
    });

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        (LON0 + LON1) / 2,
        LAT,
        120000.0,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });

    // Render exactly ONE frame first — the documented note is "even the initial
    // single-point render is flaky", so snapshot the lone vertex at minimal warmup.
    await frame(1);
    const imgA = await snap();
    const cyanA = stats(imgA, isCyan);

    // Sub-data update: move the lone point (count==1 copyAttributeFromRange).
    points.get(0, movingPoint);
    movingPoint.setPosition(C.Cartesian3.fromDegrees(LON1, LAT, ALT));
    await frame(2);
    const imgB = await snap();
    const cyanB = stats(imgB, isCyan);

    return {
      cyanA: cyanA.count,
      cxA: cyanA.cx,
      cyanB: cyanB.count,
      cxB: cyanB.cx,
      pngA: imgA.png,
      pngB: imgB.png,
    };
  });

  await page.close();
  return { ...out, errors };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let ok = true;
const check = (label, pass, detail) => {
  console.log(`  (${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

console.log("== webgl single-point ==");
const r = await runWebGL();
if (r.pngA)
  fs.writeFileSync(
    path.join(OUT_DIR, "buffer-point-single-webgl-A.png"),
    Buffer.from(r.pngA.split(",")[1], "base64"),
  );
if (r.pngB)
  fs.writeFileSync(
    path.join(OUT_DIR, "buffer-point-single-webgl-B.png"),
    Buffer.from(r.pngB.split(",")[1], "base64"),
  );

const moved = Math.abs(r.cxB - r.cxA);
check(
  "single-1",
  r.cyanA >= CYAN_MIN,
  `lone point visible at frame A (before update): cyanA=${r.cyanA}/${CYAN_MIN}`,
);
check(
  "single-2",
  r.cyanB >= CYAN_MIN,
  `lone point STILL visible at frame B (after count==1 sub-data update): cyanB=${r.cyanB}/${CYAN_MIN}`,
);
check(
  "single-3",
  moved >= MOVE_MIN,
  `lone point moved >= ${MOVE_MIN}px: |${r.cxB.toFixed(1)} - ${r.cxA.toFixed(1)}| = ${moved.toFixed(1)}px`,
);
check("single-4", r.errors.length === 0, `console errors: ${r.errors.length}`);
if (r.errors.length)
  for (const e of r.errors.slice(0, 6)) console.log(`    ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
