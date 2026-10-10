// Rig record for probe-globe-pick-h44.mjs's "globe-pick-h44" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-pick-h44.mjs's "globe-pick-h44" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-pick-h44",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Opt-in globe terrain picking: an ellipsoid-terrain globe seen straight down from 2,000 km over 75 W, 40 N, picked at the canvas centre with globe.pickable off and on, and with a 40-pixel point 500 km up in front of it.",
  camera: {
    lon: -75,
    lat: 40,
    height: 2000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "ellipsoid",
    foregroundPointHeightMetres: 500000,
    foregroundPointPixelSize: 40,
  },
  viewport: {
    width: 1000,
    height: 700,
  },
  readiness: {
    kind: "settleFrames",
    frames: 150,
  },
});
