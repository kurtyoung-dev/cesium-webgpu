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
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
// Batch 230 — scene-FB target helper (MRT slot-1 placeholder).
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";
import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";

/** Type-shape for the JS-only EncodedCartesian3.encode static. */
interface EncodedCartesian3Statics {
  encode: (value: number, result: { high: number; low: number }) => void;
}

// Simple depth-only WGSL shader for the depth plane
// Uses RTE (Relative-To-Eye) precision for planetary-scale rendering
//
// Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH): when `logDepth` is
// true the plane writes logarithmic `@builtin(frag_depth)` with the SAME
// encode as the globe / collections (csm_vertexLogDepth + csm_writeLogDepth
// contract — see WebGPULogDepth.ts). The depth plane occludes content behind
// the horizon; if it kept hyperbolic z (~1.0 at the limb) while everything
// else writes log z, geometry behind the limb (log z < 1.0) would wrongly
// pass the depth test and show through the planet. The `logDepthParams`
// uniform lane is ALWAYS present (static 112-byte layout, packed
// unconditionally) — only the log variant reads it.
function makeDepthPlaneWGSL(logDepth: boolean): string {
  return /* wgsl */ `
struct Uniforms {
  mvpRelativeToEye: mat4x4<f32>,
  encodedCameraHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraLow: vec3<f32>,
  _pad1: f32,
  // (near, far, oneOverLog2FarDepthFromNearPlusOne, reserved)
  logDepthParams: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) positionHigh: vec3<f32>,
  @location(1) positionLow: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,${
    logDepth
      ? `
  // Interpolated linear depthFromNearPlusOne; the FS converts to frag_depth.
  @location(0) v_logDepth: f32,`
      : ""
  }
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
  out.position = uniforms.mvpRelativeToEye * vec4<f32>(posRTE, 1.0);${
    logDepth
      ? `
  // csm_vertexLogDepth + csm_updatePositionDepth (canonical contract —
  // chunks/functions/csm_vertexLogDepth.wgsl). Clamp clip-z so FP rounding
  // at huge far/near ratios can't clip the vertex before the FS writes depth.
  out.v_logDepth = (out.position.w - uniforms.logDepthParams.x) + 1.0;
  out.position.z = clamp(out.position.z / out.position.w, 0.0, 1.0) * out.position.w;`
      : ""
  }
  return out;
}

${
  logDepth
    ? `// Depth-only rendering (colorWriteMask = 0) — but the log variant DOES
// write @builtin(frag_depth): log2 of the interpolated linear distance,
// matching csm_writeLogDepth.
struct FragOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fragmentMain(input: VertexOutput) -> FragOutput {
  var out: FragOutput;
  out.color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
  out.depth = log2(max(input.v_logDepth, 1e-9)) * uniforms.logDepthParams.z;
  return out;
}`
    : `// Fragment shader outputs nothing (depth-only rendering)
// The pipeline has colorWriteMask = 0 so this is effectively a no-op
@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}`
}
`;
}

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
// 28 floats = mat4(16) + camHigh(4) + camLow(4) + logDepthParams(4)
const uniformScratch = new Float32Array(28);
const DEPTH_PLANE_UNIFORM_BYTES = uniformScratch.byteLength;
const DEFAULT_UNIFORM_OFFSET_ALIGNMENT = 256;
// Cesium's planetary camera normally produces at most a small handful of
// natural frustums. Reserving four slices at initialization costs only 1 KiB
// with the common 256-byte alignment and avoids replacing the buffer/bind
// group on the first multi-frustum frame or ordinary altitude transition.
const INITIAL_UNIFORM_CAPACITY = 4;

// Pass-scoped geometry scratch. The depth-plane quad is camera/ellipsoid
// dependent but natural-frustum independent, so compute and upload it once
// before the frustum loop instead of allocating an Ellipsoid and rewriting the
// same vertices for every slice.
const scratchEllipsoidRadii = new Cartesian3();
const scratchEllipsoid = new Ellipsoid();

export type WebGPUDepthPlanePassKind = "scene" | "pick";

/**
 * Compute the depth quad corners in world space from the camera and ellipsoid.
 * This is a direct port of DepthPlane.js's computeDepthQuad().
 *
 * Returns a Float32Array of 12 values: 4 corners × 3 components (x,y,z)
 */
function computeDepthQuadCorners(
  ellipsoid: CesiumEllipsoid,
  camera: CesiumCamera,
  result: Cartesian3[],
): void {
  const radii = ellipsoid.radii as Cartesian3;
  let center: Cartesian3;
  let eastOffset: Cartesian3;
  let northOffset: Cartesian3;

  if (camera.frustum instanceof OrthographicFrustum) {
    center = Cartesian3.clone(Cartesian3.ZERO, scratchCartesian1)!;
    eastOffset = camera.rightWC as Cartesian3;
    northOffset = camera.upWC as Cartesian3;
  } else {
    const p = camera.positionWC as Cartesian3;

    // Find the corresponding position in the scaled space of the ellipsoid.
    const q = Cartesian3.multiplyComponents(
      ellipsoid.oneOverRadii as Cartesian3,
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
  private _pickPipeline: GPURenderPipeline | null = null;
  private _vertexBuffer: GPUBuffer | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _shaderModule: GPUShaderModule | null = null;
  private _vertexCount: number = 0;
  private _isDestroyed: boolean = false;
  private _ellipsoidOffset: number;
  private _uniformStride: number = DEFAULT_UNIFORM_OFFSET_ALIGNMENT;
  private _uniformCapacity: number = 0;
  private _uniformCursor: number = 0;
  private _currentUniformOffset: number = 0;
  private _passPrepared: boolean = false;
  private _directCompatibilityPass: boolean = false;
  private _dynamicOffsets = new Uint32Array(1);

  // Track whether the depth plane is enabled for the current frame
  private _enabled: boolean = false;

  // The fragment-output color format the pipeline was built against. Read by
  // the SceneRenderer's resource-ensure step to detect HDR-toggle drift and
  // rebuild the depth plane when the scene framebuffer's color format flips
  // (BGRA8Unorm ↔ RG11B10Ufloat / Rgba16Float). A mismatch here surfaces as
  // "Attachment state of [DepthPlane-Pipeline] not compatible with [Scene
  // Framebuffer Render Pass]" validation warnings every frame.
  _colorFormat: GPUTextureFormat | null = null;

  // Complete scene/pick attachment identity. The resource-ensure step uses
  // these fields to rebuild after MSAA/depth/pick-format drift.
  _depthFormat: GPUTextureFormat | null = null;
  _sampleCount: number = 1;
  _pickColorFormat: GPUTextureFormat | null = null;

  // Renderer-wide log depth (NEW-COLLECTIONS-LOG-DEPTH) — whether the
  // pipeline was built with the log-depth frag_depth shader variant. Read by
  // the SceneRenderer's resource-ensure step to detect a master-switch flip
  // and rebuild (same drift pattern as `_colorFormat`).
  _logDepth: boolean = false;

  constructor(ellipsoidOffset: number = 0) {
    this._ellipsoidOffset = ellipsoidOffset;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    this._enabled = value;
  }

  /** True only while this plane owns resources from the supplied device. */
  isForDevice(device: GPUDevice): boolean {
    return !this._isDestroyed && this._device === device;
  }

  /**
   * Allocate the uniform ring and its one stable dynamic-offset bind group.
   * Growth happens only before a pass starts, so no encoded draw can retain a
   * reference to a buffer that is destroyed during the same submission.
   */
  private _allocateUniformRing(device: GPUDevice, capacity: number): void {
    if (!this._bindGroupLayout) {
      return;
    }
    const nextCapacity = Math.max(1, Math.ceil(capacity));
    const nextBuffer = device.createBuffer({
      label: "DepthPlane-UniformRing",
      size: this._uniformStride * nextCapacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    let nextBindGroup: GPUBindGroup;
    try {
      nextBindGroup = device.createBindGroup({
        label: "DepthPlane-BindGroup",
        layout: this._bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: nextBuffer,
              offset: 0,
              size: DEPTH_PLANE_UNIFORM_BYTES,
            },
          },
        ],
      });
    } catch (error) {
      nextBuffer.destroy();
      throw error;
    }

    const previousBuffer = this._uniformBuffer;
    this._uniformBuffer = nextBuffer;
    this._bindGroup = nextBindGroup;
    this._uniformCapacity = nextCapacity;
    previousBuffer?.destroy();
  }

  /**
   * Initialize the depth plane pipeline (once per device).
   *
   * C-R7-RENDERER-MIGRATION (Batch 56). When a `pipelineCache` is supplied,
   * the depth-only pipeline is requested through the central
   * `WebGPURenderPipelineCache` so multiple `WebGPUDepthPlane` instances
   * (split-screen, multi-canvas) share a single `GPURenderPipeline` if
   * their descriptors match. Without a cache (e.g. legacy callers), falls
   * back to the previous synchronous `device.createRenderPipeline()`.
   *
   * @param device The GPU device
   * @param depthFormat Depth-stencil attachment format
   * @param colorFormat Color attachment format (writeMask = 0; depth-only)
   * @param pipelineCache Optional central pipeline cache for dedup
   * @param pickColorFormat Exact single-target pick framebuffer format
   */
  initialize(
    device: GPUDevice,
    depthFormat: GPUTextureFormat,
    colorFormat: GPUTextureFormat = "bgra8unorm",
    pipelineCache?: WebGPURenderPipelineCache | null,
    sampleCount: number = 1,
    useLogDepth: boolean = false,
    pickColorFormat: GPUTextureFormat = "rgba8unorm",
  ): void {
    if (this._pipeline) return;

    this._device = device;
    this._colorFormat = colorFormat;
    this._depthFormat = depthFormat;
    this._sampleCount = sampleCount;
    this._pickColorFormat = pickColorFormat;
    this._logDepth = useLogDepth;

    this._shaderModule = device.createShaderModule({
      label: useLogDepth ? "DepthPlane-Shader[ld]" : "DepthPlane-Shader",
      code: makeDepthPlaneWGSL(useLogDepth),
    });

    // VERTEX_FRAGMENT (Batch 253 — Batch 249 left this VERTEX-only): the
    // [ld] fragment shader reads `uniforms.logDepthParams.z` for the
    // csm_writeLogDepth contract, so [ld] pipeline creation failed with
    // "Entry point's stage (Fragment) is not in the binding visibility".
    // Unexercised until a gate scene actually had useDepthPlane=true
    // (probe-globe-default-limits). Superset visibility is valid for the
    // non-ld variant too (its FS simply doesn't read the binding). Same
    // bug class as the Batch-250 ComputeInstanceRender widening.
    this._bindGroupLayout = makeBindGroupLayout(
      device,
      "DepthPlane-BindGroupLayout",
      [
        uniformBuffer(0, Stage.VERTEX_FRAGMENT, {
          hasDynamicOffset: true,
          minBindingSize: DEPTH_PLANE_UNIFORM_BYTES,
        }),
      ],
    );

    // 112 bytes = mat4(64) + vec3+pad(16) + vec3+pad(16) +
    // logDepthParams(16). WebGPU dynamic uniform offsets must respect the
    // device alignment (normally 256 bytes), so each natural frustum receives
    // one aligned ring slice even though the logical payload stays 112 bytes.
    const alignment = Math.max(
      4,
      device.limits?.minUniformBufferOffsetAlignment ??
        DEFAULT_UNIFORM_OFFSET_ALIGNMENT,
    );
    this._uniformStride =
      Math.ceil(DEPTH_PLANE_UNIFORM_BYTES / alignment) * alignment;
    this._allocateUniformRing(device, INITIAL_UNIFORM_CAPACITY);

    const pipelineLayout = device.createPipelineLayout({
      label: "DepthPlane-PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    const pipelineName = useLogDepth
      ? "DepthPlane-Pipeline[ld]"
      : "DepthPlane-Pipeline";
    const vertex: WebGPURenderPipelineDescriptor["vertex"] = {
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
    };
    const primitive: GPUPrimitiveState = {
      topology: "triangle-strip",
      stripIndexFormat: undefined,
      cullMode: "none",
    };
    const descriptor: WebGPURenderPipelineDescriptor = {
      // The central cache keys on full attachment state, but the explicit name
      // keeps diagnostics and captured command streams self-describing.
      name: pipelineName,
      layout: pipelineLayout,
      vertex,
      fragment: {
        module: this._shaderModule,
        entryPoint: "fragmentMain",
        // The normal scene path uses its complete MRT topology.
        targets: makeSceneFBTargets(colorFormat, { writeMask: 0 }),
      },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      primitive,
      multisample: sampleCount > 1 ? { count: sampleCount } : undefined,
    };

    // C9-02A — the pick mini-frame is always single-target and single-sample.
    // Pre-request this attachment-compatible pipeline with the scene variant
    // so compilation does not begin on the first-pick hot path and the variant
    // is normally ready before interaction. Geometry, shader, layout, bind
    // group, and buffers stay shared.
    const pickDescriptor: WebGPURenderPipelineDescriptor = {
      name: `${pipelineName}[pick]`,
      layout: pipelineLayout,
      vertex,
      fragment: {
        module: this._shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: pickColorFormat, writeMask: 0 }],
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      primitive,
    };

    const createPipelineSync = (
      pipelineDescriptor: WebGPURenderPipelineDescriptor,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label: pipelineDescriptor.name,
        layout: pipelineDescriptor.layout ?? "auto",
        vertex: {
          module: pipelineDescriptor.vertex.module,
          entryPoint: pipelineDescriptor.vertex.entryPoint,
          buffers: pipelineDescriptor.vertex.buffers,
        },
        fragment: pipelineDescriptor.fragment
          ? {
              module: pipelineDescriptor.fragment.module,
              entryPoint: pipelineDescriptor.fragment.entryPoint,
              targets: pipelineDescriptor.fragment.targets,
            }
          : undefined,
        primitive: pipelineDescriptor.primitive,
        depthStencil: pipelineDescriptor.depthStencil,
        multisample: pipelineDescriptor.multisample,
      });

    if (pipelineCache) {
      for (const [pipelineDescriptor, assign] of [
        [
          descriptor,
          (pipeline: GPURenderPipeline) => (this._pipeline = pipeline),
        ],
        [
          pickDescriptor,
          (pipeline: GPURenderPipeline) => (this._pickPipeline = pipeline),
        ],
      ] as const) {
        pipelineCache
          .getPipeline(pipelineDescriptor)
          .then((pipeline) => {
            if (!this._isDestroyed) {
              assign(pipeline);
            }
          })
          .catch(() => {
            // The cache reports creation errors. Never substitute a pipeline
            // whose attachments differ from the active pass.
          });
      }
    } else {
      this._pipeline = createPipelineSync(descriptor);
      this._pickPipeline = createPipelineSync(pickDescriptor);
    }

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
   * Prepare one scene or pick draw sequence before any natural-frustum draw is
   * encoded. The uniform ring is grown up front, its cursor is reset, and the
   * camera-dependent (but frustum-independent) quad is uploaded exactly once.
   *
   * @param frameState The current frame state.
   * @param device The current device.
   * @param maximumDraws Maximum depth-plane draws encoded before submission.
   */
  beginPass(
    frameState: CesiumFrameState,
    device: GPUDevice,
    maximumDraws: number,
  ): void {
    this._uniformCursor = 0;
    this._currentUniformOffset = 0;
    this._dynamicOffsets[0] = 0;
    this._passPrepared = false;
    this._directCompatibilityPass = false;
    this._enabled = false;

    if (
      !frameState ||
      !frameState.camera ||
      frameState.mode !== SCENE_MODE_3D ||
      !this._bindGroupLayout ||
      !this._vertexBuffer
    ) {
      return;
    }

    const requiredCapacity = Math.max(1, Math.ceil(maximumDraws));
    if (
      !this._uniformBuffer ||
      !this._bindGroup ||
      this._uniformCapacity < requiredCapacity
    ) {
      this._allocateUniformRing(
        device,
        Math.max(requiredCapacity, this._uniformCapacity * 2),
      );
    }

    const mapProjection = frameState.mapProjection as
      { ellipsoid?: { radii?: CesiumCartesian3 } } | undefined;
    const baseRadii = mapProjection?.ellipsoid?.radii;
    if (!baseRadii || !this._uniformBuffer || !this._bindGroup) {
      return;
    }
    scratchEllipsoidRadii.x = baseRadii.x + this._ellipsoidOffset;
    scratchEllipsoidRadii.y = baseRadii.y + this._ellipsoidOffset;
    scratchEllipsoidRadii.z = baseRadii.z + this._ellipsoidOffset;
    // Ellipsoid.fromCartesian3 replaces five internal Cartesian3 fields. The
    // map ellipsoid and offset are stable for ordinary frames, so avoid those
    // otherwise-hidden allocations until the exact radii actually change.
    const preparedRadii = scratchEllipsoid.radii as Cartesian3;
    if (
      preparedRadii.x !== scratchEllipsoidRadii.x ||
      preparedRadii.y !== scratchEllipsoidRadii.y ||
      preparedRadii.z !== scratchEllipsoidRadii.z
    ) {
      Ellipsoid.fromCartesian3(scratchEllipsoidRadii, scratchEllipsoid);
    }

    computeDepthQuadCorners(
      scratchEllipsoid,
      frameState.camera,
      scratchCorners,
    );
    encodeQuadToRTE(scratchCorners, depthQuadRTE);
    this.updateVertices(device, depthQuadRTE);

    this._enabled = true;
    this._vertexCount = 4;
    this._passPrepared = true;
  }

  /**
   * Write the next aligned depth-plane uniform slice.
   */
  updateUniforms(device: GPUDevice, uniformData: Float32Array): void {
    if (!this._uniformBuffer || !uniformData) return;
    if (this._uniformCursor >= this._uniformCapacity) {
      throw new Error(
        `DepthPlane uniform ring exhausted (${this._uniformCursor + 1} draws, ` +
          `${this._uniformCapacity} reserved)`,
      );
    }
    const offset = this._uniformCursor * this._uniformStride;
    device.queue.writeBuffer(
      this._uniformBuffer,
      offset,
      uniformData as Float32Array<ArrayBuffer>,
    );
    this._currentUniformOffset = offset;
    this._uniformCursor++;
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

    // Defensive compatibility for a direct caller. SceneRenderer normally
    // reserves the exact natural-frustum count before encoding any draw.
    if (!this._passPrepared) {
      this.beginPass(frameState, device, 1);
      this._directCompatibilityPass = this._passPrepared;
    }
    if (
      !this._passPrepared ||
      !this._uniformBuffer ||
      !this._vertexBuffer ||
      !this._bindGroup
    ) {
      return;
    }

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

    // Renderer-wide log depth — pack (near, far, factor, 0).
    //
    // NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT — the log-depth ENCODE
    // frustum MUST be the FULL camera frustum stashed on
    // `uniformState._logDepthEncodeNearFar` (published by the globe camera-UB
    // pack and by both frustum loops before any slice remap), NOT the live
    // per-slice `currentFrustum`. Every other scene log-depth producer
    // (globe, PointPrimitive, Billboard, Polyline, ground/vector-tile
    // families, ellipsoid) encodes against that stash; this update() runs
    // INSIDE the frustum loop, so reading `currentFrustum` here baked the
    // slice's narrow near/far — a different curve — and the plane's depth was
    // not comparable with the geometry it must occlude (Sol horizon oracle:
    // the enabled scene plane failed to hide a physically-occluded marker).
    // When the stash drives near/far the factor is recomputed from the same
    // pair so encode + factor stay self-consistent. `currentFrustum` remains
    // only as the pre-stash early-frame fallback, matching the collections.
    const usLog = uniformState as unknown as {
      currentFrustum?: { x: number; y: number };
      oneOverLog2FarDepthFromNearPlusOne?: number;
      _logDepthEncodeNearFar?: Float32Array | null;
    };
    const ldEncode = usLog._logDepthEncodeNearFar;
    let ldNear = usLog.currentFrustum?.x ?? 0.0;
    let ldFar = usLog.currentFrustum?.y ?? 0.0;
    let ldFactor =
      typeof usLog.oneOverLog2FarDepthFromNearPlusOne === "number"
        ? usLog.oneOverLog2FarDepthFromNearPlusOne
        : 0.0;
    if (ldEncode && ldEncode[1] > ldEncode[0]) {
      ldNear = ldEncode[0];
      ldFar = ldEncode[1];
      const log2Far = Math.log2(ldFar - ldNear + 1.0);
      ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    } else if (!(ldFactor > 0.0) && ldFar > ldNear) {
      const log2Far = Math.log2(ldFar - ldNear + 1.0);
      ldFactor = log2Far > 0.0 ? 1.0 / log2Far : 0.0;
    }
    uniformScratch[24] = ldNear;
    uniformScratch[25] = ldFar;
    uniformScratch[26] = ldFactor;
    uniformScratch[27] = 0.0;

    this.updateUniforms(device, uniformScratch);
  }

  /**
   * Execute the depth plane draw command on the given render pass.
   */
  execute(
    renderPass: GPURenderPassEncoder,
    passKind: WebGPUDepthPlanePassKind,
  ): void {
    const pipeline = passKind === "pick" ? this._pickPipeline : this._pipeline;
    if (
      !this._enabled ||
      !pipeline ||
      !this._vertexBuffer ||
      !this._bindGroup ||
      this._vertexCount === 0
    ) {
      if (this._directCompatibilityPass) {
        this._passPrepared = false;
        this._directCompatibilityPass = false;
      }
      return;
    }

    renderPass.setPipeline(pipeline);
    this._dynamicOffsets[0] = this._currentUniformOffset;
    renderPass.setBindGroup(0, this._bindGroup, this._dynamicOffsets);
    renderPass.setVertexBuffer(0, this._vertexBuffer);
    renderPass.draw(this._vertexCount);
    if (this._directCompatibilityPass) {
      this._passPrepared = false;
      this._directCompatibilityPass = false;
    }
  }

  destroy(): void {
    if (this._isDestroyed) return;
    this._vertexBuffer?.destroy();
    this._uniformBuffer?.destroy();
    this._vertexBuffer = null;
    this._uniformBuffer = null;
    this._bindGroup = null;
    this._device = null;
    this._pipeline = null;
    this._pickPipeline = null;
    this._uniformCapacity = 0;
    this._uniformCursor = 0;
    this._currentUniformOffset = 0;
    this._passPrepared = false;
    this._directCompatibilityPass = false;
    this._isDestroyed = true;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
}
