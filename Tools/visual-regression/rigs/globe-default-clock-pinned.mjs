// Rig record for "globe-default-clock-pinned": the clock-pinned twin of the wave-end scene "globe-default", held out of scenes.json until its baselines exist.
//
// @purpose Rig record for "globe-default-clock-pinned", the clock-pinned twin of the wave-end scene "globe-default" (held out of scenes.json until its baselines exist): globe-default with both viewers' clocks pinned to the instant its historical baselines were captured at, so the historical gates compare like with like.
// @status ACTIVE
//
// WHY A TWIN (round 5, K5-5). "globe-default" follows the wall clock, so a
// night capture is compared with its daylit baselines and the historical
// gates saturate (99.3 % on 2026-10-23, PASS by the letter only). This twin
// pins the clock through scenes/clock-pin-setup.js to 2026-07-18T00:50:19Z,
// the `capturedAt` both accepted globe-default baselines record (the scene
// clock itself was not recorded; it started at page load, seconds earlier).
// The twin's own historical baselines do not exist yet: they are owed by a
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
  id: "globe-default-clock-pinned",
  tags: ["globe"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "Clock-pinned twin of globe-default: the default load with both viewers' clocks frozen at 2026-07-18T00:50:19Z (the capturedAt of globe-default's accepted baselines), so the historical gates do not compare a night capture with a daylit baseline.",
  camera: null,
  clock: "2026-07-18T00:50:19Z",
  setupFile: "scenes/clock-pin-setup.js",
  setupParams: {
    pinnedTimeIso: "2026-07-18T00:50:19Z",
  },
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  legacyOrder: 0.5,
  legacyExtraOrder: ["setupFile", "setupParams"],
});
