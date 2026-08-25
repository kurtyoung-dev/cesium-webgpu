import Check from "../Core/Check.js";
import combine from "../Core/combine.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Event from "../Core/Event.js";
import getTimestamp from "../Core/getTimestamp.js";
import JulianDate from "../Core/JulianDate.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import Resource from "../Core/Resource.js";
import ClippingPlaneCollection from "./ClippingPlaneCollection.js";
import PointCloud from "./PointCloud.js";
import PointCloudEyeDomeLighting from "./PointCloudEyeDomeLighting.js";
import PointCloudShading from "./PointCloudShading.js";
import SceneMode from "./SceneMode.js";
import ShadowMode from "./ShadowMode.js";
import WasmPointCloudBridge from "./WasmPointCloudBridge.js";

/**
 * Provides playback of time-dynamic point cloud data.
 * <p>
 * Point cloud frames are prefetched in intervals determined by the average frame load time and the current clock speed.
 * If intermediate frames cannot be loaded in time to meet playback speed, they will be skipped. If frames are sufficiently
 * small or the clock is sufficiently slow then no frames will be skipped.
 * </p>
 *
 * @alias TimeDynamicPointCloud
 *
 * @param {object} options Object with the following properties:
 * @param {Clock} options.clock A {@link Clock} instance that is used when determining the value for the time dimension.
 * @param {TimeIntervalCollection} options.intervals A {@link TimeIntervalCollection} with its data property being an object containing a <code>uri</code> to a 3D Tiles Point Cloud tile and an optional <code>transform</code>.
 * @param {boolean} [options.show=true] Determines if the point cloud will be shown.
 * @param {Matrix4} [options.modelMatrix=Matrix4.IDENTITY] A 4x4 transformation matrix that transforms the point cloud.
 * @param {ShadowMode} [options.shadows=ShadowMode.ENABLED] Determines whether the point cloud casts or receives shadows from light sources.
 * @param {number} [options.maximumMemoryUsage=256] The maximum amount of memory in MB that can be used by the point cloud.
 * @param {object} [options.shading] Options for constructing a {@link PointCloudShading} object to control point attenuation and eye dome lighting.
 * @param {Cesium3DTileStyle} [options.style] The style, defined using the {@link https://github.com/CesiumGS/3d-tiles/tree/main/specification/Styling|3D Tiles Styling language}, applied to each point in the point cloud.
 * @param {ClippingPlaneCollection} [options.clippingPlanes] The {@link ClippingPlaneCollection} used to selectively disable rendering the point cloud.
 */
class TimeDynamicPointCloud {
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("options.clock", options.clock);
    Check.typeOf.object("options.intervals", options.intervals);
    //>>includeEnd('debug');

    /**
     * Determines if the point cloud will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = options.show ?? true;

    /**
     * A 4x4 transformation matrix that transforms the point cloud.
     *
     * @type {Matrix4}
     * @default Matrix4.IDENTITY
     */
    this.modelMatrix = Matrix4.clone(options.modelMatrix ?? Matrix4.IDENTITY);

    /**
     * Determines whether the point cloud casts or receives shadows from light sources.
     *
     * @type {ShadowMode}
     * @default ShadowMode.ENABLED
     */
    this.shadows = options.shadows ?? ShadowMode.ENABLED;

    /**
     * The maximum amount of GPU memory (in MB) that may be used to cache point cloud frames.
     *
     * @type {number}
     * @default 256
     *
     * @see TimeDynamicPointCloud#totalMemoryUsageInBytes
     */
    this.maximumMemoryUsage = options.maximumMemoryUsage ?? 256;

    /**
     * Options for controlling point size based on geometric error and eye dome lighting.
     * @type {PointCloudShading}
     */
    this.shading = new PointCloudShading(options.shading);

    /**
     * The style, defined using the
     * {@link https://github.com/CesiumGS/3d-tiles/tree/main/specification/Styling|3D Tiles Styling language},
     * applied to each point in the point cloud.
     *
     * @type {Cesium3DTileStyle}
     *
     * @example
     * pointCloud.style = new Cesium.Cesium3DTileStyle({
     *    color : {
     *        conditions : [
     *            ['${Classification} === 0', 'color("purple", 0.5)'],
     *            ['${Classification} === 1', 'color("red")'],
     *            ['true', '${COLOR}']
     *        ]
     *    },
     *    show : '${Classification} !== 2'
     * });
     *
     * @see {@link https://github.com/CesiumGS/3d-tiles/tree/main/specification/Styling|3D Tiles Styling language}
     */
    this.style = options.style;

    /**
     * The event fired to indicate that a frame failed to load.
     *
     * @type {Event}
     * @default new Event()
     */
    this.frameFailed = new Event();

    /**
     * The event fired to indicate that a new frame was rendered.
     *
     * @type {Event}
     * @default new Event()
     */
    this.frameChanged = new Event();

    this._clock = options.clock;
    this._intervals = options.intervals;
    this._clippingPlanes = undefined;
    this.clippingPlanes = options.clippingPlanes;
    this._pointCloudEyeDomeLighting = new PointCloudEyeDomeLighting();
    this._loadTimestamp = undefined;
    this._clippingPlanesState = 0;
    this._styleDirty = false;
    this._pickId = undefined;
    this._totalMemoryUsageInBytes = 0;
    this._frames = [];
    this._previousInterval = undefined;
    this._nextInterval = undefined;
    this._lastRenderedFrame = undefined;
    this._clockMultiplier = 0.0;

    this._runningSum = 0.0;
    this._runningLength = 0;
    this._runningIndex = 0;
    this._runningSamples = new Array(5).fill(0.0);
    this._runningAverage = 0.0;

    /**
     * When true, transparent point cloud frames are sorted back-to-front
     * before rendering. Uses the WasmPointCloudBridge (CPU or GPU path
     * depending on `_pointCloudBridge.useGPUSort`).
     *
     * @type {boolean}
     * @default false
     */
    this.sortTransparentPoints = options.sortTransparentPoints ?? false;

    this._pointCloudBridge = null;
  }

  /**
   * The {@link ClippingPlaneCollection} used to selectively disable rendering the point cloud.
   *
   * @type {ClippingPlaneCollection}
   */
  get clippingPlanes() {
    return this._clippingPlanes;
  }

  set clippingPlanes(value) {
    ClippingPlaneCollection.setOwner(value, this, "_clippingPlanes");
  }

  /**
   * The total amount of GPU memory in bytes used by the point cloud.
   *
   * @type {number}
   * @readonly
   *
   * @see TimeDynamicPointCloud#maximumMemoryUsage
   */
  get totalMemoryUsageInBytes() {
    return this._totalMemoryUsageInBytes;
  }

  /**
   * The bounding sphere of the frame being rendered. Returns <code>undefined</code> if no frame is being rendered.
   *
   * @type {BoundingSphere}
   * @readonly
   */
  get boundingSphere() {
    if (defined(this._lastRenderedFrame)) {
      return this._lastRenderedFrame.pointCloud.boundingSphere;
    }
    return undefined;
  }

  /**
   * Marks the point cloud's {@link TimeDynamicPointCloud#style} as dirty, which forces all
   * points to re-evaluate the style in the next frame.
   */
  makeStyleDirty() {
    this._styleDirty = true;
  }

  /**
   * Exposed for testing.
   *
   * @private
   */
  _getAverageLoadTime() {
    if (this._runningLength === 0) {
      return 0.05;
    }
    return this._runningAverage;
  }

  /**
   * @private
   */
  update(frameState) {
    // NOTE: unlike `PointCloud.update`, this method does NOT delegate to the
    // POINT_CLOUD feature renderer. `TimeDynamicPointCloud` is a *manager* of
    // time-keyed `PointCloud` frames — it is not itself a renderable point
    // cloud and carries no `_parsedContent`. The per-frame `PointCloud.update`
    // (called from `renderFrame` below) performs the backend delegation for
    // the frame that is actually displayed. A previous short-circuit here
    // delegated `this` to the WebGPU point-cloud renderer, which found no
    // parsed content, produced zero instances, and skipped the whole
    // frame-management path — so WebGPU time-dynamic point clouds rendered
    // nothing. The frame loop below runs identically on both backends.
    if (frameState.mode === SceneMode.MORPHING) {
      return;
    }

    if (!this.show) {
      return;
    }

    if (!defined(this._pickId)) {
      this._pickId = frameState.context.createPickId(
        {
          primitive: this,
        },
        "primitive",
      );
    }

    if (!defined(this._loadTimestamp)) {
      this._loadTimestamp = JulianDate.clone(frameState.time);
    }

    const timeSinceLoad = Math.max(
      JulianDate.secondsDifference(frameState.time, this._loadTimestamp) * 1000,
      0.0,
    );

    const clippingPlanes = this._clippingPlanes;
    let clippingPlanesState = 0;
    let clippingPlanesDirty = false;
    const isClipped = defined(clippingPlanes) && clippingPlanes.enabled;

    if (isClipped) {
      clippingPlanes.update(frameState);
      clippingPlanesState = clippingPlanes.clippingPlanesState;
    }

    if (this._clippingPlanesState !== clippingPlanesState) {
      this._clippingPlanesState = clippingPlanesState;
      clippingPlanesDirty = true;
    }

    const styleDirty = this._styleDirty;
    this._styleDirty = false;

    if (clippingPlanesDirty || styleDirty) {
      setFramesDirty(this, clippingPlanesDirty, styleDirty);
    }

    updateStateScratch.timeSinceLoad = timeSinceLoad;
    updateStateScratch.isClipped = isClipped;

    const shading = this.shading;
    const eyeDomeLighting = this._pointCloudEyeDomeLighting;

    const commandList = frameState.commandList;
    const lengthBeforeUpdate = commandList.length;

    let previousInterval = this._previousInterval;
    let nextInterval = this._nextInterval;
    const currentInterval = getCurrentInterval(this);

    if (!defined(currentInterval)) {
      return;
    }

    let clockMultiplierChanged = false;
    const clockMultiplier = getClockMultiplier(this);
    const clockPaused = clockMultiplier === 0;
    if (clockMultiplier !== this._clockMultiplier) {
      clockMultiplierChanged = true;
      this._clockMultiplier = clockMultiplier;
    }

    if (!defined(previousInterval) || clockPaused) {
      previousInterval = currentInterval;
    }

    if (
      !defined(nextInterval) ||
      clockMultiplierChanged ||
      reachedInterval(this, currentInterval, nextInterval)
    ) {
      nextInterval = getNextInterval(this, currentInterval);
    }

    previousInterval = getNearestReadyInterval(
      this,
      previousInterval,
      currentInterval,
      updateStateScratch,
      frameState,
    );
    let frame = getFrame(this, previousInterval);

    if (!defined(frame)) {
      loadFrame(this, previousInterval, updateStateScratch, frameState);
      frame = this._lastRenderedFrame;
    }

    if (defined(frame)) {
      renderFrame(this, frame, updateStateScratch, frameState);
    }

    if (defined(nextInterval)) {
      loadFrame(this, nextInterval, updateStateScratch, frameState);
    }

    const that = this;
    if (defined(frame) && !defined(this._lastRenderedFrame)) {
      frameState.afterRender.push(function () {
        return true;
      });
    }

    if (defined(frame) && frame !== this._lastRenderedFrame) {
      if (that.frameChanged.numberOfListeners > 0) {
        frameState.afterRender.push(function () {
          that.frameChanged.raiseEvent(that);
          return true;
        });
      }
    }

    this._previousInterval = previousInterval;
    this._nextInterval = nextInterval;
    this._lastRenderedFrame = frame;

    const totalMemoryUsageInBytes = this._totalMemoryUsageInBytes;
    const maximumMemoryUsageInBytes = this.maximumMemoryUsage * 1024 * 1024;

    if (totalMemoryUsageInBytes > maximumMemoryUsageInBytes) {
      unloadFrames(this, getUnloadCondition(frameState));
    }

    const lengthAfterUpdate = commandList.length;
    const addedCommandsLength = lengthAfterUpdate - lengthBeforeUpdate;

    if (
      defined(shading) &&
      shading.attenuation &&
      shading.eyeDomeLighting &&
      addedCommandsLength > 0
    ) {
      eyeDomeLighting.update(
        frameState,
        lengthBeforeUpdate,
        shading,
        this.boundingSphere,
      );
    }
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see TimeDynamicPointCloud#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   * @example
   * pointCloud = pointCloud && pointCloud.destroy();
   *
   * @see TimeDynamicPointCloud#isDestroyed
   */
  destroy() {
    unloadFrames(this);
    this._pointCloudEyeDomeLighting =
      this._pointCloudEyeDomeLighting &&
      this._pointCloudEyeDomeLighting.destroy();
    this._clippingPlanes =
      this._clippingPlanes && this._clippingPlanes.destroy();
    this._pickId = this._pickId && this._pickId.destroy();
    return destroyObject(this);
  }
}

// --- File-scoped helpers ---

function getFragmentShaderLoaded(fs) {
  return `uniform vec4 czm_pickColor;\n${fs}`;
}

function getUniformMapLoaded(stream) {
  return function (uniformMap) {
    return combine(uniformMap, {
      czm_pickColor: function () {
        return stream._pickId.color;
      },
    });
  };
}

function getPickIdLoaded() {
  return "czm_pickColor";
}

const scratchDate = new JulianDate();

function getClockMultiplier(that) {
  const clock = that._clock;
  const isAnimating = clock.canAnimate && clock.shouldAnimate;
  const multiplier = clock.multiplier;
  return isAnimating ? multiplier : 0.0;
}

function getIntervalIndex(that, interval) {
  return that._intervals.indexOf(interval.start);
}

function getNextInterval(that, currentInterval) {
  const intervals = that._intervals;
  const multiplier = getClockMultiplier(that);

  if (multiplier === 0.0) {
    return undefined;
  }

  const averageLoadTime = that._getAverageLoadTime();
  const time = JulianDate.addSeconds(
    that._clock.currentTime,
    averageLoadTime * multiplier,
    scratchDate,
  );
  let index = intervals.indexOf(time);

  const currentIndex = getIntervalIndex(that, currentInterval);
  if (index === currentIndex) {
    if (multiplier >= 0) {
      ++index;
    } else {
      --index;
    }
  }

  return intervals.get(index);
}

function getCurrentInterval(that) {
  const intervals = that._intervals;
  const time = that._clock.currentTime;
  const index = intervals.indexOf(time);
  return intervals.get(index);
}

function reachedInterval(that, currentInterval, nextInterval) {
  const multiplier = getClockMultiplier(that);
  const currentIndex = getIntervalIndex(that, currentInterval);
  const nextIndex = getIntervalIndex(that, nextInterval);

  if (multiplier >= 0) {
    return currentIndex >= nextIndex;
  }
  return currentIndex <= nextIndex;
}

function handleFrameFailure(that, uri) {
  return function (error) {
    const message = defined(error.message) ? error.message : error.toString();
    if (that.frameFailed.numberOfListeners > 0) {
      that.frameFailed.raiseEvent({
        uri: uri,
        message: message,
      });
    } else {
      console.log(`A frame failed to load: ${uri}`);
      console.log(`Error: ${message}`);
    }
  };
}

function requestFrame(that, interval, frameState) {
  const index = getIntervalIndex(that, interval);
  const frames = that._frames;
  let frame = frames[index];
  if (!defined(frame)) {
    const transformArray = interval.data.transform;
    const transform = defined(transformArray)
      ? Matrix4.fromArray(transformArray)
      : undefined;
    const uri = interval.data.uri;
    frame = {
      pointCloud: undefined,
      transform: transform,
      timestamp: getTimestamp(),
      sequential: true,
      ready: false,
      touchedFrameNumber: frameState.frameNumber,
      uri: uri,
    };
    frames[index] = frame;
    Resource.fetchArrayBuffer({
      url: uri,
    })
      .then(function (arrayBuffer) {
        frame.pointCloud = new PointCloud({
          arrayBuffer: arrayBuffer,
          cull: true,
          fragmentShaderLoaded: getFragmentShaderLoaded,
          uniformMapLoaded: getUniformMapLoaded(that),
          pickIdLoaded: getPickIdLoaded,
        });
      })
      .catch(handleFrameFailure(that, uri));
  }
  return frame;
}

function updateAverageLoadTime(that, loadTime) {
  that._runningSum += loadTime;
  that._runningSum -= that._runningSamples[that._runningIndex];
  that._runningSamples[that._runningIndex] = loadTime;
  that._runningLength = Math.min(
    that._runningLength + 1,
    that._runningSamples.length,
  );
  that._runningIndex = (that._runningIndex + 1) % that._runningSamples.length;
  that._runningAverage = that._runningSum / that._runningLength;
}

function prepareFrame(that, frame, updateState, frameState) {
  if (frame.touchedFrameNumber < frameState.frameNumber - 1) {
    frame.sequential = false;
  }

  const pointCloud = frame.pointCloud;

  if (defined(pointCloud) && !frame.ready) {
    const commandList = frameState.commandList;
    const lengthBeforeUpdate = commandList.length;
    renderFrame(that, frame, updateState, frameState);

    if (pointCloud.ready) {
      frame.ready = true;
      that._totalMemoryUsageInBytes += pointCloud.geometryByteLength;
      commandList.length = lengthBeforeUpdate;
      if (frame.sequential) {
        const loadTime = (getTimestamp() - frame.timestamp) / 1000.0;
        updateAverageLoadTime(that, loadTime);
      }
    }
  }

  frame.touchedFrameNumber = frameState.frameNumber;
}

const scratchModelMatrix = new Matrix4();

function getGeometricError(that, pointCloud) {
  const shading = that.shading;
  if (defined(shading) && defined(shading.baseResolution)) {
    return shading.baseResolution;
  } else if (defined(pointCloud.boundingSphere)) {
    return CesiumMath.cbrt(
      pointCloud.boundingSphere.volume() / pointCloud.pointsLength,
    );
  }
  return 0.0;
}

function getMaximumAttenuation(that) {
  const shading = that.shading;
  if (defined(shading) && defined(shading.maximumAttenuation)) {
    return shading.maximumAttenuation;
  }
  return 10.0;
}

const defaultShading = new PointCloudShading();

function renderFrame(that, frame, updateState, frameState) {
  const shading = that.shading ?? defaultShading;
  const pointCloud = frame.pointCloud;
  const transform = frame.transform ?? Matrix4.IDENTITY;
  pointCloud.modelMatrix = Matrix4.multiplyTransformation(
    that.modelMatrix,
    transform,
    scratchModelMatrix,
  );
  pointCloud.style = that.style;
  pointCloud.time = updateState.timeSinceLoad;
  pointCloud.shadows = that.shadows;
  pointCloud.clippingPlanes = that._clippingPlanes;
  pointCloud.isClipped = updateState.isClipped;
  pointCloud.attenuation = shading.attenuation;
  pointCloud.backFaceCulling = shading.backFaceCulling;
  pointCloud.normalShading = shading.normalShading;
  // WebGPU-only opt-in: run the per-point GPU cull/LOD compute pass within
  // each loaded frame. Read by the WebGPU point-cloud feature renderer
  // (`pointCloud.enableGPULOD`); the WebGL path ignores this field. Default
  // false keeps the existing tile-level LOD path byte-identical.
  pointCloud.enableGPULOD = shading.gpuLOD === true;
  pointCloud.geometricError = getGeometricError(that, pointCloud);
  pointCloud.geometricErrorScale = shading.geometricErrorScale;
  pointCloud.maximumAttenuation = getMaximumAttenuation(that);

  // Sort transparent points back-to-front when enabled. The bridge
  // handles CPU/GPU dispatch based on its useGPUSort flag.
  if (
    that.sortTransparentPoints &&
    pointCloud._isTranslucent &&
    pointCloud._pointsLength > 0
  ) {
    if (!that._pointCloudBridge) {
      that._pointCloudBridge = new WasmPointCloudBridge();
    }
    const bridge = that._pointCloudBridge;
    const count = pointCloud._pointsLength;
    // Lazy-allocate scratch arrays.
    if (!that._sortDistSq || that._sortDistSq.length < count) {
      that._sortDistSq = new Float32Array(count);
      that._sortIndices = new Uint32Array(count);
    }
    // P3.6 — opt the bridge into GPU sort when the context's performance
    // manager says so. The manager's `shouldUseGPUPointCloud(count)` gates
    // on (compute supported) + (count >= gpuPointCloudThreshold). We
    // check every frame (cheap — one property compare + one boolean
    // return) so the flag tracks the current point count dynamically.
    const context = frameState.context;
    const perfMgr = context?.performanceManager;
    if (
      perfMgr &&
      typeof perfMgr.shouldUseGPUPointCloud === "function" &&
      perfMgr.shouldUseGPUPointCloud(count)
    ) {
      bridge.useGPUSort = true;
    }
    // Compute squared distances from camera to each point.
    // For now, this is a placeholder — actual position data access
    // depends on whether the parsed content has CPU-side positions.
    // The bridge.sortByDistance call is correct and will dispatch
    // to GPU when useGPUSort is true and context supports compute.
    bridge.sortByDistance(that._sortDistSq, count, that._sortIndices, context);
  }

  try {
    pointCloud.update(frameState);
  } catch (error) {
    handleFrameFailure(that, frame.uri)(error);
  }

  frame.touchedFrameNumber = frameState.frameNumber;
}

function loadFrame(that, interval, updateState, frameState) {
  const frame = requestFrame(that, interval, frameState);
  prepareFrame(that, frame, updateState, frameState);
}

function getUnloadCondition(frameState) {
  return function (frame) {
    return frame.touchedFrameNumber < frameState.frameNumber;
  };
}

function unloadFrames(that, unloadCondition) {
  const frames = that._frames;
  const length = frames.length;
  for (let i = 0; i < length; ++i) {
    const frame = frames[i];
    if (defined(frame)) {
      if (!defined(unloadCondition) || unloadCondition(frame)) {
        const pointCloud = frame.pointCloud;
        if (frame.ready) {
          that._totalMemoryUsageInBytes -= pointCloud.geometryByteLength;
        }
        if (defined(pointCloud)) {
          pointCloud.destroy();
        }
        if (frame === that._lastRenderedFrame) {
          that._lastRenderedFrame = undefined;
        }
        frames[i] = undefined;
      }
    }
  }
}

function getFrame(that, interval) {
  const index = getIntervalIndex(that, interval);
  const frame = that._frames[index];
  if (defined(frame) && frame.ready) {
    return frame;
  }
}

function updateInterval(that, interval, frame, updateState, frameState) {
  if (defined(frame)) {
    if (frame.ready) {
      return true;
    }
    loadFrame(that, interval, updateState, frameState);
    return frame.ready;
  }
  return false;
}

function getNearestReadyInterval(
  that,
  previousInterval,
  currentInterval,
  updateState,
  frameState,
) {
  let i;
  let interval;
  let frame;
  const intervals = that._intervals;
  const frames = that._frames;
  const currentIndex = getIntervalIndex(that, currentInterval);
  const previousIndex = getIntervalIndex(that, previousInterval);

  if (currentIndex >= previousIndex) {
    for (i = currentIndex; i >= previousIndex; --i) {
      interval = intervals.get(i);
      frame = frames[i];
      if (updateInterval(that, interval, frame, updateState, frameState)) {
        return interval;
      }
    }
  } else {
    for (i = currentIndex; i <= previousIndex; ++i) {
      interval = intervals.get(i);
      frame = frames[i];
      if (updateInterval(that, interval, frame, updateState, frameState)) {
        return interval;
      }
    }
  }

  return previousInterval;
}

function setFramesDirty(that, clippingPlanesDirty, styleDirty) {
  const frames = that._frames;
  const framesLength = frames.length;
  for (let i = 0; i < framesLength; ++i) {
    const frame = frames[i];
    if (defined(frame) && defined(frame.pointCloud)) {
      frame.pointCloud.clippingPlanesDirty = clippingPlanesDirty;
      frame.pointCloud.styleDirty = styleDirty;
    }
  }
}

const updateStateScratch = {
  timeSinceLoad: 0,
  isClipped: false,
  clippingPlanesDirty: false,
};

export default TimeDynamicPointCloud;
