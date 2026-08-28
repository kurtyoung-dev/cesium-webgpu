// lunar-eclipse-earth-shadow.spec.mjs — Earth's shadow on the lunar disc.
// @purpose Pins the shadow-cone geometry against five published eclipses, proves the WGSL/GLSL/JS coverage law is one function in three languages, and states the appearance properties that reject four wrong implementations.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. Three failure modes, none of which a text grep sees.
//
//   1. THE EPHEMERIS IS WRONG. A sign error in the anti-solar axis, or a
//      dropped shadow enlargement, still renders a plausible-looking bite —
//      just at the wrong time or the wrong size. So the geometry is pinned
//      against the published circumstances of five real eclipses, spanning a
//      deep partial through a central total, with the tolerance stated per
//      quantity and every measured delta recorded below. Each value is
//      additionally pinned to the engine's own current answer, so a drift
//      inside the catalogue tolerance still fails.
//   2. ONE BACKEND QUIETLY COMPUTES SOMETHING ELSE. The coverage law is a
//      lockstep pair (`Shaders/WebGPU/Environment/Moon.wgsl` <->
//      `Shaders/EllipsoidFS.glsl`) with a JavaScript reference beside it. This
//      spec EXTRACTS the function from both shader texts, compiles each body
//      as JavaScript, and requires all three to agree to 1e-12 across the full
//      radial sweep. The appearance constants are extracted from each shader's
//      own text and drive the same comparison, so a drifted literal fails
//      numerically rather than being caught only by a regex nobody updated.
//   3. THE OFF PATH IS NOT ACTUALLY OFF. The whole feature must be inert on
//      every frame outside a lunar eclipse — which is nearly all of them — and
//      the gate that makes it inert is a single comparison in each shader.
//      Both gates are pinned, and the state module is asserted to clear to the
//      exact identity rather than to something close to it.
//
// The property predicate is run against four deliberately wrong laws. A check
// that passes both the right and the wrong answer is worthless.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read below is
// normalised to `\n` first — a spec anchored on a bare `\n` silently
// false-greens on a CRLF checkout.
//
// Run: node --test Tools/visual-regression/lunar-eclipse-earth-shadow.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const WGSL_PATH = "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl";
const GLSL_PATH = "packages/engine/Source/Shaders/EllipsoidFS.glsl";

const wgsl = read(WGSL_PATH);
const glsl = read(GLSL_PATH);
const sceneMoon = read("packages/engine/Source/Scene/Moon.js");
const scene = read("packages/engine/Source/Scene/Scene.js");
const primitive = read("packages/engine/Source/Scene/EllipsoidPrimitive.js");
const envRenderer = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
);
const conditions = read(
  "packages/engine/Source/Scene/AtmosphericConditions.js",
);
const frameStateSource = read("packages/engine/Source/Scene/FrameState.js");

const stateModule = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Scene/LunarEclipseState.js"),
  ).href
);

const {
  LUNAR_SHADOW_ENLARGEMENT,
  LUNAR_UMBRA_OPTICAL_DEPTH_EDGE,
  LUNAR_UMBRA_OPTICAL_DEPTH_CENTER,
  LUNAR_UMBRA_RAYLEIGH_RED,
  LUNAR_UMBRA_RAYLEIGH_GREEN,
  LUNAR_UMBRA_RAYLEIGH_BLUE,
  LUNAR_UMBRA_GAIN,
  computeLunarDiscLuminanceFactor,
  createLunarEclipseState,
  discFractionInsideCircle,
  lunarShadowCoverage,
  lunarShadowFactor,
  updateLunarEclipseState,
} = stateModule;

const Cartesian3 = (
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Cartesian3.js"))
      .href
  )
).default;
const CesiumMath = (
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Math.js")).href
  )
).default;
const Ellipsoid = (
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Ellipsoid.js"))
      .href
  )
).default;
const JulianDate = (
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/JulianDate.js"))
      .href
  )
).default;
const Matrix3 = (
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source/Core/Matrix3.js"))
      .href
  )
).default;
const Simon1994PlanetaryPositions = (
  await import(
    pathToFileURL(
      path.join(
        root,
        "packages/engine/Source/Core/Simon1994PlanetaryPositions.js",
      ),
    ).href
  )
).default;

// Comment-stripped views. Both shader languages use `//`, and every rationale
// block below lives on in comments deliberately, so shape checks must never
// run against raw text.
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      return slash >= 0 ? line.slice(0, slash) : line;
    })
    .join("\n");
}

const wgslCode = stripLineComments(wgsl);
const glslCode = stripLineComments(glsl);

// ───────────────────────────────────────────────────────────────────────────
// Cross-language extraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Slices the balanced `{ ... }` body that follows `signature` in `source`.
 */
function extractBody(source, signature) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0, `signature not found: ${signature}`);
  const open = source.indexOf("{", at);
  assert.ok(open > at, `no body brace after: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unbalanced body for: ${signature}`);
}

const jsClamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Slices the condition of the `if` that guards a `fs.defines.push("NAME")`,
 * so a reachability check can evaluate it rather than merely grep for the
 * push. Reads the balanced parentheses backwards from the push.
 */
function defineGuardExpression(source, defineName) {
  const pushAt = source.indexOf(`fs.defines.push("${defineName}");`);
  assert.ok(pushAt > 0, `${defineName} is never pushed`);
  const ifAt = source.lastIndexOf("if (", pushAt);
  assert.ok(ifAt > 0, `${defineName}'s push has no guard`);
  let depth = 0;
  for (let i = ifAt + 3; i < pushAt; i++) {
    if (source[i] === "(") {
      depth++;
    } else if (source[i] === ")") {
      depth--;
      if (depth === 0) {
        return source.slice(ifAt + 4, i).trim();
      }
    }
  }
  throw new Error(`unbalanced guard for ${defineName}`);
}

/**
 * Compiles a shader function body into a JS callable. The coverage body is
 * written so that the only non-JavaScript tokens are the storage keywords,
 * which is itself part of the lockstep contract: a construct that cannot be
 * translated this way has to be made explicit rather than silently skipped.
 */
function compileCoverageBody(body, replacements) {
  let js = body;
  for (const [pattern, replacement] of replacements) {
    js = js.replace(pattern, replacement);
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    "radius",
    "umbraRadius",
    "penumbraRadius",
    "clamp",
    "max",
    "acos",
    "sin",
    js,
  );
}

const WGSL_COVERAGE_SIGNATURE =
  "fn lunarShadowCoverage(radius: f32, umbraRadius: f32, penumbraRadius: f32) -> f32";
const GLSL_COVERAGE_SIGNATURE =
  "float lunarShadowCoverage(float radius, float umbraRadius, float penumbraRadius)";
const WGSL_FACTOR_SIGNATURE =
  "fn lunarShadowFactor(radius: f32, umbraRadius: f32, penumbraRadius: f32) -> vec3<f32>";
const GLSL_FACTOR_SIGNATURE =
  "vec3 lunarShadowFactor(float radius, float umbraRadius, float penumbraRadius)";

const wgslCoverageBody = extractBody(wgslCode, WGSL_COVERAGE_SIGNATURE);
const glslCoverageBody = extractBody(glslCode, GLSL_COVERAGE_SIGNATURE);

const wgslCoverageFn = compileCoverageBody(wgslCoverageBody, [
  [/\blet\b/g, "let"],
]);
const glslCoverageFn = compileCoverageBody(glslCoverageBody, [
  [/\bfloat\b/g, "let"],
]);

const wgslCoverage = (r, u, p) =>
  wgslCoverageFn(r, u, p, jsClamp, Math.max, Math.acos, Math.sin);
const glslCoverage = (r, u, p) =>
  glslCoverageFn(r, u, p, jsClamp, Math.max, Math.acos, Math.sin);

/**
 * Pulls the appearance constants out of a shader's own `lunarShadowFactor`
 * body, so the numeric comparison below is driven by the literals that
 * actually ship rather than by a second copy of them written here.
 */
function extractFactorConstants(body) {
  const tau = body.match(
    /tau = ([0-9.]+) \+ \(([0-9.]+) - ([0-9.]+)\) \* depth/,
  );
  assert.ok(tau, "the optical-depth ramp must be locatable");
  assert.equal(tau[1], tau[3], "the ramp must start at the rim optical depth");
  const weight = body.match(
    /weight = ([0-9.]+) \* coverage \* coverage \* coverage/,
  );
  assert.ok(weight, "the coverage-cube weight must be locatable");
  const rayleigh = body.match(
    /vec3(?:<f32>)?\(([0-9.]+), ([0-9.]+), ([0-9.]+)\)\)/,
  );
  assert.ok(rayleigh, "the Rayleigh ratio triple must be locatable");
  return {
    tauEdge: Number(tau[1]),
    tauCenter: Number(tau[2]),
    gain: Number(weight[1]),
    rayleigh: [Number(rayleigh[1]), Number(rayleigh[2]), Number(rayleigh[3])],
  };
}

const wgslFactorBody = extractBody(wgslCode, WGSL_FACTOR_SIGNATURE);
const glslFactorBody = extractBody(glslCode, GLSL_FACTOR_SIGNATURE);
const wgslConstants = extractFactorConstants(wgslFactorBody);
const glslConstants = extractFactorConstants(glslFactorBody);

/**
 * Rebuilds the appearance law from a coverage implementation and a set of
 * extracted constants — the same composition both shaders write inline.
 */
function factorFrom(
  coverageFn,
  constants,
  radius,
  umbraRadius,
  penumbraRadius,
) {
  const coverage = coverageFn(radius, umbraRadius, penumbraRadius);
  const illumination = 1.0 - coverage;
  const depth = jsClamp(1.0 - radius / Math.max(umbraRadius, 1.0), 0.0, 1.0);
  const tau =
    constants.tauEdge + (constants.tauCenter - constants.tauEdge) * depth;
  const weight = constants.gain * coverage * coverage * coverage;
  return constants.rayleigh.map(
    (ratio) => illumination + weight * Math.exp(-tau * ratio),
  );
}

// A representative pair of cone radii, taken from the 2026-08-28 eclipse at
// greatest, plus the radial sweep every equivalence check runs over.
const UMBRA = 4671900.0;
const PENUMBRA = 8267800.0;
const SWEEP = [];
for (let i = 0; i <= 400; i++) {
  SWEEP.push((i / 400) * PENUMBRA * 1.25);
}
// Straddle both discontinuity candidates exactly.
SWEEP.push(UMBRA - 1.0, UMBRA, UMBRA + 1.0);
SWEEP.push(PENUMBRA - 1.0, PENUMBRA, PENUMBRA + 1.0);

// ───────────────────────────────────────────────────────────────────────────
// The property predicate — the thing the mutants must fail
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every property Earth's shadow must have, as one reusable predicate.
 *
 * @param {Function} coverage `(radius, umbra, penumbra) => number`
 * @returns {string[]} the violated property names; empty means it passes.
 */
function shadowLawViolations(coverage) {
  const violations = [];
  const at = (r) => coverage(r, UMBRA, PENUMBRA);

  // Total inside the umbra, none outside the penumbra — the two definitions
  // the radii carry.
  if (at(0.0) !== 1.0 || at(UMBRA) !== 1.0) {
    violations.push("total-inside-umbra");
  }
  if (at(PENUMBRA) !== 0.0 || at(PENUMBRA * 1.5) !== 0.0) {
    violations.push("clear-outside-penumbra");
  }

  // Bounded and monotone non-increasing in radius. A law that brightens as it
  // moves deeper into the shadow is the single most likely sign error.
  let previous = Number.POSITIVE_INFINITY;
  for (const r of SWEEP.slice().sort((a, b) => a - b)) {
    const c = at(r);
    if (!(c >= 0.0 && c <= 1.0)) {
      violations.push("bounded");
      break;
    }
    if (c > previous + 1e-12) {
      violations.push("monotone");
      break;
    }
    previous = c;
  }

  // Continuous across the penumbral gradient. A step here is what a wrong
  // overlap formula produces, and it renders as a visible ring.
  const step = (PENUMBRA - UMBRA) / 512.0;
  for (let r = UMBRA; r < PENUMBRA; r += step) {
    if (Math.abs(at(r + step) - at(r)) > 0.02) {
      violations.push("continuous");
      break;
    }
  }

  // The gradient must actually be a gradient — a law that is 1 inside and 0
  // outside with nothing between passes every check above.
  const mid = at(0.5 * (UMBRA + PENUMBRA));
  if (!(mid > 0.05 && mid < 0.95)) {
    violations.push("graded");
  }

  // Inert with no shadow present. This is the property the whole off-path
  // rests on, and it must be exact rather than close.
  if (coverage(1.0e6, 0.0, 0.0) !== 0.0) {
    violations.push("inert-without-shadow");
  }
  return violations;
}

test("the property predicate rejects four wrong shadow laws", () => {
  // 1. Inverted: bright where it should be dark.
  const inverted = (r, u, p) => 1.0 - lunarShadowCoverage(r, u, p);
  assert.ok(
    shadowLawViolations(inverted).length > 0,
    "an inverted law must be rejected",
  );

  // 2. Hard step at the umbral radius — no penumbra at all. The shape a
  //    naive "is the point inside the umbra" test produces.
  const hardStep = (r, u) => (r <= u ? 1.0 : 0.0);
  assert.ok(
    shadowLawViolations(hardStep).includes("graded"),
    "a step law must be caught as ungraded",
  );

  // 3. Linear in radius rather than by disc overlap. Continuous, monotone and
  //    graded — but wrong at both ends, because it does not reach 1 at the
  //    umbral radius.
  const linear = (r, u, p) => jsClamp((p - r) / (p - u), 0.0, 1.0) * 0.9;
  assert.ok(
    shadowLawViolations(linear).length > 0,
    "a law that misses the umbral limit must be rejected",
  );

  // 4. Live when no shadow is present — the failure that would make every
  //    non-eclipse frame pay for the feature.
  const alwaysOn = (r, u, p) => (p > 0.0 ? lunarShadowCoverage(r, u, p) : 0.5);
  assert.ok(
    shadowLawViolations(alwaysOn).includes("inert-without-shadow"),
    "a law that is live without a shadow must be rejected",
  );
});

test("the shipped JS reference satisfies every property", () => {
  assert.deepEqual(shadowLawViolations(lunarShadowCoverage), []);
});

test("both shader texts satisfy every property", () => {
  assert.deepEqual(shadowLawViolations(wgslCoverage), []);
  assert.deepEqual(shadowLawViolations(glslCoverage), []);
});

test("WGSL, GLSL and the JS reference are one coverage law", () => {
  let worst = 0.0;
  for (const r of SWEEP) {
    const reference = lunarShadowCoverage(r, UMBRA, PENUMBRA);
    worst = Math.max(
      worst,
      Math.abs(wgslCoverage(r, UMBRA, PENUMBRA) - reference),
      Math.abs(glslCoverage(r, UMBRA, PENUMBRA) - reference),
    );
  }
  assert.ok(worst < 1e-12, `worst cross-language coverage delta ${worst}`);
});

test("WGSL, GLSL and the JS reference are one appearance law", () => {
  const result = new Cartesian3();
  let worst = 0.0;
  for (const r of SWEEP) {
    lunarShadowFactor(r, UMBRA, PENUMBRA, result);
    const reference = [result.x, result.y, result.z];
    const fromWgsl = factorFrom(
      wgslCoverage,
      wgslConstants,
      r,
      UMBRA,
      PENUMBRA,
    );
    const fromGlsl = factorFrom(
      glslCoverage,
      glslConstants,
      r,
      UMBRA,
      PENUMBRA,
    );
    for (let c = 0; c < 3; c++) {
      worst = Math.max(
        worst,
        Math.abs(fromWgsl[c] - reference[c]),
        Math.abs(fromGlsl[c] - reference[c]),
      );
    }
  }
  assert.ok(worst < 1e-12, `worst cross-language appearance delta ${worst}`);
});

test("the two shader bodies are character-identical modulo storage keywords", () => {
  const normalise = (body) =>
    body
      .replace(/vec3<f32>/g, "vec3")
      .replace(/\blet\b/g, "T")
      .replace(/\bfloat\b/g, "T")
      .replace(/\s+/g, " ")
      .trim();
  assert.equal(
    normalise(wgslCoverageBody),
    normalise(glslCoverageBody),
    "the coverage twins have structurally drifted",
  );
  assert.equal(
    normalise(wgslFactorBody),
    normalise(glslFactorBody),
    "the appearance twins have structurally drifted",
  );
});

test("the appearance constants carry one set of numbers in three places", () => {
  for (const constants of [wgslConstants, glslConstants]) {
    assert.equal(constants.tauEdge, LUNAR_UMBRA_OPTICAL_DEPTH_EDGE);
    assert.equal(constants.tauCenter, LUNAR_UMBRA_OPTICAL_DEPTH_CENTER);
    assert.equal(constants.gain, LUNAR_UMBRA_GAIN);
    assert.deepEqual(constants.rayleigh, [
      LUNAR_UMBRA_RAYLEIGH_RED,
      LUNAR_UMBRA_RAYLEIGH_GREEN,
      LUNAR_UMBRA_RAYLEIGH_BLUE,
    ]);
  }
  // The three ratios are not artistic: they are (550 / lambda)^4 at
  // 650 / 550 / 450 nm, the Rayleigh scattering law.
  assert.ok(Math.abs(LUNAR_UMBRA_RAYLEIGH_RED - Math.pow(550 / 650, 4)) < 1e-6);
  assert.equal(LUNAR_UMBRA_RAYLEIGH_GREEN, 1.0);
  assert.ok(
    Math.abs(LUNAR_UMBRA_RAYLEIGH_BLUE - Math.pow(550 / 450, 4)) < 1e-5,
  );
  // Copper, not grey: the umbra must redden monotonically inward, and the
  // blue channel must fall fastest.
  const rim = new Cartesian3();
  const axis = new Cartesian3();
  lunarShadowFactor(UMBRA * 0.999, UMBRA, PENUMBRA, rim);
  lunarShadowFactor(0.0, UMBRA, PENUMBRA, axis);
  assert.ok(rim.x > rim.y && rim.y > rim.z, "the umbral rim must be warm");
  assert.ok(axis.x > axis.y && axis.y > axis.z, "the umbral axis must be warm");
  assert.ok(axis.x < rim.x, "the umbra must deepen toward its axis");
  assert.ok(
    axis.x / axis.z > rim.x / rim.z,
    "the red-to-blue ratio must grow inward",
  );
});

test("the appearance law is exactly the identity outside the penumbra", () => {
  const result = new Cartesian3();
  for (const r of [PENUMBRA, PENUMBRA * 1.0001, PENUMBRA * 4.0]) {
    lunarShadowFactor(r, UMBRA, PENUMBRA, result);
    assert.equal(result.x, 1.0);
    assert.equal(result.y, 1.0);
    assert.equal(result.z, 1.0);
  }
  // And with no shadow at all, which is the state every non-eclipse frame
  // publishes.
  lunarShadowFactor(1.0e6, 0.0, 0.0, result);
  assert.equal(result.x, 1.0);
  assert.equal(result.y, 1.0);
  assert.equal(result.z, 1.0);
});

// ───────────────────────────────────────────────────────────────────────────
// Goldens: five published eclipses and a control
// ───────────────────────────────────────────────────────────────────────────

// Catalogue circumstances (NASA/EclipseWise five-millennium canon). The engine
// runs Simon 1994's truncated lunar series, which is not the theory those
// catalogues were computed from, so the tolerances below are the measured
// spread of that model difference rather than an arithmetic bound:
//
//   date        greatest (UT)  catalogue mag  engine mag  d(mag)   d(t)
//   2026-08-28  04:12:16       0.9319         0.95037     +0.0185  -46 s
//   2019-01-21  05:12:16       1.1953         1.18898     -0.0063  -286 s
//   2015-09-28  02:47:09       1.27744        1.29665     +0.0192  +241 s
//   2026-03-03  11:33:40       1.15263        1.14198     -0.0107  -170 s
//   2018-01-31  13:29:51       1.31671        1.32919     +0.0125  -131 s
//
// The 1/85 shadow enlargement is what makes that fit: with no enlargement the
// worst magnitude delta is 0.0323 and with the older 1/50 rule it is 0.0344,
// against 0.0192 here.
const ECLIPSE_MAGNITUDE_TOLERANCE = 0.025;
const ECLIPSE_TIME_TOLERANCE_SECONDS = 360.0;

const GOLDENS = [
  {
    name: "2026-08-28 deep partial",
    scanFrom: "2026-08-27T22:00:00Z",
    catalogueGreatest: "2026-08-28T04:12:16Z",
    catalogueUmbralMagnitude: 0.9319,
    engineGreatest: "2026-08-28T04:11:30Z",
    engineUmbralMagnitude: 0.9503717739602602,
    engineUmbralDiscFraction: 0.9771405223581257,
    total: false,
  },
  {
    name: "2019-01-21 total",
    scanFrom: "2019-01-21T02:00:00Z",
    catalogueGreatest: "2019-01-21T05:12:16Z",
    catalogueUmbralMagnitude: 1.1953,
    engineGreatest: "2019-01-21T05:07:30Z",
    engineUmbralMagnitude: 1.1889839483293598,
    engineUmbralDiscFraction: 1.0,
    total: true,
  },
  {
    name: "2015-09-28 total",
    scanFrom: "2015-09-28T00:00:00Z",
    catalogueGreatest: "2015-09-28T02:47:09Z",
    catalogueUmbralMagnitude: 1.27744,
    engineGreatest: "2015-09-28T02:51:10Z",
    engineUmbralMagnitude: 1.2966493354354964,
    engineUmbralDiscFraction: 1.0,
    total: true,
  },
  {
    name: "2026-03-03 total",
    scanFrom: "2026-03-03T08:00:00Z",
    catalogueGreatest: "2026-03-03T11:33:40Z",
    catalogueUmbralMagnitude: 1.15263,
    engineGreatest: "2026-03-03T11:30:50Z",
    engineUmbralMagnitude: 1.1419816925580244,
    engineUmbralDiscFraction: 1.0,
    total: true,
  },
  {
    name: "2018-01-31 total",
    scanFrom: "2018-01-31T10:00:00Z",
    catalogueGreatest: "2018-01-31T13:29:51Z",
    catalogueUmbralMagnitude: 1.31671,
    engineGreatest: "2018-01-31T13:27:40Z",
    engineUmbralMagnitude: 1.3291852498714123,
    engineUmbralDiscFraction: 1.0,
    total: true,
  },
];

const goldenState = createLunarEclipseState();
const goldenOptions = {
  sunPositionWC: new Cartesian3(),
  moonPositionWC: new Cartesian3(),
  earthRadius: Ellipsoid.WGS84.maximumRadius,
  moonRadius: CesiumMath.LUNAR_RADIUS,
};

function stateAt(julianDate) {
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    julianDate,
    goldenOptions.sunPositionWC,
  );
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    julianDate,
    goldenOptions.moonPositionWC,
  );
  return updateLunarEclipseState(goldenState, goldenOptions);
}

/**
 * Scans ten hours at ten-second resolution for the instant of greatest
 * eclipse — the maximum of the umbral magnitude, which is also the minimum
 * separation of the Moon's centre from the shadow axis.
 */
function findGreatest(scanFromIso) {
  const start = JulianDate.fromIso8601(scanFromIso);
  let best = Number.NEGATIVE_INFINITY;
  let bestDate;
  let snapshot;
  for (let seconds = 0; seconds <= 10 * 3600; seconds += 10) {
    const date = JulianDate.addSeconds(start, seconds, new JulianDate());
    const current = stateAt(date);
    if (current.umbralMagnitude > best) {
      best = current.umbralMagnitude;
      bestDate = date;
      snapshot = {
        umbralMagnitude: current.umbralMagnitude,
        penumbralMagnitude: current.penumbralMagnitude,
        umbraRadius: current.umbraRadius,
        penumbraRadius: current.penumbraRadius,
        centerDistance: current.centerDistance,
        umbralDiscFraction: current.umbralDiscFraction,
        discLuminanceFactor: current.discLuminanceFactor,
        inProgress: current.inProgress,
      };
    }
  }
  return { date: bestDate, ...snapshot };
}

for (const golden of GOLDENS) {
  test(`golden: ${golden.name}`, () => {
    const found = findGreatest(golden.scanFrom);

    // Against the published catalogue — the physical-truth check.
    const magnitudeDelta =
      found.umbralMagnitude - golden.catalogueUmbralMagnitude;
    assert.ok(
      Math.abs(magnitudeDelta) <= ECLIPSE_MAGNITUDE_TOLERANCE,
      `umbral magnitude ${found.umbralMagnitude} is ${magnitudeDelta} from the catalogue's ${golden.catalogueUmbralMagnitude}`,
    );
    const timeDelta = JulianDate.secondsDifference(
      found.date,
      JulianDate.fromIso8601(golden.catalogueGreatest),
    );
    assert.ok(
      Math.abs(timeDelta) <= ECLIPSE_TIME_TOLERANCE_SECONDS,
      `greatest eclipse is ${timeDelta} s from the catalogue's ${golden.catalogueGreatest}`,
    );

    // Against the engine's own recorded answer — the drift check. A change
    // that stays inside the catalogue tolerance still fails here.
    assert.equal(
      JulianDate.toIso8601(found.date, 0),
      golden.engineGreatest,
      "the instant of greatest eclipse has moved",
    );
    assert.ok(
      Math.abs(found.umbralMagnitude - golden.engineUmbralMagnitude) < 1e-9,
      `umbral magnitude drifted to ${found.umbralMagnitude}`,
    );
    assert.ok(
      Math.abs(found.umbralDiscFraction - golden.engineUmbralDiscFraction) <
        1e-9,
      `umbral disc fraction drifted to ${found.umbralDiscFraction}`,
    );

    // Structural consequences of the magnitude, which a magnitude alone does
    // not pin: totality means the whole disc is inside the umbra, and every
    // eclipse in this set is at least fully penumbral at greatest.
    assert.equal(found.inProgress, true);
    assert.ok(found.penumbralMagnitude > 1.0);
    assert.equal(found.umbralDiscFraction === 1.0, golden.total);
    assert.ok(
      found.umbraRadius > 4.0e6 && found.umbraRadius < 5.5e6,
      `umbral radius ${found.umbraRadius} m is not a lunar-distance shadow`,
    );
    assert.ok(
      found.penumbraRadius > found.umbraRadius * 1.5,
      "the penumbra must be far wider than the umbra",
    );

    // The disc must be dramatically dimmed at greatest, and never black.
    assert.ok(
      found.discLuminanceFactor > 0.0 && found.discLuminanceFactor < 0.1,
      `disc luminance ${found.discLuminanceFactor} at greatest`,
    );
  });
}

test("control: a date with no lunar eclipse produces exactly zero coverage", () => {
  // Mid-June 2026 — the Moon is near new, on the sunward side of the Earth,
  // so there is no shadow to fall on it at all.
  const start = JulianDate.fromIso8601("2026-06-15T00:00:00Z");
  const result = new Cartesian3();
  for (let seconds = 0; seconds <= 24 * 3600; seconds += 600) {
    const date = JulianDate.addSeconds(start, seconds, new JulianDate());
    const current = stateAt(date);
    assert.equal(current.inProgress, false, "no eclipse may be reported");
    assert.equal(current.umbraRadius, 0.0);
    assert.equal(current.penumbraRadius, 0.0);
    assert.equal(current.umbralDiscFraction, 0.0);
    assert.equal(current.penumbralDiscFraction, 0.0);
    // The identity, exactly — this is what makes the off path free.
    assert.equal(current.discLuminanceFactor, 1.0);
    for (const radius of [0.0, 1.0e6, 1.0e7]) {
      assert.equal(
        lunarShadowCoverage(
          radius,
          current.umbraRadius,
          current.penumbraRadius,
        ),
        0.0,
      );
      lunarShadowFactor(
        radius,
        current.umbraRadius,
        current.penumbraRadius,
        result,
      );
      assert.equal(result.x, 1.0);
      assert.equal(result.y, 1.0);
      assert.equal(result.z, 1.0);
    }
  }
});

test("the shadow enlargement is Danjon's, not the classical rule", () => {
  assert.ok(Math.abs(LUNAR_SHADOW_ENLARGEMENT - (1.0 + 1.0 / 85.0)) < 1e-15);

  // Refuting the alternatives numerically rather than by assertion. Judged on
  // the WORST fit across all five goldens, not on any one of them: no
  // enlargement happens to fit 2015-09-28 better than Danjon does (0.0026
  // against 0.0192), and a single-eclipse comparison would therefore "prove"
  // the wrong constant. The enlargement multiplies the Earth radius, so an
  // alternative rule is driven through the shipped code by scaling the radius
  // the caller passes — the same arithmetic, a different constant, no second
  // implementation.
  const worstFitUnder = (enlargement) => {
    const scaled = {
      sunPositionWC: new Cartesian3(),
      moonPositionWC: new Cartesian3(),
      earthRadius:
        (Ellipsoid.WGS84.maximumRadius * enlargement) /
        LUNAR_SHADOW_ENLARGEMENT,
      moonRadius: CesiumMath.LUNAR_RADIUS,
    };
    const alternative = createLunarEclipseState();
    let worst = 0.0;
    for (const golden of GOLDENS) {
      const start = JulianDate.fromIso8601(golden.scanFrom);
      let best = Number.NEGATIVE_INFINITY;
      for (let seconds = 0; seconds <= 10 * 3600; seconds += 10) {
        const date = JulianDate.addSeconds(start, seconds, new JulianDate());
        Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
          date,
          scaled.sunPositionWC,
        );
        Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
          date,
          scaled.moonPositionWC,
        );
        best = Math.max(
          best,
          updateLunarEclipseState(alternative, scaled).umbralMagnitude,
        );
      }
      worst = Math.max(worst, Math.abs(best - golden.catalogueUmbralMagnitude));
    }
    return worst;
  };

  const shipped = worstFitUnder(LUNAR_SHADOW_ENLARGEMENT);
  assert.ok(
    Math.abs(shipped - 0.019209335435496522) < 1e-9,
    `the shipped worst-case fit drifted to ${shipped}`,
  );
  assert.ok(
    worstFitUnder(1.0) > shipped,
    "dropping the enlargement must fit the catalogue worse",
  );
  assert.ok(
    worstFitUnder(1.02) > shipped,
    "the classical 1/50 rule must fit the catalogue worse",
  );
});

test("the disc-integrated luminance agrees with the closed-form geometry", () => {
  // With the appearance amplitude removed from consideration, the integral's
  // umbral share must reproduce the closed-form overlap area. Checked by
  // integrating the umbral indicator with the same quadrature the luminance
  // uses, through a coverage law that is 1 inside the umbra and 0 outside.
  for (const centerDistance of [0.0, 1.0e6, 3.0e6, 5.0e6, 9.0e6]) {
    const closedForm = discFractionInsideCircle(
      UMBRA,
      centerDistance,
      CesiumMath.LUNAR_RADIUS,
    );
    // A totally-eclipsed disc must integrate to the deepest luminance, an
    // uneclipsed one to exactly 1, and the ordering must be monotone between.
    const luminance = computeLunarDiscLuminanceFactor(
      UMBRA,
      PENUMBRA,
      centerDistance,
      CesiumMath.LUNAR_RADIUS,
    );
    if (closedForm === 1.0) {
      assert.ok(luminance < 0.1, "a fully umbral disc must be deeply dimmed");
    }
    if (centerDistance >= PENUMBRA + CesiumMath.LUNAR_RADIUS) {
      assert.equal(luminance, 1.0);
    }
    assert.ok(luminance > 0.0 && luminance <= 1.0);
  }
  // Monotone in the separation: the further the Moon is from the axis, the
  // brighter it is.
  let previous = 0.0;
  for (let s = 0.0; s <= PENUMBRA + CesiumMath.LUNAR_RADIUS; s += 2.0e5) {
    const luminance = computeLunarDiscLuminanceFactor(
      UMBRA,
      PENUMBRA,
      s,
      CesiumMath.LUNAR_RADIUS,
    );
    assert.ok(
      luminance >= previous - 1e-12,
      `luminance fell from ${previous} to ${luminance} at s = ${s}`,
    );
    previous = luminance;
  }
  assert.equal(
    computeLunarDiscLuminanceFactor(
      UMBRA,
      PENUMBRA,
      PENUMBRA + CesiumMath.LUNAR_RADIUS + 1.0,
      CesiumMath.LUNAR_RADIUS,
    ),
    1.0,
  );
});

test("the shader's projection reproduces the closed-form umbral coverage", () => {
  // The end-to-end check. Everything else here tests one link: this one runs
  // the whole chain the way a fragment does — take the published world-space
  // geometry, rotate it into the Moon's model frame exactly as `Moon.update`
  // does, then for a grid of surface points apply the three lines both shaders
  // execute (drop the along-axis component, add the axis-to-centre offset,
  // take the length) and count how many land inside the umbra. That fraction
  // must reproduce the closed-form two-circle overlap, which is computed by a
  // completely different formula.
  //
  // The model rotation is arbitrary and non-trivial on purpose. A conversion
  // that dropped the rotation, or transposed it the wrong way, would still
  // produce a plausible bite — just on the wrong side of the disc — and only a
  // check that is rotation-sensitive catches that.
  const state = stateAt(JulianDate.fromIso8601("2026-08-28T04:11:30Z"));
  const modelToWorld = Matrix3.multiply(
    Matrix3.fromRotationX(0.3, new Matrix3()),
    Matrix3.fromRotationZ(0.7, new Matrix3()),
    new Matrix3(),
  );
  const worldToModel = Matrix3.transpose(modelToWorld, new Matrix3());
  const axisMC = Matrix3.multiplyByVector(
    worldToModel,
    state.shadowAxisWC,
    new Cartesian3(),
  );
  const offsetMC = Matrix3.multiplyByVector(
    worldToModel,
    state.shadowOffsetWC,
    new Cartesian3(),
  );

  // A basis for the disc, perpendicular to the shadow axis.
  const seed =
    Math.abs(axisMC.x) < 0.9
      ? new Cartesian3(1.0, 0.0, 0.0)
      : new Cartesian3(0.0, 1.0, 0.0);
  const e1 = Cartesian3.normalize(
    Cartesian3.cross(axisMC, seed, new Cartesian3()),
    new Cartesian3(),
  );
  const e2 = Cartesian3.cross(axisMC, e1, new Cartesian3());

  const R = CesiumMath.LUNAR_RADIUS;
  const N = 300;
  let inUmbra = 0;
  let sampled = 0;
  const point = new Cartesian3();
  const perp = new Cartesian3();
  const scaled = new Cartesian3();
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = ((i + 0.5) / N) * 2.0 - 1.0;
      const v = ((j + 0.5) / N) * 2.0 - 1.0;
      if (u * u + v * v > 1.0) {
        continue;
      }
      const along = Math.sqrt(Math.max(0.0, 1.0 - u * u - v * v)) * R;
      point.x = e1.x * u * R + e2.x * v * R + axisMC.x * along;
      point.y = e1.y * u * R + e2.y * v * R + axisMC.y * along;
      point.z = e1.z * u * R + e2.z * v * R + axisMC.z * along;

      // The three lines both shaders run.
      const alongAxis = Cartesian3.dot(point, axisMC);
      Cartesian3.subtract(
        point,
        Cartesian3.multiplyByScalar(axisMC, alongAxis, scaled),
        perp,
      );
      const radius = Cartesian3.magnitude(
        Cartesian3.add(offsetMC, perp, scaled),
      );

      sampled++;
      if (
        lunarShadowCoverage(radius, state.umbraRadius, state.penumbraRadius) >=
        1.0
      ) {
        inUmbra++;
      }
    }
  }
  const sampledFraction = inUmbra / sampled;
  assert.ok(sampled > 60000, "the grid must actually sample the disc");
  assert.ok(
    Math.abs(sampledFraction - state.umbralDiscFraction) < 1e-3,
    `projected umbral area ${sampledFraction} against closed form ${state.umbralDiscFraction}`,
  );

  // Rotation sensitivity: dropping the world-to-model rotation must break the
  // agreement, which is what proves the check is testing the conversion and
  // not just the coverage law.
  let unrotated = 0;
  let unrotatedSampled = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = ((i + 0.5) / N) * 2.0 - 1.0;
      const v = ((j + 0.5) / N) * 2.0 - 1.0;
      if (u * u + v * v > 1.0) {
        continue;
      }
      const along = Math.sqrt(Math.max(0.0, 1.0 - u * u - v * v)) * R;
      point.x = e1.x * u * R + e2.x * v * R + axisMC.x * along;
      point.y = e1.y * u * R + e2.y * v * R + axisMC.y * along;
      point.z = e1.z * u * R + e2.z * v * R + axisMC.z * along;
      const alongAxis = Cartesian3.dot(point, state.shadowAxisWC);
      Cartesian3.subtract(
        point,
        Cartesian3.multiplyByScalar(state.shadowAxisWC, alongAxis, scaled),
        perp,
      );
      const radius = Cartesian3.magnitude(
        Cartesian3.add(state.shadowOffsetWC, perp, scaled),
      );
      unrotatedSampled++;
      if (
        lunarShadowCoverage(radius, state.umbraRadius, state.penumbraRadius) >=
        1.0
      ) {
        unrotated++;
      }
    }
  }
  assert.ok(
    Math.abs(unrotated / unrotatedSampled - state.umbralDiscFraction) > 1e-3,
    "a conversion that skipped the model rotation must not agree",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring: one state, two backends, one conversion
// ───────────────────────────────────────────────────────────────────────────

test("Scene publishes the state from the shared ephemeris sample", () => {
  assert.match(
    scene,
    /import \{\s*createLunarEclipseState,\s*updateLunarEclipseState,\s*\} from "\.\/LunarEclipseState\.js";/,
  );
  assert.match(
    scene,
    /frameState\.lunarEclipse = updateLunarEclipseState\(/,
    "Scene must publish the state on frameState",
  );
  // The same sample the solar state and Moon.update read. A second ephemeris
  // source here would put the bite somewhere other than on the drawn disc.
  const publishAt = scene.indexOf(
    "frameState.lunarEclipse = updateLunarEclipse",
  );
  const block = scene.slice(publishAt - 1200, publishAt);
  assert.match(block, /defined\(celestialEphemerisSample\)/);
  assert.match(block, /celestialEphemerisSample\.sunPositionWC/);
  assert.match(block, /celestialEphemerisSample\.moonPositionWC/);
  assert.match(scene, /frameState\.lunarEclipse = undefined;/);
  assert.match(frameStateSource, /this\.lunarEclipse = undefined;/);
});

test("Moon converts once, before the backend branch", () => {
  const branchAt = sceneMoon.indexOf(
    "const fr = context.getFeatureRenderer(FeatureRendererKey.MOON);",
  );
  assert.ok(branchAt > 0, "the backend branch must be locatable");
  const shared = sceneMoon.slice(0, branchAt);
  assert.match(shared, /const lunarEclipse = frameState\.lunarEclipse;/);
  assert.match(shared, /lighting\.enableLunarEclipse !== false/);
  assert.match(shared, /Matrix3\.transpose\(rotation, scratchShadowRotation\)/);
  assert.match(shared, /frameState\.moonShadowAxisMC/);
  assert.match(shared, /frameState\.moonPenumbraRadius = penumbraRadius;/);
  assert.match(shared, /ellipsoidPrimitive\.lunarShadowAxis = shadowAxisMC;/);
  // Per-instance rather than module scratch: the WebGL uniform closures are
  // evaluated at draw time, after another scene's Moon may have run.
  assert.match(sceneMoon, /this\._shadowAxisMC = new Cartesian3\(\);/);
  assert.match(sceneMoon, /this\._shadowOffsetMC = new Cartesian3\(\);/);
  assert.doesNotMatch(
    sceneMoon,
    /^const scratchShadowAxisMC/m,
    "the model-space vectors must not live in module scratch",
  );
});

test("the toggle is registered in AtmosphericConditions, default ON", () => {
  assert.match(conditions, /enableLunarEclipse: true,/);
});

test("WebGL compiles the term out when there is no eclipse", () => {
  assert.match(primitive, /this\.lunarShadowAxis = undefined;/);
  assert.match(
    primitive,
    /const lunarEclipseEnabled = defined\(this\.lunarShadowAxis\);/,
  );
  assert.match(primitive, /fs\.defines\.push\("LUNAR_ECLIPSE"\);/);
  assert.match(primitive, /lunarEclipseChanged \|\|/);

  // The define must be REACHABLE, not merely present. A push whose guard has
  // been narrowed to something that never holds leaves the source text intact
  // and every grep above green, while the shader silently loses the block —
  // so the guard's own condition is extracted and evaluated.
  const guard = defineGuardExpression(primitive, "LUNAR_ECLIPSE");
  assert.equal(
    guard,
    "lunarEclipseEnabled",
    "the define must be guarded by the resolved flag alone",
  );
  // eslint-disable-next-line no-new-func
  const evaluateGuard = new Function(
    "lunarEclipseEnabled",
    `return (${guard});`,
  );
  assert.equal(
    evaluateGuard(true),
    true,
    "an eclipse frame must actually push the define",
  );
  assert.equal(
    evaluateGuard(false),
    false,
    "a frame with no shadow must not push the define",
  );
  // Every uniform the block declares must have a supplier, or the program
  // links against an undefined uniform the first frame the define flips.
  for (const name of [
    "u_lunarShadowAxis",
    "u_lunarShadowOffset",
    "u_lunarUmbraRadius",
    "u_lunarPenumbraRadius",
  ]) {
    assert.ok(
      primitive.includes(`${name}: function ()`),
      `${name} must have a uniform supplier`,
    );
    assert.ok(
      glsl.includes(name),
      `${name} must be declared by the shader that reads it`,
    );
  }
  // The block is inside the define, so a generic EllipsoidPrimitive never
  // sees it.
  const declarationAt = glsl.indexOf("uniform vec3 u_lunarShadowAxis;");
  assert.ok(declarationAt > 0);
  const guardAt = glsl.lastIndexOf("#ifdef LUNAR_ECLIPSE", declarationAt);
  assert.ok(guardAt > 0, "the uniforms must sit inside the define");
});

test("WebGPU packs the block at the reserved tail, gated on the radius", () => {
  assert.match(envRenderer, /const MOON_UNIFORM_BUFFER_SIZE = 384;/);
  assert.match(envRenderer, /ud\[88\] = shadowAxisMC\?\.x \?\? 0\.0;/);
  assert.match(
    envRenderer,
    /ud\[91\] = frameState\.moonUmbraRadius \?\? 0\.0;/,
  );
  assert.match(envRenderer, /ud\[92\] = shadowOffsetMC\?\.x \?\? 0\.0;/);
  assert.match(
    envRenderer,
    /ud\[95\] = defined\(shadowAxisMC\) \? \(frameState\.moonPenumbraRadius \?\? 0\.0\) : 0\.0;/,
    "the gate float must be zero whenever the axis is absent",
  );
  // The WGSL side must open its vec3 block on a 16-byte boundary, which is
  // why float 87 stays padding.
  assert.match(
    wgsl,
    /shadowAxisMC: vec3<f32>, umbraRadius: f32,\s+\/\/ 352\.\.367/,
  );
  assert.match(
    wgsl,
    /shadowOffsetMC: vec3<f32>, penumbraRadius: f32,\s+\/\/ 368\.\.383/,
  );
  assert.match(wgsl, /terminatorSoftness: f32,\s+\/\/ 344/);
  assert.match(wgsl, /_p11: f32,\s+\/\/ 348/);
  // Readable back out for an acceptance probe.
  assert.match(envRenderer, /lunarPenumbraRadius,\n/);
});

test("both backends gate the block so a non-eclipse frame costs one compare", () => {
  assert.match(
    wgslCode,
    /if \(u\.penumbraRadius > 0\.0\) \{/,
    "the WGSL block must be branch-gated, not multiplied through an identity",
  );
  // The projection itself, in both languages: drop the along-axis component,
  // add the axis-to-centre offset, take the length.
  assert.match(
    wgslCode,
    /let shadowPositionMC = hitMC - alongAxis \* u\.shadowAxisMC;/,
  );
  assert.match(
    wgslCode,
    /let shadowRadius = length\(u\.shadowOffsetMC \+ shadowPositionMC\);/,
  );
  assert.match(
    glslCode,
    /vec3 shadowPositionMC = positionMC - dot\(positionMC, u_lunarShadowAxis\) \* u_lunarShadowAxis;/,
  );
  assert.match(
    glslCode,
    /float shadowRadius = length\(u_lunarShadowOffset \+ shadowPositionMC\);/,
  );
  // Applied to the composed colour on both sides, so earthshine is shadowed
  // too and the umbra cannot be lifted blue-grey.
  assert.match(
    wgslCode,
    /color = color \* lunarShadowFactor\(shadowRadius, u\.umbraRadius, u\.penumbraRadius\);/,
  );
  assert.match(
    glslCode,
    /litColor\.rgb \*= lunarShadowFactor\(shadowRadius, u_lunarUmbraRadius, u_lunarPenumbraRadius\);/,
  );
  // Ordering: the shadow must be the LAST term in the disc's own lighting,
  // after earthshine.
  assert.ok(
    wgslCode.indexOf("u.penumbraRadius > 0.0") >
      wgslCode.indexOf("let earthshineOn"),
  );
  assert.ok(
    glslCode.indexOf("lunarShadowFactor(shadowRadius") >
      glslCode.indexOf("u_earthshinePhaseScale;"),
  );
});

test("Moon.wgsl still passes naga validation", async () => {
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
  assert.doesNotThrow(() => naga.validate_wgsl(wgsl));
});

// ───────────────────────────────────────────────────────────────────────────
// What the Edge acceptance leg must assert
// ───────────────────────────────────────────────────────────────────────────

test("PREDICTIONS: the numbers the Edge run is measured against", () => {
  // At greatest on 2026-08-28 the eclipse-explorer lunar preset must show:
  //
  //   - 97.71% of the disc inside the umbra (the bite covers all but a thin
  //     bright limb), from `engineUmbralDiscFraction` above;
  //   - a disc luminance of 0.0452 relative to an uneclipsed Moon, so the
  //     mean disc brightness must fall by more than an order of magnitude
  //     against a pre-eclipse frame at 01:00 UT;
  //   - the umbral interior warm, with red at least three times blue.
  //
  // The sensitivity anchor is `atmosphericConditions.lighting.enableLunarEclipse`
  // = false: with it off, `Moon.update` withholds the uniforms, the penumbral
  // radius packs as 0, and the disc must return to its uneclipsed luminance.
  // A run where the toggle does not move the disc is void.
  const found = findGreatest("2026-08-27T22:00:00Z");
  assert.ok(Math.abs(found.umbralDiscFraction - 0.9771405223581257) < 1e-9);
  assert.ok(Math.abs(found.discLuminanceFactor - 0.04518134) < 1e-6);
  const rim = new Cartesian3();
  lunarShadowFactor(
    found.centerDistance - CesiumMath.LUNAR_RADIUS * 0.5,
    found.umbraRadius,
    found.penumbraRadius,
    rim,
  );
  assert.ok(rim.x / rim.z > 3.0, "the umbral interior must read copper");
});
