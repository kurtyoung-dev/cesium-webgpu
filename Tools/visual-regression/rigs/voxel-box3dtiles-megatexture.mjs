// Rig record for the VoxelBox3DTiles root-tile upload view, the scene probe-voxel-megatexture PART 1 measures.
//
// @purpose Rig record for the VoxelBox3DTiles root-tile upload view, the scene probe-voxel-megatexture PART 1 measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-box3dtiles-megatexture",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The off-axis VoxelBox3DTiles view on WebGPU only, with the viewer's default sampling and with sun, moon and fog left as the viewer has them. The megatexture probe reads the uploaded root tile's texture dimensions from the renderer and the lit pixels of the centre region from this frame.",
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
    nearestSampling: false,
    scene:
      "globe, sky box and sky atmosphere hidden; sun, moon and fog left as the viewer has them; black background",
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
