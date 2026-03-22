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
import { destroyWebGPUGroundPrimitiveResources } from "./WebGPUGroundPrimitiveRenderer.js";

// ── Globe / Terrain ──
import { WebGPUGlobeSurfaceRenderer } from "./WebGPUGlobeSurfaceRenderer.js";
import { updateWebGPUGlobeTranslucencyDerivedCommands } from "./WebGPUGlobeTranslucencyState.js";

// ── Model ──
import {
  updateWebGPUModel,
  destroyWebGPUModelResources,
} from "./WebGPUModelRenderer.js";

// ── Advanced features ──
import {
  updateWebGPUEllipsoidPrimitive,
  destroyWebGPUEllipsoidPrimitiveResources,
} from "./WebGPUEllipsoidPrimitiveRenderer.js";
import {
  updateWebGPUGaussianSplatPrimitive,
  destroyWebGPUGaussianSplatResources,
} from "./WebGPUGaussianSplatRenderer.js";
import {
  updateWebGPUPointCloud,
  destroyWebGPUPointCloudResources,
} from "./WebGPUPointCloudRenderer.js";
import {
  updateWebGPUPointCloudEDL,
  destroyWebGPUPointCloudEDLResources,
} from "./WebGPUPointCloudEyeDomeLighting.js";
import {
  updateWebGPUVoxelPrimitive,
  destroyWebGPUVoxelResources,
} from "./WebGPUVoxelRenderer.js";
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
    destroy: destroyWebGPUGroundPrimitiveResources,
  });

  // ── Globe / Terrain ──
  context.registerFeatureRenderer(FeatureRendererKey.GLOBE_SURFACE, {
    RendererClass: WebGPUGlobeSurfaceRenderer,
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

  context.registerFeatureRenderer(FeatureRendererKey.GAUSSIAN_SPLAT, {
    update: updateWebGPUGaussianSplatPrimitive,
    destroy: destroyWebGPUGaussianSplatResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.POINT_CLOUD, {
    update: updateWebGPUPointCloud,
    destroy: destroyWebGPUPointCloudResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.POINT_CLOUD_EDL, {
    update: updateWebGPUPointCloudEDL,
    destroy: destroyWebGPUPointCloudEDLResources,
  });

  context.registerFeatureRenderer(FeatureRendererKey.VOXEL_PRIMITIVE, {
    update: updateWebGPUVoxelPrimitive,
    destroy: destroyWebGPUVoxelResources,
  });

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

  // ── Scene orchestration ──
  context.registerFeatureRenderer(FeatureRendererKey.SCENE_RENDERER, {
    RendererClass: WebGPUSceneRenderer,
    initPrimitiveShaders,
    initCollectionShaders,
  });
}
