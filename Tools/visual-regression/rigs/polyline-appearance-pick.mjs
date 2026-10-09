// Polyline family rig "polyline-appearance-pick" (probe-kit harvest, DX-108): the pickable PolylineColorAppearance Primitive scene probe-polyline-appearance-pick builds in the page before it calls scene.pick on the line.
//
// @purpose Polyline family rig "polyline-appearance-pick" (probe-kit harvest, DX-108): the pickable PolylineColorAppearance Primitive scene probe-polyline-appearance-pick builds in the page before it calls scene.pick on the line.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-appearance-pick",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A cyan width-12 zig-zag PolylineGeometry Primitive (arcType NONE, allowPicking, instance id the-polyline) drawn with PolylineColorAppearance over five points between 75 W and 71 W near 35.5 N, on black with the globe and sky hidden, seen straight down from 300 km; scene.pick is then asked at sampled on-line pixels. The C11-09 pick scene. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere"],
    appearance: "PolylineColorAppearance",
    positionsDegrees: [-75, 35, -74, 36, -73, 35, -72, 36, -71, 35],
    width: 12,
    arcType: "NONE",
    color: [0, 1, 1, 1],
    instanceId: "the-polyline",
    allowPicking: true,
    lookAt: {
      lon: -73,
      lat: 35.5,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 300000,
    },
    pick: {
      sampleEvery: 200,
      passes: 3,
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
