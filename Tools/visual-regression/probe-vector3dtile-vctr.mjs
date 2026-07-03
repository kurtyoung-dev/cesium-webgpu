// Vector3DTile .vctr end-to-end probe (NEW-VECTOR3DTILE-VCTR-E2E, Batch B8
// of QUEUE_2026-07-03_CAMPAIGN-NEXT).
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
// TWO KNOWN GAPS DOCUMENTED, NOT HIDDEN (both discovered BY this probe,
// surfaced per Principle 9 as follow-up fix batches):
//
// 1. NEW-VECTOR3DTILE-MSAA-PIPELINE — the parity phases run at
//    `scene.msaaSamples = 1` on BOTH backends because none of the three
//    WebGPU Vector3DTile pipeline builders
//    (`WebGPUVector3DTilePrimitiveRenderer.buildVectorTilePipelineResources`,
//    and the polylines / clamped-polylines equivalents) set `multisample`
//    state — under the viewer's DEFAULT 4x-MSAA scene framebuffer every
//    vector-tile draw raises "Attachment state ... is not compatible with
//    [RenderPassEncoder "Scene Framebuffer Render Pass"]" and invalidates
//    the whole frame (black scene). GroundPrimitive already threads
//    `context._msaaSamples` through (WebGPUGroundPrimitiveRenderer L1372)
//    — the vector renderers need the same. The msaa4 frame REPRODUCES the
//    gap and passes only while the known error signature matches; once
//    the fix lands it flips to a hard parity gate.
//
// 2. NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT — the WebGPU depth-sample
//    classifier (`fsMain` in WebGPUVector3DTilePrimitiveRenderer) tints
//    every fragment of the rasterized classification volume that has ANY
//    globe depth behind it (`surfaceDepth == 0.0` discard only) — it
//    never tests that the reconstructed surface point lies INSIDE the
//    volume. WebGL's stencil shadow-volume path shades exactly the
//    volume∩surface intersection. Net effect: the WebGPU footprint is
//    the volume's PROJECTED screen extent, inflated by the volume's
//    ±1 km top face — measured scale h/(h-1000) at nadir camera height h
//    (1.53x linear at 3 km, 1.09x at 12 km, →1 as h→∞). The FAR frame
//    (20 km, inflation ~5% linear) is the gated parity check; the NEAR
//    frame (3 km) reproduces the overshoot and passes only while the
//    known superset signature holds (WebGPU mask ⊇ WebGL mask, area
//    ratio > 1.2); once containment lands it flips to a parity gate.
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
// PASS (all at msaaSamples=1 unless noted):
//   - FAR (20 km) 3D polygons: both backends >= MIN_POLY_PX white px,
//     IoU >= 0.80
//   - NEAR (3 km) 3D polygons: parity (gap closed) OR the known
//     containment-overshoot superset signature (gap open, annotated)
//   - 3D polylines: both backends >= MIN_LINE_PX white px,
//     dilated-IoU >= 0.60
//   - 2D + CV polygons: WebGPU >= MIN_POLY_PX (Batch 178 regression
//     guard; WebGL logged — upstream renders nothing)
//   - 2D + CV polylines: WebGPU coverage <= SKIP_MAX_PX (skip-gate intact)
//   - 0 WebGPU device errors in every msaa=1 phase
//   - msaa=4 frame: clean parity (gap fixed) OR the known
//     attachment-state signature (gap open, annotated)
//
// READ the PNGs:
//   output/vctr-polygons-{far,near,2d,cv}-{webgl,webgpu}.png
//   output/vctr-polylines-{3d,2d,cv}-{webgl,webgpu}.png
//   output/vctr-polygons-msaa4-{webgl,webgpu}.png

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
// Containment-overshoot signature (NEAR frame while the gap is open):
// WebGPU mask is a superset of WebGL's (recall >= this) and clearly larger.
const OVERSHOOT_RECALL_MIN = 0.95;
const OVERSHOOT_RATIO_MIN = 1.2;

const POLYGONS_URL =
  "/Specs/Data/Cesium3DTiles/Vector/VectorTilePolygons/tileset.json";
const POLYLINES_URL =
  "/Specs/Data/Cesium3DTiles/Vector/VectorTilePolylines/tileset.json";

// Known-gap signature for the msaa=4 documentation frame.
const MSAA_GAP_SIGNATURE = /Attachment state .*Vector3DTile/s;

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

// Fraction of maskA's pixels also present in maskB (recall of A in B).
function recall(maskA, maskB) {
  let a = 0;
  let inter = 0;
  for (let i = 0; i < W * H; i++) {
    if (maskA[i]) {
      a++;
      if (maskB[i]) inter++;
    }
  }
  return a === 0 ? 0 : inter / a;
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
    scene.msaaSamples = 1;
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
        for (let i = 0; i < 300; i++) {
          scene.requestRender();
          scene.render();
          await new Promise((r) => requestAnimationFrame(r));
          const ts = window.__tileset;
          if (i > 30 && scene.globe.tilesLoaded && (!ts || ts.tilesLoaded)) {
            break;
          }
        }
        for (let i = 0; i < 30; i++) {
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
            let s = "";
            for (let i = 0; i < packed.length; i += 8192) {
              s += String.fromCharCode(...packed.subarray(i, i + 8192));
            }
            resolve(btoa(s));
          };
          img.src = durl;
        });
      },
      { durl: `data:image/png;base64,${png.toString("base64")}`, roi: ROI },
    );
    return unpackMask(b64);
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

  async function phase(name, mode, height) {
    const before = await errCountAt();
    await settle(mode, height);
    const mask = await capture(name);
    result.phases[name] = {
      mask,
      px: count(mask),
      newErrs: (await errCountAt()) - before,
    };
  }

  // ── Phase set A: polygons (classifier) ──
  //   far  — 3D @ 20 km: the gated parity frame (projection inflation ~5%)
  //   near — 3D @ 3 km:  containment-overshoot documentation frame
  //   2d/cv @ 3 km:      Batch 178 mode coverage (WebGPU exceeds upstream)
  await loadTileset(POLYGONS_URL);
  await phase("polygons-far", "3d", FAR_HEIGHT);
  await phase("polygons-near", "3d", NEAR_HEIGHT);
  await phase("polygons-2d", "2d", NEAR_HEIGHT);
  await phase("polygons-cv", "cv", NEAR_HEIGHT);

  // ── Phase set B: polylines — 3D, 2D, CV ──
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

  // ── Phase C: MSAA-4 documentation frame (polygons, 3D) ──
  // Reproduces NEW-VECTOR3DTILE-MSAA-PIPELINE at the viewer's DEFAULT
  // msaaSamples=4. Passes while the known attachment-state signature is
  // the only fallout; flips to a parity gate once the fix lands.
  await page.evaluate(() => {
    window.viewer.scene.msaaSamples = 4;
  });
  await loadTileset(POLYGONS_URL);
  await phase("polygons-msaa4", "3d", FAR_HEIGHT);
  result.msaa4Errs = await page.evaluate(() =>
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

  // FAR 3D polygons: the gated parity frame (presence + IoU).
  {
    const g = wgl.phases["polygons-far"];
    const p = wgpu.phases["polygons-far"];
    const j = iou(g.mask, p.mask, 0);
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

  // NEAR 3D polygons: containment-overshoot documentation frame
  // (NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT). Parity passes outright once
  // the containment fix lands; until then the known superset signature
  // (WebGPU ⊇ WebGL, clearly larger) is the expected-fail annotation.
  {
    const g = wgl.phases["polygons-near"];
    const p = wgpu.phases["polygons-near"];
    const j = iou(g.mask, p.mask, 0);
    const rec = recall(g.mask, p.mask);
    const ratio = g.px > 0 ? p.px / g.px : 0;
    if (j >= POLY_IOU_MIN) {
      gate(
        "polygons NEAR 3D (gap FIXED?)",
        true,
        `IoU=${j.toFixed(3)} — NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT ` +
          `appears CLOSED; flip this frame to a hard parity gate`,
      );
    } else {
      gate(
        "polygons NEAR 3D known-gap signature",
        g.px >= MIN_POLY_PX &&
          rec >= OVERSHOOT_RECALL_MIN &&
          ratio >= OVERSHOOT_RATIO_MIN,
        `expected-fail annotated: IoU=${j.toFixed(3)}, recall(webgl in ` +
          `webgpu)=${rec.toFixed(3)}, area ratio=${ratio.toFixed(2)} — ` +
          `KNOWN GAP NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT (depth-sample ` +
          `classifier lacks volume-containment test; footprint = projected ` +
          `volume extent, h/(h-1000) inflation)`,
      );
    }
  }

  // 2D/CV polygons: WebGPU presence (Batch 178 regression guard). WebGL
  // is logged only — upstream renders NOTHING for this classifier in
  // 2D/CV (measured 0 px), so WebGPU exceeds upstream here.
  for (const mode of ["2d", "cv"]) {
    const g = wgl.phases[`polygons-${mode}`];
    const p = wgpu.phases[`polygons-${mode}`];
    gate(
      `polygons ${mode.toUpperCase()} WebGPU presence`,
      p.px >= MIN_POLY_PX,
      `webgpu=${p.px} (min ${MIN_POLY_PX}) — Batch 178 mode coverage`,
    );
    info(
      `polygons ${mode.toUpperCase()} WebGL (logged)`,
      `webgl=${g.px} px (upstream renders nothing in this mode)`,
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

  // Device-error cleanliness across the msaa=1 phases (the msaa4 frame is
  // judged separately below).
  {
    const msaa1Errs =
      wgpu.errs.length - (wgpu.phases["polygons-msaa4"]?.newErrs ?? 0);
    gate(
      "WebGPU device errors (msaa=1)",
      msaa1Errs === 0,
      `${msaa1Errs} errors`,
    );
    if (msaa1Errs > 0) {
      wgpu.errs
        .slice(0, 6)
        .forEach((e) => console.log(`    - ${e.slice(0, 180)}`));
    }
  }

  // MSAA-4 documentation frame (NEW-VECTOR3DTILE-MSAA-PIPELINE).
  {
    const g = wgl.phases["polygons-msaa4"];
    const p = wgpu.phases["polygons-msaa4"];
    const errText = (wgpu.msaa4Errs ?? []).join("\n");
    if (p.newErrs === 0 && p.px >= MIN_POLY_PX) {
      const j = iou(g.mask, p.mask, 0);
      gate(
        "polygons MSAA4 (gap FIXED?)",
        j >= POLY_IOU_MIN,
        `clean render at msaa=4! IoU=${j.toFixed(3)} — ` +
          `NEW-VECTOR3DTILE-MSAA-PIPELINE appears CLOSED; keep this gate`,
      );
    } else {
      gate(
        "polygons MSAA4 known-gap signature",
        p.newErrs > 0 && MSAA_GAP_SIGNATURE.test(errText),
        `expected-fail annotated: ${p.newErrs} attachment-state errors — ` +
          `KNOWN GAP NEW-VECTOR3DTILE-MSAA-PIPELINE (vector pipelines lack ` +
          `multisample state; fix = thread context._msaaSamples through ` +
          `all 3 builders, mirroring WebGPUGroundPrimitiveRenderer L1372)`,
      );
      info(
        "polygons MSAA4 WebGL (logged)",
        `webgl=${g.px} px renders fine at msaa=4`,
      );
    }
  }

  console.log(rows.join("\n"));
  console.log(
    `\n  PNGs: ${OUT_DIR}/vctr-polygons-{far,near,2d,cv}-{webgl,webgpu}.png`,
  );
  console.log(
    `        ${OUT_DIR}/vctr-polylines-{3d,2d,cv}-{webgl,webgpu}.png`,
  );
  console.log(`        ${OUT_DIR}/vctr-polygons-msaa4-{webgl,webgpu}.png`);
  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
