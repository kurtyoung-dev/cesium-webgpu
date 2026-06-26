import * as Cesium from "cesium";

// Force WebGPU — dual-light atmospheric scattering is a
// WebGPU-only effect. WebGL's sky-atmosphere shader only
// supports a single light direction.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const scene = viewer.scene;
const globe = scene.globe;

// Show the sky atmosphere + globe atmospheric conditions. The
// moon needs to be visible for dual-light to do anything; the
// viewer enables sky+moon by default but we make it explicit.
scene.skyAtmosphere.show = true;
scene.moon.show = true;
scene.sun.show = true;

const viewModel = {
  dualLightEnabled: true,
  moonIntensity: 0.05,
  hourUtc: 22, // Pre-midnight UTC over the Atlantic — moon up,
  // sun on the opposite side of the Earth from the
  // camera. Best demonstration of the effect.
};

function applyConfig() {
  const ac = globe.atmosphericConditions;
  ac.lighting.enableDualLightAtmosphere = Boolean(viewModel.dualLightEnabled);
  ac.lighting.moonIntensity = Number(viewModel.moonIntensity);

  // Pin the clock to a specific UTC hour on a fixed date so
  // the moon position is reproducible. June solstice maximizes
  // the moon's elevation at high northern latitudes — handy
  // for European / North-American night-side views.
  const hour = Number(viewModel.hourUtc);
  const iso = `2026-06-21T${String(Math.floor(hour)).padStart(2, "0")}:${String(
    Math.round((hour - Math.floor(hour)) * 60),
  ).padStart(2, "0")}:00Z`;
  const fixed = Cesium.JulianDate.fromIso8601(iso);
  viewer.clock.currentTime = fixed.clone();
  viewer.clock.startTime = fixed.clone();
  viewer.clock.stopTime = fixed.clone();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;

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

// High-orbit view over the European night side at 22:00 UTC —
// the atmosphere limb at the terminator + the night
// hemisphere are visible. Toggle the dual-light checkbox to
// see the moon's contribution on the night limb appear /
// disappear; slide the moon intensity to scale it.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(20, 50, 15_000_000),
});
