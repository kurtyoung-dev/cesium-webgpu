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
  buildPickPipelineDescriptor,
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
  //   floats  28-31 : pickColor                      (vec4<f32>)  — Batch 31
  //   floats  32-35 : viewport (x, y, w, h)          (vec4<f32>)  — Migration S1
  //   floats  36-63 : reserved (used in later sessions for inverseProjection
  //                   and additional depth-source uniforms)
  //
  // The pick fragment entry (pickFS) reuses the same stencil-gated VS
  // (colorVS emits pos + col) so the pick pass projects onto the same
  // terrain coverage as the color pass.
  //
  // Depth-sample variants (Migration Session 1) — `dsColorVS`,
  // `dsColorFS`, `dsPickFS` — consume the same uniform layout plus a
  // second bind group (depth texture + sampler in @group(1)). The VS is
  // identical to `colorVS`; only the fragment side samples globe depth.
  const code = `
struct U {
  mvpRTE: mat4x4<f32>,
  camH: vec3<f32>, _p0: f32,
  camL: vec3<f32>, _p1: f32,
  color: vec4<f32>,
  pickColor: vec4<f32>,
  viewport: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;

// Depth-sample resources (Migration Session 1). Bound only by the
// depth-sample pipelines; the stencil/color/pick pipelines have a
// 1-group layout and never see this group.
@group(1) @binding(0) var globeDepthTex: texture_2d<f32>;
@group(1) @binding(1) var depthSampler: sampler;

struct VO { @builtin(position) pos: vec4<f32> };
struct CO { @builtin(position) pos: vec4<f32>, @location(0) col: vec4<f32> };

@vertex fn stencilVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> VO {
  var o: VO;
  let rte = (pH - u.camH) + (pL - u.camL);
  o.pos = u.mvpRTE * vec4f(rte, 1.0);
  return o;
}

@fragment fn stencilFS() -> @location(0) vec4<f32> { return vec4f(0.0); }

@vertex fn colorVS(@location(0) pH: vec3<f32>, @location(1) pL: vec3<f32>) -> CO {
  var o: CO;
  let rte = (pH - u.camH) + (pL - u.camL);
  o.pos = u.mvpRTE * vec4f(rte, 1.0);
  o.col = u.color;
  return o;
}

@fragment fn colorFS(i: CO) -> @location(0) vec4<f32> { return i.col; }

@fragment fn pickFS() -> @location(0) vec4<f32> { return u.pickColor; }

// Reverse of WebGPUGlobeDepth's pack: each RGBA byte carries a slice of
// the depth value. The pack writes
//   floor(d * vec4(1, 255, 65025, 16581375)) / 255
// so the unpack is dot(packed, vec4(1, 1/255, 1/65025, 1/16581375)).
// Matches czm_unpackDepth in the WebGL builtins exactly.
fn unpackDepth(packed: vec4<f32>) -> f32 {
  return dot(packed, vec4<f32>(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

// Migration Session 1 — depth-sample classifier. Samples globe depth at
// the fragment's screen-space position; discards where the globe wrote
// no depth (sky / nothing classifiable). The volume's rasterization
// handles lateral coverage. For the per-instance-color case this is
// pixel-equivalent to WebGL's ShadowVolumeAppearanceFS without
// CULL_FRAGMENTS / NORMAL_EC / TEXTURE_COORDINATES branches enabled.
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
`;

  const mod = device.createShaderModule({ label: "GroundPrimitive", code });
  const bgl = makeBindGroupLayout(device, "GroundPrimitive BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

  // Migration Session 1 — depth-sample BGL + dual-group layout. The
  // per-primitive uniform group (group 0) is shared with the stencil
  // path. The depth-sample group (group 1) carries the globe depth
  // texture + sampler. Building two separate pipeline-layouts keeps the
  // stencil pipelines validation-clean (they don't see the depth-sample
  // group); only the depth-sample pipelines bind both groups.
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

  // Stencil pass: write stencil, no color write, no depth write
  const stencilDescriptor = {
    name: `GroundPrimitive stencil [${format}/${depthFormat}]`,
    layout,
    vertex: { module: mod, entryPoint: "stencilVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "stencilFS",
      targets: [{ format, writeMask: 0 }], // No color write
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
      stencilFront: {
        compare: "always",
        passOp: "replace",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilBack: {
        compare: "always",
        passOp: "replace",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0xff,
    },
  };

  // Color pass: read stencil, write color, no depth write
  const colorDescriptor = {
    name: `GroundPrimitive color [${format}/${depthFormat}]`,
    layout,
    vertex: { module: mod, entryPoint: "colorVS", buffers: vertexBuffers },
    fragment: {
      module: mod,
      entryPoint: "colorFS",
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
      stencilFront: {
        compare: "equal",
        passOp: "keep",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilBack: {
        compare: "equal",
        passOp: "keep",
        failOp: "keep",
        depthFailOp: "keep",
      },
      stencilReadMask: 0xff,
      stencilWriteMask: 0x00,
    },
  };

  // C-R9 (Batch 31 / refactored Batch 59) — pick descriptor derived from
  // the color descriptor via {@link buildPickPipelineDescriptor}. Inherits
  // the same stencil-gated read against the terrain coverage marked by
  // `stencilPipeline`; the helper swaps the fragment entry to `pickFS`
  // and strips blend so the pick FBO receives byte-exact pick IDs for the
  // readback. `forceDepthWriteEnabled: false` preserves the historical
  // setting (ground primitives are stencil-gated, neither color nor pick
  // path writes depth).
  const pickDescriptor = buildPickPipelineDescriptor(
    colorDescriptor,
    "pickFS",
    {
      name: `GroundPrimitive pick [${format}/${depthFormat}]`,
      forceDepthWriteEnabled: false,
    },
  );

  // Migration Session 1 — depth-sample variant pipelines. Single pass,
  // no stencil interaction, samples globe-depth in the fragment shader
  // and discards where depth is 0. Layout uses both BGLs (per-primitive
  // uniforms in @group(0), depth-sample resources in @group(1)).
  // depthStencil retains less-equal for early rejection of fragments
  // beyond the volume's far face but does not configure stencil — the
  // depth-sample path doesn't read or write the stencil bits, so the
  // attachment's stencil aspect remains untouched (other passes still
  // read it for InvertClassification etc.).
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

  return {
    stencilDescriptor,
    colorDescriptor,
    pickDescriptor,
    depthSampleColorDescriptor,
    depthSamplePickDescriptor,
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
    cache.stencilPipeline &&
    cache.colorPipeline &&
    cache.pickPipeline &&
    cache.depthSampleColorPipeline &&
    cache.depthSamplePickPipeline
  ) {
    return true;
  }

  if (pipelineCache) {
    const stencilSync = pipelineCache.getPipelineSync(
      resources.stencilDescriptor,
    );
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    const dsColorSync = pipelineCache.getPipelineSync(
      resources.depthSampleColorDescriptor,
    );
    const dsPickSync = pipelineCache.getPipelineSync(
      resources.depthSamplePickDescriptor,
    );
    if (stencilSync && colorSync && pickSync && dsColorSync && dsPickSync) {
      cache.stencilPipeline = stencilSync;
      cache.colorPipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.depthSampleColorPipeline = dsColorSync;
      cache.depthSamplePickPipeline = dsPickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.stencilDescriptor),
        pipelineCache.getPipeline(resources.colorDescriptor),
        pipelineCache.getPipeline(resources.pickDescriptor),
        pipelineCache.getPipeline(resources.depthSampleColorDescriptor),
        pipelineCache.getPipeline(resources.depthSamplePickDescriptor),
      ])
        .then(([stencil, color, pick, dsColor, dsPick]) => {
          cache.stencilPipeline = stencil;
          cache.colorPipeline = color;
          cache.pickPipeline = pick;
          cache.depthSampleColorPipeline = dsColor;
          cache.depthSamplePickPipeline = dsPick;
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
  cache.stencilPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.stencilDescriptor),
  );
  cache.colorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.colorDescriptor),
  );
  cache.pickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.pickDescriptor),
  );
  cache.depthSampleColorPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSampleColorDescriptor),
  );
  cache.depthSamplePickPipeline = device.createRenderPipeline(
    descriptorToGPU(resources.depthSamplePickDescriptor),
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

  // Migration Session 1 — viewport (floats 32-35). The depth-sample
  // fragment shader divides `@builtin(position).xy` by the viewport
  // (z, w) to recover the screen-space UV used to fetch globe depth.
  // The stencil/color/pick path ignores this slot.
  const viewport = uniformState.viewportCartesian4 ?? uniformState.viewport;
  data[32] = viewport?.x ?? 0.0;
  data[33] = viewport?.y ?? 0.0;
  data[34] = viewport?.z ?? frameState.context.drawingBufferWidth ?? 0.0;
  data[35] = viewport?.w ?? frameState.context.drawingBufferHeight ?? 0.0;
}

/**
 * Creates WebGPU commands for a GroundPrimitive.
 * Returns both stencil and color commands.
 */
function createWebGPUGroundPrimitiveCommands(primitive, frameState) {
  const context = frameState.context;
  const device = context.device;

  if (!defined(primitive._webgpuCache)) {
    primitive._webgpuCache = {};
  }
  const cache = primitive._webgpuCache;

  // C-R7-RENDERER-MIGRATION (Batch 58) — build the BGL + pipeline-layout
  // + shader module + pipeline descriptors once, then route the actual
  // pipeline creation through `context.webgpuPipelineCache`. The
  // descriptors and shader module are stashed on the cache so the async
  // resolver can re-poll across frames until pipelines materialize.
  if (!defined(cache._pipelineResources)) {
    const format = context.presentationFormat || "bgra8unorm";
    const depthFmt = context.depthFormat || "depth24plus-stencil8";
    cache._pipelineResources = buildGroundPipelineResources(
      device,
      format,
      depthFmt,
    );
    cache.bgl = cache._pipelineResources.bgl;
    cache.pipelineRequestPending = false;
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
  // Migration Session 1 — the `_webgpuGeometryData` slot on the primitive
  // is populated by `Scene/PrimitiveGeometryHelpers.js` as an array of
  // `{ attributes, indices, primitiveType, boundingSphere }` (one entry
  // per Geometry instance). The previous version of this renderer read
  // `geomData.vertexBuffer` / `.indexBuffer` directly — those slots
  // never existed, so the early-return always fired and no WebGPU
  // commands ever reached the command list. The actual vertex / index
  // streams live on the saved attributes (`position3DHigh.values`,
  // `position3DLow.values`, `indices`) and need to be packed into GPU
  // buffers on first use, mirroring `WebGPUPrimitiveCommands.js`'s
  // `extractPositionData` + `ensureIndexBuffer` helpers.
  //
  // First-cut handles only `_webgpuGeometryData[0]`. Multi-geometry
  // primitives (rare for GroundPrimitive — typically one rectangle /
  // polygon per primitive) are tracked as a follow-up; the
  // single-geometry path covers the common case.
  const geomDataArray = primitive._webgpuGeometryData;
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
  const posHighAttr = geomData?.attributes?.position3DHigh;
  const posLowAttr = geomData?.attributes?.position3DLow;
  if (
    !defined(posHighAttr?.values) ||
    !defined(posLowAttr?.values) ||
    posHighAttr.values.length !== posLowAttr.values.length
  ) {
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
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      interleaved.byteLength,
      false,
      "GroundPrimitive VB",
    );
    device.queue.writeBuffer(cache.vertexGPUBuffer.buffer, 0, interleaved);
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

  // Pick the classification pass based on the primitive's classificationType.
  // ClassificationType: TERRAIN=0, CESIUM_3D_TILE=1, BOTH=2.
  // Pass enum:          TERRAIN_CLASSIFICATION=3, CESIUM_3D_TILE_CLASSIFICATION=6.
  // For BOTH we route the command into CESIUM_3D_TILE_CLASSIFICATION so it
  // still projects onto 3D Tiles — terrain-only emission is a minor
  // compromise (a second command per ground primitive would fix that).
  // Without this, ground primitives with classificationType: CESIUM_3D_TILE
  // silently degraded to terrain-only on WebGPU.
  const classType = primitive?.classificationType ?? 0;
  const groundPass =
    classType === 0
      ? 3 /* TERRAIN_CLASSIFICATION */
      : 6; /* CESIUM_3D_TILE_CLASSIFICATION */

  // Migration Session 1 — pick the dispatch path.
  //
  // Default is depth-sample (single pass per primitive). Falls back to
  // the legacy 2-pass stencil approach when the globe-depth view isn't
  // published yet (first frame, viewport resize, debug paths that don't
  // run executeCopyDepth). The fallback keeps the renderer functional
  // until the depth-source plumbing in Migration Sessions 2-3 makes the
  // depth-sample path available unconditionally.
  const globeDepthView = context._globeDepthView ?? null;
  const useDepthSample = _useDepthSampleClassifier && globeDepthView !== null;

  if (useDepthSample) {
    // Build / refresh the depth-sample bind group from the current frame's
    // globe depth view. The bind group is rebuilt every frame because the
    // underlying view object can change on resize. The sampler is shared
    // across frames (linear-clamped is correct for the unpacked depth).
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
      cache.depthSampleViewRef !== globeDepthView
    ) {
      cache.depthSampleBindGroup = device.createBindGroup({
        label: "GroundPrimitive depth-sample BG",
        layout: cache._pipelineResources.depthSampleBgl,
        entries: [
          { binding: 0, resource: globeDepthView },
          { binding: 1, resource: cache.depthSampleSampler },
        ],
      });
      cache.depthSampleViewRef = globeDepthView;
    }

    const depthSampleColorCommand = new WebGPUDrawCommand({
      pipeline: cache.depthSampleColorPipeline,
      bindGroups: [cache.bindGroup, cache.depthSampleBindGroup],
      vertexBuffers: [cache.vertexGPUBuffer],
      indexBuffer: cache.indexGPUBuffer || undefined,
      indexCount: cache.indexCount || 0,
      indexFormat: cache.indexFormat || "uint16",
      vertexCount: cache.vertexCount || 0,
      pass: groundPass,
      owner: primitive,
    });

    if (defined(pickColor)) {
      // Pick command rebuilds when the depth-sample bind group does (the
      // bind-group reference changes on view turnover). Cheaper than
      // caching since pick is a per-frame transient anyway.
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.depthSamplePickPipeline,
        bindGroups: [cache.bindGroup, cache.depthSampleBindGroup],
        vertexBuffers: [cache.vertexGPUBuffer],
        indexBuffer: cache.indexGPUBuffer || undefined,
        indexCount: cache.indexCount || 0,
        indexFormat: cache.indexFormat || "uint16",
        vertexCount: cache.vertexCount || 0,
        pass: groundPass,
        owner: primitive,
        pickOnly: true,
      });
      attachPickToColorCommand(depthSampleColorCommand, cache.pickCommand);
    }

    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.depthSampleColorPipeline,
      pickPipeline: cache.depthSamplePickPipeline,
      bindGroup: cache.bindGroup,
      // Sentinel — null `stencilCommand` tells the GroundPrimitive consumer
      // to push only `colorCommand`. See `Scene/GroundPrimitive.js`
      // delegation.
      stencilCommand: null,
      colorCommand: depthSampleColorCommand,
      pickCommand: cache.pickCommand,
    };
  }

  // Legacy stencil fallback (kept for Migration Sessions 2-3 as a quick
  // toggle if the depth-sample path needs a regression workaround).
  // Slated for removal in Migration Session 5.

  // Stencil pass draw command (mark coverage, no color output)
  const stencilCommand = new WebGPUDrawCommand({
    pipeline: cache.stencilPipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    stencilReference: 1,
    pass: groundPass,
    owner: primitive,
  });

  // Color pass draw command (render color where stencil passes)
  const colorCommand = new WebGPUDrawCommand({
    pipeline: cache.colorPipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: cache.indexFormat || "uint16",
    vertexCount: cache.vertexCount || 0,
    stencilReference: 1,
    pass: groundPass,
    owner: primitive,
  });

  // C-R9 (Batch 31) — pick command. Same layout/VS/stencil state as the
  // color command, different fragment entry. Wired onto the color
  // command's derivedCommands so the Batch 29 dispatcher routes to it
  // during pick passes. Only materialized when a pick ID exists.
  if (defined(pickColor)) {
    if (!defined(cache.pickCommand)) {
      cache.pickCommand = new WebGPUDrawCommand({
        pipeline: cache.pickPipeline,
        bindGroups: [cache.bindGroup],
        vertexBuffers: [cache.vertexGPUBuffer],
        indexBuffer: cache.indexGPUBuffer || undefined,
        indexCount: cache.indexCount || 0,
        indexFormat: cache.indexFormat || "uint16",
        vertexCount: cache.vertexCount || 0,
        stencilReference: 1,
        pass: groundPass,
        owner: primitive,
        pickOnly: true,
      });
    }
    attachPickToColorCommand(colorCommand, cache.pickCommand);
  }

  return {
    stencilPipeline: cache.stencilPipeline,
    colorPipeline: cache.colorPipeline,
    pickPipeline: cache.pickPipeline,
    bindGroup: cache.bindGroup,
    stencilCommand,
    colorCommand,
    pickCommand: cache.pickCommand,
  };
}

// Migration Session 1 toggle. Default `true` selects the depth-sample
// classifier; setting to `false` routes through the legacy 2-pass
// stencil pipelines. Exposed for debug / regression workarounds during
// Migration Sessions 2-3; the legacy path is removed in Migration
// Session 5 and this toggle goes away with it.
let _useDepthSampleClassifier = true;

/** @private */
function setUseDepthSampleClassifier(value) {
  _useDepthSampleClassifier = !!value;
}

/** @private */
function getUseDepthSampleClassifier() {
  return _useDepthSampleClassifier;
}

function destroyWebGPUGroundPrimitiveResources(primitive) {
  const cache = primitive._webgpuCache;
  if (!defined(cache)) {
    return;
  }
  if (defined(cache.uniformBuffer)) {
    cache.uniformBuffer.destroy();
  }
  // C-R9 (Batch 31 / refactored Batch 59) — release the pick ID slot
  // back to the registry.
  destroyPickIds(primitive);
  primitive._webgpuCache = undefined;
}

export {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
  setUseDepthSampleClassifier,
  getUseDepthSampleClassifier,
};
export default {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
  setUseDepthSampleClassifier,
  getUseDepthSampleClassifier,
};
