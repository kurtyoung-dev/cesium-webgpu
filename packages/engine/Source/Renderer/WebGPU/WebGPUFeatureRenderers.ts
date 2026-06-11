/**
 * WebGPU Feature Renderer Registration
 *
 * This module centralizes ALL WebGPU renderer registrations. When a WebGPU context
 * is created, `registerWebGPUFeatureRenderers(context)` is called to register
 * every feature renderer. Scene files then access renderers via
 * `context.getFeatureRenderer(FeatureRendererKey.XXX)` instead of importing directly
 * from `Renderer/WebGPU/`.
 *
 * This eliminates `if (context.isWebGPU)` branching and WebGPU imports from scene
 * files, making them fully backend-agnostic.
 *
 * @module WebGPUFeatureRenderers
 */

import FeatureRendererKey from "../FeatureRendererKey.js";

// ── Collections ──
import {
  updateWebGPUBillboards,
  destroyWebGPUBillboardResources,
} from "./WebGPUBillboardRenderer.js";
import {
  updateWebGPUPointPrimitives,
  destroyWebGPUPointResources,
} from "./WebGPUPointPrimitiveRenderer.js";
import {
  updateWebGPUPolylines,
  destroyWebGPUPolylineResources,
} from "./WebGPUPolylineRenderer.js";
import {
  updateWebGPUCloudCollection,
  destroyWebGPUCloudResources,
} from "./WebGPUCloudRenderer.js";
import {
  updateWebGPULabels,
  destroyWebGPULabelResources,
} from "./WebGPULabelRenderer.js";
import {
  updateWebGPUBufferPolygonCollection,
  destroyWebGPUBufferPolygonCollection,
  updateWebGPUBufferPolylineCollection,
  destroyWebGPUBufferPolylineCollection,
  updateWebGPUBufferPointCollection,
  destroyWebGPUBufferPointCollection,
} from "./WebGPUBufferPrimitiveRenderer.js";
// Phase 3 (Batch 230) — GPU-resident orbital catalog (compute propagation
// → storage buffer → instanced vertex-pull draw).
import {
  updateWebGPUOrbitalCatalog,
  destroyWebGPUOrbitalCatalogResources,
} from "./WebGPUOrbitalCatalogRenderer.js";

// ── Primitive system ──
import {
  createWebGPUCommands,
  updateWebGPUCommandUniforms,
  updateWebGPUPickCommandUniforms,
  createWebGPUMaterialCommands,
  updateWebGPUMaterialCommandUniforms,
} from "./WebGPUPrimitiveCommands.js";

// ── Environment ──
import {
  updateWebGPUSun,
  updateWebGPUMoon,
  destroyWebGPUMoonResources,
  getWebGPUMoonStatistics,
} from "./WebGPUEnvironmentRenderer.js";
import { updateWebGPUSkyAtmosphere } from "./WebGPUSkyAtmosphereRenderer.js";
import {
  updateCubeMapPanorama,
  destroyCubeMapPanorama,
} from "./WebGPUCubeMapPanoramaRenderer.js";
// Phase 5a — froxel-grid volumetric fog (infrastructure only).
import {
  updateWebGPUVolumetricFog,
  compositeWebGPUVolumetricFog,
  destroyWebGPUVolumetricFog,
  getWebGPUVolumetricFogStatistics,
} from "./WebGPUVolumetricFogRenderer.js";

// Phase 3 — Hi-Z occlusion culling (dispatcher + bind group factory).
import {
  initWebGPUHiZOcclusion,
  dispatchWebGPUHiZOcclusion,
  readbackWebGPUHiZOcclusion,
  getWebGPUHiZOcclusionStatistics,
  destroyWebGPUHiZOcclusion,
} from "./WebGPUHiZOcclusionDispatcher.js";

// Phase 3 — GPU sort keys (packed 64-bit draw command sort keys).
// Phase 2 (Batch 228) adds the bitonic sort + readback chain.
import {
  initWebGPUGPUSortKeys,
  dispatchWebGPUGPUSortKeys,
  runBitonicSortWebGPUGPUSortKeys,
  prepareIndicesReadbackWebGPUGPUSortKeys,
  readSortedIndicesWebGPUGPUSortKeys,
  getWebGPUGPUSortKeysStatistics,
  destroyWebGPUGPUSortKeys,
} from "./WebGPUGPUSortKeysDispatcher.js";

// Phase 3 — GPU point cloud bitonic sort.
import { WebGPUPointCloudSortDispatcher } from "./WebGPUPointCloudSortDispatcher.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import PointCloudSortSource from "../../Shaders/WebGPU/Compute/PointCloudSort.js";

// ── Shadow / Ground ──
import {
  initWebGPUShadowMap,
  destroyWebGPUShadowMapResources,
  renderShadowCastPass,
} from "./WebGPUShadowMapRenderer.js";
import {
  createWebGPUGroundPrimitiveCommands,
  destroyWebGPUGroundPrimitiveResources,
} from "./WebGPUGroundPrimitiveRenderer.js";
import {
  createWebGPUGroundPolylineCommands,
  destroyWebGPUGroundPolylineResources,
} from "./WebGPUGroundPolylineRenderer.js";
import {
  createWebGPUVector3DTilePrimitiveCommands,
  destroyWebGPUVector3DTilePrimitiveResources,
} from "./WebGPUVector3DTilePrimitiveRenderer.js";
import {
  createWebGPUVector3DTilePolylineCommands,
  destroyWebGPUVector3DTilePolylineResources,
} from "./WebGPUVector3DTilePolylinesRenderer.js";
import {
  createWebGPUVector3DTileClampedPolylineCommands,
  destroyWebGPUVector3DTileClampedPolylineResources,
} from "./WebGPUVector3DTileClampedPolylinesRenderer.js";

// ── Globe / Terrain ──
import { WebGPUGlobeSurfaceRenderer } from "./WebGPUGlobeSurfaceRenderer.js";
import { updateWebGPUGlobeTranslucencyDerivedCommands } from "./WebGPUGlobeTranslucencyState.js";
// Globe terrain shader code — imported here so Scene files don't need WebGPU imports
import GlobeTerrainShaderCode from "../../Shaders/WebGPU/Globe/GlobeTerrain.js";

// ── Model ──
import {
  updateWebGPUModel,
  destroyWebGPUModelResources,
} from "./WebGPUModelRenderer.js";

// ── Advanced features ──
//
// The advanced renderers below are registered LAZILY via dynamic import.
// Each one is wrapped in a `registerFeatureRendererLoader` call further
// down so that the renderer's source code (and the WGSL shader strings
// it depends on) only enter the bundle as separate chunks that download
// on first use. The static imports for them have been removed; only
// `EllipsoidPrimitive` and `InvertClassification` stay eager because
// they're tiny and used by core picking flows.
import {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
} from "./WebGPUEllipsoidPrimitiveRenderer.js";
import {
  updateWebGPUInvertClassification,
  destroyWebGPUInvertClassificationResources,
} from "./WebGPUInvertClassification.js";

// ── IBL / Lighting ──
import {
  updateWebGPUBrdfLut,
  destroyWebGPUBrdfLutResources,
} from "./WebGPUBrdfLutGenerator.js";
import {
  updateWebGPUImageBasedLighting,
  destroyWebGPUImageBasedLightingResources,
} from "./WebGPUImageBasedLighting.js";
import {
  updateWebGPUDynamicEnvironmentMap,
  destroyWebGPUDynamicEnvironmentMapResources,
} from "./WebGPUDynamicEnvironmentMapManager.js";

// ── Clipping ──
import {
  updateWebGPUClippingPlanes,
  destroyWebGPUClippingPlaneResources,
} from "./WebGPUClippingPlaneCollection.js";
import {
  updateWebGPUClippingPolygons,
  destroyWebGPUClippingPolygonResources,
} from "./WebGPUClippingPolygonCollection.js";

// ── Post-processing ──
import {
  updateWebGPUPostProcessStages,
  destroyWebGPUPostProcessResources,
} from "./WebGPUPostProcessStageCollection.js";

// ── Imagery ──
import {
  initWebGPUImageryReprojection,
  destroyWebGPUImageryReprojectionResources,
  reprojectWebMercatorWebGPU,
  reprojectImageSourceWebGPU,
  uploadAndReprojectMercatorImage,
} from "./WebGPUImageryReprojection.js";

// ── Atmosphere ──
import {
  updateWebGPUGroundAtmosphere,
  destroyWebGPUGroundAtmosphereResources,
} from "./WebGPUGroundAtmosphereRenderer.js";

// SSR, Weather, and Procedural Clouds are also lazy — see the
// registerFeatureRendererLoader calls below.

// ── Scene orchestration ──
import { WebGPUSceneRenderer } from "./WebGPUSceneRenderer.js";
import { initPrimitiveShaders } from "./WebGPUPrimitiveShaders.js";
import { initCollectionShaders } from "./WebGPUCollectionShaders.js";

import type WebGPUContext from "./WebGPUContext.js";
import type {
  CollectionRenderer,
  PrimitiveCommandRenderer,
  SystemRenderer,
} from "../GraphicsContext.js";

/**
 * Registers all WebGPU feature renderers on the given context.
 * Called once during WebGPUContext initialization.
 *
 * Scene files access these via `context.getFeatureRenderer(FeatureRendererKey.XXX)`
 * instead of importing from `Renderer/WebGPU/` directly.
 *
 * @param context - The WebGPU graphics context to register renderers on
 */
export function registerWebGPUFeatureRenderers(context: WebGPUContext): void {
  // ── Collections ──
  context.registerFeatureRenderer(FeatureRendererKey.BILLBOARD_COLLECTION, {
    update: updateWebGPUBillboards,
    destroy: destroyWebGPUBillboardResources,
  });

  context.registerFeatureRenderer(
    FeatureRendererKey.POINT_PRIMITIVE_COLLECTION,
    {
      update: updateWebGPUPointPrimitives,
      destroy: destroyWebGPUPointResources,
    },
  );

  context.registerFeatureRenderer(FeatureRendererKey.POLYLINE_COLLECTION, {
    update: updateWebGPUPolylines,
    destroy: destroyWebGPUPolylineResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.CLOUD_COLLECTION, {
    update: updateWebGPUCloudCollection,
    destroy: destroyWebGPUCloudResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.LABEL_COLLECTION, {
    update: updateWebGPULabels,
    destroy: destroyWebGPULabelResources,
  });

  // ── Buffer Primitive collections (v1.140 vector tiles) ──
  // Full WebGPU implementation in WebGPUBufferPrimitiveRenderer.ts using the
  // WGSL shaders at Shaders/WebGPU/Collections/Buffer{Point,Polyline,Polygon}Material.wgsl.
  // Picking is not yet wired through the WebGPU pick framebuffer for these
  // experimental collections.
  context.registerFeatureRenderer(FeatureRendererKey.BUFFER_POINT_COLLECTION, {
    update: updateWebGPUBufferPointCollection,
    destroy: destroyWebGPUBufferPointCollection,
  });
  context.registerFeatureRenderer(
    FeatureRendererKey.BUFFER_POLYLINE_COLLECTION,
    {
      update: updateWebGPUBufferPolylineCollection,
      destroy: destroyWebGPUBufferPolylineCollection,
    },
  );
  context.registerFeatureRenderer(
    FeatureRendererKey.BUFFER_POLYGON_COLLECTION,
    {
      update: updateWebGPUBufferPolygonCollection,
      destroy: destroyWebGPUBufferPolygonCollection,
    },
  );

  // ── GPU-resident orbital catalog (Phase 3, Batch 230) ──
  // Compute-propagated circular orbits; positions never leave the GPU.
  context.registerFeatureRenderer(
    FeatureRendererKey.ORBITAL_CATALOG_COLLECTION,
    {
      update: updateWebGPUOrbitalCatalog,
      destroy: destroyWebGPUOrbitalCatalogResources,
    },
  );

  // ── Primitive system ──
  context.registerFeatureRenderer(FeatureRendererKey.PRIMITIVE, {
    createCommands: createWebGPUCommands,
    createMaterialCommands: createWebGPUMaterialCommands,
    updateCommandUniforms: updateWebGPUCommandUniforms,
    updateMaterialCommandUniforms: updateWebGPUMaterialCommandUniforms,
    updatePickCommandUniforms: updateWebGPUPickCommandUniforms,
  });

  // ── Environment ──
  context.registerFeatureRenderer(FeatureRendererKey.SUN, {
    update: updateWebGPUSun,
  });

  context.registerFeatureRenderer(FeatureRendererKey.MOON, {
    update: updateWebGPUMoon,
    destroy: destroyWebGPUMoonResources,
    // Phase 6 debug surface — `getStatistics(moon)` returns the
    // per-instance moon cache state (texture loaded, phase, frozen, ...).
    // Called by `Moon.getDebugStatistics()` from the backend-agnostic
    // dispatch path.
    getStatistics: getWebGPUMoonStatistics,
  });

  context.registerFeatureRenderer(FeatureRendererKey.SKY_ATMOSPHERE, {
    update: updateWebGPUSkyAtmosphere,
  });

  // `FeatureRendererKey.FOG` is intentionally unregistered. Classic
  // distance-based fog is driven entirely by `frameState.fog.*` + the
  // per-tile UB populated in `WebGPUGlobeSurfaceRenderer`, which is the
  // only shader family that applies exponential horizon fog. An FR
  // getParameters helper would return a strict subset of what the globe
  // packer actually needs (missing visualDensityScalar, offset, humidity
  // modulation), so wiring it in would regress consumers. The key itself
  // is kept in the enum for potential future reuse (e.g., a Scene-level
  // fog sampler that legitimately needs backend-agnostic access).

  context.registerFeatureRenderer(FeatureRendererKey.CUBE_MAP_PANORAMA, {
    update: updateCubeMapPanorama,
    destroy: destroyCubeMapPanorama,
  });

  // Phase 5a — froxel-grid volumetric fog. The renderer exposes both an
  // `update` (compute passes) and `composite` (full-screen pass) entry
  // point so the WebGPUSceneRenderer can call them in the right order
  // relative to the other environmental effects. `update` runs first to
  // populate the integrated 3D volume; `composite` runs last (after
  // procedural clouds, SSR, weather particles) to multiply the scene
  // color by transmittance and add the in-scattered light.
  context.registerFeatureRenderer(FeatureRendererKey.VOLUMETRIC_FOG, {
    update: updateWebGPUVolumetricFog,
    composite: compositeWebGPUVolumetricFog,
    destroy: destroyWebGPUVolumetricFog,
    // Phase 6 debug surface — `getStatistics()` returns the per-context
    // fog instance state. Called by `WebGPUContext.getRendererStatistics`.
    getStatistics: function () {
      return getWebGPUVolumetricFogStatistics(context);
    },
  });

  // Phase 3 — GPU sort keys. Dispatcher-only registration; the
  // consumer integration in RenderScheduler is a separate step.
  // Infrastructure is in place so a future scene with >50K commands
  // can flip the switch without any renderer-layer changes.
  context.registerFeatureRenderer(FeatureRendererKey.GPU_SORT_KEYS, {
    init: function (maxCommands: number) {
      return initWebGPUGPUSortKeys(context, maxCommands);
    },
    dispatch: function (
      encoder: GPUCommandEncoder,
      soa: Parameters<typeof dispatchWebGPUGPUSortKeys>[2],
      params: Parameters<typeof dispatchWebGPUGPUSortKeys>[3],
    ) {
      return dispatchWebGPUGPUSortKeys(context, encoder, soa, params);
    },
    // Batch 228 — Phase 2 sort + readback chain.
    runBitonicSort: function (encoder: GPUCommandEncoder, count: number) {
      return runBitonicSortWebGPUGPUSortKeys(context, encoder, count);
    },
    prepareIndicesReadback: function (
      encoder: GPUCommandEncoder,
      count: number,
    ) {
      prepareIndicesReadbackWebGPUGPUSortKeys(context, encoder, count);
    },
    readSortedIndices: function (count: number) {
      return readSortedIndicesWebGPUGPUSortKeys(context, count);
    },
    destroy: function () {
      destroyWebGPUGPUSortKeys(context);
    },
    getStatistics: function () {
      return getWebGPUGPUSortKeysStatistics(context);
    },
  });

  // Phase 3 — GPU point cloud sort. Lazy-initialized on first sort()
  // call. Gated by WasmPointCloudBridge.useGPUSort (default false).
  let _pcSortDispatcher: WebGPUPointCloudSortDispatcher | null = null;
  context.registerFeatureRenderer(FeatureRendererKey.POINT_CLOUD_SORT, {
    sort: function (
      encoder: GPUCommandEncoder,
      distSq: Float32Array,
      count: number,
    ) {
      if (!_pcSortDispatcher) {
        _pcSortDispatcher = new WebGPUPointCloudSortDispatcher(context.device!);
        _pcSortDispatcher.setShaderSource(PointCloudSortSource);
        // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76).
        _pcSortDispatcher._setComputePipelineCache(
          context.webgpuComputePipelineCache ?? null,
        );
      }
      return _pcSortDispatcher.sort(encoder, distSq, count);
    },
    destroy: function () {
      if (_pcSortDispatcher) {
        _pcSortDispatcher.destroy();
        _pcSortDispatcher = null;
      }
    },
    getStatistics: function () {
      return _pcSortDispatcher ? _pcSortDispatcher.getStatistics() : null;
    },
  });

  // Phase 3 — Hi-Z occlusion culling. The dispatcher owns the Hi-Z
  // pyramid texture, the SOA sphere buffers, and the visibility
  // staging buffer. Scene-side `OcclusionCulling.initialize()` calls
  // `init()` to allocate; `beginFrame` → `dispatch()` runs the two
  // compute passes; `readback()` pulls the previous frame's
  // visibility bits for CPU-side command splitting.
  context.registerFeatureRenderer(FeatureRendererKey.HI_Z_OCCLUSION, {
    init: function (
      inputWidth: number,
      inputHeight: number,
      maxCommands: number,
    ) {
      return initWebGPUHiZOcclusion(
        context,
        inputWidth,
        inputHeight,
        maxCommands,
      );
    },
    dispatch: function (
      encoder: GPUCommandEncoder,
      depthTextureView: GPUTextureView,
      soa: Parameters<typeof dispatchWebGPUHiZOcclusion>[3],
      params: Parameters<typeof dispatchWebGPUHiZOcclusion>[4],
      frameId?: number,
    ) {
      return dispatchWebGPUHiZOcclusion(
        context,
        encoder,
        depthTextureView,
        soa,
        params,
        frameId,
      );
    },
    readback: function (count: number) {
      return readbackWebGPUHiZOcclusion(context, count);
    },
    destroy: function () {
      destroyWebGPUHiZOcclusion(context);
    },
    getStatistics: function () {
      return getWebGPUHiZOcclusionStatistics(context);
    },
  });

  // ── Shadow / Ground ──
  context.registerFeatureRenderer(FeatureRendererKey.SHADOW_MAP, {
    init: initWebGPUShadowMap,
    destroy: destroyWebGPUShadowMapResources,
    renderCastPass: renderShadowCastPass,
  });

  context.registerFeatureRenderer(FeatureRendererKey.GROUND_PRIMITIVE, {
    createCommands: createWebGPUGroundPrimitiveCommands,
    destroy: destroyWebGPUGroundPrimitiveResources,
  });

  // Migration Session 4b — GroundPolylinePrimitive classifier with
  // full WGSL VS/FS port (per-vertex volume extrusion, miter offset,
  // 5-plane fragment culling, depth-sample reconstruction). 3D path
  // only — 2D / Columbus View / Morph still fall through to WebGL.
  // The `Scene/GroundPolylinePrimitive.js` delegation hook gates on
  // SceneMode.SCENE3D and skips the WebGPU path otherwise.
  context.registerFeatureRenderer(FeatureRendererKey.GROUND_POLYLINE, {
    createCommands: createWebGPUGroundPolylineCommands,
    destroy: destroyWebGPUGroundPolylineResources,
  });

  // Batches 112-114 — Vector3DTile classification family. All three FRs
  // live on the depth-sample classifier architecture (ADR-2026-04-28):
  //   - VECTOR_3DTILE_PRIMITIVE        (Batch 112) — polygon classifier.
  //   - VECTOR_3DTILE_POLYLINE         (Batch 113) — non-clamped polylines.
  //   - VECTOR_3DTILE_CLAMPED_POLYLINE (Batch 114) — terrain-clamped
  //     polylines with per-vertex shadow-volume extrusion + 5-plane FS
  //     clipping.
  // Each Scene-side `Vector3DTile*.update()` delegates here when the FR is
  // registered; otherwise the WebGPU code path no-ops via the
  // BUILD-VAR-HAZARD guard in the corresponding `createShaders`.
  context.registerFeatureRenderer(FeatureRendererKey.VECTOR_3DTILE_PRIMITIVE, {
    createCommands: createWebGPUVector3DTilePrimitiveCommands,
    destroy: destroyWebGPUVector3DTilePrimitiveResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.VECTOR_3DTILE_POLYLINE, {
    createCommands: createWebGPUVector3DTilePolylineCommands,
    destroy: destroyWebGPUVector3DTilePolylineResources,
  });

  // Batch 114 — terrain-clamped 3D Tiles polylines. Depth-sample
  // classifier with 7-attribute shadow-volume vertex layout and
  // 5-plane FS clipping. Scene-side `Vector3DTileClampedPolylines.update()`
  // delegates here when the FR is registered.
  context.registerFeatureRenderer(
    FeatureRendererKey.VECTOR_3DTILE_CLAMPED_POLYLINE,
    {
      createCommands: createWebGPUVector3DTileClampedPolylineCommands,
      destroy: destroyWebGPUVector3DTileClampedPolylineResources,
    },
  );

  // ── Backend-handoff marker FRs (audit 2026-05-02) ──
  // These two registrations exist so scene primitives can use the
  // FR-key check pattern (CLAUDE.md §2) instead of branching on
  // `context.isWebGPU`. Each has only the `name` field set so callers
  // can distinguish a real renderer (has `update`/`createCommands`/
  // `RendererClass`) from a marker via duck-typing if needed.
  //
  // DEPTH_PLANE: `WebGPUDepthPlane` runs inside `WebGPUSceneRenderer`
  // not via the FR-dispatch loop. The marker's presence alone signals
  // to `Scene/DepthPlane.js` "skip the WebGL-only `ShaderProgram.fromCache`
  // setup; the WebGPU scene renderer handles depth-plane rendering
  // itself."
  context.registerFeatureRenderer(FeatureRendererKey.DEPTH_PLANE, {
    name: "DepthPlane (marker — handled by WebGPUSceneRenderer)",
  });

  // CLASSIFICATION_PRIMITIVE (Batch 130) — standalone
  // ClassificationPrimitive now reuses the same depth-sample
  // classification pipeline as GroundPrimitive. The renderer's
  // primitive-chain walk
  // (`primitive._webgpuGeometryData ??
  //   primitive._primitive?._webgpuGeometryData ??
  //   primitive._primitive?._primitive?._webgpuGeometryData`)
  // already handles the standalone-ClassificationPrimitive depth-2 case;
  // wiring it as the FR's `createCommands` lets the scene-side
  // dispatcher push commands without needing per-renderer logic.
  context.registerFeatureRenderer(FeatureRendererKey.CLASSIFICATION_PRIMITIVE, {
    name: "ClassificationPrimitive",
    createCommands: createWebGPUGroundPrimitiveCommands,
    destroy: destroyWebGPUGroundPrimitiveResources,
  });

  // ── Globe / Terrain ──
  context.registerFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE, {
    RendererClass: WebGPUGlobeSurfaceRenderer,
    getShaderCode: () => GlobeTerrainShaderCode,
  });

  context.registerFeatureRenderer(FeatureRendererKey.GLOBE_TRANSLUCENCY, {
    updateDerivedCommands: updateWebGPUGlobeTranslucencyDerivedCommands,
  });

  // ── Model ──
  context.registerFeatureRenderer(FeatureRendererKey.MODEL, {
    update: updateWebGPUModel,
    destroy: destroyWebGPUModelResources,
  });

  // ── Advanced features ──
  context.registerFeatureRenderer(FeatureRendererKey.ELLIPSOID_PRIMITIVE, {
    update: updateWebGPUEllipsoidPrimitive,
    destroy: destroyWebGPUEllipsoidPrimitiveResources,
  });

  // Lazy: GaussianSplatRenderer pulls in WGSL splat shaders + the
  // Gaussian sort compute pipelines. Only Gaussian splat consumers need it.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.GAUSSIAN_SPLAT,
    async () => {
      const mod = await import("./WebGPUGaussianSplatRenderer.js");
      context.registerFeatureRenderer(FeatureRendererKey.GAUSSIAN_SPLAT, {
        update: mod.updateWebGPUGaussianSplatPrimitive,
        destroy: mod.destroyWebGPUGaussianSplatResources,
      });
    },
  );

  // Lazy: PointCloudRenderer pulls in PCSS shaders + per-point styling.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.POINT_CLOUD,
    async () => {
      const mod = await import("./WebGPUPointCloudRenderer.js");
      context.registerFeatureRenderer(FeatureRendererKey.POINT_CLOUD, {
        update: mod.updateWebGPUPointCloud,
        destroy: mod.destroyWebGPUPointCloudResources,
      });
    },
  );

  // Lazy: Eye-Dome Lighting post-process for point clouds — only
  // dispatched when the user enables `pointCloudShading.attenuation`.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.POINT_CLOUD_EDL,
    async () => {
      const mod = await import("./WebGPUPointCloudEyeDomeLighting.js");
      context.registerFeatureRenderer(FeatureRendererKey.POINT_CLOUD_EDL, {
        update: mod.updateWebGPUPointCloudEDL,
        destroy: mod.destroyWebGPUPointCloudEDLResources,
      });
    },
  );

  // Lazy: VoxelRenderer pulls in volumetric raycast shaders, octree
  // traversal, and ~6 voxel-specific WGSL files. Substantial chunk.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.VOXEL_PRIMITIVE,
    async () => {
      const mod = await import("./WebGPUVoxelRenderer.js");
      context.registerFeatureRenderer(FeatureRendererKey.VOXEL_PRIMITIVE, {
        update: mod.updateWebGPUVoxelPrimitive,
        destroy: mod.destroyWebGPUVoxelResources,
      });
    },
  );

  context.registerFeatureRenderer(FeatureRendererKey.INVERT_CLASSIFICATION, {
    update: updateWebGPUInvertClassification,
    destroy: destroyWebGPUInvertClassificationResources,
  });

  // ── IBL / Lighting ──
  context.registerFeatureRenderer(FeatureRendererKey.BRDF_LUT, {
    update: updateWebGPUBrdfLut,
    destroy: destroyWebGPUBrdfLutResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.IMAGE_BASED_LIGHTING, {
    update: updateWebGPUImageBasedLighting,
    destroy: destroyWebGPUImageBasedLightingResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.DYNAMIC_ENVIRONMENT_MAP, {
    update: updateWebGPUDynamicEnvironmentMap,
    destroy: destroyWebGPUDynamicEnvironmentMapResources,
  });

  // ── Clipping ──
  context.registerFeatureRenderer(FeatureRendererKey.CLIPPING_PLANES, {
    update: updateWebGPUClippingPlanes,
    destroy: destroyWebGPUClippingPlaneResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.CLIPPING_POLYGONS, {
    update: updateWebGPUClippingPolygons,
    destroy: destroyWebGPUClippingPolygonResources,
  });

  // ── Post-processing ──
  context.registerFeatureRenderer(FeatureRendererKey.POST_PROCESS_COLLECTION, {
    update: updateWebGPUPostProcessStages,
    destroy: destroyWebGPUPostProcessResources,
  });

  // ── Imagery ──
  context.registerFeatureRenderer(FeatureRendererKey.IMAGERY_REPROJECTION, {
    init: initWebGPUImageryReprojection,
    destroy: destroyWebGPUImageryReprojectionResources,
    reproject: reprojectWebMercatorWebGPU,
    reprojectFromImage: reprojectImageSourceWebGPU,
    uploadAndReproject: uploadAndReprojectMercatorImage,
  });

  // ── Atmosphere ──
  context.registerFeatureRenderer(FeatureRendererKey.GROUND_ATMOSPHERE, {
    update: updateWebGPUGroundAtmosphere,
    destroy: destroyWebGPUGroundAtmosphereResources,
  });

  // ── Screen-space effects (LAZY) ──
  // SSR is opt-in via scene flag; only loaded when actually enabled.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
    async () => {
      const mod = await import("./WebGPUSSREffect.js");
      context.registerFeatureRenderer(
        FeatureRendererKey.SCREEN_SPACE_REFLECTIONS,
        {
          execute: mod.executeSSR,
          destroy: mod.destroySSRResources,
        },
      );
    },
  );

  // Slice 5c-B Batch 123 — NPR outlines. Opt-in via
  // `scene.enableNPROutlines`; reads G-buffer slot 1 + scene depth to
  // paint silhouette + crease edges. Off by default.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.NPR_OUTLINES,
    async () => {
      const mod = await import("./WebGPUNPROutlineEffect.js");
      context.registerFeatureRenderer(FeatureRendererKey.NPR_OUTLINES, {
        execute: mod.executeNPROutlines,
        destroy: mod.destroyNPROutlineResources,
      });
    },
  );

  // Slice 5c-B Batch 133 — Contact shadows. Opt-in via
  // `scene.enableContactShadows`; reads G-buffer slot 1 + scene depth
  // and marches the sun direction in eye-space, darkening fragments
  // where a screen-space occluder lies within the marched distance.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.CONTACT_SHADOWS,
    async () => {
      const mod = await import("./WebGPUContactShadowsEffect.js");
      context.registerFeatureRenderer(FeatureRendererKey.CONTACT_SHADOWS, {
        execute: mod.executeContactShadows,
        destroy: mod.destroyContactShadowsResources,
      });
    },
  );

  // ── Weather (LAZY) ──
  // WeatherParticles uses compute shaders + GPU particle simulation.
  // Only loaded when scene._enableWeather flips on.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.WEATHER_PARTICLES,
    async () => {
      const mod = await import("./WebGPUWeatherRenderer.js");
      context.registerFeatureRenderer(FeatureRendererKey.WEATHER_PARTICLES, {
        update: mod.updateWeatherParticles,
        render: mod.renderWeatherParticles,
        getParticleBuffer: mod.getWeatherParticleBuffer,
        getMaxParticles: mod.getWeatherMaxParticles,
        destroy: mod.destroyWeatherResources,
      });
    },
  );

  // ── Procedural clouds (LAZY) ──
  // ProceduralClouds is a volumetric raymarcher with several KB of WGSL.
  context.registerFeatureRendererLoader(
    FeatureRendererKey.PROCEDURAL_CLOUDS,
    async () => {
      const mod = await import("./WebGPUProceduralCloudRenderer.js");
      context.registerFeatureRenderer(FeatureRendererKey.PROCEDURAL_CLOUDS, {
        execute: mod.executeProceduralClouds,
        destroy: mod.destroyProceduralCloudResources,
      });
    },
  );

  // ── Scene orchestration ──
  context.registerFeatureRenderer(FeatureRendererKey.SCENE_RENDERER, {
    RendererClass: WebGPUSceneRenderer,
    initPrimitiveShaders,
    initCollectionShaders,
  });
}
