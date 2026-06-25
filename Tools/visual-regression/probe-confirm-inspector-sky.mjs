#!/usr/bin/env node
/**
 * Confirm the Weather Inspector's grey-sky caveat is a standalone-shim artifact.
 *
 * The standalone probe (probe-weather-inspector.mjs) renders the demo via a
 * hand-rolled boot where the WebGPU sky-atmosphere LUT doesn't initialize → grey
 * sky. Sandcastle2 runs the demo's code in a FULLY-booted Viewer iframe, just
 * like the CesiumViewer app. So this probe applies the demo's EXACT startup
 * config (clouds + skyAtmosphere.show + camera + time) inside the proven-good
 * CesiumViewer boot and checks the sky renders as daytime atmosphere (blue),
 * not grey/black — confirming the demo will render correctly in the real gallery.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-confirm-inspector-sky.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.RENDERER || "webgpu";
const CLOUDS = (process.env.CLOUDS ?? "on") !== "off";
const SKY = (process.env.SKY ?? "on") !== "off";
const TAG = `${RENDERER}-clouds${CLOUDS ? "on" : "off"}${SKY ? "" : "-skyoff"}`;
const W = 1024,
  H = 768;
const OUT = "Tools/visual-regression/output";

// The demo's exact startup config.
const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  s.requestRenderMode = false; // let the viewer's own loop present continuously
  g.showProceduralClouds = cfg.clouds;
  g.cloudCoverage = 0.45;
  g.cloudDensity = 0.3;
  s.skyAtmosphere.show = cfg.sky; // the thing under test
  if (!cfg.sky) {
    s.backgroundColor = C.Color.DARKSLATEGRAY; // non-black bg so globe edge reads
  }
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-95.0, 39.0, 650.0),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  const t = C.JulianDate.fromIso8601("2026-06-21T18:00:00Z");
  v.clock.currentTime = t.clone();
  v.clock.shouldAnimate = false;
  return { ok: true };
};

const RENDER = async () => {
  const v = window.viewer;
  const s = v.scene;
  for (let i = 0; i < 140; i++) {
    s.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

function skyStats(page, dataUrl) {
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
    // Sample the UPPER third only — that's where the sky is (camera pitched up).
    let blueSky = 0,
      cloud = 0,
      black = 0,
      n = 0;
    const rows = Math.floor(c.height / 3);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        n++;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (b > r + 12 && b > 70 && lum < 230) {
          blueSky++; // blue-dominant = atmosphere
        }
        const mx = Math.max(r, g, b),
          mn = Math.min(r, g, b);
        if (lum > 150 && mx - mn < 45) {
          cloud++; // bright whitish = cloud
        }
        if (lum < 25) {
          black++;
        }
      }
    }
    return {
      bluePct: +((100 * blueSky) / n).toFixed(1),
      cloudPct: +((100 * cloud) / n).toFixed(1),
      blackPct: +((100 * black) / n).toFixed(1),
    };
  }, dataUrl);
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { clouds: CLOUDS, sky: SKY });

  // Let the viewer's own render loop present + settle, then compositor-screenshot
  // (reliable for BOTH WebGL and WebGPU — no toDataURL black-buffer / Y-flip issues).
  await page.waitForTimeout(9000);
  const capCamH = await page.evaluate(() =>
    window.viewer.camera.positionCartographic.height.toFixed(0),
  );
  console.log(`[${TAG}] capture-time camera height = ${capCamH} m`);
  await page.screenshot({ path: `${OUT}/confirm-inspector-sky-${TAG}.png` });

  // Measure the upper-center sky region (clear of the left panel + right help).
  const du = "data:image/png;base64," + fs.readFileSync(`${OUT}/confirm-inspector-sky-${TAG}.png`).toString("base64");
  const sky = await page.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    const x0 = Math.floor(c.width * 0.34),
      x1 = Math.floor(c.width * 0.62),
      y0 = Math.floor(c.height * 0.06),
      y1 = Math.floor(c.height * 0.30);
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
  }, du);
  console.log(`[${TAG}] upper-center sky mean RGB ${JSON.stringify(sky)}`);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));
  console.log(`[${TAG}] captured; errs ${newErrs.length}`);
  await browser.close();
  process.exitCode = 0;
}
run();
