// Rig record for the default sky box whose sources are swapped twice, captured
// at the end on both renderers.
//
// @purpose Rig record for the default CesiumViewer sky box with its cube-map sources swapped twice in place (to solid red faces, then to solid blue faces), both renderers, 1280x720, so a cube-texture lifetime fix and the display of the swapped texture are both observable.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-texture-lifetime.mjs --scene skybox`. The steps are
// `lib/skybox-swap-steps.mjs`; this record holds only data.
//
// WHY SOLID FACES. The swap is made on the SAME sky box (`skyBox.sources = ...`),
// which is the path that replaces a loaded cube texture. Solid faces make the
// texture each renderer is drawing readable from the sky corners of the frame:
// after both swaps the corners must read the second colour on both renderers. A
// renderer still drawing an earlier texture reads the first colour, or the star
// field, instead.
//
// THE SWAPS ARE A DIAL, SO THEY ARE IN THE REPLAY KEY. Each entry is one swap:
// the face colour as 8-bit RGB and the face edge in pixels. `settleFramesPerStep`
// is rendered after each swap so the load lands before the next one starts.

export default Object.freeze({
  id: "skybox-source-swap",
  tags: ["skybox"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Default CesiumViewer sky box with its sources swapped in place twice, to solid red then solid blue 64-pixel faces, captured on both renderers at 1280x720.",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: {
    swaps: [
      { name: "red", rgb: [220, 20, 20], faceSize: 64 },
      { name: "blue", rgb: [20, 20, 220], faceSize: 64 },
    ],
    settleFramesPerStep: 90,
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
