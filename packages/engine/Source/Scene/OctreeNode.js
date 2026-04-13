import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import Intersect from "../Core/Intersect.js";

/**
 * A node in a loose octree for spatial acceleration of command sorting and
 * frustum culling. Each node has an axis-aligned bounding box (AABB),
 * a list of commands, and up to 8 child pointers.
 *
 * Loose octree: objects are placed in the smallest node whose AABB fully
 * contains their bounding volume, even if that volume overlaps child boundaries.
 * This avoids multi-insertion while keeping hierarchical culling effective.
 *
 * All coordinates are ECEF float64 (same as every CesiumJS spatial structure).
 * RTE is only used at render time (GPU shaders), not in this CPU data structure.
 *
 * @param {Cartesian3} center The center of this node's AABB.
 * @param {number} halfExtent Half the side length of the cube AABB.
 * @param {number} depth The depth of this node in the tree (0 = root).
 * @param {number} maxDepth Maximum allowed depth before forced leaf.
 * @param {number} maxCommandsPerNode Max commands before splitting.
 *
 * @alias OctreeNode
 * @constructor
 * @private
 */
class OctreeNode {
  constructor(center, halfExtent, depth, maxDepth, maxCommandsPerNode) {
    /**
     * AABB center in ECEF coordinates (float64).
     * @type {Cartesian3}
     */
    this.center = Cartesian3.clone(center);

    /**
     * Half the side length of the cubic AABB.
     * @type {number}
     */
    this.halfExtent = halfExtent;

    /**
     * Precomputed BoundingSphere for frustum/horizon culling.
     * Sphere radius = halfExtent * sqrt(3) (diagonal of cube).
     * @type {BoundingSphere}
     */
    this.boundingSphere = new BoundingSphere(
      center,
      halfExtent * 1.7320508075688772, // sqrt(3)
    );

    /**
     * Commands stored at THIS node (not in children).
     * @type {Array}
     */
    this.commands = [];

    /**
     * Child nodes (indices 0-7), null if not split. Layout:
     * 0: -x,-y,-z  1: +x,-y,-z  2: -x,+y,-z  3: +x,+y,-z
     * 4: -x,-y,+z  5: +x,-y,+z  6: -x,+y,+z  7: +x,+y,+z
     * @type {OctreeNode[]}
     */
    this.children = null;

    /**
     * Depth of this node (0 = root).
     * @type {number}
     */
    this.depth = depth;

    /**
     * @private
     */
    this._maxDepth = maxDepth;

    /**
     * @private
     */
    this._maxCommandsPerNode = maxCommandsPerNode;

    /**
     * Total command count in this node and all descendants.
     * @type {number}
     */
    this.totalCommandCount = 0;

    /**
     * Whether this node is a leaf (no children).
     * @type {boolean}
     */
    this.isLeaf = true;

    /**
     * Frame number when this node was last updated. Used for
     * incremental updates — only rebuild branches with changes.
     * @type {number}
     */
    this.lastUpdatedFrame = 0;
  }

  /**
   * Determines which child octant a bounding sphere's center falls in.
   * Returns -1 if the sphere doesn't fully fit in any child.
   *
   * @param {BoundingSphere} boundingSphere The command's bounding volume.
   * @returns {number} Child index 0-7, or -1 if it belongs in this node.
   * @private
   */
  _getChildIndex(boundingSphere) {
    const sphereCenter = boundingSphere.center;
    const sphereRadius = boundingSphere.radius;
    const childHalf = this.halfExtent * 0.5;

    // If the sphere is too large to fit in a child, keep it in this node
    if (sphereRadius > childHalf) {
      return -1;
    }

    const cx = this.center.x;
    const cy = this.center.y;
    const cz = this.center.z;
    const sx = sphereCenter.x;
    const sy = sphereCenter.y;
    const sz = sphereCenter.z;

    // Determine which octant the center is in
    let index = 0;
    if (sx >= cx) {
      index |= 1;
    }
    if (sy >= cy) {
      index |= 2;
    }
    if (sz >= cz) {
      index |= 4;
    }

    // Check if sphere fully fits within that child's AABB
    const childCenterX = cx + (index & 1 ? childHalf : -childHalf);
    const childCenterY = cy + (index & 2 ? childHalf : -childHalf);
    const childCenterZ = cz + (index & 4 ? childHalf : -childHalf);

    if (
      Math.abs(sx - childCenterX) + sphereRadius > childHalf ||
      Math.abs(sy - childCenterY) + sphereRadius > childHalf ||
      Math.abs(sz - childCenterZ) + sphereRadius > childHalf
    ) {
      return -1; // Sphere straddles child boundary — stays in this node
    }

    return index;
  }

  /**
   * Creates a child node at the given index.
   * @param {number} index Child index 0-7.
   * @returns {OctreeNode} The new child node.
   * @private
   */
  _createChild(index) {
    const childHalf = this.halfExtent * 0.5;
    const cx = this.center.x;
    const cy = this.center.y;
    const cz = this.center.z;

    _scratchChildCenter.x = cx + (index & 1 ? childHalf : -childHalf);
    _scratchChildCenter.y = cy + (index & 2 ? childHalf : -childHalf);
    _scratchChildCenter.z = cz + (index & 4 ? childHalf : -childHalf);

    return new OctreeNode(
      _scratchChildCenter,
      childHalf,
      this.depth + 1,
      this._maxDepth,
      this._maxCommandsPerNode,
    );
  }

  /**
   * Splits this node into 8 children and redistributes commands.
   * Only called when commands exceed maxCommandsPerNode and depth < maxDepth.
   * @private
   */
  _split() {
    if (!this.isLeaf || this.depth >= this._maxDepth) {
      return;
    }

    this.children = new Array(8);
    for (let i = 0; i < 8; i++) {
      this.children[i] = null; // Lazy — created on demand
    }
    this.isLeaf = false;

    // Redistribute existing commands
    const commands = this.commands;
    const remaining = [];
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      if (!defined(cmd.boundingVolume)) {
        remaining.push(cmd);
        continue;
      }
      const childIdx = this._getChildIndex(cmd.boundingVolume);
      if (childIdx === -1) {
        remaining.push(cmd);
      } else {
        if (this.children[childIdx] === null) {
          this.children[childIdx] = this._createChild(childIdx);
        }
        this.children[childIdx].commands.push(cmd);
        this.children[childIdx].totalCommandCount++;
      }
    }
    this.commands = remaining;
  }

  /**
   * Inserts a command into this node or an appropriate descendant.
   *
   * @param {object} command A DrawCommand with a boundingVolume.
   */
  insert(command) {
    this.totalCommandCount++;

    // Commands without bounding volumes stay at this node
    if (!defined(command.boundingVolume)) {
      this.commands.push(command);
      return;
    }

    // If leaf and should split
    if (
      this.isLeaf &&
      this.commands.length >= this._maxCommandsPerNode &&
      this.depth < this._maxDepth
    ) {
      this._split();
    }

    // Try to place in a child
    if (!this.isLeaf) {
      const childIdx = this._getChildIndex(command.boundingVolume);
      if (childIdx !== -1) {
        if (this.children[childIdx] === null) {
          this.children[childIdx] = this._createChild(childIdx);
        }
        this.children[childIdx].insert(command);
        return;
      }
    }

    // Keep in this node (too large for children, or leaf)
    this.commands.push(command);
  }

  /**
   * Clears all commands from this node and its descendants.
   * Keeps the tree structure for reuse next frame.
   */
  clear() {
    this.commands.length = 0;
    this.totalCommandCount = 0;

    if (!this.isLeaf && this.children !== null) {
      for (let i = 0; i < 8; i++) {
        if (this.children[i] !== null) {
          this.children[i].clear();
        }
      }
    }
  }

  /**
   * Traverses the octree, performing hierarchical frustum + horizon culling.
   * Appends visible commands to the result array.
   *
   * Uses plane mask optimization: planes confirmed INSIDE for a node don't
   * need re-testing for its children. This matches how Cesium3DTilesetTraversal
   * and QuadtreePrimitive work.
   *
   * @param {CullingVolume} cullingVolume The camera frustum.
   * @param {object} [occluder] The horizon occluder (EllipsoidalOccluder).
   * @param {number} planeMask Initial plane mask (0x3f = all 6 planes need testing).
   * @param {Array} result Array to append visible commands to.
   * @returns {number} Number of commands added.
   */
  collectVisible(cullingVolume, occluder, planeMask, result) {
    if (this.totalCommandCount === 0) {
      return 0;
    }

    // Frustum test with plane mask optimization
    const visibility = cullingVolume.computeVisibilityWithPlaneMask(
      this.boundingSphere,
      planeMask,
    );

    if (visibility === Intersect.OUTSIDE) {
      return 0; // Entire subtree is outside frustum
    }

    // Horizon culling — if behind the globe's horizon, skip subtree
    if (
      defined(occluder) &&
      !occluder.isBoundingSphereVisible(this.boundingSphere)
    ) {
      return 0; // Entire subtree is behind horizon
    }

    // All commands in this node are visible (passed frustum + horizon)
    let added = 0;
    const commands = this.commands;
    for (let i = 0; i < commands.length; i++) {
      result.push(commands[i]);
      added++;
    }

    // Recurse into children with updated plane mask
    // If visibility === INSIDE, children don't need frustum testing (mask = 0)
    const childMask =
      visibility === Intersect.INSIDE
        ? 0 // All children are fully inside — no plane tests needed
        : visibility; // Pass the intersecting plane mask

    if (!this.isLeaf && this.children !== null) {
      for (let i = 0; i < 8; i++) {
        if (this.children[i] !== null) {
          added += this.children[i].collectVisible(
            cullingVolume,
            occluder,
            childMask,
            result,
          );
        }
      }
    }

    return added;
  }

  /**
   * Collects all commands in sorted spatial order (front-to-back or back-to-front).
   * This enables hierarchical sort batching: entire spatial regions sort as units.
   *
   * @param {Cartesian3} cameraPosition Camera position for distance computation.
   * @param {boolean} frontToBack If true, closer nodes first; else farther first.
   * @param {Array} result Array to append sorted commands to.
   */
  collectSorted(cameraPosition, frontToBack, result) {
    if (this.totalCommandCount === 0) {
      return;
    }

    // Add this node's commands
    const commands = this.commands;
    for (let i = 0; i < commands.length; i++) {
      result.push(commands[i]);
    }

    // Sort children by distance to camera, then recurse
    if (!this.isLeaf && this.children !== null) {
      const childDistances = _scratchChildDistances;
      let childCount = 0;
      for (let i = 0; i < 8; i++) {
        if (this.children[i] !== null && this.children[i].totalCommandCount > 0) {
          childDistances[childCount] = {
            index: i,
            distance: Cartesian3.distanceSquared(
              this.children[i].center,
              cameraPosition,
            ),
          };
          childCount++;
        }
      }

      // Sort children by distance
      for (let i = 0; i < childCount; i++) {
        for (let j = i + 1; j < childCount; j++) {
          const swap = frontToBack
            ? childDistances[i].distance > childDistances[j].distance
            : childDistances[i].distance < childDistances[j].distance;
          if (swap) {
            const tmp = childDistances[i];
            childDistances[i] = childDistances[j];
            childDistances[j] = tmp;
          }
        }
      }

      for (let i = 0; i < childCount; i++) {
        this.children[childDistances[i].index].collectSorted(
          cameraPosition,
          frontToBack,
          result,
        );
      }
    }
  }

  /**
   * Returns diagnostic information about this node and its subtree.
   * @returns {object} Diagnostic info.
   */
  getDiagnostics() {
    let nodeCount = 1;
    let leafCount = this.isLeaf ? 1 : 0;
    let maxDepthSeen = this.depth;
    let totalCommands = this.commands.length;

    if (!this.isLeaf && this.children !== null) {
      for (let i = 0; i < 8; i++) {
        if (this.children[i] !== null) {
          const childDiag = this.children[i].getDiagnostics();
          nodeCount += childDiag.nodeCount;
          leafCount += childDiag.leafCount;
          maxDepthSeen = Math.max(maxDepthSeen, childDiag.maxDepth);
          totalCommands += childDiag.totalCommands;
        }
      }
    }

    return {
      nodeCount: nodeCount,
      leafCount: leafCount,
      maxDepth: maxDepthSeen,
      totalCommands: totalCommands,
    };
  }
}

// Scratch variables to avoid per-call allocations
const _scratchChildCenter = new Cartesian3();

// Pre-allocated scratch for child distance sorting (max 8 children)
const _scratchChildDistances = new Array(8);
for (let i = 0; i < 8; i++) {
  _scratchChildDistances[i] = { index: 0, distance: 0.0 };
}

export default OctreeNode;
