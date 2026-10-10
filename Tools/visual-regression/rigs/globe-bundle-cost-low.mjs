// Rig record for probe-globe-bundle-cost.mjs's "globe-bundle-cost-low" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-bundle-cost.mjs's "globe-bundle-cost-low" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-bundle-cost-low",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Low oblique view over San Francisco from 600 km at 45 degrees of pitch, many globe tile commands in the frame; the scene of the retired render-bundle cost measurement.",
  camera: {
    lon: -122.4,
    lat: 37.6,
    height: 600000,
    heading: 0,
    pitch: -0.7853981633974483,
    roll: 0,
  },
  clock: null,
  dials: {
    requestRenderMode: false,
    shouldAnimate: false,
  },
  viewport: {
    width: 1280,
    height: 900,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
