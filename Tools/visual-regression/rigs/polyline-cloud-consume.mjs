// Polyline family rig "polyline-cloud-consume" (probe-kit harvest, DX-108): the static PolylineCollection plus CloudCollection scene probe-polyline-cloud-consume builds on WebGPU to count per-frame re-touches.
//
// @purpose Polyline family rig "polyline-cloud-consume" (probe-kit harvest, DX-108): the static PolylineCollection plus CloudCollection scene probe-polyline-cloud-consume builds on WebGPU to count per-frame re-touches.
// @status ACTIVE

export default Object.freeze({
  id: "polyline-cloud-consume",
  tags: ["polyline"],
  page: null,
  renderers: ["webgpu"],
  description:
    "Default CesiumViewer globe and imagery with four static cyan width-6 surface polylines from 76.5 W to 73.5 W at 39 N, 39.5 N, 40 N and 40.5 N in one PolylineCollection, and four 2 km by 1 km clouds at 5 km altitude near 41.2 N in one CloudCollection, in 3D, seen from 1,500 km above 75 W 40 N. The dirty-consume scene; the probe counts re-touches over settled frames. No page renders this rig from its data yet; the probe builds it in the page.",
  camera: null,
  clock: null,
  dials: {
    anchor: {
      lon: -75,
      lat: 40,
    },
    polylines: {
      count: 4,
      halfSpanDegrees: 1.5,
      firstLatOffsetDegrees: -1,
      latStepDegrees: 0.5,
      width: 6,
      color: "CYAN",
    },
    clouds: {
      count: 4,
      lonStepDegrees: 0.2,
      latOffsetDegrees: 1.2,
      heightMetres: 5000,
      scaleMetres: [2000, 1000],
    },
    setViewHeightMetres: 1500000,
    settleFrames: 50,
    countFrames: 20,
    movedWidth: 12,
  },
  viewport: {
    width: 900,
    height: 600,
  },
  readiness: {
    kind: "settleFrames",
    frames: 50,
  },
});
