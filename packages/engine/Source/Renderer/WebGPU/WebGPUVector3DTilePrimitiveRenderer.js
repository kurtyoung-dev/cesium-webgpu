/**
 * WebGPU equivalent of `Vector3DTilePrimitive` (3D Tiles vector polygon
 * classification). Handles batched extruded polygon classification meshes
 * generated from vector tile sources — building footprints, admin
 * boundaries, country polygons, etc.
 *
 * Classification uses a WebGL-parity STENCIL Z-FAIL shadow volume
 * (Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL, 2026-07-04). Per batch, per
 * ground pass, TWO draws land in one render pass:
 *   1. A stencil-MARK draw (colorWrite off) that counts the volume∩surface
 *      region into the CLASSIFICATION_MASK stencil bits via
 *      `depthFailOp` decrement-wrap (front) / increment-wrap (back)
 *      against the BOUND scene depth — per-fragment hardware compare at
 *      full precision, terrain compare-always / tileset compare-equal-0x80.
 *   2. A stencil-TESTED color draw (`NOT_EQUAL 0`, depth test off) that
 *      shades exactly that region and resets the bits (passOp zero).
 * This mirrors `Vector3DTilePrimitive.getStencilDepthRenderState` +
 * `colorRenderState`. It supersedes the earlier depth-SAMPLE classifier,
 * which could only reach the volume's inflated PROJECTED silhouette and
 * read empty globe depth at msaa=1 (the two walls documented in
 * NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT). The mark + color pipelines use a
 * group(0)-only layout and never sample the globe depth texture, so they
 * are independent of `_globeDepthView` population. Pick + velocity still
 * use the depth-sample bind group (the same per-frustum globe-depth ↔
 * packed-translucent-depth resolver) and are skipped when it is absent.
 *
 * **Shipped (Batch 112):**
 *   - WGSL VS/FS port of `VectorTileVS.glsl` + `ShadowVolumeFS.glsl`
 *     (RTE-encoded center + RTC-relative positions, batchId attribute).
 *   - Vertex buffer interleave (positionXYZ + batchId, 16 B/vertex).
 *   - Per-batch color via storage buffer indexed by `batchId`.
 *   - Per-batch DrawCommand emission keyed on `_batchedIndices` (offset +
 *     count into the shared index buffer).
 *   - Single shared depth-sample bind group reused across all batches.
 *   - `classificationType` routed to `Pass.TERRAIN_CLASSIFICATION` or
 *     `Pass.CESIUM_3D_TILE_CLASSIFICATION` per the WebGL parity rule.
 *
 * **Deferred to follow-up:**
 *   - Pick containment. The pick path still uses the older depth-SAMPLE
 *     `pickFS` (discards only sky), so a pick over a vector tile hits the
 *     inflated projected silhouette rather than the stencil-clipped
 *     surface∩volume region. Moving pick to the stencil path needs a
 *     stencil-tested pick pipeline in the single-sample pick FB (which
 *     carries its own depth) — the color path's mark/color split ports
 *     over directly. Tracked with NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT.
 *   - SCENE2D / COLUMBUS_VIEW stencil coverage
 *     (NEW-VECTOR3DTILE-STENCIL-2DCV-COVERAGE — the reprojected-ENU map
 *     has no clean Z-fail surface; not a WebGL parity gap since upstream
 *     renders nothing in 2D/CV).
 *   - Per-fragment normal-from-depth-derivative + textured appearance.
 *   - `debugWireframe` mode (the WebGL flow runs a separate
 *     `LINES`-topology pipeline; trivial follow-up).
 *
 * @private
 * @module WebGPUVector3DTilePrimitiveRenderer
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import Cartographic from "../../Core/Cartographic.js";
import defined from "../../Core/defined.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";
import SceneMode from "../../Scene/SceneMode.js";
import csm_depthClamp from "../../Shaders/WebGPU/chunks/functions/csm_depthClamp.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// Slice 5c-B Phase 1 (Batch 113) — scene-FB target helper.
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  sampler as samplerEntry,
  texture as textureEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";

// C-R7-SHADER-MODULE-DEDUP (Batch 163) — per-device cache so multiple visible
// vector tiles share one compiled `GPUShaderModule` for the primitive shader.
const _vectorTilePrimitiveShaderCaches = new WeakMap();

function getVectorTilePrimitiveShaderCache(device) {
  let cache = _vectorTilePrimitiveShaderCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _vectorTilePrimitiveShaderCaches.set(device, cache);
  }
  return cache;
}

const UNIFORM_BUFFER_SIZE = 256;
const FLOATS_PER_BATCH_COLOR = 4;
const BYTES_PER_BATCH_COLOR = FLOATS_PER_BATCH_COLOR * 4;
const INITIAL_BATCH_BUFFER_FEATURES = 64;

const scratchEncodedCenter = new EncodedCartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchView = new Matrix4();
const scratchVPRTE = new Matrix4();

// NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — scratches for the CPU-side
// reprojection of RTC-relative 3D ECEF positions into the SCENE2D /
// COLUMBUS_VIEW planar ENU frame. Unlike GroundPrimitive (which gets
// `position2DHigh/Low` from `GeometryPipeline.projectTo2D`), Vector3DTile
// content carries only the 3D `_positions` RTC pair, so the 2D positions
// are derived here: world = position + _center (ECEF) → cartographic →
// `mapProjection.project` → (projX, projY, height) → ENU `(height, projX,
// projY)` (the `.zxy` swizzle proven in Batch 170 for the GroundPrimitive
// 2D path; matches `camera.positionWC`'s ENU frame under `TRANSFORM_2D`).
const scratchReprojWorld = new Cartesian3();
const scratchReprojCarto = new Cartographic();
const scratchReprojProj = new Cartesian3();
const scratchCenter2D = new Cartesian3();

/**
 * Build the WGSL pipeline resources (BGLs + shader module + descriptors).
 * Done once per device + scene format pair; results live on the cache and
 * are invalidated through `_scenePipelineFormatGeneration` on HDR toggle.
 *
 * Vertex layout: 16 B / vertex.
 *   loc 0: position (vec3<f32>) — RTC-relative to `_center`.
 *   loc 1: batchId (f32)        — index into the per-batch color storage buffer.
 *
 * UBO layout (matches `packUniforms` below):
 *   floats   0-15 : viewProjRTE        (mat4x4<f32>)
 *   floats  16-19 : centerHigh + pad   (vec3 + f32)
 *   floats  20-23 : centerLow  + pad   (vec3 + f32)
 *   floats  24-27 : camHigh    + pad   (vec3 + f32)
 *   floats  28-31 : camLow     + pad   (vec3 + f32)
 *   floats  32-35 : viewport (x,y,w,h) (vec4<f32>)
 *   floats  36-63 : reserved.
 * @private
 */
function buildVectorTilePipelineResources(
  device,
  format,
  depthFormat,
  logDepthActive,
  sampleCount,
  // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick pipelines target the
  // context's byte-object-ID format authority (matches the pick FBO),
  // never the (possibly float/HDR) scene format.
  pickFormat = "rgba8unorm",
) {
  const code = `
${csm_depthClamp}
struct U {
  vpRTE: mat4x4<f32>,
  centerH: vec3<f32>, _p0: f32,
  centerL: vec3<f32>, _p1: f32,
  camH: vec3<f32>, _p2: f32,
  camL: vec3<f32>, _p3: f32,
  viewport: vec4<f32>,
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Currently a layout-only invariant; consumed when the per-renderer
  // motion-vector pass for Vector3DTile classifiers lands (tracked as
  // NEW-ADVANCED-MOTION-VECTORS in DEFERRED_WORK). JS pack writes
  // UniformState.previousViewProjection with column-major identity
  // fallback on the first frame.
  prevViewProjection: mat4x4<f32>,
  // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — renderer-wide log-depth encode
  // frustum (near, far, oneOverLog2FarDepthFromNearPlusOne, reserved). This
  // classification volume depth-TESTS (less-equal) against the shared scene
  // depth, which the globe now LOG-encodes; without writing log z the
  // volume's hyperbolic z fails the test and the entire volume is culled.
  // Packed unconditionally; only the //>>ifdef LOG_DEPTH VS branch reads it.
  logDepth: vec4<f32>,
};
${
  logDepthActive
    ? // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — canonical inline copies. The
      // volume writes per-vertex log z so its hardware less-equal depth test
      // composes with the LOG-depth globe. Mirrors GroundPrimitive colorVS.
      "fn csm_vertexLogDepth(clipPosition: vec4<f32>, near: f32) -> f32 {\n" +
      "  return (clipPosition.w - near) + 1.0;\n" +
      "}\n" +
      "fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {\n" +
      "  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;\n" +
      "}\n"
    : ""
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> batchColors: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> pickColors: array<vec4<f32>>;

@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) col: vec4<f32>,
  @location(1) pickCol: vec4<f32>,
};

@vertex
fn vsMain(
  @location(0) position: vec3<f32>,
  @location(1) batchId: f32,
) -> VOut {
  var o: VOut;
  // RTE: combine the encoded center (high/low) with the camera (high/low).
  // Position is already RTC-relative to center, so the final eye-relative
  // position is centerOffsetFromCamera + position.
  let rte = (u.centerH - u.camH) + (u.centerL - u.camL) + position;
  // czm_depthClamp — matches WebGL VectorTileVS.glsl which wraps the
  // projection in czm_depthClamp(...). Without this, shadow-volume
  // vertices that bracket terrain min/max can shoot past the far plane
  // at oblique angles and get frustum-clipped, dropping the volume.
  o.pos = csm_depthClamp(u.vpRTE * vec4<f32>(rte, 1.0));
${
  logDepthActive
    ? // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — write per-vertex log z so the
      // volume's hardware less-equal depth test composes with the LOG-depth
      // globe. u.logDepth = (encodeNear, encodeFar, factor, _). The factor is
      // derived inline from the encode near/far to match the globe's encoding
      // exactly (mirrors GroundPrimitive colorVS). Coarse per-vertex vs the
      // globe's per-fragment frag_depth, but well within the terrain-height
      // margin the front-face / back-face classification needs.
      "  let _ldNear = u.logDepth.x;\n" +
      "  let _ldFar = u.logDepth.y;\n" +
      "  let _ldFactor = 1.0 / log2((_ldFar - _ldNear) + 1.0);\n" +
      "  let _logZ = csm_writeLogDepth(csm_vertexLogDepth(o.pos, _ldNear), _ldFactor);\n" +
      "  o.pos.z = clamp(_logZ, 0.0, 1.0) * o.pos.w;\n"
    : ""
}
  let bi = u32(batchId);
  o.col = batchColors[bi];
  o.pickCol = pickColors[bi];
  return o;
}

fn unpackDepth(packed: vec4<f32>) -> f32 {
  return dot(packed, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

// Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — WebGL-parity stencil Z-fail
// classifier. Replaces the depth-SAMPLE containment test (which could
// only reach the volume's PROJECTED silhouette and reads empty globe
// depth at msaa=1). The mark FS writes no color (pipeline writeMask 0 on
// every target); its sole side-effect is the pipeline's stencil
// depthFailOp inc/dec against the BOUND scene depth buffer (per-fragment
// hardware compare at full precision). Uses @group(0) only — NO
// depth-texture sample, so it sidesteps both the exp2 precision wall and
// the msaa=1 globe-depth-copy-empty wall documented in
// NEW-VECTOR3DTILE-CLASSIFY-CONTAINMENT. Mirrors
// Vector3DTilePrimitive.getStencilDepthRenderState (front zFail
// decrement-wrap / back zFail increment-wrap).
@fragment
fn classifyMarkFS(i: VOut) -> @location(0) vec4<f32> {
  // AUDIT_2026_05_02 B.1 — per-feature Cesium3DTileFeature.show folded
  // into batchColors[bi].a CPU-side. Hidden features (alpha 0) discard
  // here so they never mark stencil → the color pass draws nothing for
  // them (stencil stays 0). Matches the WebGL show-in-color-alpha path.
  if (i.col.a < 1.0e-3) {
    discard;
  }
  return vec4<f32>(0.0);
}

// Stencil-tested color draw. The pipeline's stencil compare
// (not-equal 0, masked to CLASSIFICATION_MASK) gates fragments to the
// volume∩surface region the mark pass counted; the pipeline's passOp
// zero resets the classification bits so overlapping batches stay
// independent (mirrors colorRenderState in Vector3DTilePrimitive.js).
// No depth sample, no depth test.
@fragment
fn classifyColorFS(i: VOut) -> @location(0) vec4<f32> {
  if (i.col.a < 1.0e-3) {
    discard;
  }
  return i.col;
}

@fragment
fn pickFS(i: VOut) -> @location(0) vec4<f32> {
  // AUDIT_2026_05_02 B.1 -- pick must respect feature.show too;
  // otherwise hidden features are still pickable, which contradicts
  // the WebGL behavior.
  if (i.col.a < 1.0e-3) {
    discard;
  }
  // Same coverage logic as fsMain — only the output channel differs.
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return i.pickCol;
}

// AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER) —
// CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW variant. Sky-discard only —
// deliberately does NOT respect feature.show (that's the whole point of
// the IGNORE_SHOW pass: mark the volume regardless of per-feature visibility).
// Color writes are disabled by the pipeline's writeMask=0; the sole
// side-effect is stencil=0xff via the pipeline's stencil-write state.
@fragment
fn stencilFS(i: VOut) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return vec4<f32>(0.0);
}

// NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — velocity entry
// points for TAA. Vector3DTile classification volumes have static
// per-feature geometry (the tileset content doesn't animate per-cell
// or per-feature), so velocity is camera-only: project the SAME
// world-space position through both the current and previous VPs and
// emit (currNdc - prevNdc) to the rg16float velocity texture. Mirrors
// the Voxel pattern (Batch 173) — same logic, different data shape.
struct VelocityVOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) currClip: vec4<f32>,
  @location(1) prevClip: vec4<f32>,
};

@vertex
fn vsVelocity(
  @location(0) position: vec3<f32>,
  @location(1) batchId: f32,
) -> VelocityVOut {
  var o: VelocityVOut;
  // Current frame: same RTE math as the color VS so the rasterizer
  // walks identical fragments → no spurious half-pixel offsets in the
  // emitted velocity vectors.
  let rte = (u.centerH - u.camH) + (u.centerL - u.camL) + position;
  var curClip = csm_depthClamp(u.vpRTE * vec4<f32>(rte, 1.0));
${
  logDepthActive
    ? // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — the velocity pass shares the
      // scene depth read-only and tests less-equal, so its rasterized z must
      // match the log color pass's z or coverage diverges. Same log-z write.
      "  let _ldNearV = u.logDepth.x;\n" +
      "  let _ldFarV = u.logDepth.y;\n" +
      "  let _ldFactorV = 1.0 / log2((_ldFarV - _ldNearV) + 1.0);\n" +
      "  let _logZV = csm_writeLogDepth(csm_vertexLogDepth(curClip, _ldNearV), _ldFactorV);\n" +
      "  curClip.z = clamp(_logZV, 0.0, 1.0) * curClip.w;\n"
    : ""
}
  // Previous frame: rebuild the absolute world-space position
  // (centerH + centerL + position) and project through prevVP. The
  // prevVP includes the prev-frame translation, so this yields the
  // exact NDC position the previous frame would have rasterized at.
  let worldPos = u.centerH + u.centerL + position;
  let prevClip = u.prevViewProjection * vec4<f32>(worldPos, 1.0);
  o.pos = curClip;
  o.currClip = curClip;
  o.prevClip = prevClip;
  // batchId unused in velocity but kept in the input layout so the
  // same vertex buffer format is consumed without rebinding.
  let _bi = batchId;
  return o;
}

@fragment
fn fsVelocity(i: VelocityVOut) -> @location(0) vec2<f32> {
  let curW = i.currClip.w;
  let prevW = i.prevClip.w;
  // Behind-near-plane fragments contribute zero velocity — the TAA
  // sampler will treat the pixel as static and reuse history without
  // a reprojected sample. Better than emitting NaN-ish division.
  if (curW <= 0.0 || prevW <= 0.0) {
    return vec2<f32>(0.0);
  }
  let curNdc = i.currClip.xy / curW;
  let prevNdc = i.prevClip.xy / prevW;
  return curNdc - prevNdc;
}
`;

  const mod = getVectorTilePrimitiveShaderCache(device).getOrCreate(
    ShaderSourceId.VECTOR_3DTILE_PRIMITIVE,
    code,
    logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    `Vector3DTilePrimitive${logDepthActive ? " [log]" : ""}`,
  );

  // NEW-WEBGPU-PIPELINE-KEY-LOG-DEPTH — `logDepthActive` picks a DIFFERENT
  // `mod` above (the //>>ifdef LOG_DEPTH branch), and every descriptor below
  // uses `mod` for both stages. The central pipeline cache's `generateCacheKey`
  // hashes only the descriptor NAME plus structural fields (ms / depth format /
  // target signature / vertex layout) — never `vertex.module`,
  // `fragment.module`, `entryPoint`, or the define mask. `_pipelineLogDepth`
  // below rebuilds these descriptors on a flip, which is exactly the precondition
  // for aliasing: without this marker the rebuilt log descriptor hits the
  // hyperbolic pipeline already cached under the identical name. Reachable via
  // `scene.morphTo2D()` / `camera.switchToOrthographicFrustum()`, which clear
  // `frameState.useLogDepth`. `ld=` matches the Ocean / Cloud / FlowField
  // spelling.
  const ldFlag = logDepthActive ? 1 : 0;

  const sharedBgl = makeBindGroupLayout(
    device,
    "Vector3DTilePrimitive Shared BGL",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      storageBuffer(1, Stage.VERTEX, { readOnly: true }),
      storageBuffer(2, Stage.VERTEX, { readOnly: true }),
    ],
  );

  const depthSampleBgl = makeBindGroupLayout(
    device,
    "Vector3DTilePrimitive DepthSample BGL",
    [
      textureEntry(0, Stage.FRAGMENT, { sampleType: "float" }),
      samplerEntry(1, Stage.FRAGMENT, "filtering"),
    ],
  );

  const layout = device.createPipelineLayout({
    label: "Vector3DTilePrimitive PipelineLayout",
    bindGroupLayouts: [sharedBgl, depthSampleBgl],
  });

  // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — the stencil mark + color
  // pipelines need only the shared UBO/storage group; they never sample
  // the globe-depth texture (containment is decided by the hardware
  // stencil Z-fail against the BOUND depth buffer). A group(0)-only
  // layout keeps them independent of `_globeDepthView` population (which
  // is empty at msaa=1).
  const classifyLayout = device.createPipelineLayout({
    label: "Vector3DTilePrimitive ClassifyLayout",
    bindGroupLayouts: [sharedBgl],
  });

  const vertexBuffers = [
    {
      arrayStride: 16,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32" },
      ],
    },
  ];

  // ROADMAP s4.2 (B515) — the color + stencil pipelines run inside the
  // multisampled scene pass, so their `multisample.count` MUST match
  // `context._msaaSamples` (4 at viewer defaults) or WebGPU rejects the
  // draw with an attachment-incompatible error and vector tiles render
  // fully black. Mirrors WebGPUGroundPrimitiveRenderer's `msState`
  // (L1372). Pick renders into the single-sample pick FB and velocity
  // into the single-sample rg16float texture, so both stay count-1.
  const msState = sampleCount > 1 ? { count: sampleCount } : undefined;

  // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — stencil-mark descriptor
  // factory. Mirrors `getStencilDepthRenderState(mask3DTiles)`:
  //   - colorMask off  → makeSceneFBTargets writeMask 0 on every slot.
  //   - depthTest LESS_OR_EQUAL, depthMask false → depthCompare
  //     "less-equal", depthWriteEnabled false.
  //   - front zFail DECREMENT_WRAP / back zFail INCREMENT_WRAP → Z-fail
  //     shadow-volume counting against the BOUND scene depth.
  //   - stencilReadMask CESIUM_3D_TILE_MASK (0x80) for the EQUAL compare
  //     (tileset variant); stencilWriteMask CLASSIFICATION_MASK (0x0f)
  //     so inc/dec only touch the low 4 classification bits.
  // `stencilCompare` = "always" for TERRAIN (mask3DTiles=false) or
  // "equal" for 3D-Tile classification (mask3DTiles=true). The stencil
  // reference (0x80) is supplied per-command via renderState.
  const makeMarkDescriptor = (label, stencilCompare) => ({
    name: `Vector3DTilePrimitive ${label} [${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout: classifyLayout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "classifyMarkFS",
      // Color writes off on both scene-color (slot 0) and the MRT
      // G-buffer placeholder (slot 1) — stencil is the only output.
      targets: makeSceneFBTargets(format, { writeMask: 0 }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    multisample: msState,
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
      stencilFront: {
        compare: stencilCompare,
        failOp: "keep",
        depthFailOp: "decrement-wrap",
        passOp: "keep",
      },
      stencilBack: {
        compare: stencilCompare,
        failOp: "keep",
        depthFailOp: "increment-wrap",
        passOp: "keep",
      },
      stencilReadMask: 0x80, // CESIUM_3D_TILE_MASK
      stencilWriteMask: 0x0f, // CLASSIFICATION_MASK
    },
  });
  const stencilMarkTerrainDescriptor = makeMarkDescriptor(
    "stencil-mark terrain",
    "always",
  );
  const stencilMarkTilesetDescriptor = makeMarkDescriptor(
    "stencil-mark tileset",
    "equal",
  );

  // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — stencil-tested color draw.
  // Mirrors `colorRenderState`: stencil NOT_EQUAL 0 (masked to
  // CLASSIFICATION_MASK), all ops ZERO (reset classification bits after
  // the test so overlapping batches stay independent), depth test OFF,
  // depth write OFF, premultiplied-alpha-equivalent src-over blend. Only
  // fragments the mark pass counted (surface∩volume) survive.
  const colorDescriptor = {
    name: `Vector3DTilePrimitive stencil-color [${format}/${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout: classifyLayout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "classifyColorFS",
      targets: makeSceneFBTargets(format, { translucent: true }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "always",
      stencilFront: {
        compare: "not-equal",
        failOp: "zero",
        depthFailOp: "zero",
        passOp: "zero",
      },
      stencilBack: {
        compare: "not-equal",
        failOp: "zero",
        depthFailOp: "zero",
        passOp: "zero",
      },
      stencilReadMask: 0x0f, // CLASSIFICATION_MASK
      stencilWriteMask: 0x0f, // CLASSIFICATION_MASK
    },
    multisample: msState,
  };

  // Pick pipeline: same VS / depth-sample BGL / different FS entry.
  const pickDescriptor = {
    name: `Vector3DTilePrimitive pick [${pickFormat}/${depthFormat}/ld=${ldFlag}]`,
    layout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "pickFS",
      targets: [{ format: pickFormat }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  };

  // AUDIT_2026_05_02 A.2 (Batch 141) — IGNORE_SHOW stencil-write variant.
  // Color writes disabled (writeMask=0); stencil-write replaces with 0xff
  // on every classified-surface pixel the volume covers.
  const stencilDescriptor = {
    name: `Vector3DTilePrimitive stencil [${format}/${depthFormat}/ms=${sampleCount ?? 1}/ld=${ldFlag}]`,
    layout,
    vertex: { module: mod, entryPoint: "vsMain", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "stencilFS",
      targets: [{ format, writeMask: 0 }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    // ROADMAP s4.2 (B515) — stencil-only pipeline still runs in the MSAA
    // scene pass; must carry the same sample count as the color pipeline.
    multisample: msState,
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
  };

  // NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — velocity
  // pipeline descriptor. Same VS bind-group layout as the color
  // pipeline (the FS reads only the per-vertex prevClip/currClip
  // varyings, so no extra storage is needed); the only deltas are:
  //   - Single rg16float color target (matches scene-FB velocity texture)
  //   - No blend (velocity is overwrite, not accumulate)
  //   - Depth read-only (`depthWriteEnabled: false`); the velocity pass
  //     loads depth from the prior color pass for visibility, so
  //     fragments behind opaque content don't emit velocity.
  const velocityDescriptor = {
    name: `Vector3DTilePrimitive velocity [${depthFormat}/ld=${ldFlag}]`,
    layout,
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
    colorDescriptor,
    stencilMarkTerrainDescriptor,
    stencilMarkTilesetDescriptor,
    pickDescriptor,
    stencilDescriptor,
    velocityDescriptor,
    sharedBgl,
    depthSampleBgl,
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

function tryResolvePipelines(device, pipelineCache, resources, cache) {
  if (cache.colorPipeline && cache.pickPipeline && cache.stencilPipeline) {
    return true;
  }
  if (pipelineCache) {
    if (!cache.colorPipeline) {
      const sync = pipelineCache.getPipelineSync(resources.colorDescriptor);
      if (sync) {
        cache.colorPipeline = sync;
      } else if (!cache.colorRequestPending) {
        cache.colorRequestPending = true;
        pipelineCache
          .getPipeline(resources.colorDescriptor)
          .then((p) => {
            cache.colorPipeline = p;
            cache.colorRequestPending = false;
          })
          .catch(() => {
            cache.colorRequestPending = false;
          });
      }
    }
    // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — the two stencil-mark
    // pipelines (terrain compare-always / tileset compare-equal). Both
    // must resolve before a color command is emitted (the color draw is
    // a no-op without the preceding stencil mark). Cache miss is
    // non-fatal per-frame — the color pass is simply skipped this frame
    // until the async pipeline lands.
    if (!cache.markTerrainPipeline) {
      const s = pipelineCache.getPipelineSync(
        resources.stencilMarkTerrainDescriptor,
      );
      if (s) {
        cache.markTerrainPipeline = s;
      } else if (!cache.markTerrainRequestPending) {
        cache.markTerrainRequestPending = true;
        pipelineCache
          .getPipeline(resources.stencilMarkTerrainDescriptor)
          .then((p) => {
            cache.markTerrainPipeline = p;
            cache.markTerrainRequestPending = false;
          })
          .catch(() => {
            cache.markTerrainRequestPending = false;
          });
      }
    }
    if (!cache.markTilesetPipeline) {
      const s = pipelineCache.getPipelineSync(
        resources.stencilMarkTilesetDescriptor,
      );
      if (s) {
        cache.markTilesetPipeline = s;
      } else if (!cache.markTilesetRequestPending) {
        cache.markTilesetRequestPending = true;
        pipelineCache
          .getPipeline(resources.stencilMarkTilesetDescriptor)
          .then((p) => {
            cache.markTilesetPipeline = p;
            cache.markTilesetRequestPending = false;
          })
          .catch(() => {
            cache.markTilesetRequestPending = false;
          });
      }
    }
    if (!cache.pickPipeline) {
      const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
      if (pickSync) {
        cache.pickPipeline = pickSync;
      } else if (!cache.pickRequestPending) {
        cache.pickRequestPending = true;
        pipelineCache
          .getPipeline(resources.pickDescriptor)
          .then((p) => {
            cache.pickPipeline = p;
            cache.pickRequestPending = false;
          })
          .catch(() => {
            cache.pickRequestPending = false;
          });
      }
    }
    if (!cache.stencilPipeline) {
      const stencilSync = pipelineCache.getPipelineSync(
        resources.stencilDescriptor,
      );
      if (stencilSync) {
        cache.stencilPipeline = stencilSync;
      } else if (!cache.stencilRequestPending) {
        cache.stencilRequestPending = true;
        pipelineCache
          .getPipeline(resources.stencilDescriptor)
          .then((p) => {
            cache.stencilPipeline = p;
            cache.stencilRequestPending = false;
          })
          .catch(() => {
            cache.stencilRequestPending = false;
          });
      }
    }
    // NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — velocity
    // pipeline. Cache miss is non-fatal: the color pass continues to
    // render correctly without it; only the velocity-pass dispatch
    // becomes a no-op until the variant lands. Resolved through the
    // central cache so two `Vector3DTilePrimitive` primitives share
    // the GPU pipeline.
    if (!cache.velocityPipeline) {
      const velSync = pipelineCache.getPipelineSync(
        resources.velocityDescriptor,
      );
      if (velSync) {
        cache.velocityPipeline = velSync;
      } else if (!cache.velocityRequestPending) {
        cache.velocityRequestPending = true;
        pipelineCache
          .getPipeline(resources.velocityDescriptor)
          .then((p) => {
            cache.velocityPipeline = p;
            cache.velocityRequestPending = false;
          })
          .catch(() => {
            cache.velocityRequestPending = false;
          });
      }
    }
    return !!cache.colorPipeline;
  }
  if (!cache.colorPipeline) {
    cache.colorPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.colorDescriptor),
    );
  }
  // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — fallback path (no central
  // pipeline cache): build the two mark pipelines synchronously.
  if (!cache.markTerrainPipeline) {
    cache.markTerrainPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.stencilMarkTerrainDescriptor),
    );
  }
  if (!cache.markTilesetPipeline) {
    cache.markTilesetPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.stencilMarkTilesetDescriptor),
    );
  }
  if (!cache.pickPipeline) {
    cache.pickPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.pickDescriptor),
    );
  }
  if (!cache.stencilPipeline) {
    cache.stencilPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.stencilDescriptor),
    );
  }
  // NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — fallback path
  // (no central cache). Same rationale as the cache-driven branch above.
  if (!cache.velocityPipeline) {
    cache.velocityPipeline = device.createRenderPipeline(
      descriptorToGPU(resources.velocityDescriptor),
    );
  }
  return true;
}

function packUniforms(data, frameState, primitive, cache) {
  const uniformState = frameState.context.uniformState;
  Matrix4.clone(uniformState.view, scratchView);
  scratchView[12] = 0.0;
  scratchView[13] = 0.0;
  scratchView[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchView, scratchVPRTE);
  Matrix4.pack(scratchVPRTE, data, 0);

  // NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — mode-branch the encoded
  // center. In SCENE3D the geometry's RTC positions are relative to the
  // 3D ECEF `_center`; in SCENE2D / COLUMBUS_VIEW they're relative to the
  // ENU 2D center (`cache.center2D`, computed in ensureGeometry). The VS
  // math is identical — only the center / bound vertex buffer / `vpRTE`
  // differ by mode. `vpRTE` (above) is already mode-correct
  // (uniformState.view/projection), and the camera below stays
  // `camera.positionWC` which under `TRANSFORM_2D` IS the ENU frame in
  // 2D/CV (matching the reprojected ENU positions).
  const non3D = frameState?.mode !== SceneMode.SCENE3D;
  const centerSource =
    non3D && defined(cache?.center2D) ? cache.center2D : primitive._center;
  EncodedCartesian3.fromCartesian(centerSource, scratchEncodedCenter);
  data[16] = scratchEncodedCenter.high.x;
  data[17] = scratchEncodedCenter.high.y;
  data[18] = scratchEncodedCenter.high.z;
  data[19] = 0.0;
  data[20] = scratchEncodedCenter.low.x;
  data[21] = scratchEncodedCenter.low.y;
  data[22] = scratchEncodedCenter.low.z;
  data[23] = 0.0;

  EncodedCartesian3.fromCartesian(
    frameState.camera.positionWC,
    scratchEncodedCamera,
  );
  data[24] = scratchEncodedCamera.high.x;
  data[25] = scratchEncodedCamera.high.y;
  data[26] = scratchEncodedCamera.high.z;
  data[27] = 0.0;
  data[28] = scratchEncodedCamera.low.x;
  data[29] = scratchEncodedCamera.low.y;
  data[30] = scratchEncodedCamera.low.z;
  data[31] = 0.0;

  // Viewport — source from context.drawingBufferWidth/Height directly.
  // See WebGPUGroundPolylineRenderer.js packUniforms for the full
  // explanation; same bug-pattern (uniformState.viewportCartesian4 is
  // zero-initialized at FR-update time and `??` doesn't fall through on 0).
  // Vector3DTilePrimitive uses viewport in the FS for screenUV =
  // pos.xy / viewport.zw to fetch globe depth. zw=0 → screenUV=NaN →
  // depth sample returns 0 → universal discard (silent rendering failure).
  const ctx = frameState.context;
  data[32] = 0.0;
  data[33] = 0.0;
  data[34] = ctx?.drawingBufferWidth || 1;
  data[35] = ctx?.drawingBufferHeight || 1;

  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at floats
  // 36..51. UniformState swaps `_previousViewProjection := viewProjection`
  // at the END of `update()` AFTER returning the prior frame's value via
  // the getter, so on frame N this slot holds frame N-1's VP. First frame
  // falls through to identity.
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

  // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — log-depth encode frustum at floats
  // 52..55 (near, far, factor, reserved). Prefer the stashed FULL-frustum
  // encode the globe baked with (`_logDepthEncodeNearFar`) over the live
  // per-slice currentFrustum so this volume's per-vertex log z is encoded
  // against the SAME near/far the globe wrote into the shared scene depth
  // (mismatched encode → the less-equal test fails and the volume vanishes).
  // Packed unconditionally; only the LOG_DEPTH VS variant reads it.
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
  data[52] = ldNear;
  data[53] = ldFar;
  data[54] = ldFactor;
  data[55] = 0.0; // reserved
}

function ensureGeometry(cache, primitive, device, frameState) {
  if (defined(cache.vertexGPUBuffer)) {
    return;
  }

  const positions = primitive._positions;
  const vertexBatchIds = primitive._vertexBatchIds;
  if (!defined(positions) || !defined(vertexBatchIds)) {
    return;
  }

  const numVerts = positions.length / 3;
  if (numVerts === 0) {
    return;
  }

  // Interleave position (3f) + batchId (1f) into 16-byte stride.
  // The CPU-side `_positions` and `_vertexBatchIds` arrays are released
  // after VAO creation in the WebGL path; we cache the GPU buffer here so
  // subsequent frames don't re-upload.
  const interleaved = new Float32Array(numVerts * 4);
  for (let v = 0; v < numVerts; v++) {
    const dst = v * 4;
    const src = v * 3;
    interleaved[dst] = positions[src];
    interleaved[dst + 1] = positions[src + 1];
    interleaved[dst + 2] = positions[src + 2];
    interleaved[dst + 3] = vertexBatchIds[v];
  }
  cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
    device,
    interleaved,
    "Vector3DTilePrimitive VB",
  );
  cache.vertexCount = numVerts;

  // NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — build the SCENE2D /
  // COLUMBUS_VIEW vertex buffer alongside the 3D one, while `_positions`
  // is still available (it may be released after this first build, and
  // `ensureGeometry` early-returns once `vertexGPUBuffer` exists — so both
  // buffers MUST be produced in this single pass). Each vertex is
  // reprojected from its RTC-relative 3D ECEF position into the planar ENU
  // frame, then re-expressed RTC-relative to a 2D center so the SAME
  // mode-agnostic VS math (`(centerH-camH)+(centerL-camL)+position`) holds
  // with the 2D center / 2D camera / mode-correct `vpRTE` packed in
  // `packUniforms`. Skipped for `scene3DOnly` scenes (no 2D attributes
  // needed). The reprojection mirrors `GeometryPipeline.projectTo2D` +
  // the Batch 170 GroundPrimitive ENU `.zxy` convention.
  const projection = frameState?.mapProjection;
  const ellipsoid = projection?.ellipsoid;
  if (frameState?.scene3DOnly || !projection || !ellipsoid) {
    return;
  }

  // 2D center = ENU of the tileset center's projected coordinates.
  // `_center` is the absolute ECEF tileset center.
  const centerCarto = ellipsoid.cartesianToCartographic(
    primitive._center,
    scratchReprojCarto,
  );
  if (!defined(centerCarto)) {
    return; // center at Earth's center / degenerate — skip 2D buffer
  }
  const centerProj = projection.project(centerCarto, scratchReprojProj);
  // ENU frame: (height, projX, projY) = projected.(z, x, y).
  scratchCenter2D.x = centerProj.z;
  scratchCenter2D.y = centerProj.x;
  scratchCenter2D.z = centerProj.y;
  cache.center2D = Cartesian3.clone(scratchCenter2D, cache.center2D);

  const interleaved2D = new Float32Array(numVerts * 4);
  for (let v = 0; v < numVerts; v++) {
    const src = v * 3;
    // world = RTC position + center (absolute ECEF).
    scratchReprojWorld.x = positions[src] + primitive._center.x;
    scratchReprojWorld.y = positions[src + 1] + primitive._center.y;
    scratchReprojWorld.z = positions[src + 2] + primitive._center.z;
    const carto = ellipsoid.cartesianToCartographic(
      scratchReprojWorld,
      scratchReprojCarto,
    );
    const dst = v * 4;
    if (!defined(carto)) {
      // Degenerate vertex (shouldn't happen for real tile geometry);
      // collapse to the 2D center so it contributes nothing.
      interleaved2D[dst] = 0.0;
      interleaved2D[dst + 1] = 0.0;
      interleaved2D[dst + 2] = 0.0;
      interleaved2D[dst + 3] = vertexBatchIds[v];
      continue;
    }
    const proj = projection.project(carto, scratchReprojProj);
    // ENU (height, projX, projY) then RTC-relative to the 2D center.
    interleaved2D[dst] = proj.z - scratchCenter2D.x;
    interleaved2D[dst + 1] = proj.x - scratchCenter2D.y;
    interleaved2D[dst + 2] = proj.y - scratchCenter2D.z;
    interleaved2D[dst + 3] = vertexBatchIds[v];
  }
  cache.vertexGPUBuffer2D = WebGPUBuffer.createVertexBuffer(
    device,
    interleaved2D,
    "Vector3DTilePrimitive VB 2D",
  );
}

function ensureIndexBuffer(cache, primitive, device) {
  if (defined(cache.indexGPUBuffer) && !cache._indexDirty) {
    return;
  }

  const indices = primitive._indices;
  if (!defined(indices)) {
    return;
  }

  const max = indices.length > 0 ? primitive._positions.length / 3 : 0;
  const needsU32 = max > 0xffff || indices.BYTES_PER_ELEMENT === 4;
  const typed = needsU32 ? new Uint32Array(indices) : new Uint16Array(indices);
  cache.indexFormat = needsU32 ? "uint32" : "uint16";

  if (defined(cache.indexGPUBuffer)) {
    cache.indexGPUBuffer.destroy();
  }
  cache.indexGPUBuffer = device.createBuffer({
    label: "Vector3DTilePrimitive IB",
    size: typed.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(cache.indexGPUBuffer, 0, typed);
  cache.indexBufferLength = indices.length;
  cache._indexDirty = false;
}

function ensureBatchColorStorage(cache, primitive, device) {
  // Storage buffer is indexed by batchId, so its capacity must cover the
  // largest batchId in `_vertexBatchIds`. The batch table's feature count
  // is the upper bound; fall back to scanning vertex batchIds if no
  // batch table is wired (rare).
  const featuresLength =
    primitive._batchTable?.featuresLength ??
    primitive._batchIds?.length ??
    INITIAL_BATCH_BUFFER_FEATURES;

  const requiredBytes = Math.max(
    featuresLength * BYTES_PER_BATCH_COLOR,
    INITIAL_BATCH_BUFFER_FEATURES * BYTES_PER_BATCH_COLOR,
  );

  if (
    defined(cache.batchColorBuffer) &&
    cache.batchColorBufferCapacity >= requiredBytes
  ) {
    return;
  }

  if (defined(cache.batchColorBuffer)) {
    cache.batchColorBuffer.destroy();
  }
  cache.batchColorBuffer = device.createBuffer({
    label: "Vector3DTilePrimitive batch colors",
    size: requiredBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  cache.batchColorBufferCapacity = requiredBytes;
  cache.batchColorScratch = new Float32Array(requiredBytes / 4);
  cache._sharedBindGroupDirty = true;
}

function uploadBatchColors(cache, primitive, device) {
  const scratch = cache.batchColorScratch;
  if (!defined(scratch)) {
    return;
  }
  scratch.fill(0);

  // Walk the batch table feature colors. For each feature, write its color
  // into `scratch[batchId * 4 .. batchId * 4 + 3]`. The batch table's
  // `getBatchedAttributes` style API isn't uniform across consumers; the
  // safe path is to iterate `_batchedIndices` and stamp each batch's color
  // into all of its `batchIds`.
  const batchedIndices = primitive._batchedIndices;
  if (defined(batchedIndices)) {
    for (let i = 0; i < batchedIndices.length; i++) {
      const entry = batchedIndices[i];
      const color = entry.color;
      const ids = entry.batchIds ?? [];
      const r = color.red;
      const g = color.green;
      const b = color.blue;
      const a = color.alpha;
      for (let j = 0; j < ids.length; j++) {
        const id = ids[j];
        const slot = id * 4;
        if (slot + 3 < scratch.length) {
          scratch[slot] = r;
          scratch[slot + 1] = g;
          scratch[slot + 2] = b;
          scratch[slot + 3] = a;
        }
      }
    }
  }

  // AUDIT_2026_05_02 B.1 — honor per-feature `Cesium3DTileFeature.show`.
  // The WebGL Vector3DTile path packs `_showAlphaProperties` and reads it
  // in the VS via `czm_batchTable_show(batchId)`. The WebGPU path didn't
  // consume `show` at all; setting `tileset.getFeature(i).show = false`
  // had no visual effect. We fold show into the per-batch alpha here so
  // the existing color-discard branch in fsMain (added below) hides the
  // feature without needing a second storage buffer.
  const batchTable = primitive._batchTable;
  if (defined(batchTable) && typeof batchTable.getShow === "function") {
    const featuresLength = batchTable.featuresLength ?? 0;
    for (let id = 0; id < featuresLength; id++) {
      const slot = id * 4 + 3;
      if (slot >= scratch.length) {
        break;
      }
      if (!batchTable.getShow(id)) {
        scratch[slot] = 0.0;
      }
    }
  }

  device.queue.writeBuffer(
    cache.batchColorBuffer,
    0,
    scratch.buffer,
    scratch.byteOffset,
    cache.batchColorBufferCapacity,
  );
}

function ensurePickColorStorage(cache, primitive, device) {
  // Mirror of `ensureBatchColorStorage`. Required at @group(0) @binding(2)
  // even when the pick pipeline isn't running this frame — WebGPU forbids
  // partial bind groups.
  const featuresLength =
    primitive._batchTable?.featuresLength ??
    primitive._batchIds?.length ??
    INITIAL_BATCH_BUFFER_FEATURES;
  const requiredBytes = Math.max(
    featuresLength * BYTES_PER_BATCH_COLOR,
    INITIAL_BATCH_BUFFER_FEATURES * BYTES_PER_BATCH_COLOR,
  );

  if (
    defined(cache.pickColorBuffer) &&
    cache.pickColorBufferCapacity >= requiredBytes
  ) {
    return;
  }
  if (defined(cache.pickColorBuffer)) {
    cache.pickColorBuffer.destroy();
  }
  cache.pickColorBuffer = device.createBuffer({
    label: "Vector3DTilePrimitive pick colors",
    size: requiredBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  cache.pickColorBufferCapacity = requiredBytes;
  cache.pickColorScratch = new Float32Array(requiredBytes / 4);
  cache._sharedBindGroupDirty = true;
  cache._pickColorsUploaded = false;
}

function uploadPickColors(cache, primitive, device) {
  const scratch = cache.pickColorScratch;
  if (!defined(scratch)) {
    return;
  }
  scratch.fill(0);

  const batchTable = primitive._batchTable;
  if (defined(batchTable) && typeof batchTable.getPickColor === "function") {
    const length = batchTable.featuresLength ?? 0;
    for (let i = 0; i < length; i++) {
      const pickId = batchTable.getPickColor(i);
      const color = pickId?.color;
      if (!defined(color)) {
        continue;
      }
      const slot = i * 4;
      if (slot + 3 < scratch.length) {
        scratch[slot] = color.red;
        scratch[slot + 1] = color.green;
        scratch[slot + 2] = color.blue;
        scratch[slot + 3] = color.alpha;
      }
    }
  }

  device.queue.writeBuffer(
    cache.pickColorBuffer,
    0,
    scratch.buffer,
    scratch.byteOffset,
    cache.pickColorBufferCapacity,
  );
}

/**
 * Creates per-batch DrawCommands for a Vector3DTilePrimitive.
 * Returns `{ colorCommands: [...] }` (an array since each batch is a
 * separate draw with its own offset+count). The Scene-side
 * `Vector3DTilePrimitive.update` pushes each command onto `commandList`.
 *
 * @private
 */
function createWebGPUVector3DTilePrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  // NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — SCENE2D + COLUMBUS_VIEW now
  // render via a CPU-reprojected ENU 2D vertex buffer (built in
  // ensureGeometry) + mode-branched center packing (packUniforms); the VS
  // math is mode-agnostic. MORPHING still returns no commands: the morph
  // blend needs BOTH the 3D and 2D positions interpolated in EC space (the
  // GroundPrimitive morphColorVS pattern), which is a separate slice. The
  // original Batch 150 gate (skip ALL non-3D) is therefore narrowed to
  // MORPHING-only.
  const sceneMode = frameState?.mode;
  if (sceneMode === SceneMode.MORPHING) {
    //>>includeStart('debug', pragmas.debug);
    oneTimeWarning(
      "WebGPUVector3DTilePrimitive.morphing",
      "Vector3DTilePrimitive on WebGPU renders in SCENE3D, SCENE2D, and " +
        "COLUMBUS_VIEW (Batch 178). MORPHING is still skipped pending the " +
        "3D↔2D EC-space blend — tracked as NEW-CLASSIFIER-2D-CV-MORPH.",
    );
    //>>includeEnd('debug');
    return { colorCommands: [], pickCommands: [], ignoreShowCommands: [] };
  }

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {};
  }
  const cache = primitive._webgpuCache;

  // HDR-toggle invalidation (Batch 110 pattern).
  const sceneGen = context._scenePipelineFormatGeneration ?? 0;
  // NEW-CLASSIFIER-LOG-DEPTH (Batch 266) — the LOG_DEPTH master switch (or a
  // frame toggling frameState.useLogDepth) flips the VS log-z write, so the
  // shader module + every pipeline variant must rebuild. Mirrors the
  // GroundPrimitive `_pipelineLogDepth` flip guard.
  const logDepthActive = isWebGPULogDepthActive(context, frameState);
  if (
    defined(cache._pipelineResources) &&
    (cache._pipelineFormatGeneration !== sceneGen ||
      cache._pipelineLogDepth !== logDepthActive)
  ) {
    cache._pipelineResources = undefined;
    cache.colorPipeline = undefined;
    // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — stencil-mark pipelines are
    // built against the same scene format / msaa / log-depth generation,
    // so they invalidate together with the color pipeline.
    cache.markTerrainPipeline = undefined;
    cache.markTilesetPipeline = undefined;
    cache.pickPipeline = undefined;
    cache.stencilPipeline = undefined;
    // NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — velocity
    // pipeline targets `rg16float` (the scene-FB velocity texture
    // format), which doesn't change with HDR / canvas-format flips —
    // but keeping this in the invalidation set mirrors the other
    // pipelines' lifecycle and costs nothing (the pipeline cache
    // memoizes the descriptor → GPU pipeline mapping).
    cache.velocityPipeline = undefined;
    cache.sharedBindGroup = undefined;
    cache.depthSampleBindGroup = undefined;
  }

  if (!defined(cache._pipelineResources)) {
    const format = context.scenePipelineFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    const sampleCount = context._msaaSamples ?? 1;
    cache._pipelineResources = buildVectorTilePipelineResources(
      device,
      format,
      depthFmt,
      logDepthActive,
      sampleCount,
      // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — pick target format authority.
      context.pickPipelineFormat || "rgba8unorm",
    );
    cache._pipelineFormatGeneration = sceneGen;
    cache._pipelineLogDepth = logDepthActive;
    cache.colorRequestPending = false;
    cache.markTerrainRequestPending = false;
    cache.markTilesetRequestPending = false;
    cache.pickRequestPending = false;
    cache.stencilRequestPending = false;
    // NEW-ADVANCED-MOTION-VECTORS classifiers (Batch 178) — Batch 179
    // cleanup. Init parity with the other pending flags. Defensive
    // falsy-check at line ~522 made the missing init non-fatal, but
    // the symmetry matters when format-invalidation re-runs this block
    // and stale `velocityRequestPending = true` would block the next
    // resolve attempt.
    cache.velocityRequestPending = false;
  }

  if (
    !tryResolvePipelines(
      device,
      context.webgpuPipelineCache ?? null,
      cache._pipelineResources,
      cache,
    )
  ) {
    return { colorCommands: [], pickCommands: [], ignoreShowCommands: [] };
  }

  // Allocate the shared UBO + storage buffer + bind group on first use.
  if (!defined(cache.uniformBuffer)) {
    cache.uniformBuffer = WebGPUBuffer.createUniformBuffer(
      device,
      UNIFORM_BUFFER_SIZE,
      "Vector3DTilePrimitive uniforms",
    );
    cache.uniformData = new Float32Array(UNIFORM_BUFFER_SIZE / 4);
  }
  ensureBatchColorStorage(cache, primitive, device);
  ensurePickColorStorage(cache, primitive, device);
  if (cache._sharedBindGroupDirty || !defined(cache.sharedBindGroup)) {
    cache.sharedBindGroup = device.createBindGroup({
      label: "Vector3DTilePrimitive shared BG",
      layout: cache._pipelineResources.sharedBgl,
      entries: [
        { binding: 0, resource: { buffer: cache.uniformBuffer.buffer } },
        { binding: 1, resource: { buffer: cache.batchColorBuffer } },
        { binding: 2, resource: { buffer: cache.pickColorBuffer } },
      ],
    });
    cache._sharedBindGroupDirty = false;
  }

  // Vertex + index buffers from the primitive's CPU-side arrays.
  ensureGeometry(cache, primitive, device, frameState);
  ensureIndexBuffer(cache, primitive, device);
  if (!defined(cache.vertexGPUBuffer) || !defined(cache.indexGPUBuffer)) {
    return { colorCommands: [], pickCommands: [] };
  }
  // NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — in non-3D modes bind the
  // reprojected ENU 2D vertex buffer. If the 2D buffer is missing (e.g.
  // scene3DOnly, or a degenerate center), fall back to skipping this frame
  // rather than drawing the 3D-ECEF positions through the 2D projection
  // (which would produce wandering volumes — the failure mode the Batch
  // 150 gate originally guarded against).
  const non3D = sceneMode !== SceneMode.SCENE3D;
  const activeVertexBuffer = non3D
    ? cache.vertexGPUBuffer2D
    : cache.vertexGPUBuffer;
  if (!defined(activeVertexBuffer)) {
    return { colorCommands: [], pickCommands: [] };
  }

  // Per-frame uniform + per-batch color upload.
  packUniforms(cache.uniformData, frameState, primitive, cache);
  device.queue.writeBuffer(
    cache.uniformBuffer.buffer,
    0,
    cache.uniformData.buffer,
    0,
    UNIFORM_BUFFER_SIZE,
  );

  // Re-upload batch colors when the dirty flag indicates a re-batch (Vector3DTile
  // shuffles indices on color changes; the storage-buffer contents track the
  // current batchId → color mapping).
  // AUDIT_2026_05_02 B.1 — also re-upload when the batch table reports
  // dirty values (e.g., per-feature `show` toggle); without this the
  // upload only fires on color changes and `feature.show = false` would
  // sit in the texture without ever reaching the storage buffer.
  // (Audit-rereview correction 2026-05-02: the dirty flag lives on the
  // batchTable's _batchTexture, not on _batchTable directly. See
  // `Cesium3DTileBatchTable.setShow → _batchTexture.setShow` and
  // `BatchTexture._batchValuesDirty`. The earlier path always read
  // undefined and never triggered re-upload after the first frame.)
  const batchValuesDirty =
    primitive._batchTable?._batchTexture?._batchValuesDirty === true;
  if (
    primitive._batchDirty ||
    primitive._batchColorsDirty ||
    batchValuesDirty ||
    !cache._batchColorsUploaded
  ) {
    uploadBatchColors(cache, primitive, device);
    cache._batchColorsUploaded = true;
    primitive._batchColorsDirty = false;
  }
  if (!cache._pickColorsUploaded) {
    uploadPickColors(cache, primitive, device);
    cache._pickColorsUploaded = true;
  }

  // Depth-source resolver (per-frustum bind-group rebuild on view change).
  // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — the stencil MARK+COLOR
  // classify path does NOT sample this texture (containment is decided by
  // the hardware stencil Z-fail against the bound depth), so a missing
  // globe-depth view no longer bails the whole primitive. It only gates
  // the depth-SAMPLE consumers that remain: pick + velocity. When the
  // view is absent (e.g. globe-depth framebuffer disabled) those two are
  // skipped while classification still renders.
  const packedTranslucentView = context._packedTranslucentDepthView ?? null;
  const globeDepthView = context._globeDepthView ?? null;
  const picking =
    frameState.passes?.pick === true || frameState.passes?.pickVoxel === true;
  const depthSourceView = picking
    ? context._pickClassificationDepthView
    : (packedTranslucentView ?? globeDepthView);
  if (defined(depthSourceView)) {
    if (!defined(cache.depthSampleSampler)) {
      cache.depthSampleSampler = device.createSampler({
        label: "Vector3DTilePrimitive depth-sample sampler",
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
        label: "Vector3DTilePrimitive depth-sample BG",
        layout: cache._pipelineResources.depthSampleBgl,
        entries: [
          { binding: 0, resource: depthSourceView },
          { binding: 1, resource: cache.depthSampleSampler },
        ],
      });
      cache.depthSampleViewRef = depthSourceView;
    }
  }
  const resolveDepthSampleBindGroup = () => {
    const currentSource = picking
      ? context._pickClassificationDepthView
      : (context._packedTranslucentDepthView ?? context._globeDepthView);
    if (!currentSource) {
      return null;
    }
    if (cache.depthSampleViewRef !== currentSource) {
      cache.depthSampleBindGroup = device.createBindGroup({
        label: "Vector3DTilePrimitive depth-sample BG",
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

  // Pick the classification pass(es) based on `classificationType`.
  // ClassificationType: TERRAIN=0, CESIUM_3D_TILE=1, BOTH=2.
  // Pass enum:          TERRAIN_CLASSIFICATION=3, CESIUM_3D_TILE_CLASSIFICATION=6.
  // AUDIT_2026_05_02 A.3 (Batch 145) — emit one command per relevant
  // pass. Pre-fix, BOTH collapsed to pass 6 so a tile primitive set to
  // BOTH classified 3D Tiles but never terrain (or vice versa for the
  // earlier code that used pass 3). Mirror the
  // `WebGPUVector3DTileClampedPolylinesRenderer.js` pass-list pattern
  // so BOTH emits TWO commands per batch — one to pass 3, one to pass
  // 6 — and the existing IGNORE_SHOW emission only fires for the 3D
  // Tile half (invert classification doesn't apply to terrain).
  const classType = primitive.classificationType ?? 0;
  const groundPasses = [];
  if (classType === 0 /* TERRAIN */ || classType === 2 /* BOTH */) {
    groundPasses.push(3 /* TERRAIN_CLASSIFICATION */);
  }
  if (classType === 1 /* CESIUM_3D_TILE */ || classType === 2 /* BOTH */) {
    groundPasses.push(6 /* CESIUM_3D_TILE_CLASSIFICATION */);
  }

  // Emit one color DrawCommand per `_batchedIndices` entry × per
  // requested pass. Each entry already encodes its index `offset` (in
  // indices) and `count`. The shared vertex/index buffers + per-batch-
  // color storage buffer mean we don't need separate per-batch resource
  // bindings — the only per-command state is the index range and pass.
  const batchedIndices = primitive._batchedIndices ?? [];
  const totalIndices = cache.indexBufferLength ?? 0;
  const colorCommands = [];
  const pickCommands = [];
  // AUDIT_2026_05_02 A.2 (Batch 141, NEW-INVERT-CLASS-STENCIL-CLASSIFIER) —
  // IGNORE_SHOW stencil-write commands, one per batch. Only emitted when
  // the primitive participates in 3D Tile classification (BOTH or
  // CESIUM_3D_TILE — captured by the `groundPasses.includes(6)` check
  // below). The Vector3DTilePrimitive dispatch site pushes these
  // alongside `colorCommands` when `frameState.invertClassification` is
  // true.
  const ignoreShowCommands = [];
  const emitsThreeDTileClassification = groundPasses.includes(6);
  for (let i = 0; i < batchedIndices.length; i++) {
    const entry = batchedIndices[i];
    const offset = entry.offset | 0;
    const count = entry.count | 0;
    if (count <= 0) {
      continue;
    }
    if (offset < 0 || offset + count > totalIndices) {
      continue;
    }

    const sharedDrawArgs = {
      bindGroups: [cache.sharedBindGroup, cache.depthSampleBindGroup],
      bindGroupResolvers: [undefined, resolveDepthSampleBindGroup],
      // Batch 178 — 3D ECEF buffer in SCENE3D, reprojected ENU 2D buffer
      // in SCENE2D / COLUMBUS_VIEW (NEW-CLASSIFIER-2D-CV-MORPH).
      vertexBuffers: [activeVertexBuffer],
      indexBuffer: cache.indexGPUBuffer,
      indexFormat: cache.indexFormat,
      indexCount: count,
      firstIndex: offset,
      vertexCount: 0,
      owner: primitive,
    };
    // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — the stencil mark + color
    // pipelines use the group(0)-only ClassifyLayout, so their commands
    // bind ONLY the shared UBO/storage group (no depth-sample texture).
    const classifyDrawArgs = {
      bindGroups: [cache.sharedBindGroup],
      vertexBuffers: [activeVertexBuffer],
      indexBuffer: cache.indexGPUBuffer,
      indexFormat: cache.indexFormat,
      indexCount: count,
      firstIndex: offset,
      vertexCount: 0,
      owner: primitive,
    };
    // NEW-ADVANCED-MOTION-VECTORS classifiers / Batch 178 — derive a
    // velocity command alongside the color command when TAA is on.
    // Mirrors the Voxel pattern (Batch 173) and the advanced family
    // collectively (Batches 168-173): the velocity pass walks the
    // command list for `cmd.velocityCommand` and dispatches into the
    // single-target rg16float render pass sharing scene depth read-only.
    // Skip on classifier IGNORE_SHOW emission (only the primary
    // classification passes need motion vectors; IGNORE_SHOW writes
    // stencil-only and isn't visible content).
    const taaEnabled = frameState?.taaEnabled === true;

    for (let p = 0; p < groundPasses.length; p++) {
      const passEnum = groundPasses[p];
      // Q15R-VECTOR3DTILE-CONTAINMENT-STENCIL — WebGL-parity two-draw
      // stencil Z-fail. Per batch, per pass: (1) a stencil-MARK draw that
      // counts the volume∩surface region into the CLASSIFICATION_MASK
      // bits of the BOUND scene stencil (terrain compare-always for pass
      // 3 / tileset compare-equal-0x80 for pass 6), then (2) a
      // stencil-TESTED color draw (NOT_EQUAL 0) that shades exactly that
      // region and resets the bits. Both land in the SAME pass bucket
      // (TERRAIN_CLASSIFICATION=3 or CESIUM_3D_TILE_CLASSIFICATION=6) and
      // execute in push order within one render pass, so the stencil
      // written by the mark is visible to the immediately-following color
      // draw. Mirrors Vector3DTilePrimitive.createColorCommands, which
      // interleaves commands[j*2]=stencilDepth, commands[j*2+1]=color.
      const markPipeline =
        passEnum === 6 ? cache.markTilesetPipeline : cache.markTerrainPipeline;
      if (!defined(markPipeline) || !defined(cache.colorPipeline)) {
        // Pipelines still resolving asynchronously — skip this pass's
        // color this frame (the mark is a hard prerequisite for the
        // stencil-tested color draw). Retried next frame.
        continue;
      }
      // Stencil reference CESIUM_3D_TILE_MASK (0x80) — matches
      // getStencilDepthRenderState's `reference`. For terrain
      // (compare-always) it is inert; for tileset (compare-equal) it
      // selects fragments where a 3D-tile surface set the 0x80 bit.
      colorCommands.push(
        new WebGPUDrawCommand({
          ...classifyDrawArgs,
          pipeline: markPipeline,
          pass: passEnum,
          renderState: { stencilTest: { reference: 0x80 } },
        }),
      );
      const colorCmd = new WebGPUDrawCommand({
        ...classifyDrawArgs,
        pipeline: cache.colorPipeline,
        pass: passEnum,
        // Color compare NOT_EQUAL 0 (masked to CLASSIFICATION_MASK). The
        // reference is irrelevant here: applyPerEncoderState skips a 0
        // reference and the 0x80 left by the mark reads as 0 under the
        // 0x0f readMask — either way the compare is against 0.
        renderState: { stencilTest: { reference: 0 } },
      });
      // Attach velocity derivation to the FIRST color command for this
      // primitive (the BOTH-pass dual-emit case already covers both
      // ground passes; per-feature animation isn't possible for static
      // classification volumes anyway). Velocity uses the 2-group
      // depth-sample layout, so it keeps `sharedDrawArgs`.
      if (
        taaEnabled &&
        p === 0 &&
        defined(cache.velocityPipeline) &&
        defined(cache.depthSampleBindGroup)
      ) {
        colorCmd.velocityCommand = new WebGPUDrawCommand({
          ...sharedDrawArgs,
          pipeline: cache.velocityPipeline,
          pass: passEnum,
        });
      }
      colorCommands.push(colorCmd);
      if (defined(cache.pickPipeline) && defined(cache.depthSampleBindGroup)) {
        pickCommands.push(
          new WebGPUDrawCommand({
            ...sharedDrawArgs,
            pipeline: cache.pickPipeline,
            pass: passEnum,
            pickOnly: true,
          }),
        );
      }
    }
    if (
      emitsThreeDTileClassification &&
      defined(cache.stencilPipeline) &&
      defined(cache.depthSampleBindGroup)
    ) {
      ignoreShowCommands.push(
        new WebGPUDrawCommand({
          ...sharedDrawArgs,
          pipeline: cache.stencilPipeline,
          pass: 7 /* CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW */,
          renderState: { stencilTest: { reference: 0xff } },
        }),
      );
    }
  }

  return { colorCommands, pickCommands, ignoreShowCommands };
}

function destroyWebGPUVector3DTilePrimitiveResources(primitive) {
  const cache = primitive._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  if (defined(cache.batchColorBuffer)) {
    cache.batchColorBuffer.destroy();
  }
  if (defined(cache.pickColorBuffer)) {
    cache.pickColorBuffer.destroy();
  }
  if (defined(cache.vertexGPUBuffer)) {
    cache.vertexGPUBuffer.destroy();
  }
  // NEW-CLASSIFIER-2D-CV-MORPH (Batch 178) — release the reprojected 2D buffer.
  if (defined(cache.vertexGPUBuffer2D)) {
    cache.vertexGPUBuffer2D.destroy();
  }
  if (defined(cache.indexGPUBuffer)) {
    cache.indexGPUBuffer.destroy();
  }
  primitive._webgpuCache = undefined;
}

export {
  createWebGPUVector3DTilePrimitiveCommands,
  destroyWebGPUVector3DTilePrimitiveResources,
};
export default {
  createWebGPUVector3DTilePrimitiveCommands,
  destroyWebGPUVector3DTilePrimitiveResources,
};
