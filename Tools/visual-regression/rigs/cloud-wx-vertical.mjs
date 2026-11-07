// Rig record for the landing cell E-WX-vertical: the E-W-ground scene with the vertical weather dial on.
//
// @purpose Rig record for the landing cell E-WX-vertical: w3-ew-ground (the default CesiumViewer at 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up, the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0, 1280x720, both renderers) value for value, plus cloudVerticalWeather on, so the single deck follows the cloud-top heights the weather provider publishes per region.
// @status ACTIVE
//
// THE TWIN IS w3-ew-ground, and only its dials differ: camera, clock, viewport,
// readiness, renderers and tag are copied. The dial reads the heights of the
// weather the collection OWNS (cloudWeatherMap on, no weatherProvider), so the
// twin's weather map is the precondition.
//
// A SINGLE DECK. The dial applies to a single deck: the renderer ignores it
// when cloudMultiDeck is on (`config.cloudVerticalWeather === true &&
// !multiDeckOn`), and this scene has one deck, so the dial is exercised here.
//
// BOTH RENDERERS. The WebGL page is the control: the dial reads back there but
// WebGL has no weather state, so the frame is the twin's.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-WX-vertical`.

export default Object.freeze({
  id: "cloud-wx-vertical",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "w3-ew-ground with the vertical weather dial on: CesiumViewer at the pinned instant 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up; the managed single volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0; cloudVerticalWeather on; 1280x720, both renderers.",
  declaredBy: "w3-ew-ground",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: {
    cloudWeatherMap: true,
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWindSpeed: 0,
    cloudsEnabled: true,
    cloudVerticalWeather: true,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
