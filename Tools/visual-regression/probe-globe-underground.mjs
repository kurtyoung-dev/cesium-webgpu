#!/usr/bin/env node
// Probe: GLOBE-UNDERGROUND-COLOR — globe.undergroundColor +
// undergroundColorAlphaByDistance tint parity (WebGL vs WebGPU).
// @purpose globe.undergroundColor + alphaByDistance tint parity: above-ground off-gate plus red-tint and default underground camera scenarios
// @status ACTIVE
//
// Scenarios:
//   above-default    — default load, camera above ground, default underground
//                      settings. OFF-GATE: the underground blend must not
//                      engage; WebGL/WebGPU diff must match the standing
//                      globe-default parity (no new artifact).
//   underground-red  — camera 30 km below the surface with a red
//                      undergroundColor + a custom alpha-by-distance ramp.
//                      ACCEPTANCE: WebGPU tint must match WebGL.
//   underground-def  — camera underground with the DEFAULT (black)
//                      undergroundColor + default NearFarScalar ramp.
//                      Parity check for the upstream-default underground look.
//
// Usage: node Tools/visual-regression/probe-globe-underground.mjs
// Outputs: Tools/visual-regression/output/probe-globe-underground-*.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  DET_BROWSER_SETUP,
  DETERMINISTIC_CLOCK_ISO,
  nRunMedian,
  runCount,
} from "./lib/determinism-kit.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
// Q7-PROBE-DETERMINISM: pin the clock + damp the sky + settle-to-steady-state
// so the run-to-run star-twinkle / tile-LOD drift (audit: underground 12.28 vs
// 6.75 on unchanged builds) collapses. PROBE_RUNS>1 additionally medians the
// metric over N runs.
const N_RUNS = runCount(1);

// Camera 30 km below the surface near Philadelphia, looking gently upward
// so the frame contains both the nearby underside of the terrain shell
// (short v_distance → partial tint) and the far interior of the globe
// (megameter distances → full tint).
const UNDERGROUND_CAMERA = `
  const carto = { longitude: -1.3194745, latitude: 0.6988017, height: -30000.0 };
  const dest = scene.globe.ellipsoid.cartographicToCartesian(carto);
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  v.camera.setView({
    destination: dest,
    orientation: { heading: 0.4, pitch: 0.25, roll: 0.0 },
  });
`;

const SCENARIOS = [
  {
    name: "above-default",
    dampSky: true,
    setup: `
      // Default everything — camera stays at the app's default view.
      // The underground gate must stay closed.
    `,
  },
  {
    name: "underground-red",
    dampSky: true,
    setup: `
      const g = scene.globe;
      // Mutate the live Color / NearFarScalar instances (the CesiumViewer
      // page doesn't expose the Cesium namespace; getters return the
      // internal instances so field mutation is equivalent to the setter).
      g.undergroundColor.red = 0.9;
      g.undergroundColor.green = 0.05;
      g.undergroundColor.blue = 0.05;
      g.undergroundColor.alpha = 1.0;
      const nfs = g.undergroundColorAlphaByDistance;
      nfs.near = 1000.0;
      nfs.nearValue = 0.4;
      nfs.far = 400000.0;
      nfs.farValue = 1.0;
      ${UNDERGROUND_CAMERA}
    `,
  },
  {
    name: "underground-def",
    dampSky: true,
    setup: `
      // Upstream defaults: black undergroundColor, NearFarScalar
      // (maxRadius/1000, 0, maxRadius/5, 1). Only the camera moves.
      ${UNDERGROUND_CAMERA}
    `,
  },
];

async function capture(rendererArg, scenario) {
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
    viewport: { width: 1024, height: 640 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  // Apply the scenario, then settle to a deterministic steady state.
  await page.evaluate(
    async ({ setup, det, iso, dampSky }) => {
      const v = window.viewer;
      const scene = v.scene;
      // Hide viewer chrome (toolbar, timeline, animation widget, credits,
      // ion default-token banner) so the pixel diff measures ONLY the
      // canvas. The ion banner in particular appears with backend-dependent
      // timing and would otherwise dominate the mismatch percentage.
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Q7 determinism kit: freeze the clock (stops star/sun drift), damp the
      // sky (removes the celestial cross-backend residual unrelated to the
      // underground tint), then settle on tilesLoaded steady state.
      // eslint-disable-next-line no-new-func
      new Function(det)();
      const C = await import("/Build/CesiumUnminified/index.js");
      window.__det.pinClock(C, v, scene, iso);
      if (dampSky) window.__det.dampSky(scene);
      // eslint-disable-next-line no-new-func
      new Function("v", "scene", setup)(v, scene);
      await window.__det.settleTiles(scene, {
        stableFrames: 30,
        maxFrames: 1500,
      });
    },
    {
      setup: scenario.setup,
      det: DET_BROWSER_SETUP,
      iso: DETERMINISTIC_CLOCK_ISO,
      dampSky: scenario.dampSky !== false,
    },
  );

  const out = path.join(
    OUT_DIR,
    `probe-globe-underground-${scenario.name}-${rendererArg}.png`,
  );
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  if (errs.length) {
    console.log(`  ${errs.length} console errors (${rendererArg}):`);
    errs.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  return out;
}

// Pixel diff via Playwright canvas decode (no Node PNG dependency).
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
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      let sumDR = 0,
        sumDG = 0,
        sumDB = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        const d = dr + dg + db;
        sum += d;
        if (d > 30) mismatch++;
        sumDR += b.data[i] - a.data[i];
        sumDG += b.data[i + 1] - a.data[i + 1];
        sumDB += b.data[i + 2] - a.data[i + 2];
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: (sum / total).toFixed(2),
        meanSignedDR: (sumDR / total).toFixed(2),
        meanSignedDG: (sumDG / total).toFixed(2),
        meanSignedDB: (sumDB / total).toFixed(2),
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  // The above-default scenario measures the STANDING above-ground
  // WebGL-vs-WebGPU residual (imagery LOD sharpness + atmosphere brightness
  // + star field noise — ~22-24% at threshold-30 when this probe was
  // written; the same residual was measured BEFORE the underground work
  // landed, so it is not attributable to this feature). The underground
  // scenarios are judged RELATIVE to that baseline: before the fix they
  // sat at 87-95% (underside not rendered at all + no tint); at parity
  // they must not exceed the standing residual.
  let baselinePct = null;
  for (const scenario of SCENARIOS) {
    console.log(`[probe-globe-underground] ${scenario.name}`);
    // Q7: median the cross-backend mismatch over N_RUNS so a single tile-LOD
    // tie-break can't trip the gate. With the pinned clock + damped sky +
    // settle, the spread is near zero; PROBE_RUNS>1 just tightens it further.
    const stats = await nRunMedian(async () => {
      const gpu = await capture("webgpu", scenario);
      const gl = await capture("webgl", scenario);
      const diff = await diffPngs(gpu, gl);
      return typeof diff.mismatchPct === "number" ? diff.mismatchPct : 100;
    }, N_RUNS);
    const pct = stats.median;
    console.log(
      `  mismatch median=${pct.toFixed(2)}% runs=[${stats.values
        .map((x) => x.toFixed(2))
        .join(", ")}] spread=${stats.spread.toFixed(2)}pp`,
    );
    let limit;
    if (scenario.name === "above-default") {
      baselinePct = pct;
      // Gross-regression guard on the standing baseline itself.
      limit = 30.0;
    } else {
      // Underground must be no worse than the standing above-ground
      // residual (+2% slack for tile-LOD refinement nondeterminism).
      limit = Math.max(8.0, (baselinePct ?? 22.0) + 2.0);
    }
    const ok = pct <= limit;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} (mismatch ${pct.toFixed(2)}% <= ${limit.toFixed(1)}%)`,
    );
    if (!ok) failed = true;
  }
  console.log(`[probe-globe-underground] ${failed ? "FAILED" : "done"}`);
  process.exit(failed ? 1 : 0);
})();
