/**
 * @module WebGPUGroundPrimitiveRenderer
 *
 * Handles WebGPU rendering of GroundPrimitive / ClassificationPrimitive.
 * Uses two-pass stencil approach:
 *   Pass 1: Render geometry to stencil buffer only (mark terrain coverage)
 *   Pass 2: Render color only where stencil passes (paint on terrain)
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
  // C-R9 (Batch 31) — UBO extended with a pickColor vec4 at offset 112
  // (previous tail was 112 bytes / 28 floats; the new slot occupies
  // offsets 112-128 / floats 28-31 and the UBO grows to 128 bytes).
  // The pick fragment entry (pickFS) reuses the same stencil-gated
  // VS (colorVS emits pos + col) so the pick pass projects onto the
  // same terrain coverage as the color pass.
  const code = `
struct U {
  mvpRTE: mat4x4<f32>,
  camH: vec3<f32>, _p0: f32,
  camL: vec3<f32>, _p1: f32,
  color: vec4<f32>,
  pickColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;

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
`;

  const mod = device.createShaderModule({ label: "GroundPrimitive", code });
  const bgl = makeBindGroupLayout(device, "GroundPrimitive BGL", [
    uniformBuffer(0, Stage.VERTEX_FRAGMENT),
  ]);
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

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

  return { stencilDescriptor, colorDescriptor, pickDescriptor, bgl };
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
  if (cache.stencilPipeline && cache.colorPipeline && cache.pickPipeline) {
    return true;
  }

  if (pipelineCache) {
    const stencilSync = pipelineCache.getPipelineSync(
      resources.stencilDescriptor,
    );
    const colorSync = pipelineCache.getPipelineSync(resources.colorDescriptor);
    const pickSync = pipelineCache.getPipelineSync(resources.pickDescriptor);
    if (stencilSync && colorSync && pickSync) {
      cache.stencilPipeline = stencilSync;
      cache.colorPipeline = colorSync;
      cache.pickPipeline = pickSync;
      cache.pipelineRequestPending = false;
      return true;
    }
    if (!cache.pipelineRequestPending) {
      cache.pipelineRequestPending = true;
      Promise.all([
        pipelineCache.getPipeline(resources.stencilDescriptor),
        pipelineCache.getPipeline(resources.colorDescriptor),
        pipelineCache.getPipeline(resources.pickDescriptor),
      ])
        .then(([stencil, color, pick]) => {
          cache.stencilPipeline = stencil;
          cache.colorPipeline = color;
          cache.pickPipeline = pick;
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

  // Build actual draw commands if vertex data is available
  const geomData = primitive._webgpuGeometryData;
  if (!defined(geomData) || !defined(geomData.vertexBuffer)) {
    return {
      stencilPipeline: cache.stencilPipeline,
      colorPipeline: cache.colorPipeline,
      bindGroup: cache.bindGroup,
      stencilCommand: null,
      colorCommand: null,
    };
  }

  // Create vertex buffer once
  if (!defined(cache.vertexGPUBuffer)) {
    const vbData = geomData.vertexBuffer;
    cache.vertexGPUBuffer = WebGPUBuffer.createVertexBuffer(
      device,
      vbData.byteLength,
      false,
      "GroundPrimitive VB",
    );
    device.queue.writeBuffer(cache.vertexGPUBuffer.buffer, 0, vbData);
    cache.vertexCount = geomData.vertexCount || vbData.byteLength / 24;
  }

  // Create index buffer if indexed geometry
  if (defined(geomData.indexBuffer) && !defined(cache.indexGPUBuffer)) {
    const ibData = geomData.indexBuffer;
    cache.indexGPUBuffer = device.createBuffer({
      label: "GroundPrimitive IB",
      size: ibData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.indexGPUBuffer, 0, ibData);
    cache.indexCount = geomData.indexCount || ibData.byteLength / 2;
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

  // Stencil pass draw command (mark coverage, no color output)
  const stencilCommand = new WebGPUDrawCommand({
    pipeline: cache.stencilPipeline,
    bindGroups: [cache.bindGroup],
    vertexBuffers: [cache.vertexGPUBuffer],
    indexBuffer: cache.indexGPUBuffer || undefined,
    indexCount: cache.indexCount || 0,
    indexFormat: "uint16",
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
    indexFormat: "uint16",
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
        indexFormat: "uint16",
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
};
export default {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
};
