// eclipse-state.spec.mjs — C12-29 S1: pins the limb-darkened dual-cone
// obscuration math, the `frameState.eclipseState` publication contract, the
// off-toggle identity, and the presence of the alpha fade on BOTH backends.
//
// These tests fail if:
//   - the circle-overlap math loses its exact endpoints (disjoint == full
//     sun, umbra == zero sun) or its clamp guards, both of which produce NaN
//     lighting for a whole frame when they drift;
//   - limb darkening is dropped (a uniform disc over-predicts the surviving
//     flux by ~2x near second/third contact — ACP 19:4703);
//   - a real eclipse stops reproducing (2024-04-08 from Dallas: our
//     ephemeris must reach totality inside the published totality window and
//     must be exactly zero outside the published partial window);
//   - either backend loses the alpha multiply the other keeps (the
//     C11-176/C12 exit-gate class: a default-ON celestial multiplier must
//     never be single-backend);
//   - the off-toggle stops being the exact multiplicative identity;
//   - the legacy binary cull line in Scene.js is disturbed (the off position
//     is byte-identical only because that line is untouched);
//   - a new ShaderDefine bit is introduced (the registry is exhausted — C12
//     exit-gate item 5, all-runtime-uniforms);
//   - the WebGPU sun shader stops validating under naga.
//
// Run: node --test Tools/visual-regression/eclipse-state.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");

const {
  computeSolarObscuration,
  computeUniformObscuration,
  computeEclipseMagnitude,
  LIMB_DARKENING_A0,
  LIMB_DARKENING_A1,
  LIMB_DARKENING_A2,
} = await import(
  pathToFileURL(enginePath("Scene/computeSolarObscuration.js")).href
);

const { createEclipseState, updateEclipseState, getEclipseSunFactor, computeSunPositionWC } =
  await import(pathToFileURL(enginePath("Scene/EclipseState.js")).href);

const { default: Cartesian3 } = await import(
  pathToFileURL(enginePath("Core/Cartesian3.js")).href
);
const { default: JulianDate } = await import(
  pathToFileURL(enginePath("Core/JulianDate.js")).href
);
const { default: Ellipsoid } = await import(
  pathToFileURL(enginePath("Core/Ellipsoid.js")).href
);
const { default: Matrix3 } = await import(
  pathToFileURL(enginePath("Core/Matrix3.js")).href
);
// Same module instance EclipseState.js resolves — patching a method here is
// visible to it, which is how the ICRF-availability transition is simulated.
const { default: Transforms } = await import(
  pathToFileURL(enginePath("Core/Transforms.js")).href
);

// Angular radius of the sun at 1 AU, the working scale for every geometry
// test below.
const RS = 0.004650;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The overlap math
// ─────────────────────────────────────────────────────────────────────────────

test("limb-darkening law is normalised to 1.0 at disc centre", () => {
  assert.equal(
    LIMB_DARKENING_A0 + LIMB_DARKENING_A1 + LIMB_DARKENING_A2,
    1.0,
    "I(mu=1) must be exactly 1 — the C12-15 coefficients",
  );
  // The Waldmeier-era parameterisations this replaces are up to 37% wrong;
  // pin the ratified triple so a 'tidy-up' cannot silently swap them.
  assert.equal(LIMB_DARKENING_A0, 0.3);
  assert.equal(LIMB_DARKENING_A1, 0.93);
  assert.equal(LIMB_DARKENING_A2, -0.23);
});

test("disjoint discs obscure exactly nothing", () => {
  assert.equal(computeSolarObscuration(RS, RS, 2.0 * RS), 0.0);
  assert.equal(computeSolarObscuration(RS, RS, 10.0 * RS), 0.0);
  // Exactly at external tangency the obscuration must be exactly 0, not a
  // tiny positive number: this is where the renderer's "nothing happening"
  // fast path lives.
  assert.equal(computeSolarObscuration(RS, 0.5 * RS, 1.5 * RS), 0.0);
});

test("concentric total eclipse obscures exactly everything", () => {
  // Equal discs, concentric.
  assert.equal(computeSolarObscuration(RS, RS, 0.0), 1.0);
  // Larger occluder — the umbra branch.
  assert.equal(computeSolarObscuration(RS, 1.05 * RS, 0.0), 1.0);
  // Larger occluder, off-centre but still swallowing the sun.
  assert.equal(computeSolarObscuration(RS, 1.2 * RS, 0.15 * RS), 1.0);
  // Exactly at internal tangency (d + rs === ro).
  assert.equal(computeSolarObscuration(RS, 1.2 * RS, 0.2 * RS), 1.0);
});

test("half-overlap band lands where the geometry says it should", () => {
  // Equal discs separated by one solar radius: the classic 'half' case.
  const f = computeSolarObscuration(RS, RS, RS);
  assert.ok(f > 0.35 && f < 0.45, `equal-disc d=rs obscuration ${f}`);
  // Monotone in d across the whole contact range, at a fine step.
  let prev = 1.0;
  for (let i = 0; i <= 2000; i++) {
    const d = (i / 2000) * (2.0 * RS);
    const v = computeSolarObscuration(RS, RS, d);
    assert.ok(Number.isFinite(v), `NaN at d=${d}`);
    assert.ok(v <= prev + 1e-12, `not monotone at d=${d} (${v} > ${prev})`);
    prev = v;
  }
  assert.equal(prev, 0.0, "must reach exactly zero at external tangency");
});

test("limb darkening blocks more flux than area when it covers the centre", () => {
  // The disc is brightest at the centre, so covering the centre removes MORE
  // flux than area, and covering only the limb removes LESS. Both signs are
  // physical; a uniform-disc regression collapses both to zero difference.
  let sawStrictCentral = false;
  for (let i = 1; i <= 20; i++) {
    const d = (i / 20) * RS; // overlap always includes the disc centre region
    const ld = computeSolarObscuration(RS, RS, d);
    const uniform = computeUniformObscuration(RS, RS, d);
    assert.ok(ld >= uniform - 1e-12, `LD < uniform at central d=${d / RS}*rs`);
    if (ld > uniform + 1e-3) {
      sawStrictCentral = true;
    }
  }
  assert.ok(sawStrictCentral, "limb darkening never differed from the uniform disc");

  // Grazing contact: the surviving overlap lies entirely in the darkened
  // limb, so limb darkening now removes LESS than area.
  for (const k of [1.3, 1.5, 1.7]) {
    const ld = computeSolarObscuration(RS, RS, k * RS);
    const uniform = computeUniformObscuration(RS, RS, k * RS);
    assert.ok(ld < uniform - 1e-4, `LD >= uniform at grazing d=${k}*rs`);
  }

  // Annular, concentric: a 0.9-radius occluder hides 81% of the AREA but
  // ~87% of the FLUX, because the hidden part is the bright centre.
  const annularLd = computeSolarObscuration(RS, 0.9 * RS, 0.0);
  const annularUniform = computeUniformObscuration(RS, 0.9 * RS, 0.0);
  assert.ok(
    Math.abs(annularUniform - 0.81) < 1e-9,
    `uniform annular must be (ro/rs)^2 = 0.81, got ${annularUniform}`,
  );
  assert.ok(
    annularLd > 0.86 && annularLd < 0.88,
    `limb-darkened annular obscuration ${annularLd}`,
  );
});

test("near totality, limb darkening halves the surviving flux", () => {
  // THE headline correction. Measured 2017 spectro-irradiance puts
  // actual/geometric surviving flux at 0.22 (306 nm) .. 0.67 (1020 nm) near
  // second/third contact (ACP 19:4703); a uniform disc over-predicts the
  // broadband survivor by roughly 2x. Bisect for the geometry at which the
  // uniform model says 99% obscured, then compare survivors.
  const ro = 1.02 * RS;
  let lo = 0.0;
  let hi = RS + ro;
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi);
    if (computeUniformObscuration(RS, ro, mid) > 0.99) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const uniformSurvivor = 1.0 - computeUniformObscuration(RS, ro, lo);
  const ldSurvivor = 1.0 - computeSolarObscuration(RS, ro, lo);
  assert.ok(
    Math.abs(uniformSurvivor - 0.01) < 1e-6,
    `bisection landed at uniform survivor ${uniformSurvivor}`,
  );
  const ratio = ldSurvivor / uniformSurvivor;
  assert.ok(
    ratio > 0.22 && ratio < 0.67,
    `survivor ratio ${ratio} outside the measured 0.22..0.67 band`,
  );
});

test("the uniform lens area is symmetric under swapping the two discs", () => {
  // obscuration is area-normalised, so the SYMMETRIC invariant is the lens
  // area itself: f(rs,ro,d)*pi*rs^2 === f(ro,rs,d)*pi*ro^2.
  for (const [a, b, d] of [
    [RS, 0.67 * RS, 1.05 * RS],
    [RS, 1.3 * RS, 0.9 * RS],
    [0.5 * RS, 2.0 * RS, 1.9 * RS],
  ]) {
    const lensA = computeUniformObscuration(a, b, d) * Math.PI * a * a;
    const lensB = computeUniformObscuration(b, a, d) * Math.PI * b * b;
    assert.ok(
      Math.abs(lensA - lensB) <= 1e-12 * Math.max(lensA, 1e-12),
      `lens area asymmetric: ${lensA} vs ${lensB}`,
    );
  }
});

test("degenerate and out-of-domain inputs return 0, never NaN", () => {
  for (const args of [
    [0, RS, 0],
    [RS, 0, 0],
    [-RS, RS, 0],
    [RS, RS, -1],
    [Number.NaN, RS, 0],
    [RS, Number.NaN, 0],
    [RS, RS, Number.NaN],
  ]) {
    const v = computeSolarObscuration(...args);
    assert.equal(v, 0.0, `computeSolarObscuration(${args}) === ${v}`);
    const u = computeUniformObscuration(...args);
    assert.equal(u, 0.0, `computeUniformObscuration(${args}) === ${u}`);
  }
  // The acos arguments must stay clamped right at tangency, where the
  // unguarded expressions drift a few ULP outside [-1, 1].
  for (const eps of [0, 1e-18, -1e-18, 1e-12, -1e-12]) {
    assert.ok(Number.isFinite(computeSolarObscuration(RS, RS, 2.0 * RS + eps)));
    assert.ok(Number.isFinite(computeUniformObscuration(RS, RS, 2.0 * RS + eps)));
  }
});

test("eclipse magnitude crosses 1 exactly at totality", () => {
  assert.equal(computeEclipseMagnitude(RS, RS, 2.0 * RS), 0.0);
  assert.equal(computeEclipseMagnitude(RS, RS, 0.0), 1.0);
  assert.ok(computeEclipseMagnitude(RS, 1.05 * RS, 0.0) > 1.0);
  // Magnitude >= 1 must coincide with obscuration === 1 for an occluder at
  // least as large as the sun (the Stellarium #3720 trap: magnitude and
  // obscuration are NOT interchangeable for an ANNULAR eclipse, where
  // magnitude < 1 while the geometry is still 'central').
  for (let i = 0; i <= 100; i++) {
    const d = (i / 100) * (2.0 * RS);
    const m = computeEclipseMagnitude(RS, 1.1 * RS, d);
    const f = computeSolarObscuration(RS, 1.1 * RS, d);
    if (m >= 1.0) {
      assert.equal(f, 1.0, `magnitude ${m} >= 1 but obscuration ${f} at d=${d}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The published `frameState.eclipseState` contract
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_KEYS = [
  "enabled",
  // C12-29 S2 additions: the ruling-E2 mode flag and the sun position the
  // frame actually used (derived in-module now that `Scene.render` publishes
  // the state before `uniformState.update`).
  "autoExposure",
  "sunPositionWC",
  "valid",
  "sunVisibleFraction",
  "earthOcclusionFraction",
  "moonObscuration",
  "moonPositionWC",
  "sunAngularRadius",
  "earthAngularRadius",
  "moonAngularRadius",
  "earthSeparation",
  "moonSeparation",
  "eclipseMagnitude",
  // C12-29 S6 additions: the 360-degree horizon-twilight toggle and its
  // geometry-only strength. Same convention as `enabled`/`autoExposure` —
  // the flag gates APPLICATION, the strength is computed either way.
  "horizonTwilightEnabled",
  "horizonTwilightStrength",
];

test("published state carries exactly the documented field set", () => {
  const state = createEclipseState();
  assert.deepEqual(Object.keys(state).sort(), [...CONTRACT_KEYS].sort());
  // The four load-bearing fields the research report specifies by name.
  for (const k of [
    "sunVisibleFraction",
    "earthOcclusionFraction",
    "moonObscuration",
    "moonPositionWC",
  ]) {
    assert.ok(k in state, `${k} missing from the published contract`);
  }
  // Identity at construction: a scene that never renders must not dim.
  assert.equal(state.sunVisibleFraction, 1.0);
  assert.equal(state.earthOcclusionFraction, 0.0);
  assert.equal(state.moonObscuration, 0.0);
});

test("the state object is mutated in place, never reallocated", () => {
  const state = createEclipseState();
  const moonRef = state.moonPositionWC;
  const time = JulianDate.fromIso8601("2026-08-12T17:47:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const cam = Cartesian3.fromDegrees(-21.94, 64.14, 100.0);
  const out = updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
  });
  assert.equal(out, state, "must return the same object");
  assert.equal(out.moonPositionWC, moonRef, "moonPositionWC must be reused");
});

test("missing inputs reset to identity rather than producing garbage", () => {
  const state = createEclipseState();
  updateEclipseState(state, { enabled: true });
  assert.equal(state.valid, false);
  assert.equal(state.sunVisibleFraction, 1.0);
  assert.equal(getEclipseSunFactor(state), 1.0);
});

test("getEclipseSunFactor is the exact multiplicative identity when off", () => {
  // This is the whole off-toggle identity proof: the shaders compute
  // `x * factor`, and `x * 1.0 === x` bit-for-bit in IEEE 754.
  assert.equal(getEclipseSunFactor(undefined), 1.0);
  assert.equal(getEclipseSunFactor(null), 1.0);

  const state = createEclipseState();
  const time = JulianDate.fromIso8601("2024-04-08T18:17:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const cam = Cartesian3.fromDegrees(-96.797, 32.7767, 150.0);

  // Disabled: physics still computed, factor exactly 1.0.
  updateEclipseState(state, {
    enabled: false,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
  });
  assert.equal(state.enabled, false);
  assert.equal(state.valid, true);
  assert.ok(
    state.sunVisibleFraction < 0.5,
    "the physics must still run with the effect disabled",
  );
  assert.equal(
    getEclipseSunFactor(state),
    1.0,
    "disabled must yield EXACTLY 1.0, not 0.999...",
  );

  // Enabled: the factor is the fraction, bit for bit.
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
  });
  assert.equal(getEclipseSunFactor(state), state.sunVisibleFraction);
});

test("an unoccluded sun yields exactly 1.0 (byte-identical frames)", () => {
  const state = createEclipseState();
  // Camera far off the ecliptic plane and far from the Earth-Sun line, at a
  // time chosen so neither the Earth nor the Moon is anywhere near the sun.
  const time = JulianDate.fromIso8601("2026-01-15T00:00:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const up = Cartesian3.normalize(sun, new Cartesian3());
  const cam = Cartesian3.multiplyByScalar(up, 8.0e6, new Cartesian3());
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
  });
  assert.equal(state.earthOcclusionFraction, 0.0);
  assert.equal(state.sunVisibleFraction, 1.0);
  assert.equal(getEclipseSunFactor(state), 1.0);
});

test("the Earth term is gated off exactly when the legacy occluder was", () => {
  // Caller passes `earthOccluderRadius: undefined` in 2D / Columbus view /
  // hidden globe / underground camera / translucent globe — the conditions
  // under which `SceneUtilities.getOccluder` returned undefined. The Earth
  // term must then be exactly 0 (today's "sun always visible" behaviour).
  const state = createEclipseState();
  const time = JulianDate.fromIso8601("2026-06-01T00:00:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  // Camera on the anti-solar side, i.e. deep in the Earth's shadow.
  const cam = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(sun, new Cartesian3()),
    -6.771e6,
    new Cartesian3(),
  );
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
  });
  assert.equal(state.earthOcclusionFraction, 1.0, "should be in full shadow");
  assert.equal(state.sunVisibleFraction, 0.0);

  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: cam,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: undefined,
  });
  assert.equal(state.earthOcclusionFraction, 0.0);
  assert.equal(state.sunVisibleFraction, 1.0);
});

test("orbital sunset is a continuous, monotone ramp — not a step", () => {
  // 400 km vantage swept in 0.01-degree elevation steps through the limb.
  // This is the analytic twin of probe-eclipse-sun-fade lane (a).
  const state = createEclipseState();
  const time = JulianDate.fromIso8601("2026-03-20T12:00:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const sunDir = Cartesian3.normalize(sun, new Cartesian3());
  const seed =
    Math.abs(sunDir.z) < 0.9 ? new Cartesian3(0, 0, 1) : new Cartesian3(1, 0, 0);
  const perp = Cartesian3.normalize(
    Cartesian3.cross(
      Cartesian3.cross(sunDir, seed, new Cartesian3()),
      sunDir,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const R = 6371000.0 + 400000.0;

  let prev = null;
  let maxStep = 0;
  let sawOne = false;
  let sawZero = false;
  let transitions = 0;
  for (let i = 0; i <= 400; i++) {
    const elevDeg = -19.0 - (i / 400) * 3.6;
    const theta = ((90.0 - elevDeg) * Math.PI) / 180.0;
    const up = Cartesian3.normalize(
      new Cartesian3(
        Math.cos(theta) * sunDir.x + Math.sin(theta) * perp.x,
        Math.cos(theta) * sunDir.y + Math.sin(theta) * perp.y,
        Math.cos(theta) * sunDir.z + Math.sin(theta) * perp.z,
      ),
      new Cartesian3(),
    );
    const cam = Cartesian3.multiplyByScalar(up, R, new Cartesian3());
    updateEclipseState(state, {
      enabled: true,
      cameraPositionWC: cam,
      sunPositionWC: sun,
      time,
      earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
    });
    const f = state.sunVisibleFraction;
    assert.ok(Number.isFinite(f), `NaN fraction at elev ${elevDeg}`);
    if (f === 1) {
      sawOne = true;
    }
    if (f === 0) {
      sawZero = true;
    }
    if (prev !== null) {
      assert.ok(f <= prev + 1e-12, `fraction rose at elev ${elevDeg}`);
      const step = prev - f;
      if (step > maxStep) {
        maxStep = step;
      }
      if (step > 0) {
        transitions++;
      }
    }
    prev = f;
  }
  assert.ok(sawOne, "sweep never started with a fully visible sun");
  assert.ok(sawZero, "sweep never reached full occultation");
  // The defining property of the fix: no single step carries more than a few
  // percent of the transition. A binary cull would show maxStep === 1.
  assert.ok(maxStep < 0.05, `largest single-step drop was ${maxStep}`);
  assert.ok(transitions > 40, `only ${transitions} steps changed the fraction`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A real eclipse: 2024-04-08 from Dallas, Texas
// ─────────────────────────────────────────────────────────────────────────────
//
// Published ground truth (NASA / EclipseWise, Dallas TX):
//   partial begins  17:23 UTC
//   totality        18:40:43 - 18:44:57 UTC  (3m52s)
//   greatest       ~18:42:50 UTC
//   partial ends    20:02 UTC
//
// The engine's in-fork ephemeris is Simon1994 plus
// `Transforms.computeIcrfToCentralBodyFixedMatrix`, which falls back to the
// TEME pseudo-fixed rotation when earth-orientation data has not loaded —
// which is always the case under `node --test`. That fallback drops nutation
// and polar motion, so the whole curve is time-shifted by roughly a minute.
// The assertions below are therefore stated as "totality is reached, inside
// the published window, and the eclipse is exactly zero outside the published
// partial window", which is falsifiable without pretending to arcsecond
// timing.

const DALLAS = Cartesian3.fromDegrees(-96.797, 32.7767, 150.0);

function dallasAt(state, iso) {
  const time = JulianDate.fromIso8601(iso);
  const sun = computeSunPositionWC(time, new Cartesian3());
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
  });
  return state;
}

test("2024-04-08 Dallas: totality is reached inside the published window", () => {
  const state = createEclipseState();
  const base = JulianDate.fromIso8601("2024-04-08T18:30:00Z");
  let best = { o: -1, seconds: 0 };
  for (let s = 0; s <= 1200; s += 5) {
    const time = JulianDate.addSeconds(base, s, new JulianDate());
    const sun = computeSunPositionWC(time, new Cartesian3());
    updateEclipseState(state, {
      enabled: true,
      cameraPositionWC: DALLAS,
      sunPositionWC: sun,
      time,
      earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
    });
    if (state.moonObscuration > best.o) {
      best = {
        o: state.moonObscuration,
        seconds: s,
        magnitude: state.eclipseMagnitude,
        iso: JulianDate.toIso8601(time),
      };
    }
  }
  assert.equal(best.o, 1.0, `peak obscuration ${best.o} (must be exact totality)`);
  assert.ok(
    best.magnitude >= 1.0,
    `peak magnitude ${best.magnitude} must be >= 1 at totality`,
  );
  // Published totality window is 18:40:43 - 18:44:57 UTC, i.e. 643..897 s
  // after 18:30. Allow the TEME-fallback skew but require the peak to land
  // inside the real event.
  assert.ok(
    best.seconds >= 643 && best.seconds <= 897,
    `peak at +${best.seconds}s (${best.iso}) is outside the published totality window`,
  );
});

test("2024-04-08 Dallas: exactly zero outside the published partial window", () => {
  const state = createEclipseState();
  for (const iso of [
    "2024-04-08T16:00:00Z",
    "2024-04-08T17:00:00Z",
    "2024-04-08T20:10:00Z",
    "2024-04-08T21:00:00Z",
  ]) {
    dallasAt(state, iso);
    assert.equal(state.moonObscuration, 0.0, `non-zero obscuration at ${iso}`);
    assert.equal(state.sunVisibleFraction, 1.0, `sun dimmed at ${iso}`);
    assert.equal(state.earthOcclusionFraction, 0.0, `Earth term fired at ${iso}`);
  }
});

test("2024-04-08 Dallas 18:17 UTC is a deep partial, limb-darkened", () => {
  const state = createEclipseState();
  dallasAt(state, "2024-04-08T18:17:00Z");
  // Regression pin on the measured value (0.6072 at the time of writing) with
  // a band wide enough to absorb ephemeris-frame drift but narrow enough to
  // catch a lost term.
  assert.ok(
    state.moonObscuration > 0.55 && state.moonObscuration < 0.66,
    `18:17 UTC obscuration ${state.moonObscuration}`,
  );
  assert.equal(state.earthOcclusionFraction, 0.0, "sun is high; no Earth term");
  assert.equal(
    state.sunVisibleFraction,
    1.0 - state.moonObscuration,
    "single-occluder combination must be exact",
  );
  // The limb-darkened value must exceed the uniform-disc value at the same
  // geometry — the term that stops the sky staying twice too bright near
  // totality.
  const uniform = computeUniformObscuration(
    state.sunAngularRadius,
    state.moonAngularRadius,
    state.moonSeparation,
  );
  assert.ok(
    state.moonObscuration > uniform + 0.01,
    `limb-darkened ${state.moonObscuration} vs uniform ${uniform}`,
  );
});

test("the lunar memo invalidates when ICRF data finishes loading", () => {
  // V1. `Transforms.computeIcrfToCentralBodyFixedMatrix` silently substitutes
  // the TEME pseudo-fixed rotation while the IAU2006 XYS data is still
  // loading. The two disagree by ~0.3-0.4 deg in 2026 — LARGER than the
  // ~0.53 deg solar disc — so a memo keyed on time ALONE would, under a
  // pinned/paused clock (every probe, and a common user pattern), pin the
  // TEME moon forever while `Moon.update` and `UniformState` recompute each
  // frame and switch to true ICRF the moment the data lands. The rendered
  // moon and the fade would then disagree by more than a solar diameter.
  const realIcrf = Transforms.computeIcrfToFixedMatrix;
  try {
    // Phase 1 — data not yet loaded (the natural state under node --test).
    Transforms.computeIcrfToFixedMatrix = () => undefined;
    const state = createEclipseState();
    // A time no other test uses: the lunar memo is module-level, and this
    // test deliberately leaves a stubbed-rotation entry in it.
    const time = JulianDate.fromIso8601("2026-08-12T17:53:11Z");
    const sun = computeSunPositionWC(time, new Cartesian3());
    const cam = Cartesian3.fromDegrees(-21.94, 64.14, 100.0);
    const args = {
      enabled: true,
      cameraPositionWC: cam,
      sunPositionWC: sun,
      time,
      earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
    };
    updateEclipseState(state, args);
    const fallbackMoon = Cartesian3.clone(state.moonPositionWC);

    // Same time again, still no data: the memo must be reused verbatim.
    updateEclipseState(state, args);
    assert.ok(
      Cartesian3.equals(state.moonPositionWC, fallbackMoon),
      "the memo must hold while the rotation branch is unchanged",
    );

    // Phase 2 — XYS data lands. A deliberately distinct rotation (2 deg about
    // Z on top of the real fallback) stands in for the ICRF result so the
    // change is unambiguous.
    const shift = Matrix3.fromRotationZ(0.0349, new Matrix3());
    Transforms.computeIcrfToFixedMatrix = (t, result) => {
      const teme = Transforms.computeTemeToPseudoFixedMatrix(t, new Matrix3());
      return Matrix3.multiply(shift, teme, result ?? new Matrix3());
    };
    updateEclipseState(state, args);
    const icrfMoon = Cartesian3.clone(state.moonPositionWC);
    assert.ok(
      !Cartesian3.equals(icrfMoon, fallbackMoon),
      "the memo must be rebuilt the frame ICRF becomes available",
    );
    // ~2 deg at lunar distance is ~1.3e7 m — vastly more than any rounding.
    assert.ok(
      Cartesian3.distance(icrfMoon, fallbackMoon) > 1.0e6,
      "the two rotations must actually differ in this fixture",
    );

    // Phase 3 — once ICRF is the source, the memo latches (XYS availability
    // is monotone for a given time, so no further probing is needed).
    let icrfCalls = 0;
    const patched = Transforms.computeIcrfToFixedMatrix;
    Transforms.computeIcrfToFixedMatrix = (t, result) => {
      icrfCalls++;
      return patched(t, result);
    };
    updateEclipseState(state, args);
    assert.ok(
      Cartesian3.equals(state.moonPositionWC, icrfMoon),
      "the ICRF-sourced memo must be stable",
    );
    assert.equal(icrfCalls, 0, "an ICRF-sourced memo must not re-probe");
  } finally {
    Transforms.computeIcrfToFixedMatrix = realIcrf;
  }
});

test("2D / Columbus view is identity — no mixed-frame moon term", () => {
  // V2. Outside SCENE3D the camera position is in PROJECTED MAP coordinates
  // while the sun and moon are ECEF. The Earth term is already gated off
  // there (no occluder), but the MOON term would keep running on mixed
  // frames — direction errors up to ~1.5 deg, several solar diameters.
  // Legacy had no sun occlusion in those modes at all, so `active: false`
  // must produce full identity.
  const state = createEclipseState();
  const time = JulianDate.fromIso8601("2024-04-08T18:42:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const base = {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: undefined,
  };

  // SCENE3D (active defaults true): totality, so the gate is non-vacuous.
  updateEclipseState(state, base);
  assert.equal(state.valid, true);
  assert.ok(state.moonObscuration > 0.9, "fixture must be a real eclipse");

  // 2D / Columbus view / MORPHING.
  updateEclipseState(state, { ...base, active: false });
  assert.equal(state.valid, false);
  assert.equal(state.sunVisibleFraction, 1.0);
  assert.equal(state.moonObscuration, 0.0);
  assert.equal(state.earthOcclusionFraction, 0.0);
  assert.equal(getEclipseSunFactor(state), 1.0);
});

test("Scene.js gates the eclipse computation on SCENE3D", () => {
  assert.match(
    sceneJs,
    /scratchEclipseOptions\.active = frameState\.mode === SceneMode\.SCENE3D;/,
  );
  // V3 — the per-frame options object is hoisted, not reallocated.
  assert.match(sceneJs, /const scratchEclipseOptions = \{/);
  assert.doesNotMatch(
    sceneJs,
    /updateEclipseState\(scene\._eclipseState, \{/,
    "the options literal must not be allocated per frame",
  );
});

test("a moon farther away than the sun is not an occluder", () => {
  // Guards the lunar-eclipse geometry: a full moon near the anti-solar point
  // must never be treated as occulting the sun.
  const state = createEclipseState();
  const time = JulianDate.fromIso8601("2024-04-08T18:42:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const farMoon = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(sun, new Cartesian3()),
    3.0e11,
    new Cartesian3(),
  );
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    moonPositionWC: farMoon,
    earthOccluderRadius: Ellipsoid.WGS84.minimumRadius,
  });
  assert.equal(state.moonObscuration, 0.0);
  assert.equal(state.eclipseMagnitude, 0.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Both backends carry the fade; nothing else moved
// ─────────────────────────────────────────────────────────────────────────────

const sunFs = readEngine("Shaders/SunFS.glsl");
const sunJs = readEngine("Scene/Sun.js");
const sceneJs = readEngine("Scene/Scene.js");
const conditions = readEngine("Scene/AtmosphericConditions.js");
const envRenderer = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
const frameStateJs = readEngine("Scene/FrameState.js");

test("WebGL: SunFS.glsl multiplies ALPHA by the eclipse factor", () => {
  assert.match(sunFs, /uniform float u_eclipseAlpha;/);
  assert.match(sunFs, /out_FragColor\.a \*= u_eclipseAlpha;/);
  // ALPHA, not rgb — an rgb multiply produces a black disc under ALPHA_BLEND
  // and is not invariant to the C11-115 blend flip.
  assert.doesNotMatch(sunFs, /out_FragColor\.rgb \*= u_eclipseAlpha/);
});

test("WebGL: Sun.js exposes the uniform and publishes the shared scalar", () => {
  assert.match(sunJs, /u_eclipseAlpha:\s*function\s*\(\)\s*\{/);
  assert.match(sunJs, /this\._eclipseAlpha\s*=\s*1\.0;/, "identity default");
  assert.match(sunJs, /getEclipseSunFactor\(frameState\.eclipseState\)/);
  assert.match(sunJs, /frameState\.sunEclipseAlpha\s*=\s*eclipseAlpha;/);
  // Published BEFORE the feature-renderer branch, so both backends read one
  // scalar (the C7-SUN-STARS-EXTINCTION convention).
  const publishIndex = sunJs.indexOf("frameState.sunEclipseAlpha = eclipseAlpha;");
  const branchIndex = sunJs.indexOf("getFeatureRenderer(FeatureRendererKey.SUN)");
  assert.ok(publishIndex > 0 && branchIndex > publishIndex, "publish must precede the backend branch");
});

test("WebGPU: the sun WGSL multiplies ALPHA by the same factor", () => {
  assert.match(envRenderer, /extinction: vec3<f32>, eclipseAlpha: f32,/);
  assert.match(
    envRenderer,
    /color = vec4f\(color\.rgb, color\.a \* u\.eclipseAlpha\);/,
  );
  // The former `_p2` pad is reused, so the uniform layout is unchanged.
  assert.doesNotMatch(envRenderer, /_p2: f32/);
  assert.match(
    envRenderer,
    /uniformData\[31\] = typeof eclipseAlpha === "number" \? eclipseAlpha : 1\.0;/,
  );
  assert.match(envRenderer, /const eclipseAlpha = frameState\.sunEclipseAlpha;/);
});

test("WebGPU: the moving Sun reuses its command, bind group, and RTE vertex geometry", () => {
  const start = envRenderer.indexOf("function updateWebGPUSun(");
  const end = envRenderer.indexOf(
    "// Moon Renderer — Ray-Marched Analytic Ellipsoid",
    start,
  );
  const update = envRenderer.slice(start, end);

  assert.match(update, /if \(!defined\(cache\.bindGroup\)\) \{/);
  assert.match(update, /if \(!defined\(cache\.command\)\) \{/);
  assert.equal(
    (update.match(/new WebGPUDrawCommand\(/g) ?? []).length,
    1,
    "one cached command construction site",
  );
  assert.doesNotMatch(update, /Cartesian3\.equals\(cache\.lastSunPos/);
  assert.doesNotMatch(update, /cache\.vertexBuffer\.destroy\(\)/);
  assert.match(envRenderer, /encodedSunHigh: vec3<f32>/);
  assert.match(
    envRenderer,
    /let rte = \(u\.encodedSunHigh - u\.encodedCameraHigh\)/,
  );
});

test("no new ShaderDefine bit was consumed", () => {
  const defines = readEngine("Renderer/WebGPU/WebGPUShaderDefines.ts");
  assert.doesNotMatch(
    defines,
    /ECLIPSE/i,
    "C12 exit-gate item 5: the eclipse fade must be a runtime uniform, not a define bit",
  );
  // The sun shader module is still cached with defines === 0.
  assert.match(
    envRenderer,
    /ShaderSourceId\.ENVIRONMENT_SUN,\s*SUN_SHADER_WGSL,\s*0,/,
  );
});

test("Scene.js publishes the state and leaves the legacy cull untouched", () => {
  assert.match(sceneJs, /frameState\.eclipseState = updateEclipseState\(/);
  assert.match(sceneJs, /this\._eclipseState = createEclipseState\(\);/);
  // The Earth occluder comes from the very sphere the legacy binary cull
  // uses, so the fade and the cull can never disagree about the geometry.
  assert.match(
    sceneJs,
    /scratchEclipseOptions\.earthOccluderRadius = defined\(occluder\)\s*\?\s*occluder\.radius\s*:\s*undefined;/,
  );
  assert.match(sceneJs, /_globeTranslucencyState\.sunVisibleThroughGlobe/);
  // The binary cull line itself is UNCHANGED — the off-toggle is
  // byte-identical only because this is still exactly what it was.
  assert.match(
    sceneJs,
    /environmentState\.isSunVisible = this\.isVisible\(\s*cullingVolume,\s*environmentState\.sunDrawCommand,\s*occluder,\s*\);/,
  );
});

test("Scene.environmentState still exposes the binary-cull result", () => {
  // probe-eclipse-sun-fade lane (c) proves "the legacy cull is unchanged" at
  // STATE level, by reading `scene.environmentState.isSunVisible` per step
  // (the pixel-level version is geometrically unobservable — the cull fires
  // ~1.3 deg of sun elevation BELOW the end of the fade band, where the
  // Earth's limb already covers the glow). If this field or its public
  // getter is renamed, that lane goes silently vacuous.
  assert.match(sceneJs, /get environmentState\(\) \{/);
  assert.match(sceneJs, /isSunVisible: false,/, "the initial state field");
});

test("the toggle exists on AtmosphericConditions and defaults ON", () => {
  assert.match(conditions, /enableEclipse: true,/);
  // Ruling E1 (research report §6a) — default-on, both backends.
  assert.match(conditions, /C12-29 S1/);
});

test("FrameState declares both published fields", () => {
  assert.match(frameStateJs, /this\.eclipseState = undefined;/);
  assert.match(frameStateJs, /this\.sunEclipseAlpha = undefined;/);
});

test("the WebGPU sun shader passes naga validation", async () => {
  const start = envRenderer.indexOf("const SUN_SHADER_WGSL = `");
  assert.ok(start > 0, "SUN_SHADER_WGSL not found");
  const bodyStart = envRenderer.indexOf("`", start) + 1;
  const bodyEnd = envRenderer.indexOf("`;", bodyStart);
  assert.ok(bodyEnd > bodyStart, "SUN_SHADER_WGSL terminator not found");
  const shaderSource = envRenderer.slice(bodyStart, bodyEnd);
  assert.ok(
    shaderSource.includes("u.eclipseAlpha"),
    "extracted the wrong slice",
  );
  assert.ok(!shaderSource.includes("${"), "template interpolation in the WGSL");

  const nagaDirectory = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(shaderSource));
});
