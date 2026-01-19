/**
 * @module WebGPUShaderModule
 *
 * WebGPU shader module implementation for WGSL shader compilation.
 * Provides shader creation, pipeline state management, and bind group layouts.
 *
 * @example
 * const shader = WebGPUShaderModule.create(device, {
 *   code: wgslCode,
 *   label: 'MyShader'
 * });
 */

/// <reference types="@webgpu/types" />

import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";

/**
 * Options for creating a shader module
 */
export interface WebGPUShaderModuleOptions {
  /**
   * The GPU device
   */
  device: GPUDevice;

  /**
   * WGSL shader code
   */
  code: string;

  /**
   * Label for debugging
   */
  label?: string;
}

/**
 * Options for creating a render pipeline
 */
export interface WebGPURenderPipelineOptions {
  /**
   * Vertex shader module
   */
  vertexShader: WebGPUShaderModule;

  /**
   * Fragment shader module (optional for compute)
   */
  fragmentShader?: WebGPUShaderModule;

  /**
   * Vertex entry point function name
   */
  vertexEntryPoint?: string;

  /**
   * Fragment entry point function name
   */
  fragmentEntryPoint?: string;

  /**
   * Vertex buffer layouts
   */
  vertexBuffers?: GPUVertexBufferLayout[];

  /**
   * Primitive topology
   */
  topology?: GPUPrimitiveTopology;

  /**
   * Target color formats
   */
  colorFormats?: GPUTextureFormat[];

  /**
   * Depth-stencil format
   */
  depthStencilFormat?: GPUTextureFormat;

  /**
   * Bind group layouts
   */
  bindGroupLayouts?: GPUBindGroupLayout[];

  /**
   * Label for debugging
   */
  label?: string;
}

/**
 * WebGPU shader module wrapper.
 */
export class WebGPUShaderModule {
  private _device: GPUDevice;
  private _module: GPUShaderModule;
  private _code: string;
  private _isDestroyed: boolean = false;
  private _label: string;

  /**
   * Private constructor. Use static factory methods instead.
   *
   * @private
   */
  private constructor(
    device: GPUDevice,
    module: GPUShaderModule,
    code: string,
    label: string,
  ) {
    this._device = device;
    this._module = module;
    this._code = code;
    this._label = label;
  }

  /**
   * Creates a new shader module from WGSL code.
   *
   * @param {WebGPUShaderModuleOptions} options - Shader creation options
   * @returns {WebGPUShaderModule} The created shader module
   *
   * @example
   * const shader = WebGPUShaderModule.create({
   *   device: device,
   *   code: `
   *     @vertex
   *     fn vertexMain(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
   *       return vec4<f32>(position, 1.0);
   *     }
   *   `
   * });
   */
  static create(options: WebGPUShaderModuleOptions): WebGPUShaderModule {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.device)) {
      throw new DeveloperError("options.device is required.");
    }
    if (!defined(options.code)) {
      throw new DeveloperError("options.code is required.");
    }
    //>>includeEnd('debug');

    const module = options.device.createShaderModule({
      code: options.code,
      label: options.label,
    });

    return new WebGPUShaderModule(
      options.device,
      module,
      options.code,
      options.label ?? "ShaderModule",
    );
  }

  /**
   * Creates a render pipeline using this shader.
   *
   * @param {WebGPURenderPipelineOptions} options - Pipeline creation options
   * @returns {GPURenderPipeline} The created render pipeline
   *
   * @example
   * const pipeline = vertexShader.createRenderPipeline({
   *   vertexShader: vertexShader,
   *   fragmentShader: fragmentShader,
   *   vertexBuffers: [vertexBufferLayout],
   *   colorFormats: ['bgra8unorm']
   * });
   */
  static createRenderPipeline(
    options: WebGPURenderPipelineOptions,
  ): GPURenderPipeline {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.vertexShader)) {
      throw new DeveloperError("options.vertexShader is required.");
    }
    //>>includeEnd('debug');

    const device = options.vertexShader._device;

    // Create pipeline layout if bind group layouts are provided
    let layout: GPUPipelineLayout | "auto" = "auto";
    if (options.bindGroupLayouts && options.bindGroupLayouts.length > 0) {
      layout = device.createPipelineLayout({
        bindGroupLayouts: options.bindGroupLayouts,
        label: `${options.label ?? "Pipeline"}_Layout`,
      });
    }

    const pipelineDescriptor: GPURenderPipelineDescriptor = {
      layout,
      vertex: {
        module: options.vertexShader._module,
        entryPoint: options.vertexEntryPoint ?? "vertexMain",
        buffers: options.vertexBuffers ?? [],
      },
      primitive: {
        topology: options.topology ?? "triangle-list",
      },
      label: options.label,
    };

    // Add fragment shader if provided
    if (options.fragmentShader) {
      pipelineDescriptor.fragment = {
        module: options.fragmentShader._module,
        entryPoint: options.fragmentEntryPoint ?? "fragmentMain",
        targets: (options.colorFormats ?? ["bgra8unorm"]).map((format) => ({
          format,
        })),
      };
    }

    // Add depth-stencil if provided
    if (options.depthStencilFormat) {
      pipelineDescriptor.depthStencil = {
        format: options.depthStencilFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      };
    }

    return device.createRenderPipeline(pipelineDescriptor);
  }

  /**
   * Creates a compute pipeline using this shader.
   *
   * @param {string} [entryPoint='computeMain'] - Entry point function name
   * @param {GPUBindGroupLayout[]} [bindGroupLayouts] - Bind group layouts
   * @param {string} [label] - Label for debugging
   * @returns {GPUComputePipeline} The created compute pipeline
   *
   * @example
   * const pipeline = shader.createComputePipeline();
   */
  createComputePipeline(
    entryPoint: string = "computeMain",
    bindGroupLayouts?: GPUBindGroupLayout[],
    label?: string,
  ): GPUComputePipeline {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Shader module has been destroyed.");
    }
    //>>includeEnd('debug');

    // Create pipeline layout if bind group layouts are provided
    let layout: GPUPipelineLayout | "auto" = "auto";
    if (bindGroupLayouts && bindGroupLayouts.length > 0) {
      layout = this._device.createPipelineLayout({
        bindGroupLayouts,
        label: `${label ?? this._label}_ComputeLayout`,
      });
    }

    return this._device.createComputePipeline({
      layout,
      compute: {
        module: this._module,
        entryPoint,
      },
      label: label ?? `${this._label}_ComputePipeline`,
    });
  }

  /**
   * Gets the underlying shader module.
   */
  get module(): GPUShaderModule {
    return this._module;
  }

  /**
   * Gets the shader code.
   */
  get code(): string {
    return this._code;
  }

  /**
   * Gets the shader label.
   */
  get label(): string {
    return this._label;
  }

  /**
   * Whether the shader module has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Gets compilation info (for debugging).
   *
   * @returns {Promise<GPUCompilationInfo>} Compilation information
   */
  async getCompilationInfo(): Promise<GPUCompilationInfo> {
    //>>includeStart('debug', pragmas.debug);
    if (this._isDestroyed) {
      throw new DeveloperError("Shader module has been destroyed.");
    }
    //>>includeEnd('debug');

    return await this._module.getCompilationInfo();
  }

  /**
   * Destroys the shader module.
   * Note: GPUShaderModule doesn't have an explicit destroy method,
   * so this just clears references.
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    // WebGPU shader modules don't have explicit destroy
    // They're garbage collected automatically
    this._isDestroyed = true;
  }
}

export default WebGPUShaderModule;
