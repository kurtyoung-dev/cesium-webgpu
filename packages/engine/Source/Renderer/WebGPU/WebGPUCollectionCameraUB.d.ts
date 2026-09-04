// Co-located ambient types for the JS helper `WebGPUCollectionCameraUB.js`.
// `allowJs: true, checkJs: false` means this sibling
// `.d.ts` overrides JS inference for `.ts` importers (WebGPUCloudRenderer.ts).
// See packages/engine/Source/Renderer/{Context,Texture}.d.ts as templates.

/**
 * One group-0 bind-group entry beyond the camera buffer (binding 0):
 * atlas texture/sampler, globe-depth view/sampler, noise texture, etc.
 */
export interface CollectionCameraUBExtraEntry {
  binding: number;
  resource: GPUBindingResource;
}

export interface CollectionCameraUBResolverOptions {
  /** Camera UB size in bytes. */
  bufferSize: number;
  /** The group's bind-group layout. */
  bindGroupLayout: GPUBindGroupLayout;
  /** Repacks the camera UB for the CURRENT slice into the supplied array. */
  pack: (data: Float32Array) => void;
  /** group-0 entries beyond the camera buffer (binding 0). */
  extraEntries?: CollectionCameraUBExtraEntry[];
  /** Binding slot of the camera UB (default 0). */
  cameraBinding?: number;
}

/**
 * Per-frustum camera uniform-buffer resolver for collection feature renderers.
 * Owns a per-collection pool of per-slice camera UB buffers + bind groups,
 * selected at draw time by `uniformState._currentSliceIndex`.
 */
export default class WebGPUCollectionCameraUB {
  constructor(device: GPUDevice, label?: string);
  /** Bind the shared uniformState the resolver reads `_currentSliceIndex` from. */
  bindUniformState(uniformState: unknown): void;
  /** Produce a `bindGroupResolvers[i]` closure for this frame. */
  makeResolver(
    opts: CollectionCameraUBResolverOptions,
  ): () => GPUBindGroup | null;
  /** Release all per-slice GPU buffers. */
  destroy(): void;
}
