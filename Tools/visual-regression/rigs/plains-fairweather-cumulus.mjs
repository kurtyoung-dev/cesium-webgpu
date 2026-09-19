// Rig record for the cloud-tour fixture "plains-fairweather-cumulus" (midlatitude-continental/humilis-scattered), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "plains-fairweather-cumulus" (midlatitude-continental/humilis-scattered), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "plains-fairweather-cumulus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The fork's historical cloud anchor (-95/39). Fair-weather cumulus over a dry continental boundary layer: sparse, high-contrast, and the one scene every prior cloud probe shares, so its evidence is comparable to the whole existing corpus.",
  climate: "midlatitude-continental",
  region: "north-american-great-plains",
  formation: "humilis-scattered",
  cloudGenus: "CUMULUS",
  camera: {
    lon: -95,
    lat: 39,
    height: 800,
    heading: 0,
    pitch: 0.17453292519943295,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudType: 0,
    cloudCoverage: 0.35,
    cloudDensity: 0.7,
    cloudLayerBottom: 1500,
    cloudLayerTop: 3200,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.02,
    why: "The original floor, restored 2026-08-01 when CLOUD-LOW-COVERAGE-CUTOFF closed. Its ceiling pinned a renderer defect — the coverage->density gate thresholded a base noise whose support stops at 0.718, so coverage 0.35 rendered EXACTLY zero cloud (sweep: 0 at <= 0.40, 0.0009 at 0.45) — and the re-derived response (cloudEffectiveCoverage, CloudDensityDomain.wgsl) now puts this fixture at roughly 40% of the tradewind anchor's sky cover with ~80% of its peak density. A sparse fair-weather deck sits below the denser fixtures' floors, hence 0.02 rather than their 0.03-0.05.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: -95,
      lat: 39,
      height: 800,
      heading: 0,
      pitch: 10,
      geography: "mid-latitude-continental",
    },
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: -95,
      lat: 39,
      height: 2300,
      heading: 0,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -95,
      lat: 39,
      height: 9000,
      heading: 20,
      pitch: -25,
    },
    {
      id: "orbit",
      regime: "orbital",
      lon: -95,
      lat: 39,
      height: 18000000,
      heading: 0,
      pitch: -90,
      orbitalKind: "nadir",
    },
    {
      id: "crosswind-view",
      regime: "above-deck",
      lon: -95,
      lat: 39,
      height: 9000,
      heading: 0,
      pitch: -25,
      crosswind: true,
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
