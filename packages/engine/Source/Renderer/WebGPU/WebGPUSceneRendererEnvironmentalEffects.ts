/**
 * Environmental-effects orchestration for `WebGPUSceneRenderer`.
 *
 * Composites onto the post-processed scene snapshot after all geometry and
 * display-space post-processing passes. Order is fixed:
 *
 *   1. Procedural Clouds — volumetric ray-marched clouds
 *      (atmosphere-level, behind geometry).
 *   2. NPR outlines and contact shadows — optional screen-space overlays.
 *   3. Screen-Space Reflections — surface reflections.
 *   4. Weather Particles — GPU compute rain/snow/fog/hail + render.
 *   5. Volumetric Fog — froxel-grid populate + composite.
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
 * The function takes no `this` dependencies on the scene renderer, so it is a
 * pure free function over the render-frame config.
 *
 * @module WebGPUSceneRendererEnvironmentalEffects
 */

import FeatureRendererKey from "../FeatureRendererKey.js";
import type { VolumetricCloudRequest } from "../GraphicsContext.js";
import {
  beginCloudFrameAttempt,
  finishNegativeCloudFrameAttempt,
  publishCloudIblCoverage,
  reportCloudLifecycleError,
} from "./WebGPUProceduralCloudRenderer.js";
import {
  beginEnvironmentalEffectsComposition,
  commitEnvironmentalFullscreenStage,
  commitEnvironmentalInPlaceStage,
  presentEnvironmentalEffectsComposition,
  selectEnvironmentalWeatherRoute,
  type EnvironmentalCompositionState,
} from "./WebGPUEnvironmentalEffectsCompositor.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

export interface ResolvedCloudFramePlan {
  readonly frameNumber: number;
  readonly request: VolumetricCloudRequest | null;
  readonly config: CloudVolumetricsConfig | undefined;
  readonly active: boolean;
  readonly captureRequested: boolean;
}

export interface CloudFramePreparationOutcome {
  readonly kind: "prepared" | "negative";
  readonly plan: ResolvedCloudFramePlan;
  readonly maskView: GPUTextureView | null;
  readonly reason?: CloudFrameNegativeReason;
}

export type CloudFrameNegativeReason =
  | "feature-not-ready"
  | "missing-device"
  | "missing-encoder"
  | "missing-raw-color"
  | "missing-depth"
  | "culled"
  | "resource-not-ready"
  | "preparation-busy"
  | "encoder-mismatch"
  | "encoder-abandoned";

export type CloudFrameOutcomeNegativeReason =
  CloudFrameNegativeReason | "inactive" | "preparation-failed";

export interface ProceduralCloudFrameRenderer {
  prepareCloudFrameAndEncodeMask?(
    context: WebGPURenderFrameConfig["context"],
    frameState: CesiumFrameState,
    attempt: unknown,
    rawColorView: GPUTextureView,
    depthView: GPUTextureView,
    config: CloudVolumetricsConfig,
    captureRequested: boolean,
  ): unknown;
  isPreparedCloudFrame?(
    outcome: CloudFramePreparationOutcome,
    plan: ResolvedCloudFramePlan,
  ): boolean;
  completePreparedCloudMask?(outcome: CloudFramePreparationOutcome): void;
  executePreparedCloudFrame?(
    context: WebGPURenderFrameConfig["context"],
    frameState: CesiumFrameState,
    displayColorView: GPUTextureView,
    depthView: GPUTextureView,
    outputView: GPUTextureView,
    outcome: CloudFramePreparationOutcome,
  ): boolean;
  cancelPreparedCloudFrame?(outcome: CloudFramePreparationOutcome): void;
}

export interface EnvironmentalCloudFrameOutcome {
  readonly plan: ResolvedCloudFramePlan;
  readonly renderer: ProceduralCloudFrameRenderer | null;
  readonly preparation: CloudFramePreparationOutcome | null;
  readonly negativeReason: CloudFrameOutcomeNegativeReason | null;
  readonly displaySnapshotView: GPUTextureView | null;
}

export function isPreparedCloudFrameOutcome(
  outcome: EnvironmentalCloudFrameOutcome,
): boolean {
  return (
    outcome.preparation !== null &&
    outcome.renderer?.isPreparedCloudFrame?.(
      outcome.preparation,
      outcome.plan,
    ) === true &&
    typeof outcome.renderer?.executePreparedCloudFrame === "function"
  );
}

export function resolveCloudFramePlan(
  config: WebGPURenderFrameConfig,
  captureRequested: boolean,
): ResolvedCloudFramePlan {
  const { scene, context } = config;
  const frameState = scene._frameState;
  const request = context.consumeVolumetricCloudRequest();
  let chosenRequest: VolumetricCloudRequest | null = null;
  let cloudConfig: CloudVolumetricsConfig | undefined;

  if (request?.enabled === true) {
    chosenRequest = request;
    cloudConfig = request as unknown as CloudVolumetricsConfig;
  } else {
    const managed = (
      scene.globe as unknown as {
        defaultCloudCollection?: {
          renderMode?: number;
          volumetric?: { enabled?: boolean };
          _resolveVolumetricConfig?: () => CloudVolumetricsConfig;
        };
      }
    )?.defaultCloudCollection;
    if (
      managed?.renderMode === 1 &&
      managed.volumetric?.enabled === true &&
      managed._resolveVolumetricConfig
    ) {
      try {
        cloudConfig = managed._resolveVolumetricConfig();
      } catch (error: unknown) {
        reportCloudLifecycleError(
          context,
          "Managed cloud configuration resolution failed.",
          error,
        );
      }
    }
  }

  const active = cloudConfig !== undefined;
  return Object.freeze({
    frameNumber: frameState.frameNumber,
    request: chosenRequest,
    config: cloudConfig,
    active,
    captureRequested: active && captureRequested,
  });
}

export function beginResolvedCloudFrameAttempt(
  config: WebGPURenderFrameConfig,
  plan: ResolvedCloudFramePlan,
): unknown {
  return beginCloudFrameAttempt(config.context, config.scene._frameState, plan);
}

export function finishResolvedCloudFrameAttempt(
  attempt: unknown,
  reason: CloudFrameNegativeReason,
): unknown {
  return finishNegativeCloudFrameAttempt(attempt, reason);
}

export function publishResolvedCloudFrameIbl(
  config: WebGPURenderFrameConfig,
  plan: ResolvedCloudFramePlan,
): void {
  publishCloudIblCoverage(
    config.context,
    plan.active ? plan.config : undefined,
    config.scene._frameState,
  );
}

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
 * `scene.weather*` fields. These are the fields the
 * `atmosphericConditions.weather` facade writes and the automatic precipitation
 * master pushes, so this is the single control surface that drives the particle
 * renderer for both the manual and automatic paths.
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
    // scene surface only exposes type/intensity/wind. The renderer applies its
    // own `?? default` for every field below, so leaving them at their defaults
    // here is intentional.
    maxParticles: 50000,
    particleLifetime: 5.0,
    particleSize: 1.0,
    turbulence: 0.3,
    spawnRadius: 500,
    groundAltitude: 0,
    humidity: 0.5,
    // Data-driven extras. Undefined on the manual and automatic paths
    // (`applyAtmosphericConditions` sets these only when the `dataDriven` flag
    // is on); the renderer reads `?? 1` / `?? 0`, so an unset field is inert.
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
  cloudFrame: EnvironmentalCloudFrameOutcome,
): void {
  const { scene, context } = config;
  const frameState = scene._frameState;

  // Texture views needed by all environmental effects.
  //
  // The caller supplies this view only after copying the current post-processed
  // canvas into it. A missing view disables full-screen environmental stages;
  // they must not consume a previous frame's snapshot or raw scene color.
  const snapshotView = cloudFrame.displaySnapshotView ?? undefined;
  const depthView: GPUTextureView | undefined = context._depthStencilView;
  const outputView: GPUTextureView | undefined = context.currentTextureView;

  if (!depthView || !outputView) {
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
  const preparedCloud = isPreparedCloudFrameOutcome(cloudFrame);
  const fullscreenEffectDemand =
    preparedCloud ||
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
  if (preparedCloud && composition) {
    const cloudFR = cloudFrame.renderer;
    const preparation = cloudFrame.preparation;
    if (cloudFR?.executePreparedCloudFrame && preparation) {
      try {
        const recorded = cloudFR.executePreparedCloudFrame(
          context,
          frameState,
          composition.sourceView,
          depthView,
          composition.targetView,
          preparation,
        );
        commitEnvironmentalFullscreenStage(composition, recorded);
      } catch (e: unknown) {
        reportCloudLifecycleError(
          context,
          "Procedural cloud composite failed.",
          e,
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
  // It does not sample scene color, so when fog follows it draws in-place into
  // the graph's current side. With no following fog the fast path applies:
  // weather alone draws directly to the canvas with no ping texture or final
  // blit; when prior full-screen effects exist, they are presented once and
  // weather is appended to that same tail canvas pass.
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
