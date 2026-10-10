// Rig record for probe-globe-translucency.mjs's "globe-translucency-space" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-translucency.mjs's "globe-translucency-space" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-translucency-space",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The default space view with globe translucency enabled at front-face alpha 0.5 and the sky left on, so the far side and the stars show through the planet disc.",
  camera: null,
  clock: "2026-06-21T08:00:00Z",
  dials: {
    dampSky: false,
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
