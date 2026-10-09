// Rig record for the wgs84 family's close view: straight down on 100 W, 40 N
// from 1,000 km over the WGS84 ellipsoid terrain, on the CesiumViewer page.
//
// @purpose Rig record for the WGS84-ellipsoid close view on the CesiumViewer page - nadir on 100 W, 40 N from 1,000 km, both renderers, 1280x720, a 360-frame dwell.
// @status ACTIVE
//
// WHO RENDERS IT. `probe-wgs84.mjs --scene close`. It is that probe's close
// scene and the view of the archived `probe-wgs84-close-postfix.mjs`, and it is
// the view `IMAGERY_PROJECTION.md` cites for the Web Mercator path ("Verified
// at close-zoom over Texas (1 Mm altitude) in probe-wgs84.mjs").
//
// THE CAMERA IS THE ARCHIVED PROBES' setView. They passed only a destination,
// `Cartesian3.fromDegrees(-100, 40, 1000000)`; `Camera.setView` then takes its
// default orientation (heading 0, pitch -90 degrees, roll 0), which is what is
// written out here. The wave-end rig `wgs84-close` is the same camera on the
// split-screen page at 1600x800 - a different page and viewport, so a
// different rig.
//
// THE DWELL. 360 frames is `probe-wgs84.mjs`'s own close count (the archived
// close-postfix probe used 600); the migrated probe uses it as the floor of a
// tiles-loaded-stable settle. The clock is pinned as in `wgs84-home-orbit`.

export default Object.freeze({
  id: "wgs84-close-1mm",
  tags: ["wgs84"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "WGS84 ellipsoid terrain picked from the base-layer picker, straight down on 100 W, 40 N from 1,000 km on the CesiumViewer page, 1280x720, clock pinned to the June solstice at 18:00 UTC.",
  camera: {
    lon: -100,
    lat: 40,
    height: 1000000,
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
    frames: 360,
  },
});
