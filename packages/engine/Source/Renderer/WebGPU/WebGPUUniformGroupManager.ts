/**
 * @module WebGPUUniformGroupManager
 *
 * Manages uniform buffers grouped by update frequency, following the
 * industry-standard pattern:
 *
 *   Group 0 = per-frame uniforms  (camera, time, viewport — updated once/frame)
 *   Group 1 = per-material uniforms (material params, textures — updated on material change)
 *   Group 2 = per-object uniforms  (model matrix, pick color — updated per draw call)
 *
 * This reduces GPU buffer writes by separating data that changes at different rates.
 * Without grouping, ALL uniforms are re-uploaded every draw call even if only the
 * model matrix changed.
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import { assertCameraRTERoundTrip } from "./WebGPURTEAssertions.js";

/**
 * Update frequency for uniform groups.
 */
export enum UniformFrequency {
  /** Updated once per frame (camera, lights, time, viewport) */
  PER_FRAME = 0,
  /** Updated when material changes (material params, textures, samplers) */
  PER_MATERIAL = 1,
  /** Updated per draw call (model matrix, pick color, per-instance data) */
  PER_OBJECT = 2,
}

/**
 * Layout entry for a uniform within a group.
 */
export interface UniformEntry {
  /** Name of the uniform (e.g., 'mvpRelativeToEye') */
  name: string;
  /** Offset in bytes within the group's uniform buffer */
  offset: number;
  /** Size in bytes */
  size: number;
  /** WGSL type for code generation (e.g., 'mat4x4<f32>', 'vec4<f32>') */
  wgslType: string;
}

/**
 * Descriptor for a uniform group's buffer layout.
 */
export interface UniformGroupLayout {
  /** Bind group index (0, 1, or 2) */
  group: UniformFrequency;
  /** Uniform entries in this group */
  entries: UniformEntry[];
  /** Total buffer size in bytes (padded to 256-byte alignment) */
  bufferSize: number;
  /** Whether this group includes textures/samplers in addition to the UBO */
  hasTextures: boolean;
}

/**
 * Per-frame uniform buffer data.
 * Contains camera matrices and scene-level uniforms that are
 * constant across all draw calls within a frame.
 */
export interface PerFrameUniforms {
  /** MVP with translation zeroed for RTE */
  mvpRelativeToEye: Float32Array; // mat4x4 = 64 bytes
  /** Model-view with translation zeroed for RTE */
  modelViewRelativeToEye: Float32Array; // mat4x4 = 64 bytes
  /** Normal matrix */
  normalMatrix: Float32Array; // mat4x4 = 64 bytes
  /** Camera position high bits (RTE) */
  encodedCameraHigh: Float32Array; // vec4 = 16 bytes
  /** Camera position low bits (RTE) */
  encodedCameraLow: Float32Array; // vec4 = 16 bytes
  /** Light direction */
  lightDirection: Float32Array; // vec4 = 16 bytes
  /** Viewport size (width, height) */
  viewportSize: Float32Array; // vec2 = 8 bytes
  /** Frame number */
  frameNumber: number; // f32 = 4 bytes
}

// =========================================================================
// Standard group layouts for CesiumJS rendering
// =========================================================================

/**
 * Standard per-frame layout (Group 0): camera + scene uniforms.
 * 256 bytes (one 256-byte aligned UBO).
 */
export const PER_FRAME_LAYOUT: UniformGroupLayout = {
  group: UniformFrequency.PER_FRAME,
  entries: [
    { name: "mvpRelativeToEye", offset: 0, size: 64, wgslType: "mat4x4<f32>" },
    {
      name: "modelViewRelativeToEye",
      offset: 64,
      size: 64,
      wgslType: "mat4x4<f32>",
    },
    { name: "normalMatrix", offset: 128, size: 64, wgslType: "mat4x4<f32>" },
    { name: "encodedCameraHigh", offset: 192, size: 16, wgslType: "vec4<f32>" },
    { name: "encodedCameraLow", offset: 208, size: 16, wgslType: "vec4<f32>" },
    { name: "lightDirection", offset: 224, size: 16, wgslType: "vec4<f32>" },
    { name: "viewportSize", offset: 240, size: 8, wgslType: "vec2<f32>" },
    { name: "frameNumber", offset: 248, size: 4, wgslType: "f32" },
  ],
  bufferSize: 256,
  hasTextures: false,
};

/**
 * Standard per-material layout (Group 1): material params + texture references.
 * 256 bytes UBO + texture/sampler bindings.
 */
export const PER_MATERIAL_LAYOUT: UniformGroupLayout = {
  group: UniformFrequency.PER_MATERIAL,
  entries: [
    { name: "baseColor", offset: 0, size: 16, wgslType: "vec4<f32>" },
    { name: "emissiveFactor", offset: 16, size: 16, wgslType: "vec4<f32>" },
    { name: "metallicFactor", offset: 32, size: 4, wgslType: "f32" },
    { name: "roughnessFactor", offset: 36, size: 4, wgslType: "f32" },
    { name: "alphaCutoff", offset: 40, size: 4, wgslType: "f32" },
    { name: "doubleSided", offset: 44, size: 4, wgslType: "f32" },
  ],
  bufferSize: 256,
  hasTextures: true,
};

/**
 * Standard per-object layout (Group 2): model transform + instance data.
 * 256 bytes UBO.
 */
export const PER_OBJECT_LAYOUT: UniformGroupLayout = {
  group: UniformFrequency.PER_OBJECT,
  entries: [
    { name: "modelMatrix", offset: 0, size: 64, wgslType: "mat4x4<f32>" },
    { name: "pickColor", offset: 64, size: 16, wgslType: "vec4<f32>" },
    { name: "objectId", offset: 80, size: 4, wgslType: "u32" },
  ],
  bufferSize: 256,
  hasTextures: false,
};

/**
 * Manages uniform buffer allocation and bind group creation
 * organized by update frequency.
 */
export class WebGPUUniformGroupManager {
  private _device: GPUDevice;

  // Per-frame: single shared buffer, updated once per frame
  private _perFrameBuffer: GPUBuffer | null = null;
  private _perFrameBindGroup: GPUBindGroup | null = null;
  private _perFrameLayout: GPUBindGroupLayout | null = null;
  private _perFrameData: Float32Array;
  private _perFrameDirty: boolean = true;

  // Per-material: one buffer per unique material, updated on material change
  private _materialBuffers: Map<string, GPUBuffer> = new Map();
  private _materialBindGroups: Map<string, GPUBindGroup> = new Map();
  private _materialLayout: GPUBindGroupLayout | null = null;

  // Per-object: ring buffer for per-draw-call data
  private _objectBufferPool: GPUBuffer[] = [];
  private _objectPoolIndex: number = 0;
  private _objectLayout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice) {
    this._device = device;
    this._perFrameData = new Float32Array(PER_FRAME_LAYOUT.bufferSize / 4);
  }

  /**
   * Initialize bind group layouts for all three frequency groups.
   * Should be called once during context setup.
   */
  initialize(): void {
    this._createPerFrameLayout();
    this._createMaterialLayout();
    this._createObjectLayout();
    this._createPerFrameBuffer();
  }

  // ======================================================================
  // Per-Frame (Group 0)
  // ======================================================================

  /**
   * Update per-frame uniform data from the UniformState.
   * Called once at the beginning of each frame.
   *
   * @param {any} uniformState - CesiumJS UniformState with camera/scene data
   */
  updatePerFrame(uniformState: CesiumUniformState): void {
    const data = this._perFrameData;

    // mvpRelativeToEye (offset 0, 16 floats)
    const mvpRTE = uniformState.modelViewProjectionRelativeToEye;
    if (mvpRTE) {
      for (let i = 0; i < 16; i++) {
        data[i] = mvpRTE[i];
      }
    }

    // modelViewRelativeToEye (offset 16, 16 floats)
    const mvRTE = uniformState.modelViewRelativeToEye;
    if (mvRTE) {
      for (let i = 0; i < 16; i++) {
        data[16 + i] = mvRTE[i];
      }
    }

    // normalMatrix (offset 32, 16 floats)
    const normal = uniformState.normal;
    if (normal) {
      // normal is mat3, expand to mat4x4 layout
      data[32] = normal[0];
      data[33] = normal[1];
      data[34] = normal[2];
      data[35] = 0;
      data[36] = normal[3];
      data[37] = normal[4];
      data[38] = normal[5];
      data[39] = 0;
      data[40] = normal[6];
      data[41] = normal[7];
      data[42] = normal[8];
      data[43] = 0;
      data[44] = 0;
      data[45] = 0;
      data[46] = 0;
      data[47] = 1;
    }

    // encodedCameraHigh (offset 48, 4 floats)
    const camHigh = uniformState.encodedCameraPositionMCHigh;
    if (camHigh) {
      data[48] = camHigh.x;
      data[49] = camHigh.y;
      data[50] = camHigh.z;
      data[51] = 0;
    }

    // encodedCameraLow (offset 52, 4 floats)
    const camLow = uniformState.encodedCameraPositionMCLow;
    if (camLow) {
      data[52] = camLow.x;
      data[53] = camLow.y;
      data[54] = camLow.z;
      data[55] = 0;
    }

    //>>includeStart('debug', pragmas.debug);
    // RTE round-trip: catch off-by-one packer bugs that swap the high/low
    // slots. The MC-encoded pair must reconstruct to the unencoded
    // `cameraPosition` (WC) only when the model matrix is identity, which
    // is the per-frame default for this group-0 UBO. Skip the check if
    // either input is missing.
    if (camHigh && camLow && uniformState.cameraPosition) {
      assertCameraRTERoundTrip(
        camHigh,
        camLow,
        uniformState.cameraPosition,
        "WebGPUUniformGroupManager perFrame UBO",
      );
    }
    //>>includeEnd('debug');

    // lightDirection (offset 56, 4 floats)
    const sunDir = uniformState.sunDirectionWC;
    if (sunDir) {
      data[56] = sunDir.x;
      data[57] = sunDir.y;
      data[58] = sunDir.z;
      data[59] = 0;
    }

    // viewportSize (offset 60, 2 floats)
    const vp = uniformState.viewport;
    if (vp) {
      data[60] = vp.width;
      data[61] = vp.height;
    }

    // frameNumber (offset 62, 1 float)
    data[62] = uniformState.frameState?.frameNumber ?? 0;

    this._perFrameDirty = true;
  }

  /**
   * Flush per-frame data to the GPU if dirty.
   * Call after updatePerFrame() and before rendering.
   */
  flushPerFrame(): void {
    if (!this._perFrameDirty || !this._perFrameBuffer) return;

    this._device.queue.writeBuffer(
      this._perFrameBuffer,
      0,
      this._perFrameData.buffer,
      this._perFrameData.byteOffset,
      this._perFrameData.byteLength,
    );

    this._perFrameDirty = false;
  }

  /**
   * Get the per-frame bind group (Group 0).
   * Must call updatePerFrame() + flushPerFrame() first.
   */
  get perFrameBindGroup(): GPUBindGroup | null {
    return this._perFrameBindGroup;
  }

  /**
   * Get the per-frame bind group layout.
   */
  get perFrameBindGroupLayout(): GPUBindGroupLayout | null {
    return this._perFrameLayout;
  }

  /**
   * Get the per-material bind group layout.
   */
  get materialBindGroupLayout(): GPUBindGroupLayout | null {
    return this._materialLayout;
  }

  /**
   * Get the per-object bind group layout.
   */
  get objectBindGroupLayout(): GPUBindGroupLayout | null {
    return this._objectLayout;
  }

  /**
   * Generate WGSL struct declarations for a uniform group layout.
   *
   * @param {UniformGroupLayout} layout - The layout to generate WGSL for
   * @param {string} structName - Name for the WGSL struct
   * @returns {string} WGSL struct declaration + binding
   */
  static generateWGSL(layout: UniformGroupLayout, structName: string): string {
    let wgsl = `struct ${structName} {\n`;
    for (const entry of layout.entries) {
      wgsl += `  ${entry.name}: ${entry.wgslType},\n`;
    }
    wgsl += `};\n`;
    wgsl += `@group(${layout.group}) @binding(0) var<uniform> ${structName.toLowerCase()}: ${structName};\n`;
    return wgsl;
  }

  /**
   * Reset per-frame state. Call at frame start.
   */
  beginFrame(): void {
    this._objectPoolIndex = 0;
  }

  /**
   * Destroy all GPU resources.
   */
  destroy(): void {
    this._perFrameBuffer?.destroy();
    this._perFrameBuffer = null;

    for (const buf of this._materialBuffers.values()) {
      buf.destroy();
    }
    this._materialBuffers.clear();
    this._materialBindGroups.clear();

    for (const buf of this._objectBufferPool) {
      buf.destroy();
    }
    this._objectBufferPool = [];
  }

  // ======================================================================
  // Private — Layout creation
  // ======================================================================

  private _createPerFrameLayout(): void {
    this._perFrameLayout = this._device.createBindGroupLayout({
      label: "PerFrame_BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
  }

  private _createMaterialLayout(): void {
    this._materialLayout = this._device.createBindGroupLayout({
      label: "PerMaterial_BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        // Binding 1: base color texture
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        // Binding 2: base color sampler
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });
  }

  private _createObjectLayout(): void {
    this._objectLayout = this._device.createBindGroupLayout({
      label: "PerObject_BindGroupLayout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });
  }

  private _createPerFrameBuffer(): void {
    this._perFrameBuffer = this._device.createBuffer({
      size: PER_FRAME_LAYOUT.bufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "PerFrame_UniformBuffer",
    });

    if (this._perFrameLayout) {
      this._perFrameBindGroup = this._device.createBindGroup({
        layout: this._perFrameLayout,
        entries: [{ binding: 0, resource: { buffer: this._perFrameBuffer } }],
        label: "PerFrame_BindGroup",
      });
    }
  }
}

export default WebGPUUniformGroupManager;
