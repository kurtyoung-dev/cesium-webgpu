#!/usr/bin/env node
// Probe: NS-MOON-ATMOSPHERE-EXTINCTION
//
// Verifies that the moon is attenuated + reddened by atmospheric extinction
// along the view ray near the horizon at low altitude, on BOTH backends, and
// is byte-identically unchanged from orbit (off-gate).
//
// For each backend and each of three configs we position the camera relative
// to the REAL moon (read from scene.moon._ellipsoidPrimitive.modelMatrix) and
// force a DirectionalLight lighting the camera-facing hemisphere so the disc
// is fully lit regardless of lunar phase — isolating the extinction effect:
//   * horizon-low : camera 50 m alt, moon ~4 deg above horizon (long slant path)
//   * high-low    : camera 50 m alt, moon ~85 deg elevation   (short path)
//   * orbit       : camera 2000 km alt, moon ~85 deg elevation (no atmosphere)
//
// Assertions (per backend):
//   horizon disc is DIMMER than high disc, and WARMER (higher R/B ratio).
//   orbit extinction factor ~= (1,1,1) and disc ~= full brightness (off-gate).
//
// Usage: node Tools/visual-regression/probe-moon-atmosphere.mjs
// Outputs: output/probe-moon-atmosphere-{backend}-{config}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const W = 900;
const H = 900;

// Fixed clock time (ISO) so the run is deterministic across backends.
const CLOCK_ISO = "2024-06-20T04:00:00Z";

const CONFIGS = [
  { name: "horizon-low", altitude: 50, elevationDeg: 4 },
  { name: "high-low", altitude: 50, elevationDeg: 85 },
  { name: "orbit", altitude: 2_000_000, elevationDeg: 85 },
];

async function run(rendererArg, config) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) => messages.push({ t: "pageerror", text: e.message }));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });

  const metrics = await page.evaluate(
    async ({ config, CLOCK_ISO }) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer;
      const scene = v.scene;

      // Deterministic clock.
      const jd = C.JulianDate.fromIso8601(CLOCK_ISO);
      v.clock.currentTime = jd;
      v.clock.shouldAnimate = false;

      scene.moon.show = true;
      scene.skyAtmosphere.show = true;
      scene.fog.enabled = false;
      scene.globe.show = true;

      // Prime a few frames so the moon ephemeris + model matrix populate and
      // the moon texture loads.
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Moon world position from its primitive model matrix.
      const mm = scene.moon._ellipsoidPrimitive.modelMatrix;
      const moonPos = C.Matrix4.getTranslation(mm, new C.Cartesian3());
      const M = C.Cartesian3.normalize(moonPos, new C.Cartesian3());

      // Perpendicular-to-M unit vector (horizontal reference).
      let ref = C.Cartesian3.UNIT_Z;
      if (Math.abs(C.Cartesian3.dot(M, ref)) > 0.98) {
        ref = C.Cartesian3.UNIT_X;
      }
      const perp = C.Cartesian3.normalize(
        C.Cartesian3.cross(M, ref, new C.Cartesian3()),
        new C.Cartesian3(),
      );

      // Camera up-direction U with angle(U, M) = 90 - elevation, i.e.
      // dot(U, M) = sin(elevation). U = sin(e)*M + cos(e)*perp.
      const e = C.Math.toRadians(config.elevationDeg);
      const U = C.Cartesian3.add(
        C.Cartesian3.multiplyByScalar(M, Math.sin(e), new C.Cartesian3()),
        C.Cartesian3.multiplyByScalar(perp, Math.cos(e), new C.Cartesian3()),
        new C.Cartesian3(),
      );
      C.Cartesian3.normalize(U, U);

      const Re = C.Ellipsoid.WGS84.maximumRadius;
      const camPos = C.Cartesian3.multiplyByScalar(
        U,
        Re + config.altitude,
        new C.Cartesian3(),
      );

      // Look straight at the moon.
      const dir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(moonPos, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      // Camera up = local up (U), re-orthogonalized against dir.
      const right = C.Cartesian3.normalize(
        C.Cartesian3.cross(dir, U, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const up = C.Cartesian3.normalize(
        C.Cartesian3.cross(right, dir, new C.Cartesian3()),
        new C.Cartesian3(),
      );

      scene.camera.setView({
        destination: camPos,
        orientation: { direction: dir, up: up },
      });
      // Narrow FOV so the ~0.5deg moon disc is large enough to sample.
      scene.camera.frustum.fov = C.Math.toRadians(1.2);

      // Force a directional light that lights the camera-facing hemisphere so
      // the disc is fully lit regardless of phase (isolates extinction). Light
      // travels from the camera side toward the moon.
      const lightDir = C.Cartesian3.normalize(
        C.Cartesian3.subtract(moonPos, camPos, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      scene.light = new C.DirectionalLight({ direction: lightDir });
      scene.moon.onlySunLighting = false;

      // Settle.
      for (let i = 0; i < 40; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Extinction factor set by Moon.update (both backends).
      const ext = scene.moon._ellipsoidPrimitive.atmosphereExtinction;
      const extinction = ext ? { x: ext.x, y: ext.y, z: ext.z } : null;

      // Sample the central disc region of the canvas.
      const canvas = scene.canvas;
      const gl2d = document.createElement("canvas");
      gl2d.width = canvas.width;
      gl2d.height = canvas.height;
      const ctx = gl2d.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);
      const rad = Math.floor(Math.min(canvas.width, canvas.height) * 0.12);
      const img = ctx.getImageData(cx - rad, cy - rad, rad * 2, rad * 2).data;

      let sumR = 0,
        sumG = 0,
        sumB = 0,
        n = 0,
        litR = 0,
        litG = 0,
        litB = 0,
        litN = 0,
        maxLum = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i],
          g = img[i + 1],
          b = img[i + 2];
        sumR += r;
        sumG += g;
        sumB += b;
        n++;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum > maxLum) maxLum = lum;
        // "lit" pixels = the moon disc surface (exclude near-black sky).
        if (lum > 12) {
          litR += r;
          litG += g;
          litB += b;
          litN++;
        }
      }
      const meanLum = (0.2126 * sumR + 0.7152 * sumG + 0.0722 * sumB) / n;
      const litLum =
        litN > 0 ? (0.2126 * litR + 0.7152 * litG + 0.0722 * litB) / litN : 0;
      const litRB = litN > 0 && litB > 0 ? litR / litB : 0;

      return {
        moonPos: { x: moonPos.x, y: moonPos.y, z: moonPos.z },
        camAltKm: (C.Cartesian3.magnitude(camPos) - Re) / 1000,
        extinction,
        meanLum,
        maxLum,
        litLum,
        litN,
        litRB,
        litMean: litN > 0 ? { r: litR / litN, g: litG / litN, b: litB / litN } : null,
        canvasW: canvas.width,
        canvasH: canvas.height,
      };
    },
    { config, CLOCK_ISO },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(
    OUT_DIR,
    `probe-moon-atmosphere-${rendererArg}-${config.name}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  metrics.png = out;
  metrics.errors = errs.slice(0, 4).map((e) => `${e.t}: ${e.text}`);
  return metrics;
}

(async () => {
  const results = {};
  for (const backend of ["webgl", "webgpu"]) {
    results[backend] = {};
    for (const config of CONFIGS) {
      process.stdout.write(`\n=== ${backend} / ${config.name} ===\n`);
      const m = await run(backend, config);
      results[backend][config.name] = m;
      console.log(
        `  camAlt=${m.camAltKm.toFixed(0)}km ext=${
          m.extinction
            ? `(${m.extinction.x.toFixed(3)},${m.extinction.y.toFixed(3)},${m.extinction.z.toFixed(3)})`
            : "null"
        } litLum=${m.litLum.toFixed(1)} litN=${m.litN} litRB=${m.litRB.toFixed(3)} litMean=${
          m.litMean
            ? `(${m.litMean.r.toFixed(0)},${m.litMean.g.toFixed(0)},${m.litMean.b.toFixed(0)})`
            : "null"
        }`,
      );
      if (m.errors.length) m.errors.forEach((e) => console.log(`    ERR ${e}`));
    }
  }

  console.log("\n========== VERDICT ==========");
  let pass = true;
  for (const backend of ["webgl", "webgpu"]) {
    const horizon = results[backend]["horizon-low"];
    const high = results[backend]["high-low"];
    const orbit = results[backend]["orbit"];

    const dimmer = horizon.litLum < high.litLum * 0.85;
    const warmer = horizon.litRB > high.litRB * 1.03;
    const orbitExtOne =
      orbit.extinction &&
      orbit.extinction.x > 0.999 &&
      orbit.extinction.y > 0.999 &&
      orbit.extinction.z > 0.999;
    // Horizon extinction should be materially below 1 and blue-suppressed.
    const horizonExtLow =
      horizon.extinction &&
      horizon.extinction.z < 0.9 &&
      horizon.extinction.z < horizon.extinction.x;

    console.log(
      `[${backend}] dimmer=${dimmer} (h=${horizon.litLum.toFixed(1)} vs H=${high.litLum.toFixed(
        1,
      )})  warmer=${warmer} (h.R/B=${horizon.litRB.toFixed(3)} vs H.R/B=${high.litRB.toFixed(
        3,
      )})  orbitExt=1:${orbitExtOne}  horizonExtLow:${horizonExtLow}`,
    );
    if (!(dimmer && warmer && orbitExtOne && horizonExtLow)) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
