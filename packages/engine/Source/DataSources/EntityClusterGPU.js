import Cartesian3 from "../Core/Cartesian3.js";
import defined from "../Core/defined.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";

/**
 * GPU acceleration helper for {@link EntityCluster}'s screen-space declutter
 * (Phase 10, NEW-ENTITYCLUSTER-GPU).
 *
 * The CPU path (in EntityCluster.js) builds a per-frame `KDBush` spatial index
 * over every visible screen-space point and runs a greedy range-query merge —
 * an O(N log N) build plus many range queries that don't scale to the 50k+
 * markers Phase 10 targets. This helper replaces the index-build + neighbour
 * bucketing with a single GPU compute pass (`EntityClusterGridGPU.wgsl`, owned
 * by `WebGPUEntityClusterDispatcher`): every visible point is hashed into a
 * uniform screen-space grid whose cell edge equals the merge radius
 * (pixelRange) and the per-cell occupancy + a per-cell representative point
 * index are accumulated atomically. The (sequential) representative-selection +
 * 3×3-neighbourhood merge then runs HERE on the CPU, but over the reduced set
 * of non-empty cells rather than every point.
 *
 * Backend agnosticism: this module is consulted from EntityCluster.js ONLY
 * through `context.getFeatureRenderer(ENTITY_CLUSTER_GPU)` — when the renderer
 * is absent (WebGL2, or WebGPU before the dispatcher loads) the caller uses the
 * unchanged CPU KDBush path. No `isWebGPU` branch.
 *
 * Async seam: the GPU readback is one-frame-latency (`mapAsync`). `requestGrid`
 * kicks off the compute and caches the result on the EntityCluster; the
 * synchronous declutter consumes the most-recent grid. Declutter already lags
 * the camera by a frame (it runs off `camera.changed`), so a one-frame-stale
 * grid is visually identical. A grid is only consumed when its `pointCount`
 * matches the current visible-point count AND its `pixelRange` matches — any
 * mismatch falls back to the CPU path for that frame and re-requests.
 *
 * A fully-GPU parallel merge (union-find over the grid, no readback) is a
 * follow-up — see NEW-ENTITYCLUSTER-GPU-MERGE in DEFERRED_WORK.md.
 *
 * @private
 * @module EntityClusterGPU
 */

const SENTINEL = -1.0e31; // matches the shader's x < -1e30 skip test
const EMPTY = 0xffffffff;

/**
 * Returns the ENTITY_CLUSTER_GPU feature renderer if the scene's context
 * exposes one (WebGPU with the dispatcher registered), otherwise undefined.
 * @private
 */
function getClusterRenderer(scene) {
  if (!defined(scene) || !defined(scene.context)) {
    return undefined;
  }
  const context = scene.context;
  if (typeof context.getFeatureRenderer !== "function") {
    return undefined;
  }
  return context.getFeatureRenderer(FeatureRendererKey.ENTITY_CLUSTER_GPU);
}

/**
 * True when GPU-accelerated clustering is available for this EntityCluster's
 * scene. Used by EntityCluster to decide whether to feed the GPU grid path.
 * @private
 */
function gpuClusteringAvailable(entityCluster) {
  const fr = getClusterRenderer(entityCluster._scene);
  return defined(fr) && typeof fr.computeGrid === "function";
}

/**
 * Computes the screen-space grid geometry for the current viewport + merge
 * radius. The grid spans the drawing buffer plus a one-cell margin on every
 * side so points near (and just off) the edges still bin correctly.
 * @private
 */
function computeGridGeometry(scene, pixelRange) {
  const cellSize = Math.max(pixelRange, 1.0);
  const width = scene.drawingBufferWidth || scene.canvas.clientWidth || 1;
  const height = scene.drawingBufferHeight || scene.canvas.clientHeight || 1;
  // computeScreenSpacePosition returns CSS-pixel coords; convert the drawing
  // buffer extent to CSS pixels via the resolution scale so the grid matches
  // the coordinate space of the points.
  const pixelRatio = scene.pixelRatio || 1.0;
  const cssWidth = width / pixelRatio;
  const cssHeight = height / pixelRatio;
  const originX = -cellSize; // one-cell margin
  const originY = -cellSize;
  const gridCols = Math.ceil((cssWidth + 2 * cellSize) / cellSize) + 1;
  const gridRows = Math.ceil((cssHeight + 2 * cellSize) / cellSize) + 1;
  return { cellSize, originX, originY, gridCols, gridRows };
}

/**
 * Kicks off (or refreshes) the async GPU grid for the given visible-point set.
 * Resolves into `entityCluster._gpuGrid`; triggers a scene re-render so the
 * next declutter consumes the fresh grid. Idempotent while a request is in
 * flight (the dispatcher drops overlapping `computeGrid` calls).
 *
 * @param {EntityCluster} entityCluster
 * @param {object[]} points The visible-point array built by the declutter
 *        callback (each has `.coord.x/.y`).
 * @param {number} pixelRange The merge radius (cell edge).
 * @private
 */
function requestGrid(entityCluster, points, pixelRange) {
  const scene = entityCluster._scene;
  const fr = getClusterRenderer(scene);
  if (!defined(fr) || typeof fr.computeGrid !== "function") {
    return;
  }

  const pointCount = points.length;
  if (pointCount === 0) {
    entityCluster._gpuGrid = undefined;
    return;
  }

  const geom = computeGridGeometry(scene, pixelRange);

  // Reuse a scratch coords buffer sized to the point count (grown as needed).
  let coords = entityCluster._gpuCoordsScratch;
  if (!defined(coords) || coords.length < pointCount * 4) {
    coords = new Float32Array(pointCount * 4);
    entityCluster._gpuCoordsScratch = coords;
  }
  for (let i = 0; i < pointCount; i++) {
    const coord = points[i].coord;
    const o = i * 4;
    if (defined(coord)) {
      coords[o] = coord.x;
      coords[o + 1] = coord.y;
    } else {
      coords[o] = SENTINEL;
      coords[o + 1] = SENTINEL;
    }
    coords[o + 2] = 0;
    coords[o + 3] = 0;
  }

  const generation = (entityCluster._gpuGridGeneration || 0) + 1;
  entityCluster._gpuGridGeneration = generation;

  const promise = fr.computeGrid(
    coords,
    pointCount,
    geom.gridCols,
    geom.gridRows,
    geom.cellSize,
    geom.originX,
    geom.originY,
  );
  if (!defined(promise) || typeof promise.then !== "function") {
    return;
  }
  promise
    .then(function (grid) {
      if (!defined(grid)) {
        return;
      }
      // Stash the grid + the parameters it was computed under so the consumer
      // can validate freshness (point count + merge radius must still match).
      entityCluster._gpuGrid = {
        generation: generation,
        pointCount: pointCount,
        pixelRange: pixelRange,
        gridCols: grid.gridCols,
        cellCounts: grid.cellCounts,
        cellRep: grid.cellRep,
        pointCellId: grid.pointCellId,
      };
      // The declutter that produced these points already drew; request a
      // re-render so the fresh grid is consumed on the next frame.
      if (defined(scene.requestRender)) {
        scene.requestRender();
      }
    })
    .catch(function () {
      // Readback failure already logged by the dispatcher; the CPU path
      // remains the fallback for this and subsequent frames.
    });
}

/**
 * Attempts to cluster `points` using the cached GPU grid. Returns an array of
 * cluster descriptors (one per produced cluster) plus marks each consumed
 * point's `.clustered` flag, OR returns null when no fresh grid is available
 * (caller must use the CPU KDBush path).
 *
 * Each returned cluster descriptor:
 *   { position: Cartesian3, ids: Entity[], numPoints: number }
 *
 * The merge is a greedy raster-order walk over non-empty cells: a seed cell
 * with members absorbs the unclaimed 3×3 neighbour cells, but the absorb is now
 * GATED on representative-to-representative pixel distance (Batch 308,
 * NEW-ENTITYCLUSTER-GPU-MERGE) — a neighbour cell only merges into the seed when
 * its representative is within the merge radius of the seed's representative, and
 * within an absorbed neighbour cell only the individual members within the merge
 * radius of the seed are pulled in. This mirrors the CPU KDBush path's per-point
 * `pixelRange`-expanded bbox range query (which absorbs a neighbour only when its
 * SCREEN position overlaps the seed's range), tightening cross-backend cluster-
 * count parity vs the previous unconditional whole-3×3-cell absorb (a 3×3 block
 * spans 3·pixelRange, so the old path over-merged points up to ~3× the radius
 * apart → systematically fewer representatives than the CPU path). A seed whose
 * gated membership is at least `minimumClusterSize` becomes one cluster at the
 * world centroid of its members; sub-threshold seeds leave their members
 * un-clustered (rendered individually).
 *
 * @param {EntityCluster} entityCluster
 * @param {object[]} points
 * @param {number} pixelRange
 * @param {number} minimumClusterSize
 * @returns {object[]|null}
 * @private
 */
function clusterWithGrid(
  entityCluster,
  points,
  pixelRange,
  minimumClusterSize,
) {
  const grid = entityCluster._gpuGrid;
  if (!defined(grid)) {
    return null;
  }
  // Freshness: the grid must describe THIS point set (same count) and the same
  // merge radius. Camera moves between frames don't matter — declutter is
  // intentionally a frame behind — but a changed point count or pixelRange
  // means the grid is stale and the CPU path must run this frame.
  if (grid.pointCount !== points.length || grid.pixelRange !== pixelRange) {
    return null;
  }

  const gridCols = grid.gridCols;
  const cellCounts = grid.cellCounts;
  const cellRep = grid.cellRep;
  const pointCellId = grid.pointCellId;
  const numCells = cellCounts.length;

  // Bucket point indices by cell so the merge can read members directly.
  // membersByCell is a sparse map cellId -> number[] (only non-empty cells).
  const membersByCell = new Map();
  for (let i = 0; i < points.length; i++) {
    const cellId = pointCellId[i];
    if (cellId === EMPTY || cellId >= numCells) {
      continue;
    }
    let arr = membersByCell.get(cellId);
    if (!defined(arr)) {
      arr = [];
      membersByCell.set(cellId, arr);
    }
    arr.push(i);
  }

  const clusters = [];
  const centroidScratch = new Cartesian3();

  // Rep-to-rep / member-to-seed absorb radius (squared, in screen pixels).
  // pixelRange is the cell edge AND the CPU path's bbox half-extent — two
  // markers cluster on the CPU when their pixelRange-expanded screen bboxes
  // overlap, i.e. roughly within pixelRange centre-to-centre. Gate the GPU
  // absorb at the same distance so the 3×3 block (which spans 3·pixelRange)
  // no longer over-merges far-apart points.
  const mergeRadius = Math.max(pixelRange, 1.0);
  const mergeRadiusSq = mergeRadius * mergeRadius;

  // Screen coord of a point index, or undefined when it carries no coord.
  function coordOf(idx) {
    const p = points[idx];
    return defined(p) ? p.coord : undefined;
  }

  // Point-level greedy claim (mirrors the CPU path's `point.clustered`): a
  // point joins exactly one cluster. We claim on ACCEPT (cluster ≥ threshold),
  // not on candidacy, so a sub-threshold seed's members stay available to a
  // denser later seed — exactly the CPU greedy semantics. Note `point.clustered`
  // itself is set by EntityCluster.js AFTER this returns; this scratch is the
  // intra-merge bookkeeping and stays internal to clusterWithGrid.
  const claimedPoint = new Uint8Array(points.length);

  // Raster-order walk for determinism (smallest cellId first).
  const cellIds = Array.from(membersByCell.keys()).sort(function (a, b) {
    return a - b;
  });

  for (let k = 0; k < cellIds.length; k++) {
    const cellId = cellIds[k];
    if (cellCounts[cellId] === 0) {
      continue;
    }

    const col = cellId % gridCols;
    const row = (cellId - col) / gridCols;

    // Seed: the smallest UNCLAIMED member of the seed cell (prefer the GPU's
    // atomicMin per-cell rep when it is still unclaimed + carries a coord, else
    // the smallest unclaimed bucketed member). Its screen coord anchors the
    // pixel-distance gate.
    const seedMembers = membersByCell.get(cellId);
    let seedIndex = -1;
    const seedCellRep = cellRep[cellId];
    if (
      seedCellRep !== EMPTY &&
      seedCellRep < points.length &&
      !claimedPoint[seedCellRep] &&
      defined(coordOf(seedCellRep))
    ) {
      seedIndex = seedCellRep;
    } else if (defined(seedMembers)) {
      for (let m = 0; m < seedMembers.length; m++) {
        if (!claimedPoint[seedMembers[m]]) {
          seedIndex = seedMembers[m];
          break;
        }
      }
    }
    if (seedIndex < 0) {
      continue; // every member of this cell already belongs to a cluster
    }
    const seedCoord = coordOf(seedIndex);

    // Gather the seed plus the unclaimed 3×3 neighbourhood, GATING each
    // candidate on screen-distance to the seed (rep-to-rep for the neighbour
    // cell, then member-to-seed per point). This mirrors the CPU path's
    // pixelRange range query instead of absorbing the whole 3×3 block.
    const memberIndices = [seedIndex];
    for (let dr = -1; dr <= 1; dr++) {
      const nr = row + dr;
      if (nr < 0) {
        continue;
      }
      for (let dc = -1; dc <= 1; dc++) {
        const nc = col + dc;
        if (nc < 0 || nc >= gridCols) {
          continue;
        }
        const nId = nr * gridCols + nc;
        if (nId >= numCells) {
          continue;
        }
        const arr = membersByCell.get(nId);
        if (!defined(arr)) {
          continue;
        }

        const isSeedCell = nId === cellId;
        // Rep-to-rep gate for NEIGHBOUR cells: skip a neighbour whose own
        // representative is beyond the merge radius from the seed. The seed
        // cell is handled member-by-member below (its rep IS the seed).
        if (!isSeedCell && defined(seedCoord)) {
          const nRep = cellRep[nId];
          const repIdx = nRep !== EMPTY && nRep < points.length ? nRep : arr[0];
          const repCoord = coordOf(repIdx);
          if (defined(repCoord)) {
            const drx = repCoord.x - seedCoord.x;
            const dry = repCoord.y - seedCoord.y;
            if (drx * drx + dry * dry > mergeRadiusSq) {
              continue;
            }
          }
        }

        // Member-to-seed gate: pull in only the unclaimed members within the
        // merge radius of the seed. Out-of-range / already-claimed members are
        // left for a nearer (or earlier) seed.
        for (let m = 0; m < arr.length; m++) {
          const mi = arr[m];
          if (mi === seedIndex || claimedPoint[mi]) {
            continue;
          }
          if (defined(seedCoord)) {
            const mc = coordOf(mi);
            if (defined(mc)) {
              const dx = mc.x - seedCoord.x;
              const dy = mc.y - seedCoord.y;
              if (dx * dx + dy * dy > mergeRadiusSq) {
                continue;
              }
            }
          }
          memberIndices.push(mi);
        }
      }
    }

    const numPoints = memberIndices.length;
    if (numPoints < minimumClusterSize) {
      // Sub-threshold — leave these points un-claimed so a denser later seed
      // can still absorb them (CPU greedy parity: a point participates in at
      // most one ACCEPTED cluster, not one candidacy).
      continue;
    }

    // World centroid of the members (Cesium averages world positions); claim
    // each member so it can't be double-counted by a later seed.
    centroidScratch.x = 0;
    centroidScratch.y = 0;
    centroidScratch.z = 0;
    const ids = [];
    for (let m = 0; m < numPoints; m++) {
      const mi = memberIndices[m];
      const p = points[mi];
      const item = p.collection.get(p.index);
      Cartesian3.add(item.position, centroidScratch, centroidScratch);
      ids.push(item.id);
      p.clustered = true;
      claimedPoint[mi] = 1;
    }
    Cartesian3.multiplyByScalar(
      centroidScratch,
      1.0 / numPoints,
      centroidScratch,
    );

    clusters.push({
      position: Cartesian3.clone(centroidScratch),
      ids: ids,
      numPoints: numPoints,
    });
  }

  return clusters;
}

export {
  gpuClusteringAvailable,
  requestGrid,
  clusterWithGrid,
  getClusterRenderer,
};

/**
 * Namespace aggregate of the EntityCluster GPU helpers. The engine barrel
 * (`packages/engine/index.js`) re-exports every Source module's default; this
 * keeps that export resolvable while the named exports above are the real API.
 * @private
 */
const EntityClusterGPU = {
  gpuClusteringAvailable,
  requestGrid,
  clusterWithGrid,
  getClusterRenderer,
};
export default EntityClusterGPU;
