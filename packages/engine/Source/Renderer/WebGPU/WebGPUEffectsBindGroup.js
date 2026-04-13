/**
 * @module WebGPUEffectsBindGroup
 *
 * Creates and manages the combined shadow-receive + clipping-planes bind group
 * used by lit/flat primitive shaders and the globe terrain shader.
 *
 * Bind group layout (7 bindings):
 *   0: EffectsUniforms  (uniform buffer, 144 bytes)
 *   1: Shadow depth      (texture_depth_2d)
 *   2: Shadow sampler    (sampler_comparison)
 *   3: Clipping texture  (texture_2d<f32>, rgba32float)
 *   4: Clipping sampler  (sampler)
 *   5: Polygon SDF tex   (texture_2d<f32>, r32float)
 *   6: Polygon SDF samp  (sampler, filtering)
 *
 * When no shadow map or clipping planes are active, placeholder resources
 * are used (1×1 depth=1.0, planeCount=0) so the bind group is always
 * present — no pipeline-variant branching needed.
 *
 * Phase 5 WGF-1: the UBO carries an additional 32-byte `clipPlaneDPrime`
 * tail (two vec4 slots = 8 floats) holding the per-frame precomputed
 * `d + dot(n, camera)` values for the hardware clip-distances pipeline
 * variant. The legacy fragment-discard path ignores it; the new variant
 * reads it via `effects.clipPlaneDPrime0/1`. Slots beyond the active
 * plane count are filled with +Infinity (no clip).
 *
 * @private
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import { getShadowMapResources } from "./WebGPUShadowMapRenderer.js";
import {
  computeClipPlaneDPrimes,
  CLIP_DPRIME_FLOAT_COUNT,
  CLIP_DISTANCE_INACTIVE_SENTINEL,
} from "./WebGPUClipDistancePrecompute.js";

// 240 bytes = 60 floats: shadowMatrix(16) + shadowMapSize(2) + darkness(1)
// + soft(1) + planeCount(1u) + unionMode(1u) + edgeWidth(1) + polyCount(1u)
// + edgeColor(4) + clipPlaneEqHW[8](32)
//
// Phase 5 WGF-1: the trailing 128 bytes (32 floats, indices 28..59) hold
// the precomputed `(plane.normal.xyz, dPrime)` quads — one vec4 per plane,
// up to 8 planes. The vertex shader of the hardware-clip-distances variant
// reads these and emits clip distances. The legacy fragment-discard path
// ignores them. Slots beyond the active plane count carry
// `(0,0,0,+Infinity)` so unused clip distances are always positive (no
// clip).
const EFFECTS_UNIFORM_SIZE = 240;
const EFFECTS_UNIFORM_FLOATS = EFFECTS_UNIFORM_SIZE / 4;
const CLIP_DPRIME_FLOAT_OFFSET = 28;

// Cached per-device placeholder resources (shared across all primitives)
const _placeholderCache = new WeakMap();

/**
 * Returns or creates the shared bind group layout for the effects bind group.
 * @param {GPUDevice} device
 * @returns {GPUBindGroupLayout}
 */
function getEffectsBindGroupLayout(device) {
  let cache = _placeholderCache.get(device);
  if (defined(cache) && defined(cache.bgl)) {
    return cache.bgl;
  }

  if (!defined(cache)) {
    cache = {};
    _placeholderCache.set(device, cache);
  }

  cache.bgl = device.createBindGroupLayout({
    label: "Effects BGL (shadow + clipping)",
    entries: [
      {
        binding: 0,
        // Phase 5 WGF-1: vertex visibility added so the hardware
        // clip-distances pipeline variant can read `clipPlaneEqHW`
        // from the effects UBO and emit `@builtin(clip_distances)`.
        // The fragment stage still reads shadow + edge highlight
        // fields from the same UBO.
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "comparison" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "non-filtering" },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d" },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });

  return cache.bgl;
}

/**
 * Returns or creates placeholder resources for when no shadow/clipping is active.
 * @param {GPUDevice} device
 * @returns {{ bindGroup: GPUBindGroup, uniformBuffer: GPUBuffer }}
 */
function getPlaceholderEffects(device) {
  let cache = _placeholderCache.get(device);
  if (defined(cache) && defined(cache.placeholderBindGroup)) {
    return {
      bindGroup: cache.placeholderBindGroup,
      uniformBuffer: cache.placeholderUniformBuffer,
    };
  }

  if (!defined(cache)) {
    cache = {};
    _placeholderCache.set(device, cache);
  }

  const bgl = getEffectsBindGroupLayout(device);

  // 1×1 depth texture with value 1.0 (fully lit placeholder)
  const depthTex = device.createTexture({
    label: "Placeholder shadow depth 1x1",
    size: [1, 1, 1],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  cache.placeholderDepthTex = depthTex;

  // Clear placeholder depth to 1.0 via a render pass
  const clearEncoder = device.createCommandEncoder();
  clearEncoder
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthTex.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    })
    .end();
  device.queue.submit([clearEncoder.finish()]);

  // Comparison sampler
  const compSampler = device.createSampler({
    label: "Placeholder shadow comparison sampler",
    compare: "less",
    magFilter: "linear",
    minFilter: "linear",
  });
  cache.placeholderCompSampler = compSampler;

  // 1×1 rgba32float clipping texture (no planes)
  const clipTex = device.createTexture({
    label: "Placeholder clipping 1x1",
    size: [1, 1, 1],
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: clipTex },
    new Float32Array([0, 0, 0, 0]),
    { bytesPerRow: 16 },
    { width: 1, height: 1 },
  );
  cache.placeholderClipTex = clipTex;

  const clipSampler = device.createSampler({
    label: "Placeholder clipping sampler",
    minFilter: "nearest",
    magFilter: "nearest",
  });
  cache.placeholderClipSampler = clipSampler;

  // 1×1 r32float SDF texture (outside = 1.0, no polygon clipping)
  const sdfTex = device.createTexture({
    label: "Placeholder polygon SDF 1x1",
    size: [1, 1, 1],
    format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: sdfTex },
    new Float32Array([1.0]),
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  cache.placeholderSDFTex = sdfTex;

  const sdfSampler = device.createSampler({
    label: "Placeholder polygon SDF sampler",
    minFilter: "linear",
    magFilter: "linear",
  });
  cache.placeholderSDFSampler = sdfSampler;

  // Uniform buffer with shadows disabled (darkness=1.0) and 0 clipping planes
  const ub = device.createBuffer({
    size: EFFECTS_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "Placeholder effects UB",
  });
  const data = new Float32Array(EFFECTS_UNIFORM_FLOATS);
  // shadowMatrix = identity
  Matrix4.pack(Matrix4.IDENTITY, data, 0);
  data[16] = 1.0; // shadowMapSize.x
  data[17] = 1.0; // shadowMapSize.y
  data[18] = 1.0; // shadowDarkness = 1.0 (fully lit = no shadow)
  data[19] = 0.0; // shadowSoftShadows
  // Clipping fields are all 0 (planeCount=0 → no clipping)
  // Phase 5 WGF-1: fill the placeholder dPrime slots with the inactive
  // sentinel (finite, large) so any pipeline that happens to bind the
  // placeholder while the clip-distances variant is active still
  // rasterizes correctly (no clip). MUST be finite — Metal's MSL backend
  // produces undefined behavior on non-finite clip_distances.
  // Layout per slot: (n.x=0, n.y=0, n.z=0, dPrime=sentinel).
  for (let i = 0; i < CLIP_DPRIME_FLOAT_COUNT; i++) {
    data[CLIP_DPRIME_FLOAT_OFFSET + i] = 0;
  }
  for (let i = 3; i < CLIP_DPRIME_FLOAT_COUNT; i += 4) {
    data[CLIP_DPRIME_FLOAT_OFFSET + i] = CLIP_DISTANCE_INACTIVE_SENTINEL;
  }
  device.queue.writeBuffer(ub, 0, data);
  cache.placeholderUniformBuffer = ub;

  cache.placeholderBindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: ub } },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: compSampler },
      { binding: 3, resource: clipTex.createView() },
      { binding: 4, resource: clipSampler },
      { binding: 5, resource: sdfTex.createView() },
      { binding: 6, resource: sdfSampler },
    ],
  });

  return {
    bindGroup: cache.placeholderBindGroup,
    uniformBuffer: cache.placeholderUniformBuffer,
  };
}

const _scratchEffectsData = new Float32Array(EFFECTS_UNIFORM_FLOATS);

/**
 * Creates an active effects bind group with real shadow and/or clipping resources.
 * Falls back to placeholder sub-resources when either feature is inactive.
 *
 * @param {GPUDevice} device
 * @param {FrameState} frameState
 * @param {object} [options]
 * @param {object} [options.shadowMap] - CesiumJS ShadowMap object
 * @param {object} [options.clippingPlanes] - ClippingPlaneCollection with _webgpuCache
 * @param {object} [options.clippingPolygons] - ClippingPolygonCollection with _webgpuCache
 * @param {object} [options.cameraInPlaneSpace] - Phase 5 WGF-1: unencoded
 *   camera position in the same coordinate frame the clipping plane
 *   equations were authored in (world-space for globe terrain, model-space
 *   for primitives with non-identity modelMatrix). Required for the
 *   hardware clip-distances variant; safe to omit if not in use.
 * @returns {{ bindGroup: GPUBindGroup, uniformBuffer: GPUBuffer }}
 */
function createEffectsBindGroup(device, frameState, options) {
  const shadowMap = options?.shadowMap;
  const clippingPlanes = options?.clippingPlanes;
  const clippingPolygons = options?.clippingPolygons;
  const cameraInPlaneSpace = options?.cameraInPlaneSpace;

  const placeholder = getPlaceholderEffects(device);
  const bgl = getEffectsBindGroupLayout(device);

  // Shadow resources
  let shadowDepthView;
  let shadowCompSampler;
  let hasShadow = false;

  if (defined(shadowMap) && shadowMap.enabled) {
    const res = getShadowMapResources(shadowMap);
    if (defined(res) && defined(res.view)) {
      shadowDepthView = res.view;
      shadowCompSampler = res.sampler;
      hasShadow = true;
    }
  }

  // Clipping resources
  let clipTexView;
  let clipSampler;
  let hasClipping = false;
  let clipCache;

  if (defined(clippingPlanes) && clippingPlanes.length > 0) {
    clipCache = clippingPlanes._webgpuCache;
    if (defined(clipCache) && defined(clipCache.textureView)) {
      clipTexView = clipCache.textureView;
      clipSampler = clipCache.sampler;
      hasClipping = true;
    }
  }

  // Polygon SDF resources
  let sdfTexView;
  let sdfSampler;
  let hasPolygonClipping = false;

  if (defined(clippingPolygons) && clippingPolygons.length > 0) {
    const polyCache = clippingPolygons._webgpuCache;
    if (defined(polyCache) && defined(polyCache._signedDistanceTexture)) {
      const sdfTex = polyCache._signedDistanceTexture;
      sdfTexView = sdfTex.textureView ?? sdfTex.createView?.();
      sdfSampler = polyCache._sdfSampler;
      hasPolygonClipping = true;
    }
  }

  // If no features are active, return the shared placeholder
  if (!hasShadow && !hasClipping && !hasPolygonClipping) {
    return placeholder;
  }

  // Build uniform data
  const ud = _scratchEffectsData;
  ud.fill(0);

  if (hasShadow) {
    const res = getShadowMapResources(shadowMap);
    Matrix4.pack(res.matrix, ud, 0);
    ud[16] = res.size;
    ud[17] = res.size;
    ud[18] = res.darkness;
    ud[19] = res.softShadows ? 1.0 : 0.0;
  } else {
    Matrix4.pack(Matrix4.IDENTITY, ud, 0);
    ud[16] = 1.0;
    ud[17] = 1.0;
    ud[18] = 1.0; // darkness=1.0 → fully lit
    ud[19] = 0.0;
  }

  // Clipping uniforms (u32 fields stored as float bits via DataView)
  const dv = new DataView(ud.buffer);
  // Polygon SDF clipping count (at offset 23, was _pad5)
  // (clippingPolygons is hoisted to the top of the function alongside
  // shadowMap / clippingPlanes — see ESLint no-use-before-define fix)
  if (defined(clippingPolygons) && clippingPolygons.length > 0) {
    dv.setUint32(23 * 4, clippingPolygons.length, true);
  }

  if (hasClipping) {
    dv.setUint32(20 * 4, clippingPlanes.length, true);
    dv.setUint32(21 * 4, clippingPlanes.unionClippingRegions ? 1 : 0, true);
    ud[22] = clippingPlanes.edgeWidth ?? 0.0;
    const ec = clippingPlanes.edgeColor;
    if (defined(ec)) {
      ud[24] = ec.red ?? 1.0;
      ud[25] = ec.green ?? 1.0;
      ud[26] = ec.blue ?? 1.0;
      ud[27] = ec.alpha ?? 1.0;
    } else {
      ud[24] = 1.0;
      ud[25] = 1.0;
      ud[26] = 1.0;
      ud[27] = 1.0;
    }
    // Phase 5 WGF-1: precompute dPrime for the hardware clip-distances
    // variant. Falls back to +Infinity for every slot when the camera
    // position isn't supplied (callers wired only for the legacy
    // discard path) or when the collection has no planes — both states
    // are correct because the discard path doesn't read these slots.
    computeClipPlaneDPrimes(
      clippingPlanes,
      cameraInPlaneSpace,
      ud.subarray(CLIP_DPRIME_FLOAT_OFFSET, CLIP_DPRIME_FLOAT_OFFSET + CLIP_DPRIME_FLOAT_COUNT),
    );
  } else {
    dv.setUint32(20 * 4, 0, true); // planeCount = 0
    // Fill dPrime tail with +Infinity (no clip) — see WGF-1 above.
    for (let i = 0; i < CLIP_DPRIME_FLOAT_COUNT; i++) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = 0;
    }
    for (let i = 3; i < CLIP_DPRIME_FLOAT_COUNT; i += 4) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = CLIP_DISTANCE_INACTIVE_SENTINEL;
    }
  }

  // Create per-frame uniform buffer
  const ub = device.createBuffer({
    size: EFFECTS_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "Effects UB",
  });
  device.queue.writeBuffer(ub, 0, ud);

  // Fallback to placeholder sub-resources
  const pCache = _placeholderCache.get(device);

  const bg = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: ub } },
      {
        binding: 1,
        resource: shadowDepthView ?? pCache.placeholderDepthTex.createView(),
      },
      {
        binding: 2,
        resource: shadowCompSampler ?? pCache.placeholderCompSampler,
      },
      {
        binding: 3,
        resource: clipTexView ?? pCache.placeholderClipTex.createView(),
      },
      { binding: 4, resource: clipSampler ?? pCache.placeholderClipSampler },
      {
        binding: 5,
        resource: sdfTexView ?? pCache.placeholderSDFTex.createView(),
      },
      { binding: 6, resource: sdfSampler ?? pCache.placeholderSDFSampler },
    ],
  });

  return { bindGroup: bg, uniformBuffer: ub };
}

/**
 * Updates an existing effects uniform buffer with current shadow/clipping state.
 * Avoids creating a new bind group when only the uniform values change.
 *
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {object} [shadowMap]
 * @param {object} [clippingPlanes]
 */
function updateEffectsUniforms(
  device,
  uniformBuffer,
  shadowMap,
  clippingPlanes,
  cameraInPlaneSpace,
) {
  const ud = _scratchEffectsData;
  ud.fill(0);

  if (defined(shadowMap) && shadowMap.enabled) {
    const res = getShadowMapResources(shadowMap);
    if (defined(res)) {
      Matrix4.pack(res.matrix, ud, 0);
      ud[16] = res.size;
      ud[17] = res.size;
      ud[18] = res.darkness;
      ud[19] = res.softShadows ? 1.0 : 0.0;
    } else {
      Matrix4.pack(Matrix4.IDENTITY, ud, 0);
      ud[16] = 1.0;
      ud[17] = 1.0;
      ud[18] = 1.0;
    }
  } else {
    Matrix4.pack(Matrix4.IDENTITY, ud, 0);
    ud[16] = 1.0;
    ud[17] = 1.0;
    ud[18] = 1.0;
  }

  const dv = new DataView(ud.buffer);
  if (defined(clippingPlanes) && clippingPlanes.length > 0) {
    dv.setUint32(20 * 4, clippingPlanes.length, true);
    dv.setUint32(21 * 4, clippingPlanes.unionClippingRegions ? 1 : 0, true);
    ud[22] = clippingPlanes.edgeWidth ?? 0.0;
    const ec = clippingPlanes.edgeColor;
    if (defined(ec)) {
      ud[24] = ec.red ?? 1.0;
      ud[25] = ec.green ?? 1.0;
      ud[26] = ec.blue ?? 1.0;
      ud[27] = ec.alpha ?? 1.0;
    }
    computeClipPlaneDPrimes(
      clippingPlanes,
      cameraInPlaneSpace,
      ud.subarray(CLIP_DPRIME_FLOAT_OFFSET, CLIP_DPRIME_FLOAT_OFFSET + CLIP_DPRIME_FLOAT_COUNT),
    );
  } else {
    for (let i = 0; i < CLIP_DPRIME_FLOAT_COUNT; i++) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = 0;
    }
    for (let i = 3; i < CLIP_DPRIME_FLOAT_COUNT; i += 4) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = CLIP_DISTANCE_INACTIVE_SENTINEL;
    }
  }

  device.queue.writeBuffer(uniformBuffer, 0, ud);
}

export {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  EFFECTS_UNIFORM_SIZE,
};

export default {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  EFFECTS_UNIFORM_SIZE,
};
