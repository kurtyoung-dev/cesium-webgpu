// Rig record for the cloud-tour fixture "sepacific-stratocumulus-closed" (subtropical-marine-eastern-boundary/closed-cell-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "sepacific-stratocumulus-closed" (subtropical-marine-eastern-boundary/closed-cell-sheet), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "sepacific-stratocumulus-closed",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The planet's most persistent cloud deck: a shallow, near-solid stratocumulus sheet capped by a subsidence inversion. A 600-1400 m deck is thin enough that the inside-deck regime is a genuinely narrow band, which is where deck-bound interval math fails first.",
  climate: "subtropical-marine-eastern-boundary",
  region: "southeast-pacific-off-peru",
  formation: "closed-cell-sheet",
  cloudGenus: "STRATOCUMULUS",
  camera: {
    lon: -80,
    lat: -20,
    height: 200,
    heading: 4.71238898038469,
    pitch: 0.2617993877991494,
    roll: 0,
  },
  clock: "2026-06-21T14:20:00Z",
  dials: {
    cloudType: 8,
    cloudCoverage: 0.9,
    cloudDensity: 0.8,
    cloudLayerBottom: 600,
    cloudLayerTop: 1400,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.08,
    why: "A 90%-coverage closed-cell sheet is the highest-coverage low deck in the set; its floor is correspondingly the highest of the low-cloud fixtures.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: -80,
      lat: -20,
      height: 200,
      heading: 270,
      pitch: 15,
    },
    {
      id: "in-deck",
      regime: "inside-deck",
      lon: -80,
      lat: -20,
      height: 1000,
      heading: 270,
      pitch: 0,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -80,
      lat: -20,
      height: 5000,
      heading: 270,
      pitch: -25,
    },
    {
      id: "cruise-10km",
      regime: "above-deck",
      lon: -80,
      lat: -20,
      height: 10000,
      heading: 270,
      pitch: -8,
      inAtmosphere: "cruise-above-deck-10km",
    },
    {
      id: "traverse-start",
      regime: "above-deck",
      lon: -80,
      lat: -20,
      height: 9000,
      heading: 270,
      pitch: -3,
      inAtmosphere: "forward-traverse-100ms",
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
