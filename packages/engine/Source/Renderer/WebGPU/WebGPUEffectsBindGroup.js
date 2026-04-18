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
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

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
// 240 → 256 bytes: added `atmosphereLutControl: vec4<f32>` at offset 240
// to gate the LUT-sampled fog path in GlobeTerrain.wgsl (x=enable flag,
// y=innerRadius, z=thickness, w=reserved). Landing on 256 also keeps us
// at WebGPU's minUniformBufferBindingSize alignment boundary, which is
// a nice-to-have for multi-bind-group layouts.
const EFFECTS_UNIFORM_SIZE = 256;
const EFFECTS_UNIFORM_FLOATS = EFFECTS_UNIFORM_SIZE / 4;
// Offset (in floats) of the atmosphereLutControl vec4 in the UBO data
// array. `createEffectsBindGroup` / the globe surface renderer writes
// into this slot when it has LUT resources to share.
const ATMOSPHERE_LUT_CONTROL_OFFSET = 60; // 240 bytes / 4
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

  // Phase 5 WGF-1: binding 0 has vertex visibility so the hardware
  // clip-distances pipeline variant can read `clipPlaneEqHW` from the
  // effects UBO and emit `@builtin(clip_distances)`. The fragment stage
  // still reads shadow + edge highlight fields from the same UBO.
  cache.bgl = makeBindGroupLayout(device, "Effects BGL (shadow + clipping)", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT, { sampleType: "depth" }),
    sampler(2, Stage.FRAGMENT, "comparison"),
    texture(3, Stage.FRAGMENT, { sampleType: "unfilterable-float" }),
    sampler(4, Stage.FRAGMENT, "non-filtering"),
    texture(5, Stage.FRAGMENT),
    sampler(6, Stage.FRAGMENT),
    // Atmosphere LUT bindings. The globe terrain shader samples these
    // when `tile.useAtmosphereLut > 0.5` to get transmittance +
    // inscatter values pre-integrated by the AtmosphereLUT compute
    // pass, giving a physically accurate horizon/fog color that matches
    // the sky shell. When compute isn't available OR the perf manager
    // hasn't produced LUT textures yet, placeholder 1×1 float textures
    // are bound here and the shader takes the inline-math fallback.
    // Binding 7: transmittance LUT (256×64 rgba16float)
    texture(7, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 8: inscatter LUT (256×128 rgba16float)
    texture(8, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 9: shared filtering sampler for both LUT textures
    sampler(9, Stage.FRAGMENT),
  ]);

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

  // 1×1 rgba16float placeholder for the atmosphere LUTs. Contents:
  //   transmittance = (1, 1, 1, 1) — fully transparent (no absorption)
  //     so the LUT-sample path reduces to passing terrain color
  //     through untouched when the globe shader's useAtmosphereLut
  //     flag is on but the real LUT isn't available yet.
  //   inscatter    = (0, 0, 0, 0) — no added sky contribution.
  // Together these make the LUT sampling path a no-op that matches the
  // pre-LUT appearance. The globe shader's useAtmosphereLut gate is
  // still the primary correctness check; these placeholders just
  // keep WebGPU's validation happy when the gate happens to be on.
  const lutPlaceholderTex = (() => {
    const tex = device.createTexture({
      label: "Placeholder atmosphere LUT 1x1",
      size: [1, 1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // rgba16float is 8 bytes per texel. Packing (0,0,0,0) as 8 zero
    // bytes is safe because f16 zero is all-zero bits, same as f32.
    device.queue.writeTexture(
      { texture: tex },
      new Uint16Array([0, 0, 0, 0]),
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
    return tex;
  })();
  cache.placeholderLutTex = lutPlaceholderTex;

  const lutSampler = device.createSampler({
    label: "Placeholder atmosphere LUT sampler",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  cache.placeholderLutSampler = lutSampler;

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
      { binding: 7, resource: lutPlaceholderTex.createView() },
      { binding: 8, resource: lutPlaceholderTex.createView() },
      { binding: 9, resource: lutSampler },
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
  // Atmosphere LUT views (from WebGPUPerformanceManager after the
  // compute dispatch has run). When null/undefined the globe shader
  // takes the inline-math fallback by leaving `tile.useAtmosphereLut`
  // at 0. The placeholder bindings below keep WebGPU validation happy
  // either way (same 1×1 rgba16float textures as getPlaceholderEffects).
  const atmosphereLutTransmittanceView =
    options?.atmosphereLutTransmittanceView;
  const atmosphereLutInscatterView = options?.atmosphereLutInscatterView;

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

  // Atmosphere LUT — the globe shader needs the placeholder sampler
  // + non-zero control fields even when no other effect is active
  // (otherwise the fog code reads from a clean-zero UB and the LUT
  // gate stays off). Having LUT views passed in is enough to count
  // as an active feature.
  const hasAtmosphereLut =
    defined(atmosphereLutTransmittanceView) &&
    defined(atmosphereLutInscatterView);

  // If no features are active, return the shared placeholder
  if (!hasShadow && !hasClipping && !hasPolygonClipping && !hasAtmosphereLut) {
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
      ud.subarray(
        CLIP_DPRIME_FLOAT_OFFSET,
        CLIP_DPRIME_FLOAT_OFFSET + CLIP_DPRIME_FLOAT_COUNT,
      ),
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

  // Atmosphere LUT control block — enables the LUT-sampled fog path
  // in GlobeTerrain.wgsl when views are available AND planet radii
  // are supplied via options.atmosphereLutPlanetRadii.
  if (hasAtmosphereLut) {
    const radii = options?.atmosphereLutPlanetRadii;
    const innerRadius = radii?.inner ?? 6378137.0;
    const outerRadius = radii?.outer ?? innerRadius * 1.025;
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 0] = 1.0; // useAtmosphereLut
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 1] = innerRadius;
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 2] = Math.max(
      1.0,
      outerRadius - innerRadius,
    );
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 3] = 0.0; // reserved
  } else {
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 0] = 0.0;
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
      {
        binding: 7,
        resource:
          atmosphereLutTransmittanceView ??
          pCache.placeholderLutTex.createView(),
      },
      {
        binding: 8,
        resource:
          atmosphereLutInscatterView ?? pCache.placeholderLutTex.createView(),
      },
      { binding: 9, resource: pCache.placeholderLutSampler },
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
  atmosphereLutOptions,
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
      ud.subarray(
        CLIP_DPRIME_FLOAT_OFFSET,
        CLIP_DPRIME_FLOAT_OFFSET + CLIP_DPRIME_FLOAT_COUNT,
      ),
    );
  } else {
    for (let i = 0; i < CLIP_DPRIME_FLOAT_COUNT; i++) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = 0;
    }
    for (let i = 3; i < CLIP_DPRIME_FLOAT_COUNT; i += 4) {
      ud[CLIP_DPRIME_FLOAT_OFFSET + i] = CLIP_DISTANCE_INACTIVE_SENTINEL;
    }
  }

  // Atmosphere LUT control — parity with `createEffectsBindGroup` so
  // incremental updates don't accidentally disable LUT fog. Caller
  // passes { enable, innerRadius, outerRadius } — default disabled.
  if (atmosphereLutOptions && atmosphereLutOptions.enable) {
    const innerRadius = atmosphereLutOptions.innerRadius ?? 6378137.0;
    const outerRadius = atmosphereLutOptions.outerRadius ?? innerRadius * 1.025;
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 0] = 1.0;
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 1] = innerRadius;
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 2] = Math.max(
      1.0,
      outerRadius - innerRadius,
    );
    ud[ATMOSPHERE_LUT_CONTROL_OFFSET + 3] = 0.0;
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
