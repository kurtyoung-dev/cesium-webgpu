// Rig record for the three-level octree voxel at 5 Earth radii, the close2 view probe-voxel-octree measures.
//
// @purpose Rig record for the three-level octree voxel at 5 Earth radii, the close2 view probe-voxel-octree measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-octree-l3-close2",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The three-level octree voxel, 4 x 4 x 4 cells per tile with a thin diagonal at the finest 16-cell grid and its honest downsample at each coarser level, rendered flat grey with the stored alpha and seen head-on from +X at 5 radii. At this distance both backends refine the centre to level 2.",
  camera: {
    position: [31890685, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "octree-l3",
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
    frames: 300,
  },
});
