// Rig record for probe-saved-view.mjs's "caribbean-orbit" saved view.
//
// @purpose Rig record for probe-saved-view.mjs's "caribbean-orbit" saved view.
// @status ACTIVE

export default Object.freeze({
  id: "caribbean-orbit",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    'probe-saved-view.mjs VIEWS["caribbean-orbit"] — a user-reported reproduction URL captured WebGL vs WebGPU.',
  camera: {
    lon: -70.10368589552938,
    lat: 18.485,
    height: 12000000,
  },
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
