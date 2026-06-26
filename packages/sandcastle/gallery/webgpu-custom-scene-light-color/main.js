import * as Cesium from "cesium";

const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
});

const scene = viewer.scene;
const globe = scene.globe;

const viewModel = {
  // Default to a warm sunset orange so the effect is immediately
  // visible — white would be indistinguishable from the
  // baseline.
  lightColor: "#ff8844",
  intensity: 1.5,
  enableLighting: true,
};

function hexToColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return new Cesium.Color(r, g, b, 1.0);
}

function applyConfig() {
  // The globe Lambert path on WebGPU multiplies the diffuse
  // term by `camera.lightColor.rgb` (Batch 76). This is fed
  // from `uniformState.lightColor`, which reads from
  // `scene.light.color`. The DIRECTION component of
  // `scene.light` is consumed by other paths (atmosphere,
  // model PBR); the globe Lambert always uses the sun
  // direction. So this demo focuses on COLOR tinting.
  //
  // Using a SunLight here so the sun direction stays correct
  // for the camera view (clock pinned to solar noon below
  // means the visible disc is fully day-lit).
  const color = hexToColor(viewModel.lightColor);
  scene.light = new Cesium.SunLight({
    color,
    intensity: Number(viewModel.intensity),
  });
  globe.enableLighting = Boolean(viewModel.enableLighting);
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

// Pin the clock to solar noon UTC on 2026-06-21 (June
// solstice). At 12:00 UTC the sun is over the prime meridian;
// we position the camera there so the visible globe disc is
// fully day-lit and the light color tint is unambiguous.
const noon = Cesium.JulianDate.fromIso8601("2026-06-21T12:00:00Z");
viewer.clock.currentTime = noon.clone();
viewer.clock.startTime = noon.clone();
viewer.clock.stopTime = noon.clone();
viewer.clock.shouldAnimate = false;
viewer.clock.multiplier = 0;

// Position over the prime meridian at orbital altitude — the
// bright sunlit disc fills most of the view, making the light
// color tint immediately visible.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0, 23, 12_000_000),
});
