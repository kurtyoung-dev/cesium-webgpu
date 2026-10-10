// Rig record for the globe clipping-plane parity scene with two planes in union mode.
//
// @purpose Rig record for the globe clipping-plane parity scene with two planes in union mode.
// @status ACTIVE

export default Object.freeze({
  id: "globe-clip-planes-union",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The one-plane clipping scene (solid sandy-brown globe from 1,000 km over 105 W, 45 N) with two planes through that point, normals local east and local north, in union mode, so everything west OR south of the point is clipped and only the north-east quadrant is drawn, with a 4-pixel white edge band along both cuts.",
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
      unionClippingRegions: true,
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
