// Rig record for the landing program's cell E-W-ground-hdr: the W3 weather-state identity view.
//
// @purpose Rig record for the landing cell E-W-ground-hdr (the W3 cloud job's E-W identity cell, rebuilt from the banked stage records of the 2026-10-31 W3-DAYLIGHT Edge leg): the default CesiumViewer at the pinned instant 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up, the managed volumetric deck on with the weather map on (coverage 0.55, density 0.8, wind 0), and scene.highDynamicRange forced on, 1280x720, 240 settle frames, both renderers.
// @status ACTIVE
//
// WHY IT EXISTS. The W3 job's E-W cells lived only in an out-of-tree copy of the landing probe, whose old verdict body failed a run on an unmeasured-by-contention PF-3 reading. The cells are data here so the kit's own verdicts and exit fold apply. The camera, clock, dials and viewport are the ones the banked stage records of that leg requested (`stage.camera.requested`, `stage.clock.requested`, `stage.cloud.truth.config`, the capture size); the settle count is the E-D family's 240, which fits the banked capture frame numbers (273 after 22 startup frames on the WebGL ground page, against 256 after 7 on the E-ID-2d page of the same kit).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-W-ground-hdr`.

export default Object.freeze({
  id: "w3-ew-ground-hdr",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "CesiumViewer at the pinned instant 2026-06-21T18:00:00Z, camera 800 m above (-95, 39), heading east and pitched 16 degrees up; the managed volumetric deck on with the weather map on, coverage 0.55, density 0.8, wind 0; scene.highDynamicRange forced on; 1280x720, both renderers.",
  declaredBy:
    "the W3 cloud job's E-W instrument (banked stage records, W3-DAYLIGHT Edge leg)",
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
    highDynamicRange: true,
    cloudWeatherMap: true,
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWindSpeed: 0,
    cloudsEnabled: true,
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
