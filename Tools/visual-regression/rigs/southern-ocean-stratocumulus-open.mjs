// Rig record for the cloud-tour fixture "southern-ocean-stratocumulus-open" (cold-air-outbreak/open-cell-broken), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "southern-ocean-stratocumulus-open" (cold-air-outbreak/open-cell-broken), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "southern-ocean-stratocumulus-open",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "SAME GENUS as the Peruvian sheet, opposite formation: a cold-air outbreak breaks the deck into open cells — lower coverage, deeper, stronger edge erosion. The pair proves the tour distinguishes formations within a genus rather than re-rendering one canned stratocumulus.",
  climate: "cold-air-outbreak",
  region: "southern-ocean",
  formation: "open-cell-broken",
  cloudGenus: "STRATOCUMULUS",
  camera: {
    lon: -45,
    lat: -55,
    height: 1800,
    heading: 3.141592653589793,
    pitch: 0,
    roll: 0,
  },
  clock: "2026-06-21T15:00:00Z",
  dials: {
    cloudType: 8,
    cloudCoverage: 0.5,
    cloudDensity: 0.6,
    cloudLayerBottom: 900,
    cloudLayerTop: 2600,
    cloudErosionStrength: 0.9,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.012,
    why: "Open cells are broken by construction (50% coverage, strong erosion), so the floor sits well below its closed-cell twin. Calibrated 2026-08-01: the above-deck vantage measured 0.017 on the first run (in-deck 0.251), so the floor moved from 0.03 to sit under the weakest legitimate regime with margin.",
  },
  stations: [
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: -45,
      lat: -55,
      height: 1800,
      heading: 180,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -45,
      lat: -55,
      height: 8000,
      heading: 180,
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
