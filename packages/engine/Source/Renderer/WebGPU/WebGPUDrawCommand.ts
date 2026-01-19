import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

/**
 * Options for constructing a WebGPUDrawCommand.
 */
interface WebGPUDrawCommandOptions {
  pipeline: GPURenderPipeline;
  bindGroup?: GPUBindGroup;
  vertexBuffer: WebGPUBuffer;
  indexBuffer?: WebGPUBuffer;
  vertexCount?: number;
  indexCount?: number;
  instanceCount?: number;
  firstVertex?: number;
  firstIndex?: number;
  firstInstance?: number;
  pass?: number;
  owner?: any;
  boundingVolume?: any;
  modelMatrix?: any;
  cull?: boolean;
  debugShowBoundingVolume?: boolean;
  castShadows?: boolean;
  receiveShadows?: boolean;
  pickId?: string;
  executeInClosestFrustum?: boolean;
}

/**
 * Represents a draw command for WebGPU rendering.
 * Encapsulates the state needed to execute a single draw call including
 * pipeline, bind groups, vertex/index buffers, and draw parameters.
 *
 * @alias WebGPUDrawCommand
 *
 * @param {WebGPUDrawCommandOptions} options Object with the following properties:
 * @param {GPURenderPipeline} options.pipeline The render pipeline to use for drawing.
 * @param {GPUBindGroup} [options.bindGroup] The bind group containing uniforms and textures.
 * @param {WebGPUBuffer} options.vertexBuffer The vertex buffer.
 * @param {WebGPUBuffer} [options.indexBuffer] The index buffer (optional for non-indexed draws).
 * @param {number} [options.vertexCount] Number of vertices to draw (for non-indexed draws).
 * @param {number} [options.indexCount] Number of indices to draw (for indexed draws).
 * @param {number} [options.instanceCount=1] Number of instances to draw.
 * @param {number} [options.firstVertex=0] Offset into the vertex buffer.
 * @param {number} [options.firstIndex=0] Offset into the index buffer.
 * @param {number} [options.firstInstance=0] First instance to draw.
 *
 * @private
 */
class WebGPUDrawCommand {
  pipeline: GPURenderPipeline;
  bindGroup?: GPUBindGroup;
  vertexBuffer: WebGPUBuffer;
  indexBuffer?: WebGPUBuffer;
  vertexCount?: number;
  indexCount?: number;
  instanceCount: number;
  firstVertex: number;
  firstIndex: number;
  firstInstance: number;
  enabled: boolean;

  // Properties needed for Scene/View command binning and culling
  pass: number;
  owner?: any;
  boundingVolume?: any;
  modelMatrix?: any;
  cull: boolean;
  debugShowBoundingVolume: boolean;
  castShadows: boolean;
  receiveShadows: boolean;
  pickId?: string;
  executeInClosestFrustum: boolean;

  constructor(options: WebGPUDrawCommandOptions) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options)) {
      throw new DeveloperError("options is required.");
    }
    if (!defined(options.pipeline)) {
      throw new DeveloperError("options.pipeline is required.");
    }
    if (!defined(options.vertexBuffer)) {
      throw new DeveloperError("options.vertexBuffer is required.");
    }
    //>>includeEnd('debug');

    this.pipeline = options.pipeline;
    this.bindGroup = options.bindGroup;
    this.vertexBuffer = options.vertexBuffer;
    this.indexBuffer = options.indexBuffer;
    this.vertexCount = options.vertexCount;
    this.indexCount = options.indexCount;
    this.instanceCount = options.instanceCount ?? 1;
    this.firstVertex = options.firstVertex ?? 0;
    this.firstIndex = options.firstIndex ?? 0;
    this.firstInstance = options.firstInstance ?? 0;
    this.enabled = true;

    // Initialize Scene/View command properties with defaults
    this.pass = options.pass ?? 0; // Pass.OPAQUE
    this.owner = options.owner;
    this.boundingVolume = options.boundingVolume;
    this.modelMatrix = options.modelMatrix;
    this.cull = options.cull ?? true;
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;
    this.castShadows = options.castShadows ?? false;
    this.receiveShadows = options.receiveShadows ?? false;
    this.pickId = options.pickId;
    this.executeInClosestFrustum = options.executeInClosestFrustum ?? false;
  }

  /**
   * Executes the draw command by encoding it into the given render pass encoder.
   *
   * @param {GPURenderPassEncoder} passEncoder The render pass encoder to encode commands into.
   *
   * @example
   * const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
   * drawCommand.execute(passEncoder);
   * passEncoder.end();
   */
  execute(passEncoder: GPURenderPassEncoder): void {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(passEncoder)) {
      throw new DeveloperError("passEncoder is required.");
    }
    //>>includeEnd('debug');

    if (!this.enabled) {
      return;
    }

    // Set the pipeline
    passEncoder.setPipeline(this.pipeline);

    // Set bind group if present (uniforms, textures, samplers)
    if (defined(this.bindGroup)) {
      passEncoder.setBindGroup(0, this.bindGroup);
    }

    // Set vertex buffer
    passEncoder.setVertexBuffer(0, this.vertexBuffer.buffer);

    // Execute draw call - indexed or non-indexed
    if (defined(this.indexBuffer) && defined(this.indexCount)) {
      // Indexed draw
      passEncoder.setIndexBuffer(this.indexBuffer.buffer, "uint16");
      passEncoder.drawIndexed(
        this.indexCount,
        this.instanceCount,
        this.firstIndex,
        0, // baseVertex
        this.firstInstance,
      );
    } else if (defined(this.vertexCount)) {
      // Non-indexed draw
      passEncoder.draw(
        this.vertexCount,
        this.instanceCount,
        this.firstVertex,
        this.firstInstance,
      );
    } else {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        "Either indexCount or vertexCount must be specified.",
      );
      //>>includeEnd('debug');
    }
  }

  /**
   * Creates a shallow clone of this draw command.
   *
   * @returns {WebGPUDrawCommand} A new draw command with the same properties.
   */
  clone(): WebGPUDrawCommand {
    return new WebGPUDrawCommand({
      pipeline: this.pipeline,
      bindGroup: this.bindGroup,
      vertexBuffer: this.vertexBuffer,
      indexBuffer: this.indexBuffer,
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
      instanceCount: this.instanceCount,
      firstVertex: this.firstVertex,
      firstIndex: this.firstIndex,
      firstInstance: this.firstInstance,
    });
  }
}

export default WebGPUDrawCommand;
