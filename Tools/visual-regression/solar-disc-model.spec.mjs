// solar-disc-model.spec.mjs — C12-15 / C12-16 / C12-17 (the C12 sun wave).
// @purpose Pins SolarDiscModel as the constants source for eclipse photometry, both sun-disc bakes, and the atmospheric alpha co-fade derivation.
// @status ACTIVE
//
// Pins, in pure Node with no browser:
//   - the ONE constants source (C12-15's landing requirement): the eclipse
//     photometry and BOTH sun-disc bakes must read `Scene/SolarDiscModel.js`,
//     and neither bake may carry a numeric copy;
//   - the limb-darkening law's endpoints and monotonicity;
//   - the C12-16 glare profile's endpoints, monotonicity, inverse-square
//     tail, and exact zero at the billboard's inscribed circle (a non-zero
//     pedestal there would paint a hard circular edge);
//   - the exact identity of the two disabled toggle positions — the
//     `(1, 0, 0)` limb triple and the legacy glare branch — because a
//     default-ON celestial multiplier that cannot be turned off byte-exactly
//     is the C11-176/C12 exit-gate failure class;
//   - the WebGL/WebGPU bake lockstep (both must consume the resolved
//     `frameState.sunDiscAppearance`, not their own literals);
//   - **the arithmetic that REFUTES C12-16 and C12-17 as causes of
//     `probe-eclipse-sun-fade`'s `glowOffRaw == 0` on WebGPU.** Both banked
//     co-suspects were named on the C12-16/C12-17 rows at Batch 760. This
//     spec fails if anyone re-asserts them without new evidence: over the
//     probe's 1.5x..6x solar-radius annulus BOTH glare profiles put alpha
//     between 0.16 and 0.69 (8-bit codes 41..176), and 8-bit quantisation
//     only truncates the halo beyond 8.19 solar radii — outside the annulus
//     entirely. A reshaped falloff and a wider/deeper bake cannot turn a
//     measured zero into a non-zero.
//
// Run: node --test Tools/visual-regression/solar-disc-model.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engineSource = path.join(root, "packages/engine/Source");
const engineOverlay = process.env.CESIUM_ENGINE_SOURCE_OVERLAY
  ? path.resolve(process.env.CESIUM_ENGINE_SOURCE_OVERLAY)
  : undefined;
const enginePath = (p) => {
  if (engineOverlay) {
    const candidate = path.join(engineOverlay, p);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(engineSource, p);
};
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");
const importEngine = (p) => import(pathToFileURL(enginePath(p)).href);

// Default `glowFactor = 1` geometry, shared with both bakes:
//   glowLengthTS = 5, quad half-extent = 1 + 2*glowLengthTS = 11 solar radii.
const GLOW_LENGTH_TS = 5.0;
const HALF_EXTENT_RSUN = 1.0 + 2.0 * GLOW_LENGTH_TS;
// bake `radius` for a distance of `rho` solar radii from the solar centre.
const radiusAt = (rho) => rho / (Math.SQRT2 * HALF_EXTENT_RSUN);

test("atmospheric alpha implements its documented finite and degenerate contract", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
  const alpha = M.solarDiscAtmosphereAlpha;

  assert.equal(M.default.solarDiscAtmosphereAlpha, alpha);
  assert.ok(
    Object.is(alpha({ x: 1.0, y: 1.0, z: 1.0 }), 1.0),
    "identity transmittance must return exactly 1.0",
  );

  const plain = { x: 0.2, y: 0.7, z: 0.4 };
  const cartesian = new Cartesian3(plain.x, plain.y, plain.z);
  assert.equal(alpha(plain), 0.7, "plain-object channels use their maximum");
  assert.equal(
    alpha(cartesian),
    alpha(plain),
    "Cartesian3 and a plain object have the same contract",
  );

  for (const [name, transmittance, expected] of [
    ["all-zero", { x: 0.0, y: 0.0, z: 0.0 }, 0.0],
    // A negative channel is outside the physical domain, and this return is
    // an ALPHA: left unclamped it brightens the sky behind the disc instead
    // of fading it, so the contract floors the result at zero.
    ["all-negative", { x: -1.0, y: -2.0, z: -3.0 }, 0.0],
    ["mixed-sign", { x: -1.0, y: 0.2, z: -3.0 }, 0.2],
    ["upper-clamp-x", { x: 1.25, y: 0.8, z: 0.4 }, 1.0],
    ["upper-clamp-y", { x: 0.8, y: 1.25, z: 0.4 }, 1.0],
    ["upper-clamp-z", { x: 0.8, y: 0.4, z: 1.25 }, 1.0],
  ]) {
    assert.equal(alpha(transmittance), expected, name);
  }

  for (const [name, unreadable] of [
    ["absent argument", undefined],
    ["absent channels", {}],
    ["partial NaN", { x: Number.NaN, y: 0.5, z: 0.25 }],
    ["all NaN", { x: Number.NaN, y: Number.NaN, z: Number.NaN }],
    ["+Infinity", { x: Number.POSITIVE_INFINITY, y: 0.5, z: 0.25 }],
    ["-Infinity", { x: Number.NEGATIVE_INFINITY, y: 0.5, z: 0.25 }],
  ]) {
    assert.ok(
      Object.is(alpha(unreadable), 1.0),
      `${name} must take the exact 1.0 fallback`,
    );
  }
});

// The clamp this pins is containment for input that should never arrive, not a
// correction that makes such input meaningful. What matters is the BOUND: an
// alpha below zero brightens the sky behind the disc rather than fading it, so
// no un-physical transmittance may produce one.
test("atmospheric alpha is never negative for any finite transmittance", async () => {
  const { solarDiscAtmosphereAlpha: alpha } = await importEngine(
    "Scene/SolarDiscModel.js",
  );

  const levels = [-1e6, -1000, -1.0, -0.5, -1e-7, -0.0, 0.0, 1e-7, 0.5, 1.0];
  let sawNegativeInput = false;
  for (const x of levels) {
    for (const y of levels) {
      for (const z of levels) {
        const got = alpha({ x, y, z });
        assert.ok(
          got >= 0.0,
          `alpha(${x}, ${y}, ${z}) = ${got} — a negative alpha brightens the sky`,
        );
        assert.ok(got <= 1.0, `alpha(${x}, ${y}, ${z}) = ${got} exceeds 1`);

        const peak = Math.max(x, y, z);
        if (peak > 0.0) {
          // Strictly inside the physical domain the clamp must be invisible.
          assert.equal(
            got,
            Math.min(1.0, peak),
            `alpha(${x}, ${y}, ${z}) must still be min(1, max channel)`,
          );
        } else {
          if (peak < 0.0) {
            sawNegativeInput = true;
          }
          // A non-positive peak fades the disc out completely. Zero is zero
          // here: the clamp normalizes a negative zero to a positive one, and
          // an alpha carries no sign.
          assert.equal(got, 0.0, `alpha(${x}, ${y}, ${z}) must floor at 0`);
          assert.ok(
            !Object.is(got, -0.0),
            `alpha(${x}, ${y}, ${z}) must not return a negative zero`,
          );
        }
      }
    }
  }
  assert.ok(
    sawNegativeInput,
    "the sweep must actually exercise negative input",
  );
});

test("atmospheric alpha is monotone in every physical transmittance channel", async () => {
  const { solarDiscAtmosphereAlpha: alpha } = await importEngine(
    "Scene/SolarDiscModel.js",
  );
  const levels = [0.0, 0.0001, 0.01, 0.1, 0.4, 0.8, 1.0];
  for (let axis = 0; axis < 3; axis++) {
    const fixedAxes = [0, 1, 2].filter((candidate) => candidate !== axis);
    for (const first of levels) {
      for (const second of levels) {
        let previous = -Infinity;
        for (const value of levels) {
          const channels = [0.0, 0.0, 0.0];
          channels[fixedAxes[0]] = first;
          channels[fixedAxes[1]] = second;
          channels[axis] = value;
          const got = alpha({
            x: channels[0],
            y: channels[1],
            z: channels[2],
          });
          assert.ok(
            got >= previous,
            `axis ${axis} fell at ${value} with other channels ${first}, ${second}`,
          );
          previous = got;
        }
      }
    }
  }
});

test("atmospheric alpha follows shipped dawn transmittance", async () => {
  const [
    M,
    atmosphereModule,
    cartesianModule,
    ellipsoidModule,
    extinctionModule,
  ] = await Promise.all([
    importEngine("Scene/SolarDiscModel.js"),
    importEngine("Scene/Atmosphere.js"),
    importEngine("Core/Cartesian3.js"),
    importEngine("Core/Ellipsoid.js"),
    importEngine("Scene/computeAtmosphereExtinction.js"),
  ]);
  const Atmosphere = atmosphereModule.default;
  const Cartesian3 = cartesianModule.default;
  const Ellipsoid = ellipsoidModule.default;
  const computeAtmosphereExtinction = extinctionModule.default;
  const atmosphere = new Atmosphere();
  const radius = Ellipsoid.default.maximumRadius;
  const camera = new Cartesian3(radius, 0.0, 0.0);
  const sunDistance = 1.496e11;
  const scalars = [];

  for (const altitudeDegrees of [0.1, 2.0, 5.0, 8.0, 10.0]) {
    const altitude = (altitudeDegrees * Math.PI) / 180.0;
    const sun = new Cartesian3(
      camera.x + sunDistance * Math.sin(altitude),
      sunDistance * Math.cos(altitude),
      0.0,
    );
    const transmittance = computeAtmosphereExtinction(
      new Cartesian3(),
      camera,
      sun,
      atmosphere,
      radius,
    );
    const expected = Math.min(
      1.0,
      Math.max(transmittance.x, transmittance.y, transmittance.z),
    );
    const got = M.solarDiscAtmosphereAlpha(transmittance);
    assert.equal(got, expected);
    assert.ok(got >= 0.0 && got < 1.0);
    scalars.push(got);
  }

  for (let i = 1; i < scalars.length; i++) {
    assert.ok(scalars[i] > scalars[i - 1]);
  }
  assert.ok(scalars[0] < 0.01);
  assert.ok(scalars.at(-1) > 0.5);
});

test("limb-darkening law: endpoints, monotonicity, clamping", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  assert.equal(
    M.SOLAR_LIMB_DARKENING_A0 +
      M.SOLAR_LIMB_DARKENING_A1 +
      M.SOLAR_LIMB_DARKENING_A2,
    1.0,
    "I(mu=1) must be exactly 1 at disc centre",
  );
  assert.equal(M.solarLimbIntensity(0.0), 1.0, "centre == 1");
  assert.equal(
    M.solarLimbIntensity(1.0),
    M.SOLAR_LIMB_DARKENING_A0,
    "limb == a0 (0.30, ~30% of centre)",
  );
  // Strictly decreasing outward.
  let prev = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const v = M.solarLimbIntensity(i / 1000);
    assert.ok(v < prev, `limb intensity must decrease outward (i=${i})`);
    prev = v;
  }
  // Clamps rather than extrapolating (the bakes pass min(r/radiusTS, 1)).
  assert.equal(M.solarLimbIntensity(-1.0), M.solarLimbIntensity(0.0));
  assert.equal(M.solarLimbIntensity(4.0), M.solarLimbIntensity(1.0));
});

test("C12-15: ONE constants source — photometry re-exports, shaders hold no copy", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const O = await importEngine("Scene/computeSolarObscuration.js");
  assert.equal(O.LIMB_DARKENING_A0, M.SOLAR_LIMB_DARKENING_A0);
  assert.equal(O.LIMB_DARKENING_A1, M.SOLAR_LIMB_DARKENING_A1);
  assert.equal(O.LIMB_DARKENING_A2, M.SOLAR_LIMB_DARKENING_A2);
  // The photometry module must IMPORT them, not redeclare them.
  const obscSrc = readEngine("Scene/computeSolarObscuration.js");
  assert.match(obscSrc, /from "\.\/SolarDiscModel\.js"/);
  assert.doesNotMatch(
    obscSrc,
    /LIMB_DARKENING_A1\s*=\s*0\.93/,
    "computeSolarObscuration must not redeclare the triple",
  );

  // The WebGL bake must receive the numbers as uniforms — no literals.
  // Comments are stripped first: the prose deliberately quotes the old
  // expression, and a doc mention is not a second constants source.
  const glsl = readEngine("Shaders/SunTextureFS.glsl");
  const glslCode = glsl.replace(/\/\/[^\n]*/g, "");
  assert.match(glsl, /uniform vec3 u_limbDarkening;/);
  assert.match(glsl, /uniform vec4 u_glareProfile;/);
  for (const literal of ["0.93", "0.23", "0.275", "0.55"]) {
    assert.ok(
      !glslCode.includes(literal),
      `SunTextureFS.glsl must not hardcode ${literal}`,
    );
  }
  // Both smoothstep edges now come from u_glareProfile.z.
  const smoothstepEdges = glslCode.match(/smoothstep\(0\.0,\s*([^,]+),/g) ?? [];
  assert.equal(smoothstepEdges.length, 2, "halo + burst smoothsteps");
  for (const s of smoothstepEdges) {
    assert.match(s, /u_glareProfile\.z/);
  }

  // The WebGPU CPU bake must consume the RESOLVED appearance, not literals.
  const wgpu = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  assert.match(wgpu, /appearance\.a0/);
  assert.match(wgpu, /appearance\.glareCore/);
  assert.match(wgpu, /frameState\.sunDiscAppearance/);

  // And Sun.js must publish it BEFORE the feature-renderer branch, so the
  // two backends cannot resolve it differently.
  const sun = readEngine("Scene/Sun.js");
  const publishIdx = sun.indexOf("frameState.sunDiscAppearance = appearance");
  const branchIdx = sun.indexOf("getFeatureRenderer(FeatureRendererKey.SUN)");
  assert.ok(publishIdx > 0, "Sun.update must publish sunDiscAppearance");
  assert.ok(
    publishIdx < branchIdx,
    "publication must precede the backend branch",
  );
});

test("C12-16 glare profile: endpoints, monotonicity, inverse-square tail", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  assert.equal(M.solarGlareProfile(0.0), 1.0, "peak == 1 at centre");
  assert.equal(
    M.solarGlareProfile(M.SOLAR_GLARE_SUPPORT),
    0.0,
    "must reach EXACTLY zero at the inscribed circle — a residual pedestal " +
      "there draws a hard circular edge inside the billboard",
  );
  assert.equal(M.SOLAR_GLARE_SUPPORT, Math.SQRT1_2);
  assert.equal(M.solarGlareProfile(1.0), 0.0, "clamped beyond the support");

  let prev = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const v = M.solarGlareProfile((M.SOLAR_GLARE_SUPPORT * i) / 2000);
    assert.ok(v <= prev, `glare must be non-increasing outward (i=${i})`);
    prev = v;
  }

  // The unclipped kernel is a Lorentzian: raw(2r)/raw(r) -> 1/4 (inverse
  // square in angle). Measured at 4x and 8x the core radius.
  // (measured: 5/17 = 0.2941 at 2->4 core radii, 17/65 = 0.2615 at 4->8,
  // 65/257 = 0.2529 at 8->16 — converging to 1/4 from above, as a
  // Lorentzian must.)
  const raw = (r) => 1.0 / (1.0 + (r / M.SOLAR_GLARE_CORE) ** 2);
  const octave = (n) =>
    raw(2 * n * M.SOLAR_GLARE_CORE) / raw(n * M.SOLAR_GLARE_CORE);
  const r2 = octave(2);
  const r4 = octave(4);
  const r8 = octave(8);
  assert.ok(r2 > 0.25 && r2 < 0.3, `octave ratio 2->4 core radii: ${r2}`);
  assert.ok(r4 > 0.25 && r4 < 0.27, `octave ratio 4->8 core radii: ${r4}`);
  assert.ok(r8 > 0.25 && r8 < 0.256, `octave ratio 8->16 core radii: ${r8}`);
  assert.ok(r8 < r4 && r4 < r2, "must approach the inverse square from above");

  // Legacy curve is exactly `1 - smoothstep(0, 0.55, r)`.
  assert.equal(M.solarGlareProfileLegacy(0.0), 1.0);
  assert.equal(M.solarGlareProfileLegacy(M.SOLAR_GLARE_LEGACY_EDGE), 0.0);
  assert.equal(M.solarGlareProfileLegacy(0.9), 0.0);
  assert.ok(
    Math.abs(M.solarGlareProfileLegacy(0.275) - 0.5) < 1e-12,
    "0.275 is the legacy half-amplitude point the new core is anchored to",
  );
  assert.equal(M.SOLAR_GLARE_CORE, 0.275);

  // Support: the legacy curve dies at 8.556 R_sun, the new one at 11.0.
  const supportRsun = M.solarBakeRadiusToSolarRadii(
    M.SOLAR_GLARE_SUPPORT,
    GLOW_LENGTH_TS,
  );
  assert.ok(
    Math.abs(supportRsun - 11.0) < 1e-9,
    `new support == quad half-extent (${supportRsun})`,
  );
  const legacyRsun = M.solarBakeRadiusToSolarRadii(
    M.SOLAR_GLARE_LEGACY_EDGE,
    GLOW_LENGTH_TS,
  );
  assert.ok(
    Math.abs(legacyRsun - 8.556) < 0.01,
    `legacy support (${legacyRsun})`,
  );
});

test("C12-16/C12-17 are REFUTED as causes of the measured glowOffRaw == 0", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  // `probe-eclipse-sun-fade` integrates the sun's contribution over a
  // 1.5x..6x solar-radius annulus and measured EXACTLY 0 on WebGPU across
  // all 15 partial-band steps. The bake's alpha there is 0.75 * profile.
  for (const rho of [1.5, 3.0, 4.5, 6.0]) {
    const r = radiusAt(rho);
    for (const [name, fn] of [
      ["legacy", M.solarGlareProfileLegacy],
      ["c12-16", M.solarGlareProfile],
    ]) {
      const alpha = 0.75 * fn(r);
      assert.ok(
        alpha > 0.15 && alpha < 0.7,
        `${name} alpha at ${rho} R_sun is ${alpha} — the annulus is never faint`,
      );
      assert.ok(
        alpha * 255 > 38,
        `${name} alpha at ${rho} R_sun quantises to ${Math.floor(alpha * 255)}/255`,
      );
    }
  }
  // 8-bit quantisation (C12-17's suspect) only bites OUTSIDE the annulus:
  // the legacy alpha crosses 1/255 at 8.19 R_sun, so the 8-bit bake loses
  // 8.19..8.556 R_sun — 4.2% of the radius and 0% of the measured region.
  const crossing = (fn) => {
    let lo = 0.0;
    let hi = 20.0;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (0.75 * fn(radiusAt(mid)) >= 1 / 255) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  const legacyCrossing = crossing(M.solarGlareProfileLegacy);
  assert.ok(
    legacyCrossing > 8.0 && legacyCrossing < 8.3,
    `legacy 8-bit floor crossing at ${legacyCrossing} R_sun (expected ~8.19)`,
  );
  assert.ok(
    legacyCrossing > 6.0,
    "the 8-bit floor is outside the 1.5x..6x annulus, so quantisation " +
      "cannot explain a zero measured inside it",
  );
  // C12-16 pushes the 8-bit-visible tail out to ~10.8 R_sun.
  const newCrossing = crossing(M.solarGlareProfile);
  assert.ok(
    newCrossing > 10.0,
    `C12-16 8-bit floor crossing at ${newCrossing} R_sun`,
  );
});

test("toggle identity: both OFF reproduces the pre-C12 bake exactly", async () => {
  const A = await importEngine("Scene/SunDiscAppearance.js");
  const M = await importEngine("Scene/SolarDiscModel.js");
  const state = A.createSunDiscAppearance();

  // No atmosphericConditions (no globe) -> both default ON.
  A.readSunDiscAppearance({}, state);
  assert.equal(state.limbDarkening, true);
  assert.equal(state.glareFalloff, true);
  assert.equal(state.a0, M.SOLAR_LIMB_DARKENING_A0);
  assert.equal(state.glareLegacy, 0.0);
  assert.equal(state.key, 3);

  // Explicit OFF -> exact identities.
  A.readSunDiscAppearance(
    {
      atmosphericConditions: {
        lighting: {
          enableSolarLimbDarkening: false,
          enableSolarGlareFalloff: false,
        },
      },
    },
    state,
  );
  assert.equal(state.a0, 1.0, "flat disc: I(mu) == 1 identically");
  assert.equal(state.a1, 0.0);
  assert.equal(state.a2, 0.0);
  assert.equal(state.glareLegacy, 1.0, "legacy glare branch selected");
  assert.equal(state.key, 0);
  // I(mu) with (1,0,0) is exactly 1 for every mu, i.e. the historical
  // `step(radius, u_radiusTS)` disc, not an approximation of it.
  for (const mu of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    assert.equal(state.a0 + state.a1 * mu + state.a2 * mu * mu, 1.0);
  }

  // Independently togglable, and the key is the rebuild signature.
  const keys = new Set();
  for (const ld of [true, false]) {
    for (const gf of [true, false]) {
      A.readSunDiscAppearance(
        {
          atmosphericConditions: {
            lighting: {
              enableSolarLimbDarkening: ld,
              enableSolarGlareFalloff: gf,
            },
          },
        },
        state,
      );
      keys.add(state.key);
    }
  }
  assert.equal(keys.size, 4, "all four toggle combinations must be distinct");

  // The toggles must exist on the shipped lighting leaf, default ON.
  const ac = readEngine("Scene/AtmosphericConditions.js");
  assert.match(ac, /enableSolarLimbDarkening: true/);
  assert.match(ac, /enableSolarGlareFalloff: true/);
});

// The `lighting` registry JSDoc is where a reader goes to learn what a toggle
// does, and it presented the C12-15/16 sun-disc pair and the C12-21/22
// moon-phase pair as alike ("both default ON ... EXACT identity position when
// false", "sit alongside them"). They are NOT alike in the one case the
// registry never mentioned: `Scene.js` publishes
// `frameState.atmosphericConditions` as `undefined` when there is no globe, and
// the sun resolver reads `!== false` (ON) while the moon resolver reads
// `=== true` (OFF, deliberately). A globe-less scene — a supported
// configuration — therefore gets the C12 sun disc AND the pre-C12 lunar
// terminator. Ground truth below is EXECUTED, and the doc is held to it.
const FACADE_ABSENT_CONVENTION = {
  "Scene/SunDiscAppearance.js": {
    on: ["enableSolarLimbDarkening", "enableSolarGlareFalloff"],
    off: [],
  },
  "Scene/MoonPhaseAppearance.js": {
    on: [],
    off: ["enableEarthshinePhase", "enableSoftTerminator"],
  },
  "Scene/SolarGlareAppearance.js": {
    on: [],
    off: ["enableAngularSolarGlare"],
  },
};

test("the lighting registry documents the facade-absent split it actually has", async () => {
  // 1. GROUND TRUTH, executed — not read off the prose.
  const sun = await importEngine("Scene/SunDiscAppearance.js");
  const sunState = sun.createSunDiscAppearance();
  sun.readSunDiscAppearance({}, sunState);
  assert.equal(sunState.limbDarkening, true, "sun pair is ON with no facade");
  assert.equal(sunState.glareFalloff, true, "sun pair is ON with no facade");

  const moon = await importEngine("Scene/MoonPhaseAppearance.js");
  const moonState = moon.createMoonPhaseAppearance();
  moon.readMoonPhaseAppearance(
    undefined, // no facade — exactly what a globe-less scene publishes
    true, // phase modelling on, so the ONLY gate left is the facade
    0.5,
    moon.ASTRONOMICAL_UNIT,
    moonState,
  );
  assert.equal(
    moonState.earthshinePhase,
    false,
    "moon pair is OFF with no facade — the asymmetry the doc must state",
  );
  assert.equal(moonState.softTerminator, false);
  assert.equal(moonState.earthshinePhaseScale, 1.0, "identity");
  assert.equal(moonState.terminatorSoftness, 0.0, "identity");

  // 2. The resolver SOURCES agree with what was just executed, so the table
  //    below is anchored to code and not to this test's own assumptions.
  for (const [file, buckets] of Object.entries(FACADE_ABSENT_CONVENTION)) {
    const source = readEngine(file).replace(/\r\n/g, "\n");
    for (const name of buckets.on) {
      assert.match(
        source,
        new RegExp(`${name} !== false`),
        `${file} must read ${name} as ON-without-facade`,
      );
    }
    for (const name of buckets.off) {
      assert.match(
        source,
        new RegExp(`${name} === true`),
        `${file} must read ${name} as OFF-without-facade`,
      );
    }
  }

  // 3. The registry JSDoc must sort every one of them into the right bucket.
  //    The three delimiters below are the registry's own statement of the
  //    split — the two bucket headings and the conclusion it draws from them.
  //    Deleting any of the three fails this test, which is the point: the
  //    anchor bites on the DOCUMENTED SPLIT, not on the prose around it.
  const registry = ac_lightingRegistry();
  const onList = between(
    registry,
    "Read as `!== false`, hence on without a facade",
    "Read as `=== true`, hence off without a facade",
  );
  const offList = between(
    registry,
    "Read as `=== true`, hence off without a facade",
    "A globe-less scene therefore",
  );
  for (const buckets of Object.values(FACADE_ABSENT_CONVENTION)) {
    for (const name of buckets.on) {
      assert.ok(
        onList.includes(name),
        `${name} is ON without a facade but the registry does not list it there`,
      );
      assert.ok(!offList.includes(name), `${name} is listed in both buckets`);
    }
    for (const name of buckets.off) {
      assert.ok(
        offList.includes(name),
        `${name} is OFF without a facade but the registry does not list it there`,
      );
      assert.ok(!onList.includes(name), `${name} is listed in both buckets`);
    }
  }
});

function ac_lightingRegistry() {
  const source = readEngine("Scene/AtmosphericConditions.js").replace(
    /\r\n/g,
    "\n",
  );
  const start = source.indexOf("   * Lighting flags.");
  const end = source.indexOf("  get lighting() {", start);
  assert.ok(start > 0 && end > start, "the lighting registry JSDoc must exist");
  return source.slice(start, end);
}

function between(text, from, to) {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `the registry must contain "${from}"`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `the registry must contain "${to}" after "${from}"`);
  return text.slice(start, end);
}

test("C12-17: WebGPU bake size/format parity with WebGL", () => {
  const wgpu = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  const sun = readEngine("Scene/Sun.js");
  // WebGL's rule, still present.
  assert.match(
    sun,
    /Math\.ceil\(Math\.log\(size\) \/ Math\.log\(2\.0\)\) - 2\.0/,
  );
  // WebGPU now derives from the drawing buffer instead of a hardcoded 256.
  assert.match(wgpu, /function sunTextureSize\(/);
  assert.match(wgpu, /context\.drawingBufferWidth/);
  assert.ok(
    !/createSunTexture\(device, 256,/.test(wgpu),
    "the hardcoded 256 bake must be gone",
  );
  // HDR format selection mirrors WebGL's HALF_FLOAT choice.
  assert.match(wgpu, /frameState\.useHDR === true \? "rgba16float"/);
  assert.match(wgpu, /function floatToHalfBits\(/);
  // Rebuild set must cover size, format and the C12-15/16 toggle key.
  assert.match(wgpu, /cache\.lastBakeSize !== bakeSize/);
  assert.match(wgpu, /cache\.lastBakeFormat !== bakeFormat/);
  assert.match(wgpu, /cache\.lastAppearanceKey !== appearanceKey/);
});

// ── probe-sun-glow-profile geometry satisfiability ──────────────────────────
//
// The first revision of that probe shipped a constant set that was
// arithmetically unsatisfiable — viewport 1280x720 + fov 12 deg + maxRsun
// 12.0 gives limbPx 27.94, maxHalf floor(0.45*720) = 324, and the in-page
// guard `half < maxRsun*limbPx` reduces to `324 < 335.28`, so the probe
// exited 2 at step 0 on every run, forever, before reaching any
// fix-dependent code. It NEVER PRODUCED A MEASUREMENT. These tests extract
// the shipped constants and the shipped feasibility function VERBATIM from
// the probe and prove the set is satisfiable, so that class cannot ship
// again without `node --test` going red.
function loadProbeGeometry() {
  const src = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  const slice = (name) => {
    const a = src.indexOf(`// ==BEGIN ${name}==`);
    const b = src.indexOf(`// ==END ${name}==`);
    assert.ok(a > 0 && b > a, `probe block ${name} must be marker-delimited`);
    return src.slice(a, b);
  };
  // eslint-disable-next-line no-new-func
  return new Function(
    `${slice("PROBE_CONSTANTS")}\n${slice("roiFeasibility")}\n` +
      `return { PROBE_CONSTANTS, roiFeasibility };`,
  )();
}

test("probe geometry: the shipped constant set is satisfiable at every Earth-Sun distance", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  for (const [name, d] of [
    ["perihelion", k.sunDistanceMinM],
    ["aphelion", k.sunDistanceMaxM],
    ["mean", 0.5 * (k.sunDistanceMinM + k.sunDistanceMaxM)],
  ]) {
    const f = roiFeasibility(k, d);
    assert.ok(
      f.feasible,
      `${name}: ${f.reasons.join("; ")} (limbPx ${f.limbPx.toFixed(2)}, half ${f.half}, maxHalf ${f.maxHalf}, roiRsun ${f.roiRsun.toFixed(2)})`,
    );
    // The ROI must reach past the support gate's UPPER bound, or part of the
    // acceptance band is unmeasurable at this viewport (the second half of
    // the round-1 blocker: even relaxed, the old set reached only 11.60).
    assert.ok(
      f.roiRsun >= k.supportGateHiRsun,
      `${name}: ROI reaches ${f.roiRsun.toFixed(2)} R_sun, gate needs ${k.supportGateHiRsun}`,
    );
    assert.ok(f.limbPx >= k.minLimbPx, `${name}: limbPx ${f.limbPx}`);
  }
});

test("probe geometry: the feasibility function actually rejects the round-1 set", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  // The exact set that shipped and never measured anything. If this stops
  // being rejected, the guard has been weakened into a no-op.
  const broken = { ...k, fovDeg: 12.0 };
  const f = roiFeasibility(broken, 1.5157e11);
  assert.ok(!f.feasible, "fov 12 deg at 1280x720 must be rejected");
  assert.ok(
    Math.abs(f.limbPx - 27.94) < 0.15,
    `the executor measured limbPx 27.94 there; model says ${f.limbPx.toFixed(2)}`,
  );
  assert.equal(f.maxHalf, 324);
  assert.ok(
    f.reasons.some((r) => r.includes("maxRsun*limbPx")),
    `the ROI-clamp reason must be named: ${JSON.stringify(f.reasons)}`,
  );
  // …and the "relaxed" variant still fails the support-gate reachability arm.
  assert.ok(
    f.roiRsun < k.supportGateHiRsun,
    `relaxed ROI reaches ${f.roiRsun.toFixed(2)}, still under the gate bound`,
  );

  // A too-narrow fov must fail too — narrowing GROWS limbPx, which is the
  // wrong direction, and is the intuitive-but-wrong fix.
  assert.ok(!roiFeasibility({ ...k, fovDeg: 9.0 }, 1.5157e11).feasible);
  // And the shipped fov must clear it with real margin, not by a hair.
  const ok = roiFeasibility(k, 1.5157e11);
  assert.ok(
    ok.maxHalf / (k.maxRsun * ok.limbPx) > 1.3,
    `shipped set must clear the ROI clamp with >30% margin (${(ok.maxHalf / (k.maxRsun * ok.limbPx)).toFixed(2)}x)`,
  );
});

test("probe geometry: the in-page arithmetic matches the pure feasibility model", () => {
  const { PROBE_CONSTANTS: k, roiFeasibility } = loadProbeGeometry();
  const probe = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  // The in-page guard and the pure model must use the same expressions, or
  // the pre-launch check can pass while the run still rejects.
  assert.match(
    probe,
    /Math\.ceil\(\(k\.maxRsun \+ k\.roiMarginRsun\) \* limbPx\)/,
    "in-page `half` must use the same expression as roiFeasibility",
  );
  assert.match(
    probe,
    /half < k\.maxRsun \* limbPx/,
    "in-page ROI guard must be the one the model mirrors",
  );
  assert.match(
    probe,
    /Math\.floor\(\s*0\.45 \* Math\.min\(canvas\.width, canvas\.height\),?\s*\)/,
    "in-page maxHalf must be the one the model mirrors",
  );
  // The pre-launch feasibility check must exist and be fatal.
  assert.match(
    probe,
    /if \(!feas\.perihelion\.feasible \|\| !feas\.aphelion\.feasible\)/,
  );
  assert.match(probe, /ROI geometry is unsatisfiable/);
  // The viewport must come FROM the constants, not a second literal.
  assert.match(probe, /width: plan\.k\.viewportWidth/);
  assert.match(probe, /height: plan\.k\.viewportHeight/);
  assert.match(probe, /C\.Math\.toRadians\(k\.fovDeg\)/);
  // Sanity: the model agrees with the shipped constants' own viewport.
  assert.equal(k.viewportWidth, 1280);
  assert.equal(k.viewportHeight, 720);
  assert.ok(roiFeasibility(k, 1.5157e11).feasible);
});

test("probe classifier: absence is settled at STATE level, saturation before occlusion", () => {
  const probe = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  const body = probe.slice(probe.indexOf("function classify("));
  const iAbsentBuilt = body.indexOf("commandBuiltSteps === 0");
  const iAbsentCull = body.indexOf("cullFiredSteps === steps.length");
  const iSat = body.indexOf("saturationSource !== null");
  const iOccl = body.indexOf('hypothesis = "H-OCCL');
  assert.ok(
    iAbsentBuilt > 0 && iAbsentCull > 0,
    "state-level absence arms must exist",
  );
  assert.ok(iSat > 0, "the saturation arm must exist");
  assert.ok(iOccl > 0, "the occlusion arm must exist");
  // M2: absence is decided before any pixel-difference branch.
  assert.ok(
    iAbsentBuilt < iSat && iAbsentCull < iSat,
    "absence must precede pixels",
  );
  // M1: saturation is decided before occlusion.
  assert.ok(
    iSat < iOccl,
    "H-SAT must be evaluated BEFORE H-OCCL — when the saturator is the globe " +
      "the two signatures are identical",
  );
  // The state read must happen right after the sun-SHOWN render.
  const iShownRender = probe.indexOf("// ── L0: globe ON, sky ON, sun ON");
  const iStateRead = probe.indexOf("// STATE read, SAME TASK");
  const iHiddenRender = probe.indexOf("// ── L0: sun OFF");
  assert.ok(
    iShownRender < iStateRead && iStateRead < iHiddenRender,
    "the env-state read must sit between the sun-shown render and the sun-hidden one",
  );
  // The triple confound of the globe lane must be documented in place.
  assert.match(probe, /removes THREE things at once/);
  assert.match(probe, /SceneUtilities\.getOccluder/);
  // The eliminated hypothesis must be recorded as eliminated, not tested.
  assert.match(probe, /ELIMINATED BY DRAW ORDER/);
  assert.ok(
    !/hypothesis = "H-SKY/.test(probe),
    "the opaque-shell OCCLUSION hypothesis must not be in the classifier",
  );
  // The sky lane must be marked diagnostic-only (extinction confound).
  assert.match(probe, /sunDeltaNoSky_DIAGNOSTIC/);
  assert.match(probe, /skyLaneExtinctionConfound/);
});

test("probe: scene.sun.show is pinned against the WebGL bloom lever, and the residual is sign-discriminated", () => {
  const probe = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");

  // The lever lesson must be stated where a probe author will hit it.
  assert.match(probe, /IS NOT A SINGLE-VARIABLE LEVER ON WEBGL/);
  // Every measuring lane pins bloom, and the pin is GATED so it cannot drift
  // back to Scene's default `true`.
  assert.match(probe, /scene\.sunBloom = false;/);
  assert.match(probe, /gates\.bloom_pinned = \{/);
  assert.match(probe, /baselineSunBloom === false/);
  // The capability is recorded per backend rather than assumed.
  assert.match(probe, /supportsLegacySunBloom/);

  // The A/B lane exists, runs bloom ON, and restores the pin afterwards.
  const lane = probe.slice(
    probe.indexOf("// ── L3: bloom ON"),
    probe.indexOf("// ── Accumulate the radial profile"),
  );
  assert.ok(lane.length > 0, "the L3 bloom lane must exist");
  assert.match(lane, /scene\.sunBloom = true;/);
  assert.match(lane, /scene\.sunBloom = false;/);
  assert.match(lane, /vantage\.bloomLane === true/);

  // SIGN is the discriminator: bloom ADDS light (positive), a black
  // billboard under ALPHA_BLEND SUBTRACTS a*dst (negative). Both the signed
  // accumulator and the mechanism call must be present, and the mechanism
  // call must key on the sign, not only on the toggle.
  assert.match(probe, /const s0 = l0On\[p\] - l0Off\[p\];/);
  assert.match(probe, /sunDeltaSigned/);
  assert.match(probe, /function bloomMechanism\(/);
  assert.match(probe, /offSigned < -0\.5 \* off/);
  assert.match(probe, /offSigned > 0\.5 \* off/);
  assert.match(probe, /bloom-REFUTED/);
  assert.match(probe, /bloom-CONFIRMED/);

  // The extinguished-step selector must require BOTH a built command and a
  // ~zero extinction, or "nothing drawn" would be scored as "black".
  assert.match(probe, /s\.hasSunCommand === true &&/);
  assert.match(
    probe,
    /s\.extinctionL0\.every\(\(c\) => c !== null && c < 5e-4\)/,
  );

  // The prediction must be on the record BEFORE the run, in both directions.
  assert.match(probe, /PREDICTION, STATED BEFORE THE RUN/);
  assert.match(probe, /if instead the residual COLLAPSES/);
});

test("probe provenance: a missing source degrades, never throws", () => {
  const probe = fs
    .readFileSync(
      path.join(root, "Tools/visual-regression/probe-sun-glow-profile.mjs"),
      "utf8",
    )
    .replace(/\r\n/g, "\n");
  const fn = probe.slice(
    probe.indexOf("function provenance()"),
    probe.indexOf("// ── Radial-profile sweep"),
  );
  assert.match(fn, /missingSources/, "missing sources must be tracked");
  assert.match(
    fn,
    /try \{\s*bytes = fs\.readFileSync\(p\);/,
    "the per-source read must be guarded so a PRE tree can still run",
  );
  assert.match(
    fn,
    /SOURCE FILE ABSENT/,
    "a missing verbatim-slice source must degrade rather than throw",
  );
  assert.match(fn, /missingSources\.length === 0/, "…and must fail the gate");
});

test("C12-17: half-float packing round-trips the bake's value range", async () => {
  // Re-implement the decode side only; the encoder under test is the one
  // shipped in WebGPUEnvironmentRenderer.js, extracted by source so the
  // spec cannot drift from it.
  const src = readEngine(
    "Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  ).replace(/\r\n/g, "\n");
  const start = src.indexOf("function floatToHalfBits(");
  assert.ok(start > 0, "floatToHalfBits must exist in the WebGPU bake");
  const close = src.indexOf("\n}", start);
  assert.ok(close > start, "could not delimit floatToHalfBits");
  const body = src.slice(start, close + 2);
  const scratchDecl =
    "const _f32Scratch = new Float32Array(1);\n" +
    "const _u32Scratch = new Uint32Array(_f32Scratch.buffer);\n";
  // eslint-disable-next-line no-new-func
  const encode = new Function(
    `${scratchDecl}${body}\nreturn floatToHalfBits;`,
  )();

  const decode = (bits) => {
    const sign = bits & 0x8000 ? -1 : 1;
    const exp = (bits >> 10) & 0x1f;
    const mant = bits & 0x3ff;
    if (exp === 0) {
      return sign * mant * Math.pow(2, -24);
    }
    if (exp === 31) {
      return mant ? NaN : sign * Infinity;
    }
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
  };

  assert.equal(decode(encode(0.0)), 0.0);
  assert.equal(decode(encode(1.0)), 1.0);
  assert.equal(decode(encode(0.5)), 0.5);
  assert.equal(decode(encode(0.25)), 0.25);
  // Relative accuracy over the bake's range must beat 8-bit by orders of
  // magnitude — that is the whole point of C12-17's format half.
  let worstRel = 0;
  for (let i = 1; i <= 4096; i++) {
    const v = i / 4096;
    const back = decode(encode(v));
    worstRel = Math.max(worstRel, Math.abs(back - v) / v);
  }
  assert.ok(worstRel < 1e-3, `worst relative error ${worstRel}`);
  // And the deep tail rgba8unorm cannot hold at all.
  const tiny = 1 / 65536;
  assert.ok(
    Math.abs(decode(encode(tiny)) - tiny) / tiny < 1e-3,
    "half-float represents alpha 256x below the 8-bit floor",
  );
  assert.equal(Math.floor(tiny * 255), 0, "…which rgba8unorm truncates to 0");
});

// ===========================================================================
// CO-35 — THE LIMB-DARKENING LAW AGAINST PUBLISHED SOLAR PHOTOMETRY
//
// Maintainer ruling R-2026-08-10-2 re-ratifies §5's limb band on the disc-only
// measurement, CONDITIONAL on "first confirming the shipped physics is as
// accurate as possible while remaining performant". This section is that
// confirmation, executed rather than asserted: the shipped law is sampled and
// compared against reference data, and a mutant law is required to fail the
// same comparison so the tolerance is a test rather than a restatement.
//
// SOURCES (C16-01 Reference entries):
//
//   [R1] Cox, A. N. (ed.), *Allen's Astrophysical Quantities*, 4th ed., AIP
//        Press / Springer, 2000, ISBN 0-387-98746-0 — solar limb darkening,
//        `I(psi)/I(0) = sum a_k cos^k psi`; the 550 nm row is the shipped
//        `(0.30, 0.93, -0.23)`. THIS IS THE SHIPPED LAW'S OWN SOURCE.
//   [R2] Hestroffer, D. & Magnan, C., "Wavelength dependency of the Solar limb
//        darkening", A&A **333**, 338-342 (1998). Table 1 gives the two
//        independent 5th-order fits below at lambda = 579.88 nm; Table 2 gives
//        the power-law exponent vs. wavelength; Eq. 5 gives the average
//        relation `alpha ~ -0.023 + 0.292 / lambda[um]` for 416-1099 nm,
//        "accurate to a few +/- 0.02".
//   [R3] Pierce, A. K. & Slaughter, C. D., "Solar limb darkening", Solar
//        Physics **51**, 25 (1977) — the PS coefficients, via [R2] Table 1.
//   [R4] Neckel, H. & Labs, D., "On the wavelength dependency of solar limb
//        darkening (ll 303 to 1099 nm)", Solar Physics **153**, 91 (1994) —
//        the NL coefficients, via [R2] Table 1.
//
// [R2] states the PS and NL representations agree "excellently" for r <= 0.9
// and that a polynomial fit AT the limb "is difficult to achieve from a
// numerical as well as an observational point of view" — so r <= 0.9 is where
// the references are evidence, and the 0.95R sample point §5 names is where
// they are least certain. Both facts are asserted below.
// ===========================================================================

// [R2] Table 1, lambda = 579.88 nm. `sum a_k == 1` by construction.
const REF_PS_579_88 = Object.freeze([
  0.30505, 1.13123, -0.78604, 0.4056, 0.02297, -0.0788,
]);
const REF_NL_579_88 = Object.freeze([
  0.28392, 1.36896, -1.75998, 2.22154, -1.56074, 0.4463,
]);
const REF_LAMBDA_NM = 579.88;
/** The wavelength [R1]'s shipped row is quoted at. */
const SHIPPED_LAMBDA_NM = 550.0;
/** [R2] Eq. 5, lambda in micron. */
const refAlpha = (lambdaNm) => -0.023 + 0.292 / (lambdaNm / 1000);
const refP5 = (a, mu) => a.reduce((s, c, k) => s + c * Math.pow(mu, k), 0);
/**
 * Transport a profile from one wavelength to another through [R2]'s own
 * measured exponent relation. Exact for a pure power law and first-order
 * elsewhere; used ONLY because [R2] publishes its 5th-order pair at 579.88 nm
 * while [R1]'s shipped row is at 550 nm.
 */
const refTransported = (a, mu, fromNm, toNm) =>
  refP5(a, mu) * Math.pow(mu, refAlpha(toNm) - refAlpha(fromNm));
const muAt = (x) => Math.sqrt(Math.max(0, 1 - x * x));

/**
 * Largest and RMS absolute deviation of a law from a reference over r <= 0.9.
 */
function profileDeviation(law, reference) {
  let max = 0;
  let sse = 0;
  let n = 0;
  for (let i = 0; i <= 900; i++) {
    const x = i / 1000;
    const d = Math.abs(law(x) - reference(muAt(x)));
    if (d > max) {
      max = d;
    }
    sse += d * d;
    n++;
  }
  return { max, rms: Math.sqrt(sse / n) };
}

/**
 * The tolerance this audit states, in units of disc-centre intensity.
 *
 * DERIVED from the references' own disagreement rather than chosen: [R3] and
 * [R4] are completely independent reductions of independent observations, and
 * over r <= 0.9 they differ from each other by at most 0.00136. A law cannot
 * be asked to match "the" profile more tightly than the profile is known, so
 * the bar is 5x that spread — 0.0068 — which is also ~1/6 of one 8-bit code at
 * the sample point once the shipped display chain is applied.
 */
const REFERENCE_MAX_DEVIATION = 0.0068;

test("CO-35: the two independent references agree over r <= 0.9 — and NOT at the limb", async () => {
  let max09 = 0;
  let max10 = 0;
  for (let i = 0; i <= 1000; i++) {
    const mu = muAt(i / 1000);
    const d = Math.abs(refP5(REF_PS_579_88, mu) - refP5(REF_NL_579_88, mu));
    if (i <= 900) {
      max09 = Math.max(max09, d);
    }
    max10 = Math.max(max10, d);
  }
  // [R2]'s "excellent for r <= 0.9", as a number.
  assert.ok(max09 < 0.002, `PS vs NL over r<=0.9: ${max09}`);
  // …and its warning about the limb, also as a number: the two references
  // diverge by 10x more once r passes 0.9. THIS is why §5's 0.95R sample point
  // is the least certain place on the disc to bind a bound, and why the
  // derived band's tolerance has to exceed the reference spread.
  assert.ok(max10 > 10 * max09, `PS vs NL over r<=1.0: ${max10}`);
  // Both are normalised the same way the shipped law is.
  assert.ok(Math.abs(refP5(REF_PS_579_88, 1) - 1) < 1e-4);
  assert.ok(Math.abs(refP5(REF_NL_579_88, 1) - 1) < 1e-4);
});

test("CO-35: the shipped a0 is BRACKETED by the two primary datasets", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const a0 = M.SOLAR_LIMB_DARKENING_A0;
  assert.ok(
    REF_NL_579_88[0] < a0 && a0 < REF_PS_579_88[0],
    `shipped a0 ${a0} must lie between NL ${REF_NL_579_88[0]} and PS ${REF_PS_579_88[0]}`,
  );
  // `a0` IS the extreme-limb ratio, which is what §5's original [0.3, 0.5]
  // band actually fits — the sample point, not the bound, is what moved.
  assert.equal(M.solarLimbIntensity(1.0), a0);
});

test("CO-35: the shipped law tracks BOTH references within the stated tolerance", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const law = (x) => M.solarLimbIntensity(x);
  const ps = profileDeviation(law, (mu) =>
    refTransported(REF_PS_579_88, mu, REF_LAMBDA_NM, SHIPPED_LAMBDA_NM),
  );
  const nl = profileDeviation(law, (mu) =>
    refTransported(REF_NL_579_88, mu, REF_LAMBDA_NM, SHIPPED_LAMBDA_NM),
  );
  const power = profileDeviation(law, (mu) =>
    Math.pow(mu, refAlpha(SHIPPED_LAMBDA_NM)),
  );
  for (const [name, d] of [
    ["Pierce & Slaughter 1977", ps],
    ["Neckel & Labs 1994", nl],
    ["Hestroffer & Magnan 1998 power law", power],
  ]) {
    assert.ok(
      d.max <= REFERENCE_MAX_DEVIATION,
      `${name}: max deviation ${d.max} exceeds ${REFERENCE_MAX_DEVIATION}`,
    );
    assert.ok(d.rms <= 0.5 * REFERENCE_MAX_DEVIATION, `${name}: rms ${d.rms}`);
  }

  // MUTANT — the tolerance must be a TEST, not a restatement. The linear limb
  // law is the obvious wrong implementation and the flat disc is the "not
  // implemented" state; both must blow through the same bar.
  for (const [name, mutant] of [
    ["linear 1 - 0.7x", (x) => 1 - 0.7 * Math.min(Math.max(x, 0), 1)],
    ["flat disc", () => 1.0],
    [
      "a0 = 0.4 (outside the published spread)",
      (x) => {
        const mu = muAt(Math.min(Math.max(x, 0), 1));
        return 0.4 + 0.93 * mu - 0.33 * mu * mu;
      },
    ],
  ]) {
    const d = profileDeviation(mutant, (mu) =>
      refTransported(REF_PS_579_88, mu, REF_LAMBDA_NM, SHIPPED_LAMBDA_NM),
    );
    assert.ok(
      d.max > REFERENCE_MAX_DEVIATION,
      `${name} must FAIL the reference tolerance (got ${d.max})`,
    );
  }
});

test("CO-35: I(0.95R)/I(0) agrees with the references to better than 1.5%", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  const mu = muAt(0.95);
  const shipped = M.solarLimbIntensity(0.95) / M.solarLimbIntensity(0);
  const refs = [
    refTransported(REF_PS_579_88, mu, REF_LAMBDA_NM, SHIPPED_LAMBDA_NM),
    refTransported(REF_NL_579_88, mu, REF_LAMBDA_NM, SHIPPED_LAMBDA_NM),
  ];
  const mid = 0.5 * (refs[0] + refs[1]);
  assert.ok(
    Math.abs(shipped / mid - 1) < 0.015,
    `shipped ${shipped} vs transported reference midpoint ${mid}`,
  );
  // The full spread of everything credible at ~550 nm, including the
  // untransported 579.88 nm pair and the power law. The shipped value must sit
  // INSIDE it — that is what makes "no better law is available" a measurement.
  const spread = [
    Math.pow(mu, refAlpha(SHIPPED_LAMBDA_NM)),
    refs[0],
    refs[1],
    refP5(REF_PS_579_88, mu),
    refP5(REF_NL_579_88, mu),
  ];
  assert.ok(shipped > Math.min(...spread) && shipped < Math.max(...spread));
  // …and the whole spread is ABOVE §5's original 0.5 ceiling, which is why no
  // coefficient change could ever have satisfied the superseded bound here.
  for (const v of spread) {
    assert.ok(v > 0.5, `${v} must exceed the superseded 0.5 ceiling`);
  }
});

test("CO-35: 550 nm is the right band centre for a BROADBAND visual render", async () => {
  // CIE 1931 photopic V(lambda) at 10 nm steps, times a Planck spectrum at the
  // IAU nominal solar effective temperature (5772 K) as the disc-centre
  // weighting. [R2]'s alpha is linear in 1/lambda, so the effective wavelength
  // for this quantity is the reciprocal of the weighted mean of 1/lambda.
  const V = {
    400: 0.0004,
    410: 0.0012,
    420: 0.004,
    430: 0.0116,
    440: 0.023,
    450: 0.038,
    460: 0.06,
    470: 0.091,
    480: 0.139,
    490: 0.208,
    500: 0.323,
    510: 0.503,
    520: 0.71,
    530: 0.862,
    540: 0.954,
    550: 0.995,
    560: 0.995,
    570: 0.952,
    580: 0.87,
    590: 0.757,
    600: 0.631,
    610: 0.503,
    620: 0.381,
    630: 0.265,
    640: 0.175,
    650: 0.107,
    660: 0.061,
    670: 0.032,
    680: 0.017,
    690: 0.0082,
    700: 0.0041,
  };
  const planck = (lambdaNm, T) => {
    const l = lambdaNm * 1e-9;
    const h = 6.62607015e-34;
    const c = 2.99792458e8;
    const kB = 1.380649e-23;
    return (
      (2 * h * c * c) /
      (Math.pow(l, 5) * (Math.exp((h * c) / (l * kB * T)) - 1))
    );
  };
  let wSum = 0;
  let wInv = 0;
  for (const [key, v] of Object.entries(V)) {
    const lambda = Number(key);
    const w = v * planck(lambda, 5772);
    wSum += w;
    wInv += w / lambda;
  }
  const effectiveNm = wSum / wInv;
  assert.ok(
    Math.abs(effectiveNm - SHIPPED_LAMBDA_NM) < 10,
    `photopic effective wavelength ${effectiveNm} nm vs the shipped ${SHIPPED_LAMBDA_NM} nm`,
  );
  // …and what that offset is worth on the quantity §5 measures.
  const mu = muAt(0.95);
  const delta =
    Math.pow(mu, refAlpha(effectiveNm)) /
      Math.pow(mu, refAlpha(SHIPPED_LAMBDA_NM)) -
    1;
  assert.ok(
    Math.abs(delta) < 0.01,
    `the broadband correction to I(0.95R)/I(0) is ${delta}`,
  );
});

test("CO-35: the radiance-2.0 derivation survives every published coefficient set", async () => {
  const M = await importEngine("Scene/SolarDiscModel.js");
  // `SOLAR_DISC_RADIANCE_CONTRAST_CEILING` is solved from `a0` alone, so the
  // question the ruling asks — "is the radiance derivation still sound under
  // any coefficient change?" — is answered by re-solving it across the
  // published spread of `a0` and checking the shipped 2.0 stays close.
  const ceilingFor = (a0) => {
    const ideal = 255 * (1 - Math.pow(a0, 1 / 2.2));
    const target = M.SOLAR_DISC_LIMB_CONTRAST_FRACTION * ideal;
    const contrast = (L) =>
      M.solarDiscDisplayCode(L, 2.2) - M.solarDiscDisplayCode(a0 * L, 2.2);
    let lo = 1;
    let hi = 64;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (contrast(mid) > target) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return 0.5 * (lo + hi);
  };
  // The shipped constant must be exactly what this solve returns for the
  // shipped `a0` — otherwise the module's own derivation has drifted.
  assert.ok(
    Math.abs(
      ceilingFor(M.SOLAR_LIMB_DARKENING_A0) -
        M.SOLAR_DISC_RADIANCE_CONTRAST_CEILING,
    ) < 1e-9,
  );
  // Across the two primary datasets' `a0`, the ceiling stays within 5% of the
  // shipped radiance of 2.0 — so the "two independent derivations agree"
  // argument is robust, not a knife edge.
  for (const a0 of [
    REF_NL_579_88[0],
    M.SOLAR_LIMB_DARKENING_A0,
    REF_PS_579_88[0],
  ]) {
    const c = ceilingFor(a0);
    assert.ok(
      Math.abs(2.0 - c) / c < 0.05,
      `a0 = ${a0} gives a ceiling of ${c}, which is more than 5% from 2.0`,
    );
  }
  // The ceiling IS sensitive to `a0` — the check above would be vacuous if it
  // were not. A law 33% darker at the limb moves it by more than 15%.
  assert.ok(Math.abs(2.0 - ceilingFor(0.4)) / ceilingFor(0.4) > 0.15);
});

test("CO-35: the law is a BAKE cost, never a per-frame one", async () => {
  // The performance half of the ruling's condition, pinned STRUCTURALLY rather
  // than timed: both bakes run the law only inside a rebuild branch guarded by
  // an appearance key, so a frame that changes nothing evaluates it zero times.
  const sun = readEngine("Scene/Sun.js").replaceAll("\r\n", "\n");
  const wgpu = readEngine(
    "Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  ).replaceAll("\r\n", "\n");
  assert.match(
    sun,
    /this\._bakedAppearanceKey !== appearance\.key \+ \(halo\.key << 2\)/,
    "the WebGL bake must be gated on the appearance+halo key",
  );
  assert.match(
    wgpu,
    /cache\.lastAppearanceKey !== appearanceKey/,
    "the WebGPU bake must be gated on the appearance key",
  );
  assert.match(
    wgpu,
    /Rebuild only on change to avoid a per-frame CPU bake/,
    "the WebGPU bake's own statement of the invariant must survive",
  );
  // The one per-frame consumer is the eclipse quadrature, and it is bounded:
  // a fixed Gauss order over at most four radial segments, and only while an
  // eclipse is in progress.
  const obs = readEngine("Scene/computeSolarObscuration.js").replaceAll(
    "\r\n",
    "\n",
  );
  assert.match(obs, /const QUADRATURE_ORDER = 16;/);
  assert.match(obs, /breakpoints\[count\+\+\] = rs;/);
});
