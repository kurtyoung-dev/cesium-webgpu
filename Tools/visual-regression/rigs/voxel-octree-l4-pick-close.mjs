// Rig record for the four-level octree voxel at 6 Earth radii with no custom shader, the scene probe-voxel-cell-pick Part D measures.
//
// @purpose Rig record for the four-level octree voxel at 6 Earth radii with no custom shader, the scene probe-voxel-cell-pick Part D measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-octree-l4-pick-close",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The four-level octree voxel, 2 x 2 x 2 cells per tile with a thin diagonal at the finest 16-cell grid, rendered with the default voxel shader and seen head-on from +X at 6 radii, where both backends refine to level 3.",
  camera: {
    position: [38268822, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "octree-l4",
    customShader: "none",
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
    frames: 400,
  },
});
