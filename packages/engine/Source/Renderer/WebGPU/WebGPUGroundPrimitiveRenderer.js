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
const UNIFORM_BUFFER_SIZE = 384;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
const scratchProjection = new Matrix4();
const scratchEncodedCamera = new EncodedCartesian3();

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
};
@group(0) @binding(0) var<uniform> u: U;

// Depth-sample resources. Group 1 carries the depth texture + sampler;
// the source view is bound late by WebGPUDrawCommand.bindGroupResolvers
// at draw time so per-frustum + per-frame depth-source swaps (globe-depth
// ↔ packed-translucent-depth) take effect without rebuilding the command.
@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

struct CO { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };

@vertex fn colorVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> CO {
  var o: CO;
  let rte = (pH - u.camH) + (pL - u.camL);
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

// Depth-sample classifier. Samples the depth source (globe-depth or
// packed-translucent-depth, swapped at draw time by the bind-group
// resolver) at the fragment's screen-space position; discards where the
// surface wrote no depth (sky / nothing classifiable). The volume's
// rasterization handles lateral coverage. For the per-instance-color
// case this is pixel-equivalent to WebGL's ShadowVolumeAppearanceFS
// without CULL_FRAGMENTS / NORMAL_EC / TEXTURE_COORDINATES branches.
@fragment fn dsColorFS(i: CO) -> @location(0) vec4<f32> {
  let screenUV = i.pos.xy / u.viewport.zw;
  let packed = textureSampleLevel(globeDepthTex, depthSampler, screenUV, 0.0);
  let surfaceDepth = unpackDepth(packed);
  if (surfaceDepth == 0.0) {
    discard;
  }
  return i.col;
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
  let rte = (pH - u.camH) + (pL - u.camL);
  let curClip = csm_depthClamp(u.mvpRTE * vec4<f32>(rte, 1.0));
  // Previous frame: project the world-space position (high + low,
  // simple sum is fine here because pH/pL are SOA-encoded high/low
  // bits of an absolute world position — adding them recovers the
  // original world coordinates) through prev VP. The csm_depthClamp
  // is intentionally NOT applied to prev — the clamp affects clip-z,
  // and velocity derives from clip-x/y/w; the omission is benign and
  // saves the helper call on the prev path.
  let worldPos = pH + pL;
  let prClip = u.prevViewProjection * vec4<f32>(worldPos, 1.0);
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
  const depthSampleLayout = device.createPipelineLayout({
    label: "GroundPrimitive DepthSample PipelineLayout",
    bindGroupLayouts: [bgl, depthSampleBgl],
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

function packUniforms(data, frameState, modelMatrix, color, pickColor) {
  const uniformState = frameState.context.uniformState;
  // Use uniformState.view/projection for 2D/Columbus View support
  Matrix4.multiply(uniformState.view, modelMatrix, scratchModelView);
  Matrix4.clone(scratchModelView, scratchMVRTE);
  scratchMVRTE[12] = 0.0;
  scratchMVRTE[13] = 0.0;
  scratchMVRTE[14] = 0.0;
  Matrix4.multiply(uniformState.projection, scratchMVRTE, scratchMVPRTE);
  Matrix4.pack(scratchMVPRTE, data, 0);

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
  // SCENE2D / COLUMBUS_VIEW classification (Batch 169 — over-broad
  // `_needs2DShader` skip removed; ONE remaining blocker, see below).
  //
  // The previous `_needs2DShader` non-3D silent-skip is removed: this renderer
  // is FLAT COLOR only (`packUniforms` reads `appearance.material.uniforms
  // .color`; no UV / extents / texture sampling in any mode), so a flat-color
  // GroundPrimitive does NOT need WebGL's `appearance2D` to render in 2D, and
  // the Batch 156 `position2DHigh/Low` path already produces 2D geometry.
  //
  // STATUS (verified Batch 169, NOT yet rendering): with the skip gone the
  // command IS built in 2D (no `missing2DAttributes` skip — the geometry has
  // the 2D attribute pair) and the depth source is published (Batch 167 fixed
  // the globe-2D render + globe-depth publication), so the depth-sample
  // discard is satisfied (ruled out by test: removing the `dsColorFS` discard
  // changed nothing). The classification volume still produces ZERO on-screen
  // fragments in 2D because it projects OFF-SCREEN: `packUniforms` encodes the
  // 3D-ECEF camera (`camera.positionWC`) into `encodedCamera`, but the bound
  // attributes in 2D are the `position2DHigh/Low` PROJECTED positions — so the
  // RTE subtraction `position2D − cameraECEF` mixes coordinate spaces and the
  // vertices land off-screen. The fix is to encode the 2D-PROJECTED camera
  // position in `packUniforms` for non-3D modes (analogous to the globe's
  // `rtc2D` shift), a careful coordinate-convention change tracked as
  // NEW-CLASSIFIER-GROUNDPRIM-2D-RTE. Until then 2D classification renders
  // nothing (harmless: 0 device errors, one off-screen draw per primitive).
  // Genuine textured-material detail (appearance2D UVs) remains the further
  // NEW-GROUNDPRIM-TEXTURED-MATERIALS layer.
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

  packUniforms(cache.uniformData, frameState, modelMatrix, color, pickColor);
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
    bindGroups: [cache.bindGroup, cache.depthSampleBindGroup],
    bindGroupResolvers: [undefined, resolveDepthSampleBindGroup],
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
