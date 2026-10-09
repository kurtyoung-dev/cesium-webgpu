// Rig record for probe-clustered-multifrustum.mjs: the vehicle under one clustered point light, globe on, split into several render frustums.
//
// @purpose Rig record for probe-clustered-multifrustum.mjs's scene: the GroundVehicle glTF model over Pittsburgh with the globe visible and the log-depth far-to-near ratio lowered to 2 so the view splits into several frustums, captured with clustered lighting off and then with one point light on.
// @status ACTIVE
//
// The pose is `viewBoundingSphere` about the loaded model's own bounding
// sphere (`dials.view`), so `camera` is null and the probe applies the pose.
// The page is loaded without the offline flag, as the probe always loaded it,
// so the globe streams its default imagery. Every value is the probe's own
// pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-multifrustum-vehicle",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The GroundVehicle glTF model at scale 5 over Pittsburgh with the globe visible, framed from 3.2 of its bounding radii at 16 degrees down with the log-depth far-to-near ratio set to 2 so the view splits into several frustums; captured with clustered lighting off, then with one white point light of intensity 500 placed 1.5 radii in front of it.",
  asset: "/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
  camera: null,
  clock: null,
  dials: {
    position: { lon: -79.9959, lat: 40.4406, height: 100 },
    modelScale: 5,
    view: { headingDegrees: 0, pitchDegrees: -16, rangeInRadii: 3.2 },
    logarithmicDepthFarToNearRatio: 2,
    light: {
      colorName: "WHITE",
      distanceInRadii: 1.5,
      intensity: 500,
      rangeInRadii: 100,
    },
    readyFrames: 240,
    offFrames: 90,
    onFrames: 90,
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 90 },
});
