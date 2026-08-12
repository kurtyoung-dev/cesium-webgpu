/**
 * WebGPU IBL Pipeline — Irradiance + Radiance Compute Orchestrator
 *
 * Manages the compute shader pipeline for generating IBL cubemaps:
 * - Diffuse irradiance convolution (32×32 per face)
 * - Specular radiance prefiltering (128×128 base, 6 mip levels)
 *
 * These are one-time operations triggered when the environment map changes.
 * The generated textures are cached and reused until the source changes.
 *
 * For diffuse irradiance, CesiumJS also supports spherical harmonics (SH L2,
 * 9 coefficients × 3 channels). When SH coefficients are provided, the
 * irradiance cubemap convolution is skipped — SH evaluation in the fragment
 * shader is cheaper and sufficient for low-frequency diffuse lighting.
 *
 * @module WebGPUIBLPipeline
 */

// Inline WGSL for irradiance convolution (matches Compute/IrradianceConvolution.wgsl)
import IrradianceConvolutionWGSL from "../../Shaders/WebGPU/Compute/IrradianceConvolution.js";
import RadiancePrefilterWGSL from "../../Shaders/WebGPU/Compute/RadiancePrefilter.js";
import EnvCubeMipDownsampleWGSL from "../../Shaders/WebGPU/Compute/EnvCubeMipDownsample.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageTexture,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import type { PooledParameterBuffer } from "./WebGPUEnvironmentTargetPool.js";

const IRRADIANCE_SIZE = 32;
const RADIANCE_BASE_SIZE = 128;
const RADIANCE_MIP_LEVELS = 6; // log2(128) - 1, roughness 0..1

/**
 * Quality mode for the radiance prefilter. `'parity'`, the default, samples the
 * source cube at mip 0. `'high'` first box-downsamples the source cube into a
 * mip chain, then samples a GGX-pdf-derived LOD, which removes the bright-sun
 * firefly aliasing that mip-0 sampling produces at high roughness.
 *
 * Reference: Karis, "Real Shading in Unreal Engine 4" (SIGGRAPH 2013).
 */
type IBLPrefilterQuality = "parity" | "high";

interface IBLPipelineCache {
  /** Exact native ownership tuple for generation-aware shared kernels. */
  device?: GPUDevice;
  resourceGeneration?: number;
  /**
   * Dynamic environment maps overwrite a stable output bundle. Explicit
   * authored IBL leaves this false/undefined and retains its existing
   * replace-on-source-version lifecycle.
   */
  persistentOutputs?: boolean;
  /** Caller-owned topology token for the persistent output bundle. */
  outputTopologyKey?: string;
  activeOutputTopologyKey?: string;
  activeOutputDevice?: GPUDevice;
  activeOutputResourceGeneration?: number;
  irradianceTexture: GPUTexture | null;
  irradianceView: GPUTextureView | null;
  irradianceStorageView?: GPUTextureView | null;
  radianceTexture: GPUTexture | null;
  radianceView: GPUTextureView | null;
  radianceMipStorageViews?: GPUTextureView[];
  irradiancePipeline: GPUComputePipeline | null;
  radiancePipeline: GPUComputePipeline | null;
  irradianceBGL: GPUBindGroupLayout | null;
  radianceBGL: GPUBindGroupLayout | null;
  sampler: GPUSampler | null;
  sourceVersion: number;
  // The high-quality radiance pipeline (entry point `mainHQ`) and the
  // source-cube mip-chain downsample pipeline. Built lazily, only when
  // `quality === 'high'`, and null on the parity path so a parity build never
  // references the high-quality shaders.
  radianceHQPipeline?: GPUComputePipeline | null;
  radianceHQBGL?: GPUBindGroupLayout | null;
  mipDownsamplePipeline?: GPUComputePipeline | null;
  mipDownsampleBGL?: GPUBindGroupLayout | null;
  // Source-cube format the HQ downsample pipeline was built against (the
  // storage-texture format token is baked into the pipeline; rebuild when
  // the env cube flips between rgba8unorm/rgba16float).
  mipDownsampleFormat?: GPUTextureFormat;
  sourceMipViewState?: IBLSourceMipViewState | null;
  irradianceBindGroupState?: IBLDispatchBindGroupState | null;
  radianceBindGroupState?: IBLDispatchBindGroupState | null;
  mipDownsampleBindGroupState?: IBLDispatchBindGroupState | null;
  persistentParameterArena?: IBLPersistentParameterArena | null;
  pendingOutputTransaction?: IBLOutputTransaction | null;
  /**
   * Dynamic-manager retirement seam. Submitted textures can remain referenced
   * by later segments of the same logical frame, so managers route them through
   * WebGPUContext.scheduleTextureDestroy instead of destroying inline.
   */
  retireOutputTexture?: (texture: GPUTexture | null | undefined) => void;
}

interface IBLSourceMipViewState {
  sourceCube: GPUTexture;
  sourceFormat: GPUTextureFormat;
  mipLevelCount: number;
  sourceViews: GPUTextureView[];
  destinationViews: GPUTextureView[];
}

interface IBLDispatchBindGroupState {
  layout: GPUBindGroupLayout;
  source: object;
  outputs: object;
  sampler: GPUSampler;
  parameterBuffer: GPUBuffer;
  parameterAlignment: number;
  firstParameterOffset: number;
  groups: GPUBindGroup[];
}

/**
 * Command-encoding scope shared by every stage of one IBL refresh.
 *
 * Each dispatch receives an immutable, alignment-safe slice of one packed
 * parameter arena. The arena is uploaded once immediately before submission,
 * which avoids both per-dispatch buffer allocation and late-write aliasing.
 * The owner destroys the arena only after the command buffer has been queued.
 */
interface IBLCommandEncodingScope {
  encoder: GPUCommandEncoder;
  ownsEncoder: boolean;
  parameterBuffer: GPUBuffer;
  parameterBytes: ArrayBuffer;
  parameterWords: Uint32Array;
  parameterAlignment: number;
  parameterCapacity: number;
  parameterCount: number;
  parametersUploaded: boolean;
  destroyed: boolean;
  // When the arena came from the context-owned pool, teardown returns it
  // instead of destroying it. `null` selects the own-and-destroy lifetime, for
  // callers that have no pool such as specs and standalone entry points.
  parameterPool: IBLParameterArenaPool | null;
  parameterHandle: PooledParameterBuffer | null;
  persistentArena: IBLPersistentParameterArena | null;
  outputTransactions: IBLOutputTransaction[] | null;
}

interface IBLOutputTransaction {
  ownerCache: IBLPipelineCache;
  workingCache: IBLPipelineCache;
  commit(): void;
  rollback(commandsSubmitted?: boolean): void;
}

interface IBLPersistentParameterArena {
  device: GPUDevice;
  resourceGeneration: number;
  parameterBuffer: GPUBuffer;
  parameterBytes: ArrayBuffer;
  parameterWords: Uint32Array;
  parameterAlignment: number;
  parameterCapacity: number;
  parameterPool: IBLParameterArenaPool | null;
  parameterHandle: PooledParameterBuffer | null;
  inUse: boolean;
  destroyed: boolean;
}

/**
 * The minimal view of {@link WebGPUEnvironmentTargetPool} this module needs.
 * Structural, so the IBL pipeline keeps no dependency on the pool module.
 */
interface IBLParameterArenaPool {
  acquireParameterBuffer(
    byteLength: number,
    label: string,
  ): PooledParameterBuffer;
  releaseParameterBuffer(handle: PooledParameterBuffer | null): void;
}

function createIBLCommandEncodingScope(
  device: GPUDevice,
  label: string,
  parameterCapacity = 64,
  parameterPool: IBLParameterArenaPool | null = null,
  persistentArena: IBLPersistentParameterArena | null = null,
  borrowedEncoder: GPUCommandEncoder | null = null,
): IBLCommandEncodingScope {
  const minimumAlignment =
    device.limits?.minUniformBufferOffsetAlignment ?? 256;
  const parameterAlignment = Math.max(
    16,
    Math.ceil(minimumAlignment / 16) * 16,
  );
  const capacity = Math.max(1, Math.ceil(parameterCapacity));
  if (persistentArena !== null) {
    if (
      persistentArena.destroyed ||
      persistentArena.device !== device ||
      persistentArena.parameterAlignment !== parameterAlignment ||
      persistentArena.parameterCapacity < capacity
    ) {
      throw new Error("Persistent IBL parameter arena topology mismatch.");
    }
    if (persistentArena.inUse) {
      throw new Error("Persistent IBL parameter arena is already in use.");
    }
  }
  const byteLength = capacity * parameterAlignment;
  const parameterBytes =
    persistentArena?.parameterBytes ?? new ArrayBuffer(byteLength);
  let parameterHandle: PooledParameterBuffer | null = null;
  let parameterBuffer: GPUBuffer;
  let ownsParameterBuffer = false;
  try {
    parameterHandle =
      persistentArena === null && parameterPool !== null
        ? parameterPool.acquireParameterBuffer(
            byteLength,
            `${label} Parameters`,
          )
        : null;
    if (persistentArena !== null) {
      parameterBuffer = persistentArena.parameterBuffer;
    } else if (parameterHandle !== null) {
      parameterBuffer = parameterHandle.buffer;
    } else {
      parameterBuffer = device.createBuffer({
        label: `${label} Parameters`,
        size: byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      ownsParameterBuffer = true;
    }
    const encoder = borrowedEncoder ?? device.createCommandEncoder({ label });
    if (persistentArena !== null) {
      persistentArena.inUse = true;
    }
    return {
      encoder,
      ownsEncoder: borrowedEncoder === null,
      parameterBuffer,
      parameterBytes,
      parameterWords:
        persistentArena?.parameterWords ?? new Uint32Array(parameterBytes),
      parameterAlignment,
      parameterCapacity: capacity,
      parameterCount: 0,
      parametersUploaded: false,
      destroyed: false,
      parameterPool: parameterHandle !== null ? parameterPool : null,
      parameterHandle,
      persistentArena,
      outputTransactions: null,
    };
  } catch (error) {
    if (parameterHandle !== null) {
      try {
        parameterPool?.releaseParameterBuffer(parameterHandle);
      } catch {
        // Preserve the allocation/encoder failure that made the scope invalid.
      }
    } else if (ownsParameterBuffer) {
      try {
        parameterBuffer!.destroy();
      } catch {
        // Preserve the allocation/encoder failure that made the scope invalid.
      }
    }
    throw error;
  }
}

function createIBLPersistentParameterArena(
  device: GPUDevice,
  resourceGeneration: number,
  parameterCapacity: number,
  parameterPool: IBLParameterArenaPool | null,
  label: string,
): IBLPersistentParameterArena {
  const minimumAlignment =
    device.limits?.minUniformBufferOffsetAlignment ?? 256;
  const parameterAlignment = Math.max(
    16,
    Math.ceil(minimumAlignment / 16) * 16,
  );
  const capacity = Math.max(1, Math.ceil(parameterCapacity));
  const byteLength = capacity * parameterAlignment;
  const parameterBytes = new ArrayBuffer(byteLength);
  const parameterHandle =
    parameterPool?.acquireParameterBuffer(byteLength, `${label} Parameters`) ??
    null;
  let parameterBuffer: GPUBuffer;
  try {
    parameterBuffer =
      parameterHandle?.buffer ??
      device.createBuffer({
        label: `${label} Parameters`,
        size: byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
  } catch (error) {
    parameterPool?.releaseParameterBuffer(parameterHandle);
    throw error;
  }
  return {
    device,
    resourceGeneration,
    parameterBuffer,
    parameterBytes,
    parameterWords: new Uint32Array(parameterBytes),
    parameterAlignment,
    parameterCapacity: capacity,
    parameterPool: parameterHandle !== null ? parameterPool : null,
    parameterHandle,
    inUse: false,
    destroyed: false,
  };
}

function getOrCreateIBLPersistentParameterArena(
  device: GPUDevice,
  resourceGeneration: number,
  cache: IBLPipelineCache,
  parameterCapacity: number,
  parameterPool: IBLParameterArenaPool | null,
  label: string,
): IBLPersistentParameterArena {
  const current = cache.persistentParameterArena;
  if (
    current &&
    !current.destroyed &&
    current.device === device &&
    current.resourceGeneration === resourceGeneration &&
    current.parameterCapacity >= parameterCapacity
  ) {
    return current;
  }
  if (current?.inUse) {
    throw new Error(
      "Cannot replace a persistent IBL parameter arena while it is in use.",
    );
  }

  const candidate = createIBLPersistentParameterArena(
    device,
    resourceGeneration,
    parameterCapacity,
    parameterPool,
    label,
  );
  cache.persistentParameterArena = candidate;
  cache.irradianceBindGroupState = null;
  cache.radianceBindGroupState = null;
  cache.mipDownsampleBindGroupState = null;
  try {
    destroyIBLPersistentParameterArena(current ?? null);
  } catch {
    // The candidate is already authoritative. A stale lease retirement failure
    // must not roll the cache back to an incompatible generation.
  }
  return candidate;
}

function destroyIBLPersistentParameterArena(
  arena: IBLPersistentParameterArena | null,
): void {
  if (arena === null || arena.destroyed) {
    return;
  }
  arena.inUse = false;
  arena.destroyed = true;
  if (arena.parameterPool !== null && arena.parameterHandle !== null) {
    arena.parameterPool.releaseParameterBuffer(arena.parameterHandle);
    arena.parameterHandle = null;
    arena.parameterPool = null;
    return;
  }
  arena.parameterBuffer.destroy();
}

function allocateIBLParameterBinding(
  scope: IBLCommandEncodingScope,
  value0: number,
  value1: number,
  value2: number,
  value3: number,
): GPUBufferBinding {
  if (scope.parametersUploaded) {
    throw new Error("IBL parameters cannot change after upload.");
  }
  if (scope.parameterCount >= scope.parameterCapacity) {
    throw new Error("IBL command parameter arena exhausted.");
  }
  const offset = scope.parameterCount * scope.parameterAlignment;
  const wordOffset = offset / Uint32Array.BYTES_PER_ELEMENT;
  const words = scope.parameterWords;
  words[wordOffset] = value0;
  words[wordOffset + 1] = value1;
  words[wordOffset + 2] = value2;
  words[wordOffset + 3] = value3;
  scope.parameterCount++;
  return {
    buffer: scope.parameterBuffer,
    offset,
    size: 16,
  };
}

function settleIBLCommandEncodingScope(
  scope: IBLCommandEncodingScope,
  commit: boolean,
  commandsSubmitted = commit,
): void {
  if (scope.destroyed) {
    return;
  }
  scope.destroyed = true;
  settleIBLOutputTransactions(scope, commit, commandsSubmitted);
  if (scope.persistentArena !== null) {
    scope.persistentArena.inUse = false;
    scope.persistentArena = null;
    return;
  }
  // Returning to the pool before submit is safe: WebGPU keeps a buffer alive
  // for commands already recorded against it unless `destroy()` is called, and
  // the pool never destroys an entry used on the current frame.
  if (scope.parameterPool !== null && scope.parameterHandle !== null) {
    scope.parameterPool.releaseParameterBuffer(scope.parameterHandle);
    scope.parameterHandle = null;
    scope.parameterPool = null;
    return;
  }
  scope.parameterBuffer.destroy();
}

function destroyIBLCommandEncodingScope(scope: IBLCommandEncodingScope): void {
  settleIBLCommandEncodingScope(scope, false);
}

function registerIBLOutputTransaction(
  scope: IBLCommandEncodingScope,
  transaction: IBLOutputTransaction,
): void {
  if (
    scope.outputTransactions?.some(
      (pending) => pending.ownerCache === transaction.ownerCache,
    )
  ) {
    transaction.rollback();
    throw new Error(
      "Persistent IBL cache already has a transaction in this encoding scope.",
    );
  }
  (scope.outputTransactions ??= []).push(transaction);
}

function settleIBLOutputTransactions(
  scope: IBLCommandEncodingScope,
  commit: boolean,
  commandsSubmitted = commit,
): void {
  const transactions = scope.outputTransactions;
  scope.outputTransactions = null;
  if (transactions === null) {
    return;
  }
  for (const transaction of transactions) {
    try {
      if (commit) {
        transaction.commit();
      } else {
        transaction.rollback(commandsSubmitted);
      }
    } catch {
      // Transaction settlement is fail-safe: native cleanup must not strand
      // later candidates or keep a retained arena marked in-use.
    }
  }
}

function submitIBLCommandEncodingScope(
  device: GPUDevice,
  scope: IBLCommandEncodingScope,
): void {
  if (!scope.ownsEncoder) {
    throw new Error("A borrowed IBL encoder must be submitted by its frame.");
  }
  try {
    uploadIBLCommandEncodingScopeParameters(device, scope);
    device.queue.submit([scope.encoder.finish()]);
    settleIBLCommandEncodingScope(scope, true);
  } catch (error) {
    settleIBLCommandEncodingScope(scope, false);
    throw error;
  }
}

function uploadIBLCommandEncodingScopeParameters(
  device: GPUDevice,
  scope: IBLCommandEncodingScope,
): void {
  if (scope.destroyed) {
    throw new Error("Cannot upload a destroyed IBL encoding scope.");
  }
  if (scope.parametersUploaded) {
    return;
  }
  if (scope.parameterCount > 0) {
    device.queue.writeBuffer(
      scope.parameterBuffer,
      0,
      scope.parameterBytes,
      0,
      scope.parameterCount * scope.parameterAlignment,
    );
  }
  scope.parametersUploaded = true;
}

interface IBLSharedKernel {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
}

interface IBLDeviceKernelPack {
  resourceGeneration: number;
  irradiance: IBLSharedKernel | null;
  radiance: IBLSharedKernel | null;
  radianceHQ: IBLSharedKernel | null;
  sampler: GPUSampler | null;
}

let iblKernelPacks = new WeakMap<GPUDevice, IBLDeviceKernelPack>();

function getIBLDeviceKernelPack(
  device: GPUDevice,
  resourceGeneration = 0,
): IBLDeviceKernelPack {
  let pack = iblKernelPacks.get(device);
  if (!pack || pack.resourceGeneration !== resourceGeneration) {
    pack = {
      resourceGeneration,
      irradiance: null,
      radiance: null,
      radianceHQ: null,
      sampler: null,
    };
    iblKernelPacks.set(device, pack);
  }
  return pack;
}

function resetIBLDeviceKernelPacksForSpecs(): void {
  iblKernelPacks = new WeakMap<GPUDevice, IBLDeviceKernelPack>();
}

/**
 * Creates the compute pipeline for irradiance convolution.
 *
 * Routes through the central cache when one is supplied, and creates
 * synchronously otherwise.
 */
function createIrradiancePipeline(
  device: GPUDevice,
  computePipelineCache:
    import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache | null,
  resourceGeneration = 0,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const shared = getIBLDeviceKernelPack(device, resourceGeneration);
  if (shared.irradiance) {
    return shared.irradiance;
  }

  const bgl = makeBindGroupLayout(device, "IBL-Irradiance-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: IrradianceConvolutionWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Irradiance",
        layout,
        compute: { module, entryPoint: "main" },
      })
    : device.createComputePipeline({
        label: "IBL-Irradiance",
        layout,
        compute: { module, entryPoint: "main" },
      });

  shared.irradiance = { pipeline, bgl };
  return shared.irradiance;
}

/**
 * Creates the compute pipeline for radiance prefiltering.
 */
function createRadiancePipeline(
  device: GPUDevice,
  computePipelineCache:
    import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache | null,
  resourceGeneration = 0,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const shared = getIBLDeviceKernelPack(device, resourceGeneration);
  if (shared.radiance) {
    return shared.radiance;
  }

  const bgl = makeBindGroupLayout(device, "IBL-Radiance-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: RadiancePrefilterWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Radiance",
        layout,
        compute: { module, entryPoint: "main" },
      })
    : device.createComputePipeline({
        label: "IBL-Radiance",
        layout,
        compute: { module, entryPoint: "main" },
      });

  shared.radiance = { pipeline, bgl };
  return shared.radiance;
}

/**
 * Creates the high-quality radiance prefilter pipeline: an identical bind-group
 * layout to the parity pipeline, compiled against the `mainHQ` entry point,
 * which samples the source cube at a GGX-pdf-derived LOD. Built only when
 * `quality === 'high'`.
 */
function createRadianceHQPipeline(
  device: GPUDevice,
  computePipelineCache:
    import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache | null,
  resourceGeneration = 0,
): {
  pipeline: GPUComputePipeline;
  bgl: GPUBindGroupLayout;
} {
  const shared = getIBLDeviceKernelPack(device, resourceGeneration);
  if (shared.radianceHQ) {
    return shared.radianceHQ;
  }

  const bgl = makeBindGroupLayout(device, "IBL-Radiance-HQ-BGL", [
    texture(0, Stage.COMPUTE, { viewDimension: "cube" }),
    sampler(1, Stage.COMPUTE),
    storageTexture(2, Stage.COMPUTE, "rgba16float", {
      viewDimension: "2d-array",
    }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);

  const module = device.createShaderModule({ code: RadiancePrefilterWGSL });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeline = computePipelineCache
    ? computePipelineCache.getOrCreateSync({
        name: "IBL-Radiance-HQ",
        layout,
        compute: { module, entryPoint: "mainHQ" },
      })
    : device.createComputePipeline({
        label: "IBL-Radiance-HQ",
        layout,
        compute: { module, entryPoint: "mainHQ" },
      });

  shared.radianceHQ = { pipeline, bgl };
  return shared.radianceHQ;
}

/**
 * Box-downsamples the source environment cube into its already-allocated mip
 * chain (mips 1..N from mip 0), so the high-quality prefilter has a real LOD to
 * sample. One dispatch per destination mip level.
 *
 * The storage-texture format token must match the source cube format —
 * rgba8unorm for LDR, rgba16float for HDR. The WGSL declares rgba16float and is
 * string-swapped to rgba8unorm when the source is LDR.
 *
 * @returns true if a mip chain was generated, i.e. the source has >1 mip level.
 */
function dispatchSourceCubeMipChain(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCube: GPUTexture,
  sourceFormat: GPUTextureFormat,
  encodingScope: IBLCommandEncodingScope,
): boolean {
  const mipLevelCount = sourceCube.mipLevelCount;
  if (mipLevelCount <= 1) {
    return false;
  }

  // Rebuild the pipeline if the format flipped (the storage format token is
  // baked into the BGL + shader module).
  if (
    !cache.mipDownsamplePipeline ||
    !cache.mipDownsampleBGL ||
    cache.mipDownsampleFormat !== sourceFormat
  ) {
    cache.mipDownsampleBGL = makeBindGroupLayout(
      device,
      "IBL-EnvMipDownsample-BGL",
      [
        texture(0, Stage.COMPUTE, { viewDimension: "2d-array" }),
        sampler(1, Stage.COMPUTE),
        storageTexture(2, Stage.COMPUTE, sourceFormat, {
          viewDimension: "2d-array",
        }),
        uniformBuffer(3, Stage.COMPUTE),
      ],
    );
    const code =
      sourceFormat === "rgba16float"
        ? EnvCubeMipDownsampleWGSL
        : EnvCubeMipDownsampleWGSL.replace(
            "texture_storage_2d_array<rgba16float, write>",
            `texture_storage_2d_array<${sourceFormat}, write>`,
          );
    const module = device.createShaderModule({
      label: "EnvCubeMipDownsample",
      code,
    });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [cache.mipDownsampleBGL],
    });
    cache.mipDownsamplePipeline = device.createComputePipeline({
      label: "IBL-EnvMipDownsample",
      layout,
      compute: { module, entryPoint: "main" },
    });
    cache.mipDownsampleFormat = sourceFormat;
    cache.mipDownsampleBindGroupState = null;
  }

  if (!cache.sampler) {
    const shared = getIBLDeviceKernelPack(
      device,
      cache.resourceGeneration ?? 0,
    );
    shared.sampler ??= device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    cache.sampler = shared.sampler;
  }

  const baseSize = sourceCube.width;
  const encoder = encodingScope.encoder;

  let sourceViews: GPUTextureView[];
  let destinationViews: GPUTextureView[];
  const viewState = cache.sourceMipViewState;
  if (
    cache.persistentOutputs &&
    viewState?.sourceCube === sourceCube &&
    viewState.sourceFormat === sourceFormat &&
    viewState.mipLevelCount === mipLevelCount
  ) {
    sourceViews = viewState.sourceViews;
    destinationViews = viewState.destinationViews;
  } else {
    const candidateSourceViews: GPUTextureView[] = [];
    const candidateDestinationViews: GPUTextureView[] = [];
    for (let mip = 1; mip < mipLevelCount; mip++) {
      candidateSourceViews.push(
        sourceCube.createView({
          dimension: "2d-array",
          baseMipLevel: mip - 1,
          mipLevelCount: 1,
          arrayLayerCount: 6,
          baseArrayLayer: 0,
        }),
      );
      candidateDestinationViews.push(
        sourceCube.createView({
          dimension: "2d-array",
          baseMipLevel: mip,
          mipLevelCount: 1,
          arrayLayerCount: 6,
          baseArrayLayer: 0,
        }),
      );
    }
    sourceViews = candidateSourceViews;
    destinationViews = candidateDestinationViews;
    if (cache.persistentOutputs) {
      cache.sourceMipViewState = {
        sourceCube,
        sourceFormat,
        mipLevelCount,
        sourceViews,
        destinationViews,
      };
      cache.mipDownsampleBindGroupState = null;
    }
  }

  const parameterBindings: GPUBufferBinding[] = [];
  for (let mip = 1; mip < mipLevelCount; mip++) {
    parameterBindings.push(
      allocateIBLParameterBinding(
        encodingScope,
        Math.max(1, baseSize >> mip),
        0,
        0,
        0,
      ),
    );
  }

  let bindGroups: GPUBindGroup[];
  const state = cache.mipDownsampleBindGroupState;
  const firstParameterOffset = parameterBindings[0].offset ?? 0;
  if (
    cache.persistentOutputs &&
    state?.layout === cache.mipDownsampleBGL &&
    state.source === sourceViews &&
    state.outputs === destinationViews &&
    state.sampler === cache.sampler &&
    state.parameterBuffer === encodingScope.parameterBuffer &&
    state.parameterAlignment === encodingScope.parameterAlignment &&
    state.firstParameterOffset === firstParameterOffset
  ) {
    bindGroups = state.groups;
  } else {
    const layout = cache.mipDownsampleBGL!;
    bindGroups = parameterBindings.map((paramsBinding, index) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sourceViews[index] },
          { binding: 1, resource: cache.sampler! },
          { binding: 2, resource: destinationViews[index] },
          { binding: 3, resource: paramsBinding },
        ],
      }),
    );
    if (cache.persistentOutputs) {
      cache.mipDownsampleBindGroupState = {
        layout,
        source: sourceViews,
        outputs: destinationViews,
        sampler: cache.sampler!,
        parameterBuffer: encodingScope.parameterBuffer,
        parameterAlignment: encodingScope.parameterAlignment,
        firstParameterOffset,
        groups: bindGroups,
      };
    }
  }

  for (let mip = 1; mip < mipLevelCount; mip++) {
    const dstSize = Math.max(1, baseSize >> mip);

    const pass = encoder.beginComputePass();
    pass.setPipeline(cache.mipDownsamplePipeline);
    pass.setBindGroup(0, bindGroups[mip - 1]);
    pass.dispatchWorkgroups(Math.ceil(dstSize / 8), Math.ceil(dstSize / 8), 6);
    pass.end();
  }

  return true;
}

/**
 * Dispatches irradiance convolution for all 6 cubemap faces.
 */
function dispatchIrradianceConvolution(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
  encodingScope?: IBLCommandEncodingScope,
): void {
  const ownsEncodingScope = !encodingScope;
  const scope =
    encodingScope ??
    createIBLCommandEncodingScope(device, "IBL Irradiance Refresh", 6);
  if (!cache.irradiancePipeline || !cache.irradianceBGL) {
    const result = createIrradiancePipeline(
      device,
      computePipelineCache,
      cache.resourceGeneration ?? 0,
    );
    cache.irradiancePipeline = result.pipeline;
    cache.irradianceBGL = result.bgl;
  }

  let outputArrayView: GPUTextureView;
  if (cache.persistentOutputs) {
    outputArrayView = cache.irradianceStorageView!;
  } else {
    // Explicit-source IBL retains its replace-on-source-version lifecycle.
    if (cache.irradianceTexture) {
      cache.irradianceTexture.destroy();
    }
    cache.irradianceTexture = device.createTexture({
      size: {
        width: IRRADIANCE_SIZE,
        height: IRRADIANCE_SIZE,
        depthOrArrayLayers: 6,
      },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      dimension: "2d",
    });
    cache.irradianceView = cache.irradianceTexture.createView({
      dimension: "cube",
    });
    outputArrayView = cache.irradianceTexture.createView({
      dimension: "2d-array",
      arrayLayerCount: 6,
      baseArrayLayer: 0,
    });
  }

  const encoder = scope.encoder;

  const parameterBindings: GPUBufferBinding[] = [];
  for (let face = 0; face < 6; face++) {
    parameterBindings.push(
      allocateIBLParameterBinding(scope, face, IRRADIANCE_SIZE, 0, 0),
    );
  }

  let bindGroups: GPUBindGroup[];
  const state = cache.irradianceBindGroupState;
  const firstParameterOffset = parameterBindings[0].offset ?? 0;
  if (
    cache.persistentOutputs &&
    state?.layout === cache.irradianceBGL &&
    state.source === sourceCubeView &&
    state.outputs === outputArrayView &&
    state.sampler === cache.sampler &&
    state.parameterBuffer === scope.parameterBuffer &&
    state.parameterAlignment === scope.parameterAlignment &&
    state.firstParameterOffset === firstParameterOffset
  ) {
    bindGroups = state.groups;
  } else {
    bindGroups = parameterBindings.map((paramsBinding) =>
      device.createBindGroup({
        layout: cache.irradianceBGL!,
        entries: [
          { binding: 0, resource: sourceCubeView },
          { binding: 1, resource: cache.sampler! },
          { binding: 2, resource: outputArrayView },
          { binding: 3, resource: paramsBinding },
        ],
      }),
    );
    if (cache.persistentOutputs) {
      cache.irradianceBindGroupState = {
        layout: cache.irradianceBGL!,
        source: sourceCubeView,
        outputs: outputArrayView,
        sampler: cache.sampler!,
        parameterBuffer: scope.parameterBuffer,
        parameterAlignment: scope.parameterAlignment,
        firstParameterOffset,
        groups: bindGroups,
      };
    }
  }

  for (let face = 0; face < 6; face++) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(cache.irradiancePipeline!);
    pass.setBindGroup(0, bindGroups[face]);
    pass.dispatchWorkgroups(
      Math.ceil(IRRADIANCE_SIZE / 8),
      Math.ceil(IRRADIANCE_SIZE / 8),
    );
    pass.end();
  }

  if (ownsEncodingScope) {
    submitIBLCommandEncodingScope(device, scope);
  }
}

/**
 * Optional high-quality inputs for `dispatchRadiancePrefilter` and
 * `generateIBLMaps`. Undefined, or `'parity'`, keeps the mip-0 sample with no
 * downsample.
 */
interface RadianceHQOptions {
  quality?: IBLPrefilterQuality;
  /** The source env cube texture (needed to populate its mip chain). */
  sourceCube?: GPUTexture | null;
  /** The source env cube format (rgba8unorm LDR / rgba16float HDR). */
  sourceFormat?: GPUTextureFormat;
}

function getIBLRefreshParameterCapacity(hqOptions?: RadianceHQOptions): number {
  const sourceMipJobs =
    hqOptions?.quality === "high" && hqOptions.sourceCube
      ? Math.max(0, hqOptions.sourceCube.mipLevelCount - 1)
      : 0;
  return 6 + RADIANCE_MIP_LEVELS * 6 + sourceMipJobs;
}

interface IBLPersistentOutputCandidate {
  irradianceTexture: GPUTexture;
  irradianceView: GPUTextureView;
  irradianceStorageView: GPUTextureView;
  radianceTexture: GPUTexture;
  radianceView: GPUTextureView;
  radianceMipStorageViews: GPUTextureView[];
}

function destroyTextureBestEffort(texture: GPUTexture | null): void {
  if (texture === null) {
    return;
  }
  try {
    texture.destroy();
  } catch {
    // A failed retirement must not roll back an already-published candidate.
  }
}

function retireIBLTexture(
  cache: IBLPipelineCache,
  texture: GPUTexture | null,
  commandsSubmitted: boolean,
): void {
  if (texture === null) {
    return;
  }
  if (commandsSubmitted && cache.retireOutputTexture) {
    try {
      cache.retireOutputTexture(texture);
      return;
    } catch {
      // Fall through to best-effort native retirement if the owner seam fails.
    }
  }
  destroyTextureBestEffort(texture);
}

function createPersistentIBLOutputCandidate(
  device: GPUDevice,
): IBLPersistentOutputCandidate {
  let irradianceTexture: GPUTexture | null = null;
  let radianceTexture: GPUTexture | null = null;
  try {
    irradianceTexture = device.createTexture({
      label: "Dynamic IBL Irradiance",
      size: {
        width: IRRADIANCE_SIZE,
        height: IRRADIANCE_SIZE,
        depthOrArrayLayers: 6,
      },
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      dimension: "2d",
    });
    const irradianceView = irradianceTexture.createView({
      label: "Dynamic IBL Irradiance Cube View",
      dimension: "cube",
    });
    const irradianceStorageView = irradianceTexture.createView({
      label: "Dynamic IBL Irradiance Storage View",
      dimension: "2d-array",
      arrayLayerCount: 6,
      baseArrayLayer: 0,
    });

    radianceTexture = device.createTexture({
      label: "Dynamic IBL Radiance",
      size: {
        width: RADIANCE_BASE_SIZE,
        height: RADIANCE_BASE_SIZE,
        depthOrArrayLayers: 6,
      },
      format: "rgba16float",
      mipLevelCount: RADIANCE_MIP_LEVELS,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
      dimension: "2d",
    });
    const radianceView = radianceTexture.createView({
      label: "Dynamic IBL Radiance Cube View",
      dimension: "cube",
      mipLevelCount: RADIANCE_MIP_LEVELS,
    });
    const radianceMipStorageViews: GPUTextureView[] = [];
    for (let mip = 0; mip < RADIANCE_MIP_LEVELS; mip++) {
      radianceMipStorageViews.push(
        radianceTexture.createView({
          label: `Dynamic IBL Radiance Mip ${mip} Storage View`,
          dimension: "2d-array",
          baseMipLevel: mip,
          mipLevelCount: 1,
          arrayLayerCount: 6,
          baseArrayLayer: 0,
        }),
      );
    }
    return {
      irradianceTexture,
      irradianceView,
      irradianceStorageView,
      radianceTexture,
      radianceView,
      radianceMipStorageViews,
    };
  } catch (error) {
    destroyTextureBestEffort(radianceTexture);
    destroyTextureBestEffort(irradianceTexture);
    throw error;
  }
}

function preparePersistentIBLOutputs(
  device: GPUDevice,
  cache: IBLPipelineCache,
): IBLOutputTransaction | null {
  if (!cache.persistentOutputs) {
    return null;
  }
  if (cache.pendingOutputTransaction) {
    throw new Error("Persistent IBL cache already has a pending transaction.");
  }
  const topologyKey = cache.outputTopologyKey ?? "default";
  if (
    cache.activeOutputDevice === device &&
    cache.activeOutputResourceGeneration === (cache.resourceGeneration ?? 0) &&
    cache.activeOutputTopologyKey === topologyKey &&
    cache.irradianceTexture !== null &&
    cache.irradianceView !== null &&
    cache.irradianceStorageView != null &&
    cache.radianceTexture !== null &&
    cache.radianceView !== null &&
    cache.radianceMipStorageViews?.length === RADIANCE_MIP_LEVELS
  ) {
    return null;
  }

  const candidate = createPersistentIBLOutputCandidate(device);
  const oldIrradiance = cache.irradianceTexture;
  const oldRadiance = cache.radianceTexture;
  const workingCache: IBLPipelineCache = {
    ...cache,
    irradianceTexture: candidate.irradianceTexture,
    irradianceView: candidate.irradianceView,
    irradianceStorageView: candidate.irradianceStorageView,
    radianceTexture: candidate.radianceTexture,
    radianceView: candidate.radianceView,
    radianceMipStorageViews: candidate.radianceMipStorageViews,
    activeOutputDevice: device,
    activeOutputResourceGeneration: cache.resourceGeneration ?? 0,
    activeOutputTopologyKey: topologyKey,
    irradianceBindGroupState: null,
    radianceBindGroupState: null,
    mipDownsampleBindGroupState: null,
    sourceMipViewState: null,
  };
  let settled = false;
  const transaction: IBLOutputTransaction = {
    ownerCache: cache,
    workingCache,
    commit(): void {
      if (settled) {
        return;
      }
      settled = true;
      if (cache.pendingOutputTransaction === transaction) {
        cache.pendingOutputTransaction = null;
      }

      // Publish the complete graph only after write/finish/submit accepted the
      // commands that initialize it. Immutable pipeline/sampler state built
      // while encoding follows the graph in the same atomic publication.
      cache.irradianceTexture = workingCache.irradianceTexture;
      cache.irradianceView = workingCache.irradianceView;
      cache.irradianceStorageView = workingCache.irradianceStorageView;
      cache.radianceTexture = workingCache.radianceTexture;
      cache.radianceView = workingCache.radianceView;
      cache.radianceMipStorageViews = workingCache.radianceMipStorageViews;
      cache.activeOutputDevice = workingCache.activeOutputDevice;
      cache.activeOutputResourceGeneration =
        workingCache.activeOutputResourceGeneration;
      cache.activeOutputTopologyKey = workingCache.activeOutputTopologyKey;
      cache.irradiancePipeline = workingCache.irradiancePipeline;
      cache.irradianceBGL = workingCache.irradianceBGL;
      cache.radiancePipeline = workingCache.radiancePipeline;
      cache.radianceBGL = workingCache.radianceBGL;
      cache.radianceHQPipeline = workingCache.radianceHQPipeline;
      cache.radianceHQBGL = workingCache.radianceHQBGL;
      cache.mipDownsamplePipeline = workingCache.mipDownsamplePipeline;
      cache.mipDownsampleBGL = workingCache.mipDownsampleBGL;
      cache.mipDownsampleFormat = workingCache.mipDownsampleFormat;
      cache.sampler = workingCache.sampler;
      cache.sourceMipViewState = workingCache.sourceMipViewState;
      cache.irradianceBindGroupState = workingCache.irradianceBindGroupState;
      cache.radianceBindGroupState = workingCache.radianceBindGroupState;
      cache.mipDownsampleBindGroupState =
        workingCache.mipDownsampleBindGroupState;

      retireIBLTexture(cache, oldRadiance, true);
      retireIBLTexture(cache, oldIrradiance, true);
    },
    rollback(commandsSubmitted = false): void {
      if (settled) {
        return;
      }
      settled = true;
      if (cache.pendingOutputTransaction === transaction) {
        cache.pendingOutputTransaction = null;
      }
      retireIBLTexture(cache, candidate.radianceTexture, commandsSubmitted);
      retireIBLTexture(cache, candidate.irradianceTexture, commandsSubmitted);
    },
  };
  cache.pendingOutputTransaction = transaction;
  return transaction;
}

function destroyPersistentIBLPipelineResources(cache: IBLPipelineCache): void {
  const irradianceTexture = cache.irradianceTexture;
  const radianceTexture = cache.radianceTexture;
  const parameterArena = cache.persistentParameterArena ?? null;
  const pendingOutputTransaction = cache.pendingOutputTransaction ?? null;

  // Detach every public alias before touching native resources so an
  // exceptional destroy/release cannot leave a half-live cache graph.
  cache.irradianceTexture = null;
  cache.irradianceView = null;
  cache.irradianceStorageView = null;
  cache.radianceTexture = null;
  cache.radianceView = null;
  cache.radianceMipStorageViews = undefined;
  cache.activeOutputDevice = undefined;
  cache.activeOutputResourceGeneration = undefined;
  cache.activeOutputTopologyKey = undefined;
  cache.sourceMipViewState = null;
  cache.irradianceBindGroupState = null;
  cache.radianceBindGroupState = null;
  cache.mipDownsampleBindGroupState = null;
  cache.persistentParameterArena = null;
  cache.pendingOutputTransaction = null;

  pendingOutputTransaction?.rollback();
  retireIBLTexture(cache, radianceTexture, true);
  retireIBLTexture(cache, irradianceTexture, true);
  try {
    destroyIBLPersistentParameterArena(parameterArena);
  } catch {
    // Continue with a fully detached cache even if a pool implementation fails.
  }
}

/**
 * Dispatches radiance prefiltering for all 6 faces × N mip levels.
 */
function dispatchRadiancePrefilter(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
  hqOptions?: RadianceHQOptions,
  encodingScope?: IBLCommandEncodingScope,
): void {
  const ownsEncodingScope = !encodingScope;
  const scope =
    encodingScope ??
    createIBLCommandEncodingScope(
      device,
      "IBL Radiance Refresh",
      getIBLRefreshParameterCapacity(hqOptions) - 6,
    );
  // Item 1.3 — high-quality path: box-downsample the source cube into its
  // mip chain, then select the `mainHQ` pipeline (GGX-pdf LOD sampling).
  // Falls back to the parity pipeline if the source has no extra mips.
  const wantsHQ = hqOptions?.quality === "high";
  let useHQ = false;
  if (wantsHQ && hqOptions?.sourceCube) {
    const fmt = hqOptions.sourceFormat ?? "rgba8unorm";
    const built = dispatchSourceCubeMipChain(
      device,
      cache,
      hqOptions.sourceCube,
      fmt,
      scope,
    );
    if (built) {
      if (!cache.radianceHQPipeline || !cache.radianceHQBGL) {
        const result = createRadianceHQPipeline(
          device,
          computePipelineCache,
          cache.resourceGeneration ?? 0,
        );
        cache.radianceHQPipeline = result.pipeline;
        cache.radianceHQBGL = result.bgl;
      }
      useHQ = true;
    }
  }

  if (!cache.radiancePipeline || !cache.radianceBGL) {
    const result = createRadiancePipeline(
      device,
      computePipelineCache,
      cache.resourceGeneration ?? 0,
    );
    cache.radiancePipeline = result.pipeline;
    cache.radianceBGL = result.bgl;
  }

  let outputMipViews: GPUTextureView[];
  if (cache.persistentOutputs) {
    outputMipViews = cache.radianceMipStorageViews!;
  } else {
    // Explicit-source IBL retains its replace-on-source-version lifecycle.
    if (cache.radianceTexture) {
      cache.radianceTexture.destroy();
    }
    cache.radianceTexture = device.createTexture({
      size: {
        width: RADIANCE_BASE_SIZE,
        height: RADIANCE_BASE_SIZE,
        depthOrArrayLayers: 6,
      },
      format: "rgba16float",
      mipLevelCount: RADIANCE_MIP_LEVELS,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
      dimension: "2d",
    });
    cache.radianceView = cache.radianceTexture.createView({
      dimension: "cube",
      mipLevelCount: RADIANCE_MIP_LEVELS,
    });
    outputMipViews = [];
    for (let mip = 0; mip < RADIANCE_MIP_LEVELS; mip++) {
      outputMipViews.push(
        cache.radianceTexture.createView({
          dimension: "2d-array",
          baseMipLevel: mip,
          mipLevelCount: 1,
          arrayLayerCount: 6,
          baseArrayLayer: 0,
        }),
      );
    }
  }

  const encoder = scope.encoder;
  const parameterBindings: GPUBufferBinding[] = [];

  for (let mip = 0; mip < RADIANCE_MIP_LEVELS; mip++) {
    const mipSize = RADIANCE_BASE_SIZE >> mip;
    for (let face = 0; face < 6; face++) {
      parameterBindings.push(
        allocateIBLParameterBinding(
          scope,
          face,
          mip,
          RADIANCE_MIP_LEVELS,
          mipSize,
        ),
      );
    }
  }

  const layout = useHQ ? cache.radianceHQBGL! : cache.radianceBGL!;
  const pipeline = useHQ ? cache.radianceHQPipeline! : cache.radiancePipeline!;
  const state = cache.radianceBindGroupState;
  const firstParameterOffset = parameterBindings[0].offset ?? 0;
  let bindGroups: GPUBindGroup[];
  if (
    cache.persistentOutputs &&
    state?.layout === layout &&
    state.source === sourceCubeView &&
    state.outputs === outputMipViews &&
    state.sampler === cache.sampler &&
    state.parameterBuffer === scope.parameterBuffer &&
    state.parameterAlignment === scope.parameterAlignment &&
    state.firstParameterOffset === firstParameterOffset
  ) {
    bindGroups = state.groups;
  } else {
    bindGroups = parameterBindings.map((paramsBinding, index) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sourceCubeView },
          { binding: 1, resource: cache.sampler! },
          {
            binding: 2,
            resource: outputMipViews[Math.floor(index / 6)],
          },
          { binding: 3, resource: paramsBinding },
        ],
      }),
    );
    if (cache.persistentOutputs) {
      cache.radianceBindGroupState = {
        layout,
        source: sourceCubeView,
        outputs: outputMipViews,
        sampler: cache.sampler!,
        parameterBuffer: scope.parameterBuffer,
        parameterAlignment: scope.parameterAlignment,
        firstParameterOffset,
        groups: bindGroups,
      };
    }
  }

  for (let mip = 0; mip < RADIANCE_MIP_LEVELS; mip++) {
    const mipSize = RADIANCE_BASE_SIZE >> mip;
    for (let face = 0; face < 6; face++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroups[mip * 6 + face]);
      pass.dispatchWorkgroups(Math.ceil(mipSize / 8), Math.ceil(mipSize / 8));
      pass.end();
    }
  }

  if (ownsEncodingScope) {
    submitIBLCommandEncodingScope(device, scope);
  }
}

/**
 * Packs 9 L2 spherical harmonic coefficients into a GPU buffer.
 * Each coefficient is a vec3 (RGB), packed as vec4 with padding.
 * Total: 9 × vec4 = 144 bytes.
 *
 * @param device - GPU device
 * @param shCoefficients - Array of 9 Cartesian3 objects (or null)
 * @returns GPU buffer with packed SH data, or null
 */
function packSphericalHarmonics(
  device: GPUDevice,
  shCoefficients: { x: number; y: number; z: number }[] | undefined,
): GPUBuffer | null {
  if (!shCoefficients || shCoefficients.length < 9) {
    return null;
  }

  // 40 floats / 160 bytes total:
  //   - 0..35  : 9 SH coefficients (vec4 padding)
  //   - 36..39 : control vec4, whose .w = 1.0 marks SH active so the fragment
  //              shader evaluates analytically instead of sampling the
  //              irradiance cubemap.
  const data = new Float32Array(40);
  for (let i = 0; i < 9; i++) {
    const c = shCoefficients[i];
    data[i * 4 + 0] = c.x;
    data[i * 4 + 1] = c.y;
    data[i * 4 + 2] = c.z;
    data[i * 4 + 3] = 0.0; // padding
  }
  data[39] = 1.0; // control.w -- SH active

  const buffer = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

/**
 * Runs the full IBL pipeline: irradiance + radiance generation.
 * Called when the environment cubemap source changes.
 *
 * @param device - GPU device
 * @param cache - IBL pipeline cache object
 * @param sourceCubeView - Source environment cubemap view
 */
function generateIBLMaps(
  device: GPUDevice,
  cache: IBLPipelineCache,
  sourceCubeView: GPUTextureView,
  computePipelineCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null = null,
  hqOptions?: RadianceHQOptions,
  encodingScope?: IBLCommandEncodingScope,
): void {
  const outputTransaction = preparePersistentIBLOutputs(device, cache);
  const ownsEncodingScope = !encodingScope;
  let scope: IBLCommandEncodingScope;
  try {
    scope =
      encodingScope ??
      createIBLCommandEncodingScope(
        device,
        "IBL Map Refresh",
        getIBLRefreshParameterCapacity(hqOptions),
      );
  } catch (error) {
    outputTransaction?.rollback();
    throw error;
  }
  if (outputTransaction !== null) {
    registerIBLOutputTransaction(scope, outputTransaction);
  }
  const workingCache = outputTransaction?.workingCache ?? cache;

  try {
    if (!workingCache.sampler) {
      const shared = getIBLDeviceKernelPack(
        device,
        workingCache.resourceGeneration ?? 0,
      );
      shared.sampler ??= device.createSampler({
        minFilter: "linear",
        magFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        addressModeW: "clamp-to-edge",
      });
      workingCache.sampler = shared.sampler;
    }

    if (workingCache.persistentOutputs) {
      // A dynamic replacement is all-or-nothing. A partial encoder may never
      // initialize and publish only one half of the output graph.
      dispatchIrradianceConvolution(
        device,
        workingCache,
        sourceCubeView,
        computePipelineCache,
        scope,
      );
      dispatchRadiancePrefilter(
        device,
        workingCache,
        sourceCubeView,
        computePipelineCache,
        hqOptions,
        scope,
      );
    } else {
      try {
        dispatchIrradianceConvolution(
          device,
          workingCache,
          sourceCubeView,
          computePipelineCache,
          scope,
        );
      } catch {
        // Authored IBL preserves its historical independent-stage fallback.
      }
      try {
        dispatchRadiancePrefilter(
          device,
          workingCache,
          sourceCubeView,
          computePipelineCache,
          hqOptions,
          scope,
        );
      } catch {
        // Authored IBL preserves its historical independent-stage fallback.
      }
    }

    if (ownsEncodingScope) {
      submitIBLCommandEncodingScope(device, scope);
    }
  } catch (error) {
    if (ownsEncodingScope) {
      destroyIBLCommandEncodingScope(scope);
    }
    // An externally owned scope may be borrowing the scene frame encoder. Its
    // output transaction and parameter lease must remain intact until that
    // exact encoder segment reports submitted/abandoned; eager rollback here
    // would release resources still referenced by partially recorded work.
    throw error;
  }
}

export {
  createIrradiancePipeline,
  createRadiancePipeline,
  createRadianceHQPipeline,
  createIBLCommandEncodingScope,
  getOrCreateIBLPersistentParameterArena,
  destroyIBLPersistentParameterArena,
  destroyPersistentIBLPipelineResources,
  destroyIBLCommandEncodingScope,
  settleIBLCommandEncodingScope,
  getIBLRefreshParameterCapacity,
  submitIBLCommandEncodingScope,
  uploadIBLCommandEncodingScopeParameters,
  generateIBLMaps,
  packSphericalHarmonics,
  dispatchIrradianceConvolution,
  dispatchRadiancePrefilter,
  resetIBLDeviceKernelPacksForSpecs,
  IRRADIANCE_SIZE,
  RADIANCE_BASE_SIZE,
  RADIANCE_MIP_LEVELS,
};

export type {
  IBLCommandEncodingScope,
  IBLParameterArenaPool,
  IBLPersistentParameterArena,
  IBLPipelineCache,
  RadianceHQOptions,
  IBLPrefilterQuality,
};
