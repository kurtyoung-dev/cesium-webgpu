// Rig record for the cloud-tour fixture "itcz-cumulonimbus-westpacific" (tropical-deep-convection/towering-anvil), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "itcz-cumulonimbus-westpacific" (tropical-deep-convection/towering-anvil), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "itcz-cumulonimbus-westpacific",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The deepest deck in the set (800-14000 m). Exercises the TOWER/anvil genus profile and a shell thick enough that the ground, inside-deck and above-deck regimes are far apart in march length, not just in altitude.",
  climate: "tropical-deep-convection",
  region: "west-pacific-warm-pool",
  formation: "towering-anvil",
  cloudGenus: "CUMULONIMBUS",
  camera: {
    lon: 150,
    lat: 5,
    height: 400,
    heading: 0,
    pitch: 0.4363323129985824,
    roll: 0,
  },
  clock: "2026-06-21T05:00:00Z",
  dials: {
    cloudType: 10,
    cloudCoverage: 0.7,
    cloudDensity: 0.95,
    cloudLayerBottom: 800,
    cloudLayerTop: 14000,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.05,
    why: "A 13 km deep, 70%-coverage tower field fills a large fraction of every station view; anything under 5% means the deck interval collapsed.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: 150,
      lat: 5,
      height: 400,
      heading: 0,
      pitch: 25,
      geography: "equatorial-maritime",
    },
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: 150,
      lat: 5,
      height: 6000,
      heading: 0,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: 150,
      lat: 5,
      height: 18000,
      heading: 0,
      pitch: -20,
    },
    {
      id: "orbit",
      regime: "orbital",
      lon: 150,
      lat: 5,
      height: 12000000,
      heading: 0,
      pitch: -90,
      orbitalKind: "nadir",
    },
    {
      id: "limb-view",
      regime: "orbital",
      lon: 150,
      lat: 5,
      height: 2000000,
      heading: 0,
      pitch: -40.43,
      orbitalKind: "limb",
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
