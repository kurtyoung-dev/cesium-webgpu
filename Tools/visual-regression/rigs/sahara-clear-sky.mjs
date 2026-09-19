// Rig record for the cloud-tour fixture "sahara-clear-sky" (subtropical-desert/suppressed-near-clear), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "sahara-clear-sky" (subtropical-desert/suppressed-near-clear), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "sahara-clear-sky",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The NEGATIVE-SPACE control. A climate whose correct answer is 'almost no cloud' is the only way to tell a working tour from one that always reports cloud. Its gate is a CEILING, not a floor: a large contribution here is the defect.",
  climate: "subtropical-desert",
  region: "central-sahara",
  formation: "suppressed-near-clear",
  cloudGenus: "CUMULUS",
  camera: {
    lon: 12,
    lat: 24,
    height: 600,
    heading: 0,
    pitch: 0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T11:12:00Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.05,
    cloudDensity: 0.3,
    cloudLayerBottom: 2500,
    cloudLayerTop: 4200,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    maxChangedFraction: 0.02,
    why: "CEILING, not a floor. This climate is suppressed at 5% coverage; a large contribution here means the tour reports cloud where the configuration asks for almost none.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: 12,
      lat: 24,
      height: 600,
      heading: 0,
      pitch: 20,
      geography: "arid",
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: 12,
      lat: 24,
      height: 12000,
      heading: 0,
      pitch: -30,
    },
  ],
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 8,
  },
});
