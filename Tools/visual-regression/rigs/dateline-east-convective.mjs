// Rig record for the cloud-tour fixture "dateline-east-convective" (tropical-maritime-tradewind/broken-oceanic), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "dateline-east-convective" (tropical-maritime-tradewind/broken-oceanic), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "dateline-east-convective",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "EASTWARD dateline crossing (+179.6 looking east through +180). Paired with its western twin so the crossing is exercised in BOTH directions with an otherwise identical configuration — a wrap bug that is sign-dependent shows up as an asymmetry between the pair, which a single crossing cannot reveal.",
  climate: "tropical-maritime-tradewind",
  region: "west-pacific-east-of-antimeridian",
  formation: "broken-oceanic",
  cloudGenus: "CUMULUS",
  camera: {
    lon: 179.6,
    lat: 8,
    height: 9000,
    heading: 1.5707963267948966,
    pitch: -0.08726646259971647,
    roll: 0,
  },
  clock: "2026-06-21T00:01:36Z",
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
    why: "Broken oceanic convection at 60% coverage. Shared verbatim with the western twin so the pair is judged by one rule.",
  },
  stations: [
    {
      id: "horizon-east",
      regime: "above-deck",
      lon: 179.6,
      lat: 8,
      height: 9000,
      heading: 90,
      pitch: -5,
    },
    {
      id: "crossed-east",
      regime: "above-deck",
      lon: 180.4,
      lat: 8,
      height: 9000,
      heading: 90,
      pitch: -5,
      geography: "antimeridian-east",
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
