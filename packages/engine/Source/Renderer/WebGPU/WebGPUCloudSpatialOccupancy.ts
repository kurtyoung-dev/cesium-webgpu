/// <reference types="@webgpu/types" />
import DomainSource from "../../Shaders/WebGPU/Environment/CloudDensityDomain.js";
import QuerySource from "../../Shaders/WebGPU/Environment/CloudNoiseBoundsQuery.js";
import BuildSource from "../../Shaders/WebGPU/Compute/CloudSpatialOccupancy.js";
import {
  createCloudNoiseBounds,
  type CloudNoiseBounds,
} from "./WebGPUCloudNoiseBounds.js";
import { writeCloudDensityOriginPhases } from "./WebGPUCloudDensityDomain.js";

type Triple = [number, number, number];
interface NoiseSource {
  shape: GPUTexture;
  detail: GPUTexture;
  sampler: GPUSampler;
}
interface Resources {
  bounds: CloudNoiseBounds;
  texture: GPUTexture;
  view: GPUTextureView;
  buildUniform: GPUBuffer;
  uniform: GPUBuffer;
  pages: GPUBuffer;
  pipelines: GPUComputePipeline[];
  clearGroup: GPUBindGroup;
  updateGroup: GPUBindGroup;
  reduceGroups: GPUBindGroup[];
}
const pipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline[]>>();
function getPipelines(device: GPUDevice): Promise<GPUComputePipeline[]> {
  let promise = pipelines.get(device);
  if (!promise) {
    const module = device.createShaderModule({
      label: "Cloud spatial noise bounds",
      code: [DomainSource, QuerySource, BuildSource].join("\n"),
    });
    promise = Promise.all(
      [
        "clearCloudOccupancy",
        "updateCloudOccupancy",
        "reduceCloudOccupancy",
      ].map((entryPoint) =>
        device.createComputePipelineAsync({
          label: entryPoint,
          layout: "auto",
          compute: { module, entryPoint },
        }),
      ),
    );
    pipelines.set(device, promise);
    promise.catch(() => pipelines.delete(device));
  }
  return promise;
}
function release(resources: Resources): void {
  resources.bounds.destroy();
  resources.texture.destroy();
  resources.buildUniform.destroy();
  resources.uniform.destroy();
  resources.pages.destroy();
}
async function createResources(
  device: GPUDevice,
  source: NoiseSource,
  current: () => boolean,
): Promise<Resources> {
  const selected = await getPipelines(device);
  if (!current()) {
    throw new Error("Cloud occupancy request expired.");
  }
  const bounds = await createCloudNoiseBounds(
    device,
    source.shape,
    source.detail,
    current,
  );
  const allocated: Array<{ destroy(): void }> = [];
  try {
    if (!current()) {
      throw new Error("Cloud occupancy request expired.");
    }
    const texture = device.createTexture({
      label: "Cloud spatial occupancy",
      dimension: "3d",
      size: [32, 32, 64],
      format: "rgba8unorm",
      mipLevelCount: 6,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    allocated.push(texture);
    const view = texture.createView({ dimension: "3d" });
    const buildUniform = device.createBuffer({
      label: "Cloud occupancy build",
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    allocated.push(buildUniform);
    const uniform = device.createBuffer({
      label: "Cloud occupancy query",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    allocated.push(uniform);
    const pages = device.createBuffer({
      label: "Cloud occupancy pages",
      size: 128,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    allocated.push(pages);
    const entries = [
      { binding: 0, resource: source.shape.createView({ dimension: "3d" }) },
      { binding: 1, resource: source.detail.createView({ dimension: "3d" }) },
      { binding: 2, resource: source.sampler },
      { binding: 3, resource: bounds.shapeView },
      { binding: 4, resource: bounds.detailView },
      { binding: 5, resource: { buffer: buildUniform } },
      { binding: 6, resource: { buffer: pages } },
      {
        binding: 7,
        resource: texture.createView({
          dimension: "3d",
          baseMipLevel: 0,
          mipLevelCount: 1,
        }),
      },
    ];
    const clearGroup = device.createBindGroup({
      layout: selected[0].getBindGroupLayout(0),
      entries: entries.filter(
        (entry) => entry.binding === 5 || entry.binding === 7,
      ),
    });
    const updateGroup = device.createBindGroup({
      layout: selected[1].getBindGroupLayout(0),
      entries,
    });
    const reduceGroups = [];
    for (let level = 1; level < 6; level++) {
      reduceGroups.push(
        device.createBindGroup({
          layout: selected[2].getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: texture.createView({
                dimension: "3d",
                baseMipLevel: level - 1,
                mipLevelCount: 1,
              }),
            },
            {
              binding: 7,
              resource: texture.createView({
                dimension: "3d",
                baseMipLevel: level,
                mipLevelCount: 1,
              }),
            },
          ],
        }),
      );
    }
    return {
      bounds,
      texture,
      view,
      buildUniform,
      uniform,
      pages,
      pipelines: selected,
      clearGroup,
      updateGroup,
      reduceGroups,
    };
  } catch (error) {
    bounds.destroy();
    for (const value of allocated) {
      value.destroy();
    }
    throw error;
  }
}
function modulo(value: number): number {
  return ((value % 8) + 8) % 8;
}
function key(page: Triple): number {
  return modulo(page[0]) + 8 * (modulo(page[1]) + 8 * modulo(page[2]));
}
export function planCloudOccupancyPages(
  minimum: Triple,
  resident: Map<number, string>,
): Triple[] {
  const queue: Triple[] = [];
  for (let z = 0; z < 8; z++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const page: Triple = [minimum[0] + x, minimum[1] + y, minimum[2] + z];
        if (resident.get(key(page)) !== page.join(",")) {
          queue.push(page);
        }
      }
    }
  }
  queue.sort(
    (a, b) =>
      a.reduce((sum, v, i) => sum + (v - minimum[i] - 3.5) ** 2, 0) -
      b.reduce((sum, v, i) => sum + (v - minimum[i] - 3.5) ** 2, 0),
  );
  return queue;
}

export class CloudSpatialOccupancy {
  readonly device: GPUDevice;
  resources: Resources | null = null;
  pending = false;
  failed = false;
  readyCells = 0;
  refreshedCells = 0;
  producerPasses = 0;
  generation = 0;
  private source: NoiseSource | null = null;
  private minimum: Triple | null = null;
  private puffSize = NaN;
  private resident = new Map<number, string>();
  private queue: Triple[] = [];
  private disposed = false;
  private requested = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }
  get view(): GPUTextureView | null {
    return this.resources?.view ?? null;
  }
  get uniform(): GPUBuffer | null {
    return this.resources?.uniform ?? null;
  }

  prepare(
    source: NoiseSource | null,
    camera: Triple,
    puffSize: number,
    enabled: boolean,
    refreshPages = 2,
    context?: {
      withComputePassTimestamps?(
        descriptor: GPUComputePassDescriptor,
      ): GPUComputePassDescriptor;
    },
  ): boolean {
    this.refreshedCells = 0;
    this.producerPasses = 0;
    const eligible =
      !this.disposed &&
      enabled &&
      source !== null &&
      source.shape.width >= 2 &&
      source.shape.width <= 128 &&
      source.detail.width >= 2 &&
      source.detail.width <= 32 &&
      camera.every((v) => Number.isFinite(v) && Math.abs(v) < 1e10) &&
      Number.isFinite(puffSize) &&
      puffSize > 0;
    if (!eligible) {
      if (this.pending) {
        this.generation++;
        this.pending = false;
      }
      this.requested = false;
      this.failed = false;
      if (this.uniform) {
        this.device.queue.writeBuffer(this.uniform, 0, new Uint32Array(8));
      }
      return false;
    }
    this.requested = true;
    if (
      this.source?.shape !== source.shape ||
      this.source?.detail !== source.detail ||
      this.source?.sampler !== source.sampler
    ) {
      this.generation++;
      if (this.resources) {
        release(this.resources);
      }
      this.resources = null;
      this.source = source;
      this.pending = false;
      this.failed = false;
      this.minimum = null;
      this.resident.clear();
      this.queue = [];
      this.readyCells = 0;
    }
    if (!this.resources && !this.pending && !this.failed) {
      const generation = this.generation;
      const current = () =>
        !this.disposed && this.requested && this.generation === generation;
      this.pending = true;
      void createResources(this.device, source, current).then(
        (resources) => {
          if (!current()) {
            release(resources);
            return;
          }
          this.resources = resources;
          this.pending = false;
        },
        (error: unknown) => {
          if (!current()) {
            return;
          }
          this.pending = false;
          this.failed = true;
          console.error("Cloud occupancy preparation failed.", error);
        },
      );
    }
    if (!this.resources || this.failed) {
      return false;
    }
    try {
      return this.encode(camera, puffSize, refreshPages, context);
    } catch (error: unknown) {
      this.failed = true;
      this.minimum = null;
      this.resident.clear();
      this.queue = [];
      this.readyCells = 0;
      this.refreshedCells = 0;
      this.device.queue.writeBuffer(
        this.resources.uniform,
        0,
        new Uint32Array(8),
      );
      console.error("Cloud occupancy refresh failed.", error);
      return false;
    }
  }

  private encode(
    camera: Triple,
    puffSize: number,
    requestedPages: number,
    context?: {
      withComputePassTimestamps?(
        descriptor: GPUComputePassDescriptor,
      ): GPUComputePassDescriptor;
    },
  ): boolean {
    const resources = this.resources!,
      device = this.device,
      pageSize = 256;
    const minimum = camera.map((v) => Math.floor(v / pageSize) - 4) as Triple;
    const reset = this.minimum === null || this.puffSize !== puffSize;
    const moved = reset || minimum.some((v, i) => v !== this.minimum![i]);
    const physical = minimum.map((v) => modulo(v) * 4);
    const build = new ArrayBuffer(64),
      floats = new Float32Array(build),
      signed = new Int32Array(build),
      integers = new Uint32Array(build);
    writeCloudDensityOriginPhases(
      floats,
      0,
      minimum[0] * pageSize,
      minimum[1] * pageSize,
      minimum[2] * pageSize,
      puffSize,
    );
    floats[3] = puffSize;
    floats[7] = 64;
    integers.set(physical, 8);
    signed.set(
      minimum.map((v, i) =>
        Math.max(-32, Math.min(32, (v - (this.minimum?.[i] ?? v)) * 4)),
      ),
      12,
    );
    integers[15] = reset ? 1 : 0;
    if (reset) {
      this.resident.clear();
    }
    if (moved) {
      this.queue = planCloudOccupancyPages(minimum, this.resident);
    }
    const limit = Math.max(
      1,
      Math.min(
        8,
        Math.floor(Number.isFinite(requestedPages) ? requestedPages : 2),
      ),
    );
    const count = Math.min(limit, this.queue.length);
    if (moved || count > 0) {
      device.queue.writeBuffer(resources.buildUniform, 0, build);
      const encoder = device.createCommandEncoder({
        label: "Cloud occupancy refresh",
      });
      const begin = (label: string) => {
        this.producerPasses++;
        const descriptor = { label };
        return encoder.beginComputePass(
          context?.withComputePassTimestamps?.(descriptor) ?? descriptor,
        );
      };
      if (moved) {
        const pass = begin("Cloud occupancy invalidation");
        pass.setPipeline(resources.pipelines[0]);
        pass.setBindGroup(0, resources.clearGroup);
        pass.dispatchWorkgroups(8, 8, 8);
        pass.end();
      }
      const updated = this.queue.slice(0, count);
      if (count > 0) {
        const pages = new Uint32Array(32);
        for (let i = 0; i < count; i++) {
          pages.set(
            updated[i].map((v, axis) => v - minimum[axis]),
            i * 4,
          );
        }
        device.queue.writeBuffer(resources.pages, 0, pages);
        const pass = begin("Cloud occupancy refresh");
        pass.setPipeline(resources.pipelines[1]);
        pass.setBindGroup(0, resources.updateGroup);
        pass.dispatchWorkgroups(count);
        pass.end();
      }
      for (let level = 1; level < 6; level++) {
        const pass = begin("Cloud occupancy parent bounds");
        pass.setPipeline(resources.pipelines[2]);
        pass.setBindGroup(0, resources.reduceGroups[level - 1]);
        pass.dispatchWorkgroups(
          Math.ceil((32 >> level) / 4),
          Math.ceil((32 >> level) / 4),
          Math.ceil((64 >> level) / 4),
        );
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      // CPU residency advances only after the matching GPU work is submitted.
      for (const page of updated) {
        this.resident.set(key(page), page.join(","));
      }
      this.queue.splice(0, count);
      this.minimum = minimum;
      this.puffSize = puffSize;
      this.refreshedCells = count * 64;
    }
    this.readyCells = (512 - this.queue.length) * 64;
    const query = new ArrayBuffer(32);
    new Float32Array(query).set([
      ...minimum.map((v, i) => v * pageSize - camera[i]),
      64,
    ]);
    new Uint32Array(query).set([...physical, 1], 4);
    device.queue.writeBuffer(resources.uniform, 0, query);
    return true;
  }

  destroy(): void {
    this.disposed = true;
    this.requested = false;
    this.generation++;
    if (this.resources) {
      release(this.resources);
    }
    this.resources = null;
    this.source = null;
    this.pending = false;
    this.minimum = null;
    this.resident.clear();
    this.queue = [];
    this.readyCells = 0;
  }
}
