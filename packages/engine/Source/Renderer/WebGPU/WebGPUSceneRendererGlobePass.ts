/**
 * Globe-pass dispatch logic for `WebGPUSceneRenderer`.
 *
 * Scope is the logic portion of `_executeGlobePass`: the translucency branch
 * and the `executeBatch` dispatch. The pragma-stripped diagnostic prelude —
 * validation error scope, render-pass logging, command-count throttle — stays
 * inline in `WebGPUSceneRenderer._executeGlobePass` because:
 *
 *   - the five diagnostic fields it touches (`_globeValidationDone`,
 *     `_globePassRPLogged`, `_globeCountLogged`, `_globeCountLogFrame`,
 *     `_globePassLastLog`) are pragma-stripped class members, and moving them
 *     across the file boundary complicates the pragma block placement;
 *   - the `context.uniformState?.updatePass(Pass.GLOBE)` call at the end of
 *     that prelude is load-bearing in production but sits in the same block, so
 *     extracting it would split a tightly-coupled body for marginal benefit.
 *
 * Nothing here reaches back into the SceneRenderer instance, which is what lets
 * it be a free function.
 *
 * @module WebGPUSceneRendererGlobePass
 */

import {
  executeBatch,
  executeBatchTranslucent,
  type WebGPURenderFrameConfig,
} from "./WebGPUSceneRenderer.js";

/**
 * Dispatch the globe-surface commands for a single frustum. Caller
 * (the SceneRenderer's `_executeGlobePass` wrapper) is responsible
 * for:
 *
 *   - Skipping when `frustumCommands.indices[Pass.GLOBE]` is zero.
 *   - Running the pragma-stripped diagnostic prelude.
 *   - Calling `context.uniformState.updatePass(Pass.GLOBE)`.
 *
 * Then this function:
 *
 *   1. Checks `globe._surface._tileProvider.translucencyEnabled`.
 *      If true, dispatches via `executeBatchTranslucent` and returns
 *      (translucency uses per-command blend/cull/depth state from
 *      `_webgpuTranslucencyDerived` — opaque optimisations don't
 *      apply).
 *   2. Falls through to `executeBatch` for the standard per-command
 *      dispatch.
 *
 * The opaque path deliberately carries no `GPURenderBundle`. A bundle only
 * pays off when it is cached and replayed across many frames, and this one
 * cannot be cached: each globe command records
 * `setBindGroup(0, bg0, [cameraOffset, tileOffset, eclipseOffset])` with the
 * ring-allocator byte offsets baked in at record time, and those offsets rotate
 * every frame because the per-frame ring allocator cycles pages by design. A
 * replayed bundle would bind the wrong uniform-buffer slices, and a
 * signature-keyed cache that included the offsets would miss every frame.
 * Rebuilt per frame instead, it measured ~0.3-0.4 ms slower at the median than
 * a direct `executeBatch` on a 55-tile low view, with a markedly worse p90 from
 * build-cost spikes (`probe-globe-bundle-cost.mjs`). Do not add one back here
 * until the per-tile uniform buffers are frame-stable rather than
 * ring-allocated.
 */
export function executeGlobeDispatch(
  commands: CesiumAnyDrawCommand[],
  count: number,
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context, passState } = config;

  // Check if globe is translucent
  const globe = scene.globe;
  const isTranslucent =
    globe &&
    globe._surface &&
    globe._surface._tileProvider &&
    globe._surface._tileProvider.translucencyEnabled;

  if (isTranslucent) {
    // Globe translucency: execute with per-command blend/cull/depth state
    // from the _webgpuTranslucencyDerived marker set by
    // WebGPUGlobeTranslucencyState.updateDerivedCommands()
    executeBatchTranslucent(commands, count, scene, context, passState);
    return;
  }

  // Opaque terrain: direct per-command dispatch, with no render bundle. See
  // the docblock above for the cost measurement and why a bundle here cannot
  // be cached.
  executeBatch(commands, count, scene, context, passState);
}
