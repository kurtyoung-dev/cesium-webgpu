// Rig record for the CesiumViewer page the C11 native-instrumentation probes boot (193b, 193c, 209, 210).
//
// @purpose Rig record for the offline CesiumViewer default view on WebGPU at 1000x720, the page the C11-193B/C, C11-209 and C11-210 probes boot before their in-page work.
// @status ACTIVE
//
// This is the one C11 scene `capture()` can take as declared: the page, the
// backend (capture adds `renderer=`), the viewport and a settle. What each
// probe adds on top (dynamic-IBL models, a compute primitive, native API
// wrappers) is in-page work the probe owns. The 24-frame settle is C11-209's
// steady window, the one probe of the four that waits before it measures.
//
// CHROME. This page is the full viewer, whose widgets sit over the canvas.
// `capture()` takes an element capture of the canvas and has no widget-removal
// step today, so a pixel figure read from this rig's frame includes the
// widgets until it gains one (filed by the c11 harvest packet as D-6). A probe
// that scores this page itself removes them first with
// `lib/strip-viewer-widgets.mjs` and refuses on leftovers, as the archived
// C11-209 probe now does.

export default Object.freeze({
  id: "c11-viewer-offline-webgpu",
  tags: ["c11"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgpu"],
  description:
    "CesiumViewer default view with offline imagery on WebGPU at 1000x720: the page the C11 native-instrumentation probes (dynamic-IBL submit and demand, effects placeholder startup, compute command list) boot before their in-page work.",
  camera: null,
  clock: null,
  viewport: {
    width: 1000,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 24,
  },
});
