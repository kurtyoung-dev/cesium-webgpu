// eclipse-scene-dimming.spec.mjs — C12-29 S2: pins the scene-light and
// atmosphere dimming curve, the ~5-lux twilight floor, the ruling-E2
// `eclipseAutoExposure` mode switch, the exact-1.0 identity paths, and the
// four injection sites (each one JS-side, so both backends inherit one
// change — the S1 alpha pattern).
//
// These tests fail if:
//   - the scene factor starts using `sunVisibleFraction` instead of
//     `moonObscuration`. That is the single most destructive regression
//     available here: the Earth-limb term saturates at 1 through twilight and
//     all night, so the world would go black at every sunset and the day side
//     seen from a night-side orbital camera would go black too. The
//     day/night-cycle test below sweeps 24 h and demands EXACT 1.0;
//   - the totality floor is lost (a pure-black totality — the research is
//     explicit that totality is civil twilight, ~10x brighter than a
//     full-moon night) or is silently re-tuned away from the documented
//     illuminance ratio;
//   - the curve stops being linear in the limb-darkened flux fraction (a
//     smoothstep or a magnitude-keyed darkening — Stellarium's documented
//     mistake) or stops being monotone;
//   - `eclipseAutoExposure` stops switching the transfer function, or starts
//     defaulting to the camera mode (ruling E2 makes the human-eye impression
//     the default);
//   - any of the four injection sites loses its multiply, or gains it on only
//     ONE backend (the C11-176 / C12 exit-gate class: a default-ON celestial
//     multiplier must never be single-backend);
//   - `UniformState` moves the multiply back before the LDR clamp (which
//     swallows it entirely until the factor drops below 1/intensity);
//   - the WebGPU sky-atmosphere LUT BAKE starts carrying the eclipse factor
//     (it is debounced on sun direction, which barely moves across an
//     eclipse, so a dimmed bake latches and stays wrong after totality);
//   - the eclipse publication drifts back below `uniformState.update`, which
//     would leave every re-entrant `uniformState.update` (picking, viewport
//     executor, offscreen views) reading a one-frame-stale factor;
//   - S2 starts editing shaders (it is JS-uniform-only by design) or consumes
//     a ShaderDefine bit.
//
// Run: node --test Tools/visual-regression/eclipse-scene-dimming.spec.mjs

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
  createEclipseState,
  updateEclipseState,
  getEclipseSunFactor,
  getEclipseSceneLightFactor,
  eclipseSceneLightCurve,
  computeSunPositionWC,
  ECLIPSE_FULL_SUN_ILLUMINANCE,
  ECLIPSE_TOTALITY_ILLUMINANCE,
  ECLIPSE_RADIOMETRIC_FLOOR,
  ECLIPSE_ADAPTATION_EXPONENT,
  ECLIPSE_TWILIGHT_FLOOR,
} = await import(pathToFileURL(enginePath("Scene/EclipseState.js")).href);

const { default: Cartesian3 } = await import(
  pathToFileURL(enginePath("Core/Cartesian3.js")).href
);
const { default: JulianDate } = await import(
  pathToFileURL(enginePath("Core/JulianDate.js")).href
);
const { default: Ellipsoid } = await import(
  pathToFileURL(enginePath("Core/Ellipsoid.js")).href
);

// The probe harness's rung ladder. Importable because the separation check
// lives in the Node driver rather than inside a `page.evaluate` callback —
// which is the whole reason the defect below could ship unnoticed.
const {
  LADDER_TARGETS,
  MIN_RUNG_SEPARATION,
  RUNG_SEPARATION_EPSILON,
  validateLadderSeparation,
} = await import(
  pathToFileURL(path.join(here, "eclipse-ladder-rungs.mjs")).href
);

const DALLAS = Cartesian3.fromDegrees(-96.797, 32.7767, 150.0);
const EARTH_RADIUS = Ellipsoid.WGS84.minimumRadius;

/** A published-shaped state carrying just the fields the factor reads. */
function stateWith(moonObscuration, overrides) {
  return Object.assign(
    {
      enabled: true,
      autoExposure: false,
      valid: true,
      moonObscuration,
      // Deliberately hostile: full Earth occlusion (i.e. night) alongside the
      // given lunar obscuration. Any implementation that reaches for
      // `sunVisibleFraction` reads 0 here and fails the identity tests.
      earthOcclusionFraction: 1.0,
      sunVisibleFraction: 0.0,
    },
    overrides,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The documented constants
// ─────────────────────────────────────────────────────────────────────────────

test("the floor constants are the published illuminance ratio, not a tuned number", () => {
  assert.equal(ECLIPSE_FULL_SUN_ILLUMINANCE, 100000.0);
  assert.equal(ECLIPSE_TOTALITY_ILLUMINANCE, 5.0);
  assert.equal(
    ECLIPSE_RADIOMETRIC_FLOOR,
    ECLIPSE_TOTALITY_ILLUMINANCE / ECLIPSE_FULL_SUN_ILLUMINANCE,
  );
  assert.equal(ECLIPSE_RADIOMETRIC_FLOOR, 5.0e-5);
  // CIE L* / Stevens' brightness exponent — the eye's partial adaptation
  // between those two illuminance states, and the ONLY nonlinearity in the
  // default path.
  assert.equal(ECLIPSE_ADAPTATION_EXPONENT, 1.0 / 3.0);
  // The floor must be derived from the two above, not typed in.
  assert.equal(
    ECLIPSE_TWILIGHT_FLOOR,
    Math.pow(ECLIPSE_RADIOMETRIC_FLOOR, ECLIPSE_ADAPTATION_EXPONENT),
  );
  // ~3.68% of full-sun render brightness: a deep-twilight frame, legible
  // rather than extinguished.
  assert.ok(
    ECLIPSE_TWILIGHT_FLOOR > 0.036 && ECLIPSE_TWILIGHT_FLOOR < 0.038,
    `twilight floor ${ECLIPSE_TWILIGHT_FLOOR}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The curve
// ─────────────────────────────────────────────────────────────────────────────

test("no eclipse is the exact multiplicative identity", () => {
  // Every guard path, and the ordinary "nothing is in front of the sun" frame.
  assert.equal(getEclipseSceneLightFactor(undefined), 1.0);
  assert.equal(getEclipseSceneLightFactor(null), 1.0);
  assert.equal(getEclipseSceneLightFactor(stateWith(0.0)), 1.0);
  assert.equal(
    getEclipseSceneLightFactor(stateWith(0.5, { enabled: false })),
    1.0,
  );
  assert.equal(
    getEclipseSceneLightFactor(stateWith(0.5, { valid: false })),
    1.0,
  );
  // Garbage in the field must not produce garbage light.
  assert.equal(getEclipseSceneLightFactor(stateWith(NaN)), 1.0);
  assert.equal(getEclipseSceneLightFactor(stateWith(-0.2)), 1.0);
  assert.equal(getEclipseSceneLightFactor(stateWith("0.5")), 1.0);
});

test("totality lands exactly on the twilight floor and never on black", () => {
  assert.equal(
    getEclipseSceneLightFactor(stateWith(1.0)),
    ECLIPSE_TWILIGHT_FLOOR,
  );
  // Beyond-total (clamped inputs) must not undershoot.
  assert.equal(
    getEclipseSceneLightFactor(stateWith(1.5)),
    ECLIPSE_TWILIGHT_FLOOR,
  );
  assert.ok(ECLIPSE_TWILIGHT_FLOOR > 0.0, "never pure black");
});

test("the curve is monotone, bounded, and finite across the whole range", () => {
  let prev = 1.0;
  for (let i = 0; i <= 4000; i++) {
    const o = i / 4000;
    const v = getEclipseSceneLightFactor(stateWith(o));
    assert.ok(Number.isFinite(v), `non-finite at obscuration ${o}`);
    assert.ok(
      v >= ECLIPSE_TWILIGHT_FLOOR - 1e-15 && v <= 1.0,
      `out of band at obscuration ${o}: ${v}`,
    );
    assert.ok(v <= prev + 1e-12, `not monotone at obscuration ${o}`);
    prev = v;
  }
  assert.equal(prev, ECLIPSE_TWILIGHT_FLOOR);
});

test("the curve reproduces the documented perceptual anchors", () => {
  // AAS / Optica: no visible change until ~75% obscured, overcast-day at 99%,
  // then a plunge of orders of magnitude in the last seconds. These bands are
  // what stop a 'simplification' to a raw linear multiply (which reads
  // near-black at 99%, where reality is a heavy overcast day) or to a
  // flat-floored clamp (which deletes the plunge entirely).
  const at = (obs) => getEclipseSceneLightFactor(stateWith(obs));
  const half = at(0.5);
  const threeQuarter = at(0.75);
  const ninetyNine = at(0.99);
  const total = at(1.0);
  assert.ok(half > 0.75 && half < 0.83, `50% obscured -> ${half}`);
  assert.ok(
    threeQuarter > 0.58 && threeQuarter < 0.68,
    `75% obscured -> ${threeQuarter}`,
  );
  assert.ok(
    ninetyNine > 0.18 && ninetyNine < 0.25,
    `99% obscured -> ${ninetyNine}`,
  );
  // The final plunge must survive: 99% -> totality is a multi-fold collapse,
  // not the 1.2x a floor-dominated curve would give.
  const plunge = ninetyNine / total;
  assert.ok(plunge > 4.0 && plunge < 8.0, `99%->totality collapse ${plunge}x`);
});

test("the underlying flux term is LINEAR in the flux fraction", () => {
  // The adaptation exponent is applied ONCE, on top of a curve that is affine
  // in `1 - moonObscuration`. Invert it and the result must be a straight line
  // through (o=0 -> 1) and (o=1 -> ECLIPSE_RADIOMETRIC_FLOOR). A smoothstep or
  // any easing shows up immediately as curvature here.
  for (let i = 0; i <= 200; i++) {
    const o = i / 200;
    const flux = Math.pow(
      getEclipseSceneLightFactor(stateWith(o)),
      1.0 / ECLIPSE_ADAPTATION_EXPONENT,
    );
    const expected = 1.0 - o + ECLIPSE_RADIOMETRIC_FLOOR * o;
    assert.ok(
      Math.abs(flux - expected) < 1e-9,
      `flux term not linear at obscuration ${o}: ${flux} vs ${expected}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ruling E2 — the human-eye default and its camera alternative
// ─────────────────────────────────────────────────────────────────────────────

test("eclipseAutoExposure switches the transfer function, not the dimming", () => {
  // Camera mode hands the LINEAR radiometric flux to the exposure chain.
  assert.equal(
    getEclipseSceneLightFactor(stateWith(1.0, { autoExposure: true })),
    ECLIPSE_RADIOMETRIC_FLOOR,
  );
  assert.equal(
    getEclipseSceneLightFactor(stateWith(0.0, { autoExposure: true })),
    1.0,
    "identity must survive in both modes",
  );
  // Through the partial band the human-eye default is strictly BRIGHTER (it
  // carries the adaptation the display transform will not perform), and both
  // are monotone.
  let prevCam = 1.0;
  for (let i = 1; i <= 200; i++) {
    const o = i / 200;
    const eye = getEclipseSceneLightFactor(stateWith(o));
    const cam = getEclipseSceneLightFactor(
      stateWith(o, { autoExposure: true }),
    );
    assert.ok(eye > cam, `eye ${eye} must exceed camera ${cam} at ${o}`);
    assert.ok(cam <= prevCam + 1e-12, `camera mode not monotone at ${o}`);
    assert.ok(
      cam >= ECLIPSE_RADIOMETRIC_FLOOR - 1e-15,
      `camera mode below floor at ${o}`,
    );
    prevCam = cam;
  }
});

test("the default is the human-eye impression, per ruling E2", () => {
  const state = createEclipseState();
  assert.equal(state.autoExposure, false);
  // And the toggle must reach the state through `updateEclipseState`.
  // 18:45 UTC is where OUR ephemeris puts the Dallas maximum (published
  // greatest eclipse for that site is 18:42-18:45 UTC); 18:42 is still 1.2%
  // short of totality on this ephemeris, which is a useful reminder that the
  // fixture instant is not free to drift.
  const time = JulianDate.fromIso8601("2024-04-08T18:45:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  updateEclipseState(state, {
    enabled: true,
    autoExposure: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: EARTH_RADIUS,
  });
  assert.equal(state.autoExposure, true);
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: EARTH_RADIUS,
  });
  assert.equal(state.autoExposure, false, "absent means the default mode");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE regression pin: the Earth term must never reach the scene factor
// ─────────────────────────────────────────────────────────────────────────────

test("a night frame does not dim the world even though the sun is fully occulted", () => {
  // `sunVisibleFraction` is 0 here — the Earth is between the camera and the
  // sun, which is what "night" means. The billboard fade (S1) correctly uses
  // it. The SCENE factor must not: the engine already models night per
  // fragment with N.L, and a global multiplier would black out the day side
  // visible from the same vantage.
  const s = stateWith(0.0);
  assert.equal(
    getEclipseSunFactor(s),
    0.0,
    "S1's billboard fade still uses it",
  );
  assert.equal(getEclipseSceneLightFactor(s), 1.0, "S2 must not");
});

test("a whole day/night cycle with no eclipse is EXACTLY identity", () => {
  // 24 h at 4-minute steps over Dallas on an ordinary day. Sunrise, sunset and
  // both twilights are inside this sweep, and the Earth term genuinely
  // exercises its full 0..1 range there — which is exactly the geometry that
  // an implementation reaching for `sunVisibleFraction` destroys.
  const state = createEclipseState();
  const base = JulianDate.fromIso8601("2026-03-20T00:00:00Z");
  const scratch = new JulianDate();
  let sawPartialEarthTerm = false;
  let sawFullEarthTerm = false;
  let sawNoEarthTerm = false;
  for (let i = 0; i < 360; i++) {
    const t = JulianDate.addMinutes(base, i * 4, scratch);
    const sun = computeSunPositionWC(t, new Cartesian3());
    updateEclipseState(state, {
      enabled: true,
      cameraPositionWC: DALLAS,
      sunPositionWC: sun,
      time: t,
      earthOccluderRadius: EARTH_RADIUS,
    });
    const e = state.earthOcclusionFraction;
    if (e > 0.0 && e < 1.0) {
      sawPartialEarthTerm = true;
    } else if (e >= 1.0) {
      sawFullEarthTerm = true;
    } else {
      sawNoEarthTerm = true;
    }
    assert.equal(state.moonObscuration, 0.0, `unexpected eclipse at step ${i}`);
    assert.equal(
      getEclipseSceneLightFactor(state),
      1.0,
      `scene dimmed with no eclipse at step ${i} (earth term ${e})`,
    );
  }
  // The sweep must be non-vacuous in all three regimes.
  assert.ok(sawNoEarthTerm, "no daytime samples");
  assert.ok(sawPartialEarthTerm, "the Earth-limb transition was never sampled");
  assert.ok(sawFullEarthTerm, "no night samples");
});

test("2D / Columbus view and the off toggle are identity even at totality", () => {
  const state = createEclipseState();
  // 18:45 UTC is where OUR ephemeris puts the Dallas maximum (published
  // greatest eclipse for that site is 18:42-18:45 UTC); 18:42 is still 1.2%
  // short of totality on this ephemeris, which is a useful reminder that the
  // fixture instant is not free to drift.
  const time = JulianDate.fromIso8601("2024-04-08T18:45:00Z");
  const sun = computeSunPositionWC(time, new Cartesian3());
  const base = {
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time,
    earthOccluderRadius: EARTH_RADIUS,
  };

  updateEclipseState(state, { ...base, enabled: true });
  assert.ok(state.moonObscuration > 0.9, "fixture must be a real eclipse");
  assert.ok(
    getEclipseSceneLightFactor(state) < 0.1,
    "the fixture must actually dim in the ON position",
  );

  updateEclipseState(state, { ...base, enabled: false });
  assert.equal(getEclipseSceneLightFactor(state), 1.0);
  assert.ok(state.moonObscuration > 0.9, "the physics must still run when off");

  updateEclipseState(state, { ...base, enabled: true, active: false });
  assert.equal(getEclipseSceneLightFactor(state), 1.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A real eclipse, end to end
// ─────────────────────────────────────────────────────────────────────────────

test("2024-04-08 Dallas: the scene plunges to the floor at totality", () => {
  const state = createEclipseState();
  const totality = JulianDate.fromIso8601("2024-04-08T18:45:00Z");
  const sun = computeSunPositionWC(totality, new Cartesian3());
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time: totality,
    earthOccluderRadius: EARTH_RADIUS,
  });
  assert.equal(state.moonObscuration, 1.0, "published totality");
  assert.equal(getEclipseSceneLightFactor(state), ECLIPSE_TWILIGHT_FLOOR);
});

test("2024-04-08 Dallas: the deep partial dims measurably but is far from the floor", () => {
  const state = createEclipseState();
  const t = JulianDate.fromIso8601("2024-04-08T18:17:00Z");
  const sun = computeSunPositionWC(t, new Cartesian3());
  updateEclipseState(state, {
    enabled: true,
    cameraPositionWC: DALLAS,
    sunPositionWC: sun,
    time: t,
    earthOccluderRadius: EARTH_RADIUS,
  });
  // ~0.61 obscuration at the time of writing; the band absorbs ephemeris drift.
  assert.ok(state.moonObscuration > 0.55 && state.moonObscuration < 0.66);
  const f = getEclipseSceneLightFactor(state);
  assert.ok(f > 0.7 && f < 0.8, `deep-partial factor ${f}`);
  assert.ok(
    f > 10.0 * ECLIPSE_TWILIGHT_FLOOR,
    "must not be near the floor yet",
  );
});

test("the scene factor tracks the eclipse monotonically across real time", () => {
  // Around 1st..4th contact over Dallas (measured on this ephemeris: first
  // non-zero obscuration 17:27 UTC, last 20:05 UTC), 2-minute steps. The
  // factor must fall to its minimum and recover, never wander.
  const state = createEclipseState();
  const base = JulianDate.fromIso8601("2024-04-08T17:15:00Z");
  const scratch = new JulianDate();
  const series = [];
  for (let i = 0; i <= 92; i++) {
    const t = JulianDate.addMinutes(base, i * 2, scratch);
    const sun = computeSunPositionWC(t, new Cartesian3());
    updateEclipseState(state, {
      enabled: true,
      cameraPositionWC: DALLAS,
      sunPositionWC: sun,
      time: t,
      earthOccluderRadius: EARTH_RADIUS,
    });
    series.push(getEclipseSceneLightFactor(state));
  }
  const min = Math.min(...series);
  const argmin = series.indexOf(min);
  assert.equal(min, ECLIPSE_TWILIGHT_FLOOR, "the sweep must reach totality");
  assert.ok(
    argmin > 2 && argmin < series.length - 3,
    "totality must be interior",
  );
  assert.equal(series[0], 1.0, "must start un-eclipsed");
  assert.equal(series[series.length - 1], 1.0, "must recover to identity");
  for (let i = 1; i <= argmin; i++) {
    assert.ok(series[i] <= series[i - 1] + 1e-12, `not falling at step ${i}`);
  }
  for (let i = argmin + 1; i < series.length; i++) {
    assert.ok(
      series[i] >= series[i - 1] - 1e-12,
      `not recovering at step ${i}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The injection sites — one JS multiply each, both backends inheriting
// ─────────────────────────────────────────────────────────────────────────────

const sceneJs = readEngine("Scene/Scene.js");
const frameStateJs = readEngine("Scene/FrameState.js");
const uniformStateJs = readEngine("Renderer/UniformState.js");
const globeJs = readEngine("Scene/Globe.js");
const skyAtmosphereJs = readEngine("Scene/SkyAtmosphere.js");
const webgpuSky = readEngine("Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js");
const conditions = readEngine("Scene/AtmosphericConditions.js");
const webgpuModel = readEngine("Renderer/WebGPU/WebGPUModelRenderer.ts");
const modelPbrWgsl = readEngine("Shaders/WebGPU/Model/ModelPBRComplete.wgsl");
const lightingStageGlsl = readEngine("Shaders/Model/LightingStageFS.glsl");

test("Scene.js publishes ONE factor, before anything can consume it", () => {
  assert.match(
    sceneJs,
    /view\._eclipseSceneLightFactor = getEclipseSceneLightFactor\(/,
  );
  assert.match(
    sceneJs,
    /frameState\.eclipseSceneLightFactor = view\._eclipseSceneLightFactor;/,
  );
  const publishIndex = sceneJs.indexOf(
    "frameState.eclipseSceneLightFactor = view._eclipseSceneLightFactor;",
  );
  const updateIndex = sceneJs.indexOf("uniformState.update(frameState);");
  assert.ok(publishIndex > 0 && updateIndex > 0);
  assert.ok(
    publishIndex < updateIndex,
    "the factor must be published BEFORE uniformState.update — that call is " +
      "re-entered from picking / the viewport executor / offscreen views, and " +
      "every re-entry recomputes the light colour from scratch",
  );
  // The sun position is derived in-module now; feeding it from
  // `uniformState.sunPositionWC` at this point would read LAST frame's sun.
  assert.doesNotMatch(
    sceneJs,
    /scratchEclipseOptions\.sunPositionWC = uniformState\.sunPositionWC;/,
  );
  assert.match(
    sceneJs,
    /scratchEclipseOptions\.autoExposure =\s*eclipseLighting\?\.eclipseAutoExposure === true;/,
  );
});

test("Scene.js scales skyBrightness by the same factor", () => {
  assert.match(
    sceneJs,
    /\) \* \(frameState\.eclipseSceneLightFactor \?\? 1\.0\);/,
  );
});

// `FrameState.eclipseSceneLightFactor` starts life `undefined` and is only
// assigned by `prepareLogicalViewEclipse`. `undefined` is not 1.0 here: a bare
// multiply yields NaN, `?? 1.0` does NOT catch NaN downstream
// (`CubeMapPanorama.js`, `WebGPUCubeMapPanoramaRenderer.js`), and both skybox
// shaders then feed the raw uniform to `clamp`, whose NaN behaviour is
// implementation-defined — one driver blacks the sky, another is fine, and
// nothing reaches the console. So the rule is: NO reader may take the field
// bare. This walks the tree rather than listing sites, because the whole point
// is to catch the reader that has not been written yet.
const ENGINE_SOURCE = path.join(root, "packages/engine/Source");

function engineSourceFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...engineSourceFiles(full));
    } else if (/\.(js|ts)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

test("every reader of the S2 factor defends against an unpublished frame", () => {
  // The publisher, and the two "capture then type-test" readers whose guard is
  // on the following line (each pinned by its own test above/below).
  const PUBLISHER = /frameState\.eclipseSceneLightFactor\s*=[^=]/;
  const GUARDED = [
    /frameState\.eclipseSceneLightFactor \?\?/,
    /const eclipseSceneLightFactor = frameState\.eclipseSceneLightFactor;/,
    /const eclipseFactorRaw = frameState\.eclipseSceneLightFactor;/,
  ];
  const offenders = [];
  let readerCount = 0;
  for (const file of engineSourceFiles(ENGINE_SOURCE)) {
    const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (!source.includes("frameState.eclipseSceneLightFactor")) {
      continue;
    }
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index].trim();
      if (
        !trimmed.includes("frameState.eclipseSceneLightFactor") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        PUBLISHER.test(trimmed)
      ) {
        continue;
      }
      readerCount += 1;
      if (!GUARDED.some((pattern) => pattern.test(trimmed))) {
        offenders.push(`${path.relative(root, file)}:${index + 1}  ${trimmed}`);
      }
    }
  }
  assert.ok(readerCount >= 4, `the scan must find readers, saw ${readerCount}`);
  assert.deepEqual(
    offenders,
    [],
    "these read the S2 factor with no undefined guard",
  );
});

test("FrameState declares the S2 field", () => {
  assert.match(frameStateJs, /this\.eclipseSceneLightFactor = undefined;/);
});

test("UniformState dims the scene light AFTER the LDR clamp, SunLight only", () => {
  assert.match(
    uniformStateJs,
    /const eclipseSceneLightFactor = frameState\.eclipseSceneLightFactor;/,
  );
  assert.match(
    uniformStateJs,
    /light instanceof SunLight &&\s*typeof eclipseSceneLightFactor === "number" &&\s*eclipseSceneLightFactor !== 1\.0/,
  );
  // BOTH outputs: `_lightColorHdr` feeds czm_lightColorHdr / csm_lightColorHdr
  // (model PBR), `_lightColor` feeds czm_lightColor / csm_lightColor and the
  // WebGPU globe camera UB (globe diffuse, phong).
  assert.match(
    uniformStateJs,
    /Cartesian3\.multiplyByScalar\(\s*this\._lightColorHdr,\s*eclipseSceneLightFactor,/,
  );
  assert.match(
    uniformStateJs,
    /Cartesian3\.multiplyByScalar\(\s*this\._lightColor,\s*eclipseSceneLightFactor,/,
  );
  // ORDER: the multiply must come after the `maximumComponent` renormalisation
  // that produces `_lightColor`, or it is swallowed until the factor drops
  // below 1/intensity and then applies at double rate.
  const clampIndex = uniformStateJs.indexOf(
    "const maximumComponent = Cartesian3.maximumComponent(lightColorHdr);",
  );
  const dimIndex = uniformStateJs.indexOf(
    "const eclipseSceneLightFactor = frameState.eclipseSceneLightFactor;",
  );
  assert.ok(
    clampIndex > 0 && dimIndex > clampIndex,
    "multiply must follow the clamp",
  );
});

test("Globe.js dims the ground atmosphere + fog through the one shared mirror", () => {
  // `tileProvider.atmosphereLightIntensity` is read by WebGL
  // (GlobeSurfaceTileProviderRendering -> AtmosphereCommon.glsl, whose result
  // IS GlobeFS' fog colour) and by WebGPU (WebGPUGlobeSurfaceCameraUB /
  // WebGPUGlobeSurfaceTileUB -> GlobeTerrain.wgsl). One JS line, both backends.
  assert.match(
    globeJs,
    /tileProvider\.atmosphereLightIntensity =\s*this\.atmosphereLightIntensity \*\s*\(frameState\.eclipseSceneLightFactor \?\? 1\.0\);/,
  );
  // The user-facing property itself must never be mutated.
  assert.doesNotMatch(
    globeJs,
    /this\.atmosphereLightIntensity =\s*this\.atmosphereLightIntensity \*/,
  );
});

test("both backends dim the sky-atmosphere shell with the same scalar", () => {
  // WebGL.
  assert.match(skyAtmosphereJs, /this\._eclipseLightFactor = 1\.0;/);
  assert.match(
    skyAtmosphereJs,
    /return that\.atmosphereLightIntensity \* that\._eclipseLightFactor;/,
  );
  assert.match(
    skyAtmosphereJs,
    /this\._eclipseLightFactor = frameState\.eclipseSceneLightFactor \?\? 1\.0;/,
  );
  // Refreshed FIRST in update(), so it is current for the WebGPU feature
  // renderer's pack and for the WebGL closure at draw time.
  const updateIndex = skyAtmosphereJs.indexOf("update(frameState, globe) {");
  const setIndex = skyAtmosphereJs.indexOf(
    "this._eclipseLightFactor = frameState.eclipseSceneLightFactor ?? 1.0;",
  );
  const modeGuard = skyAtmosphereJs.indexOf("const mode = frameState.mode;");
  assert.ok(
    updateIndex > 0 && setIndex > updateIndex,
    "must live inside update()",
  );
  assert.ok(
    modeGuard > setIndex,
    "must precede update()'s show / mode / pass early-returns",
  );

  // WebGPU.
  assert.match(
    webgpuSky,
    /uniformData\[39\] =\s*\(skyAtmosphere\.atmosphereLightIntensity \|\| 50\.0\) \*\s*\(skyAtmosphere\._eclipseLightFactor \?\? 1\.0\);/,
  );
  // The LUT BAKE input must stay UNdimmed — it is debounced on sun direction,
  // which barely moves across an eclipse, so a dimmed bake latches.
  assert.match(
    webgpuSky,
    /const intensity = skyAtmosphere\.atmosphereLightIntensity \|\| 50\.0;/,
  );
});

test("WebGPU model direct lighting carries the factor too (site 5)", () => {
  // THE CROSS-BACKEND DIVERGENCE THIS EXISTS TO PREVENT. WebGL models read
  // `czm_lightColorHdr`, which UniformState already dims. `ModelPBRComplete
  // .wgsl` reads NONE of the `csm_lightColor*` automatic uniforms — its direct
  // term is fed raw from `frameState.light` by `packLightUniforms`. Without
  // the multiply there, an eclipse dims the WebGL scene and the WebGPU
  // globe/sky while WebGPU glTF + 3D-Tiles models stay full-bright on top of a
  // darkened world: precisely the C12 exit-gate class for a default-ON
  // multiplier.

  // The premise, re-verified here rather than assumed — if the WGSL ever
  // starts reading a dimmed automatic uniform, this pin should be revisited
  // rather than silently doubled up.
  assert.match(
    modelPbrWgsl,
    /light\.sunColor \* light\.sunIntensity \* NdotL/,
    "the WGSL direct term is no longer sunColor*sunIntensity — re-derive site 5",
  );
  assert.doesNotMatch(
    modelPbrWgsl,
    /csm_lightColor/,
    "the WGSL now reads a csm_ light uniform — site 5 may be double-dimming",
  );
  assert.match(
    lightingStageGlsl,
    /czm_lightColorHdr/,
    "WebGL models must still take their light from the dimmed automatic uniform",
  );

  // The gate: same `instanceof SunLight` semantics as site 1, same published
  // scalar. The aerial-perspective derived light is itself a `SunLight`
  // (`Scene._atmosphereDerivedLight`), so that sub-case is covered by the
  // same branch rather than by a second one.
  assert.match(
    webgpuModel,
    /import SunLight from "\.\.\/\.\.\/Scene\/SunLight\.js";/,
  );
  assert.match(
    webgpuModel,
    /const eclipseFactorRaw = frameState\.eclipseSceneLightFactor;/,
  );
  assert.match(
    webgpuModel,
    /light instanceof SunLight && typeof eclipseFactorRaw === "number"\s*\?\s*eclipseFactorRaw\s*:\s*1\.0;/,
  );
  // The direct term: colour, not intensity — `data[7]` must keep carrying the
  // user's own `light.intensity` untouched.
  assert.match(webgpuModel, /data\[4\] = lightColor\.red \* eclipseFactor;/);
  assert.match(webgpuModel, /data\[5\] = lightColor\.green \* eclipseFactor;/);
  assert.match(webgpuModel, /data\[6\] = lightColor\.blue \* eclipseFactor;/);
  assert.match(webgpuModel, /data\[7\] = light\?\.intensity \?\? 2\.0;/);
  // The no-light fallback dims too, or a scene with `light.color` unset would
  // be the one configuration that stays bright.
  assert.match(webgpuModel, /data\[4\] = eclipseFactor;/);
  // The models' ambient — genuinely sun-driven, and computed before the
  // eclipse state is published, so this is its only dimming site.
  assert.match(webgpuModel, /data\[8\] = skyIrradiance\.x \* eclipseFactor;/);
  assert.match(webgpuModel, /data\[9\] = skyIrradiance\.y \* eclipseFactor;/);
  assert.match(webgpuModel, /data\[10\] = skyIrradiance\.z \* eclipseFactor;/);
  // The 0.2 neutral floor is NOT a sun term; dimming it would drive models to
  // black at totality, which is what the twilight floor exists to prevent.
  assert.match(webgpuModel, /data\[8\] = 0\.2;/);
  assert.doesNotMatch(webgpuModel, /data\[8\] = 0\.2 \* eclipseFactor;/);
  // And the frameState field must be declared for the TS augmentation.
  assert.match(webgpuModel, /eclipseSceneLightFactor\?: number;/);

  // UniformState must no longer claim it covers every backend path.
  assert.match(
    uniformStateJs,
    /IT IS NOT UNIVERSAL ON WEBGPU/,
    "the site-1 comment must name the site-5 exception",
  );
});

test("sites 1 and 5 apply the SAME transfer, in either multiply order", () => {
  // Numeric pin on the shared arithmetic. Site 1 dims `color * intensity`
  // (UniformState builds `lightColorHdr`, clamps, then multiplies); site 5
  // dims `color` and lets the shader multiply by `intensity`. Both must be
  // driven by the ONE published factor — not the linear flux on one side and
  // the eye-adapted value on the other, and never `sunVisibleFraction`.
  //
  // The two orders are NOT bit-identical in general, and pretending otherwise
  // would be a false pin: IEEE multiplication is not associative, so
  // `(c*I)*f` and `(c*f)*I` can differ by an ulp. What IS exact — and what
  // actually matters — is the identity case: `x * 1.0 === x` exactly, in
  // either order, so a no-eclipse frame is bit-identical on both paths. The
  // eclipsed case is pinned at a few ulp instead.
  const intensities = [2.0, 1.0, 7.3, 0.25];
  const channels = [1.0, 0.9490196078431372, 0.7, 0.13];
  let sawOrderDifference = false;
  for (let i = 0; i <= 200; i++) {
    const obs = i / 200;
    for (const autoExposure of [false, true]) {
      const factor = getEclipseSceneLightFactor(
        stateWith(obs, { autoExposure }),
      );
      for (const intensity of intensities) {
        for (const c of channels) {
          const site1 = c * intensity * factor; // dim the HDR product
          const site5 = c * factor * intensity; // dim the colour, shader scales
          if (site1 !== site5) {
            sawOrderDifference = true;
          }
          const rel = Math.abs(site1 - site5) / Math.max(site1, 1e-30);
          assert.ok(
            rel < 1e-14,
            `transfer differs by ${rel} at obscuration ${obs}, c=${c}, I=${intensity}`,
          );
          if (obs === 0) {
            // Identity, exactly, on BOTH paths — the byte-identity claim.
            assert.equal(factor, 1.0);
            assert.equal(site1, c * intensity);
            assert.equal(site5, c * intensity);
          }
        }
      }
    }
  }
  // Non-vacuity for the tolerance above: if the two orders were somehow
  // bit-identical everywhere, the ulp band would be untested slack.
  assert.ok(
    sawOrderDifference,
    "expected at least one ulp-level order difference across the sweep",
  );
});

test("the E2 toggle exists on AtmosphericConditions and defaults OFF", () => {
  assert.match(conditions, /eclipseAutoExposure: false,/);
  assert.match(conditions, /C12-29 S2/);
  // enableEclipse stays default-ON (ruling E1) — S2 must not have flipped it.
  assert.match(conditions, /enableEclipse: true,/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The probe harness's rung ladder
// ─────────────────────────────────────────────────────────────────────────────

test("a TOTAL-eclipse ladder passes derivation", () => {
  // THE REGRESSION. The separation predicate was `cur > prev + 0.1` (STRICT)
  // against targets ending `[0.9, min(best.o, 1.0)]`. The 2026-08-12 eclipse
  // is TOTAL, so the last target clamps to exactly 1.0, and `0.9 + 0.1` rounds
  // to exactly `1.0` in IEEE double — so `1.0 > 1.0` was false and this
  // perfectly good ladder aborted the whole Edge cycle as "rungs collapsed",
  // before a single measurement was taken. Every total or near-total eclipse
  // tripped it by construction, i.e. exactly the eclipses the probe exists for.
  const totalLadder = [0.0, 0.35, 0.651, 0.9, 1.0].map((o, i) => ({
    iso: `2026-08-12T17:4${i}:00Z`,
    obscuration: o,
  }));
  const verdict = validateLadderSeparation(totalLadder);
  assert.equal(verdict.ok, true, verdict.reason);

  // The exact-tie case on its own, at the ORIGINAL bar — the arithmetic that
  // produced the abort. `>=` plus the epsilon is what makes this pass.
  assert.equal(0.9 + 0.1, 1.0, "the IEEE tie this test is about");
  assert.equal(
    validateLadderSeparation([
      { obscuration: 0.9 },
      { obscuration: 0.9 + MIN_RUNG_SEPARATION },
    ]).ok,
    true,
    "an exact tie at the bar must PASS — equality must never be the discriminator",
  );

  // And the ladder the fixed targets actually produce against a total eclipse:
  // the derivation appends the clamped maximum as the fifth rung.
  const derivedLikeTotal = [...LADDER_TARGETS, 1.0].map((o) => ({
    obscuration: o,
  }));
  assert.equal(validateLadderSeparation(derivedLikeTotal).ok, true);
});

test("the ladder tolerates realistic pick jitter, and still rejects a collapse", () => {
  // The rungs are the instants CLOSEST to each target, not the targets. On
  // 10-second stepping through the steep part of the curve the deep rung can
  // overshoot by ~1e-3, which is three orders of magnitude beyond any epsilon
  // — so the tolerance has to come from the TARGET SPACING, not from the
  // comparison. This is why lowering the 4th target was not optional and an
  // epsilon alone would not have fixed the class.
  const jittered = [0.0007, 0.3512, 0.6489, 0.8531, 1.0].map((o) => ({
    obscuration: o,
  }));
  assert.equal(validateLadderSeparation(jittered).ok, true);

  // A genuinely collapsed ladder must still be caught — the check has to keep
  // its teeth. A shallow partial peaking just above the 4th target gives the
  // ladder nothing to measure across.
  const collapsed = [
    { iso: "a", obscuration: 0.0 },
    { iso: "b", obscuration: 0.35 },
    { iso: "c", obscuration: 0.65 },
    { iso: "d", obscuration: 0.85 },
    { iso: "e", obscuration: 0.87 },
  ];
  const bad = validateLadderSeparation(collapsed);
  assert.equal(bad.ok, false);
  // The message must name the ACTUAL failing pair and the predicate. The old
  // one printed the whole ladder with no indication of which pair failed or
  // what the bar was, which is why a harness defect read as a data problem.
  assert.equal(bad.failedPair.index, 4);
  assert.equal(bad.failedPair.previousIso, "d");
  assert.equal(bad.failedPair.iso, "e");
  assert.ok(Math.abs(bad.failedPair.gap - 0.02) < 1e-9);
  assert.match(bad.reason, /between rung 3 and rung 4/);
  assert.match(bad.reason, /gap of 0\.020000/);
  assert.match(
    bad.predicate,
    /obscuration\[k\] >= obscuration\[k-1\] \+ 0\.05/,
  );
});

test("the ladder targets are ascending, separated, and headroomed", () => {
  assert.deepEqual(LADDER_TARGETS, [0.0, 0.35, 0.65, 0.85]);
  for (let i = 1; i < LADDER_TARGETS.length; i++) {
    assert.ok(
      LADDER_TARGETS[i] >= LADDER_TARGETS[i - 1] + MIN_RUNG_SEPARATION,
      `targets ${i - 1}..${i} are not separated`,
    );
  }
  // The load-bearing margin: the gap between the deepest FIXED target and a
  // total eclipse must be comfortably above the enforced bar, or pick jitter
  // reintroduces the abort. 0.15 against 0.05 is 3x.
  const topGap = 1.0 - LADDER_TARGETS[LADDER_TARGETS.length - 1];
  assert.ok(
    topGap >= 3 * MIN_RUNG_SEPARATION,
    `top gap ${topGap} leaves too little headroom over ${MIN_RUNG_SEPARATION}`,
  );
  assert.ok(RUNG_SEPARATION_EPSILON > 0 && RUNG_SEPARATION_EPSILON < 1e-6);

  // Degenerate inputs must be reported, not thrown on.
  assert.equal(validateLadderSeparation(undefined).ok, false);
  assert.equal(validateLadderSeparation([{ obscuration: 0.5 }]).ok, false);
  assert.equal(
    validateLadderSeparation([{ obscuration: 0 }, { obscuration: NaN }]).ok,
    false,
  );
});

test("the probe reads its targets from the shared module, not a literal", () => {
  // The targets cross into `page.evaluate` as DATA (module-scope bindings do
  // not cross the serialization boundary). If the probe ever re-inlines them,
  // the pins above stop protecting anything.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-scene-dimming.mjs"),
    "utf8",
  );
  assert.match(probe, /from "\.\/eclipse-ladder-rungs\.mjs"/);
  assert.match(
    probe,
    /const targets = \[\.\.\.fixedTargets, Math\.min\(best\.o, 1\.0\)\];/,
  );
  assert.match(probe, /fixedTargets: LADDER_TARGETS,/);
  assert.match(
    probe,
    /const separation = validateLadderSeparation\(derived\.ladder\);/,
  );
  // The in-page copy must be GONE — two predicates would drift.
  assert.doesNotMatch(probe, /ladder rungs collapsed: \$\{picks/);
  assert.doesNotMatch(
    probe,
    /picks\[k\]\.obscuration > picks\[k - 1\]\.obscuration \+ 0\.1/,
  );
});

test("the probe instruments survive the three Edge-cycle findings", () => {
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-scene-dimming.mjs"),
    "utf8",
  );
  const sunFade = fs.readFileSync(
    path.join(here, "probe-eclipse-sun-fade.mjs"),
    "utf8",
  );

  // I1 — the sky band is shell + revealed background, so the background must
  // be MEASURED (shell hidden) in both toggle positions and the prediction
  // bracketed by it. Gating on the shell-only prediction alone under-predicts
  // at depth and false-fails.
  assert.match(probe, /scene\.skyAtmosphere\.show = false;/);
  assert.match(
    probe,
    /scene\.skyAtmosphere\.show = skyShown;/,
    "the shell must be restored after the background capture",
  );
  assert.match(probe, /predictedSkyWithBackground/);
  assert.match(probe, /backgroundRevealExplains/);
  // The hypothesis must be falsifiable, not assumed: `cRecovered` is solved
  // back out of the measurement and compared against the available background.
  assert.match(probe, /const recoverC = \(meanOff, meanOn, f\) =>/);
  // And S2 must not be reaching the star field — that is an S6/E3 decision.
  assert.match(probe, /backgroundIsToggleInvariant/);
  assert.doesNotMatch(
    probe,
    /enableStarBrightnessModulation\s*=/,
    "the probe must never dim the stars to make its own prediction fit",
  );

  // I3 — the visual lane must be captured in the SAME TASK as its render.
  // A post-evaluate `locator('canvas').screenshot()` captures the restored
  // default view (live wall clock, no globe) and ships an empty lane.
  assert.match(probe, /shots\.deepestOff = grabCanvas\(\);/);
  assert.match(probe, /shots\.deepestOn = grabCanvas\(\);/);
  assert.match(probe, /canvas\.toDataURL\("image\/png"\)/);
  assert.doesNotMatch(
    probe,
    /\.locator\("canvas"\)/,
    "the post-evaluate canvas screenshot must be gone — it captured the restored view",
  );

  // I2 — the S1 probe's luminance proxy is blend-model dependent:
  //   WebGL  ALPHA_BLEND: out - dst = a*(src - dst)   <- depends on the sky
  //   WebGPU additive   : out - dst = a*src           <- immune
  // S2 dims `dst`, so WebGL's raw ratio over-reports. The correction uses the
  // measured sun-hidden sums that the four-render pattern already produces.
  assert.match(
    sunFade,
    /const dstDelta = Math\.max\(0, inst\.off\.bgSum - inst\.on\.bgSum\);/,
  );
  assert.match(sunFade, /const isAdditiveBlend = name === "webgpu";/);
  // The dst lift is applied on the ALPHA_BLEND backend only. (R2 later made
  // the lift space-aware — `liftGated` — so the pin tracks that name.)
  assert.match(sunFade, /isAdditiveBlend \? 1 : 1 \+ liftGated/);
  assert.match(sunFade, /ratioGated < linearUpper/);
  assert.match(sunFade, /bgSum \+= dOff;/);
  // S1's actual CONTRACT must still be checked exactly — the blend model
  // corrects the proxy, never the claim.
  assert.match(
    sunFade,
    /Math\.abs\(inst\.on\.alpha - s\.sunVisibleFraction\) < 1e-12,/,
  );
});

test("the gates are model-free: equivalence, not prediction", () => {
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-scene-dimming.mjs"),
    "utf8",
  );
  const sunFade = fs.readFileSync(
    path.join(here, "probe-eclipse-sun-fade.mjs"),
    "utf8",
  );

  // R1 — after three rounds in which every physical model (display gamma,
  // PBR-Neutral shoulder, background reveal) explained part of the sky band
  // and leaked elsewhere, the gate now tests S2's LITERAL contract: the
  // eclipse path must match the same factor applied by hand through the
  // injection sites' public surfaces. Every nonlinearity then applies to both
  // paths and cancels.
  // F3 — the band was CALIBRATED on the terminal Edge cycle and tightened
  // (WebGL worst 5.876e-7; WebGPU bit-identical, 8 of 8 bands). Still >100x
  // headroom, 200x tighter than the opening estimate. The measured numbers
  // must stay in the file with the constants they justify.
  assert.match(probe, /const EQUIV_REL = 1\.0e-4;/);
  assert.match(probe, /const EQUIV_ABS = 1\.0e-5;/);
  assert.match(
    probe,
    /5\.876e-7/,
    "the calibration evidence must stay recorded",
  );
  assert.match(probe, /BIT-IDENTICAL, 8 of 8 bands/);

  // F1 — site 3's mirror must be read IMMEDIATELY AFTER the ON render. It used
  // to be read down in the manual block, which sits after the auto-exposure
  // capture; that capture renders with `eclipseAutoExposure = true` and the
  // flag is then reset WITHOUT a re-render, so `Globe.beginFrame` never runs
  // again and the mirror still holds `base * f_AE` — the CAMERA-mode factor.
  // The comparison failed on a stale read while the engine was correct.
  // The pin is whitespace-tolerant BY REGEX, not a literal `indexOf`. The
  // literal form embedded a bare `\n` and a fixed indent, so it could not match
  // a CRLF working tree and would break on any re-wrap — the fragile-pin class
  // that has now cost this fleet six cycles (see
  // `lib/provenance-markers.mjs`, which rejects exactly this shape).
  const mirrorMatch =
    /const engineMirror\s*=\s*scene\.globe\?\._surface\?\.tileProvider\?\.atmosphereLightIntensity/.exec(
      probe,
    );
  const mirrorRead = mirrorMatch ? mirrorMatch.index : -1;
  const aeRender = probe.indexOf("ac.lighting.eclipseAutoExposure = true;");
  assert.ok(mirrorRead > 0, "the engineMirror read moved or changed shape");
  assert.ok(
    aeRender > mirrorRead,
    "engineMirror must be read BEFORE the auto-exposure capture — anything " +
      "that renders in between leaves the mirror holding another factor",
  );
  assert.doesNotMatch(
    probe,
    /captured BEFORE anything moves/,
    "the old stale-read comment must not survive the fix",
  );
  assert.match(probe, /v\.equivalenceOk =/);
  assert.match(probe, /v\.equivalenceOk &&/, "equivalence must be in PASS");
  // Batch 770 — S6's additive horizon glow is a separate feature from S2's
  // multiplicative contract. Keep it on for the shipped ON capture, then turn
  // it off only for the engine/manual equivalence pair. The dedicated S6 probe
  // gates the glow itself, so the isolation cannot hide a removed feature.
  // Batch 873: S5's per-fragment globe umbra is isolated in the SAME block for
  // the same reason, so the pin now spans both switches. Keeping them adjacent
  // is the point — one render must follow both, or the reference frame carries
  // one sub-effect and not the other.
  assert.match(
    probe,
    /ac\.lighting\.enableEclipseHorizonTwilight = false;\s*ac\.lighting\.enableEclipseGlobeShadow = false;\s*scene\.render\(T\(\)\);\s*equivalentOnState = readState\(\);/,
  );
  assert.match(probe, /engineReference:\s*\{/);
  assert.match(probe, /horizonTwilightIsolated/);
  // The site-4 source must be the isolated human-eye frame. Reading mutable
  // frameState here observes the intervening auto-exposure render and mixes
  // factors from two different frames.
  assert.match(probe, /const B = equivalentOnState\.skyBrightness;/);
  assert.doesNotMatch(probe, /const B = scene\.frameState\?\.skyBrightness;/);
  // Browser evidence is offline and non-empty; `tilesLoaded` alone can pass an
  // empty/no-tile frame.
  assert.match(probe, /renderer=\$\{renderer\}&offline=true/);
  assert.match(probe, /tilesToRender > 0/);
  // Ground claims are restricted to pixels proven responsive by a
  // white-vs-black globe base-color A/B. Tile counts alone cannot make an
  // absent near-limb globe pass.
  assert.match(probe, /groundMask = new Uint8Array\(n\);/);
  assert.match(probe, /responsiveFraction >= 0\.25/);
  assert.match(probe, /meanAbsoluteResponse >= 0\.05/);
  assert.match(probe, /v\.terrainResponsive/);
  assert.match(probe, /v\.terrainResponsive &&/);
  assert.match(probe, /const aeLuminanceTolerance = 1e-4;/);
  assert.match(probe, /v\.aeDimmingNonVacuous/);
  assert.match(
    probe,
    /v\.aeRendersDarker &&\s*v\.aeDimmingNonVacuous/,
    "the quantisation tolerance must be paired with a non-vacuous dimming gate",
  );
  // The manual twin must reproduce sites 1, 2 and 3 — and VERIFY site 3's
  // mirror rather than assuming it follows.
  assert.match(
    probe,
    /scene\.light = new C\.SunLight\(\{\s*color: new C\.Color\(f, f, f, 1\.0\),/,
  );
  assert.match(
    probe,
    /scene\.skyAtmosphere\.atmosphereLightIntensity = savedSkyIntensity \* f;/,
  );
  assert.match(
    probe,
    /scene\.globe\.atmosphereLightIntensity = savedGlobeIntensity \* f;/,
  );
  assert.match(probe, /mirrorMatches/);
  // Site 1's manual twin is only exact when the LDR clamp never fires, which
  // is why the probe forces intensity 1.0 — at the stock 2.0 a manual factor
  // above 0.5 is renormalised straight back out.
  assert.match(probe, /const BASE_LIGHT_INTENSITY = 1\.0;/);
  // Site 4's exclusion must stay tied to the fact that justifies it, and the
  // aerial-perspective precondition must be asserted, not trusted.
  assert.match(probe, /enableStarBrightnessModulation is on/);
  assert.match(probe, /scene\.aerialPerspective === true/);
  // Leak-proof restore of every manual value.
  assert.match(probe, /scene\.light = savedLight;/);
  assert.match(
    probe,
    /scene\.skyAtmosphere\.atmosphereLightIntensity = savedSkyIntensity;/,
  );
  assert.match(
    probe,
    /scene\.globe\.atmosphereLightIntensity = savedGlobeIntensity;/,
  );
  // The predictive machinery is KEPT, as reported-only documentation of the
  // saturating-shell physics — it must not be gating any more.
  assert.match(probe, /skyBracketOkReportedOnly/);
  assert.match(probe, /groundBracketOkReportedOnly/);
  assert.doesNotMatch(probe, /v\.skyBracketOk &&/);
  assert.doesNotMatch(probe, /v\.groundBracketOk &&/);
  assert.match(probe, /backgroundRevealExplainsAll/);

  // R2 — a linear-space law cannot be read off display-encoded pixels. Both
  // spaces are computed; which one each backend's blend operates in is
  // determined BY MEASUREMENT, with the additive backend as the control.
  assert.match(sunFade, /const srgbToLinear = \(b\) => \{/);
  assert.match(sunFade, /glowSumLinear \+= Math\.abs\(lOn - lOff\);/);
  assert.match(sunFade, /bgSumLinear \+= lOff;/);
  assert.match(sunFade, /blendSpace/);
  assert.match(sunFade, /additiveControlIsExact/);
  // The additive control must GATE, not merely report. (F2 folded it into
  // `alphaIsLinearMeasured` and then gated that on the additive backend only —
  // see the dedicated structural test.)
  assert.match(
    sunFade,
    /ratioGated < linearUpper &&\s*additiveControlIsExact;/,
    "the control must gate, not merely report",
  );
  assert.match(
    sunFade,
    /laneB\.additiveControlIsExact = additiveControlIsExact;/,
  );
  // The dst correction has to be computed in the SAME space as the ratio.
  assert.match(
    sunFade,
    /const liftGated = blendSpace === "display" \? dstLift : dstLiftLinear;/,
  );
});

test("each backend carries a GATED eclipse-alpha application proof", () => {
  // F2 — ORCHESTRATOR RULING. The WebGL sun-glow luminance ratio is
  // REPORTED-NOT-GATED: three independent models (naive linear, dst-corrected
  // display, dst-corrected linear) all failed against it, and the measured
  // 0.2089 sits BELOW the analytic floor `f` in BOTH spaces — which no dst
  // term and no encoding can produce. Widening a band around a confounded
  // proxy only makes the gate mean less.
  //
  // What replaces it is STRUCTURAL, and this test is the pin: the gated set is
  // symmetric by PHYSICS, not by shape. Each backend must still carry at least
  // one gated proof that the alpha reaches pixels — WebGL via laneC's
  // primary-masked band ratio, WebGPU via laneB linearity (analytic under its
  // additive blend, whose control is checked alongside). If a future change
  // flips a backend's blend model — C11-115 moving WebGPU to ALPHA_BLEND is
  // the live candidate — the additive control disappears, laneB stops being
  // analytic on that backend, and the gating lane MUST be re-derived. This
  // test is written to fail loudly at that moment rather than let a backend
  // silently end up with no gated pixel proof at all.
  const sunFade = fs.readFileSync(
    path.join(here, "probe-eclipse-sun-fade.mjs"),
    "utf8",
  );

  // The luminance proxy is gated ONLY on the additive backend.
  assert.match(
    sunFade,
    /if \(isAdditiveBlend\) \{\s*\/\/[^]*?laneB\.additiveControlIsExact = additiveControlIsExact;\s*laneB\.alphaIsLinear = alphaIsLinearMeasured;\s*\}/,
    "alphaIsLinear must enter the gated laneB set only under the additive blend",
  );
  // ...but it is still MEASURED on both, so the trail survives.
  assert.match(sunFade, /alphaIsLinearMeasured,/);
  assert.match(sunFade, /laneBDiagnostics/);

  // S1's actual contract stays gated on BOTH backends, always.
  assert.match(
    sunFade,
    /\/\/ S1's contract, bit-for-bit\. Gated on BOTH backends, always\.\s*alphaEqualsFraction:/,
  );

  // The structural requirement itself, and its presence in PASS.
  assert.match(sunFade, /const applicationProof = isAdditiveBlend/);
  assert.match(sunFade, /gatedLane: "laneB\.alphaIsLinear",/);
  assert.match(sunFade, /gatedLane: "laneC\.eclipseVisiblyApplied",/);
  assert.match(sunFade, /applicationProof\.gatedResult === true,/);

  // The re-derivation warning must stay attached to the ruling.
  assert.match(sunFade, /IF A FUTURE CHANGE FLIPS A BACKEND'S BLEND MODEL/);
  // And the refutation history must stay in the file — it is the reason the
  // WebGL proxy is not gated, and without it the next session re-runs all
  // three models.
  assert.match(sunFade, /naive linear/);
  assert.match(sunFade, /dst-corrected display/);
  assert.match(sunFade, /dst-corrected linear/);
  assert.match(sunFade, /BELOW the analytic floor `f` in BOTH\s*\/\/ spaces/);

  // laneB must be boolean-only, since the verdict aggregate is
  // `Object.values(laneB).every(Boolean)` — a numeric diagnostic that
  // legitimately measures 0 would otherwise fail the whole lane.
  assert.match(sunFade, /Object\.values\(laneB\)\.every\(Boolean\)/);
  assert.doesNotMatch(
    sunFade,
    /const laneB = \{[^]*?ratioDisplay:/,
    "numeric diagnostics must live in laneBDiagnostics, not in the gated laneB",
  );
});

test("S2 is JS-uniform-only: no shader edits, no new define bit", () => {
  // Every S2 value routes through a shared JS uniform source, which is why
  // both backends inherit one change. If a future edit needs a shader, it
  // needs a WGSL *and* a GLSL half (Principle 5) and this pin should be
  // updated deliberately rather than deleted.
  for (const p of [
    "Shaders/GlobeFS.glsl",
    "Shaders/AtmosphereCommon.glsl",
    "Shaders/Builtin/Functions/computeAtmosphereColor.glsl",
    "Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
    "Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
    "Shaders/WebGPU/Model/ModelPBRComplete.wgsl",
    "Shaders/Model/LightingStageFS.glsl",
  ]) {
    assert.doesNotMatch(
      readEngine(p),
      /eclipseSceneLightFactor|eclipseLightFactor/,
      `${p} gained an S2 shader edit`,
    );
  }
  assert.doesNotMatch(
    readEngine("Renderer/WebGPU/WebGPUShaderDefines.ts"),
    /ECLIPSE/i,
    "C12 exit-gate item 5: runtime uniforms only",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Batch 873 — the equivalence gate's TWO blind spots, found by an Edge run
// that failed at worst relative 9e-3 against a 1e-4 bound.
//
// The suspicion at the time was embedded-copy drift: the probe carries its own
// SECOND implementation of the S2 constants (deliberately — so a silent engine
// retune fails the probe instead of riding along with it), and Batch 865 had
// just refactored `SolarDiscModel.js`. That hypothesis is REFUTED below by
// value comparison: the probe's constants and the shipped module's are equal
// to the bit. The real cause was a NEW sub-effect — C12-29 S5's per-fragment
// globe umbra, default ON since 2026-07-25, one day after the gate's
// calibration — that the manual twin cannot reproduce and did not isolate.
//
// Both findings get a pin so neither class can recur silently.
// ───────────────────────────────────────────────────────────────────────────

const readProbeText = () =>
  fs
    .readFileSync(path.join(here, "probe-eclipse-scene-dimming.mjs"), "utf8")
    .replace(/\r\n/g, "\n");

test("the probe's EMBEDDED S2 constants equal the shipped module's, by VALUE", () => {
  // The probe cannot import the engine (it runs its arithmetic in the Node
  // half and its scene setup inside `page.evaluate`, where a closure does not
  // survive), so the constants are embedded text. Embedded text drifts. This
  // extracts the probe's literals and compares them to the module's EXPORTS —
  // a value comparison, not a text comparison, so a legitimate reformat does
  // not fail and a changed NUMBER always does.
  const probe = readProbeText();

  const grab = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(probe);
    assert.ok(m, `${name} is no longer a single-expression const in the probe`);
    // Only arithmetic on numeric literals is permitted here, which is exactly
    // what the probe writes (`5.0 / 100000.0`, `1.0 / 3.0`).
    assert.match(
      m[1],
      /^[\d.eE+\-*/() ]+$/,
      `${name} in the probe is no longer a literal arithmetic expression`,
    );
    // The guard above restricts the text to numeric literals, `*`, `/` and
    // parentheses, so compiling it can only produce a number. Same technique
    // (and same disable) as `solar-glare-star-washout.spec.mjs`, which is how
    // this fleet compares an embedded copy against a shipped one by VALUE
    // rather than by text.
    // eslint-disable-next-line no-new-func
    return Number(new Function(`return (${m[1]});`)());
  };

  assert.equal(grab("ECLIPSE_RADIOMETRIC_FLOOR"), ECLIPSE_RADIOMETRIC_FLOOR);
  assert.equal(
    grab("ECLIPSE_ADAPTATION_EXPONENT"),
    ECLIPSE_ADAPTATION_EXPONENT,
  );
  // ...and the ratio the probe writes out longhand must be the same ratio the
  // module builds from the two published illuminances.
  assert.equal(
    ECLIPSE_TOTALITY_ILLUMINANCE / ECLIPSE_FULL_SUN_ILLUMINANCE,
    ECLIPSE_RADIOMETRIC_FLOOR,
  );

  // The probe's derived floor must agree with the module's, computed the same
  // way (`Math.pow`, not `Math.cbrt` — the module says why).
  const expected = Math.pow(
    ECLIPSE_RADIOMETRIC_FLOOR,
    ECLIPSE_ADAPTATION_EXPONENT,
  );
  assert.match(
    probe,
    /const EXPECTED_TWILIGHT_FLOOR = Math\.pow\(\s*ECLIPSE_RADIOMETRIC_FLOOR,\s*ECLIPSE_ADAPTATION_EXPONENT,\s*\);/,
  );
  assert.equal(expected, ECLIPSE_TWILIGHT_FLOOR);

  // And the probe's second implementation of the curve must agree with the
  // shipped one at every rung the gate actually visits. Evaluated, not read.
  const predict =
    /function predictFactor\(obscuration, autoExposure\) \{[\s\S]*?\n\}/.exec(
      probe,
    );
  assert.ok(predict, "predictFactor moved or changed shape");
  // Compiling the probe's OWN function text is the point: a text comparison
  // would fail on a reformat and pass on a changed constant, which is the
  // wrong way round for a drift guard.
  // eslint-disable-next-line no-new-func
  const probeCurve = new Function(
    "ECLIPSE_RADIOMETRIC_FLOOR",
    "ECLIPSE_ADAPTATION_EXPONENT",
    `${predict[0]}; return predictFactor;`,
  )(ECLIPSE_RADIOMETRIC_FLOOR, ECLIPSE_ADAPTATION_EXPONENT);
  for (const o of [0, 0.35, 0.65, 0.9, 0.99, 0.999, 1]) {
    for (const ae of [false, true]) {
      assert.equal(
        probeCurve(o, ae),
        eclipseSceneLightCurve(o, ae),
        `probe curve disagrees at obscuration ${o}, autoExposure ${ae}`,
      );
    }
  }
});

test("the equivalence gate isolates BOTH orthogonal sub-effects (S6 and S5)", () => {
  // S5 (`enableEclipseGlobeShadow`) dims the globe per FRAGMENT and is gated on
  // `enableEclipse`, so the manual twin — which runs with the eclipse off —
  // never draws it. Leaving it on makes the gate compare "S2 + S5" against
  // "S2": a guaranteed failure that grows with obscuration and says nothing
  // about S2's contract. Its own docstring prescribes this isolation.
  const probe = readProbeText();

  // The shipped default must be asserted, or the isolation could be a no-op.
  assert.match(probe, /enableEclipseGlobeShadow toggle is absent/);
  assert.match(
    probe,
    /enableEclipseGlobeShadow no longer has its shipped default-on value/,
  );

  // Isolated in the engine-reference capture, alongside S6...
  assert.match(
    probe,
    /ac\.lighting\.enableEclipseHorizonTwilight = false;\s*ac\.lighting\.enableEclipseGlobeShadow = false;/,
  );
  // ...restored immediately after it...
  assert.match(
    probe,
    /ac\.lighting\.enableEclipseHorizonTwilight = true;\s*ac\.lighting\.enableEclipseGlobeShadow = true;/,
  );
  // ...recorded...
  assert.match(probe, /globeShadowIsolated = true;/);
  assert.match(
    probe,
    /globeShadowIsolated: m\.engineReference\?\.globeShadowIsolated === true,/,
  );
  // ...and REQUIRED by the verdict, not merely reported.
  assert.match(probe, /m\.engineReference\?\.globeShadowIsolated === true &&/);

  // The tolerance must NOT have been widened to absorb S5.
  assert.match(probe, /const EQUIV_REL = 1\.0e-4;/);
  assert.match(probe, /const EQUIV_ABS = 1\.0e-5;/);

  // The finding stays recorded next to the constant it explains.
  assert.match(probe, /enableEclipseGlobeShadow` landed default-ON/);
});

test("S5's globe umbra really is gated on enableEclipse (the reason it needs isolating)", () => {
  // If this stops being true, the manual twin WOULD see the umbra and the
  // isolation becomes unnecessary rather than load-bearing — a change that
  // must be made deliberately, not discovered by a failing Edge run.
  const shadow = readEngine("Scene/EclipseGlobeShadow.js").replace(
    /\r\n/g,
    "\n",
  );
  assert.match(
    shadow,
    /eclipseLighting\?\.enableEclipse !== false &&\s*eclipseLighting\?\.enableEclipseGlobeShadow !== false;/,
  );
  assert.match(
    readEngine("Scene/AtmosphericConditions.js"),
    /enableEclipseGlobeShadow: true,/,
  );
});
