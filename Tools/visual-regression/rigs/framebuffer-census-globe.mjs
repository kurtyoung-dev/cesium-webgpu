// Rig record for the framebuffer census's globe cells: the CesiumViewer page's
// own opening view, as `default-3d` frames it, with its clock pinned.
//
// @purpose Rig record for the framebuffer census globe cells: the CesiumViewer page's own opening view over its default terrain and imagery, WebGPU only, 1280x720, 240 settle frames after a tiles-loaded settle, the clock pinned to the June solstice at 18:00 UTC.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-stub-texture-uploads.mjs --scene framebuffer-census`,
// through `lib/framebuffer-census-steps.mjs`, which adds each globe cell's
// dials (MSAA, a pickPosition read, a translucent rectangle) over it.
//
// WHY NOT `default-3d` BY ID. The census compares captures taken up to an hour
// apart, and `default-3d` declares `clock: null`, so its cells rendered at
// wall-clock time: two runs of one tree 52 minutes apart moved the ocean's sun
// glint by a changed fraction of 0.019-0.021, ten times the census threshold.
// `default-3d` stays unpinned because `probe-saved-view.mjs` reproduces a
// user's URL with it. FOLD NOTE: if `default-3d` ever declares a clock, the
// census globe cells move back onto it by id and this file is retired.
//
// THE CLOCK. 18:00 UTC on the June solstice puts the sub-solar point near
// 90 W, so the opening view over the Americas is daylit, as in the wgs84
// family's rigs.

export default Object.freeze({
  id: "framebuffer-census-globe",
  tags: ["framebuffer-census"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The CesiumViewer page's own opening view (default-3d's framing) on WebGPU, 1280x720, the clock pinned to 2026-06-21T18:00:00Z, 240 settle frames after the tiles settle.",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
