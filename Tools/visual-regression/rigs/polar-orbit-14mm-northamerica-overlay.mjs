// Rig record for the polar scene "polar-orbit-14mm-northamerica-overlay" (polar family, probe-kit harvest).
//
// @purpose Rig record for the polar scene polar-orbit-14mm-northamerica-overlay, re-declared from probe-polar-stretch-diag.mjs and probe-polar-bisect.mjs: camera, clock, dials and settle exactly as that probe captured it.
// @status ACTIVE
//
// Source: probe-polar-stretch-diag.mjs and probe-polar-bisect.mjs (both archived).
// The view of the original polar-stretch report: the full globe from 14,000 km
// over North America, clock not pinned. probe-polar-stretch-diag captured it on
// both renderers (and once more with the overlay, the sibling rig), and
// probe-polar-bisect stepped the globe fragment debug modes at it on WebGPU.
//
// READINESS is the source probe's own loop restated as data: render until
// the globe reports its tiles loaded, but never fewer than `frames` frames
// nor more than `maxFrames`, then wait `dwellMs` before the capture. The
// camera orientation is `camera.setView`'s default (heading 0, pitch -90
// degrees, roll 0), which is what the source probe got by passing none.
export default Object.freeze({
  id: "polar-orbit-14mm-northamerica-overlay",
  tags: ["polar"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The 14,000 km North America view with the debug tile overlay coloured by level, so the tiles under the reported stretch can be read. WebGPU only, as captured.",
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
    frames: 202,
    maxFrames: 1200,
    dwellMs: 2000,
  },
});
