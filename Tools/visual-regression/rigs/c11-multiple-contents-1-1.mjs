// Rig record for the C11-205 multiple-content lifecycle scene (probe-c11-205-lifecycle-v2.mjs).
//
// @purpose Rig record for the C11-205 lifecycle scene: the 3D Tiles 1.1 MultipleContents fixture (one root tile, b3dm + i3dm slots) with the globe off, on both backends at 1000x800.
// @status ACTIVE
//
// `page: null` because the tileset, the globe-off setting and the mutation
// steps are driven in-page by the probe (via lib/c11-205-evidence.mjs, whose
// fixture url c11-rigs.spec.mjs pins against `asset`). The 12-frame settle is
// the probe's `stableFramesRequired` ready-signature streak.

export default Object.freeze({
  id: "c11-multiple-contents-1-1",
  tags: ["c11"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "C11-205 lifecycle scene: the 3D Tiles 1.1 MultipleContents fixture whose root tile carries a batched and an instanced content slot, rendered with the globe off and render-on-demand off, on both backends.",
  asset:
    "Specs/Data/Cesium3DTiles/MultipleContents/MultipleContents/tileset_1.1.json",
  camera: null,
  clock: null,
  viewport: {
    width: 1000,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 12,
  },
});
