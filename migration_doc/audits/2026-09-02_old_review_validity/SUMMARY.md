# Old-review validity bank — cross-document summary

**Scope:** the ten retired reviews listed in `INDEX.json`, each judged once (`*.judgement.json`) and
then independently verified against the current tree (`*.verified.md`). All ten were verified.

**Compiler:** Ciryon. **Date:** 2026-09-03. **Tree:** `main` @ `532463ae35` (Batch 1390), working
tree as found.

**How to read the counts.** `Items` is the judgement's enumeration of the document. `Adjud.` is the
still-valid + partial subset the verifier re-derived at today's code, split into CONFIRMED (still
true as judged), CORRECTED (real, but the judgement's scope, owner, severity or number is wrong) and
REFUTED (the premise no longer holds). `Unadj.` counts items nobody could reach. `Spot-checks` is how
many of the judgement's closed items (RESOLVED / SUPERSEDED / STALE) were re-derived anyway.
`Reversals` is closed items — or sub-claims inside open ones — found still live.

The **document verdict column is the verifier's**, not the judgement's. Three verifiers overrode a
REMOVE-AFTER-MIGRATION judgement to KEEP-PART; those are marked.

## 1. Per-document counts

| Retired document                                                        | Items | Adjud. | Confirmed | Corrected | Refuted | Unadj. | Spot-checks |    Reversals | Verdict                               |
| ----------------------------------------------------------------------- | ----: | -----: | --------: | --------: | ------: | -----: | ----------: | -----------: | ------------------------------------- |
| `migration_doc/AUDIT_2026_05_02.md`                                      |    60 |      4 |         2 |         2 |       0 |      0 |           6 |            0 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`            |    48 |     16 |        11 |         5 |       0 |      0 |      5 (+1) |            0 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/audits/2026-04-30_FORK_FEATURE_INVENTORY.md`              |    58 |     13 |         6 |         5 |       2 |      0 |           5 |            1 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`       |    54 |     32 |        25 |         7 |       0 |      0 |           6 |            0 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`    |    50 |     11 |         6 |         4 |       1 |      0 |      5 (+1) |            1 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/LOCAL_CHANGE_AUDIT_2026-07-31.md`                         |    56 |     10 |         7 |         3 |       0 |      0 |           5 |            0 | REMOVE-AFTER-MIGRATION                |
| `migration_doc/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`           |    64 |     38 |        31 |         7 |       0 |      0 |           5 |  1 (partial) | REMOVE-AFTER-MIGRATION                |
| `migration_doc/PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`      |    74 |     18 |        11 |         6 |       1 |      0 |           5 |            0 | **KEEP-PART** (judgement said REMOVE) |
| `migration_doc/FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md` |    51 |     34 |        24 |         9 |       1 |      0 |           7 | 2 (sub-item) | **KEEP-PART** (judgement said REMOVE) |
| `migration_doc/audits/2026-06-11_ULTRA_REVIEW.md` (+ `_findings.json`)   |   161 |     60 |        51 |         9 |       0 |      0 |           6 |            0 | **KEEP-PART** (judgement said REMOVE) |
| **Total**                                                               |   676 |    236 |       174 |        57 |       5 |      0 |     55 (+2) |            5 | 7 REMOVE-AFTER-MIGRATION, 3 KEEP-PART |

Verifiers: Telumehtar, Ciryandil, Atanatar, Tarannon, Earnil, Egalmoth, Belecthor, Earnur, Tarondor,
Telemnar.

## 2. What the totals mean

- **236 open items were re-derived at today's code.** 174 stand as judged; **57 carry a correction
  that must travel with the migrated text** — migrating the judgement verbatim would seed the
  replacement review with 57 known-wrong premises; 5 are refuted and must not migrate at all.
- **0 items were unreachable** — see §4 for the two things that are nonetheless unchecked.
- **440 items the judgements closed were not re-derived by their verifier**; 57 of them were
  spot-checked (2 as bonus checks), leaving **383 closed items resting on a single author's
  reading.** Five of the 57 re-read items reversed. That sample was chosen for blast radius, not at
  random, so the rate bounds nothing — it is the reason §4.2 exists.

## 3. Reversals

Five, from four documents. Each is a reason a document might not be deletable, or a claim that must
be corrected before its text migrates.

### R1 — `2026-04-30_FORK_FEATURE_INVENTORY` · **R24** (Hi-Z occlusion consumer path) · judged RESOLVED, still live

The judgement closed R24 on `DEFERRED_WORK.md:5338` ("FORK-41 — Hi-Z occlusion: RESOLVED (C2-21,
2026-06-24) … command-drop now **DEFAULT ON**, verified"). The code says otherwise:
`WebGPUSceneRenderer.ts:1189` `private _hiZConsumeEnabled: boolean = false;`, the rationale at
`:1191-1196`, and `:4195-4198` `if (!this._hiZConsumeEnabled) return commands;`. No command is
dropped by Hi-Z on the default path, so the 2026-04-30 finding is still true in its operative sense.

Two consequences: the finding itself **is** owned (`C11-98` / FORK-41 at
`QUEUE_2026-07-18_CAMPAIGN11.md:1770`, restated at `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:727-729`),
so it does not by itself keep the document alive; but **`DEFERRED_WORK.md:5338` is a live ledger row
asserting a state HEAD contradicts** and must be corrected regardless of what happens to this audit.
`QUEUE_2026-08-29_RESEARCH_DISPATCH.md:605` independently verified default-off on 2026-08-29. The
same row is flagged a second time by the FORK_VS_UPSTREAM verifier under B4 — two verifiers reached
it independently.

### R2 — `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP` · **M-R5** (`debugShowBoundingVolume` on collections) · judged RESOLVED, half still open

The judgement's "resolved to WebGL parity" holds for the `Buffer*` / `GeoJsonPrimitive` family only.
For the four collections M-R5's own title names, the flag is dropped: WebGL sets it
(`BillboardCollection.js:1220`, `PointPrimitiveCollection.js:842`, `PolylineCollection.js:802`,
`:898`), the WebGPU renderers never do (`grep -c debugShowBoundingVolume` = 0 in
`WebGPUBillboardRenderer.js`, `WebGPULabelRenderer.js`, `WebGPUPointPrimitiveRenderer.js`,
`WebGPUPolylineRenderer.js`), and the consumer filters on exactly that flag
(`WebGPUSceneRenderer.ts:3652`). `DEFERRED_WORK.md:5012` is scoped to the `Buffer*` renderers and
`GeoJsonPrimitive`, so **nothing owns it.** Setting `billboardCollection.debugShowBoundingVolume` to
true draws the wireframe on WebGL and nothing on WebGPU. M-R5 migrates as PARTIAL and needs a row.

### R3 — `FORK_VS_UPSTREAM…2026-07-13` · **H17** sub-claim (globe material packing) · credited fix did not land

The judgement kept H17 open but credited "packing now happens once per frame per material type
rather than per tile". False. `_getOrCreateMaterialPipeline` (`WebGPUGlobeSurfaceRenderer.ts:522`) is
invoked at `:1625` inside `createTileCommands` (`:1099`), which
`GlobeSurfaceTileProviderRendering.js:1356` calls once per tile; `:650-654` runs `packMaterialUBO`
(a fresh `ArrayBuffer` and `Float32Array`, `WebGPUGlobeMaterial.ts:396-397`) and `queue.writeBuffer`
on **every** invocation. Only the pipeline and shader-module cache entry is per `material.type`. The
original headline — thousands of redundant allocations and queue writes per frame on a
material-enabled globe — is unmitigated. It is inert while `globe.material` is unset, which is the
default.

### R4 — `FORK_VS_UPSTREAM…2026-07-13` · **H9** sub-claim (RenderCommand adoption) · credited fix did not land

"RenderCommand now has production consumers" is false. `Renderer/WebGPU/RenderCommand.js` has no
importer anywhere in `packages/engine/Source`; the only reference is the generated barrel
`packages/engine/index.js:1025`. The cited consumers are local functions coincidentally named
`updateAndQueueRenderCommand` (`Scene/ClassificationPrimitive.js:1300`,
`Scene/GroundPrimitive.js:802`). The `ARCHITECTURE_PERFORMANCE` verifier hit the identical grep
defect independently on its item D1 (see the closing list below). The backend-agnostic command
abstraction CLAUDE.md tells new scene features to prefer is still dead on arrival.

### R5 — `FABLE5…2026-07-22` · **REJECT-4** · partial reversal, a governance rule rather than code

REJECT-4 is marked SUPERSEDED against `CLAUDE.md:20` / SR-1, but those carry only the prohibition
half ("never remove or default-disable a feature to win a metric"). The distinctive half — _a feature
toggle is a legitimate A/B attribution control, and the OFF leg is never the shipped fix_ — is stated
nowhere else, and the judgement dropped the same clause from `GATE-4-ACCEPTANCE`'s migrate text. On
the judgement as written the rule dies with the file. Restore it in both places before deletion.

### Adjacent corrections that are not reversals but travel with them

- **`ARCHITECTURE_PERFORMANCE` D1** rests on a grep that matched local function names rather than
  imports of `RenderCommand.js` — the same defect as R4. Corrected, the finding is _stronger_;
  migrating it verbatim would carry the false "3 Scene files adopt RenderCommand" figure forward.
- **Four `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` rows are stale-green** (`:1332` globe material
  cache, fixed Batch 1185; `:1335` model display-pipeline key, fixed Batch 1209; `:1348` indirect
  run-of-one swallow, fixed Batch 1198; `:1350` / Q-1 `Scene.js` light branch, fixed by the
  `updateDerivedLighting` hook). Four of sixteen `ARCHITECTURE_PERFORMANCE` migrate texts lean on
  them as live evidence.
- **`MAINTAINABILITY` T10 / N8** was held open with "no queue row"; a row exists —
  `NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` (`QUEUE_2026-07-15_CAMPAIGN9.md:124`) — and it records
  the contract's predicted failure as an observed, reproduced defect. That strengthens the finding
  and gives it an owner.
- **`ULTRA_REVIEW` #35** (TRIANGLE_FAN) was marked STILL-VALID with no owner; `DEFERRED_WORK.md:9842`
  already owns it. Migrating it as new would have duplicated a live row.
- **`PER_FEATURE` H-P11 and M-P7** were held **open** where the code no longer supports the finding,
  and H-P2 cites a straggler that landed at Batch 1192 — three false premises if migrated unchanged.
- **`LOCAL_CHANGE` S9-4-C11-194-195** warned of a possibly-live ADR-3 ownership violation that is in
  fact fixed in code (Batch 819) — an over-cautious carry, corrected so the new review does not
  re-open a closed architectural question.
- **`FORK_VS_UPSTREAM` GUARDS is refuted**: the behavioural degenerate-triangle spec the audit
  demanded exists (`EdgeVisibilityPipelineStageDecodingSpec.js:662`), so its only "needs a new tools
  row" item does not need one.

## 4. Unadjudicated

**No whole item was left unreached: 0 of 236 open items across all ten documents.** Two things are
nonetheless unchecked and must not be silently dropped from a deletion decision.

### 4.1 The one sub-claim nobody could reach

| Document | Item    | Unchecked sub-claim                                                                    | Why                                                                                          |
| -------- | ------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| FABLE5   | `F5-09` | "one bound function allocated per visible model per frame" (the allocation-rate claim) | Never measured when written, and not measured now. Carried forward explicitly as unverified. |

The rest of `F5-09` is adjudicated PARTIAL; only the rate claim is open. It needs a measurement, not
a re-read, so no amount of document work closes it.

### 4.2 Closed items no second reader re-derived — 383

These are items a judgement marked RESOLVED / SUPERSEDED / STALE that its verifier did not
re-derive. They are the residual risk in deletion: a wrongly-closed item nobody reads again
disappears with the document. Five of the 57 that _were_ re-read reversed (§3).

| Document                                   | Closed by judgement | Spot-checked | Never re-derived |
| ------------------------------------------ | ------------------: | -----------: | ---------------: |
| `AUDIT_2026_05_02`                         |                  56 |            6 |               50 |
| `2026-04-30_ARCHITECTURE_PERFORMANCE`      |                  32 |       5 (+1) |               26 |
| `2026-04-30_FORK_FEATURE_INVENTORY`        |                  45 |            5 |               40 |
| `2026-04-30_MAINTAINABILITY_SURVIVABILITY` |                  22 |            6 |               16 |
| `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP`  |                  39 |       5 (+1) |               33 |
| `LOCAL_CHANGE_AUDIT_2026-07-31`            |                  46 |            5 |               41 |
| `FABLE5_PROGRESS_AND_ACTION_AUDIT`         |                  26 |            5 |               21 |
| `PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE`    |                  56 |            5 |               51 |
| `FORK_VS_UPSTREAM…2026-07-13`              |                  17 |            7 |               10 |
| `2026-06-11_ULTRA_REVIEW`                  |                 101 |            6 |               95 |
| **Total**                                  |             **440** |       **57** |          **383** |

`PER_FEATURE`'s verifier recorded its 51 explicitly rather than treating the spot-check sample as
clearance; the same caveat applies to every row. **Mitigation, and the reason removal can still
proceed:** the judgement files stay in this bank permanently, so every closed item keeps its id,
title, claim, status and evidence line after the source document is deleted. Deletion loses the
prose, not the record.

## 5. Ordered removal list — REMOVE-AFTER-MIGRATION (7)

Order is dependency-driven, not alphabetical: files that define nothing and are cited least go
first; the two id-definition sources go last, after the tables that replace them exist.

1. **`migration_doc/LOCAL_CHANGE_AUDIT_2026-07-31.md`** — 3 inbound refs, defines no ids.
   _Hard precondition:_ inline the file/batch/artifact list into `WEBGPU_DEBUGGING_LOG.md:16478`,
   which otherwise loses its Files section entirely. Then drop the filename at `:16486` and `:16546`,
   delete the `README.md:173` row, drop the links at `:32` and `:54`, strip the clause at
   `HANDOFF_2026-07-31_CODEX_C11_HIGH_VALUE.md:7`, and give the generated-barrel default-export trap
   a durable home — it is the one item of the ten with no tracked owner.

2. **`migration_doc/audits/2026-04-30_FORK_FEATURE_INVENTORY.md`** — defines no ids, links no
   anchors. _Precondition:_ file the four orphaned findings first — **R8** (the f16 tonemap fallback
   is a validation scope wrapping no work, `WebGPUPostProcessPipeline.ts:2119-2142`), **R14**
   (translucent PointCloud classification has no depth-write variant; the mechanism exists unwired),
   **R16** (four unshipped Vector3DTilePrimitive behaviours recorded only in a renderer docstring)
   and **R17** (one depth source per frame for both classification passes, plus a pass-enum drift,
   likewise docstring-only). Carry the corrected D5 / I4 / B1 / R1 texts, and fix `CLAUDE.md:437`
   (exemption-list drift), `FEATURE_INVENTORY.md:932` / `:1082` (FEAT-GAP-09 undercount),
   `FORK_OVERVIEW.md:153` (the "~2300 LOC" claim), `WebGPUSSREffect.ts:205-224` (stale warning) and
   `DEFERRED_WORK.md:5338` (§3 R1).

3. **`migration_doc/audits/2026-04-30_MAINTAINABILITY_SURVIVABILITY.md`** — defines no ids.
   _Precondition:_ `ARCHITECTURE.md:968` is the only live pointer that sends a reader here for
   content, so the new review's survivability / embeddability section must first receive F1, F2,
   F3/F4, F5, F7, F8, F9, E1, E2, X4, X5, P1-P3, T10 and R5 — **from this bank's corrected column,
   not the judgement's** (7 of 32 migrate texts are wrong as written). Repoint
   `ISSUES_AND_FIXED_BUGS.md:355` at the new review plus `DEFERRED_WORK.md:4715`. Elevate T10 as one
   finding: a manual `_scenePipelineFormatGeneration` contract, 31 ad-hoc readers, a recorded
   reproduction of it failing on `scene.msaaSamples` flips, and no post-first-frame validation scope.

4. **`migration_doc/audits/2026-04-30_ARCHITECTURE_PERFORMANCE.md`** — defines no ids.
   _Preconditions:_ migrate D1 and D3 with the corrected text (never the "3 Scene files adopt
   RenderCommand" figure, never the "on the exemption list" claim); migrate A2a-2 with the sampler
   cache as the live item and the dead BGL cache handed to THREE-A06; drop the four stale-green
   `FIX_QUEUE` rows as supporting evidence for A2a-6 / A2b-3 / R4 / R7; rewrite the instruction at
   `audits/2026-06-11_ULTRA_REVIEW.md:336` rather than sending a reader to a deleted line; and
   **annotate `H-R9` FIXED (Batch 213, `af49776ac3`, `WebGPUGPUCuller.ts:468-495`) in
   `PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md:360` while that file still exists** — this
   document is the only other place that resolution is recorded. That is the ordering constraint
   between item 4 and item 7. _Batch the trio:_ removing items 2-4 in one commit lets
   `CLAUDE.md:603`, `README.md:343` and `README.md:392` be edited once instead of three times.

5. **`migration_doc/FABLE5_PROGRESS_AND_ACTION_AUDIT_2026-07-22.md`** — an id register and a
   principles table; no anchors of its own. _Preconditions:_ the `F5-` id register (at minimum
   F5-02, F5-04, F5-16, F5-18) and an "action 9" label must survive verbatim —
   `QUEUE_2026-08-29_RESEARCH_DISPATCH.md:348, :393, :408, :416, :424` cites them by id. Reproduce
   the eleven principles under stable headings for
   `CODEX_DISAGREEMENTS_WITH_FABLE_REVIEW_2026-08-16.md`'s 33 line-anchor links (its §2 table at
   `:60-71` already restates them one line each), adding the two the judgement dropped — bounded
   visual evidence, and honest incomplete test state — plus the REJECT-4 control-leg clause (§3 R5).
   Label `F5-04` "live, owned by DM-12 / C9-10", not SUPERSEDED. Update `CLAUDE.md:19` and
   `README.md:28` / `:334` / `:358`. The judgement's `CAMPAIGN_STATE.md:38` inbound ref **does not
   exist** — drop it from the checklist.

6. **`migration_doc/AUDIT_2026_05_02.md`** — **id-definition source** for `A.<n>` / `B.<n>` /
   `C.<n>` / `D.<n>` (`ISSUES_AND_FIXED_BUGS.md:25` and `:348` both name it authoritative).
   _Precondition:_ the one-line-per-id table (A.1-A.15, B.1-B.20, C.1-C.12, D.1-D.8 to title, final
   status, owning record) must exist first; ~25 id-only citations plus 56 source comments resolve
   only through it. Then repoint `README.md:347`, `DEFERRED_WORK.md:1931`,
   `ISSUES_AND_FIXED_BUGS.md:25` and `:348`; correct the four stale ISSUES rows (§5 B.8 follow-up
   `:189` RESOLVED Batch 175, §5 B.10 follow-up `:190` RESOLVED Batch 183, §5 A.13 residual RESOLVED
   Batches 198-204, §4 C.2 `:164` RESOLVED Batches 209-211); carry B.11 and C.6 forward as live
   gaps; mirror `NEW-CSM-VOLUMETRIC-CASTERS` from `ISSUES_AND_FIXED_BUGS.md:188` into
   `DEFERRED_WORK.md`; recount all three TS-debt numbers at `FEATURE_INVENTORY.md:1150-1152`; fix the
   `WorkerSceneHost` row at `:488`; and repoint the two `A.4` runtime warning strings
   (`WebGPUVector3DTilePolylinesRenderer.js:955`,
   `WebGPUVector3DTileClampedPolylinesRenderer.js:1142`) at `NEW-CLASSIFIER-2D-CV-MORPH`.

7. **`migration_doc/PRINCIPAL_ENGINEER_REVIEW_RENDERER_DEEP_2026_04_16.md`** — **last.** The largest
   inbound surface in the set (18 reference groups; ~59 tracked documents cite its ids) and the
   ID-definition source for `C-R*` / `H-R*` / `M-R*` / `L-R*`. _Preconditions:_ the id table in
   `INBOUND_REFERENCES.md` (ID APPENDIX) must be transcribed into the new review first; `H-R9`'s
   FIXED annotation must have arrived from item 4; and the six corrections must be carried — M-R5
   migrates as PARTIAL and needs a row (§3 R2); M-R13 is four orphan files, not five
   (`ModelPointCloudStylingStage.wgsl` is `C18-P3` do-not-remove scaffolding,
   `ModelSilhouetteStage.wgsl` is wired); H-R11's residual is dropped; H-R2 narrows to
   translucent-pass casters and clipping-plane discard; H-R6 / L-R1 is unreachable dead surface, so
   retire the class rather than hash its key; M-R10 widens from `colorMask` to the whole ignored
   `renderState`. Correct `ISSUES_AND_FIXED_BUGS.md:345` from `C-R1..C-R14` to `C-R1..C-R13`, and fix
   `:175` (orphan-WGSL note) and `FEATURE_INVENTORY.md:1006` / `:1018` in the same commit.

## 6. Not removable as they stand — KEEP-PART (3)

Each of these three was judged REMOVE-AFTER-MIGRATION and **overridden by its verifier.** All three
convert to REMOVE-AFTER-MIGRATION once one named block is migrated; none needs keeping indefinitely.

| Document                                                                | Verdict   | What must survive it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migration_doc/PRINCIPAL_ENGINEER_REVIEW_PER_FEATURE_2026_04_16.md`      | KEEP-PART | The `B-<n>` / `C-P<n>` / `H-P<n>` / `M-P<n>` / `L-P<n>` id-to-title set (B-1..B-9, C-P1..C-P18, H-P1..H-P22, M-P1..M-P12, L-P1..L-P6). `ISSUES_AND_FIXED_BUGS.md:26` and `:346` name it the definition source for the first three families; **`M-P*` and `L-P*` have no taxonomy row anywhere**, so this document is their only definition, and `archive/REVIEW_FIX_PROGRESS.md` alone carries ~49 such mentions. Secondary anchor: `ARCHITECTURE.md:412-414` cites `H-P7` — CONFIRMED live, no owning row — as the only live pointer to that defect.                                          |
| `migration_doc/FORK_VS_UPSTREAM_WEBGPU_ARCHITECTURE_AUDIT_2026-07-13.md` | KEEP-PART | The "Allocation ownership and dual-renderer investigation" to "Maximum safe sharing boundary" block (audit lines 565-588), which **no judgement item covers**: the scope-by-scope sharing table ADR-1 / FAR-206 / FAR-207 are measured against, plus two claims re-verified today — `SharedResourcePool.ts` has no importer (only `@see` comments at `GraphicsContext.ts:45`, `OffscreenContextSupport.ts:47`, `WebGPUDevicePool.ts:80`), and `Scene/ResourceCacheKey.js:387`, `:479`, `:613` still append a per-context suffix to buffer and texture keys. One table and two paragraphs. |
| `migration_doc/audits/2026-06-11_ULTRA_REVIEW.md` (+ `_findings.json`)   | KEEP-PART | The `A<n>.<m>` / `B<n>` anchor index — the §2/§3 finding tables plus the sidecar's id-to-finding mapping. `ISSUES_AND_FIXED_BUGS.md:23-24` names "the ultra-review doc + `_findings.json` sidecar" the authoritative definition source; `:76-78` defers its open MEDIUM/LOW rows to the review's bucket without reproducing them; `DEFERRED_WORK.md:4948` defers five still-open `NEW-*` ids to "the audit doc + sidecar JSON". The 60-item migration covers the open findings but **not the id-to-title index for the ~175 closed ones.**                                                      |

**Additional obligations these three carry** — none alone keeps a file, all lose information if
skipped:

- **`#37` — Billboard and Label `eyeOffset` silently dropped on WebGPU** is the only HIGH-severity
  finding in the ultra review with no owning row anywhere, and it is a real user-visible parity
  defect. It needs a row _before_ the document is retired.
- **`FAR-302`, `FAR-404`, `FAR-502`, `FAR-600` and `FAR-601` have no row** in any queue, in
  `FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md` or in `DEFERRED_WORK.md`; `FAR-301`'s
  `WebGPUViewportQuad.ts` interior is likewise unowned. Open rows or they are lost with the file.
- **Rows in closed queues are records, not owners:** re-home FAR-500/501, FAR-209/210 and
  FAR-403/405/408 out of `QUEUE_2026-07-15_CAMPAIGN8.md` / `CAMPAIGN9.md` before quoting them as
  live ownership.
- **`PER_FEATURE` unowned items to file first:** `C-P9` (eyeOffset), `H-P3`, `H-P7`, `H-P8`, `H-P19`,
  the glTF `MASK` half of `H-P20`, `L-P1`, `L-P3`, `L-P6`, and `H-P21` as a DX hygiene row. Drop
  `H-P11` and `M-P7` rather than migrating them, recording why so they are not re-derived a third
  time.

## 7. Bottom line

Removal of the seven in §5 is safe in the stated order once each precondition lands: every open item
is adjudicated with a current `file:line`, every inbound reference is repointable
(`INBOUND_REFERENCES.md`), and the judgement files in this bank retain the full record of the 383
closed items no second reader re-derived. The three in §6 must not be deleted yet — each is the sole
definition source for an id family or an architectural rule that nothing else holds today.
