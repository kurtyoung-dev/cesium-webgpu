// Rig record for the globe G-buffer normal scene: the normal-free ellipsoid globe seen through the G-buffer normal overlay.
//
// @purpose Rig record for the globe G-buffer normal scene: the normal-free ellipsoid globe seen through the G-buffer normal overlay.
// @status ACTIVE

export default Object.freeze({
  id: "globe-gbuffer-normal-overlay",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  // WebGPU only: WebGL has no G-buffer and no `debugShowGBufferNormals`
  // overlay, so there is no WebGL frame to pair this one with.
  renderers: ["webgpu"],
  description:
    "The globe on the offline ellipsoid terrain, which carries no vertex normals, with no imagery, sky, sun, moon, fog, lighting or ground atmosphere, seen straight down from 1,000 km over 105 W, 45 N, north up, through the G-buffer normal overlay, which paints each pixel's eye-space slot-1 normal n as the colour (n + 1) / 2, so the frame-centre pixel of a geodetic normal reads about (128, 128, 255) and the colour gains red, loses red, gains green and loses green away from the centre to the east, west, north and south.",
  camera: {
    lon: -105,
    lat: 45,
    height: 1000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    terrain: "ellipsoid",
    baseColor: "SANDYBROWN",
    imageryLayers: 0,
    debugShowGBufferNormals: true,
    useHardwareClipDistances: false,
  },
  viewport: {
    width: 800,
    height: 600,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
