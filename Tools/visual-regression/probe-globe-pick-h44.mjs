#!/usr/bin/env node
// Probe (DP-H44, Batch 360): WebGPU globe terrain picking, opt-in behind
// `globe.pickable`.
//
// What it asserts (WebGPU leg):
//  1. pickable=false (default): pickAsync over the globe does NOT return the
//     globe (undefined) — WebGL parity.
//  2. pickable=false: a foreground Point primitive in front of the globe IS
//     pickable (the globe stays OUT of the pick pass when not pickable, so it
//     does not occlude foreground primitives — the "didn't break existing
//     picking" regression guard).
//  3. pickable=true: pickAsync over the globe returns an object whose
//     `.primitive === scene.globe`.
//  4. Zero console errors / WebGPU validation errors.
//
// WebGL reference leg:
//  5. pickAsync over the globe returns the globe in NEITHER pickable state
//     (the WebGL globe path has no pick ID — confirms `pickable` is a
//     WebGPU-only opt-in and the WebGL globe is unaffected by the flag).
//
// pickPosition over the globe is covered by probe-pickposition-webgpu.mjs and
// is NOT touched by this change (it reads the main-pass globe-depth texture,
// not the pick FBO).
//
// Uses pickAsync everywhere (sync scene.pick leaves the WebGPU pick buffer
// mapped, breaking subsequent picks — see probe-pick-basic.mjs).
//
// Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-globe-pick-h44.mjs

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const LON = -75.0;
const LAT = 40.0;
const HEIGHT = 2_000_000.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runLeg(renderer) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  const gpuErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.text().includes("[GPUERR]")) gpuErrors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  const out = await page.evaluate(
    async ({ LON, LAT, HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      const dev = scene.context?._device;
      if (dev) {
        dev.onuncapturederror = (ev) =>
          console.log(`[GPUERR] ${ev?.error?.message?.slice(0, 300)}`);
      }
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const center = new C.Cartesian2(
        Math.floor(scene.canvas.clientWidth / 2),
        Math.floor(scene.canvas.clientHeight / 2),
      );
      const renderN = async (n) => {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      };
      const describePick = (p) => {
        if (!C.defined(p)) return { defined: false };
        return {
          defined: true,
          isGlobe: p.primitive === scene.globe,
          primCtor: p.primitive?.constructor?.name ?? null,
          id: typeof p.id === "string" ? p.id : (p.id?.id ?? null),
        };
      };
      const pickStable = async () => {
        let last;
        for (let i = 0; i < 8; i++) {
          scene.render();
          const r = await scene.pickAsync(center, 3, 3);
          if (C.defined(r)) return describePick(r);
          last = r;
          await new Promise((rr) => requestAnimationFrame(rr));
        }
        return describePick(last);
      };

      await renderN(150);

      // ── A) pickable=false (default): globe NOT picked ──
      scene.globe.pickable = false;
      await renderN(3);
      const pickGlobeFalse = await pickStable();

      // ── B) pickable=false: foreground point IS pickable (regression guard) ──
      v.entities.add({
        id: "fg-point",
        position: C.Cartesian3.fromDegrees(LON, LAT, 500_000.0),
        point: {
          pixelSize: 40,
          color: C.Color.YELLOW,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      await renderN(5);
      const pickPoint = await pickStable();
      v.entities.removeById("fg-point");
      await renderN(3);

      // ── C) pickable=true: globe IS picked ──
      scene.globe.pickable = true;
      await renderN(5);
      const pickGlobeTrue = await pickStable();

      return {
        rendererType: scene.context?.rendererType,
        pickGlobeFalse,
        pickPoint,
        pickGlobeTrue,
      };
    },
    { LON, LAT, HEIGHT },
  );

  await page.close();
  return { ...out, errors, gpuErrors };
}

const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  console.log(`  pickable=false globe : ${JSON.stringify(leg.pickGlobeFalse)}`);
  console.log(`  pickable=false point : ${JSON.stringify(leg.pickPoint)}`);
  console.log(`  pickable=true  globe : ${JSON.stringify(leg.pickGlobeTrue)}`);
  console.log(
    `  console errors: ${leg.errors.length}  gpuErrors: ${leg.gpuErrors.length}`,
  );
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
  leg.gpuErrors.slice(0, 4).forEach((e) => console.log("   ", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

const failures = [];

// WebGPU assertions.
if (webgpu.pickGlobeFalse.isGlobe) {
  failures.push("WebGPU pickable=false returned the globe (expected undefined)");
}
if (!webgpu.pickPoint.defined || webgpu.pickPoint.id !== "fg-point") {
  failures.push(
    `WebGPU foreground point not pickable with pickable=false (got ${JSON.stringify(webgpu.pickPoint)})`,
  );
}
if (!webgpu.pickGlobeTrue.defined || !webgpu.pickGlobeTrue.isGlobe) {
  failures.push(
    `WebGPU pickable=true did NOT return the globe (got ${JSON.stringify(webgpu.pickGlobeTrue)})`,
  );
}
if (webgpu.errors.length > 0)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);
if (webgpu.gpuErrors.length > 0)
  failures.push(`WebGPU validation errors: ${webgpu.gpuErrors.length}`);

// WebGL reference: globe NEVER returned by scene.pick (no pick ID).
if (webgl.pickGlobeFalse.isGlobe || webgl.pickGlobeTrue.isGlobe) {
  failures.push("WebGL returned the globe from scene.pick (should never)");
}
if (!webgl.pickPoint.defined || webgl.pickPoint.id !== "fg-point") {
  failures.push(
    `WebGL foreground point not pickable (got ${JSON.stringify(webgl.pickPoint)})`,
  );
}
if (webgl.errors.length > 0)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: DP-H44 globe pick opt-in works on WebGPU; foreground picking + WebGL unaffected",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
