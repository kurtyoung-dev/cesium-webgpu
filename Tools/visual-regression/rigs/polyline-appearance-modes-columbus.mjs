// Polyline family rig "polyline-appearance-modes-columbus" (probe-kit harvest, DX-108): cell CV of probe-polyline-appearance-2d, a polyline appearance Primitive morphed to COLUMBUS_VIEW.
//
// @purpose Polyline family rig "polyline-appearance-modes-columbus" (probe-kit harvest, DX-108): cell CV of probe-polyline-appearance-2d, a polyline appearance Primitive morphed to COLUMBUS_VIEW.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-appearance-modes-columbus",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A cyan zig-zag PolylineGeometry Primitive (arcType NONE) over five points between 75 W and 71 W near 35.5 N, drawn with PolylineColorAppearance at width 10, morphed to COLUMBUS_VIEW with no animation and seen straight down from 600 km on black with the globe and sky hidden. Cell 2 of the four the probe measures in one page, in order. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    cell: "CV",
    cellOrder: 2,
    sceneMode: "COLUMBUS_VIEW",
    appearance: "PolylineColorAppearance",
    positionsDegrees: [-75, 35, -74, 36, -73, 35, -72, 36, -71, 35],
    width: 10,
    arcType: "NONE",
    color: [0, 1, 1, 1],
    lookAt: {
      lon: -73,
      lat: 35.5,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 600000,
    },
    settleFrames: 30,
    renderFrames: 60,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 90,
  },
});
