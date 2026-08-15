# Maintainer Rulings — 2026-08-14 (Sol-audit decision packet)

Ruled by the maintainer 2026-08-14 ("Lets go with the recommendations but queue up a
larger investigation into D3"). Decision packet: `SOL_WEEK_AUDIT_2026-08-14.md` §3 +
the orchestrator's presented options. Ruling IDs continue the add-only convention.

## R-2026-08-14-1 (D1) — Eclipse-cloud gate demotions: REVERSED, with investigation rider
Restore `shadowContrastInvariant` and `refreshCostMeasured` as GATES; restore the
deleted guard assertion; un-invert the quarantine test. The reopened row's exit
criteria: a fresh, banked refresh-cost measurement (SOL-4) + a mechanism
investigation of the 1.0496 contrast reading. A red on the critical path is
information. Alternatives considered: ratify-demotion (rejected — rests on an
unrecoverable number), reverse-without-rider (subsumed).

## R-2026-08-14-2 (D2) — G3 bar: RESTORE `>= 2700` NOW; 4096 tier filed as upgrade
Restore the ratified bar; delete/repair the two mutants that enshrine `failures: []`;
the Batch-934 RED stands until honestly re-measured. Separately filed:
`G3-4096-FACE-TIER` asset task (bake/bundle 4096 faces, then the gate may prefer
them). Alternatives: 4096-only (rejected — unratified bar gating honesty).

## R-2026-08-14-3 (D3) — Pick-during-motion: UPGRADED TO FULL INVESTIGATION
The maintainer wants the underlying issue understood so picking improves while still
hitting goals — not a quick patch. Investigation scope (dispatched):
(a) archaeology — why was the provenance gate widened to exact equality (the
commit's context, any wrong-pick incident/probe red it responded to);
(b) failure-mode physics — quantify reprojection error as a function of camera pose
delta, depth, and readback age (the derivation the bounded-tolerance design needs);
(c) design — the bounded-tolerance fix (reuse within a derived pose-delta bound,
fail closed beyond) with its band derivation stated, PLUS an assessment of the async
pick path and whether a deferred-confirm pattern can give both correctness and
hover UX; (d) acceptance — probe-verifiable criteria incl. a wrong-pick negative
control. The stale docstring fix lands independently (already in the engine batch).
Fix lands ONLY after the investigation reports.

## R-2026-08-14-4 (D4) — Compliance: PROCESS HARDENING, NO REWRITE
Pre-push hook enforcing co-author trailer + batch-prefix + quiet-hours window, plus
a bypass-evident verify step that re-runs the marker guard over the pushed range.
History stays immutable (consistent with the OPS-01b disclosure). Queued as
`SOL-D4-HARDENING`.

## R-2026-08-14-5 (D5) — visual-evidence-library: ADOPT-WITH-DEDUP
Wire the probe fleet to archive through it; replace its duplicated primitives
(sha256, canonical JSON) with the shared homes; make the per-file source-hash
landing-equivalence check ENFORCED (closes audit S18). Queued as `SOL-D5-ADOPT` (M).

## R-2026-08-14-6 (D6) — Moon-mip: RE-SCOPE ACCEPTED; instrument filed low-priority
The shimmer-envelope re-scope (executing) is the certification of record. Filed:
`MOON-MIP-LOD-SAMPLING-INSTRUMENT` (low) for a true mip/LOD measurement if ever
needed.

## R-2026-08-14-7 (D7) — Destructive cleanups
(a) `.tmp/` contents: DELETE after the current fix batches land (gitignore fix
already executing); (b) the Aug-2 lint-staged stash: VERIFY-THEN-DROP (a worker
confirms its 155 files match landed state before the drop); (c) evidence worktrees:
KEEP-AND-DECLARE (executing).

## R-2026-08-14-8 (D8) — Sol's nine paused files: REASSIGN AFTER D1/D2 LAND
An Opus worker resumes them under the handoff §8 protocol (rehash → finish →
independent re-review → path-scoped commits), sequenced after R-1/R-2 so re-review
happens once against the ruled bars.

## Standing-decision dispositions (same ruling session)
- **OPS-01b (history date rewrite): CLOSED — REJECTED.** The disclosure stands;
  R-4's hardening supersedes the need. No rewrite.
- **`enableNightSkyDimming`: WIRE** to the twilight sky-brightness ladder (S row;
  discharges `SKYATMOSPHERE-NIGHT-SKY-DIMMING-UNWIRED` when landed).
- **C16-R1 (guard-invisible markers): RULED** — extract embedded shaders to `.wgsl`
  files per owning C16 shard; C16-20 gains a string-literal + regex-literal census
  leg; the runtime-generated-comment class (MetadataWGSLPipelineStage) gets an
  ordinary code fix; the two user-facing warning strings get reworded.
- **C18-S7 (§6d splat-LOD non-goal): defer to Wave-S activation as authored.**
- **CLT-D10 (shell-extent canonicity): measurement ordered** — the Lane-B-scene +
  WebGPU-native frustum readout run recorded as that entry's completion condition;
  ruling follows the measurement.
- **UX-03 loading pulse + LICENSE author display name: remain open** (maintainer-
  personal; no default action).
