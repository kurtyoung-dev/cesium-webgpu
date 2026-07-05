/**
 * WebGPU per-command bounding-volume debug draw pass — the WebGPU
 * equivalent of `Scene/SceneDebug.js#debugShowBoundingVolume` (the WebGL
 * path) and its per-command `command.debugShowBoundingVolume` flag.
 *
 * WHY THIS EXISTS (NEW-GEOJSON-WEBGPU-BV-DEBUG-DRAW-PASS). The
 * `debugShowBoundingVolume` flag plumbs through `GeoJsonPrimitive` and all
 * three `Buffer*` `WebGPUDrawCommand`s (Batch 583), and the flag setter
 * propagates to every collection, but until now NO WebGPU pass consumed it
 * — the overlay delta was a flat 0.000% vs the WebGL red bounding-sphere
 * wireframe. This pass closes that gap.
 *
 * WHAT IT DRAWS. For each command flagged `debugShowBoundingVolume === true`
 * that carries a bounding volume, a red wireframe of that volume — a
 * three-great-circle sphere for a `BoundingSphere` (has `.radius`), a
 * 12-edge cube for an `OrientedBoundingBox` (has `.halfAxes`) — matching
 * `SceneDebug`'s `EllipsoidGeometry`/`BoxGeometry` + `toWireframe()` +
 * `ColorGeometryInstanceAttribute(1,0,0,1)` choice.
 *
 * DEFAULT-OFF / BYTE-IDENTICAL. The caller collects flagged commands from
 * `frameState.commandList`; when none are flagged (the default) `execute`
 * is never invoked and no render pass is opened, so an unflagged frame is
 * byte-identical to before this pass existed.
 *
 * RENDER TARGET. Draws into the RESOLVED single-sample scene-color view
 * (`colorTarget.getColorTextureView(0)`, which prefers the MSAA resolve
 * target) with `loadOp="load"`, run AFTER the main scene pass has resolved
 * and BEFORE `_runPostProcessing` samples that same texture. Using the
 * resolved view keeps the pipeline `sampleCount === 1` regardless of the
 * scene's MSAA setting (no multisample-load hazard) and guarantees the
 * wireframe reaches the canvas through the post-process blit.
 *
 * DEPTH. Drawn with no depth attachment (always-on-top). SceneDebug's
 * WebGL volume depth-tests, but at planetary scale under WGSL log-depth the
 * wireframe's linear clip-z would not compose with the globe's log-encoded
 * depth without threading the log-depth encode through — an always-visible
 * debug wireframe is the more useful and simpler semantic, and matches the
 * "you can always see the bounding volume" intent of the debug toggle.
 *
 * RTE. Positioning follows the model-space RTE convention (Fork Charter
 * rule 5, mirrors `WebGPUEllipsoidPrimitiveRenderer`): the bounding
 * volume's world center + orientation/scale are folded into a per-command
 * model matrix; `modelViewProjectionRelativeToEye` bakes `proj * (view *
 * model)` with the translation column zeroed; the unit-geometry vertex is
 * transformed by the model-space high/low-split camera. No `mvp * vec3`.
 *
 * @module WebGPUBoundingVolumeDebugPass
 */

/// <reference types="@webgpu/types" />

import Cartesian3 from "../../Core/Cartesian3.js";
import Matrix3 from "../../Core/Matrix3.js";
import Matrix4 from "../../Core/Matrix4.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import { m4Values, gpuData } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";

const BV_DEBUG_WGSL = /* wgsl */ `
struct CameraUniforms {
  modelViewProjectionRelativeToEye: mat4x4<f32>,
  encodedCameraPositionMCHigh: vec3<f32>,
  _pad0: f32,
  encodedCameraPositionMCLow: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@vertex
fn vertexMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  // Model-space RTE: the unit-geometry vertex is exact in f32; the
  // planetary-scale translation lives in the zeroed-translation MVP + the
  // high/low camera split.
  let positionRTE = (position - camera.encodedCameraPositionMCHigh)
                  - camera.encodedCameraPositionMCLow;
  return camera.modelViewProjectionRelativeToEye * vec4<f32>(positionRTE, 1.0);
}

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
  // Matches SceneDebug's ColorGeometryInstanceAttribute(1, 0, 0, 1).
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;

// 96 bytes = 24 floats: mvpRTE(16) + camHigh(3+1) + camLow(3+1).
const CAMERA_UBO_BYTES = 96;
const CAMERA_UBO_FLOATS = CAMERA_UBO_BYTES / 4;

// Segments per great circle for the sphere wireframe.
const SPHERE_SEGMENTS = 48;

interface BVDebugItem {
  /** Model matrix folding world center + orientation/scale of the volume. */
  modelMatrix: Matrix4;
  /** true → sphere (3 great circles); false → box (12 edges). */
  isSphere: boolean;
}

/** Minimal UniformState surface this pass reads. */
interface BVDebugUniformState {
  view: Matrix4;
  projection: Matrix4;
  cameraPosition: { x: number; y: number; z: number };
}

const scratchMV = new Matrix4();
const scratchMVP = new Matrix4();
const scratchInvModel = new Matrix4();
const scratchCamModel = new Cartesian3();
const scratchEnc = {
  high: new Cartesian3(),
  low: new Cartesian3(),
};

/**
 * Build a line-list vertex buffer for the unit sphere: three great circles
 * (XY, XZ, YZ planes) on the unit sphere. `EllipsoidGeometry` +
 * `toWireframe()` produces a denser lat/long grid; three orthogonal circles
 * are the standard cheap wireframe-sphere approximation and read as a
 * bounding sphere just as clearly for a debug overlay.
 */
function buildSphereVertices(): Float32Array {
  const verts: number[] = [];
  const push = (x: number, y: number, z: number) => {
    verts.push(x, y, z);
  };
  for (let i = 0; i < SPHERE_SEGMENTS; i++) {
    const a0 = (i / SPHERE_SEGMENTS) * 2.0 * Math.PI;
    const a1 = ((i + 1) / SPHERE_SEGMENTS) * 2.0 * Math.PI;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    // XY plane
    push(c0, s0, 0.0);
    push(c1, s1, 0.0);
    // XZ plane
    push(c0, 0.0, s0);
    push(c1, 0.0, s1);
    // YZ plane
    push(0.0, c0, s0);
    push(0.0, c1, s1);
  }
  return new Float32Array(verts);
}

/**
 * Build a line-list vertex buffer for the unit cube [-1,1]^3: its 12 edges.
 * Matches `BoxGeometry.fromDimensions({2,2,2})` + `toWireframe()` scaled by
 * the OBB's `halfAxes` in the per-command model matrix.
 */
function buildBoxVertices(): Float32Array {
  const c: [number, number, number][] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0], // bottom
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4], // top
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7], // verticals
  ];
  const verts: number[] = [];
  for (const [a, b] of edges) {
    verts.push(c[a][0], c[a][1], c[a][2]);
    verts.push(c[b][0], c[b][1], c[b][2]);
  }
  return new Float32Array(verts);
}

const BV_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 12,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat },
    ],
  },
];

/**
 * Standalone debug pass for per-command `debugShowBoundingVolume`. Owns its
 * own shader module, pipeline, unit geometry, and a growable pool of camera
 * uniform buffers + bind groups (one slot per flagged command per frame —
 * distinct buffers because `writeBuffer` ordering vs the encoder is not
 * guaranteed, so sharing one buffer would race adjacent draws). Lazily
 * initialized; production frames with no flagged command pay nothing.
 */
export class WebGPUBoundingVolumeDebugPass {
  private _device: GPUDevice | null = null;
  private _pipeline: GPURenderPipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _sphereBuffer: GPUBuffer | null = null;
  private _sphereVertexCount = 0;
  private _boxBuffer: GPUBuffer | null = null;
  private _boxVertexCount = 0;
  private _format: GPUTextureFormat = "bgra8unorm";
  private _slots: {
    buffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  }[] = [];
  private _scratch = new Float32Array(CAMERA_UBO_FLOATS);
  private _isDestroyed = false;

  initialize(device: GPUDevice, format: GPUTextureFormat): void {
    if (this._device === device && this._format === format && this._pipeline) {
      return;
    }
    // Format changed (HDR toggle) or first init — (re)build the pipeline.
    // Geometry buffers are format-independent; build them once.
    this._device = device;
    this._format = format;
    this._isDestroyed = false;

    if (!this._sphereBuffer) {
      const sphereVerts = buildSphereVertices();
      this._sphereVertexCount = sphereVerts.length / 3;
      this._sphereBuffer = device.createBuffer({
        label: "BVDebug sphere VB",
        size: sphereVerts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this._sphereBuffer, 0, gpuData(sphereVerts));

      const boxVerts = buildBoxVertices();
      this._boxVertexCount = boxVerts.length / 3;
      this._boxBuffer = device.createBuffer({
        label: "BVDebug box VB",
        size: boxVerts.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this._boxBuffer, 0, gpuData(boxVerts));
    }

    const shaderModule = device.createShaderModule({
      label: "BVDebug shader",
      code: BV_DEBUG_WGSL,
    });

    this._bindGroupLayout = makeBindGroupLayout(device, "BVDebug BGL", [
      uniformBuffer(0, Stage.VERTEX),
    ]);

    const pipelineLayout = device.createPipelineLayout({
      label: "BVDebug PipelineLayout",
      bindGroupLayouts: [this._bindGroupLayout],
    });

    this._pipeline = device.createRenderPipeline({
      label: "BVDebug Pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
        buffers: BV_VERTEX_BUFFERS,
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      // line-list, no depth attachment — always-on-top wireframe.
      primitive: { topology: "line-list" },
    });

    // makeBindGroupLayout returns a fresh layout object each init, so the
    // cached bind groups reference a stale layout — drop the slot cache so
    // execute() rebuilds bind groups (and their buffers) against the new one.
    this._slots.length = 0;
  }

  /**
   * Compute a per-command model matrix from a bounding volume + emit its
   * `{modelMatrix, isSphere}` debug item, or `undefined` when the volume is
   * neither a sphere nor an oriented box. Mirrors SceneDebug's
   * `defined(radius) ? ellipsoid : box` discriminator.
   */
  static makeItem(boundingVolume: unknown): BVDebugItem | undefined {
    const bv = boundingVolume as {
      center?: { x: number; y: number; z: number };
      radius?: number;
      halfAxes?: unknown;
    };
    if (!bv || !bv.center) {
      return undefined;
    }
    const center = new Cartesian3(bv.center.x, bv.center.y, bv.center.z);
    if (typeof bv.radius === "number") {
      const r = bv.radius;
      const rotation = Matrix3.fromScale(new Cartesian3(r, r, r));
      return {
        modelMatrix: Matrix4.fromRotationTranslation(rotation, center),
        isSphere: true,
      };
    }
    if (bv.halfAxes) {
      return {
        modelMatrix: Matrix4.fromRotationTranslation(
          bv.halfAxes as Matrix3,
          center,
        ),
        isSphere: false,
      };
    }
    return undefined;
  }

  private _packCamera(
    uniformState: BVDebugUniformState,
    modelMatrix: Matrix4,
  ): void {
    const out = this._scratch;
    const view = uniformState.view;
    const proj = uniformState.projection;

    // mvpRTE = proj * (view * model) with the translation column zeroed
    // BEFORE the projection multiply (preserves proj's P23 depth term).
    Matrix4.multiply(view, modelMatrix, scratchMV);
    scratchMV[12] = 0;
    scratchMV[13] = 0;
    scratchMV[14] = 0;
    Matrix4.multiply(proj, scratchMV, scratchMVP);
    const mvp = m4Values(scratchMVP);
    for (let i = 0; i < 16; i++) {
      out[i] = mvp[i] as number;
    }

    // Encoded camera position in the model frame (invModel * cameraWorld).
    Matrix4.inverse(modelMatrix, scratchInvModel);
    const camWorld = uniformState.cameraPosition;
    Matrix4.multiplyByPoint(
      scratchInvModel,
      camWorld as Cartesian3,
      scratchCamModel,
    );
    EncodedCartesian3.fromCartesian(scratchCamModel, scratchEnc);
    out[16] = scratchEnc.high.x;
    out[17] = scratchEnc.high.y;
    out[18] = scratchEnc.high.z;
    out[19] = 0;
    out[20] = scratchEnc.low.x;
    out[21] = scratchEnc.low.y;
    out[22] = scratchEnc.low.z;
    out[23] = 0;
  }

  private _ensureSlot(index: number): {
    buffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  } {
    const device = this._device!;
    let slot = this._slots[index];
    if (!slot) {
      const buffer = device.createBuffer({
        label: `BVDebug camera UB ${index}`,
        size: CAMERA_UBO_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        label: `BVDebug bind group ${index}`,
        layout: this._bindGroupLayout!,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      slot = { buffer, bindGroup };
      this._slots[index] = slot;
    }
    return slot;
  }

  /**
   * Draw the flagged bounding-volume wireframes into `targetView`.
   *
   * @param encoder - The active frame command encoder. The caller MUST have
   *   ended any open render pass; this opens + closes its own.
   * @param targetView - The resolved single-sample scene-color view
   *   (`loadOp="load"` preserves the rendered scene).
   * @param items - One entry per flagged command.
   * @param uniformState - Camera state for the RTE MVP pack.
   */
  execute(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    items: BVDebugItem[],
    uniformState: BVDebugUniformState,
  ): void {
    if (
      this._isDestroyed ||
      !this._device ||
      !this._pipeline ||
      items.length === 0
    ) {
      return;
    }

    const passEncoder = encoder.beginRenderPass({
      label: "BVDebug Pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });
    passEncoder.setPipeline(this._pipeline);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this._packCamera(uniformState, item.modelMatrix);
      const slot = this._ensureSlot(i);
      this._device.queue.writeBuffer(slot.buffer, 0, gpuData(this._scratch));
      passEncoder.setBindGroup(0, slot.bindGroup);
      if (item.isSphere) {
        passEncoder.setVertexBuffer(0, this._sphereBuffer);
        passEncoder.draw(this._sphereVertexCount, 1, 0, 0);
      } else {
        passEncoder.setVertexBuffer(0, this._boxBuffer);
        passEncoder.draw(this._boxVertexCount, 1, 0, 0);
      }
    }

    passEncoder.end();
  }

  destroy(): void {
    if (this._isDestroyed) {
      return;
    }
    this._sphereBuffer?.destroy();
    this._boxBuffer?.destroy();
    for (const slot of this._slots) {
      slot.buffer.destroy();
    }
    this._slots.length = 0;
    this._sphereBuffer = null;
    this._boxBuffer = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._device = null;
    this._isDestroyed = true;
  }

  get isInitialized(): boolean {
    return !!this._pipeline;
  }
}

export default WebGPUBoundingVolumeDebugPass;
