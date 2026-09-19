// probe-fleet-behaviour-allowlist.mjs — the pinned census of browser-launching
// files that the filename glob never saw and that do not yet satisfy the
// authoring contract.
// @purpose Dated, shrink-only census of the browser-launching files behaviour selection added to the fleet; the spec fails on any NEW violation, stale row, or growth.
// @status ACTIVE
//
// This file is DATA, not policy. Selecting the fleet by behaviour rather than by
// the `probe-*.mjs` name brought in every file that launches a browser under
// another name — `verify-*`, `diag-*`, `canvas-*`, the readme screenshotter,
// and two of the wave-end gate's own three children. They were never held to the
// watchdog and `finally`-close rules, so almost all of them fail on contact.
//
// Repairing them is NOT this list's job and must not be done here: each file is
// a lane of its own in the fleet harvest, and a 45-file sweep in one change is
// how a machine-safety rule gets landed unreviewed. The list absorbs the
// inherited debt so the rules can start applying to NEW files immediately.
//
// The list is shrink-only and the spec pins it: `BEHAVIOUR_ALLOWLIST_BASELINE` is
// a ceiling, every name must still exist, and every name must still violate, so
// a repaired file must be deleted from this file in the same change that
// repaired it. There is no mechanism to add to it except editing it by hand.
//
// Each reason names the constructs actually missing, the date the file was first
// added to the repository, and an expiry the harvest burns down. The expiry is
// RECORDED, not enforced by the clock: a spec that reds on a calendar date is a
// landmine in a repository whose landings are batched by quiet hours. What the
// spec enforces is the ceiling.
//
// Census taken 2026-09-18 at 1a2baeaa4a: 676 files selected by behaviour, 630 of
// them already inside the filename glob, 46 outside it, 45 of those in violation
// and listed here. The readme screenshotter's own capture script is the one
// escapee that already complies and is deliberately absent.

/** Ceiling for the allowlist's size. It may shrink; it may never grow. */
export const BEHAVIOUR_ALLOWLIST_BASELINE = 45;

/** Repo-relative path -> one-line reason naming the missing constructs and the dates. */
export const BEHAVIOUR_FLEET_ALLOWLIST = Object.freeze({
  "Tools/variant-smoke-test.mjs":
    "no watchdog — added 2026-04-19; expires 2026-12-31",
  "Tools/visual-regression/bug-11-imagery-probe.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29; expires 2026-12-31",
  "Tools/visual-regression/canvas-black-narrow.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29; expires 2026-12-31",
  "Tools/visual-regression/canvas-black-readback.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29; expires 2026-12-31",
  "Tools/visual-regression/canvas-black-trace.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29; expires 2026-12-31",
  "Tools/visual-regression/canvas-format-probe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/capture-and-diff.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-08; expires 2026-12-31",
  "Tools/visual-regression/cross-backend-sandcastle-runner.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/debug-ground-polyline-color.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/diag-b3dm-cmds.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/diag-b3dm-depth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05; expires 2026-12-31",
  "Tools/visual-regression/diag-b3dm-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/diag-exag-water-streaks-2x2.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24; expires 2026-12-31",
  "Tools/visual-regression/diag-exag-water-streaks-source.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23; expires 2026-12-31",
  "Tools/visual-regression/diag-globe-belowsurface-decomp.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03; expires 2026-12-31",
  "Tools/visual-regression/diag-groundprim-extents.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05; expires 2026-12-31",
  "Tools/visual-regression/diag-ktx2-ibl-shape.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23; expires 2026-12-31",
  "Tools/visual-regression/diag-stars-hdr-autoexposure.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23; expires 2026-12-31",
  "Tools/visual-regression/diag-taa-black.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12; expires 2026-12-31",
  "Tools/visual-regression/diff-two-pngs.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29; expires 2026-12-31",
  "Tools/visual-regression/disable-skyatmo-probe-wgl.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/disable-skyatmo-probe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/earth-pixel-probe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/ground-polyline-smoke.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-28; expires 2026-12-31",
  "Tools/visual-regression/run-performance-campaign.mjs":
    "no watchdog; never closes the browser — added 2026-07-16; expires 2026-12-31",
  "Tools/visual-regression/sandcastle-batch-66-end-of-session-runner.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-25; expires 2026-12-31",
  "Tools/visual-regression/sandcastle-batch-66-final-runner.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-25; expires 2026-12-31",
  "Tools/visual-regression/sandcastle-smoke.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12; expires 2026-12-31",
  "Tools/visual-regression/sky-band-compare.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29; expires 2026-12-31",
  "Tools/visual-regression/track-entity-probe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13; expires 2026-12-31",
  "Tools/visual-regression/translucent-classification-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-27; expires 2026-12-31",
  "Tools/visual-regression/verify-b3dm-render.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-batches-106-109.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-01; expires 2026-12-31",
  "Tools/visual-regression/verify-classification-fr.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-01; expires 2026-12-31",
  "Tools/visual-regression/verify-glb-renders.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-glb-side-by-side.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-gp-debug-volume.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-gp-no-polyline.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-ground-polyline-zoom.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-hdr-taa.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-initial-hdr.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-01; expires 2026-12-31",
  "Tools/visual-regression/verify-model-feature-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/verify-pick-webgl-control.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-01; expires 2026-12-31",
  "Tools/visual-regression/verify-vector-3dtile-frs.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30; expires 2026-12-31",
  "Tools/visual-regression/webgl-vs-webgpu-pixel-check.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29; expires 2026-12-31",
});
