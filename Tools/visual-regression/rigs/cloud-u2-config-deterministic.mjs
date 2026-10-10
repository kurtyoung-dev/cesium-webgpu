// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 618 config-indirection scene: a deterministic procedural deck that exercises a broad set of cloud read sites at one fixed clock.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-u2-config-deterministic",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) heading north and pitched 10 degrees up at a fixed 12:00 UTC on 1 January, the viewer's own render loop stopped; a 1,500-4,000 m cumulonimbus deck at coverage 0.55 and density 0.8 with wind, cast shadows, image-based lighting, phase, ambient, erosion, curl, aerial, exposure, weather-channel, lenticularis species and mammatus dials all set; 120 settle frames.",
  declaredBy: "probe-cloud-u2-config",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 0,
    pitch: 0.17453292519943295,
    roll: 0,
  },
  clock: "2026-01-01T12:00:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 22,
    cloudWindDirection: [0.7, 0.3],
    cloudContributesIBL: true,
    cloudCastShadows: true,
    cloudSilverLiningIntensity: 0.85,
    cloudPhaseForwardG: 0.85,
    cloudPhaseBackG: -0.3,
    cloudPhaseBlend: 0.7,
    cloudAmbientIntensity: 1.5,
    cloudErosionStrength: 0.18,
    cloudCurlAmplitude: 0.4,
    cloudCurlFrequency: 2,
    cloudAerialStrength: 1,
    cloudExposure: 0.22,
    collectionCloudType: 10,
    cloudWeatherChannelStrength: 1,
    cloudSpecies: "lenticularis",
    cloudMammatusStrength: 0.5,
    useDefaultRenderLoop: false,
  },
  viewport: {
    width: 900,
    height: 600,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
