// Rig record for the landing program's cell E-ID-2d: the default viewer in 2D
// at a pinned instant.
//
// @purpose Rig record for the landing cell E-ID-2d: default-3d-pinned (CesiumViewer's own page, pinned clock 2026-06-21T18:00:00Z, 1280x720, 240 settle frames, both renderers) with the scene mode morphed to SCENE2D by the landing stage's sceneMode dial and the camera pinned to frame the whole 2D map (lon 0, lat 0, height 40,500,000 m), so a BEFORE and an AFTER run render the same whole-map 2D view.
// @status ACTIVE
//
// WHY THIS RIG EXISTS. It is the identity rig for landing cell E-ID-2d in
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
// with 24 px of black off-map margin at the top, which is not a frame that
// exercises the 2D map. The stage places the camera after the mode
// (`landingStagePayload` and `stageLandingCellInPage`), through
// `Camera.setView`, which in 2D runs `setView2D` (`CameraHelpers.js`): the
// orthographic frustum width becomes the destination HEIGHT in metres
// (`left = -z / 2`, `right = z / 2`) and the top/bottom keep the frustum's
// existing ratio, which the morph sets to drawingBufferHeight / drawingBufferWidth
// (`SceneTransitioner.js`). The heading and pitch do not apply (the scene's
// `mapMode2D` is INFINITE_SCROLL, so only the ROTATE map reads the orientation).
//
// THE NUMBERS. The 2D map is 2 * pi * R wide and pi * R tall, R = 6378137 m:
// 40,075,016.7 m by 20,037,508.3 m. At 1280x720 the frame is 0.5625 as tall as
// it is wide. Height 40,500,000 m makes the frame 40,500,000 m by 22,781,250 m,
// so the whole map fits with an expected margin of about 6.7 px at each side
// (the infinite scroll repeats imagery there, so it is a sliver of the next
// copy, not black) and about 43.4 px of black above and below. The frame is
// width-limited: a smaller height would crop the map's east and west.
//
// THE CENTRE. lon 0, lat 0, the middle of the map. The default 3D view's own
// spot is the middle of `Camera.DEFAULT_VIEW_RECTANGLE`, lon -82.5, lat 35
// (`Camera.js`), but a frame centred there cannot hold the whole map: lat 35 is
// 3,896,182 m north of the equator in the geographic projection, so the south
// edge needs a frame half-height of 13,914,936 m, i.e. a height of at least
// 49,475,329 m, and then the map's north edge leaves 200 px of black above it.
// Whole-map framing and the default rectangle's centre cannot both hold; the
// whole map is the stated goal, so the centre is the map's.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-ID-2d`.

export default Object.freeze({
  id: "default-2d-pinned",
  tags: ["saved-view"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "default-3d-pinned in 2D: the scene mode set to SCENE2D by the landing stage, then the camera pinned at lon 0, lat 0, height 40,500,000 m so the whole map is in the frame, the pinned instant 2026-06-21T18:00:00Z, 1280x720, both renderers.",
  declaredBy:
    "default-3d-pinned (scene mode SCENE2D, camera pinned: DX-KIT-2D-CV-RIG-PINNED-CAMERA)",
  camera: {
    lon: 0,
    lat: 0,
    height: 40500000,
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: { sceneMode: "SCENE2D" },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 240,
  },
});
