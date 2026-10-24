// Rig record for the Sandcastle 2 gallery demo "Globe Materials - Water Mask
// Elevation Map" (gallery id `globe-materials-water-mask-elevation-map`).
//
// @purpose Rig record for the water landing's material cell 1f (EDGE_LEG_WATER.md leg 1): the Sandcastle 2 demo globe-materials-water-mask-elevation-map (a WaterMask-driven globe material on Cesium World Terrain with its water mask, the demo's own camera and light), clock pinned to 16:00Z on the June solstice, both renderers, 1280x720, element capture after 240 frames drawn with the tiles loaded; needs Cesium ion.
// @status ACTIVE
//
// WHERE IT COMES FROM. The water lane's job sheet (`EDGE_LEG_WATER.md`, leg 1,
// cell 1f) names the demo, the opener (`lib/sandcastle2-renderer-gate.mjs` and
// `lib/sandcastle2-origin-rewrite.mjs`) and "element capture after 240 settled
// frames, twice per tree per renderer". The cell checks review B1's claim that
// the water batch held back its material sample: the material's water-mask
// read is the base text on both trees, so AFTER draws what BEFORE draws on
// each renderer.
//
// THE CLOCK. The demo lights the globe from a light that follows the camera,
// but the sky and the atmosphere follow the sun, which follows the viewer's
// clock; the demo starts it at the wall clock. Pinning it to the sheet's
// instant takes the minutes between a BEFORE and an AFTER run out of the diff.
//
// ION (`dials.requiresIon`). The demo streams Cesium World Terrain with its
// water mask. Without ion its globe is an ellipsoid with no mask, which is not
// the picture the cell compares, so the capture piece answers `NOT_RUN: ion`
// and the cell is NOT RUN, never a pass.
//
// WHO RENDERS IT. `probe-water-cells.mjs --cells 1f`, through
// `lib/sandcastle2-demo-capture.mjs`.

export default Object.freeze({
  id: "sandcastle2-globe-materials-water-mask",
  tags: ["sandcastle"],
  page: "Apps/Sandcastle2/standalone.html?id=globe-materials-water-mask-elevation-map",
  renderers: ["webgl", "webgpu"],
  description:
    'Sandcastle 2 gallery demo "globe-materials-water-mask-elevation-map": a WaterMask-driven elevation material on Cesium World Terrain with its water mask, the demo\'s own camera, clock pinned to 2026-06-21T16:00:00Z, both renderers, 1280x720, captured after 240 frames drawn with the tiles loaded.',
  declaredBy: "EDGE_LEG_WATER.md leg 1 cell 1f",
  camera: null,
  clock: "2026-06-21T16:00:00Z",
  dials: {
    galleryId: "globe-materials-water-mask-elevation-map",
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
