// Rig record for the Sandcastle 2 gallery demo "webgpu-global-water-weather" (optional cell 3b).
//
// @purpose Rig record for the Sandcastle 2 gallery demo webgpu-global-water-weather (optional cell 3b): the global water and weather showcase at its default view, clock pinned to 2026-06-21T16:00:00Z, both renderers, 1280x720, element capture after 240 settled frames; needs Cesium ion.
// @status ACTIVE
//
// ION (`dials.requiresIon`). The demo builds its Viewer with
// `Cesium.Viewer.createAsync("cesiumContainer", { baseLayerPicker: true, ... })`
// and no `baseLayer` (`packages/sandcastle/gallery/webgpu-global-water-weather/main.js`
// lines 4-9), so the viewer's default base layer, Bing Maps imagery from Cesium
// ion, is what streams. Without ion the globe has no imagery, which is not the
// picture the cell compares, so the capture piece answers `NOT_RUN: ion` for it
// (the way `sandcastle2-globe-materials-water-mask` does) rather than capturing
// a blank base layer. The demo's water and weather settings are the demo's own;
// this rig does not claim to run offline.
//
// RENDERERS. The demo's own code asks for the WebGPU renderer
// (`contextOptions: { renderer: "webgpu" }`); the Sandcastle 2 gate in
// `lib/sandcastle2-renderer-gate.mjs` picks the renderer the cell asks for.

export default Object.freeze({
  id: "water-bookmark-global-water-weather",
  tags: ["water", "sandcastle"],
  page: "Apps/Sandcastle2/standalone.html?id=webgpu-global-water-weather",
  renderers: ["webgl", "webgpu"],
  description:
    'Sandcastle 2 gallery demo "webgpu-global-water-weather": the global water and weather showcase at its default view with the ion Bing base layer, clock pinned to 2026-06-21T16:00:00Z, both renderers, 1280x720, captured after 240 settled frames; needs Cesium ion.',
  declaredBy:
    "water landing proposed optional cell 3b, no probe scene table names it yet; packages/sandcastle/gallery/webgpu-global-water-weather/main.js",
  camera: null,
  clock: "2026-06-21T16:00:00Z",
  dials: {
    galleryId: "webgpu-global-water-weather",
    requiresIon: true,
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
