/**
 * WebGPU Point Cloud Renderer
 *
 * Renders point cloud data (LiDAR, photogrammetry) using instanced quads.
 * Supports per-point color, position splitting for RTE precision,
 * size attenuation, and optional normal-based lighting.
 *
 * @module WebGPUPointCloudRenderer
 */

import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Cartesian3 from "../../Core/Cartesian3.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import type { WebGPUPointCloudLODProcessorInstance } from "./WebGPUPointCloudLODProcessor.js";

/**
 * Narrowed view of the CesiumJS `PointCloud` shape that this renderer
 * actually touches. The upstream type uses a generic index signature
 * (`[key: string]: unknown`) which makes arithmetic + property access
 * fail TypeScript's strict checks. Declaring the specific fields here
 * keeps the strict index signature in place for any fields we DON'T
 * reference while letting hot-path code compile without inline casts.
 *
 * Kept local to this file — callers elsewhere in the engine shouldn't
 * need to know about LOD internals.
 */
/**
 * Shape of the parsed-content blob produced by Cesium's point cloud
 * loader (PntsParser / 3D Tiles Point Cloud). Both layouts — raw LAS
 * and 3D Tiles tiles — populate the same fields, so this single shape
 * covers both loader paths. Declared separately so the interleaved
 * accesses in `buildInstanceBuffer` type-check as arrays of the right
 * numeric shape.
 */
interface PointCloudParsedContent {
  positions?: Float32Array;
  colors?: Uint8Array | Float32Array;
}

interface PointCloudLike {
  _webgpuCache?: CesiumOpaqueObject | PointCloudCache | undefined;
  _parsedContent?: PointCloudParsedContent;
  _pointCloud?: { _parsedContent?: PointCloudParsedContent };
  _pointsLength?: number;
  enableGPULOD?: boolean;
  modelMatrix?: CesiumMatrix4;
  lodFarDistance?: number;
  geometricError?: number;
  // Allow pass-through for anything else the buildInstanceBuffer /
  // frustum extraction paths read — keeps the typed surface minimal
  // while preserving the upstream escape hatch.
  [key: string]: unknown;
}

interface PointCloudCache {
  uniformBuffer: GPUBuffer | null;
  pipeline: GPURenderPipeline | null;
  shaderModule: GPUShaderModule | null;
  bindGroup: GPUBindGroup | null;
  quadVertexBuffer: GPUBuffer | null;
  instanceBuffer: GPUBuffer | null;
  instanceCount: number;
  command: CesiumAnyDrawCommand | null;
  initialized: boolean;
  lastRevision: number;

  // ── GPU LOD path (opt-in when pointCloud.enableGPULOD === true) ──
  //
  // Compiled lazily on first frame the flag is true. The LOD pipeline
  // reads instance data from a storage buffer (same bytes as the VB
  // path above — we back them with the same GPUBuffer but add STORAGE
  // usage) and looks up the actual instance via `visibleIndices[iidx]`.
  // `instanceCountBuffer` is a 16-byte indirect draw arg buffer that
  // the LOD processor's visibleCount is copied into each frame.
  lodPipeline: GPURenderPipeline | null;
  lodBindGroupLayout: GPUBindGroupLayout | null;
  lodStorageBindGroup: GPUBindGroup | null;
  lodIndirectBuffer: GPUBuffer | null;
  lodPositionsX: Float32Array | null;
  lodPositionsY: Float32Array | null;
  lodPositionsZ: Float32Array | null;
  lodUploadedRevision: number;
  lodCommand: CesiumAnyDrawCommand | null;
  lodActive: boolean;
}

const POINT_CLOUD_WGSL = `
struct VertexInput {
  @location(0) quadVertex: vec2<f32>,
  @location(1) positionHigh: vec3<f32>,
  @location(2) positionLow: vec3<f32>,
  @location(3) colorAndSize: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let posRTE = (input.positionHigh - u.encodedCameraHigh)
             + (input.positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pointSize = input.colorAndSize.a * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + input.quadVertex.x * px;
  fp.y = fp.y + input.quadVertex.y * py;
  output.position = fp;
  output.color = input.colorAndSize.rgb;
  output.pointUV = input.quadVertex;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  return vec4<f32>(input.color, alpha);
}
`;

// GPU LOD variant of the point cloud shader. Identical math to the
// default path, but reads instance data from a storage buffer and
// looks up the actual source index via the LOD processor's compacted
// visibleIndices buffer. Activated by `pointCloud.enableGPULOD` when
// the point count is above POINT_COUNT_LOD_THRESHOLD.
//
// The storage buffer is the SAME 40-byte packed layout as the default
// path's vertex buffer (posHigh(12) + posLow(12) + colorAndSize(16)).
// WGSL's `array<vec3<f32>>` would add 16-byte alignment padding that
// breaks that packing, so we declare the storage as `array<f32>` and
// index manually at 10 floats per instance. This lets us reuse the
// exact same GPUBuffer for both paths — `buildInstanceBuffer` only
// needs to OR in `STORAGE` usage when GPU LOD is potentially on.
const POINT_CLOUD_LOD_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) pointUV: vec2<f32>,
};

struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  viewportSize: vec2<f32>,
  pointSizeMultiplier: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
// Storage declared as raw floats so the packed 40-byte VB layout
// works without WGSL's std430 struct padding. Indexing matches the
// layout that buildInstanceBuffer writes (10 floats per point).
@group(1) @binding(0) var<storage, read> instanceData: array<f32>;
@group(1) @binding(1) var<storage, read> visibleIndices: array<u32>;

@vertex
fn vertexMainLOD(
  @builtin(instance_index) iidx: u32,
  @location(0) quadVertex: vec2<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  let actualIdx = visibleIndices[iidx];
  let base = actualIdx * 10u;
  let positionHigh = vec3<f32>(
    instanceData[base + 0u],
    instanceData[base + 1u],
    instanceData[base + 2u],
  );
  let positionLow = vec3<f32>(
    instanceData[base + 3u],
    instanceData[base + 4u],
    instanceData[base + 5u],
  );
  let color = vec3<f32>(
    instanceData[base + 6u],
    instanceData[base + 7u],
    instanceData[base + 8u],
  );
  let size = instanceData[base + 9u];
  let posRTE = (positionHigh - u.encodedCameraHigh)
             + (positionLow - u.encodedCameraLow);
  let clipPos = u.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  let pointSize = size * u.pointSizeMultiplier;
  let px = pointSize / u.viewportSize.x * clipPos.w;
  let py = pointSize / u.viewportSize.y * clipPos.w;
  var fp = clipPos;
  fp.x = fp.x + quadVertex.x * px;
  fp.y = fp.y + quadVertex.y * py;
  output.position = fp;
  output.color = color;
  output.pointUV = quadVertex;
  return output;
}

@fragment
fn fragmentMainLOD(input: VertexOutput) -> @location(0) vec4<f32> {
  let dist = length(input.pointUV);
  if (dist > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.8, 1.0, dist);
  return vec4<f32>(input.color, alpha);
}
`;

/**
 * Below this point count the GPU LOD path is skipped even when opted in
 * — the compute dispatch + buffer copies cost more than CPU iteration
 * for small clouds. Tuned loosely against typical point cloud benchmarks.
 */
const POINT_COUNT_LOD_THRESHOLD = 50_000;

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
// RTE scratch: view×model with translation column zeroed, used to
// build MVP correctly (must zero before projecting).
const scratchMVRTE = new Matrix4();

function createQuadVB(device: GPUDevice): GPUBuffer {
  const verts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, gpuData(verts));
  return buf;
}

function buildPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): {
  pipeline: GPURenderPipeline;
  shaderModule: GPUShaderModule;
  bgl: GPUBindGroupLayout;
} {
  const shaderModule = device.createShaderModule({ code: POINT_CLOUD_WGSL });
  const bgl = makeBindGroupLayout(device, "PointCloud BGL", [
    uniformBuffer(0, Stage.VERTEX),
  ]);
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
        {
          arrayStride: 40,
          stepMode: "instance" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 1,
              offset: 0,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 2,
              offset: 12,
              format: "float32x3" as GPUVertexFormat,
            },
            {
              shaderLocation: 3,
              offset: 24,
              format: "float32x4" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      // less-equal for planetary-scale precision robustness.
      depthCompare: "less-equal",
    },
  });
  return { pipeline, shaderModule, bgl };
}

function buildInstanceBuffer(
  device: GPUDevice,
  pointCloud: PointCloudLike,
  modelMatrix: Matrix4 | CesiumMatrix4,
  allowStorage: boolean,
): {
  buffer: GPUBuffer;
  count: number;
  // SOA world-space positions for the GPU LOD processor. Only populated
  // when `allowStorage` is true — saves 12 MB/million points otherwise.
  worldX: Float32Array | null;
  worldY: Float32Array | null;
  worldZ: Float32Array | null;
} {
  // Read point positions, colors from pointCloud._drawCommand or _parsedContent
  const parsedContent =
    pointCloud._parsedContent || pointCloud._pointCloud?._parsedContent;
  if (!parsedContent || !parsedContent.positions) {
    return {
      buffer: device.createBuffer({ size: 40, usage: GPUBufferUsage.VERTEX }),
      count: 0,
      worldX: null,
      worldY: null,
      worldZ: null,
    };
  }

  const positions = parsedContent.positions;
  const colors = parsedContent.colors;
  const pointCount = positions.length / 3;
  // 40 bytes per instance: posHigh(12) + posLow(12) + colorAndSize(16)
  const data = new Float32Array(pointCount * 10);

  // World-space SOA arrays used by the LOD processor. Allocated only
  // when the caller plans to potentially activate GPU LOD — the
  // storage adds 12 bytes/point in CPU memory which isn't free.
  const worldX = allowStorage ? new Float32Array(pointCount) : null;
  const worldY = allowStorage ? new Float32Array(pointCount) : null;
  const worldZ = allowStorage ? new Float32Array(pointCount) : null;

  const worldPosScratch = new Cartesian3();
  const srcPosScratch = new Cartesian3();

  for (let i = 0; i < pointCount; i++) {
    srcPosScratch.x = positions[i * 3];
    srcPosScratch.y = positions[i * 3 + 1];
    srcPosScratch.z = positions[i * 3 + 2];

    // Transform to world space
    Matrix4.multiplyByPoint(modelMatrix, srcPosScratch, worldPosScratch);
    EncodedCartesian3.fromCartesian(worldPosScratch, scratchEncoded);

    if (worldX) {
      worldX[i] = worldPosScratch.x;
      worldY![i] = worldPosScratch.y;
      worldZ![i] = worldPosScratch.z;
    }

    const off = i * 10;
    data[off] = scratchEncoded.high.x;
    data[off + 1] = scratchEncoded.high.y;
    data[off + 2] = scratchEncoded.high.z;
    data[off + 3] = scratchEncoded.low.x;
    data[off + 4] = scratchEncoded.low.y;
    data[off + 5] = scratchEncoded.low.z;

    // Color (normalized) + size
    if (colors && colors.length >= pointCount * 3) {
      const cn = colors instanceof Uint8Array ? 1.0 / 255.0 : 1.0;
      data[off + 6] = colors[i * 3] * cn;
      data[off + 7] = colors[i * 3 + 1] * cn;
      data[off + 8] = colors[i * 3 + 2] * cn;
    } else {
      data[off + 6] = 1.0;
      data[off + 7] = 1.0;
      data[off + 8] = 1.0;
    }
    data[off + 9] = 3.0; // default point size
  }

  // When GPU LOD might activate, OR in STORAGE usage so the same buffer
  // can back both the VB-instanced default path and the storage-backed
  // LOD path without duplicating 40 bytes/point of GPU memory.
  let usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
  if (allowStorage) {
    usage |= GPUBufferUsage.STORAGE;
  }
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage,
  });
  device.queue.writeBuffer(buffer, 0, gpuData(data));
  return { buffer, count: pointCount, worldX, worldY, worldZ };
}

function packUniforms(
  uniformState: CesiumUniformState,
  modelMatrix: Matrix4 | CesiumMatrix4,
): Float32Array {
  const data = new Float32Array(28);
  const view = uniformState.view;
  const projection = uniformState.projection;

  // RTE: zero the translation column of MV *before* multiplying by
  // projection. Zeroing after the multiply wipes out projection's P23
  // depth-mapping term. See
  // `UniformStateComputations.cleanModelViewProjectionRelativeToEye`.
  const mvRte = Matrix4.multiply(view, modelMatrix, scratchMVRTE);
  mvRte[12] = 0;
  mvRte[13] = 0;
  mvRte[14] = 0;
  const mvp = m4Values(Matrix4.multiply(projection, mvRte, scratchMVP));
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }

  const camWorld = uniformState.cameraPosition;
  const invModel = Matrix4.inverse(modelMatrix, new Matrix4());
  const camModel = Matrix4.multiplyByPoint(
    invModel,
    camWorld,
    new Cartesian3(),
  );
  EncodedCartesian3.fromCartesian(camModel, scratchEncoded);
  data[16] = scratchEncoded.high.x;
  data[17] = scratchEncoded.high.y;
  data[18] = scratchEncoded.high.z;
  data[19] = 0;
  data[20] = scratchEncoded.low.x;
  data[21] = scratchEncoded.low.y;
  data[22] = scratchEncoded.low.z;
  data[23] = 0;

  const canvas = uniformState._context?._canvas || {
    width: 1920,
    height: 1080,
  };
  data[24] = canvas.width;
  data[25] = canvas.height;
  data[26] = 1.0; // pointSizeMultiplier
  data[27] = 0; // pad
  return data;
}

function updateWebGPUPointCloud(
  pointCloud: PointCloudLike,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const commandList = frameState.commandList;

  if (!pointCloud._webgpuCache) {
    pointCloud._webgpuCache = {
      uniformBuffer: null,
      pipeline: null,
      shaderModule: null,
      bindGroup: null,
      quadVertexBuffer: null,
      instanceBuffer: null,
      instanceCount: 0,
      command: null,
      initialized: false,
      lastRevision: -1,
      lodPipeline: null,
      lodBindGroupLayout: null,
      lodStorageBindGroup: null,
      lodIndirectBuffer: null,
      lodPositionsX: null,
      lodPositionsY: null,
      lodPositionsZ: null,
      lodUploadedRevision: -1,
      lodCommand: null,
      lodActive: false,
    } as PointCloudCache;
  }

  const cache = pointCloud._webgpuCache as PointCloudCache;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  if (!cache.initialized) {
    cache.uniformBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const { pipeline, shaderModule, bgl } = buildPipeline(device, canvasFormat);
    cache.pipeline = pipeline;
    cache.shaderModule = shaderModule;

    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer } }],
    });

    cache.quadVertexBuffer = createQuadVB(device);
    cache.initialized = true;
  }

  // Decide whether GPU LOD can apply this frame. Opt-in flag + lazy
  // processor init + point count threshold are all checked. If any of
  // them says no we stay on the existing VB-instanced path.
  const optIn = pointCloud.enableGPULOD === true;
  const pointCount = pointCloud._pointsLength ?? 0;
  // `context.pointCloudLOD` is typed as `object | null` on the
  // backend-agnostic `CesiumGraphicsContext` surface — cast to the real
  // processor interface at the boundary. Doing the cast here once
  // avoids scattering `as unknown as …` through the hot path below.
  const lodProcessor = optIn
    ? ((context.pointCloudLOD as WebGPUPointCloudLODProcessorInstance | null) ??
      null)
    : null;
  const lodPossible =
    optIn && pointCount >= POINT_COUNT_LOD_THRESHOLD && lodProcessor !== null;

  // Rebuild instance data when point data changes. When LOD might be
  // active we need STORAGE usage on the buffer AND the SOA world-space
  // arrays for the LOD processor; we speculatively build both whenever
  // the opt-in flag is set so flipping enableGPULOD mid-session doesn't
  // require a rebuild.
  const modelMatrix = pointCloud.modelMatrix ?? Matrix4.IDENTITY;
  const revision = pointCount;
  if (revision !== cache.lastRevision || !cache.instanceBuffer) {
    if (cache.instanceBuffer) {
      cache.instanceBuffer.destroy();
    }
    const result = buildInstanceBuffer(device, pointCloud, modelMatrix, optIn);
    cache.instanceBuffer = result.buffer;
    cache.instanceCount = result.count;
    cache.lastRevision = revision;
    cache.lodPositionsX = result.worldX;
    cache.lodPositionsY = result.worldY;
    cache.lodPositionsZ = result.worldZ;
    cache.command = null;
    cache.lodCommand = null;
    cache.lodStorageBindGroup = null;
    cache.lodUploadedRevision = -1;
  }

  if (cache.instanceCount === 0) {
    return;
  }

  // Per-frame uniforms
  const uniforms = packUniforms(context.uniformState, modelMatrix);
  device.queue.writeBuffer(cache.uniformBuffer!, 0, gpuData(uniforms));

  // ── Fast path: opt-in + above threshold + processor ready ──
  if (
    lodPossible &&
    lodProcessor!.isReady &&
    cache.lodPositionsX &&
    cache.lodPositionsY &&
    cache.lodPositionsZ
  ) {
    _runGPULODPath(
      device,
      context,
      frameState,
      commandList,
      cache,
      lodProcessor!,
      pointCloud,
      modelMatrix,
      canvasFormat,
    );
    return;
  }

  // ── Default path (current behaviour, untouched) ──
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.pipeline,
      bindGroups: [cache.bindGroup],
      vertexBuffers: [cache.quadVertexBuffer, cache.instanceBuffer],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: Pass.OPAQUE,
    });
  }

  commandList.push(cache.command);
}

/**
 * GPU LOD fast path. Uploads positions to the shared LOD processor the
 * first time a given revision is seen, dispatches the LOD compute pass
 * each frame, copies the atomic visibleCount into the indirect draw
 * instanceCount slot, and issues a drawIndirect that draws only the
 * visible points.
 *
 * Fails gracefully: any missing resource drops back to the caller which
 * re-routes through the default path on the next frame.
 */
function _runGPULODPath(
  device: GPUDevice,
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  commandList: CesiumAnyDrawCommand[],
  cache: PointCloudCache,
  lodProcessor: WebGPUPointCloudLODProcessorInstance,
  pointCloud: PointCloudLike,
  modelMatrix: Matrix4 | CesiumMatrix4,
  canvasFormat: GPUTextureFormat,
): void {
  // Build the LOD pipeline + storage BGL lazily. Both are per-device
  // not per-instance, but storing them on the cache is simpler than
  // a device-keyed shared map and point cloud instances are typically
  // few enough that the duplication doesn't matter.
  if (!cache.lodPipeline) {
    const { pipeline, bgl, storageBGL } = _buildLODPipeline(
      device,
      canvasFormat,
    );
    cache.lodPipeline = pipeline;
    cache.lodBindGroupLayout = storageBGL;
    // Rebuild the uniform bind group against the LOD pipeline's BGL too
    // so both pipelines can share the same uniform buffer.
    cache.bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: cache.uniformBuffer! } }],
    });
  }

  // Upload positions once per revision. uploadPositions invalidates
  // the processor's bind group internally so we don't need to track that.
  if (cache.lodUploadedRevision !== cache.lastRevision) {
    lodProcessor.uploadPositions(
      cache.lodPositionsX!,
      cache.lodPositionsY!,
      cache.lodPositionsZ!,
    );
    cache.lodUploadedRevision = cache.lastRevision;
    cache.lodStorageBindGroup = null; // force rebuild (visibleIndices buf may have changed)
  }

  // Allocate the indirect draw buffer once. Layout is [vertexCount=6,
  // instanceCount=<copied each frame>, firstVertex=0, firstInstance=0].
  if (!cache.lodIndirectBuffer) {
    const init = new Uint32Array([6, 0, 0, 0]);
    cache.lodIndirectBuffer = device.createBuffer({
      label: "PointCloud LOD indirect draw",
      size: 16,
      usage:
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.STORAGE,
    });
    device.queue.writeBuffer(cache.lodIndirectBuffer, 0, init.buffer);
  }

  // Storage bind group references the processor's visibleIndices buffer
  // — rebuild whenever we upload new positions (processor may have
  // grown the buffer). Bound to @group(1) of the LOD pipeline.
  if (!cache.lodStorageBindGroup && lodProcessor.visibleIndicesBuffer) {
    cache.lodStorageBindGroup = device.createBindGroup({
      label: "PointCloud LOD storage BG",
      layout: cache.lodBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.instanceBuffer! } },
        { binding: 1, resource: { buffer: lodProcessor.visibleIndicesBuffer } },
      ],
    });
  }
  if (!cache.lodStorageBindGroup) {
    // Processor not quite ready (async init still running). Fall back
    // to the default path by returning — caller pushes nothing here.
    return;
  }

  // Build the frustum planes in world space. The LOD processor tests
  // `dot(plane.xyz, worldPos) + plane.w >= 0` per point.
  const frustumPlanes = _extractFrustumPlanes(context.uniformState, frameState);

  // Distance² thresholds derived from the camera/frustum far plane.
  // These are coarse — tiles with per-tile geometricError can override
  // by mutating pointCloud.lodDistances before the update.
  const far =
    pointCloud.lodFarDistance ?? frameState.camera?.frustum?.far ?? 1e7;
  const lod0 = far * 0.1;
  const lod1 = far * 0.25;
  const lod2 = far * 0.5;
  const lod3 = far;

  const camPos = context.uniformState.cameraPosition;
  const encoder = device.createCommandEncoder({
    label: "PointCloud LOD dispatch",
  });
  lodProcessor.dispatch(encoder, {
    cameraPositionWC: [camPos.x, camPos.y, camPos.z],
    lod0Distance2: lod0 * lod0,
    lod1Distance2: lod1 * lod1,
    lod2Distance2: lod2 * lod2,
    lod3Distance2: lod3 * lod3,
    frustumPlanes,
    pointCount: cache.instanceCount,
    maxVisiblePoints: cache.instanceCount,
    screenSpaceRadius: 1.0,
    geometricError: pointCloud.geometricError ?? 0.0,
  });
  // Copy the atomic visibleCount (first u32) into the indirect draw
  // arg's instanceCount slot (offset 4, length 4).
  encoder.copyBufferToBuffer(
    lodProcessor.visibleCountBuffer!,
    0,
    cache.lodIndirectBuffer,
    4,
    4,
  );
  device.queue.submit([encoder.finish()]);

  // Emit a drawIndirect command. The scene renderer's execute path
  // recognizes `_drawIndirectBuffer` and routes through drawIndirect
  // instead of the default instanced draw.
  if (!cache.lodCommand) {
    // Don't widen to `CesiumAnyDrawCommand` before the constructor —
    // the upstream ambient types `pipeline` as optional (for WebGL's
    // shaderProgram-shaped variant) but `WebGPUDrawCommandOptions`
    // requires it, and widening trips the assignability check. Build
    // the WebGPU-shape options object directly instead.
    cache.lodCommand = new WebGPUDrawCommand({
      pipeline: cache.lodPipeline,
      bindGroups: [cache.bindGroup, cache.lodStorageBindGroup],
      vertexBuffers: [cache.quadVertexBuffer],
      vertexCount: 6,
      instanceCount: 0, // filled by drawIndirect
      pass: Pass.OPAQUE,
      drawIndirectBuffer: cache.lodIndirectBuffer,
    });
  }
  commandList.push(cache.lodCommand);
}

/**
 * Build the LOD-variant pipeline and both bind group layouts:
 *   group 0 (bgl):        uniform buffer
 *   group 1 (storageBGL): instanceData (storage, read) + visibleIndices (storage, read)
 */
function _buildLODPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): {
  pipeline: GPURenderPipeline;
  bgl: GPUBindGroupLayout;
  storageBGL: GPUBindGroupLayout;
} {
  const shaderModule = device.createShaderModule({
    label: "PointCloud LOD Shader",
    code: POINT_CLOUD_LOD_WGSL,
  });
  const bgl = makeBindGroupLayout(device, "PointCloud LOD uniform BGL", [
    uniformBuffer(0, Stage.VERTEX),
  ]);
  // Storage bind group — we use the helpers' storageBuffer readOnly
  // shape so the layout matches `var<storage, read>`.
  const storageBGL = device.createBindGroupLayout({
    label: "PointCloud LOD storage BGL",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  const pipeline = device.createRenderPipeline({
    label: "PointCloud LOD Pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bgl, storageBGL],
    }),
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMainLOD",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex" as GPUVertexStepMode,
          attributes: [
            {
              shaderLocation: 0,
              offset: 0,
              format: "float32x2" as GPUVertexFormat,
            },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMainLOD",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
  return { pipeline, bgl, storageBGL };
}

/**
 * Extract six world-space frustum planes from the current camera as a
 * Float32Array of 24 floats (6 × vec4). Each plane is `(n.x, n.y, n.z, d)`
 * where the "inside" test is `dot(n, worldPos) + d >= 0`.
 */
function _extractFrustumPlanes(
  uniformState: CesiumUniformState,
  frameState: CesiumFrameState,
): Float32Array {
  const out = new Float32Array(24);
  const cullingVolume = frameState.cullingVolume;
  const planes = cullingVolume?.planes;
  if (planes && planes.length >= 6) {
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      out[i * 4 + 0] = p.x;
      out[i * 4 + 1] = p.y;
      out[i * 4 + 2] = p.z;
      out[i * 4 + 3] = p.w;
    }
  }
  return out;
  // Silence unused-import lint in case uniformState isn't consumed
  // — kept in the signature for callers that want to compose against it.
  void uniformState;
}

function destroyWebGPUPointCloudResources(pointCloud: PointCloudLike): void {
  const cache = pointCloud._webgpuCache as PointCloudCache | undefined;
  if (!cache) {
    return;
  }
  cache.uniformBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.instanceBuffer?.destroy();
  cache.lodIndirectBuffer?.destroy();
  // Pipelines / bind groups / layouts are GC'd when references drop.
  // The LOD processor itself lives on the WebGPUContext — don't destroy
  // it here since it may be shared with other point clouds.
  pointCloud._webgpuCache = undefined;
}

export { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
export default { updateWebGPUPointCloud, destroyWebGPUPointCloudResources };
