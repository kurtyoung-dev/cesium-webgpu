# C12 Moon texture lifecycle audit

**Date:** 2026-08-02  
**Campaign owner:** `C12-35`  
**Scope:** Moon albedo and LOLA normal-map source loading, WebGL/WebGPU GPU
realization, device-generation recovery, feature-toggle lifetime, and the hard
dependency this creates for `C12-33` mip generation.  
**Execution disposition:** the unstaged C12-35 L0-L5 implementation and
certification described below are complete in the current worktree. C12-33 is
therefore unblocked, but its mip/seam/shimmer acceptance remains separate.

## Verdict

`C12-35` is complete in the current worktree. Moon source ownership is shared
only at the renderer-neutral decoded-image layer; WebGL and WebGPU retain
backend/device-local GPU realizations. Both channels use exact
owner/URL/pair/request/context/device/generation identity, publish only from a
frame-owned update, retain matching normal resources across relief off/on,
and cancel/retire stale work exactly once. Scene teardown now deterministically
destroys Moon, closing a lifecycle omission inherited from the 2013 Moon
integration. The strict same-realm Edge gate, focused Jasmine, focused Node,
full Node fleet, type/build, and independent review all pass. C12-33 may now
add mip work on top of this certified ownership substrate.

### 2026-08-02 L0-L5 execution update

`resolveMoonNormalMapStrength` now produces the single scalar published by
`Moon.update` before the renderer branch: URL present plus toggle on resolves
undefined/null to 1, preserves finite nonnegative values, and maps negative,
NaN, and either infinity to zero; toggle off or no URL also maps to zero. Both
WebGL and WebGPU consume that exact scalar, and zero is the common no-new-work
demand signal. Focused behavioral policy plus existing normal-asset contracts
pass 22/22 and package TypeScript is clean.

`WebGPUMoonTextureLifecycle` now owns immutable request identity
`{owner, pair, exactUrl, channel, requestSerial}` and realization identity plus
`{backend, context, device, resourceGeneration, cacheSerial}`. Albedo and
normal serials advance independently. Decode/preparation occurs before GPU
allocation; upload is synchronous on the device queue and uses no private
submission. Every full tuple is revalidated before candidate finalization and
again afterward, so a reentrant finalizer cannot publish into a retired cache.
Current textures remain bound until a replacement is ready; bundle
invalidation, candidate publication, and old-resource retirement are ordered
transactionally. Raw, prepared, candidate, current, placeholder, and late
closeable-source ownership are exact-once. Teardown detaches first, invalidates
the bundle before draining resources, and continues draining if one native
destroy throws. Async settlement wakes request-render scenes through the shared
resource monitor.

The independent review found and closed the original post-upload tuple blocker.
Subsequent L1b/L3 work integrated the shared leases into a frame-owned WebGL
texture lifecycle, bypassed Material's URL loader, and retained matching normal
textures without binding/sampling them while relief is off. L4 removed the
remaining WebGPU steady-frame reconcile allocations, exposed frozen exact-pair
and realization/publication/destruction diagnostics, and added symmetric
disabled-relief state coverage. L5 then exposed and closed two teardown defects:
Scene did not own/destroy Moon, and intentional GPUDevice destruction was
misreported as device loss.

Evidence is now: focused Moon Node 75/75; full visual-regression Node fleet
1,227/1,227; WebGL lifecycle Jasmine 8/8; WebGPU lifecycle Jasmine 9/9;
focused Scene and CesiumWidget teardown Jasmine 1/1 each; device-pool and
device-loss Jasmine 4/4 + 10/10; engine TypeScript and top-level `gulp build`
green. The schema-v2 Edge report is `PASS` with zero failures,
inconclusive items, console/page errors, or GPU faults.

The required order is therefore:

1. `C12-35` — **COMPLETE**; retain its Node/Jasmine/Edge gates.
2. `C12-33` — next: mip chains, mip samplers, derivative-safe Moon sampling,
   moving seam/shimmer evidence, and the optional 2K
   LOLA re-bake.

### Important correction: where the duplicate work actually occurs

A single WebGPU Moon does **not** also fetch or allocate WebGL Moon textures.
`Moon.update` returns through the registered Moon feature renderer before
`EllipsoidPrimitive.update`, Material image loading, or WebGL normal-map
creation runs (`packages/engine/Source/Scene/Moon.js:397-420`). The WebGL normal
loader is deliberately below that return.

The real duplication is:

- split mode constructs independent WebGL and WebGPU Viewers, Scenes, and Moon
  owners (`Apps/CesiumViewer/CesiumViewer.js:294-302,357-366`);
- those owners independently fetch/decode the same albedo and normal sources;
- the WebGPU upload can perform an additional `createImageBitmap` conversion
  when its source is an `HTMLImageElement`
  (`packages/engine/Source/Renderer/WebGPU/WebGPUImageUpload.ts:50-54,89-105,177-186`).

The WebGPU Moon does retain the legacy `EllipsoidPrimitive` and `Material` CPU
objects because shared Scene logic still uses their model matrix and state.
That is a smaller legacy-frontend CPU cost, not a second set of WebGL GPU
textures, and must not be reported as a GPU allocation double tax.

## Current ownership map

All rows below describe the corrected current-worktree ownership. The detailed
Findings preserve the audited Batch-818 mechanism as historical evidence.

| Resource | Current producer/owner | Current lifetime key | Problem |
|---|---|---|---|
| WebGL albedo source | shared `MoonDecodedSourceCache` lease | exact URL + decode axes; Moon owner/pair/request serial | staged asynchronously; realized only in `Moon.update` |
| WebGL albedo texture | Moon lifecycle; adopted by Material | Moon/context/URL/pair/request serial | exact publication; Material never sees a URL loader input |
| WebGL normal source | shared `MoonDecodedSourceCache` lease | independent normal serial + exact pair/demand | matching work/realization retained while off |
| WebGL normal texture | Moon lifecycle | Moon/context/URL/pair/request serial | created only in current frame update; unbound while off |
| WebGPU albedo source/texture | `WebGPUMoonTextureLifecycle` owned by the exact Moon cache | owner/pair/URL/albedo serial/backend/context/device/resourceGeneration/cache serial | source shared; GPU realization device-local |
| WebGPU normal source/texture | `WebGPUMoonTextureLifecycle` owned by the exact Moon cache | owner/pair/URL/normal serial/backend/context/device/resourceGeneration/cache serial + demand | zero demand starts no work; matching valid work retained |
| Decoded image source | bounded realm-shared `MoonDecodedSourceCache` | canonical exact URL + orientation/color/decode axes | ref-counted, cancellation-safe, GPU/context-free LRU |

GPU realizations must remain backend- and device-owned. Only a bounded,
context-free decoded source is eligible for cross-scene/backend sharing.

## Findings

### 1. WebGPU Moon resources had no physical-device identity — CLOSED in bounded L2

**Pre-fix evidence (Batch 818):** `updateWebGPUMoon` created
`moon._webgpuCache = {}` and thereafter trusted object
presence (`packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js:1129-1133`).
The cache does not record its Moon owner, context, `GPUDevice`, or
`resourceGeneration`.

The context already publishes the required epoch:

- `WebGPUContext.resourceGeneration` returns `_deviceResourceGeneration`
  (`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:851-874`);
- recovery increments that epoch even when the replacement device exposes the
  same formats and limits, then fires device invalidation
  (`packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:6720-6748`).

The Moon feature registration supplies `update`, `destroy`, and diagnostics but
does not subscribe each Moon cache to device invalidation
(`packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts:362-370`). A
replacement device, or a same-device generation bump, can therefore encounter
old-generation geometry, buffers, pipelines, bind groups, texture views,
samplers, and render bundles.

### 2. WebGPU async publication could mutate an orphan/superseded cache — CLOSED in bounded L2

**Pre-fix evidence (Batch 818):** the albedo loader used `_textureLoading` plus `_cachedTextureUrl`
(`WebGPUEnvironmentRenderer.js:894-903`). Its callback captures `device` and
`cache`, creates and uploads a texture, then unconditionally destroys/replaces
`cache.moonTexture` (`:904-950`). It never rechecks:

- `moon._webgpuCache === cache`;
- the exact current URL/variant;
- the exact device and `resourceGeneration`;
- a monotonic request serial; or
- whether the Moon/cache was destroyed or superseded.

The normal loader repeats the same shape (`:986-1035`). Consequences include:

- A→B while A loads ignores B until A settles, then visibly publishes stale A;
- A→B→A has no defined request-generation ordering;
- changing a normal URL to `undefined` can bind the flat placeholder and then
  receive the old normal map from the late callback;
- destroying the Moon destroys the currently published cache resources and
  clears `moon._webgpuCache` (`:1664-1710`), but the callback still owns the old
  cache closure and can publish a new unreachable GPU texture into it; and
- if upload rejects after `device.createTexture`, the outer catch cannot reach
  the locally scoped candidate and does not destroy it (`:909-918,952-963` and
  `:999-1008,1024-1035`).

Every stale or failed candidate must instead be destroyed exactly once.

### 3. WebGL normal loading was only partially guarded — CLOSED in L1b/L3

`Moon._updateNormalMapTexture` has a single `_normalMapLoading` Boolean, so a
request for one URL blocks a newer URL rather than giving each request a serial
(`packages/engine/Source/Scene/Moon.js:455-466`). Its success callback checks
only destroyed state and `normalMapUrl` (`:467-487`); it does not check the
exact current enable/demand state, WebGL context, context generation, or
request serial. The rejection callback updates request fields without first
checking that the owner is still live (`:489-493`).

The generic Material albedo path was better at dropping an immediately stale
URL, but it still has no Moon request serial and queues a decoded image for a
later `Material.update` (`packages/engine/Source/Scene/MaterialHelpers.js:451-521`;
`packages/engine/Source/Scene/Material.js:457-528`). A result that was current
when queued could be stale by the time the Material drained it. The current
Moon lifecycle owns both channels, stages only decoded sources from the shared
cache, and realizes a Texture synchronously in the exact current `Moon.update`.
Material receives the adopted Texture rather than a URL, so its legacy loader
cannot issue duplicate or late Moon work.

### 4. Relief toggles had opposite resource-lifetime policies — CLOSED in L3

**Pre-fix residual:** WebGL destroyed `_normalMapTexture` and cleared its resolved URL whenever the
feature is disabled (`Moon.js:441-452`). Turning the same URL back on therefore
refetches and re-uploads it.

WebGPU retains a resolved normal texture when only the lighting toggle changes,
which is the desired lifetime, but it begins a normal request whenever
`moon.normalMapUrl` exists (`WebGPUEnvironmentRenderer.js:1237-1239`) without
consulting the resolved toggle/strength at `Moon.js:388-395`. It can fetch,
decode, and upload relief that cannot contribute. A strength of zero also
starts work on both backends.

The shipped policy is:

- no new normal source/upload work while the exact resolved demand is zero;
- if a valid request began while demand was non-zero, a later off toggle may
  finish and retain the matching source/realization;
- while off, do not bind/sample the WebGL normal map and publish strength zero;
- re-enabling the same URL reuses the retained source and GPU realization;
- a URL/variant/context/generation mismatch retires the old realization rather
  than retaining an incorrectly keyed one.

### 5. Non-finite or negative strength created backend divergence (L0 fixed in worktree)

`Moon.update` publishes `normalMapStrength ?? 1.0` without validating it
(`Moon.js:388-395`). WebGPU samples only when `u.normalStrength > 0.0`
(`packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl:392-406`). WebGL,
once `LUNAR_NORMAL_MAP` is defined, always samples and multiplies by the value
(`packages/engine/Source/Shaders/EllipsoidFS.glsl:62-73`).

At audited Batch 818, a negative value was flat in WebGPU but reversed relief in WebGL; NaN could
poison WebGL normal math while the WGSL comparison is false; infinity produces
undefined normalization. The unstaged L0 resolver now converts the public dial
before either renderer consumes it:

```text
undefined/null default -> 1.0
finite value >= 0       -> value
negative/NaN/infinity   -> 0.0
toggle off/no map       -> 0.0
```

### 6. Split mode duplicated fetch/decode, not cross-backend GPU resources — CLOSED in L1

WebGL albedo calls `Resource.fetchImage` through Material
(`MaterialHelpers.js:451-521`), WebGL normal calls it in Moon
(`Moon.js:465-466`), and WebGPU calls it independently for albedo and normal
(`WebGPUEnvironmentRenderer.js:904-905,996-997`). Split mode owns two separate
Moon instances, so the browser/cache may avoid a second network transfer but
the application still issues separate source requests and may decode the same
image more than once.

The source cache now shares only decoded, context-free input. A WebGL `Texture`
must never be handed to WebGPU, and a `GPUTexture` must never cross devices or
resource generations.

### 7. Render-bundle invalidation was happy-path-only — CLOSED for bounded WebGPU L2

**Pre-fix evidence (Batch 818):** a successful callback cleared `cache.bindGroup` and set `_bundleStale`
(`WebGPUEnvironmentRenderer.js:944-950,1017-1022`). The next update invalidates
the computed bundle key and records a bundle with the replacement bind group
(`:1346-1380`). That is correct for a current callback followed by another
frame.

It is not a complete lifetime contract: stale callbacks can mutate a retired
cache, the bundle key is not stored with the cache for deterministic teardown,
and there is no behavioral test proving that old-key invalidation precedes
texture retirement and new-bundle publication.

### 8. Lifecycle behavior lacked tests — CLOSED in L4/L5

**Pre-fix evidence (Batch 818):** `packages/engine/Specs/Scene/MoonSpec.js` covered construction, variant
selection, draw/show, and destruction. `WebGPUMoonSnapshotSpec.js` covers the
snapshot freezable and diagnostic unpacking. The Moon asset tests verify bake,
orientation, shader/source shape, and visual relief, not asynchronous ownership.

Pre-fix WebGPU diagnostics also overstated readiness:
`moonTextureLoaded` is true for the placeholder, while `moonTextureUrl` reads
`cache.moonTextureUrl`, a field the loader never assigns
(`WebGPUEnvironmentRenderer.js:1616-1626`). The lifecycle gate needs current
URL/variant, request serial/status, exact device generation, real-vs-placeholder
state, and staged-candidate state. The current frozen WebGL/WebGPU diagnostics
report exact desired/current/pending URL and pair identity, demand/state,
request/cache/resource serials, source/cache counters, real-vs-placeholder
state, GPU realization/upload/publication counters, and classified stale/failed
destruction without exposing sources or GPU handles.

## Sound behavior to preserve

- A WebGPU Moon does not allocate WebGL Moon textures.
- Both backends use the same explicit vertical-orientation convention.
- A current WebGPU texture replacement clears its bind group and marks the
  render bundle stale.
- The WebGPU normal binding always has a flat placeholder, keeping one pipeline
  layout.
- Current WebGPU cleanup destroys published geometry, buffers, albedo, real
  normal texture, and the flat placeholder.
- WebGPU already retains a loaded normal when only the lighting toggle changes.
- Real WebGPU Moon textures include `RENDER_ATTACHMENT` usage, which is useful
  for the later mip generator.
- A new albedo should replace the prior one transactionally so the Moon does
  not flash to a placeholder during an ordinary URL swap.

## Implementation plan

### L0 — Pure policy and state-machine contracts — COMPLETE FOR CURRENT SCOPE

1. **IMPLEMENTED / UNSTAGED / FOCUSED GREEN:** extract and test the
   finite, nonnegative strength/demand resolver; publish once before the backend
   branch and use zero as the no-new-normal-work demand signal.
2. **IMPLEMENTED:** immutable request identity:
   `{owner, effectiveVariant/pair, exactUrl, channel, requestSerial}`.
3. **IMPLEMENTED:** GPU realization identity:
   request identity plus `{backend, context, device, resourceGeneration,
   cacheSerial}` as applicable.
4. **IMPLEMENTED:** explicit lifecycle ownership/states spanning idle, source-
   pending/prepared, upload/candidate, current, failed, and retired.

The state machine, not callback arrival order, decides what may publish.

### L1 — Bounded context-free decoded Moon source cache — COMPLETE / REVIEWED GO

Add one Moon-specific decoded source cache with these contracts:

- key by canonical exact URL plus decode/orientation/color-space options;
- coalesce concurrent fetch/decode promises across Moon owners and backends;
- prefer one `ImageBitmap` decode that both WebGL and WebGPU can consume;
- return ref-counted leases;
- bound retained decoded memory by byte estimate and entry count;
- never evict or close an actively leased source;
- remove failed entries so a deliberate later retry can succeed; and
- contain no WebGL `Texture`, `GPUTexture`, context, or device handle.

Variant/pair remains part of the Moon request identity even when two aliases
resolve to the same source-cache URL. This permits byte sharing without allowing
one variant request to publish for another.

**L1a worktree disposition:** `MoonDecodedSourceCache` implements the cache
contract without retaining any renderer, context, device, or GPU handle. An
acquisition returns an immediate lease with `lease.ready`, so stale owners can
release before fetch/decode settles. The last pending waiter removes the entry
before aborting its owned request; every late fetch, decode, or reentrant byte-
accounting continuation revalidates exact entry identity and is cleanup-only.
Ready and pending leases are reported separately; active entries cannot be
evicted; inactive entries are byte/entry-bounded LRU; failed entries are
retryable; and close/cleanup ownership is exact-once. String URL authority is
preserved while `Resource` objects are deliberately rejected because a URL-only
key cannot safely represent their headers, retry callbacks, or request state.
Independent review is GO and the focused state-machine/mutation lane is 16/16.

**L1b WebGPU-half disposition:** the WebGPU lifecycle now acquires an immediate
lease, keeps it synchronously reachable through pending decode, holds it while
an asynchronous preparation still reads the cache-owned source, and releases
it exactly once after queue-copy settlement or any failure, supersession, or
teardown. It closes only a distinct orientation derivative, never the shared
source. Pending last-waiter cancellation still removes and aborts immediately;
only an active preparation defers release until that reader settles. Mutation
gates cover stale pending abort, two consumers with one retiring, direct-close
and Promise-only-pinning regressions, and exact-once release. Cache+lifecycle
is 45/45 and independent review is GO.

**L1b final disposition:** WebGL consumes the same immediate leases and performs
GPU realization only from its frame-owned update. The real Edge split proof
records four acquisitions but only one fetch/decode per exact source across
both backends, then proves independent backend publication and exact pending-
lease cancellation on supersession and owner destruction.

### L2 — Generation-safe WebGPU realization — BOUNDED SLICE COMPLETE / REVIEWED GO

1. **IMPLEMENTED:** initialize each WebGPU Moon cache with the exact Moon, context, device,
   `resourceGeneration`, and a monotonic cache serial.
2. **IMPLEMENTED:** on any tuple mismatch, retire the cache before using any GPU handle. Bump
   both channel serials, invalidate its stored bundle key, destroy published and
   staged candidates, release source leases, and unregister snapshot state.
3. **IMPLEMENTED:** replace loading Booleans with independent albedo/normal request records.
4. **IMPLEMENTED:** revalidate the full identity before candidate/finalization and again after
   upload. Destroy a stale/failed candidate exactly once.
5. **IMPLEMENTED:** stage a ready candidate and commit it transactionally during update:
   invalidate the old bundle key, drop the old bundle/bind group, publish the
   new texture/view/dimensions, then retire the previous realization.
6. **IMPLEMENTED for dimensions; `maxLod` remains C12-33:** record dimensions beside the exact published texture;
   do not infer them from a newer request.
7. **IMPLEMENTED:** source/upload completion wakes request-render/snapshot scenes.

### L3 — WebGL realization and toggle parity — COMPLETE / REVIEWED GO

1. Feed the Material albedo path only a controller-approved decoded source;
   revalidate owner/context/generation/request serial again when Material drains
   the source and creates its texture.
2. Create the Moon-owned normal `Texture` synchronously in the current update,
   after the same tuple check, rather than from an unowned late callback.
3. Retain a matching normal source/texture while relief is off, but pass
   `undefined` as `EllipsoidPrimitive.lunarNormalMap` so the GLSL define and
   texture sample disappear while disabled.
4. Re-enable the same URL without a new fetch/decode/upload.
5. Destroy a retained realization when URL/variant/context identity changes;
   do not fetch the replacement until resolved demand becomes non-zero.

### L4 — Diagnostics and behavioral test fleet — COMPLETE

Expose read-only lifecycle diagnostics sufficient to prove:

- exact current/pending URL and effective variant;
- request/cache serials and request state;
- device/resource generation;
- placeholder vs real texture;
- source-cache hit/coalesced/miss/eviction counts;
- GPU upload/publication/stale-destroy counts; and
- current render-bundle key/invalidation count.

Current evidence: focused cache/policy/lifecycle Node 75/75; the complete
visual-regression Node glob 1,227/1,227; WebGL lifecycle Jasmine 8/8; WebGPU
lifecycle Jasmine 9/9; focused Scene/CesiumWidget teardown Jasmine 1/1 each;
device-pool/device-loss Jasmine 4/4 + 10/10; package type-check and top-level
build pass. Diagnostics are frozen, source/GPU-handle-free, exact-pair aware,
and count realization/upload/publication/candidate-retirement events. WebGPU
steady state reuses lifecycle-owned option records and frozen result sentinels
instead of allocating two option/result pairs per frame.

### L5 — Edge split/lifecycle certification — COMPLETE / PASS

Use Node/Playwright against Edge and the existing split Viewer. Exercise rapid
relief off/on and A→B→A URL changes while both cameras render. Require:

- one fetch/decode per exact albedo/normal source across the two split owners;
- distinct backend/device GPU realizations;
- same matching WebGL normal texture identity across an off/on toggle;
- final URL/variant/serial and rendered image matching the last request;
- zero WebGPU validation errors and zero console errors;
- no stale candidate or source lease after destruction; and
- visible current/final Moon pixels with the final per-backend image unchanged
  after the canceled replacement.

**Gate amendment (2026-08-02):** moving-camera seam/shimmer measurement is
owned by C12-33, not C12-35. C12-35 changes ownership/publication but does not
change mip levels, samplers, or derivative selection; its visual gate is a
visible static Moon plus byte-identical current/final pixels across a canceled
replacement. C12-33 changes exactly those sampling axes and therefore owns the
moving near-side/far-side/limb seam and shimmer route. This is a reassignment,
not a waiver.

The schema-v2 report at
`Tools/visual-regression/output/performance/campaign12-c12-35-l5-moon-texture-lifecycle-edge.json`
passes in real Edge 151 against bundle SHA-256 `D2033C3B...87CD887`. It proves
same-realm split ownership, one shared fetch/decode per source, explicit-render
wake on both scenes before frame-owned publication, identity-stable relief
off/on, delayed C cancellation, bit-identical visible current/final B PNGs,
GPU queue drain, four pending D leases before destroy and zero after, both
Moon lifecycles retired, and zero page/console/GPU faults.

## Required behavioral tests

These must drive deferred promises and fake devices/contexts; regex-only tests
do not close the row.

1. Destroy during fetch: no GPU candidate, no owner/cache mutation.
2. Destroy after candidate creation but before upload settlement: candidate
   destroyed exactly once.
3. Upload rejection: candidate destroyed, placeholder/previous texture remains,
   same URL does not retry every frame.
4. Change away and back after failure: an intentional new serial may retry.
5. A→B→A with every settlement order: only the newest serial publishes; all
   stale GPU candidates are destroyed.
6. URL→`undefined` and variant-without-normal transitions: no late republish.
7. Replacement device: old cache/resources cannot reach the new device.
8. Same `GPUDevice` plus `resourceGeneration` bump: old handles are rejected.
9. Off before first use: zero normal fetch/decode/upload.
10. Off during a valid in-flight request: matching result may be retained but
    is not bound or consumed.
11. Rapid off/on after resolution: no refetch/reupload; same GPU realization.
12. **GREEN in the unstaged L0 slice:** strength resolver covers undefined,
    null, zero, positive, negative, NaN, and both infinities; both backend
    consumers receive the same finite nonnegative value.
13. Bundle swap ordering: invalidate old key before retiring its texture; new
    bundle records only the new bind group/view.
14. Split owners: one shared source fetch/decode, one WebGL GPU realization,
    and one WebGPU realization for the exact device/generation.
15. Source-cache limits: active leases cannot be evicted/closed; released LRU
    entries can; failures do not poison the cache forever.
16. Request-render mode: decoded/uploaded current results wake and become
    visible without unrelated scene activity.

**Current disposition:** all 16 behaviors are covered. The focused Moon Node
lane is 75/75 and includes every A→B→A fetch/upload settlement order, tuple
mutation after upload, reentrant-finalizer invalidation, exact-once cleanup,
placeholder rollback, transactional ordering, cache limits, WebGL frame-owned
realization, retained-off identity, and allocation-free steady state. The real
Edge schema-v2 gate closes items 14 and 16 with the actual split app, shared
transport/cache, both GPU backends, request-render wake, cancellation, pixel,
GPU-fault, and teardown evidence.

## Why `C12-33` waited — prerequisite now satisfied

`C12-33` adds more asynchronous ownership to the same texture:

- `mipLevelCount` and level dimensions;
- a generation job referencing the newly uploaded candidate;
- sampler `mipmapFilter` state;
- a uniform derived from the exact texture width, disc diameter, and max LOD;
- WebGL Material mip generation; and
- optional 2K normal-map output.

Without `C12-35`, a stale URL/device callback could have enqueued mip work against a
destroyed or old-device texture, a completed old-generation mip job could
publish over a newer request, and the explicit LOD could describe a different
texture than the bound view. After `C12-35`, mip generation becomes another
state transition on the exact candidate tuple:

```text
uploaded candidate -> current tuple recheck -> frame-owned mip job
-> current tuple recheck -> transactional publication
```

With C12-35 complete, C12-33 may proceed. No private `queue.submit` is
authorized. Mip work must use the existing
frame-owned preparation/submission path, and a stale mip result must be
destroyed under the same request/cache/device-generation rules.

## Non-goals and guardrails

- Do not remove lunar relief, the 2K albedo, or any visual feature for speed.
- Do not share GPU texture objects across WebGL/WebGPU or across GPU devices.
- Do not add an unbounded global image/replay journal.
- Do not start normal work merely to make a later toggle faster; retain work
  that was validly started or resolved instead.
- Do not claim a same-Moon WebGL GPU allocation double tax; measure the legacy
  CPU frontend separately if it remains worth removing.
- C12-33, the 2K LOLA re-bake, and explicit Moon LOD may begin only while the
  L0-L5 lifecycle gates above remain green; they must not weaken or bypass the
  exact ownership contract.
