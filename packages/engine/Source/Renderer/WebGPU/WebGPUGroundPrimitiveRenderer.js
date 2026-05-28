/**
 * @module WebGPUGroundPrimitiveRenderer
 *
 * Handles WebGPU rendering of GroundPrimitive / ClassificationPrimitive.
 *
 * **Architecture pivot (ADR-2026-04-28, Migration Session 1):** This
 * renderer is migrating from a 2-pass stencil approach (mark coverage in
 * stencil, then paint where stencil matches) to a depth-texture sampling
 * approach matching WebGL's `ShadowVolumeAppearanceFS.glsl`. The depth
 * approach lets the classifier swap depth sources at runtime
 * (globe-depth ↔ packed-translucent-depth ↔ per-frustum), unlocking
 * translucent-on-translucent classification, PointCloud translucent
 * tile classification (Batch 79 only fixed Models), multi-frustum
 * correctness, and `WebGPUGroundPolylineRenderer` (currently absent) on
 * the same plumbing.
 *
 * Current state:
 *   - **Default dispatch path**: depth-sample (single pass per primitive).
 *     Reads `WebGPUGlobeDepth.globeDepthTexture` (RGBA-packed depth) and
 *     `discard`s where depth is 0 (sky / no surface). The volume's
 *     rasterization handles lateral coverage; depth-clamp on the VS is
 *     unchanged from the stencil path.
 *   - **Compiled-but-unused fallback**: stencil 2-pass + color + pick
 *     pipelines. Kept around for Migration Session 2-3 work as a quick
 *     toggle if the depth-sample path needs a regression workaround.
 *     Slated for removal in Migration Session 5.
 *
 * Limitations of the Session 1 first-cut (resolved in later sessions):
 *   - Single fixed depth source (globe depth). Translucent-tile clipping
 *     still falls back to Batch 79's selective-depth-write path —
 *     Migration Session 2 wires the runtime depth-source swap.
 *   - Per-instance color only. Material/textured appearance and
 *     normal-from-depth-derivative computation are not ported yet.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import SceneMode from "../../Scene/SceneMode.js";
import csm_depthClamp from "../../Shaders/WebGPU/chunks/functions/csm_depthClamp.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// Slice 5c-B Phase 1 (Batch 111) — scene-FB target helper. Used only
// for color pipelines. Pick (`[{ format }]`), depth-only
// (`[{ format, writeMask: 0 }]`), and velocity (`[{ format: "rg16float" }]`)
// pipelines stay single-target.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  sampler as samplerEntry,
  texture as textureEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  attachPickToColorCommand,
  destroyPickIds,
  ensurePickId,
} from "./WebGPUPickCommandHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 185) — per-device module cache.
// GroundPrimitive is typically few-per-scene, but we just touched this
// file in Batch 180 for the velocity entry points so the ride-along is
// free. Closes the C-R7-SHADER-MODULE-DEDUP adoption sweep.
const _groundPrimitiveShaderCaches = new WeakMap();

function getGroundPrimitiveShaderCache(device) {
  let cache = _groundPrimitiveShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _groundPrimitiveShaderCaches.set(device, cache);
  }
  return cache;
}

// Batch 164 — UBO 256 → 384 bytes to carry separate `mvRTE` + `proj`
// matrices + a `morphFlags` vec4 for the SCENE3D ↔ SCENE2D morph
// pipeline. The morph VS uses these alongside `mvpRTE` to project both
// the 3D ECEF and 2D-projected position attributes through the
// morph-state view, then blends in EC space by `morphFlags.x`
// (morphTime). Pre-Batch-164 the renderer silently skipped MORPHING.
//
// Batch 171 — UBO 384 → 640 bytes to add the textured-material slots
// (NEW-GROUNDPRIM-TEXTURED-MATERIALS). New tail carries:
//   `invProj` — for depth → eye-coord recovery
//   `materialMeta` / `materialColor` / `materialParam0` / `materialParam1`
//                  — material dispatch (mirrors GroundPolyline)
//   `swCornerEC` / `eastwardEC` / `northwardEC` — planar-extent fields
//                  (CPU-transformed to eye space once per frame so the
//                  FS just does plane-dot for UV recovery — no per-
//                  fragment matrix mul)
//   `extentMode`   — .x = 0 (planar) | 1 (spherical), .yz = inverse
//                    extents (planar) or (latRangeInv, lonRangeInv)
//                    (spherical), .w = longitudeRotation (spherical)
//   `sphericalSW`  — (south, west, _, _) — spherical-extent corner
//   `invView`      — for spherical worldCoord recovery (eye → world)
// Threshold `ShadowVolumeAppearance.MAX_WIDTH_FOR_PLANAR_EXTENTS`
// (~1°) decides which path a given polygon's geometry was built for;
// the per-instance attribute set determines which fields the FS uses.
const UNIFORM_BUFFER_SIZE = 640;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchProjection = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

// NEW-GROUNDPRIM-TEXTURED-MATERIALS (Batch 171) — eye-space scratches
// for the planar-extent transform in packUniforms. The world-space SW
// corner + east/north direction vectors are read from the primitive's
// per-instance attributes (`getGeometryInstanceAttributes`), pulled
// out of the batch table, and transformed through `scratchMVRTE` (the
// mode-correct view matrix with translation zeroed) into eye space.
const scratchRTEDelta = new Cartesian3();
const scratchSWHigh = new Cartesian3();
const scratchSWLow = new Cartesian3();
const scratchSWEC = new Cartesian3();
const scratchEastWorld = new Cartesian3();
const scratchNorthWorld = new Cartesian3();
const scratchEastEC = new Cartesian3();
const scratchNorthEC = new Cartesian3();

/**
 * Material-type enum mirroring `materialMeta.x` in the WGSL. Adding a
 * material requires (a) a new entry here, (b) a matching `applyMaterial`
 * branch in the WGSL, and (c) packing the material's parameters into
 * `materialParam0` / `materialParam1` in `resolveMaterialState`.
 *
 * @private
 */
const GroundPrimitiveMaterialType = Object.freeze({
  COLOR: 0,
  STRIPE: 1,
  CHECKERBOARD: 2,
  GRID: 3,
  // IMAGE = 4 (reserved — texture upload plumbing is a follow-up; falls
  // through to COLOR until then).
});

// Track which custom material `type` strings we've already warned about
// (avoid log spam when the same custom material rides many primitives).
const _warnedCustomGroundMaterialTypes = new Set();

/**
 * Inspect the appearance's material and return a packed material state
 * the WGSL `applyMaterial` consumes. Returns `{ type, color, param0,
 * param1 }` — all four valid for any input. Unknown material types log
 * once and fall through to the flat-color path (`type = 0`).
 *
 * Mirrors the GroundPolyline `resolveMaterialState` pattern; the
 * material-types supported differ because polygon materials don't have
 * the polyline-specific `Dash` / `Glow` / `Outline` / `Arrow` set, but
 * DO use the polygon-relevant `Stripe` / `Checkerboard` / `Grid`.
 *
 * @private
 */
function resolveMaterialState(primitive) {
  const fallback = {
    type: GroundPrimitiveMaterialType.COLOR,
    color: [1.0, 1.0, 1.0, 1.0],
    param0: [0.0, 0.0, 0.0, 0.0],
    param1: [0.0, 0.0, 0.0, 0.0],
  };
  const material = primitive?.appearance?.material;
  if (!material) {
    return fallback;
  }
  const type = material.type;
  const uniforms = material.uniforms ?? {};

  const packColor = (c, defaults) =>
    defined(c)
      ? [
          c.red ?? defaults[0],
          c.green ?? defaults[1],
          c.blue ?? defaults[2],
          c.alpha ?? defaults[3],
        ]
      : defaults;

  if (type === "Stripe") {
    // StripeMaterial uniforms (see Material.js, Material.StripeType):
    //   horizontal (bool, default true) -- stripes run along the s axis
    //                                       when true; along t when false
    //   evenColor / oddColor / offset / repeat
    // Note: `StripeOrientation` (the CZML enum) is a higher-level concept
    // that the `StripeMaterialProperty` layer maps to the boolean
    // `horizontal` uniform -- by the time we see the material here, the
    // mapped boolean is on `uniforms.horizontal`. Read THAT directly.
    const oddColor = uniforms.oddColor;
    const isHorizontal = uniforms.horizontal !== false; // default true
    return {
      type: GroundPrimitiveMaterialType.STRIPE,
      color: packColor(uniforms.evenColor, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        uniforms.repeat ?? 5.0,
        uniforms.offset ?? 0.0,
        isHorizontal ? 1.0 : 0.0,
        0.0,
      ],
      param1: packColor(oddColor, [0.0, 0.0, 0.0, 1.0]),
    };
  }

  if (type === "Checkerboard") {
    const repeat = uniforms.repeat;
    return {
      type: GroundPrimitiveMaterialType.CHECKERBOARD,
      color: packColor(uniforms.lightColor, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        repeat?.x ?? repeat?.[0] ?? 5.0,
        repeat?.y ?? repeat?.[1] ?? 5.0,
        0.0,
        0.0,
      ],
      param1: packColor(uniforms.darkColor, [0.0, 0.0, 0.0, 1.0]),
    };
  }

  if (type === "Grid") {
    const lineCount = uniforms.lineCount;
    const lineThickness = uniforms.lineThickness;
    return {
      type: GroundPrimitiveMaterialType.GRID,
      color: packColor(uniforms.color, [1.0, 1.0, 1.0, 1.0]),
      param0: [
        uniforms.cellAlpha ?? 0.1,
        lineCount?.x ?? lineCount?.[0] ?? 8.0,
        lineCount?.y ?? lineCount?.[1] ?? 8.0,
        0.0,
      ],
      param1: [
        lineThickness?.x ?? lineThickness?.[0] ?? 1.0,
        lineThickness?.y ?? lineThickness?.[1] ?? 1.0,
        0.0,
        0.0,
      ],
    };
  }

  if (type === "Color") {
    // Explicit Color material — packs through the materialColor slot so
    // even custom-colored ColorAppearance flows ride the texture path
    // consistently. The dsColorFS fast path (type==0) still wins.
    return {
      type: GroundPrimitiveMaterialType.COLOR,
      color: packColor(uniforms.color, [1.0, 1.0, 1.0, 1.0]),
      param0: [0.0, 0.0, 0.0, 0.0],
      param1: [0.0, 0.0, 0.0, 0.0],
    };
  }

  // Unknown material type — warn once + fall through to Color so the
  // primitive still classifies (just untextured). Image material is the
  // intended next addition; until its texture-upload plumbing lands it
  // also lands here.
  //>>includeStart('debug', pragmas.debug);
  if (defined(type) && !_warnedCustomGroundMaterialTypes.has(type)) {
    _warnedCustomGroundMaterialTypes.add(type);
    console.warn(
      `[WebGPU:GroundPrimitive] material type="${type}" not natively ` +
        "supported — falling back to flat color. " +
        "Supported: Color, Stripe, Checkerboard, Grid. " +
        "Image + custom materials are pending follow-up work.",
    );
  }
  //>>includeEnd('debug');
  return fallback;
}

/**
 * Read the extent attributes from the primitive's first geometry
 * instance and pack them into the UBO so the FS can recover surface
 * UV from a depth-sampled fragment.
 *
 * Two paths, picked by the primitive's geometry (`GroundPrimitive`
 * decides during `update` based on `MAX_WIDTH_FOR_PLANAR_EXTENTS`):
 *
 *   - **Planar** (small polygons, bounding rect < ~1°): per-instance
 *     attributes `southWest_HIGH/LOW` + `eastward` + `northward`. The
 *     un-normalized `eastward` / `northward` vectors are SW→SE and
 *     SW→NW; their magnitudes are the east and north extents. CPU-
 *     transformed to eye space (`mvRTE`) once per frame — FS does a
 *     dot product per axis, no per-fragment matrix mul. Mirrors WebGL's
 *     `ShadowVolumeAppearanceVS` lines 71-86 + `…FS` lines 63-64.
 *
 *   - **Spherical** (larger polygons): per-instance attributes
 *     `sphericalExtents` (south, west, latRangeInv, lonRangeInv) +
 *     `longitudeRotation` (IDL handling). The FS recovers the surface
 *     world position via `invView × eyeCoord`, computes approximate
 *     (lat, lon) from `atan2`, and applies the SW corner + range
 *     inverses to get UV. Mirrors WebGL's `…FS` lines 54-60. `invView`
 *     is packed once per frame from `uniformState.inverseView`.
 *
 * Writes `extentMode.x = 0` (planar) or `1` (spherical); the FS
 * `surfaceUV` dispatches on it.
 *
 * Returns `true` if either extent path is wired, `false` if the
 * primitive lacks both attribute sets (e.g. a non-textured
 * GroundPrimitive that never went through `useFragmentCulling = true`).
 *
 * @private
 */
function packExtents(data, primitive, frameState) {
  // Walk the wrapping chain: GroundPrimitive → ClassificationPrimitive
  // → Primitive (mirrors the comment at the _webgpuGeometryData lookup
  // site below). Lookup may fail during the first few frames before
  // ClassificationPrimitive.update has run.
  const inner = primitive?._primitive?._primitive;
  if (!inner || !inner._instanceIds || inner._instanceIds.length === 0) {
    return false;
  }
  // Read the extents DIRECTLY from the batch table by integer index,
  // bypassing the public `getGeometryInstanceAttributes(id)` API which
  // requires the GeometryInstance to have a defined `id`. The extents
  // are per-instance attributes added by
  // `ShadowVolumeAppearance.getPlanarTextureCoordinateAttributes`; we
  // only care about the FIRST instance (multi-instance + per-instance
  // materials is a follow-up). `_batchTableAttributeIndices` is the
  // name → batch-table-index map populated when the inner Primitive's
  // batch table is built (Primitive.js); ALL four extent attributes
  // appear together (a planar-extent primitive has all or none).
  const bt = inner._batchTable;
  const indices = inner._batchTableAttributeIndices;
  if (!bt || !indices) {
    return false;
  }

  // Slot layout (recap):
  //   swCornerEC   = 120..123 (planar only; 0 in spherical)
  //   eastwardEC   = 124..127 (planar only)
  //   northwardEC  = 128..131 (planar only)
  //   extentMode   = 132..135 (.x = mode, .yz = inv extents, .w = lonRot)
  //   sphericalSW  = 136..139 (.xy = (south, west); 0 in planar)
  //   invView      = 140..155 (spherical only; identity in planar)

  // Planar path: 4 attributes (southWest_HIGH/LOW + eastward + northward).
  const swHIdx = indices.southWest_HIGH;
  const swLIdx = indices.southWest_LOW;
  const eastIdx = indices.eastward;
  const northIdx = indices.northward;
  if (
    swHIdx !== undefined &&
    swLIdx !== undefined &&
    eastIdx !== undefined &&
    northIdx !== undefined
  ) {
    const swH = bt.getBatchedAttribute(0, swHIdx);
    const swL = bt.getBatchedAttribute(0, swLIdx);
    const eastW = bt.getBatchedAttribute(0, eastIdx);
    const northW = bt.getBatchedAttribute(0, northIdx);
    if (!swH || !swL || !eastW || !northW) {
      return false;
    }
    scratchSWHigh.x = swH.x;
    scratchSWHigh.y = swH.y;
    scratchSWHigh.z = swH.z;
    scratchSWLow.x = swL.x;
    scratchSWLow.y = swL.y;
    scratchSWLow.z = swL.z;
    scratchEastWorld.x = eastW.x;
    scratchEastWorld.y = eastW.y;
    scratchEastWorld.z = eastW.z;
    scratchNorthWorld.x = northW.x;
    scratchNorthWorld.y = northW.y;
    scratchNorthWorld.z = northW.z;

    // RTE delta to camera, then mvRTE to eye space. Mirrors the colorVS
    // RTE form: rte = (pH - camH) + (pL - camL).
    const camHigh = scratchEncodedCamera.high;
    const camLow = scratchEncodedCamera.low;
    scratchRTEDelta.x =
      scratchSWHigh.x - camHigh.x + (scratchSWLow.x - camLow.x);
    scratchRTEDelta.y =
      scratchSWHigh.y - camHigh.y + (scratchSWLow.y - camLow.y);
    scratchRTEDelta.z =
      scratchSWHigh.z - camHigh.z + (scratchSWLow.z - camLow.z);
    Matrix4.multiplyByPointAsVector(scratchMVRTE, scratchRTEDelta, scratchSWEC);
    Matrix4.multiplyByPointAsVector(
      scratchMVRTE,
      scratchEastWorld,
      scratchEastEC,
    );
    Matrix4.multiplyByPointAsVector(
      scratchMVRTE,
      scratchNorthWorld,
      scratchNorthEC,
    );

    const eastExtent = Cartesian3.magnitude(scratchEastEC);
    const northExtent = Cartesian3.magnitude(scratchNorthEC);
    if (eastExtent < 1e-6 || northExtent < 1e-6) {
      return false;
    }
    Cartesian3.divideByScalar(scratchEastEC, eastExtent, scratchEastEC);
    Cartesian3.divideByScalar(scratchNorthEC, northExtent, scratchNorthEC);

    data[120] = scratchSWEC.x;
    data[121] = scratchSWEC.y;
    data[122] = scratchSWEC.z;
    data[123] = 0.0;
    data[124] = scratchEastEC.x;
    data[125] = scratchEastEC.y;
    data[126] = scratchEastEC.z;
    data[127] = 0.0;
    data[128] = scratchNorthEC.x;
    data[129] = scratchNorthEC.y;
    data[130] = scratchNorthEC.z;
    data[131] = 0.0;
    // extentMode.x = 0 (planar), .y/z = inv extents.
    data[132] = 0.0;
    data[133] = 1.0 / eastExtent;
    data[134] = 1.0 / northExtent;
    data[135] = 0.0;
    // Spherical slots zeroed.
    data[136] = 0.0;
    data[137] = 0.0;
    data[138] = 0.0;
    data[139] = 0.0;
    for (let i = 140; i <= 155; i++) {
      data[i] = 0.0;
    }
    return true;
  }

  // Spherical path: sphericalExtents (south, west, latRangeInv,
  // lonRangeInv) + longitudeRotation. The FS recovers worldCoord from
  // eyeCoord via invView, then takes (lat, lon) from atan2.
  const sphIdx = indices.sphericalExtents;
  const lonRotIdx = indices.longitudeRotation;
  if (sphIdx === undefined) {
    return false;
  }
  const sph = bt.getBatchedAttribute(0, sphIdx);
  if (!sph) {
    return false;
  }
  // The packer in ShadowVolumeAppearance writes
  //   [south, west, latRangeInverse, longitudeRangeInverse]
  // as a 4-component FLOAT attribute. `getBatchedAttribute` returns a
  // Cartesian4-like object — index by .x .y .z .w in order.
  const south = sph.x ?? sph[0];
  const west = sph.y ?? sph[1];
  const latInv = sph.z ?? sph[2];
  const lonInv = sph.w ?? sph[3];
  let longitudeRotation = 0.0;
  if (lonRotIdx !== undefined) {
    const lonRot = bt.getBatchedAttribute(0, lonRotIdx);
    // `longitudeRotation` is a single-float attribute; the batch table
    // wraps it as a scalar — accept both number and length-1 array.
    longitudeRotation =
      typeof lonRot === "number" ? lonRot : (lonRot?.x ?? lonRot?.[0] ?? 0.0);
  }

  // Planar slots zeroed (FS skips them when extentMode.x == 1).
  for (let i = 120; i <= 131; i++) {
    data[i] = 0.0;
  }
  // extentMode.x = 1 (spherical), .y = 1/latRange, .z = 1/lonRange,
  // .w = longitudeRotation.
  data[132] = 1.0;
  data[133] = latInv;
  data[134] = lonInv;
  data[135] = longitudeRotation;
  // sphericalSW.xy = (south, west).
  data[136] = south;
  data[137] = west;
  data[138] = 0.0;
  data[139] = 0.0;
  // invView (16 floats, slots 140..155) — uniformState exposes
  // `inverseView` for the active SceneMode. Used by the FS to recover
  // worldCoord from eye coords for the (lat, lon) computation.
  Matrix4.pack(frameState.context.uniformState.inverseView, data, 140);
  return true;
}

/**
 * Build the three GroundPrimitive pipeline descriptors (stencil, color,
 * pick) plus the shared pipeline-layout / BGL / shader module.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58). Previously this function called
 * `device.createRenderPipeline()` three times unconditionally per
 * primitive instance. Routing through the central
 * `WebGPURenderPipelineCache` means two ground primitives with the same
 * format / depth format / blend / stencil descriptor share a single
 * `GPURenderPipeline`. The descriptors themselves still live here (they
 * carry `pipelineLayout` + the shared shader module reference), but the
 * actual pipeline objects are materialized asynchronously by the cache.
 * @private
 */
function buildGroundPipelineResources(
  device,
  format,
  depthFormat,
  sampleCount,
) {
  // UBO layout (256 bytes total — `UNIFORM_BUFFER_SIZE`):
  //   floats   0-15 : mvpRTE                         (mat4x4<f32>)
  //   floats  16-19 : camH + _p0                     (vec3<f32> + pad)
  //   floats  20-23 : camL + _p1                     (vec3<f32> + pad)
  //   floats  24-27 : color                          (vec4<f32>)
  //   floats  28-31 : pickColor                      (vec4<f32>)
  //   floats  32-35 : viewport (x, y, w, h)          (vec4<f32>)
  //   floats  36-63 : reserved (Session 4b will use these for
  //                   inverseProjection / metersPerPixel inputs needed
  //                   by the polyline classifier).
  //
  // Migration Session 5 (Batch 85) — the legacy stencil VS/FS, color VS/FS,
  // and pick FS entries were removed alongside their pipeline descriptors.
  // The depth-sample dsColor/dsPick path is now the only classification
  // path; commands fall back to "skip dispatch" rather than stencil when
  // no depth source is published yet (first frame, viewport resize), at
  // a cost of one missed classification frame at startup.
  const code = `
${csm_depthClamp}
struct U {
  mvpRTE: mat4x4<f32>,
  camH: vec3<f32>, _p0: f32,
  camL: vec3<f32>, _p1: f32,
  color: vec4<f32>,
  pickColor: vec4<f32>,
  viewport: vec4<f32>,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at
  // floats 36..51. Layout-only invariant today; consumed by future
  // motion-vector pass for ground classifiers.
  prevViewProjection: mat4x4<f32>,
  // Batch 164 — A.4 NEW-CLASSIFIER-2D-CV-MORPH morph fields. Populated
  // unconditionally so the WGSL struct size matches the 384-byte UBO,
  // but morphFlags.x (morphTime) is only read by the morph VS.
  // The non-morph VS (colorVS) keeps using mvpRTE alone. mvRTE and
  // proj are the morph-state matrices, separate because the morph
  // blend happens in EC space and re-projects with proj after lerp.
  mvRTE: mat4x4<f32>,
  proj: mat4x4<f32>,
  // .x = morphTime (1.0 = full SCENE3D, 0.0 = full SCENE2D / Columbus
  //      View, fractional during MORPHING). Outside MORPHING the
  //      morph VS isn't dispatched so this slot is don't-care.
  // .yzw = reserved.
  morphFlags: vec4<f32>,
  // NEW-GROUNDPRIM-TEXTURED-MATERIALS (Batch 171) — material dispatch.
  //
  // invProj — inverse projection matrix (uniformState.inverseProjection).
  // Used by the FS to recover eye-space from window XY + sampled depth
  // (mirrors GroundPolyline's windowToEyeCoordinates).
  invProj: mat4x4<f32>,
  // materialMeta.x = materialType enum:
  //   0 = Color (default; FS returns o.col from VS — fast path, no UV)
  //   1 = Stripe (evenColor + oddColor + repeat + offset + orientation)
  //   2 = Checkerboard (lightColor + darkColor + repeat)
  //   3 = Grid (color + cellAlpha + lineCount + lineThickness)
  //   4 = Image  (uniforms.image sampled at (s,t); reserved -- texture
  //              upload plumbing is a follow-up Tier 4)
  // materialMeta.y/z = reserved (Image-material repeat will land here).
  materialMeta: vec4<f32>,
  materialColor: vec4<f32>,
  materialParam0: vec4<f32>,
  materialParam1: vec4<f32>,
  // Planar-extent fields (CPU-transformed to eye space). Valid when
  // extentMode.x == 0 (primitive built with planar extents -- bounding
  // rect smaller than MAX_WIDTH_FOR_PLANAR_EXTENTS, ~1 degree). Zero
  // in spherical mode.
  //   swCornerEC.xyz   = SW corner of the polygon in eye space.
  //   eastwardEC.xyz   = unit east direction at SW in eye space.
  //   northwardEC.xyz  = unit north direction at SW in eye space.
  swCornerEC: vec4<f32>,
  eastwardEC: vec4<f32>,
  northwardEC: vec4<f32>,
  // extentMode.x = 0 (planar) | 1 (spherical) -- selects the FS path.
  // extentMode.y = 1/eastExtent  (planar) | 1/latRange (spherical)
  // extentMode.z = 1/northExtent (planar) | 1/lonRange (spherical)
  // extentMode.w = longitudeRotation (spherical, for IDL handling)
  //                | pad (planar)
  extentMode: vec4<f32>,
  // Spherical-extent fields. Valid when extentMode.x == 1.
  //   sphericalSW.xy = (south, west) -- (lat, lon) of SW corner in
  //     radians. UV recovery in the FS:
  //       worldPos    = invView * vec4(eyeCoord, 1.0)
  //       (lat, lon)  = approximateSpherical(worldPos)
  //       lon        += extentMode.w  (longitudeRotation; IDL shift)
  //       u           = (lon - sphericalSW.y) * extentMode.z
  //       v           = (lat - sphericalSW.x) * extentMode.y
  //     Mirrors WebGL's ShadowVolumeAppearanceFS SPHERICAL branch
  //     (ShadowVolumeAppearanceFS.glsl lines 54-65).
  sphericalSW: vec4<f32>,
  invView: mat4x4<f32>,
  // frustum.xy = (near, far) of the CURRENT frustum slice. Used by
  // windowToEye to reverse log-depth back to the camera-distance value
  // clipW = exp2(logDepth * log2(1+far)) - 1. Cesium's WebGPU pipeline
  // turns on useLogDepth by default and the globe-depth pass writes
  // log-encoded depth -- treating it as linear NDC z gives an eye-z
  // pinned at the far plane (uniform "red polygon" in the diagnostic).
  frustum: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;

// Depth-sample resources. Group 1 carries the depth texture + sampler;
// the source view is bound late by WebGPUDrawCommand.bindGroupResolvers
// at draw time so per-frustum + per-frame depth-source swaps (globe-depth
// ↔ packed-translucent-depth) take effect without rebuilding the command.
@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

// NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — per-SLICE
// frustum state. The group-0 u.invProj / u.frustum are packed ONCE
// per frame at command-build time and therefore carry the WRONG slice's
// projection in multi-frustum scenes (the depth-sample classifier draws
// in whichever slice contains the surface, not the slice that happened
// to be current when packUniforms ran). This group is bound per-slice at
// draw time by a bind-group resolver that reads the renderer's published
// context._currentFrustumInvProj / _currentFrustumNearFar, so the FS
// recovers eye-space against the correct projection. Only invProj +
// (near, far) are per-slice; u.invView stays in group 0 because the
// VIEW matrix is constant across a frame's frustum slices (only the
// projection's near/far change). The dsColorFS Color fast path never
// reads this group (short-circuits when materialType == 0), so flat-color
// classification is unaffected.
struct FrustumState {
  invProj: mat4x4<f32>,
  frustum: vec4<f32>,   // .xy = (near, far)
};
@group(2) @binding(0) var<uniform> fstate: FrustumState;

struct CO { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };

@vertex fn colorVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> CO {
  var o: CO;
  // NEW-CLASSIFIER-GROUNDPRIM-2D-RTE (Batch 170 final) — mode-conditional
  // .zxy swizzle. In SCENE2D / COLUMBUS_VIEW the bound attributes are
  // position2DHigh/Low stored as (projX, projY, height) -- the natural
  // output of mapProjection.project() in GeometryPipeline.projectTo2D.
  // But camera.positionWC in 2D/CV is in the camera's ENU frame
  // (altitude, projX, projY) -- the TRANSFORM_2D rotation in
  // CameraInternals.updateMembers -- and uniformState.view is built
  // from that ENU camera, so the VS must subtract / project in ENU space.
  // Mirror WebGL's czm_translateRelativeToEye(pos2D.zxy, pos2DLow.zxy)
  // pattern at PrimitiveShaderHelpers.js:291 -- swizzle the 2D positions
  // to (height, projX, projY) before the RTE subtraction. SCENE3D
  // (morphFlags.x == 1.0) keeps the unswizzled ECEF positions.
  let is3D = u.morphFlags.x;
  let pHm = mix(pH.zxy, pH, vec3<f32>(is3D));
  let pLm = mix(pL.zxy, pL, vec3<f32>(is3D));
  let rte = (pHm - u.camH) + (pLm - u.camL);
  // czm_depthClamp — matches WebGL ShadowVolumeAppearanceVS.glsl which
  // wraps the projection in czm_depthClamp(...). Ground primitive shadow
  // volumes bracket terrain min/max; without depth clamp the upper /
  // lower extremes get frustum-clipped at oblique viewing angles.
  o.pos = csm_depthClamp(u.mvpRTE * vec4f(rte, 1.0));
  o.col = u.color;
  return o;
}

// Reverse of WebGPUGlobeDepth's pack: each RGBA byte carries a slice of
// the depth value. The pack writes
//   floor(d * vec4(1, 255, 65025, 16581375)) / 255
// so the unpack is dot(packed, vec4(1, 1/255, 1/65025, 1/16581375)).
// Matches czm_unpackDepth in the WebGL builtins exactly.
fn unpackDepth(packed: vec4<f32>) -> f32 {
  return dot(packed, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

// Eye-coord recovery from a depth-sampled fragment. Mirrors the PROVEN
// GroundPolyline windowToEyeCoordinates (same depth-sample classifier
// family) exactly: build clip-space from window XY + the sampled depth,
// multiply by the inverse projection, perspective-divide.
//
// Batch 171 incorrectly applied a reverseLogDepth here -- but the globe
// depth pass does NOT log-encode (a grep of Globe/*.wgsl finds no
// csm_writeLogDepth/frag_depth), so the stored value IS the standard
// WebGPU NDC z in [0, 1]. GroundPolyline confirms this: it inverse-
// projects the raw depth with no log reversal. Batch 173 corrects the
// math AND reads the PER-SLICE invProj from fstate (group 2) so the
// projection matches the slice the fragment was drawn in (the once-per-
// frame group-0 u.invProj captured the wrong slice at command-build
// time). WebGPU NDC z is [0, 1] (no -1..1 remap); clip-y points down vs
// eye-y up, so flip y.
fn windowToEye(fragXY: vec2<f32>, storedDepth: f32) -> vec3<f32> {
  var ndc = (fragXY / u.viewport.zw) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  let clip = vec4<f32>(ndc, storedDepth, 1.0);
  let eye = fstate.invProj * clip;
  return eye.xyz / eye.w;
}

// UV recovery for the depth-sampled surface point. Dispatches on
// extentMode.x: 0 = planar (CPU-transformed eye-space frame; dot
// products give normalized UV), 1 = spherical (recover worldCoord via
// invView, take approximate spherical (lat, lon), subtract SW corner +
// scale by 1/range). Mirrors WebGL's ShadowVolumeAppearanceFS lines
// 53-65.
fn surfaceUV(eyeCoord: vec3<f32>) -> vec2<f32> {
  let mode = u.extentMode.x;
  if (mode < 0.5) {
    // Planar path.
    let toSW = eyeCoord - u.swCornerEC.xyz;
    let s = dot(u.eastwardEC.xyz,  toSW) * u.extentMode.y;
    let t = dot(u.northwardEC.xyz, toSW) * u.extentMode.z;
    return vec2<f32>(s, t);
  }
  // Spherical path. Eye-space → world (ECEF) via invView. The 4th
  // homogeneous component is 1 since eyeCoord is a position.
  let worldH = u.invView * vec4<f32>(eyeCoord, 1.0);
  let world = worldH.xyz / worldH.w;
  // czm_approximateSphericalCoordinates uses Cesium's
  // czm_fastApproximateAtan(arg1, arg2) which returns arctan(arg2/arg1)
  // in the right quadrant -- i.e. EQUIVALENT to standard atan2(arg2,
  // arg1) (the implementation uses opposite/adjacent ratio with
  // adjacent=first arg, opposite=second arg). So:
  //   Cesium lat = czm_fastApproximateAtan(magXY, z) == std atan2(z, magXY)
  //   Cesium lon = czm_fastApproximateAtan(x,     y) == std atan2(y, x)
  // WGSL atan2(y, x) IS std atan2. ShadowVolumeAppearance builds the
  // packed sphericalExtents on the JS side via the same
  // CesiumMath.fastApproximateAtan2 convention, so the FS conventions
  // MUST match exactly -- swap and the polygon shows a wide gradient
  // instead of a polygon-aligned texture.
  let magXY = sqrt(world.x * world.x + world.y * world.y);
  let latitude = atan2(world.z, magXY);
  var longitude = atan2(world.y, world.x);
  // IDL handling: shift longitude by longitudeRotation then wrap into
  // (-pi, pi]. WebGL's czm_branchFreeTernary is just a sign-trick mix;
  // the explicit conditional is fine here -- per-fragment but the
  // branch is uniform within the polygon (longitudeRotation is a
  // per-primitive constant).
  longitude += u.extentMode.w;
  let TWO_PI = 6.283185307179586;
  let PI = 3.141592653589793;
  if (longitude > PI) {
    longitude -= TWO_PI;
  }
  let s = (longitude - u.sphericalSW.y) * u.extentMode.z;
  let t = (latitude  - u.sphericalSW.x) * u.extentMode.y;
  return vec2<f32>(s, t);
}

// Apply material at (s, t). materialMeta.x selects among supported
// material types (see UBO doc above). The Color path is handled by the
// caller (dsColorFS) — calling applyMaterial with materialType==0 still
// returns materialColor as a safe fallback so the function is well-
// defined for any input.
fn applyMaterial(st: vec2<f32>, fallbackColor: vec4<f32>) -> vec4<f32> {
  let materialType = u32(u.materialMeta.x);

  if (materialType == 1u) {
    // Stripe. Mirrors StripeMaterial.glsl:
    //   evenColor (materialColor) -- "on" stripe
    //   oddColor  (materialParam1) -- "off" stripe
    //   repeat    (materialParam0.x) -- WebGL halves this: stripe pairs
    //             span (repeat * 0.5) cycles across the polygon.
    //   offset    (materialParam0.y) -- phase shift
    //   horizontal (materialParam0.z) -- 1 = HORIZONTAL stripes (lines
    //              along east, variation along t/north), 0 = VERTICAL
    //              stripes (lines along north, variation along s/east).
    //              WebGL: coord = mix(s, t, horizontal).
    let repeat = u.materialParam0.x;
    let offset = u.materialParam0.y;
    let horizontal = u.materialParam0.z;
    let coord = mix(st.x, st.y, horizontal);
    let value = fract((coord - offset) * (repeat * 0.5));
    // step + mix mirrors WebGL: 0 .. 0.5 = even, 0.5 .. 1 = odd.
    if (value < 0.5) {
      return u.materialColor;
    }
    return u.materialParam1;
  }

  if (materialType == 2u) {
    // Checkerboard. Mirrors CheckerboardMaterial.glsl (and the
    // condensed GroundPolyline applyMaterial Checkerboard branch):
    //   lightColor (materialColor)
    //   darkColor  (materialParam1)
    //   repeat     (materialParam0.xy)
    let repeatS = u.materialParam0.x;
    let repeatT = u.materialParam0.y;
    let parity = (floor(repeatS * st.x) + floor(repeatT * st.y)) % 2.0;
    let scaledW = fract(repeatS * st.x);
    let scaledH = fract(repeatT * st.y);
    let dW = abs(scaledW - floor(scaledW + 0.5));
    let dH = abs(scaledH - floor(scaledH + 0.5));
    let aaDist = min(dW, dH);
    let lightColor = u.materialColor;
    let darkColor = u.materialParam1;
    let solidColor = mix(lightColor, darkColor, parity);
    let fade = smoothstep(0.0, 0.03, aaDist);
    return mix(lightColor, solidColor, fade);
  }

  if (materialType == 3u) {
    // Grid. Mirrors GridMaterial.glsl (simplified — no anisotropic AA
    // adjustment for distance, just the in-cell line/cell blend):
    //   color         (materialColor) -- line + cell tint
    //   cellAlpha     (materialParam0.x)
    //   lineCount     (materialParam0.yz)
    //   lineThickness (materialParam1.xy) -- in pixels (approx, since
    //                  the FS doesn't have screen-space derivatives here)
    let cellAlpha = u.materialParam0.x;
    let lineCountS = u.materialParam0.y;
    let lineCountT = u.materialParam0.z;
    let thicknessS = u.materialParam1.x;
    let thicknessT = u.materialParam1.y;
    // Cell-relative position (0..1 within each cell).
    let cellS = fract(st.x * lineCountS);
    let cellT = fract(st.y * lineCountT);
    // Distance to nearest cell border (in cell-fraction units).
    let dS = min(cellS, 1.0 - cellS);
    let dT = min(cellT, 1.0 - cellT);
    // Convert thickness from "pixels" to cell-fraction. Use 1 / (cellSize
    // in pixels) ~= lineCount / viewportDim. Fixed 1/64 approximation
    // works for typical zooms — exact match to WebGL requires per-pixel
    // derivative-based thickness, deferred.
    let cellFracPerPixelS = lineCountS / max(u.viewport.z, 1.0);
    let cellFracPerPixelT = lineCountT / max(u.viewport.w, 1.0);
    let lineHalfS = max(thicknessS * 0.5 * cellFracPerPixelS, 0.001);
    let lineHalfT = max(thicknessT * 0.5 * cellFracPerPixelT, 0.001);
    let onLine = dS < lineHalfS || dT < lineHalfT;
    let baseColor = u.materialColor;
    if (onLine) {
      return baseColor;
    }
    // Cell interior: faint version of baseColor.
    return vec4<f32>(baseColor.rgb, baseColor.a * cellAlpha);
  }

  // materialType == 0 (Color): caller already returned via the fast
  // path; any unrecognized type also falls through to the fallback.
  return fallbackColor;
}

// Depth-sample classifier. Samples the depth source (globe-depth or
// packed-translucent-depth, swapped at draw time by the bind-group
// resolver) at the fragment's screen-space position; discards where the
// surface wrote no depth (sky / nothing classifiable). The volume's
// rasterization handles lateral coverage. Per-instance-color path is
// pixel-equivalent to WebGL's ShadowVolumeAppearanceFS PER_INSTANCE_COLOR
// + FLAT branch. NEW-GROUNDPRIM-TEXTURED-MATERIALS (Batch 171) added the
// material path: when materialMeta.x != 0, recover eye-space from
// window+depth, compute planar UV from the per-primitive extent fields,
// dispatch to the matching applyMaterial branch.
@fragment fn dsColorFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  // Fast path: per-instance / appearance flat color. No UV or material
  // dispatch needed.
  let materialType = u32(u.materialMeta.x);
  if (materialType == 0u) {
    return i.col;
  }
  // Material path: recover eye-space, compute planar UV, apply material.
  // NOTE (Batch 173): windowToEye now reads the PER-SLICE invProj from
  // group 2 (fstate) and uses the correct standard inverse-projection
  // (Batch 171 wrongly applied reverseLogDepth to linear NDC depth).
  // BUT textured materials are STILL not pixel-correct in multi-frustum:
  // the classification command has no bounding volume, so Cesium
  // distributes it to the FARTHEST frustum slice (e.g. near=1e8/far=1e10
  // at a 350 km nadir view) instead of the near slice that actually
  // contains the surface (near=0.1/far=1e8). Reconstructing the sampled
  // depth with the far slice's projection yields an eye-z in the billions
  // -> the planar UV clamps and the material renders flat. The remaining
  // fix is to give the classification command the shadow-volume bounding
  // sphere so it is frustum-distributed to the slice matching its surface
  // (tracked under NEW-GROUNDPRIM-CLASSIFIER-FRUSTUM-DISTRIBUTION). The
  // flat-color Color path is unaffected (it short-circuits above and never
  // reads fstate / the depth → eye recovery).
  let ec = windowToEye(i.pos.xy, surfaceDepth);
  let st = surfaceUV(ec);
  let outColor = applyMaterial(st, i.col);
  // Premultiply alpha to match WebGL ShadowVolumeAppearanceFS's
  // out_FragColor.rgb *= out_FragColor.a (classification primitives
  // ride on a translucent-friendly blend state).
  return vec4<f32>(outColor.rgb * outColor.a, outColor.a);
}

@fragment fn dsPickFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return u.pickColor;
}

// AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER) —
// CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW variant. Same VS + sky-discard
// as the color path; the pipeline disables color writes (writeMask=0) and
// enables stencil-write so the only side-effect is marking stencil=0xff
// on every classified-surface pixel the volume covers. The composite
// (WebGPUInvertClassification's classifiedPipeline / unclassifiedPipeline)
// reads those bits to gate which tile pixels get the invert tint.
@fragment fn dsStencilFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return vec4<f32>(0.0);
}

// Batch 164 -- A.4 NEW-CLASSIFIER-2D-CV-MORPH morph pipeline. Mirrors
// the WebGL appearance3DMorph flow -- consumes BOTH the 3D ECEF and
// 2D-projected position attribute sets and blends EC-space positions
// by morphFlags.x (morphTime). The 2D positions ride at locations
// 2/3 with the same stride layout as the 3D pair; the JS side
// interleaves 12 bytes per attribute pair into a 24-byte vertex
// stream that the buffer layout decodes into pH/pL/pH2D/pL2D.
//
// Coordinate convention: the 2D positions follow Cesium's projected
// frame where the X-axis is the projection's altitude and (Y, Z) are
// the planar pair -- matching WebGPUGroundPolylineRenderer.vsMorph,
// hence the .zxy swizzle on the 2D pair before feeding it to the
// shared translateRelativeToEye math. Without the swizzle the
// 2D-projected lat/lon land in the wrong axes and the volume floats
// off the projected surface during the morph.
@vertex fn morphColorVS(
  @location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>,
  @location(2) pH2D: vec3<f32>, @location(3) pL2D: vec3<f32>,
) -> CO {
  var o: CO;
  let morphTime = u.morphFlags.x;
  let rte3D = (pH - u.camH) + (pL - u.camL);
  let rte2D = (pH2D.zxy - u.camH) + (pL2D.zxy - u.camL);
  let posEc3D = (u.mvRTE * vec4<f32>(rte3D, 1.0)).xyz;
  let posEc2D = (u.mvRTE * vec4<f32>(rte2D, 1.0)).xyz;
  // Blend EC positions by morphTime, then project. Matches WebGL
  // appearance3DMorph and WebGPUGroundPolylineRenderer.vsMorph.
  let posEc = mix(posEc2D, posEc3D, morphTime);
  o.pos = csm_depthClamp(u.proj * vec4<f32>(posEc, 1.0));
  o.col = u.color;
  return o;
}

// NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — velocity entry
// points for TAA. GroundPrimitive volumes have static per-feature
// geometry, so velocity is camera-only: project the SAME world-space
// position (high+low encoded position) through both the current vpRTE
// (matching colorVS) and the previous full VP, emit (currNdc - prevNdc)
// to the rg16float velocity texture. Mirrors the Voxel pattern (Batch
// 173) and the Vector3DTile classifier sweep (Batches 178-179).
//
// Coverage parity: the velocity VS uses the SAME csm_depthClamp + mvpRTE
// math as colorVS so the rasterized fragment positions match exactly —
// no half-pixel offsets in the emitted velocity vectors. The VS DOES
// NOT replicate the morphColorVS path; velocity emission is suppressed
// during MORPHING by the JS-side gating in createWebGPUGroundPrimitiveCommands
// (TAA during scene-mode morph is rare; the camera-only fallback in
// the velocity-pass is correct for static-geometry transitions).
struct VelocityCO {
  @builtin(position) pos: vec4<f32>,
  @location(0) currClip: vec4<f32>,
  @location(1) prevClip: vec4<f32>,
};

@vertex fn vsVelocity(
  @location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>,
) -> VelocityCO {
  // Current frame: identical to colorVS so the velocity-pass
  // rasterization matches the color pass fragment-for-fragment.
  // Mode-conditional swizzle matches colorVS (see comment there);
  // SCENE3D keeps unswizzled ECEF, SCENE2D / CV swizzles position2D
  // (projX, projY, height) -> (height, projX, projY) before RTE.
  let is3D = u.morphFlags.x;
  let pHm = mix(pH.zxy, pH, vec3<f32>(is3D));
  let pLm = mix(pL.zxy, pL, vec3<f32>(is3D));
  let rte = (pHm - u.camH) + (pLm - u.camL);
  let curClip = csm_depthClamp(u.mvpRTE * vec4<f32>(rte, 1.0));
  // Previous frame: project the world-space position (high + low,
  // simple sum is fine here because pH/pL are SOA-encoded high/low
  // bits of an absolute world position — adding them recovers the
  // original world coordinates) through prev VP. The csm_depthClamp
  // is intentionally NOT applied to prev — the clamp affects clip-z,
  // and velocity derives from clip-x/y/w; the omission is benign and
  // saves the helper call on the prev path.
  let worldPosRaw = pHm + pLm;
  let prClip = u.prevViewProjection * vec4<f32>(worldPosRaw, 1.0);
  var o: VelocityCO;
  o.pos = curClip;
  o.currClip = curClip;
  o.prevClip = prClip;
  return o;
}

@fragment fn fsVelocity(i: VelocityCO) -> @location(0) vec2<f32> {
  let curW = i.currClip.w;
  let prevW = i.prevClip.w;
  // Behind-near-plane fragments contribute zero velocity — TAA will
  // treat the pixel as static and reuse history without reprojection.
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = i.currClip.xy / curW;
  let prevNdc = i.prevClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

  const mod = getGroundPrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.GROUND_PRIMITIVE,
    code,
    0,
    "GroundPrimitive",
  );
  const bgl = makeBindGroupLayout(device, "GroundPrimitive BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);

  // Depth-sample BGL + 2-group pipeline layout. Group 0 carries the
  // per-primitive uniforms; group 1 carries the depth texture + sampler.
  // Bound late at draw time via WebGPUDrawCommand.bindGroupResolvers so
  // per-frustum source swaps don't require rebuilding the command.
  const depthSampleBgl = makeBindGroupLayout(
    device,
    "GroundPrimitive DepthSample BGL",
    [
      textureEntry(0, Stage.FRAGMENT, { sampleType: "float" }),
      samplerEntry(1, Stage.FRAGMENT, "filtering"),
    ],
  );
  // NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — group 2:
  // per-slice frustum state (invProj + near/far). FRAGMENT-only (only the
  // depth-sample FS reads it). Bound per-slice at draw time via the
  // frustum-state bind-group resolver. Every GroundPrimitive pipeline
  // (color / pick / stencil / morph / velocity) shares `depthSampleLayout`,
  // so they all gain this third group; the pick / stencil / velocity FS
  // don't read it but a bound-unused group is valid.
  const frustumStateBgl = makeBindGroupLayout(
    device,
    "GroundPrimitive FrustumState BGL",
    [uniformBuffer(0, Stage.FRAGMENT)],
  );
  const depthSampleLayout = device.createPipelineLayout({
    label: "GroundPrimitive DepthSample PipelineLayout",
    bindGroupLayouts: [bgl, depthSampleBgl, frustumStateBgl],
  });

  const vertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    },
  ];

  // Batch 164 — A.4 morph layout: two simultaneous vertex buffers, each
  // with a (high, low) RTE pair. Buffer 0 carries 3D ECEF positions
  // (locations 0/1 — same as the non-morph pipeline so the JS side
  // reuses the same `position3DHigh/Low` interleave). Buffer 1 carries
  // the projected 2D positions (locations 2/3). Only used during
  // SCENE_MODE.MORPHING; the non-morph pipelines bind a single buffer.
  const morphVertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    },
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 2, offset: 0, format: "float32x3" },
        { shaderLocation: 3, offset: 12, format: "float32x3" },
      ],
    },
  ];

  // Color pipeline — single pass, samples depth in the fragment shader
  // and discards where depth is 0. Layout uses both BGLs (per-primitive
  // uniforms in @group(0), depth source in @group(1)). depthStencil
  // retains less-equal for early rejection of fragments beyond the
  // volume's far face but does not configure stencil — the depth-sample
  // path doesn't read or write the stencil bits, so the attachment's
  // stencil aspect remains untouched (other passes still read it for
  // InvertClassification etc.).
  // Batch 134 — scene-FB color pipelines bake MSAA sample count.
  const msState = sampleCount > 1 ? { count: sampleCount } : undefined;
  const depthSampleColorDescriptor = {
    name: `GroundPrimitive depthSampleColor [${format}/${depthFormat}/ms=${sampleCount ?? 1}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsColorFS",
      // Slice 5c-B Phase 1 (Batch 111) — scene-FB color target via
      // helper. Standard alpha-over blend → `translucent: true`
      // shorthand.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: msState,
  };

  const depthSamplePickDescriptor = {
    name: `GroundPrimitive depthSamplePick [${format}/${depthFormat}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsPickFS",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // No `multisample` — the pick variant renders into the single-sample
    // 1-target WebGPU pick framebuffer (matching the GroundPolyline
    // pickDescriptor). It must NOT bind in the MSAA 2-target MRT scene
    // pass; that's enforced at the dispatch site, not here.
  };

  // AUDIT_2026_05_02 A.2 (Batch 141) — IGNORE_SHOW stencil-write variant.
  // Color writes disabled (writeMask=0); the pipeline runs solely to mark
  // the invert FBO's stencil with 0xff on classified pixels. The
  // stencilReference value is set per-draw via
  // `applyPerEncoderState({ stencilTest: { reference: 0xff } })`.
  const depthSampleStencilDescriptor = {
    name: `GroundPrimitive depthSampleStencil [${format}/${depthFormat}/ms=${sampleCount ?? 1}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsStencilFS",
      targets: [{ format, writeMask: 0 }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
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
    },
    // Batch 134 — stencil-only pipeline still runs in the MSAA scene pass.
    multisample: msState,
  };

  // Batch 164 — A.4 NEW-CLASSIFIER-2D-CV-MORPH morph color pipeline.
  // Two-buffer vertex layout (3D + 2D position pairs); same fragment
  // shader as the non-morph color path — the morph blend lives in the
  // VS so the FS just samples globe depth and emits per-instance color.
  // Color targets, blend, depth-stencil, and the pipeline layout all
  // mirror `depthSampleColorDescriptor` so the cache key only differs
  // by `vertex.entryPoint` + `vertex.buffers`.
  const morphColorDescriptor = {
    name: `GroundPrimitive morphColor [${format}/${depthFormat}/ms=${sampleCount ?? 1}]`,
    layout: depthSampleLayout,
    vertex: {
      module: mod,
      entryPoint: "morphColorVS",
      buffers: morphVertexBuffers,
    },
    fragment: {
      module: mod,
      entryPoint: "dsColorFS",
      // Slice 5c-B Phase 1 (Batch 111) — scene-FB color target via
      // helper. Standard alpha-over blend → `translucent: true`
      // shorthand.
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: msState,
  };

  const morphPickDescriptor = {
    name: `GroundPrimitive morphPick [${format}/${depthFormat}]`,
    layout: depthSampleLayout,
    vertex: {
      module: mod,
      entryPoint: "morphColorVS",
      buffers: morphVertexBuffers,
    },
    fragment: {
      module: mod,
      entryPoint: "dsPickFS",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    // No `multisample` — single-sample 1-target pick FBO (see
    // depthSamplePickDescriptor).
  };

  // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — velocity
  // pipeline. Same pipeline layout (depth-sample BGL pair) as the color
  // pipeline so bind groups are reused; single rg16float color target,
  // no blend, depth read-only. Only the non-morph variant is built —
  // velocity emission is suppressed during MORPHING by the JS-side
  // gating (TAA during scene-mode morph is rare).
  const velocityDescriptor = {
    name: `GroundPrimitive velocity [${depthFormat}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "vsVelocity", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "fsVelocity",
      targets: [{ format: "rg16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };

  return {
    depthSampleColorDescriptor,
    depthSamplePickDescriptor,
    depthSampleStencilDescriptor,
    morphColorDescriptor,
    morphPickDescriptor,
    velocityDescriptor,
    bgl,
    depthSampleBgl,
    frustumStateBgl,
  };
}

/**
 * Convert a `WebGPURenderPipelineDescriptor` (cache-friendly shape) back
 * into the WebGPU descriptor for the synchronous fallback path. Only
 * called when the central pipeline cache isn't available — preserves the
 * historical behavior for legacy callers.
 * @private
 */
function descriptorToGPU(d) {
  return {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    fragment: d.fragment
      ? {
          module: d.fragment.module,
          entryPoint: d.fragment.entryPoint,
          targets: d.fragment.targets,
        }
      : undefined,
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
}

/**
 * Resolve the stencil + color + pick pipelines through the central
 * pipeline cache. If the cache isn't available, falls back to direct
 * synchronous `device.createRenderPipeline()`. Returns true once all
 * three pipelines are materialized; returns false on the first frame
 * after async creation kicks off so the caller can skip the draw and
 * try again next tick.
 *
 * C-R7-RENDERER-MIGRATION (Batch 58). Mirrors the
 * `tryResolveEllipsoidPipelines` pattern from Batch 56.
 * @private
 */
function tryResolveGroundPrimitivePipelines(
  device,
  pipelineCache,
  resources,
  cache,
) {
  if (
    cache.depthSampleColorPipeline &&
    cache.depthSamplePickPipeline &&
    cache.depthSampleStencilPipeline
  ) {
    return true;
  }

  if (pipelineCache) {
    const dsColorSync = pipelineCache.getPipelineSync(
      resources.depthSampleColorDescriptor,
    );
    const dsPickSync = pipelineCache.getPipelineSync(
      resources.depthSamplePickDescriptor,
    );
    const dsStencilSync = pipelineCache.getPipelineSync(
      resources.depthSampleStencilDescriptor,
    );
    // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — velocity
    // pipeline resolved alongside color/pick/stencil. Cache miss is
    // non-fatal: color path continues to render correctly without it;
    // velocity-pass dispatch becomes a no-op until the variant lands.
    const dsVelocitySync = pipelineCache.getPipelineSync(
      resources.velocityDescriptor,
    );
    if (dsColorSync && dsPickSync && dsStencilSync) {
      cache.depthSampleColorPipeline = dsColorSync;
      cache.depthSamplePickPipeline = dsPickSync;
      cache.depthSampleStencilPipeline = dsStencilSync;
      cache.velocityPipeline = dsVelocitySync ?? null;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.depthSampleColorDescriptor),
        pipelineCache.getPipeline(resources.depthSamplePickDescriptor),
        pipelineCache.getPipeline(resources.depthSampleStencilDescriptor),
        pipelineCache.getPipeline(resources.velocityDescriptor),
      ])
        .then(([dsColor, dsPick, dsStencil, dsVelocity]) => {
          cache.depthSampleColorPipeline = dsColor;
          cache.depthSamplePickPipeline = dsPick;
          cache.depthSampleStencilPipeline = dsStencil;
          cache.velocityPipeline = dsVelocity;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          // Errors already logged by the cache; clear the in-flight flag
          // so the next frame retries.
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache (e.g. WebGL-backed graphics context, or
  // pre-init state). Mirror the historical synchronous path.
  cache.depthSampleColorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSampleColorDescriptor),
  );
  cache.depthSamplePickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSamplePickDescriptor),
  );
  cache.depthSampleStencilPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSampleStencilDescriptor),
  );
  // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — fallback path.
  cache.velocityPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.velocityDescriptor),
  );
  return true;
}

/**
 * Batch 164 — A.4 morph pipelines, resolved lazily on the first
 * MORPHING frame so non-morphing scenes don't pay the cache hit.
 * Mirrors `tryResolveGroundPrimitivePipelines` for the morph
 * descriptor pair.
 * @private
 */
function tryResolveGroundPrimitiveMorphPipelines(
  device,
  pipelineCache,
  resources,
  cache,
) {
  if (cache.morphColorPipeline && cache.morphPickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const morphColorSync = pipelineCache.getPipelineSync(
      resources.morphColorDescriptor,
    );
    const morphPickSync = pipelineCache.getPipelineSync(
      resources.morphPickDescriptor,
    );
    if (morphColorSync && morphPickSync) {
      cache.morphColorPipeline = morphColorSync;
      cache.morphPickPipeline = morphPickSync;
      cache.morphPipelineRequestPending = false;
      return true;
    }
    if (!cache.morphPipelineRequestPending) {
      cache.morphPipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.morphColorDescriptor),
        pipelineCache.getPipeline(resources.morphPickDescriptor),
      ])
        .then(([morphColor, morphPick]) => {
          cache.morphColorPipeline = morphColor;
          cache.morphPickPipeline = morphPick;
          cache.morphPipelineRequestPending = false;
        })
        .catch(() => {
          cache.morphPipelineRequestPending = false;
        });
    }
    return false;
  }

  cache.morphColorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.morphColorDescriptor),
  );
  cache.morphPickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.morphPickDescriptor),
  );
  return true;
}

function packUniforms(
  data,
  frameState,
  modelMatrix,
  color,
  pickColor,
  primitive,
) {
  const uniformState = frameState.context.uniformState;
  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, data, 0);

  // RTE camera encoding. `camera.positionWC` is the right source for ALL
  // modes — in SCENE2D / COLUMBUS_VIEW the camera frame's `actualTransform`
  // (TRANSFORM_2D) maps the local position into ENU `(altitude, projX, projY)`
  // space, which is what the 2D view matrix consumes. The position2D
  // attributes are stored unswizzled as `(projX, projY, height)`; the WGSL
  // VS applies a mode-conditional `.zxy` swizzle (matching WebGL's
  // `czm_translateRelativeToEye(...zxy, ...zxy)` convention at line 291 of
  // PrimitiveShaderHelpers.js) so the RTE subtraction is well-formed.
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

  data[24] = color?.red ?? 1.0;
  data[25] = color?.green ?? 0.0;
  data[26] = color?.blue ?? 0.0;
  data[27] = color?.alpha ?? 0.5;

  // C-R9 (Batch 31) — pickColor slot (floats 28-31). Defaults to zero
  // when no pick ID has been registered yet; the pick pass skips the
  // draw in that case so the zeros never reach the pick FBO.
  data[28] = pickColor?.red ?? 0.0;
  data[29] = pickColor?.green ?? 0.0;
  data[30] = pickColor?.blue ?? 0.0;
  data[31] = pickColor?.alpha ?? 0.0;

  // Viewport (floats 32-35). The depth-sample FS divides
  // `@builtin(position).xy` by viewport.zw to recover the screen-space
  // UV used to fetch globe depth. Source from `context.drawingBufferWidth/
  // Height` directly: `uniformState.viewportCartesian4` is zero-initialized
  // until per-frame viewport is established, but FRs run during Scene
  // primitive update — BEFORE that. `?? drawingBufferWidth` doesn't fall
  // through on 0 (only nullish), so the original code shipped 0/0 viewport
  // → screenUV = NaN → depth sample returns 0 → universal discard
  // (silent rendering failure). Bug-pattern hunt 2026-04-30 — same root
  // cause as the GroundPolyline silent-invisible bug fixed in Batch 117.
  const ctx = frameState.context;
  data[32] = 0.0;
  data[33] = 0.0;
  data[34] = ctx?.drawingBufferWidth || 1;
  data[35] = ctx?.drawingBufferHeight || 1;

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at floats
  // 36..51. UniformState swaps `_previousViewProjection := viewProjection`
  // at the END of `update()` AFTER returning the prior frame's value, so
  // on frame N this slot holds frame N-1's VP. First frame falls through
  // to identity.
  const prevVP = uniformState.previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 36);
  } else {
    data[36] = 1;
    data[37] = 0;
    data[38] = 0;
    data[39] = 0;
    data[40] = 0;
    data[41] = 1;
    data[42] = 0;
    data[43] = 0;
    data[44] = 0;
    data[45] = 0;
    data[46] = 1;
    data[47] = 0;
    data[48] = 0;
    data[49] = 0;
    data[50] = 0;
    data[51] = 1;
  }

  // Batch 164 — A.4 NEW-CLASSIFIER-2D-CV-MORPH morph fields.
  //
  // floats 52..67 — `mvRTE` — model-view RTE (translation zeroed).
  //   Read by `morphColorVS` to project both the 3D and 2D
  //   position attributes through the morph-state view (then blends
  //   in EC space). For the non-morph paths this slot is don't-care
  //   because `colorVS` only reads `mvpRTE`.
  //
  // floats 68..83 — `proj` — projection matrix.
  //   Final projection after the EC-space morph blend.
  //
  // floats 84..87 — `morphFlags` — .x = morphTime
  //   (1.0 = full SCENE3D, 0.0 = full SCENE2D / Columbus View,
  //   fractional during MORPHING).
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.pack(scratchMVRTE, data, 52);
  Matrix4.clone(uniformState.projection, scratchProjection);
  Matrix4.pack(scratchProjection, data, 68);
  // SceneMode 3D = 1.0, MORPHING = frameState.morphTime ∈ [0, 1]
  // (1.0 = full 3D, 0.0 = full 2D), SCENE2D / COLUMBUS_VIEW = 0.0.
  // `morphTime` is canonical on `frameState` (FrameState.js:98 init,
  // updated by `Scene.morphComplete*` listeners); `uniformState`
  // doesn't carry it directly. Non-morph scenes leave this stale,
  // which is fine — only `morphColorVS` reads it.
  data[84] = frameState?.morphTime ?? 0.0;
  data[85] = 0.0;
  data[86] = 0.0;
  data[87] = 0.0;

  // NEW-GROUNDPRIM-TEXTURED-MATERIALS (Batch 171) — material dispatch slots.
  //
  // invProj (floats 88..103) — inverse projection, mode-correct
  // (uniformState.inverseProjection is rebuilt every frame from the active
  // SceneMode's projection). Used by `windowToEye` in the FS.
  Matrix4.pack(uniformState.inverseProjection, data, 88);

  // Resolve material state. The Color (type 0) path skips planar-extent
  // packing because dsColorFS short-circuits to `i.col` — no UV / no
  // dot-product / no FS-side dispatch. Stripe / Checkerboard / Grid all
  // need the extents; pack them OR fall back to Color if the primitive
  // lacks the planar-extent attributes (spherical path or missing).
  const materialState = primitive ? resolveMaterialState(primitive) : null;
  const matType = materialState?.type ?? 0;
  if (matType !== 0 && primitive) {
    const haveExtents = packExtents(data, primitive, frameState);
    if (!haveExtents) {
      // No extents at all — fall back to Color so the primitive still
      // classifies (just as flat color). Logged once via the
      // resolveMaterialState's custom-material path.
      data[104] = 0.0;
    } else {
      data[104] = matType;
    }
  } else {
    data[104] = 0.0;
  }
  data[105] = 0.0;
  data[106] = 0.0;
  data[107] = 0.0; // materialMeta.yzw

  // materialColor (floats 108..111).
  const mc = materialState?.color ?? [1.0, 1.0, 1.0, 1.0];
  data[108] = mc[0];
  data[109] = mc[1];
  data[110] = mc[2];
  data[111] = mc[3];
  // materialParam0 (floats 112..115).
  const mp0 = materialState?.param0 ?? [0.0, 0.0, 0.0, 0.0];
  data[112] = mp0[0];
  data[113] = mp0[1];
  data[114] = mp0[2];
  data[115] = mp0[3];
  // materialParam1 (floats 116..119).
  const mp1 = materialState?.param1 ?? [0.0, 0.0, 0.0, 0.0];
  data[116] = mp1[0];
  data[117] = mp1[1];
  data[118] = mp1[2];
  data[119] = mp1[3];

  // Extents (floats 120..155) — packExtents wrote these if the material
  // path is active. Zero them out otherwise so the FS dispatch reading
  // them gets deterministic safe values (dsColorFS's fast path won't
  // even touch them when matType==0).
  if (matType === 0 || !primitive) {
    for (let i = 120; i <= 155; i++) {
      data[i] = 0.0;
    }
  }

  // frustum.xy = (near, far) of the CURRENT frustum slice. Pulled from
  // uniformState.currentFrustum which Cesium updates per-frustum-band
  // during multi-frustum rendering. Used by windowToEye to reverse log
  // depth back to linear distance-from-camera. Pack unconditionally
  // (cheap; the dsColorFS fast path skips reading it when matType=0).
  const cf = uniformState.currentFrustum;
  data[156] = cf?.x ?? 0.1; // near
  data[157] = cf?.y ?? 1.0e8; // far
  data[158] = 0.0;
  data[159] = 0.0;
}

/**
 * Creates WebGPU commands for a GroundPrimitive.
 * Returns both stencil and color commands.
 */
function createWebGPUGroundPrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  // AUDIT_2026_05_02 A.4 (Batch 150 conservative gate, narrowed in
  // Batch 156, narrowed further in Batch 157, MORPHING lifted in
  // Batch 164) — SCENE2D + COLUMBUS_VIEW use the per-vertex
  // `position2DHigh/Low` attributes that `PrimitivePipeline.js:175-208`
  // produces alongside the 3D positions. With both encoded into the
  // same coordinate space as the active `uniformState.view * projection`
  // and `camera.positionWC`, the existing RTE math at `colorVS`
  // produces correct classification volumes. MORPHING now routes
  // through the dedicated `morphColorVS` (Batch 164) which consumes
  // BOTH attribute sets and blends EC-space positions by
  // `uniformState.morphTime`.
  //
  // SCENE2D / COLUMBUS_VIEW classification (Batch 170 — NEW-CLASSIFIER-
  // GROUNDPRIM-2D-RTE RESOLVED).
  //
  // History:
  //   - Batch 156 added the `position2DHigh/Low` attribute pair.
  //   - Batch 164 added the morph VS so MORPHING blends 3D ↔ 2D in EC space.
  //   - Batch 167 unblocked 2D by dropping the 3D-ECEF bounding-volume cull
  //     for globe + publishing globe depth in non-3D modes.
  //   - Batch 169 removed the over-broad `_needs2DShader` silent-skip
  //     (this renderer is FLAT COLOR only — `packUniforms` reads
  //     `appearance.material.uniforms.color`; no UV / extents / texture
  //     sampling in any mode — so it does NOT need WebGL's `appearance2D`
  //     in 2D).
  //   - Batch 170 fixed the LAST blocker: coordinate-frame mismatch
  //     between `position2DHigh/Low` (stored as `(projX, projY, height)`,
  //     the natural output of `mapProjection.project()` in
  //     `GeometryPipeline.projectTo2D`) and `camera.positionWC` (which
  //     in SCENE2D / CV is in the camera's ENU frame
  //     `(altitude, projX, projY)` — produced by `TRANSFORM_2D` in
  //     `CameraInternals.updateMembers`). The RTE subtraction
  //     `position2D − cameraENU` was mixing component orderings — across
  //     a single Mercator extent (`±π * semimajorAxis` ≈ ±20M m) the
  //     misalignment shoved the volume off-screen.
  //     Fix: mirror WebGL's `czm_translateRelativeToEye(pos2D.zxy, ...)`
  //     pattern from PrimitiveShaderHelpers.js:291. The non-morph
  //     `colorVS` (and the `vsVelocity` clone) now apply a
  //     mode-conditional `.zxy` swizzle to the bound positions
  //     (gated by `morphFlags.x` — 1.0 = SCENE3D no-swizzle,
  //     0.0 = SCENE2D / CV swizzle) so the RTE math composes in ENU
  //     space matching the view matrix and the encoded camera. No JS
  //     change needed; positionWC is already in the right frame.
  //     The MORPHING path was already correct (Batch 164 morphColorVS
  //     applies the same swizzle at .zxy).
  //
  // Remaining 2D follow-up: textured-material detail (`appearance2D` UVs +
  // extents) tracked as NEW-GROUNDPRIM-TEXTURED-MATERIALS — orthogonal to
  // flat-color classification.
  const sceneMode = frameState?.mode;
  const isNon3D = sceneMode !== SceneMode.SCENE3D;
  const isMorphing = sceneMode === SceneMode.MORPHING;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {};
  }
  const cache = primitive._webgpuCache;

  // C-R7-RENDERER-MIGRATION (Batch 58) — build the BGL + pipeline-layout
  // + shader module + pipeline descriptors once, then route the actual
  // pipeline creation through `context.webgpuPipelineCache`. The
  // descriptors and shader module are stashed on the cache so the async
  // resolver can re-poll across frames until pipelines materialize.
  // Batch 110 — invalidate cached pipeline resources on scene format
  // change (HDR toggle). Pre-Batch-166 the cached pipeline OBJECTS
  // weren't cleared alongside `_pipelineResources` and `bgl` —
  // `tryResolveGroundPrimitivePipelines` early-returned on the
  // truthy slot check and left stale-format pipelines bound. WebGPU
  // would then reject the draw at submission because the bound
  // pipeline's color target format didn't match the active attachment.
  // Vector3DTile* renderers already had this pattern (see
  // WebGPUVector3DTilePrimitiveRenderer.js:796-801); GroundPrimitive
  // was the outlier.
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache._pipelineResources) &&
    cache._pipelineFormatGeneration !== sceneGen
  ) {
    cache._pipelineResources = undefined;
    cache.bgl = undefined;
    // Clear cached pipeline objects so the resolvers re-run against
    // the new resources / format. Both the standard depth-sample trio
    // and Batch 164's morph pair need clearing.
    cache.depthSampleColorPipeline = undefined;
    cache.depthSamplePickPipeline = undefined;
    cache.depthSampleStencilPipeline = undefined;
    cache.morphColorPipeline = undefined;
    cache.morphPickPipeline = undefined;
    // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — clear the
    // velocity pipeline alongside the others on format change. Mirrors
    // the Batch 176 audit fix on splats and the Batch 179 fix on
    // Vector3DTile{Polylines,ClampedPolylines}.
    cache.velocityPipeline = undefined;
    // Bind groups reference the old BGL which is now stale.
    cache.bindGroup = undefined;
    cache.depthSampleBindGroup = undefined;
    cache.depthSampleViewRef = undefined;
    // NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — the
    // frustum-state bind groups reference the old frustumStateBgl (the
    // whole _pipelineResources is rebuilt on format change), so drop them
    // too. The UBO buffers themselves are layout-agnostic but the bind
    // groups must be recreated against the new BGL; clear both so the
    // lazy `ensureFrustumStateSlot` rebuilds them.
    cache.frustumStateUBOs = undefined;
    cache.frustumStateBindGroups = undefined;
    cache.frustumStateBindGroup = undefined;
    // Reset pending-request flags so the resolvers can re-issue.
    cache.pipelineRequestPending = false;
    cache.morphPipelineRequestPending = false;
  }

  if (!defined(cache._pipelineResources)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const sampleCount = context._msaaSamples ?? 1;
    cache._pipelineResources = buildGroundPipelineResources(
      device,
      format,
      depthFmt,
      sampleCount,
    );
    cache.bgl = cache._pipelineResources.bgl;
    cache.pipelineRequestPending = false;
    cache._pipelineFormatGeneration = sceneGen;
  }

  // Resolve stencil + color + pick through the central cache. On the
  // first frame this kicks off async creation and returns false, so we
  // skip the draw rather than enqueue commands referencing null
  // pipelines. Subsequent frames pick up the cached objects synchronously.
  if (
    !tryResolveGroundPrimitivePipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return {
      stencilPipeline: null,
      colorPipeline: null,
      pickPipeline: null,
      bindGroup: cache.bindGroup ?? null,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  // Batch 164 — A.4 morph pipelines, resolved lazily on the first
  // MORPHING frame and cached thereafter. Same first-frame skip
  // contract as the non-morph resolver above.
  if (
    isMorphing &&
    !tryResolveGroundPrimitiveMorphPipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return {
      stencilPipeline: null,
      colorPipeline: null,
      pickPipeline: null,
      bindGroup: cache.bindGroup ?? null,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "GroundPrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
    cache.bindGroup = device.createBindGroup({
      layout: cache.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
      ],
    });
  }

  const modelMatrix = primitive.modelMatrix || Matrix4.IDENTITY;
  const color = primitive.appearance?.material?.uniforms?.color;

  // C-R9 (Batch 31 / refactored Batch 59) — pick ID lifecycle delegated
  // to {@link ensurePickId}. Mirrors WebGL's `Scene/GroundPrimitive.js`
  // pickId lifecycle; cache slot is the primitive itself so existing
  // `_pickId` / `_pickIdLastId` references keep working.
  const passes = frameState.passes;
  const allowAllocate = !!(passes && (passes.pick || passes.render));
  const pickId = ensurePickId(primitive, context, primitive, {
    allowAllocate,
  });
  const pickColor = pickId?.color;

  packUniforms(
    cache.uniformData,
    frameState,
    modelMatrix,
    color,
    pickColor,
    primitive,
  );
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Build actual draw commands if vertex data is available.
  //
  // Migration Session 1 (Batch 81) — `_webgpuGeometryData` is populated
  // by `Scene/PrimitiveGeometryHelpers.js:788` on the innermost Cesium
  // `Primitive`. The wrapping chain for a GroundPrimitive is:
  //   `_GroundPrimitive` → `._primitive` (`ClassificationPrimitive`) →
  //   `._primitive` (`Primitive`) → `._webgpuGeometryData` (array).
  // Walk the chain to find the slot. Direct callers that wire the
  // renderer against a `Primitive` or `ClassificationPrimitive` work
  // through the same lookup with shorter chains.
  //
  // The producer-side hook lives in the existing `Primitive.update` →
  // `createVertexArray` flow in PrimitiveGeometryHelpers — no new
  // populator was needed for ClassificationPrimitive because it
  // delegates to a Primitive at construction time
  // (`ClassificationPrimitive.js:417`). What WAS missing was the
  // walk-the-chain lookup on the renderer side, plus the correct
  // attribute extraction at `_webgpuGeometryData[g].attributes
  // .position3DHigh.values` (the slot Migration Session 1 added).
  //
  // First-cut handles only `_webgpuGeometryData[0]`. Multi-geometry
  // primitives (rare for GroundPrimitive — typically one rectangle /
  // polygon per primitive) are tracked as a follow-up.
  const geomDataArray =
    primitive._webgpuGeometryData ??
    primitive._primitive?._webgpuGeometryData ??
    primitive._primitive?._primitive?._webgpuGeometryData;
  if (!defined(geomDataArray) || geomDataArray.length === 0) {
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }
  const geomData = geomDataArray[0];
  // AUDIT_2026_05_02 A.4 (Batch 156, hardened in Batch 157) — pick the
  // position-attribute set that matches the active scene mode.
  // `PrimitivePipeline.js:175-208` produces BOTH `position3DHigh/Low`
  // (always) AND `position2DHigh/Low` (only when scene mode is non-3D).
  // In SCENE3D the 2D set is absent; in SCENE2D / COLUMBUS_VIEW the 2D
  // set is the one whose coordinate system matches
  // `uniformState.view × projection` and `camera.positionWC` (CesiumJS
  // adjusts the camera position to the active scene mode), so RTE
  // math composes correctly without shader changes.
  //
  // Strict — no `?? position3DHigh` fallback in non-3D modes. A
  // primitive that lacks `position2DHigh/Low` while running in
  // SCENE2D / CV would project 3D ECEF coords through the 2D VP
  // matrix and draw garbage volumes (the exact failure mode that
  // Batch 150 originally added the conservative gate to prevent).
  // The `defined(...)` guard below catches this and returns null
  // commands so the primitive silently skips that frame instead.
  // Batch 164 — three position-source modes:
  //   "3D"    : SCENE3D — bind only `position3DHigh/Low` (loc 0/1).
  //   "2D"    : SCENE2D / COLUMBUS_VIEW — bind only `position2DHigh/Low`
  //             (loc 0/1, swapped at the source-attribute level so the
  //             non-morph pipeline keeps reading from loc 0/1).
  //   "MORPH" : SCENE_MORPHING — bind BOTH 3D (loc 0/1) AND 2D (loc 2/3)
  //             so the morph VS can blend EC-space positions by
  //             `morphFlags.x` (uniformState.morphTime).
  const useNon3DPositions = isNon3D;
  const posHighAttr = useNon3DPositions
    ? geomData?.attributes?.position2DHigh
    : geomData?.attributes?.position3DHigh;
  const posLowAttr = useNon3DPositions
    ? geomData?.attributes?.position2DLow
    : geomData?.attributes?.position3DLow;
  // For MORPHING we need BOTH attribute sets — the primary `posHigh/LowAttr`
  // is the 3D side (loc 0/1), and we additionally consume 2D attributes
  // for the second vertex buffer.
  const morphPosHigh = isMorphing
    ? geomData?.attributes?.position3DHigh
    : posHighAttr;
  const morphPosLow = isMorphing
    ? geomData?.attributes?.position3DLow
    : posLowAttr;
  const morphPos2DHigh = isMorphing
    ? geomData?.attributes?.position2DHigh
    : undefined;
  const morphPos2DLow = isMorphing
    ? geomData?.attributes?.position2DLow
    : undefined;
  // Validation: morph requires both attribute sets; non-morph requires
  // exactly the active set. If either is missing we silent-skip the
  // frame rather than dispatch a half-bound pipeline.
  const primaryHigh = isMorphing ? morphPosHigh : posHighAttr;
  const primaryLow = isMorphing ? morphPosLow : posLowAttr;
  const morphAttrsValid =
    !isMorphing ||
    (defined(morphPos2DHigh?.values) &&
      defined(morphPos2DLow?.values) &&
      morphPos2DHigh.values.length === morphPos2DLow.values.length &&
      morphPos2DHigh.values.length === primaryHigh?.values?.length);
  if (
    !defined(primaryHigh?.values) ||
    !defined(primaryLow?.values) ||
    primaryHigh.values.length !== primaryLow.values.length ||
    !morphAttrsValid
  ) {
    //>>includeStart('debug', pragmas.debug);
    if (isMorphing) {
      oneTimeWarning(
        "WebGPUGroundPrimitive.missingMorphAttributes",
        "GroundPrimitive during MORPHING is missing one of `position3DHigh/Low` " +
          "or `position2DHigh/Low` (or the two pairs have mismatched lengths). " +
          "Silently skipping this frame. Tracked under A.4 / NEW-CLASSIFIER-2D-CV-MORPH.",
      );
    } else if (useNon3DPositions) {
      oneTimeWarning(
        "WebGPUGroundPrimitive.missing2DAttributes",
        "GroundPrimitive in non-3D scene mode has no `position2DHigh/Low` " +
          "attribute pair on its geometry — typically because the asset was " +
          "created with `scene3DOnly: true` or pre-projected positions. " +
          "Silently skipping this frame to avoid drawing 3D ECEF coords " +
          "through the 2D view-projection matrix.",
      );
    }
    //>>includeEnd('debug');
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }

  // Create vertex buffer(s). Single 24-byte/vertex stream for non-morph
  // modes; two parallel 24-byte streams for MORPHING (3D + 2D).
  //
  // AUDIT_2026_05_02 A.4 (Batch 156) — when the scene mode toggles
  // between 3D and 2D/CV (e.g. `scene.morphTo2D()` completes), the
  // cached vertex buffer was built from the wrong attribute set.
  // Track which key fed the cache and rebuild on flip. Batch 164
  // extends this to a third "MORPH" key with a parallel 2D buffer.
  const positionSourceKey = isMorphing
    ? "MORPH"
    : useNon3DPositions
      ? "2D"
      : "3D";
  if (cache.positionSourceKey !== positionSourceKey) {
    cache.vertexGPUBuffer?.destroy();
    cache.vertexGPUBuffer = undefined;
    cache.vertexGPUBuffer2D?.destroy();
    cache.vertexGPUBuffer2D = undefined;
    cache.positionSourceKey = positionSourceKey;
  }
  if (!defined(cache.vertexGPUBuffer)) {
    const numVerts = primaryHigh.values.length / 3;
    const interleaved = new Float32Array(numVerts * 6);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * 6;
      const src = v * 3;
      interleaved[dst] = primaryHigh.values[src];
      interleaved[dst + 1] = primaryHigh.values[src + 1];
      interleaved[dst + 2] = primaryHigh.values[src + 2];
      interleaved[dst + 3] = primaryLow.values[src];
      interleaved[dst + 4] = primaryLow.values[src + 1];
      interleaved[dst + 5] = primaryLow.values[src + 2];
    }
    // `WebGPUBuffer.createVertexBuffer(device, data, label)` writes the
    // data on its own; we don't follow up with a separate
    // `device.queue.writeBuffer` call. The legacy renderer's call site
    // had this wrong (passed `byteLength` as data), which contributed
    // to the silent breakage along with the broader geometry-plumbing
    // gap.
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved,
      `GroundPrimitive VB ${positionSourceKey}`,
    );
    cache.vertexCount = numVerts;
  }
  // Batch 164 — second vertex buffer for the morph pipeline. Same
  // 24-byte stride / interleave as the primary; lives at slot 1 in
  // the morph descriptor's `morphVertexBuffers`.
  if (isMorphing && !defined(cache.vertexGPUBuffer2D)) {
    const numVerts = morphPos2DHigh.values.length / 3;
    const interleaved = new Float32Array(numVerts * 6);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * 6;
      const src = v * 3;
      interleaved[dst] = morphPos2DHigh.values[src];
      interleaved[dst + 1] = morphPos2DHigh.values[src + 1];
      interleaved[dst + 2] = morphPos2DHigh.values[src + 2];
      interleaved[dst + 3] = morphPos2DLow.values[src];
      interleaved[dst + 4] = morphPos2DLow.values[src + 1];
      interleaved[dst + 5] = morphPos2DLow.values[src + 2];
    }
    cache.vertexGPUBuffer2D = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved,
      "GroundPrimitive VB MORPH-2D",
    );
  }

  // Create index buffer if indexed geometry. Auto-detect uint16 vs
  // uint32 from the maximum index value (matches
  // `WebGPUPrimitiveCommands.ensureIndexBuffer`).
  const indices = geomData.indices;
  if (defined(indices) && !defined(cache.indexGPUBuffer)) {
    let needsU32 = false;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > 0xffff) {
        needsU32 = true;
        break;
      }
    }
    const typed = needsU32
      ? new Uint32Array(indices)
      : new Uint16Array(indices);
    cache.indexFormat = needsU32 ? "uint32" : "uint16";
    cache.indexGPUBuffer = device.createBuffer({
      label: "GroundPrimitive IB",
      size: typed.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.indexGPUBuffer, 0, typed);
    cache.indexCount = indices.length;
  }

  // Pick the classification pass(es) based on `classificationType`.
  // ClassificationType: TERRAIN=0, CESIUM_3D_TILE=1, BOTH=2.
  // Pass enum:          TERRAIN_CLASSIFICATION=3, CESIUM_3D_TILE_CLASSIFICATION=6.
  // AUDIT_2026_05_02 A.3 (Batch 146) — emit one command per relevant
  // pass. Pre-fix, BOTH collapsed to CESIUM_3D_TILE_CLASSIFICATION only
  // (the comment in this file from Batch 81 acknowledged this as a
  // compromise). Now mirrors the same pass-list pattern used in
  // `WebGPUVector3DTilePrimitiveRenderer.js` (Batch 145) and
  // `WebGPUVector3DTileClampedPolylinesRenderer.js` (Batch 141 era).
  const classType = primitive?.classificationType ?? 0;
  const groundPasses = [];
  if (classType === 0 /* TERRAIN */ || classType === 2 /* BOTH */) {
    groundPasses.push(3 /* TERRAIN_CLASSIFICATION */);
  }
  if (classType === 1 /* CESIUM_3D_TILE */ || classType === 2 /* BOTH */) {
    groundPasses.push(6 /* CESIUM_3D_TILE_CLASSIFICATION */);
  }

  // Migration Session 5 — depth-sample is now the only classifier path.
  // Pick a depth source: prefer packed-translucent-depth (front-most
  // translucent surface) so classification volumes clip against
  // translucent 3D-tile surfaces; fall through to globe-depth when no
  // translucent tiles contributed depth this frame. Both views share
  // the same RGBA-packed format. The actual view is bound late at draw
  // time via `bindGroupResolvers` (Migration Session 3) so per-frustum
  // source swaps take effect within a frame.
  //
  // When neither view is published (first frame, viewport resize), no
  // commands are emitted — classification pixels are missing for that
  // frame, which is the trade for retiring the always-broken stencil
  // fallback. In steady state the classifier dispatches every frame.
  const packedTranslucentView = context._packedTranslucentDepthView ?? null;
  const globeDepthView = context._globeDepthView ?? null;
  const depthSourceView = packedTranslucentView ?? globeDepthView;
  if (!depthSourceView) {
    return {
      colorPipeline: cache.depthSampleColorPipeline,
      pickPipeline: cache.depthSamplePickPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
      // AUDIT_2026_05_02 A.3 (Batch 146) — array fields for BOTH support.
      // Empty arrays = no commands this frame (depth source not yet
      // published).
      colorCommands: [],
      pickCommands: [],
      ignoreShowCommand: null,
    };
  }

  if (!defined(cache.depthSampleSampler)) {
    cache.depthSampleSampler = device.createSampler({
      label: "GroundPrimitive depth-sample sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  if (
    !defined(cache.depthSampleBindGroup) ||
    cache.depthSampleViewRef !== depthSourceView
  ) {
    cache.depthSampleBindGroup = device.createBindGroup({
      label: "GroundPrimitive depth-sample BG",
      layout: cache._pipelineResources.depthSampleBgl,
      entries: [
        { binding: 0, resource: depthSourceView },
        { binding: 1, resource: cache.depthSampleSampler },
      ],
    });
    cache.depthSampleViewRef = depthSourceView;
  }

  // Per-frustum bind-group resolver (Migration Session 3 contract).
  // Each frustum updates `_packedTranslucentDepthView` / `_globeDepthView`
  // BEFORE its classification pass executes. The resolver picks up the
  // current values at draw time and rebuilds the bind group when the
  // source view ref has changed since the last call. Spans-frustum-
  // boundaries primitives get re-resolved per frustum.
  const resolveDepthSampleBindGroup = () => {
    const currentSource =
      context._packedTranslucentDepthView ?? context._globeDepthView;
    if (!currentSource) {
      return null; // fall through to static reference
    }
    if (cache.depthSampleViewRef !== currentSource) {
      cache.depthSampleBindGroup = device.createBindGroup({
        label: "GroundPrimitive depth-sample BG",
        layout: cache._pipelineResources.depthSampleBgl,
        entries: [
          { binding: 0, resource: currentSource },
          { binding: 1, resource: cache.depthSampleSampler },
        ],
      });
      cache.depthSampleViewRef = currentSource;
    }
    return cache.depthSampleBindGroup;
  };

  // NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — group-2
  // frustum-state UBO ring + per-slice bind-group resolver.
  //
  // The depth → eye recovery in `windowToEye` needs the projection of the
  // slice the fragment is drawn in, but `packUniforms` runs once per frame
  // (command-build) and can only capture one slice. Solve it the same way
  // the depth-source swap does: a bind-group resolver that runs per-draw.
  //
  // CRITICAL: distinct per-slice GPU buffers. `device.queue.writeBuffer`
  // is NOT ordered relative to the command encoder — every write in a
  // frame applies BEFORE the command buffer executes, last-wins. Writing
  // one shared buffer per slice would leave every slice reading the LAST
  // slice's projection. So slot the buffers by `_currentFrustumIndex`;
  // each slice writes its own buffer once, the command buffer binds the
  // matching buffer per slice. Buffers + bind groups are lazily grown.
  if (!defined(cache.frustumStateUBOs)) {
    cache.frustumStateUBOs = [];
    cache.frustumStateBindGroups = [];
    cache.frustumStateData = new Float32Array(20); // mat4(16) + vec4(4)
  }
  const ensureFrustumStateSlot = (idx) => {
    let ubo = cache.frustumStateUBOs[idx];
    if (!defined(ubo)) {
      ubo = WebGPUBuffer.createUniformBuffer(
        device,
        256,
        `GroundPrimitive FrustumState UBO slice ${idx}`,
      );
      cache.frustumStateUBOs[idx] = ubo;
      cache.frustumStateBindGroups[idx] = device.createBindGroup({
        label: `GroundPrimitive FrustumState BG slice ${idx}`,
        layout: cache._pipelineResources.frustumStateBgl,
        entries: [{ binding: 0, resource: { buffer: ubo.buffer } }],
      });
    }
    return idx;
  };
  const writeFrustumState = (idx, invProj, near, far) => {
    const data = cache.frustumStateData;
    for (let c = 0; c < 16; c++) {
      data[c] = invProj[c];
    }
    data[16] = near;
    data[17] = far;
    data[18] = 0.0;
    data[19] = 0.0;
    device.queue.writeBuffer(
      cache.frustumStateUBOs[idx].buffer,
      0,
      data.buffer,
      0,
      80, // mat4 (64B) + vec4 (16B)
    );
  };
  // Static fallback (slice 0) seeded from the once-per-frame uniformState
  // — used only if the per-slice publish is absent (resolver returns
  // null). Matches the pre-Batch-173 behaviour, so non-multi-frustum and
  // first-frame paths still get a valid (if not slice-refined) projection.
  ensureFrustumStateSlot(0);
  {
    const us = frameState.context.uniformState;
    const invProj0 = us.inverseProjection;
    const cf = us.currentFrustum;
    if (invProj0) {
      writeFrustumState(0, invProj0, cf?.x ?? 0.1, cf?.y ?? 1.0e8);
    }
    cache.frustumStateBindGroup = cache.frustumStateBindGroups[0];
  }
  const resolveFrustumStateBindGroup = () => {
    const invProj = context._currentFrustumInvProj;
    const nearFar = context._currentFrustumNearFar;
    if (!invProj || !nearFar) {
      return null; // fall through to the static slice-0 bind group
    }
    const idx = context._currentFrustumIndex | 0;
    ensureFrustumStateSlot(idx);
    writeFrustumState(idx, invProj, nearFar[0], nearFar[1]);
    return cache.frustumStateBindGroups[idx];
  };

  // C-R1-CLASSIFICATION (Batch 98) — forward the ClassificationPrimitive's
  // appearance render state so `applyPerEncoderState` runs the dynamic
  // stencilRef / blendConstant / scissor / viewport ops on the depth-sample
  // classifier draws. ClassificationPrimitive's `_appearance` exposes the
  // shared 3-pass renderState set (stencilDepth, color, pick) but the
  // depth-sample architecture (ADR-2026-04-28) collapses those into a single
  // pipeline + classifier shader pair, so here we forward the appearance's
  // top-level renderState (typically the color-pass state) and let the
  // pipeline handle stencil/blend behavior. Falls through to undefined for
  // primitives without an appearance.
  const classificationRS =
    primitive?.appearance?.renderState ??
    primitive?._primitive?.appearance?.renderState;

  // AUDIT_2026_05_02 A.3 (Batch 146) — emit one color (and optional
  // pick) command per relevant pass. The shared draw args are
  // identical across passes; only the `pass` enum differs. Each pick
  // command is attached to its sibling color command via
  // `attachPickToColorCommand` so the dispatcher's pick-pass swap
  // routes correctly. For BOTH (groundPasses.length === 2), this emits
  // two color and two pick commands per primitive.
  // Batch 164 — pipeline + vertex-buffer set picked by scene mode.
  // MORPHING uses the morph pair (consume both 3D + 2D streams,
  // blend EC-space positions in the VS by morphTime); non-morph
  // modes use the standard depth-sample pair (single stream).
  const activeColorPipeline = isMorphing
    ? cache.morphColorPipeline
    : cache.depthSampleColorPipeline;
  const activePickPipeline = isMorphing
    ? cache.morphPickPipeline
    : cache.depthSamplePickPipeline;
  const activeVertexBuffers = isMorphing
    ? [cache.vertexGPUBuffer, cache.vertexGPUBuffer2D]
    : [cache.vertexGPUBuffer];
  const sharedDrawArgs = {
    bindGroups: [
      cache.bindGroup,
      cache.depthSampleBindGroup,
      cache.frustumStateBindGroup,
    ],
    bindGroupResolvers: [
      undefined,
      resolveDepthSampleBindGroup,
      resolveFrustumStateBindGroup,
    ],
    vertexBuffers: activeVertexBuffers,
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    owner: primitive,
    renderState: classificationRS,
  };
  // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 180) — derive
  // velocity command alongside the FIRST color command per primitive
  // when TAA is on AND not in MORPHING (the velocity VS uses the
  // single-stream layout; morph would need its own velocity variant
  // matching the two-stream layout — deferred behind real demand for
  // TAA-during-morph). Per-feature animation isn't possible for static
  // ground classification volumes anyway, so one velocity command per
  // primitive is sufficient.
  const taaEnabled = frameState?.taaEnabled === true;
  const emitVelocity =
    taaEnabled && !isMorphing && defined(cache.velocityPipeline);
  // The velocity VS only consumes locations 0/1 (the 3D high/low
  // position pair), matching the single-stream non-morph layout. When
  // morph is active sharedDrawArgs.vertexBuffers carries two streams,
  // which would mismatch the velocity pipeline's single-buffer
  // expectation — thus the !isMorphing gate above.
  const velocityVertexBuffers = isMorphing ? null : [cache.vertexGPUBuffer];

  const colorCommands = [];
  const pickCommands = [];
  for (let p = 0; p < groundPasses.length; p++) {
    const passEnum = groundPasses[p];
    const colorCmd = new WebGPUDrawCommand({
      ...sharedDrawArgs,
      pipeline: activeColorPipeline,
      pass: passEnum,
    });
    if (emitVelocity && p === 0) {
      colorCmd.velocityCommand = new WebGPUDrawCommand({
        ...sharedDrawArgs,
        // Velocity uses the single-stream vertex buffer layout.
        vertexBuffers: velocityVertexBuffers,
        pipeline: cache.velocityPipeline,
        pass: passEnum,
      });
    }
    if (defined(pickColor)) {
      const pickCmd = new WebGPUDrawCommand({
        ...sharedDrawArgs,
        pipeline: activePickPipeline,
        pass: passEnum,
        pickOnly: true,
      });
      attachPickToColorCommand(colorCmd, pickCmd);
      pickCommands.push(pickCmd);
    }
    colorCommands.push(colorCmd);
  }
  // Stash the most-recent pick command for backwards compatibility with
  // any consumers that read `cache.pickCommand` directly.
  cache.pickCommand =
    pickCommands.length > 0 ? pickCommands[pickCommands.length - 1] : undefined;

  // AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER) —
  // emit a CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW command alongside the
  // color command for primitives that classify 3D Tiles. WebGPUSceneRenderer3DTilePasses
  // dispatches pass 7 inside the invert FBO before the regular CLASSIFICATION
  // pass; this command writes stencil=0xff on every classified-surface pixel
  // the volume covers so the stencil-gated composite can distinguish
  // classified vs unclassified regions. TERRAIN_CLASSIFICATION-only
  // primitives don't participate in invert classification — only emit
  // when 3D Tile classification is active (BOTH or CESIUM_3D_TILE).
  let ignoreShowCommand = null;
  // Batch 164 — skip the IGNORE_SHOW stencil-write during MORPHING.
  // The stencil pipeline binds the single-VB layout (loc 0/1 only),
  // but `sharedDrawArgs.vertexBuffers` carries two streams during
  // morph — WebGPU validates that bound buffer count matches the
  // pipeline's `vertex.buffers` length, so re-using it would fail.
  // Invert classification is a niche path; missing the IGNORE_SHOW
  // stencil mark for the brief morph window is acceptable. Closing
  // this gap fully would need a `morphStencilDescriptor` mirror
  // (cheap follow-up).
  if (groundPasses.includes(6) && !isMorphing) {
    ignoreShowCommand = new WebGPUDrawCommand({
      ...sharedDrawArgs,
      pipeline: cache.depthSampleStencilPipeline,
      pass: 7 /* CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW */,
      // Stencil reference 0xff — `applyPerEncoderState` reads
      // `stencilTest.reference` and calls `passEncoder.setStencilReference`
      // before the draw. Combined with the pipeline's `passOp: replace`,
      // every rasterized fragment marks stencil=0xff.
      renderState: { stencilTest: { reference: 0xff } },
    });
  }

  return {
    colorPipeline: cache.depthSampleColorPipeline,
    pickPipeline: cache.depthSamplePickPipeline,
    bindGroup: cache.bindGroup,
    // Sentinel — null `stencilCommand` tells the GroundPrimitive consumer
    // to push only `colorCommand(s)`. The legacy stencil 2-pass dispatch
    // shape is kept in the consumer for backwards-compat with any
    // future renderer that wants to emit a stencil pre-pass; in the
    // current depth-sample architecture it's always null.
    stencilCommand: null,
    // Backwards-compatible singular slots — point at the first / last
    // entry of the new arrays so any consumer still reading these keeps
    // working. `colorCommand` mirrors the FIRST color command (matches
    // the historical "single pass per primitive" shape for non-BOTH
    // cases, and is the TERRAIN command for BOTH if present, else the
    // 3D Tile command).
    colorCommand: colorCommands.length > 0 ? colorCommands[0] : null,
    pickCommand: cache.pickCommand,
    ignoreShowCommand,
    // AUDIT_2026_05_02 A.3 (Batch 146) — array-shaped slots. The
    // GroundPrimitive dispatch site iterates these so BOTH
    // classification primitives push two commands (TERRAIN + 3D Tile)
    // instead of one.
    colorCommands,
    pickCommands,
  };
}

function destroyWebGPUGroundPrimitiveResources(primitive) {
  const cache = primitive._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  // AUDIT_2026_05_02 A.4 (Batch 157 review fix) — release the geometry
  // GPU buffers. Previously leaked on primitive eviction; the per-frame
  // mode-flip path at line 768 already destroys+rebuilds the vertex
  // buffer correctly, but the once-per-lifetime destroy path missed
  // both the vertex buffer and the index buffer. Pre-existing leak;
  // amplified by Batch 156's mode-flip rebuild because the buffer is
  // now actively allocated multiple times per primitive.
  cache.vertexGPUBuffer?.destroy();
  // Batch 164 — release the morph-side 2D vertex buffer if present.
  cache.vertexGPUBuffer2D?.destroy();
  cache.indexGPUBuffer?.destroy();
  // C-R9 (Batch 31 / refactored Batch 59) — release the pick ID slot
  // back to the registry.
  destroyPickIds(primitive);
  primitive._webgpuCache = undefined;
}

export {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
export default {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
