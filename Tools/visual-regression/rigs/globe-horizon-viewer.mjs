// Rig record for the wave-end "globe-horizon" camera on the CesiumViewer page,
// for the water landing's performance leg E11.
//
// @purpose Rig record for the globe-horizon camera (San Francisco at 80 km, pitch -0.15: coast, surf band and open Pacific on the terrain's own water mask) on the CesiumViewer page with a pinned clock, both renderers, 1600x800, so the E11 performance leg can measure the scene the water landing's leg 1 captures through capture-and-diff.
// @status ACTIVE
//
// WHY A SECOND RIG FOR THE SAME CAMERA. The wave-end rig `globe-horizon` is a
// `url` rig on the split-screen comparison page served on port 8080, which the
// runtime refuses (a dev server on 8080 serves a live build of the source tree)
// and which hosts two viewers at once, so a frame-time or memory figure taken
// there is the sum of both. The plan's E11 runs PF-1..PF-4 on globe-horizon; this
// rig is that camera on one viewer. The clock is pinned (the wave-end rig's
// `null` is the wall clock) to 20:00Z on the June solstice, mid-day in
// California.
//
// WHO RENDERS IT. `probe-landing-cells.mjs --cells E-H`.

export default Object.freeze({
  id: "globe-horizon-viewer",
  tags: ["globe"],
  page: "Apps/CesiumViewer/index.html",
  renderers: ["webgl", "webgpu"],
  description:
    "The wave-end globe-horizon camera (-122.4, 37.7, 80 km, heading 0, pitch -0.15) on the CesiumViewer page at the pinned instant 2026-06-21T20:00:00Z, 1600x800, both renderers.",
  declaredBy:
    "globe-horizon (scenes.json camera, CesiumViewer page, clock pinned)",
  camera: {
    lon: -122.4,
    lat: 37.7,
    height: 80000,
    heading: 0,
    pitch: -0.15,
    roll: 0,
  },
  clock: "2026-06-21T20:00:00Z",
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 120,
  },
});
