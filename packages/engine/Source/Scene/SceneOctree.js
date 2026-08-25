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
 * The octree tracks the indexed state of the command list. Stable command
 * sets reuse the existing tree when the caller supplies a revision; changed
 * sets clear and reinsert into the same structure unless a structural option
 * changed.
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
   * Advances the command-set revision when the indexed command sequence or
   * state read by the tree changes. Exact scalar comparison avoids hash
   * collisions and sees in-place mutations that object-identity checks miss.
   *
   * @param {Array} commandList The full command list from frameState.
   * @returns {number} The current command-set revision.
   * @private
   */
  updateCommandSetRevision(commandList) {
    let state = this._commandSetRevisionState;
    if (!defined(state)) {
      state = createCommandSetRevisionState();
      this._commandSetRevisionState = state;
    }

    const snapshots = state.snapshots;
    const commandCount = commandList.length;
    const bypassCommands = state.bypassCommands;
    const previousEligibleCount = snapshots.length;
    let eligibleCount = 0;
    let dirty = false;

    // Commands outside the index can be recreated every frame. Refresh their
    // references without making that churn invalidate the spatial tree.
    state.commandList = undefined;
    bypassCommands.length = 0;

    try {
      for (let i = 0; i < commandCount; i++) {
        const command = commandList[i];
        if (!isOctreeEligible(command)) {
          bypassCommands.push(command);
          continue;
        }

        let snapshot = snapshots[eligibleCount];
        if (!defined(snapshot)) {
          snapshot = createCommandSnapshot();
          snapshots[eligibleCount] = snapshot;
        }
        dirty = updateCommandSnapshot(snapshot, command) || dirty;
        eligibleCount++;
      }
    } catch (error) {
      // A command getter can throw after earlier snapshots were updated. Burn
      // the old token before rethrowing so recovery cannot reuse the old tree.
      state.revision++;
      this._lastBuiltCommandSetRevision = undefined;
      this._lastBuildResult = undefined;
      throw error;
    }
    dirty = previousEligibleCount !== eligibleCount || dirty;
    snapshots.length = eligibleCount;
    state.commandList = commandList;

    if (dirty) {
      state.revision++;
    }
    return state.revision;
  }

  /**
   * Builds the octree from a command list. Call once per frame after
   * all commands have been generated but before culling/sorting.
   *
   * Commands that are not octree-eligible (terrain, 3D Tiles, compute,
   * overlay, no bounding volume) are returned in the bypass array.
   *
   * The returned bypass array is owned by the octree and reused across calls.
   * Callers must consume or copy it before the next revision scan or build.
   * When the octree is used the result object is reused as well, mutated in
   * place and identical to the one retained for the next reuse check, so a
   * caller that keeps a reference sees it change on the following build.
   *
   * @param {Array} commandList The full command list from frameState.
   * @param {number} frameNumber Current frame number.
   * @param {number} [commandSetRevision] Revision returned by
   *   {@link SceneOctree#updateCommandSetRevision}. Omitting it preserves the
   *   conservative full rebuild used by existing direct callers.
   * @returns {object} { octreeCommands: count, bypassCommands: Array }
   */
  build(commandList, frameNumber, commandSetRevision) {
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
      this._lastBuiltCommandSetRevision = undefined;
      this._lastBuildResult = undefined;
      const scanned = this._commandSetRevisionState;
      if (defined(scanned)) {
        // A partition belongs to the list it was scanned from. This build is
        // not consuming it, so it must not stay live for a later one.
        scanned.commandList = undefined;
        scanned.bypassCommands.length = 0;
      }
      this._stats.buildTimeMs = performance.now() - startTime;
      return {
        octreeCommands: 0,
        bypassCommands: commandList,
        useOctree: false,
      };
    }

    let state = this._commandSetRevisionState;
    if (!defined(state)) {
      state = createCommandSetRevisionState();
      this._commandSetRevisionState = state;
    }
    const bypassCommands = state.bypassCommands;

    // Persistence counters do not exist until the opt-in path has a large
    // enough list, keeping construction and default frames unchanged.
    if (!defined(this._stats.rebuilds)) {
      this._stats.rebuilds = 0;
      this._stats.rebuildSkips = 0;
    }

    const canUseCommandScan =
      defined(commandSetRevision) &&
      commandSetRevision === state.revision &&
      state.commandList === commandList;
    // A scan is a one-build token. Direct callers and failed builds must
    // repartition rather than publishing references from an earlier list.
    state.commandList = undefined;

    const structureUnchanged =
      this.rootHalfExtent === this._lastBuiltRootHalfExtent &&
      this.maxDepth === this._lastBuiltMaxDepth &&
      this.maxCommandsPerNode === this._lastBuiltMaxCommandsPerNode;
    const canReuse =
      canUseCommandScan &&
      defined(this._root) &&
      defined(this._lastBuildResult) &&
      commandSetRevision === this._lastBuiltCommandSetRevision &&
      structureUnchanged;

    if (canReuse) {
      // `_stats` is per-frame, so commandsInserted stays 0 on a reuse frame:
      // it reports insertions done now, not the tree's contents. The cached
      // result's octreeCommands keeps the count from the frame that built it.
      this._stats.rebuildSkips++;
      this._stats.buildTimeMs = performance.now() - startTime;
      return this._lastBuildResult;
    }

    // Clearing mutates the cached tree in place. Invalidate its reuse token
    // first so a failed insertion cannot expose a partially rebuilt tree later.
    this._lastBuiltCommandSetRevision = undefined;
    this._lastBuildResult = undefined;

    // Structural options are part of the index. Recreate the root when they
    // change; clearing cannot update extents or child split limits.
    if (!defined(this._root) || !structureUnchanged) {
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

    if (!canUseCommandScan) {
      bypassCommands.length = 0;
    }

    for (let i = 0; i < commandCount; i++) {
      const command = commandList[i];
      if (isOctreeEligible(command)) {
        this._root.insert(command);
        this._stats.commandsInserted++;
      } else {
        if (!canUseCommandScan) {
          bypassCommands.push(command);
        }
        this._stats.commandsSkipped++;
      }
    }

    this._stats.buildTimeMs = performance.now() - startTime;
    const buildResult = getBuildResult(state);
    buildResult.octreeCommands = this._stats.commandsInserted;
    buildResult.bypassCommands = bypassCommands;
    buildResult.useOctree = true;
    this._lastBuiltCommandSetRevision = canUseCommandScan
      ? commandSetRevision
      : undefined;
    this._lastBuildResult = buildResult;
    this._lastBuiltRootHalfExtent = this.rootHalfExtent;
    this._lastBuiltMaxDepth = this.maxDepth;
    this._lastBuiltMaxCommandsPerNode = this.maxCommandsPerNode;
    this._stats.rebuilds++;

    return buildResult;
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
    const bypassCount = defined(this._lastBuildResult)
      ? this._lastBuildResult.bypassCommands.length
      : this._stats.commandsSkipped;
    return [
      `=== SceneOctree (${this.enabled ? "ENABLED" : "DISABLED"}) ===`,
      `Nodes: ${diag.nodeCount} (${diag.leafCount} leaves)`,
      `Max depth: ${diag.maxDepth} / ${this.maxDepth}`,
      `Commands: ${diag.totalCommands} in tree, ${bypassCount} bypassed`,
      `Build: ${this._stats.buildTimeMs.toFixed(2)}ms`,
      `Rebuilds: ${this._stats.rebuilds}, skipped: ${this._stats.rebuildSkips}`,
      `Cull: ${this._stats.cullTimeMs.toFixed(2)}ms`,
      `Frustum tests saved: ${this._stats.frustumTestsSaved}`,
    ].join("\n");
  }

  /**
   * Destroys the octree and frees memory.
   */
  destroy() {
    this._root = undefined;
    this._commandSetRevisionState = undefined;
    this._lastBuiltCommandSetRevision = undefined;
    this._lastBuildResult = undefined;
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

function createCommandSetRevisionState() {
  return {
    revision: 0,
    snapshots: [],
    bypassCommands: [],
    commandList: undefined,
    buildResult: undefined,
  };
}

function getBuildResult(state) {
  let buildResult = state.buildResult;
  if (!defined(buildResult)) {
    buildResult = {
      octreeCommands: 0,
      bypassCommands: state.bypassCommands,
      useOctree: false,
    };
    state.buildResult = buildResult;
  }
  return buildResult;
}

function createCommandSnapshot() {
  return {
    command: undefined,
    boundingVolume: undefined,
    centerX: undefined,
    centerY: undefined,
    centerZ: undefined,
    radius: undefined,
    pass: undefined,
    moonPhysicalDepthRoute: false,
  };
}

function updateSnapshotValue(snapshot, property, value) {
  const changed = !Object.is(snapshot[property], value);
  snapshot[property] = value;
  return changed;
}

/**
 * Updates one reusable snapshot and reports whether the octree-relevant state
 * changed. The tree stores command identity and reads bounding-volume
 * definedness, center x/y/z, radius, `_moonPhysicalDepthRoute`, and
 * `_pass ?? pass`. A primitive that moves updates its bounding volume, which
 * is already tracked. Unknown bounding-volume shapes remain volatile.
 *
 * @param {object} snapshot Reusable command snapshot.
 * @param {object} command Command emitted for the current viewport.
 * @returns {boolean} Whether the command requires a new tree revision.
 * @private
 */
function updateCommandSnapshot(snapshot, command) {
  let dirty = updateSnapshotValue(snapshot, "command", command);

  const boundingVolume = command.boundingVolume;
  dirty =
    updateSnapshotValue(snapshot, "boundingVolume", boundingVolume) || dirty;
  const center = defined(boundingVolume) ? boundingVolume.center : undefined;

  const hasStableSphere =
    !defined(boundingVolume) ||
    (defined(center) &&
      Number.isFinite(center.x) &&
      Number.isFinite(center.y) &&
      Number.isFinite(center.z) &&
      Number.isFinite(boundingVolume.radius));
  if (!hasStableSphere) {
    dirty = true;
  }
  dirty = updateSnapshotValue(snapshot, "centerX", center?.x) || dirty;
  dirty = updateSnapshotValue(snapshot, "centerY", center?.y) || dirty;
  dirty = updateSnapshotValue(snapshot, "centerZ", center?.z) || dirty;
  dirty =
    updateSnapshotValue(snapshot, "radius", boundingVolume?.radius) || dirty;

  dirty =
    updateSnapshotValue(snapshot, "pass", command._pass ?? command.pass) ||
    dirty;
  dirty =
    updateSnapshotValue(
      snapshot,
      "moonPhysicalDepthRoute",
      command._moonPhysicalDepthRoute === true,
    ) || dirty;

  return dirty;
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
  // The SceneOctree root is Earth-sized and cannot represent the
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
