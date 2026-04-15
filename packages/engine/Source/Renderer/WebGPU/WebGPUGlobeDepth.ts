/// <reference types="@webgpu/types" />
/**
 * WebGPU equivalent of GlobeDepth.js
 *
 * Manages depth framebuffers for the globe rendering pass. In WebGL, GlobeDepth
 * copies depth to a color texture (via a fullscreen quad + shader) so that shaders
 * can sample it. In WebGPU, we can directly use the depth texture as a shader resource
 * via texture_depth_2d, which is more efficient.
 *
 * Responsibilities:
 * - Maintain render target for globe color+depth rendering
 * - Provide depth texture for shader access (terrain clamping, picking, etc.)
 * - Support MSAA with automatic resolve
 * - Depth copy for 3D Tiles stencil-masked depth update
 * - Pick color framebuffer (separate, no MSAA)
 *
 * @private
 */

import { WebGPURenderTarget } from "./WebGPURenderTarget.js";
import {
  makeBindGroupLayout,
  texture,
  sampler,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

// Depth copy shader: reads depth and writes to a color texture as packed RGBA
const DEPTH_COPY_WGSL = /* wgsl */ `
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Fullscreen triangle
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0)
  );
  var out: VertexOutput;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let depth = textureSample(depthTex, depthSampler, in.uv);
  // Pack float depth into RGBA8 for compatibility with existing globe depth texture consumers
  let d = depth;
  let r = floor(d * 255.0) / 255.0;
  let g = floor((d - r) * 65025.0) / 255.0;
  let b = floor((d - r - g / 255.0) * 16581375.0) / 255.0;
  return vec4<f32>(r, g, b, 1.0);
}
`;

export interface WebGPUGlobeDepthOptions {
  picking?: boolean;
}

export class WebGPUGlobeDepth {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;
  private _numSamples: number = 1;

  // Main color+depth render target (supports MSAA)
  private _outputTarget: WebGPURenderTarget | null = null;

  // Pick-mode render target (no MSAA)
  private _pickTarget: WebGPURenderTarget | null = null;

  // Depth copy target: stores packed depth as RGBA color texture
  private _depthCopyTarget: WebGPURenderTarget | null = null;

  // Temp depth copy target for the 2-step stencil-masked update
  private _tempDepthCopyTarget: WebGPURenderTarget | null = null;

  // Depth copy pipeline resources
  private _depthCopyPipeline: GPURenderPipeline | null = null;
  private _depthCopyBindGroupLayout: GPUBindGroupLayout | null = null;
  private _depthCopyBindGroup: GPUBindGroup | null = null;
  private _depthCopySampler: GPUSampler | null = null;

  private _isPicking: boolean = false;
  private _isDestroyed: boolean = false;

  // Public state used by Scene.js
  private _clearGlobeDepth: boolean = false;
  private _useHdr: boolean = false;

  constructor(options?: WebGPUGlobeDepthOptions) {
    this._isPicking = options?.picking ?? false;
  }

  /**
   * The render target for globe color+depth rendering.
   * Returns pick target when in pick mode.
   */
  get colorFramebufferTarget(): WebGPURenderTarget | null {
    return this._isPicking ? this._pickTarget : this._outputTarget;
  }

  /**
   * The render pass descriptor to use for rendering globe geometry.
   */
  get framebuffer(): GPURenderPassDescriptor | null {
    const target = this.colorFramebufferTarget;
    return target?.renderPassDescriptor ?? null;
  }

  /**
   * The depth texture for shader sampling.
   * In WebGPU, this can be used directly as texture_depth_2d.
   */
  get depthTexture(): GPUTexture | undefined {
    const target = this.colorFramebufferTarget;
    return target?.getDepthTexture() ?? undefined;
  }

  /**
   * The packed-depth-as-color texture (for compatibility with existing code
   * that expects globeDepthTexture as a color texture).
   */
  get globeDepthTexture(): GPUTexture | undefined {
    return this._depthCopyTarget?.getColorTexture() ?? undefined;
  }

  /**
   * The color texture from the globe rendering pass.
   */
  get colorTexture(): GPUTexture | undefined {
    const target = this.colorFramebufferTarget;
    return target?.getColorTexture() ?? undefined;
  }

  get clearGlobeDepth(): boolean {
    return this._clearGlobeDepth;
  }

  set clearGlobeDepth(value: boolean) {
    this._clearGlobeDepth = value;
  }

  /**
   * Update all render targets to match current viewport and settings.
   * Only recreates resources when parameters change.
   */
  update(
    device: GPUDevice,
    width: number,
    height: number,
    hdr: boolean,
    numSamples: number,
    canvasFormat: GPUTextureFormat,
  ): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height ||
      this._numSamples !== numSamples ||
      this._useHdr !== hdr;

    if (!needsRecreate) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._numSamples = numSamples;
    this._useHdr = hdr;

    this._destroyTargets();

    const colorFormat = hdr
      ? ("rgba16float" as GPUTextureFormat)
      : canvasFormat;

    // Main output target with MSAA + depth-stencil
    this._outputTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-Output",
      width,
      height,
      colorFormats: [colorFormat],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: numSamples,
    });

    // Pick target (no MSAA)
    this._pickTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-Pick",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      depthStencilFormat: "depth24plus-stencil8",
      sampleCount: 1,
    });

    // Depth copy target: stores packed depth as RGBA
    this._depthCopyTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-DepthCopy",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      sampleCount: 1,
    });

    // Temp copy for stencil-masked update
    this._tempDepthCopyTarget = new WebGPURenderTarget(device, {
      name: "GlobeDepth-TempDepthCopy",
      width,
      height,
      colorFormats: ["rgba8unorm"],
      sampleCount: 1,
    });

    // Create depth copy pipeline if not cached
    this._createDepthCopyPipeline(device);
  }

  /**
   * Copy the depth buffer to a color texture for shader access.
   * This is the WebGPU equivalent of GlobeDepth.executeCopyDepth().
   */
  executeCopyDepth(encoder: GPUCommandEncoder): void {
    if (
      !this._depthCopyTarget ||
      !this._depthCopyPipeline ||
      !this._outputTarget
    ) {
      return;
    }

    // Create bind group with current depth texture
    this._updateDepthCopyBindGroup();

    if (!this._depthCopyBindGroup) return;

    const desc = this._depthCopyTarget.getLoadPassDescriptor();
    if (!desc) return;

    const pass = encoder.beginRenderPass(desc);
    pass.setPipeline(this._depthCopyPipeline);
    pass.setBindGroup(0, this._depthCopyBindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }

  /**
   * Create the depth copy render pipeline.
   */
  private _createDepthCopyPipeline(device: GPUDevice): void {
    if (this._depthCopyPipeline) return;

    const shaderModule = device.createShaderModule({
      label: "GlobeDepth-DepthCopy-Shader",
      code: DEPTH_COPY_WGSL,
    });

    this._depthCopyBindGroupLayout = makeBindGroupLayout(
      device,
      "GlobeDepth-DepthCopy-BindGroupLayout",
      [
        texture(0, Stage.FRAGMENT, { sampleType: "depth" }),
        sampler(1, Stage.FRAGMENT),
      ],
    );

    this._depthCopySampler = device.createSampler({
      label: "GlobeDepth-DepthCopy-Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "GlobeDepth-DepthCopy-PipelineLayout",
      bindGroupLayouts: [this._depthCopyBindGroupLayout],
    });

    this._depthCopyPipeline = device.createRenderPipeline({
      label: "GlobeDepth-DepthCopy-Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /**
   * Update the bind group to reference the current depth texture.
   */
  private _updateDepthCopyBindGroup(): void {
    const device = this._device;
    const target = this.colorFramebufferTarget;
    if (
      !device ||
      !target ||
      !this._depthCopyBindGroupLayout ||
      !this._depthCopySampler
    ) {
      return;
    }

    const depthTexture = target.getDepthTexture();
    if (!depthTexture) return;

    const depthView = depthTexture.createView({
      aspect: "depth-only",
      label: "GlobeDepth-DepthTextureView",
    });

    this._depthCopyBindGroup = device.createBindGroup({
      label: "GlobeDepth-DepthCopy-BindGroup",
      layout: this._depthCopyBindGroupLayout,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._depthCopySampler },
      ],
    });
  }

  private _destroyTargets(): void {
    this._outputTarget?.destroy();
    this._pickTarget?.destroy();
    this._depthCopyTarget?.destroy();
    this._tempDepthCopyTarget?.destroy();
    this._outputTarget = null;
    this._pickTarget = null;
    this._depthCopyTarget = null;
    this._tempDepthCopyTarget = null;
    this._depthCopyBindGroup = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTargets();
    this._depthCopyPipeline = null;
    this._depthCopyBindGroupLayout = null;
    this._depthCopySampler = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
