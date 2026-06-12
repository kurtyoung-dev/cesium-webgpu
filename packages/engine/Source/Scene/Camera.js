import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Event from "../Core/Event.js";
import HeadingPitchRange from "../Core/HeadingPitchRange.js";
import HeadingPitchRoll from "../Core/HeadingPitchRoll.js";
import Intersect from "../Core/Intersect.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import Quaternion from "../Core/Quaternion.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import Transforms from "../Core/Transforms.js";
import CameraFlightPath from "./CameraFlightPath.js";
import {
  updateMembers,
  updateCameraDeltas,
  getHeading,
  getPitch,
  getRoll,
  clampMove2D,
  zoom2D,
  zoom3D,
  rotateVertical,
  rotateHorizontal,
} from "./CameraInternals.js";
import {
  setView3D,
  setViewCV,
  setView2D,
  directionUpToHeadingPitchRoll,
  calculateOrthographicFrustumWidth,
  rectangleCameraPosition3D,
  rectangleCameraPositionColumbusView,
  rectangleCameraPosition2D,
  pickEllipsoid3D,
  pickMap2D,
  pickMapColumbusView,
  getPickRayPerspective,
  getPickRayOrthographic,
  computeHorizonQuad,
  addToResult,
  cartoArray,
  offsetFromHeadingPitchRange,
  adjustBoundingSphereOffset,
  createAnimationCV,
} from "./CameraHelpers.js";
import SceneMode from "./SceneMode.js";

/**
 * @typedef {object} DirectionUp
 *
 * An orientation given by a pair of unit vectors
 *
 * @property {Cartesian3} direction The unit "direction" vector
 * @property {Cartesian3} up The unit "up" vector
 **/
/**
 * @typedef {object} HeadingPitchRollValues
 *
 * An orientation given by numeric heading, pitch, and roll
 *
 * @property {number} [heading=0.0] The heading in radians
 * @property {number} [pitch=-CesiumMath.PI_OVER_TWO] The pitch in radians
 * @property {number} [roll=0.0] The roll in radians
 **/

const scratchHPRMatrix1 = new Matrix4();
const scratchHPRMatrix2 = new Matrix4();
const scratchSetViewCartesian = new Cartesian3();
const scratchSetViewOptions = {
  destination: undefined,
  orientation: {
    direction: undefined,
    up: undefined,
    heading: undefined,
    pitch: undefined,
    roll: undefined,
  },
  convert: undefined,
  endTransform: undefined,
};
const scratchHpr = new HeadingPitchRoll();
const setTransformPosition = new Cartesian3();
const setTransformUp = new Cartesian3();
const setTransformDirection = new Cartesian3();
const moveScratch = new Cartesian3();
const lookScratchQuaternion = new Quaternion();
const lookScratchMatrix = new Matrix3();
const rotateScratchQuaternion = new Quaternion();
const rotateScratchMatrix = new Matrix3();
const scratchLookAtMatrix4 = new Matrix4();
const scratchToCenter = new Cartesian3();
const scratchProj = new Cartesian3();
const scratchPixelSize = new Cartesian2();
const pitchScratch = new Cartesian3();
const scratchFlyToDestination = new Cartesian3();
const scratchflyToBoundingSphereTransform = new Matrix4();
const scratchflyToBoundingSphereDestination = new Cartesian3();
const scratchflyToBoundingSphereDirection = new Cartesian3();
const scratchflyToBoundingSphereUp = new Cartesian3();
const scratchflyToBoundingSphereRight = new Cartesian3();
const scratchFlyToBoundingSphereCart4 = new Cartesian4();
const scratchFlyToBoundingSphereQuaternion = new Quaternion();
const scratchFlyToBoundingSphereMatrix3 = new Matrix3();

const newOptions = {
  destination: undefined,
  heading: undefined,
  pitch: undefined,
  roll: undefined,
  duration: undefined,
  complete: undefined,
  cancel: undefined,
  endTransform: undefined,
  maximumHeight: undefined,
  easingFunction: undefined,
};

/**
 * The camera is defined by a position, orientation, and view frustum.
 *
 * The orientation forms an orthonormal basis with a view, up and right = view x up unit vectors.
 *
 * The viewing frustum is defined by 6 planes.
 * Each plane is represented by a {@link Cartesian4} object, where the x, y, and z components
 * define the unit vector normal to the plane, and the w component is the distance of the
 * plane from the origin/camera position.
 *
 * @alias Camera
 *
 * @param {Scene} scene The scene.
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=camera|Cesium Sandcastle Camera Demo}
 * @demo {@link https://sandcastle.cesium.com/index.html?id=camera-tutorial|Cesium Sandcastle Camera Tutorial Example}
 * @demo {@link https://cesium.com/learn/cesiumjs-learn/cesiumjs-camera|Camera Tutorial}
 *
 * @example
 * // Create a camera looking down the negative z-axis, positioned at the origin,
 * // with a field of view of 60 degrees, and 1:1 aspect ratio.
 * const camera = new Cesium.Camera(scene);
 * camera.position = new Cesium.Cartesian3();
 * camera.direction = Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());
 * camera.up = Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Y);
 * camera.frustum.fov = Cesium.Math.PI_OVER_THREE;
 * camera.frustum.near = 1.0;
 * camera.frustum.far = 2.0;
 */
class Camera {
  constructor(scene) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene)) {
      throw new DeveloperError("scene is required.");
    }
    //>>includeEnd('debug');
    this._scene = scene;

    this._transform = Matrix4.clone(Matrix4.IDENTITY);
    this._invTransform = Matrix4.clone(Matrix4.IDENTITY);
    this._actualTransform = Matrix4.clone(Matrix4.IDENTITY);
    this._actualInvTransform = Matrix4.clone(Matrix4.IDENTITY);
    this._transformChanged = false;

    /** @type {Cartesian3} */
    this.position = new Cartesian3();
    this._position = new Cartesian3();
    this._positionWC = new Cartesian3();
    this._positionCartographic = new Cartographic();
    this._oldPositionWC = undefined;

    /** @private */
    this.positionWCDeltaMagnitude = 0.0;
    /** @private */
    this.positionWCDeltaMagnitudeLastFrame = 0.0;
    /** @private */
    this.timeSinceMoved = 0.0;
    this._lastMovedTimestamp = 0.0;

    /** @type {Cartesian3} */
    this.direction = new Cartesian3();
    this._direction = new Cartesian3();
    this._directionWC = new Cartesian3();

    /** @type {Cartesian3} */
    this.up = new Cartesian3();
    this._up = new Cartesian3();
    this._upWC = new Cartesian3();

    /** @type {Cartesian3} */
    this.right = new Cartesian3();
    this._right = new Cartesian3();
    this._rightWC = new Cartesian3();

    /**
     * @type {PerspectiveFrustum|PerspectiveOffCenterFrustum|OrthographicFrustum}
     * @default PerspectiveFrustum()
     */
    this.frustum = new PerspectiveFrustum();
    this.frustum.aspectRatio =
      scene.drawingBufferWidth / scene.drawingBufferHeight;
    this.frustum.fov = CesiumMath.toRadians(60.0);

    /**
     * @type {number}
     * @default 100000.0
     */
    this.defaultMoveAmount = 100000.0;
    /**
     * @type {number}
     * @default Math.PI / 60.0
     */
    this.defaultLookAmount = Math.PI / 60.0;
    /**
     * @type {number}
     * @default Math.PI / 3600.0
     */
    this.defaultRotateAmount = Math.PI / 3600.0;
    /**
     * @type {number}
     * @default 100000.0
     */
    this.defaultZoomAmount = 100000.0;
    /**
     * @type {Cartesian3 | undefined}
     * @default undefined
     */
    this.constrainedAxis = undefined;
    /**
     * @type {number}
     * @default 1.5
     */
    this.maximumZoomFactor = 1.5;

    this._moveStart = new Event();
    this._moveEnd = new Event();
    this._changed = new Event();
    this._changedPosition = undefined;
    this._changedDirection = undefined;
    this._changedFrustum = undefined;
    this._changedHeading = undefined;
    this._changedRoll = undefined;

    /**
     * @type {number}
     * @default 0.5
     */
    this.percentageChanged = 0.5;

    this._viewMatrix = new Matrix4();
    this._invViewMatrix = new Matrix4();
    updateMembers(this);

    this._mode = SceneMode.SCENE3D;
    this._modeChanged = true;
    const projection = scene.mapProjection;
    this._projection = projection;
    this._maxCoord = projection.project(
      new Cartographic(Math.PI, CesiumMath.PI_OVER_TWO),
    );
    this._max2Dfrustum = undefined;

    // set default view
    rectangleCameraPosition3D(
      this,
      Camera.DEFAULT_VIEW_RECTANGLE,
      this.position,
      true,
    );

    let mag = Cartesian3.magnitude(this.position);
    mag += mag * Camera.DEFAULT_VIEW_FACTOR;
    Cartesian3.normalize(this.position, this.position);
    Cartesian3.multiplyByScalar(this.position, mag, this.position);
  }

  /**
   * @readonly
   * @type {Matrix4}
   */
  get transform() {
    return this._transform;
  }

  /**
   * @readonly
   * @type {Matrix4}
   */
  get inverseTransform() {
    updateMembers(this);
    return this._invTransform;
  }

  /**
   * @readonly
   * @type {Matrix4}
   */
  get viewMatrix() {
    updateMembers(this);
    return this._viewMatrix;
  }

  /**
   * @readonly
   * @type {Matrix4}
   */
  get inverseViewMatrix() {
    updateMembers(this);
    return this._invViewMatrix;
  }

  /**
   * @readonly
   * @type {Cartographic}
   */
  get positionCartographic() {
    updateMembers(this);
    return this._positionCartographic;
  }

  /**
   * @readonly
   * @type {Cartesian3}
   */
  get positionWC() {
    updateMembers(this);
    return this._positionWC;
  }

  /**
   * @readonly
   * @type {Cartesian3}
   */
  get directionWC() {
    updateMembers(this);
    return this._directionWC;
  }

  /**
   * @readonly
   * @type {Cartesian3}
   */
  get upWC() {
    updateMembers(this);
    return this._upWC;
  }

  /**
   * @readonly
   * @type {Cartesian3}
   */
  get rightWC() {
    updateMembers(this);
    return this._rightWC;
  }

  /**
   * @readonly
   * @type {number}
   */
  get heading() {
    if (this._mode !== SceneMode.MORPHING) {
      const ellipsoid = this._projection.ellipsoid;
      const oldTransform = Matrix4.clone(this._transform, scratchHPRMatrix1);
      const transform = Transforms.eastNorthUpToFixedFrame(
        this.positionWC,
        ellipsoid,
        scratchHPRMatrix2,
      );
      this._setTransform(transform);
      const heading = getHeading(this.direction, this.up);
      this._setTransform(oldTransform);
      return heading;
    }
    return undefined;
  }

  /**
   * @readonly
   * @type {number}
   */
  get pitch() {
    if (this._mode !== SceneMode.MORPHING) {
      const ellipsoid = this._projection.ellipsoid;
      const oldTransform = Matrix4.clone(this._transform, scratchHPRMatrix1);
      const transform = Transforms.eastNorthUpToFixedFrame(
        this.positionWC,
        ellipsoid,
        scratchHPRMatrix2,
      );
      this._setTransform(transform);
      const pitch = getPitch(this.direction);
      this._setTransform(oldTransform);
      return pitch;
    }
    return undefined;
  }

  /**
   * @readonly
   * @type {number}
   */
  get roll() {
    if (this._mode !== SceneMode.MORPHING) {
      const ellipsoid = this._projection.ellipsoid;
      const oldTransform = Matrix4.clone(this._transform, scratchHPRMatrix1);
      const transform = Transforms.eastNorthUpToFixedFrame(
        this.positionWC,
        ellipsoid,
        scratchHPRMatrix2,
      );
      this._setTransform(transform);
      const roll = getRoll(this.direction, this.up, this.right);
      this._setTransform(oldTransform);
      return roll;
    }
    return undefined;
  }

  /**
   * @readonly
   * @type {Event}
   */
  get moveStart() {
    return this._moveStart;
  }

  /**
   * @readonly
   * @type {Event}
   */
  get moveEnd() {
    return this._moveEnd;
  }

  /**
   * @readonly
   * @type {Event}
   */
  get changed() {
    return this._changed;
  }

  /** @private */
  canPreloadFlight() {
    return defined(this._currentFlight) && this._mode !== SceneMode.SCENE2D;
  }

  /** @private */
  _updateCameraChanged() {
    updateCameraDeltas(this);

    if (this._changed.numberOfListeners === 0) {
      return;
    }

    const percentageChanged = this.percentageChanged;
    const currentHeading = this.heading;

    if (!defined(this._changedHeading)) {
      this._changedHeading = currentHeading;
    }

    let headingDelta =
      Math.abs(this._changedHeading - currentHeading) % CesiumMath.TWO_PI;
    headingDelta =
      headingDelta > CesiumMath.PI
        ? CesiumMath.TWO_PI - headingDelta
        : headingDelta;
    const headingChangedPercentage = headingDelta / Math.PI;

    if (headingChangedPercentage > percentageChanged) {
      this._changedHeading = currentHeading;
    }

    const currentRoll = this.roll;
    if (!defined(this._changedRoll)) {
      this._changedRoll = currentRoll;
    }

    let rollDelta =
      Math.abs(this._changedRoll - currentRoll) % CesiumMath.TWO_PI;
    rollDelta =
      rollDelta > CesiumMath.PI ? CesiumMath.TWO_PI - rollDelta : rollDelta;
    const rollChangedPercentage = rollDelta / Math.PI;

    if (rollChangedPercentage > percentageChanged) {
      this._changedRoll = currentRoll;
    }
    if (
      rollChangedPercentage > percentageChanged ||
      headingChangedPercentage > percentageChanged
    ) {
      this._changed.raiseEvent(
        Math.max(rollChangedPercentage, headingChangedPercentage),
      );
    }

    if (this._mode === SceneMode.SCENE2D) {
      if (!defined(this._changedFrustum)) {
        this._changedPosition = Cartesian3.clone(
          this.position,
          this._changedPosition,
        );
        this._changedFrustum = this.frustum.clone();
        return;
      }

      const position = this.position;
      const lastPosition = this._changedPosition;
      const frustum = this.frustum;
      const lastFrustum = this._changedFrustum;

      const x0 = position.x + frustum.left;
      const x1 = position.x + frustum.right;
      const x2 = lastPosition.x + lastFrustum.left;
      const x3 = lastPosition.x + lastFrustum.right;
      const y0 = position.y + frustum.bottom;
      const y1 = position.y + frustum.top;
      const y2 = lastPosition.y + lastFrustum.bottom;
      const y3 = lastPosition.y + lastFrustum.top;

      const leftX = Math.max(x0, x2);
      const rightX = Math.min(x1, x3);
      const bottomY = Math.max(y0, y2);
      const topY = Math.min(y1, y3);

      let areaPercentage;
      if (leftX >= rightX || bottomY >= y1) {
        areaPercentage = 1.0;
      } else {
        let areaRef = lastFrustum;
        if (x0 < x2 && x1 > x3 && y0 < y2 && y1 > y3) {
          areaRef = frustum;
        }
        areaPercentage =
          1.0 -
          ((rightX - leftX) * (topY - bottomY)) /
            ((areaRef.right - areaRef.left) * (areaRef.top - areaRef.bottom));
      }

      if (areaPercentage > percentageChanged) {
        this._changed.raiseEvent(areaPercentage);
        this._changedPosition = Cartesian3.clone(
          this.position,
          this._changedPosition,
        );
        this._changedFrustum = this.frustum.clone(this._changedFrustum);
      }
      return;
    }

    if (!defined(this._changedDirection)) {
      this._changedPosition = Cartesian3.clone(
        this.positionWC,
        this._changedPosition,
      );
      this._changedDirection = Cartesian3.clone(
        this.directionWC,
        this._changedDirection,
      );
      return;
    }

    const dirAngle = CesiumMath.acosClamped(
      Cartesian3.dot(this.directionWC, this._changedDirection),
    );

    let dirPercentage;
    if (defined(this.frustum.fovy)) {
      dirPercentage = dirAngle / (this.frustum.fovy * 0.5);
    } else {
      dirPercentage = dirAngle;
    }

    const distance = Cartesian3.distance(
      this.positionWC,
      this._changedPosition,
    );
    const heightPercentage = distance / this.positionCartographic.height;

    if (
      dirPercentage > percentageChanged ||
      heightPercentage > percentageChanged
    ) {
      this._changed.raiseEvent(Math.max(dirPercentage, heightPercentage));
      this._changedPosition = Cartesian3.clone(
        this.positionWC,
        this._changedPosition,
      );
      this._changedDirection = Cartesian3.clone(
        this.directionWC,
        this._changedDirection,
      );
    }
  }

  /** @private */
  update(mode) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(mode)) {
      throw new DeveloperError("mode is required.");
    }
    if (
      mode === SceneMode.SCENE2D &&
      !(this.frustum instanceof OrthographicOffCenterFrustum)
    ) {
      throw new DeveloperError(
        "An OrthographicOffCenterFrustum is required in 2D.",
      );
    }
    if (
      (mode === SceneMode.SCENE3D || mode === SceneMode.COLUMBUS_VIEW) &&
      !(this.frustum instanceof PerspectiveFrustum) &&
      !(this.frustum instanceof OrthographicFrustum)
    ) {
      throw new DeveloperError(
        "A PerspectiveFrustum or OrthographicFrustum is required in 3D and Columbus view",
      );
    }
    //>>includeEnd('debug');

    let updateFrustum = false;
    if (mode !== this._mode) {
      this._mode = mode;
      this._modeChanged = mode !== SceneMode.MORPHING;
      updateFrustum = this._mode === SceneMode.SCENE2D;
    }

    if (updateFrustum) {
      const frustum = (this._max2Dfrustum = this.frustum.clone());
      //>>includeStart('debug', pragmas.debug);
      if (!(frustum instanceof OrthographicOffCenterFrustum)) {
        throw new DeveloperError(
          "The camera frustum is expected to be orthographic for 2D camera control.",
        );
      }
      //>>includeEnd('debug');
      const maxZoomOut = 2.0;
      const ratio = frustum.top / frustum.right;
      frustum.right = this._maxCoord.x * maxZoomOut;
      frustum.left = -frustum.right;
      frustum.top = ratio * frustum.right;
      frustum.bottom = -frustum.top;
    }

    if (this._mode === SceneMode.SCENE2D) {
      clampMove2D(this, this.position);
    }
  }

  _setTransform(transform) {
    const position = Cartesian3.clone(this.positionWC, setTransformPosition);
    const up = Cartesian3.clone(this.upWC, setTransformUp);
    const direction = Cartesian3.clone(this.directionWC, setTransformDirection);

    Matrix4.clone(transform, this._transform);
    this._transformChanged = true;
    updateMembers(this);
    const inverse = this._actualInvTransform;

    Matrix4.multiplyByPoint(inverse, position, this.position);
    Matrix4.multiplyByPointAsVector(inverse, direction, this.direction);
    Matrix4.multiplyByPointAsVector(inverse, up, this.up);
    Cartesian3.cross(this.direction, this.up, this.right);

    updateMembers(this);
  }

  _adjustOrthographicFrustum(zooming) {
    if (!(this.frustum instanceof OrthographicFrustum)) {
      return;
    }
    if (!zooming && this._positionCartographic.height < 150000.0) {
      return;
    }
    this.frustum.width = calculateOrthographicFrustumWidth(this);
  }

  /**
   * Sets the camera position, orientation and transform.
   *
   * @param {object} options Object with the following properties:
   * @param {Cartesian3|Rectangle} [options.destination] The final position of the camera in world coordinates or a rectangle that would be visible from a top-down view.
   * @param {HeadingPitchRollValues|DirectionUp} [options.orientation] An object that contains either direction and up properties or heading, pitch and roll properties.
   * @param {Matrix4} [options.endTransform] Transform matrix representing the reference frame of the camera.
   * @param {boolean} [options.convert] Whether to convert the destination from world coordinates to scene coordinates (only relevant when not using 3D). Defaults to <code>true</code>.
   */
  setView(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    let orientation = options.orientation ?? Frozen.EMPTY_OBJECT;

    const mode = this._mode;
    if (mode === SceneMode.MORPHING) {
      return;
    }

    if (defined(options.endTransform)) {
      this._setTransform(options.endTransform);
    }

    let convert = options.convert ?? true;
    let destination =
      options.destination ??
      Cartesian3.clone(this.positionWC, scratchSetViewCartesian);
    if (defined(destination) && defined(destination.west)) {
      destination = this.getRectangleCameraCoordinates(
        destination,
        scratchSetViewCartesian,
      );
      //>>includeStart('debug', pragmas.debug);
      if (isNaN(destination.x) || isNaN(destination.y)) {
        throw new DeveloperError(`destination has a NaN component`);
      }
      //>>includeEnd('debug');
      convert = false;
    }

    if (defined(orientation.direction)) {
      orientation = directionUpToHeadingPitchRoll(
        this,
        destination,
        orientation,
        scratchSetViewOptions.orientation,
      );
    }

    scratchHpr.heading = orientation.heading ?? 0.0;
    scratchHpr.pitch = orientation.pitch ?? -CesiumMath.PI_OVER_TWO;
    scratchHpr.roll = orientation.roll ?? 0.0;

    if (mode === SceneMode.SCENE3D) {
      setView3D(this, destination, scratchHpr);
    } else if (mode === SceneMode.SCENE2D) {
      setView2D(this, destination, scratchHpr, convert);
    } else {
      setViewCV(this, destination, scratchHpr, convert);
    }
  }

  /**
   * Fly the camera to the home view.
   * @param {number} [duration] The duration of the flight in seconds.
   */
  flyHome(duration) {
    const mode = this._mode;
    if (mode === SceneMode.MORPHING) {
      this._scene.completeMorph();
    }

    if (mode === SceneMode.SCENE2D) {
      this.flyTo({
        destination: Camera.DEFAULT_VIEW_RECTANGLE,
        duration: duration,
        endTransform: Matrix4.IDENTITY,
      });
    } else if (mode === SceneMode.SCENE3D) {
      const destination = this.getRectangleCameraCoordinates(
        Camera.DEFAULT_VIEW_RECTANGLE,
      );
      let mag = Cartesian3.magnitude(destination);
      mag += mag * Camera.DEFAULT_VIEW_FACTOR;
      Cartesian3.normalize(destination, destination);
      Cartesian3.multiplyByScalar(destination, mag, destination);
      this.flyTo({
        destination: destination,
        duration: duration,
        endTransform: Matrix4.IDENTITY,
      });
    } else if (mode === SceneMode.COLUMBUS_VIEW) {
      const maxRadii = this._projection.ellipsoid.maximumRadius;
      let position = new Cartesian3(0.0, -1.0, 1.0);
      position = Cartesian3.multiplyByScalar(
        Cartesian3.normalize(position, position),
        5.0 * maxRadii,
        position,
      );
      this.flyTo({
        destination: position,
        duration: duration,
        orientation: {
          heading: 0.0,
          pitch: -Math.acos(Cartesian3.normalize(position, pitchScratch).z),
          roll: 0.0,
        },
        endTransform: Matrix4.IDENTITY,
        convert: false,
      });
    }
  }

  /** @param {Cartesian4} cartesian @param {Cartesian4} [result] @returns {Cartesian4} */
  worldToCameraCoordinates(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian4();
    }
    updateMembers(this);
    return Matrix4.multiplyByVector(
      this._actualInvTransform,
      cartesian,
      result,
    );
  }

  /** @param {Cartesian3} cartesian @param {Cartesian3} [result] @returns {Cartesian3} */
  worldToCameraCoordinatesPoint(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian3();
    }
    updateMembers(this);
    return Matrix4.multiplyByPoint(this._actualInvTransform, cartesian, result);
  }

  /** @param {Cartesian3} cartesian @param {Cartesian3} [result] @returns {Cartesian3} */
  worldToCameraCoordinatesVector(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian3();
    }
    updateMembers(this);
    return Matrix4.multiplyByPointAsVector(
      this._actualInvTransform,
      cartesian,
      result,
    );
  }

  /** @param {Cartesian4} cartesian @param {Cartesian4} [result] @returns {Cartesian4} */
  cameraToWorldCoordinates(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian4();
    }
    updateMembers(this);
    return Matrix4.multiplyByVector(this._actualTransform, cartesian, result);
  }

  /** @param {Cartesian3} cartesian @param {Cartesian3} [result] @returns {Cartesian3} */
  cameraToWorldCoordinatesPoint(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian3();
    }
    updateMembers(this);
    return Matrix4.multiplyByPoint(this._actualTransform, cartesian, result);
  }

  /** @param {Cartesian3} cartesian @param {Cartesian3} [result] @returns {Cartesian3} */
  cameraToWorldCoordinatesVector(cartesian, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(cartesian)) {
      throw new DeveloperError("cartesian is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Cartesian3();
    }
    updateMembers(this);
    return Matrix4.multiplyByPointAsVector(
      this._actualTransform,
      cartesian,
      result,
    );
  }

  move(direction, amount) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(direction)) {
      throw new DeveloperError("direction is required.");
    }
    //>>includeEnd('debug');
    const cameraPosition = this.position;
    Cartesian3.multiplyByScalar(direction, amount, moveScratch);
    Cartesian3.add(cameraPosition, moveScratch, cameraPosition);
    if (this._mode === SceneMode.SCENE2D) {
      clampMove2D(this, cameraPosition);
    }
    this._adjustOrthographicFrustum(true);
  }

  moveForward(amount) {
    amount = amount ?? this.defaultMoveAmount;
    if (this._mode === SceneMode.SCENE2D) {
      zoom2D(this, amount);
    } else {
      this.move(this.direction, amount);
    }
  }

  moveBackward(amount) {
    amount = amount ?? this.defaultMoveAmount;
    if (this._mode === SceneMode.SCENE2D) {
      zoom2D(this, -amount);
    } else {
      this.move(this.direction, -amount);
    }
  }

  moveUp(amount) {
    amount = amount ?? this.defaultMoveAmount;
    this.move(this.up, amount);
  }

  moveDown(amount) {
    amount = amount ?? this.defaultMoveAmount;
    this.move(this.up, -amount);
  }

  moveRight(amount) {
    amount = amount ?? this.defaultMoveAmount;
    this.move(this.right, amount);
  }

  moveLeft(amount) {
    amount = amount ?? this.defaultMoveAmount;
    this.move(this.right, -amount);
  }

  lookLeft(amount) {
    amount = amount ?? this.defaultLookAmount;
    if (this._mode !== SceneMode.SCENE2D) {
      this.look(this.up, -amount);
    }
  }

  lookRight(amount) {
    amount = amount ?? this.defaultLookAmount;
    if (this._mode !== SceneMode.SCENE2D) {
      this.look(this.up, amount);
    }
  }

  lookUp(amount) {
    amount = amount ?? this.defaultLookAmount;
    if (this._mode !== SceneMode.SCENE2D) {
      this.look(this.right, -amount);
    }
  }

  lookDown(amount) {
    amount = amount ?? this.defaultLookAmount;
    if (this._mode !== SceneMode.SCENE2D) {
      this.look(this.right, amount);
    }
  }

  look(axis, angle) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(axis)) {
      throw new DeveloperError("axis is required.");
    }
    //>>includeEnd('debug');
    const turnAngle = angle ?? this.defaultLookAmount;
    const quaternion = Quaternion.fromAxisAngle(
      axis,
      -turnAngle,
      lookScratchQuaternion,
    );
    const rotation = Matrix3.fromQuaternion(quaternion, lookScratchMatrix);
    Matrix3.multiplyByVector(rotation, this.direction, this.direction);
    Matrix3.multiplyByVector(rotation, this.up, this.up);
    Matrix3.multiplyByVector(rotation, this.right, this.right);
  }

  twistLeft(amount) {
    amount = amount ?? this.defaultLookAmount;
    this.look(this.direction, amount);
  }

  twistRight(amount) {
    amount = amount ?? this.defaultLookAmount;
    this.look(this.direction, -amount);
  }

  rotate(axis, angle) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(axis)) {
      throw new DeveloperError("axis is required.");
    }
    //>>includeEnd('debug');
    const turnAngle = angle ?? this.defaultRotateAmount;
    const quaternion = Quaternion.fromAxisAngle(
      axis,
      -turnAngle,
      rotateScratchQuaternion,
    );
    const rotation = Matrix3.fromQuaternion(quaternion, rotateScratchMatrix);
    Matrix3.multiplyByVector(rotation, this.position, this.position);
    Matrix3.multiplyByVector(rotation, this.direction, this.direction);
    Matrix3.multiplyByVector(rotation, this.up, this.up);
    Cartesian3.cross(this.direction, this.up, this.right);
    Cartesian3.cross(this.right, this.direction, this.up);
    this._adjustOrthographicFrustum(false);
  }

  rotateDown(angle) {
    angle = angle ?? this.defaultRotateAmount;
    rotateVertical(this, angle);
  }

  rotateUp(angle) {
    angle = angle ?? this.defaultRotateAmount;
    rotateVertical(this, -angle);
  }

  rotateRight(angle) {
    angle = angle ?? this.defaultRotateAmount;
    rotateHorizontal(this, -angle);
  }

  rotateLeft(angle) {
    angle = angle ?? this.defaultRotateAmount;
    rotateHorizontal(this, angle);
  }

  zoomIn(amount) {
    amount = amount ?? this.defaultZoomAmount;
    if (this._mode === SceneMode.SCENE2D) {
      zoom2D(this, amount);
    } else {
      zoom3D(this, amount);
    }
  }

  zoomOut(amount) {
    amount = amount ?? this.defaultZoomAmount;
    if (this._mode === SceneMode.SCENE2D) {
      zoom2D(this, -amount);
    } else {
      zoom3D(this, -amount);
    }
  }

  getMagnitude() {
    if (this._mode === SceneMode.SCENE3D) {
      return Cartesian3.magnitude(this.position);
    } else if (this._mode === SceneMode.COLUMBUS_VIEW) {
      return Math.abs(this.position.z);
    } else if (this._mode === SceneMode.SCENE2D) {
      return Math.max(
        this.frustum.right - this.frustum.left,
        this.frustum.top - this.frustum.bottom,
      );
    }
  }

  lookAt(target, offset) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(target)) {
      throw new DeveloperError("target is required");
    }
    if (!defined(offset)) {
      throw new DeveloperError("offset is required");
    }
    if (this._mode === SceneMode.MORPHING) {
      throw new DeveloperError("lookAt is not supported while morphing.");
    }
    //>>includeEnd('debug');
    const scene = this._scene;
    const ellipsoid = scene.ellipsoid ?? Ellipsoid.default;
    const transform = Transforms.eastNorthUpToFixedFrame(
      target,
      ellipsoid,
      scratchLookAtMatrix4,
    );
    this.lookAtTransform(transform, offset);
  }

  lookAtTransform(transform, offset) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(transform)) {
      throw new DeveloperError("transform is required");
    }
    if (this._mode === SceneMode.MORPHING) {
      throw new DeveloperError(
        "lookAtTransform is not supported while morphing.",
      );
    }
    //>>includeEnd('debug');

    this._setTransform(transform);
    if (!defined(offset)) {
      return;
    }

    let cartesianOffset;
    if (defined(offset.heading)) {
      cartesianOffset = offsetFromHeadingPitchRange(
        offset.heading,
        offset.pitch,
        offset.range,
      );
    } else {
      cartesianOffset = offset;
    }

    if (this._mode === SceneMode.SCENE2D) {
      Cartesian2.clone(Cartesian2.ZERO, this.position);
      Cartesian3.negate(cartesianOffset, this.up);
      this.up.z = 0.0;

      if (Cartesian3.magnitudeSquared(this.up) < CesiumMath.EPSILON10) {
        Cartesian3.clone(Cartesian3.UNIT_Y, this.up);
      }
      Cartesian3.normalize(this.up, this.up);

      this._setTransform(Matrix4.IDENTITY);
      Cartesian3.negate(Cartesian3.UNIT_Z, this.direction);
      Cartesian3.cross(this.direction, this.up, this.right);
      Cartesian3.normalize(this.right, this.right);

      const frustum = this.frustum;
      const ratio = frustum.top / frustum.right;
      frustum.right = Cartesian3.magnitude(cartesianOffset) * 0.5;
      frustum.left = -frustum.right;
      frustum.top = ratio * frustum.right;
      frustum.bottom = -frustum.top;

      this._setTransform(transform);
      return;
    }

    Cartesian3.clone(cartesianOffset, this.position);
    Cartesian3.negate(this.position, this.direction);
    Cartesian3.normalize(this.direction, this.direction);
    Cartesian3.cross(this.direction, Cartesian3.UNIT_Z, this.right);

    if (Cartesian3.magnitudeSquared(this.right) < CesiumMath.EPSILON10) {
      Cartesian3.clone(Cartesian3.UNIT_X, this.right);
    }
    Cartesian3.normalize(this.right, this.right);
    Cartesian3.cross(this.right, this.direction, this.up);
    Cartesian3.normalize(this.up, this.up);

    this._adjustOrthographicFrustum(true);
  }

  getRectangleCameraCoordinates(rectangle, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(rectangle)) {
      throw new DeveloperError("rectangle is required");
    }
    //>>includeEnd('debug');
    const mode = this._mode;
    if (!defined(result)) {
      result = new Cartesian3();
    }
    if (mode === SceneMode.SCENE3D) {
      return rectangleCameraPosition3D(this, rectangle, result);
    } else if (mode === SceneMode.COLUMBUS_VIEW) {
      return rectangleCameraPositionColumbusView(this, rectangle, result);
    } else if (mode === SceneMode.SCENE2D) {
      return rectangleCameraPosition2D(this, rectangle, result);
    }
    return undefined;
  }

  pickEllipsoid(windowPosition, ellipsoid, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(windowPosition)) {
      throw new DeveloperError("windowPosition is required.");
    }
    //>>includeEnd('debug');
    const canvas = this._scene.canvas;
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return undefined;
    }
    if (!defined(result)) {
      result = new Cartesian3();
    }
    ellipsoid = ellipsoid ?? Ellipsoid.default;

    if (this._mode === SceneMode.SCENE3D) {
      result = pickEllipsoid3D(this, windowPosition, ellipsoid, result);
    } else if (this._mode === SceneMode.SCENE2D) {
      result = pickMap2D(this, windowPosition, this._projection, result);
    } else if (this._mode === SceneMode.COLUMBUS_VIEW) {
      result = pickMapColumbusView(
        this,
        windowPosition,
        this._projection,
        result,
      );
    } else {
      return undefined;
    }
    return result;
  }

  getPickRay(windowPosition, result) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(windowPosition)) {
      throw new DeveloperError("windowPosition is required.");
    }
    //>>includeEnd('debug');
    if (!defined(result)) {
      result = new Ray();
    }
    const canvas = this._scene.canvas;
    if (canvas.clientWidth <= 0 || canvas.clientHeight <= 0) {
      return undefined;
    }
    const frustum = this.frustum;
    if (
      defined(frustum.aspectRatio) &&
      defined(frustum.fov) &&
      defined(frustum.near)
    ) {
      return getPickRayPerspective(this, windowPosition, result);
    }
    return getPickRayOrthographic(this, windowPosition, result);
  }

  distanceToBoundingSphere(boundingSphere) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(boundingSphere)) {
      throw new DeveloperError("boundingSphere is required.");
    }
    //>>includeEnd('debug');
    const toCenter = Cartesian3.subtract(
      this.positionWC,
      boundingSphere.center,
      scratchToCenter,
    );
    const proj = Cartesian3.multiplyByScalar(
      this.directionWC,
      Cartesian3.dot(toCenter, this.directionWC),
      scratchProj,
    );
    return Math.max(0.0, Cartesian3.magnitude(proj) - boundingSphere.radius);
  }

  getPixelSize(boundingSphere, drawingBufferWidth, drawingBufferHeight) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(boundingSphere)) {
      throw new DeveloperError("boundingSphere is required.");
    }
    if (!defined(drawingBufferWidth)) {
      throw new DeveloperError("drawingBufferWidth is required.");
    }
    if (!defined(drawingBufferHeight)) {
      throw new DeveloperError("drawingBufferHeight is required.");
    }
    //>>includeEnd('debug');
    const distance = this.distanceToBoundingSphere(boundingSphere);
    const pixelSize = this.frustum.getPixelDimensions(
      drawingBufferWidth,
      drawingBufferHeight,
      distance,
      this._scene.pixelRatio,
      scratchPixelSize,
    );
    return Math.max(pixelSize.x, pixelSize.y);
  }

  /** @private */
  createCorrectPositionTween(duration) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(duration)) {
      throw new DeveloperError("duration is required.");
    }
    //>>includeEnd('debug');
    if (this._mode === SceneMode.COLUMBUS_VIEW) {
      return createAnimationCV(this, duration);
    }
    return undefined;
  }

  cancelFlight() {
    if (defined(this._currentFlight)) {
      this._currentFlight.cancelTween();
      this._currentFlight = undefined;
    }
  }

  completeFlight() {
    if (defined(this._currentFlight)) {
      this._currentFlight.cancelTween();
      const options = {
        destination: undefined,
        orientation: {
          heading: undefined,
          pitch: undefined,
          roll: undefined,
        },
      };
      options.destination = newOptions.destination;
      options.orientation.heading = newOptions.heading;
      options.orientation.pitch = newOptions.pitch;
      options.orientation.roll = newOptions.roll;
      this.setView(options);
      if (defined(this._currentFlight.complete)) {
        this._currentFlight.complete();
      }
      this._currentFlight = undefined;
    }
  }

  flyTo(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    let destination = options.destination;
    //>>includeStart('debug', pragmas.debug);
    if (!defined(destination)) {
      throw new DeveloperError("destination is required.");
    }
    //>>includeEnd('debug');

    const mode = this._mode;
    if (mode === SceneMode.MORPHING) {
      return;
    }
    this.cancelFlight();

    const isRectangle = destination instanceof Rectangle;
    if (isRectangle) {
      destination = this.getRectangleCameraCoordinates(
        destination,
        scratchFlyToDestination,
      );
    }

    let orientation = options.orientation ?? Frozen.EMPTY_OBJECT;
    if (defined(orientation.direction)) {
      orientation = directionUpToHeadingPitchRoll(
        this,
        destination,
        orientation,
        scratchSetViewOptions.orientation,
      );
    }

    if (defined(options.duration) && options.duration <= 0.0) {
      const setViewOptions = scratchSetViewOptions;
      setViewOptions.destination = options.destination;
      setViewOptions.orientation.heading = orientation.heading;
      setViewOptions.orientation.pitch = orientation.pitch;
      setViewOptions.orientation.roll = orientation.roll;
      setViewOptions.convert = options.convert;
      setViewOptions.endTransform = options.endTransform;
      this.setView(setViewOptions);
      if (typeof options.complete === "function") {
        options.complete();
      }
      return;
    }

    const that = this;
    /* eslint-disable-next-line prefer-const */
    let flightTween;

    newOptions.destination = destination;
    newOptions.heading = orientation.heading;
    newOptions.pitch = orientation.pitch;
    newOptions.roll = orientation.roll;
    newOptions.duration = options.duration;
    newOptions.complete = function () {
      if (flightTween === that._currentFlight) {
        that._currentFlight = undefined;
      }
      if (defined(options.complete)) {
        options.complete();
      }
    };
    newOptions.cancel = options.cancel;
    newOptions.endTransform = options.endTransform;
    newOptions.convert = isRectangle ? false : options.convert;
    newOptions.maximumHeight = options.maximumHeight;
    newOptions.pitchAdjustHeight = options.pitchAdjustHeight;
    newOptions.flyOverLongitude = options.flyOverLongitude;
    newOptions.flyOverLongitudeWeight = options.flyOverLongitudeWeight;
    newOptions.easingFunction = options.easingFunction;

    const scene = this._scene;
    const tweenOptions = CameraFlightPath.createTween(scene, newOptions);
    if (tweenOptions.duration === 0) {
      if (typeof tweenOptions.complete === "function") {
        tweenOptions.complete();
      }
      return;
    }
    flightTween = scene.tweens.add(tweenOptions);
    this._currentFlight = flightTween;

    let preloadFlightCamera = this._scene.preloadFlightCamera;
    if (this._mode !== SceneMode.SCENE2D) {
      if (!defined(preloadFlightCamera)) {
        preloadFlightCamera = Camera.clone(this);
      }
      preloadFlightCamera.setView({
        destination: destination,
        orientation: orientation,
      });
      this._scene.preloadFlightCullingVolume =
        preloadFlightCamera.frustum.computeCullingVolume(
          preloadFlightCamera.positionWC,
          preloadFlightCamera.directionWC,
          preloadFlightCamera.upWC,
        );
    }
  }

  viewBoundingSphere(boundingSphere, offset) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(boundingSphere)) {
      throw new DeveloperError("boundingSphere is required.");
    }
    if (this._mode === SceneMode.MORPHING) {
      throw new DeveloperError(
        "viewBoundingSphere is not supported while morphing.",
      );
    }
    //>>includeEnd('debug');
    offset = adjustBoundingSphereOffset(this, boundingSphere, offset);
    this.lookAt(boundingSphere.center, offset);
  }

  flyToBoundingSphere(boundingSphere, options) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(boundingSphere)) {
      throw new DeveloperError("boundingSphere is required.");
    }
    //>>includeEnd('debug');
    options = options ?? Frozen.EMPTY_OBJECT;
    const scene2D =
      this._mode === SceneMode.SCENE2D ||
      this._mode === SceneMode.COLUMBUS_VIEW;
    this._setTransform(Matrix4.IDENTITY);
    const offset = adjustBoundingSphereOffset(
      this,
      boundingSphere,
      options.offset,
    );

    let position;
    if (scene2D) {
      position = Cartesian3.multiplyByScalar(
        Cartesian3.UNIT_Z,
        offset.range,
        scratchflyToBoundingSphereDestination,
      );
    } else {
      position = offsetFromHeadingPitchRange(
        offset.heading,
        offset.pitch,
        offset.range,
      );
    }

    const scene = this._scene;
    const ellipsoid = scene.ellipsoid ?? Ellipsoid.default;
    const transform = Transforms.eastNorthUpToFixedFrame(
      boundingSphere.center,
      ellipsoid,
      scratchflyToBoundingSphereTransform,
    );
    Matrix4.multiplyByPoint(transform, position, position);

    let direction;
    let up;

    if (!scene2D) {
      direction = Cartesian3.subtract(
        boundingSphere.center,
        position,
        scratchflyToBoundingSphereDirection,
      );
      Cartesian3.normalize(direction, direction);

      up = Matrix4.multiplyByPointAsVector(
        transform,
        Cartesian3.UNIT_Z,
        scratchflyToBoundingSphereUp,
      );
      if (1.0 - Math.abs(Cartesian3.dot(direction, up)) < CesiumMath.EPSILON6) {
        const rotateQuat = Quaternion.fromAxisAngle(
          direction,
          offset.heading,
          scratchFlyToBoundingSphereQuaternion,
        );
        const rotation = Matrix3.fromQuaternion(
          rotateQuat,
          scratchFlyToBoundingSphereMatrix3,
        );
        Cartesian3.fromCartesian4(
          Matrix4.getColumn(transform, 1, scratchFlyToBoundingSphereCart4),
          up,
        );
        Matrix3.multiplyByVector(rotation, up, up);
      }

      const right = Cartesian3.cross(
        direction,
        up,
        scratchflyToBoundingSphereRight,
      );
      Cartesian3.cross(right, direction, up);
      Cartesian3.normalize(up, up);
    }

    this.flyTo({
      destination: position,
      orientation: { direction: direction, up: up },
      duration: options.duration,
      complete: options.complete,
      cancel: options.cancel,
      endTransform: options.endTransform,
      maximumHeight: options.maximumHeight,
      easingFunction: options.easingFunction,
      flyOverLongitude: options.flyOverLongitude,
      flyOverLongitudeWeight: options.flyOverLongitudeWeight,
      pitchAdjustHeight: options.pitchAdjustHeight,
    });
  }

  computeViewRectangle(ellipsoid, result) {
    ellipsoid = ellipsoid ?? Ellipsoid.default;
    const cullingVolume = this.frustum.computeCullingVolume(
      this.positionWC,
      this.directionWC,
      this.upWC,
    );
    const boundingSphere = new BoundingSphere(
      Cartesian3.ZERO,
      ellipsoid.maximumRadius,
    );
    const visibility = cullingVolume.computeVisibility(boundingSphere);
    if (visibility === Intersect.OUTSIDE) {
      return undefined;
    }

    const canvas = this._scene.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    let successfulPickCount = 0;
    const computedHorizonQuad = computeHorizonQuad(this, ellipsoid);

    successfulPickCount += addToResult(
      0,
      0,
      0,
      this,
      ellipsoid,
      computedHorizonQuad,
    );
    successfulPickCount += addToResult(
      0,
      height,
      1,
      this,
      ellipsoid,
      computedHorizonQuad,
    );
    successfulPickCount += addToResult(
      width,
      height,
      2,
      this,
      ellipsoid,
      computedHorizonQuad,
    );
    successfulPickCount += addToResult(
      width,
      0,
      3,
      this,
      ellipsoid,
      computedHorizonQuad,
    );

    if (successfulPickCount < 2) {
      return Rectangle.MAX_VALUE;
    }

    result = Rectangle.fromCartographicArray(cartoArray, result);

    let distance = 0;
    let lastLon = cartoArray[3].longitude;
    for (let i = 0; i < 4; ++i) {
      const lon = cartoArray[i].longitude;
      const diff = Math.abs(lon - lastLon);
      if (diff > CesiumMath.PI) {
        distance += CesiumMath.TWO_PI - diff;
      } else {
        distance += diff;
      }
      lastLon = lon;
    }

    if (
      CesiumMath.equalsEpsilon(
        Math.abs(distance),
        CesiumMath.TWO_PI,
        CesiumMath.EPSILON9,
      )
    ) {
      result.west = -CesiumMath.PI;
      result.east = CesiumMath.PI;
      if (cartoArray[0].latitude >= 0.0) {
        result.north = CesiumMath.PI_OVER_TWO;
      } else {
        result.south = -CesiumMath.PI_OVER_TWO;
      }
    }

    return result;
  }

  switchToPerspectiveFrustum() {
    if (
      this._mode === SceneMode.SCENE2D ||
      this.frustum instanceof PerspectiveFrustum
    ) {
      return;
    }
    const scene = this._scene;
    this.frustum = new PerspectiveFrustum();
    this.frustum.aspectRatio =
      scene.drawingBufferWidth / scene.drawingBufferHeight;
    this.frustum.fov = CesiumMath.toRadians(60.0);
  }

  switchToOrthographicFrustum() {
    if (
      this._mode === SceneMode.SCENE2D ||
      this.frustum instanceof OrthographicFrustum
    ) {
      return;
    }
    const frustumWidth = calculateOrthographicFrustumWidth(this);
    const scene = this._scene;
    this.frustum = new OrthographicFrustum();
    this.frustum.aspectRatio =
      scene.drawingBufferWidth / scene.drawingBufferHeight;
    this.frustum.width = frustumWidth;
  }

  /** @private */
  static clone(camera, result) {
    if (!defined(result)) {
      result = new Camera(camera._scene);
    }
    Cartesian3.clone(camera.position, result.position);
    Cartesian3.clone(camera.direction, result.direction);
    Cartesian3.clone(camera.up, result.up);
    Cartesian3.clone(camera.right, result.right);
    Matrix4.clone(camera._transform, result.transform);
    result._transformChanged = true;
    result.frustum = camera.frustum.clone();
    return result;
  }
}

/** @private */
Camera.TRANSFORM_2D = new Matrix4(
  0.0,
  0.0,
  1.0,
  0.0,
  1.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
  0.0,
  0.0,
  0.0,
  0.0,
  0.0,
  1.0,
);

/** @private */
Camera.TRANSFORM_2D_INVERSE = Matrix4.inverseTransformation(
  Camera.TRANSFORM_2D,
  new Matrix4(),
);

/** @type Rectangle */
Camera.DEFAULT_VIEW_RECTANGLE = Rectangle.fromDegrees(
  -95.0,
  -20.0,
  -70.0,
  90.0,
);

/** @type {number} */
Camera.DEFAULT_VIEW_FACTOR = 0.5;

/** @type HeadingPitchRange */
Camera.DEFAULT_OFFSET = new HeadingPitchRange(
  0.0,
  -CesiumMath.PI_OVER_FOUR,
  0.0,
);

/**
 * A function that will execute when a flight completes.
 * @callback Camera.FlightCompleteCallback
 */

/**
 * A function that will execute when a flight is cancelled.
 * @callback Camera.FlightCancelledCallback
 */
export default Camera;
