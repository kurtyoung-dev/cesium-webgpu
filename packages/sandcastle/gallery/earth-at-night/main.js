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

// The emissive city-light branch is WebGPU-only by contract: it reads a value
// the WebGPU globe tile uniforms carry and the GLSL globe never declared, so on
// WebGL the two controls below are inert rather than approximated. Say which
// backend is running instead of hiding the controls, because "why did nothing
// happen" is the question this demo would otherwise leave behind.
const rendererType = scene.context.rendererType;
const isWebGPU = rendererType === "webgpu";

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
  // The engine default is 1.0 — the multiplicative identity, so a globe that
  // opts out of night imagery renders exactly as it always did. 0.15 is the
  // documented tuning value and the interesting one to start on here: the
  // darkening is suppressed per tile wherever the night layer is already
  // blending, so this slider does nothing until night imagery is switched off.
  nightDarkness: 0.15,
  dynamicLighting: false,
  enableNightLights: false,
  nightIntensity: 2.5,
  isWebGPU: isWebGPU,
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
  // cores glow rather than merely being visible.
  globe.enableNightLights = Boolean(viewModel.enableNightLights);
  globe.nightIntensity = Number(viewModel.nightIntensity);
}
updateGlobe();

const note = document.getElementById("backendNote");
note.textContent = isWebGPU
  ? `Renderer: ${rendererType} — emissive city lights are live.`
  : `Renderer: ${rendererType} — the emissive city-light controls are WebGPU-only and do nothing here. Pass contextOptions: { renderer: "webgpu" } to createAsync above and run again to see them.`;
