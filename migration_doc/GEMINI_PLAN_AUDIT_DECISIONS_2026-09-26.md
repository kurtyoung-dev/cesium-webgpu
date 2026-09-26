# Decisions for the maintainer: Gemini's comment-and-documentation plan (2026-09-20)

_RULED 2026-09-26: see [`MAINTAINER_RULINGS_2026-09-26.md`](MAINTAINER_RULINGS_2026-09-26.md) (`R-2026-09-26-13`…`-22`; every recommendation adopted — G9 as the re-framed A, G10 as A′ — and every other sound option recorded there as a fallback). This file stays as the full option analysis; the audit is [`GEMINI_PLAN_AUDIT_2026-09-26.md`](GEMINI_PLAN_AUDIT_2026-09-26.md). "Nothing here has been executed" below is this file's state when written._

Written 2026-09-26 by Adamanta (Opus 5.5), synthesizing the audit
`GEMINI_PLAN_AUDIT_2026-09-26.md`, tracked beside this file. Each item below lists only options that
can be carried out as written, with a recommendation.

Evidence is cited as `§n` of the audit, or as `file:line` at seat tip **`b263d8ac5e`** (Batch 1537). That batch
changed only `Tools/` specs and `TOOLING_CATALOG.md`, so every engine `file:line` is the same as at `a76d42b3f8`,
where this audit began. Nothing here has been executed. Revised after the critique (`cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/CRITIQUE_DONNAMIRA.md`). See
"Changes after critique" at the end.

**Premise correction first.** The document at
`migration_doc/CODEBASE_CODING_AND_COMMENT_STANDARDS_AUDIT_2026-09-14.md` is not the maintainer's own
audit. It is **Gemini's earlier audit document**, which the maintainer holds untracked until nine
corrections are applied (`R-2026-09-16-11`; `R-2026-09-17-2`: "Gemini's audit document LANDS after
the nine corrections"). The maintainer's own conclusions on this subject are the rulings
`R-2026-09-16-11`, `R-2026-09-17-2`, `R-2026-09-17-6` and `R-2026-09-17-7`. G1 is framed with that in mind.

---

## G1 — Which plan governs the work

- **A. Execute the C16 tail from `QUEUE_2026-08-10_CAMPAIGN16.md`, and bank Gemini's plan and inventory
  as evidence.**
  - The queue stays the sole status authority (`R-2026-09-17-6`).
  - The work runs as the 13 batches in audit §7, against rows `C16-09`..`C16-12`, `C16-20` and
    `C16-21`, under the shard protocol.
  - What survives from Gemini's plan is its inventory, which equals the guard census plus 32 regex
    hits. The channel (G2), the phases, the gates and the scope are all replaced.
  - Gemini's plan, inventory and scripts are banked in `cesium-webgpu-worker-archive/`, not in the
    tree.
  - The 09-14 document's nine corrections continue on their own track, as a record
    (`R-2026-09-17-2`).
- **B. Reverse `R-2026-09-17-6` (and `R-2026-09-17-2`'s record-only status for the 09-14 document).**
  Apply that document's nine corrections plus this audit's (Phases 1 and 3 already discharged by
  Batch 1498; `any` fallbacks at 139 in 19 files, not ~50 in ~10). Land it, then make it the execution
  authority for the comment work, executing from its shard table. This is a **reversal** of two
  in-force rulings. It is listed only so that the choice is explicit.

**Recommendation: A.**

- It is what the in-force rulings already say. `R-2026-09-17-6` folded this comment mass into the C16
  rows plus `C16-21`, and the queue declares itself "sole status authority for C16".
- The plan's guard-visible half is exactly the C16 census: 179 findings in 83 files, re-run at the tip.
- B would put an untracked document from an external model into the execution path. That document
  still owes nine corrections (none applied as of 09-17), and it lacks the protocol steps this audit
  found missing.

## G2 — Where relocated knowledge lives (the `Documentation/Features/` question)

- **A. The existing channels only. No new channel.**
  - A constraint is rewritten in place in the source.
  - History that carries a *why* moves verbatim into `migration_doc/DEV_NOTES_<subsystem>.md` in the
    same batch, per `ForkCommentStandard.md` §2 and `DEV_NOTES_FORMAT.md`. Fourteen such files exist.
  - An open follow-up becomes a `DEFERRED_WORK` row.
- **B. A, plus an upstream-style usage guide when needed.** When a feature has user-facing usage that
  the API reference cannot carry, it gets `Documentation/<Name>Guide/README.md`, the upstream
  convention (`CustomShaderGuide`, `FabricGuide`, `OfflineGuide`).
  - It is linked from JSDoc by the fork's absolute URL.
  - It is gated by markdownlint, prettier and a reviewer link check.
  - It is created on demand, never used as a relocation target.

**Recommendation: A.**

- None of the five sources needs a new channel. The audit's §5 verdicts are: TideModel stays in
  JSDoc; Snapshot is re-derived and banked; BufferPrimitives, Wasm and Kernels are dropped.
- The written standard, the C16 binding gates and Gemini's own 09-14 document all name DEV_NOTES.
- `Documentation/Features/` as proposed is excluded as an option. Upstream has no such directory.
  `.npmignore:22` excludes `/Documentation`, so the plan's "permanent documentation for users" premise
  is backwards. No checked-in verifier covers it. And it would publish stale status text as
  permanent: SnapshotModeService (audit §2.3) and WasmArenaSlots (§2.4).

## G3 — May published-API JSDoc be rewritten? (versus "preserve ALL existing JSDoc")

The rule in CLAUDE.md and `ForkCommentStandard.md` §5 is scoped to *modernizing*. A comment-only batch
is not modernization, so the rule's letter does not decide this. Its purpose, and Batch 1509's
restoration of stripped public blocks, argue against shortening published reference material.

- **A. Marker-strip in place.**
  - A published `/**` block may lose only tracker vocabulary (row, batch, ruling and ledger ids;
    tracker-document paths), and may have a stale claim corrected against present-day code.
  - Every technical sentence, tag, type and `@private`/`@internal` stays.
  - No block is shortened or moved out.
  - Proof:
    - The `build-docs` output diff is confined to the touched doclets.
    - `compareDeclarations` reports the declarations structurally equal.
    - The count of `any` fallbacks does not rise.
- **B. As A, plus a maintainer sign-off.** The maintainer signs off the rendered before/after of each
  published source file:
  - the seven carrying tracker text today: `CustomShader`, `Atmosphere`, `Material`, `TideModel`,
    `SampledPositionKernel`, `WasmFeatureDetection` and `WasmArenaSlots`;
  - the tide siblings.

**GLSL note (added after critique).** In GLSL, a `/**` ↔ `/*` change, a one-line doc block, or `//`
text on a closing `*/` line is a runtime change, because `ShaderSource.removeComments`
(`ShaderSource.js:8-21`) reads doc-block shape in unminified builds. Under either option, GLSL doc
blocks keep their shape (audit §7.1 U1c).

**Recommendation: A.** It keeps the published derivations and caveats, for example TideModel's "not a
prediction" and SampledPositionKernel's lane layout. It removes only what the fork's standard bans. The
proof catches a typings regression mechanically. B is the stricter choice if you want your own eyes on
the public reference.

## G4 — The cleanlist ratchet for the 100 files

The ratchet itself is already ruled design: `ForkCommentStandard.md` §8 item 2, and the shrink-only
ledger of `R-2026-08-21-18`. Deferring appends to a final phase is not an option. The guard exits 1 on
a stale grandfather row in any commit that stages the file (audit §3).

- **A. Append each certified file in the batch that certifies it, in the same commit, and retire that
  batch's grandfather rows in the same commit.** Over the wave that is 80 appends and 15 retirements
  (audit §7.2). The 80 are the 76 unlisted inventory files plus the four tide siblings, none of which
  is clean-listed (re-checked after critique). The five files flagged only by Gemini's regex are appended too:
  - `ComponentDatatype.d.ts`
  - `Resource.d.ts`
  - `Sync.js`
  - `WebGPUIndirectDrawManager.ts`
  - `MVTTileDecoder.js`
- **B. As A, except the five regex-only files.** They are appended only after B7's new grammar rules
  land, so their clean-list entry enforces something the day it is added.

**Recommendation: A.** Clean-listing those five costs nothing. No in-flight lane writes any of the 80
files. It makes any future grammar-visible regression an error immediately.

## G5 — Governance-document citations in shipping comments

There are 28 `CLAUDE.md` citations in 20 files. Each names a real constraint: 13 permanent sentinels,
9 backend agnosticism, 2 RTE, 2 co-located `.d.ts`, 1 ShaderDefine add-only, 1 Principle 7. The
written standard and the grammar are both silent on them.

- **A. Rule them out.**
  - Each is rewritten to its constraint: the constraint sentence stays, the citation goes.
  - Five of them sit on `// lint-debug-pragmas-allow:` lines. The prefix must survive; only the reason
    text changes. This is compatible with G10 only under prefix-only retention (G10-A′) or lane-local
    checks (G10-B′). Whole-comment retention would freeze the reason text.
  - A rewritten sentinel sentence must not quote `//>>includeStart(…)` syntax. The release pragma strip
    matches it even inside prose and strips the sentinel it describes (audit §3, U1a).
  - A narrow `C16-21` rule (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) lands in B7, after the last citation
    is gone, so no grandfather row is ever added.
- **B. Allow them.** Fix only the four real leaks, for example `MVTTileDecoder.js:12` "see migration_doc
  R-4". Grow the grammar only for leak shapes: `migration_doc` without a slash, `ruling T\d`,
  `AUDIT_\d{4}_\d{2}_\d{2}`.

**Recommendation: A.**

- "per CLAUDE.md §2" fails the seamlessness test (`ForkCommentStandard.md` §1). An upstream reader
  cannot resolve it.
- The constraint loses nothing when stated directly.
- Landing the rule last respects the empty-grandfather clause.
- Under either option, model names (Gemini, Astra, Sol, GPT) stay out of the grammar. They produced 0
  hits, and they already needed hand suppressions: the constellation Gemini and "Jean-Claude".

## G6 — The upstream false positive (`Core/IonSnapMode.js:4`)

`all-caps-fix-label` matches a Bentley documentation GUID inside a `{@link https://…}` URL. The file is
byte-identical to `upstream/main`. Editing that line is excluded as an option: it breaks a valid link
and diverges from upstream.

- **A. Narrow the grammar.** `all-caps-fix-label` skips tokens inside a URL, with a self-test negative
  example. This lands under `C16-21` in B0-tools, and `IonSnapMode.js` is appended to the cleanlist
  untouched.
- **B. Record a named exception.** Leave the grammar alone and record the line in `C16-20` leg (1) as a
  named, upstream-verbatim exception.

**Recommendation: A.** Narrowing a rule cannot expose anything. The census becomes honest (179 → 178).
`C16-20` leg (1) can then reach a real 0 without a standing exception.

## G7 — Who writes the rewrites

The authoring surface is about 170 flagged lines. The review surface is larger, because every rewritten
claim must be re-derived against present-day code. In `C16-11` the reviewer caught 10 stale claims.

- **A. Opus 5.5 throughout.** Opus 5.5 authors every batch. A separate Opus 5.5 station-3 reviewer
  checks each one. One Opus 5.5 tier-2 lead runs the wave with at most five tier-3 authors at a time.
  The optional adversarial Opus 5.5 verifier is used on B0-tools, B1 and B5a. B0-tools was added
  after critique, because it carries every later batch's proof.
- **B. Gemini for the simplest batches only.** Gemini (gemini-3.8-flash-high via `run-gemini-worker.sh`)
  authors **B3a and B3b only**. These are the pre-listed label strips in `.js` files that touch no
  `/**` block and no directive line, and each has an Opus 5.5 reviewer. Opus 5.5 authors the rest.

**Recommendation: A.**

- You asked to lean on Opus 5.5 in the lower tiers.
- The token saving from B is small, because review dominates and costs the same either way.
- Gemini's own plan shows the failure modes this work punishes: it invented a second knowledge home,
  got its own counts wrong, omitted the anchor-sweep tool, set an unreachable gate and misplaced the
  grandfather retirement.
- `reference_antigravity_gemini_worker.md` excludes Gemini from engine and shader judgement.
- B stays within `R-2026-09-17-7` if you prefer it. I narrowed Gamgee's proposal, which also gave
  Gemini the non-sky shader batch, because shader comments are shader judgement.

## G8 — Sequencing against Astra and CI wave 2

- **A. Start now and interleave.**
  - After the rulings, B0 baselines are measured in a disposable clone.
  - **B0-tools lands first.** Its gate is the CI `guards` job green at the landing base. That job was red
    at `a76d42b3f8` (landing-rule test 269) and is **green at `b263d8ac5e`** (run `36220924784`, read
    after the critique). Every later batch depends on B0-tools.
  - B1, B2a, B2b, B3a, B3b (without `Snapping.js`), B3c, B4 (without `Resource.d.ts`) and B6
    land one at a time between the tranche-2, C15-06 and Astra landings, each rebased onto the tip.
  - Gated items:
    - B5a and B5b wait for W2-L5. That lane re-anchors karma specs that slice those shaders on comment
      headers.
    - `Snapping.js:407` waits for W2-L8, or gets a rewrite that keeps line counts unchanged.
    - `Resource.d.ts` waits for Angrim (W2-L11).
    - B6-sky follows Astra's sky pieces, or runs `sky-light-direction.spec.mjs` on both trees.
    - B7 goes last.
  - No Edge slot is used, **provided U1a-U1e are in force** (G10-A′ or G10-B′). The wave-end gate
    (`R-2026-08-29-2`) then rides the next scheduled wave-end Edge job. If neither G10 option is taken,
    B6 and B6-sky each need a WebGL leg on the unminified dev build before the next engine landing
    (audit §7.3).
- **B. Hold the whole wave until CI tranche 2 and Astra have landed, then run it in one stretch.** The
  same B0-tools-first order and the same U1a-U1e condition apply.

**Recommendation: A.**

- Only one of the 100 files is in Astra's 81-path patch (`WebGPUFeatureRenderers.ts`, hunks about 245
  lines apart; re-measured).
- None is in a tranche-2 lane's write set.
- The Astra audit's collision reader found no ordering constraint either (`cesium-webgpu-worker-archive/lanes-2026-09-26/astra-audit/R5_COLLISIONS.md` §3 item 3).
- B is safe but costs calendar time for no risk reduction beyond A's four gates.

## G9 — The `build-ts` gate (re-framed after critique)

**The premise has changed.** `build-ts` and `build-docs` are **green in CI at the tip**. The CI step is
`release-tests` → "release build" = `npm run make-zip` (`dev.yml:128-129`, no `continue-on-error`). That
runs `release` = `series(buildRelease, parallel(buildTs, buildDocs))` (`gulpfile.js:620-623`). `buildTs`
runs both `tsc` projects through `execSync` (`gulpfile.js:1484-1491`), and `buildDocs` runs
`jsdoc --pedantic` through `execSync` (`:425-437`). Both throw on any error. The step succeeded in run
`35467592179` (`a76d42b3f8`) and in run `36220924784` (`b263d8ac5e`). So the `C16-02c` row ("21
pre-existing `error TS` … PENDING") is stale, and the seat can record that on this CI evidence. Both
jsdoc configs read `.js` files only. Gemini's own "`build-ts` exit 0" gate is reachable as written.

- **A. Strict gate on the batches that can move it.**
  - Per batch: `npm run build-ts` and `npm run build-docs` **exit 0**. `compareDeclarations` reports
    `Source/Cesium.d.ts` structurally equal to the B0 base. The `any`-fallback count is not higher.
    The `Build/Documentation` diff is confined to the touched doclets.
  - It runs on batches that edit a `.js` `/**` block (B1, B2a, B2b, B3c, and B3a/B3b if one is touched)
    and once at the wave's end.
  - B0 still saves a local base `Source/Cesium.d.ts` and `Build/Documentation` for the diffs. The seat
    corrects the `C16-02c` row in the first landing's ledger edit.
- **B. As A, but run both builds on every batch**, uninformative runs included.

**Recommendation: A.** Running the two builds on `.ts`, `.wgsl` and `.glsl` batches cannot change their
output, because both configs read `.js` only. B spends about 5 minutes per batch proving nothing. CI
runs both builds on every push anyway, as a backstop. Choose B if you want the literal "every batch
runs all four" bar.

## G10 — Comment text that a machine reads: the `comment-only-diff` gap (re-scoped after critique)

`comment-only-diff` certifies the source token stream, not the built or run artifacts. Six gaps are
confirmed, and each was reproduced with a synthetic before/after pair that the tool calls
`comment-only` (audit §3, §11):

1. `// lint-debug-pragmas-allow` (read by `lint-debug-pragmas.mjs:46`) and `/// <reference>`. No
   `SEMANTIC_COMMENT_RULES` entry covers them (`comment-scanner.mjs:115-259`).
2. Bundler magic comments, e.g. `/* webpackIgnore: true */` at five B3c sites. Nothing protects them.
3. The release pragma strip (`constructRegex`, `scripts/build.js:51-63`) matches pragma text quoted in
   prose.
4. The minify-time WGSL strip (`scripts/build.js:845`) does not nest block comments.
5. `ShaderSource.removeComments` (`ShaderSource.js:8-21`) reads GLSL doc-block shape at runtime in
   unminified builds.
6. The ASI newline loss (DX-8).

All of them are green over the whole corpus at the tip, so every check below starts green.

The first-pass option A, whole-comment retention of `lint-debug-pragmas-allow`, is withdrawn. The
scanner keeps a retained comment whole (`comment-scanner.mjs:880-883`). That would freeze the five
reason texts at `WebGPUDeviceLossRecovery.ts:591,627,651,695,718`, which G5-A rewrites, so B4 could
never pass U1. The first-pass option B was unsound for B3c, B5 and B6.

- **A′. Make the shared tool flavour-aware in B0-tools.**
  - **Prefix-only** retention for `lint-debug-pragmas-allow` and `/// <reference`: the directive token
    is code, and the reason text stays prose.
  - A `bundler-magic-comment` semantic rule, retained whole.
  - Per-flavour views in the comparison: the release pragma view via the exported `constructRegex`,
    requiring 0 anchors that do not open their line; the `stripWgslComments` view for `.wgsl`; and a
    vendored `removeComments` view for `.glsl`, byte-pinned to `ShaderSource.js:8-21` and required
    not to throw and to keep code and the `czm_` token set identical.
  - The ASI fix.
  - Whole-corpus agreement specs in `test-build-infra` (WGSL in
    `Tools/build-infra/wgsl-chunk-resolution.spec.mjs`) and unit specs in `test-c16`. Each gets a mutant
    showing it fires.
  - "Comment-only" then means "comment-only in every flavour" (U1).
- **B′. Leave the shared tool alone. Every comment batch runs the same checks as lane-local scripts.**
  These are U1a-U1e in audit §7.1. In addition, B4 carries `npm run lint-debug-pragmas` and a reviewer
  prefix check, and B3c a magic-comment count-and-bytes check. The corpus agreement specs are still
  added in B0-tools, because they guard future edits too.

**Recommendation: A′.**

- It makes the tool match `ForkCommentStandard.md` §8.4 and the fork's real transforms, once, with
  existing runner homes (`test-c16`, `test-build-infra`).
- It protects every future comment edit, not only this wave.
- It is what makes the no-Edge rationale in G8 true.
- B′ is sound but duplicates the same scripts across up to 11 lanes. It also leaves the next comment
  campaign unprotected.

---

### Not decisions, but owed under the fork's own rules (recorded so they are not lost)

- **Principle 9.** A `DEFERRED_WORK` row for SnapshotModeService's shared-context multi-view limitation.
  It points today at the historical `WEBGPU_MIGRATION_BACKLOG.md`. The row goes in B2b.
- **Stale Principle-7 claims are corrected in place**, never relocated:
  - SnapshotModeService "registration skeleton only". Three freezables are live:
    `WebGPUEnvironmentRenderer.js:2424`, `WebGPUVolumetricFogRenderer.ts:887` and
    `Scene.js:4630-4633`.
  - WasmArenaSlots "one spare slot". `NUM_SLOTS = 8`, and slots 0-7 are all used.
- **`C16-02c` is stale.** CI shows `build-ts` and `build-docs` green at the tip (G9). The seat corrects
  the row in the first landing's ledger edit.
- **DX rows DX-1 … DX-9** (audit §9). DX-2, the sky-light-direction spec with no runner that pins comment
  text, blocks B6-sky's review until it has a runner home or is run directly.

---

## Changes after critique

Critic: Donnamira (`cesium-webgpu-worker-archive/lanes-2026-09-26/gemini-plan-audit/audit/CRITIQUE_DONNAMIRA.md`). All ten MUST-FIX items are accepted. Each was re-derived at
`b263d8ac5e` before editing: the synthetic cases were reproduced, the corpus baselines re-run and the
CI runs read. Audit §11 has the evidence.

- **G1 (F8).** A is relabelled "Execute the C16 tail from the queue; bank Gemini's plan and inventory".
  B is kept only as an explicitly labelled reversal of `R-2026-09-17-6` and of `R-2026-09-17-2`'s
  record-only status.
- **G3 (A4).** Added a GLSL note: doc-block shape is read at runtime.
- **G4 (A5).** 76 → 80 appends. None of the tide siblings is clean-listed.
- **G5 (A6, F6).** The prefix-only condition and the no-quoted-pragma constraint are added.
- **G7.** The adversarial verifier is added to B0-tools.
- **G8 (F9, F10).** B0-tools first, gated on a green `guards` job, which is met at `b263d8ac5e` (run
  `36220924784`). The no-Edge option is conditional on U1a-U1e.
- **G9 (F7).** The premise is replaced with the CI evidence. The gate is now strict exit 0 plus
  structural equality. `C16-02c` is recorded as stale.
- **G10 (F1-F6).** Re-scoped from two directive shapes to six confirmed gaps. The first-pass A is
  withdrawn (the deadlock with G5-A) and so is the first-pass B (unsound for B3c, B5 and B6). They are
  replaced by A′ (shared tool made flavour-aware, prefix-only retention) and B′ (the same checks
  lane-local).
- **Tip (F9).** Every tip reference is now `b263d8ac5e`. Engine `file:line` citations are unchanged.
