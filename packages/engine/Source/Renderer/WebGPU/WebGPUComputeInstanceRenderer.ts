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
 * frame's output buffer binds as the velocity pass's `prevInstances`
 * (@binding(3) — the pick variant claims @binding(2) for pickColors). The
 * partner buffer, velocity pipeline, and per-orientation bind groups all
 * allocate lazily on the first `frameState.taaEnabled` frame, so
 * TAA-off collections pay nothing. The velocity command (rg16float NDC
 * delta, `_runVelocityPass` walks `cmd.velocityCommand`) mirrors the
 * cloud/point/billboard pattern.
 *
 * GPU picking (Batch 279, NEW-ORBITAL-GPU-PICKING): positions are GPU-
 * resident so there is no CPU position to hit-test — picking RASTERIZES the
 * same instanced quads with a per-instance pick color (one CPU-allocated
 * `context.createPickId` per instance) into the single-attachment pick FBO,
 * and the readback decodes the instance under the cursor. The pick id,
 * pick-color storage buffer, pick BGL/pipeline (slot-0-only blend-stripped,
 * the pick-FBO invariants), and pick command all allocate lazily on the
 * first `frameState.passes.pick` frame, so non-picked frames pay nothing.
 * `scene.pick` returns the engine's domain-agnostic
 * `{ collection, instanceIndex, primitive }` record (the demo maps
 * instanceIndex → its domain object). `collection.allowPicking` (default
 * true) gates the whole pick side.
 *
 * Currently deferred (tracked in DEFERRED_WORK.md, NEW-COMPUTE-INSTANCE-*):
 *   - WebGL2 fallback (worker/WASM kernel host)
 *   - pickPosition for a compute-instance (per-instance GPU position
 *     reconstruction; scene.pick returns the instance, scene.pickPosition
 *     does not yet reconstruct its world position) — NEW-ORBITAL-GPU-PICKING
 *   - HDR-mode pick (LDR pick pipelines for a float scene format — same
 *     caveat as billboard/point pick)
 *
 * Compute scheduling mirrors `WebGPUWeatherRenderer`: the dispatch is
 * recorded on its OWN command encoder and submitted immediately during the
 * collection's update — queue submission order guarantees it executes
 * before the scene's render submit that consumes the instance buffer.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import Color from "../../Core/Color.js";
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
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
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

/**
 * Free every pick id this collection allocated (releases the context's
 * `_pickObjects` / `_pickKinds` entries). Called on count change and on
 * teardown so the pick maps never accumulate orphan instance ids.
 */
function destroyPickIds(cache: {
  pickIds: Array<{ destroy(): void } | null>;
}): void {
  for (const id of cache.pickIds) {
    id?.destroy();
  }
  cache.pickIds.length = 0;
}

/**
 * Drop the pick PIPELINE (descriptor + BGL + bind group + command) on a
 * log-depth flip or scene-format-generation bump so it rebuilds against the
 * recompiled render module / new pick-FBO format. The pick IDS and the pick
 * COLOR buffer are NOT cleared here — they depend only on the instance count,
 * not the pipeline shape, so they survive a format flip (uploadParams clears
 * them on a count change).
 */
function resetPickPipeline(cache: ComputeInstanceCache): void {
  cache.pickPipeline = null;
  cache.pickPipelineDescriptor = null;
  cache.pickPipelineRequestPending = false;
  cache.pickBindGroupLayout = null;
  cache.pickBindGroup = null;
  cache.pickBindGroupOrientation = -1;
  cache.pickCommand = null;
}

// Per-instance float lanes are raw f32s: stride = floatsPerInstance * 4.
// InstanceRecord (scaffold/render output): vec3+pad, vec3+pad, vec4,
// f32+12 pad = 64 bytes. MUST match `CsmInstanceRecord` /
// `InstanceRecord` in the two WGSL files.
const INSTANCE_RECORD_BYTES = 64;
// CameraUniforms: mat4 + vec2 + pads + 2×(vec3+pad) + mat4 = 176 bytes.
const CAMERA_UNIFORM_FLOATS = 44;
const COMPUTE_WORKGROUP_SIZE = 64;
// Per-instance pick color: one vec4<f32> (RGBA in [0,1]) = 16 bytes. The
// pick id rides RGB (little-endian); alpha is unused (forced to 1.0 in the
// pick FS). Matches `pickColors: array<vec4<f32>>` in ComputeInstanceRender.
const PICK_COLOR_BYTES = 16;

// pickPosition readback (NEW-COMPUTE-INSTANCE-PICKPOSITION) — the cached
// instance position is only returned for the SAME instance index it was armed
// for and within this many rendered frames of that arming. Staleness is
// counted in dispatched frames (cache.posUpdateCount), not wall time, so a
// paused / requestRenderMode scene keeps a valid cache indefinitely (positions
// can't move without a kernel dispatch). Mirrors PickDepth's
// ASYNC_DEPTH_MAX_STALE_FRAMES contract.
const POS_READBACK_MAX_STALE_FRAMES = 4;

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
  // Pick side (NEW-ORBITAL-GPU-PICKING) — all lazy; null until the first
  // frame the scene runs a pick pass (frameState.passes.pick). GPU-resident
  // instances have no CPU position to hit-test, so picking renders the same
  // instanced quads with a per-instance pick color (CPU-allocated pick id)
  // into the single-attachment pick FBO; the readback decodes the instance.
  pickIds: Array<{ key: number; destroy(): void } | null>;
  pickColorData: Float32Array | null; // 4 floats per instance (RGBA in [0,1])
  pickColorBuffer: GPUBuffer | null; // storage buffer, vertex-pulled in pick VS
  pickBindGroupLayout: GPUBindGroupLayout | null;
  pickBindGroup: GPUBindGroup | null; // one orientation — current records buffer
  pickBindGroupOrientation: number; // which ping-pong slot pickBindGroup wraps
  pickPipeline: GPURenderPipeline | null;
  pickPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  pickPipelineRequestPending: boolean;
  pickCommand: WebGPUDrawCommand | null;
  // Count the pick ids were last allocated/uploaded for — re-alloc when the
  // instance count drifts (mirrors the color path's instanceCount tracking).
  pickIdCount: number;
  // pickPosition readback (NEW-COMPUTE-INSTANCE-PICKPOSITION) — positions are
  // GPU-resident, so reconstructing a picked instance's world position means
  // reading its one record slot back from the instance buffer. Same
  // one-frame-stale sync-cache bridge as PickDepth: getInstanceWorldPosition
  // returns the cached value when the query matches the armed index and is
  // recent, else arms a copyBufferToBuffer + mapAsync readback and returns
  // undefined. All lazy; null until the first getInstanceWorldPosition call.
  posReadbackBuffer: GPUBuffer | null; // 64-byte (one record) MAP_READ staging
  posReadbackPending: boolean; // dedupe overlapping mapAsync calls
  posCacheValue: { x: number; y: number; z: number } | null; // last decode
  posCacheIndex: number; // which instance the cached value is for
  posCacheStamp: number; // frame stamp the readback was armed at
  posUpdateCount: number; // advances once per rendered frame (staleness clock)
  _pipelineFormatGeneration?: number;
  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — whether the
  // render/velocity modules + pipelines were built with LOG_DEPTH; a
  // master-switch flip forces a re-init (same pattern as the
  // scene-format generation above).
  _logDepthEnabled?: boolean;
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
      // COPY_SRC so the pickPosition readback can copyBufferToBuffer the picked
      // instance's record slot (NEW-COMPUTE-INSTANCE-PICKPOSITION).
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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

    // Pick side (NEW-ORBITAL-GPU-PICKING): the instance count drove the pick
    // id allocation + pick color buffer size, so a count change invalidates
    // them. Free the old pick ids (releases the context pickObjects entries)
    // and tear down the GPU pick color buffer + bind group; they re-allocate
    // lazily on the next pick pass via `ensurePickResources`.
    destroyPickIds(cache);
    cache.pickColorBuffer?.destroy();
    cache.pickColorBuffer = null;
    cache.pickColorData = null;
    cache.pickBindGroup = null;
    cache.pickBindGroupOrientation = -1;
    cache.pickCommand = null;
    cache.pickIdCount = -1;
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
        // Camera UB is VERTEX_FRAGMENT: the LOG_DEPTH fragment variant
        // reads camera.logDepthFactor for the frag_depth write.
        uniformBuffer(0, Stage.VERTEX_FRAGMENT), // camera
        storageBuffer(1, Stage.VERTEX, { readOnly: true }), // current records
        // prevInstances is @binding(3) in the render module — the pick
        // variant claims @binding(2) for pickColors and WGSL forbids two
        // module-scope vars sharing a (group, binding). The velocity BGL
        // mirrors the module's binding number so leaving binding(2) unused
        // here is intentional (this layout is velocity-only).
        storageBuffer(3, Stage.VERTEX, { readOnly: true }), // prev records
      ],
    );
    cache.velocityPipelineDescriptor = {
      name: `ComputeInstance velocity pipeline [ld=${cache._logDepthEnabled === true ? 1 : 0}]`,
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

/**
 * Lazily build + resolve the GPU pick pipeline (NEW-ORBITAL-GPU-PICKING).
 * First call on a pick-pass frame creates the three-entry pick BGL (camera +
 * current instance records + per-instance pick colors) and the descriptor;
 * resolution then follows the same central-cache sync/async flow as the
 * color pipeline. The pick pipeline targets the SINGLE-attachment pick FBO
 * (slot-0 only, blend stripped, multisample dropped — the pick-FBO invariant
 * enforced by `WebGPUDerivedCommand` PICK variants) and swaps to the render
 * module's `vertexPickMain`/`fragmentPickMain` entry points, which output the
 * per-instance pick color byte-exact. Never reached until the scene runs a
 * pick pass — the whole pick side stays unallocated for never-picked frames.
 */
function tryResolvePickPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: ComputeInstanceCache,
  sceneFormat: GPUTextureFormat,
): boolean {
  if (cache.pickPipeline) {
    return true;
  }
  // The pick pipeline MUST target the pick FBO's color format or WebGPU
  // drops every pick draw ("attachment state not compatible") — FORK-34. The
  // pick FBO allocates with `scenePipelineFormat` clamped to an 8-bit unorm
  // (WebGPUPickFramebuffer.pickColorFormat): HDR scene formats fall back to
  // rgba8unorm there, so HDR pick of compute-instances is a known follow-up
  // (same caveat the billboard/point pick pipelines carry).
  const pickFormat: GPUTextureFormat =
    sceneFormat === "bgra8unorm" || sceneFormat === "rgba8unorm"
      ? sceneFormat
      : "rgba8unorm";
  if (!cache.pickPipelineDescriptor) {
    const module = cache.renderShaderModule;
    if (!module) {
      return false;
    }
    cache.pickBindGroupLayout = makeBindGroupLayout(
      device,
      "ComputeInstance pick BGL",
      [
        // Camera UB is VERTEX_FRAGMENT: the LOG_DEPTH pick fragment variant
        // reads camera.logDepthFactor for the frag_depth write.
        uniformBuffer(0, Stage.VERTEX_FRAGMENT), // camera
        storageBuffer(1, Stage.VERTEX, { readOnly: true }), // instance records
        storageBuffer(2, Stage.VERTEX, { readOnly: true }), // pick colors
      ],
    );
    // Pick color must reach the single-attachment pick FBO byte-exact —
    // slot-0 only, NO blend, multisample dropped (the pick FBO is always
    // single-sample). These are exactly the PICK-variant invariants in
    // WebGPUDerivedCommand; mirrored inline here because the pick pipeline
    // needs its OWN bind group layout (the extra pick-color binding), which
    // the factory's `base.layout` passthrough can't express.
    cache.pickPipelineDescriptor = {
      name: `ComputeInstance pick pipeline [${pickFormat}/ld=${cache._logDepthEnabled === true ? 1 : 0}]`,
      layout: device.createPipelineLayout({
        bindGroupLayouts: [cache.pickBindGroupLayout],
      }),
      vertex: {
        module,
        entryPoint: "vertexPickMain",
        buffers: QUAD_VERTEX_LAYOUT,
      },
      fragment: {
        module,
        entryPoint: "fragmentPickMain",
        targets: [{ format: pickFormat }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      multisample: undefined,
    };
  }
  const desc = cache.pickPipelineDescriptor;

  if (pipelineCache) {
    const sync = pipelineCache.getPipelineSync(desc);
    if (sync) {
      cache.pickPipeline = sync;
      cache.pickPipelineRequestPending = false;
      return true;
    }
    if (!cache.pickPipelineRequestPending) {
      cache.pickPipelineRequestPending = true;
      pipelineCache
        .getPipeline(desc)
        .then((p) => {
          cache.pickPipeline = p;
          cache.pickPipelineRequestPending = false;
        })
        .catch(() => {
          cache.pickPipelineRequestPending = false;
        });
    }
    return false;
  }

  // Fallback: no central cache.
  cache.pickPipeline = device.createRenderPipeline({
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
  logDepthActive: boolean,
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
    logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
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
      // Camera UB is VERTEX_FRAGMENT: the LOG_DEPTH fragment variant reads
      // camera.logDepthFactor for the frag_depth write.
      uniformBuffer(0, Stage.VERTEX_FRAGMENT), // camera
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
    name: `ComputeInstance pipeline [${sceneFormat}/ms=${sampleCount}/ld=${logDepthActive ? 1 : 0}]`,
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
      pickIds: [],
      pickColorData: null,
      pickColorBuffer: null,
      pickBindGroupLayout: null,
      pickBindGroup: null,
      pickBindGroupOrientation: -1,
      pickPipeline: null,
      pickPipelineDescriptor: null,
      pickPipelineRequestPending: false,
      pickCommand: null,
      pickIdCount: -1,
      posReadbackBuffer: null,
      posReadbackPending: false,
      posCacheValue: null,
      posCacheIndex: -1,
      posCacheStamp: -1,
      posUpdateCount: 0,
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
  // Renderer-wide log depth — force a full re-init when the master switch
  // flips so the render/velocity modules recompile with/without LOG_DEPTH.
  const logDepthActive = isWebGPULogDepthActive(
    context as unknown as { _logDepthWriteEnabled?: boolean },
    frameState as unknown as { useLogDepth?: boolean },
  );
  if (cache.initialized && cache._logDepthEnabled !== logDepthActive) {
    cache.initialized = false;
    cache.renderPipeline = null;
    cache.renderPipelineDescriptor = null;
    cache.renderPipelineRequestPending = false;
    cache.renderBindGroups = [null, null];
    cache.velocityPipeline = null;
    cache.velocityPipelineDescriptor = null;
    cache.velocityPipelineRequestPending = false;
    cache.velocityBindGroupLayout = null;
    cache.velocityBindGroups = [null, null];
    cache.command = null;
    // Pick side rebuilds lazily — the pick pipeline swaps the recompiled
    // render module's pick entry points, so it must recompile on a log-depth
    // flip too (the pick FS writes frag_depth only in the LOG_DEPTH variant).
    resetPickPipeline(cache);
  }

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
    // Pick pipeline targets the pick FBO format (clamped from sceneFormat),
    // so a scene-format-generation bump invalidates it the same way.
    resetPickPipeline(cache);
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
      logDepthActive,
    );
    cache._pipelineFormatGeneration = sceneGen;
    cache._logDepthEnabled = logDepthActive;
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
      // COPY_SRC so a TAA-on collection's pickPosition readback can read
      // whichever ping-pong buffer is live (NEW-COMPUTE-INSTANCE-PICKPOSITION).
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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

  // Advance the pickPosition readback staleness clock — the kernel just wrote
  // fresh positions into instanceBuffers[cur], so any pickPosition readback
  // armed against an older frame is now one render staler
  // (NEW-COMPUTE-INSTANCE-PICKPOSITION). Counted in RENDERED frames (not wall
  // time) so a paused/requestRenderMode scene keeps a cached value valid —
  // positions can't change without a dispatch.
  cache.posUpdateCount++;

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
  // Renderer-wide log depth — (near, far) at the former _padA lanes +
  // factor at the former _pad0 lane. Same encode frustum every producer
  // packs (uniformState.currentFrustum). Unconditional; only the
  // LOG_DEPTH module variant reads them.
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

  // ── GPU pick command (NEW-ORBITAL-GPU-PICKING) ──
  // Only on a pick-pass frame and when the collection allows picking. The
  // whole pick side (ids, pick-color buffer, pipeline, bind group, command)
  // stays unallocated until the first pick pass, so non-picked frames pay
  // nothing. The pick command rasterizes the SAME instanced quads pointed at
  // THIS frame's current instance buffer, so the pick region matches the
  // rendered region exactly.
  if (frameState.passes?.pick === true && collection.allowPicking !== false) {
    pushPickCommand(
      context,
      device,
      ctxAny.webgpuPipelineCache ?? null,
      collection,
      cache,
      sceneFormat,
      currentBuffer,
      cur,
      command.boundingVolume,
      command.cull === true,
      frameState,
    );
  }
}

/**
 * Build (lazily) and push the GPU pick command for this frame's ping-pong
 * orientation (NEW-ORBITAL-GPU-PICKING). Allocates one pick id per instance
 * via `context.createPickId({ collection, instanceIndex, primitive }, ...)`
 * and uploads the packed pick colors to a storage buffer the pick VS
 * vertex-pulls. The pick command is flagged `pickOnly` so the pick pass
 * (`WebGPUSceneRendererPickPass`) dispatches it into the single-attachment
 * pick FBO; the readback decodes the pick color back to the picked instance.
 */
function pushPickCommand(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  collection: CesiumObjectWithWebGPUCache,
  cache: ComputeInstanceCache,
  sceneFormat: GPUTextureFormat,
  currentBuffer: GPUBuffer,
  cur: number,
  boundingVolume: CesiumBoundingSphere | undefined,
  cull: boolean,
  frameState: CesiumFrameState,
): void {
  const count = cache.instanceCount;
  if (count <= 0) {
    return;
  }

  if (!tryResolvePickPipeline(device, pipelineCache, cache, sceneFormat)) {
    return;
  }

  // (Re)allocate the per-instance pick ids + pick-color buffer when the
  // count drifted (uploadParams already freed the stale ids on a count
  // change). One id per instance index; the pickable object is the engine's
  // domain-agnostic { collection, instanceIndex, primitive } record — the
  // demo maps instanceIndex → satellite.
  if (cache.pickIdCount !== count || !cache.pickColorBuffer) {
    destroyPickIds(cache);
    cache.pickColorData = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const pickId = context.createPickId(
        {
          collection: collection as unknown as object,
          instanceIndex: i,
          primitive: collection as unknown as object,
        } as unknown as Parameters<CesiumGraphicsContext["createPickId"]>[0],
        "compute-instance",
      );
      cache.pickIds.push(pickId);
      // PickId.color is Color.fromRgba(key) — the integer key packed
      // little-endian across ALL FOUR channels (red=key&0xff, …,
      // alpha=(key>>24)&0xff). Store the full RGBA (including alpha, which is
      // 0 for keys < 2^24); the pick FS writes it byte-exact and the readback
      // reconstructs the key from all four bytes. Forcing alpha to 1.0 would
      // corrupt the decoded key (see the fragmentPickMain comment).
      const c = pickId.color;
      cache.pickColorData[i * 4] = c.red;
      cache.pickColorData[i * 4 + 1] = c.green;
      cache.pickColorData[i * 4 + 2] = c.blue;
      cache.pickColorData[i * 4 + 3] = c.alpha;
    }
    cache.pickColorBuffer?.destroy();
    cache.pickColorBuffer = device.createBuffer({
      label: "ComputeInstance pick colors",
      size: Math.max(count * PICK_COLOR_BYTES, PICK_COLOR_BYTES),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(cache.pickColorBuffer, 0, cache.pickColorData);
    cache.pickIdCount = count;
    // Buffer identity changed — the bind group must rebind.
    cache.pickBindGroup = null;
    cache.pickBindGroupOrientation = -1;
  }

  // (Re)build the pick bind group for THIS frame's ping-pong orientation —
  // the instance-records binding tracks `currentBuffer`, which flips each
  // TAA frame, so cache the orientation it was built for and rebind on flip.
  if (!cache.pickBindGroup || cache.pickBindGroupOrientation !== cur) {
    cache.pickBindGroup = device.createBindGroup({
      label: `ComputeInstance pick BG [${cur}]`,
      layout: cache.pickBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: currentBuffer } },
        { binding: 2, resource: { buffer: cache.pickColorBuffer! } },
      ],
    });
    cache.pickBindGroupOrientation = cur;
  }

  if (!cache.pickCommand) {
    cache.pickCommand = new WebGPUDrawCommand({
      pipeline: cache.pickPipeline!,
      bindGroups: [cache.pickBindGroup!],
      vertexBuffers: [cache.quadVertexBuffer!],
      vertexCount: 6,
      instanceCount: count,
      pass: Pass.TRANSLUCENT,
      // FORK-34 (Batch 207) — dedicated pick command: its pipeline already
      // targets the single pick attachment, so the pick pass dispatches it
      // instead of skipping it as a no-pick-variant base command.
      pickOnly: true,
    });
  }
  const pickCommand = cache.pickCommand;
  pickCommand.pipeline = cache.pickPipeline!;
  pickCommand.bindGroups[0] = cache.pickBindGroup!;
  pickCommand.bindGroup = pickCommand.bindGroups[0];
  pickCommand.instanceCount = count;
  // Frustum-cull / bin the pick command exactly like the color command so a
  // culled collection contributes no pick coverage either.
  pickCommand.boundingVolume = boundingVolume;
  pickCommand.cull = cull;

  frameState.commandList.push(pickCommand);
}

/**
 * Reconstruct a picked instance's WORLD position (absolute ECEF meters) on
 * WebGPU (NEW-COMPUTE-INSTANCE-PICKPOSITION). Positions are GPU-resident — the
 * kernel writes `positionHigh` + `positionLow` (the RTE split of the absolute
 * position) into the instance record buffer each frame and they never come
 * back to the CPU — so `scene.pickPosition` over a compute-instance has no CPU
 * value to return. This reads the picked instance's ONE 64-byte record slot
 * back via `copyBufferToBuffer` + `mapAsync` and sums high+low to recover the
 * absolute position.
 *
 * The readback is asynchronous (GPU buffer mapping can't resolve within the
 * calling frame), so this uses the SAME one-frame-stale sync-cache bridge as
 * `PickDepth.getDepth`: the FIRST query for an index returns `undefined` (the
 * caller — `Picking.pickPositionWorldCoordinates` — then falls back to the
 * depth path, the pre-feature SAFE state) and ARMS the readback; subsequent
 * queries for the SAME index converge once the map resolves (1-2 frames).
 * The cached value is only trusted for the index it was armed for and within
 * `POS_READBACK_MAX_STALE_FRAMES` dispatched frames.
 *
 * @returns the world position, or `undefined` while the readback is cold.
 * @private
 */
function getWebGPUInstanceWorldPosition(
  collection: CesiumObjectWithWebGPUCache,
  index: number,
  result: Cartesian3 | undefined,
  context: CesiumGraphicsContext,
): Cartesian3 | undefined {
  const cache = collection._webgpuCache as unknown as
    | ComputeInstanceCache
    | undefined;
  if (!cache) {
    return undefined;
  }
  const count = cache.instanceCount;
  if (!(index >= 0) || index >= count) {
    return undefined;
  }
  const device = (context as unknown as { _device?: GPUDevice })._device;
  // The buffer the kernel wrote THIS frame (the color/pick draws read the same
  // slot) — read back from the live orientation, not the velocity partner.
  const sourceBuffer = cache.instanceBuffers[cache.pingPongIndex];
  if (!device || !sourceBuffer) {
    return undefined;
  }

  // Arm/refresh the background readback for this index (dedup + errors handled
  // inside).
  void _readInstancePositionAsync(device, cache, sourceBuffer, index);

  const cached = cache.posCacheValue;
  if (
    !cached ||
    cache.posCacheIndex !== index ||
    cache.posUpdateCount - cache.posCacheStamp > POS_READBACK_MAX_STALE_FRAMES
  ) {
    return undefined;
  }
  return Cartesian3.clone(cached as unknown as Cartesian3, result);
}

/**
 * Background half of `getWebGPUInstanceWorldPosition`: copy instance `index`'s
 * 64-byte record to a MAP_READ staging buffer, map it, and decode
 * `positionHigh + positionLow` into `cache.posCacheValue`. The CsmInstanceRecord
 * layout (std430) is positionHigh @0 (vec3), positionLow @16 (vec3), so the
 * absolute world position is the component-wise sum.
 * @private
 */
async function _readInstancePositionAsync(
  device: GPUDevice,
  cache: ComputeInstanceCache,
  sourceBuffer: GPUBuffer,
  index: number,
): Promise<void> {
  if (cache.posReadbackPending) {
    return;
  }
  const requestStamp = cache.posUpdateCount;
  cache.posReadbackPending = true;
  try {
    if (!cache.posReadbackBuffer) {
      cache.posReadbackBuffer = device.createBuffer({
        label: "ComputeInstance pickPosition readback",
        size: INSTANCE_RECORD_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }
    const staging = cache.posReadbackBuffer;
    const encoder = device.createCommandEncoder({
      label: "ComputeInstance pickPosition readback",
    });
    encoder.copyBufferToBuffer(
      sourceBuffer,
      index * INSTANCE_RECORD_BYTES,
      staging,
      0,
      INSTANCE_RECORD_BYTES,
    );
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ, 0, INSTANCE_RECORD_BYTES);
    const f = new Float32Array(
      staging.getMappedRange(0, INSTANCE_RECORD_BYTES),
    );
    // positionHigh = f[0..2], positionLow = f[4..6] (vec3 padded to 16 bytes).
    const px = f[0] + f[4];
    const py = f[1] + f[5];
    const pz = f[2] + f[6];
    staging.unmap();

    if (isFinite(px) && isFinite(py) && isFinite(pz)) {
      if (!cache.posCacheValue) {
        cache.posCacheValue = { x: px, y: py, z: pz };
      } else {
        cache.posCacheValue.x = px;
        cache.posCacheValue.y = py;
        cache.posCacheValue.z = pz;
      }
      cache.posCacheIndex = index;
      cache.posCacheStamp = requestStamp;
    }
  } catch (e) {
    // Buffer destroyed / device lost — drop this readback; the next query
    // re-arms. (No console.error: a stale-cache miss falls back to depth pick.)
  } finally {
    cache.posReadbackPending = false;
  }
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
        { binding: 3, resource: { buffer: prevBuffer } },
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
  // Pick side (NEW-ORBITAL-GPU-PICKING) — free the per-instance pick ids
  // (releases the context's pickObjects/pickKinds entries) and the GPU pick
  // color buffer so a destroyed collection leaves no orphan pick state.
  destroyPickIds(cache);
  cache.pickColorBuffer?.destroy();
  // pickPosition readback staging buffer (NEW-COMPUTE-INSTANCE-PICKPOSITION).
  cache.posReadbackBuffer?.destroy();
  collection._webgpuCache = undefined;
}

export {
  updateWebGPUComputeInstanceCollection,
  destroyWebGPUComputeInstanceResources,
  getWebGPUInstanceWorldPosition,
};
export default {
  updateWebGPUComputeInstanceCollection,
  destroyWebGPUComputeInstanceResources,
  getWebGPUInstanceWorldPosition,
};
