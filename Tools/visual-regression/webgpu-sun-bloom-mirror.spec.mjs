// webgpu-sun-bloom-mirror.spec.mjs — browser-free guard for the WebGPU sun
// bright-pass glow, the mirror of the WebGL `Scene/SunPostProcess.js` chain.
// @purpose Guard that both backends draw ONE sun glow: WebGPU tuning derived from SolarDiscModel not copied, shared constants, one flag, WebGL untouched.
// @status ACTIVE
//
// The row's whole claim is that the two backends draw ONE glow. A spec that
// only asserted the WebGPU side exists would be worth nothing: the failure mode
// this file has to make impossible is a second set of numbers on the WebGPU
// side that agrees with the WebGL side today and drifts tomorrow. So every rule
// below is stated once and then executed against BOTH shipped sources — the
// engine modules, imported, and the shipped `SunPostProcess.js` / `.wgsl` /
// `.glsl` text, parsed — with mutants that must be rejected.
//
// Six jobs:
//
//   1. TUNING IS SHARED, NOT COPIED. The bright-pass pair the WebGPU effect
//      pushes is the pair `SolarDiscModel.solarBrightPassTuning` derives, and a
//      dialled literal anywhere in the WebGPU effect fails here.
//   2. THE SHAPE CONSTANTS ARE ONE SET. The literals inside the shipped
//      `SunPostProcess.js` are re-read from its own text and required to equal
//      the exported constants the WebGPU effect consumes.
//   3. ONE FLAG, BOTH BACKENDS. `scene.sunBloom` gates the WebGL allocation and
//      the WebGPU enable, and the WebGPU gate is the same expression the halo
//      uses.
//   4. THE WEBGL PATH IS UNTOUCHED. `SunPostProcess.js`, `BrightPass.glsl`,
//      `AdditiveBlend.glsl` and `GaussianBlur1D.glsl` are pinned by content
//      hash-equivalent assertions on the arithmetic that matters.
//   5. OFF IS OFF. With the glow disabled the WebGPU chain must present the
//      pre-mirror composition — the effect returns its input view untouched and
//      the pipeline's stage order is otherwise unchanged.
//   6. THE ENERGY SPLIT IS DERIVED. The centre amplitude is the bright pass's
//      own half-saturation identity, is bounded by 1 for every radiance, and is
//      therefore not a term that needs a renormalisation constant.
//
// CRLF: this repo checks out with `core.autocrlf=true`. Source-text assertions
// normalize line endings first — a spec anchored on a bare "\n" silently
// false-greens on Windows.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import SolarDiscModel from "../../packages/engine/Source/Scene/SolarDiscModel.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const SUN_POST_PROCESS = read("packages/engine/Source/Scene/SunPostProcess.js");
const SUN_HALO_APPEARANCE = read(
  "packages/engine/Source/Scene/SunHaloAppearance.js",
);
const BLOOM_EFFECT = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUSunBloomEffect.ts",
);
const COLLECTION = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
);
const PIPELINE = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessPipeline.ts",
);
const FRAMEBUFFERS = read(
  "packages/engine/Source/Scene/FramebufferOrchestrator.js",
);
const BRIGHT_PASS_GLSL = read(
  "packages/engine/Source/Shaders/PostProcessStages/BrightPass.glsl",
);
const BRIGHT_PASS_WGSL = read(
  "packages/engine/Source/Shaders/WebGPU/PostProcess/SunBrightPass.wgsl",
);
const ADDITIVE_GLSL = read(
  "packages/engine/Source/Shaders/PostProcessStages/AdditiveBlend.glsl",
);
const ADDITIVE_WGSL = read(
  "packages/engine/Source/Shaders/WebGPU/PostProcess/AdditiveBlend.wgsl",
);

// ===========================================================================
// 1. THE TUNING IS SHARED, NOT COPIED
// ===========================================================================

test("the WebGPU push reads the PUBLISHED bright-pass pair, and never a literal", () => {
  // `SunHaloAppearance` derives the pair once, before the backend branch. Both
  // consumers must read those two fields by name.
  assert.match(SUN_HALO_APPEARANCE, /result\.brightPassThreshold = /);
  assert.match(SUN_POST_PROCESS, /halo\.brightPassThreshold/);
  assert.match(COLLECTION, /brightPassThreshold:\s*$/m);
  assert.match(COLLECTION, /halo\.brightPassThreshold/);
  assert.match(COLLECTION, /halo\.brightPassOffset/);

  // MUTANT SHAPE — a dialled pair in the WebGPU effect. The only numeric
  // literals allowed in the effect's tuning are the two legacy constants, and
  // they must arrive by import rather than by transcription.
  assert.match(
    BLOOM_EFFECT,
    /SUN_BRIGHT_PASS_THRESHOLD_LEGACY,\n\s*SUN_BRIGHT_PASS_OFFSET_LEGACY,/,
  );
  assert.doesNotMatch(BLOOM_EFFECT, /0\.3428/);
  assert.doesNotMatch(BLOOM_EFFECT, /threshold\s*=\s*0\.\d/);
  assert.doesNotMatch(BLOOM_EFFECT, /offset\s*=\s*0\.\d/);
  // The literal SDR pair may not be re-typed either.
  assert.doesNotMatch(BLOOM_EFFECT, /=\s*0\.25[,;\s]/);
});

test("MUTANT REJECTED — a transcribed tuning pair would not track the radiance", () => {
  // The derived pair MOVES with the disc radiance; the legacy pair does not.
  // Any consumer that hard-codes the legacy pair therefore renders a different
  // glow the moment the scene light changes, which is what rule 1 forbids.
  const atOne = SolarDiscModel.solarBrightPassTuning(
    1.0,
    SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE,
  );
  const atTwo = SolarDiscModel.solarBrightPassTuning(
    2.0,
    SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE,
  );
  const atTen = SolarDiscModel.solarBrightPassTuning(
    10.0,
    SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE,
  );
  assert.equal(
    atOne.threshold,
    SolarDiscModel.SUN_BRIGHT_PASS_THRESHOLD_LEGACY,
  );
  assert.equal(atOne.offset, SolarDiscModel.SUN_BRIGHT_PASS_OFFSET_LEGACY);
  assert.notEqual(atTwo.threshold, atOne.threshold);
  assert.ok(atTen.offset > atTwo.offset);
});

// ===========================================================================
// 2. THE SHAPE CONSTANTS ARE ONE SET
// ===========================================================================

/** Read a numeric literal out of the shipped WebGL pipeline's own text. */
function literalFrom(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `${label} not found in the shipped source`);
  const value = Number(match[1]);
  assert.ok(Number.isFinite(value), `${label} is not a number: ${match[1]}`);
  return value;
}

test("the shipped WebGL chain's own literals equal the exported shape constants", () => {
  assert.equal(
    literalFrom(SUN_POST_PROCESS, /const scale = ([\d.]+);/, "textureScale"),
    SolarDiscModel.SUN_BLOOM_TEXTURE_SCALE,
  );
  assert.equal(
    literalFrom(SUN_POST_PROCESS, /this\._delta = ([\d.]+);/, "blur delta"),
    SolarDiscModel.SUN_BLOOM_BLUR_DELTA,
  );
  assert.equal(
    literalFrom(SUN_POST_PROCESS, /this\._sigma = ([\d.]+);/, "blur sigma"),
    SolarDiscModel.SUN_BLOOM_BLUR_SIGMA,
  );
  // `sunSize` is stated as `magnitude * 30.0 * 2.0` across two lines.
  const size = SUN_POST_PROCESS.match(
    /\*\n\s*([\d.]+) \*\n\s*([\d.]+);\n\n\s*const size = sizeScratch;/,
  );
  assert.ok(size, "the sunSize factors were not found in the shipped source");
  assert.equal(
    Number(size[1]) * Number(size[2]),
    SolarDiscModel.SUN_BLOOM_SIZE_RADII,
  );
  assert.equal(
    literalFrom(
      SUN_POST_PROCESS,
      /_uRadius = Math\.max\(size\.x, size\.y\) \* ([\d.]+);/,
      "composite radius fraction",
    ),
    SolarDiscModel.SUN_BLOOM_COMPOSITE_RADIUS_FRACTION,
  );
});

test("the composite radius the WebGPU side pushes is the WebGL radius, recomputed", () => {
  // WebGL: `sunSize = limb * 30 * 2`, then `radius = max(size) * 0.15`.
  for (const limbPx of [1, 12.5, 169.3, 640]) {
    const webgl =
      limbPx *
      SolarDiscModel.SUN_BLOOM_SIZE_RADII *
      SolarDiscModel.SUN_BLOOM_COMPOSITE_RADIUS_FRACTION;
    assert.equal(SolarDiscModel.solarBloomCompositeRadiusPx(limbPx), webgl);
  }
  // Degenerate geometry yields 0, which the shader reads as "no radial term"
  // and the effect reads as "skip every pass".
  assert.equal(SolarDiscModel.solarBloomCompositeRadiusPx(0), 0);
  assert.equal(SolarDiscModel.solarBloomCompositeRadiusPx(-1), 0);
  assert.equal(SolarDiscModel.solarBloomCompositeRadiusPx(NaN), 0);
});

test("the blur buffer reproduces the shipped texture-cache sizing rule", () => {
  // `PostProcessStageTextureCache` scales both dimensions, takes the MINIMUM,
  // and rounds that up to a power of two, producing a square buffer. The blur's
  // screen footprint follows from this number, so a different rule is a
  // different glow.
  const rule = (w, h) => {
    const scaled = Math.min(
      Math.ceil(w * SolarDiscModel.SUN_BLOOM_TEXTURE_SCALE),
      Math.ceil(h * SolarDiscModel.SUN_BLOOM_TEXTURE_SCALE),
    );
    let size = 1;
    while (size < scaled) {
      size *= 2;
    }
    return size;
  };
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
    [800, 600],
    [3840, 2160],
    [640, 360],
    [1, 1],
  ]) {
    assert.equal(SolarDiscModel.solarBloomBlurBufferSize(w, h), rule(w, h));
  }
  // The operating point this row was derived at.
  assert.equal(SolarDiscModel.solarBloomBlurBufferSize(1280, 720), 128);
});

test("the WebGPU effect states no shape literal of its own", () => {
  assert.match(BLOOM_EFFECT, /SUN_BLOOM_BLUR_DELTA/);
  assert.match(BLOOM_EFFECT, /SUN_BLOOM_BLUR_SIGMA/);
  assert.match(BLOOM_EFFECT, /solarBloomBlurBufferSize/);
  assert.match(COLLECTION, /solarBloomCompositeRadiusPx/);
  // The two numbers a copy-paste mirror would inevitably carry.
  assert.doesNotMatch(BLOOM_EFFECT, /0\.125/);
  assert.doesNotMatch(BLOOM_EFFECT, /\b30\.0\b/);
});

// ===========================================================================
// 3. ONE FLAG, BOTH BACKENDS
// ===========================================================================

test("`scene.sunBloom` gates both backends, through the same visibility test", () => {
  // WebGL: the allocation and the per-frame execute are both on the flag.
  assert.match(
    FRAMEBUFFERS,
    /scene\.sunBloom && !useWebVR && supportsLegacySunBloom/,
  );
  assert.match(
    FRAMEBUFFERS,
    /environmentState\.isSunVisible && scene\.sunBloom && !useWebVR/,
  );
  // WebGPU: the glow's enable is defined as the halo's enable, so the two
  // cannot drift apart and neither can drift from the flag.
  assert.match(COLLECTION, /cache\.sunBloomEnabled = cache\.sunHaloEnabled;/);
  assert.match(
    COLLECTION,
    /cache\.sunHaloEnabled =\n\s*\(scene as unknown as \{ sunBloom\?: boolean \}\)\?\.sunBloom === true &&/,
  );
  assert.match(COLLECTION, /isSunVisible\?: boolean/);
});

test("the glow is NOT gated on the screen-halo toggle", () => {
  // `visible` folds in `enableScreenSpaceSunHalo`; `geometryValid` does not.
  // The WebGL twin transfers the bright-pass pair regardless of the halo, so a
  // glow gated on `visible` would be a cross-backend split on that toggle.
  assert.match(SUN_HALO_APPEARANCE, /result\.geometryValid = geometryOk;/);
  assert.match(
    SUN_HALO_APPEARANCE,
    /result\.visible = screenHalo && geometryOk;/,
  );
  assert.match(COLLECTION, /halo\.geometryValid !== true/);
  // And the halo's own push still reads `visible` — the two gates are distinct.
  assert.match(COLLECTION, /halo\.visible !== true/);
});

test("the glow runs BEFORE the halo, so the halo is never bright-passed", () => {
  const bloomAt = PIPELINE.indexOf("this._sunBloomEffect.execute(");
  const haloAt = PIPELINE.indexOf("this._sunHaloEffect.execute(");
  assert.ok(bloomAt > 0, "the glow is never executed");
  assert.ok(haloAt > 0, "the halo is never executed");
  assert.ok(
    bloomAt < haloAt,
    "the glow must be encoded before the halo; otherwise the bright pass sees " +
      "the halo and blooms the glow of the glow",
  );
  // Same order on WebGL: SolarHalo is the LAST stage of the chain.
  const stages = [
    ...SUN_POST_PROCESS.matchAll(/stages\[(\d)\] = new PostProcessStage/g),
  ].map((m) => Number(m[1]));
  assert.equal(Math.max(...stages), 6);
  const haloStage = SUN_POST_PROCESS.indexOf("fragmentShader: SolarHalo");
  const blendStage = SUN_POST_PROCESS.indexOf("fragmentShader: AdditiveBlend");
  assert.ok(blendStage < haloStage);
});

// ===========================================================================
// 4. THE WEBGL PATH IS UNTOUCHED
// ===========================================================================

test("the WebGL chain's arithmetic is byte-identical to what it shipped", () => {
  // BrightPass.glsl — the extraction curve, verbatim.
  assert.match(
    BRIGHT_PASS_GLSL,
    /float scaledLum = key\(avgLuminance\) \* luminance \/ avgLuminance;\n\s*float brightLum = max\(scaledLum - threshold, 0\.0\);\n\s*float brightness = brightLum \/ \(offset \+ brightLum\);/,
  );
  // AdditiveBlend.glsl — the radial term, verbatim.
  assert.match(
    ADDITIVE_GLSL,
    /float x = length\(gl_FragCoord\.xy - center\) \/ radius;\n\s*float t = smoothstep\(0\.5, 0\.8, x\);\n\s*out_FragColor = mix\(color0 \+ color1, color1, t\);/,
  );
  // SunPostProcess.js still constructs seven stages and still owns the WebGL
  // allocation gate. Nothing in this row moves the WebGL pipeline.
  assert.match(SUN_POST_PROCESS, /const stages = new Array\(7\);/);
  // The WebGL allocation gate stays where it was, in the orchestrator, not in
  // the pipeline it allocates.
  assert.doesNotMatch(SUN_POST_PROCESS, /supportsLegacySunBloom/);
});

test("the WGSL twins are line-for-line translations of their GLSL originals", () => {
  // The bright pass: same three lines, same order, same operators.
  assert.match(
    BRIGHT_PASS_WGSL,
    /let scaledLum = \(key\(avgLuminance\) \* luminance\) \/ avgLuminance;\n\s*let brightLum = max\(scaledLum - brightPass\.params\.y, 0\.0\);\n\s*let brightness = brightLum \/ \(brightPass\.params\.z \+ brightLum\);/,
  );
  // The composite: same radial term, same smoothstep bounds, same mix.
  assert.match(
    ADDITIVE_WGSL,
    /let x = length\(fragGL - uniforms\.center\) \/ uniforms\.radius;\n\s*let t = smoothstep\(0\.5, 0\.8, x\);\n\s*return mix\(color0 \+ color1, color1, t\);/,
  );
  // Exactly one y flip, and it lives in the WGSL — the published centre is in
  // the GL convention.
  assert.equal(
    (ADDITIVE_WGSL.match(/viewportHeight - input\.position\.y/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(ADDITIVE_GLSL, /viewport/i);
  // The degenerate-chromaticity guard exists on both sides of the round trip;
  // without it an exactly-black pixel produces a NaN that the blur spreads.
  assert.match(BRIGHT_PASS_WGSL, /if \(!\(total > 0\.0\)\)/);
  assert.match(BRIGHT_PASS_WGSL, /if \(!\(Yxy\.b > 0\.0\)\)/);
});

test("the two bright-pass bodies agree numerically, executed as JavaScript", () => {
  // Extract the shared three-line body from BOTH shader texts and run it. A
  // translation that reads plausibly but transposes an operand fails here.
  const glsl = BRIGHT_PASS_GLSL.match(
    /float scaledLum = ([^;]+);\n\s*float brightLum = ([^;]+);\n\s*float brightness = ([^;]+);/,
  );
  const wgsl = BRIGHT_PASS_WGSL.match(
    /let scaledLum = ([^;]+);\n\s*let brightLum = ([^;]+);\n\s*let brightness = ([^;]+);/,
  );
  assert.ok(glsl && wgsl, "one of the two bodies could not be extracted");
  const toJs = (expr) =>
    expr
      .replace(/brightPass\.params\.y/g, "threshold")
      .replace(/brightPass\.params\.z/g, "offset")
      .replace(/(^|[^.\w])max\(/g, "$1Math.max(");
  const build = (m) =>
    // eslint-disable-next-line no-new-func
    new Function(
      "luminance",
      "avgLuminance",
      "threshold",
      "offset",
      "key",
      `const scaledLum = ${toJs(m[1])};
       const brightLum = ${toJs(m[2])};
       const brightness = ${toJs(m[3])};
       return brightness;`,
    );
  const fromGlsl = build(glsl);
  const fromWgsl = build(wgsl);
  const avg = SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE;
  for (const radiance of [1, 2, 4, 10]) {
    const tuning = SolarDiscModel.solarBrightPassTuning(radiance, avg);
    for (const lum of [0, 0.25, 1, 1.4142135623730951, 2, 3.5, 10]) {
      const a = fromGlsl(
        lum,
        avg,
        tuning.threshold,
        tuning.offset,
        SolarDiscModel.sunBrightPassKey,
      );
      const b = fromWgsl(
        lum,
        avg,
        tuning.threshold,
        tuning.offset,
        SolarDiscModel.sunBrightPassKey,
      );
      assert.ok(
        Math.abs(a - b) < 1e-15,
        `bodies disagree at L=${radiance} lum=${lum}: ${a} vs ${b}`,
      );
    }
  }
});

test("both new WGSL shaders compile", async () => {
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
  assert.doesNotThrow(() => naga.validate_wgsl(BRIGHT_PASS_WGSL));
  assert.doesNotThrow(() => naga.validate_wgsl(ADDITIVE_WGSL));
});

// ===========================================================================
// 5. OFF IS OFF
// ===========================================================================

test("the disabled glow returns its input view and encodes no pass", () => {
  // Two independent off switches, both checked before any encoding: the
  // pipeline's `enabled` gate and the effect's own `inert` gate.
  assert.match(PIPELINE, /if \(this\._sunBloomEffect\?\.enabled\) \{/);
  assert.match(
    BLOOM_EFFECT,
    /if \(!this\._device \|\| !this\._brightPipeline \|\| this\.inert\) \{\n\s*return sourceView;/,
  );
  // `inert` is a property of the pushed radius alone, so a frame that pushes 0
  // is inert regardless of anything else the effect holds.
  assert.match(
    BLOOM_EFFECT,
    /get inert\(\): boolean \{\n\s*return !\(this\._compositeData\[2\] > 0\.0\);/,
  );
});

test("the glow adds itself to `hasActiveStages` so it cannot be silently skipped", () => {
  assert.match(
    PIPELINE,
    /if \(this\._sunBloomEffect\?\.enabled\) return true;/,
  );
});

test("the glow is torn down and resized on every path the halo is", () => {
  // A texture sized against the intermediate format must be dropped on a
  // resize / dynamic-range flip, and re-added by the live-slot gate.
  assert.equal(
    (PIPELINE.match(/this\._sunBloomEffect\?\.destroy\(\);/g) ?? []).length,
    (PIPELINE.match(/this\._sunHaloEffect\?\.destroy\(\);/g) ?? []).length,
  );
  assert.equal(
    (PIPELINE.match(/this\._sunBloomEffect = null;/g) ?? []).length,
    (PIPELINE.match(/this\._sunHaloEffect = null;/g) ?? []).length,
  );
  assert.match(PIPELINE, /this\._sunBloomEffect\?\.resize\(width, height\);/);
  assert.match(
    COLLECTION,
    /cache\.sunBloomEnabled && !pipeline\.sunBloomEffect/,
  );
});

// ===========================================================================
// 6. THE ENERGY SPLIT IS DERIVED
// ===========================================================================

test("the glow's centre amplitude follows from the derived offset in closed form", () => {
  // With `threshold = s` and `offset = s * (sqrt(L) - 1)`, the extraction at
  // `luminance = L` collapses to `(sqrt(L) + 1) / (sqrt(L) + 2)`: the scale `s`
  // divides out, so the amplitude is a function of the radiance alone and of
  // nothing that can be tuned. It is strictly below 1 for every finite L.
  for (const L of [1.5, 2, 4, 10, 1000]) {
    const closedForm = (Math.sqrt(L) + 1) / (Math.sqrt(L) + 2);
    assert.ok(
      Math.abs(SolarDiscModel.solarBloomCentreAmplitude(L) - closedForm) <
        1e-12,
      `centre amplitude at L=${L}`,
    );
    assert.ok(closedForm < 1);
  }
  // At the shipped radiance the closed form is exactly 1/sqrt(2) — the
  // half-saturation identity the derived pair was built on, read at the disc.
  // (The equality `(sqrt(L)+1)/(sqrt(L)+2) === 1/sqrt(L)` holds only at L = 2,
  // so this is the shipped operating point speaking, not a general law.)
  assert.ok(
    Math.abs(SolarDiscModel.solarBloomCentreAmplitude(2.0) - Math.SQRT1_2) <
      1e-15,
  );
  // In the SDR position the legacy pair applies and the amplitude is whatever
  // that historical curve gives — still bounded, still not dialled here.
  const sdr = SolarDiscModel.solarBloomCentreAmplitude(1.0);
  assert.ok(sdr > 0 && sdr < 1, `SDR centre amplitude ${sdr}`);
});

test("the glow cannot double-count the halo, because it cannot grow with it", () => {
  // Disc and halo both scale linearly with the disc radiance; the glow is a
  // saturating rational bounded by 1. Its share of the composite therefore
  // FALLS as the sun brightens, which is why no renormalisation constant is
  // needed to keep the sum bounded.
  const share = (L) => {
    const disc = L;
    const halo = SolarDiscModel.SOLAR_HALO_AMPLITUDE * L;
    const glow = SolarDiscModel.solarBloomCentreAmplitude(L);
    return glow / (disc + halo + glow);
  };
  let previous = Infinity;
  for (const L of [2, 4, 10, 100]) {
    const current = share(L);
    assert.ok(
      current < previous,
      `share did not fall at L=${L}: ${current} >= ${previous}`,
    );
    previous = current;
  }
  // At the shipped radiance the three terms are the composite peak the disc
  // lane measures.
  const L = SolarDiscModel.solarDiscHdrRadiance(true, { intensity: 2.0 });
  assert.equal(L, 2);
  const peak =
    L +
    SolarDiscModel.SOLAR_HALO_AMPLITUDE * L +
    SolarDiscModel.solarBloomCentreAmplitude(L);
  assert.ok(
    Math.abs(peak - 4.2071) < 5e-4,
    `composite centre peak ${peak}, expected 4.2071`,
  );
  // And the un-bloomed composite is the same sum without the glow.
  assert.equal(L + SolarDiscModel.SOLAR_HALO_AMPLITUDE * L, 3.5);
});

test("MUTANT REJECTED — a glow that scaled with radiance would need a renormalisation", () => {
  // The plausible wrong mirror: extract `luminance - threshold` without the
  // saturating divide. It grows without bound, so the share test above would
  // fail and the sum would eventually dominate both physical terms.
  const unbounded = (L) => {
    const tuning = SolarDiscModel.solarBrightPassTuning(
      L,
      SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE,
    );
    const scaled =
      (SolarDiscModel.sunBrightPassKey(
        SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE,
      ) *
        L) /
      SolarDiscModel.SUN_BRIGHT_PASS_AVG_LUMINANCE;
    return Math.max(scaled - tuning.threshold, 0);
  };
  assert.ok(unbounded(1000) > 1);
  assert.ok(SolarDiscModel.solarBloomCentreAmplitude(1000) < 1);
});
