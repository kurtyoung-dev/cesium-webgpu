// Rig record for the polar scene "polar-effects-off-northpole-close" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-effects-off-northpole-close, re-declared from probe-polar-fixed-time.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-fixed-time.mjs (archived).
// A polar close view with the clock frozen at 2026-05-18T12:00:00Z and every
// time-varying effect off (sky and ground atmosphere, lighting, sun, moon,
// sky box, fog), so a cross-backend difference here is not a sun or
// atmosphere difference.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-effects-off-northpole-close",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "North pole close with every time-varying effect off: straight down on 0 E, 89 N from 3,000 km over the WGS84 ellipsoid, clock frozen at 2026-05-18 12:00 UTC.",
  camera: {
    lon: 0,
    lat: 89,
    height: 3000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-05-18T12:00:00Z",
  dials: {
    terrain: "wgs84",
    skyAtmosphereShow: false,
    globeShowGroundAtmosphere: false,
    globeEnableLighting: false,
    sunShow: false,
    moonShow: false,
    skyBoxShow: false,
    fogEnabled: false,
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 302,
    maxFrames: 1500,
    dwellMs: 1500,
  },
});
