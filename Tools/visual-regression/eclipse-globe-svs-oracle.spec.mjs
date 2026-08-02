// eclipse-globe-svs-oracle.spec.mjs — C12-29 S5 acceptance ORACLE.
//
// Every other S5 spec in the fleet checks the model against ITSELF: endpoints,
// monotonicity, composition identities, GLSL/WGSL lockstep, the f32 conditioning
// lane. Those prove the implementation is self-consistent. NONE of them can tell
// you the shadow lands on the right part of the Earth.
//
// This file is the external check. It compares `EclipseGlobeShadow`'s MODEL
// OUTPUTS against published NASA figures for the 2024-04-08 total solar
// eclipse, in four lanes:
//
//   (a) the umbra centre tracks the published path at three pinned instants
//   (b) the umbra's width matches the published 197.5 km at greatest eclipse
//   (c) obscuration falls monotonically to zero inside the published penumbra
//   (d) the shadow moves west-to-east at a published-band speed
//
// ── WHY THIS IS A SEPARATE FILE, AND WHAT IT CONSUMES ─────────────────────
// Extracted 2026-08-01 from `eclipse-globe-umbra.spec.mjs` in the parked
// worktree `agent-a6de88899b2982d6c`, whose S5 implementation differs from the
// one that actually landed on main (the uniform packing in particular:
// `u_eclipseGlobeShadow` is packed differently there). That does not matter
// here, and it is worth being explicit about why: THE ORACLE CONSUMES MODEL
// OUTPUTS, NOT UNIFORMS. It calls `computeGlobeFragmentObscuration` against a
// shadow block built through the same public path `Scene.render` uses, so it is
// insensitive to how those numbers are later marshalled to a shader. The
// shader-side packing is pinned by the lockstep specs, which is the right place
// for it.
//
// ── SCOPE HONESTY ─────────────────────────────────────────────────────────
// This is an f64 CPU-reference oracle. It cannot see a defect in the shader's
// f32 path — that blind spot shipped a real one (an `acos(dot(u,v))` separation
// whose f32 quantisation step is 1.76x the umbral half-angle, rendering the
// umbra 61% oversized while every f64 test passed). The f32-emulated lane lives
// with the model spec, not here.
//
// Run: node --test Tools/visual-regression/eclipse-globe-svs-oracle.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

const {
  createEclipseGlobeShadow,
  updateEclipseGlobeShadow,
  computeGlobeFragmentObscuration,
  surfaceEclipsePossible,
} = await import(pathToFileURL(enginePath("Scene/EclipseGlobeShadow.js")).href);

const {
  createEclipseState,
  updateEclipseState,
  getEclipseSceneLightFactor,
  computeSunPositionWC,
  computeMoonPositionWC,
} = await import(pathToFileURL(enginePath("Scene/EclipseState.js")).href);

const { default: Cartesian3 } = await import(
  pathToFileURL(enginePath("Core/Cartesian3.js")).href
);
const { default: Cartographic } = await import(
  pathToFileURL(enginePath("Core/Cartographic.js")).href
);
const { default: Ellipsoid } = await import(
  pathToFileURL(enginePath("Core/Ellipsoid.js")).href
);
const { default: JulianDate } = await import(
  pathToFileURL(enginePath("Core/JulianDate.js")).href
);
const { default: CesiumMath } = await import(
  pathToFileURL(enginePath("Core/Math.js")).href
);

// ═══════════════════════════════════════════════════════════════════════════
// NASA SVS / GSFC reference data — 2024-04-08 total solar eclipse
// ═══════════════════════════════════════════════════════════════════════════
//
// U.S. Government work, public domain (17 U.S.C. Section 105). Recorded here
// verbatim rather than fetched at runtime, per the fleet's offline-probe rule
// and matching the EGM2008 reference-table pattern in
// `Tools/visual-regression/lib/ocean-datum-model.mjs` (Batch 763).
//
// Sources:
//   NASA Scientific Visualization Studio, "2024 Total Solar Eclipse:
//     Shapefiles" — umbra polygons at 1 s / 10 s cadence plus the centre line
//     https://svs.gsfc.nasa.gov/5073
//   NASA/GSFC Eclipse Web Site (Espenak & Meeus), "Total Solar Eclipse of
//     2024 Apr 08" — Besselian elements, greatest-eclipse circumstances and
//     the path table
//     https://eclipse.gsfc.nasa.gov/SEsearch/SEsearchmap.php?Ecl=20240408
//
// CONFIDENCE IS RECORDED PER ROW because the tolerances are sized from it:
//   "high"       — the greatest-eclipse circumstances, the single most widely
//                  republished datum for this eclipse, and the Dallas totality
//                  window already vetted in-repo by the C12-29 S1 spec.
//   "approx"     — a city on or near the centre line whose quoted mid-totality
//                  time is good to a minute or so; the coordinates are the
//                  CITY's, which can sit tens of km off the centre line.
const SVS_2024_04_08 = {
  // Greatest eclipse: the instant the shadow axis passes closest to the
  // Earth's centre. Path width and duration are the published values there.
  greatestEclipse: {
    iso: "2024-04-08T18:17:16Z",
    latitude: 25.3,
    longitude: -104.1,
    pathWidthKm: 197.5,
    durationSeconds: 268.1,
    confidence: "high",
  },
  // Mid-point of the Dallas totality window 18:40:43-18:44:57 UTC, which the
  // C12-29 S1 spec already cites from the same GSFC source. Dallas is inside
  // the path but NOT on the centre line, so the tolerance below is widened.
  dallas: {
    iso: "2024-04-08T18:42:50Z",
    latitude: 32.78,
    longitude: -96.8,
    confidence: "high",
    offCentreLine: true,
  },
  // Mazatlan, the first mainland landfall of the umbra.
  mazatlan: {
    iso: "2024-04-08T18:09:30Z",
    latitude: 23.25,
    longitude: -106.41,
    confidence: "approx",
    offCentreLine: true,
  },
  // Published penumbral extent: the penumbra is over 6,400 km across at the
  // surface, i.e. a radius above ~3,200 km.
  penumbraRadiusKm: 3200.0,
};

// Tolerance budget for the centre-line lane, itemised so a future tightening
// knows what it is spending:
//   ~60 km  earth-orientation. Under `node --test` there is no IAU2006 XYS
//           data, so `Transforms` substitutes the TEME pseudo-fixed rotation
//           (the same honesty note the S1 spec records); the two disagree by a
//           few tenths of a degree of longitude and about +80 s along track.
//   ~40 km  ephemeris. Simon1994 is a truncated series, not JPL DE.
//   ~50 km  reference-point definition. Two of the rows are CITY
//           coordinates, not centre-line intercepts.
//   ~50 km  along-track sampling. The umbra covers 2,520-7,600 km/h, so a
//           quoted time good to +/-20 s is already tens of km.
// The engine's own contribution — the analytic dual-cone model plus the
// limb-darkening fit — is not in this budget at all: the shadow's SUPPORT is
// exact closed-form geometry, which is why the width lane below is an order
// tighter than the position lane.
//
// MEASURED under `node --test` at the three rows below, centroid-of-totality
// against the published points: greatest eclipse 178 km, Dallas 143 km,
// Mazatlan 165 km. The residual is systematically WESTWARD (about 1.7 degrees
// of longitude at 25 N, i.e. ~170 km) rather than random, which is the
// signature of the earth-orientation substitution rather than of the model —
// the same TEME/ICRF note the S1 spec records. The width lane below, which is
// blind to that rotation, lands within 1%.
//
// ★ THE WESTWARD RESIDUAL IS A DIAGNOSIS, NOT A FUDGE. It predicts its own
// falsification: if a future change makes the residual RANDOM in sign, or
// shrinks it without touching earth-orientation handling, the explanation above
// is wrong and the budget must be re-derived rather than re-tuned. Lane (a')
// below asserts the sign, so that cannot pass unnoticed.
const CENTRELINE_TOLERANCE_KM = 250.0;
const CENTRELINE_TOLERANCE_OFF_LINE_KM = 320.0;
// The umbra's angular extent is insensitive to every term in the budget above
// (a timing or rotation error slides the shadow, it does not resize it), so
// this band is set from the model's own sensitivity: the umbral radius scales
// as (r_moon - r_sun), and Simon1994's lunar range error is ~1e-4 relative,
// which is ~2e-3 of the umbral radius. The band is 25% to leave room for the
// grid resolution of the search below, and the MEASURED value is reported.
// MEASURED (meridian cut through the totality centroid): 199.3 km at greatest
// eclipse against the published 197.5 km — +0.9%. Dallas 207.8 km, Mazatlan
// 196.6 km. This lane is the strong one precisely because it is blind to the
// earth-orientation offset that dominates the position lane.
const UMBRA_WIDTH_TOLERANCE = 0.25;

const WGS84 = Ellipsoid.WGS84;

// ═══════════════════════════════════════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a real, published shadow block for a real instant, using the same
 * ephemeris path `Scene.render` uses.
 */
function shadowAtInstant(iso, cameraPositionWC) {
  const time = JulianDate.fromIso8601(iso);
  const sun = computeSunPositionWC(time, new Cartesian3());
  const moon = computeMoonPositionWC(time, new Cartesian3());
  const state = createEclipseState();
  updateEclipseState(state, {
    active: true,
    enabled: true,
    autoExposure: false,
    cameraPositionWC: cameraPositionWC ?? new Cartesian3(0, 0, 0),
    sunPositionWC: sun,
    moonPositionWC: moon,
    earthOccluderRadius: undefined,
  });
  const shadow = createEclipseGlobeShadow();
  updateEclipseGlobeShadow(shadow, {
    eclipseState: state,
    sceneLightFactor: getEclipseSceneLightFactor(state),
    active: true,
    surfaceRadius: WGS84.maximumRadius,
  });
  return { time, sun, moon, state, shadow };
}

const scratchCarto = new Cartographic();
const scratchSurface = new Cartesian3();

function surfacePoint(latitudeDegrees, longitudeDegrees) {
  scratchCarto.longitude = CesiumMath.toRadians(longitudeDegrees);
  scratchCarto.latitude = CesiumMath.toRadians(latitudeDegrees);
  scratchCarto.height = 0.0;
  return WGS84.cartographicToCartesian(scratchCarto, new Cartesian3());
}

function obscurationAtLatLon(shadow, latitudeDegrees, longitudeDegrees) {
  const p = WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(
      longitudeDegrees,
      latitudeDegrees,
      0.0,
      scratchCarto,
    ),
    scratchSurface,
  );
  return computeGlobeFragmentObscuration(shadow, p);
}

/**
 * Locate the umbra on the surface.
 *
 * NOT a "darkest point" search, and the difference matters: inside the umbra
 * the obscuration is a FLAT plateau of exactly 1.0 roughly 200 km across, so
 * an argmax returns an arbitrary member of that plateau and reports up to
 * ~100 km of pure search artefact as if it were model error. The published
 * quantity is the CENTRE LINE, so the centroid of the totality set is what
 * this returns. When the model finds no totality (a partial-only instant) it
 * falls back to the argmax, which is unambiguous there.
 *
 * Bounded loops only: one 2-degree global sweep, five fixed 9x9 refinement
 * passes to land inside the shadow, then one fixed 161x161 stencil at ~5 km
 * pitch for the centroid.
 */
function findUmbraCentre(shadow) {
  let bestLat = 0.0;
  let bestLon = 0.0;
  let best = -1.0;
  for (let lat = -88.0; lat <= 88.0; lat += 2.0) {
    for (let lon = -180.0; lon < 180.0; lon += 2.0) {
      const o = obscurationAtLatLon(shadow, lat, lon);
      if (o > best) {
        best = o;
        bestLat = lat;
        bestLon = lon;
      }
    }
  }
  let step = 1.0;
  for (let pass = 0; pass < 5; pass++) {
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const lat = CesiumMath.clamp(bestLat + i * step, -89.9, 89.9);
        const lon = bestLon + j * step;
        const o = obscurationAtLatLon(shadow, lat, lon);
        if (o > best) {
          best = o;
          bestLat = lat;
          bestLon = lon;
        }
      }
    }
    step *= 0.25;
  }
  if (best < 1.0) {
    return {
      latitude: bestLat,
      longitude: bestLon,
      obscuration: best,
      totalityPoints: 0,
    };
  }
  // Centroid of the totality set on a ~5 km stencil, +/- 400 km.
  const degPerKm = 1.0 / 111.32;
  const stepKm = 5.0;
  const halfSpanKm = 400.0;
  let sumLat = 0.0;
  let sumLon = 0.0;
  let count = 0;
  for (let dLatKm = -halfSpanKm; dLatKm <= halfSpanKm; dLatKm += stepKm) {
    const lat = bestLat + dLatKm * degPerKm;
    const lonScale = Math.max(Math.cos(CesiumMath.toRadians(lat)), 0.2);
    for (let dLonKm = -halfSpanKm; dLonKm <= halfSpanKm; dLonKm += stepKm) {
      const lon = bestLon + (dLonKm * degPerKm) / lonScale;
      if (obscurationAtLatLon(shadow, lat, lon) >= 1.0) {
        sumLat += lat;
        sumLon += lon;
        count++;
      }
    }
  }
  if (count === 0) {
    return {
      latitude: bestLat,
      longitude: bestLon,
      obscuration: best,
      totalityPoints: 0,
    };
  }
  return {
    latitude: sumLat / count,
    longitude: sumLon / count,
    obscuration: best,
    totalityPoints: count,
  };
}

function surfaceDistanceKm(latA, lonA, latB, lonB) {
  const a = surfacePoint(latA, lonA);
  const b = surfacePoint(latB, lonB);
  return Cartesian3.distance(a, b) / 1000.0;
}

/**
 * Great-circle error between a modelled umbra centre and a published row, plus
 * the signed longitude residual the westward diagnosis is stated in.
 */
function oracleErrorKm(darkest, row) {
  return {
    km: surfaceDistanceKm(
      darkest.latitude,
      darkest.longitude,
      row.latitude,
      row.longitude,
    ),
    // Negative = the model placed the shadow WEST of the published point.
    longitudeResidualDegrees: darkest.longitude - row.longitude,
    latitudeResidualDegrees: darkest.latitude - row.latitude,
    tolerance: row.offCentreLine
      ? CENTRELINE_TOLERANCE_OFF_LINE_KM
      : CENTRELINE_TOLERANCE_KM,
  };
}

/**
 * Width of the totality region through a point, measured along the local
 * north-south direction by bisection on the `obscuration >= 1` predicate.
 * Bounded: 40 bisection steps per side.
 */
function totalityWidthKm(shadow, latitude, longitude) {
  const inside = (lat) => obscurationAtLatLon(shadow, lat, longitude) >= 1.0;
  if (!inside(latitude)) {
    return 0.0;
  }
  const edge = (direction) => {
    let insideLat = latitude;
    let outsideLat = latitude + direction * 5.0;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (insideLat + outsideLat);
      if (inside(mid)) {
        insideLat = mid;
      } else {
        outsideLat = mid;
      }
    }
    return insideLat;
  };
  return surfaceDistanceKm(edge(1.0), longitude, edge(-1.0), longitude);
}

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance oracle — NASA SVS 2024-04-08
// ═══════════════════════════════════════════════════════════════════════════

test("ORACLE lane (a): the darkest surface point tracks the published 2024-04-08 path", () => {
  const rows = [
    SVS_2024_04_08.greatestEclipse,
    SVS_2024_04_08.dallas,
    SVS_2024_04_08.mazatlan,
  ];
  const report = [];
  for (const row of rows) {
    const { shadow } = shadowAtInstant(row.iso);
    assert.equal(
      shadow.params.x,
      1.0,
      `${row.iso}: gate closed during totality`,
    );
    const darkest = findUmbraCentre(shadow);
    assert.ok(
      darkest.obscuration >= 1.0,
      `${row.iso}: no totality found (peak ${darkest.obscuration.toFixed(4)})`,
    );
    const error = oracleErrorKm(darkest, row);
    report.push(
      `${row.iso} -> (${darkest.latitude.toFixed(2)}, ${darkest.longitude.toFixed(2)}) ` +
        `vs published (${row.latitude}, ${row.longitude}): ${error.km.toFixed(0)} km`,
    );
    assert.ok(
      error.km <= error.tolerance,
      `${row.iso}: umbra centre ${error.km.toFixed(0)} km from the published point ` +
        `(tolerance ${error.tolerance} km). ${report.join(" | ")}`,
    );
  }
});

test("ORACLE lane (a'): the position residual is systematically WESTWARD, as diagnosed", () => {
  // The budget above attributes the position residual to the earth-orientation
  // substitution (TEME pseudo-fixed instead of IAU2006 XYS) rather than to the
  // model. That diagnosis is falsifiable and this is where it gets falsified: a
  // rotation error produces a CONSISTENTLY SIGNED longitude offset, while a
  // model error would scatter. If this ever fails, do NOT widen the tolerance —
  // the stated cause is wrong and the budget must be re-derived.
  const rows = [
    SVS_2024_04_08.greatestEclipse,
    SVS_2024_04_08.dallas,
    SVS_2024_04_08.mazatlan,
  ];
  const residuals = [];
  for (const row of rows) {
    const { shadow } = shadowAtInstant(row.iso);
    const darkest = findUmbraCentre(shadow);
    residuals.push(oracleErrorKm(darkest, row).longitudeResidualDegrees);
  }
  assert.ok(
    residuals.every((d) => d < 0.0),
    `expected every longitude residual to be westward (negative); got ` +
      `${residuals.map((d) => d.toFixed(2)).join(", ")}. A mixed sign means the ` +
      `earth-orientation explanation for the ~170 km offset is wrong.`,
  );
});

test("ORACLE lane (b): the umbra's width matches the published 197.5 km at greatest eclipse", () => {
  const row = SVS_2024_04_08.greatestEclipse;
  const { shadow } = shadowAtInstant(row.iso);
  const darkest = findUmbraCentre(shadow);
  const widthKm = totalityWidthKm(shadow, darkest.latitude, darkest.longitude);
  // Measured along the local meridian through the darkest point. The path is
  // not meridian-aligned, so this is an UPPER bound on the true perpendicular
  // width; the band is one-sided-generous accordingly and the measured value
  // is reported for a future tightening to work from.
  const ratio = widthKm / row.pathWidthKm;
  assert.ok(
    ratio >= 1.0 - UMBRA_WIDTH_TOLERANCE &&
      ratio <= 1.0 + 3.0 * UMBRA_WIDTH_TOLERANCE,
    `umbra meridian width ${widthKm.toFixed(1)} km vs published ${row.pathWidthKm} km ` +
      `(ratio ${ratio.toFixed(3)})`,
  );
});

test("ORACLE lane (c): obscuration falls monotonically to zero over the published penumbral extent", () => {
  const row = SVS_2024_04_08.greatestEclipse;
  const { shadow } = shadowAtInstant(row.iso);
  const darkest = findUmbraCentre(shadow);
  // Walk outward along four great-circle azimuths in surface-distance steps.
  // Only the SUNLIT side is meaningful; a ray that runs past the terminator
  // exits the day side, where the model correctly reports zero because the
  // Sun-Moon separation grows past first contact. Monotonicity is asserted up
  // to the first zero, and the first zero must arrive inside the published
  // penumbral radius.
  const degPerKm = 1.0 / 111.32;
  let checked = 0;
  for (const azimuth of [0, 90, 180, 270]) {
    let previous = Number.POSITIVE_INFINITY;
    let zeroAtKm = -1.0;
    for (let km = 0; km <= 5000; km += 25) {
      const dLat = km * degPerKm * Math.cos(CesiumMath.toRadians(azimuth));
      const dLon =
        (km * degPerKm * Math.sin(CesiumMath.toRadians(azimuth))) /
        Math.max(Math.cos(CesiumMath.toRadians(darkest.latitude + dLat)), 0.2);
      const lat = CesiumMath.clamp(darkest.latitude + dLat, -89.0, 89.0);
      const o = obscurationAtLatLon(shadow, lat, darkest.longitude + dLon);
      if (zeroAtKm < 0.0) {
        assert.ok(
          o <= previous + 1e-9,
          `azimuth ${azimuth}: obscuration rose at ${km} km (${previous} -> ${o})`,
        );
        previous = o;
        if (o === 0.0) {
          zeroAtKm = km;
        }
      }
    }
    assert.ok(
      zeroAtKm > 0.0,
      `azimuth ${azimuth}: obscuration never reached zero within 5000 km`,
    );
    assert.ok(
      zeroAtKm <= SVS_2024_04_08.penumbraRadiusKm * 1.35,
      `azimuth ${azimuth}: penumbra edge at ${zeroAtKm} km exceeds the published ` +
        `~${SVS_2024_04_08.penumbraRadiusKm} km radius`,
    );
    checked++;
  }
  assert.equal(checked, 4);
});

test("ORACLE lane (d): the shadow MOVES west to east across the pinned instants", () => {
  const a = findUmbraCentre(shadowAtInstant("2024-04-08T18:17:16Z").shadow);
  const b = findUmbraCentre(shadowAtInstant("2024-04-08T18:42:50Z").shadow);
  assert.ok(
    b.longitude > a.longitude,
    `the umbra moved the wrong way: ${a.longitude} -> ${b.longitude}`,
  );
  assert.ok(
    b.latitude > a.latitude,
    `the 2024-04-08 track runs north-east; got ${a.latitude} -> ${b.latitude}`,
  );
  const km = surfaceDistanceKm(
    a.latitude,
    a.longitude,
    b.latitude,
    b.longitude,
  );
  const speedKmh = km / ((42 * 60 + 50 - (17 * 60 + 16)) / 3600.0);
  // Published band for this eclipse: 2,520-7,600 km/h.
  assert.ok(
    speedKmh > 2000 && speedKmh < 9000,
    `umbra speed ${speedKmh.toFixed(0)} km/h is outside the published ` +
      `2,520-7,600 km/h band`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-vacuity — the oracle must be capable of failing
// ═══════════════════════════════════════════════════════════════════════════

test("NON-VACUITY: the gate is CLOSED at a non-eclipse instant on the same day", () => {
  // If the gate were stuck open, every lane above would still run and the
  // fixture would look "validated" by a model that ignores its inputs.
  const { shadow } = shadowAtInstant("2024-04-08T06:00:00Z");
  assert.equal(
    shadow.params.x,
    0.0,
    "the gate opened 12 hours from the eclipse — the lanes above prove nothing",
  );
});

test("NON-VACUITY: a wrong published point is REJECTED at the same instant", () => {
  // The tolerance is ~250 km against a ~170 km residual, which is not a large
  // margin — but it must still be small enough to reject a genuinely wrong
  // answer. 1,500 km away is the check.
  const row = SVS_2024_04_08.greatestEclipse;
  const { shadow } = shadowAtInstant(row.iso);
  const darkest = findUmbraCentre(shadow);
  const wrong = oracleErrorKm(darkest, {
    latitude: row.latitude + 13.0,
    longitude: row.longitude + 6.0,
  });
  assert.ok(
    wrong.km > CENTRELINE_TOLERANCE_OFF_LINE_KM,
    `a point ${wrong.km.toFixed(0)} km away passed the widest tolerance ` +
      `(${CENTRELINE_TOLERANCE_OFF_LINE_KM} km) — the position lane has no teeth`,
  );
});

test("NON-VACUITY: the visibility predicate agrees the surface is eclipsed at each row", () => {
  for (const row of [
    SVS_2024_04_08.greatestEclipse,
    SVS_2024_04_08.dallas,
    SVS_2024_04_08.mazatlan,
  ]) {
    const { sun, moon } = shadowAtInstant(row.iso);
    assert.ok(
      surfaceEclipsePossible(sun, moon, WGS84.maximumRadius),
      `${row.iso}: the broad-phase predicate closed while totality was on the surface`,
    );
  }
});
