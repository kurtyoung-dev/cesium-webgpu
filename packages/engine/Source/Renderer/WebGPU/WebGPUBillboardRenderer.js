/**
 * Handles WebGPU rendering of BillboardCollection.
 * Billboards are rendered as instanced screen-aligned quads with texture atlas.
 *
 * Instance data layout (160 bytes per billboard, 10 x vec4 = 40 floats):
 *   posHighAndScale(4) + posLowAndRotation(4) + compressedAttr0(4) +
 *   compressedAttr1(4) + color(4) + miscFlags(4) +
 *   perInstanceFlags(4 = disableDepthTestDistance, splitDirection,
 *                    distanceDisplayConditionNearSq, distanceDisplayConditionFarSq) +
 *   translucencyByDistance(4 = near, nearAlpha, far, farAlpha) +
 *   pixelOffsetScaleByDistance(4 = near, nearScale, far, farScale) +
 *   scaleByDistance(4 = near, nearScale, far, farScale)
 *
 * The four trailing slots (perInstanceFlags + 3 NearFarScalars) are
 * always present (16-byte alignment for `arrayStride`). The shader only
 * reads them inside the matching `//>>ifdef` blocks — when none of those
 * defines are active for the frame, the attributes are declared-unused
 * and the rasterizer ignores the slots. Cost is 64 bytes per instance
 * of upload bandwidth (negligible for typical Cesium scenes).
 *
 * @private
 * @module WebGPUBillboardRenderer
 */
import Cartesian2 from "../../Core/Cartesian2.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import WebGPUCollectionCameraUB from "./WebGPUCollectionCameraUB.js";
import { getCollectionShaderSource } from "./WebGPUCollectionShaders.js";
// Slice 5c-B Phase 1 (Batch 110) — scene-FB target helper. Used only
// for the COLOR pipeline; pick + velocity stay single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
// NEW-DERIVEDCOMMAND-VARIANT-FACTORY (Batch 248) — pick pipeline descriptor
// is derived from the color descriptor through the centralized variant
// factory; pipeline resolution (color/pick/velocity) routes through the
// factory's shared sync/async state machine.
import {
  DerivedCommandType,
  WebGPUDerivedCommand,
} from "./WebGPUDerivedCommand.js";
import { WebGPUResidentInstanceBuffer } from "./WebGPUResidentInstanceBuffer.js";
import SceneMode from "../../Scene/SceneMode.js";

// Per-instance stride. Batch 135 carried 7 vec4 (28 floats) for
// DP-H42/H40 + DISTANCE_DISPLAY_CONDITION. Batch 136 (Audit A.14
// finish) extends to 10 vec4 (40 floats) for the three remaining
// NearFarScalar gates. Batch 138 adds an 11th vec4
// (`threePointAttribs`) for VS_THREE_POINT_DEPTH_CHECK clamp-to-ground
// terrain occlusion. 16-byte stride alignment preserved.
const FLOATS_PER_INSTANCE = 44;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const VERTICES_PER_QUAD = 6;
const UNIFORM_BUFFER_SIZE = 256;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedPos = new EncodedCartesian3();
const scratchInverseModel = new Matrix4();
const scratchCameraMC = new Cartesian3();

/**
 * Batch 139 (3rd-pass audit fix) — encode the
 * `disableDepthTestDistance` per-instance attribute so the WGSL
 * sentinel check works. WebGL's convention (mirrored at
 * `BillboardCollection.js:1798-1799`):
 *
 *   - `Number.POSITIVE_INFINITY` → -1.0 (always-disable sentinel; the
 *     shader's `< 0` check fires).
 *   - finite numbers → unchanged (the shader squares + compares to
 *     squared eye distance).
 *   - other (undefined, NaN, non-number) → 0.0 (no per-instance
 *     override; falls back to frame-wide minimum in the shader).
 *
 * Pre-Batch-139 the JS pack collapsed Infinity to 0.0, which made the
 * shader's sentinel branch dead code — the disable-depth-distance
 * "always disable" mode never fired on WebGPU.
 */
function encodeDisableDepthTestDistance(value) {
  if (typeof value !== "number") {
    return 0.0;
  }
  if (value === Number.POSITIVE_INFINITY) {
    return -1.0;
  }
  // 4th-pass audit fix — guard against `NaN`, `-Infinity`, and
  // negative finite values. WebGL squares the input in the shader so
  // sign is dropped (negative distances become positive squared
  // distances), but WebGPU stores raw and uses `<0` as the always-
  // disable sentinel. Treating negatives as 0 (no override) matches
  // the WebGL behavior on sane inputs (distance is always >= 0) and
  // avoids accidentally tripping the sentinel on bad data.
  if (isFinite(value) && value > 0.0) {
    return value;
  }
  return 0.0;
}

/**
 * AUDIT_2026_05_02 A.14 (Batch 136) — pack a CesiumJS NearFarScalar
 * into the (near, nearValue, far, farValue) layout the WGSL helper
 * `czm_nearFarScalar` expects. Returns the same layout the WebGL
 * upstream uses; the shader squares the near/far values internally so
 * we pack raw distances, not squared. When `scalar` is undefined, we
 * write a "no-op" identity (near=0, value=`identity`, far=Infinity,
 * value=`identity`) — czm_nearFarScalar against that returns
 * `identity` for any camDistSq, so the shader's existing baseline
 * behavior is preserved when the user didn't set the property.
 *
 * @param {Float32Array} out - Destination buffer.
 * @param {number} offset - First slot index in `out`.
 * @param {object|undefined} scalar - The NearFarScalar object
 *   ({near, nearValue, far, farValue}) or undefined.
 * @param {number} identity - The shader-side identity for this gate
 *   (1.0 for translucency / pixel-offset / scale — all multiplicative).
 */
function packNearFarScalar(out, offset, scalar, identity) {
  if (scalar) {
    out[offset + 0] = typeof scalar.near === "number" ? scalar.near : 0.0;
    out[offset + 1] =
      typeof scalar.nearValue === "number" ? scalar.nearValue : identity;
    out[offset + 2] = typeof scalar.far === "number" ? scalar.far : 1.0e8;
    out[offset + 3] =
      typeof scalar.farValue === "number" ? scalar.farValue : identity;
  } else {
    // Identity NearFarScalar: clamp returns identity at every distance.
    out[offset + 0] = 0.0;
    out[offset + 1] = identity;
    out[offset + 2] = 1.0e8;
    out[offset + 3] = identity;
  }
}

// Shader source is bundled at build time via WebGPUCollectionShaders.js
// (esbuild inlines the .wgsl.js mirror). The previous runtime `fetch()`
// against a relative path resolved against the demo's HTML location, so
// from `Apps/Sandcastle/gallery/X.html` it tried to load
// `Apps/Sandcastle/Source/Shaders/...` which 404s — the dev server returned
// its HTML 404 page and Naga choked on `<!DOCTYPE html>`. The cached
// import path is sync, has no network round-trip, and works under every
// hosting layout (sandcastle, prebuilt apps, embedded demos).
function getShaderSource() {
  return getCollectionShaderSource("billboardColor");
}

/**
 * Visibility predicate shared by the resident-instance slot map, the pack
 * loop, and the pick builder. clusterShow is false when EntityCluster has
 * folded this billboard into a cluster glyph. Skipping these prevents the
 * stack of overlapping icons that WebGL already avoids via the same read.
 * @private
 */
function isBillboardVisible(bb) {
  return defined(bb) && bb.show && bb._clusterShow !== false;
}

/**
 * Pack ONE billboard's 44-float instance record at `offset` floats into
 * `out`. Extracted from the former whole-collection `buildInstanceData`
 * loop (NEW-PARTIAL-WRITE-WIRE-BPL) so the resident-instance manager can
 * re-pack a single changed slot without touching its neighbors. The pick
 * builder reuses it and overwrites the color slot.
 * @private
 */
function packBillboardInstance(out, offset, bb) {
  const position = bb._actualPosition || bb._position || bb.position;
  EncodedCartesian3.fromCartesian(position, scratchEncodedPos);

  // posHighAndScale
  out[offset + 0] = scratchEncodedPos.high.x;
  out[offset + 1] = scratchEncodedPos.high.y;
  out[offset + 2] = scratchEncodedPos.high.z;
  out[offset + 3] = bb.scale || 1.0;

  // posLowAndRotation
  out[offset + 4] = scratchEncodedPos.low.x;
  out[offset + 5] = scratchEncodedPos.low.y;
  out[offset + 6] = scratchEncodedPos.low.z;
  out[offset + 7] = bb.rotation || 0.0;

  // compressedAttr0: pixelOffset.xy, alignedAxis.xy
  // alignedAxis is a Cartesian3 world-space axis; billboard shader supports
  // 2D eye-space rotation, so we project to the screen-plane components
  // (x = east-west, y = up-down). Non-(0,0,0) axes orient the billboard
  // around that world axis (e.g. flagpole pointing up, road chevrons
  // pointing along a road vector).
  const pixelOffset = bb.pixelOffset || Cartesian2.ZERO;
  const alignedAxis = bb._alignedAxis;
  out[offset + 8] = pixelOffset.x;
  out[offset + 9] = pixelOffset.y;
  out[offset + 10] = alignedAxis ? alignedAxis.x : 0.0;
  out[offset + 11] = alignedAxis ? alignedAxis.y : 0.0;

  // compressedAttr1: imageRect (x,y,w,h in atlas, normalized)
  const imageRect =
    bb._imageSubRegion || bb._textureCoordinateBoundsOrImageIndex;
  if (defined(imageRect) && typeof imageRect === "object") {
    out[offset + 12] = imageRect.x || 0;
    out[offset + 13] = imageRect.y || 0;
    out[offset + 14] = imageRect.width || 1;
    out[offset + 15] = imageRect.height || 1;
  } else {
    out[offset + 12] = 0.0;
    out[offset + 13] = 0.0;
    out[offset + 14] = 1.0;
    out[offset + 15] = 1.0;
  }

  // color
  const color = bb.color;
  out[offset + 16] = color.red;
  out[offset + 17] = color.green;
  out[offset + 18] = color.blue;
  out[offset + 19] = color.alpha;

  // miscFlags: show, sizeInMeters, width, height
  out[offset + 20] = 1.0; // show
  out[offset + 21] = bb.sizeInMeters ? 1.0 : 0.0;
  out[offset + 22] = bb.width || 32.0;
  out[offset + 23] = bb.height || 32.0;

  // perInstanceFlags — DP-H42 / DP-H40 / A.14 per-billboard state.
  //   x: disableDepthTestDistance (raw meters; squared in shader)
  //   y: splitDirection (-1 LEFT / 0 NONE / +1 RIGHT)
  //   z: distanceDisplayCondition.near^2 (squared meters; 0 if unset)
  //   w: distanceDisplayCondition.far^2 (squared meters; +Inf if unset)
  out[offset + 24] = encodeDisableDepthTestDistance(
    bb._disableDepthTestDistance,
  );
  out[offset + 25] = bb._splitDirection ?? 0.0;
  // AUDIT_2026_05_02 A.14 (Batch 135) — pack the squared near/far
  // distance display window. WGSL gate compares squared eye distance
  // against [near^2, far^2] (no sqrt). Default values match WebGL's
  // `czm_nearFarScalar` semantics: near=0 / far=Infinity → always
  // visible. The renderer also flips DISTANCE_DISPLAY_CONDITION on
  // the pipeline key so the gate's runtime cost is paid only when
  // any billboard in the collection actually sets a window.
  const ddc = bb._distanceDisplayCondition;
  if (ddc) {
    const near = typeof ddc.near === "number" ? ddc.near : 0.0;
    const far =
      typeof ddc.far === "number" ? ddc.far : Number.POSITIVE_INFINITY;
    out[offset + 26] = near * near;
    out[offset + 27] = isFinite(far) ? far * far : Number.MAX_VALUE;
  } else {
    out[offset + 26] = 0.0;
    out[offset + 27] = Number.MAX_VALUE;
  }

  // AUDIT_2026_05_02 A.14 (Batch 136) — three NearFarScalar gates
  // packed into vec4 slots 7/8/9. Identity is 1.0 for all three (each
  // is multiplicative — alpha, pixel-offset scale, quad scale). The
  // `packNearFarScalar` helper writes an identity-NFS when the user
  // didn't set the property, so the shader's gate produces the
  // unchanged baseline (alpha=1, scale=1) without needing a separate
  // sentinel check.
  packNearFarScalar(out, offset + 28, bb._translucencyByDistance, 1.0);
  packNearFarScalar(out, offset + 32, bb._pixelOffsetScaleByDistance, 1.0);
  packNearFarScalar(out, offset + 36, bb._scaleByDistance, 1.0);

  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — threePointAttribs vec4:
  //   .x = depthOrigin.x (-1 / 0 / +1, label horizontal anchor; 0 means
  //         "inherit billboard origin" per WebGL convention).
  //   .y = depthOrigin.y (-1 / 0 / +1, vertical anchor).
  //   .z = enableDepthCheck (1.0 default; 0.0 means "skip the 3-point
  //         check on this billboard" — used by WebGL when the billboard
  //         is below the ellipsoid surface so the depth-check would
  //         occlude it incorrectly).
  //   .w = reserved.
  // The Billboard primitive itself doesn't expose `depthOrigin` —
  // it's a Label-only attribute. Default to (0, 0) so plain
  // Billboards take the "inherit origin" path. Labels override via
  // the LabelRenderer's instance data builder.
  out[offset + 40] = 0.0;
  out[offset + 41] = 0.0;
  out[offset + 42] = 1.0;
  out[offset + 43] = 0.0;
}

/**
 * Builds pick-variant instance data. Same layout as color but @location(4)
 * holds pick color instead of display color.
 * @private
 */
function buildPickInstanceData(collection, context) {
  const billboards = collection._billboards;
  const length = collection.length;
  const instanceData = new Float32Array(length * FLOATS_PER_INSTANCE);
  let visibleCount = 0;

  for (let i = 0; i < length; i++) {
    const bb = billboards[i];
    if (!isBillboardVisible(bb)) {
      continue;
    }

    const offset = visibleCount * FLOATS_PER_INSTANCE;
    // Same record as the color path — the pick pipeline obeys DP-H42,
    // DP-H40, and A.14 too so the picked region matches what the user
    // sees on screen (a clicked pixel below the camera's DepthDistance
    // threshold should still pick the billboard above terrain; a pixel
    // outside the split-cutoff or distance window should not pick a
    // billboard it can't see).
    packBillboardInstance(instanceData, offset, bb);

    // @location(4): pick color instead of display color
    if (!defined(bb._pickId)) {
      bb._pickId = context.createPickId(bb, "billboard");
    }
    const pc = bb._pickId.color;
    instanceData[offset + 16] = pc.red;
    instanceData[offset + 17] = pc.green;
    instanceData[offset + 18] = pc.blue;
    instanceData[offset + 19] = pc.alpha;

    visibleCount++;
  }

  return { instanceData, visibleCount };
}

const INSTANCE_BUFFER_LAYOUT = {
  arrayStride: BYTES_PER_INSTANCE,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
    { shaderLocation: 3, offset: 48, format: "float32x4" },
    { shaderLocation: 4, offset: 64, format: "float32x4" },
    { shaderLocation: 5, offset: 80, format: "float32x4" },
    // DP-H42 / DP-H40 / A.14 DDC — perInstanceFlags. Always declared in
    // the layout; the shader only reads it inside the matching
    // `//>>ifdef` blocks.
    { shaderLocation: 6, offset: 96, format: "float32x4" },
    // AUDIT_2026_05_02 A.14 (Batch 136) — three NearFarScalar gates.
    // Always declared so a single pipeline layout serves all 8
    // ifdef variants without rebuilding.
    { shaderLocation: 7, offset: 112, format: "float32x4" },
    { shaderLocation: 8, offset: 128, format: "float32x4" },
    { shaderLocation: 9, offset: 144, format: "float32x4" },
    // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — depthOrigin +
    // enableDepthCheck. Pick shader keeps its existing 10-attribute
    // VertexInput; the WebGPU spec allows a buffer layout to declare
    // more attributes than the shader reads.
    { shaderLocation: 10, offset: 160, format: "float32x4" },
  ],
};

function createBillboardBindGroupLayout(device) {
  return makeBindGroupLayout(device, "Billboard bind group layout", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    texture(1, Stage.FRAGMENT),
    sampler(2, Stage.FRAGMENT),
    // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — globe depth packed-rgba
    // texture + sampler. VS-only visibility: the 3-point check
    // sampling happens in `getGlobeDepth(positionEC)` from vertexMain;
    // FS doesn't need access. Placeholder 1×1 texture is bound when
    // the feature is off so the BGL stays a single canonical layout
    // across all `//>>ifdef` variants.
    texture(3, Stage.VERTEX),
    sampler(4, Stage.VERTEX),
  ]);
}

/**
 * Build the cache-friendly descriptor for the color (alpha-blended)
 * billboard pipeline. The actual `GPURenderPipeline` is materialized
 * through `webgpuPipelineCache.getPipeline()` so two BillboardCollections
 * with identical (defines, format, depthFormat) share one pipeline.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73).
 * @private
 */
function buildBillboardDescriptor(
  device,
  shaderModule,
  format,
  depthFormat,
  bindGroupLayout,
  defines,
  sampleCount,
) {
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  return {
    name: `Billboard pipeline [${format}/${depthFormat}/defines=0x${defines.toString(16)}/ms=${sampleCount ?? 1}]`,
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      // Slice 5c-B Phase 1 (Batch 110) — scene-FB color target via
      // helper. The velocity (rg16float) builder and the pick variant
      // (derived from THIS descriptor via WebGPUDerivedCommand, Batch
      // 248) target their own render passes; both intentionally stay
      // single-target.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // Batch 134 — scene FB color pass is MSAA when context._msaaSamples > 1.
    // Pre-Batch-134 this builder dropped `multisample`, defaulting to count=1
    // and producing the same family of validation errors caught at Batches
    // 118 (Ellipsoid) and 132 (MaterialAppearance).
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };
}

/**
 * AUDIT_2026_05_02 B.10 (Batch 143, NEW-COLLECTIONS-MOTION-VECTORS) —
 * second VB layout for the velocity pipeline. Same per-instance stride
 * as the regular instance buffer (the renderer keeps a one-frame-lagged
 * mirror of the same data), but the velocity VS only reads positions
 * via two locations, 11 (high) + 12 (low).
 * @private
 */
const VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT = {
  arrayStride: 176, // FLOATS_PER_INSTANCE (44) * 4
  stepMode: "instance",
  attributes: [
    // prevPosHighAndScale at byte 0 — mirrors location 0 of the current
    // instance buffer.
    { shaderLocation: 11, offset: 0, format: "float32x4" },
    // prevPosLowAndRotation at byte 16 — mirrors location 1.
    { shaderLocation: 12, offset: 16, format: "float32x4" },
  ],
};

/**
 * AUDIT_2026_05_02 B.10 (Batch 143, NEW-COLLECTIONS-MOTION-VECTORS) —
 * descriptor for the velocity pipeline variant. Same VS layout / shader
 * module / pipeline layout as the regular billboard pipeline; the
 * fragment entry is `fragmentVelocityMain` and the target format is
 * `rg16float` (the scene-FB velocity texture format). Depth is bound
 * read-only (`depthCompare: less-equal`, `depthWriteEnabled: false`)
 * so the velocity pass shares the scene depth from the main color
 * pass — fragments behind opaque geometry fail the depth test and
 * don't emit velocity.
 * @private
 */
function buildBillboardVelocityDescriptor(
  device,
  shaderModule,
  depthFormat,
  bindGroupLayout,
  defines,
) {
  return {
    name: `Billboard velocity pipeline [${depthFormat}/defines=0x${defines.toString(16)}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexVelocityMain",
      buffers: [INSTANCE_BUFFER_LAYOUT, VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentVelocityMain",
      targets: [{ format: "rg16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };
}

/**
 * Resolve a billboard pipeline (color, pick, or velocity) through the
 * central pipeline cache. Returns the existing GPU pipeline if cached;
 * otherwise kicks off async creation and returns null so the caller skips
 * the frame. Falls back to direct synchronous creation when
 * `pipelineCache` is null.
 *
 * C-R7-RENDERER-MIGRATION (Batch 73). Since Batch 248 this delegates to
 * the centralized variant factory's shared resolution state machine
 * (`WebGPUDerivedCommand.resolveVariantPipeline`) — same behavior, one
 * implementation.
 * @private
 */
function tryResolveBillboardPipeline(device, pipelineCache, entry) {
  return WebGPUDerivedCommand.resolveVariantPipeline(
    device,
    pipelineCache,
    entry,
  );
}

// Module-level shader-module cache keyed by GPUDevice. Shared across every
// BillboardCollection rendered on a given device so we don't recompile
// the same (source, defines) tuple for each collection. Weak so a lost
// device is GC'd along with its modules.
const _shaderModuleCaches = new WeakMap();

function getShaderModuleCache(device) {
  let cache = _shaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _shaderModuleCaches.set(device, cache);
  }
  return cache;
}

/**
 * Prewarm the most-likely define sets on first use per device. Called
 * lazily from `updateWebGPUBillboards` the first time a collection renders
 * so we don't pay for WebGPU device access at module load. Compiling the
 * four common variants (none / DDD only / split only / both) up front
 * moves the shader compile off the render path for any scene that uses
 * these features.
 * @private
 */
function prewarmBillboardShaders(device, colorSource, pickSource) {
  const cache = getShaderModuleCache(device);
  if (cache._billboardPrewarmed) {
    return;
  }
  const D = ShaderDefine;
  // AUDIT_2026_05_02 A.14 (Batches 135 + 136) — billboard-relevant
  // defines now total 6: DISABLE_DEPTH_DISTANCE, SPLIT_ENABLED,
  // DISTANCE_DISPLAY_CONDITION, EYE_DISTANCE_TRANSLUCENCY,
  // EYE_DISTANCE_PIXEL_OFFSET, EYE_DISTANCE_SCALING. Full Cartesian
  // product is 64 variants — too many to prewarm. We seed the most
  // common production scenarios; cold-path variants compile lazily
  // through the shader-module cache on first use.
  const ALL_DDC_GATES =
    D.DISTANCE_DISPLAY_CONDITION |
    D.EYE_DISTANCE_TRANSLUCENCY |
    D.EYE_DISTANCE_PIXEL_OFFSET |
    D.EYE_DISTANCE_SCALING;
  const D_KML = D.DISTANCE_DISPLAY_CONDITION | D.EYE_DISTANCE_TRANSLUCENCY;
  const D_PROD = D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED | ALL_DDC_GATES;
  const defineSets = [
    0,
    D.DISABLE_DEPTH_DISTANCE,
    D.SPLIT_ENABLED,
    D.DISTANCE_DISPLAY_CONDITION,
    D.EYE_DISTANCE_TRANSLUCENCY,
    D.EYE_DISTANCE_SCALING,
    D.DISABLE_DEPTH_DISTANCE | D.SPLIT_ENABLED,
    D_KML,
    D.DISABLE_DEPTH_DISTANCE | D_KML,
    ALL_DDC_GATES,
    D_PROD,
    // Batch 138 — VS_THREE_POINT_DEPTH_CHECK common combos. KML
    // labels with `heightReference: CLAMP_TO_GROUND` typically also
    // set DDC + translucency, so we prewarm that combo + standalone.
    D.VS_THREE_POINT_DEPTH_CHECK,
    D.VS_THREE_POINT_DEPTH_CHECK | D_KML,
    D_PROD | D.VS_THREE_POINT_DEPTH_CHECK,
  ];
  cache.prewarm(
    ShaderSourceId.BILLBOARD_COLLECTION,
    colorSource,
    defineSets,
    "Billboard shader",
  );
  if (defined(pickSource)) {
    cache.prewarm(
      ShaderSourceId.BILLBOARD_COLLECTION_PICK,
      pickSource,
      defineSets,
      "Billboard pick shader",
    );
  }
  cache._billboardPrewarmed = true;
}

function packUniforms(uniformData, frameState, modelMatrix, collection) {
  const context = frameState.context;
  const uniformState = context.uniformState;
  const canvas = context.canvas;

  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, uniformData, 0);

  // viewRotation (identity for now — simplified)
  Matrix4.pack(Matrix4.IDENTITY, uniformData, 16);

  // RTE encoding MUST be done in the same coordinate frame as the
  // per-vertex positions. Billboard instance data encodes positions as
  // `EncodedCartesian3.fromCartesian(worldPos)` in WORLD frame, so the
  // camera must also be encoded in world frame — BUT the mvpRTE above
  // uses `view * modelMatrix` with translation zeroed, which implicitly
  // treats vertex input as MODEL-space. When modelMatrix ≠ identity
  // (any entity cluster with a local frame, any BillboardCollection
  // whose `modelMatrix` is set), the two frames disagree and the RTE
  // cancellation fails at Earth scale — billboards drift by thousands
  // of metres.
  //
  // Fix: encode the camera in the same frame the positions live in.
  // `modelMatrix` is typically identity for billboard collections, in
  // which case `inverse(modelMatrix) * positionWC === positionWC` and
  // this is a no-op; when it's set, we get the correct local-frame
  // camera.
  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(
    scratchInverseModel,
    frameState.camera.positionWC,
    scratchCameraMC,
  );
  EncodedCartesian3.fromCartesian(scratchCameraMC, scratchEncodedCamera);
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — encode frustum
  // (near, far) + oneOverLog2FarDepthFromNearPlusOne packed into the
  // reserved lanes. Same source every producer uses
  // (uniformState.currentFrustum at scene-update time); unconditional —
  // only the LOG_DEPTH shader variant reads them.
  //
  // PHASE 3 SLICE 2 (NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE) — prefer the
  // stashed FULL-frustum encode (`_logDepthEncodeNearFar`) over the live
  // per-slice `currentFrustum`. The globe bakes its log-depth uniform once at
  // scene update (full frustum) and replays unchanged; when this collection
  // REPACKS per slice (2D/CV), reading the per-slice currentFrustum would
  // encode against a different near/far than the globe and lose the depth test.
  // See the same fix in WebGPUPointPrimitiveRenderer.packUniforms.
  const ldEncode = uniformState._logDepthEncodeNearFar;
  const ldFrustum = uniformState.currentFrustum;
  let ldNear = ldFrustum ? ldFrustum.x : 0.0;
  let ldFar = ldFrustum ? ldFrustum.y : 0.0;
  let ldFactor =
    typeof uniformState.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? uniformState.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  if (ldEncode && ldEncode[1] > ldEncode[0]) {
    ldNear = ldEncode[0];
    ldFar = ldEncode[1];
    const ldLog2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = ldLog2Far > 0.0 ? 1.0 / ldLog2Far : 0.0;
  } else if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const ldLog2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = ldLog2Far > 0.0 ? 1.0 / ldLog2Far : 0.0;
  }
  uniformData[32] = scratchEncodedCamera.high.x;
  uniformData[33] = scratchEncodedCamera.high.y;
  uniformData[34] = scratchEncodedCamera.high.z;
  uniformData[35] = ldNear;
  uniformData[36] = scratchEncodedCamera.low.x;
  uniformData[37] = scratchEncodedCamera.low.y;
  uniformData[38] = scratchEncodedCamera.low.z;
  uniformData[39] = ldFar;

  uniformData[40] = canvas.width;
  uniformData[41] = canvas.height;
  uniformData[42] = 1.0; // highResMultiplier
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — threePointDepthTestDistance
  // populated from `BillboardCollection.threePointDepthTestDistance`
  // when the collection has clamp-to-ground billboards. WebGL stores
  // this on the collection (not frame-state) and computes a default
  // when unset, so we read it directly from the collection. 0 (default)
  // means the WGSL gate evaluates `threshSq > 0` to false → skips.
  const threePointDist =
    typeof collection?._threePointDepthTestDistance === "number"
      ? collection._threePointDepthTestDistance
      : 0.0;
  uniformData[43] = threePointDist;

  // DP-H42 — frame-wide minimum disable-depth-test distance in meters.
  // `frameState.minimumDisableDepthTestDistance` is populated by Scene.js
  // each frame from the `Scene.minimumDisableDepthTestDistance` setter.
  uniformData[44] =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;

  // DP-H40 — split cutoff in framebuffer pixels. WebGL keeps this in
  // pixel space as `czm_splitPosition`, which is
  // `frameState.splitPosition * drawingBufferWidth`. Mirror that here so
  // the fragment-stage compare sits in the same coord system as
  // `position.x` (which WebGPU defines as framebuffer pixels).
  const splitFraction =
    typeof frameState?.splitPosition === "number"
      ? frameState.splitPosition
      : 0.0;
  const drawingBufferWidth = context?.drawingBufferWidth ?? canvas.width ?? 0.0;
  uniformData[45] = splitFraction * drawingBufferWidth;
  // Log-depth factor at float 46 (previously implicit padding).
  uniformData[46] = ldFactor;
  uniformData[47] = 0.0;

  // DP-H41 (Batch 27) — previousViewProjection at slots 48..63 (16 floats,
  // 64 bytes). Fits in the existing 256-byte uniform buffer — no resize.
  // `UniformState.update()` caches last frame's viewProjection, so on frame
  // N this slot holds frame N-1. TAA / motion-vector shaders read it via
  // `camera.previousViewProjection`.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, uniformData, 48);
  } else {
    uniformData[48] = 1;
    uniformData[49] = 0;
    uniformData[50] = 0;
    uniformData[51] = 0;
    uniformData[52] = 0;
    uniformData[53] = 1;
    uniformData[54] = 0;
    uniformData[55] = 0;
    uniformData[56] = 0;
    uniformData[57] = 0;
    uniformData[58] = 1;
    uniformData[59] = 0;
    uniformData[60] = 0;
    uniformData[61] = 0;
    uniformData[62] = 0;
    uniformData[63] = 1;
  }
}

/**
 * Scan the collection for the defines a billboard's active state requires.
 * Called once per frame before shader module / pipeline lookup; keeps the
 * cost to one pass over the billboards. We flag `DISABLE_DEPTH_DISTANCE`
 * if ANY billboard has a per-instance override OR the frame-wide minimum
 * is non-zero, and `SPLIT_ENABLED` if ANY billboard's `_splitDirection`
 * is non-zero.
 *
 * Returning zero on both flags lets the baseline (no-features) pipeline
 * stay the fast path — existing scenes pay no new shader cost.
 * @private
 */
function computeDefinesForFrame(collection, frameState) {
  let defines = 0;
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — OR the LOG_DEPTH
  // bit when the master switch + per-frame flag are on. The bit keys the
  // shader-module cache AND the pipeline maps/names, so the flip rebuilds
  // through the normal keyed-miss path. Inert while the switch defaults
  // FALSE (defines unchanged, byte-identical shaders).
  if (isWebGPULogDepthActive(frameState?.context, frameState)) {
    defines |= ShaderDefine.LOG_DEPTH;
  }
  const frameMin =
    typeof frameState?.minimumDisableDepthTestDistance === "number"
      ? frameState.minimumDisableDepthTestDistance
      : 0.0;
  if (frameMin !== 0.0) {
    defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
  }
  // Batch 138 (VS_THREE_POINT_DEPTH_CHECK) — `_shaderClampToGround` is
  // set true by `BillboardCollection.update()` when ANY billboard in the
  // collection has `heightReference !== HeightReference.NONE`. Mirrors
  // the WebGL define-flip at `BillboardCollection.js:1031`.
  if (collection._shaderClampToGround === true) {
    defines |= ShaderDefine.VS_THREE_POINT_DEPTH_CHECK;
  }
  const billboards = collection._billboards;
  const length = collection.length;
  // Short-circuit the scan once all seven flags are set. (Six A.14
  // gates + clamp-to-ground; clamp-to-ground is set above
  // collection-wide so doesn't participate in the per-billboard scan.)
  const all =
    ShaderDefine.DISABLE_DEPTH_DISTANCE |
    ShaderDefine.SPLIT_ENABLED |
    ShaderDefine.DISTANCE_DISPLAY_CONDITION |
    ShaderDefine.EYE_DISTANCE_TRANSLUCENCY |
    ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET |
    ShaderDefine.EYE_DISTANCE_SCALING;
  for (let i = 0; i < length; i++) {
    if ((defines & all) === all) {
      break;
    }
    const bb = billboards[i];
    if (!defined(bb) || !bb.show || bb._clusterShow === false) {
      continue;
    }
    if (
      (defines & ShaderDefine.DISABLE_DEPTH_DISTANCE) === 0 &&
      typeof bb._disableDepthTestDistance === "number" &&
      bb._disableDepthTestDistance !== 0.0
    ) {
      defines |= ShaderDefine.DISABLE_DEPTH_DISTANCE;
    }
    if (
      (defines & ShaderDefine.SPLIT_ENABLED) === 0 &&
      bb._splitDirection !== undefined &&
      bb._splitDirection !== 0.0
    ) {
      defines |= ShaderDefine.SPLIT_ENABLED;
    }
    // AUDIT_2026_05_02 A.14 (Batch 135) — DISTANCE_DISPLAY_CONDITION
    // gate. Flip the bit so the baseline pipeline stays the fast
    // path; collections that never set a window pay zero shader cost
    // for the gate.
    if (
      (defines & ShaderDefine.DISTANCE_DISPLAY_CONDITION) === 0 &&
      defined(bb._distanceDisplayCondition)
    ) {
      defines |= ShaderDefine.DISTANCE_DISPLAY_CONDITION;
    }
    // AUDIT_2026_05_02 A.14 (Batch 136) — three NearFarScalar gates.
    // Same opt-in semantics as DDC: bit only flips when at least one
    // billboard sets the property, so collections that don't use
    // distance-aware translucency / pixel-offset / scaling stay on
    // the baseline shader.
    if (
      (defines & ShaderDefine.EYE_DISTANCE_TRANSLUCENCY) === 0 &&
      defined(bb._translucencyByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_TRANSLUCENCY;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET) === 0 &&
      defined(bb._pixelOffsetScaleByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_PIXEL_OFFSET;
    }
    if (
      (defines & ShaderDefine.EYE_DISTANCE_SCALING) === 0 &&
      defined(bb._scaleByDistance)
    ) {
      defines |= ShaderDefine.EYE_DISTANCE_SCALING;
    }
  }
  return defines;
}

/**
 * Creates a placeholder 1x1 white texture for billboards without an atlas.
 * @private
 */
function createPlaceholderTexture(device) {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    [1, 1, 1],
  );
  return texture;
}

/**
 * Updates or creates WebGPU draw commands for BillboardCollection.
 * @param {BillboardCollection} collection
 * @param {FrameState} frameState
 * @param {Array} commandList
 */
async function updateWebGPUBillboards(collection, frameState, commandList) {
  const context = frameState.context;
  const device = context.device;
  const length = collection.length;
  if (length === 0) {
    return;
  }

  if (!defined(collection._webgpuCache)) {
    collection._webgpuCache = {};
  }
  const cache = collection._webgpuCache;

  // AUDIT_2026_05_02 A.14 (Batch 136) — all four billboard distance
  // gates are now wired: `distanceDisplayCondition` (Batch 135),
  // `translucencyByDistance`, `pixelOffsetScaleByDistance`, and
  // `scaleByDistance` (Batch 136). Each ramps via the WGSL helper
  // `czm_nearFarScalar` and gates the shader behind a per-feature
  // ShaderDefine bit so collections that don't use a given gate stay
  // on the baseline pipeline. The previous one-time warning is
  // retired.

  // Shader source + prewarm (once per device; `prewarmBillboardShaders`
  // is idempotent so repeated collections on the same device no-op).
  const shaderCode = getShaderSource();
  const pickShaderCode = getCollectionShaderSource("billboardPick");
  prewarmBillboardShaders(device, shaderCode, pickShaderCode);

  // Bind-group layout is shared across every (defines-set) pipeline —
  // only the pipeline + shader module vary per define set.
  if (!defined(cache.bindGroupLayout)) {
    cache.bindGroupLayout = createBillboardBindGroupLayout(device);
  }

  // DP-H42 / DP-H40 — pick the right shader module + pipeline for the
  // current frame's billboard state. Unchanged billboard collections
  // settle to the same `defines` value every frame, so the map lookup
  // is the hot path and pipeline resolution only fires on the first
  // frame that exercises a new combination.
  // C-R7-RENDERER-MIGRATION (Batch 73) — local Map now holds entry slots
  // `{ descriptor, pipeline, pending }`; the GPU pipeline is materialized
  // through the central `webgpuPipelineCache` so two BillboardCollections
  // with identical render-target shape + defines share one pipeline.
  const defines = computeDefinesForFrame(collection, frameState);
  if (!defined(cache.pipelineEntries)) {
    cache.pipelineEntries = new Map();
    cache.pickPipelineEntries = new Map();
    // AUDIT_2026_05_02 B.10 (Batch 143) — velocity pipeline cache. Same
    // (defines) keying as the regular pipeline cache so a billboard
    // collection's color and velocity pipelines stay in lockstep.
    cache.velocityPipelineEntries = new Map();
  }
  // Batch 110 — invalidate cached pipeline entries on scene format
  // change (HDR toggle).
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (cache._pipelineFormatGeneration !== sceneGen) {
    cache.pipelineEntries.clear();
    cache.pickPipelineEntries?.clear();
    cache.velocityPipelineEntries?.clear();
    cache._pipelineFormatGeneration = sceneGen;
  }
  let entry = cache.pipelineEntries.get(defines);
  if (!defined(entry)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const moduleCache = getShaderModuleCache(device);
    const shaderModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION,
      shaderCode,
      defines,
      "Billboard shader",
    );
    const sampleCount = context._msaaSamples ?? 1;
    const descriptor = buildBillboardDescriptor(
      device,
      shaderModule,
      format,
      depthFmt,
      cache.bindGroupLayout,
      defines,
      sampleCount,
    );
    entry = { descriptor, pipeline: null, pending: false };
    cache.pipelineEntries.set(defines, entry);
  }
  const pipeline = tryResolveBillboardPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    entry,
  );
  if (!pipeline) {
    return;
  }
  cache.pipeline = pipeline;
  cache.currentDefines = defines;

  // AUDIT_2026_05_02 B.10 (Batch 143, NEW-COLLECTIONS-MOTION-VECTORS) —
  // resolve the velocity pipeline lazily, gated on TAA being enabled
  // this frame. Static scenes (TAA off) never construct a velocity
  // pipeline. Reuses the same shader module + bind group layout as the
  // color pipeline.
  let velocityPipeline = null;
  if (frameState.taaEnabled === true) {
    let velEntry = cache.velocityPipelineEntries.get(defines);
    if (!defined(velEntry)) {
      const depthFmt2 = context.depthFormat || "depth24plus-stencil8";
      const moduleCache2 = getShaderModuleCache(device);
      const shaderModule2 = moduleCache2.getOrCreate(
        ShaderSourceId.BILLBOARD_COLLECTION,
        shaderCode,
        defines,
        "Billboard shader",
      );
      const velDescriptor = buildBillboardVelocityDescriptor(
        device,
        shaderModule2,
        depthFmt2,
        cache.bindGroupLayout,
        defines,
      );
      velEntry = { descriptor: velDescriptor, pipeline: null, pending: false };
      cache.velocityPipelineEntries.set(defines, velEntry);
    }
    velocityPipeline = tryResolveBillboardPipeline(
      device,
      context.webgpuPipelineCache ?? null,
      velEntry,
    );
  }
  cache.velocityPipeline = velocityPipeline;

  // Uniform buffer (once)
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Billboard uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Update uniforms
  const modelMatrix = collection.modelMatrix || Matrix4.IDENTITY;
  packUniforms(cache.uniformData, frameState, modelMatrix, collection);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Atlas texture. Two independent paths:
  //   1. Collection has a real `textureAtlas` with a populated GPU texture \u2014
  //      use the real view keyed by the atlas's `guid`. When the guid changes
  //      (new image added, atlas resized) drop the bind group so a new one
  //      binds the rotated texture view.
  //   2. Atlas not yet ready \u2014 bind a 1x1 white placeholder so the pipeline
  //      has a valid texture to sample. Any later frame with a ready atlas
  //      will swap in the real view via the path above.
  const atlas = collection._textureAtlas;
  const atlasTex = atlas?.texture;
  const atlasGpuTex = atlasTex?._texture?._webgpuTexture;
  const atlasGuid = atlas?.guid;

  if (defined(atlasGpuTex) && cache.atlasGuid !== atlasGuid) {
    // Real atlas is ready (or updated). Bind its view; drop any cached bind
    // group so it gets rebuilt with the new resource.
    cache.atlasTextureView = atlasGpuTex.view;
    cache.sampler = atlasGpuTex.sampler;
    cache.atlasGuid = atlasGuid;
    cache.bindGroup = undefined;
    // The placeholder (if we previously allocated one) is no longer needed.
    if (defined(cache.atlasPlaceholder)) {
      cache.atlasPlaceholder.destroy();
      cache.atlasPlaceholder = undefined;
    }
  } else if (!defined(cache.atlasTextureView)) {
    // Still waiting on the atlas; bind a placeholder so the pipeline is valid.
    cache.atlasPlaceholder = createPlaceholderTexture(device);
    cache.atlasTextureView = cache.atlasPlaceholder.createView();
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
    });
  }

  // Batch 138 / Batch 139 (VS_THREE_POINT_DEPTH_CHECK) \u2014 globe depth
  // view + sampler. Pulls the underlying texture from
  // `context._globeDepthTexture` (published by the scene renderer's
  // frustum loop) and creates the view ourselves so cache identity is
  // stable. The scene renderer's `_globeDepthView` is a fresh view
  // every frame; comparing by texture identity avoids per-frame bind
  // group rebuilds. Falls back to a 1\u00d71 placeholder when the globe
  // didn't render this frame.
  if (!defined(cache.globeDepthPlaceholder)) {
    cache.globeDepthPlaceholder = device.createTexture({
      label: "Billboard globe-depth placeholder 1x1",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: cache.globeDepthPlaceholder },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      [1, 1, 1],
    );
    cache.globeDepthPlaceholderView = cache.globeDepthPlaceholder.createView();
    cache.globeDepthSampler = device.createSampler({
      label: "Billboard globe-depth sampler",
      minFilter: "nearest",
      magFilter: "nearest",
    });
  }
  const globeDepthTexture = context._globeDepthTexture ?? null;
  if (cache.globeDepthCachedTexture !== globeDepthTexture) {
    cache.globeDepthCachedTexture = globeDepthTexture;
    cache.globeDepthCachedView =
      globeDepthTexture !== null ? globeDepthTexture.createView() : null;
  }
  const effectiveGlobeDepthView =
    cache.globeDepthCachedView ?? cache.globeDepthPlaceholderView;
  if (cache.lastGlobeDepthView !== effectiveGlobeDepthView) {
    cache.lastGlobeDepthView = effectiveGlobeDepthView;
    cache.bindGroup = undefined;
  }

  // Bind group \u2014 (re)created when the atlas view rotates or the
  // globe depth view changes (per-frame on globe scenes).
  if (!defined(cache.bindGroup)) {
    cache.bindGroup = device.createBindGroup({
      layout: cache.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: cache.atlasTextureView },
        { binding: 2, resource: cache.sampler },
        { binding: 3, resource: effectiveGlobeDepthView },
        { binding: 4, resource: cache.globeDepthSampler },
      ],
    });
  }

  // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) \u2014 per-slice camera
  // UB. Billboard's group 0 mixes the camera buffer (binding 0) with the atlas
  // texture/sampler + globe-depth view/sampler (bindings 1-4), which rotate per
  // frame \u2014 the resolver rebuilds group 0 with the slice's own buffer + those
  // SAME texture refs as extraEntries (its generation token keys off the
  // texture identities so a view rotation rebuilds the per-slice groups too).
  // The static `cache.bindGroup` is the slice-0 / single-frustum fallback.
  if (!defined(cache.cameraUB)) {
    cache.cameraUB = new WebGPUCollectionCameraUB(device, "Billboard");
  }
  cache.cameraUB.bindUniformState(context.uniformState);
  // PHASE 3 SLICE 2 (NEW-COLLECTIONS-2DCV-PROJECTED-FRAME-RTE) — repack the
  // camera UB per slice at draw time in 2D/CV/MORPHING so the MVP uses the live
  // slice projection (WebGPU depth range). SCENE3D stays snapshot-only.
  const repackPerSlice = frameState.mode !== SceneMode.SCENE3D;
  cache.cameraResolver = cache.cameraUB.makeResolver({
    bufferSize: UNIFORM_BUFFER_SIZE,
    bindGroupLayout: cache.bindGroupLayout,
    pack: (data) => packUniforms(data, frameState, modelMatrix, collection),
    repackPerSlice: repackPerSlice,
    extraEntries: [
      { binding: 1, resource: cache.atlasTextureView },
      { binding: 2, resource: cache.sampler },
      { binding: 3, resource: effectiveGlobeDepthView },
      { binding: 4, resource: cache.globeDepthSampler },
    ],
  });

  // Instance data — resident-instance partial-write path
  // (NEW-RESIDENT-INSTANCE-BUFFER-MGR + NEW-PARTIAL-WRITE-WIRE-BPL).
  // A settled collection uploads nothing; a sparse change re-packs +
  // uploads only the changed slots' byte ranges. The manager owns the
  // resident CPU array, the GPU vertex buffer, the compacted
  // _index→slot map, and the slot-aligned velocity prev mirror.
  if (!defined(cache.instanceManager)) {
    cache.instanceManager = new WebGPUResidentInstanceBuffer(
      device,
      "Billboard instances",
    );
  }

  // Structural invalidations the manager can't see from the dirty list
  // alone. `_createVertexArray` covers add/remove/removeAll/mode-change/
  // 2D-CV modelMatrix change (read BEFORE _consumeDirtyState clears it);
  // defines/atlas-guid changes re-shape packed data collection-wide;
  // MORPHING recomputes every _actualPosition per frame without dirtying.
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  const atlasGuidNow = collection._textureAtlas?.guid;
  const forceFullRebuild =
    collection._createVertexArray === true ||
    cache._instanceDefines !== defines ||
    cache._instanceSceneMode !== frameState.mode ||
    cache._instanceAtlasGuid !== atlasGuidNow ||
    frameState.mode === SceneMode.MORPHING;

  // ORDERING (load-bearing): capture + sync the dirty list FIRST, then
  // consume. `_consumeDirtyState` resets `_billboardsToUpdateIndex`, so
  // syncing after the consume would always see an empty dirty list and
  // never partial-write. (NEW-COLLECTIONS-DIRTY-GATE step 0 + Phase 1.)
  const syncResult = cache.instanceManager.sync({
    items: collection._billboards,
    length: length,
    dirtyList: collection._billboardsToUpdate,
    dirtyCount: collection._billboardsToUpdateIndex,
    packInstance: packBillboardInstance,
    isVisible: isBillboardVisible,
    floatsPerInstance: FLOATS_PER_INSTANCE,
    bytesPerInstance: BYTES_PER_INSTANCE,
    forceFullRebuild: forceFullRebuild,
    mirrorPrev: taaEnabledThisFrame,
  });
  cache._instanceDefines = defines;
  cache._instanceSceneMode = frameState.mode;
  cache._instanceAtlasGuid = atlasGuidNow;

  // Consume the collection's dirty-tracking state now that this frame's
  // instance data is captured. Without this the WebGL `_createVertexArray` /
  // `textureDirty` flags stay set on the WebGPU path and `updateMode` + the
  // readiness loop re-dirty every settled billboard every frame — defeating
  // any dirty gate / per-instance partial-update. See
  // BillboardCollection._consumeDirtyState. (NEW-COLLECTIONS-DIRTY-GATE step 0.)
  collection._consumeDirtyState();

  const visibleCount = syncResult.visibleCount;
  if (visibleCount === 0 || !defined(syncResult.buffer)) {
    return;
  }
  cache.instanceBuffer = syncResult.buffer;

  // Pick the command pass from the collection's blendOption so translucent
  // billboards composite in the back-to-front translucent pass rather than
  // painting on top of opaque geometry in unsorted order. BlendOption is:
  //   OPAQUE = 0, TRANSLUCENT = 1, OPAQUE_AND_TRANSLUCENT = 2
  // For OPAQUE_AND_TRANSLUCENT we emit the command in the TRANSLUCENT pass
  // since billboard shaders use straight alpha blending; truly opaque glyphs
  // still composite correctly in the translucent pass. A future refinement
  // would emit two commands (one per pass) when the collection is mixed.
  const blendOpt = collection._blendOption;
  const billboardPass =
    blendOpt === 0 ? 8 /* Pass.OPAQUE */ : 9; /* Pass.TRANSLUCENT */

  // C-R1-COLLECTIONS-PER-ENCODER (Batch 39) — forward the source
  // JS-side renderState from BillboardCollection (`_rsOpaque` /
  // `_rsTranslucent`) so `applyPerEncoderState` drives the dynamic
  // WebGPU pass state (stencil ref, blend constant, scissor,
  // viewport) from the same values the WebGL path uses. Without this
  // the command ran with whatever the encoder's default was for the
  // current pass, producing subtle stencil/blend drift relative to
  // WebGL. The `pass: OPAQUE` emit uses `_rsOpaque`; every other
  // emit (TRANSLUCENT or OPAQUE_AND_TRANSLUCENT) uses `_rsTranslucent`.
  const colorRenderState =
    billboardPass === 8 /* Pass.OPAQUE */
      ? collection._rsOpaque
      : collection._rsTranslucent;

  cache.colorCommand = new WebGPUDrawCommand({
    pipeline: cache.pipeline,
    bindGroups: [cache.bindGroup],
    // NEW-COLLECTIONS-PER-FRUSTUM-CAMERA-UB (Phase 3 Slice 1) — per-slice
    // camera UB at group 0. Falls back to the static bind group when the
    // slice index is unavailable (single-frustum / first frame).
    bindGroupResolvers: [cache.cameraResolver],
    vertexBuffers: [cache.instanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: visibleCount,
    pass: billboardPass,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
    renderState: colorRenderState,
  });

  // AUDIT_2026_05_02 B.10 (Batch 143, NEW-COLLECTIONS-MOTION-VECTORS) —
  // attach velocity command. The TAA pass walks the command list for
  // `cmd.velocityCommand` and dispatches it into the rg16float velocity
  // texture. Mirrors `WebGPUModelRenderer.js`'s velocity attachment
  // pattern (Batch 106). Only emitted when TAA is enabled this frame
  // AND the velocity pipeline resolved this tick (it can be null on
  // the first frame after TAA enables, while async pipeline creation
  // is in flight; the next frame will pick up the resolved pipeline).
  // The prev mirror is slot-aligned with the current buffer by the
  // resident-instance manager (partial writes mirror the prev slot too),
  // so the velocity VS reads matching instances at locations 11/12.
  if (taaEnabledThisFrame && velocityPipeline && syncResult.prevBuffer) {
    cache.velocityCommand = new WebGPUDrawCommand({
      pipeline: velocityPipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.instanceBuffer, syncResult.prevBuffer],
      vertexCount: VERTICES_PER_QUAD,
      instanceCount: visibleCount,
      pass: billboardPass,
      owner: collection,
      boundingVolume: collection._boundingVolume,
      modelMatrix: modelMatrix,
      cull: true,
      renderState: colorRenderState,
    });
    cache.colorCommand.velocityCommand = cache.velocityCommand;
  } else {
    cache.colorCommand.velocityCommand = undefined;
  }

  // Pick pass handling
  if (frameState.passes.pick) {
    _pushBillboardPickCommand(
      collection,
      context,
      device,
      cache,
      modelMatrix,
      visibleCount,
      commandList,
    );
  }

  // Push color command for render passes
  if (frameState.passes.render) {
    commandList.push(cache.colorCommand);
  }
}

/**
 * Builds and pushes a billboard pick draw command. Reuses the same
 * bind group layout as color (needs atlas for alpha discard).
 * @private
 */
function _pushBillboardPickCommand(
  collection,
  context,
  device,
  cache,
  modelMatrix,
  visibleCount,
  commandList,
) {
  // DP-H42 / DP-H40 — pick pipeline uses the same defines as the color
  // pipeline for this frame so the pick region exactly matches the
  // rendered region. Falls back to the baseline (0) when the color path
  // hasn't set currentDefines yet (first-ever frame).
  // C-R7-RENDERER-MIGRATION (Batch 73) — entry-based caching via
  // `cache.pickPipelineEntries`; pipeline resolves through the central
  // pipeline cache. Skip the pick command if the pipeline is still
  // materializing (a frame later it'll be ready).
  const pickDefines = cache.currentDefines ?? 0;
  if (!defined(cache.pickPipelineEntries)) {
    cache.pickPipelineEntries = new Map();
  }
  let pickEntry = cache.pickPipelineEntries.get(pickDefines);
  if (!defined(pickEntry)) {
    // NEW-DERIVEDCOMMAND-VARIANT-FACTORY (Batch 248) — the pick descriptor
    // is DERIVED from the color descriptor through the centralized variant
    // factory (slot-0-only blend-stripped target, depth write forced on,
    // multisample dropped for the single-sample pick FBO) instead of the
    // old hand-rolled `buildBillboardPickDescriptor`. The color entry for
    // this defines-set always exists here: `updateWebGPUBillboards` builds
    // and resolves it before pushing the pick command.
    const colorEntry = cache.pipelineEntries.get(pickDefines);
    if (!defined(colorEntry)) {
      // Only reachable via the `?? 0` fallback before the first color
      // resolve — skip the pick draw this frame; next frame the color
      // descriptor exists.
      return;
    }
    const pickShader = getCollectionShaderSource("billboardPick");
    const moduleCache = getShaderModuleCache(device);
    // Pick shader has its own source ID so its cache entries stay
    // distinct from the color pipeline's at the same defines.
    const pickModule = moduleCache.getOrCreate(
      ShaderSourceId.BILLBOARD_COLLECTION_PICK,
      pickShader,
      pickDefines,
      "Billboard pick shader",
    );
    const descriptor = WebGPUDerivedCommand.deriveDescriptor(
      colorEntry.descriptor,
      DerivedCommandType.PICK,
      // Whole-module swap: the dedicated pick shader source compiled at
      // the same defines as the color module (entry points unchanged —
      // vertexMain/fragmentMain exist in both modules).
      { module: pickModule },
    );
    pickEntry = { descriptor, pipeline: null, pending: false };
    cache.pickPipelineEntries.set(pickDefines, pickEntry);
  }
  const pickPipeline = tryResolveBillboardPipeline(
    device,
    context.webgpuPipelineCache ?? null,
    pickEntry,
  );
  if (!pickPipeline) {
    return;
  }
  cache.pickPipeline = pickPipeline;

  const pickResult = buildPickInstanceData(collection, context);
  if (pickResult.visibleCount === 0) {
    return;
  }

  const pickSize = pickResult.visibleCount * BYTES_PER_INSTANCE;
  if (
    !defined(cache.pickInstanceBuffer) ||
    cache.pickInstanceBuffer.size < pickSize
  ) {
    if (defined(cache.pickInstanceBuffer)) {
      cache.pickInstanceBuffer.destroy();
    }
    cache.pickInstanceBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      pickSize,
      false,
      "Billboard pick instances",
    );
  }
  device.queue.writeBuffer(
    cache.pickInstanceBuffer.buffer,
    0,
    pickResult.instanceData.buffer,
    0,
    pickSize,
  );

  // Pick always runs in the OPAQUE pass — use `_rsOpaque` so the pick
  // FBO sees the same depth behavior as the color opaque path. When
  // the collection is TRANSLUCENT-only `_rsOpaque` is undefined, and
  // the command falls back to encoder defaults (pick commands don't
  // blend, so that's safe).
  cache.pickCommand = new WebGPUDrawCommand({
    pipeline: cache.pickPipeline,
    bindGroups: [cache.bindGroup], // Reuse color bind group (same uniforms + atlas)
    vertexBuffers: [cache.pickInstanceBuffer],
    vertexCount: VERTICES_PER_QUAD,
    instanceCount: pickResult.visibleCount,
    pass: 8,
    owner: collection,
    boundingVolume: collection._boundingVolume,
    modelMatrix: modelMatrix,
    cull: true,
    renderState: collection._rsOpaque ?? collection._rsTranslucent,
    // FORK-34 (Batch 207) — mark as a dedicated pick command so the pick
    // pass dispatches it (single-target pick pipeline) instead of skipping
    // it as a no-pick-variant base command.
    pickOnly: true,
  });

  commandList.push(cache.pickCommand);
}

function destroyWebGPUBillboardResources(collection) {
  const cache = collection._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  // The resident-instance manager owns the current instance buffer AND
  // the velocity prev mirror (cache.instanceBuffer is just an alias of
  // manager.buffer for the draw command).
  if (defined(cache.instanceManager)) {
    cache.instanceManager.destroy();
  }
  if (defined(cache.pickInstanceBuffer)) {
    cache.pickInstanceBuffer.destroy();
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  // Only destroy the placeholder \u2014 the real atlas texture is owned by the
  // collection's TextureAtlas and will be released by it.
  if (defined(cache.atlasPlaceholder)) {
    cache.atlasPlaceholder.destroy();
  }
  if (defined(cache.atlasTexture)) {
    // Legacy field from before atlas-invalidation landed; destroy if present.
    cache.atlasTexture.destroy();
  }
  collection._webgpuCache = undefined;
}

export { updateWebGPUBillboards, destroyWebGPUBillboardResources };
export default { updateWebGPUBillboards, destroyWebGPUBillboardResources };
