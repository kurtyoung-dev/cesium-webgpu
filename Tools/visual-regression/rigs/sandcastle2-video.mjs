// Rig record for the Sandcastle2 gallery demo "Video" (gallery id `video`).
//
// @purpose Rig record for the Sandcastle2 Video demo: a tracked ellipsoid whose material is a playing HTMLVideoElement with no width or height attribute, both renderers, 1280x720, captured once the video has played a second and again 1.5 s later, then once more with the video paused at one time on both renderers for the spread band; and, for the paused cell, the same demo with the video held at one time, the repeat fixed, the scene cleared to one background colour and the console pane collapsed, with the box and the verdict rules registered here.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-stub-texture-uploads.mjs --scene video`. The demo
// runs in the Sandcastle2 run frame, so the probe opens it through
// `openSandcastle2Url` (the origin rewrite and the bucket-frame guard) and
// captures the scene canvas inside that frame; `lib/capture.mjs` navigates the
// top-level page only and has no frame step, which is why this rig is not
// driven through it.
//
// WHY THIS DEMO. Its `<video id="trailer">` element is sized by CSS and
// carries no width or height attribute, so the element's `width` and `height`
// read 0 while `videoWidth` and `videoHeight` are the frame size: the input
// that decides whether a video texture is sized from its attributes or from
// its frames. The video streams from cesium.com, so this rig needs network
// access; a video that has not started playing refuses the cell.
//
// THE MEASURED REGION. The ellipsoid fills the middle of the frame. The demo
// keeps its own video overlay at the bottom right and its toolbar at the top
// left; the probe measures the central 30% box, which neither covers.
//
// THE PAUSED CELL (`--scene video-paused`, `dials.paused`). The moving cell
// cannot see whether the texture is the right way up, because no two of its
// captures are the same frame. The paused cell holds the video at
// `currentTimeSeconds`, replaces the demo's tiling repeat (8 x 8 by default)
// with a constant one, and captures four times: WebGL at repeat (1, 1) twice
// (L1, L2), WebGL at (1, -1) (F, the control: the same geometry with the
// texture flipped) and WebGPU at (1, 1) (G). The box is centred above the
// middle of the frame, on the surface's upper half, so a flipped texture puts
// different content in it. The rules (`lib/video-paused-cell.mjs`) are fixed
// here before any run: the control separates when d(L1, F) >= 0.10,
// orientation HOLDS when d(G, F) >= d(G, L1) + 0.10, and content parity HOLDS
// when d(G, L1) <= 2 d(L1, L2) + 0.01.
//
// THE PAUSED INSTANT. The camera looks down on the ellipsoid at 45 degrees, so
// the box samples the frame's top band at repeat (1, 1) and, at (1, -1), the
// mirrored band near the frame's bottom. At 8 s and at 12 s the trailer shows
// a title card that is uniform white in both bands, so the control could not
// separate there. 5.5 s is the middle of a shot (about 4.5 s to 6.3 s) in
// which, decoded from the trailer in a 2D canvas, the top band has structure
// (luma standard deviation 9 to 15 per 17%-wide window, against 0 on the
// title cards) and differs from the mirrored bottom band in about 90% of its
// pixels. `fallbackSeconds` are the instants a void cell is re-run at, in
// order.
//
// THE SETTLE. `settleFrames` scene frames are counted only once the surface
// is drawn (the video texture adopted, a primitive drawing it ready and the
// camera tracking it), driven by the kit's frame driver for at most
// `readyMaxFrames` frames within the cell's deadline. Before that, the wait
// allows the scene up to `firstRenderMaxMs` to render its first frame: on
// Edge a WebGPU viewer had not rendered one when the seek finished, and
// rendered it 745 ms later, so the bound is about forty times that, the same
// as the seek's.
//
// THE MATCHED SPREAD (`dials.matchedSpread`, the moving cell). Whether the
// WebGPU box is textured is judged on its luma spread against WebGL's, and a
// playing video gives each renderer a different frame: on Edge one WebGPU
// capture landed on a title card (spread 3.9) while WebGL's was in a shot
// (35.5). So after its two moving captures the cell pauses the video at
// `seconds` on both renderers, lets the scene draw for `settleMs`, and
// captures once more; the spread band is judged on that capture. 5.5 s is the
// paused cell's measured instant; the demo's 8 x 8 tiling shows the whole
// frame, whose structure there (luma standard deviation about 46, 45.6 at a
// quarter of its size) is about twice the title cards' (about 20).

export default Object.freeze({
  id: "sandcastle2-video",
  tags: ["sandcastle"],
  page: "Apps/Sandcastle2/standalone.html?id=video",
  renderers: ["webgl", "webgpu"],
  description:
    'Sandcastle2 gallery demo "video": an ellipsoid textured by a playing video element with no width or height attribute, both renderers, 1280x720; the central 30% box captured once the video has played 1 s and again 1.5 s later.',
  camera: null,
  clock: null,
  dials: {
    galleryId: "video",
    videoElementId: "trailer",
    minVideoSeconds: 1,
    secondCaptureDelayMs: 1500,
    centerBoxFraction: 0.3,
    matchedSpread: {
      seconds: 5.5,
      settleMs: 3000,
      seekTimeoutMs: 30000,
      factor: 2,
    },
    paused: {
      currentTimeSeconds: 5.5,
      fallbackSeconds: [5, 10],
      repeat: [1, 1],
      controlRepeat: [1, -1],
      cells: [
        { tag: "L1", renderer: "webgl", control: false },
        { tag: "L2", renderer: "webgl", control: false },
        { tag: "F", renderer: "webgl", control: true },
        { tag: "G", renderer: "webgpu", control: false },
      ],
      background: [1, 0, 1, 1],
      backgroundTolerance: 24,
      box: { sideFraction: 0.25, centerX: 0.5, centerY: 0.35 },
      settleFrames: 30,
      readyMaxFrames: 6000,
      seekTimeoutMs: 30000,
      firstRenderMaxMs: 30000,
      rules: { controlMin: 0.1, orientationMargin: 0.1, parityFloor: 0.01 },
    },
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleMs",
    ms: 8000,
  },
});
