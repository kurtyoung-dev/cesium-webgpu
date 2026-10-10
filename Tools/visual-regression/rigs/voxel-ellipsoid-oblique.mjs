// Rig record for the oblate ellipsoid-shell voxel seen obliquely, the scene probe-voxel-ellipsoid measures.
//
// @purpose Rig record for the oblate ellipsoid-shell voxel seen obliquely, the scene probe-voxel-ellipsoid measures.
// @status ACTIVE

export default Object.freeze({
  id: "voxel-ellipsoid-oblique",
  tags: ["voxel"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A single-tile ELLIPSOID voxel with oblate radii (one, one and 0.6 Earth radii) and shell heights from zero to a thousand kilometres, 8 x 8 x 8 cells each coloured by its longitude, latitude and height index through a GLSL and native-WGSL shader pair, seen obliquely so the oblateness reads in the silhouette.",
  camera: {
    position: [16583156.200000001, 12118460.299999999, 10842832.9],
    direction: [-0.7140055472954167, -0.5217732845620352, -0.46684978092392626],
    up: [0, 0, 1],
  },
  clock: null,
  dials: {
    provider: "ellipsoid-8x8x8-lon-lat-height",
    radii: [1, 1, 0.6],
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
