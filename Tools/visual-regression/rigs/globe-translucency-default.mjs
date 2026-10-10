// Rig record for probe-globe-translucency.mjs's "globe-translucency-default" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-translucency.mjs's "globe-translucency-default" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-translucency-default",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The viewer's default space view with globe translucency at its default (disabled), sky damped and clock pinned: the standing parity baseline the translucent scenes are judged against.",
  camera: null,
  clock: "2026-06-21T08:00:00Z",
  dials: {
    dampSky: true,
    translucencyEnabled: false,
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
