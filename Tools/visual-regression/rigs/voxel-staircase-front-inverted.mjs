// Rig record for the staircase voxel under the inverted-alpha user shader, the scene probe-voxel-cell-pick Part C measures.
//
// @purpose Rig record for the staircase voxel under the inverted-alpha user shader, the scene probe-voxel-cell-pick Part C measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-staircase-front-inverted",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The head-on staircase view with a user custom shader, in GLSL and in native WGSL, that sets alpha to one minus the stored alpha, so the visually opaque cells are the previously empty ones and a pick must follow the user shader rather than the raw density.",
  camera: {
    position: [25512548, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "staircase-2x4x3",
    customShader: "inverted-alpha-dual-language",
    nearestSampling: true,
    scene:
      "globe, sky box, sky atmosphere, sun and moon hidden; fog off; black background",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
