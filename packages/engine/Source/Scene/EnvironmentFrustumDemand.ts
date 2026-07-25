/**
 * Backend-neutral demand check for environment content that the active scene
 * renderer must execute INSIDE the multi-frustum loop.
 *
 * Background (C12-G1F1). Two renderer conventions exist for the celestial /
 * environment layer:
 *
 *   - The direct convention (WebGL): `SceneRenderer.renderEnvironment` executes
 *     `scene._environmentState`'s commands with `command.execute(context,
 *     passState)` BEFORE the frustum loop, so environment content never depends
 *     on a frustum existing.
 *   - The injection convention (any `scene._alternateSceneRenderer`, i.e.
 *     WebGPU): environment commands cannot be executed outside a render pass,
 *     so `SceneRenderer.executeCommands` injects them into the FARTHEST
 *     frustum's `Pass.ENVIRONMENT` slot. If `frustumCommandsList.length === 0`
 *     there is nowhere to inject and the whole frame is dropped.
 *
 * `View.createPotentiallyVisibleSet` derives the frustum count from the scene
 * near/far accumulated over `frameState.commandList`. Only SOME environment
 * elements push a binned copy onto that list (SkyAtmosphere, Sun, and StarField
 * — and StarField only while its daytime fade is non-zero); SkyBox and Moon are
 * inject-only (Moon even redirects `frameState.commandList` to a scratch array).
 * So on the injection convention the frustum count — and therefore whether the
 * environment renders AT ALL — depended on which OTHER environment elements
 * happened to emit a binned command that frame. Turning the star field off, or
 * simply looking at a moon-only scene in daylight (star fade 0), collapsed
 * near/far to their sentinels, produced zero frustums, and blacked out the
 * entire sky.
 *
 * This module owns the shared predicate the frustum-existence decision needs:
 * "does this frame have environment content that a frustum must carry?" It is
 * per-frame, side-effect free, and never branches on backend identity — it
 * reads the same `_alternateSceneRenderer` discriminator the injection site
 * itself uses, so WebGL (which has none) is untouched.
 *
 * @module EnvironmentFrustumDemand
 */

interface ExecutableCommand {
  readonly execute?: unknown;
}

interface EnvironmentStateShape {
  readonly skyBoxCommand?: ExecutableCommand;
  readonly starFieldCommand?: ExecutableCommand;
  readonly skyAtmosphereCommand?: ExecutableCommand;
  readonly sunDrawCommand?: ExecutableCommand;
  readonly moonCommand?: ExecutableCommand;
  readonly isSkyAtmosphereVisible?: boolean;
  readonly isSunVisible?: boolean;
  readonly isMoonVisible?: boolean;
}

interface EnvironmentDemandScene {
  readonly _alternateSceneRenderer?: unknown;
  readonly _environmentState?: EnvironmentStateShape;
  readonly _frameState?: {
    readonly passes?: { readonly render?: boolean };
    readonly panoramaCommandList?: readonly ExecutableCommand[];
  };
}

/**
 * Mirrors the executability test the injection site applies
 * (`SceneRenderer.executeCommands`: `defined(cmd) && typeof cmd.execute ===
 * "function"`). A command the injector would skip must not be allowed to
 * conjure a frustum here, or an all-off scene would start paying for an empty
 * environment pass.
 */
function isInjectable(command: ExecutableCommand | undefined): boolean {
  return command !== undefined && typeof command.execute === "function";
}

/**
 * Whether this frame carries environment content that only executes once a
 * frustum exists to hold it.
 *
 * Returns `false` on renderers that execute the environment directly (no
 * `_alternateSceneRenderer`) and on non-render passes (pick / offscreen), where
 * `Scene.updateEnvironment` has already cleared the command slots — keeping
 * both paths byte-identical to their pre-C12-G1F1 behavior.
 *
 * @param scene - The scene being drawn.
 * @returns `true` when the environment layer needs a frustum this frame.
 */
export function hasInjectedEnvironmentContent(scene: unknown): boolean {
  const demandScene = scene as EnvironmentDemandScene | undefined | null;
  if (demandScene === undefined || demandScene === null) {
    return false;
  }
  // Only the injection convention couples environment execution to frustum
  // existence. WebGL renders the environment before the frustum loop.
  const renderer = demandScene._alternateSceneRenderer;
  if (renderer === undefined || renderer === null) {
    return false;
  }
  const frameState = demandScene._frameState;
  if (frameState?.passes?.render !== true) {
    return false;
  }
  const environmentState = demandScene._environmentState;
  if (environmentState === undefined || environmentState === null) {
    return false;
  }

  // Background layers are prepended unconditionally by the injector.
  if (
    isInjectable(environmentState.skyBoxCommand) ||
    isInjectable(environmentState.starFieldCommand)
  ) {
    return true;
  }
  // Culled/visibility-gated layers only inject when their flag is set.
  if (
    (environmentState.isSkyAtmosphereVisible === true &&
      isInjectable(environmentState.skyAtmosphereCommand)) ||
    (environmentState.isSunVisible === true &&
      isInjectable(environmentState.sunDrawCommand)) ||
    (environmentState.isMoonVisible === true &&
      isInjectable(environmentState.moonCommand))
  ) {
    return true;
  }
  // Panoramas that publish through the frame command list rather than
  // `returnCommand` are injected alongside the celestial layers.
  const panoramas = frameState.panoramaCommandList;
  if (panoramas !== undefined && panoramas !== null) {
    for (let i = 0; i < panoramas.length; i++) {
      if (isInjectable(panoramas[i])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The sky-only frustum fallback for `View.createPotentiallyVisibleSet`.
 *
 * `near > far` means nothing in `frameState.commandList` moved the scene
 * near/far accumulators off their `+/-MAX_VALUE` sentinels. Left alone, the
 * clamps in `updateFrustums` collapse the range to `near === far`, which yields
 * ZERO frustums and a dropped frame. Restore the camera window whenever the
 * frame still has environment content to draw — either BV-less `Pass.ENVIRONMENT`
 * commands that were binned from the command list (C10-01, Batch 693) or
 * inject-only environment commands held on `_environmentState` (C12-G1F1).
 *
 * @param near - Accumulated scene near distance.
 * @param far - Accumulated scene far distance.
 * @param sawEnvironmentNoBV - Whether the PVS walk saw a bounding-volume-less
 *   `Pass.ENVIRONMENT` command in `frameState.commandList`.
 * @param scene - The scene being drawn.
 * @returns `true` when the camera-range window must be restored so a frustum
 *   exists to carry the environment.
 */
export function needsEnvironmentOnlyFrustum(
  near: number,
  far: number,
  sawEnvironmentNoBV: boolean,
  scene: unknown,
): boolean {
  if (!(near > far)) {
    return false;
  }
  return sawEnvironmentNoBV === true || hasInjectedEnvironmentContent(scene);
}
