# Local, staged, and committed change audit — 2026-07-31

## 1. Scope and verdict

This audit covers the state inherited from the Claude/Fable handoff through the current Sol review:

- the checked-out `main` branch and its relationship to `origin/main` and Cesium upstream;
- every staged, tracked-dirty, and untracked file in the primary worktree;
- the seven registered Claude worktrees and the unique or superseded content they contain;
- the recent committed batches after the 2026-07-25 handoff; and
- the active Campaign 11 renderer/performance work, with Campaign 12 and 13 documentation truth checked at the same boundary.

**Verdict:** the active tree is buildable and the reviewed architecture is directionally sound. No performance feature was removed or disabled. The review repaired correctness/lifetime defects, removed avoidable hot-path work, and hardened the representative benchmark so attribution is untimed and exact workload identity is enforced. The current attribution proves work avoidance; it does not by itself certify a timing win.

The current evidence does **not** support blaming globe quadtree traversal, RTE, or the common moving-camera renderer path for the reported large regression. A valid globe-only altitude route is near parity. The latest resident comparison has exact camera and terrain identity but rejects the pair because San Francisco 3D Tiles reach different content-ready/selected states. That is a backend-coupled readiness/request-lifecycle seam under `C11-205`, not evidence authorizing a traversal or SSE change. Campaign 11 therefore remains open at the measurement gate.

## 2. Repository truth

Audit boundary:

- primary branch: `main`
- primary HEAD: `fe990ab335` — Batch 771
- `origin/main`: `fe990ab335` — byte-identical to local HEAD
- upstream comparison ref: `upstream/main` at `2aa87f5c0e` (2026-07-30 refresh)
- upstream merge base: `7984bb31d8`
- fork divergence at audit time: 1,066 fork-only commits and 146 upstream-only commits
- complete fork/upstream file delta: 2,724 files, 816,897 insertions, 126,086 deletions

Primary-worktree state at the start of this review:

- staged files: **0**
- tracked dirty files: **110** at intake; **130** at the current audit boundary after reviewed fixes and generated-source refresh
- untracked files: **31** at intake; **40** at the current audit boundary
- intake tracked delta: 11,723 insertions / 1,668 deletions
- no reset, checkout, clean, stash, commit, or push was performed

The dirty tree is not one atomic changeset. It contains several campaign lanes that must remain reviewable and land separately: eclipse/atmosphere, WebGL shader scheduling, WebGPU globe/resources, WebGPU model and primitive shadows, Hi-Z conservative fallback, performance tooling, tests, and documentation.

## 3. Staged-change audit

There are no staged changes. This is the correct state for an in-progress multi-lane review: the index does not falsely imply a coherent landing unit, and no file is hidden from the working-tree audit by partial staging.

Before any future commit, changes should be staged by their campaign owner rather than by directory or by `git add -A`. In particular, benchmark-harness corrections and campaign-document reconciliation should not be accidentally bundled into renderer correctness code.

## 4. Recent committed-change audit

The committed review boundary after the handoff contains:

| Batch | Commit | Review result |
|---|---|---|
| 769 | `e435d7b420` | Tide phase/origin and WebGPU ocean-tile uniform regressions were corrected with focused specs. The changes are logically independent of the active shadow/performance lane. |
| 770 | `0679b0e456` | Eclipse totality, atmosphere/star dimming, and environment-command ownership landed as a large but internally connected feature slice. Current pure Node eclipse contracts pass 138/138. The working tree adds follow-on S5/S6 correctness and RTE coverage; those additions are not yet a committed claim. |
| 771 | `fe990ab335` | Documentation-only seed for Atmospheric Effects Phase F. It adds no runtime performance or correctness risk. |

The branch is published through Batch 771. Documentation that still says Campaign 13 publication is blocked by HTTP 403, or that Batch 770 work is merely pending landing, is historical text and must not be read as current status.

The broader upstream delta remains too large to treat as a conventional patch review. Its durable review unit is the fork feature/campaign inventory plus upstream-port owners. The current high-value upstream-port findings remain:

- model topology/primitive-mode parity under `C11-90`;
- typed edge-index representation as an atomic loader/decoder/emitter port under `C11-137`;
- upstream `Texture.defaultColor` and billboard `alignedAxis` changes under `C11-137`; and
- Generic Primitive's remaining legacy CPU realization under `FAR-201` / `FAR-209` / `FAR-210`.

The audit also removed one tracked generated-file accident at
`packages/packages/engine/Source/Shaders/WebGPU/chunks/CsmBuiltins.js`. It was
an 86-byte empty generated placeholder under a duplicated `packages/packages`
root, had no consumers, and was not the canonical generated 12 KB registry at
`packages/engine/Source/Shaders/WebGPU/chunks/CsmBuiltins.js`.

## 5. Registered worktree audit

The registered Claude worktrees are not interchangeable landing candidates:

| Worktree | Disposition |
|---|---|
| `agent-a06f93c6892cba472` | Stale tides lane. Do not land or delete without maintainer confirmation. |
| `agent-a480e24d73c9b7c96` | S6 implementation superseded by Batch 770. No direct landing. |
| `agent-a578d39752cd7819c` | Contains a unique globe-pipeline readiness harness. Preserve and reconcile deliberately. |
| `agent-a68f438fcb2e102c1` | Contains a unique pipeline-alias detector. Preserve the detector; reject the caller-name key workaround and solve semantic keys centrally under `C11-19`. |
| `agent-a6de88899b2982d6c` | S5 implementation superseded by Batch 770; preserve only the unique NASA/SVS oracle material. |
| `agent-aa59196f79bb47e99` | Contains a unique environment-clear change. Preserve/rebase only after hardening its `null` versus `undefined` API semantics. |
| unregistered `agent-a4a8...` directory | Only a cleanup candidate for duplicated dependencies; deletion requires explicit approval. |

The important rule from the handoff remains valid: do not edit `main` merely to describe in-flight worktree content. Reconcile or extract each unique artifact with its owning lane, otherwise one documentation edit can conflict with several worktrees at once.

## 6. Local renderer review and fixes

### 6.1 Resource lifetime and backend ownership

The local design correctly keeps logical Cesium scene objects backend-neutral while allowing backend-native realizations to be retained and destroyed by their owning collection/cache. This avoids forcing WebGPU to construct WebGL GPU resources merely to obtain a native WebGPU equivalent.

Corrections made during this review:

- `PointPrimitiveCollection` now retains and deterministically destroys its collection-scoped WebGPU feature-renderer resources exactly once.
- `LabelCollection` now does the same for its WebGPU label SDF/uniform/placeholder resources while preserving its child billboard collections.
- the model shadow uniform buffer records the device that created it and is recreated after destruction or a device change; a stale live buffer is destroyed before replacement.
- the CSM renderer owns and destroys its terrain-global uniform buffer and raw cascade buffers explicitly.

`C11-20` is therefore **PARTIAL**, not complete. Point and label normal teardown are covered, but nested model/tileset/clipping caches and device-loss teardown still require the systematic audit.

### 6.2 Shadow correctness and RTE

The shadow architecture remains feature-preserving: one fitted native directional/spot pass when CSM is off, native CSM and point-light paths, explicit cast/receive ownership, and no routing of native WebGPU commands through WebGL derivation.

Corrections made during this review:

- shadow-map initialization receives the active `frameState`, not a bare context;
- viewport execution refreshes shadow receive state against the current frame's context;
- terrain shadow globals are stamped for both quantized-12 and uncompressed terrain layouts;
- the terrain-global upload uses one renderer-owned 16-byte buffer and direct `queue.writeBuffer`, avoiding a per-command typed-array allocation;
- invalid, zero, stale, or unrepresentable current-command bounds fall back conservatively rather than disappearing;
- primitive shadow casts reuse the camera high/low split already computed for the color path, avoiding a second matrix inverse;
- model-node shadow packing reuses the camera values already present in the camera UBO, also avoiding a second inverse; and
- model shadow resources are guarded across device recovery.

These fixes improve correctness and reduce CPU work without changing shadow visibility policy. `C11-184` remains **IN PROGRESS** until focused browser execution, moving shadow pixels, Earth-scale motion, toggle transitions, and settled upload/allocation evidence are green.

### 6.3 Hi-Z conservative fallback

`SOABoundingSphereLayout` now accepts only finite, positive values representable as exact binary32 sphere fields. Anything skipped, degenerate, over-capacity, or not exactly representable remains in original-list identity/order and passes through conservatively.

This is the narrow `C11-187` contract. It does not activate Hi-Z, assert depth provenance, or claim occlusion performance. Source and focused tests are present; the browser runner has not produced a completed focused Karma result, so the row remains **IN PROGRESS**.

### 6.4 Hot-path allocation review

Confirmed improvements:

- `WebGPUEffectsBindGroup.update` no longer allocates a new `Uint32Array` view per update; it reuses the existing scratch view.
- primitive and model shadow paths no longer repeat an already-computed camera inverse/split.
- CSM terrain-global upload no longer creates a transient typed view per command.
- collection teardown prevents retained native caches from growing across viewer recreation.

No evidence currently supports removing passes, reducing effects, weakening culling, or disabling shadows/clouds/post-processing. Such changes would violate the feature-preservation rule and would not address the measured representative-only CPU gap.

### 6.5 Visibility-triggered model preparation

The representative audit confirmed that native Model preparation occurs before
Cesium's PVS: off-camera standalone models still packed camera/material/light
state and emitted commands that were culled only later. This is distinct from
the Generic Primitive legacy-object realization under `FAR-201`.

`C11-185` Slices 1–3 now perform deliberately conservative admission and
demand realization. A cached five-plane Scene/frame snapshot rejects only a
finite, cullable standalone model outside the ordinary SCENE3D color view.
Minimum-pixel-size models and every shadow/capture/tile/classifier/pick/2D/
stereo/unknown case retain the old path. Readmission resets root, node, joint,
and morph history to current so TAA velocity does not span a rejected gap.

Native custom-shader work is skipped only when no native shader can consume
it, transient material `DataView` allocation is removed, and the root camera/
RTE block is realized only when the first pipeline-backed emitted command
actually consumes it. Tile-owned transformed nodes keep their exact per-node
RTE block.

The current API-attribution route covers 1,088 moving frames: 53,821
candidates conserve exactly into 20,384 admitted view candidates, 1,597
conservative tile-owned candidates, and 31,840 frustum rejects. The 21,981
admitted runs account exactly for 21,981 camera packs/writes, effects,
material/light preparation, and command builds; custom-shader preparation and
unchanged material uploads are both zero. This proves avoided work without
claiming a causal timing percentage. Focused browser execution and a clean,
exact, counterbalanced timing pair remain open.

### 6.6 Build-integration corrections

The canonical build uncovered issues that `tsc --noEmit` alone could not:

- `WebGPUShadowCastBindGroupCache.js` needed a default export because the generated public engine index exports every source module's default;
- runtime `ShadowMode` and globe-translucency fields needed honest local declaration/structural typing rather than unsafe cross-module assumptions; and
- the optional model inverse-view rotation type needed to match its actual `Matrix3` payload.

The package-level TypeScript build and the full gulp build are now green.

### 6.7 Model primitive topology audit

`C11-90` is broader than its original POINTS name implied. POINTS and TRIANGLES
are currently correct, while LINES, LINE_LOOP, LINE_STRIP, TRIANGLE_STRIP, and
TRIANGLE_FAN collapse to triangle-list. Upstream now has concrete
`KHR_mesh_primitive_restart` line/strip/fan assets, so this is a real P1 parity
tail rather than a hypothetical enhancement.

The fix must be atomic: a cached backend realization maps list/strip topology,
closes loops, expands fans, translates uint8 restart `0xFF` to uint16 `0xFFFF`
only for restart-capable modes, and synthesizes safe indices for non-indexed
primitives. Every model and shadow pipeline key/descriptor must carry both
topology and `stripIndexFormat`; uint16 and uint32 strips cannot alias. The
conversion belongs in preparation, not draw execution. This row does not
explain the current representative performance regression and should run after
the measurement lane, before Campaign 11 closure.

### 6.8 Post-attribution architecture corrections

The review implemented several feature-preserving corrections:

- `C11-192` realizes and uploads terrain shadow-cast uniform buffers only when
  a shadow pass demands them; the first enabled frame still builds the complete
  shadow state.
- `C11-199` gives each pending model pipeline descriptor one generation-owned
  promise and prevents stale async completion from replacing newer state.
- `C11-200` equality-gates manual tonemap exposure writes while leaving
  genuinely changing auto-exposure data dynamic.
- `C11-201` publishes the globe-depth target's stable cached view instead of
  creating a new `GPUTextureView` identity every frame. The current moving
  attribution run created the same 389 bind groups as the prior artifact,
  confirming this is a view-wrapper allocation/lifetime correction rather than
  a bind-group or timing win on this workload.
- `C11-211` updates every runtime-node transform first, updates the complete
  joint palette once, then updates primitives. This removes an inherited cost
  approaching runtime-nodes × skinned-nodes × joints and also fixes ordering.
- the narrow `C11-193` allocation slice passes the tileset-owned environment
  manager into each tile model at construction. Standalone models still own a
  private manager, and model replacement/destruction cannot destroy the
  borrowed tileset resource.
- the narrow `C11-194` lifetime slice now destroys the cache-owned default
  property texture with the rest of the model pipeline cache; device-generation
  sharing of immutable defaults remains separate, open architecture work.

Canonical build, focused lint/format, engine TypeScript, and source contracts
are green for these slices. Animated model pixels, shadow-ON pixels, and the
stable-depth attribution rerun remain browser-owned gates rather than assumed
passes.

## 7. Test and verification evidence

Green evidence at this boundary:

- `npx tsc --noEmit --pretty false`
- package TypeScript: `tsc --project packages/engine/tsconfig.json`
- canonical `npx gulp build`
- focused ESLint and Prettier for reviewed source/test files
- performance-workload Node contracts: 45/45, including untimed deterministic
  content replay, exact resident workload identity, direct-model identity that
  is independent of emitted commands, and global action-rAF cleanup ownership
- eclipse/globe/atmosphere Node contracts: 138/138
- `git diff --check`
- all 28 modified WGSL sources have regenerated wrappers newer than their sources
- all 20 untracked engine specs are present in generated `packages/engine/Specs/SpecList.js`

Unavailable evidence:

- the documented focused `EdgeHeadlessCI` Karma command reached the launcher but executed no tests and timed out. It is recorded as a harness/capture blocker, not as a pass.

Only Karma-owned Edge processes with `karma-edge-*` profiles were stopped during diagnosis. Interactive user Edge sessions were left untouched.

## 8. Moving-camera performance evidence

Idle soak FPS is not accepted because Cesium can stop rendering when nothing changes. Every performance result here uses camera motion and altitude changes.

### 8.1 Valid globe-only control

Artifact: `Tools/visual-regression/output/performance/campaign11-altitude-control-2026-07-31.json`

| Renderer | Frames | CPU avg | CPU p95 | CPU p99 | Avg FPS | 1% low | Wall p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| WebGL | 1,096 | 4.816 ms | 9.300 ms | 12.600 ms | 54.78 | 42.33 | 23.625 ms |
| WebGPU | 1,118 | 5.123 ms | 9.315 ms | 10.700 ms | 55.88 | 47.85 | 20.900 ms |

Both legs completed the route with clean quality, zero page errors, and zero device errors. WebGPU average CPU is about 6.4% higher, p95 is effectively equal, and WebGPU has better CPU p99 and frame pacing. One pair is audit evidence, not a six-pair certification, but it rules against a general globe/RTE/quadtree collapse.

### 8.2 Resident representative route

Artifact: `Tools/visual-regression/output/performance/campaign11-resident-workload-fingerprint-r1-2026-07-31.json`

Both legs completed 600 moving frames with zero terrain requests/generations,
exact terrain identity on every frame, identical 1280×720/DPR-1 presentation,
clean teardown, and no page/device errors. The pair correctly failed exact
comparability in the San Francisco segment: WebGL recorded 710 selected-tile
observations with a maximum of 15, while WebGPU recorded 571 with a maximum of
12. Internal selected statistics and `_selectedTiles.length` agree and there
are no unidentified tiles.

The direct-model mismatch in an earlier draft was a benchmark bug: emitted
commands are not logical model identity when `C11-185` intentionally suppresses
commands. The harness now fingerprints configured/ready model instances in
stable asset order. The remaining 3D Tiles mismatch is real, but current source
places the backend-dependent seam at content processing/readiness and
frame-rate-sensitive request cancellation. The directional timings in this
rejected pair are not a performance claim.

### 8.3 Streaming representative attribution route

Artifact: `Tools/visual-regression/output/performance/campaign11-streaming-c11-185-slice3b-attribution-2026-07-31.json`

Current-bundle follow-up:
`Tools/visual-regression/output/performance/campaign11-streaming-current-attribution-2026-07-31.json`

This API-instrumented run is explicitly attribution-only and non-certifying.
It completed all eight moving segments and 1,088 measured frames with no page
or device errors and clean teardown. Representative content validation now
runs as a bounded deterministic replay after `endPerformanceTrace`, so scene
content scans cannot contaminate render CPU samples. Streaming replay is capped
at 240 frames and reports unequal work as an outcome rather than manufacturing
comparability.

The first route proves exact `C11-185` conservation. The current bundle repeats
that result over 1,031 moving frames and clean queue/device teardown. It also
shows 68 cache-owned default property textures and 52 duplicated
dynamic-environment pipeline packs. The stable depth view leaves total bind
group creation unchanged at 389 pre/post, so only its removed per-frame view
wrapper allocation is credited. Avoidable empty scene-pass transitions remain
visible at four per measured frame. These are queue inputs, not a license to
remove environment maps, post effects, or passes that carry required
clears/resolves.

## 9. Campaign conclusions and next execution order

1. Execute `C11-205` readiness/request-lifecycle evidence and require identical
   ready tile identities before any causal resident timing or traversal change.
2. Keep the implemented `C11-185`, `C11-192`, `C11-199`, `C11-200`,
   `C11-201`, and `C11-211` slices open until their focused browser/moving gates
   execute; implementation presence is not a timing claim.
3. Continue `C11-193` with a selected-consumer demand registry and one
   device-generation kernel/job scheduler; the discarded per-tile manager
   allocation is already removed.
4. Execute `C11-194` shared immutable model defaults and `C11-195` dynamic
   view/light uniform arena using the measured fan-out, preserving per-view RTE
   and device-generation ownership.
5. Keep `C11-184` and `C11-187` open until their shadow/Hi-Z browser gates and
   moving correctness evidence execute.
6. Queue model topology completion under `C11-90`; do not conflate it with the
   current CPU regression without evidence.
7. After Campaign 11 measurement truth is restored, continue Campaign 13 Gate B
   in owner order: `C13-06`, `C13-07`, then `C13-08` once `C13-01` supplies the
   required data/provider evidence.

Campaign status remains:

- Campaign 10: complete.
- Campaign 11: executing/paused certification; non-cloud performance and correctness work remains open.
- Campaign 12: launched and in progress; the false atmospheric aureole belongs to `C12-31`, while direct sun bloom remains `C12-18`.
- Campaign 13: launched and in progress; `C13-03/04/05` are complete, `C13-06/07/08` remain the Gate B tail, and `C13-02` is partial because pass timing landed under `C13-39` while broader counters remain.
- Campaign 14: planned but blocked by the explicit prerequisite that Campaigns 11, 12, and 13 complete first.

## 10. Landing discipline

Nothing in this audit authorizes a commit or push. When landing is requested:

- preserve each campaign's owner and evidence in the same changeset;
- do not combine superseded worktree implementations with their already-landed equivalents;
- do not claim a performance win from invalid or idle evidence;
- do not mark a row complete from build success alone;
- retain WebGL and WebGPU functionality and fallback paths; and
- rerun the canonical build after any public-source addition because generated-index default-export failures are otherwise invisible to the narrow TypeScript gate.

## 11. Orchestrator review addendum — 2026-08-01

A 23-agent Opus review of this uncommitted changeset ran on 2026-08-01. Eight
confirmed defects were fixed pre-landing:

1. compositor `depthStencil` state;
2. WebGPU `cascadesEnabled` sun-shadow regression;
3. environment-map refresh freeze;
4. dead shadow-receive prefix gate;
5. zero-primitive `Model.ready` stall;
6. silent async shader-link failure;
7. unbounded `waitFrames`;
8. false causal provenance.

Doc-truth corrections landed alongside them: `C11-181` restated as IMPLEMENTED /
LANDING PENDING rather than COMPLETE, the two WebGL shader-lifecycle inventory
entries moved from §B (SHIPPED) to §C (WIP), debugging-log status narration
normalized to the log's entry convention, and timing-win phrasing softened to
work-avoidance/attribution language consistent with §8 above. Machine gates are
re-run before landing; §10 still governs.
