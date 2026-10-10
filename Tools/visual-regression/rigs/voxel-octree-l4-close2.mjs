// Rig record for the four-level octree voxel at 3.5 Earth radii, the close2 view probe-voxel-octree-l3plus measures.
//
// @purpose Rig record for the four-level octree voxel at 3.5 Earth radii, the close2 view probe-voxel-octree-l3plus measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-octree-l4-close2",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The four-level octree voxel, 2 x 2 x 2 cells per tile so the full 585-slot level-3 atlas fits, rendered flat grey with the stored alpha and seen head-on from +X at 3.5 radii. At this distance both backends refine the centre to level 3.",
  camera: {
    position: [22323479.5, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "octree-l4",
    customShader: "grey-0.7-metadata-alpha",
    nearestSampling: true,
    scene:
      "globe hidden and the sky box removed; sky atmosphere, sun and moon hidden; fog off; black background",
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 500,
  },
});
