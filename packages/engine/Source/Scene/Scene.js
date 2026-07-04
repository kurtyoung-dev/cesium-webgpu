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
import JulianDate from "../Core/JulianDate.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import RenderScheduler from "./RenderScheduler.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import RequestScheduler from "../Core/RequestScheduler.js";
import TaskProcessor from "../Core/TaskProcessor.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import ComputeEngine from "../Renderer/ComputeEngine.js";
import Context from "../Renderer/Context.js";
import ContextFactory from "../Renderer/ContextFactory.js";
import ContextLimits from "../Renderer/ContextLimits.js";
import Pass from "../Renderer/Pass.js";
import RenderState from "../Renderer/RenderState.js";
import Atmosphere from "./Atmosphere.js";
import AtmosphericConditions from "./AtmosphericConditions.js";
import { computeSkyBrightness } from "./SkyBrightness.js";
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
import SpecularEnvironmentCubeMap from "./SpecularEnvironmentCubeMap.js";
import StencilConstants from "./StencilConstants.js";
import { LightCollection } from "./LightTypes.js";
import SunLight from "./SunLight.js";
import computeAtmosphereDerivedLighting from "./AtmosphereDerivedLighting.js";
import TweenCollection from "./TweenCollection.js";
import View from "./View.js";
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
import {
  executeCommandsInViewport,
  execute2DViewportCommands,
  executeWebVRCommands,
} from "./ViewportExecutor.js";

// Track V-A3 — scratch for the local-up vector passed to the atmosphere-
// derived lighting (camera position direction). Module-scope to avoid a
// per-frame allocation.
const scratchAtmosphereUp = new Cartesian3();

const requestRenderAfterFrame = function (scene) {
  return function () {
    scene.frameState.afterRender.push(function () {
      scene.requestRender();
    });
  };
};

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
   *
   * @exception {DeveloperError} options and options.canvas are required.
   */
  constructor(options) {
    options = options ?? Frozen.EMPTY_OBJECT;
    const canvas = options.canvas;
    let creditContainer = options.creditContainer;
    let creditViewport = options.creditViewport;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("options and options.canvas are required.");
    }
    //>>includeEnd('debug');

    // Check for pre-initialized context (from Scene.createAsync for WebGPU support)
    let countReferences = false;
    if (defined(options._preInitializedContext)) {
      // WebGPU path - context already created asynchronously
      this._context = options._preInitializedContext;
    } else {
      // WebGL path - synchronous context creation (backward compatible)
      countReferences = options.contextOptions instanceof SharedContext;
      if (countReferences) {
        this._context = options.contextOptions.createSceneContext(canvas);
      } else {
        const contextOptions = clone(options.contextOptions);
        this._context = new Context(canvas, contextOptions);
      }
    }
    const context = this._context;

    // Set Matrix4 depth range based on renderer type
    // WebGPU uses 0-1 depth range, WebGL uses -1 to 1
    // Use capability getter instead of string comparison (FORK-7 fix)
    if (context.depthRangeZeroToOne) {
      Matrix4.setDepthRangeType("webgpu");
    } else {
      Matrix4.setDepthRangeType("webgl");
    }

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

    this._id = createGuid();
    this._jobScheduler = new JobScheduler();
    this._frameState = new FrameState(
      context,
      new CreditDisplay(creditContainer, "•", creditViewport),
      this._jobScheduler,
    );
    this._frameState.scene3DOnly = options.scene3DOnly ?? false;
    this._removeCreditContainer = !hasCreditContainer;
    this._creditContainer = creditContainer;

    this._canvas = canvas;
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
      // CRITICAL error — the context's backend contract requires a
      // `SCENE_RENDERER` FR (it owns the canvas blit / post-process
      // composite). Without it the canvas stays black. WebGPU sets this
      // predicate; WebGL leaves it at the default `false`.
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

    // B213-O2 (Batch 219) + B219-N4 (Batch 225 audit fix) — register
    // HDR fallback listener so this scene's `_useHDRCanvasOutput`
    // follows the canvas reality when the context's extended-
    // toneMapping configure fails (e.g., older browser) and the
    // context demotes itself to SDR. Each Scene attached to the
    // context registers its own listener via the Set-based API so
    // multi-scene-per-context configs (split-screen, PiP) all sync
    // — the prior single-slot design only synced the last-installed
    // scene.
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

    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 1) — subscribe to the
    // context's async resource monitor so this scene wakes itself up
    // when an inflight WebGPU pipeline / shader / texture upload
    // resolves after the scene has hibernated. WebGL contexts don't
    // expose `asyncResources` (the field is undefined), so the
    // optional chain skips the subscription entirely — WebGL paths
    // pay zero overhead. The corresponding `pendingCount` read in the
    // `shouldRender` gate is the defense-in-depth path that keeps
    // frames rendering while inflight, even if the subscriber fan-out
    // is dropped for any reason.
    this._asyncResourceUnsub = null;
    const asyncResources = context?.asyncResources;
    if (
      defined(asyncResources) &&
      typeof asyncResources.subscribe === "function"
    ) {
      // Phase 6 — pass `sceneId` so the monitor can filter events
      // scoped to other scenes' work (multi-context split-screen).
      // For tokens without an `ownerSceneIds` set (the default — most
      // pipelines are shared across scenes attached to the same
      // context), every subscriber fires regardless of `sceneId`,
      // matching the Phase 1 behavior.
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

    /**
     * The render scheduler manages layered sorting, material batching,
     * and predictive sort queries. Sits above CesiumJS's 5 existing
     * sorting mechanisms and unifies them.
     * @type {RenderScheduler}
     * @private
     */
    this._renderScheduler = new RenderScheduler();

    // SORT-11: Auto-configure octree root half-extent for the scene's ellipsoid
    // This ensures non-Earth bodies (Moon, Mars) have correctly-sized octree bounds.
    this._renderScheduler.octree.rootHalfExtent =
      this._ellipsoid.maximumRadius * 1.1;

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
     * WebGPU only — the WebGL terrain pipeline does not currently expose a
     * wireframe variant. The wireframe pipeline mirrors the production
     * pipeline's vertex layout exactly so it works on every quantization
     * + normal + WebMercator + stride combination.
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
     * correctly and that the WGF-5 normal-map shader chain produces
     * sensible results.
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
     * dumps the next 4 tile updates to the console with the full imagery
     * probe payload (encoding, stride, ready imagery state, texture
     * coordinate rectangle, translation+scale, sample vertex UVs). Used
     * for the BUG-11 imagery investigation. The flag latches at the
     * 4-tile mark — set it back to <code>false</code> and re-set to
     * <code>true</code> to capture another batch.
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
     * (modes 3/4) spends the FULL color range on the linear-eye-z band
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
     * When <code>true</code>, the ellipsoid depth-plane render is skipped (both
     * backends). The depth plane is drawn between the globe and 3D-Tiles when
     * <code>clearGlobeDepth</code> is active (the default, since
     * <code>depthTestAgainstTerrain</code> defaults false) so primitives on the
     * globe backface aren't picked. This toggle bisects whether the depth plane
     * is what occludes terrain-flush 3D-Tiles / b3dm on WebGPU (DEFERRED_WORK
     * C-R9): if content reappears with this on, the depth plane writes a depth
     * nearer than the content. Use {@link CesiumDebug#skipDepthPlane}.
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
    });

    /**
     * When <code>false</code>, 3D Tiles will render normally. When <code>true</code>, classified 3D Tile geometry will render normally and
     * unclassified 3D Tile geometry will render with the color multiplied by {@link Scene#invertClassificationColor}.
     * @type {boolean}
     * @default false
     */
    this.invertClassification = false;

    /**
     * Phase 8a (Batch 80, Slice 2 — Batch 85, Slice 2b — Batch 86) —
     * enables the depth-prepass + normal G-buffer producer pass on the
     * WebGPU backend. When <code>true</code>, the scene runs an extra
     * compute pass after the main scene render that reconstructs
     * eye-space normals from the depth buffer and writes them into
     * <code>view.gBufferFramebuffer</code>. Future Slice 4+ rewires
     * SSAO / SSR / clustered lighting consumers to read from this
     * G-buffer instead of reconstructing normals themselves.
     *
     * No-op on the WebGL backend (the WebGPU backend gates the producer
     * on this flag + compute-shader capability).
     *
     * @type {boolean}
     * @default false
     */
    this.deferredLighting = false;

    /**
     * Phase 8a Slice 2c (Batch 89) — debug toggle that replaces the
     * production post-process chain with a fullscreen blit of
     * `view.gBufferFramebuffer.normalRoughnessTexture` as a normal-map
     * visualization. Activated via `CesiumDebug.showGBufferNormals()`.
     *
     * No-op on WebGL backend. Requires
     * {@link Scene#deferredLighting} to be enabled for the G-buffer
     * to populate this frame.
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

    // ── WebGPU environmental effects (opt-in) ──
    this._enableSSR = false;

    // Slice 5c-B Batch 123 — NPR outline pass (WebGPU only). Reads
    // G-buffer slot 1 + scene depth, paints silhouette / crease edges.
    // Off by default — hard outlines clash with the photorealistic
    // globe presentation; opt-in via `scene.enableNPROutlines = true`.
    this._enableNPROutlines = false;

    // Slice 5c-B Batch 133 — screen-space contact shadows (WebGPU
    // only). Reads G-buffer slot 1 + scene depth, marches the sun
    // direction in eye-space and darkens fragments where a
    // screen-space occluder is within the marched distance. Off by
    // default — opt-in via `scene.enableContactShadows = true`.
    this._enableContactShadows = false;

    // Slice 5d Batch 150 — Forward+ clustered lighting. When true and
    // `scene.lights.length > 0`, the WebGPU SceneRenderer dispatches
    // the cluster-bounds + cluster-assign compute passes each frame
    // and binds the resulting storage buffers to consumer material
    // pipelines (Model PBR + Lit Mat shaders). Default false — opt-in.
    // No-op on WebGL.
    this._clusteredLightingEnabled = false;
    this._enableWeather = false;
    this._weatherType = 0;
    this._weatherIntensity = 0.5;
    this._weatherWindSpeed = 10.0;
    this._weatherWindDirection = { x: 0.7, y: 0.3 };

    this._brdfLutGenerator = new BrdfLutGenerator();

    this._performanceDisplay = undefined;
    this._debugVolume = undefined;

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
     * Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — when true (WebGPU
     * only), a unified per-pixel aerial-perspective atmosphere post-process
     * applies one depth-correct haze (transmittance extinction + inscatter)
     * over the WHOLE scene (terrain, 3D tiles, glTF models, geometry),
     * replacing the per-tile ground-atmosphere drape. Distant features dim,
     * redden, and gain inscattered sky light exactly like real aerial
     * perspective. The in-globe ground-atmosphere/fog drape is gated OFF while
     * this is active so the two don't double-apply; the sky/atmosphere shell
     * (WebGPUSkyAtmosphereRenderer) is left untouched. No effect on WebGL.
     *
     * @type {boolean}
     * @default false
     */
    this.aerialPerspective = options.aerialPerspective ?? false;

    /**
     * Item 2.3 (AERIAL-FROXEL) — when true (WebGPU only, and only while
     * {@link Scene#aerialPerspective} is also true), the aerial-perspective
     * atmosphere is evaluated from a pre-baked 32³ froxel volume (one trilinear
     * fetch per pixel, Hillaire 2020) instead of the per-pixel analytic march.
     * Decouples the cost from screen resolution and is temporally stable. Both
     * flags default false → no aerial perspective at all in the parity default;
     * turning this on with {@link Scene#aerialPerspective} on swaps the analytic
     * march for the froxel fast path. No effect on WebGL.
     *
     * @type {boolean}
     * @default false
     */
    this.aerialPerspectiveFroxel = options.aerialPerspectiveFroxel ?? false;

    /**
     * MORPH-TAA-PREVVP — last frame's projection type (true = orthographic,
     * false = perspective) as seen by the TAA motion-vector path. Used to
     * detect the perspective↔orthographic flip that happens mid-morph so the
     * TAA history can be invalidated for that frame (reprojecting against the
     * prior-projection `previousViewProjection` would smear/ghost). `undefined`
     * until the first taaEnabled frame so the flip check is a no-op on frame 1.
     * @type {boolean|undefined}
     * @private
     */
    this._taaPrevProjectionOrtho = undefined;

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
     * Change BEFORE enabling `useCascadedShadowMaps` — the texture is
     * allocated on first CSM frame and will NOT re-allocate if the value
     * changes later (future slice can add a re-allocation hook).
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
     * Read once at CSM init time (the first CSM frame); like
     * `cascadedShadowMapResolution`, change it BEFORE enabling
     * `useCascadedShadowMaps`.
     *
     * @type {boolean}
     * @default true
     */
    this.cascadedShadowMapSoftShadows =
      options.cascadedShadowMapSoftShadows ?? true;

    // Bumped by subsystems that mutate scene-visible state in ways that
    // invalidate frozen render bundles. Used by the snapshot/locked-orbit
    // mode (future Phase 0.7) to know when to discard cached bundles.
    // Currently bumped only by Cesium3DTilesInvalidationFeed.apply().
    this._snapshotVersion = 0;

    // Adaptive visual quality coordinator. Disabled by default — features
    // register probes/sinks against this surface so the auto-tuner (future
    // phase) can scale them to hit a target framerate. See
    // VisualPerformanceTargetService for the contract.
    this._visualPerformanceTarget = new VisualPerformanceTargetService();

    // Snapshot / locked-orbit mode coordinator. Disabled by default —
    // freezable subsystems (WebGPURenderBundleManager in Phase 1+, fog
    // froxel grids in Phase 2) register here so the service can ask
    // them to freeze/thaw their caches in lockstep. Reconciles against
    // `_snapshotVersion` (see below) to auto-thaw on invalidation.
    this._snapshotMode = new SnapshotModeService();

    // Phase 2 perf benchmarking — backend-neutral trace recorder.
    // Inactive by default; activated by `Scene.beginPerformanceTrace()`
    // and ticked once per rendered frame between begin/end. While
    // inactive its `sample()` is a one-comparison no-op so production
    // scenes pay nothing.
    this._performanceTracker = new PerformanceTracker();

    // Phase 6 audit fix — primitive collection mutations now bump
    // `_snapshotVersion` so SnapshotModeService.tick() can auto-thaw
    // on the next frame. Without this, adding/removing entities or
    // tilesets while frozen would silently leak the new state out
    // of the bundle cache (or fail to render the new content at all).
    // Cesium3DTilesInvalidationFeed.apply() also bumps this for tile
    // refines; here we cover the coarser collection-level mutations.
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

    this._hdr = undefined;
    this._hdrDirty = undefined;
    this.highDynamicRange = false;
    this.gamma = 2.2;

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

    // Track V-A3 (NEW-ATMO-DERIVED-LIGHTING) — a private SunLight whose
    // colour/intensity is re-derived each frame from the atmosphere (sun
    // transmittance) when `aerialPerspective` is enabled (WebGPU). Published
    // as `frameState.light` ONLY while aerial perspective is on, so discrete
    // models are lit by the same sun that produces the post-process haze. The
    // user's `scene.light` is never mutated (turning aerial perspective off
    // restores it untouched). The sky-irradiance ambient is published
    // alongside on `frameState.atmosphereSkyIrradiance`.
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

    // Phase 0.3: wire canonical facades onto the Globe. Runs after
    // `this.atmosphere`, `this.fog`, and `this.skyAtmosphere` are all set up
    // because the facade reads from those during property access. See
    // `Scene/AtmosphericConditions.js` and `Scene/GlobeWater.js`.
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
   * // Create scene with WebGL (backward compatible)
   * const scene = await Cesium.Scene.createAsync({
   *   canvas: canvas
   * });
   */
  static async createAsync(options, onProgress) {
    options = options ?? Frozen.EMPTY_OBJECT;

    //>>includeStart('debug', pragmas.debug);
    if (!defined(options.canvas)) {
      throw new DeveloperError("options and options.canvas are required.");
    }
    //>>includeEnd('debug');

    // Report initial progress
    if (defined(onProgress)) {
      onProgress(10, "Initializing graphics context...");
    }

    // Check if we need async context creation (WebGPU)
    const contextOptions = options.contextOptions ?? {};
    const needsAsyncContext = contextOptions.renderer === "webgpu";

    let context;
    if (needsAsyncContext) {
      // Create WebGPU context asynchronously
      context = await ContextFactory.createContext(
        options.canvas,
        contextOptions,
      );

      if (defined(onProgress)) {
        onProgress(70, "Context ready...");
      }

      // FORK-3 fix: Shader loading is now part of WebGPUContext._initialize().
      // No redundant shader loading here — shaders are already loaded during context init.
    }

    // Create scene with pre-initialized context (or undefined for WebGL)
    const sceneOptions = {
      ...options,
      _preInitializedContext: context,
    };

    const scene = new Scene(sceneOptions);

    if (defined(onProgress)) {
      onProgress(100, "Ready");
    }

    return scene;
  }

  // ═══════════════════════════════════════════════════════════
  // GETTERS AND SETTERS
  // ═══════════════════════════════════════════════════════════

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
    return ContextLimits.maximumAliasedLineWidth;
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
    return ContextLimits.maximumCubeMapSize;
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
   * Returns <code>true</code> if the {@link Scene#sampleHeight} and {@link Scene#sampleHeightMostDetailed} functions are supported.
   *
   * On WebGPU the synchronous {@link Scene#sampleHeight} reuses the main
   * scene depth (NEW-PICK-RAY-ASYNC, Batch 284): it projects the position
   * into the live view and reconstructs the surface height beneath it. It is
   * one-frame-stale (the first query at a new location returns
   * <code>undefined</code> and converges in 1-2 frames) and only resolves for
   * positions currently visible in the view. The asynchronous
   * {@link Scene#sampleHeightMostDetailed} variant is always supported.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#sampleHeight
   * @see Scene#sampleHeightMostDetailed
   */
  get sampleHeightSupported() {
    return this._context.depthTexture;
  }

  /**
   * Returns <code>true</code> if the {@link Scene#clampToHeight} and {@link Scene#clampToHeightMostDetailed} functions are supported.
   *
   * On WebGPU the synchronous {@link Scene#clampToHeight} reuses the main
   * scene depth (NEW-PICK-RAY-ASYNC, Batch 284): it projects the position
   * into the live view and reconstructs the surface beneath it. It is
   * one-frame-stale (the first query at a new location returns
   * <code>undefined</code> and converges in 1-2 frames) and only resolves for
   * positions currently visible in the view. The asynchronous
   * {@link Scene#clampToHeightMostDetailed} variant is always supported.
   *
   * @type {boolean}
   * @readonly
   *
   * @see Scene#clampToHeight
   * @see Scene#clampToHeightMostDetailed
   */
  get clampToHeightSupported() {
    return this._context.depthTexture;
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
    // Backend-neutral probe. WebGL returns false (no utils module);
    // WebGPU reports true once both its device and primitive-index-utils
    // cache are ready. Scene.js no longer peeks at `_primitiveIndexUtilsCache`.
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
    // No-op when the new globe IS the current globe. `Viewer.createAsync`
    // re-runs `CesiumWidget`'s constructor on the pre-initialized scene
    // (passing the same `options.globe` instance), which used to land here
    // and run `this._globe.destroy()` on the live globe before re-binding
    // it — wiping `_surface` and crashing `updateGlobeListeners`'s call to
    // `globe.imageryLayersUpdatedEvent` (`_surface.tileProvider`). Guarding
    // here keeps WebGL parity intact (the WebGL path never re-assigned the
    // same globe, so this branch was unreachable on it).
    if (this._globe === globe) {
      return;
    }
    this._globe = this._globe && this._globe.destroy();
    this._globe = globe;

    // Phase 0.3: re-wire canonical facades on the new Globe. See
    // `Scene/AtmosphericConditions.js` and `Scene/GlobeWater.js`.
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
   * Snapshot / locked-orbit mode coordinator. When enabled and entered,
   * tells registered freezable subsystems (e.g. the WebGPU render
   * bundle manager) to treat their current cache state as frozen for
   * the duration of the snapshot, yielding a Babylon-style FAST mode
   * speedup for static scenes (presentation mode, slow guided tours,
   * inspection cameras). Auto-thaws when `scene._snapshotVersion`
   * advances past the captured baseline. Disabled by default.
   *
   * @type {object}
   * @readonly
   */
  get snapshotMode() {
    return this._snapshotMode;
  }

  /**
   * Phase 6C — Notify the active snapshot that scene state has
   * changed in a way that the version-counter / camera-delta paths
   * can't catch on their own. Forces an auto-thaw of any active
   * snapshot so cached bundles get rebuilt against the new state.
   *
   * Typical callers:
   *   - User `postUpdate` listeners that mutate entity properties
   *     (the snapshot service has no way to detect mutations
   *     performed by JS handlers, so the contract is that the
   *     handler calls `scene.markSnapshotDirty(reason)` when it
   *     changes anything visible)
   *   - Animation systems on first tick of a new clip
   *   - The HDR / log-depth toggle (already wired internally —
   *     listed here for completeness)
   *   - Volumetric fog quality dial changes mid-snapshot (the
   *     froxel grid resolution can't change inside a frozen frame)
   *
   * Idempotent and safe to call when no snapshot is active. The
   * `reason` is captured in `scene.snapshotMode.getStatistics()`
   * for diagnostics.
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
   * Phase 6 debug surface — returns a structured diagnostic snapshot
   * of the entire scene. Aggregates state from every subsystem with a
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
      moon: null,
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
    // Batch 217 — high-density GPU cull / HiZ / sort-keys diagnostics.
    // Pulls per-frame effectiveness counters from the WebGPU scene
    // renderer when present. WebGL has no equivalent path; the field
    // simply stays absent.
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
    return snap;
  }

  /**
   * Phase 6 debug surface — pretty-print the result of
   * {@link Scene#getDebugSnapshot} to the console using grouped
   * sections and `console.table()` for tabular sub-objects. Designed
   * for ad-hoc developer use from DevTools or postUpdate callbacks.
   *
   * Quiet by default — calling this is the only way to see the dump.
   * Production code should never call this on every frame.
   */
  /**
   * Phase 2 perf benchmarking — start a trace. Records one sample per
   * rendered frame between this call and {@link Scene#endPerformanceTrace}.
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
   * Phase 2 perf benchmarking — end the active trace and return the
   * structured result. Returns `null` if no trace was started.
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
   * Monotonic counter bumped whenever a subsystem mutates scene-visible
   * state in ways that invalidate cached/frozen render bundles. The future
   * snapshot/locked-orbit mode (Phase 0.7) compares this against its cached
   * value to know when to discard bundles. Currently bumped only by
   * {@link Cesium3DTilesInvalidationFeed#apply}.
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
   * Returns true if this scene is using the WebGPU renderer.
   * Now uses the computed `isWebGPU` getter from the GraphicsContext base class.
   * The Scene should not need know the specific renderer - if you are using this consider why and if there are alternatives.
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
    // AUDIT_2026_05_02 C.11 — WebGPU scene renderer hard-codes its viewport
    // to the full canvas (`setViewport(0, 0, _width, _height)`) and ignores
    // `passState.viewport`, so the per-eye viewport split that
    // `executeWebVRCommands` performs has no effect. Until the per-eye
    // viewport plumb lands, fail loudly rather than silently producing
    // single-eye full-canvas output that masquerades as stereo.
    // Follow-up 2026-05-02: switched the gate from `isWebGPU` to the
    // capability getter `supportsStereoViewport` (true on WebGL, false on
    // WebGPU) per CLAUDE.md §2 backend-agnosticism rule.
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
   * @type {boolean}
   * @default false
   */
  get highDynamicRange() {
    return this._hdr;
  }

  set highDynamicRange(value) {
    const context = this._context;
    const hdr =
      value &&
      context.depthTexture &&
      (context.colorBufferFloat || context.colorBufferHalfFloat);
    this._hdrDirty = hdr !== this._hdr;
    this._hdr = hdr;
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
   * HDR-DISPLAY (Batch 200, canvas auto-configure Batch 206) — whether
   * the post-process pipeline should skip the SDR tonemap stage and
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
   * **Batch 206:** the WebGPU canvas is now auto-configured to match.
   * Setting this flag to `true` reconfigures the underlying
   * `GPUCanvasContext` with `format: 'rgba16float' + colorSpace:
   * 'display-p3' + toneMapping: { mode: 'extended' }` so the browser
   * forwards extended-range values to HDR-capable displays.
   * ColorGrading and FXAA keep running under HDR with HDR-aware math
   * (PARITY-HDR-PP-MATH): both stages switch to a Reinhard-compressed
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
    const next = value === true;
    if (this._useHDRCanvasOutput === next) {
      return;
    }
    this._useHDRCanvasOutput = next;
    // HDR-DISPLAY (Batch 206) — push the change to the WebGPU context so
    // the canvas configuration matches the producer-side flag. WebGL
    // backend has no equivalent (`GPUCanvasContext.configure` is WebGPU-
    // only); on WebGL the flag still controls the producer-side skip
    // pattern but cannot widen the canvas color space.
    const ctx = this._context;
    if (ctx && typeof ctx.setHDRCanvasOutput === "function") {
      ctx.setHDRCanvasOutput(next);
    }
  }

  /**
   * Batch 215 — opt-in hint that this scene will reach the
   * high-density command count where the WebGPU GPU-side culling /
   * occlusion / sort-key dispatchers (Batches 209-211) activate.
   *
   * `'always'` triggers eager warm-up of the three compute pipelines
   * + buffer pre-allocation at the next frame, amortizing the
   * 5-50 ms pipeline-compile cost into a load frame instead of the
   * first frame where the activation threshold crosses (which would
   * otherwise produce a visible hitch).
   *
   * `'auto'` (default) keeps the lazy-init path — first activation
   * crossing pays the compile cost, subsequent crossings are warm.
   *
   * `'never'` (Batch 225 wire-in) — fully disables the GPU
   * dispatchers. The opaque + translucent gates short-circuit
   * to false (`WebGPUSceneRenderer` already reads the scene
   * hint), AND the context's lazy-getter chain refuses to
   * allocate new auxiliary culler instances. Existing
   * instances are left in place to avoid an abrupt mid-render
   * deallocation; idle-decay (Batch 229) reaps them naturally.
   *
   * No-op on WebGL.
   *
   * @type {'auto' | 'always' | 'never'}
   * @default 'auto'
   * @experimental This feature is experimental and may change or be removed without Cesium's standard deprecation policy.
   */
  get gpuCullingHint() {
    return this._gpuCullingHint ?? "auto";
  }

  set gpuCullingHint(value) {
    const allowed = value === "always" || value === "never" ? value : "auto";
    if (this._gpuCullingHint === allowed) {
      return;
    }
    this._gpuCullingHint = allowed;
    const ctx = this._context;
    // Batch 225 (B219-N3 audit fix) — push the hint to the context
    // so its lazy aux-culler getters honor 'never' too. Previously
    // the hint was read only at the renderer's gate-update site;
    // any code path that touched a getter directly would still
    // burn VRAM even with 'never'.
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
    value = Math.min(value, ContextLimits.maximumSamples);
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
   * Slice 5d Batch 150 — Forward+ clustered lighting (WebGPU only).
   *
   * When true and the scene's `scene.lights` collection (or a glTF
   * model's `lightsFromGltf`) contains punctual lights, the renderer
   * dispatches per-frame cluster-bounds + cluster-assign compute
   * passes and binds the resulting storage buffers to Model PBR's
   * fragment shader. Per-pixel additive diffuse + specular from up
   * to 1024 scene-wide lights, with at most 256 lights overlapping
   * any one cluster.
   *
   * Default false. Has no effect on the WebGL renderer.
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

  // ═══════════════════════════════════════════════════════════
  // METHODS
  // ═══════════════════════════════════════════════════════════

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
  updateDerivedCommands(command) {
    const { derivedCommands } = command;
    if (!defined(derivedCommands)) {
      // Is not a DrawCommand
      return;
    }

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
    const needsHdrCommands = useHdr && !hasHdrCommands;
    const needsDerivedCommands =
      (!useLogDepth || !useHdr) && !hasDerivedCommands;
    const needsUpdateForMetadataPicking =
      frameState.pickingMetadata &&
      pickedMetadataInfoChanged(command, frameState);
    command.dirty =
      command.dirty ||
      needsLogDepthDerivedCommands ||
      needsHdrCommands ||
      needsDerivedCommands ||
      needsUpdateForMetadataPicking;

    if (!command.dirty) {
      return;
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
      // Sibling guard to the depth-only check below: WebGPU draw
      // commands lack the WebGL-style `shaderProgram.id`, and
      // `DerivedCommand.createLogDepthCommand` shallow-clones the
      // command into a raw WebGL `DrawCommand` whose `execute(context,
      // passState)` recurses through `WebGPUContext.draw` and ends up
      // calling `passEncoder.draw(WebGLDrawCommand, PassState)` —
      // surfaced as "Value is not of type 'unsigned long'". WebGPU
      // commands handle log-depth via their pipeline's WGSL fragment
      // entrypoint instead, so the WebGL helper has nothing to do
      // here. Migration Session 4b found this when the polyline
      // renderer started attaching a pickCommand (which sets
      // `derivedCommands` and made the log-depth derivation start
      // running on the colorCommand).
      derivedCommands.logDepth = DerivedCommand.createLogDepthCommand(
        command,
        context,
        derivedCommands.logDepth,
      );
      updateDerivedCommands(
        this,
        derivedCommands.logDepth.command,
        shadowsDirty,
      );
    }
    if (hasDerivedCommands || needsDerivedCommands) {
      updateDerivedCommands(this, command, shadowsDirty);
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
    // Phase 8a (Batch 86) — forward `scene.deferredLighting` to the
    // frame-state flag the WebGPU backend reads to gate the G-buffer
    // producer compute pass. WebGL backend ignores this; see Scene
    // constructor docstring for the full lifecycle.
    frameState.useDeferredLighting = this.deferredLighting === true;
    // Phase 8a Slice 2c (Batch 89) — forward debug-overlay toggle. The
    // overlay requires the G-buffer to be populated, which means
    // `deferredLighting` must also be true; CesiumDebug.showGBufferNormals()
    // sets both. If a user sets `debugShowGBufferNormals = true`
    // directly without enabling `deferredLighting`, the overlay's
    // fallback path clears the canvas magenta with a console hint.
    frameState.debugShowGBufferNormals = this.debugShowGBufferNormals === true;
    frameState.useLogDepth =
      this._logDepthBuffer &&
      !(
        this.camera.frustum instanceof OrthographicFrustum ||
        this.camera.frustum instanceof OrthographicOffCenterFrustum
      );
    frameState.light = this.light;
    // Track V-A3 (NEW-ATMO-DERIVED-LIGHTING) — when the unified aerial-
    // perspective atmosphere is active (WebGPU), derive the directional SUN
    // light (colour + intensity) and a SKY-IRRADIANCE ambient from the
    // atmosphere so discrete MODELS are lit by the SAME sun/sky that produces
    // the post-process haze (the Takram talk's "light-source lighting for the
    // ISS"). Terrain keeps the post-process Lambertian aerial-perspective
    // (V-A2); models use light-source PBR via `frameState.light` — the mixed-
    // lighting mask, both halves driven by one coherent atmosphere. Only the
    // SunLight case is derived (the sun-direction model); a user-supplied
    // DirectionalLight is left as-is. We never mutate `scene.light` — the
    // derived values live on a private SunLight, swapped into `frameState`
    // only while aerial perspective is on. The sun direction is the previous
    // frame's `uniformState.sunDirectionWC` (one frame stale — visually
    // indistinguishable at any sane sim rate, same trick as `computeSkyBrightness`).
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
        // Local up = camera position direction (ECEF position normalized) —
        // the surface normal under the camera. The sun zenith that drives the
        // derived sun colour/intensity is measured against THIS, so it tracks
        // the viewed site's time-of-day (not the pole axis).
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
    frameState.globeTranslucencyState = this._globeTranslucencyState;
    // WGF-6: Per-frame debug flag for triangulation visualization. Feature
    // renderers that opt in (Globe surface today, future BufferPrimitive +
    // Model variants) read this and swap to a face-color fragment variant.
    // Capability gating happens in the renderer — Scene only forwards intent.
    // HDR enable (Session 65, 2026-05-11) — mirrors `Scene._hdr` onto
    // frameState so downstream WebGPU packers (globe tile UB, etc.) can
    // gate shader behavior on `scene.highDynamicRange` without reaching
    // back through the scene reference. The WebGPU globe terrain drape
    // branch needs this to skip the inline exp tonemap under HDR
    // (matches WebGL's `#ifdef HDR` path in GlobeFS.glsl, where the
    // tonemap is replaced with a saturation boost and final compression
    // is deferred to the post-process chain).
    frameState.useHDR = this._hdr === true;
    // Batch 234 (NEW-COLLECTIONS-TAA-GATE-DORMANT) — canonical per-frame
    // TAA flag. The Batch-143/144 velocity-emission gates in the
    // billboard/label/point/cloud/polyline renderers read
    // `frameState.scene?.taaEnabled`, but `frameState.scene` is never
    // populated, so velocity commands silently never emitted; the
    // model/ground/vector-tile renderers read `frameState.taaEnabled`,
    // which was equally unset. This single publication activates ALL of
    // those gates from one backend-agnostic source of truth.
    frameState.taaEnabled = this.taaEnabled === true;
    // Track V-A2 (NEW-ATMO-AERIAL-PERSPECTIVE-POSTPROCESS) — canonical
    // per-frame aerial-perspective flag. When on, the WebGPU globe surface UB
    // packers gate the in-globe ground-atmosphere/fog drape OFF (same
    // dormant-gate publication pattern as `taaEnabled`) so the unified
    // aerial-perspective post-process is the SINGLE owner of distance haze and
    // the two don't double-apply. Backend-agnostic source of truth — WebGL
    // ignores it (no aerial-perspective post-process on that backend).
    frameState.aerialPerspective = this.aerialPerspective === true;
    // Batch 244 (NEW-TAA-EFFECT-NEVER-ADDED follow-on) — canonical
    // per-frame snapshot-mode service reference, same dormant-gate
    // family as `taaEnabled` above: WebGPUEnvironmentRenderer's moon
    // freezable registration read `frameState.scene` (never populated)
    // and silently never registered. Renderers read THIS field instead.
    frameState.snapshotMode = this._snapshotMode;
    frameState.debugShowTriangulation = this.debugShowTriangulation === true;
    // Globe wireframe overlay (Tier 1 debug). Forwarded to the WebGPU globe
    // surface renderer's wireframe pipeline path. WebGL renderers ignore.
    frameState.debugShowGlobeWireframe = this.debugShowGlobeWireframe === true;
    // Atmosphere scattering bypass (Tier 1 debug). Forwarded to the WebGPU
    // sky atmosphere renderer; emits flat magenta over the shell when on.
    frameState.debugDisableAtmosphereScattering =
      this.debugDisableAtmosphereScattering === true;
    // Cubemap face isolation (Tier 1 debug). Integer 0..6 forwarded to the
    // WebGPU cubemap panorama renderer's params.z. 0 = production all-faces.
    frameState.debugShowCubeMapFace = this.debugShowCubeMapFace | 0;
    // Tier 2 debug — terrain LOD color overlay (mutually exclusive with
    // triangulation/normal modes; renderer picks one fragment variant).
    frameState.debugShowTerrainLOD = this.debugShowTerrainLOD === true;
    // Tier 2 debug — eye-space normal as RGB.
    frameState.debugShowTerrainNormals = this.debugShowTerrainNormals === true;
    // Tier 2 debug — imagery layer isolation. -1 = production (all layers).
    // The terrain fragment shader applies this as a per-layer alpha mask.
    frameState.debugShowImageryLayer =
      typeof this.debugShowImageryLayer === "number"
        ? this.debugShowImageryLayer
        : -1;
    // BUG-11 imagery probe — when true, the WebGPU globe surface
    // renderer logs the next 4 tile updates with the full encoding +
    // imagery state payload. Used for ad-hoc imagery debugging; off
    // by default and self-quieting after the 4-tile latch.
    frameState.debugShowImageryProbe = this.debugShowImageryProbe === true;
    // Tier 2 debug — depth-as-color overlay (replaces post-process chain).
    // Mode integer selects linearized vs raw vs combined visualization.
    frameState.debugShowDepthAsColor = this.debugShowDepthAsColor === true;
    frameState.debugDepthAsColorMode = this.debugDepthAsColorMode | 0;
    // Windowed depth-overlay band (meters of eye-space distance) + colormap.
    frameState.debugDepthWindowMin = this.debugDepthWindowMin || 0.0;
    frameState.debugDepthWindowMax = this.debugDepthWindowMax || 0.0;
    frameState.debugDepthWindowTurbo = this.debugDepthWindowTurbo !== false;
    // Tier 2 debug — frustum / command visualization. WebGL's SceneRenderer
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

    // Update celestial and terrestrial environment effects.
    const environmentState = this._environmentState;
    const renderPass = frameState.passes.render;
    const offscreenPass = frameState.passes.offscreen;
    const atmosphere = this.atmosphere;
    const skyAtmosphere = this.skyAtmosphere;
    const globe = this.globe;
    const globeTranslucencyState = this._globeTranslucencyState;

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
    } else {
      // Batch 438 (4.4 SKY-MOON) — publish the moon ephemeris BEFORE the sky
      // atmosphere update. `Moon.update` is what writes `frameState.moonDirectionWC`
      // + `frameState.moonPhaseFraction`; previously it ran AFTER
      // `skyAtmosphere.update` (further below), so the sky's inline dual-light
      // moon march read a one-frame-stale (and, before ICRF settled, plain wrong)
      // moon direction — the moon glow never matched the actual moon position.
      // The moon DRAW command is still stored in environmentState and executed
      // later in the render pipeline; only the ephemeris publish is hoisted, which
      // is strictly better for every consumer (sky, fog, night lighting). The sun
      // direction is unaffected (the sky reads it from uniformState, updated even
      // earlier).
      environmentState.moonCommand = defined(this.moon)
        ? this.moon.update(frameState)
        : undefined;

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

        environmentState.skyAtmosphereCommand = skyAtmosphere.update(
          frameState,
          globe,
        );
        if (defined(environmentState.skyAtmosphereCommand)) {
          this.updateDerivedCommands(environmentState.skyAtmosphereCommand);
        }
      } else {
        environmentState.skyAtmosphereCommand = undefined;
      }

      environmentState.skyBoxCommand = defined(this.skyBox)
        ? this.skyBox.update(frameState, this._hdr)
        : undefined;
      // Track V-C — bright-star catalog starfield (augments the cubemap).
      // Driven here (not inside SkyBox.update) so its command can be
      // injected AFTER skyBoxCommand by the SceneRenderer — the additive
      // HDR stars then land on top of the (often opaque) cubemap rather
      // than being overwritten by its alpha-over pass. A no-op on backends
      // without a STAR_FIELD feature renderer (WebGL keeps the cubemap
      // stars only).
      //
      // The renderer ALSO pushes a binned copy onto frameState.commandList
      // (frustum guarantee on sky-only views). To avoid drawing the
      // additive stars twice, only route the returned inject command to
      // the post-skyBox injection slot when a cubemap command actually
      // exists (which would otherwise wipe the binned copy). With no
      // cubemap, the binned copy alone is correct and we drop the inject.
      const starField =
        defined(this.skyBox) && defined(this.skyBox.starField)
          ? this.skyBox.starField
          : undefined;
      const starCommand = defined(starField)
        ? starField.update(frameState)
        : undefined;
      // Drop the returned command ONLY when the renderer ALSO binned a copy
      // (WebGPU) AND there's no cubemap: in that case the binned copy alone
      // draws the stars and routing the inject too would double-draw. When
      // the renderer didn't bin a copy (WebGL), the returned command is the
      // only one and must always run — even with the cubemap off. This keeps
      // the gate backend-agnostic (reads `wasBinned`, not `isWebGPU`).
      const dropForBinnedNoCubemap =
        defined(starField) &&
        starField.wasBinned &&
        !defined(environmentState.skyBoxCommand);
      environmentState.starFieldCommand = dropForBinnedNoCubemap
        ? undefined
        : starCommand;
      const sunCommands = defined(this.sun)
        ? this.sun.update(frameState, view.passState, this._hdr)
        : undefined;
      environmentState.sunDrawCommand = defined(sunCommands)
        ? sunCommands.drawCommand
        : undefined;
      environmentState.sunComputeCommand = defined(sunCommands)
        ? sunCommands.computeCommand
        : undefined;
      // Batch 438 — `environmentState.moonCommand` is now assigned ABOVE (the
      // Moon.update call was hoisted before skyAtmosphere.update so the sky reads
      // a current-frame moon direction). Not re-run here.
    }

    const clearGlobeDepth = (environmentState.clearGlobeDepth =
      defined(globe) &&
      globe.show &&
      (!globe.depthTestAgainstTerrain || this.mode === SceneMode.SCENE2D));
    const useDepthPlane = (environmentState.useDepthPlane =
      clearGlobeDepth &&
      this.mode === SceneMode.SCENE3D &&
      globeTranslucencyState.useDepthPlane &&
      // Debug bisect (C-R9): skip the ellipsoid depth plane to test whether it
      // occludes terrain-flush 3D-Tiles / b3dm. No-op in production (default
      // false). Backend-agnostic — applies to WebGL + WebGPU identically.
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
    let specularEnvironmentCubeMap = this._specularEnvironmentCubeMap;
    if (defined(envMaps) && specularEnvironmentCubeMap?.url !== envMaps) {
      specularEnvironmentCubeMap =
        specularEnvironmentCubeMap && specularEnvironmentCubeMap.destroy();
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
    /**
     *
     * Pre passes update. Execute any pass invariant code that should run before the passes here.
     *
     */
    this._preUpdate.raiseEvent(this, time);

    const frameState = this._frameState;
    frameState.newFrame = false;

    // SORT-2: Reset per-frame sorting state (render layers, material batching, stats)
    this._renderScheduler.beginFrame();

    if (!defined(time)) {
      time = JulianDate.now();
    }

    const cameraChanged = this._view.checkForCameraUpdates(this);
    if (cameraChanged) {
      this._globeHeightDirty = true;
    }

    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 1+4) — defense-in-depth
    // poll. The subscriber path (above, in the constructor) calls
    // `requestRender()` directly when a pipeline resolves; this read
    // keeps frames rendering while FOREGROUND async GPU work is inflight,
    // in case a subscriber dispatch is missed. Background-priority
    // tokens (Phase 4 warm-on-suspicion) are excluded so speculative
    // pre-cooking doesn't burn user-visible frames — they still wake
    // the scene on resolution via the subscriber path. Optional chain
    // → `0` on WebGL contexts so non-WebGPU scenes pay nothing.
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
      // Phase 6C — HDR / log-depth dirty flags invalidate cached
      // bundles because the swap chain attachments those bundles were
      // encoded against are about to be rebuilt with different
      // formats. Mark the snapshot dirty BEFORE we clear the flags
      // so the snapshot service has a chance to thaw on this frame.
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

      // Phase 6 audit fix — service tick ordering. Snapshot mode runs
      // FIRST so it can settle this frame's frozen state, THEN we
      // forward the flag to VPT, THEN VPT ticks against the
      // current-frame value. The previous order had VPT seeing last
      // frame's stale flag, which meant one wasted measurement on the
      // entry frame and one missed measurement on the thaw frame.
      this._snapshotMode.tick(this);
      this._snapshotMode.tickCamera(this);

      // Phase 6A — register the WebGPU render bundle manager as a
      // freezable on first sight. The manager lives on the
      // WebGPUContext, is lazy-allocated on first access, and may not
      // exist on a WebGL-only scene (no-op in that case). Idempotent —
      // re-registering with the same name overwrites the entry on the
      // service's Map but the freezable contract is identical so the
      // visible behavior doesn't change.
      // `renderBundleManager` is a virtual getter on GraphicsContext —
      // WebGL returns null, WebGPU returns its manager. No backend
      // branch needed: if the manager is null the inner guard short-
      // circuits, and registration is idempotent thanks to the flag.
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

      // Forward snapshot state to VPT BEFORE its tick so the auto-tuner
      // pauses on the same frame the snapshot enters/thaws (instead of
      // one frame late). The flag write is the cheapest possible
      // coordination point — VPT just reads it and short-circuits.
      this._visualPerformanceTarget.snapshotMode = this._snapshotMode.isFrozen;

      // VisualPerformanceTargetService tick — Phase 0 no-op past the
      // contract guards. Now sees the CURRENT frame's snapshot flag
      // (post-fix) instead of last frame's stale value.
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
    }

    /**
     * Post passes update. Execute any pass invariant code that should run after the passes here.
     */
    updateDebugShowFramesPerSecond(this, shouldRender);
    tryAndCatchError(this, postPassesUpdate);

    // Phase 2 perf benchmarking — record one trace sample per rendered
    // frame. Inactive by default; the `sample()` call is a one-comparison
    // no-op when no trace is open. We sample after `postPassesUpdate`
    // so the bundle stats reflect the frame we just rendered.
    if (shouldRender && this._performanceTracker.active) {
      _samplePerformanceTrace(this);
    }

    // Always-on live FPS recording. The recordFrame() call is a couple
    // of typed-array writes per frame regardless of whether anyone is
    // reading the live stats. The HUD overlay polls getLiveStats()
    // 4-10 times per second to render the rolling FPS graph.
    if (shouldRender && defined(this._performanceTracker)) {
      this._performanceTracker.recordFrame();
    }

    // Often used to trigger events (so don't want in trycatch) that the user
    // might be subscribed to. Things like the tile load events, promises, etc.
    // We don't want those events to resolve during the render loop because the events might add new primitives
    callAfterRenderFunctions(this);

    if (shouldRender) {
      this._postRender.raiseEvent(this, time);
      frameState.creditDisplay.endFrame();
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
      ContextLimits.minimumAliasedLineWidth,
      Math.min(width, ContextLimits.maximumAliasedLineWidth),
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
   * synchronous <code>pick</code> reads back the pick buffer ASYNCHRONOUSLY and
   * returns the PREVIOUS pick's result (one frame stale). This is transparent
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
    const voxelCoordinate = this._picking.pickVoxelCoordinate(
      this,
      windowPosition,
      width,
      height,
    );
    const tileIndex = 255 * voxelCoordinate[0] + voxelCoordinate[1];
    const keyframeNode = voxelPrimitive._traversal.findKeyframeNode(tileIndex);
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
   *
   * @param {Cartesian2} windowPosition Window coordinates to perform picking on.
   * @param {Cartesian3} [result] The object on which to restore the result.
   * @returns {Cartesian3} The cartesian position.
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
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — stutter-free hover-pick.
   *
   * Async pick variant designed for continuous hover-pick at 60fps.
   * Translucent (BLEND alphaMode) primitives use stochastic dither
   * (Interleaved Gradient Noise) to discard fragments based on their
   * effective alpha — a fragment with alpha=0.3 has a 30% chance of
   * surviving the dither test. Result is approximate per-frame but
   * converges to the correct alpha-weighted appearance over multi-
   * frame hover motion.
   *
   * Cost: ~same as default `pickAsync` — single render pass, no extra
   * MRT, no extra render-pass setup. Safe to fire every frame at 60fps.
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
   * @returns {Promise<object>} The picked object, or `undefined` if
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
   * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — deterministic precise pick.
   *
   * Async pick variant designed for click-pick scenarios where the
   * user expects deterministic "geometrically-closest translucent
   * fragment wins" semantics. Translucent (BLEND alphaMode) primitives
   * route through a 2-pass pipeline pair (depth pre-pass + depth-EQUAL
   * color pass) sharing one render-pass setup so depth + stencil
   * persist between passes.
   *
   * Cost: ~2× translucent rasterization on BLEND primitives that
   * intersect the pick rect. Click-pick frequency makes this cost
   * invisible to UX. Calling this on every hover frame is NOT
   * supported and may stutter at 60fps on heavy scenes — use
   * `pickHoverAsync` for continuous hover-pick.
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
    // Batch 197 (B192-N2 fix) — first pickPreciseAsync call on this
    // scene auto-enables WebGPU timestamp profiling. The defer
    // mitigation (Batch 192 mitigation B) reads
    // `performanceManager.frameTimings.totalGpuMs` to decide whether
    // to push a precise pick to the next frame. Without timestamp
    // profiling enabled, totalGpuMs stays at 0 and defer never fires
    // — apps that exercise precise pick on heavy scenes would still
    // stutter. Auto-enabling on first use opts the user in to the
    // tiny per-frame profiler cost only when they're actually using
    // precise pick (~negligible at the cost of a few timestamp-query
    // operations per frame on supported devices).
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

  // ═══════════════════════════════════════════════════════════
  // PICK CONVENIENCE APIS (FORK-36)
  // ═══════════════════════════════════════════════════════════

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
   *
   * @param {Cartographic} position The cartographic position to sample height from.
   * @param {object[]} [objectsToExclude] A list of primitives, entities, or 3D Tiles features to not sample height from.
   * @param {number} [width=0.1] Width of the intersection volume in meters.
   * @returns {number | undefined} The height. This may be <code>undefined</code> if there was no scene geometry to sample height from.
   *
   * @example
   * const position = new Cesium.Cartographic(-1.31968, 0.698874);
   * const height = viewer.scene.sampleHeight(position);
   * console.log(height);
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
   * entity.position = viewer.scene.clampToHeight(position);
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
    // Batch 225 (B219-N4 audit fix) — unsubscribe HDR fallback
    // listener so a destroyed Scene doesn't keep a callback alive
    // on the (potentially long-lived) shared context.
    if (typeof this._hdrFallbackUnsub === "function") {
      this._hdrFallbackUnsub();
      this._hdrFallbackUnsub = null;
    }
    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 1) — same teardown
    // discipline for the async resource monitor subscriber. The
    // monitor lives on the (potentially shared) context, so leaving
    // a destroyed scene's subscriber attached would resurrect it on
    // every pipeline resolution.
    if (typeof this._asyncResourceUnsub === "function") {
      this._asyncResourceUnsub();
      this._asyncResourceUnsub = null;
    }
    this._tweens.removeAll();
    this._computeEngine = this._computeEngine && this._computeEngine.destroy();
    this._screenSpaceCameraController =
      this._screenSpaceCameraController &&
      this._screenSpaceCameraController.destroy();
    this._deviceOrientationCameraController =
      this._deviceOrientationCameraController &&
      !this._deviceOrientationCameraController.isDestroyed() &&
      this._deviceOrientationCameraController.destroy();
    this._primitives = this._primitives && this._primitives.destroy();
    this._groundPrimitives =
      this._groundPrimitives && this._groundPrimitives.destroy();
    this._globe = this._globe && this._globe.destroy();
    this._removeTerrainProviderReadyListener =
      this._removeTerrainProviderReadyListener &&
      this._removeTerrainProviderReadyListener();
    this.skyBox = this.skyBox && this.skyBox.destroy();
    this.skyAtmosphere = this.skyAtmosphere && this.skyAtmosphere.destroy();
    this._debugSphere = this._debugSphere && this._debugSphere.destroy();
    this.sun = this.sun && this.sun.destroy();
    this._sunPostProcess =
      this._sunPostProcess && this._sunPostProcess.destroy();
    this._depthPlane = this._depthPlane && this._depthPlane.destroy();
    this._transitioner = this._transitioner && this._transitioner.destroy();
    this._debugFrustumPlanes =
      this._debugFrustumPlanes && this._debugFrustumPlanes.destroy();
    this._brdfLutGenerator =
      this._brdfLutGenerator && this._brdfLutGenerator.destroy();
    this._picking = this._picking && this._picking.destroy();

    // Destroy alternate scene renderer if it was created (e.g., WebGPU)
    if (this._alternateSceneRenderer) {
      this._alternateSceneRenderer.destroy();
      this._alternateSceneRenderer = null;
    }

    this._defaultView = this._defaultView && this._defaultView.destroy();
    this._view = undefined;

    // Phase 6 audit fix — orchestration services were never cleaned up.
    // Each service holds references to registered freezables / probes /
    // sinks, which in turn close over scene-owned resources. Failing to
    // destroy them on Scene teardown leaks the entire registration map
    // and (for active snapshots) prevents the freezables from receiving
    // their final thaw. Both destroys are idempotent + safe to call
    // even if the service was never used.
    if (defined(this._snapshotMode)) {
      this._snapshotMode.destroy();
      this._snapshotMode = undefined;
    }
    if (defined(this._visualPerformanceTarget)) {
      this._visualPerformanceTarget.destroy();
      this._visualPerformanceTarget = undefined;
    }
    // Phase 2 perf benchmarking — end any active trace cleanly so the
    // operator's hold on a reference to the result object doesn't
    // also pin a destroyed scene.
    if (defined(this._performanceTracker)) {
      if (this._performanceTracker.active) {
        this._performanceTracker.endTrace();
      }
      this._performanceTracker = undefined;
    }

    // Skip the DOM removal in headless mode — `_canvas` is an
    // `OffscreenCanvas` (no `parentNode`) and `_creditContainer` is the
    // sentinel `{}` from the worker init path. Both are GC'd along
    // with the Scene instance.
    if (
      this._removeCreditContainer &&
      this._canvas &&
      this._canvas.parentNode &&
      this._creditContainer
    ) {
      this._canvas.parentNode.removeChild(this._creditContainer);
    }

    this.postProcessStages =
      this.postProcessStages && this.postProcessStages.destroy();

    this._context = this._context && this._context.destroy();
    this._frameState.creditDisplay =
      this._frameState.creditDisplay &&
      this._frameState.creditDisplay.destroy();

    if (defined(this._performanceDisplay)) {
      // FpsOverlay (and the legacy PerformanceDisplay) both manage
      // their own DOM lifecycle inside `destroy()`, so we no longer
      // need a separate `_performanceContainer` removeChild call —
      // the overlay's destroy() removes its own container from the
      // parent. The historical `_performanceContainer` field is no
      // longer set; the cleanup below is preserved as a guard for
      // any subclass that might still be wiring it.
      this._performanceDisplay.destroy();
      this._performanceDisplay = undefined;
      if (this._performanceContainer && this._performanceContainer.parentNode) {
        this._performanceContainer.parentNode.removeChild(
          this._performanceContainer,
        );
      }
    }

    this._removeRequestListenerCallback();
    this._removeTaskProcessorListenerCallback();
    for (let i = 0; i < this._removeGlobeCallbacks.length; ++i) {
      this._removeGlobeCallbacks[i]();
    }
    this._removeGlobeCallbacks.length = 0;

    if (defined(this._removeUpdateHeightCallback)) {
      this._removeUpdateHeightCallback();
      this._removeUpdateHeightCallback = undefined;
    }

    return destroyObject(this);
  }
}

// ═══════════════════════════════════════════════════════════════════
// FILE-SCOPED HELPER FUNCTIONS AND CONSTANTS
// (These rely on function hoisting or are declared before first use)
// ═══════════════════════════════════════════════════════════════════

/**
 * Phase 2 perf benchmarking — record one trace sample for the frame
 * that just rendered. Pulls bundle stats and snapshot state from the
 * central debug surface so all the per-subsystem getStatistics()
 * methods are exercised through one path.
 *
 * Called from `Scene.render()` only when a trace is active. The
 * `_performanceTracker.sample()` call itself is no-op-when-inactive,
 * so this function is a pure cost only when a trace is open.
 *
 * @private
 * @param {Scene} scene
 */
function _samplePerformanceTrace(scene) {
  const tracker = scene._performanceTracker;
  if (!defined(tracker) || !tracker.active) {
    return;
  }
  const fs = scene._frameState;
  let bundleStats;
  let gpuMs;
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
    } catch (e) {
      // Diagnostic getters must never break the trace path.
    }
  }
  const snapshotFrozen =
    defined(scene._snapshotMode) && scene._snapshotMode.isFrozen === true;
  tracker.sample({
    frameNumber: fs?.frameNumber ?? -1,
    gpuMs,
    drawCount: fs?.commandList ? fs.commandList.length : undefined,
    commandCount: fs?.commandList ? fs.commandList.length : undefined,
    bundleStats,
    snapshotFrozen,
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
    // Phase 6 audit fix — imagery/terrain mutations also bump
    // `_snapshotVersion` so an active snapshot auto-thaws when the
    // base layer changes underneath it.
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
    // WebGPU commands carry pre-built depth-only pipelines via the
    // `WebGPUDerivedCommand` variant factory (dispatched through
    // `selectCommandVariant` in `WebGPUSceneRenderer`). The WebGL helper
    // here would `DrawCommand.shallowClone` the WebGPU command into a
    // raw `DrawCommand`, which lacks `pipeline` / `indexBuffer` and
    // crashes when re-dispatched through `WebGPUContext.draw` (the
    // resulting `passEncoder.draw(DrawCommand, PassState)` call fails
    // with "Value is not of type 'unsigned long'"). The WebGPU
    // dispatcher has its own depth-only path so the guard is a pure
    // skip — no replacement needed here. Migration Session 4b found
    // this when wiring `attachPickToColorCommand` on the polyline
    // renderer (which sets `derivedCommands` and made the depth
    // derivation start running).
    derivedCommands.depth = DerivedCommand.createDepthOnlyDerivedCommand(
      scene,
      command,
      context,
      derivedCommands.depth,
    );
  }

  derivedCommands.originalCommand = command;

  if (scene._hdr) {
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

function render(scene) {
  const frameState = scene._frameState;

  const context = scene.context;
  const { uniformState } = context;

  const view = scene._defaultView;
  scene._view = view;

  scene.updateFrameState();

  // ── Option B: Per-view context updating ──
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
  // Phase 1.1: forward the canonical atmospheric conditions facade so
  // renderers can read B-series toggles (sun/moon lighting, scattering
  // occlusion, star modulation, volumetric fog/clouds, weather, night)
  // through one stable reference. Undefined if no globe attached.
  frameState.atmosphericConditions = defined(scene.globe)
    ? scene.globe.atmosphericConditions
    : undefined;
  scene.fog.update(frameState);

  uniformState.update(frameState);

  // Phase 1.2: forward sun direction (world coords) onto frameState so
  // celestial / atmosphere renderers can read it without reaching into
  // the per-context uniform state. Phase 1.3 atmosphere scattering also
  // relies on this.
  frameState.sunDirectionWC = uniformState.sunDirectionWC;

  // Phase 1.3a: cheap CPU sky brightness estimate consumed by star
  // modulation in the cubemap panorama shader and (later) by night-sky
  // dimming in the sky atmosphere shader. Uses the previous frame's
  // moon direction (still on `frameState.moonDirectionWC` from the
  // prior `Moon.update()` call) — visually indistinguishable from the
  // current value at any reasonable simulation rate, and avoids
  // duplicating the Simon 1994 ephemeris computation here.
  frameState.skyBrightness = computeSkyBrightness(
    uniformState.sunDirectionWC,
    frameState.moonDirectionWC,
    frameState.moonPhaseFraction ?? 1.0,
    frameState.camera?.positionWC,
  );

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

  context.beginFrame();

  if (defined(scene.globe)) {
    scene.globe.beginFrame(frameState);
  }

  // Batch 110 — let the alternate scene renderer (WebGPU) recreate
  // its framebuffer and bump the scene-pipeline-format generation
  // BEFORE primitives' update methods run via `updateEnvironment` /
  // the per-primitive update loop. Without this, a runtime HDR
  // toggle (which flips scene FB between rgba16float and canvas
  // format) wouldn't be visible to renderers like SkyAtmosphere
  // that emit commands during the update phase — they'd cache
  // pipelines targeting the OLD format and produce
  // pipeline-vs-attachment mismatch warnings on the toggle frame.
  // No-op on WebGL.
  if (scene._alternateSceneRenderer?.prepareFrame) {
    scene._alternateSceneRenderer.prepareFrame({
      scene: scene,
      context: context,
      useHDR: scene._hdr,
    });
  }

  scene.updateEnvironment();

  // TAA: apply sub-pixel jitter to the projection matrix before rendering.
  // The jitter is computed from a Halton(2,3) sequence and shifts the
  // projection by ±0.5 pixel in NDC. When snapshot mode is frozen, the
  // jitter is zeroed to prevent dither accumulation.
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
  // Only the WebGPU SCENE_RENDERER FR instantiates an alternate scene
  // renderer with a `_postProcess` pipeline that owns the TAA effect.
  // On WebGL `_alternateSceneRenderer` is null, so the optional chain
  // short-circuits and no TAA state is touched — no `isWebGPU` branch
  // needed. (Prior revision chained through `scene._context?._alternateSceneRenderer`
  // which is undefined because the field lives on the scene, not the
  // context — TAA jitter silently never ran.)
  if (scene.taaEnabled) {
    const pipeline = scene._alternateSceneRenderer?._postProcess;
    const taa = pipeline?.taaEffect;
    if (taa) {
      const frozen = scene._snapshotMode?.isFrozen === true;
      const cam = scene.camera;
      if (frozen) {
        taa.jitterX = 0;
        taa.jitterY = 0;
        // Forget any captured base so re-enabling jitter re-captures from the
        // live (un-jittered) matrix instead of reasoning about a stale base.
        taa.resetProjectionJitter();
      } else {
        const jitter = taa.computeJitter(
          frameState.frameNumber,
          context.drawingBufferWidth,
          context.drawingBufferHeight,
        );
        // Apply jitter to the projection matrix (column 2, row 0 and row 1
        // in column-major layout = indices [8] and [9]).
        //
        // NEW-CAMERA-JITTER-ACCUMULATION — write `base + jitter` ABSOLUTELY via
        // `applyProjectionJitter`, never `proj[8] += jitter.x`.
        // `cam.frustum.projectionMatrix` is a dirty-cached getter: on a settled
        // frustum it returns the SAME array every frame without recomputing, so
        // a `+=` would stack last frame's jitter on top of the new one and
        // proj[8]/proj[9] would drift unboundedly. The effect tracks the
        // un-jittered base and self-heals when the frustum recomputes.
        const proj = cam.frustum.projectionMatrix;
        if (proj) {
          taa.applyProjectionJitter(proj, jitter.x, jitter.y);
        }
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

      // TAA Slice 2 — history invalidation on large camera deltas
      // (teleport / `camera.flyTo` landing / viewer reset). The depth
      // reprojection assumes the NDC-space motion between frames is
      // bounded; when `|cameraDelta|` jumps by 10s of km in a single
      // frame, almost every pixel's history sample is disoccluded and
      // the neighborhood clamp can't recover in time — the user sees
      // a 2–4 frame smear. Cheaper to invalidate history for one
      // frame and let the blend restart clean.
      //
      // Threshold 50 km chosen to cover:
      //   - Typical orbit motion: ≤ 10 m/frame  → never triggers
      //   - Fast mouse-drag pan at 500 km alt: ~200 m/frame → never
      //   - `flyTo` arrival that snaps 1000+ km: ~Infinity on landing
      //     frame → triggers as expected
      // Tunable; if a future animation regularly crosses 50 km/frame
      // legitimately we'd want to scale by altitude.
      const deltaLenSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      const TELEPORT_THRESHOLD = 50000.0; // meters
      const isTeleport = deltaLenSq > TELEPORT_THRESHOLD * TELEPORT_THRESHOLD;

      // MORPH-TAA-PREVVP — invalidate TAA history across the morph and at the
      // perspective↔orthographic projection flip. During a 2D/CV/3D morph the
      // camera frustum type swaps mid-flight (perspective ⇄ orthographic), and
      // `previousViewProjectionRelativeToEye` is the PRIOR frame's matrix —
      // built from the prior projection type. Reprojecting the current depth
      // against a stale/incompatible VP across that flip warps every history
      // sample, so the TAA blend smears/ghosts through the transition. We gate
      // history off whenever the scene is MORPHING or the projection type
      // changed since last frame, and reset the effect's history so the next
      // execute() passes the source through unblended (prev := current for the
      // flip frame) instead of reprojecting against the incompatible matrix.
      const isMorphing = frameState.mode === SceneMode.MORPHING;
      const isOrthographic =
        cam.frustum instanceof OrthographicFrustum ||
        cam.frustum instanceof OrthographicOffCenterFrustum;
      const projectionFlipped =
        defined(scene._taaPrevProjectionOrtho) &&
        scene._taaPrevProjectionOrtho !== isOrthographic;
      scene._taaPrevProjectionOrtho = isOrthographic;

      const historyInvalid = isMorphing || projectionFlipped;
      if (historyInvalid) {
        // Drop the history buffer for this frame so the upcoming execute()
        // returns the un-reprojected source (no blend against the stale,
        // incompatible-projection history). Accumulation restarts clean on
        // the next frame once both projections agree again.
        taa.resetHistory();
      }

      // historyValid is false until we've seen at least one frame; the TAA
      // effect's own frameCounter also gates the blend, but keeping the
      // motion-vector flag independent lets the shader choose whether to
      // reproject or fall back to UV-identity on its own terms.
      taa.updateMotionVectorParams(
        currentVpRte,
        previousVpRte,
        deltaX,
        deltaY,
        deltaZ,
        frameState.frameNumber > 1 && !isTeleport && !historyInvalid,
      );
    }
  }

  scene.updateAndExecuteCommands(passState, backgroundColor);
  scene.resolveFramebuffers(passState);

  passState.framebuffer = undefined;
  executeOverlayCommands(scene, passState);

  if (defined(scene.globe)) {
    scene.globe.endFrame(frameState);

    if (!scene.globe.tilesLoaded) {
      scene._renderRequested = true;
    }
  }

  context.endFrame();
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
