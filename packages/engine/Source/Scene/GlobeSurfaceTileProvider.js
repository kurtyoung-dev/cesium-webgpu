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
import Visibility from "../Core/Visibility.js";
import RenderState from "../Renderer/RenderState.js";
import BlendingState from "./BlendingState.js";
import ClippingPlaneCollection from "./ClippingPlaneCollection.js";
import ClippingPolygonCollection from "./ClippingPolygonCollection.js";
import DepthFunction from "./DepthFunction.js";
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
    }
    //>>includeEnd('debug');

    this.lightingFadeOutDistance = 6500000.0;
    this.lightingFadeInDistance = 9000000.0;
    this.hasWaterMask = false;
    this.showWaterEffect = false;
    this.oceanNormalMap = undefined;
    this.zoomedOutOceanSpecularIntensity = 0.5;
    this.enableLighting = false;
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

    if (defined(this._quadtree)) {
      this._quadtree.invalidateAllTiles();
    }
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
  }

  /**
   * Adds draw commands for tiles rendered in the previous frame for a pick pass.
   * @param {FrameState} frameState The frame state.
   */
  updateForPick(frameState) {
    // DP-H44 — WebGPU rebuilds fresh globe commands (with the pick command
    // attached) for the selected tiles in the pick frame; the WebGL
    // `_drawCommands` re-push below is skipped (it's empty on WebGPU anyway).
    if (updateWebGPUForPick(this, frameState)) {
      return;
    }
    const drawCommands = this._drawCommands;
    for (let i = 0, length = this._usedDrawCommands; i < length; ++i) {
      pushCommand(drawCommands[i], frameState);
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
          this._imageryLayers,
          this.quadtree,
          this._vertexArraysToDestroy,
          terrainOnly,
        );
      }
    }
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
    if (!defined(surfaceTile.vertexArray)) {
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

    this._imageryLayersUpdatedEvent.raiseEvent();
  }

  _onLayerMoved(layer, newIndex, oldIndex) {
    this._layerOrderChanged = true;
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

// ═══════════════════════════════════════════════════════════════════════════
// File-scoped helpers
// ═══════════════════════════════════════════════════════════════════════════

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
