// Rig record for the cloud-tour fixture "northatlantic-cirrus-fibratus" (midlatitude-jetstream/fibratus-filaments), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "northatlantic-cirrus-fibratus" (midlatitude-jetstream/fibratus-filaments), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "northatlantic-cirrus-fibratus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The thinnest genus profile (baseDensity 0.15 / extinction 0.1) at a HIGH deck (8-11 km). Cirrus is the regime where a wispy correct render and a missing render differ by a few counts of luminance, which is exactly why the visibility oracle has to be an OFF/ON delta and not a bright-pixel count.",
  climate: "midlatitude-jetstream",
  region: "north-atlantic",
  formation: "fibratus-filaments",
  cloudGenus: "CIRRUS",
  camera: {
    lon: -30,
    lat: 45,
    height: 500,
    heading: 3.141592653589793,
    pitch: 0.6108652381980153,
    roll: 0,
  },
  clock: "2026-06-21T16:00:00Z",
  dials: {
    cloudType: 1,
    cloudCoverage: 0.45,
    cloudDensity: 0.35,
    cloudLayerBottom: 8000,
    cloudLayerTop: 11000,
    cloudSpecies: "fibratus",
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.002,
    why: "The thinnest genus in the set (extinction 0.1). A cirrus floor has to be an order of magnitude below the cumulus floors or it rejects a correct wispy render. HISTORY: pinned as a knownGapId ceiling 2026-08-01 when CIRRUS rendered ~nothing; the CLOUD-LOW-COVERAGE-CUTOFF fix restored visibility the same day (ground 0.0028, above-deck 0.0148) and the ceiling failed loudly as designed, flipping this back to the authored floor. Genus MORPHOLOGY (fibrous streaks vs generic puffs) remains C13-16.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: -30,
      lat: 45,
      height: 500,
      heading: 180,
      pitch: 35,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -30,
      lat: 45,
      height: 16000,
      heading: 180,
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
