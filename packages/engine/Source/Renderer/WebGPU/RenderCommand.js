/**
 * ## Execution Model
 *
 * RenderCommand supports two execution modes:
 *
 * 1. **Deferred (recommended for new features):** Push to commandList.
 *    Scene.executeCommand() detects isRenderCommand and delegates to the
 *    context's command builder. The built native command is cached on
 *    `_cachedWebGLCommand` or `_cachedWebGPUCommand` for reuse.
 *
 * 2. **Immediate (for existing code migration):** Call `command.execute(context)`.
 *    The context builds and executes the native command in one step.
 *
 * ## Design Rationale (Simplification #2 from Architectural Review)
 *
 * Currently, scene files must create either `DrawCommand` (WebGL) or
 * `WebGPUDrawCommand` (WebGPU) explicitly, forcing every scene file to
 * import WebGPU modules. RenderCommand provides a thin abstraction that
 * eliminates these imports.
 *
 * @private
 * @module RenderCommand
 */
import Pass from "../Pass.js";
import DrawCommand from "../DrawCommand.js";
import RenderState from "../RenderState.js";

/**
 * Abstract render command that both WebGL and WebGPU can interpret.
 *
 * @param {object} options
 * @param {number} [options.pass=Pass.OPAQUE] The rendering pass.
 * @param {object} [options.owner] The owning primitive.
 * @param {object} [options.modelMatrix] Model-to-world matrix.
 * @param {object} [options.boundingVolume] Bounding volume for culling.
 * @param {string} [options.shaderHint] Shader selection hint (e.g., 'perInstanceColor_lit').
 * @param {object} [options.renderState] Abstract render state.
 * @param {object} [options.vertexData] Vertex data descriptor.
 * @param {object} [options.indexData] Index data descriptor.
 * @param {object} [options.uniformData] Uniform data to pack.
 * @param {number} [options.count] Number of vertices/indices to draw.
 * @param {number} [options.instanceCount=0] Number of instances.
 * @param {string} [options.pickId] Pick ID string.
 * @constructor
 * @private
 */
function RenderCommand(options) {
  options = options || {};

  /**
   * Marker to identify this as a RenderCommand (not DrawCommand or WebGPUDrawCommand).
   * @type {boolean}
   * @readonly
   */
  this.isRenderCommand = true;

  /**
   * The rendering pass (Pass.OPAQUE, Pass.TRANSLUCENT, etc.)
   * @type {number}
   */
  this.pass = options.pass ?? Pass.OPAQUE;

  /**
   * The owning primitive or collection.
   * @type {object}
   */
  this.owner = options.owner;

  /**
   * Model-to-world transformation matrix.
   * @type {object}
   */
  this.modelMatrix = options.modelMatrix;

  /**
   * Bounding volume for frustum culling.
   * @type {object}
   */
  this.boundingVolume = options.boundingVolume;

  /**
   * Shader selection hint. Used by the backend CommandBuilder to
   * select the appropriate shader program (GLSL) or pipeline (WGSL).
   * Examples: 'perInstanceColor_flat', 'perInstanceColor_lit',
   *           'material_flat_pbr', 'billboard', 'polyline'
   * @type {string}
   */
  this.shaderHint = options.shaderHint;

  /**
   * Abstract render state. The backend maps these to concrete state:
   * - WebGL: RenderState.fromCache(...)
   * - WebGPU: PipelineDescriptorBuilder fields
   *
   * @type {object}
   * @example
   * {
   *   depthTest: { enabled: true, func: 'LESS' },
   *   depthMask: true,
   *   cullFace: { enabled: true, face: 'BACK' },
   *   blending: null,
   *   stencilTest: null,
   * }
   */
  this.renderState = options.renderState;

  /**
   * Abstract vertex data descriptor. Contains typed arrays or
   * references to existing GPU buffers.
   * @type {object}
   */
  this.vertexData = options.vertexData;

  /**
   * Abstract index data descriptor.
   * @type {object}
   */
  this.indexData = options.indexData;

  /**
   * Uniform values to pack into the command's uniform buffer.
   * Keys are uniform names, values are the data.
   * @type {object}
   */
  this.uniformData = options.uniformData;

  /**
   * Number of vertices/indices to draw.
   * @type {number}
   */
  this.count = options.count ?? 0;

  /**
   * Number of instances (0 = non-instanced).
   * @type {number}
   */
  this.instanceCount = options.instanceCount ?? 0;

  /**
   * Pick ID for color-buffer picking.
   * @type {string}
   */
  this.pickId = options.pickId;

  /**
   * Whether to show debug bounding volume.
   * @type {boolean}
   */
  this.debugShowBoundingVolume = false;

  /**
   * Whether to cast shadows.
   * @type {boolean}
   */
  this.castShadows = options.castShadows ?? false;

  /**
   * Whether to receive shadows.
   * @type {boolean}
   */
  this.receiveShadows = options.receiveShadows ?? false;

  /**
   * Whether to cull this command against the frustum.
   * @type {boolean}
   */
  this.cull = options.cull ?? true;

  /**
   * Version counter — incremented when command data changes and
   * cached native commands need rebuilding.
   * @type {number}
   * @private
   */
  this._dirtyVersion = 0;

  /**
   * Backend-specific cached command. Populated by the CommandBuilder
   * on first execution, reused on subsequent frames.
   * @type {object}
   * @private
   */
  this._cachedWebGLCommand = undefined;

  /**
   * Cached version for WebGL command.
   * @type {number}
   * @private
   */
  this._cachedWebGLVersion = -1;

  /**
   * Backend-specific cached WebGPU command.
   * @type {object}
   * @private
   */
  this._cachedWebGPUCommand = undefined;

  /**
   * Cached version for WebGPU command.
   * @type {number}
   * @private
   */
  this._cachedWebGPUVersion = -1;
}

/**
 * Mark this command as dirty, forcing native command rebuild on next execute.
 * Call this when vertex data, shader hint, or render state change.
 */
RenderCommand.prototype.setDirty = function () {
  this._dirtyVersion++;
};

/**
 * Execute this command through the given context. The context detects the
 * backend type and builds/caches the native command appropriately.
 *
 * This is the primary API for immediate-mode execution. For deferred
 * execution, push the RenderCommand to the commandList and let
 * Scene.executeCommand() handle it.
 *
 * @param {GraphicsContext} context - The rendering context
 * @param {object} [passState] - Optional pass state
 */
RenderCommand.prototype.execute = function (context, passState) {
  if (context.isWebGPU) {
    this._executeWebGPU(context, passState);
  } else {
    this._executeWebGL(context, passState);
  }
};

/**
 * Get or build the cached native command for the current backend.
 * Returns DrawCommand for WebGL, WebGPUDrawCommand for WebGPU.
 *
 * @param {GraphicsContext} context
 * @returns {object} The native draw command
 */
RenderCommand.prototype.getNativeCommand = function (context) {
  if (context.isWebGPU) {
    if (
      this._cachedWebGPUCommand === undefined ||
      this._cachedWebGPUVersion !== this._dirtyVersion
    ) {
      this._cachedWebGPUCommand = this._buildWebGPUCommand(context);
      this._cachedWebGPUVersion = this._dirtyVersion;
    }
    return this._cachedWebGPUCommand;
  }

  if (
    this._cachedWebGLCommand === undefined ||
    this._cachedWebGLVersion !== this._dirtyVersion
  ) {
    this._cachedWebGLCommand = this._buildWebGLCommand(context);
    this._cachedWebGLVersion = this._dirtyVersion;
  }
  return this._cachedWebGLCommand;
};

/**
 * Build a WebGL DrawCommand from abstract data.
 * @private
 */
RenderCommand.prototype._buildWebGLCommand = function (context) {
  const rs = this.renderState
    ? RenderState.fromCache(this.renderState)
    : undefined;

  const cmd = new DrawCommand({
    owner: this.owner,
    pass: this.pass,
    modelMatrix: this.modelMatrix,
    boundingVolume: this.boundingVolume,
    renderState: rs,
    pickId: this.pickId,
    cull: this.cull,
    debugShowBoundingVolume: this.debugShowBoundingVolume,
    castShadows: this.castShadows,
    receiveShadows: this.receiveShadows,
  });

  return cmd;
};

/**
 * Build a WebGPU command from abstract data.
 * Uses the context's command building infrastructure.
 * @private
 */
RenderCommand.prototype._buildWebGPUCommand = function (context) {
  // WebGPU command building is delegated to the context or its
  // command builder, which has access to the GPU device, pipeline cache, etc.
  // If the context provides a buildRenderCommand method, use it.
  if (typeof context.buildRenderCommand === "function") {
    return context.buildRenderCommand(this);
  }

  // Fallback: return a descriptor object that the scene renderer
  // can interpret. This allows incremental adoption — features can
  // start using RenderCommand before full builder integration.
  return {
    isWebGPUDrawCommand: true,
    pass: this.pass,
    owner: this.owner,
    modelMatrix: this.modelMatrix,
    boundingVolume: this.boundingVolume,
    shaderHint: this.shaderHint,
    renderState: this.renderState,
    vertexData: this.vertexData,
    indexData: this.indexData,
    uniformData: this.uniformData,
    count: this.count,
    instanceCount: this.instanceCount,
    pickId: this.pickId,
    cull: this.cull,
    castShadows: this.castShadows,
    receiveShadows: this.receiveShadows,
    debugShowBoundingVolume: this.debugShowBoundingVolume,
    // Stub execute for compatibility with Scene.executeCommand
    execute: function () {},
  };
};

/**
 * Execute via WebGL backend.
 * @private
 */
RenderCommand.prototype._executeWebGL = function (context, passState) {
  const cmd = this.getNativeCommand(context);
  if (cmd && typeof cmd.execute === "function") {
    cmd.execute(context, passState);
  }
};

/**
 * Execute via WebGPU backend.
 * @private
 */
RenderCommand.prototype._executeWebGPU = function (context, passState) {
  const cmd = this.getNativeCommand(context);
  if (cmd && typeof cmd.execute === "function") {
    cmd.execute(context._currentRenderPass || passState);
  }
};

/**
 * Check if a command is a RenderCommand.
 * @param {object} command
 * @returns {boolean}
 */
RenderCommand.isRenderCommand = function (command) {
  return (
    command !== undefined &&
    command !== null &&
    command.isRenderCommand === true
  );
};

export default RenderCommand;
