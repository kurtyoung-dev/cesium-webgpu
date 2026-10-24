/// <reference types="@webgpu/types" />
/**
 * @purpose Uploads a global bathymetry tensor LUT to a WebGPU device as an
 * `rgba8unorm` equirectangular texture, cached per device.
 * @status experimental: no renderer consumes the handle yet; the sampler side
 * of the water shaders still reads the per-tile hydro data. Lives here, not in
 * `Scene/BathymetryTensorMap.ts`, because device and usage-flag code is
 * backend-specific (scene code stays backend-agnostic).
 */
import {
  buildProceduralBathymetryTensor,
  type BathymetryTensorSet,
} from "../../Scene/BathymetryTensorMap.js";

export interface BathymetryGpuTextureHandle {
  texture: unknown;
  sampler: unknown;
  width: number;
  height: number;
}

interface DestroyableTexture {
  destroy?: () => void;
}

const _deviceBathymetryTextureCache = new WeakMap<
  object,
  BathymetryGpuTextureHandle
>();

/**
 * Uploads a `BathymetryTensorSet` (or a default procedural Level 0 tensor) into
 * a shared WebGPU `rgba8unorm` 2D equirectangular LUT texture with antimeridian
 * repeat-X / clamp-Y linear sampling, cached per `GPUDevice`. An explicit
 * `tensorSet` always re-uploads and destroys the texture it replaces, so
 * repeated uploads do not accumulate GPU memory.
 */
export function uploadBathymetryTensorTexture(
  device: {
    createTexture: (desc: Record<string, unknown>) => unknown;
    createSampler: (desc: Record<string, unknown>) => unknown;
    queue: {
      writeTexture: (
        dest: Record<string, unknown>,
        data: Uint8Array,
        layout: Record<string, unknown>,
        size: Record<string, unknown>,
      ) => void;
    };
  },
  tensorSet?: BathymetryTensorSet,
): BathymetryGpuTextureHandle {
  const existing = _deviceBathymetryTextureCache.get(device);
  if (existing && !tensorSet) {
    return existing;
  }
  const tensor = tensorSet ?? buildProceduralBathymetryTensor(360, 181);
  const usage =
    typeof GPUTextureUsage !== "undefined"
      ? GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      : 0x04 | 0x02;
  const texture = device.createTexture({
    label: "Global BathymetryTensorMap LUT",
    size: { width: tensor.width, height: tensor.height, depthOrArrayLayers: 1 },
    format: "rgba8unorm",
    usage,
  });
  device.queue.writeTexture(
    { texture },
    tensor.bathymetryBytes,
    { bytesPerRow: tensor.width * 4, rowsPerImage: tensor.height },
    { width: tensor.width, height: tensor.height, depthOrArrayLayers: 1 },
  );
  const sampler = device.createSampler({
    label: "Global BathymetryTensorMap Sampler",
    addressModeU: "repeat",
    addressModeV: "clamp-to-edge",
    magFilter: "linear",
    minFilter: "linear",
  });
  const handle: BathymetryGpuTextureHandle = {
    texture,
    sampler,
    width: tensor.width,
    height: tensor.height,
  };
  _deviceBathymetryTextureCache.set(device, handle);
  if (existing) {
    (existing.texture as DestroyableTexture | undefined)?.destroy?.();
  }
  return handle;
}
