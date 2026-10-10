// Rig record for probe-globe-polar-stretch.mjs's "globe-polar-far" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-polar-stretch.mjs's "globe-polar-far" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-polar-far",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Default Bing Mercator imagery over world terrain seen straight down at 95 W, 40 N from 25,000 km, the first user-reported view (Greenland squashed); the polar-stretch probe reads ice-cap and land-band alignment between the two renderers here.",
  camera: {
    lon: -95,
    lat: 40,
    height: 25000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T08:00:00Z",
  dials: {
    pinClock: true,
    cameraInputs: false,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
