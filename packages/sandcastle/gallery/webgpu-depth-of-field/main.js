import * as Cesium from "cesium";

// Force the WebGPU backend so this demo always exercises the
// WebGPU PostProcess pipeline + DoF wiring landed in Batch 98.
// (Without this, the AUTO renderer might pick WebGL and the
// demo would silently route through the upstream GL path.)
const viewer = new Cesium.Viewer("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

// Place a row of balloons at varying near-camera distances so
// the focal-distance slider sweeps through them visibly.
function createModel(url, x, y, height) {
  const position = Cesium.Cartesian3.fromDegrees(x, y, height);
  viewer.entities.add({
    name: url,
    position: position,
    model: { uri: url },
  });
}

const numberOfBalloons = 13;
const lonIncrement = 0.00025;
const initialLon = -122.99875;
const lat = 44.0503706;
const height = 100.0;
const url = "../../SampleData/models/CesiumBalloon/CesiumBalloon.glb";
for (let i = 0; i < numberOfBalloons; ++i) {
  createModel(url, initialLon + i * lonIncrement, lat, height);
}

// Build the DoF composite via the upstream library and add it
// to the collection — the WebGPU side (Batch 98) detects it by
// the well-known name `czm_depth_of_field` and routes to its
// native WebGPU DoF effect (WebGPUDepthOfFieldEffect.ts).
const dof = Cesium.PostProcessStageLibrary.createDepthOfFieldStage();
viewer.scene.postProcessStages.add(dof);

const viewModel = {
  show: true,
  focalDistance: 50.0,
  delta: 1.0,
  sigma: 3.78,
};

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
for (const name in viewModel) {
  if (viewModel.hasOwnProperty(name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(updatePostProcess);
  }
}

function updatePostProcess() {
  dof.enabled = Boolean(viewModel.show);
  dof.uniforms.focalDistance = Number(viewModel.focalDistance);
  dof.uniforms.delta = Number(viewModel.delta);
  dof.uniforms.sigma = Number(viewModel.sigma);
}
updatePostProcess();

// Aim the camera at the first balloon with a small offset so
// foreground / mid / background separation is visible — the
// focal-distance slider then sweeps the focus plane through
// the row, with near and far balloons getting blurred.
const target = Cesium.Cartesian3.fromDegrees(
  initialLon + lonIncrement,
  lat,
  height + 7.5,
);
const offset = new Cesium.Cartesian3(
  -37.048378684557974,
  -24.852967044804245,
  4.352023653686047,
);
viewer.scene.camera.lookAt(target, offset);
