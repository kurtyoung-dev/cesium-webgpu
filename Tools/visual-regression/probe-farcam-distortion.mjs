#!/usr/bin/env node
/**
 * Probe: REPRODUCE + CHARACTERIZE the WebGPU globe-surface DISTORTION + MESH TEAR
 * that appears at FAR camera distances (whole-globe / zoomed-out views).
 *
 * OWNER REPORT (from screenshots): at whole-globe and zoomed-out views the
 * WebGPU globe is geometrically DISTORTED — continents squished/warped, visible
 * FACETING — and at extreme zoom-out a MESH TEAR (a wedge of the globe surface
 * folded/torn out, near the bottom of the disc). It looks fine ONLY when the
 * camera is close (globe fills the screen) — which is why earlier close-up
 * probes missed it. The bug SCALES WITH CAMERA DISTANCE.
 *
 * STRATEGY (CLAUDE.md Principle 8 — match the owner's reproduction, READ PNGs):
 *   - TWO CesiumViewer pages: Apps/CesiumViewer/index.html?renderer=webgpu and
 *     ?renderer=webgl. Each exposes window.viewer. Constructors via dynamic
 *     import of /Build/CesiumUnminified/index.js (the split-screen IIFE is
 *     un-servable on this dev server).
 *   - DEFAULT imagery: keep the Viewer's default ion World Imagery (Bing
 *     satellite) — the SAME imagery as the owner's screenshots. If ion tiles
 *     fail to load (network/token), FALL BACK to NaturalEarthII and RECORD the
 *     fallback in the report.
 *   - scene.requestRenderMode = false (continuous render).
 *   - SETTLE by polling REAL non-black canvas coverage: require >25% coverage
 *     for 30 CONSECUTIVE frames (defeats the black-capture race) AND read the
 *     canvas inside a postRender callback (the WebGPU canvas clears-on-present;
 *     capturing outside postRender grabs a cleared/black frame).
 *   - View North America: camera over lon -95, lat 40. TWO orientations per
 *     height: straight-down (pitch -90) AND slightly tilted (pitch -75, like the
 *     screenshots). HEIGHT SWEEP: 12 / 20 / 35 / 50 Mm.
 *   - TWO atmosphere passes per height: atmosphere ON (match owner's view) AND
 *     atmosphere OFF (silhouette + tear unambiguous).
 *   - Terrain OFF (EllipsoidTerrainProvider) so the silhouette is the pure
 *     ellipsoid — any tear is a RENDER bug, not terrain geometry.
 *
 * MEASUREMENTS (atmosphere-OFF pass, magenta background):
 *   - Disc SILHOUETTE bbox + width/height at center on BOTH backends -> the
 *     WebGPU/WebGL disc-size RATIO. Does WebGPU render the disc smaller, and
 *     does the ratio WORSEN with distance?
 *   - TEAR detection: scan the lower hemisphere of the WebGPU disc for a CONCAVE
 *     bite — a background-colored wedge intruding INTO the disc silhouette
 *     (a row whose disc run is split, or a column whose top edge dips far above
 *     its neighbours). Report whether a tear is present + its location/extent.
 *   - Backend-independent camera projection check: project a lon/lat grid to
 *     window coords via SceneTransforms.worldToWindowCoordinates on BOTH
 *     backends; large per-point pixel deltas localize the warp to the
 *     camera/projection matrices vs the tessellation.
 *
 * Usage:  node Tools/visual-regression/probe-farcam-distortion.mjs
 * Output: Tools/visual-regression/output/farcam-{atmoOn,atmoOff}-h{MM}-{down,tilt}-{webgl,webgpu}.png
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:8080";
const OUT_DIR = path.join(__dirname, "output");
const VIEWPORT = { width: 1000, height: 1000 }; // square: disc fits, W/H comparable

// North America. Heights chosen by the task: whole-globe -> extreme zoom-out.
const HEIGHTS_MM = [12, 20, 35, 50]; // millions of metres
const NA = { lon: -95, lat: 40 };
// Two orientations: straight-down + tilted (owner's screenshots are slightly tilted).
const ORIENTS = [
  { tag: "down", pitchDeg: -90 },
  { tag: "tilt", pitchDeg: -75 },
];

// Solid NON-BLACK background for the atmosphere-OFF silhouette pass. Dark
// magenta (R+B, no G) does not occur in Bing/NaturalEarthII land/ocean OR in
// atmosphere-off space (black) — so the disc + any tear read cleanly.
const BG = { r: 40, g: 0, b: 40 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot one CesiumViewer page at the given renderer. */
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
  // Continuous render — never request-render-mode for a distance sweep.
  await page.evaluate(() => {
    window.viewer.scene.requestRenderMode = false;
  });
  return { page, errs };
}

/**
 * Try to keep DEFAULT ion imagery (Bing). Detect whether ion tiles actually
 * load; if not, swap in NaturalEarthII and flag the fallback. Returns the
 * imagery state. Runs ONCE per page (imagery persists across the sweep).
 */
async function ensureImagery(page) {
  return await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const out = { usedFallback: false, providerName: null, why: null };
    try {
      // Terrain OFF — pure ellipsoid silhouette, so any tear is a render bug.
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.scene.globe.terrainProvider = v.terrainProvider;

      v.clock.shouldAnimate = false;
      v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T17:00:00Z");

      // The default Viewer baseLayerPicker selects ion World Imagery (Bing).
      // Give it real frames to fire the tile requests, then check load state.
      const layers = v.imageryLayers;
      let imageryFailed = false;
      // Count imagery errors over a short window.
      const onErr = () => {
        imageryFailed = true;
      };
      for (let i = 0; i < layers.length; i++) {
        const layer = layers.get(i);
        if (layer && layer.imageryProvider && layer.imageryProvider.errorEvent) {
          layer.imageryProvider.errorEvent.addEventListener(onErr);
        }
      }
      // Render a few frames to kick off tile loads.
      for (let i = 0; i < 60; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Heuristic: if the base layer's provider has no ready imagery OR we saw
      // imagery errors, fall back. Also catch the case where ion auth fails
      // (provider construction throws -> no layers at all).
      if (imageryFailed || layers.length === 0) {
        throw new Error("ion imagery errored or absent");
      }
      out.providerName =
        (layers.length &&
          layers.get(0).imageryProvider &&
          layers.get(0).imageryProvider.constructor &&
          layers.get(0).imageryProvider.constructor.name) ||
        "unknown";
      return out;
    } catch (e) {
      // FALLBACK: NaturalEarthII (offline asset).
      try {
        const url = C.buildModuleUrl("Assets/Textures/NaturalEarthII");
        const prov = await C.TileMapServiceImageryProvider.fromUrl(url);
        v.imageryLayers.removeAll();
        v.imageryLayers.addImageryProvider(prov);
        out.usedFallback = true;
        out.providerName = "TileMapServiceImageryProvider(NaturalEarthII)";
        out.why = String(e && e.message ? e.message : e);
      } catch (e2) {
        out.why = "fallback also failed: " + String(e2 && e2.message ? e2.message : e2);
      }
      return out;
    }
  });
}

/** Apply atmosphere ON/OFF + the NA view at a given height/orientation. */
async function setView(page, { atmoOn, heightMm, pitchDeg, bg }) {
  return await page.evaluate(
    async ({ atmoOn, heightMm, pitchDeg, bg }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const out = { ok: false, why: null };
      try {
        if (atmoOn) {
          // Match owner's view: atmosphere ON. Lighting off so the silhouette
          // isn't half-dark, but keep the sky/ground glow + fog.
          v.scene.globe.enableLighting = false;
          v.scene.globe.showGroundAtmosphere = true;
          v.scene.fog.enabled = true;
          v.scene.skyAtmosphere.show = true;
          // Default space background (don't force magenta with atmosphere on).
          v.scene.backgroundColor = new C.Color(0, 0, 0, 1);
        } else {
          // Silhouette pass: ALL glow OFF, magenta background.
          v.scene.globe.enableLighting = false;
          v.scene.globe.showGroundAtmosphere = false;
          v.scene.fog.enabled = false;
          v.scene.skyAtmosphere.show = false;
          if (v.scene.sun) v.scene.sun.show = false;
          if (v.scene.moon) v.scene.moon.show = false;
          if (v.scene.skyBox) {
            v.scene.skyBox.show = false;
            v.scene.skyBox = undefined;
          }
          v.scene.backgroundColor = new C.Color(bg.r / 255, bg.g / 255, bg.b / 255, 1);
        }

        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(-95, 40, heightMm * 1_000_000),
          orientation: {
            heading: 0,
            pitch: C.Math.toRadians(pitchDeg),
            roll: 0,
          },
        });

        out.ok = true;
        out.rendererType = v.scene.context.rendererType;
        out.camPosMag = C.Cartesian3.magnitude(v.camera.positionWC);
        out.drawW = v.scene.drawingBufferWidth;
        out.drawH = v.scene.drawingBufferHeight;
      } catch (e) {
        out.why = String(e && e.message ? e.message : e);
      }
      return out;
    },
    { atmoOn, heightMm, pitchDeg, bg },
  );
}

/**
 * SETTLE by FRAME STABILITY, not coverage.
 *
 * WHY NOT COVERAGE: the atmosphere-OFF pass paints a magenta background, and the
 * WebGPU canvas clears-on-present, so "non-black coverage" is ~1.0 the instant
 * the clear color is drawn — it does NOT measure whether the DISC has
 * materialized. Combined with scene.globe.tilesLoaded going VACUOUSLY true on
 * WebGPU while the render pipelines are still COMPILING (which takes HUNDREDS of
 * frames for the first view), a coverage+tilesLoaded settle breaks far too early
 * and captures a BLACK/PARTIAL disc — the dark radial "cage"/"ring" bands that
 * masquerade as a geometry tear. (Confirmed 2026-06-22: a 600-frame fixed
 * settle renders a clean disc at every distance; the early-break capture did
 * not.)
 *
 * INSTEAD: sample a coarse SIGNATURE of the canvas each frame INSIDE postRender
 * (the safe window before the present clear) and wait until the signature STOPS
 * CHANGING — STABLE_NEEDED consecutive near-identical frames AND a MIN_FRAMES
 * floor. While the disc is still materializing the signature keeps shifting, so
 * stability is reached only AFTER the render fully resolves.
 */
async function settle(page) {
  return await page.evaluate(async () => {
    const v = window.viewer;
    const scene = v.scene;

    const sampler = document.createElement("canvas");
    const SW = 200,
      SH = 200;
    sampler.width = SW;
    sampler.height = SH;
    const sctx = sampler.getContext("2d", { willReadFrequently: true });

    let prevSig = -1;
    let stable = 0;
    let settledFrame = -1;
    let tilesLoadedAt = -1;
    let lastSig = 0;

    const signInPostRender = () => {
      try {
        sctx.clearRect(0, 0, SW, SH);
        sctx.drawImage(scene.canvas, 0, 0, SW, SH);
        const d = sctx.getImageData(0, 0, SW, SH).data;
        // Coarse weighted checksum — sensitive to disc shape/content changing as
        // tiles + pipelines materialize, cheap (stride 16).
        let s = 0;
        for (let i = 0; i < d.length; i += 16) s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
        lastSig = s;
      } catch (e) {
        lastSig = -1;
      }
    };
    const remove = scene.postRender.addEventListener(signInPostRender);

    const MIN_FRAMES = 120; // floor: never break before the disc can materialize
    const STABLE_NEEDED = 30; // consecutive near-identical frames = resolved
    const MAX_FRAMES = 1500; // ceiling for first-view pipeline compilation
    for (let i = 0; i < MAX_FRAMES; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (scene.globe.tilesLoaded && tilesLoadedAt < 0) tilesLoadedAt = i;
      const sig = lastSig;
      const rel =
        prevSig <= 0 ? Infinity : Math.abs(sig - prevSig) / Math.max(1, Math.abs(prevSig));
      if (rel < 0.0015) stable++;
      else stable = 0;
      prevSig = sig;
      if (i >= MIN_FRAMES && stable >= STABLE_NEEDED && scene.globe.tilesLoaded) {
        settledFrame = i;
        break;
      }
    }
    remove();
    for (let i = 0; i < 10; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      settledFrame,
      tilesLoadedAt,
      tilesLoaded: scene.globe.tilesLoaded,
      finalSig: lastSig,
    };
  });
}

/**
 * CAPTURE the canvas. Read INSIDE a postRender callback via toDataURL so the
 * WebGPU clear-on-present doesn't hand us a black frame. Cesium's toDataURL
 * path forces a render and reads back the resolved scene framebuffer.
 */
async function capture(page, outPath) {
  const b64 = await page.evaluate(async () => {
    const v = window.viewer;
    // Drive a render and read in postRender for safety on WebGPU.
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

/** Backend-independent camera projection check at the current view. */
async function cameraProbe(page, heightMm) {
  return await page.evaluate(
    async ({ heightMm }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const ST = C.SceneTransforms || null;
      const C3 = C.Cartesian3;
      const project = (lon, lat) => {
        if (!ST || !C3) return null;
        const carto = C3.fromDegrees(lon, lat, 0);
        const fn = ST.worldToWindowCoordinates || ST.wgs84ToWindowCoordinates;
        const win = fn(v.scene, carto);
        return win ? { x: +win.x.toFixed(2), y: +win.y.toFixed(2) } : null;
      };
      // Grid centered on NA + ring toward the limb (south ring is where the
      // reported tear lives).
      const samples = [
        { tag: "center", lon: -95, lat: 40 },
        { tag: "n", lon: -95, lat: 70 },
        { tag: "s", lon: -95, lat: 10 },
        { tag: "e", lon: -55, lat: 40 },
        { tag: "w", lon: -135, lat: 40 },
        { tag: "far-s", lon: -95, lat: -20 },
        { tag: "far-s2", lon: -95, lat: -50 },
        { tag: "se", lon: -55, lat: 0 },
        { tag: "sw", lon: -135, lat: 0 },
        { tag: "spole", lon: -95, lat: -85 },
        { tag: "npole", lon: -95, lat: 85 },
      ];
      const pts = {};
      for (const s of samples) pts[s.tag] = project(s.lon, s.lat);
      const f = v.camera.frustum;
      return {
        heightMm,
        points: pts,
        cam: {
          fov: f.fov,
          fovy: f.fovy,
          aspectRatio: f.aspectRatio,
          near: f.near,
          far: f.far,
          posMag: C3.magnitude(v.camera.positionWC),
        },
      };
    },
    { heightMm },
  );
}

/**
 * Measure the disc SILHOUETTE on both backends from the atmosphere-OFF PNGs, and
 * DETECT A TEAR. Decodes both PNGs in a 2D canvas (run on the GL page).
 *
 * Tear detection: for the WebGPU disc, walk every scanline that intersects the
 * disc and find the LONGEST contiguous disc run. If a scanline ALSO contains a
 * sizeable SECOND disc run separated by a background gap (i.e. the row is split
 * by a magenta wedge), OR a column's filled span has a big internal background
 * gap, that's a concave bite / fold = a tear. Report the largest such gap and
 * its location.
 */
async function measureDiscAndTear(page, glPath, gpuPath, bg) {
  const glB64 = fs.readFileSync(glPath).toString("base64");
  const gpuB64 = fs.readFileSync(gpuPath).toString("base64");
  return await page.evaluate(
    async ({ glB64, gpuB64, bg }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: c.width,
          h: c.height,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };

      const analyze = (im) => {
        const { w, h, data } = im;
        const idx = (x, y) => (y * w + x) * 4;
        const TOL = 36;
        const isBG = (i) =>
          Math.abs(data[i] - bg.r) <= TOL &&
          Math.abs(data[i + 1] - bg.g) <= TOL &&
          Math.abs(data[i + 2] - bg.b) <= TOL;
        const isDisc = (i) => !isBG(i);

        let x0 = w,
          x1 = -1,
          y0 = h,
          y1 = -1,
          area = 0;
        const rowL = new Array(h).fill(-1);
        const rowR = new Array(h).fill(-1);

        // Tear scan: for each row, collect all disc RUNS >= MINRUN; the disc
        // should be ONE run per scanline (convex). A second sizeable run with a
        // background gap between them = a wedge/bite cutting into the disc.
        const MINRUN = 6;
        let maxInternalGap = 0;
        let tearRowY = -1;
        let tearGapXrange = null;
        let tornRows = 0;

        for (let y = 0; y < h; y++) {
          // Find all runs of disc pixels on this row.
          const runs = [];
          let s = -1;
          for (let x = 0; x < w; x++) {
            const disc = isDisc(idx(x, y));
            if (disc) {
              area++;
              if (s === -1) s = x;
            } else if (s !== -1) {
              if (x - s >= MINRUN) runs.push([s, x - 1]);
              s = -1;
            }
          }
          if (s !== -1 && w - s >= MINRUN) runs.push([s, w - 1]);
          if (runs.length === 0) continue;

          // Longest run = the main disc body on this scanline.
          let best = runs[0];
          for (const r of runs) if (r[1] - r[0] > best[1] - best[0]) best = r;
          rowL[y] = best[0];
          rowR[y] = best[1];
          if (best[0] < x0) x0 = best[0];
          if (best[1] > x1) x1 = best[1];
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;

          // Internal-gap (tear) detection: the gap is the largest background
          // run that sits BETWEEN two disc runs on this scanline (i.e. wholly
          // inside the disc's horizontal extent). Use the union extent of all
          // runs >= MINRUN as the disc's true horizontal span for this row.
          if (runs.length >= 2) {
            const left = runs[0][0];
            const right = runs[runs.length - 1][1];
            // Largest interior background gap between consecutive runs.
            let rowGap = 0,
              rowGapX = null;
            for (let k = 0; k < runs.length - 1; k++) {
              const gap = runs[k + 1][0] - runs[k][1] - 1;
              if (gap > rowGap) {
                rowGap = gap;
                rowGapX = [runs[k][1] + 1, runs[k + 1][0] - 1];
              }
            }
            // Only count if both flanking runs are substantial (real disc, not
            // an isolated speck) and the gap is non-trivial.
            const flankL = runs[0][1] - runs[0][0] + 1;
            const flankR = runs[runs.length - 1][1] - runs[runs.length - 1][0] + 1;
            if (rowGap >= 8 && flankL >= 12 && flankR >= 12) {
              tornRows++;
              if (rowGap > maxInternalGap) {
                maxInternalGap = rowGap;
                tearRowY = y;
                tearGapXrange = rowGapX;
              }
            }
            void left;
            void right;
          }
        }

        const bboxW = x1 >= x0 ? x1 - x0 + 1 : 0;
        const bboxH = y1 >= y0 ? y1 - y0 + 1 : 0;
        const cx = x1 >= x0 ? (x0 + x1) / 2 : null;
        const cy = y1 >= y0 ? (y0 + y1) / 2 : null;
        const midY = cy != null ? Math.round(cy) : -1;
        const widthAtCenter =
          midY >= 0 && rowL[midY] >= 0 ? rowR[midY] - rowL[midY] + 1 : null;

        // Height at center column: scan the center column for disc extent.
        let colT = -1,
          colB = -1;
        const midX = cx != null ? Math.round(cx) : -1;
        if (midX >= 0) {
          for (let y = 0; y < h; y++) {
            if (isDisc(idx(midX, y))) {
              if (colT < 0) colT = y;
              colB = y;
            }
          }
        }
        const heightAtCenter = colT >= 0 ? colB - colT + 1 : null;

        // Max row width (true equatorial diameter of the disc as drawn).
        let maxRowW = 0,
          maxRowY = -1;
        for (let y = 0; y < h; y++) {
          if (rowL[y] >= 0) {
            const wid = rowR[y] - rowL[y] + 1;
            if (wid > maxRowW) {
              maxRowW = wid;
              maxRowY = y;
            }
          }
        }

        return {
          w,
          h,
          bbox: { x0, x1, y0, y1, w: bboxW, h: bboxH },
          center: { x: cx != null ? +cx.toFixed(1) : null, y: cy != null ? +cy.toFixed(1) : null },
          area,
          widthAtCenter,
          heightAtCenter,
          maxRow: { width: maxRowW, y: maxRowY },
          tear: {
            present: maxInternalGap >= 8 && tornRows >= 3,
            maxInternalGapPx: maxInternalGap,
            tornRows,
            atRowY: tearRowY,
            gapXrange: tearGapXrange,
            // Where vertically does the tear sit? (fraction of disc height,
            // 0=top 1=bottom). Owner says bottom wedge.
            vfracInDisc:
              tearRowY >= 0 && bboxH > 0
                ? +((tearRowY - y0) / bboxH).toFixed(2)
                : null,
          },
        };
      };

      const A = await decode(glB64);
      const B = await decode(gpuB64);
      const gl = analyze(A);
      const gpu = analyze(B);

      const ratio = (a, b) => (a != null && b ? +(a / b).toFixed(4) : null);
      return {
        gl,
        gpu,
        discSizeRatio: {
          // WebGPU / WebGL.
          widthAtCenter: ratio(gpu.widthAtCenter, gl.widthAtCenter),
          heightAtCenter: ratio(gpu.heightAtCenter, gl.heightAtCenter),
          maxRowWidth: ratio(gpu.maxRow.width, gl.maxRow.width),
          bboxW: ratio(gpu.bbox.w, gl.bbox.w),
          bboxH: ratio(gpu.bbox.h, gl.bbox.h),
          area: ratio(gpu.area, gl.area),
        },
      };
    },
    { glB64, gpuB64, bg },
  );
}

async function run() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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

  const gl = await bootViewer(browser, "webgl");
  const gpu = await bootViewer(browser, "webgpu");

  const imageryGL = await ensureImagery(gl.page);
  const imageryGPU = await ensureImagery(gpu.page);

  const report = {
    loaded: false,
    viewport: VIEWPORT,
    naView: NA,
    heightsMm: HEIGHTS_MM,
    imagery: { webgl: imageryGL, webgpu: imageryGPU },
    runs: [],
    paths: {},
    errors: { webgl: [], webgpu: [] },
  };

  const pngPaths = [];

  for (const heightMm of HEIGHTS_MM) {
    for (const orient of ORIENTS) {
      for (const atmoOn of [true, false]) {
        const atmoTag = atmoOn ? "atmoOn" : "atmoOff";
        const label = `farcam-${atmoTag}-h${heightMm}-${orient.tag}`;

        const sgl = await setView(gl.page, {
          atmoOn,
          heightMm,
          pitchDeg: orient.pitchDeg,
          bg: BG,
        });
        const sgpu = await setView(gpu.page, {
          atmoOn,
          heightMm,
          pitchDeg: orient.pitchDeg,
          bg: BG,
        });

        const settleGL = await settle(gl.page);
        const settleGPU = await settle(gpu.page);
        await sleep(300);

        const glPath = path.join(OUT_DIR, `${label}-webgl.png`);
        const gpuPath = path.join(OUT_DIR, `${label}-webgpu.png`);
        const okGL = await capture(gl.page, glPath);
        const okGPU = await capture(gpu.page, gpuPath);
        if (okGL) pngPaths.push(glPath);
        if (okGPU) pngPaths.push(gpuPath);

        const entry = {
          heightMm,
          orient: orient.tag,
          pitchDeg: orient.pitchDeg,
          atmoOn,
          setup: { webgl: sgl, webgpu: sgpu },
          settle: { webgl: settleGL, webgpu: settleGPU },
          captured: { webgl: okGL, webgpu: okGPU },
          glPath,
          gpuPath,
        };

        // Disc silhouette + tear only on the atmosphere-OFF pass.
        if (!atmoOn && okGL && okGPU) {
          try {
            entry.disc = await measureDiscAndTear(gl.page, glPath, gpuPath, BG);
          } catch (e) {
            entry.discErr = String(e && e.message ? e.message : e);
          }
        }
        // Camera projection check (both passes, cheap).
        try {
          const camGL = await cameraProbe(gl.page, heightMm);
          const camGPU = await cameraProbe(gpu.page, heightMm);
          entry.camera = buildCameraDelta(camGL, camGPU);
        } catch (e) {
          entry.cameraErr = String(e && e.message ? e.message : e);
        }

        report.runs.push(entry);
        console.error(
          `[probe] h=${heightMm}Mm ${orient.tag} ${atmoTag} ` +
            `settledGPU=${settleGPU.settledFrame} cov=${settleGPU.lastCoverage} ` +
            (entry.disc
              ? `tearGPU=${entry.disc.gpu.tear.present} ` +
                `wRatio=${entry.disc.discSizeRatio.maxRowWidth}`
              : ""),
        );
      }
    }
  }

  report.loaded = true;
  report.pngPaths = pngPaths;
  report.errors.webgl = gl.errs.slice(0, 8);
  report.errors.webgpu = gpu.errs.slice(0, 8);

  await browser.close();
  return report;
}

/** Cross-backend per-point window-coord deltas. */
function buildCameraDelta(camGL, camGPU) {
  const tags = Object.keys(camGL.points);
  const points = tags.map((tag) => {
    const g = camGL.points[tag];
    const p = camGPU.points[tag];
    return {
      tag,
      gl: g,
      gpu: p,
      dist: g && p ? +Math.hypot(p.x - g.x, p.y - g.y).toFixed(2) : null,
    };
  });
  let maxDist = 0,
    maxTag = null;
  for (const pt of points) {
    if (pt.dist != null && pt.dist > maxDist) {
      maxDist = pt.dist;
      maxTag = pt.tag;
    }
  }
  return {
    maxPointDeltaPx: +maxDist.toFixed(2),
    maxPointTag: maxTag,
    points,
    cam: { webgl: camGL.cam, webgpu: camGPU.cam },
  };
}

(async () => {
  const result = await run();
  // Print JSON to stdout (stderr carries the progress lines).
  console.log(JSON.stringify(result, null, 2));
})();
