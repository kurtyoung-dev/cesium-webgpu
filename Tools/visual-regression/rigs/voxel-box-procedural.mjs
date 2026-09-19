// Rig record for the wave-end scene "voxel-box-procedural" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "voxel-box-procedural" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-box-procedural",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT (C18-V2) — asset-free procedural BOX-shape VoxelPrimitive, single root tile (availableLevels=1), 4x4x4 VEC4/FLOAT32 cells whose colour is a pure function of the cell index, scaled to the WGS84 radius by the provider's globalTransform. Globe/sky/sun/moon hidden, opaque black background, clock pinned, camera fixed off-axis at ~8.5 Earth radii so the box reads as a bounded 3-D silhouette rather than a full-frame fill. Camera lives in the setup file, not here, because it is an ECEF pose with an explicit direction/up rather than a lon/lat/height. Readiness is gated on root-tile delivery through this scene's own provider plus a fixed number of post-delivery frames per viewer, NOT on VoxelPrimitive.ready — that flag is permanently false on WebGPU (VoxelPrimitive.update returns on the feature-renderer branch before the afterRender hook that sets it), which is what made this scene's first run time out. EXPECTED MISMATCH: unknown. The only recorded cross-backend voxel evidence is probe-voxel-parity's footprint IoU plus colour-structure overlap — a different metric with no mismatched-pixel-ratio equivalent — so no threshold is overridden here and the crossBackend gate runs at the suite default. The first run of this scene is the first measurement of the voxel path in this metric; replace the UNMEASURED expectation with the measured prediction once it exists.",
  camera: {
    position: [38268822, 28701616.5, 25512548],
    direction: [-0.7058823529411765, -0.5294117647058824, -0.47058823529411764],
    up: [0, 0, 1],
  },
  clock: "2026-06-01T18:00:00Z",
  setupFile: "scenes/subsystem-parity-setup.js",
  setupParams: {
    subsystem: "voxel",
    sceneName: "voxel-box-procedural",
    pinnedTimeIso: "2026-06-01T18:00:00Z",
    voxelDimension: 4,
  },
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  expectedMismatch: [
    {
      gate: "crossBackend",
      expect: "UNMEASURED",
      trackedBy: "VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT",
      rationale:
        "The voxel path has never been compared cross-backend in the capture-and-diff mismatched-pixel-ratio metric. probe-voxel-parity gates on footprint IoU and colour-structure overlap instead, and transcribing one of its numbers into a pixel-ratio threshold would be fabricating a derivation. The run records the first honest value.",
    },
  ],
  legacyOrder: 7,
  legacyExtraOrder: ["setupFile", "setupParams"],
});
