#!/usr/bin/env node
// Diag: NEW-GLOBE-BELOWSURFACE-DECOMP (B2) — below-surface darkening epic
// increment 1/3: instrumented A/B term decomposition.
// @purpose Per-term A/B decomposition of the WebGPU below-surface darkening residual via pragma-stripped bypass-* globe-fragment modes, one load/scenario.
// @status ACTIVE
//
// The below-surface scenes fail their parity probes with WebGPU uniformly
// darker than WebGL (probe-globe-underground 12.28% red / 22.85% default vs
// 8% limit; probe-globe-translucency 25.49% vs 10.5%; dRGB −5.8..−8.0).
// This diag attributes that residual per shading term: it renders each
// scenario on WebGPU with exactly ONE term bypassed (via the pragma-stripped
// `bypass-*` globe-fragment debug modes, sentinels 21e9..27e9 in
// WebGPUGlobeFragmentDebug.ts / GlobeTerrain.wgsl) and reports
//   1. the term's own signed-dRGB contribution (bypass-X vs bypass-none,
//      same page, same tile state), and
//   2. how far bypassing the term moves the WebGPU frame toward the WebGL
//      reference (residual |dR|+|dG|+|dB| delta vs the control run).
// The dominant contributor named at the end is the target for B5
// (NEW-GLOBE-BELOWSURFACE-FIX).
//
// All bypass variants are captured from a SINGLE WebGPU page load per
// scenario, so tile-LOD refinement nondeterminism cannot contaminate the
// per-term attribution. Every bypass sentinel (incl. the 'bypass-none'
// control) freezes the ocean wave clock at 0, so wave phase is identical
// across variants; the unmodded 'baseline' row exists only as a sanity check
// that the control run itself introduces no artifact beyond the frozen clock.
//
// Usage: node Tools/visual-regression/diag-globe-belowsurface-decomp.mjs
// Outputs: Tools/visual-regression/output/diag-belowsurface-*.png
//          Tools/visual-regression/output/diag-belowsurface-report.json
//
// Exit code 1 only if the bypass instrumentation is dead (no bypass moves
// any pixels in the scenario its term is active in) — this is a diag, not a
// parity gate; the existing probes keep their un-loosened limits.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE ?? "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Camera 30 km below the surface near Philadelphia (mirror of
// probe-globe-underground.mjs).
const UNDERGROUND_CAMERA = `
  const carto = { longitude: -1.3194745, latitude: 0.6988017, height: -30000.0 };
  const dest = scene.globe.ellipsoid.cartographicToCartesian(carto);
  scene.screenSpaceCameraController.enableCollisionDetection = false;
  v.camera.setView({
    destination: dest,
    orientation: { heading: 0.4, pitch: 0.25, roll: 0.0 },
  });
`;

// Mirrors of probe-globe-translucency.mjs.
const ENABLE_TRANSLUCENCY = `
  scene.globe.translucency.enabled = true;
  scene.globe.translucency.frontFaceAlpha = 0.5;
`;
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
    name: "underground-red",
    setup: `
      const g = scene.globe;
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
    // Terms whose bypass MUST move pixels here for the instrumentation to
    // count as alive (the underground tint is unquestionably active).
    mustMove: ["bypass-underground"],
  },
  {
    name: "underground-def",
    setup: UNDERGROUND_CAMERA,
    mustMove: ["bypass-underground"],
  },
  {
    name: "translucent-space",
    setup: ENABLE_TRANSLUCENCY,
    mustMove: ["bypass-translucency"],
  },
  {
    name: "translucent-terrain",
    setup: `
      ${ENABLE_TRANSLUCENCY}
      ${TERRAIN_CAMERA}
    `,
    mustMove: ["bypass-translucency"],
  },
];

// Order matters only for the report; 'baseline' = no debug mode (live wave
// clock), 'bypass-none' = frozen-clock control every bypass is diffed against.
const VARIANTS = [
  "baseline",
  "bypass-none",
  "bypass-underground",
  "bypass-translucency",
  "bypass-drape",
  "bypass-seam-clamp",
  "bypass-glint",
  "bypass-fog",
];

const HIDE_CHROME = `
  for (const el of document.querySelectorAll(
    ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
      ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
      ".cesium-widget-credits, #toolbar",
  )) {
    el.style.display = "none";
  }
`;

function launch() {
  return chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
}

async function newViewerPage(browser, rendererArg, setup) {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 640 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`,
    {
      waitUntil: "networkidle",
    },
  );
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(
    async ({ setup, hide }) => {
      const v = window.viewer;
      const scene = v.scene;
      // eslint-disable-next-line no-new-func
      new Function("v", "scene", hide + setup)(v, scene);
      for (let i = 0; i < 240; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    },
    { setup, hide: HIDE_CHROME },
  );
  await page.waitForTimeout(1500);
  return { page, errors };
}

// Set (or clear) the globe-fragment debug mode and let it settle a few
// frames. The tile-UB writer reads globalThis._webgpuGlobeDebugMode every
// frame, so no reload is needed — tile state stays identical across modes.
async function setDebugMode(page, mode) {
  await page.evaluate(async (m) => {
    globalThis._webgpuGlobeDebugMode = m;
    const scene = window.viewer.scene;
    for (let i = 0; i < 30; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, mode);
  await page.waitForTimeout(200);
}

async function shot(page, file) {
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, fullPage: false });
  return out;
}

// Pixel diff via Playwright canvas decode (same math as the parity probes:
// mismatch threshold 30 on |dR|+|dG|+|dB|, signed means are (b − a)).
async function makeDiffer() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const diff = async (a, b) => {
    const ba = fs.readFileSync(a).toString("base64");
    const bb = fs.readFileSync(b).toString("base64");
    return page.evaluate(
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
        let sumDR = 0,
          sumDG = 0,
          sumDB = 0;
        for (let i = 0; i < A.data.length; i += 4) {
          const dr = Math.abs(A.data[i] - B.data[i]);
          const dg = Math.abs(A.data[i + 1] - B.data[i + 1]);
          const db = Math.abs(A.data[i + 2] - B.data[i + 2]);
          if (dr + dg + db > 30) mismatch++;
          sumDR += B.data[i] - A.data[i];
          sumDG += B.data[i + 1] - A.data[i + 1];
          sumDB += B.data[i + 2] - A.data[i + 2];
        }
        return {
          mismatchPct: (100 * mismatch) / total,
          dR: sumDR / total,
          dG: sumDG / total,
          dB: sumDB / total,
        };
      },
      { ba, bb },
    );
  };
  return { diff, close: () => browser.close() };
}

const f2 = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = { base: BASE, when: new Date().toISOString(), scenarios: {} };
  let instrumentationDead = false;

  const browser = await launch();
  const differ = await makeDiffer();

  for (const scenario of SCENARIOS) {
    console.log(`\n[diag-belowsurface] scenario: ${scenario.name}`);
    // WebGL reference (no debug mode — the sentinels are WebGPU-only).
    const gl = await newViewerPage(browser, "webgl", scenario.setup);
    const glPng = await shot(
      gl.page,
      `diag-belowsurface-${scenario.name}-webgl.png`,
    );
    await gl.page.close();

    // One WebGPU page; all variants captured from the same tile state.
    const gpu = await newViewerPage(browser, "webgpu", scenario.setup);
    const pngs = {};
    for (const variant of VARIANTS) {
      await setDebugMode(gpu.page, variant === "baseline" ? null : variant);
      pngs[variant] = await shot(
        gpu.page,
        `diag-belowsurface-${scenario.name}-webgpu-${variant}.png`,
      );
    }
    await setDebugMode(gpu.page, null);
    await gpu.page.close();
    if (gpu.errors.length) {
      console.log(`  ${gpu.errors.length} webgpu console errors, first:`);
      console.log(`    ${gpu.errors[0]}`);
    }

    // Residual vs WebGL for every variant + own-contribution vs control.
    const rows = {};
    const control = pngs["bypass-none"];
    for (const variant of VARIANTS) {
      const vsGL = await differ.diff(pngs[variant], glPng); // signed = GL − GPU
      const vsControl =
        variant === "bypass-none"
          ? { mismatchPct: 0, dR: 0, dG: 0, dB: 0 }
          : await differ.diff(control, pngs[variant]); // signed = variant − control
      rows[variant] = { vsGL, vsControl };
    }
    report.scenarios[scenario.name] = rows;

    // Attribution table. |residual| = |dR|+|dG|+|dB| of variant-vs-WebGL;
    // toward-GL = |residual(control)| − |residual(bypass)| (positive means
    // removing the term moves WebGPU toward WebGL → the term over-darkens /
    // over-brightens relative to WebGL by that much).
    const ctl = rows["bypass-none"].vsGL;
    const ctlMag = Math.abs(ctl.dR) + Math.abs(ctl.dG) + Math.abs(ctl.dB);
    console.log(
      `  control (bypass-none) vs WebGL: mismatch ${ctl.mismatchPct.toFixed(2)}%  ` +
        `signed dRGB (GL−GPU): ${f2(ctl.dR)}/${f2(ctl.dG)}/${f2(ctl.dB)}  |sum| ${ctlMag.toFixed(2)}`,
    );
    console.log(
      "  term                  own-contribution dRGB      residual-vs-GL %   toward-GL",
    );
    let best = null;
    for (const variant of VARIANTS) {
      if (variant === "baseline" || variant === "bypass-none") continue;
      const r = rows[variant];
      const mag =
        Math.abs(r.vsGL.dR) + Math.abs(r.vsGL.dG) + Math.abs(r.vsGL.dB);
      const towardGL = ctlMag - mag;
      const own = r.vsControl;
      console.log(
        `  ${variant.padEnd(22)}` +
          `${f2(own.dR)}/${f2(own.dG)}/${f2(own.dB)} (${own.mismatchPct.toFixed(2)}%px)`.padEnd(
            28,
          ) +
          `${r.vsGL.mismatchPct.toFixed(2).padStart(7)}%   ${f2(towardGL)}`,
      );
      rows[variant].towardGL = towardGL;
      if (best === null || towardGL > best.towardGL) {
        best = { variant, towardGL };
      }
    }
    const base = rows["baseline"].vsGL;
    console.log(
      `  (sanity) unmodded baseline vs WebGL: mismatch ${base.mismatchPct.toFixed(2)}%  ` +
        `signed ${f2(base.dR)}/${f2(base.dG)}/${f2(base.dB)}`,
    );
    report.scenarios[scenario.name].dominant = best?.variant ?? "none";
    console.log(
      `  >> dominant contributor for ${scenario.name}: ${best?.variant} (toward-GL ${f2(best?.towardGL ?? 0)})`,
    );

    // Instrumentation liveness: the scenario's mustMove terms must actually
    // change pixels when bypassed (own-contribution mismatch > 0.05%).
    for (const term of scenario.mustMove) {
      const moved = rows[term].vsControl.mismatchPct > 0.05;
      if (!moved) {
        console.log(
          `  DEAD BYPASS: ${term} moved no pixels in ${scenario.name}`,
        );
        instrumentationDead = true;
      }
    }
  }

  await differ.close();
  await browser.close();

  // Overall dominant = term with the largest summed toward-GL across scenes.
  const totals = {};
  for (const s of Object.values(report.scenarios)) {
    for (const [variant, row] of Object.entries(s)) {
      if (typeof row !== "object" || row.towardGL === undefined) continue;
      totals[variant] = (totals[variant] ?? 0) + row.towardGL;
    }
  }
  const overall = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  console.log(
    "\n[diag-belowsurface] summed toward-GL attribution (all scenarios):",
  );
  for (const [variant, t] of overall) {
    console.log(`  ${variant.padEnd(22)} ${f2(t)}`);
  }
  // Total control residual magnitude across scenarios: a term only counts as
  // "dominant" if bypassing it recovers a meaningful share (>= 20%) of it.
  // Otherwise the residual lives OUTSIDE the toggled candidate set (2026-07-03
  // finding: a tile-aligned haze/brightening wedge on WebGPU, not any of the
  // named shading terms — see ROADMAP_AND_DEFERRED_WORK.md §4.1).
  const totalCtl = Object.values(report.scenarios).reduce((acc, s) => {
    const c = s["bypass-none"].vsGL;
    return acc + Math.abs(c.dR) + Math.abs(c.dG) + Math.abs(c.dB);
  }, 0);
  const top = overall[0];
  const dominant =
    top && top[1] >= 0.2 * totalCtl ? top[0] : "none-of-the-toggled-terms";
  report.overallDominant = dominant;
  report.overallTable = totals;
  report.totalControlResidual = totalCtl;
  console.log(
    `[diag-belowsurface] OVERALL DOMINANT: ${dominant}` +
      (dominant === "none-of-the-toggled-terms"
        ? ` (best toggle '${top?.[0]}' recovers ${f2(top?.[1] ?? 0)} of ${totalCtl.toFixed(2)} total |signed dRGB| — residual is outside the candidate term set)`
        : ""),
  );

  fs.writeFileSync(
    path.join(OUT_DIR, "diag-belowsurface-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `[diag-belowsurface] ${instrumentationDead ? "FAILED (dead bypass instrumentation)" : "done"}`,
  );
  process.exit(instrumentationDead ? 1 : 0);
})();
