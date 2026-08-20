# Maintainer rulings — 2026-08-17

Add-only, continuing [`MAINTAINER_RULINGS_2026-08-14.md`](MAINTAINER_RULINGS_2026-08-14.md). Each
ruling records the question, the decision, and the alternatives considered, so a later reader can see
what was weighed rather than only what was chosen.

Recorded by the orchestrator from rulings given in session on 2026-08-17.

---

## R-2026-08-17-0 (D0) — Campaign pause and resume: RECORDED HERE, not in the state mirror

The 2026-08-16 global campaign pause and the 2026-08-17 resume (**"Go continue the campaign"**) are
both the maintainer's own instructions, confirmed in session. They were previously recorded only in
uncommitted [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md) §0/§0a — a mirror, one `git checkout --` from
vanishing, and not the add-only home for authority.

**Ruled:** both are authoritative and are recorded here. `CAMPAIGN_STATE.md` may mirror them but is
not their source. The resume is governed by the recovery-first plan: reconcile contradictory status
records → implement `R-2026-08-14-1` and `-2` in executable gates → repair verifier/catalog/fleet
integrity defects → freeze and independently review held packets → produce fresh evidence only from
eligible exact source → return to feature dispatch.

**Standing consequence:** goals may be paused and resumed for **any** executor — Codex running solo,
Codex as a worker, Claude workers, or the Claude orchestrator. The pause protocol is not
Codex-specific.

---

## R-2026-08-17-1 (D1) — Quiet-hours guard: FIX THE CODE

`Tools/pre-push-guard.mjs:184` omits `includeCommitQuietHours: true`, so
`checkCommitQuietHours` (`landing-rules.mjs:382-394`, which tests **both** author and committer
dates) never runs at push. Line 177 checks only `new Date()` — the push instant — so a commit stamped
11:00 Monday pushes cleanly at 20:00. **24 such commits are already permanent ancestors of main.**
`EXECUTOR_LANE_CHARTER_2026-08-14.md:342` already *claims* the hook does this.

**Ruled:** fix the code, not the charter. One line. Alternatives: correct the charter to match the
code (rejected — the charter states the intended rule and the rule is right).

---

## R-2026-08-17-2 (D2) — Governance files: TRACK THEM

`AGENTS.md` and `.agents/skills/**` are untracked while all four documents `AGENTS.md` routes to are
tracked. A worker clone therefore contains **zero** governance.

**Ruled:** track both. The two known instruction conflicts are corrected in the same landing:
`run-cesium-campaign-lane/SKILL.md:22-23` (forbids inspecting branch state — contradicts CLAUDE.md's
branch-transparency obligations, and is exactly backwards for a branch-resident worker), and
`AGENTS.md:52` ("Repository prose cannot supply that authorization" — nullifies CLAUDE.md §8
probe-first and deadlocks a worker into the ask-the-user anti-pattern).

---

## R-2026-08-17-3 (D3) — FAR-107: AMENDED to admit a proof-carrying serve

`FAR-107` (`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:455-464`) requires that a WebGPU
synchronous call "may return only an already-complete result whose entire query/generation identity
matches", orders "Delete stale prior-frame/location/property/pass substitution", pre-emptively
rejects "more coordinate-only stale-cache exceptions", and states "stale substitution is never a
rollback mode."

Most of the picking design in
[`PICKING_ARCHITECTURE_STATE_2026-08-17.md`](PICKING_ARCHITECTURE_STATE_2026-08-17.md) is what
FAR-107 already ordered — the readiness capability, `preparePick`, the tri-state `lastPickInfo`, and
async-authoritative APIs are literally its text. The tension was narrow: **only stage S5**, the
identity-plateau predicate.

**Ruled:** FAR-107 is **amended** to admit a *proof-carrying* serve. The identity-plateau predicate
is not a stale substitution: it serves only when the cached pick ID is **provably uniform over a disc
that contains the true corresponding pixel**, so the *answer* is identical even though the pose
differs. That is a proof, not a tolerance. A bare pose-delta tolerance remains **forbidden** — it
recovers nothing during a real drag (~29 px at k=2) while reopening the wrong-ID hole.

**This unblocks the picking architecture.** FAR-107 has been BLOCKED-ON-MAINTAINER since the G1–G10
sweep.

Alternatives: keep FAR-107 as written and drop S5 (rejected — leaves the twice-regressed
empty-during-motion defect permanent); defer S5 pending S0 measurement (rejected — design already
done); narrow S5 to the static-camera case (rejected — buys nothing over exact match).

**Binding conditions.** S5 must ship with the negative control that a mutated predicate serves a
wrong ID and the test catches it; the honest residual (a thin primitive smaller than the plateau
radius, uniformly surrounded by one other ID, moving between the cached frame and now) is stated in
JSDoc, not hidden; and the aperture widening is a prerequisite, not an optimisation.

---

## R-2026-08-17-4 (D4) — `034c7f74d0` ellipsoid loosenings: TARGETED REPAIR

Three undeclared acceptance loosenings landed under the subject "Harden custom ellipsoid
certification" with an empty body. No prior ruling covered them; no repair existed in any tree.

**Ruled:**

- **① exact frame accounting** — RESTORE. `revision == before + attemptedFrames` returns, replacing
  the bare inequality. The `legacyV6` path still uses the exact form, which is evidence it was never
  flaky.
- **② the real-pick-route proof** — RESTORE, **in a better shape than a revert**. Keep the warmup
  (WebGPU pick has genuine async readiness), then require `updateForPickObserved === true`,
  `directUpdateForPickCall === false`, `updateForPickCalls >= 1` **and** that all post-warmup picks
  succeed. A straight revert would remove a warmup that exists for a real reason and could leave the
  gate unable to pass at all.
- **③ the antipode `eclipse.active` unpinning** — **RATIFIED**, because the same commit added an
  `offOnByteIdentical` assertion that is stronger than the flag it replaced: byte-identical off/on
  captures demonstrate the eclipse had no effect at the antipode, which is what the flag established
  indirectly. The rationale must be written into the file — the defect was that nobody declared it.

Requires a fresh S5 run to confirm the packet still passes. Alternatives: reverse all three
(rejected — discards ③, which is an upgrade); reverse ② only (rejected — ratifies ① by silence);
ratify all three with a note (rejected — establishes that undeclared loosenings survive if the
engineering later looks reasonable).

---

## R-2026-08-17-5 (D5) — 3D Tiles wave B: SCHEDULE ONTO A CAMPAIGN

The 51 surviving findings from the closing-gate re-audit
([`3D_TILES_PATCH_EXTENSION_REAUDIT_2026-08-16.md`](3D_TILES_PATCH_EXTENSION_REAUDIT_2026-08-16.md)),
plus the three unrun gate dimensions (prior-art, citations, **fork-fit** — entirely unchecked), were
owed and unscheduled.

**Ruled:** place them on an existing or future campaign rather than leaving them floating. The six
CRITICALs remain **UNVERIFIED** — high-quality allegations, not settled defects — so verification
precedes fixing.

---

## R-2026-08-17-6 (D6) — Claim-vs-tree enforcement: ALL THREE LAYERS

**Ruled:** build all three; they catch different things and do not conflict.

1. **Message-vs-tree predicate** — reject a commit body claiming code/spec/gate/probe work over a
   tree touching only `migration_doc/**`. Cheap and mechanical; satisfiable by vaguer prose.
2. **SHA cross-reference** — a doc-only commit narrating code work must name the commit that landed
   that code. This is what makes the claim checkable rather than merely plausible.
3. **Staged-set equality** — after `git merge --squash`, the staged set must equal the branch diff
   set. Strongest, but only exists once worker branches do, and cannot see orchestrator-authored
   commits that never had a branch.

---

## R-2026-08-17-7 (D7) — C13-41 closure record: ANNOTATE **AND** VACATE, THEN SWEEP

The closure run `b5e3f63c-94c6-4204-8706-dd30eabd2eaf` in
`FINDING_DISPOSITIONS_2026-08-13.json` rests on the warrant "the corrected invariant and
implementation later certified PASS" — precisely the demotion `R-2026-08-14-1` reversed.

**Ruled:** do both, for a reason that is about machines rather than integrity. Consumers read the
structured `state` field, not the prose, so leaving `closed` keeps propagating an overturned status.

- **Vacate** the machine-readable state: `closed` → `reopened`, pointing at `R-2026-08-14-1`.
- **Annotate** the run record: it was a genuine PASS of a gate that has since been superseded.
  Nothing is erased; history is not rewritten.
- **Sweep** every other closure in that ledger whose warrant is a gate that has since changed. If the
  ledger could certify a demoted gate once, it can again — the sweep is the recurrence prevention.

---

## R-2026-08-17-8 (D8) — Tooling catalog: SPLIT, AND PRESERVE THE REMAINDER

The overnight rewrite is 614 → 2,004 lines. Roughly 80 lines fix the two named defects
(index-based census, restore fail-on-drift); the remaining ~1,470 are a provenance architecture:
index-blob reads so unrelated dirty work cannot perturb a census, a private graft-free/shallow-free
git metadata dir for the freshness column, atomic index observation with mid-run movement detection,
self-verification of the tool's own bytes against the tracked blob, a byte-identical replacement
guard, and NUL-framed path handling.

**Ruled: split — and the remainder is NOT discarded.** Land the narrow fix first to unblock;
preserve the full rewrite intact (branch or patch) and land it after its own review. It is genuinely
valuable — it is the actual fix for the fact that **100% of the current `--check` drift traces to
other lanes' uncommitted files**, which the narrow fix does not solve.

Both blockers are fixable, not fatal: the spec is red at 28/49 with a **single root cause** (the
untracked launcher), and the launcher must be tracked in the same commit as the `package.json`
change.

---

## R-2026-08-17-9 (D9) — `refreshCostMeasured`: MUST BE FAIL-CAPABLE

As repaired, `refreshCostMeasured` can only emit PASS or STRUCTURAL — never FAIL.

**Ruled:** a failure is a valid result. If work is attempted and does not succeed, or a performance
gain cannot be reached, the gate **fails**. Sometimes a failure is just a failure regardless of
structure. `lib/eclipse-cloud-response-gate.mjs:2902` is the line to change.

This is the same principle as `R-2026-08-17-3`'s companion rule and charter §1: a valid measurement
that misses a registered expectation is `FAIL`; `STRUCTURAL` is reserved for an invalid or
unevaluable evidence shape.

---

## R-2026-08-17-10 (D10) — Landing-verifier violation counts: REPORT BOTH

117 violations over `81876710..4abfabedad` (33 batch-prefix, 37 body, 33 co-author, 14 quiet-hours),
independently reproduced. **113 are Codex Sol's own commits**; the other **4 are the orchestrator's
(B1034, B1035, B1036, B1044) and all predate the B1045 guard.**

**Ruled:** report the raw total **and** a post-guard subtotal. The bare 117 is true but reads as a
broader indictment than the 113/4 split supports; a documented boundary alone would hide that 24
quiet-hours commits are permanent ancestors of main. Both figures preserve the honest total while
making the post-guard number the one that governs.

---

## R-2026-08-17-11 (D11) — Picking freshness policy: ONE CHOICE, THREE OPTIONS; legacy `pick()` maps to `auto`

**Standing directive.** Picking keeps iterating under the dual mandate — preserve legacy
functionality as far as possible while moving the technology forward. **There must be no mysteries
when picking:** whenever a result is served from stale or cold data, the caller must be able to know.

**Ruled.** The picking APIs gain one parameter with three options — `latest` (force a fresh pick,
creating/refreshing the cache), `available` (return whatever exists now, however stale), `auto`
(the engine decides). Request and response vocabularies stay distinct: requests are
`latest | available | auto`; responses are `fresh | cached(ageFrames) | cold | declined(reason)`,
carried on every result including legacy `pick()` via the `Scene.lastPickInfo` sidecar.

**Boundary this draws, sharpening `R-2026-08-17-3`:** *proof required when the engine decides;
disclosure required when the caller decides.* `available` therefore does **not** require the
plateau proof — a caller that asks for stale data and is told it received stale data is not being
substituted to, which is the exact abuse FAR-107 forbids. The plateau licenses `auto` to serve
without being asked.

**Synchronous + `latest` on WebGPU is impossible** and returns FAR-107's documented,
feature-detectable unsupported state rather than degrading silently.

**Legacy `scene.pick()` maps to `auto`** and gains the improvement: existing callers receive a
proof-carrying result during camera motion where they previously received `undefined`, with no code
change. This is the fix for LD-01/LD-02 (clicking during inertia silently deselects; double-clicking
a tracked entity stops tracking). The plateau proof means no caller can observe a *wrong* result,
only fewer `undefined`s. Residual risk recorded rather than hidden: a caller treating
`undefined`-during-motion as a drag signal would see a change; that pattern is almost certainly
accidental but cannot be proven absent.

Alternatives: byte-compatible with opt-in only (rejected — ships the fix then declines to apply it,
leaving every internal consumer to be repointed by hand); `auto` plus a permanent opt-out flag
(rejected — a config axis to support forever); staged flip after a release (rejected — the July pick
tolerance was silently repealed precisely because nothing forced the follow-up).

**CPU-resolvable queries are exempt.** `globe.pick`, `camera.pickEllipsoid` and
`IntersectionTests` never touch a readback, so their `undefined` genuinely means absence; they are
`fresh` by construction and keep the plain contract.

---

## R-2026-08-17-12 (D12) — Tonight's landing: LAND EVERYTHING AVAILABLE

**Ruled:** land everything that is ready tonight, in one window after 19:00 ET. This supersedes the
narrower "G3 only, verifier first" sequencing discussed earlier — the review's ordering advice
stands as *ordering*, not as a restriction on scope.

Scope is "what is ready and reviewed", not "everything conceivable": the reviewed overnight gate
repairs, the landing-verifier rewrite once its two exit-3 demotions are fixed, the catalog narrow
fix split per `R-2026-08-17-8`, the governance files per `R-2026-08-17-2`, the Codex MCP wiring,
and the documents authored today. Work newly *ordered* today (the guard fix, the FAIL-capable
predicate, the ledger vacate, the three claim-vs-tree guards) lands when it is written and reviewed,
not by forcing it into tonight.

**Standing constraint unchanged:** the Codex wiring is three files — `.mcp.json`,
`Tools/codex-mcp-launcher.mjs`, `Tools/codex-preflight.mjs` — and they **must land in the same
commit**, because `.mcp.json` references the launcher. Landing them apart reproduces the
untracked-dependency defect that took `npm run verify-tooling-catalog` offline.

---

## R-2026-08-17-13 (D13) — Commit authority: THE ORCHESTRATOR DECIDES, ALWAYS

**Ruled:** only the orchestrator handles commits, or decisions about commits. If a worker must
commit, **the orchestrator explicitly tells it when and exactly which git commands to run.** Workers
never decide.

This is stricter and simpler than the branch-handoff design proposed, and it resolves the worker
commit-identity question by removing it: the worker has no discretion to have an identity policy
about. It also removes a class of failure from
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §5 — a worker
cannot commit at the wrong time, in the wrong shape, or under the wrong identity, because it does not
choose.

**Consequence for the branch flow:** the worker still owns its clone and its working tree, and still
owes the mechanical handoff report with a verbatim `git status --porcelain` (empty). What changes is
that steps involving `git commit` become orchestrator-directed. The guards that existed to catch
worker commit-shape errors become correspondingly less load-bearing, though they stay as defence in
depth.

**Still open, not covered by this ruling:** how main's checkout advances given its ~140 dirty paths
(§9.2), and whether a probe-running worker lane is authorized at all (§9.6). Both are argued in the
2026-08-17 decision packet.

---

## R-2026-08-17-14 (D14) — `output/` code: PROMOTE TWO, AND THE RULE IS "NO LONG-TERM CODE"

Three executable files were found in the gitignored `Tools/visual-regression/output/`, all
self-labelled `@status INVESTIGATION` and "one-off" — but two of them guard features that shipped.

**Ruled:**

- **Promote** `viewer-smoke.mjs` (41 lines — bare viewer is upstream chrome with WebGPU default,
  `?devUi=true` restores the toolbar, `?renderer=webgl` still selects WebGL) and
  `co41-loading-check.mjs` (111 lines — the loading indicator shows/hides on a real first frame on
  both backends, with a failure control) out of `output/` into `Tools/visual-regression/` with
  `@status ACTIVE`. UX-01 and CO-41 both landed; these are their only regression guards, wearing a
  diagnostic's clothes.
- **Discard** `sunbloom-flip-diag.mjs` — a mechanism question that has been answered.

**The standing rule is NOT "no code in `output/`".** Short throwaway code in `output/` is fine and
expected — it is a scratch space and diagnostics belong there. What must not accumulate is
**long-term** code. The guard therefore flags an executable file in `output/` when it is
*long-lived* rather than merely *present*: referenced by a tracked file, or marked `@status ACTIVE`,
or aged past a generous threshold. A recent `@status INVESTIGATION` diagnostic passes untouched.

---

## R-2026-08-17-15 (P2) — Root-document authority: PRECEDENCE IN CHARTER §0, AGENTS.md BECOMES A PURE ROUTER

**Ruled (packet P2, option R3).** Charter §2.6 keeps its no-switch rule but names
`ORCHESTRATION_HANDBOOK §3` as the identity/auth authority, resolving the HARD-tier
self-contradiction (handbook said `gh auth switch`, charter said do not switch, nothing adjudicated).
A new **[HARD] charter §0.4 states one precedence order** for every conflict class. And
`AGENTS.md:26-55` collapses to a **routing list only** — its four rule blocks each have a tracked
home and three of them contradict rulings made today.

Rationale: a router with no rules cannot contradict a rule. This discharges `R-2026-08-17-2`'s two
named corrections by deletion rather than by patching text that will drift again. Accepted cost: a
Codex agent reading only `AGENTS.md` cold gets pointers and nothing substantive until it reads four
more documents. Every deleted line must be proven to have a tracked home before removal.

Alternatives: R2 (precedence + pointer, keep AGENTS.md's content — rejected, leaves four rule blocks
duplicated across documents, three currently wrong); R1 (accept as written — rejected, leaves the
contradiction live); R4 (restore HEAD — rejected, re-installs a self-service credential-switch
instruction against charter §0.2).

---

## R-2026-08-17-16 (P5) — Sync `drillPick`: ADOPT THE FRESHNESS PREDICATE

**Ruled (packet P5, option A) — against the brief's recommendation, deliberately.** `drillPick`
adopts the same freshness predicate as ordinary picks: one policy everywhere, no Scene-layer special
case, and the `isWebGPU` branch at `Picking.js:919` retires cleanly.

This is consistent with the fork's standing principles: declaring a working feature "unsupported" is
the feature-removal the project's own rules resist, and `R-2026-08-17-11`'s dual mandate is to
extend rather than withdraw.

**REFRAMED 2026-08-18 after maintainer challenge — the original framing was wrong.** The brief (and
the orchestrator's recommendation) treated drill as an exception the predicate could not serve. The
correct statement is that **the predicate is incomplete**: it models *pose* and says nothing about
*content* or *query shape*. Drill is not exceptional — it is the case that exposes the gap first,
because it mutates the query deliberately on every iteration.

**The gap is already a confirmed defect in ORDINARY picking.** LD-16: a primitive that *moves under a
static camera* mints identical provenance and is served stale bytes, because the ordinary path passes
no owner term (`Picking.js:1666`) and `_readbackRegionsEqual` carries no frame-age term. Zero pose
delta, changed content, wrong answer — the identical failure, in the most-used API.

**FAR-107 already specifies the fix.** Its `PickQuery` definition carries "source ..., mode
(`hover | precise | drill`), width/limit/**exclusions**, requested output channels ..., and exact
context/device/scene/view/camera/resource generations." Exclusions and mode are **already part of the
query identity**. Drill picks, excludes what it found, re-picks — so each iteration is a *different
query* and structurally cannot alias against the previous iteration's cache entry. **No special case
is required.**

Standardisation across the pick family is therefore the correct goal AND the correct implementation:
one policy, one query identity. What made drill look exceptional was an under-specified identity that
was already wrong for ordinary picks.

**Partial machinery already exists** for the content axis — `_sceneCaptureContentRevision`
(`GlobeSurfaceTileProviderRendering.js:128,136,147,161`) and a `contentRevision` term in the voxel
readback identity (`Picking.js:511`) — so this extends shipped code rather than inventing it.

**Correction to the brief:** it claimed no content-revision counter exists. That is too strong.
Partial machinery is already shipped — `_sceneCaptureContentRevision`
(`GlobeSurfaceTileProviderRendering.js:128,136,147,161`) and a `contentRevision` term in the voxel
readback identity (`Picking.js:511`). So this is an **extension of existing machinery, not an
invention**, which materially improves the ruling's feasibility. The scope question — how far the
counter must generalise — is carried into the packet's wave 3 alongside P7.

**Independent of the above and required regardless:** the drill loop has **no iteration bound** on
either backend. `drillPickLoop` (`PickingRayHelpers.js:387-397`) defaults `limit` to
`Number.MAX_VALUE` and terminates only when a pick returns empty. CLAUDE.md's permanent-sentinel
rule names infinite-loop guards explicitly. **Land the sentinel on both backends now**, ahead of any
predicate work.

---

## R-2026-08-17-17 (P6) — Moon LOD shader spec: RESTRUCTURE TO PER-ENTRY-POINT ASSERTIONS

**Ruled (packet P6, option B).** `moon-mip-lod-shader.spec.mjs` is RED on committed main (5 tests,
4 pass, 1 fail): it asserts `computeEllipsoidColor` appears exactly twice in `Moon.wgsl`, and a
second `@fragment` entry point (`fsPhysical` at `:618`) made it three.

Extract each `@fragment` body and run the full contract against **each**: exactly one
`computeEllipsoidColor` call, gradients hoisted before that body's discard, `textureSampleGrad`
reached, no `textureSampleLevel`/`textureSample` on `tex` or `normalTex`.

Rationale: the count was a **proxy** for the real invariant (no redundant full-material evaluation
per shaded fragment) and only ever checked the first occurrence — so `fsPhysical` is compliant by
luck of authoring, not by assertion. Bumping 2→3 would restore green while preserving the exact blind
spot that let an uncovered entry point land. Accepted cost: a small brace-matching WGSL body
extractor in the spec, which is new test machinery that can itself be wrong.

Option D (also assert the lockstep contract in `EllipsoidFS.glsl`) is **filed as a follow-on**, not
bundled — the GLSL twin's structure differs enough that asymmetric assertions would be brittle.

---

## R-2026-08-17-18 (P12) — 3D Tiles decision 23: KEEP OUR VOCABULARY, CITE THEIRS, SEPARATE FIELD

**Ruled (packet P12, option D).** `transition.reason` keeps an enumeration drawn from the
publication events we actually have; the existing prior-art passages remain the citation for
`3DTILES_temporal`; and the five borrowed terms (creation / demolition / modification / union /
division) are exposed in **one optional, non-authoritative field** used at their own semantic level
and only when true.

**The conflation was real, and sharper than "different domains".** The five terms describe what
happened to a **feature in the world**; our `reason` describes what the **publisher did to a
generation**. Our own design doc already frames these as orthogonal. Two of our three existing values
— `baseCompaction` and `compacted` — are pure publisher housekeeping with zero world change and
have **no member** in the borrowed set; `union`/`division` have no referent because we have no
feature identity.

Accepted cost: two vocabularies rather than one, against decision 23's "costs nothing to borrow"
framing; a reviewer may fairly ask why a diagnostic hint needs a typed sub-vocabulary.

**Owed:** the binding re-survey must be pointed at `remotes/upstream/temporal-tiles`
(`b35daf3c00`, 2,028 lines) — **no prior survey pass read it.**

---

## R-2026-08-17-19 (P3) — Commit mechanics: DICTATED WHOLE-TREE COMMANDS + ORCHESTRATOR RE-READ

**Ruled (packet P3, option S2).** The worker runs orchestrator-dictated commands in **whole-tree
form** (`git add -A`) — **never a dictated path list**, because a path list is precisely how a
subset gets committed under a body claiming more. The orchestrator then **independently re-reads**
`git status --porcelain` post-commit rather than trusting the worker's report.

This keeps the sandbox boundary intact *and* removes the worker self-report from the trust chain.
The post-commit emptiness check is the exact assertion that would have caught the untracked-launcher
class. Accepted cost: one round trip per commit checkpoint.

**Guard scope:** build `Tools/verify-landing-content.mjs` (staged-set equality) **first**; the other
two are deferred, not cancelled. **The doc must be corrected before it lands** —
`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §5 asserts all three guards as if they exist; all three are
absent from disk. That is the same doc-claims-code-that-is-not-there defect this packet exists to
prevent, authored by the orchestrator.

---

## R-2026-08-17-20 (P4) — Landing clone AMENDED; probe worker lane REFUSED, experiments banked

**Ruled (packet P4, option T2).**

**Landing:** a separate clean landing clone, with the path lease **amended** so the orchestrator
authors all ledger and doc paths. 23 of 40 recent commits touched `migration_doc` — doc paths are
the collision class that actually bites, and the orchestrator already authors them under the
squash rule. The lease becomes a positive scope statement rather than a prohibition. Accepted cost:
the orchestrator is the sole ledger author — a throughput bottleneck, a single transcription point,
and ledger prose no longer written by the agent that did the work.

**Corrections to earlier claims:** main carries **144** uncommitted paths, not 140; the real overlap
rate is roughly half (**19 of 39** recent landings would fast-forward unchanged); and "B1041
overlapped 5 of 5" was wrong — it was **2 of 2**.

**Probes:** a sandboxed probe-running worker lane is **REFUSED**. Probes stay orchestrator-serialized;
workers request them and receive artifacts. Two experiments are **banked, not abandoned**: whether a
low-privilege sandbox user can acquire a WebGPU adapter, and what the Codex sandbox's write roots
actually permit.

---

## R-2026-08-17-21 (P1 + P10) — House-scale trigger RECALIBRATED; ONE fleet-contract extension, and it is the reader rule

**Ruled together, because both options targeted the same spec and the same 548-row allowlist.**

**P1 = A2.** Keep the softened prose ("a review trigger, not a correctness verdict"), but **fix the
trigger**: re-anchor to the audit's own metric — **≥12× fleet median, computed, not frozen** — and
give the architecture review's disposition a home as a dated row in a named tracked file carrying the
file, its line count, the shape-predicate finding and the decision.

The defect was a **mis-transcription**, not a tone problem. The charter's "~2× the prior fleet
maximum" ≈ 7,000 lines fires on **zero** files across 633 probes (median 263, max 6,226) and 16 gate
libs, at any point in the audited range. The audit measured **12–24× median**; at 12× median, ten
probes trigger. So the rule everyone argued about was inert. Accepted cost: 10 probes and 5 gate libs
immediately owe a written disposition, 7 of the 10 authored by the party who wrote the softening.

**A4 (a mechanical size signal in the fleet contract) is FILED AS A FOLLOW-UP, not bundled.**

**P10 = X2.** Keep the analyzer — it is good on merits (single-responsibility pure functions, a
bounded fixpoint that fails closed, real mutation controls). Restate the census claim to what it
actually computes. Extract the receiver-typing layer and port **one** detector — **prohibited canvas
reader** — into `probe-fleet-contract.spec.mjs` over the known probe population.

**Why the reader rule and not the size rule, given only one extension lands:** the prohibited-reader
rule guards a class that has **already produced void evidence** — probes reading a swap-chain-
invalidated canvas and recording black as a measurement. The size rule guards a review-quality proxy
with **no recorded instance of harm**. A correctness guard precedes a maintainability signal.

Accepted cost: the richer half of the analyzer (documentary/metric byte identity, await-adoption
through aliases, escape detection, the 96-iteration fixpoint) stays weather-only, serving 8 probes;
and the extraction is partial, which is messier than a clean port.

---

## R-2026-08-17-22 (P7) — Pick aperture 63×63, dual freshness clock

**Ruled (packet P7, option U2).** The synchronous pick capture aperture widens from 3×3 to **63×63**,
and the frame-age cap becomes a **dual clock: 2 frames for `auto`, ceiling 8 for `available`.**

63×63 doubles the recoverable regime over 33×33 (16.0°/s at k=2, 21.4°/s at k=1 — reaching typical
orbit drag) for 2× the bytes, ~945 KiB/s at 60 Hz, and **zero change in row alignment**. The dual
clock is the direct expression of `R-2026-08-17-11`: the engine deciding gets the tight cap; a
caller who explicitly asked for `available` gets the loose one.

**Binding condition:** land the **capture/query decoupling first and assert it**. The returned rect,
the decode window and `pickObjectsFromPixels`'s spiral bound must stay at the caller's 3×3, or
`scene.pick` silently changes meaning.

Accepted cost: a 441× wider cull cone whose cost is still unmeasured (owed to the serialized probe
lane per `R-2026-08-17-20`); two constants and two counters to instrument; and the 8-frame ceiling
inherits Snap's number without independent derivation.

---

## R-2026-08-17-23 (P8) — Imperative prewarm verb + readiness getter/event; WebGL mints globe pick IDs

**Ruled (packet P8, option V1), AMENDED 2026-08-18 — the verb is an OVERRIDE, not the mechanism.**

**The engine prewarms pick capability automatically under the right conditions.** That is the
default behaviour and no caller has to ask for it. `Scene.preparePickAsync()` exists as an
**optional manual override** for a caller that knows it is about to pick and wants the warm forced
now. Plus a readiness getter and `pickReadyEvent` for the passive question.

This mirrors the freshness policy's shape exactly (`R-2026-08-17-11`): the engine does the right
thing by default; explicit control is opt-in. It also means the S5 gate's retry loop is retired by
*awaiting readiness*, not by requiring every caller to learn a new verb.

**Precedent already in the tree:** `pickHoverAsync` performs prewarm-on-intent today — it marks the
scene hover-pick-enabled so the model renderer builds its dither pipeline variant on the next update
tick (`Picking.js:136-175`). Auto-prewarm generalises that existing pattern rather than inventing
one.

**BINDING CONSTRAINT on "the right conditions".** Auto-prewarm must be triggered by *evidence of
pick intent* — a pick API being called, a hover pick registering — and **never by scene construction
alone**. The C9 acceptance text explicitly forbids creating never-picked resources on scenes that
never pick, and unconditional warming would make every application pay pipeline-compile cost whether
or not it ever picks. That was the stated defect of the declarative-boolean option (V3) and it must
not re-enter through the automatic path.

**Owed as a design detail, not a ruling:** the precise trigger set for auto-prewarm. Candidate
signals are first pick call of any family, `pickHoverAsync` invocation, and a registered
pick-driven input handler. To be specified with the readiness capability, and each trigger asserted.

**And WebGL mints globe pick IDs**, ending `Globe.pickable`'s WebGPU-only divergence — which today
is encoded *as a pass criterion* in the S5 gate
(`expectedPickKind = renderer === "webgpu" ? "globe" : "undefined"`). A backend identity inside an
acceptance test is a standing invitation to treat the divergence as ratified.

**Sequencing condition:** the globe half goes **behind** the C12 critical path, not ahead of it.

Accepted cost: three new public API members plus a fork-only verb name carrying upstream-merge
collision risk. `PickReadiness` must report `preparing` for the **real** reasons — pick pipelines
inflight, globe pick ID unminted, no render frame having selected tiles — or it is decorative.

---

## R-2026-08-17-24 (P9) — C12-33: demote the vacuous leg, anchor to force-lod0, widen sensitivity, give the seam a metric

**Ruled (packet P9, option W1).** The objective is stated first and governs: *a Moon that does not
crawl or sparkle under camera motion at the default ~16 px disc, shows no seam at centre or limb, and
looks the same on both backends.* "Observed mip level" was never the objective — but the calibrated
leg does not measure the objective either.

Four moves, in order: **demote** the self-derived leg so no vacuous axis is ever scored as
acceptance; **anchor** the bounds to the `force-lod0` control, turning 72 of 88 into falsifiable
comparisons against a known-bad; **widen** sensitivity from one lane to 16 cells with a
**pre-registered** ratio; and **add a seam differential** so the seam stops resting on a reviewer
attestation.

**Binding condition:** the pre-registration — both the control-anchored bound form and the
sensitivity ratio *r* — must be **fixed in source before any data arrives**. Otherwise the ~2.5 h
ten-run set is calibration-only, a second set is owed, and any bar chosen afterwards is a fit rather
than a pre-registration.

Accepted cost: this carries the **highest chance of a RED on C12-33's first real acceptance run**,
particularly in the close and seam-centred lanes where ~4.3:1 minification may not yield a large
mip-0 penalty. That is intended behaviour and must not be read as a regression.

---

## R-2026-08-17-25 (P11) — Weather lands as two commits, docs repaired, prohibited set split

**Ruled (packet P11, option Y1)** — the brief's own conditional, since `P10 = X2` was ruled: the
fleet port **needs** the set split, so it is paid for once here rather than twice.

Two commits with a clean revert boundary: a measurement regression reverts commit 1 without losing
the instrument, and commit 2 is pure addition. `DEBUGGING_GUIDE.md` is repaired at source — it still
documents the retired reader — and its cited test count is replaced by **the guarantee the count
stands for**, removing a figure structurally guaranteed to drift. And `screenshot` is **split out of
the prohibited-reader set**, where it is currently conflated with the genuinely-prohibited
`drawImage`+`getImageData`; a compositor read is not a swap-chain read, and a fleet-wide port must
not carry a wrong prohibition.

Accepted cost: commit 1 is briefly unguarded by the analyzer that proves it correct — a real
one-commit gap — and the set split churns both consuming specs and their 183 tests for zero change in
today's green/red.

---

# Amendments — 2026-08-18

The 26 rulings above were audited adversarially on 2026-08-18 (two workflows; see
[`RULING_AUDIT_2026-08-18.md`](RULING_AUDIT_2026-08-18.md)). Load-bearing numbers were independently
re-derived and almost all reproduce exactly. The amendments below correct what did not.

---

## R-2026-08-18-26 (amends R-12) — Codex wiring lands via a TRACKED TEMPLATE MIRROR

**The ruling as recorded was physically unexecutable.** `.mcp.json` is **gitignored** at
`.gitignore:5`, in the same block as `CLAUDE.md`. Under `R-19`'s dictated `git add -A` the two
launcher files stage and `.mcp.json` does not — producing exactly the split landing `R-12` forbids,
for exactly the reason it forbids it. **And `R-19`'s post-commit `git status --porcelain` check
cannot see the omission**, because ignored paths never appear in porcelain: the guard designed to
catch untracked-dependency failures is blind to this one.

**Ruled:** track `.mcp.json.template` plus a documented local-copy step; `.mcp.json` stays ignored.
This uses **the fork's own shipped answer for this exact shape** — [`CAMPAIGN_STATE.md`](CAMPAIGN_STATE.md)
is a tracked mirror that exists precisely because `CLAUDE.md` is gitignored one line below. No
bypass-shaped act; nothing fights the ignore convention.

Accepted cost: one manual step per clone, and the template can drift from the live file unless
something asserts they agree — which `verify-tracked-references.mjs` can do.

Alternatives: untrack `.mcp.json` (rejected — reverses a standing convention, and the file may carry
machine-local paths); one-time force-add (rejected — a bypass-shaped act in the same week the fork
landed a bypass-*evident* verifier, and it must be silently repeated on every future edit); defer the
wiring (rejected — leaves a launcher and preflight that nothing invokes in a fresh clone).

---

## R-2026-08-18-27 (amends R-9) — `refreshCostMeasured`: PRINCIPLE AFFIRMED, PREREQUISITE ORDERED

**The mechanism cannot carry the ruling as written.** At `lib/eclipse-cloud-response-gate.mjs:2900`
every reachable failure is an **evidence-shape defect** — accounting absent, protocol violated, some
40 `invalidReason` strings, all of them "this measurement is untrustworthy" and none of them "the
refresh cost was too high". **There is no refresh-cost budget to fail against.** Making the predicate
FAIL-capable as recorded would convert harness errors into product regressions — the mirror image of
the de-scoring this project spent the week fighting. It also silently reversed `R-2026-08-14-1`
(nine days old), whose own exit criterion (SOL-4's banked measurement) is still open.

**Ruled, in two ordered steps.** The principle stands unchanged: **STRUCTURAL is never a hiding place
for a missed bar.** Then the prerequisite the original ruling skipped — land SOL-4's banked
measurement, pre-register an explicit refresh-cost **budget** with its derivation per charter §3.4,
and make **that** the new FAIL-capable predicate. `refreshCostMeasured` keeps its eligibility role
until then, per `R-2026-08-14-1`, which is not reversed.

Accepted cost: the FAIL-capable gate does not exist until SOL-4 lands, and SOL-4 needs time on the
serialized browser lane.

---

## R-2026-08-18-28 (amends R-13 and R-19) — WORKERS NEVER RUN GIT WRITES; THE ORCHESTRATOR COMMITS

**Three tracked documents said three different things**, and `AGENTS.md` instructs agents to stop and
report a conflict rather than choose — so a compliant worker **deadlocked**:

- `ORCHESTRATION_HANDBOOK.md:61` `[HARD]`: "Workers NEVER run git writes — no commit, stash,
  checkout, restore, reset."
- `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` section 7 rule 2: "Commit freely on your own branch."
- `R-13`/`R-19`: workers run orchestrator-dictated commit commands.

**And no configuration satisfied both `R-13` and `R-19`**: a read-only Codex sandbox blocks the
dictated commit entirely; a writable one leaves `R-13` unenforced; and a worker clone has **zero
active git hooks** — `core.hooksPath` is local config and `.husky/_` carries its own ignore, so the
shim directory reaches no clone.

**Ruled: the handbook's rule governs.** Workers stay read-only in their clone and never run a git
write. The orchestrator fetches the branch and commits from its own tree. `WORKER_ISOLATION` section
7 and `R-13`/`R-19` are amended to match.

This is the pattern the fork already ratified `[HARD]` and has operated under; it is the only variant
mechanically enforceable (via the read-only sandbox, the one real control available); and it removes
the deadlock. Accepted cost: more orchestrator work per handoff, and "the worker owns its clone"
weakens to "the worker owns its working tree."

---

## R-2026-08-18-29 (amends R-21) — House scale: FROZEN RATCHET, **RECORDED AS A KNOWN RISK**

**"Computed, not frozen" is a perverse bar.** A median-relative threshold moves in **both**
directions with no event to notice it: appending ~100 mid-size probes raises the median and silently
un-triggers existing offenders; deleting the 300 smallest takes the trigger count from 10 to 4. That
second path is **not hypothetical** — charter section 3.6 *mandates* a retirement ritual that
archives small answered probes, so executing the fork's own rule would absolve large files of the
disposition `R-21` had just imposed.

**Ruled (interim):** pin `HOUSE_SCALE_MAX_LINES = 3156` with its derivation and date recorded beside
it; put the ten probes and five gate libs currently above it on a **shrink-only allowlist** in the
fleet contract's existing idiom; require any **raise** to be a ruling. The spec recomputes the live
median and fails on >10% drift, so the constant is revisited deliberately rather than moving
silently.

### KNOWN RISK — this is a proxy, and a frozen one

Recorded at the maintainer's instruction, because it should not harden into doctrine unexamined:

1. **A frozen absolute goes stale.** The fleet legitimately grows; 3,156 was derived from one day's
   census. The >10% median-drift check is the only thing that makes staleness *visible*, and it is a
   prompt, not a fix.
2. **Line count is not the finding.** The audit measured *shape-predicate density* — "up to 64% of
   gate libs are shape predicates" — and *duplication* at 0.7–5.1%, explicitly "not copy-paste."
   Line count was reached for because it correlates with those, not because it is them. **We are
   freezing a proxy.**
3. **Both charter versions missed the original intent.** The HEAD text said a file "**trending**
   past" a bar — a *trajectory*, not a *level*. Neither the frozen bar nor the computed one measures
   trajectory.

### Better options, to be ruled separately

- **Growth-rate trigger.** Flag a file that grows more than N lines (or N%) in a single batch. This
  catches the actual behaviour — someone typing hand-rolled validation instead of importing a shared
  helper — **at the moment it happens**, is immune to fleet-median drift entirely, and is the closest
  mechanism to the charter's own "trending past" wording. Cheap: the landing already has both trees.
- **Shape-predicate ratio.** Measure the thing the audit actually found, via an AST pass computing
  what fraction of a gate lib is validation/shape-checking versus logic. The fork already owns the
  AST machinery — `lib/weather-capture-doctrine.mjs` parses probe source with acorn and builds a
  lexical scope model. This is the honest instrument; it is also the most work.
- **Cross-file duplication detection.** Directly measures "validation that belongs in a shared
  schema helper." Standard tooling exists (jscpd and similar).
- **Max-ratchet.** No absolute bar at all: any *new* file above the current fleet maximum owes a
  disposition. Self-adjusting, cannot drift downward, no number to argue about.

The frozen constant stands as the interim so something fires at authoring time, but it should be
treated as a placeholder for a real measure, not as the answer.

---

## Corrections applied without a ruling — factual errors, not choices

**`R-16`**: the sentence "exclusions and mode are already part of the query identity … structurally
cannot alias … no special case is required" is **false against shipped code**. That is FAR-107's
*specification* text, not the tree — a specification cited as an implementation, the exact error
class this project punishes. Replaced with the true statement: drill's exclusion is a **content**
mutation, so drill is served by the content term, not the query term.

**`R-22` (rates)**: the two figures cannot both hold. The banked model is exactly linear in *k*, so
the k=1 rate must be exactly twice the k=2 rate; 16.0 and 21.4 give 1.34. They were generated from
two different epsilon budgets (R/2 and R/3), and **neither reaches the 30 deg/s "typical orbit drag"
the ruling claimed**. The rate table is republished from one budget with the normative disc radius
named.

**`R-22` (binding condition — CRITICAL)**: it named three of **five** coupled rectangles, omitting
the scissor and the cull volume. A letter-compliant implementation would widen only the copy region,
yielding a 63x63 buffer holding 3x3 rendered pixels inside a **60-pixel border of cleared zeros** —
whose uniform plateau of pick-ID 0 would then *"provably"* serve `undefined`. **A proof-carrying
serve of the exact failure the architecture was ratified to eliminate.** The condition now names all
five: scissor and cull volume **widen**; returned rect, decode window and spiral bound **stay** at the
caller's 3x3, each asserted.

**`R-11`**: "no caller can observe a wrong result" is true only on the **pose** axis and is
contradicted inside its own file by `R-16`'s LD-16 (a primitive moving under a static camera is
served stale bytes). Narrowed accordingly, with the content axis stated as a precondition of the
legacy mapping.

**Confirmed sound and better-justified than claimed:** `R-22`'s aperture constant. 63 px x 4 B =
252 B pads to WebGPU's mandatory 256-byte row; 65 needs two rows; an even width cannot be
cursor-centred. **63 is the unique maximum odd aperture costing one padded row.**

---

## Carried forward — still open

- **Charter edit** (ruled 2026-08-17): ratify the §0 authority block and the HARD promotions;
  §3.5 house-scale, §2.6 push identity, §1.5 supersession, and the `CAMPAIGN_STATE` tie-break must be
  **re-proposed individually** as ruling requests.
- **Charter §1.5** (ruled): narrower split — valid instrument + missed derived bar = `FAIL`;
  disagreement with a *reference implementation* stays `STRUCTURAL`.
- **Gate repairs** (ruled): land the G3 half now; hold the eclipse half for its Edge run. Non-author
  review mandatory (charter §4.6).
- Picking §10 decisions 2–6 (aperture width, frame-age cap, prewarm API shape, globe pick parity,
  drillPick scope) — open.
- Branch-handoff §9 decisions 2, 4, 5, 6 (main's checkout, worker identity, salvage disposition,
  probe-worker lane) — open. §9.1 (the three sibling worktrees) is pending the harvest audit.
- 3D Tiles decision 23 (adopt `3DTiles_temporal` transition vocabulary) and the reframed
  title/abstract — open.
