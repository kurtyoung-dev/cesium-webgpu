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
    import("./WebGPUComputePipelineCache.js").WebGPUComputePipelineCache | null;
  // NEW-WEBGPU-PIPELINE-READY-SIGNAL — async resource monitor for the
  // freeform `createPipelineAsync` factory path that bypasses the
  // central cache. Set via the `asyncResourceMonitor` setter after
  // construction (production sites do this in WebGPUContext).
  private _monitor:
    import("./AsyncResourceMonitor.js").AsyncResourceMonitor | null = null;
  private _isDestroyed: boolean;
  private _pipelineKeyObjectIds: WeakMap<object, number>;
  private _nextPipelineKeyObjectId: number;

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
    this._pipelineKeyObjectIds = new WeakMap();
    this._nextPipelineKeyObjectId = 1;
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

    let commandStarted = false;
    let submitted = false;
    try {
      commandStarted = true;
      this._prepareCommand(command);

      const encoder = this._device.createCommandEncoder({
        label: `ComputeEncoder_${command.label}`,
      });

      let computePass: GPUComputePassEncoder | undefined;
      try {
        computePass = encoder.beginComputePass({
          label: `ComputePass_${command.label}`,
        });
        command.encode(computePass);
      } finally {
        // A synchronous pipeline/bind/dispatch error must not leave an owned
        // pass open. This also keeps the borrowed-encoder path below usable by
        // later commands after an individual dispatch rejects.
        computePass?.end();
      }

      // Submit
      this._device.queue.submit([encoder.finish()]);
      submitted = true;
      // Preserve the historical standalone API contract: a post callback
      // error remains observable as a false return even though submission has
      // already happened. The submitted guard prevents a false cancellation.
      command.postExecute?.();

      return true;
    } catch (e: unknown) {
      if (commandStarted && !submitted) {
        this._cancelCommand(command);
      }
      const msg = e instanceof Error ? e.message : String(e);
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Compute dispatch failed for '${command.label}': ${msg}. ` +
          `Falling back to CPU path.`,
      );
      //>>includeEnd('debug');
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

    const startedCommands: WebGPUComputeCommand[] = [];
    let submitted = false;
    try {
      // Run each preExecute exactly once before resolving its pipeline. A
      // producer may populate or replace command resources in that callback.
      for (const cmd of commands) {
        startedCommands.push(cmd);
        this._prepareCommand(cmd);
      }

      const encoder = this._device.createCommandEncoder({
        label: "ComputeEncoder_Batch",
      });

      let computePass: GPUComputePassEncoder | undefined;
      try {
        computePass = encoder.beginComputePass({
          label: "ComputePass_Batch",
        });
        for (const cmd of commands) {
          cmd.encode(computePass);
        }
      } finally {
        computePass?.end();
      }

      this._device.queue.submit([encoder.finish()]);
      submitted = true;

      let postCallbackFailed = false;
      let postCallbackError: unknown;
      for (const cmd of commands) {
        try {
          cmd.postExecute?.();
        } catch (error) {
          // Preserve the observable false result while still allowing every
          // submitted command's post callback to settle exactly once.
          if (!postCallbackFailed) {
            postCallbackFailed = true;
            postCallbackError = error;
          }
        }
      }
      if (postCallbackFailed) {
        throw postCallbackError;
      }

      return true;
    } catch (e: unknown) {
      if (!submitted) {
        for (const cmd of startedCommands) {
          this._cancelCommand(cmd);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Batch compute dispatch failed: ${msg}. ` +
          `Falling back to CPU path.`,
      );
      //>>includeEnd('debug');
      return false;
    }
  }

  /**
   * Encodes a compute command within an existing command encoder.
   *
   * The caller owns the encoder lifecycle and must settle the successful
   * command at that exact encoder's disposition: invoke `postExecute` after
   * queue submission, or `cancel()` if the encoder is abandoned. This method
   * invokes `preExecute` exactly once. The caller must cancel when this method
   * returns false. It never finishes or submits the borrowed encoder.
   *
   * @param {GPUCommandEncoder} encoder - Existing command encoder
   * @param {WebGPUComputeCommand} command - The compute command
   * @param canEncode Optional ownership predicate checked after preExecute and
   *   preparation. Context uses this to reject re-entrant encoder abandonment.
   * @returns {boolean} True if execution succeeded, false on failure
   */
  executeOnEncoder(
    encoder: GPUCommandEncoder,
    command: WebGPUComputeCommand,
    canEncode?: () => boolean,
  ): boolean {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("ComputeEngine has been destroyed.");
    }
    if (!defined(encoder)) {
      throw new DeveloperError("encoder is required.");
    }
    if (!defined(command)) {
      throw new DeveloperError("command is required.");
    }
    //>>includeEnd('debug');

    try {
      this._prepareCommand(command, canEncode);

      let computePass: GPUComputePassEncoder | undefined;
      try {
        if (canEncode && !canEncode()) {
          throw new RuntimeError(
            `The command encoder for '${command.label}' is no longer active.`,
          );
        }
        computePass = encoder.beginComputePass({
          label: `ComputePass_${command.label}`,
        });
        command.encode(computePass);
      } finally {
        computePass?.end();
      }

      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[CesiumJS:WebGPUComputeEngine] Compute on encoder failed for '${command.label}': ${msg}`,
      );
      //>>includeEnd('debug');
      return false;
    }
  }

  /** Runs per-dispatch preparation in lifecycle order. */
  private _prepareCommand(
    command: WebGPUComputeCommand,
    canEncode?: () => boolean,
  ): void {
    command.preExecute?.();

    if (canEncode && !canEncode()) {
      throw new RuntimeError(
        `The command encoder for '${command.label}' was abandoned during preExecute.`,
      );
    }

    if (!command.claimExecutionDevice(this._device)) {
      throw new RuntimeError(
        `WebGPUComputeCommand '${command.label}' belongs to a different ` +
          "GPUDevice. Rebuild the command and its GPU resources after device recovery.",
      );
    }

    command.invalidateGeneratedPipelineIfInputsChanged();

    if (!command.computePipeline) {
      this._ensurePipeline(command);
    }
    this._validateWorkgroups(command);

    if (canEncode && !canEncode()) {
      throw new RuntimeError(
        `The command encoder for '${command.label}' was abandoned during preparation.`,
      );
    }
  }

  /** Callback failures must not prevent other abandoned commands settling. */
  private _cancelCommand(command: WebGPUComputeCommand): void {
    try {
      command.cancel();
    } catch {
      // Cancellation is best-effort user notification; encoder cleanup and
      // remaining command settlements must continue.
    }
  }

  private _getPipelineKeyObjectId(value: object): number {
    let id = this._pipelineKeyObjectIds.get(value);
    if (id === undefined) {
      id = this._nextPipelineKeyObjectId++;
      this._pipelineKeyObjectIds.set(value, id);
    }
    return id;
  }

  /**
   * Builds a collision-safe local cache key from every pipeline-semantic input.
   * Labels are deliberately excluded; the optional namespace only preserves
   * the public getOrCreatePipeline cache partition chosen by its caller.
   */
  private _createPipelineCacheKey(
    namespace: string,
    shaderSource: string | undefined,
    shaderModule: GPUShaderModule | undefined,
    entryPoint: string,
    bindGroupLayouts: GPUBindGroupLayout[] | undefined,
  ): string {
    const shaderIdentity = shaderModule
      ? ["module", this._getPipelineKeyObjectId(shaderModule)]
      : ["source", shaderSource];
    const layoutIdentity = bindGroupLayouts
      ? bindGroupLayouts.map((layout) => this._getPipelineKeyObjectId(layout))
      : "auto";
    return JSON.stringify([
      namespace,
      shaderIdentity,
      entryPoint,
      layoutIdentity,
    ]);
  }

  private _createCommandPipelineCacheKey(
    command: WebGPUComputeCommand,
  ): string {
    return this._createPipelineCacheKey(
      "command",
      command.shaderSource,
      command.shaderModule,
      command.entryPoint,
      command.bindGroupLayouts,
    );
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
    const resolvedCacheKey = this._createPipelineCacheKey(
      cacheKey,
      shaderSource,
      undefined,
      entryPoint,
      bindGroupLayouts,
    );
    const cached = this._pipelineCache.get(resolvedCacheKey);
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

    this._pipelineCache.set(resolvedCacheKey, {
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

    if (!command.shaderModule && !command.shaderSource) {
      throw new DeveloperError(
        "WebGPUComputeCommand must have shaderSource, shaderModule, " +
          "or computePipeline.",
      );
    }

    const cacheKey = this._createCommandPipelineCacheKey(command);
    const cached = this._pipelineCache.get(cacheKey);
    if (cached) {
      command.computePipeline = cached.pipeline;
      command.markPipelineGenerated(cached.pipeline);
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
      this._pipelineCache.set(cacheKey, {
        pipeline: command.computePipeline,
        shaderModule: command.shaderModule,
        label: command.label,
      });
    } else if (command.shaderSource) {
      // Compile from source
      command.computePipeline = this.getOrCreatePipeline(
        "command",
        command.shaderSource,
        command.entryPoint,
        command.bindGroupLayouts,
      );
    }

    command.markPipelineGenerated(command.computePipeline!);
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
