/**
 * Shared lifecycle rule for a WebGPU shadow cast target (the single depth map
 * and every CSM cascade layer).
 *
 * A cast pass that receives NO casters still has to clear its target once,
 * otherwise a scene that goes from "casters" to "no casters" leaves receivers
 * sampling last frame's depth forever. That transition clear (Batch 775) is
 * correct — but it is only correct when the target was populated on an EARLIER
 * frame.
 *
 * `NEW-WEBGPU-GLOBE-SUN-SHADOW-RECEIVE-DEAD`: the WebGPU cast dispatch was
 * entered TWICE per frame — once from the backend-neutral
 * `SceneRenderer.executeShadowMapCastCommands` (the only site that populates
 * `ShadowMap.passes[j].commandList`) and again from
 * `WebGPUSceneRenderer.executeCommands`. `WebGPUContext.executeShadowMapCastCommands`
 * empties the per-pass command lists when it is done, so the second entry always
 * saw zero casters, took the transition-clear branch, and wiped the depth the
 * first entry had just written — before any receiver sampled it. The duplicate
 * dispatch was removed; this predicate makes the wipe structurally impossible to
 * reintroduce from ANY future re-entry, rather than relying on there being
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
 * same-frame guard (callers with no frame identity keep the pre-guard
 * behavior).
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
  // Populated by an earlier dispatch on THIS frame. A caster-less re-entry is
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
