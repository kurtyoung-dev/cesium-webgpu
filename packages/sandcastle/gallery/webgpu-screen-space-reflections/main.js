import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const viewModel = {
  enabled: true,
  maxDistance: 50,
  thickness: 0.5,
  maxSteps: 64,
  stride: 2.0,
  reflectionStrength: 0.5,
};

function applySSR() {
  const scene = viewer.scene;
  scene.enableSSR = Boolean(viewModel.enabled);
  scene.ssrMaxDistance = Number(viewModel.maxDistance);
  scene.ssrThickness = Number(viewModel.thickness);
  scene.ssrMaxSteps = Math.round(Number(viewModel.maxSteps));
  scene.ssrStride = Number(viewModel.stride);
  scene.ssrReflectionStrength = Number(viewModel.reflectionStrength);
  scene.requestRender();
}

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
for (const name in viewModel) {
  if (Object.prototype.hasOwnProperty.call(viewModel, name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(applySSR);
  }
}
applySSR();

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-122.4, 37.78, 1500),
  orientation: {
    heading: Cesium.Math.toRadians(0),
    pitch: Cesium.Math.toRadians(-25),
  },
});
