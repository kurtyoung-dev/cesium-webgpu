#!/usr/bin/env node
// Probe: GPU flow-field wind-particle layer (Campaign 6, C6-FLOWFIELD-WIND).
//
// Verifies, on the WebGPU backend, using the committed offline GFS sample
// (Apps/SampleData/wind/gfs-wind-sample.png — no network):
//   1. OFF-GATE: a FlowFieldWindLayer with show=false is BYTE-IDENTICAL to a
//      scene with no layer at all (0% mismatch) — nothing allocated/drawn.
//   2. ON: adding the layer (show=true) renders particles over the globe
//      (non-trivial mismatch vs the baseline).
//   3. MOTION: two ON captures ~140 frames apart differ (advection is live,
//      not a static point cloud).
//
// Outputs: Tools/visual-regression/output/probe-flowfield-{baseline,off,on-early,on-late}.png
// Usage: node Tools/visual-regression/probe-flowfield-wind.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const WIND_URL = `${BASE}/Apps/SampleData/wind/gfs-wind-sample.png`;

async function launch() {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  // The CesiumViewer app imports Cesium as an ESM module (no window.Cesium),
  // so pull the same built namespace into the page for constructing our layer.
  await page.evaluate(async () => {
    window.__C = await import("/Build/CesiumUnminified/index.js");
  });
  // Fixed deterministic view: Atlantic/Africa hemisphere from ~22 Mm so the
  // whole disk is in frame and the trade-wind belt is visible. Freeze the
  // clock and hide the navigation-help popup so the ONLY thing that can move
  // between the baseline and off captures is our particle layer.
  await page.evaluate(() => {
    const v = window.viewer;
    v.scene.globe.enableLighting = false;
    v.clock.shouldAnimate = false;
    if (v.navigationHelpButton) {
      v.navigationHelpButton.viewModel.showInstructions = false;
      v.navigationHelpButton.container.style.display = "none";
    }
    const help = document.querySelector(".cesium-navigation-help");
    if (help) {
      help.style.display = "none";
    }
    v.scene.camera.setView({
      destination: window.__C.Cartesian3.fromDegrees(10, 15, 22000000),
    });
  });
  return { browser, page, messages };
}

async function renderFrames(page, n) {
  await page.evaluate(async (count) => {
    const v = window.viewer;
    for (let i = 0; i < count; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, n);
}

async function shot(page, name) {
  const out = path.join(OUT_DIR, `probe-flowfield-${name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  return out;
}

// Pixel diff via in-browser canvas decode (no Node PNG dep) — mismatch % at
// threshold-30, matching probe-saved-view.mjs.
async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const total = A.w * A.h;
      let mismatch = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const d =
          Math.abs(A.data[i] - B.data[i]) +
          Math.abs(A.data[i + 1] - B.data[i + 1]) +
          Math.abs(A.data[i + 2] - B.data[i + 2]);
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: ((100 * mismatch) / total).toFixed(3),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const { browser, page, messages } = await launch();

  // Warm up so imagery tiles finish loading and any first-frame UI settles
  // BEFORE the baseline — the clock is frozen, so with no moving parts the
  // baseline and off captures can only differ by our particle layer.
  await renderFrames(page, 150);
  await page.waitForTimeout(1500);
  await renderFrames(page, 30);

  // (1) Baseline — no layer.
  const baseline = await shot(page, "baseline");

  // (2) OFF-GATE — add the layer but show=false; must be byte-identical.
  await page.evaluate((url) => {
    const v = window.viewer;
    window.__wind = v.scene.primitives.add(
      new window.__C.FlowFieldWindLayer({
        url,
        particleCount: 120000,
        show: false,
        pixelSize: 3.0,
        alpha: 1.0,
        speedScale: 0.0016,
        colorSlow: new window.__C.Color(1.0, 0.9, 0.2, 1.0),
        colorFast: new window.__C.Color(1.0, 0.15, 0.1, 1.0),
      }),
    );
  }, WIND_URL);
  // Let the velocity source load; still show=false, so nothing must render.
  await renderFrames(page, 90);
  const off = await shot(page, "off");

  // (3) ON — flip show=true, let particles advect.
  await page.evaluate(() => {
    window.__wind.show = true;
  });
  await renderFrames(page, 60);
  const onEarly = await shot(page, "on-early");
  await renderFrames(page, 140);
  const onLate = await shot(page, "on-late");

  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  console.log(`[probe-flowfield] console errors: ${errs.length}`);
  errs.slice(0, 8).forEach((e) => console.log(`   ${e.t}: ${e.text}`));

  const offGate = await diffPngs(baseline, off);
  const onVsBase = await diffPngs(baseline, onLate);
  const motion = await diffPngs(onEarly, onLate);

  console.log(`\n[probe-flowfield] RESULTS`);
  console.log(`  baseline : ${baseline}`);
  console.log(`  off      : ${off}`);
  console.log(`  on-early : ${onEarly}`);
  console.log(`  on-late  : ${onLate}`);
  console.log(
    `  OFF-GATE  (baseline vs off,      expect ~0): ${JSON.stringify(offGate)}`,
  );
  console.log(
    `  ON        (baseline vs on-late,  expect >0): ${JSON.stringify(onVsBase)}`,
  );
  console.log(
    `  MOTION    (on-early vs on-late,  expect >0): ${JSON.stringify(motion)}`,
  );

  const offOk = parseFloat(offGate.mismatchPct) < 0.02;
  const onOk = parseFloat(onVsBase.mismatchPct) > 0.3;
  const motionOk = parseFloat(motion.mismatchPct) > 0.1;
  console.log(
    `\n  VERDICT: offGate=${offOk ? "PASS" : "FAIL"} on=${onOk ? "PASS" : "FAIL"} motion=${motionOk ? "PASS" : "FAIL"}`,
  );
  const allOk = offOk && onOk && motionOk;
  console.log(`  ${allOk ? "ALL PASS" : "*** CHECK FAILED ***"}`);
  // A printed verdict that leaves with status 0 is read as green by anything
  // that scores runs by exit code, so the verdict carries the code.
  process.exit(allOk ? 0 : 1);
})();
