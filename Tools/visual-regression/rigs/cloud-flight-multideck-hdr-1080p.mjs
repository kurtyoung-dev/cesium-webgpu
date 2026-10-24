// Rig record for the landing program's flight cell E-F: the 2026-09-26 E4
// flight cell, re-declared as data so the seat's executor runs it on the
// runtime instead of through the lane-local driver it was first run with.
//
// @purpose Rig record for the landing cell E-F (flight): 1920x1080, 2,500 m over (-100, 40) pitched 12 degrees down at 21:40Z on the June solstice, multi-deck volumetric cumulus at coverage 0.6, highDynamicRange on, 4x MSAA, globe lighting and multiple scattering on, Natural Earth imagery on the ellipsoid - the cell the E4 driver ran as "flight".
// @status ACTIVE
//
// EVERY VALUE IS READ OUT OF THE BANKED E4 DRIVER, not restated from a brief:
// `worker-archive/lanes-2026-09-26/e4-astra-ab/lane/e4-driver.mjs`, sha256
// b01c1140d8762bbe8dd52d73c69a8373b3ef2c01af90d17b70879fce50fafecd (the hash
// the 10-08 review records), `CELLS.flight` and `ASTRA_CLOUD`. The driver
// writes the camera in degrees; the rig stores radians, as every rig does
// (pitch -12 degrees = -0.20943951023931953). `cloudType` is the
// `CloudType.CUMULUS` value (0) the driver resolved from its name. The
// driver's page was a bare `Viewer` with `baseLayer: false` and no terrain
// option, i.e. the ellipsoid; `terrain: "ellipsoid"` says so, and the probe
// opens the page with `offline=true` (no world terrain, no ion base layer), so
// the imagery dial's Natural Earth layer is the only imagery, as in the driver.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-F` (and `E-T-flight` for
// the teardown and device-loss cell on the same scene). Every dial goes
// through `lib/landing-cell-stage.mjs`, which reads each one back; the
// `cloud*` half goes through the cloud probe harness's round trip.
//
// READINESS. The driver warmed until the cloud pipeline was up, the march had
// dispatched pixels and the tiles had loaded, then rendered three 60-frame
// settles. 180 is those three settles; the warm-up is the probe's startup
// measurement, not part of the rig.

export default Object.freeze({
  id: "cloud-flight-multideck-hdr-1080p",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Flight cell E-F: 2,500 m over (-100, 40), heading north, pitched 12 degrees down, 21:40Z on the June solstice; multi-deck volumetric cumulus (coverage 0.6, density 0.35, 1,500-4,000 m, physical aerial, sky-LUT ambient, high tier), highDynamicRange on, 4x MSAA, globe lighting and sky multiple scattering on, Natural Earth imagery on the ellipsoid, 1920x1080.",
  declaredBy: "e4-driver.mjs (2026-09-26, sha256 b01c1140...) cell flight",
  camera: {
    lon: -100,
    lat: 40,
    height: 2500,
    heading: 0,
    pitch: -0.20943951023931953,
    roll: 0,
  },
  clock: "2026-06-21T21:40:00Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.6,
    cloudDensity: 0.35,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudVolumetricQuality: "high",
    cloudWeatherMap: false,
    cloudAerialMode: "physical",
    cloudAmbientSource: "sky-lut",
    cloudMultiDeck: true,
    highDynamicRange: true,
    msaaSamples: 4,
    globeEnableLighting: true,
    skyAtmosphereMultipleScattering: true,
    imagery: "naturalEarth",
    terrain: "ellipsoid",
  },
  viewport: {
    width: 1920,
    height: 1080,
  },
  readiness: {
    kind: "settleFrames",
    frames: 180,
  },
});
