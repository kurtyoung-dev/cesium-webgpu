/// <reference types="@webgpu/types" />
/**
 * WebGPU Order-Independent Transparency (OIT)
 *
 * Implements weighted blended OIT for correct translucent rendering.
 * Based on McGuire & Bavoil 2013 "Weighted Blended Order-Independent Transparency"
 *
 * Strategy:
 * 1. Render translucent geometry to MRT (Multi-Render-Target):
 *    - Target 0 (accumulation): premultiplied-alpha color * weight
 *    - Target 1 (revealage): alpha * weight (product)
 * 2. Composite over the opaque scene using a fullscreen pass:
 *    - finalColor = accumulation.rgb / max(accumulation.a, epsilon)
 *    - alpha = 1 - revealage
 *
 * If dual-source-blending is available (Chrome 128+), we use it for
 * single-pass OIT. Otherwise, we fall back to this MRT approach.
 *
 * @private
 */

import { WebGPURenderTarget } from "./WebGPURenderTarget.js";

// OIT composite shader: combines accumulation + revealage textures with opaque scene
const OIT_COMPOSITE_WGSL = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var accumulationTex: texture_2d<f32>;
@group(0) @binding(1) var revealageTex: texture_2d<f32>;
@group(0) @binding(2) var oitSampler: sampler;

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
  let accum = textureSample(accumulationTex, oitSampler, in.uv);
  let reveal = textureSample(revealageTex, oitSampler, in.uv).r;

  // Avoid division by zero
  let eps = 0.00001;

  // Weighted blended OIT composite
  let averageColor = accum.rgb / max(accum.a, eps);

  // revealage is the product of (1-alpha) for all fragments
  // So alpha = 1 - revealage
  let alpha = 1.0 - reveal;

  return vec4<f32>(averageColor * alpha, alpha);
}
`;

export class WebGPUOIT {
  private _device: GPUDevice | null = null;
  private _width: number = 0;
  private _height: number = 0;

  // MRT render targets for OIT accumulation pass
  private _accumulationTexture: GPUTexture | null = null;
  private _revealageTexture: GPUTexture | null = null;
  private _accumulationView: GPUTextureView | null = null;
  private _revealageView: GPUTextureView | null = null;

  // Shared depth-stencil (borrowed from opaque pass)
  private _depthStencilView: GPUTextureView | null = null;

  // Composite pipeline resources
  private _compositePipeline: GPURenderPipeline | null = null;
  private _compositeBindGroupLayout: GPUBindGroupLayout | null = null;
  private _compositeBindGroup: GPUBindGroup | null = null;
  private _compositeSampler: GPUSampler | null = null;

  // Scene color format for format-compatible single-target mode
  private _sceneColorFormat: GPUTextureFormat = "bgra8unorm";

  // Whether OIT is supported and enabled
  private _supported: boolean = false;
  private _isDestroyed: boolean = false;

  /**
   * Whether OIT is supported on this device.
   */
  get isSupported(): boolean {
    return this._supported;
  }

  /**
   * The MRT render pass descriptor for the OIT accumulation pass.
   * Translucent geometry is rendered using this pass.
   */
  getAccumulationPassDescriptor(
    depthStencilView: GPUTextureView,
  ): GPURenderPassDescriptor | null {
    if (!this._accumulationView || !this._revealageView) {
      return null;
    }

    return {
      label: "OIT-Accumulation-Pass",
      colorAttachments: [
        {
          view: this._accumulationView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
        {
          view: this._revealageView,
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
        },
      ],
      depthStencilAttachment: {
        view: depthStencilView,
        depthLoadOp: "load" as GPULoadOp,
        depthStoreOp: "store" as GPUStoreOp,
        depthReadOnly: true, // Don't modify depth from opaque pass
        stencilLoadOp: "load" as GPULoadOp,
        stencilStoreOp: "store" as GPUStoreOp,
      },
    };
  }

  /**
   * Update OIT render targets to match viewport size.
   */
  update(device: GPUDevice, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;

    const needsRecreate =
      this._device !== device ||
      this._width !== width ||
      this._height !== height;

    if (!needsRecreate) return;

    this._device = device;
    this._width = width;
    this._height = height;
    this._supported = true;

    this._destroyTargets();

    // Accumulation texture: rgba16float for high precision
    this._accumulationTexture = device.createTexture({
      label: "OIT-Accumulation",
      size: { width, height },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._accumulationView = this._accumulationTexture.createView();

    // Revealage texture: r8unorm is sufficient (single channel)
    this._revealageTexture = device.createTexture({
      label: "OIT-Revealage",
      size: { width, height },
      format: "r8unorm",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._revealageView = this._revealageTexture.createView();

    // Create composite pipeline
    this._createCompositePipeline(device);
  }

  /**
   * Execute the OIT composite pass: blend accumulated transparency over the opaque scene.
   * @param encoder Command encoder
   * @param targetView The opaque scene color texture view to composite onto
   * @param targetFormat The format of the target texture
   */
  executeComposite(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetFormat: GPUTextureFormat,
  ): void {
    if (
      !this._compositePipeline ||
      !this._accumulationView ||
      !this._revealageView
    ) {
      return;
    }

    this._updateCompositeBindGroup();
    if (!this._compositeBindGroup) return;

    const passDesc: GPURenderPassDescriptor = {
      label: "OIT-Composite-Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load" as GPULoadOp, // Preserve opaque content
          storeOp: "store" as GPUStoreOp,
        },
      ],
    };

    const pass = encoder.beginRenderPass(passDesc);
    pass.setPipeline(this._compositePipeline);
    pass.setBindGroup(0, this._compositeBindGroup);
    pass.draw(3); // Fullscreen triangle
    pass.end();
  }

  private _createCompositePipeline(device: GPUDevice): void {
    const shaderModule = device.createShaderModule({
      label: "OIT-Composite-Shader",
      code: OIT_COMPOSITE_WGSL,
    });

    this._compositeBindGroupLayout = device.createBindGroupLayout({
      label: "OIT-Composite-BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this._compositeSampler = device.createSampler({
      label: "OIT-Composite-Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "OIT-Composite-PipelineLayout",
      bindGroupLayouts: [this._compositeBindGroupLayout],
    });

    this._compositePipeline = device.createRenderPipeline({
      label: "OIT-Composite-Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: "rgba8unorm", // Will be overridden at draw time if HDR
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private _updateCompositeBindGroup(): void {
    if (
      !this._device ||
      !this._compositeBindGroupLayout ||
      !this._compositeSampler ||
      !this._accumulationView ||
      !this._revealageView
    ) {
      return;
    }

    this._compositeBindGroup = this._device.createBindGroup({
      label: "OIT-Composite-BindGroup",
      layout: this._compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: this._accumulationView },
        { binding: 1, resource: this._revealageView },
        { binding: 2, resource: this._compositeSampler },
      ],
    });
  }

  private _destroyTargets(): void {
    this._accumulationTexture?.destroy();
    this._revealageTexture?.destroy();
    this._accumulationTexture = null;
    this._revealageTexture = null;
    this._accumulationView = null;
    this._revealageView = null;
    this._compositeBindGroup = null;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._destroyTargets();
    this._compositePipeline = null;
    this._compositeBindGroupLayout = null;
    this._compositeSampler = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
