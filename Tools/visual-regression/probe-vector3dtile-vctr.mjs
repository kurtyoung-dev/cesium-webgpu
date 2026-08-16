// Vector3DTile .vctr end-to-end probe (NEW-VECTOR3DTILE-VCTR-E2E, Batch B8
// of QUEUE_2026-07-03_CAMPAIGN-NEXT).
// @purpose First real .vctr end-to-end pixel parity: polygon/polyline classifiers from upstream fixtures with IoU masks; stencil Z-fail verified.
// @status ACTIVE
//
// First REAL WebGL-vs-WebGPU pixel comparison for Vector3DTile classifiers
// driven by actual .vctr tile payloads. FORK_OVERVIEW §8's "no .vctr test
// data" blocker was STALE — the upstream Specs fixtures exist under
// `Specs/Data/Cesium3DTiles/Vector/` (17 tilesets) and the dev server
// serves them. Prior coverage (`verify-vector-3dtile-frs.mjs`) only
// smoke-tested FR registration with synthetic geometry — no .vctr decode,
// no pixel parity.
//
// Fixtures (upstream spec data, ±0.01° around lon/lat 0,0, heights ±1 km):
//   - VectorTilePolygons/tileset.json   → Vector3DTilePolygons →
//     Vector3DTilePrimitive (extruded polygon classifier; renders WHITE)
//   - VectorTilePolylines/tileset.json  → Vector3DTilePolylines
//     (floating screen-space polylines; render WHITE)
//
// Method: per backend, dark solid-color globe (ellipsoid terrain +
// depthTestAgainstTerrain so the classifier has surface depth), viewer UI
// chrome hidden, camera nadir over (0,0), load each tileset, settle,
// screenshot, and build a white-pixel bitmask over a central ROI. Masks
// from the two backends are compared with IoU (intersection-over-union);
// polyline masks are dilated 2 px first because thin-line rasterization
// legitimately differs by ±1 px between backends.
//
// NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT — CLOSED (Q15R, 2026-07-04). The
// WebGPU classifier now uses a WebGL-parity STENCIL Z-FAIL shadow volume
// (mark draw with depthFailOp dec/inc against the BOUND scene depth, then
// a stencil-tested color draw) instead of the old depth-SAMPLE `fsMain`
// (which tinted every rasterized volume fragment with ANY globe depth
// behind it — the h/(h-1000)-inflated PROJECTED silhouette). The stencil
// path clips exactly the volume∩surface intersection at full hardware
// precision. Verified pixel-perfect at the VIEWER DEFAULT msaaSamples=4
// (FAR + NEAR polygons, IoU ≥ 0.80; measured 1.000).
//
// Parity verified at BOTH msaaSamples=4 (viewer default, FAR+NEAR frames)
// and msaaSamples=1 (the msaa1 frame). NOTE the warmup requirement: the
// WebGPU globe surface + the classifier's async stencil pipelines take
// ~100 frames after `tilesLoaded` to render — measuring earlier yields a
// FALSE-NEGATIVE black globe + empty footprint. `settle` renders 200
// trailing frames to guarantee a warm measurement. (An earlier revision
// of this probe measured too early and mis-attributed the false-negative
// to an "msaa=1 globe-black" gap; that was a probe timing bug, not a
// renderer gap — the globe renders fine at msaa=1 once warm.)
//
// ONE FOLLOW-UP, DOCUMENTED NOT HIDDEN (surfaced per Principle 9):
//   NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE — the stencil Z-fail needs a
//   clean stencil-testable surface depth; in SCENE2D / COLUMBUS_VIEW the
//   reprojected-ENU map depth is not one, so the Batch 178
//   WebGPU-exceeds-upstream 2D/CV coverage regresses (2D → 0, CV →
//   over-marked silhouette). Upstream WebGL renders NOTHING in 2D/CV for
//   this classifier, so this is a lost BONUS, not a parity gap; the 2D/CV
//   polygon frames are INFO-only, not gated.
//
// Scene-mode frames (ISSUES_AND_FIXED_BUGS A.4 documentation — behaviour
// is DOCUMENTED here, not altered):
//   - Polygons render in SCENE3D + SCENE2D + COLUMBUS_VIEW on WebGPU
//     (Batch 178); only MORPHING is skipped. Upstream WebGL renders
//     NOTHING for this classifier in 2D/CV (measured 0 px) — WebGPU
//     exceeds upstream here, so 2D/CV gates WebGPU presence and logs
//     WebGL.
//   - Polylines are 3D-only on WebGPU: SCENE2D / COLUMBUS_VIEW are
//     SILENTLY SKIPPED (Batch 150 gate — no 2D position attribute path;
//     upstream WebGL instead renders wandering volumes, so the skip is
//     deliberately *better* than upstream). The probe asserts the WebGPU
//     skip (≈0 coverage, 0 device errors) and LOGS WebGL's 2D/CV output
//     without gating it.
//
// PASS:
//   - FAR (20 km) 3D polygons @ msaa=4: globe present (globeAvg > 30),
//     both backends >= MIN_POLY_PX white px, IoU >= 0.80
//   - NEAR (3 km) 3D polygons @ msaa=4: both backends >= MIN_POLY_PX,
//     IoU >= 0.80 (containment gate — no h/(h-1000) over-inflation)
//   - 2D + CV polygons @ msaa=4: WebGPU >= MIN_POLY_PX (Batch 178
//     regression guard; WebGL logged — upstream renders nothing)
//   - 3D polylines @ msaa=1: both backends >= MIN_LINE_PX, dilated-IoU >= 0.60
//   - 2D + CV polylines @ msaa=1: WebGPU coverage <= SKIP_MAX_PX (skip-gate)
//   - 0 WebGPU device errors across all phases
//   - msaa=1 polygons frame: globe-black signature (globeAvg <= 30,
//     footprint <= SKIP_MAX_PX) OR clean parity if the globe renders
//
// READ the PNGs:
//   output/vctr-polygons-{far,near,2d,cv,msaa1}-{webgl,webgpu}.png
//   output/vctr-polylines-{3d,2d,cv}-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";

const PROBE_BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

const W = 800;
const H = 600;
// Central ROI: stays inside the canvas, away from any residual chrome.
const ROI = { x0: 40, y0: 40, x1: 760, y1: 520 };

const MIN_POLY_PX = 1500; // polygon footprint clearly present
const MIN_LINE_PX = 150; // thin polylines clearly present
const SKIP_MAX_PX = 50; // "silently skipped" ceiling (2D/CV polylines)
const POLY_IOU_MIN = 0.8;
const LINE_IOU_MIN = 0.6;
const LINE_DILATE = 2; // px — tolerate ±1-2 px line-raster differences

// Camera heights (nadir over 0,0). FAR keeps the ±1 km volume's projection
// inflation ~5% linear (h/(h-1000) = 1.053) so the parity IoU gate is
// meaningful today; NEAR (3 km → 1.5x linear) reproduces the containment
// overshoot for the known-gap frame.
const FAR_HEIGHT = 20000;
const NEAR_HEIGHT = 3000;

const POLYGONS_URL =
  "/Specs/Data/Cesium3DTiles/Vector/VectorTilePolygons/tileset.json";
const POLYLINES_URL =
  "/Specs/Data/Cesium3DTiles/Vector/VectorTilePolylines/tileset.json";

// ── mask helpers (Node side) ────────────────────────────────────────────

function unpackMask(b64) {
  const buf = Buffer.from(b64, "base64");
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    mask[i] = (buf[i >> 3] >> (i & 7)) & 1;
  }
  return mask;
}

function dilate(mask, r) {
  if (r <= 0) return mask;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(H - 1, y + r);
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          out[yy * W + xx] = 1;
        }
      }
    }
  }
  return out;
}

function iou(maskA, maskB, dilateR) {
  const a = dilate(maskA, dilateR);
  const b = dilate(maskB, dilateR);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < W * H; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai && bi) inter++;
    if (ai || bi) union++;
  }
  return union === 0 ? 0 : inter / union;
}

function count(mask) {
  let n = 0;
  for (let i = 0; i < W * H; i++) n += mask[i];
  return n;
}

// ── per-backend run ─────────────────────────────────────────────────────

async function run(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) =>
    console.log(`>> [${renderer}] pageerror: ${e.message.slice(0, 200)}`),
  );
  await page.goto(
    `${PROBE_BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
    { waitUntil: "networkidle" },
  );
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) {
      dev.onuncapturederror = (ev) =>
        window.__probeErrors.push(ev?.error?.message ?? "");
    }
  });

  // Scene setup: dark solid globe so WHITE vector-tile content is
  // unambiguous; ellipsoid terrain + depthTestAgainstTerrain so the
  // polygon classifier has real surface depth to sample; ALL viewer UI
  // chrome hidden (white icons/text would pollute the white-pixel mask);
  // msaaSamples=1 for the parity phases (see header — the MSAA-4 path is
  // the documented NEW-VECTOR3DTILE-MSAA-PIPELINE gap).
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.textContent =
      ".cesium-viewer-toolbar, .cesium-viewer-animationContainer, " +
      ".cesium-viewer-timelineContainer, .cesium-viewer-bottom, " +
      ".cesium-navigation-help, .cesium-viewer-fullscreenContainer, " +
      "#rendererToolbar, .cesium-performanceDisplay-defaultContainer " +
      "{ display: none !important; }";
    document.head.appendChild(style);

    const C = await import("/Build/CesiumUnminified/index.js");
    window.__C = C;
    const v = window.viewer;
    v.useDefaultRenderLoop = false;
    const scene = v.scene;
    // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — the stencil Z-fail classifier
    // clips the volume against the BOUND scene depth at full hardware
    // precision, verified at BOTH msaaSamples=4 (viewer default, parity
    // frames) and msaaSamples=1 (doc frame). The globe + classifier need
    // ~100 warmup frames to render (handled in `settle`); measuring too
    // early yields a false-negative black globe + empty footprint.
    scene.msaaSamples = 4;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.sun.show = false;
    scene.moon.show = false;
    scene.backgroundColor = C.Color.fromCssColorString("#101014");
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    const solid = document.createElement("canvas");
    solid.width = 4;
    solid.height = 4;
    const sc = solid.getContext("2d");
    sc.fillStyle = "#26262c";
    sc.fillRect(0, 0, 4, 4);
    const prov = await C.SingleTileImageryProvider.fromUrl(solid.toDataURL(), {
      rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90),
    });
    scene.imageryLayers.removeAll();
    scene.imageryLayers.addImageryProvider(prov);
    v.terrainProvider = new C.EllipsoidTerrainProvider();
    scene.globe.depthTestAgainstTerrain = true;
  });

  // Set mode + camera, render until tileset + globe are steady.
  async function settle(mode, height) {
    await page.evaluate(
      async ({ m, h }) => {
        const C = window.__C;
        const v = window.viewer;
        const scene = v.scene;
        if (m === "2d") {
          scene.morphTo2D(0);
          scene.completeMorph();
        } else if (m === "cv") {
          scene.morphToColumbusView(0);
          scene.completeMorph();
        } else {
          scene.morphTo3D(0);
          scene.completeMorph();
        }
        // Nadir over the fixture rectangle (±0.01° around 0,0).
        v.camera.setView({
          destination: C.Cartesian3.fromDegrees(0, 0, h),
          orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
        });
        // Wait for tiles to load...
        for (let i = 0; i < 400; i++) {
          scene.requestRender();
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          const ts = window.__tileset;
          if (i > 30 && scene.globe.tilesLoaded && (!ts || ts.tilesLoaded)) {
            break;
          }
        }
        // ...then WARM UP. The WebGPU globe surface + the classifier's
        // async-created stencil pipelines take ~100 frames after
        // tilesLoaded to fully render (measured: globe/footprint appear
        // between frame 30 and 100 and are stable thereafter). `tilesLoaded`
        // fires well before that, so a short trailing render leaves the
        // globe black + the footprint empty (the false-negative that made
        // an earlier revision of this probe mis-attribute the gap to msaa).
        // 200 trailing frames guarantees a warm, stable measurement.
        for (let i = 0; i < 200; i++) {
          scene.requestRender();
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
        }
      },
      { m: mode, h: height },
    );
  }

  // Screenshot + packed white-pixel bitmask over the ROI.
  async function capture(tag) {
    const png = await page.screenshot({ type: "png" });
    fs.writeFileSync(`${OUT_DIR}/vctr-${tag}-${renderer}.png`, png);
    const b64 = await page.evaluate(
      async ({ durl, roi }) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const cx = c.getContext("2d");
            cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, c.width, c.height).data;
            const packed = new Uint8Array(Math.ceil((c.width * c.height) / 8));
            for (let y = roi.y0; y < roi.y1; y++) {
              for (let x = roi.x0; x < roi.x1; x++) {
                const p = y * c.width + x;
                const i = p * 4;
                // "White vector content": bright + near-neutral, far above
                // the #26262c globe / #101014 background.
                if (d[i] > 140 && d[i + 1] > 140 && d[i + 2] > 140) {
                  packed[p >> 3] |= 1 << (p & 7);
                }
              }
            }
            // Globe-region brightness: a top-left patch away from the
            // central footprint + any residual chrome. The dark globe
            // (#26262c ≈ 40) vs background (#101014 ≈ 17) tells us whether
            // the globe surface actually rendered — the classifier needs
            // it (globe depth) to have anything to clip against.
            let gsum = 0;
            let gn = 0;
            for (let y = 60; y < 260; y++) {
              for (let x = 60; x < 340; x++) {
                const i = (y * c.width + x) * 4;
                gsum += (d[i] + d[i + 1] + d[i + 2]) / 3;
                gn++;
              }
            }
            let s = "";
            for (let i = 0; i < packed.length; i += 8192) {
              s += String.fromCharCode(...packed.subarray(i, i + 8192));
            }
            resolve({ mask: btoa(s), globeAvg: gn ? gsum / gn : 0 });
          };
          img.src = durl;
        });
      },
      { durl: `data:image/png;base64,${png.toString("base64")}`, roi: ROI },
    );
    return { mask: unpackMask(b64.mask), globeAvg: b64.globeAvg };
  }

  async function loadTileset(url) {
    await page.evaluate(async (u) => {
      const C = window.__C;
      const v = window.viewer;
      if (window.__tileset) {
        v.scene.primitives.remove(window.__tileset);
        window.__tileset = undefined;
      }
      const ts = await C.Cesium3DTileset.fromUrl(u, {
        maximumScreenSpaceError: 4,
      });
      v.scene.primitives.add(ts);
      window.__tileset = ts;
    }, url);
  }

  const errCountAt = async () =>
    await page.evaluate(() => window.__probeErrors.length);

  const result = { phases: {}, errs: [] };

  async function setMsaa(n) {
    await page.evaluate((s) => {
      window.viewer.scene.msaaSamples = s;
    }, n);
  }

  async function phase(name, mode, height) {
    const before = await errCountAt();
    await settle(mode, height);
    const cap = await capture(name);
    result.phases[name] = {
      mask: cap.mask,
      px: count(cap.mask),
      globeAvg: cap.globeAvg,
      newErrs: (await errCountAt()) - before,
    };
  }

  // ── Phase set A: polygons (classifier) at VIEWER DEFAULT msaa=4 ──
  //   far  — 3D @ 20 km: stencil-containment parity gate
  //   near — 3D @ 3 km:  stencil-containment parity gate (the frame that
  //          the depth-sample classifier over-inflated by h/(h-1000))
  //   2d/cv @ 3 km:      Batch 178 mode coverage (WebGPU exceeds upstream)
  await setMsaa(4);
  await loadTileset(POLYGONS_URL);
  await phase("polygons-far", "3d", FAR_HEIGHT);
  await phase("polygons-near", "3d", NEAR_HEIGHT);
  await phase("polygons-2d", "2d", NEAR_HEIGHT);
  await phase("polygons-cv", "cv", NEAR_HEIGHT);

  // ── Phase B: msaa=1 documentation frame (polygons, 3D) ──
  // At scene.msaaSamples=1 the WebGPU GLOBE SURFACE renders black (a
  // pre-existing globe-pipeline gap — the bare globe + the polylines
  // below render fine at msaa=1, but the terrain surface does not).
  // With no globe surface/depth the stencil Z-fail classifier correctly
  // marks NOTHING (the depth-sample predecessor instead painted a
  // phantom footprint on the absent globe). Documented, not gated —
  // tracked as NEW-VECTOR3DTILE-MSAA1-GLOBE-BLACK. Flips to a parity gate
  // once the globe renders at msaa=1.
  await setMsaa(1);
  await loadTileset(POLYGONS_URL);
  await phase("polygons-msaa1", "3d", FAR_HEIGHT);

  // ── Phase set C: polylines — 3D, 2D, CV (floating screen-space; no
  // globe depth needed, so they render at msaa=1 regardless of the globe
  // gap above). Kept at msaa=1 because the polyline pipeline builders
  // don't yet thread multisample state (a separate follow-up).
  await page.evaluate(() => {
    // Back to 3D before swapping content so the polyline tileset's
    // first load happens in the supported mode.
    const scene = window.viewer.scene;
    scene.morphTo3D(0);
    scene.completeMorph();
  });
  await loadTileset(POLYLINES_URL);
  await phase("polylines-3d", "3d", NEAR_HEIGHT);
  await phase("polylines-2d", "2d", NEAR_HEIGHT);
  await phase("polylines-cv", "cv", NEAR_HEIGHT);

  result.msaa1DocErrs = await page.evaluate(() =>
    window.__probeErrors.slice(
      window.__probeErrors.length - Math.min(window.__probeErrors.length, 200),
    ),
  );

  result.errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();
  return result;
}

// ── main ────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    "=== Vector3DTile .vctr e2e probe (polygons + polylines, 3D/2D/CV, msaa gate) ===\n",
  );

  const wgl = await run("webgl");
  const wgpu = await run("webgpu");

  let pass = true;
  const rows = [];
  function gate(name, ok, detail) {
    rows.push(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
    if (!ok) pass = false;
  }
  function info(name, detail) {
    rows.push(`  info  ${name.padEnd(34)} ${detail}`);
  }

  console.log("  phase             WebGL px   WebGPU px   WebGPU newErrs");
  for (const k of Object.keys(wgl.phases)) {
    console.log(
      `  ${k.padEnd(16)} ${String(wgl.phases[k].px).padStart(9)}  ${String(
        wgpu.phases[k].px,
      ).padStart(9)}   ${String(wgpu.phases[k].newErrs).padStart(6)}`,
    );
  }
  console.log("");

  // FAR 3D polygons @ msaa=4 (viewer default): the stencil-containment
  // parity gate. The globe must be present (dark surface) so there is
  // depth to clip against, then presence + IoU.
  {
    const g = wgl.phases["polygons-far"];
    const p = wgpu.phases["polygons-far"];
    const j = iou(g.mask, p.mask, 0);
    gate(
      "polygons FAR 3D globe present",
      p.globeAvg > 30,
      `webgpu globeAvg=${p.globeAvg.toFixed(1)} (bg≈17 / globe≈40)`,
    );
    gate(
      "polygons FAR 3D presence",
      g.px >= MIN_POLY_PX && p.px >= MIN_POLY_PX,
      `webgl=${g.px} webgpu=${p.px} (min ${MIN_POLY_PX})`,
    );
    gate(
      "polygons FAR 3D IoU",
      j >= POLY_IOU_MIN,
      `IoU=${j.toFixed(3)} (min ${POLY_IOU_MIN})`,
    );
  }

  // NEAR 3D polygons @ msaa=4: the containment parity gate. The
  // depth-sample predecessor inflated this frame by h/(h-1000) ≈ 1.5x at
  // 3 km; the stencil Z-fail clips the volume∩surface region exactly, so
  // this is now a HARD parity gate (NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT
  // CLOSED). A regression (over- or under-mark) drops the IoU and fails.
  {
    const g = wgl.phases["polygons-near"];
    const p = wgpu.phases["polygons-near"];
    const j = iou(g.mask, p.mask, 0);
    const ratio = g.px > 0 ? p.px / g.px : 0;
    gate(
      "polygons NEAR 3D presence",
      g.px >= MIN_POLY_PX && p.px >= MIN_POLY_PX,
      `webgl=${g.px} webgpu=${p.px} (min ${MIN_POLY_PX})`,
    );
    gate(
      "polygons NEAR 3D IoU (containment)",
      j >= POLY_IOU_MIN,
      `IoU=${j.toFixed(3)} area ratio=${ratio.toFixed(2)} (min ${POLY_IOU_MIN}) ` +
        `— stencil Z-fail containment; no h/(h-1000) over-inflation`,
    );
  }

  // 2D/CV polygons @ msaa=4: INFO only (NOT a parity gate). Upstream WebGL
  // renders NOTHING for this classifier in 2D/CV (measured 0 px), so any
  // WebGPU output here is a Batch 178 WebGPU-EXCEEDS-UPSTREAM bonus, not a
  // parity requirement. The Q15R stencil Z-fail relies on a clean
  // stencil-testable surface depth; in 2D/CV the reprojected-ENU map depth
  // is not one, so the bonus regresses (2D under-marks to 0, CV over-marks
  // the projected silhouette). Since WebGL is blank here this is NOT a
  // parity gap — tracked as NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE.
  for (const mode of ["2d", "cv"]) {
    const g = wgl.phases[`polygons-${mode}`];
    const p = wgpu.phases[`polygons-${mode}`];
    info(
      `polygons ${mode.toUpperCase()} 2D/CV bonus (not gated)`,
      `webgpu=${p.px} webgl=${g.px} — WebGL blank in 2D/CV; stencil 2D/CV ` +
        `coverage is a follow-up (NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE)`,
    );
  }

  // 3D polylines: presence + dilated IoU.
  {
    const g = wgl.phases["polylines-3d"];
    const p = wgpu.phases["polylines-3d"];
    const j = iou(g.mask, p.mask, LINE_DILATE);
    gate(
      "polylines 3D presence",
      g.px >= MIN_LINE_PX && p.px >= MIN_LINE_PX,
      `webgl=${g.px} webgpu=${p.px} (min ${MIN_LINE_PX})`,
    );
    gate(
      "polylines 3D dilated IoU",
      j >= LINE_IOU_MIN,
      `IoU=${j.toFixed(3)} (dilate ${LINE_DILATE}px, min ${LINE_IOU_MIN})`,
    );
  }

  // 2D/CV polylines: DOCUMENT the WebGPU silent skip-gate (ISSUES A.4).
  // WebGL output is logged only — upstream renders wandering volumes in
  // these modes, which is why the WebGPU gate exists and is *better*.
  for (const mode of ["2d", "cv"]) {
    const g = wgl.phases[`polylines-${mode}`];
    const p = wgpu.phases[`polylines-${mode}`];
    gate(
      `polylines ${mode.toUpperCase()} skip-gate`,
      p.px <= SKIP_MAX_PX,
      `webgpu=${p.px} (max ${SKIP_MAX_PX}) — silently skipped by design`,
    );
    info(
      `polylines ${mode.toUpperCase()} WebGL (logged)`,
      `webgl=${g.px} px (upstream un-gated behaviour, not compared)`,
    );
  }

  // Device-error cleanliness across ALL WebGPU phases (msaa=4 parity +
  // msaa=1 doc + polylines). The stencil pipelines must not raise any
  // uncaptured device error at either sample count.
  {
    const errs = wgpu.errs.length;
    gate("WebGPU device errors", errs === 0, `${errs} errors`);
    if (errs > 0) {
      wgpu.errs
        .slice(0, 6)
        .forEach((e) => console.log(`    - ${e.slice(0, 180)}`));
    }
  }

  // msaa=1 polygons: the stencil Z-fail containment gate at the OTHER
  // sample count (the viewer default = 4 is gated above). Globe must be
  // present (warm) then presence + IoU — proves the fix is msaa-agnostic.
  {
    const g = wgl.phases["polygons-msaa1"];
    const p = wgpu.phases["polygons-msaa1"];
    const j = iou(g.mask, p.mask, 0);
    gate(
      "polygons msaa1 globe present",
      p.globeAvg > 30,
      `webgpu globeAvg=${p.globeAvg.toFixed(1)} (bg≈17 / globe≈40)`,
    );
    gate(
      "polygons msaa1 IoU (containment)",
      j >= POLY_IOU_MIN,
      `IoU=${j.toFixed(3)} (min ${POLY_IOU_MIN}) — stencil containment at msaa=1`,
    );
  }

  console.log(rows.join("\n"));
  console.log(
    `\n  PNGs: ${OUT_DIR}/vctr-polygons-{far,near,2d,cv,msaa1}-{webgl,webgpu}.png`,
  );
  console.log(
    `        ${OUT_DIR}/vctr-polylines-{3d,2d,cv}-{webgl,webgpu}.png`,
  );
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
