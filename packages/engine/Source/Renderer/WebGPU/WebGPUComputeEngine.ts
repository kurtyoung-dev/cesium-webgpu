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
import RuntimeError from "../../Core/RuntimeError.js";
import WebGPUComputeCommand from "./WebGPUComputeCommand.js";
import { trackComputePipelineCreation } from "./AsyncResourceMonitor.js";

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
  // Audit B.18 (Batch 132) -- optional central pipeline cache. When
  // set (typically via `engine.centralPipelineCache = context.webgpuComputePipelineCache`
  // after construction), pipeline creation routes through the central
  // cache so split-screen / multi-context scenes share a single
  // GPUComputePipeline per shader-source + layout key.
  private _centralCache:
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null;
  // NEW-WEBGPU-PIPELINE-READY-SIGNAL — async resource monitor for the
  // freeform `createPipelineAsync` factory path that bypasses the
  // central cache. Set via the `asyncResourceMonitor` setter after
  // construction (production sites do this in WebGPUContext).
  private _monitor:
    | import("./AsyncResourceMonitor.js").AsyncResourceMonitor
    | null = null;
  private _isDestroyed: boolean;

  /**
   * @param device - The GPUDevice to compile pipelines against.
   * @param centralCache - Audit B.18 (Batch 132/134) -- optional
   *   `WebGPUComputePipelineCache`. When supplied, pipeline creation
   *   routes through the central cache for cross-instance dedup.
   *   Production instantiation sites SHOULD pass
   *   `context.webgpuComputePipelineCache` here (or set
   *   `engine.centralPipelineCache = ...` afterward) -- the field is
   *   `null` by default so unit-test instantiations stay isolated.
   */
  constructor(
    device: GPUDevice,
    centralCache?: import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache,
  ) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(device)) {
      throw new DeveloperError("device is required.");
    }
    //>>includeEnd('debug');

    this._device = device;
    this._pipelineCache = new Map();
    this._centralCache = centralCache ?? null;
    this._isDestroyed = false;
  }

  /**
   * Audit B.18 (Batch 132) -- attach the central
   * `WebGPUComputePipelineCache` so subsequent `createPipeline` /
   * `getOrCreatePipeline` / `_ensurePipeline` calls dedupe across
   * compute-engine instances on the same device. Safe to set null to
   * detach (test reset).
   */
  set centralPipelineCache(
    cache:
      | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
      | null,
  ) {
    this._centralCache = cache;
  }
  get centralPipelineCache():
    | import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache
    | null {
    return this._centralCache;
  }

  /**
   * NEW-WEBGPU-PIPELINE-READY-SIGNAL — install the monitor for the
   * freeform `createPipelineAsync` path. Production callers wire this
   * to `context.asyncResources` after construction.
   */
  set asyncResourceMonitor(
    monitor: import("./AsyncResourceMonitor.js").AsyncResourceMonitor | null,
  ) {
    this._monitor = monitor;
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
   * Wraps all GPU operations in try/catch — if pipeline creation or
   * dispatch fails, returns false instead of propagating the error.
   * Callers should check the return value and fall back to CPU.
   *
   * @param {WebGPUComputeCommand} command - The compute command to execute
   * @returns {boolean} True if execution succeeded, false on failure
   */
  execute(command: WebGPUComputeCommand): boolean {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("ComputeEngine has been destroyed.");
    }
    if (!defined(command)) {
      throw new DeveloperError("command is required.");
    }
    //>>includeEnd('debug');

    try {
      // Ensure the command has a compiled pipeline
      if (!command.computePipeline) {
        this._ensurePipeline(command);
      }

      // Validate workgroup dimensions against device limits
      this._validateWorkgroups(command);

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

      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Compute dispatch failed for '${command.label}': ${msg}. ` +
          `Falling back to CPU path.`,
      );
      return false;
    }
  }

  /**
   * Executes multiple compute commands in a single command encoder.
   * More efficient than calling execute() for each command individually.
   *
   * @param {WebGPUComputeCommand[]} commands - Array of compute commands
   * @returns {boolean} True if all commands executed successfully
   */
  executeMultiple(commands: WebGPUComputeCommand[]): boolean {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("ComputeEngine has been destroyed.");
    }
    //>>includeEnd('debug');

    if (commands.length === 0) return true;

    try {
      // Ensure all commands have pipelines
      for (const cmd of commands) {
        if (!cmd.computePipeline) {
          this._ensurePipeline(cmd);
        }
        this._validateWorkgroups(cmd);
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

      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Batch compute dispatch failed: ${msg}. ` +
          `Falling back to CPU path.`,
      );
      return false;
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
   * @returns {boolean} True if execution succeeded, false on failure
   */
  executeOnEncoder(
    encoder: GPUCommandEncoder,
    command: WebGPUComputeCommand,
  ): boolean {
    try {
      if (!command.computePipeline) {
        this._ensurePipeline(command);
      }

      this._validateWorkgroups(command);

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

      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Compute on encoder failed for '${command.label}': ${msg}`,
      );
      return false;
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

    // Audit B.18 (Batch 132) -- prefer central cache for cross-instance
    // dedup. Falls back to direct create when no central cache attached
    // (tests, standalone usage).
    if (this._centralCache && pipelineLayout !== "auto") {
      return this._centralCache.getOrCreateSync({
        name: label ?? "ComputePipeline",
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint },
      });
    }
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

    return trackComputePipelineCreation(
      this._monitor,
      this._device,
      {
        layout: pipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint,
        },
        label: label ?? "ComputePipeline",
      },
      label ?? "ComputeEngine-freeform",
    );
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

    // Audit B.18 (Batch 132) -- delegate to central cache when present.
    let pipeline: GPUComputePipeline;
    if (this._centralCache && pipelineLayout !== "auto") {
      pipeline = this._centralCache.getOrCreateSync({
        name: cacheKey,
        layout: pipelineLayout,
        compute: { module: shaderModule, entryPoint },
      });
    } else {
      pipeline = this._device.createComputePipeline({
        layout: pipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint,
        },
        label: `${cacheKey}_Pipeline`,
      });
    }

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

      // Audit B.18 (Batch 132) -- central cache routing for the
      // shader-module path too. The "auto" layout case skips the
      // central cache because layout is required for the cache key.
      if (this._centralCache && pipelineLayout !== "auto") {
        command.computePipeline = this._centralCache.getOrCreateSync({
          name: command.label,
          layout: pipelineLayout,
          compute: {
            module: command.shaderModule,
            entryPoint: command.entryPoint,
          },
        });
      } else {
        command.computePipeline = this._device.createComputePipeline({
          layout: pipelineLayout,
          compute: {
            module: command.shaderModule,
            entryPoint: command.entryPoint,
          },
          label: `${command.label}_Pipeline`,
        });
      }
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
   * Validates that the command's workgroup counts don't exceed device limits.
   * Throws if dimensions exceed maxComputeWorkgroupsPerDimension.
   * @private
   */
  private _validateWorkgroups(command: WebGPUComputeCommand): void {
    if (!command.workgroupCountX) return;

    const maxPerDim =
      this._device.limits.maxComputeWorkgroupsPerDimension ?? 65535;

    const x = command.workgroupCountX ?? 1;
    const y = command.workgroupCountY ?? 1;
    const z = command.workgroupCountZ ?? 1;

    if (x > maxPerDim || y > maxPerDim || z > maxPerDim) {
      throw new RuntimeError(
        `Compute workgroup count (${x}, ${y}, ${z}) exceeds device limit ` +
          `maxComputeWorkgroupsPerDimension=${maxPerDim} for '${command.label}'.`,
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
