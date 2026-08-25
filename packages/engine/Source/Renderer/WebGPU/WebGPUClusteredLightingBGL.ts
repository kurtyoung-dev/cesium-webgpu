/// <reference types="@webgpu/types" />
/**
 * Per-device helpers for clustered-lighting resources in the effects bind
 * group.
 *
 * Supported Windows D3D12 and Vulkan devices expose `maxBindGroups = 4`, so
 * clustered lighting shares the effects group instead of allocating a fifth
 * group. Bindings 18..22 contain the punctual-light records, cluster bounds,
 * per-cluster counts and indices, and the parameter uniform. Binding 23
 * contains the LTC lookup texture, and binding 25 contains area-light records.
 * Binding 24 is unused because the lookup uses `textureLoad` without a sampler.
 *
 * All entries are fragment-visible because cluster lookup and light evaluation
 * happen in the fragment stage.
 * {@link CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES} supplies the layout
 * entries, and
 * {@link getClusteredLightingPlaceholders} supplies valid resources with zero
 * active counts when no dispatcher resources are bound.
 *
 * `getClusteredLightingBGL` and `buildClusteredLightingBindGroup` support the
 * dispatcher's `consumerBindGroup` compatibility getter. That getter creates a
 * separate group-4 bind group; current consumer pipelines bind the shared
 * effects group and do not consume it.
 *
 * @module WebGPUClusteredLightingBGL
 */

// Use numeric stage fallbacks because `GPUShaderStage` is absent when this
// module is evaluated on a host without WebGPU.
import { Stage } from "./WebGPUBindGroupLayoutHelpers.js";

/**
 * Starting binding index for clustered lighting in the effects group.
 * Effects bindings 0..17 are claimed by shadow/clip/SDF/atmosphere/CSM/
 * edges/cube-depth resources; clustered-lighting resources start at 18.
 */
export const CLUSTERED_LIGHTING_EFFECTS_BINDING_BASE = 18;

/**
 * Literal token used for the `@group(N)` index in the ClusteredLighting
 * WGSL chunk (`Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl`).
 * The chunk can't hardcode a group number because the effects bind group
 * lands at different group indices across pipelines: Model PBR always has
 * it at group 3, but primitive `Mat*Lit` shaders have it at group 2 (no
 * texture group) or group 3 (texture group occupies group 2). Each prepend
 * site substitutes the correct index via {@link substituteClusteredLightingGroup}.
 */
export const CLUSTERED_LIGHTING_GROUP_TOKEN = "__CL_GROUP__";

/**
 * Substitute the `__CL_GROUP__` token in the ClusteredLighting chunk with
 * the concrete effects-group index for the consuming pipeline, ready to
 * prepend to the consumer's WGSL source.
 *
 * @param chunkSource The raw ClusteredLighting chunk string (the generated
 *   `.js` export of `ClusteredLighting.wgsl`).
 * @param effectsGroup The group index the effects BGL occupies in the
 *   consumer's pipeline layout (3 for Model PBR; 2 or 3 for primitives).
 */
export function substituteClusteredLightingGroup(
  chunkSource: string,
  effectsGroup: number,
): string {
  return chunkSource
    .split(CLUSTERED_LIGHTING_GROUP_TOKEN)
    .join(String(effectsGroup));
}

/**
 * Bind-group layout entries for clustered lighting, ready to spread into the
 * effects layout. Bindings 18..21 are read-only storage for
 * `clusterLights`, `clusterAABBs`, `perClusterLightCount`, and
 * `perClusterLightIndices`. Binding 22 is the `clusterParams` uniform,
 * binding 23 is the LTC lookup texture, and binding 25 is area-light storage.
 *
 * All entries are fragment-visible. The WGSL chunk declares the same binding
 * numbers under the effects-group index supplied by the consuming pipeline.
 */
export const CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES: ReadonlyArray<GPUBindGroupLayoutEntry> =
  [
    {
      binding: 18,
      visibility: Stage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 19,
      visibility: Stage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 20,
      visibility: Stage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 21,
      visibility: Stage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
    {
      binding: 22,
      visibility: Stage.FRAGMENT,
      buffer: { type: "uniform" },
    },
    // The LTC LUT uses `textureLoad` and manual bilinear interpolation because
    // the Model PBR fragment stage already consumes the 16 available samplers.
    // Its unfilterable-float sample type is valid without a filtering sampler.
    // These entries remain in the shared layout; placeholders keep it valid
    // when no area lights exist, and `activeLightCount.y = 0` gates all reads.
    {
      binding: 23,
      visibility: Stage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" },
    },
    {
      binding: 25,
      visibility: Stage.FRAGMENT,
      buffer: { type: "read-only-storage" },
    },
  ];

/**
 * Per-device placeholder resources for clustered-lighting bindings.
 * `params` is zero-filled so the fragment shader returns before reading the
 * storage buffers or LTC texture.
 *
 * Storage buffer sizes must each be at least one element of the
 * matching WGSL array type, because WebGPU validates the bound buffer
 * size against the pipeline's derived `minBindingSize` for unsized
 * `array<T>` storage variables at draw time. With smaller placeholders
 * the validator rejects the pipeline ("buffer binding is too small")
 * even though the fragment shader short-circuits on `activeLightCount = 0`
 * at execution time.
 *
 * Sizes per binding (match the WGSL declarations in
 * `Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl`):
 *
 *   - clusterLights         : `array<ClusteredLight>`  — 80 B per element
 *   - clusterAABBs          : `array<ClusteredAABB>`   — 32 B per element
 *   - perClusterLightCount  : `array<u32>`             — 4 B per element
 *   - perClusterLightIndices: `array<u32>`             — 4 B per element
 *   - params                : `ClusteredParams` uniform — 32 B
 *   - areaLights            : `array<LTCAreaLight>`     — 96 B per element
 *   - ltcLUT                : 1×1×2 `rgba16float` placeholder texture
 */
export interface ClusteredLightingPlaceholderBuffers {
  clusterLights: GPUBuffer;
  clusterAABBs: GPUBuffer;
  perClusterLightCount: GPUBuffer;
  perClusterLightIndices: GPUBuffer;
  params: GPUBuffer;
  // Bindings 23 and 25 use texture and storage placeholders. The LUT is read
  // with `textureLoad`, so no sampler placeholder is required.
  ltcLUTView: GPUTextureView;
  areaLights: GPUBuffer;
  /** Retained so device-loss cleanup can destroy the placeholder texture. */
  ltcLUTTexture: GPUTexture;
}

const _placeholderCache = new WeakMap<
  GPUDevice,
  ClusteredLightingPlaceholderBuffers
>();

export function getClusteredLightingPlaceholders(
  device: GPUDevice,
): ClusteredLightingPlaceholderBuffers {
  const cached = _placeholderCache.get(device);
  if (cached) return cached;

  const makeStorage = (label: string, size: number): GPUBuffer => {
    const buf = device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Placeholder params keep both active counts at zero, so these bytes are
    // never read by the shader. Zero initialization keeps diagnostic readback
    // deterministic.
    device.queue.writeBuffer(buf, 0, new Uint8Array(size));
    return buf;
  };

  const params = device.createBuffer({
    label: "ClusteredLighting placeholder params (activeLightCount=0)",
    size: 32, // 2 vec4 = 32 bytes — matches the WGSL ClusteredParams layout
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(params, 0, new Float32Array(8));

  // A one-texel LUT in each layer and one zeroed 96-byte `LTCAreaLight` record
  // satisfy bindings 23 and 25 while `activeLightCount.y` is zero.
  const ltcLUTTexture = device.createTexture({
    label: "LTC LUT placeholder (1x1x2 rgba16float)",
    size: { width: 1, height: 1, depthOrArrayLayers: 2 },
    format: "rgba16float",
    dimension: "2d",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Zero-fill both layers (8 B/texel × 1 texel × 2 layers = 16 B).
  device.queue.writeTexture(
    { texture: ltcLUTTexture },
    new Uint8Array(16),
    { bytesPerRow: 8, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 2 },
  );

  const placeholders: ClusteredLightingPlaceholderBuffers = {
    // ClusteredLight = 5 vec4 = 80 bytes per element
    clusterLights: makeStorage(
      "ClusteredLighting placeholder clusterLights",
      80,
    ),
    // ClusteredAABB = 2 vec4 = 32 bytes per element
    clusterAABBs: makeStorage("ClusteredLighting placeholder clusterAABBs", 32),
    // array<u32> stride = 4 bytes
    perClusterLightCount: makeStorage(
      "ClusteredLighting placeholder perClusterLightCount",
      4,
    ),
    perClusterLightIndices: makeStorage(
      "ClusteredLighting placeholder perClusterLightIndices",
      4,
    ),
    params,
    // LTCAreaLight = 6 vec4 = 96 bytes per element
    areaLights: makeStorage("LTC area lights placeholder", 96),
    ltcLUTTexture,
    ltcLUTView: ltcLUTTexture.createView({ dimension: "2d-array" }),
  };
  _placeholderCache.set(device, placeholders);
  return placeholders;
}

/**
 * Drop the per-device placeholder cache entry. Called from
 * WebGPUContext device-loss recovery so the dead device's placeholder
 * buffers become unreachable immediately.
 */
export function clearClusteredLightingPlaceholdersForDevice(
  device: GPUDevice,
): void {
  _placeholderCache.delete(device);
}

// Compatibility group-4 helpers.

const _legacyBglCache = new WeakMap<GPUDevice, GPUBindGroupLayout>();

/**
 * @deprecated Consumer pipelines bind clustered resources through the effects
 * group. This layout serves the dispatcher's unconsumed `consumerBindGroup`
 * compatibility getter.
 */
export function getClusteredLightingBGL(device: GPUDevice): GPUBindGroupLayout {
  const cached = _legacyBglCache.get(device);
  if (cached) return cached;

  const bgl = device.createBindGroupLayout({
    label: "ClusteredLighting BGL (legacy @group(4), Batch 152 — unconsumed)",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  _legacyBglCache.set(device, bgl);
  return bgl;
}

/**
 * @deprecated Creates the compatibility bind group described by
 * `getClusteredLightingBGL`.
 */
export function buildClusteredLightingBindGroup(
  device: GPUDevice,
  buffers: {
    clusterLights: GPUBuffer;
    clusterAABBs: GPUBuffer;
    perClusterLightCount: GPUBuffer;
    perClusterLightIndices: GPUBuffer;
    params: GPUBuffer;
  },
): GPUBindGroup {
  return device.createBindGroup({
    label: "ClusteredLighting BG (legacy @group(4), unconsumed)",
    layout: getClusteredLightingBGL(device),
    entries: [
      { binding: 0, resource: { buffer: buffers.clusterLights } },
      { binding: 1, resource: { buffer: buffers.clusterAABBs } },
      { binding: 2, resource: { buffer: buffers.perClusterLightCount } },
      { binding: 3, resource: { buffer: buffers.perClusterLightIndices } },
      { binding: 4, resource: { buffer: buffers.params } },
    ],
  });
}
