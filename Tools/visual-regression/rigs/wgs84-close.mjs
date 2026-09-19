// Rig record for the wave-end scene "wgs84-close" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "wgs84-close" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "wgs84-close",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Batch 56 close-zoom regression coverage — WGS84 EllipsoidTerrainProvider at 1 Mm altitude (within the per-vertex regime). Verifies we didn't regress close-zoom by making ground atmosphere unconditionally per-fragment.",
  camera: {
    lon: -100,
    lat: 40,
    height: 1000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  setupFile: "scenes/wgs84-setup.js",
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 4,
  legacyExtraOrder: ["setupFile"],
});
