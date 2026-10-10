// Rig record for the two-level voxel whose child colours encode their own octant and cell, the scene probe-voxel-refined-pick measures.
//
// @purpose Rig record for the two-level voxel whose child colours encode their own octant and cell, the scene probe-voxel-refined-pick measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-two-level-identity-close",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The two-level thin-diagonal voxel at 10 radii with every level-1 cell colour encoding its identity: red the child octant over eight, green the local cell index over sixty-four, blue one half. A picked colour therefore names the child tile and the cell it was read from.",
  camera: {
    position: [63781370, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "two-level-thin-diagonal",
    customShader: "identity-colour-metadata",
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
    frames: 320,
  },
});
