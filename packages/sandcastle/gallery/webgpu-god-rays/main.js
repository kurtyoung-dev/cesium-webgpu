import * as Cesium from "cesium";

// Force WebGPU — God Rays is a WebGPU-only effect today.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const viewModel = {
  enabled: true,
  density: 0.96,
  decay: 0.95,
  weight: 0.5,
  exposure: 0.15,
  sampleCount: 64,
};

function applyConfig() {
  viewer.scene.godRayEnabled = Boolean(viewModel.enabled);
  viewer.scene.godRayConfig = {
    density: Number(viewModel.density),
    decay: Number(viewModel.decay),
    weight: Number(viewModel.weight),
    exposure: Number(viewModel.exposure),
    sampleCount: Math.round(Number(viewModel.sampleCount)),
  };
  viewer.scene.requestRender();
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

// Position the camera so the sun is just above the horizon —
// god rays are most visible when the sun is near the edge of
// the visible region casting toward darker geometry.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 8000),
  orientation: {
    heading: Cesium.Math.toRadians(180),
    pitch: Cesium.Math.toRadians(-15),
  },
});
