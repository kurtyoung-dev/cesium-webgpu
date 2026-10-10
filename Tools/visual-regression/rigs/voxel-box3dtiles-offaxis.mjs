// Rig record for the VoxelBox3DTiles box seen off-axis at 8.5 Earth radii, the scene probe-voxel-parity Part A measures.
//
// @purpose Rig record for the VoxelBox3DTiles box seen off-axis at 8.5 Earth radii, the scene probe-voxel-parity Part A measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-box3dtiles-offaxis",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html?offline=true",
  renderers: ["webgl", "webgpu"],
  description:
    "The Earth-sized VoxelBox3DTiles box with no custom shader and nearest sampling, placed by its own global transform and seen off-axis from 8.5 Earth radii so it reads as a bounded three-dimensional silhouette against black. Globe, sky box, sky atmosphere, sun and moon hidden, fog off. The parity probe reads the footprint grid, the mean colour of the lit region and its coverage from this frame on both backends.",
  camera: {
    position: [38268822, 28701616.5, 25512548],
    direction: [-0.7058823529411765, -0.5294117647058824, -0.47058823529411764],
    up: [0, 0, 1],
  },
  clock: null,
  asset: "Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
  dials: {
    provider: "VoxelBox3DTiles",
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
    frames: 300,
  },
});
