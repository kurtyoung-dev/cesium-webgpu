import arrayRemoveDuplicates from "../Core/arrayRemoveDuplicates.js";
import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Color from "../Core/Color.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import DistanceDisplayCondition from "../Core/DistanceDisplayCondition.js";
import Matrix4 from "../Core/Matrix4.js";
import PolylinePipeline from "../Core/PolylinePipeline.js";
import Material from "./Material.js";
import SplitDirection from "./SplitDirection.js";

/**
 * <div class="notice">
 * Create this by calling {@link PolylineCollection#add}. Do not call the constructor directly.
 * </div>
 *
 * A renderable polyline.
 *
 * @alias Polyline
 * @internalConstructor
 * @class
 *
 * @privateParam {object} options Object with the following properties:
 * @privateParam {boolean} [options.show=true] <code>true</code> if this polyline will be shown; otherwise, <code>false</code>.
 * @privateParam {number} [options.width=1.0] The width of the polyline in pixels.
 * @privateParam {boolean} [options.loop=false] Whether a line segment will be added between the last and first line positions to make this line a loop.
 * @privateParam {Material} [options.material=Material.ColorType] The material.
 * @privateParam {Cartesian3[]} [options.positions] The positions.
 * @privateParam {object} [options.id] The user-defined object to be returned when this polyline is picked.
 * @privateParam {DistanceDisplayCondition} [options.distanceDisplayCondition] The condition specifying at what distance from the camera that this polyline will be displayed.
 * @privateParam {PolylineCollection} polylineCollection The renderable polyline collection.
 *
 * @see PolylineCollection
 *
 */
class Polyline {
  constructor(options, polylineCollection) {
    options = options ?? Frozen.EMPTY_OBJECT;

    this._show = options.show ?? true;
    this._width = options.width ?? 1.0;
    this._loop = options.loop ?? false;
    this._distanceDisplayCondition = options.distanceDisplayCondition;

    this._material = options.material;
    if (!defined(this._material)) {
      this._material = Material.fromType(Material.ColorType, {
        color: new Color(1.0, 1.0, 1.0, 1.0),
      });
    }

    let positions = options.positions;
    if (!defined(positions)) {
      positions = [];
    }

    this._positions = positions;
    this._actualPositions = arrayRemoveDuplicates(
      positions,
      Cartesian3.equalsEpsilon,
    );

    if (this._loop && this._actualPositions.length > 2) {
      if (this._actualPositions === this._positions) {
        this._actualPositions = positions.slice();
      }
      this._actualPositions.push(Cartesian3.clone(this._actualPositions[0]));
    }

    this._length = this._actualPositions.length;
    this._id = options.id;

    // DP-H42 — per-polyline override of the scene-wide depth threshold.
    // When a positive distance is set, the rasterizer's depth test is
    // disabled for fragments closer than this distance so the polyline
    // stays visible against occluding terrain / geometry. A value of 0
    // (the default) falls through to `scene.minimumDisableDepthTestDistance`
    // via the frame-wide uniform. Matches the Billboard contract.
    this._disableDepthTestDistance = options.disableDepthTestDistance;

    // DP-H40 — per-polyline split-screen direction:
    //   `SplitDirection.NONE`  (0)  — render everywhere (default)
    //   `SplitDirection.LEFT`  (-1) — render only left of `scene.splitPosition`
    //   `SplitDirection.RIGHT` (+1) — render only right of `scene.splitPosition`
    // Consumed by the `SPLIT_ENABLED` fragment-shader define; discards
    // pixels on the wrong side of the cutoff.
    this._splitDirection = options.splitDirection ?? SplitDirection.NONE;

    let modelMatrix;
    if (defined(polylineCollection)) {
      modelMatrix = Matrix4.clone(polylineCollection.modelMatrix);
    }

    this._modelMatrix = modelMatrix;
    this._segments = PolylinePipeline.wrapLongitude(
      this._actualPositions,
      modelMatrix,
    );

    this._actualLength = undefined;

    this._propertiesChanged = new Uint32Array(NUMBER_OF_PROPERTIES);
    this._polylineCollection = polylineCollection;
    this._dirty = false;
    this._pickId = undefined;
    this._boundingVolume = BoundingSphere.fromPoints(this._actualPositions);
    this._boundingVolumeWC = BoundingSphere.transform(
      this._boundingVolume,
      this._modelMatrix,
    );
    this._boundingVolume2D = new BoundingSphere(); // modified in PolylineCollection
  }

  /**
   * @private
   */
  update() {
    let modelMatrix = Matrix4.IDENTITY;
    if (defined(this._polylineCollection)) {
      modelMatrix = this._polylineCollection.modelMatrix;
    }

    const segmentPositionsLength = this._segments.positions.length;
    const segmentLengths = this._segments.lengths;

    const positionsChanged =
      this._propertiesChanged[POSITION_INDEX] > 0 ||
      this._propertiesChanged[POSITION_SIZE_INDEX] > 0;
    if (!Matrix4.equals(modelMatrix, this._modelMatrix) || positionsChanged) {
      this._segments = PolylinePipeline.wrapLongitude(
        this._actualPositions,
        modelMatrix,
      );
      this._boundingVolumeWC = BoundingSphere.transform(
        this._boundingVolume,
        modelMatrix,
        this._boundingVolumeWC,
      );
    }

    this._modelMatrix = Matrix4.clone(modelMatrix, this._modelMatrix);

    if (this._segments.positions.length !== segmentPositionsLength) {
      // number of positions changed
      makeDirty(this, POSITION_SIZE_INDEX);
    } else {
      const length = segmentLengths.length;
      for (let i = 0; i < length; ++i) {
        if (segmentLengths[i] !== this._segments.lengths[i]) {
          // indices changed
          makeDirty(this, POSITION_SIZE_INDEX);
          break;
        }
      }
    }
  }

  /**
   * @private
   */
  getPickId(context) {
    if (!defined(this._pickId)) {
      this._pickId = context.createPickId(
        {
          primitive: this,
          collection: this._polylineCollection,
          id: this._id,
        },
        "polyline",
      );
    }
    return this._pickId;
  }

  _clean() {
    this._dirty = false;
    const properties = this._propertiesChanged;
    for (let k = 0; k < NUMBER_OF_PROPERTIES - 1; ++k) {
      properties[k] = 0;
    }
  }

  _destroy() {
    this._pickId = this._pickId && this._pickId.destroy();
    this._material = this._material && this._material.destroy();
    this._polylineCollection = undefined;
  }

  /**
   * Determines if this polyline will be shown.  Use this to hide or show a polyline, instead
   * of removing it and re-adding it to the collection.
   * @memberof Polyline.prototype
   * @type {boolean}
   */
  get show() {
    return this._show;
  }

  /**
   * Determines if this polyline will be shown.  Use this to hide or show a polyline, instead
   * of removing it and re-adding it to the collection.
   * @memberof Polyline.prototype
   * @type {boolean}
   */
  set show(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    if (value !== this._show) {
      this._show = value;
      makeDirty(this, SHOW_INDEX);
    }
  }

  /**
   * Gets or sets the positions of the polyline.
   * @memberof Polyline.prototype
   * @type {Cartesian3[]}
   * @example
   * polyline.positions = Cesium.Cartesian3.fromDegreesArray([
   *     0.0, 0.0,
   *     10.0, 0.0,
   *     0.0, 20.0
   * ]);
   */
  get positions() {
    return this._positions;
  }

  /**
   * Gets or sets the positions of the polyline.
   * @memberof Polyline.prototype
   * @type {Cartesian3[]}
   * @example
   * polyline.positions = Cesium.Cartesian3.fromDegreesArray([
   *     0.0, 0.0,
   *     10.0, 0.0,
   *     0.0, 20.0
   * ]);
   */
  set positions(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    let positions = arrayRemoveDuplicates(value, Cartesian3.equalsEpsilon);

    if (this._loop && positions.length > 2) {
      if (positions === value) {
        positions = value.slice();
      }
      positions.push(Cartesian3.clone(positions[0]));
    }

    if (
      this._actualPositions.length !== positions.length ||
      this._actualPositions.length !== this._length
    ) {
      makeDirty(this, POSITION_SIZE_INDEX);
    }

    this._positions = value;
    this._actualPositions = positions;
    this._length = positions.length;
    this._boundingVolume = BoundingSphere.fromPoints(
      this._actualPositions,
      this._boundingVolume,
    );
    this._boundingVolumeWC = BoundingSphere.transform(
      this._boundingVolume,
      this._modelMatrix,
      this._boundingVolumeWC,
    );
    makeDirty(this, POSITION_INDEX);

    this.update();
  }

  /**
   * Gets or sets the surface appearance of the polyline.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
   * {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}.
   * @memberof Polyline.prototype
   * @type {Material}
   */
  get material() {
    return this._material;
  }

  /**
   * Gets or sets the surface appearance of the polyline.  This can be one of several built-in {@link Material} objects or a custom material, scripted with
   * {@link https://github.com/CesiumGS/cesium/wiki/Fabric|Fabric}.
   * @memberof Polyline.prototype
   * @type {Material}
   */
  set material(material) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(material)) {
      throw new DeveloperError("material is required.");
    }
    //>>includeEnd('debug');

    if (this._material !== material) {
      this._material = material;
      makeDirty(this, MATERIAL_INDEX);
    }
  }

  /**
   * Gets or sets the width of the polyline.
   * @memberof Polyline.prototype
   * @type {number}
   */
  get width() {
    return this._width;
  }

  /**
   * Gets or sets the width of the polyline.
   * @memberof Polyline.prototype
   * @type {number}
   */
  set width(value) {
    //>>includeStart('debug', pragmas.debug)
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    const width = this._width;
    if (value !== width) {
      this._width = value;
      makeDirty(this, WIDTH_INDEX);
    }
  }

  /**
   * Gets or sets whether a line segment will be added between the first and last polyline positions.
   * @memberof Polyline.prototype
   * @type {boolean}
   */
  get loop() {
    return this._loop;
  }

  /**
   * Gets or sets whether a line segment will be added between the first and last polyline positions.
   * @memberof Polyline.prototype
   * @type {boolean}
   */
  set loop(value) {
    //>>includeStart('debug', pragmas.debug)
    if (!defined(value)) {
      throw new DeveloperError("value is required.");
    }
    //>>includeEnd('debug');

    if (value !== this._loop) {
      let positions = this._actualPositions;
      if (value) {
        if (
          positions.length > 2 &&
          !Cartesian3.equals(positions[0], positions[positions.length - 1])
        ) {
          if (positions.length === this._positions.length) {
            this._actualPositions = positions = this._positions.slice();
          }
          positions.push(Cartesian3.clone(positions[0]));
        }
      } else if (
        positions.length > 2 &&
        Cartesian3.equals(positions[0], positions[positions.length - 1])
      ) {
        if (positions.length - 1 === this._positions.length) {
          this._actualPositions = this._positions;
        } else {
          positions.pop();
        }
      }

      this._loop = value;
      makeDirty(this, POSITION_SIZE_INDEX);
    }
  }

  /**
   * Gets or sets the user-defined value returned when the polyline is picked.
   * @memberof Polyline.prototype
   * @type {*}
   */
  get id() {
    return this._id;
  }

  /**
   * Gets or sets the user-defined value returned when the polyline is picked.
   * @memberof Polyline.prototype
   * @type {*}
   */
  set id(value) {
    this._id = value;
    if (defined(this._pickId)) {
      this._pickId.object.id = value;
    }
  }

  /**
   * @private
   */
  get pickId() {
    return this._pickId;
  }

  /**
   * Gets the destruction status of this polyline
   * @memberof Polyline.prototype
   * @type {boolean}
   * @default false
   * @private
   */
  get isDestroyed() {
    return !defined(this._polylineCollection);
  }

  /**
   * Gets or sets the condition specifying at what distance from the camera that this polyline will be displayed.
   * @memberof Polyline.prototype
   * @type {DistanceDisplayCondition}
   * @default undefined
   */
  get distanceDisplayCondition() {
    return this._distanceDisplayCondition;
  }

  /**
   * Gets or sets the condition specifying at what distance from the camera that this polyline will be displayed.
   * @memberof Polyline.prototype
   * @type {DistanceDisplayCondition}
   * @default undefined
   */
  set distanceDisplayCondition(value) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(value) && value.far <= value.near) {
      throw new DeveloperError(
        "far distance must be greater than near distance.",
      );
    }
    //>>includeEnd('debug');
    if (
      !DistanceDisplayCondition.equals(value, this._distanceDisplayCondition)
    ) {
      this._distanceDisplayCondition = DistanceDisplayCondition.clone(
        value,
        this._distanceDisplayCondition,
      );
      makeDirty(this, DISTANCE_DISPLAY_CONDITION);
    }
  }

  /**
   * Gets or sets the distance from the camera at which to disable the depth
   * test to prevent clipping against terrain, e.g., to prevent clipping
   * against the edge of the Earth when looking at the horizon.
   * @memberof Polyline.prototype
   * @type {number}
   * @default 0.0
   */
  get disableDepthTestDistance() {
    return this._disableDepthTestDistance;
  }

  set disableDepthTestDistance(value) {
    //>>includeStart('debug', pragmas.debug);
    if (defined(value) && value < 0.0) {
      throw new DeveloperError(
        "disableDepthTestDistance must be greater than or equal to 0.0.",
      );
    }
    //>>includeEnd('debug');
    if (this._disableDepthTestDistance !== value) {
      this._disableDepthTestDistance = value;
      makeDirty(this, DISABLE_DEPTH_TEST_DISTANCE);
    }
  }

  /**
   * Gets or sets the {@link SplitDirection} of this polyline. Controls which
   * side of `scene.splitPosition` the polyline is rendered on.
   * @memberof Polyline.prototype
   * @type {SplitDirection}
   * @default SplitDirection.NONE
   */
  get splitDirection() {
    return this._splitDirection;
  }

  set splitDirection(value) {
    if (this._splitDirection !== value) {
      this._splitDirection = value;
      makeDirty(this, SPLIT_DIRECTION);
    }
  }
}

const POSITION_INDEX = (Polyline.POSITION_INDEX = 0);
const SHOW_INDEX = (Polyline.SHOW_INDEX = 1);
const WIDTH_INDEX = (Polyline.WIDTH_INDEX = 2);
const MATERIAL_INDEX = (Polyline.MATERIAL_INDEX = 3);
const POSITION_SIZE_INDEX = (Polyline.POSITION_SIZE_INDEX = 4);
const DISTANCE_DISPLAY_CONDITION = (Polyline.DISTANCE_DISPLAY_CONDITION = 5);
const DISABLE_DEPTH_TEST_DISTANCE =
  (Polyline.DISABLE_DEPTH_TEST_DISTANCE = 6);
const SPLIT_DIRECTION = (Polyline.SPLIT_DIRECTION = 7);
const NUMBER_OF_PROPERTIES = (Polyline.NUMBER_OF_PROPERTIES = 8);

function makeDirty(polyline, propertyChanged) {
  ++polyline._propertiesChanged[propertyChanged];
  const polylineCollection = polyline._polylineCollection;
  if (defined(polylineCollection)) {
    polylineCollection._updatePolyline(polyline, propertyChanged);
    polyline._dirty = true;
  }
}

export default Polyline;
