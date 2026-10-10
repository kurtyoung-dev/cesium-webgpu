// Weather rig "weather-regional-webgl-billboard" (probe-kit harvest, weather family).
//
// @purpose The regional tail's WebGL arm: a five-cloud billboard collection seen from 15 km, with the regional provider packed and attached.
// @status ACTIVE

export default Object.freeze({
  id: "weather-regional-webgl-billboard",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=-95,39,15000,0,-90,0",
  renderers: ["webgl"],
  description:
    "Regional tail, WebGL arm: 15 km nadir over 95 W, 39 N with the globe hidden and a five-cloud billboard collection in volumetric mode at 3 km. The regional provider is packed and attached; WebGL has no volumetric renderer, so the billboards are what renders.",
  camera: {
    lon: -95,
    lat: 39,
    height: 15000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T12:00:00Z",
  dials: {
    cloudCollection: "billboard x5, volumetric mode",
    cloudWeatherMap: true,
    weatherSource: "coveragejson:antimeridian-regional",
  },
  pins: {
    globe: false,
    sky: false,
  },
  viewport: {
    width: 900,
    height: 650,
  },
  readiness: {
    kind: "settleFrames",
    frames: 32,
  },
});
