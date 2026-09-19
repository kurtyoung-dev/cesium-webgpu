// Rig record for the cloud-tour fixture "benguela-dusk-stratocumulus" (subtropical-marine-eastern-boundary/dusk-closed-cell-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "benguela-dusk-stratocumulus" (subtropical-marine-eastern-boundary/dusk-closed-cell-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "benguela-dusk-stratocumulus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "DUSK-INSIDE-CLOUD coverage (O2/G3's civil-twilight case): the Benguela deck is the Southern Hemisphere twin of the Peru closed-cell sheet already in this table, at 18:45 local — just past sunset. Both stations sit inside the deck (the row's explicit 'dusk INSIDE-CLOUD' wording) looking in different directions, so one frames the low-sun/afterglow side and the other frames away from it.",
  climate: "subtropical-marine-eastern-boundary",
  region: "namibian-coast-benguela",
  formation: "dusk-closed-cell-sheet",
  cloudGenus: "STRATOCUMULUS",
  camera: {
    lon: 12,
    lat: -23,
    height: 900,
    heading: 4.71238898038469,
    pitch: 0,
    roll: 0,
  },
  clock: "2026-06-21T17:57:00Z",
  dials: {
    cloudType: 8,
    cloudCoverage: 0.85,
    cloudDensity: 0.75,
    cloudLayerBottom: 500,
    cloudLayerTop: 1300,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.01,
    why: "UNCALIBRATED pending an Edge run. Civil twilight (sun ~2 degrees below the horizon) still carries measurable skylight, so the floor sits above the deep-night floor (0.001) but below the daytime closed-cell floor (0.08) for the same formation family — dusk illumination is a fraction of full day, not its equal.",
  },
  stations: [
    {
      id: "inside-deck-sunsetward",
      regime: "inside-deck",
      lon: 12,
      lat: -23,
      height: 900,
      heading: 270,
      pitch: 0,
    },
    {
      id: "inside-deck-zenith",
      regime: "inside-deck",
      lon: 12,
      lat: -23,
      height: 900,
      heading: 0,
      pitch: 30,
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
