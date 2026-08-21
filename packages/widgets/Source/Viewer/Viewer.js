import {
  BoundingSphere,
  BoundingSphereState,
  Cartesian3,
  CesiumWidget,
  Cesium3DTileFeature,
  Cesium3DTileVectorFeature,
  Cesium3DTileset,
  Clock,
  ConstantPositionProperty,
  Frozen,
  defined,
  destroyObject,
  DeveloperError,
  Entity,
  Event,
  EventHelper,
  getElement,
  JulianDate,
  Math as CesiumMath,
  Property,
  getSynchronousRendererType,
  ScreenSpaceEventType,
  IonGeocoderService,
} from "@cesium/engine";
import Animation from "../Animation/Animation.js";
import AnimationViewModel from "../Animation/AnimationViewModel.js";
import BaseLayerPicker from "../BaseLayerPicker/BaseLayerPicker.js";
import createDefaultImageryProviderViewModels from "../BaseLayerPicker/createDefaultImageryProviderViewModels.js";
import createDefaultTerrainProviderViewModels from "../BaseLayerPicker/createDefaultTerrainProviderViewModels.js";
import ClockViewModel from "../ClockViewModel.js";
import FullscreenButton from "../FullscreenButton/FullscreenButton.js";
import Geocoder from "../Geocoder/Geocoder.js";
import HomeButton from "../HomeButton/HomeButton.js";
import InfoBox from "../InfoBox/InfoBox.js";
import NavigationHelpButton from "../NavigationHelpButton/NavigationHelpButton.js";
import ProjectionPicker from "../ProjectionPicker/ProjectionPicker.js";
import SceneModePicker from "../SceneModePicker/SceneModePicker.js";
import SelectionIndicator from "../SelectionIndicator/SelectionIndicator.js";
import subscribeAndEvaluate from "../subscribeAndEvaluate.js";
import Timeline from "../Timeline/Timeline.js";
import VRButton from "../VRButton/VRButton.js";

const boundingSphereScratch = new BoundingSphere();

function createViewerConstructionTransaction(viewer) {
  return {
    viewer,
    root: undefined,
    eventHelper: undefined,
    resources: [],
    cleanups: [],
  };
}

function ownViewerConstructionResource(transaction, resource) {
  if (defined(resource)) {
    transaction.resources.push(resource);
  }
  return resource;
}

function removeDataSourceCollectionChangedListener(viewer, entityCollection) {
  const removers = viewer._entityCollectionChangedListenerRemovers;
  if (!defined(removers)) {
    return false;
  }

  const entry = removers.get(entityCollection);
  if (!defined(entry)) {
    return false;
  }

  entry.referenceCount--;
  if (entry.referenceCount > 0) {
    return false;
  }

  // Delete before invoking the callback so every remover is attempted at most
  // once, including when a callback throws during teardown.
  removers.delete(entityCollection);
  try {
    entry.removeListener();
  } catch {
    // A third-party Event implementation must not abort data-source removal
    // or prevent the rest of Viewer/context teardown from running.
  }
  return true;
}

function runViewerCleanupStep(callback) {
  try {
    callback();
  } catch {
    // Preserve the original async-construction failure while exact owners are
    // drained independently.
  }
}

function destroyViewerContextIfLive(context) {
  if (!defined(context) || typeof context.destroy !== "function") {
    return;
  }
  let destroyed = false;
  if (typeof context.isDestroyed === "function") {
    try {
      destroyed = context.isDestroyed();
    } catch {
      // Still attempt idempotent destruction if the status probe is faulty.
    }
  }
  if (!destroyed) {
    context.destroy();
  }
}

function removeAllDataSourceCollectionChangedListeners(viewer) {
  const removers = viewer._entityCollectionChangedListenerRemovers;
  if (!defined(removers) || removers.size === 0) {
    return;
  }

  const entries = Array.from(removers.values());
  // Clear first to make rollback and normal destruction idempotent even if a
  // remover raises an unexpected error.
  removers.clear();

  for (const entry of entries) {
    try {
      entry.removeListener();
    } catch {
      // Keep draining. Listener teardown is subordinate to releasing the
      // Viewer-owned Scene, rendering context, widgets, and DOM graph.
    }
  }
}

function rollbackViewerConstruction(transaction) {
  try {
    transaction.eventHelper?.removeAll();
  } catch {
    // Preserve the construction error and continue draining later owners.
  }

  for (let i = transaction.cleanups.length - 1; i >= 0; i--) {
    try {
      transaction.cleanups[i]();
    } catch {
      // Best-effort rollback; the original construction error is authoritative.
    }
  }
  transaction.cleanups.length = 0;

  for (let i = transaction.resources.length - 1; i >= 0; i--) {
    const resource = transaction.resources[i];
    try {
      if (
        typeof resource.destroy === "function" &&
        !(typeof resource.isDestroyed === "function" && resource.isDestroyed())
      ) {
        resource.destroy();
      }
    } catch {
      // One partial widget must not prevent the Scene/context from draining.
    }
  }
  transaction.resources.length = 0;

  const root = transaction.root;
  if (defined(root?.parentNode)) {
    root.parentNode.removeChild(root);
  }
  destroyObject(transaction.viewer);
}

function onTimelineScrubfunction(e) {
  const clock = e.clock;
  clock.currentTime = e.timeJulian;
  clock.shouldAnimate = false;
}

function getCesium3DTileFeatureDescription(feature) {
  const propertyIds = feature.getPropertyIds();

  let html = "";
  propertyIds.forEach(function (propertyId) {
    const value = feature.getProperty(propertyId);
    if (defined(value)) {
      html += `<tr><th>${propertyId}</th><td>${value}</td></tr>`;
    }
  });

  if (html.length > 0) {
    html = `<table class="cesium-infoBox-defaultTable"><tbody>${html}</tbody></table>`;
  }

  return html;
}

function getCesium3DTileFeatureName(feature) {
  // We need to iterate all property IDs to find potential
  // candidates, but since we prefer some property IDs
  // over others, we store them in an indexed array
  // and then use the first defined element in the array
  // as the preferred choice.

  let i;
  const possibleIds = [];
  const propertyIds = feature.getPropertyIds();
  for (i = 0; i < propertyIds.length; i++) {
    const propertyId = propertyIds[i];
    if (/^name$/i.test(propertyId)) {
      possibleIds[0] = feature.getProperty(propertyId);
    } else if (/name/i.test(propertyId)) {
      possibleIds[1] = feature.getProperty(propertyId);
    } else if (/^title$/i.test(propertyId)) {
      possibleIds[2] = feature.getProperty(propertyId);
    } else if (/^(id|identifier)$/i.test(propertyId)) {
      possibleIds[3] = feature.getProperty(propertyId);
    } else if (/element/i.test(propertyId)) {
      possibleIds[4] = feature.getProperty(propertyId);
    } else if (/(id|identifier)$/i.test(propertyId)) {
      possibleIds[5] = feature.getProperty(propertyId);
    }
  }

  const length = possibleIds.length;
  for (i = 0; i < length; i++) {
    const item = possibleIds[i];
    if (defined(item) && item !== "") {
      return item;
    }
  }
  return "Unnamed Feature";
}

function entityFromPickedObject(picked) {
  if (defined(picked)) {
    const id = picked.id ?? picked.primitive.id;
    if (id instanceof Entity) {
      return id;
    }

    if (
      picked instanceof Cesium3DTileFeature ||
      picked instanceof Cesium3DTileVectorFeature
    ) {
      return new Entity({
        name: getCesium3DTileFeatureName(picked),
        description: getCesium3DTileFeatureDescription(picked),
        feature: picked,
      });
    }
  }

  return undefined;
}

/**
 * Resolves the entity under a window position and hands it to <code>apply</code>.
 *
 * The pick is asynchronous because a synchronous one cannot be answered on a
 * backend whose pick buffer is read back asynchronously: it declines whenever
 * the view has moved since the last readback, which is exactly what a click
 * during camera motion looks like, and it reports that decline as "nothing
 * here" — indistinguishable from a real miss. Callers must be able to tell
 * "nothing is there" from "not knowable yet", so an unanswerable pick has to
 * arrive as a rejection rather than as an empty result.
 *
 * @param {Viewer} viewer The viewer whose scene is picked.
 * @param {Cartesian2} windowPosition The position to pick.
 * @param {function} isCurrent Reports whether this request is still the newest
 *        one its caller issued. A superseded request applies nothing.
 * @param {function} apply Receives the picked entity, or <code>undefined</code>
 *        when the pick was answered and found nothing.
 * @returns {Promise} Rejects when the pick could not be answered at all.
 *
 * @private
 */
async function pickEntityAsync(viewer, windowPosition, isCurrent, apply) {
  const picked = await viewer.scene.pickAsync(windowPosition);
  if (!isCurrent()) {
    return;
  }

  const entity = entityFromPickedObject(picked);
  if (defined(entity)) {
    apply(entity);
    return;
  }

  // No regular entity picked.  Try picking features from imagery layers.
  // The imagery pick starts and its result is applied in the same turn: its
  // loading placeholder has to be the viewer's selection before that pick's
  // own supersession check runs, and an imagery provider is free to answer
  // immediately.
  apply(pickImageryLayerFeature(viewer, windowPosition));
}

const scratchStopTime = new JulianDate();

function linkTimelineToDataSourceClock(timeline, dataSource) {
  if (defined(dataSource)) {
    const dataSourceClock = dataSource.clock;
    if (defined(dataSourceClock) && defined(timeline)) {
      const startTime = dataSourceClock.startTime;
      let stopTime = dataSourceClock.stopTime;
      // When the start and stop times are equal, set the timeline to the shortest interval
      // starting at the start time. This prevents an invalid timeline configuration.
      if (JulianDate.equals(startTime, stopTime)) {
        stopTime = JulianDate.addSeconds(
          startTime,
          CesiumMath.EPSILON2,
          scratchStopTime,
        );
      }
      timeline.updateFromClock();
      timeline.zoomTo(startTime, stopTime);
    }
  }
}

const cartesian3Scratch = new Cartesian3();

function findFirstTileset(primitives) {
  const length = primitives.length;
  for (let i = 0; i < length; ++i) {
    const primitive = primitives.get(i);
    if (primitive instanceof Cesium3DTileset) {
      return primitive;
    }
  }
  return undefined;
}

function pickImageryLayerFeature(viewer, windowPosition) {
  const scene = viewer.scene;
  const pickRay = scene.camera.getPickRay(windowPosition);
  if (!defined(pickRay)) {
    return;
  }

  // When globe is disabled, scene.imageryLayers is undefined. Fall back to the
  // first Cesium3DTileset's imagery layers (e.g. draped imagery on 3D Tiles).
  let imageryLayers = scene.imageryLayers;
  if (!defined(imageryLayers)) {
    const tileset = findFirstTileset(scene.primitives);
    if (!defined(tileset)) {
      return;
    }
    imageryLayers = tileset.imageryLayers;
  }

  const imageryLayerFeaturePromise = imageryLayers.pickImageryLayerFeatures(
    pickRay,
    scene,
  );
  if (!defined(imageryLayerFeaturePromise)) {
    return;
  }

  // Imagery layer feature picking is asynchronous, so put up a message while loading.
  const loadingMessage = new Entity({
    id: "Loading...",
    description: "Loading feature information...",
  });

  imageryLayerFeaturePromise.then(
    function (features) {
      // Has this async pick been superseded by a later one?
      if (viewer.selectedEntity !== loadingMessage) {
        return;
      }

      if (!defined(features) || features.length === 0) {
        viewer.selectedEntity = createNoFeaturesEntity();
        return;
      }

      // Select the first feature.
      const feature = features[0];

      const entity = new Entity({
        id: feature.name,
        description: feature.description,
      });

      if (defined(feature.position)) {
        const ecfPosition = viewer.scene.ellipsoid.cartographicToCartesian(
          feature.position,
          cartesian3Scratch,
        );
        entity.position = new ConstantPositionProperty(ecfPosition);
      }

      viewer.selectedEntity = entity;
    },
    function () {
      // Has this async pick been superseded by a later one?
      if (viewer.selectedEntity !== loadingMessage) {
        return;
      }
      viewer.selectedEntity = createNoFeaturesEntity();
    },
  );

  return loadingMessage;
}

function createNoFeaturesEntity() {
  return new Entity({
    id: "None",
    description: "No features found.",
  });
}

function enableVRUI(viewer, enabled) {
  const geocoder = viewer._geocoder;
  const homeButton = viewer._homeButton;
  const sceneModePicker = viewer._sceneModePicker;
  const projectionPicker = viewer._projectionPicker;
  const baseLayerPicker = viewer._baseLayerPicker;
  const animation = viewer._animation;
  const timeline = viewer._timeline;
  const fullscreenButton = viewer._fullscreenButton;
  const infoBox = viewer._infoBox;
  const selectionIndicator = viewer._selectionIndicator;

  const visibility = enabled ? "hidden" : "visible";

  if (defined(geocoder)) {
    geocoder.container.style.visibility = visibility;
  }
  if (defined(homeButton)) {
    homeButton.container.style.visibility = visibility;
  }
  if (defined(sceneModePicker)) {
    sceneModePicker.container.style.visibility = visibility;
  }
  if (defined(projectionPicker)) {
    projectionPicker.container.style.visibility = visibility;
  }
  if (defined(baseLayerPicker)) {
    baseLayerPicker.container.style.visibility = visibility;
  }
  if (defined(animation)) {
    animation.container.style.visibility = visibility;
  }
  if (defined(timeline)) {
    timeline.container.style.visibility = visibility;
  }
  if (
    defined(fullscreenButton) &&
    fullscreenButton.viewModel.isFullscreenEnabled
  ) {
    fullscreenButton.container.style.visibility = visibility;
  }
  if (defined(infoBox)) {
    infoBox.container.style.visibility = visibility;
  }
  if (defined(selectionIndicator)) {
    selectionIndicator.container.style.visibility = visibility;
  }

  if (viewer._container) {
    const right =
      enabled || !defined(fullscreenButton)
        ? 0
        : fullscreenButton.container.clientWidth;
    viewer._vrButton.container.style.right = `${right}px`;

    viewer.forceResize();
  }
}

/**
 * @typedef {object} Viewer.ConstructorOptions
 *
 * Initialization options for the Viewer constructor
 *
 * @property {boolean} [animation=true] If set to false, the Animation widget will not be created.
 * @property {boolean} [baseLayerPicker=true] If set to false, the BaseLayerPicker widget will not be created.
 * @property {boolean} [fullscreenButton=true] If set to false, the FullscreenButton widget will not be created.
 * @property {boolean} [vrButton=false] If set to true, the VRButton widget will be created.
 * @property {boolean|IonGeocodeProviderType|GeocoderService[]} [geocoder=IonGeocodeProviderType.DEFAULT] The geocoding service or services to use when searching with the Geocoder widget. If set to false, the Geocoder widget will not be created.
 * @property {boolean} [homeButton=true] If set to false, the HomeButton widget will not be created.
 * @property {boolean} [infoBox=true] If set to false, the InfoBox widget will not be created.
 * @property {boolean} [sceneModePicker=true] If set to false, the SceneModePicker widget will not be created.
 * @property {boolean} [selectionIndicator=true] If set to false, the SelectionIndicator widget will not be created.
 * @property {boolean} [timeline=true] If set to false, the Timeline widget will not be created.
 * @property {boolean} [navigationHelpButton=true] If set to false, the navigation help button will not be created.
 * @property {boolean} [navigationInstructionsInitiallyVisible=true] True if the navigation instructions should initially be visible, or false if the should not be shown until the user explicitly clicks the button.
 * @property {boolean} [scene3DOnly=false] When <code>true</code>, each geometry instance will only be rendered in 3D to save GPU memory.
 * @property {boolean} [shouldAnimate=false] <code>true</code> if the clock should attempt to advance simulation time by default, <code>false</code> otherwise.  This option takes precedence over setting {@link Viewer#clockViewModel}.
 * @property {ClockViewModel} [clockViewModel=new ClockViewModel(clock)] The clock view model to use to control current time.
 * @property {ProviderViewModel} [selectedImageryProviderViewModel] The view model for the current base imagery layer, if not supplied the first available base layer is used.  This value is only valid if `baseLayerPicker` is set to true.
 * @property {ProviderViewModel[]} [imageryProviderViewModels=createDefaultImageryProviderViewModels()] The array of ProviderViewModels to be selectable from the BaseLayerPicker.  This value is only valid if `baseLayerPicker` is set to true.
 * @property {ProviderViewModel} [selectedTerrainProviderViewModel] The view model for the current base terrain layer, if not supplied the first available base layer is used.  This value is only valid if `baseLayerPicker` is set to true.
 * @property {ProviderViewModel[]} [terrainProviderViewModels=createDefaultTerrainProviderViewModels()] The array of ProviderViewModels to be selectable from the BaseLayerPicker.  This value is only valid if `baseLayerPicker` is set to true.
 * @property {ImageryLayer|false} [baseLayer=ImageryLayer.fromWorldImagery()] The bottommost imagery layer applied to the globe. If set to <code>false</code>, no imagery provider will be added. This value is only valid if `baseLayerPicker` is set to false. Cannot be used when `globe` is set to false.
 * @property {Ellipsoid} [ellipsoid = Ellipsoid.default] The default ellipsoid.
 * @property {TerrainProvider} [terrainProvider=new EllipsoidTerrainProvider()] The terrain provider to use
 * @property {Terrain} [terrain] A terrain object which handles asynchronous terrain provider. Can only specify if options.terrainProvider is undefined.
 * @property {SkyBox|false} [skyBox] The skybox used to render the stars. When <code>undefined</code> and the WGS84 ellipsoid used, the default stars are used. If set to <code>false</code>, no skyBox, Sun, or Moon will be added.
 * @property {SkyAtmosphere|false} [skyAtmosphere] Blue sky, and the glow around the Earth's limb. Enabled when the WGS84 ellipsoid used. Set to <code>false</code> to turn it off.
 * @property {Element|string} [fullscreenElement=document.body] The element or id to be placed into fullscreen mode when the full screen button is pressed.
 * @property {boolean} [useDefaultRenderLoop=true] True if this widget should control the render loop, false otherwise.
 * @property {number} [targetFrameRate] The target frame rate when using the default render loop.
 * @property {boolean} [showRenderLoopErrors=true] If true, this widget will automatically display an HTML panel to the user containing the error, if a render loop error occurs.
 * @property {boolean} [useBrowserRecommendedResolution=true] If true, render at the browser's recommended resolution and ignore <code>window.devicePixelRatio</code>.
 * @property {boolean} [automaticallyTrackDataSourceClocks=true] If true, this widget will automatically track the clock settings of newly added DataSources, updating if the DataSource's clock changes.  Set this to false if you want to configure the clock independently.
 * @property {ContextOptions} [contextOptions] Context and WebGL creation properties passed to {@link Scene}.
 * @property {SceneMode} [sceneMode=SceneMode.SCENE3D] The initial scene mode.
 * @property {MapProjection} [mapProjection=new GeographicProjection(options.ellipsoid)] The map projection to use in 2D and Columbus View modes.
 * @property {Globe|false} [globe=new Globe(options.ellipsoid)] The globe to use in the scene.  If set to <code>false</code>, no globe will be added and the sky atmosphere will be hidden by default.
 * @property {boolean} [orderIndependentTranslucency=true] If true and the configuration supports it, use order independent translucency.
 * @property {Element|string} [creditContainer] The DOM element or ID that will contain the {@link CreditDisplay}.  If not specified, the credits are added to the bottom of the widget itself.
 * @property {Element|string} [creditViewport] The DOM element or ID that will contain the credit pop up created by the {@link CreditDisplay}.  If not specified, it will appear over the widget itself.
 * @property {DataSourceCollection} [dataSources=new DataSourceCollection()] The collection of data sources visualized by the widget.  If this parameter is provided,
 *                               the instance is assumed to be owned by the caller and will not be destroyed when the viewer is destroyed.
 * @property {boolean} [shadows=false] Determines if shadows are cast by light sources.
 * @property {ShadowMode} [terrainShadows=ShadowMode.RECEIVE_ONLY] Determines if the terrain casts or receives shadows from light sources.
 * @property {MapMode2D} [mapMode2D=MapMode2D.INFINITE_SCROLL] Determines if the 2D map is rotatable or can be scrolled infinitely in the horizontal direction.
 * @property {boolean} [projectionPicker=false] If set to true, the ProjectionPicker widget will be created.
 * @property {boolean} [blurActiveElementOnCanvasFocus=true] If true, the active element will blur when the viewer's canvas is clicked. Setting this to false is useful for cases when the canvas is clicked only for retrieving position or an entity data without actually meaning to set the canvas to be the active element.
 * @property {boolean} [requestRenderMode=false] If true, rendering a frame will only occur when needed as determined by changes within the scene. Enabling reduces the CPU/GPU usage of your application and uses less battery on mobile, but requires using {@link Scene#requestRender} to render a new frame explicitly in this mode. This will be necessary in many cases after making changes to the scene in other parts of the API. See {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}.
 * @property {number} [maximumRenderTimeChange=0.0] If requestRenderMode is true, this value defines the maximum change in simulation time allowed before a render is requested. See {@link https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/|Improving Performance with Explicit Rendering}.
 * @property {number} [depthPlaneEllipsoidOffset=0.0] Adjust the DepthPlane to address rendering artefacts below ellipsoid zero elevation.
 * @property {number} [msaaSamples=4] If provided, this value controls the rate of multisample antialiasing. Typical multisampling rates are 2, 4, and sometimes 8 samples per pixel. Higher sampling rates of MSAA may impact performance in exchange for improved visual quality. This value only applies to WebGL2 contexts that support multisample render targets. Set to 1 to disable MSAA.
 */

/**
 * A base widget for building applications.  It composites all of the standard Cesium widgets into one reusable package.
 * The widget can always be extended by using mixins, which add functionality useful for a variety of applications.
 *
 * @alias Viewer
 * @constructor
 *
 * @param {Element|string} container The DOM element or ID that will contain the widget.
 * @param {Viewer.ConstructorOptions} [options] Object describing initialization options
 *
 * @exception {DeveloperError} Element with id "container" does not exist in the document.
 * @exception {DeveloperError} options.selectedImageryProviderViewModel is not available when not using the BaseLayerPicker widget, specify options.baseLayer instead.
 * @exception {DeveloperError} options.selectedTerrainProviderViewModel is not available when not using the BaseLayerPicker widget, specify options.terrainProvider instead.
 *
 * @see Animation
 * @see BaseLayerPicker
 * @see CesiumWidget
 * @see FullscreenButton
 * @see HomeButton
 * @see SceneModePicker
 * @see Timeline
 * @see viewerDragDropMixin
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?id=hello-world|Cesium Sandcastle Hello World Demo}
 *
 * @example
 * // Initialize the viewer widget with several custom options and mixins.
 * try {
 *   const viewer = new Cesium.Viewer("cesiumContainer", {
 *     // Start in Columbus Viewer
 *     sceneMode: Cesium.SceneMode.COLUMBUS_VIEW,
 *     // Use Cesium World Terrain
 *     terrain: Cesium.Terrain.fromWorldTerrain(),
 *     // Hide the base layer picker
 *     baseLayerPicker: false,
 *     // Use OpenStreetMaps
 *     baseLayer: new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({
 *       url: "https://tile.openstreetmap.org/"
 *     })),
 *     skyBox: new Cesium.SkyBox({
 *       sources: {
 *         positiveX: "stars/TychoSkymapII.t3_08192x04096_80_px.jpg",
 *         negativeX: "stars/TychoSkymapII.t3_08192x04096_80_mx.jpg",
 *         positiveY: "stars/TychoSkymapII.t3_08192x04096_80_py.jpg",
 *         negativeY: "stars/TychoSkymapII.t3_08192x04096_80_my.jpg",
 *         positiveZ: "stars/TychoSkymapII.t3_08192x04096_80_pz.jpg",
 *         negativeZ: "stars/TychoSkymapII.t3_08192x04096_80_mz.jpg"
 *       }
 *     }),
 *     // Show Columbus View map with Web Mercator projection
 *     mapProjection: new Cesium.WebMercatorProjection()
 *   });
 * } catch (error) {
 *   console.log(error);
 * }
 *
 * // Add basic drag and drop functionality
 * viewer.extend(Cesium.viewerDragDropMixin);
 *
 * // Show a pop-up alert if we encounter an error when processing a dropped file
 * viewer.dropError.addEventListener(function(dropHandler, name, error) {
 *   console.log(error);
 *   window.alert(error);
 * });
 */
class Viewer {
  constructor(container, options) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(container)) {
      throw new DeveloperError("container is required.");
    }
    //>>includeEnd('debug');

    container = getElement(container);
    options = options ?? Frozen.EMPTY_OBJECT;

    if (
      !defined(options._preInitializedScene) &&
      !defined(options._preInitializedContext)
    ) {
      // Reject asynchronous renderer policies before constructing any Viewer
      // DOM or view-model state.
      getSynchronousRendererType(options.contextOptions ?? Frozen.EMPTY_OBJECT);
    }

    //>>includeStart('debug', pragmas.debug);
    if (
      options.globe === false &&
      defined(options.baseLayer) &&
      options.baseLayer !== false
    ) {
      throw new DeveloperError("Cannot use baseLayer when globe is disabled.");
    }
    //>>includeEnd('debug');

    const createBaseLayerPicker =
      (!defined(options.globe) || options.globe !== false) &&
      (!defined(options.baseLayerPicker) || options.baseLayerPicker !== false);

    //>>includeStart('debug', pragmas.debug);
    // If not using BaseLayerPicker, selectedImageryProviderViewModel is an invalid option
    if (
      !createBaseLayerPicker &&
      defined(options.selectedImageryProviderViewModel)
    ) {
      throw new DeveloperError(
        "options.selectedImageryProviderViewModel is not available when not using the BaseLayerPicker widget. \
  Either specify options.baseLayer instead or set options.baseLayerPicker to true.",
      );
    }

    // If not using BaseLayerPicker, selectedTerrainProviderViewModel is an invalid option
    if (
      !createBaseLayerPicker &&
      defined(options.selectedTerrainProviderViewModel)
    ) {
      throw new DeveloperError(
        "options.selectedTerrainProviderViewModel is not available when not using the BaseLayerPicker widget. \
  Either specify options.terrainProvider instead or set options.baseLayerPicker to true.",
      );
    }
    //>>includeEnd('debug');

    const construction = createViewerConstructionTransaction(this);
    try {
      const that = this;

      const viewerContainer = document.createElement("div");
      viewerContainer.className = "cesium-viewer";
      container.appendChild(viewerContainer);
      construction.root = viewerContainer;

      // Cesium widget container
      const cesiumWidgetContainer = document.createElement("div");
      cesiumWidgetContainer.className = "cesium-viewer-cesiumWidgetContainer";
      viewerContainer.appendChild(cesiumWidgetContainer);

      // Bottom container
      const bottomContainer = document.createElement("div");
      bottomContainer.className = "cesium-viewer-bottom";

      viewerContainer.appendChild(bottomContainer);

      const scene3DOnly = options.scene3DOnly ?? false;

      let clock;
      let clockViewModel;
      let destroyClockViewModel = false;
      if (defined(options.clockViewModel)) {
        clockViewModel = options.clockViewModel;
        clock = clockViewModel.clock;
      } else {
        clock = new Clock();
        clockViewModel = ownViewerConstructionResource(
          construction,
          new ClockViewModel(clock),
        );
        destroyClockViewModel = true;
      }

      // Cesium widget
      const cesiumWidget = ownViewerConstructionResource(
        construction,
        new CesiumWidget(cesiumWidgetContainer, {
          baseLayer:
            (createBaseLayerPicker &&
              defined(options.selectedImageryProviderViewModel)) ||
            defined(options.baseLayer) ||
            defined(options.imageryProvider)
              ? false
              : undefined,
          clock: clock,
          shouldAnimate: options.shouldAnimate,
          skyBox: options.skyBox,
          skyAtmosphere: options.skyAtmosphere,
          sceneMode: options.sceneMode,
          ellipsoid: options.ellipsoid,
          mapProjection: options.mapProjection,
          globe: options.globe,
          orderIndependentTranslucency: options.orderIndependentTranslucency,
          automaticallyTrackDataSourceClocks:
            options.automaticallyTrackDataSourceClocks,
          contextOptions: options.contextOptions,
          useDefaultRenderLoop: options.useDefaultRenderLoop,
          targetFrameRate: options.targetFrameRate,
          showRenderLoopErrors: options.showRenderLoopErrors,
          useBrowserRecommendedResolution:
            options.useBrowserRecommendedResolution,
          creditContainer: defined(options.creditContainer)
            ? options.creditContainer
            : bottomContainer,
          creditViewport: options.creditViewport,
          dataSources: options.dataSources,
          scene3DOnly: scene3DOnly,
          shadows: options.shadows,
          terrainShadows: options.terrainShadows,
          mapMode2D: options.mapMode2D,
          blurActiveElementOnCanvasFocus:
            options.blurActiveElementOnCanvasFocus,
          requestRenderMode: options.requestRenderMode,
          maximumRenderTimeChange: options.maximumRenderTimeChange,
          depthPlaneEllipsoidOffset: options.depthPlaneEllipsoidOffset,
          msaaSamples: options.msaaSamples,
          _preInitializedScene: options._preInitializedScene,
          _preInitializedCanvas: options._preInitializedCanvas,
          _preInitializedContext: options._preInitializedContext,
          _contextCreationDiagnostics: options._contextCreationDiagnostics,
          _countContextReferences: options._countContextReferences,
        }),
      );

      const scene = cesiumWidget.scene;

      const eventHelper = new EventHelper();
      construction.eventHelper = eventHelper;

      eventHelper.add(clock.onTick, Viewer.prototype._onTick, this);

      // Selection Indicator
      let selectionIndicator;
      if (
        !defined(options.selectionIndicator) ||
        options.selectionIndicator !== false
      ) {
        const selectionIndicatorContainer = document.createElement("div");
        selectionIndicatorContainer.className =
          "cesium-viewer-selectionIndicatorContainer";
        viewerContainer.appendChild(selectionIndicatorContainer);
        selectionIndicator = ownViewerConstructionResource(
          construction,
          new SelectionIndicator(selectionIndicatorContainer, scene),
        );
      }

      // Info Box
      let infoBox;
      if (!defined(options.infoBox) || options.infoBox !== false) {
        const infoBoxContainer = document.createElement("div");
        infoBoxContainer.className = "cesium-viewer-infoBoxContainer";
        viewerContainer.appendChild(infoBoxContainer);
        infoBox = ownViewerConstructionResource(
          construction,
          new InfoBox(infoBoxContainer),
        );

        const infoBoxViewModel = infoBox.viewModel;
        eventHelper.add(
          infoBoxViewModel.cameraClicked,
          Viewer.prototype._onInfoBoxCameraClicked,
          this,
        );
        eventHelper.add(
          infoBoxViewModel.closeClicked,
          Viewer.prototype._onInfoBoxClockClicked,
          this,
        );
      }

      // Main Toolbar
      const toolbar = document.createElement("div");
      toolbar.className = "cesium-viewer-toolbar";
      viewerContainer.appendChild(toolbar);

      // Geocoder
      let geocoder;
      if (!defined(options.geocoder) || options.geocoder !== false) {
        const geocoderContainer = document.createElement("div");
        geocoderContainer.className = "cesium-viewer-geocoderContainer";
        toolbar.appendChild(geocoderContainer);
        let geocoderService;
        if (typeof options.geocoder === "string") {
          geocoderService = [
            new IonGeocoderService({
              scene,
              geocodeProviderType: options.geocoder,
            }),
          ];
        } else if (
          defined(options.geocoder) &&
          typeof options.geocoder !== "boolean"
        ) {
          geocoderService = Array.isArray(options.geocoder)
            ? options.geocoder
            : [options.geocoder];
        }
        geocoder = ownViewerConstructionResource(
          construction,
          new Geocoder({
            container: geocoderContainer,
            geocoderServices: geocoderService,
            scene: scene,
          }),
        );
        // Subscribe to search so that we can clear the trackedEntity when it is clicked.
        eventHelper.add(
          geocoder.viewModel.search.beforeExecute,
          Viewer.prototype._clearObjects,
          this,
        );
      }

      // HomeButton
      let homeButton;
      if (!defined(options.homeButton) || options.homeButton !== false) {
        homeButton = ownViewerConstructionResource(
          construction,
          new HomeButton(toolbar, scene),
        );
        if (defined(geocoder)) {
          eventHelper.add(
            homeButton.viewModel.command.afterExecute,
            function () {
              const viewModel = geocoder.viewModel;
              viewModel.searchText = "";
              if (viewModel.isSearchInProgress) {
                viewModel.search();
              }
            },
          );
        }
        // Subscribe to the home button beforeExecute event so that we can clear the trackedEntity.
        eventHelper.add(
          homeButton.viewModel.command.beforeExecute,
          Viewer.prototype._clearTrackedObject,
          this,
        );
      }

      // SceneModePicker
      // By default, we silently disable the scene mode picker if scene3DOnly is true,
      // but if sceneModePicker is explicitly set to true, throw an error.
      //>>includeStart('debug', pragmas.debug);
      if (options.sceneModePicker === true && scene3DOnly) {
        throw new DeveloperError(
          "options.sceneModePicker is not available when options.scene3DOnly is set to true.",
        );
      }
      //>>includeEnd('debug');

      let sceneModePicker;
      if (
        !scene3DOnly &&
        (!defined(options.sceneModePicker) || options.sceneModePicker !== false)
      ) {
        sceneModePicker = ownViewerConstructionResource(
          construction,
          new SceneModePicker(toolbar, scene),
        );
      }

      let projectionPicker;
      if (options.projectionPicker) {
        projectionPicker = ownViewerConstructionResource(
          construction,
          new ProjectionPicker(toolbar, scene),
        );
      }

      // BaseLayerPicker
      let baseLayerPicker;
      let baseLayerPickerDropDown;
      if (createBaseLayerPicker) {
        const imageryProviderViewModels =
          options.imageryProviderViewModels ??
          createDefaultImageryProviderViewModels();
        const terrainProviderViewModels =
          options.terrainProviderViewModels ??
          createDefaultTerrainProviderViewModels();

        baseLayerPicker = ownViewerConstructionResource(
          construction,
          new BaseLayerPicker(toolbar, {
            globe: scene.globe,
            imageryProviderViewModels: imageryProviderViewModels,
            selectedImageryProviderViewModel:
              options.selectedImageryProviderViewModel,
            terrainProviderViewModels: terrainProviderViewModels,
            selectedTerrainProviderViewModel:
              options.selectedTerrainProviderViewModel,
          }),
        );

        //Grab the dropdown for resize code.
        const elements = toolbar.getElementsByClassName(
          "cesium-baseLayerPicker-dropDown",
        );
        baseLayerPickerDropDown = elements[0];
      }

      // These need to be set after the BaseLayerPicker is created in order to take effect
      if (defined(options.baseLayer) && options.baseLayer !== false) {
        if (createBaseLayerPicker) {
          baseLayerPicker.viewModel.selectedImagery = undefined;
        }
        scene.imageryLayers.removeAll();
        scene.imageryLayers.add(options.baseLayer);
      }

      if (defined(options.terrainProvider)) {
        if (createBaseLayerPicker) {
          baseLayerPicker.viewModel.selectedTerrain = undefined;
        }
        scene.terrainProvider = options.terrainProvider;
      }

      if (defined(options.terrain)) {
        //>>includeStart('debug', pragmas.debug);
        if (defined(options.terrainProvider)) {
          throw new DeveloperError(
            "Specify either options.terrainProvider or options.terrain.",
          );
        }
        //>>includeEnd('debug');

        if (createBaseLayerPicker) {
          // Required as this is otherwise set by the baseLayerPicker
          scene.globe.depthTestAgainstTerrain = true;
        }

        scene.setTerrain(options.terrain);
      }

      // Navigation Help Button
      let navigationHelpButton;
      if (
        !defined(options.navigationHelpButton) ||
        options.navigationHelpButton !== false
      ) {
        let showNavHelp = true;
        try {
          //window.localStorage is null if disabled in Firefox or undefined in browsers with implementation
          if (defined(window.localStorage)) {
            const hasSeenNavHelp = window.localStorage.getItem(
              "cesium-hasSeenNavHelp",
            );
            if (defined(hasSeenNavHelp) && Boolean(hasSeenNavHelp)) {
              showNavHelp = false;
            } else {
              window.localStorage.setItem("cesium-hasSeenNavHelp", "true");
            }
          }
        } catch (e) {
          //Accessing window.localStorage throws if disabled in Chrome
          //window.localStorage.setItem throws if in Safari private browsing mode or in any browser if we are over quota.
        }
        navigationHelpButton = ownViewerConstructionResource(
          construction,
          new NavigationHelpButton({
            container: toolbar,
            instructionsInitiallyVisible:
              options.navigationInstructionsInitiallyVisible ?? showNavHelp,
          }),
        );
      }

      // Animation
      let animation;
      if (!defined(options.animation) || options.animation !== false) {
        const animationContainer = document.createElement("div");
        animationContainer.className = "cesium-viewer-animationContainer";
        viewerContainer.appendChild(animationContainer);
        animation = ownViewerConstructionResource(
          construction,
          new Animation(
            animationContainer,
            new AnimationViewModel(clockViewModel),
          ),
        );
      }

      // Timeline
      let timeline;
      if (!defined(options.timeline) || options.timeline !== false) {
        const timelineContainer = document.createElement("div");
        timelineContainer.className = "cesium-viewer-timelineContainer";
        viewerContainer.appendChild(timelineContainer);
        timeline = ownViewerConstructionResource(
          construction,
          new Timeline(timelineContainer, clock),
        );
        timeline.addEventListener("settime", onTimelineScrubfunction, false);
        construction.cleanups.push(function () {
          timeline.removeEventListener(
            "settime",
            onTimelineScrubfunction,
            false,
          );
        });
        timeline.zoomTo(clock.startTime, clock.stopTime);
      }

      // Fullscreen
      let fullscreenButton;
      let fullscreenSubscription;
      let fullscreenContainer;
      if (
        !defined(options.fullscreenButton) ||
        options.fullscreenButton !== false
      ) {
        fullscreenContainer = document.createElement("div");
        fullscreenContainer.className = "cesium-viewer-fullscreenContainer";
        viewerContainer.appendChild(fullscreenContainer);
        fullscreenButton = ownViewerConstructionResource(
          construction,
          new FullscreenButton(fullscreenContainer, options.fullscreenElement),
        );

        //Subscribe to fullscreenButton.viewModel.isFullscreenEnabled so
        //that we can hide/show the button as well as size the timeline.
        fullscreenSubscription = subscribeAndEvaluate(
          fullscreenButton.viewModel,
          "isFullscreenEnabled",
          function (isFullscreenEnabled) {
            fullscreenContainer.style.display = isFullscreenEnabled
              ? "block"
              : "none";
            if (defined(timeline)) {
              timeline.container.style.right = `${fullscreenContainer.clientWidth}px`;
              timeline.resize();
            }
          },
        );
        construction.cleanups.push(function () {
          fullscreenSubscription.dispose();
        });
      }

      // VR
      let vrButton;
      let vrSubscription;
      let vrModeSubscription;
      if (options.vrButton) {
        const vrContainer = document.createElement("div");
        vrContainer.className = "cesium-viewer-vrContainer";
        viewerContainer.appendChild(vrContainer);
        vrButton = ownViewerConstructionResource(
          construction,
          new VRButton(vrContainer, scene, options.fullScreenElement),
        );

        vrSubscription = subscribeAndEvaluate(
          vrButton.viewModel,
          "isVREnabled",
          function (isVREnabled) {
            vrContainer.style.display = isVREnabled ? "block" : "none";
            if (defined(fullscreenButton)) {
              vrContainer.style.right = `${fullscreenContainer.clientWidth}px`;
            }
            if (defined(timeline)) {
              timeline.container.style.right = `${vrContainer.clientWidth}px`;
              timeline.resize();
            }
          },
        );

        vrModeSubscription = subscribeAndEvaluate(
          vrButton.viewModel,
          "isVRMode",
          function (isVRMode) {
            enableVRUI(that, isVRMode);
          },
        );
        construction.cleanups.push(function () {
          vrModeSubscription.dispose();
        });
        construction.cleanups.push(function () {
          vrSubscription.dispose();
        });
      }

      //Assign all properties to this instance.  No "this" assignments should
      //take place above this line.
      this._baseLayerPickerDropDown = baseLayerPickerDropDown;
      this._fullscreenSubscription = fullscreenSubscription;
      this._vrSubscription = vrSubscription;
      this._vrModeSubscription = vrModeSubscription;
      this._dataSourceChangedListeners = new Map();
      this._entityCollectionChangedListenerRemovers = new Map();
      construction.cleanups.push(() => {
        removeAllDataSourceCollectionChangedListeners(this);
      });
      this._container = container;
      this._bottomContainer = bottomContainer;
      this._element = viewerContainer;
      this._cesiumWidget = cesiumWidget;
      this._selectionIndicator = selectionIndicator;
      this._infoBox = infoBox;
      this._clockViewModel = clockViewModel;
      this._destroyClockViewModel = destroyClockViewModel;
      this._toolbar = toolbar;
      this._homeButton = homeButton;
      this._sceneModePicker = sceneModePicker;
      this._projectionPicker = projectionPicker;
      this._baseLayerPicker = baseLayerPicker;
      this._navigationHelpButton = navigationHelpButton;
      this._animation = animation;
      this._timeline = timeline;
      this._fullscreenButton = fullscreenButton;
      this._vrButton = vrButton;
      this._geocoder = geocoder;
      this._eventHelper = eventHelper;
      this._lastWidth = 0;
      this._lastHeight = 0;
      this._enableInfoOrSelection =
        defined(infoBox) || defined(selectionIndicator);
      this._selectedEntity = undefined;
      this._selectedEntityChanged = new Event();

      const dataSourceCollection = this._cesiumWidget.dataSources;
      const dataSourceDisplay = this._cesiumWidget.dataSourceDisplay;

      //Listen to data source events in order to track clock changes.
      eventHelper.add(
        dataSourceCollection.dataSourceAdded,
        Viewer.prototype._onDataSourceAdded,
        this,
      );
      eventHelper.add(
        dataSourceCollection.dataSourceRemoved,
        Viewer.prototype._onDataSourceRemoved,
        this,
      );

      // Prior to each render, check if anything needs to be resized.
      eventHelper.add(scene.postUpdate, Viewer.prototype.resize, this);

      // We need to subscribe to the data sources and collections so that we can clear the
      // tracked object when it is removed from the scene.
      // Subscribe to current data sources
      const dataSourceLength = dataSourceCollection.length;
      for (let i = 0; i < dataSourceLength; i++) {
        this._dataSourceAdded(
          dataSourceCollection,
          dataSourceCollection.get(i),
        );
      }
      this._dataSourceAdded(undefined, dataSourceDisplay.defaultDataSource);

      // Hook up events so that we can subscribe to future sources.
      eventHelper.add(
        dataSourceCollection.dataSourceAdded,
        Viewer.prototype._dataSourceAdded,
        this,
      );
      eventHelper.add(
        dataSourceCollection.dataSourceRemoved,
        Viewer.prototype._dataSourceRemoved,
        this,
      );

      // Subscribe to left clicks and zoom to the picked object.
      //
      // Picking resolves later than the click that started it, so two clicks
      // can resolve out of order. Each request takes the next number from a
      // monotonic counter and may only write while it is still the newest;
      // a superseded result is dropped rather than queued behind its
      // predecessor, so a slow earlier pick can never overwrite a faster
      // later one.
      //
      // A pick that could not be answered must leave the current selection
      // alone — only an answered pick that found nothing may clear it.
      // Otherwise a click landing while the camera is still moving silently
      // deselects, and since tracking guarantees camera motion, double
      // clicking a tracked entity would stop tracking it.
      let selectionPickSequence = 0;
      let trackedPickSequence = 0;

      function reportUnansweredPick(error) {
        // Keeping the selection is the recovery, but the failure is still
        // real and has to reach the console. A viewer torn down while a pick
        // was in flight rejects by design and is not worth reporting.
        if (!that.isDestroyed()) {
          console.error(error);
        }
      }

      function pickAndTrackObject(e) {
        const sequence = ++trackedPickSequence;
        function isCurrent() {
          return sequence === trackedPickSequence && !that.isDestroyed();
        }

        pickEntityAsync(that, e.position, isCurrent, function (entity) {
          if (defined(entity)) {
            //Only track the entity if it has a valid position at the current time.
            if (
              Property.getValueOrUndefined(
                entity.position,
                that.clock.currentTime,
              )
            ) {
              that.trackedEntity = entity;
            } else {
              that.zoomTo(entity);
            }
          } else if (defined(that.trackedEntity)) {
            that.trackedEntity = undefined;
          }
        }).catch(reportUnansweredPick);
      }

      function pickAndSelectObject(e) {
        const sequence = ++selectionPickSequence;
        function isCurrent() {
          return sequence === selectionPickSequence && !that.isDestroyed();
        }

        pickEntityAsync(that, e.position, isCurrent, function (entity) {
          that.selectedEntity = entity;
        }).catch(reportUnansweredPick);
      }

      cesiumWidget.screenSpaceEventHandler.setInputAction(
        pickAndSelectObject,
        ScreenSpaceEventType.LEFT_CLICK,
      );
      cesiumWidget.screenSpaceEventHandler.setInputAction(
        pickAndTrackObject,
        ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );

      // This allows to update the Viewer's _clockViewModel instead of the CesiumWidget's _clock
      // when CesiumWidget is created from the Viewer.
      cesiumWidget._canAnimateUpdateCallback = this._updateCanAnimate(this);
      // Ownership has transferred to the fully initialized Viewer. Clearing
      // the transaction prevents a later refactor from accidentally treating
      // successful resources as rollback candidates.
      construction.resources.length = 0;
      construction.cleanups.length = 0;
      construction.eventHelper = undefined;
      construction.root = undefined;
    } catch (error) {
      rollbackViewerConstruction(construction);
      throw error;
    }
  }

  /**
   * Extends the base viewer functionality with the provided mixin.
   * A mixin may add additional properties, functions, or other behavior
   * to the provided viewer instance.
   *
   * @param {Viewer.ViewerMixin} mixin The Viewer mixin to add to this instance.
   * @param {object} [options] The options object to be passed to the mixin function.
   *
   * @see viewerDragDropMixin
   */
  extend(mixin, options) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(mixin)) {
      throw new DeveloperError("mixin is required.");
    }
    //>>includeEnd('debug');

    mixin(this, options);
  }

  /**
   * Resizes the widget to match the container size.
   * This function is called automatically as needed unless
   * <code>useDefaultRenderLoop</code> is set to false.
   */
  /**
   * Adds a controller— an implementation of the {@link Controller} interface used to handle input events, camera animations, and other interactions— to the viewer's scene.
   * @param {Controller} controller An implementation of the <code>Controller</code> interface.
   * @example
   * viewer.scene.screenSpaceCameraController.enableInputs = false;
   * viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
   *
   * const tiltOrbitController = new Cesium.ScreenSpaceTiltOrbitCameraController();
   * viewer.addController(tiltOrbitController);
   */
  addController(controller) {
    return this._cesiumWidget.addController(controller);
  }

  /**
   * Removes a controller— an implementation of the {@link Controller} interface used to handle input events, camera animations, and other interactions— from the viewer's scene.
   * @param {Controller} controller An implementation of the <code>Controller</code> interface.
   * @example
   * viewer.removeController(tiltOrbitController);
   */
  removeController(controller) {
    return this._cesiumWidget.removeController(controller);
  }

  resize() {
    const cesiumWidget = this._cesiumWidget;
    const container = this._container;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const animationExists = defined(this._animation);
    const timelineExists = defined(this._timeline);

    cesiumWidget.resize();

    if (width === this._lastWidth && height === this._lastHeight) {
      return;
    }

    const panelMaxHeight = height - 125;
    const baseLayerPickerDropDown = this._baseLayerPickerDropDown;

    if (defined(baseLayerPickerDropDown)) {
      baseLayerPickerDropDown.style.maxHeight = `${panelMaxHeight}px`;
    }

    if (defined(this._geocoder)) {
      const geocoderSuggestions = this._geocoder.searchSuggestionsContainer;
      geocoderSuggestions.style.maxHeight = `${panelMaxHeight}px`;
    }

    if (defined(this._infoBox)) {
      this._infoBox.viewModel.maxHeight = panelMaxHeight;
    }

    const timeline = this._timeline;
    let animationContainer;
    let animationWidth = 0;
    let creditLeft = 5;
    let creditBottom = 3;
    let creditRight = 0;

    if (
      animationExists &&
      window.getComputedStyle(this._animation.container).visibility !== "hidden"
    ) {
      const lastWidth = this._lastWidth;
      animationContainer = this._animation.container;
      if (width > 900) {
        animationWidth = 169;
        if (lastWidth <= 900) {
          animationContainer.style.width = "169px";
          animationContainer.style.height = "112px";
          this._animation.resize();
        }
      } else if (width >= 600) {
        animationWidth = 136;
        if (lastWidth < 600 || lastWidth > 900) {
          animationContainer.style.width = "136px";
          animationContainer.style.height = "90px";
          this._animation.resize();
        }
      } else {
        animationWidth = 106;
        if (lastWidth > 600 || lastWidth === 0) {
          animationContainer.style.width = "106px";
          animationContainer.style.height = "70px";
          this._animation.resize();
        }
      }
      creditLeft = animationWidth + 5;
    }

    if (
      timelineExists &&
      window.getComputedStyle(this._timeline.container).visibility !== "hidden"
    ) {
      const fullscreenButton = this._fullscreenButton;
      const vrButton = this._vrButton;
      const timelineContainer = timeline.container;
      const timelineStyle = timelineContainer.style;

      creditBottom = timelineContainer.clientHeight + 3;
      timelineStyle.left = `${animationWidth}px`;

      let pixels = 0;
      if (defined(fullscreenButton)) {
        pixels += fullscreenButton.container.clientWidth;
      }
      if (defined(vrButton)) {
        pixels += vrButton.container.clientWidth;
      }

      timelineStyle.right = `${pixels}px`;
      timeline.resize();
    }

    if (!timelineExists && defined(this._fullscreenButton)) {
      // don't let long credits (like the default ion token) go behind the fullscreen button
      creditRight = this._fullscreenButton.container.clientWidth;
    }

    this._bottomContainer.style.left = `${creditLeft}px`;
    this._bottomContainer.style.bottom = `${creditBottom}px`;
    this._bottomContainer.style.right = `${creditRight}px`;

    this._lastWidth = width;
    this._lastHeight = height;
  }

  /**
   * This forces the widget to re-think its layout, including
   * widget sizes and credit placement.
   */
  forceResize() {
    this._lastWidth = 0;
    this.resize();
  }

  /**
   * Renders the scene.  This function is called automatically
   * unless <code>useDefaultRenderLoop</code> is set to false;
   */
  render() {
    this._cesiumWidget.render();
  }

  /**
   * @returns {boolean} true if the object has been destroyed, false otherwise.
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the widget.  Should be called if permanently
   * removing the widget from layout.
   */
  destroy() {
    if (
      defined(this.screenSpaceEventHandler) &&
      !this.screenSpaceEventHandler.isDestroyed()
    ) {
      this.screenSpaceEventHandler.removeInputAction(
        ScreenSpaceEventType.LEFT_CLICK,
      );
      this.screenSpaceEventHandler.removeInputAction(
        ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    }

    this._container.removeChild(this._element);
    this._element.removeChild(this._toolbar);

    removeAllDataSourceCollectionChangedListeners(this);
    this._eventHelper.removeAll();

    if (defined(this._geocoder)) {
      this._geocoder = this._geocoder.destroy();
    }

    if (defined(this._homeButton)) {
      this._homeButton = this._homeButton.destroy();
    }

    if (defined(this._sceneModePicker)) {
      this._sceneModePicker = this._sceneModePicker.destroy();
    }

    if (defined(this._projectionPicker)) {
      this._projectionPicker = this._projectionPicker.destroy();
    }

    if (defined(this._baseLayerPicker)) {
      this._baseLayerPicker = this._baseLayerPicker.destroy();
    }

    if (defined(this._navigationHelpButton)) {
      this._navigationHelpButton = this._navigationHelpButton.destroy();
    }

    if (defined(this._animation)) {
      this._element.removeChild(this._animation.container);
      this._animation = this._animation.destroy();
    }

    if (defined(this._timeline)) {
      this._timeline.removeEventListener(
        "settime",
        onTimelineScrubfunction,
        false,
      );
      this._element.removeChild(this._timeline.container);
      this._timeline = this._timeline.destroy();
    }

    if (defined(this._fullscreenButton)) {
      this._fullscreenSubscription.dispose();
      this._element.removeChild(this._fullscreenButton.container);
      this._fullscreenButton = this._fullscreenButton.destroy();
    }

    if (defined(this._vrButton)) {
      this._vrSubscription.dispose();
      this._vrModeSubscription.dispose();
      this._element.removeChild(this._vrButton.container);
      this._vrButton = this._vrButton.destroy();
    }

    if (defined(this._infoBox)) {
      this._element.removeChild(this._infoBox.container);
      this._infoBox = this._infoBox.destroy();
    }

    if (defined(this._selectionIndicator)) {
      this._element.removeChild(this._selectionIndicator.container);
      this._selectionIndicator = this._selectionIndicator.destroy();
    }

    if (this._destroyClockViewModel) {
      this._clockViewModel = this._clockViewModel.destroy();
    }
    this._cesiumWidget = this._cesiumWidget.destroy();

    return destroyObject(this);
  }

  /**
   * @private
   */
  _dataSourceAdded(dataSourceCollection, dataSource) {
    const removers = this._entityCollectionChangedListenerRemovers;
    const entityCollection = dataSource.entities;
    const existingEntry = removers.get(entityCollection);
    if (defined(existingEntry)) {
      existingEntry.referenceCount++;
      return;
    }

    const removeListener = entityCollection.collectionChanged.addEventListener(
      Viewer.prototype._onEntityCollectionChanged,
      this,
    );
    removers.set(entityCollection, {
      removeListener,
      referenceCount: 1,
    });
  }

  /**
   * @private
   */
  _dataSourceRemoved(dataSourceCollection, dataSource) {
    const entityCollection = dataSource.entities;
    const removedFinalReference = removeDataSourceCollectionChangedListener(
      this,
      entityCollection,
    );

    if (removedFinalReference && defined(this.selectedEntity)) {
      if (
        entityCollection.getById(this.selectedEntity.id) === this.selectedEntity
      ) {
        this.selectedEntity = undefined;
      }
    }
  }

  /**
   * @private
   */
  _updateCanAnimate(that) {
    return function (isUpdated) {
      that._clockViewModel.canAnimate = isUpdated;
    };
  }

  /**
   * @private
   */
  _onTick(clock) {
    const time = clock.currentTime;

    let position;
    let enableCamera = false;
    const selectedEntity = this.selectedEntity;
    const showSelection =
      defined(selectedEntity) && this._enableInfoOrSelection;

    if (
      showSelection &&
      selectedEntity.isShowing &&
      selectedEntity.isAvailable(time)
    ) {
      const state = this._cesiumWidget.dataSourceDisplay.getBoundingSphere(
        selectedEntity,
        true,
        boundingSphereScratch,
      );
      if (state !== BoundingSphereState.FAILED) {
        position = boundingSphereScratch.center;
      } else if (defined(selectedEntity.position)) {
        position = selectedEntity.position.getValue(time, position);
      }
      enableCamera = defined(position);
    }

    const selectionIndicatorViewModel = defined(this._selectionIndicator)
      ? this._selectionIndicator.viewModel
      : undefined;
    if (defined(selectionIndicatorViewModel)) {
      selectionIndicatorViewModel.position = Cartesian3.clone(
        position,
        selectionIndicatorViewModel.position,
      );
      selectionIndicatorViewModel.showSelection = showSelection && enableCamera;
      selectionIndicatorViewModel.update();
    }

    const infoBoxViewModel = defined(this._infoBox)
      ? this._infoBox.viewModel
      : undefined;
    if (defined(infoBoxViewModel)) {
      infoBoxViewModel.showInfo = showSelection;
      infoBoxViewModel.enableCamera = enableCamera;
      infoBoxViewModel.isCameraTracking =
        this.trackedEntity === this.selectedEntity;

      if (showSelection) {
        infoBoxViewModel.titleText = selectedEntity.name ?? selectedEntity.id;
        infoBoxViewModel.description = Property.getValueOrDefault(
          selectedEntity.description,
          time,
          "",
        );
      } else {
        infoBoxViewModel.titleText = "";
        infoBoxViewModel.description = "";
      }
    }
  }

  /**
   * @private
   */
  _onEntityCollectionChanged(collection, added, removed) {
    const length = removed.length;
    for (let i = 0; i < length; i++) {
      const removedObject = removed[i];
      if (this.selectedEntity === removedObject) {
        this.selectedEntity = undefined;
      }
    }
  }

  /**
   * @private
   */
  _onInfoBoxCameraClicked(infoBoxViewModel) {
    if (
      infoBoxViewModel.isCameraTracking &&
      this.trackedEntity === this.selectedEntity
    ) {
      this.trackedEntity = undefined;
    } else {
      const selectedEntity = this.selectedEntity;
      const position = selectedEntity.position;
      if (defined(position)) {
        this.trackedEntity = this.selectedEntity;
      } else {
        this.zoomTo(this.selectedEntity);
      }
    }
  }

  /**
   * @private
   */
  _clearTrackedObject() {
    this.trackedEntity = undefined;
  }

  /**
   * @private
   */
  _onInfoBoxClockClicked(infoBoxViewModel) {
    this.selectedEntity = undefined;
  }

  /**
   * @private
   */
  _clearObjects() {
    this.trackedEntity = undefined;
    this.selectedEntity = undefined;
  }

  /**
   * @private
   */
  _onDataSourceChanged(dataSource) {
    if (this.clockTrackedDataSource === dataSource) {
      linkTimelineToDataSourceClock(this.timeline, dataSource);
    }
  }

  /**
   * @private
   */
  _onDataSourceAdded(dataSourceCollection, dataSource) {
    if (
      this._cesiumWidget._automaticallyTrackDataSourceClocks &&
      dataSource === this.clockTrackedDataSource
    ) {
      // When data sources are added to the CesiumWidget they may be automatically
      // tracked in that class but we also need to update the timeline in this class
      linkTimelineToDataSourceClock(this._timeline, dataSource);
    }
    const removalFunc = this._eventHelper.add(
      dataSource.changedEvent,
      Viewer.prototype._onDataSourceChanged,
      this,
    );
    this._dataSourceChangedListeners.set(dataSource, removalFunc);
  }

  /**
   * @private
   */
  _onDataSourceRemoved(dataSourceCollection, dataSource) {
    const removalFunc = this._dataSourceChangedListeners.get(dataSource);
    if (defined(removalFunc)) {
      removalFunc();
      this._dataSourceChangedListeners.delete(dataSource);
    }
  }

  /**
   * Asynchronously sets the camera to view the provided entity, entities, or data source.
   * If the data source is still in the process of loading or the visualization is otherwise still loading,
   * this method waits for the data to be ready before performing the zoom.
   *
   * <p>The offset is heading/pitch/range in the local east-north-up reference frame centered at the center of the bounding sphere.
   * The heading and the pitch angles are defined in the local east-north-up reference frame.
   * The heading is the angle from y axis and increasing towards the x axis. Pitch is the rotation from the xy-plane. Positive pitch
   * angles are above the plane. Negative pitch angles are below the plane. The range is the distance from the center. If the range is
   * zero, a range will be computed such that the whole bounding sphere is visible.</p>
   *
   * <p>In 2D, there must be a top down view. The camera will be placed above the target looking down. The height above the
   * target will be the range. The heading will be determined from the offset. If the heading cannot be
   * determined from the offset, the heading will be north.</p>
   *
   * @param {Entity|Entity[]|EntityCollection|DataSource|ImageryLayer|Cesium3DTileset|TimeDynamicPointCloud|Promise<Entity|Entity[]|EntityCollection|DataSource|ImageryLayer|Cesium3DTileset|TimeDynamicPointCloud|VoxelPrimitive|BufferPrimitiveCollection<BufferPrimitive>>} target The entity, array of entities, entity collection, data source, Cesium3DTileset, point cloud, or imagery layer to view. You can also pass a promise that resolves to one of the previously mentioned types.
   * @param {HeadingPitchRange} [offset] The offset from the center of the entity in the local east-north-up reference frame.
   * @returns {Promise<boolean>} A Promise that resolves to true if the zoom was successful or false if the target is not currently visualized in the scene or the zoom was cancelled.
   */
  zoomTo(target, offset) {
    return this._cesiumWidget.zoomTo(target, offset);
  }

  /**
   * Flies the camera to the provided entity, entities, or data source.
   * If the data source is still in the process of loading or the visualization is otherwise still loading,
   * this method waits for the data to be ready before performing the flight.
   *
   * <p>The offset is heading/pitch/range in the local east-north-up reference frame centered at the center of the bounding sphere.
   * The heading and the pitch angles are defined in the local east-north-up reference frame.
   * The heading is the angle from y axis and increasing towards the x axis. Pitch is the rotation from the xy-plane. Positive pitch
   * angles are above the plane. Negative pitch angles are below the plane. The range is the distance from the center. If the range is
   * zero, a range will be computed such that the whole bounding sphere is visible.</p>
   *
   * <p>In 2D, there must be a top down view. The camera will be placed above the target looking down. The height above the
   * target will be the range. The heading will be determined from the offset. If the heading cannot be
   * determined from the offset, the heading will be north.</p>
   *
   * @param {Entity|Entity[]|EntityCollection|DataSource|ImageryLayer|Cesium3DTileset|TimeDynamicPointCloud|Promise<Entity|Entity[]|EntityCollection|DataSource|ImageryLayer|Cesium3DTileset|TimeDynamicPointCloud|VoxelPrimitive|BufferPrimitiveCollection<BufferPrimitive>>} target The entity, array of entities, entity collection, data source, Cesium3DTileset, point cloud, or imagery layer to view. You can also pass a promise that resolves to one of the previously mentioned types.
   * @param {object} [options] Object with the following properties:
   * @param {number} [options.duration=3.0] The duration of the flight in seconds.
   * @param {number} [options.maximumHeight] The maximum height at the peak of the flight.
   * @param {HeadingPitchRange} [options.offset] The offset from the target in the local east-north-up reference frame centered at the target.
   * @returns {Promise<boolean>} A Promise that resolves to true if the flight was successful or false if the target is not currently visualized in the scene or the flight was cancelled. //TODO: Cleanup entity mentions
   */
  flyTo(target, options) {
    return this._cesiumWidget.flyTo(target, options);
  }

  /**
   * Gets the parent container.
   * @type {Element}
   * @readonly
   */
  get container() {
    return this._container;
  }

  /**
   * Manages the list of credits to display on screen and in the lightbox.
   *
   * @type {CreditDisplay}
   */
  get creditDisplay() {
    return this._cesiumWidget.creditDisplay;
  }

  /**
   * Gets the DOM element for the area at the bottom of the window containing the
   * {@link CreditDisplay} and potentially other things.
   * @type {Element}
   * @readonly
   */
  get bottomContainer() {
    return this._bottomContainer;
  }

  /**
   * Gets the CesiumWidget.
   * @type {CesiumWidget}
   * @readonly
   */
  get cesiumWidget() {
    return this._cesiumWidget;
  }

  /**
   * Gets the selection indicator.
   * @type {SelectionIndicator}
   * @readonly
   */
  get selectionIndicator() {
    return this._selectionIndicator;
  }

  /**
   * Gets the info box.
   * @type {InfoBox}
   * @readonly
   */
  get infoBox() {
    return this._infoBox;
  }

  /**
   * Gets the Geocoder.
   * @type {Geocoder}
   * @readonly
   */
  get geocoder() {
    return this._geocoder;
  }

  /**
   * Gets the HomeButton.
   * @type {HomeButton}
   * @readonly
   */
  get homeButton() {
    return this._homeButton;
  }

  /**
   * Gets the SceneModePicker.
   * @type {SceneModePicker}
   * @readonly
   */
  get sceneModePicker() {
    return this._sceneModePicker;
  }

  /**
   * Gets the ProjectionPicker.
   * @type {ProjectionPicker}
   * @readonly
   */
  get projectionPicker() {
    return this._projectionPicker;
  }

  /**
   * Gets the BaseLayerPicker.
   * @type {BaseLayerPicker}
   * @readonly
   */
  get baseLayerPicker() {
    return this._baseLayerPicker;
  }

  /**
   * Gets the NavigationHelpButton.
   * @type {NavigationHelpButton}
   * @readonly
   */
  get navigationHelpButton() {
    return this._navigationHelpButton;
  }

  /**
   * Gets the Animation widget.
   * @type {Animation}
   * @readonly
   */
  get animation() {
    return this._animation;
  }

  /**
   * Gets the Timeline widget.
   * @type {Timeline}
   * @readonly
   */
  get timeline() {
    return this._timeline;
  }

  /**
   * Gets the FullscreenButton.
   * @type {FullscreenButton}
   * @readonly
   */
  get fullscreenButton() {
    return this._fullscreenButton;
  }

  /**
   * Gets the VRButton.
   * @type {VRButton}
   * @readonly
   */
  get vrButton() {
    return this._vrButton;
  }

  /**
   * Gets the display used for {@link DataSource} visualization.
   * @type {DataSourceDisplay}
   * @readonly
   */
  get dataSourceDisplay() {
    return this._cesiumWidget.dataSourceDisplay;
  }

  /**
   * Gets the collection of entities not tied to a particular data source.
   * This is a shortcut to [dataSourceDisplay.defaultDataSource.entities]{@link Viewer#dataSourceDisplay}.
   * @type {EntityCollection}
   * @readonly
   */
  get entities() {
    return this._cesiumWidget.entities;
  }

  /**
   * Gets the set of {@link DataSource} instances to be visualized.
   * @type {DataSourceCollection}
   * @readonly
   */
  get dataSources() {
    return this._cesiumWidget.dataSources;
  }

  /**
   * Gets the canvas.
   * @type {HTMLCanvasElement}
   * @readonly
   */
  get canvas() {
    return this._cesiumWidget.canvas;
  }

  /**
   * Gets the scene.
   * @type {Scene}
   * @readonly
   */
  get scene() {
    return this._cesiumWidget.scene;
  }

  /**
   * Determines if shadows are cast by light sources.
   * @type {boolean}
   */
  get shadows() {
    return this.scene.shadowMap.enabled;
  }

  set shadows(value) {
    this.scene.shadowMap.enabled = value;
  }

  /**
   * Determines if the terrain casts or shadows from light sources.
   * @type {ShadowMode}
   */
  get terrainShadows() {
    return this.scene.globe.shadows;
  }

  set terrainShadows(value) {
    this.scene.globe.shadows = value;
  }

  /**
   * Get the scene's shadow map
   * @type {ShadowMap}
   * @readonly
   */
  get shadowMap() {
    return this.scene.shadowMap;
  }

  /**
   * Gets the collection of image layers that will be rendered on the globe.
   *
   * @type {ImageryLayerCollection}
   * @readonly
   */
  get imageryLayers() {
    return this.scene.imageryLayers;
  }

  /**
   * The terrain provider providing surface geometry for the globe.
   *
   * @type {TerrainProvider}
   */
  get terrainProvider() {
    return this.scene.terrainProvider;
  }

  set terrainProvider(terrainProvider) {
    this.scene.terrainProvider = terrainProvider;
  }

  /**
   * Gets the camera.
   *
   * @type {Camera}
   * @readonly
   */
  get camera() {
    return this.scene.camera;
  }

  /**
   * Gets the default ellipsoid for the scene.
   *
   * @type {Ellipsoid}
   * @default Ellipsoid.default
   * @readonly
   */
  get ellipsoid() {
    return this.scene.ellipsoid;
  }

  /**
   * Gets the post-process stages.
   *
   * @type {PostProcessStageCollection}
   * @readonly
   */
  get postProcessStages() {
    return this.scene.postProcessStages;
  }

  /**
   * Gets the clock.
   * @type {Clock}
   * @readonly
   */
  get clock() {
    return this._clockViewModel.clock;
  }

  /**
   * Gets the clock view model.
   * @type {ClockViewModel}
   * @readonly
   */
  get clockViewModel() {
    return this._clockViewModel;
  }

  /**
   * Gets the screen space event handler.
   * @type {ScreenSpaceEventHandler}
   * @readonly
   */
  get screenSpaceEventHandler() {
    return this._cesiumWidget.screenSpaceEventHandler;
  }

  /**
   * Gets or sets the target frame rate of the widget when <code>useDefaultRenderLoop</code>
   * is true. If undefined, the browser's requestAnimationFrame implementation
   * determines the frame rate.  If defined, this value must be greater than 0.  A value higher
   * than the underlying requestAnimationFrame implementation will have no effect.
   *
   * @type {number}
   */
  get targetFrameRate() {
    return this._cesiumWidget.targetFrameRate;
  }

  set targetFrameRate(value) {
    this._cesiumWidget.targetFrameRate = value;
  }

  /**
   * Gets or sets whether or not this widget should control the render loop.
   * If true the widget will use requestAnimationFrame to
   * perform rendering and resizing of the widget, as well as drive the
   * simulation clock. If set to false, you must manually call the
   * <code>resize</code>, <code>render</code> methods
   * as part of a custom render loop.  If an error occurs during rendering, {@link Scene}'s
   * <code>renderError</code> event will be raised and this property
   * will be set to false.  It must be set back to true to continue rendering
   * after the error.
   *
   * @type {boolean}
   */
  get useDefaultRenderLoop() {
    return this._cesiumWidget.useDefaultRenderLoop;
  }

  set useDefaultRenderLoop(value) {
    this._cesiumWidget.useDefaultRenderLoop = value;
  }

  /**
   * Gets or sets a scaling factor for rendering resolution.  Values less than 1.0 can improve
   * performance on less powerful devices while values greater than 1.0 will render at a higher
   * resolution and then scale down, resulting in improved visual fidelity.
   * For example, if the widget is laid out at a size of 640x480, setting this value to 0.5
   * will cause the scene to be rendered at 320x240 and then scaled up while setting
   * it to 2.0 will cause the scene to be rendered at 1280x960 and then scaled down.
   *
   * @type {number}
   * @default 1.0
   */
  get resolutionScale() {
    return this._cesiumWidget.resolutionScale;
  }

  set resolutionScale(value) {
    this._cesiumWidget.resolutionScale = value;
  }

  /**
   * Boolean flag indicating if the browser's recommended resolution is used.
   * If true, the browser's device pixel ratio is ignored and 1.0 is used instead,
   * effectively rendering based on CSS pixels instead of device pixels. This can improve
   * performance on less powerful devices that have high pixel density. When false, rendering
   * will be in device pixels. {@link Viewer#resolutionScale} will still take effect whether
   * this flag is true or false.
   *
   * @type {boolean}
   * @default true
   */
  get useBrowserRecommendedResolution() {
    return this._cesiumWidget.useBrowserRecommendedResolution;
  }

  set useBrowserRecommendedResolution(value) {
    this._cesiumWidget.useBrowserRecommendedResolution = value;
  }

  /**
   * Gets or sets whether or not data sources can temporarily pause
   * animation in order to avoid showing an incomplete picture to the user.
   * For example, if asynchronous primitives are being processed in the
   * background, the clock will not advance until the geometry is ready.
   *
   *
   * @type {boolean}
   */
  get allowDataSourcesToSuspendAnimation() {
    return this._cesiumWidget.allowDataSourcesToSuspendAnimation;
  }

  set allowDataSourcesToSuspendAnimation(value) {
    this._cesiumWidget.allowDataSourcesToSuspendAnimation = value;
  }

  /**
   * Gets or sets the Entity instance currently being tracked by the camera.
   * @type {Entity | undefined}
   */
  get trackedEntity() {
    return this._cesiumWidget.trackedEntity;
  }

  set trackedEntity(value) {
    this._cesiumWidget.trackedEntity = value;
  }

  /**
   * Gets or sets the object instance for which to display a selection indicator.
   *
   * If a user interactively picks a Cesium3DTilesFeature instance, then this property
   * will contain a transient Entity instance with a property named "feature" that is
   * the instance that was picked.
   * @type {Entity | undefined}
   */
  get selectedEntity() {
    return this._selectedEntity;
  }

  set selectedEntity(value) {
    if (this._selectedEntity !== value) {
      this._selectedEntity = value;
      const selectionIndicatorViewModel = defined(this._selectionIndicator)
        ? this._selectionIndicator.viewModel
        : undefined;
      if (defined(value)) {
        if (defined(selectionIndicatorViewModel)) {
          selectionIndicatorViewModel.animateAppear();
        }
      } else if (defined(selectionIndicatorViewModel)) {
        // Leave the info text in place here, it is needed during the exit animation.
        selectionIndicatorViewModel.animateDepart();
      }
      this._selectedEntityChanged.raiseEvent(value);
    }
  }

  /**
   * Gets the event that is raised when the selected entity changes.
   * @type {Event}
   * @readonly
   */
  get selectedEntityChanged() {
    return this._selectedEntityChanged;
  }

  /**
   * Gets the event that is raised when the tracked entity changes.
   * @type {Event}
   * @readonly
   */
  get trackedEntityChanged() {
    return this._cesiumWidget.trackedEntityChanged;
  }

  /**
   * Gets or sets the data source to track with the viewer's clock.
   * @type {DataSource}
   */
  get clockTrackedDataSource() {
    return this._cesiumWidget.clockTrackedDataSource;
  }

  set clockTrackedDataSource(value) {
    if (this._cesiumWidget.clockTrackedDataSource !== value) {
      this._cesiumWidget.clockTrackedDataSource = value;
      linkTimelineToDataSourceClock(this._timeline, value);
    }
  }
}

/**
 * Creates a Viewer asynchronously with support for WebGPU renderer initialization.
 *
 * The container receives exactly the elements the synchronous constructor
 * creates, and receives them at the same point: nothing is added while the
 * graphics context is being acquired. An application that wants to show
 * progress owns that presentation and drives it from <code>onProgress</code>,
 * which reports the same milestones as {@link CesiumWidget.createAsync}.
 *
 * @param {Element|string} container The DOM element or ID that will contain the viewer.
 * @param {Viewer.ConstructorOptions} [options] Same options as Viewer constructor.
 *   Include `contextOptions: { renderer: 'webgpu' }` to enable WebGPU.
 * @param {Function} [onProgress] Optional callback for loading progress (0-100).
 *   Signature: function(progress: number, status: string)
 * @returns {Promise<Viewer>} Promise that resolves to the initialized Viewer.
 *
 * @example
 * const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
 *   contextOptions: { renderer: "webgpu" }
 * });
 */
Viewer.createAsync = async function (container, options, onProgress) {
  options = options ?? {};
  const containerEl = getElement(container);
  let transaction;
  let viewer;

  try {
    transaction = await CesiumWidget._createAsyncContext(
      containerEl,
      options,
      onProgress,
    );

    viewer = new Viewer(container, {
      ...options,
      _preInitializedCanvas: transaction.canvas,
      _preInitializedContext: transaction.context,
      _contextCreationDiagnostics: transaction.diagnostics,
      _countContextReferences: transaction.countReferences,
    });

    if (defined(onProgress)) {
      onProgress(100, "Ready");
    }

    return viewer;
  } catch (error) {
    runViewerCleanupStep(function () {
      if (defined(viewer) && !viewer.isDestroyed()) {
        viewer.destroy();
      }
    });
    runViewerCleanupStep(function () {
      destroyViewerContextIfLive(transaction?.context);
    });
    throw error;
  }
};

/**
 * A function that augments a Viewer instance with additional functionality.
 * @callback Viewer.ViewerMixin
 * @param {Viewer} viewer The viewer instance.
 * @param {object} options Options object to be passed to the mixin function.
 *
 * @see Viewer#extend
 */
export default Viewer;
