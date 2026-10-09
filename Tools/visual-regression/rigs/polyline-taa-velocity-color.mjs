// Polyline family rig "polyline-taa-velocity-color" (probe-kit harvest, DX-108): one of the three scenes probe-polyline-taa-velocity steps under TAA on its own render loop (AR-752).
//
// @purpose Polyline family rig "polyline-taa-velocity-color" (probe-kit harvest, DX-108): one of the three scenes probe-polyline-taa-velocity steps under TAA on its own render loop (AR-752).
// @status ACTIVE

export default Object.freeze({
  id: "polyline-taa-velocity-color",
  tags: ["polyline"],
  page: null,
  renderers: ["webgl", "webgpu"],
  description:
    "A Viewer the probe creates itself (MSAA 1, widgets off, default render loop off, TAA on, clock stopped) over a hidden globe and sky on black, camera 3,000 km above 0 E 0 N: an animating cyan width-12 Color polyline sweeping its far endpoint along the equator, plus a red animating point to its left as the velocity positive control, stepped frame by frame by the probe. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: {
    materialType: "Color",
    withPolyline: true,
    taaEnabled: true,
    msaaSamples: 1,
  },
  viewport: {
    width: 640,
    height: 480,
  },
  readiness: {
    kind: "settleFrames",
    frames: 24,
  },
});
