/**
 * Environmental-effects orchestration extracted from
 * `WebGPUSceneRenderer`.
 *
 * Batch 134 of the audit-recommended SceneRenderer decomposition (see
 * `migration_doc/WEBGPU_CONTEXT_DECOMPOSITION_PLAN.md`,
 * SceneRenderer "post-process plumbing" candidate — environmental
 * effects are the leading slice of that work).
 *
 * Composites onto the post-processed scene snapshot AFTER all geometry and
 * display-space post-processing passes. Order is fixed:
 *
 *   1. Procedural Clouds — volumetric ray-marched clouds
 *      (atmosphere-level, behind geometry).
 *   2. NPR outlines and contact shadows — optional screen-space overlays.
 *   3. Screen-Space Reflections — surface reflections.
 *   4. Weather Particles — GPU compute rain/snow/fog/hail + render.
 *   5. Volumetric Fog — froxel-grid populate + composite (Phase 5a).
 *
 * Each stage is independently feature-gated:
 *   - Procedural Clouds: a VOLUMETRIC `CloudCollection` (the managed
 *     `globe.defaultCloudCollection` or a user collection).
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
import {
  beginEnvironmentalEffectsComposition,
  commitEnvironmentalFullscreenStage,
  commitEnvironmentalInPlaceStage,
  presentEnvironmentalEffectsComposition,
  selectEnvironmentalWeatherRoute,
  type EnvironmentalCompositionState,
} from "./WebGPUEnvironmentalEffectsCompositor.js";
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
    // PRECIP-DATA (Batch 444) — data-driven extras. Undefined in the manual/auto
    // path (applyAtmosphericConditions only sets these when the `dataDriven` flag
    // is on); the renderer reads `?? 1` / `?? 0`, so the OFF path is unchanged.
    densityScale: scene.weatherDensityScale,
    snowCover: scene.weatherSnowCover,
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
  const frameState = scene._frameState;

  // Item 4.2 (CLOUD-IBL, Batch 441) — publish the effective cloud coverage the
  // dynamic-env-map sky fill darkens + flattens its radiance toward. Done FIRST,
  // before the view-availability early-return and the cloud-render gate, so it
  // tracks the globe's flags every frame (resets to 0 when clouds /
  // cloudContributesIBL are off → the env fill stays byte-identical).
  // CLOUD-U2-CONFIG-INDIRECTION — `publishCloudIblCoverage` now takes a
  // structural `CloudVolumetricsConfig` (identical field names to `globe.cloud*`),
  // so the globe passes through directly with no inline cast. Behavior is
  // byte-identical — same object, same fields, same `?? default` reads.
  //
  // Cloud-unification epic slice 3 — consume the frame's volumetric cloud
  // request published by a VOLUMETRIC CloudCollection (first one wins; see
  // CloudCollection.update / GraphicsContext#requestVolumetricClouds). Consumed
  // UNCONDITIONALLY here — even when the request is ignored — so a stale request
  // never leaks into the next frame. When no collection publishes, `cloudConfig`
  // is `undefined` and `publishCloudIblCoverage` resets the IBL coverage to 0
  // (byte-identical clear-sky env source).
  const collectionRequest = context.consumeVolumetricCloudRequest();
  let useCollectionDeck =
    collectionRequest !== undefined && collectionRequest.enabled === true;
  let cloudConfig: CloudVolumetricsConfig | undefined = useCollectionDeck
    ? (collectionRequest as unknown as CloudVolumetricsConfig)
    : undefined;

  // Cloud-unification epic slice 4A/4B — when no USER-added VOLUMETRIC collection
  // published a deck this frame, fall back to the Scene/Globe MANAGED default
  // cloud collection (`globe.defaultCloudCollection`). Its `.volumetric` config
  // is the single source of truth for the `atmosphericConditions` cloud facade,
  // the atmospheric-effects genus bias, and the weather ingest. It only drives a
  // deck when its exclusive `renderMode` is VOLUMETRIC (=== 1) AND
  // `volumetric.enabled`; otherwise no deck is active and `cloudConfig` stays
  // `undefined` (the `globe.showProceduralClouds` field was removed in 4B).
  if (!useCollectionDeck) {
    const managed = (
      globe as unknown as {
        defaultCloudCollection?: {
          renderMode?: number;
          volumetric?: { enabled?: boolean };
          _resolveVolumetricConfig?: () => CloudVolumetricsConfig;
        };
      }
    )?.defaultCloudCollection;
    if (
      managed?.renderMode === 1 && // CloudRenderMode.VOLUMETRIC
      managed.volumetric?.enabled === true &&
      managed._resolveVolumetricConfig
    ) {
      cloudConfig = managed._resolveVolumetricConfig();
      useCollectionDeck = true;
    }
  }
  publishCloudIblCoverage(context, cloudConfig, frameState);

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
  const snapshotView = ctxAny._postProcessSnapshotView ?? undefined;
  const colorView: GPUTextureView | undefined =
    snapshotView ?? context._sceneColorView ?? context.currentTextureView;
  const depthView: GPUTextureView | undefined = context._depthStencilView;
  const outputView: GPUTextureView | undefined = context.currentTextureView;

  if (!colorView || !depthView || !outputView) {
    return;
  }

  // The post-frustum snapshot copy normally leaves no pass active. End one
  // defensively once here, then keep every offscreen effect on the shared frame
  // encoder. The canvas is resumed at most once, at the composition tail.
  context.endCurrentRenderPass?.();

  const sceneAny = scene as unknown as {
    _enableNPROutlines?: boolean;
    _enableContactShadows?: boolean;
    _view?: {
      gBufferFramebuffer?: {
        normalRoughnessTexture: GPUTextureView | null;
      };
    };
  };
  const normalView =
    sceneAny._view?.gBufferFramebuffer?.normalRoughnessTexture ?? null;
  const ac = frameState.atmosphericConditions;
  const vf = ac?.volumetricFog;
  const groundFogActive = ac?.effects?.groundFog?.enabled === true;
  const fogActive = vf?.enabled === true || groundFogActive;
  const fullscreenEffectDemand =
    useCollectionDeck ||
    (sceneAny._enableNPROutlines === true && normalView !== null) ||
    (sceneAny._enableContactShadows === true && normalView !== null) ||
    scene._enableSSR === true ||
    fogActive;

  // Only the real post-process snapshot has the RENDER_ATTACHMENT usage needed
  // to serve as side A. A missing snapshot is an early-frame readiness case;
  // full-screen effects wait rather than sample/render aliasing the canvas.
  let composition: EnvironmentalCompositionState | null =
    fullscreenEffectDemand && snapshotView
      ? beginEnvironmentalEffectsComposition(context, snapshotView)
      : null;
  let compositionPresented = false;

  // 1. Procedural clouds. Every full-screen stage consumes the previous graph
  // result and writes the opposite texture. A culled/not-ready stage returns
  // false and therefore does not advance the graph.
  if (useCollectionDeck && composition) {
    const cloudFR = context.getFeatureRenderer(
      FeatureRendererKey.PROCEDURAL_CLOUDS,
    );
    if (cloudFR?.execute) {
      try {
        const recorded =
          (cloudFR.execute as unknown as (...args: unknown[]) => unknown)(
            context,
            frameState,
            composition.sourceView,
            depthView,
            composition.targetView,
            cloudConfig,
          ) === true;
        commitEnvironmentalFullscreenStage(composition, recorded);
      } catch (e: unknown) {
        context.log?.(
          "warn",
          `Procedural clouds failed: ${(e as Error).message}`,
        );
      }
    }
  }

  // 2. NPR outlines, then contact shadows, then SSR. This preserves the
  // established visual order while making each stage see the prior result.
  if (sceneAny._enableNPROutlines === true && normalView && composition) {
    const nprFR = context.getFeatureRenderer(FeatureRendererKey.NPR_OUTLINES);
    if (nprFR?.execute) {
      try {
        const recorded =
          (nprFR.execute as unknown as (...args: unknown[]) => unknown)(
            context,
            frameState,
            composition.sourceView,
            depthView,
            normalView,
            composition.targetView,
            scene,
          ) === true;
        commitEnvironmentalFullscreenStage(composition, recorded);
      } catch (e: unknown) {
        context.log?.("warn", `NPR outlines failed: ${(e as Error).message}`);
      }
    }
  }

  if (sceneAny._enableContactShadows === true && normalView && composition) {
    const contactFR = context.getFeatureRenderer(
      FeatureRendererKey.CONTACT_SHADOWS,
    );
    if (contactFR?.execute) {
      try {
        const recorded =
          (contactFR.execute as unknown as (...args: unknown[]) => unknown)(
            context,
            frameState,
            composition.sourceView,
            depthView,
            normalView,
            composition.targetView,
            scene,
          ) === true;
        commitEnvironmentalFullscreenStage(composition, recorded);
      } catch (e: unknown) {
        context.log?.(
          "warn",
          `Contact shadows failed: ${(e as Error).message}`,
        );
      }
    }
  }

  if (scene._enableSSR && composition) {
    const ssrFR = context.getFeatureRenderer(
      FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
    );
    if (ssrFR?.execute) {
      try {
        const recorded =
          (ssrFR.execute as unknown as (...args: unknown[]) => unknown)(
            context,
            frameState,
            composition.sourceView,
            depthView,
            normalView ?? undefined,
            composition.targetView,
            scene,
          ) === true;
        commitEnvironmentalFullscreenStage(composition, recorded);
      } catch (e: unknown) {
        context.log?.("warn", `SSR failed: ${(e as Error).message}`);
      }
    }
  }

  // 3. Weather geometry has an explicit composition point between SSR and fog.
  // It does not sample scene color, so with fog after it we draw in-place into
  // the graph's current side. With no following fog, retain the fast path:
  // weather-only draws directly to canvas with no ping texture/final blit; if
  // prior full-screen effects exist, present them once and append weather to
  // that same tail canvas pass.
  if (scene._enableWeather) {
    const weatherFR = context.getFeatureRenderer(
      FeatureRendererKey.WEATHER_PARTICLES,
    );
    if (weatherFR?.update) {
      try {
        const weatherConfig = buildWeatherConfig(scene);
        weatherFR.update(context, frameState, weatherConfig);
        if (weatherFR.render) {
          const weatherRoute = selectEnvironmentalWeatherRoute(
            fogActive,
            composition !== null,
            composition?.wrote === true,
          );
          if (weatherRoute === "offscreen-before-fog" && composition) {
            const weatherContext = context as unknown as {
              _depthTextureView?: GPUTextureView | null;
              depthFormat?: GPUTextureFormat;
            };
            const weatherDepth = weatherContext._depthTextureView;
            if (weatherDepth && composition.sourceView) {
              const depthFormat =
                weatherContext.depthFormat ?? "depth24plus-stencil8";
              const depthAttachment: GPURenderPassDepthStencilAttachment = {
                view: weatherDepth,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
              };
              if (depthFormat.includes("stencil")) {
                depthAttachment.stencilClearValue = 0;
                depthAttachment.stencilLoadOp = "clear";
                depthAttachment.stencilStoreOp = "store";
              }
              const pass = context.beginRenderPass({
                label: "EnvironmentalEffects weather composition pass",
                colorAttachments: [
                  {
                    view: composition.sourceView,
                    loadOp: "load",
                    storeOp: "store",
                  },
                ],
                depthStencilAttachment: depthAttachment,
              });
              if (pass) {
                const recorded =
                  (
                    weatherFR.render as unknown as (
                      ...args: unknown[]
                    ) => unknown
                  )(context, frameState, weatherConfig, pass) === true;
                context.endCurrentRenderPass();
                commitEnvironmentalInPlaceStage(composition, recorded);
              }
            }
          } else {
            if (weatherRoute === "present-then-canvas" && composition) {
              compositionPresented = presentEnvironmentalEffectsComposition(
                context,
                composition,
              );
            }
            const priorCompositionReady =
              composition?.wrote !== true || compositionPresented;
            if (priorCompositionReady) {
              const pass =
                context.currentRenderPassEncoder ??
                context.resumeDefaultRenderPass();
              if (pass) {
                (
                  weatherFR.render as unknown as (...args: unknown[]) => unknown
                )(context, frameState, weatherConfig, pass);
              }
            }
          }
        }
      } catch (e: unknown) {
        context.endCurrentRenderPass?.();
        context.log?.("warn", `Weather update failed: ${(e as Error).message}`);
      }
    }
  }

  // 4. Volumetric fog consumes the fully accumulated clouds/outlines/contact/
  // SSR/weather result. Its compute passes and composite stay on the frame
  // encoder; only the composite advances the texture graph.
  if (fogActive && composition) {
    const fogFR = context.getFeatureRenderer(FeatureRendererKey.VOLUMETRIC_FOG);
    if (fogFR?.update) {
      try {
        fogFR.update(context, frameState, scene);
        if (fogFR.composite) {
          const recorded =
            (fogFR.composite as unknown as (...args: unknown[]) => unknown)(
              context,
              frameState,
              composition.sourceView,
              depthView,
              composition.targetView,
              context.presentationFormat || "bgra8unorm",
            ) === true;
          commitEnvironmentalFullscreenStage(composition, recorded);
        }
      } catch (e: unknown) {
        context.log?.("warn", `Volumetric fog failed: ${(e as Error).message}`);
      }
    }
  }

  if (composition && !compositionPresented) {
    presentEnvironmentalEffectsComposition(context, composition);
  }
}
