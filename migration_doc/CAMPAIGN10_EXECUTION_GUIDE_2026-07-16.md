# Campaign 10 — Opus Execution Guide (Performance Architecture Closure)

**Written 2026-07-16 at HEAD `457eb162f7` (Batch 675, `C9-07-DEMAND-OPEN-CANVAS`).** Campaign 9 is
running concurrently and the tree is moving daily — expect batch numbers > 675, more §3.2 ledger
rows, and possibly a different HEAD by the time you read this. **Re-verify every file:line anchor by
symbol grep before editing; line numbers are hints, symbols are the contract.**

**Purpose.** This guide hands Campaign 10 ([QUEUE_2026-07-16_CAMPAIGN10.md](QUEUE_2026-07-16_CAMPAIGN10.md))
to Opus workers. Each cluster section (H1–H7) is self-contained: read ONLY the section that owns your
task ID (plus H7 if you are building or resuming the workflow engine), then the queue row, then the
charter — you should be able to execute with NO campaign memory. Each section carries its own
architecture-today, invariants, walkthrough, traps, verification recipe, and rollback boundary.

**How to use it.** The **H7 engine/handoff section comes FIRST** because it governs everything else:
it builds `campaign-10.js`, runs the C9-fallout intake sweep, defines the wave order, and owns the
W5 checkpoint (`C10-30`). If you are here because Fable ran out mid-run, execute H7 Part B before any
task work. Then read your task's H-section.

### Cluster → task map

Engine wave order (guide H7 Part A): **W1** `C10-01` · `C10-09` · `C10-10` · `C10-04` → **W2**
`C10-03` · `C10-05` · `C10-02` → **W3** `C10-06` → `C10-07` → `C10-08` → **W4** `C10-11` → `C10-12`
→ **W5** `C10-30`. Infra `C10-00`/`C10-00B` precede W1. Gated tail `C10-13`/`C10-GT`/`C10-03R`.

| Section | Task IDs |
| --- | --- |
| [H7](#h7) | `C10-00` engine handoff / `campaign-10.js` gen · `C10-00B` C9-fallout intake sweep · `C10-30` default-path checkpoint · campaign shape / wave order |
| [H1](#h1) | `C10-01-ENV-COMMAND-FRUSTUM-BINNING` (anchor) + `C10-13-REVERSED-Z-EARLYZ-SPIKE` + `C10-GT-REVERSED-Z-SLICE-B` dossier |
| [H2](#h2) | `C10-02-TILES-STYLE-COMMAND-ECONOMICS` · `C10-09-VELOCITY-PREV-BUFFER-GPU-COPY` · `C10-10-SHADOW-CAST-SINGLE-SWEEP` |
| [H3](#h3) | `C10-03-MSAA-BOUNDARY-BYTES` (+ `C10-03R` reserve) |
| [H4](#h4) | `C10-04-SPLAT-ASYNC-SORT` · `C10-05-MODEL-TEXTURE-MIP-CHAIN` |
| [H5](#h5) | `C10-06-TTFF-BOOT-CONCURRENCY-AND-PREWARM` → `C10-07-ASYNC-MODEL-PIPELINES` → `C10-08-MODEL-SHADER-SPECIALIZATION-AXES` |
| [H6](#h6) | `C10-11-PICK-FLEET-LOG-DEPTH` → `C10-12-PICK-DEPTH-PLANE-GATE-FLIP` |

> **Numbering reconciliation (composer note, binding).** The H-sections below are the researched
> cluster guides reproduced verbatim; two used local numbering that collided across clusters. In the
> **campaign queue these are authoritative:** H1's `C10-02-REVERSED-Z-EARLYZ-SPIKE` is queued as
> **`C10-13`** (because `C10-02` is `TILES-STYLE-COMMAND-ECONOMICS`, H2/W8-2); H7 Part A's wave-table
> number→title recommendations are superseded by the cluster-guide-declared IDs (the mapping table in
> [queue §5](QUEUE_2026-07-16_CAMPAIGN10.md#5-waves-and-queue-rows) is the pinned set). Where an
> H-section says "C10-02 reversed-Z" or gives a wave number that differs, trust the queue.
> **Reconciled 2026-07-17 (Fable doc review):** the in-place IDs in the H7 wave table and the H1
> gated-tail dossier were rewritten to the queue's canonical set (spike = `C10-13`; W1 riders =
> `C10-09`/`C10-10`; splat = `C10-04`; W2 = `C10-03`/`C10-05`/`C10-02`; W4 = `C10-11` log-depth →
> `C10-12` gate-flip). If any residue survives, the queue remains authoritative.
> **Anchor-drift verification (2026-07-17, 7-cluster read-only pass, run wf_cb113499-4f2):** all
> seven H clusters spot-verified against HEAD (Batch 689). 16 drifts found; the material ones are
> corrected IN PLACE in the H sections (H3 resolve-count oracle bucketing — brief-breaking; H3
> C9-09-landed status; H2 twin bind-group component removed by Batch 687; H4 derivative census +
> mip-slot API; H6 compute-instance already-converted + cohort import reality + fleet ≈14; H7
> queue-doc-exists + C10-11 ownership). Line-number-only shifts were NOT patched: Batches 681-689
> grew `WebGPUContext.ts` ~+350 lines and `WebGPUModelRenderer.ts` ~+300 lines — anchors in those
> files drifted beyond ±80 with structure/symbols intact; grep by symbol per the standing rule.

### QUICK START (Opus worker, cold start)

1. Read `CLAUDE.md` (repo root) in full — the charter is binding: never weaken a feature for a metric; probe-first visual verification (Principle 8); backend agnosticism; RTE precision rules.
2. Read [QUEUE_2026-07-16_CAMPAIGN10.md](QUEUE_2026-07-16_CAMPAIGN10.md) — §1 rules + promotion rule, §2 MSAA ruling, §3 gates, §3.2 live ledger (unlisted = NOT STARTED), §4 fallout intake, §5 waves with your task's acceptance text.
3. Read THIS guide's section for your task before opening any source file; re-verify every line anchor by symbol grep — the tree moves under the concurrent campaign.
4. Resuming the campaign ENGINE (Fable exhaustion) or launching it? Follow **[H7](#h7) Part B** EXACTLY: fork `campaign-9-resume.js` → `campaign-10.js`, keep CHARTER/schemas/prompt-builders/`safeAgent`/loop byte-identical, run the four validation gates, `RESEARCH=[]`.
5. Launching C10 at all requires the **[H7](#h7) Part C** fallout-intake sweep FIRST (the running C9 slice must have completed/halted) + a maintainer launch instruction. Do not auto-run.
6. First commands, always: `git log --oneline -15` + `git status --short` + `git branch -a` — attribute every dirty file to a task before touching anything; never `git add -A`, never bare `git stash`, never revert files you did not author.
7. Ledger discipline: update your §3.2 row (IN PROGRESS / COMPLETE / PARTIAL-PAUSED / BLOCKED / DEFERRED) in the SAME commit as the work — a missing ledger update is a landing defect.
8. Build gates before any probe: `npx tsc --noEmit` then `npx gulp build`; dev server `node server.js` (probes) / `node server.js --production` (perf lanes); edit `packages/engine/Source/**` only, never root `Source/`.
9. Karma specs: `npm run build --workspace @cesium/engine` FIRST (spec-bundle freshness trap, `NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`), `$env:CHROME_BIN` → Edge binary, focused runs via `--includeName`; a trailing "Chrome failed" after SUCCESS is a launcher artifact — trust the exit code.
10. Probes: Playwright Edge only (`channel:"msedge"`), never Firefox (no WebGPU); read the output PNGs yourself (Principle 8); scan generated scripts for unbounded loops before running (machine-crash memory rule).
11. Performance evidence: moving-altitude route only (idle-soak FPS is INVALID); clean and `--api-instrumentation` lanes never mixed; ≥5 counterbalanced reps for blocking timing claims; **comparison anchor = the recorded `C9-30` clean-r5 artifact (or Gate-A `B8015811…` WebGL 5.50 / WebGPU 7.51 ms as a labelled fallback)** — never re-derive a baseline on the new tree; never overwrite historical artifacts.
12. One concern per slice; roll back the optimization, never the feature; tests and counters survive rollback.
13. Unknown consumers/inputs get the conservative fallback — never guess, never silently route around missing functionality; surface it as the next work item (Principle 9).
14. Land as kurtyoung-dev (`gh auth switch` on 403); batch number = highest `Batch NNN` in `git log --oneline -10` + 1; never `--no-verify`; lint-staged OOM → `--concurrent 1`.
15. When blocked or honest-partial: say so in the ledger row with the failing oracle named — a truthful miss with green mechanics is a VALID, COMPLETE result.

---

<a id="h7"></a>

## H7 — Campaign-10 Engine Mechanics + C9-Fallout Intake + Campaign Shape

### C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN + C10-00B-C9-FALLOUT-INTAKE-SWEEP + C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT

This cluster is the **spine of Campaign 10**: how the workflow engine is built and driven, how the
completing Campaign-9 slice's leftovers are swept into C10 as first-class rows, the recommended wave
order, and the W5 measured checkpoint that decides whether the campaign hit its number. It is the
C10 analog of the C9 guide's **G10** section — read that section
(`migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md` L65–601, "G10 — C9-30-PERF-CHECKPOINT
protocol + ENGINE HANDOFF MECHANICS") alongside this one; every mechanic below is an adaptation of a
mechanic proven there, and I call out exactly what changes for C10 versus what carries over
byte-identically.

**All file/line/state anchors were re-verified against the live tree at HEAD `457eb162f7` (Batch 675,
`C9-07-DEMAND-OPEN-CANVAS`, 2026-07-16). Campaign 9 is RUNNING concurrently and the tree is moving —
expect batch numbers > 675, more §3.2 ledger rows, and possibly a different HEAD by the time you read
this. Re-verify every anchor before acting; the whole point of the fallout-intake sweep (Part C) is
to reconcile against the tree as it actually is at C9-slice completion, not as described here.**

This section has four parts:

- **Part A — Campaign shape + recommended wave order** (C10 task map, W1→W5 + gated tail).
- **Part B — Engine handoff mechanics** (generate `campaign-10.js` from `campaign-9-resume.js`;
  model tiering; validation gates; batch numbering; ledger discipline; kurtyoung-dev push;
  the salvage playbook; the mid-run Fable-exhaustion model-flip).
- **Part C — The C9-fallout intake procedure** (the four-source sweep at C9-slice completion).
- **Part D — C10-30 default-path performance checkpoint** (the W5 gate; adaptation of C9-30 Part A).

---

### PART A — Campaign shape + recommended wave order

#### What Campaign 10 is

Campaign 10 is the **default-path performance follow-through** on the 69-finding
`migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` register (the "W8" wave-8 deep-dive) plus the
fallout the Campaign-9 Wave-2 slice leaves behind. The register's proposed rows live in its §13
(paste-ready `C9-30`…`C9-39` + riders), §14 (next-campaign seeds), §15 (reversed-Z verdict), §16
(TTFF budget). Those proposed IDs collided numerically with in-flight C9 rows, so Campaign-10 renumbers
them **`C10-01`…`C10-12`** and groups them into waves. The per-task deep guides in this same directory
(`H1`…`H6`, one cluster per task family) are AUTHORITATIVE for each task's scope, anchors, and
acceptance; this Part A is only the campaign-level **shape and ordering** — do not let a title here
override a cluster guide.

**Cluster→task map (verified against sibling guides on disk):**

- `H1-env-frustum-binning.md` → **C10-01-ENV-COMMAND-FRUSTUM-BINNING** (register S7-1 / proposed
  `C9-30-ENV-COMMAND-FRUSTUM-BINNING`) — THE anchor. Also carries the **C10-GT-REVERSED-Z-SLICE-B**
  gated-tail dossier (register §15).
- `H3-msaa-bandwidth.md` → **C10-03-MSAA-BOUNDARY-BYTES** (register S4-1/S4-2 / proposed
  `C9-35-MSAA-BOUNDARY-BYTES-CONTAINMENT`).
- H2/H4/H5/H6 (authored concurrently; confirm their exact IDs by reading their headers at
  intake time) map to the remaining C10 numbers below. **The number→title rows below are the
  campaign-shape recommendation derived from the register; reconcile them against whatever the
  sibling guides actually declare before pinning the queue.**

#### Recommended wave order (W1 → W5 + gated tail)

Waves are executed **strictly sequentially inside the engine loop** (Part B) — "wave" is a planning
grouping, not concurrency. Order within a wave is the array order in `TASKS`. Rationale for the
ordering: land the risk-free structural ×2 first (anchor), then cheap high-leverage riders that don't
depend on it, then the bandwidth family, then the boot/compile chain (internally dependent), then the
pick fleet (carries C9 fallout), then measure.

| Wave | Tasks (recommended) | Register basis | Why this order |
| --- | --- | --- | --- |
| **W1 — anchor + cheap high-leverage** | **C10-01** ENV-COMMAND-FRUSTUM-BINNING (anchor); **C10-09** VELOCITY-PREV-BUFFER-GPU-COPY + **C10-10** SHADOW-CAST-SINGLE-SWEEP (R1 cheap riders); **C10-04** SPLAT-ASYNC-SORT; small-slice cleanup (BufferMapper repair-or-retire / PP terminal-stage canvas targeting / lazy ID target — §14 item 10, unqueued riders) | S7-1 (`C9-30`), S6-2 (`C9-38`), S1/S2 (`C9-39`), S11-2 (`C9-37`), S6-4/S4-6/S4-7 (§14 item 10) | Anchor is a binning-bug fix, zero shader change, no deps — collapses default 3D to one frustum and unlocks the frustum-scaffold savings the rest measures against. The cheap R1 riders have no dep on the anchor and each carries its own on/off oracle; land them while the anchor's audit is settling. |
| **W2 — bandwidth** | **C10-03** MSAA-BOUNDARY-BYTES; **C10-05** MODEL-TEXTURE-MIP-CHAIN; **C10-02** TILES-STYLE-COMMAND-ECONOMICS (+ uniform-ring extension rider) | S4-1/S4-2 (`C9-35`), S? (`C9-31`), S11-1 (`C9-34`), S6-3 (`C9-12` rider) | These attack the ~1.6 GB/frame MSAA boundary ceiling and the phantom-translucent / mip-shimmer texture-bandwidth waste — the register's §17 item 3 names bandwidth as an independent ceiling the CPU wins can't touch. C10-03 reuses C9-09's attachment-demand registry **if it landed** (decision point — see H3 Step 0). |
| **W3 — boot / compile chain** | **C10-06** TTFF-BOOT-CONCURRENCY-AND-PREWARM → **C10-07** ASYNC-MODEL-PIPELINES → **C10-08** MODEL-SHADER-SPECIALIZATION-AXES / WGSL-MODULE-SPLIT | S8-2/S8-1 (`C9-36`), S8-3 (`C9-33`), S8-5/S3-7 (`C9-32`, §14 item 6) | **Internally ordered by hard dependency** (register §13 note + §16): specialization (`C9-32`) MUST land with or after async pipelines (`C9-33`) — "specialization without async compile scheduling regresses TTFF." `C9-33` is also the enabler `C9-36` item (iii) leans on. Run 06→07→08; `deps` in the script enforce it. |
| **W4 — pick fleet** | **C10-11** PICK-FLEET-LOG-DEPTH (carries C9 fallout `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`) → **C10-12** PICK-DEPTH-PLANE-GATE-FLIP (pick-instance-repack / show-toggle-compaction remain unqueued cluster recommendations — intake candidates, S10-6) | S10-6 (`FAR-107`/`FAR-409` rider), C9 §3.2 `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` | The pick fleet log-depth conversion is the exact surface reversed-Z slice-b (C10-GT) must later convert *back* — register §15 item 5 flags this **sequencing hazard**. Do the cheap repack first; do the log-depth fleet conversion knowingly and record the connection in the C10-GT dossier so slice-b doesn't re-fight it. |
| **W5 — measured checkpoint** | **C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT** (this cluster, Part D) | queue Gate C + §12.6 | R0/gate. Rebuild one hash, run clean + API lanes on the moving-altitude track, compare against the C9-30 result (NOT re-derived Gate-A), write the promote/iterate verdict + per-stage attribution. Decides which gated-tail items get pulled. |
| **Gated tail** (do NOT auto-run) | **C10-GT-REVERSED-Z-SLICE-B** dossier (H1); next-campaign seeds: S1 frame-delta tier, entity-at-scale arc, worker-renderer productization, geometry-residency dedupe | §14 seeds, §15 verdict | Gated on the C10-30 result AND fresh maintainer sign-off. Reversed-Z slice-b is weeks-scale, all-or-nothing, needs the `depth32float-stencil8` fallback story — it is a NEXT-campaign seed, not a C10 task. The dossier is a decision artifact, not an implementation. |

**Wave-order decision points:**

- **C9-09-ATTACHMENT-DEMAND-REGISTRY LANDED in C9** (Batch 681; registry + wiring + truthful
  reporting, hardened in Batch 684 with the measured `slot1AttachmentOpens` fold): C10-03 (MSAA)
  reuses `computeAttachmentDemand` / `context._attachmentDemand` directly — the H3 Step 0 decision
  resolves to "registry available." NOTE: the C9-10 topology FLIP did NOT land — `forceSceneMRT`
  stays `true` and `CesiumDebug.attachmentDemand(false)` REFUSES until the 31-renderer
  topology-keyed cache audit (C9-10's P0 prerequisite) is done; C10-03 must not flip topology as a
  side effect.
- **If C10-01 (anchor) is blocked or reverted**: W2/W3/W4 do NOT depend on it and proceed; but
  C10-30's frustum-count telemetry invariant loses its headline lever — note it in the checkpoint
  verdict rather than blocking the campaign.
- **If a wave's cheap task turns out expensive** (premise stale, or the register cost was
  scale-dependent and the default route doesn't exercise it): honest-partial it, ledger the remainder
  as a next-campaign seed, and keep moving — one concern per slice, never widen scope mid-task.

---

### PART B — Engine handoff mechanics (generate `campaign-10.js`)

#### Architecture today (the engine base — verified against the live script)

**Base script:** `f:\Dev\GH\cesium-webgpu\.claude\workflows\campaign-9-resume.js` (361 lines,
UNTRACKED BY DESIGN — `.claude/` is not committed; the QUEUE doc is the durable record). It ran as
Workflow run `wf_f6cb6b3b-927` (task `wbe4oirq8`). **Campaign 10 is a FRESH launch of a NEW script
`campaign-10.js`, not a resume of that run** — this is the key structural difference from the C9
handoff (which was a mid-run Fable-exhaustion resume of an existing run). You still adapt the C9
script as the engine base because its five hardenings are load-bearing; you just fork it to a new file
and launch fresh.

**The parts you COPY verbatim from `campaign-9-resume.js` (do not re-derive — they are hardened):**

1. **`CHARTER`** (L12–17) — the fork hard-rules + context-docs + clean-tree-contract + build-commands
   string prepended to EVERY prompt. Update only the CONTEXT DOCS line to point at the C10 queue and
   this guide; keep the hard-rules paragraph intact. **Note:** the CHARTER at L13 still says the
   module-cache key "masks defines to 24 bits" — that is STALE post-Batch-658 (the 40-bit full-define
   key landed), but in the C9 resume it was deliberately left because editing CHARTER nukes every
   cache. For a FRESH C10 launch there is no cache to protect, so you MAY fix that sentence to the
   current 40-bit reality — but it is harmless either way (it merely prescribes extra keySalt caution).
2. **Schemas** `IMPL_SCHEMA` / `AUDIT_SCHEMA` / `LAND_SCHEMA` (L158–182) — byte-identical. Do not
   add/remove fields; the harness validates against them.
3. **Prompt builders** `implPrompt` / `auditPrompt` / `fixPrompt` / `revertPrompt` / `landPrompt`
   (L184–220) — byte-identical. They encode: verify-premise-first (impl step 0), adversarial audit
   against the ACTUAL `git diff` with the unconditional-parity-fix `offByteIdentical=false` exception,
   the no-scope-creep fix pass, the revert-to-clean-tree contract, and the land contract
   (`gh auth switch --user kurtyoung-dev` → stage exactly task files → batch-number N → commit →
   `git push origin main`).
4. **`safeAgent`** (L266–269) — the 5th hardening. Every awaited `agent()` is `.catch(→log→null)`.
   Origin: a subagent that finishes WITHOUT calling StructuredOutput makes `agent()` THROW, which
   killed an entire prior run (C7 resume-2). **Never remove this wrapper; never add a bare
   `await agent(...)`.**
5. **The per-task loop** (L272–361) — byte-identical control flow: budget guard (L276) → dep skip
   (L277–281) → IMPL (`safeAgent`) → BLOCKED/FAILED short-circuit (L301–305) → AUDIT with the
   **B18 dead-audit single retry** (L312–318) → GO-WITH-FIXES → one FIX → re-audit (L319–327) → the
   **pass rule** (L340–341: `pass = audit && verdict!=='NO-GO' && noRegression!==false &&
   !(GO-WITH-FIXES with unresolved blockers)`) → REVERT (`model:'opus'`) or LAND. The trust-the-verdict
   comment block (L328–339) is hard-won (FOUR false reverts came from vetoing GO on sub-flags) — keep
   it and the logic it guards.

**The parts you REPLACE for C10:**

1. **`meta`** (L1–8) — new name `campaign-10`, new description (waves W1–W5 + gated tail), keep the
   two-phase shape (`Research` / `Campaign`).
2. **`TASKS`** (L20–155) — splice in the C10 rows (Part A wave order), each a
   `{ id, effort, deps, model?, title, brief, probe, offGate }` object. **The `brief` string is where
   the task's whole spec lives** — for C10 each brief must: (a) name the C10 hard rules verbatim (they
   are the same C9 rules — copy the "HARD RULES (C9 section 1)" block from any C9 task brief), (b) point
   at `migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` (the new queue) as authoritative, (c) point at the
   register `PERF_ARCH_DEEP_DIVE_2026-07-16.md` + the specific finding rows + the raw stratum file, (d)
   point at the owning cluster guide `c10guide/HN-*.md` for the implementation walkthrough, (e) carry
   the PROMOTION RULE (≥5% named-stage p95 or >3× noise, on/off/restored oracles) and LEDGER DISCIPLINE
   mandate, (f) carry VERIFY-PREMISE-FIRST. Reuse the C9 brief prose as the template — it is proven.
3. **`RESEARCH`** (L239) — **stays `const RESEARCH = []`** (empty). The research pump (L246–260) then
   becomes a structural no-op exactly as in C9. Campaign 10 is a performance/architecture campaign with
   no license-verification lanes; the cluster guides already carry the evidence. Leave the pump code in
   place (it is inert with an empty array) so the engine base stays byte-identical — do not delete it.

#### Model tiering — the C10 assignment procedure

The engine reads `t.model` per task (L299): present → that model; absent → session model. Comment at
L296–299: **opus for scoped/mechanical tasks where "the brief contains the answer"; session model
(Fable) for diagnostic/novel-cross-system work where "the agent must FIND the answer."**

For a **fresh C10 launch you assign models UP FRONT** (unlike the C9 mid-run flip). Rule of thumb from
the register's difficulty tags:

- **`model: 'opus'`** for tasks whose cluster guide already contains a step-by-step walkthrough with
  verified anchors and a decided design — i.e. every task with an `HN-*.md` guide in this directory
  (C10-01, C10-03, and the others once their guides land). The answer is written down; opus executes it.
- **Session model (omit `model:`)** for genuinely diagnostic tasks where the register flagged a
  DEEPER-ON-KNOWN cost whose fix requires the agent to find the mechanism in live code (e.g. a
  scale-dependent finding whose default-route reproduction is unproven). The anchor task C10-01 has a
  full H1 walkthrough → `opus`. C10-30 (checkpoint, measurement-only) → session model or opus, either
  works; it is mechanical if the recipe (Part D) is followed.
- **`auditModel: 'fable'`** override (L307–310) on any opus impl task whose correctness turns on subtle
  shader-math (reversed-Z convention, log-depth encode frustum, RTE precision) — keeps frontier-tier
  adversarial review on the exact thing an opus impl is most likely to get subtly wrong. Consider it for
  C10-01 (frustum binning invariant) and any W4 pick-fleet log-depth task.

#### The mid-run Fable-exhaustion model-flip (if C10 itself stalls)

If the **C10 run** dies with Fable "out of usage credits" mid-campaign (the C7/C9 precedent: impl
agents start returning nulls or scheduling stops), you resume the C10 run exactly as C9's G10 Part B
Step 2 describes — but now against `campaign-10.js` and its own run id:

1. Salvage orphan WIP (Part B salvage playbook below).
2. **Flip ONLY unfinished tasks to opus.** For every task in `TASKS` whose id is NOT in the landed set
   (not in `git log` batches) and which lacks a `model` field, add `model: 'opus',`. Do the same for
   any `auditModel` on unfinished tasks.
3. **Completed task entries stay BYTE-IDENTICAL** — the harness replays cached agent calls only when
   prompt AND opts match exactly. Touching a completed task's brief/model/effort/whitespace forces a
   LIVE re-run of already-landed work (it would try to re-implement a landed batch on a tree where it
   already exists). NEVER edit `CHARTER` or the prompt-builders on a resume (CHARTER is in every prompt
   → any edit invalidates EVERY cache including completed tasks).
4. Validate (next subsection) and resume with `resumeFromRunId: '<the C10 run id>'`.

#### Validation gates — run these before launching OR resuming the script

The `feedback_review_scripts_for_loops` memory rule is mandatory (a background probe/script loop once
crashed the machine). Before any launch/resume:

1. **`node --check .claude/workflows/campaign-10.js`** — syntax must pass.
2. **Forbidden-pattern scan** — grep the script for `while (true)`, `Date.now(`, `Math.random(`
   (nondeterminism in scheduling), unbounded recursion, and any new bare `await agent(` NOT going
   through `safeAgent`. The C9 base is clean on all of these; your diff must keep it so.
3. **DAG / dep validation** — assert every `deps: [...]` id exists in `TASKS` and there is no cycle.
   The loop's dep-skip (L277–281) only skips unlanded deps; a **typo in a dep id** silently skips the
   task forever (the dep never lands because it does not exist). Eyeball the dep graph: C10-07 deps
   [C10-06]? C10-08 deps [C10-07]? C10-12 deps [C10-11]? — match the wave-order chain.
4. **Diff-against-base review** — the script is untracked, so `git diff` won't show it. Keep a copy of
   the pristine `campaign-9-resume.js` in the scratchpad and `diff` your `campaign-10.js` against it;
   confirm the ONLY changes are `meta` / `TASKS` / CONTEXT-DOCS-line, never the schemas, prompt
   builders, `safeAgent`, or loop control flow.

#### Batch numbering continuation

The land agent computes **N = (highest `Batch NNN` in `git log --oneline -10`) + 1** (`landPrompt`,
L218). This is **monotonic across campaigns with no reset** — C9 ended somewhere around Batch 680–695;
C10's first landed task simply takes the next integer. You do NOT set a starting batch number anywhere;
the git log is the source of truth. HEAD at guide-writing time is **Batch 675**. Do not hardcode a C10
starting batch; let the land agent read it. (If two campaigns' land agents ever race the same integer,
the second push fails the fast-forward and the agent re-reads — the git log arbitrates.)

#### Ledger discipline — the C10 queue gets its OWN §3.2-style live ledger

C9 used `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 as its live execution ledger (status
vocabulary: IN PROGRESS / COMPLETE / PARTIAL·PAUSED / BLOCKED / DEFERRED / CONDITIONAL NOT TRIGGERED;
unlisted = NOT STARTED). **The queue doc `migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` ALREADY EXISTS (created f6cc291981; §3.2 seeded + §4 intake pre-populated by Batch 689) — VERIFY/EXTEND it, never re-create it (a literal re-create clobbers the seeded intake rows)**
(the §1 rules block, §3 gates A–G, and a §3.2 live ledger table with the identical status vocabulary
and columns `| Task or gate | Status | Updated | Evidence / next action |`). Every C10 task brief must
mandate the same rule the C9 briefs did: **update your row in the C10 §3.2 ledger (add it if missing)
with status + evidence, INCLUDED in your landed files.** A missing ledger update is a landing defect —
it is what makes the run resumable and auditable. Seed the C10 ledger's §3.2 with:

- one row per C10 task (status NOT STARTED until it runs),
- **one intake row per C9-fallout item** (Part C) — these are pre-populated so they are visible and
  owned from launch, not discovered later.

#### kurtyoung-dev push discipline

The `landPrompt` (L216) already encodes it: **`gh auth switch --user kurtyoung-dev` first; a 403 on
push = wrong active gh account → re-switch + retry, never ask the user.** The commit trailer is
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` even for opus-tiered tasks (it is the campaign
signature, not a per-model attribution). NEVER `--no-verify` (fix hook failures instead). The
`feedback_lint_staged_large_commit` memory applies if a batch is large: serialize the pre-commit hook
with `--concurrent 1` locally, revert after — do not bypass the hook.

#### The salvage playbook (orphan WIP recovery)

Identical to C9 G10 Part B Step 1. When a task dies mid-flight leaving a dirty tree:

1. `git log --oneline -15` → highest landed batch + which ids landed.
2. `git status --porcelain` → attribute every dirty file to a task using the §3.2 ledger + the file
   content + DEFERRED_WORK.md.
3. **Salvage before cleaning:** copy the orphan WIP (files + `git diff > salvage.diff`) to the
   scratchpad under `salvage-<taskid>-wip/` (precedent: `salvage-lake-wip/`). Then CLEAN:
   `git checkout -- <files>`, delete stray untracked task files (keep genuinely-new spec/probe files in
   the salvage copy). Verify `git status` clean + `npx tsc --noEmit` passes.
4. Add a one-line salvage pointer to THAT task's `brief` ("prior attempt WIP salvaged to <path> — reuse
   after verifying"). On a resume this brief edit invalidates only that one task's cache (desired: it
   re-runs). On a fresh launch there is no cache; the pointer just informs the agent.
5. **Branch transparency** (CLAUDE.md mandate): `git branch -a`; report anything besides `main`. As of
   2026-07-16 the local tree has ONLY `main` (verified) — no stale safety/feature branches; the many
   `remotes/upstream/*` are upstream tracking refs, not local. If a `sol-backup-*` or
   `safety-pre-batch-*` appears, surface it and ask before deleting.

---

### PART C — The C9-fallout intake procedure

**Run this ONCE, at the moment the running Campaign-9 Wave-2 slice completes (or is halted), BEFORE
launching C10.** It is the load-bearing bridge: it converts everything C9 left unfinished into owned
C10 intake rows so nothing falls through the seam. Sweep FOUR sources; each hit becomes one row in the
C10 §3.2 ledger with an evidence pointer and a wave assignment (or an explicit "next-campaign seed"
disposition).

#### Source (a) — the C9 run journal: BLOCKED / FAILED / PARTIAL tasks

The C9 engine's `results[]` (returned at L361) and its live log record per-task terminal status:
`LANDED` / `BLOCKED` / `FAILED` / `REVERTED` / `SKIPPED-DEP` / `NOT-RUN-BUDGET` / `LAND-INCOMPLETE`.
Obtain it from the Workflow run `wf_f6cb6b3b-927` output (or the memory file
`project_campaign9_running.md`). For each non-`LANDED`:

- **BLOCKED** → read the `blockReason`; the task reverted to a clean tree and (usually) left a
  DEFERRED_WORK.md finding. Intake row = the blocked task id, wave = wherever its dependency resolves.
- **FAILED (agent died)** → re-runnable; intake as-is, likely W-early.
- **REVERTED** → the audit was NO-GO; read the blockers. Decide: re-attempt in C10 (with the audit's
  concerns encoded in the brief) or demote to a seed.
- **SKIPPED-DEP** → its dep never landed; intake both the dep and the skipped task, preserving the
  `deps` chain.
- **LAND-INCOMPLETE** → work committed-but-unpushed or unstaged — **highest priority**, surfaces as
  invisible debt. Check `git log origin/main..main` and `git status`; resolve the push/stage FIRST,
  before any C10 task runs.

#### Source (b) — the C9 §3.2 ledger: PARTIAL/PAUSED, NOT-STARTED, deferred rows in the running slice

Read `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §3.2 (L112+) top to bottom. Every row NOT marked
**COMPLETE** is a fallout candidate. As of 2026-07-16 the standing candidates (re-verify — C9 is
running) are:

- **`NEW-WEBGPU-DEPTH-PLANE-LOG-DEPTH-CONTRACT`** — PARTIAL/PAUSED: scene half landed (Batch 673), pick
  half re-blocked behind fleet-scale conversion. → **C10 W4** (folds into C10-12).
- **`NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`** — NOT STARTED: the fleet prerequisite (~15+ pick WGSL entries to
  log frag_depth); blocks C9-02B and audit P0-1 gate flip. → **C10 W4 = C10-11** (its owner; `C10-12` is the dependent gate-flip). Note the
  register §15 sequencing hazard: this is the exact surface reversed-Z slice-b (C10-GT) later reverts.
- **`NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE`** — PARTIAL (authority+fleet landed, per-family residue). The
  residue rows below are its spawn.
- **`NEW-WEBGPU-BUFFER-PRIMITIVE-PICK-DISPATCH-PARITY`**, **`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION`**,
  **`NEW-WEBGPU-COMPUTE-INSTANCE-PICK-INDEX-MIRROR`**, **`NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT`**,
  **`NEW-COLLECTION-PICK-2DCV-PIPELINE-KEY-PARITY`** — all NOT STARTED pick-fleet correctness gaps. →
  **C10 W4 cluster** (correctness riders on the pick work; C9 rule 1 — these are feature/parity
  correctness, NOT metric-driven; they do not need a promotion metric, only their own oracle).
- **`NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION`** — NOT STARTED: `scene.pickPosition` never
  converges on WebGPU at `:8080` + the **bare-globe black-interior bimodal** repro (center avgRGB 2,2,2,
  `tilesLoaded=true`, zero errors). This is a **standing-gate red that predates the campaign** — it MUST
  be intaken as a correctness row, NOT a perf task, and it may be a blocker for C10-30's feature-loss
  gate (a black globe interior fails the visual gate). Highest-attention intake. Needs a bisect vs the
  probe's last green run and a decision on whether `:8080` is the supported reproduction.
- **`NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT`** — NOT STARTED: `capture-and-diff` scene at 8.69%
  cross-backend + ~92% vs history on BOTH backends. Standing visual-gate red. → correctness intake;
  gates C10-30's feature-loss check.
- **`NEW-WEBGPU-CELESTIAL-RETAINED-RESOURCES`**, **`NEW-WEBGPU-STARFIELD-SINGLE-SUBMISSION`** — NOT
  STARTED: WebGPU-only per-frame celestial command/UB/submission waste. → **C10 W1 cheap-rider
  candidates** (they are the WebGPU-only residue C9-06 explicitly deferred).
- **`NEW-WEBGPU-DEBUG-DEPTH-PLANE-GATE-PARITY`**, **`NEW-WEBGPU-POINT-BLENDOPTION-SYNC`** — NOT STARTED:
  small parity correctness gaps. → cheap correctness intake.
- **`NEW-WORKSPACE-SPEC-BUNDLE-FRESHNESS`** — NOT STARTED: the `gulp test --workspace engine` stale-spec
  trap. → a **tooling** intake row; also encode its workaround (explicit `npm run build --workspace
  @cesium/engine` before focused test) in EVERY C10 task brief that runs Jasmine (it already is in the
  C9 briefs — copy it).
- **`C9-08` octree-persistence** and **`C9-16` enabled-multi-frustum evidence** — deferred/opt-in
  remainders. → seeds unless a C10 task needs them.

For each: create a C10 §3.2 row (status NOT STARTED), an evidence pointer (the C9 ledger row + any
DEFERRED_WORK.md entry + repro probe), and a wave/seed disposition.

#### Source (c) — the uncommitted working tree (WIP)

At C9-slice completion run `git status --porcelain`. Campaign 9 is running as you read this, so the
tree may be DIRTY with an in-flight C9 task (at guide-writing time the tree was clean at Batch 675, but
C9 continues). If dirty at intake time:

- Attribute each file to a C9 task (Source (a)/(b) cross-reference).
- If it belongs to a task C9 will still finish: **leave it** — do not intake WIP that C9 owns.
- If it belongs to a task C9 abandoned (BLOCKED/halted): run the **salvage playbook** (Part B),
  intake the salvaged WIP as a C10 row pointing at the scratchpad salvage copy, and clean the tree so
  C10 launches on a clean tree (`npx tsc --noEmit` green).

#### Source (d) — the C9-30 checkpoint verdict (per-stage attribution)

If C9's own C9-30 checkpoint ran and **missed** its ≥10%/≥15% target, its ledger row carries a
per-stage attribution table (per-segment p95/p99 medians + API-lane counter deltas + which Wave-2
slices did/did not land). **That attribution decides which C10 tasks get pulled forward and their
priority:** the stage that still carries the most unrecovered cost names the highest-leverage C10 lever.
E.g. if C9-30 shows the near-ground segments still dominated by per-tile command allocation (C9-11
didn't fully land), C10 must carry a retained-command follow-through with W1 priority. If C9-30 shows
the boundary bandwidth ceiling untouched (no C9 row addressed it), C10-03 (MSAA) rises in priority. If
C9-30 **passed**, C10 is pure follow-through on the register's remaining un-owned levers (the anchor,
bandwidth, boot, pick) and the gated tail — no emergency pull-forwards.

**Output of Part C:** the seeded C10 §3.2 ledger + a one-paragraph intake summary in the campaign
launch note: "C9 landed X/N; fallout intaken as M rows (list); C9-30 verdict = pass|iterate; C10 wave
order adjusted by <attribution>." Present this to the maintainer before launching C10 (branch
transparency + campaign-scoping mandate).

---

### PART D — C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT (the W5 gate)

This is the direct adaptation of the C9 guide's **G10 Part A** (C9-30). The measurement stack, runner,
workload, route, quality/stability gates, and honest-miss discipline are **identical** — read G10 Part A
(`CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md` L78–387) for the full mechanics. Only the comparison
anchor and the artifact names change. What follows is the C10-specific delta.

#### Architecture today (verified)

- **Runner:** `Tools/visual-regression/run-performance-campaign.mjs` (unchanged). Flags: `--workload`,
  `--repetitions`, `--renderer both` (default, counterbalanced — do NOT split backends into separate
  invocations), `--api-instrumentation`, `--output`. Fresh Edge process per run is the default;
  **never `--reuse-browser`**. Records git commit/branch/dirty + bundle sha256 automatically.
- **Workload:** `moving-camera-altitude-track-3d` (manifest `performance-workloads.json`), 20 s route,
  9 waypoints → 8 segments (18,000 km → 300 m). Near-ground = segments index **5 and 6**
  (`city-sf->near-ground-sf`, `near-ground-sf->ground-sf`).
- **Quality/stability gates** (`lib/performance-campaign-utils.mjs`): a run is invalid without all-8
  aligned segments + ≥30 samples/segment; CPU-p95 max/min > 2.00 across reps → `result:"fail"`.
- **Offline deterministic boot:** `?renderer=<x>&offline=true`; every cross-origin request fails the
  lane (`externalRequests` must be empty).

#### Target design + invariants (C10 deltas from C9-30)

1. **One hash.** Rebuild once (`npx gulp build`); both lanes on that identical bundle; tree clean
   (`source.dirty === false` ideally).
2. **Two lanes, never mixed.** Clean (no flags) = the verdict lane. `--api-instrumentation` = the
   attribution lane only. Never quote an instrumented p95 as the campaign delta.
3. **r5 + counterbalanced** (`--repetitions 5 --renderer both` → 10 runs/lane, order-alternating).
   Queue §12.5 minimum for blocking performance claims.
4. **Fresh process; offline boot; moving route only.** Never idle-soak/FPS (INVALID evidence).
5. **THE COMPARISON ANCHOR IS THE C9-30 RESULT, NOT GATE-A, NOT A RE-DERIVATION.** This is the
   single most important C10 delta. C9-30's clean-r5 artifact (whatever it recorded when C9 measured
   its Wave-2 tranche) is the baseline C10 improves upon. If C9-30 recorded WebGPU whole-route CPU-p95
   median = V ms, C10's promotion arithmetic is `(V − newWebgpuP50)/V`. **If C9-30 never ran (C9 halted
   before its checkpoint), fall back to the recorded Gate-A artifact** (WebGL 5.50 / WebGPU 7.51 ms,
   bundle `B8015811…C11E`) — but say so explicitly in the verdict, because you are then measuring the
   combined C9+C10 tranche, not C10 alone. **Never re-measure a "fresh baseline" on the new tree — that
   measures nothing** (the tree already has the optimizations in it).
6. **Promotion rule** (queue §12.6 / Gate C): the combined C10 tranche passes when, versus the anchor:
   WebGPU whole-route CPU-p95 median improves **≥10%**, AND WebGPU near-ground CPU-p95 (segments 5+6)
   improves **≥15%**, OR the improvement exceeds **3× measured noise**; AND no route-segment p99
   regresses beyond noise on either backend; AND no feature loss (visual/parity probes green — this is
   where the Source-(c) standing reds bite: a black-globe-interior or high-density-drift red FAILS this
   gate); AND no WebGL regression beyond the predeclared budget. **Each individually-promoted C10 slice
   additionally needed ≥5% in its named unsaturated stage or >3× noise at land time** — C10-30 confirms
   the tranche, the per-slice gates already ran.
7. **Noise declared BEFORE looking at deltas** (max−min spread across the 5 quality-valid clean runs).
   If the spread is wider than the claimed improvement, the claim fails regardless of medians.
8. **Predeclare the WebGL budget** in the ledger row before running (recommended: WebGL whole-route
   cpuP95 median stays within max(5%, its own noise) of the anchor's WebGL median).
9. **Never overwrite historical artifacts** (Gate G fails on overwrite). New names:
   `campaign10-c10-30-checkpoint-clean-r5-<YYYY-MM-DD>.json` and `-api-r5-<YYYY-MM-DD>.json` under
   `Tools/visual-regression/output/performance/` (gitignored; the ledger row carries the numbers).
10. **Honest-miss is a REQUIRED deliverable.** On a miss: report actual deltas, per-stage attribution
    (per-segment p95/p99 + API-lane counter deltas), name which C10 slices landed, write the iterate
    verdict, and let it decide which gated-tail item gets pulled (reversed-Z slice-b if the early-Z
    fragment-work ceiling is what remains). Do not re-run hunting a better number; do not hand-prune
    "outliers" (the quality/stability machinery is the only legitimate excluder).

#### Implementation walkthrough (C10 deltas)

Follow G10 Part A Steps 0–7 verbatim, with these substitutions:

- **Step 0** — count which C10 tasks LANDED (git log grep for `C10-01|C10-02|…|C10-12` batch commits +
  the C10 §3.2 ledger). The verdict names the landed set.
- **Step 1** — `npx gulp build`; record `git rev-parse HEAD`.
- **Step 2** — predeclare in the C10 §3.2 row (HEAD hash + WebGL budget + noise rule) with the ANCHOR
  identified (C9-30 result artifact filename + its recorded medians, or Gate-A fallback with the caveat).
- **Step 3** — clean lane (`--workload moving-camera-altitude-track-3d --repetitions 5 --output
  …campaign10-c10-30-checkpoint-clean-r5-<DATE>.json`).
- **Step 4** — API lane (add `--api-instrumentation`, new output name).
- **Step 5** — analyze (read the JSON yourself; the exit code is not the analysis). Use the G10 Part A
  per-segment medians-across-runs recipe. Whole-route delta and near-ground delta both computed against
  the ANCHOR artifact parsed with the identical recipe — not eyeballed, not a single run.
- **Step 6** — feature-loss gate on the SAME build: `capture-and-diff.mjs --scene globe-default` + every
  probe the landed C10 slices named as their regression gate + **the Source-(c) standing reds**
  (bare-globe interior, high-density drift, pick-position convergence). If any standing red is still red,
  the checkpoint records it as a known pre-existing failing gate, but a NEW red = the checkpoint FAILS
  and the offending slice (the optimization, never the feature) is the rollback candidate.
- **Step 7** — record COMPLETE in the C10 §3.2 row (hash, both artifact names, whole-route +
  near-ground deltas with noise, per-segment p99 verdict, WebGL budget verdict, per-slice attribution
  table, promote/iterate verdict). Commit ONLY the ledger/doc edits; NEVER stage
  `Tools/visual-regression/output/`.

#### Traps

All G10 Part A traps apply verbatim (separate-invocation counterbalancing kill; instrumented ≠ timing;
`--gpu-timestamps` contaminates cross-backend CPU; `--reuse-browser` leaks; aggregates hide segments;
consoleErrors ≠ pageErrors; idle workloads prove nothing; don't edit the workload/track/runner to
"help"; dirty tree = wrong hash; serialize the two lanes, don't run concurrently). **The one C10-added
trap: measuring against a re-derived baseline instead of the recorded C9-30 (or Gate-A) artifact.** The
new tree already contains the wins — a "fresh baseline" on it will read fast and show near-zero
improvement, silently voiding the whole checkpoint. Parse the recorded artifact; if it is missing from
disk, STOP and mark BLOCKED.

#### Verification recipe

PASS = both artifacts exist with the new names, same `runtimeBundle.sha256`, `result:"pass"`; 10/10
runs/lane `quality.status==="clean"`, all 8 segments, ≥30 samples/segment, 0 pageErrors, 0
deviceErrors, 0 externalRequests; both aggregates `stable:true`; the promotion arithmetic computed from
medians-across-runs vs the C9-30 anchor with noise reported beside every delta; standing visual gates
green (or their reds pre-attributed); C10 §3.2 row updated + committed + pushed. **A truthful FAIL of
the ≥10%/≥15% target with all mechanics green is a VALID, COMPLETE C10-30** — record "iterate" with the
per-stage attribution and the gated-tail recommendation.

#### Rollback boundary

C10-30 changes no renderer code — nothing to roll back but doc edits. If it FAILS because a C10 slice
regressed a segment p99 / WebGL / a feature: the rollback unit is **that individual slice's optimization
commit** (revert the batch), NEVER the feature it touched and NEVER the whole tranche. Re-run the clean
lane after any revert to re-establish the tranche number. Queue rule 6: "Roll back the optimization,
never the feature. Tests and counters remain."

---

### Rollback boundary (this cluster, C10-00 / C10-00B)

- **C10-00 (script gen):** the script is untracked in `.claude/workflows/` — "rollback" is restoring
  the pristine `campaign-9-resume.js` copy from the scratchpad and re-forking. Nothing in the repo tree
  changes from generating the script. The only repo artifacts are the NEW C10 queue doc and the seeded
  §3.2 ledger — revertible as ordinary doc edits.
- **C10-00B (fallout intake):** produces only ledger rows + a launch note. Reverting means deleting the
  seeded rows. No code, no build, no browser. It is read-only against the repo except the C10 queue doc.
- **Hard stop conditions:** (1) C9 tree DIRTY with a task C9 still owns → do not clean/salvage; wait for
  C9 to finish that task. (2) `LAND-INCOMPLETE` in C9 results with unpushed commits → resolve the push
  FIRST; do not launch C10 over an inconsistent origin. (3) A validation gate (node --check / forbidden
  scan / DAG) fails on `campaign-10.js` → do not launch; fix the script. (4) The C9-30 anchor artifact
  is missing AND Gate-A is also gone → C10-30 is BLOCKED; surface to the maintainer.

### Pointers

- **Engine base:** `f:\Dev\GH\cesium-webgpu\.claude\workflows\campaign-9-resume.js` (untracked, 361 L,
  run `wf_f6cb6b3b-927` / task `wbe4oirq8`). Fork to `campaign-10.js` (fresh run).
- **Format exemplar + engine mechanics detail:**
  `migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md` §G10 (L65–601) — Part A = C9-30 protocol
  (adapt for C10-30 Part D), Part B = engine handoff (adapt for C10-00 Part B).
- **The 69-finding register:** `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` — §13 proposed rows
  (`C9-30`…`C9-39` → the C10-NN task specs), §14 next-campaign seeds (gated tail), §15 reversed-Z
  verdict (C10-GT dossier), §16 TTFF budget (W3), §17 contradicted assumptions (read before trusting a
  cost model).
- **Raw strata (deeper than the register):** `scratchpad/perfdive/S1…S11-*.md`. Anchor task = S7
  (`S7-multifrustum-reversedz.md`); MSAA = S4 (`S4-pass-bandwidth-topology.md`); boot = S8
  (`S8-loadtime-ttff.md`); pick/entity = S10 (`S10-entity-scale.md`); JS smells = S9.
- **C9 queue/ledger (fallout source + gates/vocab):** `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` —
  §1 rules, §3 gates A–G (Gate C = default hot path, Gate G = final cert), §3.2 live ledger (L112+ —
  the Part C Source-(b) sweep target), §6 Wave-2 table (item 35 = C9-30, L222), §12 landing/perf rules
  (L380–384: 5-rep counterbalanced, ≥10%/≥15% or >3× noise).
- **New C10 queue to create:** `migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` (mirror the C9 §1/§3/§3.2
  shape).
- **Runner + workload + route:** `Tools/visual-regression/run-performance-campaign.mjs`;
  `performance-workloads.json` (`moving-camera-altitude-track-3d`);
  `lib/globe-camera-track.mjs` (8 segments, near-ground = idx 5+6);
  `lib/performance-campaign-utils.mjs` (quality/stability gates).
- **Sibling C10 cluster guides (task-scope authority):** `scratchpad/c10guide/H1-env-frustum-binning.md`
  (C10-01 anchor + C10-GT reversed-Z dossier), `H3-msaa-bandwidth.md` (C10-03), and H2/H4/H5/H6 (confirm
  IDs at intake).
- **Memory:** `project_campaign9_running.md` (C9 resume state), `project_campaign7_armed.md` (salvage
  playbook + resume precedents), `feedback_review_scripts_for_loops.md` (forbidden-pattern gate),
  `feedback_push_as_kurtyoung_dev.md`, `feedback_lint_staged_large_commit.md`.

---

### Campaign-10 queue rows (this cluster's tasks — paste-ready)

| # | ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- | --- |
| — | `C10-00-ENGINE-HANDOFF-AND-SCRIPT-GEN` | R0 / infra | S | Fork `.claude/workflows/campaign-9-resume.js` → `campaign-10.js`: keep CHARTER (fix the stale 24-bit-mask sentence → 40-bit, safe on a fresh launch), schemas, all five prompt builders, `safeAgent`, and the per-task loop BYTE-IDENTICAL; replace `meta`, splice the C10 `TASKS` (Part A wave order, each brief carrying the C9 hard-rules block + C10 queue/register/cluster-guide pointers + promotion rule + ledger mandate + verify-premise-first), keep `RESEARCH=[]`. Assign `model:'opus'` to every task with a landed cluster guide; consider `auditModel:'fable'` on shader-math tasks (C10-01, W4 log-depth). Create `migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` (mirror C9 §1/§3/§3.2). **Acceptance:** `node --check` passes; forbidden-pattern scan clean (`while(true)`/`Date.now(`/`Math.random(`/unbounded recursion/bare `await agent(`); DAG validated (every `deps` id exists, no cycle, wave chain intact); diff-vs-pristine shows ONLY meta/TASKS/context-docs changes; batch numbering left to the land agent (monotonic from git log, no reset). |
| — | `C10-00B-C9-FALLOUT-INTAKE-SWEEP` | R0 / gate | S | At C9-slice completion, sweep four sources and produce the seeded C10 §3.2 ledger + a launch note. (a) C9 run journal `results[]`: intake every BLOCKED/FAILED/REVERTED/SKIPPED-DEP/**LAND-INCOMPLETE** (resolve unpushed commits FIRST). (b) C9 §3.2 ledger: intake every non-COMPLETE row (pick-fleet log-depth + HDR-pick residue → W4; celestial retained/single-submit → W1 riders; pickPosition-convergence / high-density-drift / bare-globe-black → correctness rows that gate C10-30's feature-loss check; workspace-spec-freshness → tooling + brief workaround). (c) uncommitted tree: leave WIP C9 still owns; salvage-playbook WIP C9 abandoned, clean the tree (`tsc` green). (d) C9-30 verdict: if it missed, its per-stage attribution reorders C10 waves; if it passed, C10 is pure follow-through. **Acceptance:** every fallout item has a C10 §3.2 row (status + evidence pointer + wave/seed disposition); tree clean at C10 launch; launch note ("C9 landed X/N; M fallout rows; C9-30=pass\|iterate; wave order adjusted by <attribution>") presented to the maintainer with branch inventory. |
| — | `C10-30-DEFAULT-PATH-PERFORMANCE-CHECKPOINT` | R0 / gate (W5) | M | Measurement-only. Rebuild one hash (`npx gulp build`, clean tree). Predeclare the anchor (**the recorded C9-30 clean-r5 artifact**, or Gate-A `B8015811…` = WebGL 5.50 / WebGPU 7.51 ms as a labelled fallback if C9-30 never ran) + WebGL budget + noise rule in the C10 §3.2 row. Run clean lane then API lane, `--workload moving-camera-altitude-track-3d --repetitions 5 --renderer both`, fresh process, offline boot, new artifact names (`campaign10-c10-30-checkpoint-{clean,api}-r5-<DATE>.json`, never overwrite). Parse both artifacts + the anchor with the medians-across-runs recipe. **Acceptance / PASS:** both artifacts same `runtimeBundle.sha256`, `result:"pass"`, 10/10 runs `quality:"clean"`, all 8 segments ≥30 samples, 0 page/device errors, 0 externalRequests, both aggregates `stable:true`; combined tranche ≥10% whole-route + ≥15% near-ground (seg 5+6) WebGPU CPU-p95 improvement vs anchor OR >3× measured noise, no route-segment p99 regression beyond noise either backend, no WebGL regression past predeclared budget, feature-loss gate green (standing reds pre-attributed, NO new red). A truthful ≥10%/≥15% MISS with all mechanics green = VALID COMPLETE = record "iterate" verdict + per-stage attribution + gated-tail recommendation (reversed-Z slice-b iff early-Z fragment ceiling remains). Ledger the verdict + numbers + artifact names; commit doc-only; never stage `Tools/visual-regression/output/`. |


---

<a id="h1"></a>

## H1 — Environment-Command Frustum Binning (THE Campaign-10 anchor) + Reversed-Z Slice-B Gated-Tail Dossier

### C10-01-ENV-COMMAND-FRUSTUM-BINNING (from W8-1 / C9-40) + C10-GT-REVERSED-Z-SLICE-B dossier

**Anchors re-verified 2026-07-16 against the live working tree (post-Batch-674, tree DIRTY under
the concurrent Campaign-9 run). Line numbers below are freshly grepped hints, not gospel — several
had already drifted ~20 lines from the register (e.g. `commandList.length = 0` is now
Scene.js:3366, register said :3346; `clearGlobeDepth` is now :3760, register said :3740). Re-grep
every anchor by symbol before editing.** Primary evidence: register rows S7-1/S7-2/S7-5/S7-3/S7-7
+ §15 verdict in `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md`; deeper detail in the raw
stratum `scratchpad/perfdive/S7-multifrustum-reversedz.md`.

---

#### Architecture today (verified)

**The count formula.** `View.createPotentiallyVisibleSet` (`packages/engine/Source/Scene/View.js`)
accumulates a scene-wide `[near, far]` from every command in `frameState.commandList`, then
`updateFrustums` (View.js:419) computes
`numFrustums = ceil(log(far/near) / log(farToNearRatio))` (View.js:449) with
`farToNearRatio = scene.logarithmicDepthFarToNearRatio = 1e9` under log depth (Scene.js:616;
selection at View.js:422-424). Log depth IS on for WebGPU: `Scene.defaultLogDepthBuffer = true`
(Scene.js:141), `this._logDepthBuffer = Scene.defaultLogDepthBuffer && context.fragmentDepth`
(Scene.js:310), and the Batch-251 master switch is TRUE (`WebGPULogDepth.ts:22-30`).

**The camera override that makes the widening lethal.** Under log depth the Scene constructor
overrides the camera frustum (Scene.js:1419-1422):

```js
if (this._logDepthBuffer) {
  camera.frustum.near = 0.1;
  camera.frustum.far = 10000000000.0;   // 1e10
}
```

So the worst-case window is `[0.1, 1e10]`, ratio `1e11` → `ceil(ln(1e11)/ln(1e9)) = 2`. Max
reachable count in 3D log depth is 2 (3 needs ratio > 1e18) — "2 vs 3" resolves to "2 vs 1".

**The accumulation site.** Inside the command walk (View.js:240-308):
- `near`/`far` init to `+MAX_VALUE`/`-MAX_VALUE` (View.js:222-223).
- BV branch (View.js:253-285): cull test, `computePlaneDistances`, `near=min / far=max`, plus the
  CSM shadow near/far fitting (BV branch ONLY — BV-less commands never touch shadow fitting).
- `ClearCommand` branch (View.js:287-291): extent = `[frustum.near, frustum.far]`, **no**
  accumulation (upstream already knew clears must not widen).
- **The no-BV else branch (View.js:292-298): extent = `[frustum.near, frustum.far]` AND
  `near = Math.min(near, frustum.near); far = Math.max(far, frustum.far)` — the widening.**
- `updateFrustums(this, scene, near, far)` at View.js:320, then `insertIntoBin` per extent at
  View.js:323 (function at :481 — a no-BV extent `[0.1, 1e10]` overlaps EVERY band and is
  inserted into all of them unless `executeInClosestFrustum`, default false,
  `WebGPUDrawCommand.ts:455`).

**Who pushes BV-less commands — FIVE sites, not the register's three.** The fork's WebGPU
environment feature renderers push into `frameState.commandList` (the Batch-247 "dual-path
convention": push so a frustum exists on sky-only views AND return for `environmentState`). All
constructed with `pass: 0 // Pass.ENVIRONMENT` (`Pass.js:17`) and **no `boundingVolume`**
(`WebGPUDrawCommand.boundingVolume` is a plain optional copied at `WebGPUDrawCommand.ts:446`;
nothing synthesizes one):

| Producer | Construct | Push | Default-on? |
| --- | --- | --- | --- |
| SkyAtmosphere shell | `WebGPUSkyAtmosphereRenderer.js:1339-1350` | :1354 | yes (Viewer default) |
| SkyAtmosphere fullscreen variant | :1322-1330 | :1333 | opt-in (`_webgpuFullscreen`) |
| Sun | `WebGPUEnvironmentRenderer.js:612-620` | :621 | yes |
| **Moon** | `WebGPUEnvironmentRenderer.js:1103-1113` | **:1119** | **yes** (`CesiumWidget.js:591` `scene.moon = new Moon()`; FR dispatch `Moon.js:216/254`) |
| StarField | `WebGPUStarFieldRenderer.ts:617-625` | :626 | yes (`SkyBox.js:48-56`, `showStarCatalog ?? true`; the separate `injectCommand` at :628+ is returned, never pushed) |

> **Register correction:** S7-1 names three producers (SkyAtmosphere/Sun/StarField). The Moon is a
> fourth default-on BV-less push and the fullscreen-sky variant a fifth opt-in one. This is exactly
> why the fix must key on `pass === Pass.ENVIRONMENT`, not on a per-renderer BV-attachment list.

**Why the pushes reach binning.** `frameState.commandList.length = 0` happens only in
`updateFrameState` (Scene.js:3366). The render flow then runs `scene.updateEnvironment()`
(Scene.js:5806, method at :3642) → `updateAndExecuteCommands` (Scene.js:5963 → :3624) →
`executeCommandsInViewport` → `ViewportExecutor.js` → `view.createPotentiallyVisibleSet(scene)`
(ViewportExecutor.js:109 main path; :441 second call site — check both). No reset in between. The
Batch-247 dedupe in `SceneRenderer.js:339-442` (`maybeInject` scans the farthest frustum's binned
ENVIRONMENT slot, `frustumCommandsList[length-1]` at :339) exists precisely because the binned
copies are observed.

**Result at defaults:** near=0.1, far=1e10 → **2 frusta on every default 3D WebGPU frame, at
18,000 km and at 300 m alike**. Content alone can never exceed ratio ~4.6e8 (horizon cap ~4.6e7 m)
→ content-driven count is 1 at all nine route waypoints. WebGL runs 1: its env commands never
enter `commandList` (executed via `environmentState`), so it never widens.

**Where env commands execute.** The frustum loop
(`WebGPUSceneRendererFrustumLoop.ts:172-175`) iterates FAR→NEAR (`index = numFrustums-1-i`);
ENVIRONMENT executes only at `i === 0`, i.e. the FARTHEST frustum
(WebGPUSceneRendererFrustumLoop.ts:255-266). Under the 2-frusta floor the far band `[1e8, 1e10]`
holds ONLY sky commands yet pays the full scaffold.

**What one frustum deletes (the quantified prize — S7-2/S7-5):** per default frame, the second
frustum buys: ~6 full-target render-pass boundaries (depth/stencil clear :252, globe-depth
copyDepth pack + resume :286-291, `clearGlobeDepth` clear + depth plane :324-329, DP-H45
post-opaque re-pack :447-468 whose `config.clearGlobeDepth` disjunct is constitutively true at
defaults per Scene.js:3760) + 2 unconditional fullscreen RGBA8 depth packs (~2.1 M pack fragments
@1080p; `WebGPUGlobeDepth.ts` pack ~:377-416) + duplicate frustum-uniform refresh with TAA jitter
apply/restore + one dedicated 65,536-object aux GPU culler for frustum idx ≥ 1 (≈2.8 MB VRAM +
dispatch + readback, `WebGPUContextCullerPool.ts:152-183`, `maxObjects: 65536` at :182) + one
byte-identical duplicate camera-UB `writeBuffer` + bind group PER visible collection per frame
(`WebGPUCollectionCameraUB.js` per-slice pool; in 3D `repackPerSlice=false` so slice-1 content ==
slice-0) + a doubled frustum-loop CPU walk. Attachment traffic: each boundary reloads/stores
rgba16float color (`WebGPUSceneFramebuffer.ts:17`) + MRT slot-1 + depth24plus-stencil8 ≈ 25-40 MB
→ **~150-240 MB/frame bought by the empty far band alone**.

**In-tree precedent proving the mechanism AND the fix class:** Batch 268,
`GlobeSurfaceTileProviderRendering.js:941-963` — a single BV-less command exploded the SCENE2D
split 1→~9 bands and broke marker rendering; fixed by restoring a correct BV + `cull=false`. The
3D environment commands are the same defect, still live, invisible because 2 frusta render
*correctly* — this is a pure-waste bug, not a visual bug.

**Pick is NOT affected today (do not "fix" it):** `Scene.updateEnvironment` (:3642) takes the
early branch when `!frameState.passes.render` (:3656-3667) and sets every env command to
`undefined` — env FR updates never run, nothing is pushed, pick mini-frames bin content-fit and
run 1 frustum. (`Picking.js` calls `updateEnvironment` at :478/:553/:691/:1542/:1606 — those calls
hit the early branch for pick passes. `pickFromRay`-style offscreen frames set `passes.render`
true, so they DO currently pay 2 frusta and will collapse to 1 with this fix — a bonus, verify
with the pick probes.)

---

#### Target design + invariants

1. **Frustum-count parity:** default 3D WebGPU globe frame renders with
   `scene.numberOfFrustums === 1` (getter verified at Scene.js:2661) at EVERY waypoint of the
   canonical moving-altitude route — equal to WebGL on the same scene.
2. **Zero feature change:** all five env producers still push to `commandList`, still bin via
   `insertIntoBin`, still execute exactly once in the farthest frustum at `i === 0`, and the
   Batch-247 `SceneRenderer.js` injection/dedupe is byte-untouched. Sun disk, moon, star catalog,
   atmosphere shell, and fullscreen-sky variant all render pixel-equivalent before/after (probe
   diff, not eyeball).
3. **The exclusion is pass-keyed, not producer-keyed:** any command with
   `pass === Pass.ENVIRONMENT` and no `boundingVolume` gets extent
   `[frustum.near, frustum.far]` (bins everywhere, exactly as today) but does NOT feed the
   `near/far` accumulators. Covers all five current sites and any future ENVIRONMENT producer.
4. **Unknown demand stays conservative:** BV-less commands with any OTHER pass keep the
   worst-case widening (View.js:292-298 else branch unchanged for them). Do not widen this slice
   to "fix" other BV-less producers you find — file follow-up rows instead.
5. **Sky-only views keep a frustum (the Batch-247 rationale):** if NO command contributed to the
   accumulators (`near` still +MAX_VALUE) and ≥1 BV-less ENVIRONMENT command was seen, fall back
   to `near = frustum.near, far = frustum.far` before `updateFrustums`. Sky-only frames then
   produce the same 2 frusta they produce today — behavior-preserving; do NOT "optimize" sky-only
   to 1 in this slice.
6. **WebGL byte-identical:** WebGL never puts ENVIRONMENT-pass commands in `commandList` (verify
   by grep, invariant-check below), so the new branch is dead code on WebGL. Existing
   `MultifrustumSpec.js` / `FrustumCommandsSpec.js` (packages/engine/Specs/Scene/) must pass
   unmodified.
7. **2D/CV/pick counts never increase:** SCENE2D band math (View.js:437-446) and CV are only ever
   improved by removing widening (if env commands bin in 2D at all — audit rider below); pick
   mini-frames were already env-free.
8. **Zero shader changes, zero pipeline-key changes** — this is a JS binning fix only. Any WGSL
   or `depthCompare` edit means you are on the wrong task (that's slice-b, gated).
9. **The invariant is guarded thereafter:** `numFrustums` becomes observable (debug snapshot +
   probe) and the new probe asserts `=== 1` on the default 3D scene so a future BV-less push
   regression fails loudly.

---

#### Implementation walkthrough

**Step 0 — re-verify the premise (5 min, mandatory).**
```
grep -n "10000000000" packages/engine/Source/Scene/Scene.js          # camera override alive
grep -n "worst-case near and far" packages/engine/Source/Scene/View.js  # no-BV widening branch
grep -rn "pass: 0" packages/engine/Source/Renderer/WebGPU/WebGPU{SkyAtmosphere,Environment,StarField}Renderer.*  # 5 push sites
git log --oneline -20 | grep -i "frustum"                            # has C9-40/C10-01 already landed?
```
**Decision point:** if the widening branch is already pass-gated, or the baseline probe (Step 1)
reports WebGPU `numberOfFrustums === 1`, STOP — the fix landed in a concurrent slice; verify the
ledger and mark this task superseded rather than re-landing.

**Step 1 — reproduction probe FIRST (Principle 8).** Create
`Tools/visual-regression/probe-frustum-count-3d.mjs` modeled directly on
`probe-2d-frustum-bins.mjs` (same Playwright/Edge harness, `channel: "msedge"`,
`http://localhost:8080/Apps/CesiumViewer/index.html?renderer={webgl|webgpu}`, `window.viewer`).
Per renderer, at waypoints 18,000 km / 500 km / 300 m (route altitude bands), after ≥120 rendered
frames with `tilesLoaded` gating (the Batch-634 harness lesson — a lone star can defeat a naive
non-black gate), record:
- `viewer.scene.numberOfFrustums`
- per-frustum `frustumCommandsList[i].indices[Pass.ENVIRONMENT]` and `[Pass.GLOBE]`
- canvas non-black + a sun-region and sky-region pixel sample (reuse `CesiumDebug.canvasPixels()`
  or the probe-2d-frustum-bins readback pattern)
Also a sky-only leg: `viewer.scene.globe.show = false`, camera facing space →
record `numberOfFrustums` (expect ≥1) + starfield pixels present.
**Baseline expectation: WebGPU = 2, WebGL = 1 at all three waypoints.** Screenshot both backends
per waypoint — these are your before-PNGs. Scan the probe for unbounded loops before running
(memory rule: bounded frame loops only).

**Step 2 — the fix, in `packages/engine/Source/Scene/View.js` only** (canonical location; never
root `Source/`). In `createPotentiallyVisibleSet`:

a. In the final else branch (View.js:292-298), split on pass:
```js
} else {
  // If command has no bounding volume we need to use the camera's
  // worst-case near and far planes to avoid clipping something important.
  commandNear = frustum.near;
  commandFar = frustum.far;
  if (pass !== Pass.ENVIRONMENT) {
    near = Math.min(near, commandNear);
    far = Math.max(far, commandFar);
  } else {
    sawEnvironmentNoBV = true;   // new local, init false above the loop
  }
}
```
(Keep the existing comment; add a short WHY comment citing the 2-frusta floor + Batch 268
precedent. Match file comment density — this file is upstream-shared, keep the diff minimal.)

b. Immediately before `updateFrustums(this, scene, near, far)` (View.js:320):
```js
if (near > far && sawEnvironmentNoBV) {
  // Sky-only view: only BV-less ENVIRONMENT commands exist. Restore the
  // camera-range window so a frustum exists for them (Batch 247 rationale).
  near = frustum.near;
  far = frustum.far;
}
```
`near > far` is exactly the "no contributor" state (+MAX vs -MAX). Do NOT use
`numFrustums = max(1, …)` inside `updateFrustums` instead — with near===+MAX the clamps at
View.js:434-435 would produce a degenerate `[1e10, 1e10]` band and env would bin but render with
a nonsense frustum; the pre-updateFrustums fallback keeps today's sky-only geometry exactly.

c. Touch NOTHING else: not `insertIntoBin`, not the ClearCommand branch, not the BV branch, not
`updateFrustums`' formula, not any WebGPU renderer file. **Rejected alternative** (for the record,
so you don't re-derive it): attaching honest BVs per producer (atmosphere shell = 1.025×
ellipsoid per `SkyAtmosphere.js`, sun/star sentinels) — it misses the Moon site the register
itself missed, needs per-frame BV maintenance in five renderers, and invents fake geometry for
directional content; the pass-keyed exclusion is strictly smaller and future-proof.

**Step 3 — telemetry.** Add a `frustums: { count: this._view.frustumCommandsList.length }` field
to `Scene.getDebugSnapshot()` (Scene.js:1978, near the `debugToggles` block ~:2036) so
`CesiumDebug.snapshot()` exposes it. Update
`migration_doc/DEBUGGING_GUIDE.md` in the same commit (CLAUDE.md: a drifted guide is worse than
none) and note the new probe in `Tools/visual-regression/README.md`.

**Step 4 — build + probe.** `npx tsc --noEmit` → `npx gulp build` → `node server.js` → rerun
`probe-frustum-count-3d.mjs`. Pass = WebGPU `numberOfFrustums === 1` at all three waypoints,
`=== WebGL`, ENVIRONMENT bin count in the (single) farthest frustum unchanged (5 default env
commands: shell + sun + moon + starfield binned, + injected skybox/starfield copies added later by
SceneRenderer — count the BINNED slot before injection if you assert exact numbers), sky-only leg
unchanged vs baseline, sun/sky pixels present. **Read the PNGs yourself** — confirm sun disk,
moon, stars, atmosphere gradient against the WebGL captures.

**Step 5 — regression battery** (all must be green before any perf claim):
- `node Tools/visual-regression/capture-and-diff.mjs` — full scene battery vs baselines.
- Env-specific: `probe-atmosphere-orbit.mjs`, `probe-atmo-moon-438.mjs`,
  `diag-stars-hdr-autoexposure.mjs` — mismatch % must not regress.
- Modes: `probe-2d-cv-modes.mjs`, `probe-2d-frustum-bins.mjs` (2D band counts unchanged).
- Pick: `probe-pickposition-webgpu.mjs`, `probe-point-pick-webgpu.mjs`, `probe-billboard-pick.mjs`.
- Karma (WebGL invariant): `npm run build --workspace @cesium/engine` FIRST (spec-bundle
  freshness trap), `$env:CHROME_BIN` → Edge, run `--includeName Multifrustum` and
  `--includeName FrustumCommands`.

**Step 6 — perf evidence (moving-altitude lane ONLY; idle-soak is invalid).**
`node Tools/visual-regression/run-performance-campaign.mjs --workload
moving-camera-altitude-track-3d --repetitions 6 --output <artifact>` — clean lane (no
`--api-instrumentation`, no `--gpu-timestamps`, no `--reuse-browser`), `--renderer both` for
counterbalancing. Oracle discipline: capture OFF (pre-fix tree) → ON (fix applied) → RESTORED
(revert spot-check) runs; never overwrite historical artifacts; comparison anchor = Gate-A r5
(WebGL 5.50 / WebGPU 7.51 ms CPU p95). Expected signal: whole-route WebGPU CPU p95 down + named
stages (clear / globe-depth pack / environment / frustum-loop CPU) down; promotion claim requires
≥5% named-stage p95 or >3× measured noise. **If the delta is under threshold, the slice still
lands** — its acceptance is the structural frustum-count collapse to WebGL parity with zero
regression (register S7-1 verdict); record the honest number, claim no promoted-optimization
banner. Optionally run one `--gpu-timestamps` characterization rep, clearly labeled, never mixed
into the CPU comparison.

**Step 7 — land + docs.** Ledger row in the Campaign-10 queue in the same commit; batch header
names the mechanism ("BV-less Pass.ENVIRONMENT near/far exclusion + sky-only fallback");
`WEBGPU_DEBUGGING_LOG.md` entry; note in `FORK_PERFORMANCE_RTE_VISIBILITY_REMEDIATION_PLAN` /
FAR-707 that the frustum-count claim is now carved out (register §15.1). Commit as kurtyoung-dev.

---

#### Traps

1. **FIVE push sites, not three.** The register (S7-1) lists SkyAtmosphere/Sun/StarField; the
   Moon (`WebGPUEnvironmentRenderer.js:1119`, default-on via `CesiumWidget.js:591`) and the
   opt-in fullscreen-sky command (`WebGPUSkyAtmosphereRenderer.js:1333`) also push BV-less. A
   producer-keyed fix silently leaves the floor at 2. The pass-keyed exclusion is mandatory.
2. **Sky-only black canvas.** Excluding env from accumulation with NO fallback → `near` stays
   +MAX_VALUE → clamps produce `far/near = 1` → `numFrustums = 0` → nothing executes, black
   canvas — precisely the failure Batch 247's push convention was built to prevent
   (`WebGPUStarFieldRenderer.ts` :600-616 comment says so explicitly). The `near > far &&
   sawEnvironmentNoBV` fallback is load-bearing; test the sky-only leg.
3. **Do not un-bin env commands or touch the dedupe.** The frustum loop executes ENVIRONMENT from
   the BINNED farthest-frustum slot (`WebGPUSceneRendererFrustumLoop.ts:255-266`) and
   `SceneRenderer.js:358-371`'s `maybeInject` dedupes injected copies against the binned ones —
   removing binning "because env executes only once anyway" re-introduces the Batch-247
   sun-erased-by-atmosphere-shell bug and breaks skybox/starfield draw ordering.
4. **View.js is shared upstream code.** WebGL runs the same function. Today no WebGL path pushes
   `Pass.ENVIRONMENT` into `commandList` (grep `frameState.commandList.push` under
   `packages/engine/Source/Scene/` — the hits are GLOBE/OPAQUE/TRANSLUCENT/COMPUTE producers), so
   the branch is inert there — but re-run that grep at implementation time and run the
   Multifrustum/FrustumCommands specs; if an upstream sync introduced an ENVIRONMENT pusher,
   stop and re-scope.
5. **`executeInClosestFrustum` is NOT the fix.** Setting it on env commands would bin them into
   the NEAREST band only; ENVIRONMENT executes at `i === 0` = FARTHEST — env would silently stop
   rendering whenever 2 frusta exist (sky-only fallback frames!). Leave it false.
6. **Log-depth encode is full-frustum, not per-band — that's why env survives re-banding.**
   `publishLogDepthEncodeNearFar` (`WebGPUSceneRendererFrustumLoop.ts:162-170`) encodes against
   `scene.camera.frustum` (0.1/1e10), NOT the per-band slice, so env frag_depth values do not
   change when the far band disappears; WebGL already renders these same effects in one
   content-fit frustum (the existence proof). Do NOT "helpfully" re-encode anything per-band.
7. **2D is not automatically safe.** `updateEnvironment`'s skip condition (Scene.js:3656-3659) is
   `mode !== SCENE2D && ortho` — env updates DO run in SCENE2D. Whether the WebGPU env FRs push
   there decides if 2D band counts change. Run `probe-2d-frustum-bins.mjs` before/after and do
   the S7-6 audit rider (which fork commands bin BV-less in 2D/CV) — report findings, don't fix
   them in this slice.
8. **Pick already runs 1 frustum — don't chase phantom pick wins, and don't break offscreen.**
   `updateEnvironment`'s `!renderPass` early-branch keeps env out of pick mini-frames
   (Scene.js:3656-3667). `pickFromRay` offscreen frames have `passes.render = true` and will
   legitimately drop 2→1 — run the pick probes, expect PASS not change-of-behavior.
9. **The "frustum 0" pass-label artifact.** Pass labels containing `frustum ${i}` exist ONLY in
   `WebGPUSceneRendererPickPass.ts`; main-loop passes carry no frustum index. Do not conclude
   frustum count from pass labels (this exact category error produced the first S7 draft's wrong
   "already single-frustum" verdict) — read `scene.numberOfFrustums`.
10. **Line drift is real.** Scene.js anchors moved ~20 lines between the register (written at
    Batch 673) and this guide (post-674). Whatever batch you land at, re-grep; anchor by symbol
    (`worst-case near and far`, `10000000000`, `maybeInject`) not by line.
11. **Don't decompose or modernize View.js while you're in there** — >10-line-change modernization
    rule is tempting bait; this is an upstream-merge-sensitive file, keep the diff surgical.
12. **CSM is unaffected but verify anyway:** shadow near/far fitting lives inside the
    `defined(boundingVolume)` branch (View.js:266-285) — env commands never reached it before or
    after. A shadows-enabled probe rep (any capture-and-diff scene with shadows) is cheap
    insurance.

---

#### Verification recipe (exact)

| # | Check | Command | PASS means |
| --- | --- | --- | --- |
| 1 | Types + build | `npx tsc --noEmit && npx gulp build` | clean exit |
| 2 | Frustum-count probe (new) | `node Tools/visual-regression/probe-frustum-count-3d.mjs` (server running) | WebGPU count === 1 === WebGL at 18,000 km / 500 km / 300 m; ENVIRONMENT bin count unchanged; sun/moon/star/atmo pixels present; sky-only leg count ≥ 1 with stars visible; PNGs read and artifact-free |
| 3 | Scene battery | `node Tools/visual-regression/capture-and-diff.mjs` | no scene's mismatch % regresses vs baseline |
| 4 | Env visuals | `probe-atmosphere-orbit.mjs`, `probe-atmo-moon-438.mjs`, `diag-stars-hdr-autoexposure.mjs` | each reports PASS / unchanged mismatch |
| 5 | Modes | `probe-2d-cv-modes.mjs`, `probe-2d-frustum-bins.mjs` | 2D/CV band counts and visuals unchanged |
| 6 | Pick | `probe-pickposition-webgpu.mjs`, `probe-point-pick-webgpu.mjs`, `probe-billboard-pick.mjs` | PASS |
| 7 | WebGL invariant | Karma `--includeName Multifrustum` + `--includeName FrustumCommands` (engine workspace rebuilt first, CHROME_BIN=Edge) | SUCCESS exit code (ignore trailing launcher artifact line) |
| 8 | Perf | `run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --repetitions 6 --renderer both` OFF/ON/RESTORED | route p95 delta recorded honestly vs Gate-A anchor; promotion banner only if ≥5% named-stage p95 or >3× noise; no WebGL regression, no route p99 regression |

#### Rollback boundary

One commit, JS-only: `View.js` (two small hunks) + `Scene.js` snapshot field + the new probe +
doc updates. Revert = `git revert <batch>` → 2-frusta behavior restored, zero residue: no shader,
no pipeline key, no WGSL define, no pipeline-cache invalidation, no bind-group layout, no doc
contract (IMAGERY_PROJECTION etc.) touched. Per campaign rules the probe and the snapshot
telemetry SURVIVE rollback (tests/counters outlive the optimization). Nothing downstream may take
a dependency on `numFrustums === 1` in this campaign wave (S7-2 content-gating and S7-5 UB reuse
must each keep their own correctness independent of frustum count).

---

### C10-GT-REVERSED-Z-SLICE-B — gated-tail dossier (FAR-707 proper)

**Status: GATED TAIL. Do not start implementation from this dossier. Verdict of record
(register §15): GO for a two-slice sequence, NO-GO as a monolithic item. Slice (a) is C10-01
above. This dossier defines slice (b)'s scope, its gates, and the contradiction that must be
resolved BEFORE either gate opens.**

#### Scope (all counts re-verified live, with re-count commands)

| Surface | Verified count | Re-count command |
| --- | --- | --- |
| Producer WGSL with `//>>ifdef LOG_DEPTH` | **71 `.wgsl` files** (74 write `frag_depth`) — each has a generated `.js` twin in the same dir; edit `.wgsl` only, `npx gulp build` regenerates | `grep -rln ">>ifdef LOG_DEPTH" --include="*.wgsl" packages/engine/Source/Shaders/WebGPU/ \| wc -l` |
| `depthCompare` flips (`less*`→`greater*`) + depth clearValue 1→0 | **140 sites / 47 files** (matches register exactly) — one-time pipeline-cache-wide invalidation | `grep -rn "depthCompare" packages/engine/Source/Renderer/WebGPU/ \| wc -l` |
| JS consumers reading `_logDepthEncodeNearFar` | **42 sites** (18 files under Renderer/WebGPU + Scene consumers) + `PickDepth.js` CPU decode | `grep -rn "_logDepthEncodeNearFar" packages/engine/Source/Renderer/WebGPU/ packages/engine/Source/Scene/ \| wc -l` |
| Depth-reading effect families re-linearizing | ~14 (SSR/SSR-f16, GTAO/AO, DoF, GodRay, ContactShadows, AerialPerspective, VolumetricFog, Clouds, EDL, Ground* classifiers, Picking) | — |
| Packed-depth ecosystem | RGBA8 fixed-point pack cannot represent reversed-Z far field (~1e-7 quanta) → `WebGPUGlobeDepth` pack + `PickDepth` must move to r32float copy or direct depth sampling (non-filtering sampler). **This deletion is the un-owned prize: 2-3 fullscreen pack passes/frame + surrounding boundaries go away** | `WebGPUGlobeDepth.ts` pack (~:377-416), `PickDepth.js` |
| Stencil | scene FB is `depth24plus-stencil8` (`WebGPUContext.ts:347`); classification stencil is load-bearing → needs `depth32float-stencil8` (OPTIONAL WebGPU feature) with a real fallback story. A partial fleet (some adapters log, some reversed) = the "second permanent architecture" the FAR plan forbids for failed experiments | — |
| TAA / previous-frame | `previousViewProjection` tail contract (DP-H41) must carry the flipped convention through reprojection; C9-29 adjacency | CLAUDE.md |
| Modes NOT helped | 2D/CV/ortho use linear depth — reversing redistributes nothing; the frustum loop, 2D banding, and per-slice UB machinery survive slice-b in those modes permanently (S7-6) | — |
| Kill switch precedent | `WebGPULogDepth.ts:22-30` `_logDepthWriteEnabled` master switch — slice-b needs the equivalent single flip point, and the landing is **all-or-nothing on a shared depth buffer** (mixed encodings cannot depth-test against each other; the pick-fleet sub-ulp-Δz lesson binds equally) | — |

#### Precision claims (the classic objection, resolved — do not re-litigate)

Reversed-Z f32 with infinite-far projection: relative error ≈ 2⁻²⁴·eyeZ → ~2 cm at 350 km,
~0.6 m at 10,000 km — equal or better than log depth's own quoted 0.42 m/quantum at 350 km
(`WebGPULogDepth.ts:10-16`), with no per-fragment `log2()` and no interpolation caveats. Horizon
precision is NOT the blocker; the 71+140+42-site contract surface and the stencil-format fallback
story are. RTE rules are orthogonal and unchanged: reversed-Z alters NDC z encoding only, never
the high/low position pipeline — any slice-b work that touches positionHigh/Low is out of scope
and wrong.

#### The GPU-side payoff being bought (S7-3)

Default-on log depth writes `@builtin(frag_depth)` in every production pipeline variant
(LOG_DEPTH became the production variant at Batch 251), and the canonical contract
(`chunks/functions/csm_writeLogDepth.js`) requires `discard` for near/far culling. frag_depth +
discard forfeits early-Z, Hi-Z rejection, and depth compression on effectively every opaque draw
— the GPU shades every occluded fragment; `GlobeTerrain.wgsl` samples up to 16 imagery layers per
fragment, and horizon-oblique views (exactly where fork FPS is weakest) have peak overdraw.

#### THE CONTRADICTION (act on this before anything else in the tail)

`NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (Campaign-9 queue rows 121/134-137; **NOT STARTED as of
2026-07-16 — re-check the §3.2 ledger first, this WILL have moved**) plans to convert **~15+ pick
producers TO log frag_depth** (plus vector-tile/voxel/splat/point-cloud/ellipsoid/classification
renderers) because the hyperbolic pick FBO mathematically cannot discriminate the depth plane
from a just-beyond-horizon marker at 5,000 km (sub-ulp Δz; `PICK_DEPTH_PLANE_ENABLED` held false
at the gate). Reversed-Z slice-b would convert the SAME producer surface AWAY from log depth. The
two streams pull one surface in opposite directions and, at register-writing time, no document
connected them. **They must be one design:**

- **If the early-Z spike says GO:** the pick fleet converts DIRECTLY to reversed-Z f32 depth —
  which independently solves the discrimination defect that motivated it (reversed-Z far-field
  quanta ~2⁻²⁴·eyeZ easily separate plane from marker at 5,000 km) — and slice-b becomes a joint
  scene+pick migration with one depth convention end-to-end (also killing the mixed-encoding bug
  class that burned C9-02B). The ~14-producer log-depth conversion is then SKIPPED, not done and
  undone.
- **If the spike says NO-GO:** reversed-Z parks permanently in the register, and the pick fleet
  proceeds with log depth exactly as its row specifies.
- **Either way, record the decision in BOTH work items + `DEFERRED_WORK.md`** — the register
  flagged the missing cross-link as its own defect (§17).

#### Gates (in order — each is a stop-and-block)

1. **Gate 1: C10-01 landed and verified.** The frustum-count claim must already be carved out;
   if anyone books "collapse to 1 frustum" as a slice-b deliverable, the scoping is wrong —
   reversed-Z contributes nothing to frustum count.
2. **Gate 2: the early-Z spike (days-scale, measurement-only, own queue row C10-13).** One probe
   scene (horizon-oblique globe + dense 3D tiles — the weak-FPS views): compile
   globe/model/primitive pipelines with `defines=0` (the `//>>else` hyperbolic branch already
   exists in all 71 files — the preprocessor guarantees byte-identical fallback), a reversed-Z
   infinite-far projection, `depth32float`, `greater-equal` compare; measure fragment-invocation
   delta with the existing `CesiumDebug.gpuPassCost` timestamps. **Promotion threshold
   (register §15.6): ≥20-30% fragment-work reduction on the weak-FPS views**, else reversed-Z
   stays parked and only content-gating (S7-2/S7-4 owners) proceeds. Spike artifacts are throwaway
   — nothing from the spike lands on main except the measurement report.
3. **Gate 3: the pick-fleet reconciliation decision recorded** (above), BEFORE the ~15-producer
   conversion lands. If pick-fleet has already landed its log-depth conversion when you read
   this, the slice-b cost table grows by that surface (converted twice) — recompute the counts
   and say so in the dossier update; it weakens but does not automatically kill the GO case.
4. **Gate 4: `depth32float-stencil8` fallback story resolved on paper** — enumerate adapter
   tiers; if any supported tier cannot come along, slice-b is NO-GO (forbidden dual permanent
   architecture). A `_reversedZEnabled`-style single master switch (mirroring
   `_logDepthWriteEnabled`) is required for the landing, with the OFF path byte-identical.

#### Slice-b rollback boundary (for whoever eventually executes)

All-or-nothing single flip: the master switch OFF must restore log-depth behavior byte-identical
(same discipline as Batch 251's staged landing — producers/consumers land inert behind the
switch, then one flip commit). Pipeline-cache-wide invalidation on flip is expected (140
depthCompare sites change) — first-frame compile storm mitigations (S8 prewarm work) should land
first or be accepted explicitly. Rollback = flip the switch, not revert 47 files.

#### Pointers

- Register: `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` — rows S7-1/S7-2/S7-3/S7-5/S7-6/
  S7-7, §14 seed 1, §15 verdict (the authoritative GO/NO-GO frame), §17 doc-contradiction list.
- Raw stratum (deepest detail, including the corrected first-draft reconciliation §1.4):
  `scratchpad/perfdive/S7-multifrustum-reversedz.md`.
- Queue vocabulary/gates: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §1 rules, row W8-1
  (C9-40 — the origin of C10-01), rows 121/136/137 (C9-02B + depth-plane contract + pick fleet).
- Format/mechanics exemplar: `migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md`
  (G10 Part A = the moving-altitude measurement protocol to reuse verbatim for Step 6).
- Precedent fix: `GlobeSurfaceTileProviderRendering.js:941-963` (Batch 268 comment — read it in
  full; it is the same bug class and documents the WebGL contract).
- Probe templates: `Tools/visual-regression/probe-2d-frustum-bins.mjs` (frustum-bin dump),
  `probe-saved-view.mjs` (capture+diff pattern), `performance-workloads.json`
  (`moving-camera-altitude-track-3d`).

---

### Campaign-10 queue rows

| # | ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- | --- |
| 1 | `C10-01-ENV-COMMAND-FRUSTUM-BINNING` | P0 (campaign anchor) | M (days) | Stop BV-less `Pass.ENVIRONMENT` commands (5 push sites: SkyAtmosphere shell `WebGPUSkyAtmosphereRenderer.js:1354` + fullscreen `:1333`, Sun `WebGPUEnvironmentRenderer.js:621`, Moon `:1119`, StarField `WebGPUStarFieldRenderer.ts:626`) from widening near/far in `View.createPotentiallyVisibleSet` (View.js:292-298): pass-keyed exclusion + sky-only fallback (`near > far && sawEnvironmentNoBV` → camera-range window) before `updateFrustums` (View.js:320); env commands still bin and execute in the farthest frustum; Batch-247 dedupe untouched; `numFrustums` added to `getDebugSnapshot`. JS-only, zero shader changes. Acceptance: new `probe-frustum-count-3d.mjs` shows WebGPU `numberOfFrustums === 1 === WebGL` at 18,000 km/500 km/300 m with sun/moon/stars/atmosphere pixels intact and sky-only leg unchanged (PNGs read); capture-and-diff battery + probe-2d-cv-modes + probe-2d-frustum-bins + pick probes green; Karma Multifrustum/FrustumCommands green; moving-altitude clean lane ≥5 counterbalanced reps with OFF/ON/RESTORED oracle vs Gate-A anchor, delta reported honestly (promotion banner only if ≥5% named-stage p95 or >3× noise; structural frustum parity is the landing bar regardless). Rollback: single revert; probe + telemetry survive. |
| 2 | `C10-13-REVERSED-Z-EARLYZ-SPIKE` | P1 | S-M (days, measurement-only) | FAR-707 gate evidence: one probe scene (horizon-oblique globe + dense tiles) compiled with `defines=0` hyperbolic `//>>else` branches + reversed-Z infinite-far projection + `depth32float` + `greater-equal`; measure fragment-invocation/gpuPassCost delta vs the default log-depth pipelines. MUST complete (and its verdict be recorded in BOTH `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` and the FAR-707 brief + DEFERRED_WORK) BEFORE the pick fleet's ~14-producer log-depth conversion lands — the two streams pull the same 71-file producer surface in opposite directions and must resolve to one depth convention. Acceptance: measurement report with ≥5 reps on the weak-FPS views + a written GO/NO-GO against the ≥20-30% fragment-work-reduction threshold (register §15.6); nothing from the spike lands on main. |
| 3 | `C10-GT-REVERSED-Z-SLICE-B` | Gated tail (do not schedule) | XL (weeks) | Reversed-Z migration proper, openable ONLY after: C10-01 landed, C10-13 spike GO (≥20-30% fragment-work reduction), pick-fleet reconciliation decision recorded (GO ⇒ pick fleet converts directly to reversed-Z f32, log-depth conversion skipped), and a written `depth32float-stencil8` fallback story covering every supported adapter tier (any tier left behind = forbidden dual permanent architecture = NO-GO). Scope of record: 71 producer `.wgsl` LOG_DEPTH surfaces retired; 140 `depthCompare` sites/47 files flipped + depth clearValue 1→0 behind a single `_reversedZEnabled`-style master switch (OFF = byte-identical log depth); 42 `_logDepthEncodeNearFar` JS sites + ~14 depth-consumer effect families re-linearized; RGBA8 pack ecosystem (`WebGPUGlobeDepth`/`PickDepth`) deleted in favor of r32float/direct depth sampling (the un-owned prize: 2-3 fullscreen pack passes/frame removed); TAA `previousViewProjection` carries the flipped convention; 2D/CV/ortho explicitly carved out (linear depth — machinery survives). All-or-nothing landing on the shared depth buffer; RTE high/low pipeline untouched. Acceptance: measured early-Z rejection gain on weak-FPS views ≥ spike projection, pack-pass deletion count, no pick/classification regression at horizon ranges (three-altitude oracle), full probe battery + moving-altitude lanes green, master-switch OFF byte-identical. |


---

<a id="h2"></a>

## H2 — Command / Upload Economics (C10 cluster)

**Author pass 2026-07-16, live tree post-Batch-674 (`main` @ `a54cc06b2a` + working set).**
Every file:line anchor below was re-verified by symbol grep against the live tree during this
pass — but the tree moves daily under the concurrent campaign. **Re-grep every anchor before
editing; treat line numbers as hints, symbols as truth.**

Cluster covers three independent slices, one concern each:

| Task | Register row | Stratum evidence | Concern |
| --- | --- | --- | --- |
| **C10-02-TILES-STYLE-COMMAND-ECONOMICS** (W8-2) | Deep-dive item #1 (S11-1) | `perfdive/S11-tiles-traversal.md` Finding 1 | phantom all-discard TRANSLUCENT twin per batch-table primitive |
| **C10-09-VELOCITY-PREV-BUFFER-GPU-COPY** (W8-9) | Deep-dive item #9 (S6-2) | `perfdive/S6-upload-streaming-paths.md` F2 | full CPU re-upload of static instance arrays every TAA frame |
| **C10-10-SHADOW-CAST-SINGLE-SWEEP** (W8-10) | Deep-dive §1 secondary (S1-2) | `perfdive/S1-shared-frontend-cpu.md` F2 | second full-commandList sweep per shadow map per frame |

These are three separate slices. Land them independently, each with its own on/off/restored
oracle. Do **not** batch them into one commit — the campaign rule is one concern per slice, and
their verification lanes (tileset scene / TAA+splat scene / CSM scene) are disjoint.

**Binding campaign rules for all three (encode in acceptance):**
- Never remove, default-disable, bypass, or visually degrade a feature to move a metric. Each fix
  here is a *gate* on redundant work, with the current behavior preserved as the fallback path.
- Unknown demand / unknown consumer → conservative fallback (do the work). Never guess a skip.
- RTE precision is untouched (no absolute planetary ECEF f32 pre-subtraction anywhere in these).
- Perf evidence: moving-altitude route only (idle-soak is INVALID), clean and API-instrumented
  lanes never mixed, ≥5 counterbalanced reps for any blocking-timing claim.
- Promotion bar: ≥5% named-stage p95 improvement OR >3× noise, with on/off/restored oracles.
- Pixel oracles are mandatory (Principle 8): read the output PNGs yourself; a diff that drops is
  not proof unless the artifact visually matches WebGL and no new artifact appeared.

---

### C10-02-TILES-STYLE-COMMAND-ECONOMICS (W8-2)

#### Architecture today (verified)

**The WebGL economics (the parity target).** WebGL derives a *second* (translucent) tile command
only when the applied style actually mixes per-feature opacity:

- `packages/engine/Source/Scene/Model/StyleCommandsNeeded.js:8-27` — the enum + decision:
  `getStyleCommandsNeeded(featuresLength, translucentFeaturesLength)` returns `ALL_OPAQUE` (0)
  when `translucentFeaturesLength === 0` (the default, unstyled case), `ALL_TRANSLUCENT` (1) when
  every feature is translucent, else `OPAQUE_AND_TRANSLUCENT` (2).
- `packages/engine/Source/Scene/Model/Model.js:2380-2386` — `updateStyleCommandsNeeded(model)`
  writes `model._styleCommandsNeeded` from `featureTable.batchTexture.translucentFeaturesLength`;
  it is recomputed only when `featureTables[i].styleCommandsNeededDirty` (`Model.js:2365-2377`),
  i.e. on style mutation, not per frame. Public getter at `Model.js:2179-2181`.
- `packages/engine/Source/Scene/Model/ModelDrawCommand.js:135-160` — `pushCommands` is the exact
  gate to mirror:
  ```js
  const styleCommandsNeeded = this.model.styleCommandsNeeded;
  if (this._needsTranslucentCommand && defined(styleCommandsNeeded)) {
    if (styleCommandsNeeded !== StyleCommandsNeeded.ALL_OPAQUE) {
      pushCommand(result, this._translucentCommand, use2D);   // emit twin
    }
    if (styleCommandsNeeded === StyleCommandsNeeded.ALL_TRANSLUCENT) {
      return;                                                  // suppress the OPAQUE primary
    }
  }
  ```
  So: `ALL_OPAQUE` → primary only; `OPAQUE_AND_TRANSLUCENT` → both; `ALL_TRANSLUCENT` → translucent
  only.

**The WebGPU path ignores all of it.** `grep -rn "styleCommandsNeeded" packages/engine/Source/Renderer/WebGPU`
= **zero hits** (verified). Instead:

1. `packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js:287-297` — `createBatchGPUTexture`
   **force-fills** `batchTexture._batchValues` with `new Uint8Array(w*h*4).fill(255)` (opaque white /
   show=true) when it is undefined, then unconditionally creates the GPU texture
   (`:301-314`). WebGL defers `createTexture` until the first `setColor/setShow` (comment concedes
   this at `WebGPUModelFeatureId.js:280-286`).
2. `packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js:513-520` — because the texture
   now always exists, `flags |= 0x40000 // FLAG_HAS_BATCH_TABLE (bit 18)` is set for **all**
   b3dm / feature-table glTF content, always.
3. `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts:5946-6108` — the dual-emission
   block (`C-R1-TILE-BATCH`, Batch 101). It gates *only* on
   `passClass === 0 && hasBatchTable && !suppressSurfaceForEdgesOnly` (`:5966`), where
   `hasBatchTable = defined(featureIdRes) && (featureIdRes.flags & MaterialFlags.HAS_BATCH_TABLE) !== 0`
   (`:5958-5960`). Inside, **every frame, for every batch-table primitive**:
   - second `packMaterialUniforms(..., 1 /* passClass=translucent */)` → `:5987-5997`
   - a 768 B `device.queue.writeBuffer` to `materialBufferTranslucent` → `:6034-6040`
     (`MATERIAL_UNIFORM_SIZE = 768`)
   - a second merged group-1 bind group `buildMergedMaterialBindGroup(...)` → `:6057-6067`
   - a second `new WebGPUDrawCommand({ ..., pass: Pass.TRANSLUCENT })` → `:6068-6088`, pushed at
     `:6107`.

**GPU-side cost of the phantom.** The translucent-class FS keeps only features with alpha in
`[0.004, 0.998)` and `discard`s the rest — `packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl:3446-3473`
(the class discard at `:3465-3473`, gated on `material.tileBatchFlags.x > 0.5`). With the default
all-opaque batch texture, **100% of fragments discard** — the twin re-runs the entire VS +
rasterization + a batch fetch per fragment, then throws every fragment away, and the presence of
`discard` disables early-Z for the draw.

**Systemic knock-ons** (why this is architectural, not a nit):
- The `Pass.TRANSLUCENT` bin is never empty for any tileset → the landed "skip empty-pass
  boundaries" optimization is permanently defeated for tiles, and OIT / alpha resources always
  execute.
- Every phantom enters the per-frame back-to-front CPU sort
  (`WebGPUSceneRendererTranslucentPass.ts`, `sortCommandsBackToFront`) — O(N log N) JS comparator
  with per-command distance math, N inflated by the whole selected-tile primitive count.
- `Cesium3DTile.update` stamps `depthForTranslucentClassification` on tile-owned twins
  (register anchor `Cesium3DTile.js:1081-1096` — re-verify; hint only), opting them into the
  translucent-tile-classification depth machinery.

**Quantification (from S11 Finding 1):** 400 selected tiles × ~1–2 prims ⇒ +400–800 draw
commands/frame, +300–600 KB/frame redundant material-UB writeBuffer, plus a full second
rasterization of all tile geometry. *(Correction 2026-07-17: the original "+400–800 bind-group
builds/frame" component was eliminated by Batch 687 — the translucent twin's group-1 bind group is
now identity-cached (dedicated `MERGED_MATERIAL_SLOT_TRANSLUCENT` slot, 0 steady-state creates);
the surviving costs above — twin command construction, 768 B writeBuffer/frame/prim, second
`packMaterialUniforms`, full second rasterization with early-Z-disabling discard, translucent-bin
sort inflation — still justify this task; drop the bind-group component from V-5's expected win.)* Command-list length roughly
doubles for tileset-heavy scenes.

#### Target design + invariants

Port the WebGL economics onto the WebGPU FR: emit the translucent-class twin only when the style
demands it, and suppress the opaque primary in the `ALL_TRANSLUCENT` case.

1. **INV-1 (default is one command).** For an unstyled batch-table primitive
   (`translucentFeaturesLength === 0` ⇒ `ALL_OPAQUE`), the FR emits exactly one command
   (`Pass.OPAQUE` / whatever the primary `passClass` is) — byte-identical GPU output to today's
   opaque primary. The `Pass.TRANSLUCENT` twin is NOT emitted.
2. **INV-2 (mixed style emits both).** When a `Cesium3DTileStyle` makes some but not all features
   translucent (`OPAQUE_AND_TRANSLUCENT`), both commands emit exactly as today.
3. **INV-3 (all-translucent suppresses the primary).** When every feature is translucent
   (`ALL_TRANSLUCENT`), only the translucent-class command emits; the opaque primary is suppressed
   — matching `ModelDrawCommand.js:157-159`. (Today WebGPU emits both, so all-opaque geometry is
   drawn in the opaque pass AND re-discarded in translucent — INV-3 is a correctness+perf
   improvement, not just perf.)
4. **INV-4 (style-mutation invalidation).** The moment a style mutation flips
   `translucentFeaturesLength` across a boundary (0 → >0, or <all → all), the next frame's emission
   reflects the new `styleCommandsNeeded`. No stale one-command state after a style that adds
   translucency; no stale twin after a style that removes it.
5. **INV-5 (pick parity).** Feature picking (`pick`, `drillPick`, metadata pick) still resolves
   every feature. Pick commands are emitted independently of the surface twin (see Trap T-4);
   dropping the translucent *surface* twin must not drop pick coverage.
6. **INV-6 (conservative fallback).** If `model.styleCommandsNeeded` is `undefined` (feature table
   not yet realized, or a code path that does not maintain it), **fall back to today's behavior**
   (emit the twin). Never skip on an unknown signal. This mirrors the WebGL guard
   `defined(styleCommandsNeeded)` at `ModelDrawCommand.js:150`.
7. **INV-7 (RTE / no feature loss).** No change to geometry, RTE packing, or the batch texture's
   correctness. Do not delete the dual-command machinery — gate it.

#### Implementation walkthrough

The FR runs inside `updateWebGPUModel` → the per-primitive command build in `WebGPUModelRenderer.ts`.
The signal you need, `model.styleCommandsNeeded`, is a **model-level** value (Model.js maintains it),
and the model is reachable at the emission site (`owner: model` is set on the commands; `model` is in
scope — it is used at `:6083`, `:6100`).

**Step 1 — read the demand signal once per primitive (or hoist to per-model).**
Near the top of the dual-emission block (before `:5966`), resolve:
```js
// Mirror WebGL ModelDrawCommand.pushCommands economics: only emit the
// translucent-class twin when the applied style actually mixes opacity.
const scn = model.styleCommandsNeeded; // StyleCommandsNeeded | undefined
// INV-6: unknown → conservative (emit twin, as today).
const emitTranslucentTwin = !defined(scn) || scn !== StyleCommandsNeeded.ALL_OPAQUE;
const suppressOpaquePrimary =
  defined(scn) && scn === StyleCommandsNeeded.ALL_TRANSLUCENT;
```
Import `StyleCommandsNeeded` at the top of `WebGPUModelRenderer.ts`
(`import StyleCommandsNeeded from "../../Scene/Model/StyleCommandsNeeded.js";` — verify the relative
path from `Renderer/WebGPU/`; it is `../../Scene/Model/`).

**Step 2 — gate the twin.** Change the guard at `:5966` from
```js
if (passClass === 0 && hasBatchTable && !suppressSurfaceForEdgesOnly) {
```
to additionally require `emitTranslucentTwin`:
```js
if (passClass === 0 && hasBatchTable && !suppressSurfaceForEdgesOnly && emitTranslucentTwin) {
```

**Step 3 — suppress the opaque primary in the ALL_TRANSLUCENT case.** This is the harder half:
the primary opaque command is built *above* the dual-emission block (it is the main surface command
pushed earlier in `updateWebGPUModel`). Find where the primary surface `WebGPUDrawCommand` is pushed
to `commandList` for this primitive (grep upward for the primary `commandList.push` in the same
function scope — the primary is the command whose `pass` is derived from `passClass`/alphaMode, not
the `Pass.TRANSLUCENT` twin). Gate that push on `!suppressOpaquePrimary`.
   - **Decision point:** if the primary-push site is structurally entangled (e.g. the primary is
     also the depth/pick source, or `suppressSurfaceForEdgesOnly` already interacts with it),
     and cleanly suppressing it risks INV-5/pick or classification-depth regressions, **do not
     force it**. Ship Steps 1-2 (the dominant win — INV-1 kills the phantom for the default
     unstyled case, which is >99% of tileset primitives) and record INV-3 as PARTIAL with the
     reason. `ALL_TRANSLUCENT` tilesets are rare; a redundant opaque draw there is a small residual,
     not a correctness bug (the translucent twin still renders them). Surface it as the next work
     item (Principle 9), do not silently route around it.

**Step 4 — do NOT touch the batch-texture force-create (`WebGPUModelFeatureId.js:287-297`).**
The register's fix-direction floats "create the batch texture lazily on first style mutation, keeping
FLAG_HAS_BATCH_TABLE dynamic." **That is a separate, riskier slice — out of scope for C10-02.** Making
`FLAG_HAS_BATCH_TABLE` dynamic would flip the pipeline define set at runtime (pipeline rebuild churn,
pick-texture allocation races — see the eager-allocation rationale comment at
`WebGPUModelFeatureId.js:556-566`). The command-count gate (Steps 1-3) captures the entire per-frame
command/writeBuffer/bind-group/rasterization win **without** touching realization. Leave the batch
texture eager. If a follow-up wants the lazy-realization win, that is a distinct C10 row.

#### Traps

- **T-1 (the primary is not always `Pass.OPAQUE`).** `passClass === 0` means the primary is the
  opaque-class command; a genuinely translucent-material primitive takes a different path. The gate
  at `:5966` already scopes to `passClass === 0`, so Step 2 is correct. But Step 3's suppression
  must target the *primary of this same primitive* — do not suppress a sibling primitive's command.
- **T-2 (style-mutation staleness).** `styleCommandsNeeded` updates only when
  `styleCommandsNeededDirty` (Model.js:2365-2377). Confirm that `updateFeatureTables` runs before
  the command build each frame (it does — `Model.update` calls it early). If you cache
  `emitTranslucentTwin` per primitive across frames, you MUST invalidate on style change — simplest
  is to read `model.styleCommandsNeeded` fresh every frame (it is a cheap field read). Do not cache.
- **T-3 (`translucentFeaturesLength` maintenance is WebGL-batchtexture code).** Verify
  `BatchTexture.translucentFeaturesLength` is actually incremented/decremented on the WebGPU path
  when `setColor` sets alpha < 1. Grep `translucentFeaturesLength` in `BatchTexture.js` — if the
  WebGPU batch-value writes bypass the counter, `styleCommandsNeeded` would wrongly stay `ALL_OPAQUE`
  after a translucent style and INV-2 fails (features would render opaque-only). **This is the
  single highest-risk premise of the slice — verify it before claiming INV-2**, with a styled
  probe (Step V-2 below). If the counter is not maintained on WebGPU, that missing plumbing is the
  real prerequisite (Principle 9): fix the counter, or fall back to INV-6 conservative for styled
  models until it is fixed.
- **T-4 (pick emits separately).** Pick commands for batch-table primitives are built in the
  pick-frame path (`WebGPUModelRenderer.ts` ~`:5542-5690`, per S11 Finding 4), not from the surface
  twin. Confirm dropping the translucent surface twin does not drop a pick command — pick coverage
  comes from the feature-id pick texture + the primary/pick command, independent of the twin.
- **T-5 (classification depth).** Tile-owned twins can carry
  `depthForTranslucentClassification` + `classificationDepthPipeline` (`:6098-6106`). If a scene
  uses translucent-tile classification AND a style makes the tile all-translucent, INV-3's
  suppression of the opaque primary must not remove the depth contribution that classification
  reads. If in doubt, keep the primary when `defined(model.classificationType)` (extra opaque draw,
  correct output) — conservative fallback.

#### Verification recipe

Build: `npx tsc --noEmit` then `npx gulp build`. Dev server `node server.js`.

- **V-1 (INV-1, the headline).** Probe a b3dm / photogrammetry city tileset (unstyled) in WebGPU.
  Count `Pass.TRANSLUCENT` commands attributable to tile content via
  `viewer.scene.getDebugSnapshot()` (or a targeted counter on the translucent bin) before/after.
  **Pass = tile-content translucent command count drops to 0** for the unstyled scene, and total
  command count roughly halves for the tileset. Pixel oracle: WebGPU vs WebGL split-screen on the
  same tileset must remain within baseline mismatch (no visible change — the twin was invisible).
- **V-2 (INV-2/INV-4, style correctness).** Apply a `Cesium3DTileStyle` that sets a *subset* of
  features to `color('rgba(255,0,0,0.4)')`. Confirm (a) `model.styleCommandsNeeded === 2`
  (OPAQUE_AND_TRANSLUCENT), (b) the translucent twin reappears, (c) the translucent features render
  semi-transparent and the opaque ones stay opaque — pixel-compare vs WebGL with the same style.
  Then clear the style → twin disappears again next frame (INV-4). **This is also the T-3 check.**
- **V-3 (INV-3).** Style ALL features translucent → `styleCommandsNeeded === 1`. Confirm only the
  translucent command emits (opaque primary suppressed) and output matches WebGL. If Step 3 shipped
  PARTIAL, record that INV-3 shows a residual opaque draw (still visually correct) and name it as
  follow-up.
- **V-4 (INV-5, pick).** `drillPick` / `pick` a feature in the styled scene; confirm the correct
  feature resolves. Reuse `probe-pickposition-model-webgpu.mjs` as a template.
- **V-5 (perf promotion).** Moving-altitude route on a tileset workload (add/select a tileset
  workload in the campaign harness if none exists — see
  `Tools/visual-regression/performance-workloads.json`), clean + API-instrumented lanes, ≥5
  counterbalanced reps. Named stages: translucent-sort + pass-execute CPU, total command count,
  material-UB writeBuffer bytes/frame. **Promote if ≥5% p95 on a named stage OR >3× noise**, with
  on (gated) / off (revert the guard) / restored oracles.

#### Rollback boundary

The optimization is the `emitTranslucentTwin` / `suppressOpaquePrimary` guards (Steps 1-3) plus the
`StyleCommandsNeeded` import. Reverting those three edits restores today's always-emit-twin behavior
exactly — the dual-command machinery, batch texture, WGSL discard, and pick path are all untouched.
No feature is removed; no batch-texture realization is changed. Tests and counters survive rollback.
A single-file revert of `WebGPUModelRenderer.ts` (plus the import) fully rolls back.

#### Pointers

- Evidence: `perfdive/S11-tiles-traversal.md` Finding 1 (+ Finding 4/5 for the surrounding
  per-primitive frontend cost, owned by C9-17 — do NOT fold them in here).
- WebGL model to mirror: `ModelDrawCommand.js:135-160`, `StyleCommandsNeeded.js`, `Model.js:2380-2386`.
- WGSL twin discard: `ModelPBRComplete.wgsl:3446-3473`.
- Register: deep-dive item #1; proposed owner there was `C9-34`.

---

### C10-09-VELOCITY-PREV-BUFFER-GPU-COPY (W8-9)

#### Architecture today (verified)

The TAA motion-vector pass needs, per instanced primitive, a "previous frame" instance buffer so the
velocity VS can compute `curr − prev` in clip space. Three renderers keep a **CPU mirror** of the
previous instance data and **re-upload the entire array via `queue.writeBuffer` every frame** the TAA
flag is on — even when the content is static and the bytes are identical to what already resides in
the current-frame GPU `instanceBuffer`:

- **PointCloud (default path):** `packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudRenderer.ts:1736-1744`
  ```js
  const prevSrc = cache.prevInstanceData;
  if (prevSrc && prevSrc.byteLength >= requiredBytes) {
    device.queue.writeBuffer(cache.prevInstanceBuffer, 0, prevSrc.buffer,
                             prevSrc.byteOffset, requiredBytes);   // EVERY frame
  } else { /* seed via copyBufferToBuffer, :1750-1760 */ }
  ```
  `requiredBytes = cache.instanceCount * 40` (`:1699`). The seed/mismatch path (`:1745-1761`)
  already does a GPU `copyBufferToBuffer(instanceBuffer → prevInstanceBuffer)`. Promotion of
  this-frame's data to `prevInstanceData` happens at `:1820-1822`. Rebuild/revision site (where
  `instanceBuffer` is (re)written) at `:1489-1497` (`cache.lastRevision = pointCount`). The
  velocity attach is gated on `frameState.taaEnabled === true` (`:1687-1688`). LOD/storage path
  repeats the pattern (register `:2082-2090`).
- **Gaussian splats:** `WebGPUGaussianSplatRenderer.ts:1644-1652` (writeBuffer),
  seed at `:1654-1665`. 64 B/splat.
- **Clouds (CloudCollection):** `WebGPUCloudRenderer.ts:1421-1429` (writeBuffer), seed at
  `:1431-1442`. 68 B/instance.

**The waste (self-documented).** `WebGPUPointCloudRenderer.ts:1714-1719` and `:1816-1819`
explicitly state that for static content `cache.prevInstanceData === cache.instanceData` (the same
`Float32Array` reference) — so the bytes uploaded are identical every frame AND identical to what
already lives in `cache.instanceBuffer` on the GPU. There is no reference/revision check to skip the
write, and no GPU-side alternative. Contrast: Billboard/Label/Point collections migrated to
`WebGPUResidentInstanceBuffer.ts` (dirty-range coalesced, prev mirror written only on rebuild) —
these three never got that migration.

**Quantification (S6 F2):** with TAA on: 1M-splat scene = **64 MB/frame** (~3.8 GB/s @60fps,
~6–13 ms main-thread memcpy — alone caps near 30fps); 1M-point PNTS = 40 MB/frame; 10k clouds =
0.68 MB/frame. TAA defaults false (`Scene.js:1231`, published to `frameState.taaEnabled` at
`Scene.js:3479`) so default benchmarks don't see it — but TAA is the fork's flagship AA and any
"≥2× with TAA" claim hits this wall on point/splat content.

#### Target design + invariants

The fix is **revision-skip + GPU self-copy for the identity case**, applied identically to all
three renderers. "Identity case" = `cache.prevInstanceData === cache.instanceData` (prev and curr
are the *same array* → static geometry; velocity from geometry is 0, only camera motion contributes
through the matrices).

1. **INV-1 (static → zero CPU upload after seed).** For static content the `prevInstanceBuffer` is
   populated **once** (a GPU `copyBufferToBuffer` from `instanceBuffer`, which already holds the
   identical bytes), and every subsequent frame does **no** `writeBuffer` and **no** copy while the
   data revision is unchanged. Net per-frame CPU upload for static instance data under TAA: 0 bytes.
2. **INV-2 (animated correctness preserved).** For animated content where the app rebuilds
   `instanceData` as a *new array each frame* (the only animation path these renderers support —
   see Trap T-2), `prevInstanceData !== instanceData`, so the existing `writeBuffer(prevSrc)` path
   runs unchanged and velocity captures the true per-frame delta.
3. **INV-3 (velocity output byte-identical).** For static content, the velocity texture the TAA
   resolve reads must be identical to today's (geometry velocity 0; camera-induced velocity from the
   `previousViewProjection` matrix path is untouched). For animated content, identical to today.
4. **INV-4 (seed / count-change still emits velocity 0).** First-ever velocity frame and any
   point-count/revision change fall into the GPU-copy seed (as today) so the VS reads
   `(curr, curr) → 0` instead of garbage — never a stale-size read.
5. **INV-5 (revision correctness).** The skip is keyed on a monotonic data-revision that is bumped
   wherever `instanceBuffer` content is (re)written. If any future in-place mutation path is added,
   it MUST bump the revision. Unknown → do the upload (conservative).
6. **INV-6 (RTE untouched).** No change to instance-data layout or RTE encoding — this is purely an
   upload-avoidance gate.

#### Implementation walkthrough

Do PointCloud first (default path, biggest scenes), then replicate to splat and cloud. The three
are structurally identical.

**Step 1 — add a data-revision to the cache.** The PointCloud cache already tracks
`cache.lastRevision = pointCount` at `:1489-1497` (rebuild site). Add a dedicated
`cache.instanceDataRevision` (number, init 0) bumped at every site that (re)writes `instanceBuffer`
content: the rebuild at `:1489-1497` and the LOD storage upload path. `pointCount` alone is
insufficient as a data-change signal (two different static clouds could share a count), so use a
monotonic counter incremented on every content write, not the count itself.

**Step 2 — add a resident-revision marker.** Add `cache.prevBufferRevision` (number | undefined,
init undefined) = the `instanceDataRevision` whose bytes currently reside in `prevInstanceBuffer`.

**Step 3 — restructure the upload block** (`:1736-1761`) to three branches:
```js
const prevSrc = cache.prevInstanceData;
const isIdentity = prevSrc === cache.instanceData;   // static: prev IS curr

if (isIdentity && cache.prevInstanceBuffer &&
    cache.prevInstanceBuffer.size >= requiredBytes) {
  // Identity case: the bytes we would upload already live in instanceBuffer
  // on the GPU. Seed prevInstanceBuffer from it ONCE (GPU copy, zero CPU),
  // then skip while the revision is unchanged (INV-1).
  if (cache.prevBufferRevision !== cache.instanceDataRevision) {
    const encoder = device.createCommandEncoder({ label: "PointCloud prev identity-seed" });
    encoder.copyBufferToBuffer(cache.instanceBuffer, 0,
                               cache.prevInstanceBuffer, 0, requiredBytes);
    device.queue.submit([encoder.finish()]);
    cache.prevBufferRevision = cache.instanceDataRevision;
  }
  // else: static & already resident → NOTHING. This is the 64MB/frame win.
} else if (prevSrc && prevSrc.byteLength >= requiredBytes) {
  // Animated distinct-array path (INV-2) — unchanged.
  device.queue.writeBuffer(cache.prevInstanceBuffer, 0, prevSrc.buffer,
                           prevSrc.byteOffset, requiredBytes);
  cache.prevBufferRevision = undefined; // prev holds last-frame data, not current revision
} else {
  // First-frame seed OR count mismatch (INV-4) — existing GPU copy.
  const encoder = device.createCommandEncoder({ label: "PointCloud prev seed" });
  encoder.copyBufferToBuffer(cache.instanceBuffer, 0,
                             cache.prevInstanceBuffer, 0, requiredBytes);
  device.queue.submit([encoder.finish()]);
  cache.prevBufferRevision = undefined;
}
```
Keep the existing prev-buffer alloc/grow above (`:1700-1713`) unchanged. Keep the promotion at
`:1820-1822` unchanged (it is a no-op for static content — `prevInstanceData = instanceData` when
they are already the same reference — and correct for animated).

**Decision point — the private mid-frame submit.** The identity-seed and the existing seed use a
private `device.createCommandEncoder` + `device.queue.submit` (a mid-frame private submit, which is
F7/FAR-200 territory). **Leave it private for this slice.** Folding the copy onto the main frame
encoder is a *separate* concern (FAR-200 submission-timeline). The C10-09 win is that the copy fires
**once** (identity-seed) or on revision change — not every frame. Do not expand scope to the encoder
plumbing; if you want it, that is a FAR-200 rider, noted as follow-up (Principle 9).

**Step 4 — replicate to splat and cloud.** Same three-branch restructure at
`WebGPUGaussianSplatRenderer.ts:1644-1665` (fields `prevSplatData` / `prevSplatBuffer` /
`splatBuffer`, `requiredBytes` = count × 64) and `WebGPUCloudRenderer.ts:1421-1442`
(`prevInstanceData` / `prevInstanceBuffer` / `instanceBuffer`, 68 B/instance). Add the matching
`instanceDataRevision` / `prevBufferRevision` fields and bump at each renderer's instance-buffer
(re)build site (grep each for where the instance/splat buffer is written — splat rebuild is near its
`requiredBytes` computation, cloud likewise).

#### Traps

- **T-1 (`instanceBuffer` must be current before the copy).** The identity-seed copies
  `instanceBuffer → prevInstanceBuffer`. This is only correct if `instanceBuffer` already holds
  THIS frame's data at the point the velocity attach runs. Verify the instance-buffer (re)build
  (`:1489-1497`) runs *before* `attachPointCloudVelocityCommand` in the frame — it does (build is in
  the main update, velocity attach is called after). If a future refactor reorders them, the copy
  would seed stale bytes. Assert `cache.instanceBuffer` is defined before the copy branch.
- **T-2 (in-place mutation would break the identity skip).** The skip assumes animated content
  arrives as a *new array reference* per frame (so `prevInstanceData !== instanceData`). If an app
  mutates the same `Float32Array` in place every frame without bumping `instanceDataRevision`, the
  identity check would be true and the skip would freeze velocity at the seeded data. **These three
  renderers do not support in-place animation today** (the promotion comment `:1816-1819` and the
  revision-rebuild model both assume rebuild-on-change), so this is not a regression — but it is the
  correctness contract (INV-5): the revision bump is the guard. Document it at the bump site.
- **T-3 (revision must be bumped at ALL content-write sites).** PointCloud has the default rebuild
  AND the LOD/storage path (register `:2082-2090`, `:2207-2209`). Miss one and a content change on
  that path would be skipped (stale prev → wrong velocity). Grep every `writeBuffer`/`copyBuffer`
  into `instanceBuffer` and bump next to each.
- **T-4 (prev-buffer realloc invalidates the resident revision).** The alloc/grow at `:1700-1713`
  destroys and recreates `prevInstanceBuffer` on a size increase. After a realloc,
  `prevBufferRevision` is stale (points at bytes in a destroyed buffer). Reset
  `cache.prevBufferRevision = undefined` inside the realloc branch so the next frame re-seeds.
- **T-5 (splat sort interaction).** The splat renderer ALSO re-sorts indices per rotation (S11
  Finding 2 / S6 F1 — a *different* C10 task). Do not conflate. The velocity prev buffer holds
  instance/splat *attributes*, not the sorted index permutation; the sort writes
  `sortedIndexBuffer`, untouched here.

#### Verification recipe

- **V-1 (INV-1, the headline).** Load a static point cloud or splat tileset with TAA enabled
  (`taaEnabled: true`). With API instrumentation, count `queue.writeBuffer` bytes/frame attributable
  to `prevInstanceBuffer` (or total upload bytes/frame). **Before:** ~`count × stride` bytes every
  frame. **After:** one seed copy, then 0 upload bytes/frame while static. Reuse
  `probe-taa-velocity-emission.mjs` and `probe-splat-sort.mjs` / `probe-pointcloud-lod.mjs` as
  scene templates; add an upload-byte counter.
- **V-2 (INV-3, velocity byte-identical).** Capture the velocity texture (or the TAA-resolved frame)
  for the static scene, before vs after the change — must be pixel-identical (geometry velocity 0
  either way; camera motion preserved). This is the correctness oracle — read the PNGs.
- **V-3 (INV-2/INV-4, animated).** Use `probe-timedynamic-pointcloud-load.mjs` (time-dynamic point
  cloud rebuilds per frame → new array → non-identity path). Confirm velocity still captures motion
  (visual streaks under TAA match today) and no crash on count changes.
- **V-4 (perf promotion).** Moving-altitude route on a splat/pointcloud + TAA workload, clean +
  API-instrumented lanes, ≥5 counterbalanced reps. Named stage: per-frame upload bytes and
  main-thread `writeBuffer` CPU. **Promote if ≥5% p95 on the named stage OR >3× noise**, on/off
  (revert the three-branch restructure to the single `writeBuffer`) / restored.

#### Rollback boundary

The optimization is the three-branch restructure + the `instanceDataRevision` / `prevBufferRevision`
fields in each of the three renderers. Reverting restores the unconditional per-frame
`writeBuffer(prevSrc)`. No feature, no velocity contract, no RTE encoding changes — the velocity
output is identical, only the upload path differs. Each renderer is independently revertable (land as
one slice, but the three files are separable if one regresses). Tests and counters survive rollback.

#### Pointers

- Evidence: `perfdive/S6-upload-streaming-paths.md` F2 (and F7 for the private-submit / FAR-200
  boundary you are deliberately NOT crossing here).
- Healthy reference pattern: `WebGPUResidentInstanceBuffer.ts` (dirty-range coalescing) — the model
  the long-term C9-25/C9-28 velocity/RTE rework will converge these three onto. This slice is the
  interim GPU-copy win; keep it compatible with that rework (don't invent a parallel mirror system).
- Register: deep-dive item #9; proposed owner there was rider on C9-25/C9-28 → `C9-38`. TAA default
  `Scene.js:1231`.

---

### C10-10-SHADOW-CAST-SINGLE-SWEEP (W8-10)

#### Architecture today (verified)

With shadows enabled, the frame runs a **second full-`commandList` sweep per shadow map** to build
the per-cascade cast lists — duplicating work the PVS sweep already did:

- `packages/engine/Source/Scene/SceneRenderer.js:782-824` — `insertShadowCastCommands(scene, commandList, shadowMap)`:
  ```js
  const shadowedPasses = [Pass.GLOBE, Pass.CESIUM_3D_TILE, Pass.OPAQUE, Pass.TRANSLUCENT]; // :786-791 — array literal PER CALL
  for (let i = 0; i < commandList.length; ++i) {          // :793 — ENTIRE command list
    const command = commandList[i];
    scene.updateDerivedCommands(command);                 // :795 — re-run (see Trap T-1)
    if (!command.castShadows ||
        !shadowedPasses.includes(command.pass) ||         // :799 — linear .includes scan
        !scene.isVisible(shadowMapCullingVolume, command)) // :800 — light-frustum cull
      continue;
    // point-light: push to all passes; single: passes[0]; cascade: per-cascade isVisible (:812-821)
  }
  ```
- `SceneRenderer.js:826-864` — `executeShadowMapCastCommands(scene)`: for each shadow map, zeroes
  `passes[j].commandList` (`:860-862`) and calls `insertShadowCastCommands(scene, commandList, shadowMap)`
  (`:863`). Hoisted to run for BOTH backends (Batch 296, `NEW-CSM-CAST-NO-DISPATCH-VIEWER`,
  `:836-853`).
- `SceneRenderer.js:877-896` — the WebGL dispatch loop consumes the populated lists, reading
  `command.derivedCommands.shadows.castCommands[i]` (`:892`) — **the cast derived command built by
  `updateDerivedCommands`**. (WebGPU returns early at `:871`, consuming the same populated
  `passes[].commandList`.)

**The PVS sweep already visits every command** — `packages/engine/Source/Scene/View.js:193-324`
(`createPotentiallyVisibleSet`):
- main loop `:241-309` over `commandList`; camera cull `if (!scene.isVisible(cullingVolume, command, occluder)) continue;` at `:254-256`;
- it *already* branches on `shadowsEnabled && command.receiveShadows` (`:273-286`) to fit
  `shadowNear`/`shadowFar` — i.e. it already touches shadow state per command;
- camera-visible commands are binned via `insertIntoBin` (`:322-324` → `:481-525`), whose tail at
  `View.js:524` calls `scene.updateDerivedCommands(command)` for **every binned command every frame**.

**Cost (S1-2):** shadows on, 1 CSM map, N = 3–5k commands ⇒ per frame the cast build re-runs N
`updateDerivedCommands` + N `shadowedPasses` array allocs + N `.includes` scans + N light-frustum
tests + (casters × up to 4 cascade) `isVisible` tests ≈ 15–25k plane tests + 3–5k redundant derived
dirty-checks — an O(N × cascades) sweep duplicating the PVS pass, on scenes already CPU-bound.

#### Target design + invariants

Fold cast-candidate *collection* into the single PVS sweep: collect a per-frame **caster sublist**
(commands with `castShadows` in a shadowed pass, regardless of camera visibility), then have
`insertShadowCastCommands` iterate that small sublist and do only the light/cascade culling — no
second full-list scan, no per-command `updateDerivedCommands`, no per-call `shadowedPasses` alloc, no
`.includes`.

1. **INV-1 (off-camera casters preserved — CRITICAL).** The caster sublist MUST include casters that
   are outside the *camera* frustum but inside the *light* frustum (an object behind/beside the
   camera casting a shadow into view). Collection therefore happens BEFORE the camera-cull `continue`
   at `View.js:254`. Shadow output must be pixel-identical to today, especially at camera angles
   where casters leave the view.
2. **INV-2 (cast derived command exists for every light-culled caster).** Every command that reaches
   the WebGL dispatch read of `command.derivedCommands.shadows.castCommands[i]` (`:892`) must have had
   `updateDerivedCommands` run on it this frame. Camera-visible casters get it via `insertIntoBin`
   (`View.js:524`); camera-invisible casters do NOT go through `insertIntoBin`, so they need
   `updateDerivedCommands` run at collection time (see Trap T-1 — this is the single subtlety that
   makes "drop the duplicate updateDerivedCommands" only *half* true).
3. **INV-3 (per-cascade / point-light culling unchanged).** The light-frustum
   `isVisible(shadowMapCullingVolume, ...)` and per-cascade `isVisible(cascadeVolume, ...)` /
   point-light all-pass logic stay in `insertShadowCastCommands` (they need the shadow-map volumes,
   computed after PVS). Only the *candidate set* they iterate shrinks from full `commandList` to the
   caster sublist.
4. **INV-4 (both backends).** WebGPU and WebGL both consume the same populated
   `passes[].commandList`. The fold is backend-agnostic (it lives in Scene/View, above the split).
5. **INV-5 (zero-work when shadows off).** When `shadowsEnabled` is false, collect nothing (guard the
   collection on `shadowsEnabled`), and the whole path is untouched — no new per-frame cost on the
   default (no-shadow) scene.
6. **INV-6 (conservative).** If a caster's pass is a shadowed pass but its `castShadows` is unknown/
   undefined, treat as today (the `!command.castShadows` guard already handles falsy). No new skips
   of genuine casters.

#### Implementation walkthrough

**Step 1 — hoist `shadowedPasses` to a fast lookup.** Replace the per-call array literal
(`SceneRenderer.js:786-791`) and its `.includes` (`:799`) with a module-scope boolean lookup keyed by
`Pass` enum. In `View.js` (where collection happens) build once at module scope:
```js
const isShadowedPass = []; // indexed by Pass
isShadowedPass[Pass.GLOBE] = true;
isShadowedPass[Pass.CESIUM_3D_TILE] = true;
isShadowedPass[Pass.OPAQUE] = true;
isShadowedPass[Pass.TRANSLUCENT] = true;
```
(Keep a copy or shared export usable by both `View.js` collection and `SceneRenderer.js` if the
latter still needs it — after this fold, `insertShadowCastCommands` no longer needs it at all.)

**Step 2 — collect the caster sublist during the PVS sweep.** In `View.js` add a persistent
`this._shadowCasters = []` (constructor), reset with `this._shadowCasters.length = 0` near the top of
`createPotentiallyVisibleSet` (alongside `computeList.length = 0` at `:215`). Inside the main loop,
in the `else` (non-COMPUTE/OVERLAY) block, after `pass` is known and BEFORE the camera-cull continue,
collect casters — but split by camera visibility to run `updateDerivedCommands` exactly once per
caster (INV-2, Trap T-1):
```js
const isCaster = shadowsEnabled && command.castShadows === true && isShadowedPass[pass] === true;
if (defined(boundingVolume)) {
  if (!scene.isVisible(cullingVolume, command, occluder)) {
    // Camera-invisible. Still a potential shadow caster (INV-1). This is the
    // ONLY build site for its cast derived command (insertIntoBin won't run).
    if (isCaster) {
      scene.updateDerivedCommands(command);   // INV-2
      this._shadowCasters.push(command);
    }
    continue;
  }
  // ... existing visible path (near/far, shadow near/far fit at :273-286) ...
  if (isCaster) {
    this._shadowCasters.push(command); // updateDerivedCommands runs later in insertIntoBin (:524)
  }
}
```
At the end of PVS, publish the sublist where `executeShadowMapCastCommands` can read it. Cleanest
channel: `shadowState` (`frameState.shadowState`, already written by PVS at `:315-317`). Add
`shadowState.casterCommands = this._shadowCasters;` inside the `if (shadowsEnabled)` block at
`:311-318`.

**Step 3 — rewrite `insertShadowCastCommands` to iterate the sublist.**
```js
function insertShadowCastCommands(scene, casters, shadowMap) {
  const { shadowMapCullingVolume, isPointLight, passes } = shadowMap;
  const numberOfPasses = passes.length;
  for (let i = 0; i < casters.length; ++i) {
    const command = casters[i];
    if (!scene.isVisible(shadowMapCullingVolume, command)) continue; // light-frustum cull (INV-3)
    if (isPointLight) {
      for (let k = 0; k < numberOfPasses; ++k) passes[k].commandList.push(command);
    } else if (numberOfPasses === 1) {
      passes[0].commandList.push(command);
    } else {
      let wasVisible = false;
      for (let j = numberOfPasses - 1; j >= 0; --j) {
        if (scene.isVisible(passes[j].cullingVolume, command)) {
          passes[j].commandList.push(command); wasVisible = true;
        } else if (wasVisible) break;
      }
    }
  }
}
```
Gone: the `commandList` full scan, `updateDerivedCommands` (`:795`), `shadowedPasses` literal
(`:786-791`), the `castShadows`/pass re-checks and `.includes` (`:797-803` collapse to the single
light-frustum `isVisible`).

**Step 4 — update the caller** (`executeShadowMapCastCommands`, `:854-864`) to pass the sublist:
```js
const casters = scene.frameState.shadowState.casterCommands;
if (!defined(casters)) return; // PVS didn't run / shadows off mid-frame — conservative no-op
for (let i = 0; i < shadowMaps.length; ++i) {
  const shadowMap = shadowMaps[i];
  if (shadowMap.outOfView) continue;
  const { passes } = shadowMap;
  for (let j = 0; j < passes.length; ++j) passes[j].commandList.length = 0;
  insertShadowCastCommands(scene, casters, shadowMap);
}
```

**Decision point — "revision-maintained sublist".** The task title and S1-2 say "revision-maintained
castShadows sublist." A truly *retained* (rebuilt-only-on-change) sublist depends on a retained
`commandList` above the split, which does NOT exist yet (that is S1-6, an unowned next-campaign
seed). **Do not build a retained-command system here** — that is a different, much larger slice. The
achievable win for C10-10 is the single-sweep fold: collect during the *existing* PVS pass instead of
a *second* per-shadow-map pass. Record "true revision-maintenance blocked on S1-6 retained commandList"
as the follow-up (Principle 9). Ship the fold.

#### Traps

- **T-1 (the "duplicate" `updateDerivedCommands` is NOT a pure duplicate).** S1-2's phrasing "drop
  the duplicate updateDerivedCommands (insertIntoBin already ran it)" is only true for
  **camera-visible** casters. Camera-INVISIBLE casters (culled at `View.js:254`) never reach
  `insertIntoBin`, so `insertShadowCastCommands:795` was their ONLY `updateDerivedCommands` site. If
  you blindly delete it without running `updateDerivedCommands` at collection time for camera-culled
  casters, the WebGL dispatch at `:892` reads `command.derivedCommands.shadows` = undefined →
  crash / lost shadow for every off-screen caster. Step 2 handles this by running
  `updateDerivedCommands` in the camera-invisible branch. **This is the load-bearing subtlety of the
  whole slice — get it wrong and off-camera shadows vanish or crash.**
- **T-2 (globe casters re-dirty every frame).** Globe tile commands set `dirty = true` every frame
  (S1-1, `GlobeSurfaceTileProviderRendering.js`), so `updateDerivedCommands` on a globe caster does
  real clone work, not a cheap dirty-check. To avoid *doubling* that for camera-visible globe casters,
  Step 2 does NOT call `updateDerivedCommands` in the visible branch (it relies on `insertIntoBin`'s
  call at `:524`). Only the invisible branch calls it. Verify you did not add a redundant call in the
  visible path.
- **T-3 (collection order vs `insertIntoBin`).** Camera-visible casters are pushed to the sublist in
  the `:241-309` loop, but their `updateDerivedCommands` runs later in the `:322-324` `insertIntoBin`
  loop. `insertShadowCastCommands` runs AFTER PVS returns (in `executeShadowMapCastCommands`), so by
  then all camera-visible casters have their derived commands. Ordering holds. Do not move
  `insertShadowCastCommands` earlier.
- **T-4 (no-BV casters).** The `else` branches at `View.js:287-298` handle commands without a
  boundingVolume (ClearCommand, worst-case near/far). `castShadows` commands normally have BVs; if a
  no-BV caster exists it would be missed by the BV-only collection. Guard: also collect in the no-BV
  path if `isCaster` (rare; and light-frustum `isVisible` with no BV returns true → added to all
  cascades, matching the old full-scan behavior). Keep it conservative.
- **T-5 (`shadowState.casterCommands` lifetime).** `frameState.shadowState` persists across frames;
  `this._shadowCasters` is reset by length each PVS. Publishing the reference is fine, but ensure a
  frame where `shadowsEnabled` is false does NOT leave a stale `casterCommands` that a later
  mid-frame shadow toggle reads — the `if (!defined(casters)) return;` guard + resetting the array
  each shadowed frame covers it; consider clearing `shadowState.casterCommands = undefined` when
  shadows are off.
- **T-6 (multi-view / 2D wrap double-run).** In SCENE2D wrap frames the frontend runs twice
  (S1-5); each PVS run resets and repopulates `_shadowCasters`, and `insertShadowCastCommands`
  reads the current frameState value — self-consistent per half. No cross-half leakage as long as
  the sublist is reset at PVS entry.

#### Verification recipe

- **V-1 (INV-1, the correctness oracle).** CSM-enabled scene with a caster that leaves the camera
  frustum while still shadowing visible ground (orbit so a building/model exits view but its shadow
  stays). WebGPU (and WebGL) shadow output must be pixel-identical before vs after. **Read the PNGs**
  — the failure mode is a shadow that pops out when the caster leaves view. Templates:
  `probe-csm-soft-shadow.mjs`, `probe-contact-shadows.mjs`.
- **V-2 (INV-2, no crash / no lost cast).** Same scene; assert `csmRenderer._castDispatches > 0`
  (WebGPU) and no console error reading `derivedCommands.shadows`. Confirm off-camera casters still
  appear in `passes[j].commandList`.
- **V-3 (INV-4/INV-5).** Run the default no-shadow moving-altitude route — confirm zero new cost and
  no behavior change (collection guarded on `shadowsEnabled`). Run WebGL and WebGPU shadow scenes;
  both must match their own baselines.
- **V-4 (perf promotion).** Moving-altitude route on a CSM + dense-tiles/models workload (shadows
  on), clean + API-instrumented lanes, ≥5 counterbalanced reps. Named stage: the shadow-cast build
  CPU (instrument `insertShadowCastCommands` / `executeShadowMapCastCommands` via
  `CesiumDebug.cpuPassCost` or a targeted timer) and plane-test count. **Promote if ≥5% p95 on the
  named stage OR >3× noise**, on/off (revert to the full-list `insertShadowCastCommands`) / restored.
  Note: this is scale-dependent (MED impact) — the default benchmark has no casters, so the workload
  MUST carry shadows + many casters or the evidence is empty. If the win is below the bar on the
  chosen scene, record honest-partial with green mechanics (correctness oracles pass) — a truthful
  miss is a valid COMPLETE result.

#### Rollback boundary

The optimization spans `View.js` (caster collection + `_shadowCasters` + `isShadowedPass` +
`shadowState.casterCommands`) and `SceneRenderer.js` (`insertShadowCastCommands` signature + body +
caller). Rolling back = restore `insertShadowCastCommands` to the full-`commandList` scan and remove
the collection code; the two files revert together as one slice. No feature, no shadow contract, no
backend behavior changes — the populated `passes[].commandList` and the derived cast commands are
identical; only *how* the caster set is gathered changes. Tests and counters survive rollback.

#### Pointers

- Evidence: `perfdive/S1-shared-frontend-cpu.md` F2 (deeper mechanics) + deep-dive §1 secondary
  (S1-2). Related: S1-1 (globe re-dirty, Trap T-2 context), S1-5 (2D double-run, Trap T-6).
- PVS sweep: `View.js:193-324`; camera cull `:254`; shadow near/far fit `:273-286`; `insertIntoBin`
  → `updateDerivedCommands` at `:524`.
- Cast build: `SceneRenderer.js:782-824` (fn), `:826-864` (caller/Batch-296 hoist), `:877-896`
  (WebGL dispatch reading `castCommands[i]`).
- Shadow-map update cadence: `ViewportExecutor.js:46-71` (register anchor — re-verify).
- Register: deep-dive §1 secondary highlights; owner "NEW (adjacent FAR CSM lanes)".

---

### Cross-slice notes

- **Anchors verified live this pass (~32 distinct file:line sites opened and confirmed):**
  `WebGPUModelRenderer.ts:5946-6108`, `WebGPUModelFeatureId.js:280-350/490-569`,
  `ModelPBRComplete.wgsl:3446-3473`, `StyleCommandsNeeded.js:1-31`, `Model.js:2179/2360-2386`,
  `ModelDrawCommand.js:110-160/485-687`; `WebGPUPointCloudRenderer.ts:1660-1826`,
  `WebGPUGaussianSplatRenderer.ts:1620-1665`, `WebGPUCloudRenderer.ts:1410-1442`, `Scene.js:1231/3479`;
  `SceneRenderer.js:778-916`, `View.js:193-324/481-525`.
- **Do NOT merge slices.** Three commits, three ledger rows, three on/off/restored oracles. C10-02
  and C10-09 both touch model/collection renderers but on unrelated code paths; C10-10 is
  Scene/View. Keep them separable so a regression in one does not force reverting the others.
- **Adjacency you are deliberately NOT crossing:** C9-17 (model settled-frontend revisions — the
  broader per-primitive frontend churn C10-02 sits next to), C9-25/C9-28 (velocity/RTE rework
  C10-09 is interim for), FAR-200 (private-submit consolidation C10-09 leaves alone), S1-6 (retained
  commandList that true shadow-caster revision-maintenance needs). Name these as the next work
  items where your slice stops (Principle 9); do not silently route around them.


---

<a id="h3"></a>

## C10 GUIDE — Cluster H3: MSAA boundary bytes

### C10-03-MSAA-BOUNDARY-BYTES (W8-3 / `C9-42-MSAA-BOUNDARY-BYTES-CONTAINMENT`)

**Maintainer ruling (2026-07-16) — this is the scope, verbatim intent:**

- **(b) Resolve-elision: RATIFIED, implement unconditionally.** Eager MSAA color resolve happens
  ONLY on segments whose next consumer reads resolved color. Build the consumer-demand map from
  `getColorAttachments` + every resolve site (done below, verified). Reuse `C9-09-ATTACHMENT-DEMAND-REGISTRY`
  work — **it LANDED** (Batch 681; hardened Batch 684 with the measured `slot1AttachmentOpens`/`slot1ResolveOpens` fold; C9 §3.2 row COMPLETE). Step 0 resolves to registry-available. NOTE: the C9-10 topology FLIP did NOT land — `forceSceneMRT` stays `true` and `attachmentDemand(false)` refuses.
- **(d) Auto `msaaSamples=1` when TAA is enabled: RATIFIED** as redundancy elimination, needs a
  visual gate probe. **CRITICAL verified fact: the forcing mechanism ALREADY EXISTS in-tree**
  (Batch 234, `WebGPUSceneRenderer.ts:1402-1411`). Part (d) is therefore verification + gate-probe
  work, NOT new plumbing. Do not reimplement it.
- **(c) Default `msaaSamples` 4→1 flip: EXPLICITLY NOT RATIFIED.** It is a reserve lever only. It
  may be pulled ONLY if the C9-30/C10 default-path performance checkpoint misses target WITH
  bandwidth-attributed evidence, AND a fresh maintainer sign-off is recorded. Do not flip
  `Scene.js:488` in this slice under any circumstances. (Campaign rule: never default-disable or
  degrade a feature for a metric — MSAA-4 default is visual policy.)

Evidence base: register `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` findings **S4-1** (eager
per-segment resolve, ~330 MB/frame waste) and **S4-2** (~1.6 GB/frame boundary-bytes table); raw
stratum `scratchpad/perfdive/S4-pass-bandwidth-topology.md` has the full derivations.

---

#### Architecture today (verified against live tree, HEAD = Batch 675 `457eb162f7`, 2026-07-16)

All file:line anchors below were re-verified by grep/read on the post-Batch-675 tree. Line numbers
drift — re-grep the quoted identifiers before editing; the identifier + shape is the anchor, the
number is a hint.

**MSAA configuration chain:**

- `packages/engine/Source/Scene/Scene.js:488` — `this._msaaSamples = options.msaaSamples ?? 4;`
  → **MSAA 4× is the default** (doc at `:158`, getter/setter `:2951-2957`).
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts:1401-1414` — the bridge in
  `prepareFrame`: `const taaActive = scene.taaEnabled === true; const requestedSamples = taaActive ? 1 : Math.max(1, Math.min(4, scene.msaaSamples ?? 1))`
  → writes `context._msaaSamples`. **This is Batch 234's TAA→1 forcing — part (d) already
  implemented.** `scene.msaaSamples` itself is deliberately untouched, so toggling TAA off restores
  the user's MSAA via drift detection.
- `WebGPUSceneRenderer.ts:1428-1432` — `msaaChanged = this._lastMsaaSamples !== requestedSamples`
  → scene-FB recreate; `:1458-1471` — `_scenePipelineFormatGeneration` bump + render-bundle cache
  wipe on the flip.
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneFramebuffer.ts:325-333` — scene FB =
  `new WebGPURenderTarget(device, { name:"SceneFramebuffer-Color", colorFormats:[colorFormat], depthStencilFormat:"depth24plus-stencil8", sampleCount: numSamples, depthSamplable: true })`.

**The eager-resolve defect (S4-1):**

- `packages/engine/Source/Renderer/WebGPU/WebGPURenderTarget.ts:313-331` —
  `getColorAttachments(clearValues?)` builds each color attachment with `loadOp:"clear"`,
  `storeOp:"store"`, and at `:325-327` **unconditionally** sets
  `descriptor.resolveTarget = this.resolveTargets[index].view` whenever resolve targets exist
  (i.e., whenever `sampleCount > 1`, created at `:178-193`).
- WebGPU executes the multisample resolve at **every `pass.end()`** where `resolveTarget` is set.
- Sibling descriptor builders that also bake `resolveTarget`: `getLoadPassDescriptor()` at
  `:555-586` (resolve at `:562-564`), the `renderPassDescriptor` getter at `:521-527`, and
  `getClearPassDescriptor()` at `:532-550` (both delegate to `getColorAttachments`).

**The three scene-FB pass-open sites (every scene segment goes through one of these):**

1. **Initial redirect open** — `WebGPUSceneRendererPassRedirect.ts:138-211`
   (`setupSceneFramebufferRenderPass`): `getColorAttachments?.([bg])` at `:143`, optional
   BUG-3 `sceneFbLoad` loadOp→"load" remap at `:183-189`, optional MRT slot-1 append at
   `:190-201` (`buildMrtSlot1Attachment`), `context.beginRenderPass(passDesc, "scene-framebuffer")`
   at `:208`.
2. **`_resumeScenePass`** — `WebGPUSceneRenderer.ts:1900-1962`: `getColorAttachments?.()` at
   `:1907-1908`, then a spread-copy remap to `loadOp:"load"` at `:1909-1912` — **note the spread
   copies `resolveTarget` through**, depth+stencil load at `:1913-1920`, MRT slot1 `:1928-1931`,
   `beginRenderPass(passDesc, "scene-framebuffer")` at `:1940`.
3. **`_clearDepthStencil`** — `WebGPUSceneRenderer.ts:1965-2044`: `getColorAttachments?.()` at
   `:1994-1995`, color loadOp→"load" remap `:1996-1999`, depth defaults to clear via
   `getDepthStencilAttachment?.()` at `:2000`, `beginRenderPass(..., "scene-framebuffer")` at `:2016-2019`.

`endCurrentRenderPass()` — `WebGPUContext.ts:2125-2131` — ends the pass and nulls
`_activePassTarget` (C9-07/Batch 675 added `_activePassTarget: WebGPUPassTarget | null` at `:389`;
`beginRenderPass(descriptor, target)` at `:2044+` stamps it at `:2083`; values `"default-canvas"`,
`"scene-framebuffer"`, `"external"`). **This tracking is the natural hook for the dirty flag —
use it.**

**Scene-FB segment boundaries per frame (plain globe, 3 frustums, verified anchors in
`WebGPUSceneRendererFrustumLoop.ts`):**

| Boundary source | anchor | per frame |
|---|---|---|
| Initial redirect open | `PassRedirect.ts:138-211` | 1 |
| Per-frustum depth/stencil clear (incl. i=0) | `FrustumLoop.ts:252` → `_clearDepthStencil` | 3 |
| Per-frustum globe-depth copy (end → pack → resume) | `FrustumLoop.ts:285-291` | 3 |
| `clearGlobeDepth` mid-frustum clear | `FrustumLoop.ts:325` | 0–3 |
| Post-3D-tiles depth update | `FrustumLoop.ts:372-374`, `:422` | 0–3 |
| Post-OPAQUE repack (DP-H45; fires when OPAQUE>0 or VOXELS>0 or clearGlobeDepth) | `FrustumLoop.ts:455-467` | 3 |
| Refraction capture (gated `_sceneHasTransmission`) | `FrustumLoop.ts:573` → `SceneRenderer.ts:2798-2829` | 0–3 |
| Translucent-classification depth capture | `FrustumLoop.ts:634-660` | 0–3 |
| MSAA depth resolve (post-frustum, separate concern — S4-4) | `PostFrustumChain.ts:114-121` | 1 |

→ ~10 scene-FB segments/frame on a plain globe; 13–19 with tiles + classification. **Each segment
end currently performs a full-frame MSAA color resolve. At most 1-2 are consumed.** Post-C9-07 the
API lane measures 18.38 total passes/frame (the two empty canvas opens are gone; scene-FB segment
count unchanged).

**Consumer-demand map — every reader of resolved scene color (verified complete via repo grep of
`getColorTexture(`/`getColorTextureView(`/`colorTexture`/`_sceneColorView` on the scene color
target; `WebGPURenderTarget.getColorTexture/getColorTextureView` at `:388-410` return the RESOLVE
texture/view when MSAA is on):**

| # | Consumer | anchor | gating | when |
|---|---|---|---|---|
| 1 | Refraction capture (`copyTextureToTexture` from `colorTexture`) | `SceneRenderer.ts:2819` → `WebGPUSceneFramebuffer.ts:193-217` (`:199` reads `this.colorTexture` = `:222-224`) | `context._sceneHasTransmission` | per frustum, mid-frame |
| 2 | OIT composite (writes INTO `_sceneColorView`) | `WebGPUSceneRendererTranslucentPass.ts:261-269` | `useOIT && _webgpuOITEnabled` (default **false**) | per frustum, mid-frame |
| 3 | InvertClassification composite (reads/writes resolve view; stencil path also reads the MSAA attachment view) | `SceneRenderer.ts:2688-2767` (`resolveView` at `:2724-2725`, MSAA attachment at `:2738-2745`) | `config.useInvertClassification` + ready | post-frustum |
| 4 | Bounding-volume debug pass (draws into resolved view) | `PostFrustumChain.ts:185`, `WebGPUBoundingVolumeDebugPass.ts:26` | per-command `debugShowBoundingVolume` | post-frustum |
| 5 | **Post-process input** (`context._sceneColorView`) | set `EnsureResources.ts:289-290`; consumed by `_runPostProcessing` at `PostFrustumChain.ts:200` | **ALWAYS** (WebGPU requires the PP blit) | post-frustum, final |
| 6 | Env effects sample `_sceneColorView` | `WebGPUSceneRendererEnvironmentalEffects.ts:179` | all env effects default-off | after PP |
| 7 | Debug overlays / readbacks | `SceneRenderer.ts:3114/:3395/:3504`, `WebGPUContext.ts:2972/:3431-3432` | debug only | late |

**Default frame → exactly ONE required scene-COLOR resolve (before post-process). Today's frame performs ~10 scene-color resolves.** **Oracle correction (2026-07-17 verify pass, brief-breaking):** the shipped default ALSO bakes an MRT slot-1 G-buffer `resolveTarget` into every scene-FB open (`buildMrtSlot1Attachment` spreads `resolveTarget: gb.resolveTargetView`; `forceSceneMRT` default-true; CONFIRMED measured by C9-09's `slot1ResolveOpens > 0`, Batch 681). A raw resolve-bearing-attachment counter therefore reads **~20 pre / ~11 post**, not 10→1 — the acceptance counter MUST bucket by attachment: **scene-COLOR resolves 10→exactly 1**; slot-1 resolves out of scope and unchanged (slot-1 gating is C9-10/MRT-demand territory, forbidden as a side effect here). The S4-2 bytes table below carries no slot-1 store/load/resolve rows, so its boundary figure is understated for the shipped MRT-on default.

**Bytes-per-frame budget @1920×1080 SDR MSAA4, 3 frustums, plain globe (S4-2, corrected
post-C9-07):**

| Traffic item | bytes each | count | MB/frame |
|---|---|---|---|
| MSAA color store at segment end (4 samples × 4 B × 2.07 Mpx) | 33.2 MB | 10 | 332 |
| MSAA color load at segment resume (`loadOp:"load"`) | 33.2 MB | 9 | 299 |
| Per-segment eager resolve write (S4-1; the read is counted above) | 8.3 MB | 10 | 83 |
| Depth+stencil store (D24S8@4×, `depthSamplable:true` forces store) | 41.5 MB | 10 | 415 |
| Depth+stencil load at resume | 41.5 MB | 9 | 373 |
| Globe-depth RGBA8 pack passes (S4-5) | 16.6 MB | 6 | 100 |
| MSAA depth resolve pass (S4-4) | ~12 MB | 1 | 12 |
| Post-process identity blit (S4-6) | 16.6 MB | 1 | 17 |
| Canvas pass store (PP blit output; C9-07 removed the two EMPTY canvas opens, not this) | 8.3 MB | 1 | 8 |
| **Total (raw, uncompressed)** | | | **≈ 1,640 MB/frame** |

At 30 fps ≈ 49 GB/s of attachment traffic; WebGL's comparable frame budgets ~150–250 MB (one
resolve, in-pass clears) → **7–10× structural disadvantage**. Scales ~quadratically with
resolution (~6.6 GB/frame at 4K). **This slice removes the eager-resolve line (~330 MB/frame:
~8 wasted resolves × (33.2 read + 8.3 write)) plus the resolve-read share embedded in the
store/load rows — it does NOT touch the segment count (FAR-405/706) or depth store/load
(S4-2 fix-directions 3/4, separate slices).** Quantify and report this accounting in the batch
evidence (analytical table + measured resolve-pass counts, below).

---

#### Target design + invariants

**Design: demand-driven resolve with dirty tracking ("resolve-on-consume").** All scene-FB
segments open WITHOUT `resolveTarget`; a helper performs a zero-draw resolve-only pass exactly
when a consumer is about to read resolved color and the resolve is stale.

Rejected alternative (predict-at-open): passing "will my segment end at a consumer?" into each
open site is unknowable — consumers (`_captureRefractionScene`, invert composite, PP) end the pass
themselves, and `resolveTarget` must be baked at `beginRenderPass` time. Don't attempt it.

**Invariants (encode these as acceptance):**

- **I1 — No eager resolve on scene segments.** `getColorAttachments` gains
  `options?: { resolve?: boolean }` with **default `true`** (behavior-preserving for every caller
  not explicitly migrated). The three scene-FB open sites pass `resolve:false`. In
  `_resumeScenePass`, additionally ensure the spread-copy at `SceneRenderer.ts:1909-1912` does not
  reintroduce `resolveTarget` (with `resolve:false` upstream nothing is copied; do not rely on
  deleting it in the map).
- **I2 — Every resolved-color reader is preceded by `ensureSceneColorResolved`.** The enumerated
  consumer set is rows 1–7 of the demand map. A reader may skip the call only if it provably runs
  after another ensure with no intervening scene-FB segment end.
- **I3 — The demand resolve is a zero-draw pass:** exactly one color attachment
  `{ view: <MSAA attachment view>, loadOp:"load", storeOp:"store", resolveTarget: <resolve view> }`,
  NO depth-stencil attachment, NO MRT slot-1. (A pass with zero draws has no pipeline-compat
  constraints; `storeOp:"store"` is mandatory because later segments resume with color
  `loadOp:"load"` — `"discard"` would destroy accumulated scene color.)
- **I4 — Dirty tracking is context-owned and conservative.** Flag set `true` in
  `endCurrentRenderPass()` (and every other site that ends the pass encoder and nulls
  `_activePassTarget`) when `_activePassTarget === "scene-framebuffer"`; cleared only by the
  ensure helper; reset to `true` (conservative) at frame begin, device loss, scene-FB recreate,
  and msaa/HDR flips. Unknown demand stays conservative: when in doubt, resolve.
- **I5 — `msaaSamples === 1` is inert and byte-identical.** No resolve targets exist
  (`WebGPURenderTarget.ts:178`), `getColorTextureView` returns the attachment view (`:403-410`),
  ensure() returns immediately. The off-path must be byte-identical by construction.
- **I6 — No feature removed, default-disabled, bypassed, or visually degraded.** Refraction, OIT,
  invert classification, BV debug, post-process, env effects, and debug overlays produce the same
  pixels — the resolve content is identical, only its production time moves.
- **I7 — Part (d) contract preserved:** TAA-on forces effective samples to 1
  (`WebGPUSceneRenderer.ts:1402-1411`); `scene.msaaSamples` is never mutated; TAA-off restores the
  user value via `msaaChanged` drift detection + bundle wipe + generation bump (`:1428-1432`,
  `:1458-1471`).
- **I8 — Option (c) untouched:** `Scene.js:488` default stays `4`. The reserve lever is
  documentation only.
- **I9 — RTE/shader surface untouched:** no WGSL changes, no `ShaderDefine` additions, no pipeline
  descriptor changes (sample counts, formats). This slice is pass-descriptor plumbing only.

---

#### Implementation walkthrough

**Step 0 — Ledger check (decision point).** Read `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md`
§3.2. **RESOLVED at HEAD (2026-07-17 verify pass): `C9-09-ATTACHMENT-DEMAND-REGISTRY` LANDED**
(Batch 681, hardened Batch 684) — the demand record IS the owner: register "resolved scene color"
as a consumer-declared attachment demand and drive `resolve` + the ensure calls from
`computeAttachmentDemand` / `context._attachmentDemand`; keep the same invariants. The local
dirty-flag design below is FALLBACK-ONLY documentation (do not implement it first; it applies only
if the registry regresses before execution). Also check whether `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` (ledger row, NOT
STARTED as of 2026-07-16) has landed — it affects what you may observe in part (d) verification
(see Traps).

**Step 1 — `WebGPURenderTarget.getColorAttachments` parameter.** Add
`options?: { resolve?: boolean }` (default `true`). When `resolve === false`, skip the
`:325-327` resolveTarget assignment. Do NOT change `getLoadPassDescriptor` /
`renderPassDescriptor` / `getClearPassDescriptor` semantics (their only MSAA caller today is the
scene FB via uncalled scaffolding — `WebGPUGlobeDepth.ts:213/:403` targets are single-sample so
`resolveTargets` is empty; leave them, per Principle 7 do not "clean up" the scaffolding).

**Step 2 — New method on `WebGPURenderTarget`:**
`createColorResolvePassDescriptor(): GPURenderPassDescriptor | null` — returns `null` when
`resolveTargets.length === 0`; otherwise the I3 descriptor built from `colorAttachments[0].view` +
`resolveTargets[0].view` (label it e.g. `"SceneFramebuffer-Color_demand_resolve"` so lanes can
count it). Scene FB is single-color-target (MRT slot-1 lives outside `WebGPURenderTarget` — see
`buildMrtSlot1Attachment`), so index 0 only is correct; assert/skip if
`colorAttachments.length > 1` to stay conservative for other users.

**Step 3 — Ensure helper.** On `WebGPUSceneRenderer` (it owns `_sceneFramebuffer` and receives
`context` everywhere):

```
public _ensureSceneColorResolved(context: WebGPUContext): void
```

Logic: if `context._msaaSamples <= 1` → return. If the context dirty flag is `false` → return.
`context.endCurrentRenderPass?.()` (consumers already do this — keep the call idempotent), get
`context._currentCommandEncoder`; if absent → return (leave dirty). Get the descriptor from
Step 2; `encoder.beginRenderPass(desc).end()` **raw on the encoder** (do NOT route through
`context.beginRenderPass` — no draws, no context pass-state involvement; mirror the
`_clearTarget` pattern at `WebGPUSceneFramebuffer.ts:390-400`). Clear the dirty flag.

**Step 4 — Dirty flag on `WebGPUContext`.** `_sceneColorResolvePending = true` (start
conservative). Set `true` inside `endCurrentRenderPass()` (`:2125-2131`) when
`this._activePassTarget === "scene-framebuffer"` **before** nulling it. Audit every OTHER site
that ends `_currentRenderPassEncoder` and nulls `_activePassTarget` (grep `_activePassTarget = null`
— ~12 sites incl. `:1799, :1888, :1939, :2157, :2286, :2308, :2962, :3415`): each must set the
flag when the target was `"scene-framebuffer"`, or simply set it unconditionally at those
recovery/teardown sites (conservative per I4). Reset to `true` at frame begin and on scene-FB
recreate (`msaaChanged`/`hdrChanged` branch, `SceneRenderer.ts:1437-1450`).

**Step 5 — Flip the three open sites to `resolve:false`** (`PassRedirect.ts:143`,
`SceneRenderer.ts:1908`, `SceneRenderer.ts:1995`). The fourth `getColorAttachments` caller —
invert composite's MSAA-attachment-view read at `SceneRenderer.ts:2739-2740` — only plucks
`[0].view` and never builds a pass from it; the default `resolve:true` there is harmless. Leave it.

**Step 6 — Insert ensure calls (one per consumer row):**
1. `_captureRefractionScene` (`SceneRenderer.ts:2798`) — after the transmission gate, before
   `captureRefraction` (i.e., replace/augment the `endCurrentRenderPass` at `:2808` with
   `this._ensureSceneColorResolved(context)`).
2. OIT composite (`TranslucentPass.ts:261-269`) — before `host._oit.executeComposite(...)`; call
   via the host (add to the host interface like `_resumeScenePass` was, Batch 140 pattern).
3. `_runInvertClassificationComposite` (`SceneRenderer.ts:2719`) — the existing
   `endCurrentRenderPass` there becomes ensure (it exists precisely to force the resolve — the
   comment at `:2715-2718` says so).
4. BV debug pass entry (`PostFrustumChain.ts:185` → inside `_executeBoundingVolumeDebugPass`,
   only when it will actually draw).
5. Before `host._runPostProcessing(config)` (`PostFrustumChain.ts:200`) — **the always-on one**.
6. Debug overlays (`SceneRenderer.ts:3114/:3395/:3504`) and `readPixels`-family readers that can
   see the scene FB (`WebGPUContext.ts:2972/:3431`) — add ensure where the scene color target is
   the source. Depth/frustum overlays already require MSAA-off (`:3233-3243`, `:3395+`) — for
   those the ensure is a no-op by I5; add it anyway for uniformity where the resolve view is read.

**Decision point:** if you find a resolved-color reader NOT in the demand map (grep
`getColorTexture\(|getColorTextureView\(|\.colorTexture\b|_sceneColorView` under
`packages/engine/Source/Renderer/WebGPU/` + `Scene/` and diff against rows 1–7) — STOP and add it
to the map + an ensure call; if its read timing is unclear (e.g., an async path), leave that
segment's eager resolve in place for that configuration and ledger the follow-up. Unknown demand
stays conservative.

**Step 7 — Writers to the resolve view (ordering hazard).** Invert composite (fallback path) and
BV debug WRITE the resolve view; OIT composite writes it per frustum. After such a write, a later
ensure would overwrite their output with re-resolved MSAA content **only if** a scene-FB segment
ended in between (dirty re-set). Verify orderings: invert composite and BV debug run post-frustum
with no subsequent scene-FB segment before PP → the pre-PP ensure sees `dirty === false` and
no-ops → their writes survive (same as today). OIT composite mid-frame: the next frustum's
segments re-dirty and the next ensure re-resolves — **which stomps the composite exactly as
today's eager per-segment resolve already does**; MSAA×OIT compositing is a pre-existing FAR-003
adjacency, NOT this slice's concern. Do not fix it here; record it in DEFERRED_WORK if not already
ledgered (one concern per slice).

**Step 8 — Part (d) verification work.** No plumbing. Confirm `WebGPUSceneRenderer.ts:1402-1411`
forcing is intact (if a concurrent C9 slice removed/moved it — STOP and re-implement at the bridge
with the same "never mutate `scene.msaaSamples`" contract). Extend or add the visual gate probe
(below) asserting: (i) with `scene.msaaSamples===4` and `taaEnabled=true`, effective
`context._msaaSamples===1` and zero validation errors; (ii) TAA off restores effective 4
(FB recreate + bundle wipe path) and the frame still renders; (iii) `probe-taa-jitter.mjs` GATE
still PASS.

**Step 9 — Docs.** Update `migration_doc/DEFERRED_WORK.md` / FAR ledger (FAR-405 companion) with:
elision landed, option (c) reserve-lever status + its exact trigger condition, OIT×MSAA ordering
note. FEATURE_INVENTORY: no §B/§C moves needed (no feature surface change) unless you added the
probe (tooling entries).

---

#### Traps (an expert would catch these; you must not learn them the hard way)

1. **`storeOp:"discard"` on the demand-resolve pass destroys the frame.** The MSAA attachment is
   reloaded by every subsequent segment (`loadOp:"load"`). Discard is legal WebGPU with a
   resolveTarget and looks like a bandwidth win — it is only safe on a provably-final segment,
   which this slice does not track. Always `"store"` (I3).
2. **Do NOT default the new `resolve` option to `false`.** `getClearPassDescriptor` /
   `renderPassDescriptor` / `getLoadPassDescriptor` and any future `WebGPURenderTarget` user would
   silently lose their resolve. Default `true`; migrate exactly the three scene open sites.
3. **The `_resumeScenePass` spread copies `resolveTarget`** (`SceneRenderer.ts:1909-1912`). If you
   only edit `getColorAttachments` call sites 1 and 3 you'll leave 9 of the 10 eager resolves in
   place via site 2 — the structural oracle (resolve-pass count) will catch this; don't skip it.
4. **The pre-PP ensure is load-bearing for the entire canvas.** WebGPU REQUIRES the PP blit
   (CLAUDE.md); PP reads `_sceneColorView` = the resolve view (`EnsureResources.ts:289-290`).
   Miss that ensure and every MSAA frame is black. This is the first thing to check if the probe
   shows a black canvas: was the ensure inserted before `PostFrustumChain.ts:200`?
5. **Never route the resolve-only pass through `context.beginRenderPass`.** It would stamp
   `_activePassTarget`, interact with C9-07's demand-open canvas logic and the `clear()`
   target-inference, and re-dirty bookkeeping. Raw `encoder.beginRenderPass(desc).end()` only.
6. **Dirty-flag lifetime across device loss / recreate.** The scene FB is recreated on
   resize/HDR/msaa flips (`SceneRenderer.ts:1437-1450`) and the old resolve texture is destroyed
   (`WebGPUSceneFramebuffer.ts:302`). A stale `false` flag after recreate → PP reads an
   uninitialized resolve texture (black or garbage frame). Reset conservative (`true`) on every
   recreate/loss path (I4).
7. **`context._sceneColorView` identity vs content.** EnsureResources captures the view reference
   once per frame prep (`:289-290`); the ensure pass updates CONTENT of the same texture — view
   identity is stable, bind groups keyed on the view stay valid. Do not "helpfully" recreate views
   in the ensure helper; you'd churn every bind group keyed on it.
8. **Part (d) flip race is a KNOWN, separately-owned bug.** Toggling TAA on/off flips effective
   samples 4↔1 and can surface `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` (C9 ledger row,
   2026-07-16: stale baked `multisample.count` for 1–2 frames → "Attachment state ... not
   compatible" + invalid command buffer; race hops renderers — Voxel color, GroundPrimitive).
   If your TAA gate probe sees those errors on the flip frame: stash-attribute (re-run with your
   diff stashed); if byte-identical pre-change, record it against that ledger row and do NOT fix
   it in this slice. If it's NEW with your change — your generation-bump/bundle-wipe path broke;
   stop and fix.
9. **The invert-composite stencil path resolves its own pass.** The MSAA-sample-count composite
   (`SceneRenderer.ts:2727-2745` → `executeInvertClassificationComposite`) draws to the MSAA
   attachment and auto-resolves at its own pass end (comment `:2716-2717`). Verify (grep the
   composite implementation for `resolveTarget`) whether that pass carries its own resolve; if it
   does, it should CLEAR the dirty flag (or leave dirty=true harmlessly — one redundant re-resolve
   before PP; acceptable, note it). If it doesn't, the pre-PP ensure covers it. Either way pixels
   are correct; only the count oracle expectation shifts by 1 on invert scenes.
10. **`WebGPUFramebufferManager` vs `WebGPURenderTarget` are different classes.** The
    transient/discard discipline that already exists in `WebGPUFramebufferManager.ts:285-297,378-389`
    is NOT the scene FB path. Do not refactor the scene FB onto it in this slice (that's S4-3's
    usage-flags companion work, a different row). One concern per slice.
11. **Don't touch `Scene.js` MSAA defaults, ever, in this slice** (I8). Even "just for the perf
    lane" — the lane must measure the shipped default. Probes may set `msaaSamples`/`taaEnabled`
    per scenario via the API; the engine default stays 4.
12. **Uncalled scaffolding stays.** `WebGPUSceneFramebuffer.clear()` (`:349-364`) and the
    `idFramebuffer` getter (`:264-266`) call eager-resolve descriptor builders but are uncalled in
    the WebGPU path (S4-7). Principle 7: leave them; do not delete or "fix" them here.
13. **Boundary-bytes table honesty.** The 1.64 GB figure is a raw uncompressed budget from code
    structure, not a measurement; framebuffer compression reduces real traffic by an unknown
    driver-dependent factor. Report the elision win the same way: analytically (~330 MB/frame
    @1080p default globe = 8 × 41.5 MB) PLUS the measured resolve-pass count delta and measured
    GPU/CPU timings. Never present the MB figure as a measured result.

---

#### Verification recipe

Prereqs: `npx tsc --noEmit` clean, `npx gulp build` clean, `node server.js --production` running.
Node/Playwright/Edge only (no Firefox — no WebGPU; no Python tooling).

**1. Structural oracle (the elision's primary acceptance — count resolve-bearing passes).**
Write `Tools/visual-regression/probe-msaa-resolve-elision.mjs` (template:
`probe-demand-canvas-pass.mjs` for pre/post + byte-identity mechanics; `probe-saved-view.mjs` for
the diff harness). In-page, wrap pass creation before viewer boot:

```js
const origBegin = GPUCommandEncoder.prototype.beginRenderPass;
GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
  const n = [...(desc.colorAttachments ?? [])].filter(a => a && a.resolveTarget).length;
  if (n > 0) { window.__resolvePassCount = (window.__resolvePassCount ?? 0) + n;
               (window.__resolveLabels ??= []).push(desc.label ?? "?"); }
  return origBegin.call(this, desc);
};
```

Count per settled frame (reset counter, `scene.requestRender()`, read after `postRender`).
**Pass criteria** (default globe, `renderer=webgpu&offline=true`, MSAA4, settled):
PRE-change ≈ one resolve per scene segment (~10; record exact); POST-change **exactly 1**
(the pre-PP demand resolve, label `SceneFramebuffer-Color_demand_resolve`). With
`useInvertClassification` scenario: ≤ 3 (demand + composite's own + at most one redundancy, per
Trap 9 — record exact and explain). MSAA1: **0** on both trees. Persist counts into the probe's
JSON artifact — this is the boundary-bytes accounting evidence (bytes = counts × the table's
per-item costs at the measured canvas size).

**2. Byte-identity / visual gates (I6).** Same probe, frozen-clock captures, pre-change vs
post-change on the SAME scene (build once per tree; stash-swap like C9-07 did):
- default globe MSAA4 SDR: post-change canvas byte-identical (0 mismatch px) to pre-change;
- MSAA1: byte-identical trivially (I5 — any diff here means you broke a default path, stop);
- HDR flip mid-run (scene.highDynamicRange=true→false): renders, 0 device errors;
- resize mid-run: renders, 0 device errors;
- invertClassification scenario (Sandcastle invert-classification setup or tiles asset if offline
  allows — **decision point:** if no offline asset reachable, gate on the composite running with
  0 validation errors + non-black output + the count oracle, and say so in the artifact);
- transmission scenario for row-1: a KHR_materials_transmission glTF if available offline;
  otherwise force `context._sceneHasTransmission = true` for a frame (synthetic) and assert the
  capture path runs 0-error with the ensure ordering (record which lane you used).
- **TAA gate (part d):** `scene.msaaSamples=4; scene.taaEnabled=true` → assert
  `context._msaaSamples===1` (via `CesiumDebug.context`), frame renders, 0 validation errors;
  toggle off → effective 4 restored, renders. Then run the standing
  `node Tools/visual-regression/probe-taa-jitter.mjs` → expect "GATE PASS" line (`:146`).
  Apply Trap 8 attribution if flip-frame validation errors appear.

**3. Regression suite** (all `PROBE_BASE=http://localhost:8080` where applicable):
`capture-and-diff.mjs` — expect the same 6/7 green as the C9-07 baseline (cross-backend 0.45–1.04%
< 2%); `high-density-5k-spheres` red is PRE-EXISTING (`NEW-HIGH-DENSITY-SPHERES-CROSS-BACKEND-DRIFT`
ledger row) — stash-attribute if its numbers move from 8.69%/92%. `probe-demand-canvas-pass.mjs`
(C9-07's gate — your changes touch the same pass plumbing), `probe-2d-globe-render` (BUG-3
sceneFbLoad halves), `probe-collections-regression`, `probe-point-pick-webgpu`.
`probe-pickposition-webgpu` red is PRE-EXISTING (`NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION`)
— attribution only. **Read the output PNGs yourself** (CLAUDE.md Principle 8) — count deltas
prove structure, only pixels prove no artifact.

**4. Performance evidence (the ONLY valid perf lanes — moving-altitude track):**

```powershell
node Tools/visual-regression/run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --renderer both --repetitions 2 --output Tools/visual-regression/output/performance/c10-03-clean.json
node Tools/visual-regression/run-performance-campaign.mjs --workload moving-camera-altitude-track-3d --renderer both --repetitions 2 --api-instrumentation --output Tools/visual-regression/output/performance/c10-03-api.json
```

Never mix timing between the lanes. Primary metrics: `Scene.render()` CPU p95 + capability-backed
GPU timestamps (`CesiumDebug.gpuPassCost`). **Honest expectation:** the elision is a GPU-bandwidth
win encoded in pass-end; CPU p95 should be flat (any CPU regression is a defect); GPU frame time
may improve by ~1 ms-class @1080p on a dGPU and can sit under noise on strong hardware. The
maintainer ruling ratifies (b) as redundancy elimination independent of the ≥5%/>3×-noise
promotion bar, but you still ship on/off/restored oracles: on = post-change, off = `msaaSamples=1`
lane, restored = stash-swap pre-change re-run; report deltas with noise honestly, no cherry-picked
claims. Record run artifacts under `Tools/visual-regression/output/performance/` and cite them in
the batch message + C10 queue ledger row.

**What "pass" means overall:** count oracle exact (1 resolve/frame default), byte-identity 0 px on
default scenarios, all named regression gates at their pre-change status (greens green, ledgered
reds byte-identical-red), TAA gate PASS, tsc+build clean, moving route completes all 8 segments
0 page/device errors both backends.

---

#### Rollback boundary

- **One commit, engine-only, no persisted state, no shader/WGSL changes, no `ShaderDefine`
  entries, no pipeline-descriptor changes** → `git revert <batch-commit>` fully restores eager
  per-segment resolve. Nothing else depends on the new `resolve` option (default `true` keeps all
  unmigrated callers byte-identical), the ensure helper, or the dirty flag.
- Files inside the boundary: `WebGPURenderTarget.ts`, `WebGPUSceneRenderer.ts`,
  `WebGPUSceneRendererPassRedirect.ts`, `WebGPUSceneRendererPostFrustumChain.ts`,
  `WebGPUSceneRendererTranslucentPass.ts` (host-interface addition), `WebGPUContext.ts`
  (flag + end-site hooks), the new probe, and doc updates. If the diff wants to grow past that
  set (e.g., into `WebGPUFramebufferManager`, `Scene.js`, any WGSL, or the FrustumLoop pass
  ordering) — STOP; you've left the slice.
- Runtime kill switch consideration: none needed — behavior is structurally equivalent
  (`msaaSamples=1` remains the user-facing no-MSAA switch; TAA forcing already documented).
  If the audit demands one, a context bool defaulting to elision-on with eager fallback is
  acceptable, but prefer the clean revert boundary.
- Part (d) is zero-diff (verification + probe only); its rollback is deleting the probe.
- Reserve lever (c): NOT in this commit, by ruling. If later pulled, it is its own one-line slice
  (`Scene.js:488` backend-conditional default or bridge-side default) + release note + maintainer
  sign-off recorded in the queue ledger — never fold it into a revert-sensitive batch.

#### Pointers

- Register rows: `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` — top-table row 3, S4-1
  (`:371-382`), S4-2 (`:384-401`); proposed-owner notes reference `C9-35`/`C9-42` (same work, W8-3).
- Raw stratum with full byte math + the "explicitly checked clean" list:
  `scratchpad/perfdive/S4-pass-bandwidth-topology.md`.
- Queue vocabulary + gates: `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` (W8-3 row `:344`; §3.2
  ledger for C9-07 COMPLETE details — its acceptance write-up is the model for yours).
- Mechanics exemplar: `migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md`.
- Perf lane protocol: `migration_doc/DEBUGGING_GUIDE.md:1090` (canonical moving-altitude campaign)
  + `FORK_PERFORMANCE_AUDIT_AND_FIX_RESULTS_2026-07-14.md` (claim-boundary discipline).
- Adjacent-but-NOT-this-slice rows (do not scope-creep into them): S4-3 usage-flags/transient
  (MED-HIGH companion), S4-4 depth-resolve consumer gating, S4-5 globe-depth pack chain, FAR-405/706
  segment-count reduction, FAR-003 OIT×MSAA, C9-09/C9-10 attachment/MRT demand.

---

#### Campaign-10 queue rows

| # | ID | Pri | Effort | Work / acceptance |
| --- | --- | --- | --- | --- |
| C10-03 | `C10-03-MSAA-BOUNDARY-BYTES` (W8-3 / C9-42; maintainer-ratified (b)+(d) 2026-07-16) | P1 | M | Demand-driven MSAA color resolve for the scene FB: `getColorAttachments` gains `resolve` option (default true), the three scene-FB open sites (`PassRedirect.ts:143`, `_resumeScenePass`, `_clearDepthStencil`) pass false, context dirty flag keyed on C9-07's `_activePassTarget==="scene-framebuffer"`, zero-draw load/store/resolveTarget ensure pass before every resolved-color consumer (refraction capture, OIT composite, invert-class composite, BV debug, pre-post-process ALWAYS, debug/readback). Reuse C9-09 demand registry if landed; else local flag marked as fold-in. Acceptance: scene-COLOR resolve-bearing passes/frame 10→exactly 1 on default globe (in-page beginRenderPass counter BUCKETED per attachment — MRT slot-1 G-buffer resolves are out of scope and stay unchanged; raw unbucketed counts read ~20→~11; JSON artifact), MSAA1 = 0 and byte-identical, default MSAA4 canvas byte-identical pre/post (0 px, frozen clock), HDR/resize/invert/transmission scenarios 0 device errors, capture-and-diff at C9-07 baseline status, moving-altitude clean+API lanes both backends all 8 segments with on/off/restored reporting (CPU p95 flat; GPU delta reported honestly vs noise), analytical ~330 MB/frame @1080p elision accounting cited from the S4-2 table. PLUS part (d) verification: Batch 234 TAA→samples-1 forcing intact (`WebGPUSceneRenderer.ts:1402-1411`), gate probe asserts effective 1 under taaEnabled + restore-on-off, `probe-taa-jitter` GATE PASS; flip-frame validation errors stash-attributed to `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` if pre-existing. No WGSL/ShaderDefine/pipeline changes; single-commit revert boundary. |
| C10-03R | `C10-03R-MSAA-DEFAULT-FLIP-RESERVE` (option (c) — **NOT RATIFIED**) | P4/gated | S | RESERVE LEVER, do not execute without BOTH: (1) the C9-30/C10 default-path checkpoint misses its whole-route/near-ground targets WITH bandwidth-attributed evidence (GPU timestamp + counter data implicating attachment traffic, not CPU), and (2) fresh maintainer sign-off recorded in the queue ledger. Work if triggered: backend-conditional WebGPU default `msaaSamples` 4→1 (one line at the `Scene.js:488`/bridge boundary, WebGL default untouched, user opt-in fully preserved) + release note + visual-policy gate probe (MSAA4 opt-in byte-path proven live) + moving-altitude on/off/restored evidence. Until triggered this row is documentation; any slice found flipping the default without the recorded sign-off is reverted on sight. |


---

<a id="h4"></a>

## C10 Cluster H4 — Resource / Bandwidth

Two independent slices. **One concern per slice — do not co-mingle their commits.**

- **C10-04-SPLAT-ASYNC-SORT** (queue W8-4 / C9-43; register S6-1 = S11-2, FAR-003/503 adjacency)
- **C10-05-MODEL-TEXTURE-MIP-CHAIN** (queue W8-5 / C9-44; register S3-1)

All anchors below were re-grepped against the live tree post-Batch-674 (2026-07-16). Line numbers are
verified against the files as they stand today; if a future batch shifts them, re-grep the named symbol
(every anchor cites a greppable symbol, never a bare number).

Campaign rules that gate acceptance for BOTH slices:
- Never remove / default-disable / visually degrade a feature to win a metric. The splat sort must keep
  producing correct back-to-front order; the mip chain must be byte-identical for magnified texels.
- RTE stays intact — no absolute planetary ECEF `f32` pre-subtraction anywhere you touch.
- Node/Playwright/Edge only. The moving-altitude track is the only *promotion* perf evidence, but note it
  carries no splat/model content by default (see each Verification section for the content lane you must add).
- Promotion needs ≥5% named-stage p95 **or** >3× noise, proven with on/off/restored oracles. Splat's win is
  a discrete main-thread hitch (measure long-task elimination, not average FPS); model's win is GPU sample
  bandwidth (measure GPU timestamp on a distant tileset).

---

### C10-04-SPLAT-ASYNC-SORT

#### Architecture today (verified)

The WebGPU Gaussian-splat feature renderer runs a **synchronous main-thread comparator sort inside the
render loop**. WebGL runs the identical job off-thread through a WASM radix worker that already ships in the
bundle. The WebGPU renderer never touches that worker.

Dispatch split (why WebGPU has its own sort at all):
- `packages/engine/Source/Scene/GaussianSplatPrimitive.js:1186` `update(frameState)` — resolves the
  feature renderer; if a WebGPU FR is ready it calls `fr.update(this, frameState)` and **returns at
  `:1197`**. Everything below that (the worker orchestration `shouldStartSteadySort` /
  `GaussianSplatSorter.radixSortIndexes` / `resolveSteadySort`, `:1589-1657`) is the **WebGL-only** path.
  So under WebGPU the worker never runs and the FR must order splats itself.

WebGPU main-thread sort:
- `packages/engine/Source/Renderer/WebGPU/WebGPUGaussianSplatRenderer.ts:906` `maybeSortSplats(device,
  primitive, frameState, cache)`.
  - Throttle: `:927-935` — re-sorts only when the view direction has rotated past
    `SORT_MIN_ANGLE_COS = cos(0.008726646)` (0.5°) since `cache.lastSortCameraDir`, unless
    `cache.sortRequestPending` forces it. **Angle-only** — no position-delta and no min-frame-interval
    (WebGL has all three; see Traps).
  - Depth key build: `:963-970` — allocates a **fresh `new Float64Array(count)` every sort** and computes
    eye-space z per splat from the interleaved 64-byte record (`posHigh + posLow`, layout comment `:960-962`).
  - Sort: `:974-977` — `Array.prototype.sort.call(indices, (a,b) => depth[a]-depth[b])` — a JS callback
    comparator, O(n·log n) *callbacks*.
  - Upload: `:979` — `device.queue.writeBuffer(cache.sortedIndexBuffer, 0, indices)` — full count×4 B
    re-upload of the permutation.
  - Called every frame at `:1300` inside `updateWebGPUGaussianSplats`, after bind-group (re)build.
- Cost at 1 M splats: ~20–40 M comparator invocations per re-sort (~300–1000 ms+ main-thread stall, up to
  1–4 s on slow hardware), + 8 MB Float64 alloc, re-fired continuously during orbit. 100 K still ~100–300 ms.
  This is the "WebGPU 30 fps while WebGL coasts" shape — actually per-rotation *hitches*, worse than an fps cap.
- Secondary cost: the full 64 B/splat CPU `cache.splatData` mirror is retained permanently (64 MB at 1 M)
  **solely** to feed this sort (it is the only reader of positions on the CPU side).

The unused scaffolding that already exists to receive an async result:
- `cache.sortRequestPending: boolean` — declared `WebGPUGaussianSplatRenderer.ts:80`, init `false` at
  `:1018`, cleared at `:986`; **no producer ever sets it true**. This is the "async sort in flight" flag the
  worker path is meant to fill.
- `cache.sortIndices: Uint32Array | null` (`:77`, comment `:75-76`) — reusable CPU permutation staging.
- `cache.lastSortCameraDir: Cartesian3 | null` (`:79`) — pose at last sort.
- `cache.sortedIndexBuffer: GPUBuffer` (`:73`) — the on-GPU permutation the VS reads via
  `sortedIndices[instance_index]` (binding 2; WGSL `SplatRecord` struct + indirection documented `:118-138`).
  Allocated/identity-seeded on count change at `:1256-1268`.

The WebGL worker asset (already in the bundle):
- `packages/engine/Source/Scene/GaussianSplatSorter.js:58` `radixSortIndexes({ primitive: { positions,
  modelView, count }, sortType:"Index" })` → returns a `Promise<Uint32Array>` (sorted index list) or
  `undefined` when the worker/WASM is not yet ready (`:64-66`). Worker impl:
  `packages/engine/Source/Workers/gaussianSplatSorter.js:26` `radix_sort_gaussians_indexes(positions,
  modelView, count)` from `@cesium/wasm-splats`. **Input contract: `positions` is a `Float32Array` of 3
  floats/splat (model-space), `modelView` is a `Float32Array(16)`, `count` is the splat count. The
  `positions.buffer` is transferred (neutered) into the worker** (`GaussianSplatSorter.js:68-70`), so callers
  pass a fresh copy (`new Float32Array(this._positions)` at WebGL sites `:1603/:1637`).
- WebGL cadence (the parity target for the throttle): constants
  `GaussianSplatPrimitive.js:155` `DEFAULT_SORT_MIN_FRAME_INTERVAL = 3`,
  `:157` `DEFAULT_SORT_MIN_ANGLE_RADIANS = 0.008726646` (0.5°),
  `:159` `DEFAULT_SORT_MIN_POSITION_DELTA = 1.0` (world units).
  `shouldStartSteadySort` (`:178`) starts a sort when frames-since ≥ 3 **and** (first sort **or** position
  moved ≥ 1.0 **or** direction rotated ≥ 0.5°).
- Staleness / supersede guard: `isActiveSort` (`:273`) rejects a resolved result whose `requestId !==
  primitive._sortRequestId` or `dataGeneration !== primitive._splatDataGeneration`. `resolveSteadySort`
  (`:712`) applies `primitive._indexes = sortedData` only if still active and `sortedLen === expectedCount`.

The in-tree GPU sort dispatcher (the alternative, **not** currently wired to splats):
- `packages/engine/Source/Renderer/WebGPU/WebGPUGPUSortKeysDispatcher.ts` — Batch 228 bitonic-sort-over-u64
  infra. Its own header (`:26-34`) states it produces packed 64-bit keys from **command metadata**
  (distanceSquared/renderLayer/sortPriority/materialSortId) and that the consumer integration is backlog.
  It is **not** a splat-depth sorter; adapting it needs a new depth-key compute pass reading the splat
  storage buffer + a bitonic sort over `count` (heavier). See Target design for why the worker path is primary.

**Open question you MUST resolve before writing code (STOP-AND-BLOCK #1):** who sets `primitive._splatData` /
`primitive._splatCount` in *production* (not the probe)? The FR reads them at
`WebGPUGaussianSplatRenderer.ts:1219-1221` (`primitive._splatData || primitive._renderResources?.splatBuffer`;
revision = `primitive._splatCount`), and they are declared in
`Renderer/WebGPU/cesium-js-types.d.ts:1276-1278` — but `git grep '_splatData ='` finds **no production
assignment** in JS; `probe-splat-sort.mjs` injects `_splatData` synthetically. The commit that would populate
positions for the WebGL worker (`commitSnapshot` → `primitive._positions`, `GaussianSplatPrimitive.js:432`)
runs *after* the `if (fr) return` and so never fires under WebGPU. Trace the real producer (grep the 3D-Tiles
GaussianSplat content loader + `_renderResources.splatBuffer`) **first** — the worker feed and the ordering
oracle both depend on having model-space positions available on the WebGPU path. If no production producer
exists, the splat FR is only exercised by the probe today and the whole slice is premise-broken; surface that
to the maintainer rather than wiring a worker against data that never arrives.

#### Target design + invariants

Primary approach: **consume the existing `GaussianSplatSorter` worker from the WebGPU FR, one-frame-stale**,
filling the `sortRequestPending` scaffolding. GPU on-device sort is a deferred alternative (Trap/Pointers).

Invariants (numbered; each is a checkable acceptance clause):

1. **No main-thread comparator sort remains on the splat draw path.** `Array.prototype.sort` at
   `WebGPUGaussianSplatRenderer.ts:974` is deleted; the per-sort `new Float64Array(count)` at `:963` is gone.
2. **Ordering parity within one frame of staleness.** The permutation written to `sortedIndexBuffer` equals a
   correct back-to-front (ascending eye-space z, farthest first) order for a camera pose no older than the
   most recently *resolved* worker result. Transient one-frame-stale order during fast orbit is acceptable
   and matches WebGL (which is also worker-async and one-frame-stale).
3. **Stale-result rejection.** A worker result is applied only if a generation tag (splat-data generation +
   sort request id, mirroring `isActiveSort`) still matches at resolve time. A result for a superseded
   camera pose or a reallocated splat buffer is dropped, never uploaded.
4. **Cadence parity.** Re-sort is requested on the WebGL rule: min-frame-interval (≥3) **and** (first sort
   **or** position Δ ≥ 1.0 **or** direction Δ ≥ 0.5°). Not angle-only.
5. **Identity fallback while a sort is in flight or the worker is not ready.** `sortedIndexBuffer` keeps its
   last valid permutation (or identity on first frame, already seeded at `:1261-1266`). The renderer never
   blocks on the worker; a frame with no fresh result draws with the previous order.
6. **Pick unaffected.** Splat pick is one broadcast `pickColor` per cloud (WGSL `Uniforms.pickColor`,
   `:176-180`); it does not depend on draw order. Order changes must not change pick results — verify the
   pick command path (`cache.pickCommand`) still binds the same `sortedIndexBuffer` and produces the same
   picked primitive id regardless of permutation.
7. **CPU position mirror bounded.** If the GPU-sort alternative is NOT taken, the CPU still needs positions
   to feed the worker, but you feed a **transferred copy** per request; do not retain a second permanent
   mirror. (Dropping the 64 MB permanent `splatData` mirror entirely is only possible on the GPU-sort path,
   where positions live only on-GPU — note it as the GPU-path bonus, not a worker-path deliverable.)
8. **RTE untouched.** The depth key uses the same eye-space z math already present (`us.view * modelMatrix`
   at `:945`); no absolute ECEF position is materialized as `f32`. The worker's `modelView` is the same
   `view * modelMatrix` product WebGL already passes.

#### Implementation walkthrough (decision points inline)

1. **Resolve STOP-AND-BLOCK #1** (production `_splatData` producer). If none → block. If it exists and also
   exposes model-space positions (a `Float32Array` of 3/splat, or derivable from the interleaved record),
   proceed. If only the interleaved 64-byte record is available, you must extract positions into a
   `Float32Array(count*3)` per sort request (`posHigh+posLow` per record, same math as `:966-969`) — that is
   an extra `count*12` B alloc per request, still worker-transferred, far cheaper than the comparator.

2. **Add an async-sort state block to `GaussianSplatCache`** (the interface at
   `WebGPUGaussianSplatRenderer.ts:40-116`). Reuse `sortRequestPending` (already declared `:80`). Add:
   `sortGeneration: number` (bumped on every splat-buffer realloc at `:1240`), `sortRequestGeneration:
   number` (stamped when a request is dispatched), and `lastSortCameraPos: Cartesian3 | null` +
   `lastSortFrameNumber: number` for the full cadence. Keep `sortIndices` as the reusable result landing slot.

3. **Rewrite `maybeSortSplats` into a request/apply pair.**
   - `maybeRequestSplatSort(...)`: evaluate the WebGL cadence (invariant 4). If due and
     `!cache.sortRequestPending`: build the positions copy + `modelView` (`view*modelMatrix`, same as
     `:945`), call `GaussianSplatSorter.radixSortIndexes({ primitive:{ positions, modelView, count },
     sortType:"Index" })`. **Decision:** if it returns `undefined` (worker/WASM not ready, `:64-66`), do
     **not** fall back to a main-thread sort — leave the last permutation in place and try again next frame
     (identity on the very first frames is already correct-enough for a static or near-static view). Set
     `cache.sortRequestPending = true`, stamp `sortRequestGeneration = cache.sortGeneration`, record the pose.
     Then `void` an async resolver.
   - Resolver: `const sorted = await promise;` then apply **only if**
     `cache.sortRequestPending && cache.sortGeneration === sortRequestGeneration && sorted.length === count`
     (invariant 3). On success: `cache.sortIndices = sorted; device.queue.writeBuffer(cache.sortedIndexBuffer,
     0, sorted);` clear `sortRequestPending`. On mismatch/error: clear `sortRequestPending`, keep the old
     permutation.
   - **Decision:** the `writeBuffer` on the sorted result is a single `count*4` B upload — keep it. It runs on
     the worker-resolve microtask, not synchronously in the sort. That is fine (the VS reads whatever is
     resident; a mid-frame buffer update just applies next frame).

4. **Wire the call.** Replace the single `maybeSortSplats(...)` call at `:1300` with
   `maybeRequestSplatSort(...)`. The apply happens in the async resolver, not inline.

5. **Camera-motion cadence.** Reuse the pose fields. Compute position delta against `lastSortCameraPos` and
   angle against `lastSortCameraDir` (already present `:927-931`), gate on `frameNumber -
   lastSortFrameNumber >= 3`. This prevents a worker request storm during continuous orbit (one request per
   ~3 frames max), which is exactly WebGL's behavior.

6. **Generation bump on realloc.** At the splat-buffer realloc site (`:1222-1274`), bump
   `cache.sortGeneration` and clear `sortRequestPending` so any in-flight worker result for the old buffer is
   rejected by invariant 3, and force a fresh request (`lastSortCameraDir = null` already does this at `:1268`).

7. **Do NOT delete the `splatData` mirror** on the worker path — the worker still needs a positions source,
   and `splatData` also feeds the velocity prev-buffer path (`cache.prevSplatData`, `:110-112`, promoted at
   `:1787`). Deleting it is a GPU-sort-path-only optimization and would break velocity/TAA. (This intersects
   C10 W8-4's sibling row C9-38/velocity — keep the slices independent; do not touch velocity here.)

#### Traps

- **Angle-only throttle is a regression risk if copied forward.** The current WebGPU throttle (`:927-935`)
  ignores camera *translation* — dolly-in/out without rotation never re-sorts, so a fly-through re-orders
  wrong. Adopt the full WebGL cadence (invariant 4). This is a latent correctness bug you should fix while here.
- **Positions buffer is transferred, not copied by the worker.** `radixSortIndexes` transfers
  `positions.buffer` (`GaussianSplatSorter.js:69`). You MUST pass a fresh `Float32Array` per request
  (`new Float32Array(src)`), never the live mirror — transferring the live buffer neuters it and the next
  frame's read of `splatData`/velocity throws "detached ArrayBuffer".
- **`undefined` return is normal, not an error.** The worker is lazy-initialized and WASM-gated; the first N
  frames after first splat content return `undefined` from `radixSortIndexes`. Treat as "not ready, retry",
  never as a reason to run a synchronous fallback (that would silently reintroduce the stall on slow WASM init).
- **One-frame staleness is a feature, not a bug.** Do not try to make the sort synchronous "just for
  correctness." WebGL is also async/stale; matching it IS parity. A visible order pop only appears if you
  drop invariant 5 (identity fallback exposed mid-orbit).
- **Do not reach for `WebGPUGPUSortKeysDispatcher` as a quick win.** It sorts command metadata, not splat
  depth; wiring it needs a new depth-key compute pass. It is the deferred alternative, not this slice.
- **`probe-splat-sort.mjs` injects `_splatData` directly** and asserts *ordering*, not timing. It will keep
  passing with either sort backend — it is your correctness oracle (invariants 2/6), NOT your perf oracle.
  You need a separate continuous-orbit timing lane for the stall-elimination proof.
- **Generation tag must cover BOTH data-change and pose-supersede.** A result can be stale two ways: the
  splat buffer was realloced (data generation), or a newer request was already dispatched. Guard both, or a
  slow worker result for an old pose overwrites a fresher one (visible order flicker).

#### Verification recipe

Correctness (must pass, byte-for-byte on the assertions):
```
node server.js --production          # terminal 1 (serves :8134 for this probe)
node Tools/visual-regression/probe-splat-sort.mjs
```
PASS = all 5 checks in the probe header pass (center pixel == nearest splat color; != buffer-last color;
far-camera splats survive over log globe; log-depth flip OK; 0 GPU/console errors). This proves back-to-front
order is still consumed after the sort-backend swap (invariants 2, 6).

Perf (the promotion evidence — build this lane; the moving-altitude track has no splat content):
- Load a real ≥1 M-splat tileset (or the largest available splat asset) in the WebGPU viewer, drive a
  **continuous orbit** (constant angular velocity so the cadence keeps firing), and record `Scene.render()`
  CPU frame times + long-task durations for ~600 frames. Oracle triad:
  - **off** (baseline): current `main` with `maybeSortSplats` — expect periodic multi-hundred-ms main-thread
    spikes aligned to ~0.5° rotation boundaries.
  - **on**: worker path — expect the spikes to vanish; per-frame CPU p95/p99 drop by the full sort cost
    (this is a >3× noise / discrete-hitch elimination, not a 5% average shift — report the p99 and the
    max-long-task, not the mean).
  - **restored**: revert the FR change — spikes return. Confirms attribution.
- Use `CesiumDebug.cpuPassCost(true)` to confirm no splat-sort cost appears on the render pass, and check the
  browser performance trace shows the sort work on a worker thread, not the main thread.

#### Rollback boundary

Self-contained: `WebGPUGaussianSplatRenderer.ts` (cache interface + `maybeSortSplats` → request/apply) plus
possibly a tiny positions-extraction helper. No WGSL change (the VS already reads `sortedIndexBuffer`). No
change to `GaussianSplatSorter.js` / the worker (reused as-is). No change to `GaussianSplatPrimitive.js`
unless STOP-AND-BLOCK #1 reveals the producer lives there. Revert = restore the single-file diff; the WGSL,
buffers, and bind groups are untouched, so a revert cannot leave a half-wired pipeline. Do NOT expand scope
into the velocity prev-buffer (C9-38) or the GPU-sort dispatcher in this slice.

#### Pointers
- Register: `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` S6-1 (`:552-569`), proposed row C9-37 (`:1276`),
  = S11-2.
- Strata: `scratchpad/perfdive/S6-upload-streaming-paths.md` F1 (`:30-71`).
- Queue: `QUEUE_2026-07-15_CAMPAIGN9.md` W8-4 (`:346`).
- WebGL reference orchestration: `GaussianSplatPrimitive.js:1589-1657` + helpers `:178-278`, `:712-737`.

---

### C10-05-MODEL-TEXTURE-MIP-CHAIN

#### Architecture today (verified)

Model material textures are sampled **mip-0-locked end to end**: the textures carry a single mip level and
every material sample forces LOD 0. This costs ~2 orders of magnitude of DRAM sample traffic on minified
tiles plus visible shimmer. The globe solved the identical problem in Batch 57; the model shader never got
the fix.

Shader side (`packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, 4,115 lines):
- Census (re-grepped): `textureSampleLevel` with explicit `0.0` LOD at the **material** sample sites —
  baseColor `:2478/:2483`, normal `:2563`, metallic-roughness `:2578/:2590`, specular `:2614/:2618`, plus
  emissive/occlusion/clearcoat/sheen/transmission further down (~30 material samples total). **Zero**
  implicit-derivative (`textureSample`) or gradient (`textureSampleGrad`) samples exist in the file.
- These are forced to LOD 0 because the fragment shader has **non-uniform discards** in its control flow
  (clipping-plane/polygon/batch-style discards; sites at `:2233-2269`, batch discard reachable from the
  `baseColorTexture` region). WGSL forbids implicit-derivative sampling after non-uniform discard/return —
  the same constraint the globe hit. `textureSampleLevel(...,0.0)` is legal after a discard but pins mip 0.
- Fragment entry: `@fragment fn fragmentMain(input: FragmentInput)` at `:2356`. No UV derivatives are
  hoisted at entry today. *(Correction 2026-07-17: `dpdx`/`dpdy` DO appear in this file — the
  tangent-less `perturbNormal` screen-space-tangent fallback at ~:1364-1367 uses them under the
  uniform-control-flow comment at ~:1349. The file already carries derivative built-ins with a
  uniformity constraint; only the entry-hoist is absent — factor that into the uniformity-analysis
  reasoning when adding derivative-based mip selection.)*
- **Non-material samples that MUST stay at mip 0** (data lookups, not filtered material — do NOT convert):
  batch table `:1459/:1463`, feature pick `:1479/:1482`, feature id `:2456`, edge/globe-depth screen-space
  `:1910-1913`, SDF `:2265`, clipping-plane data `:2292`. Converting any of these to grad would corrupt the
  lookup.

Texture-allocation side (two paths — this is the critical subtlety):
- `WebGPUModelRenderer.ts:1932` `createGPUTextureFromReader(device, reader, colorSpace)` is the model texture
  resolver (callers `:2616/:3392/:3672`). It resolves in two ways:
  1. **Primary path** `:1956-1960`: if the CesiumJS `Texture` is backed by a `WebGLStubTexture`, the GPU
     texture already exists at `cesiumTexture._texture._webgpuTexture.texture` and is **returned by
     reference** (`return stubGPU.texture`). The mip count of this texture was decided by the stub, NOT here.
  2. **Fallback path** `:1985-1999`: no stub texture → `device.createTexture({ size:[w,h,1], format, usage })`
     **with no `mipLevelCount`** (defaults to 1) + one `copyExternalImageToTexture` to mip 0. This is the
     anchor the register cites (S3-1), but it is the *secondary* path for real glTF textures.
- The stub allocator: `Renderer/WebGPU/Stubs/WebGLStubTexture.ts` `ensureTextureAllocated` (`:283-326`)
  **already allocates a full mip chain** — `mipLevelCount = wrapper._samplerDesc.wantsMipmaps ?
  mipLevelsFor(w,h) : 1` (`:289-291`), with `RENDER_ATTACHMENT` usage (`:301`) so the blit generator can
  write every level. `wantsMipmaps` **defaults `true`** (`:167`) but is flipped by `texParameteri` from the
  WebGL min-filter (`:415`). The stub's `generateMipmap()` (`:871-922`) dispatches `WebGPUMipmapGenerator`
  and — deliberately, per the Batch-144 comment (`:896-921`) — uses a **standalone encoder + its own
  `queue.submit` (`:921`)** because it is called mid-frame during `gltfTextureLoader.process` while the scene
  render pass is open on the main encoder (reusing it throws "locked while RenderPassEncoder is open").
- The model default sampler already declares `mipmapFilter:"linear"` (`WebGPUModelPipelineCache.ts:2083-2090`)
  — so the sampler is *ready* for trilinear, but the textures have 1 mip and the shader forces LOD 0, so it
  never engages.

The blit tool (reuse as-is): `Renderer/WebGPU/WebGPUMipmapGenerator.ts` — `generateMipmaps(texture, format,
mipLevelCount, commandEncoder?)` records N-1 blit-down render passes into a caller-provided **or** standalone
encoder (`:162-241`); `generateMipmapsAndSubmit` (`:247-254`) is the private-submit convenience wrapper (do
NOT use on the frame path). `calculateMipLevelCount(w,h) = floor(log2(max(w,h)))+1` (`:263`).

Submit-authority precedent (C9-12A): `QUEUE_2026-07-15_CAMPAIGN9.md:217` (row 30A) —
> "Mip preparation is frame-owned or off-hot-path through `ResourcePlan`/FAR-200, **never a private submit
> from draw emission**."
The same rule governs this row (queue W8-5 `:347`: "MipmapBlit at upload under submit authority").

**Quantification (state these in the acceptance):**
- **Sample bandwidth ~100×:** a minified fragment sampling mip 0 of a 2048² texture gathers from a working
  set ~ (screen-footprint)² larger than trilinear from the correct mip. Across up to ~25 sampled material
  textures per fragment with near-zero cache locality, minified tiles pull ~2 orders of magnitude more
  texture-DRAM traffic than sampling the right mip — the register's "~100×" (S3-1, `:243-249`). This is the
  win; it is a **GPU sample-bandwidth** metric, invisible in CPU frame time.
- **Memory +33%:** a full mip chain adds Σ 1/4^k (k≥1) = 1/3 of the base texture's bytes → **+33%** VRAM per
  mipped texture. Budget accordingly; it is the unavoidable cost of the win and is the standard trilinear
  tradeoff. (KTX2/compressed already-mipped textures do NOT add this — they already ship the chain.)

**KTX2 / pre-mipped interaction (STOP-AND-BLOCK #2 before touching allocation):** compressed KTX2 textures
arrive with their **own mip chain already transcoded** through the KTX2 transcoder path (loadKTX2 /
`_webgpuTexture` upload writes each level). You MUST NOT run `WebGPUMipmapGenerator` on them (the blit
generator needs `RENDER_ATTACHMENT` + a renderable format, which BC/ETC/ASTC compressed formats are not — it
would throw), and you MUST NOT re-generate over levels the transcoder already filled. Detect "already has
mips" (`tex.mipLevelCount > 1` on the stub wrapper, or a compressed `format`) and skip generation for those.

#### Target design + invariants

Apply the Batch-57 globe pattern (entry-hoisted gradients + `textureSampleGrad`) to the ~30 **material**
samples, **and** ensure the model material textures actually carry a mip chain, generated at upload through
frame-owned submit authority. **Both prongs are required** — a mip chain with the shader still forcing LOD 0
changes nothing; grad sampling on a 1-mip texture samples mip 0. They must land together.

Invariants:

1. **Magnified texels byte-identical.** For a fragment where the texture is magnified (footprint ≤ 1 texel),
   `textureSampleGrad` with the true derivatives selects mip 0 and returns the identical filtered value as
   today's `textureSampleLevel(...,0.0)`. Close-up model probes must be pixel-identical to pre-change.
2. **Minified tiles select a coarser mip.** At distance the gradient magnitude drives the sampler to the
   correct mip; shimmer disappears and sample bandwidth drops. Visually matches WebGL trilinear.
3. **Only material samples convert.** The ~30 baseColor/normal/MR/emissive/occlusion/specular/clearcoat/
   sheen/transmission samples convert to `textureSampleGrad`. Every data-lookup sample (batch/featureId/
   featurePick/edge/globeDepth/SDF/clipping) stays `textureSampleLevel(...,0.0)`.
4. **Derivatives computed once, at fragment entry, in uniform control flow.** `dpdx/dpdy` of `texCoord0`
   (and `texCoord1` when the model uses a second UV set) are taken at the top of `fragmentMain` before any
   discard, then threaded to the sample sites (exactly Batch-57).
5. **Full mip chain allocated for material textures** in BOTH allocation paths (stub + fallback), with the
   KTX2/pre-mipped skip (STOP-AND-BLOCK #2).
6. **Mip generation uses frame-owned/off-hot-path submit authority — no private `queue.submit` on the draw
   emission path.** Route the blit encoder through `ResourcePlan`/FAR-200 (C9-12A precedent) so it submits
   before the scene render pass opens, not inline during draw. (The existing stub `generateMipmap` private
   submit at `WebGLStubTexture.ts:921` is the thing to migrate — see decision point.)
7. **KTX2/compressed textures are never re-blitted** and keep their transcoded chain (invariant 5 skip).
8. **Memory budget acknowledged.** +33% VRAM on newly-mipped uncompressed material textures is expected and
   documented; no runtime cap change needed, but note it in the batch message and check the tileset residency
   counter does not blow a budget owned by C9-15/FAR-200-S3.
9. **RTE untouched** (this slice is texture/shader-only; no position math).

#### Implementation walkthrough (decision points inline)

1. **Resolve STOP-AND-BLOCK #3 (which allocation path do real model textures take?).** Instrument
   `createGPUTextureFromReader`: log whether it returns via the stub path (`:1958`) or the fallback (`:1985`)
   for a real glTF/3D-Tiles model. Load a known-textured model (e.g. a PBR glTF or a photogrammetry tileset)
   in WebGPU mode.
   - If **stub path** dominates (likely for CesiumJS `Texture`-backed model textures), the mip fix belongs in
     the stub chain: ensure the glTF material texture's sampler flips `wantsMipmaps = true` and that
     `generateMipmap()` is invoked after upload. Check *why* `wantsMipmaps` ends up effectively false today
     (glTF omitting a sampler → CesiumJS default `Sampler` min-filter → `texParameteri` at
     `WebGLStubTexture.ts:415` sets a non-mipmap filter). Parity target: WebGL Cesium models mipmap their
     material textures.
   - If **fallback path** is taken, add `mipLevelCount` + a blit at `:1985-1999`.
   - **You may need both.** Do the trace first; do not guess.

2. **Shader — hoist derivatives (Batch-57 clone).** In `ModelPBRComplete.wgsl fragmentMain` (`:2356`),
   immediately after entry (before any discard), add:
   ```
   let uv0_dx = dpdx(input.texCoord0); let uv0_dy = dpdy(input.texCoord0);
   // and texCoord1 variants iff the model samples a second UV set
   ```
   Mirror the globe comment at `GlobeTerrain.wgsl:3138-3151` (the canonical template — read it). Note the
   globe also handles a webMercatorT V-derivative special case; models have no such thing, so it is simpler.

3. **Shader — convert material samples.** Replace each material `textureSampleLevel(tex, samp, uv, 0.0)` with
   `textureSampleGrad(tex, samp, uv, uv0_dx, uv0_dy)` (use the matching UV set's derivatives per the
   `baseColorUV(input)` / `normalUV(input)` helper the site already uses — those helpers return the selected
   UV, so pass the derivative of that same set). **Decision:** if a site's UV is a transformed UV
   (KHR_texture_transform), the derivative must be of the *transformed* coordinate — take `dpdx/dpdy` of the
   `*_UV(input)` result at entry, or accept that the transform is affine so the derivative scales by the
   transform's linear part (Batch-57 took the raw derivative; match its rigor level, i.e. derivative of the
   final sampled UV). Keep it simple: derive from the same expression fed to the sampler.

4. **Leave data-lookup samples alone** (invariant 3). Double-check each `textureSampleLevel(...,0.0)` you
   touch is a material color/normal/data-that-should-filter sample, not a batch/id/edge/SDF/clip lookup.

5. **Allocation — stub path.** If step 1 says stub: at the glTF model texture load, ensure the sampler
   descriptor requests mipmaps (so `ensureTextureAllocated` allocates the chain at `WebGLStubTexture.ts:289`)
   and `generateMipmap` runs. **Do not** weaken the KTX2 skip.

6. **Allocation — fallback path.** If step 1 says fallback: at `WebGPUModelRenderer.ts:1985`, compute
   `const mipLevelCount = WebGPUMipmapGenerator.calculateMipLevelCount(width, height)`, add it to
   `createTexture` (RENDER_ATTACHMENT usage is already present `:1992`), keep the mip-0 `copyExternalImage`
   (`:1995`), then record a blit via `WebGPUMipmapGenerator.generateMipmaps(tex, format, mipLevelCount,
   encoder)` — **into a frame-owned encoder**, not `generateMipmapsAndSubmit`. Skip entirely when the source
   is compressed/pre-mipped.

7. **Submit authority (STOP-AND-BLOCK #4).** Model textures upload asynchronously at content-load time, not
   per-frame, so a private submit is *less* dangerous than the imagery per-frame case — but the C9-12A rule
   is explicit ("never a private submit from draw emission") and the Batch-144 comment
   (`WebGLStubTexture.ts:896-921`) shows the concrete hazard: the blit's `beginRenderPass` collides with the
   open scene render pass if it lands mid-frame. **Decision:** route the mip-blit encoder through the same
   `ResourcePlan`/FAR-200 pre-frame resource-submit slot C9-12A established for imagery mips. The frame-owned slot IS
   available at HEAD: C9-12A LANDED (Batches 685-686) as `WebGPUContext.enqueueImageryMipGeneration` +
   `flushPendingImageryMipJobs` with split prep/frame submits — note there is NO code symbol named
   `ResourcePlan` (queue-prose term only; a literal grep misfires), so route through the enqueue/flush
   API. Only if that API were somehow absent would the safe interim be the *existing* standalone-encoder
   pattern the stub already uses at upload time (`:916-921`) — it is a documented at-upload (not
   draw-emission) submit — and file the migration to FAR-200 as the follow-on. **State which you chose and
   why in the batch message; do not silently add a new private submit on any per-frame path.**

8. **Verify sampler engages.** The model default sampler already has `mipmapFilter:"linear"`
   (`WebGPUModelPipelineCache.ts:2083`); confirm the per-material sampler (if models build one from the glTF
   sampler) also sets `mipmapFilter:"linear"` / non-zero LOD clamp, else the chain exists but the sampler
   clamps to mip 0.

#### Traps

- **The register anchor (`:1985`) is the SECONDARY path.** If you only patch the fallback `createTexture` and
  real glTF textures actually flow through the stub path (`:1958`), your change compiles, passes a naive
  grep, and does **nothing** for production models. Do the path trace (step 1) first. This is the single most
  likely way to ship a no-op "fix."
- **Grad without a mip chain = still mip 0.** And a mip chain with the shader still at `textureSampleLevel(
  ...,0.0)` = still mip 0. Neither prong alone moves the metric. They must land in the same batch.
- **Do not convert data-lookup samples.** `textureSampleGrad` on the batch table / feature-id / SDF / edge /
  clipping-plane textures would filter across unrelated texels and corrupt styling, picking, and clipping.
  The census in "Architecture today" lists the exact keep-at-LOD-0 sites.
- **KTX2/compressed formats are not RENDER_ATTACHMENT-capable.** Running the blit generator on a BC/ETC/ASTC
  texture throws. Skip pre-mipped/compressed textures (STOP-AND-BLOCK #2). They already have their chain.
- **`generateMipmapsAndSubmit` is a private submit** (`WebGPUMipmapGenerator.ts:247-254`). Do not use it on
  any path C9-12A governs. Use the `commandEncoder`-accepting `generateMipmaps` overload and hand it a
  frame-owned encoder.
- **Mip generation must see finished mip-0 data.** The blit reads level 0 to produce level 1..N. Ensure the
  `copyExternalImageToTexture`/upload of level 0 is ordered before the blit passes in the same encoder (it is,
  if both go through the same frame-owned encoder in order) — a race yields black/garbage lower mips.
- **`wantsMipmaps` default is `true` but texParameteri can flip it false** (`WebGLStubTexture.ts:415`). If a
  glTF sampler declares LINEAR (not LINEAR_MIPMAP_*), the stub allocates 1 mip. WebGL parity means models
  should mipmap regardless — check what WebGL Cesium does for model material textures (it typically forces
  mipmaps for POT/`generateMipmap`) and match, rather than trusting the glTF-declared min-filter.
- **+33% VRAM can trip a residency budget owned elsewhere.** Tileset texture residency budgeting is C9-15/
  FAR-200-S3 territory. Your job is to allocate the chain, not to build eviction; but confirm you did not push
  a benchmark tileset past a hard budget (check the tileset memory counter before/after).

#### Verification recipe

Correctness / no-magnified-regression (byte-identical oracle):
- Close-up model probes must be pixel-identical to pre-change. Use `probe-model-pbr-ibl-parity.mjs` /
  `probe-model-color.mjs` (close cameras, magnified textures) — PASS = cross-backend and pre/post deltas
  within existing tolerance (invariant 1). `probe-mipmap-check.mjs` / `probe-mip-debug.mjs` verify a mip
  chain now exists on model textures (were built for exactly this).
- Shimmer/aliasing at distance: a distant textured-tileset probe (adapt `probe-tileset-capture-face-zoom.mjs`
  or `probe-vr2-tile-brightness.mjs` to a city photogrammetry set at regional altitude). Compare WebGPU vs
  WebGL — PASS = WebGPU distant tiles now match WebGL trilinear (no high-frequency shimmer; luminance-stable
  under sub-pixel camera jitter). **Read the PNGs yourself** (CLAUDE.md Principle 8) — a diff drop is not proof.

Perf (promotion evidence — GPU bandwidth, not CPU):
- On the distant city-tileset scene, enable `CesiumDebug.gpuPassCost(true)` and record the model/tileset
  draw-pass GPU time. Oracle triad:
  - **off**: `main` (mip-0-locked) at a fixed distant camera.
  - **on**: mipped + grad — the model draw pass GPU time drops (the ~100× sample-bandwidth reduction shows as
    a named-stage GPU-timestamp p95 drop on bandwidth-limited hardware). Report the GPU pass time, not FPS.
  - **restored**: revert → GPU time returns. Confirms attribution.
- Because the moving-altitude track carries no model/tileset content, this is a **content lane you add**; do
  not claim the promotion off the default globe track.

Type/build gate: `npx tsc --noEmit` (the `.ts` allocation change), `npx gulp build` (WGSL recompiles), and the
model probe suite green.

#### Rollback boundary

Touch set: `ModelPBRComplete.wgsl` (entry derivatives + ~30 material sample conversions) + ONE of
{`WebGLStubTexture.ts` sampler/mip path, `WebGPUModelRenderer.ts:1985` fallback} depending on the path trace,
+ the submit-authority routing (ideally reusing C9-12A's `ResourcePlan` slot; no new module). Revert = restore
those files. The two prongs (shader + allocation) are coupled — if you must roll back, roll back **both** (a
lone shader revert leaves grad-sampling a 1-mip texture = harmless mip 0; a lone allocation revert leaves the
shader grad-sampling a since-freed mip chain = also mip 0 — but keep them together to avoid a confusing
half-state). Do NOT expand into imagery mips (C9-12A owns those) or tileset residency/eviction (C9-15/FAR-200).

#### Pointers
- Register: `PERF_ARCH_DEEP_DIVE_2026-07-16.md` S3-1 (`:239-254`), proposed row C9-31 (`:1270`).
- Queue: `QUEUE_2026-07-15_CAMPAIGN9.md` W8-5 (`:347`), C9-12A submit-authority rule row 30A (`:217`).
- Batch-57 template: `Shaders/WebGPU/Globe/GlobeTerrain.wgsl:3138-3151` (entry hoist) + `:1690-1704`
  (`textureSampleGrad` helper).
- Blit tool: `WebGPUMipmapGenerator.ts`. Stub mip chain + private-submit hazard: `WebGLStubTexture.ts:283-326`,
  `:871-922`.

---

### Campaign-10 queue rows (paste-ready)

| # | ID | Pri | Effort | Work / acceptance |
|---|----|-----|--------|-------------------|
| — | `C10-04-SPLAT-ASYNC-SORT` (W8-4 / ex-C9-43) | R2 | M | Replace the synchronous main-thread comparator sort in `WebGPUGaussianSplatRenderer.maybeSortSplats` (`:906-987`, `Array.prototype.sort` `:974`, per-sort `Float64Array(count)` `:963`) with the shipped `GaussianSplatSorter.radixSortIndexes` WASM worker (the exact WebGL asset), consumed one-frame-stale into `sortedIndexBuffer` and filling the unused `sortRequestPending` scaffolding. First resolve the production `_splatData`/`_splatCount` producer (STOP-AND-BLOCK: probe injects it; no JS assignment found — block if none exists). Feed the worker a fresh transferred `Float32Array` positions copy + `view*modelMatrix`; reject results by (data-generation, request-id) tag; adopt the full WebGL cadence (≥3-frame interval AND position Δ≥1.0 OR angle Δ≥0.5°), not the current angle-only throttle. Accept: `probe-splat-sort.mjs` all-green (back-to-front order still consumed, pick unchanged); a continuous-orbit ≥1M-splat content lane shows the periodic multi-hundred-ms main-thread hitches eliminated (off/on/restored, report p99 + max-long-task, sort work on a worker thread); no main-thread comparator sort remains; no WGSL/buffer/bind-group change. Do NOT wire `WebGPUGPUSortKeysDispatcher` (command-metadata sorter, not depth) or touch velocity prev-buffers (C9-38). |
| — | `C10-05-MODEL-TEXTURE-MIP-CHAIN` (W8-5 / ex-C9-44) | R2 | M | Give glTF/3D-Tiles model material textures a real mip chain AND make the shader sample it (both prongs, same batch). Shader (`ModelPBRComplete.wgsl`): hoist `dpdx/dpdy(texCoord0/1)` at `fragmentMain` entry (`:2356`, before any non-uniform discard) and convert the ~30 **material** `textureSampleLevel(...,0.0)` sites (baseColor `:2478/:2483`, normal `:2563`, MR `:2578/:2590`, specular `:2614/:2618`, emissive/occlusion/clearcoat/sheen/transmission) to `textureSampleGrad` — Batch-57 pattern (`GlobeTerrain.wgsl:3138-3151`). Leave ALL data-lookup samples (batch/featureId/featurePick/edge/globeDepth/SDF/clipping) at LOD 0. Allocation: trace which path real model textures take — stub (`WebGPUModelRenderer.ts:1958` → `WebGLStubTexture.ts:289` mip chain gated on `wantsMipmaps`) vs fallback (`:1985`, currently `mipLevelCount=1`) — and allocate a full chain on the live path; run `WebGPUMipmapGenerator` at upload through `ResourcePlan`/FAR-200 frame-owned submit authority (C9-12A precedent, NO private draw-path submit, avoid `generateMipmapsAndSubmit`). Skip KTX2/compressed/pre-mipped textures (not RENDER_ATTACHMENT-capable; already chained). Accept: magnified-texel close-up model probes byte-identical (`probe-model-pbr-ibl-parity`, `probe-model-color`); `probe-mipmap-check`/`probe-mip-debug` confirm a chain now exists; a distant city-tileset lane loses shimmer and matches WebGL trilinear (read the PNGs); `gpuPassCost` model-draw GPU-timestamp p95 drops on the distant lane (off/on/restored, the ~100× sample-bandwidth win); +33% VRAM on newly-mipped uncompressed textures acknowledged, no residency budget (C9-15/FAR-200-S3) blown. |


---

<a id="h5"></a>

## Campaign 10 — Cluster H5: Boot / Compile TTFF Triad

**Tasks (land in this exact order — hard interdependency):**

1. `C10-06-TTFF-BOOT-CONCURRENCY-AND-PREWARM` (W8-6) — evidence S8-1 + S8-2 (+ S8-4 rider)
2. `C10-07-ASYNC-MODEL-PIPELINES` (W8-7) — evidence S8-3 + S3-6 + S5-1
3. `C10-08-MODEL-SHADER-SPECIALIZATION-AXES` (W8-8) — evidence S3-4 + S3-5

**Written 2026-07-16 against HEAD `457eb162f7` (Batch 675, "C9-07-DEMAND-OPEN-CANVAS").**
Every file:line anchor below was re-grepped on the live tree at that HEAD. The tree moves daily
under the concurrent Campaign-9 engine — **re-verify every anchor by symbol grep before editing.**
Line numbers are hints; symbols are the contract.

**Primary sources behind this section (read if you need deeper detail than is reproduced here):**
- `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` §9 (S8-1…S8-7) + §5 (S5-1) + the S3 rows in §4.
- `scratchpad/perfdive/S8-loadtime-ttff.md` (fullest boot-waterfall detail).
- `scratchpad/perfdive/S3-wgsl-shader-economics.md` Findings 4/5/6 (specialization + async).
- `migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md` G10 Part A = the C9-30/moving-altitude
  measurement stack you will reuse verbatim for verification.

**Measured evidence this cluster exists to move (repo artifacts, not re-run — do not overwrite them):**
- `Tools/visual-regression/output/performance/campaign9-deterministic-offline-boot-edge-r1-2026-07-15.json`:
  `rendererReady → firstObservedFrame` = **WebGL 18.1 ms vs WebGPU 163.8 ms (9.1×)**;
  `setupToStableMs` = 1139 vs 2718 ms (2.39×).
- `campaign9-gate-a-clean-r5-2026-07-15.json` (5 reps): first frame **+150–200 ms in 5/5**;
  per-settle-iteration 22–25 ms (WebGL) vs 58–66 ms (WebGPU, 2.6×); long tasks WebGL 7/~800 ms vs
  **WebGPU 0/0 ms in all 5 reps** (the +146 ms first frame is GPU-process compile latency behind the
  first `queue.submit`, NOT a main-thread block — a main-thread-only "fix" cannot move it).

---

### Campaign rules that bind this whole cluster (encode into every acceptance verdict)

- **Never remove / default-disable / degrade a feature to move a metric.** Prewarm, async compile, and
  specialization must be byte-identical in rendered output. A pipeline that renders later (async) is fine;
  a pipeline that renders *differently* is a rejection.
- **Unknown demand stays conservative.** If you cannot prove a pipeline is in the deterministic boot set,
  do NOT prewarm it (a wrong prewarm wastes the idle window it was meant to fill). If a model variant's
  define set is not provably stable, keep the runtime-flag path.
- **RTE precision untouched.** None of these tasks touch vertex math; if a diff forces you near
  `positionHigh/Low` or `mvpRelativeToEye`, you are out of scope — stop.
- **Evidence = moving-altitude track only** (`moving-camera-altitude-track-3d`), Playwright/Edge, clean and
  `--api-instrumentation` lanes never mixed. Idle-soak FPS is INVALID. TTFF is read from the campaign
  runner's `rendererReady→firstFrame` + `setupToStable` fields, not a stopwatch.
- **One concern per slice.** C10-06 is boot concurrency + prewarm. C10-07 is async compile scheduling.
  C10-08 is specialization. Do not fold them — but land them in order because 08 multiplies 07's compile
  count and would regress TTFF if 07 hasn't made compiles async first.
- **Promoted optimization bar:** ≥5 % improvement on a *named stage* p95 (here: `rendererReady→firstFrame`
  and `setupToStable`) OR >3× the run-to-run noise, with on/off/restored oracles. A truthful miss with
  green mechanics is a VALID COMPLETE result — say so in the ledger with the failing metric named.

---

### C10-06-TTFF-BOOT-CONCURRENCY-AND-PREWARM (W8-6)

#### Architecture today (verified)

The boot chain is a strict serial waterfall, each stage awaiting the previous, with **zero overlap**
between the two slow lanes (GPU-process device negotiation, chunk network/parse) and the main-thread
lane (Scene/Globe construction):

1. `ContextFactory.defaultCreationHooks.createWebGPU` — `packages/engine/Source/Renderer/ContextFactory.ts:103-106`:
   ```js
   async createWebGPU(canvas, options) {
     const { WebGPUContext } = await import("./WebGPU/WebGPUContext.js");   // :104 — 3 MB+ chunk
     return await WebGPUContext.create(canvas, options);
   }
   ```
   Built-output cost of `:104` (Build/Cesium minified ESM): `chunks/WebGPUContext-*.js` ≈ 798 KB statically
   importing 27 sibling chunks incl. the ~2.25 MB WGSL/renderer chunk ⇒ ~3.05 MB fetched+parsed+eval'd
   **before** anything else. (IIFE bundle: the same graph runs as one synchronous tick of 527 module
   initializers.) This is S8-4 territory; the *rider* below lazifies part of it.
2. `WebGPUContext.create → _initialize` awaits the device pool:
   `WebGPUContext.ts:1001` `await WebGPUDevicePool.instance.acquireDevice({...})` — internally serial
   `requestAdapter → negotiate → requestDevice` (30–120 ms of GPU-process time). Starts only *after* step 1
   fully returns.
3. Context init tail, all still awaited before Scene exists:
   - `WebGPUContext.ts:1065` `const primIdxMod = await import("./WebGPUPrimitiveIndexUtils.js");` — an inline
     awaited dynamic import *in the middle of init* (extra module round-trip serialized into every boot).
   - `WebGPUContext.ts:1108-1113` — two awaited **no-op** shader inits:
     ```js
     if (sceneRendererFR.initPrimitiveShaders)  { await sceneRendererFR.initPrimitiveShaders(); }
     if (sceneRendererFR.initCollectionShaders) { await sceneRendererFR.initCollectionShaders(); }
     ```
     Both bodies are `return;` — confirmed `WebGPUPrimitiveShaders.js:246-249` ("No-op: shaders are
     statically imported") and `WebGPUCollectionShaders.js:66-69`. Kept "for API compatibility"; two dead
     awaits on the critical path.
   - `WebGPUContext.ts:1118` `this._warmUpPipelines();` — **comment-only no-op**, body at
     `WebGPUContext.ts:1142-1181`. The comment itself names the correct fix (path *a*): a top-level
     `warmUpGlobeRenderer(context)` helper in `GlobeSurfaceTileProviderRendering.js` that "populates
     `_webgpuGlobeRenderers` and calls `.initialize`." **Neither path a nor b was ever done.**
4. Only after all of 1–3 returns does `CesiumWidget.createAsync` (`Widget/CesiumWidget.js:763`) call
   `CesiumWidget._createAsyncContext` (`:806`) then `new CesiumWidget(...)` (`:776`) — 100–300 ms of
   device-independent main-thread Scene/Globe/quadtree/collection construction. WebGL starts this
   immediately (its `createWebGL` at `ContextFactory.ts:100-102` is synchronous and cheap).

**The prewarm no-op in detail (S8-1).** The one real prewarm that exists —
`WebGPUGlobeSurfaceShaders.initShaderCache(host, code)` at `WebGPUGlobeSurfaceShaders.ts:84`, which
prewarms **2 GlobeTerrain variants** (baseline + `GEODETIC_NORMAL | reducedBit`) via
`host._shaderModuleCache.prewarm(...)` at `:100-108` — is invoked from the per-device globe renderer's
`.initialize(device, shaderCode, fmt)`, which runs **lazily inside the first tile-draw frame**:
`GlobeSurfaceTileProviderRendering.js:858-865`:
```js
let _webgpuGlobeRenderer = _webgpuGlobeRenderers.get(device);        // WeakMap, :788
if (!_webgpuGlobeRenderer || _webgpuGlobeRenderer.isDestroyed()) {
  _webgpuGlobeRenderer = new fr.RendererClass();
  const fmt = context.canvasFormat || navigator.gpu.getPreferredCanvasFormat();
  _webgpuGlobeRenderer.initialize(device, shaderCode, fmt);          // ← 2×239 KB GlobeTerrain compile
  _webgpuGlobeRenderers.set(device, _webgpuGlobeRenderer);
}
```
So two Tint compiles of the **238,857-byte** `Shaders/WebGPU/Globe/GlobeTerrain.wgsl` start at frame 1,
not during the idle init window. `WebGPURenderPipelineCache.preloadBatch`
(`WebGPURenderPipelineCache.ts:765`) and `WebGPUShaderCache.preloadBatch`
(`WebGPUShaderCache.ts:194`) both have **zero callers** anywhere in `packages/engine/Source` (grep: only
the definitions) — the async-preload machinery was built and never wired.

#### Target design + invariants

- **INV-06-1 (concurrency).** The `requestAdapter` GPU-process negotiation and the WebGPU chunk parse/eval
  must proceed concurrently, and both must overlap Scene construction wherever the device is not yet
  needed. No stage that has no data dependency on a prior stage may `await` it.
- **INV-06-2 (fire-and-forget prewarm).** Prewarm is launched non-awaited during the init idle window and
  must never block `_initialize` from returning, never block the first `render()`, and must be a no-op on
  failure (catch-and-drop). If the first frame arrives before a prewarm resolves, the frame path takes its
  existing lazy route — prewarm only ever *fills* the cache early, never gates a draw.
- **INV-06-3 (byte-identical output).** Prewarmed pipelines/modules must be produced from the *same*
  descriptors the lazy path would build (same `(sourceId, defines)`, same layout), so the cache key hits.
  A prewarm that builds a *different* variant is wasted work AND leaves the real first-frame compile
  unwarmed — worse than doing nothing.
- **INV-06-4 (deterministic set only).** Prewarm exactly the pipelines the deterministic-offline boot is
  proven to hit: the 2 GlobeTerrain shader variants, globe depth, depth plane, PP identity/tonemap/FXAA +
  the 2 auto-exposure compute pipelines, sky atmosphere. Do NOT prewarm imagery/model/OIT/translucent —
  those are demand-dependent (conservative-unknown rule).
- **INV-06-5 (multi-context safe).** Prewarm keys off the specific `device`/context being initialized. A
  second context (split-screen, second device) prewarms its own device. Never cache a pipeline built for
  device A onto device B (the classic globe WeakMap-keyed-by-device reason).
- **INV-06-6 (no dead awaits).** `initPrimitiveShaders`/`initCollectionShaders` awaits removed from the
  init path; the inline `WebGPUPrimitiveIndexUtils` import no longer serializes device negotiation.

#### Implementation walkthrough

Do these as **three independently-committable sub-steps** in one slice, smallest-risk first. Each has its
own oracle so a later step's failure doesn't force reverting the earlier win.

**Step A — kill the three cheap serializers (S8-2 iii + inline import).**
1. Delete the two dead awaits at `WebGPUContext.ts:1108-1113`. Leave the `sceneRendererFR` lookup if other
   code uses it; if not, drop the whole block. (Decision point: grep `getFeatureRenderer(FeatureRendererKey.SCENE_RENDERER)`
   usage in the surrounding lines — if the FR handle is used below, keep the `const`, delete only the two
   `if (...initShaders) await` lines.)
2. Hoist the `WebGPUPrimitiveIndexUtils` import off the critical path. It caches `this._primitiveIndexUtilsCache`
   (`WebGPUContext.ts:1065-1069`) read later by Scene probes (`WGF-6`, see the field comment at `:419`). Two
   options — pick by measurement:
   - **(preferred, smallest)** Convert `import("./WebGPUPrimitiveIndexUtils.js")` to a static top-of-file
     `import { WebGPUPrimitiveIndexUtils } from "./WebGPUPrimitiveIndexUtils.js";` and assign the field
     synchronously. Verify the module has no side-effectful top-level that must stay lazy (grep the file for
     top-level `device`/`navigator.gpu` touches — it is a pure util; static import is safe).
     **STOP-AND-CHECK:** static-importing it pulls it into the eager boot chunk (S8-4). It is *small*
     (index-utility math), so this is a net win, but confirm its transitive imports don't drag WebGPU-heavy
     modules into the eager graph (grep its `import` lines). If it does, use option 2 instead.
   - **(fallback)** Keep the dynamic import but do NOT await it inline: kick it at init top
     (`const primIdxPromise = import(...)`) and `await` it only at the point the field is first needed, or
     attach `.then(m => this._primitiveIndexUtilsCache = ...)` fire-and-forget and default the cache to
     `null` (the existing catch already sets `null`). Any consumer must already tolerate `null` (it does —
     the catch path sets null today).

**Step B — adapter/chunk concurrency (S8-2 i).**
The goal: `requestAdapter()` in flight *while* the WebGPU chunk parses, so device negotiation isn't
gated behind ~3 MB of parse. Two designs; **prefer the prefetch-cache** because it also overlaps Scene
construction, not just the chunk.
- **Design 1 — adapter prefetch cache in `RendererType.ts` (preferred).** `getRendererAttemptPlan`
  (`RendererType.ts:127`) already runs before the chunk import to decide WebGPU. At the point the plan
  resolves to WebGPU, kick `navigator.gpu.requestAdapter({powerPreference})` and stash the in-flight
  promise in a module-scoped cache (a 15–20 line addition). `WebGPUDevicePool.acquireDevice` then consumes
  the pre-resolved adapter instead of calling `requestAdapter` itself.
  - **Decision point:** `WebGPUDevicePool` currently owns `requestAdapter → requestDevice` internally
    (`WebGPUDevicePool.ts` ~`:745-793`, verify). You must thread the prefetched adapter into the pool
    without breaking its device-sharing logic. Add an optional `prefetchedAdapter?: Promise<GPUAdapter|null>`
    to the acquire options; if present and it resolves to a usable adapter matching the requested
    `powerPreference/featureLevel`, use it; else fall through to the pool's own `requestAdapter` (conservative
    fallback — a mismatched prefetch must NOT be used).
  - **STOP-AND-BLOCK:** if the prefetched adapter's `featureLevel`/`requiredFeatures` cannot be reconciled
    with what the pool will request (the plan runs before options are fully known), do NOT force it. Fall
    back to Design 2 (simpler, still a win) and note the reconciliation gap as follow-up. Guessing the
    adapter parameters violates the conservative-unknown rule.
- **Design 2 — `Promise.all` in `createWebGPU` (simpler, smaller win).** In `ContextFactory.ts:103-106`:
  ```js
  async createWebGPU(canvas, options) {
    const adapterP = navigator.gpu?.requestAdapter?.({ powerPreference: options.powerPreference ?? "high-performance" });
    const { WebGPUContext } = await import("./WebGPU/WebGPUContext.js");
    return await WebGPUContext.create(canvas, { ...options, prefetchedAdapter: adapterP });
  }
  ```
  This overlaps adapter-negotiation with chunk parse (recovers stage-2 under stage-1) but not with Scene
  construction. Same `prefetchedAdapter` plumbing into the pool as Design 1.

**Step C — real prewarm (S8-1), fire-and-forget at init.**
1. Add `warmUpGlobeRenderer(context)` as a top-level export in
   `packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js` (path *a* the comment names). It must
   replicate the lazy block at `:858-865`: resolve the globe feature renderer, get `shaderCode` via the FR's
   `getShaderCode` (the same source the lazy path reads — grep `getShaderCode` usage near `:820-845`),
   `new fr.RendererClass()`, `.initialize(device, shaderCode, fmt)`, `_webgpuGlobeRenderers.set(device, ...)`.
   Running `.initialize` triggers `initShaderCache` ⇒ the 2-variant GlobeTerrain prewarm during init.
   - **STOP-AND-BLOCK:** if `shaderCode` is not available at context-init time (it may be produced during
     Scene/Globe construction, which in the current waterfall runs *after* `_initialize`), then the globe
     prewarm cannot run inside `_initialize` — it must be hooked *after* `new CesiumWidget` / globe
     construction but still off the first `render()`. In that case wire `warmUpGlobeRenderer` from the widget
     post-construction path, not from `_warmUpPipelines`. Verify the ordering by grepping where the globe
     FR first has non-null `getShaderCode()` — do NOT assume init-time availability. If it is genuinely only
     available at first draw, prewarm the *shader modules* (which only need the raw WGSL string + device,
     both available early) and leave the pipeline prewarm to Step C.2.
2. Wire `WebGPURenderPipelineCache.preloadBatch` (`:765`) for the deterministic pipeline set. Enumerate the
   descriptors the boot is proven to hit (depth plane, globe depth, PP identity/tonemap/FXAA, sky
   atmosphere) — reuse the exact descriptor-builders those renderers already call (do NOT hand-author
   descriptors; import and call the same factory functions so INV-06-3 holds). Call `preloadBatch` (and the
   auto-exposure compute pipelines via their own path) **non-awaited** inside the init idle window.
   - Auto-exposure uses two *compute* pipelines through `WebGPUComputePipelineCache`
     (`WebGPUSceneRendererEnsureResources.ts:504-508`) — if you prewarm those, route them through that cache,
     not a private `createComputePipeline`.
3. Replace the `_warmUpPipelines()` body (`:1142-1181`) — or add a new `_prewarmDeterministicSet()` called
   from the same `:1118` site — with the fire-and-forget calls. Keep it wrapped so a throw never escapes
   `_initialize` (INV-06-2).

**Optional rider — S8-4 lazify (do LAST, separate commit, only if time/budget).**
Convert the ~15 cold eager feature-renderer registrations in
`packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts` (the `registerFeatureRenderer` calls
around `:244` ff) to the existing `registerFeatureRendererLoader` pattern (11 precedents already in the
file: GaussianSplat, PointCloud, EDL, Voxel, SSR, NPROutline, ContactShadows, Weather, ProceduralClouds,
FlowField, Ocean). **Biggest single win: Model** (drops the 215 KB `ModelPBRComplete.js` WGSL string import
`WebGPUModelRenderer` drags in). Others: Vector3DTile ×3, ShadowMap, VolumetricFog (65 KB), StarField, HiZ,
GPUSortKeys, ComputeInstance, EntityCluster, DynamicEnvironmentMap, CubeMapPanorama.
- **STOP-AND-CHECK:** lazifying Model interacts with C10-07 (which prewarms model pipelines). If C10-07 has
  landed, ensure its model prewarm still resolves the loader before prewarming — coordinate ordering. Keep
  eager = globe + imagery + sky + post-process + picking + primitive/collection cores.
- This rider is genuinely a separate concern (build-graph shape, not boot concurrency). Prefer to split it
  into its own C10 slice if the reviewer is strict on one-concern-per-slice; keep it here only as a small
  mechanical follow-on.

#### Traps

- **T-06-a — prewarm that misses the cache key does nothing.** If your prewarmed descriptor differs by one
  field (sample count, depth format, a define bit) from the lazy path's descriptor, the frame-1 lazy build
  is a cache MISS and recompiles anyway. The oracle: after boot, `WebGPURenderPipelineCache.getStats()`
  should show the deterministic set as `hits`, not `created`, on frame 1. If they're `created`, your
  descriptors diverged.
- **T-06-b — awaiting the prewarm re-serializes it.** The whole point is fire-and-forget. If you `await
  preloadBatch(...)` you've just moved the compile wall back onto the init path. Non-awaited, catch-dropped.
- **T-06-c — shaderCode availability ordering** (see Step C.1 STOP-AND-BLOCK). The single most likely reason
  the globe prewarm silently no-ops: `getShaderCode()` returns null/undefined at the moment you call it, so
  `initialize` bails. Log-check it in a debug pragma before claiming the prewarm ran.
- **T-06-d — static-importing PrimitiveIndexUtils bloats the eager chunk.** Only do it if its transitive
  imports are light (Step A.2 check). Otherwise you've traded a 5–20 ms serial import for tens of ms of
  extra eager parse.
- **T-06-e — adapter prefetch on a non-WebGPU plan.** Only prefetch when `getRendererAttemptPlan` actually
  resolves to WebGPU (or AUTO→WebGPU). Firing `requestAdapter` on a WebGL-only page is wasted GPU-process
  wakeup and can spuriously initialize the GPU process.
- **T-06-f — multi-context / device-loss.** Prewarm caches are per-device. On device loss the caches clear
  (`WebGPUShaderModuleCache` clears on device loss); ensure a re-init re-prewarms rather than assuming the
  first prewarm still holds.
- **T-06-g — the comment lies about perceptibility.** `_warmUpPipelines` claims first-frame stutter is
  "below the perceptible threshold." Falsified by 6/6 measured artifacts (+146–200 ms). Do not let the
  comment talk you out of the work; delete/replace it.

#### Verification recipe

1. Build gate: `npx tsc --noEmit` then `npx gulp build`.
2. **TTFF oracle (primary).** Reuse the C9-30 stack (`CAMPAIGN9_OPUS_EXECUTION_GUIDE` G10 Part A). Run the
   deterministic-offline-boot profile that produced the baseline artifact, or the moving-altitude campaign
   with `--renderer both --repetitions 5` clean lane
   (`Tools/visual-regression/run-performance-campaign.mjs`, Edge, fresh-process-per-run default). PASS =
   `rendererReady→firstFrame` WebGPU delta vs WebGL shrinks from the recorded **9.1× / +146 ms** by ≥5 % of
   the named-stage p95 (target: materially below the +146 ms floor), with the on/off/restored oracle (build
   with prewarm, without, and reverted → three runs; the middle must reproduce baseline).
3. **Cache-hit oracle (mechanism proof).** Add a temporary debug-pragma dump of
   `context.webgpuRenderPipelineCache.getStats()` (or `CesiumDebug.pipelineStatus()`) at first-frame end.
   The deterministic set must show as cache `hits`/`created` from the prewarm, not first compiled in the
   render frame. This proves T-06-a didn't bite.
4. **Byte-identical visual oracle.** `node Tools/visual-regression/capture-and-diff.mjs --scene globe-default`
   — WebGPU-vs-WebGL diff must not regress vs pre-change baseline. Read the PNGs yourself (Principle 8): the
   globe/sky/depth must look identical; prewarm changes *timing*, never pixels.
5. **No-hang oracle.** Confirm the viewer still boots with WebGPU and with WebGL
   (`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu` and `=webgl`), no console errors,
   frame renders. Run `node Tools/variant-smoke-test.mjs` if you touched the eager/lazy graph (rider).

#### Rollback boundary

Each sub-step is independently revertible. The optimization is the prewarm/concurrency wiring; the *feature*
is unchanged (globe still renders via the same descriptors). If the TTFF oracle shows no gain or a
regression, revert the prewarm wiring (Step C) and/or the concurrency plumbing (Step B) — the lazy first-frame
path is still there and correct. Do NOT roll back by disabling globe/sky/PP. Step A (dead-await deletion) is
strictly safe and can stay even if B/C are reverted. Ledger the outcome with the measured
`rendererReady→firstFrame` numbers named.

#### Pointers

- `WebGPUContext.ts:1001, 1065, 1108-1118, 1142-1181, 419` · `ContextFactory.ts:103-106` ·
  `RendererType.ts:127, 269` · `WebGPUDevicePool.ts:~745-793` · `Widget/CesiumWidget.js:763, 806, 776, 833`
- `WebGPUGlobeSurfaceShaders.ts:84, 100-108` · `GlobeSurfaceTileProviderRendering.js:788, 858-865`
- `WebGPURenderPipelineCache.ts:344 (getPipeline), 531 (async), 765 (preloadBatch, 0 callers)` ·
  `WebGPUShaderCache.ts:194 (0 callers)` · `WebGPUFeatureRenderers.ts:~244`
- `WebGPUPrimitiveShaders.js:246-249` · `WebGPUCollectionShaders.js:66-69` (no-ops)

---

### C10-07-ASYNC-MODEL-PIPELINES (W8-7)

**Lands AFTER C10-06, BEFORE C10-08.** C10-08 multiplies the variant/compile count; without async compile
scheduling in place first, 08 regresses TTFF (S3-6 explicitly: "these two must land together"; async first).

#### Architecture today (verified)

Repo census (live tree, `Renderer/WebGPU`): **132 sync `device.createRenderPipeline(`** vs **5
`createRenderPipelineAsync`**; **54 sync `createComputePipeline`**. The async pattern that fixed the globe
was never propagated.

**The globe reference pattern (the one you copy).** `WebGPUGlobeSurfacePipelines.ts:586-621`
`resolveGlobePipelineEntry(host, entry)`:
```js
if (entry.pipeline) return entry.pipeline;                 // already resolved
const sync = pipelineCache.getPipelineSync(entry.descriptor);
if (sync) { entry.pipeline = sync; entry.pending = false; return sync; }   // cache hit
if (!entry.pending) {                                       // kick async once
  entry.pending = true;
  pipelineCache.getPipeline(entry.descriptor)               // → createRenderPipelineAsync (:531)
    .then((p) => { entry.pipeline = p; entry.pending = false; })
    .catch(() => { entry.pending = false; });
}
return null;                                                // ← caller tolerates null = skip this frame
```
And the **documented sync escape hatch** for must-render passes:
`resolveCapturePipelineEntrySync` (`:642-668`) builds synchronously on first miss because the scene-capture
pass runs at most every K frames and a missed frame leaves a sky-only reflection. This is the ONLY
sanctioned reason to stay sync.

**The model path is fully sync.** `WebGPUModelPipelineCache.ts` has **12 sync `createRenderPipeline` sites**
(`:900` createPipeline, `:1017` silhouetteModel, `:1091` silhouetteColor, `:1192` pick, `:1249` pickMetadata,
`:1316` capture, `:1374` pickHover, `:1452` pickPrecisePass1, `:1535` pickPrecisePass2, `:1604` velocity,
`:1698` classification, plus `:3147` the magenta error pipeline) and **zero async**. The public entry
`getPipeline(alphaMode, doubleSided, materialDefines)` at `:3056-3115` compiles synchronously mid-draw:
```js
this._device.pushErrorScope("validation");
pipeline = createPipeline(this._device, this._getOrCreateShaderModule(md), this._getOrCreatePipelineLayout(md), ...);  // :3087 sync
this._device.popErrorScope().then((error) => { if (error) { ...swap magenta...; this._errorSwapGeneration++; } });
this._pipelines.set(key, pipeline);
return pipeline;
```
Each first-seen variant compiles a pipeline over the **215,428-byte** `ModelPBRComplete.js` monolith
synchronously (first textured model, first skinned, first alpha-masked, pick/pickHover/metadata-pick/
velocity/classification entry points, HDR/format flip). Tens-to-hundreds of ms per pipeline in DXC on
Windows.

**The consumer already tolerates null.** `WebGPUModelRenderer.ts` caches
`primCache.pipeline = pipelineCache.getPipeline(...)` at `:2804, :4830, :6045`. Crucially it already handles
a null pipeline: `:3940` sets `pc.pipeline = null`, and the refetch guard at `:4822-4844` re-fetches when
`primCache.pipeline === null`:
```js
if (primCache._pipelineNeedsRefetch || primCache.pipeline === null || errorSwapped) {
  primCache.pipeline = pipelineCache.getPipeline(matInfo.alphaMode, matInfo.isDoubleSided, md);
  ...
}
```
So the render frontend re-polls a null pipeline every frame — the exact seam an async "return null while
cooking" needs. **What you MUST verify:** that the draw executor actually *skips* the draw when
`primCache.pipeline` is null (rather than binding a null pipeline → validation error). Grep the executor for
where `primCache.pipeline` / `pc.pipeline` is consumed at encode time and confirm a null-guard exists; if it
does not, adding the null-skip guard is part of this slice (conservative: skip the draw, the refetch brings
it back next frame).

Also sync-and-unqueued: **post-process** `_compileStage` (`WebGPUPostProcessPipeline.ts:1975`, its sync
`device.createRenderPipeline` at `:2061`; identity at `:678`; tonemap `:741`, colorGrading `:833`, fxaa
`:902`) with **no central-cache participation** — and an **HDR toggle destroys and sync-recompiles the entire
PP stage set** (`WebGPUSceneRendererEnsureResources.ts:444-450` destroy → `:453-509` recreate every stage).
Plus mipmap/reprojection/environment pipelines.

#### Target design + invariants

- **INV-07-1 (async-first with tolerate-one-frame).** Every model pipeline miss returns null (or the
  previous cached variant) for the cooking frame and resolves via `createRenderPipelineAsync` through the
  central `WebGPURenderPipelineCache`, exactly like `resolveGlobePipelineEntry`. The draw is skipped that
  frame, not drawn with a wrong/null pipeline.
- **INV-07-2 (sync escape hatch only for documented must-render passes).** Keep synchronous compile ONLY
  where a skipped frame is visibly wrong and the pass is not re-run promptly — the capture-pass precedent
  (`resolveCapturePipelineEntrySync`). Everything on the normal on-screen draw path (which re-runs every
  frame) tolerates the skip. Pick pipelines: a pick that fires during a cooking frame must not silently
  return a wrong hit — decide per-pass (see decision point) whether pick uses the sync hatch or defers the
  pick a frame.
- **INV-07-3 (error-scope semantics preserved).** The C2-22 magenta-error-swap contract (`:3086-3112`) must
  survive: an invalid async pipeline still resolves its error scope, still swaps to magenta, still bumps
  `_errorSwapGeneration` so `WebGPUModelRenderer`'s `errorSwapped` refetch (`:4820`) reaches the built
  command. Async resolution and the existing `popErrorScope().then(...)` compose — do not drop the error
  path.
- **INV-07-4 (byte-identical output, one-frame-later at most).** Same pipeline, same descriptor, produced
  async. The only observable change is a ≤1-frame delay before a *newly-seen* variant first draws. Steady
  state (cache warm) is identical.
- **INV-07-5 (PP async without breaking HDR toggle).** PP stages route through the central async cache;
  the HDR toggle must **prewarm the new-format stage set before tearing down the old** (build new, then
  destroy old) so the toggle frame doesn't show an unrendered PP chain. Never leave the canvas without a
  blit — WebGPU REQUIRES the PP blit to reach the canvas (CLAUDE.md).
- **INV-07-6 (prewarm the model variant matrix).** At model-resources-ready time, prewarm the model's
  actual variant set (main + pick + the alpha/doubleSided/material-define combos the model will use) so the
  first draw is a cache hit, not a cooking skip. This is the model analogue of C10-06's globe prewarm.

#### Implementation walkthrough

**Step 1 — give `WebGPUModelPipelineCache` a central async cache handle + async resolve.**
1. Confirm the cache has (or wire) a `_centralPipelineCache` reference to the context's
   `WebGPURenderPipelineCache` (grep — the globe host uses `host._centralPipelineCache`). If the model cache
   currently owns only its local `_pipelines` Map (`:3069`) and a local `_shaderModuleCache` Map (`:1968`),
   add the central-cache handle at construction (same one the globe uses, off the context).
2. Refactor `getPipeline` (`:3056`) to the resolve pattern: build the descriptor (the same inputs
   `createPipeline` consumes: module, layout, formats, alphaMode, doubleSided, sampleCount, topology,
   metadataSlotMode), then:
   - `const sync = central.getPipelineSync(descriptor); if (sync) { cache + return sync; }`
   - if a per-key `pending` flag isn't set, set it and kick `central.getPipeline(descriptor).then(p => set
     cache[key]=p, clear pending).catch(clear pending)`, then `return null`.
   - **Decision point — descriptor construction:** `WebGPURenderPipelineCache` expects a
     `WebGPURenderPipelineDescriptor` (its own descriptor type, `getPipeline` at `:344`), whereas
     `createPipeline` (`:849`) builds a raw `GPURenderPipelineDescriptor` inline. You must express the model
     pipeline as the central cache's descriptor type so `generateCacheKey` (`:348`) dedupes it. Reuse the
     model cache's existing `computeKey`/`_metadataVariantKey` as the `variant` discriminator OR map the raw
     descriptor into the central type. Prefer the latter (one descriptor shape system-wide). Verify
     `WebGPURenderPipelineDescriptor` can represent everything `createPipeline` sets (MRT targets, depth
     stencil, multisample, topology) — if it cannot, extend it (add-only) rather than forking a parallel
     path.
   - **STOP-AND-BLOCK:** if the central descriptor type genuinely cannot express a model-only field, do NOT
     hack a private sync path around it — surface the missing descriptor field as the immediate next work
     item (Principle 9) and, in the interim, keep that specific variant sync via the documented escape hatch
     with a comment. Do not silently route around it.
3. Preserve the error scope: wrap the async creation (inside `createPipelineAsync` in the central cache, or
   in the `.then`) with the same `pushErrorScope("validation")` / `popErrorScope().then` magenta-swap +
   `_errorSwapGeneration++`. The central cache's `getPipeline` (`:344-...`) already runs the create inside
   its own bookkeeping — thread the error handling through, or keep the error-scope in the model cache's
   `.then`.

**Step 2 — the must-render decision for pick/velocity/classification.**
- On-screen color pipeline: async null-skip is safe (frame re-runs). Confirm the executor null-guard
  (INV-07-1 verification above).
- **Pick** (`getPickPipeline`, `:3204` region): a pick request in a frame where the pick pipeline is still
  cooking must not return a wrong result. Decision: either (a) use `resolveCapturePipelineEntrySync`-style
  sync build for pick pipelines (pick is user-initiated, infrequent, a one-time sync stall is acceptable
  and correct), OR (b) defer the pick one frame and re-issue. **Prefer (a)** — matches the capture-pass
  precedent and avoids a pick-correctness hazard. Document it with the same comment style as `:624-641`.
- Velocity/classification: async-safe if their consumers tolerate a one-frame absence (TAA velocity: a
  missing velocity frame degrades to no-motion-vector that frame — acceptable; classification: verify the
  classification pass tolerates a skipped model). If unsure, conservative = sync escape hatch with a
  comment naming the uncertainty.

**Step 3 — model variant prewarm (INV-07-6).** At model-resources-ready (grep where
`WebGPUModelRenderer` finishes texture/buffer upload for a model), enumerate the model's actual variant set
and `preloadBatch` them through the central cache non-awaited. The `prewarm()` that already exists on the
module cache only compiles *shader modules*, not pipelines (S3-6) — this adds the pipeline prewarm.

**Step 4 — post-process async + HDR-toggle prewarm.**
1. Route `_compileStage` (`WebGPUPostProcessPipeline.ts:1975`, sync create at `:2061`) and the identity
   pipeline (`:678`) through the central async cache with the tolerate-one-frame fallback. PP stages run
   every frame on-screen, so a one-frame skip is invisible EXCEPT the final blit — the identity/blit stage
   must stay available (build it in the C10-06 prewarm set; it's deterministic). Conservative: keep the
   final canvas blit on a guaranteed-present pipeline (prewarmed), async only the effect stages.
2. HDR toggle (`WebGPUSceneRendererEnsureResources.ts:444-450`): change destroy-then-recreate to
   **build-new-then-destroy-old**. Prewarm the new-format stage set (tonemap/FXAA/auto-exposure at the new
   `rgba16float`↔canvas format) before `host._postProcess.destroy()`, so no frame renders without a PP
   chain. This is the general fix for the "re-pays the wall at every `highDynamicRange` transition" shape.
3. mipmap generator / imagery reprojection (render+compute) / environment pipelines: route through the
   central caches (render → `WebGPURenderPipelineCache`; compute → `WebGPUComputePipelineCache`). Lower
   priority than model + PP; include if budget allows, else surface as follow-on.

**Priority order (from S8-3):** model cache → PP stages → mipmap/reprojection → environment.

#### Traps

- **T-07-a — binding a null pipeline crashes the pass.** The whole design depends on the executor skipping
  the draw when the pipeline is null. If any encode site does `pass.setPipeline(primCache.pipeline)` without
  a null-guard, async null-return produces a validation error / device loss. Verify/patch every consumer,
  not just the three `getPipeline` call sites.
- **T-07-b — losing the C2-22 magenta swap.** If you move creation into the central cache and drop the
  `pushErrorScope`/`_errorSwapGeneration` plumbing, a broken shader silently renders nothing instead of
  magenta, and the renderer's `errorSwapped` refetch never fires. Keep the error contract intact
  (INV-07-3). Test it with the C2-22 forced-error probe (`WebGPUModelPipelineCache.ts:2455` region gates a
  debug garbage-WGSL module — there's an existing probe hook).
- **T-07-c — specialization-before-async regresses TTFF.** This is why order matters. If C10-08 lands first,
  you get more-but-still-sync compiles; the moving-altitude p95/p99 spikes get WORSE. Async first, always.
- **T-07-d — HDR toggle black frame.** destroy-then-recreate leaves one frame with no PP pipeline → the
  canvas blit has nothing to draw → black flash. build-new-then-destroy-old (INV-07-5). WebGPU cannot render
  directly to canvas without the PP blit.
- **T-07-e — pick correctness under async.** A cooking pick pipeline returning null must not resolve as
  "nothing picked." Use the sync hatch for pick (Step 2a) or defer.
- **T-07-f — descriptor divergence between prewarm and draw** (same as T-06-a). Prewarm must produce the
  identical central-cache key the draw path will request, or it's wasted.
- **T-07-g — local vs central module cache.** The model cache currently has its own `_shaderModuleCache`
  Map (`:1968`), separate from the device-level `WebGPUShaderModuleCache`. Async *pipeline* creation is
  independent of *module* caching — do not conflate. This slice is pipelines; the module-cache unification
  is C10-08's concern.

#### Verification recipe

1. Build gate: `npx tsc --noEmit` && `npx gulp build`.
2. **Draw-path async oracle.** A probe under `Tools/visual-regression/probe-*.mjs` that loads a tileset /
   glTF model (e.g. the model-IBL or a b3dm city scene). Confirm (a) no synchronous `createRenderPipeline`
   fires on the model draw path — instrument via `CesiumDebug.pipelineStatus()` / the pipeline cache stats
   showing `pending` then `created` async, and (b) the model renders correctly within ≤1 frame of first
   appearance (read the PNG — no missing/magenta model).
3. **p99 hitch oracle (primary metric).** Moving-altitude campaign with a tileset workload,
   `--api-instrumentation` lane, 5 counterbalanced reps. PASS = the p99 tile/model-arrival frame spikes
   drop measurably on the descent vs the pre-change baseline (the sync-compile hitches were the spikes).
   Clean lane separately for CPU p95. Acceptance from the register row: "zero synchronous createRenderPipeline
   on the draw path for models/PP; p99 tile-arrival frame spikes drop on the moving-altitude descent."
4. **HDR-toggle oracle.** Toggle `scene.highDynamicRange` at runtime in the viewer; confirm no black flash
   frame and no sync recompile stall (visual + a frame-time capture across the toggle).
5. **C2-22 error oracle.** Trigger the forced-error path (the debug garbage-WGSL gate near `:2455`); confirm
   the model still swaps to magenta (error contract survived async).
6. **Byte-identical steady-state.** `capture-and-diff.mjs` on a model scene — warm-cache output identical to
   baseline.

#### Rollback boundary

The optimization is compile *scheduling* (async + skip-one-frame + prewarm). The feature (models, PP, HDR)
is unchanged. If the p99 oracle shows no gain, revert to sync `getPipeline` — models still render. Never
roll back by disabling models/PP/HDR. The error-swap contract, pick correctness, and the canvas blit are
correctness invariants that survive any rollback. Ledger with the p99 delta named.

#### Pointers

- `WebGPUModelPipelineCache.ts:3056 (getPipeline), 849/1017/1091/1192/1249/1316/1374/1452/1535/1604/1698
  (12 sync sites), 3147 (error), 3086-3112 (C2-22 error scope), 237-282 (MATERIAL_DEFINE_MASK),
  301-307 (computeKey), 1968 (local module map)`
- `WebGPUModelRenderer.ts:2804, 3940, 4820-4844, 6045 (getPipeline callers + null-tolerant refetch)`
- `WebGPUGlobeSurfacePipelines.ts:586-621 (async reference pattern), 642-668 (sync escape hatch)`
- `WebGPURenderPipelineCache.ts:344 (getPipeline), 531 (createRenderPipelineAsync), 765 (preloadBatch)`
- `WebGPUPostProcessPipeline.ts:678, 741, 833, 902, 1975, 2061` ·
  `WebGPUSceneRendererEnsureResources.ts:444-450 (HDR destroy), 453-509 (PP stage build)`

---

### C10-08-MODEL-SHADER-SPECIALIZATION-AXES (W8-8)

**Lands LAST — AFTER C10-07.** Specialization multiplies the pipeline-compile count (more variants, each
smaller). Without C10-07's async scheduling, this regresses TTFF (S3-6/S5-1). Add-only bit discipline is
mandatory (see the STOP-AND-BLOCK below — the register is nearly full).

#### Architecture today (verified)

`ModelPBRComplete.wgsl` (4,115 lines / 215,428 B twin) is a **runtime-flag uber-shader**: **70 `hasFlag()`
material branches** decide clearcoat/sheen/iridescence/anisotropy/transmission/volume/normal-map/MR/
emissive/occlusion/unlit/alpha-mode per-fragment at runtime, plus skinning/morph/instancing decided at
*runtime* in the VS. Only ~10 features are compile-time defines today. Bind group 1 = **39 bindings, 25
textures**, bound with placeholders for every untextured mesh. Tint fully inlines; the backend compiles the
*union* of all features into one ISA and allocates registers for the worst path — so a base-color-only draw
(the majority of any b3dm city) runs at the occupancy of the clearcoat+sheen+iridescence+transmission+CSM+IBL
superset. Uniform branches skip *execution*, not *register allocation*. This is the structural reason
model-heavy WebGPU scenes trail WebGL (which builds per-material specialized GLSL via `ShaderBuilder`
defines) even after CPU-side churn fixes.

**The specialization infrastructure exists and is proven.** The `//>>ifdef` preprocessor
(`WebGPUShaderPreprocessor.ts`), the `ShaderDefine` bitmask registry
(`WebGPUShaderDefines.ts`), and the device-level `WebGPUShaderModuleCache` (40-bit key
`((defines >>> 0) * 0x100) + sourceId`, `WebGPUShaderModuleCache.ts:90-97`, sourceId 0-0xff) already
specialize `MODEL_HAS_KHR_TEXTURES`, `MODEL_HAS_TEXCOORD_1`, `MODEL_HAS_METADATA`, etc. The model cache
builds `effectiveDefines` at `WebGPUModelPipelineCache.ts:2510-2519` by OR-ing material-mask bits with
render-mode bits (LOG_DEPTH, CAPTURE_MODE, SPLIT, HAS_COLOR, SILHOUETTE, METADATA_PICKING, MAT_TRANSPORT).

**⚠ THE BINDING CONSTRAINT — the ShaderDefine registry is nearly FULL.** Verified at
`WebGPUShaderDefines.ts:38-848`: bits **0 through 30 are all occupied** (`GEODETIC_NORMAL = 1<<0` …
`MODEL_METADATA_MAT_TRANSPORT = 1<<30`). The mask is a **Uint32**. Bit 31 is the JS sign-bit hazard
(`1<<31` = −2147483648; usable only via `>>> 0` at key time, and NEVER as a material-mask bit — see below).
**There is at most ONE free define slot. The task's literal "promote ~8 axes to ShaderDefine bits" cannot
be satisfied in the current representation.**

Two further packing limits, both verified:
- **`computeKey` packs material defines with `md << 3`** (`WebGPUModelPipelineCache.ts:306-307`). `md` is
  masked to `MATERIAL_DEFINE_MASK` (`:237-282`, currently max bit = `MODEL_HAS_WGSL_CUSTOM_VERTEX = 1<<24`).
  Any *material-mask* bit ≥ bit 29 overflows the 32-bit key under `<<3`. The registry comment at
  `WebGPUShaderDefines.ts:832` and the model cache comment at `:2499-2504` both state exactly this:
  "bit 30 would overflow computeKey's `md << 3` pipeline-key packing." So bits 29/30 are deliberately
  render-mode-only, NOT material-mask.
- **Two define scopes for models:** *material-mask bits* participate in `computeKey` (pipeline layout key,
  must be ≤ ~bit 28); *render-mode bits* participate only in the module hash / `effectiveDefines`
  (`:2510-2519`) and can be higher. A new axis that changes bindings/vertex-layout MUST be a material-mask
  bit (constrained). A new axis that only forks the module (all its textures already bound via placeholder)
  can be a render-mode bit.

#### Target design + invariants

- **INV-08-1 (add-only bit discipline).** NEVER reorder, renumber, or remove a `ShaderDefine` entry
  (reordering silently aliases cached modules; removal breaks pipelines referencing the bit). New bits
  append at the next free position with a JSDoc block naming what they gate and which shaders consume them.
  Same rule for `ShaderSourceId`.
- **INV-08-2 (bit-budget-honest scope).** Promote only as many axes as there are usable bits under the
  constraint above. With bits 0-30 full, that is realistically **one** new render-mode bit today unless the
  representation is widened. Rank the 8 candidate axes by *separation value* (below) and promote the
  highest-value ones that FIT. Surface the remainder as blocked-on-define-width follow-on (Principle 9) —
  do NOT silently drop them or hack a parallel un-cached path.
- **INV-08-3 (per-primitive stability).** Every promoted bit must be *stable per primitive* (decided once at
  material/primitive setup, not varying per frame), so the module/pipeline cache key is stable and the
  variant count stays bounded. A bit that flickers per frame thrashes the cache — worse than a runtime flag.
- **INV-08-4 (runtime flags stay for cheap scalars).** Only promote axes with high *register/occupancy*
  separation (whole feature blocks: KHR extensions, shadow mode, IBL mode, VS chains). Keep runtime
  `hasFlag()` for cheap scalar factors (a multiply, a lerp) — specializing those just multiplies variants
  for no occupancy gain.
- **INV-08-5 (byte-identical per variant).** A specialized variant must render identically to what the
  runtime-flag path produced for that same flag combination. The `//>>else` branch of every new `//>>ifdef`
  block is the historical runtime-flag code path (migration-safe: `defines=0` must be byte-identical to
  today).
- **INV-08-6 (async prerequisite).** C10-07 must have landed: each new variant is an async pipeline compile.
  If C10-07 is NOT green, STOP — do not land 08 (it will regress the p99 moving-altitude oracle).

#### The 8 axes, ranked by separation value (from S3-4)

Rank = occupancy/register-pressure separation × how often the *default* draw avoids the feature. Scope tag =
which define scope it needs.

| Rank | Axis | New define(s) | Scope | Why (separation) |
|---|---|---|---|---|
| 1 | Shadow mode (none / CSM / point) | `MODEL_SHADOW_MODE_*` (mode, ≤2 bits or reuse) | module hash (render-mode) | 9-tap PCF CSM + 2-cascade blend (:1585-1615) + point-light cube shadows (:1690+) inline unconditionally; most draws take none |
| 2 | IBL mode (SH vs cubemap / off) | `MODEL_IBL_MODE_*` | module hash | Fdez-Aguera IBL + SH + parallax reflections (:3280-3400) — heavy, often off |
| 3 | `HAS_NORMAL_TEXTURE` | 1 bit | material-mask (binding + deriv chain) | normal-map sample + TBN derivation; absent on flat-shaded meshes |
| 4 | Per-KHR extension bits (clearcoat / sheen / iridescence / anisotropy / transmission+volume) | up to 5 bits | material-mask (bindings) | each is a full BRDF lobe block; ~zero default b3dm uses any. Currently ALL gated by the single coarse `MODEL_HAS_KHR_TEXTURES` |
| 5 | `MODEL_HAS_VELOCITY` (S3-5) | 1 bit | module + pipeline (VS varyings) | main-pass VS unconditionally runs the prev-frame morph→skin→instance chain + 2 varyings (:1012-1067) even with no TAA consumer |
| 6 | `HAS_SKINNING` | 1 bit | material-mask (VS + vertex layout) | skin matrix fetch loop; static meshes skip |
| 7 | `HAS_MORPH` | 1 bit | material-mask (VS) | morph-target blend; most meshes skip |
| 8 | `HAS_INSTANCING` | 1 bit | material-mask (VS) | instance-transform fetch; non-instanced skip |

**Reality:** ranks 1-2 (shadow + IBL mode) are render-mode-scoped (module hash only, no binding change) and
give the largest occupancy separation for the least bit cost — these are the FIRST to promote and the most
likely to fit in the ≤1 free bit. Ranks 3-8 are material-mask-scoped and hit the `computeKey` `<<3`
constraint AND the exhausted-bit constraint hardest.

#### Implementation walkthrough

**Step 0 — STOP-AND-BLOCK: audit the bit budget FIRST.**
1. Re-grep `WebGPUShaderDefines.ts` for the highest occupied bit (today: `1<<30`). Count free slots in the
   Uint32 (today: bit 31 only, and it is material-mask-illegal).
2. **Decision:**
   - **If ≥ the needed bits are free** (won't happen without widening): promote per the ranked table,
     add-only.
   - **If < needed (the real case):** the slice's honest deliverable is:
     (a) promote the **highest-separation axis that fits as a render-mode bit** (shadow mode OR IBL mode) in
     the one available slot, proving the mechanism and banking the occupancy win; AND
     (b) **surface the define-width expansion as the immediate next work item** (Principle 9) — the registry
     must move from Uint32 to a wider representation (a hi/lo Uint32 pair or a Number/BigInt mask) before
     the remaining 6-7 axes can be promoted. This is a cross-cutting prerequisite touching:
     `WebGPUShaderModuleCache` key (`((defines>>>0)*0x100)+sourceId`), `computeKey`'s `md << 3`,
     `MATERIAL_DEFINE_MASK`, `WebGPUShaderPreprocessor` flag resolution, and **every** `(x & BIT)` site.
     Do NOT attempt the widening inside this slice (one-concern rule) — name it as `C10-08b` / a follow-on.
   - **Do NOT** work around the shortage with a private model-only define namespace that bypasses the shared
     preprocessor/module cache — that fragments the specialization infrastructure and violates the
     shared-registry contract. Surface, don't route around.

**Step 1 — promote the winning render-mode axis (shadow mode, the rank-1 fit).**
1. Add ONE new `ShaderDefine` entry at the next free bit (append; JSDoc naming the gated CSM/point-shadow
   blocks and that `ModelPBRComplete.wgsl` consumes it). If shadow mode needs 3 states (none/CSM/point) and
   only 1 bit is free, encode the common split (has-shadow vs none) in the bit and keep CSM-vs-point as a
   cheaper runtime sub-branch, OR use the bit for the heaviest separation (CSM present vs absent). Pick the
   split with the most default-draw avoidance.
2. In `ModelPBRComplete.wgsl`, wrap the CSM/point-shadow inline blocks (:1585-1615, :1690+) in
   `//>>ifdef MODEL_SHADOW_*` / `//>>else` (the `//>>else` branch = today's runtime code, or empty for the
   no-shadow variant) / `//>>endif`. Flag name must match `UPPERCASE_WITH_UNDERSCORES` and resolve to the
   new bit (unknown flags throw at preprocess with the source line — typos fail loud).
3. Set the bit in the model cache's `effectiveDefines` (`:2510-2519`) from the per-primitive shadow state
   (mirror how `_logDepthEnabled`/`_splitEnabled` are set via `maybeUpdateForShadow`-style sticky flags —
   grep the existing `maybeUpdateForSplit`/`maybeUpdateForModelColor` pattern at `:2481-2498` and add the
   analogue). Because it's render-mode-scoped it goes in `effectiveDefines` (module hash) but NOT in
   `computeKey`/`MATERIAL_DEFINE_MASK` (no BGL change — verify the shadow blocks read only existing
   @group(0)/existing bindings; if a shadow variant changes bindings it becomes material-mask-scoped and
   hits the constraint).
4. The module cache already keys by `effectiveDefines` — the new variant is cached automatically. The
   pipeline is created async (C10-07). Prewarm the no-shadow + shadow variants at model-resources-ready
   (C10-07 Step 3).

**Step 2 — verify variant count stays bounded.** After the change, a scene mixes at most 2× the previous
model pipeline count (shadow on/off). Confirm via `CesiumDebug.pipelineStatus()` / cache stats that the
count is bounded and stable (not growing per frame — INV-08-3).

**Step 3 — the deferred axes (if Step 0 blocked them).** Write the follow-on item precisely: which axes,
their scope tags, and that they are gated on the define-width expansion. Cross-reference
`migration_doc/DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C. Do not leave them as silent TODOs in code.

#### Traps

- **T-08-a — the register is full (THE trap).** An expert catches this in one grep; a cold worker will try
  to add 8 bits and either collide with bit 31's sign hazard or silently overflow `computeKey`. Audit bits
  FIRST (Step 0). This is a STOP-AND-BLOCK, not a "figure it out while coding."
- **T-08-b — material-mask bit ≥29 overflows `computeKey`'s `md << 3`.** Ranks 3-8 are material-mask-scoped;
  putting any of them in a high bit corrupts the pipeline key (two different variants collide → wrong
  pipeline drawn, a render-hole or wrong-material bug). Material-mask bits must stay ≤ bit 28. Verified
  constraint at `:2499-2504` + `:832`.
- **T-08-c — reordering/renumbering an existing bit.** Silently aliases every cached module compiled under
  the old numbering across all devices. Add-only, append-only, forever (INV-08-1).
- **T-08-d — a per-frame-flickering define.** If the promoted flag isn't per-primitive-stable, the module
  cache thrashes (compile every frame) — catastrophic. Mirror the sticky `maybeUpdateFor*` pattern; the flag
  must be set once at primitive setup.
- **T-08-e — landing before C10-07.** More variants × sync compile = worse p99. INV-08-6: async first.
- **T-08-f — non-byte-identical `//>>else`.** The else branch MUST reproduce today's runtime-flag output.
  `defines=0` must be byte-identical to the pre-change shader (the preprocessor guarantees this only if your
  else branch is the unchanged code). Diff the preprocessed `defines=0` output against the original source.
- **T-08-g — a shadow/IBL variant that changes bindings.** If wrapping a block in `//>>ifdef` also removes a
  binding from the layout, the axis silently becomes material-mask-scoped (must go in `MATERIAL_DEFINE_MASK`
  + `computeKey`, hitting the ≤bit-28 and full-register constraints). Verify the gated block reads only
  existing bindings before treating it as render-mode-scoped.
- **T-08-h — f16 temptation.** S3-4 mentions `enable f16` for the BRDF core as secondary relief. Do NOT fold
  it into this slice (separate concern, device-feature-gated, correctness-sensitive). It is a different task.

#### Verification recipe

1. Build gate: `npx tsc --noEmit` && `npx gulp build` (WGSL preprocessor runs in the build — a bad flag name
   throws at build time with the source line).
2. **Byte-identical oracle (per variant).** For each promoted variant, `capture-and-diff.mjs` on a scene
   exercising that flag combination (a shadowed model scene for shadow-mode). The specialized variant must
   diff-clean vs the pre-change runtime-flag output. Read PNGs (Principle 8).
3. **`defines=0` identity.** Confirm the preprocessed shader at `defines=0` (or the no-feature variant) is
   byte-identical to the original monolith's equivalent path (T-08-f).
4. **Variant-count bound.** `CesiumDebug.pipelineStatus()` on a mixed-model scene — pipeline count is
   bounded (≤ 2× per promoted binary axis) and stable across frames (INV-08-3/T-08-d).
5. **Occupancy/perf oracle (primary metric).** Moving-altitude campaign, tileset/model workload, clean lane,
   5 counterbalanced reps. PASS = ≥5 % improvement on the model-fill named-stage p95 (the register's bar) on
   a base-material-heavy scene (where the occupancy win is largest), with on/off/restored oracle. A truthful
   miss with all mechanics green (variants cached, byte-identical, bounded) is a VALID COMPLETE result —
   ledger it with the measured delta.
6. Confirm C10-07 is landed and its p99 oracle still green (no TTFF regression from the added variants).

#### Rollback boundary

The optimization is the specialization (splitting one runtime-flag shader into cached compile-time variants).
The feature — every material path, shadow, IBL — is unchanged; the `//>>else` branch IS the original code. If
the occupancy oracle shows no gain, revert the `//>>ifdef` wrapping and the `effectiveDefines` bit-set; the
runtime-flag monolith is restored byte-for-byte. **The new `ShaderDefine` bit, once added, stays** (add-only
— even a reverted feature keeps its bit reserved with a deprecation comment; never reclaim it). Never roll
back by removing a material feature. Ledger with the measured p95 delta and the bit-budget outcome named.

#### Pointers

- `WebGPUShaderDefines.ts:38-848 (registry, bits 0-30 FULL), 832 (md<<3 overflow note), 859+ (ShaderSourceId)`
- `WebGPUModelPipelineCache.ts:237-282 (MATERIAL_DEFINE_MASK), 301-307 (computeKey md<<3),
  2481-2519 (effectiveDefines + sticky maybeUpdateFor* pattern), 2499-2504 (bit-30 overflow comment)`
- `WebGPUShaderModuleCache.ts:90-97 (40-bit key), WebGPUShaderPreprocessor.ts (//>>ifdef)`
- `Shaders/WebGPU/Model/ModelPBRComplete.wgsl:1012-1067 (VS prev-frame chain), 1585-1615 (CSM),
  1690+ (point shadow), 3280-3400 (IBL), 396-448 (39-binding group)`
- CLAUDE.md "WGSL Shader Pipeline — Defines, Preprocessor, Module Cache" section (the add-only rules).

---

### Cross-cluster landing order (do not reorder)

```
C10-06 (boot concurrency + prewarm)  ──►  C10-07 (async model/PP pipelines)  ──►  C10-08 (specialization)
        independent win                    prerequisite for 08                   multiplies 07's compile count
```
- 06 before 07: 06's prewarm set (globe + PP identity/tonemap/FXAA) gives 07 a warm deterministic cache to
  build on; 07's PP-async work assumes the prewarm-on-init hook 06 adds.
- 07 before 08: 08 multiplies variant/compile count; only async scheduling (07) keeps that off the TTFF/p99
  critical path.
- Each is its own slice (one concern), its own commit(s), its own ledger row, its own oracle. A miss on one
  does not block the next if its mechanics are green.


---

<a id="h6"></a>

## C10 Guide Cluster — H6: Pick-Fleet Log-Depth + Depth-Plane Gate Flip

Two sequential slices, one concern each:

- **C10-11-PICK-FLEET-LOG-DEPTH** — convert the ENTIRE native WebGPU pick producer fleet to write
  logarithmic `frag_depth` against the shared full-frustum encode, mirroring the scene contract.
  Closes the C9 fallout item `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH`.
- **C10-12-PICK-DEPTH-PLANE-GATE-FLIP** — only AFTER C10-11 lands and every pick family is
  WebGL-parity-verified: flip `PICK_DEPTH_PLANE_ENABLED` to `true`, re-run the three-altitude horizon
  oracle with on/off/restored oracles, tighten the oracle to below-limb pixels, and close `C9-02B` +
  audit `P0-1`.

Do NOT attempt C10-12 before C10-11 is fully landed and verified. The two instrumented oracle runs on
2026-07-16 (evidence below) proved partial conversion breaks the unconverted fleet at defaults.

---

### Why this exists (the proven finding — read before touching code)

Primary sources (read in this order):
- `migration_doc/DEFERRED_WORK.md` → `## NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` (line **5229**; full math + evidence).
- `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` §S7-3 (line **706**), §15.5 (line **1372**), §17.6 (line **1442**).
- Scratchpad raw strata: `perfdive/S7-multifrustum-reversedz.md` §3 (line **157**) + the sequencing hazard (line **172**).
- Batch-673 commit `51e94d24d9` — the SCENE half that already landed (depth plane encodes against the
  full-frustum stash). This slice does the PICK half.

The two facts that force a fleet-wide (not per-participant) conversion:

1. **The pick FBO is hyperbolic today for every producer but one.** Every native pick producer
   EXCEPT compute-instance writes standard rasterizer z (no `@builtin(frag_depth)`), baked at UPDATE
   time against the camera's own frustum. *(Correction 2026-07-17: `ComputeInstanceRender.wgsl` is
   ALREADY log-depth-converted — `v_logDepth` under `//>>ifdef LOG_DEPTH`, `@builtin(frag_depth)` +
   `csm_writeLogDepth` in `fragmentPickMain`, pipeline reusing the LOG_DEPTH-compiled module. Use it
   as the fleet's reference pattern and drop it from the convert list — the fleet to convert is ~14,
   not ~15.)*
   Run 1 (2026-07-16) gave a log-`frag_depth` depth plane (~0.4–0.8) that over-occluded EVERY
   hyperbolic pick (~0.999+) across the whole globe disk — even the visible front control returned
   `null` at 20/500/5,000 km.
2. **Hyperbolic can never pass the far oracle even when made self-consistent.** With every producer on
   the shared update-time projection (near ≈ 1 m, far ≈ 5e8 m), plane-vs-marker separation at
   5,000 km is Δz ≈ n·Δ(1/d) ≈ **1.7e-8**, below one float32 ULP at z≈1.0 (≈6e-8); `less-equal` ties
   pass, so a beyond-horizon marker stays pickable. Only log-encoded pick depth has the far-field
   resolution the oracle demands. WebGL parity confirms the target: upstream's `LOG_DEPTH` wrapper
   applies to every derived pick shader, so the WebGL pick FBO is log.

Therefore: converting only the oracle participants (plane + points) breaks every other cohort at
defaults (a log plane over-occludes hyperbolic models/billboards/polylines/primitives; log points pick
through hyperbolic models). The ONLY correct end state is the WHOLE pick fleet writing log `frag_depth`
with ONE encode — the exact `_logDepthEncodeNearFar` full-frustum stash the depth plane already uses.

---

### Architecture today (verified against the live tree, post-Batch-674)

#### The scene half already landed (Batch 673, your template)
- `WebGPUDepthPlane.ts:784-824` — the depth plane now packs `(near, far, factor)` from
  `uniformState._logDepthEncodeNearFar` (the FULL camera frustum), NOT the per-slice `currentFrustum`.
  Factor is recomputed from the same pair: `factor = 1 / log2(far - near + 1)`. `currentFrustum` remains
  ONLY as the pre-stash early-frame fallback. **This is the exact encode contract every pick producer
  must adopt.**
- `WebGPUSceneRendererFrustumState.ts:29-33` — publishes the stash: `state._logDepthEncodeNearFar ??=
  new Float32Array(2); [0]=cameraFrustum.near; [1]=cameraFrustum.far`. Published by the globe camera-UB
  pack and by both frustum loops BEFORE any per-slice remap.
- Result: the horizon oracle's SCENE assertions went from all-fail (Sol run) to pass at 500 km/5,000 km,
  with only the sprite-above-limb residual at 20 km (screen-space quad above the limb — an oracle
  geometry artifact, not a depth bug; C10-12 tightens it).

#### The pick gate (what C10-12 flips)
- `WebGPUSceneRendererPickPass.ts:69` — `const PICK_DEPTH_PLANE_ENABLED = false;`
- `WebGPUSceneRendererPickPass.ts:496` — `if (PICK_DEPTH_PLANE_ENABLED && config.useDepthPlane) {
  host._renderDepthPlane(config, "pick"); }` inside the `clearGlobeDepth` reopen branch.
- The gate's JSDoc (`:52-68`) already records the fleet-conversion blocker verbatim.

#### The shared encode primitives
- `WebGPULogDepth.ts` — `isWebGPULogDepthActive(context, frameState)` = `context._logDepthWriteEnabled
  && frameState.useLogDepth` (master switch TRUE since Batch 251). `packCameraLogDepthLanes(data,
  floatBase, uniformState)` writes floats **51 (factor), 55 (near), 59 (far)** of the `CameraUniforms`
  struct from `uniformState.currentFrustum` + `oneOverLog2FarDepthFromNearPlusOne`.
- `Shaders/WebGPU/chunks/functions/csm_writeLogDepth.wgsl` — the canonical value fn:
  `fragDepth = log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne`. **Contract: the CALLER
  must `discard` when `depthFromNearPlusOne <= 0.9999999` (near cull) or beyond far — `discard` cannot
  live in the pure fn.**
- `Shaders/WebGPU/chunks/functions/csm_vertexLogDepth.*` — the vertex half that produces the
  interpolated `depthFromNearPlusOne` varying.

#### The pick pipeline builder — the key simplifier
- `WebGPUPickCommandHelpers.ts:357` `buildPickPipelineDescriptor(colorDescriptor, pickFragmentEntry,
  pickFormat, options)` — **reuses `colorFragment.module`** (line 401), swapping only `entryPoint` to
  the pick fragment fn and stamping exactly one LDR pick color target (`context.pickPipelineFormat`).
  It forces `depthWriteEnabled: true` (`:410`) and keeps the color descriptor's `depthStencil` shape
  (same `depthCompare`).
- **Consequence:** any pick entry living in the SAME module as its color sibling is already compiled
  WITH the `LOG_DEPTH` define and already has the `v_logDepth` varying available. Those families need
  ONLY a shader change to the pick entry's output struct — zero JS, no new define plumbing.

#### The fleet splits into TWO cohorts (verified — this is the load-bearing structural insight)

**Cohort A — shared-module pick entries (reuse the color module via `buildPickPipelineDescriptor`).**
The pick `@fragment` fn returns a plain `@location(0) vec4<f32>` today; the module already carries
`LOG_DEPTH` ifdefs + the `v_logDepth`/`g_fragLogDepth` varying from its color path.
- **Globe** — `GlobeTerrain.wgsl:3060` `fragmentPickMain(input) -> @location(0) vec4<f32> { return
  camera.pickColor; }`. Deliberate-design note at `:3044-3059` ("Writes STANDARD rasterizer depth … so
  the pick FBO depth stays consistent with the model / primitive pick pipelines"). Color `FragOutput`
  already has `//>>ifdef LOG_DEPTH @builtin(frag_depth) depth` at `:3016-3018`; `makeFragOutput` writes
  `csm_writeLogDepth(g_fragLogDepth, camera.logDepth.z)` at `:3039`; the `g_fragLogDepth` private stash
  is set from the varying at `:3135`. Globe camera UB is the bespoke 116-float layout (carries the log
  lanes in its own reserved slots per `WebGPULogDepth.ts:44-45`).
- **Model** — `ModelPBRComplete.wgsl`: `fragmentPickMain` (`:3793`), `fragmentPickHoverMain`
  (`:3730`), `fragmentPickMetadataMain` (`:3942`) all return `@location(0) vec4<f32>`. Color
  `FragOutput` has `@builtin(frag_depth)` at `:2352`; `v_logDepth` varying exists under LOG_DEPTH.
  Model camera UB packs log lanes at `WebGPUModelRenderer.ts:1050` (`packCameraLogDepthLanes(data, 0,
  uniformState)`).
- **Voxel** — `fragmentPickVoxelMain` is GENERATED WGSL inside `WebGPUVoxelRenderer.ts` (~:1103,
  entryPoint wired ~:2702); there is NO `*Voxel*.wgsl` under `Shaders/WebGPU`, so a Shaders-scoped
  grep returns nothing for voxel — enumerate it from the renderer. **Compute-instance** — already
  converted (see fact 1; reference pattern), and its `@fragment` sits on its own line, so the
  recipe's single-line `@fragment\s+fn` pattern misses it (use a multiline-tolerant grep).
  *(Correction 2026-07-17)*: at HEAD only `WebGPUGaussianSplatRenderer.ts`,
  `WebGPUEllipsoidPrimitiveRenderer.ts`, `WebGPUGlobeSurfacePipelines.ts`, and
  `WebGPUDerivedCommand.ts` import `buildPickPipelineDescriptor` DIRECTLY — GroundPrimitive /
  GroundPolyline / Vector3DTile* / Buffer* derive their pick variants via `WebGPUDerivedCommand`'s
  PICK machinery (which wraps the helper). Classify per family whether the pick entry is in the
  color module (Cohort A) or a dedicated pick module (Cohort B) using the grep recipe below.

**Cohort B — DEDICATED pick modules (standalone `.wgsl`, own vertex + `fragmentMain` entry).** These do
NOT reuse the color module, so they carry NEITHER the `LOG_DEPTH` define NOR the `v_logDepth` varying
today. Confirmed dedicated-module pick shaders:
- `Collections/BillboardCollectionPick.wgsl` — `@vertex fn vertexMain` (`:111`), `@fragment fn
  fragmentMain -> @location(0) vec4<f32>` (`:246`). No `frag_depth`.
- `Collections/PointPrimitivePick.wgsl` — vertex `:77`, fragment `:201`. No `frag_depth`.
- `Collections/PolylineCollectionPick.wgsl` — vertex `:84`, fragment `:190`. No `frag_depth`.
- `Primitive/PrimitivePick{Basic,BasicTextured,MatFlat,MatLit,Phong,PhongTextured}.wgsl` (6 files) —
  each `@fragment fn fragmentMain() -> @location(0) vec4<f32>`. No `frag_depth`.

`grep -Ln frag_depth Shaders/WebGPU/Collections/*Pick.wgsl Shaders/WebGPU/Primitive/*Pick.wgsl` returns
all 9 → confirms none write depth today. `grep -c frag_depth Shaders/WebGPU/**/*.wgsl` totals 74 files
on the COLOR side (the surface reversed-Z would later retire).

#### Why "per-slice pick UB refresh" is a trap, not a task
Native pick commands bind camera UBs baked at UPDATE time (before the frustum loop). In the pick pass,
`WebGPUSceneRendererPickPass.ts:383` `host._updateFrustumUniforms(uniformState, near, far, scene)`
remaps `uniformState` per slice — but that remap only reaches DRAW-TIME `uniformState` consumers (the
depth plane, redrawn per slice via `host._renderDepthPlane`). It does NOT re-bake the static pick camera
UBs. This is FINE and correct **as long as every producer's log encode uses the FULL-frustum pair**
(update-time `currentFrustum` == full camera frustum == `_logDepthEncodeNearFar`). It becomes a bug ONLY
if a producer bakes a per-slice narrow near/far — which is exactly the mistake Batch 673 fixed for the
plane. **The invariant is: one full-frustum encode for the whole fleet; never a per-slice remap of pick
depth.**

---

### Target design + invariants

**INV-1 (single encode).** Every native pick producer writes `frag_depth = csm_writeLogDepth(
depthFromNearPlusOne, factor)` where `(near, far, factor)` come from ONE source: the full-frustum
`_logDepthEncodeNearFar` stash (via the camera UB's baked log lanes 51/55/59), identical to the scene
color path and the depth plane. NO per-slice near/far in any pick encode.

**INV-2 (all-or-nothing on the shared pick FBO).** The pick FBO has one depth buffer shared by all
cohorts; a mixed hyperbolic/log fleet is incoherent by construction (the finding). C10-11 lands the
whole fleet in one slice, or not at all. No producer-by-producer landing.

**INV-3 (gated by the same predicate as scene).** Pick producers write log `frag_depth` exactly when
`isWebGPULogDepthActive(context, frameState)` is true — the same master switch that governs the color
path. Flipping `_logDepthWriteEnabled` false must restore hyperbolic pick depth everywhere (kill switch
parity). The `//>>else` branch of every new ifdef block keeps the historical standard-z pick output.

**INV-4 (near/far discard mirrors the color sibling).** Each pick entry adds the same
`depthFromNearPlusOne <= 0.9999999` (and far) `discard` its color sibling applies under LOG_DEPTH, so a
fragment behind the near plane is not written into the pick FBO (WebGL parity — upstream's pick shader
inherits the same cull).

**INV-5 (feature preservation).** No pick family is disabled, defaulted-off, or degraded to make the
oracle pass. Globe pick stays opt-in (`globe.pickable`); clipping/limit discards already present in a
pick entry stay present. This is correctness work, not a metric win.

**INV-6 (WebGL parity per family).** Each pick family's WebGPU pick result must match its WebGL control
at the near/mid/far altitudes — verified via that family's existing pick probe, not just the oracle.

**INV-7 (gate-flip is downstream).** `PICK_DEPTH_PLANE_ENABLED` stays `false` until C10-11 lands AND
all family probes are green. C10-12 flips it, re-runs the oracle with on/off/restored, and closes
C9-02B + P0-1.

**INV-8 (RTE + reversed-Z sequencing).** The `v_logDepth` varying is derived from RTE positions
(`csm_vertexLogDepth` over the RTE clip position) — no absolute planetary ECEF f32 pre-subtraction is
introduced. Log `frag_depth` is correct NOW under the current log-depth architecture; the later
reversed-Z slice (FAR-707 slice-b, next campaign) REMOVES `frag_depth` wholesale from all producers
(color + pick) to restore early-Z. C10-11 ADDS pick surface that FAR-707 must convert back. See
"Reversed-Z sequencing decision" below — the two streams must be cross-linked, never landed
simultaneously.

---

### Implementation walkthrough

#### Phase 0 — Enumerate the exact fleet (do NOT trust this list; re-derive)
Run, from `packages/engine/Source`:
```
# Cohort B (dedicated pick modules — hard cases):
grep -Ln frag_depth Shaders/WebGPU/Collections/*Pick.wgsl Shaders/WebGPU/Primitive/*Pick.wgsl
# Cohort A pick entries (shared modules):
grep -rnE "@fragment\s+fn\s+[a-zA-Z_]*[Pp]ick" Shaders/WebGPU
# Which renderers derive pick via the color module (Cohort A) vs a dedicated module (Cohort B):
grep -rn "buildPickPipelineDescriptor\|Pick.wgsl\|Pick.js" Renderer/WebGPU/*.ts Renderer/WebGPU/*.js
```
Produce a table: `family | pick shader | cohort (A/B) | camera UB packs log lanes? | pick probe`. If a
family's cohort is ambiguous (imports `buildPickPipelineDescriptor` AND a dedicated pick module), read
the actual pipeline build site to see which module + entry the pick pipeline uses. **Decision point: if
any family cannot be classified with certainty, STOP and record it — landing an unclassified family on
the shared pick FBO risks the mixed-encoding bug.**

#### Phase 1 — Convert Cohort A (shared-module entries) — cheap, do first
For each Cohort-A pick entry (globe `fragmentPickMain`; model `fragmentPickMain` /
`fragmentPickHoverMain` / `fragmentPickMetadataMain`; voxel `fragmentPickVoxelMain`; compute-instance;
plus any ellipsoid/splat/buffer/ground/vector-tile family confirmed Cohort A):
1. Change the entry's return type from `@location(0) vec4<f32>` to a small `PickFragOutput` struct:
   ```wgsl
   struct PickFragOutput {
     @location(0) color: vec4<f32>,
     //>>ifdef LOG_DEPTH
     @builtin(frag_depth) depth: f32,
     //>>endif
   };
   ```
   (Guard with the SAME `//>>ifdef CAPTURE_MODE`-style neighbors if the module already conditions
   slot layout — match the color `FragOutput` shape exactly, minus the G-buffer slot-1 the pick
   pipeline strips.)
2. In the entry body, after computing `pickColor` and any existing discards, write:
   ```wgsl
   var out: PickFragOutput;
   out.color = pickColor;
   //>>ifdef LOG_DEPTH
   if (v_logDepth <= 0.9999999) { discard; }   // near cull (INV-4), mirror the color sibling
   out.depth = csm_writeLogDepth(v_logDepth, camera.<logFactorField>);
   //>>endif
   return out;
   ```
   Use the SAME varying + factor field the module's color path uses (globe: `g_fragLogDepth` +
   `camera.logDepth.z`; model/others: the module's `v_logDepth` varying + its camera log-factor lane).
   For globe, set `g_fragLogDepth = input.v_logDepth;` at the top of `fragmentPickMain` exactly as
   `fragmentMain` does at `GlobeTerrain.wgsl:3135`, then return via a `makeFragOutput`-style struct.
3. **No JS change** for Cohort A whose camera UB already calls `packCameraLogDepthLanes` (model at
   `:1050`; globe bespoke lanes). Verify the pick command binds that same camera UB (it does — the pick
   pipeline reuses the color layout). **Decision point: if a Cohort-A family's camera UB does NOT pack
   log lanes, add the `packCameraLogDepthLanes(data, floatBase, uniformState)` call at its UB pack site
   BEFORE the pick entry can read a valid factor — otherwise `frag_depth` is `log2(x)*0 = 0` and the
   pick over-occludes everything (the Run-1 symptom).**

#### Phase 2 — Convert Cohort B (dedicated pick modules) — the hard cases
For each of the 9 dedicated pick shaders (Billboard/Point/Polyline collections + 6 PrimitivePick):
1. **Vertex:** add a `v_logDepth` varying to `VertexOutput` and compute it in `vertexMain`, guarded by
   `//>>ifdef LOG_DEPTH`, using `csm_vertexLogDepth` over the clip-space `position.w` exactly as the
   color sibling does. Copy the pattern from the matching COLOR shader
   (`BillboardCollection.wgsl` / `PolylineCollection.wgsl` / `Primitive*.wgsl`), which already has the
   ifdef block — do NOT invent a new formula.
2. **Fragment:** convert `fragmentMain() -> @location(0) vec4<f32>` to the `PickFragOutput` struct + the
   near discard + `csm_writeLogDepth` write (as Phase 1 step 2).
3. **Define plumbing:** the dedicated pick pipeline must be compiled WITH the `LOG_DEPTH` define when
   `isWebGPULogDepthActive` is true. Find the pick pipeline build site for that family and OR-in the
   `ShaderDefine.LOG_DEPTH` bit exactly as the color pipeline does. **Never reorder/renumber the define
   registry** (`WebGPUShaderDefines.ts` is add-only). Route the module through the preprocessor / module
   cache with the correct define mask (the ifdef `//>>else` branch is byte-identical to today when the
   define is off — safe migration default).
4. **Camera UB lanes:** confirm the dedicated pick pipeline's camera UB carries the log factor/near/far.
   These renderers already reference `_logDepthEncodeNearFar` (`WebGPUBillboardRenderer.js`,
   `WebGPUPointPrimitiveRenderer.js`, `WebGPUPolylineRenderer.js`, `WebGPUVector3DTile*Renderer.js`,
   `WebGPUGroundP*Renderer.js`, `WebGPUEllipsoidPrimitiveRenderer.ts`, `WebGPUGaussianSplatRenderer.ts`)
   — so the stash reaches them; verify the pick UB pack writes lanes 51/55/59 (or the module's declared
   offsets) via `packCameraLogDepthLanes`, and that the pick WGSL reads that struct field. **Decision
   point: if the dedicated pick module binds a DIFFERENT, log-less camera UB than the color path, wire
   the log lanes into the pick UB pack — do NOT read the color UB from a mismatched bind group.**

#### Phase 3 — Per-family WebGL-parity verification (INV-6) BEFORE the gate flip
Run each family's existing probe against a WebGL control at near/mid/far altitude (probe list in the
verification recipe). A family whose pick result diverges from WebGL is NOT converted — fix it before
proceeding. **Decision point: if any family cannot reach WebGL parity, STOP and block C10-12; a
half-converted fleet on the shared pick FBO is INV-2 violation.**

#### Phase 4 — C10-12 gate flip + oracle closure
1. Flip `WebGPUSceneRendererPickPass.ts:69` → `const PICK_DEPTH_PLANE_ENABLED = true;`. Update its
   JSDoc to record the fleet conversion landed (cite the C10-11 batch).
2. Re-run `probe-depth-plane-horizon-oracle.mjs`. It exercises three phases per altitude:
   `normal` (plane active → back marker MUST be occluded, front control MUST pick + be visible),
   `diagnostic-skip` (plane pick skipped → back marker MUST become pickable — proves the oracle can
   detect leakage), `restored` (plane re-active → back marker MUST be re-occluded). All three phases
   are the on/off/restored oracle discipline; all must pass at 20 km / 500 km / 5,000 km.
3. Tighten the oracle to count ONLY below-limb marker pixels — the residual "leak" at 20 km (538 px)
   and 500 km (70 px) is the screen-space sprite quad extending ABOVE the horizon line where neither
   plane nor globe covers pixels (identical WebGL geometry). Revise `probe-depth-plane-horizon-oracle.mjs`
   to mask above-limb pixels before the magenta count, and re-baseline the JSON.
4. Close `C9-02B` and audit `P0-1`. Move `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` out of DEFERRED_WORK;
   append the resolution to `WEBGPU_DEBUGGING_LOG.md` (same-date format as Batch 673).

#### Reversed-Z sequencing decision (encode NOW, cross-link, do not conflict)
- Pick-fleet log-depth is CORRECT NOW under the current log-depth architecture — it matches the scene
  color path + WebGL, and it is the P0-1 gate's proven prerequisite. Land it this campaign.
- FAR-707 slice-b (reversed-Z proper, weeks, next campaign — verdict `PERF_ARCH_DEEP_DIVE §15`, GO for a
  two-slice sequence) will REMOVE `frag_depth` from ALL producers (color + the pick surface C10-11 adds)
  to restore hardware early-Z/Hi-Z on the 72+ log-depth surfaces. It is **all-or-nothing** and its
  convert-back surface now INCLUDES the pick fleet.
- **Action (required by §15.5 / §S7-3):** when landing C10-11, add a note to the FAR-707 brief that the
  ~14 pick entries (compute-instance already converted) are now part of its convert-back surface, and add a back-reference in the C10-11
  batch comment. Do NOT run reversed-Z and pick-fleet log-depth in the same slice; do NOT let a future
  reversed-Z spike partially convert the pick fleet. The cheap FAR-707 spike (`defines=0` `//>>else`
  branches + reversed-Z infinite-far + depth32float + greater-equal, measured with gpuPassCost
  timestamps) is advisory and may run before OR after C10-11 — it does not block this correctness slice.

---

### Traps (what an expert catches by intuition)

1. **Factor-zero over-occlusion (the Run-1 symptom).** If a pick family writes
   `csm_writeLogDepth(v_logDepth, factor)` with `factor == 0` (camera UB never packed the log lanes),
   `frag_depth = 0` and that family occludes the ENTIRE globe disk in the pick FBO. Verify lane 51 (or
   the module's factor field) is non-zero at pick time for EVERY family before trusting a probe.
2. **Per-slice narrow near/far.** Reading `currentFrustum` INSIDE the frustum/pick loop bakes a slice's
   narrow curve — the exact bug Batch 673 fixed for the plane. Pick encode MUST use the full-frustum
   `_logDepthEncodeNearFar` pair. `packCameraLogDepthLanes` reads `currentFrustum` at UPDATE time (pre-loop
   = full frustum) which is consistent — but never re-pack a pick UB per slice.
3. **Missing near discard.** Without the `v_logDepth <= 0.9999999` discard, fragments behind the near
   plane write a clamped `frag_depth` and can spuriously pass `less-equal`, re-introducing a leak at
   grazing angles. Mirror the color sibling's discard exactly (INV-4).
4. **Dedicated-module define omission (Cohort B).** Adding the WGSL ifdef blocks does NOTHING if the
   pick pipeline is still compiled with `defines=0`. The `//>>else` branch (standard z) is what you get
   until you OR-in `LOG_DEPTH`. Symptom: shader looks converted, oracle still fails — check the compiled
   define mask, not the source.
5. **`buildPickPipelineDescriptor` module reuse hides Cohort membership.** A renderer that imports the
   helper is NOT automatically Cohort A — it may build a SEPARATE pick pipeline from a dedicated module
   for some passes. Read the actual pipeline build site; classify by which MODULE + entry the pick
   pipeline uses, not by imports.
6. **HDR / MSAA / resize / recovery matrix.** The pick FBO is single-sample LDR
   (`context.pickPipelineFormat`) even when the scene is `rgba16float` MSAA (NEW-WEBGPU-HDR-PICK-FORMAT-
   CLOSURE, Batch 672). Verify each converted family still produces byte-exact pick IDs in HDR and after
   a resize/device-recovery (the depth encode is orthogonal to color format, but the pipeline cache key
   now includes the LOG_DEPTH bit — confirm no stale hyperbolic pick pipeline survives the flip).
7. **Globe stays opt-in.** `fragmentPickMain` is dispatched only when `globe.pickable` is set
   (`GlobeSurfaceTileProviderRendering.updateWebGPUForPick`). Do not "fix" the oracle by making the globe
   unconditionally pickable — that changes default `scene.pick` semantics (WebGL parity break, INV-5).
8. **Clipping/limit discards not yet in globe pick.** `GlobeTerrain.wgsl:3056-3059` notes the
   cartographic-limit/clipping-plane discards are NOT mirrored in `fragmentPickMain` yet. Adding log
   depth does NOT require adding those — but do NOT accidentally introduce a NEW discard that diverges
   from the color path; only add the log near/far cull.
9. **Do not conflate this with reversed-Z.** Adding `frag_depth` here is the OPPOSITE direction from
   FAR-707. If you find yourself removing `frag_depth` to "restore early-Z," you are in the wrong slice.
10. **Oracle screenshot ≠ oracle.** The horizon oracle asserts via direct GPUTexture→GPUBuffer readback
    + a pick-path assertion (`probe-depth-plane-horizon-oracle.mjs:12-14`); the PNGs are diagnostics.
    Passing bytes, not "the screenshot looks right," is the gate.

---

### Verification recipe (exact commands + pass criteria)

Environment: Node/Playwright/**Edge** only (Firefox has no WebGPU). Dev server on `:8080`.

**Per-family parity (Phase 3, run for every converted family):**
```
node Tools/visual-regression/probe-globe-pick-h44.mjs          # globe pick
node Tools/visual-regression/probe-standalone-model-pick.mjs   # model pick
node Tools/visual-regression/verify-model-feature-pick.mjs     # model feature/metadata pick
node Tools/visual-regression/probe-pickmodel-instanced.mjs     # instanced model pick
node Tools/visual-regression/probe-billboard-pick.mjs          # billboard (Cohort B)
node Tools/visual-regression/probe-point-pick-webgpu.mjs       # point primitive (Cohort B)
node Tools/visual-regression/probe-polyline-appearance-pick.mjs# polyline (Cohort B)
node Tools/visual-regression/probe-pick-basic.mjs              # primitive pick basic (Cohort B)
node Tools/visual-regression/probe-pick-metadata.mjs           # primitive metadata pick
node Tools/visual-regression/probe-voxel-pick.mjs              # voxel
node Tools/visual-regression/probe-voxel-cell-pick.mjs         # voxel cell
node Tools/visual-regression/probe-compute-instance-pick.mjs   # compute-instance
node Tools/visual-regression/probe-ellipsoidprim-logdepth.mjs  # ellipsoid log-depth sanity
node Tools/visual-regression/probe-pick-multifrustum.mjs       # multi-frustum pick coherence
node Tools/visual-regression/probe-pickposition-webgpu.mjs     # pickPosition (reads main-pass depth)
node Tools/visual-regression/verify-pick-webgl-control.mjs     # WebGL control cross-check
```
PASS = each probe's WebGPU pick IDs match its WebGL control at all altitudes it tests, and no family
regresses vs its pre-slice baseline. `probe-collections-far-camera.mjs` (includes the below-ground
occlusion negative control) must stay PASS. `probe-logdepth-globe.mjs` must stay clean.

**The gate oracle (C10-12):**
```
node Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs
```
PASS = zero `failures[]` in `output/performance/campaign9-c9-02b-depth-plane-horizon-oracle-*.json`
across all three altitudes (`near` 20 km / `middle` 500 km / `far` 5,000 km) AND all three phases:
- `normal`: front control picks + is visible in readback; back marker NOT pickable; back-marker magenta
  pixel count 0 (below-limb, after the Phase-4 mask).
- `diagnostic-skip`: back marker BECOMES pickable + appears in GPU readback (oracle self-check).
- `restored`: back marker NOT pickable again + no magenta leak.
The `diagnostic-skip` phase is the "off" oracle; `normal`/`restored` are the "on"/"restored" oracles —
all three required (on/off/restored discipline). A run where `normal` passes but `diagnostic-skip` does
NOT is INVALID (the oracle isn't actually exercising the plane).

**Regression suite:** run the broad pick + log-depth probe set unchanged; any new FAIL blocks the land.

---

### Rollback boundary

- **C10-11 kill switch:** `_logDepthWriteEnabled = false` (master switch, `WebGPULogDepth.ts`) restores
  hyperbolic depth on BOTH scene and pick fleets in one line (INV-3) — the `//>>else` branch of every
  new ifdef is the historical standard-z output. This is the instant revert if a family regresses in
  production.
- **C10-12 kill switch:** `PICK_DEPTH_PLANE_ENABLED = false` (`WebGPUSceneRendererPickPass.ts:69`)
  reverts the gate independently of the fleet conversion — the fleet stays log-encoded (harmless, WebGL-
  parity), only the depth-plane pick draw is disabled.
- **Blast radius:** WGSL pick entries (Cohort A: globe/model/voxel/compute-instance + confirmed A
  families; Cohort B: 9 dedicated pick modules) + their pick-pipeline define masks + any pick-UB
  `packCameraLogDepthLanes` additions. No scene-color path, no camera struct offsets, no define
  registry reorder. TAA `previousViewProjection` convention untouched.
- **Do NOT touch:** the reversed-Z surface (FAR-707), the 72 color-side `frag_depth` producers, the
  `CameraUniforms` struct size/offsets, `pickPipelineFormat`, globe `globe.pickable` gating.
- **Git:** land C10-11 as one commit (whole fleet), C10-12 as a separate commit (gate flip + oracle
  tighten). Branch from `main`; delete the safety branch after both verify green. Push as
  `kurtyoung-dev`.

---

### Pointers (verified anchors, post-Batch-674)

| What | File:line |
|---|---|
| DEFERRED entry (full math + evidence) | `migration_doc/DEFERRED_WORK.md:5229` |
| Deep-dive S7-3 / §15.5 / §17.6 | `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md:706 / 1372 / 1442` |
| Raw strata (deeper) | `scratchpad/perfdive/S7-multifrustum-reversedz.md:157,172` |
| Scene-half template (Batch 673) | `WebGPUDepthPlane.ts:784-824`; commit `51e94d24d9` |
| Full-frustum stash publish | `WebGPUSceneRendererFrustumState.ts:29-33` |
| Pick gate constant + use | `WebGPUSceneRendererPickPass.ts:69, 496` |
| Pick pipeline builder (module reuse) | `WebGPUPickCommandHelpers.ts:357-429` |
| Log-depth predicate + lane packer | `WebGPULogDepth.ts:75-116` (floats 51/55/59) |
| `csm_writeLogDepth` contract | `Shaders/WebGPU/chunks/functions/csm_writeLogDepth.wgsl:23` |
| Globe pick entry + deliberate note | `Shaders/WebGPU/Globe/GlobeTerrain.wgsl:3044-3063` (FragOutput frag_depth :3016; makeFragOutput :3039; g_fragLogDepth :3135) |
| Model pick entries | `Shaders/WebGPU/Model/ModelPBRComplete.wgsl:3730,3793,3942` (color FragOutput frag_depth :2352) |
| Model camera UB log lanes | `WebGPUModelRenderer.ts:1050` |
| Cohort B dedicated pick modules | `Shaders/WebGPU/Collections/{Billboard,PointPrimitive,Polyline}CollectionPick.wgsl`; `Shaders/WebGPU/Primitive/PrimitivePick{Basic,BasicTextured,MatFlat,MatLit,Phong,PhongTextured}.wgsl` |
| Gate oracle probe | `Tools/visual-regression/probe-depth-plane-horizon-oracle.mjs` |
| Oracle evidence (Batch 673 final tree) | `Tools/visual-regression/output/performance/campaign9-c9-02b-depth-plane-horizon-oracle-2026-07-16.json` + `campaign9-c9-02b-horizon-{near,middle,far}-plane-{on,off}.png` |
| Reversed-Z verdict (sequencing) | `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md:1341-1382` (§15) |

---

### Campaign-10 queue rows

| # | ID | Pri | Effort | Work / acceptance |
|---|----|-----|--------|-------------------|
| — | C10-11-PICK-FLEET-LOG-DEPTH | P0 | XL | Convert the ENTIRE native WebGPU pick producer fleet to write log `frag_depth` against the full-frustum `_logDepthEncodeNearFar` encode (INV-1/2/3), mirroring the Batch-673 scene half. Cohort A (shared-module entries: globe `fragmentPickMain`, model `fragmentPick{Main,HoverMain,MetadataMain}`, voxel `fragmentPickVoxelMain`, compute-instance, + confirmed A families) = pick-entry FragOutput gains `//>>ifdef LOG_DEPTH @builtin(frag_depth)` + `csm_writeLogDepth` + near discard, reusing the color module's varying/factor (mostly zero JS). Cohort B (9 dedicated pick modules: 3 collection + 6 primitive) = add `v_logDepth` varying in vertex, `frag_depth` in fragment, OR-in the `LOG_DEPTH` define at the pick pipeline build site, and pack log lanes into the pick camera UB. Kill switch = `_logDepthWriteEnabled`. Cross-link the FAR-707 reversed-Z convert-back surface in both work items; do NOT land with reversed-Z. Accept: every per-family pick probe matches its WebGL control at 20/500/5,000 km (probe list in guide); `probe-collections-far-camera` + `probe-logdepth-globe` stay green; no `frag_depth`-factor-zero over-occlusion; broad pick suite green. Feature-preservation (INV-5): no family disabled/degraded. |
| — | C10-12-PICK-DEPTH-PLANE-GATE-FLIP | P0 | M | AFTER C10-11 lands + all family probes green: flip `PICK_DEPTH_PLANE_ENABLED=true` (`WebGPUSceneRendererPickPass.ts:69`); re-run `probe-depth-plane-horizon-oracle.mjs` — all three altitudes × three phases (`normal`/`diagnostic-skip`/`restored` = on/off/restored oracle) pass with zero `failures[]`; back marker occluded in `normal`, pickable in `diagnostic-skip`, re-occluded in `restored`. Tighten the oracle to count only below-limb marker pixels (mask the sprite-above-limb residual: 538 px @20 km, 70 px @500 km) + re-baseline JSON. Close `C9-02B` + audit `P0-1`; move `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` out of DEFERRED_WORK; log to `WEBGPU_DEBUGGING_LOG.md`. Rollback = flip constant false (fleet stays log-encoded). |


---

<a id="traps-index"></a>

## Traps index (one line each — full context in the owning section)

**H7 — engine / handoff / checkpoint**
- Editing `CHARTER` or a completed task's brief/model/whitespace on a resume invalidates the cache and re-runs landed work — replace only `meta`/`TASKS`/context-docs line.
- Never a bare `await agent(...)` — a subagent that skips StructuredOutput throws and kills the run; always `safeAgent`.
- Measuring `C10-30` against a re-derived baseline on the new tree reads fast and voids the checkpoint — parse the recorded `C9-30`/Gate-A artifact; if missing, STOP/BLOCKED.
- A `LAND-INCOMPLETE` C9 row with unpushed commits is invisible debt — resolve the push before any C10 task runs.

**H1 — env frustum binning + reversed-Z**
- FIVE BV-less push sites, not three (Moon + fullscreen-sky added) — the exclusion must be pass-keyed (`pass === Pass.ENVIRONMENT`), never producer-keyed.
- Excluding env from accumulation with NO sky-only fallback → `numFrustums = 0` → black canvas; the `near > far && sawEnvironmentNoBV` fallback is load-bearing.
- Do not un-bin env commands or touch the Batch-247 dedupe; do not set `executeInClosestFrustum` (it bins to the NEAREST band, env executes at the FARTHEST).
- Read `scene.numberOfFrustums`, never infer count from `frustum ${i}` pass labels (that category error produced the first draft's wrong verdict).
- Reversed-Z slice-b is GATED: contradiction with the pick-fleet log-depth conversion must be resolved as one design before either lands; `depth32float-stencil8` fallback story is the real blocker, not precision.

**H2 — command / upload economics**
- `C10-02` T-3: verify `BatchTexture.translucentFeaturesLength` is maintained on the WebGPU path before claiming INV-2 (the highest-risk premise); `undefined styleCommandsNeeded` → emit twin (conservative).
- `C10-09` T-1/T-2: the identity-seed copies `instanceBuffer→prevInstanceBuffer` (must be current-frame); the skip assumes new-array-per-frame animation, guarded by the revision bump — reset `prevBufferRevision` on realloc.
- `C10-10` T-1: the "duplicate" `updateDerivedCommands` is NOT pure duplicate — camera-INVISIBLE casters have no other build site; run it at collection for them or off-screen shadows crash/vanish (the load-bearing subtlety).
- Do not merge the three slices — three commits, three oracles, disjoint verification lanes.

**H3 — MSAA boundary bytes**
- `storeOp:"discard"` on the demand-resolve pass destroys the frame (later segments `loadOp:"load"`); always `"store"`.
- Default the new `resolve` option to `true`; the `_resumeScenePass` spread copies `resolveTarget` through — flip all three open sites or 9/10 eager resolves survive.
- The pre-post-process ensure is load-bearing for the whole canvas (WebGPU requires the PP blit) — miss it and every MSAA frame is black.
- Reset the dirty flag conservative (`true`) on every scene-FB recreate/device-loss; never touch `Scene.js:488` MSAA defaults (option (c) is NOT ratified).

**H4 — resource / bandwidth**
- `C10-04` STOP-AND-BLOCK #1: no production `_splatData` producer found (probe injects it) — trace it first or the slice is premise-broken; the worker transfers (neuters) the positions buffer, pass a fresh copy; `undefined` return = "not ready, retry", never a sync fallback.
- `C10-05`: the register anchor `:1985` is the SECONDARY path — trace whether real model textures flow through the stub path (`:1958`) first or ship a no-op; grad without a mip chain (and a chain with LOD-0-forced shader) each do nothing — both prongs land together; never blit KTX2/compressed (not RENDER_ATTACHMENT-capable).

**H5 — boot / compile TTFF**
- `C10-06` T-06-a: a prewarm whose descriptor differs by one field is a cache MISS that recompiles anyway — assert the deterministic set shows as `hits` not `created` on frame 1; never `await` the prewarm (re-serializes the wall).
- `C10-06` T-06-c: globe `getShaderCode()` may be null at init time — the single most likely silent no-op; log-check before claiming the prewarm ran.
- `C10-07` T-07-a/d: binding a null (still-cooking) pipeline crashes the pass — verify the executor null-skips; HDR toggle must build-new-then-destroy-old or the canvas blit flashes black; preserve the C2-22 magenta-swap error contract.
- `C10-08` T-08-a/b: the `ShaderDefine` register is FULL (bits 0-30) — audit the budget FIRST; material-mask bits ≥29 overflow `computeKey`'s `md<<3`; add-only, never reorder/renumber; land only after `C10-07` (async) or specialization regresses TTFF.

**H6 — pick fleet log-depth**
- Factor-zero over-occlusion (the Run-1 symptom): a family whose camera UB never packed the log lanes writes `frag_depth = 0` and occludes the entire globe disk — verify lane 51 non-zero per family before trusting a probe.
- Never read `currentFrustum` per-slice for pick encode — use the full-frustum `_logDepthEncodeNearFar` pair (the exact bug Batch 673 fixed for the plane); mirror the color sibling's near discard exactly.
- Cohort B: adding the WGSL ifdef does nothing until you OR-in `LOG_DEPTH` at the pick pipeline build site — check the compiled define mask, not the source; a `buildPickPipelineDescriptor` import does NOT prove Cohort A.
- All-or-nothing on the shared pick FBO (INV-2): a half-converted fleet is incoherent; do not flip `PICK_DEPTH_PLANE_ENABLED` (`C10-12`) until every family probe is WebGL-parity green.
- Adding `frag_depth` here is the OPPOSITE direction from FAR-707 reversed-Z — cross-link both work items; never land the two in the same slice.
