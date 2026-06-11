/// <reference types="@webgpu/types" />
/**
 * WebGPU Orbital Catalog Renderer — Phase 3 of the Large Dynamic Objects
 * roadmap (NEW-ORBITAL-GPU-RESIDENT-RENDERER).
 *
 * GPU-resident rendering for `OrbitalCatalogCollection`: the element
 * catalog (circular-orbit elements + color/size per object) is uploaded
 * ONCE to a read-only storage buffer; every frame a compute dispatch
 * (`OrbitalPropagate.wgsl`, one invocation per object) writes propagated
 * positions as RTE high/low pairs into a second storage buffer; the
 * instanced draw (`OrbitalCatalogRender.wgsl`) vertex-pulls
 * `positions[instance_index]` directly from that buffer. Object positions
 * never leave the GPU — the CPU's per-frame upload is the camera uniform
 * block plus ONE scalar (simulation time).
 *
 * What's shipped in this batch (230):
 *   - circular-orbit compute propagation + instanced storage-pull draw
 *   - catalog dirty upload (re-upload only when the collection changes)
 *   - scene-FB pipeline with baked MSAA sample count (cloud Batch-228 rule)
 * Currently deferred (tracked in DEFERRED_WORK.md):
 *   - J2/SGP4 kernels (NEW-ORBITAL-J2-KERNEL / NEW-ORBITAL-SGP4-KERNEL)
 *   - Earth-rotation (GMST) so RAAN is truly inertial
 *   - WebGL2 fallback (NEW-ORBITAL-SGP4-WASM-WORKER)
 *   - picking (NEW-ORBITAL-GPU-PICKING) and TAA motion vectors
 *
 * Compute scheduling mirrors `WebGPUWeatherRenderer`: the dispatch is
 * recorded on its OWN command encoder and submitted immediately during the
 * collection's update — queue submission order guarantees it executes
 * before the scene's render submit that consumes the positions buffer.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import OrbitalPropagateWGSL from "../../Shaders/WebGPU/Compute/OrbitalPropagate.js";
import OrbitalCatalogRenderWGSL from "../../Shaders/WebGPU/Compute/OrbitalCatalogRender.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

// Per-device shader module cache so two contexts (split-screen) share the
// compiled modules (C-R7-SHADER-MODULE-DEDUP pattern).
const _orbitalShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();

function getOrbitalShaderModuleCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _orbitalShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _orbitalShaderModuleCaches.set(device, cache);
  }
  return cache;
}

// Element record: 8 × 4 bytes. MUST match `OrbitalElement` in both WGSL
// files and the pack loop below.
const ELEMENT_FLOATS = 8;
const ELEMENT_BYTES = ELEMENT_FLOATS * 4;
// PositionHL: two vec3<f32> at 16-byte alignment = 32 bytes.
const POSITION_BYTES = 32;
// CameraUniforms: mat4 + vec2 + pads + 2×(vec3+pad) + mat4 = 176 bytes.
const CAMERA_UNIFORM_FLOATS = 44;
const PROPAGATE_WORKGROUP_SIZE = 64;

interface OrbitalElementRecord {
  semiMajorAxis: number;
  inclination: number;
  raan: number;
  phase: number;
  meanMotion: number;
  epochOffset: number;
  color: { red: number; green: number; blue: number; alpha: number };
  pixelSize: number;
}

interface OrbitalCatalogCache {
  initialized: boolean;
  // Compute side
  computePipeline: GPUComputePipeline | null;
  computeBindGroupLayout: GPUBindGroupLayout | null;
  computeBindGroup: GPUBindGroup | null;
  paramsBuffer: GPUBuffer | null;
  paramsData: Float32Array;
  // Catalog buffers
  elementBuffer: GPUBuffer | null;
  positionBuffer: GPUBuffer | null;
  elementCount: number;
  // Render side
  quadVertexBuffer: GPUBuffer | null;
  cameraUniformBuffer: GPUBuffer | null;
  cameraUniformData: Float32Array;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroup: GPUBindGroup | null;
  renderPipeline: GPURenderPipeline | null;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  renderPipelineRequestPending: boolean;
  command: WebGPUDrawCommand | null;
  _pipelineFormatGeneration?: number;
}

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMVRTE = new Matrix4();

function createQuadVB(device: GPUDevice): GPUBuffer {
  // [-1,1] quad, 2 triangles, 6 vertices — same shape as the cloud quad.
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    label: "OrbitalCatalog quad VB",
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

function packColorRGBA8(c: {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}): number {
  const r = Math.max(0, Math.min(255, Math.round((c.red ?? 1) * 255)));
  const g = Math.max(0, Math.min(255, Math.round((c.green ?? 1) * 255)));
  const b = Math.max(0, Math.min(255, Math.round((c.blue ?? 1) * 255)));
  const a = Math.max(0, Math.min(255, Math.round((c.alpha ?? 1) * 255)));
  // r in the low byte — matches WGSL unpack4x8unorm component order.
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

/**
 * Pack the collection's element records into the GPU element layout and
 * upload. Runs only when the catalog is dirty (add/remove/edit) — NOT per
 * frame.
 */
function uploadCatalog(
  device: GPUDevice,
  cache: OrbitalCatalogCache,
  records: OrbitalElementRecord[],
): void {
  const count = records.length;

  if (count !== cache.elementCount) {
    cache.elementBuffer?.destroy();
    cache.positionBuffer?.destroy();
    cache.elementBuffer = device.createBuffer({
      label: "OrbitalCatalog elements",
      size: Math.max(count * ELEMENT_BYTES, ELEMENT_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    cache.positionBuffer = device.createBuffer({
      label: "OrbitalCatalog positions",
      size: Math.max(count * POSITION_BYTES, POSITION_BYTES),
      usage: GPUBufferUsage.STORAGE,
    });
    // Buffer identity changed — bind groups and the draw command must be
    // rebuilt against the new resources.
    cache.computeBindGroup = null;
    cache.renderBindGroup = null;
    cache.command = null;
    cache.elementCount = count;
  }

  const data = new ArrayBuffer(Math.max(count, 1) * ELEMENT_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  for (let i = 0; i < count; i++) {
    const e = records[i];
    const off = i * ELEMENT_FLOATS;
    f32[off] = e.semiMajorAxis;
    f32[off + 1] = e.inclination;
    f32[off + 2] = e.raan;
    f32[off + 3] = e.phase;
    f32[off + 4] = e.meanMotion;
    f32[off + 5] = e.epochOffset;
    u32[off + 6] = packColorRGBA8(e.color);
    f32[off + 7] = e.pixelSize;
  }
  device.queue.writeBuffer(cache.elementBuffer!, 0, data);
}

/**
 * Resolve the render pipeline through the central pipeline cache
 * (C-R7-RENDERER-MIGRATION pattern — async on first frame, sync after).
 */
function tryResolveRenderPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: OrbitalCatalogCache,
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

  // Fallback: no central cache.
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

function initializeOrbitalResources(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  cache: OrbitalCatalogCache,
  sceneFormat: GPUTextureFormat,
): void {
  const moduleCache = getOrbitalShaderModuleCache(device);
  const computeModule = moduleCache.getOrCreate(
    ShaderSourceId.ORBITAL_PROPAGATE_COMPUTE,
    OrbitalPropagateWGSL,
    0,
    "OrbitalPropagate compute",
  );
  const renderModule = moduleCache.getOrCreate(
    ShaderSourceId.ORBITAL_CATALOG_RENDER,
    OrbitalCatalogRenderWGSL,
    0,
    "OrbitalCatalog render",
  );

  // ── Compute pipeline ──
  cache.computeBindGroupLayout = makeBindGroupLayout(
    device,
    "OrbitalCatalog compute BGL",
    [
      storageBuffer(0, Stage.COMPUTE, { readOnly: true }), // elements
      storageBuffer(1, Stage.COMPUTE), // positions (read_write)
      uniformBuffer(2, Stage.COMPUTE), // params
    ],
  );
  const computeLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.computeBindGroupLayout],
  });
  const computePipelineCache = context.webgpuComputePipelineCache ?? null;
  if (computePipelineCache) {
    cache.computePipeline = computePipelineCache.getOrCreateSync({
      name: "OrbitalCatalog propagate",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "propagate" },
    });
  } else {
    cache.computePipeline = device.createComputePipeline({
      label: "OrbitalCatalog propagate",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "propagate" },
    });
  }

  cache.paramsBuffer = device.createBuffer({
    label: "OrbitalCatalog propagate params",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ── Render pipeline (descriptor — materialized via the central cache) ──
  cache.renderBindGroupLayout = makeBindGroupLayout(
    device,
    "OrbitalCatalog render BGL",
    [
      uniformBuffer(0, Stage.VERTEX), // camera
      storageBuffer(1, Stage.VERTEX, { readOnly: true }), // positions
      storageBuffer(2, Stage.VERTEX, { readOnly: true }), // elements
    ],
  );

  // NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH rule (Batch 228) — scene-FB
  // pipelines MUST bake the MSAA sample count or attachment-state
  // validation invalidates the whole pass encoder. `ms=` is keyed into the
  // name so the central cache distinguishes sample-count variants.
  const sampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  cache.renderPipelineDescriptor = {
    name: `OrbitalCatalog pipeline [${sceneFormat}/ms=${sampleCount}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.renderBindGroupLayout],
    }),
    vertex: {
      module: renderModule,
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
      ],
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
    label: "OrbitalCatalog camera UB",
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

/**
 * Per-frame update: upload catalog when dirty, write the time uniform,
 * dispatch the propagation compute, and push the instanced draw command.
 *
 * Simulation time arrives via `collection._simulationTimeSeconds`, which
 * `OrbitalCatalogCollection.update()` derives from `frameState.time`
 * relative to the collection's epoch BEFORE routing to this renderer
 * (scene-logic-extractor pattern — the time source is backend-agnostic).
 */
function updateWebGPUOrbitalCatalog(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  if (!device) {
    return;
  }

  const records =
    (collection._objects as OrbitalElementRecord[] | undefined) ?? [];
  if (collection.show === false || records.length === 0) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      initialized: false,
      computePipeline: null,
      computeBindGroupLayout: null,
      computeBindGroup: null,
      paramsBuffer: null,
      paramsData: new Float32Array(4),
      elementBuffer: null,
      positionBuffer: null,
      elementCount: -1,
      quadVertexBuffer: null,
      cameraUniformBuffer: null,
      cameraUniformData: new Float32Array(CAMERA_UNIFORM_FLOATS),
      renderBindGroupLayout: null,
      renderBindGroup: null,
      renderPipeline: null,
      renderPipelineDescriptor: null,
      renderPipelineRequestPending: false,
      command: null,
    } as unknown as CesiumOpaqueObject;
  }
  const cache = collection._webgpuCache as unknown as OrbitalCatalogCache;

  // Scene-FB format + generation tracking (Batch 110 pattern) — HDR mode
  // targets rgba16float instead of canvas bgra8unorm.
  const ctxAny = context as unknown as {
    scenePipelineFormat?: GPUTextureFormat;
    presentationFormat?: GPUTextureFormat;
    _scenePipelineFormatGeneration?: number;
    webgpuPipelineCache?: WebGPURenderPipelineCache | null;
  };
  const sceneFormat: GPUTextureFormat =
    ctxAny.scenePipelineFormat ?? ctxAny.presentationFormat ?? "bgra8unorm";
  const sceneGen = ctxAny._scenePipelineFormatGeneration ?? 0;
  if (cache.initialized && cache._pipelineFormatGeneration !== sceneGen) {
    cache.initialized = false;
    cache.renderPipeline = null;
    cache.renderPipelineDescriptor = null;
    cache.renderPipelineRequestPending = false;
    cache.renderBindGroup = null;
    cache.command = null;
    cache._pipelineFormatGeneration = sceneGen;
  }

  if (!cache.initialized) {
    initializeOrbitalResources(context, device, cache, sceneFormat);
    cache._pipelineFormatGeneration = sceneGen;
  }

  // Catalog upload — only when the collection reports dirty (or the count
  // drifted, which covers external mutation of the records array).
  if (
    collection._catalogDirty === true ||
    cache.elementCount !== records.length
  ) {
    uploadCatalog(device, cache, records);
  }
  // Phase-0 dirty-consume discipline: clear the collection's dirty state
  // every frame on the WebGPU path so settled catalogs never re-upload.
  if (typeof collection._consumeDirtyState === "function") {
    collection._consumeDirtyState();
  }

  if (cache.elementCount === 0) {
    return;
  }

  // Resolve the render pipeline; skip the frame while async creation is
  // in flight (never enqueue a draw with a null pipeline). The compute
  // dispatch is also skipped — there is no consumer for its output yet.
  if (
    !tryResolveRenderPipeline(device, ctxAny.webgpuPipelineCache ?? null, cache)
  ) {
    return;
  }

  // (Re)build bind groups when buffers changed.
  if (!cache.computeBindGroup) {
    cache.computeBindGroup = device.createBindGroup({
      label: "OrbitalCatalog compute BG",
      layout: cache.computeBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.elementBuffer! } },
        { binding: 1, resource: { buffer: cache.positionBuffer! } },
        { binding: 2, resource: { buffer: cache.paramsBuffer! } },
      ],
    });
  }
  if (!cache.renderBindGroup) {
    cache.renderBindGroup = device.createBindGroup({
      label: "OrbitalCatalog render BG",
      layout: cache.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: cache.positionBuffer! } },
        { binding: 2, resource: { buffer: cache.elementBuffer! } },
      ],
    });
    cache.command = null;
  }

  // ── Per-frame CPU upload #1: ONE time scalar (+ object count) ──
  const simTime = (collection._simulationTimeSeconds as number) ?? 0;
  const params = cache.paramsData;
  params[0] = simTime;
  new Uint32Array(params.buffer)[1] = cache.elementCount;
  device.queue.writeBuffer(cache.paramsBuffer!, 0, params);

  // Dispatch propagation on its own encoder (weather pattern) — submitted
  // now, so queue order places it before the scene's render submit.
  const workgroups = Math.ceil(cache.elementCount / PROPAGATE_WORKGROUP_SIZE);
  const encoder = device.createCommandEncoder({
    label: "OrbitalCatalog propagate",
  });
  const pass = encoder.beginComputePass({
    label: "OrbitalCatalog propagate pass",
  });
  pass.setPipeline(cache.computePipeline!);
  pass.setBindGroup(0, cache.computeBindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
  device.queue.submit([encoder.finish()]);

  // ── Per-frame CPU upload #2: camera uniforms ──
  // RTE: zero the VIEW translation column BEFORE multiplying by projection
  // (zeroing after the multiply wipes projection's P23 depth term — see
  // UniformStateComputations.cleanModelViewProjectionRelativeToEye).
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
  data[18] = 0;
  data[19] = 0;
  EncodedCartesian3.fromCartesian(us.cameraPosition, scratchEncoded);
  data[20] = scratchEncoded.high.x;
  data[21] = scratchEncoded.high.y;
  data[22] = scratchEncoded.high.z;
  data[23] = 0;
  data[24] = scratchEncoded.low.x;
  data[25] = scratchEncoded.low.y;
  data[26] = scratchEncoded.low.z;
  data[27] = 0;
  // DP-H41 — previousViewProjection at the struct tail (floats 28..43),
  // identity fallback on the first frame.
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
      bindGroups: [cache.renderBindGroup!],
      vertexBuffers: [cache.quadVertexBuffer!],
      vertexCount: 6,
      instanceCount: cache.elementCount,
      pass: Pass.TRANSLUCENT,
    });
  }

  frameState.commandList.push(cache.command);
}

function destroyWebGPUOrbitalCatalogResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as unknown as
    | OrbitalCatalogCache
    | undefined;
  if (!cache) {
    return;
  }
  cache.elementBuffer?.destroy();
  cache.positionBuffer?.destroy();
  cache.paramsBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.cameraUniformBuffer?.destroy();
  collection._webgpuCache = undefined;
}

export { updateWebGPUOrbitalCatalog, destroyWebGPUOrbitalCatalogResources };
export default {
  updateWebGPUOrbitalCatalog,
  destroyWebGPUOrbitalCatalogResources,
};
