// Weather rig "weather-ingest-uniform-hi" (probe-kit harvest, weather family).
//
// @purpose The ingest leg's deck-present pose: 650 m above the plains looking east at 16 degrees, uniform synthetic coverage 0.95.
// @status ACTIVE

export default Object.freeze({
  id: "weather-ingest-uniform-hi",
  tags: ["weather"],
  page: "Apps/CesiumViewer/index.html?offline=true&view=-95,39,650,90,16,0",
  renderers: ["webgpu"],
  description:
    "Ingest leg, the high source: 650 m above 95 W, 39 N looking east 16 degrees up at local mean noon, with a uniform synthetic weather field of coverage 0.95 fed through the provider and packer. The lit sky is kept on purpose; the deck is read against it. Volumetric clouds are WebGPU-only.",
  camera: {
    lon: -95,
    lat: 39,
    height: 650,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-01T18:20:00Z",
  dials: {
    cloudCoverage: 0.5,
    cloudDensity: 0.45,
    cloudWeatherChannelStrength: 1,
    cloudWindSpeed: 0,
    cloudQuality: 32,
    cloudCastShadows: false,
    cloudContributesIBL: false,
    weatherSource: "synthetic:uniform:0.95",
  },
  pins: {
    offlineGlobe: true,
    imagery: "none",
    terrain: "ellipsoid",
    darkGlobe: true,
    groundAtmosphere: false,
    fog: false,
    sky: true,
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
