import * as Cesium from "cesium";

// Cesium WebGPU fork — AtmosphericConditions weather inputs.
//
// The canonical `scene.globe.atmosphericConditions.*` API
// (Phase 0, 2026-04-09) groups every weather / atmosphere /
// cloud / lighting toggle under one nested object. Phase 4
// (Batches 29 + 42) wired the .weather leaf to actual
// renderer state:
//
//   - humidity      → fog density × (1 + (h-0.5))
//                   AND atmosphere Mie coefficient × (0.5 + h)
//   - airQuality    → atmosphere Rayleigh coefficient × 1/airQuality
//                   (low = polluted/red sky; high = clean/blue)
//   - cloudCover    → star occlusion factor in cubemap panorama
//                   AND drives the volumetric cloud layer's
//                     coverage threshold
//   - windSpeed,
//     windDirection → SkyAtmosphere UBO scaffold for Phase 5
//                     fog advection / Phase 6 cloud motion
//
// The full leaf is documented in
//   migration_doc/CELESTIAL_ATMOSPHERE_DESIGN.md § 4.5.
// Runs on either backend. The `atmosphericConditions.weather.*`
// setters are no-ops on WebGL (the GLSL path doesn't sample the
// matching uniforms); on WebGPU each slider drives a real
// shader uniform per Phases 4 + 6. To force a backend, pass
// `contextOptions: { renderer: "webgpu" }` here.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),
  shouldAnimate: true,
});

const scene = viewer.scene;
const globe = scene.globe;
const ac = globe.atmosphericConditions;

// A high-altitude orbit view so the sky-atmosphere limb halo
// is visible — that's where humidity (Mie) and air quality
// (Rayleigh) shifts read clearly. Pittsburgh roughly
// because the default view rectangle is centered there.
viewer.scene.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-80, 35, 4_500_000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-90),
    roll: 0,
  },
});

// Enable the volumetric cloud layer so cloudCover has a
// visible effect (otherwise it only modulates star occlusion).
ac.clouds.enableVolumetric = true;
globe.defaultCloudCollection.volumetric.cloudLayerBottom = 1500;
globe.defaultCloudCollection.volumetric.cloudLayerTop = 4000;

const viewModel = {
  humidity: 0.5,
  airQuality: 1.0,
  cloudCover: 0.4,
  windSpeed: 5,
  windHeading: 0,
};
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

function syncWeather() {
  const h = parseFloat(viewModel.humidity);
  const aq = parseFloat(viewModel.airQuality);
  const cc = parseFloat(viewModel.cloudCover);
  const ws = parseFloat(viewModel.windSpeed);
  const wh = Cesium.Math.toRadians(parseFloat(viewModel.windHeading));
  ac.weather.humidity = h;
  ac.weather.airQuality = aq;
  ac.weather.cloudCover = cc;
  ac.weather.windSpeed = ws;
  // Direction lives on the local tangent plane: X = east, Z =
  // north (the volumetric fog + cloud renderers project this
  // onto the camera-local horizontal plane).
  ac.weather.windDirection = new Cesium.Cartesian3(
    Math.cos(wh),
    0,
    Math.sin(wh),
  );
  // Cloud cover also drives the visible cloud layer's
  // coverage threshold so the sliders produce a perceptible
  // shape change in addition to the star-occlusion effect.
  globe.defaultCloudCollection.volumetric.cloudCoverage = cc;
}

for (const key of Object.keys(viewModel)) {
  Cesium.knockout.getObservable(viewModel, key).subscribe(syncWeather);
}
syncWeather();
