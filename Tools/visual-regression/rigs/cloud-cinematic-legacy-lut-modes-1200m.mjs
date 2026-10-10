// Rig record for the cloud-family probe-kit harvest (round 1): the scene this probe declared, re-declared as data.
//
// @purpose Rig record for the Batch 434 LUT parity scene: the cinematic default scene with the two atmosphere-LUT couplings named at their legacy values.
// @status ACTIVE

export default Object.freeze({
  id: "cloud-cinematic-legacy-lut-modes-1200m",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The cinematic default scene at 1,200 m over (-95, 39) with the aerial mode named as heuristic and the ambient source named as constant, the two values the Batch 434 parity capture exercised. Since 2026-09-16 the aerial mode's own default is auto, so this rig and the cinematic default rig are no longer the same scene.",
  declaredBy: "probe-cloud-lut-parity",
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
    cloudAerialMode: "heuristic",
    cloudAmbientSource: "constant",
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
