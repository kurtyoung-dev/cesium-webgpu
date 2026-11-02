import CloudNoiseBoundsSource from "../../Shaders/WebGPU/Compute/CloudNoiseBounds.js";

export interface CloudNoiseBounds {
  shape: GPUTexture;
  detail: GPUTexture;
  shapeView: GPUTextureView;
  detailView: GPUTextureView;
  bytes: number;
  destroy(): void;
}

const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline[]>>();

function getPipelines(device: GPUDevice): Promise<GPUComputePipeline[]> {
  let entry = pipelines.get(device);
  if (!entry) {
    const module = device.createShaderModule({
      label: "Cloud noise bounds",
      code: CloudNoiseBoundsSource,
    });
    entry = Promise.all(
      ["seedCloudNoiseBounds", "reduceCloudNoiseBounds"].map((entryPoint) =>
        device.createComputePipelineAsync({
          label: entryPoint,
          layout: "auto",
          compute: { module, entryPoint },
        }),
      ),
    );
    pipelines.set(device, entry);
    entry.catch(() => pipelines.delete(device));
  }
  return entry;
}

export async function createCloudNoiseBounds(
  device: GPUDevice,
  shape: GPUTexture,
  detail: GPUTexture,
  isCurrent: () => boolean = () => true,
): Promise<CloudNoiseBounds> {
  for (const texture of [shape, detail]) {
    const size = texture.width;
    if (
      size < 2 ||
      (size & (size - 1)) !== 0 ||
      texture.height !== size ||
      texture.depthOrArrayLayers !== size ||
      texture.format !== "rgba8unorm"
    ) {
      throw new Error(
        "Cloud noise bounds require power-of-two rgba8unorm cubes",
      );
    }
  }
  const [seed, reduce] = await getPipelines(device);
  if (!isCurrent()) {
    throw new Error("Cloud noise bound request expired.");
  }
  const allocated: GPUTexture[] = [];
  let bytes = 0;
  try {
    const encoder = device.createCommandEncoder({
      label: "Cloud noise bounds",
    });
    for (const [index, source] of [shape, detail].entries()) {
      const size = source.width / 2;
      const levels = Math.log2(size) + 1;
      const texture = device.createTexture({
        label: index === 0 ? "Cloud shape bounds" : "Cloud warp bounds",
        size: [size, size, size],
        dimension: "3d",
        format: "rg32uint",
        mipLevelCount: levels,
        usage:
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      allocated.push(texture);
      for (let level = 0; level < levels; level++) {
        const width = size / 2 ** level;
        bytes += width ** 3 * 8;
        const pipeline = level === 0 ? seed : reduce;
        const sourceView =
          level === 0
            ? source.createView({
                dimension: "3d",
                baseMipLevel: 0,
                mipLevelCount: 1,
              })
            : texture.createView({
                dimension: "3d",
                baseMipLevel: level - 1,
                mipLevelCount: 1,
              });
        const destination = texture.createView({
          dimension: "3d",
          baseMipLevel: level,
          mipLevelCount: 1,
        });
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: level === 0 ? 0 : 1, resource: sourceView },
            { binding: 2, resource: destination },
          ],
        });
        const pass = encoder.beginComputePass({
          label: "Cloud noise bounds level",
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        const groups = Math.ceil(width / 4);
        pass.dispatchWorkgroups(groups, groups, groups);
        pass.end();
      }
    }
    const shapeBounds = allocated[0];
    const detailBounds = allocated[1];
    const shapeView = shapeBounds.createView({ dimension: "3d" });
    const detailView = detailBounds.createView({ dimension: "3d" });
    device.queue.submit([encoder.finish()]);
    let destroyed = false;
    return {
      shape: shapeBounds,
      detail: detailBounds,
      shapeView,
      detailView,
      bytes,
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        for (const texture of allocated) {
          texture.destroy();
        }
      },
    };
  } catch (error) {
    for (const texture of allocated) {
      texture.destroy();
    }
    throw error;
  }
}
