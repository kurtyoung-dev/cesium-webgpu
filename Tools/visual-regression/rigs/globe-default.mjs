// Rig record for the wave-end scene "globe-default" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "globe-default" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "globe-default",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description: "Default load: full globe centered, Bing imagery, no overlays",
  camera: null,
  clock: null,
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 0,
  legacyExtraOrder: [],
});
