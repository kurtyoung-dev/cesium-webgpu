import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import VerticalExaggeration from "../Core/VerticalExaggeration.js";
import CameraEventAggregator from "./CameraEventAggregator.js";
import CameraEventType from "./CameraEventType.js";
import KeyboardEventModifier from "../Core/KeyboardEventModifier.js";
import SceneMode from "./SceneMode.js";
import TweenCollection from "./TweenCollection.js";
import { update2D, updateCV, update3D } from "./SSCCModeHandlers.js";

function decay(time, coefficient) {
  if (time < 0) {
    return 0.0;
  }
  const tau = (1.0 - coefficient) * 25.0;
  return Math.exp(-tau * time);
}

function sameMousePosition(movement) {
  return Cartesian2.equalsEpsilon(
    movement.startPosition,
    movement.endPosition,
    CesiumMath.EPSILON14,
  );
}

const inertiaMaxClickTimeThreshold = 0.4;

function maintainInertia(
  aggregator,
  type,
  modifier,
  decayCoef,
  action,
  object,
  lastMovementName,
) {
  let movementState = object[lastMovementName];
  if (!defined(movementState)) {
    movementState = object[lastMovementName] = {
      startPosition: new Cartesian2(),
      endPosition: new Cartesian2(),
      motion: new Cartesian2(),
      inertiaEnabled: true,
    };
  }

  const ts = aggregator.getButtonPressTime(type, modifier);
  const tr = aggregator.getButtonReleaseTime(type, modifier);

  const threshold = ts && tr && (tr.getTime() - ts.getTime()) / 1000.0;
  const now = new Date();
  const fromNow = tr && (now.getTime() - tr.getTime()) / 1000.0;

  if (ts && tr && threshold < inertiaMaxClickTimeThreshold) {
    const d = decay(fromNow, decayCoef);

    const lastMovement = aggregator.getLastMovement(type, modifier);
    if (
      !defined(lastMovement) ||
      sameMousePosition(lastMovement) ||
      !movementState.inertiaEnabled
    ) {
      return;
    }

    movementState.motion.x =
      (lastMovement.endPosition.x - lastMovement.startPosition.x) * 0.5;
    movementState.motion.y =
      (lastMovement.endPosition.y - lastMovement.startPosition.y) * 0.5;

    movementState.startPosition = Cartesian2.clone(
      lastMovement.startPosition,
      movementState.startPosition,
    );

    movementState.endPosition = Cartesian2.multiplyByScalar(
      movementState.motion,
      d,
      movementState.endPosition,
    );
    movementState.endPosition = Cartesian2.add(
      movementState.startPosition,
      movementState.endPosition,
      movementState.endPosition,
    );

    if (
      isNaN(movementState.endPosition.x) ||
      isNaN(movementState.endPosition.y) ||
      Cartesian2.distance(
        movementState.startPosition,
        movementState.endPosition,
      ) < 0.5
    ) {
      return;
    }

    if (!aggregator.isButtonDown(type, modifier)) {
      const startPosition = aggregator.getStartMousePosition(type, modifier);
      action(object, startPosition, movementState);
    }
  }
}

function activateInertia(controller, inertiaStateName) {
  if (defined(inertiaStateName)) {
    let movementState = controller[inertiaStateName];
    if (defined(movementState)) {
      movementState.inertiaEnabled = true;
    }
    const inertiasToDisable = controller._inertiaDisablers[inertiaStateName];
    if (defined(inertiasToDisable)) {
      const length = inertiasToDisable.length;
      for (let i = 0; i < length; ++i) {
        movementState = controller[inertiasToDisable[i]];
        if (defined(movementState)) {
          movementState.inertiaEnabled = false;
        }
      }
    }
  }
}

const scratchEventTypeArray = [];

const scratchAdjustHeightTransform = new Matrix4();
const scratchAdjustHeightCartographic = new Cartographic();
const scratchPreviousPosition = new Cartesian3();
const scratchPreviousDirection = new Cartesian3();

/**
 * Modifies the camera position and orientation based on mouse input to a canvas.
 * @alias ScreenSpaceCameraController
 *
 * @param {Scene} scene The scene.
 */
class ScreenSpaceCameraController {
  constructor(scene) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene)) {
      throw new DeveloperError("scene is required.");
    }
    //>>includeEnd('debug');

    /**
     * @type {boolean}
     * @default true
     */
    this.enableInputs = true;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableTranslate = true;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableZoom = true;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableRotate = true;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableTilt = true;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableLook = true;
    /**
     * @type {number}
     * @default 0.9
     */
    this.inertiaSpin = 0.9;
    /**
     * @type {number}
     * @default 0.9
     */
    this.inertiaTranslate = 0.9;
    /**
     * @type {number}
     * @default 0.8
     */
    this.inertiaZoom = 0.8;
    /**
     * @type {number}
     * @default 0.1
     */
    this.maximumMovementRatio = 0.1;
    /**
     * @type {number}
     * @default 3.0
     */
    this.bounceAnimationTime = 3.0;
    /**
     * @type {number}
     * @default 1.0
     */
    this.minimumZoomDistance = 1.0;
    /**
     * @type {number}
     * @default Number.POSITIVE_INFINITY
     */
    this.maximumZoomDistance = Number.POSITIVE_INFINITY;
    /**
     * @type {number}
     * @default 5.0
     */
    this.zoomFactor = 5.0;

    this.translateEventTypes = CameraEventType.LEFT_DRAG;
    this.zoomEventTypes = [
      CameraEventType.RIGHT_DRAG,
      CameraEventType.WHEEL,
      CameraEventType.PINCH,
    ];
    this.rotateEventTypes = CameraEventType.LEFT_DRAG;
    this.tiltEventTypes = [
      CameraEventType.MIDDLE_DRAG,
      CameraEventType.PINCH,
      {
        eventType: CameraEventType.LEFT_DRAG,
        modifier: KeyboardEventModifier.CTRL,
      },
      {
        eventType: CameraEventType.RIGHT_DRAG,
        modifier: KeyboardEventModifier.CTRL,
      },
    ];
    this.lookEventTypes = {
      eventType: CameraEventType.LEFT_DRAG,
      modifier: KeyboardEventModifier.SHIFT,
    };

    const ellipsoid = scene.ellipsoid ?? Ellipsoid.default;

    this.minimumPickingTerrainHeight = Ellipsoid.WGS84.equals(ellipsoid)
      ? 150000.0
      : ellipsoid.minimumRadius * 0.025;
    this._minimumPickingTerrainHeight = this.minimumPickingTerrainHeight;
    this.minimumPickingTerrainDistanceWithInertia = Ellipsoid.WGS84.equals(
      ellipsoid,
    )
      ? 4000.0
      : ellipsoid.minimumRadius * 0.00063;
    this.minimumCollisionTerrainHeight = Ellipsoid.WGS84.equals(ellipsoid)
      ? 15000.0
      : ellipsoid.minimumRadius * 0.0025;
    this._minimumCollisionTerrainHeight = this.minimumCollisionTerrainHeight;
    this.minimumTrackBallHeight = Ellipsoid.WGS84.equals(ellipsoid)
      ? 7500000.0
      : ellipsoid.minimumRadius * 1.175;
    this._minimumTrackBallHeight = this.minimumTrackBallHeight;
    /**
     * @type {boolean}
     * @default true
     */
    this.enableCollisionDetection = true;
    /**
     * The angle, relative to the ellipsoid normal, restricting the maximum amount that the user can tilt the camera. If <code>undefined</code>, the angle of the camera tilt is unrestricted.
     * @type {number|undefined}
     * @default undefined
     *
     * @example
     * // Prevent the camera from tilting below the ellipsoid surface
     * viewer.scene.screenSpaceCameraController.maximumTiltAngle = Math.PI / 2.0;
     */
    this.maximumTiltAngle = undefined;

    this._scene = scene;
    this._globe = undefined;
    this._ellipsoid = ellipsoid;
    this._lastGlobeHeight = 0.0;
    this._aggregator = new CameraEventAggregator(scene.canvas);

    this._lastInertiaSpinMovement = undefined;
    this._lastInertiaZoomMovement = undefined;
    this._lastInertiaTranslateMovement = undefined;
    this._lastInertiaTiltMovement = undefined;

    this._inertiaDisablers = {
      _lastInertiaZoomMovement: [
        "_lastInertiaSpinMovement",
        "_lastInertiaTranslateMovement",
        "_lastInertiaTiltMovement",
      ],
      _lastInertiaTiltMovement: [
        "_lastInertiaSpinMovement",
        "_lastInertiaTranslateMovement",
      ],
    };

    this._tweens = new TweenCollection();
    this._tween = undefined;
    this._horizontalRotationAxis = undefined;

    this._tiltCenterMousePosition = new Cartesian2(-1.0, -1.0);
    this._tiltCenter = new Cartesian3();
    this._rotateMousePosition = new Cartesian2(-1.0, -1.0);
    this._rotateStartPosition = new Cartesian3();
    this._strafeStartPosition = new Cartesian3();
    this._strafeMousePosition = new Cartesian2();
    this._strafeEndMousePosition = new Cartesian2();
    this._zoomMouseStart = new Cartesian2(-1.0, -1.0);
    this._zoomWorldPosition = new Cartesian3();
    this._useZoomWorldPosition = false;
    this._panLastMousePosition = new Cartesian2();
    this._panLastWorldPosition = new Cartesian3();
    this._tiltCVOffMap = false;
    this._looking = false;
    this._rotating = false;
    this._strafing = false;
    this._zoomingOnVector = false;
    this._zoomingUnderground = false;
    this._rotatingZoom = false;
    this._adjustedHeightForTerrain = false;
    this._cameraUnderground = false;

    const projection = scene.mapProjection;
    this._maxCoord = projection.project(
      new Cartographic(Math.PI, CesiumMath.PI_OVER_TWO),
    );

    this._rotateFactor = undefined;
    this._rotateRateRangeAdjustment = undefined;
    this._maximumRotateRate = 1.77;
    this._minimumRotateRate = 1.0 / 5000.0;
    this._minimumZoomRate = 20.0;
    this._maximumZoomRate = 5906376272000.0;
    this._minimumUndergroundPickDistance = 2000.0;
    this._maximumUndergroundPickDistance = 10000.0;
  }

  /**
   * Processes input events and dispatches to mode-specific handlers.
   * Called by SSCCModeHandlers to route input through inertia.
   * @private
   */
  _reactToInput(
    enabled,
    eventTypes,
    action,
    inertiaConstant,
    inertiaStateName,
  ) {
    if (!defined(eventTypes)) {
      return;
    }

    const aggregator = this._aggregator;

    if (!Array.isArray(eventTypes)) {
      scratchEventTypeArray[0] = eventTypes;
      eventTypes = scratchEventTypeArray;
    }

    const length = eventTypes.length;
    for (let i = 0; i < length; ++i) {
      const eventType = eventTypes[i];
      const type = defined(eventType.eventType)
        ? eventType.eventType
        : eventType;
      const modifier = eventType.modifier;

      const movement =
        aggregator.isMoving(type, modifier) &&
        aggregator.getMovement(type, modifier);
      const startPosition = aggregator.getStartMousePosition(type, modifier);

      if (this.enableInputs && enabled) {
        if (movement) {
          action(this, startPosition, movement);
          activateInertia(this, inertiaStateName);
        } else if (inertiaConstant < 1.0) {
          maintainInertia(
            aggregator,
            type,
            modifier,
            inertiaConstant,
            action,
            this,
            inertiaStateName,
          );
        }
      }
    }
  }

  /**
   * Adjusts camera height to stay above terrain.
   * @private
   */
  _adjustHeightForTerrain(cameraChanged) {
    this._adjustedHeightForTerrain = true;

    const scene = this._scene;
    const mode = scene.mode;

    if (mode === SceneMode.SCENE2D || mode === SceneMode.MORPHING) {
      return;
    }

    const camera = scene.camera;
    const ellipsoid = scene.ellipsoid ?? Ellipsoid.WGS84;
    const projection = scene.mapProjection;

    let transform;
    let mag;
    if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) {
      transform = Matrix4.clone(camera.transform, scratchAdjustHeightTransform);
      mag = Cartesian3.magnitude(camera.position);
      camera._setTransform(Matrix4.IDENTITY);
    }

    const cartographic = scratchAdjustHeightCartographic;
    if (mode === SceneMode.SCENE3D) {
      ellipsoid.cartesianToCartographic(camera.position, cartographic);
    } else {
      projection.unproject(camera.position, cartographic);
    }

    let heightUpdated = false;
    if (cartographic.height < this._minimumCollisionTerrainHeight) {
      const globeHeight = this._scene.globeHeight;
      if (defined(globeHeight)) {
        const height = globeHeight + this.minimumZoomDistance;
        const difference = globeHeight - this._lastGlobeHeight;
        const percentDifference = difference / this._lastGlobeHeight;

        if (
          cartographic.height < height &&
          (cameraChanged || Math.abs(percentDifference) <= 0.1)
        ) {
          cartographic.height = height;
          if (mode === SceneMode.SCENE3D) {
            ellipsoid.cartographicToCartesian(cartographic, camera.position);
          } else {
            projection.project(cartographic, camera.position);
          }
          heightUpdated = true;
        }

        if (cameraChanged || Math.abs(percentDifference) <= 0.1) {
          this._lastGlobeHeight = globeHeight;
        } else {
          this._lastGlobeHeight += difference * 0.1;
        }
      }
    }

    if (defined(transform)) {
      camera._setTransform(transform);
      if (heightUpdated) {
        Cartesian3.normalize(camera.position, camera.position);
        Cartesian3.negate(camera.position, camera.direction);
        Cartesian3.multiplyByScalar(
          camera.position,
          Math.max(mag, this.minimumZoomDistance),
          camera.position,
        );
        Cartesian3.normalize(camera.direction, camera.direction);
        Cartesian3.cross(camera.direction, camera.up, camera.right);
        Cartesian3.cross(camera.right, camera.direction, camera.up);
      }
    }
  }

  /** @private */
  onMap() {
    const scene = this._scene;
    const mode = scene.mode;
    const camera = scene.camera;

    if (mode === SceneMode.COLUMBUS_VIEW) {
      return (
        Math.abs(camera.position.x) - this._maxCoord.x < 0 &&
        Math.abs(camera.position.y) - this._maxCoord.y < 0
      );
    }

    return true;
  }

  /** @private */
  update() {
    const scene = this._scene;
    const { camera, globe, mode } = scene;

    if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) {
      this._globe = undefined;
      this._ellipsoid = Ellipsoid.UNIT_SPHERE;
    } else {
      this._globe = globe;
      this._ellipsoid = scene.ellipsoid ?? Ellipsoid.default;
    }

    const { verticalExaggeration, verticalExaggerationRelativeHeight } = scene;
    this._minimumCollisionTerrainHeight = VerticalExaggeration.getHeight(
      this.minimumCollisionTerrainHeight,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
    this._minimumPickingTerrainHeight = VerticalExaggeration.getHeight(
      this.minimumPickingTerrainHeight,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );
    this._minimumTrackBallHeight = VerticalExaggeration.getHeight(
      this.minimumTrackBallHeight,
      verticalExaggeration,
      verticalExaggerationRelativeHeight,
    );

    this._cameraUnderground = scene.cameraUnderground && defined(this._globe);

    const radius = this._ellipsoid.maximumRadius;
    this._rotateFactor = 1.0 / radius;
    this._rotateRateRangeAdjustment = radius;

    this._adjustedHeightForTerrain = false;
    const previousPosition = Cartesian3.clone(
      camera.positionWC,
      scratchPreviousPosition,
    );
    const previousDirection = Cartesian3.clone(
      camera.directionWC,
      scratchPreviousDirection,
    );

    if (mode === SceneMode.SCENE2D) {
      update2D(this);
    } else if (mode === SceneMode.COLUMBUS_VIEW) {
      this._horizontalRotationAxis = Cartesian3.UNIT_Z;
      updateCV(this);
    } else if (mode === SceneMode.SCENE3D) {
      this._horizontalRotationAxis = undefined;
      update3D(this);
    }

    if (this.enableCollisionDetection && !this._adjustedHeightForTerrain) {
      const cameraChanged =
        !Cartesian3.equals(previousPosition, camera.positionWC) ||
        !Cartesian3.equals(previousDirection, camera.directionWC);
      this._adjustHeightForTerrain(cameraChanged);
    }

    this._aggregator.reset();
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see ScreenSpaceCameraController#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Removes mouse listeners held by this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * controller = controller && controller.destroy();
   *
   * @see ScreenSpaceCameraController#isDestroyed
   */
  destroy() {
    this._tweens.removeAll();
    this._aggregator = this._aggregator && this._aggregator.destroy();
    return destroyObject(this);
  }
}

export default ScreenSpaceCameraController;
