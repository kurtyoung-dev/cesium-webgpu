// Rig record for the wgs84 family's polar view: straight down on 105 W, 50 N
// from 14,000 km over the WGS84 ellipsoid terrain, on the CesiumViewer page.
//
// @purpose Rig record for the WGS84-ellipsoid high-latitude view on the CesiumViewer page - nadir on 105 W, 50 N from 14,000 km with the Arctic in frame, both renderers, 1280x720, a 200-frame dwell floor.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-wgs84.mjs --scene polar`. It is the view of the
// archived `probe-wgs84-polar-stretch.mjs`, the first reproduction of the
// user-reported "stretched at the northern latitudes" screenshot (the
// conclusion is banked under Batch 59 in `WEBGPU_DEBUGGING_LOG.md`).
//
// THE SAME VIEW LIVES IN THE POLAR FAMILY. `probe-polar-stretch-diag.mjs`
// reproduces the same camera on the same terrain (Batch 59 names it). If the
// polar family's harvest records it as a rig too, the two records describe one
// scene and the seat keeps one; this one exists because the wgs84 probe that
// first banked the view is this family's.
//
// THE CAMERA IS THE ARCHIVED PROBE'S setView: destination only,
// `Cartesian3.fromDegrees(-105, 50, 14000000)`, so `Camera.setView`'s default
// orientation (heading 0, pitch -90 degrees, roll 0).
//
// THE DWELL. The archived probe rendered until the globe reported its tiles
// loaded, but never fewer than 200 frames nor more than 1,200. The 200 is the
// floor recorded here; the migrated probe's tiles-loaded-stable settle caps at
// 1,200 for every scene, so the archived bounds are kept. The clock is pinned
// as in `wgs84-home-orbit`.

export default Object.freeze({
  id: "wgs84-polar-14mm",
  tags: ["wgs84"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "WGS84 ellipsoid terrain picked from the base-layer picker, straight down on 105 W, 50 N from 14,000 km with Greenland and the Arctic in frame, on the CesiumViewer page, 1280x720, clock pinned to the June solstice at 18:00 UTC.",
  camera: {
    lon: -105,
    lat: 50,
    height: 14000000,
    heading: 0,
    pitch: -1.5707963267948966,
    roll: 0,
  },
  clock: "2026-06-21T18:00:00Z",
  dials: {
    baseLayerPickerTerrain: "wgs84",
  },
  viewport: {
    width: 1280,
    height: 720,
  },
  readiness: {
    kind: "settleFrames",
    frames: 200,
  },
});
