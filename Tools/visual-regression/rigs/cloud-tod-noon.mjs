// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the W3 time-of-day sun-colour gate, noon leg: the black-sky underside view at solar noon over (-95, 39).
// @status ACTIVE

export default Object.freeze({
  id: "cloud-tod-noon",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) heading east and pitched 16 degrees up under a deck at coverage 0.5 and density 0.75 with the weather map off, at solar noon on the June solstice; sky box, sky atmosphere and sun hidden over black; the viewer's own render loop stopped and 90 frames rendered at the fixed clock.",
  declaredBy: "probe-cloud-tod",
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
    cloudCoverage: 0.5,
    cloudWeatherMap: false,
    cloudDensity: 0.75,
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
