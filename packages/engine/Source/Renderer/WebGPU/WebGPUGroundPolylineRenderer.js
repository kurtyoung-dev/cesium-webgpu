/**
 * @module WebGPUGroundPolylineRenderer
 *
 * Migration Session 4b — full WGSL port of `PolylineShadowVolumeVS.glsl`
 * + `PolylineShadowVolumeFS.glsl` for `GroundPolylinePrimitive`.
 * Sits beside `WebGPUGroundPrimitiveRenderer` in the depth-sample
 * classifier architecture (ADR-2026-04-28); reuses the same
 * `_packedTranslucentDepthView` / `_globeDepthView` plumbing
 * (Session 2) and the per-frustum bind-group resolver (Session 3) so
 * polyline classification picks up runtime depth-source swap and
 * multi-frustum correctness for free.
 *
 * **Shipped:**
 *   - WGSL VS port (per-vertex volume extrusion along miter normal,
 *     `czm_metersPerPixel`-driven width adjustment, downward extrusion
 *     for "bottom" vertices, miter-aware aligned-plane recomputation
 *     in the FS for unskewed lengthwise texture coords).
 *   - WGSL FS port (5 plane-distance tests for fragment culling,
 *     per-fragment eye-space reconstruction from sampled globe depth).
 *   - Vertex buffer interleave of 14 attributes — 8 for 3D
 *     (positionHigh/Low, startHi+forwardX, startLo+forwardY,
 *     startNormal+forwardZ, endNormal+texNormX, rightNormal+texNormY,
 *     batchId) plus 6 for 2D / Columbus View / Morph (position2DHigh/Low,
 *     startHiLo2D, offsetAndRight2D, startEndNormals2D,
 *     texcoordNormalization2D).
 *   - Per-frustum depth-source resolver (Session 3 contract).
 *   - Pick command derivation matching the GroundPrimitive renderer's
 *     pattern.
 *   - `DEBUG_SHOW_VOLUME` flag — runtime uniform; when
 *     `_debugShowShadowVolume` is true on the primitive the FS emits
 *     translucent red instead of discarding non-classified fragments.
 *   - Batch-table-driven per-instance color/width via a storage
 *     buffer (group 0 binding 1). Instance count is unbounded by
 *     uniform-buffer caps; the storage buffer grows on demand from
 *     INITIAL_BATCH_BUFFER_INSTANCES with a defensive ceiling at
 *     MAX_BATCH_INSTANCES_HARD_CAP. VS reads
 *     `czm_batchTable_color(batchId)` / `czm_batchTable_width(batchId)`
 *     equivalents from the storage array snapshotted from the inner
 *     Primitive's `_batchTable`.
 *   - 2D / Columbus View VS branch — same pipeline as 3D, scene-mode
 *     flag in the UBO selects which set of vertex attributes to read
 *     (3D vs 2D-projected) and skips bottom-vertex extrusion in 2D.
 *   - Morph scene mode — separate pipeline + WGSL entry points
 *     (`vsMorph` / `colorFSMorph` / `pickFSMorph`) that consume both
 *     2D and 3D position/plane attributes and blend by `czm_morphTime`.
 *     Front-face culling matches the WebGL `_renderStateMorph`.
 *   - Material support — `applyMaterial()` in the FS dispatches on
 *     `materialMeta.x` to inline implementations of `Color` (default),
 *     `PolylineDash`, `PolylineGlow`, `PolylineOutline`,
 *     `PolylineArrow`, `Stripe`, and `Image`. The Image material
 *     samples a 2D texture loaded asynchronously from
 *     `appearance.material.uniforms.image` (URL string,
 *     HTMLImageElement, HTMLCanvasElement, ImageBitmap, or ImageData);
 *     until the image is loaded the FS samples a 1×1 white fallback
 *     texture so the polyline renders at its tint color. Custom user
 *     materials with bespoke `fabric` / `shaderSource` fall through to
 *     the default Color path with the material's `uniforms.color` as
 *     tint — porting Cesium's full Material→GLSL pipeline to WGSL is
 *     a separate multi-week effort.
 *
 * @private
 */
import ComponentDatatype from "../../Core/ComponentDatatype.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  sampler as samplerEntry,
  texture as textureEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  attachPickToColorCommand,
  destroyPickIds,
  ensurePickId,
} from "./WebGPUPickCommandHelpers.js";
import SceneMode from "../../Scene/SceneMode.js";

// Per-instance batch-table data lives in a storage buffer (group 0
// binding 1) rather than the UBO so the instance count is unbounded
// (limited only by GPU storage-buffer size). Each instance occupies
// 8 floats: vec4 color + vec4 misc (misc.x = width-in-pixels;
// misc.y/.z/.w reserved). The storage buffer grows on demand from a
// 32-instance starting capacity; existing buffers are reused when
// the next allocation fits, otherwise destroyed and re-created.
//
// MAX_BATCH_INSTANCES_HARD_CAP is a defensive ceiling (~131k
// instances at 8 floats × 4 bytes = 32 bytes per instance ≈ 4 MB).
// In practice typical scenes top out in the low thousands; the cap
// catches runaway loops and bad input shapes before they hit the
// driver's own limits.
const FLOATS_PER_BATCH_INSTANCE = 8;
const BYTES_PER_BATCH_INSTANCE = FLOATS_PER_BATCH_INSTANCE * 4; // 32 B
const INITIAL_BATCH_BUFFER_INSTANCES = 32;
const MAX_BATCH_INSTANCES_HARD_CAP = 131072;

// UBO layout (112 floats = 448 bytes; rounded up to 512 below for
// 256-byte alignment). Per-instance batch-table data has been split
// out into a storage buffer (see above) so the UBO no longer carries
// the per-instance arrays.
//   floats   0-15 : mvRTE             (mat4x4<f32>)
//   floats  16-31 : proj              (mat4x4<f32>)
//   floats  32-47 : invProj           (mat4x4<f32>)
//   floats  48-51 : normal0           (vec3 col0 + pad)
//   floats  52-55 : normal1           (vec3 col1 + pad)
//   floats  56-59 : normal2           (vec3 col2 + pad)
//   floats  60-63 : camH + pad        (vec3<f32> + pad)
//   floats  64-67 : camL + pad        (vec3<f32> + pad)
//   floats  68-71 : viewport          (vec4<f32>: x, y, w, h)
//   floats  72-75 : color             (vec4<f32>) — fallback color
//   floats  76-79 : pickColor         (vec4<f32>)
//   floats  80-83 : misc              (vec4<f32>)
//                     x: width (pixels) — fallback width
//                     y: reserved
//                     z: GLOBE_MINIMUM_ALTITUDE (ellipsoid.minimumRadius)
//                     w: czm_geometricToleranceOverMeter (~1e-6)
//   floats  84-87 : flags             (vec4<f32>)
//                     x: debugShowVolume (0/1)
//                     y: numBatchInstances (count of valid batch-table entries)
//                     z: sceneMode (1.0 = SCENE3D, 0.0 = 2D / Columbus View)
//                     w: morphTime (0.0 = 2D, 1.0 = 3D, fractional in MORPHING)
//   floats  88-91 : materialMeta     (vec4<f32>)
//                     x: materialType
//                     y: imageRepeatS (Image material)
//                     z: imageRepeatT (Image material)
//                     w: reserved
//   floats  92-95 : materialColor    (vec4<f32>)
//   floats  96-99 : materialParam0   (vec4<f32>) — material-specific
//   floats 100-103: materialParam1   (vec4<f32>) — material-specific
//   floats 104-107: materialParam2   (vec4<f32>) — material-specific
//   floats 108-111: _pad (alignment)
const UNIFORM_BUFFER_SIZE = 512;

// 14 vertex attributes interleaved. The 3D set (locs 0-7) covers
// SCENE3D rendering; the 2D set (locs 8-13) covers SCENE2D / Columbus
// View / Morph by carrying the geometry's projected coordinates and
// 2D plane attributes. Both sets ship in every vertex even when only
// one mode is active — bandwidth cost is small for typical polyline
// sizes (a few hundred to a few thousand vertices) and avoids needing
// separate pipelines / vertex buffers per scene mode.
//
//   loc 0  (position3DHigh)                   : 0   vec3
//   loc 1  (position3DLow)                    : 12  vec3
//   loc 2  (startHiAndForwardOffsetX)         : 24  vec4
//   loc 3  (startLoAndForwardOffsetY)         : 40  vec4
//   loc 4  (startNormalAndForwardOffsetZ)     : 56  vec4
//   loc 5  (endNormalAndTexNormX)             : 72  vec4
//   loc 6  (rightNormalAndTexNormY)           : 88  vec4
//   loc 7  (batchId)                          : 104 f32
//   loc 8  (position2DHigh)                   : 108 vec3
//   loc 9  (position2DLow)                    : 120 vec3
//   loc 10 (startHiLo2D)                      : 132 vec4
//   loc 11 (offsetAndRight2D)                 : 148 vec4
//   loc 12 (startEndNormals2D)                : 164 vec4
//   loc 13 (texcoordNormalization2D)          : 180 vec2
const VERTEX_STRIDE_BYTES = 188;
const FLOATS_PER_VERTEX = 47;

const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

// `czm_geometricToleranceOverMeter` is a near-zero scaling factor that
// determines how far below the surface "bottom" vertices extrude for
// far view distances. The WebGL builtin computes it dynamically from
// camera/pixel-size; 1e-6 matches the steady-state value for typical
// global-scale views and is what the ground-primitive vertex shader
// effectively sees in steady state. Document as a first-cut limitation;
// follow-up can plumb the dynamic value through uniformState.
const GEOMETRIC_TOLERANCE_OVER_METER = 1.0e-6;

const SHADER_CODE = /* wgsl */ `
struct U {
  mvRTE: mat4x4<f32>,
  proj: mat4x4<f32>,
  invProj: mat4x4<f32>,
  normal0: vec4<f32>,
  normal1: vec4<f32>,
  normal2: vec4<f32>,
  camH: vec4<f32>,
  camL: vec4<f32>,
  viewport: vec4<f32>,
  // Fallback color used when batchId is out of range or when the
  // primitive doesn't have per-instance colors.
  color: vec4<f32>,
  pickColor: vec4<f32>,
  misc: vec4<f32>,
  // flags.x: debugShowVolume (0/1)
  // flags.y: numBatchInstances — count of valid entries in instanceColors
  //          and instanceMisc. Used by the shader to bounds-check batchId.
  // flags.z: sceneMode — 0 = 2D / Columbus View, 1 = 3D. Controls
  //          which set of vertex attributes the VS reads
  //          (3D positions/planes vs 2D positions/planes). The morph
  //          pipeline ignores this flag (it always reads both 2D and
  //          3D and blends).
  // flags.w: morphTime — 0.0 = full 2D, 1.0 = full 3D. Used only by
  //          the morph pipeline to lerp between the 2D and 3D
  //          eye-space positions and per-vertex texcoord normalizations.
  flags: vec4<f32>,
  // Material parameters. materialMeta.x is the material-type enum the
  // CPU writes after inspecting the appearance's material:
  //   0 = Color (default — uses materialColor or instanceColor)
  //   1 = PolylineDash — materialParam0.xy = (dashLength, dashPattern)
  //                       gapColor in materialParam1
  //   2 = PolylineGlow — materialParam0.x = glowPower
  //                       materialParam0.y = taperPower
  //   3 = PolylineOutline — materialParam0.x = outlineWidth
  //                          outlineColor in materialParam1
  // For unrecognised materials, the FS falls through to the default
  // color path. See applyMaterial() below.
  materialMeta: vec4<f32>,
  materialColor: vec4<f32>,
  materialParam0: vec4<f32>,
  materialParam1: vec4<f32>,
  materialParam2: vec4<f32>,
  _pad: vec4<f32>,
};

// Per-instance batch-table data. WebGL polylines look up their
// per-instance color/width via czm_batchTable_color(batchId) /
// czm_batchTable_width(batchId), which sample a 1D batch-table
// texture; in WebGPU we mirror that data into a storage-buffer
// array indexed by batchId. batchId is a per-vertex attribute
// emitted by the geometry batcher; the VS uses it to look up width
// and pass color through to the FS as a varying.
//
// Storage buffer (vs UBO array) lifts the prior MAX_BATCH_INSTANCES
// cap — instance count is bounded only by GPU storage-buffer size.
struct InstanceData {
  // color (rgba in [0, 1])
  color: vec4<f32>,
  // misc.x = per-instance width (pixels)
  // misc.y/.z/.w reserved (show, distance display, ...)
  misc: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;

// Depth-sample resources. The texture view is bound late at draw time
// via WebGPUDrawCommand.bindGroupResolvers so per-frustum + per-frame
// depth-source swaps (globe-depth ↔ packed-translucent-depth) take
// effect without rebuilding the command (Session 3 contract).
@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

// Material texture (Image material). Group 2 is always bound — when no
// Image material is in use, a 1×1 white fallback texture sits in this
// slot so the bind-group layout stays valid. The FS only samples this
// texture when materialMeta.x indicates the Image material (== 6).
@group(2) @binding(0) var materialTex: texture_2d<f32>;
@group(2) @binding(1) var materialSamp: sampler;

struct VS_IN {
  @location(0) pH: vec3<f32>,
  @location(1) pL: vec3<f32>,
  @location(2) startHi_fwdX: vec4<f32>,
  @location(3) startLo_fwdY: vec4<f32>,
  @location(4) startNormal_fwdZ: vec4<f32>,
  @location(5) endNormal_texNormX: vec4<f32>,
  @location(6) rightNormal_texNormY: vec4<f32>,
  @location(7) batchId: f32,
  @location(8) pH2D: vec3<f32>,
  @location(9) pL2D: vec3<f32>,
  @location(10) startHiLo2D: vec4<f32>,
  @location(11) offsetAndRight2D: vec4<f32>,
  @location(12) startEndNormals2D: vec4<f32>,
  @location(13) texcoordNormalization2D: vec2<f32>,
};

struct VS_OUT {
  @builtin(position) pos: vec4<f32>,
  @location(0) startPlaneNormalEcAndHalfWidth: vec4<f32>,
  @location(1) endPlaneNormalEc: vec4<f32>,
  @location(2) rightPlaneEC: vec4<f32>,
  @location(3) endEcAndStartEcX: vec4<f32>,
  @location(4) texcoordNormalizationAndStartEcYZ: vec4<f32>,
  // Per-instance color resolved at VS time (czm_batchTable_color
  // equivalent). When the primitive has no per-instance colors or the
  // batchId overflows MAX_BATCH_INSTANCES the FS gets the appearance
  // fallback color.
  @location(5) instanceColor: vec4<f32>,
};

// Look up the per-instance color from the storage-buffer array. Falls
// back to u.color when batchId is out of range. Mirrors WebGL's
// czm_batchTable_color() generated lookup.
fn batchTableColor(batchId: u32) -> vec4<f32> {
  let count = u32(u.flags.y);
  if (batchId >= count) {
    return u.color;
  }
  return instances[batchId].color;
}

// Look up the per-instance width (in pixels). Falls back to u.misc.x
// (the appearance-level width) when batchId is out of range.
fn batchTableWidth(batchId: u32) -> f32 {
  let count = u32(u.flags.y);
  if (batchId >= count) {
    return u.misc.x;
  }
  return instances[batchId].misc.x;
}

// Apply the 3x3 normal matrix (stored as 3 padded vec4 columns).
fn applyNormalMatrix(n: vec3<f32>) -> vec3<f32> {
  return u.normal0.xyz * n.x + u.normal1.xyz * n.y + u.normal2.xyz * n.z;
}

fn translateRelativeToEye(high: vec3<f32>, low: vec3<f32>) -> vec3<f32> {
  return (high - u.camH.xyz) + (low - u.camL.xyz);
}

// Perspective approximation of czm_metersPerPixel. proj[0][0] / proj[1][1]
// are the projection xScale / yScale (1/(aspect*tan(fov/2)) and
// 1/tan(fov/2)). Multiplied by 2/W and 2/H respectively, they give NDC
// pixel size; multiplied by abs(positionEC.z) they give meters per
// pixel at the eye-space z.
fn metersPerPixel(positionEC: vec3<f32>) -> f32 {
  let pixelW = 2.0 / (u.viewport.z * u.proj[0][0]);
  let pixelH = 2.0 / (u.viewport.w * u.proj[1][1]);
  let pixelSize = max(abs(pixelW), abs(pixelH));
  return pixelSize * abs(positionEC.z);
}

@vertex fn vsMain(in: VS_IN) -> VS_OUT {
  var out: VS_OUT;

  // Resolve per-instance color/width from the batch table.
  let batchIdU = u32(in.batchId);
  out.instanceColor = batchTableColor(batchIdU);

  // Pick scene-mode-specific input attributes. flags.z is 1.0 in 3D
  // and 0.0 in 2D / Columbus View. The mode determines which set of
  // attributes (3D vs 2D) we read for position, planes, and forward
  // direction. The shared body below operates on the resolved values.
  //
  // 2D / Columbus View use the projected position2DHigh/Low (with a
  // .zxy swizzle that matches Cesium's 2D coordinate convention) and
  // build planes / forward direction from vec3(0, *2D.xy/zw) inputs
  // — the leading 0 collapses the longitudinal (X) axis since the
  // 2D projection has no horizontal extent.
  let is3D = u.flags.z > 0.5;

  var positionHRTE: vec3<f32>;
  var positionLRTE: vec3<f32>;
  var startHi: vec3<f32>;
  var startLo: vec3<f32>;
  var forwardOffset: vec3<f32>;
  var startNormal: vec3<f32>;
  var endNormal: vec3<f32>;
  var rightNormal: vec3<f32>;
  var texNormX: f32;
  var texNormY: f32;

  if (is3D) {
    positionHRTE = in.pH;
    positionLRTE = in.pL;
    startHi = in.startHi_fwdX.xyz;
    startLo = in.startLo_fwdY.xyz;
    forwardOffset = vec3<f32>(
      in.startHi_fwdX.w,
      in.startLo_fwdY.w,
      in.startNormal_fwdZ.w,
    );
    startNormal = in.startNormal_fwdZ.xyz;
    endNormal = in.endNormal_texNormX.xyz;
    rightNormal = in.rightNormal_texNormY.xyz;
    texNormX = in.endNormal_texNormX.w;
    texNormY = in.rightNormal_texNormY.w;
  } else {
    // 2D / Columbus View. Position attribute is projected; the .zxy
    // swizzle maps Cesium's (lon, lat, height) packing to the 2D
    // coordinate frame the view matrix expects.
    positionHRTE = in.pH2D.zxy;
    positionLRTE = in.pL2D.zxy;
    startHi = vec3<f32>(0.0, in.startHiLo2D.x, in.startHiLo2D.y);
    startLo = vec3<f32>(0.0, in.startHiLo2D.z, in.startHiLo2D.w);
    forwardOffset = vec3<f32>(0.0, in.offsetAndRight2D.x, in.offsetAndRight2D.y);
    startNormal = vec3<f32>(0.0, in.startEndNormals2D.x, in.startEndNormals2D.y);
    endNormal = vec3<f32>(0.0, in.startEndNormals2D.z, in.startEndNormals2D.w);
    rightNormal = vec3<f32>(0.0, in.offsetAndRight2D.z, in.offsetAndRight2D.w);
    texNormX = in.texcoordNormalization2D.x;
    texNormY = in.texcoordNormalization2D.y;
  }

  // Decode start position into eye-space via RTE.
  let ecStartRTE = translateRelativeToEye(startHi, startLo);
  let ecStart = (u.mvRTE * vec4<f32>(ecStartRTE, 1.0)).xyz;

  // Forward offset (object-space) → eye-space via normal matrix.
  let offset = applyNormalMatrix(forwardOffset);
  let ecEnd = ecStart + offset;
  let forwardDirectionEC = normalize(offset);

  // Plane normals in eye-space.
  let startPlaneNormalEC = applyNormalMatrix(startNormal);
  let endPlaneNormalEC = applyNormalMatrix(endNormal);
  let rightPlaneNormalEC = applyNormalMatrix(rightNormal);

  // Right plane: store with -dot(N, ecStart) as w so that
  // dot(plane.xyz, P) + plane.w == signed distance.
  out.rightPlaneEC = vec4<f32>(rightPlaneNormalEC, -dot(rightPlaneNormalEC, ecStart));

  // Carry start/end EC and tex normalization out to the FS.
  out.endEcAndStartEcX = vec4<f32>(ecEnd, ecStart.x);
  out.texcoordNormalizationAndStartEcYZ = vec4<f32>(
    abs(texNormX),
    texNormY,
    ecStart.y,
    ecStart.z,
  );

  // Per-vertex position in eye-space (RTE).
  let positionRTE = translateRelativeToEye(positionHRTE, positionLRTE);
  var positionEC = (u.mvRTE * vec4<f32>(positionRTE, 1.0)).xyz;

  // Pick the closer plane (start vs end) for the extrusion direction.
  let absStart = abs(dot(startPlaneNormalEC, positionEC) + (-dot(startPlaneNormalEC, ecStart)));
  let absEnd = abs(dot(endPlaneNormalEC, positionEC) + (-dot(endPlaneNormalEC, ecEnd)));
  var planeDirection = endPlaneNormalEC;
  if (absStart < absEnd) {
    planeDirection = startPlaneNormalEC;
  }

  let upOrDown0 = normalize(cross(rightPlaneNormalEC, planeDirection));
  let normalEC0 = normalize(cross(planeDirection, upOrDown0));

  // Extrude bottom vertices downward for far view distances — 3D-only.
  // Matches the WebGL float(czm_sceneMode == czm_sceneMode3D) gate
  // in PolylineShadowVolumeVS: the 2D / CV projections don't need
  // bottom-vertex extrusion because the projected geometry is flat.
  var upOrDown = cross(forwardDirectionEC, normalEC0);
  let yIsBottom = (texNormY > 1.0) || (texNormY < 0.0);
  if (!yIsBottom || !is3D) {
    upOrDown = vec3<f32>(0.0, 0.0, 0.0);
  }
  let bottomScale = min(u.misc.z, u.misc.w * length(positionRTE));
  positionEC = positionEC + bottomScale * upOrDown;

  // Re-encode texcoord normalization Y (collapse > 1 sentinels to 0).
  out.texcoordNormalizationAndStartEcYZ.y = select(abs(texNormY), 0.0, texNormY > 1.0);

  // Start plane half-width carries width/2 in pixels (FS converts to
  // meters via czm_metersPerPixel(eyeCoord)).
  let widthPixels = batchTableWidth(batchIdU);
  out.startPlaneNormalEcAndHalfWidth = vec4<f32>(startPlaneNormalEC, widthPixels * 0.5);
  out.endPlaneNormalEc = vec4<f32>(endPlaneNormalEC, 0.0);

  // Determine push distance along normalEC for proper width.
  var widthMeters = widthPixels * max(0.0, metersPerPixel(positionEC));
  widthMeters = widthMeters / dot(normalEC0, rightPlaneNormalEC);

  // Sign-flip the normal based on tex normalization X (left/right
  // sidedness encoding).
  let normalSign = sign(texNormX);
  let normalEC = normalEC0 * normalSign;

  positionEC = positionEC + widthMeters * normalEC;

  out.pos = u.proj * vec4<f32>(positionEC, 1.0);
  return out;
}

// Reverse of WebGPUGlobeDepth's pack: each RGBA byte carries a slice of
// the depth value. Matches czm_unpackDepth in the WebGL builtins.
fn unpackDepth(packed: vec4<f32>) -> f32 {
  return dot(packed, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

// Reconstruct eye-space position from window XY + normalized depth.
// WebGPU NDC z is [0, 1] (no remap needed) but clip-space y points down
// while eye-space y points up, so we flip y.
fn windowToEyeCoordinates(fragXY: vec2<f32>, depth: f32) -> vec3<f32> {
  var ndc = (fragXY / u.viewport.zw) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  let clip = vec4<f32>(ndc, depth, 1.0);
  let eye = u.invProj * clip;
  return eye.xyz / eye.w;
}

// Plane distance: dot(N, P) + w.
fn planeDistance(planeXYZ: vec3<f32>, planeW: f32, point: vec3<f32>) -> f32 {
  return dot(planeXYZ, point) + planeW;
}

// Test the fragment against the polyline shadow volume planes. Returns
// a struct with the test result and the raw widthwise / lengthwise
// distances (kept around for material texture-coord computation when
// we port that). Discards happen at the call site so the color and
// pick FS can share this path.
struct ClassifyResult {
  passed: bool,
  eyeCoord: vec3<f32>,
  widthwiseDistance: f32,
  halfMaxWidth: f32,
  distanceFromStart: f32,
  distanceFromEnd: f32,
};

fn classifyFragment(in: VS_OUT) -> ClassifyResult {
  var result: ClassifyResult;
  result.passed = false;
  result.eyeCoord = vec3<f32>(0.0);
  result.widthwiseDistance = 0.0;
  result.halfMaxWidth = 0.0;
  result.distanceFromStart = 0.0;
  result.distanceFromEnd = 0.0;

  // in.pos is the @builtin(position) — in the fragment stage WGSL
  // delivers it in window-space (xy = pixel coords, z = depth, w = 1/clipW).
  let screenUV = in.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    return result;
  }

  let eyeCoord = windowToEyeCoordinates(in.pos.xy, surfaceDepth);
  result.eyeCoord = eyeCoord;

  let halfMaxWidth = in.startPlaneNormalEcAndHalfWidth.w * metersPerPixel(eyeCoord);
  result.halfMaxWidth = halfMaxWidth;

  let widthwiseDistance = planeDistance(in.rightPlaneEC.xyz, in.rightPlaneEC.w, eyeCoord);
  result.widthwiseDistance = widthwiseDistance;

  let ecStart = vec3<f32>(in.endEcAndStartEcX.w, in.texcoordNormalizationAndStartEcYZ.zw);
  let ecEnd = in.endEcAndStartEcX.xyz;

  let startW = -dot(ecStart, in.startPlaneNormalEcAndHalfWidth.xyz);
  let endW = -dot(ecEnd, in.endPlaneNormalEc.xyz);
  let distFromStart = planeDistance(in.startPlaneNormalEcAndHalfWidth.xyz, startW, eyeCoord);
  let distFromEnd = planeDistance(in.endPlaneNormalEc.xyz, endW, eyeCoord);
  result.distanceFromStart = distFromStart;
  result.distanceFromEnd = distFromEnd;

  if (abs(widthwiseDistance) > halfMaxWidth || distFromStart < 0.0 || distFromEnd < 0.0) {
    return result;
  }

  result.passed = true;
  return result;
}

// Aligned-plane reconstruction for unskewed lengthwise texture coords.
// WebGL polyline FS does this when computing material s: cross the
// right plane normal with the miter plane normal, then cross the
// result with right again to point it more forward. This produces a
// plane perpendicular to right that gives uniform distances along the
// segment regardless of miter angle.
fn alignedPlaneDistance(rightN: vec3<f32>, miterN: vec3<f32>, anchor: vec3<f32>, eye: vec3<f32>) -> f32 {
  let cross1 = cross(rightN, miterN);
  let alignedN = normalize(cross(cross1, rightN));
  return planeDistance(alignedN, -dot(alignedN, anchor), eye);
}

// Apply the active material. materialMeta.x picks among supported
// materials; materialColor is the default per-material color
// (overrides per-instance color when set), and materialParam0/1/2
// carry material-specific parameters. Mirrors the WebGL czm_getMaterial
// flow at fragment-time but inlined as a switch on the material type.
fn applyMaterial(
  s: f32,
  t: f32,
  baseColor: vec4<f32>,
) -> vec4<f32> {
  let materialType = u32(u.materialMeta.x);

  if (materialType == 1u) {
    // PolylineDash. WebGL PolylineDashMaterial parameters:
    //   color       (vec4)             — solid segment color
    //   gapColor    (vec4)             — gap color (often transparent)
    //   dashLength  (float, pixels)    — full pattern length
    //   dashPattern (uint)             — bit pattern over 16 cells
    // The shader maps s to a position along the dash pattern using
    // the polyline pixel length, then samples the bit pattern.
    let dashLength = u.materialParam0.x;
    let dashPattern = u32(u.materialParam0.y);
    // Approximate the pattern by mapping s in [0,1] over the polyline
    // length in pixels. Matches WebGL's dashed appearance for typical
    // polyline widths.
    let pixelLen = dashLength;
    let cell = u32(fract(s * pixelLen / 16.0) * 16.0);
    let bit = (dashPattern >> cell) & 1u;
    if (bit == 0u) {
      return u.materialParam1; // gap color
    }
    return u.materialColor;
  }

  if (materialType == 2u) {
    // PolylineGlow. Parameters:
    //   color     (vec4)
    //   glowPower (float)  — falls off from segment center to edge
    //   taperPower(float)  — falls off from segment start/end
    let glowPower = u.materialParam0.x;
    let taperPower = u.materialParam0.y;
    // Distance from segment centerline (t = 0.5 is center, 0/1 are edges).
    let edgeT = abs(t * 2.0 - 1.0);
    let glow = pow(1.0 - edgeT, glowPower);
    let taper = pow(min(s, 1.0 - s) * 2.0, max(taperPower, 0.001));
    let alpha = glow * taper * baseColor.a;
    return vec4<f32>(baseColor.rgb, alpha);
  }

  if (materialType == 3u) {
    // PolylineOutline. Parameters:
    //   color         (in materialColor)
    //   outlineColor  (in materialParam1)
    //   outlineWidth  (in materialParam0.x — fraction of half-width)
    let outlineWidth = u.materialParam0.x;
    let edgeT = abs(t * 2.0 - 1.0);
    if (edgeT > 1.0 - outlineWidth) {
      return u.materialParam1;
    }
    return u.materialColor;
  }

  if (materialType == 4u) {
    // PolylineArrow. Mirrors PolylineArrowMaterial.glsl.
    //
    // The shader gets:
    //   color  (in materialColor)
    //   width-derived constants in materialParam0:
    //     .x = base half-width (fraction of widthwise UV)
    //     .y = arrow head start s (default 0.85 — last 15% of length)
    //
    // The arrowhead is a triangle that grows from arrowStart to s=1
    // covering the full width, with the body shrinking to zero width
    // over the same interval. Outside the arrowhead region the polyline
    // renders at its base half-width.
    let arrowStart = u.materialParam0.y;
    if (s < arrowStart) {
      // Body region — same width as a regular polyline.
      let edgeT = abs(t * 2.0 - 1.0);
      if (edgeT > 1.0) {
        discard;
      }
      return u.materialColor;
    }
    // Arrowhead region — width tapers linearly from full at arrowStart
    // to zero at s=1. The "head" itself widens to 2× the body, then
    // tapers.
    let arrowProgress = (s - arrowStart) / max(1.0 - arrowStart, 0.001);
    let edgeT = abs(t * 2.0 - 1.0);
    // Triangle: |t-0.5| <= 0.5 * (1 - arrowProgress) gives the head body
    if (edgeT > 1.0 - arrowProgress) {
      discard;
    }
    return u.materialColor;
  }

  if (materialType == 5u) {
    // Stripe. Mirrors StripeMaterial.glsl in 1D form along the polyline.
    //   evenColor  (in materialColor)
    //   oddColor   (in materialParam1)
    //   repeat     (materialParam0.x) — number of stripe pairs over [0, 1]
    //   offset     (materialParam0.y) — phase shift
    //   orientation(materialParam0.z) — 0 = horizontal (along s),
    //                                   1 = vertical (across t)
    let repeat = u.materialParam0.x;
    let offset = u.materialParam0.y;
    let isVertical = u.materialParam0.z > 0.5;
    var coord = s;
    if (isVertical) {
      coord = t;
    }
    let phase = fract(coord * repeat + offset);
    if (phase < 0.5) {
      return u.materialColor;
    }
    return u.materialParam1;
  }

  if (materialType == 6u) {
    // Image. Mirrors ImageMaterial.glsl — samples materialTex at
    // (s * repeatS, t * repeatT) and modulates by materialColor.
    //   image       — bound to materialTex
    //   repeat.s/t  — materialMeta.y / .z
    //   color       — materialColor (multiplicative tint)
    let uv = vec2<f32>(s * u.materialMeta.y, t * u.materialMeta.z);
    let sampled = textureSampleLevel(materialTex, materialSamp, uv, 0.0);
    return sampled * u.materialColor;
  }

  if (materialType == 7u) {
    // Batch 97 — Checkerboard. Reproduces CheckerboardMaterial.glsl in
    // condensed form: alternating squares from a 2D parity test on
    // (s repeat.s, t repeat.t), with anti-aliased seams via the
    // distance-to-nearest-separator term. lightColor in materialColor;
    // darkColor in materialParam1; repeat.s/t in materialParam0.xy.
    let repeatS = u.materialParam0.x;
    let repeatT = u.materialParam0.y;
    let edgeT = clamp(t, 0.0, 1.0);
    let parity = (floor(repeatS * s) + floor(repeatT * edgeT)) % 2.0;
    let scaledW = fract(repeatS * s);
    let scaledH = fract(repeatT * edgeT);
    let dW = abs(scaledW - floor(scaledW + 0.5));
    let dH = abs(scaledH - floor(scaledH + 0.5));
    let aaDist = min(dW, dH);
    let lightColor = u.materialColor;
    let darkColor = u.materialParam1;
    let solidColor = mix(lightColor, darkColor, parity);
    // Anti-alias the seam at 0.03-distance fadeoff (matches
    // czm_antialias's default fuzz factor for materials).
    let fade = smoothstep(0.0, 0.03, aaDist);
    let aliased = mix(lightColor, solidColor, fade);
    return aliased;
  }

  if (materialType == 8u) {
    // Batch 97 — Custom fallback. Renders unrecognized material types
    // as materialColor (image repeat) so users at least get the
    // appearance tint. Hand-written fabric materials with bespoke
    // shader source aren't transpiled (see resolveMaterialState's
    // one-time warn log); they degrade to this path.
    let hasImage = u.materialParam0.x > 0.5;
    if (hasImage) {
      let uv = vec2<f32>(s * u.materialMeta.y, t * u.materialMeta.z);
      let sampled = textureSampleLevel(materialTex, materialSamp, uv, 0.0);
      return sampled * u.materialColor;
    }
    return u.materialColor;
  }

  // materialType == 0 (Color, default) — use the per-instance color
  // resolved in the VS via the batch table. PolylineMaterialAppearance
  // with a Color material lands here too: materialColor mirrors the
  // appearance's material.uniforms.color. Prefer the per-instance
  // color when batchTableColor returned a real entry; otherwise fall
  // back to the appearance's material color.
  return baseColor;
}

@fragment fn colorFS(in: VS_OUT) -> @location(0) vec4<f32> {
  let r = classifyFragment(in);
  let debugShowVolume = u.flags.x > 0.5;
  if (!r.passed) {
    if (debugShowVolume) {
      // DEBUG_SHOW_VOLUME — emit translucent red for fragments that
      // would normally be discarded so the volume's spatial coverage
      // is visible. Matches WebGL's DEBUG_SHOW_VOLUME vec4(1, 0, 0, 0.5)
      // (pre-multiplied: rgb *= a).
      return vec4<f32>(0.5, 0.0, 0.0, 0.5);
    }
    discard;
  }

  // Recompute s, t for material UV. Use aligned planes for s so
  // miter joints don't produce skewed texture coordinates (matches
  // WebGL's PolylineShadowVolumeFS aligned-plane recomputation).
  let ecStart = vec3<f32>(in.endEcAndStartEcX.w, in.texcoordNormalizationAndStartEcYZ.zw);
  let ecEnd = in.endEcAndStartEcX.xyz;
  let alignedStart = alignedPlaneDistance(
    in.rightPlaneEC.xyz,
    in.startPlaneNormalEcAndHalfWidth.xyz,
    ecStart,
    r.eyeCoord,
  );
  let alignedEnd = alignedPlaneDistance(
    in.rightPlaneEC.xyz,
    in.endPlaneNormalEc.xyz,
    ecEnd,
    r.eyeCoord,
  );
  let safeStart = max(0.0, alignedStart);
  let safeEnd = max(0.0, alignedEnd);
  let total = max(safeStart + safeEnd, 1e-6);
  var s = clamp(safeStart / total, 0.0, 1.0);
  // Apply the geometry's per-segment texcoord normalization (so
  // multi-segment polylines map to a continuous s ∈ [0,1] across the
  // whole line, not per-segment).
  s = s * in.texcoordNormalizationAndStartEcYZ.x + in.texcoordNormalizationAndStartEcYZ.y;
  let t = (r.widthwiseDistance + r.halfMaxWidth) / (2.0 * r.halfMaxWidth);

  // Default base color: the per-instance color resolved in the VS.
  // Material 0 (Color) and Material 2 (Glow) use this; the others
  // pull their own colors from material parameters.
  let c = applyMaterial(s, t, in.instanceColor);
  return vec4<f32>(c.rgb * c.a, c.a);
}

@fragment fn pickFS(in: VS_OUT) -> @location(0) vec4<f32> {
  let r = classifyFragment(in);
  if (!r.passed) {
    discard;
  }
  return u.pickColor;
}

// ── Morph scene-mode pipeline ────────────────────────────────────
//
// During scene-mode transitions (3D ↔ Columbus View ↔ 2D) the polyline
// has to render through both the 2D-projected and 3D positions, blended
// by czm_morphTime. This requires a separate VS that consumes BOTH the
// 3D and 2D vertex attributes simultaneously and produces a different
// varying set than the regular pipeline (no fragment-side eye-space
// reconstruction — the morph FS just emits the per-instance color
// directly on the volume's rasterized surface, mirroring WebGL's
// PolylineShadowVolumeMorphFS).
//
// MAX_TERRAIN_HEIGHT is the same constant the WebGL morph shader takes
// as a #define from ApproximateTerrainHeights._defaultMaxTerrainHeight
// (8000m for Earth). Used to nudge top vertices upwards to prevent
// flickering when the volume is partly above terrain.
const MAX_TERRAIN_HEIGHT: f32 = 8000.0;

struct VS_OUT_MORPH {
  @builtin(position) pos: vec4<f32>,
  @location(0) forwardDirectionEC: vec3<f32>,
  @location(1) texcoordNormalizationAndHalfWidth: vec3<f32>,
  @location(2) instanceColor: vec4<f32>,
};

@vertex fn vsMorph(in: VS_IN) -> VS_OUT_MORPH {
  var out: VS_OUT_MORPH;

  let batchIdU = u32(in.batchId);
  out.instanceColor = batchTableColor(batchIdU);
  let halfWidth = batchTableWidth(batchIdU) * 0.5;

  let morphTime = u.flags.w;

  // ── Start position (2D, 3D, blended) ──
  let startRTE2D = translateRelativeToEye(
    vec3<f32>(0.0, in.startHiLo2D.x, in.startHiLo2D.y),
    vec3<f32>(0.0, in.startHiLo2D.z, in.startHiLo2D.w),
  );
  let startRTE3D = translateRelativeToEye(in.startHi_fwdX.xyz, in.startLo_fwdY.xyz);
  let startRTE = mix(startRTE2D, startRTE3D, morphTime);
  let posEc2D_start = (u.mvRTE * vec4<f32>(startRTE2D, 1.0)).xyz;
  let posEc3D_start = (u.mvRTE * vec4<f32>(startRTE3D, 1.0)).xyz;
  let startEC = (u.mvRTE * vec4<f32>(startRTE, 1.0)).xyz;

  // ── Plane normals (2D, 3D) ──
  let startPlane2D_n = applyNormalMatrix(vec3<f32>(0.0, in.startEndNormals2D.x, in.startEndNormals2D.y));
  let startPlane3D_n = applyNormalMatrix(in.startNormal_fwdZ.xyz);
  let startPlane2D_w = -dot(startPlane2D_n, posEc2D_start);
  let startPlane3D_w = -dot(startPlane3D_n, posEc3D_start);

  let rightPlane2D_n = applyNormalMatrix(vec3<f32>(0.0, in.offsetAndRight2D.z, in.offsetAndRight2D.w));
  let rightPlane3D_n = applyNormalMatrix(in.rightNormal_texNormY.xyz);

  // ── End position ──
  let endRTE2D = startRTE2D + vec3<f32>(0.0, in.offsetAndRight2D.x, in.offsetAndRight2D.y);
  let endRTE3D = startRTE3D + vec3<f32>(in.startHi_fwdX.w, in.startLo_fwdY.w, in.startNormal_fwdZ.w);
  let endRTE = mix(endRTE2D, endRTE3D, morphTime);
  let posEc2D_end = (u.mvRTE * vec4<f32>(endRTE2D, 1.0)).xyz;
  let posEc3D_end = (u.mvRTE * vec4<f32>(endRTE3D, 1.0)).xyz;
  let endEC = (u.mvRTE * vec4<f32>(endRTE, 1.0)).xyz;
  let forwardEc3D = applyNormalMatrix(normalize(vec3<f32>(in.startHi_fwdX.w, in.startLo_fwdY.w, in.startNormal_fwdZ.w)));
  let forwardEc2D = applyNormalMatrix(normalize(vec3<f32>(0.0, in.offsetAndRight2D.x, in.offsetAndRight2D.y)));

  let endPlane2D_n = applyNormalMatrix(vec3<f32>(0.0, in.startEndNormals2D.z, in.startEndNormals2D.w));
  let endPlane3D_n = applyNormalMatrix(in.endNormal_texNormX.xyz);
  let endPlane2D_w = -dot(endPlane2D_n, posEc2D_end);
  let endPlane3D_w = -dot(endPlane3D_n, posEc3D_end);

  out.forwardDirectionEC = normalize(endEC - startEC);

  // Texcoord normalization (clean + blend across 2D/3D).
  let texY2DRaw = in.texcoordNormalization2D.y;
  let cleanTex2DX = abs(in.texcoordNormalization2D.x);
  let cleanTex2DY = select(abs(texY2DRaw), 0.0, texY2DRaw > 1.0);
  let texY3DRaw = in.rightNormal_texNormY.w;
  let cleanTex3DX = abs(in.endNormal_texNormX.w);
  let cleanTex3DY = select(abs(texY3DRaw), 0.0, texY3DRaw > 1.0);
  out.texcoordNormalizationAndHalfWidth = vec3<f32>(
    mix(cleanTex2DX, cleanTex3DX, morphTime),
    mix(cleanTex2DY, cleanTex3DY, morphTime),
    halfWidth,
  );

  // ── Compute extruded position in 3D ──
  let positionRTE3D = translateRelativeToEye(in.pH, in.pL);
  let positionEc3D_pre = (u.mvRTE * vec4<f32>(positionRTE3D, 1.0)).xyz;
  let absStart3D = abs(dot(startPlane3D_n, positionEc3D_pre) + startPlane3D_w);
  let absEnd3D = abs(dot(endPlane3D_n, positionEc3D_pre) + endPlane3D_w);
  var planeDir3D = endPlane3D_n;
  if (absStart3D < absEnd3D) { planeDir3D = startPlane3D_n; }
  let upOrDown3D = normalize(cross(rightPlane3D_n, planeDir3D));
  var normalEC3D = normalize(cross(planeDir3D, upOrDown3D));
  let geodeticNormal3D = normalize(cross(normalEC3D, forwardEc3D));
  let inRange3D = (texY3DRaw >= 0.0 && texY3DRaw <= 1.0);
  var positionEc3D = positionEc3D_pre;
  if (inRange3D) {
    positionEc3D = positionEc3D + geodeticNormal3D * MAX_TERRAIN_HEIGHT;
  }
  normalEC3D = normalEC3D * sign(in.endNormal_texNormX.w);
  positionEc3D = positionEc3D + halfWidth * max(0.0, metersPerPixel(positionEc3D)) * normalEC3D;

  // ── Compute extruded position in 2D ──
  let positionRTE2D = translateRelativeToEye(in.pH2D.zxy, in.pL2D.zxy);
  let positionEc2D_pre = (u.mvRTE * vec4<f32>(positionRTE2D, 1.0)).xyz;
  let absStart2D = abs(dot(startPlane2D_n, positionEc2D_pre) + startPlane2D_w);
  let absEnd2D = abs(dot(endPlane2D_n, positionEc2D_pre) + endPlane2D_w);
  var planeDir2D = endPlane2D_n;
  if (absStart2D < absEnd2D) { planeDir2D = startPlane2D_n; }
  let upOrDown2D = normalize(cross(rightPlane2D_n, planeDir2D));
  var normalEC2D = normalize(cross(planeDir2D, upOrDown2D));
  let geodeticNormal2D = normalize(cross(normalEC2D, forwardEc2D));
  let inRange2D = (texY2DRaw >= 0.0 && texY2DRaw <= 1.0);
  var positionEc2D = positionEc2D_pre;
  if (inRange2D) {
    positionEc2D = positionEc2D + geodeticNormal2D * MAX_TERRAIN_HEIGHT;
  }
  normalEC2D = normalEC2D * sign(in.texcoordNormalization2D.x);
  positionEc2D = positionEc2D + halfWidth * max(0.0, metersPerPixel(positionEc2D)) * normalEC2D;

  // Blend and project.
  let positionEc = mix(positionEc2D, positionEc3D, morphTime);
  out.pos = u.proj * vec4<f32>(positionEc, 1.0);
  return out;
}

// Morph FS — no globe-depth sampling. The shadow volume is rendered
// directly with the per-instance color, mirroring WebGL's
// PolylineShadowVolumeMorphFS PER_INSTANCE_COLOR path. The morph view
// is transitional (camera typically far away during a scene-mode
// switch) so rendering the full volume surface instead of clipping
// against terrain depth is acceptable. Material support and the
// non-color path are deferred.
@fragment fn colorFSMorph(in: VS_OUT_MORPH) -> @location(0) vec4<f32> {
  let c = in.instanceColor;
  return vec4<f32>(c.rgb * c.a, c.a);
}

@fragment fn pickFSMorph(in: VS_OUT_MORPH) -> @location(0) vec4<f32> {
  return u.pickColor;
}
`;

function buildPolylinePipelineResources(device, format, depthFormat) {
  const mod = device.createShaderModule({
    label: "GroundPolyline",
    code: SHADER_CODE,
  });

  // Group 0: uniform buffer (binding 0) + per-instance storage buffer
  // (binding 1). The instance data was previously a UBO array capped
  // at 64 entries; moving it to a storage buffer lifts that cap and
  // matches the polyline collection sizes seen in real apps (typically
  // hundreds of instances per primitive when batched per-route).
  const bgl = makeBindGroupLayout(device, "GroundPolyline BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
    storageBuffer(1, Stage.VERTEX_FRAGMENT, { readOnly: true }),
  ]);

  const depthSampleBgl = makeBindGroupLayout(
    device,
    "GroundPolyline DepthSample BGL",
    [
      textureEntry(0, Stage.FRAGMENT, { sampleType: "float" }),
      samplerEntry(1, Stage.FRAGMENT, "filtering"),
    ],
  );

  // Group 2: material texture (Image material). When no Image material
  // is in use, a 1×1 white fallback texture sits in the slot so the
  // bind-group layout stays valid across all material types — the FS
  // only samples this texture when materialType == 6 (Image).
  const materialBgl = makeBindGroupLayout(
    device,
    "GroundPolyline Material BGL",
    [
      textureEntry(0, Stage.FRAGMENT, { sampleType: "float" }),
      samplerEntry(1, Stage.FRAGMENT, "filtering"),
    ],
  );

  const pipelineLayout = device.createPipelineLayout({
    label: "GroundPolyline PipelineLayout",
    bindGroupLayouts: [bgl, depthSampleBgl, materialBgl],
  });

  const vertexBuffers = [
    {
      arrayStride: VERTEX_STRIDE_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x4" },
        { shaderLocation: 3, offset: 40, format: "float32x4" },
        { shaderLocation: 4, offset: 56, format: "float32x4" },
        { shaderLocation: 5, offset: 72, format: "float32x4" },
        { shaderLocation: 6, offset: 88, format: "float32x4" },
        { shaderLocation: 7, offset: 104, format: "float32" },
        { shaderLocation: 8, offset: 108, format: "float32x3" },
        { shaderLocation: 9, offset: 120, format: "float32x3" },
        { shaderLocation: 10, offset: 132, format: "float32x4" },
        { shaderLocation: 11, offset: 148, format: "float32x4" },
        { shaderLocation: 12, offset: 164, format: "float32x4" },
        { shaderLocation: 13, offset: 180, format: "float32x2" },
      ],
    },
  ];

  const colorDescriptor = {
    name: `GroundPolyline color [${format}/${depthFormat}]`,
    layout: pipelineLayout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "colorFS",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    // FS reconstructs eye-space from sampled depth; rasterization side
    // is just a coverage volume. Match GroundPrimitive renderer's
    // `cullMode: "none"` so both faces of the volume contribute (the FS
    // does the real culling via plane-distance tests). Trade: doubles
    // fill cost on the volume rasterization but avoids correctness
    // concerns from the geometry's reverse winding.
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      // The volume's geometric depth must NOT gate rasterization — the
      // shadow-volume FS samples globe depth and reconstructs the
      // surface position itself. A `less-equal` compare here culls
      // fragments where the volume's depth lies behind the depth
      // buffer (i.e., most of the volume below terrain), making the
      // polyline invisible. WebGL's render state intentionally omits
      // `depthTest` (only sets `depthMask: false`) so the volume
      // rasterizes everywhere it covers screen-space; the WebGPU
      // equivalent is `depthCompare: "always"`. Found 2026-04-30
      // chasing C-R8-GROUND-POLYLINE-NATIVE.
      depthCompare: "always",
    },
  };

  const pickDescriptor = {
    name: `GroundPolyline pick [${format}/${depthFormat}]`,
    layout: pipelineLayout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "pickFS",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "always",
    },
  };

  // Morph pipeline — uses the same UBO and pipeline layout, but
  // different VS / FS entry points and front-face culling (matches the
  // WebGL `_renderStateMorph` which has `face: CullFace.FRONT` because
  // the geometry is reverse-wound and morph wants the volume's
  // outside surface).
  const morphColorDescriptor = {
    name: `GroundPolyline color morph [${format}/${depthFormat}]`,
    layout: pipelineLayout,
    vertex: { module: mod, entryPoint: "vsMorph", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "colorFSMorph",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "front" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      // Match the main pipeline's `depthCompare: "always"` rationale —
      // the volume's depth must not gate rasterization for the
      // depth-sample classifier.
      depthCompare: "always",
    },
  };

  const morphPickDescriptor = {
    name: `GroundPolyline pick morph [${format}/${depthFormat}]`,
    layout: pipelineLayout,
    vertex: { module: mod, entryPoint: "vsMorph", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "pickFSMorph",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "front" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      // Match the main pipeline's `depthCompare: "always"` rationale —
      // the volume's depth must not gate rasterization for the
      // depth-sample classifier.
      depthCompare: "always",
    },
  };

  return {
    colorDescriptor,
    pickDescriptor,
    morphColorDescriptor,
    morphPickDescriptor,
    bgl,
    depthSampleBgl,
    materialBgl,
  };
}

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

function tryResolvePolylinePipelines(device, pipelineCache, resources, cache) {
  if (
    cache.colorPipeline &&
    cache.pickPipeline &&
    cache.morphColorPipeline &&
    cache.morphPickPipeline
  ) {
    return true;
  }

  if (pipelineCache) {
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    const morphColorSync = pipelineCache.getPipelineSync(
      resources.morphColorDescriptor,
    );
    const morphPickSync = pipelineCache.getPipelineSync(
      resources.morphPickDescriptor,
    );
    if (colorSync && pickSync && morphColorSync && morphPickSync) {
      cache.colorPipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.morphColorPipeline = morphColorSync;
      cache.morphPickPipeline = morphPickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.colorDescriptor),
        pipelineCache.getPipeline(resources.pickDescriptor),
        pipelineCache.getPipeline(resources.morphColorDescriptor),
        pipelineCache.getPipeline(resources.morphPickDescriptor),
      ])
        .then(([color, pick, morphColor, morphPick]) => {
          cache.colorPipeline = color;
          cache.pickPipeline = pick;
          cache.morphColorPipeline = morphColor;
          cache.morphPickPipeline = morphPick;
          cache.pipelineRequestPending = false;
        })
        .catch(() => {
          cache.pipelineRequestPending = false;
        });
    }
    return false;
  }

  cache.colorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
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
  widthPixels,
  globeMinAlt,
  debugShowVolume,
  batchInstanceCount,
  batchColors,
  batchMisc,
  materialState,
) {
  const uniformState = frameState.context.uniformState;

  // mvRTE = view * model with translation zeroed.
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.pack(scratchMVRTE, data, 0);

  // proj
  Matrix4.pack(uniformState.projection, data, 16);

  // invProj — used by the FS to recover eye-space from window+depth.
  Matrix4.pack(uniformState.inverseProjection, data, 32);

  // czm_normal — 3x3 inverseTranspose(modelView) upper-left, packed as
  // 3 padded vec4 columns. uniformState.normal is a Matrix3 in
  // column-major order.
  const normal = uniformState.normal;
  // Column 0
  data[48] = normal[0];
  data[49] = normal[1];
  data[50] = normal[2];
  data[51] = 0.0;
  // Column 1
  data[52] = normal[3];
  data[53] = normal[4];
  data[54] = normal[5];
  data[55] = 0.0;
  // Column 2
  data[56] = normal[6];
  data[57] = normal[7];
  data[58] = normal[8];
  data[59] = 0.0;

  // Camera high/low
  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[60] = scratchEncodedCamera.high.x;
  data[61] = scratchEncodedCamera.high.y;
  data[62] = scratchEncodedCamera.high.z;
  data[63] = 0.0;
  data[64] = scratchEncodedCamera.low.x;
  data[65] = scratchEncodedCamera.low.y;
  data[66] = scratchEncodedCamera.low.z;
  data[67] = 0.0;

  // Viewport
  const viewport = uniformState.viewportCartesian4 ?? uniformState.viewport;
  data[68] = viewport?.x ?? 0.0;
  data[69] = viewport?.y ?? 0.0;
  data[70] = viewport?.z ?? frameState.context.drawingBufferWidth ?? 0.0;
  data[71] = viewport?.w ?? frameState.context.drawingBufferHeight ?? 0.0;

  // Color
  data[72] = color?.red ?? 1.0;
  data[73] = color?.green ?? 1.0;
  data[74] = color?.blue ?? 1.0;
  data[75] = color?.alpha ?? 1.0;

  // Pick color
  data[76] = pickColor?.red ?? 0.0;
  data[77] = pickColor?.green ?? 0.0;
  data[78] = pickColor?.blue ?? 0.0;
  data[79] = pickColor?.alpha ?? 0.0;

  // Misc: width (pixels), metersPerPixelFactor (now unused — recomputed
  // in the shader from proj[0][0] / proj[1][1]), GLOBE_MIN_ALT,
  // geometricToleranceOverMeter.
  data[80] = widthPixels;
  data[81] = 0.0;
  data[82] = globeMinAlt;
  data[83] = GEOMETRIC_TOLERANCE_OVER_METER;

  // Flags: x=debugShowVolume, y=numBatchInstances, z=sceneMode, w=morphTime.
  // sceneMode encoding: 1.0 = SCENE3D, 0.0 = SCENE2D / Columbus View.
  // morphTime is uniformState.morphTime — 0.0 in 2D/CV destination,
  // 1.0 in 3D destination, fractional during a scene-mode transition.
  // The morph pipeline reads it; the regular pipeline ignores it.
  const sceneMode = frameState?.mode;
  const is3D = sceneMode === SceneMode.SCENE3D;
  const morphTime = uniformState?.morphTime ?? (is3D ? 1.0 : 0.0);
  data[84] = debugShowVolume ? 1.0 : 0.0;
  data[85] = batchInstanceCount ?? 0;
  data[86] = is3D ? 1.0 : 0.0;
  data[87] = morphTime;

  // Material state: materialMeta.x = type (88), .y = imageRepeatS (89),
  // .z = imageRepeatT (90), .w = reserved (91). Then materialColor
  // (92-95), materialParam0 (96-99), materialParam1 (100-103),
  // materialParam2 (104-107). Slots 108-111 are alignment padding.
  if (defined(materialState)) {
    data[88] = materialState.type;
    data[89] = materialState.imageRepeat?.[0] ?? 1.0;
    data[90] = materialState.imageRepeat?.[1] ?? 1.0;
    data[91] = 0.0;
    data[92] = materialState.color[0];
    data[93] = materialState.color[1];
    data[94] = materialState.color[2];
    data[95] = materialState.color[3];
    data[96] = materialState.param0[0];
    data[97] = materialState.param0[1];
    data[98] = materialState.param0[2];
    data[99] = materialState.param0[3];
    data[100] = materialState.param1[0];
    data[101] = materialState.param1[1];
    data[102] = materialState.param1[2];
    data[103] = materialState.param1[3];
    data[104] = materialState.param2[0];
    data[105] = materialState.param2[1];
    data[106] = materialState.param2[2];
    data[107] = materialState.param2[3];
  } else {
    // No material — zero everything (FS will use the default Color
    // path with the per-instance color from the batch table).
    data.fill(0.0, 88, 108);
  }
  data[108] = 0.0;
  data[109] = 0.0;
  data[110] = 0.0;
  data[111] = 0.0;

  // Per-instance batch-table data lives in a storage buffer (group 0
  // binding 1) now, not the UBO. The caller writes that buffer
  // separately when the batch-table snapshot is captured.
}

/**
 * Walk the GroundPolylinePrimitive → Primitive chain to find the
 * `_webgpuGeometryData` slot. The primitive populator runs at
 * `Scene/PrimitiveGeometryHelpers.js:788` on the innermost
 * `Primitive`. For a GroundPolylinePrimitive the chain is:
 *   `_GroundPolylinePrimitive` → `._primitive` (`Primitive`)
 *     → `._webgpuGeometryData`
 * (Note: GroundPolylinePrimitive only has ONE level of nesting, unlike
 * GroundPrimitive's two levels through ClassificationPrimitive.)
 *
 * @param {GroundPolylinePrimitive} primitive
 * @returns {Array|undefined}
 * @private
 */
function findGeomDataArray(primitive) {
  return (
    primitive._webgpuGeometryData ??
    primitive._primitive?._webgpuGeometryData ??
    primitive._primitive?._primitive?._webgpuGeometryData
  );
}

/**
 * Pull the appearance color from a GroundPolylinePrimitive. For
 * `PolylineColorAppearance` (per-instance color), the color lives on
 * the geometry instance attribute and isn't accessible without a batch
 * table — return undefined and let the caller fall back to white.
 * For `PolylineMaterialAppearance` the color lives on the material's
 * uniforms.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @returns {Color|undefined}
 * @private
 */
function resolveAppearanceColor(primitive) {
  const appearance = primitive?.appearance;
  if (!appearance) {
    return undefined;
  }
  return appearance.material?.uniforms?.color;
}

/**
 * Material type enumeration for the polyline FS. Mirrors the
 * `materialMeta.x` value the shader expects:
 *
 *   0 — Color (default; uses the per-instance color from the batch
 *       table, or `materialColor` when no per-instance entry exists)
 *   1 — PolylineDash
 *   2 — PolylineGlow
 *   3 — PolylineOutline
 *
 * Materials not in this list fall through to the default Color path.
 * Adding new materials requires (a) a new enum value here, (b) the
 * matching branch in `applyMaterial()` in the WGSL, and (c) packing
 * the material's params into materialParam0/1/2 below.
 *
 * @private
 */
const PolylineMaterialType = Object.freeze({
  COLOR: 0,
  DASH: 1,
  GLOW: 2,
  OUTLINE: 3,
  ARROW: 4,
  STRIPE: 5,
  IMAGE: 6,
  // Batch 97 — extended material support.
  CHECKERBOARD: 7,
  // Generic fallback for unrecognized materials. Reads `uniforms.color`
  // as a tint and (optionally) `uniforms.image` as a modulating texture
  // — recognizes materials whose shape mirrors a known type even if
  // their `type` string is custom (anonymous fabric / shaderSource
  // builds). Strict GLSL→WGSL transpilation is the proper full path
  // (tracked under follow-up); this CUSTOM bucket gives reasonable
  // visual output for the common "tweaked Cesium material" case.
  CUSTOM: 8,
});

// Set of one-time-warned custom-material type strings, keyed on the
// material's `type` field, to avoid log spam when the same custom
// material is used by many polylines on the scene.
const _warnedCustomMaterialTypes = new Set();

/**
 * Inspect the appearance's material (if any) and return a packed
 * material state the shader can consume. Returns the material type
 * and four vec4 slots (color + three params), all expressed as plain
 * Float32-friendly numbers.
 *
 * The detection is by the material's `type` string (set by Cesium's
 * `Material` constructor when the material is built from a known
 * type definition). Custom user materials with bespoke shader source
 * fall back to the default Color path until a generic GLSL→WGSL
 * material transpilation lands as a follow-up.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @returns {{type: number, color: number[], param0: number[], param1: number[], param2: number[]}}
 * @private
 */
function resolveMaterialState(primitive) {
  const fallback = {
    type: PolylineMaterialType.COLOR,
    color: [1.0, 1.0, 1.0, 1.0],
    param0: [0.0, 0.0, 0.0, 0.0],
    param1: [0.0, 0.0, 0.0, 0.0],
    param2: [0.0, 0.0, 0.0, 0.0],
    image: null,
    imageRepeat: [1.0, 1.0],
  };
  const material = primitive?.appearance?.material;
  if (!material) {
    return fallback;
  }
  const type = material.type;
  const uniforms = material.uniforms ?? {};

  // Pull the base color (most polyline materials have one). Cesium
  // Color objects expose .red/.green/.blue/.alpha as floats in [0,1].
  const baseColor = uniforms.color;
  const colorArr = defined(baseColor)
    ? [
        baseColor.red ?? 1.0,
        baseColor.green ?? 1.0,
        baseColor.blue ?? 1.0,
        baseColor.alpha ?? 1.0,
      ]
    : [1.0, 1.0, 1.0, 1.0];

  if (type === "PolylineDash") {
    const gapColor = uniforms.gapColor;
    return {
      type: PolylineMaterialType.DASH,
      color: colorArr,
      param0: [
        uniforms.dashLength ?? 16.0,
        uniforms.dashPattern ?? 255,
        0.0,
        0.0,
      ],
      param1: defined(gapColor)
        ? [
            gapColor.red ?? 0.0,
            gapColor.green ?? 0.0,
            gapColor.blue ?? 0.0,
            gapColor.alpha ?? 0.0,
          ]
        : [0.0, 0.0, 0.0, 0.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  if (type === "PolylineGlow") {
    return {
      type: PolylineMaterialType.GLOW,
      color: colorArr,
      param0: [
        uniforms.glowPower ?? 0.25,
        uniforms.taperPower ?? 1.0,
        0.0,
        0.0,
      ],
      param1: [0.0, 0.0, 0.0, 0.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  if (type === "PolylineArrow") {
    // PolylineArrowMaterial uses a single `color` uniform; the arrow
    // head occupies the last ~15% of the polyline length. We expose
    // the head-start s-coordinate as materialParam0.y so future tuning
    // doesn't require a shader change.
    return {
      type: PolylineMaterialType.ARROW,
      color: colorArr,
      param0: [0.0, 0.85, 0.0, 0.0],
      param1: [0.0, 0.0, 0.0, 0.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  if (type === "Stripe") {
    // StripeMaterial parameters:
    //   evenColor (in `color`)         — the "on" stripe color
    //   oddColor                       — the "off" stripe color
    //   repeat                         — number of stripe pairs over [0, 1]
    //   offset                         — phase shift
    //   orientation                    — Cesium.StripeOrientation.HORIZONTAL (0)
    //                                    or VERTICAL (1)
    const oddColor = uniforms.oddColor;
    const orientation = uniforms.orientation;
    const isVertical =
      orientation === 1 ||
      orientation?.value === 1 ||
      String(orientation) === "VERTICAL";
    return {
      type: PolylineMaterialType.STRIPE,
      color: colorArr,
      param0: [
        uniforms.repeat ?? 5.0,
        uniforms.offset ?? 0.0,
        isVertical ? 1.0 : 0.0,
        0.0,
      ],
      param1: defined(oddColor)
        ? [
            oddColor.red ?? 1.0,
            oddColor.green ?? 1.0,
            oddColor.blue ?? 1.0,
            oddColor.alpha ?? 1.0,
          ]
        : [1.0, 1.0, 1.0, 1.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  if (type === "Image") {
    // ImageMaterial samples a 2D texture; the image source on the
    // material's uniforms is whatever the consumer fed it (URL, ImageData,
    // HTMLImageElement, ...). For WebGPU we let the renderer's texture
    // loader handle the fetch + GPUTexture creation; here we only pack
    // the repeat factor and tint color.
    const repeat = uniforms.repeat;
    return {
      type: PolylineMaterialType.IMAGE,
      color: colorArr,
      param0: [0.0, 0.0, 0.0, 0.0],
      param1: [0.0, 0.0, 0.0, 0.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: uniforms.image ?? null,
      imageRepeat: [
        repeat?.x ?? repeat?.[0] ?? 1.0,
        repeat?.y ?? repeat?.[1] ?? 1.0,
      ],
    };
  }

  if (type === "PolylineOutline") {
    const outlineColor = uniforms.outlineColor;
    return {
      type: PolylineMaterialType.OUTLINE,
      color: colorArr,
      param0: [
        // outlineWidth is in pixels in the WebGL material; expressed
        // as a fraction of the half-width here so the FS comparison
        // (edgeT > 1 - outlineWidth) maps correctly. Default 1px on a
        // typical 8px polyline ≈ 0.125; the WebGL default is 1.0px so
        // we approximate as 0.2 when scale info is unavailable.
        Math.min(1.0, (uniforms.outlineWidth ?? 1.0) * 0.2),
        0.0,
        0.0,
        0.0,
      ],
      param1: defined(outlineColor)
        ? [
            outlineColor.red ?? 0.0,
            outlineColor.green ?? 0.0,
            outlineColor.blue ?? 0.0,
            outlineColor.alpha ?? 1.0,
          ]
        : [0.0, 0.0, 0.0, 1.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  // Batch 97 — Checkerboard. Two-color alternating squares. Uses the
  // `lightColor` uniform as the base color (slot 0) and packs
  // `darkColor` + repeat into the param slots. The shader does the
  // 2D s/t parity test on `(s × repeat.s, edgeT × repeat.t)`.
  if (type === "Checkerboard") {
    const lightColor = uniforms.lightColor;
    const darkColor = uniforms.darkColor;
    const repeat = uniforms.repeat;
    const lightArr = defined(lightColor)
      ? [
          lightColor.red ?? 1.0,
          lightColor.green ?? 1.0,
          lightColor.blue ?? 1.0,
          lightColor.alpha ?? 1.0,
        ]
      : [1.0, 1.0, 1.0, 1.0];
    return {
      type: PolylineMaterialType.CHECKERBOARD,
      color: lightArr,
      param0: [
        repeat?.x ?? repeat?.[0] ?? 5.0,
        repeat?.y ?? repeat?.[1] ?? 1.0,
        0.0,
        0.0,
      ],
      param1: defined(darkColor)
        ? [
            darkColor.red ?? 0.0,
            darkColor.green ?? 0.0,
            darkColor.blue ?? 0.0,
            darkColor.alpha ?? 1.0,
          ]
        : [0.0, 0.0, 0.0, 1.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: null,
      imageRepeat: [1.0, 1.0],
    };
  }

  // Batch 97 — Custom / unknown materials. Inspect the uniform shape
  // and route to the most-similar known path:
  //   - has `image`             → IMAGE-style (texture × tint)
  //   - has `evenColor`+`oddColor` → STRIPE-style fallback
  //   - otherwise               → CUSTOM (color tint, optional image)
  // Logged once per unique type string so users see what's being
  // approximated. Strict GLSL→WGSL transpilation of arbitrary fabric
  // is the long-tail follow-up (see WebGPUNagaTranspiler.ts).
  if (defined(type) && !_warnedCustomMaterialTypes.has(type)) {
    _warnedCustomMaterialTypes.add(type);
    //>>includeStart('debug', pragmas.debug);
    console.warn(
      `[WebGPU:GroundPolyline] custom material type="${type}" not natively ` +
        `supported; rendering as CUSTOM (tint × optional image). Tint reads ` +
        `uniforms.color, modulating image reads uniforms.image. Strict GLSL→` +
        `WGSL transpilation of arbitrary fabric is a separate follow-up.`,
    );
    //>>includeEnd('debug');
  }
  if (defined(uniforms.image)) {
    const repeatU = uniforms.repeat;
    return {
      type: PolylineMaterialType.CUSTOM,
      color: colorArr,
      param0: [1.0, 0.0, 0.0, 0.0], // x: hasImage flag
      param1: [0.0, 0.0, 0.0, 0.0],
      param2: [0.0, 0.0, 0.0, 0.0],
      image: uniforms.image,
      imageRepeat: [
        repeatU?.x ?? repeatU?.[0] ?? 1.0,
        repeatU?.y ?? repeatU?.[1] ?? 1.0,
      ],
    };
  }

  // Color (or unknown without image — fall back to tint-only Color path).
  return {
    type: PolylineMaterialType.COLOR,
    color: colorArr,
    param0: [0.0, 0.0, 0.0, 0.0],
    param1: [0.0, 0.0, 0.0, 0.0],
    param2: [0.0, 0.0, 0.0, 0.0],
    image: null,
    imageRepeat: [1.0, 1.0],
  };
}

/**
 * Pull the polyline width from the first geometry instance. Multi-
 * instance polylines with varied widths are deferred (the shader
 * currently uses a single uniform width). Default to 1.0 when no
 * width is set.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @returns {number}
 * @private
 */
function resolveWidthPixels(primitive) {
  const instances = primitive?.geometryInstances;
  let firstInstance;
  if (Array.isArray(instances)) {
    firstInstance = instances[0];
  } else {
    firstInstance = instances;
  }
  return firstInstance?.geometry?.width ?? 1.0;
}

/**
 * Snapshot per-instance color/width data from the primitive's
 * `geometryInstances` once they're available, caching the values on
 * the renderer cache. Returns the number of instances captured (which
 * the renderer writes into `flags.y` so the shader can bounds-check
 * batchId lookups).
 *
 * Why a snapshot instead of reading every frame: by default
 * `releaseGeometryInstances` is true and the GroundPolylinePrimitive
 * sets `this.geometryInstances = undefined` after its inner Primitive
 * goes ready. Capture data on the first call where instances are
 * still populated.
 *
 * Callers that want per-frame mutation of per-instance attributes will
 * need to plumb the underlying batch table's update events through to
 * invalidate this cache. For first-cut, the snapshot is one-shot.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @param {object} cache  Renderer cache slot (mutated).
 * @returns {boolean} `true` once the snapshot has been captured.
 * @private
 */
/**
 * Ensure the cache has a storage buffer sized for at least
 * `desiredInstances` entries. Grows by reallocation when the request
 * exceeds the current capacity (existing buffer is destroyed and
 * replaced; the new buffer's contents start zeroed and are filled
 * by a subsequent `device.queue.writeBuffer` from the snapshot's
 * Float32Array). Capped at `MAX_BATCH_INSTANCES_HARD_CAP`.
 *
 * @param {GPUDevice} device
 * @param {object} cache
 * @param {number} desiredInstances
 * @private
 */
function ensureBatchInstanceBuffer(device, cache, desiredInstances) {
  const requested = Math.max(
    1,
    Math.min(desiredInstances, MAX_BATCH_INSTANCES_HARD_CAP),
  );
  if (
    defined(cache.batchInstanceBuffer) &&
    cache.batchInstanceBufferCapacity >= requested
  ) {
    return;
  }
  // Round up to a power of two so growth amortises (1 → 32 → 64 →
  // 128 → ...). Keeps reallocations rare even when instance counts
  // climb during scene construction.
  let capacity = INITIAL_BATCH_BUFFER_INSTANCES;
  while (capacity < requested) {
    capacity *= 2;
  }
  capacity = Math.min(capacity, MAX_BATCH_INSTANCES_HARD_CAP);

  if (defined(cache.batchInstanceBuffer)) {
    cache.batchInstanceBuffer.destroy?.();
  }
  cache.batchInstanceBuffer = device.createBuffer({
    label: "GroundPolyline instance data",
    size: capacity * BYTES_PER_BATCH_INSTANCE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  cache.batchInstanceBufferCapacity = capacity;
  // The bind group references the buffer object — invalidate the
  // cache slot so the next createCommands rebuilds with the new buffer.
  cache._bindGroupBufferRef = null;
}

/**
 * Pack the per-instance color/misc Float32Arrays from the snapshot
 * into the storage buffer's interleaved (color, misc) layout that
 * WGSL `InstanceData` expects, then upload via `writeBuffer`.
 *
 * @param {GPUDevice} device
 * @param {object} cache
 * @private
 */
function uploadBatchInstanceData(device, cache) {
  if (
    !defined(cache.batchInstanceBuffer) ||
    !defined(cache.batchColors) ||
    !defined(cache.batchMisc)
  ) {
    return;
  }
  const count = cache.batchInstanceCount ?? 0;
  if (count === 0) {
    return;
  }
  const packed = new Float32Array(count * FLOATS_PER_BATCH_INSTANCE);
  for (let i = 0; i < count; i++) {
    const dst = i * FLOATS_PER_BATCH_INSTANCE;
    const src4 = i * 4;
    packed[dst + 0] = cache.batchColors[src4 + 0];
    packed[dst + 1] = cache.batchColors[src4 + 1];
    packed[dst + 2] = cache.batchColors[src4 + 2];
    packed[dst + 3] = cache.batchColors[src4 + 3];
    packed[dst + 4] = cache.batchMisc[src4 + 0];
    packed[dst + 5] = cache.batchMisc[src4 + 1];
    packed[dst + 6] = cache.batchMisc[src4 + 2];
    packed[dst + 7] = cache.batchMisc[src4 + 3];
  }
  device.queue.writeBuffer(cache.batchInstanceBuffer, 0, packed);
}

/**
 * Allocate a 1×1 RGBA white texture + filtering sampler that sit in
 * the material bind group when no Image material is in use. Created
 * once per cache; not destroyed until the primitive is destroyed.
 *
 * @param {GPUDevice} device
 * @param {object} cache
 * @private
 */
/**
 * Asynchronously load an Image material's `image` uniform into a
 * GPUTexture so the FS can sample it. Accepts URL strings,
 * HTMLImageElement, HTMLCanvasElement, ImageBitmap, and ImageData.
 * Renders with the 1×1 white fallback until the load completes.
 *
 * Subsequent calls with the same `image` source no-op. Calls with a
 * different source kick off a fresh load and swap views once ready.
 *
 * @param {GPUDevice} device
 * @param {object} cache
 * @param {string|HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData|null} imageSource
 * @private
 */
function ensureMaterialImage(device, cache, imageSource) {
  if (!defined(imageSource)) {
    cache._materialImageSource = null;
    cache.materialImageView = undefined;
    return;
  }
  if (cache._materialImageSource === imageSource) {
    return;
  }
  cache._materialImageSource = imageSource;
  cache._materialImageLoading = true;
  cache.materialImageView = undefined;

  const finishLoad = (imageBitmap) => {
    if (cache._materialImageSource !== imageSource) {
      // A newer load superseded this one — drop it on the floor.
      imageBitmap.close?.();
      return;
    }
    const tex = device.createTexture({
      label: "GroundPolyline material image",
      size: {
        width: imageBitmap.width,
        height: imageBitmap.height,
        depthOrArrayLayers: 1,
      },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: tex },
      { width: imageBitmap.width, height: imageBitmap.height },
    );
    cache.materialImageTexture?.destroy?.();
    cache.materialImageTexture = tex;
    cache.materialImageView = tex.createView();
    cache._materialImageLoading = false;
    // Invalidate the material bind group so the next createCommands
    // rebuilds with the new view.
    cache.materialBindGroupViewRef = null;
    imageBitmap.close?.();
  };

  const fail = (err) => {
    if (cache._materialImageSource === imageSource) {
      cache._materialImageLoading = false;
      console.warn(
        "[WebGPU:GroundPolyline] Failed to load Image material source:",
        err,
      );
    }
  };

  if (typeof imageSource === "string") {
    fetch(imageSource)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob))
      .then(finishLoad)
      .catch(fail);
  } else if (imageSource instanceof ImageBitmap) {
    finishLoad(imageSource);
  } else if (
    typeof HTMLImageElement !== "undefined" &&
    imageSource instanceof HTMLImageElement
  ) {
    if (imageSource.complete && imageSource.naturalWidth > 0) {
      createImageBitmap(imageSource).then(finishLoad).catch(fail);
    } else {
      imageSource.addEventListener(
        "load",
        () => createImageBitmap(imageSource).then(finishLoad).catch(fail),
        { once: true },
      );
      imageSource.addEventListener("error", fail, { once: true });
    }
  } else if (
    typeof HTMLCanvasElement !== "undefined" &&
    imageSource instanceof HTMLCanvasElement
  ) {
    createImageBitmap(imageSource).then(finishLoad).catch(fail);
  } else if (
    typeof ImageData !== "undefined" &&
    imageSource instanceof ImageData
  ) {
    createImageBitmap(imageSource).then(finishLoad).catch(fail);
  } else {
    fail(new Error(`unsupported image source type: ${typeof imageSource}`));
  }
}

function ensureFallbackMaterialTexture(device, cache) {
  if (defined(cache.fallbackMaterialTexture)) {
    return;
  }
  cache.fallbackMaterialTexture = device.createTexture({
    label: "GroundPolyline fallback material tex",
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: cache.fallbackMaterialTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  cache.fallbackMaterialView = cache.fallbackMaterialTexture.createView();
  cache.materialSampler = device.createSampler({
    label: "GroundPolyline material sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });
}

function ensureBatchTableSnapshot(primitive, cache) {
  if (cache._batchSnapshotTaken) {
    return true;
  }

  // Two sources for per-instance data:
  //
  //  1. `primitive.geometryInstances` — the original GeometryInstance
  //     array. Defined until the primitive becomes ready, then
  //     released to undefined when `releaseGeometryInstances` is true
  //     (the default). Carries the raw `attributes.color.value`
  //     typed array and `attributes.width.value`.
  //  2. `primitive._primitive._batchTable` — the inner Primitive's
  //     BatchTable. Built by `createBatchTable` in
  //     `Scene/PrimitiveGeometryHelpers.js` once the primitive is
  //     ready. Retains data after instances are released. Indexed
  //     by `_batchTableAttributeIndices.color` /
  //     `_batchTableAttributeIndices.width`.
  //
  // Prefer the BatchTable path when available because the primitive's
  // becoming-ready flow releases `geometryInstances` BEFORE the
  // first WebGPU createCommands call lands, so source (1) is usually
  // already gone by the time we get here.

  const innerPrim = primitive?._primitive;
  const batchTable = innerPrim?._batchTable;
  const attrIndices = innerPrim?._batchTableAttributeIndices;
  if (
    defined(batchTable) &&
    defined(attrIndices) &&
    defined(batchTable._numberOfInstances)
  ) {
    const numberOfInstances = batchTable._numberOfInstances;
    if (numberOfInstances === 0) {
      return false;
    }
    // Storage buffer is unbounded by GPU limits; cap defensively at
    // MAX_BATCH_INSTANCES_HARD_CAP so a runaway count doesn't allocate
    // gigabytes of CPU/GPU memory.
    const cap = Math.min(numberOfInstances, MAX_BATCH_INSTANCES_HARD_CAP);
    const colors = new Float32Array(cap * 4);
    const misc = new Float32Array(cap * 4);

    const colorIndex = attrIndices.color;
    const widthIndex = attrIndices.width;
    const scratch = {};

    // BatchTable's `getBatchedAttribute` returns a `Cartesian4` for
    // 4-component attributes (see `BatchTable.js::getAttributeType`),
    // not the original GeometryInstanceAttribute type. For UNSIGNED_BYTE
    // attributes the values come back in raw [0, 255] range via
    // `Cartesian4.unpack`. We need to know the attribute's component
    // datatype to scale to the [0, 1] range the WGSL shader expects.
    // Tracked-down 2026-04-30 (the bug source for the prior "vsMain
    // off-screen" misdiagnosis — geometry was on-screen all along, but
    // colors uploaded as (1,1,1,1) due to the missing scale path here).
    const colorAttrMeta =
      defined(colorIndex) && defined(batchTable._attributes)
        ? batchTable._attributes[colorIndex]
        : undefined;
    const colorIsU8 =
      colorAttrMeta?.componentDatatype === ComponentDatatype.UNSIGNED_BYTE;
    const colorScale = colorIsU8 ? 1.0 / 255.0 : 1.0;

    for (let i = 0; i < cap; i++) {
      if (defined(colorIndex)) {
        const colorVal = batchTable.getBatchedAttribute(i, colorIndex, scratch);
        // Two possible shapes:
        //   - Cartesian4: `{x, y, z, w}` (UNSIGNED_BYTE in [0, 255]).
        //   - Color:      `{red, green, blue, alpha}` (already in [0, 1]).
        if (defined(colorVal?.x) && defined(colorVal?.w)) {
          colors[i * 4 + 0] = colorVal.x * colorScale;
          colors[i * 4 + 1] = colorVal.y * colorScale;
          colors[i * 4 + 2] = colorVal.z * colorScale;
          colors[i * 4 + 3] = colorVal.w * colorScale;
        } else if (defined(colorVal?.red) && defined(colorVal?.alpha)) {
          colors[i * 4 + 0] = colorVal.red;
          colors[i * 4 + 1] = colorVal.green;
          colors[i * 4 + 2] = colorVal.blue;
          colors[i * 4 + 3] = colorVal.alpha;
        } else {
          colors[i * 4 + 0] = 1.0;
          colors[i * 4 + 1] = 1.0;
          colors[i * 4 + 2] = 1.0;
          colors[i * 4 + 3] = 1.0;
        }
      } else {
        colors[i * 4 + 0] = 1.0;
        colors[i * 4 + 1] = 1.0;
        colors[i * 4 + 2] = 1.0;
        colors[i * 4 + 3] = 1.0;
      }

      let widthPixels;
      if (defined(widthIndex)) {
        const widthVal = batchTable.getBatchedAttribute(i, widthIndex, scratch);
        // For width (typically `componentsPerAttribute=1`),
        // getBatchedAttribute returns the scalar directly.
        if (typeof widthVal === "number") {
          widthPixels = widthVal;
        } else if (defined(widthVal?.x)) {
          widthPixels = widthVal.x;
        }
      }
      misc[i * 4 + 0] = widthPixels ?? 1.0;
      // misc.y/z/w reserved (show, distance display, ...).
    }

    cache._batchSnapshotTaken = true;
    cache.batchInstanceCount = cap;
    cache.batchColors = colors;
    cache.batchMisc = misc;
    return true;
  }

  // Fallback: read directly from `geometryInstances` while it's still
  // populated (rare in practice — the inner primitive's batch table
  // is usually built before the first WebGPU createCommands call).
  const rawInstances = primitive?.geometryInstances;
  if (!defined(rawInstances)) {
    return false;
  }
  const instances = Array.isArray(rawInstances) ? rawInstances : [rawInstances];
  if (instances.length === 0) {
    return false;
  }
  const cap = Math.min(instances.length, MAX_BATCH_INSTANCES_HARD_CAP);
  const colors = new Float32Array(cap * 4);
  const misc = new Float32Array(cap * 4);

  for (let i = 0; i < cap; i++) {
    const inst = instances[i];
    const attrs = inst?.attributes ?? {};
    const colorAttr = attrs.color;
    if (defined(colorAttr) && defined(colorAttr.value)) {
      const v = colorAttr.value;
      const isU8 =
        colorAttr.componentDatatype === ComponentDatatype.UNSIGNED_BYTE;
      const scale = isU8 ? 1.0 / 255.0 : 1.0;
      colors[i * 4 + 0] = (v[0] ?? 0) * scale;
      colors[i * 4 + 1] = (v[1] ?? 0) * scale;
      colors[i * 4 + 2] = (v[2] ?? 0) * scale;
      colors[i * 4 + 3] = (v[3] ?? 255) * scale;
    } else {
      colors[i * 4 + 0] = 1.0;
      colors[i * 4 + 1] = 1.0;
      colors[i * 4 + 2] = 1.0;
      colors[i * 4 + 3] = 1.0;
    }
    const widthAttr = attrs.width;
    misc[i * 4 + 0] =
      (defined(widthAttr) && defined(widthAttr.value)
        ? widthAttr.value[0]
        : inst?.geometry?.width) ?? 1.0;
  }

  cache._batchSnapshotTaken = true;
  cache.batchInstanceCount = cap;
  cache.batchColors = colors;
  cache.batchMisc = misc;
  return true;
}

/**
 * Pull the ellipsoid minimum radius from the frameState's projection.
 * The WebGL shader's `GLOBE_MINIMUM_ALTITUDE` define is set from this
 * at compile time; the WebGPU path passes it as a runtime uniform so
 * we don't need shader recompilation per ellipsoid.
 *
 * @param {FrameState} frameState
 * @returns {number}
 * @private
 */
function resolveGlobeMinimumAltitude(frameState) {
  const ellipsoid = frameState?.mapProjection?.ellipsoid;
  // WGS84 minor axis as a fallback when ellipsoid info isn't published.
  return ellipsoid?.minimumRadius ?? 6356752.3142;
}

/**
 * Build draw commands for a `GroundPolylinePrimitive`. Mirrors
 * `WebGPUGroundPrimitiveRenderer.createWebGPUGroundPrimitiveCommands`'s
 * shape so the consumer in `Scene/GroundPolylinePrimitive.js` can
 * dispatch uniformly.
 *
 * Returns `{ stencilCommand: null, colorCommand, pickCommand }` on
 * success; returns `null` commands on the first frame after pipeline
 * creation kicks off (caller falls through to WebGL) and when no
 * depth source is published yet.
 *
 * @param {GroundPolylinePrimitive} primitive
 * @param {FrameState} frameState
 * @returns {object}
 * @private
 */
function createWebGPUGroundPolylineCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  if (!defined(primitive._webgpuPolylineCache)) {
    primitive._webgpuPolylineCache = {};
  }
  const cache = primitive._webgpuPolylineCache;

  // Batch 110 — invalidate cached pipeline resources on scene format
  // change (HDR toggle).
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  if (
    defined(cache._pipelineResources) &&
    cache._pipelineFormatGeneration !== sceneGen
  ) {
    cache._pipelineResources = undefined;
    cache.bgl = undefined;
  }

  if (!defined(cache._pipelineResources)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache._pipelineResources = buildPolylinePipelineResources(
      device,
      format,
      depthFmt,
    );
    cache.bgl = cache._pipelineResources.bgl;
    cache._pipelineFormatGeneration = sceneGen;
    cache.pipelineRequestPending = false;
  }

  if (
    !tryResolvePolylinePipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return {
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "GroundPolyline uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }

  // Storage buffer for per-instance data (group 0 binding 1). Sized
  // to fit the snapshot's instance count, growing on demand. Even
  // when no instances are populated yet we allocate the initial
  // capacity so the bind group stays valid before the snapshot lands.
  ensureBatchInstanceBuffer(
    device,
    cache,
    cache.batchInstanceCount ?? INITIAL_BATCH_BUFFER_INSTANCES,
  );

  // Fallback 1×1 white material texture + sampler for non-Image
  // materials. The bind-group layout always includes a material
  // texture binding (the FS only samples it for Image materials);
  // having a default texture keeps the bind group valid across all
  // material types without per-material pipeline variants.
  ensureFallbackMaterialTexture(device, cache);

  // Group 0 bind group: UBO + per-instance storage buffer. Re-created
  // when the storage buffer is reallocated for growth.
  if (
    !defined(cache.bindGroup) ||
    cache._bindGroupBufferRef !== cache.batchInstanceBuffer
  ) {
    cache.bindGroup = device.createBindGroup({
      label: "GroundPolyline group0",
      layout: cache.bgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: { buffer: cache.batchInstanceBuffer } },
      ],
    });
    cache._bindGroupBufferRef = cache.batchInstanceBuffer;
  }

  const modelMatrix = primitive.modelMatrix || Matrix4.IDENTITY;
  const color = resolveAppearanceColor(primitive);
  const widthPixels = resolveWidthPixels(primitive);
  const globeMinAlt = resolveGlobeMinimumAltitude(frameState);
  // `_debugShowShadowVolume` is `GroundPolylinePrimitive`'s constructor
  // field that flips a shader define in WebGL; in WebGPU it's a runtime
  // uniform flag so we don't need a separate pipeline variant.
  const debugShowVolume = primitive?._debugShowShadowVolume === true;

  // Snapshot per-instance color/width once geometry instances are
  // available. Returns false on early frames before the primitive's
  // inner geometries finish building — the renderer then falls back
  // to u.color / u.misc.x via the shader's bounds-check.
  const snapshotJustTaken = !cache._batchSnapshotTaken;
  ensureBatchTableSnapshot(primitive, cache);
  if (snapshotJustTaken && cache._batchSnapshotTaken) {
    // Storage-buffer was sized to INITIAL_BATCH_BUFFER_INSTANCES at
    // first-frame allocation; grow it now if the snapshot revealed
    // more instances than that, then upload the packed data once.
    ensureBatchInstanceBuffer(device, cache, cache.batchInstanceCount);
    uploadBatchInstanceData(device, cache);
  }

  // Resolve the active material into a packed state the shader
  // applyMaterial() function consumes. Re-resolved every frame so
  // appearance.material swaps + uniform mutations take effect without
  // needing an explicit invalidate.
  const materialState = resolveMaterialState(primitive);
  // Kick off the Image material's async load if the source changed.
  // Until the load completes the FS samples the 1×1 white fallback
  // (so an Image polyline renders as a plain materialColor tint
  // during the load latency).
  ensureMaterialImage(device, cache, materialState.image);

  // Group 2 bind group: material texture + sampler. Uses the loaded
  // image view when available, the fallback white texture otherwise.
  const activeMaterialView =
    cache.materialImageView ?? cache.fallbackMaterialView;
  if (
    !defined(cache.materialBindGroup) ||
    cache.materialBindGroupViewRef !== activeMaterialView
  ) {
    cache.materialBindGroup = device.createBindGroup({
      label: "GroundPolyline group2 (material)",
      layout: cache._pipelineResources.materialBgl,
      entries: [
        { binding: 0, resource: activeMaterialView },
        { binding: 1, resource: cache.materialSampler },
      ],
    });
    cache.materialBindGroupViewRef = activeMaterialView;
  }

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
    widthPixels,
    globeMinAlt,
    debugShowVolume,
    cache.batchInstanceCount,
    cache.batchColors,
    cache.batchMisc,
    materialState,
  );
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Walk the chain to the primitive's `_webgpuGeometryData`. Same
  // pattern as Batch 81's GroundPrimitive fix; for GroundPolyline the
  // chain is shorter (no ClassificationPrimitive intermediary).
  const geomDataArray = findGeomDataArray(primitive);
  if (!defined(geomDataArray) || geomDataArray.length === 0) {
    return {
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  const geomData = geomDataArray[0];
  const attrs = geomData?.attributes ?? {};
  const posHigh = attrs.position3DHigh?.values;
  const posLow = attrs.position3DLow?.values;
  const startHi = attrs.startHiAndForwardOffsetX?.values;
  const startLo = attrs.startLoAndForwardOffsetY?.values;
  const startNormal = attrs.startNormalAndForwardOffsetZ?.values;
  const endNormal = attrs.endNormalAndTextureCoordinateNormalizationX?.values;
  const rightNormal =
    attrs.rightNormalAndTextureCoordinateNormalizationY?.values;
  const batchIds = attrs.batchId?.values;
  // 2D / Columbus View attributes — present when the geometry was
  // built without `scene3DOnly`. When absent (scene3DOnly viewers) we
  // zero-fill these slots in the interleave; the shader's sceneMode
  // flag stays at 1.0 (3D) so the 2D values are never read.
  const pos2DHigh = attrs.position2DHigh?.values;
  const pos2DLow = attrs.position2DLow?.values;
  const startHiLo2D = attrs.startHiLo2D?.values;
  const offsetAndRight2D = attrs.offsetAndRight2D?.values;
  const startEndNormals2D = attrs.startEndNormals2D?.values;
  const texcoordNormalization2D = attrs.texcoordNormalization2D?.values;

  if (
    !defined(posHigh) ||
    !defined(posLow) ||
    !defined(startHi) ||
    !defined(startLo) ||
    !defined(startNormal) ||
    !defined(endNormal) ||
    !defined(rightNormal)
  ) {
    return {
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  // Build interleaved vertex buffer once. 7 attributes packed into
  // 26-float / 104-byte stride matching the pipeline's vertex layout.
  if (!defined(cache.vertexGPUBuffer)) {
    const numVerts = posHigh.length / 3;
    if (
      posLow.length !== posHigh.length ||
      startHi.length !== numVerts * 4 ||
      startLo.length !== numVerts * 4 ||
      startNormal.length !== numVerts * 4 ||
      endNormal.length !== numVerts * 4 ||
      rightNormal.length !== numVerts * 4
    ) {
      // Attribute lengths disagree — geometry is malformed or attribute
      // batching hasn't completed yet. Skip dispatch this frame.
      return {
        stencilCommand: null,
        colorCommand: null,
        pickCommand: null,
      };
    }

    const interleaved = new Float32Array(numVerts * FLOATS_PER_VERTEX);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * FLOATS_PER_VERTEX;
      const src3 = v * 3;
      const src4 = v * 4;
      // posHigh
      interleaved[dst + 0] = posHigh[src3 + 0];
      interleaved[dst + 1] = posHigh[src3 + 1];
      interleaved[dst + 2] = posHigh[src3 + 2];
      // posLow
      interleaved[dst + 3] = posLow[src3 + 0];
      interleaved[dst + 4] = posLow[src3 + 1];
      interleaved[dst + 5] = posLow[src3 + 2];
      // startHi+forwardX
      interleaved[dst + 6] = startHi[src4 + 0];
      interleaved[dst + 7] = startHi[src4 + 1];
      interleaved[dst + 8] = startHi[src4 + 2];
      interleaved[dst + 9] = startHi[src4 + 3];
      // startLo+forwardY
      interleaved[dst + 10] = startLo[src4 + 0];
      interleaved[dst + 11] = startLo[src4 + 1];
      interleaved[dst + 12] = startLo[src4 + 2];
      interleaved[dst + 13] = startLo[src4 + 3];
      // startNormal+forwardZ
      interleaved[dst + 14] = startNormal[src4 + 0];
      interleaved[dst + 15] = startNormal[src4 + 1];
      interleaved[dst + 16] = startNormal[src4 + 2];
      interleaved[dst + 17] = startNormal[src4 + 3];
      // endNormal+texNormX
      interleaved[dst + 18] = endNormal[src4 + 0];
      interleaved[dst + 19] = endNormal[src4 + 1];
      interleaved[dst + 20] = endNormal[src4 + 2];
      interleaved[dst + 21] = endNormal[src4 + 3];
      // rightNormal+texNormY
      interleaved[dst + 22] = rightNormal[src4 + 0];
      interleaved[dst + 23] = rightNormal[src4 + 1];
      interleaved[dst + 24] = rightNormal[src4 + 2];
      interleaved[dst + 25] = rightNormal[src4 + 3];
      // batchId — defaults to 0 when the geometry doesn't carry one
      // (single-instance primitives where the producer skipped batchId
      // emission). Index 0 then resolves to instanceColors[0] /
      // instanceMisc[0].x, which the CPU-side snapshot fills in from
      // the (sole) instance's attributes.
      interleaved[dst + 26] = defined(batchIds) ? batchIds[v] : 0.0;

      // ── 2D / Columbus View attributes (locs 8-13) ──
      // Zero-fill when absent (scene3DOnly viewers). The VS only
      // reads these in 2D / CV mode, gated by flags.z.
      // position2DHigh (vec3, loc 8)
      interleaved[dst + 27] = defined(pos2DHigh) ? pos2DHigh[src3 + 0] : 0.0;
      interleaved[dst + 28] = defined(pos2DHigh) ? pos2DHigh[src3 + 1] : 0.0;
      interleaved[dst + 29] = defined(pos2DHigh) ? pos2DHigh[src3 + 2] : 0.0;
      // position2DLow (vec3, loc 9)
      interleaved[dst + 30] = defined(pos2DLow) ? pos2DLow[src3 + 0] : 0.0;
      interleaved[dst + 31] = defined(pos2DLow) ? pos2DLow[src3 + 1] : 0.0;
      interleaved[dst + 32] = defined(pos2DLow) ? pos2DLow[src3 + 2] : 0.0;
      // startHiLo2D (vec4, loc 10)
      interleaved[dst + 33] = defined(startHiLo2D)
        ? startHiLo2D[src4 + 0]
        : 0.0;
      interleaved[dst + 34] = defined(startHiLo2D)
        ? startHiLo2D[src4 + 1]
        : 0.0;
      interleaved[dst + 35] = defined(startHiLo2D)
        ? startHiLo2D[src4 + 2]
        : 0.0;
      interleaved[dst + 36] = defined(startHiLo2D)
        ? startHiLo2D[src4 + 3]
        : 0.0;
      // offsetAndRight2D (vec4, loc 11)
      interleaved[dst + 37] = defined(offsetAndRight2D)
        ? offsetAndRight2D[src4 + 0]
        : 0.0;
      interleaved[dst + 38] = defined(offsetAndRight2D)
        ? offsetAndRight2D[src4 + 1]
        : 0.0;
      interleaved[dst + 39] = defined(offsetAndRight2D)
        ? offsetAndRight2D[src4 + 2]
        : 0.0;
      interleaved[dst + 40] = defined(offsetAndRight2D)
        ? offsetAndRight2D[src4 + 3]
        : 0.0;
      // startEndNormals2D (vec4, loc 12)
      interleaved[dst + 41] = defined(startEndNormals2D)
        ? startEndNormals2D[src4 + 0]
        : 0.0;
      interleaved[dst + 42] = defined(startEndNormals2D)
        ? startEndNormals2D[src4 + 1]
        : 0.0;
      interleaved[dst + 43] = defined(startEndNormals2D)
        ? startEndNormals2D[src4 + 2]
        : 0.0;
      interleaved[dst + 44] = defined(startEndNormals2D)
        ? startEndNormals2D[src4 + 3]
        : 0.0;
      // texcoordNormalization2D (vec2, loc 13)
      const src2 = v * 2;
      interleaved[dst + 45] = defined(texcoordNormalization2D)
        ? texcoordNormalization2D[src2 + 0]
        : 0.0;
      interleaved[dst + 46] = defined(texcoordNormalization2D)
        ? texcoordNormalization2D[src2 + 1]
        : 0.0;
    }
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved,
      "GroundPolyline VB",
    );
    cache.vertexCount = numVerts;
  }

  // Index buffer (auto-detect uint16 vs uint32).
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
      label: "GroundPolyline IB",
      size: typed.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.indexGPUBuffer, 0, typed);
    cache.indexCount = indices.length;
  }

  // Pick the classification pass based on the primitive's
  // classificationType (TERRAIN=0, CESIUM_3D_TILE=1, BOTH=2). For
  // BOTH we emit into CESIUM_3D_TILE_CLASSIFICATION (matches the
  // GroundPrimitive renderer's compromise — full split would emit two
  // commands, deferred).
  const classType = primitive?.classificationType ?? 0;
  const groundPass =
    classType === 0
      ? 3 /* TERRAIN_CLASSIFICATION */
      : 6; /* CESIUM_3D_TILE_CLASSIFICATION */

  // Depth source — prefer packed-translucent-depth, fall back to
  // globe-depth. When neither is published yet (first frame), skip
  // dispatch so we don't reference a null view.
  const packedTranslucentView = context._packedTranslucentDepthView ?? null;
  const globeDepthView = context._globeDepthView ?? null;
  const depthSourceView = packedTranslucentView ?? globeDepthView;
  if (!depthSourceView) {
    return {
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
    };
  }

  if (!defined(cache.depthSampleSampler)) {
    cache.depthSampleSampler = device.createSampler({
      label: "GroundPolyline depth-sample sampler",
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
      label: "GroundPolyline depth-sample BG",
      layout: cache._pipelineResources.depthSampleBgl,
      entries: [
        { binding: 0, resource: depthSourceView },
        { binding: 1, resource: cache.depthSampleSampler },
      ],
    });
    cache.depthSampleViewRef = depthSourceView;
  }

  // Per-frustum bind-group resolver — picks up the current depth
  // source at draw time (Session 3 contract). Spans-frustum-boundary
  // primitives get re-resolved per frustum.
  const resolveDepthSampleBindGroup = () => {
    const currentSource =
      context._packedTranslucentDepthView ?? context._globeDepthView;
    if (!currentSource) {
      return null;
    }
    if (cache.depthSampleViewRef !== currentSource) {
      cache.depthSampleBindGroup = device.createBindGroup({
        label: "GroundPolyline depth-sample BG",
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

  // Pick the morph or main pipeline based on scene mode. Morph is
  // its own pipeline (different VS / FS entry points + front-face
  // culling) but shares the same UBO and bind-group layout.
  const isMorphing = frameState?.mode === SceneMode.MORPHING;
  const activeColorPipeline = isMorphing
    ? cache.morphColorPipeline
    : cache.colorPipeline;
  const activePickPipeline = isMorphing
    ? cache.morphPickPipeline
    : cache.pickPipeline;

  const colorCommand = new WebGPUDrawCommand({
    pipeline: activeColorPipeline,
    bindGroups: [
      cache.bindGroup,
      cache.depthSampleBindGroup,
      cache.materialBindGroup,
    ],
    bindGroupResolvers: [undefined, resolveDepthSampleBindGroup, undefined],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    pass: groundPass,
    owner: primitive,
  });

  if (defined(pickColor)) {
    cache.pickCommand = new WebGPUDrawCommand({
      pipeline: activePickPipeline,
      bindGroups: [
        cache.bindGroup,
        cache.depthSampleBindGroup,
        cache.materialBindGroup,
      ],
      bindGroupResolvers: [undefined, resolveDepthSampleBindGroup, undefined],
      vertexBuffers: [cache.vertexGPUBuffer],
      indexBuffer: cache.indexGPUBuffer || undefined,
      indexCount: cache.indexCount || 0,
      indexFormat: cache.indexFormat || "uint16",
      vertexCount: cache.vertexCount || 0,
      pass: groundPass,
      owner: primitive,
      pickOnly: true,
    });
    attachPickToColorCommand(colorCommand, cache.pickCommand);
  }

  return {
    stencilCommand: null,
    colorCommand,
    pickCommand: cache.pickCommand,
  };
}

/**
 * Returns true once the WGSL port has been wired and the renderer can
 * generate real commands. Consumers can feature-detect via this method
 * before relying on `createCommands`.
 *
 * @returns {boolean}
 * @private
 */
function isFullyImplemented() {
  return true;
}

/**
 * Cleanup hook — releases per-primitive cache resources (uniform
 * buffer, vertex buffer, index buffer, sampler, pick IDs).
 *
 * @param {GroundPolylinePrimitive} primitive
 * @private
 */
function destroyWebGPUGroundPolylineResources(primitive) {
  const cache = primitive._webgpuPolylineCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  cache.batchInstanceBuffer?.destroy?.();
  cache.fallbackMaterialTexture?.destroy?.();
  cache.materialImageTexture?.destroy?.();
  destroyPickIds(primitive);
  primitive._webgpuPolylineCache = undefined;
}

const WebGPUGroundPolylineRenderer = {
  createCommands: createWebGPUGroundPolylineCommands,
  destroy: destroyWebGPUGroundPolylineResources,
  isFullyImplemented,
};

export {
  createWebGPUGroundPolylineCommands,
  destroyWebGPUGroundPolylineResources,
  isFullyImplemented,
};
export default WebGPUGroundPolylineRenderer;
