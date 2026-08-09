// cloud-march-emission.spec.mjs — C13-10 (march-emitted reconstruction depth +
// the first attachment consumer).
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHAT THIS EXISTS TO CATCH.
//
//   - THE C13-39 CONSTRAINT BEING PAID BY PIPELINES THAT DID NOT ASK FOR IT.
//     C13-39's negative result established that WGSL register allocation is
//     STATIC. C13-10 genuinely needs the march to emit per-sample data, so the
//     march HAD to change — which is why the C13-09 content pin on
//     `ProceduralClouds.wgsl` was updated by this row rather than worked
//     around. What replaces a raw-content pin is stricter, not looser: group A
//     requires the emission to live behind ONE compile-time bit, requires
//     exactly one pipeline in the renderer to compile that bit, and requires
//     the other four march pipelines (full-resolution, beer-shadow map, cascade
//     atlas, god-ray mask) to keep compiling the source VERBATIM. The
//     companion `cloud-reconstruction-attachments.spec.mjs` F1b pins that the
//     text they compile is byte-identical to the pre-C13-10 module;
//
//   - THE EMISSION SILENTLY BECOMING THE ESTIMATOR AGAIN. The row's whole
//     content is that the depth stops being inferred from the resolved alpha
//     and starts being accumulated from the march's own weights. Group C
//     includes the MUTANT the brief names: reinstating `weightedDepthFromAlpha`
//     inside the emitting producer while it still claims to read the march's
//     target must be detected;
//
//   - THE EMISSION MATH DRIFTING FROM ITS CPU TWIN. Group B executes the twin
//     against a synthesized march, cross-validates it against C13-09's
//     estimator on the ONE domain where the estimator is exact (uniform
//     extinction), and shows them SEPARATING where it is not — which is the
//     evidence that the row bought something;
//
//   - C13-10 QUIETLY DOING C13-12's ROW. The ledger gives C13-12
//     "attachment-aware motion/depth rejection, variance clipping, reactive
//     history, wind advection in reprojection, disocclusion". Every one of
//     those needs a TUNED NUMBER. Group D scans the consumption variant's own
//     lines and requires every numeric literal in them to be a bound (0, 1,
//     0.5) or the storage format's quantum. A depth-delta threshold or a clip
//     width appearing there fails HERE, in this row's spec, rather than in a
//     review of C13-12's;
//
//   - THE DEFAULT PATH MOVING. Group E pins that both new opt-ins are default
//     off, that the variant pipelines are SEPARATE objects built beside the
//     historical ones (so a runtime flip never rebuilds a shipped pipeline),
//     and that a frame which did not produce the set cannot consume it.
//
// Run: node --test Tools/visual-regression/cloud-march-emission.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
// C13-10 — ONE loader for "what does a pipeline actually compile". Every spec
// in the cloud lane that hands WGSL to naga now goes through this, instead of
// each rolling its own approximation of the preprocessor.
import {
  defaultVariant,
  preprocess,
  shaderDefines,
  variantOnlyLines,
} from "./lib/wgsl-variant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);

// Multi-line source anchors below are written with LF. The checkout is CRLF on
// Windows working trees, so normalize or every anchor silently misses.
const readEngine = (p) =>
  fs.readFileSync(enginePath(p), "utf8").replace(/\r\n/g, "\n");

const cloudRenderer = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const attachmentModuleSource = readEngine(
  "Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts",
);
const observabilitySource = readEngine(
  "Renderer/WebGPU/WebGPUCloudObservability.ts",
);
const definesSource = readEngine("Renderer/WebGPU/WebGPUShaderDefines.ts");
const debugSource = readEngine("Scene/CesiumDebug.js");
const marchWgsl = readEngine(
  "Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const producerWgsl = readEngine(
  "Shaders/WebGPU/Environment/CloudReconstructionAttachments.wgsl",
);
const resolveWgsl = readEngine(
  "Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl",
);

const toDataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/** Transpiles one LEAF engine TS module (no relative imports) to a data: URL. */
async function transpileLeaf(relativePath) {
  const { code } = await transform(
    fs.readFileSync(enginePath(relativePath), "utf8"),
    { loader: "ts", format: "esm", target: "es2022" },
  );
  return toDataUrl(code);
}

const { ShaderDefineHi, defineHiKeyToNames, resolveDefineBitHi } =
  shaderDefines;

const EMIT = ShaderDefineHi.CLOUD_MARCH_EMIT_RECONSTRUCTION;
const CONSUME = ShaderDefineHi.CLOUD_RECONSTRUCTION_CONSUME;

const attachments = await import(
  await transpileLeaf("Renderer/WebGPU/WebGPUCloudReconstructionAttachments.ts")
);
const {
  CLOUD_EMITTED_ATTACHMENTS,
  CLOUD_EMIT_MIN_ALPHA,
  CLOUD_MARCH_EMITTED_SLOT,
  CLOUD_MOMENT_F16_QUANTUM,
  CLOUD_OWNED_ATTACHMENTS,
  CloudHistoryRejection,
  classifyCloudReconstructionHistory,
  cloudCompositeMarchDepth,
  cloudMarchWeightedDepth,
  cloudTransmittanceWeightedDepth,
} = attachments;

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The compile-time variant — the C13-39 constraint, re-enforced
// ─────────────────────────────────────────────────────────────────────────────

test("A1 both axes are REGISTERED hi-word defines, added without disturbing the table", () => {
  assert.equal(typeof EMIT, "number");
  assert.equal(typeof CONSUME, "number");
  assert.notEqual(EMIT, CONSUME, "one bit cannot gate two independent axes");
  assert.equal(EMIT & CONSUME, 0);
  // Resolvable BY NAME through the real resolver — a bit that the preprocessor
  // cannot look up would make every `//>>ifdef` on it throw at compile time.
  assert.equal(resolveDefineBitHi("CLOUD_MARCH_EMIT_RECONSTRUCTION"), EMIT);
  assert.equal(resolveDefineBitHi("CLOUD_RECONSTRUCTION_CONSUME"), CONSUME);
  assert.deepEqual(defineHiKeyToNames(EMIT | CONSUME), [
    "CLOUD_MARCH_EMIT_RECONSTRUCTION",
    "CLOUD_RECONSTRUCTION_CONSUME",
  ]);
  // ADD-ONLY: the four pre-existing hi entries keep their exact bits. A
  // renumber here would silently alias every cached module compiled against
  // them, which is the failure the registry's add-only rule exists to prevent.
  assert.equal(ShaderDefineHi.HI_WORD_PROBE, 1 << 0);
  assert.equal(ShaderDefineHi.ENHANCED_OCEAN, 1 << 1);
  assert.equal(ShaderDefineHi.SPLAT_PACKED_WASM, 1 << 2);
  assert.equal(ShaderDefineHi.SPLAT_SPHERICAL_HARMONICS, 1 << 3);
  assert.equal(EMIT, 1 << 4);
  assert.equal(CONSUME, 1 << 5);
  // ...and the new entries carry the C13-39 rationale rather than being
  // dropped in. C16 removed tracker ids from `packages/*/Source`, so this
  // anchors on the SUBSTANCE the id used to stand next to: the doc must say
  // that the axis is compile-time rather than a uniform, and must give the
  // static-register-allocation reason. Both are prose the rewrite preserved;
  // A1-MUTATION below proves each assertion still bites.
  const emitDoc = definesSource.slice(
    definesSource.indexOf("SPLAT_SPHERICAL_HARMONICS: hiDefineBit(3),"),
    definesSource.indexOf("CLOUD_MARCH_EMIT_RECONSTRUCTION: hiDefineBit(4),"),
  );
  const emitProse = emitDoc.replace(/\s*\*\s*/g, " ");
  assert.match(
    emitProse,
    /compile-time variant rather than a uniform/,
    "a new specialization axis must record WHY it is compile-time and not a uniform",
  );
  assert.match(
    emitProse,
    /register allocation is static/,
    "the reason must be the static register allocation of the shared module",
  );
});

test("A1-MUTATION removing either rationale sentence makes A1 fail", () => {
  const emitDoc = definesSource.slice(
    definesSource.indexOf("SPLAT_SPHERICAL_HARMONICS: hiDefineBit(3),"),
    definesSource.indexOf("CLOUD_MARCH_EMIT_RECONSTRUCTION: hiDefineBit(4),"),
  );
  const emitProse = emitDoc.replace(/\s*\*\s*/g, " ");
  // Precondition: the unmutated prose satisfies both anchors, or the mutants
  // below prove nothing.
  assert.match(emitProse, /compile-time variant rather than a uniform/);
  assert.match(emitProse, /register allocation is static/);

  for (const [label, anchor] of [
    ["compile-time-vs-uniform", "compile-time variant rather than a uniform"],
    ["static-register-allocation", "register allocation is static"],
  ]) {
    const mutated = emitProse.split(anchor).join("");
    assert.notEqual(
      mutated,
      emitProse,
      `${label}: the mutation did not change the prose, so this control is vacuous`,
    );
    assert.equal(
      new RegExp(anchor).test(mutated),
      false,
      `${label}: A1 would still pass with the rationale removed`,
    );
  }
});

test("A2 EXACTLY ONE march pipeline compiles the emission bit", () => {
  // Batch 942 correction: this test originally pinned the historical
  // pipelines compiling the shared source VERBATIM "with no preprocess call
  // at all" — and the browser refuted that design premise on the first
  // post-landing run: RAW ifdef-bearing text is both branches concatenated,
  // which is invalid WGSL ("expected '}'"), and every page logged compile
  // errors. The invariant this test actually protects is unchanged and is
  // carried by the DEFAULT-BRANCH text instead: the non-emitting pipelines
  // compile `preprocess(source, 0, 0)`, which F1b pins byte-identical to the
  // pre-C13-10 module — so the C13-39 register footprint is held by text
  // equality, not by skipping the preprocessor.
  const defaultCompile =
    /code: preprocess\(\s*PROCEDURAL_CLOUDS_SOURCE,\s*0,\s*0,?\s*\)/g;
  const verbatim = [...cloudRenderer.matchAll(defaultCompile)];
  assert.equal(
    verbatim.length,
    3,
    "the full-res march, the mask module and the shadow map must compile the DEFAULT branch (preprocess at defines=0)",
  );
  // Whitespace-tolerant: prettier wraps the argument list at this width, and a
  // pin that breaks on reformatting is a pin nobody trusts.
  const emitCompile =
    /code: preprocess\(\s*PROCEDURAL_CLOUDS_SOURCE,\s*0,\s*CLOUD_MARCH_EMIT_DEFINES_HI,?\s*\)/g;
  const preprocessed = [...cloudRenderer.matchAll(emitCompile)];
  assert.equal(
    preprocessed.length,
    1,
    "exactly one pipeline may compile the emission variant of the march",
  );
  // ...and it is the HALF-RES one, which is the only pipeline that writes a
  // reconstruction attachment.
  const emitStart = cloudRenderer.search(
    /cache\.reconstructionEnabled &&\s*!cache\.halfEmitPipeline/,
  );
  const emitEnd = cloudRenderer.indexOf(
    "// The bilateral-upscale composite pipeline",
  );
  assert.ok(emitStart > 0 && emitEnd > emitStart);
  const emitBlock = cloudRenderer.slice(emitStart, emitEnd);
  assert.match(emitBlock, emitCompile);
  assert.match(
    emitBlock,
    /label: "ProceduralClouds half-res pipeline \(emit\)"/,
  );
  // The mutant that matters: routing one of the default-branch sites through
  // the preprocessor with the emission bit would charge a non-emitting
  // pipeline for the registers.
  const oneDefaultSite = cloudRenderer.match(
    /code: preprocess\(\s*PROCEDURAL_CLOUDS_SOURCE,\s*0,\s*0,?\s*\)/,
  )[0];
  const mutated = cloudRenderer.replace(
    oneDefaultSite,
    "code: preprocess(PROCEDURAL_CLOUDS_SOURCE, 0, CLOUD_MARCH_EMIT_DEFINES_HI)",
  );
  assert.equal(
    [...mutated.matchAll(defaultCompile)].length,
    2,
    "the mutant did not take",
  );
  assert.notEqual(
    [...mutated.matchAll(emitCompile)].length,
    1,
    "the count check above does not detect a second emitting pipeline",
  );
});

test("A3 the emitting pipelines are SEPARATE objects, never a rebuild of the shipped ones", () => {
  // A flag flip must not destroy or rebuild a historical pipeline: that would
  // make toggling the row a frame hitch, and would mean the shipped pipeline
  // is no longer the same GPU object it would have been without this row.
  for (const field of [
    "halfEmitPipeline",
    "attachmentEmitPipeline",
    "temporalConsumePipeline",
  ]) {
    const nulls = [
      ...cloudRenderer.matchAll(new RegExp(`cache\\.${field} = null;`, "g")),
    ];
    assert.equal(
      nulls.length,
      1,
      `${field} is nulled in more than one place — a runtime flip must not drop a pipeline`,
    );
  }
  // ...and that one place is the device teardown.
  const destroy = cloudRenderer.slice(
    cloudRenderer.indexOf("export function destroyProceduralCloudResources("),
  );
  assert.match(destroy, /cache\.halfEmitPipeline = null;/);
  assert.match(destroy, /cache\.attachmentEmitPipeline = null;/);
  assert.match(destroy, /cache\.temporalConsumePipeline = null;/);
  // The historical half-res pipeline's construction still compiles the
  // DEFAULT branch (Batch 942: preprocess at defines=0 — byte-identical text
  // per F1b; raw compilation was the landing defect).
  assert.match(
    cloudRenderer,
    /if \(!cache\.halfPipeline && cache\.bindGroupLayout\) \{\n\s*const shaderModule = device\.createShaderModule\(\{\n\s*label: "ProceduralClouds shader \(half-res\)",\n(\s*\/\/[^\n]*\n)*\s*code: preprocess\(PROCEDURAL_CLOUDS_SOURCE, 0, 0\),/,
  );
});

test("A4 the resolve compiles the CONSUMPTION axis, not the emission one", () => {
  // Two axes, two shaders. Compiling the resolve with the emission bit would
  // emit nothing (it has no emission blocks) and would silently leave the
  // consumer on the historical path — a failure with no symptom but a wrong
  // picture.
  assert.match(
    cloudRenderer,
    /code: preprocess\(\n\s*CloudTemporalResolveWGSL,\n\s*0,\n\s*CLOUD_RECONSTRUCTION_CONSUME_DEFINES_HI,\n\s*\),/,
  );
  assert.ok(
    !cloudRenderer.includes(
      "CloudTemporalResolveWGSL,\n        0,\n        CLOUD_MARCH_EMIT_DEFINES_HI,",
    ),
  );
  assert.match(
    cloudRenderer,
    /const CLOUD_MARCH_EMIT_DEFINES_HI =\n\s*ShaderDefineHi\.CLOUD_MARCH_EMIT_RECONSTRUCTION as number;/,
    "the mask must come from the registry, not from a literal that happens to match",
  );
  assert.match(
    cloudRenderer,
    /const CLOUD_RECONSTRUCTION_CONSUME_DEFINES_HI =\n\s*ShaderDefineHi\.CLOUD_RECONSTRUCTION_CONSUME as number;/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The emission math, and what it buys over the estimator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesize one deck's march at a fixed step, returning both what the shader
 * would accumulate and the reference quantities. `extinction(t)` is the
 * per-metre extinction the density field would produce.
 */
function synthesizeMarch(t0, t1, steps, extinction) {
  const step = (t1 - t0) / steps;
  let transmittance = 1.0;
  let front = -1.0;
  let weightedSum = 0.0;
  for (let i = 0; i < steps; i++) {
    // The shader samples at `t + phase*step` with the default midpoint phase.
    const sampleDistance = t0 + i * step + 0.5 * step;
    const sigma = extinction(sampleDistance);
    if (sigma <= 0.0) {
      continue;
    }
    const sampleTransmittance = Math.exp(-sigma * step);
    const weight = (1.0 - sampleTransmittance) * transmittance;
    if (front < 0.0) {
      front = sampleDistance;
    }
    weightedSum += weight * sampleDistance;
    transmittance *= sampleTransmittance;
  }
  return {
    frontDistance: front,
    weightedDistanceSum: weightedSum,
    alpha: 1.0 - transmittance,
  };
}

test("B1 an empty deck reports the no-cloud sentinel, never a plausible zero", () => {
  assert.equal(cloudMarchWeightedDepth(-1.0, 0.0, 0.0), -1.0);
  assert.equal(cloudMarchWeightedDepth(-1.0, 1234.0, 0.5), -1.0);
  // A recorded front with zero alpha cannot happen in the shader (alpha is
  // recorded on the same branch), but it must not produce a division either.
  assert.equal(cloudMarchWeightedDepth(500.0, 0.0, 0.0), -1.0);
});

test("B2 the accumulation IS the transmittance-weighted mean of the sample distances", () => {
  const march = synthesizeMarch(1000.0, 5000.0, 256, () => 4.0e-4);
  const weighted = cloudMarchWeightedDepth(
    march.frontDistance,
    march.weightedDistanceSum,
    march.alpha,
  );
  // Sum of the weights IS the alpha, by construction — that is why the mean is
  // a plain quotient and needs no renormalization.
  assert.ok(
    Math.abs(march.weightedDistanceSum / weighted - march.alpha) < 1e-9,
    "the weights do not sum to alpha — the quotient is not a mean",
  );
  assert.ok(weighted > march.frontDistance && weighted < 5000.0);
});

test("B3 on uniform extinction it AGREES with C13-09's estimator — the estimator's exact domain", () => {
  // C13-09's estimator is exact for uniform extinction over the interval. The
  // accumulation makes no such assumption, so agreement HERE is the
  // cross-validation that the new path is right, and disagreement elsewhere
  // (B4) is what the row bought.
  const t0 = 2000.0;
  const t1 = 6000.0;
  for (const sigma of [1.0e-4, 3.0e-4, 8.0e-4, 2.0e-3]) {
    const march = synthesizeMarch(t0, t1, 4096, () => sigma);
    const accumulated = cloudMarchWeightedDepth(
      march.frontDistance,
      march.weightedDistanceSum,
      march.alpha,
    );
    const estimated = cloudTransmittanceWeightedDepth(t0, t1, march.alpha);
    const span = t1 - t0;
    assert.ok(
      Math.abs(accumulated - estimated) / span < 0.005,
      `uniform extinction ${sigma}: accumulation ${accumulated} vs estimator ${estimated} differ by more than half a percent of the interval`,
    );
  }
});

test("B4 on a NON-uniform deck they SEPARATE — this is what the row bought", () => {
  // A thin veil at the front and a dense core at the back resolve to the SAME
  // alpha as a uniform deck would, so the estimator (which sees only alpha and
  // the geometric interval) cannot tell them apart. The accumulation can.
  const t0 = 2000.0;
  const t1 = 6000.0;
  const frontLoaded = synthesizeMarch(t0, t1, 4096, (t) =>
    t < t0 + 800.0 ? 2.0e-3 : 2.0e-5,
  );
  const backLoaded = synthesizeMarch(t0, t1, 4096, (t) =>
    t > t1 - 800.0 ? 2.0e-3 : 2.0e-5,
  );
  const frontDepth = cloudMarchWeightedDepth(
    frontLoaded.frontDistance,
    frontLoaded.weightedDistanceSum,
    frontLoaded.alpha,
  );
  const backDepth = cloudMarchWeightedDepth(
    backLoaded.frontDistance,
    backLoaded.weightedDistanceSum,
    backLoaded.alpha,
  );
  // Same resolved alpha to within the quadrature error...
  assert.ok(
    Math.abs(frontLoaded.alpha - backLoaded.alpha) < 0.02,
    "the two synthetic decks must resolve to comparable alpha for this to be a fair comparison",
  );
  // ...but depths that are most of the deck apart.
  assert.ok(
    backDepth - frontDepth > 0.5 * (t1 - t0),
    `the accumulation did not separate a front-loaded deck (${frontDepth}) from a back-loaded one (${backDepth})`,
  );
  // And the estimator, seeing only alpha, puts them in nearly the same place —
  // which is precisely the disocclusion failure C13-09 recorded as its limit.
  const frontEstimate = cloudTransmittanceWeightedDepth(
    t0,
    t1,
    frontLoaded.alpha,
  );
  const backEstimate = cloudTransmittanceWeightedDepth(
    t0,
    t1,
    backLoaded.alpha,
  );
  assert.ok(
    Math.abs(backEstimate - frontEstimate) < 0.05 * (t1 - t0),
    "the estimator distinguished them, so this test is not measuring what it claims",
  );
});

test("B5 multi-deck: the FRONT is the minimum, not the first deck in composite order", () => {
  // The composite orders decks by |cameraAltitude - deckMidAltitude|, a
  // VERTICAL-BAND key. For an oblique view a deck later in that order can be
  // entered first along the ray, so taking the first deck's front would hand a
  // disocclusion test the wrong surface.
  const composed = cloudCompositeMarchDepth([
    { frontDistance: 9000.0, weightedDistanceSum: 900.0, alpha: 0.2 },
    { frontDistance: 1200.0, weightedDistanceSum: 480.0, alpha: 0.4 },
  ]);
  assert.equal(composed.front, 1200.0);
});

test("B6 multi-deck: the weighted mean composes EXACTLY through the running transmittance", () => {
  const decks = [
    { frontDistance: 1000.0, weightedDistanceSum: 300.0, alpha: 0.25 },
    { frontDistance: 4000.0, weightedDistanceSum: 1800.0, alpha: 0.4 },
    { frontDistance: 9000.0, weightedDistanceSum: 900.0, alpha: 0.1 },
  ];
  const composed = cloudCompositeMarchDepth(decks);
  // Recompute the composite by hand: deck k enters with weight `trans`.
  let trans = 1.0;
  let sum = 0.0;
  let alpha = 0.0;
  for (const deck of decks) {
    sum += trans * deck.weightedDistanceSum;
    alpha += trans * deck.alpha;
    trans *= 1.0 - deck.alpha;
  }
  assert.ok(Math.abs(composed.alpha - alpha) < 1e-12);
  assert.ok(Math.abs(composed.weighted - sum / alpha) < 1e-9);
  // Empty decks are skipped exactly as the shader's `continue` skips them.
  const withEmpty = cloudCompositeMarchDepth([
    { frontDistance: -1.0, weightedDistanceSum: 0.0, alpha: 0.0 },
    ...decks,
  ]);
  assert.ok(Math.abs(withEmpty.weighted - composed.weighted) < 1e-9);
  // An all-empty stack propagates the sentinel rather than reporting 0 m.
  const empty = cloudCompositeMarchDepth([
    { frontDistance: -1.0, weightedDistanceSum: 0.0, alpha: 0.0 },
  ]);
  assert.equal(empty.front, -1.0);
  assert.equal(empty.weighted, -1.0);
});

test("B7 the twin stops where the SHADER stops — the opaque early-out", () => {
  // `trans < 0.005` breaks the shader's deck loop. A twin that integrated the
  // far deck anyway would disagree with the GPU exactly in the overcast case.
  const decks = [
    { frontDistance: 1000.0, weightedDistanceSum: 995.0, alpha: 0.996 },
    { frontDistance: 50000.0, weightedDistanceSum: 50000.0, alpha: 1.0 },
  ];
  const composed = cloudCompositeMarchDepth(decks);
  assert.equal(composed.front, 1000.0, "the occluded far deck must not count");
  assert.ok(
    composed.weighted < 2000.0,
    "the far deck leaked into the weighted mean despite the opaque early-out",
  );
});

test("B8 the WGSL and the TS twin are the SAME expression, character for character", () => {
  const wgslExpression =
    "result.weightedDistanceSum / max(result.alpha, CLOUD_EMIT_MIN_ALPHA)";
  const emitMarch = preprocess(marchWgsl, 0, EMIT);
  assert.ok(
    emitMarch.includes(wgslExpression),
    "the WGSL single-deck emission drifted from the pinned expression",
  );
  assert.ok(
    attachmentModuleSource.includes(
      "return weightedDistanceSum / Math.max(alpha, CLOUD_EMIT_MIN_ALPHA);",
    ),
    "the CPU twin drifted from the WGSL — a silently diverging twin is how a spec stops testing the shader",
  );
  // The multi-deck composition, likewise.
  assert.ok(
    emitMarch.includes(
      "emitWeightedSum = emitWeightedSum + trans * r.weightedDistanceSum;",
    ),
  );
  assert.ok(
    emitMarch.includes("emitWeightedSum / max(accAlpha, CLOUD_EMIT_MIN_ALPHA)"),
  );
  // The floors are the SAME numbers, or the twin stops predicting the shader.
  assert.ok(emitMarch.includes("const CLOUD_EMIT_MIN_ALPHA: f32 = 1.0e-6;"));
  assert.equal(CLOUD_EMIT_MIN_ALPHA, 1.0e-6);
  // The weight the emission uses IS the weight the radiance uses. If the
  // emission ever computed its own weight the depth would stop describing the
  // colour it accompanies.
  assert.ok(
    emitMarch.includes(
      "result.weightedDistanceSum + sampleWeight * sampleDistance",
    ),
    "the emission must accumulate the march's OWN sampleWeight",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The variant's shader text — and the estimator-reinstatement mutant
// ─────────────────────────────────────────────────────────────────────────────

test("C1 every emission line lives INSIDE the variant — nothing leaks to the default", () => {
  const base = defaultVariant(marchWgsl);
  for (const token of [
    "weightedDistanceSum",
    "frontDistance",
    "CloudMarchOutput",
    "deckReconstructionDepth",
    "CLOUD_EMIT_MIN_ALPHA",
  ]) {
    assert.ok(
      marchWgsl.includes(token),
      `${token} is not in the march at all — the emission variant is gone`,
    );
    assert.ok(
      !base.includes(token),
      `${token} survives into the DEFAULT march variant — every pipeline pays for it`,
    );
  }
  // The default march still returns ONE colour target; the variant returns two.
  assert.ok(
    base.includes(
      "fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {",
    ),
  );
  const emit = preprocess(marchWgsl, 0, EMIT);
  assert.ok(
    emit.includes("fn fragmentMain(input: VertexOutput) -> CloudMarchOutput {"),
  );
  assert.ok(emit.includes("@location(1) depth: vec2<f32>,"));
  // The variant must not have taken the OTHER entry points with it: the mask
  // and the shadow map share this module and must keep their signatures.
  for (const entry of [
    "fn fragmentCloudMaskMain(input: VertexOutput) -> @location(0) f32 {",
    "fn cloudShadowMain(input: VertexOutput) -> @location(0) f32 {",
  ]) {
    assert.ok(base.includes(entry), `default lost ${entry}`);
    assert.ok(emit.includes(entry), `emission variant changed ${entry}`);
  }
});

test("C2 MUTANT — the emitting producer may not reinstate the estimator", () => {
  // This is the row's headline claim: with the variant on, the depth is
  // ACCUMULATED by the march, not INFERRED from alpha. A producer that quietly
  // went back to `weightedDepthFromAlpha` while still advertising the emitting
  // layout would pass every structural check and publish the old number.
  const emitProducer = preprocess(producerWgsl, 0, EMIT);
  assert.ok(
    emitProducer.includes(
      "let weighted = textureLoad(marchDepthTex, center, 0).g;",
    ),
    "the emitting producer must READ the march's depth target",
  );
  // Scoped to the FRAGMENT BODY. The estimator's DEFINITION legitimately
  // survives into this variant (it is one function in a module both variants
  // share, and an uncalled function costs no registers); what must not survive
  // is a CALL to it.
  const fragmentBody = (source) =>
    source.slice(source.indexOf("fn fragmentMain(input: VertexOutput)"));
  const emitBody = fragmentBody(emitProducer);
  assert.ok(emitBody.length > 0);
  assert.ok(
    !emitBody.includes("weightedDepthFromAlpha("),
    "the emitting producer still CALLS the estimator — it is inferring a depth it claims to have read",
  );
  // ...and the check detects its own mutant, in BOTH shapes the regression
  // could take: replacing the read, or adding the estimate back beside it.
  for (const mutant of [
    emitProducer.replace(
      "let weighted = textureLoad(marchDepthTex, center, 0).g;",
      "let weighted = weightedDepthFromAlpha(0.0, 1.0, 0.5);",
    ),
    emitProducer.replace(
      "let weighted = textureLoad(marchDepthTex, center, 0).g;",
      "let weighted = max(textureLoad(marchDepthTex, center, 0).g, weightedDepthFromAlpha(0.0, 1.0, alpha));",
    ),
  ]) {
    assert.notEqual(mutant, emitProducer, "the mutation was a no-op");
    assert.ok(
      fragmentBody(mutant).includes("weightedDepthFromAlpha("),
      "the estimator-reinstatement mutant is not detected by this check",
    );
  }
  // The DEFAULT producer keeps the estimator — it is not deprecated, it is the
  // path a build without the emitting march still needs.
  const baseProducer = defaultVariant(producerWgsl);
  assert.ok(
    baseProducer.includes(
      "weightedDepthFromAlpha(interval.x, interval.y, alpha)",
    ),
  );
  assert.ok(!baseProducer.includes("marchDepthTex"));
});

test("C3 the emitting producer reads the depth target UNFILTERED, like every other fetch", () => {
  const emitProducer = preprocess(producerWgsl, 0, EMIT);
  assert.ok(emitProducer.includes("textureLoad(marchDepthTex,"));
  assert.ok(
    !emitProducer.includes("textureSample"),
    "rg32float is not filterable without the optional float32-filterable feature",
  );
  // The per-neighbour depth moment now uses each neighbour's OWN weighted
  // depth. That is the approximation C13-09 recorded as a cost of not being
  // able to change the march, and it is retired here.
  assert.ok(
    emitProducer.includes(
      "let neighborWeighted = textureLoad(marchDepthTex, coord, 0).g;",
    ),
  );
  assert.ok(
    defaultVariant(producerWgsl).includes(
      "weightedDepthFromAlpha(interval.x, interval.y, neighborAlpha)",
    ),
    "the default producer must keep the shared-interval approximation it documents",
  );
});

test("C4 the march's emission target agrees with the CONTRACT, not with a literal", () => {
  assert.equal(CLOUD_MARCH_EMITTED_SLOT, 1);
  assert.equal(
    CLOUD_OWNED_ATTACHMENTS[CLOUD_MARCH_EMITTED_SLOT - 1].key,
    "depth",
  );
  assert.deepEqual(
    CLOUD_EMITTED_ATTACHMENTS.map((spec) => spec.key),
    ["velocity", "moments"],
  );
  // The pipeline's second target format is derived from the table.
  assert.match(
    cloudRenderer,
    /const CLOUD_MARCH_EMITTED_FORMAT: GPUTextureFormat =\n\s*CLOUD_OWNED_ATTACHMENTS\[CLOUD_MARCH_EMITTED_SLOT - 1\]\.format;/,
  );
  assert.equal(
    CLOUD_OWNED_ATTACHMENTS[CLOUD_MARCH_EMITTED_SLOT - 1].format,
    "rg32float",
    "half-float metres cannot separate the decks a disocclusion test has to separate",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The consumer — and the C13-12 boundary, made enforceable
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TEXEL = Object.freeze({
  depthMean: 0.25,
  depthSecondMoment: 0.07,
  coverageMean: 0.5,
  coverageSecondMoment: 0.3,
  motionU: 0.01,
  motionV: -0.02,
  reprojectionValidity: 1.0,
  weightedDepth: 3200.0,
  u: 0.5,
  v: 0.5,
});

test("D1 the validity twin returns each reason, and the ORDER is part of the contract", () => {
  assert.equal(
    classifyCloudReconstructionHistory(VALID_TEXEL),
    CloudHistoryRejection.NONE,
  );
  assert.equal(
    classifyCloudReconstructionHistory({
      ...VALID_TEXEL,
      coverageSecondMoment: 0.0,
    }),
    CloudHistoryRejection.MALFORMED_MOMENTS,
    "E[x^2] far below E[x]^2 cannot come from a distribution",
  );
  assert.equal(
    classifyCloudReconstructionHistory({
      ...VALID_TEXEL,
      coverageMean: 0.0,
      coverageSecondMoment: 0.0,
      depthMean: 0.0,
      depthSecondMoment: 0.0,
    }),
    CloudHistoryRejection.EMPTY_NEIGHBOURHOOD,
  );
  assert.equal(
    classifyCloudReconstructionHistory({
      ...VALID_TEXEL,
      reprojectionValidity: 0.0,
    }),
    CloudHistoryRejection.PRODUCER_INVALID,
  );
  assert.equal(
    classifyCloudReconstructionHistory({ ...VALID_TEXEL, weightedDepth: -1.0 }),
    CloudHistoryRejection.NO_CLOUD_ANCHOR,
  );
  assert.equal(
    classifyCloudReconstructionHistory({ ...VALID_TEXEL, motionU: 0.9 }),
    CloudHistoryRejection.OFF_SCREEN,
    "uv - motion must land inside the previous frame",
  );
  // ORDER: a texel that is BOTH malformed and off-screen must report the
  // malformed record, because that is the test the shader reaches first — and
  // the reason is what the counters would publish.
  assert.equal(
    classifyCloudReconstructionHistory({
      ...VALID_TEXEL,
      coverageSecondMoment: 0.0,
      motionU: 0.9,
    }),
    CloudHistoryRejection.MALFORMED_MOMENTS,
  );
});

test("D2 the f16 quantum is a TOLERANCE, not a rejection threshold", () => {
  // A record that violates E[x^2] >= E[x]^2 by less than the storage quantum
  // is rounding, not corruption, and must be accepted.
  const nearlyFlat = {
    ...VALID_TEXEL,
    coverageMean: 0.5,
    coverageSecondMoment: 0.25 - CLOUD_MOMENT_F16_QUANTUM * 0.5,
  };
  assert.equal(
    classifyCloudReconstructionHistory(nearlyFlat),
    CloudHistoryRejection.NONE,
  );
  const beyondRounding = {
    ...VALID_TEXEL,
    coverageMean: 0.5,
    coverageSecondMoment: 0.25 - CLOUD_MOMENT_F16_QUANTUM * 4.0,
  };
  assert.equal(
    classifyCloudReconstructionHistory(beyondRounding),
    CloudHistoryRejection.MALFORMED_MOMENTS,
  );
  // 2^-10 exactly, and the same number in both implementations.
  assert.equal(CLOUD_MOMENT_F16_QUANTUM, 2 ** -10);
  assert.ok(
    preprocess(resolveWgsl, 0, CONSUME).includes(
      "const CLOUD_MOMENT_F16_QUANTUM: f32 = 0.0009765625;",
    ),
  );
});

test("D3 the empty-neighbourhood early-out is OUTPUT-EQUIVALENT, not a shortcut", () => {
  // The equivalence rests on ONE property of the march: it emits PREMULTIPLIED
  // radiance, so alpha 0 implies RGB 0. If that ever stopped being true, an
  // empty-alpha neighbourhood could still carry colour, the 3x3 clamp bounds
  // would not collapse, and skipping the blend would change the picture.
  const march = defaultVariant(marchWgsl);
  assert.ok(
    march.includes("return vec4<f32>(hazed * cloudAlpha, cloudAlpha);"),
    "the single-shell half-res path must emit premultiplied radiance",
  );
  assert.ok(
    march.includes("return vec4<f32>(accColor, accAlpha);"),
    "the multi-deck half-res path must emit premultiplied radiance",
  );
  assert.ok(
    march.includes("if (r.alpha <= 0.0) { continue; }"),
    "an empty deck must contribute nothing to accColor, or accAlpha 0 would not imply accColor 0",
  );
  // ...and the shader's own early-out demands the variance agree, so an
  // inconsistent record cannot silently disable history.
  const consume = preprocess(resolveWgsl, 0, CONSUME);
  assert.ok(
    consume.includes(
      "if (moments.b <= 0.0 && coverageVariance <= CLOUD_MOMENT_F16_QUANTUM) {",
    ),
  );
});

test("D4 THE C13-12 BOUNDARY — the consumption variant contains NO tuned number", () => {
  // The ledger gives C13-12 "attachment-aware motion/depth rejection, variance
  // clipping, reactive history, wind advection in reprojection, disocclusion".
  // Every one of those introduces a tuned constant. This test scans the lines
  // that exist ONLY in the consumption variant and requires each numeric
  // literal to be a bound (0/1/0.5), an index, or the storage quantum. A depth
  // threshold in metres, a clip width in sigmas or a reactivity ramp fails
  // HERE — in C13-10's spec — rather than in a review of C13-12's.
  const allowed = new Set(["0", "1", "0.0", "1.0", "0.5", "2"]);
  const quantumDeclaration =
    "const CLOUD_MOMENT_F16_QUANTUM: f32 = 0.0009765625;";
  let sawQuantum = 0;
  let bindings = 0;
  for (const line of variantOnlyLines(resolveWgsl, CONSUME)) {
    if (line === quantumDeclaration) {
      sawQuantum++;
      continue;
    }
    // `@group(0) @binding(4)` carries binding INDICES, not tuned constants.
    if (line.startsWith("@group(")) {
      bindings++;
      continue;
    }
    for (const literal of line.match(/(?<![\w.])\d+(?:\.\d+)?(?:e-?\d+)?/g) ??
      []) {
      assert.ok(
        allowed.has(literal),
        `the consumption variant introduces the tuned constant ${literal} in:\n  ${line}\nThresholded rejection is C13-12's row, not C13-10's.`,
      );
    }
  }
  assert.equal(
    sawQuantum,
    1,
    "the storage quantum must be declared exactly once, as a named constant",
  );
  assert.equal(
    bindings,
    3,
    "the consumption variant must bind exactly the three owned attachments",
  );
  // The same discipline in the CPU twin: its only constant is the quantum.
  const twin = attachmentModuleSource.slice(
    attachmentModuleSource.indexOf(
      "export function classifyCloudReconstructionHistory(",
    ),
  );
  const twinBody = twin.slice(0, twin.indexOf("\n}\n") + 3);
  for (const literal of twinBody.match(/(?<![\w.])\d+(?:\.\d+)?/g) ?? []) {
    assert.ok(
      allowed.has(literal),
      `the CPU twin introduces the tuned constant ${literal} — that is C13-12's row`,
    );
  }
});

test("D5 the consumer uses the PRODUCER's motion vector rather than re-deriving it", () => {
  // Re-projecting here would be a second implementation of the producer's
  // transform, and the two would drift — exactly what the C13-03 shared-contract
  // rule exists to prevent.
  const consume = preprocess(resolveWgsl, 0, CONSUME);
  assert.ok(consume.includes("let previousUv = uv - velocity.rg;"));
  const consumeOnly = variantOnlyLines(resolveWgsl, CONSUME).join("\n");
  assert.ok(
    !consumeOnly.includes("previousViewProjectionRelativeToEye"),
    "the consuming path must not project through the previous VP itself",
  );
  assert.ok(
    !consumeOnly.includes("representativeShellDistance"),
    "the consuming path must not fall back to the geometric proxy",
  );
  // The DEFAULT path still does both — it has no attachment to read.
  const base = defaultVariant(resolveWgsl);
  assert.ok(
    base.includes(
      "let shellDistance = representativeShellDistance(rayDirection);",
    ),
  );
  assert.ok(base.includes("u.previousViewProjectionRelativeToEye *"));
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Renderer wiring, lifetime, and counters
// ─────────────────────────────────────────────────────────────────────────────

test("E1 both opt-ins are DEFAULT OFF, and reconstruction implies the attachments", () => {
  pinWithMutant(
    cloudRenderer,
    /reconstructionEnabled: false,/,
    (s) =>
      s.replace(
        "reconstructionEnabled: false,",
        "reconstructionEnabled: true,",
      ),
    "the cache initialises march-emitted reconstruction to off",
  );
  // Enabling the consumer without the set would read a texture that was never
  // allocated; disabling the set must take the consumer with it.
  const setter = cloudRenderer.slice(
    cloudRenderer.indexOf("export function setCloudReconstruction("),
  );
  assert.match(
    setter,
    /cache\.reconstructionEnabled = enabled;\n\s*if \(enabled\) \{\n\s*cache\.attachmentsEnabled = true;/,
  );
  const attachmentSetter = cloudRenderer.slice(
    cloudRenderer.indexOf("export function setCloudReconstructionAttachments("),
    cloudRenderer.indexOf("export function setCloudReconstruction("),
  );
  assert.match(
    attachmentSetter,
    /if \(!enabled\) \{\n\s*cache\.reconstructionEnabled = false;/,
    "clearing the set must clear the dependent flag, not leave a half-armed variant",
  );
  // ...and the same self-heal for the debug surface, which writes the field
  // directly without going through either setter.
  pinWithMutant(
    cloudRenderer,
    /if \(!cache\.attachmentsEnabled && cache\.reconstructionEnabled\) \{\n\s*cache\.reconstructionEnabled = false;/,
    (s) =>
      s.replace(
        "  if (!cache.attachmentsEnabled && cache.reconstructionEnabled) {\n    cache.reconstructionEnabled = false;\n  }\n",
        "",
      ),
    "a directly-cleared attachment flag disarms the variant on the next execute",
  );
});

test("E2 the emitting march writes the DEPTH slot with the contract's own clear value", () => {
  const marchBlock = cloudRenderer.slice(
    cloudRenderer.indexOf("const halfPass = encoder.beginRenderPass("),
    cloudRenderer.indexOf("halfPass.setPipeline("),
  );
  assert.ok(marchBlock.length > 0);
  assert.match(
    marchBlock,
    /view: cache\.attachmentViews\[CLOUD_MARCH_EMITTED_SLOT - 1\]!,/,
  );
  assert.match(
    marchBlock,
    /clearValue:\n\s*CLOUD_OWNED_ATTACHMENTS\[CLOUD_MARCH_EMITTED_SLOT - 1\]\n\s*\.clearValue,/,
    "the sentinel must come from the contract, or a missed texel reads as distance zero",
  );
  // The attachment resources are resolved BEFORE the march, because the march
  // is now one of the passes that writes them.
  const stage = cloudRenderer.indexOf("const attachmentStageActive =");
  const halfPass = cloudRenderer.indexOf(
    "const halfPass = encoder.beginRenderPass(",
  );
  assert.ok(
    stage > 0 && stage < halfPass,
    "the attachment set must exist before the emitting march encodes",
  );
  // Both halves of the handshake are required together.
  assert.match(
    cloudRenderer,
    /const emitReconstruction =\n\s*attachmentsReady && cloudReconstructionVariantReady\(cache\);/,
  );
  const ready = cloudRenderer.slice(
    cloudRenderer.indexOf("function cloudReconstructionVariantReady("),
  );
  for (const field of [
    "halfEmitPipeline",
    "attachmentEmitPipeline",
    "attachmentEmitBindGroup",
  ]) {
    assert.ok(
      ready.slice(0, 900).includes(field),
      `${field} is not required before the variant runs — a half-applied variant could encode`,
    );
  }
});

test("E3 the emitting producer writes the REMAINING targets, offset past the march's", () => {
  assert.match(
    cloudRenderer,
    /const producedAttachments = emitReconstruction\n\s*\? CLOUD_EMITTED_ATTACHMENTS\n\s*: CLOUD_OWNED_ATTACHMENTS;/,
  );
  assert.match(
    cloudRenderer,
    /const producedViewOffset = emitReconstruction \? 1 : 0;/,
    "the emitted list starts at contract slot 2, so its views start one further in",
  );
  assert.match(
    cloudRenderer,
    /view: cache\.attachmentViews\[index \+ producedViewOffset\]!,/,
  );
  // The producer pass label is unchanged, so the pass registry and every
  // existing counter keep meaning what they meant.
  assert.match(cloudRenderer, /label: "CloudReconstructionAttachments pass",/);
});

test("E4 a frame that did not PRODUCE the set cannot CONSUME it", () => {
  // Consuming a set the producer skipped this frame would validate this
  // frame's history against last frame's motion vectors — the stale-set
  // failure C13-09's per-frame flag exists to make impossible.
  pinWithMutant(
    cloudRenderer,
    /const consumeReconstruction =\n\s*cache\.reconstructionEnabled &&\n\s*cache\.attachmentRenderedThisFrame &&\n\s*ensureCloudTemporalConsumeBindGroups\(device, cache\);/,
    (s) =>
      s.replace(
        "        cache.reconstructionEnabled &&\n        cache.attachmentRenderedThisFrame &&\n",
        "        cache.reconstructionEnabled &&\n",
      ),
    "the consuming resolve is gated on the set having been produced this frame",
  );
  // And a culled frame resets both verdicts up front.
  pinWithMutant(
    cloudRenderer,
    /existingCache\.reconstructionEmittedThisFrame = false;\n\s*existingCache\.reconstructionConsumedThisFrame = false;/,
    (s) =>
      s.replace(
        "    existingCache.reconstructionEmittedThisFrame = false;\n    existingCache.reconstructionConsumedThisFrame = false;\n",
        "",
      ),
    "a culled frame must not report that the march emitted",
  );
});

test("E5 the consuming bind groups are keyed on the monotonic attachment generation", () => {
  const ensure = cloudRenderer.slice(
    cloudRenderer.indexOf("function ensureCloudTemporalConsumeBindGroups("),
    cloudRenderer.indexOf("function ensureCloudAttachmentResources("),
  );
  assert.ok(ensure.length > 0, "the consume-group builder moved");
  pinWithMutant(
    ensure,
    /cache\.temporalConsumeAttachmentGeneration !== generation/,
    (s) =>
      s.replace(
        "cache.temporalConsumeAttachmentGeneration !== generation",
        "false",
      ),
    "a resize or device swap must rebuild the groups",
  );
  assert.match(
    ensure,
    /generation <= 0 \|\|/,
    "generation 0 means nothing is allocated",
  );
  // Release drops them rather than trusting the key alone — the textures they
  // reference have just been destroyed.
  const releaseStart = cloudRenderer.indexOf(
    "function releaseCloudAttachmentResources(",
  );
  assert.ok(releaseStart > 0, "the release function moved");
  const release = cloudRenderer.slice(
    releaseStart,
    cloudRenderer.indexOf("\n}", releaseStart),
  );
  assert.match(release, /cache\.attachmentEmitBindGroup = null;/);
  assert.match(release, /cache\.attachmentEmitBindGroupDepthView = null;/);
  assert.match(release, /cache\.temporalConsumeBindGroups = \[null, null\];/);
  assert.match(release, /cache\.temporalConsumeAttachmentGeneration = 0;/);
  // ...and the generation itself is NEVER rewound — C13-09's contract, which
  // is exactly what makes the key comparison above safe.
  assert.match(release, /releaseCloudAttachmentGeneration\(/);
});

test("E6 the counters distinguish REQUESTED from EMITTED from CONSUMED", () => {
  for (const field of [
    "reconstructionRequested",
    "reconstructionEmitted",
    "reconstructionConsumed",
    "reconstructionProducerTargets",
  ]) {
    assert.ok(
      observabilitySource.includes(`${field}: number;`),
      `${field} is missing from the counter record`,
    );
  }
  const resetBlock = observabilitySource.slice(
    observabilitySource.indexOf("const RESET_FIELDS"),
    observabilitySource.indexOf("createCloudFrameCounters"),
  );
  // Per-frame verdicts reset...
  for (const field of [
    "reconstructionEmitted",
    "reconstructionConsumed",
    "reconstructionProducerTargets",
  ]) {
    assert.ok(
      resetBlock.includes(`"${field}"`),
      `${field} is a per-frame verdict and must be reset`,
    );
  }
  // ...but the RESIDENT request does not, or a frame that fell back would read
  // as "nobody asked" instead of "asked and could not".
  assert.ok(
    !resetBlock.includes('"reconstructionRequested"'),
    "zeroing the resident request would hide every fallback",
  );
  // Published under the reconstruction surface, beside the attachment block.
  assert.match(
    observabilitySource,
    /emission: \{\n\s*requested: c\.reconstructionRequested > 0,\n\s*emitted: c\.reconstructionEmitted > 0,\n\s*consumed: c\.reconstructionConsumed > 0,\n\s*producerTargets: c\.reconstructionProducerTargets,\n\s*\},/,
  );
  // `producerTargets` is what proves ownership MOVED rather than the depth
  // slot being written twice: 3 on the estimator path, 2 when the march wrote
  // slot 1 itself.
  assert.equal(CLOUD_OWNED_ATTACHMENTS.length, 3);
  assert.equal(CLOUD_EMITTED_ATTACHMENTS.length, 2);
});

test("E7 the debug surface exposes the toggle, and says the output may change", () => {
  assert.match(debugSource, /cloudReconstruction\(enabled\) \{/);
  assert.match(debugSource, /cache\.reconstructionEnabled = enabled;/);
  assert.ok(
    debugSource.includes(
      "CesiumDebug.cloudReconstruction(t/f) — C13-10 march-emitted depth + consumer",
    ),
    "a command that is not in help() is a command nobody finds",
  );
  // C13-09's command still says the composite is unchanged; C13-10's must NOT,
  // because this is the first row for which that stops being true.
  const c10 = debugSource.slice(
    debugSource.indexOf("cloudReconstruction(enabled) {"),
  );
  assert.match(c10.slice(0, 2600), /composite MAY differ/);
  assert.ok(
    !debugSource.includes("WebGPUProceduralCloudRenderer"),
    "CesiumDebug must not statically import the lazily-chunked cloud renderer",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F. naga — every variant the renderer can compile
// ─────────────────────────────────────────────────────────────────────────────

test("F1 all six compiled forms pass naga validation", async () => {
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
  const densityDomain = readEngine(
    "Shaders/WebGPU/Environment/CloudDensityDomain.wgsl",
  );
  const forms = [
    ["march default", `${densityDomain}\n${defaultVariant(marchWgsl)}`],
    ["march emit", `${densityDomain}\n${preprocess(marchWgsl, 0, EMIT)}`],
    ["producer default", defaultVariant(producerWgsl)],
    ["producer emit", preprocess(producerWgsl, 0, EMIT)],
    ["resolve default", defaultVariant(resolveWgsl)],
    ["resolve consume", preprocess(resolveWgsl, 0, CONSUME)],
  ];
  for (const [label, source] of forms) {
    assert.doesNotThrow(
      () => naga.validate_wgsl(source),
      `naga rejected ${label}`,
    );
  }
});

test("F2 bounded loops — the emission adds no unbounded traversal", async () => {
  // Every loop the variants introduce must have a compile-time bound. The
  // march's own `maxIter` sentinel is untouched by this row (the emission is a
  // running sum inside the existing loop body, not a new traversal), and the
  // producer/resolve neighbourhoods stay 3x3.
  const emitMarch = preprocess(marchWgsl, 0, EMIT);
  assert.ok(
    emitMarch.includes("let maxIter: i32 = steps * 3;"),
    "the march's permanent loop sentinel must survive the variant",
  );
  assert.ok(emitMarch.includes("if (guard > maxIter) { break; }"));
  for (const [label, source] of [
    ["producer emit", preprocess(producerWgsl, 0, EMIT)],
    ["resolve consume", preprocess(resolveWgsl, 0, CONSUME)],
  ]) {
    const loops = [...source.matchAll(/for \(var (\w+): i32 = -1; \1 <= 1;/g)];
    assert.ok(
      loops.length <= 2,
      `${label} grew beyond its 3x3 neighbourhood loops`,
    );
    assert.ok(
      !/\bloop\s*\{/.test(source),
      `${label} introduced an unbounded WGSL loop`,
    );
  }
});

// ---------------------------------------------------------------------------
// G — Batch 942 regression pin: NO RUNTIME COMPILE OF RAW IFDEF-BEARING WGSL
// ---------------------------------------------------------------------------
// The C13-10 landing left four device.createShaderModule sites compiling
// PROCEDURAL_CLOUDS_SOURCE / CloudTemporalResolveWGSL RAW. Raw text carries
// BOTH //>>ifdef branches, which is invalid WGSL post-C13-10 ("redeclaration
// of 'previousUv'", "expected '}'"), and the browser logged compile errors on
// every page while the working pipelines came from the preprocessed sites —
// caught by the C13-09 survival run's zeroErrors gate, corroborated by the
// cross-page noise floor collapsing 37% → 0.03% (the broken default resolve
// killed temporal history). Every compile of an ifdef-bearing cloud source
// must route through preprocess(); defines=0 emits the //>>else branch,
// byte-identical to the pre-C13-10 module (F1b), so this is free.
test("G1: no createShaderModule site compiles PROCEDURAL_CLOUDS_SOURCE or CloudTemporalResolveWGSL raw", () => {
  assert.ok(
    !/code:\s*PROCEDURAL_CLOUDS_SOURCE\s*,/.test(cloudRenderer),
    "a shader-module site compiles the march RAW — route it through preprocess(source, defines, definesHi)",
  );
  assert.ok(
    !/code:\s*CloudTemporalResolveWGSL\s*,/.test(cloudRenderer),
    "a shader-module site compiles the temporal resolve RAW — route it through preprocess(source, defines, definesHi)",
  );
  assert.ok(
    !/code:\s*CloudReconstructionAttachmentsWGSL\s*,/.test(cloudRenderer),
    "a shader-module site compiles the attachment producer RAW — route it through preprocess(source, defines, definesHi)",
  );
  // The default-branch compiles exist and are explicit about defines=0.
  const zeroPre = (
    cloudRenderer.match(
      /preprocess\(\s*(?:PROCEDURAL_CLOUDS_SOURCE|CloudTemporalResolveWGSL),\s*0,\s*0,?\s*\)/g,
    ) ?? []
  ).length;
  assert.ok(
    zeroPre >= 4,
    `expected the four historical compile sites to preprocess at defines=0 (found ${zeroPre})`,
  );
});
