// Rig record for the capped-atlas octree voxel seen from just outside its +(R,R,R) corner, corner A of probe-voxel-megatexture PART 3.
//
// @purpose Rig record for the capped-atlas octree voxel seen from just outside its +(R,R,R) corner, corner A of probe-voxel-megatexture PART 3.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-octree-l3-lru-corner-a",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The three-level octree voxel on WebGPU with its atlas capped at 13 slots (nine static root and level-1 slots plus a four-slot level-2 pool) and its screen-space refinement target raised to 100, seen from just outside the positive corner at 1.05 radii on each axis, looking at the centre. The corner-local demand exceeds the pool, so the pool fills and a later visit to the opposite corner evicts it.",
  camera: {
    position: [6697043.850000001, 6697043.850000001, 6697043.850000001],
    direction: [-0.5773502691896258, -0.5773502691896258, -0.5773502691896258],
    up: [-0.4082482904638631, -0.4082482904638631, 0.8164965809277261],
  },
  clock: null,
  dials: {
    provider: "octree-l3",
    customShader: "none",
    nearestSampling: true,
    scene:
      "globe hidden and the sky box removed; sky atmosphere, sun and moon hidden; fog off; black background",
    atlasMaxSlots: 13,
    screenSpaceError: 100,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 930,
  },
});
