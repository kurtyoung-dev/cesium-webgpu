// Rig record for the hollow bounded-cylinder voxel seen obliquely, the scene probe-voxel-cylinder measures.
//
// @purpose Rig record for the hollow bounded-cylinder voxel seen obliquely, the scene probe-voxel-cylinder measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-cylinder-oblique",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A single-tile hollow CYLINDER voxel, outer radius one Earth radius, inner radius 0.3 and half-height one half, 8 x 8 x 8 cells each coloured by its radius, angle and height index through a GLSL and native-WGSL shader pair, seen obliquely so the rounded side and a cap both read in the silhouette.",
  camera: {
    position: [16583156.200000001, 12118460.299999999, 10842832.9],
    direction: [-0.7140055472954167, -0.5217732845620352, -0.46684978092392626],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "cylinder-8x8x8-radius-angle-height",
    radii: [1, 1, 0.5],
    innerRadius: 0.3,
    customShader: "metadata-colour-opaque-dual-language",
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
