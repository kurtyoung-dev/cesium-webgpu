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
  // NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 199
  // formalization). Tracks whether `_userStages` on the pipeline has
  // been populated from `scene.postProcessStages._stages` already this
  // session. Set on first build, reset to `false` when the user
  // collection's stage list empties so the configure pass re-builds.
  _userStagesBuilt?: boolean;
}

// Narrow a polymorphic PostProcessStage uniform value to a number for
// the dominant numeric-scalar reads (intensity, sigma, threshold, etc.).
// Returns the default when the uniform is undefined or carries a non-
// numeric value (the AO algorithm discriminator is the lone string-typed
// uniform — it has its own narrowing path at the read site). The pattern
// matches `Cesium.defaultValue(value, default)` semantics.
function numU(v: number | string | boolean | undefined, d: number): number {
  return typeof v === "number" ? v : d;
}

function getDefaultCache(): PostProcessCache {
  return {
    initialized: false,
    fxaaEnabled: false,
    // Session 65 cont. fix — default to FALSE to match WebGL's
    // `PostProcessStageCollection` (line 57: `tonemapping.enabled =
    // false; // will be enabled if necessary in update`).
    //
    // Previously defaulted to true, which caused the Tonemap stage to
    // run with Reinhard + sRGB encode on every frame on the bgra8unorm
    // SDR pipeline. The result: globe imagery (linear 0.1, 0.2, 0.4)
    // got tonemapped to (~0.725, 0.831, 0.902) before reaching the
    // canvas — root cause of NEW-VR2-3 "imagery wash-out" (Session 65
    // triage). Verified via a debug-return probe: globe shader emits
    // (0.1, 0.2, 0.4); canvas reads back (185, 212, 230) ≈ same
    // x/(x+0.087) Reinhard + pow(., 1/2.2) curve.
    //
    // Cesium's WebGL path tonemap.enabled flips to true only when
    // `useHdr === true` (PostProcessStageCollection.update line 575).
    // The sync layer below honors that via the `_tonemapping.enabled`
    // read — but if the WebGL collection has never been touched
    // (e.g., the WebGPU FR for POST_PROCESS_COLLECTION runs before
    // PostProcessStageCollection's constructor finishes setting
    // `_tonemapping`), the cache stays at this default. False matches
    // SDR-by-default; HDR turns it on via the cache.tonemappingEnabled
    // read below.
    tonemappingEnabled: false,
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
 * Batch 98 — locate the upstream DoF composite stage by name. The
 * fork's `cache.depthOfFieldEnabled = collection._depthOfField?.enabled`
 * read was always false because the upstream `PostProcessStageCollection`
 * never exposed a `_depthOfField` slot — DoF is only available via
 * `scene.postProcessStages.add(PostProcessStageLibrary.createDepthOfFieldStage())`.
 * That helper returns a `PostProcessStageComposite` with the well-known
 * name `czm_depth_of_field` whose own `enabled` flag controls visibility.
 *
 * Returns the composite stage if present, otherwise `null`. The caller
 * uses this to drive `cache.depthOfFieldEnabled` (no separate slot
 * needed) and to source the DoF uniforms during lazy init.
 */
function findDepthOfFieldStage(collection: unknown): {
  enabled: boolean;
  uniforms: {
    focalDistance?: number;
    delta?: number;
    sigma?: number;
    stepSize?: number;
  };
} | null {
  const stages = (
    collection as {
      _stages?: Array<{
        name?: string;
        enabled?: boolean;
        uniforms?: Record<string, unknown>;
      }>;
    }
  )._stages;
  if (!Array.isArray(stages)) return null;
  for (const s of stages) {
    if (!s) continue;
    if (s.name === "czm_depth_of_field") {
      return {
        enabled: !!s.enabled,
        uniforms: (s.uniforms ?? {}) as {
          focalDistance?: number;
          delta?: number;
          sigma?: number;
          stepSize?: number;
        },
      };
    }
  }
  return null;
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
  // Batch 98 — upstream DoF lives in `collection._stages`, not on a
  // dedicated slot. Walk the list for the well-known composite.
  const dofStage = findDepthOfFieldStage(collection);
  cache.depthOfFieldEnabled = dofStage?.enabled ?? false;

  // Cache bloom/AO uniform values for runtime update
  if (cache.bloomEnabled) {
    const bloom = collection.bloom;
    cache.bloomThreshold = numU(bloom?.uniforms?.brightness, 0.8);
    cache.bloomIntensity = bloom?.uniforms?.glowOnly ? 1.0 : 0.5;
  }
  if (cache.ambientOcclusionEnabled) {
    const ao = collection.ambientOcclusion;
    cache.aoIntensity = numU(ao?.uniforms?.intensity, 3.0);
    cache.aoBias = numU(ao?.uniforms?.bias, 0.1);
  }

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
  // HDR-DISPLAY (Batch 200; Batch 205 audit fix B200-D1 + D2) — skip
  // SDR-only post-process stages when the user opts into wide-gamut
  // HDR canvas output. On HDR-capable displays, the OS / display
  // handles the gamut + tone curve; running tonemap / colorGrading /
  // FXAA (all SDR-tuned) would corrupt the HDR signal:
  //
  // - tonemap compresses HDR → SDR (defeats the whole point)
  // - colorGrading curves are calibrated for [0,1] SDR; HDR values >1
  //   produce wrong saturation/lift/gain
  // - FXAA edge-detection thresholds assume SDR; HDR highlights
  //   over-trigger as edges
  //
  // Skip is opt-in via `scene.useHDRCanvasOutput = true` AND requires
  // `scene.highDynamicRange = true` (the latter ensures the scene
  // framebuffer is rgba16float so the HDR data actually exists to
  // forward). Falls through to standard SDR pipeline when either
  // gate is off — backwards-compatible by default.
  //
  // The per-frame skip flag lives on the pipeline (read by `execute()`'s
  // single-pass chain assembly) so colorGrading / FXAA enabled state
  // set programmatically elsewhere is preserved when HDR-skip toggles
  // off — we don't permanently mutate their enabled flags.
  const sceneAny = scene as
    | { useHDRCanvasOutput?: boolean; highDynamicRange?: boolean }
    | undefined;
  const skipSDRStagesForHDR =
    sceneAny?.useHDRCanvasOutput === true &&
    sceneAny?.highDynamicRange === true;
  pipeline.setSkipSDRStagesForHDR(skipSDRStagesForHDR);
  pipeline.setStageEnabled(
    "Tonemap",
    cache.tonemappingEnabled && !skipSDRStagesForHDR,
  );
  pipeline.setTonemappingMode(cache.tonemapMode);

  // --- Bloom: lazily initialize on first enable ---
  if (cache.bloomEnabled && !cache.bloomInitialized) {
    const bloom = collection.bloom;
    pipeline.addBloom(device, canvasFormat, {
      threshold: numU(bloom?.uniforms?.brightness, 0.8),
      intensity: bloom?.uniforms?.glowOnly ? 1.0 : 0.5,
      sigma: numU(bloom?.uniforms?.sigma, 3.5),
      glowOnly: Boolean(bloom?.uniforms?.glowOnly ?? false),
    });
    cache.bloomInitialized = true;
  }
  pipeline.setStageEnabled("Bloom", cache.bloomEnabled);

  // Update bloom config if it changed
  if (cache.bloomEnabled && pipeline.bloomEffect) {
    const bloom = collection.bloom;
    const newThreshold = numU(bloom?.uniforms?.brightness, 0.8);
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
    // when unset for backwards compatibility. The AO algorithm
    // discriminator is the lone string-typed uniform — narrow it to
    // the literal union without going through `numU`.
    const rawAlgo = ao?.uniforms?.algorithm;
    const algorithm: "gtao" | "hbao" =
      rawAlgo === "gtao" || rawAlgo === "hbao" ? rawAlgo : "hbao";
    pipeline.addAmbientOcclusion(device, canvasFormat, {
      algorithm,
      intensity: numU(ao?.uniforms?.intensity, 3.0),
      bias: numU(ao?.uniforms?.bias, 0.1),
      lengthCap: numU(ao?.uniforms?.lengthCap, 0.26),
      stepCount: numU(ao?.uniforms?.stepSize, 4),
      directionCount: numU(ao?.uniforms?.directionCount, 4),
      ambientOcclusionOnly: Boolean(
        ao?.uniforms?.ambientOcclusionOnly ?? false,
      ),
    });
    cache.aoInitialized = true;
  }
  pipeline.setStageEnabled("AmbientOcclusion", cache.ambientOcclusionEnabled);

  // --- Depth of Field: lazily initialize on first enable ---
  // Batch 98 — uniforms now come from the upstream DoF composite stage
  // located by `findDepthOfFieldStage`, not the never-existed
  // `collection._depthOfField` slot.
  if (cache.depthOfFieldEnabled && !cache.dofInitialized) {
    const dof = findDepthOfFieldStage(collection);
    pipeline.addDepthOfField(device, canvasFormat, {
      focalDistance: numU(dof?.uniforms?.focalDistance, 50.0),
      focalRange: numU(dof?.uniforms?.delta, 20.0),
      blurSigma: numU(dof?.uniforms?.sigma, 4.0),
    });
    cache.dofInitialized = true;
  }
  pipeline.setStageEnabled("DepthOfField", cache.depthOfFieldEnabled);

  // NEW-POSTPROCESS-USER-WGSL (Batch 198 first slice; Batch 204
  // second slice — named-uniform schema + multi-pass) — user-supplied
  // WGSL stages from `scene.postProcessStages.add(...)`. Build once on
  // first configure call and rebuild if the user clears/adds stages.
  //
  // Recognized stage uniforms (Batch 204):
  //   - `wgslFragmentShader: string` — required. WGSL FS source.
  //   - `wgslUniformSchema: UniformSchema` — optional. Named-uniform
  //     schema mapping `{ [name]: { type, offset } }`. When present,
  //     vec3/vec4 uniform values may be `number[]` arrays.
  //   - `wgslNumberOfPasses: number` — optional. Default 1.
  //   - All other uniform keys: numeric scalars (or arrays when schema
  //     declares them as vec2/3/4) packed into the 64-byte UBO.
  const userStages = (collection as unknown as { _stages?: unknown[] })._stages;
  if (!cache._userStagesBuilt && Array.isArray(userStages)) {
    let glslOnlyCount = 0;
    for (const s of userStages) {
      const stage = s as
        | { name?: string; uniforms?: Record<string, unknown> }
        | null
        | undefined;
      if (!stage) continue;
      // Batch 98 — skip the upstream DoF composite; it's intercepted
      // and routed through `pipeline.addDepthOfField` above. Counting
      // it as a GLSL-only stage would fire a misleading warning and
      // suggest the user supply a WGSL shader for an effect we
      // already handle natively.
      if (
        stage.name === "czm_depth_of_field" ||
        stage.name === "czm_depth_of_field_blur" ||
        stage.name === "czm_depth_of_field_composite"
      ) {
        continue;
      }
      const wgsl = stage.uniforms?.wgslFragmentShader;
      if (typeof wgsl === "string" && wgsl.length > 0) {
        const u = stage.uniforms as Record<string, unknown>;
        // Batch 204 — extract schema + numberOfPasses if provided.
        const schemaRaw = u.wgslUniformSchema;
        const schema =
          schemaRaw && typeof schemaRaw === "object"
            ? (schemaRaw as import("./WebGPUUserPostProcessStage.js").UniformSchema)
            : undefined;
        const numberOfPassesRaw = u.wgslNumberOfPasses;
        const numberOfPasses =
          typeof numberOfPassesRaw === "number" ? numberOfPassesRaw : undefined;

        // Pack uniforms — schema-driven mode allows number[] vec
        // values; iteration-order mode (no schema) accepts only
        // scalars. The user stage class handles the actual packing.
        const reservedKeys = new Set([
          "wgslFragmentShader",
          "wgslUniformSchema",
          "wgslNumberOfPasses",
        ]);
        const userUniforms: Record<string, number | number[]> = {};
        for (const k in u) {
          if (reservedKeys.has(k)) continue;
          const v = u[k];
          if (typeof v === "number") {
            userUniforms[k] = v;
          } else if (
            Array.isArray(v) &&
            v.every((x) => typeof x === "number")
          ) {
            userUniforms[k] = v as number[];
          }
        }

        pipeline.addUserWGSLStage(
          device,
          canvasFormat,
          stage.name ?? "user-wgsl",
          wgsl,
          userUniforms,
          schema,
          numberOfPasses,
        );
      } else {
        glslOnlyCount++;
      }
    }
    cache._userStagesBuilt = true;
    //>>includeStart('debug', pragmas.debug);
    if (glslOnlyCount > 0) {
      oneTimeWarning(
        "WebGPUPostProcessStageCollection.userStagesGLSL",
        `${glslOnlyCount} user-added PostProcessStage instance(s) without ` +
          "a `wgslFragmentShader` uniform detected on a WebGPU scene. " +
          "GLSL custom shaders are not transpiled on the WebGPU backend; " +
          "supply a `wgslFragmentShader: string` uniform on each stage to " +
          "execute custom WGSL post-process effects. Stages with " +
          "`wgslFragmentShader` set are honored. Track NEW-POSTPROCESS-USER-WGSL.",
      );
    }
    //>>includeEnd('debug');
  } else if (
    cache._userStagesBuilt &&
    (!Array.isArray(userStages) || userStages.length === 0)
  ) {
    pipeline.clearUserWGSLStages();
    cache._userStagesBuilt = false;
  }

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
  // Audit re-review (Batch 134) -- GodRay enable rides
  // `pipeline.godRayEffect.enabled` directly; `setStageEnabled` only
  // recognizes the named slot stages (TAA, FXAA, Bloom, Tonemap, etc.)
  // and falls through to a no-op for unknown names. The previous
  // `setStageEnabled("GodRay", false)` call was dead and misleading
  // -- removed to keep the enable surface single-source.
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
        // Audit re-review (Batch 134) -- `currentFrustum` is set
        // per-frustum during the multi-frustum command-list traversal,
        // so by the time the post-process configure runs it carries
        // whichever frustum's near/far was last applied (typically the
        // far one). The full-scene depth-linearization for GodRay
        // needs the camera's overall near + far, not the last per-
        // frustum slice.
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
  // Audit re-review (Batch 134) -- pull the frustum span from the
  // camera object, not `uniformState.currentFrustum`. The latter is
  // mutated per-frustum during command execution and by the time the
  // configure pass runs it reflects the LAST per-frustum slice (the
  // far one), so the GodRay generate pass would linearize depth
  // against the far slice's near/far -- foreground geometry depths
  // would all collapse to ~0 and gate every sample as "sky", letting
  // shafts leak through occluders. The camera's overall near/far
  // bracket the entire scene depth range correctly.
  const cam = (
    scene as unknown as {
      camera?: { frustum?: { near?: number; far?: number } };
    }
  )?.camera;
  const near = cam?.frustum?.near;
  const far = cam?.frustum?.far;
  if (typeof near === "number" && typeof far === "number" && far > near) {
    fx.setFrustum(near, far);
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
