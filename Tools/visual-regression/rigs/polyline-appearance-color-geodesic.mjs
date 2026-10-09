// Polyline family rig "polyline-appearance-color-geodesic" (probe-kit harvest, DX-108): the PolylineColorAppearance Primitive scene probe-polyline-appearance-primitive builds in the page with arcType GEODESIC.
//
// @purpose Polyline family rig "polyline-appearance-color-geodesic" (probe-kit harvest, DX-108): the PolylineColorAppearance Primitive scene probe-polyline-appearance-primitive builds in the page with arcType GEODESIC.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-appearance-color-geodesic",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A cyan width-8 zig-zag PolylineGeometry Primitive drawn with PolylineColorAppearance (arcType GEODESIC) over five points between 75 W and 71 W near 35.5 N, on a black clear colour with the globe, sky box, sun, moon and sky atmosphere hidden, seen straight down from 300 km. The colour-slice parity scene of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    appearance: "PolylineColorAppearance",
    positionsDegrees: [-75, 35, -74, 36, -73, 35, -72, 36, -71, 35],
    width: 8,
    arcType: "GEODESIC",
    color: [0, 1, 1, 1],
    lookAt: {
      lon: -73,
      lat: 35.5,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 300000,
    },
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
