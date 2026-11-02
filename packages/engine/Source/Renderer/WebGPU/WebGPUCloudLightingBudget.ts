/// <reference types="@webgpu/types" />
export interface CloudLightingBudgetOptions {
  cloudContributionLighting?: boolean;
  cloudLightingContributionThreshold?: number;
  cloudLightingMinSamples?: number;
  cloudLightingThinOpticalDepth?: number;
}
export function resolveCloudLightingBudget(
  options: CloudLightingBudgetOptions,
): Float32Array | null {
  if (options.cloudContributionLighting !== true) {
    return null;
  }
  const threshold = options.cloudLightingContributionThreshold ?? 0.02;
  const minimum = options.cloudLightingMinSamples ?? 2;
  const thin = options.cloudLightingThinOpticalDepth ?? 0.02;
  if (
    ![threshold, minimum, thin].every(Number.isFinite) ||
    threshold <= 0 ||
    threshold > 16 ||
    minimum < 1 ||
    minimum > 64 ||
    thin < 0 ||
    thin > 16
  ) {
    return null;
  }
  return new Float32Array([threshold, Math.floor(minimum), thin, 0]);
}
export class CloudLightingBudget {
  buffer: GPUBuffer | null = null;
  private readonly device: GPUDevice;
  private disposed = false;
  private failed = false;
  constructor(device: GPUDevice) {
    this.device = device;
  }
  prepare(data: Float32Array): GPUBuffer | null {
    if (
      this.disposed ||
      this.failed ||
      data.length !== 4 ||
      !data.every(Number.isFinite)
    ) {
      return null;
    }
    try {
      this.buffer ??= this.device.createBuffer({
        label: "Cloud lighting budget",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.buffer, 0, data);
      return this.buffer;
    } catch (error) {
      this.failed = true;
      this.buffer?.destroy();
      this.buffer = null;
      console.error("Cloud lighting budget preparation failed.", error);
      return null;
    }
  }
  destroy(): void {
    this.disposed = true;
    this.buffer?.destroy();
    this.buffer = null;
  }
}
