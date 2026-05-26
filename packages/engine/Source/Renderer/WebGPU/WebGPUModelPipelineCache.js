/**
 * @module WebGPUModelPipelineCache
 *
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
 */

import ModelPBRCompleteWGSL from "../../Shaders/WebGPU/Model/ModelPBRComplete.js";
import {
  makeBindGroupLayout,
  sampler,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { getEffectsBindGroupLayout } from "./WebGPUEffectsBindGroup.js";
// Slice 5c-B Phase 1 (Batch 114) — scene-FB target helper. Used for
// the color + classification pipelines; pick / hover / precise-pick /
// velocity pipelines stay single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 162) — per-device shader-module cache so
// every `WebGPUModelPipelineCache` (one per `Model`) on the same `GPUDevice`
// shares a single compiled `GPUShaderModule` for `ModelPBRComplete.wgsl`.
// Pipelines themselves stay per-cache (their formats + alphaMode + doubleSided
// keys differ); only the WGSL compilation is shared.
const _modelShaderModuleCaches = new WeakMap();

function getModelShaderModuleCache(device) {
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
const KHR_BINDING_MANIFEST = Object.freeze([
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
  return m;
})();

/**
 * Computes a cache key from pipeline configuration.
 *
 * Bit layout:
 *   bits 0-1   : alphaMode (0=OPAQUE, 1=MASK, 2=BLEND)
 *   bit  2     : doubleSided
 *   bits 3+    : materialDefines bitmask (shifted left 3). Currently
 *                only `ShaderDefine.MODEL_HAS_KHR_TEXTURES` (1<<9) is
 *                consumed, but the cache scales to any future
 *                model-material define bit added to the manifest.
 *
 * @param {number} alphaMode - 0=OPAQUE, 1=MASK, 2=BLEND
 * @param {boolean} doubleSided - true = no backface culling
 * @param {number} materialDefines - bitmask of model-material ShaderDefine bits
 * @returns {number}
 * @private
 */
function computeKey(alphaMode, doubleSided, materialDefines) {
  const md = (materialDefines >>> 0) & MATERIAL_DEFINE_MASK;
  return (alphaMode | (doubleSided ? 4 : 0) | (md << 3)) >>> 0;
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
function buildMaterialBGL(device, materialDefines) {
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

  const variantHex = `0x${(materialDefines >>> 0).toString(16)}`;
  const label = `Model Material+Textures+Feature BGL [defines=${variantHex} sampled=${sampledTextureCount}]`;
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
function createBindGroupLayouts(device) {
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

function _mapGLFilter(glEnum, fallback) {
  if (glEnum === _GL_NEAREST) {
    return "nearest";
  }
  if (glEnum === _GL_LINEAR) {
    return "linear";
  }
  return fallback;
}

function _mapGLMinFilter(glEnum) {
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

function _mapGLWrap(glEnum) {
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
 */
function createVertexBufferLayout(hasTexCoord1 = true, hasFeatureId0 = true) {
  const layout = [
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
function createPipeline(
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  alphaMode,
  doubleSided,
  forceDepthWrite,
  hasTexCoord1,
  hasFeatureId0,
  // Session 65 Batch 28 — MSAA sample count. Default 1 matches the
  // pre-bridge behavior; when the bridge re-enables this gets the
  // current `context._msaaSamples` value baked into the pipeline.
  sampleCount = 1,
) {
  const cullMode = doubleSided ? "none" : "back";

  // Blend state depends on alpha mode
  let blend;
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

  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
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
    primitive: {
      topology: "triangle-list",
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
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  alphaMode,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
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
  const label = `Model PBR pick [alpha=${alphaMode},ds=${doubleSided}]`;
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode,
    },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: !isBlend,
      depthCompare: "less-equal",
    },
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
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-hover [BLEND,ds=${doubleSided}]`;
  return device.createRenderPipeline({
    label,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickHoverMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology: "triangle-list", cullMode },
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
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-precise pass1 [BLEND,ds=${doubleSided}]`;
  // Stencil ops only valid on depth-stencil formats. Sniff the format.
  const hasStencil =
    depthFormat === "depth24plus-stencil8" ||
    depthFormat === "depth32float-stencil8";
  const stencilState = hasStencil
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
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      // colorWriteMask: 0 → fragment output is dropped; only depth +
      // stencil writes apply.
      targets: [{ format: presentationFormat, writeMask: 0 }],
    },
    primitive: { topology: "triangle-list", cullMode },
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
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model PBR pick-precise pass2 [BLEND,ds=${doubleSided}]`;
  const hasStencil =
    depthFormat === "depth24plus-stencil8" ||
    depthFormat === "depth32float-stencil8";
  const stencilState = hasStencil
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
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentPickMain",
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology: "triangle-list", cullMode },
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
  device,
  shaderModule,
  pipelineLayout,
  depthFormat,
  alphaMode,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
  // Session 65 Batch 28 — MSAA sample count. NO LONGER READ by this
  // pipeline as of Batch 143; signature kept for back-compat with the
  // pipeline-cache call site. See multisample comment below.
  sampleCount = 1,
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
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
    },
    primitive: {
      topology: "triangle-list",
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
    // started emitting velocity commands. Today it's dormant — Model
    // primitives never tag commands with `.velocityCommand` (verified
    // by probe-model-taa-msaa.mjs reporting 0/79 velocity commands on
    // a TAA+MSAA+animated-model scene). When velocity emission gets
    // wired in a future batch, the broader fix (MSAA velocity texture
    // + resolve target, or single-sample resolved depth attachment in
    // the velocity pass) must land alongside.
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
  device,
  shaderModule,
  pipelineLayout,
  presentationFormat,
  depthFormat,
  alphaMode,
  doubleSided,
  hasTexCoord1,
  hasFeatureId0,
  // Session 65 Batch 28 — MSAA sample count.
  sampleCount = 1,
) {
  const cullMode = doubleSided ? "none" : "back";
  const label = `Model classification [alpha=${alphaMode},ds=${doubleSided}]`;
  const blend = {
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
      buffers: createVertexBufferLayout(hasTexCoord1, hasFeatureId0),
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentClassificationMain",
      // Slice 5c-B Phase 1 (Batch 114) — scene-FB color target via
      // helper. Classification draws translucent overlays into scene FB.
      targets: makeSceneFBTargets(presentationFormat, { blend }),
    },
    primitive: { topology: "triangle-list", cullMode },
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
  /**
   * @param {GPUDevice} device
   * @param {string} presentationFormat - e.g., "bgra8unorm"
   * @param {string} depthFormat - e.g., "depth24plus-stencil8"
   */
  constructor(device, presentationFormat, depthFormat) {
    this._device = device;
    this._presentationFormat = presentationFormat;
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

    // Eagerly build the basic variant (materialDefines = 0). Most
    // scenes have at least one non-KHR primitive and the basic layout
    // doubles as a `materialBGL_basic` accessor for renderer code that
    // wants to peek at the layout without going through the variant
    // API.
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
    this._defaultInstancingBuffer = device.createBuffer({
      label: "default-instance-transforms",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._defaultInstancingBuffer, 0, identityData);

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
  _normalizeMaterialDefines(materialDefines) {
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
  _getOrCreateMaterialBGL(materialDefines) {
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
  _getOrCreatePipelineLayout(materialDefines) {
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
   * @returns {GPUShaderModule}
   * @private
   */
  _getOrCreateShaderModule(materialDefines) {
    const key = this._normalizeMaterialDefines(materialDefines);
    let module = this._shaderModuleCache.get(key);
    if (module) {
      return module;
    }
    const variantHex = `0x${key.toString(16)}`;
    module = getModelShaderModuleCache(this._device).getOrCreate(
      ShaderSourceId.MODEL_PBR_COMPLETE,
      ModelPBRCompleteWGSL,
      key,
      `Model PBR ShaderModule [defines=${variantHex}]`,
    );
    this._shaderModuleCache.set(key, module);
    return module;
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
  getOrCreateMaterialBGL(materialDefines) {
    return this._getOrCreateMaterialBGL(materialDefines);
  }

  /**
   * Public accessor for the per-variant pipeline layout. See
   * {@link WebGPUModelPipelineCache#getOrCreateMaterialBGL}.
   *
   * @param {number} materialDefines
   * @returns {GPUPipelineLayout}
   */
  getOrCreatePipelineLayout(materialDefines) {
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
  maybeUpdateForSceneFormat(context) {
    const generation = context._scenePipelineFormatGeneration ?? 0;
    if (this._sceneFormatGeneration === generation) {
      return;
    }
    this._sceneFormatGeneration = generation;
    const newFormat = context.scenePipelineFormat ?? this._presentationFormat;
    if (newFormat !== this._presentationFormat) {
      this._presentationFormat = newFormat;
    }
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
    this._pickPipelines.clear();
    this._depthWritePipelines.clear();
    this._velocityPipelines.clear();
    this._classificationPipelines.clear();
    // Batch 192 — second-slice pick pipelines also wipe on format change.
    this._pickHoverPipelines.clear();
    this._pickPrecisePass1Pipelines.clear();
    this._pickPrecisePass2Pipelines.clear();
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
   * @returns {GPURenderPipeline}
   */
  getPipeline(alphaMode, doubleSided, materialDefines) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
    pipeline = createPipeline(
      this._device,
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
    );
    this._pipelines.set(key, pipeline);
    return pipeline;
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
  getDepthWritePipeline(alphaMode, doubleSided, materialDefines) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._depthWritePipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    const hasTexCoord1 = (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0;
    const hasFeatureId0 = (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0;
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
    );
    this._depthWritePipelines.set(key, pipeline);
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
  getPickPipeline(alphaMode, doubleSided, materialDefines) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._pickPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }

    pipeline = createPickPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      alphaMode,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
    );
    this._pickPipelines.set(key, pipeline);
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
  getPickHoverPipeline(alphaMode, doubleSided, materialDefines) {
    if (alphaMode !== ALPHA_BLEND) {
      // OPAQUE/MASK don't need dither — reuse the default pick pipeline.
      return this.getPickPipeline(alphaMode, doubleSided, materialDefines);
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._pickHoverPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickHoverPipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
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
  getPickPrecisePass1Pipeline(alphaMode, doubleSided, materialDefines) {
    if (alphaMode !== ALPHA_BLEND) {
      return this.getPickPipeline(alphaMode, doubleSided, materialDefines);
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._pickPrecisePass1Pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickPrecisePass1Pipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
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
  getPickPrecisePass2Pipeline(alphaMode, doubleSided, materialDefines) {
    if (alphaMode !== ALPHA_BLEND) {
      return null;
    }
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._pickPrecisePass2Pipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
    pipeline = createPickPrecisePass2Pipeline(
      this._device,
      this._getOrCreateShaderModule(md),
      this._getOrCreatePipelineLayout(md),
      this._presentationFormat,
      this._depthFormat,
      doubleSided,
      (md & ShaderDefine.MODEL_HAS_TEXCOORD_1) !== 0,
      (md & ShaderDefine.MODEL_HAS_FEATURE_ID_0) !== 0,
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
  getVelocityPipeline(alphaMode, doubleSided, materialDefines) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._velocityPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
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
  getClassificationPipeline(alphaMode, doubleSided, materialDefines) {
    const md = this._normalizeMaterialDefines(materialDefines);
    const key = computeKey(alphaMode, doubleSided, md);
    let pipeline = this._classificationPipelines.get(key);
    if (pipeline) {
      return pipeline;
    }
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
    );
    this._classificationPipelines.set(key, pipeline);
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
  getSamplerForReader(textureReader) {
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
  _createDefaultTexture(r, g, b, a, label) {
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
  _createDefaultVertexBuffer(data, label) {
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
