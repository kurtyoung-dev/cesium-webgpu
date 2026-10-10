// Rig record for probe-globe-underground.mjs's "globe-underground-above" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-underground.mjs's "globe-underground-above" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-underground-above",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The viewer's default view above ground with the default underground settings, sky damped and clock pinned: the parity baseline the underground scenes are judged against.",
  camera: null,
  clock: "2026-06-21T08:00:00Z",
  dials: {
    dampSky: true,
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
