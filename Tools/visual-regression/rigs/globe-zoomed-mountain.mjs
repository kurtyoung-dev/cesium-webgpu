// Rig record for the wave-end scene "globe-zoomed-mountain" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "globe-zoomed-mountain" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "globe-zoomed-mountain",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Close zoom on a mountainous region — exercises terrain LOD + lighting",
  camera: {
    lon: -119.5383,
    lat: 37.8651,
    height: 12000,
    heading: 0,
    pitch: -0.6,
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
  legacyOrder: 1,
  legacyExtraOrder: [],
});
