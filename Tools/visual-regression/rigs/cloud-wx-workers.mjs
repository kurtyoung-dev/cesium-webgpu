// Rig record for the landing cell E-WX-workers: the E-W-ground scene with the weather worker dial on.
//
// @purpose Rig record for the landing cell E-WX-workers: w3-ew-ground (the default CesiumViewer at 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up, the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0, 1280x720, both renderers) value for value, plus cloudWeatherWorkers on, so the procedural weather the collection owns is generated, packed and turned into a wind field on a shared Web Worker.
// @status ACTIVE
//
// THE TWIN IS w3-ew-ground, and only its dials differ: camera, clock, viewport,
// readiness, renderers and tag are copied. The dial acts on the weather the
// collection OWNS, which exists only while cloudWeatherMap is on and no
// weatherProvider is set; the twin has the weather map on, and a rig with the
// weather map off would leave the dial with nothing to act on.
//
// BOTH RENDERERS. The WebGL page is the control: the dial is a CloudVolumetrics
// property on both renderers and reads back there, but WebGL has no weather
// state, so no worker is started and the frame is the twin's.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-WX-workers`. The dial goes
// through `lib/landing-cell-stage.mjs` to the cloud probe harness, which reads
// it back from the instance.

export default Object.freeze({
  id: "cloud-wx-workers",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "w3-ew-ground with the weather worker dial on: CesiumViewer at the pinned instant 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up; the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0; cloudWeatherWorkers on; 1280x720, both renderers.",
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
    cloudWeatherWorkers: true,
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
