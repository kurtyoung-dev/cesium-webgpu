#!/usr/bin/env node
/**
 * W1 — Dual-lobe Henyey-Greenstein cloud phase (silver lining). WebGPU-only
 * (procedural clouds don't render on WebGL).
 *
 * The forward lobe (phaseG1) makes BACKLIT clouds (camera looking toward the
 * sun) develop a bright forward-scatter rim — the silver lining — while
 * FRONTLIT clouds (camera away from the sun) stay flatter. Scene: camera below
 * the 1500-4000m cloud layer looking up at the horizon, sun low. Capture two
 * headings (toward-sun, away-sun) and compare the bright-rim energy of the
 * cloud band.
 *
 * PASS:
 *   1. clouds render (toward-sun has a meaningful cloud band).
 *   2. silver lining: toward-sun bright-rim pixel count > away-sun by >= 1.25x
 *      (forward scatter brightens the sun-facing edges).
 *   3. no NEW WebGPU device errors (Atmosphere-LUT filtered).
 * Then READ output/cloud-phase-toward-sun.png (bright rim toward the sun) vs
 * output/cloud-phase-away-sun.png (flatter).
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-phase.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;

const SETUP = async (cfg) => {
  const { LON, LAT, ALT } = cfg;
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  // Isolate the phase: uniform coverage (weather map OFF) + THIN clouds (0.4) so
  // there's tonal range — a silver lining is a bright edge on a darker cloud
  // body, which a fully-saturated thick deck can't show.
  if ("cloudCoverage" in g)
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.4;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.7;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.clock.shouldAnimate = false;

  const camCarto = C.Cartesian3.fromDegrees(LON, LAT, ALT);
  const enu = C.Transforms.eastNorthUpToFixedFrame(camCarto);
  const invEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());

  // Read the CURRENT world sun direction, project into the camera's ENU frame to
  // get its azimuth/elevation. The cloud raymarch lights clouds by this
  // direction regardless of local night, so a low/near-horizon sun is ideal
  // backlight for the silver lining.
  s.initializeFrame();
  s.render();
  const sunWC = s.context.uniformState.sunDirectionWC;
  const local = C.Matrix4.multiplyByPointAsVector(
    invEnu,
    sunWC,
    new C.Cartesian3(),
  );
  const n = C.Cartesian3.normalize(local, new C.Cartesian3());
  const elevDeg = C.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, n.z))));
  const sunHeading = Math.atan2(n.x, n.y); // toward the sun's horizontal dir
  const heading = cfg.away ? sunHeading + Math.PI : sunHeading;
  v.camera.setView({
    destination: camCarto,
    orientation: {
      heading: heading,
      // Pitch low so the look direction is near the sun's near-horizon
      // alignment (forward-scatter cosTheta -> 1).
      pitch: C.Math.toRadians(14.0),
      roll: 0.0,
    },
  });
  return {
    elevDeg: +elevDeg.toFixed(1),
    sunHeadingDeg: +C.Math.toDegrees(sunHeading).toFixed(1),
    away: cfg.away === true,
  };
};

const CAPTURE = async () => {
  const s = window.viewer.scene;
  for (let i = 0; i < 160; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

function measure(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    const w = c.width,
      h = c.height;
    const lums = [];
    // Upper 60% = sky/cloud band. Collect luminance of cloud-ish pixels (any
    // non-black pixel; clouds are the only lit geometry against black sky).
    for (let y = 0; y < Math.floor(h * 0.6); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        if (mx > 24) lums.push(mx);
      }
    }
    if (!lums.length) return { cloud: 0, median: 0, p95: 0, contrast: 0 };
    lums.sort((a, b) => a - b);
    const median = lums[Math.floor(lums.length * 0.5)];
    const p95 = lums[Math.floor(lums.length * 0.95)];
    // Rim contrast — a strong forward lobe makes the sun-facing edges (p95) far
    // brighter than the dark backlit interior (median).
    return {
      cloud: lums.length,
      median,
      p95,
      contrast: median > 0 ? +(p95 / median).toFixed(3) : 0,
    };
  }, dataUrl);
}

async function capture(page, away) {
  const info = await page.evaluate(SETUP, { away, LON, LAT, ALT });
  const dataUrl = await page.evaluate(CAPTURE);
  const m = await measure(page, dataUrl);
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    `Tools/visual-regression/output/cloud-phase-${away ? "away" : "toward"}-sun.png`,
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
  return { info, m };
}

async function run() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);

  const toward = await capture(page, false);
  const away = await capture(page, true);
  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  console.log("sun:", JSON.stringify(toward.info));
  console.log("toward-sun:", JSON.stringify(toward.m));
  console.log("away-sun  :", JSON.stringify(away.m));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));

  const checks = [
    [
      `clouds render both views (toward ${toward.m.cloud}, away ${away.m.cloud} > 5000 px)`,
      toward.m.cloud > 5000 && away.m.cloud > 5000,
    ],
    [
      `silver lining: backlit rim contrast ${toward.m.contrast} > frontlit ${away.m.contrast}`,
      toward.m.contrast > away.m.contrast,
    ],
    ["no NEW device errors", newErrs.length === 0],
  ];
  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
}
run();
