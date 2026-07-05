#!/usr/bin/env node
/**
 * TAKRAM-9 — cloud-aware god rays (WebGPU-only).
 *
 * The WebGPU god-ray generate pass historically gated the light shaft on scene
 * DEPTH alone: cloud pixels (which don't write depth) read as "sky" and leaked
 * their bright color into the shaft as if the sun were unobstructed. This batch
 * feeds the procedural cloud renderer's screen-space TRANSMITTANCE mask into the
 * god-ray pass so dense clouds attenuate the shaft (crepuscular rays that stream
 * through cloud gaps).
 *
 * Opt-in: `scene.godRayCloudAware = true` (needs `scene.godRayEnabled` AND
 * `globe.defaultCloudCollection.enableVolumetric`). Default OFF → the effect binds a 1×1 white
 * (r8unorm 255 → 1.0) fallback and the cloud renderer skips the mask pass, so
 * the render is byte-identical to the depth-only god rays.
 *
 * Claims:
 *   (1) SHAFTS EXIST — god-rays ON adds light vs OFF.
 *   (2) CLOUD-AWARE IS LIVE — cloudAware ON differs from cloudAware OFF.
 *   (3) CLOUD-AWARE DIMS — cloudAware ON is dimmer than OFF (clouds block the
 *       shaft instead of leaking cloud color as sky).
 *   (4) OFF IS DETERMINISTIC — cloudAware OFF rendered twice is identical.
 *   (5) The producer actually ran — cloud cache `maskRenderedThisFrame` is true
 *       only in the cloudAware-ON state.
 *   (6) No new WebGPU device errors.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-godray.mjs
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
// Low oblique view toward the horizon with the sun roughly ahead so the
// god-ray shaft crosses the cloudy sky band.
const LON = -95.0,
  LAT = 30.0,
  ALT = 2500.0;
const ISO = "2026-06-21T23:10:00Z"; // late afternoon — sun low & ahead (west)
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  // Clouds — moderate broken coverage so the shaft has gaps to stream through.
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudCoverage" in g) g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
  if ("cloudWeatherMap" in g) g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.defaultCloudCollection.volumetric.cloudDensity = 0.9;
  s.skyBox.show = false;
  s.skyAtmosphere.show = true;
  if (s.sun) s.sun.show = true;
  // God-ray config — bump exposure so the shaft is clearly measurable.
  s.godRayConfig = { exposure: 0.5, weight: 0.6, density: 0.97, decay: 0.96 };
  v.camera.setView({
    destination: window.Cesium
      ? window.Cesium.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT)
      : v.camera.position,
    orientation: {
      heading: window.Cesium.Math.toRadians(270.0), // face west toward the sun
      pitch: window.Cesium.Math.toRadians(2.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

// Render `state` and return { dataUrl, maskRendered }.
const RENDER_WITH = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  s.godRayEnabled = cfg.godRay === true;
  s.godRayCloudAware = cfg.cloudAware === true;
  for (let i = 0; i < 45; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  let maskRendered = false;
  try {
    maskRendered = !!s.context._cloudCache?.maskRenderedThisFrame;
  } catch (e) {
    maskRendered = false;
  }
  return { dataUrl: s.canvas.toDataURL("image/png"), maskRendered };
};

function meanLum(page, dataUrl) {
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
    let sum = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      n++;
    }
    return +(sum / n).toFixed(5);
  }, dataUrl);
}

async function diff(page, a, b) {
  return page.evaluate(
    async ([ua, ub]) => {
      const load = async (u) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        return cx.getImageData(0, 0, c.width, c.height).data;
      };
      const da = await load(ua),
        db = await load(ub);
      let acc = 0,
        n = da.length / 4;
      for (let i = 0; i < da.length; i += 4) {
        acc += Math.abs(
          (0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2]) -
            (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
        );
      }
      return +(acc / n).toFixed(4);
    },
    [a, b],
  );
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  // Expose Cesium for SETUP's camera helper.
  await page.evaluate(async () => {
    window.Cesium = await import("/Build/CesiumUnminified/index.js");
  });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  // 1) god rays OFF (clouds on) — baseline scene.
  const off = await page.evaluate(RENDER_WITH, {
    iso: ISO,
    godRay: false,
    cloudAware: false,
  });
  // 2) god rays ON, cloud-aware OFF (depth-only shaft).
  const grNoca = await page.evaluate(RENDER_WITH, {
    iso: ISO,
    godRay: true,
    cloudAware: false,
  });
  // 3) god rays ON, cloud-aware ON (transmittance-gated shaft).
  const grCa = await page.evaluate(RENDER_WITH, {
    iso: ISO,
    godRay: true,
    cloudAware: true,
  });
  // 4) back to cloud-aware OFF — determinism check.
  const grNoca2 = await page.evaluate(RENDER_WITH, {
    iso: ISO,
    godRay: true,
    cloudAware: false,
  });

  const save = (name, du) =>
    fs.writeFileSync(
      `${OUT}/cloud-godray-${name}.png`,
      Buffer.from(du.dataUrl.split(",")[1], "base64"),
    );
  save("off", off);
  save("gr-noca", grNoca);
  save("gr-ca", grCa);

  const mOff = await meanLum(page, off.dataUrl);
  const mNoca = await meanLum(page, grNoca.dataUrl);
  const mCa = await meanLum(page, grCa.dataUrl);

  const shaftDiff = await diff(page, off.dataUrl, grNoca.dataUrl);
  const caDiff = await diff(page, grNoca.dataUrl, grCa.dataUrl);
  const detDiff = await diff(page, grNoca.dataUrl, grNoca2.dataUrl);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));

  console.log("=== TAKRAM-9 cloud-aware god rays ===");
  console.log(`  meanLuma  off=${mOff}  gr(noca)=${mNoca}  gr(ca)=${mCa}`);
  console.log(`  shaftDiff (off vs gr-noca)      = ${shaftDiff}`);
  console.log(`  caDiff    (gr-noca vs gr-ca)    = ${caDiff}`);
  console.log(`  detDiff   (gr-noca vs gr-noca2) = ${detDiff}`);
  console.log(
    `  maskRendered: off=${off.maskRendered} noca=${grNoca.maskRendered} ca=${grCa.maskRendered}`,
  );
  if (newErrs.length) console.log("  NEW ERRORS:", newErrs.slice(0, 6));

  const checks = [
    [`(1) shafts exist (shaftDiff ${shaftDiff} > 0.2)`, shaftDiff > 0.2],
    [`(2) cloud-aware is LIVE (caDiff ${caDiff} > 0.05)`, caDiff > 0.05],
    [
      `(3) cloud-aware DIMS the shaft (gr-ca ${mCa} < gr-noca ${mNoca})`,
      mCa < mNoca,
    ],
    [`(4) OFF is deterministic (detDiff ${detDiff} <= 0.02)`, detDiff <= 0.02],
    [
      `(5) mask produced only when cloud-aware (ca=${grCa.maskRendered}, noca=${grNoca.maskRendered})`,
      grCa.maskRendered === true && grNoca.maskRendered === false,
    ],
    [`(6) no new device errors (${newErrs.length})`, newErrs.length === 0],
  ];
  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
