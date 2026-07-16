/**
 * Resolve the CesiumViewer application's startup-only scene options.
 *
 * The explicit `offline=true` mode is reserved for deterministic local tools.
 * Every other query shape preserves the application's normal world imagery and
 * world terrain startup path.
 *
 * @param {object} endUserOptions Parsed CesiumViewer query options.
 * @param {object} factories Dependencies that create normal online resources.
 * @param {Function} factories.createTmsBaseLayer Creates a TMS imagery layer.
 * @param {Function} factories.createWorldTerrain Creates Cesium World Terrain.
 * @returns {object} Viewer startup options shared by both renderers.
 */
export default function resolveCesiumViewerStartupOptions(
  endUserOptions,
  { createTmsBaseLayer, createWorldTerrain },
) {
  if (endUserOptions.offline === "true") {
    return {
      baseLayer: false,
      hasBaseLayerPicker: false,
      terrain: undefined,
      scene3DOnly: endUserOptions.scene3DOnly,
      requestRenderMode: true,
    };
  }

  let baseLayer;
  if (
    endUserOptions.tmsImageryUrl !== undefined &&
    endUserOptions.tmsImageryUrl !== null
  ) {
    baseLayer = createTmsBaseLayer(endUserOptions.tmsImageryUrl);
  }

  return {
    baseLayer,
    hasBaseLayerPicker: baseLayer === undefined || baseLayer === null,
    terrain: createWorldTerrain(),
    scene3DOnly: endUserOptions.scene3DOnly,
    requestRenderMode: true,
  };
}
