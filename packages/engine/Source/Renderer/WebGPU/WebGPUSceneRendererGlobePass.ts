/**
 * Globe-pass dispatch logic extracted from `WebGPUSceneRenderer`.
 *
 * Batch 135 of the audit-recommended SceneRenderer decomposition.
 * Scope is the LOGIC portion of `_executeGlobePass`: translucency
 * branch, render-bundle optimisation attempt, and fallback
 * `executeBatch` dispatch. The pragma-stripped diagnostic prelude
 * (validation error scope, render-pass logging, command-count
 * throttle) stays inline in `WebGPUSceneRenderer._executeGlobePass`
 * because:
 *
 *   - The 5 diag fields it touches (`_globeValidationDone`,
 *     `_globePassRPLogged`, `_globeCountLogged`,
 *     `_globeCountLogFrame`, `_globePassLastLog`) are pragma-stripped
 *     class members. Moving them across the file boundary would
 *     complicate the pragma block placement.
 *   - The `context.uniformState?.updatePass(Pass.GLOBE)` call at the
 *     end of the diag prelude IS load-bearing in production but sits
 *     in the same prelude block — extracting it without the diag
 *     would split a tightly-coupled body for marginal benefit.
 *
 * This function takes ZERO `this.*` dependencies on the SceneRenderer
 * (verified pre-extraction by grep), so it's a pure free function.
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
 * NEW-GLOBE-RENDERBUNDLE-CACHE (Batch 292) — the inline per-frame
 * `GPURenderBundle` that used to wrap the opaque-terrain dispatch was
 * REMOVED. Render bundles only pay off when cached and replayed across
 * many frames; this one was rebuilt from scratch every frame (create
 * encoder → record every tile command → `finish()` → `executeBundles`),
 * so it paid the full bundle-construction cost with zero amortization.
 * Measured cost (probe-globe-bundle-cost.mjs, 55-tile low view): the
 * bundle path ran ~0.3-0.4 ms SLOWER at the median than direct
 * `executeBatch`, with a markedly worse p90 (build-cost spikes).
 *
 * It also can't be safely cached: each globe command records
 * `setBindGroup(0, bg0, [cameraOffset, tileOffset, eclipseOffset])` with
 * the ring-allocator byte offsets BAKED IN at record time. Those
 * offsets rotate every frame (the per-frame ring allocator cycles
 * pages by design — NEW-GLOBE-DYNAMIC-OFFSET-UBO made the bind-GROUP
 * object stable across motion, but the dynamic-OFFSET values still
 * change frame-to-frame), so a cached bundle would replay stale offsets
 * and bind the wrong UB slices. A signature-keyed cache that included
 * the offsets would miss every frame — no better than rebuilding.
 *
 * The path therefore drops straight through to `executeBatch`. Do not
 * re-add an inline bundle here without first making the per-tile UBs
 * frame-stable (i.e. not ring-allocated) — see the cost probe before
 * assuming a bundle helps.
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

  // Opaque terrain: direct per-command dispatch. The previous inline
  // per-frame render bundle was removed (NEW-GLOBE-RENDERBUNDLE-CACHE,
  // Batch 292) — it was net-negative because it rebuilt the bundle every
  // frame and could not be cached (per-tile dynamic UB offsets are baked
  // into the recorded commands and rotate each frame). See the
  // file-level docstring for the cost measurement + rationale.
  executeBatch(commands, count, scene, context, passState);
}
