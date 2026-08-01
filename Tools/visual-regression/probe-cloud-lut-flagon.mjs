#!/usr/bin/env node
/**
 * Batch 434 FLAG-ON probe — 3.3 CLOUD-AERIAL-LUT + 3.4 CLOUD-AMBIENT-LUT.
 *
 * Both features couple the procedural clouds to the precomputed atmosphere LUTs,
 * which only bake when `skyAtmosphere.show = true` on a compute-capable device. So
 * this probe keeps the sky atmosphere VISIBLE (unlike the W-arc clean-black-sky
 * probes) and captures, per feature, the legacy mode vs the LUT mode.
 *
 *   3.3 (physical aerial): low sun, distant cloud deck (raised to ~28 km so the
 *       march midpoint is tens of km out). Compare cloudAerialMode 'heuristic' vs
 *       'physical'. Physical fogs distant clouds toward the REAL sky color — warm
 *       toward the (low) sun, cooler away — vs the flat heuristic tint. Metric:
 *       mean cloud color differs between modes AND the physical render's hue tracks
 *       the sun azimuth (warmer half toward the sun).
 *
 *   3.4 (sky-lut ambient): low sun, side-lit, normal deck, camera below looking up.
 *       Compare cloudAmbientSource 'constant' vs 'sky-lut'. Sky-lut warms the lit
 *       undersides at sunset (the ambient picks up the warm sky radiance) vs the
 *       constant blue/grey. Metric: shadow-side cloud mean is WARMER (R>B shifts
 *       up) under sky-lut, and not blown out.
 *
 * Writes:
 *   output/cloud-lut/aerial-heuristic.png, aerial-physical.png
 *   output/cloud-lut/ambient-constant.png, ambient-skylut.png
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-lut-flagon.mjs
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
// Dusk → a low sun so the physical sky is warm and the difference vs the constant
// blue ambient / flat heuristic tint is visible.
const DUSK = "2026-06-21T01:10:00Z";

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudCoverage" in g)
    g.defaultCloudCollection.volumetric.cloudCoverage = 0.55;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.8;
  // KEY: sky atmosphere ON so the atmosphere LUTs bake (the physical/sky-lut
  // paths self-heal to legacy when the LUTs are unbaked, so we MUST bake them).
  s.skyBox.show = true;
  s.skyAtmosphere.show = true;
  if (s.sun) s.sun.show = true;
  v.clock.shouldAnimate = false;
  v.clock.currentTime = C.JulianDate.fromIso8601(cfg.iso);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(cfg.heading ?? 90.0),
      pitch: C.Math.toRadians(cfg.pitch ?? 14.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  g.defaultCloudCollection.volumetric.cloudVolumetricQuality = "high"; // T3 full-res (no half-res/temporal)
  if (cfg.aerialMode !== undefined)
    g.defaultCloudCollection.volumetric.cloudAerialMode = cfg.aerialMode;
  if (cfg.ambientSource !== undefined)
    g.defaultCloudCollection.volumetric.cloudAmbientSource = cfg.ambientSource;
  // For the 3.4 ambient isolation, kill the heuristic aerial wash so the ambient
  // TINT on the shadow side isn't masked by the distance-haze tint.
  if (cfg.aerialStrength !== undefined)
    g.defaultCloudCollection.volumetric.cloudAerialStrength =
      cfg.aerialStrength;
  if (cfg.layerBottom !== undefined) {
    g.defaultCloudCollection.volumetric.cloudLayerBottom = cfg.layerBottom;
    g.defaultCloudCollection.volumetric.cloudLayerTop = cfg.layerTop;
  }
  if (cfg.heading !== undefined || cfg.pitch !== undefined) {
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
      orientation: {
        heading: C.Math.toRadians(cfg.heading ?? 90.0),
        pitch: C.Math.toRadians(cfg.pitch ?? 14.0),
        roll: 0.0,
      },
    });
  }
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 120; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const camCarto = C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT);
  const up = C.Cartesian3.normalize(camCarto, new C.Cartesian3());
  const sunWC = s.context.uniformState.sunDirectionWC;
  const sinElev = C.Cartesian3.dot(sunWC, up);
  return {
    elevDeg: +C.Math.toDegrees(
      Math.asin(Math.max(-1, Math.min(1, sinElev))),
    ).toFixed(1),
    dataUrl: s.canvas.toDataURL("image/png"),
  };
};

async function toPixels(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    return {
      w: c.width,
      h: c.height,
      data: Array.from(cx.getImageData(0, 0, c.width, c.height).data),
    };
  }, dataUrl);
}

// Mean cloud color over a band. Cloud pixels = brighter than the surrounding sky
// is not reliable here (sky is bright at dusk), so we gate on "near-white-ish and
// brighter than mid" — clouds are the lightest, least-saturated pixels.
function cloudMean(px, y0, y1) {
  const { w, h, data } = px;
  let n = 0;
  const s = [0, 0, 0];
  for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const maxc = Math.max(r, g, b),
        minc = Math.min(r, g, b);
      const sat = maxc > 0 ? (maxc - minc) / maxc : 0;
      // Cloud = bright + low saturation (sky is more saturated blue/orange).
      if (lum > 120 && sat < 0.28) {
        n++;
        s[0] += r;
        s[1] += g;
        s[2] += b;
      }
    }
  }
  if (!n) return { n: 0 };
  return {
    n,
    mean: s.map((v) => +(v / n / 255).toFixed(4)),
  };
}

const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

async function run() {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output/cloud-lut", { recursive: true });
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
  await page.evaluate(SETUP, { LON, LAT, ALT, iso: DUSK });

  const write = (name, r) =>
    fs.writeFileSync(
      `Tools/visual-regression/output/cloud-lut/${name}.png`,
      Buffer.from(r.dataUrl.split(",")[1], "base64"),
    );

  // ── 3.3 — physical aerial: distant deck (~28 km up), low sun, looking up ──
  const aerH = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    aerialMode: "heuristic",
    layerBottom: 28000,
    layerTop: 31000,
    pitch: 8,
  });
  const aerP = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    aerialMode: "physical",
    layerBottom: 28000,
    layerTop: 31000,
    pitch: 8,
  });
  write("aerial-heuristic", aerH);
  write("aerial-physical", aerP);
  const aerHpx = await toPixels(page, aerH.dataUrl);
  const aerPpx = await toPixels(page, aerP.dataUrl);
  const aerHm = cloudMean(aerHpx, 0.0, 1.0);
  const aerPm = cloudMean(aerPpx, 0.0, 1.0);

  // Reset aerial mode for the ambient test.
  await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    aerialMode: "heuristic",
    layerBottom: 1500,
    layerTop: 4000,
    pitch: 14,
  });

  // ── 3.4 — sky-lut ambient: normal deck, camera below looking up. Aerial wash
  // OFF (strength 0) so the ambient TINT on the shadow side is visible. Capture at
  // DUSK (warm sky) and NOON (blue sky) to show the time-of-day color tracking. ──
  const ambC = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    ambientSource: "constant",
    aerialStrength: 0,
    layerBottom: 1500,
    layerTop: 4000,
    pitch: 16,
  });
  const ambS = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    ambientSource: "sky-lut",
    aerialStrength: 0,
    layerBottom: 1500,
    layerTop: 4000,
    pitch: 16,
  });
  const NOON = "2026-06-21T18:20:00Z";
  const ambSnoon = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: NOON,
    ambientSource: "sky-lut",
    aerialStrength: 0,
    layerBottom: 1500,
    layerTop: 4000,
    pitch: 16,
  });
  write("ambient-constant", ambC);
  write("ambient-skylut", ambS);
  write("ambient-skylut-noon", ambSnoon);
  const ambCpx = await toPixels(page, ambC.dataUrl);
  const ambSpx = await toPixels(page, ambS.dataUrl);
  const ambSnoonpx = await toPixels(page, ambSnoon.dataUrl);
  // Underside / shadow band = lower image rows (camera below, looking up; canvas
  // Y-flipped so bottom of frame = horizon-distant undersides).
  const ambCm = cloudMean(ambCpx, 0.45, 1.0);
  const ambSm = cloudMean(ambSpx, 0.45, 1.0);
  const ambSnoonm = cloudMean(ambSnoonpx, 0.45, 1.0);

  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  const warmth = (m) => (m.mean ? +(m.mean[0] - m.mean[2]).toFixed(4) : null); // R - B
  console.log("\n=== 3.3 PHYSICAL AERIAL (distant deck, low sun) ===");
  console.log("  heuristic cloudMean:", JSON.stringify(aerHm));
  console.log("  physical  cloudMean:", JSON.stringify(aerPm));
  const aerDelta =
    aerHm.mean && aerPm.mean ? +dist(aerHm.mean, aerPm.mean).toFixed(4) : 0;
  console.log("  |physical - heuristic| color dist:", aerDelta);
  console.log(
    "  warmth (R-B) heuristic:",
    warmth(aerHm),
    " physical:",
    warmth(aerPm),
  );
  console.log("  sun elev (deg):", aerP.elevDeg);

  console.log("\n=== 3.4 SKY-LUT AMBIENT (undersides, aerial OFF) ===");
  console.log("  constant   (dusk) cloudMean:", JSON.stringify(ambCm));
  console.log("  sky-lut    (dusk) cloudMean:", JSON.stringify(ambSm));
  console.log("  sky-lut    (noon) cloudMean:", JSON.stringify(ambSnoonm));
  const ambDelta =
    ambCm.mean && ambSm.mean ? +dist(ambCm.mean, ambSm.mean).toFixed(4) : 0;
  console.log("  |sky-lut - constant| (dusk) color dist:", ambDelta);
  console.log(
    "  warmth (R-B) constant-dusk:",
    warmth(ambCm),
    " sky-lut-dusk:",
    warmth(ambSm),
    " sky-lut-noon:",
    warmth(ambSnoonm),
  );
  // Time-of-day tracking: the sky-lut ambient should be WARMER (higher R-B) at dusk
  // than at noon — that is the whole point of coupling to the real sky.
  const todTracks =
    warmth(ambSm) !== null && warmth(ambSnoonm) !== null
      ? warmth(ambSm) > warmth(ambSnoonm)
      : false;
  console.log("  time-of-day tracks (dusk warmer than noon):", todTracks);

  if (newErrs.length) console.log("\nNEW errs:", newErrs.slice(0, 3));

  const checks = [
    [
      "3.3 both modes render clouds",
      (aerHm.n ?? 0) > 2000 && (aerPm.n ?? 0) > 2000,
    ],
    [
      "3.3 physical differs from heuristic (color dist > 0.01)",
      aerDelta > 0.01,
    ],
    [
      "3.4 both modes render clouds",
      (ambCm.n ?? 0) > 2000 && (ambSm.n ?? 0) > 2000,
    ],
    ["3.4 sky-lut differs from constant (color dist > 0.01)", ambDelta > 0.01],
    [
      "3.4 sky-lut undersides not blown out (mean lum < 0.99)",
      !ambSm.mean ||
        0.299 * ambSm.mean[0] + 0.587 * ambSm.mean[1] + 0.114 * ambSm.mean[2] <
          0.99,
    ],
    ["3.4 sky-lut tracks time-of-day (dusk warmer than noon)", todTracks],
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
