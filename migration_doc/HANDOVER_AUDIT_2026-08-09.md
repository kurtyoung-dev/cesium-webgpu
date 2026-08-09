# Campaign Handover-Readiness Audit (2026-08-09)

**Provenance:** maintainer directive 2026-08-09 ("audit all of our open campaigns and make sure they
are well documented so that Codex Sol or just Opus 5 could take them over if needed"). Executed by a
12-agent workflow (`wf_12c83946-62d`): 7 per-campaign auditors (four takeover tests: ledger truth
sampled vs git, resumability, self-containment, contradictions) + 1 protocol extractor over the
session memory, adversarial verification of the worst findings, synthesis. Line anchors were
verified at tip c24c7ab254; the tip has since moved - RE-VERIFY anchors before landing any edit.
The fix list is executed as its own batch series; this document is the evidence authority.

---

HANDOVER-READINESS PACKET — cesium-webgpu, synthesized from the seven-lane audit (baseline HEAD c24c7ab254/023a60c75e, Batch 1006–1008; repo tip has since moved to 1a04ac09a6 / Batch 1010 under a concurrent session — re-verify line anchors before landing edits). No files were written; the handbook draft in §3 is inline, ready to land as `migration_doc/ORCHESTRATION_HANDBOOK.md`.

=====================================================================
1. PER-CAMPAIGN VERDICT TABLE
=====================================================================

| Campaign | Takeover verdict | Findings (BLOCKS / DEGRADES / MINOR) | Single worst gap |
|---|---|---|---|
| C11 | READY-WITH-FIXES | 0 / 3 / 4 | Zero C18 back-pointers: C18's queue claims the brickmap vehicle decision is "recorded in C11-100" but the C11 queue never mentions C18 — a successor would mis-schedule C11-13/86/100/108, and the §1-vs-§3.2 dual ledger would re-open already-progressed rows (C11-11/20/90/91). |
| C12 | READY-WITH-FIXES | 1 / 7 / 3 | No consolidated open-set/RESUME section anywhere: the remaining-open set (2 red gates, ~8 open rows, exit tail) must be synthesized from 15+ scattered, non-chronologically-stamped locations across five documents; the doc's own §5 G4 gate row still contradicts its own B984 closure stamp. |
| C13 | READY-WITH-FIXES | 0 / 6 / 4 | The campaign-critical row misdescribes itself: C13-41's header claims its probe "has NEVER RUN" against six recorded Edge runs (B908–B931), and neither C13-41 row records its R-2026-08-10-1 elevation to C14 critical path — the successor's most important row is the one most likely to misdirect them. |
| C14–C15 | READY-WITH-FIXES | 0 / 5 / 7 | The C15 doc-top status block ("IMPLEMENTATION NOT STARTED") is unscoped and false for the G-track (G1–G5 landed, G6 partial); combined with G5/G8 ledger cells that lose against the doc's own newer B916 record, a successor would misjudge the entire gsplat lane's state. |
| C16 | READY-WITH-FIXES | 1 / 5 / 3 (one lane finding transformed by deeper verification — see FIX 31) | C16-20's acceptance instrument does not exist in the repo: the gate is a re-run of off-repo workflow wf_c6df8ba5-f04 (rubric, journal, shard prompts all unrecoverable), and shards C16-09..12 are sized from that journal's worstFiles lists — the gate is uncertifiable and the shards unsizable as written. |
| C17–C18 | READY-WITH-FIXES | 0 / 6 / 4 | The CLT plan's Track-B rows contradict its own §2 stamps (B4 shows an already-passed acceptance run as owed; B2 fixed but unstamped; B1 superseded), and §7's launch-decision list omits CLT-D10 — the very ruling that C12's G1 gate is red on — so a successor driving from §7 misses both wasted work and the cross-campaign blocker. |
| Cross-cutting | READY-WITH-FIXES | 1 / 7 / 3 (+ protocol-lane F1–F5) | CLAUDE.md — the only aggregated orientation layer (close-out mode, campaign map, quiet-hours HARD rule) — is gitignored with zero git history; a clone-based or Cline-based successor cannot recover the quiet-hours rule or the campaign orientation block from any tracked file. |

Overall: 3 BLOCKS-TAKEOVER, ~39 DEGRADES, ~28 MINOR. No queue-ledger fabrication found anywhere — every failure is staleness, scattering, or an untracked/off-repo authority, all fixable with doc edits plus one .gitignore change and one tooling check-in.

=====================================================================
2. FIX LIST (dependency-ordered; confirmed findings only; refuted/transformed noted inline)
=====================================================================

WAVE 0 — orientation layer (do first; every later fix is discovered through these):
1. `.gitignore:6` + `CLAUDE.md` — [BLOCKS] Track CLAUDE.md (delete .gitignore line 6) or move the "Active Remediation Campaign" block + the GitHub quiet-hours HARD rule verbatim into a tracked `migration_doc/CAMPAIGN_STATE.md` with CLAUDE.md pointing at it; at absolute minimum the quiet-hours rule and a close-out-mode pointer must land in a tracked file (verification confirmed the quiet-hours rule exists in NO tracked file; C16/C18 launch directives and most campaign identities ARE independently recoverable, so the fix's floor is those two items plus the aggregated block).
2. Land `migration_doc/ORCHESTRATION_HANDBOOK.md` (draft in §3 below) and index it in `migration_doc/README.md` as the successor's first read.
3. `migration_doc/README.md` — add LIVE-table rows for CLOSEOUT_PLAN_2026-08-07.md (with a superseded-in-part caveat), MAINTAINER_RULINGS_2026-08-10.md, LICENSE_DETERMINATIONS_2026-08-10.md, and the DEV_NOTES_* family; the index that says "trust this index" currently omits the dispatch schedule and the ruling authority.
4. `CLAUDE.md:9,:14,:16` — append the R-2026-08-10-1 consequence ("the C12 gate is maximal incl. C12-29 S3; C13-41 is the C14 critical path"); update the C15 G-track sentence (G1–G5 landed B868–895, G6 PARTIAL, G7/G8 pending); delete the discharged "Do NOT run the new cloud probes until their watchdogs land" clause (watchdogs landed B743).

WAVE 1 — propagate the seven 2026-08-10 rulings to every load-bearing site (before any RESUME sections cite them):
5. `QUEUE_2026-07-19_CAMPAIGN12.md:532,:606,§5-G3` — stamp "RULED 2026-08-10 (R-2026-08-10-4): 4096/face re-bake + G3 re-run ordered; NOT YET EXECUTED at HEAD" (the queue currently records the decision as "filed, not taken" — it is taken).
6. `QUEUE_2026-07-23_CAMPAIGN13.md:125,:685` — stamp both C13-41 rows with the R-2026-08-10-1 elevation (C14 critical path; canonical owner of C12-29 S3) + a pointer to MAINTAINER_RULINGS_2026-08-10.md.
7. `OCEAN_DYNAMICS_PLAN_2026-07-24.md §5 W1` — add the R-2026-08-10-7 rider (C12-32 shared-ephemeris state transfers INTO W1) and stamp hard-prereq (1) "C11-172 DISCHARGED — landed B757 (80ef849e0f)"; also delete the session-local MCP note at :227.
8. `CLOSEOUT_PLAN_2026-08-07.md` — add a header banner ("snapshot of 2026-08-07; substantially executed — G2 PASS, G4 CLOSED B984; queue rows win"); add a dated §3 addendum mapping each spent decision-queue item to its R-2026-08-10-1..7 ruling ID; fix Lane E :99 "C12-34 pixel leg" → "C12-36 star-pixel leg (renumbered)"; stamp §3 item 6 "CLT = proposed C17, not C16"; fix :223 identity line to match AUTOMATION.md (author = cesium-webgpu-agent since B977; push AUTH = kurtyoung-dev); append an "executed CO assignments" table (CO-14..CO-37 → batch/hash → row) so the CO-* labels stamped through four queues resolve.
9. `MAINTAINER_RULINGS_2026-08-10.md` header — add a dating note ("ruled/landed 2026-08-08 per git; the 2026-08-10 label is retained for ruling-ID stability") — this is also the anchor for the global order-by-batch-number convention.

WAVE 2 — RESUME-HERE sections + stale-cell corrections per queue:
C12 (`QUEUE_2026-07-19_CAMPAIGN12.md`):
10. [BLOCKS] Add the `## 0. RESUME HERE` consolidated open-set section at the top (use the §4 template; content = the audit's enumeration: G1 red → blocker NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA, aliased CLT-D10 in the CLT plan §9 with C17 unlaunched → maintainer ask; G3 red → R-4 re-bake unexecuted; G2 effectively closed; G4 CLOSED B984; C12-29 slice table S1/S2 landed / S3=C13-41 Edge-owed / S4 observability / S5 seven-lane matrix; C12-33 calibration lane never executed; C12-11 stars-catalog Edge run owed; C12-G1F2 re-measure; C12-12 4096 bake coupled to R-4; C12-31 sweep + FOLLOWUP-A/B/C gate call; §5 EXIT-2/EXIT-3 tail; ambiguous C11-79 in/out). Per the verifier's correction: use the recorded blocker id, citing CLT-D10 only as an explicit alias.
11. Fix the §5 G4 gate row (:2063) "Edge acceptance OWED (first run ever)" → "CLOSED B984 (943e13b571)" — the exit-criteria table currently contradicts the doc's own stamp.
12. Stamp the C12-18/19/34 row cells with landings: C12-18 LANDED B906 (ca964bc1da), C12-19 LANDED B937 (794ece043a) + Edge delta discharged B994 (0697b93a5b), C12-34 mirror LANDED B967 (68bf6e78d4) + certified at G4 close.
13. Stamp the C12-11 row + CO-24 OWED block: "G3 first Edge run EXECUTED B934 (4/5 pre-registration); residual owed = probe-stars-catalog.mjs Edge run only".
14. Header hygiene batch: one-line note "stamps order by BATCH NUMBER; several printed dates (2026-08-11) are session-context artifacts"; strike the duplicate C12-12 row at :2013; append "RESOLVED — renumbered to C12-36" at :1299; stamp the §7 C11-79/80 rows historical.

C13 (`QUEUE_2026-07-23_CAMPAIGN13.md`):
15. Restamp §9 C13-11: "PART 1 COMPLETE — B961 (b288bfc7bb): in-repo STBN generator + hash-pinned asset + StbnNoiseVolume.js seam; PART 2 = C13-11-PART2-CLOUD-STBN-CONSUMPTION (DEFERRED_WORK:~1528: three WGSL sites, bind slot 14, quality bit 14, default-off, off-path byte-identity acceptance)" — copy the dispatch spec into the queue row so it is visible from the queue.
16. Restamp the C13-41 header: delete "NEVER RUN"; record "LANDED B871 (2cb4090b16); six Edge runs B908–B931; standing: deck response IN BAND, next diagnostic = <the named INVESTIGATE-don't-widen step>" and state a post-run-6 closure criterion.
17. Reconcile the C13-10 header owed-legs list against its own later discharge stamps (owed: leg 0, leg A marginal, Karma WebGPUShaderDefines; discharged: the rest).
18. Replace the two literal "batch number/hash stamped at landing" placeholders (C13-02 → B907 ec2c6e9801; C13-09 → B935 3cb301e32d); wrap the 2026-08-02 Codex-audit worktree-tense paragraphs (:41-73) in a "HISTORICAL — superseded at B866" banner.

C11 (`QUEUE_2026-07-18_CAMPAIGN11.md`):
19. Add dated C18-coordination stamps to the C11-13 (:305), C11-86 (:431), C11-100 (:452), C11-108 (:460) rows + their §3.2 ranges, and explicitly correct the dangling claim: the brickmap vehicle decision is NOT recorded in C11-100 — record it there or fix the C18 §5 pointer.
20. Carve C11-11/20/90/91 out of their §3.2 NOT-STARTED range rows into dedicated ledger rows mirroring §1 status+batch/hash (pattern: the C11-149 carve-out at :1084).
21. Stamp the §1 cells + §5 W1 (:1326) / W7 (:1404-1407) prose for the six C12-transferred rows (79/80/115/160/161/175) with the alias marker §3.2 already carries.
22. Minor batch: add "landed Batch 903 (d9a8e39eeb)" to the four CO-2 tooling rows; point the C11-REVIEW-2026-08-01 citation (:912) at WEBGPU_DEBUGGING_LOG.md; add C11-213's gate-F baseline resolution path one-liner.

C15/C14 (`QUEUE_2026-08-02_CAMPAIGN15.md`):
23. Rescope the doc-top status block (:6-8): "Aurora lane (C15-01..08): PLANNED/HELD (R4) until C12 closes — not a launch ruling. GSPLAT lane (§6, R6): ACTIVE — G1–G5 landed, G6 PARTIAL, G7/G8 pending."
24. Stamp the §6 G5/G8 ledger cells with the doc's own Batch-916 outcomes (052b5f7865) — under the row-wins rule the stale cells currently defeat the newer record.
25. Add a §6-top dispatch paragraph: "remaining-row order lives in CLOSEOUT_PLAN Lane D (machine-first G7 → tower-variance investigation → G6 multi-frustum leg → G8)" and decode CO-12.
26. Mint an owning row (C15-G9, "tower frame-variance mechanism", blocks the G8 tower leg) with pre-registered first discriminators — the item gating the track's terminal gate currently has no owner and no next step.
27. Minor batch: G6h attribution → B888 (09c67d0100) with stage closure B889 (b882728ec3); "tip 25adfbd27d (B915 tip), recorded B916"; annotate the §5 strict-O5 sentence with the R1 re-binding.

C16 (`QUEUE_2026-08-10_CAMPAIGN16.md` + plan + LICENSE_DETERMINATIONS):
28. [BLOCKS] Make C16-20 certifiable in-repo: either check in the audit rubric + shard-agent prompt + re-run recipe (migration_doc/ or Tools/c16/), or redefine the gate as "strict full-tree `npm run lint-comment-markers` census = 0 for categories A + glyph-E, plus a documented reviewer procedure for B/C/D/F/G (~920 judgment blocks)", and state that C16-09..12 scoping is computed by running the guard at HEAD (the per-shard worstFiles journal is unrecoverable).
29. Flip C16-01b → "LANDED — Batch 988 (226e63e249)" and rewrite its now-false premise sentence ("Takram appears NOWHERE in LICENSE_DETERMINATIONS…").
30. Write the prescriptive "Shard dispatch protocol" section (anchor sweep incl. regex + indexOf shapes with no length filter, mutation controls proven non-prefix, DEV_NOTES banking same-batch, cleanlist ratchet, census-delta obligation) and land the C16-06a checked-in sweep tool the queue itself says all remaining shards need.
31. TRANSFORMED (C16-lane finding partially refuted by protocol-lane F1's git verification): L-01 and L-23 are NOT open — both closed B965/B966 ("ALL 23 license determinations now closed"). Fix = stamp the closures into the C16-01 row (:23), correct the LICENSE_DETERMINATIONS_2026-08-10.md headers at :49/:295 that still read NEEDS-MAINTAINER, and reduce the queue-header open-asks callout to "C16-R1 (blocks an honest C16-20)" only. Drop the originally-proposed "list L-01/L-23 as open asks" edit.
32. Enumerate C16-20's preconditions in its own row (C16-R1 ruled + string-literal scan, cached-audit re-run per FIX 28, shards 09–12 closed, explicit in/out call on C16-02c); add a one-line date-reconciliation note (2026-08-10 = ruling-set label; commits dated 2026-08-08); refresh the four drifted R1 pins (or drop pins for the quoted strings); amend plan §3.1's false "wired into CI" claim or actually wire the guard into dev.yml.

C17/C18 (`CELESTIAL_LIGHT_TRANSPORT_PLAN_2026-08-07.md`, `QUEUE_2026-08-09_CAMPAIGN18.md`):
33. CLT plan: stamp CLT-B4 "ACCEPTANCE MET at run 3 (tip 5aec156b93)"; stamp CLT-B2 "DONE (B913, CO-13)"; rewrite CLT-B1 as "SUPERSEDED by probe-daynight-terminator-law.mjs runs 1–3; residual = finding (c) only"; append D5/D8/D10 to §7 flagging D10 as required AT launch and as C12 G1's blocker; §7.1 "Campaign 16" → "Campaign 17"; add the §8 note that workflow IDs (wf_b9b40051-931, wf_20abf089-9c7) are session-local and the restated claims are the sole evidence.
34. C18 queue: amend the C18-S0 status+acceptance cells to record the conscious L-xx deferral (currently DONE fails its own written acceptance); reconcile the three inconsistent Wave-A gating statements; add "dispatch" to the ledger-update contract (:9) and stamp C18-V2 "IN FLIGHT" (the current dispatch is invisible to a successor); add the MAINTAINER_RULINGS file pointer at the first R-2026-08-10-x citation.

WAVE 3 — reference-layer upkeep:
35. `DEFERRED_WORK.md` — add a top-of-file conventions note (prepend/append mixing; order by batch number) plus a maintained/generated OPEN-items index (ID → anchor → one-line status); stamp the 2026-04 "Cross-cutting priority guide" (:8357-8380) HISTORICAL.
36. `DEBUGGING_GUIDE.md` — make the probe-inventory count census-derived (cite probe-fleet-contract.spec.mjs; disk reality 624 probe-*.mjs vs the header's "260+"), add rows for the five missing load-bearing instruments (probe-ground-fog, probe-timedynamic-pointcloud-load, sun-radiance-delta.spec, webgpu-sun-bloom-mirror.spec, ground-fog-band.spec), and bank the 2026-08-08 instrument doctrine as rules (or point at handbook §9).

MAINTAINER ASKS (not doc edits — surface as a block, they gate honesty of the above):
37. Quiet-hours history: 71 in-window weekday commits since 2026-08-01 predate the Batch-977 attestation — record whether a waiver existed or log the breach; a successor currently cannot tell rule from practice (protocol-lane F4).
38. CLT-D10 (shell-extent canonicity) blocks C12's G1 while its owning campaign C17 is unlaunched — needs an out-of-band ruling or an explicit "G1 stays red at C12 close" acceptance.
39. In/out-of-gate calls owed: C11-79 (transferred into C12, "remains partial", gate membership stated nowhere) and C12-31 FOLLOWUP-A/B/C.
40. Branch transparency: `worktree-agent-a65cd64de74f33fcf` exists (at landed commit 423ec649e1, no unlanded work) plus unlabeled/lint-staged stashes — inventory and clean per the CLAUDE.md rule.

DROPPED (refuted or explicitly non-urgent): "list L-01/L-23 as open maintainer asks" (refuted — closed; superseded by FIX 31); C14 plan §1a anchor re-pin (verifier: "no urgent edit — re-pin at W0/W1 intake"); SkyBox.js:361→474 anchor and README:185 table-format cosmetics (fold into any passing edit of those files, not standalone).

=====================================================================
3. ORCHESTRATION_HANDBOOK — full draft (ready to land as migration_doc/ORCHESTRATION_HANDBOOK.md)
=====================================================================

```markdown
# ORCHESTRATION HANDBOOK — CesiumJS WebGPU Fork

**Status:** DRAFT produced by the 2026-08-09 handover audit (repo at Batch ~1008); ratify and land
via the normal batch procedure, then index in `migration_doc/README.md`.
**Audience:** a successor orchestrator — a different model, a different tool (Codex/Cline), or a
fresh session with no memory of any prior one. This is the FIRST document you read. It contains
every operating rule that previously lived only in session memory.
**Authority:** campaign queue documents are the SOLE status authorities. This handbook is operating
procedure only. If this document and a queue row disagree about status, **the queue row wins**.
Dispatch plans (e.g. `CLOSEOUT_PLAN_2026-08-07.md`) are grouping only — same rule.

**Rule classes used throughout:**
- **[HARD]** — inviolable. Maintainer rules, safety rules, add-only invariants. Breaking one is an
  incident to be recorded, not a judgment call.
- **[DOCTRINE]** — verification and instrument methodology, earned from recorded failures. Deviate
  only with a written reason in the ledger row; a deviation that produces a green result is still
  a defect.
- **[CADENCE]** — operating rhythm and hygiene. Adapt freely, but keep the intent.

---

## 0. First hour — orientation reading order [CADENCE]

1. This handbook, in full.
2. `CLAUDE.md` (repo root) — project rules, the Active Remediation Campaign block, principles 1–9.
   (If you are working from a bare clone and CLAUDE.md is absent, `migration_doc/CAMPAIGN_STATE.md`
   / the README index carry the campaign map — see the handover-audit fix list.)
3. `migration_doc/README.md` — the doc index; trust it over any single doc's self-description.
4. `migration_doc/MAINTAINER_RULINGS_2026-08-10.md` — the seven standing rulings (R-2026-08-10-1..7).
   Note: the "2026-08-10" in ruling IDs is a label; the commits are dated 2026-08-08. See §8.
5. The open campaign queues, RESUME-HERE sections first:
   `QUEUE_2026-07-19_CAMPAIGN12.md` (critical path), `QUEUE_2026-07-23_CAMPAIGN13.md`,
   `QUEUE_2026-07-18_CAMPAIGN11.md`, `QUEUE_2026-08-02_CAMPAIGN15.md` (§6 G-track),
   `QUEUE_2026-08-10_CAMPAIGN16.md`, `QUEUE_2026-08-09_CAMPAIGN18.md`.
6. `migration_doc/CLOSEOUT_PLAN_2026-08-07.md` — dispatch grouping, partially superseded; queue rows win.
7. `git log --oneline -50` and `git branch -a` + `git worktree list` — reconcile what you just read
   against reality before dispatching anything. Batch numbers in commit subjects are the spine.

---

## 1. The orchestrator pattern [HARD]

- There is ONE orchestrator seat. The seat is a **role, not a model** — it has been held by Fable
  and by Opus at different times, swapping on usage walls. Workers are model-matched per task.
- The orchestrator: scopes tasks from queue rows, creates worktrees, dispatches workers, runs the
  machine (browser) lane, **reviews every diff in full**, lands commits from the main tree, updates
  ledgers, and retires worktrees. Workers never do any of that.
- Executor lanes (machine-verification runs on the main tree) get a tight written runbook and are
  forbidden ALL git writes.
- **Never claim state outside your own tree.** Workers verify any claim about HEAD via
  `git show HEAD:<path>`, never by assuming their worktree matches.

### Worker constraints [HARD]
- Workers implement ONLY in orchestrator-created worktrees under `.claude/worktrees/*`.
- Workers NEVER run git writes — no commit, stash, checkout, restore, reset. Negative controls use
  file copies, never `git checkout --`.
- Workers NEVER launch Edge or any browser. All browser lanes run on the orchestrator's machine
  lane, ONE Edge instance at a time, with 5-minute watchdogs.
- Workers report state only from their own tree; a refuter must state when its counter-evidence
  disproves a *narrower* claim than the one filed.

### Subagent hazards [HARD]
- General-purpose audit/verify subagents with Bash can silently `git restore` uncommitted work.
  Before any broad audit: commit, or snapshot changed files to scratch. Prefer read-only Explore
  agents; explicitly forbid git writes in every audit prompt. Lost source can sometimes be
  recovered from `Build/CesiumUnminified/*.js`.
- Review every generated script/probe for unbounded loops or missing timeouts BEFORE running it.
  Background WebGPU probes concurrent with builds are a machine-crash risk (one VSCode crash on
  record; 32 GB RAM machine).

### Worktree trap [DOCTRINE]
- In-repo worktrees resolve `@cesium/engine` through the MAIN tree's node_modules workspace link.
  A "pre-change" build made in a worktree is contaminated by main-tree state unless the worktree
  gets local `node_modules/@cesium` junctions — create them, then verify the bundle actually
  contains the worktree's bytes.

---

## 2. Landing procedure — per batch [HARD]

1. **Review the worker diff in full.** Never land unreviewed. Verify the row's premise against HEAD
   first — rows have been wrong before (recorded mechanism wrong: Batch 857; "blocking" dep already
   discharged: Batch 858).
2. **Binding offline gates** on touched surface:
   - `npx tsc --project packages/engine/tsconfig.json --noEmit` — non-TS2307 errors must be 0.
     (~134 TS2307s are expected in unbuilt worktrees: missing generated `Shaders/**/*.js`.)
   - `npx prettier --check` on touched files; eslint ONE FILE PER INVOCATION.
   - `node --test` on touched spec files; naga validation for touched WGSL.
3. **C16 comment gates** on any code touch: `node Tools/c16/comment-marker-guard.mjs --strict <files>`.
   Comment-only batches additionally run `node Tools/c16/comment-only-diff.mjs --base <ref>`.
   All new code is written to the C16 standard (`ForkCommentStandard.md`) — no tracker IDs, batch
   numbers, campaign glyphs, or first-person in `packages/*/Source`; those live in commit messages
   and `migration_doc/**` only.
4. **Probe acceptance before any claim** (CLAUDE.md Principle 8): pinned probes per §6 doctrine;
   read the output PNGs yourself.
5. **Ledger update lands IN THE SAME COMMIT as the work.** A landing whose Edge acceptance is
   deferred must NAME the owed run in its ledger row at landing time.
6. **Commit form:** heredoc (`git commit -F -`), subject `Batch NNN: <headline finding, stated
   adversarially-honest>` — the subject states what was actually proven, including negative results.
   Batch numbers are global, monotonic, never reused.
7. **Post-commit:** lint-staged runs `prettier --write` AFTER your gates — re-run any spec that pins
   source text. Large commits: serialize lint-staged with `--concurrent 1` (OOM otherwise), revert
   after. Never `--no-verify`.
8. Push (see §3 for identity + quiet hours), verify the tree is clean, retire the worktree.

---

## 3. Identity, authentication, quiet hours [HARD]

- **Commit author:** repo-local `cesium-webgpu-agent <cesium-webgpu-agent@users.noreply.github.com>`
  (since Batch 977; recorded in `AUTOMATION.md`). Do NOT "fix" it back to a personal identity.
- **Push authentication:** the active `gh` account must be **kurtyoung-dev**. A 403 on push means
  the wrong gh account is active — `gh auth switch`, it is not a permission loss. (Author identity
  and push auth are deliberately different things.)
- **GitHub quiet hours — HARD RULE:** no `git commit`, no `git push`, no visible GitHub activity of
  any kind on WEEKDAYS 07:00–19:00 US Eastern. Commits carry timestamps, so do not commit-and-hold
  either — hold work as uncommitted worktree state / exported patches and land after 19:00 ET.
  Weekends and 19:00–07:00 are unrestricted. Check `date` before EVERY commit/push — the machine
  clock is authoritative and the session's "today" context can disagree with it; trust `date`.
  Record blocked landings as "LANDING WINDOW OPENS 19:00 ET" todos and continue non-git work.
  *History note:* commits inside the window exist prior to the Batch-977 attestation; do not treat
  them as precedent — the rule as written governs.
- **Stashes:** never bare `git stash`. Always `git stash push -m "YYYY-MM-DD_HH:MM_claude_<reason>"`.
  Prefer `git show HEAD:<file>` / worktrees over stashing for comparisons. Never drop unlabeled
  stashes without maintainer confirmation.
- **Branch transparency:** at session start and at every work-package boundary, run `git branch -a`
  + `git worktree list` and surface anything besides `main` unprompted, with a deletion plan.

---

## 4. Add-only registries and numbering [HARD]

- **`ShaderDefine` bitmask + `ShaderSourceId`** (`WebGPUShaderDefines.ts`): add-only. Never reorder,
  renumber, or remove — even entries with no remaining consumer. Deprecated entries stay with a
  comment marker. Source ID 0 is reserved.
- **Campaign numbering** is ratified add-only: C14 = Dynamic Ocean & Wind, C15 = Aurora + Space
  Weather (+ GSPLAT G-track), C16 = Comment Remediation, C17 = Celestial Light Transport
  (PROPOSED, not launched), C18 = Voxel/PointCloud/Splat. Never renumber. A queue document is NOT
  a launch ruling unless it says it is (C15's aurora rows explicitly are not).
- **Batch numbers** are global and monotonic across all campaigns and sessions; never reused.
- **Enumerated keys over strings** for all registry/table lookups (`FeatureRendererKey` etc.).
- **`WEBGPU_COMPAT_EXEMPTIONS`** (`scripts/bundleVariantPlugin.js`): new backend-neutral files under
  `Source/Renderer/WebGPU/` must be added there, and must be load-safe in webgl-only bundles.
- **Certification holds are rulings:** C11-137 certification is HELD by maintainer ruling
  (2026-07-23) until the C11 W2–W8 body executes. Obey holds; queue a maintainer ask to lift them.

---

## 5. Campaign governance and ledger discipline

- **[HARD]** Queue docs are the sole status authorities; dispatch plans are grouping only; row wins.
- **[HARD]** Ledger rows update in the same commit as the work (complete / pause / block / defer —
  and, adopt going forward: dispatch, so in-flight work is visible to a successor).
- **[HARD]** Maintainer decisions are QUEUED, never taken unilaterally. Record rulings verbatim in
  `MAINTAINER_RULINGS_*.md` / `DEFERRED_WORK.md` RULING blocks, with consequence, documented
  fallback, and revisit trigger. Propagate a new ruling to every load-bearing queue row in the same
  landing (the audit found un-propagated rulings to be the largest single class of drift).
- **[DOCTRINE]** Corrections are made IN PLACE with dated UPDATE/STALE/CORRECTED/SUPERSEDED stamps,
  preserving the original text. Withdrawn attributions are recorded as UNATTRIBUTED, never
  re-guessed. Historical prose that could be linear-read as current gets an explicit banner.
- **[DOCTRINE]** Honest-remainder rule: every batch cell states what it did NOT do. PARTIAL is a
  recorded status; scope is never silently narrowed.
- **[DOCTRINE]** Ownership boundaries are cross-referenced, never duplicated: a row lives in exactly
  one queue; other docs point at it ("do not re-file"). Transferred rows keep their old IDs as
  stamped HISTORICAL ALIASES in the source queue.
- **[DOCTRINE]** Performance work must not remove, default-disable, bypass, or visually degrade a
  feature to improve a metric (CLAUDE.md). The governing C11 principle: never remove additive
  WebGPU behavior — default-to-parity plus a toggle.

---

## 6. Evidence-ordering convention [HARD]

**Order evidence by BATCH NUMBER, never by printed date.** Document and ruling date stamps run 2–3
days ahead of git commit dates, are non-monotonic against batch order, and ruling IDs embed the
drifted date (the R-2026-08-10-* set landed 2026-08-08). Stamps within a queue doc are also not in
positional order. When ordering matters, confirm against `git log` — the batch number in the commit
subject is the spine of the entire evidence system.

---

## 7. Verification and instrument doctrine [DOCTRINE]

Every rule below was purchased with a recorded failure. The recurring meta-lesson: **when a cycle
fails, suspect the measuring apparatus before the thing measured** — on 2026-07-25 all seven
failures in one day were instrument defects.

### Capture and pixels
- WebGPU canvas pixels: **Playwright element screenshots ONLY.** In-page `drawImage` copies of a
  WebGPU canvas are transparent black even same-task.
- **Same-task capture:** a pixel read across a rAF yield is invalid on BOTH backends. Fuse
  render+capture so the unsafe path is unreachable. Yield on the LOADING side only.
- **Cross-page / cross-build byte-identity is PHYSICALLY UNTESTABLE for temporal renderers**
  (per-page frozen fixed points; ~37% same-build cross-page diff). The honest form is same-page
  OFF→ON→OFF identity plus a noise-floor-bounded cross-build diff.
- Published cloud counters lag the cache by 1–2 frames; readiness = `marchPixels > 0`, not warm-up
  counts.
- Idle-soak FPS is invalid under request-render mode; use the canonical moving-altitude campaign
  (`DEBUGGING_GUIDE.md`), clean and API-instrumented lanes separate.

### Probe construction (the pinning doctrine, one list)
- Offline globe; pinned clock; same-task capture; warm-up discard; capture OFF before ON, never
  last; delete stale outputs pre-run (stale artifacts produce confident false conclusions).
- Exit contract 0/1/2/3 where **3 = STRUCTURAL/yellow with a named reason** — a probe that cannot
  reach its measurement exits 3, it does not pass.
- Watchdog + `finally browser.close()`; read back every pin; bracketed determinism control
  (onA → off → onB).
- Helpers that read per-frame uniforms must render INSIDE themselves, never depend on caller order.
  When a gate fails, check the comparand before blaming the engine.
- In-page shared code is embedded TEXT plus validators — `page.evaluate` drops closures.
- A discriminator must not be built from the primitive it discriminates.
- Match the user's exact reproduction (saved view, pickers, scene mode); default-camera probes miss
  view-specific artifacts.

### Acceptance semantics
- **Pre-registration:** expected numbers are derived and recorded BEFORE the run (commit message or
  queue row). Disagreement is STRUCTURAL — investigate, never tune.
- **Bands are DERIVED from modelled terms, never widened to accommodate a red.**
- **Mutation controls must BITE and be NON-PREFIX** — a rename that is a prefix of its anchor
  passes vacuously (proven twice in C16). Search the closing anchor AFTER the opening one.
- **GPU timing: interleaved A/B in ONE run**, both legs, never across builds; never substitute
  counts for timing (C13-39 protocol).
- Reference-disagreement = STRUCTURAL. A "fix" that does not move the diff is not a fix.
- `DECLARED_UNVERIFIED` is an honest, recordable status — prefer it to an unearned green.
- A class defect gets a shared ENFORCEABLE home (lib/spec) the SAME round it is found, not a
  per-site patch.
- `git status` can lie about magnitude — use `git diff HEAD --numstat`. Check CRLF with
  `tr -cd '\r' | wc -c` when byte counts matter.

### Environment
- **Edge (Chromium), never Playwright Firefox** (bundled Nightly has no WebGPU).
- Dev server is IPv6-only: use `localhost`, never `127.0.0.1`.

---

## 8. Worker-brief boilerplate [DOCTRINE]

Every implementation brief includes:
1. **The comment standard:** paste `ForkCommentStandard.md` Appendix A verbatim. Derived work gets
   `Reference:` blocks + LICENSE entries; verify with the marker guard.
2. **DEV_NOTES banking:** any load-bearing fact removed from code moves VERBATIM, with file+symbol
   anchor, into `migration_doc/DEV_NOTES_<subsystem>.md` IN THE SAME CHANGE. Quotes are
   machine-verified against `git show HEAD:<file>` by a verifier first proven on a deliberately
   corrupted quote.
3. **Anchor sweep before editing comments:** three classes — grammar-matching string literals,
   regex literals (no minimum length), and containment verbs (`indexOf` block locators) over
   comment text. Prove the sweep on planted anchors of all three shapes.
4. **Premise verification first:** verify the row's premise against HEAD before implementing.
5. **Honest remainder** (§5) and **own-tree-only claims** (§1).
6. **Scaffolding rules:** CLAUDE.md Principles 7 (dead-code audit — cross-reference docs before
   removing anything that looks dead) and 9 (surface missing/deferred functionality as next work,
   never an inline hack). Never trim WIP-module interfaces during cleanup.
7. **Pragma rules** for logging (CLAUDE.md): debug diagnostics pragma-wrapped; real errors permanent.

---

## 9. Session cadence [CADENCE]

- **Always work in flight:** dispatch worker lanes on disjoint files in parallel; the machine lane
  must retire owed-acceptance debt at least as fast as worker lanes create it.
- **Session start:** `git branch -a` + `git worktree list` surfaced unprompted; check `date`;
  start the dev server in-session (`node server.js --production`).
- **Session end / boundary:** write a superseding state entry. For a successor WITHOUT a memory
  system, the in-repo equivalent is mandatory: update each open queue's RESUME-HERE section
  (tip hash, landed window, owed machine-lane queue IN ORDER, standing cautions).
- **Todo discipline:** blocked items carry their unblock condition; quiet-hours-blocked landings
  carry "LANDING WINDOW OPENS 19:00 ET".
- **Crash recovery:** salvage tree state + journal BEFORE relaunching anything heavy; kill orphaned
  `msedge`/`node` processes; never blindly relaunch the identical heavy job.

### Machine-lane owed-queue reconstruction
The CURRENT owed-Edge-acceptance order lives in: (a) each queue's RESUME-HERE section once landed,
(b) "EDGE ACCEPTANCE OWED" ledger cells across the queue docs, (c) per-batch commit-message queue
stamps. `CLOSEOUT_PLAN` Lane E is a 2026-08-07 snapshot — do not trust it as current. To rebuild:
grep the queues for `OWED`, order by batch number, and honor any recorded pre-registrations.

---

## 10. Environment traps (Windows/PowerShell/tooling) [CADENCE]

- `node server.js --production` for the dev server; `--sandcastlePort` collides if a second server
  is up; the server dies on SIGPIPE — restart it, don't debug it.
- Heavy probes/builds: `NODE_OPTIONS=--max-old-space-size=12288`.
- **Never `2>nul` in bash** — it creates a file named `nul`; use `2>/dev/null`.
- lint-staged accumulates stashes (~30 observed) — inspect before assuming stash state is yours;
  big commits need `--concurrent 1`.
- Karma (`gulp test`) defaults to Chrome, which is not installed — set `CHROME_BIN` to the Edge
  binary; use `--includeName` subsets (the full 17k suite is too slow).
- A locked `.claude/worktrees/` directory can survive a crashed agent — safe to clean once
  confirmed at a landed commit.
- Edit ONLY `packages/*/Source`; root `Source/` is build output.

---

## Appendix A — provenance

This handbook consolidates: CLAUDE.md (project rules, principles 1–9, quiet hours),
CLOSEOUT_PLAN_2026-08-07.md §4 (worker/landing contract), AUTOMATION.md (identity),
ForkCommentStandard.md (C16 standard), the C12/C13/C16/C18 queue rows that embodied instrument
doctrine as instances, and previously session-memory-only knowledge (verification doctrine of
2026-07-25; instrument doctrine of 2026-08-08; worktree junction fix; push-auth/commit-author
split; stash convention; audit-subagent hazard; crash recovery; environment traps). Where this
appendix's sources conflict, the order of precedence is: maintainer rulings > queue rows >
CLAUDE.md > this handbook.
```

=====================================================================
4. RESUME-HERE RECOMMENDATION
=====================================================================

Verdict per big doc — a top RESUME-HERE section is warranted wherever the open set cannot be read in one place:

| Doc | Needs RESUME-HERE? | Why |
|---|---|---|
| QUEUE_2026-07-19_CAMPAIGN12.md | YES — MANDATORY (the one BLOCKS-TAKEOVER gap) | open set currently spans 15+ locations in 5 docs; 33k-char cells; non-chronological stamps |
| QUEUE_2026-07-23_CAMPAIGN13.md | YES | stale C13-11/C13-41 headers would misdirect the first 1–3 dispatch cycles; the C14 critical path lives here |
| QUEUE_2026-07-18_CAMPAIGN11.md | YES (lite) | dual-ledger (§1 vs §3.2) means no single current view; must also state the HELD certification and W1-resumed scope |
| QUEUE_2026-08-02_CAMPAIGN15.md | YES (as the rescoped two-lane header, FIX 23 — a separate section is redundant if the header carries per-lane state + Lane-D order pointer) | doc-top status is currently false for the G-track |
| QUEUE_2026-08-10_CAMPAIGN16.md | YES (lite) | small open set (01b-fix, R1 ask, shards 09–12, C16-20 preconditions) but the open asks are buried in DONE-row prose |
| QUEUE_2026-08-09_CAMPAIGN18.md | YES (lite) | youngest and best-formed queue, but the ledger has no in-flight state — the section is where dispatches become visible |
| OCEAN_DYNAMICS_PLAN / CLT plan / CLOSEOUT_PLAN | NO | not status authorities; dated riders (FIX 7/33) and the header banner (FIX 8) suffice — adding RESUME sections would create rival ledgers, violating queue-is-sole-authority |

3-line template (paste at the very top of each queue, refresh in the same commit as any landing that changes it):

```markdown
## 0. RESUME HERE — Batch NNNN (<tip-hash>, YYYY-MM-DD). Supersedes all status prose below; on conflict THIS section wins, then the row, then stamps by BATCH NUMBER (printed dates unreliable).
OPEN: <row-id — one-line status — next concrete action — acceptance criterion>; <…one line per open row/gate, reds first>.
BLOCKED/ASKS: <row — blocker ID + owning doc>; IN FLIGHT: <dispatched lanes + executor>; OWED (machine lane, in order): <run — pre-registered expectation>.
```

Cross-cutting note for whoever lands this packet: FIX 1 (track CLAUDE.md or land CAMPAIGN_STATE.md) and FIX 2 (land the handbook) are the two edits that convert every lane's verdict from "READY-WITH-FIXES assuming this session's context" to genuinely cold-start READY; everything else is queue hygiene executable by any successor after those two. All findings herein trace to the lane audits at Batch 1006–1008; the four maintainer asks (FIX 37–40) require rulings, not edits.
