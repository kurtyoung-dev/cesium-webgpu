/**
 * @module WebGPUEffectsBindGroup
 *
 * Creates and manages the combined shadow-receive + clipping-planes bind group
 * used by lit/flat primitive shaders and the globe terrain shader.
 *
 * Bind group layout (18 bindings):
 *   0: EffectsUniforms       (uniform buffer, 336 bytes)
 *   1: Shadow depth          (texture_depth_2d)
 *   2: Shadow sampler        (sampler_comparison)
 *   3: Clipping texture      (texture_2d<f32>, rgba32float)
 *   4: Clipping sampler      (sampler)
 *   5: Polygon SDF tex       (texture_2d<f32>, r32float)
 *   6: Polygon SDF samp      (sampler, filtering)
 *   7: Atmosphere transmittance LUT (texture_2d<f32>, float)
 *   8: Atmosphere inscatter LUT     (texture_2d<f32>, float)
 *   9: Atmosphere LUT sampler       (sampler, filtering)
 *   10: CSM params UBO              (CSMParams, 1088 bytes)
 *   11: Cascade depth array         (texture_depth_2d_array, 4 layers)
 *   12: Edge color texture          (texture_2d<f32>, float — emitter MRT slot 0)
 *   13: Edge id texture             (texture_2d<f32>, float — emitter MRT slot 1)
 *   14: Edge depth texture          (texture_2d<f32>, float — packed depth from
 *                                    emitter MRT slot 2, czm_packDepth scheme)
 *   15: Globe depth texture         (texture_2d<f32>, float — packed depth
 *                                    from `WebGPUGlobeDepth.executeCopyDepth`,
 *                                    used to gate edges over background)
 *   16: Edge sampler                (sampler, filtering)
 *   17: Point-light cube depth      (texture_depth_cube — 6-face depth32float
 *                                    populated by `_renderPointLightCubeCastPasses`
 *                                    in WebGPUShadowMapRenderer; sampled by the
 *                                    Model FS receive path via direction +
 *                                    a perspective-Z reference depth derived
 *                                    from `lightPositionWC` + `farPlane` in
 *                                    `EffectsUniforms.pointLightControl` /
 *                                    `pointLightPositionWC`. Placeholder is a
 *                                    1×1×6 cube cleared to 1.0 so non-point-
 *                                    light pipelines that share the BGL stay
 *                                    valid; the shader gates on
 *                                    `pointLightControl.x > 0.5` before
 *                                    sampling — see C-R10-POINT-LIGHT-RECEIVE.)
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
// y=innerRadius, z=thickness, w=reserved).
// 256 → 272 bytes (CSM Slice 1): added `csmControl: vec4<f32>` at offset
// 256. x = CSM enabled flag (>0.5 → sample cascade depth array via
// binding 11 / CSMParams via binding 10; otherwise use the single-map
// path at bindings 1/2). y/z/w reserved. Keeping the vec4 shape lets
// later slices pack cascade count / moon-light flag without another
// UBO-size bump. Stays aligned on a vec4 boundary.
// 272 → 304 bytes (C-R8-EDGE-INLINE): appended two vec4 control blocks
// for the inline edge-detection stage in Model FS.
//   offset 272 — `edgeControl: vec4<f32>` —
//     x = edgeReady flag (1.0 when emitter populated MRT this frame),
//     y = isEdgePass flag (always 0 for model FS — emitter uses its
//         own pipeline; reserved so primitive/decal callers can flip
//         the gate without a UBO-size bump),
//     z = currentFrustum.x (near plane),
//     w = currentFrustum.y (far plane).
//   offset 288 — `edgeViewport: vec4<f32>` —
//     x = viewport width (px), y = viewport height (px),
//     z = depth tolerance (relative scale used by the inline stage to
//         widen the depth-equality check on far geometry; mirrors
//         `EdgeDetectionStageFS.glsl`'s `geomDepthLinear * 0.0005`),
//     w = hasEdgeFeatureId flag (1.0 when the FS should match
//         `edgeId.g` against the fragment's current featureId — the
//         `HAS_EDGE_FEATURE_ID` branch from the WebGL stage).
// 304 → 336 bytes (C-R10-POINT-LIGHT-RECEIVE): appended two vec4 blocks
// for the point-light cube-shadow-receive path in Model FS.
//   offset 304 — `pointLightControl: vec4<f32>` —
//     x = enabled flag (1.0 when binding 17 is the active cube-depth
//         view AND the shader should route through `samplePointShadow`
//         instead of the 2D / CSM paths),
//     y = farPlane (distance to the far cube-camera plane in meters,
//         equal to `shadowMap._pointLightRadius`; used together with
//         the fixed near=1.0 to reproduce the perspective-Z formula
//         the cast pipeline wrote per face),
//     z = nearPlane (defaults to 1.0; matches `computeOmnidirectional`
//         in ShadowMapComputations.js. Stored explicitly so future
//         tunable-near callers don't need a UBO-size bump),
//     w = depthBias (small offset subtracted from the reference depth
//         before the comparison sample to suppress shadow acne — same
//         role as `pointBias.depthBias` in WebGL).
//   offset 320 — `pointLightPositionWC: vec4<f32>` —
//     xyz = world-space light position (meters); w = darkness override
//     (matches `effects.shadowDarkness`'s convention — 0=fully shadowed,
//     1=no shadow). The receive shader reconstructs `fragWC = cameraWC +
//     rotated-rteMC` and computes `direction = fragWC - lightWC` for
//     both the cube sample direction AND the dominant-axis distance
//     fed into the perspective-Z formula. xyz is in absolute world
//     coordinates, NOT camera-relative — this is fine for shadow casting
//     where the relative magnitudes are bounded by `farPlane` (sub-radius
//     scale, well within f32 precision after the `fragWC - lightWC`
//     subtract). Holding the absolute vector lets the receive math
//     stay agnostic to which camera frame the cast was done in.
const EFFECTS_UNIFORM_SIZE = 336;
const EFFECTS_UNIFORM_FLOATS = EFFECTS_UNIFORM_SIZE / 4;
// Offset (in floats) of the atmosphereLutControl vec4 in the UBO data
// array. `createEffectsBindGroup` / the globe surface renderer writes
// into this slot when it has LUT resources to share.
const ATMOSPHERE_LUT_CONTROL_OFFSET = 60; // 240 bytes / 4
const CSM_CONTROL_OFFSET = 64; // 256 bytes / 4
const EDGE_CONTROL_OFFSET = 68; // 272 bytes / 4
const EDGE_VIEWPORT_OFFSET = 72; // 288 bytes / 4
// C-R10-POINT-LIGHT-RECEIVE — point-light cube-shadow control + light
// position. Two vec4 slots = 8 floats appended after the edge block.
const POINT_LIGHT_CONTROL_OFFSET = 76; // 304 bytes / 4
const POINT_LIGHT_POSITION_OFFSET = 80; // 320 bytes / 4
const CLIP_DPRIME_FLOAT_OFFSET = 28;

// CSM params UBO size. Must match `WebGPUCSMRenderer._cascadeParamsData`
// (264 floats = 1056 bytes, rounded to 1088 for 256-byte alignment) —
// we only use this number as a validation minBindingSize hint. If the
// placeholder diverges from the real buffer layout in the future, the
// BGL minBindingSize guard on binding 10 will catch it at pipeline
// creation time. Keep this in sync with the CSM renderer.
const CSM_PARAMS_PLACEHOLDER_FLOATS = 264;
const CSM_PARAMS_PLACEHOLDER_BYTES = 1088;

// Cached per-device placeholder resources (shared across all primitives).
//
// Each per-device entry now carries TWO sub-caches:
//
//   1. `placeholderXxx` fields — the 1×1 textures, samplers, and the
//      shared placeholder bind group used when no shadow/clipping/CSM/
//      edge feature is active. Created lazily by `getPlaceholderEffects`.
//      Pre-created `placeholderXxxView` slots avoid `texture.createView()`
//      churn inside the hot-path bind-group factory.
//
//   2. `effectsBgCache` — C-R11-EFFECTS-BGL-COLLECTION-CACHE (Batch 55).
//      Identity-based map of resource-tuple key → {buffer, bindGroup,
//      contentKey}. Reuses the same UBO + GPUBindGroup across all globe
//      tiles in a frame that share the same shadow/clipping/csm/edges
//      identity AND content (the globe-terrain path naturally hits this
//      because every tile shares the world-space camera and the
//      collection-scoped clipping resources). Empties on device-loss
//      via the existing `clearEffectsPlaceholderCacheForDevice` hook.
const _placeholderCache = new WeakMap();

/**
 * Allocate the per-device effects bind-group cache lazily on the
 * placeholder cache entry. Returns the cache object so the caller can
 * mutate `bindGroups` / `hits` / `misses` directly.
 *
 * @param {object} cache - per-device placeholder cache entry
 * @returns {{
 *   bindGroups: Map<string, {buffer: GPUBuffer, bindGroup: GPUBindGroup, contentKey: string}>,
 *   idMap: WeakMap<object, number>,
 *   idCounter: number,
 *   hits: number,
 *   misses: number,
 *   bufferWrites: number,
 *   diagLastFrame: number,
 * }}
 */
function _ensureEffectsBgCache(cache) {
  if (!defined(cache.effectsBgCache)) {
    cache.effectsBgCache = {
      bindGroups: new Map(),
      idMap: new WeakMap(),
      idCounter: 0,
      hits: 0,
      misses: 0,
      bufferWrites: 0,
      diagLastFrame: -1,
    };
  }
  return cache.effectsBgCache;
}

/**
 * Stable numeric ID for any GPU resource object. The id counter is
 * append-only on the cache; identities for collected resources become
 * unreachable as the WeakMap entry is reclaimed.
 *
 * @param {object} bgCache - the effects BG cache
 * @param {object|null|undefined} obj - resource object (or nullish)
 * @returns {number} 0 for nullish, otherwise a stable >0 id
 */
function _idFor(bgCache, obj) {
  if (obj === null || obj === undefined) {
    return 0;
  }
  let id = bgCache.idMap.get(obj);
  if (id === undefined) {
    id = ++bgCache.idCounter;
    bgCache.idMap.set(obj, id);
  }
  return id;
}

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
    // CSM Slice 1: Cascaded Shadow Map resources. Always present in the
    // layout (with zero-filled placeholders when CSM is disabled) so we
    // don't need per-feature pipeline variants — the shader branches on
    // `effects.csmControl.x > 0.5` to decide whether to sample them.
    // Binding 10: CSMParams UBO — 4 RTE-aware mat4 cascade VPs + split
    //             distances + blend bands + per-cascade bias (minBias
    //             + maxSlopeBias vec4s). Lives on `WebGPUCSMRenderer`
    //             when active. 272 floats / 1088 bytes.
    uniformBuffer(10, Stage.FRAGMENT),
    // Binding 11: cascade depth array (4 layers of depth32float).
    texture(11, Stage.FRAGMENT, {
      sampleType: "depth",
      viewDimension: "2d-array",
    }),
    // C-R8-EDGE-INLINE — inline edge-detection resources for Model FS.
    // Always present in the layout (with 1×1 placeholder textures + a
    // shared filtering sampler when no edges are populated) so all
    // model pipelines share one BGL. The shader gates sampling on
    // `effects.edgeControl.x > 0.5`. Globe / primitive shaders that
    // don't reference these bindings simply don't sample them — the
    // BGL still validates because the bind group has matching entries.
    // Binding 12: edge color (scene format — bgra8unorm or rgba16float
    //             when HDR is on; we declare as `float` sampleType and
    //             rely on the shared sampler being valid for both).
    texture(12, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 13: edge id / metadata (rgba8unorm — type, featureId).
    texture(13, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 14: edge packed depth (rgba8unorm — czm_packDepth scheme).
    texture(14, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 15: globe packed depth (rgba8unorm — czm_packDepth from
    //             WebGPUGlobeDepth.executeCopyDepth).
    texture(15, Stage.FRAGMENT, { sampleType: "float" }),
    // Binding 16: shared filtering sampler for the edge / globe depth
    //             textures. Linear filtering matches WebGL's default
    //             texture filter for these targets.
    sampler(16, Stage.FRAGMENT),
    // C-R10-POINT-LIGHT-RECEIVE — point-light cube depth target. Always
    // present in the layout (with a 1×1×6 placeholder cleared to 1.0
    // when point-light shadows are off) so model / primitive pipelines
    // share one BGL across both light types. The receive shader gates
    // sampling on `effects.pointLightControl.x > 0.5` — when false,
    // this binding is bound but never sampled. Reusing binding 2 as
    // the comparison sampler keeps the binding count from drifting.
    texture(17, Stage.FRAGMENT, {
      sampleType: "depth",
      viewDimension: "cube",
    }),
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
  // C-R11-EFFECTS-BGL-COLLECTION-CACHE: cache the view so the hot path
  // doesn't call `createView()` per bind-group construction.
  cache.placeholderDepthView = depthTex.createView();

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
  cache.placeholderClipView = clipTex.createView();

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
  cache.placeholderSDFView = sdfTex.createView();

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
  cache.placeholderLutView = lutPlaceholderTex.createView();

  const lutSampler = device.createSampler({
    label: "Placeholder atmosphere LUT sampler",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  cache.placeholderLutSampler = lutSampler;

  // CSM Slice 1 placeholders — always bound (even when CSM disabled)
  // so pipelines can share one BGL. The shader's
  // `effects.csmControl.x > 0.5` gate keeps these from being sampled
  // when CSM is off.
  //
  // Placeholder CSMParams: 1088 bytes (matches `WebGPUCSMRenderer`'s
  // `_cascadeParamsBuffer` size), zero-filled. A zero cascade VP
  // projects every fragment to the origin, but csmControl.x=0 keeps
  // the shader on the single-map path so this is never sampled.
  const csmParamsPlaceholder = device.createBuffer({
    label: "Placeholder CSM params",
    size: CSM_PARAMS_PLACEHOLDER_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(
    csmParamsPlaceholder,
    0,
    new Float32Array(CSM_PARAMS_PLACEHOLDER_FLOATS),
  );
  cache.placeholderCsmParamsBuffer = csmParamsPlaceholder;

  // Placeholder cascade depth array: 1×1×4 depth32float, cleared to 1.0
  // (fully lit). Use a 4-layer texture to match the real CSM renderer's
  // layout (bindings across backends can't vary arrayLayerCount between
  // the placeholder and the active resource without creating a second
  // BGL — WebGPU validates the layer count at bind time).
  const csmDepthArrayTex = device.createTexture({
    label: "Placeholder CSM cascade array 1x1x4",
    size: [1, 1, 4],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  // Clear every layer to 1.0 so the comparison sampler returns "lit".
  for (let layer = 0; layer < 4; layer++) {
    const layerClearEncoder = device.createCommandEncoder();
    layerClearEncoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: csmDepthArrayTex.createView({
            dimension: "2d",
            baseArrayLayer: layer,
            arrayLayerCount: 1,
          }),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      })
      .end();
    device.queue.submit([layerClearEncoder.finish()]);
  }
  cache.placeholderCsmDepthArrayTex = csmDepthArrayTex;
  cache.placeholderCsmDepthArrayView = csmDepthArrayTex.createView({
    dimension: "2d-array",
    baseArrayLayer: 0,
    arrayLayerCount: 4,
  });

  // C-R8-EDGE-INLINE placeholders. 1×1 transparent textures so the
  // shader's `edgeColor.a <= 0.0` early-out always triggers when the
  // gate (`edgeControl.x > 0.5`) accidentally fires without populated
  // textures. The shared filtering sampler matches the linear-filtering
  // expectations of czm_unpackDepth lookups (texel-aligned but tolerant
  // of nearest neighbours at the boundaries).
  const edgePlaceholderTex = device.createTexture({
    label: "Placeholder edge MRT 1x1",
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: edgePlaceholderTex },
    new Uint8Array([0, 0, 0, 0]),
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  cache.placeholderEdgeTex = edgePlaceholderTex;
  cache.placeholderEdgeView = edgePlaceholderTex.createView();

  const edgeSampler = device.createSampler({
    label: "Edge sampler (filtering)",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  cache.edgeSampler = edgeSampler;

  // C-R10-POINT-LIGHT-RECEIVE placeholder. 1×1×6 depth32float cleared
  // to 1.0 so the shader's comparison sample returns "lit" (refDepth <
  // 1.0 → step→0 → unshadowed) regardless of which face direction is
  // selected. The cube view is bound at binding 17 even when no point
  // light is active so any pipeline that happens to reference the slot
  // stays valid; the shader's `pointLightControl.x > 0.5` gate keeps
  // the placeholder content from being read in steady-state. The size
  // (1×1) keeps the allocation tiny — six 4-byte texels = 24 bytes plus
  // alignment padding.
  const cubeDepthPlaceholderTex = device.createTexture({
    label: "Placeholder point-light cube depth 1x1x6",
    size: [1, 1, 6],
    format: "depth32float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    // Default `dimension` is 2d — combined with `size[2] === 6` this
    // produces a texture that supports `viewDimension: "cube"` views.
  });
  // Clear every face to 1.0 (depth = far plane → "no occluder closer
  // than the light's far radius"). Per-face render pass with depth
  // clear, mirroring the CSM cascade-array placeholder above.
  for (let face = 0; face < 6; face++) {
    const faceClearEncoder = device.createCommandEncoder();
    faceClearEncoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: cubeDepthPlaceholderTex.createView({
            dimension: "2d",
            baseArrayLayer: face,
            arrayLayerCount: 1,
            aspect: "depth-only",
          }),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      })
      .end();
    device.queue.submit([faceClearEncoder.finish()]);
  }
  cache.placeholderCubeDepthTex = cubeDepthPlaceholderTex;
  cache.placeholderCubeDepthView = cubeDepthPlaceholderTex.createView({
    dimension: "cube",
    aspect: "depth-only",
  });

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
      { binding: 1, resource: cache.placeholderDepthView },
      { binding: 2, resource: compSampler },
      { binding: 3, resource: cache.placeholderClipView },
      { binding: 4, resource: clipSampler },
      { binding: 5, resource: cache.placeholderSDFView },
      { binding: 6, resource: sdfSampler },
      { binding: 7, resource: cache.placeholderLutView },
      { binding: 8, resource: cache.placeholderLutView },
      { binding: 9, resource: lutSampler },
      { binding: 10, resource: { buffer: csmParamsPlaceholder } },
      { binding: 11, resource: cache.placeholderCsmDepthArrayView },
      { binding: 12, resource: cache.placeholderEdgeView },
      { binding: 13, resource: cache.placeholderEdgeView },
      { binding: 14, resource: cache.placeholderEdgeView },
      { binding: 15, resource: cache.placeholderEdgeView },
      { binding: 16, resource: edgeSampler },
      // C-R10-POINT-LIGHT-RECEIVE — bind the cleared 1×1×6 cube depth
      // even in the shared placeholder. The shader's
      // `pointLightControl.x` gate stays at 0 in this UB so the cube
      // sample never executes; the binding just satisfies BGL validation.
      { binding: 17, resource: cache.placeholderCubeDepthView },
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
 * @param {GPUTextureView} [options.atmosphereLutTransmittanceView] - Atmosphere
 *   transmittance LUT (256×64 rgba16float) from the performance manager.
 *   When both this and inscatter view are defined, the globe shader's
 *   LUT-sampled fog path activates.
 * @param {GPUTextureView} [options.atmosphereLutInscatterView] - Atmosphere
 *   inscatter LUT (256×128 rgba16float) from the performance manager.
 * @param {{inner?: number, outer?: number}} [options.atmosphereLutPlanetRadii]
 *   - Planet radii (meters) for LUT altitude mapping. Defaults to WGS84
 *   + 2.5% atmosphere thickness.
 * @param {{enabled: boolean, paramsBuffer: GPUBuffer, cascadeArrayView: GPUTextureView}} [options.csm]
 *   - CSM Slice 1: when present with `enabled === true`, binds the cascade
 *   params UBO at binding 10 and the cascade depth array at binding 11,
 *   setting `effects.csmControl.x = 1.0` so the shader routes through
 *   `sampleCascadeShadow` instead of the single-map path. Lives on
 *   `WebGPUCSMRenderer` when active.
 * @param {object} [options.edges] - C-R8-EDGE-INLINE: when populated AND
 *   `edges.ready === true`, binds the edge MRT views at bindings 12/13/14
 *   and the globe packed-depth at binding 15, then sets
 *   `effects.edgeControl.x = 1.0` so the inline `edgeDetectionStage()`
 *   in Model FS samples real data instead of the 1×1 transparent
 *   placeholder. Pass `hasFeatureId: true` to enable per-feature gating
 *   (the WebGL `HAS_EDGE_FEATURE_ID` branch). All views are optional —
 *   any missing view falls through to the placeholder so the bind
 *   group stays valid.
 * @param {boolean} [options.edges.ready]
 * @param {GPUTextureView} [options.edges.edgeColorView]
 * @param {GPUTextureView} [options.edges.edgeIdView]
 * @param {GPUTextureView} [options.edges.edgeDepthView]
 * @param {GPUTextureView} [options.edges.globeDepthView]
 * @param {number} [options.edges.near] - Current frustum near plane.
 * @param {number} [options.edges.far] - Current frustum far plane.
 * @param {number} [options.edges.viewportWidth]
 * @param {number} [options.edges.viewportHeight]
 * @param {boolean} [options.edges.hasFeatureId]
 * @param {object} [options.pointLight] - C-R10-POINT-LIGHT-RECEIVE: when
 *   present with `enabled === true` AND `cubeDepthView` populated, binds
 *   the 6-face cube-depth view at binding 17 and sets
 *   `effects.pointLightControl.x = 1.0` so the model fragment shader
 *   routes through `samplePointShadow` instead of the 2D shadow path.
 *   Provide `lightPositionWC` (Cesium `Cartesian3` or `{x,y,z}`) +
 *   `farPlane` (light radius in meters; matches `shadowMap._pointLightRadius`)
 *   so the receive shader can derive both the cube sample direction
 *   and the perspective-Z reference depth that round-trips against
 *   what the cast pipeline wrote.
 * @param {boolean} [options.pointLight.enabled]
 * @param {GPUTextureView} [options.pointLight.cubeDepthView]
 * @param {{x:number,y:number,z:number}} [options.pointLight.lightPositionWC]
 * @param {number} [options.pointLight.farPlane]
 * @param {number} [options.pointLight.nearPlane] - Defaults to 1.0 to
 *   match `computeOmnidirectional` in ShadowMapComputations.js.
 * @param {number} [options.pointLight.depthBias] - Defaults to 0.005.
 * @param {number} [options.pointLight.darkness] - 0..1; defaults to
 *   the active shadow map's `darkness` field, or 0.3 when no map is
 *   bound (matches Cesium `ShadowMap` defaults).
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
  // CSM Slice 1: optional cascade resources. When `csm.enabled === true`
  // AND both `paramsBuffer` + `cascadeArrayView` are present, the shader
  // sees `effects.csmControl.x = 1.0` and samples the cascade array at
  // binding 11 using the `CSMParams` UBO at binding 10. Otherwise the
  // placeholder resources are bound and the shader stays on the
  // single-shadow-map path.
  const csm = options?.csm;
  const hasCsm =
    defined(csm) &&
    csm.enabled === true &&
    defined(csm.paramsBuffer) &&
    defined(csm.cascadeArrayView);

  // C-R8-EDGE-INLINE: optional edge resources for the inline detection
  // stage in Model FS. Counts as an "active feature" for the early-out
  // gate below — the placeholder bind group's `edgeControl.x = 0` would
  // disable the stage even when populated views are passed.
  const edges = options?.edges;
  const hasEdges =
    defined(edges) &&
    edges.ready === true &&
    defined(edges.edgeColorView) &&
    defined(edges.edgeDepthView);

  // C-R10-POINT-LIGHT-RECEIVE: optional point-light cube depth + light
  // metadata. The shadow map itself drives the auto-detect path below
  // (when `shadowMap._isPointLight` is true and the cube view exists);
  // explicit `options.pointLight` overrides for callers that want fine-
  // grained control (e.g., split-screen comparisons that pin one side
  // to a specific light). Like CSM, counts as an "active feature" so
  // the placeholder isn't returned when only a point light is bound.
  const pointLightOverride = options?.pointLight;
  let pointLightConfig = null;
  if (
    defined(pointLightOverride) &&
    pointLightOverride.enabled === true &&
    defined(pointLightOverride.cubeDepthView) &&
    defined(pointLightOverride.lightPositionWC) &&
    defined(pointLightOverride.farPlane)
  ) {
    pointLightConfig = pointLightOverride;
  } else if (
    defined(shadowMap) &&
    shadowMap.enabled &&
    shadowMap._isPointLight === true
  ) {
    // Auto-pick from the shadow map when it's a point light AND the
    // renderer has populated the cube view + radius. Reading internals
    // (`_webgpuCache.cubeDepthView`, `_lightCamera.positionWC`,
    // `_pointLightRadius`, `_pointBias.depthBias`) keeps callers from
    // having to plumb every field manually — the same pattern the
    // 2D path uses via `getShadowMapResources`.
    const cache = shadowMap._webgpuCache;
    const lightPositionWC = shadowMap._lightCamera?.positionWC;
    const farPlane = shadowMap._pointLightRadius;
    if (
      defined(cache) &&
      defined(cache.cubeDepthView) &&
      defined(lightPositionWC) &&
      defined(farPlane) &&
      farPlane > 0.0
    ) {
      pointLightConfig = {
        enabled: true,
        cubeDepthView: cache.cubeDepthView,
        lightPositionWC,
        farPlane,
        nearPlane: 1.0,
        depthBias: shadowMap._pointBias?.depthBias ?? 0.005,
        darkness: shadowMap.darkness ?? 0.3,
      };
    }
  }
  const hasPointLight = pointLightConfig !== null;

  const placeholder = getPlaceholderEffects(device);
  const bgl = getEffectsBindGroupLayout(device);

  // Shadow resources (2D path — directional / spot lights). When the
  // shadow map is a point light, the cube path takes over via
  // `pointLightConfig` above and we skip the 2D-binding branch here so
  // the placeholder 2D depth stays at binding 1 (the shader gates on
  // `pointLightControl.x` to ignore it). Sourcing `shadowDepthView`
  // from `getShadowMapResources(...).view` for a cube map would yield
  // the per-face stub `faceViews[0]`, which the directional/spot
  // sampler comparison would happily interpret as a 2D depth — wrong
  // semantics for a point light. The early-skip below avoids that.
  let shadowDepthView;
  let shadowCompSampler;
  let hasShadow = false;

  if (defined(shadowMap) && shadowMap.enabled && !hasPointLight) {
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
  if (
    !hasShadow &&
    !hasClipping &&
    !hasPolygonClipping &&
    !hasAtmosphereLut &&
    !hasCsm &&
    !hasEdges &&
    !hasPointLight
  ) {
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
  } else if (hasCsm) {
    // CSM active without a legacy shadow map: the shader's
    // `shadowDarkness >= 1.0` early-out would block cascade sampling,
    // so default to Cesium's `ShadowMap.darkness = 0.3` convention.
    // Callers that want a different value can wire it through
    // `options.csm.darkness` in a future slice.
    Matrix4.pack(Matrix4.IDENTITY, ud, 0);
    ud[16] = 1.0;
    ud[17] = 1.0;
    ud[18] = csm?.darkness ?? 0.3;
    ud[19] = 0.0;
  } else if (hasPointLight) {
    // Point-light receive — same `shadowDarkness >= 1.0` early-out
    // concern as CSM. Pull the override from the resolved point-light
    // config (auto-populated from `shadowMap.darkness` when the path
    // came from the auto-detect branch).
    Matrix4.pack(Matrix4.IDENTITY, ud, 0);
    ud[16] = 1.0;
    ud[17] = 1.0;
    ud[18] = pointLightConfig.darkness ?? 0.3;
    ud[19] = 0.0;
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

  // CSM control block — x=1.0 tells GlobeTerrain's shadow branch to
  // route through `sampleCascadeShadow` (binding 10 UBO + binding 11
  // depth array) instead of the single-map path at bindings 1/2.
  // Future slices pack cascade count into .y and moon-light flag
  // into .z.
  ud[CSM_CONTROL_OFFSET + 0] = hasCsm ? 1.0 : 0.0;
  ud[CSM_CONTROL_OFFSET + 1] = 0.0;
  ud[CSM_CONTROL_OFFSET + 2] = 0.0;
  ud[CSM_CONTROL_OFFSET + 3] = 0.0;

  // C-R8-EDGE-INLINE control blocks — drive the inline edge-detection
  // stage in Model FS. `edgeControl.x = 1.0` flips the gate; the rest
  // are pure data (near/far for window→linear depth conversion in the
  // stage, viewport for screen-space coord, tolerance + featureId
  // flag). Zero-fill when edges aren't ready so the gate stays off.
  if (hasEdges) {
    ud[EDGE_CONTROL_OFFSET + 0] = 1.0;
    ud[EDGE_CONTROL_OFFSET + 1] = 0.0; // isEdgePass — reserved
    ud[EDGE_CONTROL_OFFSET + 2] = edges.near ?? 1.0;
    ud[EDGE_CONTROL_OFFSET + 3] = edges.far ?? 1.0e9;
    ud[EDGE_VIEWPORT_OFFSET + 0] = edges.viewportWidth ?? 1.0;
    ud[EDGE_VIEWPORT_OFFSET + 1] = edges.viewportHeight ?? 1.0;
    // Relative tolerance — multiplied by linear depth in the stage
    // and clamped against `near * 1e-4 + fwidth(...)`. Matches the
    // `geomDepthLinear * 0.0005` term in `EdgeDetectionStageFS.glsl`.
    ud[EDGE_VIEWPORT_OFFSET + 2] = 0.0005;
    ud[EDGE_VIEWPORT_OFFSET + 3] = edges.hasFeatureId ? 1.0 : 0.0;
  } else {
    ud[EDGE_CONTROL_OFFSET + 0] = 0.0;
    ud[EDGE_CONTROL_OFFSET + 1] = 0.0;
    ud[EDGE_CONTROL_OFFSET + 2] = 0.0;
    ud[EDGE_CONTROL_OFFSET + 3] = 0.0;
    ud[EDGE_VIEWPORT_OFFSET + 0] = 1.0;
    ud[EDGE_VIEWPORT_OFFSET + 1] = 1.0;
    ud[EDGE_VIEWPORT_OFFSET + 2] = 0.0;
    ud[EDGE_VIEWPORT_OFFSET + 3] = 0.0;
  }

  // C-R10-POINT-LIGHT-RECEIVE — control + light position blocks.
  //   pointLightControl.x — gate: 1.0 routes the receive shader through
  //     `samplePointShadow` (cube depth at binding 17). 0.0 keeps the
  //     existing 2D / CSM path active.
  //   .y — farPlane (light radius). The cast pipeline used `far =
  //     shadowMap._pointLightRadius` per face camera, so the receive
  //     side has to plug the same value into the perspective-Z
  //     formula to round-trip the depth comparison.
  //   .z — nearPlane (cast pipeline used `near = 1.0`; stored as a
  //     real value so future tunable-near callers don't need a UBO
  //     bump).
  //   .w — depthBias (subtracted from the reference depth before
  //     `textureSampleCompareLevel` — same role as `pointBias.depthBias`
  //     in the WebGL pipeline).
  // pointLightPositionWC.xyz — world-space light position. Receive
  // shader computes `direction = fragWC - lightWC` for both the cube
  // face-direction sample AND the dominant-axis distance feeding
  // refDepth. .w is reserved; future slices may pack a soft-shadow
  // radius or a per-light tint there.
  if (hasPointLight) {
    const lightPos = pointLightConfig.lightPositionWC;
    const farPlane = pointLightConfig.farPlane;
    const nearPlane = pointLightConfig.nearPlane ?? 1.0;
    const depthBias = pointLightConfig.depthBias ?? 0.005;
    ud[POINT_LIGHT_CONTROL_OFFSET + 0] = 1.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 1] = farPlane;
    ud[POINT_LIGHT_CONTROL_OFFSET + 2] = nearPlane;
    ud[POINT_LIGHT_CONTROL_OFFSET + 3] = depthBias;
    ud[POINT_LIGHT_POSITION_OFFSET + 0] = lightPos.x;
    ud[POINT_LIGHT_POSITION_OFFSET + 1] = lightPos.y;
    ud[POINT_LIGHT_POSITION_OFFSET + 2] = lightPos.z;
    ud[POINT_LIGHT_POSITION_OFFSET + 3] = 0.0;
  } else {
    ud[POINT_LIGHT_CONTROL_OFFSET + 0] = 0.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 1] = 0.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 2] = 0.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 3] = 0.0;
    ud[POINT_LIGHT_POSITION_OFFSET + 0] = 0.0;
    ud[POINT_LIGHT_POSITION_OFFSET + 1] = 0.0;
    ud[POINT_LIGHT_POSITION_OFFSET + 2] = 0.0;
    ud[POINT_LIGHT_POSITION_OFFSET + 3] = 0.0;
  }

  // C-R11-EFFECTS-BGL-COLLECTION-CACHE (Batch 55):
  //
  // Build the resource tuple from the resolved-or-placeholder views/
  // samplers/buffers. Then cache the (UBO + GPUBindGroup) pair keyed on
  // the identity of those resources PLUS the small set of content-
  // affecting fields (`cameraInPlaneSpace`, `frameNumber`, edge frustum
  // params, etc.).
  //
  // Why this works for the per-tile globe path: every tile in a frame
  // shares the same shadowMap, clippingPlanes collection, atmosphere
  // LUT views, csm resources, and `cameraInPlaneSpace = uniformState.
  // cameraPosition` (globe modelMatrix is identity). All ~200 tiles in
  // a frame therefore produce the same key → 1 cache entry, written
  // ONCE on the frame's first call. The previous code allocated 200
  // GPUBuffers + 200 GPUBindGroups + ~600 GPUTextureViews per frame.
  //
  // Why correctness holds when content varies (model path, non-identity
  // modelMatrix): different `cameraInPlaneSpace` → different key →
  // different (UBO, BG) pair. Each variant gets its own buffer; we
  // never overwrite a buffer that's already been cached against a
  // different content key.
  const pCache = _placeholderCache.get(device);
  const bgCache = _ensureEffectsBgCache(pCache);

  // Resolve the actual resource objects we'll bind. Falling back to
  // pre-cached placeholder views avoids `texture.createView()` churn
  // (each `createView()` returns a fresh wrapper, which would force
  // a cache miss every frame even with identical inputs).
  const bDepthView = shadowDepthView ?? pCache.placeholderDepthView;
  const bCompSampler = shadowCompSampler ?? pCache.placeholderCompSampler;
  const bClipView = clipTexView ?? pCache.placeholderClipView;
  const bClipSampler = clipSampler ?? pCache.placeholderClipSampler;
  const bSDFView = sdfTexView ?? pCache.placeholderSDFView;
  const bSDFSampler = sdfSampler ?? pCache.placeholderSDFSampler;
  const bLutT = atmosphereLutTransmittanceView ?? pCache.placeholderLutView;
  const bLutI = atmosphereLutInscatterView ?? pCache.placeholderLutView;
  const bCsmBuffer = hasCsm
    ? csm.paramsBuffer
    : pCache.placeholderCsmParamsBuffer;
  const bCsmView = hasCsm
    ? csm.cascadeArrayView
    : pCache.placeholderCsmDepthArrayView;
  const bEdgeColor =
    (hasEdges && edges.edgeColorView) || pCache.placeholderEdgeView;
  const bEdgeId = (hasEdges && edges.edgeIdView) || pCache.placeholderEdgeView;
  const bEdgeDepth =
    (hasEdges && edges.edgeDepthView) || pCache.placeholderEdgeView;
  const bGlobeDepth =
    (hasEdges && edges.globeDepthView) || pCache.placeholderEdgeView;
  // C-R10-POINT-LIGHT-RECEIVE — pick the active cube depth view or the
  // 1×1×6 cleared placeholder. Identity is part of the cache key so
  // toggling point lights on/off allocates a fresh UBO+BG pair.
  const bCubeDepth =
    (hasPointLight && pointLightConfig.cubeDepthView) ||
    pCache.placeholderCubeDepthView;

  // Resource identity key — uniquely names the bound resource graph.
  // Two calls with identical resource identities produce the same
  // string and therefore hit the same cache entry. Identity is a
  // stable >0 integer assigned to each resource object via WeakMap;
  // GC reclaims the WeakMap slot once the resource is unreachable.
  const resKey =
    `${_idFor(bgCache, bDepthView)}|${_idFor(bgCache, bCompSampler)}|` +
    `${_idFor(bgCache, bClipView)}|${_idFor(bgCache, bClipSampler)}|` +
    `${_idFor(bgCache, bSDFView)}|${_idFor(bgCache, bSDFSampler)}|` +
    `${_idFor(bgCache, bLutT)}|${_idFor(bgCache, bLutI)}|` +
    `${_idFor(bgCache, bCsmBuffer)}|${_idFor(bgCache, bCsmView)}|` +
    `${_idFor(bgCache, bEdgeColor)}|${_idFor(bgCache, bEdgeId)}|` +
    `${_idFor(bgCache, bEdgeDepth)}|${_idFor(bgCache, bGlobeDepth)}|` +
    `${_idFor(bgCache, bCubeDepth)}`;

  // Content key — encodes the per-call inputs that drive UBO bytes
  // beyond what's already implied by the bound resources. Most of the
  // UBO is derived from collection-scoped state (clip plane equations,
  // edge color, shadow matrix from the shadowMap object). The two
  // exceptions are `cameraInPlaneSpace` (varies with modelMatrix) and
  // the per-pass edge near/far/viewport fields.
  //
  // For the dominant globe-tile path: cameraInPlaneSpace is the world
  // camera, identical across all 200 tiles in a frame → same content
  // key. For models with per-model modelMatrix: each unique modelMatrix
  // produces its own variant (still amortizes any in-frame repeat).
  const cipx = cameraInPlaneSpace?.x ?? 0;
  const cipy = cameraInPlaneSpace?.y ?? 0;
  const cipz = cameraInPlaneSpace?.z ?? 0;
  // Note: `frameNumber` is NOT in the key. The shadow matrix / edge
  // near-far values change frame-to-frame but the key already includes
  // the shadowMap / edges resource identities; on the same identity
  // we trust the caller-supplied content has been recomputed for the
  // current frame and `writeBuffer` it unconditionally on hit.
  const contentKey = `${cipx}|${cipy}|${cipz}|${edges?.near ?? 0}|${
    edges?.far ?? 0
  }|${edges?.viewportWidth ?? 0}|${edges?.viewportHeight ?? 0}|${
    edges?.hasFeatureId ? 1 : 0
  }`;

  const cacheKey = `${resKey}#${contentKey}`;

  let cached = bgCache.bindGroups.get(cacheKey);
  if (!defined(cached)) {
    // Miss — allocate a fresh UBO + BG and store. The UBO and BG stay
    // pinned in the cache map by the key string; eviction only happens
    // on device-loss via `clearEffectsPlaceholderCacheForDevice`.
    bgCache.misses++;
    const ub = device.createBuffer({
      size: EFFECTS_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Effects UB",
    });
    const bg = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: ub } },
        { binding: 1, resource: bDepthView },
        { binding: 2, resource: bCompSampler },
        { binding: 3, resource: bClipView },
        { binding: 4, resource: bClipSampler },
        { binding: 5, resource: bSDFView },
        { binding: 6, resource: bSDFSampler },
        { binding: 7, resource: bLutT },
        { binding: 8, resource: bLutI },
        { binding: 9, resource: pCache.placeholderLutSampler },
        { binding: 10, resource: { buffer: bCsmBuffer } },
        { binding: 11, resource: bCsmView },
        { binding: 12, resource: bEdgeColor },
        { binding: 13, resource: bEdgeId },
        { binding: 14, resource: bEdgeDepth },
        { binding: 15, resource: bGlobeDepth },
        { binding: 16, resource: pCache.edgeSampler },
        // C-R10-POINT-LIGHT-RECEIVE — cube depth slot. See `bCubeDepth`
        // resolution above; the resource identity is part of `resKey`
        // so a frame that toggles point-light shadows on/off gets a
        // fresh (UBO, BG) pair.
        { binding: 17, resource: bCubeDepth },
      ],
    });
    cached = { buffer: ub, bindGroup: bg };
    bgCache.bindGroups.set(cacheKey, cached);
  } else {
    bgCache.hits++;
  }

  // Always writeBuffer — the cache key fixes the resource graph but
  // the per-frame data inside it (shadow matrix, plane equations,
  // dPrime values, edge frustum) still has to be refreshed on hit.
  // Identical bytes write is a no-op cost wise compared to the
  // savings from skipping `createBuffer` + `createBindGroup`.
  device.queue.writeBuffer(cached.buffer, 0, ud);
  bgCache.bufferWrites++;

  //>>includeStart('debug', pragmas.debug);
  // Diagnostic: log cache stats once per ~3 seconds when in active use.
  // Stripped from production builds. Call sites flood with ~12k calls/
  // sec at peak in unfixed code, so we throttle aggressively.
  const fnow =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : 0;
  if (fnow > 0 && fnow - bgCache.diagLastFrame > 3000) {
    bgCache.diagLastFrame = fnow;
    const total = bgCache.hits + bgCache.misses;
    if (total > 100) {
      const hitRate = ((bgCache.hits / total) * 100).toFixed(1);
      console.log(
        `[CesiumJS:webgpu] EffectsBindGroup cache: ${bgCache.bindGroups.size} entries, ` +
          `${bgCache.hits} hits / ${bgCache.misses} misses (${hitRate}% hit), ` +
          `${bgCache.bufferWrites} writeBuffer calls`,
      );
    }
  }
  //>>includeEnd('debug');

  return { bindGroup: cached.bindGroup, uniformBuffer: cached.buffer };
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

  // CSM control — zero unless the caller rewrites via a full
  // `createEffectsBindGroup` call. Toggling CSM on requires a new
  // bind group (different resource bindings) so we intentionally
  // don't flip this flag from the in-place update path.
  ud[CSM_CONTROL_OFFSET + 0] = 0.0;

  // C-R8-EDGE-INLINE — same rationale as CSM. Toggling on requires
  // re-bind (new edge texture views), so the in-place updater leaves
  // the gate off. Callers that need edges must go through the full
  // `createEffectsBindGroup` factory each frame.
  ud[EDGE_CONTROL_OFFSET + 0] = 0.0;

  // C-R10-POINT-LIGHT-RECEIVE — same rationale as CSM and edges. The
  // cube depth view at binding 17 belongs to a specific shadow map; if
  // the caller wants point-light shadows the only correct path is
  // `createEffectsBindGroup` (which rebinds binding 17 to the active
  // cube view and writes the matching control fields). Leaving the
  // gate off here keeps the receive shader on the 2D / CSM / unlit
  // path until that full rebuild happens.
  ud[POINT_LIGHT_CONTROL_OFFSET + 0] = 0.0;
  ud[POINT_LIGHT_CONTROL_OFFSET + 1] = 0.0;
  ud[POINT_LIGHT_CONTROL_OFFSET + 2] = 0.0;
  ud[POINT_LIGHT_CONTROL_OFFSET + 3] = 0.0;
  ud[POINT_LIGHT_POSITION_OFFSET + 0] = 0.0;
  ud[POINT_LIGHT_POSITION_OFFSET + 1] = 0.0;
  ud[POINT_LIGHT_POSITION_OFFSET + 2] = 0.0;
  ud[POINT_LIGHT_POSITION_OFFSET + 3] = 0.0;

  device.queue.writeBuffer(uniformBuffer, 0, ud);
}

/**
 * C-R12 (Batch 33) — Drop the placeholder cache entry for a specific
 * device. Called from {@link WebGPUContext}'s device-invalidation
 * subscriber during device-loss recovery so the dead device's cached
 * BGL, placeholder textures, samplers, UBOs, and CSM params buffer
 * become unreachable immediately (the WeakMap would self-heal
 * eventually but only once the device object itself is unreachable,
 * which depends on unrelated holders dropping their references).
 *
 * @param {GPUDevice} device
 */
function clearEffectsPlaceholderCacheForDevice(device) {
  if (defined(device) && _placeholderCache.has(device)) {
    _placeholderCache.delete(device);
  }
}

export {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  clearEffectsPlaceholderCacheForDevice,
  EFFECTS_UNIFORM_SIZE,
  ATMOSPHERE_LUT_CONTROL_OFFSET,
  CSM_CONTROL_OFFSET,
  EDGE_CONTROL_OFFSET,
  EDGE_VIEWPORT_OFFSET,
  POINT_LIGHT_CONTROL_OFFSET,
  POINT_LIGHT_POSITION_OFFSET,
  CSM_PARAMS_PLACEHOLDER_BYTES,
};

export default {
  getEffectsBindGroupLayout,
  getPlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  clearEffectsPlaceholderCacheForDevice,
  EFFECTS_UNIFORM_SIZE,
  ATMOSPHERE_LUT_CONTROL_OFFSET,
  CSM_CONTROL_OFFSET,
  EDGE_CONTROL_OFFSET,
  EDGE_VIEWPORT_OFFSET,
  POINT_LIGHT_CONTROL_OFFSET,
  POINT_LIGHT_POSITION_OFFSET,
  CSM_PARAMS_PLACEHOLDER_BYTES,
};
