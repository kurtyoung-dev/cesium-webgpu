/**
 * @module WebGPUDebugDepthOverlay
 *
 * Tier 2 debug pass — visualizes the scene depth attachment as a grayscale
 * fullscreen overlay. Used for z-fighting diagnostics, depth-precision
 * analysis at the horizon (stars vs terrain), and verifying that
 * 3D Tiles vs terrain depth values are sane.
 *
 * Standalone from `WebGPUPostProcessPipeline` because depth textures need
 * `sampleType: "depth"` (or `"unfilterable-float"`) bind group layouts,
 * which the production post-process pipeline doesn't carry. Keeping this
 * separate avoids polluting the production pipeline class with debug-only
 * bind group variants.
 *
 * Activation: `Scene.debugShowDepthAsColor = true`. The scene render path
 * checks `frameState.debugShowDepthAsColor` after the main scene pass and
 * invokes `execute()` instead of the normal post-process chain.
 *
 * Linearization: raw NDC depth in [0,1] is non-linear (most precision near
 * the camera). The shader linearizes via the standard
 *   `linearZ = (near * far) / (far - depth * (far - near))`
 * conversion and normalizes to [0,1] using camera near/far so the entire
 * scene maps usefully to grayscale. The unmodified raw depth is also
 * available in the green channel for diagnosing buffer-precision issues
 * directly.
 */

/// <reference types="@webgpu/types" />

const DEPTH_OVERLAY_WGSL = /* wgsl */ `
struct Uniforms {
  // x = near, y = far, z = mode (0 = linearized red, 1 = raw green, 2 = both),
  // w = unused
  params: vec4<f32>,
};

@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vid: u32) -> VertexOutput {
  // Fullscreen triangle covering the viewport (no vertex buffer needed).
  // Vertex 0: (-1,-1), Vertex 1: (3,-1), Vertex 2: (-1,3)
  var output: VertexOutput;
  let x = f32((vid << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vid & 2u) * 2.0 - 1.0;
  output.position = vec4<f32>(x, y, 0.0, 1.0);
  // Flip Y because WebGPU's screen origin is top-left and we want UV (0,0)
  // at the top of the viewport.
  output.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return output;
}

fn linearizeDepth(rawDepth: f32, near: f32, far: f32) -> f32 {
  // Standard reverse of the perspective projection's z mapping.
  // Returns world-space distance from near plane.
  let denom = far - rawDepth * (far - near);
  return (near * far) / max(denom, 1e-6);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  // textureSampleLevel on a depth texture returns f32 directly.
  let raw = textureSampleLevel(depthTexture, depthSampler, input.uv, 0.0);
  let near = u.params.x;
  let far = u.params.y;
  let mode = u.params.z;

  // Linearized depth normalized to [0..1] across the camera near/far range.
  let linear = linearizeDepth(raw, near, far);
  let linearNorm = clamp((linear - near) / max(far - near, 1e-6), 0.0, 1.0);

  // Raw NDC depth — useful for spotting precision tiers near the far plane.
  let rawVis = clamp(raw, 0.0, 1.0);

  // Mode selector lets users compare linearized vs raw without recompiling.
  // 0 = linearized grayscale, 1 = raw grayscale, 2 = combined (R=linear,
  // G=raw, B=0). Default is mode 0.
  if (mode > 1.5) {
    return vec4<f32>(linearNorm, rawVis, 0.0, 1.0);
  } else if (mode > 0.5) {
    return vec4<f32>(rawVis, rawVis, rawVis, 1.0);
  }
  return vec4<f32>(linearNorm, linearNorm, linearNorm, 1.0);
}
`;

/**
 * Standalone debug pass that draws a fullscreen depth visualization
 * over the scene framebuffer. Self-contained: owns its shader module,
 * pipeline, bind group layout, sampler, and uniform buffer.
 */
export class WebGPUDebugDepthOverlay {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _sampler: GPUSampler | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  private _uniformData: Float32Array = new Float32Array(4);
  private _canvasFormat: GPUTextureFormat = "bgra8unorm";
  private _isInitialized: boolean = false;
  private _isDestroyed: boolean = false;

  /**
   * Lazy initialization. Safe to call multiple times — re-initializes only
   * if the device or canvas format changes.
   */
  initialize(device: GPUDevice, canvasFormat: GPUTextureFormat): void {
    if (
      this._isInitialized &&
      this._device === device &&
      this._canvasFormat === canvasFormat
    ) {
      return;
    }
    this._device = device;
    this._canvasFormat = canvasFormat;

    const shaderModule = device.createShaderModule({
      label: "DebugDepthOverlay shader",
      code: DEPTH_OVERLAY_WGSL,
    });

    this._bindGroupLayout = device.createBindGroupLayout({
      label: "DebugDepthOverlay BGL",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          // Depth textures require sampleType: "depth" — they are NOT
          // compatible with the "float" sampleType used by the production
          // post-process pipeline.
          texture: { sampleType: "depth" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          // Depth textures use a non-filtering sampler. The
          // "non-filtering" type pairs with "depth" sample type. Trying
          // "filtering" here causes a validation error on every device.
          sampler: { type: "non-filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "DebugDepthOverlay PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "DebugDepthOverlay Pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this._sampler = device.createSampler({
      label: "DebugDepthOverlay Sampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });

    this._uniformBuffer = device.createBuffer({
      label: "DebugDepthOverlay UB",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._isInitialized = true;
    this._isDestroyed = false;
  }

  /**
   * Draws a fullscreen depth visualization to `targetView`, sampling from
   * `depthView`. Caller is responsible for ending any in-progress render
   * pass on the encoder before invoking this; we begin and end our own.
   *
   * @param near - Camera near plane distance (used for linearization)
   * @param far - Camera far plane distance
   * @param mode - 0 linearized, 1 raw NDC, 2 combined R=linear G=raw
   */
  execute(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView,
    targetView: GPUTextureView,
    near: number,
    far: number,
    mode: number = 0,
  ): void {
    if (!this._isInitialized || !this._device || !this._pipeline) {
      return;
    }

    this._uniformData[0] = near;
    this._uniformData[1] = far;
    this._uniformData[2] = mode;
    this._uniformData[3] = 0;
    this._device.queue.writeBuffer(this._uniformBuffer!, 0, this._uniformData);

    const bindGroup = this._device.createBindGroup({
      label: "DebugDepthOverlay BG",
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: this._sampler! },
        { binding: 2, resource: { buffer: this._uniformBuffer! } },
      ],
    });

    const passEncoder = encoder.beginRenderPass({
      label: "DebugDepthOverlay Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    passEncoder.setPipeline(this._pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    // Single fullscreen triangle, 3 vertices, no vertex buffer.
    passEncoder.draw(3, 1, 0, 0);
    passEncoder.end();
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._uniformBuffer?.destroy();
    this._uniformBuffer = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._sampler = null;
    this._device = null;
    this._isInitialized = false;
    this._isDestroyed = true;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }
}

export default WebGPUDebugDepthOverlay;
