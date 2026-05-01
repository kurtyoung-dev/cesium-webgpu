/**
 * Environmental-effects orchestration extracted from
 * `WebGPUSceneRenderer`.
 *
 * Batch 134 of the audit-recommended SceneRenderer decomposition (see
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`,
 * SceneRenderer "post-process plumbing" candidate — environmental
 * effects are the leading slice of that work).
 *
 * Composites onto the rendered scene AFTER all geometry passes and
 * BEFORE post-processing. Order is fixed:
 *
 *   1. Procedural Clouds — volumetric ray-marched clouds
 *      (atmosphere-level, behind geometry).
 *   2. Screen-Space Reflections — surface reflections.
 *   3. Weather Particles — GPU compute rain/snow/fog/hail + render.
 *   4. Volumetric Fog — froxel-grid populate + composite (Phase 5a).
 *
 * Each stage is independently feature-gated:
 *   - Procedural Clouds: `globe.showProceduralClouds`.
 *   - SSR: `scene._enableSSR`.
 *   - Weather Particles: `scene._enableWeather`.
 *   - Volumetric Fog: `frameState.atmosphericConditions.volumetricFog.enabled`
 *     (default false, so unsubscribed users pay zero cost).
 *
 * Each stage is wrapped in its own try/catch so one failing effect
 * doesn't take down the rest of the chain — failures are logged via
 * `context.log("warn", ...)` and the default render pass resumes
 * even on the catch path so subsequent passes see a consistent state.
 *
 * The function takes ZERO `this.*` dependencies on the SceneRenderer,
 * so it's a pure free function over the render-frame config (verified
 * pre-extraction by grep).
 *
 * @module WebGPUSceneRendererEnvironmentalEffects
 */

import FeatureRendererKey from "../FeatureRendererKey.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/**
 * Run the environmental-effects chain for the current frame.
 *
 * @param config - The render-frame config emitted by `executeCommands`.
 *   `config.context` must have an active default render pass (the
 *   chain ends/resumes around effects that need to sample depth).
 */
export function executeEnvironmentalEffects(
  config: WebGPURenderFrameConfig,
): void {
  const { scene, context } = config;
  const globe = scene.globe;

  // Get texture views needed by all environmental effects
  const colorView: GPUTextureView | undefined =
    context._sceneColorView ?? context.currentTextureView;
  const depthView: GPUTextureView | undefined = context._depthStencilView;
  const outputView: GPUTextureView | undefined = context.currentTextureView;

  if (!colorView || !depthView || !outputView) {
    return;
  }

  const frameState = scene._frameState;

  // 1. Procedural Clouds — volumetric ray-marched clouds
  if (globe?.showProceduralClouds) {
    const cloudFR = context.getFeatureRenderer(
      FeatureRendererKey.PROCEDURAL_CLOUDS,
    );
    if (cloudFR?.execute) {
      try {
        // End render pass so shaders can sample the depth texture
        context.endCurrentRenderPass?.();
        cloudFR.execute(
          context,
          frameState,
          colorView,
          depthView,
          outputView,
          globe,
        );
        context.resumeDefaultRenderPass?.();
      } catch (e: unknown) {
        context.log?.(
          "warn",
          `Procedural clouds failed: ${(e as Error).message}`,
        );
        context.resumeDefaultRenderPass?.();
      }
    }
  }

  // 2. Screen-Space Reflections — ray-marched reflections
  if (scene._enableSSR) {
    const ssrFR = context.getFeatureRenderer(
      FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
    );
    if (ssrFR?.execute) {
      try {
        context.endCurrentRenderPass?.();
        ssrFR.execute(
          context,
          frameState,
          colorView,
          depthView,
          undefined, // normalTextureView — uses placeholder
          outputView,
          scene,
        );
        context.resumeDefaultRenderPass?.();
      } catch (e: unknown) {
        context.log?.("warn", `SSR failed: ${(e as Error).message}`);
        context.resumeDefaultRenderPass?.();
      }
    }
  }

  // 3. Weather Particles — GPU compute rain/snow/fog/hail + render
  if (scene._enableWeather) {
    const weatherFR = context.getFeatureRenderer(
      FeatureRendererKey.WEATHER_PARTICLES,
    );
    if (weatherFR?.update) {
      try {
        // Compute simulation (needs own command encoder)
        weatherFR.update(context, frameState, scene);

        // Render particles into the current scene render pass
        if (weatherFR.render) {
          const passEncoder = context.currentRenderPassEncoder;
          if (passEncoder) {
            weatherFR.render(context, frameState, scene, passEncoder);
          }
        }
      } catch (e: unknown) {
        context.log?.("warn", `Weather update failed: ${(e as Error).message}`);
      }
    }
  }

  // 4. Volumetric fog — Phase 5a infrastructure (no visual change).
  // Runs the three compute passes that populate the froxel grid (Phase
  // 5a kernels are placeholders that clear their outputs), then the
  // composite pass that samples the integrated 3D volume in screen UV +
  // linearized depth and writes the modulated scene color back. Per
  // B22, this runs AFTER opaque + OIT-resolved color and after the
  // other environmental effects, BEFORE post-processing.
  //
  // Gated on `atmosphericConditions.volumetricFog.enabled` (B18:
  // default FALSE) — the entire path is skipped when the toggle is
  // off, so unsubscribed users pay zero cost.
  const ac = frameState.atmosphericConditions;
  const vf = ac && ac.volumetricFog ? ac.volumetricFog : undefined;
  if (vf?.enabled === true) {
    const fogFR = context.getFeatureRenderer(FeatureRendererKey.VOLUMETRIC_FOG);
    if (fogFR?.update) {
      try {
        context.endCurrentRenderPass?.();
        fogFR.update(context, frameState, scene);
        if (fogFR.composite) {
          const fmt: GPUTextureFormat =
            context.presentationFormat || "bgra8unorm";
          fogFR.composite(
            context,
            frameState,
            colorView,
            depthView,
            outputView,
            fmt,
          );
        }
        context.resumeDefaultRenderPass?.();
      } catch (e: unknown) {
        context.log?.("warn", `Volumetric fog failed: ${(e as Error).message}`);
        context.resumeDefaultRenderPass?.();
      }
    }
  }
}
