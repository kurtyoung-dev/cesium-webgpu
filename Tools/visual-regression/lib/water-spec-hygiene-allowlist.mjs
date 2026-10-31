// water-spec-hygiene-allowlist.mjs — the PINNED census of scanned water specs that do not
// yet pass one of the hygiene checks enforced by `water-spec-hygiene.spec.mjs`.
// @purpose Pinned shrink-only census of scanned water or ocean specs exempt from one hygiene check (prettier, runner home, chunk extraction, wall-clock ceiling); the spec fails on any NEW violation or stale row.
// @status ACTIVE
//
// This file is DATA, not policy. The hygiene spec scans every spec under the water
// prefixes (see WATER_SPEC_PREFIXES there), and a spec that predates a check or is red
// at the tree it was found in is recorded here so the check can fail on a NEW violation
// without failing on the inherited ones. The list is **shrink-only**: the spec asserts
// that every entry still names a spec in the tree AND that the spec still fails the
// check it is listed under, so a repaired spec must be deleted from this file in the
// same change. Nothing adds to it except a deliberate edit, which is the point.
//
// Shape: check id -> spec file name -> one-line reason. The check ids are
//   IT-01       prettier-clean
//   IT-02       exactly one runner home in package.json
//   IT-03       no GlobeTerrain chunk extraction
//   WALL-CLOCK  no absolute wall-clock ceiling
// A reason says WHY the spec is exempt, and for a red spec names the failing tests and
// the ledger row that owns the repair.

/**
 * Check id -> spec file name -> one-line reason it is exempt.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const WATER_SPEC_HYGIENE_ALLOWLIST = Object.freeze({
  "IT-01": Object.freeze({}),
  "IT-02": Object.freeze({
    "globe-ocean-wave-clock.spec.mjs":
      "red at HEAD: C4 (neither dialect can still reach the render-loop counter) and E8 (the INERT-CLOCK mutant of the WGSL march dies); row NEW-GLOBE-OCEAN-WAVE-CLOCK-C4-E8",
  }),
  "IT-03": Object.freeze({
    "water-spec-hygiene.spec.mjs":
      "names the forbidden chunk-extraction calls in its own checks and mutants in order to forbid them",
  }),
  "WALL-CLOCK": Object.freeze({
    "water-spec-hygiene.spec.mjs":
      "quotes a wall-clock ceiling in its own mutant in order to prove the check goes red",
  }),
});
