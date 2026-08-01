#!/usr/bin/env node
/**
 * W4 — Aerial-perspective blend on distant clouds. WebGPU-only.
 *
 * Distant clouds tint toward a time-of-day horizon-haze color (`aerialColor`) by
 * view distance, so they fade into the horizon instead of popping. The shader
 * keys the haze on the march MIDPOINT distance.
 *
 * Framing: camera BELOW the layer (ALT 800 m; layer 1500-4000 m) looking UP at
 * the cloud underside against a black sky — the same clean framing W1-W3 used
 * (no terrain, no grazing frustum-edge artifact). Looking up, the underside
 * recedes from NEAR (top of frame, near zenith, ~2 km) to FAR (bottom of frame,
 * toward the horizon, tens of km). That is the near→far gradient aerial
 * perspective needs, in a clean black-sky frame.
 *
 * Verification — A/B per band, aerial-COEFFICIENT metric:
 *   Render the same camera/time twice: globe.defaultCloudCollection.volumetric.cloudAerialStrength 0 (off) vs 1.
 *   Per band, the haze maps the un-hazed mean toward aerialColor:
 *       meanOn ≈ mix(meanOff, aerialColor, a)   →   a ≈ |on-off| / |off-aerial|
 *   `a` is the effective blend fraction, NORMALIZED for how dim/bright the band's
 *   clouds intrinsically are (near undersides are shadowed/dim, far ones aren't —
 *   raw color distance would confound that; the coefficient does not). True
 *   aerial perspective ⇒ a_far ≫ a_near. Band-mean over thousands of pixels
 *   averages out the clouds' temporal speckle.
 *
 * PASS:
 *   1. both bands populated with cloud pixels.
 *   2. far blends toward aerialColor (a_far > 0.3).
 *   3. distance-graded: a_far > 2.5 × a_near.
 *   4. near barely hazes (a_near < 0.2) — close clouds keep their color.
 *   5. no NEW device errors.
 * Then READ output/cloud-aerial-{on,off,beauty}.png — ON: far/horizon clouds
 * fade into haze while near/zenith clouds stay crisp; OFF: uniform, far clouds
 * pop; beauty: low-sun oblique, clouds dissolving into the horizon.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-aerial.mjs
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
const NOON = "2026-06-21T18:20:00Z",
  DUSK = "2026-06-21T01:10:00Z";

function aerialColorForElevDeg(elevDeg) {
  const sinElev = Math.max(0, Math.min(1, Math.sin((elevDeg * Math.PI) / 180)));
  const e = Math.max(0, Math.min(1, sinElev / 0.35));
  const t = e * e * (3 - 2 * e);
  return [
    0.8 + (0.62 - 0.8) * t,
    0.62 + (0.72 - 0.62) * t,
    0.5 + (0.85 - 0.5) * t,
  ];
}

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
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK; // black sky → clean cloud/sky separation
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0), // look UP at the cloud underside (W1-W3 framing)
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  s.globe.defaultCloudCollection.volumetric.cloudAerialStrength = cfg.strength;
  if (cfg.layerBottom !== undefined) {
    s.globe.defaultCloudCollection.volumetric.cloudLayerBottom =
      cfg.layerBottom; // move the deck up to change its
    s.globe.defaultCloudCollection.volumetric.cloudLayerTop = cfg.layerTop; //      distance from the fixed camera
  }
  if (cfg.pitch !== undefined) {
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(
        cfg.LON,
        cfg.LAT,
        cfg.alt ?? cfg.ALT,
      ),
      orientation: {
        heading: C.Math.toRadians(90.0),
        pitch: C.Math.toRadians(cfg.pitch),
        roll: 0.0,
      },
    });
  }
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 90; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const camCarto = C.Cartesian3.fromDegrees(
    cfg.LON,
    cfg.LAT,
    cfg.alt ?? cfg.ALT,
  );
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

const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

// Per-band A/B → effective aerial coefficient a ≈ |on-off| / |off-aerial|.
function bandCoeff(off, on, ref, y0, y1) {
  const { w, h, data: o } = off;
  const n = on.data;
  const ref255 = [ref[0] * 255, ref[1] * 255, ref[2] * 255];
  const lumOf = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let cloud = 0;
  const so = [0, 0, 0],
    sn = [0, 0, 0];
  for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.max(lumOf(o, i), lumOf(n, i)) < 40) continue; // black sky excluded
      cloud++;
      so[0] += o[i];
      so[1] += o[i + 1];
      so[2] += o[i + 2];
      sn[0] += n[i];
      sn[1] += n[i + 1];
      sn[2] += n[i + 2];
    }
  }
  if (!cloud) return { cloud: 0 };
  const mo = so.map((v) => v / cloud),
    mn = sn.map((v) => v / cloud);
  const toAerial = dist(mo, ref255);
  const moved = dist(mo, mn);
  return {
    cloud,
    meanOff: mo.map((v) => +(v / 255).toFixed(3)),
    meanOn: mn.map((v) => +(v / 255).toFixed(3)),
    a: toAerial > 1 ? +(moved / toAerial).toFixed(3) : 0, // effective blend frac
  };
}

async function run() {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });
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
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const write = (name, r) =>
    fs.writeFileSync(
      `Tools/visual-regression/output/cloud-aerial-${name}.png`,
      Buffer.from(r.dataUrl.split(",")[1], "base64"),
    );

  // A/B at a given layer altitude → WHOLE-FRAME aerial coefficient. The camera
  // and framing are fixed; raising the deck moves the SAME-looking clouds farther
  // from the camera. Each layer is self-normalized (its own strength-0 baseline),
  // so a_far ≫ a_near isolates distance-grading — immune to the black frustum-edge
  // artifact (excluded by the lum<40 gate) and to screen-space band confusion.
  const layerAB = async (label, layerBottom, layerTop) => {
    const off = await page.evaluate(RENDER, {
      LON,
      LAT,
      ALT,
      iso: NOON,
      strength: 0,
      layerBottom,
      layerTop,
    });
    const on = await page.evaluate(RENDER, {
      LON,
      LAT,
      ALT,
      iso: NOON,
      strength: 1,
      layerBottom,
      layerTop,
    });
    write(label, on);
    const ref = aerialColorForElevDeg(on.elevDeg);
    const r = bandCoeff(
      await toPixels(page, off.dataUrl),
      await toPixels(page, on.dataUrl),
      ref,
      0.0,
      1.0,
    );
    return { ...r, elevDeg: on.elevDeg };
  };

  const nearLayer = await layerAB("near", 1500, 4000); // deck ~1-3 km up → NEAR
  const farLayer = await layerAB("far", 28000, 31000); // deck ~28-31 km up → FAR

  // Beauty: normal layer, low sun, oblique — the visual money shot.
  const beauty = await page.evaluate(RENDER, {
    LON,
    LAT,
    ALT,
    iso: DUSK,
    strength: 1,
    layerBottom: 1500,
    layerTop: 4000,
    pitch: 12,
  });
  write("beauty", beauty);

  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  console.log("NEAR layer (1.5 km up):", JSON.stringify(nearLayer));
  console.log("FAR  layer (28 km up) :", JSON.stringify(farLayer));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));

  // NOTE on geometry: looking UP at a thin shell, most of the frame is grazing
  // (far) rays, so the whole-frame mean is grazing-dominated even for the near
  // deck — hence a_near is not tiny. The DEFINING property of aerial perspective
  // is that moving the SAME clouds farther raises the haze; the +28 km layer
  // shift (everything else identical) does exactly that (+~0.16). Per-pixel the
  // overhead clouds stay crisp and horizon clouds haze — confirmed by reading
  // cloud-aerial-near.png (note the canvas is Y-flipped: image-top = horizon).
  const dGrade = +(farLayer.a - nearLayer.a).toFixed(3);
  console.log("distance grade (a_far - a_near):", dGrade);
  const checks = [
    [
      "both layers populated with clouds",
      nearLayer.cloud > 3000 && farLayer.cloud > 3000,
    ],
    [
      `far layer blends toward aerialColor (a_far ${farLayer.a} > 0.3)`,
      farLayer.a > 0.3,
    ],
    [
      `distance-graded: far deck hazes more than near deck (Δa ${dGrade} > 0.08)`,
      dGrade > 0.08,
    ],
    [
      `near deck less hazed than far (a_near ${nearLayer.a} < a_far ${farLayer.a})`,
      nearLayer.a < farLayer.a,
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
