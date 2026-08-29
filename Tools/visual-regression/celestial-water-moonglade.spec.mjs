// celestial-water-moonglade.spec.mjs — the reflected Moon on the FFT ocean and
// the terminator that decides when it is allowed to appear.
//
// @purpose Executes the FFT ocean's moonglade and night-gate laws from the WGSL source, and the Moon resolve from the primitive, pinning the hand-over across the terminator and the stale-bearing guard.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/celestial-water-moonglade.spec.mjs
//
// WHAT THIS IS FOR. The sun glint's own law is pinned by
// `celestial-water-sun-glint.spec.mjs`, which also owns the off contract and the
// uniform layout. This spec owns what the second light source adds: the Moon's
// resolve on the CPU, the terminator gate, the rise gate, and the way the two
// contributions are weighted so neither is counted twice.
//
// HOW IT AVOIDS CERTIFYING ITSELF. Every law below is PARSED and EVALUATED out
// of the shipped WGSL through `lib/wgsl-mini-eval.mjs` — the functions by name,
// the fragment's weighting expressions by extraction. The CPU half is the real
// exported resolver, called. Nothing here reimplements a law and then agrees
// with itself.
//
// THE ONE PROPERTY WORTH STATING PLAINLY. A reflected Moon that survives into
// daylight, or a Sun glint that survives into the night, is the failure this
// feature would be reported for. The gate is therefore tested as a sweep across
// the terminator rather than at two endpoints, and the two weights are required
// to be exactly complementary at every sample.
//
// PRECISION. The evaluator is f64 where the GPU is f32; no assertion here sits
// near an f32 boundary.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  evaluate,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
} from "./lib/wgsl-mini-eval.mjs";
import { resolveCelestialReflection } from "../../packages/engine/Source/Scene/OceanSurfacePrimitive.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OCEAN_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Ocean/OceanSurface.wgsl",
);
const OCEAN_TS_PATH = path.join(
  ROOT,
  "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
);

const oceanWgsl = fs
  .readFileSync(OCEAN_WGSL_PATH, "utf8")
  .replace(/\r\n/g, "\n");
const oceanTs = fs.readFileSync(OCEAN_TS_PATH, "utf8").replace(/\r\n/g, "\n");
const wgsl = stripComments(oceanWgsl);

const CONSTANTS = readConstants(wgsl);
const functions = {};
const globals = { ...CONSTANTS, __functions: functions };
for (const name of [
  "celestialDistributionGGX",
  "celestialSmithG1",
  "celestialGlint",
  "celestialNightGate",
]) {
  functions[name] = compileFunction(wgsl, name, globals);
}
const { celestialGlint, celestialNightGate } = functions;

// The fragment region the celestial terms live in.
const GATE_AT = wgsl.indexOf("if (ocean.celestialEnable > 0.0) {");
const ELSE_AT = wgsl.indexOf("} else {", GATE_AT);
assert.ok(GATE_AT > 0 && ELSE_AT > GATE_AT, "the gated arm must be findable");
const ENABLED_ARM = wgsl.slice(GATE_AT, ELSE_AT);

/**
 * Pull the right-hand side of a `let NAME = …;` binding out of the gated arm.
 *
 * Scoped to the arm on purpose: a law that drifts out of the gate must not go
 * on being tested as though it were still inside it.
 *
 * @param {string} name The binding name.
 * @returns {string} The expression text.
 */
function bindingExpression(name) {
  const re = new RegExp(`let ${name} =\\s*([\\s\\S]*?);\\n`);
  const m = re.exec(ENABLED_ARM);
  assert.ok(m !== null, `binding ${name} must live inside the gated arm`);
  return m[1];
}

/**
 * Evaluate a shader expression against the module globals plus bindings.
 *
 * @param {string} text The expression.
 * @param {object} env Local bindings.
 * @returns {number|object|boolean} The value.
 */
function evalExpr(text, env) {
  return evaluate(parseExpression(tokenize(stripComments(text)), 0).node, {
    ...globals,
    ...env,
  });
}

const UP = vec(0, 0, 1);

/**
 * A unit direction at a given altitude above the local horizon.
 *
 * @param {number} sinAltitude Sine of the altitude, in [-1, 1].
 * @param {number} [azimuth] Azimuth about the up axis, radians.
 * @returns {object} The unit direction.
 */
function atAltitude(sinAltitude, azimuth = 0) {
  const horizontal = Math.sqrt(Math.max(1 - sinAltitude * sinAltitude, 0));
  return vec(
    horizontal * Math.cos(azimuth),
    horizontal * Math.sin(azimuth),
    sinAltitude,
  );
}

/**
 * A primitive stand-in carrying only what the resolver reads.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object} The stand-in.
 */
function primitiveStub(overrides) {
  return {
    _celestialReflection: true,
    _celestialRoughness: 0.06,
    _celestialSunIntensity: 1.0,
    _celestialMoonIntensity: 0.35,
    ...overrides,
  };
}

/**
 * A frame state carrying only the Moon fields the resolver reads.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {object} The stand-in.
 */
function frameStateStub(overrides) {
  return {
    moonDirectionWC: { x: 0.0, y: 0.0, z: 1.0 },
    moonPhaseFraction: 1.0,
    ...overrides,
  };
}

// ───────────────── G. the Moon resolve, executed on the CPU ─────────────────

test("G1 an absent frame state means no Moon, not a stale one", () => {
  const out = resolveCelestialReflection(primitiveStub());
  assert.equal(out.enable, 1, "the feature is still on");
  assert.deepEqual(out.moonDirection, { x: 0, y: 0, z: 0 });
  assert.equal(out.moonPhase, 0);
});

test("G2 a zero illuminated fraction zeroes the direction beside it", () => {
  // Scene clears the fraction every frame and only a Moon that updated writes
  // it back, while the direction storage is reused — so a zero fraction with a
  // live-looking direction is exactly the hidden-Moon frame, and the bearing it
  // carries is last frame's.
  const out = resolveCelestialReflection(
    primitiveStub(),
    frameStateStub({ moonPhaseFraction: 0.0 }),
  );
  assert.deepEqual(out.moonDirection, { x: 0, y: 0, z: 0 });
  assert.equal(out.moonPhase, 0);
});

test("G3 the direction reaches the shader as a unit vector", () => {
  const out = resolveCelestialReflection(
    primitiveStub(),
    frameStateStub({ moonDirectionWC: { x: 3.0, y: 4.0, z: 0.0 } }),
  );
  const d = out.moonDirection;
  const magnitude = Math.hypot(d.x, d.y, d.z);
  assert.ok(Math.abs(magnitude - 1) < 1e-12, `not unit: ${magnitude}`);
  assert.ok(Math.abs(d.x - 0.6) < 1e-12);
  assert.ok(Math.abs(d.y - 0.8) < 1e-12);
});

test("G4 a degenerate direction is dropped rather than normalised", () => {
  for (const bad of [
    { x: 0, y: 0, z: 0 },
    { x: Number.NaN, y: 0, z: 0 },
    { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
  ]) {
    const out = resolveCelestialReflection(
      primitiveStub(),
      frameStateStub({ moonDirectionWC: bad }),
    );
    for (const k of ["x", "y", "z"]) {
      assert.ok(
        Object.is(out.moonDirection[k], 0),
        `${k} must be exactly 0 for ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(out.moonPhase, 0);
  }
});

test("G5 the illuminated fraction is clamped to its documented range", () => {
  assert.equal(
    resolveCelestialReflection(
      primitiveStub(),
      frameStateStub({ moonPhaseFraction: 7.5 }),
    ).moonPhase,
    1,
  );
  const half = resolveCelestialReflection(
    primitiveStub(),
    frameStateStub({ moonPhaseFraction: 0.5 }),
  );
  assert.equal(half.moonPhase, 0.5);
});

test("G6 a non-finite fraction is no Moon", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const out = resolveCelestialReflection(
      primitiveStub(),
      frameStateStub({ moonPhaseFraction: bad }),
    );
    assert.equal(out.moonPhase, 0);
    assert.deepEqual(out.moonDirection, { x: 0, y: 0, z: 0 });
  }
});

test("G7 the Moon weight is floored and defaulted, never negative", () => {
  assert.equal(
    resolveCelestialReflection(
      primitiveStub({ _celestialMoonIntensity: -2 }),
      frameStateStub(),
    ).moonIntensity,
    0,
  );
  assert.equal(
    resolveCelestialReflection(
      primitiveStub({ _celestialMoonIntensity: Number.NaN }),
      frameStateStub(),
    ).moonIntensity,
    0.35,
  );
});

test("G8 the CPU and the shader agree on the lunar disc size", () => {
  const out = resolveCelestialReflection(primitiveStub(), frameStateStub());
  assert.equal(
    out.moonSinAngularRadius,
    CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
  );
  // 932.58 arcseconds is the Moon's mean angular radius.
  const expected = Math.sin((932.58 / 3600) * (Math.PI / 180));
  assert.ok(
    Math.abs(out.moonSinAngularRadius - expected) < 5e-7,
    `${out.moonSinAngularRadius} is not sin(932.58")`,
  );
  // The two discs are close but not equal; carrying one constant for both would
  // be a coincidence relied on, not a fact.
  assert.notEqual(
    CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
    CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
  );
});

test("G9 with the feature off, the Moon half is zero too", () => {
  const out = resolveCelestialReflection(
    primitiveStub({ _celestialReflection: false }),
    frameStateStub(),
  );
  assert.deepEqual(out.moonDirection, { x: 0, y: 0, z: 0 });
  for (const key of ["moonPhase", "moonIntensity", "moonSinAngularRadius"]) {
    assert.ok(Object.is(out[key], 0), `${key} must be exactly +0`);
  }
});

// ─────────────────────── H. the lunar half of the pack ───────────────────────

test("H1 slots 40 to 47 carry the Moon, each written once", () => {
  const expected = [
    [40, /od\[40\] = moon\.x;/],
    [41, /od\[41\] = moon\.y;/],
    [42, /od\[42\] = moon\.z;/],
    [43, /od\[43\] = p\._celestialMoonPhase \?\? 0\.0;/],
    [44, /od\[44\] = p\._celestialResolvedMoonIntensity \?\? 0\.0;/],
    [45, /od\[45\] = p\._celestialMoonSinAngularRadius \?\? 0\.0;/],
    [46, /od\[46\] = 0\.0;/],
    [47, /od\[47\] = 0\.0;/],
  ];
  for (const [slot, re] of expected) {
    const writes = oceanTs.match(new RegExp(`od\\[${slot}\\]\\s*=`, "g")) ?? [];
    assert.equal(writes.length, 1, `od[${slot}] must be written exactly once`);
    assert.match(oceanTs, re, `od[${slot}] carries the wrong value`);
  }
  assert.match(
    oceanTs,
    /const moon = p\._celestialMoonDirection \?\? \{ x: 0\.0, y: 0\.0, z: 0\.0 \};/,
    "a missing direction must default to the zero vector",
  );
});

test("H2 the pad slots are written, not left to whatever was there", () => {
  // The staging array is reused frame to frame, so an unwritten slot is not a
  // zero — it is the last value anything put there.
  const tailAt = oceanTs.indexOf("od[40]");
  const flushAt = oceanTs.indexOf("writeBuffer(cache.oceanUniformBuffer");
  assert.ok(tailAt > 0 && flushAt > tailAt);
});

// ──────────────── I. the terminator gate, evaluated from source ────────────────

test("I1 the gate reads a geodetic up, never the wave normal", () => {
  const upExpr = bindingExpression("up");
  assert.match(upExpr, /normalize\(ocean\.up\)/);
  const gateExpr = bindingExpression("nightGate");
  assert.match(gateExpr, /celestialNightGate\(up, sunDir\)/);
  assert.ok(
    !gateExpr.includes("worldNormal"),
    "gating on the wave normal makes the terminator flicker with the swell",
  );
});

test("I2 the gate is fully closed by day and fully open at night", () => {
  const band = CONSTANTS.CELESTIAL_NIGHT_BAND_SIN;
  assert.equal(celestialNightGate(UP, atAltitude(1)), 0, "noon");
  assert.equal(celestialNightGate(UP, atAltitude(-1)), 1, "deep night");
  assert.equal(celestialNightGate(UP, atAltitude(band)), 0, "band edge, day");
  assert.equal(
    celestialNightGate(UP, atAltitude(-band)),
    1,
    "band edge, night",
  );
  assert.ok(
    Math.abs(celestialNightGate(UP, atAltitude(0)) - 0.5) < 1e-12,
    "the horizon must sit at the middle of the ramp",
  );
});

test("I3 the gate is monotone across the terminator, with no step", () => {
  let previous = celestialNightGate(UP, atAltitude(-1));
  let maxJump = 0;
  for (let i = 1; i <= 400; i += 1) {
    const sinAltitude = -1 + (2 * i) / 400;
    const value = celestialNightGate(UP, atAltitude(sinAltitude));
    assert.ok(value <= previous + 1e-12, `gate rose at ${sinAltitude}`);
    maxJump = Math.max(maxJump, Math.abs(value - previous));
    previous = value;
  }
  assert.equal(previous, 0);
  assert.ok(maxJump < 0.25, `the ramp has a step of ${maxJump}`);
});

test("I4 the band is a few degrees wide, not a hard edge", () => {
  const band = CONSTANTS.CELESTIAL_NIGHT_BAND_SIN;
  const degrees = (Math.asin(band) * 180) / Math.PI;
  assert.ok(
    degrees > 1 && degrees < 10,
    `a ${degrees.toFixed(2)}° terminator band is not a soft hand-over`,
  );
});

test("I5 the two weights are exactly complementary at every altitude", () => {
  const dayExpr = bindingExpression("dayGate");
  assert.match(dayExpr, /1\.0 - nightGate/);
  for (let i = 0; i <= 200; i += 1) {
    const sinAltitude = -1 + (2 * i) / 200;
    const nightGate = celestialNightGate(UP, atAltitude(sinAltitude));
    const dayGate = evalExpr(dayExpr, { nightGate });
    assert.equal(
      dayGate + nightGate,
      1,
      `weights sum to ${dayGate + nightGate} at ${sinAltitude}`,
    );
  }
});

// ───────────── J. the rise gate and how the contributions compose ─────────────

test("J1 the rise gate holds the Moon back until it clears the horizon", () => {
  const expr = bindingExpression("moonRiseGate");
  const at = (sinAltitude) =>
    evalExpr(expr, {
      up: UP,
      ocean: { moonDirection: atAltitude(sinAltitude) },
    });
  assert.equal(at(0), 0, "a Moon on the horizon casts no glade");
  assert.equal(at(-0.5), 0, "a set Moon casts none either");
  assert.equal(
    at(CONSTANTS.CELESTIAL_MOON_RISE_SIN),
    1,
    "past the rise angle the gate is fully open",
  );
  let previous = 0;
  for (let i = 0; i <= 100; i += 1) {
    const value = at((i / 100) * CONSTANTS.CELESTIAL_MOON_RISE_SIN);
    assert.ok(value >= previous - 1e-12, "the rise gate must not fall");
    previous = value;
  }
  const degrees =
    (Math.asin(CONSTANTS.CELESTIAL_MOON_RISE_SIN) * 180) / Math.PI;
  assert.ok(
    degrees > 2 && degrees < 12,
    `rise angle ${degrees}° is unreasonable`,
  );
});

test("J2 a zero Moon direction produces no glade, through both terms", () => {
  const zero = vec(0, 0, 0);
  assert.equal(
    evalExpr(bindingExpression("moonRiseGate"), {
      up: UP,
      ocean: { moonDirection: zero },
    }),
    0,
  );
  assert.equal(
    celestialGlint(
      UP,
      atAltitude(0.7),
      zero,
      0.06,
      CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS,
    ),
    0,
    "the glint's own horizon test must reject the zero vector",
  );
});

test("J3 the moonglade carries every gate it is supposed to", () => {
  const expr = bindingExpression("moonContribution");
  const base = {
    moonGlint: 4.0,
    moonRiseGate: 1.0,
    nightGate: 1.0,
    ocean: { celestialMoonIntensity: 0.35, celestialMoonPhase: 1.0 },
  };
  const full = evalExpr(expr, base);
  assert.ok(full.x > 0 && full.y > 0 && full.z > 0, "a full Moon must show");

  const zeroing = [
    [
      "the illuminated fraction",
      { ocean: { ...base.ocean, celestialMoonPhase: 0 } },
    ],
    ["the night gate", { nightGate: 0 }],
    ["the rise gate", { moonRiseGate: 0 }],
    [
      "the intensity dial",
      { ocean: { ...base.ocean, celestialMoonIntensity: 0 } },
    ],
    ["the glint itself", { moonGlint: 0 }],
  ];
  for (const [what, override] of zeroing) {
    const out = evalExpr(expr, { ...base, ...override });
    assert.deepEqual(
      out,
      { x: 0, y: 0, z: 0 },
      `${what} at zero must close the moonglade`,
    );
  }

  // Half the illuminated disc is half the light, exactly.
  const half = evalExpr(expr, {
    ...base,
    ocean: { ...base.ocean, celestialMoonPhase: 0.5 },
  });
  assert.ok(Math.abs(half.x - full.x * 0.5) < 1e-12);
});

test("J4 the moonglade is tinted warm grey, not blue", () => {
  const expr = bindingExpression("moonContribution");
  const out = evalExpr(expr, {
    moonGlint: 1.0,
    moonRiseGate: 1.0,
    nightGate: 1.0,
    ocean: { celestialMoonIntensity: 1.0, celestialMoonPhase: 1.0 },
  });
  assert.ok(out.x > out.y && out.y > out.z, "red ≥ green ≥ blue for moonlight");
});

test("J5 the sun glint is closed by the same terminator that opens the Moon", () => {
  const expr = bindingExpression("sunContribution");
  const base = {
    sunGlint: 4.0,
    dayGate: 1.0,
    ocean: { celestialSunIntensity: 1.0 },
  };
  const day = evalExpr(expr, base);
  assert.ok(day.x > 0);
  const night = evalExpr(expr, { ...base, dayGate: 0.0 });
  assert.deepEqual(night, { x: 0, y: 0, z: 0 }, "no sun glint at night");
});

test("J6 across a terminator sweep the sun falls as the Moon rises", () => {
  const sunExpr = bindingExpression("sunContribution");
  const moonExpr = bindingExpression("moonContribution");
  const dayExpr = bindingExpression("dayGate");
  let previousSun = Number.POSITIVE_INFINITY;
  let previousMoon = -1;
  for (let i = 0; i <= 100; i += 1) {
    const sinAltitude = 0.2 - (0.4 * i) / 100;
    const nightGate = celestialNightGate(UP, atAltitude(sinAltitude));
    const dayGate = evalExpr(dayExpr, { nightGate });
    const sun = evalExpr(sunExpr, {
      sunGlint: 1.0,
      dayGate,
      ocean: { celestialSunIntensity: 1.0 },
    }).x;
    const moon = evalExpr(moonExpr, {
      moonGlint: 1.0,
      moonRiseGate: 1.0,
      nightGate,
      ocean: { celestialMoonIntensity: 1.0, celestialMoonPhase: 1.0 },
    }).x;
    assert.ok(sun <= previousSun + 1e-12, "the sun term must not rise at dusk");
    assert.ok(
      moon >= previousMoon - 1e-12,
      "the moon term must not fall at dusk",
    );
    previousSun = sun;
    previousMoon = moon;
  }
  assert.equal(previousSun, 0, "the sun term must reach zero by full night");
  assert.ok(previousMoon > 0, "the moon term must be live by full night");
});

test("J7 the composition adds both contributions and nothing else", () => {
  assert.match(wgsl, /color \+= sunContribution \+ moonContribution;/);
  const adds = (wgsl.match(/color \+=/g) ?? []).length;
  // One in the enabled arm, one in the historical arm.
  assert.equal(adds, 2, `expected two colour additions, saw ${adds}`);
});

// ────────────── K. the lunar disc gets the same width floor ──────────────

test("K1 the Moon's disc floors its own lobe", () => {
  const sin = CONSTANTS.CELESTIAL_MOON_SIN_ANGULAR_RADIUS;
  const floorAlpha = CONSTANTS.CELESTIAL_DISC_WIDEN * sin;
  const bound = 1 / (Math.PI * floorAlpha * floorAlpha);
  const view = atAltitude(Math.cos(Math.PI / 4));
  let last = 0;
  for (const roughness of [0.05, 0.01, 0.001, 0.0]) {
    const light = vec(-view.x, -view.y, view.z);
    const peak = celestialGlint(UP, view, light, roughness, sin);
    assert.ok(Number.isFinite(peak), `peak must stay finite at ${roughness}`);
    assert.ok(peak <= bound, `peak ${peak} exceeds the disc floor bound`);
    last = peak;
  }
  assert.ok(last > 0, "a mirror sea must still show the Moon");
});

test("K2 the moonglade widens with the same roughness the sun glint uses", () => {
  // One roughness feeds both lobes; a second dial would let them disagree about
  // the state of the same sea.
  const moonCall =
    /let moonGlint = celestialGlint\(\s*worldNormal,\s*viewDir,\s*ocean\.moonDirection,\s*celestialRoughness,/;
  const sunCall =
    /let sunGlint = celestialGlint\(\s*worldNormal,\s*viewDir,\s*sunDir,\s*celestialRoughness,/;
  assert.match(wgsl, moonCall);
  assert.match(wgsl, sunCall);
});
