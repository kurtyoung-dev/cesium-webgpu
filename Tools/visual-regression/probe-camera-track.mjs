#!/usr/bin/env node
/**
 * Probe: CAMERA-TRACK — fly the camera through a full ORBIT → GROUND descent that
 * also ROTATES around the globe (deep-orbit whole-Earth disc → continental →
 * regional terrain → coastline → city → near-ground → LITERAL GROUND LEVEL →
 * rotate to the far side of the planet), capturing a screenshot at EACH waypoint
 * on BOTH backends (WebGPU + WebGL) to surface tile load/unload artifacts and
 * cross-backend diffs at every camera-distance band ALONG MOTION.
 *
 * WHY A TRACK (not a static distance sweep): static probes (probe-farcam-*) miss
 * artifacts that only appear while tiles are streaming in/out as the camera
 * moves and the LOD pyramid churns. By driving the camera through a sequence of
 * connected views — a high orbit that descends toward and over a city, crossing
 * a coastline and a mountain range — we exercise tile request/eviction along the
 * path and can diff WebGPU vs WebGL at every stop.
 *
 * CRITICAL SETTLE (learned the hard way in Batch 350): scene.globe.tilesLoaded
 * goes VACUOUSLY true on WebGPU while the render PIPELINES are still compiling,
 * and "non-black coverage" is satisfied INSTANTLY by the background/clear color —
 * so DO NOT settle on coverage+tilesLoaded. Settle by FRAME-SIGNATURE STABILITY:
 * sample a coarse canvas checksum INSIDE a scene.postRender callback (the WebGPU
 * canvas clears-on-present, so the only safe read window is postRender) each
 * frame and wait until the signature stops changing for STABLE_NEEDED consecutive
 * frames, with a MIN_FRAMES floor (~120) and a MAX_FRAMES ceiling (~1500) for the
 * first-view pipeline-compilation cost. See probe-farcam-isolation.mjs and
 * probe-farcam-distortion.mjs for the canonical patterns mirrored here.
 *
 * BOOT/CAPTURE (mirrored from the farcam probes):
 *   - chromium channel "msedge" + --enable-unsafe-webgpu (Playwright's bundled
 *     Firefox/Nightly does NOT have WebGPU).
 *   - TWO Apps/CesiumViewer/index.html?renderer={webgl|webgpu} pages (the
 *     split-screen page is broken on this dev server); each exposes window.viewer.
 *   - Cesium constructors via dynamic import of /Build/CesiumUnminified/index.js.
 *   - Capture INSIDE a postRender callback via canvas.toDataURL (forces a render
 *     + reads the resolved framebuffer; reading outside postRender on WebGPU
 *     grabs a cleared/black frame).
 *
 * OUTPUT:
 *   - Per waypoint: Tools/visual-regression/output/track-wp{NN}-{name}-{webgl,webgpu}.png
 *   - Per waypoint: a simple WebGPU-vs-WebGL pixel-diff % (decode both PNGs in a
 *     2D canvas, count pixels whose per-channel abs diff exceeds a tolerance).
 *   - A JSON summary to stdout (stderr carries the live progress lines).
 *
 * Usage:  node Tools/visual-regression/probe-camera-track.mjs
 *   Env:  PROBE_BASE (default http://localhost:8080)
 *         PROBE_HEADED=1 to watch the run
 *         PROBE_TERRAIN=1 to use ion world terrain (default: ellipsoid, offline-safe)
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");
const VIEWPORT = { width: 1000, height: 1000 };
const USE_TERRAIN = process.env.PROBE_TERRAIN === "1";
const HEADED = process.env.PROBE_HEADED === "1";

// Pixel-diff tolerance: per-channel abs diff above this counts the pixel as
// "different". 24 absorbs JPEG/imagery resample + sub-pixel rasterization noise
// that is not a real cross-backend artifact.
const DIFF_TOL = 24;
// Settle parameters (see module docstring — FRAME-SIGNATURE STABILITY).
const MIN_FRAMES = 120; // floor: never break before the view can materialize
const STABLE_NEEDED = 30; // consecutive near-identical frames = resolved
const MAX_FRAMES = 1500; // ceiling for first-view pipeline compilation
const REL_EPS = 0.0015; // relative signature change treated as "no change"

/**
 * TRAJECTORY — a full ORBIT → GROUND descent that also ROTATES around the
 * globe, so the track exercises every camera-distance band on BOTH backends:
 *   deep orbit (whole Earth disc) → continental → regional terrain →
 *   coastline → city → near-ground → LITERAL GROUND LEVEL (near-horizontal,
 *   ~300 m eye height) → rotate to the far side of the planet (Himalaya).
 *
 * The descent is anchored on San Francisco (good global imagery + terrain), and
 * two high-orbit waypoints over different continents (Americas, Asia) rotate the
 * view around the globe to surface worldwide imagery/terrain streaming + fresh
 * cold LOD pyramids. Run with PROBE_TERRAIN=1 for real elevation at ground level.
 *
 * Each waypoint is a full camera setView spec: destination lon/lat/height +
 * orientation (heading/pitch/roll in degrees). Screenshots + a WebGPU-vs-WebGL
 * pixel diff are captured at every waypoint.
 */
const WAYPOINTS = [
  // 1. Deep orbit — the whole Earth disc from far out (Pacific-centered), top-down.
  { name: "orbit-globe-pacific", lon: -150, lat: 10, height: 18_000_000, heading: 0, pitch: -90, roll: 0 },
  // 2. Rotate east, high orbit over the Americas — continental band.
  { name: "orbit-americas", lon: -100, lat: 35, height: 6_000_000, heading: 20, pitch: -85, roll: 0 },
  // 3. High over the Sierra Nevada — regional terrain band.
  { name: "descend-sierra", lon: -119.5, lat: 37.7, height: 900_000, heading: 35, pitch: -75, roll: 0 },
  // 4. Descend toward the SF Bay coastline (land/sea boundary).
  { name: "descend-sf-coast", lon: -122.0, lat: 37.7, height: 300_000, heading: 55, pitch: -55, roll: 0 },
  // 5. Low oblique over San Francisco — city + bay + hills in one frame.
  { name: "low-oblique-sf", lon: -122.35, lat: 37.74, height: 60_000, heading: 75, pitch: -40, roll: 0 },
  // 6. City-level over downtown SF — dense imagery LOD.
  { name: "city-sf", lon: -122.42, lat: 37.77, height: 12_000, heading: 90, pitch: -35, roll: 0 },
  // 7. Near-ground oblique over SF — building / terrain-detail LOD band.
  { name: "near-ground-sf", lon: -122.42, lat: 37.78, height: 2_500, heading: 100, pitch: -20, roll: 0 },
  // 8. GROUND LEVEL — near-horizontal eye height over SF streets (the close band).
  { name: "ground-sf", lon: -122.42, lat: 37.785, height: 300, heading: 110, pitch: -6, roll: 0 },
  // 9. Rotate to the far side of the globe — high orbit over the Himalaya
  //    (Everest): worldwide streaming + a fresh cold LOD pyramid + extreme terrain.
  { name: "orbit-himalaya", lon: 86.925, lat: 27.99, height: 2_500_000, heading: 0, pitch: -80, roll: 0 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot one CesiumViewer page at the given renderer, mirroring the farcam probes. */
async function bootViewer(browser, renderer) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 90000 });
  return { page, errs };
}

/**
 * One-time scene setup per page: continuous render, terrain choice, clock fixed,
 * atmosphere/lighting tamed so cross-backend diffs reflect tile content rather
 * than time-of-day glow. Returns imagery/terrain state for the report.
 */
async function setupScene(page, useTerrain) {
  return await page.evaluate(
    async ({ useTerrain }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const out = { terrain: "ellipsoid", imagery: null, usedFallback: false, why: null };

      // Continuous render — never request-render-mode for a motion track.
      v.scene.requestRenderMode = false;

      // Fixed clock so lighting/atmosphere don't drift between waypoints.
      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T19:00:00Z");

      // Tame view-dependent glow so the diff measures tile content, not sky.
      v.scene.globe.enableLighting = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.fog.enabled = false;
      v.scene.skyAtmosphere.show = false;
      if (v.scene.sun) v.scene.sun.show = false;
      if (v.scene.moon) v.scene.moon.show = false;
      v.scene.backgroundColor = new C.Color(0, 0, 0, 1);

      // Terrain: ion world terrain if requested + reachable, else ellipsoid.
      if (useTerrain) {
        try {
          const tp = await C.CesiumTerrainProvider.fromIonAssetId(1);
          v.terrainProvider = tp;
          v.scene.globe.terrainProvider = tp;
          out.terrain = "CesiumTerrainProvider(ion:1)";
        } catch (e) {
          v.terrainProvider = new C.EllipsoidTerrainProvider();
          v.scene.globe.terrainProvider = v.terrainProvider;
          out.terrain = "ellipsoid(fallback)";
          out.why = "terrain: " + String(e && e.message ? e.message : e);
        }
      } else {
        v.terrainProvider = new C.EllipsoidTerrainProvider();
        v.scene.globe.terrainProvider = v.terrainProvider;
        out.terrain = "ellipsoid";
      }

      // Imagery: keep the Viewer default (ion Bing). Render a few frames to fire
      // tile requests; if the base layer errors, fall back to offline
      // NaturalEarthII and flag it.
      try {
        const layers = v.imageryLayers;
        let imageryFailed = false;
        const onErr = () => {
          imageryFailed = true;
        };
        for (let i = 0; i < layers.length; i++) {
          const layer = layers.get(i);
          if (layer && layer.imageryProvider && layer.imageryProvider.errorEvent) {
            layer.imageryProvider.errorEvent.addEventListener(onErr);
          }
        }
        for (let i = 0; i < 60; i++) {
          v.scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (imageryFailed || layers.length === 0) {
          throw new Error("ion imagery errored or absent");
        }
        out.imagery =
          (layers.length &&
            layers.get(0).imageryProvider &&
            layers.get(0).imageryProvider.constructor &&
            layers.get(0).imageryProvider.constructor.name) ||
          "unknown";
      } catch (e) {
        try {
          const url = C.buildModuleUrl("Assets/Textures/NaturalEarthII");
          const prov = await C.TileMapServiceImageryProvider.fromUrl(url);
          v.imageryLayers.removeAll();
          v.imageryLayers.addImageryProvider(prov);
          out.usedFallback = true;
          out.imagery = "TileMapServiceImageryProvider(NaturalEarthII)";
          out.why = (out.why ? out.why + " | " : "") + String(e && e.message ? e.message : e);
        } catch (e2) {
          out.why = (out.why ? out.why + " | " : "") + "imagery fallback failed: " + String(e2 && e2.message ? e2.message : e2);
        }
      }

      return out;
    },
    { useTerrain },
  );
}

/** Apply a waypoint's camera view. Returns basic camera diagnostics. */
async function setWaypoint(page, wp) {
  return await page.evaluate(
    async ({ wp }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const out = { ok: false, why: null };
      try {
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.height),
          orientation: {
            heading: C.Math.toRadians(wp.heading),
            pitch: C.Math.toRadians(wp.pitch),
            roll: C.Math.toRadians(wp.roll),
          },
        });
        out.ok = true;
        out.rendererType = v.scene.context.rendererType;
        out.camPosMag = +C.Cartesian3.magnitude(v.camera.positionWC).toFixed(1);
        out.drawW = v.scene.drawingBufferWidth;
        out.drawH = v.scene.drawingBufferHeight;
      } catch (e) {
        out.why = String(e && e.message ? e.message : e);
      }
      return out;
    },
    { wp },
  );
}

/**
 * SETTLE by FRAME-SIGNATURE STABILITY (see module docstring).
 *
 * Sample a coarse weighted checksum of the canvas INSIDE postRender each frame
 * (the safe read window before the WebGPU present-clear). Break only after the
 * signature has been near-constant for STABLE_NEEDED consecutive frames, past a
 * MIN_FRAMES floor, with a MAX_FRAMES ceiling. tilesLoaded is RECORDED but NOT
 * used as a gate (it goes vacuously true on WebGPU mid-compile).
 */
async function settle(page, params) {
  return await page.evaluate(
    async ({ MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS }) => {
      const v = window.viewer;
      const scene = v.scene;

      const SW = 200,
        SH = 200;
      const sampler = document.createElement("canvas");
      sampler.width = SW;
      sampler.height = SH;
      const sctx = sampler.getContext("2d", { willReadFrequently: true });

      let lastSig = 0;
      const signInPostRender = () => {
        try {
          sctx.clearRect(0, 0, SW, SH);
          sctx.drawImage(scene.canvas, 0, 0, SW, SH);
          const d = sctx.getImageData(0, 0, SW, SH).data;
          // Coarse weighted checksum — sensitive to content changing as tiles +
          // pipelines materialize, cheap (stride 16).
          let s = 0;
          for (let i = 0; i < d.length; i += 16) s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
          lastSig = s;
        } catch (e) {
          lastSig = -1;
        }
      };
      const remove = scene.postRender.addEventListener(signInPostRender);

      let prevSig = -1;
      let stable = 0;
      let settledFrame = -1;
      let tilesLoadedAt = -1;
      let framesRendered = 0;

      for (let i = 0; i < MAX_FRAMES; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        framesRendered = i + 1;
        if (scene.globe.tilesLoaded && tilesLoadedAt < 0) tilesLoadedAt = i;
        const sig = lastSig;
        const rel =
          prevSig <= 0 ? Infinity : Math.abs(sig - prevSig) / Math.max(1, Math.abs(prevSig));
        if (rel < REL_EPS) stable++;
        else stable = 0;
        prevSig = sig;
        if (i >= MIN_FRAMES && stable >= STABLE_NEEDED) {
          settledFrame = i;
          break;
        }
      }
      remove();
      // A few extra renders to flush any final present.
      for (let i = 0; i < 10; i++) {
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return {
        settledFrame,
        framesRendered,
        tilesLoadedAt,
        tilesLoaded: scene.globe.tilesLoaded,
        stableHit: settledFrame >= 0,
        finalSig: lastSig,
      };
    },
    params,
  );
}

/**
 * CAPTURE the canvas. Read INSIDE a postRender callback via toDataURL so the
 * WebGPU clear-on-present doesn't hand us a black frame.
 */
async function capture(page, outPath) {
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    return await new Promise((resolve) => {
      const remove = v.scene.postRender.addEventListener(() => {
        remove();
        try {
          resolve(v.scene.canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) {
          resolve(null);
        }
      });
      v.scene.requestRender();
      v.scene.render();
    });
  });
  if (!b64) return false;
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  return true;
}

/**
 * Cross-backend pixel diff. Decode both PNGs in a 2D canvas (run on the GL page),
 * count pixels whose max per-channel abs diff exceeds DIFF_TOL, write a diff PNG
 * (white = differing pixel), and return diff stats.
 */
async function pixelDiff(page, glPath, gpuPath, diffPath, tol) {
  const glB64 = fs.readFileSync(glPath).toString("base64");
  const gpuB64 = fs.readFileSync(gpuPath).toString("base64");
  const res = await page.evaluate(
    async ({ glB64, gpuB64, tol }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, data: cx.getImageData(0, 0, c.width, c.height).data };
      };

      const A = await decode(glB64);
      const B = await decode(gpuB64);
      if (A.w !== B.w || A.h !== B.h) {
        return { ok: false, why: `size mismatch gl=${A.w}x${A.h} gpu=${B.w}x${B.h}` };
      }

      const w = A.w,
        h = A.h;
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = w;
      diffCanvas.height = h;
      const dcx = diffCanvas.getContext("2d");
      const out = dcx.createImageData(w, h);

      let diffCount = 0;
      let sumDelta = 0;
      let maxDelta = 0;
      const da = A.data;
      const db = B.data;
      const od = out.data;
      for (let i = 0; i < da.length; i += 4) {
        const dr = Math.abs(da[i] - db[i]);
        const dg = Math.abs(da[i + 1] - db[i + 1]);
        const dbb = Math.abs(da[i + 2] - db[i + 2]);
        const m = dr > dg ? (dr > dbb ? dr : dbb) : dg > dbb ? dg : dbb;
        sumDelta += m;
        if (m > maxDelta) maxDelta = m;
        if (m > tol) {
          diffCount++;
          od[i] = 255;
          od[i + 1] = 255;
          od[i + 2] = 255;
          od[i + 3] = 255;
        } else {
          od[i] = 0;
          od[i + 1] = 0;
          od[i + 2] = 0;
          od[i + 3] = 255;
        }
      }
      dcx.putImageData(out, 0, 0);
      const total = w * h;
      return {
        ok: true,
        w,
        h,
        diffCount,
        total,
        diffPct: +((100 * diffCount) / total).toFixed(3),
        meanDelta: +(sumDelta / total).toFixed(2),
        maxDelta,
        diffPng: diffCanvas.toDataURL("image/png").split(",")[1],
      };
    },
    { glB64, gpuB64, tol },
  );

  if (res.ok && res.diffPng) {
    fs.writeFileSync(diffPath, Buffer.from(res.diffPng, "base64"));
    delete res.diffPng;
    res.diffPath = diffPath;
  }
  return res;
}

async function run() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan", "--disable-cache"],
  });

  const gl = await bootViewer(browser, "webgl");
  const gpu = await bootViewer(browser, "webgpu");

  const setupGL = await setupScene(gl.page, USE_TERRAIN);
  const setupGPU = await setupScene(gpu.page, USE_TERRAIN);

  const report = {
    loaded: false,
    viewport: VIEWPORT,
    useTerrain: USE_TERRAIN,
    diffTol: DIFF_TOL,
    settle: { MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS },
    setup: { webgl: setupGL, webgpu: setupGPU },
    waypoints: [],
    pngPaths: [],
    errors: { webgl: [], webgpu: [] },
    summary: {},
  };

  const settleParams = { MIN_FRAMES, STABLE_NEEDED, MAX_FRAMES, REL_EPS };
  const pngPaths = [];

  for (let wi = 0; wi < WAYPOINTS.length; wi++) {
    const wp = WAYPOINTS[wi];
    const tag = `wp${String(wi + 1).padStart(2, "0")}-${wp.name}`;

    const svGL = await setWaypoint(gl.page, wp);
    const svGPU = await setWaypoint(gpu.page, wp);

    const settleGL = await settle(gl.page, settleParams);
    const settleGPU = await settle(gpu.page, settleParams);
    await sleep(300);

    const glPath = path.join(OUT_DIR, `track-${tag}-webgl.png`);
    const gpuPath = path.join(OUT_DIR, `track-${tag}-webgpu.png`);
    const diffPath = path.join(OUT_DIR, `track-${tag}-diff.png`);

    const okGL = await capture(gl.page, glPath);
    const okGPU = await capture(gpu.page, gpuPath);
    if (okGL) pngPaths.push(glPath);
    if (okGPU) pngPaths.push(gpuPath);

    let diff = null;
    if (okGL && okGPU) {
      try {
        diff = await pixelDiff(gl.page, glPath, gpuPath, diffPath, DIFF_TOL);
        if (diff && diff.ok) pngPaths.push(diffPath);
      } catch (e) {
        diff = { ok: false, why: String(e && e.message ? e.message : e) };
      }
    }

    const entry = {
      index: wi + 1,
      name: wp.name,
      waypoint: wp,
      setup: { webgl: svGL, webgpu: svGPU },
      settle: { webgl: settleGL, webgpu: settleGPU },
      captured: { webgl: okGL, webgpu: okGPU },
      glPath,
      gpuPath,
      diff,
    };
    report.waypoints.push(entry);

    console.error(
      `[track] ${tag} ` +
        `settledGPU=${settleGPU.settledFrame}/${settleGPU.framesRendered} ` +
        `settledGL=${settleGL.settledFrame}/${settleGL.framesRendered} ` +
        (diff && diff.ok
          ? `diff=${diff.diffPct}% meanD=${diff.meanDelta} maxD=${diff.maxDelta}`
          : `diff=${diff ? diff.why : "n/a"}`),
    );
  }

  // Roll-up summary across waypoints.
  const diffPcts = report.waypoints
    .map((wp) => (wp.diff && wp.diff.ok ? wp.diff.diffPct : null))
    .filter((x) => x != null);
  const worst = report.waypoints
    .filter((wp) => wp.diff && wp.diff.ok)
    .sort((a, b) => b.diff.diffPct - a.diff.diffPct)[0];
  report.summary = {
    waypointCount: WAYPOINTS.length,
    captured: report.waypoints.filter((wp) => wp.captured.webgl && wp.captured.webgpu).length,
    meanDiffPct:
      diffPcts.length > 0
        ? +(diffPcts.reduce((a, b) => a + b, 0) / diffPcts.length).toFixed(3)
        : null,
    maxDiffPct: diffPcts.length > 0 ? Math.max(...diffPcts) : null,
    worstWaypoint: worst ? { name: worst.name, diffPct: worst.diff.diffPct } : null,
    anySettleCeilingHit: report.waypoints.some(
      (wp) => !wp.settle.webgpu.stableHit || !wp.settle.webgl.stableHit,
    ),
  };

  report.loaded = true;
  report.pngPaths = pngPaths;
  report.errors.webgl = gl.errs.slice(0, 8);
  report.errors.webgpu = gpu.errs.slice(0, 8);

  await browser.close();
  return report;
}

(async () => {
  try {
    const result = await run();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("[track] FATAL:", e && e.stack ? e.stack : String(e));
    console.log(JSON.stringify({ loaded: false, fatal: String(e && e.message ? e.message : e) }, null, 2));
    process.exit(1);
  }
})();
