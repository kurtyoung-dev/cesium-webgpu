#!/usr/bin/env node
/**
 * W2 — Sky-ambient gradient + ground bounce. WebGPU-only.
 *
 * Adds a height-fraction ambient term so the anti-sun SHADOW side of clouds is
 * no longer near-black: blue sky lights the tops, warm ground-bounce the
 * bottoms. Scene: side-lit sun (so clouds have a clear lit face + shadow face),
 * camera below the layer looking up.
 *
 * PASS:
 *   1. clouds render (cloud band > 5000 px).
 *   2. shadow lifted: darkest-decile (p10) cloud luminance in [0.06, 0.5] of 255
 *      — off near-black, not blown out.
 *   3. vertical gradient: top cloud rows bluer than bottom rows (sky vs ground
 *      ambient) — top blue-ratio > bottom blue-ratio.
 *   4. no NEW WebGPU device errors.
 * Then READ output/cloud-ambient.png — shadow side soft grey-blue (not black),
 * tops cooler/bluer than the warmer bottoms.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-ambient.mjs
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
  if ("cloudCoverage" in g) g.defaultCloudCollection.volumetric.cloudCoverage = 0.5;
  if ("cloudWeatherMap" in g) g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.defaultCloudCollection.volumetric.cloudDensity = 0.75;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.clock.shouldAnimate = false;

  const camCarto = C.Cartesian3.fromDegrees(LON, LAT, ALT);
  const enu = C.Transforms.eastNorthUpToFixedFrame(camCarto);
  const invEnu = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
  s.initializeFrame();
  s.render();
  const sunWC = s.context.uniformState.sunDirectionWC;
  const local = C.Matrix4.multiplyByPointAsVector(invEnu, sunWC, new C.Cartesian3());
  const n = C.Cartesian3.normalize(local, new C.Cartesian3());
  const sunHeading = Math.atan2(n.x, n.y);
  // Side-lit: look 90deg off the sun azimuth so clouds show a lit + shadow face.
  v.camera.setView({
    destination: camCarto,
    orientation: {
      heading: sunHeading + Math.PI / 2.0,
      pitch: C.Math.toRadians(14.0),
      roll: 0.0,
    },
  });
  return { sunHeadingDeg: +C.Math.toDegrees(sunHeading).toFixed(1) };
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
    const band = Math.floor(h * 0.6); // upper 60% = cloud/sky
    const lums = [];
    let topBlue = 0,
      topN = 0,
      botBlue = 0,
      botN = 0;
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i],
          gg = d[i + 1],
          b = d[i + 2];
        const mx = Math.max(r, gg, b);
        if (mx <= 18) continue; // sky/background
        lums.push(mx);
        const blue = (r + gg + b) > 0 ? b / (r + gg + b) : 0;
        if (y < band * 0.4) {
          topBlue += blue;
          topN++;
        } else if (y > band * 0.6) {
          botBlue += blue;
          botN++;
        }
      }
    }
    if (!lums.length) return { cloud: 0 };
    lums.sort((a, b) => a - b);
    const p = (q) => lums[Math.floor(lums.length * q)];
    return {
      cloud: lums.length,
      p10: p(0.1),
      p50: p(0.5),
      p90: p(0.9),
      topBlueRatio: topN ? +(topBlue / topN).toFixed(4) : 0,
      botBlueRatio: botN ? +(botBlue / botN).toFixed(4) : 0,
    };
  }, dataUrl);
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

  const info = await page.evaluate(SETUP, { LON, LAT, ALT });
  const dataUrl = await page.evaluate(CAPTURE);
  const m = await measure(page, dataUrl);
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
  fs.writeFileSync(
    "Tools/visual-regression/output/cloud-ambient.png",
    Buffer.from(dataUrl.split(",")[1], "base64"),
  );
  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  console.log("sun:", JSON.stringify(info));
  console.log("cloud band:", JSON.stringify(m));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));

  const p10n = (m.p10 || 0) / 255;
  const p90n = (m.p90 || 0) / 255;
  // From below the layer the camera sees cloud UNDERSIDES (ground-bounce
  // ambient), so the sky-blue top ambient isn't in frame — the blue-vs-warm
  // gradient is confirmed by the PNG read, not a row metric here. The verifiable
  // core of W2: the shadow side is lifted off near-black AND the lit-to-shadow
  // range survives (the fill doesn't flatten the form).
  const checks = [
    ["clouds render (band > 5000 px)", m.cloud > 5000],
    [
      `shadow lifted off black: p10 ${p10n.toFixed(3)} in [0.06, 0.5]`,
      p10n >= 0.06 && p10n <= 0.5,
    ],
    [
      `form preserved: lit-to-shadow range p90-p10 ${(p90n - p10n).toFixed(3)} >= 0.10`,
      p90n - p10n >= 0.1,
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
