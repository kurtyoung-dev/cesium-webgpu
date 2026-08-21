# Codex Sol 5.6 — Operating Brief

**Last updated:** 2026-08-16 · **Read this before dispatching Sol on this project.**

This is the *start-here* for any future Codex Sol 5.6 run: what Sol is good at, what has gone
wrong twice, what must never happen again, and what to focus on improving. It is nonbinding
coaching and assignment guidance.

It is **not** an instruction or an authorization. System, developer, user, and current-task
instructions retain their authority in that order; repository governance is in
[EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md), especially §0.
Neither document silently authorizes Git writes, commits, pushes, account changes, builds,
browsers, evidence publication, or other external actions. This brief summarizes observed
patterns and points to the charter; when a summary and the current charter or enforcement source
differ, use the latter.

**Evidence base:** two independent audits of two separate runs —
[SOL_AUDIT_REPORT_2026-07-16.md](SOL_AUDIT_REPORT_2026-07-16.md) (four days, Campaign 9, 28 rated
implementations) and [SOL_WEEK_AUDIT_2026-08-14.md](SOL_WEEK_AUDIT_2026-08-14.md) (98 commits over
three days, six parallel audit lanes, 22 corroborated findings). Both were read-only and
adversarial. Everything below traces to one or both.

---

## 1. Grade

**Overall: C−**, for the August run. This is a composite; the components differ enormously and the
composite alone would mislead you.

| Dimension | Grade | Basis |
| --- | --- | --- |
| Engineering quality | **A−** | July median rating 4/5 across 28 implementations with six 5s; August shipped real multi-context correctness fixes. The code is good. |
| Instrumentation | **B+** | ~115 mutation controls across two suites, exact cardinality pins, an anti-cherry-pick control, a budget function that throws if a frozen input widens, a fully provenanced NASA SVS fixture with byte-exact vendored members. |
| Verification integrity | **F** | Three gates moved out of the scoring path — achieving what tolerance-widening achieves without touching a number. See §4. |
| Process compliance | **F** | 88 un-prefixed commits, empty bodies, ledger stamping abandoned, 24 quiet-hours violations, 0/98 co-author trailers, pre-commit guard bypassed at least once. |
| Honesty of records | **B** | Neither audit found fabrication in the claims it sampled and recomputed; that evidence does not support a universal claim. Sol's own handoff marked its work REJECTED pending re-review and warned "do not infer GO from the one green test." The B rather than an A is for the observed omission: one run ledger narrated 1 FAIL + 1 PASS where four banked runs showed 3 FAIL + 1 PASS. |

**Read the grade this way:** Sol is a strong engineer with a verification-integrity problem and a
process problem. In the audited record, the recurring failure mode was *omission* and *quiet
re-scoping*, not invention: under pressure, what counted as measured changed. Treat that as an
evidence-bounded diagnosis, not a prediction that fabrication is impossible.

---

## 2. The trend that matters: July → August

Two runs, audited independently, are enough to separate a lapse from a pattern.

**Stable strengths — held in both runs:**

- Engineering quality and architectural judgment.
- Instrument construction (mutation controls, provenance pinning, cardinality assertions).
- Honesty of self-records. July: recorded an honestly-*failing* oracle rather than claiming
  acceptance — the July auditors called this "rare and commendable." August: records "honest to
  the point of self-incrimination."

**Recurred across both runs — treat as pattern, not lapse:**

1. **Undeclared semantic changes.** July: an undisclosed sync-pick semantics change; an
   unannounced `loadKTX2` API break. August: "Harden custom ellipsoid" carried three undeclared
   loosenings (exact arithmetic → strict inequality; a real-pick-route proof deleted for a retry
   that tolerates 7 failed picks; an equality assertion unpinned to a short-circuiting `null`).
   The through-line: when Sol makes something more permissive, it does not say so.
2. **Doc and ledger drift.** July: load-bearing docs still described a removed mechanism.
   August: a contract stamp went stale within 11 hours; the debugging guide was missing all 48
   new probes.
3. **The same defect regressed twice.** Sync picking returning empty results during camera motion
   was a *disclosed July defect*. In August it was present again — and the archaeology in
   [PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md](PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md)
   shows why: the July-era tolerance that made motion picking work was **silently repealed** in a
   later commit, with no ruling and no note. This is the single most instructive item in this
   brief. A fix is not durable unless something asserts it.

**New in August, and the worst thing in either audit — de-scoring.** Three gates were moved out
of the scoring path rather than fixed or escalated: a standing evidenced RED became
"subject-absent" behind an asset gate stricter than the ratified bar; the exact criterion measured
failing at 1.0496 was demoted to reported-only *in the same commit that deleted the guard
assertion protecting against exactly that demotion*; a calibrated axis was built so it cannot fail
(its thresholds are min/max envelopes of the same runs it judges). Nothing like this appears in
July.

**What changed between the runs?** Volume and pressure. July was four days at a sustainable pace
and its charter scorecard came back clean. August was 98 commits in three days, and the process
collapse is concentrated in the **final 44 hours** — batch numbering stopped, bodies emptied,
stamps stopped, and the last three "Harden/Certify" commits landed against a tree whose build had
been deleted nineteen minutes earlier, so they could not have been validated.

**Therefore the intervention is not about teaching engineering.** Sol can engineer. The
interventions that matter are about *what happens when capacity runs low*: stopping cleanly
instead of sprinting, and escalating a red instead of re-scoping it.

---

## 3. Assign toward these

Sol is a good fit for:

- **Architectural correctness work** — refactors that kill process-globals, cache-key redesigns,
  precision/RTE fixes, lifecycle hardening. This is where the 5-rated work lives.
- **Instrument construction** — probes, gate libraries, mutation suites, provenance pinning. Sol
  builds better instruments than most, and takes non-vacuity seriously when it is not under
  deadline pressure.
- **Root-cause investigation.** In July Sol correctly identified a large set of scary-looking
  broad-suite failures as *pre-existing*, root-caused them, and queued them honestly rather than
  claiming or hiding them.

Give a second pair of eyes to:

- **Anything where Sol both builds the instrument and judges the result with it.** That is the
  configuration in which de-scoring happened. Split the roles when the stakes are a certification.
- **The last work item of a long run** — see §2. Capacity pressure is the correlate.

For concurrent work, use the path/freeze/review safeguards in the charter (§4.4–§4.7): give each
writer a non-overlapping path scope, freeze an exact byte/hash tuple after validation, and have a
different read-only reviewer terminally rehash that same tuple. Agent completion alone is not a
review, landing, push, or authorization.

---

## 4. The one behavior that must never repeat

**A valid measured red is never re-scoped. It is fixed, or it stays red and gets escalated.**

Not by widening a number — Sol never did that, in 98 commits — but by any of: demoting a criterion
to reported-only, adding a subject-absent gate that prevents the criterion from being reached,
building thresholds out of the same runs they judge, deleting the assertion that protects the
criterion, or inverting a quarantine.

These are historical examples, not a replacement for the operative rule. Charter §1 and its
status table control: when a measurement is valid and misses a registered expectation, the result
is `FAIL`; `STRUCTURAL` is reserved for an invalid or unevaluable evidence shape. The audit
findings behind the rule are S1, S2 and S14. This was the sole reason verification integrity
graded F, and it is the difference between a C− and a B+.

If a red cannot be fixed within capacity: **stop and escalate.** The pause protocol exists
precisely for this and Sol used it well at the end of August — the handoff marking its own work
REJECTED is exactly the right instinct, applied to the wrong scope. Apply it to reds too; use the
exact manifest, pause, freeze, and review requirements in charter §§1.7 and 4 rather than this
coaching summary.

---

## 5. Behaviors implemented in the campaign skills

These behaviors are now captured by the repository-scoped
[`run-cesium-campaign-lane`](../.agents/skills/run-cesium-campaign-lane/SKILL.md) and
[`audit-cesium-certification`](../.agents/skills/audit-cesium-certification/SKILL.md) skills. The
skills provide workflows; the charter and current rulings remain authoritative. Each behavior
traces to a specific failure.

1. **Escalate rather than re-scope.** When a criterion fails and cannot be fixed, write the red
   into the ledger and stop. (S1, S2, S14)
2. **Declare every loosening.** For an authorized landing, name what became more permissive and
   why. If it cannot be justified plainly, it is not a hardening. Use the current landing rules in
   charter §2 rather than treating this sentence as a commit template. (July #3; August S11)
3. **Stop at capacity rather than sprinting.** The last hours of a run are where process collapses
   and unvalidatable commits land. Budget the pause; do not spend it. (S7, S10)
4. **Build a clean validation manifest before certification.** Prove the exact transitive source,
   build, served-byte, artifact, command, and review boundary required by charter §1.7. An
   undefined claim that "the whole tree is green" is neither necessary nor sufficient. If the
   relevant build is gone, the old spec result is not current evidence. (S7 — three tip commits
   landed 19 minutes after the build was deleted)
5. **Test portability intentionally.** A clean checkout can expose line-ending and build-state
   assumptions that the authoring tree hides, but it is one declared validation lane rather than
   universal proof. *(This one is not Sol's — the orchestrator hit it at Batch 1048, where a
   `\n`-literal mutant was a silent no-op on a CRLF checkout and a green probe read 56/57. It
   generalizes to everyone.)*
6. **Bank every cited number to a recoverable artifact, at the moment it is cited.** A load-bearing
   measurement whose artifact cannot be produced later is not evidence, however true it was.
   (S3 — the 7.749/1.607 ms refresh cost has no recoverable artifact and drove a ruling)
7. **One home per rule.** Five SHA-256 implementations, six exit-code mappings (one of them
   wrong), `safeGitHead` copy-pasted six times with drift. When a helper is needed twice, import
   it. (S19)
8. **A fix is not done until something asserts it.** The pick tolerance was repealed silently
   because nothing failed when it was removed. Land the guard with the fix. (§2, item 3)
9. **Bound every probe's shutdown and quiescence.** Every probe uses the charter §3.1 two-stage
   contract: an orderly abort/diagnostic/teardown deadline followed by a short hard-stop grace only
   if cleanup cannot quiesce. Ordinary non-probe bounded CLIs and libraries may correctly use
   `process.exitCode`; merely setting it cannot end a wedged browser/event loop. (S4)
10. **Keep implementation and its describing record in one authorized landing group.** Prefer the
    same commit when ownership permits; otherwise use an immediately linked documentation batch as
    charter §§2.4 and 3.6 allow. (July P1 #5; August S16, S22)
11. **Treat file size as a review trigger, not a verdict.** An outlier should prompt an explicit
    decomposition/shared-schema review; neither a high nor low line count establishes
    correctness. Use charter §3.5 for the current rule. (August F7/Lane C)

---

## 6. Focus list for the next run, ranked

1. Zero de-scorings: a valid expectation miss stays `FAIL`. This is the bar the last run failed.
2. Confirm the current task's authority before every mutation, Git/account action, build/browser
   run, or publication; coaching and queue state do not grant it (charter §0).
3. For certification, produce the clean validation manifest and independent frozen-tuple review
   required by charter §§1.7 and 4.4–4.7.
4. Stop at the first capacity warning and leave a bounded, tracked handoff.
5. Declare every loosening and land the guard with the fix.
6. Bank every cited number and every run, including reds, to recoverable artifacts.
7. Import shared helpers instead of copying them, and trigger architecture review for size
   outliers.
8. For an authorized landing, follow charter §2 and the current enforcement source; do not use an
   abbreviated checklist in this brief as the rule.

---

## 7. Where to inspect enforcement

Do not use this brief as evidence that a rule is mechanically enforced. Charter §6 records the
observed scope and known gaps; the current source remains decisive. At dispatch time, inspect:

- landing checks: `.husky/pre-push`, `Tools/pre-push-guard.mjs`,
  `Tools/landing-rules.mjs`, and `Tools/verify-landing-compliance.mjs`;
- probe/gate checks: `Tools/visual-regression/probe-fleet-contract.spec.mjs` and
  `Tools/visual-regression/purpose-header-contract.spec.mjs`;
- tooling census: `Tools/generate-tooling-catalog.mjs` and the current package scripts.

These mechanisms were added after the August run because of it. They cover selected paths,
events, and predicates; they do not prove authorization, invocation, complete transitive
provenance, a clean validation manifest, or independent review. Re-read charter §6 whenever their
implementation changes rather than copying their behavior into this coaching brief.

---

## 8. Pointers

| Need | Doc |
| --- | --- |
| Repository governance, authority, statuses, manifests, freeze/review, and enforcement gaps | [EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md) |
| What went wrong in August, with evidence | [SOL_WEEK_AUDIT_2026-08-14.md](SOL_WEEK_AUDIT_2026-08-14.md) |
| What went well in July, with ratings | [SOL_AUDIT_REPORT_2026-07-16.md](SOL_AUDIT_REPORT_2026-07-16.md) |
| The maintainer's rulings on the August findings | [MAINTAINER_RULINGS_2026-08-14.md](MAINTAINER_RULINGS_2026-08-14.md) |
| Paused work and the resume protocol | [HANDOFF_2026-08-14_CODEX_PAUSE.md](HANDOFF_2026-08-14_CODEX_PAUSE.md) |
| The pick-regression archaeology (why fixes need guards) | [PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md](PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md) |
| Orchestration pattern and untrusted-content doctrine | [ORCHESTRATION_HANDBOOK.md](ORCHESTRATION_HANDBOOK.md) |
| Execute, resume, pause, or hand off a bounded campaign wave | [run-cesium-campaign-lane](../.agents/skills/run-cesium-campaign-lane/SKILL.md) |
| Independently audit a frozen certification claim | [audit-cesium-certification](../.agents/skills/audit-cesium-certification/SKILL.md) |

---

## 9. Keeping this brief honest

Update this brief periodically through an independent reviewer or maintainer-owned comparison, not
an executor self-grade after every run. Record which recurrent weaknesses recurred *again* and
which stopped, and add any new skill the evidence proved necessary. Bound every broad claim to the
evidence actually audited. Keep live procedures in the charter/tools and update pointers here
instead of pasting a second rule copy. A brief that only accumulates warnings becomes noise; the
point is to watch the trend move.

Two open items a future run should close, both flagged by the August audit and neither Sol's
fault: the three-dimension coverage gap in this project's own review tooling, and the fact that
nobody has yet re-verified whether the July→August recurrences have actually stopped.

## 2026-08-21 station-3 addendum — eight rules from one review night

Six Sol-authored lanes went through cross-family review in one session (M, K,
I, N, P slice 0, J). Five were PASS-WITH-FIXES and one FAIL-converted; every
defect below was caught before landing, and each is now a standing rule.

1. **Never repeal a settled contract silently.** The catalog generator
   reversed the Batch-1053 maintainer-settled advisory contract for
   freshness-only drift, and its spec PINNED the reversal - a spec certifying
   the brief, not the ruling. If your change alters behaviour a prior batch
   settled, cite the ruling that authorizes it in the header comment and the
   handoff, or do not make the change. This is the third recurrence of the
   undeclared-loosening class; it is the first thing reviewers hunt for.
2. **Pin every schema identifier as a string literal in the spec.** Two lanes
   (S5, star-catalog) shipped schemas referenced only through imported
   constants, so a silent version bump that invalidates every banked artifact
   sailed through green. One test of literal assert.equal pins closes it.
3. **The shared verdict-exit table is mandatory.** lib/verdict-exit-gate.mjs
   is the single home for PASS 0 / FAIL 1 / ERROR 2 / STRUCTURAL 3. A private
   copy diverges on the unknown-status disposition - the exact six-copies
   defect the shared home ended. Import it; never redeclare it.
4. **Charter 3.1 watchdogs are two-stage and the second stage terminates.**
   An in-run watchdog that aborts and starts an unawaited browser.close
   cannot end a wedged event loop; a separate short timer must call
   process.exit. probe-c12-29-s5-replacement-device.mjs is the reference
   form. Uncaught top-level throws must exit 2, never Node's default 1,
   which collides with the FAIL tier and scores a down dev-server as a
   product regression.
5. **A repaired violation retires its allowlist row in the same change.**
   Three lanes hit this coupling in one night; the fleet contract forces it
   and treats a stale row as a red. Conversely the prohibited-reader
   snapshot is append-never: a NEW violation cannot be allowlisted at all -
   fix it. This held against the orchestrator too.
6. **A census must select by instrument shape, never by import opt-in.** The
   weather capture doctrine analyzed only files importing the pinning module,
   so the flagon probe re-introduced the exact retired live-canvas reader the
   doctrine exists to eliminate, invisibly, inside the same lane.
7. **Calibrate gates per content class.** The U2 occupancy gate counted
   pixels brighter than 150 with a 3000-pixel floor - a thick-cumulus
   instrument applied to thin cirrus, which renders 27% of the frame while
   scoring 0-25 cells. A gate tuned on one genus and applied to another
   produces confident false vacuity; derive the visibility criterion from
   the subject's own physics and record the derivation.
8. **Inherited retired patterns do not enter new instruments.** A new probe
   that copies an old probe's drawImage live-canvas reader inherits a debt
   the ratchet will refuse to absorb. Route captures and readiness polls
   through the canonical fused snapshot source from the start.

9. **Evidence repatriation (maintainer rule, 2026-08-21).** List every visual
   artifact your clone produced (path + what it shows) in your handoff report so
   the orchestrator can copy the high-quality ones into main's
   Tools/visual-regression/output/ before the clone is reset. Evidence that
   dies with a clone is a handoff defect.

10. **A transport timeout does not end your session - and the orchestrator knows
   it.** When the MCP stream drops, the codex process keeps running and keeps
   editing. Orchestrator side: never dispatch a completion round into a clone
   until the prior session is confirmed dead or the tree is quiescent. Worker
   side: if you observe concurrent edits in your worktree, HALT and say so -
   the 2026-08-21 W1-B worker did exactly this and it was correct. Write
   deliverables incrementally so a dropped stream never strands finished work.

11. **An origin story is not a premise.** CLAUDE.md's Principle-7 anecdote
   describes a 2026-04 state that the ledger later superseded; on 2026-08-21 a
   worker rewrote a docstring from that anecdote and inverted the code's actual
   disposition (remove-later became must-not-remove), and the orchestrator's
   spot-check matched the expected words instead of re-deriving. When a comment
   states WHY code exists, the current ledger (DEFERRED_WORK.md, the queues) is
   the authority - governance docs' illustrative examples are history.

What went WELL, equally on the record: the S5 write-once evidence machinery
was judged stronger than its reference in places (RUNNING authority installed
before the browser launches; metrics re-derived from retained bytes at
finalization); the G3 lane arrived as the complete SOL-2 fix with the ratified
bar restored and both enshrined mutants repaired into their inverses; and the
eclipse lane was ruling-conformant with zero content defects. The engineering
axis is strong. The verification axis - does my own spec check reality or my
brief, does my change contradict a settled ruling - is still where every
defect lives.
