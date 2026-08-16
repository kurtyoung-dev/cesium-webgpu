// probe-fleet-contract-allowlist.mjs — the PINNED census of probes that do not
// yet satisfy the authoring contract enforced by
// `probe-fleet-contract.spec.mjs`.
//
// This file is DATA, not policy. Every entry is a probe that shipped before the
// contract was mechanically checkable, recorded here so the spec can fail on a
// NEW violation without failing on the whole inherited fleet. The list is
// **shrink-only**: the spec asserts that every name in it still exists AND still
// violates, so a probe that gets repaired must be deleted from this file in the
// same change. There is no mechanism to add to it except deliberately editing
// it, which is the point — an author who adds a probe without a watchdog gets a
// red spec, not a silent pass.
//
// Census taken 2026-08-07 at `557445c2a0` (Batch 924): 620 probe files, 615 of
// which launch a browser, 55 of those already compliant, 560 listed here.
// The add-date in each reason comes from `git log --diff-filter=A`, so the one
// entry dated on or after 2026-08-07 is a violation introduced AFTER the sweep
// that filed this rule — exactly the recurrence the filing predicted.
//
// Reason strings say WHICH construct is missing, because the two are not equally
// urgent: Playwright reaps the browser on process exit, so a missing `finally`
// leaks nothing past exit and matters only on the throw path, while a missing
// watchdog is the only reason a hung probe never ends. Fix watchdogs first.
//
// A reason may also be CORRECTED without the probe changing, when the analyzer
// stops mis-reading it. `probe-edge-emitter.mjs` was recorded as never closing
// its browser; it closes it on the line after the `try`, and only looked
// close-free because the scanner treated the unpaired quote inside a regex
// literal above as a string opener and went blind for the rest of the file.
// The same thing happened again to `browser?.close()`: the close pattern did
// not admit an optional chain, so three probes that close correctly were
// recorded as never closing. Two of them had no other defect and left this file
// entirely; the third kept its watchdog row with the false clause removed.
// Correcting the reason is not a relaxation — the row still names a real,
// unrepaired violation, which is what the ratchet asserts.

/**
 * Probe file name -> one-line reason it is exempt.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PROBE_CONTRACT_ALLOWLIST = Object.freeze({
  "probe-2d-blank-where.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-2d-cv-modes.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-2d-frustum-bins.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-2d-globe-render.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-2d-zoom-globe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-2dcv-verify.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-adapter-limits-quick.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-adapter-limits.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30, pre-dates the spec",
  "probe-aerial-froxel.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-aerial-lut-primitive.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-aerial-perspective.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-16, pre-dates the spec",
  "probe-aerial-runtime-config.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-align-test.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-18, pre-dates the spec",
  "probe-all-materials.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-async-resource-monitor.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-atmo-lighting.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-16, pre-dates the spec",
  "probe-atmo-lut-no-device-error.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-atmo-lut-off.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-atmo-luts.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-16, pre-dates the spec",
  "probe-atmo-moon-438.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-atmo-physics-438.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-atmo-resolver-consistency.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-atmosphere-orbit.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-atmosphere-toggle.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-atmospheric-effects-b.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-atmospheric-effects.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-attach-mismatch.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-attachment-demand-registry.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-b3dm-noglobe.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05, pre-dates the spec",
  "probe-b3dm-render-edge.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-batch65-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-bathymetry-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-bb-cv-diag.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-billboard-2d-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-billboard-atlas-vflip.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-billboard-partial-write.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-billboard-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-bisect.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-blend-math-bisect.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-bloom-no-globe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-bloom-no-msaa.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-bloom-no-pp.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-bloom-no-sky.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-bloom-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-bloom-side-by-side.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-bloom-tile-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-boot-prewarm-c10-06.mjs":
    "no watchdog — added 2026-07-18, pre-dates the spec",
  "probe-brightness-bisect.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-brightness-no-atmo.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-brightness-ratio.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-buffer-2dcv-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-buffer-integer-position.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-buffer-logdepth-zfight.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-buffer-point-single.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-buffer-point-update.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-buffercoll-encode-benchmark.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-buffercoll-wasm-encode.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-bufferpoint-positiondatatype.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-bufferpolygon-2dcv.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-bufferpolygon-outline.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-bufferpolygon-vector-tile.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-28, pre-dates the spec",
  "probe-bulk-vs-legacy-perf.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-21, pre-dates the spec",
  "probe-bundle-content.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-c-r9-diagnose.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05, pre-dates the spec",
  "probe-c-r9-webgl-vs-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05, pre-dates the spec",
  "probe-c10-02-pixel.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-02-style-economics.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-07-async-model-pipelines.mjs":
    "no watchdog — added 2026-07-18, pre-dates the spec",
  "probe-c10-09-prev-buffer-upload.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-17, pre-dates the spec",
  "probe-c10-10-shadow-single-sweep.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-11-blend-pickability.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-11-ddtd-hitrate.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-11-mixed-coherence.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c10-12-over-occlusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-c9-14-ground-atmo-stage.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-camera-construct.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-camera-issue.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-camera-track.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-canvas-format.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-canvas-timing.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-canvas-vs-screenshot.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-celestial-extinction-cache.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-celestial-extinction-revision-gate.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-cesium-man-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-cesium-man-race.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-cesium-viewer.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-07, pre-dates the spec",
  "probe-cesiumviewer-screenshot.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-channel-materials.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-classification-primitive-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-classifier-2d-renderpass.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-classifier-extents-inspect.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-30, pre-dates the spec",
  "probe-classifier-logdepth-flip.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-30, pre-dates the spec",
  "probe-classifier-logdepth-settle.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-30, pre-dates the spec",
  "probe-classifier-scenemode.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-classifier-textured-materials.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-28, pre-dates the spec",
  "probe-clipping-planes-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-cloud-aerial.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-ambient.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-cloud-clockbind.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-cloud-cone-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-config.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-depth-occlusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-cloud-diagonal.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-cloud-dials.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-cloud-exotic-flags.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-extinction.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-cloud-features.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-genus.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-cloud-godray.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-halfres-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-halfres.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-ibl-full.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-cloud-ibl.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-lighting.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-lut-flagon.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-lut-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-mammatus.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-morphology.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-noisebake.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-noisecore.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-phase.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-cloud-property-edit.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-cloud-remap.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-rte.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-shadow-cascades.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-cloud-shadows-flagon.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-shadows-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-special.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-species.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-stbn-lod.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-cloud-temporal.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cloud-tier-resolver.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-cloud-tod.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-cloud-u1-scaffold.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-u2-config.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-u3-toggle.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-u4a-managed.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cloud-volumetric-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-cloud-weather-flags.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-cluster-assign.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-cluster-bounds.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-cluster-fs-consumer.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-clustered-demo-scene.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-clustered-dispatcher.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-clustered-lights-resize.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-clustered-litmat.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-clustered-matsweep.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-clustered-multifrustum.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-clustered-per-frame.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-clustered-phong.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-clustered-visible.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-clustered-zero-work-route.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-cmd-pushes.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-cold-optics-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-cold-optics.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-collections-2dcv-morph.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-collections-closeup.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-collections-entity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-collections-far-camera.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-collections-morph-blend.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-collections-msaa.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-collections-regression.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-colorgrading-wired.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-compute-engine-wired.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-compute-instance-generic.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-compute-instance-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-14, pre-dates the spec",
  "probe-compute-instance-pickposition.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-compute-instance-webgl2-demos.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-compute-instance-webgl2.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-14, pre-dates the spec",
  "probe-confirm-inspector-sky.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-console-errors.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-contact-shadows.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-cpu-pass-profile.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-csm-cast-dispatch.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-csm-globe-receive-trace.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-culler-pool-decomp.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-custom-shader-material-fields.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-custom-shader-modify.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-custom-shader-translucency.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-custom-shader-wgsl.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-czml-bytes.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-darkness-quant.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-daytime-ocean-brightness.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-debug-api.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-debug-snapshot.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-decoupledscan-progress-guard.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-demand-canvas-pass.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-depth-plane-horizon-oracle.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-depth-plane-pick-matrix.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-depthfail-appearance.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-depthfail-material.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-determinism-check.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-determinism-kit.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-device-limits.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-diag-demand-gates.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-diffusemap-primitive.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-direct-draw-fb.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-disable-rrm.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-disc-size-orbit.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-disk-bleed-scan.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-disk-bleed.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-disk-extent-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-dp46b-metadata.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-dp46c-metadata.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-dp46d-metadata.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-dp46e-pick-metadata.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-dp46f-metadata-demo.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-draw-calls.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-draw-pipeline-labels.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-dusk-terminator.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-edge-authored-silhouette.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-edge-display-mode-tri.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-edge-emitter.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-edge-percolor.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-20, pre-dates the spec",
  "probe-ellipsoid-mrt.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-24, pre-dates the spec",
  "probe-ellipsoid-rte.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-ellipsoidprim-logdepth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-ellipsoidprim-translucent.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-empty-scenes.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-enable-lighting-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-entity-bulk-billboard-label.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-20, pre-dates the spec",
  "probe-entity-bulk.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-entitycluster-gpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-env-aerial-ms.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-env-moon.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-env-parallax.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-env-skybox-stars.mjs":
    "browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-env-temporal-reset.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-env-temporal.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-error-gate-selftest.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-error-pipeline.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-exag-water-streaks.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-exaggeration-3d.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-exaggeration-cv.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-farcam-distortion.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-farcam-isolation.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-fb-after-draws.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-fb-config.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-feature-id-texture.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-fft-ocean.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-flat-polygon-grid-material.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-flowfield-wind.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-fog-auto-vpt.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-fog-ibl-ambient.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-fog-ms-toggle.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-fog-ms.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-fog-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-fog-temporal.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-force-red.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-fork41-occlusion-v2.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-fork41-occlusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-frustum-count-3d.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-17, pre-dates the spec",
  "probe-fs-debug-modes.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-fullscreen-sky-demo.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-gamma-chain.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-gbuffer-enabled.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-gbuffer-visualize.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-geojson-holes.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-geojson-primitive.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-globe-bindgroup-cache.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-globe-bundle-cost.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-globe-clippoly-geodetic.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-globe-default-limits.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-globe-effects-handle-toggle.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-globe-farzoom.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-globe-hdr-gamma.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-globe-material.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-globe-pick-h44.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-globe-polar-stretch.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-globe-rasterizes.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-globe-translucency.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-globe-underground.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-gltf-points-mode.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-gp-pipeline.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-30, pre-dates the spec",
  "probe-gp-vs-output.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-01, pre-dates the spec",
  "probe-gpu-sort-auto.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-gpu-sort-consume.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-gpu-timestamp-profiler.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-grid-multizoom.mjs":
    "no watchdog — added 2026-06-24, pre-dates the spec",
  "probe-ground-atmosphere.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-ground-fog.mjs":
    "browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-ground-polyline-logdepth.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-ground-view-env.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-groundprim-textured-classify.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-h12-longsettle.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-hdr-canvas-output-decomp.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-hdr-pick-format-closure.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-16, pre-dates the spec",
  "probe-hdr-pp-math.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-hdr-toggle-invalidation.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-heat-shimmer.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-hello-sc-clean.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-hello-sc-wgl.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-hello-sc.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-hiz-occlusion-consumer.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-hiz-occlusion-control.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-hiz-tile-occlusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-i3dm-instance-jitter.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-ibl-hdr.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-imagery-overlay.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-imagery-tex.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29, pre-dates the spec",
  "probe-imagery.mjs":
    "no watchdog; browser.close outside finally — added 2026-04-29, pre-dates the spec",
  "probe-khr-extensions-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-khr-extensions.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-khr-lights-punctual.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-khr-meshopt.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-ktx2-transcoder-formats.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-lake-water-mask.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-large-lake-water.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-06, pre-dates the spec",
  "probe-limb-halo-width.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-litmat-mrt.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-live-weather-demo.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-lod-case-paths.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-logdepth-globe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-29, pre-dates the spec",
  "probe-logdepth-pp-sliceb.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-logdepth-pp-slicec.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-logdepth-zfight.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-ltc-area-light.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-magenta-clear.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-mainthread-encode-ceiling.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-mars-diag.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-matappearance-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-metadata-mat.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-metadata-multicomponent.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-metadata-table-instance.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-metadata-table-texture.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-metadata-uint16.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-mip-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-mipmap-check.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-mode-roundtrip.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-model-aniso-ibl.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-model-appearance-demo.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-model-capture-camera-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-model-capture-face-zoom.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-model-capture-reflection.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-model-color.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-model-ibl.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-model-instance-bg-cache.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-model-ktx2-ibl.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-model-mip-inspect.mjs":
    "no watchdog — added 2026-07-18, pre-dates the spec",
  "probe-model-mip-shimmer.mjs":
    "no watchdog — added 2026-07-18, pre-dates the spec",
  "probe-model-mrt.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-24, pre-dates the spec",
  "probe-model-pbr-audit.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-model-pbr-ibl-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-21, pre-dates the spec",
  "probe-model-project2d.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-model-scene-modes.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-model-scene2d-idl.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-model-scene2d-stage-guard.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-model-silhouette.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-model-splitter.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-model-taa-msaa.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-model-tangentgen.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-moon-atmosphere.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-moon-sunlit.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-morph-midframe.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-morph-normals.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-20, pre-dates the spec",
  "probe-motion-blur.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-mrt-validation.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-24, pre-dates the spec",
  "probe-ms-lut-azimuth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-msaa-comparison.mjs":
    "no watchdog; never closes the browser — added 2026-05-17, pre-dates the spec",
  "probe-msaa-resolve-elision.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-multideck-flagon.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-multideck-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-multideck-views.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-mvt-datasource-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-mvt-worker-decode.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-new-sandcastles.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-normalmap-gbuffer.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-normalmap-ub-diag.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-northpole-angles.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-npr-outlines.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-ocean-waves-perf.mjs":
    "browser.close outside finally — added 2026-07-19, pre-dates the spec",
  "probe-orbital-1m.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-14, pre-dates the spec",
  "probe-orbital-catalog.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-orbital-j2.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-orbital-sgp4.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-overlay-compositing.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-panorama-cull-override.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-panorama-hdr.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-particle-no-fog.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-particle-sample.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-pass-counts.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-perf-baseline.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-perinstance-diffuse.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-phase12-bugbash.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-phong-render.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-pick-basic.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-05, pre-dates the spec",
  "probe-pick-metadata.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-pick-multifrustum.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-pick-ray-async.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-pickmodel-instanced.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-pickposition-model-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-pickposition-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-plain-hdr-gamma.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-plain-hdr-tonemap.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-point-label-partial-write.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-point-pick-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-point-sprite-shape.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-pointcloud-edl-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-pointcloud-gpulod-scene-wiring.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-pointcloud-lod.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-pointcloud-logdepth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-polar-alpha-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-bisect.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-diff-all.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-fixed-time.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-18, pre-dates the spec",
  "probe-polar-forcered.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-fs-stages.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-imagery-state.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-mesh-compare.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-polar-multi-angle.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-multi-plain.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-noculling.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-pixel-sweep.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-settle.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-stretch-diag.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polar-wireframe.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-polyline-appearance-2d.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-polyline-appearance-logdepth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-polyline-appearance-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-polyline-appearance-primitive.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-21, pre-dates the spec",
  "probe-polyline-cloud-consume.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-polyline-geodesic.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-20, pre-dates the spec",
  "probe-polyline-image-material.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-polyline-material-primitive.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-21, pre-dates the spec",
  "probe-polyline-multimaterial.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-post-process.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-postprocess-f16.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-pp-effects-audit.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-24, pre-dates the spec",
  "probe-pp-frustum-thread.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-pp-library-builtins.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-pp-library-demo.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-pp-silhouette-array.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-precip-data.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-precip-wiring.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-projection-fix.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-15, pre-dates the spec",
  "probe-replay-cesium-cmd.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-reproj-log.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-reproject-baseline.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-reprojected-texture-compare.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-resident-instance-prev-mirror.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-11, pre-dates the spec",
  "probe-river-water-intensity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-sampled-position-kernel.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-16, pre-dates the spec",
  "probe-sampleheight-webgpu.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-sandcastle-bulk-legacy.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-21, pre-dates the spec",
  "probe-sandcastle-scene-capture.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-sandcastle2-ports.mjs":
    "no watchdog — added 2026-07-11, pre-dates the spec",
  "probe-sandcastle2-webgpu-start.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-06, pre-dates the spec",
  "probe-saved-view.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-16, pre-dates the spec",
  "probe-scene-capture-cardinal.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-scene-capture-off.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-scene-capture-on.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-scene-lights.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-26, pre-dates the spec",
  "probe-sceneframebuffer.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-scheduler-octree-demand.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-shim-debug.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-shim-trace.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-skirts-test.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-sky-atmosphere-coeffs.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-sky-ms-azimuth.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-sky-ms-directional.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-sky-ms.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-sky-view-lut.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-29, pre-dates the spec",
  "probe-skybox-stars-sun-facing.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-skybox-stars-sun.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-06, pre-dates the spec",
  "probe-slice4-verify.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-source-mercator-compare.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-southpole-diag.mjs":
    "no watchdog; never closes the browser — added 2026-05-17, pre-dates the spec",
  "probe-splat-globe-occlusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-splat-sort.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-split-screen.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-ssgi.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-11, pre-dates the spec",
  "probe-ssr-consumer.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-ssr-tuned.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-ssr-water.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-standalone-model-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-starfield-webgl-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-19, pre-dates the spec",
  "probe-stars-catalog.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-16, pre-dates the spec",
  "probe-stars-hdr-autoexposure-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-stars-hdr-verify.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-sun-glowfactor.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-sun-lens-glare.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-sun-pixel-check.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-07, pre-dates the spec",
  "probe-sun-stars-extinction.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-taa-disocclusion.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-25, pre-dates the spec",
  "probe-taa-jitter.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-taa-model-skinned-velocity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-taa-morph-prevvp.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-taa-resolve.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-taa-userwarn.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-15, pre-dates the spec",
  "probe-taa-velocity-emission.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-12, pre-dates the spec",
  "probe-terrain-selection-parity.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-terraindata-getters.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-tex-format.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-tileset-capture-face-zoom.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-tileset-capture-reflection.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-30, pre-dates the spec",
  "probe-timedynamic-pointcloud-load.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-tpdf-dither.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-10, pre-dates the spec",
  "probe-trans-scale.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-uniformstate-viewport-371.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-unlit-vertexcolor.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-vec4-error.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-vector3dtile-vctr.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-vertex-lighting.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-23, pre-dates the spec",
  "probe-vertexcolor-vec3.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-23, pre-dates the spec",
  "probe-volcloud-toggle.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-volumetric-clouds.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-voxel-cell-pick.mjs":
    "no watchdog; never closes the browser — added 2026-07-02, pre-dates the spec",
  "probe-voxel-cylinder.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-voxel-ellipsoid.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-03, pre-dates the spec",
  "probe-voxel-megatexture.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-voxel-octree-l3plus.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-voxel-octree.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-voxel-parity.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-01, pre-dates the spec",
  "probe-voxel-pick-logdepth.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-18, pre-dates the spec",
  "probe-voxel-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-04, pre-dates the spec",
  "probe-voxel-refined-pick.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-voxel-user-customshader.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-02, pre-dates the spec",
  "probe-vr2-polylines-3dtiles.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-vr2-tile-brightness.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-27, pre-dates the spec",
  "probe-wasm-bundle-load.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-13, pre-dates the spec",
  "probe-water-mask-coast-aa.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-06, pre-dates the spec",
  "probe-weather-channels.mjs":
    "browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-weather-edr-mock.mjs":
    "browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-weather-ingest.mjs":
    "browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-weather-inspector.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-weather-map.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-24, pre-dates the spec",
  "probe-weather-metar.mjs":
    "browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-weather-presets.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-25, pre-dates the spec",
  "probe-weather-time.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-26, pre-dates the spec",
  "probe-weather-wcs.mjs":
    "browser.close outside finally — added 2026-06-28, pre-dates the spec",
  "probe-webgpu-allocation-tax.mjs":
    "no watchdog — added 2026-07-16, pre-dates the spec",
  "probe-webgpu-grey.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-07, pre-dates the spec",
  "probe-webgpu-ocean-waves.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-06, pre-dates the spec",
  "probe-webgpu-reinit-switch.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-webgpu-tile-popping.mjs":
    "no watchdog; browser.close outside finally — added 2026-07-05, pre-dates the spec",
  "probe-wgs84-alphadbg.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-atmo.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-close-postfix.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-layer1-alpha.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-polar-stretch.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-postcomposite.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-quick.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-sample0.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84-varyings.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-17, pre-dates the spec",
  "probe-wgs84.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-16, pre-dates the spec",
  "probe-wgsl-compile-error.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
  "probe-wgsl-doctype.mjs":
    "no watchdog; browser.close outside finally — added 2026-05-13, pre-dates the spec",
  "probe-wireframe-verify.mjs":
    "no watchdog; browser.close outside finally — added 2026-06-22, pre-dates the spec",
});
