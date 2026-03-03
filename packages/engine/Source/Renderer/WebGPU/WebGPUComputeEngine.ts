/**
 * WebGPU compute engine that compiles and dispatches compute commands.
 *
 * Manages compute pipeline creation, caching, and execution.
 * Unlike the WebGL ComputeEngine (which uses fragment shader GPGPU),
 * this uses real WebGPU compute shaders.
 *
 * @private
 */

import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import WebGPUComputeCommand from "./WebGPUComputeCommand.js";

/**
 * Cached compute pipeline entry.
 */
interface CachedComputePipeline {
  pipeline: GPUComputePipeline;
  shaderModule: GPUShaderModule;
  label: string;
}

class WebGPUComputeEngine {
  private _device: GPUDevice;
  private _pipelineCache: Map<string, CachedComputePipeline>;
  private _isDestroyed: boolean;

  constructor(device: GPUDevice) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(device)) {
      throw new DeveloperError("device is required.");
    }
    //>>includeEnd('debug');

    this._device = device;
    this._pipelineCache = new Map();
    this._isDestroyed = false;
  }

  /**
   * The GPU device.
   */
  get device(): GPUDevice {
    return this._device;
  }

  /**
   * Number of cached compute pipelines.
   */
  get pipelineCacheSize(): number {
    return this._pipelineCache.size;
  }

  /**
   * Executes a WebGPUComputeCommand.
   *
   * If the command doesn't have a compiled pipeline, this method
   * compiles one from the shader source and caches it.
   *
   * Creates a separate command encoder for the compute pass,
   * dispatches the work, and submits the command buffer.
   *
   * @param {WebGPUComputeCommand} command - The compute command to execute
   */
  execute(command: WebGPUComputeCommand): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("ComputeEngine has been destroyed.");
    }
    if (!defined(command)) {
      throw new DeveloperError("command is required.");
    }
    //>>includeEnd('debug');

    // Ensure the command has a compiled pipeline
    if (!command.computePipeline) {
      this._ensurePipeline(command);
    }

    // Pre-execute callback
    if (command.preExecute) {
      command.preExecute();
    }

    // Create command encoder and compute pass
    const encoder = this._device.createCommandEncoder({
      label: `ComputeEncoder_${command.label}`,
    });

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${command.label}`,
    });

    // Execute the command
    command.execute(computePass);

    computePass.end();

    // Submit
    this._device.queue.submit([encoder.finish()]);

    // Post-execute callback
    if (command.postExecute) {
      command.postExecute();
    }
  }

  /**
   * Executes multiple compute commands in a single command encoder.
   * More efficient than calling execute() for each command individually.
   *
   * @param {WebGPUComputeCommand[]} commands - Array of compute commands
   */
  executeMultiple(commands: WebGPUComputeCommand[]): void {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("ComputeEngine has been destroyed.");
    }
    //>>includeEnd('debug');

    if (commands.length === 0) return;

    // Ensure all commands have pipelines
    for (const cmd of commands) {
      if (!cmd.computePipeline) {
        this._ensurePipeline(cmd);
      }
    }

    const encoder = this._device.createCommandEncoder({
      label: "ComputeEncoder_Batch",
    });

    const computePass = encoder.beginComputePass({
      label: "ComputePass_Batch",
    });

    for (const cmd of commands) {
      if (cmd.preExecute) {
        cmd.preExecute();
      }
      cmd.execute(computePass);
    }

    computePass.end();
    this._device.queue.submit([encoder.finish()]);

    // Post-execute callbacks
    for (const cmd of commands) {
      if (cmd.postExecute) {
        cmd.postExecute();
      }
    }
  }

  /**
   * Executes a compute command within an existing command encoder.
   * The caller is responsible for managing the encoder lifecycle.
   * This is useful when compute work needs to be interleaved with
   * render passes in the same command buffer.
   *
   * @param {GPUCommandEncoder} encoder - Existing command encoder
   * @param {WebGPUComputeCommand} command - The compute command
   */
  executeOnEncoder(
    encoder: GPUCommandEncoder,
    command: WebGPUComputeCommand,
  ): void {
    if (!command.computePipeline) {
      this._ensurePipeline(command);
    }

    if (command.preExecute) {
      command.preExecute();
    }

    const computePass = encoder.beginComputePass({
      label: `ComputePass_${command.label}`,
    });

    command.execute(computePass);
    computePass.end();

    if (command.postExecute) {
      command.postExecute();
    }
  }

  /**
   * Creates a compute pipeline from WGSL shader source.
   *
   * @param {string} shaderSource - WGSL compute shader source
   * @param {string} entryPoint - Entry point function name
   * @param {GPUBindGroupLayout[]} [bindGroupLayouts] - Optional layouts
   * @param {string} [label] - Debug label
   * @returns {GPUComputePipeline} The created pipeline
   */
  createPipeline(
    shaderSource: string,
    entryPoint: string = "computeMain",
    bindGroupLayouts?: GPUBindGroupLayout[],
    label?: string,
  ): GPUComputePipeline {
    const shaderModule = this._device.createShaderModule({
      code: shaderSource,
      label: `${label ?? "Compute"}_ShaderModule`,
    });

    const pipelineLayout = bindGroupLayouts
      ? this._device.createPipelineLayout({
          bindGroupLayouts,
          label: `${label ?? "Compute"}_PipelineLayout`,
        })
      : "auto";

    return this._device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint,
      },
      label: label ?? "ComputePipeline",
    });
  }

  /**
   * Creates a compute pipeline asynchronously for better performance.
   * Does not block the GPU or main thread during compilation.
   */
  async createPipelineAsync(
    shaderSource: string,
    entryPoint: string = "computeMain",
    bindGroupLayouts?: GPUBindGroupLayout[],
    label?: string,
  ): Promise<GPUComputePipeline> {
    const shaderModule = this._device.createShaderModule({
      code: shaderSource,
      label: `${label ?? "Compute"}_ShaderModule`,
    });

    const pipelineLayout = bindGroupLayouts
      ? this._device.createPipelineLayout({
          bindGroupLayouts,
          label: `${label ?? "Compute"}_PipelineLayout`,
        })
      : "auto";

    return this._device.createComputePipelineAsync({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint,
      },
      label: label ?? "ComputePipeline",
    });
  }

  /**
   * Gets or creates a cached compute pipeline from shader source.
   *
   * @param {string} cacheKey - Unique key for the pipeline
   * @param {string} shaderSource - WGSL source
   * @param {string} [entryPoint] - Entry point name
   * @param {GPUBindGroupLayout[]} [bindGroupLayouts] - Layouts
   * @returns {GPUComputePipeline} The cached or newly created pipeline
   */
  getOrCreatePipeline(
    cacheKey: string,
    shaderSource: string,
    entryPoint: string = "computeMain",
    bindGroupLayouts?: GPUBindGroupLayout[],
  ): GPUComputePipeline {
    const cached = this._pipelineCache.get(cacheKey);
    if (cached) {
      return cached.pipeline;
    }

    const shaderModule = this._device.createShaderModule({
      code: shaderSource,
      label: `${cacheKey}_ShaderModule`,
    });

    const pipelineLayout = bindGroupLayouts
      ? this._device.createPipelineLayout({
          bindGroupLayouts,
          label: `${cacheKey}_PipelineLayout`,
        })
      : "auto";

    const pipeline = this._device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: shaderModule,
        entryPoint,
      },
      label: `${cacheKey}_Pipeline`,
    });

    this._pipelineCache.set(cacheKey, {
      pipeline,
      shaderModule,
      label: cacheKey,
    });

    return pipeline;
  }

  /**
   * Ensures a command has a compiled pipeline.
   */
  private _ensurePipeline(command: WebGPUComputeCommand): void {
    if (command.computePipeline) return;

    // Try to get from cache using shader source as key
    const cacheKey = command.shaderSource ?? command.label;
    const cached = this._pipelineCache.get(cacheKey);
    if (cached) {
      command.computePipeline = cached.pipeline;
      return;
    }

    // Need to compile
    if (command.shaderModule) {
      // Already have a shader module, just create pipeline
      const pipelineLayout = command.bindGroupLayouts
        ? this._device.createPipelineLayout({
            bindGroupLayouts: command.bindGroupLayouts,
            label: `${command.label}_PipelineLayout`,
          })
        : "auto";

      command.computePipeline = this._device.createComputePipeline({
        layout: pipelineLayout,
        compute: {
          module: command.shaderModule,
          entryPoint: command.entryPoint,
        },
        label: `${command.label}_Pipeline`,
      });
    } else if (command.shaderSource) {
      // Compile from source
      command.computePipeline = this.getOrCreatePipeline(
        cacheKey,
        command.shaderSource,
        command.entryPoint,
        command.bindGroupLayouts,
      );
    } else {
      throw new DeveloperError(
        "WebGPUComputeCommand must have shaderSource, shaderModule, " +
          "or computePipeline.",
      );
    }
  }

  /**
   * Clears the pipeline cache.
   */
  clearCache(): void {
    this._pipelineCache.clear();
  }

  /**
   * Whether the engine has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroys the engine and releases cached resources.
   */
  destroy(): void {
    if (this._isDestroyed) return;
    this._pipelineCache.clear();
    this._isDestroyed = true;
  }
}

export default WebGPUComputeEngine;
