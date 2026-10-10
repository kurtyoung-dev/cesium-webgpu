// Weather rig "weather-channels-rich-east" (probe-kit harvest, weather family).
//
// @purpose The east end of the channels leg's sweep: 250 km nadir over the rich synthetic weather field, one scored and banked pose.
// @status ACTIVE

export default Object.freeze({
  id: "weather-channels-rich-east",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=150,25,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "Channels leg, east end of its nine-longitude sweep at 25 N: 250 km nadir at local mean noon over the rich synthetic weather field (coverage flat at 0.85; density bias thin in the west, dense in the east; genus stratus in the west, tower in the east). Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 150,
    lat: 25,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T02:00:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherChannelStrength: 1,
    cloudWeatherMap: false,
    cloudWindSpeed: 0,
    cloudQuality: 32,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "synthetic:rich",
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
