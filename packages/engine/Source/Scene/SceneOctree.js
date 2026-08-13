import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import Pass from "../Renderer/Pass.js";
import OctreeNode from "./OctreeNode.js";

/**
 * General-purpose loose octree for spatial acceleration of command sorting
 * and frustum culling. Manages DrawCommands from user entities and primitives.
 *
 * Does NOT manage:
 * - Terrain tiles (have their own QuadtreePrimitive)
 * - 3D Tiles (have their own Cesium3DTilesetTraversal)
 * - Voxels (have their own VoxelTraversal)
 *
 * The octree is rebuilt every frame from the command list. This is efficient
 * because most commands have stable bounding volumes — the tree structure
 * is reused (clear + re-insert) rather than fully recreated.
 *
 * All coordinates are ECEF float64. RTE is a GPU rendering technique only.
 *
 * @param {object} [options] Configuration options.
 * @param {boolean} [options.enabled=false] Whether the octree is active.
 * @param {number} [options.maxDepth=8] Maximum octree depth.
 * @param {number} [options.maxCommandsPerNode=64] Commands before node splits.
 * @param {number} [options.minCommandsForOctree=200] Minimum command count
 *   before octree is used. Below this threshold, brute-force is faster.
 * @param {number} [options.rootHalfExtent=7000000] Root node half-extent in
 *   meters. Default covers Earth radius (~6.4M m) with margin.
 *
 * @alias SceneOctree
 * @constructor
 * @private
 */
class SceneOctree {
  constructor(options) {
    options = options ?? {};

    /**
     * Whether the octree spatial acceleration is enabled.
     * When disabled, falls back to brute-force linear iteration.
     * @type {boolean}
     * @default false
     */
    this.enabled = options.enabled ?? false;

    /**
     * Maximum tree depth. Deeper = finer spatial granularity but more overhead.
     * @type {number}
     * @default 8
     */
    this.maxDepth = options.maxDepth ?? 8;

    /**
     * Maximum commands per node before splitting.
     * @type {number}
     * @default 64
     */
    this.maxCommandsPerNode = options.maxCommandsPerNode ?? 64;

    /**
     * Minimum command count before octree is worthwhile.
     * Below this, brute-force iteration is faster than tree operations.
     * @type {number}
     * @default 200
     */
    this.minCommandsForOctree = options.minCommandsForOctree ?? 200;

    /**
     * Root node half-extent in meters. Covers Earth + LEO orbit.
     * @type {number}
     * @default 7000000
     */
    this.rootHalfExtent = options.rootHalfExtent ?? 7000000.0;

    /**
     * The root node of the octree.
     * @type {OctreeNode|undefined}
     * @private
     */
    this._root = undefined;

    /**
     * Frame number of the last rebuild.
     * @type {number}
     * @private
     */
    this._lastFrameNumber = -1;

    /**
     * Per-frame statistics.
     * @type {object}
     */
    this._stats = {
      commandsInserted: 0,
      commandsSkipped: 0,
      nodesTraversed: 0,
      frustumTestsSaved: 0,
      buildTimeMs: 0,
      cullTimeMs: 0,
    };

    /**
     * Temporary result array for collectVisible, reused each frame.
     * @type {Array}
     * @private
     */
    this._visibleResult = [];
  }

  /**
   * Builds the octree from a command list. Call once per frame after
   * all commands have been generated but before culling/sorting.
   *
   * Commands that are not octree-eligible (terrain, 3D Tiles, compute,
   * overlay, no bounding volume) are returned in the bypass array.
   *
   * @param {Array} commandList The full command list from frameState.
   * @param {number} frameNumber Current frame number.
   * @returns {object} { octreeCommands: count, bypassCommands: Array }
   */
  build(commandList, frameNumber) {
    const startTime = performance.now();

    this._lastFrameNumber = frameNumber;
    this._stats.commandsInserted = 0;
    this._stats.commandsSkipped = 0;

    const commandCount = commandList.length;

    // If below threshold, don't use octree
    if (!this.enabled || commandCount < this.minCommandsForOctree) {
      if (defined(this._root)) {
        this._root.clear();
      }
      this._stats.buildTimeMs = performance.now() - startTime;
      return {
        octreeCommands: 0,
        bypassCommands: commandList,
        useOctree: false,
      };
    }

    // Create or clear root
    if (!defined(this._root)) {
      this._root = new OctreeNode(
        Cartesian3.ZERO, // ECEF origin
        this.rootHalfExtent,
        0,
        this.maxDepth,
        this.maxCommandsPerNode,
      );
    } else {
      this._root.clear();
    }

    const bypassCommands = [];

    for (let i = 0; i < commandCount; i++) {
      const command = commandList[i];
      if (isOctreeEligible(command)) {
        this._root.insert(command);
        this._stats.commandsInserted++;
      } else {
        bypassCommands.push(command);
        this._stats.commandsSkipped++;
      }
    }

    this._stats.buildTimeMs = performance.now() - startTime;

    return {
      octreeCommands: this._stats.commandsInserted,
      bypassCommands: bypassCommands,
      useOctree: true,
    };
  }

  /**
   * Performs hierarchical frustum + horizon culling on the octree.
   * Returns only the commands that are visible from the given viewpoint.
   *
   * This replaces the brute-force linear iteration in
   * View.createPotentiallyVisibleSet() for octree-eligible commands.
   *
   * @param {CullingVolume} cullingVolume The camera frustum.
   * @param {object} [occluder] The horizon occluder.
   * @returns {Array} Array of visible commands.
   */
  collectVisible(cullingVolume, occluder) {
    const startTime = performance.now();

    this._visibleResult.length = 0;

    if (!defined(this._root) || this._root.totalCommandCount === 0) {
      this._stats.cullTimeMs = performance.now() - startTime;
      return this._visibleResult;
    }

    // 0x3f = all 6 frustum planes need testing initially
    const initialPlaneMask = 0x3f;
    const added = this._root.collectVisible(
      cullingVolume,
      occluder,
      initialPlaneMask,
      this._visibleResult,
    );

    const totalCommands = this._root.totalCommandCount;
    this._stats.frustumTestsSaved = Math.max(0, totalCommands - added);
    this._stats.cullTimeMs = performance.now() - startTime;

    return this._visibleResult;
  }

  /**
   * Collects visible commands in spatial sorted order (front-to-back or
   * back-to-front). Combines hierarchical culling with hierarchical sorting.
   *
   * @param {CullingVolume} cullingVolume The camera frustum.
   * @param {object} [occluder] The horizon occluder.
   * @param {Cartesian3} cameraPosition Camera position for distance sorting.
   * @param {boolean} frontToBack Sort direction.
   * @returns {Array} Spatially sorted visible commands.
   */
  collectVisibleSorted(cullingVolume, occluder, cameraPosition, frontToBack) {
    // First cull, then sort the visible set
    const visible = this.collectVisible(cullingVolume, occluder);

    // For now, return the visible set — actual sorted collection
    // through the octree hierarchy is used when the sort is integrated
    // with RenderScheduler. The caller should apply additional sorting.
    return visible;
  }

  /**
   * Returns diagnostic information about the octree.
   * @returns {string} Multi-line diagnostic string.
   */
  getDiagnostics() {
    if (!defined(this._root)) {
      return "SceneOctree: not built";
    }

    const diag = this._root.getDiagnostics();
    return [
      `=== SceneOctree (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
      `Nodes: ${diag.nodeCount} (${diag.leafCount} leaves)`,
      `Max depth: ${diag.maxDepth} / ${this.maxDepth}`,
      `Commands: ${diag.totalCommands} in tree, ${this._stats.commandsSkipped} bypassed`,
      `Build: ${this._stats.buildTimeMs.toFixed(2)}ms`,
      `Cull: ${this._stats.cullTimeMs.toFixed(2)}ms`,
      `Frustum tests saved: ${this._stats.frustumTestsSaved}`,
    ].join("\n");
  }

  /**
   * Destroys the octree and frees memory.
   */
  destroy() {
    this._root = undefined;
    this._visibleResult.length = 0;
  }

  /**
   * Per-frame octree statistics for profiling.
   * @type {object}
   * @readonly
   */
  get stats() {
    return this._stats;
  }

  /**
   * Whether the octree has been built for the current frame.
   * @type {boolean}
   * @readonly
   */
  get isBuilt() {
    return defined(this._root) && this._root.totalCommandCount > 0;
  }
}

/**
 * Passes that should be included in the octree. We only manage user
 * entity/primitive commands — NOT terrain, 3D Tiles, compute, or overlay.
 * @private
 */
const OCTREE_ELIGIBLE_PASSES = [Pass.OPAQUE, Pass.TRANSLUCENT];

/**
 * Checks if a command is eligible for octree insertion.
 * Only user entity/primitive commands with bounding volumes qualify.
 *
 * @param {object} command A DrawCommand.
 * @returns {boolean} True if the command should be in the octree.
 * @private
 */
function isOctreeEligible(command) {
  // C12-37 — the SceneOctree root is Earth-sized and cannot represent the
  // physical Moon sphere without clamping or dropping it. Keep normal frustum
  // binning and leave other `occlude === false` commands on their historical
  // octree path; only the private lunar route bypasses this acceleration tree.
  if (command._moonPhysicalDepthRoute === true) {
    return false;
  }
  if (!defined(command.boundingVolume)) {
    return false;
  }
  const pass = command._pass ?? command.pass;
  for (let i = 0; i < OCTREE_ELIGIBLE_PASSES.length; i++) {
    if (pass === OCTREE_ELIGIBLE_PASSES[i]) {
      return true;
    }
  }
  return false;
}

export default SceneOctree;
