#!/usr/bin/env node
/**
 * Batch 409 cloud depth-occlusion — A/B capture. WebGPU-only.
 *
 * Without depth occlusion the cloud raymarch ignores the scene depth buffer, so
 * the global cloud shell renders THROUGH the globe — far-side clouds (behind the
 * Earth) composite over the globe disc. The fix clamps the march at the scene's
 * (log-)depth so the Earth occludes them.
 *
 * This probe boots the WebGPU CesiumViewer, turns clouds on at high coverage,
 * frames an oblique view of the globe (disc + limb + space all visible), settles,
 * and compositor-screenshots. It measures the whitish-cloud fraction over the
 * GLOBE-DISC region. Run it twice (TAG=withfix vs TAG=nofix via git-stash) and
 * diff: the fix should REMOVE through-globe cloud bleed over the disc.
 *
 * Usage:
 *   TAG=withfix PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-depth-occlusion.mjs
 *   (git stash the depth changes, rebuild)
 *   TAG=nofix   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-cloud-depth-occlusion.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const TAG = process.env.TAG || "withfix";
const W = 1024,
  H = 768;
const OUT = "Tools/visual-regression/output";
const URL = `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`;

const SETUP = async () => {
  const v = window.viewer;
  const s = v.scene;
  s.requestRenderMode = false;
  const g = s.globe;
  g.showProceduralClouds = true;
  g.cloudCoverage = 0.9;
  g.cloudDensity = 0.5;
  // THICK TEST SHELL (80-400 km, not realistic) — makes the through-globe bleed
  // unmistakable from space: the near cap sits in front of the disc, the far cap
  // sits BEHIND the Earth (must be occluded), and a ring shows beyond the limb.
  g.cloudLayerBottom = 80000;
  g.cloudLayerTop = 400000;
  // Drive the clock to local noon over the framed point so the disc is LIT.
  v.clock.currentTime = window.Cesium.JulianDate.fromIso8601(
    "2026-06-21T15:00:00Z",
  );
  v.clock.shouldAnimate = false;
  // High nadir-ish view over a daylit point: the globe disc fills the frame,
  // space + the cloud ring around the limb are visible.
  v.camera.setView({
    destination: window.Cesium.Cartesian3.fromDegrees(-30.0, 20.0, 2.0e7),
    orientation: {
      heading: 0.0,
      pitch: window.Cesium.Math.toRadians(-90.0),
      roll: 0.0,
    },
  });
  s.requestRender();
  return { ok: true };
};

// Whitish-cloud fraction in the globe-disc region (centre band) + the whole
// frame, so we can see where the fix removed cloud.
function cloudFrac(page, dataUrl) {
  return page.evaluate(async (du) => {
    const img = new Image();
    img.src = du;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext("2d");
    cx.drawImage(img, 0, 0);
    function frac(x0, x1, y0, y1) {
      const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let cloud = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const mx = Math.max(r, g, b),
          mn = Math.min(r, g, b);
        // whitish cloud: bright + low saturation
        if (L > 150 && mx - mn < 40) {
          cloud++;
        }
        n++;
      }
      return +((100 * cloud) / n).toFixed(2);
    }
    return {
      disc: frac(
        Math.floor(c.width * 0.3),
        Math.floor(c.width * 0.7),
        Math.floor(c.height * 0.35),
        Math.floor(c.height * 0.8),
      ),
      full: frac(0, c.width, 0, c.height),
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
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!(window.viewer && window.viewer.scene), null, {
    timeout: 60000,
  });
  await armWebGPUDevices(page);
  await page.evaluate(async () => {
    if (!window.Cesium) {
      window.Cesium = await import("/Build/CesiumUnminified/index.js");
    }
  });
  await page.evaluate(SETUP);
  await page.waitForTimeout(9000);

  const canvas = await page.$(".cesium-widget canvas");
  await canvas.screenshot({ path: `${OUT}/depth-occ-${TAG}.png` });
  const du =
    "data:image/png;base64," +
    fs.readFileSync(`${OUT}/depth-occ-${TAG}.png`).toString("base64");
  const frac = await cloudFrac(page, du);

  const gate = await collectGateErrors(page);
  const newErrs = (gate.errors || [])
    .concat(consoleErrors)
    .filter(
      (e) =>
        !/Atmosphere ?LUT|SkyAtmosphere|default layout|favicon/i.test(e),
    );

  console.log(`TAG=${TAG} cloud%% disc=${frac.disc} full=${frac.full} errs=${newErrs.length}`);

  // Single-run sanity gate (no-regression): the cloud pass still renders the
  // deck over the lit globe with the depth fix, no device errors. The OCCLUSION
  // behaviour itself is proven by the A/B (TAG=withfix vs TAG=nofix via git-stash
  // + READ the depth-occ-*.png) + the sky-view-unchanged check (probe-cloud-
  // diagonal stays GREEN: sky pixels carry far depth so the tEnd clamp is a no-op
  // there). A wrong reconstruction would clip the sky clouds too — it doesn't.
  const checks = [
    [`clouds render over the lit globe (full ${frac.full}% > 0.3)`, frac.full > 0.3],
    [`no NEW device errors (${newErrs.length})`, newErrs.length === 0],
  ];
  let pass = true;
  for (const [n, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}`);
    if (!ok) {
      pass = false;
    }
  }
  console.log(`RESULT: ${pass ? "GREEN" : "RED"}`);
  await browser.close();
  process.exitCode = pass ? 0 : 1;
}
run();
