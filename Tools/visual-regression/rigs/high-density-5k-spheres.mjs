// Rig record for the wave-end scene "high-density-5k-spheres" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "high-density-5k-spheres" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "high-density-5k-spheres",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Batch 224 (NEW-VR-BASELINE-HIGH-DENSITY) — procedurally generated 5K-sphere instance scene that crosses the gpuCuller activation threshold (HI=384) and HiZ threshold (HI=2400). Verifies that the threshold-gated dispatchers introduced in Batches 209-218 produce visually identical output to the unmodified WebGL pipeline. Uses Scene.gpuCullingHint = 'always' on WebGPU so the eager warm-up amortizes pipeline-compile cost into the load frame instead of the first-cross frame.",
  camera: {
    lon: -122.4194,
    lat: 37.7749,
    height: 300000,
    heading: 0,
    pitch: -0.7,
    roll: 0,
  },
  clock: null,
  setupFile: "scenes/high-density-5k-spheres-setup.js",
  setupParams: {
    centerLongitude: -122.4194,
    centerLatitude: 37.7749,
    centerHeight: 50000,
    spreadMeters: 200000,
    instanceCount: 5000,
    sphereRadius: 1000,
    rngSeed: 1234567,
  },
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 6,
  legacyExtraOrder: ["setupParams", "setupFile"],
});
