# Campaign-11 Cluster Guide G4 — Model-Frontend Command Economics (5) + Frame-Delta Shared-Frontend Economics (7 + the S1-6 tier dossier)

**Anchors verified 2026-07-18 against committed HEAD `5b98ab9698` (Batch 699, `main`).** The
working tree is concurrently edited by C10 workers — every anchor below was grepped against the
COMMIT (`git grep <pat> 5b98ab9698 -- <path>`), not the tree. Line numbers are fresh hints keyed
to that hash; several drifted 300+ lines from the register/deep-dive (drift notes inline). Re-grep
by symbol before editing; the symbol names are the contract.

**Sources:** `scratchpad/c11/C11_CANDIDATE_REGISTER.md` clusters 4 + 8 (+S1-6 from cluster 22 per
cluster direction); `migration_doc/PERF_ARCH_DEEP_DIVE_2026-07-16.md` (S1-3/5/6, S2-1..5,
S7-6, S9-1..5, S11-1/4/5, §13 riders, §14 seeds 2/4/9); `migration_doc/DEFERRED_WORK.md` ~5312
(octree), ~5335 (clustered zero-light); `migration_doc/CAMPAIGN9_OPUS_EXECUTION_GUIDE_2026-07-16.md`
G9 (C9-16 walkthrough + C9-17 invariants/STOP) and G4 (C9-08 invariants I-5..I-9);
`migration_doc/QUEUE_2026-07-16_CAMPAIGN10.md` §3.2 (C10-02/09/10 landed rows, C10-30 NOT STARTED).

**Landed context this guide is written against (Batches 683–699):** C9-17 Slices A+B landed
(B687/688: group-1 material BG cache + IBL memo, loader revision tokens); C9-11 execute-closure
hoist (B682); C10-01 one-frustum default (B693); C10-09 velocity prev-buffer revision-skip +
GPU self-copy (B694); C10-10 shadow single-sweep (B695); C10-03 demand-driven scene-color resolve
(B697); C10-05 model mip chains (B698); C10-02 translucent-twin gate on `styleCommandsNeeded`
(B699, which also FILED `NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS`). C10-06/07/08/11/12/13 and
**C10-30 are NOT started** at this writing — see OPEN QUESTIONS.

**Charter rules restated (never weaken):** premise-verify-first (many register rows are stale —
every item below has a mandatory Step 0); probe-first per CLAUDE.md Principle 8 (no "reload and
check" round-trips); one concern per slice; no feature removal/default-disable/degradation for a
metric; rule-3 conservatism (unknown demand/bounds ⇒ conservative execution); perf evidence ONLY
from the moving multi-altitude route (idle soak invalid); promotion bar ≥10% whole-route /
≥15% near-ground WebGPU CPU-p95 vs the predeclared anchor OR >3× measured noise — a truthful miss
with green mechanics is VALID COMPLETE. Items are referred to ONLY by register names — the
orchestrator assigns campaign numbers at assembly.

**Model-tier legend:** `fable` = diagnostic/ambiguous/bisect work; `opus-or-sol` = well-specified
execution against this guide.

---
---

## PART 1 — `model-frontend` cluster (5 items)

The cluster theme: the WebGPU model FR treats commands and frontend plumbing as frame-transient
values while WebGL retains them (deep-dive S9 preamble — "the retained-vs-transient inversion").
Slices A+B of C9-17 fixed the bind-group/validation half; everything below is the remaining
command-object/allocation half plus its adjacent riders.

**Intra-cluster sequencing (hard):**
`S9-2` (independent, anytime) → `C9-17 Slice D` (STOP-gated, see below) → `S9-3` (ONLY after
Slice D stabilizes command shapes) · `S11-1 remainder` (independent, C10-02 has landed so it is
now unblocked) · `S9-4` (independent, FAR-003-owned surface).

---

### 1.1 `C9-17-MODEL-SETTLED-FRONTEND-REVISIONS` — Slice D (settled WebGPUDrawCommand/frontend reuse) — P1 · L · **STOP-GATED**

*(Merged aliases carried on the register row: renderer-side implicit-FID change-gate spec;
PR S9-1 command retention; S11-4 scene-wide effects BG + dirty-gated 768 B material write;
S11-5 shared scene light UB; S9-5 collections command-reuse sibling.)*

#### What + why (evidence trail)

C9-17's queue acceptance ends with "settled draw-command/frontend reuse". Slices A/B/C landed:
- **B687 (Slice A):** `getOrCreateMergedMaterialBindGroup` + IBL entry memoization — settled
  bind-group creates 14 → 6/frame on the model probe workload (register: group-1 creates 320→0
  on the tiles workload).
- **B688 (Slice B):** loader-owned `_webgpuGeometryRevision` tokens — 240/240 settled hits via
  the O(1) fast path.
- Slice C (implicit-FID certification spec) is partially represented; the renderer-side
  change-gate spec (same `(source, offset, repeat, vertexCount)` ⇒ memoized
  `implicitFeatureIdData` identity) remains the un-landed certification remainder and travels
  with this dossier.

What did NOT land is the riskiest half: on every settled frame the model FR still constructs the
entire command graph per primitive. Deep-dive S9-1 quantifies it: ~8–12 heap objects / ~250
property stores per visible primitive per frame; 300–800 visible tile-primitives ⇒ ~3–8 K objects
(~0.5–1 MB)/frame ⇒ 15–30 MB/s allocation ⇒ V8 scavenge every ~0.5–1 s with 1–5 ms render-thread
pauses; post-construction stamping re-forks hidden classes and keeps the executor megamorphic.
S11-4 adds the tiles-scale totals (~2,600 writeBuffers, ~1.7 MB uploads, ~1,800 transient
allocs/frame @400 tiles vs WebGL's ~600 retained refs) plus two unledgered sub-costs: the
per-model per-frame group-3 effects bind-group rebuild (the code's own TODO warns about it) and
the ungated 768 B material write. S11-5 adds the per-primitive 864 B light UB (~518 KB/frame
byte-identical redundant upload @600 prims). S9-5 is the same inversion at the collection
renderers (billboard/label/point/polyline command objects rebuilt per collection per frame).

**The STOP-gate (carried forward verbatim from the C10 seed row — do not soften):** this item
opens ONLY if the C10-30 (or the recorded C9-30) per-stage attribution names model-frontend
allocation/GC or model-FR CPU as a top contributor on the route. If C10-30 has not run, or its
attribution names other stages, Slice D stays closed and the cheaper independent riders
(S9-2, S11-1 remainder) proceed instead. Verify the C10-30 §3.2 row at intake (it was NOT STARTED
at `5b98ab9698`).

#### Architecture today (verified at `5b98ab9698`)

All in `packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` (now ~6,950 lines; exports
at :6944 include `getOrCreateMergedMaterialBindGroup`):

- **Slice A/B landed machinery (reuse, do not rebuild):** `_iblEntriesMemo` field :524 +
  memo compare/stamp :3414/:3426; `getOrCreateMergedMaterialBindGroup` :3612, called at the three
  emission sites :5629 (primary), :6261 (silhouette), :6448 (translucent).
- **Per-frame command construction — LIVE, the Slice D surface** (drifted ~350 lines from the C9
  guide's anchors): `new WebGPUDrawCommand(webgpuCmdArgs)` primary :5742; pick :5896; pick-hover
  :5926; precise-pick pass-1 :5984 + conditional :5990; pick-metadata :6044; velocity :6104 with
  the post-construction stamp `webgpuCmd.velocityCommand = velocityCmd` :6125; 2D-IDL duplicate
  :6157; extra :6176; silhouette :6274. Plus per-frame `webgpuCmdArgs` object, `bindGroups` and
  `vertexBuffers` arrays feeding them.
- **The env-capture clone semantics:** `captureRecords.push({...})` :5762 — capture replays NEXT
  frame, hence the deliberate `Matrix4.clone(nodeModelMatrix)`. Retained commands must preserve
  clone-on-capture.
- **S11-4/S11-5 surfaces:** the group-3 effects BG per-model call is `createEffectsBindGroup`
  (see item 1.2 — S9-2 is its cache-hit-cost sibling; S11-4's ask is a scene-wide effects BG,
  a stronger structural fix); material UBO `writeBuffer` after `packMaterialUniforms` and light
  UBO write after `packLightUniforms` remain per-primitive per-frame (deep-dive anchors :5022/
  :5095/:5104 drifted; grep `packMaterialUniforms(` / `packLightUniforms(` call sites).
- **B699 interaction (NEW since the C9 guide was written):** the translucent twin is now gated —
  `emitTranslucentTwin` computed from `model.styleCommandsNeeded` read FRESH each frame (:6320
  comment, :6344 read). A settled-command record for the translucent variant must key on this
  gate's value: a style mutation flips `styleCommandsNeeded` and must create/destroy the retained
  translucent command, not leave a stale one pushed.
- **`_settledCommandRecord` does not exist** at HEAD (grep = 0) — Slice D genuinely unstarted; no
  concurrent C10 worker has begun it (C10 owns no model-frontend task besides landed C10-02/05).

#### Implementation walkthrough

**Step 0 — premise + gate verification (mandatory, ~30 min).**
(a) Confirm the C10-30 ledger row verdict names model-frontend allocation (the STOP-gate above).
(b) `git log --oneline -5 -- packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts` —
if anything past B699 touched emission, reconcile first. (c) Reproduce the BEFORE numbers:
`probe-model-instance-bg-cache.mjs` settled counters + an API-lane
`run-performance-campaign.mjs --api-instrumentation` capture (writeBuffer + createBindGroup label
buckets). C9-17 trap #12 applies: if your numbers differ wildly from the S9-1/S11-4 quantities,
STOP and re-read the ledger.

**Step 1 — answer the two G9 pre-questions from the live tree (carried forward verbatim; this IS
the STOP condition):**
1. Does anything mutate a pushed `WebGPUDrawCommand` after emission? Grep the executor
   (`WebGPUSceneRenderer*.ts`, `WebGPUDrawCommand.ts`) for post-construction writes to command
   fields (`velocityCommand` :6125 happens at build time — fine if the retained pair rebuilds
   together; `_shadowCastBindGroup` stamps from `WebGPUShadowMapRenderer.js:1350` and derived
   `_oitPipeline`/sort-key stamps are the ones to certify idempotent across reuse — note C10-10
   moved caster collection but casters still receive per-frame stamps).
2. The capture-record clone semantics (:5762) — a retained in-place-updated `modelMatrix` is only
   safe if every consumer reads it same-frame.

**If either answer is unclear after an hour of reading: STOP, ledger the slice as the explicit
remaining PARTIAL ("settled draw-command reuse deferred — executor mutation semantics
unresolved"), and pivot to the schedulable siblings (D2/D3 below are separable).** This is G9's
rule and it stands.

**Step 2 — Slice D proper (if safe):** retain per `primCache` a `_settledCommandRecord` per
variant (primary / pick family / velocity / silhouette / translucent / IDL) holding command +
`bindGroups` array + `vertexBuffers` array + args object. Rebuild when ANY of: pipeline identity,
any bind-group identity (slice-A group-1 + group-2 cache + effectsBG + nodeCameraBG), any
vertex/index buffer identity, pass, renderState identity, instanceCount, indexCount, **or the
`emitTranslucentTwin` gate value** changes. Per-frame: update `modelMatrix`/`boundingVolume`
in place, push retained objects. Declare ALL currently-stamped fields on the `WebGPUDrawCommand`
class (kills the hidden-class re-fork — half of S9-1's cost even before retention). Replace the
`` `${nodeIdx}_${primIdx}` `` string-keyed delete-mutated dicts with a Map keyed
`nodeIdx<<16|primIdx` (S9-1 fix clause).

**Step 3 — separable sub-slices (each its own commit; each independently STOP-able):**
- **D2 (S11-4a):** scene-wide effects bind group — one per (scene, effects-identity-generation)
  instead of per model; the code's own TODO names it. Coordinates with S9-2 (1.2): land S9-2's
  memo first, then D2 makes the per-model call disappear entirely for the common case.
- **D3 (S11-5):** ONE shared scene light UB written once/frame; per-model 864 B UB only when the
  model actually carries KHR_lights_punctual. Byte-compare oracle: light UB content identical
  across primitives is the premise — instrument once to confirm before consolidating.
- **D4 (S11-4b):** dirty-gate the 768 B material write on the existing material revision plumbing
  (input-revision design, NOT byte-compare per frame). Explicitly out-of-scope in G9's Slice A —
  it is its own slice with a byte-identical oracle.
- **D5 (S9-5):** collections command-reuse sibling — build color/pick/velocity commands once per
  cache generation in `WebGPUBillboardRenderer.js` (:1330/:1512/:1362 at deep-dive time; re-grep
  `new WebGPUDrawCommand` in the four collection renderers), reuse `forceFullRebuild` as the
  rebuild trigger, mutate instanceCount/renderState/BV in place. Shares Step-1's mutation
  certification. Coordinates with S2-1 (owned by C9-27's acceptance clause — do NOT absorb the
  resolver-closure half here; entity-scale cluster owns it).

#### Traps

1. **All 13 G9 C9-17 traps still apply** (three material buffers/one function; IBL memo before
   keying; brdf-LUT one-time flip; textureEntries identity-not-clone; transmission legit churn;
   undefined-vs-null featureIdEntries; frozen descriptor never annotated; no ShaderDefine
   touches; one revision spelling; metadata-cache shared tokens; spec-bundle freshness; workload-
   specific baselines; audit-subagent git-revert hazard).
2. **B699 twin gate:** a retained translucent command MUST rebuild on `styleCommandsNeeded`
   transitions (undefined→ALL_OPAQUE→OPAQUE_AND_TRANSLUCENT→…). The B699 polarity finding is
   subtle — undefined (pre-realization) EMITS the twin; caching the gate value across frames
   re-introduces the exact staleness B699's T-2 forbids ("read fresh every frame").
3. **`NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS` (filed by B699):** the opaque primary carries
   the pick derivative, so it is NOT suppressed under ALL_TRANSLUCENT. Do not "fix" that inside
   Slice D — it needs a pick derivative on the twin first; separate item.
4. **C10-09 precedent, not license:** B694's revision-skip pattern (prev-buffer uploads) is the
   in-tree precedent for D4's dirty-gating — but it shipped with a content-revision signal per
   renderer. D4 must find/create the model-material revision signal, never guess (rule 3).
5. **Pick-family commands are hot on pick mini-frames** (FAR-107/FAR-409 territory) — retaining
   them changes allocation behavior under `pickAsync` hover loops; run the pick probes, and do
   not let retention eagerly allocate pick resources for never-picked models
   (`NEW-PICK-ID-OWNERSHIP-MODEL` owns that — don't collide).
6. **Multi-context:** retained records live on `primCache` (per-context by construction) — never
   module-level.
7. **Shadow stamps:** `cmd._shadowCastBindGroup*` (WebGPUShadowMapRenderer.js:1333-1351) are
   stamped ON the command object. Retained commands make these stamps *stable* (good — that is
   S2-2's cache working better), but a Slice-D rebuild must null them (the :1131 invalidation
   pattern) or the caster binds stale UBs after a pipeline change.

#### Verification recipe

- **Specs:** extend the Slice-A spec family; new spec for the settled-command record (rebuild on
  each key component, in-place update of modelMatrix/BV, twin-gate transition). After adding:
  confirm the new spec NAMES appear in Karma output (freshness trap / item 4A).
- **Probes (all must PASS, zero device errors):** `probe-model-instance-bg-cache.mjs` extended
  with a `settledDrawCommandConstructs === 0` gate (debug-pragma'd counter);
  `verify-model-feature-pick.mjs`; `probe-model-color.mjs`; `probe-taa-model-skinned-velocity.mjs`;
  `probe-model-ibl.mjs` + `probe-model-pbr-ibl-parity.mjs`; `probe-standalone-model-pick.mjs`
  (B699 already gates it — keep green); `probe-model-scene-modes.mjs` (2D/CV/IDL duplicate is a
  retained variant too). Propose NEW probe `probe-model-settled-commands.mjs` if extending the
  bg-cache probe muddies its existing gates: 40 settled frames, counts command constructs +
  writeBuffer bytes by label, then mutates (style flip, animation, IBL swap, color change) and
  asserts exact single-rebuild responses.
- **Visual:** `capture-and-diff.mjs` model scenes byte-band — retention is byte-identical by
  construction; ANY pixel delta is a key bug (G9 rollback rule: fix the key or revert; never
  force per-frame invalidation to green a gate).
- **Perf:** clean + API lanes on the moving route, ≥5 reps; headline evidence = allocation/
  writeBuffer/createBindGroup counters (the default route has few models — G9's caveat stands);
  a tiles-dense workload lane for the S11-4 numbers. Promotion claims only against the
  predeclared anchor; honest miss = valid.
- **On/off/restored:** temporary in-build toggle for the retention path (removed before final),
  A/B/A byte-identity per the C10-10 oracle style.

#### Model tier + effort

- Step 0/1 (gate check + mutation-semantics certification): **fable** (ambiguous, read-heavy,
  STOP-decision quality is the whole game). 0.5–1 day.
- Slice D proper + D2/D3/D4/D5 once certified: **opus-or-sol**, one sub-slice per batch. L
  overall (4–6 batches if all sub-slices open).

---

### 1.2 `S9-2` — effects bind-group memoization — P1 · S

#### What + why

`createEffectsBindGroup` (C-R11 owner-keyed effects cache) is correct but pays full key-construction
cost on every HIT: per tile and per model per frame it fills a 480 B scratch, allocates a
DataView, does ~22 WeakMap identity lookups, builds a ~40-intermediate-string cache key, and
linear-scans slots — 300–600 invocations/frame with LUT/shadows/clipping/clustered on; tens of
thousands of string/WeakMap ops to conclude "nothing changed" (deep-dive S9-2). Worse: the
frustum loop mints a fresh globe-depth `GPUTextureView` per frustum per frame, and the model
effects path keys on view identity — with inline edges armed the resKey never repeats ⇒ a NEW
GPUBindGroup + UBO slot per model per frame (the Batch-139 texture-identity fix was applied to
collections only).

#### Architecture today (verified at `5b98ab9698`)

- `packages/engine/Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js`: `new DataView(ud.buffer)`
  :1244 (+ second site :1693); `resKey` :1536; `ownerKey` :1556-1566; `cacheKey =
  `${ownerKey}#${resKey}`` :1572. All as the deep dive described.
- `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererFrustumLoop.ts:313`:
  `context._globeDepthView = packedDepth ? packedDepth.createView() : null` — the per-frustum
  fresh-view mint (drifted from :307). NOTE B693 (C10-01): default 3D now runs ONE frustum, so
  the per-frustum multiplier is 1 at defaults — but the mint is still per-FRAME fresh identity,
  which still defeats view-identity keying every frame. The premise survives C10-01; only the
  multiplier shrank.
- Model-side call: `WebGPUModelRenderer.ts` `createEffectsBindGroup(device, frameState, {owner:
  model, ...})` (grep the call; G9 cited :4215). Tile-side call in
  `WebGPUGlobeSurfaceRenderer.ts` (deep-dive :1229) — that half is C9-11 territory
  (terrain-imagery cluster); coordinate, don't collide: the memo mechanism lands HERE (shared
  module), the per-tile call-site adoption belongs to the terrain guide's owner.

#### Implementation walkthrough

**Step 0:** confirm at intake nothing landed on `WebGPUEffectsBindGroup.js` past B699
(`git log --oneline -3 -- <file>`), and reproduce the hit-path cost: temporary debug counter of
key-builds vs creates over 40 settled frames on a tiles + shadows + clipping scene (expect
creates ≈ 0, key-builds ≈ invocations).

1. **Frame-stamp memo:** on the owner record store `{frameNumber, resolvedTuple, bindGroup}`;
   first call per (owner, frameNumber) resolves; subsequent same-frame calls return directly.
   Then extend to cross-frame: keep the resolved identity tuple (typed fields, NOT a string) and
   compare ~10 identities directly — string key built ONLY on miss (the
   `WebGPUGlobeBindGroupCache` slot-handle contract, whose docstring already documents this
   flaw).
2. **Hoist the DataView** (one per UBO scratch, module-level).
3. **Cache the globe-depth view per texture** at the frustum-loop publish site (:313): mint a new
   view only when `packedDepth` texture identity changes (resize/realloc). This single line
   repairs the edge-mode per-model rebuild.
4. Keep semantic behavior byte-identical: same bind groups, same slots, same eviction.

#### Traps

1. **Do not "fix" the per-frustum resolve topology** — that is attachment-topology cluster
   (S7-2/C9-09/C9-10) territory. This slice touches key computation + one view-caching line only.
2. **The 22-segment key exists because effects inputs legitimately change** (CSM cascade
   buffers, clustered stash, clipping textures). The memo compares identities — if any input is
   rebuilt-fresh-per-frame upstream (the clustered buffers-stash literal is, until item 2.4
   lands), the memo still misses. Measure hit-rate before/after; if a specific input churns,
   name it in the ledger row (likely fold-in: item 2.4's stable stash).
3. **`_idFor`/WeakMap ids are load-bearing for eviction** — keep the string path reachable for
   the true-miss path; never change slot eviction semantics in this slice.
4. **Cross-item:** if C9-17 D2 (scene-wide effects BG) lands later, this memo becomes its
   fast-path — the work is NOT wasted, but sequence-aware: land S9-2 first (it is S and
   independent); D2 consumes it.

#### Verification recipe

- Extend `probe-model-instance-bg-cache.mjs` (or the new settled-commands probe) with an
  effects-key-build counter gate: settled frames build 0 string keys, 0 DataViews, 0 views.
- Edge-mode oracle: scene with inline edges armed — before: N bind-group creates/frame; after: 0
  settled (this is the probe-visible headline).
- Visual byte-band: `capture-and-diff.mjs` globe-default + a shadows+clipping scene, cross-backend
  band unchanged vs baseline; on/off/restored A/B/A via temp toggle.
- Probes: `probe-csm-cast-dispatch.mjs`, `probe-clustered-per-frame.mjs` (effects BG consumes the
  clustered stash), clipping-plane probe of record. Zero device errors.

#### Model tier + effort

**opus-or-sol** — well-specified, bounded surface. S (1 batch). No STOP conditions; the only
judgment call (trap 2 churn attribution) resolves by measurement.

---

### 1.3 `S9-3` — retained-command executor unification — P2 · L · SEQUENCE-LOCKED after Slice D

#### What + why

The hottest loop (300–2,000 `executeWebGPUCommand` dispatches/frame) wraps EVERY command in
try/catch, duck-types across genuinely different shapes, and runs 8–15 megamorphic
optional-chained `derivedCommands` loads per command per pass per frustum (deep-dive S9-3).
It also passes `context` as `dynamicStateOverride` (latent foot-gun). §14 seed 4 sequences this
AFTER C9-17's command retention "so the shapes stabilize first" — unifying shapes before
retention means doing the work twice.

#### Architecture today (verified at `5b98ab9698`)

`packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`: per-command `try {` at :507 and
duplicated :577 (batch path); duck-typing `dispatched.isWebGPUDrawCommand === true || …` :316-318
with further checks :572/:611. Divergent execute arities: `WebGPUContext.ts` (~:2596-2606 at
deep-dive time) + `WebGPUViewportQuad.ts` — re-grep `execute(` signatures at intake.

#### Implementation walkthrough (summary — this is a dossier-level plan pending Slice D)

Step 0: verify Slice D's landed shape (if Slice D was STOPped, this item's premise changes —
unification without retention still pays off on IC stability but the plan must be recut; flag to
orchestrator). Then: (1) integer `commandType` tag (or single canonical class) assigned at
construction; switch-dispatch in the executor; (2) hoist try/catch to batch level with the
warn-once error path preserved (permanent sentinels NEVER stripped — CLAUDE.md logging rules);
(3) unify the viewport-quad execute signature; (4) stop passing context as
`dynamicStateOverride`; (5) declare all stamped fields (shared work with Slice D step 2 — if
Slice D landed, this is already done).

#### Traps

1. The try/catch is a **command-buffer-invalidation containment** — hoisting must not let one
   throwing command kill the whole frame silently. Keep per-batch catch + the invalid-buffer
   sentinel semantics byte-equivalent (test by injecting a throwing command in a spec).
2. Duck-typing currently tolerates legacy/overlay command shapes (ClearCommand, compute,
   viewport-quad). The switch must enumerate ALL shapes — grep every `.push(` into
   `frameState.commandList` and the overlay/compute lists before writing the enum; unknown shape
   ⇒ fall back to the old duck path (rule-3 conservatism), never drop.
3. FAR-405/706 render bundles + `executeBatchIndirect` homogeneous-run detection are downstream
   beneficiaries — do not fold bundle work in here (one concern per slice).

#### Verification recipe

Full default-route + tiles + collections probe sweep (`probe-camera-track.mjs` 9/9,
`capture-and-diff.mjs` full scene set, pick probes) — executor changes touch EVERYTHING, so the
verification is breadth not depth; injected-throw spec for the catch semantics; perf claim via
clean-lane p95 on the moving route (this one CAN honestly move route p95 at tiles scale).

#### Model tier + effort

**fable** for the shape-enumeration audit (ambiguity risk in trap 2), **opus-or-sol** for the
mechanical conversion after the enumeration is written down. L (2–3 batches). Do not schedule in
the same wave as Slice D.

---

### 1.4 `S9-4` — GPU-cull feed pooling — P2 · S

#### What + why

Above the 384-command gate, the GPU-cull FEED re-extracts every command bounding sphere into a
fresh `Float32Array(count*4)` and re-uploads spheres + planes every frustum every frame — the
output side was pooled in B213, the input never (deep-dive S9-4). 1,000 commands × frusta ≈
32 KB fresh typed-array + 2,000 sphere reads + repeated uploads/frame, exactly in dense scenes.
Owner: FAR-003 (this is a containment-adjacent surface — the cull path itself is
containment-gated; the feed cost is paid whenever the path is active).

#### Architecture today (verified at `5b98ab9698`)

`WebGPUSceneRenderer.ts`: `const sphereData = new Float32Array(count * 4)` :3833 +
`planeData = new Float32Array(24)` :3853 (opaque path); duplicate :4015/:4031 (translucent path).
Drifted from deep-dive :3708/:3873. Output pool from B213 nearby (deep-dive :3779 — re-grep).
B693's one-frustum default reduces the per-frame multiplier but the per-frame realloc remains.

#### Implementation walkthrough

Step 0: confirm the 384-command gate value + that the path activates on a reproducible dense
scene (`probe-clustered-...` no — use the high-density path: `CesiumDebug.highDensityCull()`
stats + the `high-density-5k-spheres` scene — NOTE that scene is a standing gate RED
(cross-backend drift, standing-reds cluster); use it for counters only, not pixel gates).
Then: grow-only pooled `sphereData`/`planeData` arrays on the renderer, versioned by a
command-list generation counter; skip extraction + upload when generation unchanged; translucent
path shares the pool discipline (own slot). The generation signal must be REAL — if no
command-list revision exists to key on (S1-6 territory), version on (commandList identity, length,
frameNumber-of-last-structural-change) conservatively: when in doubt, re-extract (rule 3).

#### Traps

1. **This is FAR-003 surface** — do not touch containment defaults, readback, or indirect paths.
   Feed pooling only.
2. Stale spheres = wrong culling = missing geometry (a Rule-1 violation delivered by an
   optimization). The conservative fallback (re-extract on any doubt) is mandatory; add a
   debug-pragma'd cross-check comparing pooled vs fresh extraction on N sampled frames.
3. BV objects mutate in place for dynamic content (models moving) — command-list identity alone
   is NOT sufficient; the generation must incorporate a BV-content signal or the pool must
   re-extract when any command's BV revision is unknown. If that signal doesn't exist, the
   honest scope is "pool the ALLOCATION (reuse the arrays), keep the per-frame extraction+upload"
   — still kills the GC churn, defers the upload skip to when S1-6/C9-11-class revisions exist.
   Say so in the ledger row.

#### Verification recipe

`probe-collections-regression.mjs` + a dense-command scene with `CesiumDebug.highDensityCull()`
before/after counters (allocations via API lane); visual byte-band on the dense scene
(cross-backend band vs ITS OWN baseline, given the 5k-spheres red); on/off/restored A/B/A.
Promotion stance: counter evidence, not route p95 (the default route rarely crosses the gate).

#### Model tier + effort

**opus-or-sol** with the trap-3 honest-scope decision pre-authorized above. S (1 batch).

---

### 1.5 `S11-1` remainder — `WebGPUModelFeatureId` batch-texture force-create — P2 · S–M · NOW UNBLOCKED (C10-02 landed B699)

#### What + why

`createBatchGPUTexture` force-allocates `batchTexture._batchValues` (opaque-white fill) for EVERY
feature-table primitive, making FLAG_HAS_BATCH_TABLE unconditionally true ⇒ permanent per-fragment
batch-table sampling for unstyled tilesets + the permanent Uint8Array (4 B/feature) CPU-side.
C10-02 (B699) fixed the downstream translucent-twin symptom but explicitly carved this out as a
separate slice ("stop force-allocating `_batchValues` — lazy batch texture on first style
mutation with a dynamic FLAG_HAS_BATCH_TABLE define flip", deep-dive S11-1 fix clause; C10Q §5
C10-02 row scope exclusion).

#### Architecture today (verified at `5b98ab9698`)

`packages/engine/Source/Renderer/WebGPU/WebGPUModelFeatureId.js:277-296` — the force-create is
LIVE and now carries a docstring explaining exactly WHY it exists: "the WebGPU path needs the GPU
texture to exist up front so FLAG_HAS_BATCH_TABLE gates on, the per-feature pick texture is
allocated, and the merged material BG carries valid bindings." That comment is the spec of what
the lazy conversion must re-provide dynamically:
1. the define flip (FLAG_HAS_BATCH_TABLE off→on on first style mutation, via the preprocessor +
   module cache — a pipeline-variant change, NOT a registry change);
2. the per-feature **pick texture** must still exist whenever feature picking can occur (pick
   correctness cannot become lazy-on-style — picking is not styling);
3. the merged material BG must rebuild exactly once on the flip (slice-A cache invalidation via
   `featureIdEntries` array identity — verify `ensureFeatureIdResources`' early-exit at :412-427
   rebuilds entries on the transition).
Mutation path intact: `_batchValuesDirty` upload gate :423-427/:519.

#### Implementation walkthrough

**Step 0:** re-read the B699 commit message polarity finding: unstyled batch-table tiles report
`ALL_OPAQUE` DEFINED at steady state via `Model.applyStyle` on first feature-table realization —
i.e. the style plumbing RUNS even unstyled. Instrument which of the three docstring reasons
actually fire on an unstyled tileset (is feature PICK exercised? does any consumer read the batch
texture?).
1. Split the three concerns: (a) pick texture allocation keyed on pick demand (coordinate with
   `NEW-PICK-ID-OWNERSHIP-MODEL`, Wave-4 pick cluster — do NOT solve pick-ID eagerness here;
   if pick demands the texture today, keep it and shrink scope to the batch COLOR texture only);
   (b) batch color texture + `_batchValues` allocation deferred to first
   `setShow`/`setColor`/style application (`BatchTexture._batchValuesDirty` and
   `Model.applyStyle` are the trigger points); (c) define flip: primitive pipelines start without
   FLAG_HAS_BATCH_TABLE; on first mutation, flip the define (new pipeline variant via the module
   cache — add-only, no registry edits), rebuild `featureIdEntries` (identity change invalidates
   the slice-A group-1 cache correctly), emit from then on.
2. The flip must interact correctly with B699's `emitTranslucentTwin`: a first-style-mutation
   frame may simultaneously flip the define AND the twin gate. Handle in one frame; no
   half-state (old pipeline + new twin).
3. Keep the WebGL comparison invariant: WebGL skips `createTexture` until a color change — the
   fix is literally WebGL-parity behavior.

#### Traps

1. **The transition frame is the whole risk**: style applied on frame N must render styled by
   frame N+1 at the latest, with no flash of unstyled/white content. If the new pipeline variant
   compiles async (C10-07 may land async model pipelines — check its ledger row at intake), the
   flip needs the tolerate-one-frame fallback WITHOUT dropping the primitive (render unstyled one
   extra frame, never black).
2. **Register drift note:** the register's blocker line said "sequence after C10-02 lands" — it
   HAS (B699). Also says verify FLAG_HAS_BATCH_TABLE dynamic-flip interplay with the
   styleCommandsNeeded gate — that is trap/step 2 above.
3. Memory claim honesty: the Uint8Array is 4 B/feature — the headline win is the per-fragment
   sampling + permanent define, not CPU memory. Don't oversell.
4. Do not touch `_batchValuesDirty` upload semantics (mutation-exactness, G9 invariant 6).

#### Verification recipe

- Probes: `verify-model-feature-pick.mjs` (pick before ANY style mutation — the pick-demand
  question is answered by this probe failing or passing on the lazy build);
  `probe-standalone-model-pick.mjs`; a tileset style probe (B699's scenario set: unstyled /
  setColor-alpha subset / all-translucent / cleared) asserting command counts AND pixel output
  at each transition; `capture-and-diff.mjs` tiles scenes.
- Counter oracle: unstyled tileset settles with 0 batch textures created, FLAG_HAS_BATCH_TABLE
  absent from pipeline keys (label/define dump); first mutation ⇒ exactly one texture + one
  pipeline variant + one group-1 rebuild.
- Fragment-cost evidence: `gpuPassCost` before/after on an unstyled city tileset (the
  per-fragment sampling removal is GPU-side — this item CAN claim GPU-lane wins; CPU-p95 claims
  follow the standard bar).

#### Model tier + effort

**fable** for Step 0 (the pick-demand instrumentation decides the real scope — ambiguous),
**opus-or-sol** for the conversion after scope is pinned. S–M (1–2 batches).

---
---

## PART 2 — `frame-delta` cluster (7 items + the S1-6 tier dossier)

The cluster theme: the shared (backend-agnostic) frontend has no reuse tier between
"skip the whole frame" (`shouldRender`, Scene.js:4106) and "recompute everything" — a ~4–5 ms
avg / 8–10 ms p95 command-count-independent floor on BOTH backends (deep-dive S1-6). The items
below are (a) the XL tier itself (arch-seed, schedulability split), (b) independently-schedulable
slices that shrink the floor without the tier, and (c) opt-in-path zero-work contracts.

---

### 2.0 `S1-6` — frame-delta retained-commandList tier — P1 · XL · **ARCH-SEED with two C11-schedulable increments**

*(Register cluster 22 row; included here per cluster direction. Merged: C10Q §6 seed + C10-10
row blocker + register §14 seed 2.)*

#### What + why

The only frame gate is boolean `shouldRender` (verified Scene.js:4106-4122 at HEAD); once true, a
2 m camera move re-runs tile selection, environment updates, height plumbing, PVS, preload, and
ephemeris/uniform work exactly like a content mutation. C9-11/C9-17/C9-12 retain BACKEND
artifacts only; nothing above the split has a revision system. Register contradiction #3:
without this tier, backend wins cannot deliver ≥2× at p95 on CPU-bound hosts. The fix shape:
frame-delta classification (cameraDelta tier × contentRevision tier) so camera-only frames reuse
environment commands and skip height/preload re-registration and re-binning when frustum set +
command list are revision-identical.

#### Schedulability split (the cluster-direction deliverable)

**ARCH-SEED (NOT C11-schedulable as a whole):** the tier itself — a revision system spanning
Scene/View/ViewportExecutor/UniformState + every commandList producer — is a multi-week
architecture campaign gated on C9-11/C9-17 retained packets EXISTING to be reused (C9-11
remainder is deferred-blocked; C9-17 Slice D is STOP-gated). Opening the full tier in C11 would
violate the register's own gating. It is the natural Campaign-12 anchor.

**C11-SCHEDULABLE increment 1 — instrumentation + contract spike (S, tooling):** add
debug-pragma'd per-stage revision/skip counters + a `frameDeltaClass` diagnostic
(camera-only / content-mutation / mixed) computed from existing signals (camera pose delta,
commandList length + push-site dirty flags), exposed via `CesiumDebug.snapshot()` and consumed by
`run-performance-campaign.mjs` as attribution metadata. Zero behavior change; gives C10-30-style
checkpoints the per-stage evidence that decides where the tier pays. This is also the
prerequisite for item 2.6's caster sublist and S9-4's generation signal.

**C11-SCHEDULABLE increment 2 — S1-3 (item 2.1) as the tier's first real consumer:** the
height-plumbing rebuild is self-contained enough to land its own persistent-registration fix
without the general tier (below).

Everything else (environment-command reuse, binning skip, preload gating) waits for the seed.

#### Traps (for whoever opens the seed later — record now)

1. `shouldRender` interacts with requestRenderMode + `maximumRenderTimeChange` (Scene.js:4115-
   4122) — the tier must never make a requested render a no-op (Rule 1 class).
2. B693's one-frustum invariant is guarded by `probe-frustum-count-3d.mjs` — any binning-skip
   work must keep it green byte-for-byte.
3. TAA/temporal contracts (rte-taa cluster) assume per-frame uniform refresh — camera-only reuse
   must still advance `previousViewProjection` (DP-H41) every frame.

#### Model tier + effort

Increment 1: **opus-or-sol**, S. Increment 2: see 2.1. The seed itself: not schedulable —
orchestrator decision (see OPEN QUESTIONS).

---

### 2.1 `S1-3` — globe-height plumbing rebuild — P1 · M

#### What + why

Every camera-moved frame (=100% of the canonical route) re-runs: the synchronous recursive
primitive-tree height walk (+ tileset `getHeight` = collision/BVH query when `enableCollision`),
`globe.getHeight` tile descent, teardown/rebuild of the `updateHeight` callback web (≥5 closures,
walk over all primitives, 2 collection listeners added/removed, per-tileset re-registration);
the quadtree then propagates one ADD and one REMOVE through `levelZeroTiles` +
`tile.updateCustomData()` per frame, and `updateHeights` re-interpolates under a 2 ms/frame
budget (deep-dive S1-3). Part of the shared 4–5 ms floor on BOTH backends. Unowned (NEW).

#### Architecture today (verified at `5b98ab9698`)

- `packages/engine/Source/Scene/Scene.js`: `getHeight` :3864 (globe.getHeight :3896);
  `updateHeight(cartographic, callback, heightReference)` :3920 — builds the callback web:
  `terrainRemoveCallback = this.globe._surface.updateHeight(...)` :3952 + per-primitive
  `primitive.updateHeight(...)` :3968; the per-frame teardown/rebuild at :4025-4034
  (`_removeUpdateHeightCallback()` then re-`updateHeight`) — this is the camera-height
  registration that churns every moved frame (register anchor :4048-4051, drifted).
  Destroy-path :5265.
- `packages/engine/Source/Scene/SceneUtilities.js`: scene.getHeight consumer :50, primitive
  walk :74.
- `packages/engine/Source/Scene/QuadtreePrimitive.js`: `_addHeightCallbacks`/
  `_removeHeightCallbacks` :87-88; `_updateHeightsTimeSlice = 2.0` :91; per-frame add/remove
  propagation :474-495 with `levelZeroTiles.forEach((tile) => tile.updateCustomData())` :495
  (+ :601); `updateHeights(this, frameState)` :303.

#### Implementation walkthrough

**Step 0 (probe-first):** build/extend a probe that measures the plumbing directly — propose NEW
`probe-camera-height-plumbing.mjs`: drives the canonical moving route headless, counts (via
debug-pragma'd counters) updateHeight registrations torn down/rebuilt per frame, updateCustomData
propagations, and getHeight descents; asserts the BEFORE behavior (≈1 teardown+rebuild/frame
while moving) to pin the premise.
1. **Persistent registration:** keep ONE registered camera-height callback; on camera move,
   update the registered cartographic IN PLACE (the quadtree callback record's position) instead
   of remove+add, IF the containing level-zero tile is unchanged; fall back to full re-register
   on tile change (the routing is position-dependent — rule 3).
2. **Threshold-gate recompute:** skip the whole update when the cartographic delta since last
   registration is below epsilon (config: tie to existing camera-move epsilons, do not invent a
   new magic number without documenting it) AND the terrain tile revision under the point is
   unchanged.
3. **Cache last height + source-tile revision** so `updateHeights` re-interpolation only runs
   when the tile's data changed or the position moved.
4. Both backends benefit identically (this is Scene/Quadtree code above the split) — WebGL
   byte-identical rendering is the oracle, not a nice-to-have.

#### Traps

1. **`enableCollision` camera-vs-terrain clamping is a correctness feature** — under-updating
   height = camera through terrain. The threshold gate must be conservative near the ground
   (scale epsilon by height-above-terrain; when in doubt, recompute).
2. `updateCustomData` also serves ENTITY height references (clampToGround billboards etc.) —
   the persistent-registration change must ONLY touch the camera's own registration, not the
   generic `_addHeightCallbacks` machinery that entities use (entity-scale cluster owns their
   scaling story, S10). Keep the generic path byte-identical.
3. The 2.0 ms time-slice budget (:91) is load-bearing for terrain-edit responsiveness — do not
   change it in this slice.
4. Terrain-provider readiness transitions (tiles arriving) must re-fire the callback even if the
   camera is stationary — tile-revision keying covers it; test explicitly (camera still, terrain
   streaming in, height updates must continue).

#### Verification recipe

- New `probe-camera-height-plumbing.mjs`: AFTER = 0 teardown/rebuilds and 0 full descents on
  camera-only moved frames within threshold; correct height tracking on a descent leg (compare
  `camera.positionCartographic.height` clamp behavior before/after — byte-equal trajectories).
- `probe-camera-track.mjs` 9/9 PASS both backends (the canonical route exercises exactly this
  path); `capture-and-diff.mjs` globe-default band unchanged.
- Collision oracle: scripted dive at terrain with `enableCollision` on — camera never penetrates,
  before/after trajectories equal.
- Perf: clean-lane moving route ≥5 reps both backends; this item plausibly moves shared-frontend
  p95 — claim only per the bar; per-stage evidence via the S1-6 increment-1 counters if landed.
- On/off/restored A/B/A with a temp toggle.

#### Model tier + effort

**opus-or-sol** (well-specified; the traps are enumerable). M (1–2 batches). Pairs naturally with
S1-6 increment 1 landing first for attribution.

---

### 2.2 `S1-5` / `S7-6` — 2D/CV/ortho band economics — P2 · M

#### What + why

Three mode-scoped multipliers the reversed-Z tail can never help (deep-dive S1-5 + S7-6):
(a) SCENE2D antimeridian-wrap frames zero `commandList` and re-run the ENTIRE shared frontend for
the second viewport half though commands are viewport-invariant — a clean 2× on every other S1
cost in the weakest mode; (b) the 2D uniform band split can reach ~16 frusta at full-earth zoom,
each paying a FULL `uniformState.update` (unique to 2D) + the whole per-frustum scaffold +
per-band collection-UB repack (`repackPerSlice=true`); (c) ortho 3D force-disables log depth ⇒
farToNearRatio=1000 ⇒ 3 bands. 2D worst case ≈ 70+ render passes + ~32 fullscreen packs/frame.

#### Architecture today (verified at `5b98ab9698`)

- `packages/engine/Source/Scene/ViewportExecutor.js`: wrap path zeroes commandList :364 then
  `updateAndRenderPrimitives(scene)` :367 (further wrap call-sites :416/:437; function :75).
  Drifted from deep-dive :355-363.
- `packages/engine/Source/Scene/View.js` (updateFrustums, ~:529-556): 2D branch verified —
  `numFrustums = Math.ceil(Math.max(1.0, far - near) / scene.nearToFarDistance2D)` with
  `far = Math.min(far, camera.position.z + scene.nearToFarDistance2D)`.
- Per-band scaffold + `repackPerSlice` in `WebGPUSceneRendererFrustumLoop.ts` (:183-214 at
  deep-dive time) + `WebGPUCollectionCameraUB.js` per-slice pool.
- B693 note: C10-01 keyed env-command exclusion on `pass === Pass.ENVIRONMENT` in the
  ACCUMULATORS; the S7-6 rider "audit which fork commands still bin BV-less in 2D/CV" remains
  open — C10-01's invariant 7 said 2D/CV counts "never increase", it did not claim the audit.

#### Implementation walkthrough

Three separable slices (one concern each):
1. **Wrap-frame single generation (S1-5):** generate commands once per wrap frame; per-half
   re-run ONLY the culling-volume computation, PVS binning, and execution. Step 0: probe-first —
   propose NEW `probe-2d-wrap-single-generation.mjs` (extend `probe-2d-cv-modes.mjs`, which
   exists in `Tools/visual-regression/`): camera straddling the antimeridian in 2D, assert
   BEFORE (2× `updateAndRenderPrimitives` per frame — instrument) then AFTER (1×) with
   byte-identical pixels on both halves. Trap: some primitives read
   `frameState.cullingVolume`/viewport during `update()` — audit `update()` implementations for
   viewport-dependence (rule 3: any producer that genuinely depends on the half must keep the
   re-run — enumerate, don't assume; the deep dive claims viewport-invariance but the audit is
   the slice's Step 1).
2. **Empty-band block skip (S7-6a):** in the frustum loop, skip the fixed per-band scaffold
   (uniformState.update, per-band repack, pass boundaries) for bands whose command bins are
   empty. Interaction: C10-01's sky-only fallback (2 frusta with sky in the far band) — sky
   bands are NOT empty; only truly-empty bins skip. The C9-07 canvas-clear contract must hold
   (an all-empty frame still presents the background — see `NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-
   PARITY` in standing-reds; don't collide, just don't regress).
3. **Ortho near/far fit (S7-6b):** tight command-extent near/far for ortho 3D (content-fit like
   3D log-depth already gets) so 3 bands become 1–2 where content allows.
   Plus the 2D BV-less audit rider (grep fork command producers for 2D-mode pushes without BVs;
   file findings, fix only pass-ENVIRONMENT-class offenders per C10-01's pattern).

#### Traps

1. 2D/CV is the fork's least-covered mode — visual gates are thin. Every slice needs its own
   2D probe capture, not just globe-default.
2. `repackPerSlice=true` in 2D is CORRECT (per-band frustum uniforms genuinely differ) — the
   skip is for EMPTY bands only; do not extend the 3D `repackPerSlice=false` sharing into 2D.
3. Morph frames (3D↔2D transitions) exercise both paths in one frame — run the morph probe
   (`probe-model-scene-modes.mjs` + collections 2D/CV probes).
4. Cross-item: S1-5's single-generation makes the 2.0 S1-6 tier's job easier but does not depend
   on it — safe to land first.

#### Verification recipe

`probe-2d-cv-modes.mjs` (exists) + new wrap probe; collections 2D/CV probes
(`probe-collections-regression.mjs`); `capture-and-diff.mjs` with 2D scenes at wrap and non-wrap
camera; band-count + uniformState.update counters (debug-pragma) as the headline evidence;
on/off/restored per slice. Perf claims: 2D lanes are OFF the canonical route — evidence is
counter-based + a dedicated 2D moving lane if the orchestrator wants a promotion claim
(propose: extend run-performance-campaign with a `--workload moving-2d-wrap` lane; otherwise
land as counter-evidenced correctness-neutral wins, NO p95 banner).

#### Model tier + effort

Slice 1: **fable** for the viewport-dependence audit, then opus-or-sol execution. Slices 2/3:
**opus-or-sol**. M total (2–3 batches).

---

### 2.3 `S2-2` / `S2-3` / `S2-4` — cache-hit-path allocation riders — P2 · S (three one-screen slices)

#### What + why

Three verified allocate-on-hit patterns (deep-dive S2): (a) **S2-2** — shadow/CSM cast path
builds `extraEntries` arrays + `{binding, resource}` objects per caster per frame BEFORE the
`cmd._shadowCastBindGroup` cache check (~120 K allocs/sec @100 casters ×4 cascades);
(b) **S2-3** — `WebGPUBindGroupCache` builds its string key on EVERY lookup including hits, and
six PP effects pay caller-side entries arrays + key strings per frame by design (the in-repo
`WebGPUGlobeBindGroupCache` docstring cites this exact flaw); (c) **S2-4** — TAA resolve creates
an uncached GPUBindGroup every frame despite a 2-state ping-pong input tuple (~20-line fix).

#### Architecture today (verified at `5b98ab9698`)

- S2-2: `WebGPUShadowMapRenderer.js` — `const extraEntries = []` :1312, `.push({...})` :1324,
  cache check AFTER at :1333-1337 (`let bg = cmd._shadowCastBindGroup` + layoutKey/sharedUB
  compare), create at :1347 spreads `...extraEntries`. Same shape in `WebGPUCSMCastPass.ts`
  :517/:533/:554. **C10-10 (B695) did NOT hoist this** — it changed caster COLLECTION, not the
  cast bind-group path. Premise live.
- S2-3: `WebGPUBindGroupCache.ts` — keyParts :188-205, `join("|")` :208, delete+set touch :217,
  LRU :244; self-documented flaw in `WebGPUGlobeBindGroupCache.ts` (:56-67 at deep-dive time).
  Effects consumers: Bloom/AO/DoF/AutoExposure/GodRay/HeatShimmer (deep-dive anchors).
- S2-4: `WebGPUTAAEffect.ts` — `createBindGroup` :664, per-frame `new Uint32Array(p.buffer)`
  :622.

#### Implementation walkthrough

Each is its own commit:
1. **S2-2 hoist:** move the cache-validity check (bind group present + layoutKey + sharedUB
   match) ABOVE the extraEntries walk; build entries only on miss. Zero behavior change. Both
   files. Verify with `probe-c10-10-shadow-single-sweep.mjs` (exists, B695) + `probe-csm-cast-
   dispatch.mjs` — cast dispatch counts and umbra pixels byte-identical; add a debug counter
   asserting 0 entries-builds on settled shadowed frames.
2. **S2-3 effects adoption:** per-effect cached bind group keyed on (sourceView identity,
   generation), invalidated on resize — the `_executeSinglePassStage` pattern already in
   `WebGPUPostProcessPipeline.ts`. Do NOT rewrite `WebGPUBindGroupCache` itself in this slice
   (consolidation with the globe cache is invited by its docstring but is its own concern; note
   for C9-23's audit). Verify: PP probes (`probe-taa-jitter.mjs`, bloom/AO probes of record,
   `diag-taa-black.mjs` stays green), settled key-build counter = 0.
3. **S2-4 TAA two-slot parity cache:** `_taaBindGroups[frameIndex & 1]`, invalidate on
   resize/history-realloc/placeholder swap; hoist the Uint32Array view. Verify:
   `probe-taa-jitter.mjs` + `probe-taa-model-skinned-velocity.mjs` byte-identical; resize + HDR
   flip mid-run exercised (the invalidation axes).

#### Traps

1. S2-2: `_shadowCastBindGroup` invalidation nulls the bg (:1131 / :1306 comment) — the hoisted
   check must treat `undefined` bg as miss INCLUDING when layoutKey matches (deleted-texture
   recovery path).
2. S2-3: the ping-pong/source views in PP effects change identity on HDR toggle and resize —
   generation must incorporate the pipeline's format generation (C10-03's demand-resolve landed
   B697 changed WHEN resolves happen; the resolve TEXTURE identity consumed by PP is what keys
   the cache — verify against the post-B697 flow, the deep-dive anchors predate it).
3. S2-4: TAA history realloc on viewport change is the classic stale-view crash — the two-slot
   cache must be cleared in the SAME code path that reallocs history, not lazily.
4. Cross-item: S2-1 (collection resolver closures) looks adjacent but is OWNED by C9-27's
   acceptance clause (entity-scale cluster) — do not absorb.

#### Verification recipe

Per-slice probes above; `capture-and-diff.mjs` shadows + PP + TAA scenes byte-band;
`NEW-WEBGPU-SCENE-PASS-MSAA-FLIP-TRANSITION` is a standing red in this neighborhood
(standing-reds cluster) — run the msaa-flip repro before/after to prove no interaction, and do
not claim its fix. Allocation evidence via API-lane counters; promotion stance: counter-evidenced,
no p95 banner expected (S-class).

#### Model tier + effort

**opus-or-sol** all three. S (1 batch for all three commits, or split 1+1).

---

### 2.4 `NEW-CLUSTERED-ENABLED-ZERO-LIGHT-FRAME-ZERO-WORK` — P2 · S

#### What + why

C9-16 certified the DISABLED path zero-work (B679, tests+gate only). The residual (DW ~5335,
verified live then and re-verified now): clustered ENABLED + zero effective lights still, every
frame, allocates fresh `lights[]`/`areaLights[]`, ends+resumes the canvas render pass, and calls
`dispatcher.dispatch(...)` which unconditionally writes the 32 B params UBO and re-allocates the
buffers-stash literal. Not on any default path (`_clusteredLightingEnabled=false`); behavior
locked by the B679 cert. The fix is fully designed in the C9 guide §C9-16 Step 1 (~40+10 lines) —
this dossier carries it forward unchanged.

#### Architecture today (verified at `5b98ab9698`)

`WebGPUSceneRendererClusteredLighting.ts` **untouched since B661** (git log: 374f193f8a latest)
— B679 changed only tests/probe. Anchors: `context.endCurrentRenderPass?.()` :189; fresh
`lights`/`areaLights` arrays :198/:209; buffers-stash literal :363 region; resume :379 (+ other
resume sites :192/:315). Dispatcher `WebGPUClusteredLightingDispatcher.ts`: unconditional params
`writeBuffer` :365 (constructor initial write :217). Premise CONFIRMED at HEAD.

#### Implementation walkthrough

Execute the C9 guide §C9-16 Step 1 design verbatim (it was premise-verified then and the file is
unchanged): dispatcher last-written `(activeCount, areaCount)` tracking → skip the all-zero→
all-zero write; hook: module-level scratch arrays reset by `.length=0` (dispatcher copies inputs
out synchronously — verified, no retention); zero-light settled frames publish the
identity-stable buffers stash, set `_clusteredLightingActive=false`, and return WITHOUT pass
end/resume or dispatch; decide zero-work BEFORE ending the pass. Preserve the eight C9-16
invariants — notably #4 (stash identity stable — never flip real↔placeholder, it churns the
effects BG cache, which is item 1.2's memo input: **cross-item — landing this makes S9-2's
hit-rate honest in clustered scenes**), #6 (N→0 transition writes exactly once), #7
(multi-context WeakSet), #8 (params keeps COPY_SRC).

#### Traps

1. Every enabled-path early return AFTER `endCurrentRenderPass` must resume — the zero-work
   return must be BEFORE the end (C9-16 trap; the :315 resume site is the template of what to
   avoid needing).
2. The scratch-array conversion touches the enabled-WITH-lights path too. The C9 guide's
   decision point stands: if you find any retention of the input arrays beyond `dispatch()`,
   STOP the scratch sub-slice, land only zero-light gating with fresh arrays on transition
   frames.
3. Gate zero-work on BOTH `_paramsData[4]` (punctual) and `[5]` (area) being zero.
4. The B679 unit spec's "enabled with zero effective lights" case asserts TODAY's behavior —
   tighten it in the same commit (zero writeBuffer / zero end-resume / stable identity + the
   N→0 transition case) or the suite goes red.

#### Verification recipe

`probe-clustered-zero-work-route.mjs` (exists, B679) — add the enabled-zero-light phase asserting
zero per-frame work; `probe-clustered-per-frame.mjs` / `probe-clustered-dispatcher.mjs` /
`probe-clustered-multifrustum.mjs` stay green; `probe-clustered-matsweep.mjs` +
`probe-clustered-phong.mjs` for enabled-path visual byte-identity after the scratch conversion.
Karma spec tightening per trap 4. No p95 claim (off-default path); counter oracle is the
acceptance. On/off/restored: enabled-zero-light → add a light (N=1 write + compute) → remove
(one zero write) → settled zero-work.

#### Model tier + effort

**opus-or-sol** — the design is fully pre-written and re-verified. S (1 batch).

---

### 2.5 `C9-08` octree persistence — `NEW-SCENEOCTREE-DIRTY-REVISION-REBUILD-AND-PVS-PROMOTION` — P2 · M

#### What + why

C9-08 landed the default-path demand gate (zero work at defaults). The deferred acceptance
clause (DW ~5312): an ENABLED SceneOctree rebuilds every frame (`build()` clears + re-inserts),
and auto-promotion is forbidden until (a) a revision/dirty signal lets static sets skip rebuild,
(b) a measured proof it beats ordinary Scene PVS on the moving route with >200 primitive
commands, (c) the on/off/restored oracle. Strictly opt-in (`scene.renderScheduler.octree.enabled`
default false) — zero default-path exposure.

#### Architecture today (verified at `5b98ab9698`)

`packages/engine/Source/Scene/SceneOctree.js`: `build(commandList, frameNumber)` :121;
`this._root.clear()` :133/:153; `this._root.insert(command)` :161. Consumer:
`ViewportExecutor.js`. Probe in tree: `probe-scheduler-octree-demand.mjs` (asserts default
zero-work + demand-gate byte-identity; extend case E). The C9 guide G4 invariants **I-5..I-9
carry forward verbatim**: octree never owns terrain/3D-Tiles/voxels selection
(OCTREE_ELIGIBLE_PASSES = OPAQUE, TRANSLUCENT only — do not widen); conservative bounds or
bypass (unbounded ⇒ execute, never drop); dirty/revision rebuild with "when in doubt, rebuild";
NO auto-promotion in this slice; containment reporting stays truthful (update
`RenderSchedulerSpec.js` in the same commit as any behavior change).

#### Implementation walkthrough

1. **Revision signal (I-7):** conservative dirt = (eligible-command-set membership change ∨ any
   member BV change). Without a per-command BV revision (S1-6 territory again), use the
   documented conservative hash (count + BV-center component sum) — the C9 guide explicitly
   blesses it; when in doubt, rebuild.
2. **Case-E parity lane (b):** extend `probe-scheduler-octree-demand.mjs` with a >200-command
   scene running octree-on vs octree-off: identical executed-command SETS (order may differ
   within a bin — assert set equality, and pixel byte-band), plus timing capture for the
   beats-PVS question. The measured comparison is EVIDENCE for a future promotion decision, not
   a promotion (I-8).
3. Root-bounds bypass repair if still present (I-6 / trap T-5 of the C9 guide: commands not
   fully containable under root bounds must bypass, not sit at the root where the root sphere
   test can wrongly cull them) — re-verify whether C9-08's landed slice fixed T-5; if it did
   not, that is a CORRECTNESS sub-slice and goes first.

#### Traps

1. Do not let the dirty-hash false-negative: BV-center-sum collisions are possible in theory —
   the hash includes count AND sum; add a debug-pragma'd full-compare cross-check sampled every
   N frames (same pattern as C9-17 Slice B's debug cross-check).
2. The octree is a post-selection conservative FILTER (I-5) — the parity oracle is "octree
   output ⊆ PVS output ∧ nothing visible lost", i.e. never fewer pixels than PVS renders.
3. Cross-item: C10-10's caster sublist and the octree both walk commandList — no shared state
   today; keep it that way (the octree must not consume `shadowState.casterCommands`).

#### Verification recipe

`probe-scheduler-octree-demand.mjs` case E extended (set-equality + pixel band + rebuild-skip
counters: static scene settles to 0 rebuilds; one moving primitive ⇒ rebuild); default-path
byte-identity re-run (existing cases); `RenderSchedulerSpec.js` updated in-commit. No promotion
claim of any kind; the ledger row records the measured PVS comparison as data.

#### Model tier + effort

**opus-or-sol** (invariants pre-written), with **fable** only if the I-6/T-5 re-verification
turns up the wrongly-culled-at-root correctness bug (then it becomes diagnostic-first). M
(1–2 batches).

---

### 2.6 `C10-10` follow-up — revision-maintained shadow-caster sublist — P2 · M · **BLOCKED (do not schedule)**

#### Dossier

B695 folded caster collection into the single PVS walk (verified at HEAD: `View.js`
`isShadowedPass[]` :33-37, `this._shadowCasters` :141, collection :242/:292, published via
`frameState.shadowState.casterCommands`). The banner was honestly NOT claimed: offline scenes
have K≈N and static casters, so the eliminated redundant `updateDerivedCommands` was a cheap
early-return. The TRUE win (N≫K with re-dirtying globe/tile casters) requires a caster sublist
MAINTAINED by revision across frames instead of rebuilt per PVS walk — which requires commands to
HAVE revisions, i.e. the S1-6 retained-commandList tier. The C10-10 ledger row itself records
this blocking (Principle 9 follow-up).

**C11 stance: arch-seed rider on S1-6 — not schedulable.** The only C11-schedulable piece is
already covered by S1-6 increment 1 (instrumentation: per-frame K, N, re-dirty counts on a
shadowed lane, so the future win is quantified before it is built). If the orchestrator opens a
shadowed benchmark lane for other reasons, add those counters there. Premise verified at HEAD;
nothing further to verify until S1-6 exists.

**Model tier:** n/a (blocked). Effort when unblocked: M.

---

### 2.7 WebGL near-ground seg5 p99 GC-tail (no ID) — P3 · diagnostic dossier

At the C9-30 checkpoint, WebGL seg5 p99 rose 65.8→70.6 ms with ZERO WebGL code changes —
suspected allocation/GC pressure in the SHARED scene path (C10Q §4 row (d): next-campaign seed,
note-only for C10-30 noise budgeting). PREMISE-UNVERIFIED at HEAD: this is a measurement
observation, not a code finding — nothing to grep. A worker must first REPRODUCE it on the
current tree (clean lane, ≥5 reps, both backends) before any attribution; it may be environmental
(the Karma/Edge instability cluster lives in test-infra) or it may be real shared-frontend
allocation (in which case items 2.1/2.3 and the S1-6 counters are the treatment and this row is
their measurement shadow). If reproduced: heap-profile the seg5 window (DevTools protocol
allocation sampling via the perf runner), attribute to allocation sites, and file concrete rows —
do NOT optimize blind. **Model tier: fable** (pure diagnosis/bisect). Effort unknown (S for the
repro, unbounded for the chase — timebox it).

---
---

## Cross-cluster interaction matrix (this guide's items × landed B683-699 work)

| Landed | Interacts with | Nature |
|---|---|---|
| B693 C10-01 one-frustum default | S9-2 (frustum-loop view mint), S9-4, S7-6, S1-6 | Multipliers shrank from 2→1 at defaults — re-baseline all "per frustum" quantities before claiming wins; `probe-frustum-count-3d.mjs` must stay green through every frame-delta change |
| B694 C10-09 prev-buffer revision-skip | C9-17 D4 (material dirty-gate) | Precedent pattern; D4 needs its own revision signal, not C10-09's |
| B695 C10-10 single-sweep | S2-2 (did NOT hoist extraEntries — verified live), 2.6 (its own follow-up), 2.5 (both walk commandList) | S2-2 premise survives; 2.6 blocked on S1-6 |
| B697 C10-03 demand resolve | S2-3 (PP source-view identity post-B697) | Re-verify which resolve texture PP consumes before keying caches |
| B699 C10-02 twin gate | C9-17 Slice D (retained translucent keyed on gate), S11-1 remainder (define-flip interplay), new `NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS` | Gate value is per-frame-fresh by design — retention must key on it |
| B687/688 C9-17 A+B | Slice D (foundation), S9-2 (labels/counters), S11-1 (group-1 invalidation via featureIdEntries identity) | The A-cache invalidation IS the mechanism S11-1's flip rides on |
| B679 C9-16 cert | 2.4 (its spec asserts today's behavior — tighten in-commit) | Suite red if forgotten |
| B682 C9-11 hoist | S9-2 per-tile half (terrain cluster owns call-site adoption) | Shared module lands here, terrain adopts there |

---

## OPEN QUESTIONS for the orchestrator

1. **C10-30 dependency (the big one):** `C9-17 Slice D` opens ONLY on C10-30 (or recorded C9-30)
   attribution naming model-frontend allocation. C10-30 was NOT STARTED at `5b98ab9698`. Please
   sequence this guide's Slice D (and its dependent S9-3) AFTER the checkpoint verdict is
   ledgered — or rule explicitly that the C9-30 PROMOTE verdict's attribution suffices. The
   independent riders (S9-2, S11-1 remainder, all of frame-delta) do not wait.
2. **S1-6 disposition:** the register lists it P1/XL in arch-seeds; the cluster direction routes
   it through frame-delta for schedulability marking. My split: increment 1 (instrumentation,
   S) + increment 2 (S1-3) are C11-schedulable; the tier proper is the Campaign-12 anchor.
   Confirm, and decide whether increment 1 gets its own register row.
3. **C10-11/12/13 outcomes** do not gate any item in these two clusters directly, but S2-3's PP
   cache keys touch depth/resolve textures — if C10-11's pick-fleet conversion lands mid-C11,
   re-verify the PP source-view identity assumptions (trap noted in 2.3).
4. **2D perf lane:** items under S1-5/S7-6 cannot make route-p95 promotion claims without a 2D
   moving lane in `run-performance-campaign.mjs`. Decide: add the lane (S, tooling — could ride
   the 10k-entity-lane work in entity-scale) or accept counter-evidence-only landings.
5. **Maintainer decision needed (from B699 fallout, adjacent to this cluster):**
   `NEW-WEBGPU-ALLTRANSLUCENT-PRIMARY-SUPPRESS` needs a pick derivative on the translucent twin
   before the primary can be suppressed — schedule it in the pick cluster or as a C9-17 Slice-D
   rider? It is registered nowhere else at this writing (filed by B699's commit message; confirm
   a DEFERRED_WORK row exists at intake).
6. **Sequencing constraint inside model-frontend:** S9-2 → (gate) Slice D → S9-3 is hard-ordered;
   S11-1 and S9-4 float freely. Inside frame-delta: 2.3 and 2.4 float; 2.1 benefits from S1-6
   increment 1 landing first (attribution); 2.5 independent; 2.6 blocked; 2.7 is a
   diagnostic-lane item that should run EARLY (it informs C10-30/C11 noise budgets).
7. **Effects-BG consolidation** (S2-3's long-term "adopt the globe-cache contract everywhere" +
   S9-2's memo + C9-17 D2's scene-wide BG) — three items converge on one subsystem from three
   clusters. If all are scheduled, order them S9-2 → S2-3 → D2 and tell the workers about each
   other; ideally one owner.

---

*Guide ends. 13 items covered (5 model-frontend, 7 frame-delta, +S1-6 tier dossier). All
anchors verified against `5b98ab9698`; drift from source docs noted inline. No C11-XX numbers
assigned — register names only.*
