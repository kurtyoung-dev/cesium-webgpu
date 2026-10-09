// Polyline family rig "polyline-geodesic" (probe-kit harvest, DX-108): the great-circle-over-the-pole scene probe-polyline-geodesic builds in the page (DP-H7).
//
// @purpose Polyline family rig "polyline-geodesic" (probe-kit harvest, DX-108): the great-circle-over-the-pole scene probe-polyline-geodesic builds in the page (DP-H7).
// @status ACTIVE

export default Object.freeze({
  id: "polyline-geodesic",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "One PolylineCollection holding a cyan width-5 great circle between 90 W 60 N and 90 E 60 N, subdivided on the CPU by PolylinePipeline.generateCartesianArc so it arcs over the north pole, beside a red width-4 two-point chord between the same endpoints; globe, sky, fog, sun and moon hidden on black, seen from 30,000 km above 0 E 25 S looking straight down. A curved line bows away from the chord. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: {
    lon: 0,
    lat: -25,
    height: 30000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: null,
  dials: {
    hide: ["globe", "skyBox", "sun", "moon", "skyAtmosphere", "fog"],
    endpointsDegrees: [-90, 60, 90, 60],
    geodesicWidth: 5,
    chordWidth: 4,
    requestRenderMode: false,
    shouldAnimate: false,
  },
  viewport: {
    width: 1024,
    height: 768,
  },
  readiness: {
    kind: "settleFrames",
    frames: 60,
  },
});
