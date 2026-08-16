#!/usr/bin/env node
// Diagnostic probe (C10-01 ENV-COMMAND-FRUSTUM-BINNING): in the default 3D
// scene, at three route altitudes (18,000 km / 500 km / 300 m), record
// `scene.numberOfFrustums` for both backends. The premise: BV-less
// Pass.ENVIRONMENT commands (sky-atmosphere shell, sun, moon, star field) widen
// the scene near/far to the camera worst-case span [0.1, 1e10] under log depth,
// forcing a permanent 2-frustum floor on every default 3D WebGPU frame. WebGL
// never routes those commands through commandList, so it runs 1. The fix keys
// on `pass === Pass.ENVIRONMENT` to keep those commands OUT of the near/far
// accumulators (they still bin + execute once in the farthest frustum), so
// @purpose Records scene.numberOfFrustums + per-frustum ENVIRONMENT/GLOBE bins on both backends at 3 altitudes to gate the ENV-command frustum-binning fix
// @status ACTIVE
//
// WebGPU collapses to 1 frustum == WebGL. A sky-only leg (globe hidden, facing
// space) must still keep >= 1 frustum with the star field visible.
//
// Per renderer, per waypoint this probe records:
//   - scene.numberOfFrustums
//   - per-frustum ENVIRONMENT / GLOBE bin counts, captured BEFORE the
//     SceneRenderer injection/dedupe mutates the farthest-frustum slot
//     (hook on view.createPotentiallyVisibleSet, snapshot right after orig runs)
//   - canvas pixel stats (nonBlackFraction, meanLuma, skyStripLuma) + a PNG
//
// Bounded frame loops only (memory rule). Edge/Chromium only (WebGPU).
//
// Usage: node Tools/visual-regression/probe-frustum-count-3d.mjs [webgl|webgpu|both]
// Env:   PROBE_BASE (default http://localhost:8080)
//        PROBE_OUT  (default <scratchpad>/frustum-count)

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT =
  process.env.PROBE_OUT ||
  path.join(
    process.cwd(),
    "Tools",
    "visual-regression",
    "output",
    "frustum-count",
  );
const ARG = (process.argv[2] || "both").toLowerCase();
const RENDERERS = ARG === "both" ? ["webgl", "webgpu"] : [ARG];

// Route altitude bands. lon/lat over land so terrain/imagery load.
const LON = -105.0;
const LAT = 40.0;
const WAYPOINTS = [
  { name: "18000km", height: 18000000.0, pitch: -90 },
  { name: "500km", height: 500000.0, pitch: -25 },
  { name: "300m", height: 300.0, pitch: -8 },
];

await mkdir(OUT, { recursive: true });

async function runRenderer(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errors = [];
  const pageErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer, { timeout: 60000 });

  const result = await page.evaluate(
    async ({ lon, lat, waypoints }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      const Pass = C.Pass;
      const ENV = Pass.ENVIRONMENT; // 0
      const GLOBE = Pass.GLOBE; // 2

      // Hook createPotentiallyVisibleSet so we can snapshot the binned
      // frustum indices BEFORE downstream SceneRenderer injection runs.
      const view = scene._view;
      const origPVS = view.createPotentiallyVisibleSet.bind(view);
      let binSnap = null;
      view.createPotentiallyVisibleSet = function (s) {
        const r = origPVS(s);
        const fcl = view.frustumCommandsList;
        binSnap = {
          numFrustums: fcl.length,
          env: fcl.map((fc) => fc.indices[ENV] | 0),
          globe: fcl.map((fc) => fc.indices[GLOBE] | 0),
          splits: fcl.map((fc) => ({
            near: +fc.near.toFixed(3),
            far: +fc.far.toFixed(1),
          })),
        };
        return r;
      };

      async function renderFrames(n) {
        for (let i = 0; i < n; i++) {
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      }

      function binnedGlobeCount() {
        return binSnap ? binSnap.globe.reduce((a, b) => a + b, 0) : 0;
      }

      // Gate on tilesLoaded AND the WebGPU globe surface pipeline being warm
      // enough that GLOBE-pass commands actually reach the frustum lists. A
      // tilesLoaded-only settle races createRenderPipelineAsync (~1-2 s): coarse
      // tiles report loaded before the async globe pipeline compiles, so the
      // GLOBE commands that drive scene near/far are momentarily absent and the
      // count reads high. (Same harness lesson as probe-groundprim-textured.)
      async function waitForGlobe(maxFrames) {
        for (let i = 0; i < maxFrames; i++) {
          binSnap = null;
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          if (scene.globe.tilesLoaded && binnedGlobeCount() > 0) {
            await renderFrames(20); // imagery/atmosphere LUT settle
            return true;
          }
        }
        return false;
      }

      function samplePixels() {
        const canvas = scene.canvas;
        const w = canvas.width;
        const h = canvas.height;
        const g = document.createElement("canvas");
        g.width = w;
        g.height = h;
        const ctx = g.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let nonBlack = 0;
        let sumLuma = 0;
        let skySum = 0;
        let skyCount = 0;
        const total = w * h;
        const skyRows = Math.floor(h * 0.15); // top 15% = sky/atmosphere strip
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const gg = data[idx + 1];
            const b = data[idx + 2];
            const luma = 0.299 * r + 0.587 * gg + 0.114 * b;
            sumLuma += luma;
            if (r > 6 || gg > 6 || b > 6) nonBlack++;
            if (y < skyRows) {
              skySum += luma;
              skyCount++;
            }
          }
        }
        return {
          w,
          h,
          nonBlackFrac: +(nonBlack / total).toFixed(4),
          meanLuma: +(sumLuma / total).toFixed(2),
          skyStripLuma: +(skySum / Math.max(1, skyCount)).toFixed(2),
        };
      }

      // Make sure we are in 3D (default) and env effects on.
      scene.mode = C.SceneMode.SCENE3D;
      // Defaults: skyAtmosphere on, sun on, moon on, skyBox stars on.

      // Warm the WebGPU globe surface pipeline (createRenderPipelineAsync) at a
      // tile-rich altitude BEFORE the waypoint loop so the first (18,000 km)
      // waypoint isn't measured against a cold pipeline with no GLOBE commands.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 600000.0),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(-30.0),
          roll: 0.0,
        },
      });
      await waitForGlobe(360);
      await renderFrames(30);

      const waypointResults = [];
      for (const wp of waypoints) {
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, wp.height),
          orientation: {
            heading: 0.0,
            pitch: C.Math.toRadians(wp.pitch),
            roll: 0.0,
          },
        });
        await waitForGlobe(240);
        binSnap = null;
        await renderFrames(3); // populate binSnap via hook
        const pixels = samplePixels();
        waypointResults.push({
          name: wp.name,
          height: wp.height,
          numberOfFrustums: scene.numberOfFrustums,
          bins: binSnap,
          pixels,
        });
      }

      // Sky-only leg: hide the globe, face space, expect >= 1 frustum + stars.
      scene.globe.show = false;
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat, 8000000.0),
        orientation: {
          heading: 0.0,
          pitch: C.Math.toRadians(60.0), // look up into space
          roll: 0.0,
        },
      });
      await renderFrames(90);
      binSnap = null;
      await renderFrames(3);
      const skyPixels = (function () {
        const p = samplePixels();
        // bright-pixel count for stars
        return p;
      })();
      const skyOnly = {
        numberOfFrustums: scene.numberOfFrustums,
        bins: binSnap,
        pixels: skyPixels,
      };
      scene.globe.show = true;

      view.createPotentiallyVisibleSet = origPVS;

      return {
        mode: scene.mode,
        useLogDepth: scene._logDepthBuffer === true,
        backend: scene._context?.rendererType ?? "unknown",
        waypoints: waypointResults,
        skyOnly,
      };
    },
    { lon: LON, lat: LAT, waypoints: WAYPOINTS },
  );

  // Screenshots per waypoint (re-drive views to capture PNGs).
  for (const wp of WAYPOINTS) {
    await page.evaluate(
      async ({ lon, lat, height, pitch }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer;
        v.scene.globe.show = true;
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: 0.0,
            pitch: C.Math.toRadians(pitch),
            roll: 0.0,
          },
        });
        for (let i = 0; i < 60; i++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      },
      { lon: LON, lat: LAT, height: wp.height, pitch: wp.pitch },
    );
    await page
      .locator("canvas")
      .first()
      .screenshot({ path: path.join(OUT, `${renderer}-${wp.name}.png`) });
  }
  // Sky-only screenshot
  await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-105.0, 40.0, 8000000.0),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(60.0), roll: 0.0 },
    });
    for (let i = 0; i < 60; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await page
    .locator("canvas")
    .first()
    .screenshot({ path: path.join(OUT, `${renderer}-skyonly.png`) });

  await browser.close();
  return { renderer, result, errors, pageErrors };
}

const all = {};
for (const r of RENDERERS) {
  all[r] = await runRenderer(r);
}

// Report
let hardFail = false;
console.log(`\n[probe-frustum-count-3d] base=${BASE} out=${OUT}\n`);
for (const r of RENDERERS) {
  const { result, errors, pageErrors } = all[r];
  console.log(
    `===== ${r} (backend=${result.backend}, logDepth=${result.useLogDepth}) =====`,
  );
  for (const wp of result.waypoints) {
    console.log(
      `  ${wp.name.padEnd(8)} numFrustums=${wp.numberOfFrustums}  ` +
        `envBins=[${wp.bins?.env}]  globeBins=[${wp.bins?.globe}]  ` +
        `nonBlack=${wp.pixels.nonBlackFrac} meanLuma=${wp.pixels.meanLuma} skyLuma=${wp.pixels.skyStripLuma}`,
    );
  }
  console.log(
    `  skyOnly  numFrustums=${result.skyOnly.numberOfFrustums} ` +
      `envBins=[${result.skyOnly.bins?.env}] nonBlack=${result.skyOnly.pixels.nonBlackFrac} meanLuma=${result.skyOnly.pixels.meanLuma}`,
  );
  console.log(`  errors=${errors.length} pageErrors=${pageErrors.length}`);
  errors.slice(0, 6).forEach((e) => console.log("    ERR:", e));
  pageErrors.slice(0, 6).forEach((e) => console.log("    PAGEERR:", e));
  if (errors.length || pageErrors.length) hardFail = true;
}

// Cross-backend structural assertion (only when both ran)
if (RENDERERS.includes("webgl") && RENDERERS.includes("webgpu")) {
  console.log(`\n----- ASSERTIONS -----`);
  const wgl = all.webgl.result;
  const wgpu = all.webgpu.result;
  for (let i = 0; i < wgl.waypoints.length; i++) {
    const a = wgl.waypoints[i];
    const b = wgpu.waypoints[i];
    const ok = b.numberOfFrustums === a.numberOfFrustums;
    console.log(
      `  ${a.name.padEnd(8)} WebGL=${a.numberOfFrustums} WebGPU=${b.numberOfFrustums}  ${ok ? "PARITY" : "MISMATCH"}`,
    );
    if (!ok) hardFail = true;
    // env/globe must still render SOMETHING on both (space views are
    // legitimately mostly black — globe disc alone is ~9% at 18,000 km — so
    // only an all-black canvas is a failure). Feature-preservation is proven by
    // PRE/POST per-backend pixel stability + the dedicated celestial probes,
    // not by an absolute cross-backend brightness threshold.
    if (b.pixels.nonBlackFrac < 0.02) {
      console.log(`    FAIL WebGPU ${a.name} canvas all-black`);
      hardFail = true;
    }
  }
  const skyOk =
    wgpu.skyOnly.numberOfFrustums >= 1 &&
    wgpu.skyOnly.pixels.nonBlackFrac > 0.0005;
  console.log(
    `  skyOnly  WebGPU frustums=${wgpu.skyOnly.numberOfFrustums} nonBlack=${wgpu.skyOnly.pixels.nonBlackFrac} ${skyOk ? "OK" : "FAIL"}`,
  );
  if (!skyOk) hardFail = true;
}

await writeFile(
  path.join(OUT, "frustum-count-report.json"),
  JSON.stringify(all, null, 2),
);
console.log(`\nPNGs + JSON written to ${OUT}`);
console.log(hardFail ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(hardFail ? 1 : 0);
