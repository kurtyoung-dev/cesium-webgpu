// Rig record for the Sandcastle2 gallery demo "Video" (gallery id `video`).
//
// @purpose Rig record for the Sandcastle2 Video demo: a tracked ellipsoid whose material is a playing HTMLVideoElement with no width or height attribute, both renderers, 1280x720, captured once the video has played a second and again 1.5 s later.
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
