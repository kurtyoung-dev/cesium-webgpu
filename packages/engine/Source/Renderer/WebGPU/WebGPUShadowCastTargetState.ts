/**
 * Shared lifecycle rule for a WebGPU shadow cast target (the single depth map
 * and every CSM cascade layer).
 *
 * A cast pass with no casters still clears its target once. Otherwise a scene
 * that transitions from casters to no casters leaves receivers sampling the
 * previous frame's depth indefinitely. The clear is valid only when an
 * earlier frame populated the target.
 *
 * `SceneRenderer.executeShadowMapCastCommands` is the only site that populates
 * `ShadowMap.passes[j].commandList`, and
 * `WebGPUContext.executeShadowMapCastCommands` empties those lists after
 * consuming them. A repeated dispatch in the same frame therefore sees no
 * casters but is not a casters-to-empty transition. Clearing then would erase
 * depth written earlier in the frame before any receiver samples it. Tracking
 * the content frame makes that erase impossible without relying on there being
 * exactly one caller.
 *
 * @private
 */
export type ShadowCastContentState = "uninitialized" | "casters" | "empty";

/**
 * Whether a caster-less cast dispatch should emit its transition clear.
 *
 * @param contentState What the target currently holds.
 * @param contentFrameNumber The frame on which casters were last rendered into
 * the target, or `undefined` if never.
 * @param frameNumber The frame being encoded. `undefined` disables the
 * same-frame guard.
 * @returns `true` when the target still needs the transition clear.
 * @private
 */
export function shouldClearShadowCastTarget(
  contentState: ShadowCastContentState | string | undefined,
  contentFrameNumber: number | undefined,
  frameNumber: number | undefined,
): boolean {
  // Already empty — a repeat clear would be pure waste.
  if (contentState === "empty") {
    return false;
  }
  // Populated by an earlier dispatch in this frame. A caster-less re-entry is
  // a duplicate dispatch, never a real "casters went away" transition, so
  // clearing here would destroy depth the color pass is about to read.
  if (
    contentState === "casters" &&
    typeof frameNumber === "number" &&
    contentFrameNumber === frameNumber
  ) {
    return false;
  }
  return true;
}
