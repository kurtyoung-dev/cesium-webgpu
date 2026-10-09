// Rig record for the polar scene "polar-overlay-northpole-close" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-overlay-northpole-close, re-declared from probe-polar-multi-angle.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-multi-angle.mjs (archived).
// The same view as its polar-plain twin with the fork's DebugTileImageryProvider
// added (colour by level), so each tile's level, address and Mercator-limit
// border is drawn on the globe. The overlay's grid lines are drawn by each
// backend's own rasterizer, so a parity number at this rig includes them.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-overlay-northpole-close",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "North pole close with the debug tile overlay: straight down on 0 E, 89 N from 3,000 km over the WGS84 ellipsoid, clock pinned, tile labels and borders coloured by level.",
  camera: {
    lon: 0,
    lat: 89,
    height: 3000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-05-19T18:00:00Z",
  dials: {
    terrain: "wgs84",
    debugTileOverlay: {
      colorByLevel: true,
    },
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
