/**
 * WebGPU compute command encapsulating a GPU compute dispatch.
 *
 * Unlike the WebGL ComputeCommand which emulates GPGPU via fragment shaders
 * rendering to a viewport quad, this uses real WebGPU compute shaders with
 * workgroups for true parallel computation.
 *
 * Used for: terrain processing, frustum culling, particle updates,
 * BRDF LUT generation, atmosphere scattering LUTs, etc.
 *
 * @private
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import Pass from "../Pass.js";
import type { WebGPUCommandOwner } from "./WebGPUDrawCommand.js";

export interface WebGPUComputeBindGroup {
  /** Bind group index (0, 1, 2, 3) */
  index: number;
  /** The bind group to set */
  bindGroup: GPUBindGroup;
  /** Optional dynamic offsets */
  dynamicOffsets?: Uint32Array | number[];
}

export interface WebGPUComputeCommandOptions {
  /** WGSL compute shader source or pre-compiled shader module */
  shaderSource?: string;
  /** Pre-compiled shader module (takes priority over shaderSource) */
  shaderModule?: GPUShaderModule;
  /** Compute pipeline (if pre-built) */
  computePipeline?: GPUComputePipeline;
  /** Entry point function name in the compute shader */
  entryPoint?: string;
  /** Bind group layouts for pipeline creation */
  bindGroupLayouts?: GPUBindGroupLayout[];
  /** Bind groups to set before dispatch */
  bindGroups?: WebGPUComputeBindGroup[];
  /** Workgroup count X */
  workgroupCountX?: number;
  /** Workgroup count Y */
  workgroupCountY?: number;
  /** Workgroup count Z */
  workgroupCountZ?: number;
  /** Indirect dispatch buffer (overrides workgroup counts) */
  indirectBuffer?: GPUBuffer;
  /** Offset into indirect buffer */
  indirectOffset?: number;
  /** Callback before execution */
  preExecute?: () => void;
  /** Callback after execution */
  postExecute?: () => void;
  /** Callback if command is canceled */
  canceled?: () => void;
  /** Whether to keep resources after execution */
  persists?: boolean;
  /** Owner for debugging (accessed only for `.constructor.name`). */
  owner?: WebGPUCommandOwner;
  /** Debug label */
  label?: string;
}

class WebGPUComputeCommand {
  /** WGSL compute shader source */
  shaderSource: string | undefined;
  /** Pre-compiled shader module */
  shaderModule: GPUShaderModule | undefined;
  /** Compute pipeline */
  computePipeline: GPUComputePipeline | undefined;
  /** Entry point name */
  entryPoint: string;
  /** Bind group layouts */
  bindGroupLayouts: GPUBindGroupLayout[] | undefined;
  /** Bind groups to set */
  bindGroups: WebGPUComputeBindGroup[];
  /** Workgroup count X */
  workgroupCountX: number;
  /** Workgroup count Y */
  workgroupCountY: number;
  /** Workgroup count Z */
  workgroupCountZ: number;
  /** Indirect dispatch buffer */
  indirectBuffer: GPUBuffer | undefined;
  /** Indirect buffer offset */
  indirectOffset: number;
  /** Pre-execute callback */
  preExecute: (() => void) | undefined;
  /** Post-execute callback */
  postExecute: (() => void) | undefined;
  /** Canceled callback */
  canceled: (() => void) | undefined;
  /** Whether to persist resources */
  persists: boolean;
  /** The pass this command belongs to */
  pass: number;
  /** Owner for debugging (accessed only for `.constructor.name`). */
  owner: WebGPUCommandOwner | undefined;
  /** Debug label */
  label: string;

  /** Marks this as a WebGPU compute command for type checking */
  readonly isWebGPUComputeCommand: boolean = true;

  constructor(options: WebGPUComputeCommandOptions = {}) {
    this.shaderSource = options.shaderSource;
    this.shaderModule = options.shaderModule;
    this.computePipeline = options.computePipeline;
    this.entryPoint = options.entryPoint ?? "computeMain";
    this.bindGroupLayouts = options.bindGroupLayouts;
    this.bindGroups = options.bindGroups ?? [];
    this.workgroupCountX = options.workgroupCountX ?? 1;
    this.workgroupCountY = options.workgroupCountY ?? 1;
    this.workgroupCountZ = options.workgroupCountZ ?? 1;
    this.indirectBuffer = options.indirectBuffer;
    this.indirectOffset = options.indirectOffset ?? 0;
    this.preExecute = options.preExecute;
    this.postExecute = options.postExecute;
    this.canceled = options.canceled;
    this.persists = options.persists ?? false;
    this.pass = Pass.COMPUTE;
    this.owner = options.owner;
    this.label = options.label ?? "WebGPUComputeCommand";
  }

  /**
   * Executes the compute dispatch on a compute pass encoder.
   *
   * @param {GPUComputePassEncoder} computePass - Active compute pass encoder
   */
  execute(computePass: GPUComputePassEncoder): void {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(this.computePipeline)) {
      throw new DeveloperError("computePipeline must be set before execute().");
    }
    //>>includeEnd('debug');

    if (this.preExecute) {
      this.preExecute();
    }

    computePass.setPipeline(this.computePipeline!);

    // Set bind groups
    for (const bg of this.bindGroups) {
      if (bg.dynamicOffsets) {
        computePass.setBindGroup(
          bg.index,
          bg.bindGroup,
          bg.dynamicOffsets as Uint32Array,
        );
      } else {
        computePass.setBindGroup(bg.index, bg.bindGroup);
      }
    }

    // Dispatch
    if (this.indirectBuffer) {
      computePass.dispatchWorkgroupsIndirect(
        this.indirectBuffer,
        this.indirectOffset,
      );
    } else {
      computePass.dispatchWorkgroups(
        this.workgroupCountX,
        this.workgroupCountY,
        this.workgroupCountZ,
      );
    }

    if (this.postExecute) {
      this.postExecute();
    }
  }

  /**
   * Calculates workgroup count needed to cover a given number of items.
   * Common pattern: dispatch ceil(itemCount / workgroupSize) workgroups.
   *
   * @param {number} itemCount - Total items to process
   * @param {number} workgroupSize - Items per workgroup (from @workgroup_size)
   * @returns {number} Number of workgroups to dispatch
   */
  static calculateWorkgroupCount(
    itemCount: number,
    workgroupSize: number,
  ): number {
    return Math.ceil(itemCount / workgroupSize);
  }

  /**
   * Calculates 2D workgroup counts for image/texture processing.
   *
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @param {number} workgroupSizeX - Workgroup size in X (e.g., 8)
   * @param {number} workgroupSizeY - Workgroup size in Y (e.g., 8)
   * @returns {{ x: number; y: number }} Workgroup counts
   */
  static calculateWorkgroupCount2D(
    width: number,
    height: number,
    workgroupSizeX: number = 8,
    workgroupSizeY: number = 8,
  ): { x: number; y: number } {
    return {
      x: Math.ceil(width / workgroupSizeX),
      y: Math.ceil(height / workgroupSizeY),
    };
  }

  /**
   * Cancels this command. Calls the canceled callback if set.
   */
  cancel(): void {
    if (this.canceled) {
      this.canceled();
    }
  }
}

export default WebGPUComputeCommand;
