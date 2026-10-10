// Weather rig "weather-map-wide-on" (probe-kit harvest, weather family).
//
// @purpose The weather-map keystone's wide map-on view: 2,600 km nadir over the central United States.
// @status ACTIVE

export default Object.freeze({
  id: "weather-map-wide-on",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?view=-95,38,2600000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "Weather-map keystone, wide view with the procedural weather map on: 2,600 km nadir over 95 W, 38 N. This view loads the network globe and does not pin the clock, as its probe does; the pinning is still owed under its open ledger row. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: -95,
    lat: 38,
    height: 2600000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherMap: true,
  },
  pins: {
    sky: false,
    sun: false,
    moon: false,
    skyBox: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
