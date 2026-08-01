// C12-29 S6 (SKY HALF) — node specs for the totality sky.
//
// Three separable claims, pinned here so a browser is never needed to catch a
// regression in any of them:
//
//   1. obs-1 ROOT CAUSE — the WebGPU sky shell must take its dynamic-lighting
//      enum from the value `Scene.updateEnvironment` resolved onto the
//      `SkyAtmosphere` instance, NOT by re-resolving
//      `scene.atmosphere.dynamicLighting`. The two differ on every scene with
//      a globe and `enableLighting = true`, and the difference collapses the
//      WGSL shell's per-fragment `nightAlpha` to a constant 1.0, which makes
//      the shell fully opaque at ground level and hides the star cubemap.
//
//   2. RULING E3 — the star-brightness modulation defaults ON, its two curve
//      parameters are DERIVED (rural night reference + the totality
//      naked-eye-limit target), the same three-line expression exists in the
//      CPU twin, the GLSL and both WGSL copies, and the off position is an
//      exact identity.
//
//   3. THE 360-DEGREE HORIZON TWILIGHT — geometric strength, the toggle
//      gates, byte-identity off the eclipse, matching constants in both
//      shaders, the add-only uniform-buffer growth, and naga validation.
//
// `node --test Tools/visual-regression/eclipse-sky-totality.spec.mjs`

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ECLIPSE_TWILIGHT_ELEVATION_RAD,
  ECLIPSE_TWILIGHT_FLOOR,
  ECLIPSE_TWILIGHT_HORIZON_GAIN,
  ECLIPSE_TWILIGHT_ONSET,
  ECLIPSE_TWILIGHT_TINT,
  ECLIPSE_TWILIGHT_TOTAL_RATIO_HI,
  ECLIPSE_TWILIGHT_TOTAL_RATIO_LO,
  computeHorizonTwilightStrength,
  createEclipseState,
  getEclipseHorizonTwilightFactor,
  updateEclipseState,
} from "../../packages/engine/Source/Scene/EclipseState.js";
import { computeSolarObscuration } from "../../packages/engine/Source/Scene/computeSolarObscuration.js";
import {
  CAPTURE_BEGIN,
  CAPTURE_END,
  SAME_TASK_CAPTURE_SOURCE,
  checkEmbeddedCaptureIsCanonical,
  checkFusedCaptureUsage,
} from "./lib/same-task-capture.mjs";
import {
  PRINT_WIDTH,
  assertSourcePinIsWidthSafe,
  checkSourcePinWidth,
  validateProvenanceMarker,
  validateProvenanceSlices,
} from "./lib/provenance-markers.mjs";
import {
  FIXTURE_CONSTRAINTS,
  FIXTURE_INSTANT_CONSTRAINTS,
  FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
  evaluateVantage,
  selectEclipseFixture,
  shortlistVantages,
} from "./lib/eclipse-fixture-constraints.mjs";
import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Ellipsoid from "../../packages/engine/Source/Core/Ellipsoid.js";
import JulianDate from "../../packages/engine/Source/Core/JulianDate.js";
import Matrix3 from "../../packages/engine/Source/Core/Matrix3.js";
import Simon1994PlanetaryPositions from "../../packages/engine/Source/Core/Simon1994PlanetaryPositions.js";
import Transforms from "../../packages/engine/Source/Core/Transforms.js";
import { prependUniqueEnvironmentCommands } from "../../packages/engine/Source/Scene/EnvironmentCommandList.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
// Source-order pins must not depend on a checkout's LF/CRLF policy. The handoff
// explicitly calls out lone-CR normalization hazards in these generated/source
// comparisons, so canonicalize before every structural assertion.
const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");

const starFieldMathTs = read("packages/engine/Source/Scene/StarFieldMath.ts");
const skyBrightnessJs = read("packages/engine/Source/Scene/SkyBrightness.js");
const starFieldJs = read("packages/engine/Source/Scene/StarField.js");
const atmosphericConditionsJs = read(
  "packages/engine/Source/Scene/AtmosphericConditions.js",
);
const cubeMapPanoramaJs = read(
  "packages/engine/Source/Scene/CubeMapPanorama.js",
);
const skyBoxFs = read("packages/engine/Source/Shaders/SkyBoxFS.glsl");
const panoramaWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl",
);
const panoramaRendererJs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
);
const skyAtmosphereJs = read("packages/engine/Source/Scene/SkyAtmosphere.js");
const skyAtmosphereFs = read(
  "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
);
const skyAtmosphereWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
);
const skyRendererJs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
);
const atmosphereUniformsTs = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUAtmosphereUniforms.ts",
);
const sceneJs = read("packages/engine/Source/Scene/Scene.js");
const frameStateJs = read("packages/engine/Source/Scene/FrameState.js");

// ── Second implementations (never imported from the engine) ────────────────
//
// `StarFieldMath.ts` cannot be imported by `node --test`, so the curve is
// re-implemented here and the SOURCE is separately pinned to contain the same
// expression. That is the trust-anchor shape the fleet uses: the numbers are
// checked against an independent implementation, and the independence is
// checked against the text.

const smoothstep01 = (t) => t * t * (3 - 2 * t);

function modulation(skyBrightness, inflection, steepness) {
  let t = (skyBrightness - inflection) * steepness;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - smoothstep01(t);
}

/** Solve `1 - smoothstep(0,1,t) = k` for t, by bisection. */
function inverseModulation(k) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (1 - smoothstep01(mid) > k) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

function constantFromSource(source, name) {
  const m = source.match(
    new RegExp(`export const ${name}\\s*=\\s*(-?[0-9.]+)\\s*;`),
  );
  assert.ok(m, `${name} not found as a numeric export`);
  return Number(m[1]);
}

const SHIPPED_INFLECTION = constantFromSource(
  starFieldMathTs,
  "STAR_MODULATION_INFLECTION",
);
const SHIPPED_STEEPNESS = constantFromSource(
  starFieldMathTs,
  "STAR_MODULATION_STEEPNESS",
);

// ───────────────────────── 1. obs-1 root cause ─────────────────────────────

test("obs-1: the WebGPU sky reads the enum Scene resolved, not scene.atmosphere", () => {
  // The engine-side resolution WebGL has always used.
  assert.match(
    sceneJs,
    /skyAtmosphere\.setDynamicLighting\(\s*DynamicAtmosphereLightingType\.fromGlobeFlags\(globe\),?\s*\)/,
    "Scene must still resolve the sky enum from the globe flags",
  );
  // The instance accessor that exposes it.
  assert.match(
    skyAtmosphereJs,
    /get dynamicLighting\(\)\s*\{\s*return this\._radiiAndDynamicAtmosphereColor\.z;/,
  );
  // The WebGPU packer must consume THAT, and must no longer call the
  // frameState-only resolver.
  assert.match(
    skyRendererJs,
    // SIXTH STRIKE in the source-pin class, and the first to be caught before
    // an executor: this used a LITERAL SPACE against a line measured at exactly
    // 79 chars — one under prettier's 80-col `printWidth`. Renaming the LHS or
    // adding one indent level splits it into a 4-line call and the pin fails as
    // a false "obs-1 regression". `\s*` is wrap-proof. The shared lib now
    // REFUSES to author either shape; see `assertSourcePinIsWidthSafe`.
    /resolveSkyDynamicLighting\(\s*skyAtmosphere\s*,\s*frameState\s*\)/,
  );
  assert.ok(
    !/=\s*resolveDynamicLighting\(frameState\)/.test(skyRendererJs),
    "the sky renderer must not re-resolve scene.atmosphere.dynamicLighting",
  );
  assert.match(
    atmosphereUniformsTs,
    /export function resolveSkyDynamicLighting\(/,
  );
});

test("obs-1: the sky resolver prefers the instance value and falls back cleanly", () => {
  // Second implementation of `resolveSkyDynamicLighting`'s contract, pinned
  // against the source text below.
  const resolve = (instanceValue, frameStateValue) =>
    typeof instanceValue === "number" && isFinite(instanceValue)
      ? instanceValue
      : (frameStateValue ?? 0);

  assert.equal(resolve(1, 0), 1, "SCENE_LIGHT from the instance must win");
  assert.equal(resolve(2, 0), 2, "SUNLIGHT from the instance must win");
  assert.equal(resolve(0, 2), 0, "an instance value of NONE is still a value");
  assert.equal(resolve(undefined, 2), 2, "fall back to frameState");
  assert.equal(resolve(undefined, undefined), 0, "default NONE");
  assert.equal(resolve(NaN, 1), 1, "NaN is not a value");

  assert.match(
    atmosphereUniformsTs,
    /const resolved = skyAtmosphere\?\.dynamicLighting;/,
  );
  assert.match(
    atmosphereUniformsTs,
    /typeof resolved === "number" && isFinite\(resolved\)/,
  );
});

test("obs-1: the WGSL alpha path that made the divergence visible is unchanged", () => {
  // The mechanism: with the enum at NONE, `isDynamic` is false, `nightAlpha`
  // is pinned at 1.0, and a ground camera's `altitudeOpacity` is 1.0, so
  // `alpha = mix(finalColor.b, 1.0, 1.0)` is exactly 1.0 — an opaque shell.
  // These three lines are what the fix re-enables; if any of them is
  // rewritten the root-cause story in the debugging log stops describing the
  // code and this test says so.
  assert.match(
    skyAtmosphereWgsl,
    /let isDynamic = u\.radiiAndDynamicAtmosphere\.z != 0\.0;/,
  );
  assert.match(
    skyAtmosphereWgsl,
    /clamp\(dot\(normalize\(skyPoint\), lightDirWC\), 0\.0, 1\.0\),/,
  );
  assert.match(
    skyAtmosphereWgsl,
    /let alpha = mix\(finalColor\.b, 1\.0, opacity\);/,
  );
  // WebGL's twin, same shape, same file it always lived in.
  assert.match(
    read("packages/engine/Source/Shaders/SkyAtmosphereCommon.glsl"),
    /float nightAlpha = \(u_radiiAndDynamicAtmosphereColor\.z != 0\.0\)/,
  );
});

// ───────────────────────── 2. ruling E3 ────────────────────────────────────

test("E3: the modulation default is ON and reads the derived curve constants", () => {
  assert.match(
    atmosphericConditionsJs,
    /enableStarBrightnessModulation: true,/,
    "ruling E3 flips the default on",
  );
  assert.match(
    atmosphericConditionsJs,
    /inflection: STAR_MODULATION_INFLECTION,/,
  );
  assert.match(
    atmosphericConditionsJs,
    /steepness: STAR_MODULATION_STEEPNESS,/,
  );
  assert.ok(
    !/inflection: 0\.5,\s*\r?\n\s*steepness: 1\.0,/.test(
      atmosphericConditionsJs,
    ),
    "the C11-176 placeholder curve must be gone",
  );
});

test("E3: the shipped steepness is exactly the totality anchor's answer", () => {
  // dm = 3.0 magnitudes below a rural naked-eye limit of 6.5 -> ~3.5, the
  // documented totality visibility (planets + first-to-third magnitude stars).
  const k = Math.pow(10, -0.4 * 3.0);
  const tStar = inverseModulation(k);
  const derivedSteepness = tStar / ECLIPSE_TWILIGHT_FLOOR;

  assert.ok(
    Math.abs(derivedSteepness - SHIPPED_STEEPNESS) < 0.05,
    `derived ${derivedSteepness} vs shipped ${SHIPPED_STEEPNESS}`,
  );
  assert.equal(SHIPPED_INFLECTION, 0);

  // And what the shipped pair actually produces at the anchor.
  const factorAtTotality = modulation(
    ECLIPSE_TWILIGHT_FLOOR,
    SHIPPED_INFLECTION,
    SHIPPED_STEEPNESS,
  );
  const deltaMag = 2.5 * Math.log10(factorAtTotality);
  assert.ok(
    Math.abs(deltaMag + 3.0) < 0.02,
    `totality magnitude shift ${deltaMag}, expected -3.00`,
  );
  // The documented five-figure value, so a retune cannot slip past the doc.
  assert.ok(Math.abs(factorAtTotality - 0.06281) < 5e-5);
});

test("E3: the curve endpoints and monotonicity", () => {
  assert.equal(
    modulation(0, SHIPPED_INFLECTION, SHIPPED_STEEPNESS),
    1,
    "astronomical night with no moon is EXACTLY the undimmed sky",
  );
  assert.equal(
    modulation(1, SHIPPED_INFLECTION, SHIPPED_STEEPNESS),
    0,
    "no naked-eye stars at noon",
  );
  let prev = Infinity;
  for (let i = 0; i <= 2000; i++) {
    const b = i / 2000;
    const v = modulation(b, SHIPPED_INFLECTION, SHIPPED_STEEPNESS);
    assert.ok(v >= 0 && v <= 1, `out of range at ${b}`);
    assert.ok(v <= prev + 1e-12, `not monotone at ${b}`);
    prev = v;
  }
});

test("E3: the documented off-anchor consequences are the measured ones", () => {
  // Recorded rather than tuned away — the comment block in StarFieldMath.ts
  // states these, and a retune that changes them must change the doc too.
  const fullMoon = modulation(0.04, SHIPPED_INFLECTION, SHIPPED_STEEPNESS);
  assert.ok(Math.abs(fullMoon - 0.01818) < 5e-5, `full moon ${fullMoon}`);
  assert.ok(Math.abs(2.5 * Math.log10(fullMoon) + 4.35) < 0.02);

  // A LOW-sun totality reveals more, because the sky it started from was
  // already dimmer. `computeSkyBrightness`'s sun term at 10 deg elevation.
  const sunTerm = smoothstep01(
    Math.min(1, Math.max(0, (Math.sin((10 * Math.PI) / 180) + 0.1) / 0.5)),
  );
  const lowSun = modulation(
    sunTerm * ECLIPSE_TWILIGHT_FLOOR,
    SHIPPED_INFLECTION,
    SHIPPED_STEEPNESS,
  );
  assert.ok(Math.abs(lowSun - 0.5246) < 5e-4, `low-sun totality ${lowSun}`);
  assert.ok(lowSun > modulation(ECLIPSE_TWILIGHT_FLOOR, 0, SHIPPED_STEEPNESS));
});

test("E3: one expression, four implementations", () => {
  // CPU twin.
  assert.match(
    starFieldMathTs,
    /let t = \(skyBrightness - inflection\) \* steepness;/,
  );
  assert.match(
    starFieldMathTs,
    /return 1\.0 - t \* t \* \(3\.0 - 2\.0 \* t\);/,
  );
  // WebGL — the consumer C11-176 said did not exist.
  assert.match(
    skyBoxFs,
    /float t = clamp\(\(u_skyBrightness - u_starModulation\.x\) \* u_starModulation\.y, 0\.0, 1\.0\);/,
  );
  assert.match(skyBoxFs, /float factor = 1\.0 - smoothstep\(0\.0, 1\.0, t\);/);
  // WebGPU — the .wgsl file and the production JS-embedded copy.
  for (const [name, src] of [
    ["CubeMapPanorama.wgsl", panoramaWgsl],
    ["WebGPUCubeMapPanoramaRenderer.js", panoramaRendererJs],
  ]) {
    assert.match(
      src,
      /let t = clamp\(\(skyBrightness - inflection\) \* steepness, 0\.0, 1\.0\);/,
      name,
    );
    assert.match(src, /let factor = 1\.0 - smoothstep\(0\.0, 1\.0, t\);/, name);
  }
});

test("the documented and embedded WebGPU panorama shaders keep their feature contract", () => {
  for (const [name, src] of [
    ["CubeMapPanorama.wgsl", panoramaWgsl],
    ["WebGPUCubeMapPanoramaRenderer.js", panoramaRendererJs],
  ]) {
    assert.match(src, /hdr: vec4<f32>/, `${name}: HDR uniform`);
    assert.match(
      src,
      /output\.position = vec4<f32>\(clipPos\.x, clipPos\.y, clipPos\.w, clipPos\.w\);/,
      `${name}: far-plane clamp`,
    );
    assert.match(src, /let requested = i32\(uniforms\.params\.z \+ 0\.5\);/);
    assert.match(src, /modulated = pow\(modulated, vec3<f32>\(hdrGamma\)\);/);
  }
});

test("E3: the GLSL applies the modulation BEFORE czm_gammaCorrect", () => {
  // The WGSL modulates, then cloud-occludes, then applies the HDR gamma. The
  // GLSL must do the same three in the same order or the two backends
  // disagree under HDR (k * x^g vs (k * x)^g).
  const modIndex = skyBoxFs.indexOf("float factor = 1.0 - smoothstep");
  const cloudIndex = skyBoxFs.indexOf("1.0 - clamp(u_starModulation.w");
  // The FIRST `czm_gammaCorrect` in the file is a mention in the header
  // comment; the ordering claim is about the statement.
  const gammaIndex = skyBoxFs.indexOf("out_FragColor = vec4(czm_gammaCorrect");
  assert.ok(modIndex > 0 && cloudIndex > modIndex && gammaIndex > cloudIndex);
});

test("E3: both backends consume one star-map-scoped modulation decision", () => {
  assert.match(cubeMapPanoramaJs, /panorama\._isStarMap === true/);
  assert.match(
    cubeMapPanoramaJs,
    /sky\.enableStarBrightnessModulation === true/,
  );
  assert.match(cubeMapPanoramaJs, /frameState\.skyAtmosphereVisible === true/);
  assert.match(
    panoramaRendererJs,
    /const starModulation = panorama\?\._starModulation;/,
  );
  assert.doesNotMatch(
    panoramaRendererJs,
    /enableStarBrightnessModulation === true/,
    "WebGPU must not independently re-resolve scene policy",
  );
  // WebGL must actually bind the two uniforms the shader declares.
  assert.match(cubeMapPanoramaJs, /u_starModulation: function \(\) \{/);
  assert.match(cubeMapPanoramaJs, /u_skyBrightness: function \(\) \{/);
  assert.match(skyBoxFs, /uniform vec4 u_starModulation;/);
  assert.match(skyBoxFs, /uniform float u_skyBrightness;/);
});

test("E3: the C11-176 orbital regression is closed at the source", () => {
  // The measured C11-176 failure was `skyBrightness = 1.0` for a camera along
  // the sun direction — an ORBITAL camera on the day side, where the sky is
  // black and the stars are really there. The estimator now zeroes above the
  // engine's own scattering shell, so that camera gets factor 1.0.
  assert.match(
    skyBrightnessJs,
    /export function computeAtmosphericColumnFactor\(cameraHeight\)/,
  );
  assert.match(
    skyBrightnessJs,
    /return clamped \* computeAtmosphericColumnFactor\(cameraHeight\);/,
  );
  assert.doesNotMatch(skyBrightnessJs, /MEAN_EARTH_RADIUS|6371000\.0/);
  const fadeStart = Number(
    skyBrightnessJs.match(/ATMOSPHERIC_COLUMN_FADE_START = ([0-9.]+);/)[1],
  );
  const fadeEnd = Number(
    skyBrightnessJs.match(/ATMOSPHERIC_COLUMN_FADE_END = ([0-9.]+);/)[1],
  );
  assert.equal(fadeStart, 60000);
  // The engine's own ATMOSPHERE_THICKNESS — above it neither sky shader
  // integrates anything, so the estimator must agree.
  assert.equal(fadeEnd, 111000);
  assert.match(
    skyAtmosphereWgsl,
    /outerRadius — innerRadius \+ 111e3/,
    "the shell thickness the fade end is anchored to",
  );
  // Sprite and cubemap paths share the same continuous, ellipsoidal-height
  // column law; there is no 100 km catalogue pop.
  assert.match(
    starFieldMathTs,
    /const column = computeAtmosphericColumnFactor\(cameraHeight\);/,
  );
  assert.match(
    starFieldMathTs,
    /dayFade = 1\.0 - column \* \(1\.0 - dayFade\);/,
  );
  assert.doesNotMatch(starFieldMathTs, /6371000\.0|altitude > 100000\.0/);
});

test("E3: Scene publishes current-frame moon brightness before star consumers", () => {
  const moonUpdate = sceneJs.indexOf("? this.moon.update(frameState)");
  const brightness = sceneJs.indexOf(
    "frameState.skyBrightness =\n        computeSkyBrightness(",
  );
  const atmosphereUpdate = sceneJs.indexOf(
    "environmentState.skyAtmosphereCommand = skyAtmosphere.update(",
  );
  const skyBoxUpdate = sceneJs.indexOf(
    "environmentState.skyBoxCommand = defined(this.skyBox)",
  );
  assert.ok(
    moonUpdate > 0 &&
      brightness > moonUpdate &&
      atmosphereUpdate > brightness &&
      skyBoxUpdate > atmosphereUpdate,
    "Moon.update < skyBrightness < atmosphere/skybox consumers",
  );
  assert.match(sceneJs, /frameState\.camera\?\.positionCartographic\?\.height/);
  assert.doesNotMatch(
    sceneJs,
    /Uses the previous frame's|visually indistinguishable from the current/,
  );
});

test("E3: the star catalogue draws EXACTLY ONCE (the double-draw obs-1 would have exposed)", () => {
  // Batch 761 already lets an injected environment command demand a sky-only
  // frustum. The clean S6 architecture therefore emits one cached command,
  // instead of allocating a binned+inject pair and publishing through two
  // command routes every frame.
  const envRenderer = read(
    "packages/engine/Source/Scene/EnvironmentRenderer.js",
  );
  const glSkyBox = envRenderer.indexOf("environmentState.skyBoxCommand");
  const glStars = envRenderer.indexOf("environmentState.starFieldCommand");
  const glAtmo = envRenderer.indexOf("environmentState.isSkyAtmosphereVisible");
  assert.ok(
    glSkyBox > 0 && glStars > glSkyBox && glAtmo > glStars,
    "WebGL must execute skyBox -> starField -> skyAtmosphere",
  );
  assert.match(
    envRenderer,
    /BEFORE the sky atmosphere \/ sun \/ moon so\s*\r?\n?\s*\/\/ those still occlude the stars/,
    "WebGL's own comment states the atmosphere is meant to occlude the stars",
  );

  const sceneRenderer = read("packages/engine/Source/Scene/SceneRenderer.js");
  assert.match(
    sceneRenderer,
    /prependUniqueEnvironmentCommands\(\s*envCmds,/,
    "the returned star command must be prepended into the background slot",
  );
  assert.doesNotMatch(
    sceneRenderer,
    /const bgEnv|const maybeInject/,
    "the per-frame environment hot path must not allocate scratch arrays or closures",
  );
  const frustumDemand = read(
    "packages/engine/Source/Scene/EnvironmentFrustumDemand.ts",
  );
  assert.match(
    frustumDemand,
    /isInjectable\(environmentState\.starFieldCommand\)/,
    "the returned star command must retain the sky-only frustum guarantee",
  );

  assert.match(sceneJs, /environmentState\.starFieldCommand = starCommand;/);
  assert.doesNotMatch(sceneJs, /resolveStarFieldCopies|removeCommand/);
  assert.match(starFieldJs, /return fr\.update\(this, frameState\);/);
  assert.doesNotMatch(
    starFieldJs,
    /_wasBinned|_binnedCommand|const commandList|fr\.update\(this, frameState,/,
  );

  const starRenderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts",
  );
  assert.match(
    starRenderer,
    /if \(!defined\(cache\.command\)\) \{\s*\n\s*cache\.command = new WebGPUDrawCommand/,
  );
  assert.match(starRenderer, /return cache\.command;/);
  assert.doesNotMatch(
    starRenderer,
    /commandList\.push|injectCommand|CesiumAnyDrawCommand/,
  );
  assert.equal(
    (starRenderer.match(/new WebGPUDrawCommand\(/g) ?? []).length,
    1,
    "the renderer must own one cached draw command, not a per-frame pair",
  );
  assert.equal(
    (starRenderer.match(/cache\.command = undefined;/g) ?? []).length,
    2,
    "device and pipeline-format invalidation must both drop the cached command",
  );

  for (const [producerPath, rendererPath, updateStart, updateEnd] of [
    [
      "packages/engine/Source/Scene/SkyAtmosphere.js",
      "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
      "function updateWebGPUSkyAtmosphere(",
      "function destroyWebGPUSkyAtmosphereResources(",
    ],
    [
      "packages/engine/Source/Scene/Sun.js",
      "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
      "function updateWebGPUSun(",
      "// Moon Renderer",
    ],
  ]) {
    const producer = read(producerPath);
    const renderer = read(rendererPath);
    const rendererUpdate = renderer.slice(
      renderer.indexOf(updateStart),
      renderer.indexOf(updateEnd, renderer.indexOf(updateStart)),
    );
    assert.doesNotMatch(
      producer,
      /fr\.update\(this,\s*frameState,\s*frameState\.commandList\)/,
      `${producerPath} must publish through Scene visibility only`,
    );
    assert.doesNotMatch(
      rendererUpdate,
      /commandList\.push\(cache\.(?:fullscreenCommand|command)\)/,
      `${rendererPath} must not bypass Scene visibility by binning`,
    );
    assert.match(
      rendererUpdate,
      /return cache\.(?:fullscreenCommand|command);/,
      `${rendererPath} must return its cached command`,
    );
  }
});

test("E3: repeated stereo execution keeps background commands exactly once", () => {
  const skyBox = { execute() {} };
  const starField = { execute() {} };
  const legacy = { execute() {} };
  const commands = [legacy, skyBox, starField, skyBox];

  let length = prependUniqueEnvironmentCommands(
    commands,
    commands.length,
    skyBox,
    starField,
  );
  assert.equal(length, 3);
  assert.deepEqual(commands.slice(0, length), [skyBox, starField, legacy]);

  // ViewportExecutor invokes executeCommands twice for WebVR. The second eye
  // must be an allocation-free/idempotent fast path, not another prepend.
  length = prependUniqueEnvironmentCommands(
    commands,
    length,
    skyBox,
    starField,
  );
  assert.equal(length, 3);
  assert.deepEqual(commands.slice(0, length), [skyBox, starField, legacy]);
});

test("the WebGPU sun keeps immutable geometry, bind state, and one command across clock ticks", () => {
  const renderer = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  );
  const start = renderer.indexOf("function updateWebGPUSun(");
  const end = renderer.indexOf("// Moon Renderer", start);
  const update = renderer.slice(start, end);

  assert.match(renderer, /const SUN_QUAD_DIRECTIONS = new Float32Array/);
  assert.match(renderer, /encodedSunHigh: vec3<f32>/);
  assert.match(renderer, /encodedSunLow: vec3<f32>/);
  assert.match(
    renderer,
    /let rte = \(u\.encodedSunHigh - u\.encodedCameraHigh\)/,
  );
  assert.match(update, /if \(!defined\(cache\.vertexBuffer\)\) \{/);
  assert.match(update, /if \(!defined\(cache\.bindGroup\)\) \{/);
  assert.match(update, /if \(!defined\(cache\.command\)\) \{/);
  assert.doesNotMatch(update, /lastSunPos|Cartesian3\.equals/);
  assert.equal(
    (update.match(/new WebGPUDrawCommand\(/g) ?? []).length,
    1,
    "the sun update must own one lazily-created command",
  );
});

test("E3: the sprite star field adopts the same modulation law, gated off", () => {
  assert.match(starFieldJs, /reveal = modulation;/);
  assert.match(
    starFieldJs,
    /const effectiveIntensityScale = this\._intensity \* reveal;/,
  );
  assert.match(starFieldJs, /skyLeaf\.enableStarBrightnessModulation === true/);
  assert.match(starFieldJs, /frameState\.skyAtmosphereVisible === true/);
  // Replacement, never a product: both star paths consume this same result,
  // so twilight is not double-dimmed and moonlight cannot leave the sparse
  // catalogue brighter than the cubemap.
  const atNight = modulation(0, 0, SHIPPED_STEEPNESS);
  assert.equal(atNight, 1);
  const atNoon = modulation(1, 0, SHIPPED_STEEPNESS);
  assert.equal(atNoon, 0);
  // Totality with a high sun: dayFade is exactly 0 (sun ~82 deg up) and the
  // shared factor is what brings the catalogue sprites back.
  const atTotality = modulation(ECLIPSE_TWILIGHT_FLOOR, 0, SHIPPED_STEEPNESS);
  assert.ok(atTotality > 0.06 && atTotality < 0.07);
});

// ─────────────────── 3. the 360-degree horizon twilight ────────────────────

test("S6: the horizon-twilight strength is 0 below the onset and 1 at totality", () => {
  assert.equal(computeHorizonTwilightStrength(0), 0);
  assert.equal(computeHorizonTwilightStrength(0.5), 0);
  assert.equal(computeHorizonTwilightStrength(ECLIPSE_TWILIGHT_ONSET), 0);
  assert.equal(computeHorizonTwilightStrength(1), 1);
  assert.equal(computeHorizonTwilightStrength(1.5), 1);
  assert.equal(computeHorizonTwilightStrength(NaN), 0);
  assert.equal(computeHorizonTwilightStrength(undefined), 0);

  let prev = -1;
  for (let i = 0; i <= 2000; i++) {
    const o = i / 2000;
    const s = computeHorizonTwilightStrength(o);
    assert.ok(s >= 0 && s <= 1);
    assert.ok(s >= prev - 1e-12, `not monotone at ${o}`);
    prev = s;
  }
});

test("S6: annular eclipses are excluded BY TYPE, across the whole deep band", () => {
  // The adversarial finding this test exists for: an obscuration-only gate
  // does NOT exclude every annular eclipse. Measured from the engine's own
  // overlap integrand, concentric:
  //   ratio 0.98 -> obscuration 0.9794   (already past the 0.98 onset)
  //   ratio 0.99 -> 0.9905
  //   ratio 0.995 -> 0.9955
  //   ratio 0.999 -> 0.9992
  // Real hybrid / near-hybrid eclipses (~5% of solar eclipses) run annular
  // phases right through that band, and the old spec probed only 0.97 —
  // constructed just UNDER the threshold and structurally unable to catch it.
  const rs = 0.00465;
  for (const ratio of [0.97, 0.98, 0.99, 0.995, 0.999]) {
    const ro = ratio * rs;
    const o = computeSolarObscuration(rs, ro, 0);
    assert.ok(o > 0.9, `sanity: ratio ${ratio} should obscure a lot, got ${o}`);
    // The type classifier must zero it whatever the obscuration says.
    assert.equal(
      computeHorizonTwilightStrength(o, rs, ro),
      0,
      `annular ratio ${ratio} (obscuration ${o}) produced a horizon twilight`,
    );
  }
  // And at least one of them must actually be past the onset, or this test is
  // vacuous and would pass on the obscuration gate alone.
  const deep = computeSolarObscuration(rs, 0.999 * rs, 0);
  assert.ok(
    deep > ECLIPSE_TWILIGHT_ONSET,
    `fixture is vacuous: deepest annular obscuration ${deep} <= onset`,
  );
  assert.ok(
    computeHorizonTwilightStrength(deep) > 0,
    "without the type factor the obscuration ramp DOES fire — that is the bug",
  );
});

test("S6: total and hybrid geometries keep the effect", () => {
  const rs = 0.00465;
  // A normal total eclipse sits at 1.01-1.08 at greatest eclipse.
  for (const ratio of [1.01, 1.05, 1.08]) {
    const ro = ratio * rs;
    assert.equal(
      computeHorizonTwilightStrength(1.0, rs, ro),
      1.0,
      `total ratio ${ratio} should give full strength at totality`,
    );
  }
  // The hybrid crossing is continuous, not a pop: exactly 0 at the annular
  // side, exactly full at the total side, monotone between.
  assert.equal(
    computeHorizonTwilightStrength(
      1.0,
      rs,
      ECLIPSE_TWILIGHT_TOTAL_RATIO_LO * rs,
    ),
    0,
  );
  assert.equal(
    computeHorizonTwilightStrength(
      1.0,
      rs,
      ECLIPSE_TWILIGHT_TOTAL_RATIO_HI * rs,
    ),
    1.0,
  );
  let prev = -1;
  for (let i = 0; i <= 200; i++) {
    const ratio =
      ECLIPSE_TWILIGHT_TOTAL_RATIO_LO +
      (i / 200) *
        (ECLIPSE_TWILIGHT_TOTAL_RATIO_HI - ECLIPSE_TWILIGHT_TOTAL_RATIO_LO);
    const v = computeHorizonTwilightStrength(1.0, rs, ratio * rs);
    assert.ok(v >= prev - 1e-12, `hybrid crossing not monotone at ${ratio}`);
    prev = v;
  }
  // The obscuration ramp SURVIVES the type factor — using the instantaneous
  // magnitude as the classifier would have collapsed it, because `M >= 1` is
  // algebraically the umbra branch and so is true only where obscuration is
  // already exactly 1.
  const mid = computeHorizonTwilightStrength(0.99, rs, 1.05 * rs);
  assert.ok(mid > 0 && mid < 1, `ramp collapsed: ${mid}`);
});

test("S6: the accessor is an exact 0 whenever anything is off", () => {
  const base = {
    enabled: true,
    horizonTwilightEnabled: true,
    valid: true,
    horizonTwilightStrength: 1,
  };
  assert.equal(
    getEclipseHorizonTwilightFactor(base),
    ECLIPSE_TWILIGHT_HORIZON_GAIN,
  );
  assert.equal(getEclipseHorizonTwilightFactor(undefined), 0);
  assert.equal(getEclipseHorizonTwilightFactor({ ...base, enabled: false }), 0);
  assert.equal(
    getEclipseHorizonTwilightFactor({ ...base, horizonTwilightEnabled: false }),
    0,
  );
  assert.equal(getEclipseHorizonTwilightFactor({ ...base, valid: false }), 0);
  assert.equal(
    getEclipseHorizonTwilightFactor({ ...base, horizonTwilightStrength: 0 }),
    0,
  );
  assert.equal(
    getEclipseHorizonTwilightFactor({ ...base, horizonTwilightStrength: NaN }),
    0,
  );
  // Clamped, so a future strength bug cannot blow the shell out.
  assert.equal(
    getEclipseHorizonTwilightFactor({ ...base, horizonTwilightStrength: 9 }),
    ECLIPSE_TWILIGHT_HORIZON_GAIN,
  );
});

test("S6: the state publishes both new fields and computes them with the toggle off", () => {
  const state = createEclipseState();
  assert.ok("horizonTwilightEnabled" in state);
  assert.ok("horizonTwilightStrength" in state);

  // Geometry runs regardless of the toggle (the S1 convention), so tooling
  // can read the physics with the effect switched off.
  const sunPositionWC = { x: 1.496e11, y: 0, z: 0 };
  const cameraPositionWC = { x: 6378137, y: 0, z: 0 };
  // A moon dead on the sun line, close enough to be well inside totality.
  const moonPositionWC = { x: 3.6e8, y: 0, z: 0 };
  const opts = {
    active: true,
    enabled: true,
    horizonTwilightEnabled: false,
    cameraPositionWC,
    sunPositionWC,
    moonPositionWC,
  };
  updateEclipseState(state, opts);
  assert.equal(state.horizonTwilightEnabled, false);
  assert.ok(state.moonObscuration > 0.99, "fixture should be total");
  assert.ok(state.horizonTwilightStrength > 0.99, "geometry must still run");
  assert.equal(getEclipseHorizonTwilightFactor(state), 0, "but not be applied");

  opts.horizonTwilightEnabled = true;
  updateEclipseState(state, opts);
  assert.equal(
    getEclipseHorizonTwilightFactor(state),
    ECLIPSE_TWILIGHT_HORIZON_GAIN,
  );

  // Outside SCENE3D the whole thing is identity.
  opts.active = false;
  updateEclipseState(state, opts);
  assert.equal(state.horizonTwilightStrength, 0);
  assert.equal(getEclipseHorizonTwilightFactor(state), 0);
});

test("S6: the twilight fades out above the atmosphere", () => {
  const state = createEclipseState();
  const sunPositionWC = { x: 1.496e11, y: 0, z: 0 };
  const moonPositionWC = { x: 3.6e8, y: 0, z: 0 };
  const at = (altitude) => {
    updateEclipseState(state, {
      active: true,
      enabled: true,
      horizonTwilightEnabled: true,
      cameraPositionWC: { x: 6371000 + altitude, y: 0, z: 0 },
      cameraHeight: altitude,
      sunPositionWC,
      moonPositionWC,
    });
    return state.horizonTwilightStrength;
  };
  assert.ok(at(0) > 0.99, "on the ground the umbra surrounds you");
  assert.ok(at(50000) > 0.99, "still inside the scattering column");
  assert.ok(at(85500) > 0.4 && at(85500) < 0.6, "mid-ramp");
  assert.equal(at(120000), 0, "above the shell there is no horizon glow");
  assert.equal(at(400000), 0, "and none from orbit");
});

test("S6: Scene publishes the factor and FrameState declares it", () => {
  assert.match(
    sceneJs,
    /view\._eclipseHorizonTwilight = getEclipseHorizonTwilightFactor\(/,
  );
  assert.match(
    sceneJs,
    /frameState\.eclipseHorizonTwilight = view\._eclipseHorizonTwilight;/,
  );
  assert.match(
    sceneJs,
    /scratchEclipseOptions\.horizonTwilightEnabled = defined\(eclipseLighting\)/,
  );
  assert.match(
    sceneJs,
    /eclipseLighting\.enableEclipseHorizonTwilight !== false/,
  );
  assert.match(frameStateJs, /this\.eclipseHorizonTwilight = undefined;/);
  assert.match(
    atmosphericConditionsJs,
    /enableEclipseHorizonTwilight: true,/,
    "ruling E1's precedent: eclipse-driven effects default ON",
  );
});

test("S6: both shaders carry the same constants and the same add", () => {
  // The elevation the sunlit penumbral atmosphere subtends from the middle of
  // a ~120 km umbral track — atan(25/60).
  const expected = Math.atan2(25000, 60000);
  assert.ok(Math.abs(ECLIPSE_TWILIGHT_ELEVATION_RAD - expected) < 1e-15);
  const literal = expected.toPrecision(15).replace(/0+$/, "");
  for (const [name, src] of [
    ["SkyAtmosphereFS.glsl", skyAtmosphereFs],
    ["SkyAtmosphere.wgsl", skyAtmosphereWgsl],
  ]) {
    assert.ok(
      src.includes("0.394791119699762"),
      `${name}: elevation constant absent (expected ${literal})`,
    );
    assert.ok(
      src.includes("vec3(1.0, 0.784, 0.424)") ||
        src.includes("vec3<f32>(1.0, 0.784, 0.424)"),
      `${name}: tint absent`,
    );
    assert.ok(
      src.includes("0.2126, 0.7152, 0.0722"),
      `${name}: luminance weights absent`,
    );
  }
  assert.deepEqual(ECLIPSE_TWILIGHT_TINT, [1.0, 0.784, 0.424]);
  // The tint is the normalised Rayleigh transmission at tau = 0.5 for
  // 650/550/450 nm — derived, not picked.
  const t = (lambda) => Math.exp(-0.5 * Math.pow(550 / lambda, 4));
  const raw = [t(650), t(550), t(450)];
  const peak = Math.max(...raw);
  const normalised = raw.map((v) => v / peak);
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(normalised[i] - ECLIPSE_TWILIGHT_TINT[i]) < 0.01,
      `channel ${i}: derived ${normalised[i]} vs shipped ${ECLIPSE_TWILIGHT_TINT[i]}`,
    );
  }
});

test("S6: both shaders derive a safe geodetic up from the active ellipsoid", () => {
  const glslHelper = skyAtmosphereFs.slice(
    skyAtmosphereFs.indexOf("vec3 getEclipseObserverUp"),
    skyAtmosphereFs.indexOf("#ifndef PER_FRAGMENT_ATMOSPHERE"),
  );
  const wgslHelper = skyAtmosphereWgsl.slice(
    skyAtmosphereWgsl.indexOf("fn getEclipseObserverUp"),
    skyAtmosphereWgsl.indexOf("// Precomputed atmosphere LUTs"),
  );

  assert.match(
    glslHelper,
    /czm_ellipsoidInverseRadii \* czm_ellipsoidInverseRadii/,
  );
  assert.match(wgslHelper, /positionWC \* ellipsoidInverseRadiiSquared/);
  for (const [name, helper] of [
    ["GLSL", glslHelper],
    ["WGSL", wgslHelper],
  ]) {
    assert.match(
      helper,
      /radialUp = vec3(?:<f32>)?\(0\.0, 0\.0, 1\.0\)/,
      `${name}: origin fallback must be +Z`,
    );
    assert.match(
      helper,
      /gradientMagnitudeSquared > 0\.0/,
      `${name}: degenerate ellipsoid gradient must take the radial fallback`,
    );
    assert.match(helper, /return radialUp;/);
  }
  assert.match(skyAtmosphereFs, /getEclipseObserverUp\(czm_viewerPositionWC\)/);
  assert.match(
    skyAtmosphereWgsl,
    /getEclipseObserverUp\(\s*u\.cameraPositionWC,\s*u\.ellipsoidInverseRadiiSquared,/,
  );
  assert.match(
    skyRendererJs,
    /const inverseRadiiSquared = ellipsoid\.oneOverRadiiSquared;/,
  );

  // Independent numeric check of the shader formula on WGS84. At principal
  // axes it is exactly the historical radial up; at mid-latitudes it makes
  // the small, intentional correction to the ellipsoid's true surface normal.
  function safeGeodeticUp(position, inverseRadiiSquared) {
    const radialMagnitude = Math.hypot(...position);
    const radial =
      radialMagnitude > 0.0
        ? position.map((value) => value / radialMagnitude)
        : [0.0, 0.0, 1.0];
    const gradient = position.map(
      (value, index) => value * inverseRadiiSquared[index],
    );
    const gradientMagnitude = Math.hypot(...gradient);
    return gradientMagnitude > 0.0
      ? gradient.map((value) => value / gradientMagnitude)
      : radial;
  }

  const radii = [
    Ellipsoid.WGS84.radii.x,
    Ellipsoid.WGS84.radii.y,
    Ellipsoid.WGS84.radii.z,
  ];
  const inverseRadiiSquared = radii.map((radius) => 1.0 / (radius * radius));
  assert.deepEqual(
    safeGeodeticUp([radii[0], 0.0, 0.0], inverseRadiiSquared),
    [1.0, 0.0, 0.0],
  );
  assert.deepEqual(
    safeGeodeticUp([0.0, 0.0, 0.0], inverseRadiiSquared),
    [0.0, 0.0, 1.0],
  );
  const parameter = Math.PI / 4.0;
  const position = [
    radii[0] * Math.cos(parameter),
    0.0,
    radii[2] * Math.sin(parameter),
  ];
  const tangent = [
    -radii[0] * Math.sin(parameter),
    0.0,
    radii[2] * Math.cos(parameter),
  ];
  const up = safeGeodeticUp(position, inverseRadiiSquared);
  const tangentDot = up.reduce(
    (sum, component, index) => sum + component * tangent[index],
    0.0,
  );
  assert.ok(Math.abs(tangentDot) < 1e-9);
  const radialUp = safeGeodeticUp(position, [0.0, 0.0, 0.0]);
  const upDotRadial = up.reduce(
    (sum, component, index) => sum + component * radialUp[index],
    0.0,
  );
  const correction = Math.acos(Math.min(1.0, Math.max(-1.0, upDotRadial)));
  assert.ok(correction > 0.003 && correction < 0.004);
});

test("S6: the add sits in linear scatter space in BOTH shaders", () => {
  // GLSL: after computeAtmosphereColor, before the tonemap.
  const glslAdd = skyAtmosphereFs.indexOf("u_eclipseHorizonTwilight > 0.0");
  const glslColor = skyAtmosphereFs.indexOf(
    "vec4 color = computeAtmosphereColor",
  );
  // Again the statement, not the header comment's mention of it.
  const glslTonemap = skyAtmosphereFs.indexOf(
    "color.rgb = czm_pbrNeutralTonemapping(color.rgb);",
  );
  assert.ok(glslColor > 0 && glslAdd > glslColor && glslTonemap > glslAdd);

  // WGSL: after the scattering branch, before pbrNeutralTonemapSky.
  const wgslAdd = skyAtmosphereWgsl.indexOf("u.eclipseControl.x > 0.0");
  const wgslTonemap = skyAtmosphereWgsl.indexOf(
    "var finalColor = pbrNeutralTonemapSky(color);",
  );
  assert.ok(wgslAdd > 0 && wgslTonemap > wgslAdd);

  // Both use the squared linear band ramp against the observer's local up.
  assert.match(
    skyAtmosphereFs,
    /1\.0 - max\(elevation, 0\.0\) \/ ECLIPSE_TWILIGHT_ELEVATION/,
  );
  assert.match(
    skyAtmosphereWgsl,
    /1\.0 - max\(elevation, 0\.0\) \/ ECLIPSE_TWILIGHT_ELEVATION/,
  );
  // Azimuth-independence is the whole claim: nothing in the band references
  // the sun direction.
  const glslBlock = skyAtmosphereFs.slice(glslAdd, glslTonemap);
  const wgslBlock = skyAtmosphereWgsl.slice(wgslAdd, wgslTonemap);
  for (const [name, block] of [
    ["GLSL", glslBlock],
    ["WGSL", wgslBlock],
  ]) {
    for (const token of [
      "lightDir",
      "sunDirection",
      "lightDirWC",
      "sunDirectionWC",
    ]) {
      assert.ok(
        !block.includes(token),
        `${name}: the twilight band must not reference ${token}`,
      );
    }
  }
});

test("S6: the WebGPU ellipsoid input grows the uniform buffer add-only", () => {
  assert.match(skyRendererJs, /const UNIFORM_BUFFER_SIZE = 496;/);
  assert.match(
    skyRendererJs,
    /uniformData\[116\]\s*=\s*skyAtmosphere\._eclipseHorizonTwilight/,
  );
  for (const i of [117, 118, 119]) {
    assert.ok(
      skyRendererJs.includes(`uniformData[${i}] = 0.0;`),
      `float ${i} must be explicitly zeroed`,
    );
  }
  // Nothing before 116 may have moved: the last pre-S6 slot is still
  // moonControl at 112..115.
  assert.match(skyRendererJs, /uniformData\[112\] = dualLightInline/);
  assert.match(skyRendererJs, /uniformData\[115\] = 0\.0;/);
  // The original S6 field stays fixed after moonControl. The custom-ellipsoid
  // input is one new 16-byte tail block, so no established offset moves.
  const structTail = skyAtmosphereWgsl.slice(
    skyAtmosphereWgsl.indexOf("moonControl: vec4<f32>,"),
  );
  assert.match(
    structTail.slice(0, 1600),
    /eclipseControl: vec4<f32>,[\s\S]*ellipsoidInverseRadiiSquared: vec3<f32>,\s*_pad10: f32,\s*\};/,
  );
  for (const i of [120, 121, 122]) {
    assert.match(
      skyRendererJs,
      new RegExp(`uniformData\\[${i}\\] = inverseRadiiSquared\\.[xyz];`),
    );
  }
  assert.match(skyRendererJs, /uniformData\[123\] = 0\.0;/);
  // 496 = 31 * 16.
  assert.equal(496 % 16, 0);
});

test("S6: star extinction follows the active map-projection ellipsoid radius", () => {
  assert.match(
    starFieldJs,
    /frameState\.mapProjection\?\.ellipsoid \?\? Ellipsoid\.default/,
  );
  assert.match(
    starFieldJs,
    /computeAtmosphereExtinctionCached\([\s\S]*extinctionEllipsoid\.maximumRadius,/,
  );
  assert.doesNotMatch(starFieldJs, /Ellipsoid\.default\.maximumRadius/);
});

test("S6: the WebGL uniform closure and the WGSL slot read one scalar", () => {
  assert.match(skyAtmosphereJs, /u_eclipseHorizonTwilight: function \(\) \{/);
  assert.match(
    skyAtmosphereJs,
    /this\._eclipseHorizonTwilight = frameState\.eclipseHorizonTwilight \?\? 0\.0;/,
  );
  assert.match(skyAtmosphereFs, /uniform float u_eclipseHorizonTwilight;/);
});

test("S6: no new ShaderDefine bit (C12 exit-gate item 5)", () => {
  const defines = read(
    "packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts",
  );
  for (const token of [
    "ECLIPSE",
    "STAR_MODULATION",
    "HORIZON_TWILIGHT",
    "TWILIGHT",
  ]) {
    assert.ok(
      !defines.includes(token),
      `${token} must not have been added to the exhausted lo registry`,
    );
  }
  // Everything S6 added is a runtime uniform or a JS gate.
  assert.ok(!skyAtmosphereWgsl.includes("//>>ifdef ECLIPSE"));
  assert.ok(!skyAtmosphereFs.includes("#ifdef ECLIPSE"));
});

test("PINNED INSTANT has exactly ONE writer, and every lane scope restores it", () => {
  // ★ Batch 766 BLOCKER: `pinned` was a bare `let`, Lane D reassigned it to the
  // NIGHT instant and never restored it, and Lane D runs FIRST — so Lanes A,
  // B1-B3 and C all rendered hours after the eclipse, where `moonObscuration`
  // is 0 and the twilight factor is exactly 0. `fixtureIsDeep`,
  // `revealHappens`, `revealIsPartial` and `presentAtEveryAzimuth` could never
  // pass; the probe could not exit 0 as written. Lane B4's own save/restore
  // pair existed only to protect a value Lane D had already clobbered.
  //
  // "No lane mutates the shared instant" is a property a spec can hold and a
  // comment cannot, so it is held here mechanically.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );

  // The old, unscoped binding must be gone entirely.
  assert.ok(
    !/^\s*let pinned\b/m.test(probe),
    "the bare `let pinned` binding is back — lanes can clobber the instant again",
  );
  assert.ok(
    !/^\s*pinned\s*=/m.test(probe),
    "a lane assigns `pinned` directly instead of going through `atInstant`",
  );

  // Exactly three writes to the owned binding: the initialiser, and the
  // set/restore pair inside `atInstant`.
  const writes = probe.match(/_pinnedInstant\s*=/g) ?? [];
  assert.equal(
    writes.length,
    3,
    `expected 3 writes to _pinnedInstant (init + set + restore), found ${writes.length}`,
  );

  // The restore must be in a `finally`, so an early return or a throw inside a
  // lane cannot leak the change.
  assert.match(
    probe,
    /const atInstant = async \(iso, body\) => \{[\s\S]{0,400}?finally \{\s*\r?\n\s*_pinnedInstant = saved;/,
    "atInstant must restore the instant in a `finally`",
  );

  // Every lane that needs a non-default instant goes through the helper.
  const scopes = probe.match(/await atInstant\(/g) ?? [];
  assert.ok(
    scopes.length >= 3,
    `expected at least 3 scoped instant changes (lane D, lane B4, lane C clear), found ${scopes.length}`,
  );
  for (const iso of ["nightIso", "clearIso"]) {
    assert.ok(
      probe.includes(`await atInstant(${iso}`),
      `${iso} is not entered through atInstant`,
    );
  }

  // A scoped callback cannot `return out` — that returns from the callback,
  // not from MEASURE, and would leave the probe running past a structural
  // exit. The lane sets the flag and the caller checks it after the scope.
  assert.match(
    probe,
    /\/\/ NOT `return out` — this body is an `atInstant` callback/,
    "the structural-exit hazard inside a scoped callback must stay documented",
  );
  assert.match(
    probe,
    /if \(out\.structuralError\) \{\s*\r?\n\s*return \{ \.\.\.out, laneD \};/,
  );
});

test("CAPTURE is same-task: no read may cross a requestAnimationFrame yield", () => {
  // ★ Batch 766 executor cycle, ONE root cause behind TWO reported failures.
  // Every measurement did `await frame(); await frame(); readPixels()` — the
  // read crossed a task boundary, and both backends invalidate the canvas
  // across it differently: WebGL clears the drawing buffer after the
  // compositor swap (measured: all four WebGL PNGs byte-identical, 20,861
  // bytes, completely black), WebGPU invalidates the swap-chain texture after
  // presentation so the read returns a STALE frame (measured: lane D
  // `controlResponse = 0` — the black/white background renders never reached
  // the read). The working reference is `probe-eclipse-scene-dimming.mjs`,
  // which does `scene.render(T()); bandStats(...)` with nothing in between.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );

  // ── The GENERAL guarantees are enforced by the shared library, not here ──
  //
  // This defect is a CLASS: the umbra lane hit the identical shape from the
  // opposite direction (it made its settle helpers `async` to fix tile
  // starvation, which inserted yields between render and read; its WebGPU
  // sampler then read 0.0000 from a canvas a direct PNG decode showed was
  // 91.4% non-black). So the primitives and the checks live in
  // `lib/same-task-capture.mjs` and every probe inherits them; only
  // lane-specific assertions stay below.
  assert.deepEqual(
    checkEmbeddedCaptureIsCanonical(probe),
    [],
    "the probe's embedded capture block has drifted from the shared library",
  );
  assert.deepEqual(
    checkFusedCaptureUsage(probe),
    [],
    "the probe bypasses the shared same-task capture primitives",
  );

  // LANE-SPECIFIC: this probe's own aliases must point at the shared
  // primitives rather than at re-implementations.
  assert.match(
    probe,
    /const \{ renderNow, captureNow, grabNow, settleThen \} = makeSameTaskCapture\(/,
  );
  assert.match(probe, /const render = renderNow;/);
  assert.match(probe, /const grabCanvas = grabNow;/);
  // The old private names must be gone from this probe entirely.
  assert.ok(
    !/readPixelsUnsafe/.test(probe),
    "the probe still carries its private pre-consolidation reader",
  );
});

test("SHARED CAPTURE checks are NON-VACUOUS: both lanes' shipped defects are rejected", () => {
  // The consolidation is only worth anything if the shared checks reject the
  // real shapes. Both are replayed: this lane's (a read after two yields) and
  // the umbra lane's (a settle helper made `async`, putting a yield between
  // render and read).
  const canonical = `${CAPTURE_BEGIN}\n${SAME_TASK_CAPTURE_SOURCE}\n${CAPTURE_END}`;

  // Positive control: canonical + awaited immutable-snapshot usage passes.
  const good = `${canonical}\nconst img = await captureNow();\n`;
  assert.deepEqual(checkEmbeddedCaptureIsCanonical(good), []);
  assert.deepEqual(checkFusedCaptureUsage(good), []);

  // The ImageData decode is asynchronous. Forgetting to await it is rejected
  // rather than producing misleading undefined/zero metrics downstream.
  const unawaited = `${canonical}\nconst img = captureNow();\n`;
  const unawaitedFailures = checkFusedCaptureUsage(unawaited);
  assert.ok(
    unawaitedFailures.some((f) => f.includes("not awaited")),
    `unawaited capture not rejected: ${JSON.stringify(unawaitedFailures)}`,
  );

  // Parsing, rather than line matching, makes whitespace and comments inert.
  // This direct call is awaited even though neither token is on the same line;
  // the commented-out defects must not become false positives.
  const multilineAndComments = `${canonical}
/*
  const stale = captureNow();
  canvas.toDataURL("image/png");
*/
const img = await /* same-task */ captureNow(
);
`;
  assert.deepEqual(checkFusedCaptureUsage(multilineAndComments), []);

  // Capture-capable local wrappers are tracked as aliases. Awaiting the
  // wrapper is accepted; awaiting only its body cannot excuse a floating call.
  const awaitedAlias = `${canonical}
const alias = async () => await captureNow();
const img = await alias();
`;
  assert.deepEqual(checkFusedCaptureUsage(awaitedAlias), []);
  const unawaitedAlias = `${canonical}
const alias = async () => await captureNow();
const img = alias();
`;
  const unawaitedAliasFailures = checkFusedCaptureUsage(unawaitedAlias);
  assert.ok(
    unawaitedAliasFailures.some((f) => f.includes("alias() is not awaited")),
    `unawaited capture alias not rejected: ${JSON.stringify(
      unawaitedAliasFailures,
    )}`,
  );

  // Promise policy is intentionally strict and explicit. An awaited
  // Promise.all or .then chain adopts the capture promise and is accepted;
  // merely constructing either chain still floats the capture and is rejected.
  assert.deepEqual(
    checkFusedCaptureUsage(
      `${canonical}\nconst images = await Promise.all([captureNow()]);\n`,
    ),
    [],
  );
  assert.ok(
    checkFusedCaptureUsage(
      `${canonical}\nconst images = Promise.all([captureNow()]);\n`,
    ).some((f) => f.includes("not awaited")),
    "an unawaited Promise.all capture was accepted",
  );
  assert.deepEqual(
    checkFusedCaptureUsage(
      `${canonical}\nconst image = await captureNow().then((x) => x);\n`,
    ),
    [],
  );
  assert.ok(
    checkFusedCaptureUsage(
      `${canonical}\nconst image = captureNow().then((x) => x);\n`,
    ).some((f) => f.includes("not awaited")),
    "an unawaited .then capture was accepted",
  );

  // BOTH shipped defects reduce to the same forbidden operation: reading the
  // live GPU canvas outside the render task instead of decoding the immutable
  // PNG frozen by snapshotNow().
  const ownReader = `${canonical}
const sample = () => {
  const c2 = document.createElement("canvas");
  const cx = c2.getContext("2d");
  cx.drawImage(canvas, 0, 0);
  return cx.getImageData(0, 0, 4, 4);
};
`;
  const orFailures = checkFusedCaptureUsage(ownReader);
  assert.ok(
    orFailures.length > 0,
    `a probe-local reader was accepted: ${JSON.stringify(orFailures)}`,
  );

  // Drift: an edited embedded copy must be rejected, since the whole point is
  // that the library is the single owner.
  const drifted = `${CAPTURE_BEGIN}\n${SAME_TASK_CAPTURE_SOURCE.replace(
    "const snapshot = snapshotNow();",
    "return null;",
  )}\n${CAPTURE_END}\n`;
  assert.ok(
    checkEmbeddedCaptureIsCanonical(drifted).length > 0,
    "a drifted embedded copy was accepted",
  );
  // Missing markers entirely.
  assert.ok(checkEmbeddedCaptureIsCanonical("const x = 1;").length > 0);

  // Indentation must NOT count as drift — a probe embeds this inside a
  // `page.evaluate` callback and will indent it.
  const indented = `${CAPTURE_BEGIN}\n${SAME_TASK_CAPTURE_SOURCE.split("\n")
    .map((l) => (l.length ? `    ${l}` : l))
    .join("\n")}\n${CAPTURE_END}\n`;
  assert.deepEqual(
    checkEmbeddedCaptureIsCanonical(indented),
    [],
    "indenting the embedded block was treated as drift",
  );

  // The render and toDataURL snapshot are synchronous and ordered before the
  // asynchronous decode. The live canvas is never drawn after a yield.
  assert.match(
    SAME_TASK_CAPTURE_SOURCE,
    /const captureNow = \(\) => \{\s*\n\s*const snapshot = snapshotNow\(\);\s*\n\s*return decodeSnapshot\(snapshot\);/,
  );
  assert.match(SAME_TASK_CAPTURE_SOURCE, /ctx\.drawImage\(image, 0, 0\)/);
  assert.doesNotMatch(SAME_TASK_CAPTURE_SOURCE, /drawImage\(canvas/);

  // The settle wrapper awaits the immutable capture result after the final
  // snapshot, so callers receive ImageData rather than a nested Promise.
  assert.match(
    SAME_TASK_CAPTURE_SOURCE,
    /const hasCapture = typeof capture === "function";\s*\n\s*const result = hasCapture \? await capture\(\) : undefined;/,
    "settleThen must await the immutable capture",
  );
  assert.match(
    SAME_TASK_CAPTURE_SOURCE,
    /await new Promise\(\(r\) => requestAnimationFrame\(r\)\);[\s\S]*?if \(!settled && typeof done === "function"\) \{\s*settled = done\(\) === true;\s*\}[\s\S]*?await capture\(\)/,
    "settleThen must recheck done() after the final rAF and before capture",
  );
});

test("PER-LANE INSTANT is emitted and gated, so a wrong-time lane is visible", () => {
  // The `atInstant` fix was unverifiable from artifacts because the manifest
  // carried no timestamp — the defect being repaired was not observable in the
  // output. Every lane now records the instant it rendered at, and the verdict
  // gates on it.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.match(probe, /const recordInstant = \(lane, expectedIso\) =>/);
  assert.match(probe, /matches: iso === expectedIso/);
  assert.match(
    probe,
    /sunElevationDeg = 90 - \(Math\.acos\(d\) \* 180\) \/ Math\.PI/,
  );

  // Every lane records, and each records against the instant it requires.
  for (const [lane, iso] of [
    ["D-defaults", "nightIso"],
    ["A-shellAlpha", "deepestIso"],
    ["B-multiplier", "deepestIso"],
    ["B4-exactlyOnce", "nightIso"],
    ["C-clear", "clearIso"],
  ]) {
    assert.ok(
      probe.includes(`recordInstant("${lane}", ${iso})`),
      `lane ${lane} does not record against ${iso}`,
    );
  }
  assert.match(probe, /recordInstant\(`C-az\$\{az\}`, deepestIso\)/);

  // And the verdict gates on it — matching ISO, plus a sanity arm so a
  // matching timestamp with an absurd elevation still fails.
  assert.match(probe, /v\.everyLaneAtItsInstant\s*=/);
  assert.match(probe, /v\.nightLanesAreDark\s*=/);
  assert.match(probe, /v\.eclipseLanesAreSunlit\s*=/);
  assert.match(probe, /v\.everyLaneAtItsInstant &&/);
  assert.match(probe, /v\.nightLanesAreDark &&/);
  assert.match(probe, /v\.eclipseLanesAreSunlit;/);
  // The night bar is the derived one, not an invented number.
  assert.match(probe, /<= -5\.74/);
});

test("recordInstant RENDERS FIRST, so the elevation cannot be a stale lane's", () => {
  // v2: `B4-exactlyOnce` reported the correct ISO (23:13:00Z) with elevation
  // +25.655 — lane B's deepest-instant sun. The elevation derives from
  // `uniformState.sunPositionWC`, which reflects the last RENDERED frame, and
  // B4 recorded before rendering at its instant while lane D recorded after
  // four renders and reported the correct -8.096. Fixing the call site would
  // leave an order-dependent reporter to drift again, so the render is inside
  // the recorder.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.match(
    probe,
    /const recordInstant = \(lane, expectedIso\) => \{[\s\S]{0,2000}?renderNow\(\);\s*\r?\n\s*const iso = C\.JulianDate\.toIso8601\(T\(\)\);/,
    "recordInstant must render before reading the instant and the sun uniform",
  );
  // The sun uniform must be read AFTER that render, not before it.
  const body = probe.slice(probe.indexOf("const recordInstant ="));
  const renderAt = body.indexOf("renderNow();");
  const sunAt = body.indexOf("uniformState?.sunPositionWC");
  assert.ok(
    renderAt > 0 && sunAt > renderAt,
    "the sun uniform is read before recordInstant's render",
  );
});

test("LANE A does not depend on the WebGPU env-pass-drop defect", () => {
  // v2 bisected the exit-2 to `scene.sun.show = false`: on WebGPU, with all
  // environment content hidden including the sun, the band renders black and
  // `backgroundColor` is never applied (1 -> 0 exactly at that line; WebGL
  // unaffected). That is a NEW-WEBGPU-ENV-PASS-DROP member Batch 761's fix
  // does not cover, and it belongs to its own engine lane.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  // The dependency is removed, not worked around.
  assert.match(probe, /scene\.sun\.show = true;/);
  assert.ok(
    !/scene\.sun\.show = false/.test(probe),
    "the probe still hides the sun, re-acquiring the env-pass-drop dependency",
  );
  // Per Principle 9 the defect is NAMED, so a residual failure reports
  // "blocked by" rather than a bare control failure.
  assert.match(probe, /const BLOCKED_BY_ENV_PASS_DROP =/);
  assert.match(probe, /NEW-WEBGPU-ENV-PASS-DROP \(C12-G1F1 family/);
  assert.match(probe, /BLOCKED-BY-ENGINE, not a probe defect/);
  // Both control-response structural reasons must carry it.
  const uses = probe.match(/BLOCKED_BY_ENV_PASS_DROP,/g) ?? [];
  assert.equal(
    uses.length,
    2,
    `both control-response reasons must reference the defect, found ${uses.length}`,
  );
});

test("THE REVEAL is measured by contribution, not by a census that cannot see it", () => {
  // The census is arithmetically blind to the cubemap half at totality and
  // fixture-dependent for the sprite half. Recomputed here from the shipped
  // constants and the measured background, so the claim is not just prose.
  const ss = (t) => t * t * (3 - 2 * t);
  const sunAlt = Math.sin((25.65 * Math.PI) / 180);
  const base = ss(Math.min(1, Math.max(0, (sunAlt + 0.1) / 0.5)));
  const B = base * ECLIPSE_TWILIGHT_FLOOR;
  const k = 1 - ss(Math.min(1, Math.max(0, B * SHIPPED_STEEPNESS)));
  assert.ok(Math.abs(k - 0.06281) < 1e-4, `modulation at totality ${k}`);

  const bg = 0.053 * 255; // measured revealOn band mean
  const bar = Math.max(bg + 12, 1.6 * bg);
  const neededSource = bar / k;
  assert.ok(
    neededSource > 255,
    `a cubemap star would need ${neededSource}/255 — if this drops below 255 the census is no longer blind and the gate could return to it`,
  );

  // A sprite CAN clear the bar, which is why the failure was fixture-dependent
  // rather than uniform.
  const sirius = 5.87 * k * 255;
  assert.ok(sirius > bar, `Sirius ${sirius} vs bar ${bar}`);

  // And a band MEAN is the wrong statistic for ~10 sparse point sources.
  const bandPx = Math.round(1280 * 0.5) * Math.round(720 * 0.3);
  const meanOfTenStars = (10 * 4 * 50) / 255 / bandPx;
  assert.ok(
    meanOfTenStars < 1e-4,
    `ten stars move the band mean by ${meanOfTenStars}, below the 1e-4 floor — the floor was right, the statistic was wrong`,
  );

  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  // The gate is now the star CONTRIBUTION, measured by difference.
  assert.match(probe, /const starContribution = async \(\) => \{/);
  assert.match(
    probe,
    /revealHappens: \(b\.starSumOn \?\? 0\) > \(b\.starSumOff \?\? 0\)/,
  );
  assert.match(probe, /noStarsWithoutTheEclipse:/);
  assert.match(probe, /const bandMax = \(img, x0, y0, x1, y1\) =>/);
  // The census survives as a REPORTED diagnostic, not a gate.
  assert.match(probe, /revealOnSources: b\.revealOnSources/);

  // Lane B4 counts command publication directly and cannot pass on an empty
  // star ROI.
  assert.match(probe, /const snapshotStarSubmission = \(\) => \{/);
  assert.match(probe, /commandListOwnerCount/);
  assert.match(probe, /submissionCount:/);
  assert.match(probe, /hiddenStopsSubmission:/);
  assert.doesNotMatch(probe, /sfB4\.intensity = 40\.0;/);
});

test("the browser fixture is offline, render-current, and non-vacuously atmosphere-ready", () => {
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.equal(
    (probe.match(/CesiumViewer\/index\.html\?renderer=.*offline=true/g) ?? [])
      .length,
    2,
    "both fixture derivation and backend measurement must use offline boot",
  );
  const settleStart = probe.indexOf("const settleTiles = async");
  const settleEnd = probe.indexOf("// ══ LANE D", settleStart);
  const settle = probe.slice(settleStart, settleEnd);
  assert.ok(
    settle.indexOf("await frame();") < settle.indexOf("sceneReadiness();"),
    "settleTiles must render the current camera before sampling readiness",
  );
  assert.match(settle, /!requireVisibleTile \|\| readiness\.tilesToRender > 0/);
  assert.match(settle, /readiness\.atmosphereReady/);
  assert.match(settle, /readiness\.atmosphereVisible/);
  assert.match(
    probe,
    /laneD\.globeReadiness = await settleTiles\(180, true, true\)/,
  );
  assert.match(probe, /laneD\.readiness = await settleTiles\(180, true\)/);
  assert.match(probe, /opaqueShellHidesBackgroundLayers:/);
  assert.doesNotMatch(
    probe,
    /spritesVisible\s*!==\s*side\.result\.laneD\?\.cubemapVisible/,
  );
});

test("aim() RENDERS FIRST — the stale-uniform class, third instance", () => {
  // The former B4 pixel lane exposed a general helper defect: `aim()` derives
  // the anti-solar direction from `uniformState.sunPositionWC`, which reflects
  // the last RENDERED frame. Keep the ordering contract even though B4 now
  // counts command publication directly.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  // Comments in these helpers legitimately NAME the uniform they explain, so
  // the ordering is checked against CODE lines only — the same false-positive
  // class the `readPixels()` scan hit.
  const codeOnly = probe
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  for (const [helper, uniform] of [
    ["const aim = (azimuthOffsetDeg", "uniformState.sunPositionWC"],
    ["const recordInstant =", "uniformState?.sunPositionWC"],
  ]) {
    const body = codeOnly.slice(codeOnly.indexOf(helper));
    const renderAt = body.indexOf("renderNow();");
    const sunAt = body.indexOf(uniform);
    assert.ok(renderAt > 0, `${helper} must render before reading ${uniform}`);
    assert.ok(sunAt > 0, `${helper} no longer reads ${uniform}`);
    assert.ok(
      sunAt > renderAt,
      `${helper} reads ${uniform} before its render — the stale-uniform defect is back`,
    );
  }
});

test("THE MULTIPLIER is measured on the modulated component, not the band mean", () => {
  // v3 measured 0.938 against a 0.5 target. The modulation scales the CUBEMAP
  // and the sprites; the band mean is dominated by the sky shell, which it
  // never touches. Recomputed: 1 - 0.5c = 0.938 puts the modulated content at
  // c = 12.4% of the band, so the ratio is pinned near 1 whatever the
  // multiplier does — the right quantity in the wrong place, the same class as
  // the reveal census and the B4 band mean.
  const c = (1 - 0.938) / 0.5;
  assert.ok(
    c > 0.12 && c < 0.13,
    `modulated fraction implied by the v3 measurement: ${c}`,
  );
  // With the sky cancelled by difference, the ratio is the factor exactly.
  const sky = 1000;
  const comp = 124;
  const bandRatio = (sky + 0.5 * comp) / (sky + comp);
  const compRatio = (0.5 * comp) / comp;
  assert.ok(Math.abs(bandRatio - 0.945) < 0.01, `band ratio ${bandRatio}`);
  assert.equal(
    compRatio,
    0.5,
    "the component ratio recovers the factor exactly",
  );

  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.match(probe, /const modulatedComponent = async \(\) => \{/);
  assert.match(
    probe,
    /laneB\.measuredFactor =\s*\r?\n\s*Math\.abs\(fullComponent\.sum\) > 1\.0/,
  );
  assert.match(probe, /modulatedComponentMeasurable:/);
  // The old comparand survives, clearly labelled, so the evidence is not lost.
  assert.match(probe, /bandMeanRatioReportedOnly/);
});

test("STRUCTURAL ABORT preserves the evidence it computed", () => {
  // One early failure used to erase every downstream lane's numbers, and with
  // lane D's control response checked first that is exactly what happened —
  // `spriteAttenuatedMeasurable` and every tolerance were unreportable.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.match(probe, /manifest\.partialVerdicts = \{/);
  assert.match(probe, /manifest\.partialLanes = \{/);
  // `judge` must be run defensively on the abort path — it may legitimately
  // throw on a half-populated result, and that must not lose the raw lanes.
  assert.match(probe, /const partialVerdict = \(side\) => \{/);
  assert.match(probe, /judgeThrew:/);
  assert.match(probe, /const rawLanes = \(side\) => \(\{/);
  for (const lane of ["laneA", "laneB", "laneC", "laneD", "laneInstants"]) {
    assert.ok(
      new RegExp(`${lane}: side\\?\\.result\\?\\.${lane} \\?\\? null`).test(
        probe,
      ) || lane === "laneInstants",
      `${lane} is not preserved on the abort path`,
    );
  }
  // The instants are printed on the abort path, since they are the most
  // useful thing there and should not require opening the manifest.
  assert.match(probe, /partial manifest: /);
});

test("FIXTURE SELECTION: a vantage satisfying EVERY lane constraint exists (pure math)", () => {
  // ★ Batch 766: the selector picked on MAXIMUM OBSCURATION alone and then
  // demanded three instants at the winner — deepest, clear and night. Those are
  // jointly unsatisfiable for the vantage that rule picks: the sweep visits all
  // nine Iceland vantages first and the comparison is strictly-greater, so the
  // first vantage to reach obscuration 1.0 wins and nothing later displaces it,
  // yet at 62-66N in mid-August the sun never gets below about -12.7 deg. The
  // star-dependent lanes need `computeStarDayFade === 1`, so they had no usable
  // instant however deep the eclipse was. It surfaced as a bare structural
  // string an Edge cycle later.
  //
  // This runs the SAME predicates the probe now uses over the SAME vantage grid
  // with real ephemeris, and asserts a satisfying vantage exists — no browser.
  const SOLAR_RADIUS = 6.955e8;
  const LUNAR_RADIUS = 1737400.0;
  const clampUnit = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
  const m3 = new Matrix3();

  const overlap = (rs, ro, d) => {
    if (!(rs > 0) || !(ro > 0)) return 0;
    if (d >= rs + ro) return 0;
    if (d + rs <= ro) return 1;
    if (d + ro <= rs) return (ro / rs) * (ro / rs);
    const d2 = d * d;
    const rs2 = rs * rs;
    const ro2 = ro * ro;
    const a = Math.acos(clampUnit((d2 + rs2 - ro2) / (2 * d * rs)));
    const b = Math.acos(clampUnit((d2 + ro2 - rs2) / (2 * d * ro)));
    const prod = (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro);
    const lens = rs2 * a + ro2 * b - 0.5 * Math.sqrt(prod > 0 ? prod : 0);
    return Math.min(1, Math.max(0, lens / (Math.PI * rs2)));
  };

  const stateAt = (camPos, t) => {
    const rot =
      Transforms.computeIcrfToFixedMatrix(t, m3) ??
      Transforms.computeTemeToPseudoFixedMatrix(t, m3);
    const sun =
      Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        t,
        new Cartesian3(),
      );
    Matrix3.multiplyByVector(rot, sun, sun);
    const moon =
      Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        t,
        new Cartesian3(),
      );
    Matrix3.multiplyByVector(rot, moon, moon);

    const toSun = Cartesian3.subtract(sun, camPos, new Cartesian3());
    const dSun = Cartesian3.magnitude(toSun);
    Cartesian3.divideByScalar(toSun, dSun, toSun);
    const up = Cartesian3.normalize(camPos, new Cartesian3());
    const elev =
      90 - (Math.acos(clampUnit(Cartesian3.dot(up, toSun))) * 180) / Math.PI;
    const toMoon = Cartesian3.subtract(moon, camPos, new Cartesian3());
    const dMoon = Cartesian3.magnitude(toMoon);
    if (dMoon >= dSun) return { o: 0, elev };
    Cartesian3.divideByScalar(toMoon, dMoon, toMoon);
    const rs = Math.asin(Math.min(1, SOLAR_RADIUS / dSun));
    const ro = Math.asin(Math.min(1, LUNAR_RADIUS / dMoon));
    const sep = Math.acos(clampUnit(Cartesian3.dot(toSun, toMoon)));
    return { o: overlap(rs, ro, sep), elev };
  };

  const vantages = [];
  for (const region of [
    { name: "iceland", lat: 64.14, lon: -21.94 },
    { name: "spain", lat: 42.34, lon: -3.7 },
  ]) {
    for (const dLat of [-1.5, 0, 1.5]) {
      for (const dLon of [-2.5, 0, 2.5]) {
        vantages.push({
          name: region.name,
          lat: region.lat + dLat,
          lon: region.lon + dLon,
        });
      }
    }
  }

  const base = JulianDate.fromIso8601("2026-08-12T16:00:00Z");
  const scratchT = new JulianDate();
  const candidates = vantages.map((v) => {
    const pos = Cartesian3.fromDegrees(v.lon, v.lat, 100.0);
    let maxObscuration = 0;
    let maxSunElevationDeg = -90;
    let peakMinutes = 0;
    for (let i = 0; i <= 300; i += 1) {
      const t = JulianDate.addMinutes(base, i, scratchT);
      const s = stateAt(pos, t);
      if (s.elev > 8 && s.o > maxObscuration) {
        maxObscuration = s.o;
        maxSunElevationDeg = s.elev;
        peakMinutes = i;
      }
    }
    let minNightSunElevationDeg = 90;
    for (let m = 0; m <= 1440; m += 10) {
      const t = JulianDate.addMinutes(base, peakMinutes + m, scratchT);
      const s = stateAt(pos, t);
      if (s.elev < minNightSunElevationDeg) {
        minNightSunElevationDeg = s.elev;
      }
    }
    return {
      ...v,
      peakMinutes,
      maxObscuration,
      maxSunElevationDeg,
      minNightSunElevationDeg,
    };
  });

  const { survivors, rejections } = shortlistVantages(candidates);

  // THE ASSERTION THE OLD SELECTOR WOULD HAVE FAILED: something survives.
  assert.ok(
    survivors.length > 0,
    `no vantage satisfies every lane constraint; rejections: ${JSON.stringify(rejections)}`,
  );

  // And the specific historical trap is pinned, so a future grid change that
  // reintroduces it fails HERE. Under `node --test` there is no
  // earth-orientation data, so `Transforms` falls back to the TEME pseudo-fixed
  // rotation (~0.3-0.4 deg off in 2026) — the assertions are therefore about
  // the SHAPE of the constraint field, not arcsecond timing.
  const iceland = candidates.filter((c) => c.name === "iceland");
  const spain = candidates.filter((c) => c.name === "spain");
  assert.equal(iceland.length, 9);
  assert.equal(spain.length, 9);
  // Every Spain vantage gets genuinely dark; no Iceland vantage gets anywhere
  // near astronomical night, which is what made the old -18 deg rule
  // unsatisfiable there.
  for (const c of spain) {
    assert.ok(
      c.minNightSunElevationDeg < -18,
      `spain ${c.lat},${c.lon} minNightElev ${c.minNightSunElevationDeg}`,
    );
  }
  for (const c of iceland) {
    assert.ok(
      c.minNightSunElevationDeg > -18,
      `iceland ${c.lat},${c.lon} unexpectedly reaches astronomical night (${c.minNightSunElevationDeg})`,
    );
  }
  // ...but the DERIVED threshold (-8 deg, where `computeStarDayFade` is
  // already exactly 1) is satisfiable at BOTH regions, which is why relaxing
  // to the honest requirement keeps the Iceland showcase usable.
  assert.ok(
    iceland.some(
      (c) => c.minNightSunElevationDeg <= FIXTURE_NIGHT_MAX_SUN_ELEV_DEG,
    ),
    "the derived night threshold should be reachable from Iceland",
  );
  // The threshold really is the edge of `computeStarDayFade`'s flat region.
  assert.ok(
    Math.sin((FIXTURE_NIGHT_MAX_SUN_ELEV_DEG * Math.PI) / 180) <= -0.1,
    "the night threshold must sit inside computeStarDayFade's dayFade === 1 region",
  );
  assert.match(starFieldMathTs, /solarAltSin - -0\.1\) \/ \(0\.05 - -0\.1\)/);
});

test("FIXTURE SELECTION: the selector reports WHICH constraint eliminated the field", () => {
  // Synthetic: a field that is deep enough everywhere but never gets dark.
  // The 2026-08-12 Iceland vantages are the SHAPE of this failure (-9.7 to
  // -12.7 deg), though under the derived -8 deg threshold they now pass — the
  // relaxation is the other half of this batch's fix. The numbers here are
  // pushed into genuine polar-summer territory so the field is unsatisfiable
  // and the reporting can be exercised. The structural error must name
  // `nightReachable`, not merely say a night instant was not found.
  const neverDark = [];
  for (let i = 0; i < 9; i++) {
    neverDark.push({
      name: "iceland",
      lat: 62.64 + i * 0.5,
      lon: -21.94,
      maxObscuration: 1.0,
      maxSunElevationDeg: 25,
      minNightSunElevationDeg: -2.0 - i * 0.5,
    });
  }
  const icelandLike = neverDark;
  // Precondition: every row must genuinely fail the threshold, or this test
  // proves nothing.
  for (const c of icelandLike) {
    assert.ok(c.minNightSunElevationDeg > FIXTURE_NIGHT_MAX_SUN_ELEV_DEG);
  }
  const { survivors, rejections } = shortlistVantages(icelandLike);
  assert.equal(survivors.length, 0);
  assert.equal(rejections.length, 9);
  for (const r of rejections) {
    assert.deepEqual(r.failed, ["nightReachable"]);
  }
  const selection = selectEclipseFixture([], rejections);
  assert.equal(selection.chosen, null);
  assert.match(selection.structuralError, /nightReachable/);
  assert.match(selection.structuralError, /9 of 9 candidates/);
  assert.match(selection.structuralError, /dayFade === 1/);

  // Positive control: add one Spain-like vantage and the field is satisfiable,
  // so the rejection above is not vacuous.
  const withSpain = [
    ...icelandLike,
    {
      name: "spain",
      lat: 42.34,
      lon: -3.7,
      maxObscuration: 1.0,
      maxSunElevationDeg: 20,
      minNightSunElevationDeg: -33.0,
    },
  ];
  const second = shortlistVantages(withSpain);
  assert.equal(second.survivors.length, 1);
  assert.equal(second.survivors[0].name, "spain");

  // And the instant-level arm still gates: a survivor with no night INSTANT is
  // rejected even though it passed the cheap night-reachability test.
  const refined = [
    {
      ...second.survivors[0],
      deepest: { iso: "x", obscuration: 1.0, sunElevationDeg: 20 },
      clear: { iso: "y", obscuration: 0, sunElevationDeg: 20 },
      night: null,
    },
  ];
  const third = selectEclipseFixture(refined, []);
  assert.equal(third.chosen, null);
  assert.match(third.structuralError, /nightInstant/);
});

test("FIXTURE CONSTRAINTS: every predicate has demonstrated teeth", () => {
  // On the REAL grid the tally is `{ totalEclipse: 3 }` — five of six
  // predicates reject nothing, and the thing that actually unblocked the probe
  // was the -8 deg relaxation, not the constraint set. The architecture is kept
  // for the failure REPORT, not for current filtering, and the module header
  // says so. But a predicate that has never rejected anything is a predicate
  // nobody has tested, so each one's rejection path is driven here.
  const sound = {
    name: "spain",
    lat: 43.84,
    lon: -3.7,
    peakMinutes: 121,
    maxObscuration: 1.0,
    maxSunElevationDeg: 10.1,
    minNightSunElevationDeg: -31.5,
    deepest: { iso: "d", obscuration: 1.0, sunElevationDeg: 10.1 },
    clear: { iso: "c", obscuration: 0, sunElevationDeg: 21.4 },
    night: { iso: "n", sunElevationDeg: -20.3 },
  };
  const ALL = [...FIXTURE_CONSTRAINTS, ...FIXTURE_INSTANT_CONSTRAINTS];

  // Positive control: the sound row passes everything, or the rejections below
  // would be meaningless.
  assert.deepEqual(evaluateVantage(sound, ALL), { ok: true, failed: [] });

  // One mutation per predicate, each isolating exactly that predicate.
  const cases = [
    ["totalEclipse", { maxObscuration: 0.9 }],
    ["sunHighAtEclipse", { maxSunElevationDeg: 4.0 }],
    ["nightReachable", { minNightSunElevationDeg: -2.0 }],
    [
      "deepestInstant",
      { deepest: { iso: "d", obscuration: 0.5, sunElevationDeg: 10.1 } },
    ],
    ["clearInstant", { clear: null }],
    ["nightInstant", { night: null }],
  ];
  const exercised = new Set();
  for (const [id, patch] of cases) {
    const { ok, failed } = evaluateVantage({ ...sound, ...patch }, ALL);
    assert.equal(ok, false, `${id}: the mutation did not reject`);
    assert.ok(
      failed.includes(id),
      `${id}: rejected for ${JSON.stringify(failed)} instead`,
    );
    exercised.add(id);
  }
  // Coverage: no predicate may be added without a rejection case.
  for (const c of ALL) {
    assert.ok(
      exercised.has(c.id),
      `predicate ${c.id} has no rejection case — add one before shipping it`,
    );
  }
  assert.equal(exercised.size, ALL.length);

  // A clear instant with the sun too low must also reject — the predicate
  // carries an elevation arm, not just a null check.
  const lowClear = evaluateVantage(
    { ...sound, clear: { iso: "c", obscuration: 0, sunElevationDeg: 2.0 } },
    ALL,
  );
  assert.ok(lowClear.failed.includes("clearInstant"));
  // ...and a "clear" instant that is not actually clear.
  const notClear = evaluateVantage(
    { ...sound, clear: { iso: "c", obscuration: 0.2, sunElevationDeg: 21.4 } },
    ALL,
  );
  assert.ok(notClear.failed.includes("clearInstant"));
  // A night instant that does not reach the threshold.
  const shallowNight = evaluateVantage(
    { ...sound, night: { iso: "n", sunElevationDeg: -3.0 } },
    ALL,
  );
  assert.ok(shallowNight.failed.includes("nightInstant"));

  // And the honesty note must stay in the module the next author reads.
  const lib = fs.readFileSync(
    path.join(here, "lib/eclipse-fixture-constraints.mjs"),
    "utf8",
  );
  assert.match(lib, /honestly, ──\s*\r?\n\/\/ ── none of it/);
  assert.match(lib, /\{ totalEclipse: 3 \}/);
});

test("B4 telemetry accepts return-only once and rejects hidden or duplicate routes", () => {
  const isExactlyOnce = (draw) =>
    draw.environmentCommand === true &&
    draw.commandListOwnerCount === 0 &&
    draw.submissionCount === 1;
  const hiddenStops = (draw) =>
    draw.environmentCommand === false &&
    draw.commandListOwnerCount === 0 &&
    draw.submissionCount === 0;

  assert.equal(
    isExactlyOnce({
      environmentCommand: true,
      commandListOwnerCount: 0,
      submissionCount: 1,
    }),
    true,
  );
  assert.equal(
    isExactlyOnce({
      environmentCommand: true,
      commandListOwnerCount: 1,
      submissionCount: 2,
    }),
    false,
    "a returned+binned duplicate must fail",
  );
  assert.equal(
    isExactlyOnce({
      environmentCommand: false,
      commandListOwnerCount: 1,
      submissionCount: 1,
    }),
    false,
    "a binned-only command bypasses Scene ownership and must fail",
  );
  assert.equal(
    hiddenStops({
      environmentCommand: false,
      commandListOwnerCount: 0,
      submissionCount: 0,
    }),
    true,
  );

  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  assert.match(probe, /catalogDrawnOnce:/);
  assert.match(probe, /hiddenStopsSubmission:/);
  assert.match(probe, /restoreSchedulesOnce:/);
  assert.doesNotMatch(
    probe,
    /spriteRatio|singleDrawPrediction|doubleDrawPrediction/,
  );

  // The night threshold still protects the timestamp/elevation fixture even
  // though the exactly-once instrument no longer depends on pixel density.
  assert.equal(FIXTURE_NIGHT_MAX_SUN_ELEV_DEG, -8);
  assert.ok(Math.sin((-8 * Math.PI) / 180) <= -0.1);
});

test("FIXTURE SELECTION: the SUCCESS path returns the right fixture, field by field", () => {
  // ★ Batch 766 BLOCKER: every previous call site asserted `chosen === null`.
  // One input produced a 0-row table and the other a single `ok: false` row, so
  // NO `ok: true` row existed anywhere in the suite — a selector that always
  // returned null (broken guard, renamed field, changed return shape) passed
  // the whole suite and would only be caught after an Edge launch and two
  // `page.evaluate` passes. That is precisely the failure class the extraction
  // was supposed to remove, so the success path is now asserted on IDENTITY and
  // FIELDS, not on non-nullness.
  const spainDeep = {
    name: "spain",
    lat: 43.84,
    lon: -3.7,
    peakMinutes: 121,
    maxObscuration: 1.0,
    maxSunElevationDeg: 10.1,
    minNightSunElevationDeg: -31.52,
    deepest: {
      iso: "2026-08-12T18:01:00Z",
      obscuration: 1.0,
      sunElevationDeg: 10.1,
    },
    clear: {
      iso: "2026-08-12T16:40:00Z",
      obscuration: 0,
      sunElevationDeg: 21.4,
    },
    night: { iso: "2026-08-13T00:10:00Z", sunElevationDeg: -20.3 },
  };
  const spainShallower = {
    ...spainDeep,
    lat: 42.34,
    maxObscuration: 0.9901,
    deepest: { ...spainDeep.deepest, obscuration: 0.9901 },
  };

  const selection = selectEclipseFixture([spainShallower, spainDeep], []);

  // IDENTITY: the deepest qualifying vantage wins, not merely "something".
  assert.notEqual(selection.chosen, null);
  assert.equal(selection.structuralError, null);
  assert.equal(selection.chosen.name, "spain");
  assert.equal(selection.chosen.lat, 43.84);
  assert.equal(selection.chosen.lon, -3.7);
  assert.equal(selection.chosen.maxObscuration, 1.0);
  // FIELDS: everything the probe threads into the lanes must survive selection.
  assert.equal(selection.chosen.deepest.iso, "2026-08-12T18:01:00Z");
  assert.equal(selection.chosen.clear.iso, "2026-08-12T16:40:00Z");
  assert.equal(selection.chosen.night.iso, "2026-08-13T00:10:00Z");
  assert.equal(selection.chosen.peakMinutes, 121);
  // No rejections, and BOTH rows recorded as ok — an `ok: true` row now exists
  // in the suite, which is the thing that was missing.
  assert.deepEqual(selection.rejections, []);
  assert.equal(selection.constraintTable.length, 2);
  assert.ok(selection.constraintTable.every((r) => r.ok === true));
  assert.deepEqual(
    selection.constraintTable.map((r) => r.failed),
    [[], []],
  );

  // And the probe consumes exactly these fields, so a rename breaks here too.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  for (const field of [
    "selection.chosen.name",
    "selection.chosen.lat",
    "selection.chosen.lon",
    "selection.chosen.deepest",
    "selection.chosen.clear",
    "selection.chosen.night",
  ]) {
    assert.ok(probe.includes(field), `the probe no longer reads ${field}`);
  }
});

test("PROVENANCE MARKERS satisfy all four properties (shared enforcement)", () => {
  // A probe's provenance guard is never exercised until an EXECUTOR runs it —
  // workers cannot run probes. That asymmetry is exactly why this must be a
  // SPEC (which a worker can run) rather than a habit: otherwise every bad
  // marker costs a full Edge cycle to discover, one per cycle. Batch 766's
  // `u_starModulation: function () {` was found that way.
  //
  // The enforcement itself is NOT reimplemented here: it lives in
  // `lib/provenance-markers.mjs`, extracted from the C12-29 S5 worker's
  // `eclipse-globe-umbra.spec.mjs` so both probes share one implementation and
  // the next probe inherits it.
  const probe = fs.readFileSync(
    path.join(here, "probe-eclipse-sky-totality.mjs"),
    "utf8",
  );
  const { entries, failures } = validateProvenanceSlices({
    probeSource: probe,
    readSource: (file) => fs.readFileSync(path.join(root, file), "utf8"),
  });
  assert.deepEqual(
    failures,
    [],
    `provenance markers are unsound:\n${failures.join("\n")}`,
  );
  assert.ok(entries.length >= 6, `only ${entries.length} provenance slices`);

  // The rule must stay written where the next author will see it, with the
  // failure history that earned it.
  assert.match(
    probe,
    /PROVENANCE MARKERS MUST BE STRINGS NEITHER THE BUNDLER NOR THE FORMATTER/,
  );
  assert.match(probe, /FORBIDDEN: whitespace-adjacent syntax/);
});

test("SOURCE PINS are width-safe, and the lib REFUSES to author a fragile one", () => {
  // Sixth strike in the pin class, and the first caught before an executor.
  // NEGATIVE CONTROL FIRST: the exact pattern that shipped must be rejected,
  // on BOTH arms — the literal space, and the 79-char target line one under
  // prettier's 80-col printWidth.
  const fragile = /resolveSkyDynamicLighting\(skyAtmosphere, frameState\)/;
  const target = fs.readFileSync(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    ),
    "utf8",
  );
  const failures = checkSourcePinWidth({
    pattern: fragile,
    sourceText: target,
    label: "shipped-fragile",
  });
  assert.ok(
    failures.some((f) => f.includes("literal space")),
    `the literal-space arm did not fire: ${JSON.stringify(failures)}`,
  );
  assert.ok(
    failures.some((f) => f.includes("printWidth")),
    `the width arm did not fire: ${JSON.stringify(failures)}`,
  );
  // The measured fact the width arm rests on.
  const line = target
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((l) => l.includes("resolveSkyDynamicLighting(skyAtmosphere"));
  assert.equal(line.length, 79, "the target line is no longer 79 chars");
  assert.ok(line.length < PRINT_WIDTH);

  // POSITIVE CONTROL: the replacement is accepted, so the check is not simply
  // rejecting everything.
  assert.deepEqual(
    checkSourcePinWidth({
      pattern:
        /resolveSkyDynamicLighting\(\s*skyAtmosphere\s*,\s*frameState\s*\)/,
      sourceText: target,
      label: "shipped-fixed",
    }),
    [],
  );
  // A space inside a character class is deliberate and must NOT be flagged.
  assert.deepEqual(
    checkSourcePinWidth({
      pattern: /foo[ \t]+bar/,
      sourceText: "",
      label: "charclass",
    }),
    [],
  );
  // The throwing wrapper actually throws.
  assert.throws(() =>
    assertSourcePinIsWidthSafe({
      pattern: fragile,
      sourceText: target,
      label: "x",
    }),
  );

  // And this spec's own pins against the width-sensitive file are width-safe.
  for (const pattern of [
    /resolveSkyDynamicLighting\(\s*skyAtmosphere\s*,\s*frameState\s*\)/,
    /uniformData\[116\]\s*=\s*skyAtmosphere\._eclipseHorizonTwilight/,
  ]) {
    assert.deepEqual(
      checkSourcePinWidth({
        pattern,
        sourceText: target,
        label: String(pattern),
      }),
      [],
    );
  }
});

test("PROVENANCE enforcement is NON-VACUOUS: every historical defect is rejected", () => {
  // The S5 worker proved its check by re-injecting the four known defects and
  // confirming rejection — and one of them was initially ACCEPTED, which is
  // how the distinctiveness floor was found. Same treatment here, including
  // this batch's own `function () {` case.
  const sceneSource = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/Scene.js"),
    "utf8",
  );
  const panoramaSource = fs.readFileSync(
    path.join(root, "packages/engine/Source/Scene/CubeMapPanorama.js"),
    "utf8",
  );
  const why = "a justification long enough to pass the justification arm";

  const rejected = (entry, source, label) => {
    const f = validateProvenanceMarker(entry, source);
    assert.ok(
      f.length > 0,
      `NOT REJECTED — ${label}: ${JSON.stringify(entry.marker)}`,
    );
    return f;
  };

  // Strike 1 — numeric literal (esbuild rewrote `1.0` as `1`).
  rejected(
    {
      file: "packages/engine/Source/Scene/Scene.js",
      marker: "- earthOcclusion) * (1.0",
      why,
    },
    sceneSource,
    "numeric literal",
  );
  // Strike 2 — a prettier-wrappable multi-token statement.
  rejected(
    {
      file: "packages/engine/Source/Scene/Scene.js",
      marker:
        "frameState.eclipseHorizonTwilight = getEclipseHorizonTwilightFactor(",
      why,
    },
    sceneSource,
    "wrappable call",
  );
  // Strike 3 — THIS batch's defect: whitespace esbuild strips.
  const ws = rejected(
    {
      file: "packages/engine/Source/Scene/CubeMapPanorama.js",
      marker: "u_starModulation: function () {",
      why,
    },
    panoramaSource,
    "function () whitespace",
  );
  assert.ok(
    ws.some((m) => m.includes("not a single bare identifier")),
    `the whitespace case must be rejected ON SHAPE, got: ${ws.join(" | ")}`,
  );
  // Strike 4 — a renameable LOCAL binding, long enough to clear the floor.
  rejected(
    {
      file: "packages/engine/Source/Scene/Scene.js",
      marker: "starCopiesResolved",
      why,
    },
    "const starCopiesResolved = 1;\n",
    "renameable local",
  );
  // Strike 5 — distinctiveness: property-shaped, present, but far too generic.
  rejected(
    { file: "packages/engine/Source/Scene/Scene.js", marker: "data", why },
    "const x = surfaceTile.data;\n",
    "short generic identifier",
  );
  // Strike 6 — a shape the named file has never had.
  rejected(
    {
      file: "packages/engine/Source/Scene/Scene.js",
      marker: "neverExistedHere",
      why,
    },
    sceneSource,
    "absent from source",
  );
  // Missing justification is its own rejection.
  rejected(
    {
      file: "packages/engine/Source/Scene/Scene.js",
      marker: "eclipseHorizonTwilight",
      why: "x",
    },
    sceneSource,
    "no justification",
  );

  // POSITIVE CONTROL — the check must still ACCEPT a sound marker, or the
  // rejections above would be vacuous in the opposite direction.
  assert.deepEqual(
    validateProvenanceMarker(
      {
        file: "packages/engine/Source/Scene/Scene.js",
        marker: "eclipseHorizonTwilight",
        why,
      },
      sceneSource,
    ),
    [],
  );
  // ...and a shader marker, which skips the property arm by design.
  assert.deepEqual(
    validateProvenanceMarker(
      {
        file: "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
        marker: "u_eclipseHorizonTwilight",
        why,
      },
      skyAtmosphereFs,
    ),
    [],
  );
});

test("S6: the sky WGSL passes naga validation", async () => {
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
  assert.doesNotThrow(
    () => naga.validate_wgsl(panoramaWgsl),
    "CubeMapPanorama.wgsl",
  );

  // The production panorama shader is the JS-embedded copy; validate that
  // one too, extracted the same way the S1 spec extracts the sun shader.
  const start = panoramaRendererJs.indexOf("const CUBEMAP_PANORAMA_WGSL = `");
  assert.ok(start > 0, "inline panorama WGSL not found");
  const bodyStart = panoramaRendererJs.indexOf("`", start) + 1;
  const bodyEnd = panoramaRendererJs.indexOf("`;", bodyStart);
  assert.ok(bodyEnd > bodyStart);
  const inline = panoramaRendererJs.slice(bodyStart, bodyEnd);
  assert.ok(inline.includes("uniforms.starModulation"), "wrong slice");
  assert.ok(!inline.includes("${"), "template interpolation in the WGSL");
  assert.doesNotThrow(() => naga.validate_wgsl(inline), "inline panorama WGSL");
});
