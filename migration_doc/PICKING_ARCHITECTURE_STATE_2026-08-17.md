# Picking — architecture state, outstanding issues, and the readiness/freshness design

**Date:** 2026-08-17 · **Status:** evidence document + design proposal. Six maintainer decisions are
open in §10; nothing in §8/§9 is authorized to be built until those are ruled.

**Why this document exists.** Picking has accumulated two corner-cuts that look unrelated and are
not: a certification gate that retries a pick eight times, and a synchronous pick that returns
nothing for the entire duration of any camera motion. Both are downstream of the same two absences.
This document records what picking actually is today, what is available and unused, what is missing,
and what it would take to fix properly.

**Evidence base.** Six read-only research lanes over `packages/engine/Source/`,
`packages/widgets/Source/`, `Tools/`, and the migration record, plus a consumer audit of every call
site (§7). Every claim below carries a `file:line`. Where an earlier belief was wrong, §6 says so
explicitly rather than quietly correcting it.

---

## 1. Executive summary — the two absences

The engine has **no representation of pick readiness** and **no representation of pick result
provenance**. Every symptom under discussion is downstream of those two facts.

A repo-wide grep for `pickReady|isPickReady|preparePick|prewarmPick|pickWarm|coolPick` across
`packages/engine/Source` and `packages/widgets/Source` returns **zero hits**. No caller can ask
whether a pick can be answered. The only runtime signal is a latched `console.warn` at
[`WebGPUPickFramebuffer.ts:769-781`](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts#L769-L781)
that nothing can branch on.

Symmetrically, `Scene.pick` returns `this._picking.pick(...)[0]`
([`Scene.js:4913`](../packages/engine/Source/Scene/Scene.js#L4913)), so a bare `[]` from
`WebGPUPickFramebuffer.end` (`:786`) collapses **four distinct states** into one `undefined`:

1. nothing is there;
2. pick resources are not realized;
3. the cache declined to serve;
4. no readback has ever completed.

Because callers cannot ask, they guess. Because results cannot describe themselves, the only
available validity policy is bit-exact identity.

---

## 2. What picking is today

### 2.1 Public API surface

| API | Sync/async | WebGL | WebGPU | Product consumers |
|---|---|---|---|---|
| `Scene.pick` | sync | renders an offscreen mini-frame, blocking `gl.readPixels` | serves from cached readback only if provenance matches exactly; else `undefined` | `Viewer.js:238` (click selection) |
| `Scene.pickAsync` | async | wraps sync | own staging buffer + own `mapAsync`; exact by construction | **none** |
| `Scene.pickHoverAsync` | async | wraps | + prewarm-on-intent, two-slot latest-wins coalescer (`Picking.js:136-175`) | **none** |
| `Scene.pickPreciseAsync` | async | wraps | geometrically-closest translucent semantics | **none** |
| `Scene.drillPick` / `drillPickAsync` | both | supported | `Picking.js:919` carries a Scene-layer `isWebGPU` branch emitting a stale-results warning | inspectors |
| `Scene.pickPosition` | sync | depth read | `PickDepth` serves ±4 px / ≤4 frames stale | measurement, camera |
| `pickFromRay` / `sampleHeight` / `clampToHeight` | both | offscreen render + readback | same; **not** CPU-side | terrain following, clamping |

**Four public async pick APIs are shipped and have zero product consumers.**
[`Viewer.js:238`](../packages/widgets/Source/Viewer/Viewer.js#L238) still calls synchronous
`scene.pick` for click selection.

### 2.2 The WebGPU synchronous pick path

`getCenterPixelViewProvenance` returns `parts.join("|")` over **48 raw matrix floats**
([`Picking.js:1536-1558`](../packages/engine/Source/Scene/Picking.js#L1536-L1558)).
`_extractPixelsFromCachedRegion` declines on `cached.viewProvenance !== region.viewProvenance`
([`WebGPUPickFramebuffer.ts:629`](../packages/engine/Source/Renderer/WebGPU/WebGPUPickFramebuffer.ts#L629)).

A joined string supports only `===`. **A string has no neighbourhood**, so no tolerance, bound, or
staleness measure of any kind is expressible on the current type. This is why the gate is
all-or-nothing rather than merely strict.

There **is** a working warm path: with provenance equal, a cursor that moved *within* the previous
readback's region still decodes. Same-view-different-pixel is served synchronously today.

### 2.3 The gate is simultaneously over-strict and under-strict

The ordinary object-pick call site passes **no owner**
([`Picking.js:1666`](../packages/engine/Source/Scene/Picking.js#L1666)). A primitive that *moves*
under a *static* camera therefore mints identical provenance and **is served stale bytes**.

That is a wrong-pick class the strict gate does not close, while it refuses the benign
camera-motion case. This is a live correctness defect, not a UX gap.

### 2.4 Three subsystems, three incompatible staleness policies

| Subsystem | Policy | Source |
|---|---|---|
| Object pick | exact provenance identity | `WebGPUPickFramebuffer.ts:629` |
| Pick depth | ±4 px, ≤4 rendered frames | `PickDepth.js:23,29,205-231` |
| Snapping | 8 queries, 8 scene frames, 2 px | `WebGPUSnapFramebuffer.ts:160-166` |

Consequence: during motion `scene.pickPosition` returns a depth from an unrecorded camera pose while
`scene.pick` at the **same pixel in the same frame** returns nothing. The looser API is the one whose
wrong answer is hardest to notice.

---

## 3. Outstanding issues

**P-1 · Conflated sentinel (HIGH).** `undefined` means both "nothing is there" and "I could not
tell." Documented contract at `Scene.js:4910`. Callers cannot distinguish, so they retry or take a
destructive action.

**P-2 · Sync pick empty during camera motion (HIGH, twice-regressed).** Exact provenance identity
means no valid data exists for a changed view. A July-era tolerance that made motion picking work was
**silently repealed** with nothing asserting it — the origin of the standing rule that a fix is not
done until something asserts it. See `PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md`.

**P-3 · Moving primitive under a static camera served stale bytes (HIGH).** §2.3. No owner term on
the ordinary path.

**P-4 · Pick is hostage to colour-pipeline compile (HIGH — the dominant cost).**
[`WebGPUGlobeSurfaceRenderer.ts:1518`](../packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts#L1518)
and [`WebGPUModelRenderer.ts:7080`](../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts#L7080)
both `continue` on a null **colour** pipeline, deleting the **pick** command alongside it. Pick then
inherits a `createRenderPipelineAsync` compile measured at **2674 ms / 44 frames** cold
(`DEFERRED_WORK.md:12675`) versus WebGL's 771 ms / 13 frames — even though **every pick pipeline in
the fork is created synchronously** (`WebGPUGlobeSurfacePipelines.ts:951`,
`WebGPUModelPipelineCache.ts:1223`). On a globe-less tileset the same asymmetry reads 97 warm frames
on WebGPU versus 9 on WebGL (`c11-202-batchtexture-pick-demand.json`).

**P-5 · Globe pick ID is minted only inside a render frame (MEDIUM).** `Globe._pickId` and
`tileProvider._webgpuGlobePickColor` are established only in `Globe.beginFrame`
([`Globe.js:1276-1282`](../packages/engine/Source/Scene/Globe.js#L1276-L1282)), which `Scene` calls
only from `render()` (`Scene.js:6551`). A pick mini-frame runs with `passes.render === false`, so the
mirror is never established and the pick tail packs zeros → `undefined`. Additionally
`QuadtreePrimitive.js:287` requires `passes.pick && this._tilesToRender.length > 0`, so **a pick
cannot bootstrap its own tile coverage**.

**P-6 · No instrument (MEDIUM).** `WebGPUPickFramebuffer` has no `stats`/`counter` symbol at all.
`Scene.getDebugSnapshot()` (`Scene.js:2100`) has **no pick key**. `DEBUGGING_GUIDE.md:2106` falsely
claims `CesiumDebug.snapshot()` already reports pick-framebuffer state. Readback age `k` has never
been measured.

**P-7 · Backend-agnosticism violation (MEDIUM).** `Picking.js:919` branches on `isWebGPU` in Scene
code, which `CLAUDE.md` §2 forbids outside `Renderer/`.

**P-8 · Certification gate retries instead of asserting (MEDIUM).**
`c12-29-s5-custom-ellipsoid-gate.mjs:123` sets `maximumPickWarmupAttempts: 8` with up to
`maximumPickPumpFrames: 60` per attempt — **a budget of up to 480 rendered frames to answer one
pick** — and accepts `resultKind === "undefined"` for the first seven (`:3559-3565`). It bought that
loop by *deleting* the instrumentation proving the pick routed through the terrain provider's pick
seam (commit `034c7f74d0`, ledgered at `SOL_WEEK_AUDIT_2026-08-14.md:69`). A second retry loop of the
same shape exists at `probe-depth-plane-horizon-oracle.mjs:430` (120 attempts).

---

## 4. What is available and NOT being used

1. **Four shipped public async pick APIs, zero product consumers** — `pickAsync`, `pickHoverAsync`,
   `pickPreciseAsync`, `drillPickAsync`. `pickHoverAsync` already carries a purpose-built two-slot
   latest-wins coalescer (`Picking.js:136-175`) and prewarm-on-intent.
2. **`FeatureRendererReadiness`** — a shipped discriminated union with a `generation` lifetime token
   on the abstract base (`GraphicsContext.ts:390-406`), with `getFeatureRendererReadiness` (`:2022`),
   an awaiting form (`:2048`), cheap boolean companions (`:2085`, `:2094`) and a subscription Scene
   already consumes (`Scene.js:4620-4626`). Picking uses none of it.
3. **`SnapViewProvenance`** — a shipped **flat pose struct** whose result type carries the view it
   was produced under (`WebGPUSnapFramebuffer.ts:98-143`). This is the exact shape picking needs and
   already exists two files away.
4. **`supportsSynchronousReadback`** — the backend-agnostic capability on the abstract base
   (`GraphicsContext.ts:1013`, overridden `WebGPUContext.ts:1848`), already consumed at
   `PickDepth.js:134/:162`, `Picking.js:812/:1122`, `InstancingPipelineStage.js:85`,
   `GltfLoader.js:1541`. **This is the template.**
5. **Pipeline prewarm machinery** — `WebGPURenderPipelineCache.warm()` (`:631`, idempotent,
   background priority) and the `prewarmDeterministicPipelines` boot hook
   (`WebGPUSceneRendererEnsureResources.ts:563`), already used by `WebGPUDepthPlane.prewarm()`
   (`:375`) — the one pick pipeline in the engine that is warmed today.
6. **`AsyncResourceMonitor`** (`:49-56`) — add-only kind registry; picking has no kind.

---

## 5. What is missing entirely

- Any readiness query or prepare verb (§1).
- Any provenance on a returned pick — cold / cached / fresh / declined, and how stale.
- A structured provenance type. The current one is a string.
- A pick status slot: the pick framebuffer is created by the untyped factory
  `createPickFramebuffer(): unknown { return null; }` (`GraphicsContext.ts:1497`), consumed at
  `View.js:127`. It has no generation token.
- A shared staleness policy. Three subsystems, three policies (§2.4).
- Any instrument (P-6).

---

## 6. Corrections to prior belief — read this before citing older notes

These were believed during this session's investigation and are **wrong**:

1. **`pickFromRay` is not CPU-side geometry intersection.** It renders an offscreen pick pass from a
   camera along the ray and reads it back
   ([`PickingRayHelpers.js:228-253`](../packages/engine/Source/Scene/PickingRayHelpers.js#L228-L253)).
   It carries the identical WebGPU readback constraint. It is **not** a synchronous escape hatch. A
   true CPU picker would have to be *built* (CPU-resident geometry + BVH), not exposed.
2. **Lazy pick demand is not why a first pick fails.** The C11-196 artifact shows the **first**
   `pickAsync` returning `Cesium3DTileFeature` 28 with 1 generic + 30 dense IDs + 1 lookup texture +
   1 pick pipeline all realized inside that same call.
3. **The 8 retry attempts buy zero readback latency.** The gate retries `pickAsync`, whose
   `endAsync` allocates its own staging buffer and awaits its own `mapAsync`
   (`WebGPUPickFramebuffer.ts:807-880`), consulting no cache and no provenance gate. A failing
   `pickAsync` proves the pick pass **drew nothing at the cursor** — a readiness fact, not a latency
   one.
4. **"8" is not a physical number.** It is a harness constant triple-pinned at gate `lib:123`,
   `spec:2059` and `spec:4365`. The number to beat is 44 frames of colour-compile coupling (P-4),
   not 8 attempts.
5. **WebGL's sync pick is not free and does not read "the current frame" either.** Every
   `Scene.pick` renders a fresh offscreen mini-frame (`Picking.js:1662-1669`) then blocks on
   `gl.readPixels` (`Context.js:1456-1494`). The fork's own JSDoc concedes the stall
   (`PickFramebuffer.js:57`). WebGPU cannot reproduce render-then-read-in-one-task —
   `WebGPUContext.readPixels` is a `null`-returning shim that says so (`WebGPUContext.ts:4090-4101`).
6. **Priming the readback cache is already-ruled harmful.** `DEFERRED_WORK.md:4759` records that
   priming at init makes the first user pick return *the primed location's* object rather than the
   clicked location's — a wrong answer, worse than `undefined`.

---

## 7. Improvements we could make

### 7.1 The governing distinction

**Only one of the two things called "warm" is a cache.**

- **Pick capability** — pipelines, pick IDs, bind groups, and the scene-state prerequisites (a render
  frame having selected tiles; `Globe.beginFrame` having minted the pick ID). Location-independent,
  monotone. **Safe to prewarm, safe to query.**
- **Pick data** — the readback bytes in `_lastReadPixels`/`_lastReadRegion`
  (`WebGPUPickFramebuffer.ts:252-253`). Location-**dependent**. **Must never be prewarmed** (§6.6);
  governed by a per-query validity predicate, not by a warm/cold state.

The retry loop is a **readiness** failure. Empty-during-motion is a **freshness** failure. Treating
both as "the pick cache is cold" is what produced two different corner-cuts. There is no `coolPick`
verb in the proposal: invalidation is already event-driven and correct
(`resourceGeneration`/`attachmentGeneration` at `:626-628`, and the S13 per-identity
`_invalidateCenterPixelReadback` at `:1617`, landed `4c9b559411`). A public cool button would invite
callers to paper over invalidation bugs instead of reporting them.

### 7.2 Proposed API surface

| Addition | Home | WebGL | WebGPU |
|---|---|---|---|
| `getPickReadiness(): PickReadiness` | `GraphicsContext` (abstract base) | `{kind:"ready"}` always | `preparing` while pick pipelines are inflight, the globe pick ID is unminted, or no render frame has selected tiles |
| `preparePick(): Promise<PickReadiness>` | `GraphicsContext`, mirroring `getFeatureRendererAsync` | resolves immediately | kicks `WebGPURenderPipelineCache.warm()` at background priority; prewarms **capability only** |
| `Scene.pickReady` + `pickReadyEvent` | `Scene`, delegating — the shape of `Scene.pickPositionSupported` | `true`; event fires once | fires when capability is realized |
| `Scene.lastPickInfo` | `Scene`, **sidecar** so `pick()` stays byte-identical | always `{source:"fresh", ageFrames:0}` | `cached` / `declined` + reason / `cold`; `pickAsync` always `fresh` |
| `PickViewProvenance` (flat struct) | replaces the joined string in `Picking.js` | constructed and ignored | enables a computable pose delta and reprojection error |
| `PickCacheValidity` shared module | one home under `Renderer/` | not consulted | the six-condition serve rule |
| `FeatureRendererKey.PICK` + `AsyncResourceKind "pick-pipeline"` | both add-only registries | `unsupported` | separates "is pick cooking" from "is anything cooking" |
| Widened sync capture aperture (3×3 → 33×33) | internal to `WebGPUPickFramebuffer` | no change | ~4 KB `copyTextureToBuffer` instead of 36 bytes |

**`Scene.pick()` keeps its exact contract forever**, implemented as a zero-staleness-budget
projection of the richer call. One code path, no drift, and stale data is only ever delivered to a
caller that asked for it by name.

### 7.3 The validity predicate — a proof, not a tolerance

Serve a cached pick **iff**: (a) resource and attachment generations match; (b) the readback is ≤2
rendered frames old; (c) the reprojected cursor point lies inside the cached aperture with margin ≥
the reprojection error bound ε; (d) **the cached pick ID is uniform over a disc of radius ⌈ε⌉+1
around that point**; (e) ε is under a hard ceiling regardless of (d); (f) no scene-content revision
bump.

Condition (d) is what makes this a proof rather than a fudge: if the ID is constant across a disc
that provably contains the true corresponding pixel, no error within ε can change the answer. A bare
pose-delta tolerance is **not** acceptable — the investigation's own physics says it recovers nothing
during a real drag (~29 px at k=2) while reopening the wrong-ID hole.

**It refuses** at silhouettes and on small primitives (the plateau breaks), during fast motion (ε
ceiling), on newly streamed or animated geometry (frame-age cap + content revision), on
device/attachment change (generation), and across morph and mode change.

**Honest residual, to be stated in JSDoc rather than hidden:** a thin primitive smaller than the
plateau radius that moves between the cached frame and now while uniformly surrounded by a single
other ID. The owner term and the 2-frame cap are what bound it.

**Hard prerequisite nobody had stated:** you cannot serve during motion from a 3×3 capture. A drag
displaces the cursor ~29 px at k=2; reprojection has nowhere to land. Widening the aperture is a
prerequisite for the predicate, not an optimization. Snapping already runs 25×25 for exactly this
reason.

---

### 7.4 The freshness policy — one choice, three options (maintainer directive, 2026-08-17)

**Standing directive:** picking must keep iterating under the dual mandate — preserve legacy
functionality as far as possible while moving the technology forward. **There must be no mysteries
when picking.** Whenever a result is served from stale or cold data, the caller must be able to know
that is what happened.

The picking APIs gain **one parameter with three options** — a cache-control policy, in the same
shape HTTP settled on (`must-revalidate` / `only-if-cached` / default):

| Request | Meaning | WebGPU | WebGL |
|---|---|---|---|
| `latest` | force a fresh pick; create or refresh the cache | **inherently async** — `mapAsync` cannot resolve in the same task | already synchronous and exact |
| `available` | return whatever exists now, however stale | synchronous; may return cached *N* frames old, or report cold | always fresh by construction |
| `auto` | the engine chooses the best strategy | serve if the plateau proof holds, else issue a fresh pick, else report cold | always fresh |

**Request and response vocabularies are deliberately different** — what you asked for versus what you
got:

- **request:** `latest | available | auto`
- **response:** `fresh | cached(ageFrames) | cold | declined(reason)`

Every result carries the response term, including legacy `pick()`, delivered through the
`Scene.lastPickInfo` sidecar so no existing signature changes.

#### Why this strengthens the FAR-107 amendment rather than straining it

`R-2026-08-17-3` amended FAR-107 to admit a proof-carrying serve. The freshness policy sharpens the
boundary that amendment draws:

> **Proof required when the ENGINE decides. Disclosure required when the CALLER decides.**

FAR-107 forbids *substitution* — the engine silently handing back stale data as though it were
current. A caller that explicitly requests `available` and receives
`{ object, freshness: "cached", ageFrames: 7 }` is not being substituted to: it asked, and it was
told exactly what it got. That is the "documented, feature-detectable" shape FAR-107 itself demands.

Consequently **`available` does not require the plateau proof.** The plateau is what licenses `auto`
to serve *without being asked*. `available` is licensed by disclosure instead.

#### The one impossible combination

**Synchronous + `latest` on WebGPU cannot be satisfied.** No engineering removes that boundary —
`WebGPUContext.readPixels` is a `null`-returning shim precisely because WebGPU has no same-task
readback of the current frame. That combination returns FAR-107's documented, feature-detectable
**unsupported** state rather than quietly degrading to something else.

#### Composition with prewarm

`latest` populates the cache as a side effect, so a subsequent `available` call at the same view
hits. This composes with `preparePick()` rather than duplicating it:

- `preparePick()` warms **capability** — pipelines, pick IDs, bind groups, scene prerequisites.
- `latest` warms **data** — the readback for a specific view and location.

A `latest` call should await capability readiness first, so the two chain naturally.

#### CPU-resolvable queries are exempt

`globe.pick`, `camera.pickEllipsoid` and `IntersectionTests` are pure geometry with no readback.
Their `undefined` genuinely means absence on both backends, so the freshness policy does not apply to
them and their results are `fresh` by construction. Keep the plain contract there; reserve the
freshness contract for GPU-readback paths.

#### Legacy `pick()` maps to `auto` (ruled)

`R-2026-08-17-11`: `scene.pick()` maps to `auto` and therefore **gains** the improvement. Existing
callers get a proof-carrying result during camera motion where they previously got `undefined`, with
no code change on their part — which is the fix for LD-01 and LD-02, the flagship-widget defects in
§9.1. Because the plateau proof guarantees the served answer is identical to what a fresh pick would
return, no caller can observe a *wrong* result; they observe *fewer* `undefined`s.

The residual risk, stated rather than hidden: a caller that today treats `undefined`-during-motion as
a signal ("the user is dragging, ignore this pick") would see a behaviour change. That pattern is
almost certainly accidental rather than intentional, but it cannot be proven absent. Callers needing
the old strictness ask for it explicitly.

---

## 8. Staged plan

Each stage is independently landable and **names the assertion that guards it** — the pick tolerance
was silently repealed precisely because nothing failed when it was removed.

| Stage | Work | Effort | Guard |
|---|---|---|---|
| **S0** Instrument first | counters on `WebGPUPickFramebuffer` (it has none), a `pick` section in `getDebugSnapshot()`, `CesiumDebug.pick()`, correct the false `DEBUGGING_GUIDE.md:2106` claim | S | spec asserts the counters move |
| **S1** Consume shipped async APIs | repoint `Viewer.js:238` to `pickAsync` with a request sequence; inspectors' hover to `pickHoverAsync` | S | spec asserts latest-wins ordering |
| **S2** Readiness capability | `getPickReadiness`/`preparePick` on `GraphicsContext`; `Scene.pickReady`/`pickReadyEvent`; add-only registry entries; hoist the `Globe.beginFrame` pick-ID block | M | spec asserts WebGL answers `ready` and WebGPU transitions |
| **S3** Decouple pick from colour | restructure the two `continue`s (P-4) | M | spec asserts a pick command exists while the colour pipeline is inflight |
| **S4** Structured provenance + aperture | flat `PickViewProvenance`, owner term on the ordinary path, widened capture; **no policy change** | M | A/B: served results byte-identical |
| **S5** The validity predicate | six conditions; populate `lastPickInfo` on both backends | L | negative control: a mutated predicate must serve a wrong ID and the test must catch it |
| **S6** Reconcile the three policies | one shared `PickCacheValidity` | M | spec asserts `pick` and `pickPosition` agree on answerability |
| **S7** Retire the retry loop | attempts 8 → 1 behind `await preparePickAsync()`; **restore the deleted `updateForPick` route proof** | S | the gate goes green on both backends at attempts=1 |

**S1 and S3 are the high-value early moves.** S1 fixes the user-visible symptom — a click during
camera inertia selecting nothing — at effort S with zero engine-semantics risk. S3 removes the
dominant 44-frame term. Neither requires any of the open decisions below.

---

## 9. Consumer audit — 2026-08-17

**Coverage.** Seven read-only lanes over ~200 pick call sites in ~150 files: 75 engine sites, all
seven camera files plus the four new `Controllers/*`, the depth/height family end to end, all of
`packages/widgets/Source`, 61 tooling `.mjs`, and 47 of ~340 gallery demos. **Nothing was executed** —
no build, no browser, no probe run — so every claim is structural. The audited state is the
worktree (~138 uncommitted paths), not the last landed commit.

**The framing that matters most.** The empty-during-motion decline is a **ratified fail-closed
design** with a unit guard spec (`webgpu-pick-center-identity.spec.mjs:402-478`: bytes rendered under
a different provenance must not leak). *The defect is never the decline. It is every consumer that
reads the decline as absence.* Any fix must preserve the gate — and consequently **most of what
follows is fixable today, without the new readiness API.**

### 9.1 Live defects

| ID | Severity | Site | Defect | Blocked on new API? |
|---|---|---|---|---|
| LD-01 | **CRITICAL** | `Viewer.js:1164` | Sync pick assigned straight to `selectedEntity`. A click during post-drag inertia, a `flyTo`, or while tracking **silently deselects** — SelectionIndicator plays its depart animation and the InfoBox closes on an entity the user never clicked away from. | no |
| LD-02 | **CRITICAL** | `Viewer.js:1158-1160` | Double-click clears `trackedEntity` on an unanswered pick. **Tracking guarantees camera motion**, which guarantees the decline — so double-clicking the entity you are tracking *stops tracking*. The failure is the feature's default condition, not an edge case. | no |
| LD-03 | **CRITICAL** | `Picking.js:1326`, `:1287` | `clampToHeightMostDetailed`/`sampleHeightMostDetailed` are structurally 100% broken on WebGPU (offscreen `PickDepth` never receives `update()`), the promise **resolves successfully** so no catch fires, and `Picking` writes `undefined` back **into the caller's own array**. | no |
| LD-04 | **CRITICAL** | `PickingRayHelpers.js:230` | `pickFramebuffer.begin` called with two arguments, so provenance is `undefined` for **every** ray; the offscreen viewport is a fixed 1×1, so all rays mint byte-identical regions and the exact-match fast path can return **the previous ray's object**. The one place a WebGPU pick returns a confidently *wrong* answer. | no |
| LD-05 | **CRITICAL** | `Scene.js:5596-5599` | The published `clampToHeight` `@example` is `entity.position = viewer.scene.clampToHeight(position);` — unguarded. **This ships in the public API docs** and is the most-copied usage in existence. | no |
| LD-06 | HIGH | `Scene.js:1893`, `:1914`; `PickingRayHelpers.js:203-213` | Both the capability JSDoc and the engine's own runtime warning steer developers onto the `*MostDetailed` variants that LD-03 shows are 100% broken. The two places a developer looks both point at the broken path. | no |
| LD-07 | HIGH | `Picking.js:679-685` | `_pickPositionCache` uses `Object.hasOwn`, so a stored `undefined` is a cache **hit**, and nothing on the path calls `requestRender`. Under `requestRenderMode` a pixel that goes cold once is **latched forever**. | no |
| LD-08 | HIGH | `Picking.js:1180-1252` | `_reconstructHeightSurfaceWebGPU` substitutes a **camera-ray** sample for the documented **geodetic-normal** sample. They coincide only at nadir; error grows as `h·tan(obliquity)` — ~1 km at 45° over 1 km relief. `clampToHeight` returns a point at a *different lon/lat* than requested. No JSDoc caveat. | no |
| LD-09 | HIGH | `Picking.js:918-929` | The "drillPick unreliable on WebGPU" warning is **pragma-stripped from release builds** *and* branches on `isWebGPU` rather than a capability — the only backend-identity branch in the Scene pick path, violating Core Principle 2. Production apps get duplicates or an empty array with no signal. | no |
| LD-10 | HIGH | `3d-tiles-feature-picking/main.js:129` **+8 clones** | The canonical hover template clears the highlight *before* picking and returns on `undefined`, so "could not determine" executes as "nothing is there". The highlight strobes during exactly the interaction users perform most. | no |
| LD-12 | HIGH | `Scene.js:1881` | `pickPositionSupported` returns true on WebGPU in **2D, Columbus View and orthographic**, where `useLogDepth` is false and the reconstruction returns `undefined` **permanently**. Every consumer following the documented `if (scene.pickPositionSupported)` idiom reads "nothing there" at every pixel, silently. | no |
| LD-13 | HIGH | `CameraHelpers.js:246-262` | Orthographic frustum width falls back to `camera.positionCartographic.height` when depth is unanswerable — substituting an answer, and a wrong one. Zoom feels wrong-scaled on WebGPU, permanently, in globe-less ortho scenes. | partial |
| LD-14 | HIGH | `ImageryLayerCollection.js:378-390` | Falls back to `pickFromRay` and reads a missing position as "the ray does not intersect" — which on WebGPU is structurally always true. Globe-less WebGPU scenes silently return "no features" for every GetFeatureInfo click, and the Viewer routes every unresolved click here. | no |
| LD-15 | HIGH | `client-side-snapping-dev/main.js:105-143` | A **measurement** tool whose cascade ends at `camera.pickEllipsoid`, which always succeeds with a **sea-level** point, plus `position ?? Cartesian3.ZERO`. A building-height measurement silently reports against the ellipsoid; the ZERO branch plants a point at the centre of the Earth. | partial |
| LD-16 | HIGH | `Picking.js:1666` | The ordinary object pick passes **no owner** and `_readbackRegionsEqual` carries **no frame-age term** — simultaneously the strictest path on view and the loosest on age. A primitive moving under a static camera is served arbitrarily stale bytes. The metadata path 200 lines away already has both. | no |
| LD-17 | MEDIUM | `PickDepth.js:210-227` | Sync depth cache is ±4 px / ≤4 frames with **no view provenance**, then reconstructed against the *current* frustum. Zoom anchor and tilt pivot drift against the cursor during fast motion. Separately, one shared instance means N height queries in a frame arm exactly **one** readback. | no |
| LD-18 | MEDIUM | `clamp-to-3d-model/main.js:55-66` | `sampleHeight` inside a per-frame `CallbackProperty` under `trackedEntity` (continuous motion), with `cartographic.height = 0.0` on failure — converting "undetermined" into a measurement of exactly zero. | no |
| LD-19 | MEDIUM | `Cesium3DTilesInspectorViewModel.js:403-434` | Default-on hover pick clears Feature/Tile panels on an unresolved result; both inspectors clear their one-shot pick mode **unconditionally**, so "Pick Tileset" pops back out with nothing selected. | no |
| LD-20 | MEDIUM | `SSCCModeHandlers.js:776-821` | Three gesture consumers latch on an unanswered pick: `spin3D` sets `_looking=true` for the **whole drag**; `translateCV` re-picks a moving drag-plane origin so pan gain varies with drag speed; and the four new controllers' JSDoc examples tell users to override `pickWorldPosition` with `scene.pickPosition`, freezing orbit/tilt mid-drag. | no |

### 9.2 Evidence at risk

**The most alarming finding is not in the code.**
[`DEFERRED_WORK.md:4759`](DEFERRED_WORK.md) — `NEW-WEBGPU-PICK-COLD-SYNC-STALENESS` — is marked
**RESOLVED** on the premise that *"the common hover-then-click pattern is already warm by click
time."* The repo's own banked artifacts falsify it: the moving-pick campaign records WebGL
`hitCalls` 9 versus WebGPU `hitCalls` **0** across ~1,108 picks in one leg, 9 versus 5 in another —
and `telemetryValid` (`performance-campaign-utils.mjs:334-343`) validates eight fields and **never
checks `hitCalls` at all**. The gate is provenance identity with no age term, so *any* camera motion
invalidates it and hover cannot prime a click during motion.

That closed entry is **the standing licence the probe fleet cites for skipping WebGPU pick
assertions** (`:4753` waives the bulk billboard/label pick check by name).

Further void or blind evidence:

- `probe-point-pick-webgpu.mjs:179-190` — the *named gate* cited by that RESOLVED entry. Its miss
  control samples a different pixel from the warmed one, so an uncovered region is indistinguishable
  from a genuine miss. **The leg that proves the probe is not trivially passing is itself void**, and
  every leg is stationary — precisely the regime the closure rationale assumed.
- `probe-sampleheight-webgpu.mjs` — camera at pitch −π/2 positioned exactly over the sampled point:
  the one geometry where LD-08's parallax error is identically zero. Tolerance `dH > 1500 m`.
  `clampToHeight` is asserted only to be `kind === "Cartesian3"` — its returned lon/lat is never
  compared to the input.
- `probe-pick-ray-async.mjs` — zero occurrences of `MostDetailed`, so LD-03 has no test that could
  fail on it; its only hard assertion is "does not throw".
- `probe-scheduler-octree-demand.mjs:288-304` — `pickOk: picked !== "ERR"` while the catch sets
  `picked = "ERR:" + message`. **`pickOk` is unconditionally true**; a thrown pick passes silently.
- `probe-c10-11-ddtd-hitrate.mjs:53-89` — the headline metric *is* a hit rate, and `pickStable()`
  retries 8× then returns the last `undefined`, scored identically to a wrong-primitive pick.
- **The S5 gate family carries four mutually inconsistent readiness budgets** for the same operation
  (1 attempt / 8 / 6 / 60-non-throwing), and `probe-c12-29-s5-terrain-selection.mjs:4890` records
  `pickResultKind` which its gate lib never reads — so that gate can pass with the pick returning
  `undefined`.
- `c12-29-s5-multiview-gate.mjs:1443-1449` **cements the LD-04 defect as a pass criterion**
  (`known-webgpu-no-position-globe` *requires* `position === null`). Fixing pickFromRay turns this
  gate red, and it will read as a multiview regression rather than policy drift.

### 9.3 Good patterns — the templates to propagate

1. **`PickDepth.js:107-146` is *the* template**, right for three separate reasons: it branches on
   `supportsSynchronousReadback` (never `isWebGPU`) and records *why* the `defined()` proxy was wrong;
   it **preserves the synchronous return type** across backends (`number|undefined`, "NEVER a
   Promise") so consumers degrade rather than break; and its staleness bound is measured in
   **rendered frames**, so `requestRenderMode` scenes keep a valid cache indefinitely.
2. **`readCenterPixel` (`WebGPUPickFramebuffer.ts:311-329`)** already has everything the ordinary
   pick lacks — per-identity cache slots, owner-scoped provenance, a bounded staleness clock, and an
   explicit contract that a cold query is invalid. **Generalise this rather than designing a fresh
   policy module.**
3. **`pickMetadata` and `pickVoxel`** get the sentinel exactly right: metadata refuses to read a cold
   readback as four zero bytes "because zero is a valid encoded value"; voxel puts a **CPU ray-vs-OBB
   gate in front of the GPU pick** and uses an impossible all-255 packing as its no-fragment sentinel.
4. **`SSCCInputHelpers.js:58-160`** — always computes a CPU globe-ray oracle *alongside* the depth
   answer and rejects a depth answer that disagrees. **An oracle that does not depend on the readback
   is why zoom-to-cursor still works on WebGPU.**
5. **`pickHoverAsync`'s two-slot coalescer (`Picking.js:137-268`)** is a complete, spec-asserted
   solution to the out-of-order hazard a naive repoint would create — which is why LD-01/LD-02/LD-10
   are low-risk work rather than an architecture project.
6. **CPU-resolvable queries are a different family.** `globe.pick`, `camera.pickEllipsoid` and
   `IntersectionTests` are pure geometry with no readback, so *their* `undefined` genuinely means
   absence on both backends. **The new API should formalise this split**: keep the plain `undefined`
   contract for CPU-resolvable queries; reserve the freshness contract for GPU-readback paths.

### 9.4 Inventory corrections owed to `FEATURE_INVENTORY.md` §C.5 / §B.8

- §C.5 records **none** of the defects above. Add the conflated sentinel, empty-during-motion, the
  missing owner/age terms, and the `requestRenderMode` latch.
- `C-R9-VOXEL-CELL-PICK-TAIL` is **stale** — it claims `pickVoxel` still throws; `Scene.js:5052-5055`
  guards it into `undefined`.
- `NEW-PICK-RAY-ASYNC` **over-claims**: its SHIPPED text says WebGPU `pickFromRay` "returns the hit
  object with position undefined", but the cited probe only asserts no-throw, and LD-04 means the
  true behaviour is either permanent `undefined` or a cross-ray wrong object.
- The same entry must record that `sampleHeightMostDetailed`/`clampToHeightMostDetailed` are
  **broken** on WebGPU — because the entry's own guidance recommends them as the safe alternative.
- Nothing records that **four public async pick APIs are shipped, spec-covered, and have zero product
  consumers**. Add it so the next impact analysis finds the available fix instead of re-deriving it.
- `pickPositionSupported` reporting true in 2D/CV/ortho is a **permanent**, not transient, gap.

### 9.5 What this changes about the plan

Stage **S1** is no longer a nicety — it is the fix for LD-01, LD-02, LD-10 and LD-19, i.e. the
flagship widget's default click and hover behaviour. It requires no new API, no ruling, and the
coalescer it needs already ships.

A new **S0.5** is owed ahead of everything: the doc/example fixes (LD-05, LD-06), the two-line
`drillPick` warning fix (LD-09), and the non-mutating writeback for LD-03. These are hours of work
that stop the fork actively teaching a broken pattern in its published documentation.

---

## 10. Open decisions for the maintainer

1. **FAR-107 says the opposite of what §7.3 proposes.** Its written contract
   (`FORK_ARCHITECTURE_REMEDIATION_PLAN_2026-07-13.md:455-464`) states a WebGPU synchronous call
   "may return only an already-complete result whose entire query/generation identity matches" and
   orders "Delete stale prior-frame/location/property/pass substitution." It has been
   BLOCKED-ON-MAINTAINER since the G1-G10 sweep. The identity-plateau predicate is a
   *reconciliation* — it keeps "identity must match" by proving the identity is **invariant over the
   reprojection uncertainty** rather than by comparing poses. **Does that satisfy FAR-107, or must
   FAR-107 be amended?** This is the single ruling that unblocks the architecture.
2. **How wide should the synchronous capture aperture be, and who pays?** 33×33 costs ~4 KB per sync
   pick instead of 36 bytes. Acceptable on a continuous-hover path, or opt-in via a scene option?
3. **What is the hard frame-age cap?** Proposed 2 — tighter than `PickDepth`'s 4 and Snap's 8,
   because pick returns an identity rather than an interpolable scalar. Fixed or tunable? Should S6
   pull `PickDepth` down to match?
4. **Imperative or declarative prewarm?** Upstream's idiom is a boolean option
   (`preloadWhenHidden`) plus an Event. Should `Scene.preparePickAsync()` be public, or should the
   public surface be `contextOptions.prewarmPicking: true` + `pickReadyEvent`?
5. **Globe pick parity.** `Globe.pickable` is honored by WebGPU only (`Globe.js:114-117`), and the
   S5 gate encodes the divergence: `expectedPickKind = renderer === "webgpu" ? "globe" : "undefined"`
   (gate `lib:3526`). Should this work also mint globe pick IDs on WebGL so the backends agree, or is
   the divergence deliberate and permanent?
6. **Does the predicate govern `drillPick`?** Retiring the `isWebGPU` branch at `Picking.js:919`
   (P-7) means drillPick must either adopt the predicate or declare `unsupported` through the
   readiness union.

---

## 11. Cross-references

- [`PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md`](PICK_DURING_MOTION_INVESTIGATION_2026-08-14.md)
  — the twice-regressed defect, its archaeology, and the identity-plateau seed.
- [`SOL_WEEK_AUDIT_2026-08-14.md`](SOL_WEEK_AUDIT_2026-08-14.md) — finding S6(b) (empty during
  motion), finding at `:69` (the deleted route proof).
- [`MAINTAINER_RULINGS_2026-08-14.md`](MAINTAINER_RULINGS_2026-08-14.md) — `R-2026-08-14-3` upgraded
  pick-during-motion to a full investigation.
- `DEFERRED_WORK.md` — `:4584` (PickDepth's shipped window), `:4759` (priming ruled harmful),
  `:12675` (the 2674 ms / 44 frame cold-compile measurement), and
  `NEW-WEBGPU-ASYNC-PICK-PIPELINE-READINESS-CONTRACT` / `C11-03`, filed 2026-07-16, **not started** —
  which S2 directly serves.
- [`FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) subsystem 7 (Picking) — needs the corrections in §6.
