// Rig record for the cloud-tour fixture "pacificnw-dawn-valley-stratus" (temperate-continental-dawn-fog/valley-radiation-fog-dawn), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
//
// @purpose Rig record for the cloud-tour fixture "pacificnw-dawn-valley-stratus" (temperate-continental-dawn-fog/valley-radiation-fog-dawn), generalising lib/cloud-tour-fixtures.mjs's fixture shape.
// @status ACTIVE

export default Object.freeze({
  id: "pacificnw-dawn-valley-stratus",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "DAWN coverage (O2/G3's 0-degree-sun-elevation case) plus the TERMINATOR-CROSSING orbital station. Radiation fog forms on calm, clear nights via surface radiative cooling — most reliable in winter but not exclusive to it, so a June dawn occurrence in a still inland valley is physically plausible. localSolarHour 6.0 puts the anchor AT the terminator by construction (utcIsoForLocalSolarHour(lon, 6)), which is what the orbital station below needs to see both hemispheres in one frame.",
  climate: "temperate-continental-dawn-fog",
  region: "pacific-northwest-willamette-valley",
  formation: "valley-radiation-fog-dawn",
  cloudGenus: "STRATUS",
  camera: {
    lon: -123,
    lat: 44.5,
    height: 3000,
    heading: 1.5707963267948966,
    pitch: -0.3490658503988659,
    roll: 0,
  },
  clock: "2026-06-21T14:12:00Z",
  dials: {
    cloudType: 7,
    cloudCoverage: 0.8,
    cloudDensity: 0.45,
    cloudLayerBottom: 50,
    cloudLayerTop: 400,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  gate: {
    minChangedFraction: 0.015,
    why: "UNCALIBRATED pending an Edge run. Set above the night floor (0.001) because the sun is AT the horizon rather than well below it — direct light exists, just at grazing incidence — but below the arctic/antarctic daytime stratus floor (0.02) because a 0-degree sun elevation is dimmer than the polar-day stations' higher sun angle. Revisit after the first real run the same way every other floor in this table has been.",
  },
  stations: [
    {
      id: "dawn-valley-view",
      regime: "above-deck",
      lon: -123,
      lat: 44.5,
      height: 3000,
      heading: 90,
      pitch: -20,
    },
    {
      id: "terminator-crossing-orbit",
      regime: "orbital",
      lon: -123,
      lat: 44.5,
      height: 10000000,
      heading: 0,
      pitch: -90,
      orbitalKind: "terminator-crossing",
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
