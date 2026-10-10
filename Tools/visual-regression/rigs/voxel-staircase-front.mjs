// Rig record for the 2x4x3 staircase voxel seen head-on from +X at 4 Earth radii, the scene the voxel pick probes and parity Part B measure.
//
// @purpose Rig record for the 2x4x3 staircase voxel seen head-on from +X at 4 Earth radii, the scene the voxel pick probes and parity Part B measure.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-staircase-front",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A single-tile 2 x 4 x 3 box voxel in Y-up metadata order whose filled cells form an axis-asymmetric staircase, each cell coloured by its own index, scaled to the Earth radius and seen head-on from +X at 4 radii. Any swap, flip or mis-scale of the sample frame lands a pick or a lit cell on a different cell. Used by the public pick probe, Part A of the cell-pick probe and the front view of parity Part B.",
  camera: {
    position: [25512548, 0, 0],
    direction: [-1, 0, 0],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "staircase-2x4x3",
    customShader: "metadata-colour-alpha",
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
    frames: 240,
  },
});
