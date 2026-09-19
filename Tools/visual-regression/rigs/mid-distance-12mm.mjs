// Rig record for the wave-end scene "mid-distance-12mm" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "mid-distance-12mm" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "mid-distance-12mm",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Mid-distance coverage at 12 Mm altitude — sits inside the lightingFade ramp where the per-fragment drape is most visible. Uses the default Cesium terrain provider (not WGS84). Catches drape brightness regressions that close-zoom and full-orbit probes can miss.",
  camera: {
    lon: -100,
    lat: 40,
    height: 12000000,
    heading: 0,
    pitch: -1.5707963267948966,
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
  legacyOrder: 5,
  legacyExtraOrder: [],
});
