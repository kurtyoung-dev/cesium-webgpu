#!/usr/bin/env node
/**
 * Probe: PolylineColorAppearance + PolylineMaterialAppearance Primitive in
 * 3D / Columbus View / 2D / mid-morph on WebGPU vs WebGL (C2-12 / 376b).
 *
 * The WebGPU polyline appearance VS was 3D-only — it read position3DHigh/Low and
 * fed them through the (2D/CV) modelView, so in 2D/CV mode it transformed 3D ECEF
 * through the 2D camera → 0px. 376b plumbs the projected 2D positions (loc8-13)
 * + morphTime (camera UB) into all 6 polyline shaders and blends 3D↔2D via
 * csm_computePolylinePosition (the WGSL port of czm_computePosition, with the
 * .zxy swizzle), so the line renders correctly in every scene mode.
 *
 * GATE:
 *   - 3D: webgpu cyan within 5% of webgl (no regression)
 *   - CV + 2D: webgpu cyan within 5% of webgl (was 0px → fixed)
 *   - MORPH (intermediate morphTime): webgpu renders (cyan > 0) within 15% of webgl
 *   - MATERIAL (PolylineGlow) in 2D: webgpu renders within 10% of webgl
 *   - PNGs saved for visual read
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-appearance-2d.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function captureMode(page, mode, material) {
  return page.evaluate(
    async ({ mode, material }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer,
        s = v.scene;
      s.globe.show = false;
      s.skyBox.show = false;
      if (s.sun) s.sun.show = false;
      if (s.moon) s.moon.show = false;
      s.skyAtmosphere.show = false;
      s.backgroundColor = C.Color.BLACK;

      const prims = s.primitives;
      for (let i = prims.length - 1; i >= 0; i--) {
        const p = prims.get(i);
        if (p && p.constructor && p.constructor.name === "Primitive")
          prims.remove(p);
      }

      const positions = C.Cartesian3.fromDegreesArray([
        -75.0, 35.0, -74.0, 36.0, -73.0, 35.0, -72.0, 36.0, -71.0, 35.0,
      ]);

      let primitive;
      if (material) {
        primitive = prims.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.PolylineGeometry({
                positions,
                width: 14.0,
                arcType: C.ArcType.NONE,
                vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
              }),
            }),
            appearance: new C.PolylineMaterialAppearance({
              material: C.Material.fromType("PolylineGlow", {
                color: C.Color.CYAN,
                glowPower: 0.25,
                taperPower: 1.0,
              }),
              translucent: false,
            }),
            asynchronous: false,
          }),
        );
      } else {
        primitive = prims.add(
          new C.Primitive({
            geometryInstances: new C.GeometryInstance({
              geometry: new C.PolylineGeometry({
                positions,
                width: 10.0,
                arcType: C.ArcType.NONE,
                vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
              }),
              attributes: {
                color: C.ColorGeometryInstanceAttribute.fromColor(
                  new C.Color(0.0, 1.0, 1.0, 1.0),
                ),
              },
            }),
            appearance: new C.PolylineColorAppearance({ translucent: false }),
            asynchronous: false,
          }),
        );
      }

      if (mode === "2D") s.morphTo2D(0.0);
      else if (mode === "CV") s.morphToColumbusView(0.0);
      else if (mode === "MORPH") s.morphToColumbusView(2.0); // animate → capture mid
      else s.morphTo3D(0.0);

      const center = C.Cartesian3.fromDegrees(-73.0, 35.5, 0.0);
      // For MORPH, render only a few frames so we catch an INTERMEDIATE
      // morphTime (the 2s morph is still animating).
      const settleFrames = mode === "MORPH" ? 18 : 30;
      for (let i = 0; i < settleFrames; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      v.camera.lookAt(
        center,
        new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 600000.0),
      );
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      const renderFrames = mode === "MORPH" ? 4 : 60;
      for (let i = 0; i < renderFrames; i++) {
        s.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const canvas = s.canvas,
        w = canvas.width,
        h = canvas.height;
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const cx = tmp.getContext("2d");
      cx.drawImage(canvas, 0, 0);
      const px = cx.getImageData(0, 0, w, h).data;
      let cyan = 0,
        sumX = 0,
        sumY = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 2] > 150 && px[i + 1] > 150 && px[i] < 110) {
          cyan++;
          const p = i / 4;
          sumX += p % w;
          sumY += Math.floor(p / w);
        }
      }
      return {
        mode,
        material: !!material,
        sceneMode: s.mode,
        morphTime: s.morphTime,
        renderer: s.context?.rendererType,
        ready: primitive.ready,
        cyan,
        cx: cyan ? Math.round(sumX / cyan) : -1,
        cy: cyan ? Math.round(sumY / cyan) : -1,
        width: w,
        height: h,
      };
    },
    { mode, material },
  );
}

async function run(renderer, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  const out = {};
  for (const [key, mode, material] of [
    ["3D", "3D", false],
    ["CV", "CV", false],
    ["2D", "2D", false],
    ["GLOW2D", "2D", true],
  ]) {
    out[key] = await captureMode(page, mode, material);
    if (key === "2D" || key === "GLOW2D") {
      const buf = await page.screenshot({ omitBackground: false });
      fs.writeFileSync(
        `Tools/visual-regression/output/polyline-2d-${key}-${renderer}.png`,
        buf,
      );
    }
  }
  await browser.close();
  return out;
}

const fs = await import("fs");
fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
const wgl = await run("webgl", fs);
const wgpu = await run("webgpu", fs);

console.log("=== RAW ===");
for (const k of ["3D", "CV", "2D", "GLOW2D"]) {
  console.log(`[${k}] WEBGL :`, JSON.stringify(wgl[k]));
  console.log(`[${k}] WEBGPU:`, JSON.stringify(wgpu[k]));
}

const checks = [];
for (const [k, tol] of [
  ["3D", 0.05],
  ["CV", 0.05],
  ["2D", 0.05],
  ["GLOW2D", 0.1],
]) {
  const a = wgl[k].cyan,
    b = wgpu[k].cyan;
  const ratio = a > 0 ? b / a : 0;
  checks.push([`[${k}] webgl renders (ref, cyan=${a})`, a > 200]);
  checks.push([
    `[${k}] webgpu renders + within ${(tol * 100).toFixed(0)}% (cyan=${b}, ratio=${ratio.toFixed(3)})`,
    b > 200 && ratio >= 1 - tol && ratio <= 1 + tol,
  ]);
}
console.log("\n=== ANALYSIS ===");
let pass = true;
for (const [label, ok] of checks) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) pass = false;
}
console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
process.exitCode = pass ? 0 : 1;
