// Rig record for a glyph texture atlas that grows in a later frame than the
// one that first filled it, on the CesiumViewer page.
//
// @purpose Rig record for the label-atlas growth cell: eight glyphs in one frame, twenty-eight more 25 frames later so the glyph atlas must resize and copy the first eight, captured 60 frames after the last batch on both renderers, 1280x720, globe and sky hidden.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-stub-texture-uploads.mjs --scene atlas`, through the
// step module `lib/label-atlas-growth-steps.mjs`. The labels are data here;
// the steps that add them frame by frame and read the atlas back are the
// module's.
//
// WHY THE RESIZE IS CERTAIN. A `LabelCollection`'s glyph atlas starts at
// 16x16 and is sized, when it first grows, to the glyphs queued in that frame
// (`TextureAtlas._resize`, power-of-two sides doubled until the queued area
// fits). Batch 0 queues eight 48 px glyphs; batch 1, 25 frames later, queues
// twenty-eight more, three and a half times the area of the first, so the
// atlas must grow again while batch 0's glyphs are in it. That second growth
// runs in an after-render callback, and it is the copy of batch 0's glyphs
// that this rig exists to observe. The step module refuses the cell when the
// atlas did not grow between the two batches.
//
// THE FRAME. The camera is nadir on (0, 0) from 10,000 km with the globe, sky
// box, atmosphere, sun and moon hidden over a black background, so every lit
// pixel is a glyph. Batch 0 sits 12 degrees north of the centre and lands in
// the top half of the frame; batch 1 sits 12 degrees south and lands in the
// bottom half. Depth testing is off for every label.

export default Object.freeze({
  id: "texture-atlas-label-growth",
  tags: ["texture-atlas"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A label glyph atlas filled in one frame and grown 25 frames later, so the second growth copies the first batch's glyphs; nadir on (0, 0) from 10,000 km, globe and sky hidden, 1280x720, captured 60 frames after the last batch.",
  camera: {
    lon: 0,
    lat: 0,
    height: 10000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    hideScene: true,
    font: "bold 48px monospace",
    batches: [
      { frame: 5, lat: 12, text: "ABCDEFGH" },
      { frame: 30, lat: -12, text: "IJKLMNOPQRSTUVWXYZ0123456789" },
    ],
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
  },
});
