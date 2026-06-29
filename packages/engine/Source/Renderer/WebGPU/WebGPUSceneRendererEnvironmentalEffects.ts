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
import { publishCloudIblCoverage } from "./WebGPUProceduralCloudRenderer.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/**
 * Legacy flat `scene.weatherType` index → renderer particle-type string. Matches
 * the documented `0=rain, 1=snow, 2=fog, 3=hail` convention (see `Scene.js`
 * `weatherType` JSDoc) and the renderer's own `WEATHER_TYPES` map. Out-of-range
 * → `"rain"` (the renderer's own fallback). Kept local because it's the legacy
 * flat-field convention; the hierarchy's `PrecipitationType` (0=none) mapping
 * lives in `AtmosphericEffects.ts`.
 */
const WEATHER_TYPE_STRINGS: readonly string[] = ["rain", "snow", "fog", "hail"];

/**
 * Build the WebGPU weather renderer's `CesiumWeatherConfig` from the flat
 * `scene.weather*` fields (Phase E, Batch 423). These are the fields the
 * `atmosphericConditions.weather` facade writes and the 417a auto-master pushes,
 * so this is the single control surface that drives the particle renderer for
 * both the manual and automatic precipitation paths.
 *
 * @param scene - The Cesium scene carrying the flat weather fields.
 * @returns A `CesiumWeatherConfig` the renderer can read directly.
 */
function buildWeatherConfig(
  scene: WebGPURenderFrameConfig["scene"],
): CesiumWeatherConfig {
  const typeIndex = scene.weatherType ?? 0;
  const wind = scene.weatherWindDirection;
  return {
    enabled: scene._enableWeather === true,
    type: WEATHER_TYPE_STRINGS[typeIndex] ?? "rain",
    intensity: scene.weatherIntensity ?? 0.5,
    windSpeed: scene.weatherWindSpeed ?? 10.0,
    windDirection: {
      x: wind?.x ?? 1,
      y: wind?.y ?? 0,
      z: wind?.z ?? 0,
    } as CesiumCartesian3,
    // Remaining tuning fields keep the renderer's built-in defaults — the flat
    // scene surface only exposes type/intensity/wind today. The renderer applies
    // its own `?? default` for every field below, so leaving them at their
    // defaults here is intentional (and matches the pre-Phase-E config shape).
    maxParticles: 50000,
    particleLifetime: 5.0,
    particleSize: 1.0,
    turbulence: 0.3,
    spawnRadius: 500,
    groundAltitude: 0,
    humidity: 0.5,
  };
}

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

  // Item 4.2 (CLOUD-IBL, Batch 441) — publish the effective cloud coverage the
  // dynamic-env-map sky fill darkens + flattens its radiance toward. Done FIRST,
  // before the view-availability early-return and the cloud-render gate, so it
  // tracks the globe's flags every frame (resets to 0 when clouds /
  // cloudContributesIBL are off → the env fill stays byte-identical).
  publishCloudIblCoverage(
    context,
    globe as unknown as
      | {
          showProceduralClouds?: boolean;
          cloudContributesIBL?: boolean;
          cloudCoverage?: number;
          cloudDensity?: number;
        }
      | undefined,
  );

  // Get texture views needed by all environmental effects.
  //
  // Slice 5c-B Batch 129 — `colorView` (the SOURCE that env effects
  // sample for reflection / composite-base / cloud-blend) now comes
  // from the post-process snapshot — a copyTextureToTexture mirror
  // of the canvas AFTER post-process ran (PostFrustumChain). So env
  // effects sample display-space, tonemapped, FXAA'd color, the same
  // color the viewer sees. Pre-Batch-129 they sampled the raw HDR
  // scene FB which produced color-space-mismatched reflections /
  // cloud composites. Falls back to scene color view in early frames
  // before the snapshot is allocated.
  const ctxAny = context as unknown as {
    _postProcessSnapshotView?: GPUTextureView | null;
  };
  const colorView: GPUTextureView | undefined =
    ctxAny._postProcessSnapshotView ??
    context._sceneColorView ??
    context.currentTextureView;
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

  // Slice 5c-B Batch 123 — NPR outlines. Runs BEFORE SSR so silhouette
  // edges don't get partially eaten by reflection compositing. Reads
  // G-buffer slot 1 + scene depth, paints edges over scene color.
  if (
    (scene as unknown as { _enableNPROutlines?: boolean })._enableNPROutlines
  ) {
    const nprFR = context.getFeatureRenderer(FeatureRendererKey.NPR_OUTLINES);
    const sceneAny = scene as unknown as {
      _view?: {
        gBufferFramebuffer?: {
          normalRoughnessTexture: GPUTextureView | null;
        };
      };
    };
    const nprNormalView =
      sceneAny._view?.gBufferFramebuffer?.normalRoughnessTexture ?? null;
    if (nprFR?.execute && nprNormalView) {
      try {
        context.endCurrentRenderPass?.();
        nprFR.execute(
          context,
          frameState,
          colorView,
          depthView,
          nprNormalView,
          outputView,
          scene,
        );
        context.resumeDefaultRenderPass?.();
      } catch (e: unknown) {
        context.log?.("warn", `NPR outlines failed: ${(e as Error).message}`);
        context.resumeDefaultRenderPass?.();
      }
    }
  }

  // Slice 5c-B Batch 133 — Contact shadows. Runs BEFORE SSR so the
  // reflection compositing on top includes the shadow darkening at
  // grounded objects (foliage bases, vehicle wheels meeting road,
  // building bases meeting terrain). Skipped when the G-buffer
  // normal view isn't allocated yet.
  if (
    (scene as unknown as { _enableContactShadows?: boolean })
      ._enableContactShadows
  ) {
    const csFR = context.getFeatureRenderer(FeatureRendererKey.CONTACT_SHADOWS);
    const sceneCS = scene as unknown as {
      _view?: {
        gBufferFramebuffer?: {
          normalRoughnessTexture: GPUTextureView | null;
        };
      };
    };
    const csNormalView =
      sceneCS._view?.gBufferFramebuffer?.normalRoughnessTexture ?? null;
    if (csFR?.execute && csNormalView) {
      try {
        context.endCurrentRenderPass?.();
        csFR.execute(
          context,
          frameState,
          colorView,
          depthView,
          csNormalView,
          outputView,
          scene,
        );
        context.resumeDefaultRenderPass?.();
      } catch (e: unknown) {
        context.log?.(
          "warn",
          `Contact shadows failed: ${(e as Error).message}`,
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
        // Slice 5c-B Batch 122 — drop the legacy `useDeferredLighting`
        // gate. The G-buffer is now always allocated (Sub-B, Batch 115b)
        // and populated by per-shader @location(1) emits (Batches 117-121:
        // globe, model + B3DM, ellipsoid, Lit Mat primitives). The SSR
        // shader's sentinel check at L224 (length(normalSample) < 0.1)
        // skips fragments that came from non-emitting Phase 1 pipelines
        // (sky, billboards, labels) — they used to be filled by the
        // compute producer's depth-derived path; now they keep the
        // load-op clear sentinel (0,0,0,1) and SSR falls back to per-
        // fragment depth-derivative normals at those pixels via the
        // flags.x=0 path inside the shader.
        //
        // Why this matters: SSR now reads REAL per-fragment material
        // normals at globe + model + ellipsoid + Lit Mat pixels (the
        // entire surface area you'd actually want reflections on),
        // regardless of whether the scene has scene.deferredLighting
        // enabled. The deferredLighting flag was a producer-era proxy
        // for "is the G-buffer populated"; that flag is now obsolete.
        const sceneAny = scene as unknown as {
          _view?: {
            gBufferFramebuffer?: {
              normalRoughnessTexture: GPUTextureView | null;
            };
          };
        };
        const gBufferNormalView =
          sceneAny._view?.gBufferFramebuffer?.normalRoughnessTexture ??
          undefined;
        ssrFR.execute(
          context,
          frameState,
          colorView,
          depthView,
          gBufferNormalView,
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
        // Phase E (Batch 423) — build the renderer's `CesiumWeatherConfig` from
        // the flat `scene.weather*` fields. The renderer reads its config off the
        // object passed here (`weatherConfig.enabled/type/intensity/…`); the flat
        // fields are the SAME ones the `atmosphericConditions.weather` facade
        // writes (and the auto-master pushes), so this is the single control
        // surface for both the manual and automatic precip paths. Passing `scene`
        // directly (pre-Batch-423) read `scene.enabled`/`scene.type` — which
        // don't exist — so the renderer's `enabled` gate always returned early
        // and no particles ever rendered.
        const weatherConfig = buildWeatherConfig(scene);

        // Compute simulation (needs own command encoder)
        weatherFR.update(context, frameState, weatherConfig);

        // Render particles into the default (canvas) render pass. Phase E
        // (Batch 423): env effects run AFTER post-process (Batch 127), and the
        // post-frustum chain ENDS the active render pass before this chain runs
        // (the snapshot copyTextureToTexture at PostFrustumChain:255 fires
        // whenever any env effect — including weather — is enabled). So
        // `currentRenderPassEncoder` is null here; the weather render half must
        // OPEN its own pass like the other compositing effects do. We resume the
        // default canvas pass with loadOp:"load" (preserving the post-processed
        // scene) and draw the camera-relative particle quads on top. Without
        // this, the compute simulation ran every frame but nothing was ever
        // drawn (renderInitialized stayed false).
        if (weatherFR.render) {
          let passEncoder = context.currentRenderPassEncoder;
          if (!passEncoder) {
            passEncoder = context.resumeDefaultRenderPass?.() ?? null;
          }
          if (passEncoder) {
            weatherFR.render(context, frameState, weatherConfig, passEncoder);
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
  //
  // Batch 420 — GROUND FOG owns its own activation path: when
  // `atmosphericConditions.effects.groundFog.enabled` is true the froxel
  // fog must run (to render the near-surface mist) EVEN IF the general
  // `volumetricFog.enabled` master is off (ground fog implies fog). So the
  // call-site gate fires on EITHER condition; the renderer's `update()` /
  // `composite()` apply the same OR-gate internally and supply base-fog
  // defaults when only ground fog is driving.
  const ac = frameState.atmosphericConditions;
  const vf = ac && ac.volumetricFog ? ac.volumetricFog : undefined;
  const groundFogActive = ac?.effects?.groundFog?.enabled === true;
  if (vf?.enabled === true || groundFogActive) {
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
