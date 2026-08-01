# Handoff — 2026-07-25 (orchestrator seat → Sol)

> **SUPERSEDED EXECUTION SNAPSHOT (2026-07-26).** Preserve this document as the
> Batch-767 handoff record, but do not execute its clean-tree/discard workflow
> or treat all four listed lanes as unlanded. Main has advanced through Batch
> 770: S6 is landed, the reconciled S5 work is active in the shared working
> tree, and its changes must not be discarded. Use
> [`CLAUDE_PROGRESS_AUDIT_2026-07-26.md`](CLAUDE_PROGRESS_AUDIT_2026-07-26.md),
> the live campaign queues, and current `git status` as execution authority.
> The pipeline-aliasing, environment-clear, and globe-readiness worktrees
> remain parked and require their documented runtime gates.

**Written at:** `main` = Batch 767 `3e99189a6a`, pushed, in sync with `origin/main`.
**Reason:** weekly capacity limit reached mid-flight. Nothing is broken; four completed
changesets are parked in worktrees awaiting machine cycles.

Read this with [`project_state_2026_07_25`](#) in the orchestrator's memory (the resume
anchor) — this doc is the execution state, that one is the doctrine.

---

## 1. THE ONE THING TO UNDERSTAND FIRST

**`main`'s docs are accurate as of Batch 767 and describe NONE of the four unlanded
changesets.** Every doc edit for the eclipse, pipeline-cache, and env-clear work lives
inside its own worktree and lands with its changeset. Do not "reconcile" main's docs to
match the work — the work will bring its own docs when it lands.

The working tree may be dirty with a partially-applied changeset from a stopped cycle.
**That is the normal between-cycles state.** Every executor cycle begins by reducing to
clean HEAD and re-applying from a worktree, so a dirty tree is safe to discard.

---

## 2. CAMPAIGN STATUS (verified against the queue docs, 2026-07-25)

| Campaign | State | Evidence |
|---|---|---|
| 1–8 | Closed / frozen. C8's open IDs transferred to C9; its completed slices remain regression gates | `README.md`, C8 queue |
| 9 | **CLOSED GREEN** | C9-30 verdict |
| 10 | **CLOSED** at Batch 711 (`9a52717cf2`) | C11 queue header |
| 11 | **PAUSED — open remainder retained.** Did NOT reach its exit gate and is not closed. The `clouds-weather` cluster (`C11-124..130`, `C11-SEED-10..18`) transferred to C13 with IDs retained as aliases; **every non-cloud row remains owned by C11 at its recorded status.** Certification HELD by maintainer ruling 2026-07-23 — the W2–W8 body executes before any `C11-137` certification | C11 queue, status update 2026-07-23 |
| 12 | **LAUNCHED 2026-07-23, EXECUTING.** The eclipse work in flight is `C12-29` | C12 queue header |
| 13 | **LAUNCHED 2026-07-23, EXECUTING.** Orchestrator-owned (the Sol 5.6 lane closed 2026-07-23; takeover brief `SOL_C13_REVIEW_2026-07-23.md`) | C13 queue header |
| 14 — Dynamic Ocean & Wind | **PLANNING COMPLETE.** Six decisions answered (§6a), phases W0–W5 defined, prereqs named (`C11-172` ✅ landed 757, `C6-FFT-OCEAN-CLIPMAP`, `C13-14` for W5 only). **NOT LAUNCHED** — maintainer ruling O5 is strict: waits for C11 + C12 + C13 **completion** | `DEFERRED_WORK.md:49`, `OCEAN_DYNAMICS_PLAN_2026-07-24.md` |
| 15+ — Meshlets | **RESEARCH COMPLETE.** Tier 1 recommended, WebGPU-only, Phase-8b-adjacent. Launch gate: `C11-168`'s dense-tileset measurement lane (no baseline = no provable win) | `DEFERRED_WORK.md:65`, `MESHLETS_RESEARCH_2026-07-24.md` |

**Answer to "are any of 10–13 complete?"** Only **10**. 11 is paused-open, 12 and 13 are
mid-execution. **Campaign 14 is fully planned but correctly blocked** by O5.

### Doc drift found and FIXED in this handoff commit
`README.md` said *"Campaign 12 remains draft/not launched"* — contradicted by the C12
queue's own `✅ LAUNCHED 2026-07-23` header. Corrected. No other campaign-status
contradiction was found between `README.md` and the queue headers.

---

## 3. THE FOUR UNLANDED CHANGESETS

All four are green on their own gates. All four need machine cycles. **None has been
committed.** Run them in the order below — it is dependency-ordered, not arbitrary.

### 3.1 Eclipse S5 — lunar umbra on the globe
- **Worktree:** `worktree-agent-a6de88899b2982d6c`
- **Scope:** 10 engine + 4 Tools + 5 docs. New `Scene/EclipseGlobeShadow.js`.
- **Proven:** feature confirmed in pixels **four separate times** (globe lit, distinct
  umbra over central Mexico, solid core, graded penumbra, zero bright pinholes). All five
  regressions green. `equivalenceWorstRel = 0` on both backends. `tsc` + `gulp build`
  green. Specs 46/46 in both library modes; both shared validators return `[]`.
- **One real code fix landed in it:** the shadow gate omitted `enableEclipse`, so turning
  eclipses off left the umbra painted. Now
  `mode === SCENE3D && enableEclipse !== false && enableEclipseGlobeShadow !== false`,
  and the machine confirmed `offBlockParams.x = 0` on both backends.
- **Every other failure it ever had was probe-side.** Four were fixed in the last round:
  the width gate compared two different isolines across the display chain (now measures
  the model-free **plateau**); lane (g) was anchored at totality where the dimming
  correctly blacks the pixel, making its identity vacuous (re-sited into the penumbra with
  a lit-anchor arm); the far-field ray was a fixed ±4000 km span on an eclipse whose
  penumbra is wider (now sited from a **computed** edge, zero samples = STRUCTURAL); and a
  gate read its uniform at the wrong vantage.
- **NEXT:** executor cycle v7. It was running when the session stopped — nothing lost.

### 3.2 Eclipse S6 — sky totality + star reveal
- **Worktree:** `worktree-agent-a480e24d73c9b7c96`
- **Scope:** ~19 engine + probe/spec/libs. **Owns `Tools/visual-regression/lib/same-task-capture.mjs`,
  the fleet's canonical capture module** — S5 embeds its text and validates against it, so
  S6's landing order matters (see §5).
- **★ THE MAINTAINER'S HEADLINE IS DEMONSTRATED.** Stars appear at totality that are not
  present at the clear instant: `starSumOn` 26.6/26.2 vs `starSumOff` 0; `starMaxOn` 18.026
  above a 13.9 no-stars control; `revealHappens`, `noStarsWithoutTheEclipse`, `revealParity`
  all true on both backends. **Independently corroborated** by an executor census sharing
  no code with the probe: 0 point sources before, 14–15 after, peak luminance 18.0 matching
  the engine's 18.026, same stars at the same pixels on both backends.
- The atmospheric half is also done: a visibly warm twilight band hugging the horizon, sky
  darkening ~7×, lane C passing on both backends with cross-backend parity to ~0.001.
- **Cross-slice coupling RESOLVED (was a landing blocker):** S6's ruling-E3 default flip
  (`enableStarBrightnessModulation: true`) made a lighting site live that S2's equivalence
  twin had excluded *on the justified grounds that it was inert*. S2's own asserted
  tripwire fired. Resolved by **modelling** the site in the manual twin — re-justification
  was eliminated on evidence (the star cubemap composites through the very band the gate
  measures), and disabling the modulation for the capture would test a configuration the
  engine no longer ships. `eclipse-scene-dimming.spec.mjs` is **31/31 for the first time**.
- **Specs 44/44.** Two lanes will return numbers that have never existed: the multiplier
  lane (now ratios the modulated component in isolation, sky cancelled) and the sprite lane
  (its aiming helper read a stale uniform and aimed hours of Earth rotation away).
- **NEXT:** executor cycle v4. Expect first measurements, not necessarily passes.

### 3.3 Pipeline-cache aliasing fix
- **Worktree:** `worktree-agent-a68f438fcb2e102c1`
- **The defect:** `WebGPURenderPipelineCache.generateCacheKey` hashes `descriptor.name`,
  `variant.*`, `ms:`, `df:`, `tg:`, `vx:` — **never the shader module, entryPoint, or any
  define mask.** Correctness is delegated to callers stamping the axis into a free-form
  name. Confirmed against three independent kill attempts.
- **Eight at-risk sites fixed.** Two of them were in files a brief had called *safe*: the
  Gaussian-splat **velocity** pipeline, and `WebGPUModelPipelineCache`'s glTF **colour**
  pipeline — the highest-traffic descriptor in the fork.
- **Reachable through public API** for the non-globe sites: they gate on
  `frameState.useLogDepth`, cleared by **any** orthographic transition, and their rebuild
  guards are precisely the aliasing precondition. The globe is latent (its master switch is
  pinned and no engine code writes it).
- **Previously found and mis-triaged.** `audits/2026-06-11_ULTRA_REVIEW_findings.json:2630-2636`
  marked it confirmed-real then downgraded it to *low* — sound for the globe, falsified for
  the siblings. That asymmetry is why it survived to HEAD.
- **`cacheStats()` cannot detect it — aliasing RAISES the hit rate.** A proposed
  `wrongModuleHits` counter is queued as a maintainer decision (§6).
- Spec **46/46** with a taint-set analyser (not a grep) and three live marker-removal
  proofs. `DECLARED_UNVERIFIED` was replaced with two **asserted** invariants
  (`NO_CENTRAL_CACHE`, `MODEL_CENTRAL`) that go red if a renderer migrates onto the central
  cache or gains a second central call site.
- **NEXT:** `probe-pipeline-key-aliasing.mjs` is **UNRUN and therefore UNVALIDATED.**
  Run `--expect-collisions` FIRST. **A clean detection result means nothing until the
  negative control has fired.**

### 3.4 WebGPU canvas-clear parity fix
- **Worktree:** `worktree-agent-aa59196f79bb47e99`
- **The defect:** with all environment content hidden, WebGPU rendered the canvas black
  regardless of `scene.backgroundColor` — black background → 0, white background → 0.
  WebGL correct throughout. Isolated by bisection to exactly one step: `sun.show = false`.
- **Root cause, and it was self-documented:** `_clearColor` is set once to `(0,0,0,0)` and
  never rewritten, because the deferred-canvas-clear path deliberately did not record the
  requested colour — the pre-fix source says so, "ledgered as a WebGL-parity follow-on
  candidate, not this slice."
- **Right altitude:** WebGL's `Renderer/Context.js:1298-1320` records every requested clear
  value into clear-state *before* `gl.clear`; the WebGPU port kept only the clearing half.
  Fixed inside `clear()` via a new pure `Renderer/WebGPU/WebGPUCanvasClearState.ts`. No
  contested file touched.
- **Blast radius EXONERATED** by a 22-agent assessment: `alphaMode` is `"opaque"` on all
  three configure paths (the only `configure()` call sites), so transparent-black was never
  representable as transparency; the default background is opaque black with RGB identical
  to the pre-fix value, so default frames are byte-identical. Of 190 VR files touching
  `backgroundColor`, 168 pin black/near-black and the rest are all alpha=1; a repo-wide grep
  for any background with alpha < 1 returns nothing. **No re-baseline expected** — confirm
  empirically on the VR run.
- Spec **15/15** with teeth demonstrated against two reverted states, including one that
  catches a correct module placed *after* the drop (dead code).
- **NEXT:** `probe-env-background-clear.mjs` (unrun) + a VR suite pass to confirm no
  baseline moves.

### 3.5 Also parked
`worktree-agent-a578d39752cd7819c` — `probe-globe-pipeline-readiness.mjs` (51/51, unrun).
Measures whether WebGPU's globe-tile pipeline skip is reachable with a healthy event loop.
Related engine finding: WebGPU skips any globe tile whose pipeline is still compiling, with
no last-good, no sync fast path in the normal configuration, and no hold-previous-frame;
WebGL compiles synchronously with no per-tile skip. Presents as a transparent planet during
fast camera moves or a cold pipeline cache.

---

## 4. HOW TO RUN A CYCLE (the executor contract)

The pattern that works, and the traps that cost cycles today:

1. **Reduce to clean HEAD.** Restore every modified tracked file via
   `git cat-file blob HEAD:<path> > <path>`; delete the changeset's untracked files.
   Hash-verify each with `git hash-object --no-filters` vs `git rev-parse HEAD:<path>`.
2. **`git diff HEAD --numstat` is CONTENT TRUTH.** `git status` over-reported modified
   files in **seven consecutive cycles**, including files the changeset never touched.
   Never trust a status-only claim.
3. **Use `git ls-tree`, not `git rev-parse`, to test whether a path exists at a commit.**
   A `rev-parse` fallback mislabelled new files as merges.
4. **Line endings.** Worktrees are CRLF, HEAD blobs are LF. Measure with
   `tr -cd '\r' | wc -c` — **`grep -c $'\r'` reports 0 falsely under MSYS.** Convert with
   `perl -0777 -pe 's/\r\n/\n/g'`, **never `tr -d '\r'`**: at least one doc contains
   *literal lone CR bytes as content* (prose quoting those very commands), and a blanket
   strip destroys them. Report CR / CRLF-pair / lone-CR counts per file.
5. **Doc merges:** after each, grep a distinctive string from BOTH sides and confirm each
   appears exactly once, and **check numstat parity** — a modified line reads `N N`; an
   `N 0` is the tell that a block-concatenating resolver kept both sides of the same line.
6. **`gulp build` is the only gate** that catches a missing `export default` in a new
   `Source/**/*.js`. It must pass.
7. **Delete a probe's artifacts before running it** and verify what you read post-dates the
   build. A stale PNG produced a confident false exoneration today.
8. Workers never commit. Never run `gulp build` from a worktree — `node_modules` is
   junctioned to the main tree and the build writes there.

---

## 5. RECOMMENDED LANDING ORDER

1. **S6 first**, because it owns `lib/same-task-capture.mjs` and S5 embeds that module's
   canonical text. If S5 lands first, main carries an embedded copy with no library to
   arbitrate against.
2. **S5 second** — its spec then validates byte-identity against the real library rather
   than falling back to local equivalents.
3. **Pipeline-cache** and **env-clear** are independent of both and of each other; order
   between them is free. Both need their probes run first, and the pipeline probe needs
   `--expect-collisions` before any clean result is meaningful.

`Scene/AtmosphericConditions.js` is the shared merge point — it now carries
`eclipseAutoExposure`, `enableSolarLimbDarkening`, `enableSolarGlareFalloff` (all landed),
plus `enableEclipseHorizonTwilight` (S6) and `enableEclipseGlobeShadow` (S5). Every landing
is a pure additive union; keep every key declared exactly once.

---

## 6. MAINTAINER DECISIONS QUEUED (do not decide unilaterally)

1. **Four broken pipeline getters** (`WebGPUGlobeSurfaceRenderer.ts:2650-2664`) — they
   build 3-letter cache keys against a format that gained a 4th letter in `831e2f189b`
   (2026-04-04) and have returned `null` for ~15 months with zero callers. A Principle-7
   audit came back **negative on all four sources** (docstring, DEFERRED_WORK, debugging
   log + principal-engineer reviews, originating batch `febe065f36`) — stale accessors, not
   scaffolding. Delete outright, or replace with a parameterised
   `listPipelineVariants() -> [{key, pipeline}]`? Removal is held because it is public
   surface on a fork of a public library.
2. **Add `wrongModuleHits` to `cacheStats()`?** A cache hit whose stored
   `descriptor.vertex.module` differs from the incoming one. The single number that would
   have caught the aliasing through 15 months of green dashboards.
3. **The repo-wide lint gap.** `.prettierignore` never unignores `.mjs`, so **all 727
   tracked `.mjs` files** plus everything under `Tools/**` sit outside CI enforcement.
   Closing it is a repo-wide reformat; leaving it means the probe fleet stays unchecked.
4. **Branch cleanup** — see §7.

---

## 7. BRANCH INVENTORY (2026-07-25)

```
main                                  <- Batch 767, pushed, in sync with origin
worktree-agent-a06f93c6892cba472      <- tides. REDUNDANT: its work is in 767. Safe to delete.
worktree-agent-a480e24d73c9b7c96      <- eclipse S6        (LIVE)
worktree-agent-a6de88899b2982d6c      <- eclipse S5        (LIVE)
worktree-agent-a68f438fcb2e102c1      <- pipeline-cache fix (LIVE)
worktree-agent-aa59196f79bb47e99      <- env-clear fix     (LIVE)
worktree-agent-a578d39752cd7819c      <- pipeline-readiness probe (LIVE)
```

Delete the tides branch on the maintainer's word; the other five carry unlanded work.

---

## 8. WHAT TODAY ACTUALLY TAUGHT (read before writing a probe)

Seven distinct instrument defects in one day, and **every failing cycle was the measuring
apparatus, not the thing measured.** The features worked; the instruments lied. Full
15-rule doctrine is in the orchestrator's memory anchor. The four that cost the most:

- **A read separated from its render by a `rAF` yield is invalid on BOTH backends** —
  WebGL clears the drawing buffer after the compositor swap without `preserveDrawingBuffer`;
  WebGPU invalidates the swap-chain texture after presentation. Fix by **fusion** so the
  unsafe path is unreachable, not by discipline. Yield on the **loading** side only.
- **A discriminator must not be built from the primitive it discriminates.** A
  `canvasHasContent()` built on the suspect read path reported "the renderer drew nothing"
  while another path returned a correct 1.4 MB image of the same canvas.
- **A helper that reads a per-frame uniform must render INSIDE itself** — three separate
  instances today of an order-dependent reporter returning the *previous* lane's state.
- **When a gate fails, check the comparand before blaming the engine** — four instances:
  a star census whose bar was arithmetically unreachable (a cubemap star would need
  406/255 source luminance), an umbra width comparing two different isolines across the
  display chain, a multiplier measured in a band dominated by a shell it never touches, and
  a far-field ray whose span was narrower than the penumbra.

And one process rule, learned by paying for it twice: **a defect discovered as a CLASS gets
a shared, enforceable home in the SAME round it is diagnosed.** Doctrine in a brief does not
work. Proof that it does: the shared capture checker later rejected a violation by its own
author, who had a good excuse.
