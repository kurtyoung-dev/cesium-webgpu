/**
 * Manages GPU render pipeline variants for glTF Model rendering.
 * Pipelines vary by: alpha mode (OPAQUE/MASK/BLEND), cull mode (back/none),
 * and presentation format.
 *
 * All variants share the same vertex layout (7 attribute slots) and the
 * 4 bind group layouts composed from device-shared model layouts:
 *   Group 0 — camera uniform buffer and model/view light uniform buffer,
 *             per frame, both dynamic-offset.
 *   Group 1 — merged material uniform buffer, 24 PBR and KHR textures, and
 *             7 featureId entries, per material.
 *   Group 2 — merged joint matrices, morph deltas, morph weights and instance
 *             transforms, per instance vertex.
 *   Group 3 — the effects layout shared with globe and primitive: shadow,
 *             clipping, atmosphere, CSM, edges and globe depth.
 *
 * Eight logical groups are consolidated into these four to fit the WebGPU
 * spec-mandated `maxBindGroups: 4` limit.
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
// Flat-magenta fallback shader for a model PBR pipeline that failed validation.
import ErrorPipelineWGSL from "../../Shaders/WebGPU/Model/ErrorPipeline.js";
// The Forward+ clustered lighting fragment chunk, prepended to the model PBR
// shader source unconditionally so the `@group(3)` binding declarations at
// slots 18 to 22 and the `evalClusteredLights()` function are available. Those
// bindings live on the existing effects layout, and runtime enabling is gated
// by `clusterParams.activeLightCount.x`, which is zero when there are no lights
// or clustered lighting is disabled, so the chunk early-outs.
import ClusteredLightingChunk from "../../Shaders/WebGPU/chunks/structs/ClusteredLighting.js";
// Preprocess the composed colour source, with LOG_DEPTH cleared, for the model
// OIT accumulation variant. The module cache preprocesses internally, but the
// OIT path needs the concrete WGSL to hand to `injectOITOutput`.
import { preprocess as preprocessShaderSource } from "./WebGPUShaderPreprocessor.js";
// The topology axis — topology plus stripIndexFormat — has one home. This file
// neither spells those two fields out nor builds the key segment itself.
import {
  MODEL_TOPOLOGY_TRIANGLE_LIST,
  buildModelTopologyVariantKey,
  modelPrimitiveState,
  modelTopologyRealizationFrom,
} from "./WebGPUModelTopology.js";
import type { ModelTopologyRealization } from "./WebGPUModelTopology.js";
import type { WebGPUPipelineConfig } from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { getEffectsBindGroupLayout } from "./WebGPUEffectsBindGroup.js";
// Group-token substitution for the ClusteredLighting chunk. Model PBR's effects
// layout is always at group 3.
import { substituteClusteredLightingGroup } from "./WebGPUClusteredLightingBGL.js";
// Scene-framebuffer target helper, used for the colour and classification
// pipelines. The pick, hover, precise-pick and velocity pipelines stay
// single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
// The snap payload attachment format lives in the shared encoding module so the
// pipeline target and the framebuffer attachment cannot drift. WebGPU validates
// that pairing at draw time rather than creation time, so a drift would surface
// only when a snap actually runs.
import { SNAP_PAYLOAD_FORMAT } from "./WebGPUSnapPayload.js";
// The generated-chunk class axis of the pipeline key. Two primitives of one
// model can share a material identity and still need different modules, because
// the metadata and customShader chunks are generated per class.
import { buildModelMetadataVariantKey } from "./WebGPUModelMetadataVariantKey.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
// The central render-pipeline cache. The on-screen model colour pipeline
// resolves through its `createRenderPipelineAsync` path behind a ready-gate,
// rather than a synchronous `device.createRenderPipeline` mid-draw, mirroring
// the globe's `resolveGlobePipelineEntry`.
//
// Pick, velocity, classification, capture, silhouette and depth-write stay
// synchronous: a frame still cooking its pipelines must not return a wrong pick
// or skip a pass that has to run.
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import {
  acquireWebGPUModelDeviceResources,
  getOrCreateWebGPUModelPipelineLayoutCache,
  releaseWebGPUModelDeviceResources,
  type WebGPUModelDeviceResources,
} from "./WebGPUModelDeviceResources.js";
// Property-texture and property-table binding numbers, shared with the codegen
// and the renderer so the layout, the shader and the bind-group entries agree.
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

// A per-device shader-module cache, so every `WebGPUModelPipelineCache` — one
// per `Model` — on the same `GPUDevice` shares one compiled `GPUShaderModule`
// for `ModelPBRComplete.wgsl`. The pipelines themselves stay per-cache, since
// their format, alphaMode and doubleSided keys differ; only the WGSL
// compilation is shared.
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
  /** The context's byte-object-ID pick attachment authority, from
   *  `WebGPUContext.pickPipelineFormat`. */
  pickPipelineFormat?: GPUTextureFormat;
  _msaaSamples?: number;
}

/**
 * A local mirror of the context's pick-format clamp, for construction time —
 * before the first `maybeUpdateForSceneFormat` can read
 * `context.pickPipelineFormat`. It must match that property: 8-bit unorm scene
 * formats pass through, and anything else, float or HDR, clamps to
 * `rgba8unorm`.
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
 * Declarative manifest of the KHR-extension bindings on group 1, slots 12 to
 * 25. Each entry pairs a group-1 binding number with the `ShaderDefine` bit
 * that gates whether the binding lands in the bind-group layout, the shader
 * source and the texture-entries array.
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
 * The manifest is the contract: a new KHR extension adds both its bindings and
 * a new gate define, and the layout builder, the texture-entries builder, the
 * pipeline cache key and the WGSL ifdef preprocessor all consume that same gate
 * bit. That is the scalable axis — a device may opt its sampled-texture limit
 * up well past the floor, and the renderer builds whichever subset of KHR
 * extensions a primitive actually uses, capped against
 * `device.limits.maxSampledTexturesPerShaderStage`.
 *
 * Splitting the WGSL ifdefs per extension would let the renderer compute
 * `materialDefines` as the OR of only the extension bits a primitive's material
 * flags activate, so the layout builder could produce a minimal layout that
 * fits a 16-texture device even for an asset using one KHR extension. The
 * basic-or-full binary is the coarser form of that.
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
  // MODEL_HAS_TEXCOORD_1 also discriminates pipelines, because it changes the
  // vertex buffer layout from 8 slots to 9. It is not a KHR-binding flag, but
  // it participates in the cache key the same way.
  m |= ShaderDefine.MODEL_HAS_TEXCOORD_1;
  // The same treatment for MODEL_HAS_FEATURE_ID_0: slot 8 present or absent is
  // a distinct vertex buffer layout and needs its own pipeline variant.
  m |= ShaderDefine.MODEL_HAS_FEATURE_ID_0;
  // MODEL_HAS_METADATA adds vertex slot 9, the property-attribute value, and
  // forks the shader module with `struct Metadata`, its initializer and the
  // metadataValue varying behind the ifdef. A distinct vertex layout and a
  // distinct module means its own pipeline and shader-module variant, as
  // MODEL_HAS_FEATURE_ID_0 gets. A model without metadata never sets the bit,
  // so its key is unaffected.
  m |= ShaderDefine.MODEL_HAS_METADATA;
  // MODEL_HAS_PROPERTY_TEXTURES adds the property-texture binding block from
  // slot 39 to the material layout and pipeline layout, and the generated
  // chunk's binding and sampling code. That is a new material layout variant,
  // with more sampled textures, plus a distinct module, so it participates in
  // the key as MODEL_HAS_KHR_TEXTURES does. A model without property textures
  // never sets the bit.
  m |= ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES;
  // MODEL_HAS_PROPERTY_TABLES adds the property-table binding block at slots 44
  // and 45 to the material layout and pipeline layout, and the generated
  // chunk's textureLoad code. Again a new material layout variant and a
  // distinct module, so it participates in the key like
  // MODEL_HAS_PROPERTY_TEXTURES, and a model without property tables never sets
  // the bit.
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

// Boot assertion. `computeKey` packs the masked material defines as `md << 3`
// inside a Uint32-normalized key, so a masked bit at index 29 or above shifts
// past bit 32 and is truncated by JavaScript's 32-bit shift. That silently
// aliases the variant carrying the bit with the variant lacking it: the wrong
// pipeline is served and nothing reports an error. This fails at module load,
// before any pipeline can be keyed.
//
// If it fires, route the new axis through sticky per-primitive state, a key
// suffix such as `:m34`, or the hi-word registry, rather than through
// MATERIAL_DEFINE_MASK. It carries no debug pragma on purpose: silent pipeline
// aliasing is broken output, so the check must survive into production.
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
 *                model-material define bit added to the manifest, up to
 *                bit 28. Bit 29 or above would shift past the Uint32 and
 *                alias; the boot assertion above guards that.
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
 * Folds the primitive topology axis into a pipeline cache key.
 *
 * Delegates to the single home in `WebGPUModelTopology`, so this file cannot
 * drift from the shadow path's copy of the same axis. It exists as a local
 * alias only because the short name reads better at its many call sites.
 *
 * Triangle-list returns the key unchanged, so a triangle pipeline keeps a
 * byte-identical cache key. Strips additionally carry their `stripIndexFormat`:
 * a uint16 and a uint32 `triangle-strip` are different pipelines and must not
 * share an entry.
 *
 * @param {number|string} key base cache key
 * @param {ModelTopologyRealization} topology realized topology axis
 * @returns {number|string}
 * @private
 */
function topologyVariantKey(
  key: number | string,
  topology: ModelTopologyRealization,
): number | string {
  return buildModelTopologyVariantKey(key, topology);
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
    // 0: the material uniform buffer, always present. Binding 1 is deliberately
    // vacant: the light block is per (model, view) rather than per primitive,
    // so it lives at group 0 binding 1; keeping it here would force this
    // per-primitive bind group to reference a rotating ring page. The slot is
    // left vacant rather than renumbered, because the KHR, featureId and IBL
    // binding numbers are load-bearing across the layout, the WGSL and the
    // entries arrays.
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
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

  // 37-38: the split-sum environment BRDF integration LUT that
  // `WebGPUBrdfLutGenerator` produces, rg32float at 256x256. R is the scale and
  // G the bias for F0, indexed by (NdotV, roughness), and the fragment shader
  // applies `radiance * (F0 * scale + bias)` to match `computeSpecularIBL` in
  // ImageBasedLightingStageFS.glsl.
  //
  // rg32float is non-filterable without the optional `float32-filterable`
  // feature, so the LUT binds as `unfilterable-float` with a non-filtering
  // sampler; nearest sampling of a smooth 256x256 table is visually
  // indistinguishable.
  entries.push(
    texture(37, Stage.FRAGMENT, { sampleType: "unfilterable-float" }),
    sampler(38, Stage.FRAGMENT, "non-filtering"),
  );

  // 39 onward: the property-texture block, gated on
  // MODEL_HAS_PROPERTY_TEXTURES. When set it appends `MAX_PROPERTY_TEXTURES`
  // texture bindings at 39 + k plus one shared sampler binding at
  // PROPERTY_TEXTURE_SAMPLER_BINDING.
  //
  // The generated metadata chunk declares only the texture bindings it actually
  // samples, at most the cap, and the renderer binds the remaining layout
  // entries to a 1x1 placeholder: a pipeline may use a subset of its layout's
  // bindings, but the bind group must satisfy every layout entry.
  //
  // Fragment stage only, since property textures are sampled at the
  // interpolated fragment texCoord. The sampler is shared rather than one per
  // texture, which keeps the per-stage sampler count under the spec floor
  // of 16.
  if ((materialDefines & ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES) !== 0) {
    for (let k = 0; k < MAX_PROPERTY_TEXTURES; k++) {
      entries.push(texture(PROPERTY_TEXTURE_BINDING_BASE + k, Stage.FRAGMENT));
    }
    entries.push(sampler(PROPERTY_TEXTURE_SAMPLER_BINDING, Stage.FRAGMENT));
  }

  // 44-45: the property-table block, gated on MODEL_HAS_PROPERTY_TABLES. One
  // sampled `texture_2d<f32>` holding the tightly-packed RGBA8 table, rows for
  // properties and columns for features, plus one placeholder sampler: the
  // shader reads through `textureLoad`, which ignores filtering, but the layout
  // binds a sampler to keep the declaration shape uniform with the
  // property-texture block.
  //
  // Fragment stage only, since the metadata debug and styling consumers read
  // the table at the per-fragment feature ID. It is independent of the
  // property-texture block: a model can carry tables without textures.
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

  // Capability check.
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

  // Bound the sampler count too. The property-texture block uses one shared
  // sampler, but the `maxSamplersPerShaderStage` limit of 16 counts samplers
  // across all bind groups — group 1 here plus the effects group 3. This local
  // check fires when this layout's samplers alone exceed the floor; the
  // device's pipeline-creation validation is the cross-group backstop.
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
 * Eight logical groups are consolidated into four physical ones, so the model
 * PBR pipeline fits the WebGPU spec-mandated `maxBindGroups: 4` limit.
 *
 * The material layout is built per variant on demand; `materialBGL` here is the
 * default full-KHR variant, cached for callers that do not care about the
 * variant axis. Per-primitive variants live in `_materialBGLCache`, keyed by
 * `materialDefines`.
 *
 * Layout:
 *   Group 0 — camera and light: two dynamic-offset bindings, 0 the camera in
 *             vertex and fragment, 1 the model/view light in fragment.
 *   Group 1 — material, textures and feature IDs, per variant, 22-36 bindings
 *     0     : material uniform buffer (binding 1 is vacant)
 *     2-11  : 5 PBR texture+sampler pairs
 *     12-25 : KHR textures and sampler, gated per variant by the manifest
 *     26-32 : featureId, batch and featurePick
 *     33-36 : IBL cubemaps and the SH uniform buffer
 *   Group 2 — instance data, 7 bindings, all vertex stage
 *     0 : joint matrices storage
 *     1 : morph deltas storage
 *     2 : morph weights uniform buffer
 *     3 : instance transforms
 *     4 : previous joint matrices, for TAA velocity
 *     5 : previous morph weights, for TAA velocity
 *     6 : previous instance transforms, for TAA velocity
 *   Group 3 — effects, shared with globe and primitive
 *     Layout owned by `WebGPUEffectsBindGroup.getEffectsBindGroupLayout`.
 *
 * @param {GPUDevice} device
 * @returns {{ cameraBGL, instanceBGL }}
 */
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
 * Two flags drive the slot count:
 *
 *   - `hasTexCoord1` — when false, slot 7 is omitted.
 *   - `hasFeatureId0` — when false, slot 8 is omitted.
 *
 * Most glTF models lack both TEXCOORD_1 and feature IDs, so the common-case
 * layout falls from 9 buffer slots to 7 and clears a `maxVertexBuffers = 8`
 * adapter cap with headroom. Both flags also drive a matching `//>>ifdef` block
 * in `ModelPBRComplete.wgsl`, so the `@location(7)` and `@location(8)`
 * declarations are stripped when their slot is not bound. The caller must pass
 * the same flags to the shader preprocessor when fetching the shader module;
 * the pipeline cache key includes both bits, so distinct variants get distinct
 * pipelines.
 *
 * A missing attribute that is neither TEXCOORD_1 nor featureId0 still uses a
 * one-element instance-step buffer of defaults: the shader's `@location(N)`
 * declarations stay unconditional for those, and the renderer always binds
 * something at every declared location.
 *
 * @param {boolean} [hasTexCoord1=true] — when false, slot 7 is omitted.
 * @param {boolean} [hasFeatureId0=true] — when false, slot 8 is omitted.
 * @param {number|boolean} [metadataSlotMode=0] — 0 or false for no metadata
 *   slot; 1 or true for a single `float32x4` at shader location 9; 2 for the
 *   widened MAT3 and MAT4 transport, one buffer slot with `arrayStride = 64`
 *   carrying four `float32x4` attributes at shader locations 9-12. The buffer
 *   count is the same as mode 1, so the `maxVertexBuffers` budget is
 *   unaffected.
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
    // Slot 7: texCoord1, a vec2<f32> read by textures whose glTF
    // `textureInfo.texCoord` is 1 — usually occlusion and clearcoat-normal.
    // Variant-conditional: a primitive without TEXCOORD_1 omits the slot
    // entirely, which keeps the layout inside an 8-slot adapter cap.
    layout.push({
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 7, offset: 0, format: "float32x2" }],
    });
  }
  if (hasFeatureId0) {
    // Slot 8: featureId0, the per-vertex glTF `_FEATURE_ID_0` — or b3dm's
    // `_BATCHID` — cast to f32. The fragment shader reads it as a
    // flat-interpolated varying and indexes the batch texture and the
    // per-feature pick texture when `FLAG_HAS_FEATURE_ID_ATTRIBUTE` is set in
    // materialFlags.
    //
    // Variant-conditional: a primitive with no feature-ID accessor, the common
    // case for standard glTF models, omits the slot and drops the layout to 7,
    // clearing a `maxVertexBuffers = 8` cap with headroom. The shader's
    // `//>>ifdef MODEL_HAS_FEATURE_ID_0` block strips the matching
    // `@location(8)` declaration when the flag is unset, and the vertex shader
    // assigns `output.featureId0 = 0.0` directly.
    layout.push({
      arrayStride: 4,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 8, offset: 0, format: "float32" }],
    });
  }
  if (metadataSlotMode) {
    // Slot 9: metadataValue, a per-vertex `float32x4` from an
    // EXT_structural_metadata property attribute. The vec4 width lets VEC2,
    // VEC3, VEC4 and MAT2 properties transport every component, with scalars
    // zero-padding the tail; `WebGPUModelMetadata.resolvePropertyAttributeVec4`
    // does the packing.
    //
    // Variant-conditional on MODEL_HAS_METADATA, so a model without metadata
    // never allocates it and the shader's `//>>ifdef MODEL_HAS_METADATA` block
    // strips the matching `@location(9)` declaration. A metadata primitive with
    // neither texCoord1 nor featureId0 uses slots 0-6 plus this one, 8 buffers,
    // which fits a `maxVertexBuffers = 8` cap. A primitive carrying texCoord1,
    // featureId0 and metadata at once would need 10 slots and is not supported
    // by this layout.
    //
    // In mode 2 the same buffer slot widens to `arrayStride` 64 with four
    // `float32x4` attributes at shader locations 9-12, offsets 0, 16, 32 and
    // 48, so a MAT3 or MAT4 property attribute transports all 9 or 16
    // column-major elements; MAT3 zero-pads elements 9 to 15 in the CPU pack.
    // Mode 1 keeps the single-attribute layout.
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
// The raw colour-pipeline descriptor, extracted so the synchronous path —
// `createPipeline`, used by `getDepthWritePipeline` and the no-central-cache
// fallback — and the asynchronous path through the central cache build a
// byte-identical descriptor. The two must produce the same pipeline; the async
// path may only arrive a frame later.
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
  // MSAA sample count. When multisampling is active this carries the context's
  // current sample count, baked into the pipeline.
  sampleCount: number = 1,
  // Metadata vertex slot 9. False leaves the caller's layout unchanged.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE — GPUPrimitiveTopology keyed off the glTF
  // primitive.mode. Default preserves the historical hardcoded value.
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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

  // Depth write is disabled for transparent objects, to avoid depth conflicts.
  // A translucent 3D-tile command tagged for classification is the exception:
  // it needs a depth-write variant so the stencil-based GroundPrimitive
  // classifier can clip volumes against the tile surface. The caller passes
  // `forceDepthWrite = true` to fetch that variant.
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
      // Emit G-buffer slot 1, the eye-space normal and roughness. The shader's
      // fragmentMain returns FragOutput from every path: the main lit path
      // emits the post-normal-map N and the real material roughness, while the
      // clipping-edge and unlit early-outs emit the geometric vertex normal and
      // a 0.5 roughness placeholder.
      //
      // `presentationFormat` is wired to `context.scenePipelineFormat` through
      // `maybeUpdateForSceneFormat()`. Pick, velocity and classification have
      // separate builders and stay single-target, since they do not draw into
      // the scene framebuffer.
      targets: makeSceneFBTargets(presentationFormat, {
        emitsGBuffer: true,
        blend,
      }),
    },
    // cullMode has no effect for non-triangle topologies per the WebGPU
    // spec, so forwarding it unchanged is safe for point-list.
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled,
      depthCompare: "less-equal",
    },
    // Multisample state matches the scene framebuffer's sample count. A count
    // of 1 produces `undefined`, i.e. no multisample block at all.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
    primitive: modelPrimitiveState(topology, cullMode),
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
 *   - Stencil test: compare not-equal against the model's stencil
 *     reference, with every op set to keep, so only pixels the base
 *     draw did not cover — the inflated rim — survive.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
    primitive: modelPrimitiveState(topology, "none"),
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
 * Debug-only aggregate counters for the WebGPU model pick-emission path:
 * how many primitives skip their pick command because the on-screen colour
 * pipeline is still compiling, how many pick draw commands are actually
 * emitted, how often {@link WebGPUModelPipelineCache#getPickPipeline} is
 * called, and the summed wall time spent inside the synchronous
 * {@link createPickPipeline} builder below. Every read and write of this
 * object is confined to a `pragmas.debug` block, so the storage and its
 * reads/writes disappear from a production bundle; the snapshot accessor at
 * the bottom of this section remains in production as an
 * always-`undefined`-returning fallback (see its own docstring).
 *
 * The counters are process-wide rather than per `WebGPUContext`: the
 * per-`Model` pipeline cache instance that calls into these has no handle
 * back to the context that owns it, so a per-context split would need a
 * context reference threaded through this class's constructor. That is a
 * larger change than this instrumentation makes; a process-wide count is
 * still meaningful for the single-context sessions these counters are read
 * from today.
 */
interface WebGPUModelPickDebugCounters {
  /** Primitives skipped this frame because their colour pipeline had not resolved yet. */
  readyGateSkipsThisFrame: number;
  /** Pick draw commands emitted this frame. */
  pickCommandsEmittedThisFrame: number;
  /**
   * The frame number the two per-frame fields above are current for. Set by
   * {@link resetModelPickDebugCountersForFrame}, called once per frame from
   * `WebGPUContext#beginFrame`. A published, if secondary, field: it is what
   * lets a caller confirm the two per-frame counters above are being read
   * for the frame they expect rather than a stale one.
   */
  countersFrameNumber: number;
  /** Cumulative calls to {@link WebGPUModelPipelineCache#getPickPipeline}. */
  getPickPipelineCalls: number;
  /** Cumulative wall time, in milliseconds, spent inside {@link createPickPipeline}. */
  createPickPipelineWallTimeMs: number;
}

//>>includeStart('debug', pragmas.debug);
const modelPickDebugCounters: WebGPUModelPickDebugCounters = {
  readyGateSkipsThisFrame: 0,
  pickCommandsEmittedThisFrame: 0,
  countersFrameNumber: -1,
  getPickPipelineCalls: 0,
  createPickPipelineWallTimeMs: 0,
};
//>>includeEnd('debug');

/**
 * Rolls the two per-frame counters over to zero for `frameNumber`. Called
 * exactly once per frame, from `WebGPUContext#beginFrame` immediately after
 * `this._frameCount++` — the renderer's existing per-frame-statistics reset
 * point (the same place `_drawCallCount` and `_triangleCount` reset). NOT
 * called from the record functions below: resetting lazily, only when an
 * event happens to occur, would leave a frame with zero ready-gate skips and
 * zero pick emissions still showing the PREVIOUS frame's nonzero values —
 * exactly backwards for a counter whose zero is itself informative.
 */
function resetModelPickDebugCountersForFrame(frameNumber: number): void {
  //>>includeStart('debug', pragmas.debug);
  modelPickDebugCounters.countersFrameNumber = frameNumber;
  modelPickDebugCounters.readyGateSkipsThisFrame = 0;
  modelPickDebugCounters.pickCommandsEmittedThisFrame = 0;
  //>>includeEnd('debug');
}

/**
 * Records one primitive skipped by the ready gate this frame — its colour
 * pipeline was still compiling, so no pick command could be built for it
 * either. Frame rollover is handled entirely by
 * {@link resetModelPickDebugCountersForFrame} at the renderer's frame
 * boundary; this function only ever increments.
 */
function recordModelPickReadyGateSkip(): void {
  //>>includeStart('debug', pragmas.debug);
  modelPickDebugCounters.readyGateSkipsThisFrame++;
  //>>includeEnd('debug');
}

/**
 * Records one pick draw command emitted this frame. Frame rollover is
 * handled entirely by {@link resetModelPickDebugCountersForFrame} at the
 * renderer's frame boundary; this function only ever increments.
 */
function recordModelPickCommandEmitted(): void {
  //>>includeStart('debug', pragmas.debug);
  modelPickDebugCounters.pickCommandsEmittedThisFrame++;
  //>>includeEnd('debug');
}

/** Records one {@link WebGPUModelPipelineCache#getPickPipeline} call. */
function recordGetPickPipelineCall(): void {
  //>>includeStart('debug', pragmas.debug);
  modelPickDebugCounters.getPickPipelineCalls++;
  //>>includeEnd('debug');
}

/** Adds one {@link createPickPipeline} build's wall time to the running sum. */
function recordCreatePickPipelineWallTime(elapsedMs: number): void {
  //>>includeStart('debug', pragmas.debug);
  modelPickDebugCounters.createPickPipelineWallTimeMs += elapsedMs;
  //>>includeEnd('debug');
}

/**
 * Snapshot accessor consumed by `WebGPUContext#getRendererStatistics`. The
 * storage above and every read/write of it are confined to
 * `pragmas.debug` blocks and so disappear from a production bundle; THIS
 * FUNCTION remains in production, as a fallback that always returns
 * `undefined` once its own `pragmas.debug` block is stripped — callers
 * already treat every `getRendererStatistics` field as optional for exactly
 * this reason (the field is simply absent from the published snapshot in
 * production, never present-but-wrong).
 */
function getModelPickDebugCounters(): WebGPUModelPickDebugCounters | undefined {
  //>>includeStart('debug', pragmas.debug);
  return { ...modelPickDebugCounters };
  //>>includeEnd('debug');
  return undefined;
}

export {
  getModelPickDebugCounters,
  recordCreatePickPipelineWallTime,
  recordGetPickPipelineCall,
  recordModelPickCommandEmitted,
  recordModelPickReadyGateSkip,
  resetModelPickDebugCountersForFrame,
};
export type { WebGPUModelPickDebugCounters };

/**
 * The pick pipeline. It mirrors `createPipeline` for vertex stage, layout and
 * depth state, but its fragment entry is `fragmentPickMain`, which writes
 * `material.pickColor`, and it has no blend: the pick framebuffer must receive
 * byte-exact pick IDs for the readback.
 *
 * Depth write is forced on for every alpha mode, including ALPHA_BLEND. The lit
 * path disables depth write for blend so translucent layers composite without
 * z-fighting, but the pick path needs it so the front-most fragment wins the
 * pick, matching `RenderState.depthMask = true` on the WebGL pick pass.
 * Translucent picking resolves to the first non-discarded fragment;
 * depth-correct alpha-blended picking would need OIT integration on the pick
 * framebuffer.
 *
 * Cull mode follows the doubleSided flag, as the lit pipeline does, so a back
 * face that would not render also does not pick.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  // When log depth is active the supplied `shaderModule` is the LOG_DEPTH
  // variant, whose `fragmentPickMain` writes a log `@builtin(frag_depth)`, and
  // the label is tagged `[ld]`. Only OPAQUE and MASK picks write that log
  // depth, since they already write depth; BLEND stays depth-test-only, because
  // `depthWriteEnabled` below is `!isBlend` regardless of this flag.
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  // A translucent (BLEND) primitive must not write depth on the pick
  // framebuffer. With depth write on, the first translucent fragment drawn at a
  // pixel writes both colour and depth, and every later fragment — including
  // opaque geometry visible through the translucent surface — fails
  // `less-equal` against the translucent's z and never reaches the pick
  // framebuffer. Leaving depth write off for BLEND, matching the colour
  // pipeline, keeps the opaque depth as the gate: translucent fragments pass
  // less-equal against opaque z, and opaque-behind-translucent stays pickable.
  //
  // Among several translucents at different depths in front of opaque geometry
  // the last drawn wins, since all pass the depth test and each overwrites the
  // colour. That is arbitrary, but no more so than first-drawn-wins; resolving
  // it by perceptual visibility would need weighted OIT-quality accumulation
  // and a composite resolve, which is what would let a pick select the building
  // behind a tinted glass facade rather than the glass.
  const isBlend = alphaMode === 2;
  const label = `Model PBR pick [alpha=${alphaMode},ds=${doubleSided}]${
    pickLogActive ? " [ld]" : ""
  }`;
  // Timed here, not at the `getPickPipeline` call site: every argument above
  // this point — including the caller's `_getOrCreateShaderModule` and
  // `_getOrCreatePipelineLayout` calls, which happen before this function is
  // even entered, since JS evaluates a call's arguments before the call —
  // has already run by the time control reaches this line. Starting the
  // timer here, and reading it back immediately before `return`, wraps only
  // the synchronous `device.createRenderPipeline` call this function makes,
  // which is the one that can be expensive.
  //>>includeStart('debug', pragmas.debug);
  const pickPipelineBuildStart = performance.now();
  //>>includeEnd('debug');
  const pipeline = device.createRenderPipeline({
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      // The pick-log switch changes the encoding of the depth a pick pipeline
      // writes, not which pipelines write. OPAQUE and MASK picks (`!isBlend`)
      // already write depth, so under the switch their `fragmentPickMain`
      // writes a log frag_depth into the shared pick framebuffer. BLEND picks
      // stay depth-test-only so opaque-behind-translucent remains pickable; the
      // log module still runs, so its frag_depth compares coherently against
      // the log buffer, it is simply not written. The switch therefore never
      // forces a blend pick to write depth.
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
  });
  //>>includeStart('debug', pragmas.debug);
  recordCreatePickPipelineWallTime(performance.now() - pickPipelineBuildStart);
  //>>includeEnd('debug');
  return pipeline;
}

/**
 * The snapping-pass pipeline: structurally the pick pipeline, with the same
 * layout, vertex stage, cull mode and depth state and no blend, differing in
 * two respects:
 *
 *   - the fragment entry is `fragmentSnapMain`, which writes the compact
 *     RG32Uint snap payload (exact pick key / edge-tagged f32 eye-depth bits)
 *     instead of the RGBA8 pick color, and
 *   - the single color target is {@link SNAP_PAYLOAD_FORMAT}, the format
 *     of `WebGPUSnapFramebuffer`'s payload attachment. WebGPU validates a
 *     pipeline's attachment state against the render pass at draw time, so a
 *     pick-format pipeline dispatched into the snap payload pass would
 *     invalidate the whole command buffer.
 *
 * `rg32uint` is a core renderable integer format and is not blendable; the snap
 * payload must reach the attachment byte-exact anyway, so no blend state is
 * requested.
 *
 * Depth follows the pick pipeline exactly (`depthWriteEnabled: !isBlend`,
 * `less-equal`). The snap payload pass shares the pick mini-frame's depth
 * attachment, already populated by the ordinary pick fleet during the occluder
 * phase — that is how snapless commands (globe, primitives, collections) still
 * occlude snappable geometry behind them, which is upstream's depth-only
 * fallback expressed with WebGPU's attachment-compatibility rules.
 *
 * The label carries both distinguishing axes, the snap payload format and the
 * log-depth state, following the descriptor-name convention. Like every model
 * pipeline except the colour one, this uses the direct
 * `device.createRenderPipeline` hatch and never consults the central pipeline
 * cache, so name aliasing is structurally impossible here; the markers are kept
 * so a future migration onto the central cache inherits a correct name.
 *
 * @private
 */
function createSnapPipeline(
  device: GPUDevice,
  shaderModule: GPUShaderModule,
  pipelineLayout: GPUPipelineLayout,
  snapFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
  alphaMode: number,
  doubleSided: boolean,
  hasTexCoord1: boolean,
  hasFeatureId0: boolean,
  hasMetadata: number | boolean = false,
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  pickLogActive: boolean = false,
) {
  const cullMode = doubleSided ? "none" : "back";
  const isBlend = alphaMode === 2;
  const label = `Model PBR snap [alpha=${alphaMode},ds=${doubleSided}] [sf=${snapFormat}]${
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
      entryPoint: "fragmentSnapMain",
      targets: [{ format: snapFormat }],
    },
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
  });
}

/**
 * The model metadata-pick pipeline that produces `scene.pickMetadata`. It has
 * the same vertex stage, layout, single-target pick colour attachment and depth
 * state as {@link createPickPipeline}, differing only in its fragment entry:
 * `fragmentPickMetadataMain` writes the picked property's components into the
 * RGBA8 pick framebuffer through the generated `metadataPickingStage`.
 *
 * The depth setup matches the regular pick pipeline — depth write on for opaque
 * and mask, off for blend, less-equal compare — so the visible surface's
 * metadata wins and the picked pixel is the surface a regular pick would
 * select.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  // See createPickPipeline.
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      // See createPickPipeline. An opaque or mask metadata-pick writes log
      // frag_depth under the switch; BLEND stays depth-test-only, and the
      // switch never changes which pipeline writes.
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
  });
}

/**
 * The model capture pipeline. It renders the model's lit `fragmentMain` into a
 * single cube-face colour attachment with no MRT slot 1, a transient
 * no-stencil `depth24plus` depth target and no MSAA, matching the
 * `WebGPUDynamicEnvironmentMapCapture` per-face render pass shape. The
 * `CAPTURE_MODE` shader define, folded into the module the caller fetches,
 * drops the `@location(1) normalRoughness` output so the fragment stage matches
 * that single target; a target-count mismatch is a hard WebGPU validation
 * error.
 *
 * Differences from the on-screen colour pipeline (`createPipeline`):
 *   - a single colour target, `faceFormat`, with no G-buffer slot 1
 *   - `depthFormat = depth24plus`, no stencil
 *   - `sampleCount = 1`, no MSAA
 *   - `cullMode = "none"` (disableCulling): the 6 ENU cube-face cameras render
 *     left-handed for the screen-matched basis, which flips triangle winding;
 *     rather than fight the winding sign per face the capture pass disables
 *     culling and lets the depth test pick the nearest surface (correct for a
 *     reflection source — mirrors the globe capture pipeline).
 *
 * The write is opaque, with no blend: the per-face pass composites the model
 * over the already-captured globe and sky through the render pass's
 * `loadOp: 'load'` and the shared depth buffer, so the model depth-tests
 * against the globe rather than blending against it.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
    // disableCulling — cube-face render is left-handed; depth picks nearest.
    primitive: modelPrimitiveState(topology, "none"),
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    // Always single-sample (no MSAA) for the capture pass.
  });
}

/**
 * The hover-pick pipeline variant for BLEND primitives. It uses
 * `fragmentPickHoverMain`, which discards translucent fragments stochastically
 * through Interleaved Gradient Noise, with survival probability equal to the
 * effective alpha. Because the dither does the alpha gating, depth write can
 * stay on and the standard depth test picks the closest surviving fragment, at
 * the same render-pass cost as an opaque pick.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  // See createPickPipeline. Depth write is already true here, because
  // dither-gated blend competes on the standard depth test.
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
}

/**
 * The precise-pick depth pre-pass for BLEND primitives. It writes depth and
 * stencil but no colour, so that `createPickPrecisePass2Pipeline` can identify
 * the geometrically closest translucent fragment per pixel.
 *
 * State:
 *   - depthWriteEnabled: true — records the closest translucent depth
 *   - depthCompare: less-equal — the standard depth test
 *   - stencil writes ref=1 on pass — marks a pixel whose translucent fragment
 *     won the depth test
 *   - colorWriteMask: 0 — no colour output; pass 2 writes colour
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  // Reuses `fragmentPickMain`, so it takes the same pick-gated module; the
  // label carries `[ld]` when active. Depth-write is already true, since this
  // pass records the closest translucent log depth.
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less-equal",
      ...stencilState,
    },
  });
}

/**
 * The precise-pick colour pass for BLEND primitives. It runs in the same
 * render pass as pass 1, sharing the depth and stencil attachments, and
 * writes pickColor only on fragments where stencil equals 1 and depth equals
 * the current value. That isolates the single closest translucent fragment per
 * pixel, so pick winner selection is deterministic.
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
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
  // Reuses `fragmentPickMain`, so it takes the same pick-gated module; the
  // label carries `[ld]` when active. Depth-write stays false: this pass
  // depth-tests `equal` against the log depth pass 1 wrote, and both use
  // `fragmentPickMain` so the log frag_depth values match. Enabling depth-write
  // here would corrupt the two-pass equal-test winner selection.
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "equal",
      ...stencilState,
    },
  });
}

/**
 * The velocity-only pipeline variant consumed by temporal antialiasing. A
 * single `rg16float` colour target matches the scene-framebuffer velocity
 * texture format. The vertex stage and bind-group layout are identical to the
 * colour pipeline; only the fragment entry (`fragmentVelocityMain`) and the
 * target format differ.
 *
 * Depth is bound read-only (`depthWriteEnabled: false`,
 * `depthCompare: less-equal`) so the velocity pass shares the scene depth from
 * the main colour pass — fragments behind opaque geometry fail the depth test
 * and don't emit velocity. The velocity pass runs after the main colour pass
 * closes, so the depth attachment has to be loaded with `depthLoadOp: load` at
 * the pass level; that's a render-pass concern, not a pipeline concern.
 *
 * Cull mode follows the doubleSided flag, matching the colour pipeline, so
 * velocity is emitted from exactly the same fragments the colour pass shaded —
 * there is no risk of velocity for back-faces that weren't drawn.
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
  // The MSAA sample count. This pipeline does not read it — the parameter
  // stays so the pipeline-cache call site keeps a uniform signature across
  // pipeline builders. See the multisample note below.
  sampleCount: number = 1,
  // Metadata vertex slot 9.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
    primitive: modelPrimitiveState(topology, cullMode),
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // No multisample state. The velocity pass attaches the single-sample
    // velocity texture created by `WebGPUSceneFramebuffer` as its only colour
    // attachment, so the pipeline has to be single-sample to match. This must
    // stay that way: baking `{count: sampleCount}` here resolves to 4 whenever
    // scene MSAA is on, which raises a sampleCount-mismatch validation error as
    // soon as Model emits velocity commands. Model primitives do tag
    // `.velocityCommand` when `frameState.taaEnabled`, and the coupling in
    // `prepareFrame` that forces MSAA to 1 while TAA is on keeps the velocity
    // pass's single-sample attachments valid against scene depth, so a
    // single-sample pipeline is the correct match.
    //
    // The collection renderers' velocity pipelines leave multisample undefined
    // for the same reason.
  });
}

/**
 * The classification pipeline variant for `Model.classificationType`. It
 * shares the vertex stage and pipeline layout with the lit colour pipeline, so
 * the model's existing skinning, morph and instancing transforms apply
 * unchanged, but the fragment entry is `fragmentClassificationMain`, which
 * samples the globe-depth texture — already bound on `@group(3) @binding(15)`
 * via the effects bind group — and discards pixels with no classifiable
 * surface, such as sky or areas with no globe data.
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
  // The MSAA sample count.
  sampleCount: number = 1,
  // Metadata vertex slot 9.
  hasMetadata: number | boolean = false,
  // GLTF-POINTS-MODE
  topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
      // The scene-framebuffer colour target, built through the shared helper.
      // Classification draws translucent overlays into the scene framebuffer.
      targets: makeSceneFBTargets(presentationFormat, { blend }),
    },
    primitive: modelPrimitiveState(topology, cullMode),
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
  // Type-only field declarations. Every field is `declare` so nothing is
  // emitted at runtime — the constructor's assignments remain the sole runtime
  // writes, keeping the compiled output byte-identical to the equivalent
  // untyped JavaScript.
  declare _device: GPUDevice;
  // Recovery ownership. `_device` alone is insufficient when a context
  // rebuilds native resources on the same physical device object.
  declare _resourceGeneration: number;
  declare _presentationFormat: GPUTextureFormat;
  // The pick-family pipelines' colour target format, mirrored from
  // `context.pickPipelineFormat` on every scene-format generation bump. It
  // equals `_presentationFormat` in SDR and stays an 8-bit unorm when the
  // scene target is float or HDR.
  declare _pickFormat: GPUTextureFormat;
  declare _depthFormat: GPUTextureFormat;
  declare _sampleCount: number;
  declare _sceneFormatGeneration: number;
  // Invalidates every asynchronous publication owned by this cache. Native
  // validation scopes can settle after a mode clear or destroy; callbacks
  // captured under an older epoch must not repopulate maps or allocate an
  // error pipeline against a stale device generation.
  declare _lifecycleEpoch: number;
  declare _pipelines: Map<string | number, GPURenderPipeline>;
  // The central async render-pipeline cache, shared across renderer instances
  // on the same device, plus the per-key in-flight set backing the colour
  // pipeline's ready-gate. Null when no central cache is available, in which
  // case the synchronous build path runs instead.
  declare _centralPipelineCache: WebGPURenderPipelineCache | null;
  declare _pendingColorPipelines: Map<
    string | number,
    Promise<GPURenderPipeline>
  >;
  declare _errorShaderModule: GPUShaderModule | null;
  declare _errorPipelines: Map<string | number, GPURenderPipeline>;
  declare _errorSwapGeneration: number;
  declare _pickPipelines: Map<string | number, GPURenderPipeline>;
  // The snapping-pass pipeline cache. Same key shape as `_pickPipelines`;
  // populated only for models in a scene whose app has called `Scene.snap` at
  // least once. Cleared wherever `_pickPipelines` is, because it shares the
  // pick-fleet log-depth state and the pipeline layout.
  declare _snapPipelines: Map<string | number, GPURenderPipeline>;
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
  declare _modelDeviceResources: WebGPUModelDeviceResources | null;
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
  declare _primitiveTopology: ModelTopologyRealization;
  declare _logDepthEnabled: boolean;
  // The pick fleet carries its own log-depth switch, separate from the scene
  // one, mirrored from `context._pickLogDepthWriteEnabled` by
  // `maybeUpdateForPickLogDepth()` each frame. The three pick fragment entries,
  // and the two BLEND precise-pass pipelines that reuse `fragmentPickMain`,
  // compile their module with LOG_DEPTH gated by this flag rather than the
  // scene `_logDepthEnabled`, so the shared pick framebuffer stays uniformly
  // hyperbolic or uniformly logarithmic across the whole fleet. It defaults to
  // false, leaving the pick modules without a LOG_DEPTH define and the pick
  // pipelines hyperbolic.
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
  declare _defaultWhiteTextureView: GPUTextureView;
  declare _defaultNormalTexture: GPUTexture;
  declare _defaultNormalTextureView: GPUTextureView;
  declare _defaultBlackTexture: GPUTexture;
  declare _defaultBlackTextureView: GPUTextureView;
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
   * @param {number} resourceGeneration - exact context resource generation
   */
  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    // The central async pipeline cache from the context
    // (`context.webgpuPipelineCache`). Optional, and defaulted to null, so
    // three-argument call sites and the synchronous fallback path are
    // unaffected; when present, the on-screen colour pipeline resolves through
    // it via `createRenderPipelineAsync`.
    centralPipelineCache: WebGPURenderPipelineCache | null = null,
    resourceGeneration = 0,
  ) {
    this._device = device;
    this._resourceGeneration = resourceGeneration;
    this._centralPipelineCache = centralPipelineCache;
    this._pendingColorPipelines = new Map();
    this._presentationFormat = presentationFormat;
    // A construction-time clamp; the authoritative `context.pickPipelineFormat`
    // is mirrored on the first `maybeUpdateForSceneFormat`, which the
    // generation sentinel of −1 below guarantees will run.
    this._pickFormat = clampToPickFormat(presentationFormat);
    this._depthFormat = depthFormat;
    // The MSAA sample count, tracked alongside the format generation. When
    // `WebGPUSceneRenderer.prepareFrame` sets `context._msaaSamples`, the
    // generation counter bumps, this cache wipes on the next
    // `maybeUpdateForSceneFormat`, and `createPipeline` reads the new sample
    // count to bake into the freshly-created pipelines. The initial value of 1
    // matches the default of `WebGPUContext._msaaSamples`.
    this._sampleCount = 1;
    // The scene pipeline format generation last applied, so a runtime HDR or
    // canvas-format change can invalidate every cached pipeline: colour, pick,
    // depth-write and velocity. Pipelines have their fragment target format
    // baked in at creation, so without invalidation the cached entries would
    // produce validation errors against the recreated scene framebuffer. The
    // -1 sentinel makes the first call to `maybeUpdateForSceneFormat`
    // unconditionally write the current generation without a clear.
    this._sceneFormatGeneration = -1;
    this._lifecycleEpoch = 0;
    this._pipelines = new Map();
    // Flat-magenta error pipelines, one per pipeline-layout variant `md`,
    // substituted into `_pipelines` when a colour pipeline fails validation.
    // The shared error shader module is built lazily on first failure.
    this._errorShaderModule = null;
    this._errorPipelines = new Map();
    // Bumped each time a color pipeline is swapped to its magenta fallback, so
    // the model renderer (which caches the pipeline reference per primitive) can
    // detect the swap and re-fetch. Exceptional path — only changes on failure.
    this._errorSwapGeneration = 0;
    // The pick pipeline cache, keyed by the same (alphaMode, doubleSided) pair
    // as `_pipelines`. Each pick pipeline shares the layout and vertex stage of
    // its colour sibling, and differs only in the fragment entry and the
    // no-blend target state.
    this._pickPipelines = new Map();
    // The snapping-pass pipelines, keyed like the pick cache. Stays empty until
    // an app calls `Scene.snap`.
    this._snapPipelines = new Map();
    // The depth-write variant cache, populated lazily for translucent commands
    // tagged with `depthForTranslucentClassification`. It uses the same
    // (alphaMode, doubleSided) key shape as `_pipelines`, so a translucent
    // BLEND primitive that also needs depth-write gets a separate pipeline that
    // writes depth. The two variants share layout, vertex, fragment and blend
    // state; only `depthWriteEnabled` differs. `_pipelines` cannot hold both,
    // because its key would collide for the same (alphaMode, doubleSided).
    this._depthWritePipelines = new Map();
    // The velocity pipeline cache, with the same (alphaMode, doubleSided) key
    // shape as the colour cache. Entries are built on demand the first frame
    // temporal antialiasing is enabled for any primitive carrying a given
    // (alphaMode, doubleSided) identity, so a static scene with antialiasing
    // off never constructs a velocity pipeline.
    this._velocityPipelines = new Map();
    // The classification pipeline cache. It is built on demand the first frame
    // a model with `classificationType !== undefined` reaches the feature
    // renderer; models without a classification type, the common case, never
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

    // The translucent-pick pipeline slots. Built lazily, and only allocated
    // for primitives whose owning app calls `scene.pickHover` or
    // `scene.pickPrecise`. The default `scene.pick` flow uses the existing
    // `_pickPipelines` Map.
    //
    //   _pickHoverPipelines: the stochastic dither alpha-test variant. For
    //     BLEND alphaMode, `fragmentPickHoverMain` replaces the `< 0.004`
    //     discard with IGN-dither-driven probabilistic survival. For OPAQUE
    //     and MASK it is identical to `_pickPipelines`.
    //
    //   _pickPrecisePass1Pipelines: the precise depth pre-pass. For BLEND,
    //     depth-write=true, depth-compare=less-equal, color-write=0. For
    //     OPAQUE and MASK it is identical to `_pickPipelines`, since no second
    //     pass is needed.
    //
    //   _pickPrecisePass2Pipelines: the precise colour pass, with a
    //     depth-equal test. BLEND only — OPAQUE and MASK never reach pass 2,
    //     because their precise pick is the same as the default.
    this._pickHoverPipelines = new Map();
    this._pickPrecisePass1Pipelines = new Map();
    this._pickPrecisePass2Pipelines = new Map();

    // The model scene-capture pipeline cache, keyed by
    // `(alphaMode, doubleSided, materialDefines, faceFormat)`. Entries are
    // built synchronously on first miss: the capture pass is debounced and the
    // env-cube sky fill rewrites the whole cube each refresh, so an
    // async-pending frame would read back as a permanently flat sky-only
    // reflection — the same rationale as the globe's
    // `resolveCapturePipelineEntrySync`. It is deliberately separate from
    // `_pipelines`, since a capture build must not touch the on-screen colour
    // pipeline cache or `_sceneFormatGeneration`, and `maybeUpdateForSceneFormat`
    // leaves it alone because its target is the env-cube face format rather
    // than the scene framebuffer format. It is populated lazily only while
    // capture is active, so a scene that never captures allocates nothing.
    this._capturePipelines = new Map();
    // The metadata-pick pipelines that produce `scene.pickMetadata` results,
    // keyed by `(alphaMode, doubleSided, materialDefines)` crossed with the
    // picked-property class hash, so re-picking a different property gets its
    // own pipeline and module. Populated lazily only during a metadata-pick
    // pass, so an app that never calls `pickMetadata` allocates nothing.
    this._pickMetadataPipelines = new Map();

    // Immutable placeholders and their camera and instance layouts are
    // device-generation resources, not model resources. The exact `GPUDevice`
    // identity together with the context resource generation forms the
    // ownership key; the pool retains them until the last model cache releases
    // that exact lease.
    const modelDeviceResources = acquireWebGPUModelDeviceResources(
      device,
      resourceGeneration,
    );
    this._modelDeviceResources = modelDeviceResources;
    this._cameraBGL = modelDeviceResources.cameraBGL;
    this._instanceBGL = modelDeviceResources.instanceBGL;
    // Effects BGL (group 3) — shared with globe + primitive via
    // `getEffectsBindGroupLayout` factory.
    try {
      this._effectsBGL = getEffectsBindGroupLayout(device);
    } catch (error) {
      try {
        releaseWebGPUModelDeviceResources(
          device,
          resourceGeneration,
          modelDeviceResources,
        );
      } catch {
        // Preserve the constructor failure. The shared lease detaches before
        // draining native owners, so a lost-device cleanup error is secondary.
      } finally {
        this._modelDeviceResources = null;
      }
      throw error;
    }

    // The KHR material bind-group-layout split: per-variant caches keyed by
    // `materialDefines: number`, a bitmask of `ShaderDefine` bits gating which
    // KHR bindings are present. A primitive's effective variant is the bitwise
    // OR of the gate defines for the KHR extensions its material flags
    // activate; that gating is currently all-or-nothing on
    // `MODEL_HAS_KHR_TEXTURES` rather than per-extension. Material layouts
    // depend only on the normalized mask and are device-shared. Full pipeline
    // layouts are also shared, but partitioned by the exact effects
    // bind-group-layout identity, because that owner generation can roll over
    // on the same `GPUDevice`. That shares the common case without ever
    // combining a current pipeline with a stale group-3 layout.
    //
    // The maps are populated lazily from `getOrCreateMaterialBGL` and
    // `getOrCreatePipelineLayout`, so a scene with only basic-variant models
    // never builds the full layout, and a scene with only full-variant models
    // never builds the basic layout. The pipelines themselves — colour, pick,
    // depth-write, velocity and classification — cache independently, keyed on
    // the same `materialDefines` plus alphaMode and doubleSided.
    this._materialBGLCache = modelDeviceResources.materialBGLCache;
    this._pipelineLayoutCache = getOrCreateWebGPUModelPipelineLayoutCache(
      modelDeviceResources,
      this._effectsBGL,
    );
    this._shaderModuleCache = new Map();

    // The per-metadata-class shader-module cache. The generated metadata WGSL
    // chunk (`MetadataWGSLPipelineStage.generateMetadataWGSL`) is
    // class-dependent, so two primitives whose metadata classes differ must not
    // share one compiled module. When `MODEL_HAS_METADATA` is set,
    // `_getOrCreateShaderModule` keys here by `${effectiveDefines}:${hash}`,
    // where the class hash is supplied by the renderer via `setMetadataWGSL`,
    // instead of the bitmask-only `_shaderModuleCache`. Non-metadata primitives
    // never touch this map, so their module hash and cache key are unchanged.
    this._metadataShaderModuleCache = new Map();
    // The generated chunk + its hash for the primitive whose pipeline is
    // currently being (re)built. The renderer sets these via `setMetadataWGSL`
    // immediately before each metadata `getPipeline*` call and clears them
    // (`clearMetadataWGSL`) for non-metadata primitives so a stale chunk can't
    // leak into a non-metadata module.
    this._metadataWGSL = "";
    this._metadataClassHash = 0;
    // The sticky per-primitive widened MAT3/MAT4 transport flag, under the same
    // set-before-every-`getPipeline*` contract as the chunk above. It drives
    // the `MODEL_METADATA_MAT_TRANSPORT` preprocess bit, the mode-2 slot-9
    // vertex layout, and the `:m34` pipeline-key suffix.
    this._metadataMatTransport = false;
    // The metadata-pick chunk — the display chunk plus the appended
    // `metadataPickingStage` for the currently-picked property — and its hash.
    // The renderer sets it via `setMetadataPickWGSL` immediately before
    // building the metadata-pick pipeline, and `_getOrCreateShaderModule`
    // consumes it when the `METADATA_PICKING_ENABLED` bit is set. It is
    // independent of `_metadataWGSL` so the display module and the pick module
    // of the same primitive don't clobber each other within one frame.
    this._metadataPickWGSL = "";
    this._metadataPickClassHash = 0;

    // PARITY-CUSTOM-SHADER-WGSL — the generated customShader chunk + its class
    // hash for the primitive whose pipeline is currently being (re)built. Set by
    // the renderer via `setCustomShaderWGSL` immediately before each customShader
    // `getPipeline*` call, cleared (`clearCustomShaderWGSL`) for non-customShader
    // primitives so a stale chunk can't leak. It is prepended at the same
    // injection point as the metadata chunk, and folded into the module cache
    // key when `MODEL_HAS_WGSL_CUSTOM_SHADER` or `_VERTEX` is set.
    this._customShaderWGSL = "";
    this._customShaderClassHash = 0;

    // GLTF-POINTS-MODE — the GPUPrimitiveTopology of the primitive whose
    // pipeline is currently being (re)built. Set by the renderer via
    // `setPrimitiveTopology` immediately before each `getPipeline*` call
    // (the same sticky-state pattern as the metadata and customShader chunks
    // above — `applyPrimitiveMetadataToPipelineCache` writes all three).
    // "triangle-list" is the default, so triangle primitives keep their cache
    // keys and pipeline descriptors unchanged.
    this._primitiveTopology = MODEL_TOPOLOGY_TRIANGLE_LIST;

    // Eagerly build the basic variant (materialDefines = 0). Most
    // scenes have at least one non-KHR primitive and the basic layout
    // doubles as a `materialBGL_basic` accessor for renderer code that
    // wants to peek at the layout without going through the variant
    // API.
    // Renderer-wide log depth — off until the renderer's first
    // `maybeUpdateForLogDepth()` call mirrors the live master switch.
    this._logDepthEnabled = false;
    // Pick-fleet log depth — off until the renderer's first
    // `maybeUpdateForPickLogDepth()` call mirrors the separate
    // `context._pickLogDepthWriteEnabled` master switch.
    this._pickLogDepthEnabled = false;
    // WIRE-MODEL-SPLITTER — per-model split-screen discard. Off until the
    // renderer's first `maybeUpdateForSplit()` call mirrors
    // `model.splitDirection !== SplitDirection.NONE`. This cache is per-Model,
    // so a per-model flag is the right granularity.
    this._splitEnabled = false;
    // WIRE-MODEL-COLOR — per-model `model.color` blend. Off until the
    // renderer's first `maybeUpdateForModelColor()` call mirrors
    // `defined(model.color)`. A per-Model flag, at the same granularity as
    // split.
    this._modelColorEnabled = false;
    // WIRE-MODEL-SILHOUETTE — per-model silhouette state. Off until the
    // renderer's first `maybeUpdateForSilhouette()` call mirrors the WebGL
    // `Model.hasSilhouette()` predicate. A per-Model flag, at the same
    // granularity as split and model colour.
    this._silhouetteEnabled = false;

    try {
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
    } catch (error) {
      try {
        releaseWebGPUModelDeviceResources(
          device,
          resourceGeneration,
          modelDeviceResources,
        );
      } catch {
        // Preserve the shader/layout construction failure; old-native cleanup
        // has already detached the generation-partitioned shared lease.
      } finally {
        this._modelDeviceResources = null;
      }
      throw error;
    }

    // All immutable fallback textures, views, samplers and buffers are aliases
    // into the exact-device pool acquired above. Model-specific pipelines and
    // mutable material and camera data remain privately owned.
    this._defaultWhiteTexture = modelDeviceResources.defaultWhiteTexture;
    this._defaultWhiteTextureView =
      modelDeviceResources.defaultWhiteTextureView;
    this._defaultNormalTexture = modelDeviceResources.defaultNormalTexture;
    this._defaultNormalTextureView =
      modelDeviceResources.defaultNormalTextureView;
    this._defaultBlackTexture = modelDeviceResources.defaultBlackTexture;
    this._defaultBlackTextureView =
      modelDeviceResources.defaultBlackTextureView;
    this._defaultSampler = modelDeviceResources.defaultSampler;
    this._defaultIBLCubemap = modelDeviceResources.defaultIBLCubemap;
    this._defaultIBLCubemapView = modelDeviceResources.defaultIBLCubemapView;
    this._defaultIBLSampler = modelDeviceResources.defaultIBLSampler;
    this._defaultSHBuffer = modelDeviceResources.defaultSHBuffer;
    this._defaultBrdfLut = modelDeviceResources.defaultBrdfLut;
    this._defaultBrdfLutView = modelDeviceResources.defaultBrdfLutView;
    this._defaultBrdfLutSampler = modelDeviceResources.defaultBrdfLutSampler;
    this._defaultPropertyTexture = modelDeviceResources.defaultPropertyTexture;
    this._defaultPropertyTextureView =
      modelDeviceResources.defaultPropertyTextureView;
    this._propertyTextureSampler = modelDeviceResources.propertyTextureSampler;
    this._samplerCache = modelDeviceResources.samplerCache;

    this._defaultNormalBuffer = modelDeviceResources.defaultNormalBuffer;
    this._defaultTangentBuffer = modelDeviceResources.defaultTangentBuffer;
    this._defaultUVBuffer = modelDeviceResources.defaultUVBuffer;
    this._defaultColorBuffer = modelDeviceResources.defaultColorBuffer;
    this._defaultJointsBuffer = modelDeviceResources.defaultJointsBuffer;
    this._defaultWeightsBuffer = modelDeviceResources.defaultWeightsBuffer;
    this._defaultFeatureIdBuffer = modelDeviceResources.defaultFeatureIdBuffer;
    this._defaultJointBuffer = modelDeviceResources.defaultJointBuffer;
    this._defaultMorphDeltaBuffer =
      modelDeviceResources.defaultMorphDeltaBuffer;
    this._defaultMorphWeightBuffer =
      modelDeviceResources.defaultMorphWeightBuffer;
    this._defaultInstancingBuffer =
      modelDeviceResources.defaultInstancingBuffer;
    this._defaultInstanceBG = modelDeviceResources.defaultInstanceBG;
    this._defaultFeatureUniformBuffer =
      modelDeviceResources.defaultFeatureUniformBuffer;
    // Feature ID resources live in the merged group 1, at bindings 26 to 32.
    // The default placeholder entries are exposed as a function so callers can
    // splice them into a merged group-1 bind group's `entries[]` array. There
    // is no standalone feature-ID bind group; the renderer always builds the
    // merged group 1.
    this._defaultFeatureIdEntries = () => [
      { binding: 26, resource: this._defaultWhiteTextureView },
      { binding: 27, resource: this._defaultSampler },
      { binding: 28, resource: this._defaultWhiteTextureView },
      { binding: 29, resource: this._defaultSampler },
      {
        binding: 30,
        resource: { buffer: this._defaultFeatureUniformBuffer },
      },
      { binding: 31, resource: this._defaultWhiteTextureView },
      { binding: 32, resource: this._defaultSampler },
    ];
  }

  /**
   * Normalizes a caller-supplied `materialDefines` value down to just the
   * model-material gating bits this cache understands. This defends against
   * callers passing other `ShaderDefine` bits, such as a
   * primitive-pipeline-level `SPLIT_ENABLED` or `GEODETIC_NORMAL`, that would
   * inflate the cache key without affecting the layout.
   *
   * @param {number} materialDefines
   * @returns {number}
   * @private
   */
  _normalizeMaterialDefines(materialDefines: number) {
    return ((materialDefines | 0) & MATERIAL_DEFINE_MASK) >>> 0;
  }

  /**
   * A lazy per-variant material bind-group-layout builder, keyed by the
   * normalized `materialDefines` mask so each unique combination of
   * KHR-extension gates produces exactly one layout per device.
   *
   * Callers in the renderer and in bind-group construction should use
   * `getOrCreateMaterialBGL` and `getOrCreatePipelineLayout` rather than the
   * `materialBGL` and `pipelineLayout` getters, which are retained for
   * backward compatibility and delegate through the per-variant cache.
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
   * A lazy per-variant pipeline-layout builder. It composes the
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
   * The colour-shader composition — effective defines, generated chunks, full
   * source and cache keys — factored out so that both the module build and
   * `getOITColorConfig`, the OIT accumulation variant, derive a byte-identical
   * `fullSource` and `effectiveDefines` for a given `materialDefines` and
   * per-cache render-mode state. It is pure: no module creation, no cache
   * mutation. `_getOrCreateShaderModule` still short-circuits on a module-cache
   * hit, whereas this composes unconditionally, a negligible string cost on the
   * rare pipeline-miss path.
   * @private
   */
  _composeColorSource(materialDefines: number, pickLogOverride?: boolean) {
    const key = this._normalizeMaterialDefines(materialDefines);
    // Renderer-wide log depth: the module forks on the LOG_DEPTH bit, while the
    // bind-group and pipeline layouts do not, since their bindings don't
    // change. `_logDepthEnabled` mirrors `isWebGPULogDepthActive()` via
    // `maybeUpdateForLogDepth()` each frame.
    //
    // CAPTURE_MODE is a render-mode bit like LOG_DEPTH, deliberately outside
    // `MATERIAL_DEFINE_MASK`, so `_normalizeMaterialDefines` above strips it.
    // It is preserved from the raw argument here so the env scene-capture
    // single-target `FragOutput` variant, which drops
    // `@location(1) normalRoughness`, actually compiles; otherwise the capture
    // pipeline gets the two-target MRT module and `createCapturePipeline`'s
    // single colour target fails WebGPU validation. On-screen callers never set
    // CAPTURE_MODE, so their module hash is unaffected.
    const captureBit = (materialDefines & ShaderDefine.CAPTURE_MODE) >>> 0;
    // METADATA_PICKING_ENABLED is likewise a render-mode bit, like CAPTURE_MODE
    // and LOG_DEPTH, deliberately outside `MATERIAL_DEFINE_MASK`, so
    // `_normalizeMaterialDefines` above strips it. It is preserved from the raw
    // argument so the metadata-pick pipeline gets a module that compiles
    // `fragmentPickMetadataMain` together with the generated
    // `metadataPickingStage`. On-screen, display and regular-pick callers never
    // set it, so their module hash is unaffected.
    const metadataPickBit =
      (materialDefines & ShaderDefine.METADATA_PICKING_ENABLED) >>> 0;
    // WIRE-MODEL-SPLITTER — MODEL_SPLIT_ENABLED is a render-mode bit like
    // LOG_DEPTH: a per-cache flag with no bind-group or layout change.
    // `_splitEnabled` mirrors `model.splitDirection !== NONE` via
    // `maybeUpdateForSplit()`.
    const splitBit = this._splitEnabled ? ShaderDefine.MODEL_SPLIT_ENABLED : 0;
    // WIRE-MODEL-COLOR — MODEL_HAS_COLOR is a render-mode bit like
    // MODEL_SPLIT_ENABLED: a per-cache flag with no bind-group or layout
    // change. `_modelColorEnabled` mirrors `defined(model.color)` via
    // `maybeUpdateForModelColor()`.
    const modelColorBit = this._modelColorEnabled
      ? ShaderDefine.MODEL_HAS_COLOR
      : 0;
    // WIRE-MODEL-SILHOUETTE — MODEL_SILHOUETTE is a render-mode bit like
    // MODEL_HAS_COLOR: a per-cache flag with no bind-group or layout change.
    // `_silhouetteEnabled` mirrors the WebGL `Model.hasSilhouette()` predicate
    // via `maybeUpdateForSilhouette()`.
    const silhouetteBit = this._silhouetteEnabled
      ? ShaderDefine.MODEL_SILHOUETTE
      : 0;
    // The widened MAT3/MAT4 attribute transport is sticky per-primitive state,
    // like the topology and metadata chunks, rather than a `materialDefines`
    // bit: bit 30 would overflow `computeKey`'s `md << 3` pipeline-key packing.
    // It is gated on MODEL_HAS_METADATA so the bit can never leak into a
    // texture-only or table-only module, whose call sites use the
    // four-argument `initializeMetadata` signature.
    const metadataMatBit =
      this._metadataMatTransport === true &&
      (key & ShaderDefine.MODEL_HAS_METADATA) !== 0
        ? ShaderDefine.MODEL_METADATA_MAT_TRANSPORT
        : 0;
    // A pick caller passes `pickLogOverride` so its module's LOG_DEPTH bit
    // follows the separate pick-fleet switch, decoupled from the scene
    // `_logDepthEnabled`. Nullish coalescing rather than `||` is required here:
    // an explicit `false`, meaning pick off while the scene is on, has to clear
    // the bit, while `undefined` from every non-pick caller falls through to
    // the scene switch. Because this bit is part of `effectiveDefines`, the
    // per-cache `moduleKey` and the device Tier-1 cache key already distinguish
    // the pick-off variant from the scene-on colour module — distinct modules
    // when scene-on meets pick-off, deduped when both agree.
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
    // The generated metadata chunk is class-dependent, so when
    // MODEL_HAS_METADATA, for property attributes, or
    // MODEL_HAS_PROPERTY_TEXTURES is set, the module varies by
    // `_metadataClassHash` — a fingerprint of the generated WGSL, which folds
    // in the property-texture binding numbers too — in addition to
    // `effectiveDefines`. The per-cache map, and the device-level Tier-1 cache
    // below, are keyed by a string composite only in that case; non-metadata
    // modules keep the numeric `effectiveDefines` key, so plain glTF keeps the
    // same module hash and cache key. The renderer sets `_metadataWGSL` and
    // `_metadataClassHash` immediately before the metadata `getPipeline*` call
    // and clears them for non-metadata primitives.
    const hasMetadata =
      (effectiveDefines &
        (ShaderDefine.MODEL_HAS_METADATA |
          ShaderDefine.MODEL_HAS_PROPERTY_TEXTURES |
          ShaderDefine.MODEL_HAS_PROPERTY_TABLES)) !==
      0;
    // When the metadata-pick bit is set, the prepended chunk is the pick chunk
    // — the display chunk plus the appended `metadataPickingStage` — and the
    // class hash folds in the picked property, so the pick module is cached
    // distinctly from the display module and separately per picked property.
    // Otherwise the display chunk and its class hash apply.
    const isMetadataPick = metadataPickBit !== 0 && hasMetadata;
    const metadataClassHash = !hasMetadata
      ? 0
      : isMetadataPick
        ? this._metadataPickClassHash >>> 0
        : this._metadataClassHash >>> 0;
    // PARITY-CUSTOM-SHADER-WGSL — the generated customShader chunk is
    // model-dependent, carrying uniforms and the inlined user body, so when
    // MODEL_HAS_WGSL_CUSTOM_SHADER for the fragment stage, or its `_VERTEX`
    // counterpart, is set, the module varies by `_customShaderClassHash` too.
    // Non-customShader modules keep `customShaderClassHash === 0`, so their key
    // is unchanged.
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
    // Prepend the ClusteredLighting chunk so the Model PBR shader has
    // `@group(3)` bindings 18 to 22 declared and the `evalClusteredLights()`
    // function defined. The chunk declares the bindings unconditionally; the
    // effects bind group, which covers slots 18 to 22, supplies either
    // placeholder buffers or the dispatcher's live buffers, and the fragment
    // chunk gates its evaluation on `clusterParams.activeLightCount.x`.
    const clChunk = substituteClusteredLightingGroup(ClusteredLightingChunk, 3);
    // The metadata WGSL injection seam. `MetadataWGSLPipelineStage` stashes the
    // generated chunk — the real `struct Metadata`, `initializeMetadata` and
    // `metadataDebugScalar`, named after the real metadata class with offset
    // and scale baked in — on the cache via `setMetadataWGSL`, and it is
    // prepended here at the single injection point, following the same fork
    // pattern as `clChunk` and CAPTURE_MODE. `ModelPBRComplete.wgsl` therefore
    // carries only the `//>>ifdef MODEL_HAS_METADATA` call site, not a struct
    // declaration of its own.
    //   - For a metadata primitive, `metadataChunk` is the generated string, so
    //     `fullSource` declares the real struct and the gated call site uses it.
    //   - For a non-metadata primitive, `_metadataWGSL` is "" because the
    //     renderer clears it before the call, and the bit is clear, so the
    //     prepend is empty and the ifdef call site is stripped, leaving
    //     `fullSource` character-for-character identical to the plain path.
    // The class hash (`metadataClassHash`) is passed as the device-level
    // cache's `keySalt` only when the bit is set, so two metadata classes
    // sharing `(sourceId, defines)` get distinct compiled modules rather than
    // aliasing; for non-metadata callers `keySalt === 0`, leaving the device
    // cache key unchanged.
    const metadataChunk = !hasMetadata
      ? ""
      : isMetadataPick
        ? (this._metadataPickWGSL ?? this._metadataWGSL ?? "")
        : (this._metadataWGSL ?? "");
    // PARITY-CUSTOM-SHADER-WGSL — prepend the generated customShader chunk at
    // the same injection point, after the metadata chunk. It is empty, and the
    // gated call sites are stripped, for non-customShader models, leaving their
    // source unchanged.
    const customShaderChunk = !hasCustomShader
      ? ""
      : (this._customShaderWGSL ?? "");
    // WIRE-MODEL-SILHOUETTE — prepend the inflate and colour helper chunk at
    // the same injection point when the bit is active. It is empty, and the
    // gated call sites are stripped, for non-silhouette models, leaving their
    // source unchanged.
    const silhouetteChunk =
      silhouetteBit !== 0 ? `${ModelSilhouetteStageWGSL}\n` : "";
    const fullSource = `${clChunk}\n${silhouetteChunk}${metadataChunk}${customShaderChunk}${ModelPBRCompleteWGSL}`;
    // The device-level Tier-1 cache keys by (sourceId, defines, keySalt). Both
    // the metadata and customShader class hashes fold into one salt, so two
    // models sharing (sourceId, defines) but differing in either generated
    // chunk get distinct compiled modules. The salt is zero on the plain path,
    // leaving the device key unchanged.
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

  /**
   * A lazy per-variant shader-module fetcher. It routes through the per-device
   * `WebGPUShaderModuleCache` so two `Model` instances with the same
   * `materialDefines` share one compiled `GPUShaderModule`. The preprocessor
   * strips the WGSL declarations and sampling sites whose gate define isn't set
   * in `materialDefines`, so the compiled binary itself differs per variant.
   *
   * @param {number} materialDefines
   * @param {boolean} [pickLogOverride] When supplied, the LOG_DEPTH module bit
   *   follows this value instead of the scene `_logDepthEnabled`. The pick
   *   pipelines pass `this._pickLogDepthEnabled` so their module's log state is
   *   gated by the separate pick-fleet switch. It is omitted by every colour,
   *   velocity, classification, capture and silhouette caller, leaving the
   *   LOG_DEPTH bit following `_logDepthEnabled`.
   * @returns {GPUShaderModule}
   * @private
   */
  _getOrCreateShaderModule(materialDefines: number, pickLogOverride?: boolean) {
    //>>includeStart('debug', pragmas.debug);
    // A test hook: when `globalThis.CesiumWebGPUForcePipelineError` is set,
    // return a deliberately invalid module — no entry points, garbage WGSL — so
    // the downstream `createRenderPipeline` fails validation and the magenta
    // error pipeline can be verified. Called inside `getPipeline`'s error scope.
    if (
      (globalThis as { CesiumWebGPUForcePipelineError?: boolean })
        .CesiumWebGPUForcePipelineError === true
    ) {
      return this._device.createShaderModule({
        label: "Model PBR FORCED-ERROR (deliberate probe path)",
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
   * Builds the OIT accumulation variant inputs for a translucent model colour
   * or twin command: the non-LOG_DEPTH preprocessed colour source
   * (`_shaderCode`), plus a `_pipelineConfig` that reuses the base colour
   * pipeline's shared layout, vertex layout and primitive and depth state, kept
   * single-sample to match the single-sample OIT accumulation targets. The
   * renderer attaches these to a `Pass.TRANSLUCENT` model command so
   * `executeTranslucentPass` can build the MRT accumulation pipeline. They are
   * read only while the WebGPU MRT OIT containment flag is on, so a scene with
   * the flag off is unaffected. The model fragment stage returns a `FragOutput`
   * struct carrying `@location(0) color`, which the `injectOITOutput` struct
   * branch handles. Returns null defensively when the composed source is empty,
   * as it is for the forced-error test hook.
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
   * Sets the generated metadata WGSL chunk and its class hash for the next
   * `getPipeline*` call. The renderer calls this immediately before
   * (re)building a metadata primitive's pipelines so
   * `_getOrCreateShaderModule` prepends the right chunk and keys the module by
   * the right class. It is idempotent, and the chunk is consumed by every
   * variant — colour, pick, depth-write, velocity and classification — built
   * for that primitive in the same pass.
   *
   * @param {string} wgsl the generated metadata chunk
   * @param {number} classHash a stable fingerprint of the generated chunk
   * @param {boolean} [matTransport=false] True when the chunk was generated
   *   with the widened four-vec4 MAT3/MAT4 transport, the codegen's
   *   `matTransport` result. It drives the `MODEL_METADATA_MAT_TRANSPORT`
   *   preprocess bit, the widened slot-9 vertex layout (mode 2), and the `:m34`
   *   pipeline-key suffix.
   * @private
   */
  setMetadataWGSL(wgsl: string, classHash: number, matTransport?: boolean) {
    this._metadataWGSL = wgsl ?? "";
    this._metadataClassHash = (classHash | 0) >>> 0;
    this._metadataMatTransport = matTransport === true;
  }

  /**
   * Clears the generated metadata WGSL so a subsequent non-metadata primitive
   * sharing this per-Model cache can't inherit a stale chunk. The
   * MODEL_HAS_METADATA bit already gates whether the chunk is prepended at all,
   * so this is belt-and-braces, but it also keeps `_metadataClassHash` from
   * leaking into a metadata primitive of a different class that failed to set
   * it. It resets to the plain non-metadata defaults.
   *
   * @private
   */
  clearMetadataWGSL() {
    this._metadataWGSL = "";
    this._metadataClassHash = 0;
    this._metadataMatTransport = false;
  }

  /**
   * The slot-9 metadata vertex-layout mode for a normalized `materialDefines`
   * mask: 0 for no metadata slot, 1 for a single float32x4 at location 9, and 2
   * for the widened MAT3/MAT4 transport with stride 64 across locations 9 to
   * 12. Mode 2 engages only when the sticky per-primitive
   * `metadataMatTransport` state, set via {@link setMetadataWGSL}, is true and
   * the mask carries MODEL_HAS_METADATA. That mirrors the module-side
   * `metadataMatBit` gate exactly, so the layout and the compiled module always
   * agree.
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
   * Discriminates a pipeline-map key by everything beyond the material identity
   * that changes the compiled module: the widened MAT3/MAT4 metadata transport,
   * whose vertex layout and module differ from plain metadata at the same
   * `(alphaMode, doubleSided, materialDefines)` identity, and the generated
   * metadata and customShader chunks, which are emitted per class and so make
   * two primitives of one model compile differently at an identical material
   * identity.
   *
   * Every pipeline map in this cache keys through here, so the fold is applied
   * once for all of them. It is byte-identical for a primitive with neither a
   * metadata class nor a customShader.
   *
   * @param {number|string} key base pipeline cache key
   * @param {number} md normalized materialDefines
   * @returns {number|string}
   * @private
   */
  _metadataVariantKey(key: number | string, md: number): number | string {
    return buildModelMetadataVariantKey(
      key,
      md,
      this._metadataSlotMode(md),
      this._metadataClassHash,
      this._customShaderClassHash,
    );
  }

  /**
   * Sets the generated metadata-pick chunk and its property-folded hash for the
   * next metadata-pick `getPickMetadataPipeline` call. The chunk is the display
   * chunk plus the appended `fn metadataPickingStage(metadata) -> vec4<f32>`
   * for the currently-picked property, built by
   * `MetadataWGSLPipelineStage.generateMetadataPickWGSL`.
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
   * Clears the generated metadata-pick chunk so a later non-pick build can't
   * inherit a stale chunk. The METADATA_PICKING_ENABLED bit already gates
   * whether the pick chunk is consumed at all, so this is belt-and-braces.
   *
   * @private
   */
  clearMetadataPickWGSL() {
    this._metadataPickWGSL = "";
    this._metadataPickClassHash = 0;
  }

  /**
   * PARITY-CUSTOM-SHADER-WGSL — sets the generated customShader WGSL chunk and
   * its class hash for the next `getPipeline*` call. The renderer calls this
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
   * PARITY-CUSTOM-SHADER-WGSL — clears the generated customShader WGSL so a
   * subsequent non-customShader primitive sharing this per-Model cache can't
   * inherit a stale chunk. The MODEL_HAS_WGSL_CUSTOM_SHADER bit already gates
   * whether the chunk is prepended at all, so this is belt-and-braces.
   *
   * @private
   */
  clearCustomShaderWGSL() {
    this._customShaderWGSL = "";
    this._customShaderClassHash = 0;
  }

  /**
   * GLTF-POINTS-MODE — sets the realized topology axis for the primitive whose
   * pipeline is about to be (re)built. It follows the same sticky-state
   * contract as `setMetadataWGSL` and `setCustomShaderWGSL`: the renderer
   * writes it immediately before each primitive's `getPipeline*` calls, via
   * `applyPrimitiveMetadataToPipelineCache`, and anything that is not a
   * recognized topology, or is a strip missing its index format, resets to the
   * `triangle-list` default so stale state can never leak into a triangle
   * primitive.
   *
   * Both fields are decided a single time during preparation, by
   * `realizeModelPrimitiveTopology`; this setter only replays that decision.
   * It does not decide anything itself, which is why the strip index format is
   * a required companion rather than something this method could infer.
   *
   * @param {string} topology GPUPrimitiveTopology
   * @param {string} [stripIndexFormat] GPUIndexFormat — required for
   *   `line-strip` and `triangle-strip`, forbidden otherwise.
   */
  setPrimitiveTopology(topology: string, stripIndexFormat?: string) {
    this._primitiveTopology = modelTopologyRealizationFrom(
      topology,
      stripIndexFormat,
    );
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
   * Mirrors the renderer-wide log depth master switch each frame. When the flag
   * flips, every pipeline map is wiped, because the cached pipelines reference
   * modules compiled with the wrong LOG_DEPTH state, and the eagerly-built
   * module fields are refreshed. This is a cheap boolean compare on the steady
   * path; the wipe only fires on a flip.
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
    this._lifecycleEpoch++;
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._snapPipelines.clear();
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
    // Metadata-pick pipelines bake the depth format and sample count too.
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
   * Mirrors the separate pick-fleet master switch
   * (`context._pickLogDepthWriteEnabled`) each frame. It follows the structure
   * of `maybeUpdateForLogDepth`, but is scoped to the pick pipelines:
   *
   *   - It wipes the pick pipeline maps and nothing else: `_pickPipelines`,
   *     `_pickHoverPipelines`, `_pickMetadataPipelines`, and the two BLEND
   *     precise-pass maps whose pipelines reuse `fragmentPickMain`. Those
   *     cached pipelines reference a module compiled with the wrong pick-log
   *     state, so a flip has to rebuild them; the module cache serves the
   *     correct variant because the LOG_DEPTH bit is part of
   *     `effectiveDefines` via the `pickLogOverride` argument.
   *   - It leaves the colour, velocity, classification, capture and silhouette
   *     maps alone, along with the eager `_shaderModule*` fields, since those
   *     follow the scene `_logDepthEnabled` and are unaffected by the pick
   *     switch.
   *
   * With the switch off, its default, the pick modules carry no LOG_DEPTH
   * define and the pick pipelines stay hyperbolic; a flip to true converts the
   * whole fleet together.
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
    this._snapPipelines.clear();
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
    this._lifecycleEpoch++;
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._snapPipelines.clear();
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
    this._lifecycleEpoch++;
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._snapPipelines.clear();
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
    this._lifecycleEpoch++;
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._snapPipelines.clear();
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

  /**
   * Invalidates cached pipelines when the scene pipeline format generation has
   * changed, as an HDR or MSAA toggle does. It updates `_presentationFormat` to
   * the new scene-pipeline format so newly created pipelines target the right
   * fragment-output format.
   *
   * The model renderer's update calls this once per frame, before any
   * `getPipeline`, `getPickPipeline` or `getVelocityPipeline` lookup. It is a
   * cheap reference compare; only the first frame after a format change pays
   * for the cache wipe.
   *
   * @param {object} context WebGPUContext
   */
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
    // Mirror the context's pick-format authority alongside the scene format;
    // the wipe below drops every pick-family pipeline built against the
    // previous format.
    this._pickFormat =
      context.pickPipelineFormat ?? clampToPickFormat(newFormat);
    // Read the current MSAA sample count so newly-created pipelines bake the
    // matching multisample state. The wipe below covers the
    // previous-generation pipelines that had the old sample count baked in.
    this._sampleCount = context._msaaSamples ?? 1;
    this._lifecycleEpoch++;
    // Wipe all cached pipelines so the next lookup creates fresh
    // entries against the current `_presentationFormat`. The cached
    // pipelines themselves aren't `destroy()`-ed (WebGPU has no
    // pipeline destroy) — releasing the Map references is enough
    // for the JS GC to collect them once any in-flight commands
    // referencing them complete.
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    this._pickPipelines.clear();
    this._snapPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // WIRE-MODEL-SILHOUETTE — silhouette variants bake the same module /
    // format / sample-count state as the colour pipeline; wipe together.
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    // The translucent-pick pipelines also wipe on a format change.
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    // Metadata-pick pipelines bake the presentation format too.
    this._pickMetadataPipelines.clear();
  }

  /**
   * Gets or creates a pipeline for the given material configuration.
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] A bitmask of `ShaderDefine` bits
   *   gating which KHR bindings the variant uses. `0` builds the basic variant,
   *   with no KHR textures, which fits the WebGPU spec floor;
   *   `MODEL_HAS_KHR_TEXTURES` builds the full variant with all KHR bindings
   *   present. Per-extension subsets build a minimal layout on demand. The
   *   renderer computes this from the primitive's material flags.
   * @returns {GPURenderPipeline | null} the pipeline, or `null` when a central
   *   cache is present and the variant is still compiling asynchronously. Under
   *   that ready-gate the caller skips the draw for the cooking frame and the
   *   per-frame refetch guard re-polls, so the draw appears within one frame of
   *   the compile landing. Returns non-null synchronously on a cache hit or on
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

    // The local promise already owns descriptor construction and the
    // central-cache lookup for this exact variant. Rebuilding the descriptor
    // and re-polling `getPipelineSync` while that promise is unresolved cannot
    // produce a different result; it only inflates CPU work and central miss
    // counters once per model per frame. The promise completion handlers below
    // still remove the key and publish either the resolved pipeline or the
    // generation-correct error fallback, so a later call resumes normally.
    if (this._pendingColorPipelines.has(key)) {
      return null;
    }

    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    // The metadata vertex slot 9 variant; mode 2 is the widened MAT3/MAT4
    // transport.
    const metadataSlotMode = this._metadataSlotMode(md);
    // One shared descriptor serves both the async and sync paths, so a
    // cooking-frame async compile and the fallback build produce identical
    // pipelines. The pick, velocity, classification, capture, silhouette and
    // depth-write variants keep their own synchronous builders as a
    // must-render hatch.
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
      // Resolve the on-screen colour pipeline through the central
      // `createRenderPipelineAsync` path, exactly as the globe's
      // `resolveGlobePipelineEntry` does. `name` carries the full variant key
      // so the central cache dedupes per
      // (alphaMode, doubleSided, materialDefines, topology, metadataSlot,
      // generated-chunk class), and
      // the format, sampleCount and vertex-layout fields feed the central key
      // too, so a scene-format change materializes a distinct entry rather than
      // colliding.
      const centralDesc: WebGPURenderPipelineDescriptor = {
        // The `ld=` segment names the log-depth axis in the key. `raw.label`
        // encodes only (alphaMode, doubleSided, forceDepthWrite), and `key`
        // only (alphaMode, doubleSided, materialDefines, topology, :m34, and
        // the generated metadata/customShader class hashes where those chunks
        // apply), so neither carries the LOG_DEPTH bit: it is folded into the
        // module via `effectiveDefines` from `this._logDepthEnabled`, not into
        // `md`. Separation of the two variants is guaranteed structurally,
        // because the central key folds `vertex.module` and `fragment.module`
        // identity and `maybeUpdateForLogDepth` wipes `_pipelines` on a flip;
        // the marker is what keeps the two rows tellable apart when a key is
        // read back. This is the only descriptor in this file that routes
        // through the central cache; every other model pipeline uses the direct
        // `createRenderPipeline` hatch.
        name: `${raw.label}|${key}|ld=${this._logDepthEnabled === true ? 1 : 0}`,
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
        // Capture the scene-format generation so a resolution that lands after
        // a runtime HDR, log-depth or format toggle — which cleared
        // `_pipelines` and bumped the generation — is dropped instead of
        // writing a stale-format pipeline back into the cache.
        const kickGeneration = this._sceneFormatGeneration;
        const kickLifecycleEpoch = this._lifecycleEpoch;
        const pendingPipeline = central.getPipeline(centralDesc);
        this._pendingColorPipelines.set(key, pendingPipeline);
        pendingPipeline
          .then((p) => {
            // Cache invalidation clears ownership, and a later request may
            // already own the same key. An older completion must neither
            // delete that replacement nor publish its stale descriptor.
            if (this._pendingColorPipelines.get(key) !== pendingPipeline) {
              return;
            }
            this._pendingColorPipelines.delete(key);
            if (
              this._sceneFormatGeneration === kickGeneration &&
              this._lifecycleEpoch === kickLifecycleEpoch
            ) {
              this._pipelines.set(key, p);
            }
          })
          .catch(() => {
            // The magenta fallback contract, in its async form. The
            // synchronous path needs an error scope because
            // `createRenderPipeline` returns an invalid pipeline silently,
            // whereas `createRenderPipelineAsync` rejects on a validation
            // failure, so the swap lives in `.catch` instead. It still swaps to
            // the flat-magenta fallback and bumps `_errorSwapGeneration` so the
            // renderer's `errorSwapped` refetch reaches the built command.
            // `_getOrCreateErrorPipeline` bakes the current format, so the
            // generation is guarded here too.
            if (this._pendingColorPipelines.get(key) !== pendingPipeline) {
              return;
            }
            this._pendingColorPipelines.delete(key);
            if (
              this._sceneFormatGeneration === kickGeneration &&
              this._lifecycleEpoch === kickLifecycleEpoch
            ) {
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

    // Fallback with no central cache: a synchronous build, including the
    // error-scope magenta swap.
    const validationEpoch = this._lifecycleEpoch;
    this._device.pushErrorScope("validation");
    const built = this._device.createRenderPipeline(raw);
    this._device.popErrorScope().then((error) => {
      if (error && this._lifecycleEpoch === validationEpoch) {
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
   * Builds, and caches per layout-variant `md`, a flat-magenta fallback
   * pipeline that is a drop-in for a failed colour pipeline. It reuses the
   * variant's pipeline layout, so the command's bound bind groups stay valid —
   * the error shader reads only the `@group(0)` camera — and consumes only
   * vertex slot 0, `positionMC`. It matches the colour pipeline's MRT targets,
   * depth format and sample count so it binds in the same render pass.
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
    topology: ModelTopologyRealization = MODEL_TOPOLOGY_TRIANGLE_LIST,
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
      primitive: modelPrimitiveState(topology, "none"),
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
   * Gets or creates a depth-write variant of the colour pipeline for
   * translucent 3D-tile commands tagged with
   * `depthForTranslucentClassification`. The variant differs from the standard
   * pipeline only in that `depthWriteEnabled = true` is forced even for
   * `ALPHA_BLEND`. It is used by `WebGPUDrawCommand.execute()`
   * when the flag is set so flagged tiles populate the scene framebuffer's
   * depth attachment, letting the stencil-based GroundPrimitive classifier
   * clip its volumes against the tile surface instead of the globe behind it.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] See
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
    // The metadata vertex slot 9 variant; mode 2 is the widened MAT3/MAT4
    // transport.
    const metadataSlotMode = this._metadataSlotMode(md);
    // The depth-write variant draws into the same scene-framebuffer MRT targets
    // as `getPipeline`, because `createPipeline` with `forceDepthWrite=true`
    // only flips `depthWriteEnabled`, so the flat-magenta error pipeline is a
    // valid drop-in here too. The create is wrapped in the validation error
    // scope and swaps to magenta on failure, mirroring `getPipeline`.
    const validationEpoch = this._lifecycleEpoch;
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
      if (error && this._lifecycleEpoch === validationEpoch) {
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
   * WIRE-MODEL-SILHOUETTE — gets or creates the silhouette model pass, the
   * base stencil-write pipeline variant, for the given material configuration.
   * See {@link createSilhouetteModelPipeline}. It is requested only when the
   * per-model silhouette flag is active, so the module already carries the
   * MODEL_SILHOUETTE define.
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
    // Same MRT targets and layout as `getPipeline`, so the flat-magenta error
    // pipeline is a valid drop-in here too.
    const validationEpoch = this._lifecycleEpoch;
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
      if (error && this._lifecycleEpoch === validationEpoch) {
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
   * WIRE-MODEL-SILHOUETTE — gets or creates the silhouette colour pass, the
   * stencil not-equal inflate and rim pipeline variant. See
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
    const validationEpoch = this._lifecycleEpoch;
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
      if (error && this._lifecycleEpoch === validationEpoch) {
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
   * Gets or creates a pick pipeline for the given material configuration. It
   * shares the layout and vertex stage of the matching colour pipeline; the
   * fragment entry is `fragmentPickMain`, which emits `material.pickColor`
   * instead of the lit colour, and the fragment target has no blend, because
   * the pick framebuffer has to receive byte-exact pick IDs.
   *
   * Keyed identically to `getPipeline` so a primitive's color and pick
   * pipelines share the same `(alphaMode, doubleSided, materialDefines)`
   * identity. The pick pipeline is only built once per identity per device.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] See
   *   {@link WebGPUModelPipelineCache#getPipeline}.
   * @returns {GPURenderPipeline}
   */
  getPickPipeline(
    alphaMode: number,
    doubleSided: boolean,
    materialDefines: number,
  ) {
    //>>includeStart('debug', pragmas.debug);
    recordGetPickPipelineCall();
    //>>includeEnd('debug');
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

    // TODO: extend the error-pipeline fallback to the pick, velocity and
    // classification variants.
    // The flat-magenta error pipeline emits the scene-FB G-buffer target shape and
    // can't be a drop-in here (pick draws into the single-target pick FBO); a pick
    // error fallback needs its own pick-FBO-shaped error pipeline.
    //
    // Wall time is recorded inside `createPickPipeline` itself, around only
    // its own `device.createRenderPipeline` call — not here, where it would
    // also capture the two calls immediately below (`_getOrCreateShaderModule`,
    // `_getOrCreatePipelineLayout`), since JS evaluates a call's arguments,
    // left to right, before the call. Timing from out here would measure
    // those two lookups as if they were part of the synchronous pipeline
    // build, which they are not.
    pipeline = createPickPipeline(
      this._device,
      // The pick-gated module: its LOG_DEPTH state follows the pick-fleet
      // switch, not the scene `_logDepthEnabled`.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // The authoritative pick target format.
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
   * Gets or creates the snapping-pass pipeline for the given material
   * configuration. It is keyed identically to
   * {@link WebGPUModelPipelineCache#getPickPipeline} so a primitive's colour,
   * pick and snap pipelines share one `(alphaMode, doubleSided,
   * materialDefines, topology)` identity.
   *
   * The module is the same pick-gated module the pick pipeline uses, with
   * LOG_DEPTH following `_pickLogDepthEnabled` rather than the scene switch, so
   * `fragmentSnapMain` writes the same `@builtin(frag_depth)` encoding that
   * `fragmentPickMain` does and the payload phase's depth test stays coherent
   * with the depth the occluder phase wrote.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} materialDefines - see {@link WebGPUModelPipelineCache#getPipeline}
   * @returns {GPURenderPipeline}
   */
  getSnapPipeline(
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
    let pipeline = this._snapPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    pipeline = createSnapPipeline(
      this._device,
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      SNAP_PAYLOAD_FORMAT,
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
      this._metadataSlotMode(md),
      topology,
      this._pickLogDepthEnabled,
    );
    this._snapPipelines.set(key, pipeline);
    return pipeline;
  }

  /**
   * Gets or creates a metadata-pick pipeline for `scene.pickMetadata`. It
   * shares the layout, vertex stage, vertex buffers and bind groups of the
   * colour and pick pipelines; only the fragment entry differs, being
   * `fragmentPickMetadataMain`, which writes the picked property's components
   * into the pick framebuffer's RGBA8 target. The module is fetched with the
   * METADATA_PICKING_ENABLED bit folded into the raw `materialDefines` so
   * `_getOrCreateShaderModule` compiles that entry together with the generated
   * `metadataPickingStage` chunk the renderer set via `setMetadataPickWGSL`
   * immediately before this call.
   *
   * It is keyed by `(alphaMode, doubleSided, materialDefines)` crossed with the
   * picked-property class hash, so re-picking a different property builds a
   * distinct pipeline and module rather than serving a stale one.
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
    // Fold the pick-fleet LOG_DEPTH override in alongside the metadata-pick bit
    // so the metadata-pick module's log state follows the pick switch rather
    // than the scene `_logDepthEnabled`.
    const pickModule = this._getOrCreateShaderModule(
      (md | ShaderDefine.METADATA_PICKING_ENABLED) >>> 0,
      this._pickLogDepthEnabled,
    );
    pipeline = createPickMetadataPipeline(
      this._device,
      pickModule,
      this._getOrCreatePipelineLayout(md),
      // The authoritative pick target format.
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
   * The hover-pick pipeline. For OPAQUE and MASK alpha modes this delegates to
   * `getPickPipeline` and is identical to it. For BLEND it returns a variant
   * that uses `fragmentPickHoverMain`, a stochastic dither alpha-test, with
   * `depthWriteEnabled: true` so translucent fragments compete on the standard
   * depth test once dither has discarded most of them.
   *
   * It stays within a hover's per-frame budget: a single pass, the same
   * render-pass setup cost as the default pick pipeline, and no MRT. It is used
   * by `Scene.pickHover()`.
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
      // OPAQUE and MASK don't need dither — reuse the default pick pipeline.
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
      // The pick-gated module.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // The authoritative pick target format.
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
   * The precise-pick depth pre-pass, pass 1. For OPAQUE and MASK alpha modes
   * this delegates to `getPickPipeline` and is identical to it, since a single
   * pass suffices. For BLEND it returns a variant that writes depth and stencil
   * but no colour (`colorWriteMask: 0`), so pass 2 can identify the
   * geometrically closest translucent fragment per pixel.
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
      // This pass reuses `fragmentPickMain`, so it has to fetch the same
      // pick-gated module `getPickPipeline` does. The scene-log module, whose
      // LOG_DEPTH is on by default, would otherwise make `fragmentPickMain`
      // write log frag_depth even while the pick switch is off.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // The authoritative pick target format.
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
   * The precise-pick colour pass, pass 2, which depth-tests `equal`. It applies
   * to BLEND only; OPAQUE and MASK have no pass 2, because the single-pass pick
   * handles them. Returns null for non-BLEND so the renderer can skip pass-2
   * emission.
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
      // This pass reuses `fragmentPickMain` with the same pick-gated module as
      // pass 1, so their log frag_depth values match for the equal-test winner
      // selection.
      this._getOrCreateShaderModule(md, this._pickLogDepthEnabled),
      this._getOrCreatePipelineLayout(md),
      // The authoritative pick target format.
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
   * Gets or creates a velocity pipeline for the given material configuration.
   * It shares the vertex stage and pipeline layout of the colour pipeline; the
   * fragment entry is `fragmentVelocityMain` and the target format is
   * `rg16float`, the scene-framebuffer velocity texture format. Depth is
   * read-only, since the colour pass already wrote depth and the velocity pass
   * shares the same depth view at `depthLoadOp: load`.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] See
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
    // TODO: extend the error-pipeline fallback to the pick, velocity and
    // classification variants.
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
   * Gets or creates a classification pipeline for the given material
   * configuration. It shares the vertex stage and pipeline layout of the lit
   * colour pipeline; the fragment entry is `fragmentClassificationMain`, which
   * samples the globe-depth texture — already bound on the effects bind group
   * at `@group(3) @binding(15)` — and emits `material.baseColorFactor` only
   * where a classifiable surface exists.
   *
   * `WebGPUModelRenderer` uses it when `model.classificationType !== undefined`,
   * routing it in place of the standard colour command at
   * `Pass.TERRAIN_CLASSIFICATION` or `Pass.CESIUM_3D_TILE_CLASSIFICATION`
   * according to the model's classification type.
   *
   * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
   * @param {boolean} doubleSided
   * @param {number} [materialDefines=0] See
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
    // TODO: extend the error-pipeline fallback to the pick, velocity and
    // classification variants.
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
   * Gets or creates the model capture pipeline for the
   * dynamic-environment-map scene-capture pass. It renders the model's lit
   * `fragmentMain` into a single cube-face colour attachment of `faceFormat`,
   * against a transient no-stencil `depth24plus` depth target, with no MSAA.
   * The `CAPTURE_MODE` shader define drops the G-buffer slot-1 output so the
   * fragment stage matches that single target.
   *
   * It routes through the separate `_capturePipelines` cache, so it never
   * collides with the on-screen colour pipelines and a capture build never
   * invalidates them. The key includes `faceFormat`, giving an HDR env cube its
   * own variant, plus the same `(alphaMode, doubleSided, materialDefines)`
   * identity as the colour pipeline, so the capture command pairs with the same
   * per-variant pipeline layout and merged bind groups at draw time.
   *
   * It is built synchronously on first miss: the capture pass is debounced and
   * the sky fill rewrites the cube each refresh, so an async-pending frame would
   * read back as a flat sky-only reflection. It shares the device's WGSL module
   * cache, so a face format change only re-runs the cheap pipeline create rather
   * than the WGSL compile.
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
    // The capture module forks on LOG_DEPTH downstream in
    // `_getOrCreateShaderModule`, from the live `_logDepthEnabled`, but
    // `maybeUpdateForLogDepth` deliberately leaves `_capturePipelines` alone so
    // on-screen format churn can't invalidate capture. Following the globe
    // capture key in `WebGPUGlobeSurfacePipelines.selectCapturePipeline`, the
    // effective log-depth bit folds into the key here, so a runtime log-depth
    // toggle rebuilds the capture pipeline instead of serving a variant with a
    // stale depth encoding, which would break model-to-globe occlusion in the
    // shared face depth buffer.
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
    // CAPTURE_MODE folds into the module fetch, selecting the single-target
    // `FragOutput` variant that drops `@location(1) normalRoughness`. The module
    // cache dedupes across all models on the device.
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
   * The basic variant of the KHR material bind-group-layout split, with no KHR
   * textures, for materials that set no KHR-extension bit. It pairs with
   * `pipelineLayout_basic` and the no-KHR shader module.
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

  /** @returns {GPUTextureView} Stable view for a device-shared fallback texture. */
  getDefaultTextureView(texture: GPUTexture) {
    if (texture === this._defaultWhiteTexture) {
      return this._defaultWhiteTextureView;
    }
    if (texture === this._defaultNormalTexture) {
      return this._defaultNormalTextureView;
    }
    if (texture === this._defaultBlackTexture) {
      return this._defaultBlackTextureView;
    }
    return texture.createView();
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

  /** @returns {GPUTextureView} 1×1 black placeholder property texture. */
  get defaultPropertyTextureView() {
    return this._defaultPropertyTextureView;
  }

  /** @returns {GPUTexture} 1×1 black placeholder property texture (raw). */
  get defaultPropertyTexture() {
    return this._defaultPropertyTexture;
  }

  /** @returns {GPUSampler} Nearest/clamp sampler for property textures. */
  get propertyTextureSampler() {
    return this._propertyTextureSampler;
  }

  /**
   * Builds the full set of `MAX_PROPERTY_TEXTURES` (texture, sampler)
   * bind-group entries for the property-texture block, which starts at binding
   * 39. `realEntries` supplies the resolved physical textures and samplers from
   * `WebGPUModelMetadata.ensurePropertyTextureResources`; any slot the primitive
   * doesn't use is filled with the 1×1 placeholder and the shared property
   * sampler, so the bind group satisfies every entry in the layout. The
   * generated shader samples the real slots alone, so the placeholders are never
   * read.
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
   * Builds the (texture, sampler) bind-group entries for the property-table
   * block at bindings 44 and 45. `realEntries` supplies the resolved table
   * texture view and sampler from
   * `WebGPUModelMetadata.ensurePropertyTableResources`; a missing binding is
   * filled with the 1×1 placeholder and the shared property sampler, so the
   * bind group satisfies every entry in the layout. The shader reads the table
   * via `textureLoad`, so the placeholder sampler is never sampled.
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

  // Accessors for the underlying default buffers. The renderer composes merged
  // group 2 bind groups per frame; when a primitive lacks skinning, morph or
  // instancing data, the corresponding slot binds the default placeholder
  // buffer here.
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
   * Destroys all cached pipelines and default resources.
   */
  destroy() {
    this._lifecycleEpoch++;
    this._pipelines.clear();
    // Drop in-flight colour async compiles too. Their descriptors baked the
    // now-stale format and mode; the `.then` also carries a
    // scene-format-generation guard so a stale resolve never writes back.
    this._pendingColorPipelines.clear();
    // Drop pick pipelines too. A `GPURenderPipeline` is released by the garbage
    // collector once all references go away, and clearing the map releases the
    // cache's reference. Same lifecycle as `_pipelines`.
    this._pickPipelines.clear();
    this._snapPipelines.clear();
    this._errorPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    this._silhouetteModelPipelines.clear();
    this._silhouetteColorPipelines.clear();
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
    this._capturePipelines.clear();
    this._pickMetadataPipelines.clear();
    this._shaderModuleCache.clear();
    this._metadataShaderModuleCache.clear();
    this._errorShaderModule = null;
    if (this._modelDeviceResources) {
      // The release detaches the shared lease before draining native owners,
      // then rethrows the first drain error. The field is nulled in a `finally`
      // so a throwing release cannot leave this cache holding a lease it has
      // already given back, mirroring the constructor error paths above.
      try {
        releaseWebGPUModelDeviceResources(
          this._device,
          this._resourceGeneration,
          this._modelDeviceResources,
        );
      } finally {
        this._modelDeviceResources = null;
      }
    }
  }
}

// Export alpha mode constants for use by WebGPUModelRenderer
WebGPUModelPipelineCache.ALPHA_OPAQUE = ALPHA_OPAQUE;
WebGPUModelPipelineCache.ALPHA_MASK = ALPHA_MASK;
WebGPUModelPipelineCache.ALPHA_BLEND = ALPHA_BLEND;

export default WebGPUModelPipelineCache;
