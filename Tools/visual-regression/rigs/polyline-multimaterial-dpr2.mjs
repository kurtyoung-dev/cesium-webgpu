// Polyline family rig "polyline-multimaterial-dpr2" (probe-kit harvest, DX-108): the five-material PolylineCollection scene probe-polyline-multimaterial builds in the page, at device scale factor 2.
//
// @purpose Polyline family rig "polyline-multimaterial-dpr2" (probe-kit harvest, DX-108): the five-material PolylineCollection scene probe-polyline-multimaterial builds in the page, at device scale factor 2.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-multimaterial-dpr2",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "One PolylineCollection holding five hue-separated horizontal lines from 76 W to 72 W: red Color at 35.6 N, cyan PolylineDash at 35.3 N, yellow PolylineGlow at 35.0 N, magenta width-24 PolylineArrow at 34.7 N and lime width-16 PolylineOutline (blue outline) at 34.4 N, on black with the globe and sky hidden, seen straight down from 700 km, at device scale factor 2 with useBrowserRecommendedResolution off so the backing store is 2x the page size. AR-754's mixed-material scene. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    deviceScaleFactor: 2,
    useBrowserRecommendedResolution: false,
    lookAt: {
      lon: -74,
      lat: 35,
      height: 0,
      headingDegrees: 0,
      pitchDegrees: -90,
      rangeMetres: 700000,
    },
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
