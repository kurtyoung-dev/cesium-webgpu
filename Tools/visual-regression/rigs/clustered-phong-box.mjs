// Rig record for probe-clustered-phong.mjs: a lit per-instance-colour box under one clustered point light.
//
// @purpose Rig record for probe-clustered-phong.mjs's scene: a 40 m flat:false PerInstanceColorAppearance box over Pittsburgh, globe hidden, captured with clustered lighting off and then with one bright point light on.
// @status ACTIVE
//
// The pose is `viewBoundingSphere` about a 35 m sphere at `dials.centre`
// (`dials.view`), which the `camera` shape cannot hold, so `camera` is null
// and the probe applies the pose. Every value is the probe's own pre-harvest
// constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-phong-box",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "A 40 m closed per-instance-colour box (flat off) over Pittsburgh with the globe hidden, framed from three sphere radii at 30 degrees down; captured with clustered lighting off, then with one bright white point light 1.5 radii in front of it.",
  camera: null,
  clock: null,
  dials: {
    centre: { lon: -79.9959, lat: 40.4406, height: 150 },
    box: { dimensionsMetres: [40, 40, 40], colorBytes: [150, 150, 150, 255] },
    boundingSphereRadiusMetres: 35,
    view: { headingDegrees: 0, pitchDegrees: -30, rangeInRadii: 3 },
    light: {
      colorName: "WHITE",
      distanceInRadii: 1.5,
      intensity: 20000,
      rangeInRadii: 100,
    },
    readyFrames: 120,
    offFrames: 60,
    onFrames: 60,
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 60 },
});
