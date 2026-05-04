/**
 * WebGPU Post-Process Stage Collection
 *
 * Integration layer that connects PostProcessStageCollection.js to the
 * WebGPUPostProcessPipeline infrastructure.
 *
 * This module has two roles:
 *
 * 1. **Feature renderer sync** (`updateWebGPUPostProcessStages`):
 *    Called by PostProcessStageCollection.update() via the feature renderer
 *    pattern (FeatureRendererKey.POST_PROCESS_COLLECTION). Caches the enabled/
 *    disabled state so the pipeline can read it without touching scene-layer objects.
 *
 * 2. **Pipeline configuration** (`configureWebGPUPostProcessPipeline`):
 *    Called by WebGPUSceneRenderer._ensureResources() to lazily initialize
 *    WebGPU effects (bloom, AO, DoF) on the pipeline when first enabled,
 *    and to sync enable/disable state each frame.
 *
 * Effects are fullscreen image-space operations — they apply to everything
 * in the rendered scene buffer (terrain, 3D tiles, Gaussian splats, models, etc.)
 * after the scene is composited. Users control them via the standard CesiumJS API:
 *
 *   scene.postProcessStages.fxaa.enabled = true;
 *   scene.postProcessStages.bloom.enabled = true;
 *   scene.postProcessStages.ambientOcclusion.enabled = true;
 *
 * @module WebGPUPostProcessStageCollection
 */

import {
  WebGPUPostProcessPipeline,
  TonemapMode,
} from "./WebGPUPostProcessPipeline.js";
import oneTimeWarning from "../../Core/oneTimeWarning.js";

export interface PostProcessCache {
  initialized: boolean;
  fxaaEnabled: boolean;
  tonemappingEnabled: boolean;
  tonemapMode: number;
  ambientOcclusionEnabled: boolean;
  bloomEnabled: boolean;
  depthOfFieldEnabled: boolean;
  // Audit A.11 (Batch 133) -- GodRay (volumetric light scattering)
  // post-process. Activated via `scene.godRayEnabled = true` (optional
  // `scene.godRayConfig`); the per-frame configure pass updates the
  // sun screen UV from `scene.sun.position` projected through
  // viewProjection.
  godRayEnabled: boolean;
  godRayInitialized: boolean;
  // Track whether complex effects have been initialized on the pipeline
  bloomInitialized: boolean;
  aoInitialized: boolean;
  dofInitialized: boolean;
  // Track bloom/AO uniform values for dirty checking
  bloomThreshold: number;
  bloomIntensity: number;
  aoIntensity: number;
  aoBias: number;
}

function getDefaultCache(): PostProcessCache {
  return {
    initialized: false,
    fxaaEnabled: false,
    tonemappingEnabled: true,
    tonemapMode: TonemapMode.REINHARD,
    ambientOcclusionEnabled: false,
    bloomEnabled: false,
    depthOfFieldEnabled: false,
    godRayEnabled: false,
    godRayInitialized: false,
    bloomInitialized: false,
    aoInitialized: false,
    dofInitialized: false,
    bloomThreshold: 0.8,
    bloomIntensity: 0.5,
    aoIntensity: 3.0,
    aoBias: 0.1,
  };
}

/**
 * Map CesiumJS Tonemapper enum to our WebGPU tonemapping mode.
 * CesiumJS: REINHARD=0, MODIFIED_REINHARD=1, FILMIC=2, ACES=3, PBR_NEUTRAL=4
 */
function mapTonemapType(collection: CesiumObjectWithWebGPUCache): number {
  const type = collection._tonemapping?.type ?? collection._tonemappingType;
  switch (type) {
    case 0:
      return TonemapMode.REINHARD;
    case 1:
      return TonemapMode.MODIFIED_REINHARD;
    case 2:
      return TonemapMode.FILMIC;
    case 3:
      return TonemapMode.ACES;
    case 4:
      return TonemapMode.PBR_NEUTRAL;
    default:
      return TonemapMode.PBR_NEUTRAL; // CesiumJS default
  }
}

/**
 * Feature renderer sync — called by PostProcessStageCollection.update()
 * via FeatureRendererKey.POST_PROCESS_COLLECTION.
 *
 * Caches the current enabled/disabled state of all post-processing stages.
 * Does NOT touch the WebGPU pipeline — that's configureWebGPUPostProcessPipeline's job.
 */
function updateWebGPUPostProcessStages(
  collection: CesiumObjectWithWebGPUCache,
  frameState: CesiumFrameState,
): void {
  if (!collection._webgpuCache) {
    collection._webgpuCache = getDefaultCache();
  }

  const cache = collection._webgpuCache as PostProcessCache;

  // Read current state from the CesiumJS collection
  cache.fxaaEnabled = collection.fxaa?.enabled ?? false;
  cache.tonemappingEnabled = collection._tonemapping?.enabled ?? true;
  cache.tonemapMode = mapTonemapType(collection);
  cache.bloomEnabled = collection.bloom?.enabled ?? false;
  cache.ambientOcclusionEnabled = collection.ambientOcclusion?.enabled ?? false;
  cache.depthOfFieldEnabled = collection._depthOfField?.enabled ?? false;

  // Cache bloom/AO uniform values for runtime update
  if (cache.bloomEnabled) {
    const bloom = collection.bloom;
    cache.bloomThreshold = bloom?.uniforms?.brightness ?? 0.8;
    cache.bloomIntensity = bloom?.uniforms?.glowOnly ? 1.0 : 0.5;
  }
  if (cache.ambientOcclusionEnabled) {
    const ao = collection.ambientOcclusion;
    cache.aoIntensity = ao?.uniforms?.intensity ?? 3.0;
    cache.aoBias = ao?.uniforms?.bias ?? 0.1;
  }

  // AUDIT_2026_05_02 A.13 — surface that user-added PostProcessStage
  // instances aren't yet honored on WebGPU. We walk built-in named slots
  // above; the user-added `_stages` array (where `scene.postProcessStages.add(...)`
  // entries land) is currently silently dropped. Warn once per process.
  //>>includeStart('debug', pragmas.debug);
  const userStages = (collection as unknown as { _stages?: unknown[] })._stages;
  if (Array.isArray(userStages)) {
    let userStageCount = 0;
    for (const s of userStages) {
      if (s !== undefined && s !== null) userStageCount++;
    }
    if (userStageCount > 0) {
      oneTimeWarning(
        "WebGPUPostProcessStageCollection.userStages",
        `${userStageCount} user-added PostProcessStage instance(s) detected on a ` +
          "WebGPU scene. User custom GLSL stages are not yet executed on the WebGPU " +
          "backend; only built-in named slots (fxaa, bloom, ambientOcclusion, " +
          "depthOfField, tonemapping) are honored. Track AUDIT_2026_05_02 A.13.",
      );
    }
  }
  //>>includeEnd('debug');

  collection._activeStagesChanged = false;
  cache.initialized = true;
}

/**
 * Configure the WebGPU post-process pipeline based on cached collection state.
 * Called by WebGPUSceneRenderer._ensureResources() each frame.
 *
 * Lazily initializes complex effects (bloom, AO, DoF) on the pipeline when
 * they are first enabled. Syncs enabled/disabled state and tonemapping mode.
 *
 * @param pipeline - The WebGPU post-process pipeline
 * @param collection - The CesiumJS PostProcessStageCollection
 * @param device - The GPU device
 * @param canvasFormat - The canvas texture format
 */
function configureWebGPUPostProcessPipeline(
  pipeline: WebGPUPostProcessPipeline,
  collection: CesiumPostProcessStageCollection,
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  scene?: CesiumScene,
): void {
  const cache = (collection._webgpuCache ??
    getDefaultCache()) as PostProcessCache;

  // Audit A.11 (Batch 133) -- GodRay enabled flag, scene-level (no
  // upstream PostProcessStageCollection slot exists for this fork
  // addition). Mirrors the `scene.taaEnabled` pattern.
  cache.godRayEnabled =
    (scene as unknown as { godRayEnabled?: boolean })?.godRayEnabled === true;

  // --- TAA (controlled by scene.taaEnabled, not the collection) ---
  const taaEnabled = scene?.taaEnabled === true;
  pipeline.setStageEnabled("TAA", taaEnabled);
  // When TAA is active, disable FXAA (TAA provides superior AA).
  const fxaaEnabled = taaEnabled ? false : cache.fxaaEnabled;

  // --- FXAA ---
  pipeline.setStageEnabled("FXAA", fxaaEnabled);

  // --- Tonemapping ---
  pipeline.setStageEnabled("Tonemap", cache.tonemappingEnabled);
  pipeline.setTonemappingMode(cache.tonemapMode);

  // --- Bloom: lazily initialize on first enable ---
  if (cache.bloomEnabled && !cache.bloomInitialized) {
    const bloom = collection.bloom;
    pipeline.addBloom(device, canvasFormat, {
      threshold: bloom?.uniforms?.brightness ?? 0.8,
      intensity: bloom?.uniforms?.glowOnly ? 1.0 : 0.5,
      sigma: bloom?.uniforms?.sigma ?? 3.5,
      glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
    });
    cache.bloomInitialized = true;
  }
  pipeline.setStageEnabled("Bloom", cache.bloomEnabled);

  // Update bloom config if it changed
  if (cache.bloomEnabled && pipeline.bloomEffect) {
    const bloom = collection.bloom;
    const newThreshold = bloom?.uniforms?.brightness ?? 0.8;
    const newIntensity = bloom?.uniforms?.glowOnly ? 1.0 : 0.5;
    if (
      newThreshold !== cache.bloomThreshold ||
      newIntensity !== cache.bloomIntensity
    ) {
      pipeline.bloomEffect.updateConfig({
        threshold: newThreshold,
        intensity: newIntensity,
        glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
      });
      cache.bloomThreshold = newThreshold;
      cache.bloomIntensity = newIntensity;
    }
  }

  // --- Ambient Occlusion: lazily initialize on first enable ---
  if (cache.ambientOcclusionEnabled && !cache.aoInitialized) {
    const ao = collection.ambientOcclusion;
    // AUDIT_2026_05_02 B.13 — read `algorithm` from user uniforms so
    // GTAO is reachable without monkey-patching. Falls back to "hbao"
    // when unset for backwards compatibility.
    const rawAlgo = ao?.uniforms?.algorithm;
    const algorithm =
      rawAlgo === "gtao" || rawAlgo === "hbao" ? rawAlgo : "hbao";
    pipeline.addAmbientOcclusion(device, canvasFormat, {
      algorithm,
      intensity: ao?.uniforms?.intensity ?? 3.0,
      bias: ao?.uniforms?.bias ?? 0.1,
      lengthCap: ao?.uniforms?.lengthCap ?? 0.26,
      stepCount: ao?.uniforms?.stepSize ?? 4,
      directionCount: ao?.uniforms?.directionCount ?? 4,
      ambientOcclusionOnly: Boolean(
        ao?.uniforms?.ambientOcclusionOnly ?? false,
      ),
    });
    cache.aoInitialized = true;
  }
  pipeline.setStageEnabled("AmbientOcclusion", cache.ambientOcclusionEnabled);

  // --- Depth of Field: lazily initialize on first enable ---
  if (cache.depthOfFieldEnabled && !cache.dofInitialized) {
    const dof = collection._depthOfField;
    pipeline.addDepthOfField(device, canvasFormat, {
      focalDistance: dof?.uniforms?.focalDistance ?? 50.0,
      focalRange: dof?.uniforms?.delta ?? 20.0,
      blurSigma: dof?.uniforms?.sigma ?? 4.0,
    });
    cache.dofInitialized = true;
  }
  pipeline.setStageEnabled("DepthOfField", cache.depthOfFieldEnabled);

  // Audit A.11 (Batch 133) -- GodRay lazy init + per-frame sun UV
  // update. Config can be supplied via `scene.godRayConfig` (optional).
  // Skip when the scene has no sun configured -- the effect needs the
  // sun's screen-space position to draw the radial blur direction.
  if (cache.godRayEnabled && !cache.godRayInitialized) {
    const cfg = (
      scene as unknown as {
        godRayConfig?: import("./WebGPUGodRayEffect.js").GodRayConfig;
      }
    )?.godRayConfig;
    pipeline.addGodRay(device, canvasFormat, cfg);
    cache.godRayInitialized = true;
  }
  pipeline.setStageEnabled("GodRay", false); // GodRay isn't a `_stage` slot
  if (cache.godRayEnabled && pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = true;
    updateGodRaySunUV(pipeline, scene);
  } else if (pipeline.godRayEffect) {
    pipeline.godRayEffect.enabled = false;
  }
}

// Audit A.11 (Batch 133) -- per-frame sun screen-space UV computed
// by projecting `scene.sun.position` (or the directional sun direction
// when no Sun primitive is configured) through the camera's
// viewProjection matrix and converting NDC -> UV. Off-screen suns
// emit UVs outside [0, 1]; the GodRay shader still produces a
// directional glow across the visible region.
const _godRayScratchClip = new Float64Array(4);
function updateGodRaySunUV(
  pipeline: WebGPUPostProcessPipeline,
  scene?: CesiumScene,
): void {
  const fx = pipeline.godRayEffect;
  if (!fx) return;
  const us = (
    scene as unknown as {
      context?: { uniformState?: unknown };
    }
  )?.context?.uniformState as
    | {
        viewProjection?: number[] | Float64Array;
        sunPositionWC?: { x: number; y: number; z: number };
        sunDirectionWC?: { x: number; y: number; z: number };
        currentFrustum?: { x: number; y: number };
      }
    | undefined;
  if (!us || !us.viewProjection) return;
  const vp = us.viewProjection;
  // Use sun position when available; else extrapolate the sun direction
  // far enough to project off the camera (constant 1.5e8 km mirrors the
  // Earth-sun distance scale).
  let sx: number;
  let sy: number;
  let sz: number;
  if (us.sunPositionWC) {
    sx = us.sunPositionWC.x;
    sy = us.sunPositionWC.y;
    sz = us.sunPositionWC.z;
  } else if (us.sunDirectionWC) {
    sx = us.sunDirectionWC.x * 1.5e11;
    sy = us.sunDirectionWC.y * 1.5e11;
    sz = us.sunDirectionWC.z * 1.5e11;
  } else {
    return;
  }
  // viewProjection is column-major mat4; NDC = vp * [sx, sy, sz, 1].
  const cx = vp[0] * sx + vp[4] * sy + vp[8] * sz + vp[12];
  const cy = vp[1] * sx + vp[5] * sy + vp[9] * sz + vp[13];
  const cw = vp[3] * sx + vp[7] * sy + vp[11] * sz + vp[15];
  if (cw === 0 || !isFinite(cw)) return;
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  // NDC [-1, 1] -> UV [0, 1]; flip Y so origin is top-left.
  const u = ndcX * 0.5 + 0.5;
  const v = -ndcY * 0.5 + 0.5;
  fx.setSunScreenUV(u, v);
  if (us.currentFrustum) {
    fx.setFrustum(us.currentFrustum.x, us.currentFrustum.y);
  }
  // Touch the scratch slot so esbuild can't tree-shake the alloc that
  // future versions may use for SIMD-aware projection.
  _godRayScratchClip[0] = cx;
}

/**
 * Destroy WebGPU post-process resources.
 */
function destroyWebGPUPostProcessResources(
  collection: CesiumObjectWithWebGPUCache,
): void {
  collection._webgpuCache = undefined;
}

/**
 * Check if any post-process stages are active for WebGPU.
 */
function hasActiveWebGPUPostProcessStages(
  collection: CesiumObjectWithWebGPUCache,
): boolean {
  const cache = collection._webgpuCache as PostProcessCache | undefined;
  if (!cache || !cache.initialized) {
    return false;
  }
  return (
    cache.fxaaEnabled ||
    cache.tonemappingEnabled ||
    cache.ambientOcclusionEnabled ||
    cache.bloomEnabled ||
    cache.depthOfFieldEnabled ||
    cache.godRayEnabled
  );
}

export {
  updateWebGPUPostProcessStages,
  configureWebGPUPostProcessPipeline,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
export default {
  updateWebGPUPostProcessStages,
  configureWebGPUPostProcessPipeline,
  destroyWebGPUPostProcessResources,
  hasActiveWebGPUPostProcessStages,
};
