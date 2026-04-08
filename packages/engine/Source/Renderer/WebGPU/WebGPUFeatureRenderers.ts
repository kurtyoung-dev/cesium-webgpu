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
  getWebGPUFogParameters,
} from "./WebGPUEnvironmentRenderer.js";
import { updateWebGPUSkyAtmosphere } from "./WebGPUSkyAtmosphereRenderer.js";
import {
  updateCubeMapPanorama,
  destroyCubeMapPanorama,
} from "./WebGPUCubeMapPanoramaRenderer.js";

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

import type GraphicsContext from "../GraphicsContext.js";
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
export function registerWebGPUFeatureRenderers(context: GraphicsContext): void {
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
  });

  context.registerFeatureRenderer(FeatureRendererKey.SKY_ATMOSPHERE, {
    update: updateWebGPUSkyAtmosphere,
  });

  context.registerFeatureRenderer(FeatureRendererKey.FOG, {
    getParameters: getWebGPUFogParameters,
  });

  context.registerFeatureRenderer(FeatureRendererKey.CUBE_MAP_PANORAMA, {
    update: updateCubeMapPanorama,
    destroy: destroyCubeMapPanorama,
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
