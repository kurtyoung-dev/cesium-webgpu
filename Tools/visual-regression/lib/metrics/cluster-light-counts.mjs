// cluster-light-counts.mjs — reductions over the clustered-lighting per-cluster light-count readback.
// @purpose Pure reductions over the clustered-lighting dispatcher's per-cluster light-count readback (a Uint32 per cluster of the 16 x 9 x 24 grid): the summed, occupied and largest counts, and the number of clusters on which two readbacks disagree.
// @status ACTIVE
//
// NOT RGBA, AND WHY IT LIVES WITH THE METRICS ANYWAY. Every other module in
// `lib/metrics/` reads decoded pixels. This one reads the GPU buffer the
// clustered-lighting compute passes write — `perClusterLightCountBuffer`, one
// unsigned count per cluster — copied to a mappable staging buffer by the
// probe. Three probes (`probe-clustered-dispatcher`, `-per-frame` and
// `-lights-resize`) each reduced that readback inside the page with a private
// loop: the summed count ("totalOverlap"), the largest count, the number of
// non-empty clusters, and (lights-resize) the number of clusters on which two
// readbacks differ. The reductions are measurements in exactly the sense the
// pixel metrics are, and moving them into Node is what lets a spec drive them
// and an inertness mutant prove the spec can see them.
//
// THE GRID IS THE PROBES' CONSTANT, RECORDED ONCE. The three originals sized
// their staging buffer as `16 * 9 * 24` cells of 4 bytes. `CLUSTER_GRID` is
// that constant, so the page-side readback and the Node-side bar ("a
// directional light reaches every cluster": summed count >= cells) read one
// number rather than three copies of it. It is what the probes assumed, not a
// value read from the engine, and it cannot detect a grid change: each probe
// copies exactly `cells * 4` bytes, so every readback is this length. An
// engine buffer smaller than that makes the copy invalid (a device error,
// which each probe's device-errors verdict counts); a larger one is truncated
// to this length without notice. The `cells` a summary reports restates the
// constant.
//
// FAILS CLOSED. A readback that is empty, or holds anything but non-negative
// integers, throws. Two readbacks of different lengths throw rather than
// compare a prefix: a count of differing clusters taken over the shorter of two
// grids would report agreement on clusters one of them never had.
//
// Pure: no I/O, no browser, no gate decision. The probes own their bars.

/** The cluster grid the three probes sized their readback by (`16 * 9 * 24`). */
export const CLUSTER_GRID = Object.freeze({ x: 16, y: 9, z: 24, cells: 3456 });

function requireCounts(counts, what) {
  if (
    counts === null ||
    typeof counts !== "object" ||
    !Number.isInteger(counts.length) ||
    counts.length === 0
  ) {
    throw new TypeError(`${what} must be a non-empty array of cluster counts`);
  }
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `${what}[${i}] must be a non-negative integer cluster count, received ${String(value)}`,
      );
    }
  }
}

/**
 * Summarise one per-cluster light-count readback.
 *
 * @param {ArrayLike<number>} counts One count per cluster.
 * @returns {{cells: number, total: number, occupied: number, max: number}}
 *   `cells` is the readback length, `total` the summed count (the originals'
 *   "totalOverlap"), `occupied` the number of clusters with a count above 0,
 *   `max` the largest count.
 */
export function summariseClusterLightCounts(counts) {
  requireCounts(counts, "counts");
  let total = 0;
  let occupied = 0;
  let max = 0;
  for (let i = 0; i < counts.length; i++) {
    const value = counts[i];
    total += value;
    if (value > 0) {
      occupied += 1;
    }
    if (value > max) {
      max = value;
    }
  }
  return { cells: counts.length, total, occupied, max };
}

/**
 * The number of clusters whose counts differ between two readbacks.
 *
 * @param {ArrayLike<number>} first
 * @param {ArrayLike<number>} second
 * @returns {number} Clusters with `first[i] !== second[i]`.
 * @throws {RangeError} When the two readbacks have different lengths.
 */
export function clusterCellsThatDiffer(first, second) {
  requireCounts(first, "first");
  requireCounts(second, "second");
  if (first.length !== second.length) {
    throw new RangeError(
      `clusterCellsThatDiffer: readback length mismatch ${first.length} vs ${second.length}; two grids cannot be compared cluster by cluster`,
    );
  }
  let differing = 0;
  for (let i = 0; i < first.length; i++) {
    if (first[i] !== second[i]) {
      differing += 1;
    }
  }
  return differing;
}
