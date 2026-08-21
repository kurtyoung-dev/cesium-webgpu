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
  /**
   * GPUDevice that owns any prebuilt GPU resources in this command. Supplying
   * it makes cross-device rejection deterministic before the first execution.
   */
  device?: GPUDevice;
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

interface GeneratedPipelineProvenance {
  pipeline: GPUComputePipeline;
  shaderSource: string | undefined;
  shaderModule: GPUShaderModule | undefined;
  entryPoint: string;
  bindGroupLayouts: GPUBindGroupLayout[] | undefined;
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

  // A command can retain pipelines, shader modules, bind groups, and buffers.
  // None of those handles may cross a GPUDevice recovery boundary. The first
  // compute engine that prepares the command claims it; later engines fail
  // closed instead of submitting stale handles to a replacement device.
  private _executionDevice: GPUDevice | undefined;
  private _generatedPipelineProvenance: GeneratedPipelineProvenance | undefined;

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
    this._executionDevice = options.device;
    this._generatedPipelineProvenance = undefined;
  }

  /**
   * Encodes the compute dispatch without invoking lifecycle callbacks.
   *
   * Frame-owned callers use this seam so `preExecute` can run during command
   * preparation while `postExecute` waits for the owning command encoder to
   * reach `queue.submit`.
   *
   * @param computePass Active compute pass encoder
   */
  encode(computePass: GPUComputePassEncoder): void {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(this.computePipeline)) {
      throw new DeveloperError("computePipeline must be set before encode().");
    }
    //>>includeEnd('debug');

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
  }

  /**
   * Executes the compute dispatch on a compute pass encoder.
   *
   * This compatibility entry point preserves the historical immediate
   * `preExecute` / encode / `postExecute` ordering. Frame-owned execution must
   * use {@link encode} through WebGPUComputeEngine so the post callback can be
   * tied to the exact encoder submission boundary.
   *
   * @param computePass Active compute pass encoder
   */
  execute(computePass: GPUComputePassEncoder): void {
    // Preserve the historical public execute() precondition ordering: an
    // unprepared command fails before either lifecycle callback runs.
    //>>includeStart('debug', pragmas.debug);
    if (!defined(this.computePipeline)) {
      throw new DeveloperError("computePipeline must be set before execute().");
    }
    //>>includeEnd('debug');

    if (this.preExecute) {
      this.preExecute();
    }

    this.encode(computePass);

    if (this.postExecute) {
      this.postExecute();
    }
  }

  /**
   * Claims this command for a GPUDevice.
   *
   * WebGPU handles do not expose their creating device, so a command without
   * `options.device` uses its first preparation as the ownership trust
   * boundary. Producers supplying prebuilt pipelines/modules/bind groups or
   * buffers should provide the device at construction time.
   *
   * @returns true when the command is new or already belongs to `device`;
   * false when it retains resources from another device generation.
   * @private
   */
  claimExecutionDevice(device: GPUDevice): boolean {
    if (!this._executionDevice) {
      this._executionDevice = device;
      return true;
    }
    return this._executionDevice === device;
  }

  /** Records the semantic inputs for an engine-generated pipeline. @private */
  markPipelineGenerated(pipeline: GPUComputePipeline): void {
    this._generatedPipelineProvenance = {
      pipeline,
      shaderSource: this.shaderSource,
      shaderModule: this.shaderModule,
      entryPoint: this.entryPoint,
      bindGroupLayouts: this.bindGroupLayouts
        ? [...this.bindGroupLayouts]
        : undefined,
    };
  }

  /**
   * Invalidates a retained generated pipeline after preExecute changes any
   * semantic input. Provenance lives on the command so it remains correct when
   * another compute engine on the same pooled GPUDevice receives the command.
   * An explicitly replaced pipeline is producer-owned and is left intact.
   * @private
   */
  invalidateGeneratedPipelineIfInputsChanged(): void {
    const provenance = this._generatedPipelineProvenance;
    if (!provenance) {
      return;
    }
    if (this.computePipeline !== provenance.pipeline) {
      this._generatedPipelineProvenance = undefined;
      return;
    }

    const oldLayouts = provenance.bindGroupLayouts;
    const newLayouts = this.bindGroupLayouts;
    const layoutsMatch =
      oldLayouts === undefined
        ? newLayouts === undefined
        : newLayouts !== undefined &&
          oldLayouts.length === newLayouts.length &&
          oldLayouts.every((layout, index) => layout === newLayouts[index]);
    if (
      provenance.shaderSource !== this.shaderSource ||
      provenance.shaderModule !== this.shaderModule ||
      provenance.entryPoint !== this.entryPoint ||
      !layoutsMatch
    ) {
      this.computePipeline = undefined;
      this._generatedPipelineProvenance = undefined;
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
