#!/usr/bin/env node
// probe-ocean-datum.mjs — the shared TIDES + OCEAN-DYNAMICS W0 DATUM PROBE.
//
// This is the measurement that gates every vertical ocean design:
//   • TIDES_FEASIBILITY_2026-07-24.md §4 "FIRST MOVE" + §5a ruling T2
//     (T2 EXPANDED: the eventual architecture must support ellipsoid + geoid +
//      multiple vertical datums derived from the selected terrain/imagery — the
//      numbers this probe returns are the empirical input to that design).
//   • OCEAN_DYNAMICS_PLAN_2026-07-24.md W0 + the UNCONFIRMED register entry
//     "Cesium-World-Terrain ocean-lid datum (W0 probe, shared with tides)".
//   • DEFERRED_WORK.md C6-FFT-OCEAN-TIDE-DATUM seed.
//
// Rationale, site selection, the EGM2008 reference table with its citation, the
// decision tree and the full manifest schema live in
//   migration_doc/OCEAN_DATUM_PROBE_DESIGN_2026-07-24.md
// The classification math lives in `lib/ocean-datum-model.mjs` and is pinned by
// `node --test Tools/visual-regression/ocean-datum.spec.mjs`.
//
// WHAT IT MEASURES (three lanes, all against the app's own terrain provider)
// -------------------------------------------------------------------------
// LANE 1 — DATUM SURVEY. `sampleTerrainMostDetailed` (plus `sampleTerrain` at
//   levels 0/4/8) at six OPEN-OCEAN sites spanning the EGM2008 undulation range
//   (-100 m Indian Ocean low → +65 m West Pacific high). If CWT's sea surface
//   sits at ellipsoidal 0 every value is ≈ 0; if it carries the geoid the values
//   track the undulations. `sampleTerrain*` is chosen over a rendered-pixel or
//   pick measurement because it reads the DECODED TERRAIN TILE HEIGHT directly:
//   backend-independent, exaggeration-independent, camera-independent and free
//   of any shader-side transform — i.e. it measures the DATA's datum, which is
//   the question, not the renderer's treatment of it.
//
// LANE 2 — FFT PATCH vs WATERLINE at a high-undulation coast (Laccadive Sea,
//   off SW Sri Lanka, undulation ≈ -95 m). `OceanSurfacePrimitive` anchors at
//   `ellipsoid.scaleToGeodeticSurface(cameraPos)` — ellipsoidal height 0 by
//   construction (`Scene/OceanSurfacePrimitive.js:115-167`, "height 0 datum"),
//   and the WGSL patch is a spherical cap THROUGH that anchor (`OceanSurface.wgsl:99`
//   drop = -(e0²+n0²)·0.5·invRadius), so the anchor's geodetic height IS the
//   patch's sea-level datum. API READS are preferred over screen-space
//   measurement (the task's stated preference and the more precise instrument:
//   metres, not pixels); a canvas PNG pair (ocean OFF / ON) + their mean
//   |Δluminance| corroborate visually and prove the patch was actually in frame,
//   so a "0 offset" cannot be silently produced by an absent patch.
//   WebGPU-only lane — the FFT ocean is a documented WebGL no-op.
//
// LANE 3 — VERTICAL EXAGGERATION. The same ocean point sampled at
//   `scene.verticalExaggeration` 1.0 vs 3.0. Cesium's map is
//   h' = (h - relativeHeight)·scale + relativeHeight (Core/VerticalExaggeration.js),
//   so an ellipsoid-0 lid is a FIXED POINT and does not move, while a
//   geoid-carrying lid at -100 m drops to -300 m. Measured with
//   `globe.getHeight()` because that picks the RENDERED mesh (the terrain picker
//   is rebuilt on an exaggeration change — Core/TerrainMesh.js:244-250), with
//   `sampleTerrainMostDetailed` as the raw control that must stay invariant.
//   That contrast is itself the renderer-vs-CPU divergence Design B inherits.
//
// NETWORK: Cesium World Terrain streams from ion (asset 1, via
// `Terrain.fromWorldTerrain()` in Apps/CesiumViewer). Network use is expected
// and STREAM-ONLY — nothing is cached or bundled. If ion is unreachable the
// probe exits 2 with a clear message; it NEVER fabricates a height.
//
// EXIT CODES
//   0 — a clean, actionable datum answer (ELLIPSOID_ZERO or GEOID).
//   1 — an answer was obtained but it is the MIXED/OTHER branch (or the survey
//       was too thin): escalate to the T2 multi-vertical-datum adapter design.
//       This is a REAL RESULT, not a broken probe.
//   2 — structural: ion unreachable, no terrain availability, backend fallback,
//       a lane threw, or the watchdog fired.
//
// Usage: node Tools/visual-regression/probe-ocean-datum.mjs
//   env PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  DATUM_SITES,
  SURVEY_LEVELS,
  THRESHOLDS,
  classifyDatum,
  decisionFromLanes,
  exaggerationVerdict,
  patchAnchorVerdict,
} from "./lib/ocean-datum-model.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MANIFEST = path.join(OUT_DIR, "ocean-datum.json");
const RENDERER = "webgpu"; // lane 2 requires it; lanes 1/3 are backend-neutral

// ── house rule: hard watchdog + unref, forces exit 2 on hang ──
// Longer than the 300 s fleet default because three lanes each stream CWT tiles
// from ion over the network at six survey sites plus two exaggeration sites.
const HARD_LIMIT_MS = 480000;
const watchdog = setTimeout(() => {
  console.error("[probe-ocean-datum] WATCHDOG FIRED (480s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const VIEWPORT = { width: 1280, height: 720 };
// Pinned clock — every render in every lane passes this exact time so nothing
// drifts with wall time (sun position, animated water mask, cloud phase).
const DAY_ISO = "2026-07-03T06:00:00Z";

// Lane 2 site. Laccadive Sea ~40 km off the SW coast of Sri Lanka: OPEN WATER
// inside the EGM2008 Indian Ocean low (undulation ≈ -95 m) with the coast to
// the east, so the frame carries both the FFT patch and the baked CWT sea.
const PATCH_SITE = Object.freeze({
  id: "LKA-COAST",
  lonDeg: 79.75,
  latDeg: 6.0,
  cameraAltM: 120.0,
  headingDeg: 90.0,
  pitchDeg: -6.0,
  approxUndulationM: -95,
});

// Lane 3 sites: the maximum-lever site and the near-zero control.
const EXAG_SITE_IDS = Object.freeze(["IND-LOW", "PAC-MID"]);
const EXAG_SCALE = 3.0;
const EXAG_CAMERA_ALT_M = 15000.0;

// Bounded frame budgets (house rule: every loop has a hard bound).
const FRAMES = Object.freeze({
  patchSettle: 260,
  // `patchBaseline` and `patchOcean` MUST be equal: the OFF-vs-OFF delta over
  // `patchBaseline` frames is the temporal control for the OFF-vs-ON delta over
  // `patchOcean` frames (the base globe animates its water-mask waves, so
  // "pixels changed" alone would not prove the FFT patch rendered).
  patchBaseline: 120,
  patchOcean: 120,
  exagSettle: 200,
  exagAfterChange: 160,
});
const IN_PAGE_TIMEOUT_MS = 120000; // bound every terrain await inside the page

// ───────────────────────── in-page lanes ─────────────────────────
// Helpers live INSIDE each page.evaluate body (fleet rule) — nothing is closed
// over from Node except the plain-object argument.

const SURVEY = async ({ sites, levels, timeoutMs }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  viewer.useDefaultRenderLoop = false; // house rule: no default loop
  scene.requestRenderMode = false;

  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms),
      ),
    ]);
  // Never let an ion access token reach the manifest.
  const redact = (u) => {
    if (typeof u !== "string") {
      return null;
    }
    return u.split("?")[0].replace(/ey[A-Za-z0-9_-]{12,}/g, "<redacted-jwt>");
  };
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const radii = (e) =>
    e && e.radii ? { x: e.radii.x, y: e.radii.y, z: e.radii.z } : null;

  const provider = scene.globe.terrainProvider;
  const identity = {
    rendererType: scene.context.rendererType,
    constructorName: provider ? provider.constructor.name : null,
    hasAvailability: !!(provider && provider.availability),
    hasWaterMask: provider ? provider.hasWaterMask === true : null,
    hasVertexNormals: provider ? provider.hasVertexNormals === true : null,
    creditHtml:
      provider && provider.credit && provider.credit.html
        ? String(provider.credit.html).slice(0, 240)
        : null,
    resourceUrlRedacted: redact(
      provider && provider._resource ? provider._resource.url : null,
    ),
    tilingSchemeEllipsoidRadii: radii(
      provider && provider.tilingScheme
        ? provider.tilingScheme.ellipsoid
        : null,
    ),
    ellipsoidWgs84Radii: radii(C.Ellipsoid.WGS84),
    ellipsoidDefaultRadii: radii(C.Ellipsoid.default),
  };
  identity.ellipsoidsMatch =
    !!identity.ellipsoidWgs84Radii &&
    !!identity.ellipsoidDefaultRadii &&
    identity.ellipsoidWgs84Radii.x === identity.ellipsoidDefaultRadii.x &&
    identity.ellipsoidWgs84Radii.z === identity.ellipsoidDefaultRadii.z;

  if (!provider || !provider.availability) {
    return {
      ok: false,
      structural: true,
      reason:
        "terrain provider has no tile availability — Cesium World Terrain did not load (ion unreachable, or the viewer fell back to EllipsoidTerrainProvider)",
      identity,
      samples: [],
    };
  }

  const cartoOf = (s) => C.Cartographic.fromDegrees(s.lonDeg, s.latDeg);
  const maxLevels = sites.map((s) =>
    provider.availability.computeMaximumLevelAtPosition(cartoOf(s)),
  );

  // Most-detailed pass.
  const md = sites.map(cartoOf);
  await withTimeout(
    C.sampleTerrainMostDetailed(provider, md, false),
    timeoutMs,
    "sampleTerrainMostDetailed",
  );

  // Fixed-level passes (LOD-dependence detector). Bounded by `levels.length`.
  const byLevel = {};
  for (const level of levels) {
    const ps = sites.map(cartoOf);
    await withTimeout(
      C.sampleTerrain(provider, level, ps, false),
      timeoutMs,
      `sampleTerrain(level=${level})`,
    );
    byLevel[level] = ps.map((p) => num(p.height));
  }

  const samples = sites.map((s, i) => {
    const heightByLevelM = {};
    for (const level of levels) {
      heightByLevelM[level] = byLevel[level][i];
    }
    return {
      id: s.id,
      lonDeg: s.lonDeg,
      latDeg: s.latDeg,
      maxAvailableLevel: num(maxLevels[i]),
      heightM: num(md[i].height),
      heightByLevelM,
    };
  });

  return { ok: true, structural: false, identity, samples };
};

const PATCH = async ({ site, dayIso, frames, timeoutMs }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const pin = () => {
    viewer.clock.currentTime = C.JulianDate.fromIso8601(dayIso);
  };
  pin();
  const T = () => viewer.clock.currentTime;

  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms),
      ),
    ]);
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  if (!globe.water || !globe.water.ocean) {
    return {
      ok: false,
      structural: true,
      reason:
        "scene.globe.water.ocean facade is missing — the FFT ocean cannot be enabled",
      rendererType: scene.context.rendererType,
    };
  }

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(
      site.lonDeg,
      site.latDeg,
      site.cameraAltM,
    ),
    orientation: {
      heading: C.Math.toRadians(site.headingDeg),
      pitch: C.Math.toRadians(site.pitchDeg),
      roll: 0.0,
    },
  });

  const canvas = scene.canvas;
  const w = canvas.width;
  const h = canvas.height;
  // Same-task capture: render at the pinned time, read pixels with NO await in
  // between (WebGPU clears the drawing buffer once the compositor presents).
  // The PNG comes from a 2d copy of the CANVAS ELEMENT only — no app chrome.
  const grab = () => {
    pin();
    scene.render(T());
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    return {
      data: ctx.getImageData(0, 0, w, h).data,
      dataUrl: tmp.toDataURL("image/png"),
    };
  };

  const advance = async (count) => {
    for (let i = 0; i < count; i++) {
      pin();
      scene.render(T());
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  await advance(frames.patchSettle);
  const off1 = grab();
  // Temporal control: the SAME frame span with the ocean still OFF, so the
  // animated water-mask contribution is measured rather than mistaken for the
  // FFT patch.
  await advance(frames.patchBaseline);
  const off2 = grab();

  globe.water.ocean.enabled = true;
  await advance(frames.patchOcean);
  const on = grab();

  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const meanAbsLum = (A, B) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      sum += Math.abs(lum(A, i) - lum(B, i));
      n++;
    }
    return n ? sum / n : null;
  };
  const baselineLumDelta = meanAbsLum(off1.data, off2.data);
  const meanAbsLumDelta = meanAbsLum(off2.data, on.data);

  const prim = globe.water.ocean.primitive;
  const cartoOfCartesian = (c) =>
    c
      ? (() => {
          const g = C.Cartographic.fromCartesian(c, C.Ellipsoid.WGS84);
          return g
            ? {
                lonDeg: C.Math.toDegrees(g.longitude),
                latDeg: C.Math.toDegrees(g.latitude),
                heightM: num(g.height),
              }
            : null;
        })()
      : null;

  const primitiveState = prim
    ? {
        created: true,
        show: prim.show === true,
        a0: cartoOfCartesian(prim._a0),
        anchor: cartoOfCartesian(prim._anchor),
        patchLengthM: num(prim._patchLength),
        patchExtentM: num(prim._patchExtent),
        uvOffset: [num(prim._uvOffsetX), num(prim._uvOffsetY)],
        invRadius: num(prim._invRadius),
        curvatureRadiusM: num(prim._invRadius) ? 1.0 / prim._invRadius : null,
      }
    : { created: false };

  // Terrain at the ANCHOR's own lon/lat — apples-to-apples with the patch datum.
  let terrainRawHeightM = null;
  let terrainRenderedHeightM = null;
  const anchorGeo = primitiveState.anchor ?? primitiveState.a0 ?? null;
  if (anchorGeo) {
    const carto = C.Cartographic.fromDegrees(
      anchorGeo.lonDeg,
      anchorGeo.latDeg,
    );
    terrainRenderedHeightM = num(globe.getHeight(carto));
    const provider = globe.terrainProvider;
    if (provider && provider.availability) {
      const ps = [
        C.Cartographic.fromDegrees(anchorGeo.lonDeg, anchorGeo.latDeg),
      ];
      await withTimeout(
        C.sampleTerrainMostDetailed(provider, ps, false),
        timeoutMs,
        "sampleTerrainMostDetailed(anchor)",
      );
      terrainRawHeightM = num(ps[0].height);
    }
  }

  // Leave the scene as we found it.
  globe.water.ocean.enabled = false;

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    site,
    primitive: primitiveState,
    terrainAtAnchor: { terrainRawHeightM, terrainRenderedHeightM },
    visual: {
      meanAbsLumDelta,
      baselineLumDelta,
      frameSpan: frames.patchOcean,
      width: w,
      height: h,
    },
    offDataUrl: off2.dataUrl,
    onDataUrl: on.dataUrl,
  };
};

const EXAG = async ({ sites, dayIso, altM, scale, frames, timeoutMs }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const pin = () => {
    viewer.clock.currentTime = C.JulianDate.fromIso8601(dayIso);
  };
  pin();
  const T = () => viewer.clock.currentTime;

  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms),
      ),
    ]);
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const settle = async (count) => {
    for (let i = 0; i < count; i++) {
      pin();
      scene.render(T());
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const rawHeight = async (lonDeg, latDeg) => {
    const provider = globe.terrainProvider;
    if (!provider || !provider.availability) {
      return null;
    }
    const ps = [C.Cartographic.fromDegrees(lonDeg, latDeg)];
    await withTimeout(
      C.sampleTerrainMostDetailed(provider, ps, false),
      timeoutMs,
      "sampleTerrainMostDetailed(exag)",
    );
    return num(ps[0].height);
  };

  const results = [];
  for (const s of sites) {
    scene.camera.setView({
      destination: C.Cartesian3.fromDegrees(s.lonDeg, s.latDeg, altM),
      orientation: { heading: 0.0, pitch: C.Math.toRadians(-90.0), roll: 0.0 },
    });

    scene.verticalExaggeration = 1.0;
    scene.verticalExaggerationRelativeHeight = 0.0;
    await settle(frames.exagSettle);
    const carto1 = C.Cartographic.fromDegrees(s.lonDeg, s.latDeg);
    const renderedH1M = num(globe.getHeight(carto1));
    const rawH1M = await rawHeight(s.lonDeg, s.latDeg);

    scene.verticalExaggeration = scale;
    await settle(frames.exagAfterChange);
    const carto3 = C.Cartographic.fromDegrees(s.lonDeg, s.latDeg);
    const renderedH3M = num(globe.getHeight(carto3));
    const rawH3M = await rawHeight(s.lonDeg, s.latDeg);

    scene.verticalExaggeration = 1.0; // restore before the next site

    results.push({
      id: s.id,
      lonDeg: s.lonDeg,
      latDeg: s.latDeg,
      exaggeration: scale,
      relativeHeightM: 0.0,
      renderedH1M,
      renderedH3M,
      rawH1M,
      rawH3M,
    });
  }

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    cameraAltM: altM,
    sites: results,
  };
};

// ───────────────────────── Node driver ─────────────────────────

async function runLane(browser, label, fn, arg) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      consoleErrors.push(m.text().slice(0, 220));
    }
  });
  page.on("pageerror", (e) =>
    consoleErrors.push(String(e.message).slice(0, 220)),
  );
  page.on("requestfailed", (req) => {
    const url = req.url();
    if (/cesium\.com|ion\.cesium/.test(url)) {
      failedRequests.push(
        `${url.split("?")[0]} :: ${req.failure()?.errorText ?? "failed"}`,
      );
    }
  });

  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`,
      { waitUntil: "domcontentloaded", timeout: 90000 },
    );
    await page.waitForFunction(
      () =>
        !!(
          window.viewer &&
          window.viewer.scene &&
          window.viewer.scene.context &&
          window.viewer.scene.globe &&
          window.viewer.scene.globe.terrainProvider
        ),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(5000); // let the ion terrain layer.json resolve
    const result = await page.evaluate(fn, arg);
    return {
      label,
      ...result,
      consoleErrors: consoleErrors.slice(0, 6),
      failedIonRequests: [...new Set(failedRequests)].slice(0, 6),
    };
  } catch (e) {
    return {
      label,
      ok: false,
      structural: true,
      reason: String((e && e.message) || e).slice(0, 400),
      consoleErrors: consoleErrors.slice(0, 6),
      failedIonRequests: [...new Set(failedRequests)].slice(0, 6),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function writePng(dataUrl, file) {
  if (!dataUrl) {
    return null;
  }
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const out = path.join(OUT_DIR, file);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const surveySites = DATUM_SITES.map((s) => ({
    id: s.id,
    lonDeg: s.lonDeg,
    latDeg: s.latDeg,
  }));
  const exagSites = DATUM_SITES.filter((s) => EXAG_SITE_IDS.includes(s.id)).map(
    (s) => ({ id: s.id, lonDeg: s.lonDeg, latDeg: s.latDeg }),
  );

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let lane1;
  let lane2;
  let lane3;
  try {
    lane1 = await runLane(browser, "datum-survey", SURVEY, {
      sites: surveySites,
      levels: [...SURVEY_LEVELS],
      timeoutMs: IN_PAGE_TIMEOUT_MS,
    });
    lane2 = await runLane(browser, "fft-patch-vs-waterline", PATCH, {
      site: { ...PATCH_SITE },
      dayIso: DAY_ISO,
      frames: { ...FRAMES },
      timeoutMs: IN_PAGE_TIMEOUT_MS,
    });
    lane3 = await runLane(browser, "vertical-exaggeration", EXAG, {
      sites: exagSites,
      dayIso: DAY_ISO,
      altM: EXAG_CAMERA_ALT_M,
      scale: EXAG_SCALE,
      frames: { ...FRAMES },
      timeoutMs: IN_PAGE_TIMEOUT_MS,
    });
  } finally {
    await browser.close().catch(() => {});
  }

  // Canvas-element PNG evidence (lane 2) — READ THESE, numbers alone don't
  // prove the patch/waterline seam looks the way the metres say it does.
  const pngs = {};
  if (lane2 && lane2.ok) {
    pngs.oceanOff = writePng(lane2.offDataUrl, "ocean-datum-patch-off.png");
    pngs.oceanOn = writePng(lane2.onDataUrl, "ocean-datum-patch-on.png");
    delete lane2.offDataUrl;
    delete lane2.onDataUrl;
  }

  // ── structural gates (exit 2) ──
  const structuralFailures = [];
  for (const lane of [lane1, lane2, lane3]) {
    if (!lane || !lane.ok) {
      structuralFailures.push(
        `${lane ? lane.label : "?"}: ${lane ? (lane.reason ?? "lane failed") : "lane missing"}`,
      );
    }
  }
  const rendererActual =
    (lane1 && lane1.identity && lane1.identity.rendererType) ??
    (lane2 && lane2.rendererType) ??
    null;
  if (rendererActual && rendererActual !== RENDERER) {
    structuralFailures.push(
      `backend fell back: rendererType "${rendererActual}" !== requested "${RENDERER}"`,
    );
  }
  const allSamplesNull =
    lane1 && lane1.ok && lane1.samples.every((s) => s.heightM === null);
  if (allSamplesNull) {
    structuralFailures.push(
      "every survey site returned an undefined height — Cesium World Terrain tiles did not load (ion unreachable)",
    );
  }

  // ── classification + verdicts ──
  const datum =
    lane1 && lane1.ok
      ? classifyDatum(lane1.samples)
      : {
          classification: "INSUFFICIENT_DATA",
          subLabel: null,
          reasons: [],
          stats: null,
        };

  const patch =
    lane2 && lane2.ok
      ? patchAnchorVerdict({
          anchorHeightM: lane2.primitive?.anchor?.heightM ?? null,
          terrainRawHeightM: lane2.terrainAtAnchor?.terrainRawHeightM ?? null,
          terrainRenderedHeightM:
            lane2.terrainAtAnchor?.terrainRenderedHeightM ?? null,
          meanAbsLumDelta: lane2.visual?.meanAbsLumDelta ?? null,
          baselineLumDelta: lane2.visual?.baselineLumDelta ?? null,
        })
      : {
          verdict: "INDETERMINATE",
          rawMinusAnchorM: null,
          renderedMinusAnchorM: null,
          patchVisible: null,
          patchVisibilityFloor: null,
        };

  const exaggeration =
    lane3 && lane3.ok
      ? lane3.sites.map((s) => ({
          id: s.id,
          ...exaggerationVerdict({
            exaggeration: s.exaggeration,
            relativeHeightM: s.relativeHeightM,
            renderedH1M: s.renderedH1M,
            renderedH3M: s.renderedH3M,
            rawH1M: s.rawH1M,
            rawH3M: s.rawH3M,
          }),
        }))
      : [];

  const decision = decisionFromLanes({ datum, patch, exaggeration });
  const exitCode = structuralFailures.length ? 2 : decision.exitCode;

  const manifest = {
    probe: "probe-ocean-datum",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    base: BASE,
    watchdogMs: HARD_LIMIT_MS,
    clockIso: DAY_ISO,
    environment: {
      browserChannel: "msedge",
      headless: true,
      viewport: VIEWPORT,
      rendererRequested: RENDERER,
      rendererActual,
    },
    terrainProvider: {
      ...(lane1 && lane1.identity ? lane1.identity : {}),
      ionAssetId: 1,
      ionAssetIdSource:
        "Apps/CesiumViewer/CesiumViewer.js:58-62 Terrain.fromWorldTerrain({requestWaterMask,requestVertexNormals}) -> packages/engine/Source/Core/createWorldTerrainAsync.js:44 CesiumTerrainProvider.fromIonAssetId(1, ...)",
      licenceNote:
        "Cesium ion Community plan — STREAM-ONLY. Nothing is cached, stored or bundled by this probe (TIDES_FEASIBILITY_2026-07-24.md §3).",
    },
    thresholds: THRESHOLDS,
    referenceTable: DATUM_SITES,
    lane1_datumSurvey: lane1
      ? {
          ok: lane1.ok,
          reason: lane1.reason ?? null,
          sites: (lane1.samples ?? []).map((s) => {
            const ref = DATUM_SITES.find((r) => r.id === s.id);
            return {
              ...s,
              egm2008: ref
                ? {
                    undulationM: ref.undulationM,
                    toleranceM: ref.toleranceM,
                    confidence: ref.confidence,
                    source: ref.source,
                  }
                : null,
              residualVsEllipsoidM: s.heightM,
              residualVsGeoidM:
                s.heightM === null || !ref ? null : s.heightM - ref.undulationM,
            };
          }),
          stats: datum.stats,
          classification: datum.classification,
          subLabel: datum.subLabel,
          reasons: datum.reasons,
          consoleErrors: lane1.consoleErrors ?? [],
          failedIonRequests: lane1.failedIonRequests ?? [],
        }
      : null,
    lane2_fftPatchVsWaterline: lane2
      ? {
          ok: lane2.ok,
          reason: lane2.reason ?? null,
          site: lane2.site ?? PATCH_SITE,
          primitive: lane2.primitive ?? null,
          terrainAtAnchor: lane2.terrainAtAnchor ?? null,
          offsets: {
            rawMinusAnchorM: patch.rawMinusAnchorM,
            renderedMinusAnchorM: patch.renderedMinusAnchorM,
          },
          verdict: patch.verdict,
          visual: {
            ...(lane2.visual ?? {}),
            patchVisible: patch.patchVisible,
            patchVisibilityFloor: patch.patchVisibilityFloor,
            pngs,
          },
          consoleErrors: lane2.consoleErrors ?? [],
          failedIonRequests: lane2.failedIonRequests ?? [],
        }
      : null,
    lane3_verticalExaggeration: lane3
      ? {
          ok: lane3.ok,
          reason: lane3.reason ?? null,
          cameraAltM: lane3.cameraAltM ?? EXAG_CAMERA_ALT_M,
          exaggeration: EXAG_SCALE,
          sites: (lane3.sites ?? []).map((s) => ({
            ...s,
            ...(exaggeration.find((e) => e.id === s.id) ?? {}),
          })),
          consoleErrors: lane3.consoleErrors ?? [],
          failedIonRequests: lane3.failedIonRequests ?? [],
        }
      : null,
    decision: {
      ...decision,
      structuralFailures,
      exitCode,
      GATE: structuralFailures.length
        ? `INCOMPLETE — ${structuralFailures[0]}`
        : decision.exitCode === 0
          ? `ANSWERED — CWT ocean-lid datum = ${decision.datumHypothesis}`
          : `ESCALATE — CWT ocean-lid datum = ${decision.datumHypothesis}${decision.subLabel ? ` (${decision.subLabel})` : ""}`,
    },
  };

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  // ── console summary ──
  console.log(
    "== ocean-lid vertical-datum probe (TIDES + OCEAN-DYNAMICS W0) ==",
  );
  if (lane1 && lane1.ok) {
    console.log("\nLANE 1 — datum survey (ellipsoidal metres from CWT):");
    for (const s of manifest.lane1_datumSurvey.sites) {
      const ref = s.egm2008 ? s.egm2008.undulationM : null;
      console.log(
        `  ${s.id.padEnd(11)} ${String(s.lonDeg).padStart(7)}E ${String(s.latDeg).padStart(6)}N  ` +
          `sampled ${s.heightM === null ? "  n/a  " : s.heightM.toFixed(2).padStart(8)} m   ` +
          `EGM2008 ${ref === null ? " n/a " : String(ref).padStart(5)} m   ` +
          `maxLevel ${s.maxAvailableLevel}   byLevel ${JSON.stringify(s.heightByLevelM)}`,
      );
    }
    const st = datum.stats;
    if (st) {
      console.log(
        `  stats: maxAbs ${st.maxAbsHeightM?.toFixed(3)} m  spread ${st.spreadM?.toFixed(3)} m  ` +
          `rmsVsEllipsoid ${st.rmsResidualVsEllipsoidM?.toFixed(2)} m  rmsVsGeoid ${st.rmsResidualVsGeoidM?.toFixed(2)} m`,
      );
      console.log(
        `  regression h = ${st.regression.slope === null ? "n/a" : st.regression.slope.toFixed(3)}·N + ` +
          `${st.regression.intercept === null ? "n/a" : st.regression.intercept.toFixed(2)}  ` +
          `r2 ${st.regression.r2 === null ? "n/a" : st.regression.r2.toFixed(3)}  ` +
          `signAgreement ${st.signAgreement === null ? "n/a" : st.signAgreement.toFixed(2)}  ` +
          `LODdependent ${st.levelDependence.dependent}`,
      );
    }
    console.log(
      `  CLASSIFICATION: ${datum.classification}${datum.subLabel ? ` / ${datum.subLabel}` : ""}`,
    );
    datum.reasons.forEach((r) => console.log(`    - ${r}`));
  } else if (lane1) {
    console.log(`\nLANE 1 FAILED: ${lane1.reason}`);
  }

  if (lane2 && lane2.ok) {
    console.log("\nLANE 2 — FFT patch anchor vs CWT waterline (LKA-COAST):");
    console.log(
      `  patch anchor height   ${lane2.primitive?.anchor?.heightM ?? "n/a"} m   (a0 ${lane2.primitive?.a0?.heightM ?? "n/a"} m)`,
    );
    console.log(
      `  terrain @ anchor raw  ${lane2.terrainAtAnchor?.terrainRawHeightM ?? "n/a"} m   rendered ${lane2.terrainAtAnchor?.terrainRenderedHeightM ?? "n/a"} m`,
    );
    console.log(
      `  offset (terrain-anchor) raw ${patch.rawMinusAnchorM ?? "n/a"} m   rendered ${patch.renderedMinusAnchorM ?? "n/a"} m  →  ${patch.verdict}`,
    );
    console.log(
      `  patch in frame: ${patch.patchVisible} (mean |Δlum| ON vs OFF = ${lane2.visual?.meanAbsLumDelta?.toFixed(3)}, ` +
        `OFF-vs-OFF baseline ${lane2.visual?.baselineLumDelta?.toFixed(3)}, floor ${patch.patchVisibilityFloor?.toFixed(3)})`,
    );
    console.log(`  PNGs: ${pngs.oceanOff}  ${pngs.oceanOn}   ← READ THESE`);
  } else if (lane2) {
    console.log(`\nLANE 2 FAILED: ${lane2.reason}`);
  }

  if (lane3 && lane3.ok) {
    console.log("\nLANE 3 — scene.verticalExaggeration 1.0 vs 3.0:");
    for (const s of manifest.lane3_verticalExaggeration.sites) {
      console.log(
        `  ${s.id.padEnd(11)} rendered ${s.renderedH1M ?? "n/a"} → ${s.renderedH3M ?? "n/a"} m ` +
          `(predicted ${s.predictedH3M === null || s.predictedH3M === undefined ? "n/a" : s.predictedH3M.toFixed(3)}), ` +
          `raw ${s.rawH1M ?? "n/a"} → ${s.rawH3M ?? "n/a"} m  →  ${s.verdict}`,
      );
    }
  } else if (lane3) {
    console.log(`\nLANE 3 FAILED: ${lane3.reason}`);
  }

  console.log("\nDECISION:");
  console.log(
    `  datum hypothesis : ${decision.datumHypothesis}${decision.subLabel ? ` / ${decision.subLabel}` : ""}`,
  );
  console.log(`  implication      : ${decision.implication}`);
  console.log(`  patch            : ${decision.patchImplication}`);
  console.log(`  exaggeration     : ${decision.exaggerationImplication}`);
  if (structuralFailures.length) {
    console.log("  STRUCTURAL FAILURES:");
    structuralFailures.forEach((f) => console.log(`    - ${f}`));
  }
  for (const lane of [lane1, lane2, lane3]) {
    if (lane && lane.failedIonRequests && lane.failedIonRequests.length) {
      console.log(`  [${lane.label}] failed ion requests:`);
      lane.failedIonRequests.forEach((f) => console.log(`    - ${f}`));
    }
    if (lane && lane.consoleErrors && lane.consoleErrors.length) {
      lane.consoleErrors.forEach((e) =>
        console.log(`  [${lane.label}] console: ${e}`),
      );
    }
  }

  console.log(`\n[full manifest: ${MANIFEST}]`);
  console.log(`\nGATE: ${manifest.decision.GATE}\nEXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-ocean-datum] FATAL", e);
  process.exit(2);
});
