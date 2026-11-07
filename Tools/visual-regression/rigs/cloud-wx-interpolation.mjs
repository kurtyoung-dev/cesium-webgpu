// Rig record for the landing cell E-WX-interpolation: the E-W-ground scene with the weather interpolation dial on and a clock step that gives the page a snapshot pair.
//
// @purpose Rig record for the landing cell E-WX-interpolation: w3-ew-ground (the default CesiumViewer at 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up, the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0, 1280x720, both renderers) value for value, plus cloudWeatherInterpolation on and one clock step to 2026-06-21T18:10:15Z with 240 frames settled after it, so the collection's own weather has published the 18:10 snapshot with the 18:00 one as its predecessor and the fade is half done.
// @status ACTIVE
//
// WHERE THE PAIR COMES FROM: DATA, NOT A FIXTURE. The collection's own weather
// provider quantizes scene time to 1/6 h (10 minutes, `CloudWeatherState`), and
// it publishes `previous` only when the CACHED slice of the quantum before the
// current one exists (`WeatherProvider._publishVersion`); a slice is cached only
// when the scene clock has visited that quantum and its fetch completed, and the
// provider fetches the current quantum alone. The rig therefore starts at
// 18:00:00Z (quantum 18:00, fetched while the page settles) and steps the clock
// across the 10-minute boundary to 18:10:15Z (quantum 18:10): the new snapshot
// is published with the 18:00 one as `previous`.
//
// THE FADE IS OPEN AT THE LAST FRAME. `resolveCloudWeatherTransition` is active
// while 0 <= elapsed < min(interval, duration), elapsed counted from the current
// snapshot's quantum start: here 15 s against min(600 s, the 30 s default
// cloudWeatherTransitionSeconds), so the fade is half done and, with the
// viewer's clock frozen, stays there. The transition then allocates the texture
// "Cloud previous weather snapshot" (`WebGPUCloudWeatherTransition`), which the
// cell's pass rule reads in the page census.
//
// THE TRANSITION NEEDS BAKED NOISE. The march drops the transition define
// unless the resolved tier bakes its noise (`WebGPUProceduralCloudRenderer`,
// `bakedOnly`). Tiers 1 to 3 all bake once the noise volumes are resident; the
// twin sets no tier, and at 800 m the auto tier is the high one, so nothing is
// added here.
//
// DIFFERS FROM THE TWIN IN: cloudWeatherInterpolation, and the step dials
// clockSteps and settleFramesPerStep (the 240 frames give the provider time to
// fetch and pack the 18:10 snapshot; a page that has not published it by then
// shows no previous-snapshot owner in the census and the cell reports it).
// BOTH RENDERERS: the WebGL page runs the same clock step and is the control
// (no weather state, so no previous snapshot and no worker).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-WX-interpolation` (kind
// clock-steps: a capture before the step and one after it).

export default Object.freeze({
  id: "cloud-wx-interpolation",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "w3-ew-ground with the weather interpolation dial on: CesiumViewer at 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up; the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0; cloudWeatherInterpolation on; the clock stepped to 18:10:15Z (across a 10-minute weather quantum) so the page holds a snapshot pair mid-fade; 1280x720, both renderers.",
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
    cloudWeatherInterpolation: true,
    clockSteps: ["2026-06-21T18:10:15Z"],
    settleFramesPerStep: 240,
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
