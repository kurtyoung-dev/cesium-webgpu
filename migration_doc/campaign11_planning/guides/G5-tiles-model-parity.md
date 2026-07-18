# Campaign-11 Cluster Guide G5 — `tiles-model-parity` (21) + `splat` (2) + fresh Batch-699 trio (3)

**Anchors verified 2026-07-18 against committed HEAD `5b98ab9698` (Batch 699,
C10-02-TILES-STYLE-COMMAND-ECONOMICS).** The working tree is being edited by concurrent C10
workers; every anchor below was checked against files that are clean in `git status` at guide
time, but a C11 worker MUST re-grep each anchor by symbol at intake (line numbers are hints,
symbols are the contract). Register base: `scratchpad/c11/C11_CANDIDATE_REGISTER.md` cluster 12
(swept at `aef553d592` = B698) — **the three fresh Batch-699 findings are NOT in the register
table**; their canonical source entries are `migration_doc/DEFERRED_WORK.md:5424-5490`, written
by the B699 landing. This guide covers 26 items: the 21 register rows of cluster 12, the 3 fresh
B699 items, and the 2 rows of cluster 3 (`splat`).

**Charter constants that bind every item here (never weaken):** no feature removal / default-off
/ visual degradation for a metric; Rule-3 conservatism (unknown demand stays conservative);
probe-first (Principle 8 — reproduce in a `Tools/visual-regression/probe-*.mjs` BEFORE claiming a
fix); one concern per slice; moving-altitude route only for perf evidence (idle soak invalid);
premise-verify-first — several rows below are proven stale or partially stale at HEAD and are
flagged as such.

**Landed work this cluster must not regress (Batches 683–699):** 1-frustum default (C10-01,
B693-region), demand-driven scene-color resolve (C10-03, B697), revision tokens + execute-closure
hoist (C9-11 partial, B682), model group-1 bind-group caching + O(1) geometry validation
(C9-17 A+B+C, B687/688 — settled group-1 creates 320→0), the translucent-twin
`styleCommandsNeeded` gate (C10-02, B699), shadow single-sweep caster collection (C10-10, B695),
splat prev-buffer revision-skip velocity leg (C10-09, B694-region), model texture mip-chain
unlock (C10-05, B698). Specific interactions are called out per item and in the traps index.

---

## G5.0 — Cluster map, priority order, and sequencing spine

Recommended intake order (dependencies → in parentheses):

1. **Fresh B699 trio** — `NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE` (visible visual
   gap, P1) and `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY` (feature-pick dead on tiles, P1) are
   the cluster's user-visible anchors; `NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS` (P2)
   sequences AFTER pick-empty (it needs a twin pick derivative, and building one while
   tile-content pick is broken verifies against a dead oracle).
2. **Splat producer** — `NEW-WEBGPU-SPLAT-DATA-PRODUCER` (L, maintainer ratification pending);
   `C10-04-SPLAT-ASYNC-SORT` strictly after it.
3. **Model parity fleet** — `WIRE-MODEL-COLOR-ALPHA-SEMANTICS`, `GLTF-POINTS-MODE-RESIDUALS`
   (both well-specified), the silhouette and shader-strategy decision items, the stale-premise
   re-verifies (`NEW-MODEL-SCENE2D-IDL-DUPLICATE`, `C-R1-TILE-BATCH`).
4. **Audits** — FEAT-3DT2-02 / -05 (cheap, unblock production-content claims).
5. **Perf/compute consumer wiring** — Hi-Z granularity, indirect, bundles, FORK-41,
   FEAT-SURVEY-06 — most of these sit behind C9-17 Slice D / S9-3 / FAR-003 sequencing and
   should NOT open early.
6. **P3 dossiers** — Phase-8b TileStoreGPU, GPUExternalTexture (premise partially stale).

---

## G5.1 — Fresh Batch-699 trio

### NEW-WEBGPU-TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE — subset-styled per-feature tint not composited (P1, correctness/parity, M)

#### What + why (evidence trail)

Applying a per-feature translucent color to b3dm batch-table content
(`Cesium3DTileFeature.color = rgba(...,0.4)` → `BatchTexture.setColor`) composites red/green
semi-transparent on WebGL but shows **no visual tint at all** on WebGPU — the styled building
renders in its base opaque material color. Evidence of record (`probe-c10-02-pixel.mjs`, N=700²
frame, requestRenderMode off): WebGL subset redPix=2781 / all greenPix=6853; WebGPU red/green ≈ 0
across unstyled/subset/all with identical RGB. **A/B-confirmed PRE-EXISTING** via the C10-02
`__C10_02_PRE__` in-build toggle (twin-always PRE also shows no tint) — NOT introduced by the
B699 twin gate. Source entry: `DEFERRED_WORK.md:5449-5470`; B699 commit message (git
`5b98ab9698`) files it explicitly for C11 intake.

Why it matters: per-feature styling is THE core 3D Tiles interaction pattern (highlight the
picked building, fade a subset). Today WebGPU silently renders styled tilesets unstyled — a
visible-visual parity break on production content, and it also blinds any future
styling-economics verification (C10-02's twin only proves command COUNTS, not pixels).

#### Architecture today (verified at `5b98ab9698`)

The startling fact a worker must internalize first: **the WGSL composite path already exists and
looks complete.** The DW entry's fix sketch ("wire the per-feature RGBA into the
translucent-class fragment output") is written as if the modulation is missing — it is not. The
gap is upstream of the shader math, in one of the runtime gates. Verified chain:

- Twin emission gate: `WebGPUModelRenderer.ts` `emitTranslucentTwin` (~:6344-6357) —
  `!defined(scn) || scn !== StyleCommandsNeeded.ALL_OPAQUE`, evaluated fresh per frame; twin
  block packs `passClass=1` via `packMaterialUniforms(..., 1)` (~:6387) into a SEPARATE
  `materialBufferTranslucent` UB, then mirrors `FLAG_HAS_INSTANCING` / `featureIdRes.flags`
  (incl. `FLAG_HAS_BATCH_TABLE`) into the flags word at float 28 (~:6411-6424). C10-02 verified
  at landing that the twin DOES emit for the styled case (`styleCommandsNeeded===2/1`,
  translucent command count = 1).
- Batch texture: `WebGPUModelFeatureId.js` `createBatchGPUTexture` (~:273-318) force-creates the
  rgba8unorm batch texture with opaque-white fill(255) (~:295); `updateBatchGPUTexture` (~:359)
  re-uploads on `batchTexture._batchValuesDirty` (~:423-427). C10-02 verified the re-upload DOES
  fire on style change. Bound at group-1 binding 28 (`ModelPBRComplete.wgsl:543`).
- WGSL composite path (`Shaders/WebGPU/Model/ModelPBRComplete.wgsl`, canonical location — the
  root `Source/` twin is build output): main FS ~:3474-3523 —
  `hasFeatureIdSource = FLAG_HAS_FEATURE_ID_TEXTURE || FLAG_HAS_FEATURE_ID_ATTRIBUTE` (:3476-3477);
  if `hasFeatureIdSource && FLAG_HAS_BATCH_TABLE`: `lookupBatchColor(currentFeatureId)`,
  hidden-discard at a<0.004, dual-pass classification against
  `material.tileBatchFlags.x` (passClass; packed at data[176], `WebGPUModelRenderer.ts:1583`)
  with opaqueThreshold 0.998, then `color *= featureColor.rgb` and
  `alpha *= featureColor.a` (:3511-3522). **Else-branch (:3503-3506): batch table WITHOUT a
  feature-id source falls through with featureColor = WHITE — no tint, no discard.**
- Feature-id source flag: `WebGPUModelFeatureId.js` sets `FLAG_HAS_FEATURE_ID_ATTRIBUTE`
  (0x20000) at ~:502-503 only when `selected.isAttribute || selected.isImplicit`; the comment at
  ~:491-493 documents that b3dm hits this path because the glTF loader renames `_BATCHID` →
  `_FEATURE_ID_0`.

#### Root-cause hypothesis fork (diagnose FIRST — do not code from the DW fix sketch)

The observed signature — twin emits, texture uploads, zero tint, AND no per-feature
hidden-discard either — is exactly the :3503 white fall-through. Ranked hypotheses:

- **H1 (most likely): `hasFeatureIdSource` is false at runtime for this content** — the
  selected feature-id record for the b3dm primitive doesn't classify as
  attribute/implicit (e.g. `getSelectedImplicitFeatureId`/the selection helper at
  `WebGPUModelFeatureId.js:54-133` picks nothing for `BatchedWithBatchTable`), so bit 17 never
  sets and BOTH primary and twin render featureColor=white. Predicts: hiding a feature
  (`feature.show=false`) ALSO fails on WebGPU — test this, it's a one-line probe extension and
  discriminates H1 from H3.
- **H2: flags reach the UB but `currentFeatureId` is wrong/zero** (attribute not bound in the
  vertex layout for this content, or the flat interstage featureId0 lane defaults) — predicts
  tint applies to feature 0 only or to nothing, hidden-discard misfires similarly.
- **H3: the twin's pipeline lacks alpha blending** (twin uses the primary's opaque pipeline
  rather than a BLEND variant) — predicts tint WOULD appear opaque rather than not at all;
  inconsistent with "no tint", so demote, but verify the twin's pipeline blend state while in
  there (the twin block reuses the draw-site merged-BG path; the pipeline choice for the
  `Pass.TRANSLUCENT` twin command is worth one assertion).

#### Implementation walkthrough

0. **Premise re-verify (10 min):** run `node Tools/visual-regression/probe-c10-02-pixel.mjs`
   (RENDERER=webgpu MODE=subset) at HEAD; confirm red/green ≈ 0 persists. If tint now appears, a
   concurrent C10/C11 slice fixed it — stop, verify ledger, mark superseded.
1. **Instrument the gate, not the math:** debug-pragma'd one-shot log in the model renderer (or
   read back `primCache.materialDataTranslucent[28*... flags word]`) for the probe's tile
   primitive: does the flags word carry bit 17/16? Does `featureIdRes` classify the `_FEATURE_ID_0`
   attribute? Extend `probe-c10-02-pixel.mjs` with a `feature.show=false` leg (H1 discriminator).
2. **Fix at the source-selection seam** (likely `WebGPUModelFeatureId` selection helper), NOT by
   forcing bits at the pack site — an inline flag-force at :6420 would un-gate the WGSL for
   content with genuinely no feature ids (Principle 9: no inline shortcut).
3. **Re-run the pixel oracle:** WebGPU MODE=subset redPix within a band of WebGL's 2781 (exact
   count differs by AA/blend rounding — assert >0 and within ~30% of WebGL, plus unstyled leg
   still 0 diff); MODE=all greenPix likewise. Read the PNGs (Principle 8.4).
4. **Off-gates:** `probe-c10-02-style-economics.mjs` (twin counts still {1,0}/{2,1} per mode —
   the fix must not change command economics), `probe-model-pbr-audit.mjs`,
   `probe-standalone-model-pick.mjs`, capture-and-diff battery, `npx tsc --noEmit && npx gulp build`.

#### Traps

- **Do not "fix" this in the WGSL** — the composite math at :3511 is already correct and shared
  with the primary's opaque-class classification; editing it risks the unstyled dual-discard
  contract (B699's INV-6) and every non-tile model.
- **B699 twin-gate interaction:** if your fix makes hidden features discard correctly (H1), the
  unstyled `ALL_OPAQUE` suppression still stands — do not touch `emitTranslucentTwin`.
- **B687/688 group-1 caching:** the twin builds its merged group-1 BG per-frame at the draw site
  by design (comment ~:6368-6372); a fix that adds a new texture binding must go through the
  same merged-BG path, not a new group.
- **S11-1 remainder adjacency** (`model-frontend` cluster): the batch-texture force-create at
  :287-297 is that item's target (lazy-create on first style mutation). If S11-1 lands first,
  `FLAG_HAS_BATCH_TABLE` becomes dynamic — your H1 fix must not assume the flag is
  statically present from frame 0. Coordinate sequencing; ideally this item lands first (it makes
  S11-1's dynamic-flip testable in pixels).
- Pick FS uses the same `(pickHasFidTex || pickHasFidAttr)` gate (:3802-3813) — an H1 fix
  changes pick-shader behavior too (per-feature hidden-discard starts working in pick). That is
  parity-correct, but re-run the pick probes and note it in the batch message.

#### Verification recipe

| # | Check | Oracle |
| --- | --- | --- |
| 1 | `probe-c10-02-pixel.mjs` MODE=subset/all/unstyled, both renderers | WebGPU red/green > 0, within band of WebGL; unstyled unchanged |
| 2 | New `feature.show=false` leg (extend probe 1) | hidden feature's pixels absent on BOTH backends |
| 3 | `probe-c10-02-style-economics.mjs` | command counts byte-identical to B699 record |
| 4 | `probe-model-pbr-audit.mjs`, `probe-standalone-model-pick.mjs`, capture-and-diff | unchanged |
| 5 | tsc + gulp build + globe-default diff | clean; ≤0.5%/0.01% band |

**Model tier: fable** (diagnostic fork; the fix is small once H1/H2/H3 resolves, but choosing the
seam is the work). Effort M.

---

### NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY — tile-content feature pick returns nothing (P1, correctness, M)

#### What + why (evidence trail)

`scene.pick` / `scene.drillPick` over rendered b3dm tile content (`BatchedWithBatchTable`)
returns **nothing** on WebGPU while WebGL resolves the `Cesium3DTileFeature` (featureId 4 at the
same pixel). Reproduced with globe on/off, `requestRenderMode=false`; WebGL drillCount=1, WebGPU
full-region scan finds no pick. **Standalone `Model.fromGltfAsync` pick WORKS on WebGPU**
(`probe-standalone-model-pick.mjs` PASS both backends) — the gap is specific to
3D-tile-content feature pick. A/B-confirmed pre-existing (identical PRE↔POST around the B699
gate; the pick derivative rides the always-emitted primary, so C10-02 is pick-neutral). Source:
`DEFERRED_WORK.md:5472-5489`; B699 commit message.

Why it matters: pick on tiles is a headline API (`Cesium3DTileFeature` selection/styling
round-trip). It also gates `NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS` (below) and interacts
with the whole `pick` cluster's fleet work (C10-11/12 outcomes).

#### Architecture today (verified at `5b98ab9698`)

- Per-primitive pick id: `ensurePickId` at `WebGPUModelRenderer.ts` ~:5311-5331, called with
  `allowAllocate = passes.pick || passes.render` and `detail: { model }` (DP-H46e — makes
  `Scene.pickMetadata` resolve). `pickColor = modelPickId?.color` (~:5332) rides material-UB
  floats 40-43 (`packMaterialUniforms` ~:1402-1411).
- Pick derivative: `attachPickToColorCommand(webgpuCmd, pickCmd)` at ~:5900, gated
  `pickColor && !isClassifier` (~:5854-5860). Per-feature pick machinery exists:
  `ensureFeatureIdResources(..., pickPassActive)` (~:5407-5419) → `ensurePerFeaturePickIds`
  (WebGPUModelFeatureId.js; resolution comment ~:729 — "both expose `getFeature(batchId)`").
- Pick FS: `ModelPBRComplete.wgsl` ~:3802-3813 (and hover twin ~:3928-3939) — per-feature
  branch writes per-feature ids only when `(pickHasFidTex || pickHasFidAttr) && FLAG_HAS_BATCH_TABLE`,
  with the batch-table hidden-discard mirrored.
- Existing feature-pick verifier: `Tools/visual-regression/verify-model-feature-pick.mjs`
  (worker: read it — determine whether it exercises glTF EXT_mesh_features only, which would
  explain why this b3dm gap was never caught).

#### Root-cause hypothesis fork

**Note the coupling: this is very plausibly the SAME root cause as the color-composite item.**
If `FLAG_HAS_FEATURE_ID_ATTRIBUTE` never sets for b3dm content (H1 above), the pick FS skips the
per-feature branch and writes the model-level pickColor instead. Then `scene.pick` resolves the
pick-id table entry for the MODEL — and for tile content the resolution may return an object the
Picking layer discards (or maps to nothing the drillPick loop accepts), yielding "no pick".
Ranked:

- **P-H1: shared flag root cause** — per-feature pick branch never taken (couples to composite
  H1). Diagnose both items in ONE instrumented session before slicing fixes; if confirmed, the
  flag fix is one slice and BOTH probes are its oracle (still one concern: the flag).
- **P-H2: pick command never drawn for tile-content models** — `allowPicking`/pick-id
  allocation differs when the Model is constructed by `Model3DTileContent` (e.g. pick-id
  allocation guard, or the tile pass (`tilesetPassState`) not flagged `passes.pick` on the FR
  path). Discriminator: instrument the pick-pass command count for the tile vs the standalone
  model.
- **P-H3: id written but resolution fails** — pick FBO carries a valid id but the pick-object
  table maps it to `{primitive: model, detail:{model}}` and Picking's tile-content translation
  (`Cesium3DTileFeature` construction from `content.getFeature(batchId)`) never runs on the
  WebGPU path. Discriminator: `CesiumDebug`-level readback of the pick FBO pixel (the pick
  probes have a readback pattern) — if a non-zero id is present, it's resolution, not emission.

#### Implementation walkthrough

0. Premise re-verify: `probe-c10-02-pixel.mjs` MODE=subset — WebGPU drillCount still 0.
   Check the C10 ledger for C10-11/C10-12 landings first: **the pick fleet's log-depth
   conversion (C10-11) and depth-plane contract (C10-12) touch the pick FBO producers this item
   reads through** — if W4 landed changes, re-baseline before diagnosing.
1. Read `verify-model-feature-pick.mjs`; extend or clone it into
   **`probe-b3dm-feature-pick.mjs`** (new): loads the same `BatchedWithBatchTable` tileset as
   probe-c10-02-pixel, asserts `scene.pick` → `Cesium3DTileFeature` with the expected featureId
   on both backends, plus a `pickPosition` sanity leg.
2. Run the P-H1/H2/H3 discriminators (shared session with the composite item's step 1 —
   one instrumented build, two diagnoses).
3. Fix at the identified seam. If P-H1: same slice as composite (one flag fix, two oracles). If
   P-H2/H3: own slice; keep the composite fix independent.
4. Oracles: new probe PASS both backends; `probe-standalone-model-pick.mjs`,
   `probe-pick-basic.mjs`, `probe-pick-metadata.mjs`, `probe-pickmodel-instanced.mjs`,
   `verify-model-feature-pick.mjs` unchanged; pick-cluster probes
   (`probe-pickposition-model-webgpu.mjs`) not regressed.

#### Traps

- **Do NOT widen into the pick-fleet log-depth work** (C10-11 owns it). This item is about
  id/feature EMISSION+RESOLUTION, not depth encoding. If your diagnosis lands in depth
  territory (pickPosition converging etc.), you are on the wrong item — that's the pick
  cluster's convergence regression.
- **Async-pick readiness (pick cluster W4 rider):** a false-undefined from a still-compiling
  pick pipeline can mimic this bug in a COLD session. The probe must render ≥120 frames and
  re-pick before concluding "empty" (the B699 evidence did; keep that discipline).
- The hover/precise-pick twin FS (:3928) duplicates the branch — fix both or neither.
- `ensurePickId` allocation is gated on `passes` (~:5310) — offline/probe scenes with
  requestRenderMode quirks can skip allocation frames; `requestRenderMode=false` in the probe.

**Model tier: fable** (multi-way diagnostic across renderer/pick/resolution layers). Effort M.

---

### NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS — twin pick derivative, then suppress the all-discard primary (P2, parity/econ, S–M)

#### What + why

C10-02 shipped INV-3 deliberately PARTIAL: WebGL's `ModelDrawCommand.pushCommands`
(`ModelDrawCommand.js:157-159`, verified) suppresses the opaque primary under
`StyleCommandsNeeded.ALL_TRANSLUCENT`; WebGPU keeps it because the primary carries the
primitive's ONLY pick derivative (`attachPickToColorCommand` ~:5900) — suppressing it would drop
feature pick (INV-5). The residual is one visually-correct all-discard opaque draw per
batch-table primitive in the rare all-translucent case. Source: `DEFERRED_WORK.md:5424-5447`;
the in-code contract comment at `WebGPUModelRenderer.ts` ~:6332-6343 restates it.

#### Architecture today (verified)

Twin emission block ~:6352-6429 (separate `materialBufferTranslucent`, passClass=1, flags
mirror); primary push inside the `!suppressSurfaceForEdgesOnly` region (~:6138-6153 and the
command-emission sites ~:5749-5759); `scn = model.styleCommandsNeeded` read fresh (~:6344).
DW's fix shape (verified against these anchors): hoist the `pickCmd`, attach it to the
translucent twin when suppressing (`attachPickToColorCommand(translucentCmd, pickCmd)`), then
gate the primary push on `!(defined(scn) && scn === ALL_TRANSLUCENT)`; verify T-5 (the twin
already carries `depthForTranslucentClassification` when `classificationType` set) and suppress
the IDL 2D duplicate of the primary alongside.

#### Walkthrough + traps

0. **Hard gate: sequence after `NEW-WEBGPU-B3DM-TILE-CONTENT-PICK-EMPTY`.** The acceptance
   oracle is "pick still resolves on an all-translucent tile" — meaningless while tile-content
   pick is broken at baseline.
1. Probe first: extend `probe-c10-02-pixel.mjs` MODE=all with (a) command-count assertion
   (primary suppressed: tile-content opaque count −1) and (b) a pick assertion on the styled
   building.
2. Implement per the DW sketch. **One concern:** do not fold in the composite fix or any twin
   BG restructuring.
3. Traps: (a) the twin's pick derivative must ride `Pass.TRANSLUCENT` dispatch —
   `WebGPUSceneRenderer.executeWebGPUCommand`→`selectCommandVariant` dispatches per-command, so
   verify the pick pass actually walks translucent commands (if it only walks opaque bins, the
   derivative is dead and the design moves to "pick emission off the surface primary" — the DW
   alternative); (b) INV-6 polarity — `undefined` scn must STILL emit primary+twin (never
   suppress on unknown); (c) edges-only suppression composes (`suppressSurfaceForEdgesOnly`
   already gates both); (d) IDL 2D duplicate — the C-MODEL-2DIDL-DUPLICATE machinery (:4357+)
   duplicates the primary; suppress the duplicate under the same predicate or the IDL side
   renders the phantom.
4. Verify: probe legs above + `probe-c10-02-style-economics.mjs` (counts change ONLY in
   ALL_TRANSLUCENT mode: {2,1}→{1,1}) + pick fleet probes + globe-default band.

**Model tier: opus-or-sol** (well-specified; the one open design point — translucent-bin pick
dispatch — has a written fallback). Effort S–M.

---

## G5.2 — Splat cluster

### NEW-WEBGPU-SPLAT-DATA-PRODUCER — the missing production data producer (P1, feature, L) — **immediately schedulable IF the maintainer ratifies the placement decision**

#### What + why (evidence trail)

The WebGPU Gaussian-splat FR has **no production data producer** — in production it never
receives splat data and never draws. Filed 2026-07-18 as C10-04's STOP-AND-BLOCK #1 verdict with
a fresh repo-wide producer trace (`DEFERRED_WORK.md:23`, the definitive entry; C10 guide H4;
PR §7 S6-1 context; two independent prior notes: Batch 288 "no `_splatData` producer is wired"
and the C10-09 worker note). Until it lands, `WebGPUGaussianSplatRenderer` is
SCAFFOLDED-not-SHIPPED and three landed investments sit dormant on it: B288 log-depth +
sort-consume, and the C10-09 prev-buffer revision-skip velocity leg.

#### Architecture today (verified at `5b98ab9698`)

- `GaussianSplatPrimitive.update` (`packages/engine/Source/Scene/GaussianSplatPrimitive.js`
  :1186-1201): resolves FR readiness; when ready, `fr.update(this, frameState)` at :1195 and
  **returns at :1197** — everything below (the WebGL continuation) never runs under WebGPU.
- WebGL-lane packers the WebGPU path never reaches: `commitSnapshot` (:407, writes
  `_positions`/`_indexes`/`gaussianSplatTexture`), `resolveSteadySort` (:712; calls
  commitSnapshot at :681 then `buildGSplatDrawCommand` :683), `buildGSplatDrawCommand` (:1967),
  and the three `GaussianSplatSorter.radixSortIndexes` call sites (:1543/:1601/:1635 — the WASM
  worker sorter, `GaussianSplatSorter.js:58`, already ships).
- FR consumption contract: `WebGPUGaussianSplatRenderer.ts` reads ONLY
  `primitive._splatData || primitive._renderResources?.splatBuffer` (:1231), rebuilds on
  `revision !== cache.lastRevision && splatData` (:1233); 16-float/64 B interleaved record
  `posHigh(3)+posLow(3)+covA(3)+covB(3)+color(4)` documented ~:118-138; `maybeSortSplats` (:914)
  no-ops at count 0; `sortRequestPending` scaffolding (:80/:940/:994/:1026) awaits C10-04.
- Producer grep at HEAD: `_splatData =` and `_renderResources =` — **0 assignments in
  production code** (re-verify with `git grep`, excluding `_splatDataGeneration`). Only
  exerciser: `Tools/visual-regression/probe-splat-sort.mjs` (synthetic 3-splat injection).

#### The maintainer decision (write this at the top of any brief)

Placement of the WebGPU splat-commit — **(A)** a WebGPU branch in
`GaussianSplatPrimitive.update` BEFORE the `if (fr) return` (Scene file stays backend-agnostic
only if expressed via the scene-logic-extractor pattern — shared commit logic hoisted above the
branch point, per CLAUDE.md), or **(B)** inside the FR, consuming the loader snapshot buffers
directly. (A) reuses the existing snapshot/sort spine and keeps one copy of the
covariance/SH math; (B) keeps Scene untouched but duplicates snapshot mechanics behind the
context boundary. **Also needed: an offline test asset** — no `.spz`/glTF-splat tileset is
in-tree (Sandcastle demos reference remote iTwin assets); either vendor a small license-clean
asset or build a faithful synthetic-scene builder (the probe's 3-splat injection is NOT a
substitute for the loader→snapshot→commit chain). Both halves are decision-shaped; the register
row says "immediately-schedulable-if-ratified" — this dossier is written so a worker can start
the same day the decision lands.

#### Implementation walkthrough (post-ratification)

1. **Slice 1 — commit path + first pixel (probe-first):** new
   **`probe-splat-producer.mjs`**: load the chosen asset via
   `Cesium3DTileset` → `GaussianSplat3DTileContent`; assert (a) `_splatData` defined with
   count>0, (b) canvas non-black at the splat region, (c) WebGL lane renders the same asset
   (cross-backend capture pair). Implementation: pack loaded snapshot (model-space positions +
   rotations/scales→3D covariance + colors + shData) into the 16-float record; RTE rule —
   positions split high/low camera-relative at the pack (never absolute f32 ECEF; the record
   layout already encodes posHigh/posLow); assign `_splatData` + `_splatCount`, bump the
   revision the FR watches; expose model-space positions (Float32Array(count*3)) for the sort.
2. **Slice 2 — steady-state correctness:** sort consume (`maybeSortSplats` now has count>0 —
   the B288 sort-consume path goes live for the first time in production shape), log-depth leg,
   multi-frustum (B647 splat multi-frustum fix was verified on the synthetic path — re-verify on
   real data), `probe-splat-globe-occlusion.mjs`.
3. **Slice 3 — velocity leg:** C10-09's prev-buffer revision-skip was landed against the
   dormant path; with real data flowing, run the TAA/velocity probes and confirm the
   revision-skip doesn't hold stale prev-buffers across splat data commits (revision must bump).
4. FEATURE_INVENTORY: move the splat FR line §B SCAFFOLDED→SHIPPED only when slice 2's
   cross-backend oracle is green (the §B line was explicitly annotated by the C10-04 verdict).

#### Traps

- **Do not start C10-04's async machinery here** (explicitly forbidden by the register row and
  the C10-04 STOP verdict — producer first, sort second, one concern each).
- `resolveFeatureRendererReadiness` kinds: the `unsupported` fall-through at :1199-1201 must
  keep the WebGL lane byte-identical — option (A)'s branch must be unreachable on WebGL.
- The FR's revision gate (:1233): a producer that mutates `_splatData` in place without bumping
  the revision renders one commit forever; a producer that bumps every frame re-uploads every
  frame. Commit-on-change only.
- Asset licensing: no NVIDIA/non-commercial splat assets; record provenance in the batch
  message.
- 32 GB machine + Edge/WebGPU probes: splat assets can be large — bound the probe asset size
  (memory rule: pre-scan probes for unbounded loops; splat sort is O(n log n) on main thread
  until C10-04 — keep probe counts ≤ ~200k).

**Model tier:** decision memo = maintainer; slice 1 = **fable** (placement execution +
asset/loader ambiguity); slices 2-3 = **opus-or-sol**. Effort L (multi-session).

---

### C10-04-SPLAT-ASYNC-SORT — async WASM sort consume (P2, perf, M) — **BLOCKED, do not open**

Premise-broken at C10 intake (the synchronous `maybeSortSplats` comparator path it targets never
runs in production because no data flows); escalated to maintainer; the producer above is the
unblock. When it opens: replace the synchronous main-thread comparator sort with the shipped
`GaussianSplatSorter.radixSortIndexes` WASM worker consumed one-frame-stale, filling the
`sortRequestPending` scaffolding (:80/:940/:994/:1026 — verified present and unused at HEAD).
Acceptance: no frozen-frame at high counts (the 1M-splat 1-4 s stall class), sort correctness vs
the sync path on a fixed camera (index-array equality or pixel-identical), one-frame-stale
tolerance documented, `probe-splat-sort.mjs` extended with an async leg. Trap: the WASM bridge
rules apply (JS fallback retained, threshold-gated activation). **Model tier: opus-or-sol**, M,
strictly after the producer's slice 2.

---

## G5.3 — Model parity fleet

### WIRE-MODEL-COLOR-ALPHA-SEMANTICS — model.color.alpha pass routing + alpha==0 hide (P1, parity, M)

**What/why:** Blend math shipped (B484: `MODEL_HAS_COLOR` bit 27, `applyModelColor()` FS,
UB lanes 175/184-187 — verified live at `WebGPUModelRenderer.ts` :5392-5398 and the twin mirror
:6400-6406). Remaining (DW ~5070, verified): WebGL's `ModelColorPipelineStage` (a) routes to
`Pass.TRANSLUCENT` when `model.color.alpha < 1` (so the multiply blends), (b) disables color
mask at alpha==0 (invisible but depth-occluding). WebGPU leaves pass selection to the material's
own alphaMode — an OPAQUE-material model at color.alpha=0.5 renders fully opaque.

**Architecture today:** pass selection single-point:
`passClass = matInfo.alphaMode === AlphaModes.BLEND ? 1 : 0` (:5356). The proven override
precedent is `applyCustomShaderTranslucency` (Q25) — a single-point mutation of the fresh
`matInfo.alphaMode` right after `extractMaterialInfo`, cascading into blend state, passClass,
draw-pass selection, and the BLEND depth-write variant with zero shader change. The writeMask-0
infra already exists: `getSilhouetteModelPipeline(..., invisible)` (WIRE-MODEL-SILHOUETTE
landed it for the silhouette path).

**Walkthrough:** (0) premise-verify B484 lanes + the Q25 override still live; (1) extend
`probe-model-color.mjs` with alpha=0.5-on-opaque-material and alpha=0 legs, capture WebGL
baseline FIRST (expect: blended / hidden-but-occluding); (2) mirror the Q25 pattern: when
`modelHasColor && modelColor.alpha < 1` force effective alphaMode BLEND (translucent routing);
alpha==0 → writeMask-0 pipeline variant on the OPAQUE pass (keep depth) — reuse the silhouette
invisible variant plumbing in `WebGPUModelPipelineCache`, do NOT invent a second writeMask
mechanism; (3) verify the batch-table twin still behaves (a color.alpha<1 model with a batch
table: primary becomes translucent-class → passClass=1 → the C10-02 twin gate's
`passClass === 0` precondition goes false — confirm no double-emission and that per-feature
styling still classifies; this is the ONE subtle interaction, test it explicitly);
(4) off-gate: `probe-model-color.mjs` original legs byte-identical; silhouette probe unchanged.

**Traps:** WebGL's alpha==0 keeps depth (occluding) — a naive "skip draw" is a feature change
(forbidden). Silhouette+alpha=0 combination already works — don't regress it. TRAPS with C10-02:
above. **Model tier: opus-or-sol** (well-specified, single-point precedent). Effort M.

### GLTF-POINTS-MODE-RESIDUALS — 4 residuals from the POINTS topology fix (P2, parity, M)

DW ~5129-5140 (verified in full): (1) non-indexed TRIANGLES with missing attributes hard-fail
`draw()` validation ("Vertex range requires a larger buffer") → silent no-model — extend the
sequential-index synthesis beyond `point-list` or size default buffers (S); (2) LINES/LINE_STRIP/
TRIANGLE_STRIP render as triangle-list — map topologies + `stripIndexFormat` + per-strip cache
keys (S-M); (3) `ModelPointCloudStylingStage.wgsl` orphaned pending quad expansion — scaffolding,
DO NOT REMOVE (Principle 7, explicitly marked); (4) POINTS prims rasterize garbage into CSM
cascades — thread `primCache.topology` through `WebGPUShadowMapRenderer`'s model depth pipelines.
**Trap vs B695 (shadow single-sweep):** the caster list is now collected in the single PVS walk —
residual 4's fix is in the shadow PIPELINE cache, not the caster collection; don't touch the
sweep. **Probes:** `probe-gltf-points-mode.mjs` (green baseline), new legs per residual: a
LINES-mode asset leg, a non-indexed-missing-attr leg (asset or synthetic glTF), a
POINTS+castShadows leg (shadow-map readback or shadow-on-ground pixel oracle vs WebGL). Each
residual = its own slice (one concern). **Model tier:** residuals 1/2/4 **opus-or-sol** (each
S); premise-verify first — an intervening batch may have landed 1 or 2. Effort M total.

### WIRE-MODEL-SILHOUETTE-TRANSLUCENT-DIVERGENCE — match-vs-document decision (P2, parity, S)

DW ~5078-5082 (verified): translucent silhouetteColor — WebGL washes the whole model
translucent-red (~61k px; upstream OIT-stencil artifact: its translucent pass doesn't carry the
scene stencil), WebGPU draws the rim only (~5k px; matches the DOCUMENTED intent, because the
WebGPU translucent pass shares the scene depth-stencil). **This is a maintainer decision item,
not a code item:** (a) replicate WebGL's body-wash for byte-parity, or (b) ratify the
documented-intent rim-only cutout and record the deliberate divergence (DEFERRED_WORK +
FEATURE_INVENTORY + the parity-report methodology note). Evidence to attach to the decision ask:
the two PNGs from the DW capture (regenerate via `probe-model-silhouette.mjs` with an
alpha<1 leg). If (a): the change is in `getSilhouetteColorPipeline`'s translucent variant
(stencil-disabled) — S effort, opus. If (b): doc-only. **Do not schedule implementation before
the decision** (Principle 9 pattern; same shape as the ratified NS-SUN-BLEND divergence class).
**Model tier:** decision = maintainer; execution **opus-or-sol** S.

### KHR_materials_variants / IOR / clearcoat-IOR coupling (P2, parity, M) — **PREMISE-SPLIT: verify each sub-claim**

FI §C.2/§C.3 row (:806). Grep at HEAD: `KHR_materials_variants` — **zero hits in engine
Source** (loader does not even parse it; upstream CesiumJS also lacks runtime variant support —
worker must confirm against current upstream before treating this as a WebGPU-parity item rather
than an upstream feature request; if upstream lacks it, re-classify to §D FUTURE and close the
§C row honestly). `ior` — parsed into `ModelMaterialInfo.js` (verified hit); the audit is
whether `ModelPBRComplete.wgsl`'s Fresnel/F0 consumes it and whether clearcoat's coupled IOR
matches WebGL's `KHR_materials_clearcoat` handling. **Walkthrough:** (0) premise matrix: for
each of {variants, ior, clearcoat-IOR} record loader-parses? / WebGL-consumes? /
WebGPU-consumes?; (1) for real gaps, fix WGSL-side F0 derivation
(`F0 = ((ior-1)/(ior+1))²`) behind the existing material flags — no new define bit without
checking C10-08b (registry EXHAUSTED, bits 0-30 — verified via the Q31 note; a new bit is NOT
available, so any new gate must reuse existing flag lanes or the material-UB flags word);
(2) probe: `probe-khr-extensions-parity.mjs` + `probe-khr-extensions.mjs` extended with an
IOR-authored asset. **Model tier: fable** (premise matrix + upstream check), then opus for the
mechanical WGSL fix. Effort M.

### "5 default textures bound per model draw" (P2, perf, S) — sequence AFTER C10-08

FI :807. The default set lives at `WebGPUContext._initializeDefaultTextures` (:1401 — white/
black/normal/cubemap; device-loss re-init wired). The claim: every model draw binds (and the FS
potentially samples) all default textures even when the material uses none. **C10-08
(model runtime-flag specialization) is the C10-owned owner of the shader-side axes** — this row
is only the bind/sample elimination remainder that C10-08's carve-out leaves. **Do not open
until C10-08's outcome is recorded** (UNKNOWNS table in the register): if C10-08 lands
specialization defines, the unused-texture sampling dies with it and this row may reduce to a
bind-only cleanup or close entirely. Premise-verify then: count actual bindings in the merged
group-1 BGL vs the material's used set; measure with `CesiumDebug.gpuPassCost` on a
textureless-material scene. **Model tier: opus-or-sol** S, gated on C10-08 outcome.

### NEW-MODEL-WGSL-CUSTOM-SHADER — Q31 Slice C varyings (P2, parity, L) — **PARKED, double-blocked; do not schedule**

DW ~1290-1316 (verified in full, including the 2026-07-05 re-audit): custom vertex→fragment
varyings + extra attributes are CONFIRMED-BLOCKED on (1) interstage `@location` budget 16/16 in
the maximal case (locations 0-15 enumerated at ModelPBRComplete.wgsl ~:807-859/:1489-1521 —
free only when metadata and/or texCoord1 absent) and (2) the ShaderDefine registry EXHAUSTED
(bits 0-30 assigned; 1<<31 is the sign-bit hazard). Unblock options recorded in the source:
(a) reuse `MODEL_HAS_WGSL_CUSTOM_VERTEX` (1<<24) with metadata mutual-exclusion + drop+warn, or
(b) the C10-08b 64-bit define-width widening (`build-boot` cluster owns it, itself gated on
C10-08). **This item's C11 disposition: remains parked until C10-08b's mechanism exists** —
option (a) is available sooner but forces a user-visible metadata×varyings exclusion; that
trade needs a maintainer nod. If opened under (a): metadata-model regression probe REQUIRED
before landing (the source's own acceptance caveat). **Model tier: opus-or-sol** L
post-unblock; the option-(a)-vs-(b) call = maintainer.

### NEW-MODEL-SCENE2D-IDL-DUPLICATE (P2, parity, M) — **PREMISE PARTIALLY STALE at HEAD**

Register (LQ §4.3, ~160+ batches stale) lists four projectTo2D residuals including "SCENE2D
IDL-crossing duplicate draw command". **Verified at HEAD: the IDL duplicate is IMPLEMENTED** —
`C-MODEL-2DIDL-DUPLICATE` machinery in `WebGPUModelRenderer.ts` (`Idl2DHost` interface :421-427,
scratch :965-968, arming logic :4357+ "armed only for a non-projectTo2D model that crosses the
antimeridian in SCENE2D"), with a dedicated probe `probe-model-scene2d-idl.mjs` in-tree. A
worker must: (0) `git log -S C-MODEL-2DIDL-DUPLICATE` for the landing batch + run the probe to
confirm green; (1) re-scope the row to the residuals that remain — per-PRIMITIVE 2D reference
frames (model-level frame jitters on large-arc models), per-node normal rotation,
skinned/instanced/morphed projectTo2D (the B12-follow-up comment at :4349 "the IDL-crossing
duplicate command are the B12 follow-up" suggests part landed with the projectTo2D chain —
reconcile against `project2d-followup` memory notes); (2) file the corrected row in
DEFERRED_WORK. **Do not implement anything before the re-scope.** Probes:
`probe-model-project2d.mjs`, `probe-model-scene-modes.mjs`, `probe-model-scene2d-stage-guard.mjs`.
**Model tier: fable** (premise reconciliation), M.

---

## G5.4 — Tiles parity + audits

### TILE-ARCH-SHADER-STRATEGY — the Phase-8a variant-strategy decision (P1, parity/arch, L)

FI :793 — the monolithic `ModelPBRComplete.wgsl` uber-shader trade-off silently drops KHR
extensions not baked in, and "gates ~30% of Phase-7 items". This is the **highest-leverage open
architectural DECISION in the model path**, not an implementation item. **C10 adjacency
(verified from the register's UNKNOWNS): C10-08 owns the model runtime-flag→define
specialization axes and banks the ONE free ShaderDefine slot; C10-08b owns define-width
widening.** The tiles-side remainder this row owns: the coverage decision — which specialization
axes tiles-path pipelines need (~20 coarse pipelines + prewarm list), and whether the strategy
is (a) more uber-flags, (b) preprocessor-ifdef variants via the existing
`//>>ifdef`/module-cache infra, or (c) generated-chunk keySalt variants (the customShader
precedent). **Deliverable: an ADR-style decision memo + a prototype of ONE axis** (recommended:
the KHR-extension axis that currently silently drops — enumerate which KHR features
`ModelPBRComplete` actually implements vs what the loader parses; the aniso/sheen/clearcoat
family from FI §C.3). Every future model-shader item (Slice C varyings, IOR, specialization)
lands inside whatever this decides — schedule it BEFORE the KHR fleet, AFTER C10-08's outcome
is recorded. Traps: add-only define registry; module-cache key math `((defines>>>0)*0x100)+sourceId`
is the compatibility surface C10-08b widens — do not fork it here. **Model tier: fable**
(decision + prototype). Effort L.

### C-R1-TILE-BATCH — per-feature batch-table renderState (P1, parity, M) — **PREMISE PARTIALLY STALE; re-scope first**

FI :788 says per-feature `Cesium3DTileBatchTable` renderState (depthMask flip, custom blend) is
"not consumed by WebGPU model emission". **Verified at HEAD: the CORE of this landed long ago**
— the Batch 100/101 dual-command emission (`WebGPUModelRenderer.ts` ~:6302-6313 explicitly
cites "C-R1-TILE-BATCH (Batch 101)" and mirrors WebGL's `deriveTranslucentCommand`), and B699
gated its economics. What the WebGL side ACTUALLY derives beyond that
(`Cesium3DTileBatchTable.js`, verified): `getTranslucentRenderState` (:1122 — cull off,
depthMask FALSE, ALPHA_BLEND, 3D-Tile stencil bit), `getOpaqueRenderState` (:1134 — stencil
bit), `deriveZBackfaceCommand` (:1048 — front-cull colorMask-off polygonOffset back-face depth
for unresolved tiles), `deriveStencilCommand` (:1092 — skip-LOD stencil reference). The honest
remaining question set: does the WebGPU twin's pipeline mirror depthMask=false + cull-off? Are
the CESIUM_3D_TILE stencil-bit semantics and the skip-LOD stencil carried anywhere on the
WebGPU tile path (this overlaps `C-R1-CLASSIFICATION` in the classification cluster — the
stencil semantics are shared infrastructure; coordinate, don't duplicate)? Is zBackface needed
for parity on unresolved-tile refinement seams? **Walkthrough:** (0) re-scope by diffing the
four derived states against the twin's actual pipeline descriptor (read
`WebGPUModelPipelineCache`'s translucent variant); (1) file the corrected residual list; (2) fix
the depthMask/cull deltas first (visual: translucent features self-occluding), stencil semantics
as a separate slice coordinated with C-R1-CLASSIFICATION. Probe: `probe-c10-02-pixel.mjs`
MODE=all (translucent self-occlusion artifacts visible on the building), plus a refinement-seam
scene for zBackface if pursued. **Model tier: fable** (re-scope), then opus per residual. M.

### FEAT-3DT2-02 — property-texture / feature-ID WGSL sampling audit (P2, parity, M)

FI :794, audit incomplete. Machinery exists and is non-trivial (verified: PropertyTexture
handling across 6 WebGPU files — `WebGPUModelMetadata.js`, `WebGPUModelMetadataCache.js`,
`WebGPUModelFeatureId.js`, renderer, pipeline cache, defines; the DP-H46a-f epic landed the
metadata transport). The audit: per property-texture channel type (u8/norm/vec-swizzle),
assert WGSL samples the same texel+channel as WebGL's `MetadataPipelineStage` GLSL — build a
synthetic property-texture asset with a known per-texel pattern, compare
`pickMetadata`/styled-color output cross-backend. Probes exist to extend:
`probe-metadata-table-texture.mjs`, `probe-dp46*-metadata.mjs`, `probe-pick-metadata.mjs`.
Deliverable: audit table + fixes for any texel/channel mismatch. Trap: metadata transport uses
interstage locations 12-15 (`MODEL_METADATA_MAT_TRANSPORT`) — do not touch the location map
(Slice-C collision surface). **Model tier: fable** M (audit + targeted fixes).

### FEAT-3DT2-05 — Draco / KTX2 / meshopt end-to-end audit (P2, parity/tooling, M) — stale-risk flagged by the register itself

"~300 batches stale — re-verify premise." Evidence of partial coverage at HEAD:
`probe-khr-meshopt.mjs`, `probe-ktx2-transcoder-formats.mjs`, `probe-model-ktx2-ibl.mjs`,
`diag-ktx2-ibl-shape.mjs` all exist (the C2-1 KTX2-transcoder-formats work landed ~B370+).
Decode is loader-level (backend-neutral workers); the WebGPU-specific risk is
upload-format/transcode-target selection (`loadKTX2.js` → `KTX2Transcoder.transcode`,
`Renderer/CubeMap`/texture upload paths — several of these files are dirty in the C10 working
tree, so verify against committed HEAD). **Walkthrough:** run the four existing probes; the
audit reduces to filling a matrix {Draco-compressed tileset, meshopt glTF, KTX2
basis/ETC1S/UASTC targets} × {WebGL, WebGPU} with render-parity + pick sanity; file gaps as
individual rows rather than one mega-fix. **Model tier: fable** S-M (mostly verification;
likely closes or shrinks the row). 

### FEAT-3DT2-01 — Cesium3DTileStyle expression → WGSL compiler (P2, parity/perf, L)

FI :932 (§D). The backlog's single biggest 3D Tiles performance lever: today style evaluation is
CPU-side per-feature (`BatchTexture.setColor` writes — the path C10-02/the composite item ride);
a WGSL compiler moves styling to the GPU. Registered direction: restricted subset first
(color/show from property comparisons + arithmetic), standalone-buildable, orthogonal to
C10-02's CPU-side economics. **Sequencing:** AFTER the composite item (pixels must be right
before compiling to them) and after/with the TILE-ARCH-SHADER-STRATEGY decision (a styling
compiler is a generated-chunk consumer of whatever variant mechanism is chosen; it overlaps the
Phase-8b styling-compiler component — build ONE grammar, referenced by both). Deliverable
shape: expression AST → WGSL chunk (keySalt-cached, the voxel/customShader codegen precedent —
`WebGPUVoxelCustomShaderCodegen.ts` is the in-tree template), define-free (chunk-hash keyed),
CPU fallback retained for unsupported expressions (never silently wrong — fall back to
BatchTexture for anything outside the subset). **Model tier: opus-or-sol** L (the grammar
subset is specifiable up front; a fable spike only if the AST surface proves murkier than
`Cesium3DTileStyle`'s documented expression grammar). 

### Phase-8a Tile↔Hi-Z wiring — wrong consumer granularity (P2, perf, M)

FI :569-570 + register row. Verified at HEAD: `_hiZConsumeEnabled` default false
(`WebGPUSceneRenderer.ts:1132`, filter at :4134, request at :4727; toggle
`CesiumDebug.hiZConsume`). The dispatcher consumes ViewportExecutor COMMAND lists — it can only
cull already-generated commands, forfeiting whole-tile pre-traversal culling for dense city
tilesets. ALSO: consume is gated off pending the FORK-41 residual max-Z footprint-coverage fix
(FI :570 — the false-cull class). **Two-layer item:** (1) finish the footprint fix so
`_hiZConsumeEnabled` can default on for command-level culling (probes exist:
`probe-hiz-occlusion-consumer.mjs`, `probe-hiz-occlusion-control.mjs`,
`probe-hiz-tile-occlusion.mjs` — the control probe is the false-cull oracle: NOTHING visible may
be culled); (2) the granularity move — feed tile bounding volumes pre-traversal (a
`Cesium3DTilesetTraversal` integration — Scene-side, must go through the FR/RenderCommand
abstraction, no `isWebGPU` in Scene files). Layer 2 interacts with C9-26 (GPU visibility RTE
closure, `rte-taa` cluster): Hi-Z stores absolute ECEF today — **do not expand Hi-Z consumption
before C9-26's camera-relative storage lands** or you widen the precision hazard the FAR-003
containment exists for. Rule-3: any occlusion cull must be provably conservative
(on/off/restored pixel-identical on the control probe). **Model tier: fable** for layer 1
(false-cull diagnosis), opus for layer 2 after C9-26. M.

---

## G5.5 — Perf/compute consumer wiring (mostly sequenced-later)

### BACKLOG-§4.6 — indirect drawing for 3D Tiles (P2, perf, L)

`WebGPUIndirectDrawManager.ts` exists (imported by `WebGPUContext.ts:95`; flag landed S26);
no renderer batches homogeneous runs into it. Honest sequencing (register + PR §10): needs
homogeneous pipeline+bindgroup runs, which don't exist until S9-3 (retained-command executor
unification / canonical command shape) and benefits from C9-17 Slice D stability; the GPU-driven
compaction consumers (FEAT-SURVEY-06) and the FAR-003/T7 tail own the auto-enable decision.
**Do not open in early C11.** When opened: 3D Tiles opaque models first (largest static
homogeneous population), behind an opt-in flag, with `probe-bundle-content.mjs`-style content
equality as the oracle. **Model tier: opus-or-sol** L, gated.

### R-7a — render-bundle expansion to 3D Tiles opaque models (P2, perf, M)

`WebGPURenderBundleManager.ts` exists (imported `WebGPUContext.ts:91`; globe bundles measured by
`probe-globe-bundle-cost.mjs`). Expansion to tiles opaque models is encoder-time CPU reduction on
static command populations. **Hard interaction with C9-17 Slice D** (settled frontend — bundles
require command identity stability across frames, which is exactly what Slice D delivers; before
it, per-frame rebuilt commands invalidate bundles every frame and the "win" is negative) and
with S9-3 (canonical shape). Register sequencing stands: after Slice D. Oracle:
bundle-vs-direct pixel identity + encoder-time delta on the moving route (GPU timestamp
accounting item from `test-infra` is prerequisite-grade for the claim). **Model tier:
opus-or-sol** M, gated on Slice D.

### TILE-PERF-02 — KTX2 transcode on a worker (P2, perf, M) — **PREMISE LIKELY STALE**

Verified at HEAD: `KTX2Transcoder.js` header says "Transcodes KTX2 textures using web workers"
and constructs `TaskProcessor("transcodeKTX2")` (:5/:8/:14) — the transcode is ALREADY off the
main thread upstream. The FI §D row predates verification. A worker must: (0) confirm no
WebGPU-specific path bypasses the TaskProcessor (grep the WebGPU texture upload chain for a
synchronous transcode; check `loadKTX2.js:86` → `KTX2Transcoder.transcode` is the only entry);
(1) if none, close the row as stale with a one-line DEFERRED_WORK note; (2) if a burst-stall is
still measurable (main-thread long tasks during tile load bursts), the real item is upload
scheduling (writeTexture batching), which belongs to the `terrain-imagery`/residency family, not
here. **Model tier: fable** S (verification-only).

### TILE-WASM-01 — WASM SIMD tile traversal (P2, perf, L) — research-stage; fold into the S1-6 conversation

FI :938 claims 3-4× traversal speedup. The shared globe-quadtree/tileset traversal CPU cost is
real and measured (the S1-6 frame-delta floor, `arch-seeds` cluster), but the S1-6
retained-commandList tier attacks the same cost structurally (skip traversal on
camera-delta-small frames) and the WASM strategy rules (JS fallback, threshold gating, worker
placement) make this a heavy build. **Recommendation to orchestrator: treat as a spike gated on
S1-6's design** — if S1-6 makes traversal skippable most frames, a 3-4× on the remaining frames
is worth far less. Also note S5-2 (WASM consume-or-retire, `arch-seeds`): 5 of 7 existing
bridges are dead — adding an 8th before consuming the 5 needs justification. **Model tier:
fable** spike only.

### FORK-41 — PointCloudSort + GPUSortKeys consumer wiring (P2, perf, M)

Verified at HEAD: `WebGPUPointCloudSortDispatcher.ts` + `WebGPUGPUSortKeysDispatcher.ts` exist
and are imported by `WebGPUFeatureRenderers.ts:117/120` (registered as FRs — the register's
"dispatcher never integrated into the point-cloud collection" claim needs a consumer-level
re-verify: registration ≠ consumption; grep who calls the dispatchers' dispatch entry points
from the point-cloud/collection render paths). The HiZ sub-rows are stale (fixed B212-213 per
the register's own note) but the max-Z footprint residual stands (see Phase-8a Tile↔Hi-Z above
— same fix, one slice, don't do it twice). GPUSortKeys needs SOA buffers + BG factory +
RenderScheduler integration per FI :1042. **Sequencing trap:** sorted-key consumers feed the
FAR-003-contained GPU-driven paths — wiring consumers is fine; AUTO-ENABLING them is the
FAR-003/T7 tail's call, post-Gate-F. **Model tier: fable** (consumer-status re-verify + scoping)
then opus for the wiring. M.

### FEAT-SURVEY-06 — decoupled-lookback prefix-sum consumers (P2, perf, M)

Verified: `DecoupledLookbackScan.wgsl` + `WebGPUDecoupledScan.ts` exist; cull compaction +
indirect-draw compaction still use the legacy two-pass. Same FAR-003 posture as FORK-41: the
consumers (cull/indirect compaction) are on gated GPU-driven paths — the single-pass swap is a
clean, testable slice (index-array equality vs the two-pass on synthetic inputs +
`probe-clustered-dispatcher.mjs`-style dispatch counting) but its payoff is zero until the
gated paths re-enable. **Recommendation: LOW priority; pair it with whatever slice first
re-enables a compaction consumer.** **Model tier: opus-or-sol** S-M, deferred.

---

## G5.6 — P3 dossiers (short form)

### Phase-8b TileStoreGPU (P3, perf, XL — research-gated)

FI :931 + LQ §6.4/§7: the ~5-7-week umbrella epic (MegaBuffer + GPU Resident Drawer +
compute-cull fanout + dynamic-offset UBO orchestration + WGSL styling compiler + WBOIT×indirect
composition). Genuinely unbuilt (design docs only). C11 disposition: **not schedulable as a
slice**; requires the RFC + the 3-day WGSL-styling-grammar spike the register names, and its
styling-compiler component must be the SAME grammar as FEAT-3DT2-01 (build once). The CPU
traversal redesign overlaps S1-6 — the orchestrator should force these into one architecture
conversation (see OPEN QUESTIONS). If a C11 wave wants a down-payment: FEAT-3DT2-01's
restricted subset IS the down-payment.

### BACKLOG-§8 — GPUExternalTexture zero-copy video (P3, perf, M) — **PREMISE PARTIALLY STALE: manager exists, zero consumers**

Verified at HEAD: `WebGPUVideoTextureManager.ts` implements `device.importExternalTexture`
(:171/:201) with the zero-copy design documented in its header — and has **zero references
outside its own file**. The register row ("deferred, unbuilt") is behind reality: this is now a
Principle-7 scaffolding-awaiting-consumer item. The work: wire video `Material`
(`Material.video`/image-with-video-element paths) and video-on-terrain through the manager;
GPUExternalTexture's same-frame-expiry semantics mean the consumer must re-import per frame
(the manager's API shape suggests it handles this — read its docstring first); WGSL side needs
`texture_external` binding variants (a NEW BGL/pipeline variant per consuming material — check
define/keySalt budget, same constraint as everything else in this guide). Off-gate: non-video
materials byte-identical. Probe: new `probe-video-material.mjs` with a small in-tree
video asset (license-clean), pixel-motion oracle (two captures ≥N frames apart differ).
**Model tier: fable** (consumer-map + API re-read), then opus. M.

---

## Traps index (cross-item, one line each — full context in the owning section)

1. **Composite ↔ pick-empty shared root-cause candidate** (bit-17 flag): diagnose together in
   one instrumented session; if shared, ONE flag fix with BOTH probes as oracles; if not, two
   slices — never two independent "fixes" for the same flag.
2. **ALLTRANSLUCENT-PRIMARY-SUPPRESS after pick-empty** — its pick oracle is dead until then.
3. **B699 twin gate**: no item may cache `styleCommandsNeeded` (T-2) or skip on `undefined`
   (INV-6); economics probes are standing gates.
4. **B687/688 group-1 caching**: any model-renderer binding change goes through the merged
   group-1 path; re-run the settled-cache gates (Batch-687 spec suite) after touching
   emission.
5. **C10-08/C10-08b own the define/specialization surface**: registry is EXHAUSTED (bits 0-30);
   NO item in this cluster may claim a new ShaderDefine bit; chunk-hash keySalt is the escape
   valve (voxel/customShader precedent).
6. **C10-01 one-frustum default**: tile/model probes asserting per-frustum behavior must not
   assume 2 frusta; new probes should assert `numberOfFrustums===1` on default 3D scenes.
7. **C10-03 demand-driven resolve**: new scene-color consumers (bundles, video composite)
   must declare demand — never assume a resolved texture exists.
8. **B695 shadow single-sweep**: shadow fixes here (POINTS topology) are pipeline-side only;
   the caster collection walk is C10-10's landed surface.
9. **C10-09 prev-buffer revision-skip**: splat producer must bump the revision on data commit
   or velocity holds stale prev-buffers.
10. **C10-11/12/13 pick + reversed-Z in flight**: anything touching pick FBO or depth encoding
    re-baselines after W4 lands; the reversed-Z GO/NO-GO can redirect pick work — check the
    ledger at intake (register UNKNOWNS table).
11. **Splat: producer before sort** — C10-04 machinery is forbidden until the producer's
    slice 2 is green.
12. **Principle 7 scaffolding in this cluster** (do not delete): `ModelPointCloudStylingStage.wgsl`,
    `sortRequestPending` fields, `WebGPUVideoTextureManager`, dispatcher FRs, the twin's
    separate material UB.
13. **Stale-premise rows** — TILE-PERF-02 (worker transcode already exists),
    NEW-MODEL-SCENE2D-IDL-DUPLICATE (IDL duplicate landed), C-R1-TILE-BATCH (core landed
    B100/101), KHR_materials_variants (absent upstream too), GPUExternalTexture (manager
    exists): every one gets a premise-verify slice BEFORE any brief promises a fix.
14. **Perf claims**: moving-altitude route only, OFF/ON/RESTORED, promotion bar
    ≥10%/≥15% CPU-p95 or >3× noise; structural-economics items (twin counts, bundle counts)
    land on their own count oracles WITHOUT perf banners (the B699 precedent: honest
    "p95 noise-dominated → NO banner").

## Model-tier + effort summary

| Item | Tier | Effort | Gate |
| --- | --- | --- | --- |
| TILE-FEATURE-TRANSLUCENT-COLOR-COMPOSITE | fable | M | none — open first |
| B3DM-TILE-CONTENT-PICK-EMPTY | fable | M | shared session w/ above; C10-11/12 ledger check |
| ALLTRANSLUCENT-PRIMARY-SUPPRESS | opus-or-sol | S–M | after pick-empty |
| SPLAT-DATA-PRODUCER | fable (S1) → opus (S2/3) | L | maintainer placement + asset ratification |
| C10-04-SPLAT-ASYNC-SORT | opus-or-sol | M | after producer slice 2 |
| WIRE-MODEL-COLOR-ALPHA-SEMANTICS | opus-or-sol | M | none |
| GLTF-POINTS-MODE-RESIDUALS (×4) | opus-or-sol | S each | premise-verify each |
| WIRE-MODEL-SILHOUETTE-TRANSLUCENT-DIVERGENCE | maintainer → opus | S | decision first |
| KHR variants/IOR/clearcoat-IOR | fable → opus | M | premise matrix; C10-08b for new gates |
| 5 default textures | opus-or-sol | S | after C10-08 outcome |
| NEW-MODEL-WGSL-CUSTOM-SHADER Slice C | opus-or-sol | L | PARKED — C10-08b or option-(a) maintainer nod |
| NEW-MODEL-SCENE2D-IDL-DUPLICATE | fable | M | premise re-scope (partially stale) |
| TILE-ARCH-SHADER-STRATEGY | fable | L | after C10-08 outcome recorded |
| C-R1-TILE-BATCH | fable → opus | M | premise re-scope; coordinate C-R1-CLASSIFICATION |
| FEAT-3DT2-02 | fable | M | none |
| FEAT-3DT2-05 | fable | S–M | none (likely shrinks/closes) |
| FEAT-3DT2-01 | opus-or-sol | L | after composite fix + shader-strategy decision |
| Phase-8a Tile↔Hi-Z | fable (L1) → opus (L2) | M | L2 after C9-26 |
| BACKLOG-§4.6 indirect | opus-or-sol | L | after S9-3 / Slice D — do not open early |
| R-7a bundles→tiles | opus-or-sol | M | after C9-17 Slice D |
| TILE-PERF-02 | fable | S | verification-only (likely stale) |
| TILE-WASM-01 | fable spike | — | gated on S1-6 design |
| FORK-41 consumers | fable → opus | M | auto-enable = FAR-003/T7 only |
| FEAT-SURVEY-06 | opus-or-sol | S–M | pair with first re-enabled compaction consumer |
| Phase-8b TileStoreGPU | — (RFC) | XL | not schedulable as a slice |
| GPUExternalTexture | fable → opus | M | premise re-scope (manager exists) |

## OPEN QUESTIONS for the orchestrator

1. **Splat ratification (blocking the L feature):** placement (A: pre-FR-return branch in
   `GaussianSplatPrimitive.update` via scene-logic-extractor vs B: inside the FR) AND the
   offline asset strategy (vendor a license-clean `.spz`/glTF-splat tileset vs synthetic
   builder). Both need a recorded maintainer decision before the producer brief is cut.
2. **Silhouette match-vs-document:** replicate WebGL's OIT body-wash artifact or ratify the
   documented-intent rim-only divergence — maintainer call; PNGs are ready to regenerate.
3. **C10-08 / C10-08b dependency fan:** four items here (shader-strategy, Slice C varyings,
   5-default-textures, any new KHR gate) sequence on C10-08's outcome and the define-width
   decision. Confirm at C11 assembly whether C10-08 landed and whether C10-08b is a C11 wave —
   it reorders this cluster's back half.
4. **C10-11/12/13 pick + reversed-Z outcomes** redirect the pick-empty item's baseline and any
   depth-adjacent verification; re-sweep the C10 §3.2 ledger at intake (register UNKNOWNS).
5. **Slice D / S9-3 sequencing:** indirect drawing and render bundles are only worth opening
   after retained/settled command identity exists. If C9-30/C10-30 attribution opens C9-17
   Slice D in C11, schedule R-7a immediately behind it; otherwise park both.
6. **Grammar unification:** FEAT-3DT2-01's restricted styling subset and Phase-8b's styling
   compiler must be ONE grammar — assign a single owner if both appear in C11 planning.
7. **Upstream-parity classification for KHR_materials_variants:** if current upstream CesiumJS
   still lacks runtime variant support, the row should be re-classified §D FUTURE (feature
   request, not parity gap) — needs a quick upstream check + FEATURE_INVENTORY correction.
8. **Stale-row hygiene:** TILE-PERF-02 and (likely) parts of FEAT-3DT2-05 /
   NEW-MODEL-SCENE2D-IDL-DUPLICATE / C-R1-TILE-BATCH will close or shrink on verification —
   consider batching the premise-verify passes as one cheap "cluster-12 reconciliation" slice
   at wave start so later briefs cut against corrected rows.
9. **Cross-cluster coordination:** S11-1 (batch-texture lazy-create, `model-frontend`) vs the
   composite fix (sequencing recorded in G5.1); C-R1-TILE-BATCH stencil semantics vs
   C-R1-CLASSIFICATION (`classification-voxel`); Hi-Z layer 2 vs C9-26 (`rte-taa`).
