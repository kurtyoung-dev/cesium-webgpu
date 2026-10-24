// Rig record for the landing program's cell E-D-HDR: the default 3D viewer
// with highDynamicRange forced on.
//
// @purpose Rig record for the landing cell E-D-HDR (the 09-26 plan's E5-1a and E9-2): the default-3d saved view (CesiumViewer's own camera, 1280x720, 240 settle frames) at the pinned instant of default-3d-pinned, with scene.highDynamicRange forced on, on both renderers.
// @status ACTIVE
//
// `default-3d-pinned` is E-D. This sibling differs from it by the one dial,
// so the replay keys of the two cells differ and the HDR arm cannot be
// mistaken for the plain one. The clock is pinned for the reason given in
// `default-3d-pinned`: an unpinned page clock moves the sun and the stars
// between a BEFORE and an AFTER run, so the two arms would differ by the time
// of day rather than by the change. The dial is read back by
// `lib/landing-cell-stage.mjs`; on a renderer or canvas that refuses HDR the
// read-back says so rather than the cell silently photographing an SDR frame.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-D-HDR`.

export default Object.freeze({
  id: "default-3d-hdr",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "default-3d at the pinned instant 2026-06-21T18:00:00Z with scene.highDynamicRange forced on: CesiumViewer's own camera, 1280x720, both renderers.",
  declaredBy: "default-3d-pinned (plus highDynamicRange true)",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: {
    highDynamicRange: true,
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
