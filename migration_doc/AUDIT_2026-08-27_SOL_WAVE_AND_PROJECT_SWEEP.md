# Audit — the 2026-08-26/27 Sol wave, plus a project-wide sweep

**Date:** 2026-08-27
**Base tip:** `aa9409432d` (Batch 1169)
**Subject A:** ~24 hours of uncommitted work in main's worktree — 35 dirty paths, ~13,000 insertions across 16 tracked files, 30 untracked prototype files, 14 new preregistration documents
**Subject B:** the committed project at `aa9409432d`
**Status:** IN PROGRESS — four of five Sol lanes reported; one lane and three review fleets still running. Sections marked PENDING will be appended.

## 0. How to read this

Every finding carries a **verification tier**, because the tiers catch different classes and
conflating them is how a false finding becomes a cited fact:

| Tier | Meaning |
|---|---|
| **V-ORCH** | Re-derived by the orchestrator with commands recorded here. Highest confidence. |
| **V-LANE** | The Opus lane lead verified it independently of its Sol worker, usually by reading the cited lines or re-running the gate. |
| **R-SOL** | Reported by the Sol worker and NOT independently re-derived. Treat as a lead. |

No finding below is promoted a tier on plausibility alone. Where a lane and its worker disagreed,
that is recorded rather than smoothed over — the disagreements were among the most useful output.

**Provenance limits of this document.** No browser, GPU, or build ran in any lane. Nothing here
rests on observed pixels. All five audit clones were provisioned WITHOUT a build, which is itself
the subject of finding `O-3`.

---

## 1. Disposition

| Body | Verdict | Gate |
|---|---|---|
| C11-13 voxel probe trio | **LAND-WITH-FIXES** | clear to land |
| `model-lazy-pick-demand.spec.mjs` | HELD | blocked by `O-2` |
| Model feature-id / instancing / BatchTexture | **DO-NOT-LAND** | `M-1`, `M-3` |
| C16 grandfather ledger retirement | HELD | blocked by `O-1` |
| `Tools/patch-prototype/` + 14 P0 docs | **DO-NOT-LAND** | `P-1`, `P-2`, `P-3` |
| `WEBGPU_DEBUGGING_LOG.md` | **DO-NOT-LAND** | `D-1` |
| `QUEUE_2026-08-09_CAMPAIGN18.md` | LAND-WITH-FIXES | `D-6` |
| `QUEUE_2026-07-18_CAMPAIGN11.md` | LAND-WITH-FIXES | `D-3` |
| Governance + change audit documents | LAND-WITH-FIXES | `D-4`, `D-5` |
| `verify-landing-compliance.mjs` | PENDING | lane still running |

Only the voxel probe trio is unconditionally clear tonight. Everything else is either held behind a
defect or behind a coupling.

---

## 2. Couplings — measured, not inferred

`WebGPUModelFeatureId.js` is the linchpin of three otherwise unrelated bodies. Both couplings were
measured by substituting the HEAD version of the file and observing the failure.

**`O-1` — the C16 grandfather ledger cannot land without the engine rewrite.** V-ORCH.
The ledger change retires exactly one row, `WebGPUModelFeatureId.js all-caps-fix-label`, which is
legitimate only because the rewrite removed those markers. Substituting HEAD's file with the shrunk
ledger in place yields **4 REGRESSED findings and `--verify-cleanlist` exit 1**. The file is
clean-listed, so findings on it are errors rather than warnings. Same shape as the grammar coupling
that forced Batch 1168 to be atomic.

**`O-2` — `model-lazy-pick-demand.spec.mjs` cannot land without the engine rewrite.** V-ORCH.
With the rewritten engine file the spec is **16 pass / 0 fail**; with HEAD's file it is
**9 pass / 7 fail**. The spec exercises the real bundled module, so this is a genuine behavioural
dependency, not a text coincidence.

**Consequence.** The model lane's DO-NOT-LAND propagates to the C16 ledger change, the model spec,
and the `C11-202` preregistration rows that describe the same work. These four items land together
or not at all.

---

## 3. Orchestrator findings

**`O-3` — unbuilt audit clones produced false findings in three independent lanes.** V-ORCH.
**This is an orchestrator defect, not a worker defect.** All five clones were provisioned from a
clean checkout with `node_modules` junctioned but no build. `packages/engine/index.js` is a
gitignored build product imported by 611 spec files. Lanes were then briefed with gate results
measured in main, which *is* built. Three false findings resulted:

| Lane | False finding | Reality |
|---|---|---|
| probe | `verify-tracked-references` exit 0 (my brief) | exit 0 in main, **exit 1 in clone** |
| model | "the pre-existing `.mjs` precedent is already broken, nobody noticed" | **13 pass / 0 fail in main**, 0 pass / 1 fail in clone |
| docs | nine rows marked CONTRADICTED on engine `tsc` exit 2 | 140 diagnostics, **all TS2307** for missing generated shaders, zero of any other kind |

Every lane diagnosed the environmental cause correctly rather than routing around it. The premise
was mine. Any future audit clone must either be built or be briefed that build-dependent gates fail
for environmental reasons, with the specific gates named.

**`O-4` — no evidence artifact has been produced since 2026-08-25 17:47.** V-ORCH.
The store holds 8,348 files; nothing post-dates that timestamp. This is the backdrop for `D-6`.

**`O-5` — the P0 document set is 14 files, not the 12 first reported.** V-ORCH. Orchestrator
miscount, corrected by the proto lane.

**`O-6` — `verify-landing-compliance.mjs` fails its own immutable semantic controls.** V-ORCH,
carried forward from 2026-08-25. Exactly one of its 13 pinned marker patterns is stale:
`campaign-row-id` is pinned as `\bC\d{1,2}-\d+[A-Za-z]?\b` while the shipping grammar has been the
widened `\bC(?:\d{1,2}-\d+[A-Za-z]?|\d{1,2}-[A-Z][A-Z0-9-]*[a-z]?)\b` since before HEAD — row ids
like `C15-G6` and `C16-R2` require it. The tool also reports `end=DRIFT`, which reads as file
drift; the four policy-closure files are byte-identical before and after a run and git-clean, so
that string is a hardcoded literal in a different failure branch and misattributes the cause.

---

## 4. Model / instancing / BatchTexture — DO-NOT-LAND

**`M-1` — the feature-id compatibility guard cannot see which source was selected.** V-ORCH.
`WebGPUModelFeatureId.js:2211` gates on `(provenance.compatibilityToken & 1) === 1`, and only when
the selection requires a primitive feature attribute. The renderer supplies that token as
`geometry.hasFeatureId0 ? 1 : 0` (`WebGPUModelRenderer.ts:6888`), while
`ModelPrimitiveGeometry.js:683` extracts only `_FEATURE_ID_0`. The token therefore encodes *whether
set 0 exists*, never *which set was chosen*. A model selecting a non-zero attribute set is admitted
and renders and picks against set 0 silently, instead of failing closed to `null`. The set-0-only
limitation predates this change; the guard that appears to validate it does not. **Verdict driver.**

**`M-2` — instancing transform cardinalities are recorded but never validated.** V-LANE.
`WebGPUModelInstancing.js:1195` records array lengths; `:741` reads `12 * instanceCount` and `:785`
reads `3/4/3 * count` without checking them. A stable short array satisfies the double-observation
guard and uploads NaNs.

**`M-3` — 3,803 lines of spec evidence are executed by no runner.** V-ORCH.
`gulpfile.js:78` and `scripts/build.js:625` glob `packages/engine/Specs/**/*Spec.js`; `.mjs` cannot
match. Karma loads only `Build/Specs/SpecList.js`. The single npm script touching `.mjs` specs is
`test-webgpu-policy`, which points at a different path, and **zero** CI workflows reference them.
The only way to run them is to type `node --test <path>`. This is independent of build state.

**`M-4` — the layout dirty-marking has no behavioural coverage, and the consequence is on WebGL.**
V-LANE. Making `configureTextureLayout`'s dirty marking inert survives every spec — revisions read
`[1,1,2]`, identical to pristine, because the specs assert only the revision counter while the
mutation drops the `_batchValuesDirty` side effect. The lane then demonstrated the consequence:
after a device-limit change the batch texture rebuilds under pristine code and **not** under
inertness, so features fall back to the default texture and lose per-feature colour and show — on
**WebGL** — with every spec green.

**`M-5` — the `clearCapturedBatchDirty` guard is untested.** V-LANE. Replacing its
revision/identity predicate with `true` survives every spec (`WebGPUModelFeatureId.js:1876`). This
is the safety-critical half: it is where `Renderer/WebGPU/` writes `_batchValuesDirty = false` into
shared Scene state.

**`M-6` — four instancing mutation assertions can pass vacuously.** V-LANE.
`replaceOnce`'s `assert.notEqual` sits *inside* the `assert.throws` callback
(`WebGPUModelInstancingSpec.mjs:1651`), so a stale search pattern reads as success. The BatchTexture
equivalents place it correctly outside. Compounded by `assert.throws` carrying no error filter.

**`M-7` — Principle 2 two-way backend coupling.** V-LANE. `_webgpuFeatureResourceRevision` is a
backend-named field in shared `Scene/BatchTexture.js`, and `Renderer/WebGPU/` writes back into Scene
dirty state.

**`M-8` — the two new spec files are pure LF in a CRLF tree.** V-ORCH.

**What is genuinely good here, and should survive the rework:** `BatchTexture.js` does **not** alter
WebGL behaviour. Differential testing over 4,681 exhaustive sequences / 18,056 states plus 128 random
seeds reports 0 divergences on every non-throwing path, with a negative control that does produce a
divergence, so the zero is not vacuous. The one reachable delta is retry-after-upload-throw: the old
code attempted one upload and silently never retried. That is a strict improvement.

---

## 5. 3D Tiles patch prototype — DO-NOT-LAND

**`P-1` — the byte-frozen provenance model destroys itself on checkout.** V-ORCH.
All 30 prototype files are pure LF (0 CRLF pairs, 24,393 lone LF). The repo has `* text=auto` with
`core.autocrlf=true` local and global, and `.gitattributes` carries **no** pin for this path. The
specs assert `sha256(source) === SOURCE_HASHES[name]` with the failure message `"tuple drift"` —
the hashes *are* the provenance mechanism. Demonstrated on `p0b/protocol-v0.mjs`:

```
on disk now       b27e630005656c14   7835 B   <- what the spec pins
stored blob (LF)  b27e630005656c14   7835 B
fresh checkout    082c8a06a7962fc4   8094 B   <- what a Windows clone gets
```

A fresh clone goes red before a single behaviour runs. Fix is a `Tools/patch-prototype/** text eol=lf`
pin *before* tracking.

**`P-2` — the tooling catalog and the frozen tuples are mutually incompatible as written.** V-LANE.
The census counts tracked `.mjs` under `Tools` and `scripts`. Tracking adds 29 files, so
`verify-tooling-catalog` goes red until regenerated, and each file needs an `@purpose`/`@status`
header — which changes bytes, which breaks the pinned hashes *and* the frozen tuples in all 14 docs.

**`P-3` — the suite is red today.** V-LANE. 358 tests, 355 pass, **3 fail**, plus one ESLint error
(`no-control-regex`, `p0b/test-support/parser-package-tree-v1.mjs:25`). All three failures share one
cause: `p0b-parser-provenance.spec.mjs` is 1,258 lines against its own 820-line cap, asserted from
two different specs. The record's "71/71 PASS exit 0" is **70/71 exit 1** today. This is the
in-flight R8 adjudicator-cap correction.

**`P-4` — the topology scanner is still blind to the defect class the record blames.** V-LANE.
`p0b/test-support/module-graph-v0.mjs:263` builds `localEdges` exclusively from
`module.staticReferences`, so dynamic imports are recorded as metadata and never become edges or
enter cycle traversal. The successor's P0B-17/19/20 PASS rests partly on that scanner's evidence.
Separately: **no import cycle exists now** — an independent Tarjan pass over static, dynamic and
`new URL` forms found 9 production modules, 13 edges, a DAG. The historical cycle is unverifiable
from on-disk state.

**`P-5` — "59/59 controls" is an arithmetic tautology.** V-LANE.
`p0b-topology-mutants.spec.mjs:1652` asserts `equal(27 + registry.length, 59)` with
`registry.length === 32` asserted separately. The 27 is a magic literal never derived from an
execution count.

**`P-6` — a prototype spec pins the root `package.json` hash** (`:1611`), so any dependency bump
turns it red. V-LANE.

**`P-7` — the cap failure is two failures, and the second survives the in-flight repair.** V-LANE.
Beyond the 820-line cap, a second aggregate ceiling also fails: fixture 299 + harness 219 + own
1,258 = **1,776 against a 1,340 ceiling**, over by 436. That gate is labelled a
`"non-binding combined reporting ceiling"` at `p0b-topology-mutants.spec.mjs:1555` while
`p0b-parser-provenance.spec.mjs:451` asserts it as binding. R8 closing the first cap does **not**
turn the suite green.

**`P-8` — one whole evidence family is unmutatable, so it cannot be scored by anyone.** V-LANE.
`assertSourceGates` runs *before* the behavioural work (`p0b-parser-provenance.spec.mjs:1143`,
`:1193`) and its exact source pins reject any edit, so an absence or inertness mutation trips the
hash pin before the intended path ever executes. This is why the "16/16 killed" result covers only
8 of 9 families.

**`P-9` — the parser package fixture is a same-literal loop.** V-LANE.
`parser-provenance-fixtures-v1.mjs:10 → :43 → :75` is compared back at
`p0b-parser-provenance.spec.mjs:330`; nothing independently derives the installed-package
expectation.

**What is good here:** P0a reproduces **exactly** — 151/151, exit 0, in both the pre and forward
groupings, matching the preregistration. Mutation testing killed 16/16 across the 8 scorable
families with **no inertness survivors**, so the protocol core is genuinely live-tested. The record
is directionally honest: the self-declared STRUCTURAL/NO-GO is corroborated, with no
declared-NO-GO-but-actually-green inversion.

**A quantitative correction the lane made against itself.** Its first report put self-referential
gates at 55%. Sol rejected its own figure as internally impossible — it mixed sub-predicate
granularities and omitted 33 families — and recounted: **55 SELF / 108 EXTERNAL of 163 declared
families, 33.7% SELF**. The lane verified the denominator exactly (111 top-level `test(`
declarations plus 19/31/2 registration families). The behavioural protocol suite is therefore
majority externally anchored; the self-reference is concentrated entirely in the topology and
provenance gates, three of which are 100% SELF. The qualitative conclusion stood; the number did
not.

**Disclosed by the lane, unprompted:** it ran `npm run verify-tooling-catalog`, which Sol had
refused because the script calls `git update-index` twice. The lane then proved it harmless —
`.git/index` mtime unchanged at clone-creation time, HEAD unchanged, reflog showing only the clone
and checkout, because the script uses a private `GIT_INDEX_FILE`. Flagged rather than passed over
silently.

---

## 6. Documentation claims

**`D-1` — the debugging log resurrects a vacated closure. BLOCKS LANDING.** V-ORCH.
New prose at `WEBGPU_DEBUGGING_LOG.md:18854` asserts `C13-41 / C12-29 S3: COMPLETE / EDGE VERIFIED`
and `:18863` "This discharges the C13-41 machine criterion". Both are `+` lines in this diff. The
C13 queue and CLAUDE.md both record that exact 2026-08-12 reconciliation as **VACATED** by
`R-2026-08-14-1`, with `R-2026-08-17-7` setting the closure record to reopened — on the row CLAUDE.md
calls the most schedule-load-bearing in the campaign and C14's critical path. The underlying run is
genuine; the closure is superseded. Repair is to reframe the block as dated history, not to delete
the measurements.

**`D-2` — `:18861` says the raw ratio is "report-only"**, contradicted by
`Tools/visual-regression/lib/eclipse-cloud-response-gate.mjs`, which keeps the `[0.97, 1.03]` reading
operative. V-LANE.

**`D-3` — the C11 raw-byte freeze is stamped LF against a CRLF worktree** (`:1107`). Not a
falsification: LF-normalising the 73,303-byte worktree file yields exactly the claimed 71,195 bytes
and exactly the claimed digest. Re-stamp owed. V-LANE.

**`D-4` — the governance audit's census sums to 4,977, not the stated 4,976** (`:31`). V-LANE.

**`D-5` — `WebGPUPointCloudLODProcessorSpec.js` is mislabelled browser-free** (`:72`); it is
browser-bundled Jasmine. V-LANE.

**`D-6` — the point-cloud and voxel number family has no backing anywhere.** V-LANE, consistent with
`O-4`. `0.15%`, `0.19%`, `0.12%`, `0.986` IoU, `32,419` pixels, `165 KB`, `4.063 m`, `1.12x` and
their "passes on both backends / zero errors" assertions appear in **zero** of 112,989 files
scanned across 15 evidence roots. They carry no run id and no artifact path, and post-date the
newest file in the store. **Absence of an artifact is not proof the run never happened** — the
likeliest explanation is evidence that was never repatriated, a known recurring defect here. Repair
is honest dated attribution with evidence owed, never deletion of the measurement.

**What is verified good:** the debugging log's dated 2026-08-12 section is genuine in every
particular. All three run UUIDs resolve to real banked publications, and all three report byte sizes
and all three SHA-256 digests match **exactly**, as do the 30 gating predicates, the 36 preserved
PNGs, and the verbatim `webgl S5 page timeout` string. The change audit's git provenance likewise
reproduces to the digit: 58 commits, 1,092 files, +89,518 / −6,062.

---

## 7. Engine defects found incidentally

**`E-1` — the clustered-light cache key omits most of what it uploads.** V-ORCH.
`WebGPUClusterAssignRenderer.ts:293` accumulates only `posOrDir.x/y/z` and `type` into the checksum,
while the packed upload also carries colour, intensity, range, attenuation, cone and spot direction.
The source concedes it in a comment directly above: *"The cache key covers eye-space position or
direction and type. Other packed fields do not independently invalidate this assignment."* A
stationary light whose colour or intensity changes keeps stale GPU bytes. Unrelated to any document;
deserves its own campaign row.

---

## 8. Instrument-quality findings

**`I-1` — an exit tier enforced only by regex.** V-LANE, FIXED in the probe lane.
The C11-13 probe's new FAIL-vs-STRUCTURAL tier was pinned exclusively by source-text patterns
asserting the `"STRUCTURAL",` argument *at each call site*. Making `addCheck` ignore its
`failureStatus` argument — one token, every call site untouched, every regex still satisfied —
silently returned the whole probe to exit 1 **with all 16 tests green**. The worker's own mutation
deleted the argument at the call site, which the regex does catch: the easy-mutation trap exactly.
Fixed by exporting `addCheck` and driving it through the fold to an observed exit code in both
directions.

**`I-2` — zero-check vacuity.** V-LANE, FIXED. `foldProbeChecks([])` returned PASS / exit 0, so a
probe that ran no checks reported success. Both `[]` and `undefined` now yield STRUCTURAL / 3.

**`I-3` — harness-supplied assertion inventory.** R-SOL for the counts, V-LANE for the samples.
Across the audited instruments: 48 source-text assertion sites, 14 harness-echo assertions, 7 shared
mutable baselines, 14 absent-evidence pass surfaces including 9 `.every(...)` calls that pass on
empty evidence. In the probe lane, `readTextBoundToFingerprint` takes an injectable `operations` and
**every** test injects a fake reader, so the production `fs` path is never exercised.

**`I-4` — surviving inertness mutants.** V-LANE. Model lane: 11/14 killed, **3 survived**, and of the
kills 3 were text-only rather than behavioural. Proto lane: 16/16 killed, none survived.

---

## 9. Cross-cutting operational facts

**File modification times actively lie on this machine.** Two lanes independently observed it. One
rollout file grew 1.81 → 2.35 MB while `stat` reported `idle=2083s`; another had all four rollout
mtimes frozen at creation time ~60 minutes after work continued. Windows defers mtime updates on
open append handles. **Terminality must come from rollout event streams (`task_complete`), never
from mtimes.** This has now cost time in three separate sessions.

**Codex fan-out is larger and more variable than assumed.** Five dispatches produced roughly **26
rollout sessions**: 12 on proto (a 12× fan-out), 8 on model (two dispatches, 4× each), 4 on docs,
2 on probe. Sessions share one worktree. The model lane observed a genuine collision — two sessions
transiently saw non-pristine file hashes, and both honoured the stop protocol. Every lane hit the
1,800 s idle timeout on its first call; none re-dispatched.

**Cross-family review remains the tier that finds real defects.** The Opus leads overruled their Sol
workers repeatedly and correctly: the probe lane showed Sol's DO-NOT-LAND rested on three exit-mapping
defects that `git show HEAD:` proves are byte-for-byte pre-existing; the proto lane corrected two Sol
instrument errors (a shell-glob artifact reported as a prettier failure, and a markdownlint "FAIL"
produced by overriding `--ignore-path`); the docs lane overruled Sol four times, including a false
negative where `git cat-file` resolves a commit Sol marked unbacked.

---

## 10. Fleet 1 — twelve cross-cutting dimensions over the committed project

25 agents, 12 dimensions, each finding put through an adversarial refutation pass instructed to
default to REFUTED under uncertainty. **55 raw findings, 40 survived, 15 refuted** — 2 high,
10 medium, 28 low.

**The refutations are as informative as the findings.** Parity discipline, the ShaderDefine
registry, the RTE convention across the shader corpus, and the build-variant plugin all held: every
candidate defect in those areas required a source change or a caller that does not exist. The fleet
found **nothing that threatens WebGL**. What survived is a different and less comfortable pattern —
*the fork's own governance instruments have drifted out of sync with the code they govern*. That is
Principle 10 turned inward on the project's own paperwork.

**`F1-1` — the pre-commit type gate checks zero engine files while claiming otherwise.** V-ORCH.
`tsconfig.json` has `"include": ["scripts/*.js"]`. `.husky/pre-commit` runs `npx tsc --noEmit` under
a comment reading *"Run tsc ONCE after formatting is applied — catches type errors before they
land"*, and a second comment records that this *"replaces the per-file tsc that was in
engine/lint-staged.config.js"* — so the move narrowed coverage from the engine project to the root
project. Measured directly: `npx tsc --noEmit --listFiles | grep -c 'packages/engine/Source'`
returns **0**.

> **This retroactively weakens a gate cited throughout this project's landing records, including
> mine.** A bare `npx tsc --noEmit` exit 0 says nothing about engine TypeScript. Landings that ran
> *both* the root and `-p packages/engine/tsconfig.json` checks are unaffected — the engine project
> check is the real one — but any record citing only the root check should be read as unverified for
> the engine. CI still catches it (`dev.yml` → `gulp tsc` after a build materialises the generated
> shader siblings), so nothing shipped broken. Fix: point the hook at `npm run tsc`.

**`F1-2` — the performance manager is absent from every teardown and device-loss path.** V-ORCH,
and the fleet's most serious finding. `WebGPUPerformanceManager.ts:1622` is exactly:

```ts
destroy(): void {
  this._staticTileBundleKeys.clear();
  this._computePipelines.clear();
}
```

It never releases `_atmosphereLutResources` or `_gbufferComputeResources`, which own seven
`rgba16float` textures and two params buffers. The manager is not destroyed by
`WebGPUContext.destroy()` and is not registered in `_registerResourceCaches`. After a *successful*
device-loss recovery the same context host is reused, so the manager and its dead-device textures
survive; `ensureAtmosphereLUTResources` early-returns them on a presence-only check with no device
identity, and they are bound into a new-device bind group. Result: per-frame `GPUValidationError`
and permanently broken atmosphere **after recovery that otherwise worked** — defeating the purpose
of the recovery subsystem.

**`F1-3` — six elevation materials report height against a mean sphere.** V-ORCH.
`PrimitiveMatElev{Ramp,Band,Contour}{Flat,Lit}.wgsl` each declare
`const EARTH_RADIUS: f32 = 6371000.0` and publish `length(worldPos) - EARTH_RADIUS` as "height above
ellipsoid" in their own words. Bias **+7,137 m at the equator, −14,248 m at the poles**, with
nothing compensating on the JS side. Ramp colour therefore drifts with latitude across a
constant-altitude surface. The same lines also recompute `worldPos = positionHigh + positionLow`,
discarding the correct `posRTE` — the fleet correctly merged these as one defect, since ±0.25 m of
quantization is unobservable inside a 7 km bias and one fix addresses both.
**No WebGL behaviour is at risk** — this is a fork-added capability. But the comment justifying the
approximation claims WebGL's `Material.js` populates `materialInput.height` the same way, and that
premise is false: `materialInput.glsl:13` documents height as globe-only. The trade-off was accepted
on a wrong premise.

**Other survivors**, in descending severity: `Scene.js:3741` branches on `isWebGPU` to overwrite the
shared `frameState.light`, a direct Principle 2 violation; three unwrapped interpolated
`console.log` calls in `Scene/` that cost work in production; `WebGPUSceneRenderer.ts:651`, where the
run-of-one branch of `executeBatchIndirect` swallows a command throw with zero output at any log
level while the sibling branch 60 lines above reports the identical throw through a permanent
`context.log("warn", …)`; `WebGPUPostProcessPipeline.ts:1856`, where every canvas resize destroys all
effects and recompiles their shaders; `IMAGERY_PROJECTION.md:207`, whose summary table inverts the
shipped WGSL truth across nine citations — notable because CLAUDE.md calls drift in that document
"a worse bug than the projection bug itself"; and `WebGPUSceneRenderer.ts` carrying three
self-contained clusters with no orchestration role inline.

**Blind spots.** Read-only, build-free, browser-free, and excluding the uncommitted wave. A clean
dimension means "no defect found by static reading in the time available", not "correct".

---

## 11. Lane POLICY — LAND-WITH-FIXES

Both briefed defects are fixed in the durable form and mutation-proven in both directions.

**`O-6` is closed, and the fix is behavioural rather than another pin.** V-ORCH.
All 14 required controls now carry `positives` (inputs the rule must match, with expected match
text) and `negatives` (inputs it must not match). Measured: **0 source pins, 14 positives,
14 negatives**. The only structural facts still asserted are the ones that cannot go stale — that
the pattern is a RegExp and that it is global. The tool went **exit 3 → exit 0**, printing
`load=stable; end=stable`, and its spec is **88 pass / 0 fail / 0 skipped**.

**The premise was more dangerous than first diagnosed.** V-ORCH.
`C4-PLAIN-HDR` is a *real* marker the gate finds at `Tonemapping.wgsl:89`. It matches the live
grammar and does **not** match the stale pin. So resolving the mismatch in the other direction —
narrowing the grammar to satisfy the pin — would have turned a genuine violation into a silent pass
on the one gate whose entire purpose is to refuse silence. Worth recording separately:
`REQUIRED_MARKER_RULE_CONTROLS` does not exist at HEAD, so the pin was **authored stale from the
start** rather than drifting out of date.

**`O-7` — a latent crash on the diagnosis path, found by driving it.** V-LANE.
The shape-failure early return omitted the `brokenMarkerRules` list the message branch reads, so a
non-array grammar would have died with a `TypeError` instead of producing a diagnosis. Now returns
empty arrays; mutation M8 drove the path and got a clean exit 3 with zero `TypeError`s.

**`O-8` — three grammar rules still have no immutable control. FILED.**
`parity-report-row-id`, `all-caps-fix-label` and `fork-id` exist in the grammar but not in the
control set, and `required-marker-rule-order` *projects* onto required ids, so deleting an
uncontrolled rule fires nothing. This is a live false-green path, and not a theoretical one:
`all-caps-fix-label` and `fork-id` produced **22 of the 23** real findings in the history run.

**`O-9` — detached HEAD yields exit 2. FILED, pre-existing at HEAD.** Affects worker clones;
`--last N` and `--range` work. False RED, so the safe direction.

---

## 12. Fleet 2 — governance, history, supply chain

17 agents, 8 dimensions. **30 raw findings, 25 survived, 5 refuted** — 2 critical, 1 high,
7 medium, 15 low.

**Where the governance layer is sound:** the status authorities — the campaign queues and
`DEFERRED_WORK.md` — are internally consistent, carry their own precedence disclaimers, and win
every conflict found. Landing discipline is machine-enforced and clean: `Tools/landing-rules.mjs`
evaluated **125 commits since the guard landed with 0 violations**. Licensing has no live defect.

**`G-1` — CRITICAL: single-copy unlanded work in two clones. HARVESTED 2026-08-27.** V-ORCH.
Two clones held work present in no commit, no branch, no archive, and not in main's worktree:

| Clone | Work | Proof it existed nowhere else |
|---|---|---|
| `cesium-worker-sundisc` | `SolarDiscModel.js` holding `solarDiscTransmittanceSplit` — **the actual C12-38 dawn fix the maintainer reported** | `git grep -l solarDiscTransmittanceSplit aa9409432d` exits 1 |
| `cesium-worker-c11170` | `perf-metric-vector.mjs`, 1,262 lines — the artifact discharging the 2026-08-25 multi-metric ruling | `git cat-file -e aa9409432d:…/perf-metric-vector.mjs` fails |

**Batch 1164 landed only half the sun-disc fix.** Its six paths were the probe, the gate, the gate
spec, `Sun.js`, `WebGPUEnvironmentRenderer.js` and the C12 queue row — `SolarDiscModel.js`,
`FrameState.js`, `SunFS.glsl` and four celestial specs were left behind in the clone. Now banked at
`cesium-webgpu-worker-archive/2026-08-27-critical-single-copy/` with patches, untracked tarballs and
base tips; the sun-disc patch contains the symbol 16 times. **Neither clone may be retired until
this work is landed or deliberately abandoned.** Root cause: the "Evidence Repatriation — CRITICAL"
rule has no tool. Repair is a `verify-clone-drained.mjs` that refuses to call a clone retirable
while any tracked file differs from tip or any untracked non-ignored file is absent from it.

**`G-2` — HIGH: eslint does not lint engine or widgets TypeScript at all.** V-LANE.
`typescript-eslint/recommended` is spread solely under `files: ['packages/sandcastle/**/*.{ts,tsx}']`.
Shown empirically: `npx eslint --no-cache …/WebGPUShaderCache.ts` returns *"File ignored because no
matching configuration was supplied"* while a sandcastle `.ts` in the same invocation lints
normally — and `npm run eslint` passes `--quiet`, which suppresses that warning entirely, so CI
exits 0 having printed nothing. **~270 files unexamined**, and eleven
`// eslint-disable-next-line @typescript-eslint/no-explicit-any` directives annotate a linter that
never opens the file. This explains the "no matching configuration" warnings seen throughout
tonight's lane work. Land the fix behind a `--max-warnings` ratchet; expect a backlog.

**`G-3` — twelve fork guards exist; none runs in CI, and one cannot be armed.** V-LANE.
`lint-comment-markers`, `lint-debug-pragmas`, `verify-tooling-catalog`, `verify-landing`,
`test-c16`, `verify-tracked-references`, `audit-feature-renderers` and five more appear in no
workflow and no hook. (The fleet corrected its own finder here: CI is not guard-free —
`dev.yml:123` runs the variant smoke test, and the visual-regression workflow is deliberately
`workflow_dispatch:`-only. The gap is selective.) Separately `lint-debug-pragmas.mjs` exits 1 today
on four *deliberately permanent* latched `console.warn` sites, because it exempts only by method and
cannot express CLAUDE.md's "never wrap a log the user needs to see" carve-out — so it can never be
turned on as written.

**`G-4` — derived orientation docs contradict the status authorities.** V-LANE, and the same root
cause as `D-1`: hand-maintained mirrors with no reconciliation check.
`CAMPAIGN_PORTFOLIO_QUEUE.md:133` still reads "C13-41 / C12-29 S3 — COMPLETE … S3 no longer blocks
C12" while both queues record it REOPENED and VACATED; grepping that board for
`R-2026-08-14-1|REOPENED|VACATED` returns **zero** hits. In the opposite direction,
`CAMPAIGN_STATE.md:34` asserts `C11-181` is "NOT COMPLETE … the queue row is the authority and keeps
it open" while the named row reads COMPLETE, administratively closed 2026-08-09. Contained today
only because the board is visibly self-contradictory.

---

## 13. Fleet 3 — per-file deep logic review

25 agents over the 12 largest renderer and Scene files. **37 raw findings, 32 survived, 5 refuted**
— 8 high, 13 medium, 11 low. **60,279 lines in scope; roughly 21,500 actually read**, so a clean
region here means unexamined, not correct.

**What was specifically attacked and held:** pass ordering, the scene-framebuffer resume/MRT
re-attachment protocol, the demand-driven colour-resolve handshake, the 2D `beginFrame`/`endFrame`
pairing, the voxel and splat RTE derivations, and the voxel two-range index buffer. Nothing suggests
the frame graph or the precision model is wrong.

**One defect class dominates — hit 20+ times across 9 of the 12 files: hand-rolled cache
invalidation that omits an axis which changes the result.** CLAUDE.md records the project being
bitten by exactly this in the *central* pipeline cache and fixing it structurally by folding module
identity into the key. Every finding here lives in a **renderer-local** cache that never reaches
that fold, so the structural protection does not cover them. That is the shape of the remaining risk,
and it argues for extending the fold rather than patching each site.

| | Finding |
|---|---|
| **H1** | `WebGPUDynamicEnvironmentMapManager.ts:1197` — the IBL refresh gate's only positional term sits behind two flags that both default false, so JS short-circuits before `manager._position` is read. A moving `Model` or tileset keeps an environment cube baked for its original location — wrong ENU up-vector, wrong ellipsoid height — indefinitely. **Default path, no opt-in, silent wrong image, and a one-sided parity break: WebGL regenerates correctly on this exact input.** Fleet 3's most important finding. |
| **H2** | `WebGPUGlobeSurfaceRenderer.ts:1203` — `_materialPipelineCache` appears at three lines in the file and at none of the three clear sites, and its sub-key carries no format or sample-count axis. Set `globe.material`, then `scene.highDynamicRange = true`, and an rgba8unorm/1-sample pipeline is served into an rgba16float pass forever. |
| **H3** | `WebGPUGaussianSplatRenderer.ts:1403`, `:3113` — async pipeline promises capture `resources` and never compare it to the live value. On cold start, legacy 64-byte promises land after the packed 32-byte commit and overwrite it; the readiness check then declares success, so packed records are decoded at 64-byte stride with no validation error and no further request. |
| **H4** | `WebGPUProceduralCloudRenderer.ts:1482`, `:1591` — temporal bind groups bind `cache.halfView` but are invalidated only on size change or attachment generation, so an A→B→A canvas cycle leaves both unchanged against a destroyed texture. The attachment producer group next door already compares view identity, so the correct pattern exists 250 lines away. |
| **H5** | `WebGPUModelRenderer.ts:3964`, `:3361`, `:3388` — customShader identity is in none of the staleness tuple's terms, so assigning `model.customShader` after the first frame never compiles; removing or swapping one destroys a UBO that is still submitted. |

---

## 14. PENDING

Nothing. All five Sol lanes and all three review fleets have reported.

---

## 12. Housekeeping owed

- `F:/Dev/GH/cesium-audit-probe/.sol-audit-report.md` — worker artifact, must not land.
- `F:/Dev/GH/cesium-audit-proto/_audit-out/` — roughly 12 mutant tree copies; currently makes
  `npm run markdownlint` fail in that clone. Retain as evidence or remove before retiring the clone.
- The uncommitted wave is banked at
  `F:/Dev/GH/cesium-webgpu-worker-archive/2026-08-27-sol-uncommitted/` as `tracked.patch` plus
  `untracked.tar.gz` with a porcelain listing and base tip, because it exists nowhere in git.

---

## 15. Addendum — late-evening corrections and rulings (2026-08-27, post-Batch-1174)

**Correction to §12/`G-1`'s sun-disc framing.** "Batch 1164 landed only half the fix" implied an
accident. The lane that took the work proved otherwise: 1164's engine change was **comment-only**
(0 non-comment changed lines), the rendering fix was **deliberately HELD by the C12-38 row** because
every candidate changes WebGL's shipped sunrise/sunset appearance, and the banked patch implements
option (B) — an unselected candidate. The 2026-08-25 maintainer ruling selecting **option (A)
co-fade** was then re-verified verbatim from the session transcript; it had never been recorded in
the row, and that recording gap — not a lost half-landing — is the defect. Option (A) is in
implementation; option (B) stays banked-unselected. The G-1 harvest itself remains correct: the
bytes were single-copy and needed banking regardless of disposition.

**Maintainer ruling, 2026-08-27 (prototype caps, via R8's RULING REQUEST).** Per-spec cap
820 → 1,400 **granted**; the 1,340 aggregate ceiling **stays binding** (the independent review
proved it load-bearing — 1,940 would equal the sum of maxima and constrain nothing). Satisfies
charter §1.1's measured-red rule through the instrument the charter names.

**New systemic findings from the repair lanes**, queued in the fix queue (Q-11…Q-15): the tracked
`AGENTS.md` carries none of the fork's CRITICAL technical rules, so worker clones receive them only
when a brief inlines them; `prettier --check` over `migration_doc/**` is vacuous (ignore-file gap)
and every such gate in doc batches has been a false green; mixed EOL silently suppressed five
node:test registrations in one spec; the primitive camera buffers share A5-5's never-resized defect
family in a second file; and an MCP idle-timeout abort does NOT terminate the codex session — one
"killed" round was still writing 45 minutes later, so freeze-then-review must verify quiescence
from event streams plus file stability, never from the tool returning.

**C1 verification round (post-Batch-1175).** The R-SOL tier is closed: two counts confirmed
exactly (the 942/1,118 spec-shape ratio; the 489-row bucket census), two corrected by one (48→47
source-text sites; 9→8 unguarded .every() surfaces), the seven shared-mutable-baselines REFUTED in
scope, and — important — **the proto lane's 55/108 self/external split is UNVERIFIABLE and must not
be cited**, including where §5 of this document quotes 33.7%: a fully published convention yields
4 SELF / 144 EXTERNAL / 15 AMBIGUOUS, and no construction reaches 55. The qualitative conclusion
(self-reference concentrated in the topology and provenance gates) survives; the number does not.
Also: nine of the docs lane's 25 CONTRADICTED rows record the O-3 unbuilt-clone artifact, not a
contradiction — a classification error, honestly documented inside the rows themselves. C1's two
new confirmed engine defects are queued as Q-16 and Q-17; its twelve single-source findings remain
held out of every row pending the adversarial review round now running.

**C1 closure (2026-08-28, post-Batch-1177).** Final mission tally across both parts: five
worker-reported claims confirmed exactly, two corrected by one count each, one refuted, one marked
unverifiable/do-not-cite, and the docs lane's CONTRADICTED bucket measured 36% unsound (nine of 25
rows are the O-3 unbuilt-clone artifact, reproduced independently). Over 14,024 previously-unread
renderer lines: ten findings CONFIRMED and personally spot-checked, zero refuted, four held
single-source pending one more review. Two entered the queue immediately (Q-19 device-recovery
generation resets, HIGH, same class as F1-2 — the third subsystem confirmed to survive device loss
holding dead-device objects; Q-20 translucent cull bracket). The six S1 findings were synthesised
into ONE structural row (Q-18) rather than six patches, on the precedent of the central pipeline
cache fix. Process result recorded plainly: three Sol review dispatches produced five usable
verdicts between them — buffered output died with aborts both times it was tried, incremental
writes saved the one partial success, and the untested remedy is the lean brief (under 200 words,
no governance preamble), now being validated by two live reviewers.
