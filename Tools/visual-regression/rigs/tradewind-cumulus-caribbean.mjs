// Rig record for the cloud-tour fixture "tradewind-cumulus-caribbean" (tropical-maritime-tradewind/tradewind-mediocris), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "tradewind-cumulus-caribbean" (tropical-maritime-tradewind/tradewind-mediocris), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "tradewind-cumulus-caribbean",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "SAME GENUS as the plains fixture, different formation: a moist maritime trade-wind cumulus field sits lower, is more numerous and less eroded. Two cumulus fixtures that differ only in their formation parameters are the row's 'multiple same-type formations'.",
  climate: "tropical-maritime-tradewind",
  region: "caribbean-sea",
  formation: "tradewind-mediocris",
  cloudGenus: "CUMULUS",
  camera: {
    lon: -65,
    lat: 17,
    height: 300,
    heading: 0.7853981633974483,
    pitch: 0.20943951023931953,
    roll: 0,
  },
  clock: "2026-06-21T14:20:00Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.55,
    cloudDensity: 0.85,
    cloudLayerBottom: 700,
    cloudLayerTop: 2400,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.03,
    why: "Denser and lower than the plains field, so its floor is higher; a trade-wind deck that reads below 3% is not the formation this fixture names.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: -65,
      lat: 17,
      height: 300,
      heading: 45,
      pitch: 12,
    },
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: -65,
      lat: 17,
      height: 1500,
      heading: 45,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -65,
      lat: 17,
      height: 6000,
      heading: 45,
      pitch: -20,
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
