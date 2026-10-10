// Weather rig "weather-wcs-mock-east" (probe-kit harvest, weather family).
//
// @purpose The east end of the OGC API-Coverages mock-fixture leg's sweep: 250 km nadir over its committed cloud-cover fixture, served offline.
// @status ACTIVE

export default Object.freeze({
  id: "weather-wcs-mock-east",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=160,30,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "OGC API-Coverages mock-fixture leg, east end of its nine-longitude sweep at 30 N: 250 km nadir at local mean noon over the committed 12x6 coverage fixture (clear in the west ramping to overcast in the east), parsed by the same CoverageJSON parser the EDR source uses, served offline by the dev server's mock route. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 160,
    lat: 30,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T01:20:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherChannelStrength: 1,
    cloudWindSpeed: 0,
    cloudQuality: 32,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "mock-wcs:gdps-cloud-cover:TCDC:percent",
  },
  pins: {
    offlineGlobe: true,
    imagery: "none",
    terrain: "ellipsoid",
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
    sky: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleMs",
    ms: 1000,
  },
});
