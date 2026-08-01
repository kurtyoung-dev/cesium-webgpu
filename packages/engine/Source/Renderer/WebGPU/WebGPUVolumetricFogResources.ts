/// <reference types="@webgpu/types" />
/**
 * Volumetric-fog resource builder extracted from
 * `WebGPUVolumetricFogRenderer` (Batch 158 of the maintainability sweep).
 *
 * Owns the 412-LOC `_ensureResources` body: 3D texture allocation,
 * compute-pipeline creation (density / scattering / integrate), bind-
 * group + bind-group-layout construction, params UBO, sun-shadow
 * placeholder, composite-pipeline descriptor (resolved later via the
 * central pipeline cache), composite uniform buffer + sampler.
 *
 * The renderer's `_ensureResources` becomes a small cache-management
 * wrapper: check whether the existing resources match the requested
 * quality, dispose if they don't, call `buildVolumetricFogResources`
 * to allocate fresh ones, assign to `this._resources`, return.
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

  // ── 3D textures ──
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

  // ── Compute shader module + per-pass pipelines ──
  // Phase 5b uses one shader module containing all three entry points
  // and disjoint @binding numbers so we can declare write/read access
  // for the SAME texture without WGSL `@binding` collisions. Each
  // pipeline gets its own BGL containing only the bindings its entry
  // point references; WebGPU validates per-entry-point.
  // C-R7-SHADER-MODULE-DEDUP (Batch 74) — route the compute shader
  // through the per-device module cache. Pipeline-level dedup is
  // available via `context.webgpuComputePipelineCache` (Batch 76+) but
  // VolumetricFog is a scene-singleton, so direct pipeline creation
  // here is fine; adoption would only matter for the multi-instance
  // case.
  const moduleCache = getVolumetricFogShaderModuleCache(device);
  const computeShaderModule = moduleCache.getOrCreate(
    ShaderSourceId.VOLUMETRIC_FOG_COMPUTE,
    VolumetricFogComputeSource,
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
      // Batch 431 (FOG-IBL-AMBIENT) — atmosphere TRANSMITTANCE LUT
      // (rgba16float, filterable) + a linear (non-comparison) sampler for
      // the (cosZenith, altitude) lookup + the atmosphere-derived SH-L2
      // irradiance buffer (SHUniforms, 160 bytes). Bound unconditionally
      // (placeholders by default) so the layout never forks; the WGSL only
      // samples them when `u.iblAmbient.x >= 0.5`.
      texture(8, Stage.COMPUTE, { sampleType: "float" }),
      sampler(9, Stage.COMPUTE),
      uniformBuffer(10, Stage.COMPUTE),
      // Batch 437 (CLOUD-SHADOWS) — sun-view beer shadow map (binding 11) + a
      // linear sampler (binding 12). Bound unconditionally (1×1 zero placeholder
      // when the hi-fi flag is off → the legacy local-fbm path runs) so the layout
      // never forks; the WGSL samples them only inside `cloudShadowHiFi.x >= 0.5`.
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

  // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — route the three compute
  // pipelines through `webgpuComputePipelineCache` (sync path) so two
  // contexts with volumetric fog enabled share one pipeline per
  // (label, layout, entryPoint) tuple.
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

  // ── Params UBO ──
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

  // Batch 431 (FOG-IBL-AMBIENT) — sky-LUT / IBL ambient placeholders.
  // The scattering pass binds the atmosphere TRANSMITTANCE LUT (binding 8)
  // + a linear sampler (binding 9) + the atmosphere-derived SH-L2 buffer
  // (binding 10) UNCONDITIONALLY so the BGL is constant. Until the real
  // resources arrive (and on the OFF default forever), placeholders keep
  // the bind group valid. Mirrors AerialPerspectiveEffect's placeholder
  // pattern. The WGSL only samples them when `u.iblAmbient.x >= 0.5`, so
  // the placeholders are never read in the parity-default path.
  //
  // 1×1 white transmittance LUT — white = no extinction (so a stray read
  // can't darken anything). rgba16float white = 0x3C00 per channel.
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

  // Batch 437 (CLOUD-SHADOWS) — 1×1 ZERO r16float beer-shadow-map placeholder
  // (optical depth 0 → transmittance 1, no shadow) + a linear sampler. Bound at
  // bindings 11/12 when the hi-fi flag is off (the WGSL `sampleCloudShadow` then
  // takes the legacy local-fbm branch and never reads these). The real beer map is
  // swapped in by the renderer's per-frame bind-group rebuild when hi-fi is on.
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
      // Batch 431 — sky-LUT / IBL ambient (placeholders until real arrive).
      { binding: 8, resource: iblTransmittancePlaceholderView },
      { binding: 9, resource: iblLutSampler },
      { binding: 10, resource: { buffer: iblShPlaceholderBuffer } },
      // Batch 437 — beer shadow map placeholder until hi-fi flag turns it on.
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

  // ── Batch 435 (FOG-TEMPORAL) — temporal resolve pass resources ──
  // The resolve pass reprojects the previous frame's integrated volume,
  // neighborhood-clamps it, exponentially blends with the current march, and
  // writes the new history. It is dispatched ONLY when temporal is on; on the
  // default path the placeholder 1×1×1 history below keeps the BGL valid and
  // the pass is never recorded (so the integrate output reaches the composite
  // unchanged → byte-identical parity).
  //
  // 1×1×1 placeholder history (storage write + filterable sample) — bound on
  // the OFF path so the resolve BGL is constant and never forks. Tiny; never
  // sampled in the parity-default path (the resolve pass doesn't run).
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

  // ── Composite pass resources ──
  // C-R7-SHADER-MODULE-DEDUP (Batch 74) — route the composite shader
  // through the per-device module cache.
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
      // Batch 420 — LATENT FIX. Was `{ sampleType: "depth" }`, but the
      // renderer binds the FLOAT depth-resolve texture here (sample type
      // Float), so the depth sampleType made the bind group invalid the
      // first time ground fog activated this composite. Plain float texture
      // matches the bound view + the WGSL `texture_2d<f32>` declaration.
      texture(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT, { viewDimension: "3d" }),
    ],
  );

  const compositePipelineLayout = device.createPipelineLayout({
    label: "VolumetricFog_CompositePipelineLayout",
    bindGroupLayouts: [compositeBindGroupLayout],
  });

  // C-R7-RENDERER-MIGRATION (Batch 74) — descriptor-only construction;
  // the actual pipeline materializes through the central cache via
  // `tryResolveCompositePipeline` in `composite()`. Two contexts with
  // volumetric fog enabled share one composite pipeline.
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
    // Batch 435 (FOG-TEMPORAL) — temporal resolve resources. History pair is
    // NOT allocated here (only when the flag is set, in the renderer); the
    // placeholder + resolve pipeline are built up-front (cheap) so enabling
    // temporal at runtime doesn't need a full resource rebuild.
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
    // Batch 431 (FOG-IBL-AMBIENT) — sky-LUT / IBL ambient resources.
    iblTransmittancePlaceholderTexture,
    iblTransmittancePlaceholderView,
    iblLutSampler,
    iblShPlaceholderBuffer,
    scatteringBoundTransmittanceView: iblTransmittancePlaceholderView,
    scatteringBoundShBuffer: iblShPlaceholderBuffer,
    // Batch 437 (CLOUD-SHADOWS) — beer shadow map placeholder + sampler.
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
