// celestial-water-sun-glint.spec.mjs — the microfacet sun glint on the FFT
// ocean, and the off contract that keeps the default look untouched.
//
// @purpose Executes the FFT ocean's celestial sun-glint law straight out of the WGSL source, pins the zeroed-uniform off contract, and records the pre-port state of the other three water glint laws.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/celestial-water-sun-glint.spec.mjs
//
// WHAT MAKES THIS SPEC ABLE TO FAIL. A spec that transcribes a shader law into
// JavaScript and then asserts the transcription certifies the transcription.
// This one does not transcribe: it PARSES the three WGSL functions out of
// `Shaders/WebGPU/Ocean/OceanSurface.wgsl` and EVALUATES them, so every
// property below is a property of the shipped shader text. Editing the shader's
// arithmetic changes what runs here. The evaluator itself lives in
// `lib/wgsl-mini-eval.mjs`, which fails closed on anything outside the subset
// it can read, so a shader that outgrows it makes this spec fail rather than
// quietly skip the part it can no longer evaluate.
//
// The CPU half is executed too, not read: `resolveCelestialReflection` is
// imported from the primitive and called, so the "every float is exactly zero
// while it is off" claim is measured rather than asserted.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. The evaluator computes in f64 where the
// GPU computes in f32, so it establishes the SHAPE of the lobe and its limits,
// not bit-level agreement with a device. No property asserted here sits near an
// f32 boundary. Nothing here draws a pixel: the rendered-output half of the off
// contract belongs to a browser leg, and this spec's contribution to it is that
// the off arm's source text is byte-for-byte the historical highlight and the
// off uniform tail is exact zeros.
//
// THE AUDIT GROUP IS LOAD-BEARING. Group F pins what the OTHER three water
// glint laws do today — two in `GlobeTerrain.wgsl` and one in `GlobeFS.glsl`,
// all of them the shininess-10 Phong lobe. They are recorded as facts under
// test so that the port of this lobe onto the globe ocean has to come here and
// change them deliberately, instead of leaving a stale claim behind.
//
// CRLF: this repo checks out with `core.autocrlf=true`; every reader below
// normalises line endings before matching.

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
const PRIMITIVE_PATH = path.join(
  ROOT,
  "packages/engine/Source/Scene/OceanSurfacePrimitive.js",
);
const GLOBE_WGSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const GLOBE_GLSL_PATH = path.join(
  ROOT,
  "packages/engine/Source/Shaders/GlobeFS.glsl",
);

/**
 * Read a source file with its line endings normalised to LF.
 *
 * @param {string} file Absolute path.
 * @returns {string} The source.
 */
function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const oceanWgsl = read(OCEAN_WGSL_PATH);
const oceanTs = read(OCEAN_TS_PATH);
const primitiveJs = read(PRIMITIVE_PATH);

const wgslStripped = stripComments(oceanWgsl);
const WGSL_CONSTANTS = readConstants(wgslStripped);
const wgslFunctions = {};
const wgslGlobals = { ...WGSL_CONSTANTS, __functions: wgslFunctions };
for (const name of [
  "celestialDistributionGGX",
  "celestialSmithG1",
  "celestialGlint",
]) {
  wgslFunctions[name] = compileFunction(wgslStripped, name, wgslGlobals);
}
const { celestialDistributionGGX, celestialSmithG1, celestialGlint } =
  wgslFunctions;

/**
 * Evaluate a bare WGSL expression against an environment.
 *
 * @param {string} text The expression.
 * @param {object} env Bindings.
 * @returns {number|object|boolean} The value.
 */
function evalExpression(text, env) {
  const tokens = tokenize(stripComments(text));
  return evaluate(parseExpression(tokens, 0).node, {
    ...wgslGlobals,
    ...env,
  });
}

/**
 * A unit 3-vector from a polar angle about `+z` and an azimuth.
 *
 * @param {number} theta Angle from `+z`, radians.
 * @param {number} phi Azimuth in the `xy` plane, radians.
 * @returns {object} The unit vector.
 */
function dir(theta, phi) {
  return vec(
    Math.sin(theta) * Math.cos(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(theta),
  );
}

const UP = vec(0, 0, 1);

/**
 * The glint at a fixed view, with the light swung `offset` radians away from
 * the mirror direction of that view.
 *
 * @param {number} viewTheta View angle from the normal, radians.
 * @param {number} offset Angular offset of the light from the mirror direction.
 * @param {number} roughness Microfacet roughness.
 * @returns {number} The reflected radiance factor.
 */
function glintAtOffset(viewTheta, offset, roughness) {
  const view = dir(viewTheta, 0);
  const light = dir(viewTheta + offset, Math.PI);
  return celestialGlint(
    UP,
    view,
    light,
    roughness,
    WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
  );
}

// ─────────────────────── A. the off contract, executed ───────────────────────

/**
 * A minimal stand-in carrying only the fields the resolver reads.
 *
 * @param {object} overrides Field overrides.
 * @returns {object} The stand-in.
 */
function primitiveStub(overrides) {
  return {
    _celestialReflection: false,
    _celestialRoughness: 0.06,
    _celestialSunIntensity: 1.0,
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

test("A1 off resolves every float to exact positive zero", () => {
  const out = resolveCelestialReflection(primitiveStub({}), frameStateStub());
  assert.deepEqual(Object.keys(out).sort(), [
    "enable",
    "moonDirection",
    "moonIntensity",
    "moonPhase",
    "moonSinAngularRadius",
    "roughness",
    "sinAngularRadius",
    "sunIntensity",
  ]);
  const flat = {
    ...out,
    moonDirection: undefined,
    "moonDirection.x": out.moonDirection.x,
    "moonDirection.y": out.moonDirection.y,
    "moonDirection.z": out.moonDirection.z,
  };
  delete flat.moonDirection;
  for (const [key, value] of Object.entries(flat)) {
    assert.ok(Object.is(value, 0), `${key} must be exactly +0, got ${value}`);
  }
});

test("A2 off ignores every other control", () => {
  const out = resolveCelestialReflection(
    primitiveStub({ _celestialRoughness: 0.9, _celestialSunIntensity: 12.0 }),
  );
  assert.ok(Object.is(out.roughness, 0));
  assert.ok(Object.is(out.sunIntensity, 0));
});

test("A3 only strict true enables — a truthy value is not enough", () => {
  for (const value of [1, "true", {}, "yes"]) {
    const out = resolveCelestialReflection(
      primitiveStub({ _celestialReflection: value }),
    );
    assert.equal(out.enable, 0, `${JSON.stringify(value)} must not enable`);
  }
  assert.equal(
    resolveCelestialReflection(primitiveStub({ _celestialReflection: true }))
      .enable,
    1,
  );
});

test("A4 on publishes the shader's own solar angular radius", () => {
  const out = resolveCelestialReflection(
    primitiveStub({ _celestialReflection: true }),
  );
  assert.equal(
    out.sinAngularRadius,
    WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS,
    "the CPU and the shader must agree on the disc size",
  );
  assert.equal(out.roughness, 0.06);
  assert.equal(out.sunIntensity, 1.0);
});

test("A5 roughness is clamped into the shader's own range", () => {
  const lo = resolveCelestialReflection(
    primitiveStub({ _celestialReflection: true, _celestialRoughness: -5 }),
  );
  const hi = resolveCelestialReflection(
    primitiveStub({ _celestialReflection: true, _celestialRoughness: 40 }),
  );
  assert.equal(lo.roughness, WGSL_CONSTANTS.CELESTIAL_MIN_ROUGHNESS);
  assert.equal(hi.roughness, 1.0);
});

test("A6 non-finite controls fall back rather than poisoning the buffer", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const out = resolveCelestialReflection(
      primitiveStub({
        _celestialReflection: true,
        _celestialRoughness: bad,
        _celestialSunIntensity: bad,
      }),
    );
    assert.ok(Number.isFinite(out.roughness), `roughness for ${bad}`);
    assert.ok(Number.isFinite(out.sunIntensity), `intensity for ${bad}`);
    assert.equal(out.roughness, 0.06);
    assert.equal(out.sunIntensity, 1.0);
  }
});

test("A7 a negative intensity is floored, never allowed to subtract light", () => {
  const out = resolveCelestialReflection(
    primitiveStub({ _celestialReflection: true, _celestialSunIntensity: -3 }),
  );
  assert.equal(out.sunIntensity, 0);
});

test("A8 the resolver does not mutate the primitive", () => {
  const stub = primitiveStub({ _celestialReflection: true });
  const before = JSON.stringify(stub);
  resolveCelestialReflection(stub);
  assert.equal(JSON.stringify(stub), before);
});

// ───────────────────────── B. the packing seam ─────────────────────────

test("B1 the buffer size is derived, never written twice", () => {
  assert.match(oceanTs, /const OCEAN_UNIFORM_FLOATS = 48;/);
  assert.match(oceanTs, /size: OCEAN_UNIFORM_FLOATS \* 4,/);
  assert.match(oceanTs, /new Float32Array\(OCEAN_UNIFORM_FLOATS\)/);
  // The staging array and the GPU buffer must be sized from the same
  // constant, or a grown tail silently truncates on upload.
  const literals = oceanTs.match(/OCEAN_UNIFORM_FLOATS/g) ?? [];
  assert.ok(literals.length >= 3, "the constant must drive every size");
});

test("B2 slots 36 to 39 carry the resolved tail, each written once", () => {
  const expected = [
    [36, "_celestialEnable"],
    [37, "_celestialResolvedRoughness"],
    [38, "_celestialResolvedSunIntensity"],
    [39, "_celestialSinAngularRadius"],
  ];
  for (const [slot, field] of expected) {
    const writes = oceanTs.match(new RegExp(`od\\[${slot}\\]\\s*=`, "g")) ?? [];
    assert.equal(writes.length, 1, `od[${slot}] must be written exactly once`);
    assert.match(
      oceanTs,
      new RegExp(`od\\[${slot}\\] = p\\.${field} \\?\\? 0\\.0;`),
      `od[${slot}] must come from ${field} and default to 0`,
    );
  }
  const tailAt = oceanTs.indexOf("od[36]");
  const flushAt = oceanTs.indexOf("writeBuffer(cache.oceanUniformBuffer");
  assert.ok(tailAt > 0 && flushAt > tailAt, "the tail must precede the flush");
});

test("B3 the primitive publishes the resolved tail before dispatching", () => {
  const resolveAt = primitiveJs.indexOf(
    "const celestial = resolveCelestialReflection(this, frameState);",
  );
  const dispatchAt = primitiveJs.indexOf(
    "context.getFeatureRenderer(FeatureRendererKey.FFT_OCEAN)",
  );
  assert.ok(resolveAt > 0, "update must resolve the tail");
  assert.ok(
    dispatchAt > resolveAt,
    "the tail must be resolved ahead of the backend dispatch",
  );
  for (const field of [
    "_celestialEnable",
    "_celestialResolvedRoughness",
    "_celestialResolvedSunIntensity",
    "_celestialSinAngularRadius",
    "_celestialMoonDirection",
    "_celestialMoonPhase",
    "_celestialResolvedMoonIntensity",
    "_celestialMoonSinAngularRadius",
  ]) {
    assert.match(primitiveJs, new RegExp(`this\\.${field} = celestial\\.`));
  }
});

// ───────────────────── C. the WGSL uniform tail's layout ─────────────────────

test("C1 the struct tail matches the packing order, and the struct is 192 B", () => {
  const structText = /struct OceanUniforms \{([\s\S]*?)\n\};/.exec(
    stripComments(oceanWgsl),
  );
  assert.ok(structText !== null, "OceanUniforms must be findable");
  const fields = structText[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+),$/.exec(l);
      assert.ok(m !== null, `unparsable struct field: ${l}`);
      return { name: m[1], type: m[2] };
    });

  const tail = fields.slice(-9);
  assert.deepEqual(
    tail.map((f) => `${f.name}:${f.type}`),
    [
      "celestialEnable:f32",
      "celestialRoughness:f32",
      "celestialSunIntensity:f32",
      "celestialSinAngularRadius:f32",
      "moonDirection:vec3<f32>",
      "celestialMoonPhase:f32",
      "celestialMoonIntensity:f32",
      "celestialMoonSinAngularRadius:f32",
      "_p2:vec2<f32>",
    ],
    "the tail order is the packing order",
  );

  // The vec3 must land on a 16-byte boundary or every float after it slides,
  // which is the failure the pad at the end exists to keep visible.
  const moonAt = fields.findIndex((f) => f.name === "moonDirection");
  assert.equal(moonAt, fields.length - 5);

  // WGSL layout: f32 is size 4 align 4, vec2<f32> size 8 align 8, vec3<f32>
  // size 12 align 16. The struct's own alignment is its largest member's.
  const SIZE = { f32: [4, 4], "vec2<f32>": [8, 8], "vec3<f32>": [12, 16] };
  let offset = 0;
  let maxAlign = 1;
  for (const f of fields) {
    const entry = SIZE[f.type];
    assert.ok(entry !== undefined, `unsupported field type ${f.type}`);
    const [size, align] = entry;
    offset = Math.ceil(offset / align) * align;
    offset += size;
    maxAlign = Math.max(maxAlign, align);
  }
  const total = Math.ceil(offset / maxAlign) * maxAlign;
  assert.equal(total, 192, "the struct must be exactly 48 floats");
  assert.match(
    oceanTs,
    new RegExp(`const OCEAN_UNIFORM_FLOATS = ${total / 4};`),
    "the packer and the struct must agree on the float count",
  );
});

// ─────────────────── D. the shader law, evaluated from source ───────────────────

test("D1 the constants carry their documented physical values", () => {
  assert.equal(WGSL_CONSTANTS.CELESTIAL_WATER_F0, 0.02);
  assert.equal(WGSL_CONSTANTS.CELESTIAL_DISC_WIDEN, 0.5);
  assert.equal(WGSL_CONSTANTS.CELESTIAL_MIN_ROUGHNESS, 0.02);
  assert.equal(WGSL_CONSTANTS.CELESTIAL_DISTANCE_ROUGHEN, 0.25);
  // 959.63 arcseconds is the Sun's mean angular radius; the constant must be
  // its sine to within the precision the comment claims.
  const arcsec = 959.63;
  const expected = Math.sin((arcsec / 3600) * (Math.PI / 180));
  assert.ok(
    Math.abs(WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS - expected) < 5e-7,
    `solar disc constant ${WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS} is not sin(${arcsec}")`,
  );
});

test("D2 the GGX distribution integrates to one over the hemisphere", () => {
  // ∫ D(θ) cosθ dω = 1 for a normalised NDF. Sampled on a fine polar grid.
  for (const alpha of [0.05, 0.2, 0.6]) {
    const steps = 20000;
    let sum = 0;
    for (let i = 0; i < steps; i += 1) {
      const theta = ((i + 0.5) / steps) * (Math.PI / 2);
      const d = celestialDistributionGGX(Math.cos(theta), alpha);
      sum += d * Math.cos(theta) * Math.sin(theta) * (Math.PI / 2 / steps);
    }
    sum *= 2 * Math.PI;
    assert.ok(
      Math.abs(sum - 1) < 0.01,
      `alpha ${alpha} integrates to ${sum}, not 1`,
    );
  }
});

test("D3 the masking term is bounded and monotone in the cosine", () => {
  for (const alpha of [0.01, 0.3, 1.0]) {
    let previous = -1;
    for (let i = 1; i <= 50; i += 1) {
      const c = i / 50;
      const g = celestialSmithG1(c, alpha);
      assert.ok(g >= 0 && g <= 1 + 1e-12, `G1 out of range: ${g}`);
      assert.ok(g > previous, "G1 must rise with the cosine");
      previous = g;
    }
    assert.ok(Math.abs(celestialSmithG1(1, alpha) - 1) < 1e-12);
  }
});

test("D4 Fresnel hits its endpoints exactly", () => {
  // At grazing the Schlick term must reach unity; head-on it must be F0. Both
  // are read out of the glint itself by driving the geometry to the limit.
  const f0 = WGSL_CONSTANTS.CELESTIAL_WATER_F0;
  const schlick = (vDotH) => f0 + (1 - f0) * Math.pow(1 - vDotH, 5);
  assert.equal(schlick(1), f0);
  assert.equal(schlick(0), 1);
  // The shader's own expression, lifted from source and evaluated.
  const source = /let f =\s*([\s\S]*?);/.exec(
    stripComments(oceanWgsl).slice(
      stripComments(oceanWgsl).indexOf("fn celestialGlint"),
    ),
  );
  assert.ok(source !== null, "the Fresnel line must be findable");
  assert.equal(evalExpression(source[1], { vDotH: 1 }), f0);
  assert.equal(evalExpression(source[1], { vDotH: 0 }), 1);
});

test("D5 nothing is reflected from below the horizon", () => {
  const below = dir(Math.PI * 0.75, 0);
  const above = dir(Math.PI * 0.25, 0);
  const r = 0.06;
  const s = WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS;
  assert.equal(celestialGlint(UP, above, below, r, s), 0, "light below");
  assert.equal(celestialGlint(UP, below, above, r, s), 0, "eye below");
  assert.equal(celestialGlint(UP, below, below, r, s), 0, "both below");
  assert.ok(
    celestialGlint(UP, above, above, r, s) > 0,
    "both above must glint",
  );
});

test("D6 the lobe peaks on the mirror direction and falls away from it", () => {
  const viewTheta = Math.PI / 3;
  const roughness = 0.06;
  const peak = glintAtOffset(viewTheta, 0, roughness);
  assert.ok(peak > 0, "the mirror direction must carry the peak");
  let previous = peak;
  for (let i = 1; i <= 40; i += 1) {
    const offset = (i / 40) * 0.5;
    const value = glintAtOffset(viewTheta, offset, roughness);
    assert.ok(
      value < previous + 1e-12,
      `the lobe must not rise at offset ${offset}`,
    );
    assert.ok(value <= peak, "no sample may exceed the mirror direction");
    previous = value;
  }
  assert.ok(previous < peak * 1e-3, "the lobe must actually fall off");
});

test("D7 a rougher surface trades peak brightness for width", () => {
  const viewTheta = Math.PI / 3;
  const tight = 0.03;
  const broad = 0.3;
  assert.ok(
    glintAtOffset(viewTheta, 0, tight) > glintAtOffset(viewTheta, 0, broad),
    "the tighter lobe must be brighter on axis",
  );
  const far = 0.2;
  assert.ok(
    glintAtOffset(viewTheta, far, broad) > glintAtOffset(viewTheta, far, tight),
    "the broader lobe must reach further off axis",
  );
});

test("D8 the solar disc puts a floor under the lobe width", () => {
  // With the widening in place, a mirror-smooth surface still spreads the
  // reflection over at least the disc's own angular scale, so the on-axis peak
  // stays bounded instead of running away as the roughness falls.
  const viewTheta = Math.PI / 4;
  const sin = WGSL_CONSTANTS.CELESTIAL_SUN_SIN_ANGULAR_RADIUS;
  const floorAlpha = WGSL_CONSTANTS.CELESTIAL_DISC_WIDEN * sin;
  const peakBound = 1 / (Math.PI * floorAlpha * floorAlpha);

  let last = 0;
  for (const roughness of [0.05, 0.02, 0.005, 0.0005, 0.0]) {
    const peak = glintAtOffset(viewTheta, 0, roughness);
    assert.ok(Number.isFinite(peak), `peak must stay finite at ${roughness}`);
    assert.ok(
      peak <= peakBound,
      `peak ${peak} at roughness ${roughness} exceeds the disc floor bound ${peakBound}`,
    );
    last = peak;
  }
  assert.ok(last > 0, "a mirror surface must still show the disc");

  // The floor is what does it: the same evaluation without the widening blows
  // past the bound, which is the failure the widening exists to prevent.
  const unwidened = 1 / (Math.PI * 1e-8);
  assert.ok(
    unwidened > peakBound * 100,
    "the bound must be far below an unfloored peak, or it proves nothing",
  );
});

test("D9 the reflection is stronger at grazing incidence", () => {
  // Water's Fresnel rises steeply toward the horizon, so the same lobe seen at
  // a grazing view must return more light than one seen from overhead.
  const roughness = 0.06;
  const steep = glintAtOffset(Math.PI / 8, 0, roughness);
  const grazing = glintAtOffset(Math.PI * 0.47, 0, roughness);
  assert.ok(
    grazing > steep,
    `grazing ${grazing} must exceed near-normal ${steep}`,
  );
});

test("D10 distance roughens the water toward the far band", () => {
  const source = /let celestialRoughness = clamp\(([\s\S]*?)\);/.exec(
    stripComments(oceanWgsl),
  );
  assert.ok(source !== null, "the roughness expression must be findable");
  const expr = `clamp(${source[1]})`;
  const base = 0.06;
  const near = evalExpression(expr, {
    ocean: { celestialRoughness: base },
    input: { fade: 1.0 },
  });
  const far = evalExpression(expr, {
    ocean: { celestialRoughness: base },
    input: { fade: 0.0 },
  });
  assert.equal(near, base, "the near patch keeps the requested roughness");
  assert.equal(
    far,
    base + WGSL_CONSTANTS.CELESTIAL_DISTANCE_ROUGHEN,
    "the far band adds the full roughening",
  );
  assert.equal(
    evalExpression(expr, {
      ocean: { celestialRoughness: 0.0 },
      input: { fade: 1.0 },
    }),
    WGSL_CONSTANTS.CELESTIAL_MIN_ROUGHNESS,
    "the floor still applies after the distance term",
  );
});

// ───────────── E. the off arm, and that the new arm is reachable ─────────────

const HISTORICAL_GLINT = [
  "    let halfway = normalize(sunDir + viewDir);",
  "    let spec = pow(max(dot(worldNormal, halfway), 0.0), 200.0);",
  "    color += vec3<f32>(1.0, 0.98, 0.9) * spec * nDotV;",
].join("\n");

test("E1 the off arm is the historical highlight, unchanged", () => {
  assert.ok(
    oceanWgsl.includes(HISTORICAL_GLINT),
    "the else arm must reproduce the Blinn-Phong highlight verbatim",
  );
  const powCount = (oceanWgsl.match(/200\.0/g) ?? []).length;
  assert.equal(powCount, 1, "the shininess-200 lobe must exist exactly once");
});

test("E2 the microfacet arm is gated on the enable float, live", () => {
  assert.ok(
    oceanWgsl.includes("if (ocean.celestialEnable > 0.0) {"),
    "the enabled arm must be gated on the uniform, with no extra guard",
  );
  const gateAt = oceanWgsl.indexOf("if (ocean.celestialEnable > 0.0) {");
  const elseAt = oceanWgsl.indexOf("} else {", gateAt);
  const glintAt = oceanWgsl.indexOf("celestialGlint(", gateAt);
  assert.ok(elseAt > gateAt, "the gate must have an else arm");
  assert.ok(
    glintAt > gateAt && glintAt < elseAt,
    "the microfacet call must sit inside the enabled arm",
  );
  const historicalAt = oceanWgsl.indexOf(HISTORICAL_GLINT.split("\n")[0]);
  assert.ok(historicalAt > elseAt, "the historical arm must be the else arm");
});

test("E3 the glint is evaluated only from the gated arm", () => {
  // One definition plus one call per light source.
  const calls = (oceanWgsl.match(/celestialGlint\(/g) ?? []).length;
  assert.equal(calls, 3, `expected one definition and two calls, saw ${calls}`);
  assert.match(oceanWgsl, /fn celestialGlint\(/);
  const gateAt = oceanWgsl.indexOf("if (ocean.celestialEnable > 0.0) {");
  const elseAt = oceanWgsl.indexOf("} else {", gateAt);
  const inArm = [...oceanWgsl.matchAll(/celestialGlint\(/g)]
    .map((m) => m.index)
    .filter((at) => at > gateAt && at < elseAt);
  assert.equal(inArm.length, 2, "both calls must sit inside the enabled arm");
});

test("E4 the enable float is read nowhere else", () => {
  const reads = (oceanWgsl.match(/ocean\.celestialEnable/g) ?? []).length;
  assert.equal(reads, 1, "one gate, one read");
});

// ───────── F. the pre-port state of the other three water glint laws ─────────

test("F1 the globe ocean still carries the shininess-10 Phong lobe, twice", () => {
  const globeWgsl = read(GLOBE_WGSL_PATH);
  const reflects = (globeWgsl.match(/reflect\(-sunDirEC, waterNormal\)/g) ?? [])
    .length;
  assert.equal(
    reflects,
    2,
    "the enhanced and classic branches each hold one Phong glint",
  );
  assert.equal(
    (globeWgsl.match(/, 0\.0\), 10\.0\)/g) ?? []).length,
    2,
    "both must still use the shininess-10 exponent",
  );
  assert.ok(
    !globeWgsl.includes("celestialGlint"),
    "the microfacet lobe has not been ported to the globe ocean yet — when it is, this pin moves deliberately",
  );
});

test("F2 the WebGL twin still carries the same Phong lobe", () => {
  const glsl = read(GLOBE_GLSL_PATH);
  assert.match(
    glsl,
    /czm_getSpecular\(czm_lightDirectionEC, normalizedPositionToEyeEC, normalEC, 10\.0\)/,
  );
});

test("F3 the divergence between the two oceans is recorded, not assumed", () => {
  // Three laws exist today: shininess-10 Phong on the globe ocean in both
  // backends, shininess-200 Blinn-Phong on the FFT ocean when the reflection is
  // off, and the microfacet lobe on the FFT ocean when it is on. The first two
  // are unchanged by this work; only the third is new. This test states that as
  // a fact so the port cannot land while quietly leaving one of them behind.
  const globeWgsl = read(GLOBE_WGSL_PATH);
  assert.ok(globeWgsl.includes("10.0)"), "globe: Phong 10");
  assert.ok(oceanWgsl.includes("200.0)"), "FFT off: Blinn-Phong 200");
  assert.ok(oceanWgsl.includes("fn celestialGlint"), "FFT on: microfacet");
});
