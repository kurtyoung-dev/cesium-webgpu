/**
 * WebGPU Image-Based Lighting Manager
 *
 * Manages IBL resources for WebGPU PBR rendering:
 * - BRDF LUT texture (via WebGPUBrdfLutGenerator)
 * - Specular environment map (cubemap for reflections)
 * - Diffuse irradiance (spherical harmonics or cubemap)
 *
 * @module WebGPUImageBasedLighting
 */

interface IBLCache {
  brdfLutGenerated: boolean;
  specularTexture: GPUTexture | null;
  specularTextureView: GPUTextureView | null;
  diffuseTexture: GPUTexture | null;
  diffuseTextureView: GPUTextureView | null;
  sampler: GPUSampler | null;
  defaultSpecularCreated: boolean;
  defaultDiffuseCreated: boolean;
}

/**
 * Creates a 1x1 default specular cubemap (white) for fallback IBL.
 */
function createDefaultSpecularCubemap(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const texture = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: "2d",
  });

  // Fill all 6 faces with white
  const whitePixel = new Uint8Array([255, 255, 255, 255]);
  for (let face = 0; face < 6; face++) {
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: face } },
      whitePixel,
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  const view = texture.createView({ dimension: "cube" });
  return { texture, view };
}

/**
 * Creates a 1x1 default diffuse irradiance cubemap (ambient gray).
 */
function createDefaultDiffuseCubemap(device: GPUDevice): {
  texture: GPUTexture;
  view: GPUTextureView;
} {
  const texture = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 6 },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    dimension: "2d",
  });

  // Fill all 6 faces with ambient gray
  const grayPixel = new Uint8Array([128, 128, 128, 255]);
  for (let face = 0; face < 6; face++) {
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0, z: face } },
      grayPixel,
      { bytesPerRow: 4 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  const view = texture.createView({ dimension: "cube" });
  return { texture, view };
}

/**
 * Update IBL resources for WebGPU rendering.
 * Called from ImageBasedLighting.update() when context.isWebGPU.
 */
function updateWebGPUImageBasedLighting(ibl: any, frameState: any): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;

  if (!ibl._webgpuCache) {
    ibl._webgpuCache = {
      brdfLutGenerated: false,
      specularTexture: null,
      specularTextureView: null,
      diffuseTexture: null,
      diffuseTextureView: null,
      sampler: null,
      defaultSpecularCreated: false,
      defaultDiffuseCreated: false,
    } as IBLCache;
  }

  const cache = ibl._webgpuCache as IBLCache;

  // Skip duplicate frames
  if (
    frameState.frameNumber === ibl._previousFrameNumber &&
    frameState.context === ibl._previousFrameContext
  ) {
    return;
  }
  ibl._previousFrameNumber = frameState.frameNumber;
  ibl._previousFrameContext = frameState.context;

  // Generate BRDF LUT via the frameState's brdfLutGenerator
  if (frameState.brdfLutGenerator) {
    frameState.brdfLutGenerator.update(frameState);
  }

  // Create default sampler
  if (!cache.sampler) {
    cache.sampler = device.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
  }

  // Create default specular cubemap if none provided
  if (!cache.defaultSpecularCreated) {
    const spec = createDefaultSpecularCubemap(device);
    cache.specularTexture = spec.texture;
    cache.specularTextureView = spec.view;
    cache.defaultSpecularCreated = true;
  }

  // Create default diffuse cubemap if none provided
  if (!cache.defaultDiffuseCreated) {
    const diff = createDefaultDiffuseCubemap(device);
    cache.diffuseTexture = diff.texture;
    cache.diffuseTextureView = diff.view;
    cache.defaultDiffuseCreated = true;
  }

  // If user-provided specular environment map exists, upload it
  if (
    ibl._specularEnvironmentCubeMap &&
    ibl._specularEnvironmentCubeMap._texture
  ) {
    // The user-provided cubemap is already managed externally
    // We just need to ensure our cache references are updated
  }
}

/**
 * Destroy WebGPU IBL resources.
 */
function destroyWebGPUImageBasedLightingResources(ibl: any): void {
  const cache = ibl._webgpuCache as IBLCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.specularTexture) {
    cache.specularTexture.destroy();
  }
  if (cache.diffuseTexture) {
    cache.diffuseTexture.destroy();
  }

  ibl._webgpuCache = undefined;
}

export {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
export default {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
};
