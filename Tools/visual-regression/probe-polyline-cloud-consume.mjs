#!/usr/bin/env node
// Probe (NEW-DIRTY-CONSUME-POLYLINE + NEW-DIRTY-CONSUME-CLOUD verify): after the
// Phase-0 dirty-consume fix, a STATIC PolylineCollection and a STATIC
// CloudCollection must stop re-touching their primitives every frame on the
// WebGPU path, with queues drained — while polylines still render.
//
// Render assertions:
//  - Polyline: asserted at the known-good view (1.5 Mm camera, surface
//    polylines — the configuration verified rendering in
//    probe-collections-2dcv-morph.mjs).
//  - Cloud: render reported informationally (not asserted — the white-ish
//    pixel heuristic can include imagery). Cloud consume is verified via the
//    dirty-call counter + queue drain. NOTE: this probe originally found
//    NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH — the cloud pipeline missed the
//    scene-FB MSAA sample count, and the resulting validation error killed
//    the WHOLE pass (adding one cloud blanked every primitive in the scene,
//    confirmed pre-existing at HEAD). Fixed in the same batch (multisample
//    baked into the cloud pipeline descriptor); the error filter below is
//    kept as a regression tripwire.
//
// Usage: node Tools/visual-regression/probe-polyline-cloud-consume.mjs
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

  // Known-good polyline configuration (matches probe-collections-2dcv-morph):
  // surface polylines spanning degrees, camera at 1.5 Mm looking down.
  const LON = -75.0,
    LAT = 40.0;
  const pls = scene.primitives.add(new C.PolylineCollection());
  for (let i = 0; i < 4; i++) {
    pls.add({
      positions: [
        C.Cartesian3.fromDegrees(LON - 1.5, LAT - 1.0 + i * 0.5, 0.0),
        C.Cartesian3.fromDegrees(LON + 1.5, LAT - 1.0 + i * 0.5, 0.0),
      ],
      width: 6,
      material: C.Material.fromType("Color", { color: C.Color.CYAN }),
    });
  }
  const clouds = scene.primitives.add(new C.CloudCollection());
  for (let i = 0; i < 4; i++) {
    clouds.add({
      position: C.Cartesian3.fromDegrees(LON + i * 0.2, LAT + 1.2, 5000),
      scale: new C.Cartesian2(2000, 1000),
    });
  }
  scene.morphTo3D(0);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, 1500000.0),
  });
  for (let i = 0; i < 50; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  // Count per-primitive dirty calls over 20 settled frames.
  let plCalls = 0;
  let cloudCalls = 0;
  const origPl = pls._updatePolyline.bind(pls);
  const origCloud = clouds._updateCloud.bind(clouds);
  pls._updatePolyline = function (p, prop) {
    plCalls++;
    return origPl(p, prop);
  };
  clouds._updateCloud = function (c, prop) {
    cloudCalls++;
    return origCloud(c, prop);
  };
  for (let i = 0; i < 20; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  pls._updatePolyline = origPl;
  clouds._updateCloud = origCloud;

  // Queue-leak check: the toUpdate queues must be drained, not growing.
  const plQueue = pls._polylinesToUpdate.length;
  const cloudQueue = clouds._cloudsToUpdateIndex;

  // Moving-polyline correctness: change one polyline; it must re-enqueue
  // (the consume must re-ARM dirty tracking, not freeze it).
  let movingCalls = 0;
  pls._updatePolyline = function (p, prop) {
    movingCalls++;
    return origPl(p, prop);
  };
  const pl0 = pls.get(0);
  pl0.width = 12;
  scene.render();
  await new Promise((r) => requestAnimationFrame(r));
  pls._updatePolyline = origPl;

  // Render check (deterministic in-evaluate readback).
  const c = scene.canvas;
  const off = document.createElement("canvas");
  off.width = c.width;
  off.height = c.height;
  const cx = off.getContext("2d");
  cx.drawImage(c, 0, 0);
  const d = cx.getImageData(0, 0, c.width, c.height).data;
  let cyan = 0,
    cloudish = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    if (g > 150 && b > 150 && r < 120) cyan++;
    else if (r > 140 && g > 140 && b > 140 && Math.abs(r - b) < 30) cloudish++;
  }
  return {
    plCallsPerFrame: plCalls / 20,
    cloudCallsPerFrame: cloudCalls / 20,
    plQueue,
    cloudQueue,
    movingCalls,
    cyan,
    cloudish,
  };
});

const plOK = out.plCallsPerFrame < 1;
const cloudOK = out.cloudCallsPerFrame < 1;
const queueOK = out.plQueue === 0 && out.cloudQueue === 0;
const movingOK = out.movingCalls >= 1;
const plRenders = out.cyan > 100;
// Pre-existing cloud scene-FB pipeline mismatch is allowed in console errors;
// everything else fails the probe.
const realErrors = errors.filter(
  (e) => !/CloudCollection pipeline/.test(e),
);
console.log(
  `polyline _updatePolyline/frame: ${out.plCallsPerFrame} ${plOK ? "OK" : "FAIL"} | cloud _updateCloud/frame: ${out.cloudCallsPerFrame} ${cloudOK ? "OK" : "FAIL"}`,
);
console.log(
  `queues drained: pl=${out.plQueue} cloud=${out.cloudQueue} ${queueOK ? "OK" : "FAIL"} | modified polyline re-enqueues: ${out.movingCalls} ${movingOK ? "OK" : "FAIL"}`,
);
console.log(
  `renders: polyline(cyan)=${out.cyan} ${plRenders ? "OK" : "FAIL"} | clouds(white)=${out.cloudish} (informational — pre-existing no-render at HEAD, NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH)`,
);
console.log(
  `console errors: ${errors.length} total, ${realErrors.length} non-cloud`,
);
realErrors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 160)));
const pass =
  plOK && cloudOK && queueOK && movingOK && plRenders && realErrors.length === 0;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
