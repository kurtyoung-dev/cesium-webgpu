#!/usr/bin/env node
// Probe (NEW-CLOUD-REBUILD-DIRTY-GATE verify): WebGPUCloudRenderer's rebuild
// gate was count-only (cloudCount !== lastCloudCount), so per-cloud property
// edits (position/scale/brightness/color) never re-uploaded the instance
// buffer — edited clouds rendered stale forever. After the fix the gate also
// reads the collection's dirty state (_cloudsToUpdateIndex > 0 /
// _createVertexArray) BEFORE the Batch-228 _consumeDirtyState() call clears
// it.
// @purpose Regression: per-cloud property edits re-upload the billboard-cloud instance buffer within 2 frames, then settle with no further rebuilds
// @status ACTIVE
//
// Assertions:
//  1. Clouds render against a black background (globe/sky hidden) — the
//     bright-pixel mask is non-trivial before the edit.
//  2. Move one cloud's position by a visible amount + change its scale →
//     the rendered mask CHANGES within 2 frames (pre-fix: stays stale), and
//     the instance buffer identity changes (>= 1 rebuild observed).
//  3. Settled frames after the edit → NO further rebuilds (instance-buffer
//     identity stable; the dirty-consume keeps the gate from re-firing).
//  4. 0 console errors.
//
// Batch 253 (NEW-CLOUD-SCALE-METERS): CumulusCloud.scale is METERS (upstream
// parity) — the WebGPU renderer previously sized quads in screen PIXELS, so
// this probe's original 220x150 "px" clouds at a 300 km camera became
// sub-pixel after the fix. Re-parameterized to 2000x1300 m clouds at a
// 15 km camera (~156x101 px) — same assertions, same dirty-gate coverage.
//
// Usage: node Tools/visual-regression/probe-cloud-property-edit.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    scene = v.scene;

  // Black background so cloud pixels are the only bright ones.
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = C.Color.BLACK;

  const LON = -75.0,
    LAT = 40.0;
  const clouds = scene.primitives.add(new C.CloudCollection());
  // Cloud 0 — the one we edit. Cloud 1 — static control off to the side.
  const cloud0 = clouds.add({
    position: C.Cartesian3.fromDegrees(LON, LAT, 5000.0),
    scale: new C.Cartesian2(2000, 1300),
  });
  clouds.add({
    position: C.Cartesian3.fromDegrees(LON - 0.03, LAT, 5000.0),
    scale: new C.Cartesian2(1500, 1000),
  });
  scene.morphTo3D(0);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 15000.0),
  });

  const frame = () =>
    new Promise((r) => {
      scene.render();
      requestAnimationFrame(r);
    });

  // One-shot capture INSIDE scene.postRender — present clears the WebGPU
  // canvas texture, so readback after the rAF tick is non-deterministic.
  function captureMask() {
    return new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        const d = cx.getImageData(0, 0, c.width, c.height).data;
        const mask = new Uint8Array(c.width * c.height);
        let count = 0;
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          if (d[i] + d[i + 1] + d[i + 2] > 90) {
            mask[p] = 1;
            count++;
          }
        }
        resolve({ mask, count });
      });
      scene.render();
    });
  }

  // Warmup — async pipeline resolution + first instance build.
  for (let i = 0; i < 60; i++) await frame();

  const cacheOf = () => clouds._webgpuCache;
  const before = await captureMask();
  const bufBeforeEdit = cacheOf()?.instanceBuffer;

  // THE EDIT: move cloud 0 by a clearly visible amount (~200 px east,
  // ~130 px north at the 15 km camera) + change its scale.
  cloud0.position = C.Cartesian3.fromDegrees(LON + 0.03, LAT + 0.015, 5000.0);
  cloud0.scale = new C.Cartesian2(3000, 2000);
  const dirtyIndexAtEdit = clouds._cloudsToUpdateIndex;

  // Mask must change within 2 frames.
  await frame();
  const after = await captureMask(); // frame 2 post-edit
  const bufAfterEdit = cacheOf()?.instanceBuffer;
  const editRebuilt = bufAfterEdit !== bufBeforeEdit;

  let changedPixels = 0;
  for (let p = 0; p < before.mask.length; p++) {
    if (before.mask[p] !== after.mask[p]) changedPixels++;
  }

  // Settled frames after the edit — the gate must NOT re-fire (the consume
  // cleared the dirty state the rebuild was keyed on).
  let settledRebuilds = 0;
  let lastBuf = cacheOf()?.instanceBuffer;
  for (let i = 0; i < 15; i++) {
    await frame();
    const b = cacheOf()?.instanceBuffer;
    if (b !== lastBuf) {
      settledRebuilds++;
      lastBuf = b;
    }
  }
  const queueAfterSettle = clouds._cloudsToUpdateIndex;

  return {
    beforeCount: before.count,
    afterCount: after.count,
    changedPixels,
    dirtyIndexAtEdit,
    editRebuilt,
    settledRebuilds,
    queueAfterSettle,
  };
});

const rendersOK = out.beforeCount > 200;
const changeOK = out.changedPixels > 500 && out.editRebuilt;
const settledOK = out.settledRebuilds === 0 && out.queueAfterSettle === 0;
const errorsOK = errors.length === 0;

console.log(
  `clouds render: before=${out.beforeCount}px after=${out.afterCount}px ${rendersOK ? "OK" : "FAIL"}`,
);
console.log(
  `edit visible within 2 frames: changedPixels=${out.changedPixels} rebuilt=${out.editRebuilt} (dirtyIndexAtEdit=${out.dirtyIndexAtEdit}) ${changeOK ? "OK" : "FAIL (stale render — gate missed the property edit)"}`,
);
console.log(
  `settled after edit: rebuilds=${out.settledRebuilds} queue=${out.queueAfterSettle} ${settledOK ? "OK" : "FAIL"}`,
);
console.log(`console errors: ${errors.length} ${errorsOK ? "OK" : "FAIL"}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 160)));

const pass = rendersOK && changeOK && settledOK && errorsOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
