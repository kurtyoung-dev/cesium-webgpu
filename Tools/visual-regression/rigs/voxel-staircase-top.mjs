// Rig record for the 2x4x3 staircase voxel seen from +Z at 4 Earth radii, the top view parity Part B measures.
//
// @purpose Rig record for the 2x4x3 staircase voxel seen from +Z at 4 Earth radii, the top view parity Part B measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-staircase-top",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The staircase voxel seen from +Z looking down with +Y up, which shows the X by Y cell layout and so catches an X mirroring the front view cannot see.",
  camera: {
    position: [0, 0, 25512548],
    direction: [0, 0, -1],
    up: [0, 1, 0],
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
