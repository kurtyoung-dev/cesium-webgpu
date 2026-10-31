/// <reference types="@webgpu/types" />
/**
 * The FFT ocean's compute side: the simulation textures, uniform buffers,
 * pipelines and bind groups of the spectrum -> evolve -> inverse FFT -> merge
 * chain, and the per-frame recording of its dispatches. Split out of
 * `WebGPUOceanRenderer.ts`, which keeps the pipeline lifecycle, the uniform
 * uploads and the draw.
 *
 * Two inverse-FFT kernels are kept, selected per frame by the surface's
 * `ifftKernel`:
 *   - "stockham" (default): `OceanStockhamIFFT.wgsl`, two dispatches per frame
 *     (rows, then columns), each running all log2(N) stages in workgroup
 *     memory on both complex fields at once.
 *   - "pingpong": `OceanIFFT.wgsl`, one global ping-pong dispatch per stage,
 *     per axis, per field — 4 * log2(N) = 32 dispatches per frame.
 * Both read the one `OceanTwiddle.wgsl` texture and perform the same stage
 * arithmetic, so they produce the same field; both end with the result in
 * field A, which is what the merge binds.
 *
 * @private
 */
import OceanInitialSpectrumWGSL from "../../Shaders/WebGPU/Ocean/OceanInitialSpectrum.js";
import OceanTwiddleWGSL from "../../Shaders/WebGPU/Ocean/OceanTwiddle.js";
import OceanTimeSpectrumWGSL from "../../Shaders/WebGPU/Ocean/OceanTimeSpectrum.js";
import OceanIFFTWGSL from "../../Shaders/WebGPU/Ocean/OceanIFFT.js";
import OceanStockhamIFFTWGSL from "../../Shaders/WebGPU/Ocean/OceanStockhamIFFT.js";
import OceanMergeWGSL from "../../Shaders/WebGPU/Ocean/OceanMerge.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture as textureEntry,
  storageTexture,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";
import type WebGPUDrawCommand from "./WebGPUDrawCommand.js";

export const N = 256; // cascade resolution (fits WebGPU default 256 workgroup limit)
export const LOG2N = 8;
const WG = 8; // workgroup size per axis
const DISPATCH = N / WG; // 32

/** The inverse-FFT kernel a surface selects. */
export type OceanIfftKernel = "stockham" | "pingpong";

/**
 * The kernel a surface asked for: `"pingpong"` only when it says so exactly,
 * otherwise the default `"stockham"`.
 */
export function resolveOceanIfftKernel(value: unknown): OceanIfftKernel {
  return value === "pingpong" ? "pingpong" : "stockham";
}

const _oceanShaderModuleCaches = new WeakMap<
  GPUDevice,
  WebGPUShaderModuleCache
>();
export function getOceanShaderModuleCache(
  device: GPUDevice,
): WebGPUShaderModuleCache {
  let cache = _oceanShaderModuleCaches.get(device);
  if (!cache) {
    cache = new WebGPUShaderModuleCache(device);
    _oceanShaderModuleCaches.set(device, cache);
  }
  return cache;
}

export interface OceanCache {
  initialized: boolean;
  paramsDirty: boolean;
  frameNumber: number;
  /**
   * The last wave phase, in seconds, this surface was advanced to. Carried so
   * a frame that arrives without a clock can continue from where the clock
   * left off instead of restarting on an unrelated origin.
   */
  simulationSeconds: number;
  // Simulation textures
  noiseTexture: GPUTexture | null;
  h0Texture: GPUTexture | null;
  twiddleTexture: GPUTexture | null;
  field1: GPUTexture[]; // [A,B] rg32float ping-pong (Dy+iDx)
  field2: GPUTexture[]; // [A,B] rg32float ping-pong (Dz)
  displacementTexture: GPUTexture | null;
  displacementSampler: GPUSampler | null;
  // Compute pipelines
  initPipeline: GPUComputePipeline | null;
  twiddlePipeline: GPUComputePipeline | null;
  evolvePipeline: GPUComputePipeline | null;
  ifftHPipeline: GPUComputePipeline | null;
  ifftVPipeline: GPUComputePipeline | null;
  stockhamHPipeline: GPUComputePipeline | null;
  stockhamVPipeline: GPUComputePipeline | null;
  mergePipeline: GPUComputePipeline | null;
  computePipelinesReady?: boolean;
  /**
   * Terminal: an async compute pipeline creation was rejected. Set once, after
   * the one permanent error is logged, and cleared only by a re-initialisation.
   */
  computePipelinesFailed?: boolean;
  /** Terminal, like `computePipelinesFailed`, for the render pipeline. */
  renderPipelineFailed?: boolean;
  /**
   * Bumped by every (re)initialisation. An async pipeline result carries the
   * value it was requested under and is ignored when it no longer matches, so a
   * result built for a superseded descriptor (format or log-depth change) can
   * neither overwrite the new pipeline nor clear its pending flag.
   */
  pipelineGeneration?: number;
  readyFrames?: number;
  // Compute bind groups
  initBindGroup: GPUBindGroup | null;
  twiddleBindGroup: GPUBindGroup | null;
  evolveBindGroup: GPUBindGroup | null;
  ifftBindGroups1: (GPUBindGroup | null)[]; // [0..7] per stage, field1
  ifftBindGroups2: (GPUBindGroup | null)[];
  // Stockham: H reads field A writes B, V reads B writes A (merge reads A).
  stockhamHBindGroup: GPUBindGroup | null;
  stockhamVBindGroup: GPUBindGroup | null;
  mergeBindGroup: GPUBindGroup | null;
  ifftBGL: GPUBindGroupLayout | null;
  // Compute uniform buffers
  initParamsBuffer: GPUBuffer | null;
  twiddleParamsBuffer: GPUBuffer | null;
  timeParamsBuffer: GPUBuffer | null;
  mergeParamsBuffer: GPUBuffer | null;
  // Reused 32-byte CPU scratch for time parameters.
  timeParamsScratch: ArrayBuffer | null;
  timeParamsU32?: Uint32Array;
  timeParamsF32?: Float32Array;
  // Reused 32-byte CPU scratch for merge parameters.
  mergeParamsScratch: ArrayBuffer | null;
  mergeParamsU32?: Uint32Array;
  mergeParamsF32?: Float32Array;
  stepBuffers: GPUBuffer[]; // [0..7]
  // Render side
  gridVertexBuffer: GPUBuffer | null;
  gridIndexBuffer: GPUBuffer | null;
  gridIndexCount: number;
  cameraUniformBuffer: GPUBuffer | null;
  cameraUniformData: Float32Array;
  oceanUniformBuffer: GPUBuffer | null;
  oceanUniformData: Float32Array;
  renderShaderModule: GPUShaderModule | null;
  renderBindGroupLayout: GPUBindGroupLayout | null;
  renderBindGroup: GPUBindGroup | null;
  renderPipeline: GPURenderPipeline | null;
  renderPipelineDescriptor: WebGPURenderPipelineDescriptor | null;
  renderPipelineRequestPending: boolean;
  command: WebGPUDrawCommand | null;
  _pipelineFormatGeneration?: number;
  _logDepthEnabled?: boolean;
}

// Deterministic Box-Muller Gaussian noise (rgba32float, 4 gaussians/texel).
function makeNoise(): Float32Array {
  const data = new Float32Array(N * N * 4);
  let seed = 0x9e3779b9 >>> 0;
  const rand = () => {
    // xorshift32
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  const gauss = () => {
    let u = rand();
    const v = rand();
    if (u < 1e-7) {
      u = 1e-7;
    }
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };
  for (let i = 0; i < N * N; i++) {
    data[i * 4 + 0] = gauss();
    data[i * 4 + 1] = gauss();
    data[i * 4 + 2] = gauss();
    data[i * 4 + 3] = gauss();
  }
  return data;
}

function createComputeTexture(
  device: GPUDevice,
  format: GPUTextureFormat,
  label: string,
): GPUTexture {
  return device.createTexture({
    label,
    size: { width: N, height: N },
    format,
    usage:
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST,
  });
}

function makeComputeModule(device: GPUDevice, code: string, label: string) {
  return device.createShaderModule({ label, code });
}

/**
 * Create the compute textures, buffers, bind groups and pipeline descriptors.
 * Returns the descriptors in the order the renderer's
 * `requestComputePipelines` assigns them: init, twiddle, evolve, ping-pong
 * IFFT H and V, merge, Stockham H and V.
 */
export function createOceanComputeResources(
  device: GPUDevice,
  cache: OceanCache,
): GPUComputePipelineDescriptor[] {
  // ── Textures ──
  cache.noiseTexture = device.createTexture({
    label: "Ocean noise",
    size: { width: N, height: N },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: cache.noiseTexture },
    makeNoise(),
    { bytesPerRow: N * 16, rowsPerImage: N },
    { width: N, height: N },
  );
  cache.h0Texture = createComputeTexture(device, "rgba32float", "Ocean h0");
  cache.twiddleTexture = device.createTexture({
    label: "Ocean twiddle",
    size: { width: LOG2N, height: N },
    format: "rgba32float",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  cache.field1 = [
    createComputeTexture(device, "rg32float", "Ocean field1A"),
    createComputeTexture(device, "rg32float", "Ocean field1B"),
  ];
  cache.field2 = [
    createComputeTexture(device, "rg32float", "Ocean field2A"),
    createComputeTexture(device, "rg32float", "Ocean field2B"),
  ];
  cache.displacementTexture = createComputeTexture(
    device,
    "rgba16float",
    "Ocean displacement",
  );
  cache.displacementSampler = device.createSampler({
    label: "Ocean disp sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

  // ── Uniform buffers ──
  cache.initParamsBuffer = device.createBuffer({
    label: "Ocean init params",
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.twiddleParamsBuffer = device.createBuffer({
    label: "Ocean twiddle params",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.timeParamsBuffer = device.createBuffer({
    label: "Ocean time params",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.mergeParamsBuffer = device.createBuffer({
    label: "Ocean merge params",
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.stepBuffers = [];
  for (let s = 0; s < LOG2N; s++) {
    const buf = device.createBuffer({
      label: `Ocean ifft step ${s}`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, new Uint32Array([s, 0, 0, 0]));
    cache.stepBuffers.push(buf);
  }

  // ── Compute pipelines + bind groups ──
  const initBGL = makeBindGroupLayout(device, "Ocean init BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    storageTexture(1, Stage.COMPUTE, "rgba32float", { access: "write-only" }),
    uniformBuffer(2, Stage.COMPUTE),
  ]);
  const initDesc: GPUComputePipelineDescriptor = {
    label: "Ocean init pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [initBGL] }),
    compute: {
      module: makeComputeModule(device, OceanInitialSpectrumWGSL, "Ocean init"),
      entryPoint: "initialSpectrum",
    },
  };
  cache.initBindGroup = device.createBindGroup({
    label: "Ocean init BG",
    layout: initBGL,
    entries: [
      { binding: 0, resource: cache.noiseTexture.createView() },
      { binding: 1, resource: cache.h0Texture.createView() },
      { binding: 2, resource: { buffer: cache.initParamsBuffer } },
    ],
  });

  const twiddleBGL = makeBindGroupLayout(device, "Ocean twiddle BGL", [
    storageTexture(0, Stage.COMPUTE, "rgba32float", { access: "write-only" }),
    uniformBuffer(1, Stage.COMPUTE),
  ]);
  const twiddleDesc: GPUComputePipelineDescriptor = {
    label: "Ocean twiddle pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [twiddleBGL] }),
    compute: {
      module: makeComputeModule(device, OceanTwiddleWGSL, "Ocean twiddle"),
      entryPoint: "precompute",
    },
  };
  cache.twiddleBindGroup = device.createBindGroup({
    label: "Ocean twiddle BG",
    layout: twiddleBGL,
    entries: [
      { binding: 0, resource: cache.twiddleTexture.createView() },
      { binding: 1, resource: { buffer: cache.twiddleParamsBuffer } },
    ],
  });

  const evolveBGL = makeBindGroupLayout(device, "Ocean evolve BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    storageTexture(1, Stage.COMPUTE, "rg32float", { access: "write-only" }),
    storageTexture(2, Stage.COMPUTE, "rg32float", { access: "write-only" }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);
  const evolveDesc: GPUComputePipelineDescriptor = {
    label: "Ocean evolve pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [evolveBGL] }),
    compute: {
      module: makeComputeModule(device, OceanTimeSpectrumWGSL, "Ocean evolve"),
      entryPoint: "evolve",
    },
  };
  cache.evolveBindGroup = device.createBindGroup({
    label: "Ocean evolve BG",
    layout: evolveBGL,
    entries: [
      { binding: 0, resource: cache.h0Texture.createView() },
      { binding: 1, resource: cache.field1[0].createView() }, // write field1A
      { binding: 2, resource: cache.field2[0].createView() }, // write field2A
      { binding: 3, resource: { buffer: cache.timeParamsBuffer } },
    ],
  });

  const ifftBGL = makeBindGroupLayout(device, "Ocean ifft BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }), // twiddle
    textureEntry(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }), // input
    storageTexture(2, Stage.COMPUTE, "rg32float", { access: "write-only" }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);
  cache.ifftBGL = ifftBGL;
  const ifftLayout = device.createPipelineLayout({
    bindGroupLayouts: [ifftBGL],
  });
  const ifftModule = makeComputeModule(device, OceanIFFTWGSL, "Ocean ifft");
  const ifftHDesc: GPUComputePipelineDescriptor = {
    label: "Ocean ifft H",
    layout: ifftLayout,
    compute: { module: ifftModule, entryPoint: "horizontalStep" },
  };
  const ifftVDesc: GPUComputePipelineDescriptor = {
    label: "Ocean ifft V",
    layout: ifftLayout,
    compute: { module: ifftModule, entryPoint: "verticalStep" },
  };
  // Per-stage bind groups: even step reads A writes B, odd reads B writes A.
  cache.ifftBindGroups1 = [];
  cache.ifftBindGroups2 = [];
  for (let s = 0; s < LOG2N; s++) {
    const inIdx = s % 2 === 0 ? 0 : 1;
    const outIdx = s % 2 === 0 ? 1 : 0;
    cache.ifftBindGroups1.push(
      device.createBindGroup({
        label: `Ocean ifft1 BG ${s}`,
        layout: ifftBGL,
        entries: [
          { binding: 0, resource: cache.twiddleTexture.createView() },
          { binding: 1, resource: cache.field1[inIdx].createView() },
          { binding: 2, resource: cache.field1[outIdx].createView() },
          { binding: 3, resource: { buffer: cache.stepBuffers[s] } },
        ],
      }),
    );
    cache.ifftBindGroups2.push(
      device.createBindGroup({
        label: `Ocean ifft2 BG ${s}`,
        layout: ifftBGL,
        entries: [
          { binding: 0, resource: cache.twiddleTexture.createView() },
          { binding: 1, resource: cache.field2[inIdx].createView() },
          { binding: 2, resource: cache.field2[outIdx].createView() },
          { binding: 3, resource: { buffer: cache.stepBuffers[s] } },
        ],
      }),
    );
  }

  // Stockham IFFT: the same twiddle texture, both fields in one dispatch per
  // axis, every stage in workgroup memory.
  const stockhamBGL = makeBindGroupLayout(device, "Ocean Stockham IFFT BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }), // twiddle
    textureEntry(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }), // Dy+iDx in
    textureEntry(2, Stage.COMPUTE, { sampleType: "unfilterable-float" }), // Dz in
    storageTexture(3, Stage.COMPUTE, "rg32float", { access: "write-only" }),
    storageTexture(4, Stage.COMPUTE, "rg32float", { access: "write-only" }),
  ]);
  const stockhamLayout = device.createPipelineLayout({
    bindGroupLayouts: [stockhamBGL],
  });
  const stockhamModule = getOceanShaderModuleCache(device).getOrCreate(
    ShaderSourceId.OCEAN_STOCKHAM_IFFT,
    OceanStockhamIFFTWGSL,
    0,
    "Ocean Stockham IFFT",
  );
  const stockhamHDesc: GPUComputePipelineDescriptor = {
    label: "Ocean Stockham IFFT H",
    layout: stockhamLayout,
    compute: { module: stockhamModule, entryPoint: "horizontalStockham" },
  };
  const stockhamVDesc: GPUComputePipelineDescriptor = {
    label: "Ocean Stockham IFFT V",
    layout: stockhamLayout,
    compute: { module: stockhamModule, entryPoint: "verticalStockham" },
  };
  const stockhamBindGroup = (
    label: string,
    from: number,
    to: number,
  ): GPUBindGroup =>
    device.createBindGroup({
      label,
      layout: stockhamBGL,
      entries: [
        { binding: 0, resource: cache.twiddleTexture!.createView() },
        { binding: 1, resource: cache.field1[from].createView() },
        { binding: 2, resource: cache.field2[from].createView() },
        { binding: 3, resource: cache.field1[to].createView() },
        { binding: 4, resource: cache.field2[to].createView() },
      ],
    });
  cache.stockhamHBindGroup = stockhamBindGroup("Ocean Stockham H BG", 0, 1);
  cache.stockhamVBindGroup = stockhamBindGroup("Ocean Stockham V BG", 1, 0);

  const mergeBGL = makeBindGroupLayout(device, "Ocean merge BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    textureEntry(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    storageTexture(2, Stage.COMPUTE, "rgba16float", { access: "write-only" }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);
  const mergeDesc: GPUComputePipelineDescriptor = {
    label: "Ocean merge pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [mergeBGL] }),
    compute: {
      module: makeComputeModule(device, OceanMergeWGSL, "Ocean merge"),
      entryPoint: "merge",
    },
  };
  cache.mergeBindGroup = device.createBindGroup({
    label: "Ocean merge BG",
    layout: mergeBGL,
    entries: [
      { binding: 0, resource: cache.field1[0].createView() },
      { binding: 1, resource: cache.field2[0].createView() },
      { binding: 2, resource: cache.displacementTexture.createView() },
      { binding: 3, resource: { buffer: cache.mergeParamsBuffer } },
    ],
  });

  return [
    initDesc,
    twiddleDesc,
    evolveDesc,
    ifftHDesc,
    ifftVDesc,
    mergeDesc,
    stockhamHDesc,
    stockhamVDesc,
  ];
}

/**
 * Record one frame of the chain into an open compute pass: on a bake frame the
 * twiddle LUT and the initial spectrum, then evolve, the inverse FFT through
 * `kernel`, and merge.
 */
export function recordOceanComputeChain(
  computePass: GPUComputePassEncoder,
  cache: OceanCache,
  kernel: OceanIfftKernel,
  bake: boolean,
): void {
  const dispatchStage = (
    pipeline: GPUComputePipeline,
    bg: GPUBindGroup,
    gx: number,
    gy: number,
  ) => {
    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bg);
    computePass.dispatchWorkgroups(gx, gy);
  };

  if (bake) {
    dispatchStage(
      cache.twiddlePipeline!,
      cache.twiddleBindGroup!,
      LOG2N,
      Math.ceil(N / 64),
    );
    dispatchStage(
      cache.initPipeline!,
      cache.initBindGroup!,
      DISPATCH,
      DISPATCH,
    );
  }

  dispatchStage(
    cache.evolvePipeline!,
    cache.evolveBindGroup!,
    DISPATCH,
    DISPATCH,
  );
  if (kernel === "stockham") {
    // One workgroup per row, then one per column; result lands in field A.
    dispatchStage(cache.stockhamHPipeline!, cache.stockhamHBindGroup!, N, 1);
    dispatchStage(cache.stockhamVPipeline!, cache.stockhamVBindGroup!, N, 1);
  } else {
    // IFFT field1: horizontal then vertical (result lands back in field1[0]=A).
    for (let s = 0; s < LOG2N; s++) {
      dispatchStage(
        cache.ifftHPipeline!,
        cache.ifftBindGroups1[s]!,
        DISPATCH,
        DISPATCH,
      );
    }
    for (let s = 0; s < LOG2N; s++) {
      dispatchStage(
        cache.ifftVPipeline!,
        cache.ifftBindGroups1[s]!,
        DISPATCH,
        DISPATCH,
      );
    }
    for (let s = 0; s < LOG2N; s++) {
      dispatchStage(
        cache.ifftHPipeline!,
        cache.ifftBindGroups2[s]!,
        DISPATCH,
        DISPATCH,
      );
    }
    for (let s = 0; s < LOG2N; s++) {
      dispatchStage(
        cache.ifftVPipeline!,
        cache.ifftBindGroups2[s]!,
        DISPATCH,
        DISPATCH,
      );
    }
  }
  dispatchStage(
    cache.mergePipeline!,
    cache.mergeBindGroup!,
    DISPATCH,
    DISPATCH,
  );
}
