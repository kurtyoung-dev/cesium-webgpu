/**
 * @module WebGPUShadowMapRenderer
 *
 * Handles WebGPU shadow map generation and shadow receiving.
 * Creates a depth-only render target for the shadow map, renders scene
 * from light's perspective, then provides shadow sampling for color passes.
 *
 * @private
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const SHADOW_MAP_SIZE = 2048;
const SHADOW_UNIFORM_SIZE = 128;

const scratchEncodedCamera = new EncodedCartesian3();

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

// ─── Shadow cast pipeline registry ───────────────────────────────────────
//
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
 *   `u.depthBias` to the Z coordinate. Any additional bind group
 *   bindings beyond `u` at @group(0) @binding(0) should reference the
 *   bindings declared in `extraBindings` below.
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
  // RTE primitives: positionHigh + positionLow, stride 24, two float32x3.
  // The current default — covers all RTE-encoded primitive geometry.
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
  // Non-RTE single-position world-space: one float32x3 at offset 0,
  // stride 12. Assumes the caller already wrote world coordinates.
  // Used by small objects near origin, debug primitives, and ad-hoc
  // world-space meshes. The camera subtract that RTE needs is skipped
  // because the position isn't split into high/low halves.
  p12: {
    vsCode: `
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  var pos = u.lightVP * vec4f(p, 1.0);
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
struct ModelShadowUniforms { modelMatrix: mat4x4<f32> };
@group(0) @binding(1) var<uniform> m: ModelShadowUniforms;
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  let worldPos = (m.modelMatrix * vec4f(p, 1.0)).xyz;
  // RTE-preserving subtraction: subtract cameraHigh first (both
  // world-scale, result is small) then subtract cameraLow. This keeps
  // the intermediate in a well-conditioned range and matches the
  // precision behavior of czm_modelViewRelativeToEye — avoids the
  // ~1-meter shadow artifacts at planetary scale that the naive
  // 'worldPos - (camH + camL)' reduction produces.
  let rte = (worldPos - u.camH) - u.camL;
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
struct ModelShadowUniforms { modelMatrix: mat4x4<f32> };
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
  let worldPos = (m.modelMatrix * vec4f(skinnedPos, 1.0)).xyz;
  // RTE-preserving subtraction (see modelP12 comment).
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
  // Instanced model path (storage-buffer flavour). Matches Cesium's
  // actual WebGPU model instancing architecture: per-instance model
  // matrices live in a storage buffer bound to the color pass at
  // `@group(5)`. For shadow cast we rebind the same buffer at our
  // `@group(0) @binding(2)` and index it via @builtin(instance_index).
  //
  // Binding 1 carries the node's base model matrix (same UB the
  // modelP12 variant uses); binding 2 is the per-instance transforms
  // storage buffer owned by `WebGPUModelInstancing.ensureInstancingResources`.
  // WebGPUModelRenderer.js tags instanced commands with this variant
  // + both UBs.
  modelInstancedSB: {
    vsCode: `
struct ModelShadowUniforms { modelMatrix: mat4x4<f32> };
@group(0) @binding(1) var<uniform> m: ModelShadowUniforms;
@group(0) @binding(2) var<storage, read> instanceMatrices: array<mat4x4<f32>>;

@vertex fn vs(
  @location(0) p: vec3<f32>,
  @builtin(instance_index) iidx: u32,
) -> @builtin(position) vec4<f32> {
  // glTF instancing semantics: position goes through instance matrix
  // first (local → instanced-local), then through the node's model
  // matrix (instanced-local → world). Matches the color pass in
  // WebGPUModelInstancing / ModelPBRComplete.wgsl.
  let instancedLocal = (instanceMatrices[iidx] * vec4f(p, 1.0)).xyz;
  let worldPos = (m.modelMatrix * vec4f(instancedLocal, 1.0)).xyz;
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
    perCommandBindingFields: [
      "_shadowCastModelUB",
      "_shadowCastInstancingSB",
    ],
  },
  // Instanced model path (classic per-instance VB flavour). Kept for
  // code paths that use the canonical glTF EXT_mesh_gpu_instancing VB
  // layout (4×float32x4 per instance, stride 64, instance step). This
  // variant is currently dormant in CesiumJS — all Cesium model paths
  // use the storage-buffer variant above — but we register it so
  // third-party renderers that DO supply a per-instance VB can opt in
  // via `_shadowCastLayout = "modelInstanced"`.
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
  // Uncompressed terrain (Batch 24). Mirrors `quantized12` structurally
  // but reads the position as-is (no BITS12 decode). The globe's
  // uncompressed VB stores `position3DAndHeight` as a float32x4 at
  // offset 0; subsequent bytes carry tex coords, optional normals /
  // web-mercator-T / geodetic surface normal (DP-H25). All of those
  // extend the stride without touching the position — so we declare
  // the minimum 24-byte stride here and let callers pass `overrideStride`
  // for their actual VB layout (24 / 28 / 32 / 36 / 40 / 44 depending
  // on feature flags).
  //
  // Before Batch 24 uncompressed-terrain shadow cast was structurally
  // broken: the code fell through to the `rte24` variant via stride-
  // inference, which reads two vec3s at offset 0 and 12. Those offsets
  // land on `position.xyz` and `(height, u, v)` — the second vec3 is
  // tex-coord garbage, not a positionLow. The resulting RTE math
  // produced shadow coordinates unrelated to the actual terrain
  // surface. This new variant fixes that at the source.
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
  // Renderers that need the modelP12 or modelInstanced variants MUST
  // set `cmd._shadowCastLayout` explicitly because stride 12 alone
  // can't distinguish world-space vs model-space positions.
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
    console.warn(
      `[WebGPUShadowMap] No shadow cast pipeline registered for vertex stride ${vbStride}. ` +
        `Commands with this layout will be skipped. See SHADOW-LAYOUT in the migration backlog.`,
    );
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

const SHADOW_CAST_BIND_GROUP_PREFIX = `
struct U { lightVP: mat4x4<f32>, camH: vec3<f32>, _p0: f32, camL: vec3<f32>, _p1: f32,
  depthBias: f32, normalBias: f32, _p2: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
@fragment fn fs() {}
`;

/**
 * Builds (and caches) the shadow cast pipeline for a given layout variant.
 * Pipelines are cached on the shadow map's `_webgpuCache.castPipelines` Map
 * keyed by variant name (+ optional stride override), so each shadow map
 * only pays creation cost once per `(layoutKey, stride)` tuple it actually
 * encounters.
 *
 * Batch 24 — the `overrideStride` parameter (optional) replaces the
 * variant's declared `arrayStride` for the first vertex buffer. The
 * variants declare their default stride (matching the canonical caller),
 * but several callers have extra per-vertex bytes trailing the
 * position data (e.g., uncompressed terrain with vertex normals +
 * web-mercator-T + geodetic surface normal = 28–44 bytes). Without the
 * override WebGPU would walk the buffer at the variant's default
 * stride, silently misaligning every vertex after the first. With it,
 * the pipeline's GPU-side stride matches the actual VB contents and
 * the shadow cast reads the right position data for every vertex.
 *
 * Cache keying: when `overrideStride` is defined AND differs from the
 * variant's declared stride, the cache key becomes `${layoutKey}|s${stride}`
 * so stride-divergent callers don't collide.
 *
 * @private
 */
function _getOrCreateCastPipeline(device, cache, layoutKey, overrideStride) {
  if (!defined(cache.castPipelines)) {
    cache.castPipelines = new Map();
    cache.castBindGroups = new Map();
  }
  const variant = SHADOW_CAST_VARIANTS[layoutKey];
  if (!defined(variant)) {
    return null;
  }

  // Work out the effective arrayStride for the first vertex buffer.
  // Variants that don't set `overrideStride` fall back to the declared
  // stride; we only prepend the stride suffix to the cache key when
  // the override actually differs, so single-stride callers (rte24,
  // p12, modelP12, etc.) keep their original keys.
  const declaredStride = variant.buffers?.[0]?.arrayStride ?? 0;
  const effectiveStride = defined(overrideStride)
    ? overrideStride
    : declaredStride;
  const strideDiffers =
    defined(overrideStride) && overrideStride !== declaredStride;
  const effectiveKey = strideDiffers
    ? `${layoutKey}|s${effectiveStride}`
    : layoutKey;

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
  // `extraBindings` — we splice those in after the shared entry.
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

  // Build the final buffers array — shallow-clone when we're overriding
  // so we don't mutate the shared `SHADOW_CAST_VARIANTS` entry.
  let buffers = variant.buffers;
  if (strideDiffers) {
    buffers = variant.buffers.map((buf, idx) =>
      idx === 0
        ? { ...buf, arrayStride: effectiveStride }
        : buf,
    );
  }

  const pipeline = device.createRenderPipeline({
    label: `Shadow cast pipeline (${effectiveKey})`,
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: "vs", buffers },
    fragment: { module: mod, entryPoint: "fs", targets: [] },
    primitive: { topology: "triangle-list", cullMode: "front" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: true,
      // `less-equal` for planetary-scale precision robustness — the
      // CSM far cascades can project shadow casters onto the cascade
      // far plane and `less` would discard them.
      depthCompare: "less-equal",
    },
  });

  entry = { pipeline, bgl };
  cache.castPipelines.set(effectiveKey, entry);
  return entry;
}

/**
 * Registers an additional shadow cast variant (called from outside this
 * module by renderers that need a specialized vertex layout — e.g.,
 * quantized terrain or model PBR). Variants registered after the first
 * shadow cast pass will be picked up on the next pass.
 *
 * @param {string} key Unique layout name (also used as `cmd._shadowCastLayout`)
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
 * Initializes or updates WebGPU shadow map resources.
 * @param {ShadowMap} shadowMap
 * @param {FrameState} frameState
 */
function initWebGPUShadowMap(shadowMap, frameState) {
  // Only directional/spot lights for now (point light shadow maps need cube faces)
  if (!shadowMap.enabled || shadowMap._isPointLight) {
    return;
  }

  const device = frameState.context.device;

  if (!defined(shadowMap._webgpuCache)) {
    shadowMap._webgpuCache = {};
  }
  const cache = shadowMap._webgpuCache;

  // Create shadow map texture once
  if (!defined(cache.depthTexture)) {
    const size = shadowMap._textureSize?.x || SHADOW_MAP_SIZE;
    const result = createShadowMapTexture(device, size);
    cache.depthTexture = result.texture;
    cache.depthTextureView = result.texture.createView();
    cache.comparisonSampler = result.sampler;
    cache.size = size;
  }

  // Cast pipelines are now created lazily per vertex-layout variant
  // (see _getOrCreateCastPipeline). Eager creation removed so that
  // shadow maps which only ever see one layout don't pay for unused
  // variants.

  // Uniform buffer
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      SHADOW_UNIFORM_SIZE,
      "Shadow uniforms",
    );
    cache.uniformData = new Float32Array(SHADOW_UNIFORM_SIZE / 4);
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

/**
 * Packs shadow cast uniforms.
 * @private
 */
function packShadowCastUniforms(data, shadowMap, frameState) {
  const lightVP = shadowMap._shadowMapMatrix || Matrix4.IDENTITY;
  Matrix4.pack(lightVP, data, 0);

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[16] = scratchEncodedCamera.high.x;
  data[17] = scratchEncodedCamera.high.y;
  data[18] = scratchEncodedCamera.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCamera.low.x;
  data[21] = scratchEncodedCamera.low.y;
  data[22] = scratchEncodedCamera.low.z;
  data[23] = 0.0;

  // Shadow bias comes from the appropriate bias object (primitive, terrain, or point)
  const bias = shadowMap._primitiveBias || shadowMap._terrainBias || {};
  data[24] = bias.depthBias || 0.005;
  data[25] = bias.normalShadingSmooth || 0.0;
  data[26] = 0.0;
  data[27] = 0.0;
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
 * Gets the shadow map texture and sampler for use in color pass shaders.
 * @param {ShadowMap} shadowMap
 * @returns {{ texture: GPUTexture, view: GPUTextureView, sampler: GPUSampler, matrix: Matrix4 }|null}
 */
function getShadowMapResources(shadowMap) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTexture)) {
    return null;
  }

  return {
    texture: cache.depthTexture,
    view: cache.depthTextureView,
    sampler: cache.comparisonSampler,
    matrix: shadowMap._shadowMapMatrix || Matrix4.IDENTITY,
    size: cache.size || SHADOW_MAP_SIZE,
    darkness: shadowMap.darkness || 0.3,
    softShadows: shadowMap.softShadows || false,
  };
}

/**
 * Renders a shadow cast pass — draws all shadow-casting commands from the light's perspective.
 * Uses the shadow cast pipeline with depth-only output to the shadow map texture.
 *
 * @param {GPUCommandEncoder} encoder - Active command encoder
 * @param {ShadowMap} shadowMap - The shadow map with cached WebGPU resources
 * @param {FrameState} frameState
 * @param {Array} castCommands - Array of WebGPUDrawCommands that cast shadows
 */
function renderShadowCastPass(encoder, shadowMap, frameState, castCommands) {
  const cache = shadowMap._webgpuCache;
  if (!defined(cache) || !defined(cache.depthTextureView)) {
    return;
  }
  if (!castCommands || castCommands.length === 0) {
    return;
  }

  // Update shadow uniforms
  packShadowCastUniforms(cache.uniformData, shadowMap, frameState);
  const device = frameState.context.device;
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    SHADOW_UNIFORM_SIZE,
  );

  // Update the scene-wide terrain globals. Exaggeration comes from
  // frameState (set by Scene.js from `scene.verticalExaggeration`
  // and `scene.verticalExaggerationRelativeHeight`). In 2D / Columbus
  // View the color pass skips exaggeration, so we mirror that here by
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

  // Stamp the scene-wide terrain globals UB onto every quantized12
  // command so the per-command bind group builder finds it at
  // `cmd._shadowCastTerrainGlobalsUB`. The globals UB handle is
  // stable across frames (buffer never reallocates), so the bind
  // group cache on each command stays valid — we're only writing a
  // handle that was already there on subsequent frames.
  for (let si = 0; si < castCommands.length; si++) {
    const c = castCommands[si];
    if (
      c &&
      c._shadowCastLayout === "quantized12" &&
      c._shadowCastTerrainGlobalsUB !== cache.terrainGlobalsUB
    ) {
      c._shadowCastTerrainGlobalsUB = cache.terrainGlobalsUB;
      // Invalidate any cached bind group on this command — it held a
      // reference to a null or stale globals UB before.
      c._shadowCastBindGroup = undefined;
    }
  }

  // Begin shadow render pass (depth-only)
  const passDesc = getShadowPassDescriptor(shadowMap);
  if (!passDesc) {
    return;
  }
  const pass = encoder.beginRenderPass(passDesc);

  // Per-layout pipeline switching — track the currently-bound variant so we
  // only call setPipeline/setBindGroup when the layout actually changes.
  // Sorting commands by layout key upstream would amortize this further but
  // is not required for correctness.
  let currentLayoutKey = null;

  // Draw each shadow-casting command's geometry through the matching cast
  // pipeline. Commands declare their layout via `cmd._shadowCastLayout` or
  // are inferred from vertex stride (see _inferShadowLayoutKey).
  //
  // Commands can be either:
  //   - WebGPU DrawCommands (have vertexBuffers[] with .buffer getter)
  //   - Ad-hoc commands (have _vertexBuffer with raw GPUBuffer)
  //   - WebGL DrawCommands (have vertexArray — skip these, can't render in WebGPU)
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

    // Batch 24 — pass the command's reported stride so stride-divergent
    // callers (uncompressed terrain with vertex normals / web-mercator-T
    // / geodetic surface normal) get a pipeline whose `arrayStride`
    // matches their actual VB stride. Variants with a fixed stride
    // (rte24, p12, modelP12, modelInstanced, quantized12, modelSkinned)
    // don't set `vertexStride` on their commands, so `vbStride` would
    // match the variant's declared stride and no override kicks in.
    const entry = _getOrCreateCastPipeline(device, cache, layoutKey, vbStride);
    if (!defined(entry)) {
      continue;
    }
    const variant = SHADOW_CAST_VARIANTS[layoutKey];
    const hasExtraBindings =
      defined(variant.extraBindings) && variant.extraBindings.length > 0;

    // For variants with no per-command bindings (rte24, p12,
    // modelInstanced) we can share a single bind group for the whole
    // pass. For variants with extraBindings (modelP12, quantized12)
    // we build one per command using the per-variant field map.
    if (!hasExtraBindings) {
      if (layoutKey !== currentLayoutKey) {
        let bg = cache.castBindGroups.get(layoutKey);
        if (!defined(bg)) {
          bg = device.createBindGroup({
            label: `Shadow cast bind group (${layoutKey})`,
            layout: entry.bgl,
            entries: [
              {
                binding: 0,
                resource: { buffer: cache.uniformBuffer.buffer },
              },
            ],
          });
          cache.castBindGroups.set(layoutKey, bg);
        }
        pass.setPipeline(entry.pipeline);
        pass.setBindGroup(0, bg);
        currentLayoutKey = layoutKey;
      }
    } else {
      // Per-command bind group — rebuild every command unless we
      // detect a stable cache on the command itself. The cached bind
      // group is invalidated by the renderer when its UB contents
      // change (by nulling `cmd._shadowCastBindGroup`).
      if (layoutKey !== currentLayoutKey) {
        pass.setPipeline(entry.pipeline);
        currentLayoutKey = layoutKey;
      }
      const fields = variant.perCommandBindingFields || [];
      const extraEntries = [];
      let missingBinding = false;
      for (let fi = 0; fi < fields.length; fi++) {
        const field = fields[fi];
        const buffer = cmd[field];
        const extraBinding = variant.extraBindings[fi];
        if (!defined(buffer)) {
          missingBinding = true;
          break;
        }
        // Unwrap WebGPUBuffer or accept a raw GPUBuffer
        const raw = defined(buffer.buffer) ? buffer.buffer : buffer;
        extraEntries.push({
          binding: extraBinding.binding,
          resource: { buffer: raw },
        });
      }
      if (missingBinding) {
        continue;
      }

      let bg = cmd._shadowCastBindGroup;
      if (
        !defined(bg) ||
        cmd._shadowCastBindGroupLayoutKey !== layoutKey ||
        cmd._shadowCastBindGroupSharedUB !== cache.uniformBuffer.buffer
      ) {
        bg = device.createBindGroup({
          label: `Shadow cast bind group (${layoutKey})`,
          layout: entry.bgl,
          entries: [
            {
              binding: 0,
              resource: { buffer: cache.uniformBuffer.buffer },
            },
            ...extraEntries,
          ],
        });
        cmd._shadowCastBindGroup = bg;
        cmd._shadowCastBindGroupLayoutKey = layoutKey;
        cmd._shadowCastBindGroupSharedUB = cache.uniformBuffer.buffer;
      }
      pass.setBindGroup(0, bg);
    }

    // Resolve vertex buffer(s).
    //
    // Two shapes of variant binding here:
    //
    //   1. Single-VB variants (rte24, p12, modelP12, quantized12,
    //      modelInstancedSB) — slot 0 only, already-resolved above.
    //
    //   2. Multi-VB variants — variant declares `vertexBufferSourceSlots`
    //      that maps each of its N `buffers` entries to an index in
    //      `cmd.vertexBuffers[]`. Lets a variant pull only the VBs it
    //      needs (pos + joints + weights) from a command whose full
    //      layout has more slots (Cesium model's 7-buffer layout).
    //
    //   3. `modelInstanced` (the classic VB-instancing variant) is a
    //      third legacy shape that keeps its old `_shadowCastInstanceVB
    //      || cmd.vertexBuffers[1]` fallback. Kept for third-party
    //      callers that explicitly use it.
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

  pass.end();
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
  getShadowPassDescriptor,
  getShadowMapResources,
  renderShadowCastPass,
  destroyWebGPUShadowMapResources,
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  _inferShadowLayoutKey,
  _resetShadowLayoutWarningsForSpec,
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
};
