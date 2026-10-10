// Rig record for probe-globe-pipeline-readiness.mjs's "globe-pipeline-readiness-nadir" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-pipeline-readiness.mjs's "globe-pipeline-readiness-nadir" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-pipeline-readiness-nadir",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Straight down on 102 W, 23 N from 9,000 km, the far end of the reported home-to-Mexico transition that the pipeline readiness probe measures for tile holes while globe pipeline variants compile.",
  camera: {
    lon: -102,
    lat: 23,
    height: 9000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
