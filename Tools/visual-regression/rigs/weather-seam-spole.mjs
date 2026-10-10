// Weather rig "weather-seam-spole" (probe-kit harvest, weather family).
//
// @purpose The dateline and pole seam gate's spole pose: 250 km nadir over the procedural weather map.
// @status ACTIVE

export default Object.freeze({
  id: "weather-seam-spole",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=0,-89.995,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "Dateline and pole seam gate: 250 km nadir at local mean noon over the south pole, inside the constant polar cap, with the procedural weather map on and no provider attached. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 0,
    lat: -89.995,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T12:00:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.9,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWeatherMap: true,
    cloudWindSpeed: 0,
    cloudQuality: 32,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "procedural",
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
    ms: 1500,
  },
});
