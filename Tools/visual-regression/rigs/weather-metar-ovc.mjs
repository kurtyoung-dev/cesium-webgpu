// Weather rig "weather-metar-ovc" (probe-kit harvest, weather family).
//
// @purpose The METAR leg's overcast-station pose: 250 km nadir over the inverse-distance field rasterised from the committed station fixture.
// @status ACTIVE

export default Object.freeze({
  id: "weather-metar-ovc",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=0,35,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "METAR leg, the spatial pair's overcast side: 250 km nadir at local mean noon over the overcast (OVC) station of the committed five-station fixture, rasterised by inverse distance (64x32 grid, 45 degree influence radius) with the genus, base and density channels on. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 0,
    lat: 35,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T12:00:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.5,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherChannelStrength: 1,
    cloudWindSpeed: 0,
    cloudQuality: 32,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "mock-metar:grid64x32:influence45",
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
