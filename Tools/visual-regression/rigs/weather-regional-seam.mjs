// Weather rig "weather-regional-seam" (probe-kit harvest, weather family).
//
// @purpose The regional antimeridian tail's seam pose: 250 km nadir over a CoverageJSON field whose longitude axis walks through 180.
// @status ACTIVE

export default Object.freeze({
  id: "weather-regional-seam",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=180,-5,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "Regional antimeridian tail: 250 km nadir at local mean noon over the antimeridian itself, centred on the regional field. The field is a real CoverageJSON response (170 to 190 degrees, 5 S band, full coverage) whose axis crosses 180, answered by an intercepted EDR route. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 180,
    lat: -5,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T00:00:00Z",
  dials: {
    cloudCoverage: 0.5,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudQuality: 96,
    cloudWeatherMap: true,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "coveragejson:antimeridian-regional",
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
    kind: "settleFrames",
    frames: 28,
  },
});
