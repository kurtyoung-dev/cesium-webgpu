import * as Cesium from "cesium";

// The Earth at night — and in this fork it is the default, not a recipe.
//
// `globe.nightImagery` defaults to `true`, which resolves to the Black Marble
// night pyramid bundled with the library: an auto-managed imagery layer with a
// day alpha of 0 and a night alpha of 1, created and destroyed by the globe and
// kept above the base layer. So the viewer below is built with no options at
// all, and the dark half of the planet already carries city lights. There is no
// second layer to add, no alpha pair to set, and no `enableLighting` to turn on
// first — the day/night blend is driven by the alpha pair itself rather than by
// whether the globe is being shaded.
//
// `createAsync` rather than `new Viewer` only because acquiring a WebGPU device
// is asynchronous; with no options it still takes the build's default backend,
// which is what makes the WebGPU-only control further down reachable at all.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer");

const scene = viewer.scene;
const globe = scene.globe;

// A fixed instant so the terminator lands in a known place: the Americas are on
// the night side and the ramp runs down the eastern Pacific. Dynamic lighting
// starts the clock, and 4000x makes the terminator sweep in a few seconds.
viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
  "2026-03-21T02:00:00Z",
);
viewer.clock.multiplier = 4000;
viewer.clock.shouldAnimate = false;

scene.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-95.0, 25.0, 24000000.0),
});

// Both renderers run the same emission law, so the two city-light controls
// below act the same way whichever backend this page picked. The renderer is
// still named underneath, because a demo about appearance should say what drew
// it.
const rendererType = scene.context.rendererType;

// The ion night asset is created once and reused. The globe compares the
// provider it was handed against the one already attached, so handing it a
// freshly-created promise on every slider move would tear the layer down and
// rebuild it each frame.
let ionNightImagery;

function resolveNightImagery(choice) {
  if (choice === "off") {
    return false;
  }
  if (choice === "ion") {
    if (!Cesium.defined(ionNightImagery)) {
      ionNightImagery = Cesium.IonImageryProvider.fromAssetId(3812);
    }
    return ionNightImagery;
  }
  return true;
}

const viewModel = {
  nightImagery: "bundled",
  // The engine's own default, and the value the acceptance sweep measured as
  // the street-altitude darkness that reads as night without crushing detail.
  // Assigning it here is the explicit path, so the slider applies whatever
  // night imagery is doing — though from orbit, where the night layer covers
  // the night side outright, the fallback is scaled back to the identity and
  // moving it does nothing until the camera descends far enough for the layer
  // to fade.
  nightDarkness: 0.15,
  dynamicLighting: false,
  enableNightLights: true,
  nightIntensity: 2.5,
};

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);
for (const name in viewModel) {
  if (viewModel.hasOwnProperty(name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(updateGlobe);
  }
}

function updateGlobe() {
  globe.nightImagery = resolveNightImagery(viewModel.nightImagery);

  // Procedural fallback for globes with no night layer: the surface is scaled
  // along the same dusk ramp the imagery alpha uses, with no camera-distance
  // fade, so the night side stays dark at street altitude as well as from orbit.
  globe.nightDarkness = Number(viewModel.nightDarkness);

  // Lit terrain and a running clock. The night imagery no longer depends on it.
  const dynamicLighting = Boolean(viewModel.dynamicLighting);
  globe.enableLighting = dynamicLighting;
  viewer.clock.shouldAnimate = dynamicLighting;

  // Treats the night layer as emissive, boosted by its own luminance, so city
  // cores glow rather than merely being visible. On by default, on both
  // renderers.
  globe.enableNightLights = Boolean(viewModel.enableNightLights);
  globe.nightIntensity = Number(viewModel.nightIntensity);
}
updateGlobe();

const note = document.getElementById("backendNote");
note.textContent = `Renderer: ${rendererType} — emissive city lights are live on both renderers.`;
