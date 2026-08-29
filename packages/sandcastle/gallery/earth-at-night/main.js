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
// A fixed instant so the terminator lands in a known place: the Americas are on
// the night side and the ramp runs down the eastern Pacific. Dynamic lighting
// starts the clock, and 4000x makes the terminator sweep in a few seconds.
//
// Built as a Clock up front, with startTime/stopTime already bracketing the
// pinned instant, rather than assigned onto the default clock after
// construction: the widget zooms the timeline to clock.startTime/stopTime
// exactly once, at construction. An unbracketed default clock spans
// [now, now + 1 day], which does not contain a fixed March date, so the
// timeline has no visible track for the needle to sit on.
const clock = new Cesium.Clock({
  startTime: Cesium.JulianDate.fromIso8601("2026-03-21T00:00:00Z"),
  stopTime: Cesium.JulianDate.fromIso8601("2026-03-22T00:00:00Z"),
  currentTime: Cesium.JulianDate.fromIso8601("2026-03-21T02:00:00Z"),
  multiplier: 4000,
  shouldAnimate: false,
});

// `createAsync` rather than `new Viewer` only because acquiring a WebGPU device
// is asynchronous; apart from the clock view model, it still takes the build's
// default backend.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  clockViewModel: new Cesium.ClockViewModel(clock),
});

const scene = viewer.scene;
const globe = scene.globe;

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

// EAN-01 star-control defaults: begin.
Object.assign(viewModel, {
  starMap: Cesium.SkyBox?.defaultVariant ?? "TYCHO_T5_DIFFUSE",
  hdrBloom: false,
  starFieldIntensity: 1.0,
});
// EAN-01 star-control defaults: end.

Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

// Four of the five controls share this subscriber; `dynamicLighting` does
// not (see `updateDynamicLighting` below), so none of the four can reach the
// clock as a side effect of sharing a subscription list with the checkbox
// that is actually supposed to drive it.
for (const name of [
  "nightImagery",
  "nightDarkness",
  "enableNightLights",
  "nightIntensity",
]) {
  Cesium.knockout.getObservable(viewModel, name).subscribe(updateGlobe);
}
Cesium.knockout
  .getObservable(viewModel, "dynamicLighting")
  .subscribe(updateDynamicLighting);

function updateGlobe() {
  globe.nightImagery = resolveNightImagery(viewModel.nightImagery);

  // Procedural fallback for globes with no night layer: the surface is scaled
  // along the same dusk ramp the imagery alpha uses, with no camera-distance
  // fade, so the night side stays dark at street altitude as well as from orbit.
  globe.nightDarkness = Number(viewModel.nightDarkness);

  // Treats the night layer as emissive, boosted by its own luminance, so city
  // cores glow rather than merely being visible. On by default, on both
  // renderers.
  globe.enableNightLights = Boolean(viewModel.enableNightLights);
  globe.nightIntensity = Number(viewModel.nightIntensity);
}

// Lit terrain and a running clock, coupled exactly the way the demo this one
// is ported from couples them: checking the box resumes a paused clock,
// unchecking it pauses a running one. Scoped to its own subscriber, on its
// own observable, so that coupling lives only on the checkbox instead of
// firing every time any of the other four controls change.
function updateDynamicLighting() {
  const dynamicLighting = Boolean(viewModel.dynamicLighting);
  globe.enableLighting = dynamicLighting;
  viewer.clock.shouldAnimate = dynamicLighting;
}

updateGlobe();
updateDynamicLighting();

// Wired after the lighting setup so the clock coupling above stays exactly as
// the Q-146 proof lifts it; these controls never reach the clock.
wireStarControls(viewModel, viewer.scene);

// EAN-01 star-control wiring: begin.
function wireStarControls(viewModel, scene) {
  // Show the engine's current value; reading it changes nothing.
  viewModel.starFieldIntensity = scene.skyBox?.starField?.intensity ?? 1.0;
  Cesium.knockout.getObservable(viewModel, "starMap").subscribe(updateStarMap);
  Cesium.knockout
    .getObservable(viewModel, "hdrBloom")
    .subscribe(updateHdrBloom);
  Cesium.knockout
    .getObservable(viewModel, "starFieldIntensity")
    .subscribe(updateStarFieldIntensity);

  function updateStarMap() {
    const previousSkyBox = scene.skyBox;
    Cesium.SkyBox.defaultVariant = Cesium.SkyBox.Variant[viewModel.starMap];
    previousSkyBox.destroy();
    scene.skyBox = Cesium.SkyBox.createEarthSkyBox();
  }

  function updateHdrBloom() {
    const enabled = Boolean(viewModel.hdrBloom);
    scene.highDynamicRange = enabled;
    scene.postProcessStages.bloom.enabled = enabled;
  }

  function updateStarFieldIntensity() {
    scene.skyBox.starField.intensity = Number(viewModel.starFieldIntensity);
  }
}
// EAN-01 star-control wiring: end.

const note = document.getElementById("backendNote");
note.textContent = `Renderer: ${rendererType} — emissive city lights are live on both renderers.`;
