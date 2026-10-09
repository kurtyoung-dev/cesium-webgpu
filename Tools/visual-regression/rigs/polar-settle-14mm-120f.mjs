// Rig record for the polar scene "polar-settle-14mm-120f" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-settle-14mm-120f, re-declared from probe-polar-settle.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-settle.mjs (archived).
// The 14,000 km North America view with the tile cache size forced to 0 so
// every tile loads fresh, rendered for a fixed frame count (no tiles-loaded
// exit) and then captured: three rigs, one per budget the probe compared.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-settle-14mm-120f",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The 14,000 km North America view with a cold tile cache, captured after exactly 120 rendered frames. WebGPU only, as captured.",
  camera: {
    lon: -105,
    lat: 50,
    height: 14000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "wgs84",
    globeTileCacheSize: 0,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
    maxFrames: 120,
    dwellMs: 500,
  },
});
