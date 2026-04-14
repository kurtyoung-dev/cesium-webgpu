/**
 * Typed helpers for building WebGPU bind-group layouts and their entries.
 *
 * Raw `device.createBindGroupLayout({ entries: [{ binding, visibility, … }] })`
 * calls work fine, but each entry repeats 4-5 lines of boilerplate and often
 * needs a `"uniform" as GPUBufferBindingType` cast. The helpers below collapse
 * each entry to a one-liner with the GPU binding-type string literals fully
 * inferred, no casts, and a short label for compatibility with the WGPU
 * validation layer's error messages.
 *
 * Adoption pattern — when editing an existing renderer, replace the
 * `createBindGroupLayout({ entries: [...] })` call with `makeBindGroupLayout(
 * device, "label", [entryFn(binding), …])`. New code should adopt these
 * helpers by default. Do NOT wrap a single existing call just for the sake
 * of it; the payoff comes from eliminating the cast + visibility boilerplate.
 *
 * @private
 */

/** Shorthand for the GPUShaderStage combinations we actually use. */
export const Stage = {
  COMPUTE: GPUShaderStage.COMPUTE,
  VERTEX: GPUShaderStage.VERTEX,
  FRAGMENT: GPUShaderStage.FRAGMENT,
  VERTEX_FRAGMENT: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
  ALL: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
} as const;

/** Builds a uniform-buffer entry. */
export function uniformBuffer(
  binding: number,
  visibility: GPUShaderStageFlags,
  options?: { hasDynamicOffset?: boolean; minBindingSize?: number },
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    buffer: {
      type: "uniform",
      hasDynamicOffset: options?.hasDynamicOffset,
      minBindingSize: options?.minBindingSize,
    },
  };
}

/** Builds a storage-buffer entry. Set `readOnly: true` for read-only-storage. */
export function storageBuffer(
  binding: number,
  visibility: GPUShaderStageFlags,
  options?: { readOnly?: boolean; hasDynamicOffset?: boolean },
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    buffer: {
      type: options?.readOnly ? "read-only-storage" : "storage",
      hasDynamicOffset: options?.hasDynamicOffset,
    },
  };
}

/** Builds a sampled-texture entry (default: 2D float). */
export function texture(
  binding: number,
  visibility: GPUShaderStageFlags,
  options?: {
    sampleType?: GPUTextureSampleType;
    viewDimension?: GPUTextureViewDimension;
    multisampled?: boolean;
  },
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    texture: {
      sampleType: options?.sampleType ?? "float",
      viewDimension: options?.viewDimension ?? "2d",
      multisampled: options?.multisampled,
    },
  };
}

/** Builds a storage-texture entry. */
export function storageTexture(
  binding: number,
  visibility: GPUShaderStageFlags,
  format: GPUTextureFormat,
  options?: {
    access?: GPUStorageTextureAccess;
    viewDimension?: GPUTextureViewDimension;
  },
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    storageTexture: {
      format,
      access: options?.access ?? "write-only",
      viewDimension: options?.viewDimension ?? "2d",
    },
  };
}

/** Builds a sampler entry. */
export function sampler(
  binding: number,
  visibility: GPUShaderStageFlags,
  type: GPUSamplerBindingType = "filtering",
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    sampler: { type },
  };
}

/**
 * Convenience factory for a labeled bind-group layout. The label lands in
 * WebGPU validation errors so `grep`-friendly names are worth the keystroke.
 */
export function makeBindGroupLayout(
  device: GPUDevice,
  label: string,
  entries: readonly GPUBindGroupLayoutEntry[],
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label,
    entries: entries as GPUBindGroupLayoutEntry[],
  });
}
