// Rig record for the C13-N04b orbital ladder rung at 2000 km (lib/cloud-orbital-ladder-model.mjs ALTITUDE_LADDER_METRES).
//
// @purpose Rig record for the C13-N04b orbital ladder rung at 2000 km (lib/cloud-orbital-ladder-model.mjs ALTITUDE_LADDER_METRES).
// @status ACTIVE

export default Object.freeze({
  id: "orbital-ladder-2000km",
  tags: ["orbital-ladder"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "C13-N04b orbital ladder rung at 2000 km over the shared LADDER_ANCHOR — one of four decades from 20 km to 20,000 km measuring O3/O4/O6/O7 at this altitude.",
  altitudeMetres: 2000000,
  camera: {
    lon: -95,
    lat: 20,
    height: 2000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T18:20:00Z",
  dials: {
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudWindSpeed: 0,
    cloudWeatherMap: false,
    cloudVolumetricQuality: "high",
  },
  viewport: {
    width: 1024,
    height: 1024,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
