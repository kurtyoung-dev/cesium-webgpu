// Rig record for probe-saved-view.mjs's "default-3d" saved view.
//
// @purpose Rig record for probe-saved-view.mjs's "default-3d" saved view.
// @status ACTIVE

export default Object.freeze({
  id: "default-3d",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    'probe-saved-view.mjs VIEWS["default-3d"] — a user-reported reproduction URL captured WebGL vs WebGPU.',
  camera: null,
  clock: null,
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
