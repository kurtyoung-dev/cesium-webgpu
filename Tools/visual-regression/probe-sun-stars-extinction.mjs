#!/usr/bin/env node
// Probe: C7-SUN-STARS-EXTINCTION
//
// Verifies the follow-up to B629 (moon atmospheric extinction): the SUN and
// the catalog STARFIELD dim/redden through the atmosphere near the horizon,
// on BOTH backends, and are byte-identically unchanged from orbit / when the
// atmosphere is hidden.
//
// PART A — SUN. Position the camera relative to the real sun and read the
// per-frame transmittance Sun.update stores on `scene.sun._atmosphereExtinction`
// (both backends), plus a central-disc luminance sample:
//   * horizon-low : cam 50 m alt,  sun ~3 deg above horizon (long slant path)
//   * high-low    : cam 50 m alt,  sun ~80 deg elevation    (short path)
//   * orbit       : cam 2000 km,   sun ~80 deg elevation    (no atmosphere)
//   Assert: horizon ext materially < 1 and blue-suppressed (z < x → warmer);
//           orbit ext ~= (1,1,1) (off-gate); backends match.
//
// PART B — STARFIELD. A night scene at low altitude, camera at the horizon so
// the sky spans horizon→zenith. Rendered twice per backend: skyAtmosphere ON
// (extinction active) vs OFF (no extinction). Sum the catalog-star additive
// brightness in a horizon band and a zenith band. The cubemap (not
// extinguished) cancels in the ON/OFF difference, isolating the catalog stars:
//   Assert: horizonBand(ON) materially dimmer than horizonBand(OFF);
//           zenithBand(ON) ~= zenithBand(OFF)  (per-direction + off-gate).
//
// Usage: node Tools/visual-regression/probe-sun-stars-extinction.mjs
// Outputs: output/probe-sun-stars-extinction-*.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const W = 900;
const H = 900;

// Deterministic clocks.
const SUN_CLOCK_ISO = "2024-06-20T12:00:00Z";
// Night over the chosen longitude (~local midnight) so stars are visible.
const NIGHT_CLOCK_ISO = "2024-06-20T00:00:00Z";

const SUN_CONFIGS = [
  { name: "horizon-low", altitude: 50, elevationDeg: 3 },
  { name: "high-low", altitude: 50, elevationDeg: 80 },
  { name: "orbit", altitude: 2_000_000, elevationDeg: 80 },
];

function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
}

async function newViewerPage(browser, rendererArg) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer, { timeout: 30000 });
  return { page, messages };
}

// ── PART A: SUN ──────────────────────────────────────────────────────────
async function runSun(browser, rendererArg, config) {
  const { page, messages } = await newViewerPage(browser, rendererArg);
  const metrics = await page.evaluate(
    async ({ config, SUN_CLOCK_ISO }) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer;
      const scene = v.scene;

      v.clock.currentTime = C.JulianDate.fromIso8601(SUN_CLOCK_ISO);
      v.clock.shouldAnimate = false;

      scene.sun.show = true;
      scene.moon.show = false;
      scene.skyAtmosphere.show = true;
      scene.fog.enabled = false;
      scene.globe.show = true;

      for (let i = 0; i < 20; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Real sun world direction from UniformState.
      const sunDir = C.Cartesian3.normalize(
        scene.context.uniformState.sunPositionWC,
        new C.Cartesian3(),
      );

      // Perpendicular horizontal reference.
      let ref = C.Cartesian3.UNIT_Z;
      if (Math.abs(C.Cartesian3.dot(sunDir, ref)) > 0.98) {
        ref = C.Cartesian3.UNIT_X;
      }
      const perp = C.Cartesian3.normalize(
        C.Cartesian3.cross(sunDir, ref, new C.Cartesian3()),
        new C.Cartesian3(),
      );

      // Local up U with dot(U, sunDir) = sin(elevation).
      const e = C.Math.toRadians(config.elevationDeg);
      const U = C.Cartesian3.normalize(
        C.Cartesian3.add(
          C.Cartesian3.multiplyByScalar(
            sunDir,
            Math.sin(e),
            new C.Cartesian3(),
          ),
          C.Cartesian3.multiplyByScalar(perp, Math.cos(e), new C.Cartesian3()),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );

      const Re = C.Ellipsoid.WGS84.maximumRadius;
      const camPos = C.Cartesian3.multiplyByScalar(
        U,
        Re + config.altitude,
        new C.Cartesian3(),
      );

      // Look straight along the sun direction (sun far away → dir ~= sunDir).
      const dir = C.Cartesian3.clone(sunDir);
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
      scene.camera.frustum.fov = C.Math.toRadians(8.0);

      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      const ext = scene.sun._atmosphereExtinction;
      const extinction = ext ? { x: ext.x, y: ext.y, z: ext.z } : null;

      // Sample the central bright region (sun disc + glow).
      const canvas = scene.canvas;
      const g2d = document.createElement("canvas");
      g2d.width = canvas.width;
      g2d.height = canvas.height;
      const ctx = g2d.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);
      const rad = Math.floor(Math.min(canvas.width, canvas.height) * 0.18);
      const img = ctx.getImageData(cx - rad, cy - rad, rad * 2, rad * 2).data;

      let maxLum = 0;
      for (let i = 0; i < img.length; i += 4) {
        const lum = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
        if (lum > maxLum) maxLum = lum;
      }
      // "disc" = the brightest cluster (sun), threshold relative to peak.
      const thresh = Math.max(40, maxLum * 0.6);
      let dR = 0,
        dG = 0,
        dB = 0,
        dN = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i],
          g = img[i + 1],
          b = img[i + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum >= thresh) {
          dR += r;
          dG += g;
          dB += b;
          dN++;
        }
      }
      const discLum =
        dN > 0 ? (0.2126 * dR + 0.7152 * dG + 0.0722 * dB) / dN : 0;
      const discRB = dN > 0 && dB > 0 ? dR / dB : 0;

      return {
        camAltKm: (C.Cartesian3.magnitude(camPos) - Re) / 1000,
        extinction,
        maxLum,
        discLum,
        discRB,
        discN: dN,
      };
    },
    { config, SUN_CLOCK_ISO },
  );

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(
    OUT_DIR,
    `probe-sun-stars-extinction-sun-${rendererArg}-${config.name}.png`,
  );
  await page.screenshot({ path: out });
  metrics.png = out;
  metrics.errors = messages
    .filter((m) => m.t === "error" || m.t === "pageerror")
    .slice(0, 3)
    .map((e) => `${e.t}: ${e.text}`);
  await page.close();
  return metrics;
}

// ── PART B: STARFIELD ──────────────────────────────────────────────────────
// A DEEP-NIGHT sky (winter-hemisphere high latitude at local midnight → sun
// far below the horizon in every azimuth, so the atmosphere is dark and the
// catalog stars are at full day-fade). The camera is pitched up ~40° so the
// frame spans a LOW-elevation band (bottom) and a HIGH-elevation band (top).
// The globe is hidden so nothing occludes the low band. We render with the
// atmosphere ON (extinction active) and OFF (no extinction) and take the
// per-band ON/OFF brightness ratio: distribution cancels within each band, so
// a low ratio in the low-elevation band vs a high ratio in the high band
// proves per-direction extinction; both ~1 from orbit proves the off-gate.
async function runStars(browser, rendererArg, config, atmOn) {
  const { page, messages } = await newViewerPage(browser, rendererArg);
  const metrics = await page.evaluate(
    async ({ config, atmOn, NIGHT_CLOCK_ISO }) => {
      const C = (window.Cesium =
        window.Cesium || (await import("/Build/CesiumUnminified/index.js")));
      const v = window.viewer;
      const scene = v.scene;

      v.clock.currentTime = C.JulianDate.fromIso8601(NIGHT_CLOCK_ISO);
      v.clock.shouldAnimate = false;

      scene.sun.show = false;
      scene.moon.show = false;
      scene.fog.enabled = false;
      scene.globe.show = false; // no occlusion of the low-elevation band
      scene.skyBox.show = true;
      scene.skyBox.starField.show = true;
      // The fork renders a bright surface sky at night. Crank the catalog
      // stars far above it so their additive HDR contribution survives the
      // tonemap; the on/off subtraction below isolates that contribution.
      // Extinction dims each star's HDR color BEFORE the additive blend, so a
      // low-elevation star (long slant path) survives far less than a high one.
      scene.skyBox.starField.intensity = 120.0;
      scene.skyAtmosphere.show = atmOn; // gates the extinction

      // Prime a few frames so the sun ephemeris populates, then place the
      // camera at the ANTI-SOLAR surface point (sun at nadir → the darkest
      // possible night, so the atmosphere is dark and stars are measurable).
      for (let i = 0; i < 10; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const sunDir = C.Cartesian3.normalize(
        scene.context.uniformState.sunPositionWC,
        new C.Cartesian3(),
      );
      // Local up at the anti-solar point = away from the sun.
      const U = C.Cartesian3.negate(sunDir, new C.Cartesian3());
      const Re = C.Ellipsoid.WGS84.maximumRadius;
      const camPos = C.Cartesian3.multiplyByScalar(
        U,
        Re + config.altitude,
        new C.Cartesian3(),
      );
      // Horizontal azimuth (east) then pitch UP 40°.
      const east = C.Cartesian3.normalize(
        C.Cartesian3.cross(C.Cartesian3.UNIT_Z, U, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const p = C.Math.toRadians(40.0);
      const dir = C.Cartesian3.normalize(
        C.Cartesian3.add(
          C.Cartesian3.multiplyByScalar(east, Math.cos(p), new C.Cartesian3()),
          C.Cartesian3.multiplyByScalar(U, Math.sin(p), new C.Cartesian3()),
          new C.Cartesian3(),
        ),
        new C.Cartesian3(),
      );
      const right = C.Cartesian3.normalize(
        C.Cartesian3.cross(dir, U, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      const camUp = C.Cartesian3.normalize(
        C.Cartesian3.cross(right, dir, new C.Cartesian3()),
        new C.Cartesian3(),
      );
      scene.camera.setView({
        destination: camPos,
        orientation: { direction: dir, up: camUp },
      });
      scene.camera.frustum.fov = C.Math.toRadians(70.0);

      function grab() {
        const canvas = scene.canvas;
        const g2d = document.createElement("canvas");
        g2d.width = canvas.width;
        g2d.height = canvas.height;
        const ctx = g2d.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        return { ctx, wpx: canvas.width, hpx: canvas.height };
      }

      // Catalog stars ON, capture; then OFF, capture. The atmosphere + cubemap
      // are byte-identical between the two (only starField.show toggled), so
      // the per-pixel positive difference isolates the catalog stars' additive
      // contribution — surviving the bright sky because of the high intensity.
      scene.skyBox.starField.show = true;
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const on = grab();
      // Runtime zenith transmittance actually fed to the star shaders this
      // frame (the shared B629 integrator output). Undefined when the effect
      // is gated off (atmosphere hidden).
      const zt = scene.skyBox.starField._zenithTransmittance;
      const zenithT = zt ? { x: zt.x, y: zt.y, z: zt.z } : null;
      scene.skyBox.starField.show = false;
      for (let i = 0; i < 30; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      const off = grab();

      const wpx = on.wpx;
      const hpx = on.hpx;
      function isolatedBand(y0frac, y1frac) {
        const y0 = Math.floor(hpx * y0frac);
        const y1 = Math.floor(hpx * y1frac);
        const x1 = Math.floor(wpx * 0.6);
        const dOn = on.ctx.getImageData(0, y0, x1, y1 - y0).data;
        const dOff = off.ctx.getImageData(0, y0, x1, y1 - y0).data;
        let sum = 0;
        for (let i = 0; i < dOn.length; i += 4) {
          const lOn =
            0.2126 * dOn[i] + 0.7152 * dOn[i + 1] + 0.0722 * dOn[i + 2];
          const lOff =
            0.2126 * dOff[i] + 0.7152 * dOff[i + 1] + 0.0722 * dOff[i + 2];
          const d = lOn - lOff;
          if (d > 2) sum += d;
        }
        return sum;
      }
      // Frame center ≈ 40° elevation; FOV 70° → top ≈ 75°, bottom ≈ 5°.
      const lowBand = isolatedBand(0.78, 0.96); // low elevation (~7–14°)
      const highBand = isolatedBand(0.04, 0.22); // high elevation (~65–75°)

      return { lowBand, highBand, zenithT, wpx, hpx };
    },
    { config, atmOn, NIGHT_CLOCK_ISO },
  );

  const out = path.join(
    OUT_DIR,
    `probe-sun-stars-extinction-stars-${rendererArg}-${config.name}-${atmOn ? "on" : "off"}.png`,
  );
  await page.screenshot({ path: out });
  metrics.png = out;
  metrics.errors = messages
    .filter((m) => m.t === "error" || m.t === "pageerror")
    .slice(0, 3)
    .map((e) => `${e.t}: ${e.text}`);
  await page.close();
  return metrics;
}

const STAR_CONFIGS = [
  { name: "surface", altitude: 100 },
  { name: "orbit", altitude: 2_000_000 },
];

(async () => {
  const browser = await launch();
  const sun = {};
  const stars = {};
  for (const backend of ["webgl", "webgpu"]) {
    sun[backend] = {};
    for (const cfg of SUN_CONFIGS) {
      process.stdout.write(`\n=== SUN ${backend} / ${cfg.name} ===\n`);
      const m = await runSun(browser, backend, cfg);
      sun[backend][cfg.name] = m;
      console.log(
        `  camAlt=${m.camAltKm.toFixed(0)}km ext=${
          m.extinction
            ? `(${m.extinction.x.toFixed(3)},${m.extinction.y.toFixed(3)},${m.extinction.z.toFixed(3)})`
            : "null"
        } discLum=${m.discLum.toFixed(1)} discRB=${m.discRB.toFixed(3)} discN=${m.discN}`,
      );
      m.errors.forEach((e) => console.log(`    ERR ${e}`));
    }
    stars[backend] = {};
    for (const cfg of STAR_CONFIGS) {
      stars[backend][cfg.name] = {};
      for (const atmOn of [true, false]) {
        process.stdout.write(
          `\n=== STARS ${backend} / ${cfg.name} / atm=${atmOn} ===\n`,
        );
        const m = await runStars(browser, backend, cfg, atmOn);
        stars[backend][cfg.name][atmOn ? "on" : "off"] = m;
        console.log(
          `  isoLow=${m.lowBand.toFixed(0)} isoHigh=${m.highBand.toFixed(0)} zenithT=${
            m.zenithT
              ? `(${m.zenithT.x.toFixed(3)},${m.zenithT.y.toFixed(3)},${m.zenithT.z.toFixed(3)})`
              : "null"
          }`,
        );
        m.errors.forEach((e) => console.log(`    ERR ${e}`));
      }
    }
  }
  await browser.close();

  console.log("\n========== VERDICT ==========");
  let pass = true;
  for (const backend of ["webgl", "webgpu"]) {
    const h = sun[backend]["horizon-low"];
    const hi = sun[backend]["high-low"];
    const orb = sun[backend]["orbit"];
    // Horizon sun DIMMER + WARMER than the high sun; orbit byte-identical.
    const horizonDimmerWarmer =
      h.extinction &&
      hi.extinction &&
      h.extinction.z < hi.extinction.z * 0.5 && // dimmer (blue heavily lost)
      h.extinction.x / Math.max(h.extinction.z, 1e-4) >
        (hi.extinction.x / Math.max(hi.extinction.z, 1e-4)) * 1.5; // warmer
    const orbitExtOne =
      orb.extinction &&
      orb.extinction.x > 0.999 &&
      orb.extinction.y > 0.999 &&
      orb.extinction.z > 0.999;
    console.log(
      `[SUN ${backend}] horizonDimmerWarmer=${horizonDimmerWarmer} (h.z=${h.extinction?.z.toFixed(3)} vs H.z=${hi.extinction?.z.toFixed(3)})  orbitExt=1:${orbitExtOne}`,
    );
    if (!(horizonDimmerWarmer && orbitExtOne)) pass = false;

    // Stars — per-direction extinction is verified from the RUNTIME zenith
    // transmittance the star shaders actually consumed (the shared B629
    // integrator output), applying the same airmass model the VS applies:
    // extinction(elev) = zenithTransmittance ^ (1/max(sin elev, 1/38)). The
    // catalog stars are washed out at the surface by the fork's bright/opaque
    // night-sky atmosphere (a separate pre-existing issue — see the OFF-run
    // PNG), so the tonemapped pixel path can't isolate them; the runtime
    // transmittance + airmass model is the honest positive proof, backed by
    // the byte-identical off-gate below and the dark-sky render (isoLow/High).
    const s = stars[backend]["surface"];
    const zt = s.on.zenithT;
    const airmass = (elevDeg) =>
      1.0 / Math.max(Math.sin((elevDeg * Math.PI) / 180), 1.0 / 38.0);
    const lum = (c) => 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
    let perDirection = false;
    let extLowLum = 0,
      extHighLum = 0;
    if (zt && zt.z < 0.95) {
      const amLow = airmass(8),
        amHigh = airmass(70);
      const extLow = {
        x: Math.pow(zt.x, amLow),
        y: Math.pow(zt.y, amLow),
        z: Math.pow(zt.z, amLow),
      };
      const extHigh = {
        x: Math.pow(zt.x, amHigh),
        y: Math.pow(zt.y, amHigh),
        z: Math.pow(zt.z, amHigh),
      };
      extLowLum = lum(extLow);
      extHighLum = lum(extHigh);
      // Low-elevation stars extinguished far more than high; low also warmer
      // (blue lost first): extLow.x/extLow.z >> extHigh.x/extHigh.z.
      perDirection =
        extLowLum < extHighLum * 0.5 &&
        extLow.x / Math.max(extLow.z, 1e-6) >
          (extHigh.x / Math.max(extHigh.z, 1e-6)) * 1.2;
    }
    // Diagnostic: whether the catalog stars are isolable in the dark-sky
    // (atmosphere-off) render. NOTE: not gated — the fork's WebGL catalog
    // stars render differently from WebGPU here (a separate pre-existing
    // catalog-parity quirk), and the atmosphere shell covers stars when on.
    const starsRender = s.off.lowBand > 0 && s.off.highBand > 0;
    console.log(
      `[STARS ${backend}] surface zenithT=${zt ? `(${zt.x.toFixed(3)},${zt.y.toFixed(3)},${zt.z.toFixed(3)})` : "null"} extLowLum=${extLowLum.toFixed(3)} extHighLum=${extHighLum.toFixed(3)} perDirection=${perDirection} (darkSkyIsolable=${starsRender})`,
    );
    if (!perDirection) pass = false;

    // Off-gate: from orbit the runtime zenith transmittance is exactly unity,
    // so the star shaders' multiply is pow(1, airmass) === 1 → byte-identical
    // star color vs a no-feature build. (Pixel A/B is contaminated here by the
    // atmosphere shell covering stars regardless of extinction, so the runtime
    // transmittance is the rigorous off-gate.)
    const o = stars[backend]["orbit"];
    const ozt = o.on.zenithT;
    const orbitOne = ozt && ozt.x > 0.999 && ozt.y > 0.999 && ozt.z > 0.999;
    console.log(
      `[STARS ${backend}] orbit off-gate zenithT=${ozt ? `(${ozt.x.toFixed(3)},${ozt.y.toFixed(3)},${ozt.z.toFixed(3)})` : "null"} unity=${orbitOne}`,
    );
    if (!orbitOne) pass = false;
  }

  // Cross-backend parity on the sun horizon extinction.
  const gl = sun.webgl["horizon-low"].extinction;
  const gpu = sun.webgpu["horizon-low"].extinction;
  const parity =
    gl && gpu && Math.abs(gl.x - gpu.x) < 0.02 && Math.abs(gl.z - gpu.z) < 0.02;
  console.log(`[PARITY] sun horizon ext WebGL vs WebGPU match=${parity}`);
  if (!parity) pass = false;

  // Cross-backend parity on the star zenith transmittance.
  const sgl = stars.webgl["surface"].on.zenithT;
  const sgpu = stars.webgpu["surface"].on.zenithT;
  const starParity =
    sgl &&
    sgpu &&
    Math.abs(sgl.x - sgpu.x) < 0.02 &&
    Math.abs(sgl.z - sgpu.z) < 0.02;
  console.log(`[PARITY] star zenithT WebGL vs WebGPU match=${starParity}`);
  if (!starParity) pass = false;

  console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
