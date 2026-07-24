/**
 * Manages GPU render pipeline variants for glTF Model rendering.
 * Pipelines vary by: alpha mode (OPAQUE/MASK/BLEND), cull mode (back/none),
 * and presentation format.
 *
 * All variants share the same vertex layout (7 attribute slots) and the
 * 4 bind group layouts produced by `createBindGroupLayouts`:
 *   Group 0 — camera UBO (per-frame).
 *   Group 1 — merged material UBO + light UBO + 24 PBR/KHR textures +
 *             7 featureId entries (per-material).
 *   Group 2 — merged joint matrices + morph deltas + morph weights +
 *             instance transforms (per-instance vertex).
 *   Group 3 — effects BGL shared with globe + primitive (shadow +
 *             clipping + atmosphere + CSM + edges + globe depth).
 *
 * Consolidated from 8 logical groups in NEW-BG-CONSOLIDATION (Batch 122)
 * to fit within the WebGPU spec-mandated `maxBindGroups: 4` limit
 * (universal in Chromium, April 2026 — verified via
 * `Tools/visual-regression/probe-adapter-limits.mjs`).
 *
 * Skinning support: joints0 (vec4<u32>) and weights0 (vec4<f32>) are always
 * present in the vertex layout. Non-skinned primitives bind default zero
 * buffers via the merged group 2. Joint matrices ride storage at group
 * 2 binding 0; morph deltas at binding 1; morph weights at binding 2;
 * instance transforms at binding 3.
 *
 * @private
 * @module WebGPUModelPipelineCache
 */

import defined from "../../Core/defined.js";
import ModelPBRCompleteWGSL from "../../Shaders/WebGPU/Model/ModelPBRComplete.js";
// WIRE-MODEL-SILHOUETTE — the inflate/colour helper chunk, prepended to
// the module source only when the MODEL_SILHOUETTE bit is active.
import ModelSilhouetteStageWGSL from "../../Shaders/WebGPU/Model/ModelSilhouetteStage.js";
// C2-22 — flat-magenta fallback shader for failed model PBR pipelines.
import ErrorPipelineWGSL from "../../Shaders/WebGPU/Model/ErrorPipeline.js";
// Slice 5d Batch 153 — Forward+ clustered lighting FS chunk. Prepended
// to the Model PBR shader source unconditionally so the @group(3)
// binding declarations (slots 18..22) + evalClusteredLights() function
// are available. The bindings live on the existing effects BGL
// (extended in Batch 153); runtime enabling is gated by
// `clusterParams.activeLightCount.x` (zero when no lights or
// scene.clusteredLightingEnabled === false → FS chunk early-out).
import ClusteredLightingChunk from "../../Shaders/WebGPU/chunks/structs/ClusteredLighting.js";
// C11-157 Slice C — preprocess the composed color source (LOG_DEPTH cleared)
// for the model OIT accumulation variant. The module cache preprocesses
// internally; the OIT path needs the concrete WGSL for injectOITOutput.
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";
import type { WebGPUPipelineConfig } from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  sampler,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { getEffectsBindGroupLayout } from "./WebGPUEffectsBindGroup.js";
// Slice 5d Batch 154 — group-token substitution for the ClusteredLighting
// chunk. Model PBR's effects BGL is always at group 3, so we substitute 3.
import { substituteClusteredLightingGroup } from "./WebGPUClusteredLightingBGL.js";
// Slice 5c-B Phase 1 (Batch 114) — scene-FB target helper. Used for
// the color + classification pipelines; pick / hover / precise-pick /
// velocity pipelines stay single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
// C10-07-ASYNC-MODEL-PIPELINES (Batch 704) — central render-pipeline cache.
// The on-screen model COLOR pipeline now resolves through this cache's
// `createRenderPipelineAsync` path (with a ready-gate) instead of a
// synchronous `device.createRenderPipeline` mid-draw, mirroring the globe's
// `resolveGlobePipelineEntry`. Pick / velocity / classification / capture /
// silhouette / depth-write stay synchronous (documented must-render escape
// hatch — a cooking frame must not return a wrong pick / miss a must-run pass).
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
// DP-H46c/d — property-texture + property-table binding numbers, shared with
// the codegen + renderer so the BGL, shader, and bind-group entries all agree.
import {
  PROPERTY_TEXTURE_BINDING_BASE,
  PROPERTY_TEXTURE_SAMPLER_BINDING,
  MAX_PROPERTY_TEXTURES,
  PROPERTY_TABLE_BINDING,
  PROPERTY_TABLE_SAMPLER_BINDING,
} from "./WebGPUModelMetadata.js";
// PARITY-CUSTOM-SHADER-WGSL — customShader UBO + custom-texture binding numbers,
// shared with the codegen (`CustomShaderWGSLPipelineStage`) + renderer so the
// BGL, shader, and bind-group entries all agree.
import {
  CUSTOM_SHADER_UBO_BINDING,
  CUSTOM_SHADER_TEXTURE_BINDING_BASE,
  CUSTOM_SHADER_SAMPLER_BINDING,
  MAX_CUSTOM_TEXTURES,
} from "../../Scene/Model/CustomShaderWGSLPipelineStage.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 162) — per-device shader-module cache so
// every `WebGPUModelPipelineCache` (one per `Model`) on the same `GPUDevice`
// shares a single compiled `GPUShaderModule` for `ModelPBRComplete.wgsl`.
// Pipelines themselves stay per-cache (their formats + alphaMode + doubleSided
// keys differ); only the WGSL compilation is shared.
/**
 * A single KHR-extension binding entry in {@link KHR_BINDING_MANIFEST}.
 * @private
 */
interface KhrBinding {
  binding: number;
  type: "texture" | "sampler";
  gateDefine: number;
  viewDimension?: GPUTextureViewDimension;
}

/**
 * Minimal shape of the `context` object read by
 * {@link WebGPUModelPipelineCache#maybeUpdateForSceneFormat}.
 * @private
 */
interface SceneFormatContext {
  _scenePipelineFormatGeneration?: number;
  scenePipelineFormat?: GPUTextureFormat;
  /** NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — the context's byte-object-ID
   *  pick attachment authority (`WebGPUContext.pickPipelineFormat`). */
  pickPipelineFormat?: GPUTextureFormat;
  _msaaSamples?: number;
}

/**
 * NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — local mirror of the context's
 * pick-format clamp for construction time (before the first
 * `maybeUpdateForSceneFormat` can read `context.pickPipelineFormat`).
 * Must match `WebGPUContext.pickPipelineFormat`: 8-bit unorm scene formats
 * pass through; anything else (float/HDR) clamps to `rgba8unorm`.
 * @private
 */
function clampToPickFormat(format: GPUTextureFormat): GPUTextureFormat {
  return format === "bgra8unorm" || format === "rgba8unorm"
    ? format
    : "rgba8unorm";
}

/**
 * Sampler metadata carried by a glTF texture — either a CesiumJS `Sampler`
 * instance (min/magnificationFilter) or a raw glTF sampler object
 * (min/magFilter). All fields are GL enum integers.
 * @private
 */
interface GltfSamplerLike {
  magnificationFilter?: number;
  magFilter?: number;
  minificationFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}

/**
 * glTF `textureInfo`-like reader passed to
 * {@link WebGPUModelPipelineCache#getSamplerForReader}.
 * @private
 */
interface TextureReaderLike {
  texture?: { _sampler?: GltfSamplerLike; sampler?: GltfSamplerLike };
  sampler?: GltfSamplerLike;
}

const _modelShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getModelShaderModuleCache(device: GPUDevice): WebGPUShaderModuleCache {
  let cache = _modelShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _modelShaderModuleCaches.set(device, cache);
  }
  return cache;
}

// Alpha mode constants matching glTF spec
const ALPHA_OPAQUE = 0;
const ALPHA_MASK = 1;
const ALPHA_BLEND = 2;

/**
 * Batch 174 — B.4 KHR materialBGL split. Declarative manifest of the
 * KHR-extension bindings on group 1 (slots 12-25). Each entry pairs a
 * group-1 binding number with the `ShaderDefine` bit that gates whether
 * the binding lands in the BGL / shader source / texture-entries array.
 *
 * Today every KHR binding shares a single coarse gate
 * (`ShaderDefine.MODEL_HAS_KHR_TEXTURES`), giving two variants:
 *   - basic (materialDefines = 0): bindings 12-25 stripped, 10 sampled
 *     textures total, fits the WebGPU spec floor
 *     `maxSampledTexturesPerShaderStage = 16`.
 *   - full (materialDefines includes MODEL_HAS_KHR_TEXTURES): all 23
 *     sampled textures, requires opting up
 *     `maxSampledTexturesPerShaderStage` past the spec floor.
 *
 * The manifest is the contract: future KHR extensions add new bindings
 * AND a new gate define (`MODEL_HAS_KHR_TRANSMISSION_VOLUMETRIC`, etc.)
 * — the BGL builder, the texture-entries builder, the pipeline cache
 * key, and the WGSL ifdef preprocessor all consume the same gate bit.
 * That's the scalable axis: the device may opt up its sampled-texture
 * limit (Chromium currently allows 64; future devices may go higher);
 * the renderer builds whichever subset of KHR extensions a primitive
 * actually uses, capped against `device.limits.maxSampledTexturesPerShaderStage`.
 *
 * Once the WGSL ifdefs are split per-extension (follow-up to Batch 174),
 * the renderer can compute `materialDefines` as the OR of only the
 * extension bits the primitive's material flags activate, and the BGL
 * builder will produce a minimal layout that fits a 16-texture device
 * even if the asset uses ONE KHR extension. The current "basic / full"
 * binary is a stepping-stone to that fully granular state.
 *
 * Entry shape:
 *   { binding, type: "texture" | "sampler", viewDimension?, gateDefine }
 *
 * @private
 */
const KHR_BINDING_MANIFEST: readonly KhrBinding[] = Object.freeze([
  { binding: 12, type: "texture", gateDefine: 1 << 9 },
  { binding: 13, type: "texture", gateDefine: 1 << 9 },
  { binding: 14, type: "texture", gateDefine: 1 << 9 },
  { binding: 15, type: "texture", gateDefine: 1 << 9 },
  { binding: 16, type: "texture", gateDefine: 1 << 9 },
  { binding: 17, type: "texture", gateDefine: 1 << 9 },
  { binding: 18, type: "texture", gateDefine: 1 << 9 },
  { binding: 19, type: "texture", gateDefine: 1 << 9 },
  { binding: 20, type: "texture", gateDefine: 1 << 9 },
  { binding: 21, type: "texture", gateDefine: 1 << 9 },
  { binding: 22, type: "texture", gateDefine: 1 << 9 },
  { binding: 23, type: "sampler", gateDefine: 1 << 9 },
  { binding: 24, type: "texture", gateDefine: 1 << 9 },
  { binding: 25, type: "texture", gateDefine: 1 << 9 },
]);

/**
 * Bitmask of all ShaderDefine bits referenced by the KHR manifest. The
 * pipeline cache uses this to mask `materialDefines` down to just the
 * model-material-relevant bits — other ShaderDefine bits (e.g.
 * `SPLIT_ENABLED`, `GEODETIC_NORMAL`) live on different shader sources
 * and don't influence model BGL/pipeline construction.
 *
 * Computed at module load by OR-ing every `gateDefine` in the manifest;
 * future KHR additions automatically extend the mask without touching
 * any consumer.
 *
 * @private
 */
const MATERIAL_DEFINE_MASK = (() => {
  let m = 0;
  for (let i = 0; i < KHR_BINDING_MANIFEST.length; i++) {
    m |= KHR_BINDING_MANIFEST[i].gateDefine;
  }
  // Session 62 NEW-VR-VERTEX-BUFFER-VARIANT — MODEL_HAS_TEXCOORD_1 also
  // discriminates pipelines (different vertex buffer layout: 9 vs 8
  // slots). Not a KHR-binding flag, but participates in the cache key
  // the same way.
  m |= ShaderDefine.MODEL_HAS_TEXCOORD_1;
  // Session 65 — same treatment for MODEL_HAS_FEATURE_ID_0. Distinct
  // vertex buffer layout (slot 8 present vs absent) needs its own
  // pipeline variant.
  m |= ShaderDefine.MODEL_HAS_FEATURE_ID_0;
  // DP-H46a — MODEL_HAS_METADATA adds vertex slot 9 (property-ATTRIBUTE
  // scalar) AND forks the shader module (struct Metadata + initializer +
  // the metadataValue varying behind the ifdef). Distinct vertex layout
  // + distinct module → its own pipeline + shader-module variant, the
  // same way MODEL_HAS_FEATURE_ID_0 does. Folded into the mask only here;
  // for non-metadata models the bit is never set so the key is unchanged.
  m |= ShaderDefine.MODEL_HAS_METADATA;
  // DP-H46c — MODEL_HAS_PROPERTY_TEXTURES adds the property-texture
  // (texture, sampler) binding block (39..) to the material BGL +
  // pipeline layout AND the generated chunk's binding/sampling code. It's
  // a NEW materialBGL variant (more sampled textures) + a distinct module,
  // so it participates in the key the same way MODEL_HAS_KHR_TEXTURES does.
  // For non-property-texture models the bit is never set → key unchanged.
  m |= ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES;
  // DP-H46d — MODEL_HAS_PROPERTY_TABLES adds the property-table (texture,
  // sampler) binding block (44..45) to the material BGL + pipeline layout AND
  // the generated chunk's textureLoad code. A NEW materialBGL variant + a
  // distinct module, so it participates in the key like
  // MODEL_HAS_PROPERTY_TEXTURES. For non-property-table models the bit is never
  // set → key unchanged.
  m |= ShaderDefine.MODEL_HAS_PROPERTY_TABLES;
  // PARITY-CUSTOM-SHADER-WGSL — MODEL_HAS_WGSL_CUSTOM_SHADER (+ the optional
  // vertex sibling) adds the customShader UBO (binding 50) + custom texture
  // (texture, sampler) pairs (51+) to the material BGL + pipeline layout AND the
  // generated chunk's uniform/texture declarations + inlined user body. A NEW
  // materialBGL variant + a distinct module, so it participates in the key like
  // MODEL_HAS_PROPERTY_TEXTURES. For non-customShader (and GLSL-only) models the
  // bits are never set → key unchanged.
  m |= ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER;
  m |= ShaderDefine.MODEL_HAS_WGSL_CUSTOM_VERTEX;
  return m;
})();

// C11-149 BOOT ASSERTION — `computeKey` packs the masked material defines
// as `md << 3` inside a Uint32-normalized key. A masked bit at index 29+
// would shift to bit 32+ and be TRUNCATED by JavaScript's 32-bit shift,
// silently ALIASING that variant's pipelines with the variant that lacks
// the bit (wrong pipeline served, no error — exactly how the
// MODEL_METADATA_MAT_TRANSPORT bit-30 case was dodged by keeping it out of
// materialDefines). Fail at module load, before any pipeline can be keyed.
// If this fires: route the new axis through sticky per-primitive state /
// a key suffix (the `:m34` pattern) or the hi-word registry instead of
// MATERIAL_DEFINE_MASK. PERMANENT (no debug pragma) — silent pipeline
// aliasing is broken output.
if ((MATERIAL_DEFINE_MASK & ~0x1fffffff) !== 0) {
  throw new Error(
    `WebGPUModelPipelineCache: MATERIAL_DEFINE_MASK 0x${(MATERIAL_DEFINE_MASK >>> 0).toString(16)} ` +
      `includes a define bit >= 29, which overflows computeKey's 'md << 3' ` +
      `packing and silently aliases pipeline variants. Key the new axis ` +
      `outside MATERIAL_DEFINE_MASK (sticky state / key suffix / hi word).`,
  );
}

/**
 * Computes a cache key from pipeline configuration.
 *
 * Bit layout:
 *   bits 0-1   : alphaMode (0=OPAQUE, 1=MASK, 2=BLEND)
 *   bit  2     : doubleSided
 *   bits 3+    : materialDefines bitmask (shifted left 3). Currently
 *                only `ShaderDefine.MODEL_HAS_KHR_TEXTURES` (1<<9) is
 *                consumed, but the cache scales to any future
 *                model-material define bit added to the manifest UP TO
 *                bit 28 — bit 29+ would shift past the Uint32 and alias
 *                (guarded by the C11-149 boot assertion above).
 *
 * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
 * @param {boolean} doubleSided - true = no backface culling
 * @param {number} materialDefines - bitmask of model-material ShaderDefine bits
 * @returns {number}
 * @private
 */
function computeKey(
  alphaMode: number,
  doubleSided: boolean,
  materialDefines: number,
): number {
  const md = (materialDefines >>> 0) & MATERIAL_DEFINE_MASK;
  return (alphaMode | (doubleSided ? 4 : 0) | (md << 3)) >>> 0;
}

/**
 * GLTF-POINTS-MODE — folds the primitive topology into a pipeline cache
 * key. Triangle-list (the historical default and the overwhelmingly
 * common case) returns the key UNCHANGED — numeric for the numeric-keyed
 * caches, string for the string-keyed ones — so pre-existing triangle
 * pipelines keep byte-identical cache keys. Non-triangle topologies
 * (today: "point-list" for glTF mode-0 POINTS primitives) get a distinct
 * string key so a model mixing POINTS and TRIANGLES primitives with the
 * same material identity builds both variants.
 *
 * @param {number|string} key base cache key
 * @param {string} topology GPUPrimitiveTopology
 * @returns {number|string}
 * @private
 */
function topologyVariantKey(
  key: number | string,
  topology: string,
): number | string {
  return topology === "triangle-list" ? key : `${key}:${topology}`;
}

/**
 * Builds the group-1 (material + textures + feature) BGL for a given
 * variant mask. Iterates the KHR_BINDING_MANIFEST and includes only
 * entries whose `gateDefine` is set in `materialDefines`. The fixed
 * non-KHR portion (UBOs at 0-1, PBR textures+samplers at 2-11,
 * featureId block at 26-32, IBL block at 33-36) is always included.
 *
 * Validates the assembled layout against the device's
 * `maxSampledTexturesPerShaderStage` limit and throws with a clear
 * diagnostic when a variant exceeds it. This is what makes the
 * BGL split scale "from spec floor (16) to the device's opted-up
 * ceiling": adding more KHR bindings (or letting more variants build)
 * is safe — the assertion fires loudly the moment a build would exceed
 * the device limit, instead of silently producing a validation error
 * at pipeline-creation time.
 *
 * @param {GPUDevice} device
 * @param {number} materialDefines - bitmask of ShaderDefine bits
 *   gating which KHR bindings to include. `0` produces the basic
 *   layout (10 sampled textures, fits the spec floor of 16).
 * @returns {GPUBindGroupLayout}
 * @private
 */
function buildMaterialBGL(
  device: GPUDevice,
  materialDefines: number,
): GPUBindGroupLayout {
  const entries = [
    // 0-1: Material + Light UBOs (always)
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    uniformBuffer(1, Stage.FRAGMENT),
    // 2-11: Five PBR texture + sampler pairs (always)
    texture(2, Stage.FRAGMENT),
    sampler(3, Stage.FRAGMENT),
    texture(4, Stage.FRAGMENT),
    sampler(5, Stage.FRAGMENT),
    texture(6, Stage.FRAGMENT),
    sampler(7, Stage.FRAGMENT),
    texture(8, Stage.FRAGMENT),
    sampler(9, Stage.FRAGMENT),
    texture(10, Stage.FRAGMENT),
    sampler(11, Stage.FRAGMENT),
  ];

  // 12-25: KHR bindings — manifest-driven. Entries whose `gateDefine`
  // is set in `materialDefines` are included; the rest are stripped
  // and the matching shader source ifdefs strip the WGSL declarations
  // + sampling sites at preprocess time so the binding numbers stay
  // consistent across the layout, the shader, and the bind-group
  // entries[] array.
  for (let i = 0; i < KHR_BINDING_MANIFEST.length; i++) {
    const m = KHR_BINDING_MANIFEST[i];
    if ((materialDefines & m.gateDefine) === 0) {
      continue;
    }
    if (m.type === "texture") {
      entries.push(
        texture(
          m.binding,
          Stage.FRAGMENT,
          m.viewDimension ? { viewDimension: m.viewDimension } : undefined,
        ),
      );
    } else if (m.type === "sampler") {
      entries.push(sampler(m.binding, Stage.FRAGMENT));
    }
  }

  // 26-32: feature ID + batch + per-feature pick (always)
  entries.push(
    texture(26, Stage.FRAGMENT), // featureId
    sampler(27, Stage.FRAGMENT),
    texture(28, Stage.FRAGMENT), // batch
    sampler(29, Stage.FRAGMENT),
    uniformBuffer(30, Stage.FRAGMENT), // featureId UBO
    texture(31, Stage.FRAGMENT), // featurePick
    sampler(32, Stage.FRAGMENT),
  );

  // 33-36: IBL cubemaps + SH UBO (always). The
  // WebGPUImageBasedLighting pipeline produces irradiance + radiance
  // cubemaps from the source environment map; SH at binding 36
  // optionally short-circuits the irradiance sample in favor of cheap
  // analytic evaluation.
  entries.push(
    texture(33, Stage.FRAGMENT, { viewDimension: "cube" }),
    texture(34, Stage.FRAGMENT, { viewDimension: "cube" }),
    sampler(35, Stage.FRAGMENT),
    uniformBuffer(36, Stage.FRAGMENT),
  );

  // 37-38: NEW-MODEL-IBL-BRDF-LUT (Batch 287) — split-sum environment
  // BRDF integration LUT (`WebGPUBrdfLutGenerator`, rg32float 256×256).
  // R = scale, G = bias for F0, indexed by (NdotV, roughness). The FS
  // applies `radiance * (F0 * scale + bias)` to match WebGL's
  // `computeSpecularIBL` (ImageBasedLightingStageFS.glsl) instead of the
  // prior `radiance * fresnelSchlickRoughness(...)` hack. rg32float is
  // non-filterable without the optional `float32-filterable` feature, so
  // the LUT binds as `unfilterable-float` + a non-filtering sampler;
  // nearest sampling of a smooth 256×256 table is visually indistinct.
  entries.push(
    texture(37, Stage.FRAGMENT, { sampleType: "unfilterable-float" }),
    sampler(38, Stage.FRAGMENT, "non-filtering"),
  );

  // 39..: DP-H46c — property-texture block. Gated on
  // MODEL_HAS_PROPERTY_TEXTURES. When set, append `MAX_PROPERTY_TEXTURES`
  // texture bindings (39 + k) + ONE shared sampler binding
  // (PROPERTY_TEXTURE_SAMPLER_BINDING). The generated metadata chunk declares
  // only the texture bindings it actually samples (≤ the cap); the extra BGL
  // entries are bound to a 1×1 placeholder by the renderer (a pipeline is
  // allowed to use a subset of its layout's bindings, but the bind group must
  // satisfy every BGL entry). Fragment-stage only — property textures are
  // sampled at the interpolated fragment texCoord. ONE sampler (not one per
  // texture) keeps the per-stage sampler count under the spec floor of 16.
  if ((materialDefines & ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES) !== 0) {
    for (let k = 0; k < MAX_PROPERTY_TEXTURES; k++) {
      entries.push(texture(PROPERTY_TEXTURE_BINDING_BASE + k, Stage.FRAGMENT));
    }
    entries.push(sampler(PROPERTY_TEXTURE_SAMPLER_BINDING, Stage.FRAGMENT));
  }

  // 44-45: DP-H46d — property-table block. Gated on MODEL_HAS_PROPERTY_TABLES.
  // ONE sampled `texture_2d<f32>` (the tightly-packed RGBA8 table, rows =
  // properties, columns = features) + ONE sampler (a placeholder — the shader
  // reads via `textureLoad`, which ignores filtering, but the BGL binds a
  // sampler to keep the declaration shape uniform with the property-texture
  // block). Fragment-stage only — the metadata debug / styling consumer reads
  // the table in the FS at the per-fragment feature ID. Independent of the
  // property-texture block (a model can have tables without textures).
  if ((materialDefines & ShaderDefine.MODEL_HAS_PROPERTY_TABLES) !== 0) {
    entries.push(texture(PROPERTY_TABLE_BINDING, Stage.FRAGMENT));
    entries.push(sampler(PROPERTY_TABLE_SAMPLER_BINDING, Stage.FRAGMENT));
  }

  // 50+: PARITY-CUSTOM-SHADER-WGSL — customShader block. Gated on
  // MODEL_HAS_WGSL_CUSTOM_SHADER (fragment) — the vertex sibling shares the same
  // BGL (only the module differs). ONE uniform buffer (visible to VERTEX+FRAGMENT
  // so a vertex customShader can read the same uniforms) at binding 50, then
  // `MAX_CUSTOM_TEXTURES` (texture, sampler) pairs at 51+ (fragment-stage). The
  // generated chunk declares only the textures it actually uses (≤ the cap); the
  // extra BGL entries are bound to a 1×1 placeholder by the renderer so the bind
  // group satisfies every BGL entry (a pipeline may use a subset of its layout).
  if ((materialDefines & ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER) !== 0) {
    entries.push(
      uniformBuffer(CUSTOM_SHADER_UBO_BINDING, Stage.VERTEX_FRAGMENT),
    );
    for (let k = 0; k < MAX_CUSTOM_TEXTURES; k++) {
      entries.push(
        texture(CUSTOM_SHADER_TEXTURE_BINDING_BASE + k, Stage.FRAGMENT),
      );
    }
    // ONE shared sampler for every custom texture (keeps the per-stage sampler
    // count under the spec floor of 16).
    entries.push(sampler(CUSTOM_SHADER_SAMPLER_BINDING, Stage.FRAGMENT));
  }

  // ── Capability check ──
  // Count sampled textures in the assembled layout and compare against
  // the device's reported limit. Fires LOUDLY (a permanent error log
  // + thrown Error) if a build would exceed — that's how a future
  // KHR extension addition that pushes the variant past the device
  // ceiling becomes visible immediately instead of as an opaque
  // pipeline validation error.
  let sampledTextureCount = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].texture) {
      sampledTextureCount++;
    }
  }
  const limit = device.limits?.maxSampledTexturesPerShaderStage ?? 16;
  if (sampledTextureCount > limit) {
    const variantHex = `0x${(materialDefines >>> 0).toString(16)}`;
    const msg =
      `[WebGPU:Model:BGL] materialBGL variant ${variantHex} requires ` +
      `${sampledTextureCount} sampled textures but the device only supports ` +
      `${limit}. Either drop a KHR extension from the primitive, opt the ` +
      `device up to a higher maxSampledTexturesPerShaderStage limit, or ` +
      `split the variant into a smaller subset.`;
    console.error(msg);
    throw new Error(msg);
  }

  // DP-H46c — also bound the SAMPLER count. The property-texture block uses one
  // shared sampler, but the cross-stage `maxSamplersPerShaderStage` limit (16)
  // counts samplers across ALL bind groups (group 1 here + the effects group
  // 3). This local check fires if THIS BGL's samplers alone exceed the floor;
  // the device's pipeline-creation validation is the cross-group backstop.
  let samplerCount = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].sampler) {
      samplerCount++;
    }
  }
  const samplerLimit = device.limits?.maxSamplersPerShaderStage ?? 16;
  if (samplerCount > samplerLimit) {
    const variantHex = `0x${(materialDefines >>> 0).toString(16)}`;
    const msg =
      `[WebGPU:Model:BGL] materialBGL variant ${variantHex} requires ` +
      `${samplerCount} samplers but the device only supports ${samplerLimit}.`;
    console.error(msg);
    throw new Error(msg);
  }

  const variantHex = `0x${(materialDefines >>> 0).toString(16)}`;
  const label = `Model Material+Textures+Feature BGL [defines=${variantHex} sampled=${sampledTextureCount} samplers=${samplerCount}]`;
  return makeBindGroupLayout(device, label, entries);
}

/**
 * Builds the four bind group layouts shared by all Model pipelines.
 *
 * **NEW-BG-CONSOLIDATION (2026-04-30, Batch 122):** Consolidated from 8
 * logical groups to 4 physical groups so the Model PBR pipeline fits
 * within the WebGPU spec-mandated `maxBindGroups: 4` limit (universal
 * across Chromium configs in April 2026 — verified via
 * `Tools/visual-regression/probe-adapter-limits.mjs`).
 *
 * **Batch 174 (B.4 KHR materialBGL split):** the materialBGL is now
 * built per-variant on demand — `materialBGL` here is just the
 * "default" full-KHR variant cached for callers that don't care about
 * the variant axis. Per-primitive variants live in
 * `_materialBGLCache` keyed by `materialDefines: number`.
 *
 * Layout:
 *   Group 0 — CAMERA (1 binding, V+F)
 *   Group 1 — MATERIAL+TEXTURES+FEATURE (per-variant, 23-37 bindings)
 *     0-1   : material UBO + light UBO
 *     2-11  : 5 PBR texture+sampler pairs
 *     12-25 : KHR textures + sampler (gated per-variant via manifest)
 *     26-32 : featureId / batch / featurePick
 *     33-36 : IBL cubemaps + SH UBO
 *   Group 2 — INSTANCE (7 bindings, all VERTEX)
 *     0 : joint matrices storage
 *     1 : morph deltas storage
 *     2 : morph weights UBO
 *     3 : instance transforms
 *     4 : PREV joint matrices (TAA velocity)
 *     5 : PREV morph weights (TAA velocity)
 *     6 : PREV instance transforms (TAA velocity)
 *   Group 3 — EFFECTS (shared with globe + primitive)
 *     Layout owned by `WebGPUEffectsBindGroup.getEffectsBindGroupLayout`.
 *
 * @param {GPUDevice} device
 * @returns {{ cameraBGL, instanceBGL }}
 */
function createBindGroupLayouts(device: GPUDevice): {
  cameraBGL: GPUBindGroupLayout;
  instanceBGL: GPUBindGroupLayout;
} {
  // ── Group 0: CAMERA ── per-frame, shared across all models.
  const cameraBGL = makeBindGroupLayout(device, "Model Camera BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);

  // ── Group 2: INSTANCE ── per-instance vertex stage data.
  // Audit A.5 (Batch 130) — binding 4 carries the PREVIOUS frame's
  // joint matrices so the velocity pass can compute prevPositionMC
  // by re-running skinning with the previous-frame poses. Without it,
  // TAA reprojects from `previousModelMatrix * currentSkinnedPosition`
  // — phantom motion vectors that ghost across animated characters.
  // Defaults to the identity-matrix buffer (same as binding 0's
  // default) so non-skinned primitives degrade to "prev == current"
  // → zero skinning velocity contribution.
  const instanceBGL = makeBindGroupLayout(device, "Model Instance BGL", [
    storageBuffer(0, Stage.VERTEX, { readOnly: true }), // joint matrices
    storageBuffer(1, Stage.VERTEX, { readOnly: true }), // morph deltas
    uniformBuffer(2, Stage.VERTEX), // morph weights
    storageBuffer(3, Stage.VERTEX, { readOnly: true }), // instance transforms
    storageBuffer(4, Stage.VERTEX, { readOnly: true }), // PREV joint matrices (TAA velocity)
    // NEW-TAA-MORPH-PREV (Batch 134) -- previous-frame morph weights
    // for the velocity pass. Defaults to the current weights buffer
    // when no morph history is established (first frame), producing
    // zero velocity contribution from morph deltas.
    uniformBuffer(5, Stage.VERTEX),
    // NEW-TAA-INSTANCE-PREV (Batch 134) -- previous-frame instance
    // transforms. Today's GPU instancing is static (uploaded once,
    // never updated), so the prev buffer aliases the current one and
    // adds zero velocity contribution from instance deltas. Animated
    // EXT_mesh_gpu_instancing assets would override the alias.
    storageBuffer(6, Stage.VERTEX, { readOnly: true }),
  ]);

  return {
    cameraBGL,
    instanceBGL,
  };
}

// WebGL GL_* sampler-enum constants → GPU strings. Module-scope helpers
// so `getSamplerForReader` (method on the pipeline cache class) can use
// them without a per-call closure.
const _GL_NEAREST = 9728;
const _GL_LINEAR = 9729;
const _GL_NEAREST_MIPMAP_NEAREST = 9984;
const _GL_LINEAR_MIPMAP_NEAREST = 9985;
const _GL_NEAREST_MIPMAP_LINEAR = 9986;
const _GL_LINEAR_MIPMAP_LINEAR = 9987;
const _GL_REPEAT = 10497;
const _GL_CLAMP_TO_EDGE = 33071;
const _GL_MIRRORED_REPEAT = 33648;

function _mapGLFilter(glEnum: number, fallback: GPUFilterMode): GPUFilterMode {
  if (glEnum === _GL_NEAREST) {
    return "nearest";
  }
  if (glEnum === _GL_LINEAR) {
    return "linear";
  }
  return fallback;
}

function _mapGLMinFilter(glEnum: number): {
  min: GPUFilterMode;
  mip: GPUMipmapFilterMode;
} {
  // Return { min, mip } because WebGPU splits filter + mipmap filter.
  switch (glEnum) {
    case _GL_NEAREST:
      return { min: "nearest", mip: "nearest" };
    case _GL_LINEAR:
      return { min: "linear", mip: "nearest" };
    case _GL_NEAREST_MIPMAP_NEAREST:
      return { min: "nearest", mip: "nearest" };
    case _GL_LINEAR_MIPMAP_NEAREST:
      return { min: "linear", mip: "nearest" };
    case _GL_NEAREST_MIPMAP_LINEAR:
      return { min: "nearest", mip: "linear" };
    case _GL_LINEAR_MIPMAP_LINEAR:
    default:
      // glTF spec default is LINEAR_MIPMAP_LINEAR — honor it explicitly.
      return { min: "linear", mip: "linear" };
  }
}

function _mapGLWrap(glEnum: number): GPUAddressMode {
  if (glEnum === _GL_CLAMP_TO_EDGE) {
    return "clamp-to-edge";
  }
  if (glEnum === _GL_MIRRORED_REPEAT) {
    return "mirror-repeat";
  }
  if (glEnum === _GL_REPEAT) {
    return "repeat";
  }
  return "repeat"; // glTF spec default when no match
}

/**
 * Creates the vertex buffer layout descriptor.
 *
 * Variant-aware (Session 62 NEW-VR-VERTEX-BUFFER-VARIANT + Session 65
 * follow-up): two flags drive the slot count.
 *
 *   - `hasTexCoord1` — when false, slot 7 is omitted.
 *   - `hasFeatureId0` — when false, slot 8 is omitted.
 *
 * Brings the common-case layout from 9 → 7 buffer slots (most glTF
 * models lack both TEXCOORD_1 and feature IDs), fitting Edge's adapter
 * `maxVertexBuffers = 8` cap with headroom. Both flags also drive a
 * matching `//>>ifdef` block in `ModelPBRComplete.wgsl` so the
 * `@location(7)` / `@location(8)` declarations are stripped when the
 * corresponding slot isn't bound. Caller MUST pass the same flags to
 * the shader preprocessor when fetching the shader module — the
 * pipeline cache key includes both bits so distinct variants get
 * distinct pipelines.
 *
 * Missing attributes that aren't TEXCOORD_1 / featureId0 still use a
 * 1-element instance-step buffer with defaults — the shader's
 * `@location(N)` declarations stay unconditional for those, and the
 * renderer always binds something at every declared location.
 *
 * @param {boolean} [hasTexCoord1=true] — when false, slot 7 is omitted.
 * @param {boolean} [hasFeatureId0=true] — when false, slot 8 is omitted.
 * @param {number|boolean} [metadataSlotMode=0] — 0/false: no metadata slot;
 *   1/true: the historical single `float32x4` at shader location 9;
 *   2: NEW-MODEL-METADATA-MAT3-MAT4 widened MAT3/MAT4 transport — ONE
 *   buffer slot with `arrayStride = 64` carrying FOUR `float32x4`
 *   attributes at shader locations 9-12 (buffer COUNT is unchanged vs
 *   mode 1, so Edge's `maxVertexBuffers = 8` budget is unaffected).
 */
function createVertexBufferLayout(
  hasTexCoord1: boolean = true,
  hasFeatureId0: boolean = true,
  metadataSlotMode: number | boolean = 0,
): GPUVertexBufferLayout[] {
  const layout: GPUVertexBufferLayout[] = [
    // Slot 0: positionMC (vec3<f32>) — ALWAYS present, vertex step
    {
      arrayStride: 12,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
    },
    // Slot 1: normalMC (vec3<f32>) — may use default
    {
      arrayStride: 12,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
    },
    // Slot 2: tangentMC (vec4<f32>) — may use default
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }],
    },
    // Slot 3: texCoord0 (vec2<f32>) — may use default
    {
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 3, offset: 0, format: "float32x2" }],
    },
    // Slot 4: color0 (vec4<f32>) — may use default
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 4, offset: 0, format: "float32x4" }],
    },
    // Slot 5: joints0 (vec4<u32>) — may use default (zero joints)
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 5, offset: 0, format: "uint32x4" }],
    },
    // Slot 6: weights0 (vec4<f32>) — may use default (zero weights)
    {
      arrayStride: 16,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 6, offset: 0, format: "float32x4" }],
    },
  ];
  if (hasTexCoord1) {
    // Slot 7: texCoord1 (vec2<f32>) — used by textures whose
    // glTF textureInfo.texCoord == 1 (occlusion + clearcoat-normal are
    // the usual cases). Variant-conditional in Session 62 — primitives
    // without TEXCOORD_1 omit this slot entirely, fitting Edge's
    // 8-slot adapter cap.
    layout.push({
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 7, offset: 0, format: "float32x2" }],
    });
  }
  if (hasFeatureId0) {
    // Slot 8: featureId0 (f32) — Audit B.2 (Batch 130). Per-vertex
    // glTF `_FEATURE_ID_0` (or b3dm `_BATCHID`) cast to f32. The FS
    // reads it as a `flat`-interpolated varying and indexes the batch
    // texture / per-feature pick texture when
    // `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set in materialFlags.
    //
    // Variant-conditional in Session 65 — primitives without a feature
    // ID accessor (the common case for standard glTF models) omit this
    // slot, dropping the layout to 7 slots and fitting Edge's
    // `maxVertexBuffers = 8` cap with headroom. The shader's
    // `//>>ifdef MODEL_HAS_FEATURE_ID_0` block strips the matching
    // `@location(8)` declaration when this flag is unset, and the
    // vertex shader assigns `output.featureId0 = 0.0` directly.
    layout.push({
      arrayStride: 4,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 8, offset: 0, format: "float32" }],
    });
  }
  if (metadataSlotMode) {
    // Slot 9: metadataValue (vec4<f32>) — DP-H46a, widened to float32x4 by
    // METADATA-MULTICOMPONENT so VEC2/3/4 (and MAT2) property attributes
    // transport every component (scalars zero-pad the tail; the packing is
    // `WebGPUModelMetadata.resolvePropertyAttributeVec4`). Per-vertex value
    // from an EXT_structural_metadata property ATTRIBUTE.
    // Variant-conditional on MODEL_HAS_METADATA so non-metadata models never
    // allocate it; the shader's `//>>ifdef MODEL_HAS_METADATA` block strips
    // the matching `@location(9)` declaration when the flag is unset. The
    // BoxTexturedWithPropertyAttributes proof model uses 0..6 + this slot
    // = 8 buffers (no texCoord1, no featureId0), fitting Edge's
    // `maxVertexBuffers = 8` cap. A primitive that simultaneously carries
    // texCoord1 + featureId0 + metadata would need 10 slots — out of
    // scope for DP-H46a (no such test asset); DP-H46b's generated path
    // can pack metadata into fewer slots if that combination arises.
    //
    // NEW-MODEL-METADATA-MAT3-MAT4 (mode 2) — the SAME buffer slot widens
    // to arrayStride 64 with FOUR float32x4 attributes at shader locations
    // 9-12 (offsets 0/16/32/48) so a MAT3/MAT4 property attribute
    // transports all 9/16 column-major elements (MAT3 zero-pads 9..15 on
    // the CPU pack). Mode 1 keeps the historical single-attribute layout
    // byte-identical.
    if (metadataSlotMode === 2) {
      layout.push({
        arrayStride: 64,
        stepMode: "vertex",
        attributes: [
          { shaderLocation: 9, offset: 0, format: "float32x4" },
          { shaderLocation: 10, offset: 16, format: "float32x4" },
          { shaderLocation: 11, offset: 32, format: "float32x4" },
          { shaderLocation: 12, offset: 48, format: "float32x4" },
        ],
      });
    } else {
      layout.push({
        arrayStride: 16,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 9, offset: 0, format: "float32x4" }],
      });
    }
  }
  return layout;
}

/**
 * Creates a render pipeline for the given configuration.
 * @param {GPUDevice} device
 * @param {GPUShaderModule} shaderModule
 * @param {GPUPipelineLayout} pipelineLayout
 * @param {string} presentationFormat
 * @param {string} depthFormat
 * @param {number} alphaMode
 * @param {boolean} doubleSided
 * @returns {GPURenderPipeline}
 */
// C10-07 — the raw color-pipeline descriptor, extracted so the SYNC path
// (`createPipeline`, used by `getDepthWritePipeline` + the no-central-cache
// fallback) and the ASYNC path (`getPipeline` → central cache) build a
// BYTE-IDENTICAL descriptor (INV-07-4: same pipeline, one-frame-later at most).
function buildColorPipelineDescriptor(
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  forceDepthWrite: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  // Session 65 Batch 28 — MSAA sample count. Default 1 matches the
  // pre-bridge behavior; when the bridge re-enables this gets the
  // current `context._msaaSamples` value baked into the pipeline.
  sampleCount: number = 1,
  // DP-H46a — metadata vertex slot 9. Default false keeps every existing
  // caller's layout unchanged.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE — GPUPrimitiveTopology keyed off the glTF
  // primitive.mode. Default preserves the historical hardcoded value.
  topology: GPUPrimitiveTopology = "triangle-list",
): GPURenderPipelineDescriptor {
  const cullMode = doubleSided ? "none" : "back";

  // Blend state depends on alpha mode
  let blend: GPUBlendState | undefined;
  if (alphaMode === ALPHA_BLEND) {
    blend = {
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
    };
  }

  // Depth write: disabled for transparent objects to avoid depth conflicts.
  // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — translucent 3D-tile commands
  // tagged for classification need a depth-write variant so the existing
  // stencil-based GroundPrimitive classifier can clip volumes against the
  // tile surface. Caller passes forceDepthWrite=true to fetch that variant.
  const depthWriteEnabled = forceDepthWrite || alphaMode !== ALPHA_BLEND;

  const variantTag = forceDepthWrite ? ",dwForceOn" : "";
  const label = `Model PBR [alpha=${alphaMode},ds=${doubleSided}${variantTag}]`;

  return {
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Slice 5c-B Batch 119 — emit G-buffer slot 1 (eye-space normal +
      // roughness). The shader's fragmentMain returns FragOutput from
      // every path: main lit path emits the post-normal-map N and the
      // real material roughness (the wide-divergence pixel class);
      // clipping-edge + unlit early-out paths emit the geometric vertex
      // normal + 0.5 roughness placeholder.
      // `presentationFormat` is actually wired to
      // `context.scenePipelineFormat` per `maybeUpdateForSceneFormat()`
      // at L1526. Pick / velocity / classification have separate
      // builders and stay single-target (they don't draw into the
      // scene FB).
      targets: makeSceneFBTargets(presentationFormat, {
        emitsGBuffer: true,
        blend,
      }),
    },
    // cullMode has no effect for non-triangle topologies per the WebGPU
    // spec, so forwarding it unchanged is safe for point-list.
    primitive: {
      topology,
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled,
      depthCompare: "less-equal",
    },
    // Session 65 Batch 28 — multisample state matches the scene FB's
    // sample count. Default 1 produces `undefined` (no multisample
    // block), preserving pre-MSAA behavior.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
}

function createPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  forceDepthWrite: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  sampleCount: number = 1,
  hasMetadata: number | boolean = false,
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  return device.createRenderPipeline(
    buildColorPipelineDescriptor(
      shaderModule,
      pipelineLayout,
      presentationFormat,
      depthFormat,
      alphaMode,
      doubleSided,
      forceDepthWrite,
      hasTexCoord1,
      hasFeatureId0,
      sampleCount,
      hasMetadata,
      topology,
    ),
  );
}

/**
 * WIRE-MODEL-SILHOUETTE — silhouette-MODEL pipeline (WebGL
 * `deriveSilhouetteModelCommand` parity). Identical to `createPipeline`
 * (same module, entry points, layout, blend, depth state) plus:
 *
 *   - Stencil write: compare ALWAYS, zPass REPLACE (fail/zFail KEEP) on
 *     front and back — the base draw stamps the model's stencil
 *     reference (`model._silhouetteId % 255`, set per-draw via
 *     `renderState.stencilTest.reference` → `setStencilReference`) into
 *     the scene FB's stencil aspect so the derived colour pass can cut
 *     out the body.
 *   - `invisible = true` (WebGL `model.isInvisible()`) zeroes the color
 *     writeMask on every target so an invisible model still writes
 *     stencil (silhouette-only rendering) without touching color.
 *
 * The scene depth format is always `depth24plus-stencil8` (see
 * `WebGPUContext._depthFormat`), so declaring stencil state here is
 * valid; the renderer additionally guards on the format including
 * "stencil" before requesting this variant.
 *
 * @private
 */
function createSilhouetteModelPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  sampleCount: number,
  hasMetadata: number | boolean,
  invisible: boolean,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  const cullMode = doubleSided ? "none" : "back";
  let blend: GPUBlendState | undefined;
  if (alphaMode === ALPHA_BLEND) {
    blend = {
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
    };
  }
  const depthWriteEnabled = alphaMode !== ALPHA_BLEND;
  const stencilWrite: GPUStencilFaceState = {
    compare: "always",
    failOp: "keep",
    depthFailOp: "keep",
    passOp: "replace",
  };
  const targets = makeSceneFBTargets(presentationFormat, {
    emitsGBuffer: true,
    blend,
    // WebGL `deriveSilhouetteModelCommand` sets colorMask false for
    // invisible models — stencil still writes, color doesn't.
    writeMask: invisible ? 0 : 0xf,
  });
  return device.createRenderPipeline({
    label: `Model PBR silhouette-model [alpha=${alphaMode},ds=${doubleSided},inv=${invisible === true}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets,
    },
    primitive: {
      topology,
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled,
      depthCompare: "less-equal",
      stencilFront: stencilWrite,
      stencilBack: stencilWrite,
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
}

/**
 * WIRE-MODEL-SILHOUETTE — silhouette-COLOR pipeline (WebGL
 * `deriveSilhouetteColorCommand` parity). Same module / entry points /
 * layout as the colour pipeline (the VS/FS fork on the material UB's
 * silhouette-pass flag, not on a separate entry point) plus:
 *
 *   - Cull disabled (WebGL sets `renderState.cull.enabled = false` so
 *     back-facing inflated geometry still contributes to the rim).
 *   - Stencil test: compare NOT-EQUAL against the model's stencil
 *     reference, all ops KEEP — only pixels NOT covered by the base
 *     draw (the inflated rim) survive.
 *   - `translucent = true` (command pass is TRANSLUCENT or
 *     `silhouetteColor.alpha < 1`) adds the standard alpha blend and
 *     disables depth write, mirroring WebGL's derived render state.
 *
 * @private
 */
function createSilhouetteColorPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  sampleCount: number,
  hasMetadata: number | boolean,
  translucent: boolean,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  const stencilNotEqual: GPUStencilFaceState = {
    compare: "not-equal",
    failOp: "keep",
    depthFailOp: "keep",
    passOp: "keep",
  };
  const targets = makeSceneFBTargets(presentationFormat, {
    emitsGBuffer: true,
    translucent: translucent === true,
  });
  return device.createRenderPipeline({
    label: `Model PBR silhouette-color [alpha=${alphaMode},t=${translucent === true}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets,
    },
    primitive: {
      topology,
      cullMode: "none",
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: translucent !== true,
      depthCompare: "less-equal",
      stencilFront: stencilNotEqual,
      stencilBack: stencilNotEqual,
      // The colour pass only READS stencil (all ops KEEP); mask writes
      // off entirely so a driver quirk can't perturb the reference.
      stencilWriteMask: 0,
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
}

/**
 * C-R9-MODEL-PICK (Batch 54) — pick pipeline. Mirrors `createPipeline` for
 * vertex stage, layout, and depth state, but the fragment entry is
 * `fragmentPickMain` (writes `material.pickColor`) and there's no blend
 * (pick FBO must receive byte-exact pick IDs for the readback).
 *
 * Depth write is forced ON for ALL alpha modes, even ALPHA_BLEND. The
 * lit path disables depth write for blend so translucent layers
 * composite without z-fighting; the pick path however needs depth
 * write so the front-most fragment wins the pick (matches WebGL's
 * `RenderState.depthMask = true` for pick passes). Translucent
 * picking is intentionally simplified to "first non-discarded
 * fragment wins" in this first cut — depth-correct alpha-blended
 * picking would need OIT integration on the pick FBO and is tracked
 * separately as `C-R9-MODEL-PICK-TRANSLUCENT`.
 *
 * Cull mode follows the doubleSided flag, same as the lit pipeline,
 * so a back face that wouldn't render also wouldn't pick — matching
 * WebGL's behaviour.
 *
 * @private
 */
function createPickPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — when the pick-fleet switch is on
  // the passed `shaderModule` is the LOG_DEPTH variant (fragmentPickMain writes
  // log `@builtin(frag_depth)`); tag the label `[ld]`. Only OPAQUE/MASK picks
  // WRITE that log depth (they already wrote depth); BLEND stays depth-test-only
  // (depthWriteEnabled below is `!isBlend`, independent of this flag). Default
  // false → byte-identical.
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  // C-R9-MODEL-PICK-TRANSLUCENT (Batch 186) — first slice. Translucent
  // (BLEND) primitives must NOT write depth on the pick FBO. With
  // depth-write ON, the first translucent fragment to draw at a given
  // pixel writes both color and depth; later fragments (including
  // opaque geometry visible THROUGH the translucent surface) fail
  // `less-equal` against the translucent's z and never reach the pick
  // FBO. Toggling depth-write OFF for BLEND (matching the existing
  // color-pipeline pattern at line 535) keeps the OPAQUE depth as the
  // gate — translucent fragments pass less-equal against opaque z,
  // and opaque-behind-translucent stays pickable. Among multiple
  // translucents at varying depths between the camera and opaque,
  // last-drawn wins (depth-test passes for all, color overwrites).
  //
  // Net effect of this slice:
  //   - Opaque geometry seen through translucent surfaces is now pickable
  //     (the previously-blocking depth-write is gone).
  //   - Translucent-vs-translucent stacking changes from "first-drawn
  //     wins" to "last-drawn wins"; both are arbitrary but neither is
  //     strictly better than the other — that's what OIT-quality
  //     resolve is for.
  //
  // What this slice DOES NOT do: weighted OIT-quality accumulation +
  // composite resolve sorting by perceptual visibility. That remains
  // the second slice — it would let the user pick the visually-
  // dominant feature when translucent layers blend (e.g., picking the
  // building behind a tinted glass facade should select the building,
  // not the glass).
  const isBlend = alphaMode === 2;
  const label = `Model PBR pick [alpha=${alphaMode},ds=${doubleSided}]${
    pickLogActive ? " [ld]" : ""
  }`;
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology,
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — the pick-log switch changes the
      // ENCODING of the depth a pick pipeline writes, NOT which pipelines write.
      // OPAQUE/MASK picks (`!isBlend`) already write depth, so under the switch
      // their `fragmentPickMain` writes LOG frag_depth into the shared pick FBO.
      // BLEND/translucent picks keep the historical Batch-186 depth-test-only
      // behavior (`depthWriteEnabled:false`) so opaque-behind-translucent stays
      // pickable — the log module still runs so its frag_depth compares
      // COHERENTLY against the (log) buffer, it just isn't written. Same both
      // states → the pick-fleet switch never forces a blend pick to write depth.
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
  });
}

/**
 * DP-H46e — model metadata-PICK pipeline (`scene.pickMetadata` producer). Same
 * vertex stage / layout / single-target pick FBO color attachment / depth state
 * as {@link createPickPipeline}; the ONLY difference is the fragment entry
 * (`fragmentPickMetadataMain`, which writes the picked property's components into
 * the RGBA8 pick FBO via the GENERATED `metadataPickingStage`). The depth setup
 * matches the regular pick pipeline so the VISIBLE surface's metadata wins
 * (depth-write on for opaque/mask, off for blend, less-equal compare) — the
 * picked pixel is the same surface a regular pick would select.
 *
 * @private
 */
function createPickMetadataPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — see createPickPipeline.
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  const isBlend = alphaMode === 2;
  return device.createRenderPipeline({
    label: `Model PBR pick-metadata [alpha=${alphaMode},ds=${doubleSided}]${
      pickLogActive ? " [ld]" : ""
    }`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMetadataMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology,
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH — see createPickPipeline. Opaque/mask
      // metadata-pick writes LOG frag_depth under the switch; BLEND keeps the
      // depth-test-only behavior. The switch never changes which pipeline writes.
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
  });
}

/**
 * C2-25 ENV-SCENE-CAPTURE (Batch 447) — model CAPTURE pipeline. Renders the
 * model's lit `fragmentMain` into ONE cube-face color attachment (no MRT
 * slot-1), a transient no-stencil `depth24plus` depth target, and NO MSAA —
 * matching the `WebGPUDynamicEnvironmentMapCapture` per-face render pass shape.
 * The `CAPTURE_MODE` shader define (folded into the module fetched by the
 * caller) drops the `@location(1) normalRoughness` output so the fragment stage
 * matches the single target (a MRT/target-count mismatch would be a HARD WebGPU
 * validation error).
 *
 * Differences from the on-screen color pipeline (`createPipeline`):
 *   - single color target = `faceFormat` (no G-buffer slot 1)
 *   - `depthFormat = depth24plus` (no stencil)
 *   - `sampleCount = 1` (no MSAA)
 *   - `cullMode = "none"` (disableCulling): the 6 ENU cube-face cameras render
 *     left-handed for the screen-matched basis, which flips triangle winding;
 *     rather than fight the winding sign per face the capture pass disables
 *     culling and lets the depth test pick the nearest surface (correct for a
 *     reflection source — mirrors the globe capture pipeline).
 *
 * Opaque write (no blend): the per-face pass composites the model OVER the
 * already-captured globe + sky via the render pass `loadOp: 'load'` and the
 * shared depth buffer (model depth-tests against globe), not a blend op.
 *
 * @private
 */
function createCapturePipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  faceFormat: GPUTextureFormat,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  return device.createRenderPipeline({
    label: `Model PBR capture [face=${faceFormat},ds=${doubleSided}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // CAPTURE_MODE module emits FragOutput { @location(0) color } only.
      targets: [{ format: faceFormat, writeMask: 0xf }],
    },
    primitive: {
      topology,
      // disableCulling — cube-face render is left-handed; depth picks nearest.
      cullMode: "none",
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    // Always single-sample (no MSAA) for the capture pass.
  });
}

/**
 * C-R9-MODEL-PICK-TRANSLUCENT Option D (Batch 192) — hover-pick
 * pipeline variant for BLEND primitives. Uses `fragmentPickHoverMain`
 * which discards translucent fragments stochastically via Interleaved
 * Gradient Noise (probability of survival = effective alpha). With
 * dither doing the alpha gating, depth-write can stay ON and standard
 * depth-test picks the closest survived fragment — same render-pass
 * cost as default opaque pick. Stutter-free at 60fps hover frequency.
 *
 * @private
 */
function createPickHoverPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — see createPickPipeline. Depth-write
  // is already true here (dither-gated blend competes on the standard depth test).
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-hover [BLEND,ds=${doubleSided}]${
    pickLogActive ? " [ld]" : ""
  }`;
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickHoverMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology, cullMode },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
}

/**
 * C-R9-MODEL-PICK-TRANSLUCENT Option C precise pass 1 (Batch 192).
 * Depth pre-pass for BLEND primitives — writes depth + stencil but no
 * color so a subsequent pass 2 (`createPickPrecisePass2Pipeline`) can
 * identify the geometrically-closest translucent fragment per pixel.
 *
 * State:
 *   - depthWriteEnabled: true   — record closest translucent depth
 *   - depthCompare: less-equal  — standard depth test
 *   - stencil writes ref=1 on pass — marks "this pixel had a translucent
 *     fragment that won the depth test"
 *   - colorWriteMask: 0         — no color output; pass 2 writes color
 *
 * @private
 */
function createPickPrecisePass1Pipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — reuses fragmentPickMain, so it
  // MUST take the same pick-gated module; tag `[ld]` when active. Depth-write is
  // already true (this pass records the closest translucent log depth).
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-precise pass1 [BLEND,ds=${doubleSided}]${
    pickLogActive ? " [ld]" : ""
  }`;
  // Stencil ops only valid on depth-stencil formats. Sniff the format.
  const hasStencil =
    depthFormat === "depth24plus-stencil8" ||
    depthFormat === "depth32float-stencil8";
  const stencilState: Partial<GPUDepthStencilState> = hasStencil
    ? {
        stencilFront: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace",
        },
        stencilBack: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace",
        },
        stencilReadMask: 0xff,
        stencilWriteMask: 0xff,
      }
    : {};
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      // colorWriteMask: 0 → fragment output is dropped; only depth +
      // stencil writes apply.
      targets: [{ format: presentationFormat, writeMask: 0 }],
    },
    primitive: { topology, cullMode },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
      ...stencilState,
    },
  });
}

/**
 * C-R9-MODEL-PICK-TRANSLUCENT Option C precise pass 2 (Batch 192).
 * Color pass for BLEND primitives — runs in the SAME render pass as
 * pass 1 (sharing the depth + stencil attachments) and writes pickColor
 * only on fragments where stencil==1 AND depth==current. This isolates
 * the single closest translucent fragment per pixel for deterministic
 * pick winner selection.
 *
 * State:
 *   - depthWriteEnabled: false  — pass 1 already wrote final depth
 *   - depthCompare: equal       — only the closest fragment passes
 *   - stencil compare: equal w/ ref=1 — only pass-1 winners participate
 *   - colorWriteMask: ALL       — actual pickColor output
 *
 * Used in conjunction with pass 1; never standalone.
 *
 * @private
 */
function createPickPrecisePass2Pipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — reuses fragmentPickMain, so it
  // MUST take the same pick-gated module; tag `[ld]` when active. Depth-write
  // STAYS false: this pass depth-tests `equal` against the log depth pass1 wrote
  // (both use fragmentPickMain, so the log frag_depth values match) — forcing
  // depth-write here would corrupt the two-pass equal-test winner selection.
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-precise pass2 [BLEND,ds=${doubleSided}]${
    pickLogActive ? " [ld]" : ""
  }`;
  const hasStencil =
    depthFormat === "depth24plus-stencil8" ||
    depthFormat === "depth32float-stencil8";
  const stencilState: Partial<GPUDepthStencilState> = hasStencil
    ? {
        stencilFront: {
          compare: "equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
        stencilBack: {
          compare: "equal",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "keep",
        },
        stencilReadMask: 0xff,
        stencilWriteMask: 0xff,
      }
    : {};
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology, cullMode },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "equal",
      ...stencilState,
    },
  });
}

/**
 * TAA Slice 2e (Batch 106) — velocity-only pipeline variant. Single
 * `rg16float` color target matching the scene-FB velocity texture
 * format (Batch 104). Vertex stage and bind-group layout are identical
 * to the color pipeline; only the fragment entry (`fragmentVelocityMain`)
 * and target format differ.
 *
 * Depth is bound read-only (`depthWriteEnabled: false`,
 * `depthCompare: less-equal`) so the velocity pass shares the scene
 * depth from the main color pass — fragments behind opaque geometry
 * fail the depth test and don't emit velocity. The velocity pass runs
 * AFTER the main color pass closes, so the depth attachment must be
 * loaded with `depthLoadOp: load` at the pass level — that's a render-
 * pass concern, not a pipeline concern.
 *
 * Cull mode follows the doubleSided flag (matches the color pipeline)
 * so velocity is emitted from exactly the same fragments the color
 * pass shaded — no risk of velocity for back-faces that weren't drawn.
 *
 * @private
 */
function createVelocityPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  // Session 65 Batch 28 — MSAA sample count. NO LONGER READ by this
  // pipeline as of Batch 143; signature kept for back-compat with the
  // pipeline-cache call site. See multisample comment below.
  sampleCount: number = 1,
  // DP-H46a — metadata vertex slot 9.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  void sampleCount;
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR velocity [alpha=${alphaMode},ds=${doubleSided}]`;
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
    },
    primitive: {
      topology,
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Batch 143 — drop multisample. The velocity pass attaches the
    // single-sample velocityTexture (per WebGPUSceneFramebuffer.ts:118)
    // as the only color attachment, so the pipeline must also be
    // single-sample to match. Pre-Batch-143 this baked
    // `{count: sampleCount}` (= 4 when scene MSAA is on) which would
    // trigger a sampleCount-mismatch validation error the moment Model
    // started emitting velocity commands. This IS now live (TAA-SLICE-2B,
    // premise-reconciled 2026-07-05): Model primitives DO tag
    // `.velocityCommand` when `frameState.taaEnabled` (WebGPUModelRenderer
    // L4967), and `probe-model-taa-msaa.mjs` now reports 1/80 velocity
    // commands with 0 device errors — the TAA→MSAA=1 coupling in
    // `prepareFrame` keeps the velocity pass's single-sample attachments
    // valid against scene depth, so this single-sample pipeline is the
    // correct match. Do NOT re-add `{count: sampleCount}` here.
    //
    // Matches the collection renderers' velocity pipelines (Batch 134)
    // which all leave multisample undefined for the same reason.
  });
}

/**
 * AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
 * classification pipeline variant for `Model.classificationType`. Same
 * vertex stage and pipeline layout as the lit color pipeline (so the
 * model's existing skinning / morph / instancing transforms apply
 * unchanged), but the fragment entry is `fragmentClassificationMain`
 * which samples the globe-depth texture (already bound on
 * `@group(3) @binding(15)` via the effects bind group) and discards
 * pixels that don't have a classifiable surface (sky / no globe data).
 *
 * Depth state mirrors the regular GroundPrimitive classifier:
 * `depthWriteEnabled: false`, `depthCompare: less-equal`. Standard
 * src-alpha blend so the model's `baseColorFactor.a` controls the
 * classification opacity.
 *
 * @private
 */
function createClassificationPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  presentationFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  // Session 65 Batch 28 — MSAA sample count.
  sampleCount: number = 1,
  // DP-H46a — metadata vertex slot 9.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: GPUPrimitiveTopology = "triangle-list",
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model classification [alpha=${alphaMode},ds=${doubleSided}]`;
  const blend: GPUBlendState = {
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
  };
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(
        hasTexCoord1,
        hasFeatureId0,
        hasMetadata,
      ),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentClassificationMain",
      // Slice 5c-B Phase 1 (Batch 114) — scene-FB color target via
      // helper. Classification draws translucent overlays into scene FB.
      targets: makeSceneFBTargets(presentationFormat, { blend }),
    },
    primitive: { topology, cullMode },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
}

/**
 * WebGPUModelPipelineCache manages GPU pipeline variants for Model rendering.
 */
class WebGPUModelPipelineCache {
  // Type-only field declarations (Session-29 interop pattern). Every field
  // is `declare` so nothing is emitted at runtime — the constructor's
  // assignments remain the sole runtime writes, keeping the compiled output
  // byte-identical to the pre-conversion JS.
  declare _device: GPUDevice;
  declare _presentationFormat: GPUTextureFormat;
  // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — the pick-family pipelines' color
  // target format, mirrored from `context.pickPipelineFormat` on every
  // scene-format generation bump. Equals `_presentationFormat` in SDR;
  // stays an 8-bit unorm when the scene target is float/HDR.
  declare _pickFormat: GPUTextureFormat;
  declare _depthFormat: GPUTextureFormat;
  declare _sampleCount: number;
  declare _sceneFormatGeneration: number;
  declare _pipelines: Map<string | number, GPURenderPipeline>;
  // C10-07 — central async render-pipeline cache (shared across renderer
  // instances on the same device) + per-key in-flight set for the model
  // COLOR pipeline's `resolveGlobePipelineEntry`-style ready-gate. Null when
  // no central cache is available (falls back to the synchronous build path).
  declare _centralPipelineCache: WebGPURenderPipelineCache | null;
  declare _pendingColorPipelines: Set<string | number>;
  declare _errorShaderModule: GPUShaderModule | null;
  declare _errorPipelines: Map<string | number, GPURenderPipeline>;
  declare _errorSwapGeneration: number;
  declare _pickPipelines: Map<string | number, GPURenderPipeline>;
  declare _depthWritePipelines: Map<string | number, GPURenderPipeline>;
  declare _velocityPipelines: Map<string | number, GPURenderPipeline>;
  declare _classificationPipelines: Map<string | number, GPURenderPipeline>;
  declare _silhouetteModelPipelines: Map<string | number, GPURenderPipeline>;
  declare _silhouetteColorPipelines: Map<string | number, GPURenderPipeline>;
  declare _pickHoverPipelines: Map<string | number, GPURenderPipeline>;
  declare _pickPrecisePass1Pipelines: Map<string | number, GPURenderPipeline>;
  declare _pickPrecisePass2Pipelines: Map<string | number, GPURenderPipeline>;
  declare _capturePipelines: Map<string | number, GPURenderPipeline>;
  declare _pickMetadataPipelines: Map<string | number, GPURenderPipeline>;
  declare _cameraBGL: GPUBindGroupLayout;
  declare _instanceBGL: GPUBindGroupLayout;
  declare _effectsBGL: GPUBindGroupLayout;
  declare _materialBGLCache: Map<number, GPUBindGroupLayout>;
  declare _pipelineLayoutCache: Map<number, GPUPipelineLayout>;
  declare _shaderModuleCache: Map<string | number, GPUShaderModule>;
  declare _metadataShaderModuleCache: Map<string | number, GPUShaderModule>;
  declare _metadataWGSL: string;
  declare _metadataClassHash: number;
  declare _metadataMatTransport: boolean;
  declare _metadataPickWGSL: string;
  declare _metadataPickClassHash: number;
  declare _customShaderWGSL: string;
  declare _customShaderClassHash: number;
  declare _primitiveTopology: GPUPrimitiveTopology;
  declare _logDepthEnabled: boolean;
  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — SEPARATE pick-fleet log-depth
  // switch, mirrored from `context._pickLogDepthWriteEnabled` via
  // maybeUpdateForPickLogDepth() each frame. The 3 pick fragment entries (and
  // the 2 BLEND precise-pass pipelines reusing fragmentPickMain) compile their
  // module with LOG_DEPTH gated by THIS flag — NOT the scene `_logDepthEnabled`
  // — so the shared pick FBO stays uniformly hyperbolic OR log across the whole
  // fleet (INV-2). Default false → the pick modules carry no LOG_DEPTH define
  // and the pick pipelines are byte-identical hyperbolic until C10-11's flip.
  declare _pickLogDepthEnabled: boolean;
  declare _splitEnabled: boolean;
  declare _modelColorEnabled: boolean;
  declare _silhouetteEnabled: boolean;
  declare _materialBGL_basic: GPUBindGroupLayout;
  declare _pipelineLayout_basic: GPUPipelineLayout;
  declare _shaderModule_basic: GPUShaderModule;
  declare _materialBGL: GPUBindGroupLayout;
  declare _pipelineLayout: GPUPipelineLayout;
  declare _shaderModule: GPUShaderModule;
  declare _defaultWhiteTexture: GPUTexture;
  declare _defaultNormalTexture: GPUTexture;
  declare _defaultBlackTexture: GPUTexture;
  declare _defaultSampler: GPUSampler;
  declare _defaultIBLCubemap: GPUTexture;
  declare _defaultIBLCubemapView: GPUTextureView;
  declare _defaultIBLSampler: GPUSampler;
  declare _defaultSHBuffer: GPUBuffer;
  declare _defaultBrdfLut: GPUTexture;
  declare _defaultBrdfLutView: GPUTextureView;
  declare _defaultBrdfLutSampler: GPUSampler;
  declare _defaultPropertyTexture: GPUTexture;
  declare _defaultPropertyTextureView: GPUTextureView;
  declare _propertyTextureSampler: GPUSampler;
  declare _samplerCache: Map<string, GPUSampler>;
  declare _defaultNormalBuffer: GPUBuffer;
  declare _defaultTangentBuffer: GPUBuffer;
  declare _defaultUVBuffer: GPUBuffer;
  declare _defaultColorBuffer: GPUBuffer;
  declare _defaultJointsBuffer: GPUBuffer;
  declare _defaultWeightsBuffer: GPUBuffer;
  declare _defaultFeatureIdBuffer: GPUBuffer;
  declare _defaultJointBuffer: GPUBuffer;
  declare _defaultMorphDeltaBuffer: GPUBuffer;
  declare _defaultMorphWeightBuffer: GPUBuffer;
  declare _defaultInstancingBuffer: GPUBuffer;
  declare _defaultInstanceBG: GPUBindGroup;
  declare _defaultFeatureUniformBuffer: GPUBuffer;
  declare _defaultFeatureIdEntries: () => GPUBindGroupEntry[];

  // Alpha-mode constants, assigned as static properties below the class.
  declare static ALPHA_OPAQUE: number;
  declare static ALPHA_MASK: number;
  declare static ALPHA_BLEND: number;

  /**
   * @param {GPUDevice} device
   * @param {string} presentationFormat - e.g., "bgra8unorm"
   * @param {string} depthFormat - e.g., "depth24plus-stencil8"
   */
  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    // C10-07 — central async pipeline cache from the context
    // (`context.webgpuPipelineCache`). Optional + null-default so the
    // existing 3-arg call sites and the synchronous fallback path are
    // unaffected; when present the on-screen COLOR pipeline resolves through
    // it via `createRenderPipelineAsync`.
    centralPipelineCache: WebGPURenderPipelineCache | null = null,
  ) {
    this._device = device;
    this._centralPipelineCache = centralPipelineCache;
    this._pendingColorPipelines = new Set();
    this._presentationFormat = presentationFormat;
    // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — construction-time clamp; the
    // authoritative `context.pickPipelineFormat` is mirrored on the first
    // `maybeUpdateForSceneFormat` (generation sentinel −1 guarantees it runs).
    this._pickFormat = clampToPickFormat(presentationFormat);
    this._depthFormat = depthFormat;
    // Session 65 Batch 28 — MSAA sample count tracked alongside format
    // generation. When the bridge in `WebGPUSceneRenderer.prepareFrame`
    // sets `context._msaaSamples`, the generation counter bumps (Batch
    // 25), this cache wipes on the next `maybeUpdateForSceneFormat`,
    // and `createPipeline` reads the new sample count to bake into the
    // freshly-created pipelines. `_sampleCount = 1` matches the default
    // hardcoded value of `WebGPUContext._msaaSamples` so pre-bridge
    // behavior is unchanged.
    this._sampleCount = 1;
    // Batch 110 — track the scene pipeline format generation last
    // applied so a runtime HDR / canvas-format change can invalidate
    // every cached pipeline (color, pick, depth-write, velocity).
    // Pipelines have their fragment target format baked in at
    // creation; without invalidation the cached entries would
    // produce validation errors against the recreated scene FB.
    // -1 sentinel so the first call to `maybeUpdateForSceneFormat`
    // unconditionally writes the current generation without a clear.
    this._sceneFormatGeneration = -1;
    this._pipelines = new Map();
    // C-22 — flat-magenta error pipelines (per pipeline-layout variant `md`),
    // substituted into `_pipelines` when a color pipeline fails validation. The
    // shared error shader module is built lazily on first failure.
    this._errorShaderModule = null;
    this._errorPipelines = new Map();
    // Bumped each time a color pipeline is swapped to its magenta fallback, so
    // the model renderer (which caches the pipeline reference per primitive) can
    // detect the swap and re-fetch. Exceptional path — only changes on failure.
    this._errorSwapGeneration = 0;
    // C-R9-MODEL-PICK (Batch 54) — pick pipeline cache, keyed by the same
    // (alphaMode, doubleSided) pair as `_pipelines`. Each pick pipeline
    // shares the layout + vertex stage of its color sibling and only
    // differs in the fragment entry + no-blend target state.
    this._pickPipelines = new Map();
    // C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — depth-write variant cache,
    // populated lazily for translucent commands tagged with
    // `depthForTranslucentClassification`. Same key shape as `_pipelines`
    // (alphaMode, doubleSided), so a translucent BLEND primitive that
    // also needs depth-write gets a separate pipeline that writes depth.
    // The two variants share layout, vertex, fragment, and blend state;
    // only `depthWriteEnabled` differs. We cannot reuse `_pipelines`
    // because its key would collide for the same (alphaMode, doubleSided).
    this._depthWritePipelines = new Map();
    // TAA Slice 2e (Batch 106) — velocity pipeline cache. Same key shape
    // (alphaMode, doubleSided) as the color cache; entries are built on
    // demand the first frame TAA is enabled for any primitive carrying
    // a given (alphaMode, doubleSided) identity. Static scenes (TAA
    // off) never construct a velocity pipeline.
    this._velocityPipelines = new Map();
    // AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) —
    // classification pipeline cache. Built on demand the first frame a
    // model with `classificationType !== undefined` reaches the FR;
    // models without classificationType (the common case) never
    // construct a classification pipeline.
    this._classificationPipelines = new Map();

    // WIRE-MODEL-SILHOUETTE — silhouette two-pass pipeline caches
    // (WebGL `deriveSilhouetteModelCommand` / `deriveSilhouetteColorCommand`
    // parity). Keyed by `"computeKey(alphaMode, doubleSided, md):variantFlag"`
    // strings — the variant flag is `isInvisible` for the model (stencil-
    // write) pass and `translucent` for the colour pass. Built lazily the
    // first frame a model with `silhouetteSize > 0` reaches the FR;
    // models without silhouettes (the default) never construct either.
    this._silhouetteModelPipelines = new Map();
    this._silhouetteColorPipelines = new Map();

    // C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — second-slice pipeline
    // slots. Built lazily; only allocated for primitives whose owning
    // app calls `scene.pickHover` or `scene.pickPrecise`. The default
    // `scene.pick` flow uses the existing `_pickPipelines` Map.
    //
    //   _pickHoverPipelines: Option D (stochastic dither alpha-test).
    //     For BLEND alphaMode, fragmentPickHoverMain replaces the
    //     `< 0.004` discard with IGN-dither-driven probabilistic
    //     survival. For OPAQUE/MASK, identical to `_pickPipelines`.
    //
    //   _pickPrecisePass1Pipelines: Option C precise pass 1 (depth
    //     pre-pass). For BLEND, depth-write=true, depth-compare=
    //     less-equal, color-write=0. For OPAQUE/MASK, identical to
    //     `_pickPipelines` (no 2-pass needed).
    //
    //   _pickPrecisePass2Pipelines: Option C precise pass 2 (color
    //     pass with depth-EQUAL test). BLEND only — OPAQUE/MASK never
    //     hit pass 2 since their precise pick is the same as default.
    this._pickHoverPipelines = new Map();
    this._pickPrecisePass1Pipelines = new Map();
    this._pickPrecisePass2Pipelines = new Map();

    // C2-25 ENV-SCENE-CAPTURE (Batch 447) — model scene-capture pipeline cache.
    // Keyed by `(alphaMode, doubleSided, materialDefines, faceFormat)`; built
    // SYNCHRONOUSLY on first miss (the capture pass is debounced + the env-cube
    // sky fill rewrites the whole cube each refresh, so an async-pending frame
    // would read back as a permanently-flat sky-only reflection — same rationale
    // as the globe's `resolveCapturePipelineEntrySync`). DELIBERATELY separate
    // from `_pipelines`: a capture build NEVER touches the on-screen color
    // pipeline cache or `_sceneFormatGeneration`, and is NOT wiped by
    // `maybeUpdateForSceneFormat` (its target is the env-cube face format, not
    // the scene FB format). Lazily populated only when capture is active →
    // default-OFF byte-identical (no allocation, no creation).
    this._capturePipelines = new Map();
    // DP-H46e — metadata-PICK pipelines (scene.pickMetadata producer). Keyed by
    // `(alphaMode, doubleSided, materialDefines)` × the picked-property class
    // hash (so a re-pick of a DIFFERENT property gets its own pipeline+module).
    // Lazily populated only during a metadata-pick pass → default-OFF
    // byte-identical (no allocation when pickMetadata is never called).
    this._pickMetadataPipelines = new Map();

    // Create shared bind group layouts (NEW-BG-CONSOLIDATION, 4 groups).
    const bgls = createBindGroupLayouts(device);
    this._cameraBGL = bgls.cameraBGL;
    this._instanceBGL = bgls.instanceBGL; // merged: skinning+morph+instancing
    // Effects BGL (group 3) — shared with globe + primitive via
    // `getEffectsBindGroupLayout` factory.
    this._effectsBGL = getEffectsBindGroupLayout(device);

    // Batch 174 — B.4 KHR materialBGL split. Per-variant caches keyed
    // by `materialDefines: number` (a bitmask of ShaderDefine bits
    // gating which KHR bindings are present). A primitive's effective
    // variant = OR of the gate defines for the KHR extensions its
    // material flags activate (today coarse: all-or-nothing on
    // `MODEL_HAS_KHR_TEXTURES`; tomorrow per-extension granular).
    //
    // The maps are populated lazily from `getOrCreateMaterialBGL` /
    // `getOrCreatePipelineLayout` so a scene with only basic-variant
    // models never builds the full layout, and a scene with only
    // full-variant models never builds the basic layout. Maps live for
    // the lifetime of the cache (= one Model). Pipelines themselves
    // (color / pick / depth-write / velocity / classification) cache
    // independently, keyed on the same `materialDefines` plus
    // alphaMode / doubleSided.
    this._materialBGLCache = new Map();
    this._pipelineLayoutCache = new Map();
    this._shaderModuleCache = new Map();

    // DP-H46b — per-metadata-class shader-module cache. The generated
    // metadata WGSL chunk (`MetadataWGSLPipelineStage.generateMetadataWGSL`)
    // is class-dependent, so two primitives whose metadata classes differ
    // must NOT share one compiled module. When MODEL_HAS_METADATA is set,
    // `_getOrCreateShaderModule` keys here by `${effectiveDefines}:${hash}`
    // (the class hash supplied by the renderer via `setMetadataWGSL`) instead
    // of the bitmask-only `_shaderModuleCache`. Non-metadata primitives never
    // touch this map → their module hash + cache key are unchanged (parity).
    this._metadataShaderModuleCache = new Map();
    // The generated chunk + its hash for the primitive whose pipeline is
    // currently being (re)built. The renderer sets these via `setMetadataWGSL`
    // immediately before each metadata `getPipeline*` call and clears them
    // (`clearMetadataWGSL`) for non-metadata primitives so a stale chunk can't
    // leak into a non-metadata module.
    this._metadataWGSL = "";
    this._metadataClassHash = 0;
    // NEW-MODEL-METADATA-MAT3-MAT4 — sticky per-primitive widened MAT3/MAT4
    // transport flag (same set-before-every-getPipeline* contract as the
    // chunk above). Drives the MODEL_METADATA_MAT_TRANSPORT preprocess bit,
    // the mode-2 slot-9 vertex layout, and the `:m34` pipeline-key suffix.
    this._metadataMatTransport = false;
    // DP-H46e — the metadata-PICK chunk (display chunk + the appended
    // `metadataPickingStage` for the currently-picked property) + its hash. Set
    // by the renderer via `setMetadataPickWGSL` immediately before building the
    // metadata-pick pipeline, consumed by `_getOrCreateShaderModule` when the
    // METADATA_PICKING_ENABLED bit is set. Independent of `_metadataWGSL` so the
    // display module and the pick module of the same primitive don't clobber each
    // other within one frame.
    this._metadataPickWGSL = "";
    this._metadataPickClassHash = 0;

    // PARITY-CUSTOM-SHADER-WGSL — the generated customShader chunk + its class
    // hash for the primitive whose pipeline is currently being (re)built. Set by
    // the renderer via `setCustomShaderWGSL` immediately before each customShader
    // `getPipeline*` call, cleared (`clearCustomShaderWGSL`) for non-customShader
    // primitives so a stale chunk can't leak. Prepended at the SAME injection
    // point as the metadata chunk; folded into the module cache key when
    // MODEL_HAS_WGSL_CUSTOM_SHADER / _VERTEX is set.
    this._customShaderWGSL = "";
    this._customShaderClassHash = 0;

    // GLTF-POINTS-MODE — the GPUPrimitiveTopology of the primitive whose
    // pipeline is currently being (re)built. Set by the renderer via
    // `setPrimitiveTopology` immediately before each `getPipeline*` call
    // (the same sticky-state pattern as the metadata/customShader chunks
    // above — `applyPrimitiveMetadataToPipelineCache` writes all three).
    // "triangle-list" is the historical hardcoded value; triangle
    // primitives keep byte-identical cache keys + pipeline descriptors.
    this._primitiveTopology = "triangle-list";

    // Eagerly build the basic variant (materialDefines = 0). Most
    // scenes have at least one non-KHR primitive and the basic layout
    // doubles as a `materialBGL_basic` accessor for renderer code that
    // wants to peek at the layout without going through the variant
    // API.
    // Renderer-wide log depth — OFF until the renderer's first
    // maybeUpdateForLogDepth() call mirrors the live master switch.
    this._logDepthEnabled = false;
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — pick-fleet log depth, OFF
    // until the renderer's first maybeUpdateForPickLogDepth() call mirrors the
    // SEPARATE `context._pickLogDepthWriteEnabled` master switch.
    this._pickLogDepthEnabled = false;
    // WIRE-MODEL-SPLITTER — per-model split-screen discard. OFF until the
    // renderer's first maybeUpdateForSplit() call mirrors
    // `model.splitDirection !== SplitDirection.NONE`. This cache is
    // per-Model, so a per-model flag is the right granularity.
    this._splitEnabled = false;
    // WIRE-MODEL-COLOR — per-model model.color blend. OFF until the
    // renderer's first maybeUpdateForModelColor() call mirrors
    // `defined(model.color)`. Per-Model flag, same granularity as split.
    this._modelColorEnabled = false;
    // WIRE-MODEL-SILHOUETTE — per-model silhouette state. OFF until the
    // renderer's first maybeUpdateForSilhouette() call mirrors the WebGL
    // `Model.hasSilhouette()` predicate. Per-Model flag, same granularity
    // as split / model-color.
    this._silhouetteEnabled = false;

    this._materialBGL_basic = this._getOrCreateMaterialBGL(0);
    this._pipelineLayout_basic = this._getOrCreatePipelineLayout(0);
    this._shaderModule_basic = this._getOrCreateShaderModule(0);

    // Eagerly build the full-KHR variant too — this is the historical
    // default before the split, and exposed via the `materialBGL`
    // getter for compatibility with callers that don't yet pass a
    // variant key.
    this._materialBGL = this._getOrCreateMaterialBGL(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    this._pipelineLayout = this._getOrCreatePipelineLayout(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    this._shaderModule = this._getOrCreateShaderModule(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );

    // Create default 1x1 textures for missing material textures
    this._defaultWhiteTexture = this._createDefaultTexture(
      255,
      255,
      255,
      255,
      "default-white",
    );
    this._defaultNormalTexture = this._createDefaultTexture(
      128,
      128,
      255,
      255,
      "default-normal",
    );
    this._defaultBlackTexture = this._createDefaultTexture(
      0,
      0,
      0,
      255,
      "default-black",
    );
    this._defaultSampler = device.createSampler({
      label: "Model default sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    // Audit A.9 (Batch 130) — placeholder cubemap for IBL bindings 33
    // and 34 when a model has no `imageBasedLighting` configured. 1×1
    // mid-grey on all 6 faces so the FS samples (0.5, 0.5, 0.5) ambient
    // — same intensity as the previous hardcoded `vec3(0.2)` baseline,
    // just routed through the texture path. Skinned/material code never
    // overrides the binding when no IBL is set up; the FS doesn't gate
    // the sample on an `iblEnabled` flag, so the placeholder must
    // produce a sane reflection level on its own.
    this._defaultIBLCubemap = device.createTexture({
      label: "default-ibl-cubemap",
      size: [1, 1, 6],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    {
      // half-float 0.5 = 0x3800; rgba16f payload per texel = 4 × 2 bytes.
      const halfHalf = new Uint16Array([0x3800, 0x3800, 0x3800, 0x3c00]);
      for (let face = 0; face < 6; face++) {
        device.queue.writeTexture(
          { texture: this._defaultIBLCubemap, origin: [0, 0, face] },
          halfHalf,
          { bytesPerRow: 8 },
          { width: 1, height: 1 },
        );
      }
    }
    this._defaultIBLCubemapView = this._defaultIBLCubemap.createView({
      dimension: "cube",
    });
    this._defaultIBLSampler = device.createSampler({
      label: "default-ibl-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    // SH UBO is 9 vec3 + 1 active flag = 9 × 16 + 16 = 160 bytes
    // (vec3 in WGSL uniform layout is padded to 16). Default = all
    // zeros + active = 0 so the shader's `useSH` branch falls back
    // to the placeholder cubemap.
    this._defaultSHBuffer = device.createBuffer({
      label: "default-ibl-sh",
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultSHBuffer, 0, new Float32Array(40));

    // NEW-MODEL-IBL-BRDF-LUT (Batch 287) — 1×1 placeholder BRDF
    // integration LUT (bindings 37/38) for models drawn before
    // `BrdfLutGenerator` has produced the real 256×256 table. (scale=1,
    // bias=0) makes the split-sum term collapse to `radiance * F0`,
    // matching the pre-LUT behaviour so the placeholder frame doesn't
    // flash a different specular intensity. rg32float is non-filterable;
    // the sampler is `non-filtering` to satisfy validation.
    this._defaultBrdfLut = device.createTexture({
      label: "default-brdf-lut",
      size: [1, 1],
      format: "rg32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._defaultBrdfLut },
      new Float32Array([1.0, 0.0]),
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
    this._defaultBrdfLutView = this._defaultBrdfLut.createView();
    this._defaultBrdfLutSampler = device.createSampler({
      label: "default-brdf-lut-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // DP-H46c — placeholder property-texture (1×1 black, rgba8unorm/linear)
    // + a clamp-to-edge sampler. Property metadata values are raw byte
    // channels, never gamma-encoded, so the placeholder + sampler stay
    // linear. The placeholder fills the MAX_PROPERTY_TEXTURES BGL slots the
    // generated shader does NOT sample (a pipeline may use a subset of its
    // layout's bindings, but the bind group must satisfy every entry), AND
    // backs a property texture whose glTF image hasn't resolved yet.
    this._defaultPropertyTexture = device.createTexture({
      label: "default-property-texture",
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this._defaultPropertyTexture },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this._defaultPropertyTextureView =
      this._defaultPropertyTexture.createView();
    // glTF property textures default to NEAREST sampling in the corpus
    // (SimplePropertyTexture's sampler is magFilter/minFilter NEAREST), and
    // metadata sampling must NOT interpolate raw byte values across texels —
    // nearest is the correct default for data textures.
    this._propertyTextureSampler = device.createSampler({
      label: "property-texture-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Per-textureInfo sampler cache. glTF textures each carry a
    // `sampler` object with magFilter / minFilter / wrapS / wrapT values;
    // creating a new GPUSampler per distinct combination and reusing it
    // avoids thrashing the device with duplicate samplers when a tileset
    // has thousands of glTF textures that share sampler state (common —
    // glTF authoring pipelines usually emit one sampler per material
    // repeated across all textures).
    this._samplerCache = new Map();

    // Create default vertex buffers for missing attributes
    this._defaultNormalBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 1, 0]),
      "default-normal-vb",
    );
    this._defaultTangentBuffer = this._createDefaultVertexBuffer(
      new Float32Array([1, 0, 0, 1]),
      "default-tangent-vb",
    );
    this._defaultUVBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 0]),
      "default-uv-vb",
    );
    this._defaultColorBuffer = this._createDefaultVertexBuffer(
      new Float32Array([1, 1, 1, 1]),
      "default-color-vb",
    );
    // Skinning defaults: zero joints and zero weights
    this._defaultJointsBuffer = this._createDefaultVertexBuffer(
      new Uint32Array([0, 0, 0, 0]),
      "default-joints-vb",
    );
    this._defaultWeightsBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0, 0, 0, 0]),
      "default-weights-vb",
    );
    // Audit B.2 (Batch 130) — single-element default for slot 8
    // (featureId0). The FS only reads the value when
    // FLAG_HAS_FEATURE_ID_ATTRIBUTE is set, so the zero default never
    // reaches the batch / pick lookup paths for primitives that lack
    // an authored feature id.
    this._defaultFeatureIdBuffer = this._createDefaultVertexBuffer(
      new Float32Array([0]),
      "default-featureId-vb",
    );

    // Default skinning bind group: 1-element identity matrix storage buffer
    // Used when a primitive has no skinning (FLAG_HAS_SKINNING will be false)
    const identityData = new Float32Array(16);
    identityData[0] = 1;
    identityData[5] = 1;
    identityData[10] = 1;
    identityData[15] = 1;
    this._defaultJointBuffer = device.createBuffer({
      label: "default-joint-matrices",
      size: 64, // 1 mat4 = 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultJointBuffer, 0, identityData);
    // NEW-BG-CONSOLIDATION (Batch 122) — no standalone skinning BG.
    // The renderer composes the merged group 2 BG per-frame from this
    // joint buffer + morph deltas + morph weights + instance transforms.

    // Morph delta storage (1-vec4 zero), morph weight UBO (12 floats zero).
    this._defaultMorphDeltaBuffer = device.createBuffer({
      label: "default-morph-deltas",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const zeroWeights = new Float32Array(12);
    this._defaultMorphWeightBuffer = device.createBuffer({
      label: "default-morph-weights",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultMorphWeightBuffer, 0, zeroWeights);

    // Identity instance transform storage.
    // DP-H36 (Batch 325) — the per-instance element is now the 24-float / 96-byte
    // `InstanceTransform` struct (linear mat4x4 + translationHigh/Low vec4s), so
    // the placeholder buffer must be a full element. Identity = identity linear
    // matrix + zero translation. FLAG_HAS_INSTANCING gates the read, so these
    // contents are never consumed; the size just satisfies binding validation.
    // MUST stay byte-consistent with FLOATS_PER_INSTANCE in WebGPUModelInstancing.js
    // and the WGSL InstanceTransform struct in ModelPBRComplete.wgsl.
    const instanceIdentityData = new Float32Array(24);
    instanceIdentityData[0] = 1; // linear col0.x
    instanceIdentityData[5] = 1; // linear col1.y
    instanceIdentityData[10] = 1; // linear col2.z
    instanceIdentityData[15] = 1; // linear col3.w
    // floats 16..23 (translationHigh + translationLow) stay zero
    this._defaultInstancingBuffer = device.createBuffer({
      label: "default-instance-transforms",
      size: 96,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this._defaultInstancingBuffer,
      0,
      instanceIdentityData,
    );

    // NEW-BG-CONSOLIDATION (Batch 122) — merged group 2 default bind group.
    // Used when a primitive has none of skinning / morph / instancing.
    // All four resources are placeholder defaults; the shader checks
    // FLAG_HAS_SKINNING / FLAG_HAS_MORPH_TARGETS / FLAG_HAS_INSTANCING
    // before reading any of the underlying storage so the placeholder
    // contents are never consumed.
    this._defaultInstanceBG = device.createBindGroup({
      layout: this._instanceBGL,
      entries: [
        { binding: 0, resource: { buffer: this._defaultJointBuffer } },
        { binding: 1, resource: { buffer: this._defaultMorphDeltaBuffer } },
        { binding: 2, resource: { buffer: this._defaultMorphWeightBuffer } },
        { binding: 3, resource: { buffer: this._defaultInstancingBuffer } },
        // Audit A.5 (Batch 130) — prev joint matrices fall back to the
        // SAME identity buffer as binding 0 when no skinning is active.
        // Skinned primitives override with the per-node prev-frame
        // joint buffer in `buildMergedInstanceBindGroup`.
        { binding: 4, resource: { buffer: this._defaultJointBuffer } },
        // NEW-TAA-MORPH-PREV (Batch 134) -- prev morph weights default
        // to the same zero-weights buffer as binding 2.
        { binding: 5, resource: { buffer: this._defaultMorphWeightBuffer } },
        // NEW-TAA-INSTANCE-PREV (Batch 134) -- prev instance transforms
        // default to the same identity buffer as binding 3.
        { binding: 6, resource: { buffer: this._defaultInstancingBuffer } },
      ],
    });
    // Feature ID default UBO (14 floats — `featurePickEnabled = 0`).
    const zeroFeatureUniforms = new Float32Array(14);
    this._defaultFeatureUniformBuffer = device.createBuffer({
      label: "default-feature-uniforms",
      size: 56,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this._defaultFeatureUniformBuffer,
      0,
      zeroFeatureUniforms,
    );
    // NEW-BG-CONSOLIDATION (Batch 122) — feature ID resources moved into
    // the merged group 1 (bindings 26-32). The default placeholder
    // entries are exposed as a function so callers can splice them
    // into a merged group-1 bind group's `entries[]` array. There's no
    // standalone feature-ID bind group anymore; the renderer always
    // builds the merged group 1.
    this._defaultFeatureIdEntries = () => [
      { binding: 26, resource: this._defaultWhiteTexture.createView() },
      { binding: 27, resource: this._defaultSampler },
      { binding: 28, resource: this._defaultWhiteTexture.createView() },
      { binding: 29, resource: this._defaultSampler },
      {
        binding: 30,
        resource: { buffer: this._defaultFeatureUniformBuffer },
      },
      { binding: 31, resource: this._defaultWhiteTexture.createView() },
      { binding: 32, resource: this._defaultSampler },
    ];
  }

  /**
   * Batch 174 — Normalize a caller-supplied `materialDefines` value
   * down to just the model-material gating bits this cache understands.
   * Defends against callers passing other ShaderDefine bits (e.g. a
   * primitive-pipeline-level `SPLIT_ENABLED` or `GEODETIC_NORMAL`)
   * that would inflate the cache key without affecting the layout.
   *
   * @param {number} materialDefines
   * @returns {number}
   * @private
   */
  _normalizeMaterialDefines(materialDefines: number) {
    return ((materialDefines | 0) & MATERIAL_DEFINE_MASK) >>> 0;
  }

  /**
   * Batch 174 — Lazy per-variant materialBGL builder. Keyed by the
   * normalized `materialDefines` mask so each unique combination of
   * KHR-extension gates produces exactly one BGL per device.
   *
   * Public API: callers (renderer + bind-group construction) should
   * use `getOrCreateMaterialBGL` and `getOrCreatePipelineLayout`
   * rather than the legacy `materialBGL` / `pipelineLayout` getters,
   * which are retained for backward compatibility and now delegate
   * through the per-variant cache.
   *
   * @param {number} materialDefines
   * @returns {GPUBindGroupLayout}
   * @private
   */
  _getOrCreateMaterialBGL(materialDefines: number) {
    const key = this._normalizeMaterialDefines(materialDefines);
    let layout = this._materialBGLCache.get(key);
    if (layout) {
      return layout;
    }
    layout = buildMaterialBGL(this._device, key);
    this._materialBGLCache.set(key, layout);
    return layout;
  }

  /**
   * Batch 174 — Lazy per-variant pipeline-layout builder. Composes the
   * (camera, materialBGL[variant], instance, effects) tuple into a
   * `GPUPipelineLayout` and caches by `materialDefines`.
   *
   * @param {number} materialDefines
   * @returns {GPUPipelineLayout}
   * @private
   */
  _getOrCreatePipelineLayout(materialDefines: number) {
    const key = this._normalizeMaterialDefines(materialDefines);
    let layout = this._pipelineLayoutCache.get(key);
    if (layout) {
      return layout;
    }
    const variantHex = `0x${key.toString(16)}`;
    layout = this._device.createPipelineLayout({
      label: `Model PBR PipelineLayout [defines=${variantHex}]`,
      bindGroupLayouts: [
        this._cameraBGL, // group 0
        this._getOrCreateMaterialBGL(key), // group 1 (per-variant)
        this._instanceBGL, // group 2
        this._effectsBGL, // group 3
      ],
    });
    this._pipelineLayoutCache.set(key, layout);
    return layout;
  }

  /**
   * Batch 174 — Lazy per-variant shader-module fetcher. Routes through
   * the per-device shader-module cache (Batch 162's
   * `WebGPUShaderModuleCache`) so two `Model` instances with the same
   * `materialDefines` share one compiled `GPUShaderModule`. The
   * preprocessor strips the WGSL declarations + sampling sites whose
   * gate define isn't set in `materialDefines`, so the binary itself
   * differs per variant.
   *
   * @param {number} materialDefines
   * @param {boolean} [pickLogOverride] NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11)
   *   — when supplied, the LOG_DEPTH module bit follows THIS value instead of
   *   the scene `_logDepthEnabled`. The pick pipelines pass
   *   `this._pickLogDepthEnabled` so their module's log state is gated by the
   *   SEPARATE pick-fleet switch (INV-2). Omitted (undefined) for every color /
   *   velocity / classification / capture / silhouette caller → the LOG_DEPTH
   *   bit keeps following `_logDepthEnabled` exactly as before (byte-identical).
   * @returns {GPUShaderModule}
   * @private
   */
  /**
   * C11-157 Slice C — the color-shader composition (effective defines +
   * generated chunks + full source + cache keys), extracted verbatim from
   * `_getOrCreateShaderModule` so BOTH the module build AND `getOITColorConfig`
   * (the OIT accumulation variant) derive a byte-identical `fullSource` +
   * `effectiveDefines` for a given `materialDefines` + per-cache render-mode
   * state. Pure — no module creation, no cache mutation. (`_getOrCreateShaderModule`
   * still short-circuits on a module-cache hit; this composes unconditionally,
   * a negligible string cost on the rare pipeline-miss path.)
   * @private
   */
  _composeColorSource(materialDefines: number, pickLogOverride?: boolean) {
    const key = this._normalizeMaterialDefines(materialDefines);
    // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — the module
    // (NOT the BGL/pipeline-layout, whose bindings don't change) forks on
    // the LOG_DEPTH bit. `_logDepthEnabled` mirrors
    // isWebGPULogDepthActive() via maybeUpdateForLogDepth() each frame.
    //
    // C2-25 (Batch 447) — CAPTURE_MODE is a render-mode bit like LOG_DEPTH,
    // intentionally OUTSIDE MATERIAL_DEFINE_MASK, so `_normalizeMaterialDefines`
    // above strips it. Preserve it from the raw arg here so the env scene-capture
    // single-target FragOutput variant (drops `@location(1) normalRoughness`)
    // actually compiles — otherwise the capture pipeline gets the 2-MRT module
    // and createCapturePipeline's single color target fails WebGPU validation.
    // On-screen callers never set CAPTURE_MODE, so their module hash is unchanged.
    const captureBit = (materialDefines & ShaderDefine.CAPTURE_MODE) >>> 0;
    // DP-H46e — METADATA_PICKING_ENABLED is a render-MODE bit (like CAPTURE_MODE
    // / LOG_DEPTH) intentionally OUTSIDE MATERIAL_DEFINE_MASK, so the
    // `_normalizeMaterialDefines` above strips it. Preserve it from the raw arg
    // so the metadata-pick pipeline gets a module that compiles
    // `fragmentPickMetadataMain` + the GENERATED `metadataPickingStage`. On-screen
    // / display / regular-pick callers never set it → their module hash unchanged.
    const metadataPickBit =
      (materialDefines & ShaderDefine.METADATA_PICKING_ENABLED) >>> 0;
    // WIRE-MODEL-SPLITTER — MODEL_SPLIT_ENABLED is a render-mode bit like
    // LOG_DEPTH (per-cache flag, no BGL/layout change). `_splitEnabled`
    // mirrors `model.splitDirection !== NONE` via maybeUpdateForSplit().
    const splitBit = this._splitEnabled ? ShaderDefine.MODEL_SPLIT_ENABLED : 0;
    // WIRE-MODEL-COLOR — MODEL_HAS_COLOR is a render-mode bit like
    // MODEL_SPLIT_ENABLED (per-cache flag, no BGL/layout change).
    // `_modelColorEnabled` mirrors `defined(model.color)` via
    // maybeUpdateForModelColor().
    const modelColorBit = this._modelColorEnabled
      ? ShaderDefine.MODEL_HAS_COLOR
      : 0;
    // WIRE-MODEL-SILHOUETTE — MODEL_SILHOUETTE is a render-mode bit like
    // MODEL_HAS_COLOR (per-cache flag, no BGL/layout change).
    // `_silhouetteEnabled` mirrors the WebGL `Model.hasSilhouette()`
    // predicate via maybeUpdateForSilhouette().
    const silhouetteBit = this._silhouetteEnabled
      ? ShaderDefine.MODEL_SILHOUETTE
      : 0;
    // NEW-MODEL-METADATA-MAT3-MAT4 — the widened MAT3/MAT4 attribute
    // transport is sticky per-primitive state (like the topology / metadata
    // chunk), NOT a materialDefines bit: bit 30 would overflow computeKey's
    // `md << 3` pipeline-key packing. Gated on MODEL_HAS_METADATA so the bit
    // can never leak into a texture-/table-only module (whose call sites use
    // the 4-arg initializeMetadata signature).
    const metadataMatBit =
      this._metadataMatTransport === true &&
      (key & ShaderDefine.MODEL_HAS_METADATA) !== 0
        ? ShaderDefine.MODEL_METADATA_MAT_TRANSPORT
        : 0;
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — a PICK caller passes
    // `pickLogOverride` so its module's LOG_DEPTH bit follows the SEPARATE
    // pick-fleet switch, decoupled from the scene `_logDepthEnabled`. Nullish
    // coalescing (not `||`) so an explicit `false` (pick off, scene on) CLEARS
    // the bit; `undefined` (every non-pick caller) falls through to the scene
    // switch → byte-identical. Because this bit is part of `effectiveDefines`,
    // the per-cache `moduleKey` + the device Tier-1 cache key already
    // distinguish the pick-off variant from the scene-on color module (distinct
    // modules when scene-on/pick-off; deduped when both agree).
    const logDepthActiveForModule = pickLogOverride ?? this._logDepthEnabled;
    const effectiveDefines =
      (key |
        captureBit |
        metadataPickBit |
        splitBit |
        modelColorBit |
        silhouetteBit |
        metadataMatBit |
        (logDepthActiveForModule ? ShaderDefine.LOG_DEPTH : 0)) >>>
      0;
    // DP-H46b/c — the generated metadata chunk is class-dependent, so when
    // MODEL_HAS_METADATA (property attributes) OR MODEL_HAS_PROPERTY_TEXTURES
    // (DP-H46c) is set the module varies by `_metadataClassHash` (a
    // fingerprint of the generated WGSL — which folds in the property-texture
    // binding numbers too) in addition to `effectiveDefines`. Key the
    // per-cache map (and, below, the device-level Tier-1 cache) by a STRING
    // composite ONLY in that case; non-metadata modules keep the numeric
    // `effectiveDefines` key → byte-identical to the pre-metadata path (same
    // module hash + cache key for plain glTF). The renderer sets
    // `_metadataWGSL` + `_metadataClassHash` immediately before the metadata
    // `getPipeline*` call and clears them for non-metadata primitives.
    const hasMetadata =
      (effectiveDefines &
        (ShaderDefine.MODEL_HAS_METADATA |
          ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES |
          ShaderDefine.MODEL_HAS_PROPERTY_TABLES)) !==
      0;
    // DP-H46e — when the metadata-pick bit is set, the prepended chunk is the
    // PICK chunk (display chunk + the appended `metadataPickingStage`) and the
    // class hash folds in the picked property — so the pick module is cached
    // distinctly from the display module AND per picked property. Otherwise the
    // display chunk + class hash apply (DP-H46b/c/d, unchanged).
    const isMetadataPick = metadataPickBit !== 0 && hasMetadata;
    const metadataClassHash = !hasMetadata
      ? 0
      : isMetadataPick
        ? this._metadataPickClassHash >>> 0
        : this._metadataClassHash >>> 0;
    // PARITY-CUSTOM-SHADER-WGSL — the generated customShader chunk is
    // model-dependent (uniforms + inlined user body), so when
    // MODEL_HAS_WGSL_CUSTOM_SHADER (fragment) OR _VERTEX is set the module varies
    // by `_customShaderClassHash` too. Non-customShader modules keep
    // `customShaderClassHash === 0` → their key is unchanged (parity).
    const hasCustomShader =
      (effectiveDefines &
        (ShaderDefine.MODEL_HAS_WGSL_CUSTOM_SHADER |
          ShaderDefine.MODEL_HAS_WGSL_CUSTOM_VERTEX)) !==
      0;
    const customShaderClassHash = !hasCustomShader
      ? 0
      : this._customShaderClassHash >>> 0;
    const moduleKey =
      metadataClassHash === 0 && customShaderClassHash === 0
        ? effectiveDefines
        : `${effectiveDefines}#${metadataClassHash}#${customShaderClassHash}`;
    const variantHex = `0x${effectiveDefines.toString(16)}`;
    // Slice 5d Batch 153 — prepend the ClusteredLighting chunk so the
    // Model PBR shader has @group(3) bindings 18..22 declared + the
    // evalClusteredLights() function defined. The chunk declares the
    // bindings unconditionally; the effects bind group (extended in
    // Batch 153 to include slots 18..22) supplies either placeholder
    // buffers or the dispatcher's live buffers, and the FS chunk gates
    // its evaluation on `clusterParams.activeLightCount.x`.
    const clChunk = substituteClusteredLightingGroup(ClusteredLightingChunk, 3);
    // DP-H46b — metadata WGSL injection seam. `MetadataWGSLPipelineStage`
    // stashes the generated chunk (the real `struct Metadata` +
    // `initializeMetadata` + `metadataDebugScalar`, named after the real
    // metadata class with offset/scale baked) on the cache via
    // `setMetadataWGSL`; it is prepended here at the SAME single injection
    // point — the same fork pattern as `clChunk` / CAPTURE_MODE — and
    // SUPERSEDES the (now-removed) DP-H46a stub: `ModelPBRComplete.wgsl`
    // keeps only the `//>>ifdef MODEL_HAS_METADATA` CALL SITE.
    //   • metadata primitive:    `metadataChunk` is the generated string →
    //     `fullSource` declares the real struct, the gated call site uses it.
    //   • non-metadata primitive: `_metadataWGSL` is "" (the renderer clears
    //     it before the call) AND the bit is clear → the prepend is empty AND
    //     the ifdef call site is stripped → `fullSource` is
    //     character-for-character identical to the pre-metadata path.
    // The class hash (`metadataClassHash`) is passed as the device-level
    // cache's `keySalt` ONLY when the bit is set, so two metadata classes
    // sharing `(sourceId, defines)` get distinct compiled modules (no
    // aliasing); for non-metadata callers `keySalt === 0` → the device cache
    // key is unchanged.
    const metadataChunk = !hasMetadata
      ? ""
      : isMetadataPick
        ? (this._metadataPickWGSL ?? this._metadataWGSL ?? "")
        : (this._metadataWGSL ?? "");
    // PARITY-CUSTOM-SHADER-WGSL — prepend the generated customShader chunk at the
    // SAME injection point, after the metadata chunk. Empty (and the gated call
    // sites stripped) for non-customShader models → byte-identical source.
    const customShaderChunk = !hasCustomShader
      ? ""
      : (this._customShaderWGSL ?? "");
    // WIRE-MODEL-SILHOUETTE — prepend the inflate/colour helper chunk at
    // the SAME injection point when the bit is active. Empty (and the
    // gated call sites stripped) for non-silhouette models →
    // byte-identical source.
    const silhouetteChunk =
      silhouetteBit !== 0 ? `${ModelSilhouetteStageWGSL}\n` : "";
    const fullSource = `${clChunk}\n${silhouetteChunk}${metadataChunk}${customShaderChunk}${ModelPBRCompleteWGSL}`;
    // The device-level Tier-1 cache keys by (sourceId, defines, keySalt). Fold
    // BOTH the metadata + customShader class hashes into one salt so two models
    // sharing (sourceId, defines) but differing in either generated chunk get
    // distinct compiled modules. Zero for the plain path → device key unchanged.
    const keySalt =
      customShaderClassHash === 0
        ? metadataClassHash
        : (metadataClassHash ^ customShaderClassHash) >>> 0;
    return {
      fullSource,
      effectiveDefines,
      moduleKey,
      keySalt,
      variantHex,
      metadataClassHash,
      customShaderClassHash,
    };
  }

  _getOrCreateShaderModule(materialDefines: number, pickLogOverride?: boolean) {
    //>>includeStart('debug', pragmas.debug);
    // C2-22 — test hook: when `globalThis.CesiumWebGPUForcePipelineError` is set,
    // return a deliberately-invalid module (no entry points, garbage WGSL) so the
    // downstream createRenderPipeline fails validation and the magenta error
    // pipeline can be verified. Called inside getPipeline's error scope.
    if (
      (globalThis as { CesiumWebGPUForcePipelineError?: boolean })
        .CesiumWebGPUForcePipelineError === true
    ) {
      return this._device.createShaderModule({
        label: "Model PBR FORCED-ERROR (C2-22 probe)",
        code: "garbage_token_not_valid_wgsl",
      });
    }
    //>>includeEnd('debug');
    const composed = this._composeColorSource(materialDefines, pickLogOverride);
    let module = this._shaderModuleCache.get(composed.moduleKey);
    if (module) {
      return module;
    }
    // The Tier-1 cache retains the complete Uint32 `effectiveDefines`, so
    // render-mode bits 26-30 require no salt. `keySalt` now has one job only:
    // fingerprint the dynamically generated metadata/custom-shader source.
    module = getModelShaderModuleCache(this._device).getOrCreate(
      ShaderSourceId.MODEL_PBR_COMPLETE,
      composed.fullSource,
      composed.effectiveDefines,
      `Model PBR ShaderModule [defines=${composed.variantHex}${
        composed.metadataClassHash !== 0
          ? ` meta=0x${composed.metadataClassHash.toString(16)}`
          : ""
      }${
        composed.customShaderClassHash !== 0
          ? ` cs=0x${composed.customShaderClassHash.toString(16)}`
          : ""
      }]`,
      composed.keySalt,
    );
    this._shaderModuleCache.set(composed.moduleKey, module);
    return module;
  }

  /**
   * C11-157 Slice C — build the OIT accumulation variant inputs for a
   * translucent model color/twin command: the non-LOG_DEPTH preprocessed color
   * source (`_shaderCode`) + a `_pipelineConfig` reusing the base color
   * pipeline's SHARED layout + vertex layout + primitive/depth state
   * (single-sample to match the single-sample OIT accumulation targets). The
   * renderer attaches these to a `Pass.TRANSLUCENT` model command so
   * `executeTranslucentPass` auto-builds the MRT accumulation pipeline under the
   * FAR-003 gate; read ONLY when the gate is on → gate-OFF byte-identical. The
   * model FS returns a `FragOutput` struct (@location(0) color) → the
   * `injectOITOutput` struct branch handles it. Returns null defensively when
   * the composed source is empty (e.g. the C2-22 forced-error test hook).
   */
  getOITColorConfig(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ): { shaderCode: string; pipelineConfig: WebGPUPipelineConfig } | null {
    const md = this._normalizeMaterialDefines(materialDefines);
    const composed = this._composeColorSource(materialDefines);
    if (!composed.fullSource) {
      return null;
    }
    // OIT runs in a depth-read-only pass; strip LOG_DEPTH so the FragOutput's
    // `@builtin(frag_depth)` member is gone (leaving the plain @location(0)/(1)
    // struct the injector's struct branch transforms).
    const shaderCode = preprocessShaderSource(
      composed.fullSource,
      (composed.effectiveDefines & ~ShaderDefine.LOG_DEPTH) >>> 0,
    );
    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    const metadataSlotMode = this._metadataSlotMode(md);
    // Reuse the EXACT color-pipeline descriptor so the OIT variant's layout +
    // vertex layout + primitive/depth match the base pipeline the command's
    // bind groups + vertex buffers were built against. The shaderModule arg is
    // discarded here (createOITPipeline compiles its own module from shaderCode).
    const raw = buildColorPipelineDescriptor(
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      false,
      hasTexCoord1,
      hasFeatureId0,
      this._sampleCount,
      metadataSlotMode,
      this._primitiveTopology,
    );
    return {
      shaderCode,
      pipelineConfig: {
        label: `OIT Model [${composed.variantHex}]`,
        layout: raw.layout as GPUPipelineLayout,
        vertexBuffers: raw.vertex.buffers as GPUVertexBufferLayout[],
        vertexEntryPoint: "vertexMain",
        fragmentEntryPoint: "fragmentMain",
        primitive: raw.primitive as GPUPrimitiveState,
        depthStencil: raw.depthStencil as GPUDepthStencilState,
        multisample: undefined,
      },
    };
  }

  /**
   * DP-H46b — set the generated metadata WGSL chunk + its class hash for the
   * NEXT `getPipeline*` call. The renderer calls this immediately before
   * (re)building a metadata primitive's pipelines so
   * `_getOrCreateShaderModule` prepends the right chunk and keys the module by
   * the right class. Idempotent; the chunk is consumed by every variant
   * (color / pick / depth-write / velocity / classification) built for that
   * primitive in the same pass.
   *
   * @param {string} wgsl the generated metadata chunk
   * @param {number} classHash a stable fingerprint of the generated chunk
   * @param {boolean} [matTransport=false] NEW-MODEL-METADATA-MAT3-MAT4 —
   *   true when the chunk was generated with the widened four-vec4 MAT3/MAT4
   *   transport (the codegen's `matTransport` result). Drives the
   *   `MODEL_METADATA_MAT_TRANSPORT` preprocess bit, the widened slot-9
   *   vertex layout (mode 2), and the `:m34` pipeline-key suffix.
   * @private
   */
  setMetadataWGSL(wgsl: string, classHash: number, matTransport?: boolean) {
    this._metadataWGSL = wgsl ?? "";
    this._metadataClassHash = (classHash | 0) >>> 0;
    this._metadataMatTransport = matTransport === true;
  }

  /**
   * DP-H46b — clear the generated metadata WGSL so a subsequent non-metadata
   * primitive (sharing this per-Model cache) can't inherit a stale chunk. The
   * MODEL_HAS_METADATA bit gates whether the chunk is prepended at all, so
   * this is belt-and-suspenders, but it keeps `_metadataClassHash` from
   * leaking into a metadata primitive of a DIFFERENT class that forgot to set
   * it. Resets to the byte-identical non-metadata defaults.
   *
   * @private
   */
  clearMetadataWGSL() {
    this._metadataWGSL = "";
    this._metadataClassHash = 0;
    this._metadataMatTransport = false;
  }

  /**
   * NEW-MODEL-METADATA-MAT3-MAT4 — the slot-9 metadata vertex-layout mode for
   * a normalized materialDefines mask: 0 = no metadata slot, 1 = historical
   * single float32x4 (location 9), 2 = widened MAT3/MAT4 transport (stride 64,
   * locations 9-12). Mode 2 engages only when the sticky per-primitive
   * `metadataMatTransport` state (set via {@link setMetadataWGSL}) is true AND
   * the mask carries MODEL_HAS_METADATA — mirroring the module-side
   * `metadataMatBit` gate exactly so layout and compiled module always agree.
   *
   * @param {number} md normalized materialDefines
   * @returns {number} 0 | 1 | 2
   * @private
   */
  _metadataSlotMode(md: number) {
    if ((md & ShaderDefine.MODEL_HAS_METADATA) === 0) {
      return 0;
    }
    return this._metadataMatTransport === true ? 2 : 1;
  }

  /**
   * NEW-MODEL-METADATA-MAT3-MAT4 — appends the `:m34` discriminator to a
   * pipeline-map key when the widened MAT3/MAT4 transport is active, so a
   * MAT-transport primitive and a plain-metadata primitive sharing the same
   * `(alphaMode, doubleSided, materialDefines)` identity in one per-model
   * cache build distinct pipelines (their vertex layouts + modules differ).
   * Off path returns the key UNCHANGED — byte-identical cache behaviour for
   * every non-MAT-transport primitive.
   *
   * @param {number|string} key base pipeline cache key
   * @param {number} md normalized materialDefines
   * @returns {number|string}
   * @private
   */
  _metadataVariantKey(key: number | string, md: number): number | string {
    return this._metadataSlotMode(md) === 2 ? `${key}:m34` : key;
  }

  /**
   * DP-H46e — set the generated metadata-PICK chunk + its (property-folded) hash
   * for the NEXT metadata-pick `getPickMetadataPipeline` call. The chunk is the
   * display chunk PLUS the appended `fn metadataPickingStage(metadata) ->
   * vec4<f32>` for the currently-picked property (built by
   * `MetadataWGSLPipelineStage.generateMetadataPickWGSL`).
   *
   * @param {string} wgsl the generated metadata-pick chunk
   * @param {number} classHash a stable fingerprint folding in the picked property
   * @private
   */
  setMetadataPickWGSL(wgsl: string, classHash: number) {
    this._metadataPickWGSL = wgsl ?? "";
    this._metadataPickClassHash = (classHash | 0) >>> 0;
  }

  /**
   * DP-H46e — clear the generated metadata-pick chunk so a later non-pick build
   * can't inherit a stale chunk. The METADATA_PICKING_ENABLED bit gates whether
   * the pick chunk is consumed at all, so this is belt-and-suspenders.
   *
   * @private
   */
  clearMetadataPickWGSL() {
    this._metadataPickWGSL = "";
    this._metadataPickClassHash = 0;
  }

  /**
   * PARITY-CUSTOM-SHADER-WGSL — set the generated customShader WGSL chunk + its
   * class hash for the NEXT `getPipeline*` call. The renderer calls this
   * immediately before (re)building a customShader model's pipelines so
   * `_getOrCreateShaderModule` prepends the right chunk and keys the module by
   * the right customShader class.
   *
   * @param {string} wgsl the generated customShader chunk
   * @param {number} classHash a stable fingerprint of the generated chunk
   * @private
   */
  setCustomShaderWGSL(wgsl: string, classHash: number) {
    this._customShaderWGSL = wgsl ?? "";
    this._customShaderClassHash = (classHash | 0) >>> 0;
  }

  /**
   * PARITY-CUSTOM-SHADER-WGSL — clear the generated customShader WGSL so a
   * subsequent non-customShader primitive (sharing this per-Model cache) can't
   * inherit a stale chunk. The MODEL_HAS_WGSL_CUSTOM_SHADER bit gates whether the
   * chunk is prepended at all, so this is belt-and-suspenders.
   *
   * @private
   */
  clearCustomShaderWGSL() {
    this._customShaderWGSL = "";
    this._customShaderClassHash = 0;
  }

  /**
   * GLTF-POINTS-MODE — set the GPUPrimitiveTopology for the primitive whose
   * pipeline is about to be (re)built. Same sticky-state contract as
   * `setMetadataWGSL` / `setCustomShaderWGSL`: the renderer writes it
   * immediately before each primitive's `getPipeline*` calls (via
   * `applyPrimitiveMetadataToPipelineCache`), and passing anything other
   * than a known non-triangle topology resets to the "triangle-list"
   * default so a stale point-list can't leak into a triangle primitive.
   *
   * Today only "point-list" (glTF mode-0 POINTS) is supported beyond the
   * default; LINES / LINE_STRIP / TRIANGLE_STRIP remain deferred (strip
   * topologies additionally need `stripIndexFormat` plumbing).
   *
   * @param {string} topology GPUPrimitiveTopology
   */
  setPrimitiveTopology(topology: string) {
    this._primitiveTopology =
      topology === "point-list" ? "point-list" : "triangle-list";
  }

  /**
   * Public accessor for the per-variant materialBGL. Renderer call
   * sites should pass the primitive's normalized `materialDefines`
   * (computed from its material flags). The eagerly-built basic
   * (`materialDefines = 0`) and full (`materialDefines =
   * MODEL_HAS_KHR_TEXTURES`) variants are returned without an
   * additional Map lookup; arbitrary subsets are built on demand.
   *
   * @param {number} materialDefines
   * @returns {GPUBindGroupLayout}
   */
  getOrCreateMaterialBGL(materialDefines: number) {
    return this._getOrCreateMaterialBGL(materialDefines);
  }

  /**
   * Public accessor for the per-variant pipeline layout. See
   * {@link WebGPUModelPipelineCache#getOrCreateMaterialBGL}.
   *
   * @param {number} materialDefines
   * @returns {GPUPipelineLayout}
   */
  getOrCreatePipelineLayout(materialDefines: number) {
    return this._getOrCreatePipelineLayout(materialDefines);
  }

  /**
   * Batch 110 — invalidate cached pipelines when the scene pipeline
   * format generation has changed (HDR toggle, MSAA toggle). Updates
   * `_presentationFormat` to the new scene-pipeline format so newly
   * created pipelines target the right fragment-output format.
   *
   * Caller (model renderer's update) invokes this once per frame
   * before any `getPipeline` / `getPickPipeline` / `getVelocityPipeline`
   * lookup. Cheap reference compare; only the first frame after a
   * format change pays for the cache wipe.
   *
   * @param {object} context WebGPUContext
   */
  /**
   * Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — mirror the
   * master switch each frame. When the flag flips, wipe every pipeline
   * map (the cached pipelines reference modules compiled with the wrong
   * LOG_DEPTH state) and refresh the eagerly-built module fields. Cheap
   * boolean compare on the steady path; the wipe only fires on a flip.
   *
   * @param {boolean} active isWebGPULogDepthActive(context, frameState)
   * @returns {boolean} true when the flag flipped this call (callers use
   *   this to drop per-primitive direct pipeline references, mirroring
   *   the scene-format-generation invalidation).
   */
  maybeUpdateForLogDepth(active: boolean) {
    const enabled = active === true;
    if (this._logDepthEnabled === enabled) {
      return false;
    }
    this._logDepthEnabled = enabled;
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // WIRE-MODEL-SILHOUETTE — silhouette variants bake the same module /
    // format / sample-count state as the colour pipeline; wipe together.
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    // DP-H46e — metadata-pick pipelines bake the depth format / sample count too.
    this._pickMetadataPipelines.clear();
    // Refresh the eager compatibility module fields so legacy callers
    // never see a stale-variant module after a flip.
    this._shaderModule_basic = this._getOrCreateShaderModule(0);
    this._shaderModule = this._getOrCreateShaderModule(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    return true;
  }

  /**
   * NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — mirror the SEPARATE pick-fleet
   * master switch (`context._pickLogDepthWriteEnabled`) each frame. Structurally
   * the maybeUpdateForLogDepth pattern, but scoped to the PICK pipelines only:
   *
   *   - Wipes ONLY the pick pipeline maps (`_pickPipelines`, `_pickHoverPipelines`,
   *     `_pickMetadataPipelines`, and the two BLEND precise-pass maps whose
   *     pipelines reuse `fragmentPickMain`). Those cached pipelines reference a
   *     module compiled with the wrong pick-log state, so a flip must rebuild
   *     them — the module cache serves the correct variant because the LOG_DEPTH
   *     bit is now part of `effectiveDefines` (via the `pickLogOverride` arg).
   *   - Does NOT touch the color / velocity / classification / capture /
   *     silhouette maps, nor the eager `_shaderModule*` fields — those follow the
   *     scene `_logDepthEnabled` and are unaffected by the pick switch.
   *
   * With the switch OFF (default) the pick modules carry no LOG_DEPTH define and
   * the pick pipelines are byte-identical hyperbolic; a flip to true is C10-11's
   * coordinated fleet conversion.
   *
   * @param {boolean} active isWebGPUPickLogDepthActive(context, frameState)
   * @returns {boolean} true when the flag flipped this call (the renderer uses
   *   this to drop per-primitive direct pick-pipeline references).
   */
  maybeUpdateForPickLogDepth(active: boolean) {
    const enabled = active === true;
    if (this._pickLogDepthEnabled === enabled) {
      return false;
    }
    this._pickLogDepthEnabled = enabled;
    this._pickPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickMetadataPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    return true;
  }

  /**
   * WIRE-MODEL-SPLITTER — mirror `model.splitDirection !== NONE` each
   * frame (the maybeUpdateForLogDepth pattern). When the flag flips, wipe
   * every pipeline map (cached pipelines reference modules compiled with
   * the wrong MODEL_SPLIT_ENABLED state) and refresh the eagerly-built
   * module fields. Cheap boolean compare on the steady path.
   *
   * @param {boolean} active model.splitDirection !== SplitDirection.NONE
   * @returns {boolean} true when the flag flipped this call (callers use
   *   this to drop per-primitive direct pipeline references, mirroring
   *   the scene-format-generation invalidation).
   */
  maybeUpdateForSplit(active: boolean) {
    const enabled = active === true;
    if (this._splitEnabled === enabled) {
      return false;
    }
    this._splitEnabled = enabled;
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // WIRE-MODEL-SILHOUETTE — silhouette variants bake the same module /
    // format / sample-count state as the colour pipeline; wipe together.
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    this._pickMetadataPipelines.clear();
    // Refresh the eager compatibility module fields so legacy callers
    // never see a stale-variant module after a flip.
    this._shaderModule_basic = this._getOrCreateShaderModule(0);
    this._shaderModule = this._getOrCreateShaderModule(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    return true;
  }

  /**
   * WIRE-MODEL-COLOR — mirror `defined(model.color)` each frame (the
   * maybeUpdateForSplit pattern). When the flag flips, wipe every pipeline
   * map (cached pipelines reference modules compiled with the wrong
   * MODEL_HAS_COLOR state) and refresh the eagerly-built module fields.
   * Cheap boolean compare on the steady path.
   *
   * @param {boolean} active defined(model.color)
   * @returns {boolean} true when the flag flipped this call (callers use
   *   this to drop per-primitive direct pipeline references, mirroring
   *   the scene-format-generation invalidation).
   */
  maybeUpdateForModelColor(active: boolean) {
    const enabled = active === true;
    if (this._modelColorEnabled === enabled) {
      return false;
    }
    this._modelColorEnabled = enabled;
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // WIRE-MODEL-SILHOUETTE — silhouette variants bake the same module /
    // format / sample-count state as the colour pipeline; wipe together.
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    this._pickMetadataPipelines.clear();
    // Refresh the eager compatibility module fields so legacy callers
    // never see a stale-variant module after a flip.
    this._shaderModule_basic = this._getOrCreateShaderModule(0);
    this._shaderModule = this._getOrCreateShaderModule(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    return true;
  }

  /**
   * WIRE-MODEL-SILHOUETTE — mirror the WebGL `Model.hasSilhouette()`
   * predicate each frame (the maybeUpdateForModelColor pattern). When the
   * flag flips, wipe every pipeline map (cached pipelines reference
   * modules compiled with the wrong MODEL_SILHOUETTE state) and refresh
   * the eagerly-built module fields. Cheap boolean compare on the steady
   * path.
   *
   * @param {boolean} active silhouetteSize > 0 && silhouetteColor.alpha > 0
   *   && !defined(model.classificationType)
   * @returns {boolean} true when the flag flipped this call (callers use
   *   this to drop per-primitive direct pipeline references, mirroring
   *   the scene-format-generation invalidation).
   */
  maybeUpdateForSilhouette(active: boolean) {
    const enabled = active === true;
    if (this._silhouetteEnabled === enabled) {
      return false;
    }
    this._silhouetteEnabled = enabled;
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    this._pickMetadataPipelines.clear();
    // Refresh the eager compatibility module fields so legacy callers
    // never see a stale-variant module after a flip.
    this._shaderModule_basic = this._getOrCreateShaderModule(0);
    this._shaderModule = this._getOrCreateShaderModule(
      ShaderDefine.MODEL_HAS_KHR_TEXTURES,
    );
    return true;
  }

  maybeUpdateForSceneFormat(context: SceneFormatContext) {
    const generation = context._scenePipelineFormatGeneration ?? 0;
    if (this._sceneFormatGeneration === generation) {
      return;
    }
    this._sceneFormatGeneration = generation;
    const newFormat = context.scenePipelineFormat ?? this._presentationFormat;
    if (newFormat !== this._presentationFormat) {
      this._presentationFormat = newFormat;
    }
    // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — mirror the context's pick-format
    // authority alongside the scene format; the wipe below drops every
    // pick-family pipeline built against the previous format.
    this._pickFormat =
      context.pickPipelineFormat ?? clampToPickFormat(newFormat);
    // Session 65 Batch 28 — read the current MSAA sample count so
    // newly-created pipelines bake the matching multisample state.
    // The wipe below covers the previous-generation pipelines that
    // had the old sample count baked in.
    this._sampleCount = context._msaaSamples ?? 1;
    // Wipe all cached pipelines so the next lookup creates fresh
    // entries against the current `_presentationFormat`. The cached
    // pipelines themselves aren't `destroy()`-ed (WebGPU has no
    // pipeline destroy) — releasing the Map references is enough
    // for the JS GC to collect them once any in-flight commands
    // referencing them complete.
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // WIRE-MODEL-SILHOUETTE — silhouette variants bake the same module /
    // format / sample-count state as the colour pipeline; wipe together.
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    // Batch 192 — second-slice pick pipelines also wipe on format change.
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    // DP-H46e — metadata-pick pipelines bake the presentation format too.
    this._pickMetadataPipelines.clear();
  }

  /**
   * Gets or creates a pipeline for the given material configuration.
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] Batch 174 — bitmask of
   *   ShaderDefine bits gating which KHR bindings the variant uses.
   *   `0` builds the basic variant (no KHR textures, fits the WebGPU
   *   spec floor); `MODEL_HAS_KHR_TEXTURES` builds the historical full
   *   variant (all KHR bindings present). Future per-extension subsets
   *   build a minimal layout on demand. The renderer computes this
   *   from the primitive's material flags.
   * @returns {GPURenderPipeline | null} the pipeline, or `null` when a central
   *   cache is present and the variant is still compiling asynchronously
   *   (C10-07 ready-gate — the caller SKIPS the draw for the cooking frame and
   *   the per-frame refetch guard re-polls; the draw appears within ≤1 frame of
   *   the compile landing). Returns non-null synchronously on a cache hit or on
   *   the no-central-cache fallback path.
   */
  getPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ): GPURenderPipeline | null {
    const md = this._normalizeMaterialDefines(materialDefines);
    // GLTF-POINTS-MODE — snapshot the sticky topology at entry so the async
    // callback below can't read a later primitive's value.
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    const cached = this._pipelines.get(key);
    if (cached) {
      return cached;
    }

    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    // DP-H46a — metadata vertex slot 9 variant (mode 2 = widened MAT3/MAT4
    // transport, NEW-MODEL-METADATA-MAT3-MAT4).
    const metadataSlotMode = this._metadataSlotMode(md);
    // C10-07 — shared descriptor for both the async and sync paths so a
    // cooking-frame async compile and the fallback build are byte-identical
    // (INV-07-4). Pick/velocity/classification/capture/silhouette/depth-write
    // keep their own synchronous builders (documented must-render hatch).
    const raw = buildColorPipelineDescriptor(
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      false,
      hasTexCoord1,
      hasFeatureId0,
      this._sampleCount,
      metadataSlotMode,
      topology,
    );

    const central = this._centralPipelineCache;
    if (central) {
      // C10-07-ASYNC-MODEL-PIPELINES — resolve the on-screen COLOR pipeline
      // through the central `createRenderPipelineAsync` path, exactly like the
      // globe's `resolveGlobePipelineEntry`. `name` carries the full variant
      // key so the central cache dedupes per
      // (alphaMode, doubleSided, materialDefines, topology, metadataSlot); the
      // format/sampleCount/vertex-layout fields feed the central key too, so a
      // scene-format change materializes a distinct entry (no collision).
      const centralDesc: WebGPURenderPipelineDescriptor = {
        name: `${raw.label}|${key}`,
        layout: raw.layout as GPUPipelineLayout,
        vertex: raw.vertex as WebGPURenderPipelineDescriptor["vertex"],
        fragment: raw.fragment as WebGPURenderPipelineDescriptor["fragment"],
        primitive: raw.primitive,
        depthStencil: raw.depthStencil,
        multisample: raw.multisample,
      };
      const sync = central.getPipelineSync(centralDesc);
      if (sync) {
        this._pipelines.set(key, sync);
        this._pendingColorPipelines.delete(key);
        return sync;
      }
      if (!this._pendingColorPipelines.has(key)) {
        this._pendingColorPipelines.add(key);
        // Capture the scene-format generation so a resolution that lands
        // AFTER a runtime HDR/log-depth/format toggle (which cleared
        // `_pipelines` + bumped the generation) is dropped instead of
        // writing a stale-format pipeline back into the cache.
        const kickGeneration = this._sceneFormatGeneration;
        central
          .getPipeline(centralDesc)
          .then((p) => {
            this._pendingColorPipelines.delete(key);
            if (this._sceneFormatGeneration === kickGeneration) {
              this._pipelines.set(key, p);
            }
          })
          .catch(() => {
            // C2-22 magenta contract under async (INV-07-3). The synchronous
            // path needs an error scope because `createRenderPipeline`
            // returns an INVALID pipeline silently; `createRenderPipelineAsync`
            // REJECTS on a validation failure, so the swap lives in `.catch`.
            // Still swap to the flat-magenta fallback + bump
            // `_errorSwapGeneration` so the renderer's `errorSwapped` refetch
            // reaches the built command. `_getOrCreateErrorPipeline` bakes the
            // current format, so guard on the generation too.
            this._pendingColorPipelines.delete(key);
            if (this._sceneFormatGeneration === kickGeneration) {
              console.error(
                `[CesiumJS:webgpu] Model PBR pipeline creation failed (async); substituting flat-magenta error pipeline`,
              );
              this._pipelines.set(
                key,
                this._getOrCreateErrorPipeline(md, topology),
              );
              this._errorSwapGeneration++;
            }
          });
      }
      // Ready-gate: null tells the renderer to skip this primitive's draw for
      // the cooking frame (never bind a null pipeline). Steady state is a hit.
      return null;
    }

    // Fallback — no central cache: synchronous build, byte-identical to the
    // pre-C10-07 path including the C2-22 error-scope magenta swap.
    this._device.pushErrorScope("validation");
    const built = this._device.createRenderPipeline(raw);
    this._device.popErrorScope().then((error) => {
      if (error) {
        console.error(
          `[CesiumJS:webgpu] Model PBR pipeline creation failed (${error.message}); substituting flat-magenta error pipeline`,
        );
        this._pipelines.set(key, this._getOrCreateErrorPipeline(md, topology));
        // Signal model primitives (which cache the pipeline reference) to
        // re-fetch so the magenta fallback reaches the already-built command.
        this._errorSwapGeneration++;
      }
    });
    this._pipelines.set(key, built);
    return built;
  }

  /**
   * C2-22 — builds (and caches per layout-variant `md`) a flat-magenta fallback
   * pipeline that is a drop-in for a failed color pipeline: it reuses the
   * variant's pipeline layout (so the command's bound bind groups stay valid —
   * the error shader reads only @group(0) camera) and consumes only vertex
   * slot 0 (positionMC). Matches the color pipeline's MRT targets / depth format
   * / sample count so it binds in the same render pass.
   * @param {number} md Normalized material-defines key.
   * @param {string} [topology="triangle-list"] GLTF-POINTS-MODE — topology of
   *   the failed pipeline, so a failed point-list pipeline's magenta fallback
   *   still draws points (a triangle-list fallback over point vertex data
   *   would rasterize garbage triangles).
   * @returns {GPURenderPipeline}
   * @private
   */
  _getOrCreateErrorPipeline(
    md: number,
    topology: GPUPrimitiveTopology = "triangle-list",
  ) {
    const key = topologyVariantKey(md, topology);
    let ep = this._errorPipelines.get(key);
    if (ep) {
      return ep;
    }
    if (!this._errorShaderModule) {
      this._errorShaderModule = this._device.createShaderModule({
        label: "Model PBR error (magenta) shader",
        code: ErrorPipelineWGSL,
      });
    }
    ep = this._device.createRenderPipeline({
      label: "Model PBR ERROR (magenta fallback)",
      layout: this._getOrCreatePipelineLayout(md),
      vertex: {
        module: this._errorShaderModule,
        entryPoint: "vertexMain",
        // Only slot 0 (positionMC) — the command's other vertex buffers stay
        // bound but unused, which is valid.
        buffers: [
          {
            arrayStride: 12,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
        ],
      },
      fragment: {
        module: this._errorShaderModule,
        entryPoint: "fragmentMain",
        targets: makeSceneFBTargets(this._presentationFormat, {
          emitsGBuffer: true,
        }),
      },
      primitive: { topology, cullMode: "none" },
      depthStencil: {
        format: this._depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      multisample:
        this._sampleCount > 1 ? { count: this._sampleCount } : undefined,
    });
    this._errorPipelines.set(key, ep);
    return ep;
  }

  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — gets or creates a depth-write
   * variant of the color pipeline for translucent 3D-tile commands tagged
   * with `depthForTranslucentClassification`. The variant differs from
   * the standard pipeline only in that `depthWriteEnabled = true` is
   * forced even for `ALPHA_BLEND`. Used by `WebGPUDrawCommand.execute()`
   * when the flag is set so flagged tiles populate the scene framebuffer's
   * depth attachment, letting the stencil-based GroundPrimitive classifier
   * clip its volumes against the tile surface instead of the globe behind it.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] Batch 174 — see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @returns {GPURenderPipeline}
   */
  getDepthWritePipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._depthWritePipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    // DP-H46a — metadata vertex slot 9 variant (mode 2 = MAT3/MAT4 widened).
    const metadataSlotMode = this._metadataSlotMode(md);
    // C2-22 (Batch 418) — the depth-write variant draws into the SAME scene FB
    // MRT targets as `getPipeline` (`createPipeline` with forceDepthWrite=true
    // only flips `depthWriteEnabled`), so the flat-magenta error pipeline is a
    // valid drop-in here too. Wrap the create in the validation error scope and
    // swap to magenta on failure, mirroring `getPipeline`.
    this._device.pushErrorScope("validation");
    pipeline = createPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      true,
      hasTexCoord1,
      hasFeatureId0,
      this._sampleCount,
      metadataSlotMode,
      topology,
    );
    this._device.popErrorScope().then((error) => {
      if (error) {
        console.error(
          `[CesiumJS:webgpu] Model PBR depth-write pipeline creation failed (${error.message}); substituting flat-magenta error pipeline`,
        );
        this._depthWritePipelines.set(
          key,
          this._getOrCreateErrorPipeline(md, topology),
        );
        this._errorSwapGeneration++;
      }
    });
    this._depthWritePipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * WIRE-MODEL-SILHOUETTE — gets or creates the silhouette-MODEL (base
   * stencil-write) pipeline variant for the given material configuration.
   * See {@link createSilhouetteModelPipeline}. Only requested when the
   * per-model silhouette flag is active, so the module already carries
   * the MODEL_SILHOUETTE define.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @param {boolean} [invisible=false] WebGL `model.isInvisible()` —
   *   zero color writeMask (stencil-only draw).
   * @returns {GPURenderPipeline}
   */
  getSilhouetteModelPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
    invisible?: boolean,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(
        `${computeKey(alphaMode, doubleSided, md)}:${invisible === true ? 1 : 0}`,
        topology,
      ),
      md,
    );
    let pipeline = this._silhouetteModelPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    const metadataSlotMode = this._metadataSlotMode(md);
    // Same MRT targets / layout as `getPipeline`, so the flat-magenta
    // error pipeline is a valid drop-in here too (C2-22 pattern).
    this._device.pushErrorScope("validation");
    pipeline = createSilhouetteModelPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      hasTexCoord1,
      hasFeatureId0,
      this._sampleCount,
      metadataSlotMode,
      invisible === true,
      topology,
    );
    this._device.popErrorScope().then((error) => {
      if (error) {
        console.error(
          `[CesiumJS:webgpu] Model silhouette-model pipeline creation failed (${error.message}); substituting flat-magenta error pipeline`,
        );
        this._silhouetteModelPipelines.set(
          key,
          this._getOrCreateErrorPipeline(md, topology),
        );
        this._errorSwapGeneration++;
      }
    });
    this._silhouetteModelPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * WIRE-MODEL-SILHOUETTE — gets or creates the silhouette-COLOR
   * (stencil not-equal inflate/rim) pipeline variant. See
   * {@link createSilhouetteColorPipeline}.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided (unused for cull — the colour pass
   *   always disables culling — but kept in the key so it pairs 1:1
   *   with the base variant identity)
   * @param {number} [materialDefines=0] see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @param {boolean} [translucent=false] command pass is TRANSLUCENT or
   *   `silhouetteColor.alpha < 1` — adds alpha blend + disables depth
   *   write (WebGL derived-state parity).
   * @returns {GPURenderPipeline}
   */
  getSilhouetteColorPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
    translucent?: boolean,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(
        `${computeKey(alphaMode, doubleSided, md)}:${translucent === true ? 1 : 0}`,
        topology,
      ),
      md,
    );
    let pipeline = this._silhouetteColorPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    const metadataSlotMode = this._metadataSlotMode(md);
    this._device.pushErrorScope("validation");
    pipeline = createSilhouetteColorPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      hasTexCoord1,
      hasFeatureId0,
      this._sampleCount,
      metadataSlotMode,
      translucent === true,
      topology,
    );
    this._device.popErrorScope().then((error) => {
      if (error) {
        console.error(
          `[CesiumJS:webgpu] Model silhouette-color pipeline creation failed (${error.message}); substituting flat-magenta error pipeline`,
        );
        this._silhouetteColorPipelines.set(
          key,
          this._getOrCreateErrorPipeline(md, topology),
        );
        this._errorSwapGeneration++;
      }
    });
    this._silhouetteColorPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C-R9-MODEL-PICK (Batch 54) — gets or creates a pick pipeline for
   * the given material configuration. Same layout + vertex stage as
   * the matching color pipeline; the fragment entry is `fragmentPickMain`
   * which emits `material.pickColor` instead of the lit color, and the
   * fragment target has no blend (pick FBO must receive byte-exact pick
   * IDs).
   *
   * Keyed identically to `getPipeline` so a primitive's color and pick
   * pipelines share the same `(alphaMode, doubleSided, materialDefines)`
   * identity. The pick pipeline is only built once per identity per device.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] Batch 174 — see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @returns {GPURenderPipeline}
   */
  getPickPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._pickPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    // TODO(C2-22 follow-up): extend error-pipeline to pick/velocity/classification.
    // The flat-magenta error pipeline emits the scene-FB G-buffer target shape and
    // can't be a drop-in here (pick draws into the single-target pick FBO); a pick
    // error fallback needs its own pick-FBO-shaped error pipeline.
    pipeline = createPickPipeline(
      this._device,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — pick-gated module: LOG_DEPTH
      // follows the pick-fleet switch, NOT the scene `_logDepthEnabled`.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      this._pickFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._pickPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * DP-H46e — gets or creates a metadata-PICK pipeline for `scene.pickMetadata`.
   * Same layout + vertex stage + vertex buffers + bind groups as the color /
   * pick pipeline; only the fragment entry differs (`fragmentPickMetadataMain`,
   * which writes the picked property's components into the pick-FBO RGBA8). The
   * module is fetched with the METADATA_PICKING_ENABLED bit folded into the raw
   * `materialDefines` so `_getOrCreateShaderModule` compiles that entry + the
   * GENERATED `metadataPickingStage` chunk (which the renderer set via
   * `setMetadataPickWGSL` immediately before this call).
   *
   * Keyed by `(alphaMode, doubleSided, materialDefines)` × the picked-property
   * class hash so a re-pick of a DIFFERENT property builds a distinct
   * pipeline+module rather than serving a stale one.
   *
   * @param {number} alphaMode 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} materialDefines see {@link WebGPUModelPipelineCache#getPipeline}
   * @returns {GPURenderPipeline}
   */
  getPickMetadataPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    // Fold in the picked-property hash so a different picked property (same
    // material variant) doesn't collide on the cache key.
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(
        `${computeKey(alphaMode, doubleSided, md)}_${
          this._metadataPickClassHash >>> 0
        }`,
        topology,
      ),
      md,
    );
    let pipeline = this._pickMetadataPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    // The module compiles `fragmentPickMetadataMain` only when the pick bit is
    // present in the raw arg (it's stripped from `md` but preserved in the
    // module fetch — see `_getOrCreateShaderModule`).
    // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — fold the pick-fleet LOG_DEPTH
    // override in alongside the metadata-pick bit so the metadata-pick module's
    // log state follows the pick switch (not the scene `_logDepthEnabled`).
    const pickModule = this._getOrCreateShaderModule(
      (md | ShaderDefine.METADATA_PICKING_ENABLED) >>> 0,
      this._pickLogDepthEnabled,
    );
    pipeline = createPickMetadataPipeline(
      this._device,
      pickModule,
      this._getOrCreatePipelineLayout(md),
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      this._pickFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._pickMetadataPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option D / hover pick.
   * For OPAQUE / MASK alpha modes this is identical to
   * `getPickPipeline` (delegates). For BLEND, returns a variant that
   * uses `fragmentPickHoverMain` (stochastic dither alpha-test) and
   * `depthWriteEnabled: true` so translucent fragments compete on the
   * standard depth-test once dither has discarded most of them.
   *
   * Guaranteed stutter-free at 60fps hover frequency: single-pass,
   * same render-pass setup cost as the default pick pipeline, no MRT.
   * Used by `Scene.pickHover()`.
   *
   * @param {number} alphaMode 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0]
   * @returns {GPURenderPipeline}
   */
  getPickHoverPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    if (alphaMode !== ALPHA_BLEND) {
      // OPAQUE/MASK don't need dither — reuse the default pick pipeline.
      return this.getPickPipeline(alphaMode, doubleSided, materialDefines);
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._pickHoverPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickHoverPipeline(
      this._device,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — pick-gated module.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      this._pickFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._pickHoverPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C / precise pick
   * pass 1 (depth pre-pass). For OPAQUE / MASK alpha modes this is
   * identical to `getPickPipeline` (delegates — single pass suffices).
   * For BLEND, returns a variant that writes depth + stencil but no
   * color (`colorWriteMask: 0`) so subsequent pass 2 can identify the
   * geometrically-closest translucent fragment per pixel.
   *
   * @param {number} alphaMode 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0]
   * @returns {GPURenderPipeline}
   */
  getPickPrecisePass1Pipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    if (alphaMode !== ALPHA_BLEND) {
      return this.getPickPipeline(alphaMode, doubleSided, materialDefines);
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._pickPrecisePass1Pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickPrecisePass1Pipeline(
      this._device,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — reuses fragmentPickMain, so it
      // MUST fetch the SAME pick-gated module as getPickPipeline; otherwise the
      // scene-log module (LOG_DEPTH on by default) would make fragmentPickMain
      // write log frag_depth even with the pick switch OFF (NOT byte-identical).
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      this._pickFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._pickPrecisePass1Pipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — Option C precise pick
   * pass 2 (color pass with depth-EQUAL test). BLEND only — for
   * OPAQUE/MASK there's no pass 2 (single-pass pick handles them).
   * Returns null for non-BLEND so the renderer can skip pass-2 emission.
   *
   * @param {number} alphaMode 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0]
   * @returns {GPURenderPipeline|null}
   */
  getPickPrecisePass2Pipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    if (alphaMode !== ALPHA_BLEND) {
      return null;
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._pickPrecisePass2Pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickPrecisePass2Pipeline(
      this._device,
      // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — reuses fragmentPickMain; same
      // pick-gated module as pass1 so their log frag_depth values match for the
      // equal-test winner selection (and off is byte-identical, see pass1).
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      this._pickFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._pickPrecisePass2Pipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * TAA Slice 2e (Batch 106) — gets or creates a velocity pipeline for
   * the given material configuration. Same vertex stage and pipeline
   * layout as the color pipeline; the fragment entry is
   * `fragmentVelocityMain` and the target format is `rg16float` (the
   * scene-FB velocity texture format). Depth is read-only (color pass
   * already wrote depth; velocity pass shares the same depth view at
   * `depthLoadOp: load`).
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] Batch 174 — see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @returns {GPURenderPipeline}
   */
  getVelocityPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._velocityPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    // TODO(C2-22 follow-up): extend error-pipeline to pick/velocity/classification.
    // The velocity pass targets `rg16float`, not the scene-FB G-buffer, so the
    // flat-magenta error pipeline can't be a drop-in fallback here.
    pipeline = createVelocityPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._sampleCount,
      this._metadataSlotMode(md),
      topology,
    );
    this._velocityPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * AUDIT_2026_05_02 A.8 (Batch 142, NEW-MODEL-AS-CLASSIFIER) — gets or
   * creates a classification pipeline for the given material configuration.
   * Same vertex stage and pipeline layout as the lit color pipeline; the
   * fragment entry is `fragmentClassificationMain` which samples the
   * globe-depth texture (already bound on the effects bind group at
   * `@group(3) @binding(15)`) and emits `material.baseColorFactor` only
   * where a classifiable surface exists.
   *
   * Used by `WebGPUModelRenderer` when `model.classificationType !==
   * undefined`. Routed in place of the standard color command at
   * `Pass.TERRAIN_CLASSIFICATION` or `Pass.CESIUM_3D_TILE_CLASSIFICATION`
   * per the model's classificationType setting.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] Batch 174 — see
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @returns {GPURenderPipeline}
   */
  getClassificationPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(computeKey(alphaMode, doubleSided, md), topology),
      md,
    );
    let pipeline = this._classificationPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    // TODO(C2-22 follow-up): extend error-pipeline to pick/velocity/classification.
    // The classification pass has its own target/blend/stencil state, so the
    // scene-FB flat-magenta error pipeline can't be a drop-in fallback here.
    pipeline = createClassificationPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._sampleCount,
      this._metadataSlotMode(md),
      topology,
    );
    this._classificationPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * C2-25 ENV-SCENE-CAPTURE (Batch 447) — gets or creates the model CAPTURE
   * pipeline for the dynamic-environment-map scene-capture pass. Renders the
   * model's lit `fragmentMain` into ONE cube-face color attachment
   * (`faceFormat`), a transient no-stencil `depth24plus` depth target, and no
   * MSAA. The `CAPTURE_MODE` shader define drops the G-buffer slot-1 output so
   * the fragment stage matches the single target.
   *
   * Routes through the SEPARATE `_capturePipelines` cache so it never collides
   * with — and a capture build never invalidates — the on-screen color
   * pipelines. The key includes `faceFormat` (an HDR env cube gets its own
   * variant) plus the same `(alphaMode, doubleSided, materialDefines)` identity
   * as the color pipeline so the capture command pairs with the SAME per-variant
   * pipeline layout and merged bind groups at draw time.
   *
   * Built SYNCHRONOUSLY on first miss (the capture pass is debounced + the sky
   * fill rewrites the cube each refresh, so an async-pending frame would read
   * back as a flat sky-only reflection). Shares the device's WGSL module cache,
   * so a face format change only re-runs the cheap pipeline create, not the WGSL
   * compile.
   *
   * @param {number} alphaMode 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} materialDefines see {@link WebGPUModelPipelineCache#getPipeline}
   * @param {GPUTextureFormat} faceFormat env-cube face color attachment format
   * @returns {GPURenderPipeline}
   */
  getCapturePipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
    faceFormat: GPUTextureFormat,
  ) {
    const md = this._normalizeMaterialDefines(materialDefines);
    // C2-25 (Batch 447) — the capture module forks on LOG_DEPTH downstream in
    // `_getOrCreateShaderModule` (from the live `_logDepthEnabled`), but
    // `_capturePipelines` is deliberately NOT wiped by `maybeUpdateForLogDepth`
    // (so on-screen format churn can't invalidate capture). Mirror the globe
    // capture key (WebGPUGlobeSurfacePipelines selectCapturePipeline): fold the
    // effective log-depth bit into the key so a runtime log-depth toggle rebuilds
    // the capture pipeline instead of serving a stale-depth-encoding variant
    // (which would break model↔globe occlusion in the shared face depth buffer).
    const topology = this._primitiveTopology;
    const key = this._metadataVariantKey(
      topologyVariantKey(
        `${computeKey(alphaMode, doubleSided, md)}_${faceFormat}_${
          this._logDepthEnabled ? 1 : 0
        }`,
        topology,
      ),
      md,
    );
    let pipeline = this._capturePipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    // CAPTURE_MODE folded into the module fetch → the single-target FragOutput
    // variant (drops `@location(1) normalRoughness`). The module cache dedupes
    // across all models on the device.
    const captureModule = this._getOrCreateShaderModule(
      (md | ShaderDefine.CAPTURE_MODE) >>> 0,
    );
    pipeline = createCapturePipeline(
      this._device,
      captureModule,
      this._getOrCreatePipelineLayout(md),
      faceFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
    );
    this._capturePipelines.set(key, pipeline);
    return pipeline;
  }

  /** @returns {GPUBindGroupLayout} */
  get cameraBGL() {
    return this._cameraBGL;
  }

  /** @returns {GPUBindGroupLayout} */
  get materialBGL() {
    return this._materialBGL;
  }

  /**
   * Batch 174 — B.4 KHR materialBGL split. Basic variant (no KHR
   * textures) for materials without any KHR-extension bit set. Pairs
   * with `pipelineLayout_basic` and the no-KHR shader module.
   * @returns {GPUBindGroupLayout}
   */
  get materialBGL_basic() {
    return this._materialBGL_basic;
  }

  /** @returns {GPUPipelineLayout} basic pipeline layout (uses materialBGL_basic) */
  get pipelineLayout_basic() {
    return this._pipelineLayout_basic;
  }

  /** @returns {GPUShaderModule} basic shader module (no KHR sections) */
  get shaderModule_basic() {
    return this._shaderModule_basic;
  }

  /** @returns {GPUTexture} 1×1 white (255,255,255,255) */
  get defaultWhiteTexture() {
    return this._defaultWhiteTexture;
  }

  /** @returns {GPUTexture} 1×1 flat normal (128,128,255,255) */
  get defaultNormalTexture() {
    return this._defaultNormalTexture;
  }

  /** @returns {GPUTexture} 1×1 black (0,0,0,255) */
  get defaultBlackTexture() {
    return this._defaultBlackTexture;
  }

  /** @returns {GPUSampler} Default linear-repeat sampler */
  get defaultSampler() {
    return this._defaultSampler;
  }

  /**
   * Build (or retrieve from cache) a `GPUSampler` matching the glTF
   * textureInfo's sampler block. Returns `defaultSampler` when the
   * reader has no sampler metadata (non-glTF texture or legacy path).
   *
   * WebGL sampler enum → WebGPU string translation:
   *   magFilter  NEAREST=9728, LINEAR=9729
   *   minFilter  NEAREST=9728, LINEAR=9729,
   *              NEAREST_MIPMAP_NEAREST=9984, LINEAR_MIPMAP_NEAREST=9985,
   *              NEAREST_MIPMAP_LINEAR=9986, LINEAR_MIPMAP_LINEAR=9987
   *   wrapS/T/R  REPEAT=10497, CLAMP_TO_EDGE=33071, MIRRORED_REPEAT=33648
   *
   * @param {object} textureReader glTF textureInfo; the `.texture._sampler`
   *   field carries the sampler metadata as either a CesiumJS Sampler
   *   instance or a plain object with the fields listed above.
   * @returns {GPUSampler}
   */
  getSamplerForReader(textureReader: TextureReaderLike) {
    if (!textureReader || !textureReader.texture) {
      return this._defaultSampler;
    }
    const glSampler =
      textureReader.texture._sampler ||
      textureReader.texture.sampler ||
      textureReader.sampler;
    if (!glSampler) {
      return this._defaultSampler;
    }

    // Read fields — support both Cesium's Sampler class (minificationFilter
    // / magnificationFilter / wrapS / wrapT) and raw glTF sampler objects
    // (minFilter / magFilter / wrapS / wrapT).
    const magEnum = glSampler.magnificationFilter ?? glSampler.magFilter;
    const minEnum = glSampler.minificationFilter ?? glSampler.minFilter;
    const wrapSEnum = glSampler.wrapS;
    const wrapTEnum = glSampler.wrapT;

    const magFilter = _mapGLFilter(magEnum, "linear");
    const minFilterAndMip = _mapGLMinFilter(minEnum);
    const addrU = _mapGLWrap(wrapSEnum);
    const addrV = _mapGLWrap(wrapTEnum);

    // Cache key packs all sampler state into a single string. Identical
    // combinations across textures share a single GPUSampler.
    const key = `${magFilter}|${minFilterAndMip.min}|${minFilterAndMip.mip}|${addrU}|${addrV}`;
    let cached = this._samplerCache.get(key);
    if (cached) {
      return cached;
    }

    cached = this._device.createSampler({
      label: `glTF sampler ${key}`,
      magFilter,
      minFilter: minFilterAndMip.min,
      mipmapFilter: minFilterAndMip.mip,
      addressModeU: addrU,
      addressModeV: addrV,
    });
    this._samplerCache.set(key, cached);
    return cached;
  }

  /** @returns {GPUBuffer} Default normal (0,1,0) as instance-step VB */
  get defaultNormalBuffer() {
    return this._defaultNormalBuffer;
  }

  /** @returns {GPUBuffer} Default tangent (1,0,0,1) as instance-step VB */
  get defaultTangentBuffer() {
    return this._defaultTangentBuffer;
  }

  /** @returns {GPUBuffer} Default UV (0,0) as instance-step VB */
  get defaultUVBuffer() {
    return this._defaultUVBuffer;
  }

  /** @returns {GPUBuffer} Default color (1,1,1,1) as instance-step VB */
  get defaultColorBuffer() {
    return this._defaultColorBuffer;
  }

  /** @returns {GPUBuffer} Default joints (0,0,0,0) as instance-step VB */
  get defaultJointsBuffer() {
    return this._defaultJointsBuffer;
  }

  /** @returns {GPUBuffer} Default weights (0,0,0,0) as instance-step VB */
  get defaultWeightsBuffer() {
    return this._defaultWeightsBuffer;
  }

  /** @returns {GPUBuffer} Default featureId (0) as vertex-step VB. */
  get defaultFeatureIdBuffer() {
    return this._defaultFeatureIdBuffer;
  }

  /** @returns {GPUTextureView} Default IBL cubemap view (mid-grey, 1x1x6). */
  get defaultIBLCubemapView() {
    return this._defaultIBLCubemapView;
  }

  /** @returns {GPUSampler} Default IBL sampler (linear, clamp-to-edge). */
  get defaultIBLSampler() {
    return this._defaultIBLSampler;
  }

  /** @returns {GPUBuffer} Default SH coefficients UBO (zeros + inactive). */
  get defaultSHBuffer() {
    return this._defaultSHBuffer;
  }

  /** @returns {GPUTextureView} Default BRDF LUT view (1×1, scale=1/bias=0). */
  get defaultBrdfLutView() {
    return this._defaultBrdfLutView;
  }

  /** @returns {GPUSampler} Non-filtering sampler for the rg32float BRDF LUT. */
  get defaultBrdfLutSampler() {
    return this._defaultBrdfLutSampler;
  }

  /** @returns {GPUTextureView} DP-H46c 1×1 black placeholder property texture. */
  get defaultPropertyTextureView() {
    return this._defaultPropertyTextureView;
  }

  /** @returns {GPUTexture} DP-H46c 1×1 black placeholder property texture (raw). */
  get defaultPropertyTexture() {
    return this._defaultPropertyTexture;
  }

  /** @returns {GPUSampler} DP-H46c nearest/clamp sampler for property textures. */
  get propertyTextureSampler() {
    return this._propertyTextureSampler;
  }

  /**
   * DP-H46c — build the full set of `MAX_PROPERTY_TEXTURES` (texture,
   * sampler) bind-group entries for the property-texture block (bindings
   * 39..). `realEntries` supplies the resolved physical textures + samplers
   * (from `WebGPUModelMetadata.ensurePropertyTextureResources`); any slot the
   * primitive doesn't use is filled with the 1×1 placeholder + the shared
   * property sampler so the bind group satisfies every BGL entry. The
   * generated shader only samples the real slots, so the placeholders are
   * never read.
   *
   * @param {Array<GPUBindGroupEntry>} [realEntries] resolved property-texture
   *   entries; missing bindings get the placeholder.
   * @returns {Array<GPUBindGroupEntry>}
   */
  propertyTextureEntries(realEntries?: GPUBindGroupEntry[]) {
    const byBinding = new Map();
    if (defined(realEntries)) {
      for (let i = 0; i < realEntries.length; i++) {
        byBinding.set(realEntries[i].binding, realEntries[i]);
      }
    }
    const entries = [];
    for (let k = 0; k < MAX_PROPERTY_TEXTURES; k++) {
      const textureBinding = PROPERTY_TEXTURE_BINDING_BASE + k;
      entries.push(
        byBinding.get(textureBinding) ?? {
          binding: textureBinding,
          resource: this._defaultPropertyTextureView,
        },
      );
    }
    // Single shared sampler binding.
    entries.push(
      byBinding.get(PROPERTY_TEXTURE_SAMPLER_BINDING) ?? {
        binding: PROPERTY_TEXTURE_SAMPLER_BINDING,
        resource: this._propertyTextureSampler,
      },
    );
    return entries;
  }

  /**
   * DP-H46d — build the (texture, sampler) bind-group entries for the
   * property-TABLE block (bindings 44-45). `realEntries` supplies the resolved
   * table texture view + sampler (from
   * `WebGPUModelMetadata.ensurePropertyTableResources`); if a binding is
   * missing it is filled with the 1×1 placeholder + the shared property sampler
   * so the bind group satisfies every BGL entry. The shader reads the table via
   * `textureLoad` (the sampler placeholder is never sampled).
   *
   * @param {Array<GPUBindGroupEntry>} [realEntries] resolved property-table
   *   entries; missing bindings get the placeholder.
   * @returns {Array<GPUBindGroupEntry>}
   */
  propertyTableEntries(realEntries?: GPUBindGroupEntry[]) {
    const byBinding = new Map();
    if (defined(realEntries)) {
      for (let i = 0; i < realEntries.length; i++) {
        byBinding.set(realEntries[i].binding, realEntries[i]);
      }
    }
    return [
      byBinding.get(PROPERTY_TABLE_BINDING) ?? {
        binding: PROPERTY_TABLE_BINDING,
        resource: this._defaultPropertyTextureView,
      },
      byBinding.get(PROPERTY_TABLE_SAMPLER_BINDING) ?? {
        binding: PROPERTY_TABLE_SAMPLER_BINDING,
        resource: this._propertyTextureSampler,
      },
    ];
  }

  /**
   * Returns a fresh array of `entries[]` objects (bindings 26-32) for
   * the merged group 1 bind group when no feature ID resources are
   * available. The renderer splices these into the merged-group-1
   * `entries[]` so the BG validates against the materialBGL layout.
   * @returns {Array<GPUBindGroupEntry>}
   */
  defaultFeatureIdEntries() {
    return this._defaultFeatureIdEntries();
  }

  /** @returns {GPUBindGroupLayout} Merged group-2 BGL (skinning + morph + instancing) */
  get instanceBGL() {
    return this._instanceBGL;
  }

  /** @returns {GPUBindGroup} Default merged group-2 bind group (all-placeholder resources) */
  get defaultInstanceBindGroup() {
    return this._defaultInstanceBG;
  }

  // NEW-BG-CONSOLIDATION (Batch 122) — accessors for the underlying
  // default buffers. The renderer composes merged group 2 bind groups
  // per-frame; when a primitive lacks one of skinning / morph / instancing,
  // the corresponding slot binds the default placeholder buffer here.
  /** @returns {GPUBuffer} Identity 4×4 joint matrices storage buffer */
  get defaultJointBuffer() {
    return this._defaultJointBuffer;
  }
  /** @returns {GPUBuffer} Zero-filled morph deltas storage buffer */
  get defaultMorphDeltaBuffer() {
    return this._defaultMorphDeltaBuffer;
  }
  /** @returns {GPUBuffer} Zero-filled morph weights uniform buffer */
  get defaultMorphWeightBuffer() {
    return this._defaultMorphWeightBuffer;
  }
  /** @returns {GPUBuffer} Identity 4×4 instance transform storage buffer */
  get defaultInstancingBuffer() {
    return this._defaultInstancingBuffer;
  }

  /**
   * Creates a 1×1 RGBA texture with the given color.
   * @private
   */
  _createDefaultTexture(
    r: number,
    g: number,
    b: number,
    a: number,
    label: string,
  ) {
    const texture = this._device.createTexture({
      label,
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._device.queue.writeTexture(
      { texture },
      new Uint8Array([r, g, b, a]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    return texture;
  }

  /**
   * Creates a small vertex buffer for default attribute values.
   * Used with instance step mode when an attribute is missing.
   * @private
   */
  _createDefaultVertexBuffer(data: BufferSource, label: string) {
    const buffer = this._device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  /**
   * Destroys all cached pipelines and default resources.
   */
  destroy() {
    this._pipelines.clear();
    // C10-07 — drop in-flight COLOR async compiles too. Their descriptors
    // baked the now-stale format / mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    // C-R9-MODEL-PICK (Batch 54) — drop pick pipelines too. GPUPipelines
    // are released via GC once all references go away; clearing the map
    // releases the cache's reference. Same lifecycle as `_pipelines`.
    this._pickPipelines.clear();
    this._defaultWhiteTexture?.destroy();
    this._defaultNormalTexture?.destroy();
    this._defaultBlackTexture?.destroy();
    this._defaultNormalBuffer?.destroy();
    this._defaultTangentBuffer?.destroy();
    this._defaultUVBuffer?.destroy();
    this._defaultColorBuffer?.destroy();
    this._defaultJointsBuffer?.destroy();
    this._defaultWeightsBuffer?.destroy();
    this._defaultFeatureIdBuffer?.destroy();
    this._defaultIBLCubemap?.destroy();
    this._defaultSHBuffer?.destroy();
    this._defaultBrdfLut?.destroy();
    this._defaultJointBuffer?.destroy();
    this._defaultMorphDeltaBuffer?.destroy();
    this._defaultMorphWeightBuffer?.destroy();
    this._defaultInstancingBuffer?.destroy();
    this._defaultFeatureUniformBuffer?.destroy();
  }
}

// Export alpha mode constants for use by WebGPUModelRenderer
WebGPUModelPipelineCache.ALPHA_OPAQUE = ALPHA_OPAQUE;
WebGPUModelPipelineCache.ALPHA_MASK = ALPHA_MASK;
WebGPUModelPipelineCache.ALPHA_BLEND = ALPHA_BLEND;

export default WebGPUModelPipelineCache;
