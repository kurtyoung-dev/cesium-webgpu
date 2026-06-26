import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const viewModel = {
  enabled: true,
  weatherType: "0",
  intensity: 0.5,
  windSpeed: 10,
};

function applyWeather() {
  const scene = viewer.scene;
  scene.enableWeather = Boolean(viewModel.enabled);
  scene.weatherType = parseInt(viewModel.weatherType, 10);
  scene.weatherIntensity = Number(viewModel.intensity);
  scene.weatherWindSpeed = Number(viewModel.windSpeed);
  scene.requestRender();
}

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
for (const name in viewModel) {
  if (Object.prototype.hasOwnProperty.call(viewModel, name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(applyWeather);
  }
}
applyWeather();

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-122.4, 37.78, 5000),
  orientation: {
    heading: Cesium.Math.toRadians(0),
    pitch: Cesium.Math.toRadians(-20),
  },
});
