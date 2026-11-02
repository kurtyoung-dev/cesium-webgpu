/// <reference types="@webgpu/types" />
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import type { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";
import type { CloudWeatherOctreeOptions } from "../../Scene/Weather/CloudWeatherOctree.js";

type Domain = Pick<
  CloudWeatherOctreeOptions,
  "equatorialRadius" | "polarRadius" | "bottom" | "top"
>;
export interface CloudWeatherBoundsData {
  data: Float32Array;
  nodeCount: number;
  regionCount: number;
}
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function prepareCloudWeatherBounds(
  weather: Uint8Array,
  width: number,
  height: number,
  domain: Domain,
  current: () => boolean = () => true,
  yieldWork: () => Promise<void> = yieldTask,
): Promise<CloudWeatherBoundsData> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    weather.length !== width * height * 4
  ) {
    throw new Error("Invalid cloud weather bounds source.");
  }
  // Max pooling preserves every occupied texel. Sector envelopes include the
  // larger pooled filter footprint as well as the original bilinear support.
  const columns = Math.min(width, 360),
    rows = Math.min(height, 181);
  const pooled = new Uint8Array(columns * rows * 4);
  await yieldWork();
  for (let y = 0; y < height; y++) {
    if (!current()) {
      throw new Error("Cloud weather bounds request expired.");
    }
    const row = Math.floor((y * rows) / height) * columns;
    for (let x = 0; x < width; x++) {
      const target = (row + Math.floor((x * columns) / width)) * 4;
      pooled[target] = Math.max(pooled[target], weather[(y * width + x) * 4]);
    }
    if ((y + 1) % 16 === 0) {
      await yieldWork();
    }
  }
  if (!current()) {
    throw new Error("Cloud weather bounds request expired.");
  }
  const { buildCloudWeatherOctree } =
    await import("../../Scene/Weather/CloudWeatherOctree.js");
  if (!current()) {
    throw new Error("Cloud weather bounds request expired.");
  }
  const tree = buildCloudWeatherOctree(pooled, columns, rows, {
    ...domain,
    blockSize: 4,
  });
  if (tree.nodes.length > 16384) {
    throw new Error("Cloud weather bounds capacity exceeded.");
  }
  const data = new Float32Array(4 + Math.max(1, tree.nodes.length) * 16);
  const integers = new Uint32Array(data.buffer),
    split = { high: 0, low: 0 };
  integers[0] = tree.nodes.length;
  integers[1] = 1;
  for (let i = 0; i < tree.nodes.length; i++) {
    const node = tree.nodes[i],
      offset = 4 + i * 16;
    for (let axis = 0; axis < 3; axis++) {
      EncodedCartesian3.encode(node.min[axis], split);
      data[offset + axis] = split.high;
      data[offset + 4 + axis] = split.low;
      EncodedCartesian3.encode(node.max[axis], split);
      data[offset + 8 + axis] = split.high;
      data[offset + 12 + axis] = split.low;
    }
    integers[offset + 3] = node.escape;
    integers[offset + 7] = node.region >= 0 ? 1 : 0;
    data[offset + 11] = Math.min(1, node.maximumCoverage + 1 / 255);
  }
  return {
    data,
    nodeCount: tree.nodes.length,
    regionCount: tree.regions.length,
  };
}

export class CloudWeatherBounds {
  buffer: GPUBuffer | null = null;
  pending = false;
  failed = false;
  generation = 0;
  builds = 0;
  nodeCount = 0;
  regionCount = 0;
  liveBytes = 0;
  preparationMilliseconds = 0;
  private readonly device: GPUDevice;
  private source: Uint8Array | null = null;
  private key = "";
  private publishedSource: Uint8Array | null = null;
  private publishedKey = "";
  private prepared: CloudWeatherBoundsData | null = null;
  private disposed = false;
  private frame = -1;
  private bufferFrame = -1;
  private retired: GPUBuffer[] = [];
  private readonly monitor?: AsyncResourceMonitor;

  constructor(device: GPUDevice, monitor?: AsyncResourceMonitor) {
    this.device = device;
    this.monitor = monitor;
  }

  prepare(
    weather: Uint8Array | null,
    width: number,
    height: number,
    version: number,
    domain: Domain,
    enabled: boolean,
    frame = 0,
  ): GPUBuffer | null {
    if (frame !== this.frame) {
      for (const buffer of this.retired) {
        buffer.destroy();
      }
      this.retired.length = 0;
      this.frame = frame;
    }
    if (!enabled || this.disposed || !weather) {
      if (this.pending || this.prepared) {
        this.generation++;
        this.pending = false;
        this.prepared = null;
        this.key = "";
      }
      this.failed = false;
      return null;
    }
    const key = [
      width,
      height,
      version,
      domain.equatorialRadius,
      domain.polarRadius,
      domain.bottom,
      domain.top,
    ].join("/");
    if (
      this.publishedSource === weather &&
      this.publishedKey === key &&
      this.buffer
    ) {
      this.bufferFrame = frame;
      return this.buffer;
    }
    if (this.source !== weather || this.key !== key) {
      this.generation++;
      this.source = weather;
      this.key = key;
      this.pending = false;
      this.prepared = null;
      this.failed = false;
    }
    if (this.prepared) {
      const ready = this.prepared;
      let buffer: GPUBuffer | null = null;
      try {
        buffer = this.device.createBuffer({
          label: "Cloud weather volume bounds",
          size: ready.data.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(buffer, 0, ready.data);
      } catch (error) {
        buffer?.destroy();
        this.prepared = null;
        this.failed = true;
        console.error("Cloud weather volume bounds upload failed.", error);
        return null;
      }
      const previous = this.buffer,
        previousFrame = this.bufferFrame;
      this.buffer = buffer;
      this.bufferFrame = frame;
      this.prepared = null;
      this.publishedSource = weather;
      this.publishedKey = key;
      this.nodeCount = ready.nodeCount;
      this.regionCount = ready.regionCount;
      this.liveBytes = ready.data.byteLength;
      this.builds++;
      // Prepared views in this frame may still reference the previous slice.
      if (previous) {
        if (previousFrame === frame) {
          this.retired.push(previous);
        } else {
          previous.destroy();
        }
      }
      return buffer;
    }
    if (!this.pending && !this.failed) {
      const generation = this.generation,
        started = performance.now();
      const current = () => !this.disposed && this.generation === generation;
      this.pending = true;
      const token = this.monitor?.begin({
        kind: "texture-upload",
        key: `cloud-weather-bounds:${generation}`,
        label: "Cloud weather volume bounds",
        priority: "background",
      });
      void prepareCloudWeatherBounds(
        weather,
        width,
        height,
        domain,
        current,
      ).then(
        (ready) => {
          if (current()) {
            this.prepared = ready;
            this.pending = false;
            this.preparationMilliseconds = performance.now() - started;
          }
          if (token) {
            this.monitor!.resolve(token);
          }
        },
        (error: unknown) => {
          if (current()) {
            this.pending = false;
            this.failed = true;
            console.error(
              "Cloud weather volume bounds preparation failed.",
              error,
            );
            if (token) {
              this.monitor!.reject(token, error);
            }
          } else if (token) {
            this.monitor!.resolve(token);
          }
        },
      );
    }
    // A previous field cannot certify emptiness in the current weather slice.
    return null;
  }

  destroy(): void {
    this.disposed = true;
    this.generation++;
    this.pending = false;
    this.buffer?.destroy();
    this.buffer = null;
    this.prepared = null;
    for (const buffer of this.retired) {
      buffer.destroy();
    }
    this.retired.length = 0;
    this.source = null;
    this.publishedSource = null;
    this.key = "";
    this.publishedKey = "";
    this.nodeCount = 0;
    this.regionCount = 0;
    this.liveBytes = 0;
  }
}
