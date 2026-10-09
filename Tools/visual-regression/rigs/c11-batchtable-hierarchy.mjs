// Rig record for the C11-196/C11-202 pick-demand scene (probe-c11-196-lazy-pick-demand.mjs, probe-c11-202-batchtexture-pick-demand.mjs).
//
// @purpose Rig record for the C11-196/C11-202 pick-demand scene: the BatchTableHierarchy tileset on the offline viewer at 1280x720, picked after cold colour frames.
// @status ACTIVE
//
// `page: null` because the tileset, the cold colour frames and the picks are
// driven in-page by the probes. C11-196 runs WebGPU only; C11-202 adds a
// WebGL control lane, so the rig lists both backends. The 4-frame settle is
// both probes' ready streak (`readyStreak >= 4`).

export default Object.freeze({
  id: "c11-batchtable-hierarchy",
  tags: ["c11"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "C11-196/C11-202 pick-demand scene: the 30-feature BatchTableHierarchy tileset rendered for cold colour frames and then picked, on the offline viewer at 1280x720.",
  asset:
    "Apps/SampleData/Cesium3DTiles/Hierarchy/BatchTableHierarchy/tileset.json",
  camera: null,
  clock: null,
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 4,
  },
});
