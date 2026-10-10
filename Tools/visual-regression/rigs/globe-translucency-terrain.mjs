// Rig record for probe-globe-translucency.mjs's "globe-translucency-terrain" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-translucency.mjs's "globe-translucency-terrain" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-translucency-terrain",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Globe translucency at front-face alpha 0.5 seen from 60 km above terrain near Philadelphia at an oblique pitch, near terrain compositing at half alpha over the far side of the globe; sky damped.",
  camera: {
    lon: -75.60032002513455,
    lat: 40.0383881265671,
    height: 60000,
    heading: 0.4,
    pitch: -0.9,
    roll: 0,
  },
  clock: "2026-06-21T08:00:00Z",
  dials: {
    dampSky: true,
    translucencyEnabled: true,
    frontFaceAlpha: 0.5,
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
