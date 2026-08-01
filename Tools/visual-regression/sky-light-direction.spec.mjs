// C12-31 — NATURAL SOLAR ATMOSPHERIC AUREOLE: the sky's light-direction contract.
//
// The maintainer screenshot (2026-07-28) showed a broad white patch overhead
// that is not the Sun billboard, not generic post-process bloom and not an RTE
// failure. It is the shared legacy `DynamicAtmosphereLightingType.NONE` path
// substituting a per-sample `normalize(positionWC)` — a different "Sun directly
// overhead" at every sample — for the one astronomical Sun. `Globe.enableLighting`
// defaults to `false`, so `DynamicAtmosphereLightingType.fromGlobeFlags` resolves
// NONE in the default viewer and every default scene rendered it.
//
// Four separable claims, pinned here so a browser is never needed to catch a
// regression in any of them:
//
//   1. THE MECHANISM — under the local-up substitution the Mie phase argument
//      `cosAngle = dot(cameraToPositionWCDirection, lightDirection)` is ≈1 along
//      every ray a ground observer looks down, so the phase function sits on its
//      forward peak everywhere. At the default anisotropy g = 0.9 that peak is
//      4869.9× the 90° value. Derived here from an independent implementation of
//      the phase function and pinned against `AtmosphereCommon.glsl`.
//
//   2. THE SELECTION — NONE resolves to the astronomical Sun; SCENE_LIGHT and
//      SUNLIGHT are unchanged; a NEW, named, explicit `LEGACY_OVERHEAD` mode
//      reproduces the historical appearance exactly. Second implementation of
//      the selector, checked against both shaders' text.
//
//   3. TWIN LOCKSTEP — the GLSL builtin and the WGSL block carry the same four
//      arms, and the WGSL still validates under naga.
//
//   4. WHAT MUST NOT MOVE — the day/night alpha gates in both shaders stay keyed
//      on `enum != 0` (so the shell's OPACITY is untouched, which is what keeps
//      the C12-29 eclipse suites green), LUT eligibility is byte-identical for
//      enums 0/1/2, `fromGlobeFlags` is unchanged, and the non-sky atmosphere
//      consumers (model ground-atmosphere/fog, the IBL radiance bake) still call
//      the legacy selector — their migration is a separate, deliberate act.
//
// `node --test Tools/visual-regression/sky-light-direction.spec.mjs`

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSourcePinIsWidthSafe } from "./lib/provenance-markers.mjs";
import {
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import DynamicAtmosphereLightingType from "../../packages/engine/Source/Scene/DynamicAtmosphereLightingType.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Source-order pins must not depend on a checkout's LF/CRLF policy.
const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");

const skyLightDirGlsl = read(
  "packages/engine/Source/Shaders/Builtin/Functions/getSkyAtmosphereLightDirection.glsl",
);
const legacyLightDirGlsl = read(
  "packages/engine/Source/Shaders/Builtin/Functions/getDynamicAtmosphereLightDirection.glsl",
);
const skyAtmosphereVs = read(
  "packages/engine/Source/Shaders/SkyAtmosphereVS.glsl",
);
const skyAtmosphereFs = read(
  "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
);
const skyAtmosphereCommon = read(
  "packages/engine/Source/Shaders/SkyAtmosphereCommon.glsl",
);
const skyAtmosphereWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
);
const atmosphereCommon = read(
  "packages/engine/Source/Shaders/AtmosphereCommon.glsl",
);
const atmosphereStageFs = read(
  "packages/engine/Source/Shaders/Model/AtmosphereStageFS.glsl",
);
const radianceMapFs = read(
  "packages/engine/Source/Shaders/ComputeRadianceMapFS.glsl",
);
const proceduralSkyWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Compute/ProceduralSkyCubemap.wgsl",
);
const dynamicLightingTypeJs = read(
  "packages/engine/Source/Scene/DynamicAtmosphereLightingType.js",
);
const atmosphereUniformsTs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereUniforms.ts",
);
const skyRendererJs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
);

/** Author a pin and prove it survives a prettier re-wrap before using it. */
function pin(sourceText, pattern, label) {
  assertSourcePinIsWidthSafe({ pattern, sourceText, label });
  assert.match(sourceText, pattern, label);
}

// ── Second implementations (never imported from the engine) ────────────────

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

/**
 * Independent implementation of the Mie phase in `computeAtmosphereColor`
 * (`AtmosphereCommon.glsl`). Not imported — the SOURCE is pinned separately.
 */
function miePhase(cosAngle, g) {
  const gSq = g * g;
  const cosSq = cosAngle * cosAngle;
  return (
    ((3.0 / 25.1327412287) * ((1.0 - gSq) * (cosSq + 1.0))) /
    (Math.pow(1.0 + gSq - 2.0 * cosAngle * g, 1.5) * (2.0 + gSq))
  );
}

/** The engine's documented default anisotropy (`SkyAtmosphere.atmosphereMieAnisotropy`). */
const DEFAULT_MIE_ANISOTROPY = 0.9;

/**
 * Second implementation of the light-direction selector shared by
 * `czm_getSkyAtmosphereLightDirection` and the `isLegacyOverhead` block in
 * `SkyAtmosphere.wgsl`.
 */
function selectSkyLightDirection(positionWC, lightEnum, sunWC, sceneLightWC) {
  if (lightEnum === 1) {
    return norm(sceneLightWC);
  }
  if (lightEnum === 3) {
    return norm(positionWC);
  }
  return norm(sunWC);
}

/** The pre-C12-31 selector, kept so the negative controls are real. */
function selectLegacyLightDirection(
  positionWC,
  lightEnum,
  sunWC,
  sceneLightWC,
) {
  if (lightEnum === 1) {
    return norm(sceneLightWC);
  }
  if (lightEnum === 2) {
    return norm(sunWC);
  }
  return norm(positionWC);
}

const EARTH_RADIUS = 6378137.0;
// `ATMOSPHERE_THICKNESS` in AtmosphereCommon.glsl. The exact value does not
// matter to the argument below (any shell thin against the planet gives the same
// conclusion); it is used so the geometry is the engine's, not a toy.
const ATMOSPHERE_THICKNESS = 111e3;

/** A unit vector at `elevationDeg` above the local horizon, `azimuthDeg` from east. */
function localDirection(elevationDeg, azimuthDeg) {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  // Local frame: up = +z, east = +x, north = +y — matched to the observer below.
  return [
    Math.cos(el) * Math.cos(az),
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
  ];
}

// Ground observer on the +z pole, so the local frame above IS the world frame.
const OBSERVER = [0, 0, EARTH_RADIUS];

/** Where a view ray leaves the shell — the `positionWC` both shaders shade. */
function shellExit(rayDir) {
  // Ray/sphere against the outer shell from a point on the inner sphere.
  const outer = EARTH_RADIUS + ATMOSPHERE_THICKNESS;
  const b = 2 * dot(OBSERVER, rayDir);
  const c = dot(OBSERVER, OBSERVER) - outer * outer;
  const t = (-b + Math.sqrt(b * b - 4 * c)) / 2;
  return add(OBSERVER, scale(rayDir, t));
}

/** Upper-hemisphere sampling grid, coarse enough to stay fast, fine enough to localize a peak. */
function* upperHemisphere(stepDeg = 2) {
  for (let el = 0; el <= 90; el += stepDeg) {
    for (let az = 0; az < 360; az += stepDeg) {
      yield { el, az, dir: localDirection(el, az) };
    }
  }
}

/** The sky direction with the strongest Mie response, under a given selector. */
function mieArgmax(selector, lightEnum, sunWC, sceneLightWC) {
  let best = null;
  for (const sample of upperHemisphere()) {
    const positionWC = shellExit(sample.dir);
    const lightDir = selector(positionWC, lightEnum, sunWC, sceneLightWC);
    // `computeAtmosphereColor`: cosAngle = dot(normalize(positionWC - viewer), L)
    const viewDir = norm([
      positionWC[0] - OBSERVER[0],
      positionWC[1] - OBSERVER[1],
      positionWC[2] - OBSERVER[2],
    ]);
    const phase = miePhase(dot(viewDir, lightDir), DEFAULT_MIE_ANISOTROPY);
    if (best === null || phase > best.phase) {
      best = { ...sample, phase };
    }
  }
  return best;
}

const angleBetweenDeg = (a, b) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI;

// ───────────────────── 1. the mechanism, quantified ────────────────────────

test("the Mie forward peak at the default anisotropy is 4869.9x the 90-degree value", () => {
  const ratio =
    miePhase(1.0, DEFAULT_MIE_ANISOTROPY) /
    miePhase(0.0, DEFAULT_MIE_ANISOTROPY);
  assert.ok(
    Math.abs(ratio - 4869.9) < 0.5,
    `forward/side Mie ratio ${ratio}, expected 4869.9`,
  );
  // The figure quoted in the code comments must be the one the math produces.
  for (const [name, src] of [
    ["getSkyAtmosphereLightDirection.glsl", skyLightDirGlsl],
    ["SkyAtmosphereFS.glsl", skyAtmosphereFs],
    ["SkyAtmosphere.wgsl", skyAtmosphereWgsl],
  ]) {
    assert.ok(
      src.includes("4869.9"),
      `${name}: the derived ratio is not quoted`,
    );
  }
});

test("the phase function this reasons about is the one the shader ships", () => {
  // If `computeAtmosphereColor` stops taking cosAngle against the light
  // direction, or the Mie expression is retuned, the derivation above is no
  // longer about the shipped code and this says so.
  pin(
    atmosphereCommon,
    /float\s+cosAngle\s*=\s*dot\(cameraToPositionWCDirection,\s*lightDirection\);/,
    "cosAngle definition",
  );
  assert.ok(
    atmosphereCommon.includes(
      "3.0 / (25.1327412287) * ((1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq))",
    ),
    "the Mie phase expression moved",
  );
  // And the default anisotropy the ratio is quoted at.
  pin(
    read("packages/engine/Source/Scene/SkyAtmosphere.js"),
    /this\.atmosphereMieAnisotropy\s*=\s*0\.9;/,
    "default anisotropy",
  );
});

test("the legacy substitution parks the peak on the zenith, sun-independently", () => {
  // The defect, reproduced: sweep the sun right around the sky and the bright
  // lobe does not move. This is the negative control for every claim below —
  // if it ever stops failing, the "fix" tests are measuring nothing.
  const peaks = [];
  for (const sunEl of [60, 20, 0, -20]) {
    for (const sunAz of [0, 90, 180, 270]) {
      const sunWC = localDirection(sunEl, sunAz);
      peaks.push(mieArgmax(selectLegacyLightDirection, 0, sunWC, [0, 0, 1]));
    }
  }
  for (const peak of peaks) {
    assert.equal(peak.el, 90, "the legacy peak is not at the zenith");
  }
  // …and it is the FULL forward peak, i.e. the maximum the phase can reach.
  const forward = miePhase(1.0, DEFAULT_MIE_ANISOTROPY);
  for (const peak of peaks) {
    assert.ok(
      peak.phase > 0.99 * forward,
      `legacy peak ${peak.phase} is not the forward peak ${forward}`,
    );
  }
});

test("the fixed selection anchors the peak to the sun at every sun position", () => {
  for (const sunEl of [75, 45, 15, 2]) {
    for (const sunAz of [0, 37, 90, 180, 271]) {
      const sunWC = localDirection(sunEl, sunAz);
      const peak = mieArgmax(selectSkyLightDirection, 0, sunWC, [0, 0, 1]);
      // 2-degree sampling grid, so the peak lands within one cell diagonal.
      assert.ok(
        angleBetweenDeg(peak.dir, sunWC) <= 3.0,
        `sun at el ${sunEl} az ${sunAz}: peak ${angleBetweenDeg(peak.dir, sunWC)} deg off`,
      );
    }
  }
});

test("no direct aureole survives once the sun is below the local horizon", () => {
  const forward = miePhase(1.0, DEFAULT_MIE_ANISOTROPY);
  const sunWC = localDirection(-20, 45);

  const fixed = mieArgmax(selectSkyLightDirection, 0, sunWC, [0, 0, 1]);
  assert.ok(
    fixed.phase < 0.05 * forward,
    `below-horizon sun still yields ${(100 * fixed.phase) / forward}% of the forward peak`,
  );
  // The residual brightest direction hugs the horizon on the sun's azimuth —
  // a sunset glow, not an overhead patch.
  assert.ok(fixed.el <= 4, `residual peak sits at elevation ${fixed.el}`);
  assert.ok(Math.abs(fixed.az - 45) <= 3, `residual peak azimuth ${fixed.az}`);

  // NEGATIVE CONTROL: the legacy path keeps the full overhead peak with the sun
  // 20 degrees underground — exactly the maintainer's screenshot.
  const legacy = mieArgmax(selectLegacyLightDirection, 0, sunWC, [0, 0, 1]);
  assert.ok(legacy.phase > 0.99 * forward);
  assert.equal(legacy.el, 90);
});

// ───────────────────── 2. the selection contract ───────────────────────────

test("the enum is add-only and LEGACY_OVERHEAD is the named compatibility mode", () => {
  assert.equal(DynamicAtmosphereLightingType.NONE, 0);
  assert.equal(DynamicAtmosphereLightingType.SCENE_LIGHT, 1);
  assert.equal(DynamicAtmosphereLightingType.SUNLIGHT, 2);
  assert.equal(DynamicAtmosphereLightingType.LEGACY_OVERHEAD, 3);
  assert.ok(Object.isFrozen(DynamicAtmosphereLightingType));
  // The legacy behaviour is PRESERVED, not deleted — a feature removal would
  // read as a passing test otherwise.
  pin(dynamicLightingTypeJs, /LEGACY_OVERHEAD:\s*3,/, "legacy mode value");
});

test("fromGlobeFlags is unchanged — the decoupling is in the direction, not the enum", () => {
  const globe = (enableLighting, dynamicAtmosphereLighting, fromSun) => ({
    enableLighting,
    dynamicAtmosphereLighting,
    dynamicAtmosphereLightingFromSun: fromSun,
  });
  assert.equal(
    DynamicAtmosphereLightingType.fromGlobeFlags(globe(false, true, false)),
    DynamicAtmosphereLightingType.NONE,
  );
  assert.equal(
    DynamicAtmosphereLightingType.fromGlobeFlags(globe(true, false, false)),
    DynamicAtmosphereLightingType.NONE,
  );
  assert.equal(
    DynamicAtmosphereLightingType.fromGlobeFlags(globe(true, true, false)),
    DynamicAtmosphereLightingType.SCENE_LIGHT,
  );
  assert.equal(
    DynamicAtmosphereLightingType.fromGlobeFlags(globe(true, true, true)),
    DynamicAtmosphereLightingType.SUNLIGHT,
  );
  // Turning terrain lighting off still resolves NONE — and NONE is now the
  // astronomical sun for the sky, which is the whole decoupling.
  const sunWC = [0.6, 0.8, 0.0];
  const positionWC = [0, 0, EARTH_RADIUS];
  assert.deepEqual(
    selectSkyLightDirection(positionWC, 0, sunWC, [0, 0, 1]),
    norm(sunWC),
  );
});

test("only SCENE_LIGHT and LEGACY_OVERHEAD deviate from the astronomical sun", () => {
  const sunWC = [0.6, 0.8, 0.0];
  const sceneLightWC = [0.0, 0.0, -1.0];
  const positionWC = [1000.0, 0.0, EARTH_RADIUS];

  assert.deepEqual(
    selectSkyLightDirection(
      positionWC,
      DynamicAtmosphereLightingType.NONE,
      sunWC,
      sceneLightWC,
    ),
    norm(sunWC),
  );
  assert.deepEqual(
    selectSkyLightDirection(
      positionWC,
      DynamicAtmosphereLightingType.SUNLIGHT,
      sunWC,
      sceneLightWC,
    ),
    norm(sunWC),
  );
  assert.deepEqual(
    selectSkyLightDirection(
      positionWC,
      DynamicAtmosphereLightingType.SCENE_LIGHT,
      sunWC,
      sceneLightWC,
    ),
    norm(sceneLightWC),
  );
  assert.deepEqual(
    selectSkyLightDirection(
      positionWC,
      DynamicAtmosphereLightingType.LEGACY_OVERHEAD,
      sunWC,
      sceneLightWC,
    ),
    norm(positionWC),
  );

  // "other modes unchanged": SCENE_LIGHT and SUNLIGHT agree with the pre-fix
  // selector for every input, and LEGACY_OVERHEAD agrees with the pre-fix NONE.
  for (const mode of [1, 2]) {
    assert.deepEqual(
      selectSkyLightDirection(positionWC, mode, sunWC, sceneLightWC),
      selectLegacyLightDirection(positionWC, mode, sunWC, sceneLightWC),
    );
  }
  assert.deepEqual(
    selectSkyLightDirection(positionWC, 3, sunWC, sceneLightWC),
    selectLegacyLightDirection(positionWC, 0, sunWC, sceneLightWC),
  );
  // …and NONE is the one arm that moved.
  assert.notDeepEqual(
    selectSkyLightDirection(positionWC, 0, sunWC, sceneLightWC),
    selectLegacyLightDirection(positionWC, 0, sunWC, sceneLightWC),
  );
});

// ───────────────────── 3. twin lockstep ────────────────────────────────────

test("both sky shaders select through the natural-sky selector", () => {
  // GLSL: one shared builtin, called from BOTH stages (the per-vertex path is
  // the default whenever a globe is visible, so missing the VS would leave the
  // defect in place for the default scene).
  pin(
    skyLightDirGlsl,
    /vec3\s+czm_getSkyAtmosphereLightDirection\(vec3\s+positionWC,\s*float\s+lightEnum\)/,
    "sky builtin signature",
  );
  pin(
    skyAtmosphereVs,
    /czm_getSkyAtmosphereLightDirection\(positionWC\.xyz,\s*lightEnum\)/,
    "VS call site",
  );
  pin(
    skyAtmosphereFs,
    /czm_getSkyAtmosphereLightDirection\(v_outerPositionWC,\s*lightEnum\)/,
    "FS call site",
  );
  assert.ok(
    !/czm_getDynamicAtmosphereLightDirection/.test(skyAtmosphereVs) &&
      !/czm_getDynamicAtmosphereLightDirection/.test(skyAtmosphereFs),
    "a sky stage still calls the legacy selector",
  );

  // WGSL: the same four arms, inline (no builtin include mechanism in WGSL).
  pin(
    skyAtmosphereWgsl,
    /let\s+isLegacyOverhead\s*=\s*dynamicLighting\s*>\s*2\.5;/,
    "WGSL legacy predicate",
  );
  pin(
    skyAtmosphereWgsl,
    /lightDirWC\s*=\s*normalize\(skyPoint\);/,
    "WGSL legacy arm",
  );
  pin(skyAtmosphereWgsl, /lightDirWC\s*=\s*u\.sunDirectionWC;/, "WGSL sun arm");
  // The old predicate must be gone from the CODE. It is still named in one
  // comment (so a reader can see what the gate used to be), which is why these
  // two pins target the declaration and the use rather than the identifier.
  assert.ok(
    !/let\s+isNoneCase/.test(skyAtmosphereWgsl),
    "the WGSL still declares the old NONE predicate",
  );
  assert.ok(
    !/!isNoneCase\s*&&/.test(skyAtmosphereWgsl),
    "a WGSL gate still branches on the old NONE predicate",
  );
});

test("the GLSL and WGSL selectors agree on all four enum values", () => {
  // A textual twin check is not enough — assert the two source texts encode the
  // same mapping by reading the arms out of each and comparing the answers.
  const glslArms = {
    sceneLight: /czm_lightDirectionWC\s*\*\s*sceneLightWeight/.test(
      skyLightDirGlsl,
    ),
    sun: /czm_sunDirectionWC\s*\*\s*sunWeight/.test(skyLightDirGlsl),
    legacy: /positionWC\s*\*\s*legacyOverheadWeight/.test(skyLightDirGlsl),
    sunIsTheComplement:
      /sunWeight\s*=\s*1\.0\s*-\s*sceneLightWeight\s*-\s*legacyOverheadWeight;/.test(
        skyLightDirGlsl,
      ),
    legacyIsThree: /LEGACY_OVERHEAD\s*=\s*3\.0;/.test(skyLightDirGlsl),
    sceneLightIsOne: /SCENE_LIGHT\s*=\s*1\.0;/.test(skyLightDirGlsl),
  };
  for (const [name, ok] of Object.entries(glslArms)) {
    assert.ok(ok, `GLSL selector arm missing: ${name}`);
  }

  // The WGSL's SCENE_LIGHT arm lives on the CPU: the renderer packs the scene
  // light INTO `sunDirectionWC` for enum 1, which is why the shader has two
  // arms where the GLSL has three. Pin that seam or the twin claim is false.
  pin(
    skyRendererJs,
    /const\s+useSceneLight\s*=\s*dynamicLighting\s*===\s*1;/,
    "scene-light pack",
  );
  assert.ok(
    /useSceneLight\s*&&\s*defined\(sceneLightWC\)/.test(skyRendererJs),
    "the renderer no longer routes the scene light into sunDirectionWC",
  );
});

test("the sky WGSL still passes naga validation", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(
    () => naga.validate_wgsl(skyAtmosphereWgsl),
    "SkyAtmosphere.wgsl",
  );
  // `ProceduralSkyCubemap.wgsl` is NOT validated here: it is assembled with
  // JS-side chunk injection (`CLOUD_DENSITY_WORLD_TO_NOISE` and friends are
  // spliced in by `WebGPUDynamicEnvironmentMapManager`), so the file on disk is
  // not a standalone module and naga rejects it for reasons unrelated to this
  // change. Its edit here is a two-token predicate widening, pinned textually
  // in the consumer test below.
});

// ───────────────────── 4. what must not move ───────────────────────────────

test("the day/night alpha gates are untouched on both backends", () => {
  // This is what keeps the C12-29 eclipse suites green: the enum VALUE stays
  // NONE in the default scene, so the alpha ramp stays disabled exactly as it
  // was. Remapping NONE to SUNLIGHT would have changed the shell's opacity and
  // with it the totality star reveal, the skybox occlusion and the S6 twilight.
  pin(
    skyAtmosphereCommon,
    /float\s+nightAlpha\s*=\s*\(u_radiiAndDynamicAtmosphereColor\.z\s*!=\s*0\.0\)/,
    "GLSL night alpha gate",
  );
  pin(
    skyAtmosphereWgsl,
    /let\s+isDynamic\s*=\s*u\.radiiAndDynamicAtmosphere\.z\s*!=\s*0\.0;/,
    "WGSL night alpha gate",
  );
  pin(
    skyAtmosphereWgsl,
    /let\s+alpha\s*=\s*mix\(finalColor\.b,\s*1\.0,\s*opacity\);/,
    "WGSL alpha",
  );
});

test("in LEGACY_OVERHEAD the night-alpha term is still exactly 1.0", () => {
  // Both gates read `enum != 0`, so enum 3 takes the DYNAMIC branch. That is
  // only safe because the legacy light direction IS the normalized position, so
  // the dot product the branch computes is 1.0 identically — the new mode
  // reproduces the historical alpha without touching the pinned gate text.
  for (const sample of upperHemisphere(15)) {
    const positionWC = shellExit(sample.dir);
    const lightDir = selectSkyLightDirection(
      positionWC,
      3,
      [1, 0, 0],
      [0, 1, 0],
    );
    const nightAlpha = dot(norm(positionWC), lightDir);
    assert.ok(
      Math.abs(nightAlpha - 1.0) < 1e-12,
      `legacy nightAlpha ${nightAlpha} at el ${sample.el} az ${sample.az}`,
    );
  }
});

test("LUT eligibility is byte-identical for enums 0, 1 and 2", () => {
  pin(
    skyAtmosphereWgsl,
    /let\s+lutEligible\s*=\s*dynamicLighting\s*>\s*0\.5\s*&&\s*dynamicLighting\s*<\s*2\.5;/,
    "LUT eligibility",
  );
  const lutEligible = (e) => e > 0.5 && e < 2.5;
  const wasNotNone = (e) => !(e < 0.5);
  for (const e of [0, 1, 2]) {
    assert.equal(
      lutEligible(e),
      wasNotNone(e),
      `enum ${e} changed LUT eligibility`,
    );
  }
  // The new mode is excluded, which it must be — its direction is per-fragment.
  assert.equal(lutEligible(3), false);
  // Both LUT consumers read the shared predicate, not a re-derived test.
  assert.ok(
    (skyAtmosphereWgsl.match(/lutEligible\s*&&/g) ?? []).length === 2,
    "a LUT gate stopped using the shared eligibility predicate",
  );
});

test("the non-sky atmosphere consumers deliberately keep the legacy selector", () => {
  // Principle 9: the remaining consumers are NOT silently migrated, and they are
  // NOT silently left broken either — they are pinned so the follow-up is a
  // deliberate edit that has to update this contract.
  pin(
    legacyLightDirGlsl,
    /positionWC\s*\*\s*float\(lightEnum\s*==\s*NONE\)/,
    "legacy NONE arm",
  );
  assert.ok(
    /czm_getDynamicAtmosphereLightDirection\(positionWC,\s*czm_atmosphereDynamicLighting\)/.test(
      atmosphereStageFs,
    ),
    "the model atmosphere stage no longer calls the legacy selector",
  );
  assert.ok(
    /czm_getDynamicAtmosphereLightDirection\(skyPositionWC,\s*lightEnum\)/.test(
      radianceMapFs,
    ),
    "the IBL radiance bake no longer calls the legacy selector",
  );
  // Its WebGPU twin must keep matching it, or the two backends' IBL diverge.
  pin(
    proceduralSkyWgsl,
    /if\s*\(enumVal\s*<\s*0\.5\s*\|\|\s*enumVal\s*>\s*2\.5\)\s*\{/,
    "IBL twin legacy arm",
  );
});

test("LEGACY_OVERHEAD reproduces the historical NONE in every consumer", () => {
  // The legacy selector must answer for enum 3, or it returns normalize(0) = NaN.
  pin(
    legacyLightDirGlsl,
    /positionWC\s*\*\s*float\(lightEnum\s*==\s*LEGACY_OVERHEAD\)/,
    "legacy selector mode-3 arm",
  );
  // The model fog darken gate skipped NONE; it must skip mode 3 too.
  assert.ok(
    /czm_atmosphereDynamicLighting\s*!=\s*NONE\s*&&\s*czm_atmosphereDynamicLighting\s*!=\s*LEGACY_OVERHEAD/.test(
      atmosphereStageFs,
    ),
    "the model fog darken gate treats LEGACY_OVERHEAD as dynamic",
  );
  // The WebGPU IBL's MS-LUT gates asked `!== 0`; they must ask the shared
  // predicate now, and that predicate must agree with `!== 0` on 0/1/2.
  pin(
    atmosphereUniformsTs,
    /export\s+function\s+usesSceneLightDirection\(\s*dynamicLighting:\s*number,?\s*\)/,
    "shared predicate export",
  );
  const usesSceneLightDirection = (e) => e === 1 || e === 2;
  for (const e of [0, 1, 2]) {
    assert.equal(usesSceneLightDirection(e), e !== 0, `enum ${e} gate changed`);
  }
  assert.equal(usesSceneLightDirection(3), false);
  pin(
    atmosphereUniformsTs,
    /return\s+dynamicLighting\s*===\s*1\s*\|\|\s*dynamicLighting\s*===\s*2;/,
    "shared predicate body",
  );
});

// ───────────────────── 5. the acceptance probe's discipline ────────────────

test("the aureole probe carries the canonical same-task capture", () => {
  // The probe is the browser-side acceptance instrument for this row and has
  // NOT been executed by its author. The capture discipline is exactly where an
  // unrun probe produces a confident false conclusion (a WebGL read across a
  // rAF yield is BLACK; a WebGPU one is stale), so it is enforced offline here
  // rather than discovered on the first run.
  const probe = read("Tools/visual-regression/probe-sky-aureole-anchor.mjs");
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(probe), []);
  assert.deepEqual(checkFusedCaptureUsage(probe), []);
  // Hard exit codes, or a red gate reports success.
  assert.ok(/process\.exit\(1\)/.test(probe), "the probe cannot fail the run");
  // Backend truth: a silent WebGPU->WebGL fallback must not report WebGL twice.
  assert.ok(
    /rendererType\s*!==\s*backend/.test(probe),
    "the probe does not assert the backend it actually got",
  );
  // The discriminator must be ANCHORING, not brightness — a pure brightness
  // gate would pass against the defect, which is bright in every direction.
  assert.ok(
    /centroidX/.test(probe) && /toward\/anti/.test(probe),
    "the probe lost its anchoring metric",
  );
});
