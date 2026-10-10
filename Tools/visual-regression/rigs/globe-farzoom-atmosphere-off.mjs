// Rig record for probe-globe-farzoom.mjs's "globe-farzoom-atmosphere-off" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-farzoom.mjs's "globe-farzoom-atmosphere-off" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-farzoom-atmosphere-off",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The 25,000 km polar view with ground atmosphere switched off on both renderers, the arm that showed the far-zoom interior blobs come from the ground-atmosphere drape (its atmosphere-on arm is globe-polar-far).",
  camera: {
    lon: -95,
    lat: 40,
    height: 25000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T08:00:00Z",
  dials: {
    pinClock: true,
    cameraInputs: false,
    showGroundAtmosphere: false,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
