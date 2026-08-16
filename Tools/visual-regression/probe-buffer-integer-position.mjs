#!/usr/bin/env node
// Probe (C4-BUFFER-POSITION-INT-NORMALIZED / Q12) — render-diff acceptance for
// integer + positionNormalized position decode on the WebGPU Buffer* renderers.
// @purpose Render-diff acceptance for integer + positionNormalized decode on WebGPU Buffer*: normalized-SHORT cross coincides with DOUBLE control.
// @status ACTIVE
//
// Background: a BufferPointCollection can store positions as an integer
// ComponentDatatype (BYTE/UNSIGNED_BYTE/SHORT/UNSIGNED_SHORT/INT/UNSIGNED_INT)
// with positionNormalized:true, meaning the full integer range maps to [-1,1]
// (signed) / [0,1] (unsigned) — exactly the WebGL vertex-attribute `normalize`
// convention (Core/AttributeCompression.dequantize). The WebGPU renderers have
// no integer vertex path; they always RTE-encode the model-space position into
// positionHigh/positionLow. Before the fix they encoded the RAW integer value
// (e.g. 32767) as a Cartesian coordinate, so a normalized-SHORT point landed
// hundreds of km from where WebGL (GPU-normalized to 1.0) drew it. The fix
// dequantizes in the encode path with the same divisor + (-1) clamp.
//
// Design: each capture renders EXACTLY ONE collection (no overlap/occlusion).
// Four captures = {WebGL,WebGPU} × {int-normalized SHORT, DOUBLE control}, all
// at the SAME model-space cross (±1,0,0)/(0,±1,0) under a shared modelMatrix
// (ENU @ -75,40 scaled ×300 km → a visible ±300 km cross). The SHORT store uses
// raw ints ±32767 / -32768 (the -32768 exercises the (-1) clamp). Assertions:
//   • per backend: int-normalized centroid ≈ DOUBLE-control centroid
//   • cross-backend: WebGL int centroid ≈ WebGPU int centroid  (the parity fix)
//   • cross-backend: WebGL double ≈ WebGPU double  (harness/RTE sanity control)
//
// Usage: node Tools/visual-regression/probe-buffer-integer-position.mjs
// Env:   PROBE_BASE (default http://localhost:8080)
// Out:   Tools/visual-regression/output/buffer-int-position-{webgl,webgpu}-{int,double}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const COUNT_MIN = 30; // 4 points × ~18px quads
const COINCIDE_MAX = 5.0; // px: int-normalized vs double centroid
const CROSS_MAX = 5.0; // px: WebGL vs WebGPU

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// mode: "int" (normalized SHORT) | "double" (plain DOUBLE control)
async function runCase(renderer, mode) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(async (mode) => {
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

    const {
      BufferPointCollection,
      BufferPointMaterial,
      ComponentDatatype,
      Cartesian3,
      Color,
      Matrix4,
      Transforms,
    } = C;

    const center = Cartesian3.fromDegrees(-75.0, 40.0, 0.0);
    const model = Matrix4.multiply(
      Transforms.eastNorthUpToFixedFrame(center),
      Matrix4.fromUniformScale(300000.0),
      new Matrix4(),
    );

    const corners = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ];
    const S_POS = 32767;
    const S_NEG = -32768; // -32768/32767 = -1.00003 → clamp to -1

    const opts =
      mode === "int"
        ? {
            primitiveCountMax: 8,
            positionDatatype: ComponentDatatype.SHORT,
            positionNormalized: true,
            modelMatrix: model,
          }
        : { primitiveCountMax: 8, modelMatrix: model };

    const coll = scene.primitives.add(new BufferPointCollection(opts));
    const mat = new BufferPointMaterial({
      color: new Color(1.0, 0.9, 0.1, 1.0), // yellow — high R+G, low B
      size: 18,
      outlineWidth: 0,
    });
    for (const [x, y, z] of corners) {
      const pos =
        mode === "int"
          ? new Cartesian3(
              x > 0 ? S_POS : x < 0 ? S_NEG : 0,
              y > 0 ? S_POS : y < 0 ? S_NEG : 0,
              z > 0 ? S_POS : z < 0 ? S_NEG : 0,
            )
          : new Cartesian3(x, y, z);
      coll.add({ position: pos, material: mat });
    }

    v.camera.setView({
      destination: Cartesian3.fromDegrees(-75.0, 40.0, 2400000.0),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });

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

    await frame(3);
    const img = await snap();

    const isYellow = (d, i) => d[i] > 150 && d[i + 1] > 130 && d[i + 2] < 100;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let minX = 1e9;
    let maxX = -1e9;
    let minY = 1e9;
    let maxY = -1e9;
    for (let p = 0; p < img.w * img.h; p++) {
      if (isYellow(img.data, 4 * p)) {
        const px = p % img.w;
        const py = Math.floor(p / img.w);
        n++;
        sx += px;
        sy += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    return {
      count: n,
      cx: n > 0 ? sx / n : -1,
      cy: n > 0 ? sy / n : -1,
      bbox: n > 0 ? { w: maxX - minX, h: maxY - minY } : null,
      png: img.png,
    };
  }, mode);

  await page.close();
  return { ...out, errors };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

let ok = true;
const check = (label, pass, detail) => {
  console.log(`  (${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};
const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);

const cases = {};
for (const renderer of ["webgl", "webgpu"]) {
  for (const mode of ["int", "double"]) {
    const r = await runCase(renderer, mode);
    cases[`${renderer}-${mode}`] = r;
    if (r.png)
      fs.writeFileSync(
        path.join(OUT_DIR, `buffer-int-position-${renderer}-${mode}.png`),
        Buffer.from(r.png.split(",")[1], "base64"),
      );
    console.log(
      `${renderer}/${mode}: count=${r.count} centroid=(${r.cx.toFixed(1)},${r.cy.toFixed(1)}) bbox=${r.bbox ? r.bbox.w + "x" + r.bbox.h : "none"} errs=${r.errors.length}`,
    );
  }
}

const glI = cases["webgl-int"];
const glD = cases["webgl-double"];
const gpI = cases["webgpu-int"];
const gpD = cases["webgpu-double"];

check(
  "vis-webgl-int",
  glI.count >= COUNT_MIN,
  `WebGL int-normalized visible: ${glI.count} (>=${COUNT_MIN})`,
);
check(
  "vis-webgl-double",
  glD.count >= COUNT_MIN,
  `WebGL double control visible: ${glD.count} (>=${COUNT_MIN})`,
);
check(
  "vis-webgpu-int",
  gpI.count >= COUNT_MIN,
  `WebGPU int-normalized visible: ${gpI.count} (>=${COUNT_MIN})`,
);
check(
  "vis-webgpu-double",
  gpD.count >= COUNT_MIN,
  `WebGPU double control visible: ${gpD.count} (>=${COUNT_MIN})`,
);

if (glI.count > 0 && glD.count > 0)
  check(
    "coincide-webgl",
    dist(glI, glD) <= COINCIDE_MAX,
    `WebGL int vs double centroid ${dist(glI, glD).toFixed(2)}px (<=${COINCIDE_MAX})`,
  );
if (gpI.count > 0 && gpD.count > 0)
  check(
    "coincide-webgpu",
    dist(gpI, gpD) <= COINCIDE_MAX,
    `WebGPU int vs double centroid ${dist(gpI, gpD).toFixed(2)}px (<=${COINCIDE_MAX}) — THE FIX`,
  );
if (glI.count > 0 && gpI.count > 0)
  check(
    "cross-int",
    dist(glI, gpI) <= CROSS_MAX,
    `WebGL↔WebGPU int-normalized centroid ${dist(glI, gpI).toFixed(2)}px (<=${CROSS_MAX})`,
  );
if (glD.count > 0 && gpD.count > 0)
  check(
    "cross-double",
    dist(glD, gpD) <= CROSS_MAX,
    `WebGL↔WebGPU double centroid ${dist(glD, gpD).toFixed(2)}px (<=${CROSS_MAX})`,
  );

const allErrs = Object.values(cases).reduce((a, c) => a + c.errors.length, 0);
check("errs", allErrs === 0, `console errors total: ${allErrs}`);
for (const [k, c] of Object.entries(cases))
  for (const e of c.errors.slice(0, 4))
    console.log(`    ${k} ERR: ${e.slice(0, 160)}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
