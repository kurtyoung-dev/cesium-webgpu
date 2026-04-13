window.CESIUM_BASE_URL = window.CESIUM_BASE_URL
  ? window.CESIUM_BASE_URL
  : "../../Build/CesiumUnminified/";

import {
  Cartesian3,
  defined,
  formatError,
  Math as CesiumMath,
  objectToQuery,
  queryToObject,
  CzmlDataSource,
  GeoJsonDataSource,
  ImageryLayer,
  KmlDataSource,
  GpxDataSource,
  Terrain,
  TileMapServiceImageryProvider,
  Viewer,
  viewerCesiumInspectorMixin,
  viewerDragDropMixin,
  CesiumDebug,
} from "../../Build/CesiumUnminified/index.js";

// ---- State ----
let currentMode = "webgl"; // 'webgl' | 'webgpu' | 'split'
let showFps = false;
let webglViewer = null;
let webgpuViewer = null;

const endUserOptions = queryToObject(window.location.search.substring(1));

// Parse initial mode from query string
if (endUserOptions.renderer === "webgpu") {
  currentMode = "webgpu";
} else if (endUserOptions.renderer === "split") {
  currentMode = "split";
}
if (endUserOptions.stats) {
  showFps = true;
}

// ---- Viewer Creation Helpers ----

function getCommonOptions() {
  let baseLayer;
  if (defined(endUserOptions.tmsImageryUrl)) {
    baseLayer = ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(endUserOptions.tmsImageryUrl),
    );
  }
  const hasBaseLayerPicker = !defined(baseLayer);
  const terrain = Terrain.fromWorldTerrain({
    requestWaterMask: true,
    requestVertexNormals: true,
  });

  return {
    baseLayer,
    hasBaseLayerPicker,
    terrain,
    scene3DOnly: endUserOptions.scene3DOnly,
    requestRenderMode: true,
  };
}

function createWebGLViewer(container) {
  const opts = getCommonOptions();
  const viewer = new Viewer(container, {
    baseLayer: opts.baseLayer,
    baseLayerPicker: opts.hasBaseLayerPicker,
    scene3DOnly: opts.scene3DOnly,
    requestRenderMode: opts.requestRenderMode,
    terrain: opts.terrain,
  });

  if (opts.hasBaseLayerPicker) {
    const viewModel = viewer.baseLayerPicker.viewModel;
    viewModel.selectedTerrain = viewModel.terrainProviderViewModels[1];
  }

  if (showFps) {
    viewer.scene.debugShowFramesPerSecond = true;
  }

  return viewer;
}

async function createWebGPUViewer(container) {
  const opts = getCommonOptions();
  const viewer = await Viewer.createAsync(container, {
    baseLayer: opts.baseLayer,
    baseLayerPicker: opts.hasBaseLayerPicker,
    scene3DOnly: opts.scene3DOnly,
    requestRenderMode: opts.requestRenderMode,
    terrain: opts.terrain,
    contextOptions: { renderer: "webgpu" },
  });

  if (opts.hasBaseLayerPicker) {
    const viewModel = viewer.baseLayerPicker.viewModel;
    viewModel.selectedTerrain = viewModel.terrainProviderViewModels[1];
  }

  if (showFps) {
    viewer.scene.debugShowFramesPerSecond = true;
  }

  return viewer;
}

function setupViewer(viewer) {
  viewer.extend(viewerDragDropMixin);
  if (endUserOptions.inspector) {
    viewer.extend(viewerCesiumInspectorMixin);
  }

  const scene = viewer.scene;
  const context = scene.context;
  if (endUserOptions.debug) {
    context.validateShaderProgram = true;
    context.validateFramebuffer = true;
    context.logShaderCompilation = true;
    context.throwOnWebGLError = true;
  }

  viewer.dropError.addEventListener(function (viewerArg, name, error) {
    const title = `An error occurred while loading the file: ${name}`;
    const message =
      "An error occurred while loading the file, which may indicate that it is invalid.  A detailed error report is below:";
    viewer.cesiumWidget.showErrorPanel(title, message, error);
  });
}

function applyViewSettings(viewer) {
  const view = endUserOptions.view;
  if (defined(view)) {
    const splitQuery = view.split(/[ ,]+/);
    if (splitQuery.length > 1) {
      const longitude = !isNaN(+splitQuery[0]) ? +splitQuery[0] : 0.0;
      const latitude = !isNaN(+splitQuery[1]) ? +splitQuery[1] : 0.0;
      const height =
        splitQuery.length > 2 && !isNaN(+splitQuery[2])
          ? +splitQuery[2]
          : 300.0;
      const heading =
        splitQuery.length > 3 && !isNaN(+splitQuery[3])
          ? CesiumMath.toRadians(+splitQuery[3])
          : undefined;
      const pitch =
        splitQuery.length > 4 && !isNaN(+splitQuery[4])
          ? CesiumMath.toRadians(+splitQuery[4])
          : undefined;
      const roll =
        splitQuery.length > 5 && !isNaN(+splitQuery[5])
          ? CesiumMath.toRadians(+splitQuery[5])
          : undefined;

      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(longitude, latitude, height),
        orientation: { heading, pitch, roll },
      });
    }
  }
}

// ---- DOM Management ----

function destroyAllViewers() {
  if (webglViewer && !webglViewer.isDestroyed()) {
    webglViewer.destroy();
  }
  webglViewer = null;

  if (webgpuViewer && !webgpuViewer.isDestroyed()) {
    webgpuViewer.destroy();
  }
  webgpuViewer = null;
}

function resetContainers() {
  // Remove split containers if they exist
  const splitContainer = document.getElementById("splitContainer");
  if (splitContainer) {
    splitContainer.remove();
  }

  // Ensure main cesiumContainer exists and is visible
  let container = document.getElementById("cesiumContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "cesiumContainer";
    container.className = "fullWindow";
    document.body.insertBefore(
      container,
      document.getElementById("loadingIndicator"),
    );
  }
  container.style.display = "";
  container.innerHTML = "";
}

function createSplitContainers() {
  // Hide main container
  const mainContainer = document.getElementById("cesiumContainer");
  if (mainContainer) {
    mainContainer.style.display = "none";
  }

  // Create split layout
  const splitContainer = document.createElement("div");
  splitContainer.id = "splitContainer";
  splitContainer.className = "split-container";

  const leftPane = document.createElement("div");
  leftPane.className = "split-pane";
  const leftLabel = document.createElement("div");
  leftLabel.className = "split-label";
  leftLabel.textContent = "WebGL";
  const leftViewer = document.createElement("div");
  leftViewer.id = "cesiumContainerLeft";
  leftViewer.style.cssText = "width: 100%; height: 100%;";
  leftPane.appendChild(leftLabel);
  leftPane.appendChild(leftViewer);

  const divider = document.createElement("div");
  divider.className = "split-divider";

  const rightPane = document.createElement("div");
  rightPane.className = "split-pane";
  const rightLabel = document.createElement("div");
  rightLabel.className = "split-label";
  rightLabel.textContent = "WebGPU";
  const rightViewer = document.createElement("div");
  rightViewer.id = "cesiumContainerRight";
  rightViewer.style.cssText = "width: 100%; height: 100%;";
  rightPane.appendChild(rightLabel);
  rightPane.appendChild(rightViewer);

  splitContainer.appendChild(leftPane);
  splitContainer.appendChild(divider);
  splitContainer.appendChild(rightPane);

  document.body.insertBefore(
    splitContainer,
    document.getElementById("loadingIndicator"),
  );
}

// ---- UI Button State ----

function updateButtonState(mode) {
  document
    .getElementById("btnWebGL")
    .classList.toggle("active", mode === "webgl");
  document
    .getElementById("btnWebGPU")
    .classList.toggle("active", mode === "webgpu");
  document
    .getElementById("btnSplit")
    .classList.toggle("active", mode === "split");
}

// ---- Global Switch Functions (called from HTML onclick) ----

window.switchRenderer = async function (mode) {
  if (mode === currentMode) {
    return;
  }
  currentMode = mode;
  updateButtonState(mode);

  const loadingIndicator = document.getElementById("loadingIndicator");
  loadingIndicator.style.display = "";

  destroyAllViewers();

  try {
    if (mode === "webgl") {
      resetContainers();
      webglViewer = createWebGLViewer("cesiumContainer");
      setupViewer(webglViewer);
      applyViewSettings(webglViewer);
    } else if (mode === "webgpu") {
      resetContainers();
      webgpuViewer = await createWebGPUViewer("cesiumContainer");
      window.viewer = webgpuViewer;
      CesiumDebug(webgpuViewer);
      setupViewer(webgpuViewer);
      applyViewSettings(webgpuViewer);
    } else if (mode === "split") {
      resetContainers();
      createSplitContainers();

      webglViewer = createWebGLViewer("cesiumContainerLeft");
      setupViewer(webglViewer);
      applyViewSettings(webglViewer);

      try {
        webgpuViewer = await createWebGPUViewer("cesiumContainerRight");
        setupViewer(webgpuViewer);
        applyViewSettings(webgpuViewer);
        syncCameras(webglViewer, webgpuViewer);
      } catch (e) {
        console.error("WebGPU viewer failed to create:", e.message);
      }
    }
  } catch (exception) {
    const message = formatError(exception);
    console.error(message);
    if (!document.querySelector(".cesium-widget-errorPanel")) {
      //eslint-disable-next-line no-alert
      window.alert(message);
    }
  }

  loadingIndicator.style.display = "none";
};

window.toggleFps = function (enabled) {
  showFps = enabled;
  if (webglViewer && !webglViewer.isDestroyed()) {
    webglViewer.scene.debugShowFramesPerSecond = enabled;
  }
  if (webgpuViewer && !webgpuViewer.isDestroyed()) {
    webgpuViewer.scene.debugShowFramesPerSecond = enabled;
  }
};

// ---- Main ----

async function main() {
  const loadingIndicator = document.getElementById("loadingIndicator");

  // Set initial UI state
  updateButtonState(currentMode);
  document.getElementById("fpsToggle").checked = showFps;

  try {
    if (currentMode === "webgl") {
      webglViewer = createWebGLViewer("cesiumContainer");
      setupViewer(webglViewer);
      applyViewSettings(webglViewer);
      setupCameraSave(webglViewer);
    } else if (currentMode === "webgpu") {
      webgpuViewer = await createWebGPUViewer("cesiumContainer");
      setupViewer(webgpuViewer);
      applyViewSettings(webgpuViewer);
      setupCameraSave(webgpuViewer);
    } else if (currentMode === "split") {
      // Hide main container and create split
      document.getElementById("cesiumContainer").style.display = "none";
      createSplitContainers();

      webglViewer = createWebGLViewer("cesiumContainerLeft");
      setupViewer(webglViewer);
      applyViewSettings(webglViewer);
      setupCameraSave(webglViewer);

      try {
        webgpuViewer = await createWebGPUViewer("cesiumContainerRight");
        setupViewer(webgpuViewer);
        applyViewSettings(webgpuViewer);
        syncCameras(webglViewer, webgpuViewer);
      } catch (e) {
        console.error("WebGPU viewer failed to create:", e.message);
      }
    }

    // Load data sources if specified
    const activeViewer = webglViewer || webgpuViewer;
    if (activeViewer) {
      await loadDataSources(activeViewer);
      applyTheme(activeViewer);
    }
  } catch (exception) {
    loadingIndicator.style.display = "none";
    const message = formatError(exception);
    console.error(message);
    if (!document.querySelector(".cesium-widget-errorPanel")) {
      //eslint-disable-next-line no-alert
      window.alert(message);
    }
    return;
  }

  loadingIndicator.style.display = "none";
}

async function loadDataSources(viewer) {
  const source = endUserOptions.source;
  const view = endUserOptions.view;
  if (!defined(source)) {
    return;
  }

  let sourceType = endUserOptions.sourceType;
  if (!defined(sourceType)) {
    if (/\.czml$/i.test(source)) {
      sourceType = "czml";
    } else if (
      /\.geojson$/i.test(source) ||
      /\.json$/i.test(source) ||
      /\.topojson$/i.test(source)
    ) {
      sourceType = "geojson";
    } else if (/\.kml$/i.test(source) || /\.kmz$/i.test(source)) {
      sourceType = "kml";
    } else if (/\.gpx$/i.test(source)) {
      sourceType = "gpx";
    }
  }

  let loadPromise;
  if (sourceType === "czml") {
    loadPromise = CzmlDataSource.load(source);
  } else if (sourceType === "geojson") {
    loadPromise = GeoJsonDataSource.load(source);
  } else if (sourceType === "kml") {
    loadPromise = KmlDataSource.load(source, {
      camera: viewer.scene.camera,
      canvas: viewer.scene.canvas,
      screenOverlayContainer: viewer.container,
    });
  } else if (sourceType === "gpx") {
    loadPromise = GpxDataSource.load(source);
  }

  if (defined(loadPromise)) {
    try {
      const dataSource = await viewer.dataSources.add(loadPromise);
      const lookAt = endUserOptions.lookAt;
      if (defined(lookAt)) {
        const entity = dataSource.entities.getById(lookAt);
        if (defined(entity)) {
          viewer.trackedEntity = entity;
        }
      } else if (!defined(view) && endUserOptions.flyTo !== "false") {
        viewer.flyTo(dataSource);
      }
    } catch (error) {
      const title = `An error occurred while loading the file: ${source}`;
      viewer.cesiumWidget.showErrorPanel(title, "", error);
    }
  }
}

function applyTheme(viewer) {
  const theme = endUserOptions.theme;
  if (defined(theme)) {
    if (theme === "lighter") {
      document.body.classList.add("cesium-lighter");
      viewer.animation.applyThemeChanges();
    }
  }
}

// ---- Split-Screen Camera Sync ----

let _syncActive = false;

function syncCameras(viewerA, viewerB) {
  if (!viewerA || !viewerB) {
    return;
  }

  function copyCamera(src, dst) {
    if (_syncActive) {
      return;
    }
    _syncActive = true;
    try {
      const srcCam = src.camera;
      const dstCam = dst.camera;
      dstCam.position = Cartesian3.clone(srcCam.position);
      dstCam.direction = Cartesian3.clone(srcCam.direction);
      dstCam.up = Cartesian3.clone(srcCam.up);
      dstCam.right = Cartesian3.clone(srcCam.right);
      dst.scene.requestRender();
    } finally {
      _syncActive = false;
    }
  }

  viewerA.camera.changed.addEventListener(() => copyCamera(viewerA, viewerB));
  viewerB.camera.changed.addEventListener(() => copyCamera(viewerB, viewerA));
  // Set percentage threshold low so sync is responsive
  viewerA.camera.percentageChanged = 0.001;
  viewerB.camera.percentageChanged = 0.001;

  // Force initial camera sync A→B and trigger first render of both
  copyCamera(viewerA, viewerB);
  viewerA.scene.requestRender();
}

function setupCameraSave(viewer) {
  if (endUserOptions.saveCamera === "false") {
    return;
  }

  const camera = viewer.camera;
  let timeout;
  camera.changed.addEventListener(function () {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(function () {
      const position = camera.positionCartographic;
      let hpr = "";
      if (defined(camera.heading)) {
        hpr = `,${CesiumMath.toDegrees(camera.heading)},${CesiumMath.toDegrees(
          camera.pitch,
        )},${CesiumMath.toDegrees(camera.roll)}`;
      }
      endUserOptions.view = `${CesiumMath.toDegrees(
        position.longitude,
      )},${CesiumMath.toDegrees(position.latitude)},${position.height}${hpr}`;
      history.replaceState(undefined, "", `?${objectToQuery(endUserOptions)}`);
    }, 1000);
  });
}

main();
