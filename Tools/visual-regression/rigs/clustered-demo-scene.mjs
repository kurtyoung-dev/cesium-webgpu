// Rig record for the clustered-lighting gallery demo's scene, rebuilt on the CesiumViewer page by probe-clustered-demo-scene.mjs.
//
// @purpose Rig record for the clustered-lighting gallery demo's scene (ground slab, three vehicles, six coloured point lights at night) as probe-clustered-demo-scene.mjs rebuilds it on the CesiumViewer page.
// @status ACTIVE
//
// The pose is a lookAt about `dials.centre` (heading, pitch and range in
// `dials.lookAt`), which the degrees-or-ECEF `camera` shape cannot hold, so
// `camera` is null and the probe applies the pose. Every value below is the
// probe's own pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-demo-scene",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The clustered-lighting gallery demo's scene on the viewer page: a 400 m ground slab, three vehicle models and six coloured point lights at local night, with the globe, sky box and atmosphere hidden, framed from 105 m; captured with clustered lighting off, then on.",
  camera: null,
  clock: "2026-06-21T04:30:00Z",
  dials: {
    centre: { lon: -75.59, lat: 40.038, height: 0 },
    backgroundCss: "#05060a",
    ground: {
      dimensionsMetres: [400, 400, 2],
      offsetMetres: [0, 0, -1],
      colorBytes: [120, 120, 130, 255],
    },
    models: [
      {
        uri: "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
        eastMetres: -22,
        headingDegrees: 0,
      },
      {
        uri: "../../SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
        eastMetres: 0,
        headingDegrees: 40,
      },
      {
        uri: "../../SampleData/models/GroundVehicle/GroundVehicle.glb",
        eastMetres: 22,
        headingDegrees: 80,
      },
    ],
    modelScale: 7,
    lights: {
      colorsCss: [
        "#ff3b30",
        "#34c759",
        "#0a84ff",
        "#ffd60a",
        "#ff2d92",
        "#64d2ff",
      ],
      ringRadiusMetres: 34,
      heightMetres: 14,
      intensity: 600,
      range: 120,
    },
    lookAt: { headingDegrees: -20, pitchDegrees: -16, rangeMetres: 105 },
    offFrames: 300,
    onFrames: 60,
  },
  viewport: { width: 1000, height: 700 },
  readiness: { kind: "settleFrames", frames: 300 },
});
