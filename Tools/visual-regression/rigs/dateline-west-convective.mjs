// Rig record for the cloud-tour fixture "dateline-west-convective" (tropical-maritime-tradewind/broken-oceanic), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "dateline-west-convective" (tropical-maritime-tradewind/broken-oceanic), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "dateline-west-convective",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "WESTWARD dateline crossing (-179.6 looking west through -180), the twin of the eastward fixture. Same volumetric configuration and the same pinned instant by construction; only the crossing direction differs, so any east/west asymmetry in the result is the wrap and nothing else.",
  climate: "tropical-maritime-tradewind",
  region: "west-pacific-west-of-antimeridian",
  formation: "broken-oceanic",
  cloudGenus: "CUMULUS",
  camera: {
    lon: -179.6,
    lat: 8,
    height: 9000,
    heading: 4.71238898038469,
    pitch: -0.08726646259971647,
    roll: 0,
  },
  clock: "2026-06-21T23:58:24Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.6,
    cloudDensity: 0.85,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.03,
    why: "Broken oceanic convection at 60% coverage. Shared verbatim with the eastern twin so the pair is judged by one rule.",
  },
  stations: [
    {
      id: "horizon-west",
      regime: "above-deck",
      lon: -179.6,
      lat: 8,
      height: 9000,
      heading: 270,
      pitch: -5,
    },
    {
      id: "crossed-west",
      regime: "above-deck",
      lon: -180.4,
      lat: 8,
      height: 9000,
      heading: 270,
      pitch: -5,
      geography: "antimeridian-west",
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
