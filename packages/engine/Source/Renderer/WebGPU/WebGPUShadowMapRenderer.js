/**
 * Handles WebGPU shadow map generation and shadow receiving.
 * Creates a depth-only render target for the shadow map, renders scene
 * from light's perspective, then provides shadow sampling for color passes.
 *
 * @private
 * @module WebGPUShadowMapRenderer
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Pass from "../Pass.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { prepareTerrainShadowCastCommandUniforms } from "./WebGPUGlobeSurfaceTileBuffers.js";
import { getOrCreateShadowCastBindGroup } from "./WebGPUShadowCastBindGroupCache.js";
import { shouldClearShadowCastTarget } from "./WebGPUShadowCastTargetState.js";
import { toWebGPUShadowReceiveMatrix } from "./WebGPUShadowReceiveTransform.js";
// Shadow casting and color rendering bake the same topology axis, so they
// both read it from the model topology helpers.
import {
  modelPrimitiveState,
  modelTopologyAxisToken,
  modelTopologyRealizationFrom,
} from "./WebGPUModelTopology.js";

const SHADOW_MAP_SIZE = 2048;
const SHADOW_UNIFORM_SIZE = 128;

const scratchEncodedCamera = new EncodedCartesian3();
const scratchLightViewProjection = new Matrix4();
const scratchCameraTranslation = new Matrix4();

const DEFAULT_SHADOW_CAST_TOPOLOGY = "triangle-list";
const DEFAULT_SHADOW_CAST_CULL_MODE = "back";
// `ShadowMap` point passes are ordered -X,-Y,-Z,+X,+Y,+Z, while WebGPU cube
// layers are +X,-X,+Y,-Y,+Z,-Z. This mapping keeps cast attachments aligned
// with direction-based cube sampling.
const POINT_LIGHT_PASS_TO_CUBE_LAYER = Object.freeze([1, 3, 5, 0, 2, 4]);

function getPointLightCubeLayer(passIndex) {
  return POINT_LIGHT_PASS_TO_CUBE_LAYER[passIndex];
}

function isTerrainShadowCaster(command) {
  return command?.pass === Pass.GLOBE;
}

/**
 * Creates shadow map depth texture and render target.
 * @private
 */
function createShadowMapTexture(device, size) {
  const texture = device.createTexture({
    label: "Shadow map depth",
    size: [size, size, 1],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  const sampler = device.createSampler({
    label: "Shadow map comparison sampler",
    compare: "less",
    magFilter: "linear",
    minFilter: "linear",
  });

  return { texture, sampler };
}

/**
 * Creates a cube-depth shadow map for point lights.
 *
 * Point lights cast shadows omnidirectionally, so the cast pass draws
 * the scene 6 times (one per cube face) into 6 depth layers. Sampling
 * in the color pass uses the cube view, which picks the correct face
 * by ray direction. The 6 per-face views are kept for the cast pass's
 * `depthStencilAttachment.view`.
 *
 * Matches WebGL's `ShadowMap.js:487-498` numberOfPasses = 6 + the
 * per-face camera / culling volume setup.
 * @private
 */
function createPointLightCubeShadowMap(device, size) {
  const texture = device.createTexture({
    label: "Shadow map cube depth (point light)",
    size: [size, size, 6],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });

  // Per-face views for cast-time depthStencilAttachment binding.
  const faceViews = new Array(6);
  for (let i = 0; i < 6; i++) {
    faceViews[i] = texture.createView({
      label: `Shadow cube face ${i} view`,
      dimension: "2d",
      baseArrayLayer: i,
      arrayLayerCount: 1,
      aspect: "depth-only",
    });
  }

  // Cube view for the color pass's point-shadow receive shader. Directional
  // and spot receivers continue to use the separate 2D binding.
  const cubeView = texture.createView({
    label: "Shadow cube view (point light)",
    dimension: "cube",
    aspect: "depth-only",
  });

  const sampler = device.createSampler({
    label: "Shadow cube comparison sampler",
    compare: "less",
    magFilter: "linear",
    minFilter: "linear",
  });

  return { texture, faceViews, cubeView, sampler };
}

// Shadow cast pipeline registry.
// Different vertex layouts (RTE primitives, single-position models, quantized
// terrain, instanced) can't share one shadow cast pipeline because WebGPU
// pipelines bake in the vertex buffer layout. Each entry registers:
//   - A WGSL fragment producing the vertex shader body (must declare its own
//     @vertex fn vs returning @builtin(position) and applying u.depthBias)
//   - A vertex buffer layout descriptor matching that shader's @location(s)
//
// Commands declare which key to use via `cmd._shadowCastLayout` (preferred)
// or fall back to `_inferShadowLayoutKey()` which sniffs vertexStride.
// Unknown layouts are skipped silently after a one-time warning.

/**
 * @typedef {object} ShadowCastVariant
 * @property {string} vsCode - WGSL vertex shader body. Must declare
 *   `@vertex fn vs(...) -> @builtin(position) vec4<f32>` and apply
 *   `u.depthBias` to the Z coordinate. `u.lightVP` transforms
 *   scene-camera-relative world coordinates into the light's clip space.
 *   Any additional bind group bindings beyond `u` at @group(0) @binding(0)
 *   should reference the bindings declared in `extraBindings` below.
 * @property {GPUVertexBufferLayout[]} buffers - Vertex buffer layout
 *   array exactly matching the commands this variant targets.
 * @property {GPUBindGroupLayoutEntry[]} [extraBindings] - Additional
 *   bind-group-layout entries beyond the default lightVP uniform at
 *   binding 0. Each entry describes a per-command binding (e.g., a
 *   model matrix UB at binding 1).
 * @property {string[]} [perCommandBindingFields] - Parallel array to
 *   `extraBindings`. For each extra binding, names the field on the
 *   WebGPUDrawCommand to read the GPUBuffer from. If the command
 *   doesn't have that field the command is skipped (the renderer that
 *   owns the command must provide it — see usage in
 *   WebGPUModelRenderer / WebGPUGlobeSurfaceRenderer shadow paths).
 */

const SHADOW_CAST_VARIANTS = {
  // World-space RTE geometry: positionHigh + positionLow, stride 24, two
  // float32x3 attributes. Generic Primitive geometry uses primitiveRte24
  // below because its encoded positions remain in Primitive/model space.
  rte24: {
    vsCode: `
@vertex fn vs(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rte = (pH - u.camH) + (pL - u.camL);
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
        ],
      },
    ],
  },
  // Generic Primitive RTE positions are encoded in primitive/model space, not
  // necessarily world space. Binding 1 carries the Primitive.modelMatrix
  // linear part plus the scene camera encoded in that same coordinate system.
  // Keeping the world-scale translation out of f32 makes translation,
  // rotation, and nonuniform scale follow the color path without sacrificing
  // the plain `rte24` route used by truly world-space command producers.
  primitiveRte24: {
    vsCode: `
struct PrimitiveShadowUniforms {
  modelLinear: mat4x4<f32>,
  cameraMCHigh: vec4<f32>,
  cameraMCLow: vec4<f32>,
};
@group(0) @binding(1) var<uniform> p: PrimitiveShadowUniforms;
@vertex fn vs(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rteMC = (pH - p.cameraMCHigh.xyz) + (pL - p.cameraMCLow.xyz);
  let rteWC = (p.modelLinear * vec4f(rteMC, 0.0)).xyz;
  var pos = u.lightVP * vec4f(rteWC, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" },
          { shaderLocation: 1, offset: 12, format: "float32x3" },
        ],
      },
    ],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
    ],
    perCommandBindingFields: ["_shadowCastPrimitiveUB"],
  },
  // Non-RTE single-position world-space: one float32x3 at offset 0,
  // stride 12. Assumes the caller already wrote world coordinates.
  // Used by small objects near origin, debug primitives, and ad-hoc
  // world-space meshes. The position itself is not split, but it must
  // still be rebased around the scene camera before applying lightVP.
  p12: {
    vsCode: `
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rte = (p - u.camH) - u.camL;
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      },
    ],
  },
  // Model-space positions + per-command model matrix. Targets the
  // WebGPUModelRenderer path, where glTF positions live in model space
  // (stride 12 in slot 0 of WebGPUModelPipelineCache's 7-buffer layout)
  // and a modelMatrix uniform lifts them to world space. This variant
  // adds a second UBO at binding 1 containing the model matrix; the
  // renderer owns the buffer via `cmd._shadowCastModelUB`.
  modelP12: {
    vsCode: `
struct ModelShadowUniforms {
  modelLinear: mat4x4<f32>,
  cameraMCHigh: vec4<f32>,
  cameraMCLow: vec4<f32>,
};
@group(0) @binding(1) var<uniform> m: ModelShadowUniforms;
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let rteMC = (-m.cameraMCHigh.xyz) + (p - m.cameraMCLow.xyz);
  let rteWC = (m.modelLinear * vec4f(rteMC, 0.0)).xyz;
  var pos = u.lightVP * vec4f(rteWC, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      },
    ],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
    ],
    perCommandBindingFields: ["_shadowCastModelUB"],
  },
  // Skinned model path. Matches Cesium's skinning architecture:
  // joints0 (vec4<u32>) + weights0 (vec4<f32>) per-vertex, with a
  // packed joint matrix palette in a storage buffer. The shadow
  // shader reproduces the exact skin math from ModelPBRComplete.wgsl
  // so casted shadows match the deformed geometry.
  //
  // The color pass puts joints at slot 5 and weights at slot 6 of its
  // 7-buffer layout. Shadow cast uses a compact 0/1/2 layout and the
  // render loop pulls from the command's vertex buffer array via the
  // `vertexBufferSourceSlots` map below.
  modelSkinned: {
    vsCode: `
struct ModelShadowUniforms {
  modelLinear: mat4x4<f32>,
  cameraMCHigh: vec4<f32>,
  cameraMCLow: vec4<f32>,
};
@group(0) @binding(1) var<uniform> m: ModelShadowUniforms;
@group(0) @binding(2) var<storage, read> jointMatrices: array<mat4x4<f32>>;

@vertex fn vs(
  @location(0) p: vec3<f32>,
  @location(1) joints0: vec4<u32>,
  @location(2) weights0: vec4<f32>,
) -> @builtin(position) vec4<f32> {
  // Exactly matches ModelPBRComplete.wgsl skinning block so the
  // shadow positions track the deformed mesh:
  //   skinMatrix = w.x*J[j.x] + w.y*J[j.y] + w.z*J[j.z] + w.w*J[j.w]
  let skinMatrix = weights0.x * jointMatrices[joints0.x]
                 + weights0.y * jointMatrices[joints0.y]
                 + weights0.z * jointMatrices[joints0.z]
                 + weights0.w * jointMatrices[joints0.w];
  let skinnedPos = (skinMatrix * vec4f(p, 1.0)).xyz;
  let rteMC = (-m.cameraMCHigh.xyz)
            + (skinnedPos - m.cameraMCLow.xyz);
  let rteWC = (m.modelLinear * vec4f(rteMC, 0.0)).xyz;
  var pos = u.lightVP * vec4f(rteWC, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 12,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      },
      {
        arrayStride: 16,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 1, offset: 0, format: "uint32x4" }],
      },
      {
        arrayStride: 16,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 2, offset: 0, format: "float32x4" }],
      },
    ],
    // Index into the command's `vertexBuffers[]` array, parallel to
    // the `buffers` list above. Cesium's model renderer puts pos at
    // slot 0, joints at slot 5, weights at slot 6 of the 7-slot
    // ModelPipelineCache layout; shadow cast pulls those three and
    // binds them at its own compact slots 0/1/2.
    vertexBufferSourceSlots: [0, 5, 6],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
      {
        binding: 2,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "read-only-storage" },
      },
    ],
    perCommandBindingFields: [
      "_shadowCastModelUB",
      "_shadowCastJointMatricesSB",
    ],
  },
  // Storage-buffer model instancing matches Cesium's WebGPU architecture.
  // Per-instance matrices live in the color pass's group 5; shadow casting
  // rebinds that buffer at group 0 binding 2 and indexes it through
  // `@builtin(instance_index)`.
  //
  // Binding 1 carries the node base-model matrix used by `modelP12`. Binding
  // 2 carries per-instance transform storage from
  // `WebGPUModelInstancing.ensureInstancingResources`. The model renderer
  // tags instanced commands with this variant and both buffers.
  modelInstancedSB: {
    vsCode: `
struct ModelShadowUniforms {
  modelLinear: mat4x4<f32>,
  cameraMCHigh: vec4<f32>,
  cameraMCLow: vec4<f32>,
};
// DP-H36 (Batch 325) — per-instance element matches the color pass's
// InstanceTransform layout: linear mat4x4 (rotation+scale, col3 zeroed)
// + translationHigh/Low vec4. MUST stay byte-consistent with
// FLOATS_PER_INSTANCE (WebGPUModelInstancing.js, 24 floats / 96 bytes).
struct InstanceTransform {
  linear: mat4x4<f32>,
  translationHigh: vec4<f32>,
  translationLow: vec4<f32>,
};
@group(0) @binding(1) var<uniform> m: ModelShadowUniforms;
@group(0) @binding(2) var<storage, read> instanceMatrices: array<InstanceTransform>;

@vertex fn vs(
  @location(0) p: vec3<f32>,
  @builtin(instance_index) iidx: u32,
) -> @builtin(position) vec4<f32> {
  // Match the color path's model-space RTE exactly: keep the instance
  // translation split until it cancels the encoded model-space camera, add
  // the small local vertex afterward, then rotate/scale the relative vector
  // into camera-relative world coordinates without a translation column.
  let inst = instanceMatrices[iidx];
  let linear3 = mat3x3<f32>(inst.linear[0].xyz, inst.linear[1].xyz, inst.linear[2].xyz);
  let rteMC = (inst.translationHigh.xyz - m.cameraMCHigh.xyz)
            + (inst.translationLow.xyz - m.cameraMCLow.xyz)
            + linear3 * p;
  let rteWC = (m.modelLinear * vec4f(rteMC, 0.0)).xyz;
  var pos = u.lightVP * vec4f(rteWC, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 12,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      },
    ],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
      {
        binding: 2,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "read-only-storage" },
      },
    ],
    perCommandBindingFields: ["_shadowCastModelUB", "_shadowCastInstancingSB"],
  },
  // Classic per-instance vertex-buffer instancing uses the canonical glTF
  // `EXT_mesh_gpu_instancing` layout: four float32x4 values per instance with
  // a 64-byte stride. Cesium model paths use the storage-buffer variant;
  // third-party renderers with an instance vertex buffer can select this one
  // through `_shadowCastLayout = "modelInstanced"`.
  modelInstanced: {
    vsCode: `
@vertex fn vs(
  @location(0) p: vec3<f32>,
  @location(1) col0: vec4<f32>,
  @location(2) col1: vec4<f32>,
  @location(3) col2: vec4<f32>,
  @location(4) col3: vec4<f32>,
) -> @builtin(position) vec4<f32> {
  let modelMatrix = mat4x4<f32>(col0, col1, col2, col3);
  let worldPos = (modelMatrix * vec4f(p, 1.0)).xyz;
  // RTE-preserving subtraction (see modelP12 comment). At planetary
  // scale the naive 'worldPos - (camH+camL)' discards ~1 meter of
  // precision; the split subtract keeps f32 arithmetic well-conditioned.
  let rte = (worldPos - u.camH) - u.camL;
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 12,
        stepMode: "vertex",
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
      },
      {
        arrayStride: 64,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 16, format: "float32x4" },
          { shaderLocation: 3, offset: 32, format: "float32x4" },
          { shaderLocation: 4, offset: 48, format: "float32x4" },
        ],
      },
    ],
  },
  // Quantized terrain (TerrainQuantization.BITS12): each vertex has
  // `compressed0: vec4<f32>` at location 0 packing (compressedXY,
  // compressedZH, compressedUV, encodedNormal). Shadow casting only
  // needs the position, so we decode xy + zh, apply scaleAndBias, add
  // the tile center, and RTE-encode. The scaleAndBias matrix + center
  // come from a per-command UB at binding 1 populated by the globe
  // surface renderer (`cmd._shadowCastTerrainUB`).
  quantized12: {
    vsCode: `
struct TerrainShadowUniforms {
  scaleAndBias: mat4x4<f32>,
  center3D: vec3<f32>,
  _pad0: f32,
  minMaxHeight: vec2<f32>,
  _pad1: vec2<f32>,
};
@group(0) @binding(1) var<uniform> t: TerrainShadowUniforms;

// Scene-wide exaggeration controls. Shared across every tile in a
// shadow cast pass so the per-tile UB can stay static (written once
// on tile load). Values mirror the color-pass convention:
//   exaggeration.x = vertical scale (1.0 = none)
//   exaggeration.y = relativeHeight reference (typically 0)
//   sceneMode: 0=MORPH, 1=COLUMBUS, 2=2D, 3=3D. Exaggeration only
//     applies in 3D (mode > 2.5) — matches GlobeTerrain.wgsl's check.
struct TerrainShadowGlobals {
  exaggeration: vec2<f32>,
  sceneMode: f32,
  _pad: f32,
};
@group(0) @binding(2) var<uniform> g: TerrainShadowGlobals;

const EARTH_RADIUS: f32 = 6378137.0;

// Matches czm_decompressTextureCoordinates — unpack a packed 24-bit
// (2×12-bit) value from a f32 into two f32s in [0,1].
fn decompressTC(c: f32) -> vec2<f32> {
  let temp = c / 256.0;
  let xFrac = floor(temp);
  let yFrac = c - 256.0 * xFrac;
  return vec2<f32>(xFrac / 255.0, yFrac / 255.0);
}

@vertex fn vs(@location(0) compressed0: vec4<f32>) -> @builtin(position) vec4<f32> {
  let xy = decompressTC(compressed0.x);
  let zh = decompressTC(compressed0.y);
  let scaledPos = vec3f(xy.x, xy.y, zh.x);
  var tileRelPos = (t.scaleAndBias * vec4f(scaledPos, 1.0)).xyz;

  // Apply vertical exaggeration — must match the color pass exactly
  // so shadows line up with the stretched terrain. The exaggeration
  // direction is the ellipsoid normal at this point's world position,
  // so we reconstruct worldPos temporarily to get that direction.
  let exagg = g.exaggeration.x;
  if (exagg != 1.0 && g.sceneMode > 2.5) {
    let position3D = tileRelPos + t.center3D;
    let ellipsoidNormal = normalize(position3D);
    let surfaceHeight = length(position3D) - EARTH_RADIUS;
    let relativeHeight = g.exaggeration.y;
    let newHeight = (surfaceHeight - relativeHeight) * exagg + relativeHeight;
    let clampedHeight = max(newHeight, -EARTH_RADIUS * 0.5);
    let offset = ellipsoidNormal * (clampedHeight - surfaceHeight);
    tileRelPos = tileRelPos + offset;
  }

  // RTE-preserving arithmetic. center3D is world-scale (~6M) and so is
  // camH; their difference is small enough to fit in f32 with good
  // precision. tileRelPos (≤10km) and camL (≤1m) are small residuals
  // that combine without loss.
  let rte = (t.center3D - u.camH) + tileRelPos - u.camL;
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        arrayStride: 16,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
      },
    ],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
      {
        binding: 2,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
    ],
    perCommandBindingFields: [
      "_shadowCastTerrainUB",
      "_shadowCastTerrainGlobalsUB",
    ],
  },
  // Uncompressed terrain mirrors `quantized12` structurally, but its
  // position does not use BITS12 decoding. The globe stores the float32x4
  // `position3DAndHeight` at offset 0. Texture coordinates and optional
  // normals extend the stride without moving it. Callers use `overrideStride`
  // for 24-, 28-, 32-, 36-, 40-, or 44-byte layouts.
  //
  // The `rte24` variant is not a valid fallback: its vec3 reads at offsets 0
  // and 12 would interpret `(height, u, v)` as `positionLow`, producing
  // shadow coordinates unrelated to the terrain surface.
  terrainUncompressed: {
    vsCode: `
struct TerrainShadowUniforms {
  scaleAndBias: mat4x4<f32>,
  center3D: vec3<f32>,
  _pad0: f32,
  minMaxHeight: vec2<f32>,
  _pad1: vec2<f32>,
};
@group(0) @binding(1) var<uniform> t: TerrainShadowUniforms;

struct TerrainShadowGlobals {
  exaggeration: vec2<f32>,
  sceneMode: f32,
  _pad: f32,
};
@group(0) @binding(2) var<uniform> g: TerrainShadowGlobals;

const EARTH_RADIUS: f32 = 6378137.0;

@vertex fn vs(@location(0) position3DAndHeight: vec4<f32>) -> @builtin(position) vec4<f32> {
  // Tile-relative position lives in the first 3 components. The
  // uncompressed VB stores it already in meters (no BITS12 scaling
  // needed), so we don't apply \`scaleAndBias\`; keep the UB layout
  // identical to \`quantized12\` for reuse of the tile/globals UBs
  // from the globe surface renderer, but this branch just reads xyz.
  var tileRelPos = position3DAndHeight.xyz;

  // Apply vertical exaggeration — must match the color pass exactly.
  // The exaggeration direction is the ellipsoid normal at this point's
  // world position (reconstructed temporarily for the compare).
  let exagg = g.exaggeration.x;
  if (exagg != 1.0 && g.sceneMode > 2.5) {
    let position3D = tileRelPos + t.center3D;
    let ellipsoidNormal = normalize(position3D);
    let surfaceHeight = length(position3D) - EARTH_RADIUS;
    let relativeHeight = g.exaggeration.y;
    let newHeight = (surfaceHeight - relativeHeight) * exagg + relativeHeight;
    let clampedHeight = max(newHeight, -EARTH_RADIUS * 0.5);
    let offset = ellipsoidNormal * (clampedHeight - surfaceHeight);
    tileRelPos = tileRelPos + offset;
  }

  // RTE-preserving arithmetic — same pattern as \`quantized12\`.
  let rte = (t.center3D - u.camH) + tileRelPos - u.camL;
  var pos = u.lightVP * vec4f(rte, 1.0);
  pos.z += u.depthBias;
  return pos;
}`,
    buffers: [
      {
        // Default stride matches the minimum uncompressed terrain case
        // (position3DAndHeight + tex coords = 24 bytes). Larger strides
        // (with normals / webMercT / geodetic) arrive via
        // `overrideStride` at pipeline build time.
        arrayStride: 24,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
      },
    ],
    extraBindings: [
      {
        binding: 1,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
      {
        binding: 2,
        visibility: 1 /* GPUShaderStage.VERTEX */,
        buffer: { type: "uniform" },
      },
    ],
    perCommandBindingFields: [
      "_shadowCastTerrainUB",
      "_shadowCastTerrainGlobalsUB",
    ],
  },
};

const _shadowLayoutWarned = new Set();

// Snapshot of the built-in shadow cast variant keys, captured at module
// load before any `registerShadowCastVariant` call can add to the table.
// Used by `_resetShadowCastVariantRegistryForSpec` so tests can strip
// test-added entries without clobbering the built-ins renderers depend on.
const _BUILTIN_SHADOW_CAST_VARIANT_KEYS = Object.freeze(
  Object.keys(SHADOW_CAST_VARIANTS).slice(),
);

/**
 * Maps a command's vertex configuration to a registered shadow cast layout
 * key. Returns null when no compatible cast pipeline exists for the command.
 * Logs once per unknown stride to avoid console spam.
 * @private
 */
function _inferShadowLayoutKey(cmd, vbStride) {
  // Explicit override on the command always wins.
  if (defined(cmd._shadowCastLayout)) {
    return cmd._shadowCastLayout;
  }
  // Stride-24 = canonical RTE primitive layout (positionHigh + positionLow).
  if (vbStride === 24 || !defined(vbStride)) {
    return "rte24";
  }
  // Stride-12 = single-vec3 world-space position. Second most common
  // layout after RTE — covers non-RTE models and debug primitives.
  // Renderers using `modelP12` or `modelInstanced` must set
  // `cmd._shadowCastLayout`, because stride 12 alone cannot distinguish
  // world-space from model-space positions.
  if (vbStride === 12) {
    return "p12";
  }
  // Stride-16 = BITS12 quantized terrain (compressed0 vec4). Globe
  // surface renderer wires its own UB via cmd._shadowCastTerrainUB,
  // but the inference is still useful when the caller forgets to set
  // the explicit layout override.
  if (vbStride === 16) {
    return "quantized12";
  }
  if (!_shadowLayoutWarned.has(vbStride)) {
    _shadowLayoutWarned.add(vbStride);
    //>>includeStart('debug', pragmas.debug);
    console.warn(
      `[WebGPUShadowMap] No shadow cast pipeline registered for vertex stride ${vbStride}. ` +
        `Commands with this layout will be skipped. See SHADOW-LAYOUT in the migration backlog.`,
    );
    //>>includeEnd('debug');
  }
  return null;
}

/**
 * Test-only hook — resets the "warned once" dedupe set so specs can
 * verify the warning path fires deterministically. Not exported on the
 * default object; only reachable through the named export.
 * @private
 */
function _resetShadowLayoutWarningsForSpec() {
  _shadowLayoutWarned.clear();
}

/**
 * Test-only hook that removes test-added shadow cast variants so the registry
 * returns to its module-load state. It mirrors
 * `_resetShadowLayoutWarningsForSpec`, allowing specs to isolate a fresh
 * registry in `afterEach` without leaking test keys across Jasmine blocks.
 * Built-in keys (`rte24`, `p12`, `modelP12`, and others) remain registered
 * because renderers expect them.
 * @private
 */
function _resetShadowCastVariantRegistryForSpec() {
  const builtin = new Set(_BUILTIN_SHADOW_CAST_VARIANT_KEYS);
  for (const key of Object.keys(SHADOW_CAST_VARIANTS)) {
    if (!builtin.has(key)) {
      delete SHADOW_CAST_VARIANTS[key];
    }
  }
}

const SHADOW_CAST_BIND_GROUP_PREFIX = `
struct U { lightVP: mat4x4<f32>, camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32,
  depthBias: f32, normalBias: f32, _p2: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
@fragment fn fs() {}
`;

function getShadowCastTopology(command) {
  return command?._shadowCastTopology ?? DEFAULT_SHADOW_CAST_TOPOLOGY;
}

/**
 * Return the strip-index half of the topology axis. WebGPU derives a strip's
 * implicit primitive-restart value from its index format, so uint16 and
 * uint32 casters require different pipelines. Producers set this alongside
 * `_shadowCastTopology`; non-strip pipelines leave it undefined.
 *
 * @private
 */
function getShadowCastStripIndexFormat(command) {
  return command?._shadowCastStripIndexFormat;
}

function getShadowCastCullMode(command, invertWinding = false) {
  const explicit = command?._shadowCastCullMode;
  let cullMode;
  if (explicit === "none" || explicit === "back" || explicit === "front") {
    cullMode = explicit;
  } else {
    const cull = command?.renderState?.cull;
    cullMode = cull?.enabled === false ? "none" : DEFAULT_SHADOW_CAST_CULL_MODE;
  }
  // WebGL ShadowMap derives every enabled caster against the shadow map's
  // back-face render state; it only inherits the source command's enabled/
  // disabled bit (ShadowMap.js createCastDerivedCommand). Do not copy a color
  // pipeline's front-face choice into the depth caster.
  if (!invertWinding || cullMode === "none") {
    return cullMode;
  }
  return cullMode === "back" ? "front" : "back";
}

/**
 * Build the cast-pipeline cache key. Its topology segment comes from
 * `modelTopologyAxisToken`, the same source used by model color keys, so the
 * two paths cannot encode the axis differently.
 *
 * `triangle-list` appends `|ttriangle-list`. A strip also appends its index
 * format, so uint16 and uint32 `triangle-strip` casters cannot share an entry.
 *
 * @private
 */
function getShadowCastPipelineCacheKey(
  layoutKey,
  stride,
  topology,
  cullMode,
  stripIndexFormat,
) {
  const axis = modelTopologyAxisToken(
    modelTopologyRealizationFrom(topology, stripIndexFormat),
  );
  return `${layoutKey}|s${stride}|t${axis}|c${cullMode}`;
}

/**
 * Builds (and caches) the shadow cast pipeline for a given layout variant.
 * Pipelines are cached on the shadow map's `_webgpuCache.castPipelines` Map
 * keyed by layout, stride, topology, and cull mode, so each shadow map only
 * pays creation cost once per pipeline-baked state tuple it encounters.
 *
 * The optional `overrideStride` replaces the first vertex buffer's declared
 * `arrayStride`. Some callers append per-vertex data after the position, such
 * as uncompressed terrain layouts spanning 28 to 44 bytes. Without the
 * override, WebGPU would use the variant's default stride and misalign every
 * vertex after the first.
 *
 * @private
 */
function _getOrCreateCastPipeline(
  device,
  cache,
  layoutKey,
  overrideStride,
  topology = DEFAULT_SHADOW_CAST_TOPOLOGY,
  cullMode = DEFAULT_SHADOW_CAST_CULL_MODE,
  // Required for `line-strip` and `triangle-strip`, and undefined otherwise.
  stripIndexFormat = undefined,
) {
  if (!defined(cache.castPipelines)) {
    cache.castPipelines = new Map();
    cache.castBindGroups = new Map();
  }
  const variant = SHADOW_CAST_VARIANTS[layoutKey];
  if (!defined(variant)) {
    return null;
  }

  // Work out the effective arrayStride for the first vertex buffer. Variants
  // that don't set `overrideStride` fall back to their declared stride.
  const declaredStride = variant.buffers?.[0]?.arrayStride ?? 0;
  const effectiveStride = defined(overrideStride)
    ? overrideStride
    : declaredStride;
  const strideDiffers = effectiveStride !== declaredStride;
  const castTopology = modelTopologyRealizationFrom(topology, stripIndexFormat);
  const effectiveKey = getShadowCastPipelineCacheKey(
    layoutKey,
    effectiveStride,
    topology,
    cullMode,
    stripIndexFormat,
  );

  let entry = cache.castPipelines.get(effectiveKey);
  if (defined(entry)) {
    return entry;
  }

  const mod = device.createShaderModule({
    label: `Shadow cast (${effectiveKey})`,
    code: SHADOW_CAST_BIND_GROUP_PREFIX + variant.vsCode,
  });
  // Build the BGL. Binding 0 is always the shared lightVP/camera UB
  // (`u` in the shader prefix). Variants that need additional
  // per-command bindings (model matrix, tile uniforms) list them in
  // `extraBindings`, which are appended after the shared entry.
  const bindGroupLayoutEntries = [uniformBuffer(0, Stage.VERTEX)];
  if (defined(variant.extraBindings)) {
    for (const eb of variant.extraBindings) {
      bindGroupLayoutEntries.push(eb);
    }
  }
  const bgl = makeBindGroupLayout(
    device,
    `Shadow cast BGL (${effectiveKey})`,
    bindGroupLayoutEntries,
  );

  // Shallow-clone the buffer layouts when overriding so the shared
  // `SHADOW_CAST_VARIANTS` entry remains immutable.
  let buffers = variant.buffers;
  if (strideDiffers) {
    buffers = variant.buffers.map((buf, idx) =>
      idx === 0 ? { ...buf, arrayStride: effectiveStride } : buf,
    );
  }

  const pipeline = device.createRenderPipeline({
    label: `Shadow cast pipeline (${effectiveKey})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: "vs", buffers },
    fragment: { module: mod, entryPoint: "fs", targets: [] },
    // Use the model color pipeline's topology builder so topology and strip
    // index format are emitted together.
    primitive: modelPrimitiveState(castTopology, cullMode),
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      // `less-equal` for planetary-scale precision robustness — the
      // CSM far cascades can project shadow casters onto the cascade
      // far plane and `less` would discard them.
      depthCompare: "less-equal",
    },
  });

  entry = { pipeline, bgl, cacheKey: effectiveKey };
  cache.castPipelines.set(effectiveKey, entry);
  return entry;
}

/**
 * Registers an additional shadow cast variant (called from outside this
 * module by renderers that need a specialized vertex layout — e.g.,
 * quantized terrain or model PBR). Variants registered after the first
 * shadow cast pass will be picked up on the next pass.
 *
 * @param {string} key Unique layout name, also used as
 *                     `cmd._shadowCastLayout`.
 * @param {{vsCode: string, buffers: Array<GPUVertexBufferLayout>}} variant
 */
function registerShadowCastVariant(key, variant) {
  SHADOW_CAST_VARIANTS[key] = variant;
}

/**
 * Returns the list of currently-registered shadow cast layout keys.
 * Useful for diagnostics, tests, and visualizing which variants a renderer
 * has actually wired up.
 * @returns {string[]}
 */
function getRegisteredShadowCastVariantKeys() {
  return Object.keys(SHADOW_CAST_VARIANTS);
}

/**
 * Returns the registered variant descriptor for a given layout key, or
 * undefined if no such variant is registered. Exported for
 * `WebGPUCSMRenderer` so the CSM cast loop can read the same
 * `extraBindings` / `perCommandBindingFields` / `vertexBufferSourceSlots`
 * metadata as the single-shadow-map loop without duplicating the table.
 * The returned descriptor is shared by both paths and must be treated as
 * read-only.
 * @param {string} key
 * @returns {ShadowCastVariant | undefined}
 */
function getShadowCastVariant(key) {
  return SHADOW_CAST_VARIANTS[key];
}

/**
 * Initializes or updates WebGPU shadow map resources.
 * @param {ShadowMap} shadowMap
 * @param {FrameState} frameState
 */
function initWebGPUShadowMap(shadowMap, frameState) {
  if (!shadowMap.enabled) {
    return;
  }

  // Entity-driven shadow allocation can run before the first scene render,
  // when `frameState.context` is absent or transient. Leave initialization
  // pending in that case so a later frame can retry with the WebGPU context.
  const context = frameState?.context;
  if (!context) {
    return;
  }
  const device = context.device ?? context._device;
  if (!device) {
    return;
  }

  if (!defined(shadowMap._webgpuCache)) {
    shadowMap._webgpuCache = {};
  }
  const cache = shadowMap._webgpuCache;

  // Create the shadow texture once. Directional and spot lights use one 2D
  // depth target; point lights use six cube layers so casting can render each
  // face and receiving can sample by ray direction.
  if (!defined(cache.depthTexture)) {
    const size = shadowMap._textureSize?.x || SHADOW_MAP_SIZE;
    if (shadowMap._isPointLight) {
      const result = createPointLightCubeShadowMap(device, size);
      cache.depthTexture = result.texture;
      cache.cubeFaceViews = result.faceViews;
      cache.cubeDepthView = result.cubeView;
      // Keep `depthTextureView` populated with the first face for callers
      // that require a 2D view. `WebGPUEffectsBindGroup.js` detects point
      // lights through `_isPointLight` and `cache.cubeDepthView`, binds the
      // cube view at binding 17, and routes model and globe receivers through
      // `samplePointShadow`; binding 1 is not sampled on that path.
      cache.depthTextureView = result.faceViews[0];
      cache.comparisonSampler = result.sampler;
      cache.size = size;
      cache.isCube = true;
    } else {
      const result = createShadowMapTexture(device, size);
      cache.depthTexture = result.texture;
      cache.depthTextureView = result.texture.createView();
      cache.comparisonSampler = result.sampler;
      cache.size = size;
      cache.isCube = false;
    }
  }

  // Create cast pipelines lazily in `_getOrCreateCastPipeline` so each shadow
  // map pays only for the vertex-layout variants it encounters.

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      SHADOW_UNIFORM_SIZE,
      "Shadow uniforms",
    );
    cache.uniformData = new Float32Array(SHADOW_UNIFORM_SIZE / 4);
  }
  // Point faces are encoded into one command buffer and submitted together.
  // Rewriting one UBO six times before submit makes every pass observe the
  // final face matrix, so each face owns persistent uniform contents
  // and a no-extra-bindings cache. Directional/spot maps pay none of this.
  if (cache.isCube && !defined(cache.pointFaceUniformBuffers)) {
    cache.pointFaceUniformBuffers = new Array(6);
    cache.pointFaceUniformData = new Array(6);
    cache.pointFaceCastBindGroups = new Array(6);
    for (let i = 0; i < 6; i++) {
      cache.pointFaceUniformBuffers[i] = WebGPUBuffer.createUniformBuffer(
        device,
        SHADOW_UNIFORM_SIZE,
        `Point shadow face ${i} uniforms`,
      );
      cache.pointFaceUniformData[i] = new Float32Array(SHADOW_UNIFORM_SIZE / 4);
      cache.pointFaceCastBindGroups[i] = new Map();
    }
  }

  // Scene-wide terrain shadow globals (exaggeration + sceneMode).
  // Small (16 bytes) and shared across all terrain tiles in this
  // shadow map's cast pass. See SHADOW_CAST_VARIANTS.quantized12 for
  // the struct layout. Updating the exaggeration at runtime (e.g. via
  // `viewer.scene.verticalExaggeration`) just rewrites the 16 bytes
  // on the next frame.
  if (!defined(cache.terrainGlobalsUB)) {
    cache.terrainGlobalsUB = WebGPUBuffer.createUniformBuffer(
      device,
      16,
      "Shadow terrain globals",
    );
    cache.terrainGlobalsData = new Float32Array(4);
  }
}

function ensureTerrainShadowCastUniforms(device, cache) {
  if (defined(cache.terrainCastUniformBuffer)) {
    return;
  }
  cache.terrainCastUniformBuffer = WebGPUBuffer.createUniformBuffer(
    device,
    SHADOW_UNIFORM_SIZE,
    "Shadow terrain uniforms",
  );
  cache.terrainCastUniformData = new Float32Array(SHADOW_UNIFORM_SIZE / 4);
  cache.terrainCastBindGroups = new Map();
}

function computeShadowCastRteMatrix(
  lightCamera,
  sceneCameraPositionWC,
  result,
  viewMatrix = lightCamera.viewMatrix,
) {
  const frustum = lightCamera.frustum;
  const projection =
    typeof frustum.getProjectionMatrix === "function"
      ? frustum.getProjectionMatrix(lightCamera.clipSpaceConvention)
      : frustum.projectionMatrix;

  Matrix4.multiply(projection, viewMatrix, scratchLightViewProjection);
  // Cast shaders emit scene-camera-relative world coordinates. Reintroduce
  // that origin in double precision before the matrix is packed to f32.
  Matrix4.fromTranslation(sceneCameraPositionWC, scratchCameraTranslation);
  return Matrix4.multiply(
    scratchLightViewProjection,
    scratchCameraTranslation,
    result,
  );
}

const scratchShadowCastMatrix = new Matrix4();
const scratchPointShadowViewMatrix = new Matrix4();

function resolveShadowCastCameraPosition(frameState) {
  return (
    frameState?.context?.uniformState?.cameraPosition ??
    frameState?.camera?.positionWC
  );
}

/**
 * Computes the native WebGPU point-shadow cast transform for one shared
 * `ShadowMap` cube-face camera.
 *
 * Cesium's shared point cameras retain WebGL's bottom-left cube-face
 * convention. WebGPU render attachments use a top-left framebuffer origin,
 * while `texture_depth_cube` lookup follows the face basis used by the
 * repository's dynamic-environment capture. Negating the camera view's Y row
 * mirrors only the rendered face vertically, preserving the shared WebGL
 * cameras and their frustum volumes. The corresponding winding reflection is
 * handled by `getShadowCastCullMode(command, true)` in the point pass.
 *
 * @private
 */
function computeWebGPUPointShadowCastRteMatrix(
  lightCamera,
  sceneCameraPositionWC,
  result,
) {
  Matrix4.clone(lightCamera.viewMatrix, scratchPointShadowViewMatrix);
  scratchPointShadowViewMatrix[1] = -scratchPointShadowViewMatrix[1];
  scratchPointShadowViewMatrix[5] = -scratchPointShadowViewMatrix[5];
  scratchPointShadowViewMatrix[9] = -scratchPointShadowViewMatrix[9];
  scratchPointShadowViewMatrix[13] = -scratchPointShadowViewMatrix[13];
  return computeShadowCastRteMatrix(
    lightCamera,
    sceneCameraPositionWC,
    result,
    scratchPointShadowViewMatrix,
  );
}

function packShadowCastMatrix(
  data,
  lightCamera,
  sceneCameraPositionWC,
  webgpuPointFace = false,
) {
  const computeMatrix = webgpuPointFace
    ? computeWebGPUPointShadowCastRteMatrix
    : computeShadowCastRteMatrix;
  computeMatrix(lightCamera, sceneCameraPositionWC, scratchShadowCastMatrix);
  Matrix4.pack(scratchShadowCastMatrix, data, 0);
}

/**
 * Packs shadow cast uniforms.
 * @private
 */
function packShadowCastBias(data, shadowMap, isTerrain = false) {
  // Point shadows apply `_pointBias.depthBias` once during cube receive, just
  // like WebGL; adding caster bias here would double-bias the comparison.
  // Directional/spot native casting keeps separate primitive and terrain
  // payloads because the shared renderer gives those families different
  // separation values.
  const isPointLight = shadowMap._isPointLight === true;
  const bias = isTerrain
    ? (shadowMap._terrainBias ?? shadowMap._primitiveBias ?? {})
    : (shadowMap._primitiveBias ?? shadowMap._terrainBias ?? {});
  data[24] = isPointLight ? 0.0 : (bias.depthBias ?? 0.00002);
  data[25] = bias.normalShadingSmooth ?? 0.0;
  data[26] = 0.0;
  data[27] = 0.0;
}

function packShadowCastUniforms(
  data,
  shadowMap,
  frameState,
  sceneCameraPositionWC = resolveShadowCastCameraPosition(frameState),
) {
  // `_shadowMapMatrix` is the eye-to-texture receive transform. The cast pass
  // needs the pass camera's raw world-to-clip transform instead.
  const lightCamera =
    shadowMap._passes?.[0]?.camera ??
    shadowMap._shadowMapCamera ??
    shadowMap._lightCamera;
  packShadowCastMatrix(data, lightCamera, sceneCameraPositionWC);

  EncodedCartesian3.fromCartesian(sceneCameraPositionWC, scratchEncodedCamera);
  data[16] = scratchEncodedCamera.high.x;
  data[17] = scratchEncodedCamera.high.y;
  data[18] = scratchEncodedCamera.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCamera.low.x;
  data[21] = scratchEncodedCamera.low.y;
  data[22] = scratchEncodedCamera.low.z;
  data[23] = 0.0;

  packShadowCastBias(data, shadowMap, false);
}

/**
 * Creates a shadow map render pass descriptor.
 * @param {ShadowMap} shadowMap
 * @returns {GPURenderPassDescriptor|null}
 */
function getShadowPassDescriptor(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTextureView)) {
    return null;
  }

  return {
    colorAttachments: [],
    depthStencilAttachment: {
      view: cache.depthTextureView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  };
}

/**
 * Create a cube-face pass descriptor for point-light shadow casting. The
 * depth attachment targets one face so each of the six cast passes writes a
 * distinct cube-texture layer.
 *
 * @param {ShadowMap} shadowMap
 * @param {number} passIndex Legacy ShadowMap pass index, 0..5.
 * @returns {GPURenderPassDescriptor|null}
 * @private
 */
function getPointLightFacePassDescriptor(shadowMap, passIndex) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !cache.isCube) {
    return null;
  }
  const layer = getPointLightCubeLayer(passIndex);
  const view = cache.cubeFaceViews?.[layer];
  if (!defined(view)) {
    return null;
  }
  return {
    label: `Shadow point pass ${passIndex} -> cube layer ${layer}`,
    colorAttachments: [],
    depthStencilAttachment: {
      view,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  };
}

/**
 * Gets the shadow map texture and sampler for use in color pass shaders.
 *
 * Returns the directional or spot 2D fields and, for point lights, the cube
 * depth view, light position, and clipping planes needed by cube receivers.
 * Two-dimensional callers can ignore the point-light fields;
 * `WebGPUEffectsBindGroup.js` also reads them directly from
 * `shadowMap._webgpuCache`.
 *
 * @param {ShadowMap} shadowMap
 * @returns {{
 *   texture: GPUTexture,
 *   view: GPUTextureView,
 *   sampler: GPUSampler,
 *   matrix: Matrix4,
 *   size: number,
 *   darkness: number,
 *   softShadows: boolean,
 *   isPointLight: boolean,
 *   cubeView: (GPUTextureView|undefined),
 *   lightPositionWC: (object|undefined),
 *   farPlane: (number|undefined),
 *   nearPlane: (number|undefined),
 *   pointDepthBias: (number|undefined)
 * }|null}
 */
function getShadowMapResources(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTexture)) {
    return null;
  }

  const isPointLight =
    shadowMap._isPointLight === true && cache.isCube === true;

  // `_shadowMapMatrix` already lands in GL-origin shadow TEXTURE space (see
  // `WebGPUShadowReceiveTransform`); only the image origin still differs, and
  // the conversion is cached per shadow map so concurrent callers never alias
  // one module-level scratch.
  let matrix = Matrix4.IDENTITY;
  if (defined(shadowMap._shadowMapMatrix)) {
    cache.webgpuReceiveMatrix ??= new Matrix4();
    matrix = toWebGPUShadowReceiveMatrix(
      shadowMap._shadowMapMatrix,
      cache.webgpuReceiveMatrix,
    );
  }

  return {
    texture: cache.depthTexture,
    view: cache.depthTextureView,
    sampler: cache.comparisonSampler,
    matrix,
    size: cache.size ?? SHADOW_MAP_SIZE,
    // Use the faded `_darkness` value, which `ShadowMapComputations` ramps to
    // 1.0 as the light reaches the horizon. The public `darkness` value does
    // not include this terminator fade.
    darkness: shadowMap._darkness ?? shadowMap.darkness ?? 0.3,
    softShadows: shadowMap.softShadows ?? false,
    // Point-light receive fields stay undefined on directional and spot maps.
    isPointLight,
    cubeView: isPointLight ? cache.cubeDepthView : undefined,
    lightPositionWC: isPointLight
      ? shadowMap._lightCamera?.positionWC
      : undefined,
    farPlane: isPointLight ? shadowMap._pointLightRadius : undefined,
    nearPlane: isPointLight ? 1.0 : undefined,
    pointDepthBias: isPointLight
      ? (shadowMap._pointBias?.depthBias ?? 0.005)
      : undefined,
  };
}

/**
 * Renders every shadow-casting command from the light's perspective into a
 * depth-only shadow texture.
 *
 * @param {GPUCommandEncoder} encoder - The active command encoder.
 * @param {ShadowMap} shadowMap - The shadow map with cached WebGPU resources.
 * @param {FrameState} frameState - The current frame state.
 * @param {Array} castCommands - WebGPU draw commands that cast shadows.
 * @returns {boolean} Whether a draw or clear-only pass was encoded.
 */
function renderShadowCastPass(encoder, shadowMap, frameState, castCommands) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTextureView)) {
    return false;
  }
  const hasCasters = defined(castCommands) && castCommands.length > 0;
  if (!hasCasters) {
    if (
      !shouldClearShadowCastTarget(
        cache.shadowContentState,
        cache.shadowContentFrame,
        frameState?.frameNumber,
      )
    ) {
      return false;
    }
    if (shadowMap._isPointLight) {
      for (let face = 0; face < 6; face++) {
        const descriptor = getPointLightFacePassDescriptor(shadowMap, face);
        if (defined(descriptor)) {
          encoder.beginRenderPass(descriptor).end();
        }
      }
    } else {
      const descriptor = getShadowPassDescriptor(shadowMap);
      if (defined(descriptor)) {
        encoder.beginRenderPass(descriptor).end();
      }
    }
    cache.shadowContentState = "empty";
    return true;
  }

  // Update shadow uniforms.
  const context = frameState?.context;
  const device = context?.device ?? context?._device;
  if (!device) {
    return false;
  }
  // Capture one authoritative cast origin for the whole pass. UniformState
  // is the active-view authority used by model/primitive RTE resources; the
  // frame camera remains the conservative fallback for older/direct callers.
  const shadowCastCameraPositionWC =
    resolveShadowCastCameraPosition(frameState);
  packShadowCastUniforms(
    cache.uniformData,
    shadowMap,
    frameState,
    shadowCastCameraPositionWC,
  );
  // Update the scene-wide terrain globals. Exaggeration comes from
  // frameState (set by Scene.js from `scene.verticalExaggeration`
  // and `scene.verticalExaggerationRelativeHeight`). In 2D / Columbus
  // View the color pass skips exaggeration, so mirror that here by
  // forcing exaggeration to 1.0 when sceneMode <= 2 — this keeps the
  // shader branch cold and identical to the non-exaggerated path.
  if (defined(cache.terrainGlobalsUB)) {
    const sceneMode = frameState.mode ?? 3;
    const exaggeration =
      sceneMode >= 3 ? (frameState.verticalExaggeration ?? 1.0) : 1.0;
    const relativeHeight = frameState.verticalExaggerationRelativeHeight ?? 0.0;
    cache.terrainGlobalsData[0] = exaggeration;
    cache.terrainGlobalsData[1] = relativeHeight;
    cache.terrainGlobalsData[2] = sceneMode;
    cache.terrainGlobalsData[3] = 0; // pad
    device.queue.writeBuffer(
      cache.terrainGlobalsUB.buffer,
      0,
      cache.terrainGlobalsData.buffer,
      0,
      16,
    );
  }

  // Stamp the scene-wide terrain globals UB onto each quantized12 command.
  // Each per-command bind group builder retrieves the buffer through
  // `cmd._shadowCastTerrainGlobalsUB`. The buffer never reallocates, so its
  // stable handle keeps each command's bind-group cache valid across writes.
  let hasTerrainCaster = false;
  for (let si = 0; si < castCommands.length; si++) {
    const c = castCommands[si];
    hasTerrainCaster ||= isTerrainShadowCaster(c);
    if (
      c &&
      (c._shadowCastLayout === "quantized12" ||
        c._shadowCastLayout === "terrainUncompressed") &&
      c._shadowCastTerrainGlobalsUB !== cache.terrainGlobalsUB
    ) {
      c._shadowCastTerrainGlobalsUB = cache.terrainGlobalsUB;
      // The identity-aware bind-group cache observes the changed buffer
      // handle and realizes the replacement group on demand.
    }
  }

  // Point lights invoke `_renderCastPassForShadowMap` six times with per-face
  // VPs and attachments. Directional and spot lights use one depth-only pass.
  if (shadowMap._isPointLight) {
    _renderPointLightCubeCastPasses(
      encoder,
      device,
      cache,
      shadowMap,
      shadowCastCameraPositionWC,
      castCommands,
    );
    cache.shadowContentState = "casters";
    cache.shadowContentFrame = frameState?.frameNumber;
    return true;
  }

  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    SHADOW_UNIFORM_SIZE,
  );
  if (hasTerrainCaster) {
    ensureTerrainShadowCastUniforms(device, cache);
    cache.terrainCastUniformData.set(cache.uniformData);
    packShadowCastBias(cache.terrainCastUniformData, shadowMap, true);
    device.queue.writeBuffer(
      cache.terrainCastUniformBuffer.buffer,
      0,
      cache.terrainCastUniformData.buffer,
      0,
      SHADOW_UNIFORM_SIZE,
    );
  }

  const passDesc = getShadowPassDescriptor(shadowMap);
  if (!passDesc) {
    return false;
  }
  // Realize per-tile terrain uniforms only for commands entering this cast
  // pass. Do this before beginning the pass so its first enabled frame has
  // complete bindings.
  prepareTerrainShadowCastCommandUniforms(device, castCommands);
  const pass = encoder.beginRenderPass(passDesc);
  _drawCastCommandsToPass(
    pass,
    device,
    cache,
    castCommands,
    cache.uniformBuffer.buffer,
    cache.castBindGroups,
    false,
    cache.terrainCastUniformBuffer?.buffer,
    cache.terrainCastBindGroups,
  );
  pass.end();
  cache.shadowContentState = "casters";
  cache.shadowContentFrame = frameState?.frameNumber;
  return true;
}

/**
 * Run the six-face cast loop for a point-light shadow map. Reuses the
 * directional and spot cast-pipeline factory and command-drawing body while
 * replacing the light VP and depth attachment for each face.
 *
 * Matches the six-pass loop in `ShadowMap.js:270-313`. Model and globe
 * receive shaders consume the completed cube view with
 * `textureSampleCompare` and a cube sampler.
 *
 * @private
 */
function _renderPointLightCubeCastPasses(
  encoder,
  device,
  cache,
  shadowMap,
  sceneCameraPositionWC,
  castCommands,
) {
  const passes = shadowMap._passes;
  if (!defined(passes) || passes.length < 6) {
    return;
  }
  for (let face = 0; face < 6; face++) {
    const passDesc = getPointLightFacePassDescriptor(shadowMap, face);
    if (!passDesc) {
      continue;
    }
    // `ShadowMap` point-light passes already contain a per-face
    // frustum-culled command list. WebGPUContext preserves those lists until
    // this loop completes. Falling back to the unique union keeps
    // direct/internal callers with camera-only pass objects working, while an
    // explicitly empty list remains empty so off-face casters are not redrawn
    // into all six cube layers.
    const faceCommands = Array.isArray(passes[face]?.commandList)
      ? passes[face].commandList
      : castCommands;
    const faceData = cache.pointFaceUniformData?.[face];
    const faceBuffer = cache.pointFaceUniformBuffers?.[face];
    const faceBindGroups = cache.pointFaceCastBindGroups?.[face];
    if (
      !defined(faceData) ||
      !defined(faceBuffer) ||
      !defined(faceBindGroups)
    ) {
      continue;
    }
    // Per-face command lists are already spatially culled. Realize only
    // terrain that this cube face will actually draw.
    prepareTerrainShadowCastCommandUniforms(device, faceCommands);
    // Copy the common encoded-camera/bias fields, then replace this face's
    // matrix. A distinct GPUBuffer keeps these bytes immutable until submit.
    faceData.set(cache.uniformData);
    packShadowCastMatrix(
      faceData,
      passes[face].camera,
      sceneCameraPositionWC,
      true,
    );
    device.queue.writeBuffer(
      faceBuffer.buffer,
      0,
      faceData.buffer,
      0,
      SHADOW_UNIFORM_SIZE,
    );

    const pass = encoder.beginRenderPass(passDesc);
    _drawCastCommandsToPass(
      pass,
      device,
      cache,
      faceCommands,
      faceBuffer.buffer,
      faceBindGroups,
      true,
    );
    pass.end();
  }
}

/**
 * Shared cast-command drawing loop for the single-pass directional or spot
 * path and the six-face point-light path. Both use the same pipeline,
 * bind-group, and vertex-buffer resolution logic.
 *
 * @private
 */
function _drawCastCommandsToPass(
  pass,
  device,
  cache,
  castCommands,
  sharedUniformBuffer,
  sharedCastBindGroups,
  invertWinding = false,
  terrainUniformBuffer,
  terrainCastBindGroups,
) {
  // Pipeline topology, culling, vertex layout, and stride are all baked in
  // WebGPU. Use the complete key so adjacent commands share state only when
  // every baked field is compatible.
  let currentPipelineKey = null;
  let currentUniformBuffer = null;

  // Draw each shadow-casting command's geometry through the matching cast
  // pipeline. Commands declare their layout via `cmd._shadowCastLayout` or
  // are inferred from vertex stride (see _inferShadowLayoutKey).
  //
  // Commands can be either:
  //   - WebGPU DrawCommands (have vertexBuffers[] with .buffer getter)
  //   - Ad-hoc commands (have _vertexBuffer with raw GPUBuffer)
  //   - WebGL DrawCommands, which have `vertexArray` and cannot render here
  for (let i = 0; i < castCommands.length; i++) {
    const cmd = castCommands[i];
    if (!defined(cmd)) {
      continue;
    }

    // Resolve vertex buffer — try WebGPU command, then ad-hoc, then skip
    let vb;
    let vbStride;
    if (defined(cmd.vertexBuffers) && cmd.vertexBuffers.length > 0) {
      const first = cmd.vertexBuffers[0];
      vb = defined(first.buffer) ? first.buffer : first;
      vbStride = first.arrayStride ?? cmd.vertexStride;
    } else if (defined(cmd._vertexBuffer)) {
      vb = defined(cmd._vertexBuffer.buffer)
        ? cmd._vertexBuffer.buffer
        : cmd._vertexBuffer;
      vbStride = cmd._vertexStride ?? cmd.vertexStride;
    } else if (defined(cmd.vertexBuffer)) {
      vb = defined(cmd.vertexBuffer.buffer)
        ? cmd.vertexBuffer.buffer
        : cmd.vertexBuffer;
      vbStride = cmd.vertexStride;
    } else {
      // No vertex data available (e.g., WebGL DrawCommand) — skip
      continue;
    }

    const layoutKey = _inferShadowLayoutKey(cmd, vbStride);
    if (layoutKey === null) {
      continue;
    }

    // Pass the command's reported stride so layouts with trailing terrain
    // attributes receive a matching pipeline `arrayStride`. Fixed-stride
    // variants omit `vertexStride`, leaving `vbStride` equal to the declared
    // layout and avoiding an override.
    const topology = getShadowCastTopology(cmd);
    const cullMode = getShadowCastCullMode(cmd, invertWinding);
    const entry = _getOrCreateCastPipeline(
      device,
      cache,
      layoutKey,
      vbStride,
      topology,
      cullMode,
      getShadowCastStripIndexFormat(cmd),
    );
    if (!defined(entry)) {
      continue;
    }
    const variant = SHADOW_CAST_VARIANTS[layoutKey];
    const hasExtraBindings =
      defined(variant.extraBindings) && variant.extraBindings.length > 0;
    const useTerrainUniforms =
      defined(terrainUniformBuffer) && isTerrainShadowCaster(cmd);
    const commandUniformBuffer = useTerrainUniforms
      ? terrainUniformBuffer
      : (sharedUniformBuffer ?? cache.uniformBuffer.buffer);
    const commandSharedBindGroups = useTerrainUniforms
      ? terrainCastBindGroups
      : (sharedCastBindGroups ?? cache.castBindGroups);

    // For variants with no per-command bindings (`rte24`, `p12`, and
    // `modelInstanced`), share one bind group for the pass. Extra-binding
    // variants (`modelP12` and `quantized12`) use the per-variant field map
    // to build one bind group for each command.
    if (!hasExtraBindings) {
      if (
        entry.cacheKey !== currentPipelineKey ||
        commandUniformBuffer !== currentUniformBuffer
      ) {
        const bindGroupCache = commandSharedBindGroups;
        let bg = bindGroupCache.get(entry.cacheKey);
        if (!defined(bg)) {
          bg = device.createBindGroup({
            label: `Shadow cast bind group (${entry.cacheKey})`,
            layout: entry.bgl,
            entries: [
              {
                binding: 0,
                resource: {
                  buffer: commandUniformBuffer,
                },
              },
            ],
          });
          bindGroupCache.set(entry.cacheKey, bg);
        }
        pass.setPipeline(entry.pipeline);
        pass.setBindGroup(0, bg);
        currentPipelineKey = entry.cacheKey;
        currentUniformBuffer = commandUniformBuffer;
      }
    } else {
      // Per-resource bind group. Model and generic Primitive commands publish
      // a persistent cache host because draw commands can be rebuilt. Other
      // command families fall back to the command itself.
      if (entry.cacheKey !== currentPipelineKey) {
        pass.setPipeline(entry.pipeline);
        currentPipelineKey = entry.cacheKey;
      }
      const fields = variant.perCommandBindingFields || [];
      const cacheHost = cmd._shadowCastBindGroupCacheHost || cmd;
      const bg = getOrCreateShadowCastBindGroup(
        device,
        cacheHost,
        `Shadow cast bind group (${layoutKey})`,
        entry.bgl,
        commandUniformBuffer,
        variant.extraBindings,
        fields,
        cmd,
      );
      if (!defined(bg)) {
        continue;
      }
      pass.setBindGroup(0, bg);
    }

    // Resolve vertex buffer(s).
    //
    // Two shapes of variant binding here:
    //
    //   1. Single-VB variants (rte24, primitiveRte24, p12, modelP12,
    //      quantized12, modelInstancedSB) — slot 0 only, already-resolved
    //      above.
    //
    //   2. Multi-VB variants — variant declares `vertexBufferSourceSlots`
    //      that maps each of its N `buffers` entries to an index in
    //      `cmd.vertexBuffers[]`. Lets a variant pull only the VBs it
    //      needs (pos + joints + weights) from a command whose full
    //      layout has more slots (Cesium model's 7-buffer layout).
    //
    //   3. `modelInstanced` is a third shape that retains the
    //      `_shadowCastInstanceVB || cmd.vertexBuffers[1]` fallback for
    //      third-party callers that explicitly use it.
    const sourceSlots = variant.vertexBufferSourceSlots;
    if (sourceSlots && sourceSlots.length > 1) {
      let allResolved = true;
      for (let slotIndex = 0; slotIndex < sourceSlots.length; slotIndex++) {
        const src = sourceSlots[slotIndex];
        const srcEntry = cmd.vertexBuffers && cmd.vertexBuffers[src];
        if (!defined(srcEntry)) {
          allResolved = false;
          break;
        }
        const rawVb = defined(srcEntry.buffer) ? srcEntry.buffer : srcEntry;
        pass.setVertexBuffer(slotIndex, rawVb);
      }
      if (!allResolved) {
        continue;
      }
    } else {
      pass.setVertexBuffer(0, vb);
      if (layoutKey === "modelInstanced") {
        const instVb =
          cmd._shadowCastInstanceVB ||
          (cmd.vertexBuffers && cmd.vertexBuffers[1]);
        if (!defined(instVb)) {
          // Missing instance buffer — skip rather than validation-error.
          continue;
        }
        const rawInstVb = defined(instVb.buffer) ? instVb.buffer : instVb;
        pass.setVertexBuffer(1, rawInstVb);
      }
    }

    // Resolve index buffer
    const ib = cmd.indexBuffer || cmd._indexBuffer;
    if (defined(ib)) {
      const rawIb = defined(ib.buffer) ? ib.buffer : ib;
      const fmt = cmd.indexFormat || cmd._indexFormat || "uint16";
      const count = cmd.indexCount || cmd._indexCount || 0;
      pass.setIndexBuffer(rawIb, fmt);
      pass.drawIndexed(count, cmd.instanceCount || 1);
    } else {
      const count = cmd.vertexCount || cmd._vertexCount || 0;
      pass.draw(count, cmd.instanceCount || 1);
    }
  }

  // Caller owns pass.end() — kept out of the helper so the single-pass
  // (directional/spot) and 6-face (point-light) callers can end their
  // own passes with the right scoping.
}

function destroyWebGPUShadowMapResources(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.depthTexture)) {
    cache.depthTexture.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.terrainCastUniformBuffer)) {
    cache.terrainCastUniformBuffer.destroy();
    cache.terrainCastBindGroups?.clear();
  }
  if (defined(cache.pointFaceUniformBuffers)) {
    for (let i = 0; i < cache.pointFaceUniformBuffers.length; i++) {
      cache.pointFaceUniformBuffers[i]?.destroy();
      cache.pointFaceCastBindGroups?.[i]?.clear();
    }
  }
  if (defined(cache.terrainGlobalsUB)) {
    cache.terrainGlobalsUB.destroy();
  }
  // Pipelines and bind groups are owned by the device and don't expose
  // explicit destroy(); dropping references is sufficient for GC.
  if (defined(cache.castPipelines)) {
    cache.castPipelines.clear();
  }
  if (defined(cache.castBindGroups)) {
    cache.castBindGroups.clear();
  }
  shadowMap._webgpuCache = undefined;
}

export {
  initWebGPUShadowMap,
  packShadowCastUniforms,
  packShadowCastBias,
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  getShadowCastVariant,
  computeShadowCastRteMatrix,
  computeWebGPUPointShadowCastRteMatrix,
  resolveShadowCastCameraPosition,
  getShadowCastTopology,
  getShadowCastStripIndexFormat,
  getShadowCastCullMode,
  getShadowCastPipelineCacheKey,
  getPointLightCubeLayer,
  isTerrainShadowCaster,
  _inferShadowLayoutKey,
  _resetShadowLayoutWarningsForSpec,
  _resetShadowCastVariantRegistryForSpec,
  // Exported for `WebGPUCSMRenderer` — the CSM cast loop needs the same
  // per-vertex-layout pipeline factory as the single-shadow-map path so
  // every registered variant (rte24, p12, quantized12, modelP12,
  // modelInstancedSB, modelSkinned) works under CSM without duplicating
  // the pipeline cache. Internal API — public consumers should not
  // depend on this shape remaining stable.
  _getOrCreateCastPipeline,
};

export default {
  initWebGPUShadowMap,
  packShadowCastUniforms,
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  getPointLightCubeLayer,
};
