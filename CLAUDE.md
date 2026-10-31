# CLAUDE.md — CesiumJS WebGPU Project Rules

This file is the fork's one rules file for every agent — Claude, Codex, Gemini and Cline alike (see "Rules Files and Routing"). Claude Code loads it automatically into every conversation; `AGENTS.md`, `GEMINI.md` and `.clinerules` point here. Task-specific rules live in on-demand skills (see "On-demand Skills"): they bind exactly as this file does, and work their task covers starts by reading them.

---

## Active Remediation Campaign — see CAMPAIGN_STATE.md

Campaign status (which campaigns are launched, their critical paths, current holds, and the
ruling that governs each) lives in the tracked
[`migration_doc/CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md), which is the **sole
campaign-status authority** (`R-2026-09-02-14`). This section is a pointer, not a mirror — do not
restate campaign facts here; edit `CAMPAIGN_STATE.md` instead, in the same commit as any
campaign-level change. The `QUEUE_*_CAMPAIGN*.md` documents remain the row-level authorities.

Read `CAMPAIGN_STATE.md` first for orientation. The GitHub quiet-hours and branch-transparency
HARD rules live only in this file (below); `CAMPAIGN_STATE.md` §2-§3 and
`ORCHESTRATION_HANDBOOK.md` §3 point here rather than restating them. This file is the one rules
file for every agent: see "Rules Files and Routing" below.

---

## Core Principles

### 1. Preserve Existing Functionality

- WebGL rendering must continue to work correctly — **never break existing WebGL behavior**
- Upstream WebGL files **may be modified** when it improves overall architecture (e.g., `Context.js` ES6 class conversion + `extends GraphicsContext`) — the goal is preserving _functionality_, not preserving _code as-is_
- All existing APIs must continue to work as expected
- Maintain backward compatibility with existing CesiumJS applications
- Ensure all existing tests continue to pass

### 2. Backend Agnosticism (Three.js + PlayCanvas Hybrid)

- Scene code must be **backend-agnostic** — it should NOT import from `Renderer/WebGPU/` or check `isWebGPU`
- All backend-specific code lives in **Feature Renderers** accessed through `GraphicsContext`
- `GraphicsContext` is an **abstract base class** — both `Context.js` (WebGL) and `WebGPUContext.ts` extend it
- Both renderers implement the **same abstract API** — TypeScript enforces parity at compile time
- The renderer layer is the **ONLY** system that needs to know the current backend
- External/extension code CAN query context type via getters (`context.rendererType`, `context.isWebGPU`) but should NOT branch on it
- WebGPU renderer must be optional and configurable via startup parameters
- Use feature detection to gracefully fallback to WebGL when WebGPU is not available

### 3. Multi-Context Support

- Every `GraphicsContext` instance has a **unique ID** (`context.id`) and its own `rendererType`
- `ContextRegistry` (static on `GraphicsContext`) tracks ALL active contexts
- Multiple contexts can run simultaneously — split-screen, multi-view, mixed backends
- Error logs MUST include context ID: `[CesiumJS:webgpu:ctx-a3f7] Pipeline creation failed`
- Each `View` may carry its own context (`options.graphicsContext`, resolved through `view.effectiveContext`, falling back to the Scene's); `scene.createView(camera, viewport, { graphicsContext })` makes additional views, and `FrameState.context` is repointed to each View's effective context before its render pass
- For WebGPU multi-view prefer **device sharing** (one `GPUDevice` across canvases, `WebGPUDevicePool.ts`); cross-backend multi-view shares CPU-side data through `SharedResourcePool.ts`; `OffscreenContextSupport.ts` is opt-in WebWorker rendering
- `GraphicsContext.registry.getFormattedDiagnostics()` / `.dumpDiagnostics()` dump every active context; `context.log(level, message)` is the context-tagged logging helper both backends inherit

### 4. WebGL2 Targeting

- Our fork targets **WebGL2 only** — we do NOT actively maintain WebGL1 fallback paths
- This reduces maintenance from 3 rendering paths to 2 (WebGL2 + WebGPU)

### 5. WebGL/WebGPU Feature Parity — CRITICAL

When implementing features for **either** backend, check whether the same improvement should also be applied to the **other** backend.

- **New renderer-agnostic features** MUST be implemented for **both** backends simultaneously
- **New shader features** need both WGSL and GLSL implementations (unless architecturally impossible in WebGL)
- **When adding a property to `DrawCommand`**, also add it to `WebGPUDrawCommand` (and vice versa) — including the options interface, `clone()`, and any sorting/dispatch logic
- **When fixing an upstream issue** for WebGPU, check if the fix can also improve WebGL
- **Scene-level wiring** (`scene.lights`, View.js sort steps, collection `renderOrder`) is backend-agnostic and benefits both paths — implement it once in shared code

Run this checklist before calling a feature or fix complete:

1. Does the feature's **JS/TS API** work for both backends?
2. Does the feature's **shader code** exist in both WGSL and GLSL? If not, record the gap.
3. Is the feature's **scene wiring** backend-agnostic?
4. Are **command properties** on both `DrawCommand` and `WebGPUDrawCommand`, with matching clone/options support?
5. Is the parity status recorded in `migration_doc/DEFERRED_WORK.md` and `FEATURE_INVENTORY.md` §C?

Not required for parity: WebGPU-only capabilities with no WebGL equivalent (compute shaders, render bundles, indirect drawing, storage buffers); WebGL1-specific fallbacks (we target WebGL2 only); and performance infrastructure that is inherently GPU-API-specific.

### 6. Feature Inventory — Scope the Impact of Every Change — CRITICAL

This fork has a **large feature surface**, inventoried in [`migration_doc/FEATURE_INVENTORY.md`](migration_doc/FEATURE_INVENTORY.md) in four buckets: §A EXISTING (inherited from upstream), §B NEW (fork-added, each tagged `(SHIPPED)`, `(SCAFFOLDED)` or `(EXPERIMENTAL)`), §C WIP (partially shipped, known gaps) and §D FUTURE / DEFERRED. Counts drift as the inventory grows; re-measure them there rather than trusting a transcribed figure.

**Before scoping the impact of any change**, cross-reference the affected subsystem(s) in `FEATURE_INVENTORY.md`; the eleven subsystems used for impact scoping (Globe & Imagery, 3D Tiles, glTF Models + KHR, Geometry Primitives, Collections, Entity / DataSource, Picking, Shadows / Lighting, Post-process & Effects, Performance & Compute, Architecture / Build) are detailed at `FORK_OVERVIEW.md:62`. A change touching globe terrain may also affect 3D Tile classification (shared depth target), CSM cascades (cast list), TAA (motion vectors), pick (depth blit). Use the inventory to surface those couplings _before_ writing code, not after a regression.

**When you ship a feature** that resolves a WIP entry, move it from §C to §B (and update the tag). When a future entry becomes WIP, move it from §D to §C. When a new feature lands, add it to §B. **Don't let the inventory go stale** — it's load-bearing for impact analysis.

### 7. "Dead" Code Audit — Cross-Reference Architecture Docs Before Removing — CRITICAL

This codebase ships features in **batches with deliberate scaffolding** for follow-up work. Code that looks dead at a glance is often pre-allocated infrastructure for a partially-implemented feature.

**Before deleting any code that appears unused** (uncalled methods, unread fields, allocated-but-never-written textures, no-op render passes), check ALL of the following:

1. **Read the file's own module-level docstring.** Cesium WebGPU files often list "What's shipped in this batch" + "What's currently a no-op until follow-ups land". If the code maps to a no-op-pending bullet, it's scaffolding, not dead code.
2. **Search `migration_doc/DEFERRED_WORK.md`** for the relevant subsystem (`C-R*`, `NEW-*`, `BUG-*` entries). Partial-implementation entries explicitly call out which pieces are infrastructure-only awaiting their fill-in.
3. **Search `migration_doc/WEBGPU_DEBUGGING_LOG.md` and `migration_doc/PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`** for the symbol or feature name. These docs describe architectural intent, not just bug history (the archived RENDERER_DEEP pillar's id table is transcribed at `ARCHITECTURE_REVIEW_2026-09-02.md` §5.1).
4. **Check the originating batch comment** (`git log -S '<symbol>'`). Batch headers ("**What's shipped**: A + B + scaffolding for C") tell you whether C is still planned.

**NOT proof of deadness:** a texture allocated but never written, a shader that samples uninitialized data and discards every fragment, a method called every frame with no visible output (the producer half is missing, not the consumer half), or a Sandcastle baseline that still passes after the removal (it covers a narrow set of demos).

**When in doubt, leave the scaffolding in place.** Removing it forces re-adding it when the follow-up work lands. The cost of one orphaned texture allocation is trivial; the cost of re-architecting a removed code path is real.

This principle's origin story (the C-R8 near-removal) and its later inversion are history, kept in [`RULES_FILE_NOTES.md`](migration_doc/RULES_FILE_NOTES.md) §1. The
principle (check before deleting) stands; the example's FACTS do not - always
re-derive a file's current disposition from the ledger, never from a governance
doc's illustrative anecdote.

### 8. Verify Rendering Fixes via Playwright — DO NOT ask the user to verify visual output — CRITICAL

If a fix is visually verifiable (renders a globe, sky, tiles, post-process effects, picking, etc.), the verification must be done via an automated Playwright probe BEFORE the fix is claimed to work — not by asking the user to reload and inspect.

**Required workflow for any WebGPU rendering fix:**

1. **Reproduce the symptom in a probe first**, built from probe-kit pieces (see "Probe Kit"), that loads the exact URL/camera/mode that triggers the bug. The probe MUST match the user's reproduction (saved-view query params, terrain/imagery picker selections, scene mode) — default-camera probes miss LOD-specific and view-specific artifacts.
2. **Capture WebGL vs WebGPU + compute a pixel diff.** Record the baseline mismatch percentage.
3. **Apply the fix → rebuild → re-run the probe.** Compare the new mismatch percentage against baseline. A "fix" that doesn't move the diff is not a fix.
4. **Read the output PNGs yourself.** Don't claim a fix works just because the diff dropped — visually confirm against the WebGL screenshot that the artifact is gone and no new artifact appeared.
5. **Only then ping the user.** Surface the probe name, the mismatch delta, and the screenshots so the user can spot-check rather than diagnose.

**Anti-patterns to avoid:**

- "Try reloading and let me know if the ring is gone" — the user's job is not to re-verify what you can verify automatically.
- "The build has the fix, so it should work" — bytes in the build output do not prove the runtime path is reached or the bug is gone.
- Default-camera probes when the user reported the bug at a specific saved view — match their reproduction exactly. Probe-first applies even when "I'm just going to be quick".

### 9. Surface Missing/Deferred Functionality as Immediate Next Work — CRITICAL

When investigating a bug, if the root cause turns out to be **unfinished, missing, or explicitly-deferred functionality** (not a regression in working code), do not paper over it — surface it as the next concrete work item.

**Required behavior:**

- If a fix is gated on functionality that doesn't exist yet, name the missing piece in the response and add it to the todo list as the next immediate item.
- Cross-reference `migration_doc/DEFERRED_WORK.md` and `migration_doc/FEATURE_INVENTORY.md` §C (WIP) and §D (FUTURE) when the missing piece looks like it should already be tracked there. If it's not tracked, add it.
- Do not silently route around missing functionality with an inline hack at the call site — that creates the kind of partial-implementation debt that Principle 7 ("dead code audit") warns against.
- If the user is blocked by the missing functionality, say so plainly so they can prioritize ("this bug needs X, which is deferred — build X next?").

This is the corollary of Principle 7: keep scaffolding in place AND finish the work the scaffolding implies.

### 10. Brief From Verified Premises — CRITICAL

An unverified premise does not stay contained. It propagates into the fix **and** into the test that
was supposed to catch it (the 2026-08-20 evidence: `WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8c, R8).

**Before you brief work — for a subagent, or for yourself:**

- **If you cite `file:line`, read those lines now.** An audit finding, a queue row, or a prior
  session's note is a LEAD, not a premise. Findings age; code moves.
- **State the observable behaviour to assert, never the implementation shape.** Behaviour is
  checkable against reality; a shape only checks that the instruction was followed.
- **A spec written from the same brief as the fix is not an independent check.** It inherits the
  brief's errors. Independence requires a different source — the behaviour itself, or a different
  reviewer.
- **Mutate for inertness, not just absence.** Deleting code is the easy mutation and most specs
  survive it. Make the fix _unreachable_ — `if (false && …)` — and see whether the spec still passes.
  A spec that greps source asserts text shape, not that the branch is live.

Verification has three tiers and each catches a class the others cannot: mechanical checks (does it
run, is it in scope), substantive review (is the code correct), and **independent re-derivation of
the premises**. Only the third catches a false diagnosis. A green mechanical check means "ready for
review", never "correct".

Subagent dispatch mechanics, the worker rules and the full evidence live in
[migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md)
§8a–§8c; this principle applies whether or not a subagent is involved.

### 11. File Editing Discipline: Never Rewrite Files > 100 Lines — CRITICAL

- **NEVER rewrite or overwrite an existing file longer than 100 lines** when the goal is to insert new code, add documentation, or modify existing functionality.
- **ALWAYS use targeted chunk editing (`replace_file_content`)** or surgical insertion. Never replace the entire file content with `write_to_file(Overwrite=true)`.
- Full file rewrites on files > 100 lines are strictly prohibited to prevent accidental code omissions, large diff bloat, context exhaustion, and regression risks.

Entered on 2026-09-10 by maintainer decision.

### 12. Command Execution Preference: Node Commands First — CRITICAL

- **ALWAYS prefer `node` / `npx` commands first** for scripts, evaluation, inspection, and tooling (`node script.mjs`, `node -e "..."`, `npx ...`).
- **NEVER use PowerShell (`pwsh`), cmd, or shell builtins unless strictly required** (e.g. for environment variables or platform operations where Node is not viable).
- Ensures deterministic cross-platform execution without shell quoting, escaping, or expansion discrepancies across Windows and POSIX systems.

Entered on 2026-09-10 by maintainer decision.

### 13. Context Spine — Scope With It, Verify at HEAD

The context spine (`Tools/query-context.mjs`, MCP server `cesium-context-spine`; guide:
[`migration_doc/CONTEXT_SPINE_GUIDE.md`](migration_doc/CONTEXT_SPINE_GUIDE.md)) is a preferred first step
for scoping a change. It is not an authority, and it never replaces Principle 10.

- **Prefer a pack to a cold read.** Before reading a multi-thousand-line hotspot whole, run
  `node Tools/query-context.mjs impact <file|symbol|key>` (MCP `cesium_impact_pack`): a pack is a few KB against tens to hundreds of KB for the file.
- **A pack is a lead, not a premise.** Re-open every `file:line` it cites at HEAD before you brief or edit,
  and treat its regime tags, rig covers and contract labels as candidates (the audit that found them wrong is in [`RULES_FILE_NOTES.md`](migration_doc/RULES_FILE_NOTES.md) §2). The spine's contract output is a scoping lead, never a gate; never cite it as one.
- **Rulings** come back ranked by Charter §0.4 (`node Tools/query-context.mjs ruling <id>`, MCP
  `cesium_query_ledger`); cite the ruling's own file and line, not the pack.
- **Clones.** `node Tools/provision-worker-clone.mjs <clone>` seeds the spine DB and `.mcp.json`;
  `--capsule <targets> [--capsule-role worker|reviewer]` also writes `<clone>/_review/context-capsule.md`;
  in a provisioned clone, read that capsule first when it exists. Refresh the seat's DB after a landing
  with `node Tools/landing/post-landing-spine.mjs` (the landing hook: it refreshes the spine and, when the
  landing touched the engine or the spine, imports Graphify incrementally; `npm run context-graphify` is that
  incremental import and works while the MCP server is up, a full `context-build` refuses while it holds the
  DB). Provisioning refreshes a seeded DB to the clone's HEAD (`--no-spine-refresh` skips it).
  A worker may run `npm run context-refresh` (3.3-3.9 s with nothing
  changed) in its own clone, but never `--bootstrap-graphify`: it downloads from the Python package
  index and installs into the tree, so it is the seat's to run.

---

## Proof Bar and Wave-End Gate

**Proof bar by change class (maintainer ruling R-2026-08-29-1):** engine, parity and shader changes keep
the full bar (behaviour spec + inertness mutant + separate review + the named Edge leg). Tools changes
carry a spec only where there is logic worth pinning AND an npm runner home. Docs, comments and demo
text carry review plus one capture where visual - no spec. A spec with no runner home is a review
blocker. Where a probe can measure the feature directly, the probe is the acceptance.
An optional second, adversarial Opus verifier (R-2026-09-11-1, `ORCHESTRATION_HANDBOOK.md` §7) may be added by the seat for
batches flagged as important; it is briefed to refute the packet, and a REFUTED verdict returns the lane before landing.

**Wave-end gate (R-2026-08-29-2):** every multi-batch wave closes with the variant smoke test, the
Sandcastle2 sweep on both renderers and the visual-regression capture-and-diff (baselines refreshed
deliberately, each refresh its own reviewed commit), run by an Edge executor and banked under
`Tools/visual-regression/output/wave-end/<wave>/`. Not per batch; the wave does not close without it.

---

## Probe Kit - Kit First (maintainer rule, 2026-10-08)

When we need probe functionality, we first see if it already exists; if it does not, we create a new modular piece
(the maintainer's directive is quoted in the guide). The probe kit under `Tools/visual-regression/` is the shared
runtime (`lib/probe-runtime.mjs`), the rig registry (`lib/rig-registry.mjs`, `rigs/*.mjs`: scenes as data), the stage
and step pieces in `lib/`, the metrics in `lib/metrics/`, the capture seam and the contact sheet. How it works, and the
inventory of every piece: [`migration_doc/PROBE_KIT_GUIDE.md`](migration_doc/PROBE_KIT_GUIDE.md).

**Before writing any probe code, in this order:**

1. **Rig.** Is the scene already a rig? If not, declare one as data in `rigs/<id>.mjs`.
2. **Stage.** Is there a stage or step piece for the scene kind? Reuse it, or add the missing dial to it.
3. **Metric.** Is there a metric? Reuse it, and measure in Node from the captured PNG.
4. **Probe.** Does a probe on the runtime already capture the scene? Extend its scene table.
5. **Only then** write ONE new modular piece in `lib/` (one responsibility, an `@purpose`/`@status` header, a Node
   spec with an inertness mutant). **Never** a bespoke probe or driver that launches its own browser.

**Keep the guide in sync**, as for `DEBUGGING_GUIDE.md`: a change that adds or removes a kit piece, metric, rig or
runtime probe regenerates the guide's inventory in the same change
(`node Tools/visual-regression/probe-kit-inventory.mjs --write migration_doc/PROBE_KIT_GUIDE.md`; `--check` fails on
drift).

**Shared files at landing.** Every family edits the rig census in `rig-registry.spec.mjs`, `RIG_TAGS` and the
shrink-only `lib/*-allowlist.mjs` files; the seat rebases a frozen lane patch's hunks on those files onto the tip with
`Tools/landing/rebase-shared.mjs` instead of resolving the conflicts by hand.

---

## Engine Code Standards — Non-negotiables (full rules: /engine-code-standards)

Any change under `packages/**` starts by reading `/engine-code-standards`.

- **RTE:** vertex buffers carry `positionHigh` + `positionLow`, never a single `position: vec3<f32>`; never `mvp * vec4(position, 1.0)`, always `mvpRelativeToEye * translateRelativeToEye(...)`; `CameraUniforms` ends with `previousViewProjection` (DP-H41).
- **Placement:** edit `packages/engine/Source/` and `packages/widgets/Source/`; NEVER create or edit files in root `Source/` (build output).
- **Language:** prefer TypeScript for new code; `any` is banned as a variable, parameter or return type in `.ts` and `.d.ts` alike (except third-party interop where the upstream type is genuinely `any`).
- **Comments:** the fork comment standard — comments under `packages/engine/Source` and `packages/widgets/Source` describe what the code does, never the work that produced it (no batch numbers, row ids or dates); `Documentation/Contributors/CodingGuide/ForkCommentStandard.md`.
- **Size:** files over ~1,000 lines are decomposed when touched functionally (not performance-critical math classes or pure data); the main class keeps its file and name; record it in `migration_doc/ES6_MODERNIZATION_STATUS.md`.

---

## GitHub Quiet Hours — HARD RULE (maintainer, 2026-08)

On WEEKDAYS between 07:00 and 19:00 US Eastern: **no `git commit`, no
`git push`, no visible GitHub activity of any kind.** Commits carry visible
timestamps even if pushed later, so do not commit during the window either —
hold work as uncommitted worktree state / exported patches and land in
batches after 19:00 ET. Weekends and 19:00–07:00 are unrestricted. Check
`date` before every commit/push; the machine clock is authoritative.
Local-only work (builds, probes, workers, edits) is unaffected. Record a
blocked landing as a "LANDING WINDOW OPENS 19:00 ET" todo and carry on with
non-git work.

Enforced mechanically (R-2026-08-14-4): `.husky/pre-push`
(`Tools/pre-push-guard.mjs`) refuses a push made inside the window and any
outgoing commit dated inside it, and also enforces the monotonic `Batch NNNN:`
prefix, a non-empty body and the `Co-Authored-By:` trailer (merge and
upstream-sync commits skip the message rules). It has no bypass flag;
`npm run verify-landing` makes a `--no-verify` push visible. In-window commits
from before the Batch-977 attestation are not precedent. Rules and specs:
`Tools/landing-rules.mjs`, `npm run test-landing-rules`, charter §6.

---

## Branch Transparency — CRITICAL

**Worker branches, clones and the handoff procedure:** see
[migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).
Workers get **clones, not worktrees** (a sandboxed worker cannot safely be given commit rights in a
worktree), landings are **squash-only** (merge commits skip landing rules), and every dispatch
begins with a capacity preflight. The obligations below still apply in full.

**Worker naming (maintainer directive 2026-08-29):** every dispatched worker, reviewer, executor
and scoping agent is named after a Tolkien character, uniquely, and that name is the lane's
identity in the Agent description, the clone directory, the packet, the ledger and every status
line. The Fable seat is Gandalf. Convention: §8e of the handoff doc above; the registry and role
pools are the seat's memory `feedback_tolkien_worker_names.md`.

The user's working model is "trunk-only — no long-lived branches." Surface branch state proactively whenever a work package is being scoped, started, paused, or closed. Do not let safety branches, worktree branches, or agent branches accumulate silently.

**Always tell the user, unprompted, when:**

1. **Starting a work package** — list any pre-existing local or origin branches besides `main` and offer to audit and clean them first. Run `git branch -a` to check; do not assume.
2. **Creating a new branch or worktree** — name it, say why, and commit upfront to a deletion plan (when it is deleted, and after what lands green).
3. **A sub-agent spawns a worktree branch** — surface the branch name in your reply, even if the agent ran in the background.
4. **Finishing a work package** — re-list all branches and explicitly ask whether to delete the now-redundant safety/feature/worktree branches before declaring the package done.
5. **At the start of every new conversation** if `git branch -a` shows anything besides `main` (and its remote tracker), open with a one-liner inventory.

Label refs and stashes by the git-stash convention in [`ORCHESTRATION_HANDBOOK.md`](migration_doc/ORCHESTRATION_HANDBOOK.md) §3 (timestamped, descriptive; never a bare `git stash`).

---

## Evidence Repatriation - CRITICAL (maintainer rule, 2026-08-21)

When finishing out a local branch, worker clone, or worktree, copy any
high-quality visual evidence it produced (probe PNGs, pixel-diff images,
capture reports) back into the main repo's gitignored
`Tools/visual-regression/output/` folder, preserving the probe's own
subdirectory layout, BEFORE resetting or deleting the clone.
Certification-grade artifacts additionally bank in
`f:/Dev/GH/cesium-webgpu-visual-evidence` (immutable) as before. Evidence
that dies with a clone reset is a handoff defect.

The counterpart rule is that everything NOT repatriated is swept: agents and
sub-agents clean up after themselves once a task is completely finished and
pushed - the lane temp root, downloaded bundles, runner profiles and mutant
copies - and the seat runs `node Tools/temp-hygiene.mjs --plan` / `--execute`
after a push. Scratch space is taken through `Tools/lib/lane-tmp.mjs` (one
sweepable root per lane). Procedure:
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md` §8i](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md).
A worker may run `node Tools/temp-hygiene.mjs --plan` (read-only) and report it; `--execute` is the
seat's.

---

## Rules Files and Routing — One Source (R-2026-10-30-M2)

**This file is the one rules file for every agent on the fork.** `AGENTS.md` (Codex), `GEMINI.md`
(Antigravity / Gemini) and `.clinerules` (Cline) are pointers: each tells its agent to read this
file first, then carries only what is specific to that agent and its tool surface. A rule that binds
every agent is written here once; where an agent file or a `migration_doc` page restates one, replace
the restatement with a pointer here. Precedence between governance documents stays in
`EXECUTOR_LANE_CHARTER_2026-08-14.md` §0.4, which ranks this file above `AGENTS.md`, `.clinerules`
and the handbook.

**Where agents work (R-2026-10-30-M3).** An LLM that does not hold the seat works in its own clone,
never in the seat worktree `F:/Dev/GH/cesium-webgpu`, unless the maintainer says otherwise; only the
seat lands on main. The maintainer may hand the seat to another LLM, and the others adapt and clean
up after the handover.

**Conduct that binds every worker.** The worker rules are
[`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md) §7
(path lease; no git writes; never `npm install`; no build or browser unless the dispatch authorizes
it; a mechanical handoff report), §8a-§8c (one deliverable per dispatch, negative controls, verifying
claims) and §8i (temp hygiene). In addition:

- Write a deliverable to disk incrementally; never hold a whole deliverable unsaved.
- If you **observe** an unexpected change in the tree, **report it**; never restore, revert or clean
  it — it may be another lane's live work.
- If the work needs a probe you are not authorized to run, say so plainly and stop (Principle 8:
  never substitute a request for the maintainer to verify by eye).
- Every reviewed unit becomes `_lane-out/<name>.patch` (`git diff HEAD --binary --no-renames`) plus a
  packet the same day. Uncommitted work older than one session is a handoff defect, not a checkpoint.
- No dependency mutation outside an owned clone, and none in a served or shared clone. Every install
  command is captured with its exit code, and the lock, manifest and installed tree are reconciled in
  one reviewed batch.
- An instrument that refuses every run is a ruling request, not a work queue: file the request in the
  same session (charter §1.1) and keep measuring by source review in parallel.
- Governance files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.clinerules`, the queue decision rows and
  `MAINTAINER_RULINGS_*.md`) are edited only under a seat lease, and a rule is never softened to "an
  open ruling" without first checking the rulings record (the queue's `AR-D*` rows and every
  `MAINTAINER_RULINGS_*.md`). Numbered principles are appended, never inserted mid-list; a duplicate
  heading number is a review blocker.
- Archival and doc moves are maintainer-held (hold of 2026-06-30) until lifted in writing.

**Where governed questions are answered.** Do not begin campaign work, and do not commit, build, run a
browser, publish evidence or change external state, until you have read the document that governs
that act. Reading a router is not the same as being briefed.

- Precedence between sources, tie-break included: [`EXECUTOR_LANE_CHARTER_2026-08-14.md`](migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md) §0.4 `[HARD]`; if it does not decide, stop and report the conflict.
- Verdict vocabulary and exit codes (`PASS` 0 / `FAIL` 1 / `ERROR` 2 / `STRUCTURAL` 3): Charter §1 status table; the frozen table is `Tools/visual-regression/lib/verdict-exit-gate.mjs`.
- That a measured red is never de-scored, demoted or quarantined: Charter §1.1 `[HARD]`; escalation route in §5.
- Evidence prerequisites, the clean validation manifest, banking a citation: Charter §1.7 `[HARD]`.
- Capacity, pausing, freezing, and the handoff you owe: Charter §4.
- Whether the campaign is paused or resumed **right now**: [`CAMPAIGN_STATE.md`](migration_doc/CAMPAIGN_STATE.md) (`R-2026-09-02-14`); a maintainer ruling in `MAINTAINER_RULINGS_*.md` outranks it — newest file wins, newest ruling within it.
- Branch, clone, path-lease and rebase rules; the handoff report; your dispatch rules as a worker: [`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`](migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md), §8a-§8c for dispatch.
- Who may commit, and how: `R-2026-08-18-28` and the charter's landing discipline (§2).
- Orchestration pattern; untrusted-content doctrine; git identity and authentication: [`ORCHESTRATION_HANDBOOK.md`](migration_doc/ORCHESTRATION_HANDBOOK.md) (§3 for identity; charter §2.6 governs identity-switching restraint).
- Symbols, seams, rulings, uniform/RTE contracts and spatial rigs for a target: Principle 13 and [`CONTEXT_SPINE_GUIDE.md`](migration_doc/CONTEXT_SPINE_GUIDE.md).
- How Codex's predecessor performed, and what to focus on: [`CODEX_SOL_OPERATING_BRIEF.md`](migration_doc/CODEX_SOL_OPERATING_BRIEF.md) — coaching, not rules.

---

## On-demand Skills

These rules live in `.claude/skills/<name>/SKILL.md` so they load only when their task comes up: Claude
Code lists them and invokes them as `/<name>`; every other agent reads the file. They bind exactly as
this file does, and **the work a skill covers starts by reading it**.

- `/wgsl-shader-pipeline` — before adding or changing a WGSL shader variant, a `ShaderDefine*` or
  `ShaderSourceId` entry, an `//>>ifdef` block, or shader-module / pipeline-cache keying.
- `/build-and-variants` — before building, testing, running visual regression or Playwright / Edge,
  touching the variant plugin, entry barrels or `sideEffects`, or adding a file under `Renderer/WebGPU/`.
- `/logging-pragmas` — before adding or changing a log or debug pragma in engine code, and when
  creating a new renderer / pipeline subsystem (its permanent sentinels).
- `/upstream-sync` — before merging CesiumGS `upstream/main` into the fork.
- `/wasm-strategy` — before adding or changing a WASM module, bridge or toolchain.
- `/debug-console` — when debugging rendering with `CesiumDebug`, and when you fix a bug (how to
  record it in `WEBGPU_DEBUGGING_LOG.md`).
- `/engine-code-standards` — before any change under `packages/**`.

---

## Key Reference Files

[`migration_doc/README.md`](migration_doc/README.md) indexes every migration doc (LIVE vs ARCHIVED); start
there and trust it over any single doc's self-description (the former reference list is in
[`RULES_FILE_NOTES.md`](migration_doc/RULES_FILE_NOTES.md) §3). Two guides carry a sync duty:

- [`DEBUGGING_GUIDE.md`](migration_doc/DEBUGGING_GUIDE.md), the single entry point for debugging tools and procedures: it **MUST be kept in sync whenever you add a new CesiumDebug command, probe, or globe-fragment debug mode.**
- [`IMAGERY_PROJECTION.md`](migration_doc/IMAGERY_PROJECTION.md), the single source of truth for imagery-layer projection: it **MUST be kept in sync whenever you touch any file in the projection chain** (`*ImageryReprojection*`, `GlobeFS.glsl`, `GlobeTerrain.wgsl`, `WebGPUGlobeSurfaceTextures.ts`, `WebGPUGlobeSurfaceTileUB.ts`, `WebGPUGlobeSurfaceCameraUB.ts`, `ImageryLayer.js`, `ImageryLayerHelpers.js`).
