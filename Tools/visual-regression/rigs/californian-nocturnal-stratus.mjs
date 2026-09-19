// Rig record for the cloud-tour fixture "californian-nocturnal-stratus" (coastal-marine-nocturnal/nocturnal-marine-layer), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "californian-nocturnal-stratus" (coastal-marine-nocturnal/nocturnal-marine-layer), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "californian-nocturnal-stratus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "NIGHT coverage (O2/dusk-dawn band gap): a coastal marine stratus deck is driven by the subsidence inversion over cold upwelled water, not by solar heating, so it persists — often thickens — after dark. Two stations at deep night (01:30 local) give the row's required 2 night-band stations without inventing a scene the real atmosphere would not produce at that hour.",
  climate: "coastal-marine-nocturnal",
  region: "eastern-pacific-california-coast",
  formation: "nocturnal-marine-layer",
  cloudGenus: "STRATUS",
  camera: {
    lon: -123.5,
    lat: 37,
    height: 100,
    heading: 4.71238898038469,
    pitch: 0.17453292519943295,
    roll: 0,
  },
  clock: "2026-06-21T09:44:00Z",
  dials: {
    cloudType: 7,
    cloudCoverage: 0.85,
    cloudDensity: 0.5,
    cloudLayerBottom: 200,
    cloudLayerTop: 900,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.001,
    why: "UNCALIBRATED pending an Edge run (this worker has no browser). Set below the cirrus floor (0.002, previously the lowest-illumination case) because night removes the direct solar term entirely and only moon/ambient light remains, which this table cannot bound without actually rendering a frame. Revisit exactly as southern-ocean-stratocumulus-open's floor was revised 0.03->0.012 after its first real run: tighten if the first run measures higher, lower it further if it measures lower.",
  },
  stations: [
    {
      id: "ground-lookup",
      regime: "ground",
      lon: -123.5,
      lat: 37,
      height: 100,
      heading: 270,
      pitch: 10,
    },
    {
      id: "above-deck",
      regime: "above-deck",
      lon: -123.5,
      lat: 37,
      height: 6000,
      heading: 270,
      pitch: -25,
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
