// Weather rig "weather-edr-mock-west" (probe-kit harvest, weather family).
//
// @purpose The west end of the EDR mock-fixture leg's sweep: 250 km nadir over its committed cloud-cover fixture, served offline.
// @status ACTIVE

export default Object.freeze({
  id: "weather-edr-mock-west",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=-160,30,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "EDR mock-fixture leg, west end of its nine-longitude sweep at 30 N: 250 km nadir at local mean noon over the committed 12x6 EDR cloud-cover fixture (clear in the north-west ramping to overcast in the south-east, with a clear eye in the east), served offline by the dev server's mock route. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: -160,
    lat: 30,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T22:40:00Z",
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
    weatherSource: "mock-edr:mock-gfs:TCDC:percent",
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
