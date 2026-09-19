// Rig record for the cloud-tour fixture "bengal-monsoon-nimbostratus" (monsoon/overcast-rain-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "bengal-monsoon-nimbostratus" (monsoon/overcast-rain-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "bengal-monsoon-nimbostratus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The densest genus profile (baseDensity 0.95 / extinction 0.9). An overcast rain sheet is the saturated end of the density domain, where a march that terminates early and a march that saturates look alike from one screenshot and differ in the OFF/ON contribution metric.",
  climate: "monsoon",
  region: "bay-of-bengal",
  formation: "overcast-rain-sheet",
  cloudGenus: "NIMBOSTRATUS",
  camera: {
    lon: 88,
    lat: 18,
    height: 300,
    heading: 1.5707963267948966,
    pitch: 0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T05:08:00Z",
  dials: {
    cloudType: 6,
    cloudCoverage: 0.95,
    cloudDensity: 0.95,
    cloudLayerBottom: 700,
    cloudLayerTop: 6000,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.1,
    why: "An overcast rain sheet at 95% coverage should dominate every station view; a low number here means saturation or early march termination, not thin cloud.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: 88,
      lat: 18,
      height: 300,
      heading: 90,
      pitch: 20,
    },
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: 88,
      lat: 18,
      height: 3000,
      heading: 90,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: 88,
      lat: 18,
      height: 11000,
      heading: 90,
      pitch: -25,
    },
    {
      id: "tropical-land-view",
      regime: "ground",
      lon: 87.5,
      lat: 23.5,
      height: 300,
      heading: 90,
      pitch: 20,
      geography: "tropical-land",
    },
    {
      id: "between-decks",
      regime: "above-deck",
      lon: 88,
      lat: 18,
      height: 8000,
      heading: 90,
      pitch: -15,
      inAtmosphere: "between-decks-approx",
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
