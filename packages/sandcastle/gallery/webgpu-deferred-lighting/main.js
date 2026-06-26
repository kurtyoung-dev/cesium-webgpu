import * as Cesium from "cesium";

// Force WebGPU — deferred lighting is a WebGPU-only path.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const scene = viewer.scene;

const viewModel = {
  deferredEnabled: false,
  ssaoEnabled: true,
  showGBufferNormals: false,
};

function applyConfig() {
  scene.deferredLighting = Boolean(viewModel.deferredEnabled);

  // SSAO toggle — note that pre-Phase-8a SSAO already worked
  // by reconstructing normals from depth derivatives. With
  // deferred lighting on, the same SSAO reads from the
  // G-buffer for cleaner normals at silhouettes (Slice 4).
  if (scene.postProcessStages?.ambientOcclusion) {
    scene.postProcessStages.ambientOcclusion.enabled = Boolean(
      viewModel.ssaoEnabled,
    );
  }

  // Debug overlay — `CesiumDebug.showGBufferNormals()` is the
  // canonical API. When ON, it auto-enables deferred lighting
  // (the overlay needs the G-buffer populated). We mirror
  // that here so the checkboxes stay coherent.
  if (viewModel.showGBufferNormals && window.CesiumDebug) {
    window.CesiumDebug.showGBufferNormals();
    // Also reflect the auto-enable back in the model.
    viewModel.deferredEnabled = true;
    Cesium.knockout
      .getObservable(viewModel, "deferredEnabled")
      .valueHasMutated();
  } else if (window.CesiumDebug) {
    window.CesiumDebug.hideGBufferNormals();
  }

  scene.requestRender();
}

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
for (const name in viewModel) {
  if (Object.prototype.hasOwnProperty.call(viewModel, name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(applyConfig);
  }
}
applyConfig();

// A close-camera coastal view — the globe horizon + ground
// detail produce clear silhouette edges where Slice 3's
// forward/backward-difference normals visibly improve over
// the consumer's depth-only reconstruction.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 150_000),
  orientation: {
    heading: Cesium.Math.toRadians(0),
    pitch: Cesium.Math.toRadians(-25),
  },
});
