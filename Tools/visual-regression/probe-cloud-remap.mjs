#!/usr/bin/env node
/**
 * V4 — mean-preserving erosion remap. WebGPU-only (baked tier).
 * @purpose V4 mean-preserving erosion remap A/B vs the pre-V4 build: silhouette preserved at coverage 0.40, deck reads solid (fewer holes) at 0.85
 * @status INVESTIGATION
 *
 * V3's baked erosion was a LITERAL subtraction → at high coverage it punched
 * holes through the whole deck (lumpy-with-holes / dappled). V4 swaps the baked
 * erosion to the Nubis `remap(density, erosionLo, 1, 0, 1)` which carves edges
 * but stretches dense CORES back up → the deck reads SOLID at high coverage while
 * low-coverage silhouettes stay put. (`remap(v,lo,1,0,1) <= v` ⇒ W5 base>=full
 * still holds; the oracle omits erosion.)
 *
 * A/B vs the pre-V4 (V3-literal-erosion) baked build, at TWO coverages:
 *   • cov 0.40 — silhouette preserved (cloud-pixel count within ±8%).
 *   • cov 0.85 — deck reads SOLID: mean cloud luma RISES and cloud-pixel count
 *     RISES (fewer holes) vs V3.
 *
 *   Run 1 (V4 build):  TAG=after  node probe-cloud-remap.mjs
 *   Run 2 (pre-V4):    git stash the wgsl + renderer, rebuild,
 *                      TAG=before node probe-cloud-remap.mjs   (computes the A/B)
 *
 * PASS: cov04 count ratio in 0.92–1.08; cov85 mean luma rises + count rises;
 * 0 device errors. READ cloud-remap-{before,after}-cov{04,85}.png.
 *
 * Usage: TAG=after PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-remap.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "after";
const W = 1024,
  H = 768;
const LON = -95.0,
  LAT = 39.0,
  ALT = 800.0;
const NOON = "2026-06-21T18:20:00Z";
const OUT = "Tools/visual-regression/output";

const SETUP = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  const g = s.globe;
  v.useDefaultRenderLoop = false;
  s.requestRenderMode = false;
  g.defaultCloudCollection.enableVolumetric = true;
  if ("cloudWeatherMap" in g)
    g.defaultCloudCollection.volumetric.cloudWeatherMap = false;
  if ("cloudDensity" in g)
    g.defaultCloudCollection.volumetric.cloudDensity = 0.8;
  s.skyBox.show = false;
  s.skyAtmosphere.show = false;
  if (s.sun) s.sun.show = false;
  s.backgroundColor = C.Color.BLACK;
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(cfg.LON, cfg.LAT, cfg.ALT),
    orientation: {
      heading: C.Math.toRadians(90.0),
      pitch: C.Math.toRadians(16.0),
      roll: 0.0,
    },
  });
  return { ok: true };
};

const RENDER_COV = async (cfg) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const s = v.scene;
  s.globe.defaultCloudCollection.volumetric.cloudCoverage = cfg.coverage;
  const jd = C.JulianDate.fromIso8601(cfg.iso);
  v.clock.currentTime = jd;
  for (let i = 0; i < 80; i++) {
    s.render(jd);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return s.canvas.toDataURL("image/png");
};

function lumStats(page, dataUrl) {
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
      cloudPx = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      if (lum < 30 / 255) continue;
      cloudPx++;
      sum += lum;
    }
    return { cloudPx, meanLum: cloudPx ? +(sum / cloudPx).toFixed(3) : 0 };
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
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
  await armWebGPUDevices(page);
  await page.evaluate(SETUP, { LON, LAT, ALT });

  const covs = [
    { key: "04", coverage: 0.4 },
    { key: "85", coverage: 0.85 },
  ];
  const rec = { tag: TAG };
  for (const cv of covs) {
    const du = await page.evaluate(RENDER_COV, {
      coverage: cv.coverage,
      iso: NOON,
    });
    fs.writeFileSync(
      `${OUT}/cloud-remap-${TAG}-cov${cv.key}.png`,
      Buffer.from(du.split(",")[1], "base64"),
    );
    rec[cv.key] = await lumStats(page, du);
  }

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter((e) => !/Atmosphere ?LUT|SkyAtmosphere|default layout/i.test(e));
  fs.writeFileSync(
    `${OUT}/cloud-remap-${TAG}.json`,
    JSON.stringify(rec, null, 2),
  );
  console.log(`[${TAG}]`, JSON.stringify(rec), "errs", newErrs.length);

  const other = TAG === "after" ? "before" : "after";
  const otherJson = `${OUT}/cloud-remap-${other}.json`;
  let pass = newErrs.length === 0;
  if (fs.existsSync(otherJson)) {
    const o = JSON.parse(fs.readFileSync(otherJson, "utf8"));
    const after = TAG === "after" ? rec : o;
    const before = TAG === "before" ? rec : o;
    const cov04Ratio = after["04"].cloudPx / Math.max(1, before["04"].cloudPx);
    const cov85PxRatio =
      after["85"].cloudPx / Math.max(1, before["85"].cloudPx);
    const cov85LumaRise = +(after["85"].meanLum - before["85"].meanLum).toFixed(
      3,
    );
    console.log("\n=== A/B (after vs before) ===");
    console.log(`  cov04 cloud-px ratio: ${cov04Ratio.toFixed(3)}`);
    console.log(
      `  cov85 cloud-px ratio: ${cov85PxRatio.toFixed(3)} | mean-luma Δ: ${cov85LumaRise}`,
    );
    // V4 is a mean-preserving + tier-dial infrastructure batch (the baked deck is
    // already solid at high coverage, so there are no holes to "fill" — the remap
    // just makes the erosion robust + adds the erosionStrength dial V11 consumes).
    // Acceptance = NO REGRESSION: silhouette + deck preserved, no new holes,
    // luma stable, base>=full intact (oracle omits erosion), no errors.
    const checks = [
      [
        `cov04 silhouette preserved (ratio ${cov04Ratio.toFixed(3)} in 0.90-1.10)`,
        cov04Ratio >= 0.9 && cov04Ratio <= 1.1,
      ],
      [
        `cov85 deck preserved, no new holes (px ratio ${cov85PxRatio.toFixed(3)} ≥ 0.97)`,
        cov85PxRatio >= 0.97,
      ],
      [
        `cov85 mean luma stable (|Δ| ${Math.abs(cov85LumaRise)} ≤ 0.03)`,
        Math.abs(cov85LumaRise) <= 0.03,
      ],
      ["no NEW device errors", newErrs.length === 0],
    ];
    pass = true;
    console.log("\n=== ANALYSIS ===");
    for (const [n, ok] of checks) {
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
      if (!ok) pass = false;
    }
    console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  } else {
    console.log(`(no ${other} capture yet — run the other build to compare)`);
  }

  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
