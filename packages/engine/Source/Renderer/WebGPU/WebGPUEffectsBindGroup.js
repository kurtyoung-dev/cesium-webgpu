/**
 * Creates and manages the combined shadow-receive + clipping-planes bind group
 * used by lit/flat primitive shaders and the globe terrain shader.
 *
 * Full model bind group layout (25 entries; bindings 0..23 and 25):
 *   0: EffectsUniforms       (uniform buffer, 480 bytes)
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
 *                                    `pointLightPositionRTE`. Placeholder is a
 *                                    1×1×6 cube cleared to 1.0 so non-point-
 *                                    light pipelines that share the BGL stay
 *                                    valid; the shader gates on
 *                                    `pointLightControl.x > 0.5` before
 *                                    sampling.)
 *   18: clusterLights         (read-only storage — Forward+ clustered
 *                              80 B per ClusteredLight record × 1024 caps)
 *   19: clusterAABBs          (read-only storage — eye-space AABBs from
 *                              ClusterBounds compute pass, one per cluster)
 *   20: perClusterLightCount  (read-only storage — u32 per cluster)
 *   21: perClusterLightIndices (read-only storage — flat u32 index list)
 *   22: clusterParams         (uniform — viewport + planes + activeLightCount.
 *                              When `activeLightCount.x = 0`, the FS chunk
 *                              early-outs and 18..21 are never sampled.)
 *   See `WebGPUClusteredLightingBGL.ts` for the canonical declaration of
 *   bindings 18..22 and the per-device placeholder buffers used by both the
 *   placeholder bind group and the active bind group when no dispatcher is
 *   running.
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
 * @module WebGPUEffectsBindGroup
 */
import defined from "../../Core/defined.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import {
  getShadowMapResources,
  initWebGPUShadowMap,
} from "./WebGPUShadowMapRenderer.js";
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
// The clustered-lighting bindings 18..22 fold into the existing effects
// bind-group layout because Chromium on Windows caps `maxBindGroups` at 4, so
// they cannot have a group of their own. See `WebGPUClusteredLightingBGL.ts`.
import {
  CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES,
  getClusteredLightingPlaceholders,
} from "./WebGPUClusteredLightingBGL.js";
import WebGPUEffectsStateCache from "./WebGPUEffectsStateCache.js";

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
// 272 → 304 bytes: two vec4 control blocks for the inline edge-detection
// stage in the model fragment shader.
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
// 304 → 336 bytes: two vec4 blocks for the point-light cube-shadow-receive
// path in the model fragment shader.
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
//   offset 320 — `pointLightPositionRTE: vec4<f32>` —
//     xyz = light position relative to the active camera origin (meters).
//           JavaScript subtracts the two f64 ECEF positions before the result
//           is quantized to f32, preserving meter/sub-meter light offsets at
//           planetary scale. Receiver shaders subtract an already-relative
//           fragment position in the same world-axis frame.
//     w   = pcfRadius, for soft point-light shadows. Units are
//           cube-face texels; 0 is hard sampling, a single tap.
//           Typical soft values are 1.0–2.0
//           texels; the receive shader converts this to a projected cube-face
//           shift of `2 * radius / shadowMapSize.x`, then runs a 5-tap cross
//           PCF kernel along the two minor cube-face axes. NOT the same role
//           as `effects.shadowDarkness`
//           (that drives the visibility-→-RGB mix at the call site;
//           pcfRadius drives kernel width here). Defaults to 0 so the
//           hard path stays the default for back-compat.
//     The receive shader computes `direction = fragRTE - lightRTE` for both
//     the cube sample direction and dominant-axis distance. Both operands are
//     camera-relative world-axis vectors, so camera translation cancels while
//     the cube-face orientation remains aligned with the cast cameras.
// 336 → 480 bytes: polygon-clipping atlas control and per-extent UV remap, so
// the model fragment shader can sample `clippingPolygonTex` at the atlas slot
// belonging to the fragment's containing extent. A whole-globe lon/lat mapping
// instead produces garbage SDF samples for any polygon small relative to the
// globe, which is most of them.
//   offset 336 — `clippingPolygonControl: vec4<f32>` —
//     x = extentsCount (number of merged-extent groups in the SDF atlas;
//         polygons with overlapping spherical bounding rectangles get
//         coalesced into one group on the CPU, see
//         `ClippingPolygonCollection.getExtents`),
//     y = atlas inverse dimension (`1.0 / dim` where
//         `dim = ceil(log2(extentsCount))` for extentsCount > 2 and
//         `dim = extentsCount` for ≤ 2 — matches `czm_clipPolygons.glsl`
//         atlas grid layout, precomputed here so the shader avoids a
//         per-fragment `log2`),
//     z = inverse flag (1.0 = `ClippingPolygonCollection.inverse=true`
//         → fragments OUTSIDE every polygon are clipped, used by AEC
//         "show only inside" demos; 0.0 = default cutout — fragments
//         INSIDE any polygon are clipped — matches the
//         non-`#ifdef CLIPPING_INVERSE` branch of `czm_clipPolygons`),
//     w = reserved.
//   offset 352 — `clippingPolygonExtents: array<vec4<f32>, 8>` (128 bytes) —
//     Each vec4 packs `(south, west, latitudeRangeInverse, longitudeRangeInverse)`
//     for one merged-extent group (one atlas slot). Sourced from
//     `ClippingPolygonCollection._extentsFloat32View` (CPU-packed by
//     `packPolygonsAsFloats` in the same vec4 layout). The shader iterates
//     active groups, picks the first whose padded extent contains the
//     fragment's `(lat, lon)`, then samples the SDF at the group's atlas
//     slot. Capped at 8 groups — a typical BIM cutaway needs 1–4. If a
//     scene exceeds 8, the JS side warns once and silently drops the
//     overflow groups (their fragments just won't get clipped).
const EFFECTS_UNIFORM_SIZE = 480;
const EFFECTS_UNIFORM_FLOATS = EFFECTS_UNIFORM_SIZE / 4;
// Polygon clipping atlas control and per-extent remap.
const CLIPPING_POLYGON_CONTROL_OFFSET = 84; // 336 bytes / 4
const CLIPPING_POLYGON_EXTENTS_OFFSET = 88; // 352 bytes / 4
const CLIPPING_POLYGON_EXTENTS_MAX = 8;
// Offset (in floats) of the atmosphereLutControl vec4 in the UBO data
// array. `createEffectsBindGroup` / the globe surface renderer writes
// into this slot when it has LUT resources to share.
const ATMOSPHERE_LUT_CONTROL_OFFSET = 60; // 240 bytes / 4
const CSM_CONTROL_OFFSET = 64; // 256 bytes / 4
const EDGE_CONTROL_OFFSET = 68; // 272 bytes / 4
const EDGE_VIEWPORT_OFFSET = 72; // 288 bytes / 4
// Point-light cube-shadow control and light position: two vec4 slots, eight
// floats, after the edge block.
const POINT_LIGHT_CONTROL_OFFSET = 76; // 304 bytes / 4
const POINT_LIGHT_POSITION_OFFSET = 80; // 320 bytes / 4
const CLIP_DPRIME_FLOAT_OFFSET = 28;

/**
 * Resolve the camera origin used by renderer RTE uniform blocks.
 *
 * UniformState is authoritative because offscreen/multi-view passes may
 * temporarily publish a camera that differs from `frameState.camera`. The
 * frame-state camera remains a compatibility fallback for isolated callers.
 *
 * @param {object} frameState
 * @returns {object|undefined}
 * @private
 */
function resolvePointShadowCameraPosition(frameState) {
  return (
    frameState?.context?.uniformState?.cameraPosition ??
    frameState?.camera?.positionWC
  );
}

/**
 * Pack an absolute point-light position as a camera-relative f32 vector.
 *
 * The subtraction happens in JavaScript number precision before assigning to
 * the Float32Array. This is the precision-critical ordering: independently
 * quantizing Earth-scale light/camera coordinates and subtracting them in WGSL
 * loses meter-scale separation.
 *
 * @param {{x:number,y:number,z:number}} lightPositionWC
 * @param {{x:number,y:number,z:number}|undefined} cameraPositionWC
 * @param {number} pcfRadius
 * @param {Float32Array} result
 * @param {number} [offset=POINT_LIGHT_POSITION_OFFSET]
 * @returns {Float32Array}
 * @private
 */
function packPointLightPositionRelativeToCamera(
  lightPositionWC,
  cameraPositionWC,
  pcfRadius,
  result,
  offset = POINT_LIGHT_POSITION_OFFSET,
) {
  const cameraX = cameraPositionWC?.x ?? 0.0;
  const cameraY = cameraPositionWC?.y ?? 0.0;
  const cameraZ = cameraPositionWC?.z ?? 0.0;
  result[offset + 0] = lightPositionWC.x - cameraX;
  result[offset + 1] = lightPositionWC.y - cameraY;
  result[offset + 2] = lightPositionWC.z - cameraZ;
  result[offset + 3] = pcfRadius;
  return result;
}

// CSM params UBO size. Must match `WebGPUCSMRenderer._cascadeParamsData`
// (272 floats = 1088 bytes). The WGSL CSMParams struct is only 80 floats /
// 320 bytes; the renderer over-allocates to 272 floats so this placeholder and
// the real buffer share one size for the binding-10 minBindingSize hint.
// NOTE: 1088 is NOT 256-aligned (1088 % 256 = 64) — a uniform buffer's SIZE only
// needs a 4-byte multiple; the 256 rule applies to dynamic binding OFFSETS, not
// buffer size. The renderer separately rounds its real GPU buffer up to 1280 at
// creation (WebGPUCSMRenderer.ts:372-373). If the placeholder ever diverges from
// the real layout, the BGL minBindingSize guard on binding 10 catches it at
// pipeline-creation time. Keep this in sync with the CSM renderer.
const CSM_PARAMS_PLACEHOLDER_FLOATS = 272;
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
//   2. `effectsBgCaches` — one context-scoped stable owner/resource cache per
//      context sharing this device. Volatile camera bytes never participate
//      in permanent identity, and Scene-local frame numbers never cross an
//      eviction boundary between contexts.
const _placeholderCache = new WeakMap();
const LEGACY_EFFECTS_CONTEXT = Object.freeze({});

const PLACEHOLDER_TEXTURE_FIELDS = Object.freeze([
  "placeholderDepthTex",
  "placeholderClipTex",
  "placeholderSDFTex",
  "placeholderLutTex",
  "placeholderCsmDepthArrayTex",
  "placeholderEdgeTex",
  "placeholderCubeDepthTex",
]);

const PLACEHOLDER_BUFFER_FIELDS = Object.freeze([
  "placeholderCsmParamsBuffer",
  "placeholderUniformBuffer",
]);

function getOrCreateEffectsDeviceCache(device) {
  let cache = _placeholderCache.get(device);
  if (!defined(cache)) {
    cache = {
      owners: new Set(),
    };
    _placeholderCache.set(device, cache);
  } else if (!defined(cache.owners)) {
    cache.owners = new Set();
  }
  return cache;
}

function destroyEffectsStateCache(bgCache, destroyResource) {
  bgCache?.stateCache.drain((resources) => {
    for (let i = 0; i < resources.length; i++) {
      destroyResource(resources[i].buffer);
    }
  });
}

function destroyEffectsDeviceCache(cache) {
  const destroyed = new Set();
  const destroyResource = (resource) => {
    if (
      !defined(resource) ||
      destroyed.has(resource) ||
      typeof resource.destroy !== "function"
    ) {
      return;
    }
    destroyed.add(resource);
    resource.destroy();
  };

  if (defined(cache.effectsBgCaches)) {
    for (const bgCache of cache.effectsBgCaches.values()) {
      destroyEffectsStateCache(bgCache, destroyResource);
    }
    cache.effectsBgCaches.clear();
  }

  const pendingRetirements = cache.effectsRetirementQueue ?? [];
  cache.effectsRetirementQueue = [];
  cache.effectsRetirementPending = false;
  for (let i = 0; i < pendingRetirements.length; i++) {
    destroyResource(pendingRetirements[i].buffer);
  }

  for (let i = 0; i < PLACEHOLDER_TEXTURE_FIELDS.length; i++) {
    const field = PLACEHOLDER_TEXTURE_FIELDS[i];
    destroyResource(cache[field]);
    cache[field] = undefined;
  }
  for (let i = 0; i < PLACEHOLDER_BUFFER_FIELDS.length; i++) {
    const field = PLACEHOLDER_BUFFER_FIELDS[i];
    destroyResource(cache[field]);
    cache[field] = undefined;
  }

  cache.owners?.clear();
}

/**
 * Retains a context's ownership of the effects cache for a physical device.
 * Multiple contexts may share a pooled device, so cache resources are not
 * destroyed until the last distinct owner releases them.
 *
 * @param {GPUDevice} device
 * @param {object} owner
 */
function retainEffectsPlaceholderCacheForContext(device, owner) {
  if (!defined(device) || !defined(owner)) {
    return;
  }
  getOrCreateEffectsDeviceCache(device).owners.add(owner);
}

/**
 * Releases one context owner. Returns true only when this release destroyed
 * the last-owner cache entry.
 *
 * @param {GPUDevice} device
 * @param {object} owner
 * @returns {boolean}
 */
function releaseEffectsPlaceholderCacheForContext(device, owner) {
  if (!defined(device) || !defined(owner)) {
    return false;
  }
  const cache = _placeholderCache.get(device);
  if (!defined(cache) || !cache.owners?.delete(owner)) {
    return false;
  }

  // Dynamic effects UBOs carry view/camera state and are context-owned even
  // though immutable placeholders and layouts are device-shared. Drain this
  // context's slots on every release so a surviving pooled context neither
  // retains nor can accidentally reuse the departing context's state.
  const contextCache = cache.effectsBgCaches?.get(owner);
  if (defined(contextCache)) {
    destroyEffectsStateCache(contextCache, (resource) => {
      if (typeof resource?.destroy === "function") {
        resource.destroy();
      }
    });
    cache.effectsBgCaches.delete(owner);
  }
  if (cache.owners.size > 0) {
    return false;
  }
  destroyEffectsDeviceCache(cache);
  _placeholderCache.delete(device);
  return true;
}

/**
 * @param {object} cache - per-device placeholder cache entry
 * @returns {object}
 */
function _ensureEffectsBgCache(cache, contextOwner) {
  cache.effectsBgCaches ??= new Map();
  const key = contextOwner ?? LEGACY_EFFECTS_CONTEXT;
  let bgCache = cache.effectsBgCaches.get(key);
  if (!defined(bgCache)) {
    bgCache = {
      stateCache: new WebGPUEffectsStateCache({ maxGroups: 256 }),
      idMap: new WeakMap(),
      idCounter: 0,
      diagLastFrame: -1,
    };
    cache.effectsBgCaches.set(key, bgCache);
  }
  return bgCache;
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

function retireEffectsResources(device, resources) {
  const cache = _placeholderCache.get(device);
  if (!defined(cache)) {
    return;
  }
  cache.effectsRetirementQueue ??= [];
  cache.effectsRetirementQueue.push(...resources);
  if (cache.effectsRetirementPending) {
    return;
  }
  cache.effectsRetirementPending = true;

  const destroyQueued = () => {
    const retired = cache.effectsRetirementQueue;
    cache.effectsRetirementQueue = [];
    cache.effectsRetirementPending = false;
    for (let i = 0; i < retired.length; i++) {
      retired[i].buffer.destroy();
    }
  };

  if (typeof device.queue.onSubmittedWorkDone !== "function") {
    destroyQueued();
    return;
  }
  device.queue.onSubmittedWorkDone().then(destroyQueued, () => {
    // Device loss owns reclamation; drop stale JS references without calling
    // into the failed device.
    cache.effectsRetirementQueue = [];
    cache.effectsRetirementPending = false;
  });
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
    cache = getOrCreateEffectsDeviceCache(device);
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
    // Inline edge-detection resources for the model fragment shader. Always
    // present in the layout — with 1×1 placeholder textures and a shared
    // filtering sampler when no edges are populated — so all model pipelines
    // share one bind-group layout. The shader gates sampling on
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
    // Point-light cube depth target. Always present in the layout — with a
    // 1×1×6 placeholder cleared to 1.0 when point-light shadows are off — so
    // model and primitive pipelines share one bind-group layout across both
    // light types. The receive shader gates
    // sampling on `effects.pointLightControl.x > 0.5` — when false,
    // this binding is bound but never sampled. Reusing binding 2 as
    // the comparison sampler keeps the binding count from drifting.
    texture(17, Stage.FRAGMENT, {
      sampleType: "depth",
      viewDimension: "cube",
    }),
    // Forward+ clustered lighting bindings.
    // The five entries, 18..22, come from
    // CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES so the binding numbers
    // + types match the WGSL chunk and the active/placeholder bind group
    // builders below. Always present in the layout (placeholders bound
    // when no dispatcher is running) so consumer pipelines that include
    // the ClusteredLighting WGSL chunk validate against one shared BGL.
    ...CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES,
  ]);

  return cache.bgl;
}

/**
 * Returns the globe-only effects layout. Globe terrain consumes the shared
 * shadow, clipping, atmosphere, CSM, and point-light resources, but its WGSL
 * does not declare the model edge-detection or clustered/area-light bindings.
 * Keeping those model-only bindings out of the globe pipeline layout lowers
 * its fragment sampled-texture footprint from 12 effects textures to 7.
 *
 * @param {GPUDevice} device
 * @returns {GPUBindGroupLayout}
 */
function getGlobeEffectsBindGroupLayout(device) {
  const cache = getOrCreateEffectsDeviceCache(device);
  if (defined(cache.globeBgl)) {
    return cache.globeBgl;
  }

  cache.globeBgl = makeBindGroupLayout(
    device,
    "Globe effects BGL (shadow + clipping)",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      texture(1, Stage.FRAGMENT, { sampleType: "depth" }),
      sampler(2, Stage.FRAGMENT, "comparison"),
      texture(3, Stage.FRAGMENT, { sampleType: "unfilterable-float" }),
      sampler(4, Stage.FRAGMENT, "non-filtering"),
      texture(5, Stage.FRAGMENT),
      sampler(6, Stage.FRAGMENT),
      texture(7, Stage.FRAGMENT, { sampleType: "float" }),
      texture(8, Stage.FRAGMENT, { sampleType: "float" }),
      sampler(9, Stage.FRAGMENT),
      uniformBuffer(10, Stage.FRAGMENT),
      texture(11, Stage.FRAGMENT, {
        sampleType: "depth",
        viewDimension: "2d-array",
      }),
      texture(17, Stage.FRAGMENT, {
        sampleType: "depth",
        viewDimension: "cube",
      }),
    ],
  );
  return cache.globeBgl;
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
    cache = getOrCreateEffectsDeviceCache(device);
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
  // Cache the view so the hot path does not call `createView()` on every
  // bind-group construction.
  cache.placeholderDepthView = depthTex.createView();

  // All placeholder depth subresources are initialized in one command buffer.
  // The 11 clear passes remain distinct because each targets a different
  // subresource: base depth, four CSM layers, and six point-light cube faces.
  const clearEncoder = device.createCommandEncoder({
    label: "Initialize effects depth placeholders",
  });
  clearEncoder
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: cache.placeholderDepthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    })
    .end();

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
    clearEncoder
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
  }
  cache.placeholderCsmDepthArrayTex = csmDepthArrayTex;
  cache.placeholderCsmDepthArrayView = csmDepthArrayTex.createView({
    dimension: "2d-array",
    baseArrayLayer: 0,
    arrayLayerCount: 4,
  });

  // Edge placeholders: 1×1 transparent textures, so the
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

  // Point-light placeholder: a 1×1×6 depth32float cleared
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
    clearEncoder
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
  }
  device.queue.submit([clearEncoder.finish()]);
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

  // Per-device clustered-lighting placeholder buffers, bound at slots 18..22
  // of the placeholder bind group so the layout validates regardless of
  // whether a scene renderer's dispatcher is
  // running yet. The placeholder `params` is zero-filled, so any
  // pipeline whose WGSL includes the ClusteredLighting chunk reads
  // `activeLightCount = 0` and early-outs without touching slots 18..21.
  const clusteredPH = getClusteredLightingPlaceholders(device);

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
      // Bind the cleared 1×1×6 cube depth even in the shared placeholder.
      // The shader's
      // `pointLightControl.x` gate stays at 0 in this UB so the cube
      // sample never executes; the binding just satisfies BGL validation.
      { binding: 17, resource: cache.placeholderCubeDepthView },
      // Clustered lighting placeholders.
      { binding: 18, resource: { buffer: clusteredPH.clusterLights } },
      { binding: 19, resource: { buffer: clusteredPH.clusterAABBs } },
      { binding: 20, resource: { buffer: clusteredPH.perClusterLightCount } },
      {
        binding: 21,
        resource: { buffer: clusteredPH.perClusterLightIndices },
      },
      { binding: 22, resource: { buffer: clusteredPH.params } },
      // Placeholders (LUT texture + area-light buffer;
      // no sampler — LUT read via textureLoad).
      { binding: 23, resource: clusteredPH.ltcLUTView },
      { binding: 25, resource: { buffer: clusteredPH.areaLights } },
    ],
  });

  return {
    bindGroup: cache.placeholderBindGroup,
    uniformBuffer: cache.placeholderUniformBuffer,
  };
}

/**
 * Returns a placeholder matching {@link getGlobeEffectsBindGroupLayout}.
 * Placeholder textures and buffers remain device-shared with the complete
 * effects layout; only the bind-group shape is specialized per consumer.
 *
 * @param {GPUDevice} device
 * @returns {{ bindGroup: GPUBindGroup, uniformBuffer: GPUBuffer }}
 */
function getGlobePlaceholderEffects(device) {
  // Initialize the canonical placeholder resource set once. Models and
  // primitives may share the same physical device with the globe, so the
  // resources themselves stay centralized while the cheap binding wrapper is
  // specialized to avoid charging the globe pipeline model-only limits.
  getPlaceholderEffects(device);
  const cache = getOrCreateEffectsDeviceCache(device);
  if (!defined(cache.globePlaceholderBindGroup)) {
    cache.globePlaceholderBindGroup = device.createBindGroup({
      label: "Globe placeholder effects BG",
      layout: getGlobeEffectsBindGroupLayout(device),
      entries: [
        {
          binding: 0,
          resource: { buffer: cache.placeholderUniformBuffer },
        },
        { binding: 1, resource: cache.placeholderDepthView },
        { binding: 2, resource: cache.placeholderCompSampler },
        { binding: 3, resource: cache.placeholderClipView },
        { binding: 4, resource: cache.placeholderClipSampler },
        { binding: 5, resource: cache.placeholderSDFView },
        { binding: 6, resource: cache.placeholderSDFSampler },
        { binding: 7, resource: cache.placeholderLutView },
        { binding: 8, resource: cache.placeholderLutView },
        { binding: 9, resource: cache.placeholderLutSampler },
        {
          binding: 10,
          resource: { buffer: cache.placeholderCsmParamsBuffer },
        },
        { binding: 11, resource: cache.placeholderCsmDepthArrayView },
        { binding: 17, resource: cache.placeholderCubeDepthView },
      ],
    });
  }
  return {
    bindGroup: cache.globePlaceholderBindGroup,
    uniformBuffer: cache.placeholderUniformBuffer,
  };
}

const _scratchEffectsData = new Float32Array(EFFECTS_UNIFORM_FLOATS);
const _scratchEffectsBits = new Uint32Array(_scratchEffectsData.buffer);
// The post-light-fit partial write covers exactly the first 20 words / 80
// bytes: shadowMatrix(16) + shadowMapSize(2) + darkness(1) + soft(1).
const SHADOW_RECEIVE_PREFIX_WORDS = 20;
const _scratchShadowReceivePrefix = new Float32Array(
  SHADOW_RECEIVE_PREFIX_WORDS,
);
const _scratchShadowReceivePrefixBits = new Uint32Array(
  _scratchShadowReceivePrefix.buffer,
);
// Tracks the first 80 bytes actually resident in each live effects UBO. The
// state cache owns full-payload comparisons against its own slot arrays; this
// weak sidecar is private to this module and holds only the prefix, so a
// settled static shadow skips its queue.writeBuffer without either aliasing or
// mutating cache-owned storage, and without retaining retired GPUBuffers.
const _shadowReceivePrefixByBuffer = new WeakMap();

function recordShadowReceivePrefix(uniformBuffer, uniformBits) {
  let cached = _shadowReceivePrefixByBuffer.get(uniformBuffer);
  if (!defined(cached)) {
    cached = new Uint32Array(SHADOW_RECEIVE_PREFIX_WORDS);
    _shadowReceivePrefixByBuffer.set(uniformBuffer, cached);
  }
  // `uniformBits` may be a full-payload view; only the prefix is copied.
  for (let i = 0; i < SHADOW_RECEIVE_PREFIX_WORDS; i++) {
    cached[i] = uniformBits[i];
  }
}

// Prefix-only comparison against `_scratchShadowReceivePrefixBits`. A
// whole-array compare (`bitsEqual`) is wrong here: it rejects on length alone,
// so the gate below never fired and every frame paid the 80-byte write.
function shadowReceivePrefixMatches(cached) {
  if (!defined(cached)) {
    return false;
  }
  for (let i = 0; i < SHADOW_RECEIVE_PREFIX_WORDS; i++) {
    if (cached[i] !== _scratchShadowReceivePrefixBits[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Creates an active effects bind group with real shadow and/or clipping resources.
 * Falls back to placeholder sub-resources when either feature is inactive.
 *
 * @param {GPUDevice} device
 * @param {FrameState} frameState
 * @param {object} [options]
 * @param {object} [options.owner] Stable view/model/context owner identity.
 *   Required on hot paths so volatile camera values update bounded slots
 *   rather than becoming permanent cache keys.
 * @param {object} [options.shadowMap] - CesiumJS ShadowMap object
 * @param {object} [options.clippingPlanes] - ClippingPlaneCollection with _webgpuCache
 * @param {object} [options.clippingPolygons] - ClippingPolygonCollection with _webgpuCache
 * @param {object} [options.cameraInPlaneSpace] - Unencoded
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
 * @param {{inner: (number|undefined), outer: (number|undefined)}} [options.atmosphereLutPlanetRadii]
 *   - Planet radii (meters) for LUT altitude mapping. Defaults to WGS84
 *   + 2.5% atmosphere thickness.
 * @param {{enabled: boolean, paramsBuffer: GPUBuffer, cascadeArrayView: GPUTextureView, pcfRadius: (number|undefined)}} [options.csm]
 *   - When present with `enabled === true`, binds the cascade
 *   params UBO at binding 10 and the cascade depth array at binding 11,
 *   setting `effects.csmControl.x = 1.0` so the shader routes through
 *   `sampleCascadeShadow` instead of the single-map path. Lives on
 *   `WebGPUCSMRenderer` when active. `pcfRadius` (shadow texels, default
 *   from the renderer's `softShadows` config) drives the 3x3 PCF box
 *   kernel via `effects.csmControl.y`.
 * @param {object} [options.edges] - When populated AND
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
 * @param {object} [options.pointLight] - When
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
 * @param {number} [options.pointLight.pcfRadius] - Soft point-
 *   light shadow radius in cube-face texels. 0, the default, is the
 *   hard-edge path — a single comparison sample. Above 0 enables
 *   the 5-tap cross PCF kernel in `samplePointShadow`. Auto-populated
 *   from `shadowMap._softShadows ? 1.5 : 0.0` when sourced from a
 *   ShadowMap; explicit overrides allow per-call control.
 * @param {object} [options.clusteredLighting] - The live
 *   clustered-lighting dispatcher's GPU buffers from
 *   `WebGPUSceneRenderer._getClusteredLightingBuffers()`. When present,
 *   bindings 18..22 use these handles so the Forward+ FS chunk in
 *   ModelPBRComplete (and follow-on Lit Mat shaders) reads the
 *   per-frame cluster data. When omitted, per-device placeholders
 *   are bound and the FS chunk early-outs via `activeLightCount = 0`.
 * @param {GPUBuffer} [options.clusteredLighting.clusterLights]
 * @param {GPUBuffer} [options.clusteredLighting.clusterAABBs]
 * @param {GPUBuffer} [options.clusteredLighting.perClusterLightCount]
 * @param {GPUBuffer} [options.clusteredLighting.perClusterLightIndices]
 * @param {GPUBuffer} [options.clusteredLighting.params]
 * @param {"globe"} [options.consumer] - Selects the reduced globe layout,
 *   which omits model-only edge and clustered/area-light bindings.
 * @returns {{ bindGroup: GPUBindGroup, uniformBuffer: GPUBuffer }}
 */
function createEffectsBindGroup(device, frameState, options) {
  const globeConsumer = options?.consumer === "globe";
  const shadowMap = options?.shadowMap;
  // Model/globe effects bindings are assembled during primitive update,
  // before ViewportExecutor updates the fitted light camera. Allocate the
  // backend resources now so the first shadowed frame binds the real depth
  // view; the later ShadowMap update fills the current matrix and the cast
  // pass writes the texture before color commands execute.
  if (defined(shadowMap) && shadowMap.enabled) {
    initWebGPUShadowMap(shadowMap, frameState);
  }
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

  // Optional edge resources for the inline detection stage in the model
  // fragment shader. Counts as an active feature for the early-out
  // gate below — the placeholder bind group's `edgeControl.x = 0` would
  // disable the stage even when populated views are passed.
  const edges = options?.edges;
  const hasEdges =
    defined(edges) &&
    edges.ready === true &&
    defined(edges.edgeColorView) &&
    defined(edges.edgeDepthView);

  // Optional point-light cube depth and light metadata. The shadow map
  // itself drives the auto-detect path below, when `shadowMap._isPointLight`
  // is true and the cube view exists; an explicit `options.pointLight`
  // overrides that, for callers wanting fine-grained control such as a
  // split-screen comparison pinning one side to a specific light. Like CSM,
  // counts as an active feature so
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
        // Read the faded `_darkness` that WebGL's `combineUniforms` reads,
        // not the public unfaded property, so the two backends fade
        // identically. `getShadowMapResources` reads the same field.
        darkness: shadowMap._darkness ?? shadowMap.darkness ?? 0.3,
        // Soft point-light shadows. `ShadowMap.softShadows` is the opt-in
        // flag, mirroring the WebGL `softShadows` path; when set, the model
        // fragment shader gets a 1.5-texel PCF radius, which noticeably
        // softens the edge and still holds above 120 fps on the 5-tap
        // kernel. Hard sampling is the default when `softShadows` is false.
        pcfRadius: shadowMap.softShadows ? 1.5 : 0.0,
        // Cube-face edge length in texels — the receive shader scales
        // pcfRadius by `1.0 / cubeFaceSize` to convert texels to a unit-
        // direction perturbation. We piggyback on `effects.shadowMapSize.x`
        // (which is the natural carrier and unused by the point-light path
        // otherwise) so this value drives both the kernel scaling and any
        // future debug overlay that wants to read the cube size.
        cubeFaceSize: cache.size ?? shadowMap._textureSize?.x ?? 1024,
      };
    }
  }
  const hasPointLight = pointLightConfig !== null;

  const placeholder = globeConsumer
    ? getGlobePlaceholderEffects(device)
    : getPlaceholderEffects(device);
  const bgl = globeConsumer
    ? getGlobeEffectsBindGroupLayout(device)
    : getEffectsBindGroupLayout(device);

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
    if (defined(polyCache) && defined(polyCache.signedDistanceTextureView)) {
      sdfTexView = polyCache.signedDistanceTextureView;
      sdfSampler = polyCache.sdfSampler;
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

  // Clustered lighting counts as an active feature when the caller has
  // handed over live dispatcher buffers. The shared placeholder bind group
  // binds per-device placeholder cluster buffers, whose params carry
  // `activeLightCount = 0` and make the fragment chunk early-out, so
  // reaching the dispatcher's real buffers at the consumer site means
  // skipping the early return and building the active bind group below.
  const hasClusteredLighting = defined(options?.clusteredLighting);

  // If no features are active, return the shared placeholder
  if (
    !hasShadow &&
    !hasClipping &&
    !hasPolygonClipping &&
    !hasAtmosphereLut &&
    !hasCsm &&
    !hasEdges &&
    !hasPointLight &&
    !hasClusteredLighting
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
    // came from the auto-detect branch). `shadowMapSize.x`
    // carries the cube-face edge length so the model FS's PCF kernel
    // can scale `pcfRadius` (texels) to a `2 * radius / shadowMapSize.x`
    // projected cube-face perturbation. .y is unused on this path; we
    // mirror .x to keep the field square (no shader currently reads
    // .y but a future round-cube probe might).
    const cubeFaceSize = pointLightConfig.cubeFaceSize ?? 1024;
    Matrix4.pack(Matrix4.IDENTITY, ud, 0);
    ud[16] = cubeFaceSize;
    ud[17] = cubeFaceSize;
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

    // Atlas control and per-extent UV remap, so
    // `modelClipByPolygon` (and the equivalent globe-side helper)
    // sample the SDF at the correct atlas slot. The CPU-side
    // `_extentsFloat32View` already packs `(south, west, invLatRange,
    // invLonRange)` per merged-extent group; copy up to
    // `CLIPPING_POLYGON_EXTENTS_MAX` groups.
    const extentsView = clippingPolygons._extentsFloat32View;
    const extentsCount = clippingPolygons._extentsCount ?? 0;
    if (defined(extentsView) && extentsCount > 0) {
      const usedCount = Math.min(extentsCount, CLIPPING_POLYGON_EXTENTS_MAX);
      // Atlas grid math MUST mirror `PolygonSignedDistance.wgsl:53-56`
      // — the SDF compute pass writes its atlas using the FULL
      //   dim = (extentsCount > 2) ? ceil(log2(extentsCount)) : extentsCount
      // formula, not the capped count. Deriving `dim` from `usedCount`
      // instead breaks any scene with more than 8 merged-extent groups:
      // the SDF compute writes, say, a 4×4 atlas while this publishes
      // `invDim = 1/3`, and every region samples the wrong slot. The
      // uniform array is still capped at `CLIPPING_POLYGON_EXTENTS_MAX`,
      // so regions at index 8 and beyond simply do not clip, while
      // regions 0..7 sample the correct slot.
      // Precompute `1/dim` so the shader skips per-fragment log2.
      const dim =
        extentsCount > 2 ? Math.ceil(Math.log2(extentsCount)) : extentsCount;
      ud[CLIPPING_POLYGON_CONTROL_OFFSET] = usedCount;
      ud[CLIPPING_POLYGON_CONTROL_OFFSET + 1] = 1.0 / dim;
      ud[CLIPPING_POLYGON_CONTROL_OFFSET + 2] = clippingPolygons.inverse
        ? 1.0
        : 0.0;
      // ud[+3] reserved.
      // Each merged-extent group is 4 floats in `_extentsFloat32View`,
      // packed contiguously in extentsList order. The polygon FS picks
      // the first group whose padded extent contains the fragment.
      const floatCount = usedCount * 4;
      for (let i = 0; i < floatCount; i++) {
        ud[CLIPPING_POLYGON_EXTENTS_OFFSET + i] = extentsView[i];
      }
      if (extentsCount > CLIPPING_POLYGON_EXTENTS_MAX) {
        oneTimeWarning(
          "WebGPUClippingPolygons.maxExtents",
          `[WebGPU] ClippingPolygonCollection produced ${extentsCount} merged-extent groups; the WGSL UBO supports up to ${CLIPPING_POLYGON_EXTENTS_MAX}. Overflow groups (${extentsCount - CLIPPING_POLYGON_EXTENTS_MAX}) will not clip.`,
        );
      }
    }
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
  // .y is the PCF kernel radius in shadow texels. Above 0 it routes the
  // receive shaders' `sampleOneCascade` through a 3x3 box kernel, matching
  // WebGL's `czm_shadowVisibility` under `USE_SOFT_SHADOWS`; 0 keeps a
  // single hardware-comparison tap, a hard edge. Sourced from the
  // CSM renderer's `softShadows` config (default 1.5 texels).
  ud[CSM_CONTROL_OFFSET + 1] = hasCsm ? (csm?.pcfRadius ?? 0.0) : 0.0;
  ud[CSM_CONTROL_OFFSET + 2] = 0.0;
  ud[CSM_CONTROL_OFFSET + 3] = 0.0;

  // Control blocks driving the inline edge-detection stage in the model
  // fragment shader. `edgeControl.x = 1.0` flips the gate; the rest
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

  // Point-light control and light-position blocks.
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
  // pointLightPositionRTE.xyz — light position relative to the same active
  // camera origin used by renderer RTE UBs. The f64 JS subtraction happens
  // before f32 packing; receiver shaders use their existing camera-relative
  // fragment vector directly. .w remains the soft-shadow PCF radius.
  if (hasPointLight) {
    const lightPos = pointLightConfig.lightPositionWC;
    const farPlane = pointLightConfig.farPlane;
    const nearPlane = pointLightConfig.nearPlane ?? 1.0;
    const depthBias = pointLightConfig.depthBias ?? 0.005;
    // The PCF radius defaults to 0, hard sampling. When the caller wires
    // `pcfRadius > 0`, or the auto-detect branch above resolved a
    // soft-shadows-enabled ShadowMap to 1.5 texels, the
    // model FS runs a 5-tap cross kernel on the cube depth instead
    // of the single-tap hard sample.
    const pcfRadius = pointLightConfig.pcfRadius ?? 0.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 0] = 1.0;
    ud[POINT_LIGHT_CONTROL_OFFSET + 1] = farPlane;
    ud[POINT_LIGHT_CONTROL_OFFSET + 2] = nearPlane;
    ud[POINT_LIGHT_CONTROL_OFFSET + 3] = depthBias;
    packPointLightPositionRelativeToCamera(
      lightPos,
      resolvePointShadowCameraPosition(frameState),
      pcfRadius,
      ud,
    );
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

  // Build the resource tuple from the resolved-or-placeholder views/
  // samplers/buffers. Then cache the (UBO + GPUBindGroup) pair under a
  // stable owner/resource identity. Camera, edge, and viewport values live
  // only in the bounded slot bytes; they never become permanent cache keys.
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
  // modelMatrix): distinct byte payloads used during the same frame acquire
  // distinct slots. On a later frame those slots can be rewritten, because
  // no slot referenced by the current frame is selected for replacement.
  const pCache = _placeholderCache.get(device);
  // Uniform slots are scoped to the logical context. Frame numbers are only
  // monotonic within one Scene/Context; treating them as device-global lets a
  // fast context evict buffers referenced by another context's open encoder.
  // Placeholders/layouts remain shared in pCache, while volatile slots do not.
  const bgCache = _ensureEffectsBgCache(pCache, frameState?.context);

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
  // Pick the active cube depth view or the
  // 1×1×6 cleared placeholder. Identity is part of the cache key so
  // toggling point lights on/off allocates a fresh UBO+BG pair.
  const bCubeDepth =
    (hasPointLight && pointLightConfig.cubeDepthView) ||
    pCache.placeholderCubeDepthView;

  // Clustered lighting buffer handles: the active dispatcher's buffers
  // when the scene renderer wires them through
  // `options.clusteredLighting`; otherwise the per-device placeholders
  // (whose `params` reads `activeLightCount = 0` so the consumer FS
  // chunk early-outs). Identities participate in the resource key so
  // a scene that toggles `clusteredLightingEnabled` on/off allocates
  // a fresh UBO+BG pair (the new pair lives until the dispatcher
  // buffers are destroyed).
  const clusteredLighting = options?.clusteredLighting;
  const clusteredPH = getClusteredLightingPlaceholders(device);
  const bClusterLights =
    clusteredLighting?.clusterLights ?? clusteredPH.clusterLights;
  const bClusterAABBs =
    clusteredLighting?.clusterAABBs ?? clusteredPH.clusterAABBs;
  const bClusterCount =
    clusteredLighting?.perClusterLightCount ?? clusteredPH.perClusterLightCount;
  const bClusterIndices =
    clusteredLighting?.perClusterLightIndices ??
    clusteredPH.perClusterLightIndices;
  const bClusterParams = clusteredLighting?.params ?? clusteredPH.params;
  // LUT texture view / sampler / area-light buffer.
  // The dispatcher only builds the real LUT once an area light appears;
  // until then (and when no area lights are active) the per-device
  // placeholders are bound and the FS early-outs on activeLightCount.y=0.
  const bLtcLUTView = clusteredLighting?.ltcLUTView ?? clusteredPH.ltcLUTView;
  const bAreaLights = clusteredLighting?.areaLights ?? clusteredPH.areaLights;

  // Resource identity key — uniquely names the bound resource graph.
  // Two calls with identical resource identities produce the same
  // string and therefore hit the same cache entry. Identity is a
  // stable >0 integer assigned to each resource object via WeakMap;
  // GC reclaims the WeakMap slot once the resource is unreachable.
  const coreResKey =
    `${_idFor(bgCache, bDepthView)}|${_idFor(bgCache, bCompSampler)}|` +
    `${_idFor(bgCache, bClipView)}|${_idFor(bgCache, bClipSampler)}|` +
    `${_idFor(bgCache, bSDFView)}|${_idFor(bgCache, bSDFSampler)}|` +
    `${_idFor(bgCache, bLutT)}|${_idFor(bgCache, bLutI)}|` +
    `${_idFor(bgCache, bCsmBuffer)}|${_idFor(bgCache, bCsmView)}|`;
  const resKey = globeConsumer
    ? `globe|${coreResKey}${_idFor(bgCache, bCubeDepth)}`
    : `shared|${coreResKey}` +
      `${_idFor(bgCache, bEdgeColor)}|${_idFor(bgCache, bEdgeId)}|` +
      `${_idFor(bgCache, bEdgeDepth)}|${_idFor(bgCache, bGlobeDepth)}|` +
      `${_idFor(bgCache, bCubeDepth)}|` +
      `${_idFor(bgCache, bClusterLights)}|${_idFor(bgCache, bClusterAABBs)}|` +
      `${_idFor(bgCache, bClusterCount)}|${_idFor(bgCache, bClusterIndices)}|` +
      `${_idFor(bgCache, bClusterParams)}|` +
      `${_idFor(bgCache, bLtcLUTView)}|${_idFor(bgCache, bAreaLights)}`;

  // Stable owner identity groups byte variants that may safely reuse the
  // same bounded slots across frames. The exact UBO bytes still distinguish
  // simultaneous variants within a frame. Production hot paths provide an
  // owner; the legacy fallback is retained only for internal callers that
  // have not yet adopted the ownership contract.
  const owner = options?.owner;
  let ownerKey;
  if (defined(owner)) {
    ownerKey = `owner:${_idFor(bgCache, owner)}`;
  } else {
    // Compatibility fallback for internal callers not yet supplying stable
    // ownership. The three production hot paths all provide an owner, so they
    // avoid this per-call string and its camera-position growth semantics.
    const cipx = cameraInPlaneSpace?.x ?? 0;
    const cipy = cameraInPlaneSpace?.y ?? 0;
    const cipz = cameraInPlaneSpace?.z ?? 0;
    ownerKey = `legacy:${cipx}|${cipy}|${cipz}|${edges?.near ?? 0}|${
      edges?.far ?? 0
    }|${edges?.viewportWidth ?? 0}|${edges?.viewportHeight ?? 0}|${
      edges?.hasFeatureId ? 1 : 0
    }`;
  }
  const cacheKey = `${ownerKey}#${resKey}`;
  const frameNumber = frameState?.frameNumber ?? 0;

  const cached = bgCache.stateCache.acquire(
    cacheKey,
    _scratchEffectsBits,
    frameNumber,
    () => {
      const ub = device.createBuffer({
        size: EFFECTS_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        label: "Effects UB",
      });
      const bg = device.createBindGroup({
        layout: bgl,
        entries: globeConsumer
          ? [
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
              { binding: 17, resource: bCubeDepth },
            ]
          : [
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
              { binding: 17, resource: bCubeDepth },
              { binding: 18, resource: { buffer: bClusterLights } },
              { binding: 19, resource: { buffer: bClusterAABBs } },
              { binding: 20, resource: { buffer: bClusterCount } },
              { binding: 21, resource: { buffer: bClusterIndices } },
              { binding: 22, resource: { buffer: bClusterParams } },
              { binding: 23, resource: bLtcLUTView },
              { binding: 25, resource: { buffer: bAreaLights } },
            ],
      });
      return { buffer: ub, bindGroup: bg };
    },
    (resource, bits) => {
      device.queue.writeBuffer(resource.buffer, 0, bits);
      // Record the prefix that just landed on the GPU in this module's own
      // sidecar. Never alias the state cache's slot comparison array here: the
      // partial refresh below would then rewrite words 0..19 of the cache's
      // payload identity in place.
      recordShadowReceivePrefix(resource.buffer, bits);
    },
    (resources) => {
      retireEffectsResources(device, resources);
    },
  );

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
    const diagnostics = bgCache.stateCache.getDiagnostics(EFFECTS_UNIFORM_SIZE);
    const total = diagnostics.hits + diagnostics.misses;
    if (total > 100) {
      const hitRate = ((diagnostics.hits / total) * 100).toFixed(1);
      console.log(
        `[CesiumJS:webgpu] EffectsBindGroup cache: ${diagnostics.groupCount} groups / ` +
          `${diagnostics.slotCount} slots, ${diagnostics.hits} hits / ` +
          `${diagnostics.misses} misses (${hitRate}% hit), ` +
          `${diagnostics.bufferWrites} writes / ${diagnostics.skippedWrites} skipped`,
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

  // Same reasoning as CSM. Toggling edges on requires a
  // re-bind (new edge texture views), so the in-place updater leaves
  // the gate off. Callers that need edges must go through the full
  // `createEffectsBindGroup` factory each frame.
  ud[EDGE_CONTROL_OFFSET + 0] = 0.0;

  // Same reasoning as CSM and edges. The
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
  // `_scratchEffectsBits` aliases the same backing store as `ud`. Reuse it
  // instead of allocating a new typed-array view for every effects refresh.
  recordShadowReceivePrefix(uniformBuffer, _scratchEffectsBits);
}

/**
 * Refresh the fitted single-shadow-map prefix after ShadowMap.update().
 *
 * Model commands prepare their effects bind groups before the PVS computes the
 * current light camera. The bind group and depth texture are stable, but the
 * first 80 uniform bytes (matrix, map size, darkness, softness) must be written
 * after that fit and before color execution. WebGPUContext batches these
 * writes through a frame-owned resource-preparation list.
 *
 * @param {GPUDevice} device
 * @param {GPUBuffer} uniformBuffer
 * @param {object} shadowMap
 * @private
 */
function refreshShadowReceiveUniformPrefix(device, uniformBuffer, shadowMap) {
  const data = _scratchShadowReceivePrefix;
  const res = getShadowMapResources(shadowMap);
  if (defined(res)) {
    Matrix4.pack(res.matrix, data, 0);
    data[16] = res.size;
    data[17] = res.size;
    data[18] = res.darkness;
    data[19] = res.softShadows ? 1.0 : 0.0;
  } else {
    Matrix4.pack(Matrix4.IDENTITY, data, 0);
    data[16] = 1.0;
    data[17] = 1.0;
    data[18] = 1.0;
    data[19] = 0.0;
  }
  const cached = _shadowReceivePrefixByBuffer.get(uniformBuffer);
  if (shadowReceivePrefixMatches(cached)) {
    return false;
  }
  device.queue.writeBuffer(uniformBuffer, 0, data.buffer, 0, data.byteLength);
  recordShadowReceivePrefix(uniformBuffer, _scratchShadowReceivePrefixBits);
  return true;
}

/**
 * Force-destroys the placeholder cache entry for a specific device. Normal
 * pooled-context teardown must use the retain/release functions above so one
 * context cannot destroy resources still used by another. This force path is
 * reserved for tests and whole-device invalidation.
 *
 * @param {GPUDevice} device
 */
function clearEffectsPlaceholderCacheForDevice(device) {
  if (!defined(device)) {
    return;
  }
  const cache = _placeholderCache.get(device);
  if (!defined(cache)) {
    return;
  }
  destroyEffectsDeviceCache(cache);
  _placeholderCache.delete(device);
}

/**
 * Returns a frozen allocation/upload snapshot for performance probes.
 *
 * @param {GPUDevice} device
 * @returns {object|undefined}
 */
function getEffectsCacheDiagnostics(device) {
  const deviceCache = _placeholderCache.get(device);
  const caches = deviceCache?.effectsBgCaches;
  if (!defined(caches) || caches.size === 0) {
    return undefined;
  }
  const diagnostics = {
    groupCount: 0,
    slotCount: 0,
    liveBytes: 0,
    hits: 0,
    misses: 0,
    bufferWrites: 0,
    skippedWrites: 0,
    evictions: 0,
    maxGroups: 0,
  };
  for (const cache of caches.values()) {
    const snapshot = cache.stateCache.getDiagnostics(EFFECTS_UNIFORM_SIZE);
    diagnostics.groupCount += snapshot.groupCount;
    diagnostics.slotCount += snapshot.slotCount;
    diagnostics.liveBytes += snapshot.liveBytes;
    diagnostics.hits += snapshot.hits;
    diagnostics.misses += snapshot.misses;
    diagnostics.bufferWrites += snapshot.bufferWrites;
    diagnostics.skippedWrites += snapshot.skippedWrites;
    diagnostics.evictions += snapshot.evictions;
    diagnostics.maxGroups += snapshot.maxGroups;
  }
  return Object.freeze({
    ...diagnostics,
    ownerCount: deviceCache.owners?.size ?? 0,
    contextCacheCount: caches.size,
  });
}

export {
  destroyEffectsDeviceCache as _destroyEffectsDeviceCache,
  _ensureEffectsBgCache,
  getEffectsBindGroupLayout,
  getGlobeEffectsBindGroupLayout,
  getPlaceholderEffects,
  getGlobePlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  refreshShadowReceiveUniformPrefix,
  resolvePointShadowCameraPosition,
  packPointLightPositionRelativeToCamera,
  retainEffectsPlaceholderCacheForContext,
  releaseEffectsPlaceholderCacheForContext,
  clearEffectsPlaceholderCacheForDevice,
  getEffectsCacheDiagnostics,
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
  getGlobeEffectsBindGroupLayout,
  getPlaceholderEffects,
  getGlobePlaceholderEffects,
  createEffectsBindGroup,
  updateEffectsUniforms,
  refreshShadowReceiveUniformPrefix,
  resolvePointShadowCameraPosition,
  packPointLightPositionRelativeToCamera,
  retainEffectsPlaceholderCacheForContext,
  releaseEffectsPlaceholderCacheForContext,
  clearEffectsPlaceholderCacheForDevice,
  getEffectsCacheDiagnostics,
  EFFECTS_UNIFORM_SIZE,
  ATMOSPHERE_LUT_CONTROL_OFFSET,
  CSM_CONTROL_OFFSET,
  EDGE_CONTROL_OFFSET,
  EDGE_VIEWPORT_OFFSET,
  POINT_LIGHT_CONTROL_OFFSET,
  POINT_LIGHT_POSITION_OFFSET,
  CSM_PARAMS_PLACEHOLDER_BYTES,
};
