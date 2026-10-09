// Rig record for the C11-169 globe camera-track scene (probe-c11-169-primitive-breakdown.mjs).
//
// @purpose Rig record for the C11-169 CPU-breakdown scene: the offline WebGPU viewer at 1280x720 flown along the orbit-to-ground camera track of lib/globe-camera-track.mjs.
// @status ACTIVE
//
// `page: null` because the camera is moved along the track in-page by the
// probe; `cameraTrack` names the track (`GLOBE_CAMERA_TRACK_ID`) rather than
// copying its waypoints, so the track keeps one home. The 18-frame settle is
// the probe's `ROUTE_START_PRIME_FRAMES`.

export default Object.freeze({
  id: "c11-globe-camera-track",
  tags: ["c11"],
  page: null,
  renderers: ["webgpu"],
  description:
    "C11-169 CPU-breakdown scene: the offline viewer on WebGPU at 1280x720, flown along the orbit-to-ground global camera track while nested CPU timers run.",
  cameraTrack: "orbit-to-ground-global-v1",
  camera: null,
  clock: null,
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 18,
  },
});
