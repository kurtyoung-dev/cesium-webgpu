import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Check from "../Core/Check.js";
import clone from "../Core/clone.js";
import Color from "../Core/Color.js";
import createGuid from "../Core/createGuid.js";
import CullingVolume from "../Core/CullingVolume.js";
import Frozen from "../Core/Frozen.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import DeveloperError from "../Core/DeveloperError.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import Event from "../Core/Event.js";
import GeographicProjection from "../Core/GeographicProjection.js";
import HeightReference from "./HeightReference.js";
import Intersect from "../Core/Intersect.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import Interval from "../Core/Interval.js";
import JulianDate from "../Core/JulianDate.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import RenderScheduler from "./RenderScheduler.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import RequestScheduler from "../Core/RequestScheduler.js";
import Simon1994EphemerisProvider from "../Core/Simon1994EphemerisProvider.js";
import TaskProcessor from "../Core/TaskProcessor.js";
import Transforms from "../Core/Transforms.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import ComputeEngine from "../Renderer/ComputeEngine.js";
import ControllerHost from "./Controllers/ControllerHost.js";
import Context from "../Renderer/Context.js";
import ContextFactory from "../Renderer/ContextFactory.js";
import RendererType, {
  getSynchronousRendererType,
} from "../Renderer/RendererType.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import Atmosphere from "./Atmosphere.js";
import AtmosphericConditions from "./AtmosphericConditions.js";
import { computeSkyBrightness } from "./SkyBrightness.js";
import {
  createSolarGlareAppearance,
  readSolarGlareAppearance,
} from "./SolarGlareAppearance.js";
import {
  getEclipseHorizonTwilightFactor,
  getEclipseSceneLightFactor,
  updateEclipseState,
} from "./EclipseState.js";
import GlobeWater from "./GlobeWater.js";
import VisualPerformanceTargetService from "../Services/VisualPerformanceTargetService.js";
import SnapshotModeService from "../Services/SnapshotModeService.js";
import PerformanceTracker from "../Services/PerformanceTracker.js";
import BrdfLutGenerator from "./BrdfLutGenerator.js";
import {
  callAfterRenderFunctions,
  getGlobeHeight,
  getMaxPrimitiveHeight,
  getOccluder,
  isCameraUnderground,
  updateFrameNumber,
  updateHeightScratchCartographic,
} from "./SceneUtilities.js";
import { updateDebugShowFramesPerSecond } from "./SceneDebug.js";
import Camera from "./Camera.js";
import Cesium3DTilePass from "./Cesium3DTilePass.js";
import Cesium3DTilePassState from "./Cesium3DTilePassState.js";
import CreditDisplay from "./CreditDisplay.js";
import DepthPlane from "./DepthPlane.js";
import DerivedCommand from "./DerivedCommand.js";
import DeviceOrientationCameraController from "./DeviceOrientationCameraController.js";
import DynamicAtmosphereLightingType from "./DynamicAtmosphereLightingType.js";
import Fog from "./Fog.js";
import FrameState from "./FrameState.js";
import GlobeTranslucencyState from "./GlobeTranslucencyState.js";
import {
  HdrDisplayPolicy,
  normalizeHdrDisplayPolicy,
  observeHdrDisplay,
  queryHdrDisplay,
  resolveHdrDefault,
} from "./HdrDisplayCapability.js";
import InvertClassification from "./InvertClassification.js";
import JobScheduler from "./JobScheduler.js";
import MapMode2D from "./MapMode2D.js";
import Picking from "./Picking.js";
import PostProcessStageCollection from "./PostProcessStageCollection.js";
import PrimitiveCollection from "./PrimitiveCollection.js";
import SceneMode from "./SceneMode.js";
import SceneTransforms from "./SceneTransforms.js";
import SceneTransitioner from "./SceneTransitioner.js";
import ScreenSpaceCameraController from "./ScreenSpaceCameraController.js";
import ShadowMap from "./ShadowMap.js";
import SharedContext from "../Renderer/SharedContext.js";
import Snapping from "./Snapping.js";
import SpecularEnvironmentCubeMap from "./SpecularEnvironmentCubeMap.js";
import StencilConstants from "./StencilConstants.js";
import { LightCollection } from "./LightTypes.js";
import SunLight from "./SunLight.js";
import computeAtmosphereDerivedLighting from "./AtmosphereDerivedLighting.js";
import TweenCollection from "./TweenCollection.js";
import View from "./View.js";
import {
  beginViewTemporalHistoryPresentation,
  commitPresentedViewTemporalHistory,
  enqueuePresentedViewTemporalHistoryCommit,
  stagePresentedViewTemporalHistory,
} from "./ViewTemporalHistory.js";
import DebugInspector from "./DebugInspector.js";
import VoxelCell from "./VoxelCell.js";
import VoxelPrimitive from "./VoxelPrimitive.js";
import getMetadataClassProperty from "./getMetadataClassProperty.js";
import PickedMetadataInfo from "./PickedMetadataInfo.js";
import getMetadataProperty from "./getMetadataProperty.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import {
  updateAndClearFramebuffers,
  resolveFramebuffers as resolveFramebuffersImpl,
} from "./FramebufferOrchestrator.js";
import { executeOverlayCommands } from "./SceneRenderer.js";
import scheduleFinalWebGLShaderProgram from "./WebGLShaderProgramScheduler.js";
import {
  executeCommandsInViewport,
  execute2DViewportCommands,
  executeWebVRCommands,
} from "./ViewportExecutor.js";

// Scratch storage keeps atmosphere-derived lighting allocation-free while it
// uses the camera-position direction as the local up vector.
const scratchAtmosphereUp = new Cartesian3();

const requestRenderAfterFrame = function (scene) {
  return function () {
    scene.frameState.afterRender.push(function () {
      scene.requestRender();
    });
  };
};

/**
 * The result of a snap operation. See {@link Scene#snap}.
 *
 * @typedef {object} SceneSnapResult
 * @property {object} object The snapped primitive or feature.
 * @property {Cartesian3} position The world-space position of the snap point, un-projected from the snap framebuffer's eye-space depth.
 * @property {Cartesian2} screenPosition The window coordinates of the snap point.
 * @property {boolean} isEdge <code>true</code> if the snap point lies on an edge; <code>false</code> if it lies on a surface.
 *
 * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
 */

/**
 * One renderer initialization attempt recorded while a scene context is created.
 *
 * @typedef {object} RendererAttemptDiagnostic
 * @property {("webgl"|"webgpu"|"webgpu-compat")} renderer The renderer attempted.
 * @property {("succeeded"|"failed")} status Whether the attempt succeeded.
 * @property {("availability"|"adapter"|"device"|"context"|"unknown")} [stage] The stage at which the attempt failed.
 * @property {string} [message] A diagnostic message for a failed attempt.
 */

/**
 * The WebGPU-to-WebGL fallback recorded while a scene context is created.
 *
 * @typedef {object} RendererFallbackDiagnostic
 * @property {("webgpu"|"webgpu-compat")} fromRenderer The renderer that failed.
 * @property {("availability"|"adapter"|"device"|"context"|"unknown")} stage The stage at which fallback occurred.
 * @property {string} message The fallback diagnostic message.
 */

/**
 * Diagnostics describing renderer selection and context creation for a scene.
 *
 * @typedef {object} ContextCreationDiagnostics
 * @property {("webgl"|"webgpu"|"webgpu-compat"|"auto")} requestedRenderer The requested renderer mode.
 * @property {("webgl"|"webgpu"|"webgpu-compat"|null)} resolvedRenderer The selected concrete renderer, or <code>null</code> when none succeeded.
 * @property {("explicit"|"auto-webgpu-first"|"auto-webgl-only"|"auto-build-webgl-only"|"auto-build-webgpu-only")} selectionReason Why this renderer selection path was used.
 * @property {ReadonlyArray<RendererAttemptDiagnostic>} attempts The renderer initialization attempts.
 * @property {(RendererFallbackDiagnostic|null)} fallback The WebGPU-to-WebGL fallback, or <code>null</code> when no fallback occurred.
 */

/**
 * The container for all 3D graphical objects and state in a Cesium virtual scene.  Generally,
 * a scene is not created directly; instead, it is implicitly created by {@link CesiumWidget}.
 *
 * @alias Scene
 *
 * @see CesiumWidget
 * @see {@link http://www.khronos.org/registry/webgl/specs/latest/#5.2|WebGLContextAttributes}
 *
 * @example
 * // Create scene without anisotropic texture filtering
 * const scene = new Cesium.Scene({
 *   canvas : canvas,
 *   contextOptions : {
 *     allowTextureFilterAnisotropic : false
 *   }
 * });
 */
class Scene {
  /**
   * Use this to set the default value for {@link Scene#logarithmicDepthBuffer} in newly constructed Scenes
   * This property relies on fragmentDepth being supported.
   */
  static defaultLogDepthBuffer = true;

  /**
   * @param {object} options Object with the following properties:
   * @param {HTMLCanvasElement} options.canvas The HTML canvas element to create the scene for.
   * @param {ContextOptions} [options.contextOptions] Context and WebGL creation properties.
   * @param {Element} [options.creditContainer] The HTML element in which the credits will be displayed. If not specified, a credit container will be created and added as a sibling of the canvas.
   * @param {Element} [options.creditViewport] The HTML element in which to display the credit popup.  If not specified, the viewport will be added as a sibling of the canvas.
   * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.default] The default ellipsoid. If not specified, the default ellipsoid is used.
   * @param {MapProjection} [options.mapProjection=new GeographicProjection(options.ellipsoid)] The map projection to use in 2D and Columbus View modes.
   * @param {boolean} [options.orderIndependentTranslucency=true] If true and the configuration supports it, use order independent translucency.
   * @param {boolean} [options.scene3DOnly=false] If true, optimizes memory use and performance for 3D mode but disables the ability to use 2D or Columbus View.
   * @param {boolean} [options.shadows=false] Determines if shadows are cast by light sources.
   * @param {MapMode2D} [options.mapMode2D=MapMode2D.INFINITE_SCROLL] Determines if the 2D map is rotatable or can be scrolled infinitely in the horizontal direction.
   * @param {boolean} [options.requestRenderMode=false] If true, rendering a frame will only occur when needed as determined by changes within the scene. Enabling improves performance of the application, but requires using {@link Scene#requestRender} to render a new frame explicitly in this mode. This will be necessary in many cases after making changes to the scene in other parts of the API. See {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}.
   * @param {number} [options.maximumRenderTimeChange=0.0] If requestRenderMode is true, this value defines the maximum change in simulation time allowed before a render is requested. See {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}.
   * @param {number} [options.depthPlaneEllipsoidOffset=0.0] Adjust the DepthPlane to address rendering artefacts below ellipsoid zero elevation.
   * @param {number} [options.msaaSamples=4] If provided, this value controls the rate of multisample antialiasing. Typical multisampling rates are 2, 4, and sometimes 8 samples per pixel. Higher sampling rates of MSAA may impact performance in exchange for improved visual quality. This value only applies to WebGL2 contexts that support multisample render targets. Set to 1 to disable MSAA.
   * @param {CelestialEphemerisProvider} [options.celestialEphemerisProvider] A ready synchronous Sun/Moon ephemeris provider. A per-Scene {@link Simon1994EphemerisProvider} is used by default.
   *
   * @exception {DeveloperError} options and options.canvas are required.
   */
  constructor(options) {
    // Establish the fields that construction rollback needs before doing any
    // work that can throw. Scene initialization is intentionally kept in a
    // separate method so the constructor can retain the partially-built
    // instance and release every ownership edge before rethrowing the original
    // error. In particular, this covers failures after the process-wide
    // RequestScheduler/TaskProcessor listeners have been installed.
    this._context = undefined;
    this._frameState = undefined;
    this._tweens = undefined;
    this._hdrFallbackUnsub = null;
    this._asyncResourceUnsub = null;
    this._featureRendererReadinessUnsub = null;
    this._removeRequestListenerCallback = undefined;
    this._removeTaskProcessorListenerCallback = undefined;
    this._removeGlobeCallbacks = [];
    this._removeCreditContainer = false;
    this._creditContainer = undefined;
    this._canvas = undefined;

    try {
      this._initialize(options);
    } catch (error) {
      destroySceneResources(this);
      throw error;
    }
  }

  /**
   * Initializes a Scene after the constructor has established rollback-safe
   * sentinels.
   *
   * @param {object} options Scene construction options.
   * @private
   */
  _initialize(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const canvas = options.canvas;
    let creditContainer = options.creditContainer;
    let creditViewport = options.creditViewport;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("options and options.canvas are required.");
    }
    //>>includeEnd('debug');

    // Synchronous construction is deliberately WebGL-only. Renderer policies
    // that may initialize WebGPU or fall back between backends must go through
    // createAsync so context creation has a real transactional boundary.
    if (!defined(options._preInitializedContext)) {
      getSynchronousRendererType(options.contextOptions ?? Frozen.EMPTY_OBJECT);
    }

    // Check for a pre-initialized context from the async factory. The context
    // is created against this exact canvas, then transferred into the final
    // Scene; no temporary Scene or compatibility context is constructed.
    let countReferences = options._countContextReferences ?? false;
    if (defined(options._preInitializedContext)) {
      this._context = options._preInitializedContext;
    } else {
      countReferences = options.contextOptions instanceof SharedContext;
      if (countReferences) {
        this._context = options.contextOptions.createSceneContext(canvas);
      } else {
        const contextOptions = clone(options.contextOptions);
        this._context = new Context(canvas, contextOptions);
      }
    }
    const context = this._context;
    this._contextCreationDiagnostics =
      options._contextCreationDiagnostics ??
      Object.freeze({
        requestedRenderer: RendererType.WEBGL,
        resolvedRenderer: RendererType.WEBGL,
        selectionReason: "explicit",
        attempts: Object.freeze([
          Object.freeze({
            renderer: RendererType.WEBGL,
            status: "succeeded",
          }),
        ]),
        fallback: null,
      });

    // Worker-safe headless mode: when running inside a Web Worker
    // (DedicatedWorkerGlobalScope), `document` does not exist and
    // `OffscreenCanvas` has no `parentNode`. The Scene + CreditDisplay
    // pair detects this and skips all DOM construction. The credit
    // container is replaced with a sentinel `{}` so CreditDisplay's
    // `Check.defined("container", ...)` guard still passes; the
    // CreditDisplay constructor sees `typeof document === "undefined"`
    // and short-circuits all DOM ops itself.
    const headless =
      typeof document === "undefined" ||
      !canvas ||
      typeof canvas.parentNode === "undefined" ||
      canvas.parentNode === null;

    const hasCreditContainer = defined(creditContainer);
    if (!hasCreditContainer) {
      if (headless) {
        // Provide a sentinel object so CreditDisplay's defined-check
        // passes; CreditDisplay will not actually call appendChild on it.
        creditContainer = {};
      } else {
        creditContainer = document.createElement("div");
        creditContainer.style.position = "absolute";
        creditContainer.style.bottom = "0";
        creditContainer.style["text-shadow"] = "0 0 2px #000000";
        creditContainer.style.color = "#ffffff";
        creditContainer.style["font-size"] = "10px";
        creditContainer.style["padding-right"] = "5px";
        canvas.parentNode.appendChild(creditContainer);
      }
    }
    if (!defined(creditViewport)) {
      creditViewport = headless ? {} : canvas.parentNode;
    }

    // Publish DOM ownership before CreditDisplay/FrameState construction so a
    // failure inside either constructor can still remove the generated credit
    // container. The caller-owned canvas is never removed by rollback.
    this._canvas = canvas;
    this._removeCreditContainer = !hasCreditContainer;
    this._creditContainer = creditContainer;

    this._id = createGuid();
    this._jobScheduler = new JobScheduler();
    this._controllerHost = new ControllerHost();
    this._frameState = new FrameState(
      context,
      new CreditDisplay(creditContainer, "•", creditViewport),
      this._jobScheduler,
    );
    this._frameState.scene3DOnly = options.scene3DOnly ?? false;
    const usesImplicitCelestialEphemerisProvider = !defined(
      options.celestialEphemerisProvider,
    );
    const celestialEphemerisProvider = usesImplicitCelestialEphemerisProvider
      ? new Simon1994EphemerisProvider()
      : options.celestialEphemerisProvider;
    if (typeof celestialEphemerisProvider?.then === "function") {
      throw new DeveloperError(
        "celestialEphemerisProvider must be ready; await asynchronous provider creation before constructing Scene.",
      );
    }
    Check.defined("celestialEphemerisProvider", celestialEphemerisProvider);
    Check.typeOf.func(
      "celestialEphemerisProvider.compute",
      celestialEphemerisProvider.compute,
    );
    this._celestialEphemerisProvider = celestialEphemerisProvider;
    this._activeCelestialEphemerisProvider = celestialEphemerisProvider;
    this._celestialEphemerisProviderIsImplicit =
      usesImplicitCelestialEphemerisProvider;
    this._activeCelestialEphemerisProviderIsImplicit =
      usesImplicitCelestialEphemerisProvider;
    this._implicitCelestialEphemerisProvider =
      usesImplicitCelestialEphemerisProvider
        ? celestialEphemerisProvider
        : undefined;
    this._celestialEphemerisProviderSetFrameNumber = undefined;
    this._celestialEphemerisTransformFrameNumber = undefined;
    this._activeCelestialEphemerisLegacyTransformActive = false;
    this._activeCelestialEphemerisLegacyTransform = undefined;
    this._computeEngine = new ComputeEngine(context);

    this._ellipsoid = options.ellipsoid ?? Ellipsoid.default;
    this._globe = undefined;
    this._globeTranslucencyState = new GlobeTranslucencyState();
    this._primitives = new PrimitiveCollection({ countReferences });
    this._groundPrimitives = new PrimitiveCollection({ countReferences });

    this._globeHeight = undefined;
    this._globeHeightDirty = true;
    this._cameraUnderground = false;
    this._removeUpdateHeightCallback = undefined;

    this._logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth;
    this._logDepthBufferDirty = true;

    this._tweens = new TweenCollection();

    this._shaderFrameCount = 0;

    this._sunPostProcess = undefined;

    this._computeCommandList = [];
    this._overlayCommandList = [];

    this._useOIT = options.orderIndependentTranslucency ?? true;
    /**
     * The function that will be used for executing translucent commands when
     * useOIT is true. This is created once in
     * obtainTranslucentCommandExecutionFunction, then cached here.
     * @private
     */
    this._executeOITFunction = undefined;

    this._depthPlane = new DepthPlane(options.depthPlaneEllipsoidOffset);

    this._clearColorCommand = new ClearCommand({
      color: new Color(),
      stencil: 0,
      owner: this,
    });
    this._depthClearCommand = new ClearCommand({
      depth: 1.0,
      owner: this,
    });
    this._stencilClearCommand = new ClearCommand({
      stencil: 0,
    });
    this._classificationStencilClearCommand = new ClearCommand({
      stencil: 0,
      renderState: RenderState.fromCache({
        stencilMask: StencilConstants.CLASSIFICATION_MASK,
      }),
    });

    this._depthOnlyRenderStateCache = {};

    // Backend-specific scene renderer — handles multi-frustum command execution.
    // Created from the SCENE_RENDERER feature renderer if registered (e.g., WebGPU).
    // This keeps Scene.js free of direct WebGPU imports.
    this._alternateSceneRenderer = null;
    const sceneRendererFR = context.getFeatureRenderer(
      FeatureRendererKey.SCENE_RENDERER,
    );
    if (sceneRendererFR && sceneRendererFR.RendererClass) {
      this._alternateSceneRenderer = new sceneRendererFR.RendererClass();
      console.log(
        `[Scene:${context.rendererType}] ` +
          `alternate scene renderer CREATED — ` +
          `FR_KEY=${FeatureRendererKey.SCENE_RENDERER} ` +
          `contextId=${context.id ?? "?"}`,
      );
    } else if (context.requiresSceneRenderer) {
      // A context that requires an alternate scene renderer also delegates
      // canvas blitting and post-process composition to it. Without that
      // renderer, the context cannot present the scene.
      console.error(
        `[Scene:${context.rendererType}] CRITICAL — scene renderer NOT CREATED. ` +
          `SCENE_RENDERER FR not found (key=${FeatureRendererKey.SCENE_RENDERER}). ` +
          `Canvas will be BLACK. ` +
          `getFeatureRenderer=${typeof context.getFeatureRenderer} ` +
          `frResult=${!!sceneRendererFR}`,
      );
    }
    // WebGL scenes don't use _alternateSceneRenderer — they run the
    // traditional executeCommand path in SceneRenderer.js. No log needed.

    // Keep this scene's canvas-output state synchronized when extended tone
    // mapping configuration fails and the context falls back to SDR. Each
    // scene registers independently because a context may be shared by
    // multiple scenes.
    this._hdrFallbackUnsub = null;
    if (
      defined(context) &&
      typeof context.setHDRFallbackListener === "function"
    ) {
      this._hdrFallbackUnsub = context.setHDRFallbackListener((newValue) => {
        if (this._useHDRCanvasOutput && !newValue) {
          this._useHDRCanvasOutput = false;
        }
      });
    }

    // Subscribe when the context exposes asynchronous resources so a resolved
    // pipeline, shader, or texture request wakes a request-render scene. The
    // pending-resource check below also keeps rendering active while
    // foreground work remains.
    this._asyncResourceUnsub = null;
    const asyncResources = context?.asyncResources;
    if (
      defined(asyncResources) &&
      typeof asyncResources.subscribe === "function"
    ) {
      // Pass the scene identifier so owned work wakes only its scene. Tokens
      // without owners represent resources shared by every scene on the
      // context and notify every subscriber.
      this._asyncResourceUnsub = asyncResources.subscribe(
        (event) => {
          if (event.kind !== "resolved") {
            return;
          }
          this.requestRender();
        },
        { sceneId: this._id },
      );
    }

    // Lazy feature-module readiness is a separate state machine from GPU
    // resource preparation. Wake request-render scenes when a renderer module
    // installs so they cannot hibernate with a compatibility/placeholder
    // frame still on screen.
    this._featureRendererReadinessUnsub = null;
    if (typeof context?.subscribeFeatureRendererReadiness === "function") {
      this._featureRendererReadinessUnsub =
        context.subscribeFeatureRendererReadiness((_key, state) => {
          if (state.kind === "ready") {
            this.requestRender();
          }
        });
    }

    /**
     * Manages layered sorting, material batching, and predictive sort
     * queries for scene commands.
     * @type {RenderScheduler}
     * @private
     */
    this._renderScheduler = new RenderScheduler();

    // Size the octree root from the scene ellipsoid so non-Earth bodies retain
    // valid bounds.
    this._renderScheduler.octree.rootHalfExtent =
      this._ellipsoid.maximumRadius * 1.1;

    // GPU culling, Hi-Z, and sorting map results back to CPU command arrays and
    // therefore remain disabled by default. Publish the policy before the
    // first frame so lazy culler access cannot allocate those resources.
    this._gpuCullingHint = "never";
    if (typeof context.setGpuCullingHint === "function") {
      context.setGpuCullingHint("never");
    }

    this._transitioner = new SceneTransitioner(this);

    this._preUpdate = new Event();
    this._postUpdate = new Event();

    this._renderError = new Event();
    this._preRender = new Event();
    this._postRender = new Event();

    this._minimumDisableDepthTestDistance = 0.0;
    this._debugInspector = new DebugInspector();

    this._msaaSamples = options.msaaSamples ?? 4;

    /**
     * Exceptions occurring in <code>render</code> are always caught in order to raise the
     * <code>renderError</code> event.  If this property is true, the error is rethrown
     * after the event is raised.  If this property is false, the <code>render</code> function
     * returns normally after raising the event.
     *
     * @type {boolean}
     * @default false
     */
    this.rethrowRenderErrors = false;

    /**
     * Determines whether or not to instantly complete the
     * scene transition animation on user input.
     *
     * @type {boolean}
     * @default true
     */
    this.completeMorphOnUserInput = true;

    /**
     * The event fired at the beginning of a scene transition.
     * @type {Event}
     * @default Event()
     */
    this.morphStart = new Event();

    /**
     * The event fired at the completion of a scene transition.
     * @type {Event}
     * @default Event()
     */
    this.morphComplete = new Event();

    /**
     * The {@link SkyBox} used to draw the stars.
     *
     * @type {SkyBox | undefined}
     * @default undefined
     *
     * @see Scene#backgroundColor
     */
    this.skyBox = undefined;

    /**
     * The sky atmosphere drawn around the globe.
     *
     * @type {SkyAtmosphere | undefined}
     * @default undefined
     */
    this.skyAtmosphere = undefined;

    /**
     * The {@link Sun}.
     *
     * @type {Sun | undefined}
     * @default undefined
     */
    this.sun = undefined;

    /**
     * Uses a bloom filter on the sun when enabled.
     *
     * @type {boolean}
     * @default true
     */
    this.sunBloom = true;
    this._sunBloom = undefined;

    /**
     * The {@link Moon}
     *
     * @type {Moon | undefined}
     * @default undefined
     */
    this.moon = undefined;

    /**
     * The background color, which is only visible if there is no sky box, i.e., {@link Scene#skyBox} is <code>undefined</code>.
     *
     * @type {Color}
     * @default {@link Color.BLACK}
     *
     * @see Scene#skyBox
     */
    this.backgroundColor = Color.clone(Color.BLACK);

    this._mode = SceneMode.SCENE3D;

    this._mapProjection = defined(options.mapProjection)
      ? options.mapProjection
      : new GeographicProjection(this._ellipsoid);

    /**
     * The current morph transition time between 2D/Columbus View and 3D,
     * with 0.0 being 2D or Columbus View and 1.0 being 3D.
     *
     * @type {number}
     * @default 1.0
     */
    this.morphTime = 1.0;

    /**
     * The far-to-near ratio of the multi-frustum when using a normal depth buffer.
     * <p>
     * This value is used to create the near and far values for each frustum of the multi-frustum. It is only used
     * when {@link Scene#logarithmicDepthBuffer} is <code>false</code>. When <code>logarithmicDepthBuffer</code> is
     * <code>true</code>, use {@link Scene#logarithmicDepthFarToNearRatio}.
     * </p>
     *
     * @type {number}
     * @default 1000.0
     */
    this.farToNearRatio = 1000.0;

    /**
     * The far-to-near ratio of the multi-frustum when using a logarithmic depth buffer.
     * <p>
     * This value is used to create the near and far values for each frustum of the multi-frustum. It is only used
     * when {@link Scene#logarithmicDepthBuffer} is <code>true</code>. When <code>logarithmicDepthBuffer</code> is
     * <code>false</code>, use {@link Scene#farToNearRatio}.
     * </p>
     *
     * @type {number}
     * @default 1e9
     */
    this.logarithmicDepthFarToNearRatio = 1e9;

    /**
     * Determines the uniform depth size in meters of each frustum of the multifrustum in 2D. If a primitive or model close
     * to the surface shows z-fighting, decreasing this will eliminate the artifact, but decrease performance. On the
     * other hand, increasing this will increase performance but may cause z-fighting among primitives close to the surface.
     *
     * @type {number}
     * @default 1.75e6
     */
    this.nearToFarDistance2D = 1.75e6;

    /**
     * The vertical exaggeration of the scene.
     * When set to 1.0, no exaggeration is applied.
     *
     * @type {number}
     * @default 1.0
     */
    this.verticalExaggeration = 1.0;

    /**
     * The reference height for vertical exaggeration of the scene.
     * When set to 0.0, the exaggeration is applied relative to the ellipsoid surface.
     *
     * @type {number}
     * @default 0.0
     */
    this.verticalExaggerationRelativeHeight = 0.0;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * A function that determines what commands are executed.  As shown in the examples below,
     * the function receives the command's <code>owner</code> as an argument, and returns a boolean indicating if the
     * command should be executed.
     * </p>
     * <p>
     * The default is <code>undefined</code>, indicating that all commands are executed.
     * </p>
     *
     * @type {Function | undefined}
     *
     * @default undefined
     *
     * @example
     * // Do not execute any commands.
     * scene.debugCommandFilter = function(command) {
     *     return false;
     * };
     *
     * // Execute only the billboard's commands.  That is, only draw the billboard.
     * const billboards = new Cesium.BillboardCollection();
     * scene.debugCommandFilter = function(command) {
     *     return command.owner === billboards;
     * };
     */
    this.debugCommandFilter = undefined;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, commands are randomly shaded.  This is useful
     * for performance analysis to see what parts of a scene or model are
     * command-dense and could benefit from batching.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowCommands = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, commands are shaded based on the frustums they
     * overlap.  Commands in the closest frustum are tinted red, commands in
     * the next closest are green, and commands in the farthest frustum are
     * blue.  If a command overlaps more than one frustum, the color components
     * are combined, e.g., a command overlapping the first two frustums is tinted
     * yellow.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowFrustums = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * Displays frames per second and time between frames.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowFramesPerSecond = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * Indicates which frustum will have depth information displayed.
     * </p>
     *
     * @type {number}
     *
     * @default 1
     */
    this.debugShowDepthFrustum = 1;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, draws outlines to show the boundaries of the camera frustums
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowFrustumPlanes = false;
    this._debugShowFrustumPlanes = false;
    this._debugFrustumPlanes = undefined;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, the globe surface renderer overlays a wireframe
     * (line-list) version of each terrain tile instead of the shaded surface.
     * Useful for diagnosing tile boundaries, LOD transitions, mesh density,
     * and culling/refinement bugs without leaving the running scene.
     * </p>
     * <p>
     * The WebGPU wireframe pipeline uses the same vertex layout as the
     * production terrain pipeline, including quantization, normals,
     * WebMercator coordinates, and stride. Other contexts ignore this flag.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowGlobeWireframe = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, the WebGPU sky atmosphere renderer skips the
     * Rayleigh + Mie scattering integral and emits a flat magenta color
     * over the atmosphere shell. Useful for isolating whether a sky-color
     * bug lives in the scattering math, the LUT inputs, or the
     * post-process composite — magenta confirms only that the draw call,
     * ray-sphere intersection, and shell coverage are reaching the
     * fragment stage.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugDisableAtmosphereScattering = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When set to a value 1-6, the WebGPU skybox / cubemap panorama renderer
     * isolates a single cubemap face and discards fragments belonging to
     * the other five. Useful for verifying cubemap face data, orientation,
     * and resource bindings without leaving the running scene or pulling
     * the texture into an external tool.
     * </p>
     * <p>
     * Encoding: 0 = all faces (production), 1 = +X, 2 = -X, 3 = +Y,
     * 4 = -Y, 5 = +Z, 6 = -Z. Any other value behaves like 0.
     * </p>
     *
     * @type {number}
     *
     * @default 0
     */
    this.debugShowCubeMapFace = 0;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, the WebGPU globe surface renderer tints each
     * terrain tile by its LOD depth level using a 12-color palette. Levels
     * 0..11 cycle through hues; levels above 11 wrap. Useful for visually
     * confirming tile refinement, culling boundaries, and screen-space
     * error decisions.
     * </p>
     * <p>
     * Mutually exclusive with {@link Scene#debugShowTriangulation} and
     * {@link Scene#debugShowTerrainNormals}; the renderer picks one
     * fragment variant per frame.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowTerrainLOD = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, the WebGPU globe surface renderer outputs
     * the eye-space surface normal as RGB color (remapped from [-1,1]
     * to [0,1]). Useful for verifying that vertex normals are interpolating
     * correctly through the normal-map shader chain.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowTerrainNormals = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When set to a non-negative integer 0..3, the WebGPU globe surface
     * renderer renders only that imagery layer slot in the multi-layer
     * composite, hiding the other layers. -1 (default) restores
     * production behavior with all layers blended.
     * </p>
     * <p>
     * Note: the index refers to the *per-pass* layer slot, not the
     * absolute imagery layer index in `Globe.imageryLayers`. Tiles with
     * more than 4 imagery layers split into multiple passes; layer 0 of
     * the second pass is layer 4 of the imagery collection.
     * </p>
     *
     * @type {number}
     *
     * @default -1
     */
    this.debugShowImageryLayer = -1;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When set to <code>true</code>, the WebGPU globe surface renderer
     * logs the next four tile updates with their imagery diagnostics,
     * including encoding, stride, readiness, texture coordinates,
     * translation and scale, and sample vertex coordinates. The flag latches
     * after four updates; toggle it off and on to start another capture.
     * </p>
     * <p>
     * Off by default; the diagnostic does nothing in normal renders.
     * </p>
     *
     * @type {boolean}
     * @default false
     */
    this.debugShowImageryProbe = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, the WebGPU scene renderer replaces the
     * production post-process chain with a fullscreen depth visualization
     * pass. Linearized depth is rendered as grayscale, useful for
     * z-fighting diagnostics, depth-precision analysis at the horizon,
     * and verifying terrain vs 3D Tiles depth values.
     * </p>
     * <p>
     * Requires a single-sample (non-MSAA) scene framebuffer — multisampled
     * depth textures cannot be sampled in WGSL. The overlay logs a warning
     * once and skips the pass when MSAA is enabled.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowDepthAsColor = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * Selects the visualization mode used by {@link Scene#debugShowDepthAsColor}.
     * 0 = linearized grayscale (default, best for distance precision).
     * 1 = raw NDC grayscale (best for buffer-precision tier diagnosis).
     * 2 = combined R=linear G=raw (compare both at once).
     * </p>
     *
     * @type {number}
     *
     * @default 0
     */
    this.debugDepthAsColorMode = 0;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * Eye-space distance window (meters) for the depth-as-color overlay. When
     * <code>debugDepthWindowMax &gt; debugDepthWindowMin</code>, the overlay
     * (modes 3/4) spends the full color range on the linear-eye-z band
     * <code>[min, max]</code> instead of the whole <code>[near, far]</code>
     * range — so two near-identical depths (e.g. a building at 188.1 m vs the
     * terrain under it at 188.4 m) become distinct hues. Use
     * {@link CesiumDebug#showDepthWindow}. Disabled when max &le; min.
     * </p>
     * @type {number}
     * @default 0
     */
    this.debugDepthWindowMin = 0.0;
    /** @see Scene#debugDepthWindowMin @type {number} @default 0 */
    this.debugDepthWindowMax = 0.0;
    /**
     * Use the Turbo colormap (vs grayscale) for the windowed depth overlay.
     * @type {boolean}
     * @default true
     */
    this.debugDepthWindowTurbo = true;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code>, omits the ellipsoid depth plane used with
     * <code>clearGlobeDepth</code>. The plane prevents primitives behind the
     * globe from being picked, and skipping it isolates whether its depth
     * writes occlude terrain-flush content. Use
     * {@link CesiumDebug#skipDepthPlane}.
     * </p>
     * @type {boolean}
     * @default false
     */
    this.debugSkipDepthPlane = false;

    /**
     * This property is for debugging only; it is not for production use.
     * <p>
     * When <code>true</code> and the active rendering context is WebGPU with
     * `@builtin(primitive_index)` support, feature renderers that opt in
     * (terrain, polygon collections, batched models) will switch their
     * fragment shader to a per-triangle "rainbow" debug variant. This makes
     * tile triangulation, polygon earcut output, and mesh structure visible
     * without an extra debug pass.
     * </p>
     * <p>
     * Has no effect on WebGL — `gl_PrimitiveID` requires a geometry shader,
     * which WebGL2 doesn't expose. Has no effect on WebGPU implementations
     * that fail the {@link WebGPUPrimitiveIndexUtils.isSupported} probe.
     * </p>
     *
     * @type {boolean}
     *
     * @default false
     */
    this.debugShowTriangulation = false;

    /**
     * When <code>true</code>, enables picking using the depth buffer.
     *
     * @type {boolean}
     * @default true
     */
    this.useDepthPicking = true;

    /**
     * When <code>true</code>, enables picking translucent geometry using the depth buffer. Note that {@link Scene#useDepthPicking} must also be true for enabling this to work.
     *
     * <p>
     * There is a decrease in performance when enabled. There are extra draw calls to write depth for
     * translucent geometry.
     * </p>
     *
     * @example
     * // picking the position of a translucent primitive
     * viewer.screenSpaceEventHandler.setInputAction(function onLeftClick(movement) {
     *      const pickedFeature = viewer.scene.pick(movement.position);
     *      if (!Cesium.defined(pickedFeature)) {
     *          // nothing picked
     *          return;
     *      }
     *      const worldPosition = viewer.scene.pickPosition(movement.position);
     * }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
     *
     * @type {boolean}
     * @default false
     */
    this.pickTranslucentDepth = false;

    /**
     * The time in milliseconds to wait before checking if the camera has not moved and fire the cameraMoveEnd event.
     * @type {number}
     * @default 500.0
     * @private
     */
    this.cameraEventWaitTime = 500.0;

    /**
     * Settings for atmosphere lighting effects affecting 3D Tiles and model rendering. This is not to be confused with
     * {@link Scene#skyAtmosphere} which is responsible for rendering the sky.
     *
     * @type {Atmosphere}
     */
    this.atmosphere = new Atmosphere();

    /**
     * Blends the atmosphere to geometry far from the camera for horizon views. Allows for additional
     * performance improvements by rendering less geometry and dispatching less terrain requests.
     *
     * Disbaled by default if an ellipsoid other than WGS84 is used.
     * @type {Fog}
     */
    this.fog = new Fog();
    this.fog.enabled = Ellipsoid.WGS84.equals(this._ellipsoid);

    if (!Ellipsoid.WGS84.equals(this._ellipsoid)) {
      Camera.DEFAULT_VIEW_RECTANGLE = Rectangle.fromDegrees(
        -45.0,
        -45.0,
        45.0,
        45.0,
      );
    }

    this._shadowMapCamera = new Camera(this);

    /**
     * The shadow map for the scene's light source. When enabled, models, primitives, and the globe may cast and receive shadows.
     * @type {ShadowMap}
     */
    this.shadowMap = new ShadowMap({
      context: context,
      lightCamera: this._shadowMapCamera,
      enabled: options.shadows ?? false,
      // `cascadesEnabled` stays at its default `true` on both backends. It does
      // not merely pick a pass count: it selects the whole directional-light
      // lifecycle — the orthographic light frustum, `fitShadowMapToScene`, the
      // below-horizon cull, terminator darkness fade, and the every-frame
      // `_needsUpdate`. Turning it off makes `ShadowMap` treat this scene's
      // `_shadowMapCamera` as a spot light, and `Scene` only ever writes that
      // camera's `.direction` (see `updateAndExecuteCommands`), so the light
      // would sit at a default camera position with a 60-degree perspective
      // frustum. Backends that own cascades natively instead publish the fitted
      // whole-frustum light camera through pass 0 in `ShadowMap.update`, gated
      // on `context.managesSceneShadowCascadesNatively`.
    });

    /**
     * When <code>false</code>, 3D Tiles will render normally. When <code>true</code>, classified 3D Tile geometry will render normally and
     * unclassified 3D Tile geometry will render with the color multiplied by {@link Scene#invertClassificationColor}.
     * @type {boolean}
     * @default false
     */
    this.invertClassification = false;

    /**
     * When <code>true</code>, WebGPU runs the depth-derived normal producer
     * and writes eye-space normals to
     * <code>view.gBufferFramebuffer</code>. WebGL ignores this option.
     *
     * @type {boolean}
     * @default false
     */
    this.deferredLighting = false;

    /**
     * Displays
     * <code>view.gBufferFramebuffer.normalRoughnessTexture</code> as a
     * normal-map visualization. Enable {@link Scene#deferredLighting} to
     * populate the depth-derived G-buffer; enabling only this overlay uses the
     * magenta missing-producer fallback. WebGL ignores this option.
     *
     * @type {boolean}
     * @default false
     */
    this.debugShowGBufferNormals = false;

    /**
     * The highlight color of unclassified 3D Tile geometry when {@link Scene#invertClassification} is <code>true</code>.
     * <p>When the color's alpha is less than 1.0, the unclassified portions of the 3D Tiles will not blend correctly with the classified positions of the 3D Tiles.</p>
     * <p>Also, when the color's alpha is less than 1.0, the WEBGL_depth_texture and EXT_frag_depth WebGL extensions must be supported.</p>
     * @type {Color}
     * @default Color.WHITE
     */
    this.invertClassificationColor = Color.clone(Color.WHITE);

    this._actualInvertClassificationColor = Color.clone(
      this._invertClassificationColor,
    );
    this._invertClassification = new InvertClassification();

    /**
     * The focal length for use when with cardboard or WebVR.
     * @type {number}
     */
    this.focalLength = undefined;

    /**
     * The eye separation distance in meters for use with cardboard or WebVR.
     * @type {number}
     */
    this.eyeSeparation = undefined;

    /**
     * Post processing effects applied to the final render.
     * @type {PostProcessStageCollection}
     */
    this.postProcessStages = new PostProcessStageCollection();

    this._enableSSR = false;

    // Requests the WebGPU outline pass, which uses scene depth and eye-space
    // normals to paint silhouette and crease edges. It is opt-in because hard
    // outlines conflict with the photorealistic globe presentation. WebGL
    // ignores the option.
    this._enableNPROutlines = false;

    // Requests screen-space contact shadows using scene depth, eye-space
    // normals, and the Sun direction. WebGL ignores the option.
    this._enableContactShadows = false;

    // Requests WebGPU clustered-light bounds and assignment passes when the
    // scene has punctual lights, with their storage buffers exposed to
    // participating material pipelines. WebGL ignores the option.
    this._clusteredLightingEnabled = false;
    this._enableWeather = false;
    this._weatherType = 0;
    this._weatherIntensity = 0.5;
    this._weatherWindSpeed = 10.0;
    this._weatherWindDirection = { x: 0.7, y: 0.3 };

    this._brdfLutGenerator = new BrdfLutGenerator();

    this._performanceDisplay = undefined;
    this._debugVolume = undefined;

    // Keep the resolved solar-glare appearance per scene so concurrent scenes
    // never share mutable scratch state.
    this._solarGlareAppearance = undefined;

    this._screenSpaceCameraController = new ScreenSpaceCameraController(this);
    this._cameraUnderground = false;
    this._mapMode2D = options.mapMode2D ?? MapMode2D.INFINITE_SCROLL;

    // Keeps track of the state of a frame. FrameState is the state across
    // the primitives of the scene. This state is for internally keeping track
    // of celestial and environment effects that need to be updated/rendered in
    // a certain order as well as updating/tracking framebuffer usage.
    this._environmentState = {
      skyBoxCommand: undefined,
      starFieldCommand: undefined,
      skyAtmosphereCommand: undefined,
      sunDrawCommand: undefined,
      sunComputeCommand: undefined,
      moonCommand: undefined,

      isSunVisible: false,
      isMoonVisible: false,
      isReadyForAtmosphere: false,
      isSkyAtmosphereVisible: false,

      clearGlobeDepth: false,
      // Reuse this private options object for Moon.update so the frame handoff
      // remains allocation-free.
      moonDepthRouteState: {
        clearGlobeDepth: false,
      },
      useDepthPlane: false,
      renderTranslucentDepthForPick: false,

      originalFramebuffer: undefined,
      useGlobeDepthFramebuffer: false,
      useOIT: false,
      useInvertClassification: false,
      usePostProcess: false,
      usePostProcessSelected: false,
      useWebVR: false,
    };

    this._useWebVR = false;
    this._cameraVR = undefined;
    this._aspectRatioVR = undefined;

    /**
     * When <code>true</code>, rendering a frame will only occur when needed as determined by changes within the scene.
     * Enabling improves performance of the application, but requires using {@link Scene#requestRender}
     * to render a new frame explicitly in this mode. This will be necessary in many cases after making changes
     * to the scene in other parts of the API.
     *
     * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
     * @see Scene#maximumRenderTimeChange
     * @see Scene#requestRender
     *
     * @type {boolean}
     * @default false
     */
    this.requestRenderMode = options.requestRenderMode ?? false;
    this._renderRequested = true;

    /**
     * When true, Temporal Anti-Aliasing replaces FXAA as the primary
     * anti-aliasing method. TAA accumulates jittered frames into a
     * history buffer for sub-pixel quality, at the cost of one frame
     * of latency and potential ghosting on fast-moving objects.
     *
     * Disables MSAA when active (the two are incompatible).
     *
     * @type {boolean}
     * @default false
     */
    this.taaEnabled = options.taaEnabled ?? false;

    /**
     * When <code>true</code>, WebGPU applies motion blur using geometry
     * velocity for object motion and depth reprojection for camera motion. The
     * disabled path does not instantiate the effect. WebGL ignores this
     * option.
     *
     * @type {boolean}
     * @default false
     */
    this.motionBlur = options.motionBlur ?? false;

    /**
     * When <code>true</code>, WebGPU applies depth-correct atmospheric
     * extinction and inscatter across terrain, 3D Tiles, models, and geometry.
     * The globe's local distance-haze drape is disabled to avoid applying haze
     * twice, while the sky shell remains independent. WebGL ignores this
     * option.
     *
     * @type {boolean}
     * @default false
     */
    this.aerialPerspective = options.aerialPerspective ?? false;

    /**
     * When <code>true</code> with {@link Scene#aerialPerspective}, WebGPU
     * samples a 32 &times; 32 &times; 32 Hillaire 2020 froxel volume instead
     * of evaluating the analytic atmosphere march per pixel. The post-process
     * performs one trilinear volume lookup per pixel. Both options default to
     * <code>false</code>. WebGL ignores this option.
     *
     * @type {boolean}
     * @default false
     */
    this.aerialPerspectiveFroxel = options.aerialPerspectiveFroxel ?? false;

    /**
     * When true, Cascaded Shadow Maps split the camera frustum into
     * 4 depth ranges, each rendered at full shadow map resolution.
     * Gives high-resolution shadows near the camera without
     * sacrificing far-range coverage.
     *
     * @type {boolean}
     * @default false
     */
    this.useCascadedShadowMaps = options.useCascadedShadowMaps ?? false;

    /**
     * Per-cascade texture resolution for the CSM path. Four layers of
     * `depth32float` at this resolution are allocated when CSM first
     * activates — 1024 (default) = 16 MB total, 512 = 4 MB, 2048 = 64 MB.
     * Reducing is the cheapest way to fit CSM on integrated GPUs; the
     * cascade texel density stays similar when the number of cascades
     * stays the same.
     *
     * Set this before enabling `useCascadedShadowMaps`; initialized CSM
     * resources retain their allocation settings.
     *
     * Valid range: 256..4096. Values outside the range are clamped.
     *
     * @type {number}
     * @default 1024
     */
    this.cascadedShadowMapResolution =
      options.cascadedShadowMapResolution ?? 1024;

    /**
     * When true, the CSM receive shaders soften cascade edges with a 3x3
     * PCF box kernel (matches the WebGL `softShadows` path / the single
     * shadow map's `czm_shadowVisibility` USE_SOFT_SHADOWS kernel). When
     * false, each cascade is sampled with a single hardware-comparison
     * tap, producing hard aliased shadow edges.
     *
     * Set this before enabling `useCascadedShadowMaps`; it is read during CSM
     * initialization.
     *
     * @type {boolean}
     * @default true
     */
    this.cascadedShadowMapSoftShadows =
      options.cascadedShadowMapSoftShadows ?? true;

    // This monotonic revision advances when scene-visible mutations invalidate
    // frozen render bundles. Snapshot mode compares it with the captured
    // baseline and thaws stale caches.
    this._snapshotVersion = 0;

    // The adaptive visual-quality coordinator exposes probe and sink
    // registration through VisualPerformanceTargetService and is disabled by
    // default.
    this._visualPerformanceTarget = new VisualPerformanceTargetService();

    // Freezable resources register with the snapshot-mode coordinator so their
    // caches freeze and thaw together. The snapshot revision triggers
    // invalidation.
    this._snapshotMode = new SnapshotModeService();

    // The backend-neutral performance recorder samples rendered frames only
    // while a trace is active; the inactive path is a bounded no-op.
    this._performanceTracker = new PerformanceTracker();

    // Primitive and ground-primitive collection changes advance the snapshot
    // revision so frozen bundles thaw before added or removed content can
    // become stale. Tile refinements use the same invalidation channel.
    const bumpSnapshotVersion = () => {
      this._snapshotVersion = (this._snapshotVersion ?? 0) + 1;
    };
    this._primitives.primitiveAdded.addEventListener(bumpSnapshotVersion);
    this._primitives.primitiveRemoved.addEventListener(bumpSnapshotVersion);
    this._groundPrimitives.primitiveAdded.addEventListener(bumpSnapshotVersion);
    this._groundPrimitives.primitiveRemoved.addEventListener(
      bumpSnapshotVersion,
    );

    /**
     * If {@link Scene#requestRenderMode} is <code>true</code>, this value defines the maximum change in
     * simulation time allowed before a render is requested. Lower values increase the number of frames rendered
     * and higher values decrease the number of frames rendered. If <code>undefined</code>, changes to
     * the simulation time will never request a render.
     * This value impacts the rate of rendering for changes in the scene like lighting, entity property updates,
     * and animations.
     *
     * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
     * @see Scene#requestRenderMode
     *
     * @type {number}
     * @default 0.0
     */
    this.maximumRenderTimeChange = options.maximumRenderTimeChange ?? 0.0;
    this._lastRenderTime = undefined;
    this._frameRateMonitor = undefined;

    this._removeRequestListenerCallback =
      RequestScheduler.requestCompletedEvent.addEventListener(
        requestRenderAfterFrame(this),
      );
    this._removeTaskProcessorListenerCallback =
      TaskProcessor.taskCompletedEvent.addEventListener(
        requestRenderAfterFrame(this),
      );
    this._removeGlobeCallbacks = [];
    this._removeTerrainProviderReadyListener = undefined;

    const viewport = new BoundingRectangle(
      0,
      0,
      context.drawingBufferWidth,
      context.drawingBufferHeight,
    );
    const camera = new Camera(this);

    if (this._logDepthBuffer) {
      camera.frustum.near = 0.1;
      camera.frustum.far = 10000000000.0;
    }

    /**
     * The camera view for the scene camera flight destination. Used for preloading flight destination tiles.
     * @type {Camera}
     * @private
     */
    this.preloadFlightCamera = new Camera(this);

    /**
     * The culling volume for the scene camera flight destination. Used for preloading flight destination tiles.
     * @type {CullingVolume}
     * @private
     */
    this.preloadFlightCullingVolume = undefined;

    this._picking = new Picking(this);
    this._defaultView = new View(this, camera, viewport);
    this._view = this._defaultView;

    // Deterministic late-construction failure point for transactional cleanup
    // specs. It follows creation of the process-wide listeners and default
    // View so the rollback path exercises all of their ownership edges. Debug
    // pragmas remove the hook from production bundles.
    //>>includeStart('debug', pragmas.debug);
    if (typeof options._constructionFailureForSpecs === "function") {
      options._constructionFailureForSpecs(
        "afterGlobalListenersAndDefaultView",
        this,
      );
    }
    //>>includeEnd('debug');

    this._hdr = undefined;
    this._hdrDirty = undefined;
    this.highDynamicRange = false;
    this.gamma = 2.2;

    // Begin from the SDR base state. Display capability detection may enable
    // HDR when the selected policy permits it, while an explicit application
    // assignment remains authoritative. Clear the ownership flags because the
    // constructor assignment uses the public setter.
    this._hdrUserSet = false;
    this._useHDRCanvasOutputUserSet = false;
    this._hdrDisplayPolicy = HdrDisplayPolicy.SCENE;
    this._hdrDisplayIsHdr = undefined;
    this._hdrDisplayUnsub = null;
    this._initializeHdrDisplayDetection();

    /**
     * The spherical harmonic coefficients for image-based lighting of PBR models.
     * @type {Cartesian3[]}
     */
    this.sphericalHarmonicCoefficients = undefined;

    /**
     * The url to the KTX2 file containing the specular environment map and convoluted mipmaps for image-based lighting of PBR models.
     * @type {string}
     */
    this.specularEnvironmentMaps = undefined;
    this._specularEnvironmentCubeMap = undefined;

    /**
     * The light source for shading. Defaults to a directional light from the Sun.
     * @type {Light}
     */
    this.light = new SunLight();

    // A private SunLight carries atmosphere-derived color and intensity while
    // aerial perspective is enabled so model lighting and atmospheric haze
    // remain coherent. The application-owned scene light remains unchanged,
    // and sky irradiance is published separately.
    this._atmosphereDerivedLight = new SunLight();
    this._atmosphereSkyIrradiance = new Cartesian3(0.2, 0.2, 0.2);

    /**
     * Collection of additional light sources for multi-light rendering.
     * Supports up to 8 lights (DirectionalLight, PointLight, SpotLight).
     * This is renderer-agnostic — both WebGL and WebGPU backends can consume it.
     * The primary `scene.light` (SunLight) is always applied independently;
     * `scene.lights` provides supplementary lights for advanced lighting scenarios.
     *
     * @type {LightCollection}
     *
     * @example
     * // Add a red point light
     * const pointLight = new Cesium.PointLight({
     *   position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 100.0),
     *   color: Cesium.Color.RED,
     *   intensity: 5.0,
     *   range: 1000.0
     * });
     * scene.lights.add(pointLight);
     */
    this.lights = new LightCollection();

    /**
     * Whether or not to enable edge visibility rendering for 3D tiles.
     * When enabled, creates a framebuffer with multiple render targets
     * for advanced edge detection and visibility techniques.
     * @type {boolean}
     * @default false
     */
    this._enableEdgeVisibility = false;

    /**
     * Whether or not to enable the planar fill feature-ID pre-pass.
     * Updated each frame from FrameState.planarFillRequested.
     * @type {boolean}
     * @default false
     * @private
     */
    this._enablePlanarFillId = false;

    // Publish the canonical globe facades after atmosphere, fog, and sky
    // objects exist because their accessors resolve those objects.
    if (defined(this._globe)) {
      this._globe._atmosphericConditions = new AtmosphericConditions(
        this,
        this._globe,
      );
      this._globe._water = new GlobeWater(this, this._globe);
    }

    // Give frameState, camera, and screen space camera controller initial state before rendering
    updateFrameNumber(this, 0.0, JulianDate.now());
    this.updateFrameState();
    this.initializeFrame();
  }

  /**
   * Creates a Scene asynchronously with support for WebGPU renderer initialization.
   * This static factory method handles the asynchronous initialization required for WebGPU,
   * while maintaining backward compatibility with synchronous WebGL initialization.
   *
   * @param {object} options Scene creation options (same as Scene constructor)
   * @param {Function} [onProgress] Optional callback for loading progress (0-100)
   *   Signature: function(progress: number, status: string)
   * @returns {Promise<Scene>} Promise that resolves to the initialized Scene
   *
   * @example
   * // Create scene with WebGPU and loading progress
   * const scene = await Cesium.Scene.createAsync({
   *   canvas: canvas,
   *   contextOptions: {
   *     renderer: 'webgpu'
   *   }
   * }, (progress, status) => {
   *   console.log(`${status}: ${progress}%`);
   * });
   *
   * @example
   * // Create scene explicitly with WebGL. Omitting renderer from createAsync
   * // uses AUTO (WebGPU first with WebGL fallback in a dual build).
   * const scene = await Cesium.Scene.createAsync({
   *   canvas: canvas,
   *   contextOptions: { renderer: "webgl" }
   * });
   */
  static async createAsync(options, onProgress) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.canvas)) {
      throw new DeveloperError("options and options.canvas are required.");
    }
    //>>includeEnd('debug');

    let result;
    let scene;
    try {
      if (defined(onProgress)) {
        onProgress(10, "Initializing graphics context...");
      }

      const contextOptions = options.contextOptions ?? {};
      result = await Scene._createContextWithDiagnostics(
        options.canvas,
        contextOptions,
      );

      // The acquired context is transaction-owned before this callback runs.
      // A progress observer is user code and may throw; in that case the catch
      // below must still release the context/device-pool lease.
      if (defined(onProgress)) {
        onProgress(70, "Context ready...");
      }

      scene = new Scene({
        ...options,
        _preInitializedContext: result.context,
        _contextCreationDiagnostics: result.diagnostics,
        _countContextReferences: result.countReferences,
      });

      // Keep the completed Scene transaction-owned until the final observer
      // has returned. Otherwise a throwing 100% callback would reject while
      // leaving a live Scene, global listeners, and graphics context behind.
      if (defined(onProgress)) {
        onProgress(100, "Ready");
      }

      return scene;
    } catch (error) {
      if (
        defined(scene) &&
        (typeof scene.isDestroyed !== "function" || !scene.isDestroyed())
      ) {
        try {
          scene.destroy();
        } catch {
          // Preserve the original factory/progress error. The context fallback
          // below remains mandatory even if a custom Scene owner misbehaves.
        }
      }

      const context = result?.context;
      if (
        defined(context) &&
        typeof context.destroy === "function" &&
        (typeof context.isDestroyed !== "function" || !context.isDestroyed())
      ) {
        try {
          context.destroy();
        } catch {
          // Preserve the original error; Context.destroy performs its own
          // best-effort ownership drain before returning/throwing.
        }
      }
      throw error;
    }
  }

  /**
   * Creates exactly one context for an async Scene/Widget/Viewer transaction.
   * Kept internal so all three entry points share renderer policy and
   * diagnostics without constructing temporary ownership graphs.
   *
   * @private
   */
  static async _createContextWithDiagnostics(canvas, contextOptions) {
    if (contextOptions instanceof SharedContext) {
      const context = contextOptions.createSceneContext(canvas);
      return {
        context,
        countReferences: true,
        diagnostics: Object.freeze({
          requestedRenderer: RendererType.WEBGL,
          resolvedRenderer: RendererType.WEBGL,
          selectionReason: "explicit",
          attempts: Object.freeze([
            Object.freeze({
              renderer: RendererType.WEBGL,
              status: "succeeded",
            }),
          ]),
          fallback: null,
        }),
      };
    }

    const result = await ContextFactory.createContextWithDiagnostics(
      canvas,
      contextOptions,
    );
    return { ...result, countReferences: false };
  }

  /**
   * Gets the canvas element to which this scene is bound.
   *
   * @type {HTMLCanvasElement}
   * @readonly
   */
  get canvas() {
    return this._canvas;
  }

  /**
   * Collects an array of <code>Controller</code> objects that can be registered with the scene to handle input events, camera animations, and other interactions.
   * @see {@link Controller}
   * @type {ControllerHost}
   * @readonly
   * @example
   * scene.screenSpaceCameraController.enableInputs = false;
   * scene.screenSpaceCameraController.enableCollisionDetection = false;
   *
   * const tiltOrbitController = new Cesium.ScreenSpaceTiltOrbitCameraController();
   * scene.controllerHost.registerController(tiltOrbitController, scene.canvas.parentNode);
   */
  get controllerHost() {
    return this._controllerHost;
  }

  /**
   * Describes the renderer request, attempts, selected backend, and fallback
   * (if any) that produced this Scene's graphics context.
   *
   * @type {ContextCreationDiagnostics}
   * @readonly
   */
  get contextCreationDiagnostics() {
    return this._contextCreationDiagnostics;
  }

  /**
   * The drawingBufferHeight of the underlying GL context.
   *
   * @type {number}
   * @readonly
   *
   * @see {@link https://www.khronos.org/registry/webgl/specs/1.0/#DOM-WebGLRenderingContext-drawingBufferHeight|drawingBufferHeight}
   */
  get drawingBufferHeight() {
    return this._context.drawingBufferHeight;
  }

  /**
   * The drawingBufferWidth of the underlying GL context.
   *
   * @type {number}
   * @readonly
   *
   * @see {@link https://www.khronos.org/registry/webgl/specs/1.0/#DOM-WebGLRenderingContext-drawingBufferWidth|drawingBufferWidth}
   */
  get drawingBufferWidth() {
    return this._context.drawingBufferWidth;
  }

  /**
   * The maximum aliased line width, in pixels, supported by this WebGL implementation.  It will be at least one.
   *
   * @type {number}
   * @readonly
   *
   * @see {@link https://www.khronos.org/opengles/sdk/docs/man/xhtml/glGet.xml|glGet} with <code>ALIASED_LINE_WIDTH_RANGE</code>.
   */
  get maximumAliasedLineWidth() {
    return this.context.limits.maximumAliasedLineWidth;
  }

  /**
   * The maximum length in pixels of one edge of a cube map, supported by this WebGL implementation.  It will be at least 16.
   *
   * @type {number}
   * @readonly
   *
   * @see {@link https://www.khronos.org/opengles/sdk/docs/man/xhtml/glGet.xml|glGet} with <code>GL_MAX_CUBE_MAP_TEXTURE_SIZE</code>.
   */
  get maximumCubeMapSize() {
    return this.context.limits.maximumCubeMapSize;
  }

  /**
   * Returns <code>true</code> if the {@link Scene#pickPosition} function is supported.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#pickPosition
   */
  get pickPositionSupported() {
    return this._context.depthTexture;
  }

  /**
   * Returns <code>true</code> if the synchronous {@link Scene#sampleHeight}
   * function is supported. This property does not indicate support for
   * {@link Scene#sampleHeightMostDetailed}.
   *
   * On WebGPU the synchronous {@link Scene#sampleHeight} reuses the main
   * scene depth: it projects the position into the live view and reconstructs
   * the surface height beneath it. It is
   * one-frame-stale (the first query at a new location returns
   * <code>undefined</code> and converges in 1-2 frames) and only resolves for
   * positions currently visible in the view. The asynchronous
   * {@link Scene#sampleHeightMostDetailed} variant relies on offscreen depth
   * and is unsupported on asynchronous-readback backends. For CPU terrain-only
   * sampling that is independent of GPU readback, use
   * {@link sampleTerrainMostDetailed}.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#sampleHeight
   * @see Scene#sampleHeightMostDetailed
   * @see Scene#sampleHeightMostDetailedSupported
   */
  get sampleHeightSupported() {
    return this._context.depthTexture;
  }

  /**
   * Returns <code>true</code> if the synchronous {@link Scene#clampToHeight}
   * function is supported. This property does not indicate support for
   * {@link Scene#clampToHeightMostDetailed}.
   *
   * On WebGPU the synchronous {@link Scene#clampToHeight} reuses the main
   * scene depth: it projects the position into the live view and reconstructs
   * the surface beneath it. It is
   * one-frame-stale (the first query at a new location returns
   * <code>undefined</code> and converges in 1-2 frames) and only resolves for
   * positions currently visible in the view. The asynchronous
   * {@link Scene#clampToHeightMostDetailed} variant relies on offscreen depth
   * and is unsupported on asynchronous-readback backends. For CPU terrain-only
   * sampling that is independent of GPU readback, use
   * {@link sampleTerrainMostDetailed}.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#clampToHeight
   * @see Scene#clampToHeightMostDetailed
   * @see Scene#clampToHeightMostDetailedSupported
   */
  get clampToHeightSupported() {
    return this._context.depthTexture;
  }

  /**
   * Returns <code>true</code> if the asynchronous
   * {@link Scene#sampleHeightMostDetailed} function is supported.
   *
   * This is narrower than {@link Scene#sampleHeightSupported}: the most-detailed
   * variant additionally needs the renderer to recover depth from an offscreen
   * ray render. Where that producer is missing the query still resolves, but
   * every sampled height comes back <code>undefined</code>, so check this before
   * relying on the result. For CPU terrain-only sampling that needs no GPU
   * readback at all, use {@link sampleTerrainMostDetailed}.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#sampleHeightMostDetailed
   * @see Scene#sampleHeightSupported
   */
  get sampleHeightMostDetailedSupported() {
    return (
      this.sampleHeightSupported &&
      this._context.supportsOffscreenRayDepthReadback
    );
  }

  /**
   * Returns <code>true</code> if the asynchronous
   * {@link Scene#clampToHeightMostDetailed} function is supported.
   *
   * This is narrower than {@link Scene#clampToHeightSupported}: the
   * most-detailed variant additionally needs the renderer to recover depth from
   * an offscreen ray render. Where that producer is missing the query still
   * resolves, but every element of the array comes back <code>undefined</code>,
   * so check this before relying on the result. For CPU terrain-only sampling
   * that needs no GPU readback at all, use {@link sampleTerrainMostDetailed}.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#clampToHeightMostDetailed
   * @see Scene#clampToHeightSupported
   */
  get clampToHeightMostDetailedSupported() {
    return (
      this.clampToHeightSupported &&
      this._context.supportsOffscreenRayDepthReadback
    );
  }

  /**
   * Returns <code>true</code> if the {@link Scene#invertClassification} is supported.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#invertClassification
   */
  get invertClassificationSupported() {
    return this._context.depthTexture;
  }

  /**
   * Returns <code>true</code> if specular environment maps are supported.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#specularEnvironmentMaps
   */
  get specularEnvironmentMapsSupported() {
    return SpecularEnvironmentCubeMap.isSupported(this._context);
  }

  /**
   * Whether the active rendering context can use the WGSL
   * `@builtin(primitive_index)` fragment input. True only on WebGPU contexts
   * whose driver successfully compiles a probe shader using the builtin —
   * always false on WebGL because `gl_PrimitiveID` requires a geometry shader.
   * Drives whether {@link Scene#debugShowTriangulation} has any effect.
   *
   * @type {boolean}
   * @readonly
   */
  get triangulationDebugSupported() {
    // WebGL reports false because it does not expose the primitive-index
    // utility. WebGPU reports true only after the device and utility are ready.
    return this._context?.supportsTriangulationDebug === true;
  }

  /**
   * The ellipsoid.  If not specified, the default ellipsoid is used.
   *
   * @type {Ellipsoid}
   * @readonly
   */
  get ellipsoid() {
    return this._ellipsoid;
  }

  /**
   * Gets or sets the depth-test ellipsoid.
   *
   * @type {Globe}
   */
  get globe() {
    return this._globe;
  }

  set globe(globe) {
    // Preserve a live globe when asynchronous widget initialization assigns
    // the same instance. Destroying it before rebinding would erase surface
    // state required by the globe listeners.
    if (this._globe === globe) {
      return;
    }
    this._globe = this._globe && this._globe.destroy();
    this._globe = globe;

    // Rebind the canonical facades because their accessors resolve through the
    // current globe.
    if (defined(globe)) {
      globe._atmosphericConditions = new AtmosphericConditions(this, globe);
      globe._water = new GlobeWater(this, globe);
    }

    updateGlobeListeners(this, globe);
  }

  /**
   * Adaptive visual quality coordinator. Features with a tunable quality
   * dial (cloud sample count, fog froxel resolution, terrain LOD bias,
   * etc.) register sinks against this service so the auto-tuner can scale
   * them to hold a target framerate. Disabled by default — opt in via
   * `scene.visualPerformanceTarget.enabled = true`.
   *
   * @type {object}
   * @readonly
   */
  get visualPerformanceTarget() {
    return this._visualPerformanceTarget;
  }

  /**
   * Snapshot mode coordinator for static scenes. Registered freezable
   * subsystems retain their cache state while a snapshot is active and thaw
   * when `scene._snapshotVersion` advances beyond the captured baseline.
   * Disabled by default.
   *
   * @type {object}
   * @readonly
   */
  get snapshotMode() {
    return this._snapshotMode;
  }

  /**
   * Notifies the active snapshot that scene state changed outside the
   * version-counter and camera-delta paths. This thaws frozen caches so they
   * rebuild against the new state.
   *
   * Typical callers:
   *   - User `postUpdate` listeners that mutate visible entity properties
   *   - Animation systems on first tick of a new clip
   *   - HDR or logarithmic-depth changes
   *   - Volumetric fog quality dial changes mid-snapshot (the
   *     froxel grid resolution can't change inside a frozen frame)
   *
   * Callers that make changes the service cannot observe must call
   * `scene.markSnapshotDirty(reason)`. The call is idempotent when no snapshot
   * is active, and the reason is available from
   * `scene.snapshotMode.getStatistics()` for diagnostics.
   *
   * @param {string} [reason] Human-readable reason for the dirty
   *   notification. Defaults to a generic placeholder.
   */
  markSnapshotDirty(reason) {
    if (defined(this._snapshotMode)) {
      this._snapshotMode.markDirty(reason);
    }
  }

  /**
   * Returns a structured diagnostic snapshot of the scene. Aggregates state
   * from every subsystem with a
   * `getStatistics()` accessor: snapshot mode, VPT, the renderer
   * (bundle cache, fog, perf manager), the moon, and the current debug
   * toggles. Pure read; safe to call from any callback at any time.
   *
   * The shape is intentionally permissive — every nested field is
   * optional, so a WebGL scene that doesn't have a bundle manager
   * still produces a usable snapshot. Use {@link Scene#logDebugSnapshot}
   * for a console-friendly pretty-print.
   *
   * @returns {object} A debug snapshot, suitable for `console.log()` or
   *   `JSON.stringify()`.
   *
   * @example
   * // From a postUpdate listener:
   * scene.postUpdate.addEventListener(() => {
   *   if (scene.frameState.frameNumber % 60 === 0) {
   *     scene.logDebugSnapshot();
   *   }
   * });
   *
   * @example
   * // Programmatic — pull just the bundle stats:
   * const snap = scene.getDebugSnapshot();
   * console.table(snap.renderer?.bundleManager?.keyPrefixes);
   */
  getDebugSnapshot() {
    const fs = this._frameState;
    const snap = {
      scene: {
        backend: this._context?.rendererType ?? "unknown",
        contextId: this._context?.id ?? null,
        frameNumber: fs?.frameNumber ?? -1,
        snapshotVersion: this._snapshotVersion ?? 0,
        requestRenderMode: this.requestRenderMode === true,
        renderRequested: this._renderRequested === true,
        taaEnabled: this.taaEnabled === true,
        useCascadedShadowMaps: this.useCascadedShadowMaps === true,
        mode: fs?.mode ?? null,
        morphTime: fs?.morphTime ?? null,
        useLogDepth: this._logDepthBuffer === true,
        useHdr: this._hdr === true,
        primitivesCount: this._primitives?.length ?? 0,
        groundPrimitivesCount: this._groundPrimitives?.length ?? 0,
      },
      snapshotMode: null,
      visualPerformanceTarget: null,
      renderer: null,
      containment: {
        renderScheduler: {
          requested: this._renderScheduler?.enabled === true,
          capable: true,
          active:
            this._renderScheduler?.enabled === true &&
            (this._renderScheduler?.stats?.sortCalls ?? 0) > 0,
          fallbackReason:
            this._renderScheduler?.enabled === true
              ? (this._renderScheduler?.stats?.sortCalls ?? 0) > 0
                ? null
                : "no-sort-work-this-frame"
              : "contained-dead-command-stream",
          // Stable material identifiers are maintained only while a consumer
          // needs them, avoiding default-path scheduler work.
          materialIdMaintenance: {
            consumers: this._renderScheduler?.stableMaterialIdConsumers ?? 0,
            ranThisFrame:
              (this._renderScheduler?.stats?.materialIdsAssigned ?? 0) > 0,
            framesRun: this._renderScheduler?.materialIdMaintenanceRuns ?? 0,
            framesSkipped:
              this._renderScheduler?.materialIdMaintenanceSkips ?? 0,
          },
          // SceneOctree is opt-in and accepts only opaque or translucent
          // primitive commands; terrain, 3D Tiles, and voxels never enter it.
          // At default settings it is inactive and performs no build work.
          octree: {
            enabled: this._renderScheduler?.octree?.enabled === true,
            builtThisFrame: this._renderScheduler?.octree?.isBuilt === true,
            buildTimeMs: this._renderScheduler?.octree?.stats?.buildTimeMs ?? 0,
            commandsInserted:
              this._renderScheduler?.octree?.stats?.commandsInserted ?? 0,
          },
        },
      },
      moon: null,
      // Report the current view's depth-frustum count. Environment commands
      // without bounding volumes must not widen its near/far range, allowing
      // the default 3D scene to use one frustum; the sky-only fallback may use
      // two.
      frustums: {
        count: this._view?.frustumCommandsList?.length ?? 0,
      },
      debugToggles: {
        debugShowFramesPerSecond: this.debugShowFramesPerSecond === true,
        debugShowCommands: this.debugShowCommands === true,
        debugShowFrustums: this.debugShowFrustums === true,
        debugShowFrustumPlanes: this.debugShowFrustumPlanes === true,
        debugShowDepthFrustum: this.debugShowDepthFrustum ?? 1,
        debugShowGlobeWireframe: this.debugShowGlobeWireframe === true,
        debugShowCubeMapFace: this.debugShowCubeMapFace ?? 0,
        debugShowTerrainLOD: this.debugShowTerrainLOD === true,
        debugShowTerrainNormals: this.debugShowTerrainNormals === true,
        debugShowImageryLayer: this.debugShowImageryLayer ?? -1,
        debugShowImageryProbe: this.debugShowImageryProbe === true,
        debugShowDepthAsColor: this.debugShowDepthAsColor === true,
        debugShowTriangulation: this.debugShowTriangulation === true,
        debugDisableAtmosphereScattering:
          this.debugDisableAtmosphereScattering === true,
      },
    };
    if (defined(this._snapshotMode)) {
      try {
        snap.snapshotMode = this._snapshotMode.getStatistics();
      } catch (e) {
        snap.snapshotMode = { error: String(e?.message ?? e) };
      }
    }
    if (defined(this._visualPerformanceTarget)) {
      try {
        snap.visualPerformanceTarget =
          this._visualPerformanceTarget.getStatistics();
      } catch (e) {
        snap.visualPerformanceTarget = { error: String(e?.message ?? e) };
      }
    }
    if (
      defined(this._context) &&
      typeof this._context.getRendererStatistics === "function"
    ) {
      try {
        snap.renderer = this._context.getRendererStatistics();
      } catch (e) {
        snap.renderer = { error: String(e?.message ?? e) };
      }
    }
    // Report per-frame attachment demand and the measured scene-framebuffer
    // topology when the context exposes those statistics.
    snap.attachmentDemand = null;
    if (
      defined(this._context) &&
      typeof this._context.getAttachmentDemandStats === "function"
    ) {
      try {
        snap.attachmentDemand = this._context.getAttachmentDemandStats();
      } catch (e) {
        snap.attachmentDemand = { error: String(e?.message ?? e) };
      }
    }
    if (
      defined(this.moon) &&
      typeof this.moon.getDebugStatistics === "function"
    ) {
      try {
        snap.moon = this.moon.getDebugStatistics(this);
      } catch (e) {
        snap.moon = { error: String(e?.message ?? e) };
      }
    }
    // Include high-density GPU-culling, Hi-Z, and sort-key counters when the
    // alternate renderer exposes them; otherwise leave the field absent.
    if (
      defined(this._alternateSceneRenderer) &&
      typeof this._alternateSceneRenderer.getHighDensityCullStats === "function"
    ) {
      try {
        snap.highDensityCull =
          this._alternateSceneRenderer.getHighDensityCullStats();
      } catch (e) {
        snap.highDensityCull = { error: String(e?.message ?? e) };
      }
    }
    if (
      defined(this._alternateSceneRenderer) &&
      typeof this._alternateSceneRenderer.getContainmentStats === "function"
    ) {
      try {
        Object.assign(
          snap.containment,
          this._alternateSceneRenderer.getContainmentStats(),
        );
      } catch (e) {
        snap.containment.rendererError = String(e?.message ?? e);
      }
    }
    return snap;
  }

  /**
   * Starts a performance trace with one sample per rendered frame until
   * {@link Scene#endPerformanceTrace} is called.
   * Auto-ends when `options.frames` is reached (default 600).
   *
   * Pure read on the rendering side — sampling is bounded to a few
   * field copies per frame and a single Map lookup. Production scenes
   * pay nothing while no trace is active.
   *
   * @param {string} label Diagnostic label carried into the result.
   * @param {object} [options]
   * @param {number} [options.frames=600] Max frames before auto-end.
   *
   * @example
   * // From the dev tools console:
   * scene.beginPerformanceTrace("idle-orbit", { frames: 300 });
   * // ... let the scene render for 5 seconds ...
   * const result = scene.endPerformanceTrace();
   * console.log(scene.performanceTracker.toCSV(result));
   */
  beginPerformanceTrace(label, options) {
    this._performanceTracker.beginTrace(label, options);
  }

  /**
   * Ends the active performance trace and returns its structured result, or
   * `null` when no trace is active.
   *
   * @returns {object|null}
   */
  endPerformanceTrace() {
    return this._performanceTracker.endTrace();
  }

  /**
   * The {@link PerformanceTracker} owned by this scene. Exposed so the
   * operator can call `toCSV()` / `toJSON()` / `logToConsole()` on the
   * result without having to thread the result object through the
   * application.
   *
   * @type {object}
   * @readonly
   */
  get performanceTracker() {
    return this._performanceTracker;
  }

  /**
   * Pretty-prints the result of
   * {@link Scene#getDebugSnapshot} to the console using grouped
   * sections and `console.table()` for tabular sub-objects. Designed
   * for ad-hoc developer use from DevTools or postUpdate callbacks.
   *
   * Calling this method is the only way to emit the dump. Avoid calling it on
   * every frame.
   */
  logDebugSnapshot() {
    const snap = this.getDebugSnapshot();
    const tag = `[CesiumJS:${snap.scene.backend}:${snap.scene.contextId ?? "?"}] DebugSnapshot frame=${snap.scene.frameNumber}`;
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed(tag);
    } else {
      console.log(tag);
    }
    console.log("scene:", snap.scene);
    console.log("debugToggles:", snap.debugToggles);
    if (snap.snapshotMode) {
      console.log("snapshotMode:", snap.snapshotMode);
    }
    if (snap.visualPerformanceTarget) {
      console.log("visualPerformanceTarget:", snap.visualPerformanceTarget);
    }
    if (snap.renderer) {
      console.log("renderer:", snap.renderer);
    }
    if (snap.moon) {
      console.log("moon:", snap.moon);
    }
    if (typeof console.groupEnd === "function") {
      console.groupEnd();
    }
    return snap;
  }

  /**
   * Monotonic counter advanced by scene-visible mutations that invalidate
   * frozen render bundles. Snapshot mode compares it with the captured value
   * to decide when cached bundles must thaw.
   *
   * @type {number}
   * @readonly
   */
  get snapshotVersion() {
    return this._snapshotVersion;
  }

  /**
   * Gets the collection of primitives.
   *
   * @type {PrimitiveCollection}
   * @readonly
   */
  get primitives() {
    return this._primitives;
  }

  /**
   * Gets the collection of ground primitives.
   *
   * @type {PrimitiveCollection}
   * @readonly
   */
  get groundPrimitives() {
    return this._groundPrimitives;
  }

  /**
   * Gets or sets the camera.
   *
   * @type {Camera}
   * @readonly
   */
  get camera() {
    return this._view.camera;
  }

  set camera(camera) {
    // For internal use only. Documentation is still @readonly.
    this._view.camera = camera;
  }

  /**
   * Gets or sets the view.
   *
   * @type {View}
   * @readonly
   *
   * @private
   */
  get view() {
    return this._view;
  }

  set view(view) {
    // For internal use only. Documentation is still @readonly.
    this._view = view;
  }

  /**
   * Gets the default view.
   *
   * @type {View}
   * @readonly
   *
   * @private
   */
  get defaultView() {
    return this._defaultView;
  }

  /**
   * Gets picking functions and state
   *
   * @type {Picking}
   * @readonly
   *
   * @private
   */
  get picking() {
    return this._picking;
  }

  /**
   * Gets the controller for camera input handling.
   *
   * @type {ScreenSpaceCameraController}
   * @readonly
   */
  get screenSpaceCameraController() {
    return this._screenSpaceCameraController;
  }

  /**
   * Get the map projection to use in 2D and Columbus View modes.
   *
   * @type {MapProjection}
   * @readonly
   *
   * @default new GeographicProjection()
   */
  get mapProjection() {
    return this._mapProjection;
  }

  /**
   * Gets the job scheduler
   * @type {JobScheduler}
   * @readonly
   *
   * @private
   */
  get jobScheduler() {
    return this._jobScheduler;
  }

  /**
   * Gets state information about the current scene. If called outside of a primitive's <code>update</code>
   * function, the previous frame's state is returned.
   *
   * @type {FrameState}
   * @readonly
   *
   * @private
   */
  get frameState() {
    return this._frameState;
  }

  /**
   * Gets or sets the ready synchronous provider used for per-frame Sun and
   * Moon positions. Assignment is atomic: the configured provider becomes
   * active on the next logical frame, so main, pick, and offscreen Views can
   * never mix providers within one frame.
   *
   * Astronomy Engine setup remains caller-owned; await
   * {@link AstronomyEngineEphemerisProvider.create} before assigning it.
   *
   * @type {CelestialEphemerisProvider}
   */
  get celestialEphemerisProvider() {
    return this._celestialEphemerisProvider;
  }

  set celestialEphemerisProvider(provider) {
    if (typeof provider?.then === "function") {
      throw new DeveloperError(
        "celestialEphemerisProvider must be ready; await asynchronous provider creation before assigning it.",
      );
    }
    Check.defined("celestialEphemerisProvider", provider);
    Check.typeOf.func("celestialEphemerisProvider.compute", provider.compute);
    if (
      provider === this._celestialEphemerisProvider &&
      !this._celestialEphemerisProviderIsImplicit
    ) {
      return;
    }

    this._celestialEphemerisProvider = provider;
    // Assignment is an explicit ownership boundary even when the caller
    // writes back the exact Scene-created default object. Keep the active
    // ownership unchanged until the next logical frame.
    this._celestialEphemerisProviderIsImplicit = false;
    this._celestialEphemerisProviderSetFrameNumber =
      this._frameState.frameNumber;
    this.requestRender();
  }

  /**
   * Gets the environment state.
   *
   * @type {EnvironmentState}
   * @readonly
   *
   * @private
   */
  get environmentState() {
    return this._environmentState;
  }

  /**
   * Gets the collection of tweens taking place in the scene.
   *
   * @type {TweenCollection}
   * @readonly
   *
   * @private
   */
  get tweens() {
    return this._tweens;
  }

  /**
   * Gets the collection of image layers that will be rendered on the globe.
   *
   * @type {ImageryLayerCollection}
   * @readonly
   */
  get imageryLayers() {
    if (!defined(this.globe)) {
      return undefined;
    }

    return this.globe.imageryLayers;
  }

  /**
   * The terrain provider providing surface geometry for the globe.
   *
   * @type {TerrainProvider}
   */
  get terrainProvider() {
    if (!defined(this.globe)) {
      return undefined;
    }

    return this.globe.terrainProvider;
  }

  set terrainProvider(terrainProvider) {
    // Cancel any in-progress terrain update
    this._removeTerrainProviderReadyListener =
      this._removeTerrainProviderReadyListener &&
      this._removeTerrainProviderReadyListener();

    if (defined(this.globe)) {
      this.globe.terrainProvider = terrainProvider;
    }
  }

  /**
   * Gets an event that's raised when the terrain provider is changed
   *
   * @type {Event}
   * @readonly
   */
  get terrainProviderChanged() {
    if (!defined(this.globe)) {
      return undefined;
    }

    return this.globe.terrainProviderChanged;
  }

  /**
   * @type {VectorProvider}
   * @ignore
   */
  get vectorProvider() {
    return this.globe?.vectorProvider;
  }

  /**
   * Gets the event that will be raised before the scene is updated or rendered.  Subscribers to the event
   * receive the Scene instance as the first parameter and the current time as the second parameter.
   *
   * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
   * @see Scene#postUpdate
   * @see Scene#preRender
   * @see Scene#postRender
   *
   * @type {Event}
   * @readonly
   */
  get preUpdate() {
    return this._preUpdate;
  }

  /**
   * Gets the event that will be raised immediately after the scene is updated and before the scene is rendered.
   * Subscribers to the event receive the Scene instance as the first parameter and the current time as the second
   * parameter.
   *
   * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
   * @see Scene#preUpdate
   * @see Scene#preRender
   * @see Scene#postRender
   *
   * @type {Event}
   * @readonly
   */
  get postUpdate() {
    return this._postUpdate;
  }

  /**
   * Gets the event that will be raised when an error is thrown inside the <code>render</code> function.
   * The Scene instance and the thrown error are the only two parameters passed to the event handler.
   * By default, errors are not rethrown after this event is raised, but that can be changed by setting
   * the <code>rethrowRenderErrors</code> property.
   *
   * @type {Event}
   * @readonly
   */
  get renderError() {
    return this._renderError;
  }

  /**
   * Gets the event that will be raised after the scene is updated and immediately before the scene is rendered.
   * Subscribers to the event receive the Scene instance as the first parameter and the current time as the second
   * parameter.
   *
   * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
   * @see Scene#preUpdate
   * @see Scene#postUpdate
   * @see Scene#postRender
   *
   * @type {Event}
   * @readonly
   */
  get preRender() {
    return this._preRender;
  }

  /**
   * Gets the event that will be raised immediately after the scene is rendered.  Subscribers to the event
   * receive the Scene instance as the first parameter and the current time as the second parameter.
   *
   * @see {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}
   * @see Scene#preUpdate
   * @see Scene#postUpdate
   * @see Scene#postRender
   *
   * @type {Event}
   * @readonly
   */
  get postRender() {
    return this._postRender;
  }

  /**
   * Gets the simulation time when the scene was last rendered. Returns <code>undefined</code>
   * if the scene has not yet been rendered.
   *
   * @type {JulianDate | undefined}
   * @readonly
   */
  get lastRenderTime() {
    return this._lastRenderTime;
  }

  /**
   * @private
   * @readonly
   */
  get context() {
    return this._context;
  }

  /**
   * The graphics context as a GraphicsContext instance.
   * Provides access to the full backend-agnostic API including
   * context-aware logging, feature renderer registry, and type queries.
   *
   * @type {GraphicsContext}
   * @readonly
   */
  get graphicsContext() {
    return this._context;
  }

  /**
   * The global ContextRegistry tracking all active GraphicsContext instances.
   * Supports multi-view and split-screen scenarios.
   *
   * @type {ContextRegistry}
   * @readonly
   *
   * @example
   * const registry = scene.contextRegistry;
   * console.log(`Active contexts: ${registry.count}`);
   * for (const [id, ctx] of registry) {
   *   console.log(`${id}: ${ctx.rendererType}`);
   * }
   */
  get contextRegistry() {
    // Access the static registry via the context's constructor
    // GraphicsContext.registry is the singleton
    if (
      this._context &&
      this._context.constructor &&
      this._context.constructor.registry
    ) {
      return this._context.constructor.registry;
    }
    return undefined;
  }

  /**
   * Returns true if this scene uses the WebGPU renderer. Prefer
   * backend-neutral capabilities when the concrete renderer is not required.
   * @type {boolean}
   * @readonly
   * @private
   */
  get isWebGPU() {
    return this._context.isWebGPU === true;
  }

  /**
   * This property is for debugging only; it is not for production use.
   * <p>
   * When {@link Scene.debugShowFrustums} is <code>true</code>, this contains
   * properties with statistics about the number of command execute per frustum.
   * <code>totalCommands</code> is the total number of commands executed, ignoring
   * overlap. <code>commandsInFrustums</code> is an array with the number of times
   * commands are executed redundantly, e.g., how many commands overlap two or
   * three frustums.
   * </p>
   *
   * @type {object | undefined}
   * @readonly
   *
   * @default undefined
   */
  get debugFrustumStatistics() {
    return this._view.debugFrustumStatistics;
  }

  /**
   * Gets whether or not the scene is optimized for 3D only viewing.
   * @type {boolean}
   * @readonly
   */
  get scene3DOnly() {
    return this._frameState.scene3DOnly;
  }

  /**
   * Gets whether or not the scene has order independent translucency enabled.
   * Note that this only reflects the original construction option, and there are
   * other factors that could prevent OIT from functioning on a given system configuration.
   * @type {boolean}
   * @readonly
   */
  get orderIndependentTranslucency() {
    return this._useOIT;
  }

  /**
   * Gets the unique identifier for this scene.
   * @type {string}
   * @readonly
   */
  get id() {
    return this._id;
  }

  /**
   * Gets or sets the current mode of the scene.
   * @type {SceneMode}
   * @default {@link SceneMode.SCENE3D}
   */
  get mode() {
    return this._mode;
  }

  set mode(value) {
    //>>includeStart('debug', pragmas.debug);
    if (this.scene3DOnly && value !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Only SceneMode.SCENE3D is valid when scene3DOnly is true.",
      );
    }
    //>>includeEnd('debug');
    if (value === SceneMode.SCENE2D) {
      this.morphTo2D(0);
    } else if (value === SceneMode.SCENE3D) {
      this.morphTo3D(0);
    } else if (value === SceneMode.COLUMBUS_VIEW) {
      this.morphToColumbusView(0);
      //>>includeStart('debug', pragmas.debug);
    } else {
      throw new DeveloperError("value must be a valid SceneMode enumeration.");
      //>>includeEnd('debug');
    }
    this._mode = value;
  }

  /**
   * Gets the number of frustums used in the last frame.
   * @type {FrustumCommands[]}
   *
   * @private
   */
  get frustumCommandsList() {
    return this._view.frustumCommandsList;
  }

  /**
   * Gets the number of frustums used in the last frame.
   * @type {number}
   *
   * @private
   */
  get numberOfFrustums() {
    return this._view.frustumCommandsList.length;
  }

  /**
   * When <code>true</code>, splits the scene into two viewports with steroscopic views for the left and right eyes.
   * Used for cardboard and WebVR.
   * @type {boolean}
   * @default false
   */
  get useWebVR() {
    return this._useWebVR;
  }

  set useWebVR(value) {
    //>>includeStart('debug', pragmas.debug);
    if (this.camera.frustum instanceof OrthographicFrustum) {
      throw new DeveloperError(
        "VR is unsupported with an orthographic projection.",
      );
    }
    //>>includeEnd('debug');
    // Reject stereo when the context cannot apply per-eye viewports; otherwise
    // a full-canvas viewport would present one eye while appearing to be
    // stereo. The capability gate keeps this independent of renderer identity.
    if (value && this._context?.supportsStereoViewport === false) {
      throw new DeveloperError(
        "scene.useWebVR is not yet supported on this backend. " +
          "The per-eye viewport split requires plumbing passState.viewport " +
          "through the backend's scene renderer (WebGPU currently hard-codes " +
          "the full-canvas viewport).",
      );
    }
    this._useWebVR = value;
    if (this._useWebVR) {
      this._frameState.creditDisplay.container.style.visibility = "hidden";
      this._cameraVR = new Camera(this);
      if (!defined(this._deviceOrientationCameraController)) {
        this._deviceOrientationCameraController =
          new DeviceOrientationCameraController(this);
      }

      this._aspectRatioVR = this.camera.frustum.aspectRatio;
    } else {
      this._frameState.creditDisplay.container.style.visibility = "visible";
      this._cameraVR = undefined;
      this._deviceOrientationCameraController =
        this._deviceOrientationCameraController &&
        !this._deviceOrientationCameraController.isDestroyed() &&
        this._deviceOrientationCameraController.destroy();

      this.camera.frustum.aspectRatio = this._aspectRatioVR;
      this.camera.frustum.xOffset = 0.0;
    }
  }

  /**
   * Determines if the 2D map is rotatable or can be scrolled infinitely in the horizontal direction.
   * @type {MapMode2D}
   * @readonly
   */
  get mapMode2D() {
    return this._mapMode2D;
  }

  /**
   * Gets or sets the position of the splitter within the viewport.  Valid values are between 0.0 and 1.0.
   *
   * @type {number}
   */
  get splitPosition() {
    return this._frameState.splitPosition;
  }

  set splitPosition(value) {
    this._frameState.splitPosition = value;
  }

  /**
   * The distance from the camera at which to disable the depth test of billboards, labels and points
   * to, for example, prevent clipping against terrain. When set to zero, the depth test should always
   * be applied. When less than zero, the depth test should never be applied. Setting the disableDepthTestDistance
   * property of a billboard, label or point will override this value.
   * @type {number}
   * @default 0.0
   */
  get minimumDisableDepthTestDistance() {
    return this._minimumDisableDepthTestDistance;
  }

  set minimumDisableDepthTestDistance(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value) || value < 0.0) {
      throw new DeveloperError(
        "minimumDisableDepthTestDistance must be greater than or equal to 0.0.",
      );
    }
    //>>includeEnd('debug');
    this._minimumDisableDepthTestDistance = value;
  }

  /**
   * Whether or not to use a logarithmic depth buffer. Enabling this option will allow for less frustums in the multi-frustum,
   * increasing performance. This property relies on fragmentDepth being supported.
   * @type {boolean}
   */
  get logarithmicDepthBuffer() {
    return this._logDepthBuffer;
  }

  set logarithmicDepthBuffer(value) {
    value = this._context.fragmentDepth && value;
    if (this._logDepthBuffer !== value) {
      this._logDepthBuffer = value;
      this._logDepthBufferDirty = true;
    }
  }

  /**
   * The value used for gamma correction. This is only used when rendering with high dynamic range.
   * @type {number}
   * @default 2.2
   */
  get gamma() {
    return this._context.uniformState.gamma;
  }

  set gamma(value) {
    this._context.uniformState.gamma = value;
  }

  /**
   * Whether or not to use high dynamic range rendering.
   *
   * On a display that reports `(dynamic-range: high)`, a context that supports
   * HDR ({@link Scene#highDynamicRangeSupported}) defaults to `true` and
   * follows display changes. Assigning this property transfers ownership to
   * the application, so display detection no longer overwrites it. Set
   * {@link Scene#hdrDisplayPolicy} to `'off'` to opt out of detection entirely
   * without pinning a value.
   *
   * @type {boolean}
   * @default false on SDR displays; the display capability otherwise
   */
  get highDynamicRange() {
    return this._hdr;
  }

  set highDynamicRange(value) {
    // Record application ownership before capability clamping so an explicit
    // `true` assignment on a context without HDR support still stops display
    // detection from changing the property.
    this._hdrUserSet = true;
    const context = this._context;
    const hdr =
      value &&
      context.depthTexture &&
      (context.colorBufferFloat || context.colorBufferHalfFloat);
    this._hdrDirty = hdr !== this._hdr;
    this._hdr = hdr;
  }

  /**
   * Controls which scene properties may follow the detected display
   * capability.
   *
   * - `'off'` — retain the current HDR values without applying display
   *   detection.
   * - `'scene'` (default) — default {@link Scene#highDynamicRange} from the
   *   display. The scene renders into a float framebuffer and the normal SDR
   *   tonemap still runs on the way to the canvas.
   * - `'scene-and-canvas'` — additionally default
   *   {@link Scene#useHDRCanvasOutput}, which skips that tonemap and asks the
   *   WebGPU canvas for extended range. WebGL has no canvas-color-space
   *   equivalent and ignores the flag.
   *
   * Changing this re-resolves immediately. Values the application has already
   * assigned are still never overwritten.
   *
   * @type {'off' | 'scene' | 'scene-and-canvas'}
   * @default 'scene'
   */
  get hdrDisplayPolicy() {
    return this._hdrDisplayPolicy;
  }

  set hdrDisplayPolicy(value) {
    const normalized = normalizeHdrDisplayPolicy(value);
    if (this._hdrDisplayPolicy === normalized) {
      return;
    }
    this._hdrDisplayPolicy = normalized;
    if (this._applyHdrDisplayDefault()) {
      this.requestRender();
    }
  }

  /**
   * Whether or not high dynamic range rendering is supported.
   * @type {boolean}
   * @readonly
   * @default true
   */
  get highDynamicRangeSupported() {
    const context = this._context;
    return (
      context.depthTexture &&
      (context.colorBufferFloat || context.colorBufferHalfFloat)
    );
  }

  /**
   * Whether the post-process pipeline should skip the SDR tonemap stage and
   * forward HDR-encoded scene color directly to the canvas. Useful on
   * HDR-capable displays (Apple Pro Display XDR, modern OLEDs, displays
   * in HDR-10 / Dolby Vision mode) where the OS / display handles the
   * gamut + tone curve, and an SDR-tonemapped frame would crush
   * highlights into the SDR range.
   *
   * Requires {@link Scene#highDynamicRange} to also be true (the scene
   * framebuffer must be rgba16float so the HDR data actually exists
   * to forward). When either gate is off, standard tonemap runs.
   *
   * Setting this flag to `true` reconfigures the underlying WebGPU
   * `GPUCanvasContext` with `format: 'rgba16float' + colorSpace:
   * 'display-p3' + toneMapping: { mode: 'extended' }` so the browser
   * forwards extended-range values to HDR-capable displays.
   * ColorGrading and FXAA keep running under HDR with HDR-aware math: both
   * stages switch to a Reinhard-compressed
   * working space so the grade pivots and AA edge thresholds behave,
   * and their output stays linear HDR.
   *
   * @type {boolean}
   * @default false
   * @experimental This feature is experimental and may change or be removed without Cesium's standard deprecation policy.
   */
  get useHDRCanvasOutput() {
    return this._useHDRCanvasOutput === true;
  }

  set useHDRCanvasOutput(value) {
    // Record application ownership before the unchanged-value return because
    // assigning the existing value still opts this property out of display
    // detection.
    this._useHDRCanvasOutputUserSet = true;
    const next = value === true;
    if (this._useHDRCanvasOutput === next) {
      return;
    }
    this._useHDRCanvasOutput = next;
    // Keep the WebGPU canvas configuration synchronized with the
    // producer-side flag. Contexts without canvas reconfiguration support
    // cannot widen the output color space.
    const ctx = this._context;
    if (ctx && typeof ctx.setHDRCanvasOutput === "function") {
      ctx.setHDRCanvasOutput(next);
    }
  }

  /**
   * Reads the display capability and subscribes to changes.
   *
   * The subscription is the load-bearing half: a laptop dragged onto an HDR
   * external monitor, or the OS HDR toggle, fires `change` on the media query
   * and this scene re-resolves. Without it the default would be frozen at
   * whatever display the scene happened to be constructed on.
   *
   * Safe in Node / jsdom / any host without `matchMedia`: the query reports
   * "unavailable", the resolver applies nothing, and no listener is attached.
   *
   * @private
   */
  _initializeHdrDisplayDetection() {
    const host = typeof window !== "undefined" ? window : undefined;
    const query = queryHdrDisplay(host);
    this._hdrDisplayIsHdr = query.displayIsHdr;
    this._applyHdrDisplayDefault();
    if (!query.detectionAvailable) {
      return;
    }
    this._hdrDisplayUnsub = observeHdrDisplay(host, (displayIsHdr) => {
      if (this.isDestroyed()) {
        return;
      }
      this._hdrDisplayIsHdr = displayIsHdr;
      if (this._applyHdrDisplayDefault()) {
        this.requestRender();
      }
    });
  }

  /**
   * Applies {@link resolveHdrDefault} to this scene.
   *
   * Assignment goes through the public setters so the HDR-dirty bookkeeping
   * and the WebGPU canvas reconfigure both run exactly as they do for an
   * application assignment; the user-set flags are then restored, because a
   * detection-driven write must not masquerade as an application override
   * (that would make the very first detection freeze the value forever).
   *
   * @returns {boolean} true when anything actually changed.
   * @private
   */
  _applyHdrDisplayDefault() {
    const context = this._context;
    const decision = resolveHdrDefault({
      displayIsHdr: this._hdrDisplayIsHdr,
      contextSupportsHdr: this.highDynamicRangeSupported === true,
      policy: this._hdrDisplayPolicy,
      canvasExtendedRangeSupported:
        defined(context) && typeof context.setHDRCanvasOutput === "function",
      sceneHdrUserSet: this._hdrUserSet === true,
      canvasOutputUserSet: this._useHDRCanvasOutputUserSet === true,
      currentSceneHdr: this._hdr === true,
      currentCanvasOutput: this._useHDRCanvasOutput === true,
    });

    let changed = false;
    if (decision.applySceneHdr) {
      const wasUserSet = this._hdrUserSet;
      this.highDynamicRange = decision.sceneHdr;
      this._hdrUserSet = wasUserSet;
      changed = true;
    }
    if (decision.applyCanvasOutput) {
      const wasUserSet = this._useHDRCanvasOutputUserSet;
      this.useHDRCanvasOutput = decision.canvasOutput;
      this._useHDRCanvasOutputUserSet = wasUserSet;
      changed = true;
    }
    return changed;
  }

  /**
   * Controls allocation and warm-up of WebGPU high-density GPU-culling,
   * occlusion, and sort-key resources.
   *
   * `'always'` eagerly warms the three compute pipelines and pre-allocates
   * their buffers before the activation threshold is crossed.
   *
   * `'auto'` initializes those resources when the activation threshold is
   * first crossed.
   *
   * `'never'` disables dispatch, prevents lazy allocation of auxiliary culler
   * instances, and releases existing auxiliary instances when the policy
   * changes.
   *
   * No-op on WebGL.
   *
   * @type {'auto' | 'always' | 'never'}
   * @default 'never'
   * @experimental This feature is experimental and may change or be removed without Cesium's standard deprecation policy.
   */
  get gpuCullingHint() {
    return this._gpuCullingHint ?? "never";
  }

  set gpuCullingHint(value) {
    const allowed = value === "always" || value === "auto" ? value : "never";
    if (this._gpuCullingHint === allowed) {
      return;
    }
    this._gpuCullingHint = allowed;
    const ctx = this._context;
    // Publish the hint to the context so direct access through its lazy
    // auxiliary-culler getters also respects `never` and cannot allocate
    // resources behind the scene-level gate.
    if (ctx && typeof ctx.setGpuCullingHint === "function") {
      ctx.setGpuCullingHint(allowed);
    }
    if (allowed === "always") {
      if (ctx && typeof ctx.warmUpHighDensityDispatchers === "function") {
        ctx.warmUpHighDensityDispatchers(
          ctx.drawingBufferWidth || 1920,
          ctx.drawingBufferHeight || 1080,
          16384,
        );
      }
    }
  }

  /**
   * Whether or not the camera is underneath the globe.
   * @type {boolean}
   * @readonly
   * @default false
   */
  get cameraUnderground() {
    return this._cameraUnderground;
  }

  /**
   * The sample rate of multisample antialiasing (values greater than 1 enable MSAA).
   * @type {number}
   * @default 4
   */
  get msaaSamples() {
    return this._msaaSamples;
  }

  set msaaSamples(value) {
    value = Math.min(value, this.context.limits.maximumSamples);
    this._msaaSamples = value;
  }

  /**
   * Returns <code>true</code> if the Scene's context supports MSAA.
   * @type {boolean}
   * @readonly
   */
  get msaaSupported() {
    return this._context.msaa;
  }

  /**
   * When true and using the WebGPU renderer, screen-space reflections (SSR)
   * are composited after geometry rendering. Adds a full-screen ray-march pass.
   * Has no effect on the WebGL path.
   *
   * @type {boolean}
   * @default false
   *
   * @example
   * // Enable screen-space reflections (WebGPU only)
   * scene.enableSSR = true;
   */
  get enableSSR() {
    return this._enableSSR;
  }

  set enableSSR(value) {
    this._enableSSR = value;
  }

  /**
   * When true and using the WebGPU renderer, an NPR (non-photorealistic
   * rendering) outline pass paints silhouette and crease edges over the
   * scene by reading the G-buffer normal-roughness texture + scene
   * depth. Off by default — hard outlines clash with photorealistic
   * globe presentations; intended for technical / engineering /
   * CAD-style visualizations. Has no effect on the WebGL path.
   *
   * Tunable via {@link Scene#nprNormalThreshold},
   * {@link Scene#nprDepthThreshold}, {@link Scene#nprEdgeStrength},
   * {@link Scene#nprEdgeColor}.
   *
   * @type {boolean}
   * @default false
   *
   * @example
   * // Enable NPR outlines (WebGPU only)
   * scene.enableNPROutlines = true;
   * scene.nprEdgeStrength = 0.7;
   */
  get enableNPROutlines() {
    return this._enableNPROutlines;
  }

  set enableNPROutlines(value) {
    this._enableNPROutlines = value;
  }

  /**
   * When true and using the WebGPU renderer, runs a screen-space
   * contact-shadows post-process pass that reads the G-buffer normal
   * + scene depth, marches the sun direction in eye-space, and
   * darkens fragments where a screen-space occluder lies within the
   * marched distance. Cheap silhouette darkening for grounded objects
   * (foliage bases, vehicle wheels, building bases meeting ground).
   * Has no effect on the WebGL path.
   *
   * Tunable via {@link Scene#contactShadowMaxDistance},
   * {@link Scene#contactShadowSteps},
   * {@link Scene#contactShadowStrength},
   * {@link Scene#contactShadowThickness}.
   *
   * @type {boolean}
   * @default false
   *
   * @example
   * // Enable contact shadows (WebGPU only)
   * scene.enableContactShadows = true;
   * scene.contactShadowStrength = 0.6;
   */
  get enableContactShadows() {
    return this._enableContactShadows;
  }

  set enableContactShadows(value) {
    this._enableContactShadows = value;
  }

  /**
   * Requests Forward+ clustered lighting when `scene.lights` or a model's
   * `lightsFromGltf` contains punctual lights. WebGPU prepares cluster bounds
   * and assignments for participating material pipelines, with up to 1024
   * scene-wide lights and 256 lights per cluster. WebGL ignores this option.
   *
   * @type {boolean}
   * @default false
   *
   * @example
   * scene.lights.add(new Cesium.PointLight({
   *   position: Cesium.Cartesian3.fromDegrees(-75, 40, 100),
   *   color: Cesium.Color.YELLOW,
   *   range: 200,
   * }));
   * scene.clusteredLightingEnabled = true;
   */
  get clusteredLightingEnabled() {
    return this._clusteredLightingEnabled;
  }

  set clusteredLightingEnabled(value) {
    this._clusteredLightingEnabled = value;
  }

  /**
   * When true and using the WebGPU renderer, GPU-computed weather particles
   * (rain, snow, fog, hail) are rendered as a camera-relative overlay.
   * Has no effect on the WebGL path. Configure weather type and intensity
   * with {@link Scene#weatherType} and {@link Scene#weatherIntensity}.
   *
   * @type {boolean}
   * @default false
   *
   * @example
   * // Enable rain
   * scene.enableWeather = true;
   * scene.weatherType = 0; // 0=rain, 1=snow, 2=fog, 3=hail
   * scene.weatherIntensity = 0.7;
   */
  get enableWeather() {
    return this._enableWeather;
  }

  set enableWeather(value) {
    this._enableWeather = value;
  }

  /**
   * The type of weather particles to render when {@link Scene#enableWeather}
   * is true. Only active with the WebGPU renderer.
   * <ul>
   *   <li>0 — Rain</li>
   *   <li>1 — Snow</li>
   *   <li>2 — Fog particles</li>
   *   <li>3 — Hail</li>
   * </ul>
   *
   * @type {number}
   * @default 0
   */
  get weatherType() {
    return this._weatherType;
  }

  set weatherType(value) {
    this._weatherType = value;
  }

  /**
   * Weather particle density/intensity (0.0 = none, 1.0 = maximum).
   * Controls how many particles are emitted per frame.
   *
   * @type {number}
   * @default 0.5
   */
  get weatherIntensity() {
    return this._weatherIntensity;
  }

  set weatherIntensity(value) {
    this._weatherIntensity = Math.max(0.0, Math.min(1.0, value));
  }

  /**
   * Wind speed in meters/second applied to weather particles.
   *
   * @type {number}
   * @default 10.0
   */
  get weatherWindSpeed() {
    return this._weatherWindSpeed;
  }

  set weatherWindSpeed(value) {
    this._weatherWindSpeed = value;
  }

  /**
   * Wind direction as a 2D vector {x, y} where x=east, y=north.
   * Normalized internally by the weather renderer.
   *
   * @type {object}
   * @default { x: 0.7, y: 0.3 }
   */
  get weatherWindDirection() {
    return this._weatherWindDirection;
  }

  set weatherWindDirection(value) {
    this._weatherWindDirection = value;
  }

  /**
   * Ratio between a pixel and a density-independent pixel. Provides a standard unit of
   * measure for real pixel measurements appropriate to a particular device.
   *
   * @type {number}
   * @default 1.0
   * @private
   */
  get pixelRatio() {
    return this._frameState.pixelRatio;
  }

  set pixelRatio(value) {
    this._frameState.pixelRatio = value;
  }

  /**
   * @private
   */
  get opaqueFrustumNearOffset() {
    return 0.9999;
  }

  /**
   * @private
   */
  get globeHeight() {
    return this._globeHeight;
  }

  /**
   * The render scheduler manages layered sorting, material batching,
   * predictive sort queries, and render layer configuration.
   *
   * Access this to configure render layers, set custom sort modes,
   * enable/disable depth clear between layers, and debug render order.
   *
   * @type {RenderScheduler}
   * @readonly
   *
   * @example
   * // Configure the Annotations layer to always render on top
   * const annotations = scene.renderScheduler.layers.getByName('Annotations');
   * annotations.clearDepth = true;
   *
   * // Add a custom layer for sensor overlays
   * scene.renderScheduler.layers.create({
   *   name: 'Sensors',
   *   order: 60,
   *   clearDepth: true,
   *   opaqueSortMode: Cesium.SortMode.NONE,
   * });
   *
   * // Debug: explain why entity A renders behind entity B
   * console.log(scene.renderScheduler.explainRenderOrder(commandA, commandB, camera.positionWC));
   */
  get renderScheduler() {
    return this._renderScheduler;
  }

  /**
   * Determines if a compressed texture format is supported.
   * @param {string} format The texture format. May be the name of the format or the WebGL extension name, e.g. s3tc or WEBGL_compressed_texture_s3tc.
   * @return {boolean} Whether or not the format is supported.
   */
  getCompressedTextureFormatSupported(format) {
    const context = this.context;
    return (
      ((format === "WEBGL_compressed_texture_s3tc" || format === "s3tc") &&
        context.s3tc) ||
      ((format === "WEBGL_compressed_texture_pvrtc" || format === "pvrtc") &&
        context.pvrtc) ||
      ((format === "WEBGL_compressed_texture_etc" || format === "etc") &&
        context.etc) ||
      ((format === "WEBGL_compressed_texture_etc1" || format === "etc1") &&
        context.etc1) ||
      ((format === "WEBGL_compressed_texture_astc" || format === "astc") &&
        context.astc) ||
      ((format === "EXT_texture_compression_bptc" || format === "bc7") &&
        context.bc7)
    );
  }

  /**
   * @private
   */
  updateDerivedCommands(command, scheduleFinalShaderProgram = false) {
    const { derivedCommands } = command;
    if (!defined(derivedCommands)) {
      // Is not a DrawCommand
      return;
    }

    // Native WebGPU commands own their pick, depth, shadow, HDR, and OIT
    // variants. Running the WebGL factories below would build DrawCommands
    // whose shaderProgram/vertexArray state cannot execute on WebGPU.
    if (command.isWebGPUDrawCommand === true) {
      return;
    }

    const isWebGLCommand =
      !this._alternateSceneRenderer && command.isWebGPUDrawCommand !== true;
    const scheduleWebGLFinalShaderProgram =
      scheduleFinalShaderProgram && isWebGLCommand;
    const frameState = this._frameState;
    const { shadowState, useLogDepth } = this._frameState;
    const context = this._context;

    // Update derived commands when any shadow maps become dirty
    let shadowsDirty = false;
    const lastDirtyTime = shadowState.lastDirtyTime;
    if (command.lastDirtyTime !== lastDirtyTime) {
      command.lastDirtyTime = lastDirtyTime;
      command.dirty = true;
      shadowsDirty = true;
    }

    const useHdr = this._hdr;
    const hasLogDepthDerivedCommands = defined(derivedCommands.logDepth);
    const hasHdrCommands = defined(derivedCommands.hdr);
    const hasDerivedCommands = defined(derivedCommands.originalCommand);
    const needsLogDepthDerivedCommands =
      useLogDepth && !hasLogDepthDerivedCommands;
    // Keep the WebGL Moon's base program when its physical-depth route moves
    // the command from the environment pass into the opaque pass. Deriving an
    // HDR variant only on the depth route would switch gamma conventions and
    // cause a brightness pop. WebGPU handles this convention in its native
    // pipeline.
    const skipHdrDerivedCommand = command._moonPhysicalDepthRoute === true;
    const needsHdrCommands =
      useHdr && !skipHdrDerivedCommand && !hasHdrCommands;
    const needsDerivedCommands =
      (!useLogDepth || !useHdr) && !hasDerivedCommands;
    const needsUpdateForMetadataPicking =
      frameState.pickingMetadata &&
      pickedMetadataInfoChanged(command, frameState);
    let needsUpdateForSnap = false;
    if (frameState.passes.snap) {
      // Snap dispatch selects the log-depth clone before selecting its snap
      // variant. Inspect that exact tree: the base command may already have a
      // snap derivative while a log-depth clone created during an ordinary
      // render does not (for example after toggling logarithmicDepthBuffer).
      // Keep this selection inside the rare snap branch so ordinary camera
      // binning pays no optional-chain or derived-tree traversal cost.
      const snapDerivedCommands =
        useLogDepth && defined(derivedCommands.logDepth?.command)
          ? derivedCommands.logDepth.command.derivedCommands
          : derivedCommands;
      needsUpdateForSnap =
        (defined(command.snapId) && !defined(snapDerivedCommands.snapping)) ||
        (!defined(command.snapId) &&
          !command.pickOnly &&
          !defined(snapDerivedCommands.snappingOccluder));
    }
    command.dirty =
      command.dirty ||
      needsLogDepthDerivedCommands ||
      needsHdrCommands ||
      needsDerivedCommands ||
      needsUpdateForMetadataPicking ||
      needsUpdateForSnap;

    if (!command.dirty) {
      // Camera-visible commands revisit this method after their exact derived
      // tree has already been built. Keep polling/scheduling that final
      // executable until it finishes linking without rebuilding any derived
      // commands. Off-camera and alternate-renderer paths pass false; pick and
      // debug paths remain conservatively rejected by the scheduler.
      if (scheduleWebGLFinalShaderProgram) {
        scheduleFinalWebGLShaderProgram(this, command);
      }
      return;
    }

    if (isWebGLCommand) {
      // Any derived-tree rebuild can replace the selected final command while
      // retaining the same base program and frame selector. Clear strong
      // references too: an off-camera rebuild must not pin a displaced tree.
      command._webGLFinalShaderProgramBase = undefined;
      command._webGLFinalShaderProgramCommand = undefined;
      command._webGLFinalShaderProgram = undefined;
      command._webGLFinalShaderProgramSelector = -1;
      command._webGLFinalShaderProgramLinkState = undefined;
    }
    command.dirty = false;

    const { shadowsEnabled, shadowMaps } = shadowState;
    if (shadowsEnabled && command.castShadows) {
      derivedCommands.shadows = ShadowMap.createCastDerivedCommand(
        shadowMaps,
        command,
        shadowsDirty,
        context,
        derivedCommands.shadows,
      );
    }

    if (
      (hasLogDepthDerivedCommands || needsLogDepthDerivedCommands) &&
      !command.isWebGPUDrawCommand
    ) {
      // WebGPU draw commands lack the WebGL-style `shaderProgram.id`, and a
      // WebGL log-depth clone would recurse into `WebGPUContext.draw` with an
      // incompatible command. WebGPU pipelines provide their own WGSL
      // log-depth entry point, so only WebGL commands use this helper.
      derivedCommands.logDepth = DerivedCommand.createLogDepthCommand(
        command,
        context,
        derivedCommands.logDepth,
      );
      // DrawCommand.shallowClone intentionally copies only declared command
      // fields, so carry this private route marker onto the log-depth clone
      // before its recursive HDR derivation decision. Without this handoff,
      // the base command skips HDR as intended but the selected log clone
      // immediately recreates it and the Moon still changes brightness.
      derivedCommands.logDepth.command._moonPhysicalDepthRoute =
        command._moonPhysicalDepthRoute === true;
      updateDerivedCommands(
        this,
        derivedCommands.logDepth.command,
        shadowsDirty,
      );
    }
    if (hasDerivedCommands || needsDerivedCommands) {
      updateDerivedCommands(this, command, shadowsDirty);
    }

    if (scheduleWebGLFinalShaderProgram) {
      scheduleFinalWebGLShaderProgram(this, command);
    }
  }

  /**
   * @private
   * @param {FrameState.Passes} passes
   */
  clearPasses(passes) {
    passes.render = false;
    passes.pick = false;
    passes.pickVoxel = false;
    passes.snap = false;
    passes.depth = false;
    passes.postProcess = false;
    passes.offscreen = false;
  }

  /**
   * @private
   */
  updateFrameState() {
    const camera = this.camera;

    const frameState = this._frameState;
    frameState.commandList.length = 0;
    frameState.shadowMaps.length = 0;
    frameState.panoramaCommandList.length = 0;
    frameState.brdfLutGenerator = this._brdfLutGenerator;
    frameState.environmentMap = this.skyBox && this.skyBox._cubeMap;
    frameState.mode = this._mode;
    frameState.morphTime = this.morphTime;
    frameState.mapProjection = this.mapProjection;
    frameState.view = this._view;
    frameState.camera = camera;
    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    frameState.occluder = getOccluder(this);
    frameState.minimumTerrainHeight = 0.0;
    frameState.minimumDisableDepthTestDistance =
      this._minimumDisableDepthTestDistance;
    frameState.invertClassification = this.invertClassification;
    // Publish the deferred-lighting option so WebGPU can gate its
    // depth-derived normal producer. WebGL ignores the value.
    frameState.useDeferredLighting = this.deferredLighting === true;
    // Publish the normal-overlay toggle after the producer option. The
    // depth-derived G-buffer requires `deferredLighting`; an overlay without a
    // producer uses the magenta missing-producer fallback.
    frameState.debugShowGBufferNormals = this.debugShowGBufferNormals === true;
    frameState.useLogDepth =
      this._logDepthBuffer &&
      !(
        this.camera.frustum instanceof OrthographicFrustum ||
        this.camera.frustum instanceof OrthographicOffCenterFrustum
      );
    frameState.highDynamicRange = this._hdr;
    frameState.light = this.light;
    // While WebGPU aerial perspective uses a SunLight, derive model PBR sun
    // and sky lighting from the same atmosphere that supplies post-process
    // extinction and inscatter to all scene pixels, including terrain and
    // models. Custom lights and `scene.light` remain unchanged; derived values
    // live only on the private FrameState light and sky-irradiance fields.
    // The sun direction comes from `uniformState`, which this frame has not
    // updated yet, so it lags by one frame — indistinguishable at any
    // realistic simulation rate.
    frameState.atmosphereSkyIrradiance = undefined;
    if (
      this.aerialPerspective === true &&
      this.isWebGPU &&
      this.light instanceof SunLight
    ) {
      const us = this._context?.uniformState;
      const sunDir = us?.sunDirectionWC;
      const cameraPos = this.camera?.positionWC;
      if (defined(sunDir) && defined(cameraPos)) {
        const altitude = this.camera?.positionCartographic?.height ?? 0.0;
        const baseIntensity = this.light.intensity ?? 2.0;
        const lightIntensity =
          this.skyAtmosphere?.atmosphereLightIntensity ?? 50.0;
        // The normalized camera position is the local surface normal. Measuring
        // the Sun zenith against it follows the viewed location's time of day
        // instead of the ellipsoid's pole axis.
        const localUp = Cartesian3.normalize(cameraPos, scratchAtmosphereUp);
        const derived = computeAtmosphereDerivedLighting(
          sunDir,
          localUp,
          altitude,
          lightIntensity,
          baseIntensity,
        );
        const dl = this._atmosphereDerivedLight;
        dl.color.red = derived.sunColor.x;
        dl.color.green = derived.sunColor.y;
        dl.color.blue = derived.sunColor.z;
        dl.color.alpha = 1.0;
        dl.intensity = derived.sunIntensity;
        frameState.light = dl;
        Cartesian3.clone(derived.skyIrradiance, this._atmosphereSkyIrradiance);
        frameState.atmosphereSkyIrradiance = this._atmosphereSkyIrradiance;
      }
    }
    frameState.lights = this.lights;
    frameState.cameraUnderground = this._cameraUnderground;
    // Publish current CSM intent before models, primitives, and globe commands
    // prepare their effects bindings. The renderer object persists after its
    // first use, so its mere existence cannot distinguish an active CSM frame
    // from a later toggle-off or non-3D frame.
    frameState.useCascadedShadowMaps =
      this.useCascadedShadowMaps === true && this._mode === SceneMode.SCENE3D;
    // Shared scene truth, published before model / tileset updates can invoke
    // renderer-specific environment capture. A retained prior-frame terrain
    // list is not renderable while the owning globe is hidden.
    frameState.globeVisible = defined(this.globe) && this.globe.show;
    frameState.globeTranslucencyState = this._globeTranslucencyState;
    // Publish HDR state so downstream packers can skip inline terrain
    // tonemapping and leave final compression to the post-process chain.
    frameState.useHDR = this._hdr === true;
    // Publish TAA state through FrameState so velocity emitters share one
    // backend-neutral value.
    frameState.taaEnabled = this.taaEnabled === true;
    // Publish aerial-perspective state so WebGPU disables the globe's local
    // distance-haze drape while the post-process owns extinction and inscatter,
    // avoiding a double application. WebGL ignores the value.
    frameState.aerialPerspective = this.aerialPerspective === true;
    // Publish the snapshot-mode service through FrameState for environment
    // renderer registrations.
    frameState.snapshotMode = this._snapshotMode;
    // Publish triangulation intent for renderers that provide a face-color
    // fragment variant; each renderer applies its own capability gate.
    frameState.debugShowTriangulation = this.debugShowTriangulation === true;
    // Forward the globe-wireframe toggle to the WebGPU surface renderer.
    // WebGL renderers ignore it.
    frameState.debugShowGlobeWireframe = this.debugShowGlobeWireframe === true;
    // Forward the scattering-bypass toggle to the WebGPU sky-atmosphere
    // renderer, which emits flat magenta over the shell when enabled.
    frameState.debugDisableAtmosphereScattering =
      this.debugDisableAtmosphereScattering === true;
    // Forward cubemap face isolation to the WebGPU panorama renderer. Zero
    // selects all faces; values 1 through 6 select one face.
    frameState.debugShowCubeMapFace = this.debugShowCubeMapFace | 0;
    // The terrain LOD overlay is mutually exclusive with triangulation and
    // normal modes because the renderer selects one fragment variant.
    frameState.debugShowTerrainLOD = this.debugShowTerrainLOD === true;
    // Publish the eye-space normal visualization toggle.
    frameState.debugShowTerrainNormals = this.debugShowTerrainNormals === true;
    // A value of -1 disables imagery-layer isolation and renders all layers.
    // The terrain fragment shader applies this as a per-layer alpha mask.
    frameState.debugShowImageryLayer =
      typeof this.debugShowImageryLayer === "number"
        ? this.debugShowImageryLayer
        : -1;
    // Publish the imagery diagnostic toggle. The WebGPU globe renderer logs at
    // most four tile updates, and a false-to-true edge re-arms the capture.
    frameState.debugShowImageryProbe = this.debugShowImageryProbe === true;
    // The depth-as-color overlay replaces the post-process chain.
    // Mode integer selects linearized vs raw vs combined visualization.
    frameState.debugShowDepthAsColor = this.debugShowDepthAsColor === true;
    frameState.debugDepthAsColorMode = this.debugDepthAsColorMode | 0;
    // Windowed depth-overlay band (meters of eye-space distance) + colormap.
    frameState.debugDepthWindowMin = this.debugDepthWindowMin || 0.0;
    frameState.debugDepthWindowMax = this.debugDepthWindowMax || 0.0;
    frameState.debugDepthWindowTurbo = this.debugDepthWindowTurbo !== false;
    // Publish frustum and command visualization. WebGL's SceneRenderer
    // reads these directly from `scene.*` for the DebugInspector path, and
    // the WebGPU scene renderer reads them from `frameState.*` when deciding
    // whether to run `WebGPUDebugFrustumOverlay` after the main scene pass.
    frameState.debugShowFrustums = this.debugShowFrustums === true;
    frameState.debugShowCommands = this.debugShowCommands === true;

    const { globe } = this;
    if (defined(globe) && globe._terrainExaggerationChanged) {
      // Honor a user-set value for the old deprecated globe.terrainExaggeration.
      // This can be removed when Globe.terrainExaggeration is removed.
      this.verticalExaggeration = globe._terrainExaggeration;
      this.verticalExaggerationRelativeHeight =
        globe._terrainExaggerationRelativeHeight;
      globe._terrainExaggerationChanged = false;
    }
    frameState.verticalExaggeration = this.verticalExaggeration;
    frameState.verticalExaggerationRelativeHeight =
      this.verticalExaggerationRelativeHeight;

    if (
      defined(this._specularEnvironmentCubeMap) &&
      this._specularEnvironmentCubeMap.ready
    ) {
      frameState.specularEnvironmentMaps =
        this._specularEnvironmentCubeMap.texture;
      frameState.specularEnvironmentMapsMaximumLOD =
        this._specularEnvironmentCubeMap.maximumMipmapLevel;
    } else {
      frameState.specularEnvironmentMaps = undefined;
      frameState.specularEnvironmentMapsMaximumLOD = undefined;
    }

    frameState.sphericalHarmonicCoefficients =
      this.sphericalHarmonicCoefficients;

    this._actualInvertClassificationColor = Color.clone(
      this.invertClassificationColor,
      this._actualInvertClassificationColor,
    );
    if (!InvertClassification.isTranslucencySupported(this._context)) {
      this._actualInvertClassificationColor.alpha = 1.0;
    }

    frameState.invertClassificationColor =
      this._actualInvertClassificationColor;

    if (defined(this.globe)) {
      frameState.maximumScreenSpaceError = this.globe.maximumScreenSpaceError;
    } else {
      frameState.maximumScreenSpaceError = 2;
    }

    this.clearPasses(frameState.passes);

    frameState.tilesetPassState = undefined;
    if (
      (this._activeCelestialEphemerisProvider !==
        this._celestialEphemerisProvider ||
        this._activeCelestialEphemerisProviderIsImplicit !==
          this._celestialEphemerisProviderIsImplicit) &&
      this._celestialEphemerisProviderSetFrameNumber !== frameState.frameNumber
    ) {
      this._activeCelestialEphemerisProvider = this._celestialEphemerisProvider;
      this._activeCelestialEphemerisProviderIsImplicit =
        this._celestialEphemerisProviderIsImplicit;
    }

    // The central-body transform is a documented override point. The
    // Scene-owned Simon provider is Earth-fixed, so an override must retain
    // the built-in Earth-fixed derivation instead of publishing those Earth
    // coordinates as central-body coordinates. Snapshot the decision once
    // per logical frame so a mid-frame override/restoration cannot split main,
    // pick, and offscreen Views across two lineages. User-supplied providers
    // remain authoritative ECEF inputs regardless of this override hook.
    if (
      this._celestialEphemerisTransformFrameNumber !== frameState.frameNumber
    ) {
      this._celestialEphemerisTransformFrameNumber = frameState.frameNumber;
      const centralBodyTransform =
        Transforms.computeIcrfToCentralBodyFixedMatrix;
      this._activeCelestialEphemerisLegacyTransformActive =
        this._activeCelestialEphemerisProviderIsImplicit &&
        this._activeCelestialEphemerisProvider ===
          this._implicitCelestialEphemerisProvider &&
        centralBodyTransform !==
          Transforms._computeIcrfToCentralBodyFixedMatrixDefault;
      this._activeCelestialEphemerisLegacyTransform = this
        ._activeCelestialEphemerisLegacyTransformActive
        ? centralBodyTransform
        : undefined;
    }
    frameState._updateCelestialEphemeris(
      this._activeCelestialEphemerisProvider,
      frameState.time,
      this._activeCelestialEphemerisLegacyTransformActive,
      this._activeCelestialEphemerisLegacyTransform,
    );
    prepareLogicalViewEclipse(this);
  }

  /**
   * Check whether a draw command will render anything visible in the current Scene,
   * based on its bounding volume.
   *
   * @param {CullingVolume} cullingVolume The culling volume of the current Scene.
   * @param {DrawCommand} [command] The draw command
   * @param {Occluder} [occluder] An occluder that may be in front of the command's bounding volume.
   * @returns {boolean} <code>true</code> if the command's bounding volume is visible in the scene.
   *
   * @private
   */
  isVisible(cullingVolume, command, occluder) {
    if (!defined(command)) {
      return false;
    }
    const { boundingVolume } = command;
    if (!defined(boundingVolume) || !command.cull) {
      return true;
    }
    if (cullingVolume.computeVisibility(boundingVolume) === Intersect.OUTSIDE) {
      return false;
    }
    return (
      !defined(occluder) ||
      !command.occlude ||
      !boundingVolume.isOccluded(occluder)
    );
  }

  /**
   * Update and clear framebuffers, and execute draw commands.
   *
   * @param {PassState} passState State specific to each render pass.
   * @param {Color} backgroundColor
   *
   * @private
   */
  updateAndExecuteCommands(passState, backgroundColor) {
    updateAndClearFramebuffers(this, passState, backgroundColor);

    if (this._environmentState.useWebVR) {
      executeWebVRCommands(this, passState, backgroundColor);
    } else if (
      this._frameState.mode !== SceneMode.SCENE2D ||
      this._mapMode2D === MapMode2D.ROTATE
    ) {
      executeCommandsInViewport(true, this, passState);
    } else {
      execute2DViewportCommands(this, passState);
    }
  }

  /**
   * @private
   */
  updateEnvironment() {
    const frameState = this._frameState;
    const view = this._view;
    // A route transition is a one-frame TAA invalidation signal. Reset it even
    // on early environment exits so a prior frame cannot poison later history.
    frameState._moonPhysicalDepthRouteChanged = false;

    // Update celestial and terrestrial environment effects.
    const environmentState = this._environmentState;
    const renderPass = frameState.passes.render;
    const offscreenPass = frameState.passes.offscreen;
    const atmosphere = this.atmosphere;
    const skyAtmosphere = this.skyAtmosphere;
    const globe = this.globe;
    const globeTranslucencyState = this._globeTranslucencyState;
    // Preserve the original unconditional clear policy for render, pick,
    // offscreen, orthographic and environment-hidden frames alike. Moon reads
    // the same resolved value only on the branch where Moon.update runs.
    const clearGlobeDepth =
      defined(globe) &&
      globe.show &&
      (!globe.depthTestAgainstTerrain || this.mode === SceneMode.SCENE2D);
    environmentState.clearGlobeDepth = clearGlobeDepth;
    environmentState.moonDepthRouteState.clearGlobeDepth = clearGlobeDepth;

    if (
      !renderPass ||
      (this._mode !== SceneMode.SCENE2D &&
        view.camera.frustum instanceof OrthographicFrustum) ||
      !globeTranslucencyState.environmentVisible
    ) {
      environmentState.skyAtmosphereCommand = undefined;
      environmentState.skyBoxCommand = undefined;
      environmentState.starFieldCommand = undefined;
      environmentState.sunDrawCommand = undefined;
      environmentState.sunComputeCommand = undefined;
      environmentState.moonCommand = undefined;
      environmentState.isSkyAtmosphereVisible = false;
      frameState.skyAtmosphereVisible = false;
      // No celestial consumer runs on this path, so clear the glare resolution
      // so later consumers cannot read stale state.
      frameState.solarGlareAppearance = undefined;
      // Clear the halo because stale state can retain a visible screen position
      // and make post-process consumers paint a halo over a frame with no Sun.
      frameState.sunHalo = undefined;
      frameState.sunBloomActive = false;
    } else {
      // Resolve atmosphere applicability before any celestial consumer runs.
      // The constructor/show flag alone is not authoritative while a globe is
      // still waiting for its first renderable tile. Both renderers read
      // this same-frame value, so extinction and default-on star modulation
      // never model an atmosphere shell that the scene has skipped.
      if (defined(skyAtmosphere)) {
        if (defined(globe)) {
          skyAtmosphere.setDynamicLighting(
            DynamicAtmosphereLightingType.fromGlobeFlags(globe),
          );
          environmentState.isReadyForAtmosphere =
            environmentState.isReadyForAtmosphere ||
            !globe.show ||
            globe._surface._tilesToRender.length > 0;
        } else {
          const dynamicLighting = atmosphere.dynamicLighting;
          skyAtmosphere.setDynamicLighting(dynamicLighting);
          environmentState.isReadyForAtmosphere = true;
        }
      }
      frameState.skyAtmosphereVisible =
        defined(skyAtmosphere) &&
        skyAtmosphere.show === true &&
        (frameState.mode === SceneMode.SCENE3D ||
          frameState.mode === SceneMode.MORPHING) &&
        environmentState.isReadyForAtmosphere;

      // Update the Moon before the sky atmosphere so sky, fog, and night
      // lighting read the current direction and phase. Store its draw command
      // for later execution; the Sun direction is already available through
      // UniformState.
      // A hidden/absent Moon must not leave the previous frame's phase active
      // in default-on sky brightness. Keep the reusable direction storage but
      // reset its scalar contribution before the update; a visible Moon
      // overwrites it with current ephemeris data below.
      frameState.moonPhaseFraction = 0.0;
      // Resolve globe-depth clearing before Moon.update so its backend-neutral
      // route can decide whether to compare against packed pre-clear depth.
      // Reuse the same decision throughout the environment pipeline.
      environmentState.moonCommand = defined(this.moon)
        ? this.moon.update(frameState, environmentState.moonDepthRouteState)
        : undefined;

      // Derive brightness after Moon.update publishes the current direction
      // and phase because request-render mode and stepped clocks may not
      // provide another frame to repair stale values. Supply ellipsoidal height
      // directly to avoid an Earth-specific radius at the atmospheric boundary.
      frameState.skyBrightness =
        computeSkyBrightness(
          frameState.context.uniformState.sunDirectionWC,
          frameState.moonDirectionWC,
          frameState.moonPhaseFraction ?? 1.0,
          frameState.camera?.positionWC,
          frameState.camera?.positionCartographic?.height,
        ) * (frameState.eclipseSceneLightFactor ?? 1.0);

      // Resolve angular solar glare before skyBox.update and starField.update
      // so every shader consumer reads one value instead of independently
      // deriving the Sun direction. This remains separate from sky brightness:
      // atmospheric-column glow is inert in orbit, while veiling glare follows
      // the observer. See `Scene/SolarGlareAppearance.js`.
      if (!defined(this._solarGlareAppearance)) {
        this._solarGlareAppearance = createSolarGlareAppearance();
      }
      // updateFrameState publishes `frameState.eclipseState` before this
      // function because glare resolution consumes the current eclipse state.
      frameState.solarGlareAppearance = readSolarGlareAppearance(
        frameState.atmosphericConditions?.lighting,
        frameState.context.uniformState.sunDirectionWC,
        frameState.context.uniformState.temeToPseudoFixedMatrix,
        frameState.eclipseState,
        this._solarGlareAppearance,
      );

      if (defined(skyAtmosphere)) {
        environmentState.skyAtmosphereCommand = skyAtmosphere.update(
          frameState,
          globe,
        );
        if (defined(environmentState.skyAtmosphereCommand)) {
          this.updateDerivedCommands(
            environmentState.skyAtmosphereCommand,
            true,
          );
        }
      } else {
        environmentState.skyAtmosphereCommand = undefined;
      }
      environmentState.isSkyAtmosphereVisible =
        defined(environmentState.skyAtmosphereCommand) &&
        environmentState.isReadyForAtmosphere;
      frameState.skyAtmosphereVisible = environmentState.isSkyAtmosphereVisible;

      environmentState.skyBoxCommand = defined(this.skyBox)
        ? this.skyBox.update(frameState, this._hdr)
        : undefined;
      // Update the bright-star catalog separately from SkyBox so its reusable
      // command executes after the cubemap and before the atmosphere. This
      // draws additive HDR stars over the cubemap while preserving atmospheric
      // occlusion.
      const starField =
        defined(this.skyBox) && defined(this.skyBox.starField)
          ? this.skyBox.starField
          : undefined;
      const starCommand = defined(starField)
        ? starField.update(frameState)
        : undefined;
      // The environment-demand predicate reads this returned command, which
      // retains a far frustum for WebGPU sky-only views without duplicating the
      // command-list entry.
      environmentState.starFieldCommand = starCommand;
      // Publish solar-halo post-process activity before Sun.update because Sun
      // has no Scene reference. Resolve it before the backend branch so both
      // halo paths use the same bake gain.
      //
      // `scene.sunBloom` controls both SunPostProcess on WebGL and
      // SunHaloEffect on WebGPU. WebVR excludes the halo path.
      frameState.sunBloomActive =
        this.sunBloom === true && this._useWebVR !== true;
      // Reset before Sun.update because its early-return paths otherwise leave
      // a visible halo and old screen position for post-process consumers.
      frameState.sunHalo = undefined;
      const sunCommands = defined(this.sun)
        ? this.sun.update(frameState, view.passState, this._hdr)
        : undefined;
      environmentState.sunDrawCommand = defined(sunCommands)
        ? sunCommands.drawCommand
        : undefined;
      environmentState.sunComputeCommand = defined(sunCommands)
        ? sunCommands.computeCommand
        : undefined;
    }

    // Reuse the clear-depth decision resolved before Moon.update so its packed
    // depth comparison and the remaining pipeline cannot diverge.
    const useDepthPlane = (environmentState.useDepthPlane =
      clearGlobeDepth &&
      this.mode === SceneMode.SCENE3D &&
      globeTranslucencyState.useDepthPlane &&
      // The debug toggle omits the ellipsoid depth plane to isolate whether its
      // writes occlude terrain-flush content. Its default leaves both backend
      // paths unchanged.
      this.debugSkipDepthPlane !== true);
    if (useDepthPlane) {
      // Update the depth plane that is rendered in 3D when the primitives are
      // not depth tested against terrain so primitives on the backface
      // of the globe are not picked.
      this._depthPlane.update(frameState);
    }

    environmentState.renderTranslucentDepthForPick = false;
    environmentState.useWebVR =
      this._useWebVR && this.mode !== SceneMode.SCENE2D && !offscreenPass;

    const occluder =
      frameState.mode === SceneMode.SCENE3D &&
      !globeTranslucencyState.sunVisibleThroughGlobe
        ? frameState.occluder
        : undefined;
    let cullingVolume = frameState.cullingVolume;

    // get user culling volume minus the far plane.
    const planes = scratchCullingVolume.planes;
    for (let k = 0; k < 5; ++k) {
      planes[k] = cullingVolume.planes[k];
    }
    cullingVolume = scratchCullingVolume;

    // Determine visibility of celestial and terrestrial environment effects.
    environmentState.isSkyAtmosphereVisible =
      defined(environmentState.skyAtmosphereCommand) &&
      environmentState.isReadyForAtmosphere;
    frameState.skyAtmosphereVisible = environmentState.isSkyAtmosphereVisible;
    environmentState.isSunVisible = this.isVisible(
      cullingVolume,
      environmentState.sunDrawCommand,
      occluder,
    );
    environmentState.isMoonVisible = this.isVisible(
      cullingVolume,
      environmentState.moonCommand,
      occluder,
    );

    const envMaps = this.specularEnvironmentMaps;
    const specularEnvironmentCubeMap = this._specularEnvironmentCubeMap;
    if (defined(envMaps) && specularEnvironmentCubeMap?.url !== envMaps) {
      if (defined(specularEnvironmentCubeMap)) {
        specularEnvironmentCubeMap.destroy();
      }
      this._specularEnvironmentCubeMap = new SpecularEnvironmentCubeMap(
        envMaps,
      );
    } else if (!defined(envMaps) && defined(specularEnvironmentCubeMap)) {
      specularEnvironmentCubeMap.destroy();
      this._specularEnvironmentCubeMap = undefined;
    }

    if (defined(this._specularEnvironmentCubeMap)) {
      this._specularEnvironmentCubeMap.update(frameState);
    }
  }

  /**
   * @private
   */
  resolveFramebuffers(passState) {
    resolveFramebuffersImpl(this, passState);
  }

  /**
   * Gets the height of the loaded surface at the cartographic position.
   * @param {Cartographic} cartographic The cartographic position.
   * @param {HeightReference} [heightReference=CLAMP_TO_GROUND] Based on the height reference value, determines whether to ignore heights from 3D Tiles or terrain.
   * @private
   */
  getHeight(cartographic, heightReference) {
    if (!defined(cartographic)) {
      return undefined;
    }

    const ignore3dTiles =
      heightReference === HeightReference.CLAMP_TO_TERRAIN ||
      heightReference === HeightReference.RELATIVE_TO_TERRAIN;

    const ignoreTerrain =
      heightReference === HeightReference.CLAMP_TO_3D_TILE ||
      heightReference === HeightReference.RELATIVE_TO_3D_TILE;

    if (!defined(cartographic)) {
      return;
    }

    let maxHeight = Number.NEGATIVE_INFINITY;

    if (!ignore3dTiles) {
      const maxPrimitiveHeight = getMaxPrimitiveHeight(
        this.primitives,
        cartographic,
        this,
      );
      if (defined(maxPrimitiveHeight) && maxPrimitiveHeight > maxHeight) {
        maxHeight = maxPrimitiveHeight;
      }
    }

    const globe = this._globe;
    if (!ignoreTerrain && defined(globe) && globe.show) {
      const result = globe.getHeight(cartographic);
      if (result > maxHeight) {
        maxHeight = result;
      }
    }

    if (maxHeight > Number.NEGATIVE_INFINITY) {
      return maxHeight;
    }

    return undefined;
  }

  /**
   * Calls the callback when a new tile is rendered that contains the given cartographic. The only parameter
   * is the cartesian position on the tile.
   *
   * @private
   *
   * @param {Cartographic} cartographic The cartographic position.
   * @param {Function} callback The function to be called when a new tile is loaded containing the updated cartographic.
   * @param {HeightReference} [heightReference=CLAMP_TO_GROUND] Based on the height reference value, determines whether to ignore heights from 3D Tiles or terrain.
   * @returns {Function} The function to remove this callback from the quadtree.
   */
  updateHeight(cartographic, callback, heightReference) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.func("callback", callback);
    //>>includeEnd('debug');

    const ellipsoid = this._ellipsoid;
    const callbackWrapper = (clampedCartographic) => {
      Cartographic.clone(cartographic, updateHeightScratchCartographic);

      let height;
      if (defined(clampedCartographic)) {
        height = clampedCartographic.height;
      }
      if (!defined(height)) {
        height = this.getHeight(cartographic, heightReference);
      }
      if (defined(height)) {
        updateHeightScratchCartographic.height = height;
        callback(updateHeightScratchCartographic);
      }
    };

    const ignore3dTiles =
      heightReference === HeightReference.CLAMP_TO_TERRAIN ||
      heightReference === HeightReference.RELATIVE_TO_TERRAIN;

    const ignoreTerrain =
      heightReference === HeightReference.CLAMP_TO_3D_TILE ||
      heightReference === HeightReference.RELATIVE_TO_3D_TILE;

    let terrainRemoveCallback;
    if (!ignoreTerrain && defined(this.globe)) {
      terrainRemoveCallback = this.globe._surface.updateHeight(
        cartographic,
        callbackWrapper,
      );
    }

    let tilesetRemoveCallbacks = {};
    const createPrimitiveEventListener = (primitive) => {
      if (
        ignore3dTiles ||
        primitive.isDestroyed() ||
        !primitive.isCesium3DTileset
      ) {
        return;
      }

      const tilesetRemoveCallback = primitive.updateHeight(
        cartographic,
        callbackWrapper,
        ellipsoid,
      );
      tilesetRemoveCallbacks[primitive.id] = tilesetRemoveCallback;
    };

    if (!ignore3dTiles) {
      const length = this.primitives.length;
      for (let i = 0; i < length; ++i) {
        const primitive = this.primitives.get(i);
        createPrimitiveEventListener(primitive);
      }
    }

    const removeAddedListener = this.primitives.primitiveAdded.addEventListener(
      createPrimitiveEventListener,
    );
    const removeRemovedListener =
      this.primitives.primitiveRemoved.addEventListener((primitive) => {
        if (primitive.isDestroyed() || !primitive.isCesium3DTileset) {
          return;
        }
        if (defined(tilesetRemoveCallbacks[primitive.id])) {
          tilesetRemoveCallbacks[primitive.id]();
        }
        delete tilesetRemoveCallbacks[primitive.id];
      });

    const removeCallback = () => {
      terrainRemoveCallback = terrainRemoveCallback && terrainRemoveCallback();
      Object.values(tilesetRemoveCallbacks).forEach((tilesetRemoveCallback) =>
        tilesetRemoveCallback(),
      );
      tilesetRemoveCallbacks = {};
      removeAddedListener();
      removeRemovedListener();
    };

    return removeCallback;
  }

  /**
   * @private
   */
  initializeFrame() {
    // Destroy released shaders and textures once every 120 frames to avoid thrashing the cache
    if (this._shaderFrameCount++ === 120) {
      this._shaderFrameCount = 0;
      this._context.shaderCache.destroyReleasedShaderPrograms();
      this._context.textureCache.destroyReleasedTextures();
    }

    this._tweens.update();

    if (this._globeHeightDirty) {
      if (defined(this._removeUpdateHeightCallback)) {
        this._removeUpdateHeightCallback();
        this._removeUpdateHeightCallback = undefined;
      }

      this._globeHeight = getGlobeHeight(this);
      this._globeHeightDirty = false;

      const cartographic = this.camera.positionCartographic;
      this._removeUpdateHeightCallback = this.updateHeight(
        cartographic,
        (updatedCartographic) => {
          if (this.isDestroyed()) {
            return;
          }

          this._globeHeight = updatedCartographic.height;
        },
      );
    }
    this._cameraUnderground = isCameraUnderground(this);
    this._globeTranslucencyState.update(this);

    this._screenSpaceCameraController.update();
    if (defined(this._deviceOrientationCameraController)) {
      this._deviceOrientationCameraController.update();
    }

    this.camera.update(this._mode);
    this.camera._updateCameraChanged();
  }

  /**
   * Update and render the scene. It is usually not necessary to call this function
   * directly because {@link CesiumWidget} will do it automatically.
   * @param {JulianDate} [time] The simulation time at which to render.
   */
  render(time) {
    // Check the recursion sentinel before consulting the currently installed
    // renderer. A callback may temporarily replace or disable that renderer,
    // recursively render this same Scene, and restore it without advancing the
    // frame token. That nested call must still invalidate the outer sample.
    const cpuAccountingState = cpuAccountingSceneGuard.get(this);
    if (cpuAccountingState?.active === true) {
      if (cpuAccountingState.baseEntryExpected) {
        // Consume the wrapper's one allowed entry into the immutable method.
        cpuAccountingState.baseEntryExpected = false;
      } else {
        // Any later same-Scene recursion invalidates the outer wall-clock
        // interval, including a request-render-suppressed inner call which
        // leaves the frame token unchanged. Different Scene instances have
        // independent WeakMap entries and do not trip this latch.
        cpuAccountingState.reentered = true;
      }
    }

    const cpuFrameRenderer = this._alternateSceneRenderer;
    if (cpuFrameRenderer?.cpuPassProfilingEnabled === true) {
      if (
        cpuAccountingState?.active !== true &&
        typeof cpuFrameRenderer.beginCpuSceneFrame === "function"
      ) {
        return renderSceneWithCpuAccounting(this, time, cpuFrameRenderer);
      }
    }

    // Capture the Scene.render() boundary only while an operator trace is
    // active. This trace branch pays one boolean check and does not call
    // performance.now() while inactive; the independent CPU-accounting
    // recursion sentinel above performs one WeakMap read. Sampling happens
    // after postRender so cpuMs covers the complete Scene-managed frame,
    // including update and after-render work.
    const performanceTraceStart = this._performanceTracker.active
      ? performance.now()
      : undefined;

    /**
     *
     * Pre passes update. Execute any pass invariant code that should run before the passes here.
     *
     */
    this._preUpdate.raiseEvent(this, time);

    const frameState = this._frameState;
    frameState.newFrame = false;

    // Reset render-layer, material-batching, and sorting statistics each frame.
    this._renderScheduler.beginFrame();

    if (!defined(time)) {
      time = JulianDate.now();
    }

    this._controllerHost.update(this, time);

    const cameraChanged = this._view.checkForCameraUpdates(this);
    if (cameraChanged) {
      this._globeHeightDirty = true;
    }

    // Keep request-render scenes active while foreground asynchronous work is
    // pending. Background work is excluded to avoid speculative frames, while
    // its resolution can still wake the scene through the subscription. A
    // context without the monitor contributes a zero count.
    const pendingAsyncResources =
      this._context?.asyncResources?.pendingForegroundCount ?? 0;

    // Determine if should render a new frame in request render mode
    let shouldRender =
      !this.requestRenderMode ||
      this._renderRequested ||
      cameraChanged ||
      this._logDepthBufferDirty ||
      this._hdrDirty ||
      this.mode === SceneMode.MORPHING ||
      pendingAsyncResources > 0;
    if (
      !shouldRender &&
      defined(this.maximumRenderTimeChange) &&
      defined(this._lastRenderTime)
    ) {
      const difference = Math.abs(
        JulianDate.secondsDifference(this._lastRenderTime, time),
      );
      shouldRender = shouldRender || difference > this.maximumRenderTimeChange;
    }

    // Snapshot mode coordination — fires every frame regardless of
    // shouldRender so the service can track idle frames and auto-enter
    // when `autoEnterIdleFrames` is configured. Lives outside the
    // `if (shouldRender)` block on purpose; the actual snapshot
    // version + camera-delta auto-thaw checks live inside the render
    // path because they only matter when something is actually
    // happening.
    this._snapshotMode.notifyFrame(this, shouldRender);

    if (shouldRender) {
      this._lastRenderTime = JulianDate.clone(time, this._lastRenderTime);
      // HDR and logarithmic-depth changes invalidate bundles encoded against
      // the current swap-chain attachments. Mark the snapshot dirty before
      // clearing the flags so the service can thaw during this frame.
      if (this._hdrDirty || this._logDepthBufferDirty) {
        const reason = this._hdrDirty
          ? "HDR mode changed — swap chain rebuild invalidates bundles"
          : "log-depth buffer changed — depth attachment format mismatch";
        this._snapshotMode.markDirty(reason);
      }
      this._renderRequested = false;
      this._logDepthBufferDirty = false;
      this._hdrDirty = false;

      const frameNumber = CesiumMath.incrementWrap(
        frameState.frameNumber,
        15000000.0,
        1.0,
      );
      updateFrameNumber(this, frameNumber, time);
      frameState.newFrame = true;

      // Settle snapshot state before publishing it to the visual-performance
      // target and ticking that service. This prevents an extra measurement on
      // snapshot entry and a missed measurement on thaw.
      this._snapshotMode.tick(this);
      this._snapshotMode.tickCamera(this);

      // Register the render-bundle manager as a freezable when it first becomes
      // available. GraphicsContext returns null when it has no manager, and the
      // flag keeps registration idempotent without a renderer-identity branch.
      const ctx = frameState.context;
      if (ctx && !this._bundleManagerSnapshotRegistered) {
        const bundleMgr = ctx.renderBundleManager;
        if (bundleMgr && typeof bundleMgr.asFreezable === "function") {
          this._snapshotMode.registerFreezable(
            "webgpu-bundle-manager",
            bundleMgr.asFreezable(),
          );
          this._bundleManagerSnapshotRegistered = true;
        }
      }

      // Publish snapshot state before the visual-performance tick so tuning
      // pauses on the same frame that a snapshot enters or thaws.
      this._visualPerformanceTarget.snapshotMode = this._snapshotMode.isFrozen;

      // Tick after publishing the current snapshot state; the service applies
      // its own contract guards.
      this._visualPerformanceTarget.tick(this);
    }

    tryAndCatchError(this, prePassesUpdate);

    /**
     * Passes update. Add any passes here
     */
    if (this.primitives.show) {
      tryAndCatchError(this, updateMostDetailedRayPicks);
      tryAndCatchError(this, updatePreloadPass);
      tryAndCatchError(this, updatePreloadFlightPass);
      if (!shouldRender) {
        tryAndCatchError(this, updateRequestRenderModeDeferCheckPass);
      }
    }

    this._postUpdate.raiseEvent(this, time);

    if (shouldRender) {
      this._preRender.raiseEvent(this, time);
      frameState.creditDisplay.beginFrame();
      tryAndCatchError(this, render);
      setCpuScenePhase(this, "afterRenderCreditTrace");
    }

    /**
     * Post passes update. Execute any pass invariant code that should run after the passes here.
     */
    updateDebugShowFramesPerSecond(this, shouldRender);
    tryAndCatchError(this, postPassesUpdate);

    // Always-on live FPS recording. The recordFrame() call is a couple
    // of typed-array writes per frame regardless of whether anyone is
    // reading the live stats. The HUD overlay polls getLiveStats()
    // 4-10 times per second to render the rolling FPS graph.
    if (shouldRender && defined(this._performanceTracker)) {
      this._performanceTracker.recordFrame();
    }

    // Keep subscribed events such as tile loads and promises outside the error
    // wrapper, and resolve them after the render loop because callbacks may add
    // primitives.
    callAfterRenderFunctions(this);

    if (shouldRender) {
      this._postRender.raiseEvent(this, time);
      frameState.creditDisplay.endFrame();

      if (defined(performanceTraceStart)) {
        _samplePerformanceTrace(
          this,
          performance.now() - performanceTraceStart,
        );
      }
    }
  }

  /**
   * Create an additional View with an optional per-view GraphicsContext.
   * This enables multi-view scenarios: split-screen, multi-monitor, mixed backends.
   *
   * The created view shares the same scene graph but can render to a different
   * canvas/context. For WebGPU multi-view, use WebGPUDevicePool to share a
   * single GPUDevice across multiple canvases (~90% GPU memory savings).
   *
   * @param {Camera} camera The camera for the new view.
   * @param {BoundingRectangle} viewport The viewport rectangle.
   * @param {object} [options] Options for the view.
   * @param {GraphicsContext} [options.graphicsContext] Per-view context override.
   *   When provided, this view renders using its own context.
   *   When omitted, falls back to the Scene's default context.
   * @returns {View} The created view.
   *
   * @example
   * // Create a secondary WebGPU view on a different canvas
   * const secondaryView = scene.createView(camera, viewport, {
   *   graphicsContext: secondaryWebGPUContext
   * });
   *
   * @private
   */
  createView(camera, viewport, options) {
    return new View(this, camera, viewport, options);
  }

  /**
   * Update and render the scene. Always forces a new render frame regardless of whether a render was
   * previously requested.
   * @param {JulianDate} [time] The simulation time at which to render.
   *
   * @private
   */
  forceRender(time) {
    this._renderRequested = true;
    this.render(time);
  }

  /**
   * Requests a new rendered frame when {@link Scene#requestRenderMode} is set to <code>true</code>.
   * The render rate will not exceed the {@link CesiumWidget#targetFrameRate}.
   *
   * If snapshot mode is currently active, calling this also marks the
   * snapshot dirty so the next frame rebuilds bundles against fresh
   * state — the caller is asking for a new frame because something
   * changed, and a frozen snapshot replaying old bundles would be
   * visually wrong.
   *
   * @see Scene#requestRenderMode
   * @see Scene#markSnapshotDirty
   */
  requestRender() {
    this._renderRequested = true;
    if (defined(this._snapshotMode) && this._snapshotMode.isFrozen) {
      this._snapshotMode.markDirty("Scene.requestRender() called");
    }
  }

  /**
   * @private
   */
  clampLineWidth(width) {
    return Math.max(
      this.context.limits.minimumAliasedLineWidth,
      Math.min(width, this.context.limits.maximumAliasedLineWidth),
    );
  }

  /**
   * Returns an object with a <code>primitive</code> property that contains the first (top) primitive in the scene
   * at a particular window coordinate or <code>undefined</code> if nothing is at the location. Other properties may
   * potentially be set depending on the type of primitive and may be used to further identify the picked object.
   * <p>
   * When a feature of a 3D Tiles tileset is picked, <code>pick</code> returns a {@link Cesium3DTileFeature} object.
   * </p>
   * <p>
   * <b>WebGPU note:</b> WebGPU has no synchronous GPU-to-CPU readback, so the
   * synchronous <code>pick</code> reads back the pick buffer asynchronously and
   * returns the previous pick's result (one frame stale). This is transparent
   * for the continuous-hover pattern above (the cursor barely moves frame to
   * frame, so the prior result matches), but a <i>standalone</i>
   * <code>pick</code> at a fresh location returns <code>undefined</code> on its
   * first call ("cold") and resolves on a subsequent call at the same location.
   * For one-off / click-driven picks on WebGPU, prefer {@link Scene#pickAsync},
   * which awaits the readback and always returns the correct current-frame
   * result. On WebGL <code>pick</code> is fully synchronous and unaffected.
   * </p>
   *
   * @example
   * // On mouse over, color the feature yellow.
   * handler.setInputAction(function(movement) {
   *     const feature = scene.pick(movement.endPosition);
   *     if (feature instanceof Cesium.Cesium3DTileFeature) {
   *         feature.color = Cesium.Color.YELLOW;
   *     }
   * }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
   *
   * @see Scene#pickAsync
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {object | undefined} Object containing the picked primitive or <code>undefined</code> if nothing is at the location.
   */
  pick(windowPosition, width, height) {
    return this._picking.pick(this, windowPosition, width, height, 1)[0];
  }

  /**
   * Returns the best snap target in a screen-space region around <code>windowPosition</code>.
   * Edges are preferred over surfaces; among hits of the same kind the one
   * nearest the cursor wins. Returns <code>undefined</code> if the region contains
   * no snappable geometry.
   * <p>
   * Only primitives rendered through the Model pipeline (e.g. 3D Tiles and glTF
   * models) are snappable. Snapping requires float color attachments
   * (WebGL2 with <code>EXT_color_buffer_float</code>); if unsupported, this
   * function returns <code>undefined</code>.
   * </p>
   * <p>
   * <b>WebGPU note:</b> like {@link Scene#pick}, <code>snap</code> reads its
   * framebuffer asynchronously and returns the most recent completed relevant
   * snap. With an unchanged rendered view, an exact query may reuse its recent
   * completed payload and a moving cursor may briefly reuse one whose search
   * region still overlaps the new one. Pixels are paired with the immutable
   * camera, frustum, viewport, and CSS/drawing-buffer dimensions that rendered
   * them. Camera/projection motion, a cold or non-overlapping query, or an old
   * payload can therefore return <code>undefined</code> until a relevant
   * readback completes rather than reconstructing against mismatched state. On
   * WebGL <code>snap</code> is fully synchronous and unaffected.
   * </p>
   *
   * @param {Cartesian2} windowPosition Window coordinates at the center of the search region.
   * @param {object} [options] Object with the following properties:
   * @param {number} [options.width=25] Width of the search region in pixels.
   * @param {number} [options.height=options.width] Height of the search region in pixels.
   * @returns {SceneSnapResult | undefined} The best snap target in the region, or <code>undefined</code> if there is none.
   *
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  snap(windowPosition, options) {
    return Snapping.snap(this, windowPosition, options);
  }

  /**
   * Performs the same operation as Scene.pick but asynchonosly without blocking the main render thread.
   * Requires WebGL2 else using fallback.
   *
   * @example
   * // On mouse over, color the feature yellow.
   * handler.setInputAction(function(movement) {
   *     const feature = scene.pickAsync(movement.endPosition).then(function(feature) {
   *        if (feature instanceof Cesium.Cesium3DTileFeature) {
   *            feature.color = Cesium.Color.YELLOW;
   *        }
   *     });
   * }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {Promise<Object | undefined>} Object containing the picked primitive or <code>undefined</code> if nothing is at the location.
   *
   * @see Scene#pick
   */
  async pickAsync(windowPosition, width, height) {
    const result = await this._picking.pickAsync(
      this,
      windowPosition,
      width,
      height,
      1,
    );
    return result[0];
  }

  /**
   * Returns a {@link VoxelCell} for the voxel sample rendered at a particular window coordinate,
   * or <code>undefined</code> if no voxel is rendered at that position.
   *
   * @example
   * On left click, report the value of the "color" property at that voxel sample.
   * handler.setInputAction(function(movement) {
   *   const voxelCell = scene.pickVoxel(movement.position);
   *   if (defined(voxelCell)) {
   *     console.log(voxelCell.getProperty("color"));
   *   }
   * }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {VoxelCell|undefined} Information about the voxel cell rendered at the picked position or <code>undefined</code> if no voxel is rendered at that position.
   *
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  pickVoxel(windowPosition, width, height) {
    const pickedObject = this.pick(windowPosition, width, height);
    if (!defined(pickedObject)) {
      return;
    }
    const voxelPrimitive = pickedObject.primitive;
    if (!(voxelPrimitive instanceof VoxelPrimitive)) {
      return;
    }
    // Require an actual ray-to-bounds hit rather than trusting the object-pick
    // footprint. This rejects a stale off-box WebGPU hit before the cell pass;
    // the conservative oriented box still admits every surface hit. WebGL
    // already returns undefined away from the rendered voxel surface.
    if (!voxelPickRayHitsBounds(this, windowPosition, voxelPrimitive)) {
      return;
    }
    const voxelCoordinate = this._picking.pickVoxelCoordinate(
      this,
      windowPosition,
      width,
      height,
      voxelPrimitive,
    );
    // A cold WebGPU readback is invalid, not a synthetic root/sample zero.
    if (!defined(voxelCoordinate)) {
      return;
    }
    // WebGPU clears the dedicated voxel-coordinate pass to all-255. Base-255
    // packing never emits 255 in either remainder byte, so this value is an
    // impossible no-command/no-fragment sentinel on both backends.
    if (
      voxelCoordinate[0] === 255 &&
      voxelCoordinate[1] === 255 &&
      voxelCoordinate[2] === 255 &&
      voxelCoordinate[3] === 255
    ) {
      return;
    }
    const tileIndex = 255 * voxelCoordinate[0] + voxelCoordinate[1];
    // Backend-agnostic keyframe-node resolve: WebGL consults the CPU-side
    // VoxelTraversal; the WebGPU feature-renderer path (no traversal) resolves
    // from its uploaded tile content. Guards a missing traversal so a picked
    // tile with no resolvable node degrades to `undefined` instead of throwing.
    const keyframeNode = voxelPrimitive._getPickKeyframeNode(tileIndex);
    if (!defined(keyframeNode)) {
      return;
    }
    const sampleIndex = 255 * voxelCoordinate[2] + voxelCoordinate[3];
    return VoxelCell.fromKeyframeNode(
      voxelPrimitive,
      tileIndex,
      sampleIndex,
      keyframeNode,
    );
  }

  /**
   * Pick a metadata value at the given window position.
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {string|undefined} schemaId The ID of the metadata schema to pick values
   * from. If this is <code>undefined</code>, then it will pick the values from the object
   * that match the given class- and property name, regardless of the schema ID.
   * @param {string} className The name of the metadata class to pick
   * values from
   * @param {string} propertyName The name of the metadata property to pick
   * values from
   * @returns {MetadataValue|undefined} The metadata value, or <code>undefined</code> when
   * no matching metadata was found at the given position
   *
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  pickMetadata(windowPosition, schemaId, className, propertyName) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("windowPosition", windowPosition);
    Check.typeOf.string("className", className);
    Check.typeOf.string("propertyName", propertyName);
    //>>includeEnd('debug');

    const pickedObject = this.pick(windowPosition);
    if (!defined(pickedObject)) {
      return undefined;
    }

    const structuralMetadata = pickedObject.detail?.model?.structuralMetadata;
    if (!defined(structuralMetadata)) {
      return undefined;
    }
    const schema = structuralMetadata.schema;
    const classProperty = getMetadataClassProperty(
      schema,
      schemaId,
      className,
      propertyName,
    );
    if (!defined(classProperty)) {
      return undefined;
    }
    const metadataProperty = getMetadataProperty(
      structuralMetadata,
      className,
      propertyName,
    );
    if (!defined(metadataProperty)) {
      return undefined;
    }

    const pickedMetadataInfo = new PickedMetadataInfo(
      schemaId,
      className,
      propertyName,
      classProperty,
      metadataProperty,
    );

    const pickedMetadataValues = this._picking.pickMetadata(
      this,
      windowPosition,
      pickedMetadataInfo,
      pickedObject,
    );

    return pickedMetadataValues;
  }

  /**
   * Pick the schema of the metadata of the object at the given position
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @returns {MetadataSchema | undefined} The metadata schema, or <code>undefined</code> if there is no object with
   * associated metadata at the given position.
   *
   * @experimental This feature is not final and is subject to change without Cesium's standard deprecation policy.
   */
  pickMetadataSchema(windowPosition) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const pickedObject = this.pick(windowPosition);
    if (!defined(pickedObject)) {
      return undefined;
    }
    const schema = pickedObject.detail?.model?.structuralMetadata?.schema;
    return schema;
  }

  /**
   * Returns the cartesian position reconstructed from the depth buffer and window position.
   * The returned position is in world coordinates. Used internally by camera functions to
   * prevent conversion to projected 2D coordinates and then back.
   * <p>
   * Set {@link Scene#pickTranslucentDepth} to <code>true</code> to include the depth of
   * translucent primitives; otherwise, this essentially picks through translucent primitives.
   * </p>
   *
   * @private
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {Cartesian3} [result] The object on which to restore the result.
   * @returns {Cartesian3} The cartesian position in world coordinates.
   *
   * @exception {DeveloperError} Picking from the depth buffer is not supported. Check pickPositionSupported.
   */
  pickPositionWorldCoordinates(windowPosition, result) {
    return this._picking.pickPositionWorldCoordinates(
      this,
      windowPosition,
      result,
    );
  }

  /**
   * Returns the cartesian position reconstructed from the depth buffer and window position.
   * <p>
   * The position reconstructed from the depth buffer in 2D may be slightly different from those
   * reconstructed in 3D and Columbus view. This is caused by the difference in the distribution
   * of depth values of perspective and orthographic projection.
   * </p>
   * <p>
   * Set {@link Scene#pickTranslucentDepth} to <code>true</code> to include the depth of
   * translucent primitives; otherwise, this essentially picks through translucent primitives.
   * </p>
   * <p>
   * <b>WebGPU note:</b> like {@link Scene#snap}, <code>pickPosition</code> reads
   * scene depth asynchronously and returns the most recent completed relevant
   * position. With an unchanged rendered view, an exact query may reuse its
   * recent completed payload. Camera or projection motion, a cold query, or an
   * old payload can therefore return <code>undefined</code> until a relevant
   * readback completes. On WebGL <code>pickPosition</code> is fully synchronous
   * and unaffected.
   * </p>
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {Cartesian3} [result] The object on which to restore the result.
   * @returns {Cartesian3 | undefined} The cartesian position, or <code>undefined</code> when no current position is available.
   *
   * @exception {DeveloperError} Picking from the depth buffer is not supported. Check pickPositionSupported.
   */
  pickPosition(windowPosition, result) {
    return this._picking.pickPosition(this, windowPosition, result);
  }

  /**
   * Returns a list of objects, each containing a <code>primitive</code> property, for all primitives at
   * a particular window coordinate position. Other properties may also be set depending on the
   * type of primitive and may be used to further identify the picked object. The primitives in
   * the list are ordered by their visual order in the scene (front to back).
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {number} [limit] If supplied, stop drilling after collecting this many picks.
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {any[]} Array of objects, each containing 1 picked primitives.
   *
   * @exception {DeveloperError} windowPosition is undefined.
   *
   * @example
   * const pickedObjects = scene.drillPick(new Cesium.Cartesian2(100.0, 200.0));
   *
   * @see Scene#pick
   */
  drillPick(windowPosition, limit, width, height) {
    return this._picking.drillPick(this, windowPosition, limit, width, height);
  }

  /**
   * Asynchronous variant of {@link Scene#drillPick}. Awaits each pick
   * render's framebuffer readback before drilling to the next layer,
   * so on WebGPU each iteration sees a fresh pick render instead of
   * the prior frame's stale pixels (the failure mode of the
   * synchronous {@link Scene#drillPick} on WebGPU). On WebGL this
   * uses the existing {@link PickFramebuffer#endAsync} sync-fence +
   * PBO path; results match the synchronous path otherwise.
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {number} [limit] If supplied, stop drilling after collecting this many picks.
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {Promise<any[]>} Array of objects, each containing 1 picked primitive (front-to-back).
   *
   * @exception {DeveloperError} windowPosition is undefined.
   *
   * @example
   * const pickedObjects = await scene.drillPickAsync(new Cesium.Cartesian2(100.0, 200.0));
   *
   * @see Scene#drillPick
   */
  drillPickAsync(windowPosition, limit, width, height) {
    return this._picking.drillPickAsync(
      this,
      windowPosition,
      limit,
      width,
      height,
    );
  }

  /**
   * Approximate asynchronous pick designed for continuous hover input.
   *
   * Translucent (BLEND alphaMode) primitives use stochastic dither
   * (Interleaved Gradient Noise) to discard fragments based on their
   * effective alpha — a fragment with alpha=0.3 has a 30% chance of
   * surviving the dither test. Result is approximate per-frame but
   * converges to the correct alpha-weighted appearance over multi-
   * frame hover motion.
   *
   * It uses one render pass, matching the pass count of `pickAsync`, and is
   * intended for per-frame use at 60fps.
   *
   * Use `pickPreciseAsync` for click-pick scenarios where the user
   * wants deterministic "geometrically-closest translucent fragment
   * wins" semantics.
   *
   * On WebGL or scenes without translucent geometry, this method's
   * result is identical to `pickAsync`.
   *
   * @param {Cartesian2} windowPosition
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {Promise<object|undefined>} The picked object, or `undefined` if
   *   no object was picked.
   *
   * @example
   * // Continuous hover-pick — won't stutter even on heavy scenes.
   * handler.setInputAction(async (movement) => {
   *   const picked = await scene.pickHoverAsync(movement.endPosition);
   *   showTooltip(picked);
   * }, ScreenSpaceEventType.MOUSE_MOVE);
   *
   * @see Scene#pickAsync
   * @see Scene#pickPreciseAsync
   */
  pickHoverAsync(windowPosition, width, height) {
    // Mark the scene as hover-pick-enabled so the model renderer
    // builds the dither pipeline variant on the next update tick.
    this._webgpuPickHoverEnabled = true;
    return this._picking.pickHoverAsync(this, windowPosition, width, height);
  }

  /**
   * Deterministic asynchronous pick designed for click input where the
   * user expects deterministic "geometrically-closest translucent
   * fragment wins" semantics. Translucent (BLEND alphaMode) primitives
   * route through a 2-pass pipeline pair (depth pre-pass + depth-EQUAL
   * color pass) sharing one render-pass setup so depth + stencil
   * persist between passes.
   *
   * Translucent primitives that intersect the pick rectangle require roughly
   * twice the rasterization work. Use `pickHoverAsync` for continuous hover
   * input.
   *
   * On WebGL or scenes without translucent geometry, this method's
   * result is identical to `pickAsync`.
   *
   * @param {Cartesian2} windowPosition
   * @param {number} [width=3] Width of the pick rectangle.
   * @param {number} [height=3] Height of the pick rectangle.
   * @returns {Promise<object>} The picked object.
   *
   * @example
   * // Click-pick with deterministic translucent winner selection.
   * handler.setInputAction(async (click) => {
   *   const picked = await scene.pickPreciseAsync(click.position);
   *   if (picked) selectFeature(picked);
   * }, ScreenSpaceEventType.LEFT_CLICK);
   *
   * @see Scene#pickAsync
   * @see Scene#pickHoverAsync
   */
  pickPreciseAsync(windowPosition, width, height) {
    this._webgpuPickPreciseEnabled = true;
    // Enable timestamp profiling when precise picking is first requested. Its
    // deferral decision reads `performanceManager.frameTimings.totalGpuMs`, so
    // missing timings would prevent heavy precise picks from being deferred.
    const perfMgr = this.context?._performanceManager;
    if (perfMgr && perfMgr._config && !perfMgr._config.timestampProfiling) {
      perfMgr._config.timestampProfiling = true;
    }
    return this._picking.pickPreciseAsync(this, windowPosition, width, height);
  }

  /**
   * Returns an object containing the first object intersected by the ray and the position of intersection,
   * or <code>undefined</code> if there were no intersections. The intersected object has a <code>primitive</code>
   * property that contains the intersected primitive. Other properties may be set depending on the type of primitive
   * and may be used to further identify the picked object. The ray must be given in world coordinates.
   * <p>
   * This function only picks globe tiles and 3D Tiles that are rendered in the current view. Picks all other
   * primitives regardless of their visibility.
   * </p>
   *
   * @private
   *
   * @param {Ray} ray The ray.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to exclude from the ray intersection.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {object | undefined} An object containing the object and position of the first intersection or <code>undefined</code> if there are no intersections.
   *
   * @exception {DeveloperError} Ray intersections are only supported in 3D mode.
   */
  pickFromRay(ray, objectsToExclude, width) {
    return this._picking.pickFromRay(this, ray, objectsToExclude, width);
  }

  /**
   * Returns a list of objects, each containing the object intersected by the ray and the position of intersection.
   * The intersected object has a <code>primitive</code> property that contains the intersected primitive. Other
   * properties may also be set depending on the type of primitive and may be used to further identify the picked object.
   * The primitives in the list are ordered by first intersection to last intersection. The ray must be given in
   * world coordinates.
   * <p>
   * This function only picks globe tiles and 3D Tiles that are rendered in the current view. Picks all other
   * primitives regardless of their visibility.
   * </p>
   *
   * @private
   *
   * @param {Ray} ray The ray.
   * @param {number} [limit=Number.MAX_VALUE] If supplied, stop finding intersections after this many intersections.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to exclude from the ray intersection.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {object[]} List of objects containing the object and position of each intersection.
   *
   * @exception {DeveloperError} Ray intersections are only supported in 3D mode.
   */
  drillPickFromRay(ray, limit, objectsToExclude, width) {
    return this._picking.drillPickFromRay(
      this,
      ray,
      limit,
      objectsToExclude,
      width,
    );
  }

  /**
   * Initiates an asynchronous {@link Scene#pickFromRay} request using the maximum level of detail for 3D Tilesets
   * regardless of visibility.
   *
   * @private
   *
   * @param {Ray} ray The ray.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to exclude from the ray intersection.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {Promise<object>} A promise that resolves to an object containing the object and position of the first intersection.
   *
   * @exception {DeveloperError} Ray intersections are only supported in 3D mode.
   */
  pickFromRayMostDetailed(ray, objectsToExclude, width) {
    return this._picking.pickFromRayMostDetailed(
      this,
      ray,
      objectsToExclude,
      width,
    );
  }

  /**
   * Initiates an asynchronous {@link Scene#drillPickFromRay} request using the maximum level of detail for 3D Tilesets
   * regardless of visibility.
   *
   * @private
   *
   * @param {Ray} ray The ray.
   * @param {number} [limit=Number.MAX_VALUE] If supplied, stop finding intersections after this many intersections.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to exclude from the ray intersection.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {Promise<Object[]>} A promise that resolves to a list of objects containing the object and position of each intersection.
   *
   * @exception {DeveloperError} Ray intersections are only supported in 3D mode.
   */
  drillPickFromRayMostDetailed(ray, limit, objectsToExclude, width) {
    return this._picking.drillPickFromRayMostDetailed(
      this,
      ray,
      limit,
      objectsToExclude,
      width,
    );
  }

  /**
   * Pick all objects at a screen position. Convenience wrapper around
   * {@link Scene#drillPick} with an options-object API.
   *
   * @param {Cartesian2} windowPosition Screen coordinates to pick at.
   * @param {object} [options] Options object.
   * @param {number} [options.limit=Number.MAX_VALUE] Maximum objects to return.
   * @param {number} [options.width=3] Pick region width in pixels.
   * @param {number} [options.height=3] Pick region height in pixels.
   * @returns {object[]} Array of picked objects, each with a <code>primitive</code> property.
   *
   * @see Scene#drillPick
   * @see Scene#pickRayAll
   * @see Scene#pickColumn
   */
  pickAll(windowPosition, options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const limit = options.limit ?? Number.MAX_VALUE;
    const width = options.width ?? 3;
    const height = options.height ?? 3;
    return this.drillPick(windowPosition, limit, width, height);
  }

  /**
   * Pick all objects along a world-space ray with optional diameter.
   * Convenience wrapper around {@link Scene#drillPickFromRay}.
   *
   * @param {Ray} ray The ray to pick along.
   * @param {object} [options] Options object.
   * @param {number} [options.diameter=0.1] Pick cylinder diameter in meters.
   * @param {number} [options.limit=Number.MAX_VALUE] Maximum objects to return.
   * @param {object[]} [options.exclude] Objects to skip.
   * @returns {Array<object>} All intersected objects with position and normal.
   *
   * @exception {DeveloperError} Ray intersections are only supported in 3D mode.
   *
   * @see Scene#drillPickFromRay
   * @see Scene#pickColumn
   */
  pickRayAll(ray, options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const diameter = options.diameter ?? 0.1;
    const limit = options.limit ?? Number.MAX_VALUE;
    const exclude = options.exclude;
    return this.drillPickFromRay(ray, limit, exclude, diameter);
  }

  /**
   * Pick all objects in a vertical column at a geographic position,
   * from above the surface toward the center of the earth. Equivalent to
   * {@link Scene#drillPickFromRay} with a downward ray at the given lon/lat.
   *
   * @param {Cartographic} position Longitude/latitude/height to pick from.
   * @param {object} [options] Options object.
   * @param {number} [options.diameter=1.0] Column diameter in meters.
   * @param {number} [options.limit=Number.MAX_VALUE] Maximum objects to return.
   * @param {object[]} [options.exclude] Objects to skip.
   * @returns {Array<object>} All intersected objects.
   *
   * @exception {DeveloperError} pickColumn is only supported in 3D mode.
   *
   * @see Scene#drillPickFromRay
   * @see Scene#pickRayAll
   */
  pickColumn(position, options) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("position", position);
    if (this.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError("pickColumn is only supported in 3D mode.");
    }
    //>>includeEnd('debug');

    options = options ?? Frozen.EMPTY_OBJECT;
    const diameter = options.diameter ?? 1.0;
    const limit = options.limit ?? Number.MAX_VALUE;
    const exclude = options.exclude;

    const ellipsoid = this._ellipsoid;
    const heightAbove = position.height + 1000.0;
    const origin = Cartographic.toCartesian(
      new Cartographic(position.longitude, position.latitude, heightAbove),
      ellipsoid,
    );
    const direction = Cartesian3.negate(
      Cartesian3.normalize(origin, scratchPickColumnDirection),
      scratchPickColumnDirection,
    );
    const ray = new Ray(origin, direction);
    return this.drillPickFromRay(ray, limit, exclude, diameter);
  }

  /**
   * Returns the height of scene geometry at the given cartographic position or <code>undefined</code> if there was no
   * scene geometry to sample height from. The height of the input position is ignored. May be used to clamp objects to
   * the globe, 3D Tiles, or primitives in the scene.
   * <p>
   * This function only samples height from globe tiles and 3D Tiles that are rendered in the current view. Samples height
   * from all other primitives regardless of their visibility.
   * </p>
   * <p>
   * <b>WebGPU note:</b> like {@link Scene#snap}, <code>sampleHeight</code> reads
   * scene depth asynchronously and returns the most recent completed relevant
   * height. With an unchanged rendered view, an exact visible-position query
   * may reuse its recent completed payload. Camera or projection motion, a cold
   * query, a position outside the current view, or an old payload can therefore
   * return <code>undefined</code> until a relevant readback completes. On WebGL
   * <code>sampleHeight</code> is fully synchronous and unaffected.
   * </p>
   *
   * @param {Cartographic} position The cartographic position to sample height from.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to not sample height from.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {number | undefined} The height. This may be <code>undefined</code> if there was no scene geometry to sample height from.
   *
   * @example
   * const position = new Cesium.Cartographic(-1.31968, 0.698874);
   * const height = viewer.scene.sampleHeight(position);
   * if (Cesium.defined(height)) {
   *     console.log(height);
   * }
   *
   * @see Scene#clampToHeight
   * @see Scene#clampToHeightMostDetailed
   * @see Scene#sampleHeightMostDetailed
   *
   * @exception {DeveloperError} sampleHeight is only supported in 3D mode.
   * @exception {DeveloperError} sampleHeight requires depth texture support. Check sampleHeightSupported.
   */
  sampleHeight(position, objectsToExclude, width) {
    return this._picking.sampleHeight(this, position, objectsToExclude, width);
  }

  /**
   * Clamps the given cartesian position to the scene geometry along the geodetic surface normal. Returns the
   * clamped position or <code>undefined</code> if there was no scene geometry to clamp to. May be used to clamp
   * objects to the globe, 3D Tiles, or primitives in the scene.
   * <p>
   * This function only clamps to globe tiles and 3D Tiles that are rendered in the current view. Clamps to
   * all other primitives regardless of their visibility.
   * </p>
   * <p>
   * <b>WebGPU note:</b> like {@link Scene#snap}, <code>clampToHeight</code> reads
   * scene depth asynchronously and returns the most recent completed relevant
   * position. With an unchanged rendered view, an exact visible-position query
   * may reuse its recent completed payload. Camera or projection motion, a cold
   * query, a position outside the current view, or an old payload can therefore
   * return <code>undefined</code> until a relevant readback completes. On WebGL
   * <code>clampToHeight</code> is fully synchronous and unaffected.
   * </p>
   *
   * @param {Cartesian3} cartesian The cartesian position.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to not clamp to.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @param {Cartesian3} [result] An optional object to return the clamped position.
   * @returns {Cartesian3 | undefined} The modified result parameter or a new Cartesian3 instance if one was not provided. This may be <code>undefined</code> if there was no scene geometry to clamp to.
   *
   * @example
   * // Clamp an entity to the underlying scene geometry
   * const position = entity.position.getValue(Cesium.JulianDate.now());
   * const clampedPosition = viewer.scene.clampToHeight(position);
   * if (Cesium.defined(clampedPosition)) {
   *     entity.position = clampedPosition;
   * }
   *
   * @see Scene#sampleHeight
   * @see Scene#sampleHeightMostDetailed
   * @see Scene#clampToHeightMostDetailed
   *
   * @exception {DeveloperError} clampToHeight is only supported in 3D mode.
   * @exception {DeveloperError} clampToHeight requires depth texture support. Check clampToHeightSupported.
   */
  clampToHeight(cartesian, objectsToExclude, width, result) {
    return this._picking.clampToHeight(
      this,
      cartesian,
      objectsToExclude,
      width,
      result,
    );
  }

  /**
   * Initiates an asynchronous {@link Scene#sampleHeight} query for an array of {@link Cartographic} positions
   * using the maximum level of detail for 3D Tilesets in the scene. The height of the input positions is ignored.
   * Returns a promise that is resolved when the query completes. Each point height is modified in place.
   * If a height cannot be determined because no geometry can be sampled at that location, or another error occurs,
   * the height is set to <code>undefined</code>.
   *
   * @param {Cartographic[]} positions The cartographic positions to update with sampled heights.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to not sample height from.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {Promise<Array<Cartographic | undefined>>} A promise that resolves to the provided list of positions when the query has completed. Positions may become <code>undefined</code> if the height cannot be determined.
   *
   * @example
   * const positions = [
   *     new Cesium.Cartographic(-1.31968, 0.69887),
   *     new Cesium.Cartographic(-1.10489, 0.83923)
   * ];
   * const promise = viewer.scene.sampleHeightMostDetailed(positions);
   * promise.then(function(updatedPosition) {
   *     // positions[0].height and positions[1].height have been updated.
   *     // updatedPositions is just a reference to positions.
   * }
   *
   * @see Scene#sampleHeight
   *
   * @exception {DeveloperError} sampleHeightMostDetailed is only supported in 3D mode.
   * @exception {DeveloperError} sampleHeightMostDetailed requires depth texture support. Check sampleHeightSupported.
   */
  sampleHeightMostDetailed(positions, objectsToExclude, width) {
    return this._picking.sampleHeightMostDetailed(
      this,
      positions,
      objectsToExclude,
      width,
    );
  }

  /**
   * Initiates an asynchronous {@link Scene#clampToHeight} query for an array of {@link Cartesian3} positions
   * using the maximum level of detail for 3D Tilesets in the scene. Returns a promise that is resolved when
   * the query completes. Each position is modified in place. If a position cannot be clamped because no geometry
   * can be sampled at that location, or another error occurs, the element in the array is set to undefined.
   *
   * @param {Cartesian3[]} cartesians The cartesian positions to update with clamped positions.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to not clamp to.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {Promise<Array<Cartesian3 | undefined>>} A promise that resolves to the provided list of positions when the query has completed. Positions may become <code>undefined</code> if they cannot be clamped.
   *
   * @example
   * const cartesians = [
   *     entities[0].position.getValue(Cesium.JulianDate.now()),
   *     entities[1].position.getValue(Cesium.JulianDate.now())
   * ];
   * const promise = viewer.scene.clampToHeightMostDetailed(cartesians);
   * promise.then(function(updatedCartesians) {
   *     entities[0].position = updatedCartesians[0];
   *     entities[1].position = updatedCartesians[1];
   * }
   *
   * @see Scene#clampToHeight
   *
   * @exception {DeveloperError} clampToHeightMostDetailed is only supported in 3D mode.
   * @exception {DeveloperError} clampToHeightMostDetailed requires depth texture support. Check clampToHeightSupported.
   */
  clampToHeightMostDetailed(cartesians, objectsToExclude, width) {
    return this._picking.clampToHeightMostDetailed(
      this,
      cartesians,
      objectsToExclude,
      width,
    );
  }

  /**
   * Transforms a position in cartesian coordinates to canvas coordinates.  This is commonly used to place an
   * HTML element at the same screen position as an object in the scene.
   *
   * @param {Cartesian3} position The position in cartesian coordinates.
   * @param {Cartesian2} [result] An optional object to return the input position transformed to canvas coordinates.
   * @returns {Cartesian2 | undefined} The modified result parameter or a new Cartesian2 instance if one was not provided.  This may be <code>undefined</code> if the input position is near the center of the ellipsoid.
   *
   * @example
   * // Output the canvas position of longitude/latitude (0, 0) every time the mouse moves.
   * const scene = widget.scene;
   * const position = Cesium.Cartesian3.fromDegrees(0.0, 0.0);
   * const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
   * handler.setInputAction(function(movement) {
   *     console.log(scene.cartesianToCanvasCoordinates(position));
   * }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
   */
  cartesianToCanvasCoordinates(position, result) {
    return SceneTransforms.worldToWindowCoordinates(this, position, result);
  }

  /**
   * Instantly completes an active transition.
   */
  completeMorph() {
    this._transitioner.completeMorph();
  }

  /**
   * Asynchronously transitions the scene to 2D.
   * @param {number} [duration=2.0] The amount of time, in seconds, for transition animations to complete.
   */
  morphTo2D(duration) {
    duration = duration ?? 2.0;
    this._transitioner.morphTo2D(duration, this._ellipsoid);
  }

  /**
   * Asynchronously transitions the scene to Columbus View.
   * @param {number} [duration=2.0] The amount of time, in seconds, for transition animations to complete.
   */
  morphToColumbusView(duration) {
    duration = duration ?? 2.0;
    this._transitioner.morphToColumbusView(duration, this._ellipsoid);
  }

  /**
   * Asynchronously transitions the scene to 3D.
   * @param {number} [duration=2.0] The amount of time, in seconds, for transition animations to complete.
   */
  morphTo3D(duration) {
    duration = duration ?? 2.0;
    this._transitioner.morphTo3D(duration, this._ellipsoid);
  }

  /**
   * Update the terrain providing surface geometry for the globe.
   *
   * @param {Terrain} terrain The terrain provider async helper
   * @returns {Terrain} terrain The terrain provider async helper
   *
   * @example
   * // Use Cesium World Terrain
   * scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
   *
   * @example
   * // Use a custom terrain provider
   * const terrain = new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromUrl("https://myTestTerrain.com"));
   * scene.setTerrain(terrain);
   *
   * terrain.errorEvent.addEventListener(error => {
   *   alert(`Encountered an error while creating terrain! ${error}`);
   * });
   */
  setTerrain(terrain) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("terrain", terrain);
    //>>includeEnd('debug');

    setTerrain(this, terrain);

    return terrain;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see Scene#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * scene = scene && scene.destroy();
   *
   * @see Scene#isDestroyed
   */
  destroy() {
    // Use the same field-based drain as constructor rollback. Every ownership
    // edge is isolated, so a throwing custom resource cannot prevent global
    // listeners, per-scene GPU resources, or the graphics context/device-pool
    // lease from being released.
    destroySceneResources(this);
    return destroyObject(this);
  }
}

// Keep the concrete implementation immutable so profiler-enabled rendering
// cannot re-enter a later prototype override or instance wrapper.
const renderSceneForCpuAccounting = Scene.prototype.render;

/**
 * Releases a complete or partially initialized Scene. Each cleanup is isolated
 * so a malformed/custom backend resource cannot prevent mandatory listener,
 * per-scene GPU-resource, context, and device-pool cleanup.
 *
 * @param {Scene} scene The partially initialized scene.
 * @private
 */
function destroySceneResources(scene) {
  const cleanup = function (callback) {
    try {
      callback();
    } catch {
      // Construction rollback preserves its original error, while public
      // destroy remains best-effort. In both cases later ownership edges,
      // especially global listeners and the graphics context, must drain.
    }
  };

  const removeCallback = function (property) {
    const callback = scene[property];
    scene[property] = undefined;
    if (typeof callback === "function") {
      cleanup(callback);
    }
  };

  const destroyProperty = function (property) {
    const resource = scene[property];
    scene[property] = undefined;
    if (!defined(resource) || typeof resource.destroy !== "function") {
      return;
    }
    cleanup(function () {
      if (
        typeof resource.isDestroyed !== "function" ||
        !resource.isDestroyed()
      ) {
        resource.destroy();
      }
    });
  };

  // These callbacks close over the Scene and are owned by process-wide or
  // context-wide publishers. Detach them before destroying scene resources.
  removeCallback("_removeTaskProcessorListenerCallback");
  removeCallback("_removeRequestListenerCallback");
  removeCallback("_featureRendererReadinessUnsub");
  removeCallback("_asyncResourceUnsub");
  removeCallback("_hdrFallbackUnsub");
  // Detach the window-owned media-query listener because it closes over this
  // Scene and otherwise outlives it.
  removeCallback("_hdrDisplayUnsub");
  removeCallback("_removeTerrainProviderReadyListener");
  removeCallback("_removeUpdateHeightCallback");

  const globeCallbacks = scene._removeGlobeCallbacks ?? [];
  scene._removeGlobeCallbacks = [];
  for (let i = globeCallbacks.length - 1; i >= 0; --i) {
    if (typeof globeCallbacks[i] === "function") {
      cleanup(globeCallbacks[i]);
    }
  }

  // Reverse the scene-owned portion of construction. The default View is
  // deliberately first: it is created after the global listeners and was the
  // original late-construction failure boundary.
  const ownedResources = [
    "_defaultView",
    "_picking",
    "_performanceDisplay",
    "_brdfLutGenerator",
    "_screenSpaceCameraController",
    "_deviceOrientationCameraController",
    "postProcessStages",
    "_invertClassification",
    "shadowMap",
    "_debugFrustumPlanes",
    "_transitioner",
    "_depthPlane",
    "_sunPostProcess",
    "sun",
    "moon",
    "_debugSphere",
    "skyAtmosphere",
    "skyBox",
    "_globe",
    "_groundPrimitives",
    "_primitives",
    "_alternateSceneRenderer",
    "_computeEngine",
  ];
  for (let i = 0; i < ownedResources.length; ++i) {
    destroyProperty(ownedResources[i]);
  }
  scene._view = undefined;

  // FpsOverlay removes its own DOM. Preserve the container guard for overlay
  // implementations that expose only the container.
  const performanceContainer = scene._performanceContainer;
  scene._performanceContainer = undefined;
  if (defined(performanceContainer?.parentNode)) {
    cleanup(function () {
      performanceContainer.parentNode.removeChild(performanceContainer);
    });
  }

  if (defined(scene._snapshotMode)) {
    destroyProperty("_snapshotMode");
  }
  if (defined(scene._visualPerformanceTarget)) {
    destroyProperty("_visualPerformanceTarget");
  }
  if (defined(scene._performanceTracker)) {
    const tracker = scene._performanceTracker;
    scene._performanceTracker = undefined;
    cleanup(function () {
      if (tracker.active) {
        tracker.endTrace();
      }
    });
  }
  if (defined(scene._tweens)) {
    const tweens = scene._tweens;
    scene._tweens = undefined;
    cleanup(function () {
      tweens.removeAll();
    });
  }

  // Match normal Scene teardown for the constructor-created credit DOM. The
  // canvas belongs to the caller and is never removed here.
  if (
    scene._removeCreditContainer &&
    scene._canvas?.parentNode &&
    scene._creditContainer?.parentNode === scene._canvas.parentNode
  ) {
    cleanup(function () {
      scene._canvas.parentNode.removeChild(scene._creditContainer);
    });
  }

  const creditDisplay = scene._frameState?.creditDisplay;
  if (defined(scene._frameState)) {
    scene._frameState.creditDisplay = undefined;
  }
  if (defined(creditDisplay) && typeof creditDisplay.destroy === "function") {
    cleanup(function () {
      if (
        typeof creditDisplay.isDestroyed !== "function" ||
        !creditDisplay.isDestroyed()
      ) {
        creditDisplay.destroy();
      }
    });
  }
  scene._frameState = undefined;

  // Context destruction is last and isolated. Context.destroy unregisters the
  // context and releases any pooled WebGPU device lease. Scene.createAsync's
  // outer catch checks isDestroyed(), so it cannot pay a second release tax.
  const context = scene._context;
  scene._context = undefined;
  if (defined(context) && typeof context.destroy === "function") {
    cleanup(function () {
      if (typeof context.isDestroyed !== "function" || !context.isDestroyed()) {
        context.destroy();
      }
    });
  }
}

const scratchVoxelPickRay = new Ray();
const scratchVoxelPickLocalRay = new Ray();
const scratchVoxelPickInvAxes = new Matrix3();
const scratchVoxelPickOffset = new Cartesian3();
const scratchVoxelPickInterval = new Interval();
const voxelPickUnitBox = {
  minimum: new Cartesian3(-1.0, -1.0, -1.0),
  maximum: new Cartesian3(1.0, 1.0, 1.0),
};

/**
 * Returns whether the pick ray at `windowPosition` intersects the voxel
 * primitive's oriented bounding box. {@link Scene#pickVoxel} uses this to
 * reject off-box picks when an object-pick footprint is conservative.
 *
 * The ray is transformed into the box's unit-cube frame
 * (`halfAxes^-1 * (p - center)`), then intersected with the [-1, 1]^3 AABB. A
 * An absent, degenerate, or non-invertible oriented box fails open so a malformed
 * bound cannot discard a real pick.
 *
 * @private
 * @param {Scene} scene
 * @param {Cartesian2} windowPosition
 * @param {VoxelPrimitive} voxelPrimitive
 * @returns {boolean}
 */
function voxelPickRayHitsBounds(scene, windowPosition, voxelPrimitive) {
  const obb = voxelPrimitive.orientedBoundingBox;
  if (!defined(obb)) {
    return true;
  }
  const ray = scene.camera.getPickRay(windowPosition, scratchVoxelPickRay);
  if (!defined(ray)) {
    return true;
  }
  let invAxes;
  try {
    invAxes = Matrix3.inverse(obb.halfAxes, scratchVoxelPickInvAxes);
  } catch {
    // Non-invertible half-axes (zero-extent / not-yet-ready shape) — fail open.
    return true;
  }
  Matrix3.multiplyByVector(
    invAxes,
    Cartesian3.subtract(ray.origin, obb.center, scratchVoxelPickOffset),
    scratchVoxelPickLocalRay.origin,
  );
  Matrix3.multiplyByVector(
    invAxes,
    ray.direction,
    scratchVoxelPickLocalRay.direction,
  );
  const interval = IntersectionTests.rayAxisAlignedBoundingBox(
    scratchVoxelPickLocalRay,
    voxelPickUnitBox,
    scratchVoxelPickInterval,
  );
  // No intersection, or the box lies entirely behind the ray origin.
  return defined(interval) && interval.stop >= 0.0;
}

/**
 * Records one performance-trace sample for the rendered frame. It reads bundle
 * statistics and snapshot state through the central debug surface so subsystem
 * statistics follow one path.
 *
 * Scene.render calls this only when a trace was active at frame start. The
 * tracker still accepts an inactive call in case a render event ends the trace.
 *
 * @private
 * @param {Scene} scene
 * @param {number} cpuMs Full Scene.render() CPU wall time for this frame.
 */
function _samplePerformanceTrace(scene, cpuMs) {
  const tracker = scene._performanceTracker;
  if (!defined(tracker) || !tracker.active) {
    return;
  }
  const fs = scene._frameState;
  let bundleStats;
  let gpuMs;
  let gpuCoverageExtra;
  const ctx = scene._context;
  if (ctx && typeof ctx.getRendererStatistics === "function") {
    try {
      const rendererStats = ctx.getRendererStatistics();
      if (rendererStats && rendererStats.bundleManager) {
        bundleStats = rendererStats.bundleManager;
      }
      // Pull the timestamp profiler frame time when available.
      if (
        rendererStats &&
        rendererStats.timestamps &&
        typeof rendererStats.timestamps.frameMs === "number"
      ) {
        gpuMs = rendererStats.timestamps.frameMs;
      }
      const timestamps = rendererStats?.timestamps;
      if (timestamps) {
        const extra = {};
        if (typeof timestamps.profiledPassMs === "number") {
          extra.gpuProfiledPassMs = timestamps.profiledPassMs;
        }
        if (typeof timestamps.unprofiledMs === "number") {
          extra.gpuUnprofiledMs = timestamps.unprofiledMs;
        }
        if (typeof timestamps.coverageRatio === "number") {
          extra.gpuCoverageRatio = timestamps.coverageRatio;
        }
        if (Object.keys(extra).length > 0) {
          gpuCoverageExtra = extra;
        }
      }
    } catch (e) {
      // Diagnostic getters must never break the trace path.
    }
  }
  const snapshotFrozen =
    defined(scene._snapshotMode) && scene._snapshotMode.isFrozen === true;
  tracker.sample({
    frameNumber: fs?.frameNumber ?? -1,
    cpuMs,
    gpuMs,
    drawCount: fs?.commandList ? fs.commandList.length : undefined,
    commandCount: fs?.commandList ? fs.commandList.length : undefined,
    bundleStats,
    snapshotFrozen,
    extra: gpuCoverageExtra,
  });
}

function updateGlobeListeners(scene, globe) {
  for (let i = 0; i < scene._removeGlobeCallbacks.length; ++i) {
    scene._removeGlobeCallbacks[i]();
  }
  scene._removeGlobeCallbacks.length = 0;

  const removeGlobeCallbacks = [];
  if (defined(globe)) {
    removeGlobeCallbacks.push(
      globe.imageryLayersUpdatedEvent.addEventListener(
        requestRenderAfterFrame(scene),
      ),
    );
    removeGlobeCallbacks.push(
      globe.terrainProviderChanged.addEventListener(
        requestRenderAfterFrame(scene),
      ),
    );
    // Advance the snapshot revision when imagery or terrain changes so an
    // active snapshot thaws before rendering a different base layer.
    const bumpSnapshotVersion = function () {
      scene._snapshotVersion = (scene._snapshotVersion ?? 0) + 1;
    };
    removeGlobeCallbacks.push(
      globe.imageryLayersUpdatedEvent.addEventListener(bumpSnapshotVersion),
    );
    removeGlobeCallbacks.push(
      globe.terrainProviderChanged.addEventListener(bumpSnapshotVersion),
    );
  }
  scene._removeGlobeCallbacks = removeGlobeCallbacks;
}

function pickedMetadataInfoChanged(command, frameState) {
  const oldPickedMetadataInfo = command.pickedMetadataInfo;
  const newPickedMetadataInfo = frameState.pickedMetadataInfo;
  if (oldPickedMetadataInfo?.schemaId !== newPickedMetadataInfo?.schemaId) {
    return true;
  }
  if (oldPickedMetadataInfo?.className !== newPickedMetadataInfo?.className) {
    return true;
  }
  if (
    oldPickedMetadataInfo?.propertyName !== newPickedMetadataInfo?.propertyName
  ) {
    return true;
  }
  return false;
}

function updateDerivedCommands(scene, command, shadowsDirty) {
  const frameState = scene._frameState;
  const context = scene._context;
  const oit = scene._view.oit;
  const { lightShadowMaps, lightShadowsEnabled } = frameState.shadowState;

  let derivedCommands = command.derivedCommands;

  if (defined(command.pickId)) {
    derivedCommands.picking = DerivedCommand.createPickDerivedCommand(
      scene,
      command,
      context,
      derivedCommands.picking,
    );
  }
  // Snap derived commands are only created on demand, during a snapping pass,
  // so applications that never call Scene.snap pay no shader-derivation cost.
  if (defined(command.snapId) && frameState.passes.snap) {
    derivedCommands.snapping = DerivedCommand.createSnapDerivedCommand(
      scene,
      command,
      context,
      derivedCommands.snapping,
    );
  }
  if (frameState.pickingMetadata && command.pickMetadataAllowed) {
    command.pickedMetadataInfo = frameState.pickedMetadataInfo;
    if (defined(command.pickedMetadataInfo)) {
      derivedCommands.pickingMetadata =
        DerivedCommand.createPickMetadataDerivedCommand(
          scene,
          command,
          context,
          derivedCommands.pickingMetadata,
        );
    }
  }
  if (!command.pickOnly && !command.isWebGPUDrawCommand) {
    // WebGPU commands carry prebuilt depth-only variants. Passing one through
    // the WebGL helper would shallow-clone it into a DrawCommand without the
    // pipeline and index-buffer state required by WebGPUContext.draw, so only
    // WebGL commands use this helper.
    derivedCommands.depth = DerivedCommand.createDepthOnlyDerivedCommand(
      scene,
      command,
      context,
      derivedCommands.depth,
    );
    if (frameState.passes.snap && !defined(command.snapId)) {
      derivedCommands.snappingOccluder =
        DerivedCommand.createSnapOccluderDerivedCommand(
          scene,
          command,
          context,
          derivedCommands.snappingOccluder,
        );
    }
  }

  derivedCommands.originalCommand = command;

  // Preserve the WebGL Moon's base-program appearance when its physical-depth
  // route changes pass ownership. See the matching dirty predicate above.
  if (scene._hdr && command._moonPhysicalDepthRoute !== true) {
    derivedCommands.hdr = DerivedCommand.createHdrCommand(
      command,
      context,
      derivedCommands.hdr,
    );
    command = derivedCommands.hdr.command;
    derivedCommands = command.derivedCommands;
  }

  if (lightShadowsEnabled && command.receiveShadows) {
    derivedCommands.shadows = ShadowMap.createReceiveDerivedCommand(
      lightShadowMaps,
      command,
      shadowsDirty,
      context,
      derivedCommands.shadows,
    );
  }

  if (command.pass === Pass.TRANSLUCENT && defined(oit) && oit.isSupported()) {
    if (lightShadowsEnabled && command.receiveShadows) {
      derivedCommands.oit = defined(derivedCommands.oit)
        ? derivedCommands.oit
        : {};
      derivedCommands.oit.shadows = oit.createDerivedCommands(
        derivedCommands.shadows.receiveCommand,
        context,
        derivedCommands.oit.shadows,
      );
    } else {
      derivedCommands.oit = oit.createDerivedCommands(
        command,
        context,
        derivedCommands.oit,
      );
    }
  }
}

const renderTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.RENDER,
});

const preloadTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.PRELOAD,
});

const preloadFlightTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.PRELOAD_FLIGHT,
});

const requestRenderModeDeferCheckPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.REQUEST_RENDER_MODE_DEFER_CHECK,
});

const scratchCullingVolume = new CullingVolume();

function prePassesUpdate(scene) {
  scene._jobScheduler.resetBudgets();

  const frameState = scene._frameState;
  scene.primitives.prePassesUpdate(frameState);

  if (defined(scene.globe)) {
    scene.globe.update(frameState);
  }

  scene._picking.update();
  frameState.creditDisplay.update();
}

function postPassesUpdate(scene) {
  scene.primitives.postPassesUpdate(scene._frameState);
  RequestScheduler.update();
}

const scratchBackgroundColor = new Color();

// Reuse eclipse options to keep the per-frame update allocation-free. The call
// site overwrites every field before use.
const scratchEclipseOptions = {
  active: true,
  enabled: true,
  autoExposure: false,
  horizonTwilightEnabled: true,
  cameraPositionWC: undefined,
  cameraHeight: 0.0,
  sunPositionWC: undefined,
  moonPositionWC: undefined,
  time: undefined,
  earthOccluderRadius: undefined,
};

/**
 * Prepare camera-dependent eclipse state for the active logical View.
 *
 * Mutable state belongs to `View`, while FrameState exposes aliases for the
 * active update and render path. This function is called
 * by `Scene.updateFrameState()` after the camera, occluder, mode, light, and
 * globe-translucency state are current, and therefore before every full
 * `UniformState.update(frameState)` entry (main render, pick, and offscreen
 * logical views). Pass-camera-only overrides intentionally use
 * `UniformState.updateCamera()` and do not enter here.
 *
 * The computation remains unconditional (a couple of dot products and two
 * asin in the common no-occlusion case, which early-outs before quadrature);
 * `enableEclipse` gates only whether consumers apply the result.
 *
 * The Earth occluder is taken straight off `frameState.occluder` — the same
 * sphere `Scene.updateEnvironment` feeds to the binary
 * `Occluder.isBoundingSphereVisible` cull. Reading its radius reproduces every
 * `SceneUtilities.getOccluder` guard: 2D/Columbus view, a hidden globe, an
 * underground camera and a translucent globe all leave it undefined.
 *
 * In 3D the inputs share world coordinates. In 2D, Columbus view, and
 * morphing, the camera is in projected
 * coordinates while the Sun and Moon are ECEF. Identity is the frame-correct
 * result in those modes.
 *
 * Publication must precede `UniformState.update(frameState)`, because
 * UniformState consumes the scene-light factor and is re-entered by picking
 * and offscreen views. Sun/moon world positions come from FrameState's
 * authoritative sample, avoiding both a second ephemeris evaluation and the
 * previous-frame value in UniformState before its update.
 *
 * @param {Scene} scene
 * @private
 */
function prepareLogicalViewEclipse(scene) {
  const frameState = scene._frameState;
  const view = frameState.view;

  // Publish the canonical atmospheric-conditions facade before deriving
  // eclipse state for every logical view, including pick and offscreen paths.
  frameState.atmosphericConditions = defined(scene.globe)
    ? scene.globe.atmosphericConditions
    : undefined;

  const eclipseLighting = frameState.atmosphericConditions?.lighting;
  const occluder = scene._globeTranslucencyState.sunVisibleThroughGlobe
    ? undefined
    : frameState.occluder;
  scratchEclipseOptions.active = frameState.mode === SceneMode.SCENE3D;
  scratchEclipseOptions.enabled = defined(eclipseLighting)
    ? eclipseLighting.enableEclipse !== false
    : true;
  scratchEclipseOptions.autoExposure =
    eclipseLighting?.eclipseAutoExposure === true;
  scratchEclipseOptions.horizonTwilightEnabled = defined(eclipseLighting)
    ? eclipseLighting.enableEclipseHorizonTwilight !== false
    : true;
  scratchEclipseOptions.cameraPositionWC = frameState.camera?.positionWC;
  scratchEclipseOptions.cameraHeight =
    frameState.camera?.positionCartographic?.height ?? 0.0;
  const celestialEphemerisSample = frameState.celestialEphemerisSample;
  scratchEclipseOptions.sunPositionWC = celestialEphemerisSample?.sunPositionWC;
  scratchEclipseOptions.moonPositionWC =
    celestialEphemerisSample?.moonPositionWC;
  scratchEclipseOptions.time = frameState.time;
  scratchEclipseOptions.earthOccluderRadius = defined(occluder)
    ? occluder.radius
    : undefined;

  frameState.eclipseState = updateEclipseState(
    view._eclipseState,
    scratchEclipseOptions,
  );
  // Publish one scalar for every scene-dimming consumer. It is 1.0 outside an
  // enabled lunar eclipse.
  view._eclipseSceneLightFactor = getEclipseSceneLightFactor(
    frameState.eclipseState,
  );
  frameState.eclipseSceneLightFactor = view._eclipseSceneLightFactor;

  // A FrameState is reused across logical views and mini-frames, so begin a
  // fresh memo window and clear the prior view's transient alias.
  // Classification is deferred to the command owner that has the exact
  // terrain set: dynamic-environment capture uses its retained sources, the
  // main globe uses its current selection, and pick uses its rebuilt set.
  frameState.eclipseGlobeShadow = undefined;
  frameState.eclipseGlobeShadowPrepared = false;
  frameState.eclipseGlobeShadowSurfaceRadius = undefined;
  frameState.eclipseGlobeShadowSelectionRevision = undefined;

  // Publish the horizon-twilight gain, which is 0.0 outside near-totality and
  // above the atmosphere.
  view._eclipseHorizonTwilight = getEclipseHorizonTwilightFactor(
    frameState.eclipseState,
  );
  frameState.eclipseHorizonTwilight = view._eclipseHorizonTwilight;
}

function render(scene) {
  const frameState = scene._frameState;

  const context = scene.context;
  const { uniformState } = context;

  const view = scene._defaultView;
  scene._view = view;

  setCpuScenePhase(scene, "frameState");
  scene.updateFrameState();

  const viewContext = view.effectiveContext;
  if (viewContext && viewContext !== frameState.context) {
    frameState.context = viewContext;
    frameState.graphicsContext = viewContext;
  }

  frameState.passes.render = true;
  frameState.passes.postProcess = scene.postProcessStages.hasSelected;
  frameState.tilesetPassState = renderTilesetPassState;

  let backgroundColor = scene.backgroundColor ?? Color.BLACK;
  if (scene._hdr) {
    backgroundColor = Color.clone(backgroundColor, scratchBackgroundColor);
    backgroundColor.red = Math.pow(backgroundColor.red, scene.gamma);
    backgroundColor.green = Math.pow(backgroundColor.green, scene.gamma);
    backgroundColor.blue = Math.pow(backgroundColor.blue, scene.gamma);
  }
  frameState.backgroundColor = backgroundColor;

  frameState.atmosphere = scene.atmosphere;
  // `updateEnvironment` publishes the authoritative same-frame value after
  // applying render-pass, mode and globe-readiness gates. Reset here so a
  // skipped environment update cannot leak the prior frame's visibility into
  // moon/star extinction or default-on star modulation.
  frameState.skyAtmosphereVisible = false;
  scene.fog.update(frameState);

  uniformState.update(frameState);

  // Publish the world-space Sun direction so celestial and atmosphere
  // renderers do not reach into per-context uniform state.
  frameState.sunDirectionWC = uniformState.sunDirectionWC;

  const shadowMap = scene.shadowMap;
  if (defined(shadowMap) && shadowMap.enabled) {
    if (!defined(scene.light) || scene.light instanceof SunLight) {
      Cartesian3.negate(
        uniformState.sunDirectionWC,
        scene._shadowMapCamera.direction,
      );
    } else {
      Cartesian3.clone(scene.light.direction, scene._shadowMapCamera.direction);
    }
    frameState.shadowMaps.push(shadowMap);
  }

  scene._computeCommandList.length = 0;
  scene._overlayCommandList.length = 0;

  const viewport = view.viewport;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = context.drawingBufferWidth;
  viewport.height = context.drawingBufferHeight;

  const passState = view.passState;
  passState.framebuffer = undefined;
  passState.blendingEnabled = undefined;
  passState.scissorTest = undefined;
  passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

  setCpuScenePhase(scene, "contextBegin");
  context.beginFrame();

  // Give this View's presentation an identity independent of frameNumber,
  // which wraps and can repeat while an intermittently scheduled View retains
  // older history. Explicit-command contexts resolve the retained callback at
  // queue.submit; immediate-mode contexts commit after endFrame returns.
  const temporalHistory = view._temporalHistory;
  const temporalPresentationToken =
    beginViewTemporalHistoryPresentation(temporalHistory);
  const temporalPresentationEpoch = temporalHistory.presentationEpoch;
  stagePresentedViewTemporalHistory(
    temporalHistory,
    uniformState,
    frameState,
    temporalPresentationToken,
    temporalPresentationEpoch,
  );
  const temporalHistoryHasSubmitBoundary =
    typeof context.enqueueAfterFrameSubmit === "function";
  if (temporalHistoryHasSubmitBoundary) {
    enqueuePresentedViewTemporalHistoryCommit(temporalHistory, context);
  }

  setCpuScenePhase(scene, "sceneEnvironmentUpdate");
  if (defined(scene.globe)) {
    scene.globe.beginFrame(frameState);
  }

  // Let the alternate renderer recreate its framebuffer and advance the
  // pipeline-format generation before primitives update. This exposes an HDR
  // format change to commands produced during the update phase and prevents
  // pipeline-to-attachment mismatches. WebGL has no alternate renderer.
  if (scene._alternateSceneRenderer?.prepareFrame) {
    scene._alternateSceneRenderer.prepareFrame({
      scene: scene,
      context: context,
      useHDR: scene._hdr,
    });
  }

  scene.updateEnvironment();

  // Compute the TAA sub-pixel sample offset before rendering. The effect
  // stores explicit NDC (raster projection) and UV (resolve) representations.
  // The WebGPU scene renderer applies only the NDC value to its reusable
  // scratch frustum for each depth slice; the persistent camera-frustum cache
  // is never mutated. When snapshot mode is frozen, both representations are
  // zeroed to prevent temporal dither accumulation.
  //
  // Also pushes the motion-vector matrices + camera delta into the TAA
  // effect. Matrices come from UniformState:
  //   - current VP_RTE  : model-independent VP (proj × view-with-eye-at-origin)
  //   - previous VP_RTE : snapshotted at the top of UniformState.update()
  //   - camera delta     : FP64 subtraction of world-space camera positions
  // The TAA shader uses these for depth-based reprojection without
  // reconstructing world-space positions, which would lose ~1m FP32 at
  // Earth scale and produce catastrophic motion-vector errors during
  // orbital fly-to.
  // The alternate scene renderer owns the TAA effect. On WebGL the optional
  // chain short-circuits because no alternate renderer exists.
  if (scene.taaEnabled) {
    const pipeline = scene._alternateSceneRenderer?._postProcess;
    const taa = pipeline?.taaEffect;
    if (taa) {
      const frozen = scene._snapshotMode?.isFrozen === true;
      if (frozen) {
        taa.resetJitter();
      } else {
        taa.computeJitter(
          frameState.frameNumber,
          context.drawingBufferWidth,
          context.drawingBufferHeight,
        );
      }

      const us = context.uniformState;
      const currentVpRte = us.viewProjectionRelativeToEye;
      const previousVpRte = us.previousViewProjectionRelativeToEye;
      const currCam = us.cameraPosition;
      const prevCam = us.previousCameraPosition;
      // FP64 subtraction — both operands are JS `number` (FP64) so the
      // 6.37M-magnitude positions cancel cleanly. The resulting delta is
      // per-frame-small (meters during typical camera motion) and down-casts
      // to FP32 without losing meaningful precision.
      const deltaX = currCam.x - prevCam.x;
      const deltaY = currCam.y - prevCam.y;
      const deltaZ = currCam.z - prevCam.z;

      // UniformState derives validity from the active view's last successfully
      // presented frame. It covers the first frame, teleports, morphs,
      // mode/map-projection changes, and perspective/orthographic flips while
      // keeping logical views independent.
      const historyInvalid =
        !us.temporalHistoryValid ||
        frameState._moonPhysicalDepthRouteChanged === true;
      if (historyInvalid) {
        // Drop the history buffer for this frame so the upcoming execute()
        // returns the un-reprojected source (no blend against the stale,
        // incompatible-projection history). Accumulation restarts clean on
        // the next frame once both projections agree again.
        taa.resetHistory();
      }

      // historyValid is false until at least one frame has been seen; the TAA
      // effect's own frameCounter also gates the blend, but keeping the
      // motion-vector flag independent lets the shader choose whether to
      // reproject or fall back to UV-identity on its own terms.
      taa.updateMotionVectorParams(
        currentVpRte,
        previousVpRte,
        deltaX,
        deltaY,
        deltaZ,
        !historyInvalid,
      );
    }
  }

  // Feed motion blur the same motion-vector state as TAA without depending on
  // `scene.taaEnabled`, so it also works when TAA is disabled. The
  // default-disabled gate touches no effect state, and WebGL has no alternate
  // post-process renderer.
  if (scene.motionBlur === true) {
    const mbPipeline = scene._alternateSceneRenderer?._postProcess;
    const mb = mbPipeline?.motionBlurEffect;
    if (mb) {
      const us = context.uniformState;
      const currentVpRte = us.viewProjectionRelativeToEye;
      const previousVpRte = us.previousViewProjectionRelativeToEye;
      const currCam = us.cameraPosition;
      const prevCam = us.previousCameraPosition;
      // FP64 subtraction — 6.37M-magnitude positions cancel cleanly; the
      // per-frame-small delta down-casts to FP32 without meaningful loss.
      const mbDeltaX = currCam.x - prevCam.x;
      const mbDeltaY = currCam.y - prevCam.y;
      const mbDeltaZ = currCam.z - prevCam.z;
      mb.updateMotionVectorParams(
        currentVpRte,
        previousVpRte,
        mbDeltaX,
        mbDeltaY,
        mbDeltaZ,
        us.temporalHistoryValid,
      );
    }
  }

  setCpuScenePhase(scene, "visibilityCommandPrep");
  scene.updateAndExecuteCommands(passState, backgroundColor);

  setCpuScenePhase(scene, "frameFinalize");
  scene.resolveFramebuffers(passState);

  passState.framebuffer = undefined;
  executeOverlayCommands(scene, passState);

  if (defined(scene.globe)) {
    scene.globe.endFrame(frameState);

    if (!scene.globe.tilesLoaded) {
      scene._renderRequested = true;
    }
  }

  setCpuScenePhase(scene, "contextEndSubmit");
  context.endFrame();
  if (!temporalHistoryHasSubmitBoundary) {
    commitPresentedViewTemporalHistory(
      temporalHistory,
      temporalPresentationToken,
      temporalPresentationEpoch,
    );
  }
}

const cpuAccountingSceneGuard = new WeakMap();

function setCpuScenePhase(scene, phase) {
  const frameState = scene._frameState;
  const renderer = frameState._cpuSceneProfileRenderer;
  if (!defined(renderer)) {
    return false;
  }
  return renderer.setCpuScenePhase(
    frameState._cpuSceneProfileFrameNumber,
    phase,
  );
}

function renderSceneWithCpuAccounting(scene, time, renderer) {
  const frameState = scene._frameState;
  const expectedFrameNumber = CesiumMath.incrementWrap(
    frameState.frameNumber,
    15000000.0,
    1.0,
  );
  let renderErrorRaised = false;
  let recorded = false;
  let removeRenderErrorListener;

  let accountingState = cpuAccountingSceneGuard.get(scene);
  if (!defined(accountingState)) {
    accountingState = {
      active: false,
      baseEntryExpected: false,
      reentered: false,
    };
    cpuAccountingSceneGuard.set(scene, accountingState);
  }
  accountingState.active = true;
  accountingState.baseEntryExpected = true;
  accountingState.reentered = false;
  frameState._cpuSceneProfileRenderer = renderer;
  frameState._cpuSceneProfileFrameNumber = expectedFrameNumber;

  try {
    removeRenderErrorListener = scene._renderError.addEventListener(() => {
      renderErrorRaised = true;
    });

    // Install every fail-closed guard before sampling. The profiler's returned
    // timestamp is the one shared whole-frame start, immediately adjacent to
    // the immutable render implementation it measures.
    const startTimestamp = renderer.beginCpuSceneFrame(
      expectedFrameNumber,
      "sceneUpdate",
    );
    if (!defined(startTimestamp)) {
      return renderSceneForCpuAccounting.call(scene, time);
    }
    renderSceneForCpuAccounting.call(scene, time);
    const endTimestamp = performance.now();
    const totalMs = endTimestamp - startTimestamp;

    // A suppressed request-render invocation has no logical render frame.
    // Reentrant rendering is rejected explicitly even when the nested call was
    // request-render suppressed and therefore left the frame token unchanged.
    if (
      !renderErrorRaised &&
      !accountingState.reentered &&
      frameState.newFrame === true &&
      frameState.frameNumber === expectedFrameNumber &&
      scene._alternateSceneRenderer === renderer &&
      renderer.cpuPassProfilingEnabled === true
    ) {
      recorded =
        renderer.recordSceneFrameCpu(
          expectedFrameNumber,
          totalMs,
          endTimestamp,
        ) === true;
    }
  } finally {
    try {
      try {
        if (!recorded) {
          renderer.cancelCpuSceneFrame(expectedFrameNumber);
        }
      } finally {
        if (defined(removeRenderErrorListener)) {
          removeRenderErrorListener();
        }
      }
    } finally {
      accountingState.active = false;
      accountingState.baseEntryExpected = false;
      frameState._cpuSceneProfileRenderer = undefined;
      frameState._cpuSceneProfileFrameNumber = undefined;
    }
  }
}

function tryAndCatchError(scene, functionToExecute) {
  try {
    functionToExecute(scene);
  } catch (error) {
    console.error("[tryAndCatchError] ❌ ERROR CAUGHT:", error);
    console.error("[tryAndCatchError] Stack trace:", error.stack);
    scene._renderError.raiseEvent(scene, error);

    if (scene.rethrowRenderErrors) {
      throw error;
    }
  }
}

function updateMostDetailedRayPicks(scene) {
  return scene._picking.updateMostDetailedRayPicks(scene);
}

function updatePreloadPass(scene) {
  const frameState = scene._frameState;
  preloadTilesetPassState.camera = frameState.camera;
  preloadTilesetPassState.cullingVolume = frameState.cullingVolume;

  const primitives = scene.primitives;
  primitives.updateForPass(frameState, preloadTilesetPassState);
}

function updatePreloadFlightPass(scene) {
  const frameState = scene._frameState;
  const camera = frameState.camera;
  if (!camera.canPreloadFlight()) {
    return;
  }

  preloadFlightTilesetPassState.camera = scene.preloadFlightCamera;
  preloadFlightTilesetPassState.cullingVolume =
    scene.preloadFlightCullingVolume;

  const primitives = scene.primitives;
  primitives.updateForPass(frameState, preloadFlightTilesetPassState);
}

function updateRequestRenderModeDeferCheckPass(scene) {
  scene.primitives.updateForPass(
    scene._frameState,
    requestRenderModeDeferCheckPassState,
  );
}

function setTerrain(scene, terrain) {
  scene._removeTerrainProviderReadyListener =
    scene._removeTerrainProviderReadyListener &&
    scene._removeTerrainProviderReadyListener();

  if (terrain.ready) {
    if (defined(scene.globe)) {
      scene.globe.terrainProvider = terrain.provider;
    }
    return;
  }
  scene.globe.terrainProvider = undefined;
  scene._removeTerrainProviderReadyListener =
    terrain.readyEvent.addEventListener((provider) => {
      if (defined(scene) && defined(scene.globe)) {
        scene.globe.terrainProvider = provider;
      }

      scene._removeTerrainProviderReadyListener();
    });
}

const scratchPickColumnDirection = new Cartesian3();

export default Scene;
