/// <reference types="@webgpu/types" />
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import SnapshotSource from "../../Shaders/WebGPU/Compute/CloudDensitySnapshot.js";
import {
  createCloudShadowFrame,
  computeCloudShadowFrame,
  type CloudShadowFrame,
} from "./WebGPUCloudShadowFrame.js";
import {
  cloudDensityCacheMaterialSlots,
  type CloudDensityCacheInputs,
  type CloudDensitySamplingSnapshot,
} from "./WebGPUCloudDensityCache.js";
import type { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";

type Triple = [number, number, number];
export interface CloudDeepShadowOptions {
  cloudDeepShadowSize?: number;
  cloudDeepShadowHalfExtent?: number;
  cloudDeepShadowRowsPerFrame?: number;
  cloudDeepShadowNearDistance?: number;
  cloudDeepShadowWindTolerance?: number;
}
interface Inputs extends CloudDensityCacheInputs {
  density?: CloudDensitySamplingSnapshot | null;
}
interface TimingContext {
  withComputePassTimestamps?(
    descriptor: GPUComputePassDescriptor,
  ): GPUComputePassDescriptor;
}
interface Resources {
  size: number;
  pipelines: GPUComputePipeline[];
  textures: GPUTexture[];
  views: GPUTextureView[];
  query: GPUBuffer;
  build: GPUBuffer;
  producer: GPUBuffer;
  densityUniform: GPUBuffer;
  densityTexture: GPUTexture;
  densityView: GPUTextureView;
  densitySize: number;
  outputs: GPUBindGroup[];
}
interface Field {
  key: string;
  bindings: readonly unknown[];
  frame: CloudShadowFrame;
  wind: Triple;
  index: number;
  densityPublication: number;
}
interface Batch extends Field {
  row: number;
  source: GPUBindGroup;
  snapshot: GPUBindGroup | null;
  densitySource: CloudDensitySamplingSnapshot | null;
}
const pipelineCache = new WeakMap<
  GPUDevice,
  Map<() => string, Promise<GPUComputePipeline[]>>
>();
function pipelines(
  device: GPUDevice,
  source: () => string,
): Promise<GPUComputePipeline[]> {
  let cache = pipelineCache.get(device);
  if (!cache) {
    cache = new Map();
    pipelineCache.set(device, cache);
  }
  let promise = cache.get(source);
  if (!promise) {
    promise = Promise.resolve().then(() => {
      const main = device.createShaderModule({
        label: "Cloud deep-shadow producer",
        code: source(),
      });
      const snapshot = device.createShaderModule({
        label: "Cloud density snapshot",
        code: SnapshotSource,
      });
      return Promise.all([
        device.createComputePipelineAsync({
          label: "Cloud deep-shadow producer",
          layout: "auto",
          compute: { module: main, entryPoint: "cloudDeepShadowBuildMain" },
        }),
        device.createComputePipelineAsync({
          label: "Cloud density snapshot",
          layout: "auto",
          compute: { module: snapshot, entryPoint: "copyDensitySnapshot" },
        }),
      ]);
    });
    cache.set(source, promise);
    promise.catch(() => cache!.delete(source));
  }
  return promise;
}
function destroyResources(r: Resources): void {
  for (const texture of r.textures) {
    texture.destroy();
  }
  r.densityTexture.destroy();
  r.query.destroy();
  r.build.destroy();
  r.producer.destroy();
  r.densityUniform.destroy();
}
function createResources(
  device: GPUDevice,
  selected: GPUComputePipeline[],
  size: number,
): Resources {
  const allocated: Array<{ destroy(): void }> = [];
  try {
    const textures = [0, 1].map(() => {
      const texture = device.createTexture({
        label: "Cloud cumulative deep shadow",
        size: [size, size, 99],
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
    const buffer = (label: string, bytes: number) => {
      const value = device.createBuffer({
        label,
        size: bytes,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      allocated.push(value);
      return value;
    };
    const query = buffer("Cloud deep-shadow frame", 112),
      build = buffer("Cloud deep-shadow build", 112);
    const producer = buffer("Cloud deep-shadow material", 196 * 4);
    const densityUniform = buffer("Cloud deep-shadow density frame", 48);
    const densityTexture = device.createTexture({
      label: "Cloud frozen density",
      size: [1, 1, 1],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });
    allocated.push(densityTexture);
    const densityView = densityTexture.createView({ dimension: "3d" });
    const outputs = views.map((view) =>
      device.createBindGroup({
        layout: selected[0].getBindGroupLayout(1),
        entries: [{ binding: 0, resource: view }],
      }),
    );
    return {
      size,
      pipelines: selected,
      textures,
      views,
      query,
      build,
      producer,
      densityUniform,
      densityTexture,
      densityView,
      densitySize: 1,
      outputs,
    };
  } catch (error) {
    for (const value of allocated) {
      value.destroy();
    }
    throw error;
  }
}
export function packCloudDeepShadowFrame(
  frame: CloudShadowFrame,
  row: number,
  rows: number,
  enabled: boolean,
  near: number,
): Float32Array {
  const data = new Float32Array(28),
    bits = new Uint32Array(data.buffer),
    split = { high: 0, low: 0 };
  for (const [i, value] of [
    frame.centerX,
    frame.centerY,
    frame.centerZ,
  ].entries()) {
    EncodedCartesian3.encode(value, split);
    data[i] = split.high;
    data[i + 4] = split.low;
  }
  data[3] = Number(enabled);
  data[7] = frame.halfExtent;
  data.set([frame.rightX, frame.rightY, frame.rightZ], 8);
  bits[11] = row;
  data.set([frame.upX, frame.upY, frame.upZ], 12);
  bits[15] = rows;
  data.set([frame.sunX, frame.sunY, frame.sunZ], 16);
  bits[19] = 33;
  data[20] = near;
  data.set(enabled ? [1, 1, 1, 1] : [0, 0, 0, 0], 24);
  return data;
}
const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const drift = (a: Triple, b: Triple) =>
  Math.hypot(...a.map((v, i) => v - b[i]));
const sunDifference = (a: CloudShadowFrame, b: CloudShadowFrame) =>
  Math.hypot(a.sunX - b.sunX, a.sunY - b.sunY, a.sunZ - b.sunZ);

export class CloudDeepShadowCache {
  resources: Resources | null = null;
  pending = false;
  failed = false;
  ready = false;
  generation = 0;
  publications = 0;
  completedRows = 0;
  producerPasses = 0;
  copiedBytes = 0;
  snapshotCopies = 0;
  refreshedColumns = 0;
  sourceDensityPublication = 0;
  pipelineMilliseconds = 0;
  private readonly device: GPUDevice;
  private readonly source: () => string;
  private readonly monitor?: AsyncResourceMonitor;
  private disposed = false;
  private requested = false;
  private requestedSize = 0;
  private active: Field | null = null;
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
  get view(): GPUTextureView | null {
    return this.active
      ? (this.resources?.views[this.active.index] ?? null)
      : null;
  }
  get uniform(): GPUBuffer | null {
    return this.resources?.query ?? null;
  }
  get needsFrame(): boolean {
    return this.batch !== null;
  }

  prepare(
    inputs: Inputs,
    data: Float32Array,
    camera: Triple,
    wind: Triple,
    enabled: boolean,
    options: CloudDeepShadowOptions = {},
    context?: TimingContext,
  ): boolean {
    this.producerPasses = 0;
    this.copiedBytes = 0;
    this.refreshedColumns = 0;
    this.ready = false;
    const extent = Math.max(
      512,
      Math.min(
        65536,
        Number.isFinite(options.cloudDeepShadowHalfExtent)
          ? options.cloudDeepShadowHalfExtent!
          : 8192,
      ),
    );
    const candidate = createCloudShadowFrame();
    const eligible =
      enabled &&
      !this.disposed &&
      data.length === 196 &&
      data.every(Number.isFinite) &&
      camera.every(Number.isFinite) &&
      wind.every(Number.isFinite) &&
      Math.hypot(...camera) < 32000000 &&
      computeCloudShadowFrame(
        candidate,
        ...camera,
        data[36],
        data[37],
        data[38],
        extent,
        data[42],
        data[62],
      ) &&
      (candidate.centerX * candidate.sunX +
        candidate.centerY * candidate.sunY +
        candidate.centerZ * candidate.sunZ) /
        Math.hypot(candidate.centerX, candidate.centerY, candidate.centerZ) >
        0.2;
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
    const size =
      options.cloudDeepShadowSize === 32
        ? 32
        : options.cloudDeepShadowSize === 128
          ? 128
          : 64;
    if (this.pending && this.requestedSize !== size) {
      this.generation++;
      this.pending = false;
    }
    this.requestedSize = size;
    if (this.resources && this.resources.size !== size) {
      this.generation++;
      destroyResources(this.resources);
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
        key: `cloud-deep-shadow:${generation}`,
        label: "Cloud deep-shadow preparation",
        priority: "background",
      });
      void pipelines(this.device, this.source)
        .then((selected) => {
          if (
            !this.disposed &&
            this.requested &&
            this.generation === generation
          ) {
            this.resources = createResources(this.device, selected, size);
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
            console.error("Cloud deep-shadow preparation failed.", error);
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
      return this.encode(inputs, data, wind, candidate, options, context);
    } catch (error) {
      this.failed = true;
      this.batch = null;
      this.active = null;
      this.completedRows = 0;
      this.device.queue.writeBuffer(
        this.resources.query,
        12,
        new Float32Array(1),
      );
      console.error("Cloud deep-shadow refresh failed.", error);
      return false;
    }
  }

  private encode(
    inputs: Inputs,
    data: Float32Array,
    wind: Triple,
    candidate: CloudShadowFrame,
    options: CloudDeepShadowOptions,
    context?: TimingContext,
  ): boolean {
    const r = this.resources!,
      device = this.device,
      size = r.size;
    const tolerance = Math.max(
      1,
      Math.min(
        candidate.halfExtent / (2 * size),
        Number.isFinite(options.cloudDeepShadowWindTolerance)
          ? options.cloudDeepShadowWindTolerance!
          : 32,
      ),
    );
    const near = Math.max(
      0,
      Math.min(
        4096,
        Number.isFinite(options.cloudDeepShadowNearDistance)
          ? options.cloudDeepShadowNearDistance!
          : 128,
      ),
    );
    const key = JSON.stringify([
      size,
      candidate.halfExtent,
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
    ];
    const current = (field: Field | null) =>
      !!field && field.key === key && same(field.bindings, bindings);
    const moved = (frame: CloudShadowFrame) => {
      const delta = [
        candidate.centerX - frame.centerX,
        candidate.centerY - frame.centerY,
        candidate.centerZ - frame.centerZ,
      ];
      return (
        Math.abs(
          delta[0] * frame.rightX +
            delta[1] * frame.rightY +
            delta[2] * frame.rightZ,
        ) >
          candidate.halfExtent / 4 ||
        Math.abs(
          delta[0] * frame.upX + delta[1] * frame.upY + delta[2] * frame.upZ,
        ) >
          candidate.halfExtent / 4
      );
    };
    if (
      this.batch &&
      (!current(this.batch) ||
        drift(this.batch.wind, wind) > tolerance ||
        sunDifference(candidate, this.batch.frame) > 0.001)
    ) {
      this.batch = null;
    }
    if (
      !this.batch &&
      (!current(this.active) ||
        moved(this.active!.frame) ||
        drift(this.active!.wind, wind) > tolerance * 0.5 ||
        sunDifference(candidate, this.active!.frame) > 0.0005)
    ) {
      const snapshot = inputs.density ?? null;
      if (snapshot && snapshot.size !== r.densitySize) {
        const next = device.createTexture({
          label: "Cloud frozen density",
          size: [snapshot.size, snapshot.size, snapshot.size],
          dimension: "3d",
          format: "rgba16float",
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        let view: GPUTextureView;
        try {
          view = next.createView({ dimension: "3d" });
        } catch (error) {
          next.destroy();
          throw error;
        }
        const previous = r.densityTexture;
        r.densityTexture = next;
        r.densityView = view;
        r.densitySize = snapshot.size;
        previous.destroy();
      }
      const source = device.createBindGroup({
        layout: r.pipelines[0].getBindGroupLayout(0),
        entries: [
          { binding: 3, resource: { buffer: r.producer } },
          { binding: 4, resource: inputs.weather },
          { binding: 5, resource: inputs.weatherSampler },
          { binding: 6, resource: inputs.shape },
          { binding: 7, resource: inputs.detail },
          { binding: 8, resource: inputs.noiseSampler },
          { binding: 20, resource: r.densityView },
          { binding: 21, resource: { buffer: r.densityUniform } },
          { binding: 23, resource: { buffer: r.build } },
        ],
      });
      const copy = snapshot
        ? device.createBindGroup({
            layout: r.pipelines[1].getBindGroupLayout(0),
            entries: [
              {
                binding: 0,
                resource: snapshot.texture.createView({ dimension: "3d" }),
              },
              { binding: 1, resource: r.densityView },
            ],
          })
        : null;
      device.queue.writeBuffer(r.producer, 0, data);
      if (!snapshot) {
        device.queue.writeBuffer(r.densityUniform, 0, new Float32Array(12));
      }
      this.batch = {
        key,
        bindings,
        frame: candidate,
        wind: [...wind],
        index: this.active ? 1 - this.active.index : 0,
        row: 0,
        source,
        snapshot: copy,
        densitySource: snapshot,
        densityPublication: snapshot?.publication ?? 0,
      };
      this.completedRows = 0;
    }
    if (this.batch) {
      const batch = this.batch;
      const limit = Math.max(
        1,
        Math.min(
          size,
          Math.floor(
            Number.isFinite(options.cloudDeepShadowRowsPerFrame)
              ? options.cloudDeepShadowRowsPerFrame!
              : 8,
          ),
        ),
      );
      const count = Math.min(limit, size - batch.row);
      device.queue.writeBuffer(
        r.build,
        0,
        packCloudDeepShadowFrame(batch.frame, batch.row, count, true, near),
      );
      const encoder = device.createCommandEncoder({
        label: "Cloud deep-shadow refresh",
      });
      const begin = (label: string) => {
        this.producerPasses++;
        const descriptor = { label };
        return encoder.beginComputePass(
          context?.withComputePassTimestamps?.(descriptor) ?? descriptor,
        );
      };
      let copied = 0;
      if (batch.row === 0 && batch.snapshot && batch.densitySource) {
        encoder.copyBufferToBuffer(
          batch.densitySource.uniform,
          0,
          r.densityUniform,
          0,
          48,
        );
        const pass = begin("Cloud deep-shadow density snapshot");
        pass.setPipeline(r.pipelines[1]);
        pass.setBindGroup(0, batch.snapshot);
        const groups = Math.ceil(batch.densitySource.size / 4);
        pass.dispatchWorkgroups(groups, groups, groups);
        pass.end();
        copied = batch.densitySource.size ** 3 * 8 + 48;
      }
      const pass = begin("Cloud deep-shadow refresh");
      pass.setPipeline(r.pipelines[0]);
      pass.setBindGroup(0, batch.source);
      pass.setBindGroup(1, r.outputs[batch.index]);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(count / 4), 3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (copied > 0) {
        this.copiedBytes = copied;
        this.snapshotCopies++;
      }
      batch.row += count;
      this.completedRows = batch.row;
      this.refreshedColumns = size * count * 3;
      if (batch.row === size) {
        this.active = batch;
        this.batch = null;
        this.publications++;
        this.sourceDensityPublication = batch.densityPublication;
      }
    }
    const ready =
      current(this.active) &&
      drift(this.active!.wind, wind) <= tolerance &&
      sunDifference(candidate, this.active!.frame) <= 0.001;
    device.queue.writeBuffer(
      r.query,
      0,
      packCloudDeepShadowFrame(
        this.active?.frame ?? candidate,
        0,
        size,
        ready,
        near,
      ),
    );
    this.ready = ready;
    return ready;
  }

  destroy(): void {
    this.disposed = true;
    this.requested = false;
    this.generation++;
    if (this.resources) {
      destroyResources(this.resources);
    }
    this.resources = null;
    this.pending = false;
    this.active = null;
    this.batch = null;
    this.ready = false;
    this.completedRows = 0;
  }
}
