// Rig record for the cloud-tour fixture "antarctic-stratus-plateau" (polar-continental/shallow-ice-stratus), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "antarctic-stratus-plateau" (polar-continental/shallow-ice-stratus), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "antarctic-stratus-plateau",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "SOUTH-POLE approach and the SAME GENUS as the Arctic fixture in the opposite hemisphere. It is pinned to the DECEMBER solstice, not the shared June one: at -78 latitude in June the sun never rises, so a June-locked southern fixture would measure polar night and its blank frame would be correct — useless as a pole-geometry oracle. December puts the same geometry in polar DAY.",
  climate: "polar-continental",
  region: "antarctic-plateau",
  formation: "shallow-ice-stratus",
  cloudGenus: "STRATUS",
  camera: {
    lon: -45,
    lat: -78,
    height: 20000,
    heading: 3.141592653589793,
    pitch: -0.5235987755982988,
    roll: 0,
  },
  clock: "2026-06-21T15:00:00Z",
  dials: {
    cloudType: 7,
    cloudCoverage: 0.65,
    cloudDensity: 0.45,
    cloudLayerBottom: 400,
    cloudLayerTop: 1600,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.02,
    why: "Polar DAY at the December solstice (see the rationale); matched to its Arctic twin so an asymmetry between the poles is visible as a gate result.",
  },
  stations: [
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -45,
      lat: -78,
      height: 20000,
      heading: 180,
      pitch: -30,
    },
    {
      id: "pole-approach",
      regime: "above-deck",
      lon: -45,
      lat: -89.5,
      height: 20000,
      heading: 180,
      pitch: -30,
      geography: "south-pole",
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
