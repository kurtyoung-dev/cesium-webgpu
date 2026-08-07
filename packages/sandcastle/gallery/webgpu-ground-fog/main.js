import * as Cesium from "cesium";

// Cesium WebGPU fork — the near-surface GROUND FOG band.
//
// `atmosphericConditions.effects.groundFog` boosts the WebGPU froxel fog's
// extinction inside a shallow layer hugging the ground. Three things make it
// its own feature rather than a preset of the general volumetric fog:
//
//   OWN ACTIVATION   it drives the froxel renderer by itself. Leave the
//                    `volumetricFog.enabled` master OFF and the mist still
//                    appears — the "Fog master" box below is there so you can
//                    watch that happen (and stack the two when you want to).
//
//   CAMERA-LOCAL DATUM  the band is anchored to a single scalar per frame: the
//                    ellipsoid radius along the camera's own radial direction
//                    plus the terrain height beneath the camera. The froxel
//                    shader measures altitude above the INSCRIBED sphere, which
//                    at Alpine latitudes sits ~10 km below the surface — feeding
//                    that raw altitude into a 120 m falloff evaluates e^-85 and
//                    the mist underflows to exactly nothing. Expressing the
//                    datum in the same frame makes the offset cancel.
//
//   DERIVED DENSITY  the extinction is not a tuned number. It is the
//                    Koschmieder relation at the 2% contrast threshold,
//                    sigma = ln(50) / V, evaluated at V = 2 km — the mist/fog
//                    boundary of the WMO visibility scale. Intensity scales it
//                    linearly, so the readout below can quote the meteorological
//                    visibility each slider position corresponds to.
//
// The froxel renderer is WebGPU-only, so the backend is pinned here rather than
// left to the renderer toggle; on WebGL every setter below is a silent no-op.
// The default framing is the acceptance scene from
// `Tools/visual-regression/probe-ground-fog.mjs`.
const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {
  contextOptions: { renderer: "webgpu" },
  terrain: Cesium.Terrain.fromWorldTerrain(),
  timeline: false,
  animation: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  selectionIndicator: false,
});

const scene = viewer.scene;
const conditions = scene.globe.atmosphericConditions;

viewer.clock.shouldAnimate = false;

// Shipped constants, mirrored from
// packages/engine/Source/Renderer/WebGPU/WebGPUGroundFogBand.ts so the readout
// quotes the same physics the shader is handed.
const KOSCHMIEDER_LN50 = 3.912;
const GROUND_FOG_REFERENCE_VISIBILITY_METERS = 2000.0;
const GROUND_FOG_BAND_HEIGHT_METERS = 120.0;

// Extinction at the band core for intensity 1, per metre. Intensity scales it
// linearly, and inverting Koschmieder turns that back into a visibility range.
const GROUND_FOG_PEAK_EXTINCTION =
  KOSCHMIEDER_LN50 / GROUND_FOG_REFERENCE_VISIBILITY_METERS;

function visibilityMeters(intensity) {
  if (!(intensity > 0.0)) {
    return Number.POSITIVE_INFINITY;
  }
  return KOSCHMIEDER_LN50 / (intensity * GROUND_FOG_PEAK_EXTINCTION);
}

// WMO visibility bands, so the slider reads as weather rather than a scalar.
function visibilityLabel(meters) {
  if (!Number.isFinite(meters)) {
    return "clear (fog off)";
  }
  if (meters < 1000.0) {
    return "fog";
  }
  if (meters <= 2000.0) {
    return "dense mist / fog boundary";
  }
  if (meters <= 5000.0) {
    return "mist";
  }
  if (meters <= 10000.0) {
    return "haze";
  }
  return "light haze";
}

const FRAMINGS = [
  {
    text: "Alpine ridge, midday (probe framing)",
    // Verbatim from probe-ground-fog.mjs: a low oblique camera over
    // mountainous terrain looking north, so the mist band fills the bottom of
    // the frame while the sky fills the top. This is the geometry the gate
    // measures its lower-band vs upper-band separation on.
    destination: { longitude: 10.5, latitude: 46.4, height: 3500.0 },
    heading: 0.0,
    pitch: -8.0,
    hourUtc: 11.0,
  },
  {
    text: "Inn valley floor, dawn",
    // The band is anchored to the terrain beneath the CAMERA, so a valley-floor
    // camera is squarely inside the model's envelope; the documented limit is
    // the opposite case, a camera parked on a peak high above the valley it is
    // looking at. Low sun makes the in-scatter directional.
    destination: { longitude: 11.28, latitude: 47.28, height: 700.0 },
    heading: 68.0,
    pitch: -3.0,
    hourUtc: 4.25,
  },
];

const viewModel = {
  framings: FRAMINGS,
  framing: FRAMINGS[0],
  groundFog: true,
  intensity: 0.6,
  fogMaster: false,
  multiScatter: false,
  msOctaves: 3,
  occlusion: false,
  hourUtc: FRAMINGS[0].hourUtc,
  readout: "",
};
Cesium.knockout.track(viewModel);
const toolbar = document.getElementById("toolbar");
Cesium.knockout.applyBindings(viewModel, toolbar);

function applyFraming(framing) {
  if (!Cesium.defined(framing)) {
    return;
  }
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      framing.destination.longitude,
      framing.destination.latitude,
      framing.destination.height,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(framing.heading),
      pitch: Cesium.Math.toRadians(framing.pitch),
      roll: 0.0,
    },
  });
  viewModel.hourUtc = framing.hourUtc;
}

function applyClock() {
  // Summer solstice so the sun path is generous; the hour slider then walks it
  // from before dawn to after dusk.
  const hour = parseFloat(viewModel.hourUtc);
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60.0);
  const iso = `2026-06-21T${String(whole).padStart(2, "0")}:${String(
    minutes,
  ).padStart(2, "0")}:00Z`;
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(iso);
}

function applyFog() {
  const intensity = parseFloat(viewModel.intensity);
  // The ground-fog leaf. Enabled here with the master left to the checkbox, so
  // the own-activation path is the default thing on screen.
  conditions.effects.groundFog.enabled = viewModel.groundFog;
  conditions.effects.groundFog.intensity = intensity;

  conditions.volumetricFog.enabled = viewModel.fogMaster;
  conditions.volumetricFog.multiScatter = viewModel.multiScatter;
  conditions.volumetricFog.msOctaves = Math.round(
    parseFloat(viewModel.msOctaves),
  );
  conditions.volumetricFog.enableScatteringOcclusion = viewModel.occlusion;
}

function updateReadout() {
  const intensity = viewModel.groundFog ? parseFloat(viewModel.intensity) : 0.0;
  const meters = visibilityMeters(intensity);
  const lines = [
    `intensity ${intensity.toFixed(2)} -> visibility ${
      Number.isFinite(meters)
        ? `${(meters / 1000.0).toFixed(1)} km`
        : "unbounded"
    } (${visibilityLabel(meters)})`,
    `band falloff scale ${GROUND_FOG_BAND_HEIGHT_METERS} m; negligible above ~${
      3 * GROUND_FOG_BAND_HEIGHT_METERS
    } m`,
  ];

  // The datum the renderer actually handed the shader this frame. Reading it
  // back is what separates "the density is wrong" from "the band is anchored to
  // the wrong ground" — the defect that made this effect render nothing for
  // 400+ batches. Guarded: it is a debug surface, not a rendering dependency.
  const context = scene.context;
  const statistics =
    Cesium.defined(context) &&
    typeof context.getRendererStatistics === "function"
      ? context.getRendererStatistics()
      : undefined;
  const ground = statistics?.volumetricFog?.groundFog;
  if (Cesium.defined(ground)) {
    lines.push(
      `datum ${Number(ground.referenceAltitude).toFixed(1)} m over terrain ${Number(
        ground.terrainHeight,
      ).toFixed(1)} m; camera ${(
        Number(ground.cameraAltitude) - Number(ground.referenceAltitude)
      ).toFixed(1)} m above it; band ${ground.active ? "active" : "idle"}`,
    );
  } else {
    lines.push("band diagnostics unavailable on this backend");
  }
  viewModel.readout = lines.join("\n");
}

Cesium.knockout.getObservable(viewModel, "framing").subscribe(applyFraming);
Cesium.knockout.getObservable(viewModel, "hourUtc").subscribe(applyClock);
for (const key of [
  "groundFog",
  "intensity",
  "fogMaster",
  "multiScatter",
  "msOctaves",
  "occlusion",
]) {
  Cesium.knockout.getObservable(viewModel, key).subscribe(applyFog);
}

// The datum only exists once the froxel renderer has run a frame, so the
// readout is refreshed off the render loop rather than only on input. Four
// times a second is enough to follow a camera move without touching the DOM
// every frame.
let lastReadoutTime = 0.0;
scene.postRender.addEventListener(() => {
  const now = performance.now();
  if (now - lastReadoutTime < 250.0) {
    return;
  }
  lastReadoutTime = now;
  updateReadout();
});

applyFraming(viewModel.framing);
applyClock();
applyFog();
updateReadout();
