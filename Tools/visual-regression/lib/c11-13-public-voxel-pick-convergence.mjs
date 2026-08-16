/**
 * Advance the public voxel-pick convergence state.
 * @purpose Pure convergence predicate for Scene.pickVoxel warm-up: two consecutive identical real cells establish stability; an absent result resets the streak.
 * @status ACTIVE
 *
 * WebGPU's synchronous `Scene.pickVoxel` composes an ordinary object-pick
 * readback with a typed voxel-coordinate readback. A new cursor may therefore
 * return `undefined` for several calls while those two independent readbacks
 * warm. Only two consecutive identical real cells establish convergence;
 * an absent result resets the streak and is never itself a stable value.
 *
 * @param {{lastCellKey: string|null, consecutiveCellCount: number}} state
 * @param {string|null} cellKey A real `tileIndex/sampleIndex` key, or null.
 * @returns {{lastCellKey: string|null, consecutiveCellCount: number, stable: boolean}}
 */
export function advanceC1113PublicVoxelPickConvergence(state, cellKey) {
  if (typeof cellKey !== "string" || cellKey.length === 0) {
    return {
      lastCellKey: null,
      consecutiveCellCount: 0,
      stable: false,
    };
  }

  const consecutiveCellCount =
    state?.lastCellKey === cellKey
      ? Number(state.consecutiveCellCount ?? 0) + 1
      : 1;
  return {
    lastCellKey: cellKey,
    consecutiveCellCount,
    stable: consecutiveCellCount >= 2,
  };
}
