// Rig record for the landing program's cell E-D: the default 3D viewer at a
// pinned instant.
//
// @purpose Rig record for the landing cell E-D (the 09-26 plan's E5-1 and E9-1): the default-3d saved view (CesiumViewer's own camera, no dials, 1280x720, 240 settle frames, both renderers) with the clock pinned to 2026-06-21T18:00:00Z, so a BEFORE and an AFTER run render the same sun and stars.
// @status ACTIVE
//
// WHY NOT `default-3d` ITSELF. That rig records `clock: null`, the page's own
// clock, which is the wall clock at load. The default viewer draws the sky box
// in the inertial frame and the sky atmosphere from the sun's direction, so two
// runs started minutes apart differ in the stars and the sky colour before any
// code has changed, and E-D's expectation is 0 changed pixels between the
// arms. The pinned instant is the one the texture-lifetime rigs use. Nothing
// else differs from default-3d.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-D`.

export default Object.freeze({
  id: "default-3d-pinned",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "default-3d at the pinned instant 2026-06-21T18:00:00Z: CesiumViewer's own camera, no dials, 1280x720, both renderers.",
  declaredBy: "default-3d (clock pinned)",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
