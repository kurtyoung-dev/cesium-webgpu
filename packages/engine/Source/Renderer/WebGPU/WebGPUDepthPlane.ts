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
 * For WebGPU, we replicate the same geometry computation but with a
 * WebGPU render pipeline configured for depth-only output. Positions
 * are split into RTE (Relative-To-Eye) high/low pairs for planetary
 * scale precision.
 *
 * The depth plane is only active in SCENE3D mode and is positioned at
 * the ellipsoid surface visible from the camera. It ensures that objects
 * behind the horizon are properly depth-culled.
 *
 * @private
 */

import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Ellipsoid from "../../Core/Ellipsoid.js";
import OrthographicFrustum from "../../Core/OrthographicFrustum.js";
import { jsModule, m4Values } from "./webgpuTypeHelpers.js";

/** Type-shape for the JS-only EncodedCartesian3.encode static. */
interface EncodedCartesian3Statics {
  encode: (value: number, result: { high: number; low: number }) => void;
}

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

// SceneMode.SCENE3D = 3
const SCENE_MODE_3D = 3;

// Scratch variables for depth quad computation (avoid per-frame allocations)
const scratchCartesian1 = new Cartesian3();
const scratchCartesian2 = new Cartesian3();
const scratchCartesian3 = new Cartesian3();
const scratchCartesian4 = new Cartesian3();
const scratchCartesian5 = new Cartesian3();

// 4 corners × 6 floats (posHigh xyz + posLow xyz) = 24 floats
const depthQuadRTE = new Float32Array(24);
// 4×4 matrix (64 bytes) + vec3+pad (16) + vec3+pad (16) = 96 bytes = 24 floats
const uniformScratch = new Float32Array(24);

/**
 * Compute the depth quad corners in world space from the camera and ellipsoid.
 * This is a direct port of DepthPlane.js's computeDepthQuad().
 *
 * Returns a Float32Array of 12 values: 4 corners × 3 components (x,y,z)
 */
function computeDepthQuadCorners(
  ellipsoid: any,
  camera: any,
  result: Cartesian3[],
): void {
  const radii = ellipsoid.radii;
  let center: Cartesian3;
  let eastOffset: Cartesian3;
  let northOffset: Cartesian3;

  if (camera.frustum instanceof OrthographicFrustum) {
    center = Cartesian3.clone(Cartesian3.ZERO, scratchCartesian1)!;
    eastOffset = camera.rightWC;
    northOffset = camera.upWC;
  } else {
    const p = camera.positionWC;

    // Find the corresponding position in the scaled space of the ellipsoid.
    const q = Cartesian3.multiplyComponents(
      ellipsoid.oneOverRadii,
      p,
      scratchCartesian1,
    );

    const qUnit = Cartesian3.normalize(q, scratchCartesian2);

    // Determine the east and north directions at q.
    const eUnit = Cartesian3.normalize(
      Cartesian3.cross(Cartesian3.UNIT_Z, q, scratchCartesian3),
      scratchCartesian3,
    );
    const nUnit = Cartesian3.normalize(
      Cartesian3.cross(qUnit, eUnit, scratchCartesian4),
      scratchCartesian4,
    );

    const qMagnitude = Cartesian3.magnitude(q);

    // Determine the radius of the 'limb' of the ellipsoid.
    const wMagnitude = Math.sqrt(qMagnitude * qMagnitude - 1.0);

    // Compute the center and offsets.
    center = Cartesian3.multiplyByScalar(
      qUnit,
      1.0 / qMagnitude,
      scratchCartesian1,
    );
    const scalar = wMagnitude / qMagnitude;
    eastOffset = Cartesian3.multiplyByScalar(eUnit, scalar, scratchCartesian2);
    northOffset = Cartesian3.multiplyByScalar(nUnit, scalar, scratchCartesian3);
  }

  // Compute 4 corners in scaled ellipsoid space, then scale back to world
  // Upper-left
  const ul = Cartesian3.add(center, northOffset, scratchCartesian5);
  Cartesian3.subtract(ul, eastOffset, ul);
  Cartesian3.multiplyComponents(radii, ul, result[0]);

  // Lower-left
  const ll = Cartesian3.subtract(center, northOffset, scratchCartesian5);
  Cartesian3.subtract(ll, eastOffset, ll);
  Cartesian3.multiplyComponents(radii, ll, result[1]);

  // Upper-right
  const ur = Cartesian3.add(center, northOffset, scratchCartesian5);
  Cartesian3.add(ur, eastOffset, ur);
  Cartesian3.multiplyComponents(radii, ur, result[2]);

  // Lower-right
  const lr = Cartesian3.subtract(center, northOffset, scratchCartesian5);
  Cartesian3.add(lr, eastOffset, lr);
  Cartesian3.multiplyComponents(radii, lr, result[3]);
}

// Scratch object for EncodedCartesian3.encode output (plain {high, low} pair)
const scratchHL = { high: 0.0, low: 0.0 };

/**
 * Encode 4 world-space corners into RTE vertex data.
 * Output: interleaved [posHighX, posHighY, posHighZ, posLowX, posLowY, posLowZ] × 4
 *
 * Uses EncodedCartesian3.encode per-component (returns plain {high, low})
 * to avoid the writeElements/fromCartesian path whose module-level
 * encodedP variable can hit initialization-order issues in bundled builds.
 */
function encodeQuadToRTE(corners: Cartesian3[], result: Float32Array): void {
  const encode = jsModule<EncodedCartesian3Statics>(EncodedCartesian3).encode;
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const off = i * 6;

    encode(c.x, scratchHL);
    result[off] = scratchHL.high;
    result[off + 3] = scratchHL.low;

    encode(c.y, scratchHL);
    result[off + 1] = scratchHL.high;
    result[off + 4] = scratchHL.low;

    encode(c.z, scratchHL);
    result[off + 2] = scratchHL.high;
    result[off + 5] = scratchHL.low;
  }
}

// Scratch corners - allocated once
const scratchCorners = [
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
];

// Indexed triangle list for the quad: two triangles from 4 corners
// Matches WebGL DepthPlane: indices [0, 1, 2, 2, 1, 3]
// But we use triangle-strip topology: [0, 1, 2, 3] draws the same quad
// (upperLeft, lowerLeft, upperRight, lowerRight)

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
  private _ellipsoidOffset: number;

  // Track whether the depth plane is enabled for the current frame
  private _enabled: boolean = false;

  constructor(ellipsoidOffset: number = 0) {
    this._ellipsoidOffset = ellipsoidOffset;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /**
   * Initialize the depth plane pipeline (once per device).
   */
  initialize(
    device: GPUDevice,
    depthFormat: GPUTextureFormat,
    colorFormat: GPUTextureFormat = "bgra8unorm",
  ): void {
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
            format: colorFormat, // Must match canvas format (typically bgra8unorm)
            writeMask: 0, // No color writes — depth only
          },
        ],
      },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        // less-equal for planetary-scale precision robustness.
        depthCompare: "less-equal",
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: undefined,
        cullMode: "none",
      },
    });

    // Pre-allocate vertex buffer for 4 corners × 24 bytes each = 96 bytes
    this._vertexBuffer = device.createBuffer({
      label: "DepthPlane-Vertices",
      size: 96, // 4 corners × 6 floats × 4 bytes
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
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
   * High-level update method called by WebGPUSceneRenderer.
   * Computes depth plane geometry from the frame state's camera and ellipsoid,
   * then updates vertices and uniforms.
   *
   * @param frameState The current frame state (contains camera, mapProjection)
   * @param device The GPU device for buffer writes
   */
  update(frameState: CesiumFrameState, device: GPUDevice): void {
    // The depth plane is only used in 3D mode (SceneMode.SCENE3D = 3)
    if (
      !frameState ||
      !frameState.camera ||
      frameState.mode !== SCENE_MODE_3D
    ) {
      this._enabled = false;
      return;
    }

    if (!this._pipeline) {
      return;
    }

    // Allow offsetting the ellipsoid radius to address rendering artifacts
    // below ellipsoid zero elevation (matches WebGL DepthPlane behavior)
    const mapProj = frameState.mapProjection as { ellipsoid: { radii: CesiumCartesian3 } };
    const baseRadii = mapProj.ellipsoid.radii;
    const ellipsoid = new Ellipsoid(
      baseRadii.x + this._ellipsoidOffset,
      baseRadii.y + this._ellipsoidOffset,
      baseRadii.z + this._ellipsoidOffset,
    );

    // Compute the 4 quad corners in world space
    computeDepthQuadCorners(ellipsoid, frameState.camera, scratchCorners);

    // Encode corners into RTE vertex data
    encodeQuadToRTE(scratchCorners, depthQuadRTE);

    // Update vertex buffer
    this.updateVertices(device, depthQuadRTE);

    // Build uniform data: mvpRelativeToEye (mat4) + encodedCameraHigh (vec3+pad) + encodedCameraLow (vec3+pad)
    const uniformState = frameState.context.uniformState;
    if (!uniformState) {
      this._enabled = false;
      return;
    }

    const mvpRTE = uniformState.modelViewProjectionRelativeToEye;
    const mvp = m4Values(mvpRTE);
    for (let i = 0; i < 16; i++) {
      uniformScratch[i] = mvp[i];
    }

    const camHigh = uniformState.encodedCameraPositionMCHigh;
    const camLow = uniformState.encodedCameraPositionMCLow;
    uniformScratch[16] = camHigh.x;
    uniformScratch[17] = camHigh.y;
    uniformScratch[18] = camHigh.z;
    uniformScratch[19] = 0.0; // padding
    uniformScratch[20] = camLow.x;
    uniformScratch[21] = camLow.y;
    uniformScratch[22] = camLow.z;
    uniformScratch[23] = 0.0; // padding

    this.updateUniforms(device, uniformScratch);

    this._enabled = true;
    this._vertexCount = 4; // triangle strip with 4 vertices
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
