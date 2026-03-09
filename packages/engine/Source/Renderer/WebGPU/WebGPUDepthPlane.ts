/// <reference types="@webgpu/types" />
/**
 * WebGPU Depth Plane
 *
 * Renders a depth-only quad at the ellipsoid surface to ensure correct
 * depth testing for objects that should be behind the globe.
 *
 * In the WebGL path (DepthPlane.js), this creates a quad geometry in
 * scaled ellipsoid space based on the camera position and limb radius,
 * then renders with depth-write enabled and color-write disabled.
 *
 * For WebGPU, we use the same geometry computation but with a WebGPU
 * render pipeline configured for depth-only output.
 *
 * The depth plane is only active in SCENE3D mode and is positioned at
 * the ellipsoid surface visible from the camera. It ensures that objects
 * behind the horizon are properly depth-culled.
 *
 * @private
 */

// Simple depth-only WGSL shader for the depth plane
// Uses RTE (Relative-To-Eye) precision for planetary-scale rendering
const DEPTH_PLANE_WGSL = /* wgsl */ `
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

fn translateRelativeToEye(
  posHigh: vec3<f32>, posLow: vec3<f32>,
  camHigh: vec3<f32>, camLow: vec3<f32>
) -> vec3<f32> {
  return (posHigh - camHigh) + (posLow - camLow);
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  let posRTE = translateRelativeToEye(
    input.positionHigh, input.positionLow,
    uniforms.encodedCameraHigh, uniforms.encodedCameraLow
  );
  var out: VertexOutput;
  out.position = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);
  return out;
}

// Fragment shader outputs nothing (depth-only rendering)
// The pipeline has colorWriteMask = 0 so this is effectively a no-op
@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;

export class WebGPUDepthPlane {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _vertexBuffer: GPUBuffer | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _shaderModule: GPUShaderModule | null = null;
  private _vertexCount: number = 0;
  private _isDestroyed: boolean = false;

  // Track whether the depth plane is enabled for the current frame
  private _enabled: boolean = false;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /**
   * Initialize the depth plane pipeline (once per device).
   */
  initialize(device: GPUDevice, depthFormat: GPUTextureFormat): void {
    if (this._pipeline) return;

    this._device = device;

    this._shaderModule = device.createShaderModule({
      label: "DepthPlane-Shader",
      code: DEPTH_PLANE_WGSL,
    });

    this._bindGroupLayout = device.createBindGroupLayout({
      label: "DepthPlane-BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    // 96 bytes = mat4(64) + vec3+pad(16) + vec3+pad(16)
    this._uniformBuffer = device.createBuffer({
      label: "DepthPlane-Uniforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._bindGroup = device.createBindGroup({
      label: "DepthPlane-BindGroup",
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "DepthPlane-PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "DepthPlane-Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: this._shaderModule,
        entryPoint: "vertexMain",
        buffers: [
          {
            // positionHigh + positionLow interleaved
            arrayStride: 24, // 6 floats × 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" }, // posHigh
              { shaderLocation: 1, offset: 12, format: "float32x3" }, // posLow
            ],
          },
        ],
      },
      fragment: {
        module: this._shaderModule,
        entryPoint: "fragmentMain",
        targets: [
          {
            format: "rgba8unorm",
            writeMask: 0, // No color writes — depth only
          },
        ],
      },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: undefined,
        cullMode: "none",
      },
    });
  }

  /**
   * Update the depth plane vertex data from the computed quad geometry.
   * Called each frame with the quad corners computed by DepthPlane.js logic.
   *
   * @param device The GPU device
   * @param vertices Float32Array of interleaved [posHighX, posHighY, posHighZ, posLowX, posLowY, posLowZ] × 4 corners
   */
  updateVertices(device: GPUDevice, vertices: Float32Array): void {
    if (!vertices || vertices.length === 0) return;

    this._vertexCount = vertices.length / 6; // 6 floats per vertex

    if (!this._vertexBuffer || this._vertexBuffer.size < vertices.byteLength) {
      this._vertexBuffer?.destroy();
      this._vertexBuffer = device.createBuffer({
        label: "DepthPlane-Vertices",
        size: vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    device.queue.writeBuffer(
      this._vertexBuffer,
      0,
      vertices as Float32Array<ArrayBuffer>,
    );
  }

  /**
   * Update the depth plane uniforms (MVP, camera position).
   */
  updateUniforms(device: GPUDevice, uniformData: Float32Array): void {
    if (!this._uniformBuffer || !uniformData) return;
    device.queue.writeBuffer(
      this._uniformBuffer,
      0,
      uniformData as Float32Array<ArrayBuffer>,
    );
  }

  /**
   * Execute the depth plane draw command on the given render pass.
   */
  execute(renderPass: GPURenderPassEncoder): void {
    if (
      !this._enabled ||
      !this._pipeline ||
      !this._vertexBuffer ||
      !this._bindGroup ||
      this._vertexCount === 0
    ) {
      return;
    }

    renderPass.setPipeline(this._pipeline);
    renderPass.setBindGroup(0, this._bindGroup);
    renderPass.setVertexBuffer(0, this._vertexBuffer);
    renderPass.draw(this._vertexCount);
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._vertexBuffer?.destroy();
    this._uniformBuffer?.destroy();
    this._vertexBuffer = null;
    this._uniformBuffer = null;
    this._bindGroup = null;
    this._pipeline = null;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
