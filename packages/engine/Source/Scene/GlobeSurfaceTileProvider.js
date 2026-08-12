import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import clone from "../Core/clone.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import Intersect from "../Core/Intersect.js";
import CesiumMath from "../Core/Math.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import Rectangle from "../Core/Rectangle.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import Visibility from "../Core/Visibility.js";
import RenderState from "../Renderer/RenderState.js";
import BlendingState from "./BlendingState.js";
import ClippingPlaneCollection from "./ClippingPlaneCollection.js";
import ClippingPolygonCollection from "./ClippingPolygonCollection.js";
import DepthFunction from "./DepthFunction.js";
import {
  TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY,
  TERRAIN_ECLIPSE_BOUND_SAFETY_METERS,
  updateEclipseGlobeShadowForFrameState,
} from "./EclipseGlobeShadow.js";
import GlobeSurfaceTile from "./GlobeSurfaceTile.js";
import ImageryState from "./ImageryState.js";
import QuadtreeTileLoadState from "./QuadtreeTileLoadState.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import TerrainFillMesh from "./TerrainFillMesh.js";
import TerrainState from "./TerrainState.js";
import TileSelectionResult from "./TileSelectionResult.js";
import {
  addDrawCommandsForTile,
  updateWebGPUForPick,
  updateTileBoundingRegion,
  pushCommand,
  isUndergroundVisible,
  clipRectangleAntimeridian,
} from "./GlobeSurfaceTileProviderRendering.js";

const boundingSphereScratch = new BoundingSphere();
const rectangleIntersectionScratch = new Rectangle();
const tileDirectionScratch = new Cartesian3();
// HeightmapTerrainData caps synthesized fill skirts at 1000 m. Fill vertices
// interpolate loaded source meshes, so extending the resource-level minimum by
// that cap encloses fill geometry without revisiting selected tiles.
const ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS = 1000.0;

function resetKnownTerrainEclipseBounds(tileProvider) {
  tileProvider._eclipseKnownMeshes = new WeakSet();
  tileProvider._eclipseKnownMinimumHeight = 0.0;
  tileProvider._eclipseKnownMaximumHeight = 0.0;
  tileProvider._eclipseKnownBoundsValid = true;
}

/**
 * Fold a newly realized terrain resource into the provider-wide raw-height
 * envelope. This runs on the asynchronous tile-load path once per mesh, not
 * in selection or command generation.
 *
 * @param {GlobeSurfaceTileProvider} tileProvider
 * @param {object} mesh
 * @private
 */
function observeTerrainMeshForEclipse(tileProvider, mesh) {
  if (!defined(mesh) || tileProvider._eclipseKnownMeshes.has(mesh)) {
    return;
  }
  tileProvider._eclipseKnownMeshes.add(mesh);

  let minimumHeight = mesh.encoding?.minimumHeight;
  let maximumHeight = mesh.encoding?.maximumHeight;
  if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight)) {
    const indexLength = mesh.indices?.length;
    const noSkirtsProven =
      Number.isFinite(indexLength) &&
      Number.isFinite(mesh.indexCountWithoutSkirts) &&
      indexLength === mesh.indexCountWithoutSkirts;
    if (!noSkirtsProven) {
      tileProvider._eclipseKnownBoundsValid = false;
      return;
    }
    minimumHeight = mesh.minimumHeight;
    maximumHeight = mesh.maximumHeight;
  }
  if (!Number.isFinite(minimumHeight) || !Number.isFinite(maximumHeight)) {
    tileProvider._eclipseKnownBoundsValid = false;
    return;
  }

  tileProvider._eclipseKnownMinimumHeight = Math.min(
    tileProvider._eclipseKnownMinimumHeight,
    minimumHeight,
  );
  tileProvider._eclipseKnownMaximumHeight = Math.max(
    tileProvider._eclipseKnownMaximumHeight,
    maximumHeight,
  );
}

/**
 * Compute an origin-centred sphere enclosing every terrain resource observed
 * by the provider, including possible fill skirts and current exaggeration.
 *
 * @param {GlobeSurfaceTileProvider} tileProvider
 * @param {FrameState} frameState
 * @returns {number|undefined}
 * @private
 */
function computeKnownTerrainEclipseSurfaceRadius(tileProvider, frameState) {
  const ellipsoidMaximumRadius =
    tileProvider.tilingScheme?.ellipsoid?.maximumRadius;
  if (
    tileProvider._eclipseKnownBoundsValid !== true ||
    !Number.isFinite(ellipsoidMaximumRadius)
  ) {
    return undefined;
  }

  const exaggeration = frameState.verticalExaggeration ?? 1.0;
  const relativeHeight = frameState.verticalExaggerationRelativeHeight ?? 0.0;
  const exaggeratedMinimumHeight = VerticalExaggeration.getHeight(
    tileProvider._eclipseKnownMinimumHeight -
      ECLIPSE_FILL_SKIRT_ALLOWANCE_METERS,
    exaggeration,
    relativeHeight,
  );
  const exaggeratedMaximumHeight = VerticalExaggeration.getHeight(
    tileProvider._eclipseKnownMaximumHeight,
    exaggeration,
    relativeHeight,
  );
  if (
    !Number.isFinite(exaggeratedMinimumHeight) ||
    !Number.isFinite(exaggeratedMaximumHeight)
  ) {
    return undefined;
  }

  const unprotectedRadius =
    ellipsoidMaximumRadius +
    Math.max(
      Math.abs(exaggeratedMinimumHeight),
      Math.abs(exaggeratedMaximumHeight),
    );
  const safety = Math.max(
    TERRAIN_ECLIPSE_BOUND_SAFETY_METERS,
    unprotectedRadius * TERRAIN_ECLIPSE_BOUND_RELATIVE_SAFETY,
  );
  return unprotectedRadius + safety;
}

function markSceneCaptureContentChanged(tileProvider) {
  tileProvider._sceneCaptureContentRevision =
    (tileProvider._sceneCaptureContentRevision ?? 0) + 1;
}

function getSceneCaptureResourceId(tileProvider, resource) {
  if (
    !defined(resource) ||
    (typeof resource !== "object" && typeof resource !== "function")
  ) {
    return 0;
  }

  let resourceIds = tileProvider._sceneCaptureResourceIds;
  if (!defined(resourceIds)) {
    resourceIds = new WeakMap();
    tileProvider._sceneCaptureResourceIds = resourceIds;
  }

  let id = resourceIds.get(resource);
  if (!defined(id)) {
    id = tileProvider._nextSceneCaptureResourceId++;
    resourceIds.set(resource, id);
  }
  return id;
}

function mixSceneCaptureHash(hash, value, prime) {
  return Math.imul(hash ^ (value >>> 0), prime) >>> 0;
}

/**
 * Advance the producer content epoch when the selected terrain or imagery
 * resources change. This scan is feature-gated, reuses two scalar hashes, and
 * allocates no per-tile records. Resource identities live in a lazy WeakMap so
 * mesh/imagery replacement is visible even when tile coordinates stay fixed.
 *
 * @param {GlobeSurfaceTileProvider} tileProvider
 * @param {FrameState} frameState
 * @private
 */
function updateSceneCaptureContentRevision(tileProvider, frameState) {
  if (frameState.context.sceneCaptureReflections !== true) {
    return;
  }

  const tiles = tileProvider._quadtree._tilesToRender;
  let hashA = 2166136261;
  let hashB = 2246822519;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const surfaceTile = tile.data;
    const mesh = surfaceTile?.renderedMesh;
    const meshId = getSceneCaptureResourceId(tileProvider, mesh);
    const vertexId = getSceneCaptureResourceId(tileProvider, mesh?.vertices);
    const indexId = getSceneCaptureResourceId(tileProvider, mesh?.indices);

    hashA = mixSceneCaptureHash(hashA, tile.level, 16777619);
    hashA = mixSceneCaptureHash(hashA, tile.x, 16777619);
    hashA = mixSceneCaptureHash(hashA, tile.y, 16777619);
    hashA = mixSceneCaptureHash(hashA, meshId, 16777619);
    hashA = mixSceneCaptureHash(hashA, vertexId, 16777619);
    hashA = mixSceneCaptureHash(hashA, indexId, 16777619);
    hashA = mixSceneCaptureHash(
      hashA,
      mesh === surfaceTile?.mesh ? 1 : 0,
      16777619,
    );

    hashB = mixSceneCaptureHash(hashB, tile.level, 3266489917);
    hashB = mixSceneCaptureHash(hashB, tile.x, 3266489917);
    hashB = mixSceneCaptureHash(hashB, tile.y, 3266489917);
    hashB = mixSceneCaptureHash(hashB, meshId, 3266489917);
    hashB = mixSceneCaptureHash(hashB, vertexId, 3266489917);
    hashB = mixSceneCaptureHash(hashB, indexId, 3266489917);

    const imagery = surfaceTile?.imagery;
    const imageryLength = imagery?.length ?? 0;
    hashA = mixSceneCaptureHash(hashA, imageryLength, 16777619);
    hashB = mixSceneCaptureHash(hashB, imageryLength, 3266489917);
    for (let j = 0; j < imageryLength; j++) {
      const readyImagery = imagery[j].readyImagery;
      const texture = readyImagery?.texture ?? readyImagery;
      const imageryResourceId = getSceneCaptureResourceId(
        tileProvider,
        readyImagery,
      );
      const imageryId = getSceneCaptureResourceId(tileProvider, texture);
      const layerIndex = readyImagery?.imageryLayer?._layerIndex ?? -1;
      hashA = mixSceneCaptureHash(hashA, imageryResourceId, 16777619);
      hashA = mixSceneCaptureHash(hashA, imageryId, 16777619);
      hashA = mixSceneCaptureHash(hashA, layerIndex, 16777619);
      hashB = mixSceneCaptureHash(hashB, imageryResourceId, 3266489917);
      hashB = mixSceneCaptureHash(hashB, imageryId, 3266489917);
      hashB = mixSceneCaptureHash(hashB, layerIndex, 3266489917);
    }
  }

  if (
    tileProvider._sceneCaptureSelectionLength !== tiles.length ||
    tileProvider._sceneCaptureSelectionHashA !== hashA ||
    tileProvider._sceneCaptureSelectionHashB !== hashB
  ) {
    tileProvider._sceneCaptureSelectionLength = tiles.length;
    tileProvider._sceneCaptureSelectionHashA = hashA;
    tileProvider._sceneCaptureSelectionHashB = hashB;
    markSceneCaptureContentChanged(tileProvider);
  }
}
/** @import Context from "../Renderer/Context.js"; */
/** @import EllipsoidalOccluder from "../Core/EllipsoidalOccluder.js"; */
/** @import FrameState from "./FrameState.js"; */
/** @import GlobeSurfaceShaderSet from "./GlobeSurfaceShaderSet.js"; */
/** @import ImageryLayerCollection from "./ImageryLayerCollection.js"; */
/** @import QuadtreeOccluders from "./QuadtreeOccluders.js"; */
/** @import QuadtreePrimitive from "./QuadtreePrimitive.js"; */
/** @import QuadtreeTile from "./QuadtreeTile.js"; */
/** @import TerrainMesh from "../Core/TerrainMesh.js"; */
/** @import TerrainProvider from "../Core/TerrainProvider.js"; */
/** @import TilingScheme from "../Core/TilingScheme.js"; */
/** @import VectorProvider, { VectorTileData } from "../Core/VectorProvider.js"; */
/** @import { GlobeSurfaceShaderSetOptions } from "./GlobeSurfaceShaderSet.js"; */

/**
 * Provides quadtree tiles representing the surface of the globe.  This type is intended to be used
 * with {@link QuadtreePrimitive}.
 *
 * @alias GlobeSurfaceTileProvider
 *
 * @param {object} options Object with the following properties:
 * @param {TerrainProvider} options.terrainProvider The terrain provider that describes the surface geometry.
 * @param {ImageryLayerCollection} options.imageryLayers The collection of imagery layers describing the shading of the surface.
 * @param {GlobeSurfaceShaderSet} options.surfaceShaderSet The set of shaders used to render the surface.
 *
 * @private
 */
class GlobeSurfaceTileProvider {
  /**
   * @param {object} options
   * @param {TerrainProvider} options.terrainProvider The terrain provider that describes the surface geometry.
   * @param {ImageryLayerCollection} options.imageryLayers The collection of imagery layers describing the shading of the surface.
   * @param {GlobeSurfaceShaderSet} options.surfaceShaderSet The set of shaders used to render the surface.
   * @param {VectorProvider} options.vectorProvider
   */
  constructor(options) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options)) {
      throw new DeveloperError("options is required.");
    }
    if (!defined(options.terrainProvider)) {
      throw new DeveloperError("options.terrainProvider is required.");
    } else if (!defined(options.imageryLayers)) {
      throw new DeveloperError("options.imageryLayers is required.");
    } else if (!defined(options.surfaceShaderSet)) {
      throw new DeveloperError("options.surfaceShaderSet is required.");
    } else if (!defined(options.vectorProvider)) {
      throw new DeveloperError("options.vectorProvider is required.");
    }
    //>>includeEnd('debug');

    this.lightingFadeOutDistance = 6500000.0;
    this.lightingFadeInDistance = 9000000.0;
    this.hasWaterMask = false;
    this.showWaterEffect = false;
    // Mirrored from Globe each frame while `globe.lakeWaterMask` is on, and
    // left undefined otherwise. GlobeSurfaceTile's shared water-mask upload
    // point consumes it to OR lake coverage over the terrain provider's
    // ocean-only mask. See `Scene/WaterClassificationProvider.ts`.
    this.waterClassificationProvider = undefined;
    this.oceanNormalMap = undefined;
    this.zoomedOutOceanSpecularIntensity = 0.5;
    this.enableLighting = false;
    // Backend-neutral, per-frame mirror of Globe.terminatorGlowStrength.
    // Zero is the natural/parity identity; renderers branch before evaluating
    // the optional exponential glow term.
    this.terminatorGlowStrength = 0.0;
    this.dynamicAtmosphereLighting = false;
    this.dynamicAtmosphereLightingFromSun = false;
    this.showGroundAtmosphere = false;
    this.shadows = ShadowMode.RECEIVE_ONLY;
    this.vertexShadowDarkness = 0.3;

    /**
     * The color to use to highlight terrain fill tiles. If undefined, fill tiles are not
     * highlighted at all. The alpha value is used to alpha blend with the tile's
     * actual color. Because terrain fill tiles do not represent the actual terrain surface,
     * it may be useful in some applications to indicate visually that they are not to be trusted.
     * @type {Color}
     * @default undefined
     */
    this.fillHighlightColor = undefined;

    this.hueShift = 0.0;
    this.saturationShift = 0.0;
    this.brightnessShift = 0.0;

    this.showSkirts = true;
    this.backFaceCulling = true;
    this.undergroundColor = undefined;
    this.undergroundColorAlphaByDistance = undefined;

    this.lambertDiffuseMultiplier = 0.0;

    this.materialUniformMap = undefined;
    this._materialUniformMap = undefined;

    this._quadtree = undefined;
    this._terrainProvider = options.terrainProvider;
    this._vectorProvider = options.vectorProvider;
    this._imageryLayers = options.imageryLayers;
    this._surfaceShaderSet = options.surfaceShaderSet;

    this._renderState = undefined;
    this._blendRenderState = undefined;
    this._disableCullingRenderState = undefined;
    this._disableCullingBlendRenderState = undefined;

    this._errorEvent = new Event();

    this._removeLayerAddedListener =
      this._imageryLayers.layerAdded.addEventListener(
        GlobeSurfaceTileProvider.prototype._onLayerAdded,
        this,
      );
    this._removeLayerRemovedListener =
      this._imageryLayers.layerRemoved.addEventListener(
        GlobeSurfaceTileProvider.prototype._onLayerRemoved,
        this,
      );
    this._removeLayerMovedListener =
      this._imageryLayers.layerMoved.addEventListener(
        GlobeSurfaceTileProvider.prototype._onLayerMoved,
        this,
      );
    this._removeLayerShownListener =
      this._imageryLayers.layerShownOrHidden.addEventListener(
        GlobeSurfaceTileProvider.prototype._onLayerShownOrHidden,
        this,
      );
    this._imageryLayersUpdatedEvent = new Event();

    this._layerOrderChanged = false;

    this._tilesToRenderByTextureCount = [];
    this._drawCommands = [];
    this._uniformMaps = [];
    this._usedDrawCommands = 0;

    this._vertexArraysToDestroy = [];

    this._debug = {
      wireframe: false,
      boundingSphereTile: undefined,
    };

    this._baseColor = undefined;
    this._firstPassInitialColor = undefined;
    this.baseColor = new Color(0.0, 0.0, 0.5, 1.0);

    /**
     * A property specifying a {@link ClippingPlaneCollection} used to selectively disable rendering on the outside of each plane.
     * @type {ClippingPlaneCollection}
     * @private
     */
    this._clippingPlanes = undefined;

    /**
     * A property specifying a {@link ClippingPolygonCollection} used to selectively disable rendering inside or outside a list of polygons.
     * @type {ClippingPolygonCollection}
     * @private
     */
    this._clippingPolygons = undefined;

    /**
     * A property specifying a {@link Rectangle} used to selectively limit terrain and imagery rendering.
     * @type {Rectangle}
     */
    this.cartographicLimitRectangle = Rectangle.clone(Rectangle.MAX_VALUE);

    this._hasLoadedTilesThisFrame = false;
    this._hasFillTilesThisFrame = false;

    this._oldVerticalExaggeration = undefined;
    this._oldVerticalExaggerationRelativeHeight = undefined;
    this._oldSceneMode = SceneMode.SCENE3D;

    // Retained O(1) activation envelope for the rendered terrain. Raw height
    // extrema are folded in once, when mesh resources become ready, so
    // ordinary selection and command generation do no eclipse work.
    this._eclipseSurfaceRadius = undefined;
    this._eclipseSelectionRevision = 0;
    resetKnownTerrainEclipseBounds(this);

    // Dynamic-environment scene capture consumes the prior frame's selected
    // resources. Keep one producer epoch for identity/content changes so a
    // stationary request-render scene gets one fresh capture instead of
    // waiting for the ordinary eight-frame cadence.
    this._sceneCaptureContentRevision = 0;
    this._sceneCaptureSelectionLength = -1;
    this._sceneCaptureSelectionHashA = undefined;
    this._sceneCaptureSelectionHashB = undefined;
    this._sceneCaptureResourceIds = undefined;
    this._nextSceneCaptureResourceId = 1;
  }

  /**
   * Gets or sets the color of the globe when no imagery is available.
   * @type {Color}
   */
  get baseColor() {
    return this._baseColor;
  }

  set baseColor(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    this._baseColor = value;
    this._firstPassInitialColor = Cartesian4.fromColor(
      value,
      this._firstPassInitialColor,
    );
  }

  /**
   * Gets or sets the {@link QuadtreePrimitive} for which this provider is
   * providing tiles.
   * @type {QuadtreePrimitive}
   */
  get quadtree() {
    return this._quadtree;
  }

  set quadtree(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    this._quadtree = value;
  }

  /**
   * Gets the tiling scheme used by the provider.
   * @type {TilingScheme}
   */
  get tilingScheme() {
    if (!defined(this._terrainProvider)) {
      return undefined;
    }
    return this._terrainProvider.tilingScheme;
  }

  /**
   * Gets an event that is raised when the geometry provider encounters an asynchronous error.
   * @type {Event}
   */
  get errorEvent() {
    return this._errorEvent;
  }

  /**
   * Gets an event that is raised when an imagery layer is added, shown, hidden, moved, or removed.
   * @type {Event}
   */
  get imageryLayersUpdatedEvent() {
    return this._imageryLayersUpdatedEvent;
  }

  /**
   * Gets or sets the terrain provider that describes the surface geometry.
   * @type {TerrainProvider}
   */
  get terrainProvider() {
    return this._terrainProvider;
  }

  set terrainProvider(terrainProvider) {
    if (this._terrainProvider === terrainProvider) {
      return;
    }

    this._terrainProvider = terrainProvider;
    markSceneCaptureContentChanged(this);
    this._eclipseSurfaceRadius = undefined;
    resetKnownTerrainEclipseBounds(this);

    if (defined(this._quadtree)) {
      this._quadtree.invalidateAllTiles();
    }
  }

  /** @type {VectorProvider} */
  get vectorProvider() {
    return this._vectorProvider;
  }

  /**
   * The {@link ClippingPlaneCollection} used to selectively disable rendering.
   * @type {ClippingPlaneCollection}
   * @private
   */
  get clippingPlanes() {
    return this._clippingPlanes;
  }

  set clippingPlanes(value) {
    ClippingPlaneCollection.setOwner(value, this, "_clippingPlanes");
  }

  /**
   * The {@link ClippingPolygonCollection} used to selectively disable rendering inside or outside a list of polygons.
   * @type {ClippingPolygonCollection}
   * @private
   */
  get clippingPolygons() {
    return this._clippingPolygons;
  }

  set clippingPolygons(value) {
    ClippingPolygonCollection.setOwner(value, this, "_clippingPolygons");
  }

  /**
   * Make updates to the tile provider that are not involved in rendering. Called before the render update cycle.
   */
  update(frameState) {
    this._imageryLayers._update();
  }

  /**
   * Called at the beginning of each render frame, before {@link QuadtreeTileProvider#showTileThisFrame}
   * @param {FrameState} frameState The frame state.
   */
  initialize(frameState) {
    this._imageryLayers.queueReprojectionCommands(frameState);

    if (this._layerOrderChanged) {
      this._layerOrderChanged = false;
      this._quadtree.forEachLoadedTile(function (tile) {
        tile.data.imagery.sort(sortTileImageryByLayerIndex);
      });
    }

    // Record regions dirtied by changed collections, re-bake overlapping
    // tiles, and build vector data for new surface tiles.
    const vectorProvider = this._vectorProvider;
    vectorProvider.update();
    this._quadtree.forEachRenderedTile(
      /** @param {QuadtreeTile} tile */
      (tile) => {
        const surfaceTile = /** @type {GlobeSurfaceTile} */ (tile.data);

        if (defined(surfaceTile.vectorData)) {
          surfaceTile.vectorData = vectorProvider.updateTileData(
            tile.x,
            tile.y,
            tile.level,
            frameState.context,
            surfaceTile.vectorData,
          );
        } else {
          surfaceTile.vectorData = vectorProvider.requestTileData(
            tile.x,
            tile.y,
            tile.level,
            frameState.context,
          );
        }
      },
    );
    vectorProvider.makeClean();

    // Add credits for terrain and imagery providers.
    updateCredits(this, frameState);

    const vertexArraysToDestroy = this._vertexArraysToDestroy;
    const length = vertexArraysToDestroy.length;
    for (let j = 0; j < length; ++j) {
      GlobeSurfaceTile._freeVertexArray(vertexArraysToDestroy[j]);
    }
    vertexArraysToDestroy.length = 0;
  }

  /**
   * Called at the beginning of the update cycle for each render frame.
   * @param {FrameState} frameState The frame state.
   */
  beginUpdate(frameState) {
    const tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
    for (let i = 0, len = tilesToRenderByTextureCount.length; i < len; ++i) {
      const tiles = tilesToRenderByTextureCount[i];
      if (defined(tiles)) {
        tiles.length = 0;
      }
    }

    const clippingPlanes = this._clippingPlanes;
    if (defined(clippingPlanes) && clippingPlanes.enabled) {
      clippingPlanes.update(frameState);
    }

    const clippingPolygons = this._clippingPolygons;
    if (defined(clippingPolygons) && clippingPolygons.enabled) {
      clippingPolygons.update(frameState);
      clippingPolygons.queueCommands(frameState);
    }

    this._usedDrawCommands = 0;
    this._hasLoadedTilesThisFrame = false;
    this._hasFillTilesThisFrame = false;
  }

  /**
   * Called at the end of the update cycle for each render frame.
   * @param {FrameState} frameState The frame state.
   */
  endUpdate(frameState) {
    if (!defined(this._renderState)) {
      this._renderState = RenderState.fromCache({
        cull: { enabled: true },
        depthTest: { enabled: true, func: DepthFunction.LESS },
      });

      this._blendRenderState = RenderState.fromCache({
        cull: { enabled: true },
        depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
        blending: BlendingState.ALPHA_BLEND,
      });

      let rs = clone(this._renderState, true);
      rs.cull.enabled = false;
      this._disableCullingRenderState = RenderState.fromCache(rs);

      rs = clone(this._blendRenderState, true);
      rs.cull.enabled = false;
      this._disableCullingBlendRenderState = RenderState.fromCache(rs);
    }

    if (this._hasFillTilesThisFrame && this._hasLoadedTilesThisFrame) {
      TerrainFillMesh.updateFillTiles(
        this,
        this._quadtree._tilesToRender,
        frameState,
        this._vertexArraysToDestroy,
      );
    }

    const quadtree = this.quadtree;
    const exaggeration = frameState.verticalExaggeration;
    const exaggerationRelativeHeight =
      frameState.verticalExaggerationRelativeHeight;
    const exaggerationChanged =
      this._oldVerticalExaggeration !== exaggeration ||
      this._oldVerticalExaggerationRelativeHeight !==
        exaggerationRelativeHeight;

    this._oldVerticalExaggeration = exaggeration;
    this._oldVerticalExaggerationRelativeHeight = exaggerationRelativeHeight;

    if (exaggerationChanged) {
      markSceneCaptureContentChanged(this);
      quadtree.forEachLoadedTile(function (tile) {
        const surfaceTile = tile.data;
        surfaceTile.updateExaggeration(tile, frameState, quadtree);
      });
    }

    const sceneModeChanged = this._oldSceneMode !== frameState.mode;
    this._oldSceneMode = frameState.mode;

    if (sceneModeChanged) {
      quadtree.forEachLoadedTile(function (tile) {
        const surfaceTile = tile.data;
        surfaceTile.updateSceneMode(frameState.mode);
      });
    }

    this._eclipseSurfaceRadius = computeKnownTerrainEclipseSurfaceRadius(
      this,
      frameState,
    );
    this._eclipseSelectionRevision++;

    // The current selection and exaggeration bounds are authoritative, so
    // reclassify before any tile command captures or binds the view-owned
    // block.
    updateEclipseGlobeShadowForFrameState(
      frameState,
      this._eclipseSurfaceRadius,
      this._quadtree._tilesToRender,
      this._eclipseSelectionRevision,
    );

    updateSceneCaptureContentRevision(this, frameState);

    // Optional visibility and execution ownership audit; the performance
    // runner attaches this observer only in its separately instrumented lane.
    // Production pays one context-field read and two frame-level guards, and
    // tile compilation itself gains no diagnostic allocation or per-tile
    // branch.
    const ownershipDiagnostics =
      frameState.context._visibilityExecutionOwnershipDiagnostics;
    const ownershipCommandListStart = defined(ownershipDiagnostics)
      ? frameState.commandList.length
      : 0;
    if (defined(ownershipDiagnostics)) {
      ownershipDiagnostics.beginTerrainCompilation(
        frameState.frameNumber,
        this._quadtree._tilesToRender,
        this._tilesToRenderByTextureCount,
      );
    }

    const tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
    for (
      let textureCountIndex = 0,
        textureCountLength = tilesToRenderByTextureCount.length;
      textureCountIndex < textureCountLength;
      ++textureCountIndex
    ) {
      const tilesToRender = tilesToRenderByTextureCount[textureCountIndex];
      if (!defined(tilesToRender)) {
        continue;
      }

      for (
        let tileIndex = 0, tileLength = tilesToRender.length;
        tileIndex < tileLength;
        ++tileIndex
      ) {
        const tile = tilesToRender[tileIndex];
        const tileBoundingRegion = tile.data.tileBoundingRegion;
        addDrawCommandsForTile(this, tile, frameState);
        frameState.minimumTerrainHeight = Math.min(
          frameState.minimumTerrainHeight,
          tileBoundingRegion.minimumHeight,
        );
      }
    }

    if (defined(ownershipDiagnostics)) {
      ownershipDiagnostics.endTerrainCompilation(
        frameState.frameNumber,
        frameState.commandList,
        ownershipCommandListStart,
      );
    }
  }

  /**
   * Adds draw commands for tiles rendered in the previous frame for a pick pass.
   * @param {FrameState} frameState The frame state.
   */
  updateForPick(frameState) {
    // Pick mini-frames reuse the retained render list but prepare a fresh
    // logical View/frame. Rebind S5 against those exact tile bounds before
    // WebGPU rebuilds commands or WebGL re-pushes its retained commands.
    updateEclipseGlobeShadowForFrameState(
      frameState,
      this._eclipseSurfaceRadius,
      this._quadtree._tilesToRender,
      this._eclipseSelectionRevision,
    );

    const ownershipDiagnostics =
      frameState.context._visibilityExecutionOwnershipDiagnostics;
    const ownershipCommandListStart = defined(ownershipDiagnostics)
      ? frameState.commandList.length
      : 0;
    if (defined(ownershipDiagnostics)) {
      ownershipDiagnostics.beginTerrainPickCompilation(
        frameState.frameNumber,
        this._quadtree._tilesToRender,
        this._tilesToRenderByTextureCount,
      );
    }

    // WebGPU rebuilds fresh globe commands, with the pick command attached,
    // for the selected tiles in the pick frame, so the WebGL `_drawCommands`
    // re-push below is skipped; it is empty on WebGPU in any case.
    const webGPUHandled = updateWebGPUForPick(this, frameState);
    if (!webGPUHandled) {
      const drawCommands = this._drawCommands;
      for (let i = 0, length = this._usedDrawCommands; i < length; ++i) {
        // The pooled WebGL command was built by the prior on-screen view.
        // Rebind the property-backed eclipse block before an offscreen or pick
        // view re-pushes it, or the derived pick fragment shader runs its
        // eclipse arithmetic against the default view's geometry.
        this._uniformMaps[i].properties.eclipseGlobeShadow =
          frameState.eclipseGlobeShadow;
        pushCommand(drawCommands[i], frameState);
      }
    }

    if (defined(ownershipDiagnostics)) {
      ownershipDiagnostics.endTerrainPickCompilation(
        frameState.frameNumber,
        frameState.commandList,
        ownershipCommandListStart,
      );
    }
  }

  /**
   * Cancels any imagery re-projections in the queue.
   */
  cancelReprojections() {
    this._imageryLayers.cancelReprojections();
  }

  /**
   * Gets the maximum geometric error allowed in a tile at a given level, in meters.
   * @param {number} level The tile level for which to get the maximum geometric error.
   * @returns {number} The maximum geometric error in meters.
   */
  getLevelMaximumGeometricError(level) {
    if (!defined(this._terrainProvider)) {
      return 0;
    }
    return this._terrainProvider.getLevelMaximumGeometricError(level);
  }

  /**
   * Loads, or continues loading, a given tile.
   * @param {FrameState} frameState The frame state.
   * @param {QuadtreeTile} tile The tile to load.
   */
  loadTile(frameState, tile) {
    let surfaceTile = tile.data;
    let terrainOnly = true;
    let terrainStateBefore;
    if (defined(surfaceTile)) {
      terrainOnly =
        surfaceTile.boundingVolumeSourceTile !== tile ||
        tile._lastSelectionResult === TileSelectionResult.CULLED_BUT_NEEDED;
      terrainStateBefore = surfaceTile.terrainState;
    }

    GlobeSurfaceTile.processStateMachine(
      tile,
      frameState,
      this.terrainProvider,
      this.vectorProvider,
      this._imageryLayers,
      this.quadtree,
      this._vertexArraysToDestroy,
      terrainOnly,
    );

    surfaceTile = tile.data;
    if (terrainOnly && terrainStateBefore !== tile.data.terrainState) {
      if (
        this.computeTileVisibility(
          tile,
          frameState,
          this.quadtree.occluders,
        ) !== Visibility.NONE &&
        surfaceTile.boundingVolumeSourceTile === tile
      ) {
        terrainOnly = false;
        GlobeSurfaceTile.processStateMachine(
          tile,
          frameState,
          this.terrainProvider,
          this.vectorProvider,
          this._imageryLayers,
          this.quadtree,
          this._vertexArraysToDestroy,
          terrainOnly,
        );
      }
    }

    // Resource publication edge: fold each realized mesh into S5's global
    // height envelope once. This is deliberately outside the render-selection
    // and command hot paths.
    observeTerrainMeshForEclipse(this, tile.data?.mesh);
  }

  /**
   * Determines the visibility of a given tile.
   * @param {QuadtreeTile} tile The tile instance.
   * @param {FrameState} frameState The state information about the current frame.
   * @param {QuadtreeOccluders} occluders The objects that may occlude this tile.
   * @returns {Visibility} The visibility of the tile.
   */
  computeTileVisibility(tile, frameState, occluders) {
    const distance = this.computeDistanceToTile(tile, frameState);
    tile._distance = distance;

    const undergroundVisible = isUndergroundVisible(this, frameState);

    if (frameState.fog.enabled && !undergroundVisible) {
      if (CesiumMath.fog(distance, frameState.fog.density) >= 1.0) {
        return Visibility.NONE;
      }
    }

    const surfaceTile = tile.data;
    const tileBoundingRegion = surfaceTile.tileBoundingRegion;

    if (surfaceTile.boundingVolumeSourceTile === undefined) {
      return Visibility.PARTIAL;
    }

    const cullingVolume = frameState.cullingVolume;
    let boundingVolume = tileBoundingRegion.boundingVolume;

    if (!defined(boundingVolume)) {
      boundingVolume = tileBoundingRegion.boundingSphere;
    }

    surfaceTile.clippedByBoundaries = false;
    const clippedCartographicLimitRectangle = clipRectangleAntimeridian(
      tile.rectangle,
      this.cartographicLimitRectangle,
    );
    const areaLimitIntersection = Rectangle.simpleIntersection(
      clippedCartographicLimitRectangle,
      tile.rectangle,
      rectangleIntersectionScratch,
    );
    if (!defined(areaLimitIntersection)) {
      return Visibility.NONE;
    }
    if (!Rectangle.equals(areaLimitIntersection, tile.rectangle)) {
      surfaceTile.clippedByBoundaries = true;
    }

    if (frameState.mode !== SceneMode.SCENE3D) {
      boundingVolume = boundingSphereScratch;
      BoundingSphere.fromRectangleWithHeights2D(
        tile.rectangle,
        frameState.mapProjection,
        tileBoundingRegion.minimumHeight,
        tileBoundingRegion.maximumHeight,
        boundingVolume,
      );
      Cartesian3.fromElements(
        boundingVolume.center.z,
        boundingVolume.center.x,
        boundingVolume.center.y,
        boundingVolume.center,
      );

      if (
        frameState.mode === SceneMode.MORPHING &&
        defined(surfaceTile.renderedMesh)
      ) {
        boundingVolume = BoundingSphere.union(
          tileBoundingRegion.boundingSphere,
          boundingVolume,
          boundingVolume,
        );
      }
    }

    if (!defined(boundingVolume)) {
      return Visibility.PARTIAL;
    }

    const clippingPlanes = this._clippingPlanes;
    if (defined(clippingPlanes) && clippingPlanes.enabled) {
      const planeIntersection =
        clippingPlanes.computeIntersectionWithBoundingVolume(boundingVolume);
      tile.isClipped = planeIntersection !== Intersect.INSIDE;
      if (planeIntersection === Intersect.OUTSIDE) {
        return Visibility.NONE;
      }
    }

    const clippingPolygons = this._clippingPolygons;
    if (defined(clippingPolygons) && clippingPolygons.enabled) {
      const polygonIntersection =
        clippingPolygons.computeIntersectionWithBoundingVolume(
          tileBoundingRegion,
        );
      tile.isClipped = polygonIntersection !== Intersect.OUTSIDE;
    }

    let visibility;
    const intersection = cullingVolume.computeVisibility(boundingVolume);

    if (intersection === Intersect.OUTSIDE) {
      visibility = Visibility.NONE;
    } else if (intersection === Intersect.INTERSECTING) {
      visibility = Visibility.PARTIAL;
    } else if (intersection === Intersect.INSIDE) {
      visibility = Visibility.FULL;
    }

    if (visibility === Visibility.NONE) {
      return visibility;
    }

    const ortho3D =
      frameState.mode === SceneMode.SCENE3D &&
      frameState.camera.frustum instanceof OrthographicFrustum;
    if (
      frameState.mode === SceneMode.SCENE3D &&
      !ortho3D &&
      defined(occluders) &&
      !undergroundVisible
    ) {
      const occludeePointInScaledSpace = surfaceTile.occludeePointInScaledSpace;
      if (!defined(occludeePointInScaledSpace)) {
        return visibility;
      }

      if (
        occluders.ellipsoid.isScaledSpacePointVisiblePossiblyUnderEllipsoid(
          occludeePointInScaledSpace,
          tileBoundingRegion.minimumHeight,
        )
      ) {
        return visibility;
      }

      return Visibility.NONE;
    }

    return visibility;
  }

  /**
   * Determines if the given tile can be refined.
   * @param {QuadtreeTile} tile The tile to check.
   * @returns {boolean} True if the tile can be refined.
   */
  canRefine(tile) {
    if (defined(tile.data.terrainData)) {
      return true;
    }
    const childAvailable = this.terrainProvider.getTileDataAvailable(
      tile.x * 2,
      tile.y * 2,
      tile.level + 1,
    );
    return childAvailable !== undefined;
  }

  /**
   * Determines if the given not-fully-loaded tile can be rendered without losing detail.
   * @param {QuadtreeTile} tile The tile to check.
   * @param {FrameState} frameState The frame state.
   * @returns {boolean} True if the tile can be rendered without losing detail.
   */
  canRenderWithoutLosingDetail(tile, frameState) {
    const surfaceTile = tile.data;

    const readyImagery = readyImageryScratch;
    readyImagery.length = this._imageryLayers.length;

    let terrainReady = false;
    let initialImageryState = false;
    let imagery;

    if (defined(surfaceTile)) {
      terrainReady = surfaceTile.terrainState === TerrainState.READY;
      initialImageryState = true;
      imagery = surfaceTile.imagery;
    }

    let i;
    let len;

    for (i = 0, len = readyImagery.length; i < len; ++i) {
      readyImagery[i] = initialImageryState;
    }

    if (defined(imagery)) {
      for (i = 0, len = imagery.length; i < len; ++i) {
        const tileImagery = imagery[i];
        const loadingImagery = tileImagery.loadingImagery;
        const isReady =
          !defined(loadingImagery) ||
          loadingImagery.state === ImageryState.FAILED ||
          loadingImagery.state === ImageryState.INVALID;
        const layerIndex = (
          tileImagery.loadingImagery || tileImagery.readyImagery
        ).imageryLayer._layerIndex;

        readyImagery[layerIndex] = isReady && readyImagery[layerIndex];
      }
    }

    const lastFrame = this.quadtree._lastSelectionFrameNumber;

    const stack = canRenderTraversalStack;
    stack.length = 0;
    stack.push(
      tile.southwestChild,
      tile.southeastChild,
      tile.northwestChild,
      tile.northeastChild,
    );

    while (stack.length > 0) {
      const descendant = stack.pop();
      const lastFrameSelectionResult =
        descendant._lastSelectionResultFrame === lastFrame
          ? descendant._lastSelectionResult
          : TileSelectionResult.NONE;

      if (lastFrameSelectionResult === TileSelectionResult.RENDERED) {
        const descendantSurface = descendant.data;

        if (!defined(descendantSurface)) {
          continue;
        }

        if (
          !terrainReady &&
          descendant.data.terrainState === TerrainState.READY
        ) {
          return false;
        }

        const descendantImagery = descendant.data.imagery;
        for (i = 0, len = descendantImagery.length; i < len; ++i) {
          const descendantTileImagery = descendantImagery[i];
          const descendantLoadingImagery = descendantTileImagery.loadingImagery;
          const descendantIsReady =
            !defined(descendantLoadingImagery) ||
            descendantLoadingImagery.state === ImageryState.FAILED ||
            descendantLoadingImagery.state === ImageryState.INVALID;
          const descendantLayerIndex = (
            descendantTileImagery.loadingImagery ||
            descendantTileImagery.readyImagery
          ).imageryLayer._layerIndex;

          if (descendantIsReady && !readyImagery[descendantLayerIndex]) {
            return false;
          }
        }
      } else if (lastFrameSelectionResult === TileSelectionResult.REFINED) {
        stack.push(
          descendant.southwestChild,
          descendant.southeastChild,
          descendant.northwestChild,
          descendant.northeastChild,
        );
      }
    }

    return true;
  }

  /**
   * Determines the priority for loading this tile. Lower priority values load sooner.
   * @param {QuadtreeTile} tile The tile.
   * @param {FrameState} frameState The frame state.
   * @returns {number} The load priority value.
   */
  computeTileLoadPriority(tile, frameState) {
    const surfaceTile = tile.data;
    if (surfaceTile === undefined) {
      return 0.0;
    }

    const obb = surfaceTile.tileBoundingRegion.boundingVolume;
    if (obb === undefined) {
      return 0.0;
    }

    const cameraPosition = frameState.camera.positionWC;
    const cameraDirection = frameState.camera.directionWC;
    const tileDirection = Cartesian3.subtract(
      obb.center,
      cameraPosition,
      tileDirectionScratch,
    );
    const magnitude = Cartesian3.magnitude(tileDirection);
    if (magnitude < CesiumMath.EPSILON5) {
      return 0.0;
    }
    Cartesian3.divideByScalar(tileDirection, magnitude, tileDirection);
    return (
      (1.0 - Cartesian3.dot(tileDirection, cameraDirection)) * tile._distance
    );
  }

  /**
   * Shows a specified tile in this frame.
   * @param {QuadtreeTile} tile The tile instance.
   * @param {FrameState} frameState The state information of the current rendering frame.
   */
  showTileThisFrame(tile, frameState) {
    let readyTextureCount = 0;
    const tileImageryCollection = tile.data.imagery;
    for (let i = 0, len = tileImageryCollection.length; i < len; ++i) {
      const tileImagery = tileImageryCollection[i];
      if (
        defined(tileImagery.readyImagery) &&
        tileImagery.readyImagery.imageryLayer.alpha !== 0.0
      ) {
        ++readyTextureCount;
      }
    }

    let tileSet = this._tilesToRenderByTextureCount[readyTextureCount];
    if (!defined(tileSet)) {
      tileSet = [];
      this._tilesToRenderByTextureCount[readyTextureCount] = tileSet;
    }

    tileSet.push(tile);

    const surfaceTile = tile.data;
    const renderedMesh = surfaceTile.renderedMesh;
    if (!defined(renderedMesh) || renderedMesh !== surfaceTile.mesh) {
      this._hasFillTilesThisFrame = true;
    } else {
      this._hasLoadedTilesThisFrame = true;
    }

    const debug = this._debug;
    ++debug.tilesRendered;
    debug.texturesRendered += readyTextureCount;
  }

  /**
   * Gets the distance from the camera to the closest point on the tile.
   * @param {QuadtreeTile} tile The tile instance.
   * @param {FrameState} frameState The state information of the current rendering frame.
   * @returns {number} The distance from the camera to the closest point on the tile, in meters.
   */
  computeDistanceToTile(tile, frameState) {
    updateTileBoundingRegion(tile, this, frameState);

    const surfaceTile = tile.data;
    const boundingVolumeSourceTile = surfaceTile.boundingVolumeSourceTile;
    if (boundingVolumeSourceTile === undefined) {
      return 9999999999.0;
    }

    const tileBoundingRegion = surfaceTile.tileBoundingRegion;
    const min = tileBoundingRegion.minimumHeight;
    const max = tileBoundingRegion.maximumHeight;

    if (surfaceTile.boundingVolumeSourceTile !== tile) {
      const cameraHeight = frameState.camera.positionCartographic.height;
      const distanceToMin = Math.abs(cameraHeight - min);
      const distanceToMax = Math.abs(cameraHeight - max);
      if (distanceToMin > distanceToMax) {
        tileBoundingRegion.minimumHeight = min;
        tileBoundingRegion.maximumHeight = min;
      } else {
        tileBoundingRegion.minimumHeight = max;
        tileBoundingRegion.maximumHeight = max;
      }
    }

    const result = tileBoundingRegion.distanceToCamera(frameState);

    tileBoundingRegion.minimumHeight = min;
    tileBoundingRegion.maximumHeight = max;

    return result;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * @returns {boolean} True if this object was destroyed; otherwise, false.
   * @see GlobeSurfaceTileProvider#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   * @see GlobeSurfaceTileProvider#isDestroyed
   */
  destroy() {
    this._tileProvider = this._tileProvider && this._tileProvider.destroy();
    this._clippingPlanes =
      this._clippingPlanes && this._clippingPlanes.destroy();
    this._clippingPolygons =
      this._clippingPolygons && this._clippingPolygons.destroy();
    this._removeLayerAddedListener =
      this._removeLayerAddedListener && this._removeLayerAddedListener();
    this._removeLayerRemovedListener =
      this._removeLayerRemovedListener && this._removeLayerRemovedListener();
    this._removeLayerMovedListener =
      this._removeLayerMovedListener && this._removeLayerMovedListener();
    this._removeLayerShownListener =
      this._removeLayerShownListener && this._removeLayerShownListener();

    return destroyObject(this);
  }

  _onLayerAdded(layer, index) {
    if (this.isDestroyed()) {
      return;
    }

    if (layer.show) {
      const terrainProvider = this._terrainProvider;
      const that = this;
      const tileImageryUpdatedEvent = this._imageryLayersUpdatedEvent;
      const reloadFunction = function () {
        layer._imageryCache = {};

        that._quadtree.forEachLoadedTile(function (tile) {
          if (defined(tile._loadedCallbacks[layer._layerIndex])) {
            return;
          }

          let i;
          const tileImageryCollection = tile.data.imagery;
          const length = tileImageryCollection.length;
          let startIndex = -1;
          let tileImageriesToFree = 0;
          for (i = 0; i < length; ++i) {
            const tileImagery = tileImageryCollection[i];
            const imagery =
              tileImagery.readyImagery ?? tileImagery.loadingImagery;
            if (imagery.imageryLayer === layer) {
              if (startIndex === -1) {
                startIndex = i;
              }
              ++tileImageriesToFree;
            } else if (startIndex !== -1) {
              break;
            }
          }

          if (startIndex === -1) {
            return;
          }

          const insertionPoint = startIndex + tileImageriesToFree;

          if (
            layer._createTileImagerySkeletons(
              tile,
              terrainProvider,
              insertionPoint,
            )
          ) {
            tile._loadedCallbacks[layer._layerIndex] = getTileReadyCallback(
              tileImageriesToFree,
              layer,
              terrainProvider,
            );
            tile.state = QuadtreeTileLoadState.LOADING;
          }
        });
      };

      if (layer.ready) {
        const imageryProvider = layer.imageryProvider;
        imageryProvider._reload = reloadFunction;
      }

      this._quadtree.forEachLoadedTile(function (tile) {
        if (layer._createTileImagerySkeletons(tile, terrainProvider)) {
          tile.state = QuadtreeTileLoadState.LOADING;

          if (
            tile.level !== 0 &&
            (tile._lastSelectionResultFrame !==
              that.quadtree._lastSelectionFrameNumber ||
              tile._lastSelectionResult !== TileSelectionResult.RENDERED)
          ) {
            tile.renderable = false;
          }
        }
      });

      this._layerOrderChanged = true;
      markSceneCaptureContentChanged(this);
      tileImageryUpdatedEvent.raiseEvent();
    }
  }

  _onLayerRemoved(layer, index) {
    this._quadtree.forEachLoadedTile(function (tile) {
      const tileImageryCollection = tile.data.imagery;

      let startIndex = -1;
      let numDestroyed = 0;
      for (let i = 0, len = tileImageryCollection.length; i < len; ++i) {
        const tileImagery = tileImageryCollection[i];
        let imagery = tileImagery.loadingImagery;
        if (!defined(imagery)) {
          imagery = tileImagery.readyImagery;
        }
        if (imagery.imageryLayer === layer) {
          if (startIndex === -1) {
            startIndex = i;
          }
          tileImagery.freeResources();
          ++numDestroyed;
        } else if (startIndex !== -1) {
          break;
        }
      }

      if (startIndex !== -1) {
        tileImageryCollection.splice(startIndex, numDestroyed);
      }
    });

    if (defined(layer.imageryProvider)) {
      layer.imageryProvider._reload = undefined;
    }

    markSceneCaptureContentChanged(this);
    this._imageryLayersUpdatedEvent.raiseEvent();
  }

  _onLayerMoved(layer, newIndex, oldIndex) {
    this._layerOrderChanged = true;
    markSceneCaptureContentChanged(this);
    this._imageryLayersUpdatedEvent.raiseEvent();
  }

  _onLayerShownOrHidden(layer, index, show) {
    if (show) {
      this._onLayerAdded(layer, index);
    } else {
      this._onLayerRemoved(layer, index);
    }
  }
}

function sortTileImageryByLayerIndex(a, b) {
  let aImagery = a.loadingImagery;
  if (!defined(aImagery)) {
    aImagery = a.readyImagery;
  }

  let bImagery = b.loadingImagery;
  if (!defined(bImagery)) {
    bImagery = b.readyImagery;
  }

  return aImagery.imageryLayer._layerIndex - bImagery.imageryLayer._layerIndex;
}

function updateCredits(surface, frameState) {
  const creditDisplay = frameState.creditDisplay;
  const terrainProvider = surface._terrainProvider;
  if (defined(terrainProvider) && defined(terrainProvider.credit)) {
    creditDisplay.addCreditToNextFrame(terrainProvider.credit);
  }

  const imageryLayers = surface._imageryLayers;
  for (let i = 0, len = imageryLayers.length; i < len; ++i) {
    const layer = imageryLayers.get(i);
    if (layer.ready && layer.show && defined(layer.imageryProvider.credit)) {
      creditDisplay.addCreditToNextFrame(layer.imageryProvider.credit);
    }
  }
}

function getTileReadyCallback(tileImageriesToFree, layer, terrainProvider) {
  return function (tile) {
    let tileImagery;
    let imagery;
    let startIndex = -1;
    const tileImageryCollection = tile.data.imagery;
    const length = tileImageryCollection.length;
    let i;
    for (i = 0; i < length; ++i) {
      tileImagery = tileImageryCollection[i];
      imagery = tileImagery.readyImagery ?? tileImagery.loadingImagery;
      if (imagery.imageryLayer === layer) {
        startIndex = i;
        break;
      }
    }

    if (startIndex !== -1) {
      const endIndex = startIndex + tileImageriesToFree;
      tileImagery = tileImageryCollection[endIndex];
      imagery = defined(tileImagery)
        ? (tileImagery.readyImagery ?? tileImagery.loadingImagery)
        : undefined;
      if (!defined(imagery) || imagery.imageryLayer !== layer) {
        return !layer._createTileImagerySkeletons(
          tile,
          terrainProvider,
          endIndex,
        );
      }

      for (i = startIndex; i < endIndex; ++i) {
        tileImageryCollection[i].freeResources();
      }

      tileImageryCollection.splice(startIndex, tileImageriesToFree);
    }

    return true;
  };
}

const readyImageryScratch = [];
const canRenderTraversalStack = [];

export default GlobeSurfaceTileProvider;
