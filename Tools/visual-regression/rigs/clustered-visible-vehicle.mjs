// Rig record for probe-clustered-visible.mjs: a glTF vehicle under one clustered point light, globe hidden.
//
// @purpose Rig record for probe-clustered-visible.mjs's scene: the GroundVehicle glTF model over Pittsburgh with the globe hidden, captured with clustered lighting off and then with one point light on.
// @status ACTIVE
//
// The pose is `viewBoundingSphere` about the loaded model's own bounding
// sphere (`dials.view`), known only once the model is ready, so `camera` is
// null and the probe applies the pose. Every value is the probe's own
// pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-visible-vehicle",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The GroundVehicle glTF model at scale 5 over Pittsburgh with the globe hidden, framed from three of its bounding radii at 30 degrees down; captured with clustered lighting off, then with one white point light of intensity 500 placed 1.5 radii in front of it.",
  asset: "/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
  camera: null,
  clock: null,
  dials: {
    position: { lon: -79.9959, lat: 40.4406, height: 100 },
    modelScale: 5,
    view: { headingDegrees: 0, pitchDegrees: -30, rangeInRadii: 3 },
    light: {
      colorName: "WHITE",
      distanceInRadii: 1.5,
      intensity: 500,
      rangeInRadii: 100,
    },
    readyFrames: 240,
    offFrames: 60,
    onFrames: 60,
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 60 },
});
