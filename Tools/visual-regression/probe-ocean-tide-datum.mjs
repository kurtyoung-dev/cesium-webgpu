#!/usr/bin/env node
// probe-ocean-tide-datum.mjs — acceptance for C6-FFT-OCEAN-TIDE-DATUM slice 1
// (the FFT-ocean vertical-datum anchor + the equilibrium tide).
//
// SIBLING of `probe-ocean-datum.mjs` (Batch 759), which MEASURED the problem:
// Cesium World Terrain's ocean lid is the GEOID, the FFT patch anchored at
// ellipsoidal 0, and at the Sri Lanka coast the patch floated 101.64 m above
// the baked sea. That probe answered a question; this one accepts a fix.
//
// AUTHORITIES
//   migration_doc/TIDES_FEASIBILITY_2026-07-24.md §5a rulings T1 (TideModel in
//     Core), T2 (multi-vdatum derived from the terrain, manual override), T3
//     (documented tideExaggeration, default 1.0), T6 (tide timing phase-locked
//     to the scene clock + the real Simon-1994 ephemerides) and §5b (the datum
//     probe result, including "verticalExaggeration DOES displace the lid, so
//     the tide term must compose WITH the exaggeration map").
//   migration_doc/OCEAN_DATUM_PROBE_DESIGN_2026-07-24.md — the instrument this
//     probe reuses (sampleTerrainMostDetailed at the anchor's own lon/lat).
//
// FOUR LANES
//   (a) DATUM FIX at the India/Sri Lanka coast. Both halves of the before/after
//       are measured IN THIS RUN: the "before" comes from pinning
//       `oceanVerticalDatum = "ELLIPSOID"`, not from trusting the Batch 759
//       number, so terrain-LOD drift cannot masquerade as an improvement. The
//       archived value is still checked — if the re-measured baseline does not
//       reproduce it, the comparison is declared un-anchored rather than
//       quietly accepted. PNG pair captured; READ THEM (Principle 8 step 4).
//   (b) TIDE PHASE. A pinned-clock ladder across 25 h at a reference coast
//       (NOAA CO-OPS station 8418150 region), reading the RENDERED
//       `tideHeightMeters` after each render, plus the model evaluated at the
//       same instants. Three independent things are checked: the rendered value
//       equals the model at the pinned SCENE time (that is the T6 clock lock —
//       anything reading wall time fails here); the lunar-only term peaks AT
//       lunar culmination; and the mean lunar period equals the published NOAA
//       M2 constituent (12.4206 h), not 12.00 h. The spring/neap envelope is
//       checked against Sun-Moon elongation over 90 days.
//   (c) EXAGGERATION COMPOSITION. `scene.verticalExaggeration` 1.0 vs 3.0 with
//       the clock pinned, asserting h' = (h - rel)*scale + rel on the published
//       anchor height. Batch 759 lane 3 measured the terrain lid doing exactly
//       this (India -104 -> -313 m); a patch that does not follow re-opens the
//       plateau at scale > 1.
//   (d) OFF-CONTRACT. `tideEnabled = false`, a zero `tideCallback`, and
//       `oceanVerticalDatum = "ELLIPSOID"` must each produce EXACTLY 0 — and
//       together must put the anchor back on the ellipsoid surface.
//
// WHY THE TIDE IS NOT COMPARED TO A STATION'S HIGH-WATER CLOCK TIME. The
// equilibrium tide has ZERO phase lag by construction; every real station lags
// lunar transit by its own "high water lunitidal interval" (hours), and coastal
// ranges are 1-16 m against an equilibrium ±0.3 m. Asserting agreement with a
// NOAA predicted high-water TIME would therefore be asserting something false.
// What IS externally checkable, and is checked: the PERIOD (NOAA's published
// M2 constituent speed), the spring/neap BEAT (half a synodic month), and the
// phase lock to the actual Moon. The ephemeris underneath is the same
// Simon-1994 chain already pinned against a real event — the 2024-04-08 total
// solar eclipse — by `eclipse-state.spec.mjs`.
//
// EXIT CODES
//   0 — all four lanes pass.
//   1 — a lane returned a real but failing verdict (a result, not a fault).
//   2 — structural: ion unreachable, backend fallback, the ocean facade or the
//       geoid asset missing, a lane threw, or the watchdog fired.
//
// Usage: node Tools/visual-regression/probe-ocean-tide-datum.mjs
//   env PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import {
  DATUM_FIX_SITE,
  PUBLISHED_CONSTANTS,
  THRESHOLDS,
  TIDE_PERIOD_SITE,
  TIDE_PHASE_SITE,
  datumFixVerdict,
  decisionFromLanes,
  exaggerationCompositionVerdict,
  offContractVerdict,
  tidePhaseVerdict,
} from "./lib/ocean-tide-datum-model.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const MANIFEST = path.join(OUT_DIR, "ocean-tide-datum.json");
const RENDERER = "webgpu"; // the FFT ocean is a documented WebGL no-op

// House rule: hard watchdog, unref'd, forces exit 2. 480 s matches the sibling
// datum probe — four lanes each stream CWT tiles from ion at two coasts.
const HARD_LIMIT_MS = 480000;
const watchdog = setTimeout(() => {
  console.error("[probe-ocean-tide-datum] WATCHDOG FIRED (480s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) {
  watchdog.unref();
}

const VIEWPORT = { width: 1280, height: 720 };
// Pinned clock. The same instant the Batch 759 probe used, so lane (a)'s PNGs
// are directly comparable with `ocean-datum-patch-{off,on}.png`.
const DAY_ISO = "2026-07-03T06:00:00Z";
// Lane (b) ladder epoch — midnight of the same day, so the 25 h window is a
// whole civil day plus one hour (enough to contain two full M2 cycles).
const LADDER_ISO = "2026-07-03T00:00:00Z";

const FRAMES = Object.freeze({
  settle: 260,
  // `baseline` and `ocean` MUST be equal: the OFF-vs-OFF delta is the temporal
  // control for the OFF-vs-ON delta (the base globe animates its own water-mask
  // waves, so "pixels changed" alone does not prove the FFT patch rendered).
  baseline: 120,
  ocean: 120,
  afterDatumChange: 90,
  afterExagChange: 160,
  perLadderStep: 2,
  geoidWaitMax: 240, // bounded wait for the ~508 KiB asset to land
});

const LADDER = Object.freeze({
  stepSeconds: 900, // 15 min
  steps: 101, // 25 h inclusive
});
const PHASE_LOCK = Object.freeze({
  stepSeconds: 60,
  hours: 30,
});
const M2_LADDER = Object.freeze({
  stepSeconds: 300,
  days: THRESHOLDS.M2_BASELINE_DAYS,
});
const SPRING_LADDER = Object.freeze({
  days: 90,
  stepSeconds: 600,
  samplesPerDay: 150,
});
const EXAG_SCALE = 3.0;
const IN_PAGE_TIMEOUT_MS = 120000;

// ───────────────────────── in-page lanes ─────────────────────────
// Every helper is defined INSIDE the evaluated function (fleet rule); only
// plain-object arguments cross the boundary.

const DATUM_LANE = async ({ site, dayIso, frames, thresholds, timeoutMs }) => {
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
      reason: "scene.globe.water.ocean facade is missing",
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
  // Same-task capture: render at the pinned time and read the pixels with NO
  // await in between (WebGPU clears the drawing buffer once the compositor
  // presents). The PNG is a 2-D copy of the CANVAS ELEMENT — no app chrome.
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
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const meanAbsLum = (A, B) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < A.length; i += 4) {
      s += Math.abs(lum(A, i) - lum(B, i));
      n++;
    }
    return n ? s / n : null;
  };
  const anchorCarto = () => {
    const prim = globe.water.ocean.primitive;
    if (!prim || !prim._anchor) {
      return null;
    }
    const g = C.Cartographic.fromCartesian(prim._anchor, C.Ellipsoid.WGS84);
    return g
      ? {
          lonDeg: C.Math.toDegrees(g.longitude),
          latDeg: C.Math.toDegrees(g.latitude),
          heightM: num(g.height),
        }
      : null;
  };
  const terrainRawAt = async (lonDeg, latDeg) => {
    const provider = globe.terrainProvider;
    if (!provider || !provider.availability) {
      return null;
    }
    const ps = [C.Cartographic.fromDegrees(lonDeg, latDeg)];
    await withTimeout(
      C.sampleTerrainMostDetailed(provider, ps, false),
      timeoutMs,
      "sampleTerrainMostDetailed(anchor)",
    );
    return num(ps[0].height);
  };

  // ── visibility control: OFF / OFF / ON over equal frame spans ──
  await advance(frames.settle);
  const off1 = grab();
  await advance(frames.baseline);
  const off2 = grab();

  globe.water.ocean.enabled = true; // AUTO datum -> starts the geoid fetch
  await advance(frames.ocean);

  // Bounded wait for the bundled grid. A zero undulation here would look
  // exactly like "the fix does nothing", so it is a structural failure, not a
  // verdict.
  let geoidWaited = 0;
  for (let i = 0; i < frames.geoidWaitMax; i++) {
    if (num(globe.water.ocean.geoidUndulationMeters) !== 0) {
      break;
    }
    geoidWaited++;
    pin();
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (num(globe.water.ocean.geoidUndulationMeters) === 0) {
    globe.water.ocean.enabled = false;
    return {
      ok: false,
      structural: true,
      reason:
        "the bundled EGM2008 grid never produced a non-zero undulation at a -100 m site — Assets/Geoid/egm2008-0p5deg.i16 did not load",
      rendererType: scene.context.rendererType,
    };
  }

  const on = grab();
  const afterAnchor = anchorCarto();
  const after = {
    resolvedDatum: globe.water.ocean.resolvedVerticalDatum ?? null,
    geoidUndulationM: num(globe.water.ocean.geoidUndulationMeters),
    tideHeightM: num(globe.water.ocean.tideHeightMeters),
    anchorHeightM: num(globe.water.ocean.anchorHeightMeters),
    anchor: afterAnchor,
    terrainRawHeightM: afterAnchor
      ? await terrainRawAt(afterAnchor.lonDeg, afterAnchor.latDeg)
      : null,
    terrainRenderedHeightM: afterAnchor
      ? num(
          globe.getHeight(
            C.Cartographic.fromDegrees(afterAnchor.lonDeg, afterAnchor.latDeg),
          ),
        )
      : null,
  };

  // ── re-measure the PRE-FIX baseline in the same run ──
  globe.water.ocean.verticalDatum = "ELLIPSOID";
  globe.water.ocean.tideEnabled = false;
  await advance(frames.afterDatumChange);
  const beforeShot = grab();
  const beforeAnchor = anchorCarto();
  const before = {
    resolvedDatum: globe.water.ocean.resolvedVerticalDatum ?? null,
    geoidUndulationM: num(globe.water.ocean.geoidUndulationMeters),
    tideHeightM: num(globe.water.ocean.tideHeightMeters),
    anchorHeightM: num(globe.water.ocean.anchorHeightMeters),
    anchor: beforeAnchor,
    terrainRawHeightM: beforeAnchor
      ? await terrainRawAt(beforeAnchor.lonDeg, beforeAnchor.latDeg)
      : null,
  };

  // Restore.
  globe.water.ocean.verticalDatum = "AUTO";
  globe.water.ocean.tideEnabled = true;
  globe.water.ocean.enabled = false;

  const offset = (m) =>
    m && m.anchor && m.terrainRawHeightM !== null && m.anchor.heightM !== null
      ? m.terrainRawHeightM - m.anchor.heightM
      : null;

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    site,
    geoidWaitFrames: geoidWaited,
    before,
    after,
    offsets: {
      beforeOffsetM: offset(before),
      afterOffsetM: offset(after),
    },
    visual: {
      baselineLumDelta: meanAbsLum(off1.data, off2.data),
      meanAbsLumDelta: meanAbsLum(off2.data, on.data),
      frameSpan: frames.ocean,
      width: w,
      height: h,
      minLumDelta: thresholds.PATCH_VISIBLE_MIN_LUM_DELTA,
      baselineFactor: thresholds.PATCH_VISIBLE_BASELINE_FACTOR,
    },
    beforeDataUrl: beforeShot.dataUrl,
    afterDataUrl: on.dataUrl,
  };
};

const TIDE_LANE = async ({
  site,
  periodSite,
  ladderIso,
  ladder,
  phaseLock,
  m2,
  spring,
  frames,
}) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  if (!C.TideModel) {
    return {
      ok: false,
      structural: true,
      reason: "Cesium.TideModel is not exported — ruling T1 put it in Core",
    };
  }
  if (!globe.water || !globe.water.ocean) {
    return { ok: false, structural: true, reason: "ocean facade missing" };
  }

  const epoch = C.JulianDate.fromIso8601(ladderIso);
  const at = (s) => C.JulianDate.addSeconds(epoch, s, new C.JulianDate());

  scene.camera.setView({
    destination: C.Cartesian3.fromDegrees(site.lonDeg, site.latDeg, 600.0),
    orientation: { heading: 0.0, pitch: C.Math.toRadians(-35.0), roll: 0.0 },
  });
  globe.water.ocean.enabled = true;
  globe.water.ocean.tideEnabled = true;
  globe.water.ocean.tideExaggeration = 1.0;

  const settle = async (count, time) => {
    for (let i = 0; i < count; i++) {
      viewer.clock.currentTime = time;
      scene.render(time);
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  await settle(frames.settle, at(0));

  // ── the rendered ladder: pin -> render -> read, at every step ──
  //
  // The model MUST be evaluated at the UN-OFFSET anchor. `computeSeaLevelOffset`
  // runs BEFORE the anchor is displaced, so by the time this reads
  // `prim._anchor` the point has already moved along `_a0Up` by
  // `anchorHeightMeters` (about -27.6 m at this site, from the geoid term).
  // Feeding the displaced point back in changes r by that amount and shifts the
  // tide by ~9e-7 m — three orders of magnitude above the 1e-9 scene-clock-lock
  // tolerance — so the lane would fail deterministically at any GEOID site
  // while the engine is correct. The tolerance is NOT widened: its sharpness IS
  // the T6 assertion. Undoing the displacement is exact, because the
  // displacement is exactly `_a0Up * anchorHeightMeters`.
  const unOffsetAnchor = new C.Cartesian3();
  const modelSite = (prim, anchorHeightM) => {
    if (!prim || !prim._anchor) {
      return null;
    }
    if (!prim._a0Up || !isFinite(anchorHeightM) || anchorHeightM === 0) {
      return prim._anchor;
    }
    C.Cartesian3.multiplyByScalar(prim._a0Up, -anchorHeightM, unOffsetAnchor);
    return C.Cartesian3.add(prim._anchor, unOffsetAnchor, unOffsetAnchor);
  };

  const renderedSeries = [];
  const modelSeries = [];
  const anchorHeights = [];
  for (let k = 0; k < ladder.steps; k++) {
    const t = at(k * ladder.stepSeconds);
    await settle(frames.perLadderStep, t);
    const prim = globe.water.ocean.primitive;
    const anchorHeightM = num(globe.water.ocean.anchorHeightMeters);
    renderedSeries.push(num(globe.water.ocean.tideHeightMeters));
    anchorHeights.push(anchorHeightM);
    const site = modelSite(prim, anchorHeightM);
    modelSeries.push(site ? num(C.TideModel.equilibriumHeight(t, site)) : null);
  }

  // ── model-only ladders (no rendering): phase lock, M2 period, spring/neap ──
  const eq = C.Ellipsoid.WGS84.cartographicToCartesian(
    C.Cartographic.fromDegrees(periodSite.lonDeg, periodSite.latDeg, 0),
  );
  const eqDir = C.Cartesian3.normalize(eq, new C.Cartesian3());
  const result = C.TideModel.createResult();
  const moon = new C.Cartesian3();
  const sun = new C.Cartesian3();

  const refine = (a, b, c, index, dt) => {
    const denom = a - 2 * b + c;
    const delta = denom === 0 ? 0 : (a - c) / (2 * denom);
    const clamped = delta > 0.5 ? 0.5 : delta < -0.5 ? -0.5 : delta;
    return (index + clamped) * dt;
  };
  const maximaOf = (values, dt) => {
    const out = [];
    for (let i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i - 1] && values[i] >= values[i + 1]) {
        out.push(refine(values[i - 1], values[i], values[i + 1], i, dt));
      }
    }
    return out;
  };
  const extremaOf = (values, dt) => {
    const out = [];
    for (let i = 1; i < values.length - 1; i++) {
      const rising = values[i] > values[i - 1] && values[i] >= values[i + 1];
      const falling = values[i] < values[i - 1] && values[i] <= values[i + 1];
      if (rising || falling) {
        out.push(refine(values[i - 1], values[i], values[i + 1], i, dt));
      }
    }
    return out;
  };

  const nLock = Math.floor((phaseLock.hours * 3600) / phaseLock.stepSeconds);
  const lunar = [];
  const altitude = [];
  for (let i = 0; i < nLock; i++) {
    const t = at(i * phaseLock.stepSeconds);
    lunar.push(C.TideModel.evaluate(t, eq, result).lunarM);
    C.TideModel.computeMoonPositionFixed(t, moon);
    altitude.push(
      C.Cartesian3.dot(C.Cartesian3.normalize(moon, moon), eqDir),
    );
  }
  const lunarMax = maximaOf(lunar, phaseLock.stepSeconds);
  const culminations = extremaOf(altitude, phaseLock.stepSeconds);
  let lunarPhaseLockMaxMinutes = null;
  if (lunarMax.length > 0 && culminations.length > 0) {
    lunarPhaseLockMaxMinutes = 0;
    for (const tm of lunarMax) {
      let best = Infinity;
      for (const tc of culminations) {
        best = Math.min(best, Math.abs(tc - tm));
      }
      lunarPhaseLockMaxMinutes = Math.max(lunarPhaseLockMaxMinutes, best / 60);
    }
  }

  const nM2 = Math.floor((m2.days * 86400) / m2.stepSeconds);
  const m2Series = [];
  for (let i = 0; i < nM2; i++) {
    m2Series.push(
      C.TideModel.evaluate(at(i * m2.stepSeconds), eq, result).lunarM,
    );
  }
  const m2Maxima = maximaOf(m2Series, m2.stepSeconds);
  const meanM2IntervalHours =
    m2Maxima.length >= 2
      ? (m2Maxima[m2Maxima.length - 1] - m2Maxima[0]) /
        (m2Maxima.length - 1) /
        3600
      : null;

  const dailyRanges = [];
  const elongations = [];
  for (let d = 0; d < spring.days; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < spring.samplesPerDay; i++) {
      const v = C.TideModel.equilibriumHeight(
        at(d * 86400 + i * spring.stepSeconds),
        eq,
      );
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    dailyRanges.push(hi - lo);
    const noon = at(d * 86400 + 43200);
    C.TideModel.computeMoonPositionFixed(noon, moon);
    C.TideModel.computeSunPositionFixed(noon, sun);
    const c =
      C.Cartesian3.dot(moon, sun) /
      (C.Cartesian3.magnitude(moon) * C.Cartesian3.magnitude(sun));
    elongations.push(
      (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI,
    );
  }
  let springElongationMaxDeg = null;
  let neapElongationMaxDeg = null;
  const springDays = [];
  const neapDays = [];
  for (let i = 1; i < spring.days - 1; i++) {
    if (dailyRanges[i] > dailyRanges[i - 1] && dailyRanges[i] >= dailyRanges[i + 1]) {
      springDays.push(i);
      const e = elongations[i];
      springElongationMaxDeg = Math.max(
        springElongationMaxDeg ?? 0,
        Math.min(e, Math.abs(180 - e)),
      );
    }
    if (dailyRanges[i] < dailyRanges[i - 1] && dailyRanges[i] <= dailyRanges[i + 1]) {
      neapDays.push(i);
      neapElongationMaxDeg = Math.max(
        neapElongationMaxDeg ?? 0,
        Math.abs(elongations[i] - 90),
      );
    }
  }
  const springBeatDays =
    springDays.length >= 2
      ? (springDays[springDays.length - 1] - springDays[0]) /
        (springDays.length - 1)
      : null;

  globe.water.ocean.enabled = false;

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    site,
    periodSite,
    ladderIso,
    stepSeconds: ladder.stepSeconds,
    renderedSeries,
    modelSeries,
    anchorHeights,
    lunarPhaseLockMaxMinutes,
    lunarMaximaCount: lunarMax.length,
    meanM2IntervalHours,
    m2MaximaCount: m2Maxima.length,
    springDays,
    neapDays,
    springBeatDays,
    springElongationMaxDeg,
    neapElongationMaxDeg,
  };
};

const EXAG_LANE = async ({ site, dayIso, scale, frames }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const time = C.JulianDate.fromIso8601(dayIso);
  const settle = async (count) => {
    for (let i = 0; i < count; i++) {
      viewer.clock.currentTime = time; // re-pinned every frame
      scene.render(time);
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  if (!globe.water || !globe.water.ocean) {
    return { ok: false, structural: true, reason: "ocean facade missing" };
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
  scene.verticalExaggeration = 1.0;
  scene.verticalExaggerationRelativeHeight = 0.0;
  globe.water.ocean.enabled = true;
  await settle(frames.settle);

  // Bounded wait for the bundled grid BEFORE the first measurement. Without it
  // a fetch completing BETWEEN the scale-1.0 and scale-3.0 reads makes the
  // undulation change for a reason that has nothing to do with exaggeration
  // (spurious component-invariance failure), and a fetch that never completes
  // silently degrades this lane to a tide-only measurement that would still
  // "pass". Neither is a verdict, so both are structural.
  for (let i = 0; i < frames.geoidWaitMax; i++) {
    if (num(globe.water.ocean.geoidUndulationMeters) !== 0) {
      break;
    }
    viewer.clock.currentTime = time;
    scene.render(time);
    await new Promise((r) => requestAnimationFrame(r));
  }
  if (num(globe.water.ocean.geoidUndulationMeters) === 0) {
    globe.water.ocean.enabled = false;
    return {
      ok: false,
      structural: true,
      reason:
        "the bundled EGM2008 grid never produced a non-zero undulation before the exaggeration measurement — Assets/Geoid/egm2008-0p5deg.i16 did not load",
      rendererType: scene.context.rendererType,
    };
  }

  const anchorHeight1M = num(globe.water.ocean.anchorHeightMeters);
  const geoid1M = num(globe.water.ocean.geoidUndulationMeters);
  const tide1M = num(globe.water.ocean.tideHeightMeters);

  scene.verticalExaggeration = scale;
  await settle(frames.afterExagChange);
  const anchorHeightNM = num(globe.water.ocean.anchorHeightMeters);
  const geoidNM = num(globe.water.ocean.geoidUndulationMeters);
  const tideNM = num(globe.water.ocean.tideHeightMeters);

  scene.verticalExaggeration = 1.0;
  globe.water.ocean.enabled = false;

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    site,
    scale,
    relativeHeightM: 0.0,
    anchorHeight1M,
    anchorHeightNM,
    // The two component terms must be exaggeration-INVARIANT: the map is
    // applied to their sum, once, and never folded back into the components.
    geoid1M,
    geoidNM,
    tide1M,
    tideNM,
  };
};

const OFF_LANE = async ({ site, dayIso, frames }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;
  const globe = scene.globe;

  viewer.useDefaultRenderLoop = false;
  scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = false;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const time = C.JulianDate.fromIso8601(dayIso);
  const settle = async (count) => {
    for (let i = 0; i < count; i++) {
      viewer.clock.currentTime = time;
      scene.render(time);
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  if (!globe.water || !globe.water.ocean) {
    return { ok: false, structural: true, reason: "ocean facade missing" };
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
  scene.verticalExaggeration = 1.0;
  scene.verticalExaggerationRelativeHeight = 0.0;
  globe.water.ocean.enabled = true;
  await settle(frames.settle);

  // (1) tide off.
  globe.water.ocean.tideEnabled = false;
  await settle(frames.afterDatumChange);
  const tideOffMeters = num(globe.water.ocean.tideHeightMeters);

  // (2) a callback that returns 0.
  globe.water.ocean.tideEnabled = true;
  globe.water.ocean.tideCallback = () => 0;
  await settle(frames.afterDatumChange);
  const zeroCallbackMeters = num(globe.water.ocean.tideHeightMeters);

  // (3) ellipsoid datum.
  globe.water.ocean.tideCallback = undefined;
  globe.water.ocean.verticalDatum = "ELLIPSOID";
  await settle(frames.afterDatumChange);
  const ellipsoidUndulationMeters = num(globe.water.ocean.geoidUndulationMeters);

  // (4) both off -> the anchor must be back on the ellipsoid surface.
  globe.water.ocean.tideEnabled = false;
  await settle(frames.afterDatumChange);
  const identityAnchorMeters = num(globe.water.ocean.anchorHeightMeters);
  const prim = globe.water.ocean.primitive;
  let identityAnchorGeodeticHeightM = null;
  if (prim && prim._anchor) {
    const g = C.Cartographic.fromCartesian(prim._anchor, C.Ellipsoid.WGS84);
    identityAnchorGeodeticHeightM = g ? num(g.height) : null;
  }

  // Restore.
  globe.water.ocean.verticalDatum = "AUTO";
  globe.water.ocean.tideEnabled = true;
  globe.water.ocean.enabled = false;

  return {
    ok: true,
    structural: false,
    rendererType: scene.context.rendererType,
    tideOffMeters,
    zeroCallbackMeters,
    ellipsoidUndulationMeters,
    identityAnchorMeters,
    identityAnchorGeodeticHeightM,
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

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let laneA;
  let laneB;
  let laneC;
  let laneD;
  try {
    laneA = await runLane(browser, "datum-fix", DATUM_LANE, {
      site: { ...DATUM_FIX_SITE },
      dayIso: DAY_ISO,
      frames: { ...FRAMES },
      thresholds: { ...THRESHOLDS },
      timeoutMs: IN_PAGE_TIMEOUT_MS,
    });
    laneB = await runLane(browser, "tide-phase", TIDE_LANE, {
      site: { ...TIDE_PHASE_SITE },
      periodSite: { ...TIDE_PERIOD_SITE },
      ladderIso: LADDER_ISO,
      ladder: { ...LADDER },
      phaseLock: { ...PHASE_LOCK },
      m2: { ...M2_LADDER },
      spring: { ...SPRING_LADDER },
      frames: { ...FRAMES },
    });
    laneC = await runLane(browser, "exaggeration-composition", EXAG_LANE, {
      site: { ...DATUM_FIX_SITE },
      dayIso: DAY_ISO,
      scale: EXAG_SCALE,
      frames: { ...FRAMES },
    });
    laneD = await runLane(browser, "off-contract", OFF_LANE, {
      site: { ...DATUM_FIX_SITE },
      dayIso: DAY_ISO,
      frames: { ...FRAMES },
    });
  } finally {
    await browser.close().catch(() => {});
  }

  const pngs = {};
  if (laneA && laneA.ok) {
    pngs.datumBefore = writePng(
      laneA.beforeDataUrl,
      "ocean-tide-datum-before.png",
    );
    pngs.datumAfter = writePng(laneA.afterDataUrl, "ocean-tide-datum-after.png");
    delete laneA.beforeDataUrl;
    delete laneA.afterDataUrl;
  }

  // ── structural gates (exit 2) ──
  const structuralFailures = [];
  for (const lane of [laneA, laneB, laneC, laneD]) {
    if (!lane || !lane.ok) {
      structuralFailures.push(
        `${lane ? lane.label : "?"}: ${lane ? (lane.reason ?? "lane failed") : "lane missing"}`,
      );
    }
  }
  const rendererActual =
    [laneA, laneB, laneC, laneD].map((l) => l && l.rendererType).find(Boolean) ??
    null;
  if (rendererActual && rendererActual !== RENDERER) {
    structuralFailures.push(
      `backend fell back: rendererType "${rendererActual}" !== requested "${RENDERER}"`,
    );
  }

  // ── verdicts ──
  const patchVisible =
    laneA && laneA.ok && laneA.visual
      ? laneA.visual.meanAbsLumDelta >=
        Math.max(
          THRESHOLDS.PATCH_VISIBLE_MIN_LUM_DELTA,
          (laneA.visual.baselineLumDelta ?? 0) *
            THRESHOLDS.PATCH_VISIBLE_BASELINE_FACTOR,
        )
      : null;

  const datumFix =
    laneA && laneA.ok
      ? datumFixVerdict({
          beforeOffsetM: laneA.offsets.beforeOffsetM,
          afterOffsetM: laneA.offsets.afterOffsetM,
          resolvedDatum: laneA.after.resolvedDatum,
          geoidUndulationM: laneA.after.geoidUndulationM,
          patchVisible,
        })
      : { verdict: "INDETERMINATE", reasons: ["lane (a) did not run"] };

  const tidePhase =
    laneB && laneB.ok
      ? tidePhaseVerdict({
          renderedSeries: laneB.renderedSeries,
          modelSeries: laneB.modelSeries,
          dtSeconds: laneB.stepSeconds,
          lunarPhaseLockMaxMinutes: laneB.lunarPhaseLockMaxMinutes,
          meanM2IntervalHours: laneB.meanM2IntervalHours,
          springElongationMaxDeg: laneB.springElongationMaxDeg,
          neapElongationMaxDeg: laneB.neapElongationMaxDeg,
        })
      : { verdict: "INDETERMINATE", reasons: ["lane (b) did not run"] };

  const exaggeration =
    laneC && laneC.ok
      ? exaggerationCompositionVerdict({
          anchorHeight1M: laneC.anchorHeight1M,
          anchorHeightNM: laneC.anchorHeightNM,
          scale: laneC.scale,
          relativeHeightM: laneC.relativeHeightM,
          geoid1M: laneC.geoid1M,
          geoidNM: laneC.geoidNM,
          tide1M: laneC.tide1M,
          tideNM: laneC.tideNM,
        })
      : { verdict: "INDETERMINATE", reasons: ["lane (c) did not run"] };

  const offContract =
    laneD && laneD.ok
      ? offContractVerdict({
          tideOffMeters: laneD.tideOffMeters,
          zeroCallbackMeters: laneD.zeroCallbackMeters,
          ellipsoidUndulationMeters: laneD.ellipsoidUndulationMeters,
          identityAnchorMeters: laneD.identityAnchorMeters,
          identityAnchorGeodeticHeightM: laneD.identityAnchorGeodeticHeightM,
        })
      : { verdict: "INDETERMINATE", reasons: ["lane (d) did not run"] };

  const decision = decisionFromLanes({
    datumFix,
    tidePhase,
    exaggeration,
    offContract,
  });
  const exitCode = structuralFailures.length ? 2 : decision.exitCode;

  const manifest = {
    probe: "probe-ocean-tide-datum",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    base: BASE,
    watchdogMs: HARD_LIMIT_MS,
    clockIso: DAY_ISO,
    ladderIso: LADDER_ISO,
    environment: {
      browserChannel: "msedge",
      headless: true,
      viewport: VIEWPORT,
      rendererRequested: RENDERER,
      rendererActual,
    },
    publishedConstants: PUBLISHED_CONSTANTS,
    thresholds: THRESHOLDS,
    laneA_datumFix: laneA ?? null,
    laneB_tidePhase: laneB ?? null,
    laneC_exaggeration: laneC ?? null,
    laneD_offContract: laneD ?? null,
    pngs,
    verdicts: { datumFix, tidePhase, exaggeration, offContract },
    decision: { ...decision, structuralFailures, exitCode },
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`[probe-ocean-tide-datum] manifest -> ${MANIFEST}`);
  if (pngs.datumBefore) {
    console.log(`  before: ${pngs.datumBefore}`);
    console.log(`  after:  ${pngs.datumAfter}`);
  }
  console.log(
    `  (a) datum fix   : ${datumFix.verdict}` +
      (laneA && laneA.ok
        ? ` (before ${laneA.offsets.beforeOffsetM?.toFixed(2)} m -> after ${laneA.offsets.afterOffsetM?.toFixed(2)} m)`
        : ""),
  );
  console.log(
    `  (b) tide phase  : ${tidePhase.verdict}` +
      (tidePhase.rangeM !== undefined && tidePhase.rangeM !== null
        ? ` (range ${tidePhase.rangeM.toFixed(3)} m, mean period ${tidePhase.meanM2IntervalHours?.toFixed(4)} h vs M2 ${tidePhase.m2PublishedHours?.toFixed(4)} h)`
        : ""),
  );
  console.log(`  (c) exaggeration: ${exaggeration.verdict}`);
  console.log(`  (d) off-contract: ${offContract.verdict}`);
  for (const f of structuralFailures) {
    console.error(`  STRUCTURAL: ${f}`);
  }
  for (const f of decision.failures) {
    console.error(`  FAIL: ${f}`);
  }
  console.log(`  GATE: ${decision.GATE}`);
  process.exit(exitCode);
})();
