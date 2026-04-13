/**
 * WebGPU Pipeline Descriptor Builder
 *
 * Fluent API for building WebGPU render pipeline descriptors with sensible defaults
 *
 * @module WebGPUPipelineDescriptorBuilder
 */

import { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";

/**
 * Builder for creating WebGPU render pipeline descriptors
 *
 * Provides a fluent API with sensible defaults for common pipeline configurations
 */
export class WebGPUPipelineDescriptorBuilder {
  private descriptor: Partial<WebGPURenderPipelineDescriptor> = {};

  /**
   * Set pipeline name
   *
   * @param name - Pipeline name/identifier
   * @returns This builder for chaining
   */
  setName(name: string): this {
    this.descriptor.name = name;
    return this;
  }

  /**
   * Set vertex shader
   *
   * @param module - Vertex shader module
   * @param entryPoint - Vertex shader entry point (default: 'vertexMain')
   * @param buffers - Vertex buffer layouts (optional)
   * @returns This builder for chaining
   */
  setVertexShader(
    module: GPUShaderModule,
    entryPoint: string = "vertexMain",
    buffers?: GPUVertexBufferLayout[],
  ): this {
    this.descriptor.vertex = {
      module,
      entryPoint,
      buffers,
    };
    return this;
  }

  /**
   * Set fragment shader
   *
   * @param module - Fragment shader module
   * @param entryPoint - Fragment shader entry point (default: 'fragmentMain')
   * @param targets - Color target states (default: single bgra8unorm target)
   * @returns This builder for chaining
   */
  setFragmentShader(
    module: GPUShaderModule,
    entryPoint: string = "fragmentMain",
    targets?: GPUColorTargetState[],
  ): this {
    this.descriptor.fragment = {
      module,
      entryPoint,
      targets: targets || [{ format: "bgra8unorm" }],
    };
    return this;
  }

  /**
   * Set pipeline layout
   *
   * @param layout - Pipeline layout or 'auto'
   * @returns This builder for chaining
   */
  setLayout(layout: GPUPipelineLayout | "auto"): this {
    this.descriptor.layout = layout;
    return this;
  }

  /**
   * Set primitive topology
   *
   * @param topology - Primitive topology (default: 'triangle-list')
   * @returns This builder for chaining
   */
  setTopology(topology: GPUPrimitiveTopology): this {
    if (!this.descriptor.primitive) {
      this.descriptor.primitive = {};
    }
    this.descriptor.primitive.topology = topology;
    return this;
  }

  /**
   * Set cull mode
   *
   * @param cullMode - Cull mode ('front', 'back', 'none')
   * @returns This builder for chaining
   */
  setCullMode(cullMode: GPUCullMode): this {
    if (!this.descriptor.primitive) {
      this.descriptor.primitive = {};
    }
    this.descriptor.primitive.cullMode = cullMode;
    return this;
  }

  /**
   * Set front face winding
   *
   * @param frontFace - Front face winding ('ccw' or 'cw')
   * @returns This builder for chaining
   */
  setFrontFace(frontFace: GPUFrontFace): this {
    if (!this.descriptor.primitive) {
      this.descriptor.primitive = {};
    }
    this.descriptor.primitive.frontFace = frontFace;
    return this;
  }

  /**
   * Enable depth testing with standard configuration
   *
   * @param format - Depth format (default: 'depth24plus')
   * @param compare - Depth compare function (default: 'less')
   * @param write - Enable depth writes (default: true)
   * @returns This builder for chaining
   */
  enableDepthTest(
    format: GPUTextureFormat = "depth24plus",
    // Default depthCompare is `less-equal`, not `less`. See
    // WebGPUContext._depthCompare for the planetary-scale rationale.
    compare: GPUCompareFunction = "less-equal",
    write: boolean = true,
  ): this {
    if (!this.descriptor.depthStencil) {
      this.descriptor.depthStencil = {
        format,
        depthWriteEnabled: write,
        depthCompare: compare,
      };
    } else {
      this.descriptor.depthStencil.format = format;
      this.descriptor.depthStencil.depthWriteEnabled = write;
      this.descriptor.depthStencil.depthCompare = compare;
    }
    return this;
  }

  /**
   * Disable depth testing
   *
   * @returns This builder for chaining
   */
  disableDepthTest(): this {
    this.descriptor.depthStencil = undefined;
    return this;
  }

  /**
   * Ensure the depthStencil descriptor block exists with a stencil-capable format.
   * @private
   */
  private _ensureDepthStencil(): void {
    if (!this.descriptor.depthStencil) {
      this.descriptor.depthStencil = {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      };
    }
    // Upgrade depth-only format to depth+stencil if needed
    const fmt = this.descriptor.depthStencil.format;
    if (fmt === "depth24plus" || fmt === "depth32float") {
      this.descriptor.depthStencil.format = "depth24plus-stencil8";
    }
  }

  /**
   * Enable stencil testing with the given front/back face operations.
   *
   * If depth testing hasn't been configured yet, it will be initialised with
   * the `depth24plus-stencil8` format automatically.
   *
   * @param front - Stencil face state for front-facing primitives
   * @param back  - Stencil face state for back-facing primitives (defaults to front)
   * @returns This builder for chaining
   *
   * @example
   * builder.enableStencilTest(
   *   { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
   *   { compare: 'always', passOp: 'replace', failOp: 'keep', depthFailOp: 'keep' },
   * );
   */
  enableStencilTest(
    front: GPUStencilFaceState,
    back?: GPUStencilFaceState,
  ): this {
    this._ensureDepthStencil();
    this.descriptor.depthStencil!.stencilFront = front;
    this.descriptor.depthStencil!.stencilBack = back ?? front;
    return this;
  }

  /**
   * Set stencil read mask (default 0xFF).
   *
   * @param mask - 8-bit stencil read mask
   * @returns This builder for chaining
   */
  setStencilReadMask(mask: number): this {
    this._ensureDepthStencil();
    this.descriptor.depthStencil!.stencilReadMask = mask;
    return this;
  }

  /**
   * Set stencil write mask (default 0xFF).
   *
   * @param mask - 8-bit stencil write mask
   * @returns This builder for chaining
   */
  setStencilWriteMask(mask: number): this {
    this._ensureDepthStencil();
    this.descriptor.depthStencil!.stencilWriteMask = mask;
    return this;
  }

  /**
   * Set depth bias parameters for shadow mapping / decals.
   *
   * @param bias - Constant depth bias
   * @param slopeScale - Slope-dependent depth bias
   * @param clamp - Maximum absolute depth bias (0 = no clamp)
   * @returns This builder for chaining
   */
  setDepthBias(bias: number, slopeScale: number = 0, clamp: number = 0): this {
    this._ensureDepthStencil();
    this.descriptor.depthStencil!.depthBias = bias;
    this.descriptor.depthStencil!.depthBiasSlopeScale = slopeScale;
    this.descriptor.depthStencil!.depthBiasClamp = clamp;
    return this;
  }

  /**
   * Enable multisampling
   *
   * @param count - Sample count (default: 4)
   * @returns This builder for chaining
   */
  enableMultisampling(count: number = 4): this {
    this.descriptor.multisample = {
      count,
    };
    return this;
  }

  /**
   * Add vertex buffer layout
   *
   * @param arrayStride - Stride between vertices in bytes
   * @param attributes - Vertex attributes
   * @param stepMode - Step mode ('vertex' or 'instance')
   * @returns This builder for chaining
   */
  addVertexBuffer(
    arrayStride: number,
    attributes: GPUVertexAttribute[],
    stepMode: GPUVertexStepMode = "vertex",
  ): this {
    if (!this.descriptor.vertex) {
      throw new Error("Vertex shader must be set before adding vertex buffers");
    }

    if (!this.descriptor.vertex.buffers) {
      this.descriptor.vertex.buffers = [];
    }

    this.descriptor.vertex.buffers.push({
      arrayStride,
      attributes,
      stepMode,
    });

    return this;
  }

  /**
   * Build the pipeline descriptor
   *
   * @returns Complete pipeline descriptor
   * @throws Error if required fields are missing
   */
  build(): WebGPURenderPipelineDescriptor {
    if (!this.descriptor.name) {
      throw new Error("Pipeline name is required");
    }

    if (!this.descriptor.vertex) {
      throw new Error("Vertex shader is required");
    }

    // Apply defaults
    const result: WebGPURenderPipelineDescriptor = {
      name: this.descriptor.name,
      vertex: this.descriptor.vertex,
      fragment: this.descriptor.fragment,
      layout: this.descriptor.layout || "auto",
      primitive: this.descriptor.primitive || {
        topology: "triangle-list",
        cullMode: "back",
        frontFace: "ccw",
      },
      depthStencil: this.descriptor.depthStencil,
      multisample: this.descriptor.multisample,
    };

    return result;
  }

  /**
   * Reset the builder to initial state
   *
   * @returns This builder for chaining
   */
  reset(): this {
    this.descriptor = {};
    return this;
  }

  /**
   * Create a builder for a basic colored geometry pipeline
   *
   * @param name - Pipeline name
   * @param vertexShader - Vertex shader module
   * @param fragmentShader - Fragment shader module
   * @returns Configured builder
   */
  static createBasicColorPipeline(
    name: string,
    vertexShader: GPUShaderModule,
    fragmentShader: GPUShaderModule,
  ): WebGPUPipelineDescriptorBuilder {
    return new WebGPUPipelineDescriptorBuilder()
      .setName(name)
      .setVertexShader(vertexShader)
      .setFragmentShader(fragmentShader)
      .enableDepthTest()
      .setCullMode("back");
  }

  /**
   * Create a builder for a textured geometry pipeline
   *
   * @param name - Pipeline name
   * @param vertexShader - Vertex shader module
   * @param fragmentShader - Fragment shader module
   * @returns Configured builder
   */
  static createTexturedPipeline(
    name: string,
    vertexShader: GPUShaderModule,
    fragmentShader: GPUShaderModule,
  ): WebGPUPipelineDescriptorBuilder {
    return new WebGPUPipelineDescriptorBuilder()
      .setName(name)
      .setVertexShader(vertexShader)
      .setFragmentShader(fragmentShader)
      .enableDepthTest()
      .setCullMode("back");
  }

  /**
   * Create a builder for a wireframe pipeline
   *
   * @param name - Pipeline name
   * @param vertexShader - Vertex shader module
   * @param fragmentShader - Fragment shader module
   * @returns Configured builder
   */
  static createWireframePipeline(
    name: string,
    vertexShader: GPUShaderModule,
    fragmentShader: GPUShaderModule,
  ): WebGPUPipelineDescriptorBuilder {
    return new WebGPUPipelineDescriptorBuilder()
      .setName(name)
      .setVertexShader(vertexShader)
      .setFragmentShader(fragmentShader)
      .setTopology("line-list")
      .enableDepthTest()
      .setCullMode("none");
  }

  /**
   * Create a builder for a depth-only pipeline (no fragment shader)
   *
   * @param name - Pipeline name
   * @param vertexShader - Vertex shader module
   * @returns Configured builder
   */
  static createDepthOnlyPipeline(
    name: string,
    vertexShader: GPUShaderModule,
  ): WebGPUPipelineDescriptorBuilder {
    return new WebGPUPipelineDescriptorBuilder()
      .setName(name)
      .setVertexShader(vertexShader)
      .enableDepthTest()
      .setCullMode("back");
  }
}

export default WebGPUPipelineDescriptorBuilder;
