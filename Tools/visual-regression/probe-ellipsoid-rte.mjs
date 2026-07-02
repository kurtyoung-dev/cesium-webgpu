#!/usr/bin/env node
// probe-ellipsoid-rte — PARITY-RTE-ELLIPSOID-AWARE (FEAT-3DT2-03) verification.
//
// The WebGPU CSM cascade ground-clamp (NEW-CSM-CASCADE-GROUND-FIT) used
// hardcoded WGS84 radii, so on a non-Earth globe (Mars/Moon/scaled) the
// ray/ellipsoid solve intersected the WRONG surface: cascade splits spread
// to maxShadowDistance and frustum corners never clamped to the visible
// ground. The fix threads `scene.ellipsoid.radii` into WebGPUCSMRenderer
// (default WGS84 → byte-identical for Earth).
//
// No Mars/Moon asset exists, so per the ISSUES_AND_FIXED_BUGS FEAT-3DT2-03
// probe note this SYNTHESIZES a scaled-ellipsoid globe (0.5x WGS84) and
// checks CSM ground positions against the CPU reference math WebGL uses
// (IntersectionTests.rayEllipsoid on the ACTUAL scene ellipsoid).
//
// Cells (all UI-less custom viewers, flat base-color globe + extruded wall
// caster + fixed clock, top-down camera over the cast shadow):
//   1. wgs84-webgpu   — default WGS84 globe, CSM on   (off-gate reference)
//   2. scaled-webgpu  — 0.5x-scaled ellipsoid, CSM on (the fix target)
//   3. scaled-webgl   — 0.5x-scaled ellipsoid, WebGL shadows (pixel reference)
//
// Numeric assertion ("positions agree"): for each WebGPU cell,
//   csm.computeVisibleGroundFar(camera)  ==  max over the 4 frustum-edge
//   rays of IntersectionTests.rayEllipsoid(ray, scene.ellipsoid) entry
//   distance (converted to along-view depth). Pre-fix the scaled cell
//   diverges by ~4 orders of magnitude (Earth-radius solve on a half-size
//   globe); post-fix both cells agree to FP tolerance. The last cascade
//   splitFar must also be tightened to ~groundTruth*1.1 (not 100 km).
//
// Pixel assertion: umbra-mask IoU between scaled-webgpu and scaled-webgl
// (self-calibrated luminance classification inside the ground ROI) —
// the cast shadow lands in the SAME place on both backends.
//
// Off-gate (default WGS84 byte-identical):
//   --save-baseline  writes ellipsoid-rte-wgs84-baseline.png + baseline JSON
//                    (run this on the PRE-change build).
//   default run      diffs the fresh wgs84 capture against the baseline
//                    (must be ~0) and compares groundFar FP-exactly.
//
// Usage:
//   node Tools/visual-regression/probe-ellipsoid-rte.mjs --save-baseline
//   node Tools/visual-regression/probe-ellipsoid-rte.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const SAVE_BASELINE = process.argv.includes("--save-baseline");

const VIEW = { lon: -79.9959, lat: 40.4406 };
const FIXED_CLOCK_UTC = "2026-06-15T21:10:00Z";
// 0.5x WGS84 — big enough that the Earth-radius solve is wildly wrong
// (camera sits INSIDE the assumed WGS84 ellipsoid → through-Earth exit
// distance ~9600 km vs the true ~1 km ground distance), small enough
// that the rest of the globe pipeline stays in familiar numeric range.
const SCALE = 0.5;
// Ground ROI for luminance masks — central region, no viewer UI (the
// custom viewers are chrome-less but keep margins clear of the horizon).
const ROI = { x0: 230, y0: 130, w: 615, h: 390 };

async function runCell(label, { renderer, scale }) {
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

  // Load the CesiumViewer page only as a same-origin module host; the
  // auto-created viewer is destroyed and replaced by a chrome-less custom
  // viewer so the scaled ellipsoid can be injected at construction time.
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgl`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, renderer, scale }) => {
      const C = await import("/Build/CesiumUnminified/index.js");

      // Replace the app's auto viewer with a chrome-less one.
      try {
        window.viewer.destroy();
      } catch (e) {
        /* the app viewer may still be mid-load; container reset below */
      }
      const container = document.getElementById("cesiumContainer");
      container.innerHTML = "";

      const isScaled = scale !== 1;
      const ellipsoid = isScaled
        ? new C.Ellipsoid(
            C.Ellipsoid.WGS84.radii.x * scale,
            C.Ellipsoid.WGS84.radii.y * scale,
            C.Ellipsoid.WGS84.radii.z * scale,
          )
        : undefined;
      if (isScaled) {
        // Many subsystems key camera limits / defaults off Ellipsoid.default;
        // upstream's documented non-Earth recipe is to set it pre-construction.
        C.Ellipsoid.default = ellipsoid;
      }

      const commonOptions = {
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        selectionIndicator: false,
        infoBox: false,
        skyBox: false,
        skyAtmosphere: false,
        creditContainer: document.createElement("div"),
        requestRenderMode: false,
        terrainProvider: new C.EllipsoidTerrainProvider(
          isScaled ? { ellipsoid } : {},
        ),
      };
      if (isScaled) {
        commonOptions.ellipsoid = ellipsoid;
      }

      const v =
        renderer === "webgpu"
          ? await C.Viewer.createAsync(container, {
              ...commonOptions,
              contextOptions: { renderer: "webgpu" },
            })
          : new C.Viewer(container, commonOptions);
      window.viewer = v;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Uniform bright ground, no lighting/atmosphere — the cast shadow is
      // the only thing that darkens the globe (same recipe as
      // probe-csm-soft-shadow).
      v.scene.globe.baseColor = new C.Color(0.82, 0.8, 0.74, 1.0);
      v.scene.fog.enabled = false;
      v.scene.globe.showGroundAtmosphere = false;
      v.scene.globe.enableLighting = false;

      v.shadows = true;
      v.scene.shadowMap.enabled = true;
      v.scene.shadowMap.softShadows = true;
      v.scene.shadowMap.darkness = 0.3;
      v.scene.shadowMap.maximumDistance = 10000;
      v.scene.shadowMap.size = 2048;
      if (renderer === "webgpu") {
        v.scene.useCascadedShadowMaps = true;
        v.scene.cascadedShadowMapSoftShadows = true;
        v.scene.cascadedShadowMapResolution = 1024;
      }

      // Device-error capture (WebGPU only).
      window.__probeErrors = [];
      const dev = v.scene.context?._device;
      if (dev) {
        dev.onuncapturederror = (ev) => {
          window.__probeErrors.push({ text: ev?.error?.message ?? "" });
        };
      }

      // Wall caster — same angular footprint as probe-csm-soft-shadow so
      // the METERS scale tracks the globe scale (0.5x globe → 0.5x wall).
      const sceneEllipsoid = v.scene.ellipsoid;
      const wallCoords = C.Cartesian3.fromDegreesArray(
        [
          view.lon - 0.0004, view.lat - 0.0030,
          view.lon + 0.0004, view.lat - 0.0030,
          view.lon + 0.0004, view.lat + 0.0030,
          view.lon - 0.0004, view.lat + 0.0030,
        ],
        sceneEllipsoid,
      );
      const wall = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(wallCoords),
            height: 0,
            extrudedHeight: 120 * scale,
            ellipsoid: sceneEllipsoid,
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

      // Top-down over the lit ground NE of the wall (sun in the SW).
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          view.lon + 0.0012,
          view.lat + 0.0012,
          1700.0 * scale,
          sceneEllipsoid,
        ),
        orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      });

      // Warm up: tiles + shadow settle.
      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 200) break;
      }
      for (let i = 0; i < 90; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // ── Numeric "positions agree" check (WebGPU cells) ────────────────
      // Reference: the same 4 frustum-edge rays the CSM ground-clamp
      // shoots, solved with IntersectionTests.rayEllipsoid against the
      // ACTUAL scene ellipsoid — the canonical CPU/WebGL-side math.
      const cam = v.scene.camera;
      const fovy = cam.frustum.fovy ?? Math.PI / 3;
      const aspect = cam.frustum.aspectRatio ?? 1;
      const tanH = Math.tan(fovy * 0.5);
      const tanW = tanH * aspect;
      const pos = cam.positionWC;
      const fwd = cam.directionWC;
      const up = cam.upWC;
      const rt = cam.rightWC;
      let truthGroundFar = 0;
      let truthAnyHit = false;
      for (const [sW, sH] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        const dir = new C.Cartesian3(
          fwd.x + sW * tanW * rt.x + sH * tanH * up.x,
          fwd.y + sW * tanW * rt.y + sH * tanH * up.y,
          fwd.z + sW * tanW * rt.z + sH * tanH * up.z,
        );
        const len = C.Cartesian3.magnitude(dir);
        const ray = new C.Ray(
          pos,
          C.Cartesian3.normalize(dir, new C.Cartesian3()),
        );
        const hit = C.IntersectionTests.rayEllipsoid(ray, sceneEllipsoid);
        if (hit) {
          const s = hit.start > 0 ? hit.start : hit.stop;
          if (s > 0) {
            truthAnyHit = true;
            const t = s / len; // meters → along-view depth (unit fwd comp)
            if (t > truthGroundFar) truthGroundFar = t;
          }
        }
      }

      const csm = v.scene.context?.csmRenderer ?? null;
      const csmGroundFar = csm ? csm.computeVisibleGroundFar(cam) : null;
      const csmStats = csm ? csm.getStatistics() : null;

      // Umbra/lit luminance data for the pixel checks is derived Node-side
      // from the saved PNGs (single decode path for both cells).
      return {
        renderer: v.scene.context?.isWebGPU ? "webgpu" : "webgl",
        scaled: isScaled,
        ellipsoidRadii: {
          x: sceneEllipsoid.radii.x,
          y: sceneEllipsoid.radii.y,
          z: sceneEllipsoid.radii.z,
        },
        cameraHeightAboveEllipsoid:
          sceneEllipsoid.cartesianToCartographic(pos)?.height ?? null,
        truthGroundFar: truthAnyHit ? truthGroundFar : null,
        csmGroundFar,
        csmEnabled: csm?.enabled ?? null,
        csmCastDispatches: csm?._castDispatches ?? null,
        cascadeSplitFars:
          csmStats?.cascades?.map((c) => c.splitFar) ?? null,
        tilesLoaded: v.scene.globe.tilesLoaded,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, renderer, scale },
  );

  const deviceErrors = await page.evaluate(() => window.__probeErrors ?? []);
  await page.waitForTimeout(400);
  const out = path.join(OUT_DIR, `ellipsoid-rte-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  return { label, out, diagnostics, deviceErrors, messages };
}

// Decode two PNGs in a headless page; inside the ROI compute (a) the raw
// masked mismatch %, and (b) umbra-mask IoU with self-calibrated per-image
// luminance cuts (robust to WebGL↔WebGPU tonemapping differences).
async function analyzePair(a, b, roi) {
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
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(roi.x0, roi.y0, roi.w, roi.h).data;
      };
      const da = await decode(ba);
      const db = await decode(bb);
      const total = roi.w * roi.h;
      let mismatch = 0;
      let sum = 0;
      const lum = (d, i) =>
        0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const la = new Float32Array(total);
      const lb = new Float32Array(total);
      let aMin = 255, aMax = 0, bMin = 255, bMax = 0;
      for (let i = 0, j = 0; i < da.length; i += 4, j++) {
        const d =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        sum += d;
        if (d > 12) mismatch++;
        la[j] = lum(da, i);
        lb[j] = lum(db, i);
        if (la[j] < aMin) aMin = la[j];
        if (la[j] > aMax) aMax = la[j];
        if (lb[j] < bMin) bMin = lb[j];
        if (lb[j] > bMax) bMax = lb[j];
      }
      // Umbra = below 40% of each image's own lum span (shadow pixels).
      const aCut = aMin + (aMax - aMin) * 0.4;
      const bCut = bMin + (bMax - bMin) * 0.4;
      let inter = 0, union = 0, aUmbra = 0, bUmbra = 0;
      for (let j = 0; j < total; j++) {
        const ua = la[j] <= aCut;
        const ub = lb[j] <= bCut;
        if (ua) aUmbra++;
        if (ub) bUmbra++;
        if (ua && ub) inter++;
        if (ua || ub) union++;
      }
      return {
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
        umbraA: aUmbra,
        umbraB: bUmbra,
        umbraIoU: union > 0 ? inter / union : null,
      };
    },
    { ba, bb, roi },
  );
  await browser.close();
  return result;
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const mode = SAVE_BASELINE ? "SAVE-BASELINE (pre-change)" : "verify";
  console.log(`[probe-ellipsoid-rte] mode=${mode}\n`);

  const cells = {};
  cells.wgs84 = await runCell("wgs84-webgpu", {
    renderer: "webgpu",
    scale: 1,
  });
  cells.scaledGpu = await runCell("scaled-webgpu", {
    renderer: "webgpu",
    scale: SCALE,
  });
  cells.scaledGl = await runCell("scaled-webgl", {
    renderer: "webgl",
    scale: SCALE,
  });

  for (const cell of Object.values(cells)) {
    const d = cell.diagnostics;
    console.log(`  [${cell.label}] renderer=${d.renderer} scaled=${d.scaled}`);
    console.log(
      `    ellipsoid radii=(${d.ellipsoidRadii.x.toFixed(0)}, ${d.ellipsoidRadii.y.toFixed(0)}, ${d.ellipsoidRadii.z.toFixed(0)}) camHeight=${d.cameraHeightAboveEllipsoid?.toFixed(1)}`,
    );
    if (d.csmGroundFar !== null) {
      const rel =
        d.truthGroundFar > 0
          ? Math.abs(d.csmGroundFar - d.truthGroundFar) / d.truthGroundFar
          : null;
      console.log(
        `    groundFar csm=${d.csmGroundFar?.toFixed(2)} truth=${d.truthGroundFar?.toFixed(2)} relErr=${rel === null ? "n/a" : (rel * 100).toFixed(3) + "%"}`,
      );
      console.log(
        `    cascadeSplitFars=[${d.cascadeSplitFars?.map((s) => s.toFixed(1)).join(", ")}] castDispatches=${d.csmCastDispatches}`,
      );
    }
    console.log(
      `    tilesLoaded=${d.tilesLoaded} deviceErrors=${cell.deviceErrors.length}`,
    );
    console.log("");
  }

  const results = {};
  const dw = cells.wgs84.diagnostics;
  const ds = cells.scaledGpu.diagnostics;

  // 1. Numeric parity — WGS84 cell (sanity; holds pre- and post-fix).
  results.wgs84GroundFarAgrees =
    dw.truthGroundFar > 0 &&
    dw.csmGroundFar !== null &&
    Math.abs(dw.csmGroundFar - dw.truthGroundFar) / dw.truthGroundFar < 0.01;

  // 2. Numeric parity — SCALED cell (THE fix): CSM's ground positions must
  //    match the actual-ellipsoid reference solve.
  results.scaledGroundFarAgrees =
    ds.truthGroundFar > 0 &&
    ds.csmGroundFar !== null &&
    Number.isFinite(ds.csmGroundFar) &&
    Math.abs(ds.csmGroundFar - ds.truthGroundFar) / ds.truthGroundFar < 0.01;

  // 3. Splits tightened to the visible ground (not maxShadowDistance).
  const lastSplit = ds.cascadeSplitFars?.[ds.cascadeSplitFars.length - 1];
  results.scaledSplitsTight =
    typeof lastSplit === "number" &&
    ds.truthGroundFar > 0 &&
    lastSplit <= ds.truthGroundFar * 1.1 * 1.05 + 1;

  // 4. CSM actually ran (cast pass dispatched) in both WebGPU cells.
  results.csmActive =
    (dw.csmCastDispatches ?? 0) > 0 && (ds.csmCastDispatches ?? 0) > 0;

  // 5. Pixel — scaled scene: WebGPU shadow lands where WebGL's does.
  const scaledPair = await analyzePair(
    cells.scaledGpu.out,
    cells.scaledGl.out,
    ROI,
  );
  results.scaledPixel = scaledPair;
  results.scaledShadowPresent = scaledPair.umbraA > 200;
  results.scaledShadowAgrees =
    scaledPair.umbraIoU !== null && scaledPair.umbraIoU > 0.5;

  // 6. Device errors.
  const errAll = Object.values(cells).reduce(
    (s, c) => s + c.deviceErrors.length,
    0,
  );
  results.noDeviceErrors = errAll === 0;

  // 7. Off-gate — default WGS84 must be byte-identical to the baseline.
  const baselinePng = path.join(OUT_DIR, "ellipsoid-rte-wgs84-baseline.png");
  const baselineJson = path.join(
    OUT_DIR,
    "ellipsoid-rte-wgs84-baseline.json",
  );
  if (SAVE_BASELINE) {
    fs.copyFileSync(cells.wgs84.out, baselinePng);
    fs.writeFileSync(
      baselineJson,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          csmGroundFar: dw.csmGroundFar,
          cascadeSplitFars: dw.cascadeSplitFars,
        },
        null,
        2,
      ),
    );
    console.log(`  baseline saved: ${baselinePng}`);
  } else if (fs.existsSync(baselinePng)) {
    const gate = await analyzePair(cells.wgs84.out, baselinePng, ROI);
    results.offGatePixel = gate;
    results.offGatePixelIdentical = gate.mismatchPct < 0.1;
    if (fs.existsSync(baselineJson)) {
      const bl = JSON.parse(fs.readFileSync(baselineJson, "utf8"));
      results.offGateGroundFarExact = bl.csmGroundFar === dw.csmGroundFar;
      results.offGateSplitsExact =
        JSON.stringify(bl.cascadeSplitFars) ===
        JSON.stringify(dw.cascadeSplitFars);
    }
  } else {
    console.log(
      "  (no WGS84 baseline found — run with --save-baseline on the pre-change build for the off-gate)",
    );
  }

  console.log("[probe-ellipsoid-rte] assertions:");
  const line = (name, ok, detail) =>
    console.log(`  ${name}: ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
  line(
    "wgs84 groundFar agrees with IntersectionTests reference",
    results.wgs84GroundFarAgrees,
    `csm=${dw.csmGroundFar?.toFixed(2)} truth=${dw.truthGroundFar?.toFixed(2)}`,
  );
  line(
    "SCALED groundFar agrees with IntersectionTests reference",
    results.scaledGroundFarAgrees,
    `csm=${ds.csmGroundFar?.toFixed(2)} truth=${ds.truthGroundFar?.toFixed(2)}`,
  );
  line(
    "SCALED cascade splits tightened to visible ground",
    results.scaledSplitsTight,
    `lastSplit=${lastSplit?.toFixed(1)} vs bound=${(ds.truthGroundFar * 1.1 * 1.05).toFixed(1)}`,
  );
  line("CSM cast pass dispatched in both WebGPU cells", results.csmActive);
  line(
    "SCALED WebGPU shadow present",
    results.scaledShadowPresent,
    `umbraPx=${scaledPair.umbraA}`,
  );
  line(
    "SCALED WebGPU shadow position matches WebGL (umbra IoU > 0.5)",
    results.scaledShadowAgrees,
    `IoU=${scaledPair.umbraIoU?.toFixed(3)} umbraGL=${scaledPair.umbraB}`,
  );
  line("no device errors", results.noDeviceErrors, `count=${errAll}`);
  if (results.offGatePixel) {
    line(
      "OFF-GATE wgs84 pixel-identical to baseline",
      results.offGatePixelIdentical,
      `mismatch=${results.offGatePixel.mismatchPct.toFixed(4)}% meanDelta=${results.offGatePixel.meanDelta.toFixed(3)}`,
    );
    line(
      "OFF-GATE wgs84 groundFar FP-exact vs baseline",
      results.offGateGroundFarExact === true,
    );
    line(
      "OFF-GATE wgs84 cascade splits FP-exact vs baseline",
      results.offGateSplitsExact === true,
    );
  }

  const required = SAVE_BASELINE
    ? [results.wgs84GroundFarAgrees, results.noDeviceErrors]
    : [
        results.wgs84GroundFarAgrees,
        results.scaledGroundFarAgrees,
        results.scaledSplitsTight,
        results.csmActive,
        results.scaledShadowPresent,
        results.scaledShadowAgrees,
        results.noDeviceErrors,
        results.offGatePixel ? results.offGatePixelIdentical : true,
        results.offGatePixel ? results.offGateGroundFarExact === true : true,
      ];
  const pass = required.every(Boolean);
  console.log(`\n  OVERALL: ${pass ? "PASS" : "FAIL"}${SAVE_BASELINE ? " (baseline mode — scaled-cell divergence expected pre-fix, reported above)" : ""}`);

  fs.writeFileSync(
    path.join(OUT_DIR, "ellipsoid-rte-report.json"),
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        mode,
        scale: SCALE,
        cells: Object.fromEntries(
          Object.entries(cells).map(([k, c]) => [
            k,
            {
              label: c.label,
              screenshot: c.out,
              diagnostics: c.diagnostics,
              deviceErrorCount: c.deviceErrors.length,
            },
          ]),
        ),
        results,
        pass,
      },
      null,
      2,
    ),
  );
  process.exitCode = pass ? 0 : 1;
})();
