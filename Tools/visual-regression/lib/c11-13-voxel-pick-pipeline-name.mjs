/**
 * Derive the one exact voxel-pick pipeline name from independent log-depth
 * state. Returning null is structural: the probe must never infer expected
 * state from the descriptor string that it is meant to verify.
 * @purpose Derives the one exact voxel-pick pipeline name from independent log-depth state; returns null (structural) rather than inferring from the descriptor.
 * @status ACTIVE
 *
 */
export function expectedC1113VoxelPickPipelineName(state) {
  if (
    typeof state?.master !== "boolean" ||
    typeof state?.frame !== "boolean" ||
    typeof state?.realized !== "boolean"
  ) {
    return null;
  }
  const expectedRealized = state.master && state.frame;
  if (state.realized !== expectedRealized) {
    return null;
  }
  return `Voxel pickVoxel pipeline${state.realized ? " [ld]" : ""}`;
}

export function exactC1113VoxelPickPipelineName(state, actualName) {
  const expectedName = expectedC1113VoxelPickPipelineName(state);
  return expectedName !== null && actualName === expectedName;
}
