// Rig record for the C11-13 voxel camera-inside scene (probe-c11-13-voxel-inside-camera.mjs).
//
// @purpose Rig record for the C11-13 voxel camera-inside scene: the harness page, its seven-waypoint ladder and the capture conditions the probe uses.
// @status ACTIVE
//
// `page: null` because the scene's state is driven inside the harness page
// (`__c1113VoxelInsideHarness.prepareWaypoint(id)`), which `capture()` has no
// step for; the probe drives it. `harness` and `states` are documentary and
// match the probe's own `WAYPOINTS` (c11-rigs.spec.mjs pins that).

export default Object.freeze({
  id: "c11-voxel-inside-camera",
  tags: ["c11"],
  page: null,
  harness: "Tools/visual-regression/c11-13-voxel-inside-camera-harness.html",
  renderers: ["webgl", "webgpu"],
  description:
    "C11-13 voxel camera-inside scene: a procedural voxel box drawn by a green custom shader, seen from a seven-waypoint ladder that starts outside, enters the volume on both sides and returns outside, on both backends.",
  states: Object.freeze([
    "outside-positive-initial",
    "inside-positive-near",
    "inside-positive-deep",
    "inside-negative-deep",
    "inside-negative-near",
    "outside-negative",
    "outside-positive-return",
  ]),
  camera: null,
  clock: null,
  viewport: {
    width: 960,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 8,
  },
});
