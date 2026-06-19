import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Event from "../Core/Event.js";
import getTimestamp from "../Core/getTimestamp.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import Visibility from "../Core/Visibility.js";
import QuadtreeOccluders from "./QuadtreeOccluders.js";
import QuadtreeTile from "./QuadtreeTile.js";
import QuadtreeTileLoadState from "./QuadtreeTileLoadState.js";
import SceneMode from "./SceneMode.js";
import TileReplacementQueue from "./TileReplacementQueue.js";
import TileSelectionResult from "./TileSelectionResult.js";

/**
 * Renders massive sets of data by utilizing level-of-detail and culling.  The globe surface is divided into
 * a quadtree of tiles with large, low-detail tiles at the root and small, high-detail tiles at the leaves.
 * The set of tiles to render is selected by projecting an estimate of the geometric error in a tile onto
 * the screen to estimate screen-space error, in pixels, which must be below a user-specified threshold.
 * The actual content of the tiles is arbitrary and is specified using a {@link QuadtreeTileProvider}.
 *
 * @alias QuadtreePrimitive
 * @private
 */
class QuadtreePrimitive {
  /**
   * @param {object} options
   * @param {QuadtreeTileProvider} options.tileProvider The tile provider that loads, renders, and estimates
   *        the distance to individual tiles.
   * @param {number} [options.maximumScreenSpaceError=2] The maximum screen-space error, in pixels, that is allowed.
   * @param {number} [options.tileCacheSize=100] The maximum number of tiles that will be retained in the tile cache.
   */
  constructor(options) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options) || !defined(options.tileProvider)) {
      throw new DeveloperError("options.tileProvider is required.");
    }
    if (defined(options.tileProvider.quadtree)) {
      throw new DeveloperError(
        "A QuadtreeTileProvider can only be used with a single QuadtreePrimitive",
      );
    }
    //>>includeEnd('debug');

    this._tileProvider = options.tileProvider;
    this._tileProvider.quadtree = this;

    this._debug = {
      enableDebugOutput: false,

      maxDepth: 0,
      maxDepthVisited: 0,
      tilesVisited: 0,
      tilesCulled: 0,
      tilesRendered: 0,
      tilesWaitingForChildren: 0,

      lastMaxDepth: -1,
      lastMaxDepthVisited: -1,
      lastTilesVisited: -1,
      lastTilesCulled: -1,
      lastTilesRendered: -1,
      lastTilesWaitingForChildren: -1,

      suspendLodUpdate: false,
    };

    const tilingScheme = this._tileProvider.tilingScheme;
    const ellipsoid = tilingScheme.ellipsoid;

    this._tilesRenderedThisFrame = new Set();
    this._tilesToRender = [];
    this._tileLoadQueueHigh = [];
    this._tileLoadQueueMedium = [];
    this._tileLoadQueueLow = [];
    this._tileReplacementQueue = new TileReplacementQueue();
    this._levelZeroTiles = undefined;
    this._loadQueueTimeSlice = 5.0;
    this._tilesInvalidated = false;

    this._addHeightCallbacks = [];
    this._removeHeightCallbacks = [];

    this._tileToUpdateHeights = [];
    this._updateHeightsTimeSlice = 2.0;

    this._cameraPositionCartographic = undefined;
    this._cameraReferenceFrameOriginCartographic = undefined;

    /**
     * Gets or sets the maximum screen-space error, in pixels, that is allowed.
     * @type {number}
     * @default 2
     */
    this.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 2;

    /**
     * Gets or sets the maximum number of tiles that will be retained in the tile cache.
     * @type {number}
     * @default 100
     */
    this.tileCacheSize = options.tileCacheSize ?? 100;

    /**
     * Gets or sets the number of loading descendant tiles that is considered "too many".
     * @type {number}
     * @default 20
     */
    this.loadingDescendantLimit = 20;

    /**
     * Gets or sets a value indicating whether the ancestors of rendered tiles should be preloaded.
     * @type {boolean}
     * @default true
     */
    this.preloadAncestors = true;

    /**
     * Gets or sets a value indicating whether the siblings of rendered tiles should be preloaded.
     * @type {boolean}
     * @default false
     */
    this.preloadSiblings = false;

    this._occluders = new QuadtreeOccluders({
      ellipsoid: ellipsoid,
    });

    this._tileLoadProgressEvent = new Event();
    this._lastTileLoadQueueLength = 0;

    this._lastSelectionFrameNumber = undefined;
  }

  /**
   * Gets the provider of {@link QuadtreeTile} instances for this quadtree.
   * @type {QuadtreeTile}
   */
  get tileProvider() {
    return this._tileProvider;
  }

  /**
   * Gets an event that's raised when the length of the tile load queue has changed since the last render frame.
   * @type {Event}
   */
  get tileLoadProgressEvent() {
    return this._tileLoadProgressEvent;
  }

  get occluders() {
    return this._occluders;
  }

  /**
   * Invalidates and frees all the tiles in the quadtree.  The tiles must be reloaded
   * before they can be displayed.
   */
  invalidateAllTiles() {
    this._tilesInvalidated = true;
  }

  /**
   * Invokes a specified function for each {@link QuadtreeTile} that is partially
   * or completely loaded.
   *
   * @param {Function} tileFunction The function to invoke for each loaded tile.
   */
  forEachLoadedTile(tileFunction) {
    let tile = this._tileReplacementQueue.head;
    while (defined(tile)) {
      if (tile.state !== QuadtreeTileLoadState.START) {
        tileFunction(tile);
      }
      tile = tile.replacementNext;
    }
  }

  /**
   * Invokes a specified function for each {@link QuadtreeTile} that was rendered
   * in the most recent frame.
   *
   * @param {Function} tileFunction The function to invoke for each rendered tile.
   */
  forEachRenderedTile(tileFunction) {
    const tilesRendered = this._tilesRenderedThisFrame;
    for (const tile of tilesRendered) {
      tileFunction(tile);
    }
  }

  /**
   * Calls the callback when a new tile is rendered that contains the given cartographic.
   *
   * @param {Cartographic} cartographic The cartographic position.
   * @param {Function} callback The function to be called when a new tile is loaded containing the updated cartographic.
   * @returns {Function} The function to remove this callback from the quadtree.
   */
  updateHeight(cartographic, callback) {
    const primitive = this;
    const object = {
      positionOnEllipsoidSurface: undefined,
      positionCartographic: cartographic,
      level: -1,
      callback: callback,
    };

    object.removeFunc = function () {
      const addedCallbacks = primitive._addHeightCallbacks;
      const length = addedCallbacks.length;
      for (let i = 0; i < length; ++i) {
        if (addedCallbacks[i] === object) {
          addedCallbacks.splice(i, 1);
          break;
        }
      }
      primitive._removeHeightCallbacks.push(object);
      if (object.callback) {
        object.callback = undefined;
      }
    };

    primitive._addHeightCallbacks.push(object);
    return object.removeFunc;
  }

  /**
   * Updates the tile provider imagery and continues to process the tile load queue.
   * @private
   */
  update(frameState) {
    if (defined(this._tileProvider.update)) {
      this._tileProvider.update(frameState);
    }
  }

  /**
   * Initializes values for a new render frame and prepare the tile load queue.
   * @private
   */
  beginFrame(frameState) {
    const passes = frameState.passes;
    if (!passes.render) {
      return;
    }

    if (this._tilesInvalidated) {
      invalidateAllTiles(this);
      this._tilesInvalidated = false;
    }

    this._tileProvider.initialize(frameState);

    clearTileLoadQueue(this);

    if (this._debug.suspendLodUpdate) {
      return;
    }

    this._tileReplacementQueue.markStartOfRenderFrame();
    this._tilesRenderedThisFrame.clear();
  }

  /**
   * Selects new tiles to load based on the frame state and creates render commands.
   * @private
   */
  render(frameState) {
    const passes = frameState.passes;
    const tileProvider = this._tileProvider;

    if (passes.render) {
      tileProvider.beginUpdate(frameState);

      selectTilesForRendering(this, frameState);
      createRenderCommandsForSelectedTiles(this, frameState);

      tileProvider.endUpdate(frameState);
    }

    if (passes.pick && this._tilesToRender.length > 0) {
      tileProvider.updateForPick(frameState);
    }
  }

  /**
   * Updates terrain heights.
   * @private
   */
  endFrame(frameState) {
    const passes = frameState.passes;
    if (!passes.render || frameState.mode === SceneMode.MORPHING) {
      return;
    }

    processTileLoadQueue(this, frameState);
    updateHeights(this, frameState);
    updateTileLoadProgress(this, frameState);
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * @returns {boolean}
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.
   */
  destroy() {
    this._tileProvider = this._tileProvider && this._tileProvider.destroy();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// File-scoped helper functions (hoisted, not part of the class)
// ═══════════════════════════════════════════════════════════════════════════

function invalidateAllTiles(primitive) {
  const replacementQueue = primitive._tileReplacementQueue;
  replacementQueue.head = undefined;
  replacementQueue.tail = undefined;
  replacementQueue.count = 0;

  clearTileLoadQueue(primitive);

  const levelZeroTiles = primitive._levelZeroTiles;
  if (defined(levelZeroTiles)) {
    for (let i = 0; i < levelZeroTiles.length; ++i) {
      const tile = levelZeroTiles[i];
      const customData = tile.customData;

      for (const data of customData) {
        data.level = 0;
        primitive._addHeightCallbacks.push(data);
      }

      levelZeroTiles[i].freeResources();
    }
  }

  primitive._levelZeroTiles = undefined;

  primitive._tileProvider.cancelReprojections();
}

function clearTileLoadQueue(primitive) {
  const debug = primitive._debug;
  debug.maxDepth = 0;
  debug.maxDepthVisited = 0;
  debug.tilesVisited = 0;
  debug.tilesCulled = 0;
  debug.tilesRendered = 0;
  debug.tilesWaitingForChildren = 0;

  primitive._tileLoadQueueHigh.length = 0;
  primitive._tileLoadQueueMedium.length = 0;
  primitive._tileLoadQueueLow.length = 0;
}

function updateTileLoadProgress(primitive, frameState) {
  const currentLoadQueueLength =
    primitive._tileLoadQueueHigh.length +
    primitive._tileLoadQueueMedium.length +
    primitive._tileLoadQueueLow.length;

  if (
    currentLoadQueueLength !== primitive._lastTileLoadQueueLength ||
    primitive._tilesInvalidated
  ) {
    const raiseEvent = Event.prototype.raiseEvent.bind(
      primitive._tileLoadProgressEvent,
      currentLoadQueueLength,
    );
    frameState.afterRender.push(() => {
      raiseEvent();
      return true;
    });
    primitive._lastTileLoadQueueLength = currentLoadQueueLength;
  }

  const debug = primitive._debug;
  if (debug.enableDebugOutput && !debug.suspendLodUpdate) {
    debug.maxDepth = primitive._tilesToRender.reduce(function (max, tile) {
      return Math.max(max, tile.level);
    }, -1);
    debug.tilesRendered = primitive._tilesToRender.length;

    if (
      debug.tilesVisited !== debug.lastTilesVisited ||
      debug.tilesRendered !== debug.lastTilesRendered ||
      debug.tilesCulled !== debug.lastTilesCulled ||
      debug.maxDepth !== debug.lastMaxDepth ||
      debug.tilesWaitingForChildren !== debug.lastTilesWaitingForChildren ||
      debug.maxDepthVisited !== debug.lastMaxDepthVisited
    ) {
      console.log(
        `Visited ${debug.tilesVisited}, Rendered: ${debug.tilesRendered}, Culled: ${debug.tilesCulled}, Max Depth Rendered: ${debug.maxDepth}, Max Depth Visited: ${debug.maxDepthVisited}, Waiting for children: ${debug.tilesWaitingForChildren}`,
      );

      debug.lastTilesVisited = debug.tilesVisited;
      debug.lastTilesRendered = debug.tilesRendered;
      debug.lastTilesCulled = debug.tilesCulled;
      debug.lastMaxDepth = debug.maxDepth;
      debug.lastTilesWaitingForChildren = debug.tilesWaitingForChildren;
      debug.lastMaxDepthVisited = debug.maxDepthVisited;
    }
  }
}

let comparisonPoint;
const centerScratch = new Cartographic();
function compareDistanceToPoint(a, b) {
  let center = Rectangle.center(a.rectangle, centerScratch);
  const alon = center.longitude - comparisonPoint.longitude;
  const alat = center.latitude - comparisonPoint.latitude;

  center = Rectangle.center(b.rectangle, centerScratch);
  const blon = center.longitude - comparisonPoint.longitude;
  const blat = center.latitude - comparisonPoint.latitude;

  return alon * alon + alat * alat - (blon * blon + blat * blat);
}

const cameraOriginScratch = new Cartesian3();
let rootTraversalDetails = [];

function selectTilesForRendering(primitive, frameState) {
  const debug = primitive._debug;
  if (debug.suspendLodUpdate) {
    return;
  }

  const tilesToRender = primitive._tilesToRender;
  tilesToRender.length = 0;

  const tileProvider = primitive._tileProvider;
  if (!defined(primitive._levelZeroTiles)) {
    const tilingScheme = tileProvider.tilingScheme;
    if (defined(tilingScheme)) {
      primitive._levelZeroTiles =
        QuadtreeTile.createLevelZeroTiles(tilingScheme);
      const numberOfRootTiles = primitive._levelZeroTiles.length;
      if (rootTraversalDetails.length < numberOfRootTiles) {
        rootTraversalDetails = new Array(numberOfRootTiles);
        for (let i = 0; i < numberOfRootTiles; ++i) {
          if (rootTraversalDetails[i] === undefined) {
            rootTraversalDetails[i] = new TraversalDetails();
          }
        }
      }
    } else {
      return;
    }
  }

  primitive._occluders.ellipsoid.cameraPosition = frameState.camera.positionWC;

  const levelZeroTiles = primitive._levelZeroTiles;
  const occluders =
    levelZeroTiles.length > 1 ? primitive._occluders : undefined;

  comparisonPoint = frameState.camera.positionCartographic;
  levelZeroTiles.sort(compareDistanceToPoint);

  const customDataAdded = primitive._addHeightCallbacks;
  const customDataRemoved = primitive._removeHeightCallbacks;

  customDataAdded.forEach((data) => {
    const tile = levelZeroTiles.find((tile) =>
      Rectangle.contains(tile.rectangle, data.positionCartographic),
    );
    if (tile) {
      tile._addedCustomData.push(data);
    }
  });

  customDataRemoved.forEach((data) => {
    const tile = levelZeroTiles.find((tile) =>
      Rectangle.contains(tile.rectangle, data.positionCartographic),
    );
    if (tile) {
      tile._removedCustomData.push(data);
    }
  });

  levelZeroTiles.forEach((tile) => tile.updateCustomData());
  customDataAdded.length = 0;
  customDataRemoved.length = 0;

  const camera = frameState.camera;

  primitive._cameraPositionCartographic = camera.positionCartographic;
  const cameraFrameOrigin = Matrix4.getTranslation(
    camera.transform,
    cameraOriginScratch,
  );
  primitive._cameraReferenceFrameOriginCartographic =
    primitive.tileProvider.tilingScheme.ellipsoid.cartesianToCartographic(
      cameraFrameOrigin,
      primitive._cameraReferenceFrameOriginCartographic,
    );

  for (let i = 0; i < levelZeroTiles.length; ++i) {
    const tile = levelZeroTiles[i];
    primitive._tileReplacementQueue.markTileRendered(tile);
    if (!tile.renderable) {
      queueTileLoad(primitive, primitive._tileLoadQueueHigh, tile, frameState);
      ++debug.tilesWaitingForChildren;
    } else {
      visitIfVisible(
        primitive,
        tile,
        tileProvider,
        frameState,
        occluders,
        false,
        rootTraversalDetails[i],
      );
    }
  }

  primitive._lastSelectionFrameNumber = frameState.frameNumber;
}

function queueTileLoad(primitive, queue, tile, frameState) {
  if (!tile.needsLoading) {
    return;
  }

  if (primitive.tileProvider.computeTileLoadPriority !== undefined) {
    tile._loadPriority = primitive.tileProvider.computeTileLoadPriority(
      tile,
      frameState,
    );
  }
  queue.push(tile);
}

function TraversalDetails() {
  this.allAreRenderable = true;
  this.anyWereRenderedLastFrame = false;
  this.notYetRenderableCount = 0;
}

function TraversalQuadDetails() {
  this.southwest = new TraversalDetails();
  this.southeast = new TraversalDetails();
  this.northwest = new TraversalDetails();
  this.northeast = new TraversalDetails();
}

TraversalQuadDetails.prototype.combine = function (result) {
  const southwest = this.southwest;
  const southeast = this.southeast;
  const northwest = this.northwest;
  const northeast = this.northeast;

  result.allAreRenderable =
    southwest.allAreRenderable &&
    southeast.allAreRenderable &&
    northwest.allAreRenderable &&
    northeast.allAreRenderable;
  result.anyWereRenderedLastFrame =
    southwest.anyWereRenderedLastFrame ||
    southeast.anyWereRenderedLastFrame ||
    northwest.anyWereRenderedLastFrame ||
    northeast.anyWereRenderedLastFrame;
  result.notYetRenderableCount =
    southwest.notYetRenderableCount +
    southeast.notYetRenderableCount +
    northwest.notYetRenderableCount +
    northeast.notYetRenderableCount;
};

const traversalQuadsByLevel = new Array(31);
for (let i = 0; i < traversalQuadsByLevel.length; ++i) {
  traversalQuadsByLevel[i] = new TraversalQuadDetails();
}

function visitTile(
  primitive,
  frameState,
  tile,
  ancestorMeetsSse,
  traversalDetails,
) {
  const debug = primitive._debug;

  ++debug.tilesVisited;

  primitive._tileReplacementQueue.markTileRendered(tile);
  tile.updateCustomData();

  if (tile.level > debug.maxDepthVisited) {
    debug.maxDepthVisited = tile.level;
  }

  const meetsSse =
    screenSpaceError(primitive, frameState, tile) <
    primitive.maximumScreenSpaceError;

  const southwestChild = tile.southwestChild;
  const southeastChild = tile.southeastChild;
  const northwestChild = tile.northwestChild;
  const northeastChild = tile.northeastChild;

  const lastFrame = primitive._lastSelectionFrameNumber;
  const lastFrameSelectionResult =
    tile._lastSelectionResultFrame === lastFrame
      ? tile._lastSelectionResult
      : TileSelectionResult.NONE;

  const tileProvider = primitive.tileProvider;

  if (meetsSse || ancestorMeetsSse) {
    const oneRenderedLastFrame =
      TileSelectionResult.originalResult(lastFrameSelectionResult) ===
      TileSelectionResult.RENDERED;
    const twoCulledOrNotVisited =
      TileSelectionResult.originalResult(lastFrameSelectionResult) ===
        TileSelectionResult.CULLED ||
      lastFrameSelectionResult === TileSelectionResult.NONE;
    const threeCompletelyLoaded = tile.state === QuadtreeTileLoadState.DONE;

    let renderable =
      oneRenderedLastFrame || twoCulledOrNotVisited || threeCompletelyLoaded;

    if (!renderable) {
      if (defined(tileProvider.canRenderWithoutLosingDetail)) {
        renderable = tileProvider.canRenderWithoutLosingDetail(tile);
      }
    }

    if (renderable) {
      if (meetsSse) {
        queueTileLoad(
          primitive,
          primitive._tileLoadQueueMedium,
          tile,
          frameState,
        );
      }
      addTileToRenderList(primitive, tile);

      traversalDetails.allAreRenderable = tile.renderable;
      traversalDetails.anyWereRenderedLastFrame =
        lastFrameSelectionResult === TileSelectionResult.RENDERED;
      traversalDetails.notYetRenderableCount = tile.renderable ? 0 : 1;

      tile._lastSelectionResultFrame = frameState.frameNumber;
      tile._lastSelectionResult = TileSelectionResult.RENDERED;

      if (!traversalDetails.anyWereRenderedLastFrame) {
        primitive._tileToUpdateHeights.push(tile);
      }

      return;
    }

    ancestorMeetsSse = true;

    if (meetsSse) {
      queueTileLoad(primitive, primitive._tileLoadQueueHigh, tile, frameState);
    }
  }

  if (tileProvider.canRefine(tile)) {
    const allAreUpsampled =
      southwestChild.upsampledFromParent &&
      southeastChild.upsampledFromParent &&
      northwestChild.upsampledFromParent &&
      northeastChild.upsampledFromParent;

    if (allAreUpsampled) {
      addTileToRenderList(primitive, tile);

      queueTileLoad(
        primitive,
        primitive._tileLoadQueueMedium,
        tile,
        frameState,
      );

      primitive._tileReplacementQueue.markTileRendered(southwestChild);
      primitive._tileReplacementQueue.markTileRendered(southeastChild);
      primitive._tileReplacementQueue.markTileRendered(northwestChild);
      primitive._tileReplacementQueue.markTileRendered(northeastChild);

      traversalDetails.allAreRenderable = tile.renderable;
      traversalDetails.anyWereRenderedLastFrame =
        lastFrameSelectionResult === TileSelectionResult.RENDERED;
      traversalDetails.notYetRenderableCount = tile.renderable ? 0 : 1;

      tile._lastSelectionResultFrame = frameState.frameNumber;
      tile._lastSelectionResult = TileSelectionResult.RENDERED;

      if (!traversalDetails.anyWereRenderedLastFrame) {
        primitive._tileToUpdateHeights.push(tile);
      }

      return;
    }

    tile._lastSelectionResultFrame = frameState.frameNumber;
    tile._lastSelectionResult = TileSelectionResult.REFINED;

    const firstRenderedDescendantIndex = primitive._tilesToRender.length;
    const loadIndexLow = primitive._tileLoadQueueLow.length;
    const loadIndexMedium = primitive._tileLoadQueueMedium.length;
    const loadIndexHigh = primitive._tileLoadQueueHigh.length;
    const tilesToUpdateHeightsIndex = primitive._tileToUpdateHeights.length;

    visitVisibleChildrenNearToFar(
      primitive,
      southwestChild,
      southeastChild,
      northwestChild,
      northeastChild,
      frameState,
      ancestorMeetsSse,
      traversalDetails,
    );

    if (firstRenderedDescendantIndex !== primitive._tilesToRender.length) {
      const allAreRenderable = traversalDetails.allAreRenderable;
      const anyWereRenderedLastFrame =
        traversalDetails.anyWereRenderedLastFrame;
      const notYetRenderableCount = traversalDetails.notYetRenderableCount;
      let queuedForLoad = false;

      if (!allAreRenderable && !anyWereRenderedLastFrame) {
        const renderList = primitive._tilesToRender;
        for (let i = firstRenderedDescendantIndex; i < renderList.length; ++i) {
          let workTile = renderList[i];
          while (
            workTile !== undefined &&
            workTile._lastSelectionResult !== TileSelectionResult.KICKED &&
            workTile !== tile
          ) {
            workTile._lastSelectionResult = TileSelectionResult.kick(
              workTile._lastSelectionResult,
            );
            workTile = workTile.parent;
          }
        }

        primitive._tilesToRender.length = firstRenderedDescendantIndex;
        primitive._tileToUpdateHeights.length = tilesToUpdateHeightsIndex;
        addTileToRenderList(primitive, tile);

        tile._lastSelectionResult = TileSelectionResult.RENDERED;

        const wasRenderedLastFrame =
          lastFrameSelectionResult === TileSelectionResult.RENDERED;
        if (
          !wasRenderedLastFrame &&
          notYetRenderableCount > primitive.loadingDescendantLimit
        ) {
          primitive._tileLoadQueueLow.length = loadIndexLow;
          primitive._tileLoadQueueMedium.length = loadIndexMedium;
          primitive._tileLoadQueueHigh.length = loadIndexHigh;
          queueTileLoad(
            primitive,
            primitive._tileLoadQueueMedium,
            tile,
            frameState,
          );
          traversalDetails.notYetRenderableCount = tile.renderable ? 0 : 1;
          queuedForLoad = true;
        }

        traversalDetails.allAreRenderable = tile.renderable;
        traversalDetails.anyWereRenderedLastFrame = wasRenderedLastFrame;

        if (!wasRenderedLastFrame) {
          primitive._tileToUpdateHeights.push(tile);
        }

        ++debug.tilesWaitingForChildren;
      }

      if (primitive.preloadAncestors && !queuedForLoad) {
        queueTileLoad(primitive, primitive._tileLoadQueueLow, tile, frameState);
      }
    }

    return;
  }

  tile._lastSelectionResultFrame = frameState.frameNumber;
  tile._lastSelectionResult = TileSelectionResult.RENDERED;

  addTileToRenderList(primitive, tile);
  queueTileLoad(primitive, primitive._tileLoadQueueHigh, tile, frameState);

  traversalDetails.allAreRenderable = tile.renderable;
  traversalDetails.anyWereRenderedLastFrame =
    lastFrameSelectionResult === TileSelectionResult.RENDERED;
  traversalDetails.notYetRenderableCount = tile.renderable ? 0 : 1;
}

function visitVisibleChildrenNearToFar(
  primitive,
  southwest,
  southeast,
  northwest,
  northeast,
  frameState,
  ancestorMeetsSse,
  traversalDetails,
) {
  const cameraPosition = frameState.camera.positionCartographic;
  const tileProvider = primitive._tileProvider;
  const occluders = primitive._occluders;

  const quadDetails = traversalQuadsByLevel[southwest.level];
  const southwestDetails = quadDetails.southwest;
  const southeastDetails = quadDetails.southeast;
  const northwestDetails = quadDetails.northwest;
  const northeastDetails = quadDetails.northeast;

  if (cameraPosition.longitude < southwest.rectangle.east) {
    if (cameraPosition.latitude < southwest.rectangle.north) {
      visitIfVisible(
        primitive,
        southwest,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        southwestDetails,
      );
      visitIfVisible(
        primitive,
        southeast,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        southeastDetails,
      );
      visitIfVisible(
        primitive,
        northwest,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        northwestDetails,
      );
      visitIfVisible(
        primitive,
        northeast,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        northeastDetails,
      );
    } else {
      visitIfVisible(
        primitive,
        northwest,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        northwestDetails,
      );
      visitIfVisible(
        primitive,
        southwest,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        southwestDetails,
      );
      visitIfVisible(
        primitive,
        northeast,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        northeastDetails,
      );
      visitIfVisible(
        primitive,
        southeast,
        tileProvider,
        frameState,
        occluders,
        ancestorMeetsSse,
        southeastDetails,
      );
    }
  } else if (cameraPosition.latitude < southwest.rectangle.north) {
    visitIfVisible(
      primitive,
      southeast,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      southeastDetails,
    );
    visitIfVisible(
      primitive,
      southwest,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      southwestDetails,
    );
    visitIfVisible(
      primitive,
      northeast,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      northeastDetails,
    );
    visitIfVisible(
      primitive,
      northwest,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      northwestDetails,
    );
  } else {
    visitIfVisible(
      primitive,
      northeast,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      northeastDetails,
    );
    visitIfVisible(
      primitive,
      northwest,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      northwestDetails,
    );
    visitIfVisible(
      primitive,
      southeast,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      southeastDetails,
    );
    visitIfVisible(
      primitive,
      southwest,
      tileProvider,
      frameState,
      occluders,
      ancestorMeetsSse,
      southwestDetails,
    );
  }

  quadDetails.combine(traversalDetails);
}

function containsNeededPosition(primitive, tile) {
  const rectangle = tile.rectangle;
  return (
    (defined(primitive._cameraPositionCartographic) &&
      Rectangle.contains(rectangle, primitive._cameraPositionCartographic)) ||
    (defined(primitive._cameraReferenceFrameOriginCartographic) &&
      Rectangle.contains(
        rectangle,
        primitive._cameraReferenceFrameOriginCartographic,
      ))
  );
}

function visitIfVisible(
  primitive,
  tile,
  tileProvider,
  frameState,
  occluders,
  ancestorMeetsSse,
  traversalDetails,
) {
  if (
    tileProvider.computeTileVisibility(tile, frameState, occluders) !==
    Visibility.NONE
  ) {
    return visitTile(
      primitive,
      frameState,
      tile,
      ancestorMeetsSse,
      traversalDetails,
    );
  }

  ++primitive._debug.tilesCulled;
  primitive._tileReplacementQueue.markTileRendered(tile);

  traversalDetails.allAreRenderable = true;
  traversalDetails.anyWereRenderedLastFrame = false;
  traversalDetails.notYetRenderableCount = 0;

  if (containsNeededPosition(primitive, tile)) {
    if (!defined(tile.data) || !defined(tile.data.vertexArray)) {
      queueTileLoad(
        primitive,
        primitive._tileLoadQueueMedium,
        tile,
        frameState,
      );
    }

    const lastFrame = primitive._lastSelectionFrameNumber;
    const lastFrameSelectionResult =
      tile._lastSelectionResultFrame === lastFrame
        ? tile._lastSelectionResult
        : TileSelectionResult.NONE;
    if (
      lastFrameSelectionResult !== TileSelectionResult.CULLED_BUT_NEEDED &&
      lastFrameSelectionResult !== TileSelectionResult.RENDERED
    ) {
      primitive._tileToUpdateHeights.push(tile);
    }

    tile._lastSelectionResult = TileSelectionResult.CULLED_BUT_NEEDED;
  } else if (primitive.preloadSiblings || tile.level === 0) {
    queueTileLoad(primitive, primitive._tileLoadQueueLow, tile, frameState);
    tile._lastSelectionResult = TileSelectionResult.CULLED;
  } else {
    tile._lastSelectionResult = TileSelectionResult.CULLED;
  }

  tile._lastSelectionResultFrame = frameState.frameNumber;
}

function screenSpaceError(primitive, frameState, tile) {
  if (
    frameState.mode === SceneMode.SCENE2D ||
    frameState.camera.frustum instanceof OrthographicFrustum ||
    frameState.camera.frustum instanceof OrthographicOffCenterFrustum
  ) {
    return screenSpaceError2D(primitive, frameState, tile);
  }

  const maxGeometricError =
    primitive._tileProvider.getLevelMaximumGeometricError(tile.level);

  const distance = tile._distance;
  const height = frameState.context.drawingBufferHeight;
  const sseDenominator = frameState.camera.frustum.sseDenominator;

  let error = (maxGeometricError * height) / (distance * sseDenominator);

  if (frameState.fog.enabled) {
    error -=
      CesiumMath.fog(distance, frameState.fog.density) * frameState.fog.sse;
  }

  error /= frameState.pixelRatio;

  return error;
}

function screenSpaceError2D(primitive, frameState, tile) {
  const camera = frameState.camera;
  let frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  if (defined(offCenterFrustum)) {
    frustum = offCenterFrustum;
  }

  const context = frameState.context;
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;

  const maxGeometricError =
    primitive._tileProvider.getLevelMaximumGeometricError(tile.level);
  const pixelSize =
    Math.max(frustum.top - frustum.bottom, frustum.right - frustum.left) /
    Math.max(width, height);
  let error = maxGeometricError / pixelSize;

  if (frameState.fog.enabled && frameState.mode !== SceneMode.SCENE2D) {
    error -=
      CesiumMath.fog(tile._distance, frameState.fog.density) *
      frameState.fog.sse;
  }

  error /= frameState.pixelRatio;

  return error;
}

function addTileToRenderList(primitive, tile) {
  primitive._tilesToRender.push(tile);
  primitive._tilesRenderedThisFrame.add(tile);
}

function processTileLoadQueue(primitive, frameState) {
  const tileLoadQueueHigh = primitive._tileLoadQueueHigh;
  const tileLoadQueueMedium = primitive._tileLoadQueueMedium;
  const tileLoadQueueLow = primitive._tileLoadQueueLow;

  if (
    tileLoadQueueHigh.length === 0 &&
    tileLoadQueueMedium.length === 0 &&
    tileLoadQueueLow.length === 0
  ) {
    return;
  }

  primitive._tileReplacementQueue.trimTiles(primitive.tileCacheSize);

  const endTime = getTimestamp() + primitive._loadQueueTimeSlice;
  const tileProvider = primitive._tileProvider;

  let didSomeLoading = processSinglePriorityLoadQueue(
    primitive,
    frameState,
    tileProvider,
    endTime,
    tileLoadQueueHigh,
    false,
  );
  didSomeLoading = processSinglePriorityLoadQueue(
    primitive,
    frameState,
    tileProvider,
    endTime,
    tileLoadQueueMedium,
    didSomeLoading,
  );
  processSinglePriorityLoadQueue(
    primitive,
    frameState,
    tileProvider,
    endTime,
    tileLoadQueueLow,
    didSomeLoading,
  );
}

function sortByLoadPriority(a, b) {
  return a._loadPriority - b._loadPriority;
}

function processSinglePriorityLoadQueue(
  primitive,
  frameState,
  tileProvider,
  endTime,
  loadQueue,
  didSomeLoading,
) {
  if (tileProvider.computeTileLoadPriority !== undefined) {
    loadQueue.sort(sortByLoadPriority);
  }

  for (
    let i = 0, len = loadQueue.length;
    i < len && (getTimestamp() < endTime || !didSomeLoading);
    ++i
  ) {
    const tile = loadQueue[i];
    primitive._tileReplacementQueue.markTileRendered(tile);
    tileProvider.loadTile(frameState, tile);
    didSomeLoading = true;
  }

  return didSomeLoading;
}

const scratchRay = new Ray();
const scratchCartographic = new Cartographic();
const scratchPosition = new Cartesian3();
const scratchArray = [];

function updateHeights(primitive, frameState) {
  if (!defined(primitive.tileProvider.tilingScheme)) {
    return;
  }

  const tryNextFrame = scratchArray;
  tryNextFrame.length = 0;
  const tilesToUpdateHeights = primitive._tileToUpdateHeights;

  const startTime = getTimestamp();
  const timeSlice = primitive._updateHeightsTimeSlice;
  const endTime = startTime + timeSlice;

  const mode = frameState.mode;
  const projection = frameState.mapProjection;
  const ellipsoid = primitive.tileProvider.tilingScheme.ellipsoid;
  let i;

  while (tilesToUpdateHeights.length > 0) {
    const tile = tilesToUpdateHeights[0];
    if (!defined(tile.data) || !defined(tile.data.mesh)) {
      const selectionResult =
        tile._lastSelectionResultFrame === primitive._lastSelectionFrameNumber
          ? tile._lastSelectionResult
          : TileSelectionResult.NONE;
      if (
        selectionResult === TileSelectionResult.RENDERED ||
        selectionResult === TileSelectionResult.CULLED_BUT_NEEDED
      ) {
        tryNextFrame.push(tile);
      }
      tile.clearPositionCache();
      tilesToUpdateHeights.shift();
      continue;
    }
    const customData = tile.customData;
    if (!defined(tile._customDataIterator)) {
      tile._customDataIterator = customData.values();
    }
    const customDataIterator = tile._customDataIterator;

    let timeSliceMax = false;
    let nextData;
    while (!(nextData = customDataIterator.next()).done) {
      const data = nextData.value;

      const terrainData = tile.data.terrainData;
      const upsampledGeometryFromParent =
        defined(terrainData) && terrainData.wasCreatedByUpsampling();

      if (tile.level > data.level && !upsampledGeometryFromParent) {
        let position;
        const cachedData = tile.getPositionCacheEntry(
          data.positionCartographic,
          primitive.maximumScreenSpaceError,
        );
        if (defined(cachedData)) {
          position = cachedData;
        } else {
          if (!defined(data.positionOnEllipsoidSurface)) {
            data.positionOnEllipsoidSurface = Cartesian3.fromRadians(
              data.positionCartographic.longitude,
              data.positionCartographic.latitude,
              0.0,
              ellipsoid,
            );
          }

          if (mode === SceneMode.SCENE3D) {
            const surfaceNormal = ellipsoid.geodeticSurfaceNormal(
              data.positionOnEllipsoidSurface,
              scratchRay.direction,
            );

            const rayOrigin = ellipsoid.getSurfaceNormalIntersectionWithZAxis(
              data.positionOnEllipsoidSurface,
              11500.0,
              scratchRay.origin,
            );

            if (!defined(rayOrigin)) {
              let minimumHeight = 0.0;
              if (defined(tile.data.tileBoundingRegion)) {
                minimumHeight = tile.data.tileBoundingRegion.minimumHeight;
              }
              const magnitude = Math.min(minimumHeight, -11500.0);

              const vectorToMinimumPoint = Cartesian3.multiplyByScalar(
                surfaceNormal,
                Math.abs(magnitude) + 1,
                scratchPosition,
              );
              Cartesian3.subtract(
                data.positionOnEllipsoidSurface,
                vectorToMinimumPoint,
                scratchRay.origin,
              );
            }
          } else {
            Cartographic.clone(data.positionCartographic, scratchCartographic);

            scratchCartographic.height = -11500.0;
            projection.project(scratchCartographic, scratchPosition);
            Cartesian3.fromElements(
              scratchPosition.z,
              scratchPosition.x,
              scratchPosition.y,
              scratchPosition,
            );
            Cartesian3.clone(scratchPosition, scratchRay.origin);
            Cartesian3.clone(Cartesian3.UNIT_X, scratchRay.direction);
          }

          position = tile.data.pick(
            scratchRay,
            mode,
            projection,
            false,
            scratchPosition,
          );

          if (defined(position)) {
            // `pick` wrote into the module-level `scratchPosition`, so `position`
            // aliases it — clone before caching or the next pick mutates every entry.
            tile.setPositionCacheEntry(
              data.positionCartographic,
              primitive.maximumScreenSpaceError,
              Cartesian3.clone(position),
            );
          }
        }
        if (defined(position)) {
          if (defined(data.callback)) {
            const positionCarto = ellipsoid.cartesianToCartographic(
              position,
              scratchCartographic,
            );
            data.callback(positionCarto);
          }
          data.level = tile.level;
        }
      }

      if (getTimestamp() >= endTime) {
        timeSliceMax = true;
        break;
      }
    }

    if (timeSliceMax) {
      tile._customDataIterator = customDataIterator;
      break;
    } else {
      tile._customDataIterator = undefined;
      tilesToUpdateHeights.shift();
    }
  }
  for (i = 0; i < tryNextFrame.length; i++) {
    tilesToUpdateHeights.push(tryNextFrame[i]);
  }
}

function createRenderCommandsForSelectedTiles(primitive, frameState) {
  const tileProvider = primitive._tileProvider;
  const tilesToRender = primitive._tilesToRender;

  for (let i = 0, len = tilesToRender.length; i < len; ++i) {
    const tile = tilesToRender[i];
    tileProvider.showTileThisFrame(tile, frameState);
  }
}
export default QuadtreePrimitive;
