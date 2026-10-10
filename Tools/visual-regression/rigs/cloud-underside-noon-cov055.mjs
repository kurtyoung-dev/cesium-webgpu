// Rig record for the cloud-family probe-kit harvest (round 1): the scene these probes declared, re-declared as data.
//
// @purpose Rig record for the baked-tier underside scene the Batch 397 and 398 byte-identity A/Bs captured: coverage 0.55, density 0.8, black sky, solar noon.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-underside-noon-cov055",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) under the deck, heading east and pitched 16 degrees up, at solar noon on the June solstice; sky box, sky atmosphere and sun hidden over a black background; weather map off, coverage 0.55, density 0.8; the viewer's own render loop stopped and 90 frames rendered at the fixed clock.",
  declaredBy: "probe-cloud-tier-resolver, probe-cloud-noisebake",
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
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
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
