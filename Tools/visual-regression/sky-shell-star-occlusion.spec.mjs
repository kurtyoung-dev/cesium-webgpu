// sky-shell-star-occlusion.spec.mjs — the sky shell's day/night alpha ramp and
// what it does to the star field beneath it.
// @purpose Executes the shipped shell-alpha expressions out of both shader texts and composites them over the shipped star exposure, so a ground camera's night stars are provably reachable.
// @status ACTIVE
//
// WHY THIS EXISTS
// ───────────────
// The sky atmosphere is drawn AFTER the star cubemap and the catalogue sprites
// (`Scene/EnvironmentRenderer.js`, and the same order is injected on WebGPU),
// with ALPHA_BLEND. Whatever alpha that shell resolves to is therefore a direct
// multiplier on every star already in the frame: a star survives at
// `peak * (1 - shellAlpha)`.
//
// The ramp that decides that alpha used to be gated on the dynamic-lighting
// enum, and the shipped default resolves to the natural-sky enum (`Globe`
// constructs with `enableLighting = false`). In that arm the ramp was pinned at
// 1.0, so a ground camera's shell alpha was the altitude ramp alone —
// 0.995495 at 500 m — all night. Every star in the frame was multiplied by
// 0.0045: the brightest in-frame catalogue star of a 60-degree anti-solar frame
// went from a 21-luma peak to 0.10, i.e. to the 0 code, and even a fully
// saturated star would have survived at luma 1.15. That is the whole content of
// the "twilight star black box": the star field was correct and was erased on
// composite.
//
// WHAT IS EXECUTED HERE, NOT TRANSCRIBED
// ──────────────────────────────────────
// Every number below comes from shipped code:
//
//   * the ramp, the altitude opacity and the alpha mix are EXTRACTED from
//     `Shaders/SkyAtmosphereCommon.glsl`, `Shaders/SkyAtmosphereFS.glsl` and
//     `Shaders/WebGPU/Environment/SkyAtmosphere.wgsl` and EVALUATED with the
//     shared `lib/wgsl-mini-eval.mjs` reader, so both dialects are run rather
//     than compared as text;
//   * the star's brightness comes from `Scene/StarFieldMath.ts`'s
//     `buildStarInstanceData`;
//   * its atmospheric dimming comes from `Scene/computeAtmosphereExtinction.js`
//     at the airmass law the two star shaders apply;
//   * the reveal multiplier comes from `Scene/SkyBrightness.js` composed with
//     `computeStarBrightnessModulation`.
//
// FRAME SUBSTITUTION, DECLARED: the browser probe rotates the inertial Sun with
// `computeIcrfToFixedMatrix`, whose IAU2006 XYS chunks only a browser fetch
// supplies. Node falls back to the GMST rotation the probe already applies to
// the stars. The two differ by precession and nutation, about 0.4 degrees at
// this epoch — a few pixels in this framing, and irrelevant to a claim about a
// 220x attenuation. The substitution is asserted to reproduce the target the
// banked run reported (vmag 2.14) so it cannot drift silently.
//
// Run: node --test Tools/visual-regression/sky-shell-star-occlusion.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  evaluate,
  parseExpression,
  stripComments,
  tokenize,
} from "./lib/wgsl-mini-eval.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");
const engineUrl = (rel) =>
  pathToFileURL(path.join(root, "packages/engine/Source", rel)).href;

const GLSL_COMMON_REL =
  "packages/engine/Source/Shaders/SkyAtmosphereCommon.glsl";
const GLSL_FS_REL = "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl";
const WGSL_REL =
  "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl";
const ATMOSPHERE_COMMON_REL =
  "packages/engine/Source/Shaders/AtmosphereCommon.glsl";
const ENVIRONMENT_RENDERER_REL =
  "packages/engine/Source/Scene/EnvironmentRenderer.js";
const GLOBE_REL = "packages/engine/Source/Scene/Globe.js";

const glslCommon = read(GLSL_COMMON_REL);
const glslFs = read(GLSL_FS_REL);
const wgsl = read(WGSL_REL);

const { default: Cartesian3 } = await import(engineUrl("Core/Cartesian3.js"));
const { default: Cartesian4 } = await import(engineUrl("Core/Cartesian4.js"));
const { default: Matrix3 } = await import(engineUrl("Core/Matrix3.js"));
const { default: Matrix4 } = await import(engineUrl("Core/Matrix4.js"));
const { default: JulianDate } = await import(engineUrl("Core/JulianDate.js"));
const { default: Ellipsoid } = await import(engineUrl("Core/Ellipsoid.js"));
const { default: CesiumMath } = await import(engineUrl("Core/Math.js"));
const { default: Transforms } = await import(engineUrl("Core/Transforms.js"));
const { default: PerspectiveFrustum } = await import(
  engineUrl("Core/PerspectiveFrustum.js")
);
const { default: Simon1994PlanetaryPositions } = await import(
  engineUrl("Core/Simon1994PlanetaryPositions.js")
);
const { default: BrightStarCatalog } = await import(
  engineUrl("Scene/BrightStarCatalog.js")
);
const { default: Atmosphere } = await import(engineUrl("Scene/Atmosphere.js"));
const { default: DynamicAtmosphereLightingType } = await import(
  engineUrl("Scene/DynamicAtmosphereLightingType.js")
);
const { default: computeAtmosphereExtinction } = await import(
  engineUrl("Scene/computeAtmosphereExtinction.js")
);
const { computeSkyBrightness, computeCelestialElevationSine } = await import(
  engineUrl("Scene/SkyBrightness.js")
);
const {
  FLOATS_PER_STAR,
  buildStarInstanceData,
  computeStarBrightnessModulation,
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
} = await import(engineUrl("Scene/StarFieldMath.ts"));

// ── shader-expression reader ────────────────────────────────────────────────
//
// `wgsl-mini-eval` reads expressions, not statements, so each shipped statement
// is located by its exact left-hand side and its right-hand side is taken up to
// the terminating semicolon. The only normalisation is removing the trailing
// comma WGSL allows before a closing paren, which the shared tokenizer's
// argument list does not accept. Anything else outside the evaluator's subset
// throws, which is the point: a shader that outgrows the reader fails loudly.

/**
 * Take the right-hand side of one assignment out of shader source.
 *
 * @param {string} source Shader text.
 * @param {string} lhs Exact left-hand side, up to and including `=`.
 * @returns {string} The right-hand side, without its semicolon.
 */
function rhsOf(source, lhs) {
  const body = stripComments(source);
  const at = body.indexOf(lhs);
  assert.ok(at >= 0, `assignment not found in shader source: ${lhs}`);
  const end = body.indexOf(";", at);
  assert.ok(end > at, `unterminated assignment: ${lhs}`);
  return body.slice(at + lhs.length, end).replace(/,(\s*\))/g, "$1");
}

/**
 * Evaluate a shader expression string in a supplied environment.
 *
 * @param {string} expression Shader expression text.
 * @param {object} env Name bindings, plus `__functions` for extra builtins.
 * @returns {number|object|boolean} The value.
 */
function run(expression, env) {
  const tokens = tokenize(expression);
  const { node } = parseExpression(tokens, 0);
  return evaluate(node, env);
}

const EXTRA = {
  mix: (a, b, t) => a + (b - a) * t,
  smoothstep: (e0, e1, x) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  },
};

const GLSL_NIGHT_ALPHA = rhsOf(glslCommon, "float nightAlpha =");
const GLSL_ALTITUDE_OPACITY = rhsOf(glslCommon, "opacity = clamp(").replace(
  /^/,
  "clamp(",
);
const GLSL_OPACITY_RAMP = rhsOf(glslCommon, "opacity *=");
const GLSL_SHELL_ALPHA = rhsOf(glslFs, "color.a =");
const WGSL_NIGHT_ALPHA = rhsOf(wgsl, "var nightAlpha =");
const WGSL_ALTITUDE_OPACITY = rhsOf(wgsl, "let altitudeOpacity =");
const WGSL_OPACITY = rhsOf(wgsl, "let opacity =");
const WGSL_SHELL_ALPHA = rhsOf(wgsl, "let alpha =");

// The reader must have found real arithmetic, not an empty string that would
// make every assertion below vacuously true.
for (const [name, text] of [
  ["GLSL nightAlpha", GLSL_NIGHT_ALPHA],
  ["WGSL nightAlpha", WGSL_NIGHT_ALPHA],
  ["GLSL altitude opacity", GLSL_ALTITUDE_OPACITY],
  ["WGSL altitude opacity", WGSL_ALTITUDE_OPACITY],
  ["GLSL shell alpha", GLSL_SHELL_ALPHA],
  ["WGSL shell alpha", WGSL_SHELL_ALPHA],
]) {
  assert.ok(text.trim().length > 8, `${name} extraction is empty`);
}

const ATMOSPHERE_THICKNESS = Number(
  /const float ATMOSPHERE_THICKNESS = ([0-9.e+]+);/.exec(
    read(ATMOSPHERE_COMMON_REL),
  )[1],
);

const vec = (c) => ({ x: c.x, y: c.y, z: c.z });

/**
 * Shell alpha from the SHIPPED GLSL text, for one shell point and light.
 *
 * `atmosphereInnerRadius` is a free parameter of the shipped expression, so it
 * is supplied here at the value the shader derives; it cancels out of the
 * altitude ramp, which the spec asserts separately.
 *
 * @param {object} args Geometry and colour inputs.
 * @returns {number} Alpha in [0, 1].
 */
function glslShellAlpha({
  shellPoint,
  lightDir,
  eyeHeight,
  colorB,
  nightAlphaExpression = GLSL_NIGHT_ALPHA,
  enumValue = 0,
}) {
  const innerRadius = Ellipsoid.WGS84.maximumRadius;
  const env = {
    positionWC: vec(shellPoint),
    lightDirection: vec(lightDir),
    czm_eyeHeight: eyeHeight,
    atmosphereInnerRadius: innerRadius,
    ATMOSPHERE_THICKNESS,
    // Only the pre-fix ramp reads this; the shipped one has no enum term.
    u_radiiAndDynamicAtmosphereColor: { z: enumValue },
    __functions: EXTRA,
  };
  env.cameraHeight = env.czm_eyeHeight + innerRadius;
  env.atmosphereOuterRadius = innerRadius + ATMOSPHERE_THICKNESS;
  const altitude = run(GLSL_ALTITUDE_OPACITY, env);
  env.nightAlpha = run(nightAlphaExpression, env);
  const opacity = altitude * run(GLSL_OPACITY_RAMP, env);
  return run(GLSL_SHELL_ALPHA, {
    ...env,
    color: { a: opacity, b: colorB },
    czm_morphTime: 1.0,
    __functions: EXTRA,
  });
}

/**
 * Shell alpha from the SHIPPED WGSL text, same inputs.
 *
 * @param {object} args Geometry and colour inputs.
 * @returns {number} Alpha in [0, 1].
 */
function wgslShellAlpha({
  shellPoint,
  lightDir,
  eyeHeight,
  colorB,
  nightAlphaExpression = WGSL_NIGHT_ALPHA,
  enumValue = 0,
}) {
  const innerRadius = Ellipsoid.WGS84.maximumRadius;
  const env = {
    skyPoint: vec(shellPoint),
    lightDirWC: vec(lightDir),
    innerRadius,
    outerRadius: innerRadius + ATMOSPHERE_THICKNESS,
    cameraHeight: innerRadius + eyeHeight,
    // Only the pre-fix ramp reads these; the shipped one has neither term.
    u: { radiiAndDynamicAtmosphere: { z: enumValue } },
    isDynamic: enumValue !== 0,
    __functions: EXTRA,
  };
  env.altitudeOpacity = run(WGSL_ALTITUDE_OPACITY, env);
  env.nightAlpha = run(nightAlphaExpression, env);
  const opacity = run(WGSL_OPACITY, env);
  return run(WGSL_SHELL_ALPHA, {
    ...env,
    opacity,
    finalColor: { b: colorB },
    __functions: EXTRA,
  });
}

// ── the probe's control-lane scene, re-derived ──────────────────────────────

const SITE_LON = -105.0;
const SITE_LAT = 40.0;
const SITE_HEIGHT = 500.0;
const VIEW_W = 1024;
const VIEW_H = 768;
const BOX_HALF = 40;
const CONTROL_SUN_ELEVATION_DEG = -20;

const cameraPos = Cartesian3.fromDegrees(SITE_LON, SITE_LAT, SITE_HEIGHT);
const geodeticUp = Ellipsoid.WGS84.geodeticSurfaceNormal(
  cameraPos,
  new Cartesian3(),
);

const sunAt = (jd) => {
  const rotation =
    Transforms.computeIcrfToFixedMatrix(jd) ??
    Transforms.computeTemeToPseudoFixedMatrix(jd, new Matrix3());
  const inertial =
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      jd,
      new Cartesian3(),
    );
  return Cartesian3.normalize(
    Matrix3.multiplyByVector(rotation, inertial, new Cartesian3()),
    new Cartesian3(),
  );
};
const elevationAt = (jd) =>
  CesiumMath.toDegrees(
    Math.asin(
      Math.max(
        -1,
        Math.min(1, computeCelestialElevationSine(sunAt(jd), cameraPos)),
      ),
    ),
  );
const solveClock = (targetDeg) => {
  const base = JulianDate.fromIso8601("2026-03-20T00:00:00Z");
  let lo = null;
  let hi = null;
  let previousJd = base;
  let previousElevation = elevationAt(base);
  for (let minutes = 5; minutes <= 1440; minutes += 5) {
    const jd = JulianDate.addMinutes(base, minutes, new JulianDate());
    const elevation = elevationAt(jd);
    if (previousElevation >= targetDeg !== elevation >= targetDeg) {
      lo = previousJd;
      hi = jd;
      break;
    }
    previousJd = jd;
    previousElevation = elevation;
  }
  assert.ok(lo !== null, `no bracketing instant for ${targetDeg} degrees`);
  for (let i = 0; i < 40; i++) {
    const mid = JulianDate.addSeconds(
      lo,
      JulianDate.secondsDifference(hi, lo) * 0.5,
      new JulianDate(),
    );
    if (elevationAt(lo) >= targetDeg !== elevationAt(mid) >= targetDeg)
      hi = mid;
    else lo = mid;
  }
  return lo;
};

const controlInstant = solveClock(CONTROL_SUN_ELEVATION_DEG);
const controlSunDir = sunAt(controlInstant);

/**
 * The brightest catalogue star inside the probe's anti-solar frame, with the
 * shell point its view ray crosses.
 *
 * @returns {object} Row index, magnitude, fixed-frame direction and shell point.
 */
function brightestInFrameStar() {
  const antiSun = Cartesian3.negate(controlSunDir, new Cartesian3());
  const right = Cartesian3.normalize(
    Cartesian3.cross(antiSun, geodeticUp, new Cartesian3()),
    new Cartesian3(),
  );
  const up = Cartesian3.normalize(
    Cartesian3.cross(right, antiSun, new Cartesian3()),
    new Cartesian3(),
  );
  const viewMatrix = Matrix4.computeView(
    cameraPos,
    antiSun,
    up,
    right,
    new Matrix4(),
  );
  const frustum = new PerspectiveFrustum();
  frustum.fov = CesiumMath.toRadians(60.0);
  frustum.aspectRatio = VIEW_W / VIEW_H;
  frustum.near = 1.0;
  frustum.far = 500000000.0;
  const projection = frustum.projectionMatrix;
  const temeToFixed = Transforms.computeTemeToPseudoFixedMatrix(
    controlInstant,
    new Matrix3(),
  );

  let best = null;
  for (let i = 0; i < BrightStarCatalog.count; i++) {
    const base = i * BrightStarCatalog.STRIDE;
    const vmag = BrightStarCatalog.data[base + 2];
    if (best !== null && vmag >= best.vmag) continue;
    const ra = CesiumMath.toRadians(BrightStarCatalog.data[base + 0]);
    const dec = CesiumMath.toRadians(BrightStarCatalog.data[base + 1]);
    const teme = new Cartesian3(
      Math.cos(dec) * Math.cos(ra),
      Math.cos(dec) * Math.sin(ra),
      Math.sin(dec),
    );
    const dirFixed = Cartesian3.normalize(
      Matrix3.multiplyByVector(temeToFixed, teme, new Cartesian3()),
      new Cartesian3(),
    );
    const far = Cartesian3.multiplyByScalar(dirFixed, 1.0e12, new Cartesian3());
    const eye = Matrix4.multiplyByVector(
      viewMatrix,
      Cartesian4.fromElements(far.x, far.y, far.z, 1),
      new Cartesian4(),
    );
    const clip = Matrix4.multiplyByVector(projection, eye, new Cartesian4());
    if (clip.z < 0) continue;
    const x = (clip.x / clip.w) * 0.5 + 0.5;
    const y = (clip.y / clip.w) * 0.5 + 0.5;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const px = Math.round(x * VIEW_W);
    const py = Math.round(VIEW_H - y * VIEW_H);
    if (
      px < BOX_HALF ||
      py < BOX_HALF ||
      px >= VIEW_W - BOX_HALF ||
      py >= VIEW_H - BOX_HALF
    ) {
      continue;
    }
    best = { index: i, vmag, dirFixed, px, py };
  }
  assert.ok(best !== null, "no catalogue star lands inside the control frame");
  // The shell point the star's view ray crosses, which is what both shaders
  // shade: march out along the ray until the radius reaches the outer shell.
  const outerRadius = Ellipsoid.WGS84.maximumRadius + ATMOSPHERE_THICKNESS;
  const b = 2.0 * Cartesian3.dot(cameraPos, best.dirFixed);
  const c = Cartesian3.dot(cameraPos, cameraPos) - outerRadius * outerRadius;
  const t = (-b + Math.sqrt(b * b - 4.0 * c)) * 0.5;
  best.shellPoint = Cartesian3.add(
    cameraPos,
    Cartesian3.multiplyByScalar(best.dirFixed, t, new Cartesian3()),
    new Cartesian3(),
  );
  return best;
}

const target = brightestInFrameStar();

/**
 * The target star's peak pixel, in 8-bit codes, BEFORE the shell composites
 * over it: shipped Pogson exposure, shipped reveal multiplier, shipped
 * atmospheric extinction at the shader's airmass law, shipped PSF peak.
 *
 * @returns {{r: number, g: number, b: number}} Linear peak, 0..255 scale.
 */
function targetStarPeak() {
  const instances = buildStarInstanceData();
  const o = target.index * FLOATS_PER_STAR;
  const flux = instances[o + 3];
  const rgb = [instances[o + 4], instances[o + 5], instances[o + 6]];

  const skyBrightness = computeSkyBrightness(
    controlSunDir,
    undefined,
    0.0,
    cameraPos,
    SITE_HEIGHT,
  );
  const reveal = computeStarBrightnessModulation(
    skyBrightness,
    STAR_MODULATION_INFLECTION,
    STAR_MODULATION_STEEPNESS,
  );

  const cameraLength = Cartesian3.magnitude(cameraPos);
  const zenithDirection = Cartesian3.divideByScalar(
    cameraPos,
    cameraLength,
    new Cartesian3(),
  );
  const zenithBody = Cartesian3.add(
    cameraPos,
    Cartesian3.multiplyByScalar(zenithDirection, 1.0e9, new Cartesian3()),
    new Cartesian3(),
  );
  const zenithTransmittance = computeAtmosphereExtinction(
    new Cartesian3(),
    cameraPos,
    zenithBody,
    new Atmosphere(),
    Ellipsoid.WGS84.maximumRadius,
  );
  // The airmass law both star shaders apply, read off the shipped GLSL.
  const airmassSource = read("packages/engine/Source/Shaders/StarFieldVS.glsl");
  const airmassFloor = Number(
    /float airmass = 1\.0 \/ max\(sinElev, ([0-9.]+)\);/.exec(airmassSource)[1],
  );
  const sinElevation = Cartesian3.dot(target.dirFixed, zenithDirection);
  const airmass = 1.0 / Math.max(sinElevation, airmassFloor);
  const extinction = [
    Math.pow(zenithTransmittance.x, airmass),
    Math.pow(zenithTransmittance.y, airmass),
    Math.pow(zenithTransmittance.z, airmass),
  ];
  // Fragment profile peak at r = 0: core 1 plus the halo share.
  const kHalo = Number(
    /const float STAR_PSF_K_HALO = ([0-9.]+);/.exec(
      read("packages/engine/Source/Shaders/StarFieldFS.glsl"),
    )[1],
  );
  const profilePeak = 1.0 + kHalo;
  const scale = 255.0 * flux * reveal * profilePeak;
  return {
    r: rgb[0] * extinction[0] * scale,
    g: rgb[1] * extinction[1] * scale,
    b: rgb[2] * extinction[2] * scale,
    sinElevation,
    reveal,
  };
}

const LUMA = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// ═══════════════════════════ 1. the composite ═══════════════════════════════

test("the probe's control-lane target is the star the banked run reported", () => {
  // Guards the declared frame substitution: if the ICRF fallback ever moves the
  // instant enough to change which star is brightest in frame, every number
  // below is about a different subject and this says so.
  assert.equal(target.vmag, 2.14);
  // And it lands where the banked run put it, within the declared precession
  // offset of the frame substitution rather than "somewhere in the frame".
  const bankedX = 370;
  const bankedY = 203;
  const offsetPx = Math.hypot(target.px - bankedX, target.py - bankedY);
  assert.ok(
    offsetPx <= 10,
    `target moved ${offsetPx.toFixed(1)} px from the banked (370, 203) — ` +
      "more than the declared frame substitution can account for",
  );
});

test("at shipped defaults the sky enum is the natural-sky arm", () => {
  // The arm that used to pin the ramp. Read out of the shipped constructor
  // text because `Globe.js` pulls built shader modules a source run has not.
  const globeJs = read(GLOBE_REL);
  const flag = (field) =>
    new RegExp(`this\\.${field} = (true|false);`).exec(globeJs)[1] === "true";
  const resolved = DynamicAtmosphereLightingType.fromGlobeFlags({
    enableLighting: flag("enableLighting"),
    dynamicAtmosphereLighting: flag("dynamicAtmosphereLighting"),
    dynamicAtmosphereLightingFromSun: flag("dynamicAtmosphereLightingFromSun"),
  });
  assert.equal(resolved, DynamicAtmosphereLightingType.NONE);
});

test("the shell is composited over the star field, not under it", () => {
  // The ordering that makes the shell's alpha a multiplier on the stars. If
  // this ever flips, the composite arithmetic below stops describing the frame.
  const source = read(ENVIRONMENT_RENDERER_REL);
  const starAt = source.indexOf("environmentState.starFieldCommand");
  const skyAt = source.indexOf("environmentState.isSkyAtmosphereVisible");
  assert.ok(starAt > 0 && skyAt > starAt, "star field must execute first");
});

test("a ground camera's night star survives the shell composite", () => {
  // THE BEHAVIOURAL CLAIM. Peak star pixel after ALPHA_BLEND with the shell:
  //   out = shellColor * alpha + star * (1 - alpha)
  // and the shell's own colour is ~0 at astronomical night, so what is left of
  // the star is `peak * (1 - alpha)`. It must survive as at least one 8-bit
  // code, which is the difference between a measurable star and the black box.
  const peak = targetStarPeak();
  const alpha = glslShellAlpha({
    shellPoint: target.shellPoint,
    lightDir: controlSunDir,
    eyeHeight: SITE_HEIGHT,
    colorB: 0.0,
  });
  const survived = {
    r: peak.r * (1 - alpha),
    g: peak.g * (1 - alpha),
    b: peak.b * (1 - alpha),
  };
  assert.ok(
    LUMA(peak) > 12,
    `the star must reach the frame at all: luma ${LUMA(peak)}`,
  );
  assert.ok(
    Math.round(LUMA(survived)) > 0,
    `star luma after the shell composite is ${LUMA(survived).toFixed(4)}, ` +
      `shell alpha ${alpha.toFixed(6)} — the star is erased`,
  );
});

test("MUTATION: restoring the enum gate puts the star back at the 0 code", () => {
  // INERTNESS IMAGE, MEASURED. The fix is a shader expression, so the honest
  // way to make it unreachable is to put the pre-fix text back on a copy of
  // each source and re-run the SAME reader, the SAME ramp evaluation and the
  // SAME composite over it. Nothing here is hardcoded: the pre-fix arm is
  // EXECUTED, so this red carries the number the reverted shader would produce
  // rather than a parser failure. (`lib/wgsl-mini-eval.mjs` reads `?:` and
  // `select` for exactly this reason.)
  const mutatedGlsl = glslCommon.replace(
    /float nightAlpha = clamp\(dot\(normalize\(positionWC\), lightDirection\), 0\.0, 1\.0\);/,
    "float nightAlpha = (u_radiiAndDynamicAtmosphereColor.z != 0.0) ? " +
      "clamp(dot(normalize(positionWC), lightDirection), 0.0, 1.0) : 1.0;",
  );
  const mutatedWgsl = wgsl.replace(
    /var nightAlpha = clamp\(dot\(normalize\(skyPoint\), lightDirWC\), 0\.0, 1\.0\);/,
    "var nightAlpha = select(1.0, clamp(dot(normalize(skyPoint), lightDirWC), " +
      "0.0, 1.0), isDynamic);",
  );
  assert.notEqual(mutatedGlsl, glslCommon, "the GLSL mutation must apply");
  assert.notEqual(mutatedWgsl, wgsl, "the WGSL mutation must apply");

  // Re-extracted from the mutated text by the shipped reader, then executed at
  // the shipped default enum (0 = the natural-sky arm).
  const preFixGlslRamp = rhsOf(mutatedGlsl, "float nightAlpha =");
  const preFixWgslRamp = rhsOf(mutatedWgsl, "var nightAlpha =");
  assert.match(preFixGlslRamp, /\?/);
  assert.match(preFixWgslRamp, /select\(/);

  const geometry = {
    shellPoint: target.shellPoint,
    lightDir: controlSunDir,
    eyeHeight: SITE_HEIGHT,
    colorB: 0.0,
  };
  const rampEnv = {
    positionWC: vec(target.shellPoint),
    lightDirection: vec(controlSunDir),
    skyPoint: vec(target.shellPoint),
    lightDirWC: vec(controlSunDir),
    u_radiiAndDynamicAtmosphereColor: { z: 0 },
    u: { radiiAndDynamicAtmosphere: { z: 0 } },
    isDynamic: false,
    __functions: EXTRA,
  };
  // The whole mechanism in two measured numbers: the pre-fix ramp answers 1.0
  // at the shipped default no matter where the Sun is, the shipped ramp answers
  // 0 at the same geometry, on both dialects.
  assert.equal(run(preFixGlslRamp, rampEnv), 1.0);
  assert.equal(run(preFixWgslRamp, rampEnv), 1.0);
  assert.equal(run(GLSL_NIGHT_ALPHA, rampEnv), 0.0);
  assert.equal(run(WGSL_NIGHT_ALPHA, rampEnv), 0.0);

  const alpha = glslShellAlpha({
    ...geometry,
    nightAlphaExpression: preFixGlslRamp,
    enumValue: 0,
  });
  const wgslAlpha = wgslShellAlpha({
    ...geometry,
    nightAlphaExpression: preFixWgslRamp,
    enumValue: 0,
  });
  assert.ok(
    Math.abs(alpha - wgslAlpha) < 1e-12,
    "both pre-fix dialects must erase the star identically",
  );
  assert.ok(
    alpha > 0.99,
    `the pre-fix shell alpha must be near-opaque; got ${alpha}`,
  );

  const peak = targetStarPeak();
  const survived = LUMA({
    r: peak.r * (1 - alpha),
    g: peak.g * (1 - alpha),
    b: peak.b * (1 - alpha),
  });
  assert.equal(
    Math.round(survived),
    0,
    `the pre-fix shell must erase the star; got ${survived.toFixed(4)}`,
  );
  // And the bound is not specific to this star: nothing survives it.
  const saturated = LUMA({ r: 255, g: 255, b: 255 }) * (1 - alpha);
  assert.ok(
    saturated * 3 < 24,
    "under the pre-fix shell even a saturated star cannot clear the probe's " +
      `added-pixel bar: sum ${(saturated * 3).toFixed(2)}`,
  );
});

// ══════════════════════ 2. the control that must not move ═══════════════════

test("CONTROL: the faint-anchor exposure is untouched by this change", () => {
  // The star exposure law lives in a different file and the fix must not have
  // moved it: a vmag 3.6 star still peaks at the documented 15.3/255 through
  // the shipped instance builder and the shipped PSF peak, with no atmosphere
  // and no reveal dimming.
  const instances = buildStarInstanceData();
  const kHalo = Number(
    /const float STAR_PSF_K_HALO = ([0-9.]+);/.exec(
      read("packages/engine/Source/Shaders/StarFieldFS.glsl"),
    )[1],
  );
  let closest = null;
  for (let i = 0; i < BrightStarCatalog.count; i++) {
    const vmag = BrightStarCatalog.data[i * BrightStarCatalog.STRIDE + 2];
    if (closest === null || Math.abs(vmag - 3.6) < Math.abs(closest.vmag - 3.6))
      closest = { i, vmag };
  }
  assert.equal(closest.vmag, 3.6, "the catalogue carries the anchor magnitude");
  const flux = instances[closest.i * FLOATS_PER_STAR + 3];
  const peak = flux * (1.0 + kHalo) * 255.0;
  assert.ok(
    Math.abs(peak - 15.3) < 0.1,
    `faint-anchor peak drifted to ${peak.toFixed(3)}/255`,
  );
});

test("CONTROL: an overhead Sun leaves the shell alpha where it was", () => {
  // The day the ramp must not disturb. With the Sun at the local zenith the
  // ramp's dot is 1, so the alpha is the altitude ramp alone — exactly the
  // pre-fix value.
  const zenith = Cartesian3.normalize(cameraPos, new Cartesian3());
  const shellPoint = Cartesian3.multiplyByScalar(
    zenith,
    Ellipsoid.WGS84.maximumRadius + ATMOSPHERE_THICKNESS,
    new Cartesian3(),
  );
  const alpha = glslShellAlpha({
    shellPoint,
    lightDir: zenith,
    eyeHeight: SITE_HEIGHT,
    colorB: 0.9,
  });
  const preFix =
    0.9 +
    (1 - 0.9) * ((ATMOSPHERE_THICKNESS - SITE_HEIGHT) / ATMOSPHERE_THICKNESS);
  assert.ok(
    Math.abs(alpha - preFix) < 1e-9,
    `overhead-Sun alpha moved: ${alpha} vs ${preFix}`,
  );
});

test("CONTROL: the lit-from-above mode keeps its permanent-day opacity", () => {
  // The compatibility arm. Its light direction IS the normalized shell point,
  // so the ramp is inert and the alpha equals the pre-fix value everywhere.
  const preFix = (ATMOSPHERE_THICKNESS - SITE_HEIGHT) / ATMOSPHERE_THICKNESS;
  for (const [x, y, z] of [
    [1, 0, 0],
    [0.3, -0.9, 0.31],
    [-0.5, 0.5, 0.707],
    [0, 0, -1],
  ]) {
    const dir = Cartesian3.normalize(new Cartesian3(x, y, z), new Cartesian3());
    const shellPoint = Cartesian3.multiplyByScalar(
      dir,
      Ellipsoid.WGS84.maximumRadius + ATMOSPHERE_THICKNESS,
      new Cartesian3(),
    );
    const alpha = glslShellAlpha({
      shellPoint,
      lightDir: dir,
      eyeHeight: SITE_HEIGHT,
      colorB: 0.0,
    });
    assert.ok(
      Math.abs(alpha - preFix) < 1e-9,
      `lit-from-above alpha moved at (${x}, ${y}, ${z}): ${alpha}`,
    );
  }
});

// ═══════════════════════════ 3. backend parity ══════════════════════════════

test("PARITY: both dialects' ramps agree, executed from their own sources", () => {
  // Not a text comparison: each dialect's own expression is evaluated by the
  // shared reader over the same geometry grid.
  const innerRadius = Ellipsoid.WGS84.maximumRadius;
  let samples = 0;
  for (let elevationDeg = -40; elevationDeg <= 90; elevationDeg += 5) {
    for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 45) {
      const el = CesiumMath.toRadians(elevationDeg);
      const az = CesiumMath.toRadians(azimuthDeg);
      const lightDir = Cartesian3.normalize(
        new Cartesian3(
          Math.cos(el) * Math.cos(az),
          Math.cos(el) * Math.sin(az),
          Math.sin(el),
        ),
        new Cartesian3(),
      );
      const shellPoint = new Cartesian3(
        0.0,
        0.0,
        innerRadius + ATMOSPHERE_THICKNESS,
      );
      for (const eyeHeight of [0, 500, 20000, 60000, 200000]) {
        for (const colorB of [0.0, 0.35, 0.9]) {
          const a = glslShellAlpha({
            shellPoint,
            lightDir,
            eyeHeight,
            colorB,
          });
          const b = wgslShellAlpha({
            shellPoint,
            lightDir,
            eyeHeight,
            colorB,
          });
          assert.ok(
            Math.abs(a - b) < 1e-12,
            `dialects disagree at el ${elevationDeg} az ${azimuthDeg} ` +
              `h ${eyeHeight} b ${colorB}: ${a} vs ${b}`,
          );
          samples += 1;
        }
      }
    }
  }
  assert.ok(samples > 500, `parity grid was too small: ${samples}`);
});

test("PARITY MUTATION: a divergent WGSL ramp is caught by the same grid", () => {
  // Proves the parity test has teeth: perturb the WGSL expression text and the
  // evaluated grid must separate the two dialects.
  const divergent = WGSL_NIGHT_ALPHA.replace("0.0, 1.0", "0.25, 1.0");
  assert.notEqual(divergent, WGSL_NIGHT_ALPHA, "the mutation must apply");
  const innerRadius = Ellipsoid.WGS84.maximumRadius;
  const shellPoint = new Cartesian3(
    0.0,
    0.0,
    innerRadius + ATMOSPHERE_THICKNESS,
  );
  const lightDir = new Cartesian3(0.0, 0.0, -1.0);
  const env = {
    skyPoint: vec(shellPoint),
    lightDirWC: vec(lightDir),
    // Bound so this test reports a measured value rather than an unbound
    // identifier if the shipped ramp is ever reverted to the enum-gated form.
    u: { radiiAndDynamicAtmosphere: { z: 0 } },
    isDynamic: false,
    __functions: EXTRA,
  };
  const shipped = run(WGSL_NIGHT_ALPHA, env);
  const mutant = run(divergent, env);
  assert.notEqual(shipped, mutant);
  assert.equal(
    shipped,
    0.0,
    `the shipped WGSL ramp must close with the light behind the shell point; ` +
      `got ${shipped}`,
  );
});

// ══════════════ 4. the probe's repaired reachability control ════════════════
//
// The probe itself cannot run here (it launches a browser at module load), so
// the claim it makes is unit-tested through the shared module both import.

const STAR_CENSUS_REL =
  "Tools/visual-regression/lib/star-contribution-census.mjs";

const {
  DIFFERENCE_CENSUS_OPTIONS,
  STAR_AIM_TOLERANCE_PX,
  STAR_PEAK_LUMA_AT_CONTROL_ELEVATION,
  STAR_REACHABILITY_RESIDUAL_FRACTION,
  QUANTIZATION_HALF_CODE,
  STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR,
  deriveStarReachabilityFloor,
  isStarReachable,
  censusAtTarget,
  censusAtTargetDifference,
} = await import("./lib/star-contribution-census.mjs");

/**
 * Synthetic 81x81 RGBA box with an optional Gaussian source at the centre over
 * a flat background.
 *
 * @param {number} background Flat background luma, 0..255.
 * @param {number} amplitude Source peak above the background, 0..255.
 * @returns {object} Box in the shape the census consumes.
 */
function syntheticBox(background, amplitude) {
  const half = 40;
  const w = 2 * half + 1;
  const h = w;
  const data = new Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - half, y - half);
      const v = background + amplitude * Math.exp(-(r * r) / (2 * 0.6 * 0.6));
      const i = 4 * (y * w + x);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return { data, w, h, centerX: half, centerY: half };
}

test("PROBE CONTROL: the difference census resolves the 21-luma target", () => {
  // The magnitude the shipped chain actually delivers for this framing. The
  // absolute-frame census must NOT resolve it — that is the property that made
  // the old control unsatisfiable — and the difference census must.
  const on = syntheticBox(0, 21);
  const off = syntheticBox(0, 0);
  const absolute = censusAtTarget(on);
  assert.equal(
    absolute.resolvedAtTarget,
    false,
    "a 21-luma star must stay below the absolute-frame floor, or this " +
      "control's whole premise is wrong",
  );
  const difference = censusAtTargetDifference(on, off);
  assert.equal(difference.available, true);
  assert.equal(difference.count, 1);
  assert.equal(difference.resolvedAtTarget, true);
  assert.ok(difference.nearestPx <= STAR_AIM_TOLERANCE_PX);
});

test("PROBE CONTROL: the shell composite is what the difference census sees", () => {
  // The pre-fix frame: the same star, attenuated by the opaque shell. The
  // difference census must go to zero — it is a measurement, not a rubber stamp.
  const alpha = (ATMOSPHERE_THICKNESS - SITE_HEIGHT) / ATMOSPHERE_THICKNESS;
  const on = syntheticBox(0, 21 * (1 - alpha));
  const off = syntheticBox(0, 0);
  const difference = censusAtTargetDifference(on, off);
  assert.equal(difference.count, 0, "an erased star must not resolve");
  assert.equal(difference.resolvedAtTarget, false);
});

test("PROBE CONTROL: a bright cube map cancels out of the difference", () => {
  // The job the absolute floor of 40 was doing is done by construction here:
  // a diffuse background well above that floor is identical in both frames.
  const on = syntheticBox(30, 21);
  const off = syntheticBox(30, 0);
  const difference = censusAtTargetDifference(on, off);
  assert.equal(difference.count, 1);
  assert.equal(difference.resolvedAtTarget, true);
  assert.ok(
    difference.peakMax < 22,
    `the background must cancel; difference peak ${difference.peakMax}`,
  );
});

test("PROBE CONTROL: mismatched or missing boxes are unavailable, not green", () => {
  assert.equal(
    censusAtTargetDifference(null, syntheticBox(0, 21)).available,
    false,
  );
  assert.equal(
    censusAtTargetDifference(syntheticBox(0, 21), null).available,
    false,
  );
  const small = syntheticBox(0, 21);
  assert.equal(
    censusAtTargetDifference(small, { ...small, w: small.w - 1 }).available,
    false,
  );
  // And the zero bar is a bar, not an absence of one.
  assert.equal(DIFFERENCE_CENSUS_OPTIONS.minPeak, 1);
  assert.equal(DIFFERENCE_CENSUS_OPTIONS.minContrast, 1);
});

test("PROBE CONTROL: the probe consumes the shared module, not a private copy", () => {
  const probe = read("Tools/visual-regression/probe-sky-twilight-range.mjs");
  assert.match(probe, /from "\.\/lib\/star-contribution-census\.mjs"/);
  assert.match(
    probe,
    /censusAtTargetDifference\(gl\.controlBox, gl\.controlBoxOff\)/,
  );
  assert.match(
    probe,
    /censusAtTargetDifference\(gpu\.controlBox, gpu\.controlBoxOff\)/,
  );
  assert.ok(
    !/function censusAtTargetDifference/.test(probe),
    "the probe must not carry its own copy of the detector wrapper",
  );
});

// ═════════ 4b. Q-115: the STAR REACHABILITY differencePeak floor ════════════
//
// The old reachability path had no floor of its own on `differencePeak`; an
// executor graded it by eye against "8", reverse-engineered from the probe's
// unrelated whole-frame `addedPixels()` metric. This section unit-tests the
// REPLACEMENT floor's arithmetic, its rejection of the pre-fix measurement,
// its acceptance (with margin) of the post-fix measurement, and — via a
// MUTATION — that removing the peak check from the gate is something these
// tests would actually catch.

test("Q-115: the derived floor matches the framing's own documented arithmetic", () => {
  // Recomputed independently of the module's own expression so this is a
  // real check on the FORMULA, not a restatement of it.
  assert.equal(STAR_PEAK_LUMA_AT_CONTROL_ELEVATION, 21.2);
  assert.equal(STAR_REACHABILITY_RESIDUAL_FRACTION, 0.14);
  assert.equal(QUANTIZATION_HALF_CODE, 0.5);
  const expected = 21.2 * 0.14 - 0.5;
  assert.ok(
    Math.abs(deriveStarReachabilityFloor() - expected) < 1e-9,
    `derived floor ${deriveStarReachabilityFloor()} != independently computed ${expected}`,
  );
  assert.ok(
    Math.abs(STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR - expected) < 1e-9,
    "the precomputed export must match the same defaults",
  );
});

// B2 (station-3 review, pass 1) — the residual fraction is a DECLARED SAFETY
// FACTOR under the single banked render observation, never derived from it
// and never pinned to a specific gap from it. An earlier version of this
// floor re-applied the framing's own extinction ratio under a second name
// (`RENDER_TIME_RESIDUAL_FACTOR = 1/3`) — extinction is already inside
// `STAR_PEAK_LUMA_AT_CONTROL_ELEVATION` (the computed ratio at this
// elevation is 0.41544, from the shipped `computeAtmosphereExtinction` +
// `StarFieldVS.glsl` airmass law, re-run below) — and at that CORRECT ratio
// the floor would have been 7.31, which the tranche's own banked
// `differencePeak` of 6.07 FAILS. The `Math.abs(floor - 6) < 0.5` and
// `margin > 0.3` assertions this test replaces pinned the row's own "close
// to 6" instruction and the tranche's own single measurement in place as
// contract — the exact Principle-10 trap this review found.
test("Q-115 (B2): the residual fraction is materially below the single banked observation, and the floor has headroom by construction", () => {
  const spacePeakLuma = 51.023; // analytic PSF peak with NO extinction applied
  const computedExtinctionRatio = 21.1969 / spacePeakLuma;
  assert.ok(
    Math.abs(computedExtinctionRatio - 0.41544) < 1e-3,
    `computed extinction ratio drifted: ${computedExtinctionRatio}`,
  );
  // The floor a WRONG re-application of that computed ratio would give —
  // proof, not assertion, that the honest arithmetic fails the single banked
  // measurement it must admit, which is why this floor is a stated safety
  // factor instead.
  const wrongDoubleExtinctionFloor = 21.1969 * computedExtinctionRatio - 1.5;
  assert.ok(
    wrongDoubleExtinctionFloor > 6.07,
    `expected the double-extinction floor (${wrongDoubleExtinctionFloor.toFixed(2)}) ` +
      "to exceed the banked measurement (6.07) — if it does not, the case " +
      "for treating the residual as a safety factor rather than physics " +
      "no longer holds and this test itself needs review",
  );

  const bankedObservationFraction = 6.07 / 21.1969;
  assert.ok(
    Math.abs(bankedObservationFraction - 0.2864) < 1e-3,
    `banked observation fraction drifted: ${bankedObservationFraction}`,
  );
  assert.ok(
    STAR_REACHABILITY_RESIDUAL_FRACTION < bankedObservationFraction,
    `the residual fraction (${STAR_REACHABILITY_RESIDUAL_FRACTION}) must sit ` +
      "materially below the single banked observation " +
      `(${bankedObservationFraction.toFixed(4)}), or a correct fix with ` +
      "different antialiasing could false-fail exactly as the pre-review " +
      "1/3 value would have",
  );

  // Headroom by construction: the floor sits at or below HALF the single
  // banked observation, so it cannot be a fit to that observation and has
  // room to admit a correct fix whose residual differs materially from it.
  assert.ok(
    STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR <= 6.07 / 2,
    `floor ${STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR} must sit at or below ` +
      "half the single banked observation (6.07)",
  );
});

test("Q-115: explicit inputs override every term independently", () => {
  assert.equal(
    deriveStarReachabilityFloor({
      starPeakLuma: 30,
      residualFraction: 0.5,
      quantizationHalfCode: 1,
    }),
    30 * 0.5 - 1,
  );
  assert.equal(
    deriveStarReachabilityFloor({ starPeakLuma: 0 }),
    0 * STAR_REACHABILITY_RESIDUAL_FRACTION - QUANTIZATION_HALF_CODE,
  );
});

test("Q-115: tranche 3e-C's PRE-FIX differencePeak (0.0) fails the gate", () => {
  // The exact shape `censusAtTargetDifference` returns for a fully-erased
  // star: a flat, identical stars-on/stars-off pair at the target position.
  const erased = censusAtTargetDifference(
    syntheticBox(0, 0),
    syntheticBox(0, 0),
  );
  assert.equal(erased.available, true);
  assert.equal(erased.peakMax, 0, "pre-fix differencePeak must be 0.0");
  assert.equal(erased.resolvedAtTarget, false);
  assert.equal(
    isStarReachable(erased),
    false,
    "a zeroed star must not clear the reachability gate",
  );
  // And directly against the packet's own reported shape, in case the census
  // geometry ever changes what an erased box looks like.
  assert.equal(
    isStarReachable({ available: true, resolvedAtTarget: false, peakMax: 0.0 }),
    false,
  );
});

// B2 (station-3 review) — the pre-fix state is not the only "star not really
// there" case worth checking: the MODELLED shell composite (the same
// computation "PROBE CONTROL: the shell composite is what the difference
// census sees" above exercises — the fully-erased star's actual surviving
// luma under the pre-fix shell alpha, ~0.095, not a clean 0.0) must also fail
// the gate. Reusing that test's own formula rather than a fresh literal.
test("Q-115 (B2): the modelled shell-composite residual (~0.095) also fails the gate", () => {
  const alpha = (ATMOSPHERE_THICKNESS - SITE_HEIGHT) / ATMOSPHERE_THICKNESS;
  const modelledResidual = STAR_PEAK_LUMA_AT_CONTROL_ELEVATION * (1 - alpha);
  assert.ok(
    Math.abs(modelledResidual - 0.0946) < 1e-3,
    `modelled shell-composite residual drifted: ${modelledResidual}`,
  );
  assert.ok(
    modelledResidual < STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR,
    `the modelled residual (${modelledResidual.toFixed(4)}) must sit below ` +
      `the floor (${STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR})`,
  );
  const on = syntheticBox(0, modelledResidual);
  const off = syntheticBox(0, 0);
  const composite = censusAtTargetDifference(on, off);
  assert.equal(
    isStarReachable(composite),
    false,
    "the modelled shell-composite residual must not clear the reachability gate",
  );
});

test("Q-115: tranche 3e-C's POST-FIX differencePeak (6.07) clears the gate", () => {
  assert.equal(
    isStarReachable({
      available: true,
      resolvedAtTarget: true,
      peakMax: 6.07,
    }),
    true,
  );
  // Headroom by construction (see the B2 test above), not a fitted gap to
  // this one measurement — `assert.ok(margin > 0.3)` is exactly the trap the
  // station-3 review found: it pinned the tranche's own single observation
  // in place as contract.
  assert.ok(STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR <= 6.07 / 2);
});

test("Q-115: a positionally-resolved but dim source is REJECTED by the new peak floor", () => {
  // Distinguishes the NEW check from the OLD `resolvedAtTarget`-only gate: a
  // synthetic star bright enough to register as a resolved point source
  // (amplitude 2 clears the census's own minPeak of 1) but below the B2 floor
  // (2.468) must still fail reachability.
  const dim = censusAtTargetDifference(syntheticBox(0, 2), syntheticBox(0, 0));
  assert.equal(dim.resolvedAtTarget, true, "amplitude 2 must still resolve");
  assert.ok(dim.peakMax < STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR);
  assert.equal(isStarReachable(dim), false);

  const bright = censusAtTargetDifference(
    syntheticBox(0, 21),
    syntheticBox(0, 0),
  );
  assert.ok(bright.peakMax >= STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR);
  assert.equal(isStarReachable(bright), true);
});

test("Q-115: an unavailable or unresolved census is rejected regardless of peak", () => {
  assert.equal(
    isStarReachable({ available: false, resolvedAtTarget: true, peakMax: 999 }),
    false,
  );
  assert.equal(
    isStarReachable({ available: true, resolvedAtTarget: false, peakMax: 999 }),
    false,
  );
  assert.equal(isStarReachable(null), false);
});

/**
 * Import a MUTATED copy of `star-contribution-census.mjs` from a temp dir.
 * The module's own relative import of the shared detector is rewritten to an
 * absolute `file://` URL so the mutant still resolves it from its temp
 * location; the detector itself is untouched.
 *
 * @param {(src: string) => string} mutate Source transform.
 * @param {string} label Description for the vacuity guard.
 * @returns {Promise<object>} The mutant module namespace.
 */
async function importMutatedStarCensus(mutate, label) {
  const file = path.join(root, STAR_CENSUS_REL);
  const original = (await readFile(file, "utf8")).split("\r\n").join("\n");
  const detectorUrl = pathToFileURL(
    path.join(root, "Tools/skybox-bake/starmap-census.mjs"),
  ).href;
  const rehomed = original.replace(
    '"../../skybox-bake/starmap-census.mjs"',
    JSON.stringify(detectorUrl),
  );
  assert.notEqual(
    rehomed,
    original,
    "the import rehoming did not apply — its target text has moved",
  );
  const mutated = mutate(rehomed);
  assert.notEqual(
    mutated,
    rehomed,
    `the ${label} mutation did not change ${STAR_CENSUS_REL} — its target ` +
      "text has moved, so this MUTATION test would pass vacuously",
  );
  const dir = await mkdtemp(path.join(tmpdir(), "cesium-star-reach-"));
  const out = path.join(dir, "MutantStarCensus.mjs");
  await writeFile(out, mutated, "utf8");
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Q-115 MUTATION: dropping the peak-floor clause readmits the erased star", async () => {
  const mutant = await importMutatedStarCensus(
    (src) =>
      src.replace(
        "Number.isFinite(census.peakMax) &&\n    census.peakMax >= floor",
        "true",
      ),
    "peak-floor removal",
  );
  const dim = mutant.censusAtTargetDifference(
    syntheticBox(0, 3),
    syntheticBox(0, 0),
  );
  // Under the shipped code this is REJECTED (previous test). Under the
  // mutant, with the peak clause gone, it is wrongly accepted — proving the
  // clause this suite exercises is load-bearing.
  assert.equal(
    mutant.isStarReachable(dim),
    true,
    "the mutant must readmit the dim source once the peak floor is removed",
  );
});

test("Q-115: the probe imports the shared floor/gate, not private copies", () => {
  const probe = read("Tools/visual-regression/probe-sky-twilight-range.mjs");
  assert.match(probe, /STAR_REACHABILITY_DIFFERENCE_PEAK_FLOOR/);
  assert.match(probe, /isStarReachable/);
  assert.match(
    probe,
    /const starsVisible = isStarReachable\(glCensus\) && isStarReachable\(gpuCensus\);/,
  );
  assert.ok(
    !/function isStarReachable/.test(probe),
    "the probe must not carry its own copy of the reachability gate",
  );
  // The old ad hoc floor path (whole-frame addedPixels() feeding starsVisible)
  // must be gone from the reachability gate itself.
  assert.ok(
    !/starsVisible =[\s\S]{0,400}glStars\[0\] > 0/.test(probe),
    "starsVisible must no longer read the whole-frame addedPixels() metric",
  );
});

// ════════ 5. the WGSL-only moon term the ramp makes reachable ═══════════════

test("the moon term does not divide the backends at the control lane", () => {
  // The WGSL ramp carries an extra `max(nightAlpha, cos(moonZenith) * phase)`
  // that GLSL has no twin for. SCOPE, and it is narrower than it looks: that
  // term is guarded by `u.atmosControl.y`, which the renderer packs from
  // `SkyAtmosphere.dualLightInline`, constructed FALSE. So it is behind a
  // default-off opt-in and is not on the default path either before or after
  // the ramp change — this test does not model the gate and neither does the
  // lane's moon script, so read both as "what the divergence would be if an
  // application opted in", never as a default-path claim.
  //
  // What the test does gate is the control lane's own precondition: with the
  // moon below the horizon the term is zero whatever the gate says, so
  // "the star survives on BOTH backends" holds unconditionally there. It is
  // below by ~5.8 degrees, and this asserts it before an Edge run is briefed.
  const moonInertial =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      controlInstant,
      new Cartesian3(),
    );
  const rotation =
    Transforms.computeIcrfToFixedMatrix(controlInstant) ??
    Transforms.computeTemeToPseudoFixedMatrix(controlInstant, new Matrix3());
  const moonFixed = Matrix3.multiplyByVector(
    rotation,
    moonInertial,
    new Cartesian3(),
  );
  const moonDir = Cartesian3.normalize(moonFixed, new Cartesian3());
  const cosMoonZenith = Cartesian3.dot(
    Cartesian3.normalize(target.shellPoint, new Cartesian3()),
    moonDir,
  );
  assert.ok(
    cosMoonZenith <= 0,
    `the moon is above the shell point at the control instant ` +
      `(cos ${cosMoonZenith.toFixed(4)}), so the WGSL-only moon term would ` +
      "raise WebGPU's shell alpha and the two backends would disagree",
  );
  // And with the moon down, both dialects resolve the same alpha there.
  const glsl = glslShellAlpha({
    shellPoint: target.shellPoint,
    lightDir: controlSunDir,
    eyeHeight: SITE_HEIGHT,
    colorB: 0.0,
  });
  const wgslNoMoon = wgslShellAlpha({
    shellPoint: target.shellPoint,
    lightDir: controlSunDir,
    eyeHeight: SITE_HEIGHT,
    colorB: 0.0,
  });
  assert.ok(Math.abs(glsl - wgslNoMoon) < 1e-12);
  assert.ok(glsl < 0.01, `control-lane shell alpha is ${glsl}`);
  // The gate this test does not model, pinned so the scope note above stays
  // true: the moon term is opt-in and off by default.
  assert.match(
    read("packages/engine/Source/Scene/SkyAtmosphere.js"),
    /this\.dualLightInline = false;/,
  );
  assert.match(
    read(
      "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    ),
    /uniformData\[101\] = dualLightInline \? 1\.0 : 0\.0;/,
  );
  assert.match(
    wgsl,
    /if \(u\.atmosControl\.y > 0\.5 && u\.moonControl\.x > 0\.001\) \{/,
  );
});
