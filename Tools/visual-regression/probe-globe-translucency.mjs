#!/usr/bin/env node
// Probe: GLOBE-TRANSLUCENCY-ALPHA — globe.translucency per-fragment alpha
// parity (WebGL vs WebGPU). The 9 derived blend/cull/depth pipeline variants
// were already wired (Batches 177/182); this probe verifies the alpha values
// (frontFaceAlpha × frontFaceAlphaByDistance) actually reach the globe FS so
// an enabled translucent globe composites see-through, not opaque.
//
// Scenarios:
//   off-default        — default load, translucency disabled (the default).
//                        OFF-GATE: the translucency alpha gate must stay
//                        closed; WebGL/WebGPU diff must match the standing
//                        globe-default parity residual (no new artifact).
//                        Sets the baseline for the enabled scenarios.
//   translucent-space  — default space camera + translucency.enabled +
//                        frontFaceAlpha = 0.5. ACCEPTANCE: the whole planet
//                        disk becomes see-through (back side + stars blend
//                        through) on BOTH backends comparably.
//   translucent-terrain— camera 60 km above terrain looking down at an
//                        oblique pitch + frontFaceAlpha = 0.5. ACCEPTANCE:
//                        near terrain composites at half alpha over the far
//                        side of the globe, matching WebGL.
//
// Usage: node Tools/visual-regression/probe-globe-translucency.mjs
// Outputs: Tools/visual-regression/output/probe-globe-translucency-*.png

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
// Q7-PROBE-DETERMINISM: pin the clock + settle-to-steady-state (and damp the
// sky where stars are not the signal) so the run-to-run drift (audit:
// translucency 25.49 vs 23.14 on unchanged builds) collapses. The
// translucent-space scenario keeps the sky ON — the stars blending THROUGH the
// see-through globe are its acceptance signal — but the pinned clock still
// freezes them deterministically. PROBE_RUNS>1 medians the metric over N runs.
const N_RUNS = runCount(1);

const ENABLE_TRANSLUCENCY = `
  scene.globe.translucency.enabled = true;
  scene.globe.translucency.frontFaceAlpha = 0.5;
`;

// 60 km above the surface near Philadelphia, pitched down obliquely so the
// frame contains near terrain (short v_distance) AND the horizon/far side
// that the translucent blend reveals.
const TERRAIN_CAMERA = `
  const carto = { longitude: -1.3194745, latitude: 0.6988017, height: 60000.0 };
  const dest = scene.globe.ellipsoid.cartographicToCartesian(carto);
  v.camera.setView({
    destination: dest,
    orientation: { heading: 0.4, pitch: -0.9, roll: 0.0 },
  });
`;

const SCENARIOS = [
  {
    name: "off-default",
    dampSky: true,
    setup: `
      // Default everything — globe.translucency.enabled is false by default.
      // The translucency alpha gate must stay closed.
    `,
  },
  {
    name: "translucent-space",
    // Stars blending THROUGH the see-through globe are this scenario's
    // acceptance signal, so keep the sky ON — the pinned clock still makes
    // it deterministic.
    dampSky: false,
    setup: `
      ${ENABLE_TRANSLUCENCY}
    `,
  },
  {
    name: "translucent-terrain",
    dampSky: true,
    setup: `
      ${ENABLE_TRANSLUCENCY}
      ${TERRAIN_CAMERA}
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
      // Hide viewer chrome so the pixel diff measures ONLY the canvas.
      for (const el of document.querySelectorAll(
        ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
          ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
          ".cesium-widget-credits, #toolbar",
      )) {
        el.style.display = "none";
      }
      // Q7 determinism kit: freeze the clock, optionally damp the sky, settle.
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
    `probe-globe-translucency-${scenario.name}-${rendererArg}.png`,
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
          data: c
            .getContext("2d")
            .getImageData(0, 0, c.width, c.height).data,
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
  // The off-default scenario measures the STANDING WebGL-vs-WebGPU residual
  // at the default view (imagery LOD sharpness + atmosphere brightness +
  // star-field noise). The translucent scenarios are judged RELATIVE to
  // that baseline: before the alpha threading landed they sat far above it
  // (WebGPU composited fully opaque where WebGL was see-through); at parity
  // they must stay within the standing residual + slack.
  let baselinePct = null;
  for (const scenario of SCENARIOS) {
    console.log(`[probe-globe-translucency] ${scenario.name}`);
    // Q7: median the cross-backend mismatch over N_RUNS. With the pinned clock
    // + settle (+ damped sky where stars aren't the signal) the spread is near
    // zero; PROBE_RUNS>1 tightens it further.
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
    if (scenario.name === "off-default") {
      baselinePct = pct;
      // Gross-regression guard on the standing baseline itself.
      limit = 30.0;
    } else {
      // Translucent scenarios must be no worse than the standing residual
      // (+8% slack: the see-through composite doubles the imagery surface
      // area whose LOD refinement can disagree between backends).
      limit = Math.max(10.0, (baselinePct ?? 22.0) + 8.0);
    }
    const ok = pct <= limit;
    console.log(
      `  ${ok ? "PASS" : "FAIL"} (mismatch ${pct.toFixed(2)}% <= ${limit.toFixed(1)}%)`,
    );
    if (!ok) failed = true;
  }
  console.log(`[probe-globe-translucency] ${failed ? "FAILED" : "done"}`);
  process.exit(failed ? 1 : 0);
})();
