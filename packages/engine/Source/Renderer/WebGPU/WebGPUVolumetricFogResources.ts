/// <reference types="@webgpu/types" />
/**
 * Volumetric-fog resource builder for `WebGPUVolumetricFogRenderer`.
 *
 * Owns the whole `_ensureResources` body: 3D texture allocation,
 * compute-pipeline creation for the density, scattering and integrate
 * passes, bind-group and bind-group-layout construction, the params uniform
 * buffer, the sun-shadow placeholder, the composite-pipeline descriptor
 * (resolved later through the central pipeline cache), and the composite
 * uniform buffer and sampler.
 *
 * That leaves the renderer's `_ensureResources` a small cache-management
 * wrapper: check whether the existing resources match the requested quality,
 * dispose if they do not, call `buildVolumetricFogResources` to allocate
 * fresh ones, assign to `this._resources`, return.
 *
 * @module WebGPUVolumetricFogResources
 */

import {
  makeBindGroupLayout,
  sampler,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import CloudDensityDomainWGSL from "../../Shaders/WebGPU/Environment/CloudDensityDomain.js";
import VolumetricFogComputeSource from "../../Shaders/WebGPU/Compute/VolumetricFog.js";
import VolumetricFogCompositeSource from "../../Shaders/WebGPU/PostProcess/VolumetricFogComposite.js";
import {
  QUALITY_RESOLUTIONS,
  VOLUMETRIC_FOG_PARAMS_FLOATS,
  VOLUMETRIC_FOG_PARAMS_BYTES,
  COMPOSITE_UNIFORMS_FLOATS,
  COMPOSITE_UNIFORMS_BYTES,
  FOG_TEMPORAL_UNIFORMS_FLOATS,
  FOG_TEMPORAL_UNIFORMS_BYTES,
  getVolumetricFogShaderModuleCache,
} from "./WebGPUVolumetricFogRenderer.js";
import type {
  QualityKey,
  VolumetricFogResources,
} from "./WebGPUVolumetricFogRenderer.js";
import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";
import type { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";

/**
 * CLOUD-LOW-COVERAGE-CUTOFF (fog cheap-path arm) — the fog's cheap cloud
 * shadow gates on cloud coverage, so it must use the SAME
 * `cloudEffectiveCoverage` response as the visible march and the IBL cube
 * rather than a second copy of it. That response lives in the shared
 * `CloudDensityDomain` chunk, which `WebGPUProceduralCloudRenderer` and
 * `WebGPUDynamicEnvironmentMapManager` prepend the same way.
 *
 * The chunk declares no bindings and shares no symbol names with
 * `VolumetricFog.wgsl`; its unreferenced helpers are dead-code-eliminated.
 * Composed once at module scope because `WebGPUShaderModuleCache` keys on
 * `(sourceId, defines)` and never on the source text — one source ID must
 * always mean one string.
 */
const VOLUMETRIC_FOG_COMPUTE_SOURCE = `${CloudDensityDomainWGSL}\n${VolumetricFogComputeSource}`;

/**
 * Allocate a fresh `VolumetricFogResources` for the given quality band.
 * Caller is responsible for disposing any prior resources before
 * calling this.
 */
export function buildVolumetricFogResources(
  device: GPUDevice,
  quality: QualityKey,
  computePipelineCache: WebGPUComputePipelineCache | null,
): VolumetricFogResources {
  const dims = QUALITY_RESOLUTIONS[quality];

  // 3D textures
  // STORAGE_BINDING for the compute write target; TEXTURE_BINDING for
  // the composite shader sample. Both bits are core WebGPU; no
  // optional features required.
  const usage =
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

  const densityTexture = device.createTexture({
    label: "VolumetricFog_Density",
    size: {
      width: dims.width,
      height: dims.height,
      depthOrArrayLayers: dims.depth,
    },
    format: "rgba16float",
    dimension: "3d",
    usage,
  });
  const scatteringTexture = device.createTexture({
    label: "VolumetricFog_Scattering",
    size: {
      width: dims.width,
      height: dims.height,
      depthOrArrayLayers: dims.depth,
    },
    format: "rgba16float",
    dimension: "3d",
    usage,
  });
  const integratedTexture = device.createTexture({
    label: "VolumetricFog_Integrated",
    size: {
      width: dims.width,
      height: dims.height,
      depthOrArrayLayers: dims.depth,
    },
    format: "rgba16float",
    dimension: "3d",
    usage,
  });

  const densityView = densityTexture.createView({
    label: "VolumetricFog_Density_View",
    dimension: "3d",
  });
  const scatteringView = scatteringTexture.createView({
    label: "VolumetricFog_Scattering_View",
    dimension: "3d",
  });
  const integratedView = integratedTexture.createView({
    label: "VolumetricFog_Integrated_View",
    dimension: "3d",
  });
  const integratedSampleView = integratedTexture.createView({
    label: "VolumetricFog_Integrated_SampleView",
    dimension: "3d",
  });

  // Compute shader module and per-pass pipelines. One shader module carries
  // all three entry points with disjoint `@binding` numbers, so write and
  // read access can be declared for the same texture without a `@binding`
  // collision. Each pipeline gets its own bind-group layout containing only
  // the bindings its entry point references; WebGPU validates per entry
  // point.
  //
  // The compute shader routes through the per-device module cache.
  // Pipeline-level dedup is available through
  // `context.webgpuComputePipelineCache`, but volumetric fog is a scene
  // singleton, so creating the pipelines directly here costs nothing;
  // adopting the cache would only matter in a multi-instance case.
  const moduleCache = getVolumetricFogShaderModuleCache(device);
  const computeShaderModule = moduleCache.getOrCreate(
    ShaderSourceId.VOLUMETRIC_FOG_COMPUTE,
    VOLUMETRIC_FOG_COMPUTE_SOURCE,
    0,
    "VolumetricFog_Compute",
  );

  // Helper for the storage texture entries — same shape repeated.
  const writeStorageEntry = {
    access: "write-only" as GPUStorageTextureAccess,
    format: "rgba16float" as GPUTextureFormat,
    viewDimension: "3d" as GPUTextureViewDimension,
  };
  const readStorageEntry = {
    access: "read-only" as GPUStorageTextureAccess,
    format: "rgba16float" as GPUTextureFormat,
    viewDimension: "3d" as GPUTextureViewDimension,
  };

  const densityBindGroupLayout = makeBindGroupLayout(
    device,
    "VolumetricFog_DensityBGL",
    [
      uniformBuffer(0, Stage.COMPUTE),
      // Storage textures keep the inline entry because the access/format/
      // viewDimension vary with `writeStorageEntry` / `readStorageEntry`.
      {
        binding: 1,
        visibility: Stage.COMPUTE,
        storageTexture: writeStorageEntry,
      },
    ],
  );

  const scatteringBindGroupLayout = makeBindGroupLayout(
    device,
    "VolumetricFog_ScatteringBGL",
    [
      uniformBuffer(0, Stage.COMPUTE),
      {
        binding: 2,
        visibility: Stage.COMPUTE,
        storageTexture: readStorageEntry,
      },
      {
        binding: 3,
        visibility: Stage.COMPUTE,
        storageTexture: writeStorageEntry,
      },
      // Phase 5c — sun shadow map (depth texture + comparison sampler).
      texture(6, Stage.COMPUTE, { sampleType: "depth" }),
      sampler(7, Stage.COMPUTE, "comparison"),
      // The atmosphere transmittance LUT (rgba16float, filterable), a linear
      // non-comparison sampler for the (cosZenith, altitude) lookup, and the
      // atmosphere-derived SH-L2 irradiance buffer, 160 bytes. Bound
      // unconditionally, as placeholders by default, so the layout never
      // forks; the WGSL only samples them when `u.iblAmbient.x >= 0.5`.
      texture(8, Stage.COMPUTE, { sampleType: "float" }),
      sampler(9, Stage.COMPUTE),
      uniformBuffer(10, Stage.COMPUTE),
      // Sun-view beer shadow map at binding 11 and a linear sampler at 12.
      // Bound unconditionally — a 1×1 zero placeholder when the hi-fi flag is
      // off, where the local-FBM path runs instead — so the layout never
      // forks; the WGSL samples them only inside `cloudShadowHiFi.x >= 0.5`.
      texture(11, Stage.COMPUTE, { sampleType: "float" }),
      sampler(12, Stage.COMPUTE),
    ],
  );

  const integrateBindGroupLayout = makeBindGroupLayout(
    device,
    "VolumetricFog_IntegrateBGL",
    [
      uniformBuffer(0, Stage.COMPUTE),
      {
        binding: 4,
        visibility: Stage.COMPUTE,
        storageTexture: readStorageEntry,
      },
      {
        binding: 5,
        visibility: Stage.COMPUTE,
        storageTexture: writeStorageEntry,
      },
    ],
  );

  // Route the three compute pipelines through
  // `webgpuComputePipelineCache`, on its synchronous path, so two contexts
  // with volumetric fog enabled share one pipeline per (label, layout,
  // entryPoint) tuple.
  const computeCache = computePipelineCache;
  const densityLayout = device.createPipelineLayout({
    bindGroupLayouts: [densityBindGroupLayout],
  });
  const scatteringLayout = device.createPipelineLayout({
    bindGroupLayouts: [scatteringBindGroupLayout],
  });
  const integrateLayout = device.createPipelineLayout({
    bindGroupLayouts: [integrateBindGroupLayout],
  });
  let densityPipeline: GPUComputePipeline;
  let scatteringPipeline: GPUComputePipeline;
  let integratePipeline: GPUComputePipeline;
  if (computeCache) {
    densityPipeline = computeCache.getOrCreateSync({
      name: "VolumetricFog_DensityPipeline",
      layout: densityLayout,
      compute: {
        module: computeShaderModule,
        entryPoint: "densityInjection",
      },
    });
    scatteringPipeline = computeCache.getOrCreateSync({
      name: "VolumetricFog_ScatteringPipeline",
      layout: scatteringLayout,
      compute: { module: computeShaderModule, entryPoint: "lightScattering" },
    });
    integratePipeline = computeCache.getOrCreateSync({
      name: "VolumetricFog_IntegratePipeline",
      layout: integrateLayout,
      compute: { module: computeShaderModule, entryPoint: "integrate" },
    });
  } else {
    densityPipeline = device.createComputePipeline({
      label: "VolumetricFog_DensityPipeline",
      layout: densityLayout,
      compute: {
        module: computeShaderModule,
        entryPoint: "densityInjection",
      },
    });
    scatteringPipeline = device.createComputePipeline({
      label: "VolumetricFog_ScatteringPipeline",
      layout: scatteringLayout,
      compute: { module: computeShaderModule, entryPoint: "lightScattering" },
    });
    integratePipeline = device.createComputePipeline({
      label: "VolumetricFog_IntegratePipeline",
      layout: integrateLayout,
      compute: { module: computeShaderModule, entryPoint: "integrate" },
    });
  }

  // Params UBO
  const paramsData = new Float32Array(VOLUMETRIC_FOG_PARAMS_FLOATS);
  const paramsU32 = new Uint32Array(
    paramsData.buffer,
    paramsData.byteOffset,
    paramsData.length,
  );
  const paramsBuffer = device.createBuffer({
    label: "VolumetricFog_Params",
    size: Math.max(VOLUMETRIC_FOG_PARAMS_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const densityBindGroup = device.createBindGroup({
    label: "VolumetricFog_DensityBindGroup",
    layout: densityBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: densityView },
    ],
  });

  // Phase 5c — sun shadow placeholder. 1×1 depth texture cleared to
  // 1.0 (= "fully lit" for the comparison sampler — no shadow). Stays
  // bound when no real sun shadow map is active so the kernel's
  // texture sample never tries to read an unbound texture.
  const shadowPlaceholderTexture = device.createTexture({
    label: "VolumetricFog_ShadowPlaceholder",
    size: { width: 1, height: 1 },
    format: "depth32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // We can't initialize a depth texture via writeBuffer; instead, use
  // a one-shot render pass that clears it to 1.0.
  {
    const initEncoder = device.createCommandEncoder({
      label: "VolumetricFog_ShadowPlaceholder_Init",
    });
    const initPass = initEncoder.beginRenderPass({
      label: "VolumetricFog_ShadowPlaceholder_Clear",
      colorAttachments: [],
      depthStencilAttachment: {
        view: shadowPlaceholderTexture.createView(),
        depthLoadOp: "clear",
        depthClearValue: 1.0,
        depthStoreOp: "store",
      },
    });
    initPass.end();
    device.queue.submit([initEncoder.finish()]);
  }
  const shadowPlaceholderView = shadowPlaceholderTexture.createView({
    label: "VolumetricFog_ShadowPlaceholder_View",
  });
  const shadowComparisonSampler = device.createSampler({
    label: "VolumetricFog_ShadowComparisonSampler",
    compare: "less-equal",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // Sky-LUT / image-based ambient placeholders. The scattering pass binds the
  // atmosphere transmittance LUT at binding 8, a linear sampler at 9, and the
  // atmosphere-derived SH-L2 buffer at 10, unconditionally, so the
  // bind-group layout is constant. Until the real resources arrive — and
  // forever on the default path — these placeholders keep the bind group
  // valid, the same arrangement `AerialPerspectiveEffect` uses. The WGSL only
  // samples them when `u.iblAmbient.x >= 0.5`, so they are never read by
  // default.
  //
  // The 1×1 white transmittance LUT is white so a stray read cannot darken
  // anything: no extinction. In rgba16float, white is 0x3C00 per channel.
  const iblTransmittancePlaceholderTexture = device.createTexture({
    label: "VolumetricFog_IBLTransmittancePlaceholder",
    size: { width: 1, height: 1 },
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  {
    const white = new Uint16Array([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
    device.queue.writeTexture(
      { texture: iblTransmittancePlaceholderTexture },
      white,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
  }
  const iblTransmittancePlaceholderView =
    iblTransmittancePlaceholderTexture.createView({
      label: "VolumetricFog_IBLTransmittancePlaceholder_View",
    });
  // Non-comparison linear sampler for the transmittance LUT lookup.
  const iblLutSampler = device.createSampler({
    label: "VolumetricFog_IBLLutSampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  // 160-byte zero-filled SH placeholder (9 vec4 coeffs + control vec4).
  // control.w = 0 (zero-filled) → the WGSL `evalFogSH` returns 0, so a
  // stray read contributes nothing. Real buffer is the scene env-manager's
  // `_webgpuSHBuffer` (same 160-byte UNIFORM layout — SHUniforms).
  const iblShPlaceholderBuffer = device.createBuffer({
    label: "VolumetricFog_IBLSHPlaceholder",
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Explicitly zero the placeholder so control.w starts at 0 even on
  // backends that don't zero-init new buffers (160 bytes = 40 floats).
  device.queue.writeBuffer(iblShPlaceholderBuffer, 0, new Float32Array(40));

  // A 1×1 zero r16float beer-shadow-map placeholder — optical depth 0, so
  // transmittance 1 and no shadow — and a linear sampler. Bound at bindings
  // 11 and 12 while the hi-fi flag is off, where the WGSL
  // `sampleCloudShadow` takes the local-FBM branch and never reads them. The
  // real beer map is swapped in by the renderer's per-frame bind-group
  // rebuild when hi-fi is on.
  const beerShadowPlaceholderTexture = device.createTexture({
    label: "VolumetricFog_BeerShadowPlaceholder",
    size: { width: 1, height: 1 },
    format: "r16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // f16(0.0) = 0x0000.
  device.queue.writeTexture(
    { texture: beerShadowPlaceholderTexture },
    new Uint16Array([0]),
    { bytesPerRow: 2 },
    { width: 1, height: 1 },
  );
  const beerShadowPlaceholderView = beerShadowPlaceholderTexture.createView({
    label: "VolumetricFog_BeerShadowPlaceholder_View",
  });
  const beerShadowSampler = device.createSampler({
    label: "VolumetricFog_BeerShadowSampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const scatteringBindGroup = device.createBindGroup({
    label: "VolumetricFog_ScatteringBindGroup",
    layout: scatteringBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 2, resource: densityView },
      { binding: 3, resource: scatteringView },
      { binding: 6, resource: shadowPlaceholderView },
      { binding: 7, resource: shadowComparisonSampler },
      // Sky-LUT / image-based ambient: placeholders until the real ones arrive.
      { binding: 8, resource: iblTransmittancePlaceholderView },
      { binding: 9, resource: iblLutSampler },
      { binding: 10, resource: { buffer: iblShPlaceholderBuffer } },
      // Beer shadow map placeholder until the hi-fi flag turns it on.
      { binding: 11, resource: beerShadowPlaceholderView },
      { binding: 12, resource: beerShadowSampler },
    ],
  });

  const integrateBindGroup = device.createBindGroup({
    label: "VolumetricFog_IntegrateBindGroup",
    layout: integrateBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: scatteringView },
      { binding: 5, resource: integratedView },
    ],
  });

  // Temporal resolve pass resources. The resolve pass reprojects the previous
  // frame's integrated volume, neighbourhood-clamps it, exponentially blends
  // it with the current march, and writes the new history. It is dispatched
  // only when temporal is on; otherwise the 1×1×1 placeholder history below
  // keeps the bind-group layout valid, the pass is never recorded, and the
  // integrate output reaches the composite unchanged.
  //
  // That placeholder history — a storage write plus a filterable sample — is
  // bound on the off path so the resolve layout is constant and never forks.
  // It is tiny, and never sampled, because the resolve pass does not run.
  const temporalPlaceholderTexture = device.createTexture({
    label: "VolumetricFog_TemporalPlaceholder",
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: "rgba16float",
    dimension: "3d",
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
  const temporalPlaceholderStorageView = temporalPlaceholderTexture.createView({
    label: "VolumetricFog_TemporalPlaceholder_StorageView",
    dimension: "3d",
  });
  const temporalPlaceholderSampleView = temporalPlaceholderTexture.createView({
    label: "VolumetricFog_TemporalPlaceholder_SampleView",
    dimension: "3d",
  });

  // Linear (non-comparison) sampler for the 3D reprojection lookup — clamps
  // out-of-grid reprojections to the edge (disocclusion is handled in WGSL by
  // a UV-range reject, but clamp keeps the sample valid in all cases).
  const temporalSampler = device.createSampler({
    label: "VolumetricFog_TemporalSampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });

  // Resolve BGL: temporal uniforms + current integrated (sample) + history
  // read (sample) + sampler + history write (storage).
  const temporalResolveBindGroupLayout = makeBindGroupLayout(
    device,
    "VolumetricFog_TemporalResolveBGL",
    [
      uniformBuffer(0, Stage.COMPUTE),
      texture(1, Stage.COMPUTE, { viewDimension: "3d" }), // current integrated
      texture(2, Stage.COMPUTE, { viewDimension: "3d" }), // previous history
      sampler(3, Stage.COMPUTE),
      {
        binding: 4,
        visibility: Stage.COMPUTE,
        storageTexture: writeStorageEntry, // new history out (3d rgba16float)
      },
    ],
  );

  const temporalResolveLayout = device.createPipelineLayout({
    label: "VolumetricFog_TemporalResolveLayout",
    bindGroupLayouts: [temporalResolveBindGroupLayout],
  });
  let temporalResolvePipeline: GPUComputePipeline;
  if (computeCache) {
    temporalResolvePipeline = computeCache.getOrCreateSync({
      name: "VolumetricFog_TemporalResolvePipeline",
      layout: temporalResolveLayout,
      compute: { module: computeShaderModule, entryPoint: "temporalResolve" },
    });
  } else {
    temporalResolvePipeline = device.createComputePipeline({
      label: "VolumetricFog_TemporalResolvePipeline",
      layout: temporalResolveLayout,
      compute: { module: computeShaderModule, entryPoint: "temporalResolve" },
    });
  }

  const temporalUniformData = new Float32Array(FOG_TEMPORAL_UNIFORMS_FLOATS);
  const temporalUniformBuffer = device.createBuffer({
    label: "VolumetricFog_TemporalUniforms",
    size: Math.max(FOG_TEMPORAL_UNIFORMS_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Composite pass resources. The composite shader routes through the
  // per-device module cache.
  const compositeShaderModule = moduleCache.getOrCreate(
    ShaderSourceId.VOLUMETRIC_FOG_COMPOSITE,
    VolumetricFogCompositeSource,
    0,
    "VolumetricFog_Composite",
  );

  const compositeBindGroupLayout = makeBindGroupLayout(
    device,
    "VolumetricFog_CompositeBGL",
    [
      uniformBuffer(0, Stage.VERTEX_FRAGMENT),
      sampler(1, Stage.FRAGMENT),
      texture(2, Stage.FRAGMENT),
      // A plain float texture, not `{ sampleType: "depth" }`: the renderer
      // binds the float depth-resolve texture here, so a depth sample type
      // makes the bind group invalid the first time ground fog activates this
      // composite. Float matches both the bound view and the WGSL
      // `texture_2d<f32>` declaration.
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT, { viewDimension: "3d" }),
    ],
  );

  const compositePipelineLayout = device.createPipelineLayout({
    label: "VolumetricFog_CompositePipelineLayout",
    bindGroupLayouts: [compositeBindGroupLayout],
  });

  // Descriptor-only construction; the pipeline itself materializes through
  // the central cache in `composite()`'s `tryResolveCompositePipeline`, so
  // two contexts with volumetric fog enabled share one composite pipeline.
  const compositeDescriptor: WebGPURenderPipelineDescriptor = {
    name: "VolumetricFog_CompositePipeline",
    layout: compositePipelineLayout,
    vertex: { module: compositeShaderModule, entryPoint: "vertexMain" },
    fragment: {
      module: compositeShaderModule,
      entryPoint: "fragmentMain",
      // The output format gets set when the bind group is built
      // (we don't know it at allocation time). The pipeline is
      // created with `bgra8unorm` as a placeholder; the real format
      // is verified at composite() call time.
      targets: [{ format: "bgra8unorm" }],
    },
    primitive: { topology: "triangle-list" },
  };
  const compositePipelineEntry = {
    descriptor: compositeDescriptor,
    pipeline: null as GPURenderPipeline | null,
    pending: false,
  };

  const compositeUniformData = new Float32Array(COMPOSITE_UNIFORMS_FLOATS);
  const compositeUniformBuffer = device.createBuffer({
    label: "VolumetricFog_CompositeUniforms",
    size: Math.max(COMPOSITE_UNIFORMS_BYTES, 256),
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const compositeSampler = device.createSampler({
    label: "VolumetricFog_CompositeSampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    addressModeW: "clamp-to-edge",
  });

  return {
    resolutionKey: quality,
    width: dims.width,
    height: dims.height,
    depth: dims.depth,
    densityTexture,
    densityView,
    scatteringTexture,
    scatteringView,
    integratedTexture,
    integratedView,
    integratedSampleView,
    computeShaderModule,
    densityBindGroupLayout,
    densityPipeline,
    densityBindGroup,
    scatteringBindGroupLayout,
    scatteringPipeline,
    scatteringBindGroup,
    scatteringBoundShadowView: shadowPlaceholderView,
    integrateBindGroupLayout,
    integratePipeline,
    integrateBindGroup,
    // Temporal resolve resources. The history pair is not allocated here,
    // only when the flag is set, in the renderer; the placeholder and the
    // resolve pipeline are built up front, cheaply, so enabling temporal at
    // runtime needs no full resource rebuild.
    temporalHistoryAllocated: false,
    temporalHistoryTexture: [null, null],
    temporalHistoryStorageView: [null, null],
    temporalHistorySampleView: [null, null],
    temporalRead: 0,
    temporalFirstFrame: true,
    temporalPlaceholderTexture,
    temporalPlaceholderStorageView,
    temporalPlaceholderSampleView,
    temporalResolveBindGroupLayout,
    temporalResolvePipeline,
    temporalUniformBuffer,
    temporalUniformData,
    temporalSampler,
    temporalResolveBindGroups: [null, null],
    temporalResolveBindGroupNextSlot: 0,
    shadowPlaceholderTexture,
    shadowPlaceholderView,
    shadowComparisonSampler,
    // Sky-LUT / image-based ambient resources.
    iblTransmittancePlaceholderTexture,
    iblTransmittancePlaceholderView,
    iblLutSampler,
    iblShPlaceholderBuffer,
    scatteringBoundTransmittanceView: iblTransmittancePlaceholderView,
    scatteringBoundShBuffer: iblShPlaceholderBuffer,
    // Beer shadow map placeholder and sampler.
    beerShadowPlaceholderTexture,
    beerShadowPlaceholderView,
    beerShadowSampler,
    scatteringBoundBeerShadowView: beerShadowPlaceholderView,
    paramsBuffer,
    paramsData,
    paramsU32,
    compositeShaderModule,
    compositeBindGroupLayout,
    compositePipeline: null,
    compositePipelineEntry,
    compositeUniformBuffer,
    compositeUniformData,
    compositeSampler,
    compositeBindGroups: [null, null],
    compositeBindGroupNextSlot: 0,
  };
}
