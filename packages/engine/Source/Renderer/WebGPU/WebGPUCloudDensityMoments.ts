/// <reference types="@webgpu/types" />
import DensityDomain from "../../Shaders/WebGPU/Environment/CloudDensityDomain.js";
import DensityFormation from "../../Shaders/WebGPU/Environment/CloudDensityFormation.js";
import DensityMomentsBake from "../../Shaders/WebGPU/Compute/CloudDensityMomentsBake.js";

export class CloudDensityMomentsResources {
  readonly device: GPUDevice;
  view: GPUTextureView | null = null;
  texture: GPUTexture | null = null;
  bakeCount = 0;
  disposed = false;
  failed = false;
  private pending = false;
  private layout: GPUBindGroupLayout | null = null;
  private pipelines: GPUComputePipeline[] | null = null;
  private parameters: GPUBuffer | null = null;
  private samples: GPUBuffer | null = null;
  private shape: GPUTextureView | null = null;
  private detail: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private puffSize = NaN;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  prepare(
    shape: GPUTextureView,
    detail: GPUTextureView,
    sampler: GPUSampler,
    puffSize: number,
  ): GPUTextureView | null {
    if (this.disposed || this.failed) {
      return null;
    }
    if (!this.pipelines) {
      if (!this.pending) {
        this.requestPipelines();
      }
      return null;
    }
    if (
      this.shape === shape &&
      this.detail === detail &&
      this.sampler === sampler &&
      this.puffSize === puffSize
    ) {
      return this.view;
    }
    const device = this.device;
    this.texture ??= device.createTexture({
      label: "Cloud formed-density moments",
      size: [32, 16, 16],
      dimension: "3d",
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.view ??= this.texture.createView({ dimension: "3d" });
    this.parameters ??= device.createBuffer({
      label: "Cloud density statistics parameters",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.samples ??= device.createBuffer({
      label: "Cloud density distribution",
      size: 128 * 8,
      usage: GPUBufferUsage.STORAGE,
    });
    device.queue.writeBuffer(
      this.parameters,
      0,
      new Float32Array([puffSize, 0, 0, 0, 0, 0, 0, 0]),
    );
    const group = device.createBindGroup({
      layout: this.layout!,
      entries: [
        { binding: 0, resource: shape },
        { binding: 1, resource: detail },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: this.parameters } },
        { binding: 4, resource: { buffer: this.samples } },
        { binding: 5, resource: this.view },
      ],
    });
    const encoder = device.createCommandEncoder({
      label: "Cloud density statistics",
    });
    const samplePass = encoder.beginComputePass({
      label: "Cloud density distribution",
    });
    samplePass.setPipeline(this.pipelines[0]);
    samplePass.setBindGroup(0, group);
    samplePass.dispatchWorkgroups(2);
    samplePass.end();
    const momentPass = encoder.beginComputePass({
      label: "Cloud formed-density moments",
    });
    momentPass.setPipeline(this.pipelines[1]);
    momentPass.setBindGroup(0, group);
    momentPass.dispatchWorkgroups(8, 4, 4);
    momentPass.end();
    device.queue.submit([encoder.finish()]);
    this.shape = shape;
    this.detail = detail;
    this.sampler = sampler;
    this.puffSize = puffSize;
    this.bakeCount++;
    return this.view;
  }

  private requestPipelines(): void {
    const device = this.device;
    this.pending = true;
    this.layout = device.createBindGroupLayout({
      label: "Cloud density statistics layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: "filtering" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "rgba16float",
            viewDimension: "3d",
          },
        },
      ],
    });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.layout],
    });
    const module = device.createShaderModule({
      label: "Cloud density statistics",
      code: [DensityDomain, DensityFormation, DensityMomentsBake].join("\n"),
    });
    void Promise.all([
      device.createComputePipelineAsync({
        label: "Cloud density distribution",
        layout,
        compute: { module, entryPoint: "sampleCloudDensityDistribution" },
      }),
      device.createComputePipelineAsync({
        label: "Cloud formed-density moments",
        layout,
        compute: { module, entryPoint: "bakeCloudDensityMoments" },
      }),
    ]).then(
      (pipelines) => {
        if (!this.disposed) {
          this.pipelines = pipelines;
        }
      },
      (error: unknown) => {
        if (!this.disposed) {
          this.failed = true;
          console.error(
            "Cloud density statistics pipeline creation failed.",
            error,
          );
        }
      },
    );
  }

  destroy(): void {
    this.disposed = true;
    this.texture?.destroy();
    this.parameters?.destroy();
    this.samples?.destroy();
    this.texture = null;
    this.view = null;
    this.parameters = null;
    this.samples = null;
    this.pipelines = null;
    this.layout = null;
    this.shape = null;
    this.detail = null;
    this.sampler = null;
  }
}
