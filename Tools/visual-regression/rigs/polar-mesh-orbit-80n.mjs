// Rig record for the polar scene "polar-mesh-orbit-80n" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-mesh-orbit-80n, re-declared from probe-polar-mesh-compare.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-mesh-compare.mjs (archived).
// The scene at which probe-polar-mesh-compare read the most polar tile's mesh
// and the RTE camera encoding on both renderers (no frame was captured): north
// pole orbit with sky atmosphere, ground atmosphere and lighting off.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-mesh-orbit-80n",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "North pole orbit with sky atmosphere, ground atmosphere and lighting off, the scene of the polar tile mesh and camera-encoding comparison: straight down on 0 E, 80 N from 12,000 km.",
  camera: {
    lon: 0,
    lat: 80,
    height: 12000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "wgs84",
    skyAtmosphereShow: false,
    globeShowGroundAtmosphere: false,
    globeEnableLighting: false,
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
