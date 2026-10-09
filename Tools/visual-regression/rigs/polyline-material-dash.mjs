// Polyline family rig "polyline-material-dash" (probe-kit harvest, DX-108): the PolylineMaterialAppearance Primitive scene probe-polyline-material-primitive builds in the page with a PolylineDash material.
//
// @purpose Polyline family rig "polyline-material-dash" (probe-kit harvest, DX-108): the PolylineMaterialAppearance Primitive scene probe-polyline-material-primitive builds in the page with a PolylineDash material.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-material-dash",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A width-12 horizontal PolylineGeometry Primitive from 76 W to 72 W at 35 N (arcType NONE) drawn with PolylineMaterialAppearance and a cyan PolylineDash material, on black with the globe and sky hidden, seen straight down from 600 km. The material-slice parity scene of NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    appearance: "PolylineMaterialAppearance",
    positionsDegrees: [-76, 35, -72, 35],
    width: 12,
    arcType: "NONE",
    material: {
      type: "PolylineDash",
      color: [0, 1, 1, 1],
      dashLength: 24,
      dashPattern: 255,
    },
    lookAt: {
      lon: -74,
      lat: 35,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 600000,
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
