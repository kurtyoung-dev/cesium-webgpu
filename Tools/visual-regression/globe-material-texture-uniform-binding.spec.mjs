#!/usr/bin/env node
// @purpose Behaviour gate for the WebGPU globe-material texture path: drives the real Material fabric, the real MaterialHelpers texture adoption and the real prelude/rewrite/assemble/preprocess chain, and requires every identifier the emitted module hands to a WGSL texture builtin to be a declaration the module actually makes.
// @status ACTIVE
//
// WHY THIS EXISTS. `createElevationBandMaterial` is the only in-tree material
// factory that puts a live `Renderer/Texture.js` instance on a fabric uniform.
// The WebGPU globe path classified it as a scalar, packed it into the material
// UBO, and emitted `textureSampleLevel(materialUniforms.heights, ...)` plus a
// bare `colorsSampler` the shader never declared. The module failed to compile,
// the pipeline was invalid, and `CommandEncoder.finish()` discarded the whole
// scene frame — on a shipped gallery demo.
//
// WHAT IS ACTUALLY CHECKED. Not source text. The material is built by the real
// `Material.fromType`, its texture uniforms are adopted by the real
// `MaterialHelpers` update functions, and its WGSL is assembled and
// preprocessed by the real renderer functions over the real `GlobeTerrain.wgsl`
// bytes. The gate is then a property of the emitted module: every argument the
// body passes to `textureSampleLevel` / `textureDimensions` must be an
// identifier the assembled module declares with a matching kind, and the
// sampler must be the one paired with that texture's binding. Both of the
// original defects violate that property, and so would any future fabric whose
// uniform names do not match the shader's slot names.
//
// The analyser is proven non-vacuous in the same file: it is run once over a
// body rewritten under the pre-fix policy (texture names left bare) and must
// report exactly the faults the diagnosis named.
//
// WHAT IS NOT CHECKED HERE. This is browser-free. It does not create a device,
// does not compile WGSL, and does not look at a pixel. The pixel and
// validation-error halves of the acceptance are
// `probe-globe-elevation-band-material.mjs`, whose gate function is also
// exercised below so it has a runner home of its own.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const Material = (
  await import("../../packages/engine/Source/Scene/Material.js")
).default;
const Texture = (
  await import("../../packages/engine/Source/Renderer/Texture.js")
).default;
const globeMaterial =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeMaterial.ts");
const { preprocess } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderPreprocessor.ts");
const { ShaderDefine } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGPUShaderDefines.ts");
const { decideElevationBandVerdicts } =
  await import("./probe-globe-elevation-band-material.mjs");
const PixelFormat = (
  await import("../../packages/engine/Source/Core/PixelFormat.js")
).default;
const PixelDatatype = (
  await import("../../packages/engine/Source/Renderer/PixelDatatype.js")
).default;
const { webglToWebGPUTextureFormat, bytesPerTexel } =
  await import("../../packages/engine/Source/Renderer/WebGPU/WebGLStateConverters.ts");

const GLOBE_TERRAIN_WGSL = fs.readFileSync(
  path.join(
    REPO_ROOT,
    "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  ),
  "utf8",
);

// `MaterialHelpers`'s texture-adoption path branches on four DOM constructors.
// They are defined only for the duration of the adoption call, and never used
// as the value under test — the value under test is a real `Texture`. Defining
// them permanently would also hide whether the WebGPU classifier survives their
// absence, which the later tests require.
const DOM_CONSTRUCTORS = [
  "HTMLVideoElement",
  "HTMLCanvasElement",
  "HTMLImageElement",
  "ImageBitmap",
];

/**
 * @param {Function} body Work to run with the DOM constructors present.
 * @returns {*} Whatever `body` returns.
 */
function withDomConstructors(body) {
  const added = [];
  for (const name of DOM_CONSTRUCTORS) {
    if (typeof globalThis[name] === "undefined") {
      globalThis[name] = class {};
      added.push(name);
    }
  }
  try {
    return body();
  } finally {
    for (const name of added) {
      delete globalThis[name];
    }
  }
}

/**
 * A `Renderer/Texture.js` instance shaped the way one is shaped under WebGPU:
 * a real `Texture` whose `_texture` handle is the WebGL-compat stub carrying
 * the WebGPU view. Constructed through the real prototype so the real
 * `instanceof Texture` branch in `MaterialHelpers` is the branch that runs; the
 * GL upload it would otherwise perform needs a device this spec does not have.
 *
 * @param {string} label Identifies the view in assertions.
 * @param {number} width Texture width.
 * @param {number} height Texture height.
 * @returns {object} The Texture.
 */
function textureWithWebGPUHandle(label, width, height) {
  const texture = Object.create(Texture.prototype);
  texture._texture = {
    _isPlaceholder: true,
    _webgpuTexture: { view: `view:${label}` },
  };
  texture._width = width;
  texture._height = height;
  return texture;
}

/**
 * Builds a material through the real fabric, replaces its texture uniforms with
 * live `Texture` instances exactly as `createElevationBandMaterial` does, and
 * runs the real `MaterialHelpers` update functions over it.
 *
 * @param {string} type The material type.
 * @param {object} textureUniforms name → Texture.
 * @returns {object} The material.
 */
function materialWithLiveTextures(type, textureUniforms) {
  const material = Material.fromType(type);
  for (const [name, value] of Object.entries(textureUniforms)) {
    material.uniforms[name] = value;
  }
  withDomConstructors(() => {
    for (const update of material._updateFunctions) {
      update(material, {});
    }
  });
  return material;
}

/**
 * Runs the real renderer chain for one material and returns the emitted body
 * plus the module-scope resource declarations of the assembled, preprocessed
 * module.
 *
 * @param {object} material A Cesium Material.
 * @returns {object} `{ textureNames, prelude, body, declarations }`.
 */
function emitModule(material) {
  const built = globeMaterial.buildMaterialPrelude(material);
  assert.ok(built, `buildMaterialPrelude returned null for ${material.type}`);
  const body = globeMaterial.rewriteMaterialBody(
    material.wgslShaderSource,
    built.uboLayout,
    built.textureNames,
  );
  const assembled = globeMaterial.assembleMaterialWGSLSource(
    GLOBE_TERRAIN_WGSL,
    built.prelude,
    body,
  );
  const preprocessed = preprocess(assembled, ShaderDefine.MATERIAL_APPLY, 0);
  return {
    textureNames: built.textureNames,
    uboLayout: built.uboLayout,
    prelude: built.prelude,
    body,
    declarations: collectResourceDeclarations(preprocessed),
  };
}

/**
 * Every `@group(g) @binding(b) var name : type;` the module declares.
 *
 * @param {string} source WGSL.
 * @returns {Map<string, object>} name → `{ group, binding, type }`.
 */
function collectResourceDeclarations(source) {
  const declarations = new Map();
  const pattern =
    /@group\((\d+)\)\s*@binding\((\d+)\)\s*var\s*(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g;
  for (const match of source.matchAll(pattern)) {
    declarations.set(match[3], {
      group: Number(match[1]),
      binding: Number(match[2]),
      type: match[4].trim(),
    });
  }
  return declarations;
}

/**
 * The gate. Finds every WGSL texture-builtin call in an emitted material body
 * and reports the ones whose arguments the module does not declare with the
 * right kind, or whose sampler is not the one paired with the texture's
 * binding.
 *
 * @param {string} body The emitted material body.
 * @param {Map<string, object>} declarations Module-scope resource declarations.
 * @returns {Array<object>} One entry per fault; empty means the body resolves.
 */
export function findUnresolvedTextureArguments(body, declarations) {
  const faults = [];
  const sampleCalls = body.matchAll(
    /\btextureSample(?:Level|Bias|Grad|Compare)?\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*[,)]/g,
  );
  for (const call of sampleCalls) {
    const [, textureArgument, samplerArgument] = call;
    const texture = declarations.get(textureArgument);
    const sampler = declarations.get(samplerArgument);
    if (!texture || !texture.type.startsWith("texture_")) {
      faults.push({
        kind: "texture-argument-not-a-texture",
        identifier: textureArgument,
        declaredType: texture?.type ?? null,
      });
    }
    if (!sampler || sampler.type !== "sampler") {
      faults.push({
        kind: "sampler-argument-not-a-sampler",
        identifier: samplerArgument,
        declaredType: sampler?.type ?? null,
      });
    }
    if (texture && sampler && sampler.binding !== texture.binding + 1) {
      faults.push({
        kind: "sampler-not-paired-with-texture",
        identifier: samplerArgument,
        textureBinding: texture.binding,
        samplerBinding: sampler.binding,
      });
    }
  }
  const dimensionCalls = body.matchAll(
    /\btextureDimensions\s*\(\s*([^,()]+?)\s*[,)]/g,
  );
  for (const call of dimensionCalls) {
    const identifier = call[1];
    const texture = declarations.get(identifier);
    if (!texture || !texture.type.startsWith("texture_")) {
      faults.push({
        kind: "texture-argument-not-a-texture",
        identifier,
        declaredType: texture?.type ?? null,
      });
    }
  }
  return faults;
}

/**
 * The ElevationBand material as the demo hands it over: two live `Texture`
 * uniforms adopted through the real update path.
 *
 * @returns {object} `{ material, heights, colors }`.
 */
function elevationBandMaterial() {
  const heights = textureWithWebGPUHandle("heights", 8, 1);
  const colors = textureWithWebGPUHandle("colors", 8, 1);
  const material = materialWithLiveTextures("ElevationBand", {
    heights,
    colors,
  });
  return { material, heights, colors };
}

test("the real adoption path leaves a live Texture on the fabric uniform", () => {
  const { material, heights, colors } = elevationBandMaterial();
  // The premise the whole row rests on, re-derived rather than assumed: the
  // Texture branch of MaterialHelpers adopts into `_textures` and returns
  // without reassigning `uniforms`, so the WebGPU path sees a Texture.
  assert.equal(material.uniforms.heights, heights);
  assert.equal(material.uniforms.colors, colors);
  assert.equal(material._textures.heights, heights);
  assert.equal(material._textures.colors, colors);
});

test("both live-Texture uniforms are classified as textures, in fabric order", () => {
  const { material } = elevationBandMaterial();
  const built = globeMaterial.buildMaterialPrelude(material);
  assert.deepEqual(built.textureNames, ["heights", "colors"]);
  // A classified texture is never also a UBO field: a name in both would be
  // packed as a scalar and read as a texture in the same module.
  for (const name of built.textureNames) {
    assert.equal(
      built.uboLayout.has(name),
      false,
      `${name} was packed into the material UBO as well as bound as a texture`,
    );
  }
});

test("the emitted ElevationBand module hands only real texture and sampler declarations to WGSL texture builtins", () => {
  const { material } = elevationBandMaterial();
  const emitted = emitModule(material);
  const faults = findUnresolvedTextureArguments(
    emitted.body,
    emitted.declarations,
  );
  assert.deepEqual(
    faults,
    [],
    `emitted body does not resolve:\n${JSON.stringify(faults, null, 2)}\n${emitted.body}`,
  );
});

test("the single-texture fabric shape still resolves", () => {
  // ElevationRamp is the shape the water-mask-elevation-map and bathymetry
  // demos bind: one texture uniform, no second slot.
  const image = textureWithWebGPUHandle("image", 100, 15);
  const material = materialWithLiveTextures("ElevationRamp", { image });
  const emitted = emitModule(material);
  assert.deepEqual(emitted.textureNames, ["image"]);
  assert.deepEqual(
    findUnresolvedTextureArguments(emitted.body, emitted.declarations),
    [],
  );
});

test("slot selection does not depend on the fabric's uniform names", () => {
  const { material } = elevationBandMaterial();
  const built = globeMaterial.buildMaterialPrelude(material);
  // Same body shape, texture uniforms named nothing like the shader's slots.
  const body =
    "let a = textureSampleLevel(alpha, alphaSampler, uv, 0.0);\n" +
    "let b = textureSampleLevel(beta, betaSampler, uv, 0.0);\n" +
    "let d = textureDimensions(alpha);\n";
  const rewritten = globeMaterial.rewriteMaterialBody(body, built.uboLayout, [
    "alpha",
    "beta",
  ]);
  const declarations = collectResourceDeclarations(
    preprocess(
      globeMaterial.assembleMaterialWGSLSource(
        GLOBE_TERRAIN_WGSL,
        built.prelude,
        rewritten,
      ),
      ShaderDefine.MATERIAL_APPLY,
      0,
    ),
  );
  assert.deepEqual(
    findUnresolvedTextureArguments(rewritten, declarations),
    [],
    rewritten,
  );
  // And the mapping is positional: the first texture uniform reads the slot the
  // renderer binds textureNames[0] to, whatever it is called.
  const slotZero = globeMaterial.materialTextureSlotName(0);
  const slotOne = globeMaterial.materialTextureSlotName(1);
  assert.notEqual(slotZero, slotOne);
  assert.equal(declarations.get(slotZero).binding, 5);
  assert.equal(declarations.get(slotOne).binding, 7);
  assert.match(rewritten, new RegExp(`textureDimensions\\(${slotZero}\\)`));
});

test("the resolve path returns a real view for a Texture-shaped value", () => {
  const { material } = elevationBandMaterial();
  const built = globeMaterial.buildMaterialPrelude(material);
  // Classification and resolution have to agree: every name the classifier
  // routed to a texture slot must resolve to a view, or the renderer binds the
  // 1x1 placeholder and the material samples nothing.
  for (const name of built.textureNames) {
    const view = globeMaterial.resolveMaterialTextureView(
      material.uniforms[name],
    );
    assert.equal(view, `view:${name}`, `${name} did not resolve to its view`);
  }
});

test("the resolve path still returns null for a value it cannot bind", () => {
  // The negative control. A resolver that returned something for everything
  // would make the test above pass over any input.
  assert.equal(globeMaterial.resolveMaterialTextureView(null), null);
  assert.equal(globeMaterial.resolveMaterialTextureView(4.0), null);
  assert.equal(globeMaterial.resolveMaterialTextureView({}), null);
  assert.equal(
    globeMaterial.resolveMaterialTextureView({ _texture: { nothing: true } }),
    null,
  );
});

test("the analyser reports exactly the faults the pre-fix rewrite produced", () => {
  // Non-vacuity. The pre-fix policy left texture names bare and packed any
  // unclassified uniform into the UBO. Reproduced here over the real
  // ElevationBand body and the real declarations, the analyser must find the
  // three faults the diagnosis named, or its silence above means nothing.
  const { material } = elevationBandMaterial();
  const emitted = emitModule(material);
  const preFixBody = material.wgslShaderSource
    .replaceAll("textureSampleLevel(heights,", "textureSampleLevel(H,")
    .replaceAll("textureDimensions(heights)", "textureDimensions(H)")
    .replaceAll("textureSampleLevel(colors,", "textureSampleLevel(C,")
    .replaceAll("H,", "materialUniforms.heights,")
    .replaceAll("(H)", "(materialUniforms.heights)")
    .replaceAll("C,", "materialUniforms.colors,");
  const faults = findUnresolvedTextureArguments(
    preFixBody,
    emitted.declarations,
  );
  const kinds = faults.map((f) => `${f.kind}:${f.identifier}`).sort();
  assert.deepEqual(kinds, [
    "sampler-argument-not-a-sampler:colorsSampler",
    "sampler-argument-not-a-sampler:heightsSampler",
    "texture-argument-not-a-texture:materialUniforms.colors",
    "texture-argument-not-a-texture:materialUniforms.heights",
    "texture-argument-not-a-texture:materialUniforms.heights",
  ]);
});

test("the probe's gate passes only on a clean, visible, moving band", () => {
  const thresholds = { materialVisible: 0.02, bandMoves: 0.002 };
  const green = {
    renderer: "webgpu",
    run: 0,
    consoleErrors: [],
    band: { gpuErrors: [] },
    materialVisible: { differingFraction: 0.31 },
    bandMoves: { differingFraction: 0.02 },
    siblings: [
      { kind: "elevation-ramp", clause: "a", gpuErrors: [] },
      { kind: "elevation-color-contour", clause: "b", gpuErrors: [] },
    ],
  };
  assert.equal(
    decideElevationBandVerdicts(green, thresholds).every((v) => v.pass),
    true,
  );

  // The pre-fix engine's shape: an invalid module, no visible material, and a
  // band that cannot move because the placeholder view is what is bound.
  const preFix = {
    ...green,
    consoleErrors: [
      '[error] [Invalid ShaderModule "Globe material module ElevationBand"] is invalid',
    ],
    band: {
      gpuErrors: [{ kind: "GPUValidationError", message: "invalid pipeline" }],
    },
    materialVisible: { differingFraction: 0 },
    bandMoves: { differingFraction: 0 },
  };
  const preFixVerdicts = decideElevationBandVerdicts(preFix, thresholds);
  assert.deepEqual(
    preFixVerdicts.filter((v) => !v.pass).map((v) => v.id),
    [
      "webgpu/run0/clause1-no-validation-fault",
      "webgpu/run0/clause2-material-visible",
      "webgpu/run0/clause3-band-moves",
    ],
  );

  // A sibling shape that faults fails clause 4 on its own.
  const siblingFault = {
    ...green,
    siblings: [
      { kind: "elevation-ramp", clause: "a", gpuErrors: [] },
      {
        kind: "elevation-color-contour",
        clause: "b",
        gpuErrors: [{ kind: "GPUValidationError", message: "bad bind group" }],
      },
    ],
  };
  assert.deepEqual(
    decideElevationBandVerdicts(siblingFault, thresholds)
      .filter((v) => !v.pass)
      .map((v) => v.id),
    ["webgpu/run0/clause4-elevation-color-contour"],
  );
});

// ---------------------------------------------------------------------------
// The contribution half. Everything above proves the module RESOLVES; none of
// it can tell a material that paints from one that compiles, binds, draws and
// paints nothing. The 2026-09-05 Edge leg found exactly that: clause 1 green on
// both backends, clause 2 at 0.002023 against a 0.02 floor, and clause 3 at
// exactly 0 with the two WebGPU band captures byte-identical.
//
// The cause was upstream of the module. `createElevationBandMaterial` picks
// `PixelFormat.LUMINANCE` + `PixelDatatype.FLOAT` for its heights texture
// whenever `context.webgl2` is false, which `WebGPUContext` always is, and the
// compatibility stub's format converter answered that triple with `r8unorm` —
// channel count from the base format, precision from nowhere. The terrain
// heights were reinterpreted as unorm bytes in [0,1], `queue.writeTexture` read
// a quarter of the source buffer, and the material's own early-out
// (`height < minHeight || height > maxHeight` → `alpha = 0`) then discarded
// every fragment on the globe.
//
// So these tests assert the property that decides whether the band appears at
// all: the height values the sampler hands the shader must still span the
// configured band heights. An all-grey globe is what happens when they do not,
// and each of the two shapes that produce one — the mis-typed upload and a 1×1
// placeholder view — is asserted to be rejected.

/**
 * Decode the texels a WebGPU sampler would read back from one row of a texture
 * the compatibility stub uploaded. Mirrors the raw-byte branch of
 * `WebGLStubTexture`'s `texImage2D`: `bytesPerRow = width * bytesPerTexel(format)`,
 * the source `ArrayBufferView` reinterpreted as bytes, no conversion.
 *
 * @param {string} format A GPUTextureFormat this upload path can produce.
 * @param {Uint8Array} bytes The bytes that landed in row 0.
 * @param {number} width Texel count in the row.
 * @returns {number[]} The first channel of each texel, as the shader reads it.
 */
function decodeFirstChannel(format, bytes, width) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = bytesPerTexel(format);
  const texels = [];
  for (let i = 0; i < width; i++) {
    const at = i * stride;
    if (at + stride > bytes.byteLength) break;
    switch (format) {
      case "r32float":
      case "rg32float":
      case "rgba32float":
        texels.push(view.getFloat32(at, true));
        break;
      case "r8unorm":
      case "rg8unorm":
      case "rgba8unorm":
        texels.push(view.getUint8(at) / 255);
        break;
      default:
        throw new Error(`decodeFirstChannel: unhandled format ${format}`);
    }
  }
  return texels;
}

/**
 * Run one `Texture.create({ context, pixelFormat, pixelDatatype, source })`
 * through the real format decisions a WebGPU context makes for it, and report
 * what the sampler would then read.
 *
 * The only value supplied rather than produced is `context.webgl2 === false` —
 * `WebGPUContext` declares it as a field default, and constructing one needs a
 * GPUDevice this spec does not have. Everything downstream of it is the real
 * `PixelFormat.toInternalFormat`, the real `PixelDatatype.toWebGLConstant` and
 * the real `webglToWebGPUTextureFormat` / `bytesPerTexel`.
 *
 * @param {number} pixelFormat A PixelFormat.
 * @param {number} pixelDatatype A PixelDatatype.
 * @param {ArrayBufferView} source The `arrayBufferView` the caller uploads.
 * @param {number} width Texture width in texels (height is 1 on this path).
 * @returns {object} `{ format, bytesPerRow, sourceBytes, texels }`.
 */
function uploadThroughCompatibilityStub(
  pixelFormat,
  pixelDatatype,
  source,
  width,
) {
  const context = { webgl2: false };
  const internalFormat = PixelFormat.toInternalFormat(
    pixelFormat,
    pixelDatatype,
    context,
  );
  const glType = PixelDatatype.toWebGLConstant(pixelDatatype, context);
  const format = webglToWebGPUTextureFormat(
    internalFormat,
    pixelFormat,
    glType,
  );
  const bytesPerRow = width * bytesPerTexel(format);
  const bytes = new Uint8Array(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );
  return {
    format,
    bytesPerRow,
    sourceBytes: bytes.byteLength,
    texels: decodeFirstChannel(
      format,
      bytes.subarray(0, Math.min(bytesPerRow, bytes.byteLength)),
      width,
    ),
  };
}

/**
 * The ElevationBand material's own early-out, transcribed: outside
 * `[texels[0], texels[last]]` it sets `alpha = 0` and returns, so the fragment
 * keeps the bare surface. A `true` here is the necessary condition for the
 * material to contribute anything at that height.
 *
 * @param {number[]} texels Heights as the sampler reads them, ascending.
 * @param {number} height A terrain height in metres.
 * @returns {boolean} Whether the material can paint at that height.
 */
function bandCoversHeight(texels, height) {
  if (texels.length === 0) return false;
  return height >= texels[0] && height <= texels[texels.length - 1];
}

// The layer heights the `elevation-band-material` demo configures, and the
// buffer `createElevationBandMaterial` builds from them on a float-capable
// context: one f32 per entry, ascending.
const DEMO_BAND_HEIGHTS = [4200, 5200, 5800, 6400, 7000, 7600, 8200, 8848];

test("the heights the shader samples still span the configured band heights", () => {
  const source = new Float32Array(DEMO_BAND_HEIGHTS);
  const upload = uploadThroughCompatibilityStub(
    // The pair `createElevationBandMaterial` picks when
    // `_useFloatTexture(context)` is true and `context.webgl2` is false.
    PixelFormat.LUMINANCE,
    PixelDatatype.FLOAT,
    source,
    source.length,
  );

  // `queue.writeTexture` is handed the whole source buffer with this
  // bytesPerRow. If they disagree the upload truncates or over-reads.
  assert.equal(
    upload.bytesPerRow,
    upload.sourceBytes,
    `row stride ${upload.bytesPerRow} does not match the ${upload.sourceBytes}-byte source (format ${upload.format})`,
  );

  // The heights survive the round trip.
  assert.deepEqual(upload.texels, DEMO_BAND_HEIGHTS);

  // And therefore the material contributes at every configured band height,
  // instead of taking its early-out on every fragment and leaving the globe
  // bare — the failure the Edge leg measured as clause 2 = 0.002023 and
  // clause 3 = 0.
  for (const height of DEMO_BAND_HEIGHTS) {
    assert.equal(
      bandCoversHeight(upload.texels, height),
      true,
      `a fragment at ${height} m falls outside [${upload.texels[0]}, ${upload.texels[upload.texels.length - 1]}], so czm_getMaterial returns alpha 0`,
    );
  }
});

test("the all-grey shapes are the ones this gate rejects", () => {
  // Non-vacuity for the test above. `bandCoversHeight` has to say NO to both
  // shapes that produced a bare globe, or its YES means nothing.
  const source = new Float32Array(DEMO_BAND_HEIGHTS);

  // 1. The pre-fix upload: the same source bytes read as unorm.
  const misTyped = decodeFirstChannel(
    "r8unorm",
    new Uint8Array(source.buffer, source.byteOffset, DEMO_BAND_HEIGHTS.length),
    DEMO_BAND_HEIGHTS.length,
  );
  assert.equal(Math.max(...misTyped) <= 1, true);
  for (const height of DEMO_BAND_HEIGHTS) {
    assert.equal(bandCoversHeight(misTyped, height), false);
  }

  // 2. The renderer's 1x1 placeholder view, bound when a texture uniform fails
  //    to resolve: one texel, so minHeight and maxHeight are the same value and
  //    no real terrain height lies on it.
  for (const height of DEMO_BAND_HEIGHTS) {
    assert.equal(bandCoversHeight([1.0], height), false);
    assert.equal(bandCoversHeight([0.0], height), false);
  }

  // 3. Staleness guard on the transcription: the early-out `bandCoversHeight`
  //    models is still the one the fabric's own WGSL performs.
  const { material } = elevationBandMaterial();
  assert.match(
    material.wgslShaderSource,
    /if \(height < minHeight \|\| height > maxHeight\)/,
  );
  assert.match(material.wgslShaderSource, /material\.alpha = 0\.0;/);
});

test("the format decision reads the source's precision, not just its channel count", () => {
  // One row per shape this upload path produces in-tree. The UNSIGNED_BYTE rows
  // are the byte-identity guarantee for the existing LUMINANCE callers —
  // GlobeSurfaceTile's water mask and PrimitiveOutlineGenerator — which must
  // keep their r8unorm.
  const cases = [
    // createElevationBandMaterial heights, on a WebGPU context.
    [PixelFormat.LUMINANCE, PixelDatatype.FLOAT, "r32float"],
    [PixelFormat.LUMINANCE, PixelDatatype.HALF_FLOAT, "r16float"],
    // createElevationBandMaterial colors, and the canvas-backed ramps.
    [PixelFormat.RGBA, PixelDatatype.UNSIGNED_BYTE, "rgba8unorm"],
    // Unchanged callers.
    [PixelFormat.LUMINANCE, PixelDatatype.UNSIGNED_BYTE, "r8unorm"],
    [PixelFormat.ALPHA, PixelDatatype.UNSIGNED_BYTE, "r8unorm"],
    [PixelFormat.LUMINANCE_ALPHA, PixelDatatype.UNSIGNED_BYTE, "rg8unorm"],
  ];
  const context = { webgl2: false };
  for (const [pixelFormat, pixelDatatype, expected] of cases) {
    const format = webglToWebGPUTextureFormat(
      PixelFormat.toInternalFormat(pixelFormat, pixelDatatype, context),
      pixelFormat,
      PixelDatatype.toWebGLConstant(pixelDatatype, context),
    );
    assert.equal(
      format,
      expected,
      `pixelFormat 0x${pixelFormat.toString(16)} + datatype 0x${pixelDatatype.toString(16)} resolved to ${format}, expected ${expected}`,
    );
  }
});
