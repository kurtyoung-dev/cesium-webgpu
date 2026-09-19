// Rig record for the cloud-tour fixture "arctic-stratus-svalbard" (polar-marine/thin-polar-stratus), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "arctic-stratus-svalbard" (polar-marine/thin-polar-stratus), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "arctic-stratus-svalbard",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "NORTH-POLE approach, lit: at the June solstice the Arctic is in polar day, so a thin stratus deck at 82N is genuinely illuminated and a blank frame is a defect rather than night. Batch 735 replaced the pre-fix north-pole blank with green WGS84 evidence; this fixture keeps that checkpoint inside the tour.",
  climate: "polar-marine",
  region: "arctic-ocean-north-of-svalbard",
  formation: "thin-polar-stratus",
  cloudGenus: "STRATUS",
  camera: {
    lon: 20,
    lat: 82,
    height: 150,
    heading: 0,
    pitch: 0.2617993877991494,
    roll: 0,
  },
  clock: "2026-06-21T10:40:00Z",
  dials: {
    cloudType: 7,
    cloudCoverage: 0.75,
    cloudDensity: 0.55,
    cloudLayerBottom: 300,
    cloudLayerTop: 1200,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.02,
    why: "Polar DAY at the June solstice, so the deck is genuinely lit; Batch 735 turned this checkpoint from blank to green and the floor keeps it there.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: 20,
      lat: 82,
      height: 150,
      heading: 0,
      pitch: 15,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: 20,
      lat: 82,
      height: 20000,
      heading: 0,
      pitch: -30,
      geography: "polar",
    },
    {
      id: "pole-approach",
      regime: "above-deck",
      lon: 20,
      lat: 89.5,
      height: 20000,
      heading: 0,
      pitch: -30,
      geography: "north-pole",
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
