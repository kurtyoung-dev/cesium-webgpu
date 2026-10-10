// Rig record for probe-globe-underground.mjs's "globe-underground-default" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-underground.mjs's "globe-underground-default" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-underground-default",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The same underground camera with the upstream default underground look (black colour, default near-far alpha ramp); only the camera moves.",
  camera: {
    lon: -75.60032002513455,
    lat: 40.0383881265671,
    height: -30000,
    heading: 0.4,
    pitch: 0.25,
    roll: 0,
  },
  clock: "2026-06-21T08:00:00Z",
  dials: {
    dampSky: true,
    collisionDetection: false,
  },
  viewport: {
    width: 1024,
    height: 640,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
