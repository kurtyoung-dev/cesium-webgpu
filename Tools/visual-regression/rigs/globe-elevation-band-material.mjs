// Rig record for probe-globe-elevation-band-material.mjs's "globe-elevation-band-material" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-elevation-band-material.mjs's "globe-elevation-band-material" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-elevation-band-material",
  tags: ["globe"],
  page: "Tools/visual-regression/globe-elevation-band-material-harness.html",
  renderers: ["webgl", "webgpu"],
  description:
    "An elevation-band globe material over world terrain in its own harness page, which sets the camera itself (the pose lives in the page, so the rig carries none).",
  camera: null,
  clock: null,
  viewport: {
    width: 1024,
    height: 640,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
