// C13-N11 — the tier lighting dials are wired: powderStrength, isotropicFloor, ambientFloor.
// @purpose C13-N11: pins the 172-175 tail slots and the 176-float block, the conditional powder byte-identity at 0.5, the guarded floors' neutrality at 0, each dial's authority and direction, the byte-identity equivalence (identical IFF powder 0.5 and both floors 0) with the per-tier delta reported, the consumer-side parse that makes a neutered powder use observable, and QF_PROFILE_ON deprecated in place.
// @status ACTIVE
//
// PREMISE THIS FILE PINS, RE-DERIVED AT THE TREE 2026-09-13.
// Three `CloudTierPreset` fields — `powderStrength`, `isotropicFloor`,
// `ambientFloor` — existed only inside `WebGPUCloudTierPresets.ts` with NO
// READER anywhere: `ProceduralClouds.wgsl` hard-coded `powder = 0.5` at its one
// `multiScatterLight` call site and had no isotropic or ambient floor at all.
// The tier table's whole lighting column was therefore decorative: a tier could
// declare any powder signature it liked and every tier rendered the same one.
// This file pins the shader half of the wiring and the preset half. The
// renderer's packing site (`CLOUD_UNIFORM_FLOATS`, slots 172/173/174) is landed
// by a different lane and is DELIBERATELY NOT ASSERTED HERE — an assertion on a
// file this row does not own would go red on someone else's landing, not on a
// defect.
//
// WHAT IS ASSERTED, AND WHY IN THIS FORM.
//
//  1. LAYOUT. The dial row is the struct TAIL at slots 172-175 and the block is
//     176 floats. The slot NUMBERS are the contract with the packing site, so
//     they are computed from the declared field widths and cross-checked
//     against the shipped slot comments rather than copied from them. A
//     decomposition may move a line; it may never move a slot.
//  2. NEUTRALITY, with `assert.equal` and no tolerance. `powderStrength` is
//     byte-identical to the code it replaces exactly when the preset carries
//     0.5, because 0.5 was the literal — a CONDITIONAL identity, and the
//     measurement in (5) is what says which tiers meet the condition. The two
//     floors are neutral at 0 by construction, behind an explicit `> 0.0`
//     guard, the same idiom `genusForwardG` uses at its delta-0 early return.
//     Equality here is exact because both sides are the same f64 evaluation of
//     two source texts: it is a statement about the EXPRESSIONS, not a claim
//     about a device's f32.
//  3. AUTHORITY AND DIRECTION. Each dial moves the modelled value away from its
//     neutral setting, and in the only direction its arithmetic permits: a
//     floor can raise and never lower; powder can only darken, because
//     `mix(beer, beer * powderEffect, powder)` interpolates toward a term that
//     is `beer` scaled by a factor in [0, 1).
//  4. BAR A4's DIRECTION ONLY. A4 is "powder signature: backscatter
//     edge/interior <= 0.80". What is asserted is that `powderStrength` has
//     AUTHORITY over that statistic and moves it the way A4 scores. The 0.80
//     threshold is NOT pre-registered here: the modelled ratio is a
//     lighting-only proxy with no silver lining, ambient, transmittance
//     weighting or tone map, and the bar is measured on a rendered frame.
//  5. THE PRESET TABLE IS THE SOURCE, AND IS MEASURED RATHER THAN PINNED. The
//     tiers are imported, and what is ASSERTED is an equivalence — a tier is
//     byte-identical to the pre-wiring march if and only if it carries the
//     neutral values (powder 0.5, both floors 0). The per-tier state is
//     REPORTED, never hard-coded: the table lives in another lane's file, so a
//     spec restating its literals would certify the table instead of the wiring
//     and go red on that lane's landing rather than on a defect.
//     As first measured (2026-09-12) no tier carried 0.5 — the table was
//     0 / 0 / 0.4 / 0.7 — so reading the slot moved the image at every tier and
//     stripped the powder term outright at tiers 0-1, a 99.52 % max relative
//     delta. That measurement is why the seat ruled the presets pinned to the
//     pre-wiring literal, with the tuning filed as a follow-up under C13-N11.
//
// WHAT IS EXECUTED AND WHAT IS TRANSCRIBED — AND WHAT THE TRANSCRIPTION COSTS.
//
// `hgPhase`, `genusForwardG` and `effectiveAbsorption` are EXECUTED straight
// out of the shipped WGSL through `lib/wgsl-mini-eval.mjs`, so the phase and
// extinction arithmetic in every number below came from the text that ships.
// The octave ACCUMULATION cannot be: `multiScatterLight` is a `for` loop with
// in-place assignment inside an `if`, and the evaluator fails closed on both
// (it supports only guarded `return`s). That half is transcribed into
// `accumulateOctaves` below.
//
// The cost of a transcription is that it certifies itself: change the loop's
// arithmetic in the shader and these numbers do not move. Two things bound that
// cost. First, the transcription's WIRING is not transcribed — it is PARSED
// from the shipped source by `parseWiring` — which argument the call site passes,
// WHICH ARGUMENT THE LOOP BODY CONSUMES, and whether each floor is guarded,
// ungated or absent — and the model behaves as the parse says, so a mutation to
// the wiring changes the model's numbers. The consumer half was added 2026-09-13:
// without it, neutering the use inside the loop left slot 172 handed in and
// dropped while every assertion here stayed green. Second,
// the structural predicates (`assertPowderCallSite`, `assertGuardedFloor`) are
// asserted directly and are the same functions the mutants are run against. The
// residue — someone rewriting the octave recurrence itself — is covered by the
// row's browser acceptance, not here.
//
// WHAT IS NOT ASSERTED. Rendered luminance, the A4 threshold, the renderer's
// packing site, and the non-CUMULUS `genusForwardG` branch (C13-N21's row; the
// evaluator cannot read that branch's trailing-comma argument list, noted here
// so the gap is visible rather than silently routed around).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  readConstants,
  stripComments,
} from "./lib/wgsl-mini-eval.mjs";

import {
  CLOUD_QF_PROFILE_ON,
  CLOUD_TIER_PRESETS,
  resolveCloudPreset,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const CLOUD_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl";
const SHADER_DIR = "packages/engine/Source/Shaders/WebGPU";
const shippedSource = read(CLOUD_WGSL);

// The preset table is imported (Node 22 strips types, and this module has no
// relative imports, so it needs no resolver hook). Reading it as text would
// have pinned the literals' SPELLING rather than their VALUES, and the row is
// about what the tiers resolve to.
const TIER_PRESETS = CLOUD_TIER_PRESETS;

// ── Source shape ─────────────────────────────────────────────────────────────

/**
 * Extract one WGSL function's full text by brace matching.
 *
 * @param {string} source WGSL source text.
 * @param {string} name Function name.
 * @returns {string} The `fn name(...) { ... }` text.
 */
function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  assert.fail(`unterminated function ${name}`);
}

/** Float width of each WGSL type the uniform block uses. */
const TYPE_WIDTH = Object.freeze({
  f32: 1,
  i32: 1,
  u32: 1,
  "vec2<f32>": 2,
  "vec3<f32>": 3,
  "vec4<f32>": 4,
  "mat4x4<f32>": 16,
});

/**
 * Parse `struct CloudUniforms` into ordered fields with COMPUTED slot offsets.
 *
 * The offsets are derived from the declared types, never read from the trailing
 * comments — the comments are then checked against them, which is the only
 * ordering that can catch a comment that lies.
 *
 * @param {string} source WGSL source text.
 * @returns {{fields: Array<{name: string, type: string, width: number, from: number, to: number, comment: string}>, total: number}} The layout.
 */
function parseCloudUniforms(source) {
  const start = source.indexOf("struct CloudUniforms");
  assert.notEqual(start, -1, "struct CloudUniforms not found");
  const end = source.indexOf("};", start);
  assert.notEqual(end, -1, "unterminated struct CloudUniforms");
  const fields = [];
  let offset = 0;
  for (const line of source.slice(start, end).split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)\s*,(.*)$/,
    );
    if (match === null) {
      continue;
    }
    const [, name, type, trailing] = match;
    const width = TYPE_WIDTH[type];
    assert.ok(width !== undefined, `unhandled uniform type ${type} on ${name}`);
    fields.push({
      name,
      type,
      width,
      from: offset,
      to: offset + width - 1,
      comment: trailing.trim(),
    });
    offset += width;
  }
  return { fields, total: offset };
}

/**
 * Read a field's declared slot range out of its trailing comment.
 *
 * @param {{comment: string}} field A parsed field.
 * @returns {{from: number, to: number}|undefined} The declared range, if any.
 */
function declaredSlots(field) {
  const match = field.comment.match(/^\/\/\s*(\d+)(?:\s*-\s*(\d+))?/);
  if (match === null) {
    return undefined;
  }
  const from = Number(match[1]);
  return { from, to: match[2] === undefined ? from : Number(match[2]) };
}

// The dial row, and the block it was appended to. Both are the contract with
// the renderer's packing site.
const DIAL_ROW = Object.freeze([
  { name: "powderStrength", slot: 172 },
  { name: "isotropicFloor", slot: 173 },
  { name: "ambientFloor", slot: 174 },
  { name: "_padQ", slot: 175 },
]);
const CLOUD_UNIFORM_TOTAL_FLOATS = 176;
// The block immediately before the dial row, spot-checked so an "append" that
// silently reordered its neighbours is caught.
const PRECEDING_BLOCK = Object.freeze([
  { name: "densityMorphologyOriginHigh", from: 160, to: 162 },
  { name: "_padO", from: 163, to: 163 },
  { name: "densityMorphologyOriginLow", from: 164, to: 166 },
  { name: "_padP", from: 167, to: 167 },
  { name: "genusFibreStrength", from: 168, to: 168 },
  { name: "genusFibreAnisotropy", from: 169, to: 169 },
  { name: "genusFibreShear", from: 170, to: 170 },
  { name: "genusPhaseDelta", from: 171, to: 171 },
]);
// Slot comments are cross-checked from here to the tail. Earlier fields predate
// the convention and one of them (`coverage: f32, // 0-1, global cloud
// coverage`) carries a VALUE range in the same position, which a global check
// would read as a slot claim. The scope is stated so it cannot be mistaken for
// coverage it does not have.
const SLOT_COMMENT_CHECK_FROM = 100;

// ── Wiring, parsed from the shipped source ───────────────────────────────────

/**
 * Classify how a floor reaches its target: behind the documented `> 0.0` guard,
 * applied with no gate at all, or absent.
 *
 * @param {string} body Comment-stripped function text.
 * @param {string} uniform Escaped uniform member, e.g. `cloud\\.ambientFloor`.
 * @param {string} apply Escaped assignment text, without the semicolon.
 * @returns {"guarded"|"ungated"|"absent"} The classification.
 */
function classifyFloor(body, uniform, apply) {
  const guarded = new RegExp(
    `if\\s*\\(\\s*${uniform}\\s*>\\s*0\\.0\\s*\\)\\s*\\{\\s*${apply}\\s*;\\s*\\}`,
  );
  if (guarded.test(body)) {
    return "guarded";
  }
  return new RegExp(`${apply}\\s*;`).test(body) ? "ungated" : "absent";
}

/**
 * Read the three dials' wiring out of one WGSL source string.
 *
 * Parsed from the COMMENT-STRIPPED text: the prose above each site quotes the
 * code it replaced (`powder = 0.5`), so a reader that kept the comments would
 * report the historical wiring as if it still shipped.
 *
 * @param {string} source WGSL source text.
 * @returns {{powderArgument: string, phaseMutable: boolean, ambientMutable: boolean, isotropic: string, ambient: string, callSites: number}} The wiring.
 */
function parseWiring(source) {
  const stripped = stripComments(source);
  const march = functionSource(stripped, "marchDeck");
  const octaves = functionSource(stripped, "multiScatterLight");
  const call = march.match(
    /multiScatterLight\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/,
  );
  assert.notEqual(call, null, "no multiScatterLight call site in marchDeck");
  // The CONSUMER, not merely the call site. ADDED 2026-09-13 after adversarial
  // verification (Saradoc) landed a mutant this file could not see: leave the
  // call site passing `cloud.powderStrength` and neuter the use INSIDE the
  // function — `mix(beer, beer * powderEffect, powder)` → `…, 0.5)` — and slot
  // 172 then reaches nothing while this spec stayed 27/27 GREEN. The call site
  // says what is handed in; this says whether the body uses it. Reading only the
  // first lets the twin honour an argument the shader ignores.
  const consumer = octaves.match(
    /let\s+bp\s*=\s*mix\(\s*beer\s*,\s*beer\s*\*\s*powderEffect\s*,\s*([^)]+?)\s*\)/,
  );
  assert.notEqual(
    consumer,
    null,
    "the beer-powder mix inside multiScatterLight could not be located — this spec is stale",
  );
  return {
    powderArgument: call[3],
    powderConsumer: consumer[1],
    // The `fn` declaration is not a call site, and `cloudPhase` is not a second
    // entry point — the march's radiance comes entirely from this one call.
    definitions: (stripped.match(/fn\s+multiScatterLight\(/g) ?? []).length,
    callSites: (stripped.match(/(?<!fn\s)multiScatterLight\(/g) ?? []).length,
    phaseMutable: /var\s+ph\s*=\s*mix\(/.test(octaves),
    ambientMutable: /var\s+ambient\s*=\s*mix\(/.test(march),
    isotropic: classifyFloor(
      octaves,
      "cloud\\.isotropicFloor",
      "ph\\s*=\\s*max\\(\\s*ph\\s*,\\s*cloud\\.isotropicFloor\\s*\\)",
    ),
    ambient: classifyFloor(
      march,
      "cloud\\.ambientFloor",
      "ambient\\s*=\\s*max\\(\\s*ambient\\s*,\\s*vec3<f32>\\(\\s*cloud\\.ambientFloor\\s*\\)\\s*\\)",
    ),
  };
}

/**
 * The powder argument must be the uniform, at the single call site.
 *
 * Shared by the passing test and by the mutants, so the RED/GREEN pair runs one
 * predicate rather than two similar ones.
 *
 * @param {{powderArgument: string, callSites: number, definitions: number}} wiring Parsed wiring.
 * @returns {void}
 */
function assertPowderCallSite(wiring) {
  assert.equal(
    wiring.powderArgument,
    "cloud.powderStrength",
    "the march must pass slot 172, not a literal",
  );
  assert.equal(wiring.definitions, 1, "multiScatterLight must be defined once");
  assert.equal(
    wiring.callSites,
    1,
    "multiScatterLight must have one call site",
  );
  // Handed in AND used. Passing slot 172 to a body that ignores it is the
  // shape adversarial verification found surviving on 2026-09-13.
  assert.equal(
    wiring.powderConsumer,
    "powder",
    "multiScatterLight's beer-powder mix must consume its powder parameter, " +
      "not a literal — otherwise slot 172 is handed in and dropped",
  );
}

/**
 * A floor must be applied behind the explicit `> 0.0` guard on a mutable
 * binding.
 *
 * @param {object} wiring Parsed wiring.
 * @param {"isotropic"|"ambient"} which Which floor.
 * @returns {void}
 */
function assertGuardedFloor(wiring, which) {
  assert.equal(
    wiring[which],
    "guarded",
    `the ${which} floor must sit behind an explicit > 0.0 test`,
  );
  const mutable = which === "isotropic" ? "phaseMutable" : "ambientMutable";
  assert.equal(wiring[mutable], true, `the ${which} target must be a var`);
}

/**
 * Apply a regex mutation and fail loudly if it matched nothing.
 *
 * `ProceduralClouds.wgsl` is CRLF, so a multi-line string literal matches
 * nothing here; every pattern is a regex whose whitespace is `\\s*`. A pattern
 * that stops matching must THROW, never silently leave the source unmutated and
 * let the mutant pass as if the fix were load bearing.
 *
 * @param {string} source Source to mutate.
 * @param {RegExp} pattern What to replace.
 * @param {string} replacement The replacement text.
 * @returns {string} The mutated source.
 */
function mutate(source, pattern, replacement) {
  const mutated = source.replace(pattern, replacement);
  assert.notEqual(
    mutated,
    source,
    `mutation pattern ${pattern} matched nothing — the spec is stale`,
  );
  return mutated;
}

const POWDER_CALL_PATTERN =
  /multiScatterLight\(\s*lightOpticalDepth,\s*cosTheta,\s*cloud\.powderStrength,\s*msOctaves\s*\)/;
const ISOTROPIC_GUARD_PATTERN =
  /if \(cloud\.isotropicFloor > 0\.0\) \{\s*ph = max\(ph, cloud\.isotropicFloor\);\s*\}/;
const AMBIENT_GUARD_PATTERN =
  /if \(cloud\.ambientFloor > 0\.0\) \{\s*ambient = max\(ambient, vec3<f32>\(cloud\.ambientFloor\)\);\s*\}/;

// ── The model ────────────────────────────────────────────────────────────────

// Stations, not defaults. These are the values the renderer packs at this tree
// (`WebGPUProceduralCloudRenderer.ts`, read 2026-09-13), used here only to put
// the model in a plausible place; every property below is additionally swept, so
// none of them rests on this particular row. `genusPhaseDelta` is held at 0
// (CUMULUS) — the non-zero branch is C13-N21's row, and the evaluator cannot
// read its trailing-comma `clamp(...)` argument list.
const CANONICAL_UNIFORMS = Object.freeze({
  phaseG1: 0.85,
  phaseG2: -0.3,
  phaseBlend: 0.7,
  genusPhaseDelta: 0,
  absorptionCoeff: 0.04,
  profileExtinction: 1,
  msDecayA: 0.5,
  msDecayB: 0.5,
  msDecayC: 0.85,
  ambientIntensity: 0.4,
  powderStrength: 0,
  isotropicFloor: 0,
  ambientFloor: 0,
});

/** Uniform rows the properties are swept over, so no claim rests on one row. */
const UNIFORM_VARIANTS = Object.freeze([
  {},
  { phaseBlend: 0.35, phaseG2: -0.5, absorptionCoeff: 0.12 },
  { msDecayA: 0.65, msDecayB: 0.4, msDecayC: 0.95, phaseG1: 0.78 },
]);

/** Light-march optical depths, from a thin edge to a deep interior. */
const OPTICAL_DEPTHS = Object.freeze([0.05, 0.2, 0.6, 1.5, 4, 12]);
/** Scattering angles, backscatter through the forward lobe. */
const COS_THETAS = Object.freeze([-1, -0.6, -0.2, 0.2, 0.5, 0.9]);
/** Octave counts reachable from `qualityFlags` bits 4-6 via the tier table. */
const OCTAVE_COUNTS = Object.freeze([1, 2, 3]);

/** Every (variant, opticalDepth, cosTheta, octaves) station. */
const STATIONS = UNIFORM_VARIANTS.flatMap((uniforms) =>
  OPTICAL_DEPTHS.flatMap((opticalDepth) =>
    COS_THETAS.flatMap((cosTheta) =>
      OCTAVE_COUNTS.map((octaves) => ({
        uniforms,
        opticalDepth,
        cosTheta,
        octaves,
      })),
    ),
  ),
);

/**
 * WGSL `mix`, spelled as the specification defines it.
 *
 * @param {number} x Value at s = 0.
 * @param {number} y Value at s = 1.
 * @param {number} s Blend.
 * @returns {number} The blended value.
 */
const mix = (x, y, s) => x * (1 - s) + y * s;

/**
 * Compile the executable half of the lighting model out of a WGSL source.
 *
 * @param {string} source WGSL source text.
 * @returns {object} The model: a mutable `cloud` uniform bag, the compiled
 *   shader functions, and the wiring parsed from the same text.
 */
function buildModel(source) {
  const stripped = stripComments(source);
  const constants = readConstants(stripped);
  const cloud = { ...CANONICAL_UNIFORMS };
  const globals = { ...constants, cloud, __functions: { exp: Math.exp } };
  return {
    cloud,
    constants,
    wiring: parseWiring(source),
    hgPhase: compileFunction(stripped, "hgPhase", globals),
    genusForwardG: compileFunction(stripped, "genusForwardG", globals),
    effectiveAbsorption: compileFunction(
      stripped,
      "effectiveAbsorption",
      globals,
    ),
  };
}

/**
 * Resolve the powder value the march actually passes, as the PARSED call site
 * says — the uniform when it reads slot 172, the literal when it does not.
 *
 * @param {object} model A built model.
 * @returns {number} The powder argument's value.
 */
function resolvePowder(model) {
  const text = model.wiring.powderArgument;
  if (text === "cloud.powderStrength") {
    return model.cloud.powderStrength;
  }
  const literal = Number(text);
  assert.ok(
    Number.isFinite(literal),
    `unreadable powder argument ${JSON.stringify(text)}`,
  );
  return literal;
}

/**
 * Per-octave multi-scatter accumulation — TRANSCRIBED from `fn
 * multiScatterLight`, because the evaluator fails closed on its `for` loop and
 * on assignment inside an `if`. The phase and extinction it calls are executed
 * from the shipped source; the floor's application follows the parsed wiring
 * rather than a hard-coded shape, so a mutation to the guard changes what this
 * function does.
 *
 * @param {object} model A built model.
 * @param {number} opticalDepth Light-march optical depth at the sample.
 * @param {number} cosTheta Cosine of the scattering angle.
 * @param {number} powder The resolved `powder` argument.
 * @param {number} octaves Octave count.
 * @returns {number} The scattered-light term, phase included.
 */
function accumulateOctaves(model, opticalDepth, cosTheta, powder, octaves) {
  const { cloud, wiring } = model;
  const a = cloud.msDecayA;
  const b = cloud.msDecayB;
  const c = cloud.msDecayC;
  const n = Math.max(octaves, 1);
  const absorb = model.effectiveAbsorption();
  const forwardG = model.genusForwardG();
  let luminance = 0;
  let total = 0;
  let scat = 1;
  let ext = 1;
  let ecc = 1;
  for (let i = 0; i < n; i += 1) {
    const beer = Math.exp(-opticalDepth * absorb * ext);
    const powderEffect = 1 - Math.exp(-opticalDepth * absorb * 2 * ext);
    // The twin uses what the BODY uses, read from the shipped text: the passed
    // argument when the body says `powder`, the literal when it says a number.
    // Without this the twin would honour a parameter the shader ignores, and a
    // mutant that neuters the consumer would leave every "the dial is live"
    // assertion GREEN while slot 172 reached nothing.
    const consumed =
      wiring.powderConsumer === "powder"
        ? powder
        : Number(wiring.powderConsumer);
    assert.ok(
      Number.isFinite(consumed),
      `unreadable powder consumer ${JSON.stringify(wiring.powderConsumer)}`,
    );
    const bp = mix(beer, beer * powderEffect, consumed);
    let ph = mix(
      model.hgPhase(cosTheta, cloud.phaseG2 * ecc),
      model.hgPhase(cosTheta, forwardG * ecc),
      cloud.phaseBlend,
    );
    if (
      wiring.isotropic === "ungated" ||
      (wiring.isotropic === "guarded" && cloud.isotropicFloor > 0)
    ) {
      ph = Math.max(ph, cloud.isotropicFloor);
    }
    luminance += scat * bp * ph;
    total += scat;
    scat = scat * a;
    ext = ext * b;
    ecc = ecc * c;
  }
  return luminance / Math.max(total, 1e-6);
}

/**
 * Evaluate the march's light term at one station, through the parsed call site.
 *
 * @param {object} model A built model.
 * @param {{uniforms?: object, opticalDepth: number, cosTheta: number, octaves: number}} station The station.
 * @param {object} [dials] Dial values to install before evaluating.
 * @returns {number} The station's light term.
 */
function lightAt(model, station, dials = {}) {
  Object.assign(model.cloud, CANONICAL_UNIFORMS, station.uniforms ?? {}, dials);
  return accumulateOctaves(
    model,
    station.opticalDepth,
    station.cosTheta,
    resolvePowder(model),
    station.octaves,
  );
}

/**
 * The per-octave phase the floor bounds, with no floor applied. Used to measure
 * where a given floor can bite at all.
 *
 * @param {object} model A built model.
 * @param {{uniforms?: object, cosTheta: number, octaves: number}} station The station.
 * @returns {number[]} The phase of each octave.
 */
function octavePhases(model, station) {
  Object.assign(model.cloud, CANONICAL_UNIFORMS, station.uniforms ?? {});
  const { cloud } = model;
  const forwardG = model.genusForwardG();
  const out = [];
  let ecc = 1;
  for (let i = 0; i < Math.max(station.octaves, 1); i += 1) {
    out.push(
      mix(
        model.hgPhase(station.cosTheta, cloud.phaseG2 * ecc),
        model.hgPhase(station.cosTheta, forwardG * ecc),
        cloud.phaseBlend,
      ),
    );
    ecc = ecc * cloud.msDecayC;
  }
  return out;
}

/**
 * The march's ambient fill — TRANSCRIBED from `marchDeck`, whose 400-line body
 * is far outside the evaluator's subset. Per channel, as the shader writes it,
 * and gated on the parsed wiring for the same reason `accumulateOctaves` is.
 *
 * @param {object} model A built model.
 * @param {[number, number, number]} groundColor Ground-hemisphere ambient.
 * @param {[number, number, number]} skyColor Sky-hemisphere ambient.
 * @param {number} heightFraction Height through the deck.
 * @returns {[number, number, number]} The ambient fill.
 */
function ambientFill(model, groundColor, skyColor, heightFraction) {
  const { cloud, wiring } = model;
  const ambient = groundColor.map(
    (g, i) => mix(g, skyColor[i], heightFraction) * cloud.ambientIntensity,
  );
  if (
    wiring.ambient === "ungated" ||
    (wiring.ambient === "guarded" && cloud.ambientFloor > 0)
  ) {
    return ambient.map((v) => Math.max(v, cloud.ambientFloor));
  }
  return ambient;
}

const shipped = buildModel(shippedSource);

// The code this row replaced: the literal at the call site, and neither floor.
// Built by MUTATING the shipped text, so it is the shipped shader minus exactly
// the three edits rather than a hand-written "what I think it used to be".
const historicalSource = mutate(
  mutate(
    mutate(
      shippedSource,
      POWDER_CALL_PATTERN,
      "multiScatterLight(lightOpticalDepth, cosTheta, 0.5, msOctaves)",
    ),
    ISOTROPIC_GUARD_PATTERN,
    "",
  ),
  AMBIENT_GUARD_PATTERN,
  "",
);
const historical = buildModel(historicalSource);

// ── Layout ───────────────────────────────────────────────────────────────────

test("the dial row is the struct tail, at slots 172-175", () => {
  const { fields, total } = parseCloudUniforms(shippedSource);
  const tail = fields.slice(-DIAL_ROW.length);
  assert.deepEqual(
    tail.map((f) => ({ name: f.name, slot: f.from })),
    DIAL_ROW.map((d) => ({ name: d.name, slot: d.slot })),
    "the four dial floats must be the last four fields, in slot order",
  );
  for (const field of tail) {
    assert.equal(field.type, "f32", `${field.name} must be a single float`);
  }
  assert.equal(
    total,
    CLOUD_UNIFORM_TOTAL_FLOATS,
    "the uniform block is 176 floats — this is the number the packing site must agree with",
  );
});

test("the 160-171 block the dials were appended to is unmoved", () => {
  const { fields } = parseCloudUniforms(shippedSource);
  const block = fields
    .filter((f) => f.from >= 160 && f.to <= 171)
    .map((f) => ({ name: f.name, from: f.from, to: f.to }));
  assert.deepEqual(block, [...PRECEDING_BLOCK]);
});

test("every slot comment from 100 to the tail matches the computed offset", () => {
  // The comments are the human-readable half of the contract with the packing
  // site. A comment that disagrees with the declared widths is worse than none:
  // the packing site is written from the comment.
  const { fields } = parseCloudUniforms(shippedSource);
  let checked = 0;
  for (const field of fields) {
    if (field.from < SLOT_COMMENT_CHECK_FROM) {
      continue;
    }
    const declared = declaredSlots(field);
    if (declared === undefined) {
      continue;
    }
    checked += 1;
    assert.deepEqual(
      declared,
      { from: field.from, to: field.to },
      `${field.name} claims slots ${declared.from}-${declared.to} but the declared widths put it at ${field.from}-${field.to}`,
    );
  }
  assert.ok(checked > 20, `only ${checked} slot comments were checked`);
});

test("the dials are declared in exactly one shader", () => {
  // `CloudCollection.wgsl` declares an unrelated `struct CloudUniforms` for the
  // billboard collection. A dial that leaked into it would be a second,
  // silently diverging layout.
  const hits = fs
    .readdirSync(path.join(root, SHADER_DIR), { recursive: true })
    .filter((f) => String(f).endsWith(".wgsl"))
    .filter((f) =>
      /powderStrength|isotropicFloor|ambientFloor/.test(
        read(path.posix.join(SHADER_DIR, String(f).split(path.sep).join("/"))),
      ),
    );
  assert.deepEqual(hits.map(String), [
    ["Environment", "ProceduralClouds.wgsl"].join(path.sep),
  ]);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("the one multiScatterLight call site passes slot 172", () => {
  assertPowderCallSite(shipped.wiring);
});

test("each floor sits behind an explicit > 0.0 guard on a mutable binding", () => {
  assertGuardedFloor(shipped.wiring, "isotropic");
  assertGuardedFloor(shipped.wiring, "ambient");
});

test("the guard idiom is the one genusForwardG already uses", () => {
  // The row's neutrality argument is "same idiom as the delta-0 early return".
  // That is only an argument if the early return is actually there.
  const body = functionSource(stripComments(shippedSource), "genusForwardG");
  assert.match(body, /if\s*\(\s*cloud\.genusPhaseDelta\s*==\s*0\.0\s*\)/);
});

// ── Neutrality ───────────────────────────────────────────────────────────────

test("powder 0.5 reproduces the pre-change march exactly, at every station", () => {
  // CONDITIONAL identity: the march is byte-identical to the code it replaces
  // exactly when the preset carries 0.5, because 0.5 was the literal. No
  // tolerance — both sides are the same f64 evaluation of two source texts.
  for (const station of STATIONS) {
    assert.equal(
      lightAt(shipped, station, { powderStrength: 0.5 }),
      lightAt(historical, station, { powderStrength: 0.5 }),
      `station od=${station.opticalDepth} cos=${station.cosTheta} n=${station.octaves}`,
    );
  }
});

test("the historical march ignores slot 172, which is what makes that comparison mean something", () => {
  // If the "historical" model read the uniform too, the test above would be
  // comparing a model with itself.
  const station = STATIONS[0];
  assert.equal(
    lightAt(historical, station, { powderStrength: 0.9 }),
    lightAt(historical, station, { powderStrength: 0.1 }),
    "the literal call site must be blind to the uniform",
  );
  assert.equal(historical.wiring.powderArgument, "0.5");
});

test("both floors are inert at 0, at every station", () => {
  for (const station of STATIONS) {
    assert.equal(
      lightAt(shipped, station, {
        powderStrength: 0.5,
        isotropicFloor: 0,
        ambientFloor: 0,
      }),
      lightAt(historical, station, { powderStrength: 0.5 }),
      `floors at 0 must not move od=${station.opticalDepth} cos=${station.cosTheta}`,
    );
  }
  const fill = [0.02, 0.05, 0.09];
  shipped.cloud.ambientFloor = 0;
  const floored = ambientFill(shipped, fill, [0.3, 0.4, 0.5], 0.5);
  historical.cloud.ambientFloor = 0;
  assert.deepEqual(
    floored,
    ambientFill(historical, fill, [0.3, 0.4, 0.5], 0.5),
  );
});

test("the phase the floor bounds is positive everywhere it is evaluated", () => {
  // This is WHY stripping the `> 0.0` guard is numerically inert at a 0 floor:
  // `max(x, 0)` is the identity on a positive x. The guard's contract is
  // therefore structural — it says the floor is opt-in per tier — and the
  // neutrality of slot 173 rests on this invariant rather than on the guard
  // alone. Asserting the invariant is what lets the mutant below be reported
  // honestly instead of dressed up as a numeric catch.
  for (const station of STATIONS) {
    for (const ph of octavePhases(shipped, station)) {
      assert.ok(ph > 0, `phase ${ph} at cos=${station.cosTheta}`);
    }
  }
});

test("the byte-identity predicate rejects a perturbation of 1e-9", () => {
  // Negative control: an `assert.equal` with no tolerance is only a real
  // discriminator if it can fail at the magnitudes in play.
  const station = STATIONS[0];
  assert.throws(() =>
    assert.equal(
      lightAt(shipped, station, { powderStrength: 0.5 }),
      lightAt(shipped, station, { powderStrength: 0.5 + 1e-9 }),
    ),
  );
});

// ── Authority and direction ──────────────────────────────────────────────────

test("powderStrength moves the march, and can only darken it", () => {
  const ladder = [0, 0.25, 0.5, 0.75, 1];
  for (const station of STATIONS) {
    const values = ladder.map((p) =>
      lightAt(shipped, station, { powderStrength: p }),
    );
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(
        values[i] < values[i - 1],
        `powder ${ladder[i]} must darken vs ${ladder[i - 1]}: ${values[i]} vs ${values[i - 1]}`,
      );
    }
  }
});

test("isotropicFloor can only raise the octave sum, and does raise it where the phase is below it", () => {
  let raised = 0;
  for (const station of STATIONS) {
    const neutral = lightAt(shipped, station, { powderStrength: 0.5 });
    const phases = octavePhases(shipped, station);
    // A floor above the largest phase must bite at every octave; one below the
    // smallest cannot bite at all.
    const above = Math.max(...phases) * 2;
    const below = Math.min(...phases) / 2;
    const withAbove = lightAt(shipped, station, {
      powderStrength: 0.5,
      isotropicFloor: above,
    });
    const withBelow = lightAt(shipped, station, {
      powderStrength: 0.5,
      isotropicFloor: below,
    });
    assert.ok(
      withAbove > neutral,
      `a floor above the phase must raise the sum`,
    );
    assert.equal(
      withBelow,
      neutral,
      `a floor below the phase must not move it`,
    );
    raised += 1;
  }
  assert.equal(raised, STATIONS.length);
});

test("ambientFloor can only raise the fill, per channel, and cannot tint it", () => {
  const dark = [0.004, 0.01, 0.02];
  const bright = [0.6, 0.7, 0.9];
  shipped.cloud.ambientIntensity = 0.4;
  shipped.cloud.ambientFloor = 0;
  const unfloored = ambientFill(shipped, dark, bright, 0.15);
  shipped.cloud.ambientFloor = 0.08;
  const floored = ambientFill(shipped, dark, bright, 0.15);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(floored[i] >= unfloored[i], "a floor may never lower a channel");
    assert.ok(
      floored[i] >= 0.08 - 1e-15,
      "every channel is at or above the floor",
    );
  }
  assert.ok(
    floored.some((v, i) => v > unfloored[i]),
    "a dark fill must actually be raised",
  );
  // Per channel and equal-valued, so it adds grey, never a hue: the channel
  // that was already above the floor is untouched.
  shipped.cloud.ambientFloor = 0;
  const brightUnfloored = ambientFill(shipped, bright, bright, 0.5);
  shipped.cloud.ambientFloor = 0.08;
  assert.deepEqual(ambientFill(shipped, bright, bright, 0.5), brightUnfloored);
});

test("powderStrength has authority over the statistic bar A4 scores", (t) => {
  // A4: "powder signature: backscatter edge/interior <= 0.80". The edge is the
  // optically thin limb of the cloud, the interior the deep sample. Raising
  // powder must move that ratio DOWN — toward what A4 asks — because the powder
  // term multiplies `beer` by `1 - exp(-2 t)`, which is near 0 at the edge and
  // near 1 in the interior. The THRESHOLD is not pre-registered: this is a
  // lighting-only proxy, and A4 is scored on a rendered frame.
  const edge = { opticalDepth: 0.08, cosTheta: -1, octaves: 3 };
  const interior = { opticalDepth: 6, cosTheta: -1, octaves: 3 };
  const ladder = [0, 0.4, 0.5, 0.7, 1];
  const ratios = ladder.map(
    (p) =>
      lightAt(shipped, edge, { powderStrength: p }) /
      lightAt(shipped, interior, { powderStrength: p }),
  );
  for (let i = 1; i < ratios.length; i += 1) {
    assert.ok(
      ratios[i] < ratios[i - 1],
      `raising powder must lower edge/interior: ${ratios[i]} vs ${ratios[i - 1]}`,
    );
  }
  t.diagnostic(
    `A4 proxy edge/interior by powderStrength: ${ladder
      .map((p, i) => `${p}=${ratios[i].toFixed(4)}`)
      .join("  ")}`,
  );
});

// ── The preset table ─────────────────────────────────────────────────────────

test("every tier declares all three dials, finite and in range", () => {
  assert.ok(TIER_PRESETS.length >= 4, "tiers 0-3 must all be present");
  for (const preset of TIER_PRESETS) {
    for (const field of ["powderStrength", "isotropicFloor", "ambientFloor"]) {
      const value = preset[field];
      assert.equal(
        typeof value,
        "number",
        `tier ${preset.tier} must declare ${field}`,
      );
      assert.ok(
        Number.isFinite(value),
        `tier ${preset.tier} ${field} is ${value}`,
      );
      assert.ok(
        value >= 0 && value <= 1,
        `tier ${preset.tier} ${field} = ${value} is outside [0, 1]`,
      );
    }
  }
});

test("a tier is byte-identical to the pre-wiring march IFF it carries the neutral values", (t) => {
  // THE INVARIANT, which is a property of the WIRING and so this lane's to
  // assert. Byte-identity with the pre-change march holds exactly when
  // `powderStrength` is the literal 0.5 this replaced AND both floors are 0.
  //
  // Stated as an equivalence, not as a snapshot of the preset table: that table
  // lives in another lane's file, and a spec hard-coding its values certifies
  // the table rather than the wiring, then goes red the moment that lane tunes
  // it. Tier 0 is the baseline where the cloud pass does not run, so its values
  // are inert in practice; measured anyway, because a tier-0 preset that later
  // starts rendering would carry them.
  //
  // HISTORY THIS TEST CARRIES. As first measured (2026-09-12) the table was
  // powder 0 / 0 / 0.4 / 0.7 with floors 0 / 0 / 0.02+0.05 / 0.04+0.08 — NO tier
  // carried 0.5 — so reading the slot moved the image at every tier and removed
  // the powder term outright at tiers 0-1, a 99.52 % max relative delta. That
  // measurement is why the seat ruled the presets pinned to the pre-wiring
  // literal, with the tuning filed as a follow-up row under C13-N11. The
  // per-tier state is REPORTED on every run, so the record shows what the table
  // carries at that commit either way.
  const rows = [];
  for (const preset of TIER_PRESETS) {
    const dials = {
      powderStrength: preset.powderStrength,
      isotropicFloor: preset.isotropicFloor,
      ambientFloor: preset.ambientFloor,
    };
    let worst = 0;
    let identical = true;
    for (const station of STATIONS) {
      const now = lightAt(shipped, station, dials);
      const before = lightAt(historical, station, { powderStrength: 0.5 });
      if (now !== before) {
        identical = false;
      }
      worst = Math.max(worst, Math.abs(now - before) / Math.abs(before));
    }
    const neutral =
      preset.powderStrength === 0.5 &&
      preset.isotropicFloor === 0 &&
      preset.ambientFloor === 0;
    rows.push({ tier: preset.tier, identical, neutral, worst, ...dials });
    assert.equal(
      identical,
      neutral,
      `tier ${preset.tier}: byte-identical=${identical} but neutral=${neutral} ` +
        `(powder=${preset.powderStrength}, isoFloor=${preset.isotropicFloor}, ` +
        `ambFloor=${preset.ambientFloor}). The wiring must move the image if and ` +
        `only if a dial departs from its neutral value.`,
    );
  }
  // The equivalence must not be vacuous in either direction. If every tier is
  // neutral it reduces to four trivially-true identities, so both arms are
  // exercised explicitly rather than left to the table's current contents.
  const neutralValue = lightAt(shipped, STATIONS[0], {
    powderStrength: 0.5,
    isotropicFloor: 0,
    ambientFloor: 0,
  });
  assert.equal(
    neutralValue,
    lightAt(historical, STATIONS[0], { powderStrength: 0.5 }),
    "the neutral arm must reproduce the pre-change march exactly",
  );
  assert.notEqual(
    neutralValue,
    lightAt(shipped, STATIONS[0], {
      powderStrength: 0.7,
      isotropicFloor: 0,
      ambientFloor: 0,
    }),
    "the non-neutral arm must move the image",
  );
  for (const row of rows) {
    t.diagnostic(
      `tier ${row.tier}: powder=${row.powderStrength} isoFloor=${row.isotropicFloor} ambFloor=${row.ambientFloor} — neutral=${row.neutral}, byte-identical=${row.identical}, max relative delta ${(row.worst * 100).toFixed(2)}%`,
    );
  }
});

test("where each tier's isotropicFloor can bite is measured, not assumed", (t) => {
  // A floor below the phase minimum is declared but inert. Which tiers are in
  // that position is a fact about the shipped phase row, so it is measured and
  // reported rather than asserted into existence.
  for (const preset of TIER_PRESETS) {
    let biting = 0;
    let minimumPhase = Infinity;
    for (const station of STATIONS) {
      const phases = octavePhases(shipped, station);
      minimumPhase = Math.min(minimumPhase, ...phases);
      if (phases.some((ph) => ph < preset.isotropicFloor)) {
        biting += 1;
      }
    }
    t.diagnostic(
      `tier ${preset.tier}: isotropicFloor=${preset.isotropicFloor} bites at ${biting}/${STATIONS.length} stations (phase minimum ${minimumPhase.toFixed(5)})`,
    );
    if (preset.isotropicFloor === 0) {
      assert.equal(biting, 0, "a zero floor can never bite");
    }
  }
});

test("the power-user escape hatch declares all three dials, and its state is reported", (t) => {
  // `cloudQuality !== 64` bypasses the tier table entirely and constructs its
  // own preset, so it is a FOURTH place the three dials are decided and the one
  // a user reaches for when the tiers look wrong. Its values are asserted the
  // same way as the tiers' — through the equivalence, not as literals — because
  // it lives in another lane's file too.
  const escape = resolveCloudPreset({
    preset: undefined,
    rawCloudQuality: 32,
    cameraHeightMeters: 5000,
    enableAltitudeMeters: 1000,
    disableAltitudeMeters: 100000,
  });
  for (const field of ["powderStrength", "isotropicFloor", "ambientFloor"]) {
    assert.equal(
      typeof escape[field],
      "number",
      `the escape hatch must declare ${field}`,
    );
    assert.ok(
      escape[field] >= 0 && escape[field] <= 1,
      `escape hatch ${field} = ${escape[field]} is outside [0, 1]`,
    );
  }
  const neutral =
    escape.powderStrength === 0.5 &&
    escape.isotropicFloor === 0 &&
    escape.ambientFloor === 0;
  const identical = STATIONS.every(
    (station) =>
      lightAt(shipped, station, {
        powderStrength: escape.powderStrength,
        isotropicFloor: escape.isotropicFloor,
        ambientFloor: escape.ambientFloor,
      }) === lightAt(historical, station, { powderStrength: 0.5 }),
  );
  assert.equal(
    identical,
    neutral,
    `the escape hatch must obey the same equivalence as the tiers ` +
      `(powder=${escape.powderStrength}, isoFloor=${escape.isotropicFloor}, ` +
      `ambFloor=${escape.ambientFloor})`,
  );
  // REPORTED because it is a live question for the seat: if the tier presets are
  // pinned to the neutral 0.5 and this path is not, the escape hatch alone loses
  // the powder term — a silent divergence between the two routes to a preset.
  t.diagnostic(
    `escape hatch: powder=${escape.powderStrength} isoFloor=${escape.isotropicFloor} ambFloor=${escape.ambientFloor} — neutral=${neutral}`,
  );
});

// ── QF_PROFILE_ON, deprecated in place ───────────────────────────────────────

test("QF_PROFILE_ON is kept at bit 7 with its deprecation marker, and read by nothing", () => {
  // Removing it would be wrong even though it has no consumer: the define space
  // is ADD-ONLY. A reclaimed bit silently aliases every cached shader module and
  // pipeline keyed on the mask — the cache hands back a module compiled under
  // the old meaning of the bit, with no error anywhere. The per-texel genus
  // profile it was reserved for is C13-N38's row, which either wires both
  // halves or files the removal on the ledger.
  const declaration = shippedSource.match(
    /(\/\/[^\n]*\n\s*)*const QF_PROFILE_ON: u32 = (\d+)u;/,
  );
  assert.notEqual(declaration, null, "QF_PROFILE_ON must still be declared");
  assert.equal(Number(declaration[2]), 128, "bit 7 must not be renumbered");
  assert.match(
    shippedSource,
    /DEPRECATED IN PLACE[\s\S]{0,600}const QF_PROFILE_ON/,
    "the deprecation must be recorded where the constant is",
  );
  assert.equal(
    CLOUD_QF_PROFILE_ON,
    1 << 7,
    "the TS twin must keep the same bit",
  );
  // No consumer in the shipped shader: the only mentions are the declaration
  // and its own deprecation note. The PRODUCER half lives in the renderer,
  // which another lane owns and this file deliberately does not pin.
  const uses = stripComments(shippedSource).match(/QF_PROFILE_ON/g) ?? [];
  assert.equal(
    uses.length,
    1,
    `QF_PROFILE_ON is read ${uses.length - 1} times`,
  );
});

// ── Mutants ──────────────────────────────────────────────────────────────────

test("MUTANT 1 — the call site reverted to the literal kills the dial", () => {
  const inert = buildModel(
    mutate(
      shippedSource,
      POWDER_CALL_PATTERN,
      "multiScatterLight(lightOpticalDepth, cosTheta, 0.5, msOctaves)",
    ),
  );
  // The structural predicate rejects it...
  assert.throws(() => assertPowderCallSite(inert.wiring), /must pass slot 172/);
  // ...and so does the liveness measurement, which is the point: with the
  // literal back, the tier's value reaches nothing.
  const station = STATIONS[0];
  assert.equal(
    lightAt(inert, station, { powderStrength: 0 }),
    lightAt(inert, station, { powderStrength: 1 }),
  );
  assert.throws(() => {
    const low = lightAt(inert, station, { powderStrength: 0.25 });
    const high = lightAt(inert, station, { powderStrength: 0.75 });
    assert.ok(high < low, `powder must darken: ${high} vs ${low}`);
  }, /powder must darken/);
});

test("MUTANT 1b — the consumer neutered inside the loop kills the dial", () => {
  // THE MUTANT ADVERSARIAL VERIFICATION FOUND SURVIVING, 2026-09-13. It leaves
  // the call site passing `cloud.powderStrength` untouched — so every text-shaped
  // check on the call site still passes — and neuters the USE inside the octave
  // loop, where the argument is actually consumed. Slot 172 is then handed in
  // and dropped, and before this round the file stayed 27/27 GREEN.
  const inert = buildModel(
    mutate(
      shippedSource,
      /let\s+bp\s*=\s*mix\(\s*beer\s*,\s*beer\s*\*\s*powderEffect\s*,\s*powder\s*\)/,
      "let bp = mix(beer, beer * powderEffect, 0.5)",
    ),
  );
  // The call site is INTACT under this mutant — assert that, so nobody
  // "simplifies" this test into a call-site grep that cannot see it.
  assert.equal(inert.wiring.powderArgument, "cloud.powderStrength");
  // The structural predicate now rejects it, on the consumer rather than the
  // call site...
  assert.throws(
    () => assertPowderCallSite(inert.wiring),
    /must consume its powder parameter/,
  );
  // ...and so does the liveness measurement, which is what makes this a
  // behavioural catch rather than a second grep.
  const station = STATIONS[0];
  assert.equal(
    lightAt(inert, station, { powderStrength: 0 }),
    lightAt(inert, station, { powderStrength: 1 }),
    "with the consumer neutered the dial must reach nothing",
  );
  assert.throws(() => {
    const low = lightAt(inert, station, { powderStrength: 0.25 });
    const high = lightAt(inert, station, { powderStrength: 0.75 });
    assert.ok(high < low, `powder must darken: ${high} vs ${low}`);
  }, /powder must darken/);
});

test("MUTANT 2 — the isotropic floor ungated fails the guard predicate", () => {
  const ungated = buildModel(
    mutate(
      shippedSource,
      ISOTROPIC_GUARD_PATTERN,
      "ph = max(ph, cloud.isotropicFloor);",
    ),
  );
  assert.equal(ungated.wiring.isotropic, "ungated");
  assert.throws(
    () => assertGuardedFloor(ungated.wiring, "isotropic"),
    /isotropic floor must sit behind an explicit > 0\.0 test/,
  );
  // Reported honestly: at a 0 floor this mutant is numerically inert, because
  // the phase is positive (asserted above) and `max(x, 0)` is then the
  // identity. The guard is a structural contract — the floor is opt-in per
  // tier — so a structural predicate is what must catch its removal.
  const station = STATIONS[0];
  assert.equal(
    lightAt(ungated, station, { powderStrength: 0.5, isotropicFloor: 0 }),
    lightAt(historical, station, { powderStrength: 0.5 }),
  );
});

test("MUTANT 3 — the isotropic floor removed altogether kills its dial", () => {
  const absent = buildModel(mutate(shippedSource, ISOTROPIC_GUARD_PATTERN, ""));
  assert.equal(absent.wiring.isotropic, "absent");
  assert.throws(
    () => assertGuardedFloor(absent.wiring, "isotropic"),
    /isotropic floor must sit behind an explicit > 0\.0 test/,
  );
  const station = STATIONS[0];
  const phases = octavePhases(absent, station);
  assert.throws(() => {
    const neutral = lightAt(absent, station, { powderStrength: 0.5 });
    const raised = lightAt(absent, station, {
      powderStrength: 0.5,
      isotropicFloor: Math.max(...phases) * 2,
    });
    assert.ok(raised > neutral, "a floor above the phase must raise the sum");
  }, /must raise the sum/);
});

test("MUTANT 4 — the ambient floor ungated, then removed", () => {
  const ungated = buildModel(
    mutate(
      shippedSource,
      AMBIENT_GUARD_PATTERN,
      "ambient = max(ambient, vec3<f32>(cloud.ambientFloor));",
    ),
  );
  assert.equal(ungated.wiring.ambient, "ungated");
  assert.throws(
    () => assertGuardedFloor(ungated.wiring, "ambient"),
    /ambient floor must sit behind an explicit > 0\.0 test/,
  );

  const absent = buildModel(mutate(shippedSource, AMBIENT_GUARD_PATTERN, ""));
  assert.equal(absent.wiring.ambient, "absent");
  absent.cloud.ambientFloor = 0.08;
  const dark = [0.004, 0.01, 0.02];
  assert.throws(() => {
    const floored = ambientFill(absent, dark, dark, 0.5);
    assert.ok(
      floored.every((v) => v >= 0.08 - 1e-15),
      `a dark fill must be raised to the floor, got ${floored.join(", ")}`,
    );
  }, /must be raised to the floor/);
});

test("MUTANT 5 — a dial moved off the tail breaks the slot contract", () => {
  // The slot numbers are the contract with the packing site. Reordering the row
  // keeps the struct the same SIZE, which is exactly why a size check alone
  // would not catch it.
  const reordered = mutate(
    shippedSource,
    /powderStrength: f32,(\s*)\/\/ 172/,
    "powderStrength: f32,$1// 174",
  );
  assert.throws(() => {
    const { fields } = parseCloudUniforms(reordered);
    for (const field of fields) {
      const declared = declaredSlots(field);
      if (declared === undefined || field.from < SLOT_COMMENT_CHECK_FROM) {
        continue;
      }
      assert.deepEqual(
        declared,
        { from: field.from, to: field.to },
        `${field.name} claims a slot the declared widths do not put it at`,
      );
    }
  }, /claims a slot the declared widths do not put it at/);
});

test("META-MUTANT — the predicates are not vacuous", () => {
  // 1. A mutation pattern that matches nothing must THROW rather than hand back
  //    an unmutated source that passes as a mutant.
  assert.throws(
    () => mutate(shippedSource, /this text is not in the shader/, "x"),
    /matched nothing/,
  );
  // 2. The wiring parser must be capable of reporting each state, or its
  //    "guarded" verdict means nothing.
  assert.equal(
    classifyFloor(
      "if (cloud.x > 0.0) { y = max(y, cloud.x); }",
      "cloud\\.x",
      "y\\s*=\\s*max\\(\\s*y\\s*,\\s*cloud\\.x\\s*\\)",
    ),
    "guarded",
  );
  assert.equal(
    classifyFloor(
      "y = max(y, cloud.x);",
      "cloud\\.x",
      "y\\s*=\\s*max\\(\\s*y\\s*,\\s*cloud\\.x\\s*\\)",
    ),
    "ungated",
  );
  assert.equal(
    classifyFloor(
      "y = ph;",
      "cloud\\.x",
      "y\\s*=\\s*max\\(\\s*y\\s*,\\s*cloud\\.x\\s*\\)",
    ),
    "absent",
  );
  // 3. The layout parser must actually be reading the shipped struct: a source
  //    with no struct in it must fail loudly, not return an empty pass.
  assert.throws(
    () => parseCloudUniforms("fn nothing() {}"),
    /struct CloudUniforms not found/,
  );
});
