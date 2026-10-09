// Rig record for the polar scene "polar-plain-midlat-mid" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-plain-midlat-mid, re-declared from probe-polar-multi-plain.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-multi-plain.mjs.
// One of the six standing polar imagery parity views, captured on both
// renderers with no overlay and the clock pinned to 2026-05-19T18:00:00Z (the
// Batch 70 constant, kept so historical figures stay comparable). These six
// rigs are the migrated probe's default set; its parity numbers come from
// lib/metrics/polar-parity.mjs.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-plain-midlat-mid",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Mid-latitude mid: straight down on 100 W, 40 N from 3,000 km over the WGS84 ellipsoid, clock pinned, no overlay. One of the six standing polar imagery parity views.",
  camera: {
    lon: -100,
    lat: 40,
    height: 3000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-05-19T18:00:00Z",
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
    dwellMs: 2000,
  },
});
