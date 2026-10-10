// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 401 multi-scatter octave A/B scene: the baked-tier underside view at coverage 0.6 and density 0.85.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-underside-noon-cov060",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The black-sky underside view from 800 m over (-95, 39), heading east and pitched 16 degrees up, at solar noon on the June solstice, with the weather map off, coverage 0.6 and density 0.85; the viewer's own render loop stopped and 90 frames rendered at the fixed clock.",
  declaredBy: "probe-cloud-lighting",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.6,
    cloudDensity: 0.85,
    cloudWeatherMap: false,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
    useDefaultRenderLoop: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
