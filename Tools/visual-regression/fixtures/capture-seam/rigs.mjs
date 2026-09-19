// Rig records the DX-104 capture-seam spec drives, held here rather than in
// the spec so the two mutant copies of the spec read the same inputs.
//
// @purpose Fixture rig records for capture-seam.spec.mjs: an absolute-url split-screen rig carrying a gate, a relative-page rig, and a page-null rig.
// @status ACTIVE
//
// Every record below passes `validateRig` (`lib/rig-registry.mjs`) unchanged —
// a fixture that could not be loaded by the real registry would prove nothing
// about the real capture path. The viewports are tiny on purpose: the spec
// hands the capture seam eight-by-eight PNGs whose metrics are derivable by
// hand, so an assertion reads a number a reviewer can recompute rather than a
// number the code happened to produce.

/**
 * The absolute-`url` form, on `http://localhost:8080`. Ten rigs in the real
 * registry look exactly like this, which is why the re-basing case exists: the
 * origin baked in here must never reach the browser.
 *
 * It also declares BOTH `gate` and `expectedMismatch`, so the manifest's
 * "no verdict vocabulary" rule is asserted against a rig that actually has
 * some to leak.
 */
export const splitScreenRig = Object.freeze({
  id: "seam-split-screen",
  tags: Object.freeze(["wave-end"]),
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: Object.freeze(["webgl", "webgpu"]),
  description: "Fixture rig in the absolute-url form, both renderers.",
  camera: null,
  clock: null,
  viewport: Object.freeze({ width: 8, height: 8 }),
  readiness: Object.freeze({ kind: "settleFrames", frames: 30 }),
  gate: Object.freeze({
    maxChangedFraction: 0.02,
    why: "a fixture ceiling, present only so the spec can prove the manifest strips it",
  }),
  expectedMismatch: Object.freeze([
    Object.freeze({
      gate: "crossBackend",
      expect: "PASS",
      trackedBy: "KIT-B-FIXTURE",
      rationale:
        "a fixture expectation, present only so the spec can prove the manifest strips it",
    }),
  ]),
});

/** The origin-relative `page` form, one renderer. */
export const viewerRig = Object.freeze({
  id: "seam-viewer",
  tags: Object.freeze(["saved-view"]),
  page: "Apps/CesiumViewer/index.html",
  renderers: Object.freeze(["webgpu"]),
  description: "Fixture rig in the origin-relative page form, one renderer.",
  camera: null,
  clock: null,
  viewport: Object.freeze({ width: 8, height: 8 }),
  readiness: Object.freeze({ kind: "settleFrames", frames: 4 }),
});

/**
 * The `page: null` form the four aurora seed rigs use. It is a capture INPUT,
 * not an error: it produces UNMEASURED cells and the run continues.
 */
export const seedRig = Object.freeze({
  id: "seam-seed",
  tags: Object.freeze(["aurora"]),
  page: null,
  renderers: Object.freeze(["webgl", "webgpu"]),
  description: "Fixture seed rig whose renderer does not exist yet.",
  camera: null,
  clock: null,
  viewport: Object.freeze({ width: 8, height: 8 }),
  readiness: Object.freeze({ kind: "settleFrames", frames: 90 }),
  expectedMismatch: Object.freeze([
    Object.freeze({
      gate: "crossBackend",
      expect: "UNMEASURED",
      trackedBy: "KIT-B-SEED",
      rationale:
        "a fixture seed rig predating its renderer; never compared in this metric.",
    }),
  ]),
});

/** The origins the spec captures over. Neither is `http://localhost:8080`. */
export const ORIGINS = Object.freeze({
  BEFORE: "http://localhost:8094",
  AFTER: "http://localhost:8095",
});
