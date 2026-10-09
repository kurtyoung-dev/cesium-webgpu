// Rig record for the polar scene "polar-wireframe-northpole-close" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-wireframe-northpole-close, re-declared from probe-polar-wireframe.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-wireframe.mjs (archived).
// A polar close view with the globe drawn as a wireframe, which separates
// a mesh that is present but unimaged from a mesh that is absent.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-wireframe-northpole-close",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "North pole close with the globe drawn as a wireframe: straight down on 0 E, 89 N from 3,000 km over the WGS84 ellipsoid.",
  camera: {
    lon: 0,
    lat: 89,
    height: 3000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "wgs84",
    globeShowWireframe: true,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 202,
    maxFrames: 1200,
    dwellMs: 1500,
  },
});
