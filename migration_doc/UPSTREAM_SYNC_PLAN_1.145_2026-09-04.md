# Upstream sync plan — CesiumJS 1.145 (2026-09-04)

**Status: LANDED** (stamped 2026-09-05, doc-fitness follow-up G-25). The 1.145 merge landed at
Batch 1408, merge commit `ffb8161c083b29df0d3a301496ad5f4bc80e6c27` — two parents: fork
`40341305f4068a64517c7be81d5164979dc1d115`, upstream `488b114e16f5879f5d51456640aae67850a715c0`.
Verified at HEAD: `git log -1 --format=%P ffb8161c08` → the two parent hashes above;
`git merge-base --is-ancestor 488b114e16 HEAD` → exit 0; `package.json`'s `"version"` → `1.145.0`.
This document was produced by lane U (tier-2 lead Nolondil, five tier-3 workers) from **one
dry-run merge**, executed in an isolated clone and aborted before the real landing; that dry-run
clone ended clean at `01226c648a` and is retained below as the conflict census and per-hunk
resolution plan the real landing followed — it was not itself the landing.

**What this document is.** The plan the 1.145 sync was landed from (Batch 1408,
`ffb8161c083b29df0d3a301496ad5f4bc80e6c27`): the real conflict census,
four cluster analyses with a resolution per hunk, the toolchain survey, the post-merge verification
plan, and the landing sequence. It is a **plan**, not a status authority — the queue rows it opens
(`UPSTREAM-SYNC-1.145-*` in
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md)) carry status.

## 0. The seven findings that change how this sync is landed

1. **The dominant conflict mechanism is ES6 class conversion, not semantics** — 13 of the 24
   conflicted `.js` files, **46% of all hunks**. CLAUDE.md's sync-procedure `--theirs` default is
   **actively wrong** for them, and its "then re-add WebGPU code" does not repair the damage. §3.
2. **The merge is dangerous where it is quiet.** Seven confirmed breaks live in files that produced
   **no conflict marker** — including three live calls to a method 1.145 deletes, emitted as
   *agreement* because both sides removed the surrounding block. §5.5.
3. **`UP-1` is a REWORK, not the ABSORB the lens called it.** ~1,627 LOC at stake; the ledger records
   the fork's SDF path as shipped, working and pixel-gated with **no removal row**. Dropping it would
   turn WebGPU clipping dark. **The LOC is not uniformly blocked:** step 1 — relocating bucket C,
   **~762 LOC**, out of the upstream-tracked `Scene/` files — **lands with the merge**, and is what
   makes 11 of cluster (b)'s hunks mechanical; only steps 2 and 3 wait on the already-open
   `NEW-WEBGPU-VECTOR-POLYGON-DRAPING`. §5.2.
4. **`UP-7` is five colliding shader-key bits, not three** — and the fork **renumbered an inherited
   upstream bit**. Either naive resolution is a *silent* wrong-shader bug, it is WebGL-only, and
   **no spec, probe or runner in the fork can detect it**. §5.1.
5. **All 32 conflicts land in one commit or none do.** Git refuses a commit with unresolved paths, so
   the brief's per-cluster resolution batches are not a shape git permits; per-cluster review moves
   into the working tree instead. §8.0.
6. **The `S3` re-run is not a gate on this sync.** The premise handed to the lane does not survive
   re-derivation: `C12-29` S3 is eclipse occlusion, not a classification depth target. `G1`'s
   prescribed remedy is stale for the same reason. §7.3.
7. **Four coverage gaps have no detector at all** — the `sideEffects` line, CI action-version
   consistency, `MVTDataProvider`'s new API surface, and the sync's own headline features, which
   `scenes.json` does not exercise. §7.2.

**Lane provenance.** Lane U, 2026-09-04. Lead **Nolondil** (Opus 5 — the dry run, cluster (d), this
document). Workers: **Tar-Ardamin** (Sonnet, census), **Tar-Vanimelde** (Opus, globe),
**Tar-Telperien** (Opus, clipping + vector), **Tar-Surion** (Opus, tiles + models), **Hallacar**
(Sonnet, toolchain + verification). Reviewer: **Anardil**. Each worker's full working is banked in
the lane clone's `_lane-out/`; this document carries the resolutions and the findings and cites the
bank for per-hunk detail.

---

## 1. Premises, re-verified

Every number below was re-derived in the clone on 2026-09-04. Where a premise handed to the lane
proved wrong, the correction is marked.

| Fact | Value | Verified how |
|---|---|---|
| fork `main` | `01226c648a` | `git rev-parse HEAD` |
| `upstream/main` | `73c2eeec0c` (2026-09-03) | `git rev-parse upstream/main` |
| merge-base | `6d5d8b1f07` (2026-08-03, "Update ThirdParty.json") | `git merge-base main upstream/main` |
| behind / ahead | **358 / 1783** | `git rev-list --count` both ways |
| release tags in the gap | exactly one: **1.145** | upstream tag list |
| upstream `packages/engine/Source` delta | 65 files | `git diff --stat` merge-base→upstream |
| both-sides-changed, whole repo | **59** | `comm -12` of the two changed-file lists |
| both-sides-changed, `packages/engine/Source/` | **39** | as above, filtered — **premise confirmed exactly** |

Version moves in 1.145: root `1.144.0 → 1.145.0`, `@cesium/engine 26.2 → 26.3`,
`@cesium/widgets 16.1.1 → 16.2.0`, `protobufjs 8.6.5 → 8.8.0`, `@ast-grep/cli 0.44 → 0.45.1`, and
**`@playwright/test 1.59.1 → 1.62.1`** — the last is a fleet-wide behaviour change, not a version
string, because the fork's entire probe fleet and the Edge executor run on Playwright (§6).

### 1.1 The governing procedure, and the amendment this sync forces

`CLAUDE.md` → "Upstream Sync Procedure" is the governing procedure: safety branch, fetch, check
divergence, `git merge upstream/main --no-edit`, resolve **preferring `--theirs` then re-adding
WebGPU code**, verify a two-parent merge commit, push `--force-with-lease`.

Two things must be said about it in this plan.

1. **The sync is the one sanctioned merge commit.** Landing rules are otherwise squash-only
   (`WORKER_ISOLATION_AND_BRANCH_HANDOFF.md`). The sync is the documented exception: the procedure
   explicitly requires a verified **two-parent merge commit**, because that is what makes the next
   sync's merge-base correct. Squashing this would make every future sync progressively worse.
2. **Step 5's `--theirs` default is actively wrong for 13 of the 24 conflicted `.js` files** — see
   §3. This is the single most important operational finding in the plan.

### 1.2 Fork invariants the resolution must not lose

CLAUDE.md Principles **1** (WebGL keeps working), **2** (backend agnosticism — Scene code must not
import `Renderer/WebGPU/` or branch on `isWebGPU`), **3** (multi-context; every `GraphicsContext`
has its own id and limits), **5** (WebGL/WebGPU feature parity), **9** (surface deferred
functionality as concrete next work); the **RTE** rules (`positionHigh`/`positionLow`,
`mvpRelativeToEye`, never `posHigh + posLow`); the **`ShaderDefine` registry is add-only** — never
reorder, renumber or remove; the **`WEBGPU_COMPAT_EXEMPTIONS`** list in
`scripts/bundleVariantPlugin.js`; and the **`"./Source/Cesium*.js"` side-effects declaration** in
the root `package.json`, without which bundlers tree-shake `setGlobalDefaultRenderer()` out of the
variant entry barrels.

---

## 2. The dry run — what actually happens

Executed once, in `F:/Dev/GH/cesium-lane-nolondil-20260904`:
`git merge --no-commit --no-ff upstream/main` → exit 1 → artifacts captured → `git merge --abort`.
Clone verified back at `01226c648a`, clean tree, no `.git/MERGE_HEAD`.

| Measure | Value |
|---|---|
| **conflicted files** | **32** |
| **conflict hunks** | **79** |
| paths the merge would change | **164** — 117 modified, 44 added, 3 deleted |
| line delta | **+17,311 / −1,452** |
| both-sides-changed files that auto-merged | **27** |
| auto-merged modified files, total | **85** |

### 2.1 The three deletions

1.145 deletes exactly three files, and all three are the clipping-polygon signed-distance path:

- `packages/engine/Source/Shaders/Builtin/Functions/clipPolygons.glsl`
- `packages/engine/Source/Shaders/Builtin/Functions/unpackClippingExtents.glsl`
- `packages/engine/Source/Shaders/PolygonSignedDistanceFS.glsl`

This is `UP-1` confirmed at the merge level, and it is the reason cluster (b) is the sync's largest
cost centre (§5.2).

### 2.2 Corrections to the lane's candidate list

Eleven files the brief listed as conflict candidates **auto-merged cleanly**:
`Core/IonResource.js`, `Core/VectorProvider.js`, `Renderer/AutomaticUniforms.js`,
`Scene/GlobeSurfaceTile.js`, `Scene/GltfLoader.js`, `Scene/Model/Model3DTileContent.js`,
`Scene/Model/EdgeVisibilityPipelineStage.js`, `Scene/Model/PickingPipelineStage.js`,
`Scene/BufferPointCollection.js`, `Shaders/GlobeFS.glsl`, `Shaders/GlobeVS.glsl`.

**Auto-merged is not the same as safe.** A clean textual merge says only that the two sides touched
different lines. §5 treats the auto-merged both-sides set as its own risk class, and §5.4 documents
a case where the *most dangerous item in the whole sync* is a file that never appears in the
conflict list at all.

### 2.3 Where the evidence lives

The dry run's artifacts are banked under `_lane-out/dryrun/` in the lane clone: the conflict list,
per-file hunk counts, the conflicted files **with markers**, the three merge stages
(`base`/`ours`/`theirs`) for each, per-file `UPSTREAM.diff` and `FORK.diff`, the full name-status
and stat, and the both-sides/auto-merged lists. They allow every claim here to be re-checked
without re-running the merge. Per the evidence-repatriation rule these must be copied into the main
repo's gitignored `Tools/visual-regression/output/` before the lane clone is reset.
---

## 3. The dominant conflict mechanism is ES6 class conversion, not semantics

**This section governs how §5's resolutions are read, and it amends CLAUDE.md's sync procedure.**

**13 of the 24 conflicted `.js` files conflict because the fork converted them from prototype-based
to ES6 `class`, while 1.145 is still prototype-based.** These are *structural* conflicts: git aligns
a fork class method against an unrelated `X.prototype.y = function` block and emits one large
conflict region spanning the shape boundary. The two sides of such a region are frequently **not
about the same feature at all**.

Verified instances, opened in this run:

- `Scene/ClippingPolygon.js` — fork `class ClippingPolygon {` at `ours:37`; upstream
  `function ClippingPolygon(options) {` at `theirs:65` plus
  `Object.defineProperties(ClippingPolygon.prototype, {` at `theirs:217`.
- `Scene/Scene.js` — fork `class Scene {` at `ours:207`; upstream still 40 × `Scene.prototype.*`.
- `Renderer/ShaderBuilder.js` — the single conflict pairs the fork's `addVarying()` **class method**
  against upstream's `ShaderBuilder.prototype.addFragmentLines = function`. Two unrelated methods;
  upstream's actual delta for the file is **one JSDoc line**.

The full set, with conflict-hunk counts and owning cluster:

| File | hunks | Cluster |
|---|---|---|
| `Scene/ClippingPolygonCollection.js` | 8 | b |
| `Scene/Cesium3DTileset.js` | 5 | c |
| `Scene/Model/Model.js` | 5 | c |
| `Scene/Cesium3DTile.js` | 3 | c |
| `Scene/ClippingPolygon.js` | 3 | b |
| `Scene/CreditDisplay.js` | 3 | d |
| `Scene/Scene.js` | 3 | d |
| `Scene/Cesium3DTilesetCache.js` | 1 | c |
| `Scene/Model/ModelSceneGraph.js` | 1 | c |
| `Scene/PostProcessStage.js` | 1 | d |
| `Scene/PrimitiveCollection.js` | 1 | d |
| `Renderer/ShaderBuilder.js` | 1 | d |
| `Renderer/UniformState.js` | 1 | d |

**36 of the sync's 79 conflict hunks (46%)**, spanning **all four clusters**.

The 11 conflicted `.js` files that are *not* structural — ES6 on both sides, or neither — are the
genuine semantic conflicts and deserve the deeper review budget: `Core/VectorPipeline.js`, the three
`Scene/Buffer*Collection.js`, `Scene/GeoJsonPrimitive.js`, `Scene/GlobeSurfaceShaderSet.js`,
`Scene/GlobeSurfaceTileProvider.js`, `Scene/MVTDataProvider.js`, `Scene/Snapping.js`, and the two
Specs.

**One of the 13 takes a different route to the same end, and the guard admits no exception for it.**
`ClippingPolygon.js` is classed `THEIRS-THEN-READD` in the census (§4.1) rather than
`PORT-INTO-CLASS`, because upstream rewrote nearly the whole file — 12 upstream hunks adding holes
and construction-time immutability — so starting from `theirs` is genuinely cheaper than porting that
delta into the fork's class body. **It is still one of the 13** (verified: fork `class` 1 /
`.prototype.` 0; upstream `class` 0 / `.prototype.` 1), so its ES6 re-conversion is **part of that
file's resolution inside the merge commit, not a follow-up.** The census row's phrasing — "re-apply
ES6 class syntax as a mechanical follow-up" — is superseded here: deferring it past the commit would
make `UPSTREAM-SYNC-1.145-00` fail its own acceptance, on this section's own lead example. Different
route, same requirement — the file is an ES6 class when the merge commit is made.

### 3.1 Why `--theirs` is wrong here

For these 13 files, taking upstream's prototype-based file wholesale:

1. **reverts the fork's ES6 class conversion** — many batches of work done under CLAUDE.md's own
   "ES6+ Modernization — Incremental Upgrade Rule";
2. **loses more than WebGPU code**, so the procedure's "then re-add WebGPU code" does not restore
   it — what is lost is the file's whole shape, including `Object.defineProperties` → `get`/`set`;
3. **fails silently in review** — the file still parses, still exports the same symbols, and most
   specs still pass, because the public API is unchanged.

### 3.2 The sixth resolution class

The census (§4) and the cluster analyses (§5) use five classes from the lane brief —
`THEIRS-THEN-READD`, `OURS`, `MANUAL`, `DROP-FORK-CODE`, `C16-ONLY` — plus one this dry run forced:

> **`PORT-INTO-CLASS`** — never `--theirs` the file. Start from the fork's `ours` (ES6 class)
> version, read upstream's `base → theirs` diff to extract the **semantic delta only**, and
> hand-port that delta into the fork's class body. The conflict markers are noise; the signal is the
> upstream side-diff (`_lane-out/dryrun/diffs/<path>.UPSTREAM.diff`).

### 3.3 The guard this needs

The failure mode is silent, so the resolution needs a mechanical check. After each
`PORT-INTO-CLASS` file is resolved:

```bash
grep -nE '^[A-Za-z0-9_]+\.prototype\.' <file>   # must print nothing
grep -nE '^class [A-Za-z0-9_]+' <file>          # must print the class
```

Generalised, and worth landing as part of the sync batch: **a check that no file which was an ES6
class at `01226c648a` is prototype-based after the merge is resolved.** One assertion, catches the
entire class of silent reversion, and nothing in the fork's current gate does. Filed as
`UPSTREAM-SYNC-1.145-08` (§9).

This is a source-shape assertion, which CLAUDE.md rightly distrusts as a *behaviour* test — but the
invariant here genuinely is about source structure, so shape is the correct instrument.
---

## 4. The conflict census

Compiled by Tar-Ardamin (Sonnet). Full per-file table with upstream/fork hunk counts, feature
attribution and per-row notes: `_lane-out/TAR-ARDAMIN_CENSUS.md`.

The census covers **both** risk sets — the 32 files that conflict, and the 27 both-sides-changed
files that auto-merged. The second set is not padding: §4.3 is where the sync's most dangerous
findings live.

### 4.1 Section A — the 32 conflicted files

| Class | Files |
|---|---|
| `MANUAL` | 19 |
| `PORT-INTO-CLASS` | 10 |
| `THEIRS-THEN-READD` | 2 |
| `MANUAL` + partially `DROP-FORK-CODE` | 1 |
| `OURS` / `C16-ONLY` / `UNDETERMINED` | 0 |

**No `C16-ONLY` rows at all.** The comment-remediation class the brief anticipated does not appear —
C16's comment work did not land in the files 1.145 touched.

**Only one `DROP-FORK-CODE` trace at census level**, and it is qualified. The `UP-1` disposition is
cluster (b)'s to make (§5.2), and the census correctly declined to pre-empt it.

**Two of the ten `PORT-INTO-CLASS` rows are explicitly flagged as *not* pure shape** —
`UniformState.js` (fork content: MoonLight, eclipse, TAA history, and the
`UniformStateComputations.js` extraction) and `ClippingPolygonCollection.js` (a `CLIPPING_POLYGONS`
feature-renderer branch). The class-conversion noise sits *on top of* real fork logic in both, so
"keep ours, port the delta" needs more care there than in the shape-only rows.

**A divergence worth recording.** The census calls `Model.js` `MANUAL`; cluster (c)'s deeper read
calls it `PORT-INTO-CLASS`. Both are defensible — the file's *shape* is a class conversion, but the
semantic port inside it is large enough to feel like a manual merge. On its own files the cluster
analysis wins, being the deeper read; but the disagreement is itself signal, and `Model.js` should
get the most review attention of any single file in the sync. The census and cluster (c) agree on
everything else checked.

### 4.2 Section B — the 27 both-sides-changed files that auto-merged

| Verdict | Files |
|---|---|
| `AUTO-OK` | 14 |
| `AUTO-VERIFY` | 12 |
| `UNDETERMINED` | 1 |

The single `UNDETERMINED` is `GlobeSurfaceTileProviderSpec.js`, flagged honestly rather than
guessed: it needs a human to confirm the spec exercises the WebGPU pick mini-frame path together
with the new clipping-rebake wiring, which was the sharpest risk in the production file.

### 4.3 The census's four cross-cutting patterns

These generalise past any single cluster and are the reason to read the census rather than only the
cluster analyses.

**1. One epic dominates both sections.** Draping vector / GeoJSON / MVT data and clipping polygons —
now with holes, immutability, and a unified rectangle/rebake model — onto terrain and 3D Tiles
touches roughly **two-thirds of both sections' rows**. It must be resolved as one dependency-ordered
slice, not as independent files: `VectorPipeline` / `VectorProvider` → `ClippingPolygon(Collection)`
→ `Cesium3DTile(set)` / `GlobeSurfaceTile(Provider)` → `Model` / `ModelSceneGraph` → `GlobeFS/VS.glsl`
/ `VectorCommon.glsl` → everything else.

**2. The ES6-conversion finding generalises past the conflicted set.** At least four Section B files
show the same fork-class-vs-upstream-prototype shape — `WebMapServiceImageryProvider.js`,
`WebMapTileServiceImageryProvider.js` and others — and simply did not collide because upstream's
edits landed in doc comments or genuinely disjoint methods. **Shape noise is a property of this
sync, not of any one file list.** Independent corroboration arrived from the fork's own side: two
Section B files delete now-stale `// @ts-expect-error Requires {Model,Cesium3DTileset} conversion to
ES6 class` comments — the fork documenting its own conversions.

**3. Silent numeric-key collisions are a distinct risk class**, and neither git nor a marker file can
surface them. The globe shader-variant bit allocation (§5.1) is the one confirmed instance, but the
census's recommendation is broader and worth acting on: **any additive bitmask, index or enum scheme
touched by both sides deserves the same scrutiny** — check `ShaderDefine` usage sites,
`FeatureRendererKey` values and pipeline-cache axis markers before landing.

**4. "Auto-merged" correctness is frequently contingent on a *different* file's manual resolution.**
This is the sync's unifying finding, reached independently by the census and by all three cluster
analysts. The confirmed dependency pairs:

| Auto-merged file | Depends on the manual resolution of |
|---|---|
| `Renderer/AutomaticUniforms.js` | `Renderer/UniformState.js` |
| `Shaders/GlobeFS.glsl`, `Shaders/GlobeVS.glsl` | `Shaders/VectorCommon.glsl` |
| `Model/PickingPipelineStage.js`, `VectorGltf3DTileContent.js` | `Model/Model.js`, `Core/VectorProvider.js` |
| `Specs/Scene/SnappingSpec.js` | `Scene/Snapping.js` |

**Land Section A's `MANUAL` / `PORT-INTO-CLASS` rows first and re-verify their Section B dependents
after, never in parallel.**

Two instances deserve naming because a clean merge actively misleads:

- **`GlobeFS.glsl`** compiles only if `vectorClip(vec2)` is **brought in** by `VectorCommon.glsl`'s
  manual resolution. `vectorClip` is **new from upstream** — 0 hits at merge-base, 0 on the fork, 1
  upstream, in each of the two files — so the auto-merged `GlobeFS.glsl` arrives already calling a
  function the fork has never had. The hazard is *failing to bring it in* while reconciling the
  fork's condition-number fix, not dropping something the fork owns; either way **every WebGL
  clipping-polygon build fails outright**. Treat the two as one atomic unit. (§5.1.4 states the same
  hazard in the same direction.)
- **`SnappingSpec.js`** is the tightest near-miss in the whole sync: the two sides' hunks land
  **two lines apart**, on the spec file for the production file already flagged as most dangerous. A
  "no conflict markers" result here is not evidence the merged spec still exercises whatever
  `Snapping.js` becomes. It needs a re-read and almost certainly hand-editing *after* `Snapping.js`
  is resolved.

### 4.4 The census's riskiest-three, independently derived

1. **`Scene/Snapping.js`** — the fork's frozen-camera-state WebGPU snap reconstruction against
   upstream's live-repick `surfacePosition` feature, with its spec auto-merging two lines away.
2. **`Scene/GlobeSurfaceShaderSet.js`** — the silent shader-variant bit collision (§5.1).
3. **`Scene/Model/Model.js`**, tied with **`Scene/ClippingPolygonCollection.js`** — the densest
   intersection of fork WebGPU feature-renderer, clip-plane and translucent-classification logic with
   upstream's new unified vector-lookup / clipping-rebake model.

This list was produced without sight of the cluster analyses and agrees with them on all three.
---

## 5. The four cluster analyses

Each cluster's full working — every hunk, every citation — is banked in `_lane-out/`. This section
carries the resolutions and the findings that change how the sync is landed.

### 5.1 Cluster (a) — globe. `GlobeSurfaceShaderSet` + `GlobeSurfaceTileProvider`

Analyst: Tar-Vanimelde (Opus). Full working:
`_lane-out/TAR-VANIMELDE_CLUSTER_A_GLOBE.md` (11 hunks, every line re-opened).

#### `UP-7`: CONFIRMED IN KIND, CORRECTED IN DEGREE

The lens said the globe shader-set key's high bits collide **three ways**. They collide **five
ways**, and the mechanism is worse than "both sides appended".

Bits 0–31 are byte-identical on all three sides — same operands, same shifts, same `>>> 0` wrap
guard. The entire divergence is the arithmetic tail:

| Bit | merge-base `6d5d8b1f07` | fork `main` | 1.145 `upstream/main` | Collide? |
|---|---|---|---|---|
| 32 | `applyDayNightAlpha` | `applyDayNightAlpha` | `applyDayNightAlpha` | no — agreed |
| 33 | **`hasVectorLayer`** | `enableEclipseGlobeShadow` | `hasVectorLayer` (unchanged) | **YES** |
| 34 | — | `hasVectorLayer` *(moved off 33 by the fork)* | `hasVectorPolylines` | **YES** |
| 35 | — | `applyNightDarkness` | `hasVectorPolygons` | **YES** |
| 36 | — | `applyNightLights` | `vectorAntialias` | **YES** |
| 37 | — | `applyCelestialWater` | `vectorWidthInMeters` | **YES** |
| 38 | — | — | `vectorMixedWidthUnits` | no — upstream only |

**`hasVectorLayer` was renumbered, not added.** It sat at bit 33 in the merge-base; the fork moved
it to bit 34 because its eclipse flag had already taken 33, and says so in an in-code comment. That
is a deliberate, documented renumbering of an **inherited upstream bit** — precisely the hazard
class CLAUDE.md forbids outright for the WebGPU `ShaderDefine` registry ("Add-only. Never reorder,
renumber, or remove"). **No equivalent add-only rule is written for this WebGL globe key, and that
gap is itself a finding** (§5.1.3).

#### Why neither naive side is safe

Both failure modes are silent — nothing throws, nothing fails:

- **`--theirs`** drops the fork's `enableEclipseGlobeShadow`, `applyNightDarkness`,
  `applyNightLights` and `applyCelestialWater` out of the key. Four fork features then alias against
  each other and against the vector flags.
- **`--ours`** leaves 1.145's five vector flags out of the key while upstream still pushes a
  *different* `#define` set per combination. Two tiles differing only in polyline-vs-polygon vector
  content then collide on one cached `ShaderProgram`.

**Only a MANUAL union of both tails is correct.**

#### It is WebGL-only, and the WebGPU fold is not a mitigation

The WebGPU globe uses a separate **string** key (`WebGPUGlobeSurfacePipelineKey.ts`) and the four
fork features are uniform-driven there, so CLAUDE.md's shader-module-identity fold in the WebGPU
pipeline cache does **not** protect this path. The mitigation that exists for one backend does not
reach the backend that has the bug.

#### Resolutions

11 hunks: **`MANUAL` 4** (the JSDoc typedef list, the `flags` arithmetic tail, the imports, the
moved-out rendering block) · **`THEIRS` 5** · **`OURS` 1** · **`THEIRS`-but-gated 1**. No
`DROP-FORK-CODE`, no `C16-ONLY`.

Two hunks deserve naming:

- **The `flags` arithmetic tail is the highest-severity hunk in the sync.** Five colliding bits, a
  silent failure either way, and — see below — no detector.
- **The moved-out rendering block is the largest hunk in the sync at 1,451 lines**, and the most
  easily mis-resolved: `--theirs` silently un-does the fork's decomposition and duplicates two
  exported functions across modules.
- **The `updateForPick` hunk resolves `OURS`**, and the justification is worth recording because it
  is the good kind of finding: `DrawCommand.shallowClone` gives the fork an empty derived-command
  graph, so the fork is **structurally immune** to the pick-staleness bug 1.145 is fixing. The
  upstream fix is not needed rather than not wanted.

**Land order within the cluster:** JSDoc → clipping-function injection + definitions (atomic) →
imports → the three helper functions + dispatch + per-tile build (atomic) → the rendering block →
`updateForPick` → **the `flags` tail last, behind its new injectivity spec.**

#### 5.1.3 The detector gap — the most actionable finding in this cluster

**Nothing in the fork can currently detect a globe shader-key collision.**

- `GlobeSurfaceShaderSetSpec.js` is 1,068 lines and has **zero** `flags` coverage.
- `pipeline-key-aliasing.spec.mjs` — the fork's existing aliasing guard — is **WebGPU-only**.
- The three fork globe law-specs assert **source text**, not behaviour, and have **no npm runner
  home**, which is a standing `R-2026-08-29-1` review blocker independent of this sync.

The proposed instrument is a browser-free **injectivity spec**: enumerate the flag combinations,
assert the key function is injective over them, and pair it with an inertness mutant. That is
behaviour, cheap, and it would have caught this class before the sync rather than during it. It
belongs with `UPSTREAM-SYNC-1.145-01`, and the add-only rule for this key belongs with it.

#### 5.1.4 This cluster cannot land alone — and it is where `G1` bites

`git grep czm_clipPolygons upstream/main` is **empty**: 1.145 deleted the GLSL that
`GlobeTerrain.wgsl` is an explicit parity port of. So the hunk that removes the SDF producer means
**WebGPU globe clipping silently stops clipping** unless the WGSL port co-lands.

Three concrete couplings force co-landing with cluster (b):

- the new clipping-polygon helpers and the auto-merged `GlobeSurfaceTile.js` call
  `requestRectangleData` / `releaseRectangleData`, which exist **only** on `upstream/main`;
- the auto-merged `GlobeFS.glsl` calls `vectorClip`, which exists **only** in `upstream/main`'s
  `VectorCommon.glsl`;
- the SDF producer hunk is `THEIRS`-but-gated — it becomes `OURS` if the WGSL port cannot co-land.

This is the sharpest illustration of §8.0's point: two auto-merged files call functions that only
exist on the upstream side of a *conflicted* file. The merge must be resolved as one unit.

`probe-globe-clippoly-geodetic.mjs` is the post-sync re-run and **must not be re-baselined**.
---

### 5.2 Cluster (b) — clipping polygons + vector pipeline. The sync's largest cost centre

Analyst: Tar-Telperien (Opus). Full working:
`_lane-out/TAR-TELPERIEN_CLUSTER_B_CLIPPING_VECTOR.md` (28 hunks, 757 lines).

**Resolutions (28 hunks):** `PORT-INTO-CLASS` 11 · `THEIRS` 7 · `MANUAL` 9 · `MANUAL` doc-only 1.
**Zero `DROP-FORK-CODE`. Zero `OURS`.**

#### 5.2.1 `UP-1`: CONFIRMED as a cost, but the lens's disposition is wrong

The lens called this an **ABSORB**. It is a **REWORK on everything and a DROP on nothing** — and the
distinction is the difference between a working feature and a dark one.

**~1,627 LOC at stake**, and the honest split matters far more than the headline:

| Bucket | LOC | What it is |
|---|---|---|
| A — WebGPU-only whole files | **581** | `WebGPUClippingPolygonCollection.ts` 347, `PolygonSignedDistance.wgsl` 151, `csm_clipByPolygons.wgsl` 76, `csm_unpackClippingExtents.wgsl` 7 |
| B — embedded WebGPU regions | **~284** | `globeClipByPolygon` 84, `modelClipByPolygon` 105, the `WebGPUEffectsBindGroup` clipping slice ~95 |
| C — backend-neutral JS **upstream deletes but the WebGPU path still needs** | **762** | 709 of `ClippingPolygonCollection.js`'s 1,184 lines, plus `ClippingPolygon.computeSphericalExtents` 53 |

Bucket C is ~47% of the total and is **not new work** — it is upstream code the fork would be
re-adopting as its own. It is also the bucket that **re-buys the same 8-hunk conflict at 1.146** if
it is simply left in place.

**Why not DROP.** The ledger, re-derived in this run rather than inferred: `FEATURE_INVENTORY.md:627`
and `:684` mark both artifacts **SHIPPED**; `DEFERRED_WORK.md:6028` marks `NEW-MODEL-CLIPPING-POLYGONS`
**RESOLVED**; `DEBUGGING_GUIDE.md:348` documents `probe-globe-clippoly-geodetic.mjs` as its
pixel-level end-to-end gate. **The decisive negative: a search of `DEFERRED_WORK.md`,
`CAMPAIGN_STATE.md` and `FEATURE_INVENTORY.md` found no row scheduling this path's removal or
deprecation.** Its current disposition is shipped, working and gated.

This is Principle 7 applied in the direction the principle's own text warns about — and it is the
*reverse* of the C-R8 anecdote. The risk here is not deleting scaffolding that looked dead; it is
**classifying working, shipped, gated code as droppable because its upstream twin died**. An upstream
deletion is evidence about upstream, not a ledger disposition for the fork.

**Why not KEEP as-is either.** `WebGPUClippingPolygonCollection`'s declared input contract
(`packDataForFeatureRenderer` producing spherical extents) is exactly what upstream deletes. Keeping
it untouched inside upstream-tracked files guarantees the conflict returns every sync.

#### 5.2.2 The three-step rework, and the blocker that gates step 2

**Step 1 — relocate, and this lands *with* the merge.** Move bucket C out of the two upstream-tracked
`Scene/` files into a fork-owned module (proposed: `Scene/ClippingPolygonSdfPack.js` exporting
`packDataForFeatureRenderer`, `computeSphericalExtents` and the three resolution helpers). It must
stay backend-neutral — it is `Scene/` code, so Principle 2 applies: no `Renderer/WebGPU/` import, no
`isWebGPU` branch; the `CLIPPING_POLYGONS` feature renderer calls into it. **This is the step that
makes 11 of the cluster's hunks mechanical instead of open-ended**, and it is the only part of the
rework that cannot be deferred.

**Step 2 — the successor twin, filed as a row, not done in the sync.** A WGSL twin of `vectorClip`
reading the same polygon-edge / primitive-index / grid-cell tables the new upstream path produces.
It restores algorithmic parity *and* delivers holes for free, because holes in the new algorithm are
just more rings in the even-odd test.

**The blocker, stated plainly (Principle 9).** That twin needs **polygon** tables in the WebGPU vector
bake, and the fork has **polylines only**. This is already in the ledger:
`DEFERRED_WORK.md:14183-14192`, `NEW-WEBGPU-VECTOR-POLYGON-DRAPING`, filed 2026-08-10 at Batch 959,
still **OPEN**. 1.145 raises that row's value sharply — the same polygon tables now unlock clipping
as well as draping. **Building it is the next concrete step**, and it should be re-tiered from
"M-sized parity gap" to "prerequisite for the 1.145 clipping twin".

**Step 3 — retire.** Only once step 2 ships does bucket A/B become a genuine `DROP-FORK-CODE`. File
it as a follow-up cleanup row so the deletion is a decision with a date rather than an accident.

#### 5.2.3 Four ways "parity" changes meaning after this merge

Principle 5 says a renderer-agnostic feature exists on both backends. Clipping polygons still will —
but not in the same sense, and the plan should say so rather than let the word paper over it:

1. **Algorithm parity is gone by construction.** WebGL runs even-odd ray casting over per-rectangle
   vector edge tables; WebGPU runs an SDF atlas built by a compute shader. Coarse pixel parity may
   hold, but the fork's actual working model — "same algorithm, two languages", the pre-translated
   WGSL twin template — has no pair to lock to. Every future clipping defect must be diagnosed twice.
2. **Two user-visible features become WebGL-only on day one:** `ClippingPolygon.holes`, and 1.145's
   headline quality improvement across distance scales. This is ordinary fork parity debt and is
   already tracked (`ARCHITECTURE_REVIEW_2026-09-02.md` row C01, PARTIAL / HIGH).
3. **Two API surfaces become WebGPU-only, with deprecation text that is actively wrong.** Upstream
   deprecates `quality` and `debugShowDistanceTexture` saying they "no longer [have] any effect". On
   the fork's WebGPU backend both **do** still have an effect — `quality` sizes the SDF atlas and
   `debugShowDistanceTexture` drives a real overlay. Shipping a warning that tells users a live knob
   is inert is a defect the merge introduces silently. **Decide it explicitly** — fork the two
   messages to state the WebGPU caveat, or gate the deprecation on the WebGL path. Do not let
   `--theirs` decide it.
4. **A silent divergence lands with no conflict marker.** `ModelClippingPolygonsPipelineStage.js` and
   both `ModelClippingPolygons{FS,VS}.glsl` have an **empty fork diff** and auto-merge, so they take
   upstream's rewrite wholesale. At merge time the **WebGL** model clipping path switches to
   `vectorClip` while `modelClipByPolygon` in `ModelPBRComplete.wgsl` keeps sampling the atlas.
   Nothing warns, and no model-clipping capture exists to catch it.

#### 5.2.4 `UP-2` and `UP-5`, re-derived

- **`UP-2` CONFIRMED, and cheaper than feared.** The `TilingScheme` → `Ellipsoid` signature change is
  real, but **exactly one** fork call site passes the old type, and upstream rewrote that whole
  method — so git absorbs it. Post-merge, just verify the old `_tilingScheme` reference is gone.
- **`UP-5` CONFIRMED with a correction to its description.** It is not "drape binding moved onto
  `Scene`". It is that **registration lifetime changed** from persistent `add()`/`remove()` to
  per-frame `markForFrame`, with `Scene` owning the walk. And `PrimitiveCollection.js` needs
  **nothing** — its entire upstream diff is a `@template T` JSDoc. That independently matches cluster
  (d)'s reading of the same file (§5.4 D-4). The hand-off to cluster (d) is written as seven numbered
  requirements, including the ordering constraint that **cluster (b)'s `heightReference` must land
  first or the walk marks nothing**.

#### 5.2.5 The riskiest item is, again, not a conflict

The **auto-merged** `VectorPipeline` + `renderBufferPolylineCollection` width change: `widths` moves
`Uint8Array` → signed `Float32Array`, `widthTexture` moves `UNSIGNED_BYTE` → `FLOAT`, and a new
`pickColorTexture` appears. None of it conflicts, none of it is gated, and all of it silently
desynchronises the WebGPU storage-buffer bake in `WebGPUVectorTileResources.ts` from the WebGL
texture bake it is required to mirror. **No marker, no type error** (the fork's TS does not check the
WGSL side), **and no probe failure** until a `"meters"`-width or picked vector reaches a WebGPU frame.

**Mitigation, before landing:** diff `VectorPipeline`'s post-merge table layout against
`WebGPUVectorTileResources.ts`'s packer field-by-field, then re-run `probe-vector-draping.mjs` on
both backends.

#### 5.2.6 Cluster verdict and two DX defects

**Three batches, not one:** (i) vector plumbing — mechanical, gated by `probe-vector-draping.mjs` and
`probe-geojson-*`, and **independent, so it can land first**; (ii) the clipping port — one indivisible
decision, gated by `probe-globe-clippoly-geodetic.mjs`; (iii) the WGSL twin follow-up, filed not done.

**Dependencies.** Inbound: cluster (c) must resolve `Model.js` and `Cesium3DTileset.js` as
`PORT-INTO-CLASS`, or `VectorGltf3DTileContent.js` breaks `tsc`. Outbound: cluster (d)'s Scene walk
needs this cluster's `heightReference`.

**Two DX defects surfaced** (per the standing directive to report them rather than fix silently):
`Tools/visual-regression/vector-layer-draping.spec.mjs` has **no npm runner home** — a review blocker
under `R-2026-08-29-1` independent of this sync — and several of its assertions are **source-text
regexes** that upstream's reflow will break without any behaviour changing.
---

### 5.3 Cluster (c) — 3D Tiles + glTF models

Analyst: Tar-Surion (Opus). Full working:
`_lane-out/TAR-SURION_CLUSTER_C_TILES_MODELS.md` (15 hunks + 22 auto-merged files).

#### Resolutions: 15 of 15 are `PORT-INTO-CLASS`

Zero `THEIRS-THEN-READD`, zero `OURS`, zero `MANUAL`, zero `DROP-FORK-CODE`, zero `C16-ONLY`. The
whole conflicted set is **structural in shape** — but "structural" describes why the conflict fired,
not whether there is a delta to port, and those are different questions.

**Six of the 15 hunks carry no upstream semantic content** and resolve to "keep `ours`, port nothing".
**The other nine do carry a delta**, and three were re-derived under review as explicit
counter-examples to any blanket reading:

| Hunk | Upstream content inside the conflict region | fork / upstream hits |
|---|---|---|
| `ModelSceneGraph.js` | the `hasDrapedVectors()` → `modelPipelineStages.push(ModelVectorLookupPipelineStage)` registration, plus the `hasClippingPolygonGeometry` guard | 0 / present at `theirs:741-748` |
| `Cesium3DTilesetCache.js` | `forEachLoadedTile`, with a live consumer | 0 / 1 |
| `Cesium3DTile.js` | `clippingPolygonsNeedRebake` | 0 / 3 |

**"Keep ours, port nothing" on `ModelSceneGraph.js` would leave this cluster's own non-deferrable new
pipeline stage registered nowhere** — the stage file would land and never be pushed. Resolve each of
the 15 against the per-hunk table in the bank rather than against the cluster's headline class; the
class tells you not to run `--theirs`, it does not tell you there is nothing to bring across.

The analyst reached the `PORT-INTO-CLASS` conclusion **independently, before the lead's §3 note
arrived**. That is worth recording: §3 is not a single reading of the tree, it is two.

#### The real risk is in the files that did *not* conflict

**`AUTO-OK` 15 · `AUTO-VERIFY` 7.** Every one of the seven is a **consumer the merge landed ahead of
its producer**: `ModelClippingPolygonsPipelineStage.js`, `Core/VectorProvider.js`,
`Model3DTileContent.js`, `PickingPipelineStage.js`, `ModelClippingPolygonsStageVS.glsl`,
`ModelClippingPolygonsStageFS.glsl`, `ModelVS.glsl`.

**Riskiest item in the cluster: `ModelClippingPolygonsPipelineStage.js`.** It auto-merged to
upstream wholesale, its uniforms all fall back to `?? defaultTexture`, and its producer
(`model._clippingPolygonData`) **does not exist in the fork**. Resolve the corresponding `Model.js`
hunks wrong and model clipping polygons stop clipping **with no error of any kind** — the exact
profile of a regression that ships.

#### Two silent breaks that produce no conflict marker at all

These are the cluster's most valuable findings, and neither appears anywhere in the conflict list.

**1. Three live call sites to a method 1.145 deletes.** Upstream removes
`ClippingPolygonCollection.queueCommands`, but the merge **silently keeps all three fork call
sites** — `Cesium3DTileset.js:1444`, `Model.js:2525` (this cluster) and
`GlobeSurfaceTileProvider.js:673` (cluster a). The mechanism is worth understanding, because it will
recur: the fork had *moved* the surrounding block, so git saw delete-here / delete-here and read it
as **agreement**. No conflict marker is emitted anywhere. The result is three calls to a method that
no longer exists.

This is one decision — keep the method or drop the call sites — with three consequences. Take it
once at the top rather than rediscovering it three times mid-resolution.

**2. A silent arity break handed to cluster (a).** 1.145 reshapes
`VectorProvider.requestTileData` / `updateTileData` / `update`, while the fork's
`GlobeSurfaceTileProvider.js:615/622/630` still pass the old signatures. `VectorProvider.js`
**auto-merged**, so nothing forces anyone to read the new contract against the old callers.

Both are the same shape as `UP-2`'s `TilingScheme → Ellipsoid` parameter change (§5.2), and the same
shape as §5.4's `UniformState` × `AutomaticUniforms` coupling: **the merge is dangerous where it is
quiet, not where it is loud.**

#### The new `ModelVectorLookupPipelineStage` — absorb GLSL now, defer WGSL as a tracked row

1.145 adds a 205-line pipeline stage that drapes vector data onto a **model's** surface, the way the
terrain path already drapes onto the globe, plus its two GLSL leaves.

The fork is closer than it looks but is not there: it has the WGSL polyline half
(`GlobeTerrain.wgsl` carries an explicit documented port of `VectorCommon.glsl::vectorPolylineRender`
with its four helpers) and the buffer/texture side in `WebGPUVectorTileResources.ts`. It does **not**
have `vectorPolygonRender`, `vectorPickColorOver` (needed by the auto-merged `PickingPipelineStage`),
`czm_eyeToCartographicDelta`, or **any** model-side WGSL vector stage.

There is also a structural reason the GLSL stage cannot carry the WebGPU path on its own: when the
MODEL feature renderer runs it has already produced backend-native draw commands and the legacy
pipeline-stage chain must not also run, so adding the stage to `modelPipelineStages` is, on WebGPU,
**a no-op by design**.

**The call: absorb the GLSL side in the sync — mandatory, not deferrable — and file the WGSL twin.**
The GLSL side is non-optional because the auto-merged `PickingPipelineStage.js` already calls
`hasDrapedVectors()` unconditionally for every non-classification model. The WGSL twin becomes
`NEW-WEBGPU-MODEL-VECTOR-LOOKUP` under `UPSTREAM-SYNC-1.145-07`. This is Principle 9 applied exactly
as written: the gap is named as concrete next work rather than routed around.

#### Two `UNCERTAIN`s left open, honestly

1. **Destroy ownership** — who destroys `WebGPUClippingPolygonCollection` once
   `Cesium3DTileset.destroy()` stops destroying the collection.
2. **Bind-group capacity** — whether the WebGPU model bind group has room for nine more texture
   bindings. This sizes the deferred row and should be answered before it is scheduled, not during.

#### Cluster verdict

Does **not** land as its own batch. It is one arc with cluster (b): the `Model.js` hunks call
`requestRectangleData` / `releaseRectangleData`, which do not exist until
`ClippingPolygonCollection.js` is resolved, and the auto-merged model clipping shaders need
`vectorClip` from the conflicted `VectorCommon.glsl`.

**Recommended order within the merge:** (b) `ClippingPolygonCollection` + `VectorCommon.glsl` →
(c) tiles & models → (a) `GlobeSurfaceTileProvider` + the `VectorProvider` arity change.

Deferred rows this cluster opens: `NEW-WEBGPU-MODEL-VECTOR-LOOKUP`; a WGSL model
vertical-exaggeration stage (a pre-existing gap this sync widens); and a tileset-side
destroy-ownership spec to twin the two renamed `ModelSpec` tests.
---

### 5.4 Cluster (d) — renderer core + scene plumbing

Analyst: Nolondil (lane lead, Opus 5) — retained rather than spending a sixth worker slot. Full
working: `_lane-out/NOLONDIL_CLUSTER_D_RENDERER_CORE.md`.

**Scope, 7 files / 14 hunks:** `ShaderBuilder` (1), `UniformState` (1), `CreditDisplay` (3),
`PostProcessStage` (1), `PrimitiveCollection` (1), `Scene` (3), `Snapping` (4).
**Resolutions: `PORT-INTO-CLASS` 10 · `MANUAL` 4.** Six of the seven files are structural;
`Snapping.js` is the only genuinely semantic conflict in the cluster.

#### D-1 — `UniformState` × `AutomaticUniforms`: a break that spans the conflict boundary

**The most dangerous item in the cluster is not one of its 14 hunks.**

1.145 adds two automatic uniforms, `czm_eyeCartographic` (`vec3`) and `czm_eyeToEnu` (`mat3`), plus
a new `eyeToCartographicDelta.glsl` builtin. The change lands on **both sides of the conflict
boundary at once**:

| File | Merge outcome | Carries |
|---|---|---|
| `Renderer/AutomaticUniforms.js` | **auto-merged** | the two entries, whose `getValue` bodies read `uniformState.eyeCartographic` / `.eyeToEnu` |
| `Renderer/UniformState.js` | **CONFLICTS** | the backing `_eyeCartographic` / `_eyeToEnu` fields and their accessors |

The fork's `UniformState.js` contains **zero** occurrences of either name today. The natural
resolution of a structural conflict — "keep the fork's class" — is right for shape and silently drops
both members, at which point every `czm_eyeCartographic` / `czm_eyeToEnu` uniform set receives
`undefined`. Nothing throws at merge time, at build time, or in any existing spec.

**Resolution: `PORT-INTO-CLASS`, and it must land inside the merge commit** (§8.0) — the auto-merged
file is broken until it does. Port both fields into the class constructor, expose them as ES6 getters
(upstream declares them via `Object.defineProperties`), and put the population step in
`UniformStateComputations.js` alongside the fork's existing `clean*` / `update*` helpers.

**Parity obligation.** The fork has zero occurrences of either name anywhere under
`packages/engine/Source/`, so there is no WGSL twin — a new upstream GLSL builtin with no WebGPU
equivalent. Absorb the GLSL with the merge; file the WGSL twin as `UPSTREAM-SYNC-1.145-07`.

**Detector gap:** nothing in the fork's gate catches an `undefined` automatic uniform. Worth a
permanent sentinel.

#### D-2 — `PostProcessStage`: `UP-10` confirmed, with the fix already built

**`UP-10` CONFIRMED, wording corrected.** The lens said the fork "retired `ContextLimits` to zero
readers". Precisely: **61** references exist, but **0** outside `packages/engine/Source/Renderer/` —
it is confined to the renderer layer, not retired.

1.145 adds exactly one Scene-layer reader:
`upstream/main:.../Scene/PostProcessStage.js:13` (the import) and `:805`
(`ContextLimits.maximumTextureSize`, clamping the selected-feature-id texture).

`ContextLimits` is a process-global singleton. The fork runs **multiple simultaneous contexts with
different backends** (Principle 3; split-screen is a shipped configuration and the visual-regression
harness's own mode), so a global limit is whichever context initialised last. Absorbing the line
verbatim makes `PostProcessStage` clamp against the wrong context's limit in exactly that
configuration.

**Resolution — absorb the clamp, substitute the source.** The fork already built the migration path:
`GraphicsContext.ts:1187-1190` exposes `get limits(): GraphicsCapabilitiesRecord` documented as the
"compatibility alias for consumers migrating from ContextLimits", and
`GraphicsCapabilities.d.ts:17` declares `readonly maximumTextureSize: number`. The ported line is
`context.limits.maximumTextureSize`; the `import ContextLimits` line is **not** taken. `context` is
already a parameter at the call site.

#### D-3 — `Snapping.js`: `UP-4` confirmed; upstream's design is incompatible

**`UP-4` CONFIRMED.** 1.145's `SceneSnapResult.surfacePosition` is implemented as a **complete second
pick cycle nested inside a single snap query**, gated on `best.isEdge`: `pickBegin(...)` with
`SNAP_SURFACE_REGION_WIDTH = 9.0`, then `snapFramebuffer.end(...)` — **a synchronous readback** —
then `pickEnd(...)`.

The fork's WebGPU snap path cannot do that, and says so in its own `captureSnapView` docstring: *"The
synchronous WebGPU API consumes a completed readback from an earlier mini-frame, so it must
reconstruct against that rendered view rather than the live camera."* Upstream's sequence assumes it
can render and read *now*; under WebGPU that means a second mini-frame plus a second `mapAsync`
round-trip — doubling latency on the interactive path.

**Resolution — `MANUAL`; take the contract, not the implementation.** Upstream centres its 9-px read
on the edge hit itself so the seed does not depend on cursor position — which is very likely a
neighbourhood the fork's existing snap readback already covers. If so, `surfacePosition` can be
computed from data in hand with **no second readback on either backend** — better than upstream, and
better for WebGL too.

**`UNCERTAIN`, and the resolver must settle it before writing code:** whether the fork's existing snap
region contains the 9-px neighbourhood in the worst case. If not: widen the fork's single read, or —
explicitly and as a tracked row, never silently — return `undefined` for WebGPU edge hits.

#### D-4 — `Scene.js` + `PrimitiveCollection.js`: `UP-5`

`PrimitiveCollection.js` needs **nothing**: its entire upstream delta is a `@template T` JSDoc
generic. Cluster (b) reached the identical conclusion independently.

`Scene.js` absorbs `markVectorCollections` and its two imports. The concern is **cost, not
correctness** — a new per-frame full-primitive-tree recursive walk, in the fork's most heavily
diverged file (10,173 changed lines since merge-base). Absorb, then measure call counts and
allocations alongside frame time, not one number.

#### D-5 / D-6 — `CreditDisplay` and `ShaderBuilder`

`CreditDisplay`: a clean accessibility absorb (keyboard activation for `role="button"` elements, a
`:focus-visible` outline). DOM/CSS only, backend-neutral, no parity obligation.

`ShaderBuilder`: the conflict pairs the fork's `addVarying()` class method against upstream's
`addFragmentLines` prototype assignment — two unrelated methods. Upstream's real delta for the file
is **one JSDoc line** widening `@param {string[]}` to `{string|string[]}`. The clearest illustration
in the sync of why `--theirs` is the wrong default: the conflict looks like an API collision and is a
comment edit.

Both are the cheapest items in the sync and make good warm-ups for the `PORT-INTO-CLASS` procedure.

---

### 5.5 Cross-cluster synthesis — what the four analyses agree on

#### The unifying finding: the merge is dangerous where it is quiet

All four analysts and the census reached this independently. **The sync's most serious risks are in
files that produced no conflict marker**, because a clean textual merge only says the two sides
touched different lines — not that the result is coherent.

Every confirmed instance, in one place:

| Silent break | Consumer (auto-merged) | Producer (conflicted or deleted) |
|---|---|---|
| `czm_eyeCartographic` / `czm_eyeToEnu` resolve to `undefined` | `AutomaticUniforms.js` | `UniformState.js` |
| WebGL shader fails to compile — undefined `vectorClip` | `GlobeFS.glsl`, `GlobeVS.glsl` | `VectorCommon.glsl` |
| model clipping stops clipping, no error | `ModelClippingPolygonsPipelineStage.js` + its two GLSL leaves | `Model.js` (`_clippingPolygonData`) |
| three calls to a **deleted** method, no marker anywhere | `Cesium3DTileset.js:1444`, `Model.js:2525`, `GlobeSurfaceTileProvider.js:673` | `ClippingPolygonCollection.queueCommands` |
| arity mismatch on three methods | `GlobeSurfaceTileProvider.js:615/622/630` | `VectorProvider.js` (auto-merged, reshaped) |
| WebGPU vector bake desynchronised from the WebGL bake | `VectorPipeline.js`, `renderBufferPolylineCollection.js` | `WebGPUVectorTileResources.ts` (not in the merge at all) |
| merged spec no longer exercises its production file | `SnappingSpec.js` (hunks land **2 lines** apart) | `Snapping.js` |

The `queueCommands` row deserves special attention because of *how* it hides: the fork had moved the
surrounding block, so git read delete-here / delete-here as **agreement** and emitted nothing.

**Operational consequence:** resolve every conflicted file first, then re-verify its auto-merged
dependents — never in parallel, and never treat "no conflict markers" as a result.

#### The forced landing order

Cluster (a) and cluster (c) each independently concluded they **cannot land alone**, and the
dependency chain the three analyses produce is consistent:

> **(b) vector plumbing** → **(b) `ClippingPolygonCollection` + `VectorCommon.glsl`** →
> **(c) tiles & models** → **(a) globe** → **(d) scene walk**

with cluster (b)'s vector-plumbing batch independent and able to lead, and cluster (b)'s
`heightReference` required before cluster (d)'s Scene walk marks anything. Since §8.0 establishes
that all of this lands in one commit anyway, this is the **resolution order within the working
tree**, not a commit sequence.

#### Three decisions to take once, at the top

Taking these before resolution starts avoids rediscovering them three times mid-merge:

1. **Keep `ClippingPolygonCollection.queueCommands` or drop its three call sites.** One decision,
   three files, two clusters.
2. **The `quality` / `debugShowDistanceTexture` deprecation text**, which upstream writes as "no
   longer has any effect" and which is **false on the fork's WebGPU backend**. Fork the messages or
   gate the deprecation — do not let `--theirs` decide it.
3. **Relocate bucket C** (§5.2.2 step 1) out of the upstream-tracked `Scene/` files. This is what
   makes 11 of cluster (b)'s hunks mechanical, and it is the only part of the `UP-1` rework that
   must land with the merge.

#### What the lane refused to decide

- **`UP-1` is a `REWORK`, not a `DROP`** — and step 3 (retiring ~865 LOC of SDF code) is explicitly
  *not* authorised by this plan. It becomes available only after
  `NEW-WEBGPU-VECTOR-POLYGON-DRAPING` ships.
- **The `S3` gating claim is refuted** (§7.3), and the landscape audit rows that carry it are flagged
  for the maintainer rather than edited here.
- **The Sandcastle telemetry question** (§6.5) is a maintainer call.
---

## 6. Widgets, Sandcastle, dependencies and CI

Full working: `_lane-out/HALLACAR_TOOLCHAIN_AND_VERIFICATION.md` Part 1.

### 6.1 The seven non-engine conflicts

| File | hunks | Class | Resolution |
|---|---|---|---|
| `CHANGES.md` | 2 | `THEIRS-THEN-READD` | Upstream's release notes win; the fork's entries re-append. Mechanical. |
| `ThirdParty.json` | 2 | `THEIRS-THEN-READD` | Upstream's manifest wins; fork additions re-append. Mechanical. |
| `.gitignore` | 1 | `MANUAL` | Trivial: re-append the fork's ignore block after upstream drops its `GoogleConfig.json` line, which the fork's own `cla.yml` does not reference. |
| `package.json` (root) | 3 | `MANUAL` | **Not mechanical.** See 6.2. |
| `packages/engine/package.json` | 1 | `MANUAL` | Small: version move plus fork script retention. |
| `packages/widgets/package.json` | 1 | `MANUAL` | Small: as above. |
| `.github/workflows/dev.yml` | 1 | `MANUAL` | Fork changed 117 lines to upstream's 18. Take upstream's `setup-node@v7` and the `sg` → `ast-grep` rename; re-add the fork's `guards` and `variants` jobs. |

### 6.2 The must-survive lines — and the ones actually at risk

**The three fork-only devDependencies inside conflict hunk 1 are the real exposure**, and an earlier
draft of this plan missed them by guarding only the `sideEffects` entry. Verified against the three
merge stages:

| Line | fork | upstream | merge-base | In a conflict hunk? |
|---|---|---|---|---|
| `"@eslint/js"` | 1 | **0** | 0 | **yes — hunk 1** |
| `"eslint-config-prettier"` | 1 | **0** | 0 | **yes — hunk 1** |
| `"eslint-plugin-n"` | 1 | **0** | 0 | **yes — hunk 1** |
| `"sideEffects": [… "./Source/Cesium*.js" …]` | present | untouched | present | **no — outside every conflict region** |

**A `--theirs` on hunk 1 deletes all three devDependencies**, because upstream simply does not have
them. The `sideEffects` entry is still load-bearing — without it, bundlers tree-shake the
`setGlobalDefaultRenderer()` call out of the variant entry barrels and the default-renderer hint
silently disappears — but it sits outside the conflict, so it is at materially lower risk than the
three lines above.

**Nothing in the verification plan re-checks any of the four** — see 7.2 gap 1. A `grep` for all four
literals belongs in the landing checklist for this file.

**Do not "re-add" the fork's `sg` form.** `sg-scan` → `ast-grep scan` and `@ast-grep/cli` → `^0.45.1`
auto-merge correctly; a resolver pattern-matching on "restore the fork's version" would undo a
correct rename.

### 6.3 Dependency bumps and the Playwright exposure

Verified against the real diffs: root `1.144.0 → 1.145.0`, `@cesium/engine 26.2 → 26.3`,
`@cesium/widgets 16.1.1 → 16.2.0`, `protobufjs 8.6.5 → 8.8.0`, `@ast-grep/cli 0.44 → 0.45.1`,
`@playwright/test 1.59.1 → 1.62.1`.

**Playwright exposure: LOW, with one caveat.** The fleet uses only foundational, stable
`playwright-core` APIs — `chromium.launch({ channel: "msedge", ... })`, `page.goto`/`evaluate`,
`locator().screenshot()`, `context.route`, `browser.close()`. None sit on Playwright's deprecation
cadence, and Edge channel resolution is unaffected. The exposure is nonetheless marked
**`UNVERIFIED` offline** — the check that settles it is a before/after receipt-hash diff on an
already-migrated probe, and it should be run rather than reasoned about.

**Fleet-consolidation caveat worth surfacing separately:** of roughly 975 probes, only five run on
the shared `probe-runtime.mjs`. A Playwright behaviour change would therefore have ~970 independent
blast sites rather than one. That is a pre-existing DX condition, not something the sync creates, but
the sync is the event that would expose it — and it is exactly what Wave DX's `DX-06` fleet
deduplication exists to fix. Worth the maintainer knowing that landing `DX-06` before the next sync
would materially reduce that surface.

**Pre-existing drift found in the lane clone:** `node_modules` already carries Playwright **1.62.1**
while `package.json` still declares `^1.59.1`, and no lockfile is committed. Not caused by the dry
run, but it means this clone cannot smoke-test the 1.59 → 1.62 boundary without a clean reinstall
first. Whoever runs 7.1 stage 3 should reinstall deliberately rather than trust the tree.

### 6.4 Widgets and Sandcastle

Upstream changed 48 files under `packages/widgets/Source` and 29 under `packages/sandcastle`;
**none conflicted** except the two `package.json` files, because the fork barely touches either tree.

The five new gallery demos (`3d-tiles-3d-native-vector`, `3d-tiles-property-lod-river`,
`aec-snapping`, `hybrid-snapping-dev`, `ion-snapping-dev`) match the fork's folder convention
exactly (`index.html` + `main.js` + `sandcastle.yaml` + `thumbnail.jpg`) and auto-merged clean. They
are **upstream-authored and not WebGPU-aware**, so the Sandcastle2 sweep must actually prove they
run under `--renderer=webgpu` rather than assume it.

### 6.5 Two maintainer decisions, not merge details

Both are flagged rather than absorbed:

1. **Sandcastle analytics.** 1.145 adds `packages/sandcastle/src/analytics/` (Amplitude telemetry)
   and a `.env.example`. It is disabled by default with an empty API key, but it is real third-party
   telemetry code landing in a private fork. Take it, strip it, or stub it — a maintainer call.
2. **The CLA rotation workflow.** 1.145 adds `.github/workflows/cla-rotation-reminder.yml`, which
   reminds about rotating `MICROSOFT_GRAPH_INFO_JSON` — a credential the fork's Google-Sheets-based
   `cla.yml` does not use. Recommendation: do not take it, or take it with the `schedule:` trigger
   stripped so it cannot fire on a private fork's schedule.

---

## 7. Post-merge verification

Full table with per-stage "what it proves" and expected green shape:
`_lane-out/HALLACAR_TOOLCHAIN_AND_VERIFICATION.md` Part 2. Every command below was verified to
**exist** against `package.json` scripts and the files on disk.

**Existence is not runnability, and the distinction cost this plan one defect.** Stage 8's
`npm run wave-end-gate` exists and would have exited on a usage error; the review caught it (see the
stage-8 note below). Treat the table as a verified inventory of *commands*, not as a rehearsal — the
first execution of any stage should be watched, not assumed.

### 7.1 The stages, in order

| # | Stage | Command | Blocking |
|---|---|---|---|
| 1 | Build | `npx gulp build` | Yes — gates everything |
| 1b | Types (root) | `npx tsc --noEmit` | Yes |
| 1c | Types (engine) | `npm run tsc-engine` | Yes, **after** stage 1 (an unbuilt tree fails with a wall of TS2307) |
| 2a–2k | Karma specs, per subsystem | `$env:CHROME_BIN="<msedge.exe>"; npx gulp test --includeName <Name> --browsers=EdgeHeadlessCI` for `ClippingPolygonCollection`, `ModelClippingPolygonsPipelineStage`, `GeoJsonPrimitive`, `Cesium3DTileset`, `Model`, `Scene`, `PrimitiveCollection`, `Buffer*Collection`, `Snapping`, `CreditDisplay`, `PostProcessStage`, `ShaderBuilder`, `UniformState`, `VectorPipeline`; plus `npm run test-webgpu-policy` | Yes |
| 3 | Variant smoke | `node Tools/variant-smoke-test.mjs` (all three variants) | Yes |
| 4 | Visual regression | `node Tools/visual-regression/capture-and-diff.mjs` — **never `--update`** | Yes |
| 5 | Sandcastle2 sweep | `node Tools/visual-regression/sandcastle-smoke.mjs --sandcastle2` then `... --renderer=webgl`; scope the first run to the five new demos with `--ids=` | Yes |
| 6a–6g | Subsystem + RTE probes | `probe-globe-clippoly-geodetic`, `probe-bufferpolygon-vector-tile`, `probe-vector3dtile-vctr`, `probe-model-tangentgen`, `probe-pick-basic`, `probe-post-process`, `probe-collections-far-camera`, `probe-ellipsoid-rte` | Yes |
| ~~7b~~ | ~~`S3` discriminator re-run~~ | ~~`probe-eclipse-cloud-response.mjs --exposure-sweep`~~ | **REMOVED — see §7.3** |
| 8 | Wave-end gate | `npm run wave-end-gate -- --wave <id>` | Yes — the closing bar, run last |

**Stage 8 needs its `--wave` argument.** `Tools/wave-end-gate.mjs` refuses with
`--wave <id> is required.` when the flag is absent, and the npm script is a bare
`node Tools/wave-end-gate.mjs` — so `npm run wave-end-gate` on its own exits on a usage error rather
than running the closing bar. The `--` is required to pass the flag through npm.

**Karma requires Edge.** `CHROME_BIN` must point at `msedge.exe`; Chrome is not installed. A
`--includeName` that matches nothing exits 3 (`IncludeNameZeroMatchError`) — treat that as a failure,
not a pass.

**Baselines are not refreshed by the sync.** Stage 4 runs without `--update`. If an upstream-driven
rendering change genuinely moves a baseline, that refresh is its own separately reviewed commit.

**Stage 7a — `G1`'s two WGSL twins — has no runnable command, and that is the honest finding. It is
therefore explicitly OUT OF SCOPE for `UPSTREAM-SYNC-1.145-06`'s "every stage green" acceptance**,
which is scoped to stages 1–6 and 8; a row cannot be gated on a command that does not exist.
Clipping-polygon holes in the SDF atlas and polygon draping onto the shared classification depth
target are new upstream features with no WebGPU port. `scenes.json`'s ten scenes contain no
clipping, polygon or drape entry, so **the sync's own headline features are not covered by the
visual-regression stage at all**. Building those scenes is part of `G1`'s deliverable, not something
this plan can run today. This is not blocking for the sync landing — WebGL-only parity immediately
post-merge is expected — but it is blocking for closing `G1`, and it should not be discovered later.

### 7.2 What a wrong merge would look like, and what fails to catch it

Five silent-failure modes, with an honest verdict on coverage. The gaps are the most useful part of
this section.

1. **The `sideEffects` array loses `"./Source/Cesium*.js"`** during JSON conflict resolution.
   *Caught by:* **nothing automated.** `gulp build` still succeeds (the entry is bundler metadata),
   and variant smoke only fails if a downstream bundler actually tree-shakes the call. **Gap —**
   add an explicit grep or a small `node --test` assertion to the landing checklist.
2. **`ClippingPolygonCollection`'s new freeze-on-mutate throws for a fork WebGPU caller** that
   mutates `polygon.positions[i]` in place. *Caught by:* stage 2a only if upstream's spec covers it;
   **not** by typecheck, since these are plain `.js` files and the failure is at runtime. **Gap —**
   a targeted grep for in-place position mutation in `WebGPUClippingPolygonCollection.ts` belongs in
   the `G1` landing.
3. **`dev.yml` action versions bumped inconsistently** — upstream's four jobs move to `@v7` while the
   fork's `guards`/`variants` jobs stay at `@v6`. *Caught by:* **nothing** — no local stage reads CI
   workflow files. **Gap —** human review of the final `dev.yml` across all six jobs.
4. **`MVTDataProvider.js` silently drops or mis-wires the new `heightReference` option.** It is
   both-sides-changed, **auto-merged** (so nobody is forced to read the result), and has **zero
   class-level Karma coverage** — only `buildVectorGltfFromMVTSpec` and `decodeMVTSpec` exist, which
   test decode helpers, not the class. *Caught by:* stage 6b's probe **only if** its `sample-us-states`
   scene exercises `heightReference`, which is **`UNVERIFIED`**. **This is the sharpest gap in the
   plan:** real new API surface, on an auto-merged file, with no spec and a maybe-adequate probe.
   Check whether the probe exercises `heightReference` before landing; if not, extend it or write
   `MVTDataProviderSpec.js` as part of this work, not as a someday item.
5. **The Sandcastle2 `App.tsx` auto-merge breaks where `RendererToggle` mounts**, with no textual
   conflict. *Caught by:* stage 5 **only partially** — if the toggle fails to render, the app may
   still boot on its default renderer and every demo still satisfies the renderer gate for that one
   default, never proving the other path. **Gap —** after stage 5's scoped run, visually confirm the
   toggle is present and clickable, rather than trusting a gate a broken toggle can satisfy.

### 7.3 An adjudication: the `S3` re-run is NOT a gate on this sync

Two of this lane's workers disagreed about stage 7b, and the disagreement is worth recording in full
because it is the plan's clearest instance of Principle 10 doing its job.

**The premise handed to the lane** (from `RENDERER_LANDSCAPE_AUDIT_2026-09-02.md:334`, `G1`):

> "The draping row shares the C13-41 / C12-29 S3 depth target, so the reopened S3 discriminator
> (`R-2026-09-02-5`) must be re-run after the sync."

**What re-derivation found.** `C12-29` S3 is `NEW-ECLIPSE-OCCLUSION-EFFECTS`
(`QUEUE_2026-07-19_CAMPAIGN12.md:36`) — eclipse occlusion and shadow contrast. `R-2026-09-02-5` funds
its **exit-condition-2 exposure-sweep discriminator**, a shadow-contrast measurement. **Neither is a
classification depth target, and neither has any relationship to polygon draping.**

**How the lane reached it.** The toolchain worker took the audit's claim at face value and dutifully
located a real runner for it. The clipping/vector analyst, reading the S3 definition itself, refuted
the linkage. The globe analyst, independently, recorded that he could not resolve the audit's "S3"
reference from inside the repo at all and marked it `UNCERTAIN` rather than guessing. **Two
independent failures to confirm, and one active refutation.**

**Adjudication: the claim is REFUTED and stage 7b is removed from the verification plan.** Running
an eclipse shadow-contrast sweep would not test anything this sync touches; it would consume an Edge
leg and produce a green tick that certifies nothing about the merge. A gate that cannot fail for the
right reason is worse than no gate, because it looks like coverage.

**Two consequences beyond this plan:**

1. `RENDERER_LANDSCAPE_AUDIT_2026-09-02.md:334` and the `RL-01` row at `:443` both carry the
   unsupported gating claim. They should be corrected — but that is the landscape audit's own
   document to fix, and this plan has no authority to move it. Flagged for the maintainer.
2. **`G1`'s remedy is also stale, and materially so.** `G1` prescribes "clipping-polygon holes in the
   SDF atlas". 1.145 added holes to the **vector** path and **deleted** the SDF one — so the
   prescribed remedy targets an algorithm that no longer exists upstream. `RL-01a` should be
   re-scoped from "SDF-atlas holes" to "WGSL twin of `vectorClip`", at which point it **merges with
   `RL-01b`**, since both need the same polygon tables (§5.2.2). That is one row where the audit says
   two, and it is blocked on the same already-open `NEW-WEBGPU-VECTOR-POLYGON-DRAPING`.

The `S3` discriminator remains live work under its own ruling. It is simply not this sync's business,
and the sync must not be gated on it.
---

## 8. The landing sequence

### 8.0 A correction to the batch model, stated first because everything below depends on it

The lane brief asked for "resolution batches per cluster with their gates". **Git does not permit
that shape.** A merge commit is atomic: `git commit` refuses while any path is unresolved, so there
is no way to land cluster (a)'s resolution as one commit and leave clusters (b)–(d) conflicted for a
later one. All 32 conflicts resolve into **one merge commit** or none of them do.

The workable shape preserves the *review* granularity the brief wanted without pretending the
commits can be split:

- **Per-cluster review happens in the working tree, before the commit.** Each cluster's resolution
  is staged and reviewed against its §5 analysis by a reviewer who did not write it. The merge is
  committed only once all four clusters plus the toolchain set have passed review.
- **Everything separable moves out of the merge commit** into ordinary squash commits on top: the
  WGSL parity twins, the deferred design work, the new guard, baseline refreshes. That is where the
  per-batch discipline lives.

Two consequences worth stating plainly. First, the merge commit will be large, and that is correct,
not a landing-hygiene failure — the sync is the one sanctioned merge commit (§1.1) and squashing it
would corrupt the next sync's merge-base. Second, because the commit is atomic, **anything the merge
breaks must be fixed inside it**, not deferred. §5.4's `UniformState` × `AutomaticUniforms` coupling
is exactly such an item: `AutomaticUniforms.js` auto-merges into a broken state, so its fix is not
optional follow-up work.

### 8.1 Batch 0 — preflight, before the window opens

Local-only; no commits, so it may run during quiet hours.

1. **Branch inventory and transparency.** `git branch -a`; report every branch besides `main` and
   its remote tracker to the maintainer before starting, per CLAUDE.md's branch-transparency rule.
2. **Executor check.** Confirm no Edge tranche is running. Landing engine changes under a live
   tranche voids its source-identity preflight — this is a recorded prior defect, and the sync is
   the largest engine landing the fork will do this quarter.
3. **Baseline green at `01226c648a`.** `npx gulp build`, `npx tsc --noEmit`, and a
   `capture-and-diff` run banked the same day, so the post-merge comparison has a same-day
   reference rather than an aged baseline.
4. **Capacity preflight** per the handoff procedure, and confirm the lane's dry-run artifacts are
   repatriated (§2.3).

### 8.2 Batch 1 — the safety branch and the merge commit

Run in a single window, weekend, Edge executor free.

1. **Safety branch, with its deletion plan stated upfront:**
   `git branch pre-upstream-merge-1.145-2026-09-05 main`. It is a rollback ref only; it is deleted
   once the merge has landed on `main` and the §7 verification is green, and the maintainer is told
   at both ends.
2. `git fetch upstream main` and re-confirm the divergence numbers still read 358/1783 against
   `73c2eeec0c`. If upstream has moved, the census is stale — re-run the dry run rather than
   proceeding on this document's numbers.
3. `git merge upstream/main --no-edit` → 32 conflicts.
4. **Resolve, cluster by cluster, in the working tree**, each per its §5 analysis:
   - **(d) renderer core first** — it contains the one item that cannot be deferred
     (`UniformState` × `AutomaticUniforms`) and two of its files are trivial warm-ups that exercise
     the `PORT-INTO-CLASS` procedure where a mistake is cheap.
   - **(a) globe** — the `GlobeSurfaceShaderSet` key-bit work is the highest-severity single
     resolution and wants a fresh reviewer.
   - **(b) clipping + vector** — the largest cluster, and the only one carrying a
     drop-fork-code decision.
   - **(c) tiles + models** — largest hunk count but almost entirely structural.
   - **toolchain/widgets/Sandcastle** — mechanical; the three `package.json` files are not.
5. **After each cluster, run the §3.3 shape guard** over that cluster's `PORT-INTO-CLASS` files.
   Catching a silent class reversion at cluster granularity is far cheaper than finding it after
   the commit.
6. **Per-cluster review** by someone who did not write the resolution, against the §5 analysis. A
   spec written from the same brief as the fix is not an independent check.

   **The per-cluster gate is a grep and a reading — not a behaviour leg, and reviewers must not wait
   for one.** No probe or spec can run against a partially-resolved tree: the tree does not build
   until every conflict is resolved, so `gulp build`, the Karma suites and every probe arrive only at
   §7, after the whole merge compiles. A cluster reviewer's evidence is the shape guard, the §5
   analysis, and the diff — that is the most that exists at that point, and it is the reason §7 is
   heavy.
7. `npx gulp build` then `npx tsc --noEmit` **before committing** — a new `Source` leaf breaks the
   generated barrel, and 1.145 adds **ten** engine `Source` files: six for a new Ion-backed snapping
   service (`Core/SnapService.js`, `Core/IonSnapService.js` and four `IonSnap*` enums), the
   `Model/ModelVectorLookupPipelineStage.js` stage with its two GLSL shaders, and the
   `eyeToCartographicDelta.glsl` builtin. The six snapping files are an entire new upstream feature
   arriving with the sync, not a refactor — §5.4 D-3's snap work must be read against them.
8. **Commit, and verify the two-parent shape:** `git cat-file -p HEAD` must show two `parent` lines,
   `01226c648a` and `73c2eeec0c`. This is the procedure's explicit acceptance and the thing that
   makes the next sync's merge-base correct.

### 8.3 Batch 2 — post-merge verification

The full §7 plan, run by an Edge executor, before any push. Nothing here changes code; a red result
sends the work back to Batch 1's working tree, which is why the safety branch still exists.

### 8.4 Batch 3 — the push

`git push origin main --force-with-lease`, outside quiet hours. Then delete the safety branch and
tell the maintainer, per the branch-transparency rule's finish-a-package obligation.

### 8.5 Batches 4+ — the follow-ups the sync opens

Ordinary squash commits, each its own reviewed batch, in this order:

1. **The parity twins** the merge creates — the WGSL side of every new upstream GLSL feature. These
   are Principle 5 obligations and Principle 9 says they are named as concrete next work, not
   absorbed silently.
2. **The design-gated item** — the snap `surfacePosition` question (§5.4 D-3), which needs a
   measurement before code.
3. **The shape guard** (§3.3), if not landed with the merge.
4. **Baseline refreshes.** Per the wave-end gate ruling, visual-regression baselines are **not**
   refreshed by the sync batch; each refresh is its own deliberately reviewed commit.

### 8.6 Window recommendation

**Saturday 2026-09-05, with Sunday 2026-09-06 as the fallback.**

The reasoning: today is **Friday 2026-09-04, 11:29 EDT**, inside the weekday 07:00–19:00 ET quiet
window, so nothing lands today regardless. Friday after 19:00 ET is *permitted* but is a poor fit —
the resolution pass plus the wave-end gate plus the parity probes is a long sitting, and starting it
at 19:00 on a Friday risks the verification half running tired or, worse, being deferred to the next
day with a merge commit already made. Weekends are unrestricted end to end, which lets Batch 1 and
Batch 2 run in one continuous session with the Edge executor free — which the maintainer has already
said is the intent.

**The window must hold both the resolution and the verification.** Committing the merge and
verifying it the following day means `main` carries an unverified 164-file merge across a boundary
where the Edge executor may be re-tasked. If only half a window is available, do neither half.
---

### 8.7 A governance change this plan cannot make itself

§3.1 establishes that CLAUDE.md's Upstream Sync Procedure step 5 — "prefer `git checkout --theirs`
then re-add WebGPU code" — is wrong for 13 files and would silently revert their ES6 class
conversion. **That correction currently lives only here and in a row's "Ruling touched" note, and the
next sync's session will read CLAUDE.md, not this plan.** Left as-is, the trap re-arms for 1.146.

Amending CLAUDE.md is a **maintainer governance change, outside this plan's authority**, and this
lane does not edit it. **The seat is queueing that amendment separately.** Two related asymmetries
belong in the same amendment if it is made:

- **No add-only rule exists for the WebGL globe shader-variant key**, though CLAUDE.md mandates
  exactly that for the WebGPU `ShaderDefine` registry ("Add-only. Never reorder, renumber, or
  remove"). That asymmetry is what permitted bit 33's renumbering (§5.1).
- The procedure's "then re-add WebGPU code" phrasing assumes the only fork content at risk is WebGPU
  code. §3.1 and §6.2 both show otherwise — an ES6 class shape and three ESLint devDependencies are
  neither.

## 9. Queue rows — the `UPSTREAM-SYNC-1.145-*` family

These are the rows this plan opens in
[`QUEUE_2026-08-29_RESEARCH_DISPATCH.md`](QUEUE_2026-08-29_RESEARCH_DISPATCH.md), in that
document's §0.3 row-card format. **Status lives in the queue, not here.** They are reproduced in
this section only so the plan is readable standalone; on any disagreement the queue row wins.

Wave placement per §0.4: `-00`..`-05` are **Wave 1** — the sync is ruling-free engine work whose
only blocker is a *window*, not an authoring or evidence question. `-06` is Wave 1 (it is the
sync's own acceptance). `-07` and `-08` are **Wave 2**: each needs the merge to exist first.

### `UPSTREAM-SYNC-1.145-00` — the merge commit and the `PORT-INTO-CLASS` resolution pass

- **Disposition:** OPEN. Execute the plan's §8.2: safety branch, `git merge upstream/main --no-edit`, resolve all 32 conflicts cluster by cluster per §5, build + typecheck, commit, verify two parents. This row owns the merge commit itself and therefore also owns every resolution — §8.0 explains why the resolutions cannot be separate commits. The `UniformState` × `AutomaticUniforms` fix (§5.4 D-1) is **inside this row**, not a follow-up: the auto-merged file is broken until it lands.
- **Tier / Size / Backends:** OPUS-JUDGMENT · XL · both. **Depends on:** an open window with the Edge executor free (§8.6). **Ruling touched:** invokes CLAUDE.md's Upstream Sync Procedure and its one sanctioned merge commit; amends its step-5 `--theirs` default per §3.1. **Gate:** none — the sync is ruling-free; it needs a window, not a decision.
- **Acceptance:** `git cat-file -p HEAD` shows two parents, `01226c648a` and `73c2eeec0c`; `npx gulp build` and `npx tsc --noEmit` green; the §3.3 shape guard reports zero files that were ES6 classes at `01226c648a` and are prototype-based after; `czm_eyeCartographic` and `czm_eyeToEnu` resolve to defined values through the automatic-uniform path.
- **Binds:** SR-1. **Source:** `UPSTREAM_SYNC_PLAN_1.145_2026-09-04.md` §2, §3, §8.

### `UPSTREAM-SYNC-1.145-01` — globe cluster resolution review

- **Disposition:** OPEN. Review gate on `-00`'s globe resolution: the `GlobeSurfaceShaderSet` shader-key bit assignment and `GlobeSurfaceTileProvider`'s seven hunks, against §5.1. Highest-severity single resolution in the sync because a shader-cache key collision serves the wrong shader with nothing thrown and no spec failing.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both (WebGL primarily). **Depends on:** `-00` resolution staged. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** the post-merge bit map is stated and every bit has exactly one meaning; the globe renders identically to the pre-merge baseline on both backends at the capture set; a negative control shows the guard fires if two variants are given the same key.
- **Binds:** SR-1. **Source:** plan §5.1.

### `UPSTREAM-SYNC-1.145-02` — clipping polygons and vector pipeline; the `UP-1` disposition

- **Disposition:** OPEN. The sync's largest cost centre. Owns the drop/keep/rework decision on the fork's WebGPU clipping-polygon backend now that 1.145 has deleted the three signed-distance shaders its WebGL twin was ported from (§2.1), plus the `pack*CollectionData` contract change and the drape-binding move. Principle 7 applies: fork WebGPU code is not droppable merely because its upstream WebGL twin died — the disposition comes from the ledger, not from the deletion.
- **Tier / Size / Backends:** OPUS-JUDGMENT · L · both. **Depends on:** `-00` resolution staged. **Ruling touched:** may require a maintainer decision if the disposition is DROP — see §5.2. **Gate:** none for KEEP or REWORK; a DROP of shipped fork functionality is a maintainer call.
- **Acceptance:** clipping-polygon rendering unchanged on both backends at the capture set; every fork call site of the changed pack signature passes the new parameter type; the `G1` WGSL twins re-verified.
- **Binds:** SR-1. **Source:** plan §5.2.

### `UPSTREAM-SYNC-1.145-03` — tiles and models resolution review, incl. the auto-merged set

- **Disposition:** OPEN. Review gate on `-00`'s tiles/models resolution. Its conflicted set is almost entirely structural, so the substantive risk sits in the **auto-merged** files in the same subsystem — `GltfLoader.js`, `Model3DTileContent.js`, `EdgeVisibilityPipelineStage.js`, `PickingPipelineStage.js` — all RTE-heavy paths where a clean textual merge can still be a contract break.
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both. **Depends on:** `-00` resolution staged. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** RTE precision unchanged — the far-camera probes show no new drift; tileset and model rendering unchanged at the capture set on both backends; every `AUTO-VERIFY` row in §4's Section B is discharged with a named check.
- **Binds:** SR-1. **Source:** plan §5.3, §4.

### `UPSTREAM-SYNC-1.145-04` — renderer core: `ContextLimits` layering and the snap contract

- **Disposition:** OPEN. Review gate on `-00`'s renderer-core resolution. Two named items: 1.145 introduces the fork's **only** Scene-layer `ContextLimits` reader, which must be re-sourced to `context.limits` because a process-global limit is wrong under multi-context (§5.4 D-2); and `SceneSnapResult.surfacePosition` arrives implemented as a second synchronous readback, which the fork's WebGPU snap path cannot do (§5.4 D-3).
- **Tier / Size / Backends:** OPUS-JUDGMENT · M · both. **Depends on:** `-00` resolution staged. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** zero `ContextLimits` readers outside `packages/engine/Source/Renderer/`; the selected-feature-id texture clamps against the owning context's limit under split-screen; an edge snap costs no more readbacks on WebGPU than a non-edge snap.
- **Binds:** SR-1. **Source:** plan §5.4.

### `UPSTREAM-SYNC-1.145-05` — toolchain, widgets, Sandcastle, and the Playwright bump

- **Disposition:** OPEN. The seven non-engine conflicts, the dependency moves, and the `@playwright/test 1.59.1 → 1.62.1` bump against the probe fleet and the Edge executor's runtime. **The at-risk lines are the three fork-only devDependencies inside `package.json` conflict hunk 1 — `@eslint/js`, `eslint-config-prettier`, `eslint-plugin-n` — which a `--theirs` deletes; the `sideEffects` entry is also must-survive but sits outside every conflict region (§6.2).** Do not "re-add" the fork's `sg` form. Carries one maintainer decision that must not be absorbed silently: 1.145 adds a Sandcastle analytics module and a `.env.example`, i.e. upstream telemetry arriving in a private fork.
- **Tier / Size / Backends:** SONNET-BOUNDED · M · tooling. **Second dispatch:** OPUS-JUDGMENT · S · tooling — the Playwright 1.59 → 1.62 exposure analysis and the probe-fleet smoke that settles it. **Depends on:** `-00`. **Ruling touched:** none. **Gate:** the analytics/telemetry decision is a maintainer call.
- **Acceptance:** the probe fleet runs green on 1.62.1 under Edge with no API deprecation warnings; `node Tools/variant-smoke-test.mjs` green on all three variants; all three devDependencies and the `sideEffects` entry present post-merge; the telemetry decision recorded either way.
- **Binds:** SR-1. **Source:** plan §6.

### `UPSTREAM-SYNC-1.145-06` — post-merge verification and the wave-end gate

- **Disposition:** OPEN. Run §7 stages 1–6 and 8 before the push: build, both typechecks, the spec suites for every touched subsystem, variant smoke, capture-and-diff, the Sandcastle2 sweep on both renderers, and the subsystem and RTE probes; then the wave-end gate — **`npm run wave-end-gate -- --wave <id>`; the bare form refuses (§7.1 stage 8)** — by an Edge executor, banked under `Tools/visual-regression/output/wave-end/`. **The `S3` discriminator is NOT part of this row** — §7.3 adjudicates that gating claim REFUTED; do not spend an Edge leg on it. **Visual-regression baselines are not refreshed by this row**; each refresh is its own reviewed commit.
- **Tier / Size / Backends:** OPUS-EDGE-EXECUTOR · L · both. **Depends on:** `-00`..`-05`. **Ruling touched:** executes the wave-end gate ruling. **Gate:** none.
- **Acceptance:** every §7 stage green with its receipt banked, **excepting stage 7a (`G1`'s two WGSL twins), explicitly out of scope — it has no runnable command because the scenes do not exist yet, and building them is `G1`'s own deliverable**. A red stage returns the work to `-00`'s working tree rather than being waived.
- **Binds:** SR-1, SR-11 (evidence repatriation). **Source:** plan §7.

### `UPSTREAM-SYNC-1.145-07` — the WGSL parity twins the sync opens

- **Disposition:** OPEN. 1.145 adds GLSL-side features with no WebGPU equivalent — at minimum the `czm_eyeCartographic` / `czm_eyeToEnu` uniform pair and the `eyeToCartographicDelta` builtin that consumes them, plus any new pipeline stage §5.3 identifies. Principle 5 makes the twin an obligation and Principle 9 makes it a named next work item rather than a silent gap. This row exists so the sync does not quietly ship WebGL-only features.
- **Tier / Size / Backends:** OPUS-JUDGMENT (shader, parity) · M · WebGPU. **Depends on:** `-00` landed. **Ruling touched:** none. **Gate:** none.
- **Acceptance:** the WGSL `CameraUniforms` carries the ENU basis and cartographic eye **with `previousViewProjection` still at the tail of the struct** (CLAUDE.md pins that field's position — the new members go ahead of it, never after); a probe shows a shader consuming them producing matching output on both backends; `FEATURE_INVENTORY.md` updated so the entry moves rather than the inventory going stale.
- **Binds:** SR-1. **Source:** plan §5.4 D-1, §5.3.

### `UPSTREAM-SYNC-1.145-08` — the ES6-shape guard

- **Disposition:** OPEN. Land the §3.3 assertion: no file that was an ES6 class at the pre-merge tip may be prototype-based afterwards. One check, and it catches the entire silent-reversion class that §3 identified as the sync's dominant conflict mechanism. Valuable beyond this sync — every future upstream merge faces the same shape mismatch, and it will get worse as the fork converts more files.
- **Tier / Size / Backends:** SONNET-BOUNDED · S · tooling. **Depends on:** `-00` landed (it needs the merge to test against). **Ruling touched:** none. **Gate:** none — but note it needs a runner home; a spec with no runner home is a review blocker.
- **Acceptance:** the guard fails on a fixture where a class file is replaced by its prototype-based ancestor, and passes on the real post-merge tree; it is wired into an existing `npm run` target rather than left orphaned.
- **Binds:** SR-12. **Source:** plan §3.3.

---

## 10. What this plan does **not** decide

Stated so the reader does not mistake analysis for authority:

- **This document did not land the merge itself** — it produced the census and per-hunk plan; the
  sync landed separately at Batch 1408 (`ffb8161c083b29df0d3a301496ad5f4bc80e6c27`; verified
  2026-09-05: parents `40341305f4` / `488b114e16`, `git merge-base --is-ancestor 488b114e16 HEAD`
  exit 0, `package.json` version `1.145.0`). The dry-run lane clone this plan is based on ended
  clean at `01226c648a` and was not itself the landing.
- **It does not move any status authority.** Campaign status stays in `CAMPAIGN_STATE.md`; row
  status stays in the queue. This document is a plan and a census.
- **It does not decide the `UP-1` disposition** where that means deleting shipped fork
  functionality — §5.2 states the evidence and the recommendation; a DROP is a maintainer call.
- **It does not decide the Sandcastle telemetry question** (§6) — upstream analytics arriving in a
  private fork is a maintainer call, not a merge-resolution detail.
- **It does not refresh any visual-regression baseline**, and `-06` is explicitly forbidden from
  doing so.
