// Rig record for the wave-end scene "globe-horizon" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "globe-horizon" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "globe-horizon",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description: "Low-angle horizon shot — exercises atmosphere, fog, sky",
  camera: {
    lon: -122.4,
    lat: 37.7,
    height: 80000,
    heading: 0,
    pitch: -0.15,
    roll: 0,
  },
  clock: null,
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 2,
  legacyExtraOrder: [],
});
