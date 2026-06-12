/// <reference types="@webgpu/types" />
/**
 * WebGPU Compute-Instance Renderer — the feature-agnostic GPU-resident
 * instance system (NEW-COMPUTE-INSTANCE-SYSTEM; Phase 3 of the Large
 * Dynamic Objects roadmap, generalized in Batch 231 from the Batch-230
 * catalog renderer).
 *
 * GPU-resident rendering for `ComputeInstanceCollection`: the per-instance
 * parameter floats (layout = the user's business) upload ONCE to a
 * read-only storage buffer; every frame a compute dispatch (one invocation
 * per instance) runs the USER-SUPPLIED WGSL kernel and writes position
 * (RTE high/low) + color + pixelSize into a second storage buffer; the
 * instanced draw (`ComputeInstanceRender.wgsl`) vertex-pulls
 * `instances[instance_index]` directly from that buffer. Instance state
 * never leaves the GPU — the CPU's per-frame upload is the camera uniform
 * block plus ONE scalar (simulation time).
 *
 * Kernel composition (UserPostProcessStage-style, see that file for the
 * precedent): the compute module is composed at pipeline build as
 *
 *     <generated prologue: const FLOATS_PER_INSTANCE>
 *   + ComputeInstanceScaffold.wgsl   (bindings + entry point + bounds
 *                                     check + RTE split/write)
 *   + <user kernel defining csm_computeInstance>
 *
 * Composed modules are cached per composed-source string in a per-device
 * map (kernels are per-collection, low cardinality) — NOT in
 * `WebGPUShaderModuleCache`, whose (sourceId, defines) key can't represent
 * arbitrary user strings. The static render module still goes through the
 * sourceId cache (`ShaderSourceId.COMPUTE_INSTANCE_RENDER`).
 *
 * Bounding volume (Batch 235): positions are GPU-resident, so the engine
 * cannot derive a bounding volume — `collection.boundingSphere` is a USER
 * contract ("every position the kernel can produce fits in this sphere").
 * When supplied it threads onto the draw command (`boundingVolume` +
 * `cull: true`) for per-frustum binning/culling; when absent the command
 * keeps the historical bin-into-all-frustums behavior.
 *
 * TAA motion vectors (Batch 235): two instance-record buffers ping-pong —
 * the kernel writes `instanceBuffers[pingPongIndex]` each frame, and last
 * frame's output buffer binds as the velocity pass's `prevInstances`. The
 * partner buffer, velocity pipeline, and per-orientation bind groups all
 * allocate lazily on the first `frameState.taaEnabled` frame, so
 * TAA-off collections pay nothing. The velocity command (rg16float NDC
 * delta, `_runVelocityPass` walks `cmd.velocityCommand`) mirrors the
 * cloud/point/billboard pattern.
 *
 * Currently deferred (tracked in DEFERRED_WORK.md, NEW-COMPUTE-INSTANCE-*):
 *   - df64 kernel math (RTE low part is always 0)
 *   - WebGL2 fallback (worker/WASM kernel host)
 *   - picking
 *
 * Compute scheduling mirrors `WebGPUWeatherRenderer`: the dispatch is
 * recorded on its OWN command encoder and submitted immediately during the
 * collection's update — queue submission order guarantees it executes
 * before the scene's render submit that consumes the instance buffer.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import ComputeInstanceScaffoldWGSL from "../../Shaders/WebGPU/Compute/ComputeInstanceScaffold.js";
import ComputeInstanceRenderWGSL from "../../Shaders/WebGPU/Compute/ComputeInstanceRender.js";
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
// compiled modules (C-R7-SHADER-MODULE-DEDUP pattern). Holds the STATIC
// render module only.
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

// Per-device cache of COMPOSED user-kernel compute modules, keyed by the
// full composed source string (collision-free content key; kernels are
// per-collection so cardinality stays low).
const _composedModuleCaches = new WeakMap<
  GPUDevice,
  Map<string, GPUShaderModule>
>();

function getOrCreateComposedModule(
  device: GPUDevice,
  composedSource: string,
  label: string,
): GPUShaderModule {
  let cache = _composedModuleCaches.get(device);
  if (!cache) {
    cache = new Map();
    _composedModuleCaches.set(device, cache);
  }
  let module = cache.get(composedSource);
  if (!module) {
    module = device.createShaderModule({ label, code: composedSource });
    cache.set(composedSource, module);
  }
  return module;
}

// FNV-1a 32-bit — used only for human-readable module labels and pipeline
// cache names (the module cache itself keys on the full source string).
function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compose the final compute module source. The scaffold owns bindings,
 * entry point, bounds check, and the RTE high/low split + write; the
 * prologue injects `FLOATS_PER_INSTANCE`; the user kernel supplies
 * `csm_computeInstance`. WGSL module-scope declarations are
 * order-independent, so concatenation order is purely cosmetic.
 */
function composeKernelSource(
  kernel: string,
  floatsPerInstance: number,
): string {
  return (
    `// ── engine prologue (generated per collection) ──\n` +
    `const FLOATS_PER_INSTANCE: u32 = ${floatsPerInstance >>> 0}u;\n\n` +
    `${ComputeInstanceScaffoldWGSL}\n` +
    `// ── user kernel ──\n` +
    `${kernel}\n`
  );
}

// Per-instance float lanes are raw f32s: stride = floatsPerInstance * 4.
// InstanceRecord (scaffold/render output): vec3+pad, vec3+pad, vec4,
// f32+12 pad = 64 bytes. MUST match `CsmInstanceRecord` /
// `InstanceRecord` in the two WGSL files.
const INSTANCE_RECORD_BYTES = 64;
// CameraUniforms: mat4 + vec2 + pads + 2×(vec3+pad) + mat4 = 176 bytes.
const CAMERA_UNIFORM_FLOATS = 44;
const COMPUTE_WORKGROUP_SIZE = 64;

interface ComputeInstanceCache {
  initialized: boolean;
  // Compute side
  computePipeline: GPUComputePipeline | null;
  computeBindGroupLayout: GPUBindGroupLayout | null;
  // One bind group per ping-pong orientation (index = which instance
  // buffer the kernel writes that frame). Slot 1 stays null until the
  // TAA partner buffer allocates.
  computeBindGroups: Array<GPUBindGroup | null>;
  frameParamsBuffer: GPUBuffer | null;
  frameParamsData: Float32Array;
  // Instance buffers — [0] always; [1] is the TAA velocity ping-pong
  // partner, allocated lazily on the first frameState.taaEnabled frame.
  paramsBuffer: GPUBuffer | null;
  instanceBuffers: Array<GPUBuffer | null>;
  // Which instanceBuffers slot the kernel writes (and the color draw
  // reads) THIS frame; the other slot holds last frame's output and
  // feeds the velocity pass's prevInstances binding.
  pingPongIndex: number;
  instanceCount: number;
  // Render side
  quadVertexBuffer: GPUBuffer | null;
  cameraUniformBuffer: GPUBuffer | null;
  cameraUniformData: Float32Array;
  renderShaderModule: GPUShaderModule | null;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroups: Array<GPUBindGroup | null>;
  renderPipeline: GPURenderPipeline | null;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  renderPipelineRequestPending: boolean;
  command: WebGPUDrawCommand | null;
  // Velocity (TAA) side — all lazy; null until the first TAA-on frame.
  velocityBindGroupLayout: GPUBindGroupLayout | null;
  velocityBindGroups: Array<GPUBindGroup | null>;
  velocityPipeline: GPURenderPipeline | null;
  velocityPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  velocityPipelineRequestPending: boolean;
  _pipelineFormatGeneration?: number;
}

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMVRTE = new Matrix4();

// Shared by the color and velocity pipeline descriptors — both rasterize
// the same [-1,1] quad VB at @location(0).
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
  // [-1,1] quad, 2 triangles, 6 vertices — same shape as the cloud quad.
  const v = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const buf = device.createBuffer({
    label: "ComputeInstance quad VB",
    size: v.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, v);
  return buf;
}

/**
 * Upload the collection's flat per-instance parameter lanes. Runs only
 * when the collection is dirty (add/edit/removeAll) — NOT per frame.
 * Recreates the GPU buffers (and invalidates dependent bind groups +
 * command) when the instance count changes.
 */
function uploadParams(
  device: GPUDevice,
  cache: ComputeInstanceCache,
  paramsData: Float32Array,
  count: number,
  floatsPerInstance: number,
): void {
  if (count !== cache.instanceCount) {
    cache.paramsBuffer?.destroy();
    cache.instanceBuffers[0]?.destroy();
    cache.instanceBuffers[1]?.destroy();
    cache.paramsBuffer = device.createBuffer({
      label: "ComputeInstance params",
      size: Math.max(count * floatsPerInstance, 4) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    cache.instanceBuffers[0] = device.createBuffer({
      label: "ComputeInstance records A",
      size: Math.max(count * INSTANCE_RECORD_BYTES, INSTANCE_RECORD_BYTES),
      usage: GPUBufferUsage.STORAGE,
    });
    // The TAA ping-pong partner re-allocates lazily at the new size on
    // the next taaEnabled frame; restart on the primary buffer.
    cache.instanceBuffers[1] = null;
    cache.pingPongIndex = 0;
    // Buffer identity changed — bind groups and the draw command must be
    // rebuilt against the new resources.
    cache.computeBindGroups = [null, null];
    cache.renderBindGroups = [null, null];
    cache.velocityBindGroups = [null, null];
    cache.command = null;
    cache.instanceCount = count;
  }

  if (count > 0) {
    device.queue.writeBuffer(
      cache.paramsBuffer!,
      0,
      paramsData,
      0,
      count * floatsPerInstance,
    );
  }
}

/**
 * Resolve the render pipeline through the central pipeline cache
 * (C-R7-RENDERER-MIGRATION pattern — async on first frame, sync after).
 */
function tryResolveRenderPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: ComputeInstanceCache,
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

/**
 * Lazily build + resolve the TAA velocity pipeline (Batch 235). First
 * call on a TAA-on frame creates the three-entry velocity BGL (camera +
 * current + prev instance records) and the descriptor; resolution then
 * follows the same central-cache sync/async flow as the color pipeline.
 * Never reached while TAA is off — the whole velocity side stays
 * unallocated for TAA-off collections.
 */
function tryResolveVelocityPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: ComputeInstanceCache,
): boolean {
  if (cache.velocityPipeline) {
    return true;
  }
  if (!cache.velocityPipelineDescriptor) {
    const module = cache.renderShaderModule;
    if (!module) {
      return false;
    }
    cache.velocityBindGroupLayout = makeBindGroupLayout(
      device,
      "ComputeInstance velocity BGL",
      [
        uniformBuffer(0, Stage.VERTEX), // camera
        storageBuffer(1, Stage.VERTEX, { readOnly: true }), // current records
        storageBuffer(2, Stage.VERTEX, { readOnly: true }), // prev records
      ],
    );
    cache.velocityPipelineDescriptor = {
      name: "ComputeInstance velocity pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [cache.velocityBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: "vertexVelocityMain",
        buffers: QUAD_VERTEX_LAYOUT,
      },
      fragment: {
        module,
        entryPoint: "fragmentVelocityMain",
        targets: [{ format: "rg16float" as GPUTextureFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      // The velocity pass reuses the scene depth attachment read-only.
      // No multisample state: the rg16float velocity target is always
      // single-sample and TAA forces MSAA=1 (Batch 234 coupling).
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    };
  }
  const desc = cache.velocityPipelineDescriptor;

  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(desc);
    if (sync) {
      cache.velocityPipeline = sync;
      cache.velocityPipelineRequestPending = false;
      return true;
    }
    if (!cache.velocityPipelineRequestPending) {
      cache.velocityPipelineRequestPending = true;
      pipelineCache
        .getPipeline(desc)
        .then((p) => {
          cache.velocityPipeline = p;
          cache.velocityPipelineRequestPending = false;
        })
        .catch(() => {
          cache.velocityPipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache.
  cache.velocityPipeline = device.createRenderPipeline({
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
  });
  return true;
}

function initializeComputeInstanceResources(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  cache: ComputeInstanceCache,
  sceneFormat: GPUTextureFormat,
  kernel: string,
  floatsPerInstance: number,
): void {
  const composedSource = composeKernelSource(kernel, floatsPerInstance);
  const kernelTag = `fpi=${floatsPerInstance}/k=${fnv1a32(composedSource)}-${composedSource.length}`;
  const computeModule = getOrCreateComposedModule(
    device,
    composedSource,
    `ComputeInstance kernel [${kernelTag}]`,
  );
  const renderModule = getRenderShaderModuleCache(device).getOrCreate(
    ShaderSourceId.COMPUTE_INSTANCE_RENDER,
    ComputeInstanceRenderWGSL,
    0,
    "ComputeInstance render",
  );
  // Stashed so the velocity pipeline (lazy — first TAA-on frame) can
  // reference the same module's velocity entry points.
  cache.renderShaderModule = renderModule;

  // ── Compute pipeline ──
  cache.computeBindGroupLayout = makeBindGroupLayout(
    device,
    "ComputeInstance compute BGL",
    [
      storageBuffer(0, Stage.COMPUTE, { readOnly: true }), // params
      storageBuffer(1, Stage.COMPUTE), // instance records (read_write)
      uniformBuffer(2, Stage.COMPUTE), // frame params (time + count)
    ],
  );
  const computeLayout = device.createPipelineLayout({
    bindGroupLayouts: [cache.computeBindGroupLayout],
  });
  // The kernel tag is keyed into the name so the central cache never
  // aliases pipelines built from different user kernels.
  const computePipelineCache = context.webgpuComputePipelineCache ?? null;
  if (computePipelineCache) {
    cache.computePipeline = computePipelineCache.getOrCreateSync({
      name: `ComputeInstance dispatch [${kernelTag}]`,
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "computeInstanceMain" },
    });
  } else {
    cache.computePipeline = device.createComputePipeline({
      label: `ComputeInstance dispatch [${kernelTag}]`,
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "computeInstanceMain" },
    });
  }

  cache.frameParamsBuffer = device.createBuffer({
    label: "ComputeInstance frame params",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // ── Render pipeline (descriptor — materialized via the central cache) ──
  cache.renderBindGroupLayout = makeBindGroupLayout(
    device,
    "ComputeInstance render BGL",
    [
      uniformBuffer(0, Stage.VERTEX), // camera
      storageBuffer(1, Stage.VERTEX, { readOnly: true }), // instance records
    ],
  );

  // NEW-CLOUD-SCENEFB-PIPELINE-MISMATCH rule (Batch 228) — scene-FB
  // pipelines MUST bake the MSAA sample count or attachment-state
  // validation invalidates the whole pass encoder. `ms=` is keyed into the
  // name so the central cache distinguishes sample-count variants.
  const sampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  cache.renderPipelineDescriptor = {
    name: `ComputeInstance pipeline [${sceneFormat}/ms=${sampleCount}]`,
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
    label: "ComputeInstance camera UB",
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
}

/**
 * Per-frame update: upload params when dirty, write the time uniform,
 * dispatch the user kernel, and push the instanced draw command.
 *
 * Simulation time arrives via `collection._simulationTimeSeconds`, which
 * `ComputeInstanceCollection.update()` derives from `frameState.time`
 * relative to the collection's epoch BEFORE routing to this renderer
 * (scene-logic-extractor pattern — the time source is backend-agnostic).
 */
function updateWebGPUComputeInstanceCollection(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  if (!device) {
    return;
  }

  const count = (collection.length as number | undefined) ?? 0;
  const kernel = collection._kernel as string | undefined;
  const floatsPerInstance =
    (collection._floatsPerInstance as number | undefined) ?? 0;
  const paramsData = collection._paramsData as Float32Array | undefined;
  if (
    collection.show === false ||
    count === 0 ||
    !kernel ||
    floatsPerInstance < 1 ||
    !paramsData
  ) {
    return;
  }

  if (!collection._webgpuCache) {
    collection._webgpuCache = {
      initialized: false,
      computePipeline: null,
      computeBindGroupLayout: null,
      computeBindGroups: [null, null],
      frameParamsBuffer: null,
      frameParamsData: new Float32Array(4),
      paramsBuffer: null,
      instanceBuffers: [null, null],
      pingPongIndex: 0,
      instanceCount: -1,
      quadVertexBuffer: null,
      cameraUniformBuffer: null,
      cameraUniformData: new Float32Array(CAMERA_UNIFORM_FLOATS),
      renderShaderModule: null,
      renderBindGroupLayout: null,
      renderBindGroups: [null, null],
      renderPipeline: null,
      renderPipelineDescriptor: null,
      renderPipelineRequestPending: false,
      command: null,
      velocityBindGroupLayout: null,
      velocityBindGroups: [null, null],
      velocityPipeline: null,
      velocityPipelineDescriptor: null,
      velocityPipelineRequestPending: false,
    } as unknown as CesiumOpaqueObject;
  }
  const cache = collection._webgpuCache as unknown as ComputeInstanceCache;

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
    cache.renderBindGroups = [null, null];
    // Velocity side rebuilds lazily against the re-created BGLs (the
    // rg16float target itself is format-independent, but keep the whole
    // family consistent with the color pipeline reset).
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    cache.velocityBindGroupLayout = null;
    cache.velocityBindGroups = [null, null];
    cache.command = null;
    cache._pipelineFormatGeneration = sceneGen;
  }

  if (!cache.initialized) {
    initializeComputeInstanceResources(
      context,
      device,
      cache,
      sceneFormat,
      kernel,
      floatsPerInstance,
    );
    cache._pipelineFormatGeneration = sceneGen;
  }

  // Params upload — only when the collection reports dirty (or the count
  // drifted, which covers external mutation of the backing array).
  if (collection._catalogDirty === true || cache.instanceCount !== count) {
    uploadParams(device, cache, paramsData, count, floatsPerInstance);
  }
  // Phase-0 dirty-consume discipline: clear the collection's dirty state
  // every frame on the WebGPU path so settled collections never re-upload.
  if (typeof collection._consumeDirtyState === "function") {
    collection._consumeDirtyState();
  }

  if (cache.instanceCount === 0) {
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

  // ── TAA prev-position ping-pong (Batch 235) ──
  // The kernel writes instanceBuffers[pingPongIndex] each frame; when the
  // partner buffer exists, last frame's output buffer feeds the velocity
  // pass's prevInstances binding. The partner allocates lazily on the
  // first TAA-on frame, and the flip continues even if TAA later turns
  // off (alternating pre-built bind groups costs nothing and keeps prev
  // warm for an instant TAA re-enable). Collections that never see TAA
  // never allocate the partner — the off path stays zero-cost. The flip
  // sits AFTER the pipeline-resolve early-out so "prev" is always
  // exactly one dispatched frame old.
  const taaEnabledThisFrame = frameState.taaEnabled === true;
  let velocitySeedFrame = false;
  if (taaEnabledThisFrame && !cache.instanceBuffers[1]) {
    cache.instanceBuffers[1] = device.createBuffer({
      label: "ComputeInstance records B (velocity ping-pong)",
      size: cache.instanceBuffers[0]!.size,
      usage: GPUBufferUsage.STORAGE,
    });
    // This frame still writes+reads the primary buffer; the fresh
    // partner holds no prior-frame positions yet, so velocity emission
    // starts next frame (no zero-velocity seed copy needed).
    velocitySeedFrame = true;
    cache.pingPongIndex = 0;
  } else if (cache.instanceBuffers[1]) {
    cache.pingPongIndex ^= 1;
  }
  const cur = cache.pingPongIndex;
  const currentBuffer = cache.instanceBuffers[cur]!;
  const prevBuffer = cache.instanceBuffers[1 - cur];

  // (Re)build this orientation's bind groups when buffers changed.
  if (!cache.computeBindGroups[cur]) {
    cache.computeBindGroups[cur] = device.createBindGroup({
      label: `ComputeInstance compute BG [${cur}]`,
      layout: cache.computeBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.paramsBuffer! } },
        { binding: 1, resource: { buffer: currentBuffer } },
        { binding: 2, resource: { buffer: cache.frameParamsBuffer! } },
      ],
    });
  }
  if (!cache.renderBindGroups[cur]) {
    cache.renderBindGroups[cur] = device.createBindGroup({
      label: `ComputeInstance render BG [${cur}]`,
      layout: cache.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: currentBuffer } },
      ],
    });
  }

  // ── Per-frame CPU upload #1: ONE time scalar (+ instance count) ──
  const simTime = (collection._simulationTimeSeconds as number) ?? 0;
  const frameParams = cache.frameParamsData;
  frameParams[0] = simTime;
  new Uint32Array(frameParams.buffer)[1] = cache.instanceCount;
  device.queue.writeBuffer(cache.frameParamsBuffer!, 0, frameParams);

  // Dispatch the user kernel on its own encoder (weather pattern) —
  // submitted now, so queue order places it before the scene's render
  // submit.
  const workgroups = Math.ceil(cache.instanceCount / COMPUTE_WORKGROUP_SIZE);
  const encoder = device.createCommandEncoder({
    label: "ComputeInstance dispatch",
  });
  const pass = encoder.beginComputePass({
    label: "ComputeInstance dispatch pass",
  });
  pass.setPipeline(cache.computePipeline!);
  pass.setBindGroup(0, cache.computeBindGroups[cur]);
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
      bindGroups: [cache.renderBindGroups[cur]!],
      vertexBuffers: [cache.quadVertexBuffer!],
      vertexCount: 6,
      instanceCount: cache.instanceCount,
      pass: Pass.TRANSLUCENT,
    });
  }
  const command = cache.command;
  // Ping-pong: point the cached command at this frame's CURRENT buffer.
  command.bindGroups[0] = cache.renderBindGroups[cur]!;
  command.bindGroup = command.bindGroups[0];

  // Bounding volume (Batch 235): positions are GPU-resident, so the BV is
  // a user contract — collection.boundingSphere bounds every position the
  // kernel can produce. Refreshed per frame so post-construction
  // assignment (including back to undefined) takes effect immediately.
  // Without it the command keeps the historical never-culled,
  // bin-into-all-frustums behavior.
  const boundingSphere = collection.boundingSphere as
    | CesiumBoundingSphere
    | undefined;
  command.boundingVolume = boundingSphere;
  command.cull = boundingSphere !== undefined;

  // TAA velocity command — only when the canonical flag is on AND the
  // partner buffer already holds last frame's kernel output. On the
  // partner's allocation frame `prev` is still unwritten, so emission
  // starts one frame later. When TAA is off the slot clears so
  // `_runVelocityPass` finds nothing.
  attachVelocityCommand(
    device,
    ctxAny.webgpuPipelineCache ?? null,
    cache,
    taaEnabledThisFrame && !velocitySeedFrame,
    cur,
    prevBuffer,
  );

  frameState.commandList.push(command);
}

/**
 * Attach (or clear) `cache.command.velocityCommand` for this frame's
 * ping-pong orientation. Mirrors `attachCloudVelocityCommand` — the TAA
 * velocity pass (`WebGPUSceneRenderer._runVelocityPass`) walks the binned
 * frustum commands for `velocityCommand` and dispatches them into the
 * rg16float velocity texture, so a frustum-culled color command's
 * velocity command is naturally skipped with it.
 */
function attachVelocityCommand(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: ComputeInstanceCache,
  emit: boolean,
  cur: number,
  prevBuffer: GPUBuffer | null,
): void {
  const command = cache.command as WebGPUDrawCommand & {
    velocityCommand?: WebGPUDrawCommand;
  };
  if (
    !emit ||
    !prevBuffer ||
    !tryResolveVelocityPipeline(device, pipelineCache, cache)
  ) {
    command.velocityCommand = undefined;
    return;
  }

  if (!cache.velocityBindGroups[cur]) {
    cache.velocityBindGroups[cur] = device.createBindGroup({
      label: `ComputeInstance velocity BG [${cur}]`,
      layout: cache.velocityBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: cache.instanceBuffers[cur]! } },
        { binding: 2, resource: { buffer: prevBuffer } },
      ],
    });
  }

  // Rebuilt per frame (cloud precedent) — cheap, and guarantees the
  // attached command always matches this frame's orientation.
  command.velocityCommand = new WebGPUDrawCommand({
    pipeline: cache.velocityPipeline!,
    bindGroups: [cache.velocityBindGroups[cur]!],
    vertexBuffers: [cache.quadVertexBuffer!],
    vertexCount: 6,
    instanceCount: cache.instanceCount,
    pass: Pass.TRANSLUCENT,
  });
}

function destroyWebGPUComputeInstanceResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  const cache = collection._webgpuCache as unknown as
    | ComputeInstanceCache
    | undefined;
  if (!cache) {
    return;
  }
  cache.paramsBuffer?.destroy();
  cache.instanceBuffers[0]?.destroy();
  cache.instanceBuffers[1]?.destroy();
  cache.frameParamsBuffer?.destroy();
  cache.quadVertexBuffer?.destroy();
  cache.cameraUniformBuffer?.destroy();
  collection._webgpuCache = undefined;
}

export {
  updateWebGPUComputeInstanceCollection,
  destroyWebGPUComputeInstanceResources,
};
export default {
  updateWebGPUComputeInstanceCollection,
  destroyWebGPUComputeInstanceResources,
};
