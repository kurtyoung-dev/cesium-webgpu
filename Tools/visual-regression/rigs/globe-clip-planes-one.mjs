// Rig record for the globe clipping-plane parity scene with one plane and a visible edge band.
//
// @purpose Rig record for the globe clipping-plane parity scene with one plane and a visible edge band.
// @status ACTIVE

export default Object.freeze({
  id: "globe-clip-planes-one",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A solid sandy-brown globe with no imagery, sky, sun, moon, fog, lighting or ground atmosphere, seen straight down from 1,000 km over 105 W, 45 N, cut by one clipping plane through that point whose normal is local east, so the western half shows the black background, with a 4-pixel white edge band along the cut.",
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
      planes: [{ normal: [1, 0, 0], distance: 0 }],
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
