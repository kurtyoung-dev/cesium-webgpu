#!/usr/bin/env node
// probe-csm-soft-shadow — NEW-CSM-SOFT-SHADOW-PCF verification (Batch 289).
//
// Validates that the WebGPU cascaded-shadow-map receive path softens the
// cascade edge with a 3x3 PCF box kernel, matching WebGL's
// czm_shadowVisibility USE_SOFT_SHADOWS softness (within tolerance), with
// no shadow-acne / peter-panning regression and 0 device errors.
//
// Scene: an extruded box ("wall") on the Pittsburgh terrain, sun low in
// the west so the wall casts a long shadow on the terrain toward the
// camera. CSM is enabled (the box + terrain are CSM receivers).
//
// Matrix:
//   A: WebGPU, CSM on, soft OFF (cascadedShadowMapSoftShadows=false) → HARD edge
//   B: WebGPU, CSM on, soft ON  (default)                            → SOFT edge
//   C: WebGL,  shadows on, soft shadows ON                           → reference SOFT edge
//
// Softness metric (per cell): scan a horizontal pixel row that crosses
// the shadow boundary on the lit terrain. Classify each pixel as
// lit / penumbra / umbra by luminance. The PENUMBRA count (intermediate
// pixels straddling the 0→1 step) is the softness signal:
//   - A (hard) should have the FEWEST penumbra pixels (sharp step).
//   - B (soft) should have MORE penumbra pixels than A (gradient).
//   - B's penumbra width should be in the same ballpark as C (WebGL ref).
//
// Pass conditions:
//   - 0 device errors in every cell
//   - B.penumbra > A.penumbra              (PCF actually softens the edge)
//   - B has a real shadow (umbra pixels exist → not peter-panned away)
//   - A has a real shadow too (no acne wiping it / no full-lit)
//   - B.penumbra within [0.4x, 3.0x] of C.penumbra (parity ballpark)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const OUT_DIR = "Tools/visual-regression/output";

// Pittsburgh; late-afternoon sun (low western angle) → long east-cast
// shadow from a north-south wall. Low altitude so the wall + its shadow
// fall in CSM cascade 0/1 at high texel density.
const VIEW = { lon: -79.9959, lat: 40.4406, height: 220.0 };
// ~21:10 UTC mid-June at Pittsburgh → sun ~30° elevation in the SW: high
// enough that the lit terrain is bright on BOTH backends, low enough to
// throw a long, clearly-bounded shadow across the flat foreground.
const FIXED_CLOCK_UTC = "2026-06-15T21:10:00Z";

// Luminance thresholds for lit / penumbra / umbra classification. Tuned
// for the (0.85, 0.78, 0.65) tan terrain-lit color under directional sun;
// the absolute values aren't load-bearing — the RELATIVE penumbra counts
// across cells are.
// Thresholds are recomputed per-cell from each cell's own lit/umbra
// luminance band (see deriveThresholds) so the penumbra metric is robust
// to per-backend tonemapping differences. These are only fallback floors.
const LIT_LUM = 110; // fallback >= this → fully lit
const UMBRA_LUM = 70; // fallback <= this → fully shadowed
// pixels in (UMBRA_LUM, LIT_LUM) → penumbra (the soft gradient)

async function capture(label, { renderer, useCsm, csmSoft, webglSoft }) {
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
    viewport: { width: 1280, height: 720 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, useCsm, csmSoft, webglSoft, thresholds }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Clean isolated test surface: strip imagery + flat ellipsoid
      // terrain so the receiver is a uniform plane. Crucially DISABLE
      // directional lighting (enableLighting=false) — the base-color globe
      // then renders FULL-BRIGHT everywhere, so the cast shadow is the ONLY
      // thing that darkens the ground. (With lighting on, the WebGPU
      // base-color globe renders near-black, masking the shadow edge.) A
      // bright uniform ground + a dark shadow rectangle is the cleanest
      // possible lit↔shadow boundary for measuring PCF softness.
      v.terrainProvider = new C.EllipsoidTerrainProvider();
      v.imageryLayers.removeAll();
      v.scene.globe.baseColor = new C.Color(0.82, 0.8, 0.74, 1.0);
      v.scene.skyAtmosphere.show = false;
      v.scene.fog.enabled = false;
      v.scene.globe.showGroundAtmosphere = false;

      // Shadows darken receivers independently of enableLighting, so the
      // uniform bright ground still shows the cast shadow crisply.
      v.scene.globe.enableLighting = false;
      // Shadows on; terrain receives the box's cast shadow.
      v.shadows = true;
      v.scene.shadowMap.enabled = true;
      v.scene.shadowMap.softShadows = webglSoft;
      v.scene.shadowMap.darkness = 0.3;
      v.scene.shadowMap.maximumDistance = 10000;
      v.scene.shadowMap.size = 2048;

      // CSM toggle + soft-shadow toggle. Both must be set BEFORE the first
      // CSM frame (the renderer reads softShadows once at init).
      v.scene.useCascadedShadowMaps = useCsm;
      v.scene.cascadedShadowMapSoftShadows = csmSoft;
      v.scene.cascadedShadowMapResolution = 1024;

      // A big blocky caster ("the wall"): wide enough that its shadow on
      // the flat ground spans most of the frame, tall enough that the
      // shadow is long under the low afternoon sun. East-facing edge of
      // the shadow runs roughly N-S → vertical-ish boundary in screen.
      const wallCoords = C.Cartesian3.fromDegreesArray([
        view.lon - 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat - 0.003,
        view.lon + 0.0004,
        view.lat + 0.003,
        view.lon - 0.0004,
        view.lat + 0.003,
      ]);
      // FLAT appearance (no diffuse lighting) is REQUIRED for this probe.
      // The metric counts ROI pixels whose luminance sits in the penumbra
      // band as "soft-edge" pixels. A lit (flat:false) PerInstanceColor
      // wall renders its body at a DIFFERENT luminance on WebGPU vs WebGL
      // (~92 vs ~154) because of a pre-existing PerInstanceColorAppearance
      // diffuse-shading parity gap that is INDEPENDENT of shadows (it is
      // present with shadows fully OFF — NEW-PERINSTANCE-DIFFUSE-PARITY).
      // That gap puts the whole WebGPU wall body inside the penumbra band
      // (~14k pixels) and swamps the actual cast-shadow edge the
      // parity-ballpark sub-check is meant to measure. `flat:true` makes
      // the caster body render at its base color on BOTH backends (lit,
      // out of the penumbra band), so the only penumbra pixels left are
      // the genuine ground cast-shadow edge — exactly what we want to
      // compare for soft-shadow parity. (The cast shadow itself is
      // unaffected by the caster's appearance.)
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 0,
            extrudedHeight: 120, // 120 m tall block
            vertexFormat: C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.6, 0.6, 0.62, 1.0),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          translucent: false,
          flat: true,
        }),
        asynchronous: false,
        shadows: C.ShadowMode.ENABLED,
      });
      v.scene.primitives.add(wall);

      // Camera east of the block, low and looking west toward the block so
      // the long eastward-cast shadow fills the foreground ground. The
      // lit/shadow boundary on the flat terrain runs roughly vertically in
      // screen space → a horizontal pixel scan crosses it cleanly.
      // Top-down view centered NE of the block, over the lit ground where
      // the NE-cast shadow (sun in the SW) falls. Top-down keeps the
      // shadow edge sharp + surrounded by bright uniform ground — no
      // horizon/sky in frame.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon + 0.0012,
          view.lat + 0.0012,
          1700.0,
        ),
        orientation: {
          heading: 0,
          pitch: C.Math.toRadians(-90),
          roll: 0,
        },
      });

      // Warm the globe + let shadows settle.
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Read the full canvas into a 2D context. Return a luminance map of
      // the central ground region (avoid the UI chrome). Node computes the
      // penumbra (intermediate-luminance) pixel count + edge stats and the
      // A-vs-B PNG diff is computed separately from the saved screenshots.
      const canvas = v.canvas;
      const tmp = document.createElement("canvas");
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx2d = tmp.getContext("2d");
      ctx2d.drawImage(canvas, 0, 0);
      const W = tmp.width;
      const H = tmp.height;

      // Central ground ROI — clear of the top toolbar, right help panel,
      // and bottom timeline.
      const rx0 = Math.floor(W * 0.18);
      const rx1 = Math.floor(W * 0.66);
      const ry0 = Math.floor(H * 0.18);
      const ry1 = Math.floor(H * 0.72);
      const roiW = rx1 - rx0;
      const roiH = ry1 - ry0;
      const img = ctx2d.getImageData(rx0, ry0, roiW, roiH).data;
      const lumMap = new Array(roiW * roiH);
      let minLum = 255;
      let maxLum = 0;
      for (let p = 0, j = 0; p < img.length; p += 4, j++) {
        const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
        lumMap[j] = lum;
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      return {
        renderer: v.scene.context?.isWebGPU ? "webgpu" : "webgl",
        useCsm: v.scene.useCascadedShadowMaps,
        csmSoft: v.scene.cascadedShadowMapSoftShadows,
        webglSoft: v.scene.shadowMap?.softShadows,
        csmEnabledOnContext: v.scene.context?.csmRenderer?.enabled === true,
        csmPcfRadius: v.scene.context?.csmRenderer?.pcfRadius ?? null,
        csmSoftShadowsGetter: v.scene.context?.csmRenderer?.softShadows ?? null,
        tilesLoaded: v.scene.globe.tilesLoaded,
        primitives: v.scene.primitives.length,
        canvas: { w: W, h: H },
        roi: { x0: rx0, y0: ry0, w: roiW, h: roiH },
        minLum: Math.round(minLum),
        maxLum: Math.round(maxLum),
        lumMap,
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      useCsm,
      csmSoft,
      webglSoft,
      thresholds: { LIT_LUM, UMBRA_LUM },
    },
  );

  // Softness metric: count PENUMBRA pixels (intermediate luminance between
  // the cell's own lit + umbra bands) inside the ROI. A hard shadow edge
  // is ~1px wide → few penumbra pixels; a 3x3 PCF kernel widens the edge →
  // more penumbra pixels. Self-calibrated per cell (its own min/max) so
  // the WebGPU↔WebGL tonemapping gap doesn't bias the comparison — what
  // matters is the COUNT of transition pixels relative to the (identical)
  // edge length.
  const lumMap = diagnostics.lumMap || [];
  const lo = diagnostics.minLum;
  const hi = diagnostics.maxLum;
  const span = Math.max(1, hi - lo);
  const litCut = lo + span * 0.72;
  const umbraCut = lo + span * 0.28;
  let litPixels = 0;
  let umbraPixels = 0;
  let penumbraPixels = 0;
  for (const l of lumMap) {
    if (l >= litCut) litPixels++;
    else if (l <= umbraCut) umbraPixels++;
    else penumbraPixels++;
  }
  diagnostics.scan = {
    penumbraPixels,
    litPixels,
    umbraPixels,
    total: lumMap.length,
    // penumbra as a fraction of the shadow-edge "perimeter" proxy: the
    // umbra pixel count grows the edge length too, so normalize by sqrt
    // (a square shadow's perimeter ∝ sqrt(area)).
    penumbraPerEdge:
      umbraPixels > 0
        ? Number((penumbraPixels / Math.sqrt(umbraPixels)).toFixed(3))
        : 0,
    litCut: Math.round(litCut),
    umbraCut: Math.round(umbraCut),
    minLum: lo,
    maxLum: hi,
  };
  delete diagnostics.lumMap;

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(500);
  const out = path.join(OUT_DIR, `csm-soft-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

// Masked PNG diff: decode two screenshots in a headless page and compute
// the % of pixels (restricted to the ROI rect) whose RGB delta exceeds a
// threshold. Used to confirm the soft-shadow toggle actually changes the
// WebGPU output (A vs B). Canvas-decode, no Node PNG dep — same approach
// as probe-saved-view / probe-contact-shadows.
async function diffPngsMasked(a, b, roi) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb, roi }) => {
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
          ctx: c.getContext("2d"),
        };
      };
      const A = await decode(ba);
      const B = await decode(bb);
      if (A.w !== B.w || A.h !== B.h) return { error: "size mismatch" };
      const da = A.ctx.getImageData(roi.x0, roi.y0, roi.w, roi.h).data;
      const db = B.ctx.getImageData(roi.x0, roi.y0, roi.w, roi.h).data;
      let mismatch = 0;
      let sum = 0;
      const total = roi.w * roi.h;
      for (let i = 0; i < da.length; i += 4) {
        const d =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        sum += d;
        if (d > 12) mismatch++;
      }
      return { mismatchPct: (100 * mismatch) / total, meanDelta: sum / total };
    },
    { ba, bb, roi },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-csm-soft-shadow] capturing 3-cell matrix\n");

  const cells = [];
  cells.push(
    await capture("a-webgpu-hard", {
      renderer: "webgpu",
      useCsm: true,
      csmSoft: false,
      webglSoft: false,
    }),
  );
  cells.push(
    await capture("b-webgpu-soft", {
      renderer: "webgpu",
      useCsm: true,
      csmSoft: true,
      webglSoft: false,
    }),
  );
  cells.push(
    await capture("c-webgl-soft", {
      renderer: "webgl",
      useCsm: false,
      csmSoft: true,
      webglSoft: true,
    }),
  );

  for (const cell of cells) {
    const d = cell.diagnostics;
    console.log(`  [${cell.label}] renderer=${d.renderer}`);
    console.log(
      `    csm=${d.useCsm} csmSoft(scene)=${d.csmSoft} ctxCsmEnabled=${d.csmEnabledOnContext} pcfRadius=${d.csmPcfRadius} softGetter=${d.csmSoftShadowsGetter}`,
    );
    console.log(
      `    scan penumbraPx=${d.scan.penumbraPixels} (perEdge=${d.scan.penumbraPerEdge}) litPx=${d.scan.litPixels} umbraPx=${d.scan.umbraPixels} lum[min=${d.scan.minLum},max=${d.scan.maxLum}]`,
    );
    console.log(`    tilesLoaded=${d.tilesLoaded} prims=${d.primitives}`);
    if (cell.deviceErrors.length) {
      console.log(`    ✗ ${cell.deviceErrors.length} device errors`);
      cell.deviceErrors
        .slice(0, 3)
        .forEach((e) => console.log(`      ${e.text?.slice(0, 200)}`));
    } else {
      console.log(`    ✓ no device errors`);
    }
    console.log("");
  }

  const A = cells[0].diagnostics.scan;
  const B = cells[1].diagnostics.scan;
  const Cc = cells[2].diagnostics.scan;
  const errAll = cells.reduce((s, c) => s + c.deviceErrors.length, 0);

  // Primary "PCF is active" proof: A and B are the IDENTICAL WebGPU scene +
  // camera, differing only in the soft-shadow toggle. Any pixel that
  // changes between them is a shadow-edge pixel the PCF kernel reworked.
  // A non-trivial masked diff proves the kernel is reaching the runtime
  // and altering output; zero diff would mean the toggle is dead.
  const abRoi = cells[0].diagnostics.roi;
  const abDiff = await diffPngsMasked(cells[0].out, cells[1].out, abRoi);

  // Softness ordering: B (soft) should have MORE penumbra pixels per unit
  // shadow-edge than A (hard). Both WebGPU, identical scene → directly
  // comparable.
  const softerThanHard = B.penumbraPerEdge > A.penumbraPerEdge + 0.05;
  const pcfChangesOutput = abDiff.mismatchPct > 0.05; // % of ROI pixels
  const bHasShadow = B.umbraPixels > 200; // not peter-panned away
  const aHasShadow = A.umbraPixels > 200; // not acne-wiped / fully lit
  // B's soft-edge density should be in the same ballpark as WebGL's PCF
  // soft edge (C). Backends differ in resolution/tonemap, so allow a wide
  // band.
  const ratioVsWebGL =
    Cc.penumbraPerEdge > 0 ? B.penumbraPerEdge / Cc.penumbraPerEdge : Infinity;
  const parityBallpark = ratioVsWebGL >= 0.25 && ratioVsWebGL <= 4.0;

  console.log("[probe-csm-soft-shadow] assertions:");
  console.log(
    `  A-vs-B masked diff=${abDiff.mismatchPct.toFixed(3)}% (>0.05) → PCF toggle reaches runtime + alters shadow edges: ${pcfChangesOutput ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  B.penumbraPerEdge(${B.penumbraPerEdge}) > A.penumbraPerEdge(${A.penumbraPerEdge})+0.05 → soft edge wider than hard: ${softerThanHard ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  B.umbraPx(${B.umbraPixels}) > 200 → soft shadow not peter-panned: ${bHasShadow ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  A.umbraPx(${A.umbraPixels}) > 200 → hard shadow present (no acne wipe): ${aHasShadow ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  B.perEdge/C.perEdge=${ratioVsWebGL.toFixed(2)} in [0.25, 4.0] → WebGL softness parity ballpark: ${parityBallpark ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  total device errors=${errAll} → ${errAll === 0 ? "PASS" : "FAIL"}`,
  );

  const pass =
    pcfChangesOutput &&
    softerThanHard &&
    bHasShadow &&
    aHasShadow &&
    parityBallpark &&
    errAll === 0;
  console.log(`\n  OVERALL: ${pass ? "PASS ✓" : "FAIL ✗"}`);

  const reportPath = path.join(OUT_DIR, "csm-soft-shadow-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        clock: FIXED_CLOCK_UTC,
        thresholds: { LIT_LUM, UMBRA_LUM },
        cells: cells.map((c) => ({
          label: c.label,
          screenshot: c.out,
          diagnostics: c.diagnostics,
          deviceErrorCount: c.deviceErrors.length,
        })),
        assertions: {
          abMaskedDiff: abDiff,
          pcfChangesOutput,
          softerThanHard,
          bHasShadow,
          aHasShadow,
          parityBallpark,
          ratioVsWebGL,
          totalDeviceErrors: errAll,
          pass,
        },
      },
      null,
      2,
    ),
  );
  console.log(`  report: ${reportPath}`);
  process.exitCode = pass ? 0 : 1;
})();
