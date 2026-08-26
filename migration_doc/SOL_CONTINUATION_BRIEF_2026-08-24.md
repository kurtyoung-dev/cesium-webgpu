# Sol continuation brief — 2026-08-24

**Audience: Codex Sol 5.6, driven directly by the maintainer through the codex CLI, with no
Fable or Opus orchestrator in front of you.** Everything an orchestrator used to do for you —
verify the premise, hold the git writes, run the browser, review the diff — is now either the
maintainer's job or yours, and this brief says which. Read it before you touch anything.

Authorities this brief points at and never replaces:
[EXECUTOR_LANE_CHARTER_2026-08-14.md](EXECUTOR_LANE_CHARTER_2026-08-14.md) §0.4 (the single
tracked precedence order), the dated `MAINTAINER_RULINGS_*.md` series,
[CODEX_SOL_OPERATING_BRIEF.md](CODEX_SOL_OPERATING_BRIEF.md) (worker rules 1-11),
[WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §8a-§8c,
[TIERED_ORCHESTRATION_PLAYBOOK_2026-08-21.md](TIERED_ORCHESTRATION_PLAYBOOK_2026-08-21.md),
`CLAUDE.md` (gitignored, local to the main checkout — it can never reach a clone), and the
campaign queues, which remain the sole status authority for their own rows.

Every `file:line` in this brief was re-read on 2026-08-24 between roughly 21:40 and 21:55 ET.
Where a number could not be reproduced tonight it says **verify** instead of asserting one.
Line numbers in a dirty working tree move; anchor on the quoted sentence, not the number.

---

## 0. State of play at the time of writing

**This paragraph is a snapshot of a session that was still landing while it was written — rev
the tip yourself before you rely on any number in it — it moved twice during this review alone.**
**Re-derived at review, 2026-08-24 ~22:45 ET:** `main` is at `bb15651f42` (**Batch 1157**, the
`C15-G6` multi-frustum instrument) and is **pushed** — `git log origin/main..main` is empty and
the index is clean. The evening's landing group ran 21:27→22:12: Batch 1150 (the C11-170 gate) at
21:27, Batches **1151** through **1156** between 22:01:35 and 22:04:13 — the C16
clustered-lighting/compute-instance shard, the scene/architecture residue tail, the pick-plumbing
shard, C13-41 SOL-4 commissioning, the C16 post-process/effects shard, and the `Scene.js` shard —
then Batch **1157** at 22:12. **Batch 1158 is this brief, and is the only one still pending.**
Throughout, the branch inventory was and remains
`main` plus `remotes/origin/main` and the read-only `upstream/*` refs, with no local safety or
feature branches outstanding. The working tree was never clean and never still: 68 porcelain
entries at 21:42, 71 at 21:51, 34 at 22:04 as the shards committed out of it, **31 after 1157**.
Read the composition, not the count, because the count moves: the **25-path lane F residue** (23
code and probe paths — of which five are untracked engine modules and one an untracked spec —
plus the `QUEUE_2026-08-09_CAMPAIGN18.md` hunk-1 and `WEBGPU_DEBUGGING_LOG.md` doc residue),
**lane P's held `verify-landing-compliance.mjs` + `.spec.mjs` pair**, **this brief and
`NEXT_SESSION_HANDOFF.md`** (Batch 1158), and **`migration_doc/pending/`** plus
**`CODEX_FABLE_OPUS_CHANGE_AUDIT_2026-08-17.md`**, both untracked — the latter is cited by
nothing and needs a disposition. Anything not on that list is a stray. Eleven worker clones exist at
`F:/Dev/GH/cesium-worker-lane1` … `-lane11`: lane7 is an
**empty husk** (no `.git`, no `node_modules`), and lanes 1-6 and 8-11 all sit at `daaca4fde8`
(Batch 1137) with dirty counts 7 / 4 / 7 / 14 / 11 / 3 / – / 3 / 4 / 4 / 31, each with a
`node_modules` **junction** into the main tree. **`cesium-worker-lane11` is lane F**, the C18-P
point-cloud / EDL / GPU-LOD / Draco package: 31 porcelain entries, one of which is the
pre-existing `MAINTAINER_RULINGS_2026-08-17.md` line-ending provisioning artifact that must
never be staged (its diff is EOL-only — git itself warns *"LF will be replaced by CRLF"* on it),
leaving the 30-path package. **Clone dispositions at review:** lanes 1, 2, 3, 4, 5 and 9 have
landed their batches and are retirable now under the closeout rule; lane6 is lane H, landing as
Batch 1157 (landed — lane6 is retirable now); lane11 is lane F, in flight; lane7 is the husk;
lanes 8 and 10 are the ones reported
held by the orphaned sandbox processes. The `moonmip` clone was deleted earlier in the session.
A tree of orphaned `node_repl.exe` sandbox
processes from the codex `mcp-server` (`codex.exe mcp-server` pid 20268,
`codex-code-mode-host.exe` pid 9864 at the time of writing) is still resident and holds the
lane8 and lane10 clones.

---

## 1. The rules you must obey when there is no orchestrator

These are not style. Each one exists because it was broken once.

1. **Quiet hours are absolute.** No `git commit` and no `git push` on a **weekday between 07:00
   and 19:00 US Eastern**. Commits carry visible timestamps whenever they are pushed, so holding
   a commit and pushing later does not launder it. The machine clock is the authority — run
   `date` before every commit and every push, not once per session. Since Batch 1146 the
   **pre-push hook enforces the commit-timestamp half itself**: `Tools/pre-push-guard.mjs`
   passes `includeCommitQuietHours: true` into `evaluateCommits`, and `checkCommitQuietHours` in
   `Tools/landing-rules.mjs` reads **both** the author date and the committer date and fails on
   either. A refusal there is the guard working, not a bug. Weekends and 19:00-07:00 are
   unrestricted; local builds, probes and edits are unaffected at all hours.

2. **The landing guard's other rules, and how not to trip them.** `Tools/pre-push-guard.mjs`
   enforces, over every outgoing commit authored by `cesium-webgpu-agent`: (a) a `Batch NNNN: `
   subject prefix, monotonic against the highest batch already reachable from the remote; (b) a
   **non-empty body** — trailers alone are not a body; (c) a `Co-Authored-By:` trailer; (d) the
   quiet-hours rule above; (e) merge commits skip (a)-(c) and nothing else. **There is
   deliberately no bypass flag.** `git --no-verify` still works, which is the point:
   `npm run verify-landing` re-checks the same rules over a landed range, so bypassing leaves
   evidence instead of leaving nothing. Never use it.

3. **Never rewrite history.** No rebase onto pushed commits, no amend of anything pushed, no
   force-push. Landings are **squash-only** — a merge commit skips the landing rules by
   construction, which is exactly why it is not an option for worker work.

4. **Never `git add -A`, never `git add .`, never `git commit -a`.** The tree is shared and
   almost always carries other lanes' held work. Stage by **explicit pathspec**, every time.
   When another held lane owns hunks in a file you must touch, stage per hunk: `git diff -U0
   <file>` → keep the wanted hunk → `git apply --cached --unidiff-zero <hunk.patch>` → assert
   `git diff --cached -U0` shows exactly those hunks before committing.

5. **Never de-score a measured red.** Charter §1.1 is `[HARD]`: a measured red is never demoted,
   quarantined, made reported-only, or made structurally unevaluable without a maintainer
   ruling. If a gate looks wrong, file a one-paragraph ruling request — the red, why the gate may
   be at fault, the proposed change — and continue other work. Equally hard: a valid measurement
   that misses a **pre-registered** expectation is **FAIL**, not STRUCTURAL. STRUCTURAL is
   reserved for an instrument or evidence shape that cannot be scored. Never tune a bar to an
   observation, and never author acceptance criteria in the same commit that lands the run they
   judge.

6. **One Edge job at a time.** Browser work is serialized: the executor lane owns Edge, and two
   concurrent WebGPU/Edge probes on this machine have crashed the host before. Never launch a
   second browser run while one is live, and never run a browser at all unless the maintainer's
   current instruction places it in scope. Playwright must use **Edge (Chromium)**, never Firefox
   — Playwright bundles Firefox Nightly, which has no WebGPU.

7. **Repatriate evidence before you reset anything.** Before resetting or deleting any clone,
   branch or worktree, copy the high-quality visual evidence it produced — probe PNGs, pixel
   diffs, capture reports — back into the main repo's gitignored
   `Tools/visual-regression/output/`, **preserving the probe's own subdirectory layout**.
   Certification-grade artifacts additionally bank in `F:/Dev/GH/cesium-webgpu-visual-evidence`
   (immutable, append-only). Evidence that dies with a clone reset is a handoff defect.

8. **Never delete the visual-evidence library or its staging folder.**
   `F:/Dev/GH/cesium-webgpu-visual-evidence` is append-only and content-addressed;
   `F:/Dev/GH/cesium-webgpu-visual-evidence-staging` holds the three C13-16 U2 directories moved
   out of the library root under `R-2026-08-24-12` and was left in place deliberately. Nothing in
   either is yours to remove.

9. **Never commit while an evidence publication is running.** `R-2026-08-24-12` records the
   lesson at cost: `archive` stamps repository provenance per run and the finalizer demands one
   identity across a ten-run block, so a landing that moves `HEAD` mid-publication spends the
   block irrecoverably in an append-only library. Block `20260824a` was lost exactly this way.
   **Publications and landings are serialized.** If an archive sequence is running, the landing
   waits for an explicit quiescent window.

10. **Write every new comment to the C16 standard.** No batch numbers, no campaign row ids, no
    tracker-document pointers, no session ids, no `FORK-NN`, no decorative glyphs anywhere under
    `packages/*/Source`. That history belongs in commit messages and `migration_doc/**`. The
    machine-readable half is `Tools/c16/lib/marker-grammar.mjs` (16 rules); the standard is
    `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`. The guard runs in
    lint-staged, so a violation on a clean-listed path fails your commit. Comments state the
    **timeless constraint and the WHY**, never the work programme.

11. **Principle 8 — probe first, for any rendering fix.** If a fix is visually verifiable, the
    verification is an automated Playwright probe that reproduces the exact reported view
    *before* the fix is claimed to work. Never ask the maintainer to reload and look. A "fix"
    that does not move the pixel diff is not a fix. When you cannot run the browser yourself,
    **author the probe and hand the maintainer the exact command** — never substitute a grep of
    the build output for a measurement.

12. **Principle 10 — re-derive every premise.** An audit finding, a queue row, a prior session's
    note, or a line in this brief is a **lead**, not a premise. If you are about to cite
    `file:line`, open those lines now. State the observable behaviour to assert, never the
    implementation shape. A spec written from the same brief as the fix is not an independent
    check. Mutate for **inertness** (`if (false && …)`), not just for absence — deleting code is
    the easy mutation and most specs survive it.

13. **Everything else stays as the charter has it.** No implicit mutation authority (§0.2):
    being handed this brief authorizes none of git writes, browser runs, gulp builds,
    `npm install`, destructive cleanup, or messages to external systems. Each becomes in scope
    only when the maintainer's current instruction places that action **and that target** in
    scope. A read-only task stays read-only even though this document describes how a landing is
    done. Branch and worktree state is the one exception, and inspecting it is **required**:
    surface `git branch -a` unprompted at the start of a work package and at the start of every
    session.

---

## 2. Your own failure modes, 2026-08-20 to 2026-08-24 — and what to do instead

Every item here was observed on this machine in the last five days. None of them is a capability
defect; all of them are environment traps that a wrong habit walks straight into.

1. **A forked child session keeps writing after your parent turn ends.** Codex runs with
   proactive multi-agent delegation and forks child sessions **into the same clone**; the child
   rollouts carry `forked_from_id` / `parent_thread_id` and replay the brief as their opening
   message. They are your own sub-agents, not duplicate dispatches, and they write to the same
   paths. **Do not kill them.** *Instruction:* "done" means the **parent** rollout carries a
   `task_complete` event **and** every child is complete or silent across the watch window
   **and** the in-scope files are stable across that window. Disclose in the packet that the
   deliverable had concurrent authors.

2. **`mtime` is not a liveness signal.** An eight-sample size/mtime watch declared QUIESCED while
   a worker was mid-way through a fleet anchor sweep that writes only at batch boundaries; a
   rollout whose `mtime` was fifteen minutes stale carried events timestamped seconds earlier;
   and on Windows a file being appended through an open handle reports `LastWriteTime` equal to
   its `CreationTime` until the handle closes. *Instruction:* read the rollout's **event stream**
   (`~/.codex/sessions/<date>/rollout-*.jsonl`, matched by `cwd`) and use the last event's own
   timestamp plus the event count. Never `statSync` a rollout. Between tool calls the process
   count reads zero, so a process check alone is a false negative — it counts only conjoined with
   stable event counts and stable files across the full window. The reliable per-clone process
   discriminator is the sandbox wrapper's `--command-cwd <clone>` argument; bare `codex.exe`
   carries no cwd, and `lane1` must not match `lane10` or `lane11`. A forty-minute silence before
   the first write is normal for a brief that orders a premise check first.

3. **`grep -c $'\r$'` is mangled by the harness.** The quoting does not survive intact and you
   get a confident wrong number. *Instruction:* count line endings in node — read the file as a
   buffer, walk it once, and count CRLF, lone LF and lone CR separately, reporting all three.
   `core.autocrlf` is `true` here and `.gitattributes` says `* text=auto`, so **most** tracked
   text files are CRLF in the checkout and LF in the blob — but **do not assume it, measure it**.
   `text=auto` normalizes on `git add`, so a file added while its content was already LF can stay
   LF in both blob and checkout with git reporting no diff. Two such files exist today and one of
   them is a file this brief asks you to edit: `Tools/c16/spec-anchor-sweep.mjs` (455 lone LF, 0
   CRLF, blob identical) and `Tools/c16/spec-anchor-sweep.spec.mjs` (179 lone LF). Read the
   target's own line ending before every edit; never key an editor on a repository-wide rule.

4. **`sed -i` and codex `apply_patch` rewrite a CRLF file to LF.** This happened twice on
   2026-08-24 — once to `Tools/c16/comment-marker-guard.spec.mjs`, caught only because a lane
   lead re-counted afterwards. A whole-file EOL flip is invisible in a rendered diff and shows up
   as a 700-line change at commit. *Instruction:* edit with a **byte-exact node script** that
   (a) reads the file as a buffer, (b) matches an anchor joined with the file's own line ending,
   (c) **asserts the anchor occurs exactly once** and aborts otherwise, (d) writes bytes, and
   (e) re-reads, re-counts EOLs and asserts the expected line-count delta. Keep a pre-edit
   backup. Never reach for `sed -i` on a tracked file in this repository.

5. **`Tools/c16/spec-anchor-sweep.mjs` silently skips literals under load, and cannot see
   concatenated or cross-line anchors.** Its `parseLiteral` evaluates string literals through
   `runInNewContext(raw, Object.create(null), { timeout: 50 })` at `:166`, and the call site at
   `:221-227` wraps it in `try { … } catch { continue; }` — the same catch that legitimately
   swallows the tokenizer's safe-direction regex heuristic **also swallows a VM timeout**. Under
   load the class B / class C counts become nondeterministic. Separately, the sweep reads one
   string segment at a time, so a spec anchoring on a **concatenated** or **cross-line regex**
   fragment is invisible to it — which is how two gsplat specs anchored on a marker-free two-line
   `View.js` comment and were caught by the spec run, not the sweep. *Instruction:* treat a green
   sweep as necessary and not sufficient. **Run the anchor-sensitive specs themselves**, directly,
   before and after any comment edit, and diff the results.

6. **The C16 node suites collide when run concurrently.** They share a synthetic fixture path, so
   a parallel run produces failures that are an artifact of the harness rather than of the code.
   *Instruction:* run `npm run test-c16` and the individual `node --test Tools/c16/*.spec.mjs`
   files **serially**, never in parallel with each other or with another C16 tool invocation.

7. **An unbuilt clone lacks the generated shader `.js` modules.** The engine-project TypeScript
   check and several specs therefore fail there for **environmental** reasons — a wall of
   `TS2307` on missing generated shader modules is the usual shape. *Instruction:* say so
   plainly and move on. Do **not** "fix" it, do not add the generated files, and do not run a
   build to make it green — builds are outside a worker lane. Name the environmental red as
   environmental in the packet, separately from any deliverable red.

8. **Census absolutes are build-state dependent; deltas are not.** The same C16 census reads
   2,179 in-scope files on an unbuilt clone and 2,840 on a built main, and main's marker absolute
   moved twice in one evening as batches landed. *Instruction:* lead every stamp with the
   **delta**, label any absolute with the exact tip it was measured at, and say explicitly that
   it must be re-derived at the landing point.

9. **Do not self-certify.** Charter §4.6 is `[HARD]` — certification authors do not self-approve
   — and with no orchestrator in front of you the reviewer is the **maintainer**. *Instruction:*
   end every package with a **landing packet** carrying, at minimum: the exact pathspecs; a
   `sha256` and CRLF / lone-LF / lone-CR counts per path; every gate you ran with its exit code,
   and every gate you did **not** run named as owed; a mutation table with **at least one
   inertness mutant per assertion family** and the observed failure count for each; the stamp
   text with its insertion anchor quoted **verbatim** and proven to resolve exactly once; and a
   drafted commit message. State what you could not verify. The packet is the author's account —
   expect it to be checked, and make checking cheap.

---

## 3. The bounded work list

Each item below is a self-contained brief. Take them one at a time. **One deliverable per
sitting** — the observed failure mode of a three-part brief is code that does not run.

### (a) Lane F next round — restore the far cull, then finish the probes

**Where — two copies, and they are not the same set.** `F:/Dev/GH/cesium-worker-lane11`, at
`daaca4fde8`, holds the 30-path package plus the untouchable `MAINTAINER_RULINGS_2026-08-17.md`
EOL artifact. **Main's own worktree also carries lane F dirt** — 25 paths at review (23 code and
probe paths plus the `QUEUE_2026-08-09_CAMPAIGN18.md` hunk-1 and `WEBGPU_DEBUGGING_LOG.md` doc
residue), including the five untracked engine modules. The two sets **overlap but differ**: lane11
additionally holds `Scene/Cesium3DTileset.js`, `Scene/TimeDynamicPointCloud.js`,
`celestial-gate-class-audit.spec.mjs` and four untracked probes/specs
(`pointcloud-browser-gate-contract.spec.mjs`, `probe-point-sprite-tint-repeat.mjs`,
`probe-pointcloud-color-formats.mjs`, `probe-pointcloud-draco-timedynamic.mjs`) that main does
not; main additionally holds the two doc paths and lane P's `verify-landing-compliance` pair,
which are **not** lane F's to stage. Diff the two before you touch either, and never assume a
file you edited in one is present in the other.

**Premise, re-derived tonight.** At `HEAD`, `packages/engine/Source/Shaders/WebGPU/Compute/
PointCloudLOD.wgsl` carries `var lodLevel = 4u; // Beyond all LODs = culled` at `:119` and
`:205`, gated by `if (lodLevel < 4u && shouldKeepAtLOD(pointIndex, lodLevel))` at `:131` and
`:215`, with the far radius supplied as `lod3Distance2` in the uniform block (`:25`,
"beyond this = culled"). In the lane F working copy the rewrite to projected geometric error
replaced that with `selectLOD` at `:111`, which returns `0u / 1u / 2u` by projected-spacing ratio
and **falls through to `3u`** — there is no cull tier, so points that used to be dropped now
render at 1/64. The public knob is half-deleted: `lodFarDistance?: number;` is still declared on
`PointCloudLike` at `WebGPUPointCloudRenderer.ts:132`, but it has **zero consumers** in the
working copy, where `HEAD` consumed it at `WebGPUPointCloudRenderer.ts:2029`
(`pointCloud.lodFarDistance ?? frameState.camera?.frustum?.far ?? 1e7`).

**Deliverable, ordered by `R-2026-08-24-13`.** Restore the cull as a culled tier gated on
`lodFarDistance` **in projected-error space**, with the prior default, and restore the knob as a
kept toggle. This is the fork's governing principle — never remove additive behaviour as a side
effect of a refactor, keep the toggle — and it keeps the `C18-A1` acceptance recipe valid.

**Acceptance, as observable behaviour.** With `lodFarDistance` at its default and a camera
dollied past that distance, the compacted visible-point count for the affected tiles falls to
zero rather than to one sixty-fourth; with `lodFarDistance` set to `Infinity` (or the knob's
documented off value) the same camera pose yields the 1/64 population; a value between the two
moves the transition distance monotonically. Assert the counts read off the engine's own
compaction counter, never inferred from pixels. Do **not** assert "the shader contains a `4u`
tier" — that is implementation shape.

**Also in this round.**

- The **M8 behavioural fail-open spec** and the **F-9 / F-10** tests carried by the station-3
  advisory review. Those findings live in that review's own record; re-derive each against the
  current code before implementing (the review's own eslint finding has already moved — see
  below).
- **Three probe fixes**, all in `Tools/visual-regression/`: make the **rgb565 control**
  gain-inert so it discriminates rather than scaling with the subject; eliminate the
  `"[object Object]"` error artifact, which destroys the diagnostic value of a failure; route a
  **404 to STRUCTURAL**, never to a pass or a product FAIL, because a missing artifact still
  hashes; and add the **served-vs-disk `sha256`** provenance assertion required by
  `R-2026-08-24-2` using `validateServedEntryIdentities`, exported at
  `Tools/visual-regression/lib/build-source-identity.mjs:193`. **Corrected at review — do not act
  on the earlier reading of this item.** An earlier pass reported four `no-unused-vars` errors in
  `probe-pointcloud-color-formats.mjs` and concluded the provenance helper was imported and never
  called. **Re-measured in lane11 at review: `npx eslint --quiet` on that file exits 0 with no
  output**, and the helper is wired — `fingerprintEvidenceFile` is called at `:1761`,
  `validateServedEntryIdentities` at `:1762` and again at `:1829`, `buildEntryPath` at `:1761`,
  `runtimeEntryPath` at `:1201`. Either the file was still being written when the earlier pass
  read it (§2 item 1's own failure mode) or that pass read a stale copy. So this leg is **verify,
  not build**: re-read those call sites, confirm the `R-2026-08-24-2` served-vs-disk assertion
  actually fires and fails closed, and report it as already-present rather than re-adding it. The
  `eqeqeq` error the station-3 advisory named is also gone.
- **Inner budgets versus the 300 s watchdog.** Give every inner phase a bounded budget that sums
  to less than the outer watchdog, so a phase that hangs is attributed to that phase instead of
  killing the run with a generic timeout. A watchdog that fires must still emit a verdict.
- **Stamp corrections.** Batches **1142** (the PNTS retention record's second half plus the
  celestial-gate anti-vacuity anchor) and **1143** (the eye-dome lighting destroy fix, both
  backends) have **already landed**; any lane F stamp text still claiming them as pending is
  wrong and must be corrected before the package lands.

**Do not touch.** Anything outside the 30 paths. Do not stage
`MAINTAINER_RULINGS_2026-08-17.md`. Do not run a browser or a gulp build from the clone.

**Rows to stamp.** `C18-P2`, `C18-P5` and the `C18-A1` recipe-refresh note in
`migration_doc/QUEUE_2026-08-09_CAMPAIGN18.md`; the ledger entries in `DEFERRED_WORK.md` they
name. Honour the two landing guards on that queue: the lane F package **does not** discharge
`C18-P4` (model-path EDL routing — no model-path EDL producer exists in the package), and the
`C18-A1` acceptance recipe cites the pre-lane-F four-band shader shape and must be re-derived
against the landed one. `C18-P5`'s gate must verify the served build actually provisions
`Source/ThirdParty/draco_decoder.wasm` — it is a gitignored generated artifact, and a missing
decoder reads as the very hang the row fixes.

**Owed to the maintainer, not to you.** The terminal browser gates: C18-P2 per-format colour
fixtures with negative controls, and C18-P5 a real compressed-Draco ready/render gate. The
package lands **after** they run.

### (b) C16 — the remaining shards

All counts below were measured with `node Tools/c16/comment-marker-guard.mjs --strict <file>` on
2026-08-24 against the current working tree.

- **Blocked until lane F lands** (it is in lane F's dirty set in both main and lane11 — do not
  open a second writer on it): `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts`
  (**42** markers, re-measured at review).
- **`packages/engine/Source/Scene/CesiumDebug.js` (29 markers) is NOT blocked** — corrected at
  review. It is **clean in main and clean in lane11**; its last change landed as Batch 1139. The
  earlier reading was taken from a session-start snapshot that predates that landing. It is
  available now, and it is the largest single-file shard left outside lane F.
- **The four F-prime siblings**, all clean in main and available now:
  `WebGPUClusterDebugRenderer.ts` (**4**), `Shaders/WebGPU/Compute/ClusterAssign.wgsl` (**4**),
  `Shaders/WebGPU/Compute/ClusterBounds.wgsl` (**3**), `WebGPULTCLUTData.ts` (**1**) — twelve
  markers, one sitting. Note these are `.wgsl` as well as `.ts`: prettier does not match `.wgsl`
  (see `.prettierignore`), so those paths are inert in a prettier line, and `wgsl-comment-strip`
  is the gate that matters for them.
- **`C16-11a`** — ten pre-existing **sentence-less `@param` tags** in
  `packages/engine/Source/Scene/Scene.js`. Verified tonight: exactly ten, at `:2261`, `:3676`,
  `:3969`, `:5134`, `:5172`, `:5874`, `:5875`, `:5876`, `:5923`, `:6224`. Give each a sentence
  that says what the parameter *is*, not what its type is.
- **`C16-R2` — add a `fork-id` rule to `Tools/c16/lib/marker-grammar.mjs`.** The row already
  exists in `migration_doc/QUEUE_2026-08-10_CAMPAIGN16.md` (filed at `C16-09`). The blind spot is
  real: `MARKER_RULES` holds 16 rules including `far-id` (`/\bFAR-\d{3}/g`) and **no fork rule**,
  so a planted `FORK-99` in a clean-listed file passes `--strict` at zero errors. Measured
  tonight in the current working tree: **32 occurrences across 21 in-scope files, 7 distinct ids**
  (`FORK-1`, `-15`, `-27`, `-34`, `-35`, `-41`, `-45`); the guard's `SCOPE_EXCLUSIONS` skip
  `/ThirdParty/`, which holds 2 further files / 6 occurrences in generated `cesium_wasm`
  artifacts. **The eight-vs-seven question is already settled by the row — do not re-open it:**
  the eighth id was `FORK-36`, which survives only in the untracked
  `packages/engine/Build/Specs/SpecList.js` build artifact and appears in no tracked file, so it
  is out of scope. **Three of the affected files are clean-listed and become ERRORs the moment the
  rule lands** — `Renderer/GraphicsContext.ts` (1), `Renderer/WebGPU/WGSLShaderPreprocessor.ts`
  (1), `Renderer/WebGPU/WebGPUContext.ts` (2), confirmed against the 578-entry clean list at
  review. **Clear those four occurrences in the same commit as the rule — do not grandfather
  them.** `R-2026-08-21-18` makes the grandfather ledger **shrink-only** (41 pairs / 158 findings
  today) and `C16-20`'s empty-grandfather clause requires it to reach zero, so adding rows moves
  the gate backwards; the `C16-R2` row itself says the three "must be fixed in the same batch as
  the rule".
- **The digit / two-character-segment grammar widening**, a precondition on `C16-20` leg (1). The
  current `all-caps-fix-label` pattern is
  `/(?<![A-Z0-9_-])(?!(?:NEW|BUG|EPIC|FIX)-)[A-Z]{3,}(?:-[A-Z]{3,}){2,}(?![A-Z0-9_-])/g` — every
  segment must be **three or more letters with no digit**, and there must be at least three
  segments. So `PARITY-F16-POSTPROCESS` (digit segment) and `PARITY-PC-EDL` (two-character
  segment) are both invisible. Census carried into the C16-20 stamp: **111 occurrences / 23
  labels across roughly sixty files**, split shape A (digit segment) 9 labels / 50 occurrences and
  shape B (two-character segment) 14 labels / 61 occurrences; `CC-BY-SA` and `YYYY-MM-DD` are
  required exclusions. **Verify all three numbers before stamping** — they were measured at an
  earlier tip and the tree has moved. Land the widening **with a grandfather sweep in the same
  commit**, or the guard turns red across sixty files at once.
- **`spec-anchor-sweep.mjs` VM-timeout skip.** Fix it to **fail loud or retry**, never skip. See
  §2 item 5 for the exact call sites. **This file is lone-LF, not CRLF** (455 LF / 0 CRLF, blob
  and checkout alike) — see §2 item 3; an editor that assumes the repository-wide CRLF rule will
  rewrite every line of it. Acceptance: with a literal engineered to exceed the 50 ms
  budget, the tool reports a non-zero exit and names the file and line, and the class B / C counts
  are byte-reproducible across two runs under load. Keep the existing catch for the tokenizer's
  safe-direction heuristic — distinguish the two causes rather than widening one to cover both.

### (c) `C12-38` — the sun-disc centre dark spot (probe-first; you author, the maintainer runs)

**Row.** `migration_doc/QUEUE_2026-07-19_CAMPAIGN12.md:2247`,
`NEW-SUN-DISC-CENTRE-DARK-SPOT`, filed from a maintainer screenshot at Batch 1148. Read it in
full before writing anything — it carries the reproduction, three candidate loci and the required
method, and it is the premise, not this paragraph.

**Deliverable.** The Principle-8 probe the row itself specifies, **authored unrun**: the saved
view at `view=107.5215780802716,35.05292293726632,1175.3399698570242,…` (heading and pitch are
truncated in the screenshot — re-derive them from a low-sun pose at that position), clock
`2026-08-24T23:01:41Z`, terrain plus default imagery, no ion token; a **dawn sweep of sun
altitude from −2° to +10°**; **disc-centre versus disc-annulus luminance ratio published per
sample**; and a **WebGL twin as the parity control**. The FAIL bar is **pre-registered from the
first WebGL sweep, never from WebGPU**, and it is written into the queue **before** the run.

**Acceptance.** The probe publishes a per-sample centre/annulus ratio on both backends over the
whole sweep, with a readiness witness proving the sun was actually rendered at each sample and a
STRUCTURAL route when it was not. Claim **no verdict** — the machine-lane run earns it.

**Do not.** Do not fix anything yet. All three candidate loci (the disc shader's centre texel or
limb-darkening term, the bright-pass / sun-bloom mirror compositing a tonemapped core, an
atmosphere/depth ordering issue at low altitude angles) are **UNVERIFIED**, and the defect is not
yet confirmed on WebGL at all.

### (d) `C11-62` clause (b) — the timed octree-versus-PVS instrument

**Ruling.** `R-2026-08-24-15`: the ledger clause **stands** and the row stays **OPEN** until a
timed comparison runs. Case E does not measure it. The row is
`migration_doc/QUEUE_2026-07-18_CAMPAIGN11.md:544`; the ledger clause is in `DEFERRED_WORK.md`
under `NEW-SCENEOCTREE-DIRTY-REVISION-REBUILD-AND-PVS-PROMOTION` — "(b) a measured comparison
proving the enabled octree beats ordinary Scene PVS on the moving multi-altitude route" with more
than 200 commands.

**Deliverable.** A timed octree-versus-PVS instrument over the **canonical moving-altitude
route**, and the machine re-run of **case E** on a refreshed bundle in both backends.

**Method, non-negotiable.** Use the canonical campaign at
[DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md#canonical-moving-altitude-campaign-2026-07-14) — the
versioned nine-waypoint flight from 18,000 km orbit to 300 m AGL and back to a 2,500 km rotating
view, `--workload moving-camera-altitude-track-3d`, `--renderer both`, with the clean and
API-instrumented lanes kept **separate** and their samples never combined. **Interleaved A/B**:
alternate octree-on → octree-off and octree-off → octree-on repetitions to counterbalance thermal
and launch-order drift. Idle-soak FPS is invalid under request-render mode. Treat full
`Scene.render()` CPU distributions and capability-backed GPU timestamps as the primary metrics.

**Constraints the ledger already records, and which the fixture must honour.** The per-frame scan
is the same order of cost as the insert it replaces at N ≈ 200, so a measured win must come from
avoided allocations and descents and must not be assumed. Any bounding volume without a finite
`radius` keeps the snapshot volatile and disables reuse for the whole set — **run on a
sphere-only fixture**. In 2D split-viewport mode two command sets alternate through one octree so
every build is dirty and the scan is pure overhead (correct, inefficient, rare) — exclude it or
report it separately.

**Acceptance.** Publish paired per-repetition CPU distributions for octree-on and octree-off over
the same route on the same backend, with the interleaving order recorded per repetition, plus the
command count per segment proving the >200 threshold was actually crossed. The row closes only if
the enabled octree **beats** PVS; a null or negative result is a real result and closes the row
negative, not silently.

### (e) `C11-170` — the acquire-mode run, and the Signal-G sequencing

**Rows.** `migration_doc/QUEUE_2026-07-18_CAMPAIGN11.md:837` and the status row at `:1350`
(PARTIAL — gate authored, browser-free half 70/70 green, **certifies nothing**).

**What is owed.** A real **acquire-mode** run of `probe-perf-regression-gate.mjs` against a live
dev server. **The maintainer runs it; you adjudicate the artifact.** `--adjudicate-only` is capped
at STRUCTURAL by construction, so a stale green is impossible — do not treat the banked
`output/performance/c11-170-perf-regression-gate.json` STRUCTURAL/exit-3 artifact as a pass.

**Signal-G sequencing, and it is a hard order.** `NEW-C11-170-SENTINEL-UNOBSERVABLE-TO-GATE`
(`DEFERRED_WORK.md:4630`) must be sequenced **after** the `reuploadWatch` over-reporting hardening
recorded at `NEW-WEBGPU-UPLOADIMAGESOURCE-CACHE-CONTRACT-TRAP` (`:4628`). That residual is
specific: module-global `reuploadWatch` is unbounded, mixes ownership domains, and records
*before* source validation and shared-realization lookup, so it retains keys and reports logical
attempts as physical reuploads. Scope it to the context/device cache, bound it with TTL/LRU, and
record only validated physical realization attempts. Only then is the sentinel's observability
worth fixing — hardening the detector first would tune the gate to a producer that is about to
change.

### (f) SOL-4 — the protocol-v4 first run, and the profiler ring

**Authority.** `R-2026-08-24-3` re-partitioned Campaign 13 by work shape: **bounded,
spec-verifiable C13 instrument and harness work is yours**; C13 engine-semantic changes stay
Opus-authored. This row is instrument work.

**Deliverable 1 — the protocol-v4 first run.** DISCHARGED 2026-08-25: protocol v4
produced its first report that day — run `d6d15a71-fc5b-48e9-b071-ce627c61281b`,
GATE FAIL / exit 1, `incomplete: false` — after an earlier attempt the same day exited
2 on a module-scope import called from inside `page.evaluate`. All sixteen segments
completed on both backends and cardinality came back exact at 275/275. The one
engine-relevant red is `shadowContrastInvariant` at 1.0341102079879674; the
refresh-cost lane is still unscored on readback-ring saturation, which makes
**Deliverable 2 the remaining SOL-4 debt, not this run**. The
commissioning batch's own message states the position honestly: the ~29 ms per-refresh figure
holds only at or below 34 refreshes per 100 frames, from the four segments whose GPU timing was
valid, and the two steepest segments are excluded by readback-ring saturation with the direction
of their bias unknown. Any count quoted from protocol v3 must be named as a v3 retained sample
count.

**Deliverable 2 — raise the profiler's ring depth.**
`packages/engine/Source/Renderer/WebGPU/WebGPUTimestampProfiler.ts:198` reads
`private _bufferCount: number = 3;` — verified tonight — consumed by the allocation loop at `:264`
and the ring advance at `:433`, with the class docblock at `:186-189` describing triple-buffering.
Three slots is what saturates on steep segments. Raise it, and make it a named constant with the
reason stated at the declaration.

**Acceptance.** On the same steep segments that previously saturated, `droppedPassCount` stays 0
and the segment's GPU timing is **valid** rather than excluded — measured, not asserted, with the
before and after taken under the same route. Publish the ring depth in the report so a later
reader can attribute a saturation to it.

**Method.** The **interleaved A/B protocol is mandatory for all GPU timing** in this repository.
Alternate the two arms; never compare two contiguous blocks.

**Also.** The shadow-contrast red (1.0341 against a `[0.97, 1.03]` band, three clusters, relative
spread 1.4e-5) **stays red and its band does not move**. Do not re-score it.

### (g) `DEFERRED_WORK.md` hygiene — seven rows

These are small, disjoint, and each closes a documented lie or a dangling reference. They can be
batched together as one doc commit, but re-derive each one against the code first.

1. **The clustered-lighting "SCAFFOLDED" block is stale.** The sentence *"Batch 153 will merge the
   5 clustered-lighting bindings into the existing group 3 (effects) BGL"*, together with *"Step 5
   SCAFFOLDED across Batches 149-151"*, sits under
   `NEW-GBUFFER-CONSUMER-CLUSTERED-LIGHTING` — at **worktree line 9323** tonight (a prior report
   cited `:9253-9261` at `daaca4fde8`; **anchor on the sentence, not the number**). It is
   falsified by the code: `WebGPUEffectsBindGroup.js` documents bindings 18-22 at `:39-45`,
   spreads `CLUSTERED_LIGHTING_EFFECTS_BINDING_ENTRIES` into the shared BGL (~`:596`), binds the
   placeholders at `:987-994`, and resolves the active buffers around `:1714`. The dispatcher and
   the BGL are live. **Caution:** the `@group(4)` pair's retirement *is* still genuinely open —
   correct the merge claim without over-claiming the whole entry closed.
2. **`NEW-WEBGPU-PIPELINE-READY-SIGNAL` is a dangling id.** Re-measured at review, `15215aede5`:
   **zero** rows in `DEFERRED_WORK.md`, **two** mentions in `WEBGPU_DEBUGGING_LOG.md`, and
   **5 files / 5 occurrences** at `HEAD` under `packages/engine/Source` —
   `AsyncResourceMonitor.ts`, `WebGPUDecoupledScan.ts`, `WebGPUGPUCuller.ts`,
   `WebGPUImageUpload.ts`, `WebGPUPointCloudLODProcessor.ts`. An earlier pass read 7 files / 9
   occurrences at `6c215f9b49`, counting `WebGPUComputeEngine.ts` (×2) and `Scene/Scene.js` (×2);
   Batches 1151 and 1156 removed both. Re-derive the count at your own tip before stamping it.
   Either file the real row or rewrite those comments to the mechanism (they are C16 violations
   either way — `deferred-work-id` is rule 11).
3. **The cluster-assign invalidation defect.** In
   `packages/engine/Source/Renderer/WebGPU/WebGPUClusterAssignRenderer.ts` the cache checksum is
   `checksum += (L.posOrDir.x + L.posOrDir.y * 1.31 + L.posOrDir.z * 1.71) * (i + 1) + L.type *
   100 * (i + 1)` — seeded with `clampedCount * 1e6`, so it covers the light count plus each
   record's eye-space position/direction and light type, and **nothing else**. Colour,
   intensity, range, the three attenuation terms, both cone angles and the spot direction are all
   packed into the upload buffer and **excluded from the key**. Worse, both
   `this._device.queue.writeBuffer(...)` calls sit **after** the early `return false`, so when the
   checksum matches, the freshly repacked CPU scratch is never uploaded and the GPU keeps the
   previous frame's values. That makes it a **visible-state bug** — a light whose colour changes
   and whose position does not will not change on screen — not a conservative-cache inefficiency.
   File it with that framing and a three-part fix (widen the key, move the upload, add the
   regression test). **Note the fixture limit:** `probe-cluster-assign.mjs` varies light
   *geometry*, so it cannot catch this by construction.
4. **`NEW-WEBGPU-GLOBE-PER-FRAME-COMMAND-OBJECT-CHURN`** (filed Batch 1149, `DEFERRED_WORK.md`
   ~`:10197`). The WebGPU globe allocates one ~30-field command object literal per tile per
   command per frame (`GlobeSurfaceTileProviderRendering.js` ~1322-1389, pushed ~1466, counted as
   `logicalCounters.adapterCommandObjects` ~1399) where WebGL pools and mutates in place
   (~1758-1772, reset at `GlobeSurfaceTileProvider.js:667`); the legacy moon route has the same
   shape (`WebGPUEnvironmentRenderer.js` ~1917-1933). It needs its own lane and its own
   before/after **allocation measurement** — pooling means every per-frame field must be
   reassigned or explicitly cleared. Not a blocker for `C11-62`.
5. **The toji attribution determination. — PREMISE CORRECTED AT REVIEW; the earlier reading was
   backwards.** `DEFERRED_WORK.md:9325` cites
   [toji/webgpu-clustered-shading](https://github.com/toji/webgpu-clustered-shading) as the
   reference implementation for the cluster-bounds and light-assignment compute shaders. An
   earlier pass reported that `grep -ril toji` finds nothing under `packages/*/Source` and
   concluded there was no evidence of derivation. **That is false.** Re-measured at review, the
   code names the reference itself: `WebGPUClusterAssignRenderer.ts:24`
   (`https://github.com/toji/webgpu-clustered-shading.`),
   `Shaders/WebGPU/Compute/ClusterBounds.wgsl:6` (*"matches toji/webgpu-clustered-shading"*) and
   `:24` (*"**RTE delta from toji's example:**"*), and
   `Shaders/WebGPU/Compute/ClusterAssign.wgsl:35` (*"**Toji delta:** the reference example uses
   256 max lights per…"*), plus the generated `.js` siblings. (`Renderer/CubeMap.js:89` and
   `Renderer/Texture.js:76` also match, but on an unrelated upstream `tojicode.com` link — do not
   count them.) So the shaders were written **against** the reference and document their deltas
   from it, while `LICENSE.md` carries no entry at all. That is a **live attribution gap**, not an
   open question about whether one exists. Run the four-step `C16-01` pass: diff the two shaders
   and the chunk against the MIT reference; add a `LICENSE.md` entry **only if transcribed**;
   normalize the existing references into a proper `Reference:` block; record on the attribution
   ledger. Model it on the existing LTC entry at `LICENSE.md:415`. **A comment-only shard may not
   introduce a `Reference:` block, and must not delete the existing toji lines either** — both
   `.wgsl` files are in the four-file F-prime sibling set of §3(b), so that shard must preserve
   those attribution sentences verbatim and leave this row to restructure them.
6. **Three `DEBUGGING_GUIDE.md` probe-inventory rows are missing.** Verified tonight:
   `Tools/visual-regression/probe-cluster-bounds.mjs`, `probe-cluster-assign.mjs` and
   `probe-device-limits.mjs` all exist and the guide mentions **none of them** (zero matches).
   Write each row from the probe's own `@purpose` header, and carry the cluster-assign fixture
   caveat from item 3 into its row.
7. **The `R-2026-08-17-7` sweep residual — the method limit, recorded honestly.** The sweep
   compared each warrant against the git history of its gate spec, gate lib and probe since
   2026-08-13 and grepped the 08-14 → 08-24 rulings. That catches a gate whose **code or ruling**
   changed; it does **not** catch a gate whose **meaning** changed without either. Record the
   sweep as executed **for the certifying-pass class** with the residual method limit stated, and
   do **not** mark `R-2026-08-17-7` fully discharged.

### (h) `C12-33` — the certification tail

`C12-33` **is certified** on block `20260824b` (Batch 1148). Three things remain.

1. **The certification artifact cannot be banked, and this needs a decision.**
   `Tools/visual-regression/output/c12-33/certification-20260824b.json` (706,734 bytes, sha256
   `c2a0bcf9f11cd00075baacd9f57ae9dc5437a47b64755aad94f309ca838fb9ed`) was refused by
   `assertFinalArtifact`, which requires `artifact.runId === --run-id`; the certification schema
   carries **no `runId`** (dry-run: *"authoritative artifact runId undefined does not match
   20260824b"*). `import-legacy` would accept it but forces `NON_CERTIFYING`, which would
   misrepresent a PASS. The two options are an **additive schema field** under
   `cesium-finding-dispositions/v1`-style additive rules, or a dedicated archive
   `--artifact-kind certification` path. Present both with their costs; **do not hand-place
   anything into the library** — that is precisely the sin `R-2026-08-24-12` repaired.
2. **The maintainer countersign is owed.** `reviewer.identity` on the banked attestation is a
   self-asserted automated station-3 claim; no machine step supplies a human signature. The row
   says so and must keep saying so until a human signs.
3. **`R-2026-08-24-11`'s deferred `r`.** The sixteen-cell moon-mip ratio design was held until
   `sign-test-v1`'s ten-run set reported. **It has now reported**, and the reported shape is that
   all normal runs were byte-identical — a fixed point, variance nil. Put that in front of the
   maintainer as the input to the `r` decision. **The `r` is pre-registered by the maintainer,
   never post hoc, and never by you** — `R-2026-08-21-15`'s never-post-hoc rule is reaffirmed, not
   relaxed. A correlation is not meaningfully estimable from a degenerate dispersion; say that
   plainly rather than proposing a number.

### (i) FAR-107 and the B1-B5 picking programme

**The amendment exists and has been rescued from the session scratch.** It was written to
`…\scratchpad\laneL\far107-amendment.diff` — a **temporary** directory that does not survive the
session — so it has been copied into the repository at
**`migration_doc/pending/far107-amendment.diff`** (6,554 bytes, untracked). It is a **DRAFT — NOT
FOR APPLICATION WITHOUT NON-AUTHOR REVIEW**; it targets the `FAR-107` row of
`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md` (`:455-464`) and was verified `git apply
--check` clean at `daaca4fde8`. **Re-verify it applies at the current tip before proposing it.**

**Why it is held.** `R-2026-08-24-1` ruled the amendment, and `FAR-107:457` reads *"- **Size:** L;
public-API review required"*, while `EXECUTOR_LANE_CHARTER_2026-08-14.md:342` §4.6 is *"**[HARD]**
Certification authors do not self-approve."* The reviewer must not be the author. **You did not
author it, so you may review it** — but say so explicitly in the review, and the maintainer
decides whether that satisfies the obligation. Note for the record: the wave plan called FAR-107 a
`[HARD]` block; that is **not literally true** and should not be repeated — the file carries no
`[HARD]` markers at all. The obligation comes from the two lines above.

**What it unblocks.** Once the amendment actually lands, the **B1-B5 picking programme brief**
may be written. All six open decisions in `PICKING_ARCHITECTURE_STATE_2026-08-17.md` §10 are now
ruled — `R-2026-08-24-6` (single-texel sync capture by default, 33×33 opt-in via a scene option
defaulting to `false`), `-7` (tunable frame-age cap defaulting to 2, **and** `PickDepth` pulled
down from 4 to match — ordered, not merely permitted), `-8` (declarative prewarm:
`contextOptions.prewarmPicking` plus `pickReadyEvent`; a public `preparePickAsync()` is **not**
the surface), `-9` (globe pick IDs on **both** backends behind an explicit `Globe.pickable`
opt-in, upstream default preserved — `scene.pick` on a bare globe still returns `undefined`), and
`-10` (`drillPick` adopts the same readiness predicate as `pick`, riding P-7, not declaring
`unsupported`). §8 and §9 stay **unbuilt** until the amendment lands. The S5 gate's
`expectedPickKind = renderer === "webgpu" ? "globe" : "undefined"` divergence retires **when the
behaviour lands, not before** — a gate that encodes a divergence must not be edited ahead of it.

### (j) Clone hygiene

**The closeout rule.** When a `cesium-worker-*` clone is done: reconfirm it is unused (§2 item 2's
liveness predicate, not mtime); **harvest** its scripts, images and outputs to main or to the
backups; confirm nothing of value is left; **then** delete — **junction first**, because the
`node_modules` junction points into the main tree and a naive recursive delete will follow it.

**Current state, measured tonight.** Lanes 1-6 and 8-11 are at `daaca4fde8` and dirty (7 / 4 / 7 /
14 / 11 / 3 / 3 / 4 / 4 / 31); their packages are either landed or in flight, so **retire each
only after its batch is committed and pushed** and after byte-comparing the extracted files
against main. **lane7** is an empty husk — no `.git`, no `node_modules` — and can be removed now.
**lane8** and **lane10** are held by orphaned `node_repl.exe` sandbox children of the codex
`mcp-server`; stop those PIDs (or restart the codex host) before attempting a delete, or the
delete will fail partway and leave a half-removed tree.

---

## 4. How to land without an orchestrator

The shape below is the `RUNBOOK.md` written for the 2026-08-24 landing group. That runbook lives
in the session scratchpad, which is temporary, so its pre-flight and its push/residual sections
are reproduced here **verbatim** — the batch numbers and expected counts are the ones that were
true at `daaca4fde8` and have since advanced, so read them as the **shape** to reproduce, not as
values to assert.

> ## 0. Pre-flight (run once, before 19:00 is fine — nothing here writes history)
>
> ```sh
> cd F:/Dev/GH/cesium-webgpu
> date
> git status -sb
> git rev-parse HEAD
> git branch -a
> git diff --cached --stat
> ```
>
> Expected:
>
> - `git rev-parse HEAD` → `daaca4fde8...` (Batch 1137). If it is anything else,
>   **stop** — the batch numbers below are wrong.
> - `git branch -a` → `main` and `remotes/origin/main` only. Anything else is a
>   pre-existing branch that must be surfaced to the maintainer before landing.
> - `git diff --cached --stat` → empty. The index must be clean before section 1.
> - `git status -sb` → 53 modified + 15 untracked entries (**68** porcelain lines;
>   `.agents/` counts as one untracked entry, not four).
>
> Type-check the whole tree once (the preparer reports both exit 0 at this tip):
>
> ```sh
> cd F:/Dev/GH/cesium-webgpu
> npx tsc --noEmit
> npx tsc --project packages/engine/tsconfig.json --noEmit
> ```
>
> Format and lint over the union of all ten batches' pathspecs. Prettier only matches
> `.js/.cjs/.mjs/.ts/.md/.css/.html` (see `.prettierignore`), so `.wgsl` and `.yaml`
> paths are inert in the prettier line and are omitted from the eslint line.
>
> [The runbook then lists every pathspec explicitly in one `npx prettier --check`
> invocation and one `npx eslint --quiet` invocation. Reproduce that literal
> enumeration for your own batch set; never substitute a glob.]
>
> Two reds are pre-existing at tip and are **invariants to hold, not gates to clear**:
>
> - `node Tools/verify-tracked-references.mjs` → exactly **5** violations, all the held
>   point-cloud lane's untracked modules imported by `pointcloud-voxel-public-correctness.spec.mjs`.
>   Assert the count is still 5 after every batch; do not try to make it 0.
> - `npm run -s verify-tooling-catalog` → red on **four** unrelated drifted rows
>   (`probe-eclipse-cloud-response.mjs`, `probe-gsplat-frame-variance.mjs`,
>   `probe-scheduler-octree-demand.mjs`, `scene-octree-dirty-revision.spec.mjs`).
>
> **Hook note.** `git commit` runs lint-staged. §8 stages nine documents, two of them very
> large (`DEFERRED_WORK.md`, `QUEUE_2026-07-19_CAMPAIGN12.md` at ~395 KB), which is the
> shape that has OOM-killed the pre-commit hook before. If it dies there, re-run the
> commit with lint-staged serialized (`--concurrent 1`) and revert that local change
> afterwards. Never reach for `--no-verify`.
>
> Finally, confirm the patch inputs still apply to a clean index (read-only, `--check`
> does not write):
>
> ```sh
> cd F:/Dev/GH/cesium-webgpu
> git apply --cached --check --unidiff-zero <each prepared .patch>
> ```

> ## 12. Push and residual check
>
> ```sh
> cd F:/Dev/GH/cesium-webgpu
> date
> git log --oneline -11
> git push origin main
> ```
>
> Assert before pushing: `git log --oneline -11` shows Batches 1138…1147 in order on top
> of `daaca4fde8`, and every one of their commit timestamps is after 19:00 ET (the hook
> now enforces this; a refusal here is the guard working, not a bug).
>
> ```sh
> cd F:/Dev/GH/cesium-webgpu
> git status --porcelain | wc -l
> git status --porcelain
> ```
>
> **Expected residual: 29 entries**, and every one of them should be on this list. A
> path that is *not* here is a stray and must be explained before the session closes.

**The rules that generalize out of that shape.**

- **Pre-flight is: `date`, `git rev-parse HEAD` matches the tip your batch numbers assume,
  `git branch -a` is `main`-only, and `git diff --cached --stat` is empty.** A dirty index poisons
  every batch behind it.
- **Both TypeScript checks are landing gates.** The root `npx tsc --noEmit` passed all day once
  while `npx tsc --project packages/engine/tsconfig.json --noEmit` — the step `gulp build`
  actually runs — failed on an undeclared property, and every later build aborted there in a way
  that masqueraded as "the bundle did not refresh". Run both.
- **Enumerate pathspecs literally.** Never a glob, never `-A`.
- **Regenerate the tooling catalog after `git add` of any new `Tools` file**, not before:
  `npm run generate-tooling-catalog` (`node Tools/generate-tooling-catalog-launcher.cjs`), then
  `npm run verify-tooling-catalog` to confirm. The census reads the staged set.
- **Snapshot the C16 clean list per commit, not per batch group.** `npm run
  verify-comment-cleanlist` asserts that every clean-list entry still resolves and is still clean;
  a group that lands a shard's files in one commit and its clean-list additions in a later one
  leaves the intermediate commits red. Stage the exact clean-list state each commit implies, so
  `--verify-cleanlist` is green at **every** commit in the range, not only at the tip — the
  after-the-fact detector walks the range.
- **The pre-commit hook never runs `verify-cleanlist`.** `.husky/pre-commit` runs `lint-staged`
  then `npx tsc --noEmit`, and `lint-staged.config.js` wires only `eslint`, `prettier --write`,
  `markdownlint` and `node Tools/c16/comment-marker-guard.mjs` (the per-file mode, no
  `--verify-cleanlist`). A stale or unresolvable clean-list entry therefore commits silently and
  surfaces later in `npm run verify-comment-cleanlist` or in CI. Run it yourself, per commit.
- **Chain batches with an explicit failure exit.** A batch whose commit fails must not be followed
  by the next batch's `git add` — the failed batch's files stay staged and poison every later
  attempt. Reset the index before retrying.
- **Batch numbers are commit order.** If a scripted batch is pulled, renumber the batches behind
  it and fix every pending doc stamp that cites the old number before committing.
- **Documents that cite other batches land after the batches they cite.**
- **Push after 19:00 ET**, then assert the residual porcelain set matches an enumerated,
  explained list. Anything not on it is a stray.
- **The specs that pin all of this** are `Tools/landing-rules.spec.mjs` (control plus mutant per
  rule, two DST-straddling quiet-hours pairs with the same UTC time of day and opposite verdicts,
  and the narrow merge exemption checked against the same commit with the exemption removed —
  hermetic, no git, no filesystem, no ambient clock) and `Tools/verify-landing-compliance.spec.mjs`
  for the after-the-fact detector. Note that the detector runs the marker guard in **strict**
  mode, which is grandfather-blind, while the live commit-time guard honours the grandfather
  ledger — so classify every range finding against the pre-range blob before recording anything.

---

## 5. Where things are

**Indexes.** [`migration_doc/README.md`](README.md) is the index of all migration docs (LIVE vs
ARCHIVED) — trust it over any single doc's self-description.
[`migration_doc/TOOLING_CATALOG.md`](TOOLING_CATALOG.md) is the generated census of every tool,
probe and spec with its `@purpose` and `@status`.
[`migration_doc/DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) is the single entry point for debugging
tools and procedures — decision tree, `CesiumDebug` command catalog, probe inventory, WGSL pragma
patterns, and the canonical moving-altitude campaign at its §"Canonical moving-altitude campaign
(2026-07-14)". Keep both in sync whenever you add a probe or a debug command; a guide that drifts
is worse than no guide.

**Dispatch and governance.**
[`CAMPAIGN_PORTFOLIO_QUEUE.md`](CAMPAIGN_PORTFOLIO_QUEUE.md) is the current feature-priority
dispatch view across C11-C18 (grouping only — the campaign queues remain the status authority).
[`MAINTAINER_RULINGS_2026-08-24.md`](MAINTAINER_RULINGS_2026-08-24.md) records `R-2026-08-24-1`
through `-16`, taken across **five** sittings (~15:45, ~16:35-16:40, ~18:20, ~21:00 and ~21:55
ET); `-16` is the `C15-G6` precedence ruling, landed with Batch 1157. [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](EXECUTOR_LANE_CHARTER_2026-08-14.md) §0.4
is the one tracked precedence order and §1 the verification non-negotiables, including the
certification status table (PASS / FAIL / ERROR / STRUCTURAL / RUNNING / DECLARED_UNVERIFIED).

**Evidence.** The library CLI is `Tools/visual-regression/visual-evidence-library.mjs` —
`archive` / `import-legacy` / `verify` / `catalog` / `upgrade`, append-only and content-addressed,
with provenance and run identity stamped per run. The library is
`F:/Dev/GH/cesium-webgpu-visual-evidence`; the staging folder from the `R-2026-08-24-12` repair is
`F:/Dev/GH/cesium-webgpu-visual-evidence-staging`. Run-local output lives in the gitignored
`Tools/visual-regression/output/`, which **never reaches a clone through git** — a brief that
cites run evidence must have that evidence copied into the clone's same gitignored path first.

**Servers and provenance.** The built-artifact server is
`node server.js --serve-built --no-embeddings`, run detached; it fail-closes on a missing
`Build/CesiumUnminified` (unlike `--production`, which has no existence check and surfaces a stale
or absent artifact as mid-run 404s). Per `R-2026-08-24-2`, **certification and acceptance runs
certify the gulp artifact** with a fail-closed served-vs-disk `sha256` and byte-length compare;
the shared helper is `validateServedEntryIdentities` at
`Tools/visual-regression/lib/build-source-identity.mjs:193`. A swapped bundle is **not** refreshed
by `npx gulp build` — restore with `npx gulp clean && npx gulp buildCesiumDual`, then prove the
served identity changed, the served status is 200, and the embedded sources match disk. The dev
server is IPv6-only: use `localhost`, not `127.0.0.1`.

**Certification constants.** The moon-mip counterbalanced control order is
`C12_33_COUNTERBALANCED_CONTROL_ORDER`, exported at
`Tools/visual-regression/lib/moon-mip-motion-certification.mjs:82` and asserted against the
chronological order at `:1781-1783`. Never reorder it to match a run.

**C16 commands.** `npm run lint-comment-markers` (one-shot census; exits 1 only if a clean-listed
path regressed) · `npm run lint-comment-markers-strict` (every finding an error — this is what
`C16-20` must exit 0 on) · `node Tools/c16/comment-marker-guard.mjs <paths...>` (the lint-staged
mode; out-of-scope paths are skipped, not failed) · `npm run verify-comment-cleanlist` (asserts
every clean-list entry resolves and is still clean except current grandfathered pairs; stale
grandfather rows are errors) · `npm run test-c16` (**run serially**) ·
`npm run lint-string-literal-markers` · `npm run verify-packaged-notices` ·
`node Tools/c16/comment-only-diff.mjs --base HEAD` (zero code deltas on a comment-only shard) ·
`node Tools/c16/spec-anchor-sweep.mjs` (necessary, not sufficient — see §2 item 5). Scope is
`packages/engine/Source` and `packages/widgets/Source` only, minus vendored `ThirdParty/`; the
guard never reads `migration_doc/`, `Tools/` or `Specs/`, and adding them would be a standards
change, not a configuration change.

**Build and test.** `npx gulp build` (full, includes WGSL compilation) · `npx gulp buildCesiumDual`
(both backends, WebGPU-first default) · `npx tsc --noEmit` **and**
`npx tsc --project packages/engine/tsconfig.json --noEmit` · `npm test` (Jasmine) ·
`node Tools/variant-smoke-test.mjs` after any change to the variant plugin, the exemption list, or
entry-barrel generation · `node Tools/visual-regression/capture-and-diff.mjs` for the WebGL/WebGPU
split-screen pixel diff (note it refuses baseline promotion while the worktree is dirty).
