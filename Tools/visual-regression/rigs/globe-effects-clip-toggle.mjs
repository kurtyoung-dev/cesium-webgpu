// Rig record for probe-globe-effects-handle-toggle.mjs's "globe-effects-clip-toggle" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-effects-handle-toggle.mjs's "globe-effects-clip-toggle" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-effects-clip-toggle",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Offline globe at 100 W, 40 N from 2,000 km with a clipping plane through the origin (normal +X) assigned, removed and re-added, the active-to-placeholder-to-active walk of the per-frame globe effects bind group.",
  camera: {
    lon: -100,
    lat: 40,
    height: 2000000,
  },
  clock: "2026-06-15T18:00:00Z",
  dials: {
    offline: true,
    clippingPlaneNormal: [1, 0, 0],
    edgeWidth: 0,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
  },
});
