// Rig record for the wave-end scene "wgs84-orbit" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "wgs84-orbit" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "wgs84-orbit",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Batch 56 regression coverage — WGS84 EllipsoidTerrainProvider + default Bing aerial at orbit altitude. Before Batch 56 this rendered as black wedges with a mesh-pattern artifact (per-vertex ground atmosphere math). The scene's `setupFile` swaps both viewers to WGS84, then waits for settle. Camera at 20 Mm over North America.",
  camera: {
    lon: -100,
    lat: 40,
    height: 20000000,
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
  legacyOrder: 3,
  legacyExtraOrder: ["setupFile"],
});
