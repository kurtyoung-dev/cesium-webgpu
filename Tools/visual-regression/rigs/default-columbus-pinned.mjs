// Rig record for the landing program's cell E-ID-cv: the default viewer in Columbus view
// at a pinned instant.
//
// @purpose Rig record for the landing cell E-ID-cv: default-3d-pinned (CesiumViewer's own page, pinned clock 2026-06-21T18:00:00Z, 1280x720, 240 settle frames, both renderers) with the scene mode morphed to COLUMBUS_VIEW by the landing stage's sceneMode dial, so a BEFORE and an AFTER run render the same default view in Columbus view.
// @status ACTIVE
//
// WHY THIS RIG EXISTS. It is the identity rig for landing cell E-ID-cv in
// `probe-landing-cells.mjs`: the cell's expectation is 0 changed pixels
// between the arms in this scene mode, so the rig must hold everything but the
// mode as `default-3d-pinned` does. The scene mode comes from the landing
// stage's `sceneMode` dial (`lib/landing-cell-stage.mjs`), a zero-duration
// morph read back through `scene.mode`; camera is null because the mode's own
// default view after the morph is the thing under test. Nothing else differs
// from default-3d-pinned.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ID-cv`.

export default Object.freeze({
  id: "default-columbus-pinned",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "default-3d-pinned in Columbus view: the scene mode set to COLUMBUS_VIEW by the landing stage, CesiumViewer's own default view after the morph, the pinned instant 2026-06-21T18:00:00Z, 1280x720, both renderers.",
  declaredBy: "default-3d-pinned (scene mode COLUMBUS_VIEW)",
  camera: null,
  clock: "2026-06-21T18:00:00Z",
  dials: { sceneMode: "COLUMBUS_VIEW" },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
