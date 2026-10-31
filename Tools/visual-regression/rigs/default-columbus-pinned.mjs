// Rig record for the landing program's cell E-ID-cv: the default viewer in Columbus view
// at a pinned instant.
//
// @purpose Rig record for the landing cell E-ID-cv: default-3d-pinned (CesiumViewer's own page, pinned clock 2026-06-21T18:00:00Z, 1280x720, 240 settle frames, both renderers) with the scene mode morphed to COLUMBUS_VIEW by the landing stage's sceneMode dial and the camera pinned top-down to frame the whole Columbus map (lon 0, lat 0, height 35,000,000 m), so a BEFORE and an AFTER run render the same whole-map Columbus view.
// @status ACTIVE
//
// WHY THIS RIG EXISTS. It is the identity rig for landing cell E-ID-cv in
// `probe-landing-cells.mjs`: the cell's expectation is 0 changed pixels
// between the arms in this scene mode, so the rig must hold everything but the
// mode as `default-3d-pinned` does. The scene mode comes from the landing
// stage's `sceneMode` dial (`lib/landing-cell-stage.mjs`), a zero-duration
// morph read back through `scene.mode`. Nothing else differs from
// default-3d-pinned except the camera below.
//
// WHY THE CAMERA IS PINNED (DX-KIT-2D-CV-RIG-PINNED-CAMERA, the kit receipt's
// finding 1). It used to be null, "the mode's own default view after the
// morph". The Edge leg showed what that view is after a zero-duration morph
// from the 3D home view: a zoomed-in part of the map near its north/west edge
// with 122 px of black off-map margin at the left and 68 px at the top, which
// is not a frame that exercises the Columbus map. The stage places the camera
// after the mode (`landingStagePayload` and `stageLandingCellInPage`), through
// `Camera.setView`, which in Columbus view runs `setViewCV` (`CameraHelpers.js`):
// the destination is projected to the map plane (x, y metres, z the height),
// and the orientation is built from heading, pitch and roll, so pitch -pi/2
// looks straight down and heading 0 puts north up.
//
// THE NUMBERS. The Columbus map plane is 2 * pi * R wide and pi * R tall,
// R = 6378137 m: 40,075,016.7 m by 20,037,508.3 m. The camera is the default
// 60-degree perspective frustum; `PerspectiveFrustum` applies `fov` to the
// larger dimension of a wide frame (`PerspectiveFrustum.js`), so the visible
// half-width at a top-down height h is h * tan(30 deg) = 0.57735 * h and the
// half-height is 0.5625 times that (720 / 1280). Fitting the width needs
// h >= 20,037,508.3 / 0.57735 = 34,704,000 m. Height 35,000,000 m gives a
// half-width of 20,207,259 m, so the whole map fits with an expected margin of
// about 5.4 px of black at each side and about 42.7 px above and below (the
// half-height is 11,366,583 m against the map's 10,018,754 m). Columbus view
// does not scroll infinitely, so the side margins are black, not repeated
// imagery.
//
// THE CENTRE. lon 0, lat 0, the middle of the map. The default 3D view's own
// spot is the middle of `Camera.DEFAULT_VIEW_RECTANGLE`, lon -82.5, lat 35
// (`Camera.js`), but a frame centred there cannot hold the whole map: lon -82.5
// is 9,183,858 m west of the map's centre, so the west and east edges need a
// half-width of 29,221,366 m, i.e. a height of at least 50,612,891 m, and the
// map then shows 400 px of black on its east side. Whole-map framing and the
// default rectangle's centre cannot both hold; the whole map is the stated
// goal, so the centre is the map's.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ID-cv`.

export default Object.freeze({
  id: "default-columbus-pinned",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "default-3d-pinned in Columbus view: the scene mode set to COLUMBUS_VIEW by the landing stage, then the camera pinned top-down at lon 0, lat 0, height 35,000,000 m so the whole map is in the frame, the pinned instant 2026-06-21T18:00:00Z, 1280x720, both renderers.",
  declaredBy:
    "default-3d-pinned (scene mode COLUMBUS_VIEW, camera pinned: DX-KIT-2D-CV-RIG-PINNED-CAMERA)",
  camera: {
    lon: 0,
    lat: 0,
    height: 35000000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  },
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
