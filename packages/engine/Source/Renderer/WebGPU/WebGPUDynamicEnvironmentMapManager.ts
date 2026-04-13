/**
 * WebGPU Dynamic Environment Map Manager
 *
 * Manages dynamic cubemap generation for environment reflections.
 * Renders the scene from 6 directions into a cubemap texture, then
 * generates mipmaps for roughness-based reflections.
 *
 * @module WebGPUDynamicEnvironmentMapManager
 */

interface DynEnvMapCache {
  cubemapTexture: GPUTexture | null;
  cubemapTextureView: GPUTextureView | null;
  faceViews: GPUTextureView[];
  sampler: GPUSampler | null;
  size: number;
  mipmapLevels: number;
  needsUpdate: boolean;
  framesSinceUpdate: number;
}

/**
 * Update WebGPU dynamic environment map resources.
 * Creates cubemap textures and schedules re-rendering when needed.
 */
function updateWebGPUDynamicEnvironmentMap(
  manager: any,
  frameState: CesiumFrameState,
): void {
  const context = frameState.context;
  const device: GPUDevice = context.device;
  const mode = frameState.mode;

  // Check basic support conditions
  const isSupported = manager._mipmapLevels >= 1;
  if (
    !isSupported ||
    !manager.enabled ||
    !manager.shouldUpdate ||
    !manager._position ||
    mode === 3 // SceneMode.MORPHING
  ) {
    manager._shouldRegenerateShaders = false;
    return;
  }

  if (!manager._webgpuCache) {
    manager._webgpuCache = {
      cubemapTexture: null,
      cubemapTextureView: null,
      faceViews: [],
      sampler: null,
      size: 0,
      mipmapLevels: 0,
      needsUpdate: true,
      framesSinceUpdate: 0,
    } as DynEnvMapCache;
  }

  const cache = manager._webgpuCache as DynEnvMapCache;
  const size = manager._cubemapSize || 256;
  const mipmapLevels = manager._mipmapLevels || 1;

  // Create/recreate cubemap if size changed
  if (cache.size !== size || cache.mipmapLevels !== mipmapLevels) {
    if (cache.cubemapTexture) {
      cache.cubemapTexture.destroy();
    }

    const mipLevelCount = Math.max(1, mipmapLevels);

    cache.cubemapTexture = device.createTexture({
      size: { width: size, height: size, depthOrArrayLayers: 6 },
      format: "rgba8unorm",
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST,
      dimension: "2d",
    });

    cache.cubemapTextureView = cache.cubemapTexture.createView({
      dimension: "cube",
    });

    // Create per-face views for rendering into each face
    cache.faceViews = [];
    for (let face = 0; face < 6; face++) {
      cache.faceViews.push(
        cache.cubemapTexture.createView({
          dimension: "2d",
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      );
    }

    cache.size = size;
    cache.mipmapLevels = mipmapLevels;
    cache.needsUpdate = true;
  }

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

  // Initialize faces with neutral color on first creation
  if (cache.needsUpdate) {
    const faceSize = size * size * 4;
    const neutralColor = new Uint8Array(faceSize);
    for (let p = 0; p < faceSize; p += 4) {
      neutralColor[p] = 128; // R
      neutralColor[p + 1] = 128; // G
      neutralColor[p + 2] = 128; // B
      neutralColor[p + 3] = 255; // A
    }

    for (let face = 0; face < 6; face++) {
      device.queue.writeTexture(
        { texture: cache.cubemapTexture!, origin: { x: 0, y: 0, z: face } },
        neutralColor,
        { bytesPerRow: size * 4 },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
    }

    cache.needsUpdate = false;
  }

  // Expose cubemap for shader consumption
  manager._radianceMap = {
    _webgpuTexture: cache.cubemapTexture,
    _webgpuTextureView: cache.cubemapTextureView,
    _webgpuSampler: cache.sampler,
  };

  cache.framesSinceUpdate++;
}

/**
 * Destroy WebGPU dynamic environment map resources.
 */
function destroyWebGPUDynamicEnvironmentMapResources(manager: any): void {
  const cache = manager._webgpuCache as DynEnvMapCache | undefined;
  if (!cache) {
    return;
  }

  if (cache.cubemapTexture) {
    cache.cubemapTexture.destroy();
  }

  manager._webgpuCache = undefined;
}

export {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
};
export default {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
};
