// Rig record for the default globe with 4x MSAA driven through a ladder of five
// canvas resizes, captured at the end on both renderers.
//
// @purpose Rig record for the default CesiumViewer globe at 4x MSAA taken through five canvas resizes and back to its start size, both renderers, 1280x720, so a render-target lifetime fix is guarded on the scene framebuffer's rebuild path.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-texture-lifetime.mjs --scene resize`. The steps are
// `lib/globe-resize-steps.mjs`; this record holds only data.
//
// WHY A RESIZE LADDER. The WebGPU scene framebuffer rebuilds its render targets
// whenever the canvas size changes, and with MSAA and a samplable depth each
// rebuild allocates a single-sample depth-conversion texture beside the
// multisampled depth. Five distinct sizes give five rebuilds after the first
// one, so a texture that is not released on a rebuild shows up as a count, and a
// texture that is released while something still samples it shows up as a
// "destroyed texture used" validation error.
//
// THE LADDER IS A DIAL, SO IT IS IN THE REPLAY KEY. Each entry is a CSS viewport
// size; the last returns to the rig's own viewport, so the final capture is taken
// at the size every run ends on. `settleFrames` is rendered after each step.
//
// THE CAMERA IS THE PAGE'S OWN and the clock is pinned, as for the wgs84 home
// rig, so the globe and the sky are the same on every run.

export default Object.freeze({
  id: "globe-msaa4-resize-ladder",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Default CesiumViewer globe at msaaSamples 4, canvas resized through five sizes and back to 1280x720, then captured on both renderers.",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: {
    msaaSamples: 4,
    resizeLadder: [
      [1024, 600],
      [1440, 810],
      [800, 640],
      [1366, 768],
      [1280, 720],
    ],
    settleFramesPerStep: 60,
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
