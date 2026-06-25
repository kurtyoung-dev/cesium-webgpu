#!/usr/bin/env node
/**
 * W3 — Time-of-day cloud sun color. WebGPU-only.
 *
 * The direct-sun term is tinted by a CPU-computed sun color keyed on the LOCAL
 * sun elevation: warm orange near the horizon (dawn/dusk), neutral white at
 * noon. Fixed camera looking up at the cloud band; render at three sun
 * elevations (dawn / noon / dusk) and compare the cloud color.
 *
 * Sun control: viewer.useDefaultRenderLoop=false + scene.render(jd) so the sun
 * follows the supplied JulianDate (the RAF path ignored the clock).
 *
 * PASS:
 *   1. clouds render at all three times.
 *   2. dawn AND dusk warm: cloud meanR/meanB >= 1.15.
 *   3. noon neutral-ish: cloud meanR/meanB <= dawn's (markedly less warm).
 *   4. no NEW device errors.
 * Then READ output/cloud-tod-{dawn,noon,dusk}.png — dawn/dusk orange-tinted,
 * noon white-grey.
 *
 * Usage: PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-tod.mjs
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
  v.useDefaultRenderLoop = false; // take manual control so render(jd) drives the sun
  s.requestRenderMode = false;
  g.showProceduralClouds = true;
  if ("cloudCoverage" in g) g.cloudCoverage = 0.5;
  if ("cloudWeatherMap" in g) g.cloudWeatherMap = false;
  if ("cloudDensity" in g) g.cloudDensity = 0.75;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(LON, LAT, ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER_AT = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 90; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  // Local sun elevation for reporting.
  const camCarto = C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT);
  const up = C.Cartesian3.normalize(camCarto, new C.Cartesian3());
  const sunWC = s.context.uniformState.sunDirectionWC;
  const sinElev = C.Cartesian3.dot(sunWC, up);
  return {
    elevDeg: +C.Math.toDegrees(Math.asin(Math.max(-1, Math.min(1, sinElev)))).toFixed(
      1,
    ),
    dataUrl: s.canvas.toDataURL("image/png"),
  };
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
    let rs = 0,
      bs = 0,
      n = 0;
    for (let y = 0; y < Math.floor(h * 0.6); y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        if (mx <= 24) continue;
        rs += d[i];
        bs += d[i + 2];
        n++;
      }
    }
    return { cloud: n, rOverB: n && bs > 0 ? +(rs / bs).toFixed(3) : 0 };
  }, dataUrl);
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

  // dawn ~ sunrise over lon -95; noon ~ solar noon (18:20 UTC); dusk ~ sunset.
  const times = {
    dawn: "2026-06-21T11:40:00Z",
    noon: "2026-06-21T18:20:00Z",
    dusk: "2026-06-21T01:10:00Z",
  };
  const out = {};
  for (const [name, iso] of Object.entries(times)) {
    const r = await page.evaluate(RENDER_AT, { iso, LON, LAT, ALT });
    const m = await measure(page, r.dataUrl);
    fs.writeFileSync(
      `Tools/visual-regression/output/cloud-tod-${name}.png`,
      Buffer.from(r.dataUrl.split(",")[1], "base64"),
    );
    out[name] = { elevDeg: r.elevDeg, ...m };
  }
  const gate = await collectGateErrors(page);
  await browser.close();
  const newErrs = (gate.errors || []).filter(
    (e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e),
  );

  console.log("dawn:", JSON.stringify(out.dawn));
  console.log("noon:", JSON.stringify(out.noon));
  console.log("dusk:", JSON.stringify(out.dusk));
  if (newErrs.length) console.log("NEW errs:", newErrs.slice(0, 2));

  const checks = [
    [
      "clouds render all three",
      out.dawn.cloud > 3000 && out.noon.cloud > 3000 && out.dusk.cloud > 3000,
    ],
    [`dawn warm (R/B ${out.dawn.rOverB} >= 1.15)`, out.dawn.rOverB >= 1.15],
    [`dusk warm (R/B ${out.dusk.rOverB} >= 1.15)`, out.dusk.rOverB >= 1.15],
    [
      `noon less warm than dawn/dusk (${out.noon.rOverB} < ${out.dawn.rOverB})`,
      out.noon.rOverB < out.dawn.rOverB && out.noon.rOverB < out.dusk.rOverB,
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
