// Rig record for the staircase voxel with the pick log-depth gate forced on and a nearer blocker voxel, the scene probe-voxel-pick-logdepth measures.
//
// @purpose Rig record for the staircase voxel with the pick log-depth gate forced on and a nearer blocker voxel, the scene probe-voxel-pick-logdepth measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-staircase-front-logdepth",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The head-on staircase view on WebGPU with the pick-fleet log-depth write forced on, plus a second fully solid voxel a quarter of the radius across placed at +2.5 radii on the view axis, nearer the camera, so that a correct log depth lets it occlude the staircase in the shared pick buffer. The frame shows both voxels.",
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
    pickLogDepthWriteEnabled: true,
    blocker: {
      scale: 0.25,
      offsetX: 2.5,
      fill: "solid",
    },
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 260,
  },
});
