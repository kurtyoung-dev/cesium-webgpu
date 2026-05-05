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

const UNIFORM_BUFFER_SIZE = 256;
const scratchModelView = new Matrix4();
const scratchMVRTE = new Matrix4();
const scratchMVPRTE = new Matrix4();
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
function buildGroundPipelineResources(device, format, depthFormat) {
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
  // AUDIT_2026_05_02 B.9 (Batch 153) — DP-H41 prev viewProjection at the
  // tail. Layout-only invariant today; consumed by future motion-vector
  // pass for ground classifiers.
  prevViewProjection: mat4x4<f32>,
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
`;

  const mod = device.createShaderModule({ label: "GroundPrimitive", code });
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

  // Color pipeline — single pass, samples depth in the fragment shader
  // and discards where depth is 0. Layout uses both BGLs (per-primitive
  // uniforms in @group(0), depth source in @group(1)). depthStencil
  // retains less-equal for early rejection of fragments beyond the
  // volume's far face but does not configure stencil — the depth-sample
  // path doesn't read or write the stencil bits, so the attachment's
  // stencil aspect remains untouched (other passes still read it for
  // InvertClassification etc.).
  const depthSampleColorDescriptor = {
    name: `GroundPrimitive depthSampleColor [${format}/${depthFormat}]`,
    layout: depthSampleLayout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "dsColorFS",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
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
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
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
  };

  // AUDIT_2026_05_02 A.2 (Batch 141) — IGNORE_SHOW stencil-write variant.
  // Color writes disabled (writeMask=0); the pipeline runs solely to mark
  // the invert FBO's stencil with 0xff on classified pixels. The
  // stencilReference value is set per-draw via
  // `applyPerEncoderState({ stencilTest: { reference: 0xff } })`.
  const depthSampleStencilDescriptor = {
    name: `GroundPrimitive depthSampleStencil [${format}/${depthFormat}]`,
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
  };

  return {
    depthSampleColorDescriptor,
    depthSamplePickDescriptor,
    depthSampleStencilDescriptor,
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
    if (dsColorSync && dsPickSync && dsStencilSync) {
      cache.depthSampleColorPipeline = dsColorSync;
      cache.depthSamplePickPipeline = dsPickSync;
      cache.depthSampleStencilPipeline = dsStencilSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.depthSampleColorDescriptor),
        pipelineCache.getPipeline(resources.depthSamplePickDescriptor),
        pipelineCache.getPipeline(resources.depthSampleStencilDescriptor),
      ])
        .then(([dsColor, dsPick, dsStencil]) => {
          cache.depthSampleColorPipeline = dsColor;
          cache.depthSamplePickPipeline = dsPick;
          cache.depthSampleStencilPipeline = dsStencil;
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
}

/**
 * Creates WebGPU commands for a GroundPrimitive.
 * Returns both stencil and color commands.
 */
function createWebGPUGroundPrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  // AUDIT_2026_05_02 A.4 (Batch 150 conservative gate, narrowed in
  // Batch 156, narrowed further in Batch 157) — SCENE2D + COLUMBUS_VIEW
  // use the per-vertex `position2DHigh/Low` attributes that
  // `PrimitivePipeline.js:175-208` produces alongside the 3D positions.
  // With both encoded into the same coordinate space as the active
  // `uniformState.view * projection` and `camera.positionWC`, the
  // existing RTE math at `colorVS` lines 121-130 produces correct
  // classification volumes — see the geometry-attribute selection in
  // `ensureVertexBuffer` below.
  //
  // Two cases still gate to silent-skip:
  //
  // 1. MORPHING — lerping volumes between 3D ECEF and 2D projected
  //    coordinates needs both attribute sets bound at the same time +
  //    an in-shader `mix(rte3D, rte2D, morphTime)` (the pattern
  //    `WebGPUGroundPolylineRenderer` uses for its morph pipeline).
  //
  // 2. `_needs2DShader` primitives in any non-3D mode — primitives
  //    with `_hasPlanarExtentsAttributes` or `_hasSphericalExtentsAttribute`
  //    require WebGL's `derivedCommands.appearance2D` shader for the
  //    planar/spherical extents math (`GroundPrimitive.js:813-818`).
  //    The WebGPU renderer doesn't have a WGSL `appearance2D`
  //    equivalent yet, so the position-only swap from Batch 156 would
  //    produce correct geometry but broken texture coords — silent
  //    skip until the appearance2D WGSL pipeline lands. Common with
  //    textured GroundPrimitives (Image / Stripe / Grid material) and
  //    batched-classification primitives.
  //
  // Both gates are tracked as the remainder of A.4 /
  // NEW-CLASSIFIER-2D-CV-MORPH in DEFERRED_WORK.
  const sceneMode = frameState?.mode;
  const isNon3D = sceneMode !== SceneMode.SCENE3D;
  const needs2DShader = primitive?._primitive?._needs2DShader === true;
  if (sceneMode === SceneMode.MORPHING || (isNon3D && needs2DShader)) {
    //>>includeStart('debug', pragmas.debug);
    oneTimeWarning(
      "WebGPUGroundPrimitive.morphOrNeeds2DShader",
      "GroundPrimitive on WebGPU silently skips during MORPHING and for " +
        "primitives requiring `_needs2DShader` (planar/spherical extents) in " +
        "non-3D scene modes. SCENE2D + COLUMBUS_VIEW + SCENE3D render " +
        "correctly otherwise. Tracked as A.4 / NEW-CLASSIFIER-2D-CV-MORPH.",
    );
    //>>includeEnd('debug');
    return {
      colorPipeline: null,
      pickPipeline: null,
      bindGroup: null,
      stencilCommand: null,
      colorCommand: null,
      pickCommand: null,
      colorCommands: [],
      pickCommands: [],
      ignoreShowCommand: null,
    };
  }

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
    cache._pipelineResources = buildGroundPipelineResources(
      device,
      format,
      depthFmt,
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
  const useNon3DPositions = frameState?.mode !== SceneMode.SCENE3D;
  const posHighAttr = useNon3DPositions
    ? geomData?.attributes?.position2DHigh
    : geomData?.attributes?.position3DHigh;
  const posLowAttr = useNon3DPositions
    ? geomData?.attributes?.position2DLow
    : geomData?.attributes?.position3DLow;
  if (
    !defined(posHighAttr?.values) ||
    !defined(posLowAttr?.values) ||
    posHighAttr.values.length !== posLowAttr.values.length
  ) {
    //>>includeStart('debug', pragmas.debug);
    if (useNon3DPositions) {
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

  // Create vertex buffer once. Interleaves posHigh + posLow into a
  // single 24-byte/vertex stream matching the pipeline's vertex layout
  // (location 0 = posHigh vec3, location 1 = posLow vec3).
  //
  // AUDIT_2026_05_02 A.4 (Batch 156) — when the scene mode toggles
  // between 3D and 2D/CV (e.g. user calls `scene.morphTo2D()` and the
  // morph completes), the cached vertex buffer was built from the
  // wrong attribute set. Track which set fed the cache and rebuild
  // when the mode flips. Stable across frames within the same mode.
  const positionSourceKey = useNon3DPositions ? "2D" : "3D";
  if (cache.positionSourceKey !== positionSourceKey) {
    cache.vertexGPUBuffer?.destroy();
    cache.vertexGPUBuffer = undefined;
    cache.positionSourceKey = positionSourceKey;
  }
  if (!defined(cache.vertexGPUBuffer)) {
    const numVerts = posHighAttr.values.length / 3;
    const interleaved = new Float32Array(numVerts * 6);
    for (let v = 0; v < numVerts; v++) {
      const dst = v * 6;
      const src = v * 3;
      interleaved[dst] = posHighAttr.values[src];
      interleaved[dst + 1] = posHighAttr.values[src + 1];
      interleaved[dst + 2] = posHighAttr.values[src + 2];
      interleaved[dst + 3] = posLowAttr.values[src];
      interleaved[dst + 4] = posLowAttr.values[src + 1];
      interleaved[dst + 5] = posLowAttr.values[src + 2];
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
  const sharedDrawArgs = {
    bindGroups: [cache.bindGroup, cache.depthSampleBindGroup],
    bindGroupResolvers: [undefined, resolveDepthSampleBindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    owner: primitive,
    renderState: classificationRS,
  };
  const colorCommands = [];
  const pickCommands = [];
  for (let p = 0; p < groundPasses.length; p++) {
    const passEnum = groundPasses[p];
    const colorCmd = new WebGPUDrawCommand({
      ...sharedDrawArgs,
      pipeline: cache.depthSampleColorPipeline,
      pass: passEnum,
    });
    if (defined(pickColor)) {
      const pickCmd = new WebGPUDrawCommand({
        ...sharedDrawArgs,
        pipeline: cache.depthSamplePickPipeline,
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
  if (groundPasses.includes(6)) {
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
