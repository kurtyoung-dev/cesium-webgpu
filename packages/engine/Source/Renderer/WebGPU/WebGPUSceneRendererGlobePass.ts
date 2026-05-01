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

import type { WebGPUContext } from "./WebGPUContext.js";
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
 *   2. For opaque terrain, attempts a `GPURenderBundle` when the
 *      command count meets the perfManager threshold (default 8).
 *      Bundles reduce driver overhead at the cost of a one-time
 *      build; falls back to unbundled execution if either bundle
 *      recording or `executeBundles` throws.
 *   3. Falls through to `executeBatch` for the standard per-command
 *      dispatch.
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

  // Try render bundles for opaque terrain (reduces driver overhead)
  const perfMgr = context.performanceManager;
  const renderPass = context.currentRenderPassEncoder;
  if (
    perfMgr &&
    renderPass &&
    count >= (perfMgr.config?.renderBundleThreshold ?? 8)
  ) {
    try {
      // Batch 110 — globe terrain pipelines target the scene FB, so
      // the bundle's `colorFormats` must mirror the scene FB color
      // format (rgba16float in HDR, canvas format otherwise). Using
      // `presentationFormat` here would mismatch in HDR mode and the
      // bundle would be flagged invalid.
      const bundleEncoder = (
        context._device as GPUDevice
      ).createRenderBundleEncoder({
        label: "Globe terrain bundle",
        colorFormats: [context.scenePipelineFormat],
        depthStencilFormat: context.depthFormat ?? "depth24plus-stencil8",
      });

      let drawCalls = 0;
      for (let i = 0; i < count; i++) {
        const cmd = commands[i];
        if (cmd && cmd.execute) {
          // Ad-hoc globe commands and WebGPUDrawCommands both accept
          // a GPURenderBundleEncoder (same API as GPURenderPassEncoder)
          cmd.execute(bundleEncoder, context as WebGPUContext);
          drawCalls++;
        }
      }

      if (drawCalls > 0) {
        const bundle = bundleEncoder.finish();
        renderPass.executeBundles([bundle]);
        return;
      }
    } catch (_e) {
      // Fall through to unbundled execution if bundle recording fails
    }
  }

  executeBatch(commands, count, scene, context, passState);
}
