// Rig record for the three-level octree voxel streamed in at 10 Earth radii, the near view probe-voxel-megatexture PART 2 measures.
//
// @purpose Rig record for the three-level octree voxel streamed in at 10 Earth radii, the near view probe-voxel-megatexture PART 2 measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-octree-l3-streaming-near",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The three-level octree voxel on WebGPU with the default voxel shader at 10 radii, the near view of the demand-driven streaming check: descendants stream in only when the camera demands them and stay resident after it pulls back.",
  camera: {
    position: [63781370, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "octree-l3",
    customShader: "none",
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
