/// <reference types="@webgpu/types" />
/**
 * WebGPU FFT spectral ocean renderer.
 *
 * A GPU FFT ocean: a per-frame compute chain synthesizes an animated wave
 * displacement + foam map from a Tessendorf/Phillips spectrum, and an RTE-
 * anchored ENU grid patch samples it to render a displaced, Fresnel-shaded
 * ocean surface on the globe.
 *
 * Compute chain (single 256×256 cascade, v1):
 *   1. initial-spectrum  h0(k) / conj(h0(-k))       (once / on param change)
 *   2. twiddle-precompute butterfly index+factor LUT (once)
 *   3. time-evolve        h(k,t) → packed Dy+iDx, Dz (per frame)
 *   4. inverse FFT        log2(N) horizontal + log2(N) vertical stages, ×2 fields
 *   5. merge              → filterable rgba16float (Dx, Dy, Dz, foam)
 *
 * Opt-in and default-off: the entire GPU resource set is allocated lazily on
 * the first `update()` of an enabled `OceanSurfacePrimitive`, so nothing is
 * allocated or dispatched while the feature is off and frames stay
 * byte-identical. WebGL contexts never register this renderer, so an
 * `OceanSurfacePrimitive` renders nothing on WebGL — a documented no-op rather
 * than a fallback.
 *
 * References:
 *   - Jerry Tessendorf, "Simulating Ocean Water" (SIGGRAPH course notes) — the
 *     Phillips spectrum and the dispersion relation, implemented from the
 *     published equations.
 *   - gasgiant/FFT-Ocean (MIT, © 2020 Ivan Pensionerov), Popov72/OceanDemo
 *     (MIT, WGSL port) and BarthPaleologue/WebTide (MIT, © 2024 Barthélemy
 *     Paléologue) — the FFT butterfly and spectrum packing. See the
 *     Third-Party section of `LICENSE.md`. The sign and index conventions used
 *     here were CPU-validated against a brute-force IDFT before porting.
 *
 * @private
 */
import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";
import Pass from "../Pass.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
import { m4Values } from "./webgpuTypeHelpers.js";
import OceanInitialSpectrumWGSL from "../../Shaders/WebGPU/Ocean/OceanInitialSpectrum.js";
import OceanTwiddleWGSL from "../../Shaders/WebGPU/Ocean/OceanTwiddle.js";
import OceanTimeSpectrumWGSL from "../../Shaders/WebGPU/Ocean/OceanTimeSpectrum.js";
import OceanIFFTWGSL from "../../Shaders/WebGPU/Ocean/OceanIFFT.js";
import OceanMergeWGSL from "../../Shaders/WebGPU/Ocean/OceanMerge.js";
import OceanSurfaceWGSL from "../../Shaders/WebGPU/Ocean/OceanSurface.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture as textureEntry,
  storageTexture,
  sampler as samplerEntry,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderDefine, ShaderSourceId } from "./WebGPUShaderDefines.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import { getAvailableFrameCommandEncoder } from "./WebGPUFrameCommandEncoder.js";
// The simulation clock law. It lives beside the surface it belongs to rather
// than here, so a node spec can execute it without standing up a device — the
// same split `computeSeaLevelOffset` and `resolveCelestialReflection` already
// make, and the same direction of import the globe's camera-UB packer uses for
// `isUndergroundVisible`.
import { resolveOceanSimulationSeconds } from "../../Scene/OceanSurfacePrimitive.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

const N = 256; // cascade resolution (fits WebGPU default 256 workgroup limit)
const LOG2N = 8;
const WG = 8; // workgroup size per axis
const DISPATCH = N / WG; // 32
const CAMERA_UNIFORM_FLOATS = 44;
// 192 bytes (12 vec4). The last two vec4 carry the celestial-reflection
// tail, which is written as exact zeros while the reflection is off, so the
// values the shader reads are unchanged from before the tail existed.
const OCEAN_UNIFORM_FLOATS = 48;

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

interface OceanCache {
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
  mergePipeline: GPUComputePipeline | null;
  // Compute bind groups
  initBindGroup: GPUBindGroup | null;
  twiddleBindGroup: GPUBindGroup | null;
  evolveBindGroup: GPUBindGroup | null;
  ifftBindGroups1: (GPUBindGroup | null)[]; // [0..7] per stage, field1
  ifftBindGroups2: (GPUBindGroup | null)[];
  mergeBindGroup: GPUBindGroup | null;
  ifftBGL: GPUBindGroupLayout | null;
  // Compute uniform buffers
  initParamsBuffer: GPUBuffer | null;
  twiddleParamsBuffer: GPUBuffer | null;
  timeParamsBuffer: GPUBuffer | null;
  mergeParamsBuffer: GPUBuffer | null;
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

interface OceanPrimitiveLike {
  show?: boolean;
  _enabled?: boolean;
  _resolutionN?: number;
  // spectrum params
  _patchLength?: number;
  _patchExtent?: number;
  _gravity?: number;
  _windDirX?: number;
  _windDirZ?: number;
  _windSpeed?: number;
  _amplitude?: number;
  _smallWave?: number;
  _dirDamp?: number;
  _choppiness?: number;
  _heightScale?: number;
  _foamThreshold?: number;
  _foamScale?: number;
  _foamStrength?: number;
  _detailScale?: number;
  _timeSpeed?: number;
  /**
   * The instant the wave phase counts from, a `JulianDate`. Undefined until
   * the first frame that carries a scene time, which adopts it; a caller may
   * pin it to make the surface reproducible across pages. Typed structurally
   * rather than as the class, so this interface keeps its existing shape of
   * describing the surface by the fields the renderer touches.
   */
  _simulationEpoch?: object;
  // per-frame anchor state (packed by the primitive)
  _anchor?: Cartesian3;
  _east?: Cartesian3;
  _north?: Cartesian3;
  _up?: Cartesian3;
  _uvOffsetX?: number;
  _uvOffsetY?: number;
  _sunDirection?: Cartesian3;
  _celestialEnable?: number;
  _celestialResolvedRoughness?: number;
  _celestialResolvedSunIntensity?: number;
  _celestialSinAngularRadius?: number;
  _celestialMoonDirection?: { x: number; y: number; z: number };
  _celestialMoonPhase?: number;
  _celestialResolvedMoonIntensity?: number;
  _celestialMoonSinAngularRadius?: number;
  _invRadius?: number;
  _deepColor?: { x: number; y: number; z: number };
  _shallowColor?: { x: number; y: number; z: number };
  _paramsDirty?: boolean;
  _webgpuCache?: unknown;
}

const scratchEncoded = { high: new Cartesian3(), low: new Cartesian3() };
const scratchAnchorEnc = { high: new Cartesian3(), low: new Cartesian3() };
const scratchMVP = new Matrix4();
const scratchMVRTE = new Matrix4();

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
    let v = rand();
    if (u < 1e-7) u = 1e-7;
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

function createGrid(device: GPUDevice, cache: OceanCache): void {
  const res = 200; // quads per side
  const verts = new Float32Array((res + 1) * (res + 1) * 2);
  let vi = 0;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      verts[vi++] = i / res - 0.5; // [-0.5, 0.5]
      verts[vi++] = j / res - 0.5;
    }
  }
  const indices = new Uint32Array(res * res * 6);
  let ii = 0;
  const stride = res + 1;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }
  const vb = device.createBuffer({
    label: "Ocean grid VB",
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vb, 0, verts);
  const ib = device.createBuffer({
    label: "Ocean grid IB",
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(ib, 0, indices);
  cache.gridVertexBuffer = vb;
  cache.gridIndexBuffer = ib;
  cache.gridIndexCount = indices.length;
}

function makeComputeModule(device: GPUDevice, code: string, label: string) {
  return device.createShaderModule({ label, code });
}

const GRID_VERTEX_LAYOUT: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    stepMode: "vertex",
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
  },
];

function initializeOceanResources(
  context: CesiumGraphicsContext,
  device: GPUDevice,
  cache: OceanCache,
  sceneFormat: GPUTextureFormat,
  logDepthActive: boolean,
): void {
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
  cache.initPipeline = device.createComputePipeline({
    label: "Ocean init pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [initBGL] }),
    compute: {
      module: makeComputeModule(device, OceanInitialSpectrumWGSL, "Ocean init"),
      entryPoint: "initialSpectrum",
    },
  });
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
  cache.twiddlePipeline = device.createComputePipeline({
    label: "Ocean twiddle pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [twiddleBGL] }),
    compute: {
      module: makeComputeModule(device, OceanTwiddleWGSL, "Ocean twiddle"),
      entryPoint: "precompute",
    },
  });
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
  cache.evolvePipeline = device.createComputePipeline({
    label: "Ocean evolve pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [evolveBGL] }),
    compute: {
      module: makeComputeModule(device, OceanTimeSpectrumWGSL, "Ocean evolve"),
      entryPoint: "evolve",
    },
  });
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
  cache.ifftHPipeline = device.createComputePipeline({
    label: "Ocean ifft H",
    layout: ifftLayout,
    compute: { module: ifftModule, entryPoint: "horizontalStep" },
  });
  cache.ifftVPipeline = device.createComputePipeline({
    label: "Ocean ifft V",
    layout: ifftLayout,
    compute: { module: ifftModule, entryPoint: "verticalStep" },
  });
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

  const mergeBGL = makeBindGroupLayout(device, "Ocean merge BGL", [
    textureEntry(0, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    textureEntry(1, Stage.COMPUTE, { sampleType: "unfilterable-float" }),
    storageTexture(2, Stage.COMPUTE, "rgba16float", { access: "write-only" }),
    uniformBuffer(3, Stage.COMPUTE),
  ]);
  cache.mergePipeline = device.createComputePipeline({
    label: "Ocean merge pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [mergeBGL] }),
    compute: {
      module: makeComputeModule(device, OceanMergeWGSL, "Ocean merge"),
      entryPoint: "merge",
    },
  });
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

  // ── Render pipeline ──
  const renderModule = getRenderShaderModuleCache(device).getOrCreate(
    ShaderSourceId.OCEAN_SURFACE,
    OceanSurfaceWGSL,
    logDepthActive ? ShaderDefine.LOG_DEPTH : 0,
    "Ocean surface",
  );
  cache.renderShaderModule = renderModule;
  cache.renderBindGroupLayout = makeBindGroupLayout(
    device,
    "Ocean render BGL",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      uniformBuffer(1, Stage.VERTEX_FRAGMENT),
      textureEntry(2, Stage.VERTEX_FRAGMENT, { sampleType: "float" }),
      samplerEntry(3, Stage.VERTEX_FRAGMENT, "filtering"),
    ],
  );

  const sampleCount =
    (context as unknown as { _msaaSamples?: number })._msaaSamples ?? 1;
  cache.renderPipelineDescriptor = {
    name: `Ocean pipeline [${sceneFormat}/ms=${sampleCount}/ld=${logDepthActive ? 1 : 0}]`,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [cache.renderBindGroupLayout],
    }),
    vertex: {
      module: renderModule,
      entryPoint: "vertexMain",
      buffers: GRID_VERTEX_LAYOUT,
    },
    fragment: {
      module: renderModule,
      entryPoint: "fragmentMain",
      targets: makeSceneFBTargets(sceneFormat),
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth24plus-stencil8",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
  };

  createGrid(device, cache);
  cache.cameraUniformBuffer = device.createBuffer({
    label: "Ocean camera UB",
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  cache.oceanUniformBuffer = device.createBuffer({
    label: "Ocean UB",
    size: OCEAN_UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  cache.initialized = true;
  cache.paramsDirty = true;
}

function tryResolveRenderPipeline(
  device: GPUDevice,
  pipelineCache: WebGPURenderPipelineCache | null | undefined,
  cache: OceanCache,
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
    vertex: desc.vertex,
    fragment: desc.fragment,
    primitive: desc.primitive,
    depthStencil: desc.depthStencil,
    multisample: desc.multisample,
  });
  return true;
}

/**
 * How far a clockless frame advances the wave phase: one frame at the nominal
 * sixty hertz, which is the rate the surface ran at before it was given a
 * clock. Only reached when `frameState.time` is absent.
 */
const FALLBACK_FRAME_SECONDS = 1.0 / 60.0;

function updateWebGPUOcean(
  primObj: unknown,
  frameState: CesiumFrameState,
): void {
  const p = primObj as OceanPrimitiveLike;
  const context = frameState.context;
  const device: GPUDevice = context.device;
  if (!device) {
    return;
  }
  if (p.show === false || p._enabled !== true || !p._anchor) {
    return;
  }

  if (!p._webgpuCache) {
    p._webgpuCache = {
      initialized: false,
      paramsDirty: true,
      frameNumber: 0,
      simulationSeconds: 0,
      noiseTexture: null,
      h0Texture: null,
      twiddleTexture: null,
      field1: [],
      field2: [],
      displacementTexture: null,
      displacementSampler: null,
      initPipeline: null,
      twiddlePipeline: null,
      evolvePipeline: null,
      ifftHPipeline: null,
      ifftVPipeline: null,
      mergePipeline: null,
      initBindGroup: null,
      twiddleBindGroup: null,
      evolveBindGroup: null,
      ifftBindGroups1: [],
      ifftBindGroups2: [],
      mergeBindGroup: null,
      ifftBGL: null,
      initParamsBuffer: null,
      twiddleParamsBuffer: null,
      timeParamsBuffer: null,
      mergeParamsBuffer: null,
      stepBuffers: [],
      gridVertexBuffer: null,
      gridIndexBuffer: null,
      gridIndexCount: 0,
      cameraUniformBuffer: null,
      cameraUniformData: new Float32Array(CAMERA_UNIFORM_FLOATS),
      oceanUniformBuffer: null,
      oceanUniformData: new Float32Array(OCEAN_UNIFORM_FLOATS),
      renderShaderModule: null,
      renderBindGroupLayout: null,
      renderBindGroup: null,
      renderPipeline: null,
      renderPipelineDescriptor: null,
      renderPipelineRequestPending: false,
      command: null,
    } as OceanCache;
  }
  const cache = p._webgpuCache as OceanCache;

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

  if (
    cache.initialized &&
    (cache._logDepthEnabled !== logDepthActive ||
      cache._pipelineFormatGeneration !== sceneGen)
  ) {
    cache.initialized = false;
    cache.renderPipeline = null;
    cache.renderPipelineDescriptor = null;
    cache.renderPipelineRequestPending = false;
    cache.renderBindGroup = null;
    cache.command = null;
  }

  if (!cache.initialized) {
    initializeOceanResources(
      context,
      device,
      cache,
      sceneFormat,
      logDepthActive,
    );
    cache._pipelineFormatGeneration = sceneGen;
    cache._logDepthEnabled = logDepthActive;
  }

  if (
    !tryResolveRenderPipeline(device, ctxAny.webgpuPipelineCache ?? null, cache)
  ) {
    return;
  }

  // ── Upload compute uniforms ──
  const patchLength = p._patchLength ?? 250.0;
  const gravity = p._gravity ?? 9.81;
  if (cache.paramsDirty || p._paramsDirty) {
    const initBuf = new ArrayBuffer(48);
    const iu = new Uint32Array(initBuf);
    const iff = new Float32Array(initBuf);
    iu[0] = N;
    iff[2] = patchLength;
    iff[3] = gravity;
    iff[4] = p._windDirX ?? 1.0;
    iff[5] = p._windDirZ ?? 0.0;
    iff[6] = p._windSpeed ?? 12.0;
    iff[7] = p._amplitude ?? 1.0;
    iff[8] = p._smallWave ?? 1.0;
    iff[9] = p._dirDamp ?? 0.15;
    device.queue.writeBuffer(cache.initParamsBuffer!, 0, initBuf);
    device.queue.writeBuffer(
      cache.twiddleParamsBuffer!,
      0,
      new Uint32Array([N, LOG2N, 0, 0]),
    );
  }

  // Wave phase advances with SCENE time, not with the render loop.
  //
  // A frame that carries no time at all — an off-frame or direct update — has
  // no clock to read, and the phase carries on from where the clock left it,
  // one nominal frame at a time. It must NOT fall back to the frame counter:
  // that counter has an origin of its own, unrelated to the clock's, so
  // switching to it teleports the sea by however far the two have diverged,
  // and switching back teleports it again. Continuing is the only choice that
  // costs nothing and jumps nothing. When the clock returns it is authoritative
  // and the phase resumes from it, which is a correction rather than a jump:
  // the clock is what the sea is a function of.
  //
  // The rate is unchanged either way: one second of scene time at speed 1
  // advances the phase by the same 1.0 that sixty frames used to.
  const elapsedSeconds = resolveOceanSimulationSeconds(p, frameState);
  cache.simulationSeconds =
    elapsedSeconds !== undefined
      ? elapsedSeconds
      : cache.simulationSeconds + FALLBACK_FRAME_SECONDS;
  const timeSpeed = p._timeSpeed ?? 1.0;
  const time = cache.simulationSeconds * timeSpeed;
  const timeBuf = new ArrayBuffer(32);
  const tu = new Uint32Array(timeBuf);
  const tf = new Float32Array(timeBuf);
  tu[0] = N;
  tf[2] = patchLength;
  tf[3] = gravity;
  tf[4] = time;
  device.queue.writeBuffer(cache.timeParamsBuffer!, 0, timeBuf);

  const mergeBuf = new ArrayBuffer(32);
  const mu = new Uint32Array(mergeBuf);
  const mf = new Float32Array(mergeBuf);
  mu[0] = N;
  mf[2] = patchLength;
  mf[3] = p._choppiness ?? 1.0;
  mf[4] = p._heightScale ?? 1.0;
  mf[5] = p._foamThreshold ?? 0.6;
  mf[6] = p._foamScale ?? 1.2;
  device.queue.writeBuffer(cache.mergeParamsBuffer!, 0, mergeBuf);

  // ── Compute chain ──
  // During normal rendering `beginFrame()` has already opened the shared
  // command encoder and no render pass is active yet. Record the FFT ladder
  // there so it stays ordered immediately before the ocean draw without an
  // extra queue submission. Direct/off-frame update callers retain the
  // historical private-encoder fallback.
  const frameEncoder = getAvailableFrameCommandEncoder(context);
  const enc =
    frameEncoder ?? device.createCommandEncoder({ label: "Ocean compute" });
  const dispatchPass = (
    pipeline: GPUComputePipeline,
    bg: GPUBindGroup,
    gx: number,
    gy: number,
    label: string,
  ) => {
    const pass = enc.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
  };

  if (cache.paramsDirty || p._paramsDirty) {
    dispatchPass(
      cache.twiddlePipeline!,
      cache.twiddleBindGroup!,
      LOG2N,
      Math.ceil(N / 64),
      "Ocean twiddle",
    );
    dispatchPass(
      cache.initPipeline!,
      cache.initBindGroup!,
      DISPATCH,
      DISPATCH,
      "Ocean init",
    );
    cache.paramsDirty = false;
    p._paramsDirty = false;
  }

  dispatchPass(
    cache.evolvePipeline!,
    cache.evolveBindGroup!,
    DISPATCH,
    DISPATCH,
    "Ocean evolve",
  );
  // IFFT field1: horizontal then vertical (result lands back in field1[0]=A).
  for (let s = 0; s < LOG2N; s++) {
    dispatchPass(
      cache.ifftHPipeline!,
      cache.ifftBindGroups1[s]!,
      DISPATCH,
      DISPATCH,
      `Ocean ifft1 H${s}`,
    );
  }
  for (let s = 0; s < LOG2N; s++) {
    dispatchPass(
      cache.ifftVPipeline!,
      cache.ifftBindGroups1[s]!,
      DISPATCH,
      DISPATCH,
      `Ocean ifft1 V${s}`,
    );
  }
  for (let s = 0; s < LOG2N; s++) {
    dispatchPass(
      cache.ifftHPipeline!,
      cache.ifftBindGroups2[s]!,
      DISPATCH,
      DISPATCH,
      `Ocean ifft2 H${s}`,
    );
  }
  for (let s = 0; s < LOG2N; s++) {
    dispatchPass(
      cache.ifftVPipeline!,
      cache.ifftBindGroups2[s]!,
      DISPATCH,
      DISPATCH,
      `Ocean ifft2 V${s}`,
    );
  }
  dispatchPass(
    cache.mergePipeline!,
    cache.mergeBindGroup!,
    DISPATCH,
    DISPATCH,
    "Ocean merge",
  );
  if (!frameEncoder) {
    device.queue.submit([enc.finish()]);
  }
  cache.frameNumber++;

  // ── Render bind group (built once) ──
  if (!cache.renderBindGroup) {
    cache.renderBindGroup = device.createBindGroup({
      label: "Ocean render BG",
      layout: cache.renderBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: cache.cameraUniformBuffer! } },
        { binding: 1, resource: { buffer: cache.oceanUniformBuffer! } },
        { binding: 2, resource: cache.displacementTexture!.createView() },
        { binding: 3, resource: cache.displacementSampler! },
      ],
    });
  }

  // ── Camera uniforms (RTE) ──
  const us = context.uniformState;
  Matrix4.clone(us.view, scratchMVRTE);
  scratchMVRTE[12] = 0;
  scratchMVRTE[13] = 0;
  scratchMVRTE[14] = 0;
  const mvp = m4Values(
    Matrix4.multiply(us.projection, scratchMVRTE, scratchMVP),
  );
  const cd = cache.cameraUniformData;
  for (let i = 0; i < 16; i++) {
    cd[i] = mvp[i];
  }
  const canvas = context._canvas || { width: 1920, height: 1080 };
  cd[16] = canvas.width;
  cd[17] = canvas.height;
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
  cd[18] = ldNear;
  cd[19] = ldFar;
  EncodedCartesian3.fromCartesian(us.cameraPosition, scratchEncoded);
  cd[20] = scratchEncoded.high.x;
  cd[21] = scratchEncoded.high.y;
  cd[22] = scratchEncoded.high.z;
  cd[23] = ldFactor;
  cd[24] = scratchEncoded.low.x;
  cd[25] = scratchEncoded.low.y;
  cd[26] = scratchEncoded.low.z;
  cd[27] = 0;
  const prevVP = (us as { previousViewProjection?: Matrix4 })
    .previousViewProjection;
  if (prevVP) {
    Matrix4.pack(prevVP, cd, 28);
  } else {
    cd.fill(0, 28, 44);
    cd[28] = 1;
    cd[33] = 1;
    cd[38] = 1;
    cd[43] = 1;
  }
  device.queue.writeBuffer(cache.cameraUniformBuffer!, 0, cd);

  // ── Ocean uniforms ──
  const od = cache.oceanUniformData;
  EncodedCartesian3.fromCartesian(p._anchor!, scratchAnchorEnc);
  od[0] = scratchAnchorEnc.high.x;
  od[1] = scratchAnchorEnc.high.y;
  od[2] = scratchAnchorEnc.high.z;
  od[3] = 0;
  od[4] = scratchAnchorEnc.low.x;
  od[5] = scratchAnchorEnc.low.y;
  od[6] = scratchAnchorEnc.low.z;
  od[7] = 0;
  const east = p._east!;
  const north = p._north!;
  const up = p._up!;
  const patchExtent = p._patchExtent ?? 3000.0;
  od[8] = east.x;
  od[9] = east.y;
  od[10] = east.z;
  od[11] = patchExtent;
  od[12] = north.x;
  od[13] = north.y;
  od[14] = north.z;
  od[15] = p._invRadius ?? 1.0 / 6371000.0;
  od[16] = up.x;
  od[17] = up.y;
  od[18] = up.z;
  od[19] = patchLength;
  const sun = p._sunDirection ?? { x: 0, y: 0, z: 1 };
  od[20] = sun.x;
  od[21] = sun.y;
  od[22] = sun.z;
  od[23] = p._foamStrength ?? 1.0;
  const deep = p._deepColor ?? { x: 0.02, y: 0.08, z: 0.13 };
  od[24] = deep.x;
  od[25] = deep.y;
  od[26] = deep.z;
  od[27] = 70000.0; // waveFadeNear
  const shallow = p._shallowColor ?? { x: 0.05, y: 0.22, z: 0.32 };
  od[28] = shallow.x;
  od[29] = shallow.y;
  od[30] = shallow.z;
  od[31] = 1.0e6; // waveFadeFar
  od[32] = p._uvOffsetX ?? 0.0;
  od[33] = p._uvOffsetY ?? 0.0;
  od[34] = 1.0 / N; // texelSize
  od[35] = p._detailScale ?? 1.0;
  // Celestial-reflection tail. The primitive resolves these ahead of the
  // backend branch and publishes all four as exactly 0 while the reflection
  // is off, which is what the tail held before the feature existed -- so an
  // off ocean writes byte-identical uniform data.
  od[36] = p._celestialEnable ?? 0.0;
  od[37] = p._celestialResolvedRoughness ?? 0.0;
  od[38] = p._celestialResolvedSunIntensity ?? 0.0;
  od[39] = p._celestialSinAngularRadius ?? 0.0;
  const moon = p._celestialMoonDirection ?? { x: 0.0, y: 0.0, z: 0.0 };
  od[40] = moon.x;
  od[41] = moon.y;
  od[42] = moon.z;
  od[43] = p._celestialMoonPhase ?? 0.0;
  od[44] = p._celestialResolvedMoonIntensity ?? 0.0;
  od[45] = p._celestialMoonSinAngularRadius ?? 0.0;
  od[46] = 0.0;
  od[47] = 0.0;
  device.queue.writeBuffer(cache.oceanUniformBuffer!, 0, od);

  // ── Draw command ──
  if (!cache.command) {
    cache.command = new WebGPUDrawCommand({
      pipeline: cache.renderPipeline!,
      bindGroups: [cache.renderBindGroup!],
      vertexBuffers: [cache.gridVertexBuffer!],
      indexBuffer: cache.gridIndexBuffer!,
      indexFormat: "uint32",
      indexCount: cache.gridIndexCount,
      instanceCount: 1,
      pass: Pass.OPAQUE,
    });
  }
  const command = cache.command;
  command.pipeline = cache.renderPipeline!;
  command.bindGroups[0] = cache.renderBindGroup!;
  command.bindGroup = command.bindGroups[0];
  command.boundingVolume = undefined;
  command.cull = false;
  frameState.commandList.push(command);
}

function destroyWebGPUOceanResources(primObj: unknown): void {
  const p = primObj as OceanPrimitiveLike;
  const cache = p._webgpuCache as OceanCache | undefined;
  if (!cache) {
    return;
  }
  cache.noiseTexture?.destroy();
  cache.h0Texture?.destroy();
  cache.twiddleTexture?.destroy();
  cache.field1?.forEach((t) => t?.destroy());
  cache.field2?.forEach((t) => t?.destroy());
  cache.displacementTexture?.destroy();
  cache.gridVertexBuffer?.destroy();
  cache.gridIndexBuffer?.destroy();
  cache.cameraUniformBuffer?.destroy();
  cache.oceanUniformBuffer?.destroy();
  cache.initParamsBuffer?.destroy();
  cache.twiddleParamsBuffer?.destroy();
  cache.timeParamsBuffer?.destroy();
  cache.mergeParamsBuffer?.destroy();
  cache.stepBuffers?.forEach((b) => b?.destroy());
  p._webgpuCache = undefined;
}

export { updateWebGPUOcean, destroyWebGPUOceanResources };
export default { updateWebGPUOcean, destroyWebGPUOceanResources };
