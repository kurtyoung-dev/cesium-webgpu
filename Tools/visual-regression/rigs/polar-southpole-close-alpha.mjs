// Rig record for the polar scene "polar-southpole-close-alpha" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-southpole-close-alpha, re-declared from probe-polar-forcered.mjs, probe-polar-alpha-debug.mjs, probe-polar-fs-stages.mjs and probe-polar-pixel-sweep.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-forcered.mjs, probe-polar-alpha-debug.mjs, probe-polar-fs-stages.mjs and probe-polar-pixel-sweep.mjs (all archived).
// South pole close on WebGPU with one globe fragment debug mode set through
// CesiumDebug.globeFragmentDebug. The four archived probes swept these modes
// at this camera to locate the polar black hole (Batches 61-62); these two
// rigs keep the two modes that carried the conclusion: force-red (the polar
// fragments rasterize) and alpha (the layer-0 mask reads 0 at the pole).
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-southpole-close-alpha",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "South pole close on WebGPU with the globe fragment debug mode alpha, which writes the layer-0 texture-coordinate mask and rectangle into the colour channels. Straight down on 0 E, 89 S from 3,000 km.",
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
    globeFragmentDebug: "alpha",
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
