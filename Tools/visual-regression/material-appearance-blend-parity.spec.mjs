// material-appearance-blend-parity.spec.mjs — a material-bearing appearance
// must blend on WebGPU exactly when it blends on WebGL.
// @purpose Constructs real MaterialAppearance instances over real Materials, reads the render state the WebGL command path would carry, and runs the lifted WebGPU blend derivation and scene-framebuffer target builder against those same render states, so an appearance that blends on one backend and writes opaque on the other fails here.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// `Appearance.isTranslucent()` answers with the MATERIAL's translucency the
// moment a material is present, so `new MaterialAppearance({ translucent: true,
// material: Material.fromType("ElevationContour") })` answers `false` — the
// contour fabric registers itself opaque. `Appearance.getRenderState()` then
// forces `depthMask` back on but never clears the alpha blend the constructor
// installed, so the WebGL draw blends and a fragment with alpha 0 leaves the
// destination untouched.
//
// The WebGPU material pipelines baked their color-target blend from that same
// `isTranslucent()` boolean, so they wrote opaque. A contour material encodes
// "not on a contour line" as alpha 0, so the whole surface came out filled
// with the line colour — invariant to `width`, to `spacing`, and to the
// appearance's own `translucent` option, because none of those reach a
// discarded alpha channel.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
//   - THE WEBGL REFERENCE IS WHAT WE THINK IT IS. Real `Material` and real
//     `MaterialAppearance` instances are constructed and their real
//     `isTranslucent()` / `getRenderState()` are called. The premise that an
//     opaque-declared material still leaves a live blend is produced by the
//     engine, not asserted from a reading of it.
//   - THE TWO BACKENDS AGREE. The blend the WebGPU pipeline bakes is derived
//     by the real (lifted and executed) `resolveAppearanceBlend` +
//     `renderStateToBlendState`, and the resulting slot-0 color target is
//     built by the real (lifted and executed) `makeSceneFBTargets`. Its blend
//     is compared against the WebGPU translation of the render state WebGL
//     would have used. A pipeline that drops the blend fails.
//   - THE CACHE CANNOT SERVE THE WRONG PIPELINE. `blendCacheKey` must separate
//     a blended build from an unblended one.
//   - INERTNESS. The fix is made unreachable rather than deleted, and every
//     agreement assertion above has to go red.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No pixel is measured. Whether a contour LINE appears on a primitive is a
// separate question — the GLSL appearance shaders never populate
// `czm_materialInput.height`, so on WebGL the contour law degenerates to
// alpha 0 everywhere and there is nothing to draw. This spec only requires
// that both backends agree about the blend, which is what makes "nothing
// drawn" and "opaque fill" distinguishable at all.
//
// ENVIRONMENT SUPPLIED BY THIS SPEC (disclosed, and not the subject)
// -----------------------------------------------------------------
// `packages/engine/Source/Shaders/**/*.js` are build outputs and are absent in
// an unbuilt tree. A module hook supplies each one from the `.glsl` / `.wgsl`
// file sitting next to it, which is the same string the build would have
// emitted. A handful of DOM constructors are stubbed because
// `MaterialHelpers` uses them only in `instanceof` tests. Neither the shader
// text nor those constructors are read by anything this spec scores.

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ENGINE_SOURCE = path.join(REPO_ROOT, "packages", "engine", "Source");
const VARIANT_FILE =
  "packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts";
const COMMANDS_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts";
const TARGETS_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneFBTargetHelpers.ts";
// Gitignored, so a materialized module here is never a tracked artifact.
const OUTPUT_RELATIVE = "Tools/visual-regression/output";

// =============================================================================
// Environment
// =============================================================================

const SHADER_JS = /Shaders\/[^"']*\.js$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (SHADER_JS.test(specifier) && context.parentURL) {
      const url = new URL(specifier, context.parentURL).href;
      if (!fs.existsSync(fileURLToPath(url))) {
        return { url, format: "module", shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (SHADER_JS.test(url)) {
      const file = fileURLToPath(url);
      if (!fs.existsSync(file)) {
        let text = "";
        for (const extension of [".glsl", ".wgsl"]) {
          const candidate = file.replace(/\.js$/, extension);
          if (fs.existsSync(candidate)) {
            text = fs.readFileSync(candidate, "utf8");
            break;
          }
        }
        return {
          format: "module",
          shortCircuit: true,
          source: `export default ${JSON.stringify(text)};`,
        };
      }
    }
    return nextLoad(url, context);
  },
});

for (const name of [
  "HTMLCanvasElement",
  "HTMLImageElement",
  "HTMLVideoElement",
  "ImageBitmap",
  "OffscreenCanvas",
  "ImageData",
]) {
  if (globalThis[name] === undefined) {
    globalThis[name] = class {};
  }
}

async function engine(relative) {
  return import(pathToFileURL(path.join(ENGINE_SOURCE, relative)).href);
}

const Material = (await engine("Scene/Material.js")).default;
const MaterialAppearance = (await engine("Scene/MaterialAppearance.js"))
  .default;

// =============================================================================
// Lifting the WebGPU side out of TypeScript so it can be executed
// =============================================================================

function read(relative) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

// Lifts a function body out of a TypeScript source so it can be executed. The
// functions this is used on carry no TypeScript-only syntax in their bodies,
// and running them is the only way to score what they PRODUCE rather than what
// they are spelled as.
function liftFunctionBody(source, name, file) {
  const text = source;
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `no function ${name} in ${file}`);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") {
      depth++;
    } else if (text[index] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

// Re-emits the lifted bodies as a real ES module under the gitignored output
// directory and imports it, so the real loader runs the real source. The
// bodies go in verbatim and esbuild removes only the TypeScript annotations
// they carry — no statement is rewritten on the way through.
async function importLifted({ variant, commands, targets }) {
  const directory = fs.mkdtempSync(
    path.join(REPO_ROOT, OUTPUT_RELATIVE, "appearance-blend-"),
  );
  const file = path.join(directory, "lifted-blend.mjs");
  const body = (source, name, origin) => liftFunctionBody(source, name, origin);
  const typescript = [
    `function glBlendFactorToGPU(factor) {${body(variant, "glBlendFactorToGPU", VARIANT_FILE)}}`,
    `function glBlendEquationToGPU(eq) {${body(variant, "glBlendEquationToGPU", VARIANT_FILE)}}`,
    `export function renderStateToBlendState(renderState) {${body(variant, "renderStateToBlendState", VARIANT_FILE)}}`,
    `export function resolveAppearanceBlend(renderState, translucent) {${body(commands, "resolveAppearanceBlend", COMMANDS_FILE)}}`,
    `export function blendCacheKey(blend) {${body(commands, "blendCacheKey", COMMANDS_FILE)}}`,
    "let _mrtMode = true;",
    `const MRT_NORMAL_ROUGHNESS_FORMAT = "rgba16float";`,
    `function _buildSlot0(format, options) {${body(targets, "_buildSlot0", TARGETS_FILE)}}`,
    `export function makeSceneFBTargets(format, options = {}) {${body(targets, "makeSceneFBTargets", TARGETS_FILE)}}`,
    "",
  ].join("\n");
  fs.writeFileSync(
    file,
    esbuild.transformSync(typescript, { loader: "ts", format: "esm" }).code,
  );
  const module = await import(pathToFileURL(file).href);
  return { module, directory };
}

function discard(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

// =============================================================================
// Fixtures
// =============================================================================

// Materials whose fabric registers `translucent: false` while the appearance
// that carries them defaults to `translucent: true`. Every one of them is a
// case where the two backends could disagree.
const OPAQUE_DECLARED_MATERIALS = [
  "ElevationContour",
  "ElevationRamp",
  "SlopeRamp",
  "AspectRamp",
  "WaterMask",
];

const SCENE_FORMAT = "bgra8unorm";

function appearanceFor(type, translucent) {
  return new MaterialAppearance({
    material: Material.fromType(type),
    translucent,
  });
}

// =============================================================================
// Tests
// =============================================================================

test("an opaque-declared material leaves the appearance's alpha blend live on WebGL", () => {
  for (const type of OPAQUE_DECLARED_MATERIALS) {
    const appearance = appearanceFor(type, true);
    assert.equal(
      appearance.material.isTranslucent(),
      false,
      `${type} is expected to register itself opaque`,
    );
    assert.equal(
      appearance.isTranslucent(),
      false,
      `${type}: the material's answer is the appearance's answer`,
    );

    const renderState = appearance.getRenderState();
    assert.equal(
      renderState.depthMask,
      true,
      `${type}: an opaque answer restores depth writes`,
    );
    assert.equal(
      renderState.blending?.enabled,
      true,
      `${type}: the constructor's alpha blend survives getRenderState`,
    );
  }
});

test("an appearance built translucent:false carries no blend at all", () => {
  for (const type of OPAQUE_DECLARED_MATERIALS) {
    const renderState = appearanceFor(type, false).getRenderState();
    assert.equal(renderState.blending, undefined, `${type}`);
  }
});

// The single agreement claim, in one place, so a mutant is scored by the same
// assertions the passing case is scored by rather than by a restatement of
// what the mutant was expected to do.
function assertBackendsAgree(module) {
  for (const type of OPAQUE_DECLARED_MATERIALS) {
    const appearance = appearanceFor(type, true);
    // What the WebGPU command path passes down: the material said opaque.
    const translucent = appearance.isTranslucent();
    assert.equal(translucent, false);

    const blend = module.resolveAppearanceBlend(
      appearance.renderState,
      translucent,
    );
    const reference = module.renderStateToBlendState(
      appearance.getRenderState(),
    );
    assert.deepEqual(
      blend,
      reference,
      `${type}: the pipeline blend must equal the WebGL render state's blend`,
    );
    assert.deepEqual(blend, {
      color: {
        srcFactor: "src-alpha",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
      alpha: {
        srcFactor: "one",
        dstFactor: "one-minus-src-alpha",
        operation: "add",
      },
    });

    const targets = module.makeSceneFBTargets(SCENE_FORMAT, {
      translucent,
      blend,
    });
    assert.ok(
      targets[0].blend,
      `${type}: slot 0 must blend, or the material's alpha is written as opaque colour`,
    );
    assert.equal(targets[0].blend.color.srcFactor, "src-alpha");
  }
}

test("the WebGPU material pipeline bakes the blend WebGL would have used", async () => {
  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: read(COMMANDS_FILE),
    targets: read(TARGETS_FILE),
  });
  try {
    assertBackendsAgree(module);
  } finally {
    discard(directory);
  }
});

test("an appearance with no blend still produces an opaque pipeline", async () => {
  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: read(COMMANDS_FILE),
    targets: read(TARGETS_FILE),
  });
  try {
    const appearance = appearanceFor("ElevationContour", false);
    const blend = module.resolveAppearanceBlend(
      appearance.renderState,
      appearance.isTranslucent(),
    );
    assert.equal(blend, undefined);
    const targets = module.makeSceneFBTargets(SCENE_FORMAT, {
      translucent: false,
      blend,
    });
    assert.equal(targets[0].blend, undefined);
  } finally {
    discard(directory);
  }
});

test("the translucent path is untouched", async () => {
  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: read(COMMANDS_FILE),
    targets: read(TARGETS_FILE),
  });
  try {
    // A translucent appearance already selected the standard alpha blend
    // inside makeSceneFBTargets; the resolver must not hand it a second one.
    const appearance = appearanceFor("ElevationContour", true);
    assert.equal(
      module.resolveAppearanceBlend(appearance.renderState, true),
      undefined,
    );
    const withResolver = module.makeSceneFBTargets(SCENE_FORMAT, {
      translucent: true,
      blend: undefined,
    });
    const withoutResolver = module.makeSceneFBTargets(SCENE_FORMAT, {
      translucent: true,
    });
    assert.deepEqual(withResolver, withoutResolver);
  } finally {
    discard(directory);
  }
});

test("the pipeline cache cannot serve a blended build to an unblended one", async () => {
  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: read(COMMANDS_FILE),
    targets: read(TARGETS_FILE),
  });
  try {
    const blended = module.resolveAppearanceBlend(
      appearanceFor("ElevationContour", true).renderState,
      false,
    );
    const unblended = module.resolveAppearanceBlend(
      appearanceFor("ElevationContour", false).renderState,
      false,
    );
    assert.notEqual(
      module.blendCacheKey(blended),
      module.blendCacheKey(unblended),
    );
    assert.equal(module.blendCacheKey(undefined), "none");
  } finally {
    discard(directory);
  }
});

// =============================================================================
// Inertness
// =============================================================================
//
// The fix is made UNREACHABLE rather than deleted: `resolveAppearanceBlend`
// keeps its shape, its call and its return type, and only stops being able to
// answer with a blend. A spec that merely greps for the call site survives
// this; the assertions above must not.

test("MUTANT — a resolver that can never answer with a blend goes red", async () => {
  const commands = read(COMMANDS_FILE);
  const marker = "  return renderStateToBlendState(renderState);";
  assert.ok(
    commands.includes(marker),
    "resolveAppearanceBlend no longer ends in the expected return",
  );
  const mutated = commands.replace(
    marker,
    "  if (false) {\n    return renderStateToBlendState(renderState);\n  }\n  return undefined;",
  );
  assert.notEqual(mutated, commands);

  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: mutated,
    targets: read(TARGETS_FILE),
  });
  try {
    assert.throws(
      () => assertBackendsAgree(module),
      /AssertionError/,
      "the agreement assertions must not survive an unreachable resolver",
    );
  } finally {
    discard(directory);
  }
});

test("MUTANT — a target builder that ignores the blend goes red", async () => {
  const targetsSource = read(TARGETS_FILE);
  const marker = "  if (options.blend) {";
  assert.ok(targetsSource.includes(marker), "_buildSlot0 shape changed");
  const mutated = targetsSource.replace(
    marker,
    "  if (false && options.blend) {",
  );
  assert.notEqual(mutated, targetsSource);

  const { module, directory } = await importLifted({
    variant: read(VARIANT_FILE),
    commands: read(COMMANDS_FILE),
    targets: mutated,
  });
  try {
    // The resolver still answers, so only the target builder is inert; the
    // agreement assertions still have to notice.
    assert.ok(
      module.resolveAppearanceBlend(
        appearanceFor("ElevationContour", true).renderState,
        false,
      ),
    );
    assert.throws(
      () => assertBackendsAgree(module),
      /AssertionError/,
      "a builder that drops the blend must be visible here",
    );
  } finally {
    discard(directory);
  }
});
