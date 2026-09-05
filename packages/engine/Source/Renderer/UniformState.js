import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import ClipSpaceConvention from "../Core/ClipSpaceConvention.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import Transforms from "../Core/Transforms.js";
import SceneMode from "../Scene/SceneMode.js";
import SunLight from "../Scene/SunLight.js";
import MoonLight from "../Scene/MoonLight.js";
import { LIGHT_PACK_FLOATS } from "../Scene/LightTypes.js";
import { getLunarEclipseMoonlightFactor } from "../Scene/EclipseState.js";
import {
  isViewTemporalHistoryValid,
  readViewTemporalHistory,
} from "../Scene/ViewTemporalHistory.js";
import {
  setView,
  setInverseView,
  setProjection,
  setInfiniteProjection,
  setCamera,
  setSunAndMoonDirections,
  cleanViewport,
  cleanInverseProjection,
  cleanModelView,
  cleanModelView3D,
  cleanInverseModelView,
  cleanInverseModelView3D,
  cleanViewProjection,
  cleanViewProjectionRelativeToEye,
  cleanInverseViewProjection,
  cleanModelViewProjection,
  cleanModelViewRelativeToEye,
  cleanInverseModelViewProjection,
  cleanModelViewProjectionRelativeToEye,
  cleanModelViewInfiniteProjection,
  cleanNormal,
  cleanNormal3D,
  cleanInverseNormal,
  cleanInverseNormal3D,
  cleanEncodedCameraPositionMC,
  updateView3D,
  updateInverseView3D,
} from "./UniformStateComputations.js";

const EMPTY_ARRAY = [];
const defaultLight = new SunLight();

/**
 * @private
 * @alias UniformState
 */
class UniformState {
  constructor(clipSpaceConvention) {
    this._clipSpaceConvention =
      ClipSpaceConvention.normalize(clipSpaceConvention);
    /** @type {Texture} */
    this.globeDepthTexture = undefined;
    /** @type {Texture} */
    this.edgeIdTexture = undefined;
    /** @type {Texture} */
    this.edgeColorTexture = undefined;
    /** @type {Texture} */
    this.edgeDepthTexture = undefined;
    /**
     * Texture written by the planar fill feature-ID pre-pass.
     * Contains per-pixel feature IDs for non-behind planar fill geometry.
     * Sampled by behind fills to test same-object coplanarity.
     * @type {Texture}
     */
    this.planarFillIdTexture = undefined;
    /** @type {number} */
    this.gamma = undefined;

    this._viewport = new BoundingRectangle();
    this._viewportCartesian4 = new Cartesian4();
    this._viewportDirty = false;
    this._viewportOrthographicMatrix = Matrix4.clone(Matrix4.IDENTITY);
    this._viewportTransformation = Matrix4.clone(Matrix4.IDENTITY);

    this._model = Matrix4.clone(Matrix4.IDENTITY);
    this._view = Matrix4.clone(Matrix4.IDENTITY);
    this._inverseView = Matrix4.clone(Matrix4.IDENTITY);
    this._projection = Matrix4.clone(Matrix4.IDENTITY);
    this._infiniteProjection = Matrix4.clone(Matrix4.IDENTITY);
    this._entireFrustum = new Cartesian2();
    this._currentFrustum = new Cartesian2();
    this._frustumPlanes = new Cartesian4();
    this._farDepthFromNearPlusOne = undefined;
    this._log2FarDepthFromNearPlusOne = undefined;
    this._oneOverLog2FarDepthFromNearPlusOne = undefined;

    this._frameState = undefined;
    this._temeToPseudoFixed = Matrix3.clone(Matrix4.IDENTITY);

    this._view3DDirty = true;
    this._view3D = new Matrix4();

    this._inverseView3DDirty = true;
    this._inverseView3D = new Matrix4();

    this._inverseModelDirty = true;
    this._inverseModel = new Matrix4();

    this._inverseTransposeModelDirty = true;
    this._inverseTransposeModel = new Matrix3();

    this._viewRotation = new Matrix3();
    this._inverseViewRotation = new Matrix3();

    this._viewRotation3D = new Matrix3();
    this._inverseViewRotation3D = new Matrix3();

    this._inverseProjectionDirty = true;
    this._inverseProjection = new Matrix4();

    this._modelViewDirty = true;
    this._modelView = new Matrix4();

    this._modelView3DDirty = true;
    this._modelView3D = new Matrix4();

    this._modelViewRelativeToEyeDirty = true;
    this._modelViewRelativeToEye = new Matrix4();

    this._inverseModelViewDirty = true;
    this._inverseModelView = new Matrix4();

    this._inverseModelView3DDirty = true;
    this._inverseModelView3D = new Matrix4();

    this._viewProjectionDirty = true;
    this._viewProjection = new Matrix4();

    // View-projection relative to eye: projection * (view with translation
    // zeroed). Model-independent — used by post-process passes (TAA motion
    // vectors) that feed it identity model matrices. Mirrors the upstream
    // `_modelViewProjectionRelativeToEye` but without per-command model bias.
    this._viewProjectionRelativeToEyeDirty = true;
    this._viewProjectionRelativeToEye = new Matrix4();

    // TAA: previous frame's view-projection for reprojection.
    // Initialize as identity, not zero. Many WebGPU renderers pack
    // `previousViewProjection` into the camera UBO with the pattern
    // `if (prevVP) { Matrix4.pack(...) } else { /* identity fallback */ }`.
    // Since `Matrix4` is always a truthy object reference, the else branch
    // is unreachable; the initial zero-matrix value would propagate into
    // the UBO on frame 0 and produce broken motion vectors when downstream
    // consumers land. Initializing as identity makes the first-frame value
    // safe and makes the now-dead `else` fallback a redundant-but-correct
    // mirror.
    this._previousViewProjection = Matrix4.clone(Matrix4.IDENTITY);

    // TAA RTE motion vectors: previous frame's camera position (world-space)
    // and previous frame's view-projection-relative-to-eye. Used by the TAA
    // resolve pass to compute motion vectors via depth reprojection without
    // reconstructing world-space positions at Earth scale (which loses ~1m
    // to FP32). Loaded by `update()` from the active logical View's last
    // submitted presentation before the current camera is prepared. The
    // VP_RTE form is model-independent, so auxiliary/pass-camera preparation
    // cannot advance or contaminate the View-owned record.
    //
    // Motion-vector math in the TAA shader:
    //   currentEyeRel = inverse(currentVP_RTE) * vec4(ndc, 1) / w
    //   previousEyeRel = currentEyeRel + cameraDelta        // FP64 on CPU → vec3 on GPU
    //   previousClip = previousVP_RTE * vec4(previousEyeRel, 1)
    //   motion = currentUV - (previousClip.xy/w * 0.5 + 0.5)
    //
    // where cameraDelta = currentCameraWC - previousCameraWC.
    this._previousCameraPosition = new Cartesian3();
    // Same first-frame safety as `_previousViewProjection` above:
    // initialize as identity so first-frame UBO packs land at a meaningful
    // value if any consumer races the first `UniformState.update()` call.
    this._previousViewProjectionRelativeToEye = Matrix4.clone(Matrix4.IDENTITY);
    this._temporalHistoryValid = false;

    this._inverseViewProjectionDirty = true;
    this._inverseViewProjection = new Matrix4();

    this._modelViewProjectionDirty = true;
    this._modelViewProjection = new Matrix4();

    this._inverseModelViewProjectionDirty = true;
    this._inverseModelViewProjection = new Matrix4();

    this._modelViewProjectionRelativeToEyeDirty = true;
    this._modelViewProjectionRelativeToEye = new Matrix4();

    this._modelViewInfiniteProjectionDirty = true;
    this._modelViewInfiniteProjection = new Matrix4();

    this._normalDirty = true;
    this._normal = new Matrix3();

    this._normal3DDirty = true;
    this._normal3D = new Matrix3();

    this._inverseNormalDirty = true;
    this._inverseNormal = new Matrix3();

    this._inverseNormal3DDirty = true;
    this._inverseNormal3D = new Matrix3();

    this._encodedCameraPositionMCDirty = true;
    this._encodedCameraPositionMC = new EncodedCartesian3();
    this._cameraPosition = new Cartesian3();

    this._sunPositionWC = new Cartesian3();
    this._sunPositionColumbusView = new Cartesian3();
    this._sunDirectionWC = new Cartesian3();
    this._sunDirectionEC = new Cartesian3();
    this._moonDirectionWC = new Cartesian3();
    this._moonDirectionEC = new Cartesian3();

    this._lightDirectionWC = new Cartesian3();
    this._lightDirectionEC = new Cartesian3();
    this._lightColor = new Cartesian3();
    this._lightColorHdr = new Cartesian3();

    this._lightCount = 0;
    // Sized from the packer so `LightCollection.pack` never has to reallocate
    // and never hands `czm_lightsData` more floats than the GLSL array holds.
    this._lightsData = new Float32Array(LIGHT_PACK_FLOATS);

    this._pass = undefined;
    this._mode = undefined;
    this._mapProjection = undefined;
    this._ellipsoid = undefined;
    this._cameraDirection = new Cartesian3();
    this._cameraRight = new Cartesian3();
    this._cameraUp = new Cartesian3();
    this._frustum2DWidth = 0.0;
    this._eyeHeight = 0.0;
    this._eyeHeight2D = new Cartesian2();
    this._eyeCartographic = new Cartesian3();
    this._eyeEllipsoidNormalEC = new Cartesian3();
    this._eyeEllipsoidCurvature = new Cartesian2();
    this._eyeToEnu = new Matrix3();
    this._modelToEnu = new Matrix4();
    this._enuToModel = new Matrix4();
    this._pixelRatio = 1.0;
    this._orthographicIn3D = false;
    this._backgroundColor = new Color();

    this._brdfLut = undefined;
    this._environmentMap = undefined;

    this._sphericalHarmonicCoefficients = undefined;
    this._specularEnvironmentMaps = undefined;
    this._specularEnvironmentMapsMaximumLOD = undefined;

    this._fogDensity = undefined;
    this._fogVisualDensityScalar = undefined;
    this._fogMinimumBrightness = undefined;

    this._atmosphereHsbShift = undefined;
    this._atmosphereLightIntensity = undefined;
    this._atmosphereRayleighCoefficient = new Cartesian3();
    this._atmosphereRayleighScaleHeight = new Cartesian3();
    this._atmosphereMieCoefficient = new Cartesian3();
    this._atmosphereMieScaleHeight = undefined;
    this._atmosphereMieAnisotropy = undefined;
    this._atmosphereDynamicLighting = undefined;

    this._invertClassificationColor = undefined;

    this._splitPosition = 0.0;
    this._pixelSizePerMeter = undefined;
    this._geometricToleranceOverMeter = undefined;

    this._minimumDisableDepthTestDistance = undefined;
  }

  /** @type {FrameState} */
  get frameState() {
    return this._frameState;
  }

  /** @type {BoundingRectangle} */
  get viewport() {
    return this._viewport;
  }

  set viewport(viewport) {
    if (!BoundingRectangle.equals(viewport, this._viewport)) {
      BoundingRectangle.clone(viewport, this._viewport);
      const v = this._viewport;
      const vc = this._viewportCartesian4;
      vc.x = v.x;
      vc.y = v.y;
      vc.z = v.width;
      vc.w = v.height;
      this._viewportDirty = true;
    }
  }

  get viewportCartesian4() {
    return this._viewportCartesian4;
  }

  get viewportOrthographic() {
    cleanViewport(this);
    return this._viewportOrthographicMatrix;
  }

  get viewportTransformation() {
    cleanViewport(this);
    return this._viewportTransformation;
  }

  /** @type {Matrix4} */
  get model() {
    return this._model;
  }

  set model(matrix) {
    Matrix4.clone(matrix, this._model);
    this._modelView3DDirty = true;
    this._inverseModelView3DDirty = true;
    this._inverseModelDirty = true;
    this._inverseTransposeModelDirty = true;
    this._modelViewDirty = true;
    this._inverseModelViewDirty = true;
    this._modelViewRelativeToEyeDirty = true;
    this._modelViewProjectionDirty = true;
    this._inverseModelViewProjectionDirty = true;
    this._modelViewProjectionRelativeToEyeDirty = true;
    this._modelViewInfiniteProjectionDirty = true;
    this._normalDirty = true;
    this._inverseNormalDirty = true;
    this._normal3DDirty = true;
    this._inverseNormal3DDirty = true;
    this._encodedCameraPositionMCDirty = true;
  }

  /** @type {Matrix4} */
  get inverseModel() {
    if (this._inverseModelDirty) {
      this._inverseModelDirty = false;
      Matrix4.inverse(this._model, this._inverseModel);
    }
    return this._inverseModel;
  }

  get inverseTransposeModel() {
    const m = this._inverseTransposeModel;
    if (this._inverseTransposeModelDirty) {
      this._inverseTransposeModelDirty = false;
      Matrix4.getMatrix3(this.inverseModel, m);
      Matrix3.transpose(m, m);
    }
    return m;
  }

  /** @type {Matrix4} */
  get view() {
    return this._view;
  }

  get view3D() {
    updateView3D(this);
    return this._view3D;
  }

  get viewRotation() {
    updateView3D(this);
    return this._viewRotation;
  }

  get viewRotation3D() {
    updateView3D(this);
    return this._viewRotation3D;
  }

  /** @type {Matrix4} */
  get inverseView() {
    return this._inverseView;
  }

  get inverseView3D() {
    updateInverseView3D(this);
    return this._inverseView3D;
  }

  get inverseViewRotation() {
    return this._inverseViewRotation;
  }

  get inverseViewRotation3D() {
    updateInverseView3D(this);
    return this._inverseViewRotation3D;
  }

  /** @type {Matrix4} */
  get projection() {
    return this._projection;
  }

  get inverseProjection() {
    cleanInverseProjection(this);
    return this._inverseProjection;
  }

  get infiniteProjection() {
    return this._infiniteProjection;
  }

  get modelView() {
    cleanModelView(this);
    return this._modelView;
  }

  get modelView3D() {
    cleanModelView3D(this);
    return this._modelView3D;
  }

  get modelViewRelativeToEye() {
    cleanModelViewRelativeToEye(this);
    return this._modelViewRelativeToEye;
  }

  get inverseModelView() {
    cleanInverseModelView(this);
    return this._inverseModelView;
  }

  get inverseModelView3D() {
    cleanInverseModelView3D(this);
    return this._inverseModelView3D;
  }

  get viewProjection() {
    cleanViewProjection(this);
    return this._viewProjection;
  }

  get previousViewProjection() {
    return this._previousViewProjection;
  }

  /**
   * Current frame's world-space camera position (`Cartesian3`). Populated
   * by `UniformStateComputations.updateCamera` from `camera.positionWC` on
   * every per-frame `UniformState.update` pass. Renderer code reads this
   * via `uniformState.cameraPosition` to encode RTE high/low pairs and to
   * derive eye-space / model-space camera coords for shader uniforms.
   *
   * The TS `.d.ts` companion declares this property, and roughly a dozen
   * WebGPU renderer call sites read it; without the getter every read
   * returns `undefined`, which the debug-only `Check.typeOf.object`
   * pragma in callers like `EncodedCartesian3.fromCartesian` /
   * `Matrix4.multiplyByPoint` surfaces as a hard `DeveloperError` the
   * first time a render path exercises the field, in an unminified debug
   * build where the pragmas are not stripped.
   *
   * @type {Cartesian3}
   * @readonly
   */
  get cameraPosition() {
    return this._cameraPosition;
  }

  /**
   * Previous frame's world-space camera position. Used with the current
   * frame's camera position to derive `cameraDelta` for TAA motion vectors.
   * @type {Cartesian3}
   * @readonly
   */
  get previousCameraPosition() {
    return this._previousCameraPosition;
  }

  /**
   * Model-independent view-projection relative to eye: projection × view
   * with the view's translation column zeroed. Consumers like TAA's resolve
   * pass need a matrix whose semantics don't depend on what model the last
   * draw command bound to `_model`.
   * @type {Matrix4}
   * @readonly
   */
  get viewProjectionRelativeToEye() {
    cleanViewProjectionRelativeToEye(this);
    return this._viewProjectionRelativeToEye;
  }

  /**
   * Previous frame's `viewProjectionRelativeToEye`. TAA's resolve pass
   * uses this together with the current VP_RTE and `cameraDelta`
   * (current - previous camera position) to compute motion vectors via
   * depth reprojection without reconstructing world-space positions,
   * which would lose ~1m FP32 precision at Earth radius.
   * @type {Matrix4}
   * @readonly
   */
  get previousViewProjectionRelativeToEye() {
    return this._previousViewProjectionRelativeToEye;
  }

  /**
   * Whether the active logical View has compatible previously presented
   * camera history. False on its first frame and after teleport, morph, mode,
   * map-projection, or perspective/orthographic transitions.
   * @type {boolean}
   * @readonly
   */
  get temporalHistoryValid() {
    return this._temporalHistoryValid;
  }

  get inverseViewProjection() {
    cleanInverseViewProjection(this);
    return this._inverseViewProjection;
  }

  get modelViewProjection() {
    cleanModelViewProjection(this);
    return this._modelViewProjection;
  }

  get inverseModelViewProjection() {
    cleanInverseModelViewProjection(this);
    return this._inverseModelViewProjection;
  }

  get modelViewProjectionRelativeToEye() {
    cleanModelViewProjectionRelativeToEye(this);
    return this._modelViewProjectionRelativeToEye;
  }

  get modelViewInfiniteProjection() {
    cleanModelViewInfiniteProjection(this);
    return this._modelViewInfiniteProjection;
  }

  get normal() {
    cleanNormal(this);
    return this._normal;
  }

  get normal3D() {
    cleanNormal3D(this);
    return this._normal3D;
  }

  get inverseNormal() {
    cleanInverseNormal(this);
    return this._inverseNormal;
  }

  get inverseNormal3D() {
    cleanInverseNormal3D(this);
    return this._inverseNormal3D;
  }

  get entireFrustum() {
    return this._entireFrustum;
  }

  get currentFrustum() {
    return this._currentFrustum;
  }

  get frustumPlanes() {
    return this._frustumPlanes;
  }

  get farDepthFromNearPlusOne() {
    return this._farDepthFromNearPlusOne;
  }

  get log2FarDepthFromNearPlusOne() {
    return this._log2FarDepthFromNearPlusOne;
  }

  get oneOverLog2FarDepthFromNearPlusOne() {
    return this._oneOverLog2FarDepthFromNearPlusOne;
  }

  get eyeHeight() {
    return this._eyeHeight;
  }

  /** Geodetic longitude (x) / latitude (y) in radians and height (z) in metres of the
   * eye. Only valid when the SceneMode is SCENE3D.
   * @type {Cartesian3} */
  get eyeCartographic() {
    return this._eyeCartographic;
  }

  get eyeHeight2D() {
    return this._eyeHeight2D;
  }

  get eyeEllipsoidNormalEC() {
    return this._eyeEllipsoidNormalEC;
  }

  get eyeEllipsoidCurvature() {
    return this._eyeEllipsoidCurvature;
  }

  /** Rotation from eye coordinates to an east-north-up frame centred on the ellipsoid
   * below the camera. Only valid when the SceneMode is SCENE3D.
   * @type {Matrix3} */
  get eyeToEnu() {
    return this._eyeToEnu;
  }

  get modelToEnu() {
    return this._modelToEnu;
  }

  get enuToModel() {
    return this._enuToModel;
  }

  get sunPositionWC() {
    return this._sunPositionWC;
  }

  get sunPositionColumbusView() {
    return this._sunPositionColumbusView;
  }

  get sunDirectionWC() {
    return this._sunDirectionWC;
  }

  get sunDirectionEC() {
    return this._sunDirectionEC;
  }

  get moonDirectionWC() {
    return this._moonDirectionWC;
  }

  get moonDirectionEC() {
    return this._moonDirectionEC;
  }

  get lightDirectionWC() {
    return this._lightDirectionWC;
  }

  get lightDirectionEC() {
    return this._lightDirectionEC;
  }

  get lightColor() {
    return this._lightColor;
  }

  get lightColorHdr() {
    return this._lightColorHdr;
  }

  get lightCount() {
    return this._lightCount;
  }

  get lightsData() {
    return this._lightsData;
  }

  get encodedCameraPositionMCHigh() {
    cleanEncodedCameraPositionMC(this);
    return this._encodedCameraPositionMC.high;
  }

  get encodedCameraPositionMCLow() {
    cleanEncodedCameraPositionMC(this);
    return this._encodedCameraPositionMC.low;
  }

  get temeToPseudoFixedMatrix() {
    return this._temeToPseudoFixed;
  }

  get pixelRatio() {
    return this._pixelRatio;
  }

  get fogDensity() {
    return this._fogDensity;
  }

  get fogVisualDensityScalar() {
    return this._fogVisualDensityScalar;
  }

  get fogMinimumBrightness() {
    return this._fogMinimumBrightness;
  }

  get atmosphereHsbShift() {
    return this._atmosphereHsbShift;
  }

  get atmosphereLightIntensity() {
    return this._atmosphereLightIntensity;
  }

  get atmosphereRayleighCoefficient() {
    return this._atmosphereRayleighCoefficient;
  }

  get atmosphereRayleighScaleHeight() {
    return this._atmosphereRayleighScaleHeight;
  }

  get atmosphereMieCoefficient() {
    return this._atmosphereMieCoefficient;
  }

  get atmosphereMieScaleHeight() {
    return this._atmosphereMieScaleHeight;
  }

  get atmosphereMieAnisotropy() {
    return this._atmosphereMieAnisotropy;
  }

  get atmosphereDynamicLighting() {
    return this._atmosphereDynamicLighting;
  }

  get geometricToleranceOverMeter() {
    return this._geometricToleranceOverMeter;
  }

  get pass() {
    return this._pass;
  }

  get backgroundColor() {
    return this._backgroundColor;
  }

  get brdfLut() {
    return this._brdfLut;
  }

  get environmentMap() {
    return this._environmentMap;
  }

  get sphericalHarmonicCoefficients() {
    return this._sphericalHarmonicCoefficients;
  }

  get specularEnvironmentMaps() {
    return this._specularEnvironmentMaps;
  }

  get specularEnvironmentMapsMaximumLOD() {
    return this._specularEnvironmentMapsMaximumLOD;
  }

  get splitPosition() {
    return this._splitPosition;
  }

  get minimumDisableDepthTestDistance() {
    return this._minimumDisableDepthTestDistance;
  }

  get invertClassificationColor() {
    return this._invertClassificationColor;
  }

  get orthographicIn3D() {
    return this._orthographicIn3D;
  }

  get ellipsoid() {
    return this._ellipsoid ?? Ellipsoid.default;
  }

  /**
   * Synchronizes the frustum's state with the camera state.
   * @param {object} camera The camera to synchronize with.
   */
  updateCamera(camera) {
    setView(this, camera.viewMatrix);
    setInverseView(this, camera.inverseViewMatrix);
    setCamera(this, camera);

    this._entireFrustum.x = camera.frustum.near;
    this._entireFrustum.y = camera.frustum.far;
    this.updateFrustum(camera.frustum);

    this._orthographicIn3D =
      this._mode !== SceneMode.SCENE2D &&
      camera.frustum instanceof OrthographicFrustum;
  }

  /**
   * Synchronizes the frustum's state with the uniform state.
   * @param {object} frustum The frustum to synchronize with.
   */
  updateFrustum(frustum) {
    const projection = defined(frustum.getProjectionMatrix)
      ? frustum.getProjectionMatrix(this._clipSpaceConvention)
      : frustum.projectionMatrix;
    setProjection(this, projection);

    if (defined(frustum.getInfiniteProjectionMatrix)) {
      setInfiniteProjection(
        this,
        frustum.getInfiniteProjectionMatrix(this._clipSpaceConvention),
      );
    } else if (defined(frustum.infiniteProjectionMatrix)) {
      setInfiniteProjection(this, frustum.infiniteProjectionMatrix);
    }
    this._currentFrustum.x = frustum.near;
    this._currentFrustum.y = frustum.far;

    this._farDepthFromNearPlusOne = frustum.far - frustum.near + 1.0;
    this._log2FarDepthFromNearPlusOne = CesiumMath.log2(
      this._farDepthFromNearPlusOne,
    );
    this._oneOverLog2FarDepthFromNearPlusOne =
      1.0 / this._log2FarDepthFromNearPlusOne;

    const offCenterFrustum = frustum.offCenterFrustum;
    if (defined(offCenterFrustum)) {
      frustum = offCenterFrustum;
    }

    this._frustumPlanes.x = frustum.top;
    this._frustumPlanes.y = frustum.bottom;
    this._frustumPlanes.z = frustum.left;
    this._frustumPlanes.w = frustum.right;
  }

  updatePass(pass) {
    this._pass = pass;
  }

  /**
   * Synchronizes frame state with the uniform state.
   * @param {FrameState} frameState The frameState to synchronize with.
   */
  update(frameState) {
    // Previous camera state is owned by the active logical View and advances
    // only at Scene's successful presented-frame boundary. Re-entrant pick,
    // ray, viewport, shadow, and capture updates merely reload this immutable
    // snapshot, so they cannot turn main-view history into current/current or
    // leak another camera into it. Keep the old context-local snapshot only
    // for direct/private callers that supply no logical View.
    const temporalHistory = frameState.view?._temporalHistory;
    let hasPresentedTemporalHistory = false;
    if (defined(temporalHistory)) {
      hasPresentedTemporalHistory = readViewTemporalHistory(
        temporalHistory,
        this._previousViewProjection,
        this._previousViewProjectionRelativeToEye,
        this._previousCameraPosition,
      );
    } else {
      cleanViewProjection(this);
      Matrix4.clone(this._viewProjection, this._previousViewProjection);
      Cartesian3.clone(this._cameraPosition, this._previousCameraPosition);
      cleanViewProjectionRelativeToEye(this);
      Matrix4.clone(
        this._viewProjectionRelativeToEye,
        this._previousViewProjectionRelativeToEye,
      );
    }

    this._mode = frameState.mode;
    this._mapProjection = frameState.mapProjection;
    this._ellipsoid = frameState.mapProjection.ellipsoid;
    this._pixelRatio = frameState.pixelRatio;

    const camera = frameState.camera;
    this.updateCamera(camera);

    this._temporalHistoryValid =
      defined(temporalHistory) &&
      isViewTemporalHistoryValid(temporalHistory, frameState);

    // On an initialized View, incompatible history is reset to the current
    // camera in the context-local results. The View's committed record remains
    // untouched until presentation. This gives every previous-VP UBO consumer
    // zero motion on teleport/morph/projection resets, while the genuinely
    // first frame retains the historical identity/zero fallback.
    if (hasPresentedTemporalHistory && !this._temporalHistoryValid) {
      cleanViewProjection(this);
      Matrix4.clone(this._viewProjection, this._previousViewProjection);
      cleanViewProjectionRelativeToEye(this);
      Matrix4.clone(
        this._viewProjectionRelativeToEye,
        this._previousViewProjectionRelativeToEye,
      );
      Cartesian3.clone(this._cameraPosition, this._previousCameraPosition);
    }
    frameState.temporalHistoryValid = this._temporalHistoryValid;

    if (frameState.mode === SceneMode.SCENE2D) {
      this._frustum2DWidth = camera.frustum.right - camera.frustum.left;
      this._eyeHeight2D.x = this._frustum2DWidth * 0.5;
      this._eyeHeight2D.y = this._eyeHeight2D.x * this._eyeHeight2D.x;
    } else {
      this._frustum2DWidth = 0.0;
      this._eyeHeight2D.x = 0.0;
      this._eyeHeight2D.y = 0.0;
    }

    setSunAndMoonDirections(this, frameState);

    const light = frameState.light ?? defaultLight;
    if (light instanceof SunLight) {
      this._lightDirectionWC = Cartesian3.clone(
        this._sunDirectionWC,
        this._lightDirectionWC,
      );
      this._lightDirectionEC = Cartesian3.clone(
        this._sunDirectionEC,
        this._lightDirectionEC,
      );
    } else if (light instanceof MoonLight) {
      // `MoonLight`, like `SunLight`, is a marker: it carries colour and
      // intensity but no per-instance direction, because the direction is
      // ephemeris rather than user state. The generic arm below negates
      // `light.direction`, so without this branch assigning one to
      // `scene.light` threw on its first frame and everything downstream of
      // the branch — the lunar dimming a few dozen lines on included — could
      // never run.
      //
      // Taken from the directions computed for this frame rather than from
      // `frameState.moonDirectionWC`: that field belongs to `Moon.update`,
      // which returns before publishing when the Moon is hidden and so leaves
      // the previous frame's vector in place. Switching off the Moon's
      // billboard must not freeze the light that Moon casts.
      //
      // No negation. Both directions already point at the Moon, which is the
      // sense `czm_lightDirectionWC` is documented in and the sense the sun
      // arm above clones.
      this._lightDirectionWC = Cartesian3.clone(
        this._moonDirectionWC,
        this._lightDirectionWC,
      );
      this._lightDirectionEC = Cartesian3.clone(
        this._moonDirectionEC,
        this._lightDirectionEC,
      );
    } else {
      this._lightDirectionWC = Cartesian3.normalize(
        Cartesian3.negate(light.direction, this._lightDirectionWC),
        this._lightDirectionWC,
      );
      this._lightDirectionEC = Matrix3.multiplyByVector(
        this.viewRotation3D,
        this._lightDirectionWC,
        this._lightDirectionEC,
      );
    }

    const lightColor = light.color;
    let lightColorHdr = Cartesian3.fromElements(
      lightColor.red,
      lightColor.green,
      lightColor.blue,
      this._lightColorHdr,
    );
    lightColorHdr = Cartesian3.multiplyByScalar(
      lightColorHdr,
      light.intensity,
      lightColorHdr,
    );
    const maximumComponent = Cartesian3.maximumComponent(lightColorHdr);
    if (maximumComponent > 1.0) {
      Cartesian3.divideByScalar(
        lightColorHdr,
        maximumComponent,
        this._lightColor,
      );
    } else {
      Cartesian3.clone(lightColorHdr, this._lightColor);
    }

    // Eclipse dimming of the sun-driven scene light. Applying it here, at
    // the uniform source, reaches every consumer of `czm_lightColor` /
    // `czm_lightColorHdr` on WebGL and of `csm_lightColor*` on WebGPU — the
    // globe's diffuse term, phong, translucent phong, and the model PBR
    // lighting stage — so the factor does not have to be threaded through
    // eight shaders.
    //
    // `ModelPBRComplete.wgsl` is the exception: it reads none of the
    // `csm_lightColor*` automatic uniforms and lights from
    // `light.sunColor * light.sunIntensity * NdotL`, packed by
    // `WebGPUModelRenderer.packLightUniforms`, which carries its own copy of
    // this multiply under the same `instanceof SunLight` gate. The two must
    // change together or WebGPU models stay lit while the WebGPU globe dims.
    // `eclipse-scene-dimming.spec.mjs` pins both halves.
    //
    // Applied after the LDR clamp, not before. `_lightColor` is
    // `_lightColorHdr` renormalised so its brightest channel is at most 1,
    // so a pre-clamp multiply is swallowed by the renormalisation until the
    // factor drops below 1 / intensity — 0.5 at the default sun intensity of
    // 2.0 — which would hold the light steady through the first half of the
    // eclipse and then dim it at double rate. Dimming after the clamp is
    // what "the sun got fainter" means in LDR.
    //
    // Gated on `light instanceof SunLight` — the branch above — so a
    // user-supplied DirectionalLight is never touched. WebGPU's aerial-
    // perspective path swaps in its own derived light, but that light is a
    // `SunLight` too (`Scene._atmosphereDerivedLight`), so both backends dim.
    //
    // The `!== 1.0` guard keeps every non-eclipse frame untouched by
    // construction rather than by arithmetic.
    const eclipseSceneLightFactor = frameState.eclipseSceneLightFactor;
    if (
      light instanceof SunLight &&
      typeof eclipseSceneLightFactor === "number" &&
      eclipseSceneLightFactor !== 1.0
    ) {
      Cartesian3.multiplyByScalar(
        this._lightColorHdr,
        eclipseSceneLightFactor,
        this._lightColorHdr,
      );
      Cartesian3.multiplyByScalar(
        this._lightColor,
        eclipseSceneLightFactor,
        this._lightColor,
      );
    }

    // The lunar arm of the same contract: Earth's shadow dimming the MOON,
    // for a scene the Moon is lighting.
    //
    // A different event and a different gate. The factor above is the Moon
    // standing in front of the Sun, and it applies to a `SunLight`; this one
    // is Earth standing in front of the Sun as seen from the Moon, and it
    // applies to a `MoonLight`. The two are mutually exclusive by light type,
    // which is what keeps a lunar eclipse from darkening a sunlit scene — the
    // Sun is entirely unaffected by one, and the day side of the Earth does
    // not dim because the Moon has gone red.
    //
    // The multiplier is the Moon's disc-averaged brightness under the same
    // per-point law both moon disc shaders evaluate, so the rendered disc and
    // the light it casts cannot disagree about how eclipsed the Moon is.
    //
    // AFTER the LDR clamp for the same reason the solar arm is: `_lightColor`
    // is `_lightColorHdr` renormalised so its brightest channel is at most 1,
    // and a pre-clamp multiply would be swallowed by that renormalisation
    // until the factor fell below 1/intensity.
    //
    // `MoonLight` is opt-in (`scene.light = new Cesium.MoonLight()`), so this
    // branch is not reached in a default scene at all; combined with the
    // `!== 1.0` guard, every frame that is not a moonlit lunar eclipse is
    // untouched by construction.
    if (light instanceof MoonLight) {
      const moonlightFactor = getLunarEclipseMoonlightFactor(
        frameState.lunarEclipse,
        frameState.atmosphericConditions?.lighting,
      );
      if (moonlightFactor !== 1.0) {
        Cartesian3.multiplyByScalar(
          this._lightColorHdr,
          moonlightFactor,
          this._lightColorHdr,
        );
        Cartesian3.multiplyByScalar(
          this._lightColor,
          moonlightFactor,
          this._lightColor,
        );
      }
    }

    // Multi-light: pack additional lights from LightCollection
    const lights = frameState.lights;
    if (defined(lights) && lights.length > 0) {
      this._lightsData = lights.pack(this._lightsData);
      // The header slot records how many lights `pack` actually wrote, which
      // is not `enabledCount`: area lights are enabled but are served by the
      // clustered path and occupy no punctual slot. The shader's loop bound
      // must agree with the buffer it reads, so take the count from the
      // buffer.
      this._lightCount = this._lightsData[0];
    } else {
      this._lightCount = 0;
    }

    const brdfLutGenerator = frameState.brdfLutGenerator;
    const brdfLut = defined(brdfLutGenerator)
      ? brdfLutGenerator.colorTexture
      : undefined;
    this._brdfLut = brdfLut;

    this._environmentMap =
      frameState.environmentMap ?? frameState.context.defaultCubeMap;

    this._sphericalHarmonicCoefficients =
      frameState.sphericalHarmonicCoefficients ?? EMPTY_ARRAY;
    this._specularEnvironmentMaps = frameState.specularEnvironmentMaps;
    this._specularEnvironmentMapsMaximumLOD =
      frameState.specularEnvironmentMapsMaximumLOD;

    this._fogDensity = frameState.fog.density;
    this._fogVisualDensityScalar = frameState.fog.visualDensityScalar;
    this._fogMinimumBrightness = frameState.fog.minimumBrightness;

    const atmosphere = frameState.atmosphere;
    if (defined(atmosphere)) {
      this._atmosphereHsbShift = Cartesian3.fromElements(
        atmosphere.hueShift,
        atmosphere.saturationShift,
        atmosphere.brightnessShift,
        this._atmosphereHsbShift,
      );
      this._atmosphereLightIntensity = atmosphere.lightIntensity;
      this._atmosphereRayleighCoefficient = Cartesian3.clone(
        atmosphere.rayleighCoefficient,
        this._atmosphereRayleighCoefficient,
      );
      this._atmosphereRayleighScaleHeight = atmosphere.rayleighScaleHeight;
      this._atmosphereMieCoefficient = Cartesian3.clone(
        atmosphere.mieCoefficient,
        this._atmosphereMieCoefficient,
      );
      this._atmosphereMieScaleHeight = atmosphere.mieScaleHeight;
      this._atmosphereMieAnisotropy = atmosphere.mieAnisotropy;
      this._atmosphereDynamicLighting = atmosphere.dynamicLighting;
    }

    this._invertClassificationColor = frameState.invertClassificationColor;

    this._frameState = frameState;
    this._temeToPseudoFixed = Transforms.computeTemeToPseudoFixedMatrix(
      frameState.time,
      this._temeToPseudoFixed,
    );

    this._splitPosition =
      frameState.splitPosition * frameState.context.drawingBufferWidth;
    const fov = camera.frustum.fov;
    const viewport = this._viewport;
    let pixelSizePerMeter;
    if (defined(fov)) {
      if (viewport.height > viewport.width) {
        pixelSizePerMeter = (Math.tan(0.5 * fov) * 2.0) / viewport.height;
      } else {
        pixelSizePerMeter = (Math.tan(0.5 * fov) * 2.0) / viewport.width;
      }
    } else {
      pixelSizePerMeter = 1.0 / Math.max(viewport.width, viewport.height);
    }

    this._geometricToleranceOverMeter =
      pixelSizePerMeter * frameState.maximumScreenSpaceError;
    Color.clone(frameState.backgroundColor, this._backgroundColor);

    this._minimumDisableDepthTestDistance =
      frameState.minimumDisableDepthTestDistance;
    this._minimumDisableDepthTestDistance *=
      this._minimumDisableDepthTestDistance;
    if (this._minimumDisableDepthTestDistance === Number.POSITIVE_INFINITY) {
      this._minimumDisableDepthTestDistance = -1.0;
    }
  }
}

export default UniformState;
