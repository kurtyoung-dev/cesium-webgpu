/// <reference types="@webgpu/types" />
import Composite from "../../Shaders/WebGPU/Environment/CloudPrimaryComposite.js";
import { ShaderSourceId } from "./WebGPUShaderDefines.js";
import { WebGPUShaderModuleCache } from "./WebGPUShaderModuleCache.js";

export class CloudPrimaryReuseResources {
  private readonly device: GPUDevice;
  private readonly modules: WebGPUShaderModuleCache;
  private layout: GPUBindGroupLayout | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline | null>();
  private groups: {
    scene: GPUTextureView;
    cloud: GPUTextureView;
    group: GPUBindGroup;
  }[] = [];
  private disposed = false;

  constructor(device: GPUDevice) {
    this.device = device;
    this.modules = new WebGPUShaderModuleCache(device);
  }

  getPipeline(
    context: CesiumGraphicsContext,
    format: GPUTextureFormat,
  ): GPURenderPipeline | null {
    if (this.disposed || context._device !== this.device) {
      return null;
    }
    const cache = context.webgpuPipelineCache;
    if (!cache) {
      return null;
    }
    if (this.pipelines.has(format)) {
      return this.pipelines.get(format) ?? null;
    }
    this.layout ??= this.device.createBindGroupLayout({
      label: "Cloud primary composition layout",
      entries: [0, 1].map((binding) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" as const },
      })),
    });
    this.pipelineLayout ??= this.device.createPipelineLayout({
      bindGroupLayouts: [this.layout],
    });
    const module = this.modules.getOrCreate(
      ShaderSourceId.CLOUD_PRIMARY_COMPOSITE,
      Composite,
      0,
      "Cloud primary composition",
    );
    const descriptor = {
      name: `Cloud primary composition ${format}`,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: "vertexMain" },
      fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
      primitive: { topology: "triangle-list" as const },
    };
    const ready = cache.getPipelineSync(descriptor) ?? null;
    this.pipelines.set(format, ready);
    if (!ready) {
      void cache.getPipeline(descriptor).then(
        (pipeline) => {
          if (!this.disposed && context._device === this.device) {
            this.pipelines.set(format, pipeline);
          }
        },
        (error: unknown) => {
          console.error(
            "Cloud primary composition pipeline creation failed.",
            error,
          );
        },
      );
    }
    return ready;
  }

  getBindGroup(scene: GPUTextureView, cloud: GPUTextureView): GPUBindGroup {
    const existing = this.groups.find(
      (value) => value.scene === scene && value.cloud === cloud,
    );
    if (existing) {
      return existing.group;
    }
    const group = this.device.createBindGroup({
      label: "Cloud primary composition",
      layout: this.layout!,
      entries: [
        { binding: 0, resource: scene },
        { binding: 1, resource: cloud },
      ],
    });
    // Two scene ping-pong views are sufficient; replaced targets must not grow
    // a device-lifetime list of obsolete texture views.
    if (this.groups.length === 2) {
      this.groups.shift();
    }
    this.groups.push({ scene, cloud, group });
    return group;
  }

  destroy(): void {
    this.disposed = true;
    this.groups.length = 0;
    this.pipelines.clear();
    this.pipelineLayout = null;
    this.layout = null;
  }
}
