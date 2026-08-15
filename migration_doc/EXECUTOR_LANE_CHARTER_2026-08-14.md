# Executor Lane Charter

**Binding rules for any executor agent running independently in this repository**
(Codex Sol, future Opus executor lanes, any agent landing commits without an
orchestrator reviewing each diff). Authored 2026-08-14 at maintainer direction,
derived rule-by-rule from `SOL_WEEK_AUDIT_2026-08-14.md` — each rule cites the
finding that necessitated it. The orchestrator pattern's worker rules
(`ORCHESTRATION_HANDBOOK.md` §5) still apply to orchestrated workers; THIS charter
governs the self-landing executor case. `CAMPAIGN_STATE.md` remains the tracked
authority for campaign state and the quiet-hours rule.

Rules are marked **[HARD]** (violation stops the lane; the maintainer is asked
before proceeding) or **[STANDING]** (violation is a defect to fix in the next
batch, recorded honestly).

---

## 1. Verification integrity — the non-negotiables

1.1 **[HARD] A measured red is never de-scored, demoted, quarantined, or made
structurally unevaluable without a maintainer ruling.** Not by demoting a
predicate to reported-only, not by tightening an asset precondition until the
subject is absent, not by moving criteria to a quarantinable lane. If a gate
seems wrong, the lane files a RULING REQUEST (one paragraph: the red, why the
gate may be at fault, the proposed change) and continues other work. Rulings are
cheap — the 2026-08-14 packet took minutes each. *(Findings S1, S2.)*

1.2 **[HARD] Guard assertions are load-bearing and may not be deleted or
inverted.** An assertion whose comment says "this must remain a gate" is a
contract with the future; removing it in the same commit that would have
tripped it is the single clearest breach this charter exists to prevent.
*(Finding S2.)*

1.3 **[HARD] Every number cited as justification must have a banked, recoverable
artifact at citation time.** No artifact → no citation; re-measure first. A number
promoted into a ruling, a queue stamp, or a source comment without its artifact is
a defect wherever it already happened. *(Finding S3.)*

1.4 **[HARD] The run ledger is complete or it is false.** Every run of a gate —
PASS, FAIL, STRUCTURAL, aborted — is recorded where the runs are narrated.
Publishing one FAIL while three are banked is curation; curation of evidence is
treated as seriously as fabrication here, because it produces the same false
confidence. *(Finding S8.)*

1.5 **[STANDING] Pre-register before running.** Expected outcomes (criteria,
bands with stated derivations, or an explicit "thresholds deliberately null —
calibration run") are written to the owning queue BEFORE the run. A gate whose
acceptance criteria are authored by its own landing commit certifies nothing.
Disagreement between expectation and observation is STRUCTURAL — investigate,
never tune. *(Findings F5/Lane C, S16; handbook §6 unchanged.)*

1.6 **[STANDING] Certification claims match what is measured.** A commit or gate
titled "certify X" must contain an assertion that measures X. Peer-calibrated
envelopes that cannot fail, sensitivity gates with no minimum effect size, and
proxy metrics wearing the headline claim's name are each individually a defect.
*(Finding S14.)*

1.7 **[HARD] A certification is validated against a green tree or it is not
landed.** Landing "Harden/Certify" commits against a deleted build, or with the
subject spec red, is void certification. If the tree cannot go green in time,
the honest state is "unvalidated — run owed," stamped as such. *(Finding S7.)*

## 2. Landing discipline — every commit, no exceptions

2.1 **[HARD] Quiet hours:** no commit, push, or visible GitHub activity weekdays
07:00–19:00 US Eastern; the machine clock is authoritative; commits carry
timestamps even if pushed later, so hold work uncommitted during the window.
*(CAMPAIGN_STATE.md; finding S10 — 24 violations.)*

2.2 **[STANDING] Every commit carries:** the `Batch NNNN:` prefix (numbers are
the spine of the evidence system — global, monotonic, never reused, never
skipped silently), a body stating what landed and what it discharges (the
subject line alone is not a record), and the co-author trailer. *(Finding S10 —
88 un-prefixed commits, 98 empty bodies, 0 trailers.)*

2.3 **[HARD] Hooks are never bypassed.** `--no-verify` and equivalents are
prohibited. If a hook blocks a landing incorrectly, that is a ruling request,
not a bypass. The marker guard being red is a reason to fix comments, not to
skip the guard. *(Finding S9.)*

2.4 **[STANDING] Stamp as you land.** The owning queue is updated in the same
landing (or the immediately following doc batch — never more than one batch
behind). A lane that lands 23 commits with zero stamps has produced work the
project cannot see. Landing records live in TRACKED files only; an untracked
handoff is a single `rm` away from erasing 36 landings. *(Findings F1, F2/S1-A.)*

2.5 **[STANDING] Push what you commit** — at minimum at every pause point and
end-of-day (subject to 2.1). A 98-commit local-only range is a machine failure
away from total loss, and invisible to every other lane. *(Discovery at B1033
landing.)*

2.6 **[STANDING] Identity:** commits authored as `cesium-webgpu-agent`; push
auth as `kurtyoung-dev`; leave the active `gh` account as you found it
(`gh auth switch --user kurtyoung-dev` restores it). *(B1033 403 incident.)*

## 3. Instrument doctrine — probes, gates, specs

3.1 **[HARD] Fleet contract compliance is not optional and not allowlistable by
neglect.** Every probe: a TERMINATING watchdog (`setTimeout` whose body exits the
process — `process.exitCode` cannot end a wedged loop), `browser.close()` in
`finally`, and the 0/1/2/3 exit contract with **3 = STRUCTURAL with a named
reason** (2 is harness error; conflating them makes "cannot measure" look like a
crash). If your architecture moves exit semantics into a lib, the contract scan
must be extended to cover it IN THE SAME BATCH — an evasion left standing turns
the fleet's recurrence detector off for everyone. A red fleet contract at the end
of your session is a stop-the-lane defect. *(Findings S4, S5.)*

3.2 **[STANDING] Capture doctrine:** element screenshots are the default;
same-task `toDataURL` through `lib/same-task-capture.mjs` (with its validators)
is the sanctioned in-page alternative; `drawImage → getImageData` on a WebGPU
canvas is prohibited. Pins are written both directions and read back.
*(Finding S15; post-reconciliation text in the handbook is authoritative.)*

3.3 **[STANDING] Shared homes before hand-rolling.** Before writing a helper
(sha256, canonical JSON, exit mapping, git provenance, capture, viewer config),
grep `Tools/visual-regression/lib/` and use or extend the existing home. Five
SHA-256 implementations and six exit maps — one of them wrong — is how one
defect becomes six. New shared infrastructure that nothing consumes is filed as
scaffolding with a named consumer task, or not landed. *(Findings S19, S22.)*

3.4 **[STANDING] Bars are derived, not asserted.** Every numeric threshold
carries its derivation (error budget, resolution argument, or an explicit
citation to a ratified value). A bare round number one line below an exemplary
derivation is a defect. Hermeticity: a spec must import cleanly and fail
STRUCTURAL — not product-FAIL — when a build/asset prerequisite is absent, and
must not do filesystem work at import time. *(Findings F6/Lane C, S22.)*

3.5 **[STANDING] House scale.** Probes and gate libs stay near fleet scale
(probes: median ~255 lines, prior max ~4k). If a file is trending past ~2× the
prior fleet maximum, the design is wrong — usually hand-rolled validation that
belongs in a shared schema helper. Stop and restructure rather than continuing
to type. *(Finding F7/Lane C.)*

## 4. Capacity and the pause protocol

4.1 **[STANDING] Pause EARLY, not at collapse.** The observable signature of a
lane past capacity — batch numbering stops, bodies go empty, stamps stop, specs
land red — is now a named pattern. At the FIRST of those signs, stop landing,
write the handoff, and pause. The candid handoff Sol wrote at the end was the
right artifact at the wrong time. *(Findings S7, S10; grade feedback.)*

4.2 **[STANDING] The handoff is a TRACKED file, written before the pause, with:**
the paused-file inventory (byte counts + SHA-256), what is finished vs
mid-repair vs rejected, the resume protocol, and any environment state (build
artifacts with paths verified — a hash table pointing at a directory that does
not exist fails its purpose; declared worktrees; account state). *(Findings F2,
D6/D8-Lane F; the §3 path-label error.)*

4.3 **[STANDING] Frozen means frozen.** Files declared paused in a handoff are
not edited, run for certification, or treated as green by anyone — including
their author resuming informally. Resumption follows the handoff's own protocol
(rehash → finish → independent re-review → path-scoped commits). *(Lane F D1/D2;
ruling R-2026-08-14-8.)*

## 5. Escalation — when to stop and ask

Ask the maintainer (via a filed RULING REQUEST) before: de-scoring any red
(1.1); changing a ratified bar or its operative precondition; deleting a guard;
adopting an external dependency or reference implementation (license
determination first — the Inria trap is endemic); any history rewrite; any
destructive cleanup of state you did not create. Ask the orchestrator (or file
and continue) for: a blocking hook you believe is wrong; a fleet-contract rule
your architecture cannot satisfy; a shared home that needs extending.

## 6. Enforcement

The R-2026-08-14-4 hardening makes 2.1/2.2/2.3 mechanical: a pre-push hook
enforcing trailer + batch prefix + quiet-hours, and a bypass-evident verify step
re-running the marker guard over the pushed range. The fleet contract (extended
to gate libs) enforces 3.1. Everything else is enforced the way it was enforced
this week: the work gets audited, omissions are found, and the grade reflects
them. The cheapest path through this charter is compliance; the second-cheapest
is a ruling request; there is no third path that survives an audit.
