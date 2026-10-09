// Rig record for probe-clustered-per-frame.mjs: a point and a directional light in scene.lights over Pittsburgh.
//
// @purpose Rig record for probe-clustered-per-frame.mjs's scene: one point light and one directional light in scene.lights over Pittsburgh, viewed from 600 m, rendered with clustered lighting off, on, and off again.
// @status ACTIVE
//
// The camera is the probe's `setView`: the point light's longitude, its
// latitude less 0.003 degrees (stored here as the exact double that
// subtraction produced), 600 m, pitched 20 degrees down (stored in radians as
// `-20 * (Math.PI / 180)`, which is what `CesiumMath.toRadians(-20)` returns).
// No heading is given, as the probe gave none. Every value is the probe's own
// pre-harvest constant; the probe now reads them from here.

export default Object.freeze({
  id: "clustered-per-frame-pittsburgh",
  tags: ["clustered"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "A yellow point light 200 m over Pittsburgh and a white directional light in scene.lights, viewed from 600 m pitched 20 degrees down; rendered with clustered lighting off, then on, then off again.",
  camera: {
    lon: -79.9959,
    lat: 40.4376,
    height: 600,
    pitch: -0.3490658503988659,
  },
  clock: null,
  dials: {
    pointLight: {
      lon: -79.9959,
      lat: 40.4406,
      height: 200,
      colorName: "YELLOW",
      intensity: 5,
      range: 500,
    },
    directionalLight: {
      direction: [0, -1, -1],
      colorName: "WHITE",
      intensity: 1,
    },
    offFrames: 30,
    onFrames: 60,
    stableOffFrames: 9,
  },
  viewport: { width: 800, height: 600 },
  readiness: { kind: "settleFrames", frames: 30 },
});
