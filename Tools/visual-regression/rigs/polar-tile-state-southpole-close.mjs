// Rig record for the polar scene "polar-tile-state-southpole-close" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-tile-state-southpole-close, re-declared from probe-polar-imagery-state.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-imagery-state.mjs (archived).
// The scene at which probe-polar-imagery-state read the per-tile imagery
// state of every polar tile on both renderers (no frame was captured).
// Clock not pinned. A capture at this rig records the frame the state was
// read under.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-tile-state-southpole-close",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "South pole close, the scene of the per-tile imagery state census: straight down on 0 E, 89 S from 3,000 km over the WGS84 ellipsoid, clock not pinned.",
  camera: {
    lon: 0,
    lat: -89,
    height: 3000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "wgs84",
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 302,
    maxFrames: 1500,
    dwellMs: 0,
  },
});
