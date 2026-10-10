// Rig record for the VoxelBox3DTiles box under the user blue-to-red scalar ramp, the scene probe-voxel-user-customshader measures.
//
// @purpose Rig record for the VoxelBox3DTiles box under the user blue-to-red scalar ramp, the scene probe-voxel-user-customshader measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-box3dtiles-user-ramp",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The same off-axis VoxelBox3DTiles view with a user custom shader that ramps the first property's red channel from blue to red at full opacity, authored once in GLSL for WebGL and once in native WGSL for WebGPU. Both backends are expected to show the same ramped box rather than the default grey.",
  camera: {
    position: [38268822, 28701616.5, 25512548],
    direction: [-0.7058823529411765, -0.5294117647058824, -0.47058823529411764],
    up: [0, 0, 1],
  },
  clock: null,
  asset: "Apps/SampleData/Cesium3DTiles/Voxel/VoxelBox3DTiles/tileset.json",
  dials: {
    provider: "VoxelBox3DTiles",
    customShader: "user-scalar-ramp-dual-language",
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
