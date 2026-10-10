// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the W1 dual-lobe phase gate, backlit leg: the black-sky underside view looking toward the sun's azimuth.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-phase-backlit",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) under a thin deck (coverage 0.4, density 0.7, weather map off), looking toward the sun's azimuth and pitched 14 degrees up; sky box, sky atmosphere and sun hidden over black; the page's own clock, frozen; 160 settle frames. The heading is relative to the sun's azimuth at the capture instant.",
  declaredBy: "probe-cloud-phase",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 0,
    pitch: 0.24434609527920614,
    roll: 0,
    headingReference: "sun-azimuth",
  },
  clock: null,
  dials: {
    cloudCoverage: 0.4,
    cloudWeatherMap: false,
    cloudDensity: 0.7,
    skyBoxShow: false,
    skyAtmosphereShow: false,
    sunShow: false,
    backgroundColor: "rgb(0,0,0)",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 160,
  },
});
