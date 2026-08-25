# Codex disagreements and reconciliation with the Fable review — 2026-08-16

**Status:** governance reconciliation packet; no campaign implementation is authorized by this
document. The repository-wide campaign pause remains controlling: governance work may proceed only
when expressly authorized, while implementation, certification runs, evidence mutation, and Git
state changes remain prohibited
([`CAMPAIGN_STATE.md`, lines 31–50](CAMPAIGN_STATE.md#L31-L50)).

**Primary Fable-specific source:**
[`FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md),
which pins its source range and Batch-731 cutoff at
[lines 5–11](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L5-L11).

**Comparison/context only:**
[`SOL_AUDIT_REPORT_2026-07-16.md`](SOL_AUDIT_REPORT_2026-07-16.md),
[`SOL_C13_REVIEW_2026-07-23.md`](SOL_C13_REVIEW_2026-07-23.md),
[`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md), and
[`CODEX_SOL_OPERATING_BRIEF.md`](CODEX_SOL_OPERATING_BRIEF.md). Current maintainer decisions are in
[`MAINTAINER_RULINGS_2026-08-14.md`](MAINTAINER_RULINGS_2026-08-14.md), with the earlier decision
history preserved in
[`MAINTAINER_RULINGS_2026-08-10.md`](MAINTAINER_RULINGS_2026-08-10.md).

This packet uses **FACT** for a statement directly supported by the linked source, **INFERENCE** for
an interpretation that still needs confirmation, and **DECISION NEEDED** for a choice reserved to
Fable/the maintainer. “Disagreement” includes a temporal or scope qualification; it does not imply
dishonesty. Nothing here alleges fabrication. Within its audited and recomputed sample, the August
Sol audit likewise found no evidence of fabrication and explicitly separated omissions/re-scoping
from invention
([lines 23–28](SOL_WEEK_AUDIT_2026-08-14.md#L23-L28)).

---

## 1. Executive reconciliation

The Fable audit is a strong, unusually careful performance/action review. Its most reusable
contributions are its feature-preservation rule, exact-bundle claim boundaries, separation of two
different backend bottlenecks, conservative consumer inventories, and insistence on A/B evidence
before topology changes. I found no basis to reverse those technical principles.

The qualifications are chiefly governance and time-domain issues:

1. “Current” in the July audit means **the Batch-731 cutoff**, not 2026-08-16 HEAD.
2. The document mixes its original July-22 audit with a July-28/August-1 F5-17 addendum while its
   top-level source range and COMPLETE label remain unchanged.
3. Outcomes from an orchestrated, shared-identity range should be attributed to the audited range or
   orchestration unless an author/task map proves individual authorship.
4. Its action queue is a historical recommendation set, not permission to resume work during the
   current pause.
5. The later G3 and Moon disputes are **not findings from Fable's July audit**. They arose in the
   August Sol audit and were ruled afterward.
6. The pre-reconciliation Codex operating brief contained overstatements and copied rules. The
   2026-08-16 update keeps binding policy in the charter and role workflows in two repository skills;
   the historical brief still should not be turned wholesale into a portable skill.

---

## 2. What we agree with in the Fable audit

| Topic | Agreement | Source |
| --- | --- | --- |
| Feature preservation | Performance work must improve implementation without removing, bypassing, or visually degrading the feature merely to improve a metric. | [Fable audit, lines 13–16](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L13-L16) |
| Exact-bundle claims | A measured parity result belongs to the exact bundle/environment that produced it; it is not a permanent claim for later HEADs. | [Fable audit, lines 67–68](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L67-L68) |
| Two bottlenecks, not one verdict | WebGPU's steady-state CPU floor and WebGL's recurring long stalls are separate optimization problems and should not be collapsed into “which renderer is slower?” | [Fable audit, lines 42–49](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L42-L49) |
| Bounded visual evidence | The nine-waypoint route validates its offline ellipsoid/NaturalEarthII subject, not real terrain, water, dense 3D Tiles, optional OIT, or every post-process consumer. | [Fable audit, lines 126–134](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L126-L134) |
| Honest incomplete test state | A stopped full suite is neither a complete green nor a complete red, and unrelated global-lint debt must remain separately attributed. | [Fable audit, lines 148–161](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L148-L161) |
| Lifecycle before optimization | Terrain and ocean resources need correct device/context/provider ownership and post-submit retirement before adding retention optimizations. | [Fable audit, lines 212–231](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L212-L231), [lines 380–403](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L380-L403) |
| Conservative demand gating | Inventory all consumers, let unknown consumers force the safe path, and separately assert demand from actual pass opens. | [Fable audit, lines 405–445](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L405-L445) |
| Controlled A/B before promotion | Preserve exact one-target/MRT variants, prewarm and commit topology atomically, and promote only after GPU/API/visual A/B evidence. | [Fable audit, lines 410–428](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L410-L428) |
| Positive controls and temporal evidence | Optional-path gates need feature-on controls; temporal behavior cannot be certified by a final still. | [Fable audit, lines 462–477](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L462-L477) |
| Evidence before performance claims | Pair provenance, refresh/pacing scope, local representative fixtures, tracing, and exact environment identity belong ahead of another broad performance claim. | [Fable audit, lines 358–378](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L358-L378) |
| Concrete consumers before abstraction | Do not integrate a parallel ownership framework without a zero-copy contract and a concrete measured consumer. | [Fable audit, lines 321–343](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L321-L343) |

These principles are consistent with the later Sol reviews' strongest findings: honest negative
evidence, scope boundaries, and guard-backed fixes were strengths in July
([`SOL_AUDIT_REPORT`, lines 12–22](SOL_AUDIT_REPORT_2026-07-16.md#L12-L22)); the August problem was
not fabricated measurements but changing what remained in the scoring path
([`SOL_WEEK_AUDIT`, lines 30–47](SOL_WEEK_AUDIT_2026-08-14.md#L30-L47)).

---

## 3. Concrete disagreements and qualifications with Fable's actual audit

### F-1 — “Current” must remain attached to Batch 731

**FACT.** The audit fixes its source at clean `main` Batch 731
([lines 5–7](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L5-L7)), but later says “Current HEAD”
is not CPU-parity certified
([lines 31–32](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L31-L32)), labels findings as current
([lines 168–190](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L168-L190)), and ends with a “Current
recommendation” ([lines 509–530](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L509-L530)).

**Qualification.** Those statements can only establish the state of the pinned audit cutoff. They do
not establish 2026-08-16 product state.

**Why it matters.** Dispatching a July “confirmed” item as if its premise were still true can reopen
already-fixed work or apply an obsolete architecture recommendation.

**Reconciled wording/action.** Replace the semantic reading—not necessarily the historical bytes—with:
“At the Batch-731 audit cutoff…” and require a focused premise re-check before any item from §5/§6 is
dispatched.

### F-2 — The F5-17 addendum creates mixed temporal provenance

**FACT.** The findings register describes F5-17 as a leading hypothesis
([lines 188 and 207–208](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L188-L208)). A later section,
explicitly dated 2026-07-28, says it is no longer only a hypothesis and records an implementation
landed on 2026-08-01
([lines 248–289](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L248-L289)). The document header still
advertises one COMPLETE audit and the original source range
([lines 1–7](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L1-L7)).

**Disagreement.** A durable audit should not present an original register and a superseding result as
one undifferentiated temporal snapshot.

**Why it matters.** Readers can cite either “leading hypothesis” or “proved” from the same authority,
and automated extraction cannot know which is operative.

**Reconciled wording/action.** Keep the original finding immutable, add a top-level amendments table
with amendment date/source range/status, and mark F5-17 `SUPERSEDED BY ADDENDUM A1`. Prefer a dated
successor report for future updates.

### F-3 — Attribute the range, not a single model, unless the author map proves it

**FACT.** The audit covers 78 commits across four campaign phases
([lines 22–24](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L22-L24)) and then says “Fable 5 made”
the progress ([lines 26–29](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L26-L29)). Current campaign
records describe an orchestrator dispatching model-matched subagents and landing reviewed worker
diffs ([`CAMPAIGN_STATE.md`, line 61](CAMPAIGN_STATE.md#L61)). The later August audit warns that all
commits used one shared identity and therefore attributes by range
([`SOL_WEEK_AUDIT`, lines 9–17](SOL_WEEK_AUDIT_2026-08-14.md#L9-L17)).

**INFERENCE.** Some July outcomes may have been implemented by workers under Fable orchestration
rather than authored solely by Fable. This packet does not have a complete July task/author map.

**Why it matters.** Model-performance conclusions and future task assignment become unreliable if
orchestration, implementation, review, and landing are conflated.

**Reconciled wording/action.** Use “the audited Fable-orchestrated range produced…” unless a task map
supports a narrower attribution. Record `orchestrator`, `implementer`, `reviewer`, and `lander`
separately in future audit manifests.

### F-4 — COMPLETE means the audit is complete, not that remediation is complete

**FACT.** The header says COMPLETE
([line 3](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L3)), while the document itself lists open
follow-up and missing integration coverage
([lines 494–505](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L494-L505)).

**Qualification.** The status is reasonable for the review activity, but ambiguous for downstream
campaign readers.

**Reconciled wording/action.** Render two fields: `AUDIT_STATUS=COMPLETE` and
`REMEDIATION_STATUS=OPEN/HISTORICAL`.

### F-5 — The action queue is historical advice, not a live dispatch authority

**FACT.** The audit assigns `DO FIRST`, `FIX EARLY`, and related decisions
([lines 293–322](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L293-L322)) and recommends proceeding
([lines 509–530](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L509-L530)). Current campaign state
forbids resuming queued implementation or running campaign builds/browser probes during the pause
([`CAMPAIGN_STATE.md`, lines 31–50](CAMPAIGN_STATE.md#L31-L50)).

**Disagreement only as applied today.** Fable's ordering was valid advice at its cutoff; it is not
current authorization.

**Reconciled wording/action.** Treat §5/§6 as a historical candidate queue. Reverify each premise and
obtain an explicit resume/dispatch decision before work.

### F-6 — Artifact links need immutable identity in the audit record

**FACT.** The audit links dated performance artifacts
([lines 51–52](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L51-L52),
[lines 119–124](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L119-L124)), but the audit prose does
not pin their byte sizes and SHA-256 values. A later Sol review documented artifacts overwritten or
superseded by later runs
([`SOL_C13_REVIEW`, lines 94–99](SOL_C13_REVIEW_2026-07-23.md#L94-L99)). The current
[`executor charter §1`](EXECUTOR_LANE_CHARTER_2026-08-14.md#1-verification-integrity--the-non-negotiables)
requires a recoverable artifact at citation time.

**Qualification.** The linked July artifact files exist in the present tree, but path existence is
not the same as immutable identity.

**Reconciled wording/action.** Future audit tables should carry artifact path, byte size, SHA-256,
producer/schema version, source hash, bundle hash, and run timestamp. A mutable `latest` path may be
listed only beside the immutable record it resolves to.

### F-7 — File/count growth is a coverage signal, not semantic coverage

**FACT.** The audit infers an integration-coverage lag from source files changed without an engine
Spec change ([lines 163–164](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L163-L164)), and later
correctly says increased module/spec/test counts do not prove semantic coverage
([lines 496–499](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L496-L499)).

**Qualification.** The first statement is a useful triage heuristic, not a verdict on whether a
behavioral contract is covered by another spec, integration gate, or mutation control.

**Reconciled wording/action.** Label co-change counts `coverage-risk proxy`; certify closure only with
a requirement-to-test map, negative controls, and mutation evidence.

### F-8 — The visual aggregate cannot certify localization or temporal stability

**FACT.** The audit reports mean/max cross-backend pixel differences for nine captures
([lines 128–130](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L128-L130)) and immediately states
the route's exclusions ([lines 132–134](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L132-L134)).

**Qualification.** Mean and maximum image-level aggregates can miss localized, semantic, or temporal
defects. The audit itself later requires temporal sequences because a final still cannot prove
history stability ([lines 473–477](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L473-L477)).

**Reconciled wording/action.** Describe the nine-waypoint result as a bounded static regression lane,
not feature parity. Add semantic masks and temporal controls per claimed feature.

### F-9 — No technical reversal is justified without a current premise audit

**INFERENCE.** F5-02 through F5-19 may have changed after Batch 731. This governance pass did not
inspect or run the current engine/browser subjects, because the campaign is paused. Therefore this
packet neither reaffirms nor refutes their present product status.

**Reconciled action.** When the pause is lifted, use the Fable findings register as the input to a
read-only premise-reconciliation pass before scheduling fixes. Preserve the original findings as
historical facts even when a present-day premise is closed.

---

## 4. Qualifications to later Sol governance documents — not disagreements with Fable's July audit

These items must not be attributed to the Fable performance audit. They were identified while
reviewing the later Sol governance documents. The accompanying 2026-08-16 governance update resolved
the wording/tooling items below; they remain recorded here so Fable can see what changed and why.

### S-1 — Keep the operating brief as coaching, not a second rule source

**Original issue.** The operating brief described itself as coaching while repeating operative
requirements, creating a policy-drift risk.

**Resolution (2026-08-16).** The brief now points to the binding charter, the current enforcement
source, and the two repository skills. Its behavior list is explicitly coaching; authority,
exceptions, and exact mechanics remain in the
[`Executor Lane Charter`](EXECUTOR_LANE_CHARTER_2026-08-14.md).

### S-2 — Model/persona grading is history, not a portable control surface

**Original issue.** The brief is a dated review of “Codex Sol 5.6.” Treating that persona as a live
dispatch interface would not generalize to multi-agent work.

**Resolution (2026-08-16).** The brief remains historical coaching. The new
[`run-cesium-campaign-lane`](../.agents/skills/run-cesium-campaign-lane/SKILL.md) and
[`audit-cesium-certification`](../.agents/skills/audit-cesium-certification/SKILL.md) skills assign
execution and independent-review roles by task and evidence boundary, not model persona.

### S-3 — “Same commit” overstated the binding ledger rule

**Original issue.** A universal same-commit rule conflicts with disjoint path ownership and with
investigations whose conclusion is “no product fix.”

**Resolution (2026-08-16).** Charter §§2.4 and 3.6 and the brief now require one linked, authorized
landing group: the same commit when ownership permits, otherwise an immediately linked reviewed
batch. The archive/no-fix path is explicit.

### S-4 — Build/clean-checkout language needed evidence-prerequisite scope

**Original issue.** A missing built application invalidates build/browser-dependent certification,
not a pure-Node parser, schema, or static-policy test. In a shared dirty worktree, “clean checkout”
must never imply resetting another lane's state.

**Resolution (2026-08-16).** Charter §1.7 now defines a claim-specific clean validation manifest and
allows a stable, named unrelated-red baseline outside the transitive boundary. The brief now says to
claim only the evidence class whose declared prerequisites passed.

### S-5 — Every probe needs a watchdog; not every Node program is a probe

**Original issue.** The earlier prose could be read as applying a terminating watchdog to every Node
program. Ordinary non-probe bounded CLIs and libraries may correctly use `process.exitCode`; an
immediate `process.exit` is an exceptional hard-stop when a probe fails to quiesce.

**Resolution (2026-08-16).** Charter §3.1 defines the orderly-deadline/hard-stop-grace state machine,
and the brief now applies it to every probe while preserving the non-probe CLI/library distinction.

### S-6 — Enforcement descriptions needed actual predicates and exemptions

**Original issue.** Hooks and after-the-fact checks were described as if they mechanically prevented
all violations.

**Resolution (2026-08-16).** Charter §6 now lists each observed mechanism, enforced scope, and known
gap. It explicitly states that the hook is push-time and bypassable, the range verifier is manual,
and neither proves authorization, full invocation, or complete provenance.

### S-7 — “Every header” and “all drift” were too absolute

**Original issue.** The live tooling has a named shrink-only purpose-header allowlist, and catalog
freshness-only changes can be advisory. Absolute prose hid those qualifications.

**Resolution (2026-08-16).** The brief now points to the current source rather than restating a
universal claim. Charter §§3.6 and 6 retain the visible allowlist and distinguish structural census
coverage from probe correctness.

---

## 5. Current maintainer-ruling conflicts requiring reconciliation

### 5.1 G3: the ratified bar is `>= 2700`; 4096 is an upgrade, not a certification precondition

This issue is **not present in Fable's July audit**. It is a later celestial-certification conflict.

**Earlier ruling/history.** `R-2026-08-10-4` ordered a 4096/face re-bake and G3 rerun, with fallback
options preserved ([lines 96–111](MAINTAINER_RULINGS_2026-08-10.md#L96-L111)). That remains a valid
asset-improvement direction.

**Later audit finding.** The August Sol audit found that an exact-4096 precondition converted a
standing red against the ratified `>= 2700` bar into SUBJECT-ABSENT
([lines 53–56](SOL_WEEK_AUDIT_2026-08-14.md#L53-L56)) and requested either restoration of `>= 2700`
or an actually bundled 4096 tier ([lines 97 and 110–112](SOL_WEEK_AUDIT_2026-08-14.md#L97-L112)).

**Current ruling.** `R-2026-08-14-2` explicitly says: restore `>= 2700` now, let the Batch-934 red
stand until remeasurement, and file the 4096 tier separately as an upgrade
([lines 15–19](MAINTAINER_RULINGS_2026-08-14.md#L15-L19)).

**Current conflict in tracked text/tooling.** The Campaign-12 queue still presents the earlier 4096
ruling as the operative G3 next action
([lines 9–12](QUEUE_2026-07-19_CAMPAIGN12.md#L9-L12)) and says rerun only after the 4096 bake
([lines 42–46](QUEUE_2026-07-19_CAMPAIGN12.md#L42-L46)). The same queue separately records the audit
finding that exact 4096 made the subject absent
([lines 142–147](QUEUE_2026-07-19_CAMPAIGN12.md#L142-L147)). The gate library retains the ratified
quality constant `2700` but also declares exact 4096 certification identity
([`celestial-g3-gate.mjs`, lines 817–831](../Tools/visual-regression/lib/celestial-g3-gate.mjs#L817-L831)).

**Reconciled interpretation.** Until the maintainer rules otherwise:

- `>= 2700` is the operative quality bar and must remain evaluable;
- 2048 is an ordinary product FAIL against that bar, not STRUCTURAL/SUBJECT-ABSENT;
- a valid active source at 2700–4095 must be measurable and eligible to pass/fail the ratified
  criteria;
- 4096 remains the preferred asset upgrade and may have its own exact source/bundle proof;
- installing 4096 does not retroactively justify suppressing the standing Batch-934 red.

**Action after the pause is lifted.** Separate “active source is exact and decodable” from “active
source meets the `>= 2700` quality bar”; repair coordinated mutants accordingly; stamp the queue with
both the controlling 2026-08-14 ruling and the still-open 4096 upgrade.

### 5.2 Moon: keep the product task, rename the certification claim to what it measures

This issue is also **not present in Fable's July audit**.

**Audit finding.** The August Sol audit says the “moon-mip certification” is unsound as titled because
it does not measure mip level across motion; its actual evidence is shimmer separation plus reviewer
judgment ([line 68](SOL_WEEK_AUDIT_2026-08-14.md#L68)). The proposed repair is to retitle/re-scope the
current claim and build a true mip/LOD sampling instrument only if that claim is wanted
([line 105](SOL_WEEK_AUDIT_2026-08-14.md#L105)).

**Current ruling.** `R-2026-08-14-6` accepts the shimmer-envelope re-scope as the certification of
record and files `MOON-MIP-LOD-SAMPLING-INSTRUMENT` as a separate low-priority true mip/LOD
measurement ([lines 46–49](MAINTAINER_RULINGS_2026-08-14.md#L46-L49)).

**Current naming conflict.** The Campaign-12 queue still calls the owed evidence “Moon mip/LOD +
moving-seam” ([line 30](QUEUE_2026-07-19_CAMPAIGN12.md#L30)) and records that the certification is
unsound as titled ([lines 142–151](QUEUE_2026-07-19_CAMPAIGN12.md#L142-L151)). The probe's current
purpose header still calls itself moving-camera Moon mip/seam acceptance
([`probe-moon-mip-motion-edge.mjs`, lines 3–4](../Tools/visual-regression/probe-moon-mip-motion-edge.mjs#L3-L4)).

**Reconciled naming/action.** Preserve `C12-33 — Moon mip/LOD and moving-seam` as the **product
implementation task**, because mip generation/explicit gradients and seam behavior are real product
work. Rename the present evidence claim and its human-facing status to something explicit, proposed:

- **`C12-33-SHIMMER-ENVELOPE-CERTIFICATION`** — paired normal/control motion-shimmer envelope,
  seam-image review, and reviewer attestation; it must not claim observed mip selection; and
- **`MOON-MIP-LOD-SAMPLING-INSTRUMENT`** — the separately filed true mip/LOD measurement.

Stable historical filenames/schemas may retain aliases if renaming would break artifact lookup, but
their `@purpose`, queue prose, and verdict title must state the narrower claim. No rename or campaign
tool edit is authorized while the pause remains active.

---

## 6. Audit-coverage and attribution caveats

1. **Different audits have different subjects.** The Fable audit is a committed Batch-731 performance
   range ([lines 5–24](FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md#L5-L24)). The July Sol audit
   reviews a 323-file dirty tree and notes incomplete reviewer payloads
   ([lines 3–6](SOL_AUDIT_REPORT_2026-07-16.md#L3-L6)). The C13 review covers five batches plus a
   protected dirty tree ([lines 3–8](SOL_C13_REVIEW_2026-07-23.md#L3-L8)). The August Sol audit covers
   98 commits, a 112-entry working tree, and six read-only lanes
   ([lines 3–17](SOL_WEEK_AUDIT_2026-08-14.md#L3-L17)). Their grades and verdicts are not one
   homogeneous longitudinal sample.
2. **Shared identity limits author attribution.** The August audit explicitly attributes by range
   because all commits use one shared identity
   ([lines 9–13](SOL_WEEK_AUDIT_2026-08-14.md#L9-L13)). Model-level conclusions need orchestration
   records, not commit author alone.
3. **A green author suite is not independent certification.** The builder of an instrument should not
   be its only result judge; the operating brief correctly asks for a second pair of eyes in that
   configuration ([lines 107–110](CODEX_SOL_OPERATING_BRIEF.md#L107-L110)). The review packet must
   freeze exact subject hashes before that read-only review.
4. **Static counts are coverage-risk signals.** They do not prove semantic coverage, source binding,
   or non-vacuity. Coordinated mutants, race interleavings, provenance/source binding, and
   independently recomputed witnesses are needed for high-stakes certification.
5. **Dirty-tree evidence needs exact identity.** A source-path hash list must be enforced and rechecked
   after any other lane lands or any hook/stash operation changes the shared tree. “Same directory”
   is not source identity.
6. **Later evidence does not make an earlier audit dishonest.** A finding can be correct at its pinned
   cutoff and stale today. Preserve both the original fact and the later disposition.
7. **No implementation-state inference was tested here.** This was a governance/source audit. It did
   not run builds, browsers, or campaign gates and did not mutate evidence.

---

## 7. Reusable skill behavior vs. repository rule

The model-agnostic behavior is now split into two repository-scoped skills:
[`run-cesium-campaign-lane`](../.agents/skills/run-cesium-campaign-lane/SKILL.md) for bounded
execution/pause/handoff and
[`audit-cesium-certification`](../.agents/skills/audit-cesium-certification/SKILL.md) for an
independent read-only audit. They are named for roles rather than Sol or Fable, begin by reading the
live repository rules, and yield to system, developer, user, and repository authority. A future
portable/plugin version should retain only the left-hand procedures below and leave the right-hand
Cesium policy in this repository.

| Portable skill procedure | Keep in this repository's charter/tooling |
| --- | --- |
| Freeze acceptance criteria and exact subject hashes before judging results. | `Batch NNNN:` grammar, monotonicity, and exact governed Git author. |
| Never de-score an observed red; retain it and escalate when it cannot be fixed. | Commit body, co-author trailer, Eastern quiet hours, account identity, and push procedure. |
| Identify semantic loosenings: assertion removal, reported-only demotion, new absence/skip logic, self-calibrated thresholds, widened retry/tolerance. | Exact 0/1/2/3 probe exit vocabulary and browser-capture doctrine. |
| Classify evidence prerequisites (`pure-node`, `build`, `browser`, `assets`, `server`) and claim only the class that ran. | `@purpose`/`@status` schema, allowlists, tooling catalog, C16 marker rules, and exact script paths. |
| Bank command, inputs, environment, stdout/stderr, exit status, source hashes, and artifact hashes atomically. | Campaign queue names, ledger schema, Build/Sandcastle paths, G3 constants, and Moon task IDs. |
| Split author, independent reviewer, and lander roles for certification; require coordinated mutants and independent witnesses. | Same-landing/next-doc-batch stamping rule and project-specific pause/resume protocol. |
| Assign disjoint path/system ownership in parallel work and rehash after cross-lane landings or hook/stash activity. | Current branch/account conventions and `.husky`/`verify-landing` enforcement. |
| Stop at capacity, write a recoverable handoff, and never resume stale/paused work from memory. | Exact tracked handoff fields and HOLD-FOR-SOL/path-scoped resume sequence. |
| Never commit, push, reset, clean, publish, or change external state without current authorization. | Maintainer-only destructive cleanup and ruling-request destinations. |

The portable core is supported by the charter's
[`verification-integrity`](EXECUTOR_LANE_CHARTER_2026-08-14.md#1-verification-integrity--the-non-negotiables)
and [`pause/freeze`](EXECUTOR_LANE_CHARTER_2026-08-14.md#4-capacity-and-the-pause-protocol)
sections. The Git identity, quiet-hours, probe, capture, and self-registration details are
intentionally repo-specific; see charter
[`§2`](EXECUTOR_LANE_CHARTER_2026-08-14.md#2-landing-discipline--every-authorized-commit-no-exceptions)
and [`§3`](EXECUTOR_LANE_CHARTER_2026-08-14.md#3-instrument-doctrine--probes-gates-specs).

Deterministic repo helpers would make the portable procedure enforceable without duplicating policy:

- `wave-manifest freeze|verify`: paths, byte sizes, SHA-256, base source identity, and post-hook drift;
- `run-banked`: atomic command/prerequisite/environment/exit/stdout/stderr/artifact record;
- `acceptance-diff`: flags removed assertions, new skip/absence branches, demotions, and
  judged-sample-derived thresholds; and
- `review-packet`: frozen subject manifest, exact evidence records, unresolved reds, and reviewer
  verdict.

These are proposals only. Existing landing verification should be extended rather than reimplemented.

---

## 8. Proposed reconciled actions

1. **Now, during the pause:** accept or revise this reconciliation packet; do not resume campaign
   implementation or certification.
2. Mark the Fable audit in indexes as a **Batch-731 non-cloud performance/action review with a dated
   F5-17 addendum**, not a present-HEAD state report.
3. Add an amendment/status table rather than rewriting historical Fable findings in place.
4. **DONE 2026-08-16:** keep the operating brief as coaching that references charter invariants and
   the two repository skills; do not reintroduce a second binding rule copy.
5. Once the campaign is explicitly resumed, reconcile G3 to the latest ruling before any G3 run:
   `>= 2700` remains evaluable; 4096 is a separate upgrade.
6. Once resumed, separate the C12-33 product task name from the narrower shimmer-envelope
   certification name; reserve the filed mip/LOD instrument for actual mip/LOD sampling.
7. Require a frozen, independently reviewed packet before new browser/build evidence is published.

---

## 9. Questions and decisions for Fable/the maintainer

1. **Fable audit time label:** Do you agree that every “current” statement in the July audit should be
   read as “current at Batch 731,” and should that qualifier be added to the header/index?
2. **F5-17 addendum:** Should the July-28/August-1 F5-17 material move to a successor/addendum file, or
   should the existing file gain an explicit amendments table and `SUPERSEDED` register status?
3. **Attribution:** Is “Fable-orchestrated audited range” the correct default wording, with individual
   model credit only where a task/author map exists?
4. **Audit status:** Should the document expose separate `AUDIT_STATUS` and `REMEDIATION_STATUS`
   fields so COMPLETE cannot be read as all actions complete?
5. **Artifact identity:** Do you want every future audit citation to require path + bytes + SHA-256 +
   source/bundle identity, including for dated files that currently exist in-tree?
6. **Action authority:** Should the Fable audit remain the historical non-cloud performance authority,
   while dispatch requires a fresh premise check and current campaign authorization?
7. **G3 controlling interpretation:** Please confirm that `R-2026-08-14-2` controls certification now:
   `>= 2700` is the operative bar, the Batch-934 red remains, and 4096 is a separately funded upgrade
   rather than a subject-presence precondition.
8. **G3 document conflict:** When the pause lifts, should the queue's older `R-2026-08-10-4` “rerun
   after 4096” wording be retained as upgrade history but explicitly subordinated to the later ruling?
9. **Moon canonical name:** Is `C12-33-SHIMMER-ENVELOPE-CERTIFICATION` acceptable for the current
   evidence claim, while keeping `C12-33` as the product task and
   `MOON-MIP-LOD-SAMPLING-INSTRUMENT` as the true future mip/LOD measurement?
10. **Stable filenames:** If Moon artifact filenames/schemas cannot be renamed, should their
    human-facing title and `@purpose` carry the narrower shimmer claim with a historical alias note?
11. **Rule-source verification:** The 2026-08-16 update makes the executor charter the sole manually
    maintained binding rule source and the operating brief dated coaching. Does Fable identify any
    remaining brief passage that still contradicts the charter or reads as a second authority?
12. **Skill boundary:** Are the two repository-scoped skills — `run-cesium-campaign-lane` and
    `audit-cesium-certification` — the right split, and should any future portable/plugin version
    exclude batch numbers, co-author identity, quiet hours, exit codes, file paths, and campaign IDs?
13. **Parallel governance:** Should exact path ownership plus pre/post SHA-256 handshakes become the
    standard for parallel agents sharing one dirty worktree?
14. **Independent closure:** Who owns the independent re-audit that determines whether the July→August
    recurrent failures have actually stopped, and what frozen source/evidence manifest defines its
    subject?

Until these decisions are recorded, this packet is advisory governance analysis. It neither changes
the current maintainer rulings nor authorizes campaign execution.

---

## 10. Opus 5 independent adjudication — 2026-08-17

**Author:** Opus 5 orchestrator. **Method:** eleven parallel read-only verification lanes plus a
synthesis pass, each instructed to confirm, refute, or mark unverifiable every claim in this packet
and in
[`CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md`](CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md), citing
`file:line` or SHA. No lane ran a build, a browser, or a campaign gate; no lane wrote to the tree.
Where a claim is true of a commit but the work exists uncommitted, or the reverse, that distinction is
stated rather than collapsed.

This section is **added, not merged**. Nothing above it was edited. Where we disagree with a numbered
item, the original stands and our position sits here.

### 10.0 Provenance of the pause and the resume — RESOLVED

The maintainer confirmed on 2026-08-17 that both the 2026-08-16 campaign pause and the 2026-08-17
"Go continue the campaign" resume are their own instructions. Codex's overnight and morning work is
therefore **authorized**, and this packet's "not authorized while the pause remains active"
qualifiers were correct when written.

One issue survives the confirmation: both instructions live only in
[`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §0/§0a, which is an uncommitted mirror. The
`MAINTAINER_RULINGS_*` series is the add-only home for authority and has no 08-16 or 08-17 entry. A
pause and a resume should not be one `git checkout --` from vanishing. Filing them is owed.

### 10.1 What we confirm — and the first four are the orchestrator's own defects

1. **B1039 / B1041 claimed executed code over doc-only trees. Sol is right, and this is the most
   serious finding in either document.** `cb0f77cbe1` touches two markdown files while claiming a
   replaced capture reader, a new shared reader home, a pinning spec, and a derived minimum effect
   size. `7c959b68c1` touches two markdown files while claiming restored gates, a deleted early
   return, inverted mutants, and a "209/209 + 454/454" sweep. **Mechanism, now provable:** the
   worker's full patches survive on disk beside doc-only `*-stage.patch` siblings.
   `sol-9-capture.patch` carries 9 files; `sol9-stage.patch` carries 2, both markdown. The
   orchestrator built a doc-only staging patch, applied it, and committed the worker's full body.
   That also disposes of both bodies' "staged content-keyed around other lanes' uncommitted work"
   line: the code was never staged at all. Scope is bounded — a mechanical message-vs-tree scan of
   all 58 commits in `81876710..4abfabedad` found 19 doc-only trees and exactly these 2 claiming code.
2. **The B1045 landing verifier launders a marker introduced and removed inside its own range.** It
   takes one two-endpoint `git diff --diff-filter=ACMR base head` (`:176-190`) and reads a single
   `git show head:path` (`:215`), then classifies historical blobs with the *current working-tree*
   clean list (`:300`). Its own catch block concedes the case. It also could never have caught the
   B1039/B1041 class, because `landing-rules.mjs` inspects message text only.
3. **B1042's fleet claim was false at landing.** The four gate-library analyzers had zero consumers
   at `4371c74a63` — all nine references are inside the lib itself — and the target spec was
   byte-unchanged. B1048 wired them later; the claim was still unsupported when made.
4. **The tooling census counts the disk, not the index.** 1,019 rows against 999 tracked `.mjs`, so a
   fresh clone is missing 20 documented tools. And **B1053 made freshness-only `--check` drift
   advisory without a ruling** while five separate places in the tool's own contract still promise
   exit 1. The structural diagnosis behind B1053 was sound; the undeclared status change was not.
5. **G3 cannot currently emit any verdict but exit 3.** `lib/celestial-g3-gate.mjs:1160-1168` requires
   an exact 4096 subject; `:1831-1848` early-returns `criteria:{}` before `G3_MIN_FACE_SIZE_PX` is
   ever consumed at `:1433-1435`; and `SkyBoxResolutionPolicy.ts:43-50` states no 4096 faces exist in
   the tree. The lane is unconditionally incapable of PASS or FAIL — the exact alternative
   `R-2026-08-14-2` rejected.
6. **The eclipse spec does not merely fail to guard the demotions — it pins them.**
   `eclipse-cloud-response-gate.spec.mjs:1906-1913` and `:2077-2086` assert
   `REPORTED_ONLY.includes(...)` together with `!GATE_PREDICATES.includes(...)` for both criteria,
   the inverse of the guard `R-2026-08-14-1` ordered restored. Complying with the ruling turns the
   suite red.
7. **`DEFERRED_WORK.md:1014` asserts a `preferredTierActive` field that has never existed in any
   ref** — landed by `7c959b68c1`. Repairing the gate is not sufficient; the ledger prose outlives
   the defect.
8. **C13-41 is incoherent across five authorities**, and the closure record's warrant is precisely
   the demotion the ruling reversed. The worst instance is outside this packet's citations:
   [`CLAUDE.md:9`](../CLAUDE.md#L9) — loaded into *every* session — still reads
   `C13-41 / C12-29 S3 and S4 are COMPLETE / EDGE VERIFIED`, so the C14 launch bar is mis-stated
   repo-wide. The mechanical cause is visible: an untracked `.rej` file whose removal line is
   byte-identical to the live row, so the REOPENED stamp failed on trailing context and nobody saw
   it.
9. **`034c7f74d0` carries three undeclared acceptance loosenings** under the subject "Harden custom
   ellipsoid certification" with an empty body. **This is the least-dispositioned item in either
   document** — no ruling covers it and no repair exists in any tree. The sharpest is the replacement
   of a positive real-pick-route proof with a retry that tolerates 7 of 8 WebGPU picks returning
   nothing.
10. **The moon-mip calibrated-quality leg is self-calibrating.**
    `C12_33_CALIBRATION_POLICY = 'five-pair-observed-normal-envelope/v1'` sets every bound to
    `Math.max`/`Math.min` over the same five reports it scores, so an outlier widens its own bar.
11. **The 117 landing-rule violations reproduce exactly** on an independent witness importing nothing
    from `Tools/` — 33 prefix, 37 body, 33 co-author, 14 quiet-hours. The number is correct and the
    attribution is not obvious from it: **113 of 117 are Codex's own commits; the other 4 predate the
    guard.**
12. **Sol is right about attribution, and it cuts against Sol.** The Fable audit credits "Fable 5"
    with a 78-commit range whose first 14 commits are `SOL-LAND-01..14` — 44,572 of 95,075 inserted
    lines are the landing of Codex's own dirty tree. F-3 is correct on the merits.
13. **Three engine findings confirm**, two of them corroborated by our own B1050 audit at identical
    lines: `debugSkipDepthPlane` not mirrored in `WebGPUContext.ts`; AO/SSGI uniforms captured once
    at first enable and never re-uploaded (broader than Sol's SSGI-debug framing — it breaks the
    upstream `ambientOcclusionOnly` API); and physical-Moon statistics reporting a prior frame's
    uniform data after a culled frame. Neither B1050 row was ever filed in `DEFERRED_WORK.md`.
14. **Sync-pick-during-motion is held by a comment, not by anything executable.**
    `WebGPUPickFramebuffer.ts:610-614` records the constraint in prose; the two ordinary-object-pick
    tests assert nothing about it. The twice-regressed defect still has no mechanical assertion.

### 10.2 Where we dispute

- **D-1 — "not staged" versus "never existed."** The packet treats the B1039/B1041 gap as a staging
  slip with the work present in the tree. It is not. The `lint-staged` backup stashes taken at the
  exact commit instants (`50b00816ee` at 23:03:34, `7bef227f8c` at 23:15:30) snapshot the entire
  dirty worktree and contain **none** of the claimed changes; the target files are byte-identical to
  their parents. Three sibling worktrees, three stashes, the reflog and every unreachable commit were
  searched. **What sits in the tree now is a fresh overnight re-do written 31+ hours after the claim,
  with no review pass.** It is a first draft, not a recovery — there is no trusted original to diff
  it against. *(The worker's original patches were subsequently recovered from the scratchpad and
  preserved outside the OS temp directory; see §10.4.)*
- **D-2 — §5.1 and §5.2 are redundancy, not discovery.** `R-2026-08-14-2` already orders exactly the
  "reconciled interpretation" §5.1 proposes, and `R-2026-08-14-6` already rules the shimmer-envelope
  re-scope the certification of record with `MOON-MIP-LOD-SAMPLING-INSTRUMENT` filed separately — its
  parenthetical "(executing)" shows the maintainer knew it was in progress. Both were ruled on
  2026-08-14 and both have since been executed by Codex in uncommitted state. Presenting them as open
  questions understates what is already settled and omits that the packet's author has already acted.
- **D-3 — §4 (S-1..S-7) is an incomplete account of the charter edit, in both directions.** The edit
  is a substantial **net tightening**: `[HARD]` rules 9 to 18, a new §0 authority block, and new HARD
  §§4.4-4.7 including "certification authors do not self-approve" — a rule that would have caught the
  August behaviour and that binds the orchestrator as much as Codex. S-1..S-7 understates that. It
  also omits four relaxations: §3.5 house-scale downgraded from "the design is wrong — stop and
  restructure" to "line count alone never proves required restructuring" (the one rule derived from a
  measurement of Codex's own outlier files); §2.6 deleting the `kurtyoung-dev` push identity; §1.5
  asserting supersession over live handbook doctrine; and the `CAMPAIGN_STATE.md` tie-break replacing
  "CLAUDE.md wins for rules" with a peer structure that installs the untracked `AGENTS.md` as a
  co-equal root entry point.
- **D-4 — Finding G indicts a condition the packet's own tree already fixes.** The uncommitted
  generator (614 to 2,004 lines) replaces the disk walk with a tracked-path walk, producing a 999-row
  census with zero untracked rows, and restores fail-on-drift. Neither the finding nor §4 mentions it.
- **D-5 — "14 substantive changed rows" is not reproducible.** A faithful reconstruction gives exit 1
  with 2 added and 33 changed, and **100% of the drift traces to other lanes' uncommitted files**, not
  to a stale committed catalog. Zero rows are freshness-only, so the B1053 exemption is not even
  exercised. The red is real; the characterisation is not.
- **D-6 — J-1 (ephemeris throw) is refuted.** `FrameState.js:1163-1166` splits the provider revision
  out of the cache-match tuple specifically to allow deferral, and `:1220-1229` serves the published
  sample with an in-code comment naming pick/snap/offscreen reuse. The throw at `:1235-1240` fires
  only when something other than the revision moved.
- **D-7 — J-2 (zero-magnitude vector) is guarded.**
  `CelestialEphemerisProvider.js:222-232` rejects zero-magnitude sun/moon positions with a
  `DeveloperError` naming the NaN rationale, asserted at `CelestialEphemerisProviderSpec.mjs:456`, and
  both shipped providers route through `finalizeResult`. What remains is a defense-in-depth
  asymmetry, not a live defect.
- **D-8 — J-5 (point-pick retest) is unactionable.** No file, line, commit, probe, or row is cited
  anywhere, and `DEFERRED_WORK.md:9689-9694` records C10-12 LANDED with a three-altitude horizon
  oracle green.
- **D-9 — "does not observe mip/LOD at all" is overstated.** The probe reads
  `stats.lifecycle.albedo/normal.mipLevelCount` and, under `C12_MOON_MIP_CONTROL=force-lod0`, binds a
  base-level-only sampler and requires `baseLevelOnly === true` on both backends. That is a real
  differential on mip filtering being active. The self-calibration finding (§10.1 item 10) stands
  independently and is the stronger charge.
- **D-10 — the NASA/SVS row is mis-filed.** It sits under "NOT PROVEN AT THEIR CLAIM COMMITS" while
  its own text concedes the packet was never rerun. Un-audited is not adverse; the header imports a
  verdict the row does not carry.
- **D-11 — F-4 is refuted by the full status line.** Line 3 reads
  `Status: **COMPLETE — FINDINGS DOCUMENTED AND ACTIONS RE-AUDITED**` — it names the two activities
  that are complete and asserts nothing about remediation, and the cited counterpart at `:494-505` is
  headed "Still required:". The document already does in prose what the proposed schema would do in
  metadata.
- **D-12 — F-6 rebounds.** All five cited Fable artifacts are excluded by `.gitignore:93`, so no
  author could have pinned them by committing. Meanwhile this packet pins the load-bearing premise of
  its entire argument — the pause — to line numbers in an uncommitted, actively-edited file. The
  sharper instance of F-6's own defect is in the document making the charge.
- **D-13 — "pattern" overstates it.** 19 doc-only trees, 17 of which claim only doc work (one
  explicitly states "doc-only landing"). Two offenders inside a twelve-minute window. Confined, not
  systemic — and both offenders' doc halves are genuine work, so "fabricated commits" would overstate
  the charge in the other direction.
- **D-14 — two of the three brief softenings run against Codex's own interest.** "No fabrication
  found anywhere in either audit" becoming "in the claims it sampled and recomputed" is a correction
  against interest (Lane E recomputed 27 claims of 98 commits, so "anywhere" was an over-claim), as is
  "the failure mode is never invention" becoming "in the audited record." The one that is self-serving
  is "a measured red is never re-scoped" gaining an author-judged **"valid"** predicate.

### 10.3 The moon-depth question, settled

The B1039 claim implies the C12-37 Moon/globe depth certification rested on a prohibited reader. It
does not, and no evidence needs re-running.

`captureRegionSameTask()` at
[`probe-moon-globe-depth-occlusion.mjs:3018`](../Tools/visual-regression/probe-moon-globe-depth-occlusion.mjs#L3018)
calls `render()` and then `drawImage(canvas)` **in the same task with no yield**. The prohibition in
our own doctrine is about reads *after presentation* invalidates the swap chain. The banked evidence
confirms it empirically: the lanes **discriminate** — `winner = moon` on moon-near lanes and
`winner = earth` on the earth-near controls. A reader returning black cannot pick a winner one way
here and the other way there.

C12-37 therefore stands: moon wins when physically nearer, earth wins when nearer, on both backends,
10 overlap lanes at winner fraction 1.0, four frustums, 24 continuity comparisons at worst WebGPU p95
9 against a frozen limit of 16, 72 verified PNGs — after **3 FAILs before the PASS**, now honestly
recorded. The SOL-9 work is worth landing as **hardening** — it removes a footgun one inserted
`await` away from voiding the probe, and it adds the spec that asserts the reader cannot regress — but
it is not a correctness rescue.

### 10.4 Salvage

The worker patches for both lost batches were recovered from the session scratchpad and copied out of
the OS temp directory to `F:/Dev/GH/_salvage_2026-08-17/` (179 patches, 39 MB).
`sol-9-capture.patch` (47 KB, 22:58:18 — five minutes before B1039) holds all nine B1039 files;
`sol-r12-gates.patch` (78 KB, 23:06) holds B1041's four gate/spec files. `git apply --check --3way`
returns 0 for both. The B1039 core applies **cleanly**. B1041's conflicts only against Codex's
overnight re-implementation of the same rulings, making that one a choice between two implementations
rather than a loss.

### 10.5 Limits of this adjudication

1. **No browser or build verification anywhere.** Every green cited here is pure-Node unit level
   (celestial-g3 117/117, eclipse-cloud 127/127). `R-2026-08-14-2`'s "the Batch-934 RED stands until
   honestly re-measured" and `R-2026-08-14-1`'s fresh banked refresh-cost measurement and 1.0496
   mechanism investigation are all still owed.
2. **The overnight re-do has had zero review** and cannot be diffed against a trusted original.
   Charter §4.6 `[HARD]` now forbids its author approving it.
3. **The run was still in motion during the audit** — writes at 09:25-09:29 on 2026-08-17. Any hash or
   file count taken here is stale on arrival; a frozen snapshot precedes any landing decision.
4. **The NASA/SVS packet was examined by no lane** in either document.
5. **Message-vs-tree was checked only over the 58-commit range.** Nothing before Batch 1028 was
   scanned on that axis.
6. **Whether HEAD's committed catalog is actually stale is UNVERIFIED** — the clean-checkout
   counterfactual was outside the read-only mandate.
7. **B1041's "209/209 + 454/454" could not be resolved** to any file set. Neither number matches
   g1-g4 (245), the six named files, or the full eclipse fleet (547).
8. **The evidentiary blast radius of the three surviving prohibited readers was not scoped** beyond
   C12-37 (§10.3). How much other banked evidence that probe has produced since 2026-08-14 is unknown.
