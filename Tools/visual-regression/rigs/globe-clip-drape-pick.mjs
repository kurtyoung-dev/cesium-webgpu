// Rig record for the draped-vector pick scene over a globe with one clipping plane.
//
// @purpose Rig record for the draped-vector pick scene over a globe with one clipping plane.
// @status ACTIVE

export default Object.freeze({
  id: "globe-clip-drape-pick",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "A solid sandy-brown globe seen straight down from 1,000 km over 104.5 W, 38.5 N, draped with one pickable green polygon (105.6 W to 103.4 W, 36.6 N to 40.4 N) and two pickable 16-pixel blue polylines along 104.0 W and 105.0 W, cut by one clipping plane through 104.5 W, 38.5 N whose normal is local east, so the western part of the polygon and the whole 105.0 W line are clipped away; five fixed points are picked: the polygon on each side of the cut, each line on its own side, and bare globe east of the polygon.",
  camera: {
    lon: -104.5,
    lat: 38.5,
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
      originDegrees: [-104.5, 38.5, 0],
      planes: [{ normal: [1, 0, 0], distance: 0 }],
      unionClippingRegions: false,
      edgeWidth: 0,
      edgeColor: "WHITE",
    },
    useHardwareClipDistances: false,
    drape: {
      polygons: [
        {
          id: "polygon",
          westSouthEastNorth: [-105.6, 36.6, -103.4, 40.4],
          color: [0, 1, 0, 1],
        },
      ],
      polylines: [
        {
          id: "polyline-east",
          meridianDegrees: -104.0,
          southNorthDegrees: [36.0, 41.0],
          widthPixels: 16,
          color: [0, 0, 1, 1],
        },
        {
          id: "polyline-west",
          meridianDegrees: -105.0,
          southNorthDegrees: [36.0, 41.0],
          widthPixels: 16,
          color: [0, 0, 1, 1],
        },
      ],
    },
    pickPoints: [
      { id: "polygon-kept", lonLatDegrees: [-103.7, 37.2] },
      { id: "polygon-clipped", lonLatDegrees: [-105.3, 37.2] },
      { id: "polyline-east-kept", lonLatDegrees: [-104.0, 39.8] },
      { id: "polyline-west-clipped", lonLatDegrees: [-105.0, 39.8] },
      { id: "bare-globe-kept", lonLatDegrees: [-102.8, 38.5] },
    ],
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
