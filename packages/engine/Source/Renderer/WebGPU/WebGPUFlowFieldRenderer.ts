/// <reference types="@webgpu/types" />
/**
 * WebGPU Flow-Field Wind Renderer.
 *
 * GPU flow-field particle advection over the globe: a ping-pong compute pass
 * advects N particles across a velocity field (an RGBA8 imagery texture,
 * R = u/east, G = v/north, normalized against the sidecar min/max), and an
 * instanced point draw vertex-pulls each particle's lon/lat, converts it to a
 * WGS84 ellipsoid position, RTE-splits it, and rasterizes an anti-aliased dot.
 *
 * Opt-in, default-off: the whole GPU resource set (velocity texture, ping-pong
 * state buffers, compute + render pipelines, uniform buffers) is allocated
 * lazily on the first `update()` of a `FlowFieldWindLayer` whose `show` is true
 * and whose velocity source has finished loading. Removing the layer (or
 * `show = false`, or destroying it) frees everything — nothing lingers when
 * the feature is off. WebGL contexts never register this renderer, so on WebGL
 * a `FlowFieldWindLayer` renders nothing (documented no-op, Principle 2/10).
 *
 * Compute scheduling mirrors `WebGPUComputeInstanceRenderer` /
 * `WebGPUWeatherRenderer`: the advection dispatch records on its OWN command
 * encoder and submits immediately during the layer's update — queue submission
 * order guarantees it runs before the scene render submit that consumes the
 * state buffer.
 *
 * Technique reference: mapbox/webgl-wind (ISC) fragment ping-pong ported to a
 * WGSL compute kernel; Cesium GPU-wind blog (RaymanNg/3D-Wind-Field, MIT) for
 * the globe lon/lat integration. Velocity SAMPLE data is NOAA GFS, public
 * domain.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import FlowFieldAdvectWGSL from "../../Shaders/WebGPU/FlowFieldAdvect.js";
import FlowFieldRenderWGSL from "../../Shaders/WebGPU/FlowFieldRender.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  texture as textureEntry,
  sampler as samplerEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { getAvailableFrameCommandEncoder } from "./WebGPUFrameCommandEncoder.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

// WGS84 (m) — the render shader converts lon/lat → ellipsoid ECEF using these.
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245179;

const STATE_BYTES_PER_PARTICLE = 16; // one vec4<f32>: lon, lat, age, speed01
const COMPUTE_WORKGROUP_SIZE = 64;
const CAMERA_UNIFORM_FLOATS = 44; // mat4 + vec2 + pads + 2×(vec3+pad) + mat4
const COMPUTE_PARAMS_BYTES = 64;
const RENDER_PARAMS_BYTES = 48;

// Per-device shader module cache so split-screen contexts share the compiled
// render module. Holds the render module only; the
// advection compute module has no ifdef variants and is created directly.
const _renderShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getRenderShaderModuleCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _renderShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _renderShaderModuleCaches.set(device, cache);
  }
  return cache;
}

interface FlowFieldCache {
  initialized: boolean;
  particleCount: number;
  // Velocity texture (uploaded once from the layer's decoded image).
  velocityTexture: GPUTexture | null;
  velocitySampler: GPUSampler | null;
  velocityImageVersion: number;
  // Compute side
  computePipeline: GPUComputePipeline | null;
  computeBindGroupLayout: GPUBindGroupLayout | null;
  // One bind group per ping-pong orientation (reads prev, writes cur).
  computeBindGroups: Array<GPUBindGroup | null>;
  computeParamsBuffer: GPUBuffer | null;
  computeParamsData: Float32Array;
  stateBuffers: Array<GPUBuffer | null>;
  pingPongIndex: number;
  // Render side
  quadVertexBuffer: GPUBuffer | null;
  cameraUniformBuffer: GPUBuffer | null;
  cameraUniformData: Float32Array;
  renderParamsBuffer: GPUBuffer | null;
  renderParamsData: Float32Array;
  renderShaderModule: GPUShaderModule | null;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroups: Array<GPUBindGroup | null>;
  renderPipeline: GPURenderPipeline | null;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  renderPipelineRequestPending: boolean;
  command: WebGPUDrawCommand | null;
  frameNumber: number;
  _pipelineFormatGeneration?: number;
  _logDepthEnabled?: boolean;
}

// Minimal shape the renderer reads off the FlowFieldWindLayer (Scene file is
// JS; these are the fields it sets before routing here).
interface FlowFieldLayerLike {
  show?: boolean;
  _particleCount?: number;
  _velocityImage?: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  _velocityWidth?: number;
  _velocityHeight?: number;
  _velocityReady?: boolean;
  _velocityVersion?: number;
  _uMin?: number;
  _uMax?: number;
  _vMin?: number;
  _vMax?: number;
  _speedScale?: number;
  _lifetime?: number;
  _dropRate?: number;
  _maxSpeed?: number;
  _heightOffset?: number;
  _pixelSize?: number;
  _alpha?: number;
  _colorSlow?: { red: number; green: number; blue: number };
  _colorFast?: { red: number; green: number; blue: number };
  _initialState?: Float32Array;
  _webgpuCache?: unknown;
}

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMVRTE = new Matrix4();

const QUAD_VERTEX_LAYOUT: GPUVertexBufferLayout[] = [
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
];

function createQuadVB(device: GPUDevice): GPUBuffer {
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    label: "FlowField quad VB",
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

/**
 * Upload the velocity field image into an rgba8unorm texture (once, or when
 * the layer swaps its source). Bilinear filtering + repeat-in-U addressing
 * (antimeridian wrap) / clamp-in-V.
 */
function uploadVelocityTexture(
  device: GPUDevice,
  cache: FlowFieldCache,
  layer: FlowFieldLayerLike,
): void {
  const image = layer._velocityImage;
  const w = layer._velocityWidth ?? 0;
  const h = layer._velocityHeight ?? 0;
  if (!image || w <= 0 || h <= 0) {
    return;
  }
  cache.velocityTexture?.destroy();
  const tex = device.createTexture({
    label: "FlowField velocity texture",
    size: { width: w, height: h },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: image, flipY: false },
    { texture: tex },
    { width: w, height: h },
  );
  cache.velocityTexture = tex;
  if (!cache.velocitySampler) {
    cache.velocitySampler = device.createSampler({
      label: "FlowField velocity sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
    });
  }
  cache.velocityImageVersion = layer._velocityVersion ?? 0;
  // Buffers/bind groups that reference the texture must rebuild.
  cache.computeBindGroups = [null, null];
}

/**
 * (Re)allocate the ping-pong state buffers and seed them with the layer's
 * deterministic initial state (both buffers, so the first compute reads valid
 * prev state). Runs on count change.
 */
function allocateStateBuffers(
  device: GPUDevice,
  cache: FlowFieldCache,
  count: number,
  initialState: Float32Array | undefined,
): void {
  cache.stateBuffers[0]?.destroy();
  cache.stateBuffers[1]?.destroy();
  const size = Math.max(
    count * STATE_BYTES_PER_PARTICLE,
    STATE_BYTES_PER_PARTICLE,
  );
  const seed =
    initialState && initialState.length >= count * 4
      ? initialState.subarray(0, count * 4)
      : new Float32Array(Math.max(count * 4, 4));
  for (let i = 0; i < 2; i++) {
    const buf = device.createBuffer({
      label: `FlowField state ${i === 0 ? "A" : "B"}`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, seed);
    cache.stateBuffers[i] = buf;
  }
  cache.pingPongIndex = 0;
  cache.particleCount = count;
  cache.computeBindGroups = [null, null];
  cache.renderBindGroups = [null, null];
  cache.command = null;
}

function tryResolveRenderPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: FlowFieldCache,
): boolean {
  if (cache.renderPipeline) {
    return true;
  }
  const desc = cache.renderPipelineDescriptor;
  if (!desc) {
    return false;
  }
  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(desc);
    if (sync) {
      cache.renderPipeline = sync;
      cache.renderPipelineRequestPending = false;
      return true;
    }
    if (!cache.renderPipelineRequestPending) {
      cache.renderPipelineRequestPending = true;
      pipelineCache
        .getPipeline(desc)
        .then((p) => {
          cache.renderPipeline = p;
          cache.renderPipelineRequestPending = false;
        })
        .catch(() => {
          cache.renderPipelineRequestPending = false;
        });
    }
    return false;
  }
  cache.renderPipeline = device.createRenderPipeline({
    label: desc.name,
    layout: desc.layout ?? "auto",
    vertex: {
      module: desc.vertex.module,
      entryPoint: desc.vertex.entryPoint,
      buffers: desc.vertex.buffers,
    },
    fragment: desc.fragment
      ? {
          module: desc.fragment.module,
          entryPoint: desc.fragment.entryPoint,
          targets: desc.fragment.targets,
        }
      : undefined,
    primitive: desc.primitive,
    depthStencil: desc.depthStencil,
    multisample: desc.multisample,
  });
  return true;
}

function initializeFlowFieldResources(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  cache: FlowFieldCache,
  sceneFormat: GPUTextureFormat,
  logDepthActive: boolean,
): void {
  const computeModule = device.createShaderModule({
    label: "FlowField advect",
    code: FlowFieldAdvectWGSL,
  });
  const renderModule = getRenderShaderModuleCache(device).getOrCreate(
    ShaderSourceId.FLOW_FIELD_RENDER,
    FlowFieldRenderWGSL,
    logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    "FlowField render",
  );
  cache.renderShaderModule = renderModule;

  // ── Compute pipeline ──
  cache.computeBindGroupLayout = makeBindGroupLayout(
    device,
    "FlowField compute BGL",
    [
      storageBuffer(0, Stage.COMPUTE, { readOnly: true }), // particlesIn
      storageBuffer(1, Stage.COMPUTE), // particlesOut (read_write)
      uniformBuffer(2, Stage.COMPUTE), // params
      textureEntry(3, Stage.COMPUTE, { sampleType: "float" }), // velocity tex
      samplerEntry(4, Stage.COMPUTE, "filtering"), // velocity sampler
    ],
  );
  const computeLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.computeBindGroupLayout],
  });
  const computePipelineCache = (
    context as unknown as {
      webgpuComputePipelineCache?: {
        getOrCreateSync(d: {
          name: string;
          layout: GPUPipelineLayout;
          compute: { module: GPUShaderModule; entryPoint: string };
        }): GPUComputePipeline;
      } | null;
    }
  ).webgpuComputePipelineCache;
  if (computePipelineCache) {
    cache.computePipeline = computePipelineCache.getOrCreateSync({
      name: "FlowField advect dispatch",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "advectMain" },
    });
  } else {
    cache.computePipeline = device.createComputePipeline({
      label: "FlowField advect dispatch",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "advectMain" },
    });
  }

  cache.computeParamsBuffer = device.createBuffer({
    label: "FlowField compute params",
    size: COMPUTE_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ── Render pipeline (descriptor materialized via the central cache) ──
  cache.renderBindGroupLayout = makeBindGroupLayout(
    device,
    "FlowField render BGL",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT), // camera
      storageBuffer(1, Stage.VERTEX, { readOnly: true }), // particle state
      uniformBuffer(2, Stage.VERTEX), // render params
    ],
  );

  const sampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  cache.renderPipelineDescriptor = {
    name: `FlowField pipeline [${sceneFormat}/ms=${sampleCount}/ld=${logDepthActive ? 1 : 0}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.renderBindGroupLayout],
    }),
    vertex: {
      module: renderModule,
      entryPoint: "vertexMain",
      buffers: QUAD_VERTEX_LAYOUT,
    },
    fragment: {
      module: renderModule,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(sceneFormat, {
        blend: {
          color: {
            srcFactor: "src-alpha",
            dstFactor: "one-minus-src-alpha",
          },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  cache.quadVertexBuffer = createQuadVB(device);
  cache.cameraUniformBuffer = device.createBuffer({
    label: "FlowField camera UB",
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.renderParamsBuffer = device.createBuffer({
    label: "FlowField render params",
    size: RENDER_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

function packComputeParams(
  cache: FlowFieldCache,
  layer: FlowFieldLayerLike,
  count: number,
): void {
  const d = cache.computeParamsData;
  d[0] = layer._uMin ?? -1;
  d[1] = layer._vMin ?? -1;
  d[2] = layer._uMax ?? 1;
  d[3] = layer._vMax ?? 1;
  d[4] = layer._speedScale ?? 0.0002; // rad per (m/s) per frame at equator
  d[5] = layer._lifetime ?? 120.0; // frames
  d[6] = layer._dropRate ?? 0.003;
  d[7] = 0;
  // meta (u32 lanes 8..11)
  const u = new Uint32Array(d.buffer);
  u[8] = count >>> 0;
  u[9] = cache.frameNumber >>> 0;
  u[10] = 0;
  u[11] = 0;
  d[12] = layer._maxSpeed ?? 40.0; // speedRef.x
  d[13] = 0;
  d[14] = 0;
  d[15] = 0;
}

function packRenderParams(
  cache: FlowFieldCache,
  layer: FlowFieldLayerLike,
): void {
  const d = cache.renderParamsData;
  d[0] = WGS84_A * WGS84_A;
  d[1] = WGS84_A * WGS84_A;
  d[2] = WGS84_B * WGS84_B;
  d[3] = layer._heightOffset ?? 15000.0;
  const slow = layer._colorSlow ?? { red: 0.1, green: 0.35, blue: 1.0 };
  d[4] = slow.red;
  d[5] = slow.green;
  d[6] = slow.blue;
  d[7] = layer._pixelSize ?? 2.5;
  const fast = layer._colorFast ?? { red: 1.0, green: 1.0, blue: 1.0 };
  d[8] = fast.red;
  d[9] = fast.green;
  d[10] = fast.blue;
  d[11] = layer._alpha ?? 0.9;
}

/**
 * Per-frame update: upload the velocity texture (once), (re)allocate state on
 * count change, write params + camera, dispatch the advection compute, and
 * push the instanced point draw command.
 *
 * @private
 */
function updateWebGPUFlowField(
  layerObj: unknown,
  frameState: CesiumFrameState,
): void {
  const layer = layerObj as FlowFieldLayerLike;
  const context = frameState.context;
  const device: GPUDevice = context.device;
  if (!device) {
    return;
  }

  const count = layer._particleCount ?? 0;
  if (
    layer.show === false ||
    count === 0 ||
    layer._velocityReady !== true ||
    !layer._velocityImage
  ) {
    return;
  }

  if (!layer._webgpuCache) {
    layer._webgpuCache = {
      initialized: false,
      particleCount: -1,
      velocityTexture: null,
      velocitySampler: null,
      velocityImageVersion: -1,
      computePipeline: null,
      computeBindGroupLayout: null,
      computeBindGroups: [null, null],
      computeParamsBuffer: null,
      computeParamsData: new Float32Array(COMPUTE_PARAMS_BYTES / 4),
      stateBuffers: [null, null],
      pingPongIndex: 0,
      quadVertexBuffer: null,
      cameraUniformBuffer: null,
      cameraUniformData: new Float32Array(CAMERA_UNIFORM_FLOATS),
      renderParamsBuffer: null,
      renderParamsData: new Float32Array(RENDER_PARAMS_BYTES / 4),
      renderShaderModule: null,
      renderBindGroupLayout: null,
      renderBindGroups: [null, null],
      renderPipeline: null,
      renderPipelineDescriptor: null,
      renderPipelineRequestPending: false,
      command: null,
      frameNumber: 0,
    } as FlowFieldCache;
  }
  const cache = layer._webgpuCache as FlowFieldCache;

  const ctxAny = context as unknown as {
    scenePipelineFormat?: GPUTextureFormat;
    presentationFormat?: GPUTextureFormat;
    _scenePipelineFormatGeneration?: number;
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  const sceneFormat: GPUTextureFormat =
    ctxAny.scenePipelineFormat ?? ctxAny.presentationFormat ?? "bgra8unorm";
  const sceneGen = ctxAny._scenePipelineFormatGeneration ?? 0;
  const logDepthActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );

  // Full re-init on a log-depth flip or scene-format-generation bump so the
  // render module + pipeline rebuild against the new mode/format.
  if (
    cache.initialized &&
    (cache._logDepthEnabled !== logDepthActive ||
      cache._pipelineFormatGeneration !== sceneGen)
  ) {
    cache.initialized = false;
    cache.renderPipeline = null;
    cache.renderPipelineDescriptor = null;
    cache.renderPipelineRequestPending = false;
    cache.renderBindGroups = [null, null];
    cache.command = null;
  }

  if (!cache.initialized) {
    initializeFlowFieldResources(
      context,
      device,
      cache,
      sceneFormat,
      logDepthActive,
    );
    cache._pipelineFormatGeneration = sceneGen;
    cache._logDepthEnabled = logDepthActive;
  }

  // Velocity texture upload (once, or when the layer swaps its source).
  if (
    !cache.velocityTexture ||
    cache.velocityImageVersion !== (layer._velocityVersion ?? 0)
  ) {
    uploadVelocityTexture(device, cache, layer);
  }
  if (!cache.velocityTexture) {
    return;
  }

  // (Re)allocate + seed the ping-pong state on count change.
  if (cache.particleCount !== count || !cache.stateBuffers[0]) {
    allocateStateBuffers(device, cache, count, layer._initialState);
  }

  if (
    !tryResolveRenderPipeline(device, ctxAny.webgpuPipelineCache ?? null, cache)
  ) {
    return;
  }

  // Ping-pong: read prev, write cur, then cur becomes next frame's prev.
  const prev = cache.pingPongIndex;
  const cur = 1 - prev;
  const prevBuffer = cache.stateBuffers[prev]!;
  const curBuffer = cache.stateBuffers[cur]!;

  if (!cache.computeBindGroups[cur]) {
    cache.computeBindGroups[cur] = device.createBindGroup({
      label: `FlowField compute BG [${cur}]`,
      layout: cache.computeBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: prevBuffer } },
        { binding: 1, resource: { buffer: curBuffer } },
        { binding: 2, resource: { buffer: cache.computeParamsBuffer! } },
        { binding: 3, resource: cache.velocityTexture.createView() },
        { binding: 4, resource: cache.velocitySampler! },
      ],
    });
  }
  if (!cache.renderBindGroups[cur]) {
    cache.renderBindGroups[cur] = device.createBindGroup({
      label: `FlowField render BG [${cur}]`,
      layout: cache.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: curBuffer } },
        { binding: 2, resource: { buffer: cache.renderParamsBuffer! } },
      ],
    });
  }

  // ── Uploads: compute params (with frame number) + render params ──
  packComputeParams(cache, layer, count);
  device.queue.writeBuffer(
    cache.computeParamsBuffer!,
    0,
    cache.computeParamsData,
  );
  packRenderParams(cache, layer);
  device.queue.writeBuffer(
    cache.renderParamsBuffer!,
    0,
    cache.renderParamsData,
  );

  // Join the frame submission when update runs in the normal pre-render phase;
  // retain the private encoder only for off-frame/direct callers.
  const workgroups = Math.ceil(count / COMPUTE_WORKGROUP_SIZE);
  const frameEncoder = getAvailableFrameCommandEncoder(context);
  const encoder =
    frameEncoder ?? device.createCommandEncoder({ label: "FlowField advect" });
  const pass = encoder.beginComputePass({ label: "FlowField advect pass" });
  pass.setPipeline(cache.computePipeline!);
  pass.setBindGroup(0, cache.computeBindGroups[cur]!);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
  if (!frameEncoder) {
    device.queue.submit([encoder.finish()]);
  }

  cache.frameNumber++;
  cache.pingPongIndex = cur;

  // ── Camera uniforms (RTE) ──
  const us = context.uniformState;
  Matrix4.clone(us.view, scratchMVRTE);
  scratchMVRTE[12] = 0;
  scratchMVRTE[13] = 0;
  scratchMVRTE[14] = 0;
  const mvp = m4Values(
    Matrix4.multiply(us.projection, scratchMVRTE, scratchMVP),
  );
  const data = cache.cameraUniformData;
  for (let i = 0; i < 16; i++) {
    data[i] = mvp[i];
  }
  const canvas = context._canvas || { width: 1920, height: 1080 };
  data[16] = canvas.width;
  data[17] = canvas.height;
  const usLog = us as unknown as {
    currentFrustum?: { x: number; y: number };
    oneOverLog2FarDepthFromNearPlusOne?: number;
  };
  const ldNear = usLog.currentFrustum?.x ?? 0.0;
  const ldFar = usLog.currentFrustum?.y ?? 0.0;
  let ldFactor =
    typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
      ? usLog.oneOverLog2FarDepthFromNearPlusOne
      : 0.0;
  if (!(ldFactor > 0.0) && ldFar > ldNear) {
    const log2Far = Math.log2(ldFar - ldNear + 1.0);
    ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
  }
  data[18] = ldNear;
  data[19] = ldFar;
  EncodedCartesian3.fromCartesian(us.cameraPosition, scratchEncoded);
  data[20] = scratchEncoded.high.x;
  data[21] = scratchEncoded.high.y;
  data[22] = scratchEncoded.high.z;
  data[23] = ldFactor;
  data[24] = scratchEncoded.low.x;
  data[25] = scratchEncoded.low.y;
  data[26] = scratchEncoded.low.z;
  data[27] = 0;
  const prevVP = (us as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, data, 28);
  } else {
    data.fill(0, 28, 44);
    data[28] = 1;
    data[33] = 1;
    data[38] = 1;
    data[43] = 1;
  }
  device.queue.writeBuffer(cache.cameraUniformBuffer!, 0, data);

  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.renderPipeline!,
      bindGroups: [cache.renderBindGroups[cur]!],
      vertexBuffers: [cache.quadVertexBuffer!],
      vertexCount: 6,
      instanceCount: count,
      pass: Pass.TRANSLUCENT,
    });
  }
  const command = cache.command;
  command.instanceCount = count;
  command.bindGroups[0] = cache.renderBindGroups[cur]!;
  command.bindGroup = command.bindGroups[0];
  // No bounding volume — particles span the whole globe, so bin into all
  // frustums (never culled), matching the compute-instance no-BV default.
  command.boundingVolume = undefined;
  command.cull = false;

  frameState.commandList.push(command);
}

function destroyWebGPUFlowFieldResources(layerObj: unknown): void {
  const layer = layerObj as FlowFieldLayerLike;
  const cache = layer._webgpuCache as FlowFieldCache | undefined;
  if (!cache) {
    return;
  }
  cache.velocityTexture?.destroy();
  cache.stateBuffers[0]?.destroy();
  cache.stateBuffers[1]?.destroy();
  cache.computeParamsBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.cameraUniformBuffer?.destroy();
  cache.renderParamsBuffer?.destroy();
  layer._webgpuCache = undefined;
}

export { updateWebGPUFlowField, destroyWebGPUFlowFieldResources };
export default { updateWebGPUFlowField, destroyWebGPUFlowFieldResources };
