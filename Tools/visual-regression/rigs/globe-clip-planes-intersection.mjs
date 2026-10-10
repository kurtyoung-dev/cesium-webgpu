// Rig record for the globe clipping-plane parity scene with two planes in intersection mode.
//
// @purpose Rig record for the globe clipping-plane parity scene with two planes in intersection mode.
// @status ACTIVE

export default Object.freeze({
  id: "globe-clip-planes-intersection",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The two-plane clipping scene (solid sandy-brown globe from 1,000 km over 105 W, 45 N, normals local east and local north) in intersection mode, so only what is west AND south of the point is clipped and the south-west quadrant shows the black background, with a 4-pixel white edge band along the two half-lines that bound it.",
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
    clippingPlanes: {
      originDegrees: [-105, 45, 0],
      planes: [
        { normal: [1, 0, 0], distance: 0 },
        { normal: [0, 1, 0], distance: 0 },
      ],
      unionClippingRegions: false,
      edgeWidth: 4,
      edgeColor: "WHITE",
    },
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
