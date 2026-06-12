import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Frozen from "../Core/Frozen.js";
import SortMode from "./SortMode.js";

/**
 * Configuration for a single render layer. Render layers group draw commands
 * into ordered buckets with configurable sorting strategies and optional
 * depth buffer clearing between layers.
 *
 * Layers execute in ascending {@link RenderLayer#order} — lower order renders first.
 * Within each layer, commands are sorted according to the layer's
 * {@link RenderLayer#opaqueSortMode} and {@link RenderLayer#transparentSortMode}.
 *
 * @param {object} [options] Options object.
 * @param {string} options.name The human-readable name for this layer.
 * @param {number} options.order The execution order (lower = renders first).
 * @param {boolean} [options.clearDepth=false] Whether to clear the depth buffer before
 *   rendering this layer. When true, everything in this layer renders "on top" of
 *   all previous layers regardless of actual depth. Powerful for GIS: terrain layer 0,
 *   annotations layer 1 with clearDepth = true → annotations always visible.
 * @param {boolean} [options.clearStencil=false] Whether to clear stencil before this layer.
 * @param {SortMode} [options.opaqueSortMode=SortMode.MATERIAL_MESH] Sort mode for opaque commands.
 * @param {SortMode} [options.transparentSortMode=SortMode.BACK_TO_FRONT] Sort mode for transparent commands.
 * @param {SortMode} [options.transmissiveSortMode=SortMode.BACK_TO_FRONT] Sort mode for transmissive commands.
 * @param {Function} [options.customOpaqueSort] Custom comparator for opaque. Only used when opaqueSortMode is CUSTOM.
 * @param {Function} [options.customTransparentSort] Custom comparator for transparent. Only used when transparentSortMode is CUSTOM.
 * @param {number} [options.visibilityMask=0xFFFFFFFF] 32-bit bitmask for visibility group filtering.
 * @param {boolean} [options.enabled=true] Whether this layer is active.
 *
 * @alias RenderLayer
 * @constructor
 *
 * @see RenderLayerCollection
 * @see SortMode
 * @see RenderScheduler
 */
class RenderLayer {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.name)) {
      throw new DeveloperError("options.name is required.");
    }
    if (!defined(options.order)) {
      throw new DeveloperError("options.order is required.");
    }
    //>>includeEnd('debug');

    /**
     * Human-readable layer name. Used in debug output and {@link RenderScheduler#explainRenderOrder}.
     * @type {string}
     * @readonly
     */
    this.name = options.name;

    /**
     * Execution order. Lower values render first (behind higher values).
     * Changing this at runtime triggers re-sort of the layer collection.
     * @type {number}
     */
    this._order = options.order;

    /**
     * Whether to clear the depth buffer before rendering this layer.
     * When true, all geometry in this layer renders "on top" of previous layers.
     *
     * Auto mode (default): depth is cleared automatically when the layer order
     * gap from the previous layer is >= 2. Set explicitly to override.
     * @type {boolean}
     * @default false
     */
    this.clearDepth = options.clearDepth ?? false;

    /**
     * Whether to clear the stencil buffer before rendering this layer.
     * @type {boolean}
     * @default false
     */
    this.clearStencil = options.clearStencil ?? false;

    /**
     * Sort mode for opaque draw commands in this layer.
     *
     * {@link SortMode.MATERIAL_MESH} groups commands by shader/texture
     * to minimize GPU state changes (recommended for world geometry).
     *
     * {@link SortMode.FRONT_TO_BACK} maximizes early-Z rejection
     * (recommended for dense scenes with heavy overdraw).
     *
     * @type {SortMode}
     * @default SortMode.MATERIAL_MESH
     */
    this.opaqueSortMode = options.opaqueSortMode ?? SortMode.MATERIAL_MESH;

    /**
     * Sort mode for transparent draw commands in this layer.
     * @type {SortMode}
     * @default SortMode.BACK_TO_FRONT
     */
    this.transparentSortMode =
      options.transparentSortMode ?? SortMode.BACK_TO_FRONT;

    /**
     * Sort mode for transmissive draw commands (glass, water) in this layer.
     * Transmissive objects are rendered after opaque and before transparent.
     * @type {SortMode}
     * @default SortMode.BACK_TO_FRONT
     */
    this.transmissiveSortMode =
      options.transmissiveSortMode ?? SortMode.BACK_TO_FRONT;

    /**
     * Custom comparator for opaque commands.
     * Only used when {@link RenderLayer#opaqueSortMode} is {@link SortMode.CUSTOM}.
     *
     * Signature: `(commandA, commandB, cameraPosition) => number`
     * Return negative if A should render before B, positive if after, 0 if equal.
     *
     * @type {Function|undefined}
     * @default undefined
     */
    this.customOpaqueSort = options.customOpaqueSort;

    /**
     * Custom comparator for transparent commands.
     * Only used when {@link RenderLayer#transparentSortMode} is {@link SortMode.CUSTOM}.
     *
     * Signature: `(commandA, commandB, cameraPosition) => number`
     *
     * @type {Function|undefined}
     * @default undefined
     */
    this.customTransparentSort = options.customTransparentSort;

    /**
     * 32-bit bitmask for visibility group filtering. A command is visible
     * in this layer only if `(command.visibilityMask & layer.visibilityMask) !== 0`.
     *
     * Default: all bits set (0xFFFFFFFF) — everything visible.
     * @type {number}
     * @default 0xFFFFFFFF
     */
    this.visibilityMask = options.visibilityMask ?? 0xffffffff;

    /**
     * Whether this layer is currently active. Disabled layers are skipped
     * during rendering but retain their configuration.
     * @type {boolean}
     * @default true
     */
    this.enabled = options.enabled ?? true;

    // --- Internal per-frame command buckets (managed by RenderScheduler) ---

    /**
     * @private
     * @type {Array}
     */
    this._opaqueCommands = [];

    /**
     * @private
     * @type {number}
     */
    this._opaqueCount = 0;

    /**
     * @private
     * @type {Array}
     */
    this._transparentCommands = [];

    /**
     * @private
     * @type {number}
     */
    this._transparentCount = 0;

    /**
     * @private
     * @type {Array}
     */
    this._transmissiveCommands = [];

    /**
     * @private
     * @type {number}
     */
    this._transmissiveCount = 0;

    /**
     * Dirty flag — set when any configuration changes.
     * @private
     * @type {boolean}
     */
    this._dirty = true;
  }

  /**
   * Resets per-frame command buckets. Called at the start of each frame
   * by the RenderScheduler before command binning.
   * @private
   */
  resetCommandBuckets() {
    this._opaqueCount = 0;
    this._transparentCount = 0;
    this._transmissiveCount = 0;
  }

  /**
   * Pushes a command into the appropriate bucket (opaque, transparent, or transmissive).
   *
   * @param {object} command The draw command.
   * @param {boolean} isTranslucent Whether the command is translucent.
   * @param {boolean} [isTransmissive=false] Whether the command is transmissive (glass/water).
   * @private
   */
  pushCommand(command, isTranslucent, isTransmissive) {
    if (isTransmissive) {
      const idx = this._transmissiveCount;
      if (idx >= this._transmissiveCommands.length) {
        this._transmissiveCommands.push(command);
      } else {
        this._transmissiveCommands[idx] = command;
      }
      this._transmissiveCount++;
    } else if (isTranslucent) {
      const idx = this._transparentCount;
      if (idx >= this._transparentCommands.length) {
        this._transparentCommands.push(command);
      } else {
        this._transparentCommands[idx] = command;
      }
      this._transparentCount++;
    } else {
      const idx = this._opaqueCount;
      if (idx >= this._opaqueCommands.length) {
        this._opaqueCommands.push(command);
      } else {
        this._opaqueCommands[idx] = command;
      }
      this._opaqueCount++;
    }
  }

  /**
   * Returns the total number of commands binned into this layer for the current frame.
   * @returns {number} Total command count.
   * @private
   */
  getCommandCount() {
    return this._opaqueCount + this._transparentCount + this._transmissiveCount;
  }

  /**
   * The execution order of this layer. Lower values render first.
   * @type {number}
   */
  get order() {
    return this._order;
  }

  set order(value) {
    if (this._order !== value) {
      this._order = value;
      this._dirty = true;
    }
  }
}

// ---- Pre-defined layer order constants ----

/**
 * Pre-defined layer orders matching CesiumJS pass structure.
 * Users can create layers with any order value; these are defaults.
 * @enum {number}
 */
RenderLayer.Order = Object.freeze({
  /** Sky, atmosphere, sun, moon */
  ENVIRONMENT: 0,
  /** Globe / terrain surface tiles */
  GLOBE: 10,
  /** Terrain classification overlays */
  TERRAIN_CLASSIFICATION: 20,
  /** 3D Tiles content */
  TILES_3D: 30,
  /** Default layer for user primitives, GeoJSON, entities */
  WORLD: 50,
  /** Annotations, labels, billboards that should float above world */
  ANNOTATIONS: 70,
  /** Translucent objects (when layer-based translucent separation is used) */
  TRANSLUCENT: 80,
  /** Screen-space overlays */
  OVERLAY: 100,
});

export default RenderLayer;
