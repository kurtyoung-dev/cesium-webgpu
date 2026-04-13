import defined from "../Core/defined.js";

/**
 * Allocates stable, deterministic integer IDs for material/shader combinations
 * to enable draw call batching. Commands sharing the same materialSortId will be
 * rendered together, minimizing GPU state changes (shader swaps, texture rebinds).
 *
 * The allocator uses {@link ShaderProgram#id} as the primary key since shader
 * programs are the most expensive state to change. Commands using the same shader
 * program with different textures get the same materialSortId — texture switching
 * is cheaper than shader switching, and within-material distance sorting provides
 * additional ordering.
 *
 * For WebGPU commands, the pipeline object hash is used instead of ShaderProgram.id
 * since WebGPU pipelines encapsulate both shader and fixed-function state.
 *
 * @alias MaterialSortIdAllocator
 * @constructor
 * @private
 *
 * @performance This allocator is designed for per-frame use. It maintains a
 * persistent cache that maps shader IDs to sort IDs, avoiding per-frame allocation.
 * The cache grows monotonically (never shrinks) — acceptable because the number of
 * unique shader programs in a CesiumJS scene is bounded (typically 50-200).
 *
 * @see RenderScheduler
 * @see SortMode
 */
class MaterialSortIdAllocator {
  constructor() {
    /**
     * Maps ShaderProgram.id (number) → materialSortId (number).
     * Using a plain object with integer keys for fast lookup.
     * @private
     * @type {Object<number, number>}
     */
    this._shaderToSortId = {};

    /**
     * Next available sort ID. Incremented monotonically.
     * @private
     * @type {number}
     */
    this._nextId = 1; // Start at 1; 0 means "not assigned"

    /**
     * Number of unique materials tracked.
     * @private
     * @type {number}
     */
    this._count = 0;
  }

  /**
   * Returns the materialSortId for a given DrawCommand. If the command's
   * shader program hasn't been seen before, a new ID is allocated.
   *
   * For WebGL DrawCommands, the key is ShaderProgram.id.
   * For WebGPU DrawCommands (with pipeline), the key is derived from
   * the pipeline's label or a fallback hash.
   *
   * @param {object} command A DrawCommand or WebGPUDrawCommand.
   * @returns {number} The materialSortId (positive integer). Returns 0 if
   *   the command has no shader program (e.g., compute commands).
   */
  getIdForCommand(command) {
    // WebGL path: use ShaderProgram.id
    if (defined(command._shaderProgram)) {
      return this._getOrAllocate(command._shaderProgram.id);
    }

    // Also handle shaderProgram as direct property (non-underscore)
    if (defined(command.shaderProgram) && defined(command.shaderProgram.id)) {
      return this._getOrAllocate(command.shaderProgram.id);
    }

    // WebGPU path: use pipeline reference identity.
    // GPURenderPipeline objects are cached by WebGPURenderPipelineCache,
    // so same config → same object → same key.
    if (defined(command.pipeline)) {
      // Use a WeakMap-based approach for object identity.
      // Fall back to pipeline label if available.
      return this._getOrAllocateForPipeline(command.pipeline);
    }

    return 0; // No shader info — can't batch
  }

  /**
   * Gets or allocates a sort ID for a shader program integer key.
   * @private
   * @param {number} key The ShaderProgram.id
   * @returns {number} The materialSortId
   */
  _getOrAllocate(key) {
    let id = this._shaderToSortId[key];
    if (!defined(id)) {
      id = this._nextId++;
      this._shaderToSortId[key] = id;
      this._count++;
    }
    return id;
  }

  /**
   * Gets or allocates a sort ID for a WebGPU pipeline using object identity.
   * Uses a WeakMap to avoid holding strong references to GPU objects.
   * @private
   * @param {GPURenderPipeline} pipeline
   * @returns {number}
   */
  _getOrAllocateForPipeline(pipeline) {
    // Lazy-init the WeakMap (not created in constructor to avoid overhead
    // when only WebGL is used)
    if (!defined(this._pipelineMap)) {
      this._pipelineMap = new WeakMap();
    }

    let id = this._pipelineMap.get(pipeline);
    if (!defined(id)) {
      id = this._nextId++;
      this._pipelineMap.set(pipeline, id);
      this._count++;
    }
    return id;
  }

  /**
   * Auto-populates the materialSortId on a command if it hasn't been set.
   * Called by the RenderScheduler during command binning.
   *
   * @param {object} command A DrawCommand or WebGPUDrawCommand.
   */
  ensureMaterialSortId(command) {
    if (command.materialSortId === 0) {
      command.materialSortId = this.getIdForCommand(command);
    }
  }

  /**
   * The number of unique materials tracked by this allocator.
   * @memberof MaterialSortIdAllocator.prototype
   * @type {number}
   * @readonly
   */
  get count() {
    return this._count;
  }
}

export default MaterialSortIdAllocator;
