// Rig record for the landing cell E-CLOUD-morph: the default cloud collection while the scene mode is morphing.
//
// @purpose Rig record for the landing cell E-CLOUD-morph: the 3D globe at lon 0, lat 0, height 20,000,000 m at the pinned instant 2026-06-21T18:00:00Z, 1280x720, volumetric cloud collection on with every cloud dial at its default, and a morph to 2D started with a duration so long that the scene is still in SceneMode.MORPHING at the capture (the morphHold step dial, lib/morph-steps.mjs), so the cloud renderer resolves its quality tier for a morphing frame.
// @status ACTIVE
//
// WHY A HELD MORPH. The scene's tweens advance on wall-clock time, not on the
// pinned clock, so a morph of ordinary length passes through its fractions at
// a speed the probe does not control. A 3D-to-2D morph of 3,600 s first tweens
// the camera for 1,800 s and starts the `morphTime` tween only when that
// completes (`Scene/SceneTransitioner.js` `morphFrom3DTo2D`,
// `morphFrom3DToColumbusView`), so `morphTime` stays 1.0 and the page is in
// MORPHING for every frame the cell renders and captures; the step reads `scene.mode` and `scene.morphTime`
// before and after the frames and reports both. What the cell holds
// deterministically is the mode, not a morph fraction.
//
// THE TIER IT READS. As cloud-2d-default: "auto" quality at a camera height
// above 100,000 m resolves tier 1, and the renderer clears the temporal bit
// while `frameState.mode` is MORPHING (`temporalReprojectionSupported`).
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-CLOUD-morph`.

export default Object.freeze({
  id: "cloud-morph-default",
  tags: ["cloud"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgpu"],
  description:
    "The 3D globe at lon 0, lat 0, height 20,000,000 m, volumetric clouds on at their defaults, a 3,600 s morph to 2D started after staging so the scene is MORPHING at the capture, the pinned instant 2026-06-21T18:00:00Z, 1280x720, WebGPU only.",
  declaredBy: "cloud-2d-default (morph held instead of completed)",
  camera: {
    lon: 0,
    lat: 0,
    height: 20000000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: {
    cloudsEnabled: true,
    morphHold: { to: "SCENE2D", seconds: 3600 },
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
