// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the W4 aerial-perspective gate, near-deck leg, with the aerial blend at full strength.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-aerial-near-deck",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Camera 800 m above (-95, 39) heading east and pitched 16 degrees up under a 1,500-4,000 m deck at solar noon; coverage 0.55, density 0.8, weather map off, aerial strength 1; sky box, sky atmosphere and sun hidden over black; the viewer's own render loop stopped and 90 frames rendered at the fixed clock. The gate's second arm is this rig with the aerial strength at 0.",
  declaredBy: "probe-cloud-aerial",
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
    cloudWeatherMap: false,
    cloudDensity: 0.8,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudAerialStrength: 1,
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
