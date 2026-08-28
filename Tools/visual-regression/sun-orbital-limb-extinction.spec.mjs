// sun-orbital-limb-extinction.spec.mjs — C12-29 slice S4 (orbital-sunrise
// limb glow), VERIFICATION lane.
// @purpose Measures the shipped orbital extinction ramp and behaviorally verifies the shared Sun atmospheric-alpha publication and WebGPU pack.
// @status ACTIVE
//
// S4's brief said: "probe the EXISTING Sun.js extinction integrator first —
// it may already be the reddening ramp, currently unobservable behind the
// cull". This spec is that probe, and the answer it measures is YES.
//
// The research report's §3.4 doubted the `Sun.js` comment claiming the
// from-orbit case is "exactly ONE (the ray never crosses the shell)". That
// claim is true only for rays that miss the 111 km shell. From a 400 km
// vantage the shell subtends 73.1 deg from nadir and the solid Earth 70.2
// deg, so a 2.9-deg-wide annulus of directions produces limb-GRAZING rays
// that traverse the whole atmosphere — which is exactly the band the sun
// crosses during an orbital sunset. Along those rays the existing integrator
// already produces the full reddening ramp.
//
// WHAT THIS SPEC PINS (all numbers measured, not predicted):
//   - identity above the shell is EXACT (byte-identical frames outside the
//     occultation band, which is what makes the effect safe to ship);
//   - the ramp is monotone in every channel across tangent heights
//     110 km -> 0 km and spans ~5 orders of magnitude in blue;
//   - it REDDENS monotonically: the red/blue transmittance ratio climbs from
//     1.0 to ~2.0e6, passing 3.3 at 25 km, 25 at 15 km, 209 at 10 km;
//   - rays that pass below the surface extinguish to ~0 (the sun is behind
//     the Earth there and C12-29 S1's `sunVisibleFraction` is already 0);
//   - EQUIVALENCE GATE (S2 doctrine — equivalence beats a predictive model):
//     the shipped 16-sample rule reproduces a 40,000-sample midpoint
//     reference of the SAME integrand to better than 5e-5 absolute, over the
//     entire sweep. That refutes the a-priori worry that 16 uniform samples
//     over a ~2,400 km chord cannot resolve an 8-10 km scale height: the
//     chord's density profile is near-Gaussian with sigma = sqrt(r_t * H)
//     ~ 250 km against a ~150 km step, and midpoint sampling of a Gaussian
//     converges by Poisson summation, not by step-size ratio.
//
// WHAT IS THEREFORE *NOT* MISSING: the ramp physics, the per-channel
// reddening, the publication to both backends. What IS still missing is
// recorded on the C12-29 S4 row: the extinction is evaluated on the
// camera->sun-CENTRE ray only, so the whole billboard gets one uniform tint,
// while a real setting sun is graded ACROSS its disc. The sun's 0.5329-deg
// angular diameter maps to a 21.34 km span in tangent height here, and the
// upper-limb / lower-limb ratio measured with THIS integrator is strongly
// altitude- and channel-dependent — red / green / blue: 1.02 / 1.05 / 1.12
// at 60 km, 1.18 / 1.47 / 2.33 at 40 km, 2.27 / 6.16 / 4.8e1 at 25 km,
// 5.03 / 2.6e1 / 7.7e2 at 20 km, 5.1e1 / 7.7e2 / 2.0e5 at 15 km,
// 1.7e5 / 1.4e7 / 1.2e11 at 10 km, 2.6e9 / 9.7e11 / 1.9e17 at 0 km.
// (An earlier revision of this header quoted "5.6x in blue" as the figure
// and cited a table that did not exist; 5.6x is reached only in a narrow
// ~31.75-34.25 km band and understates the gap by many orders of magnitude
// across 0-15 km, exactly where an orbital sunset is interesting. The
// numbers above are asserted by `differential extinction across the disc`
// below so the restatement cannot rot.) That differential, and refraction
// lift/flattening, remain the deferred polish the research report named.
//
// Run: node --test Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs

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

// Cesium's shipped atmosphere defaults (Scene/Atmosphere.js) and the
// 111 km shell `computeAtmosphereExtinction` integrates over.
const ATMOSPHERE = {
  rayleighScaleHeight: 10000.0,
  mieScaleHeight: 3200.0,
};
const R_EARTH = 6378137.0;
const SHELL = 111e3;
const ALTITUDE = 400e3;
const SUN_DISTANCE = 1.496e11;

async function fixture() {
  const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
  const { default: computeAtmosphereExtinction } = await importEngine(
    "Scene/computeAtmosphereExtinction.js",
  );
  const atmosphere = {
    ...ATMOSPHERE,
    rayleighCoefficient: new Cartesian3(5.5e-6, 13.0e-6, 28.4e-6),
    mieCoefficient: new Cartesian3(21e-6, 21e-6, 21e-6),
  };
  const rCam = R_EARTH + ALTITUDE;
  const camera = new Cartesian3(rCam, 0, 0);

  // A ray from `camera` whose closest approach to the Earth's centre is
  // `tangentRadius`. camera is on +x, so a direction at angle
  // alpha = pi - asin(b / rCam) from +x has |camera x dir| = b and points
  // "downward" past the limb (closest approach in FRONT of the camera).
  const directionFor = (tangentRadius) => {
    const alpha = Math.PI - Math.asin(Math.min(1.0, tangentRadius / rCam));
    return new Cartesian3(Math.cos(alpha), Math.sin(alpha), 0.0);
  };
  const sunFor = (tangentRadius) => {
    const d = directionFor(tangentRadius);
    return new Cartesian3(
      camera.x + SUN_DISTANCE * d.x,
      camera.y + SUN_DISTANCE * d.y,
      camera.z + SUN_DISTANCE * d.z,
    );
  };
  const transmittanceAt = (tangentHeightKm) =>
    computeAtmosphereExtinction(
      new Cartesian3(),
      camera,
      sunFor(R_EARTH + tangentHeightKm * 1000.0),
      atmosphere,
      R_EARTH,
    );

  // Independent high-resolution midpoint quadrature of the same integrand.
  const reference = (tangentHeightKm, steps) => {
    const d = directionFor(R_EARTH + tangentHeightKm * 1000.0);
    const b = 2.0 * (camera.x * d.x + camera.y * d.y + camera.z * d.z);
    const outer = R_EARTH + SHELL;
    const c = rCam * rCam - outer * outer;
    const disc = b * b - 4.0 * c;
    if (disc <= 0.0) {
      return { x: 1.0, y: 1.0, z: 1.0 };
    }
    const sq = Math.sqrt(disc);
    const tEntry = Math.max((-b - sq) * 0.5, 0.0);
    const tExit = Math.min((-b + sq) * 0.5, SUN_DISTANCE);
    if (tExit <= tEntry) {
      return { x: 1.0, y: 1.0, z: 1.0 };
    }
    const step = (tExit - tEntry) / steps;
    let tauR = 0.0;
    let tauM = 0.0;
    for (let i = 0; i < steps; i++) {
      const t = tEntry + (i + 0.5) * step;
      const h = Math.max(
        Math.hypot(camera.x + d.x * t, camera.y + d.y * t, camera.z + d.z * t) -
          R_EARTH,
        0.0,
      );
      tauR += Math.exp(-h / ATMOSPHERE.rayleighScaleHeight) * step;
      tauM += Math.exp(-h / ATMOSPHERE.mieScaleHeight) * step;
    }
    const ch = (kr, km) => Math.exp(-(kr * tauR + km * tauM));
    return {
      x: ch(atmosphere.rayleighCoefficient.x, atmosphere.mieCoefficient.x),
      y: ch(atmosphere.rayleighCoefficient.y, atmosphere.mieCoefficient.y),
      z: ch(atmosphere.rayleighCoefficient.z, atmosphere.mieCoefficient.z),
    };
  };

  return { transmittanceAt, reference };
}

const shaderStubUrl = `data:text/javascript;base64,${Buffer.from(
  'export default "";',
).toString("base64")}`;

async function importSunForBehavior() {
  const shaderStubs = new Set([
    "Shaders/SunFS.js",
    "Shaders/SunTextureFS.js",
    "Shaders/SunVS.js",
  ]);
  const source = readEngine("Scene/Sun.js").replace(
    /from "(\.{1,2}\/[^"]+)";/g,
    (statement, specifier) => {
      const relative = path.posix.normalize(
        path.posix.join("Scene", specifier),
      );
      const url = shaderStubs.has(relative)
        ? shaderStubUrl
        : pathToFileURL(enginePath(relative)).href;
      return `from "${url}";`;
    },
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
}

function extractFunction(sourcePath, functionName) {
  const source = readEngine(sourcePath).replace(/\r\n/g, "\n");
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start > 0, `${functionName} must exist in ${sourcePath}`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `could not delimit ${functionName}`);
  return source.slice(start, end + 2);
}

async function loadPackSunUniforms() {
  const [
    matrixModule,
    encodedModule,
    cartesianModule,
    mathModule,
    definedModule,
  ] = await Promise.all([
    importEngine("Core/Matrix4.js"),
    importEngine("Core/EncodedCartesian3.js"),
    importEngine("Core/Cartesian3.js"),
    importEngine("Core/Math.js"),
    importEngine("Core/defined.js"),
  ]);
  const Matrix4 = matrixModule.default;
  const EncodedCartesian3 = encodedModule.default;
  const Cartesian3 = cartesianModule.default;
  const CesiumMath = mathModule.default;
  const defined = definedModule.default;
  const body = extractFunction(
    "Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
    "packSunUniforms",
  );
  const declarations = `
    const scratchModelView = new Matrix4();
    const scratchMVRTE = new Matrix4();
    const scratchMVPRTE = new Matrix4();
    const scratchEncodedCamera = new EncodedCartesian3();
    const scratchEncodedPos = new EncodedCartesian3();
    const defaultSunPosition = Object.freeze(new Cartesian3(1.5e11, 0.0, 0.0));
    const DEFAULT_SUN_ANGULAR_HALF_SIZE =
      CesiumMath.SOLAR_RADIUS / 149597870700.0;
  `;
  // eslint-disable-next-line no-new-func
  const makePack = new Function(
    "Matrix4",
    "EncodedCartesian3",
    "Cartesian3",
    "CesiumMath",
    "defined",
    `${declarations}\n${body}\nreturn packSunUniforms;`,
  );
  return makePack(Matrix4, EncodedCartesian3, Cartesian3, CesiumMath, defined);
}

async function publishDawnSunState() {
  const [
    sunModule,
    atmosphereModule,
    cartesianModule,
    ellipsoidModule,
    matrixModule,
    sceneModeModule,
  ] = await Promise.all([
    importSunForBehavior(),
    importEngine("Scene/Atmosphere.js"),
    importEngine("Core/Cartesian3.js"),
    importEngine("Core/Ellipsoid.js"),
    importEngine("Core/Matrix4.js"),
    importEngine("Scene/SceneMode.js"),
  ]);
  const Sun = sunModule.default;
  const Atmosphere = atmosphereModule.default;
  const Cartesian3 = cartesianModule.default;
  const Ellipsoid = ellipsoidModule.default;
  const Matrix4 = matrixModule.default;
  const SceneMode = sceneModeModule.default;
  const radius = Ellipsoid.default.maximumRadius;
  const cameraPosition = new Cartesian3(radius, 0.0, 0.0);
  const altitude = (5.0 * Math.PI) / 180.0;
  const sunPosition = new Cartesian3(
    cameraPosition.x + SUN_DISTANCE * Math.sin(altitude),
    SUN_DISTANCE * Math.cos(altitude),
    0.0,
  );
  let observedAtBackendBranch;
  const featureRenderer = {
    update(sun, state) {
      observedAtBackendBranch = state.sunAtmosphereAlpha;
      return { owner: sun };
    },
  };
  const frameState = {
    mode: SceneMode.SCENE3D,
    passes: { render: true },
    skyAtmosphereVisible: true,
    atmosphere: new Atmosphere(),
    camera: { positionWC: cameraPosition },
    context: {
      drawingBufferWidth: 1280,
      drawingBufferHeight: 720,
      uniformState: {
        sunPositionWC: sunPosition,
        view: Matrix4.IDENTITY,
        projection: Matrix4.IDENTITY,
      },
      getFeatureRenderer() {
        return featureRenderer;
      },
    },
    eclipseState: undefined,
    atmosphericConditions: undefined,
    sunBloomActive: false,
    useHDR: false,
  };
  const sun = new Sun();
  sun.update(frameState, { viewport: { width: 1280, height: 720 } }, false);
  return { frameState, observedAtBackendBranch, sun };
}

test("atmospheric alpha publishes before the backend branch and packs at offset 35", async () => {
  // This executes the CPU derivation, Sun publication and WebGPU uniform pack.
  // Node does not execute either fragment shader, so no pixel claim is made.
  const { frameState, observedAtBackendBranch, sun } =
    await publishDawnSunState();
  const extinction = frameState.sunAtmosphereExtinction;
  const expected = Math.min(
    1.0,
    Math.max(extinction.x, extinction.y, extinction.z),
  );
  assert.ok(expected > 0.0 && expected < 1.0);
  const packSunUniforms = await loadPackSunUniforms();
  const uniformData = new Float32Array(64);
  packSunUniforms(uniformData, frameState, 1.0, 1.0);
  assert.equal(uniformData[35], Math.fround(expected));
  assert.notEqual(uniformData[35], 1.0);
  assert.equal(frameState.sunAtmosphereAlpha, expected);
  assert.equal(observedAtBackendBranch, expected);
  assert.equal(sun._uniformMap.u_atmosphereAlpha(), expected);
});

test("atmospheric alpha pack fallback is identity for both absence forms", async () => {
  const { frameState } = await publishDawnSunState();
  const packSunUniforms = await loadPackSunUniforms();

  const omitted = { ...frameState };
  delete omitted.sunAtmosphereAlpha;
  const omittedData = new Float32Array(64);
  packSunUniforms(omittedData, omitted, 1.0, 1.0);
  assert.equal(omittedData[35], 1.0);

  const explicitUndefined = {
    ...frameState,
    sunAtmosphereAlpha: undefined,
  };
  const undefinedData = new Float32Array(64);
  packSunUniforms(undefinedData, explicitUndefined, 1.0, 1.0);
  assert.equal(undefinedData[35], 1.0);
});

test("S4: above the shell the orbital sun is EXACTLY unattenuated", async () => {
  const { transmittanceAt } = await fixture();
  for (const h of [115, 130, 200, 1000]) {
    const t = transmittanceAt(h);
    assert.equal(t.x, 1.0, `red at ${h} km`);
    assert.equal(t.y, 1.0, `green at ${h} km`);
    assert.equal(t.z, 1.0, `blue at ${h} km`);
  }
});

test("S4: the limb ramp already exists — monotone, multi-decade, reddening", async () => {
  const { transmittanceAt } = await fixture();
  let prev = transmittanceAt(111);
  let prevRatio = 1.0;
  for (let h = 110; h >= 0; h -= 1) {
    const t = transmittanceAt(h);
    assert.ok(
      t.x <= prev.x,
      `red must not brighten as the ray sinks (${h} km)`,
    );
    assert.ok(t.y <= prev.y, `green must not brighten (${h} km)`);
    assert.ok(t.z <= prev.z, `blue must not brighten (${h} km)`);
    assert.ok(t.x >= t.y && t.y >= t.z, `red >= green >= blue (${h} km)`);
    const ratio = t.x / Math.max(t.z, Number.MIN_VALUE);
    assert.ok(
      ratio >= prevRatio - 1e-12,
      `reddening must not reverse (${h} km)`,
    );
    prev = t;
    prevRatio = ratio;
  }

  // Measured anchors (Edge-free, pure CPU): the ramp is not marginal.
  const at = (h) => transmittanceAt(h);
  assert.ok(at(50).z > 0.85 && at(50).z < 0.92, `blue at 50 km: ${at(50).z}`);
  assert.ok(at(25).z > 0.2 && at(25).z < 0.25, `blue at 25 km: ${at(25).z}`);
  assert.ok(at(10).z < 1e-3, `blue at 10 km: ${at(10).z}`);
  assert.ok(at(0).z < 1e-10, `blue at 0 km: ${at(0).z}`);
  assert.ok(at(0).x > 1e-6 && at(0).x < 1e-4, `red at 0 km: ${at(0).x}`);
  assert.ok(at(25).x / at(25).z > 3.0, "reddened by 25 km");
  assert.ok(at(10).x / at(10).z > 100.0, "strongly reddened by 10 km");

  // Below the surface the ray is inside the Earth: essentially zero.
  for (const h of [-10, -20, -50]) {
    const t = transmittanceAt(h);
    assert.ok(t.x < 1e-8, `red below the surface (${h} km): ${t.x}`);
  }
});

test("S4 equivalence gate: 16 samples reproduce a 40,000-sample reference", async () => {
  const { transmittanceAt, reference } = await fixture();
  let worst = 0.0;
  let worstH = 0;
  for (let h = 150; h >= -60; h -= 5) {
    const got = transmittanceAt(h);
    const ref = reference(h, 40000);
    const err = Math.max(
      Math.abs(got.x - ref.x),
      Math.abs(got.y - ref.y),
      Math.abs(got.z - ref.z),
    );
    if (err > worst) {
      worst = err;
      worstH = h;
    }
  }
  // Measured 5.2e-6 at h = 45 km; pinned an order of magnitude above so the
  // gate flags a real regression, not quadrature noise.
  assert.ok(
    worst < 5e-5,
    `EXTINCTION_STEPS = 16 must resolve the limb chord (worst ${worst} at ${worstH} km)`,
  );
  // The gate must not be vacuous: the reference has to actually vary.
  const ref0 = reference(0, 40000);
  const ref100 = reference(100, 40000);
  assert.ok(ref100.z / ref0.z > 1e6, "the reference itself spans the ramp");
});

test("S4 deferred limit: differential extinction across the disc, measured", async () => {
  const { transmittanceAt } = await fixture();
  const SOLAR_RADIUS = 6.957e8;
  const rCam = R_EARTH + ALTITUDE;
  // Angular half-diameter of the sun -> the tangent-height span it subtends
  // at the limb. d(theta)/d(tangent radius) = 1 / (rCam * sqrt(1-(R/rCam)^2)).
  const angRadius = SOLAR_RADIUS / SUN_DISTANCE;
  const dThetaPerMetre = 1.0 / (rCam * Math.sqrt(1.0 - (R_EARTH / rCam) ** 2));
  const spanKm = (2.0 * angRadius) / dThetaPerMetre / 1000.0;
  assert.ok(
    Math.abs(spanKm - 21.34) < 0.15,
    `the 0.53-deg disc spans ~21.34 km of tangent height (${spanKm})`,
  );
  const halfKm = 0.5 * spanKm;
  const ratio = (h, ch) => {
    const top = transmittanceAt(h + halfKm);
    const bot = transmittanceAt(h - halfKm);
    return top[ch] / Math.max(bot[ch], Number.MIN_VALUE);
  };

  // The table quoted in this file's header and in Sun.js. Bands are wide
  // (x1.6) because the point is the ORDER OF MAGNITUDE, not a tight fit —
  // what must never come back is the single "5.6x" figure.
  const expected = [
    [60, 1.02, 1.05, 1.12],
    [40, 1.18, 1.47, 2.33],
    [25, 2.27, 6.16, 4.8e1],
    [20, 5.03, 2.6e1, 7.7e2],
    [15, 5.1e1, 7.7e2, 2.0e5],
    [10, 1.7e5, 1.4e7, 1.2e11],
    [0, 2.6e9, 9.7e11, 1.9e17],
  ];
  for (const [h, r, g, b] of expected) {
    for (const [ch, want] of [
      ["x", r],
      ["y", g],
      ["z", b],
    ]) {
      const got = ratio(h, ch);
      assert.ok(
        got > want / 1.6 && got < want * 1.6,
        `disc ratio at ${h} km, channel ${ch}: got ${got.toExponential(3)}, table says ${want}`,
      );
    }
  }

  // The retired "5.6x in blue" claim: true only in a narrow high band, and
  // wrong by many orders of magnitude where an orbital sunset is visible.
  assert.ok(
    ratio(33, "z") > 4.5 && ratio(33, "z") < 7.0,
    "5.6x lives at ~33 km",
  );
  assert.ok(
    ratio(10, "z") > 1e9,
    "…and understates the 10 km case by >8 orders of magnitude",
  );
  // Monotone: the grading only ever gets worse as the sun sinks.
  let prev = 0;
  for (let h = 60; h >= 0; h -= 2) {
    const v = ratio(h, "z");
    assert.ok(
      v >= prev,
      `disc grading must increase as the sun sinks (${h} km)`,
    );
    prev = v;
  }
});

test("S4 wiring: the ramp reaches BOTH backends, gated only on sky visibility", () => {
  const sun = readEngine("Scene/Sun.js");
  const glsl = readEngine("Shaders/SunFS.glsl");
  const wgpu = readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js");
  const scene = readEngine("Scene/Scene.js");

  // Published before the backend branch (the C7-SUN-STARS-EXTINCTION rule).
  const publishIdx = sun.indexOf("frameState.sunAtmosphereExtinction =");
  const branchIdx = sun.indexOf("getFeatureRenderer(FeatureRendererKey.SUN)");
  assert.ok(publishIdx > 0 && publishIdx < branchIdx);

  // Both backends multiply the sun's RGB by it.
  assert.match(glsl, /out_FragColor\.rgb \*= u_atmosphereExtinction;/);
  assert.match(wgpu, /color\.rgb \* u\.extinction/);
  assert.match(wgpu, /frameState\.sunAtmosphereExtinction/);

  // The gate is `skyAtmosphere.show`, with NO altitude term — that is what
  // lets the ramp run from orbit at all.
  const gate = scene.match(/frameState\.skyAtmosphereVisible =\s*[^;]+;/);
  assert.ok(gate, "skyAtmosphereVisible assignment must exist");
  assert.ok(
    !/altitude|height|cameraHeight/i.test(gate[0]),
    `the extinction gate must not be altitude-keyed: ${gate[0]}`,
  );

  // The stale "from orbit the ray never crosses the shell" claim must be
  // corrected — it is false in exactly the geometry S4 cares about.
  assert.ok(
    !/the physics yields exactly Cartesian3\.ONE from orbit/.test(sun),
    "Sun.js must no longer claim the orbital case is unconditionally identity",
  );
});
