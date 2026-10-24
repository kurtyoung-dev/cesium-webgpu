// Rig record for "globe-horizon-clock-pinned": the clock-pinned twin of the wave-end scene "globe-horizon", held out of scenes.json until its baselines exist.
//
// @purpose Rig record for "globe-horizon-clock-pinned", the clock-pinned twin of the wave-end scene "globe-horizon" (held out of scenes.json until its baselines exist): globe-horizon with both viewers' clocks pinned to a stated daylit instant (local solar noon over the camera), so the historical gates and a PNG reading see the coast in daylight on every run.
// @status ACTIVE
//
// WHY A TWIN (round 5, K5-5; Calenhad N7). "globe-horizon" follows the wall
// clock: at 03:5x EDT on 2026-10-23 it looked across inland California at
// night, so leg 1's coast reading (1e) could not be made. "globe-horizon" has
// no historical baseline, so there is no recorded instant to reuse; this twin
// pins 2026-07-18T20:10:00Z, the local solar noon at the camera's longitude
// (-122.4 deg: 12:00 + 122.4 / 15 h = 20:10 UTC), on the same date as
// globe-default's baselines. Its historical baselines are owed by a
// deliberate, reviewed baseline-refresh commit (R-2026-08-29-2), not by the
// lane that declared it.
//
// HELD OUT OF scenes.json. No scene enters scenes.json without its reviewed
// baselines (cloud-scenes-contract.spec.mjs: a scene without them makes
// capture-and-diff report NON_CERTIFYING and exit 1 by construction), so this
// rig is tagged "globe", not "wave-end", and generateScenesJson does not see
// it. The refresh commit adds the "wave-end" tag, regenerates scenes.json
// (the entry lands directly after its original), captures the baselines with
// --update and reviews them, all in one commit; landing-rigs.spec.mjs R9
// asserts that regeneration moves nothing else.
//
// ORDER. capture-and-diff applies every scene of a sweep to ONE page, so a
// scene inherits what earlier scenes left (the subsystem scenes hide the globe;
// wgs84-orbit swaps the terrain). The twin therefore sits directly after its
// original (a fractional legacyOrder, so no other scene moves) and sees the
// page its original saw; the runner restores the page clock after every
// capture, so the pinned clock does not leak into the scenes after it.

export default Object.freeze({
  id: "globe-horizon-clock-pinned",
  tags: ["globe"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Clock-pinned twin of globe-horizon: the low-angle horizon shot over the San Francisco coast with both viewers' clocks frozen at 2026-07-18T20:10:00Z (local solar noon at -122.4 deg), so atmosphere, fog, sky and the coast are read in daylight on every run.",
  camera: {
    lon: -122.4,
    lat: 37.7,
    height: 80000,
    heading: 0,
    pitch: -0.15,
    roll: 0,
  },
  clock: "2026-07-18T20:10:00Z",
  setupFile: "scenes/clock-pin-setup.js",
  setupParams: {
    pinnedTimeIso: "2026-07-18T20:10:00Z",
  },
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 2.5,
  legacyExtraOrder: ["setupFile", "setupParams"],
});
