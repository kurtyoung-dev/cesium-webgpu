// Rig record for the wave-end scene "gsplat-sh-unit-cube" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "gsplat-sh-unit-cube" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "gsplat-sh-unit-cube",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT (C18-V2) — the in-tree Specs/Data sh_unit_cube Gaussian-splat tileset (27 splats, SH degree 3, not georeferenced), framed from its own bounding sphere at range = 2x radius, pitch -30 deg. Globe hidden because the tileset sits at the geocentre. The setup waits on three separate signals before the capture: tile content readiness, the splat data commit, and sort quiescence — the last because a scene still re-ordering itself cannot reproduce its own baseline between runs. EXPECTED MISMATCH: none. C15-G5 (Batch 895) measured this asset's cross-backend mismatch at 0.000% under exact per-channel equality; the suite's tolerance-16 comparison can only be looser, so the suite-default 2% ceiling is not a tuned number and PASS is a falsifiable prediction rather than an accommodation.",
  camera: null,
  clock: "2026-06-01T18:00:00Z",
  setupFile: "scenes/subsystem-parity-setup.js",
  setupParams: {
    subsystem: "gsplat",
    sceneName: "gsplat-sh-unit-cube",
    pinnedTimeIso: "2026-06-01T18:00:00Z",
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
      expect: "PASS",
      trackedBy: "C15-G8",
      rationale:
        "Derived, not assumed: after C15-G5 landed spherical harmonics in WGSL, Batch 895 measured sh_unit_cube at 0.000% cross-backend mismatch under exact per-channel equality on probe-gsplat-parity, and this suite's per-channel tolerance of 16 is strictly more forgiving. The caveats are the page (split-screen viewers, different canvas size and post-process state) rather than the renderer, so a FAIL here is a finding to file, not a threshold to widen.",
    },
  ],
  legacyOrder: 9,
  legacyExtraOrder: ["setupFile", "setupParams"],
});
