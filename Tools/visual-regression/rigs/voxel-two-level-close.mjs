// Rig record for the two-level thin-diagonal voxel close enough to refine to level 1, the scene probe-voxel-cell-pick Part B measures.
//
// @purpose Rig record for the two-level thin-diagonal voxel close enough to refine to level 1, the scene probe-voxel-cell-pick Part B measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-two-level-close",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A two-level box voxel, 4 x 4 x 4 cells per tile, whose finest 8 x 8 x 8 truth is a thin diagonal extruded along X and whose root is its fat downsample, rendered flat grey with the stored alpha and seen head-on from +X at 10 radii, where both backends refine to level 1.",
  camera: {
    position: [63781370, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "two-level-thin-diagonal",
    customShader: "grey-0.7-metadata-alpha",
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
    frames: 300,
  },
});
