#!/usr/bin/env node
// Probe (NEW-PICKDEPTH-CAPABILITY-READBACK verify): does scene.pickPosition()
// return a valid globe-surface Cartesian3 on WebGPU after the
// supportsSynchronousReadback capability fix? Reports, over several frames,
// what pickPosition returns at the screen center (Cartesian3 / Promise /
// undefined) and whether it lands near the globe surface.
//
// Usage: node Tools/visual-regression/probe-pickposition-webgpu.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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
  const v = window.viewer;
  const scene = v.scene;

  // Look straight down at a known location so the center pixel is on the globe.
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75.0, 40.0, 2_000_000.0),
  });
  scene.pickPositionSupported; // touch

  // Let the globe load + render so the depth texture is populated.
  for (let i = 0; i < 90; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }

  const center = new C.Cartesian2(
    Math.floor(scene.canvas.clientWidth / 2),
    Math.floor(scene.canvas.clientHeight / 2),
  );

  const samples = [];
  for (let i = 0; i < 12; i++) {
    scene.render();
    let res;
    try {
      res = scene.pickPosition(center);
    } catch (e) {
      res = `THREW: ${e}`;
    }
    let kind = "undefined";
    let carto = null;
    if (res && typeof res.then === "function") {
      kind = "Promise";
      try {
        const awaited = await res;
        if (awaited) {
          kind = "Promise->Cartesian3";
          const cc = C.Cartographic.fromCartesian(awaited);
          carto = cc
            ? {
                lon: C.Math.toDegrees(cc.longitude),
                lat: C.Math.toDegrees(cc.latitude),
                h: cc.height,
              }
            : null;
        } else {
          kind = "Promise->undefined";
        }
      } catch (e) {
        kind = `Promise->THREW`;
      }
    } else if (res && typeof res.x === "number" && isFinite(res.x)) {
      kind = "Cartesian3";
      const cc = C.Cartographic.fromCartesian(res);
      carto = cc
        ? {
            lon: C.Math.toDegrees(cc.longitude),
            lat: C.Math.toDegrees(cc.latitude),
            h: cc.height,
          }
        : null;
    } else if (res && typeof res.x === "number") {
      kind = `Cartesian3-NaN(${res.x})`;
    } else if (typeof res === "string") {
      kind = res;
    }
    samples.push({ frame: i, kind, carto });
    await new Promise((r) => requestAnimationFrame(r));
  }

  return {
    pickPositionSupported: scene.pickPositionSupported,
    rendererType: scene.context?.rendererType,
    samples,
  };
});

console.log("pickPositionSupported:", out.pickPositionSupported);
console.log("rendererType:", out.rendererType);
for (const s of out.samples) {
  console.log(
    `  frame ${String(s.frame).padStart(2)}: ${s.kind}` +
      (s.carto
        ? ` @ lon=${s.carto.lon.toFixed(3)} lat=${s.carto.lat.toFixed(3)} h=${s.carto.h.toFixed(0)}`
        : ""),
  );
}
console.log("console errors:", errors.length);
errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
await browser.close();
