// Rig record for probe-globe-bindgroup-cache.mjs's "globe-bindgroup-cache-pan" scene (globe family, probe-kit harvest).
//
// @purpose Rig record for probe-globe-bindgroup-cache.mjs's "globe-bindgroup-cache-pan" scene (globe family, probe-kit harvest).
// @status ACTIVE

export default Object.freeze({
  id: "globe-bindgroup-cache-pan",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "Globe bind-group cache scene: the view the cache probe pans to (80 E, 10 S, 15,000 km, default orientation) and captures once its bind-group creations have re-settled; it also holds a fixed view at 0 E, 20 N and a sustained low pan over San Francisco at 250 km.",
  camera: {
    lon: 80,
    lat: -10,
    height: 15000000,
  },
  clock: null,
  dials: {
    requestRenderMode: false,
    shouldAnimate: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
});
