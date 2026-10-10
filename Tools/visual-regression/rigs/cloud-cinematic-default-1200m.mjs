// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 432 full-res parity scene: the cinematic tier at its defaults, sky, sun, atmosphere and globe shown, one fixed clock and camera.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-cinematic-default-1200m",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Ground view at 1,200 m over the fork's cloud anchor (-95, 39), heading north and pitched 12 degrees up, at 18:20 UTC on the June solstice; sky box, sun, sky atmosphere and globe shown; a 1,500-3,800 m deck at coverage 0.45 and density 0.75 on the high (cinematic, full-resolution) tier; 200 settle frames.",
  declaredBy: "probe-cloud-halfres-parity",
  camera: {
    lon: -95,
    lat: 39,
    height: 1200,
    heading: 0,
    pitch: 0.20943951023931956,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.45,
    cloudDensity: 0.75,
    cloudLayerBottom: 1500,
    cloudLayerTop: 3800,
    cloudVolumetricQuality: "high",
    skyBoxShow: true,
    sunShow: true,
    skyAtmosphereShow: true,
    globeShow: true,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 200,
  },
});
