// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the W2 sky-ambient gate: the black-sky underside view turned 90 degrees off the sun's azimuth so the deck shows a lit face and a shadow face.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-ambient-sidelit",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) under a deck at coverage 0.5 and density 0.75 with the weather map off, turned 90 degrees clockwise from the sun's azimuth and pitched 14 degrees up; sky box, sky atmosphere and sun hidden over black; the page's own clock, frozen; 160 settle frames.",
  declaredBy: "probe-cloud-ambient",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 1.5707963267948966,
    pitch: 0.24434609527920614,
    roll: 0,
    headingReference: "sun-azimuth",
  },
  clock: null,
  dials: {
    cloudCoverage: 0.5,
    cloudWeatherMap: false,
    cloudDensity: 0.75,
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
