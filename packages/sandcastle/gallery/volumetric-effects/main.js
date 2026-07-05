import * as Cesium from "cesium";

// Cesium WebGPU fork — volumetric atmospheric stack demo.
//
// Phase 5a-5d (already shipped) wires a Frostbite-style froxel
// grid: per-froxel height-fog density + Henyey-Greenstein sun
// scattering + sun-shadow-map god rays + 3D-noise varying
// density. Toggle on via the canonical
// `atmosphericConditions.volumetricFog.enabled` API.
//
// Phase 6 main path (also shipped) is a Schneider-style
// volumetric raymarcher (HG dual-lobe phase + Beer-Powder
// lighting + 3D FBM density + per-step light marching). Toggle
// via `atmosphericConditions.clouds.enableVolumetric` (Batch 43)
// or the legacy `globe.defaultCloudCollection.enableVolumetric`.
//
// Phase 6c (Batch 44) couples the two: clouds cast soft
// shadows into the fog grid, so the god rays from the sun-
// shadow-map term get further attenuated by overhead cloud
// density. The cheap one-sample-along-sun approximation costs
// ~1 fbm sample per froxel.
//
// Default off so the demo opens cheaply on integrated GPUs;
// tick the boxes to see each layer add to the scene.
// Runs on either backend; volumetric fog + clouds only have
// visible effect on WebGPU (the toggles are silent no-ops on
// WebGL). To force a backend, pass
// `contextOptions: { renderer: "webgpu" }` here.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  shouldAnimate: true,
});

const scene = viewer.scene;
const globe = scene.globe;
const ac = globe.atmosphericConditions;

// Park the camera on a ridge looking across a valley so the
// sun-side terrain casts long shadow shafts when the volumetric
// fog god-ray pass kicks in. Mt. Hood faces roughly south at
// this position; pitch -20° keeps the horizon visible so the
// cloud layer + fog interact in the same frame.
viewer.scene.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-121.6875, 45.2735, 6000),
  orientation: {
    heading: Cesium.Math.toRadians(15),
    pitch: Cesium.Math.toRadians(-20),
    roll: 0,
  },
});

// Hand-set clock so the sun stays in a sweet spot for shadow
// shafts. The slider below lets the user rotate it through
// the day.
const baseTime = Cesium.JulianDate.fromIso8601("2026-06-21T17:30:00Z");
viewer.clock.startTime = baseTime.clone();
viewer.clock.currentTime = baseTime.clone();
viewer.clock.multiplier = 0;

// Volumetric cloud layer parameters — match the typical
// Schneider preset so the renderer's defaults produce a
// visible cloud band 1.5-4 km up.
globe.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
globe.defaultCloudCollection.volumetric.cloudLayerTop = 4000;
globe.defaultCloudCollection.volumetric.cloudCoverage = 0.4;
globe.defaultCloudCollection.volumetric.cloudDensity = 0.4;

const viewModel = {
  fogEnabled: false,
  cloudsEnabled: false,
  cloudCoverage: 0.4,
  fogDensity: 1.5,
  fogMaxKm: 30,
  sunElev: 25,
};
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

function syncFog() {
  ac.volumetricFog.enabled = viewModel.fogEnabled;
  ac.volumetricFog.density = parseFloat(viewModel.fogDensity);
  ac.volumetricFog.maxDistance = parseFloat(viewModel.fogMaxKm) * 1000;
}
function syncClouds() {
  // Aliases since Batch 43 — both setters route to the same
  // underlying `globe.defaultCloudCollection.enableVolumetric` flag.
  ac.clouds.enableVolumetric = viewModel.cloudsEnabled;
  globe.defaultCloudCollection.volumetric.cloudCoverage = parseFloat(
    viewModel.cloudCoverage,
  );
}
function syncSun() {
  // Approximate: rotate JulianDate forward to push the sun
  // toward the requested elevation. 4° elevation ≈ 16 minutes
  // of real time at this latitude/season.
  const minutes = (parseFloat(viewModel.sunElev) - 25) * 4;
  const t = Cesium.JulianDate.addMinutes(
    baseTime,
    minutes,
    new Cesium.JulianDate(),
  );
  viewer.clock.currentTime = t;
}

Cesium.knockout.getObservable(viewModel, "fogEnabled").subscribe(syncFog);
Cesium.knockout.getObservable(viewModel, "cloudsEnabled").subscribe(syncClouds);
Cesium.knockout.getObservable(viewModel, "cloudCoverage").subscribe(syncClouds);
Cesium.knockout.getObservable(viewModel, "fogDensity").subscribe(syncFog);
Cesium.knockout.getObservable(viewModel, "fogMaxKm").subscribe(syncFog);
Cesium.knockout.getObservable(viewModel, "sunElev").subscribe(syncSun);

syncFog();
syncClouds();
syncSun();
