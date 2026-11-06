/// <reference types="@webgpu/types" />
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import type { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";
import {
  samplePackedWeatherVertical,
  type PackedWeatherVertical,
} from "../../Scene/Weather/WeatherVerticalField.js";

type Triple = [number, number, number];
export interface CloudDensityCacheInputs {
  weather: GPUTextureView;
  weatherSampler: GPUSampler;
  shape: GPUTextureView;
  detail: GPUTextureView;
  noiseSampler: GPUSampler;
  weatherBytes: Uint8Array | null;
  weatherVersion: number;
  verticalWeather?: boolean;
  weatherVertical?: PackedWeatherVertical;
  weatherSize?: { width: number; height: number };
}
export interface CloudDensityCacheOptions {
  cloudDensityCacheSize?: number;
  cloudDensityCacheCellSize?: number;
  cloudDensityCacheUpdateSlices?: number;
  cloudDensityCacheWindTolerance?: number;
  cloudPrimaryDensityCache?: boolean;
  cloudPrimaryDensityMinDistance?: number;
  cloudPrimaryDensityStrength?: number;
}
export interface CloudDensitySamplingSnapshot {
  texture: GPUTexture;
  uniform: GPUBuffer;
  size: number;
  publication: number;
}
interface TimingContext {
  withComputePassTimestamps?(
    descriptor: GPUComputePassDescriptor,
  ): GPUComputePassDescriptor;
}
interface Snapshot {
  key: string;
  bindings: readonly unknown[];
  origin: Triple;
  wind: Triple;
  index: number;
}
interface Batch extends Snapshot {
  camera: Triple;
  slices: number;
  group: GPUBindGroup;
}
interface Resources {
  size: number;
  textures: GPUTexture[];
  views: GPUTextureView[];
  query: GPUBuffer;
  producer: GPUBuffer;
  build: GPUBuffer;
  pipeline: GPUComputePipeline;
  outputs: GPUBindGroup[];
}
const pipelines = new WeakMap<
  GPUDevice,
  Map<() => string, Promise<GPUComputePipeline>>
>();
function requestPipeline(
  device: GPUDevice,
  source: () => string,
): Promise<GPUComputePipeline> {
  let cache = pipelines.get(device);
  if (!cache) {
    cache = new Map();
    pipelines.set(device, cache);
  }
  let promise = cache.get(source);
  if (!promise) {
    promise = Promise.resolve().then(() => {
      const module = device.createShaderModule({
        label: "Cloud density cache producer",
        code: source(),
      });
      return device.createComputePipelineAsync({
        label: "Cloud density cache producer",
        layout: "auto",
        compute: { module, entryPoint: "cloudDensityCacheBuildMain" },
      });
    });
    cache.set(source, promise);
    promise.catch(() => cache!.delete(source));
  }
  return promise;
}
function release(resources: Resources): void {
  for (const texture of resources.textures) {
    texture.destroy();
  }
  resources.query.destroy();
  resources.producer.destroy();
  resources.build.destroy();
}
function createResources(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  size: number,
): Resources {
  const allocated: Array<{ destroy(): void }> = [];
  try {
    const textures = [0, 1].map(() => {
      const texture = device.createTexture({
        label: "Cloud cached density",
        size: [size, size, size],
        dimension: "3d",
        format: "rgba16float",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      allocated.push(texture);
      return texture;
    });
    const views = textures.map((texture) =>
      texture.createView({ dimension: "3d" }),
    );
    const buffer = (label: string, bytes: number, copySource = false) => {
      const value = device.createBuffer({
        label,
        size: bytes,
        usage:
          GPUBufferUsage.UNIFORM |
          GPUBufferUsage.COPY_DST |
          (copySource ? GPUBufferUsage.COPY_SRC : 0),
      });
      allocated.push(value);
      return value;
    };
    const query = buffer("Cloud density cache frame", 48, true);
    const producer = buffer("Cloud density cache material", 196 * 4);
    const build = buffer("Cloud density cache region", 32);
    const outputs = views.map((view) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: { buffer: build } },
        ],
      }),
    );
    return { size, textures, views, query, producer, build, pipeline, outputs };
  } catch (error) {
    for (const value of allocated) {
      value.destroy();
    }
    throw error;
  }
}
export const cloudDensityCacheMaterialSlots: readonly number[] = [
  40, 41, 42, 43, 46, 48, 49, 50, 62, 64, 65, 68, 69, 70, 71, 74, 75, 77, 79,
  96, 101, 102, 104, 107, 112, 114, 115, 116, 117, 118, 119, 128, 129, 130, 132,
  133, 134, 135, 136, 137, 138, 139, 168, 169, 170,
];
const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const drift = (a: Triple, b: Triple) =>
  Math.hypot(...a.map((v, i) => v - b[i]));
export function cloudDensityCacheFocus(
  camera: Triple,
  data: Float32Array,
  vertical = false,
  metadata?: PackedWeatherVertical,
  weatherSize?: { width: number; height: number },
): Triple {
  let height = (data[40] + data[41]) * 0.5;
  const length = Math.hypot(...camera);
  const unit = camera.map((value) => value / length);
  if (
    vertical &&
    data[64] > 0.5 &&
    weatherSize &&
    Math.abs(data[70]) > 1e-8 &&
    Math.abs(data[71]) > 1e-8
  ) {
    const longitude =
      camera[0] * camera[0] + camera[1] * camera[1] > 1e-12
        ? Math.atan2(camera[1], camera[0])
        : 0;
    const latitude = Math.asin(Math.max(-1, Math.min(1, unit[2])));
    const sample = samplePackedWeatherVertical(
      metadata,
      weatherSize.width,
      weatherSize.height,
      (longitude - data[68]) / data[70],
      1 - (latitude - data[69]) / data[71],
    );
    if (sample) {
      height += ((sample[0] + sample[1]) * 0.5 - height) * sample[2];
    }
  }
  const radius =
    1 /
    Math.hypot(
      unit[0] / (data[42] + height),
      unit[1] / (data[42] + height),
      unit[2] / (data[62] + height),
    );
  return unit.map((value) => value * radius) as Triple;
}

export class CloudDensityCache {
  resources: Resources | null = null;
  pending = false;
  failed = false;
  ready = false;
  generation = 0;
  publications = 0;
  refreshedVoxels = 0;
  producerPasses = 0;
  completedSlices = 0;
  pipelineMilliseconds = 0;
  private readonly device: GPUDevice;
  private readonly source: () => string;
  private readonly monitor?: AsyncResourceMonitor;
  private requestedSize = 0;
  private disposed = false;
  private requested = false;
  private active: Snapshot | null = null;
  private batch: Batch | null = null;

  constructor(
    device: GPUDevice,
    source: () => string,
    monitor?: AsyncResourceMonitor,
  ) {
    this.device = device;
    this.source = source;
    this.monitor = monitor;
  }
  usesSource(source: () => string): boolean {
    return this.source === source;
  }
  get needsFrame(): boolean {
    return this.batch !== null;
  }
  get view(): GPUTextureView | null {
    return this.active
      ? (this.resources?.views[this.active.index] ?? null)
      : null;
  }
  get uniform(): GPUBuffer | null {
    return this.resources?.query ?? null;
  }
  get samplingSnapshot(): CloudDensitySamplingSnapshot | null {
    if (!this.ready || !this.active || !this.resources) {
      return null;
    }
    return {
      texture: this.resources.textures[this.active.index],
      uniform: this.resources.query,
      size: this.resources.size,
      publication: this.publications,
    };
  }

  prepare(
    inputs: CloudDensityCacheInputs,
    data: Float32Array,
    camera: Triple,
    wind: Triple,
    enabled: boolean,
    options: CloudDensityCacheOptions = {},
    context?: TimingContext,
  ): boolean {
    this.refreshedVoxels = 0;
    this.producerPasses = 0;
    this.ready = false;
    const eligible =
      enabled &&
      !this.disposed &&
      data.length === 196 &&
      data.every(Number.isFinite) &&
      camera.every((v) => Number.isFinite(v) && Math.abs(v) < 1e9) &&
      Math.hypot(...camera) > 1 &&
      wind.every(Number.isFinite);
    this.requested = eligible;
    if (!eligible) {
      if (this.pending) {
        this.generation++;
        this.pending = false;
      }
      this.batch = null;
      this.failed = false;
      if (this.uniform) {
        this.device.queue.writeBuffer(this.uniform, 12, new Float32Array(1));
      }
      return false;
    }
    const size = options.cloudDensityCacheSize === 64 ? 64 : 32;
    if (this.pending && this.requestedSize !== size) {
      this.generation++;
      this.pending = false;
    }
    this.requestedSize = size;
    if (this.resources && this.resources.size !== size) {
      this.generation++;
      release(this.resources);
      this.resources = null;
      this.active = null;
      this.batch = null;
    }
    if (!this.resources && !this.pending && !this.failed) {
      const generation = ++this.generation,
        started = performance.now();
      this.pending = true;
      const token = this.monitor?.begin({
        kind: "compute-pipeline",
        key: `cloud-density-cache:${generation}`,
        label: "Cloud density cache preparation",
        priority: "background",
      });
      void requestPipeline(this.device, this.source)
        .then((pipeline) => {
          if (
            !this.disposed &&
            this.requested &&
            this.generation === generation
          ) {
            this.resources = createResources(this.device, pipeline, size);
            this.pipelineMilliseconds = performance.now() - started;
            this.pending = false;
          }
          if (token) {
            this.monitor!.resolve(token);
          }
        })
        .catch((error: unknown) => {
          if (!this.disposed && this.generation === generation) {
            this.pending = false;
            this.failed = true;
            console.error("Cloud density cache preparation failed.", error);
            if (token) {
              this.monitor!.reject(token, error);
            }
          } else if (token) {
            this.monitor!.resolve(token);
          }
        });
    }
    if (!this.resources || this.failed) {
      return false;
    }
    try {
      return this.encode(inputs, data, camera, wind, options, context);
    } catch (error) {
      this.failed = true;
      this.batch = null;
      this.active = null;
      this.completedSlices = 0;
      this.ready = false;
      this.device.queue.writeBuffer(
        this.resources.query,
        12,
        new Float32Array(1),
      );
      console.error("Cloud density cache refresh failed.", error);
      return false;
    }
  }

  private encode(
    inputs: CloudDensityCacheInputs,
    data: Float32Array,
    camera: Triple,
    wind: Triple,
    options: CloudDensityCacheOptions,
    context?: TimingContext,
  ): boolean {
    const r = this.resources!,
      device = this.device,
      size = r.size;
    const cell = Math.max(
      32,
      Math.min(
        2048,
        Number.isFinite(options.cloudDensityCacheCellSize)
          ? options.cloudDensityCacheCellSize!
          : 128,
      ),
    );
    const tolerance = Math.max(
      0.01,
      Math.min(
        cell * 0.25,
        Number.isFinite(options.cloudDensityCacheWindTolerance)
          ? options.cloudDensityCacheWindTolerance!
          : Math.min(4, cell / 32),
      ),
    );
    const key = JSON.stringify([
      cell,
      size,
      inputs.weatherVersion,
      ...cloudDensityCacheMaterialSlots.map((i) => data[i]),
    ]);
    const bindings = [
      inputs.weather,
      inputs.weatherSampler,
      inputs.shape,
      inputs.detail,
      inputs.noiseSampler,
      inputs.weatherBytes,
      inputs.verticalWeather === true,
      inputs.weatherVertical?.bytes,
    ];
    const focus = cloudDensityCacheFocus(
      camera,
      data,
      inputs.verticalWeather === true,
      inputs.weatherVertical,
      inputs.weatherSize,
    );
    const current = (snapshot: Snapshot | null) =>
      !!snapshot && snapshot.key === key && same(snapshot.bindings, bindings);
    const contained = (snapshot: Snapshot) =>
      focus.every(
        (value, i) =>
          value >= snapshot.origin[i] + size * cell * 0.25 &&
          value <= snapshot.origin[i] + size * cell * 0.75,
      );
    if (
      this.batch &&
      (!current(this.batch) || drift(this.batch.wind, wind) > tolerance)
    ) {
      this.batch = null;
    }
    const activeCurrent = current(this.active);
    if (
      !this.batch &&
      (!activeCurrent ||
        !contained(this.active!) ||
        drift(this.active!.wind, wind) > tolerance * 0.5)
    ) {
      const origin = focus.map(
        (value) => (Math.floor(value / cell) - size / 2) * cell,
      ) as Triple;
      const index = this.active ? 1 - this.active.index : 0;
      const group = device.createBindGroup({
        layout: r.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 3, resource: { buffer: r.producer } },
          { binding: 4, resource: inputs.weather },
          { binding: 5, resource: inputs.weatherSampler },
          { binding: 6, resource: inputs.shape },
          { binding: 7, resource: inputs.detail },
          { binding: 8, resource: inputs.noiseSampler },
        ],
      });
      device.queue.writeBuffer(r.producer, 0, data);
      this.batch = {
        key,
        bindings,
        origin,
        wind: [...wind],
        camera: [...camera],
        index,
        slices: 0,
        group,
      };
      this.completedSlices = 0;
    }
    if (this.batch) {
      const batch = this.batch;
      const limit = Math.max(
        1,
        Math.min(
          size,
          Math.floor(
            Number.isFinite(options.cloudDensityCacheUpdateSlices)
              ? options.cloudDensityCacheUpdateSlices!
              : 8,
          ),
        ),
      );
      const count = Math.min(limit, size - batch.slices),
        bytes = new ArrayBuffer(32);
      new Float32Array(bytes).set([
        ...batch.origin.map((v, i) => v - batch.camera[i]),
        cell,
      ]);
      new Uint32Array(bytes).set([batch.slices, size, count, 0], 4);
      device.queue.writeBuffer(r.build, 0, bytes);
      const encoder = device.createCommandEncoder({
        label: "Cloud density cache refresh",
      });
      const descriptor = { label: "Cloud density cache refresh" };
      const pass = encoder.beginComputePass(
        context?.withComputePassTimestamps?.(descriptor) ?? descriptor,
      );
      pass.setPipeline(r.pipeline);
      pass.setBindGroup(0, batch.group);
      pass.setBindGroup(1, r.outputs[batch.index]);
      pass.dispatchWorkgroups(Math.ceil(size / 4), Math.ceil(size / 4), count);
      pass.end();
      device.queue.submit([encoder.finish()]);
      batch.slices += count;
      this.completedSlices = batch.slices;
      this.refreshedVoxels = size * size * count;
      this.producerPasses = 1;
      if (batch.slices === size) {
        this.active = batch;
        this.batch = null;
        this.publications++;
      }
    }
    const ready =
      current(this.active) && drift(this.active!.wind, wind) <= tolerance;
    const query = new Float32Array(12);
    if (ready) {
      const split = { high: 0, low: 0 };
      for (let i = 0; i < 3; i++) {
        EncodedCartesian3.encode(this.active!.origin[i], split);
        query[i] = split.high;
        query[i + 4] = split.low;
      }
      query[3] = 1;
      query[7] = cell;
      query[8] = size;
      if (options.cloudPrimaryDensityCache === true) {
        const distance = options.cloudPrimaryDensityMinDistance ?? 512;
        const strength = options.cloudPrimaryDensityStrength ?? 1;
        query[9] = Number.isFinite(distance)
          ? Math.max(0, Math.min(100000, distance))
          : 512;
        query[10] = cell * 2;
        query[11] = Number.isFinite(strength)
          ? Math.max(0, Math.min(1, strength))
          : 0;
      }
    }
    device.queue.writeBuffer(r.query, 0, query);
    this.ready = ready;
    return ready;
  }

  destroy(): void {
    this.disposed = true;
    this.requested = false;
    this.generation++;
    if (this.resources) {
      release(this.resources);
    }
    this.resources = null;
    this.pending = false;
    this.active = null;
    this.batch = null;
    this.ready = false;
    this.completedSlices = 0;
  }
}
