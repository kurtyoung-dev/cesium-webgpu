// Rig record for probe-globe-rasterizes.mjs's "globe-rasterizes-default" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-rasterizes.mjs's "globe-rasterizes-default" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-rasterizes-default",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The viewer's default load after 300 rendered frames, the whole-disc frame the retired rasterization smoke check read coverage and colour classes from.",
  camera: null,
  clock: null,
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 300,
  },
});
