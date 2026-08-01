/// <reference types="@webgpu/types" />
/**
 * WebGPU MotionBlurEffect (C6-VELOCITY-MOTION-BLUR)
 *
 * Velocity-buffer motion blur. A single fullscreen pass that gathers the
 * scene color along a per-pixel screen-space velocity vector, smearing
 * fast-moving content in the direction of motion. Opt-in via
 * `scene.motionBlur` (default false) and a byte-identical passthrough when
 * off — the host never records the pass while the effect is disabled, and
 * even when bound the shader returns the crisp center when intensity <= 0.
 *
 * Velocity is derived from the SAME data TAA already produces:
 *   - the per-pixel model MRT velocity texture (object motion), and
 *   - camera reprojection from depth using the current/previous VP-RTE
 *     matrices + camera delta (whole-scene camera motion).
 * This is near-pure reuse of the TAA motion-vector plumbing — the CPU-side
 * `updateMotionVectorParams` mirrors `WebGPUTAAEffect.updateMotionVectorParams`.
 *
 * WebGPU-only (a WebGPU-EXCEEDS feature); no WebGL twin. Runs in the
 * linear/HDR domain AFTER TAA and BEFORE tonemap, matching the depth
 * texture's projection so the unproject stays self-consistent.
 *
 * @private
 * @module WebGPUMotionBlurEffect
 */

import type { PostProcessEffect } from "./WebGPUPostProcessEffects.js";
import MotionBlurSource from "../../Shaders/WebGPU/PostProcess/MotionBlur.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { _invertMatrix4 } from "./WebGPUTAAEffect.js";

// Params UBO layout (256-byte aligned; 240 bytes of content):
//   offset   0: texelSize          vec2<f32>   (8B)
//   offset   8: intensity          f32         (4B)
//   offset  12: sampleCount        f32         (4B)
//   offset  16: velocityValid      u32         (4B)
//   offset  20: maxBlurPx          f32         (4B)
//   offset  24: _pad0              vec2<f32>   (8B)
//   offset  32: currentVpRte       mat4x4<f32> (64B)
//   offset  96: previousVpRte      mat4x4<f32> (64B)
//   offset 160: inverseCurrentVpRte mat4x4<f32>(64B)
//   offset 224: cameraDelta        vec3<f32>   (12B)
//   offset 236: _pad1              f32         (4B)
const PARAMS_BYTES = 256;
const PARAMS_FLOATS = PARAMS_BYTES / 4;

interface MotionBlurBindGroupEntry {
  source: GPUTextureView;
  depth: GPUTextureView;
  velocity: GPUTextureView;
  bindGroup: GPUBindGroup;
}

export interface MotionBlurConfig {
  /** Blur strength multiplier applied to the velocity vector. Default 1.0. */
  intensity?: number;
  /** Number of taps gathered along the velocity vector. Default 12. */
  sampleCount?: number;
  /** Max smear length in texels (clamps teleports/disocclusions). Default 64. */
  maxBlurPx?: number;
}

export class WebGPUMotionBlurEffect implements PostProcessEffect {
  readonly name = "MotionBlur";
  enabled = false;

  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _paramsScratch = new Float32Array(PARAMS_FLOATS);
  private _paramsU32 = new Uint32Array(this._paramsScratch.buffer);
  private _bindGroupCache: [
    MotionBlurBindGroupEntry | null,
    MotionBlurBindGroupEntry | null,
  ] = [null, null];
  private _nextBindGroupSlot = 0;

  private _outputTex: GPUTexture | null = null;
  private _outputView: GPUTextureView | null = null;

  private _sampler: GPUSampler | null = null;
  private _depthSampler: GPUSampler | null = null;

  // 1x1 zero placeholder for the velocity binding when no MRT velocity
  // pass populated a real texture (same policy as TAA's motion placeholder).
  private _velocityPlaceholderView: GPUTextureView | null = null;

  private _width = 0;
  private _height = 0;
  private _format: GPUTextureFormat = "bgra8unorm";

  private _intensity: number;
  private _sampleCount: number;
  private _maxBlurPx: number;

  // Motion-vector state, mirrored from the TAA path. Kept FP64 so the
  // inverse(currentVpRte) preserves precision; down-cast to FP32 on upload.
  private _currentVpRte = new Float64Array(16);
  private _previousVpRte = new Float64Array(16);
  private _inverseCurrentVpRte = new Float64Array(16);
  private _cameraDelta: [number, number, number] = [0, 0, 0];
  private _motionVectorsValid = false;

  constructor(config: MotionBlurConfig = {}) {
    this._intensity = config.intensity ?? 1.0;
    this._sampleCount = config.sampleCount ?? 12;
    this._maxBlurPx = config.maxBlurPx ?? 64;
  }

  initialize(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    this._device = device;
    this._format = format;
    this._width = width;
    this._height = height;

    this._paramsBuffer = device.createBuffer({
      label: "MotionBlur_Params",
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._sampler = device.createSampler({
      label: "MotionBlur_Sampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this._depthSampler = device.createSampler({
      label: "MotionBlur_DepthSampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this._bindGroupLayout = makeBindGroupLayout(device, "MotionBlur_BGL", [
      texture(0, Stage.FRAGMENT),
      texture(1, Stage.FRAGMENT, { sampleType: "depth" }),
      sampler(2, Stage.FRAGMENT),
      uniformBuffer(3, Stage.FRAGMENT),
      texture(4, Stage.FRAGMENT),
      sampler(5, Stage.FRAGMENT, "non-filtering"),
    ]);

    const shaderModule = device.createShaderModule({
      label: "MotionBlur_Shader",
      code: MotionBlurSource,
    });

    this._pipeline = device.createRenderPipeline({
      label: "MotionBlur_Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._bindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._allocateOutput(width, height, format);

    // 1x1 zero rg16float velocity placeholder (matches the model MRT format).
    const placeholderTex = device.createTexture({
      label: "MotionBlur Velocity Placeholder",
      size: [1, 1, 1],
      format: "rg16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: placeholderTex },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this._velocityPlaceholderView = placeholderTex.createView();
  }

  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) {
      return;
    }
    this._width = width;
    this._height = height;
    this._allocateOutput(width, height, this._format);
  }

  /** Blur strength multiplier. */
  setIntensity(intensity: number): void {
    this._intensity = intensity;
  }

  /** Number of taps along the velocity vector. */
  setSampleCount(count: number): void {
    this._sampleCount = count;
  }

  /** Max smear length in texels. */
  setMaxBlurPx(px: number): void {
    this._maxBlurPx = px;
  }

  /**
   * Push motion-vector matrices + camera delta from the caller (Scene.js
   * pulling from `UniformState`). Mirrors `WebGPUTAAEffect.updateMotionVectorParams`.
   * Operates in FP64 so the inverse of `currentVpRte` preserves precision.
   */
  updateMotionVectorParams(
    currentVpRte: ArrayLike<number>,
    previousVpRte: ArrayLike<number>,
    cameraDeltaX: number,
    cameraDeltaY: number,
    cameraDeltaZ: number,
    valid: boolean,
  ): void {
    for (let i = 0; i < 16; i++) {
      this._currentVpRte[i] = currentVpRte[i];
      this._previousVpRte[i] = previousVpRte[i];
    }
    _invertMatrix4(this._currentVpRte, this._inverseCurrentVpRte);
    this._cameraDelta[0] = cameraDeltaX;
    this._cameraDelta[1] = cameraDeltaY;
    this._cameraDelta[2] = cameraDeltaZ;
    this._motionVectorsValid = valid;
  }

  execute(
    encoder: GPUCommandEncoder,
    sourceView: GPUTextureView,
    depthView: GPUTextureView | null,
    _sampler: GPUSampler,
    velocityView: GPUTextureView | null = null,
  ): GPUTextureView {
    if (
      !this._device ||
      !this._pipeline ||
      !this._paramsBuffer ||
      !this._sampler ||
      !this._depthSampler ||
      !this._bindGroupLayout ||
      !this._outputView ||
      !depthView ||
      this._intensity <= 0.0
    ) {
      // No usable input / inert config — pass the source through unchanged.
      return sourceView;
    }

    const velocityBindView = velocityView ?? this._velocityPlaceholderView;
    if (!velocityBindView) {
      return sourceView;
    }

    const p = this._paramsScratch;
    p[0] = this._width > 0 ? 1.0 / this._width : 0.0;
    p[1] = this._height > 0 ? 1.0 / this._height : 0.0;
    p[2] = this._intensity;
    p[3] = this._sampleCount;
    const u32View = this._paramsU32;
    u32View[4] = this._motionVectorsValid ? 1 : 0;
    p[5] = this._maxBlurPx;
    p[6] = 0;
    p[7] = 0;
    for (let i = 0; i < 16; i++) p[8 + i] = this._currentVpRte[i];
    for (let i = 0; i < 16; i++) p[24 + i] = this._previousVpRte[i];
    for (let i = 0; i < 16; i++) p[40 + i] = this._inverseCurrentVpRte[i];
    p[56] = this._cameraDelta[0];
    p[57] = this._cameraDelta[1];
    p[58] = this._cameraDelta[2];
    p[59] = 0;
    this._device.queue.writeBuffer(this._paramsBuffer, 0, p);

    let bg: GPUBindGroup | null = null;
    for (let i = 0; i < this._bindGroupCache.length; i++) {
      const entry = this._bindGroupCache[i];
      if (
        entry?.source === sourceView &&
        entry.depth === depthView &&
        entry.velocity === velocityBindView
      ) {
        bg = entry.bindGroup;
        break;
      }
    }
    if (!bg) {
      bg = this._device.createBindGroup({
        label: "MotionBlur_BG",
        layout: this._bindGroupLayout,
        entries: [
          { binding: 0, resource: sourceView },
          { binding: 1, resource: depthView },
          { binding: 2, resource: this._sampler },
          { binding: 3, resource: { buffer: this._paramsBuffer } },
          { binding: 4, resource: velocityBindView },
          { binding: 5, resource: this._depthSampler },
        ],
      });
      this._bindGroupCache[this._nextBindGroupSlot] = {
        source: sourceView,
        depth: depthView,
        velocity: velocityBindView,
        bindGroup: bg,
      };
      this._nextBindGroupSlot = (this._nextBindGroupSlot + 1) & 1;
    }

    const pass = encoder.beginRenderPass({
      label: "MotionBlur_Pass",
      colorAttachments: [
        {
          view: this._outputView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3, 1, 0, 0);
    pass.end();

    return this._outputView;
  }

  destroy(): void {
    this._outputTex?.destroy();
    this._outputTex = null;
    this._outputView = null;
    if (this._paramsBuffer) {
      this._paramsBuffer.destroy();
      this._paramsBuffer = null;
    }
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._bindGroupCache = [null, null];
    this._device = null;
  }

  private _allocateOutput(
    width: number,
    height: number,
    format: GPUTextureFormat,
  ): void {
    if (!this._device) return;
    this._outputTex?.destroy();
    this._outputTex = this._device.createTexture({
      label: "MotionBlur_Output",
      size: { width, height },
      format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._outputView = this._outputTex.createView({
      label: "MotionBlur_Output_View",
    });
  }
}
