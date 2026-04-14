/**
 * @module WebGPUAutoExposure
 *
 * GPU compute-based auto-exposure for the WebGPU post-process pipeline.
 * Replaces the WebGL multi-pass framebuffer reduction (AutoExposure.js)
 * with a two-pass compute shader that's both simpler and faster.
 *
 * Pass 1: parallel reduction — each 16×16 workgroup reduces its tile to
 * a single luminance value via shared-memory tree reduction.
 *
 * Pass 2: single workgroup reduces all tile values to one scalar and
 * applies temporal smoothing against the previous frame.
 *
 * The output is a single f32 (`averageLuminance`) that the tonemapping
 * stage reads via `getExposureMultiplier()` to implement adaptive
 * eye adaptation. The tonemapping shader's `exposure` uniform is
 * multiplied by `1 / (averageLuminance + epsilon)` to brighten dark
 * scenes and darken bright scenes.
 *
 * @private
 */

/// <reference types="@webgpu/types" />

import AutoExposureWGSL from "../../Shaders/WebGPU/Compute/AutoExposure.js";
import {
  makeBindGroupLayout,
  storageBuffer,
  texture,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

export interface AutoExposureConfig {
  minimumLuminance?: number;
  maximumLuminance?: number;
  adaptationSeconds?: number;
  targetFps?: number;
}

export class WebGPUAutoExposure {
  private _device: GPUDevice | null = null;
  private _pass1Pipeline: GPUComputePipeline | null = null;
  private _pass2Pipeline: GPUComputePipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private _intermediateBuffer: GPUBuffer | null = null;
  private _resultBuffer: GPUBuffer | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _paramsData: Float32Array = new Float32Array(8);

  private _width = 0;
  private _height = 0;
  private _tileCountX = 0;
  private _tileCountY = 0;

  private _minimumLuminance: number;
  private _maximumLuminance: number;
  private _adaptationRate: number;

  private _averageLuminance = 0.5;
  private _readbackBuffer: GPUBuffer | null = null;
  private _readbackPending = false;

  enabled = true;
  private _initialized = false;

  constructor(config?: AutoExposureConfig) {
    this._minimumLuminance = config?.minimumLuminance ?? 0.1;
    this._maximumLuminance = config?.maximumLuminance ?? 10.0;
    const fps = config?.targetFps ?? 60;
    const seconds = config?.adaptationSeconds ?? 1.5;
    this._adaptationRate = 1.0 / (fps * seconds);
  }

  get averageLuminance(): number {
    return this._averageLuminance;
  }

  getExposureMultiplier(): number {
    return 1.0 / Math.max(this._averageLuminance, 0.001);
  }

  initialize(device: GPUDevice, width: number, height: number): void {
    if (
      this._initialized &&
      this._width === width &&
      this._height === height &&
      this._device === device
    ) {
      return;
    }

    this._device = device;
    this._width = width;
    this._height = height;
    this._tileCountX = Math.ceil(width / 16);
    this._tileCountY = Math.ceil(height / 16);
    const totalTiles = this._tileCountX * this._tileCountY;

    this._destroyBuffers();

    if (!this._pass1Pipeline) {
      this._createPipelines(device);
    }

    this._intermediateBuffer = device.createBuffer({
      label: "AutoExposure intermediate",
      size: Math.max(totalTiles * 4, 4),
      usage: GPUBufferUsage.STORAGE,
    });

    // Result buffer: holds 1 f32 (the average luminance). Initialized to
    // 0.5 so the first frame's temporal smoothing has a sane starting point.
    this._resultBuffer = device.createBuffer({
      label: "AutoExposure result",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this._readbackBuffer = device.createBuffer({
      label: "AutoExposure readback",
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this._paramsBuffer = device.createBuffer({
      label: "AutoExposure params",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._initialized = true;
  }

  /**
   * Dispatch both compute passes. Must be called inside a command encoder
   * scope BEFORE the tonemapping stage executes.
   *
   * @param encoder The command encoder for this frame
   * @param sceneColorView The scene framebuffer's color texture view (HDR)
   */
  dispatch(encoder: GPUCommandEncoder, sceneColorTexture: GPUTexture): void {
    if (
      !this.enabled ||
      !this._device ||
      !this._pass1Pipeline ||
      !this._pass2Pipeline ||
      !this._intermediateBuffer ||
      !this._resultBuffer ||
      !this._paramsBuffer
    ) {
      return;
    }

    const device = this._device;

    // Update params
    const p = this._paramsData;
    p[0] = this._width;
    p[1] = this._height;
    p[2] = this._tileCountX;
    p[3] = this._tileCountY;
    p[4] = this._minimumLuminance;
    p[5] = this._maximumLuminance;
    p[6] = this._adaptationRate;
    p[7] = 0; // pad
    device.queue.writeBuffer(this._paramsBuffer, 0, p);

    // Create bind group with this frame's scene texture
    const sceneView = sceneColorTexture.createView();
    const bindGroup = device.createBindGroup({
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: sceneView },
        { binding: 1, resource: { buffer: this._intermediateBuffer } },
        { binding: 2, resource: { buffer: this._resultBuffer } },
        { binding: 3, resource: { buffer: this._paramsBuffer } },
      ],
    });

    // Pass 1: tile reduction
    const pass1 = encoder.beginComputePass({
      label: "AutoExposure pass1",
    });
    pass1.setPipeline(this._pass1Pipeline);
    pass1.setBindGroup(0, bindGroup);
    pass1.dispatchWorkgroups(this._tileCountX, this._tileCountY, 1);
    pass1.end();

    // Pass 2: final reduction + temporal smoothing
    const pass2 = encoder.beginComputePass({
      label: "AutoExposure pass2",
    });
    pass2.setPipeline(this._pass2Pipeline);
    pass2.setBindGroup(0, bindGroup);
    pass2.dispatchWorkgroups(1, 1, 1);
    pass2.end();

    // Async readback for CPU-side access (1-frame latency, non-blocking)
    if (!this._readbackPending && this._readbackBuffer) {
      encoder.copyBufferToBuffer(
        this._resultBuffer,
        0,
        this._readbackBuffer,
        0,
        4,
      );
      this._readbackPending = true;
      this._readbackBuffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (this._readbackBuffer) {
            const data = new Float32Array(
              this._readbackBuffer.getMappedRange(),
            );
            this._averageLuminance = data[0];
            this._readbackBuffer.unmap();
          }
          this._readbackPending = false;
        })
        .catch(() => {
          this._readbackPending = false;
        });
    }
  }

  private _createPipelines(device: GPUDevice): void {
    const module = device.createShaderModule({
      label: "AutoExposure compute",
      code: AutoExposureWGSL,
    });

    this._bindGroupLayout = makeBindGroupLayout(device, "AutoExposure BGL", [
      texture(0, Stage.COMPUTE),
      storageBuffer(1, Stage.COMPUTE),
      storageBuffer(2, Stage.COMPUTE),
      uniformBuffer(3, Stage.COMPUTE),
    ]);

    const layout = device.createPipelineLayout({
      label: "AutoExposure PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pass1Pipeline = device.createComputePipeline({
      label: "AutoExposure pass1",
      layout,
      compute: { module, entryPoint: "pass1" },
    });

    this._pass2Pipeline = device.createComputePipeline({
      label: "AutoExposure pass2",
      layout,
      compute: { module, entryPoint: "pass2" },
    });
  }

  private _destroyBuffers(): void {
    this._intermediateBuffer?.destroy();
    this._resultBuffer?.destroy();
    this._readbackBuffer?.destroy();
    this._paramsBuffer?.destroy();
    this._intermediateBuffer = null;
    this._resultBuffer = null;
    this._readbackBuffer = null;
    this._paramsBuffer = null;
    this._bindGroup = null;
  }

  destroy(): void {
    this._destroyBuffers();
    this._pass1Pipeline = null;
    this._pass2Pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
    this._initialized = false;
  }
}
