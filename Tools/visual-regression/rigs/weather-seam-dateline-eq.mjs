// Weather rig "weather-seam-dateline-eq" (probe-kit harvest, weather family).
//
// @purpose The dateline and pole seam gate's dateline-eq pose: 250 km nadir over the procedural weather map.
// @status ACTIVE

export default Object.freeze({
  id: "weather-seam-dateline-eq",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=180,0.7,250000,0,-90,0",
  renderers: ["webgpu"],
  description:
    "Dateline and pole seam gate: 250 km nadir at local mean noon over the antimeridian at 0.7 N, where the map is cloudy on both sides of the seam, with the procedural weather map on and no provider attached. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: 180,
    lat: 0.7,
    height: 250000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-01T00:00:00Z",
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
