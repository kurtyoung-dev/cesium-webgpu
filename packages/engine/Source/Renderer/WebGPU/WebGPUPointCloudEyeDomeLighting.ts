/// <reference types="@webgpu/types" />
/**
 * WebGPU Point Cloud Eye-Dome Lighting (EDL) — full data path (PARITY-PC-EDL).
 *
 * EDL is a depth-discontinuity post-process that darkens the edges of a point
 * cloud to enhance depth perception (Boucheny 2009). The WebGL implementation
 * lives in `Scene/PointCloudEyeDomeLighting.js`: it redirects every point-cloud
 * draw command into an off-screen framebuffer with two color attachments
 * (color + eye/device depth) using a depth-writing "EC" shader variant, then blends
 * a darkened-edge result back to the main framebuffer.
 *
 * This module ports that pipeline to WebGPU:
 *
 *   1. `update()` (called from `PointCloudEyeDomeLighting.update` during scene
 *      traversal) tags each freshly-pushed point command with stable,
 *      processor-owned metadata. It does not allocate targets or disable the
 *      original command because its frustum and destination are not known yet.
 *
 *   2. The 3D-tile and opaque pass orchestrators preflight only their current
 *      frustum bucket against the exact scene/invert target. A command is
 *      disabled only after every replay/composite resource is usable.
 *
 *   3. Immediately after that pass, each processor group is replayed into a
 *      cleared off-screen color + eye/device-depth target and composited back
 *      in stable update order. Tile groups run before globe-depth publication
 *      and classification; opaque groups run before post-opaque depth repack.
 *      Any synchronous failure restores and directly draws the originals.
 *
 * # Off-gate (parity-neutral when disabled)
 *
 * Everything here runs ONLY when the user turns on
 * `pointCloudShading.eyeDomeLighting` (default false). With EDL off:
 *   - `PointCloudEyeDomeLighting.update` never delegates the EDL path (the
 *     3D-Tileset gate in `Cesium3DTileset.js` short-circuits), so `update()`
 *     below is never called → no metadata work or command interception.
 *   - The depth shader is compiled with the `POINT_CLOUD_EDL_DEPTH` define
 *     which is add-only; at `defines=0` the point draw shaders and every other
 *     WGSL module preprocess byte-identically.
 *   - Pass-local preparation first scans its existing command bucket and
 *     returns before cache/texture access when no tagged candidate exists.
 *
 * @module WebGPUPointCloudEyeDomeLighting
 */

import Pass from "../Pass.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { gpuData } from "./webgpuTypeHelpers.js";
import { ShaderSourceId, ShaderDefine } from "./WebGPUShaderDefines.js";
import { makeDeviceShaderModuleCacheAccessor } from "./WebGPUCollectionRendererBase.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import PointCloudEDLDepthWGSL from "../../Shaders/WebGPU/PointCloud/PointCloudEDLDepth.js";
import PointCloudEDLBlendWGSL from "../../Shaders/WebGPU/Advanced/PointCloudEDL.js";
import type { PointCloudEDLSource } from "./WebGPUPointCloudRenderer.js";
import {
  POINT_CLOUD_EDL_TILE_STENCIL_MASK,
  acquireWebGPUPointCloudEDLUniformSlice,
  beginWebGPUPointCloudEDLCandidateFrame,
  beginWebGPUPointCloudEDLProcessorUpdate,
  createWebGPUPointCloudEDLCompositeDepthStencilState,
  findNextWebGPUPointCloudEDLProcessor,
  getWebGPUPointCloudEDLBlendPipelineKey,
  hasCurrentWebGPUPointCloudEDLCandidate,
  interceptWebGPUPointCloudEDLCommand,
  isWebGPUPointCloudEDLCacheCurrent,
  isWebGPUPointCloudEDLMetadataForSlice,
  markWebGPUPointCloudEDLCandidate,
  releaseWebGPUPointCloudEDLOwner,
  restoreWebGPUPointCloudEDLCommand,
  shouldReleaseWebGPUPointCloudEDLTargets,
  withWebGPUPointCloudEDLFailOpen,
} from "./WebGPUPointCloudEDLState.js";

// The blend uniform block (`EDLUniforms`) is 8 floats / 32 bytes:
// texelSize.xy, strength, radius, nearPlane, farPlane, _pad0, _pad1.
const BLEND_UNIFORM_FLOATS = 8;
const getPointCloudEDLShaderModuleCache = makeDeviceShaderModuleCacheAccessor();

let edlFailureLastReportTime = -Infinity;

function reportWebGPUPointCloudEDLFailure(
  context: CesiumGraphicsContext,
  message: string,
  error: unknown,
): void {
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - edlFailureLastReportTime < 3000) {
    return;
  }
  edlFailureLastReportTime = now;
  const detail = error instanceof Error ? error.message : String(error);
  const logger = context as unknown as {
    log?: (level: string, message: string) => void;
  };
  if (logger.log !== undefined) {
    logger.log("error", `${message}: ${detail}`);
    return;
  }
  console.error(`[CesiumJS:webgpu] ${message}: ${detail}`);
}

export type WebGPUPointCloudEDLTargetKind = "scene" | "invert";

/** Stable command-owned metadata. Allocated once, then mutated per update. */
export interface WebGPUPointCloudEDLCommandMetadata {
  processor: EDLProcessorLike;
  source: PointCloudEDLSource;
  frameNumber: number;
  updateOrder: number;
  strength: number;
  radius: number;
  pass: number;
  boundingVolume: unknown;
  interceptFrame: number;
  interceptSlice: number;
  targetKind: WebGPUPointCloudEDLTargetKind | null;
  targetIdentity: object | null;
}

/**
 * Per-context cache of EDL GPU resources. Allocated lazily the first frame EDL
 * is active; torn down by `destroy()` on toggle-off / device loss.
 */
interface PointCloudEDLCache {
  device: GPUDevice;
  resourceGeneration: number;
  colorFormat: GPUTextureFormat;
  width: number;
  height: number;

  // Off-screen render targets (single-sample). Slot 0 = point color in the
  // scene color format; slot 1 = raw eye-space + exact scene device depth
  // (rg32float); plus a depth-stencil for point-to-point depth testing.
  colorTexture: GPUTexture | null;
  colorView: GPUTextureView | null;
  eyeDepthTexture: GPUTexture | null;
  eyeDepthView: GPUTextureView | null;
  dsTexture: GPUTexture | null;
  dsView: GPUTextureView | null;

  // Depth-writing point pipeline (dual output: color + eye/device depth).
  depthShaderModule: GPUShaderModule | null;
  depthUniformBGL: GPUBindGroupLayout | null;
  depthEffectsBGL: GPUBindGroupLayout | null;
  depthPipeline: GPURenderPipeline | null;
  lodDepthPipeline: GPURenderPipeline | null;
  lodDepthStorageBGL: GPUBindGroupLayout | null;
  // Per-source uniform bind groups, keyed by the source's uniform buffer so a
  // scene with multiple point clouds reuses one BG per cloud.
  depthUniformBindGroups: WeakMap<GPUBuffer, GPUBindGroup>;

  // Blend/composite pipeline (full-screen, samples the off-screen FBO).
  blendShaderModule: GPUShaderModule | null;
  blendBGL: GPUBindGroupLayout | null;
  blendPipelines: Map<string, GPURenderPipeline>;
  // One bind group per page of the context's bounded, submit-safe uniform
  // ring. Dynamic offsets select a distinct 256-byte slot per composite.
  blendBindGroups: WeakMap<GPUBuffer, GPUBindGroup>;
  blendSampler: GPUSampler | null;
  blendUniformData: Float32Array;
  blendDynamicOffsetScratch: number[];
  releaseInvalidation: (() => void) | null;
  owners: Set<EDLProcessorLike>;
  lastActiveFrame: number;
}

/**
 * Minimal shape of the WebGL `PointCloudEyeDomeLighting` processor this
 * renderer reads. `_strength` / `_radius` are the user-configured EDL controls
 * (set on the processor by `PointCloudEyeDomeLighting.update` in the WebGL
 * path; we read the same fields for parity).
 */
export interface EDLProcessorLike {
  _strength?: number;
  _radius?: number;
  _webgpuEDLActive?: boolean;
  _webgpuEDLContext?: CesiumGraphicsContext | null;
  _webgpuEDLUpdateContext?: CesiumGraphicsContext | null;
  _webgpuEDLUpdateFrame?: number;
  _webgpuEDLUpdateOrder?: number;
}

interface EDLProcessorSelection {
  processor: EDLProcessorLike;
  updateOrder: number;
}

// Scalar per-context scheduler state. Commands own their metadata, so no
// context-global cloud list or last-writer control values exist.
interface EDLContextState {
  _pointCloudEDLCache?: PointCloudEDLCache | null;
  _pointCloudEDLUpdateFrame?: number;
  _pointCloudEDLNextUpdateOrder?: number;
  _pointCloudEDLCandidateFrame?: number;
  _pointCloudEDLCandidatePassMask?: number;
}

function getBlendSampler(cache: PointCloudEDLCache): GPUSampler {
  if (!cache.blendSampler) {
    cache.blendSampler = cache.device.createSampler({
      label: "PointCloudEDL blend sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }
  return cache.blendSampler;
}

/**
 * Build (once) the depth-writing point pipeline. Dual color targets:
 *   slot 0 — point color (scene color format)
 *   slot 1 — eye-space + exact scene device depth (rg32float)
 * Depth-stencil matches the point draw's `depth24plus-stencil8` / less-equal.
 */
function ensureDepthPipeline(
  cache: PointCloudEDLCache,
  effectsBGL: GPUBindGroupLayout,
): void {
  if (cache.depthPipeline && cache.depthEffectsBGL === effectsBGL) {
    return;
  }
  cache.depthPipeline = null;
  cache.lodDepthPipeline = null;
  cache.lodDepthStorageBGL = null;
  cache.depthEffectsBGL = effectsBGL;
  const device = cache.device;
  if (!cache.depthShaderModule) {
    const moduleCache = getPointCloudEDLShaderModuleCache(device);
    cache.depthShaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_CLOUD_EDL_DEPTH,
      PointCloudEDLDepthWGSL,
      ShaderDefine.POINT_CLOUD_EDL_DEPTH,
      "PointCloudEDL depth shader",
    );
  }
  if (!cache.depthUniformBGL) {
    cache.depthUniformBGL = makeBindGroupLayout(
      device,
      "PointCloudEDL depth uniform BGL",
      // VERTEX_FRAGMENT: FS reads log-depth controls and atmosphere inputs.
      [uniformBuffer(0, Stage.VERTEX_FRAGMENT)],
    );
  }
  cache.depthPipeline = device.createRenderPipeline({
    label: "PointCloudEDL depth pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.depthUniformBGL, effectsBGL],
    }),
    vertex: {
      module: cache.depthShaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
        {
          arrayStride: 40,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x3" },
            { shaderLocation: 2, offset: 12, format: "float32x3" },
            { shaderLocation: 3, offset: 24, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: cache.depthShaderModule,
      entryPoint: "fragmentMain",
      targets: [
        // slot 0 — point color, standard alpha blend (matches on-screen draw).
        {
          format: cache.colorFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
        // slot 1 — raw eye-space + exact device depth (rg32float), no blend.
        { format: "rg32float" },
      ],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
}

/** Build the storage/indirect sibling used by GPU-LOD point clouds. */
function ensureLodDepthPipeline(
  cache: PointCloudEDLCache,
  effectsBGL: GPUBindGroupLayout,
  storageBGL: GPUBindGroupLayout,
): void {
  ensureDepthPipeline(cache, effectsBGL);
  if (cache.lodDepthPipeline && cache.lodDepthStorageBGL === storageBGL) {
    return;
  }
  cache.lodDepthStorageBGL = storageBGL;
  cache.lodDepthPipeline = cache.device.createRenderPipeline({
    label: "PointCloudEDL LOD depth pipeline",
    layout: cache.device.createPipelineLayout({
      bindGroupLayouts: [cache.depthUniformBGL!, effectsBGL, storageBGL],
    }),
    vertex: {
      module: cache.depthShaderModule!,
      entryPoint: "vertexMainLOD",
      buffers: [
        {
          arrayStride: 8,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module: cache.depthShaderModule!,
      entryPoint: "fragmentMain",
      targets: [{ format: cache.colorFormat }, { format: "rg32float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
  });
}

/**
 * Build (once) the full-screen blend pipeline that composites the darkened
 * off-screen point color back onto the scene framebuffer.
 */
function ensureBlendPipeline(
  cache: PointCloudEDLCache,
  targetKind: WebGPUPointCloudEDLTargetKind,
  sceneFormat: GPUTextureFormat,
  sampleCount: number,
  targetCount: number,
): GPURenderPipeline | null {
  const key = getWebGPUPointCloudEDLBlendPipelineKey(
    targetKind,
    sceneFormat,
    sampleCount,
    targetCount,
  );
  const existing = cache.blendPipelines.get(key);
  if (existing) {
    return existing;
  }
  const device = cache.device;
  if (!cache.blendShaderModule) {
    const moduleCache = getPointCloudEDLShaderModuleCache(device);
    cache.blendShaderModule = moduleCache.getOrCreate(
      ShaderSourceId.POINT_CLOUD_EDL_BLEND,
      PointCloudEDLBlendWGSL,
      0,
      "PointCloudEDL blend shader",
    );
  }
  if (!cache.blendBGL) {
    cache.blendBGL = makeBindGroupLayout(device, "PointCloudEDL blend BGL", [
      texture(0, Stage.FRAGMENT, { sampleType: "unfilterable-float" }), // color
      texture(1, Stage.FRAGMENT, { sampleType: "unfilterable-float" }), // rg32float eye + device depth
      sampler(2, Stage.FRAGMENT, "non-filtering"),
      uniformBuffer(3, Stage.FRAGMENT, {
        hasDynamicOffset: true,
        minBindingSize: BLEND_UNIFORM_FLOATS * 4,
      }),
    ]);
  }
  const blend: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  };
  const targets =
    targetKind === "scene"
      ? makeSceneFBTargets(sceneFormat, { blend })
      : [{ format: sceneFormat, blend }];
  if (targets.length !== targetCount) {
    return null;
  }
  const pipeline = device.createRenderPipeline({
    label: "PointCloudEDL blend pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.blendBGL],
    }),
    vertex: { module: cache.blendShaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: cache.blendShaderModule,
      entryPoint: "fragmentMain",
      // The scene FB render pass carries a slot-1 MRT G-buffer attachment
      // (when MRT mode is on), so the composite pipeline must declare BOTH
      // targets — slot 0 = darkened point color (alpha-blended over the scene),
      // slot 1 = placeholder (writeMask 0). `makeSceneFBTargets` produces the
      // right shape for the current MRT mode.
      targets,
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    // The composite re-emits the exact device depth captured by the point
    // replay. Testing/writing it here makes opaque terrain occlude points and
    // publishes point depth to later translucent/post/TAA consumers.
    depthStencil: createWebGPUPointCloudEDLCompositeDepthStencilState(),
    // Match the scene framebuffer's MSAA sample count so the composite draw is
    // attachment-compatible with the (MSAA) Scene Framebuffer Render Pass.
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  });
  cache.blendPipelines.set(key, pipeline);
  return pipeline;
}

/**
 * Ensure the per-context EDL cache exists and the off-screen framebuffer is
 * sized to the current drawing buffer.
 */
function ensureCache(
  context: CesiumGraphicsContext,
  sceneFormat: GPUTextureFormat,
): PointCloudEDLCache | null {
  const device = (context as unknown as { device?: GPUDevice }).device;
  if (!device) {
    return null;
  }
  const resourceGeneration =
    (context as unknown as { resourceGeneration?: number })
      .resourceGeneration ?? 0;
  const width = Math.max(1, context.drawingBufferWidth | 0);
  const height = Math.max(1, context.drawingBufferHeight | 0);

  const ctxState = context as unknown as EDLContextState;
  let cache = ctxState._pointCloudEDLCache ?? null;
  if (
    cache &&
    !isWebGPUPointCloudEDLCacheCurrent(cache, device, resourceGeneration)
  ) {
    destroyEDLCache(cache);
    ctxState._pointCloudEDLCache = null;
    cache = null;
  }
  if (!cache) {
    cache = {
      device,
      resourceGeneration,
      colorFormat: sceneFormat,
      width: 0,
      height: 0,
      colorTexture: null,
      colorView: null,
      eyeDepthTexture: null,
      eyeDepthView: null,
      dsTexture: null,
      dsView: null,
      depthShaderModule: null,
      depthUniformBGL: null,
      depthEffectsBGL: null,
      depthPipeline: null,
      lodDepthPipeline: null,
      lodDepthStorageBGL: null,
      depthUniformBindGroups: new WeakMap(),
      blendShaderModule: null,
      blendBGL: null,
      blendPipelines: new Map(),
      blendBindGroups: new WeakMap(),
      blendSampler: null,
      blendUniformData: new Float32Array(BLEND_UNIFORM_FLOATS),
      blendDynamicOffsetScratch: [0],
      releaseInvalidation: null,
      owners: new Set(),
      lastActiveFrame: -1,
    };
    ctxState._pointCloudEDLCache = cache;
    const ownedCache = cache;
    const subscribe = (
      context as unknown as {
        onDeviceInvalidated?: (callback: () => void) => () => void;
      }
    ).onDeviceInvalidated;
    if (typeof subscribe === "function") {
      ownedCache.releaseInvalidation = subscribe.call(context, () => {
        if (ctxState._pointCloudEDLCache !== ownedCache) {
          return;
        }
        ctxState._pointCloudEDLCache = null;
        destroyEDLCache(ownedCache);
      });
    }
  }

  // Scene color format flipped (HDR toggle) — rebuild the color pipeline +
  // off-screen color texture against the new format.
  if (cache.colorFormat !== sceneFormat) {
    cache.colorFormat = sceneFormat;
    cache.width = 0; // force texture rebuild below
    cache.height = 0;
    cache.depthPipeline = null;
    cache.lodDepthPipeline = null;
    cache.lodDepthStorageBGL = null;
    cache.blendBindGroups = new WeakMap();
  }

  if (cache.width !== width || cache.height !== height) {
    destroyEDLTextures(cache);
    cache.width = width;
    cache.height = height;
    cache.colorTexture = device.createTexture({
      label: "PointCloudEDL color",
      size: { width, height },
      format: sceneFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.colorView = cache.colorTexture.createView();
    cache.eyeDepthTexture = device.createTexture({
      label: "PointCloudEDL eyeDepth",
      size: { width, height },
      format: "rg32float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    cache.eyeDepthView = cache.eyeDepthTexture.createView();
    cache.dsTexture = device.createTexture({
      label: "PointCloudEDL depthStencil",
      size: { width, height },
      format: "depth24plus-stencil8",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    cache.dsView = cache.dsTexture.createView();
    // Off-screen texture views changed — every page bind group must rebind.
    cache.blendBindGroups = new WeakMap();
  }

  return cache;
}

/** Release the off-screen render-target textures (resize / destroy). */
function destroyEDLTextures(cache: PointCloudEDLCache): void {
  cache.colorTexture?.destroy();
  cache.eyeDepthTexture?.destroy();
  cache.dsTexture?.destroy();
  cache.colorTexture = null;
  cache.colorView = null;
  cache.eyeDepthTexture = null;
  cache.eyeDepthView = null;
  cache.dsTexture = null;
  cache.dsView = null;
  cache.width = 0;
  cache.height = 0;
  cache.blendBindGroups = new WeakMap();
}

/** Destroy every owned EDL allocation and detach its invalidation listener. */
function destroyEDLCache(cache: PointCloudEDLCache): void {
  const releaseInvalidation = cache.releaseInvalidation;
  cache.releaseInvalidation = null;
  releaseInvalidation?.();
  destroyEDLTextures(cache);
  cache.blendBindGroups = new WeakMap();
  cache.blendPipelines.clear();
  cache.depthPipeline = null;
  cache.lodDepthPipeline = null;
  cache.lodDepthStorageBGL = null;
  cache.depthEffectsBGL = null;
  cache.owners.clear();
}

type EDLAwareCommand = CesiumAnyDrawCommand & {
  enabled?: boolean;
  _edlSource?: PointCloudEDLSource;
  _webgpuPointCloudEDL?: WebGPUPointCloudEDLCommandMetadata;
};

function getFrameNumber(frameState: CesiumFrameState): number {
  return (frameState as unknown as { frameNumber?: number }).frameNumber ?? 0;
}

function getResourceGeneration(context: CesiumGraphicsContext): number {
  return (
    (context as unknown as { resourceGeneration?: number })
      .resourceGeneration ?? 0
  );
}

function endCurrentRenderPass(context: CesiumGraphicsContext): void {
  (
    context as unknown as {
      endCurrentRenderPass?: () => void;
    }
  ).endCurrentRenderPass?.();
}

function isSourceUsable(
  source: PointCloudEDLSource | undefined,
  device: GPUDevice | undefined,
  resourceGeneration: number,
): source is PointCloudEDLSource {
  return !!(
    source &&
    device &&
    source.device === device &&
    source.resourceGeneration === resourceGeneration &&
    source.instanceBuffer &&
    source.uniformBuffer &&
    source.quadVertexBuffer &&
    source.effectsBindGroup &&
    source.effectsBindGroupLayout &&
    source.instanceCount > 0
  );
}

function ensureDepthUniformBindGroup(
  cache: PointCloudEDLCache,
  source: PointCloudEDLSource,
): GPUBindGroup | null {
  const uniformBuffer = source.uniformBuffer;
  if (!uniformBuffer || !cache.depthUniformBGL) {
    return null;
  }
  let bindGroup = cache.depthUniformBindGroups.get(uniformBuffer);
  if (!bindGroup) {
    bindGroup = cache.device.createBindGroup({
      label: "PointCloudEDL depth uniform BG",
      layout: cache.depthUniformBGL,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    cache.depthUniformBindGroups.set(uniformBuffer, bindGroup);
  }
  return bindGroup;
}

function ensureBlendBindGroup(
  cache: PointCloudEDLCache,
  uniformPage: GPUBuffer,
): GPUBindGroup | null {
  const existing = cache.blendBindGroups.get(uniformPage);
  if (existing) {
    return existing;
  }
  if (!cache.blendBGL || !cache.colorView || !cache.eyeDepthView) {
    return null;
  }
  const bindGroup = cache.device.createBindGroup({
    label: "PointCloudEDL blend arena-page BG",
    layout: cache.blendBGL,
    entries: [
      { binding: 0, resource: cache.colorView },
      { binding: 1, resource: cache.eyeDepthView },
      { binding: 2, resource: getBlendSampler(cache) },
      {
        binding: 3,
        resource: {
          buffer: uniformPage,
          offset: 0,
          size: BLEND_UNIFORM_FLOATS * 4,
        },
      },
    ],
  });
  cache.blendBindGroups.set(uniformPage, bindGroup);
  return bindGroup;
}

function preflightSource(
  cache: PointCloudEDLCache,
  source: PointCloudEDLSource,
): boolean {
  const effectsLayout = source.effectsBindGroupLayout;
  if (!effectsLayout) {
    return false;
  }
  ensureDepthPipeline(cache, effectsLayout);
  if (!cache.depthPipeline || !ensureDepthUniformBindGroup(cache, source)) {
    return false;
  }
  if (
    source.lodStorageBindGroup ||
    source.lodStorageBindGroupLayout ||
    source.drawIndirectBuffer
  ) {
    if (
      !source.lodStorageBindGroup ||
      !source.lodStorageBindGroupLayout ||
      !source.drawIndirectBuffer
    ) {
      return false;
    }
    ensureLodDepthPipeline(
      cache,
      effectsLayout,
      source.lodStorageBindGroupLayout,
    );
    if (!cache.lodDepthPipeline) {
      return false;
    }
  }
  return true;
}

/** Release one processor from exactly the context cache it previously owned. */
function releaseProcessorContextOwnership(
  processor: EDLProcessorLike,
  context: CesiumGraphicsContext,
): void {
  const ctxState = context as unknown as EDLContextState;
  const cache = ctxState._pointCloudEDLCache;
  if (cache && releaseWebGPUPointCloudEDLOwner(cache.owners, processor)) {
    destroyEDLCache(cache);
    ctxState._pointCloudEDLCache = null;
  }
}

/**
 * Feature-renderer update entry. The scene traversal does not yet know which
 * frustum or render target will own a command, so this phase only attaches a
 * stable, command-owned descriptor. The descriptor is allocated at most once
 * for the command and mutated on subsequent frames. No command is disabled
 * until the frustum-local target preflight succeeds.
 */
function updateWebGPUPointCloudEDL(
  processor: EDLProcessorLike,
  frameState: CesiumFrameState,
  commandStart: number,
): void {
  const context = frameState.context;
  const ctxState = context as unknown as EDLContextState;
  const frameNumber = getFrameNumber(frameState);
  const previousContext = processor._webgpuEDLContext;
  if (previousContext && previousContext !== context) {
    // A primitive can migrate between pooled contexts without being
    // destroyed. Remove its old cache ownership before publishing the new
    // context so the final old owner deterministically retires 4K targets.
    releaseProcessorContextOwnership(processor, previousContext);
  }
  const updateOrder = beginWebGPUPointCloudEDLProcessorUpdate(
    ctxState,
    processor,
    frameNumber,
  );
  processor._webgpuEDLActive = true;
  processor._webgpuEDLContext = context;
  beginWebGPUPointCloudEDLCandidateFrame(ctxState, frameNumber);

  const device = (context as unknown as { device?: GPUDevice }).device;
  const resourceGeneration = getResourceGeneration(context);
  const commandList = frameState.commandList;
  const start = typeof commandStart === "number" ? commandStart : 0;
  for (let i = start; i < commandList.length; i++) {
    const command = commandList[i] as EDLAwareCommand;
    const source = command._edlSource;
    if (
      command.isWebGPUDrawCommand !== true ||
      command.pass === Pass.TRANSLUCENT ||
      !isSourceUsable(source, device, resourceGeneration)
    ) {
      continue;
    }
    let metadata = command._webgpuPointCloudEDL;
    if (!metadata) {
      metadata = {
        processor,
        source,
        frameNumber,
        updateOrder,
        strength: processor._strength ?? 1.0,
        radius: processor._radius ?? 1.0,
        pass: command.pass ?? Pass.OPAQUE,
        boundingVolume: command.boundingVolume,
        interceptFrame: -1,
        interceptSlice: -1,
        targetKind: null,
        targetIdentity: null,
      };
      command._webgpuPointCloudEDL = metadata;
    } else {
      metadata.processor = processor;
      metadata.source = source;
      metadata.frameNumber = frameNumber;
      metadata.updateOrder = updateOrder;
      metadata.strength = processor._strength ?? 1.0;
      metadata.radius = processor._radius ?? 1.0;
      metadata.pass = command.pass ?? Pass.OPAQUE;
      metadata.boundingVolume = command.boundingVolume;
      metadata.interceptFrame = -1;
      metadata.interceptSlice = -1;
      metadata.targetKind = null;
      metadata.targetIdentity = null;
    }
    markWebGPUPointCloudEDLCandidate(ctxState, frameNumber, metadata.pass);
  }
}

function isMetadataCandidate(
  command: EDLAwareCommand,
  frameNumber: number,
  pass: number,
): boolean {
  const metadata = command._webgpuPointCloudEDL;
  return !!(
    command.enabled !== false &&
    metadata &&
    metadata.frameNumber === frameNumber &&
    metadata.pass === pass &&
    pass !== Pass.TRANSLUCENT
  );
}

/**
 * Preflight one concrete frustum/pass/target slice. Only commands whose exact
 * replay and composite resources are ready are disabled; all other commands
 * remain enabled and follow the normal renderer path (fail open).
 */
export function prepareWebGPUPointCloudEDLCommands(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  commands: CesiumAnyDrawCommand[],
  count: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  targetFormat: GPUTextureFormat,
  sampleCount: number,
  targetCount: number,
): number {
  const frameNumber = getFrameNumber(frameState);
  const ctxState = context as unknown as EDLContextState;
  // This scalar exact-frame/pass mask is maintained while commands are tagged.
  // It prevents the ordinary opaque/tile path from walking its command bucket
  // at all when EDL is off, stale, or produced no compatible source.
  if (!hasCurrentWebGPUPointCloudEDLCandidate(ctxState, frameNumber, pass)) {
    return 0;
  }
  let hasCandidate = false;
  for (let i = 0; i < count; i++) {
    if (
      isMetadataCandidate(commands[i] as EDLAwareCommand, frameNumber, pass)
    ) {
      hasCandidate = true;
      break;
    }
  }
  if (!hasCandidate) {
    return 0;
  }

  const device = (context as unknown as { device?: GPUDevice }).device;
  if (!device) {
    return 0;
  }
  const resourceGeneration = getResourceGeneration(context);
  let cache: PointCloudEDLCache | null = null;
  try {
    cache = ensureCache(context, targetFormat);
    if (
      !cache ||
      !ensureBlendPipeline(
        cache,
        targetKind,
        targetFormat,
        sampleCount,
        targetCount,
      )
    ) {
      return 0;
    }
  } catch {
    return 0;
  }

  let intercepted = 0;
  for (let i = 0; i < count; i++) {
    const command = commands[i] as EDLAwareCommand;
    if (!isMetadataCandidate(command, frameNumber, pass)) {
      continue;
    }
    const metadata = command._webgpuPointCloudEDL!;
    if (!isSourceUsable(metadata.source, device, resourceGeneration)) {
      continue;
    }
    try {
      if (!preflightSource(cache, metadata.source)) {
        continue;
      }
    } catch {
      continue;
    }
    interceptWebGPUPointCloudEDLCommand(
      command,
      metadata,
      frameNumber,
      frustumSlice,
      targetKind,
      targetIdentity,
    );
    cache.owners.add(metadata.processor);
    cache.lastActiveFrame = frameNumber;
    intercepted++;
  }
  return intercepted;
}

function matchesIntercept(
  command: EDLAwareCommand,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  processor?: EDLProcessorLike,
  updateOrder?: number,
): boolean {
  const metadata = command._webgpuPointCloudEDL;
  return !!(
    command.enabled === false &&
    isWebGPUPointCloudEDLMetadataForSlice(
      metadata,
      frameNumber,
      pass,
      frustumSlice,
      targetKind,
      targetIdentity,
    ) &&
    (processor === undefined || metadata.processor === processor) &&
    (updateOrder === undefined || metadata.updateOrder === updateOrder)
  );
}

function findNextProcessor(
  commands: CesiumAnyDrawCommand[],
  count: number,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  afterOrder: number,
): EDLProcessorSelection | null {
  return findNextWebGPUPointCloudEDLProcessor(
    commands,
    count,
    frameNumber,
    pass,
    frustumSlice,
    targetKind,
    targetIdentity,
    afterOrder,
  ) as EDLProcessorSelection | null;
}

function getReadyProcessorGroupMetadata(
  cache: PointCloudEDLCache,
  commands: CesiumAnyDrawCommand[],
  count: number,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  processor: EDLProcessorLike,
  updateOrder: number,
): WebGPUPointCloudEDLCommandMetadata | null {
  let firstMetadata: WebGPUPointCloudEDLCommandMetadata | null = null;
  for (let i = 0; i < count; i++) {
    const command = commands[i] as EDLAwareCommand;
    if (
      !matchesIntercept(
        command,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
      )
    ) {
      continue;
    }
    const metadata = command._webgpuPointCloudEDL!;
    firstMetadata ??= metadata;
    const source = metadata.source;
    if (
      !isSourceUsable(source, cache.device, cache.resourceGeneration) ||
      !preflightSource(cache, source)
    ) {
      return null;
    }
  }
  return firstMetadata;
}

function restoreProcessorGroup(
  context: CesiumGraphicsContext,
  commands: CesiumAnyDrawCommand[],
  count: number,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  processor: EDLProcessorLike,
  updateOrder: number,
  fallbackPass: GPURenderPassEncoder | null,
): void {
  for (let i = 0; i < count; i++) {
    const command = commands[i] as EDLAwareCommand;
    if (
      !matchesIntercept(
        command,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
      )
    ) {
      continue;
    }
    const metadata = command._webgpuPointCloudEDL!;
    restoreWebGPUPointCloudEDLCommand(command, metadata);
    if (fallbackPass && command.execute) {
      try {
        command.execute(fallbackPass, context);
      } catch (error: unknown) {
        const logger = context as unknown as {
          log?: (level: string, message: string) => void;
        };
        logger.log?.(
          "warn",
          `Point-cloud EDL fail-open draw failed: ${(error as Error).message}`,
        );
      }
    }
  }
}

function restoreAllInterceptedCommands(
  context: CesiumGraphicsContext,
  commands: CesiumAnyDrawCommand[],
  count: number,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  fallbackPass: GPURenderPassEncoder | null,
): void {
  for (let i = 0; i < count; i++) {
    const command = commands[i] as EDLAwareCommand;
    if (
      !matchesIntercept(
        command,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
      )
    ) {
      continue;
    }
    const metadata = command._webgpuPointCloudEDL!;
    restoreWebGPUPointCloudEDLCommand(command, metadata);
    if (fallbackPass && command.execute) {
      try {
        command.execute(fallbackPass, context);
      } catch {
        // The command remains enabled. The scene dispatcher may still see it
        // in another slice; this recovery path must never hide the source.
      }
    }
  }
}

function getCurrentRenderPass(
  context: CesiumGraphicsContext,
): GPURenderPassEncoder | null {
  return (
    (
      context as unknown as {
        currentRenderPassEncoder?: GPURenderPassEncoder | null;
      }
    ).currentRenderPassEncoder ?? null
  );
}

function acquireBlendUniformBinding(
  cache: PointCloudEDLCache,
  metadata: WebGPUPointCloudEDLCommandMetadata,
  context: CesiumGraphicsContext,
): GPUBindGroup | null {
  const data = cache.blendUniformData;
  data[0] = 1.0 / cache.width;
  data[1] = 1.0 / cache.height;
  data[2] = metadata.strength;
  data[3] = metadata.radius;
  data[4] = getFrustumNear(context);
  data[5] = getFrustumFar(context);
  data[6] = 0.0;
  data[7] = 0.0;
  const allocator = (
    context as unknown as {
      uniformAllocator?: {
        allocateAndWrite(
          source: ArrayBuffer | ArrayBufferView,
          allocationSize?: number,
        ): { buffer: GPUBuffer; offset: number };
      } | null;
    }
  ).uniformAllocator;
  const allocation = acquireWebGPUPointCloudEDLUniformSlice(
    allocator,
    gpuData(data),
  ) as { buffer: GPUBuffer; offset: number } | null;
  if (!allocation) {
    return null;
  }
  const bindGroup = ensureBlendBindGroup(cache, allocation.buffer);
  if (!bindGroup) {
    return null;
  }
  // The one-element array is retained on the cache. WebGPU snapshots dynamic
  // offsets at setBindGroup encoding time, so mutating it for the next group
  // creates no command-stream alias and avoids a hot-path JS allocation.
  cache.blendDynamicOffsetScratch[0] = allocation.offset;
  return bindGroup;
}

function drawProcessorGroupOffscreen(
  cache: PointCloudEDLCache,
  passEncoder: GPURenderPassEncoder,
  commands: CesiumAnyDrawCommand[],
  count: number,
  frameNumber: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  processor: EDLProcessorLike,
  updateOrder: number,
): WebGPUPointCloudEDLCommandMetadata | null {
  let firstMetadata: WebGPUPointCloudEDLCommandMetadata | null = null;
  for (let i = 0; i < count; i++) {
    const command = commands[i] as EDLAwareCommand;
    if (
      !matchesIntercept(
        command,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
      )
    ) {
      continue;
    }
    const metadata = command._webgpuPointCloudEDL!;
    const source = metadata.source;
    firstMetadata ??= metadata;
    ensureDepthPipeline(cache, source.effectsBindGroupLayout!);
    const uniformBindGroup = ensureDepthUniformBindGroup(cache, source)!;
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.setBindGroup(1, source.effectsBindGroup!);
    passEncoder.setVertexBuffer(0, source.quadVertexBuffer!);
    if (
      source.lodStorageBindGroup &&
      source.lodStorageBindGroupLayout &&
      source.drawIndirectBuffer
    ) {
      ensureLodDepthPipeline(
        cache,
        source.effectsBindGroupLayout!,
        source.lodStorageBindGroupLayout,
      );
      passEncoder.setPipeline(cache.lodDepthPipeline!);
      passEncoder.setBindGroup(2, source.lodStorageBindGroup);
      passEncoder.drawIndirect(source.drawIndirectBuffer, 0);
    } else {
      passEncoder.setPipeline(cache.depthPipeline!);
      passEncoder.setVertexBuffer(1, source.instanceBuffer!);
      passEncoder.draw(6, source.instanceCount, 0, 0);
    }
  }
  return firstMetadata;
}

/**
 * Replay and composite every intercepted processor group for this exact
 * frustum/pass/target. Groups are discovered by stable update order directly
 * from the bucket; no per-frame command wrappers or cloud arrays are built.
 * The returned target pass remains open for the caller's subsequent work.
 */
export function renderWebGPUPointCloudEDLCommands(
  context: CesiumGraphicsContext,
  frameState: CesiumFrameState,
  commands: CesiumAnyDrawCommand[],
  count: number,
  pass: number,
  frustumSlice: number,
  targetKind: WebGPUPointCloudEDLTargetKind,
  targetIdentity: object,
  targetFormat: GPUTextureFormat,
  sampleCount: number,
  targetCount: number,
  resumeTargetPass: () => GPURenderPassEncoder | null,
): boolean {
  const frameNumber = getFrameNumber(frameState);
  const ctxState = context as unknown as EDLContextState;
  if (!hasCurrentWebGPUPointCloudEDLCandidate(ctxState, frameNumber, pass)) {
    return true;
  }
  const cache = ctxState._pointCloudEDLCache ?? null;
  const device = (context as unknown as { device?: GPUDevice }).device;
  if (
    !cache ||
    !device ||
    !isWebGPUPointCloudEDLCacheCurrent(
      cache,
      device,
      getResourceGeneration(context),
    )
  ) {
    let fallbackPass = getCurrentRenderPass(context);
    if (!fallbackPass) {
      try {
        fallbackPass = resumeTargetPass();
      } catch {
        fallbackPass = null;
      }
    }
    restoreAllInterceptedCommands(
      context,
      commands,
      count,
      frameNumber,
      pass,
      frustumSlice,
      targetKind,
      targetIdentity,
      fallbackPass,
    );
    return false;
  }
  const blendPipeline = withWebGPUPointCloudEDLFailOpen(
    () => {
      const pipeline = ensureBlendPipeline(
        cache,
        targetKind,
        targetFormat,
        sampleCount,
        targetCount,
      );
      if (!pipeline) {
        throw new Error("EDL composite resources are unavailable");
      }
      return pipeline;
    },
    {
      report: (error: unknown) =>
        reportWebGPUPointCloudEDLFailure(
          context,
          "Point-cloud EDL composite resources unavailable",
          error,
        ),
      restore: () => {
        let fallbackPass = getCurrentRenderPass(context);
        if (!fallbackPass) {
          try {
            fallbackPass = resumeTargetPass();
          } catch {
            fallbackPass = null;
          }
        }
        restoreAllInterceptedCommands(
          context,
          commands,
          count,
          frameNumber,
          pass,
          frustumSlice,
          targetKind,
          targetIdentity,
          fallbackPass,
        );
      },
    },
  );
  if (blendPipeline === false) {
    return false;
  }

  let allGroupsComposited = true;
  let afterOrder = -1;
  for (;;) {
    const selection = findNextProcessor(
      commands,
      count,
      frameNumber,
      pass,
      frustumSlice,
      targetKind,
      targetIdentity,
      afterOrder,
    );
    if (!selection) {
      break;
    }
    const { processor, updateOrder } = selection;
    afterOrder = updateOrder;

    let readyMetadata: WebGPUPointCloudEDLCommandMetadata | null = null;
    try {
      readyMetadata = getReadyProcessorGroupMetadata(
        cache,
        commands,
        count,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
      );
    } catch {
      readyMetadata = null;
    }
    if (!readyMetadata) {
      let currentPass = getCurrentRenderPass(context);
      if (!currentPass) {
        try {
          currentPass = resumeTargetPass();
        } catch {
          currentPass = null;
        }
      }
      restoreProcessorGroup(
        context,
        commands,
        count,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
        currentPass,
      );
      allGroupsComposited = false;
      continue;
    }

    // Reserve and stage a unique dynamic-uniform slice BEFORE disturbing the
    // live target pass. Ring exhaustion/misalignment is therefore a true
    // fail-open: the original group is restored without an offscreen replay.
    const blendBindGroup = acquireBlendUniformBinding(
      cache,
      readyMetadata,
      context,
    );
    if (!blendBindGroup) {
      restoreProcessorGroup(
        context,
        commands,
        count,
        frameNumber,
        pass,
        frustumSlice,
        targetKind,
        targetIdentity,
        processor,
        updateOrder,
        getCurrentRenderPass(context),
      );
      allGroupsComposited = false;
      continue;
    }

    let compositeEncoded = false;
    withWebGPUPointCloudEDLFailOpen(
      () => {
        endCurrentRenderPass(context);
        if (!cache.colorView || !cache.eyeDepthView || !cache.dsView) {
          throw new Error("EDL offscreen views are unavailable");
        }
        const offscreenPass = (
          context as unknown as {
            beginRenderPass?: (
              descriptor: GPURenderPassDescriptor,
            ) => GPURenderPassEncoder | null;
          }
        ).beginRenderPass?.({
          label: `PointCloudEDL offscreen group ${updateOrder}`,
          colorAttachments: [
            {
              view: cache.colorView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
            {
              view: cache.eyeDepthView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          depthStencilAttachment: {
            view: cache.dsView,
            depthClearValue: 1.0,
            depthLoadOp: "clear",
            depthStoreOp: "store",
            stencilClearValue: 0,
            stencilLoadOp: "clear",
            stencilStoreOp: "store",
          },
        });
        if (!offscreenPass) {
          throw new Error("EDL offscreen pass could not be opened");
        }
        offscreenPass.setViewport(0, 0, cache.width, cache.height, 0, 1);
        offscreenPass.setScissorRect(0, 0, cache.width, cache.height);
        const metadata = drawProcessorGroupOffscreen(
          cache,
          offscreenPass,
          commands,
          count,
          frameNumber,
          pass,
          frustumSlice,
          targetKind,
          targetIdentity,
          processor,
          updateOrder,
        );
        endCurrentRenderPass(context);
        if (!metadata) {
          throw new Error("EDL processor group became empty");
        }
        const targetPass = resumeTargetPass();
        if (!targetPass) {
          throw new Error("EDL target pass could not be resumed");
        }
        targetPass.setPipeline(blendPipeline);
        targetPass.setBindGroup(
          0,
          blendBindGroup,
          cache.blendDynamicOffsetScratch,
        );
        targetPass.setStencilReference(POINT_CLOUD_EDL_TILE_STENCIL_MASK);
        targetPass.draw(3, 1, 0, 0);
        // The stencil reference is PASS state, not pipeline state, so the
        // 3D-Tile bit set above would otherwise apply to every later draw in
        // the resumed pass. Nothing downstream reads that bit here today, so
        // there is no reachable defect; the reset keeps the leak from becoming
        // one when a stencil consumer is added, matching the defensive reset
        // WebGPUInvertClassification already performs on its own pass.
        targetPass.setStencilReference(0);
        compositeEncoded = true;
        restoreProcessorGroup(
          context,
          commands,
          count,
          frameNumber,
          pass,
          frustumSlice,
          targetKind,
          targetIdentity,
          processor,
          updateOrder,
          null,
        );
        return true;
      },
      {
        report: (error: unknown) =>
          reportWebGPUPointCloudEDLFailure(
            context,
            "Point-cloud EDL composite failed",
            error,
          ),
        restore: () => {
          allGroupsComposited = false;
          if (!compositeEncoded) {
            endCurrentRenderPass(context);
            let fallbackPass: GPURenderPassEncoder | null = null;
            try {
              fallbackPass = resumeTargetPass();
            } catch {
              // Restoring `enabled` is still required even if the target itself
              // disappeared during recovery. A later frustum/frame must not inherit
              // a command hidden by this failed slice.
            }
            restoreProcessorGroup(
              context,
              commands,
              count,
              frameNumber,
              pass,
              frustumSlice,
              targetKind,
              targetIdentity,
              processor,
              updateOrder,
              fallbackPass,
            );
          } else {
            restoreProcessorGroup(
              context,
              commands,
              count,
              frameNumber,
              pass,
              frustumSlice,
              targetKind,
              targetIdentity,
              processor,
              updateOrder,
              null,
            );
          }
        },
      },
    );
  }
  return allGroupsComposited;
}

/** Release full-resolution targets when no EDL group rendered this frame. */
export function finalizeWebGPUPointCloudEDLFrame(
  context: CesiumGraphicsContext,
  frameNumber: number,
): void {
  const cache = (context as unknown as EDLContextState)._pointCloudEDLCache;
  if (cache && shouldReleaseWebGPUPointCloudEDLTargets(cache, frameNumber)) {
    destroyEDLTextures(cache);
    cache.blendBindGroups = new WeakMap();
  }
}

/** Read the current frustum near plane (metres), with a safe fallback. */
function getFrustumNear(context: CesiumGraphicsContext): number {
  const cf = (
    context.uniformState as unknown as {
      currentFrustum?: { x: number; y: number };
    }
  ).currentFrustum;
  return cf?.x ?? 1.0;
}

/** Read the current frustum far plane (metres), with a safe fallback. */
function getFrustumFar(context: CesiumGraphicsContext): number {
  const cf = (
    context.uniformState as unknown as {
      currentFrustum?: { x: number; y: number };
    }
  ).currentFrustum;
  return cf?.y ?? 1.0e7;
}

/**
 * Release all EDL GPU resources. Called on toggle-off (via the WebGL
 * processor's `destroy`), viewport teardown, and device loss.
 */
function destroyWebGPUPointCloudEDLResources(
  processor: EDLProcessorLike,
  context?: CesiumGraphicsContext,
): void {
  const owningContext = context ?? processor._webgpuEDLContext ?? undefined;
  processor._webgpuEDLActive = false;
  processor._webgpuEDLContext = null;
  processor._webgpuEDLUpdateContext = null;
  if (!owningContext) {
    return;
  }
  releaseProcessorContextOwnership(processor, owningContext);
}

export { updateWebGPUPointCloudEDL, destroyWebGPUPointCloudEDLResources };
export default {
  updateWebGPUPointCloudEDL,
  prepareWebGPUPointCloudEDLCommands,
  renderWebGPUPointCloudEDLCommands,
  finalizeWebGPUPointCloudEDLFrame,
  destroyWebGPUPointCloudEDLResources,
};
