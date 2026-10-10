// Rig record for probe-globe-underground.mjs's "globe-underground-red" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-underground.mjs's "globe-underground-red" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-underground-red",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Camera 30 km below the surface near Philadelphia looking gently up, with a red underground colour and an alpha-by-distance ramp from 0.4 at 1 km to 1.0 at 400 km; collision detection off.",
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
    undergroundColor: [0.9, 0.05, 0.05, 1],
    undergroundColorAlphaByDistance: {
      near: 1000,
      nearValue: 0.4,
      far: 400000,
      farValue: 1,
    },
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
