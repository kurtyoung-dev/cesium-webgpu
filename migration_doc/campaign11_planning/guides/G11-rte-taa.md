# Campaign-11 Cluster Guide G11 — RTE Precision + TAA Temporal Contracts (7)

**Author sweep HEAD: `c643516c04` (Batch 703, `main`).** Every anchor marked "verified" below was
re-grepped against `git show HEAD:` / `git grep <pat> HEAD` at that hash on 2026-07-18 — NOT against
the working tree. The tree is concurrently dirty under a running C10 worker, but the ONLY engine file
modified vs HEAD at author time is `packages/engine/Source/Renderer/WebGPU/WebGPUModelPipelineCache.ts`
(a C10 model-pipeline edit) — **none of this cluster's anchor files are dirty**, so tree greps and
HEAD greps agree for every symbol here. Line numbers are hints; **anchor by symbol** — the symbol
names are the contract. Where the register cited a line number, drift from HEAD is noted inline.

**This guide closes the phase-3 assembler gap:** the original 10 cluster guides covered 165/188
register items; `rte-taa` (7 items) and `clouds-weather` (16) had no owning guide (QUEUE §0
owning-guide caveat, lines 69–73). This is the `rte-taa` guide.

**Sources:** `migration_doc/campaign11_planning/CANDIDATE_REGISTER.md` §7 (`rte-taa`, 7 rows);
`migration_doc/QUEUE_2026-07-18_CAMPAIGN11.md` §1.7 (canonical id mapping) + §sequencing (lines
620–626) + §open-questions (lines 792–799); `migration_doc/QUEUE_2026-07-15_CAMPAIGN9.md` §7 (C9-24/25/26
R-foundation rows 40–42, C9-29 row 15, Gate E line 249, C9-48 row W8-9); `migration_doc/TAA_DESIGN.md`
(Slice 2b/3/4 table); `migration_doc/FEATURE_INVENTORY.md` §C.7 (TAA-DESIGN pending bullets 844–848,
791, 826); `CLAUDE.md` (the 64-Bit Precision & RTE charter, DP-H41). House format per
`migration_doc/campaign11_planning/guides/G1-pick-and-reds.md` + `G4-model-frame-delta.md`.

**Queue id mapping (reference only — refer to items by register NAME; the orchestrator owns the
numbering, do not re-assign):** per QUEUE §1.7 the cluster maps to `C11-51 … C11-57`:
`NEW-TAA-CUSTOM-FRUSTUM-JITTER-FALLBACK` = C11-51 (W1); `C9-24-RTE-PRODUCER-CONSUMER-INVENTORY` = C11-52
(W5, R0 foundation); `C9-25-PREVIOUS-FRAME-RTE` = C11-53 (dep C11-52); `C9-26-GPU-VISIBILITY-RTE-CLOSURE`
= C11-54; `NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT / C9-29` = C11-55; `TAA-DESIGN Slices 2b+3`
= C11-56; `TAA-DESIGN Slice 4` = C11-57 (dep C11-56).

---

## 0. Landed context this guide is written against (Batches 692–703)

| Batch | Change | Interaction with this cluster |
| --- | --- | --- |
| B693 | C10-01 default 3D collapses to **ONE** frustum | Shrinks — does NOT close — the multi-frustum TAA prize (`C9-29`). The natural-frustum depth/jitter/history mismatch now occurs only in 2D/CV (~16 bands), ortho-3D (3 bands), custom near/far, and the 2-frustum sky-only fallback. The per-frustum jitter is applied in a loop in `WebGPUSceneRenderer` (the `C11-51` throw site) once per contributing frustum. |
| B694 | C10-09 velocity **prev-buffer** revision-skip + GPU self-copy (3 renderers) | This is the **upload-economics** predecessor of `C9-25`, NOT the RTE math (the diff states "Zero shader/pipeline/RTE/layout change"). The prev buffers still hold `prevPosHigh`/`prevPosLow`; `C9-25` changes only how the SHADER consumes them, so the B694 revision-skip guard (`instanceDataRevision` vs `prevBufferRevision`) must stay green — do not regress it. |
| B697 | C10-03 demand-driven scene-color resolve (`_sceneColorResolveElisionEnabled`) | TAA is a demand consumer (reads scene color at binding 0 + depth at binding 2). Any `C9-29` per-frustum depth work must ensure TAA's demand still forces the correct resolve; the kill switch is a clean A/B isolation lever for TAA-black diagnosis. |
| B699 | C10-02 translucent-twin gate | Tangential (pick/model command economics); no RTE/TAA coupling, but tile command counts halved — velocity-command-count probes must not assert pre-B699 counts. |
| B702 | C10-06 TTFF boot concurrency + globe prewarm | Runtime-irrelevant to RTE/TAA. |

**Charter rules restated — NEVER weaken (CLAUDE.md "64-Bit Precision & RTE — CRITICAL"):**

1. **Rule 4 is the hardest line in this cluster.** "**NEVER** add `posHigh + posLow` directly — always
   subtract camera first." Any reconstruction of an **absolute ECEF `f32` position** before camera
   subtraction — in the current frame, a **previous** frame, or **GPU culling/LOD/visibility** data —
   is a HARD charter violation. Six velocity shaders currently do exactly this (§3 below). They carry
   in-source "precision loss at planet scale is acceptable" annotations; **those annotations are the
   debt `C9-24`/`C9-25` pay down, not a licence to keep them.** The guide holds the charter line.
2. **DP-H41 tail (verified at HEAD):** `CameraUniforms.previousViewProjection: mat4x4<f32>` sits at the
   struct tail (`chunks/structs/CameraUniforms.wgsl` shared struct has NO such field; the per-shader
   inline struct in `Model/ModelPBRComplete.wgsl` declares `previousViewProjection` at the tail, 304 B
   through it inside the 320 B `CAMERA_UNIFORM_SIZE`). JS writes `UniformState.previousViewProjection`
   (getter at `UniformState.js` `get previousViewProjection`, packed via
   `Matrix4.clone(this._viewProjection, this._previousViewProjection)`; IDENTITY fallback on frame 0).
   TAA/CSM/motion-vector passes read it via `camera.previousViewProjection`. Extending the tail is
   add-only — never reorder.
3. **Premise-verify-first — mandatory Step 0 on every item.** Several register rows carry stale line
   numbers (e.g. `C11-51` cited `WebGPUSceneRenderer.ts:1824`; the throw is now at the `Error` inside
   the `if (jitterActive)` block, `:1824` is the `jitterActive` const). Re-grep by symbol before touching.
4. **Probe-first (Principle 8).** Every fix here is visually or numerically verifiable. Build/extend a
   probe that reproduces the symptom BEFORE claiming a fix. No "reload and check" round-trips.
5. **One concern per slice; no feature removal/default-disable/degradation for a metric.** The single
   exception the maintainer already sanctioned (`C11-51`) is a **crash fix**: an exotic un-jitterable
   custom frustum runs TAA without jitter instead of throwing every frame — strictly better than crashing,
   and the correct conservative fallback.
6. **Gate E (C9 queue line 249):** "No safe-auto visibility restoration may run" until the RTE closure
   (`C9-26`) AND the natural-frustum TAA contract (`C9-29`) land. `C9-26`'s payoff — ever un-containing
   auto GPU cull / Hi-Z / sort / indirect (FAR-003/T7 tail) — is gated behind Gate E. This is a
   **correctness gate, not a perf gate**; do not let a perf argument pull cull restoration ahead of it.
7. **Perf evidence only from the moving multi-altitude route** (idle soak invalid). Most of this cluster
   is **correctness**, not perf — the promotion bar is a byte/pixel oracle, not a p95 delta. Where a
   perf claim IS made (`C9-26` restoring auto cull, deferred behind Gate E), the standard ≥10% whole-route
   / ≥15% near-ground WebGPU CPU-p95 or >3× noise bar applies, and a truthful miss with green mechanics
   is VALID COMPLETE.

**Model-tier legend:** `fable` = diagnostic / ambiguous / bisect / scheme-decision work; `opus-or-sol`
= well-specified execution against this guide. Items are referred to ONLY by register name.

---

## Intra-cluster sequencing (hard)

```
C11 W1:  NEW-TAA-CUSTOM-FRUSTUM-JITTER-FALLBACK   (crash-class, standalone, no deps — land first)

C11 W5:  C9-24-RTE-PRODUCER-CONSUMER-INVENTORY    (R0 foundation — the reviewed helper + numeric
            │                                       oracle + machine-readable inventory; prerequisite
            │                                       for C9-25/26 and Gate E; land BEFORE any conversion)
            ├──► C9-25-PREVIOUS-FRAME-RTE          (hard dep on C9-24: uses its blessed contract + oracle)
            ├──► C9-26-GPU-VISIBILITY-RTE-CLOSURE  (uses C9-24's oracle; contained path; Gate-E half)
            └──► NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT / C9-29
                                                    (Gate-E half; interacts w/ attachment-topology
                                                     per-frustum depth pack; benefits from C9-24 discipline)

         TAA-DESIGN Slices 2b+3  ──► TAA-DESIGN Slice 4   (P2 tail; 2b needs model-MRT velocity output
                                                            = second color attachment, cross-cluster with
                                                            attachment-topology; Slice 4 deps 2b+3)
```

`C9-24` is the keystone: it produces the one reviewed RTE helper contract + the GPU numeric oracle that
`C9-25`/`C9-26`/`C9-29` all verify against. Opening any conversion before `C9-24`'s oracle exists means
converting shaders with no way to prove the conversion is numerically correct — do not.

---

## 1. `NEW-TAA-CUSTOM-FRUSTUM-JITTER-FALLBACK` — P0 · S · crash-class · **opus-or-sol**

### What + why (evidence trail)

- Register §7 P0 (verified quote): "TAA + a custom frustum THROWS every frame mid-`executeCommands`
  (`WebGPUSceneRenderer.ts:1824`). Fall back to un-jittered `frustum.projectionMatrix` with a one-time
  pragma-wrapped warn; keep the throw debug-only." Source: C9Q §9 W5-84.
- This is a **crash-class** correctness bug: any app that assigns a user-authored frustum object to
  `camera.frustum` (satisfying the minimal frustum shape but not the convention-aware projection API)
  AND enables `scene.taaEnabled` throws once per contributing frustum, every frame, inside the hottest
  render loop. TAA + custom frustum is a legitimate combination; today it is unusable.

### Architecture today (verified at HEAD `c643516c04`)

All in `packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts`, inside the per-frustum band loop
that clones the camera frustum and applies raster-space NDC jitter (register `:1824` drifted — the
symbols are the contract):

- The jitter-active gate: `const jitterActive = taaScene.taaEnabled === true && taaEffect !== undefined
  && scene._frameState?.passes?.render === true && taaScene._snapshotMode?.isFrozen !== true;`
  (`taaEffect` resolved from `taaScene._alternateSceneRenderer?._postProcess?.taaEffect`).
- The throw (verified) inside `if (jitterActive) { … }`:
  ```ts
  projection = frustum.getProjectionMatrix?.(context.clipSpaceConvention);
  if (projection === undefined) {
    throw new Error("WebGPU frustum must support explicit clip-space projection");
  }
  ```
  The `?.` short-circuits when `frustum.getProjectionMatrix` is **absent** (a custom frustum lacking the
  convention-aware method) OR when it returns `undefined` for the requested `clipSpaceConvention`; either
  way `projection === undefined` → throw. The same block conditionally jitters
  `getInfiniteProjectionMatrix` and restores both in the `finally`.
- The jitter helper is `applyProjectionJitterToScratch(projection, taaEffect.projectionJitterNdcX,
  taaEffect.projectionJitterNdcY)` (defined + exported in `WebGPUTAAEffect.ts`; homogeneous-row
  translation, works for perspective AND orthographic — so the jitter itself is convention-agnostic once
  a projection matrix exists).
- The standard frustums are NOT the problem: `PerspectiveFrustum.getProjectionMatrix(clipSpaceConvention)`
  and `OrthographicFrustum.getProjectionMatrix(clipSpaceConvention)` both exist at HEAD (each delegates to
  `this._offCenterFrustum.getProjectionMatrix(clipSpaceConvention)`). Only a **custom** frustum object
  hits the undefined branch. The plain `frustum.projectionMatrix` getter is the WebGL-convention fallback
  the register names.
- Existing warn precedent: `Tools/visual-regression/probe-taa-userwarn.mjs` exists — a one-time-warn
  pattern for TAA is already probed; reuse its assertion shape.

### Implementation walkthrough

**Step 0 — premise (probe-first, mandatory).** Reproduce the throw: propose extending
`probe-taa-userwarn.mjs` (or a new `probe-taa-custom-frustum-fallback.mjs`) that (a) enables
`scene.taaEnabled`, (b) assigns a minimal custom frustum object to `camera.frustum` exposing
`.projectionMatrix`/`.near`/`.far` but NO `getProjectionMatrix(convention)`, (c) renders one frame and
asserts the CURRENT behavior throws (captured via the probe's console/exception hook). This pins the
premise before the fix and becomes the permanent RED→GREEN gate.

1. **Replace the throw with a graceful fallback (production path).** When
   `frustum.getProjectionMatrix?.(context.clipSpaceConvention) === undefined`, set `jitterActive = false`
   for THIS frustum (skip the jitter block entirely) and let `uniformState.updateFrustum(frustum)` run on
   the un-jittered `frustum.projectionMatrix`. TAA still runs — it falls back to depth-reprojection with
   zero sub-pixel jitter for that frustum, which is the correct conservative behavior (better than a
   crash, no visible artifact beyond slightly-less-effective AA on the exotic path).
2. **Keep the throw debug-only.** Wrap the `throw` in `//>>includeStart('debug', pragmas.debug); … 
   //>>includeEnd('debug');` so development builds still fail loudly on a genuinely malformed frustum
   (helps catch real regressions in the standard frustum classes), while production degrades gracefully.
   This matches CLAUDE.md logging rules: a real-bug sentinel that would produce broken output stays, but
   the "unsupported optional capability" case is not a broken-output bug — it is a supported degraded mode.
3. **One-time pragma-wrapped warn.** On the first fallback per effect lifetime, emit a debug-pragma'd
   `console.warn` (throttled/once) naming that the custom frustum lacks convention-aware projection so
   TAA jitter is disabled for it. Use a boolean latch (e.g. `this._customFrustumJitterWarned`) so the warn
   fires once, not per-frame-per-frustum.
4. **Do NOT touch the jitter math or the standard-frustum path** — byte-identical for
   Perspective/Orthographic (their `getProjectionMatrix` returns defined). The change is purely the
   undefined-branch behavior.

**Invariant / oracle:** with a standard frustum, jitter behavior is byte-identical to today (the fallback
branch is never taken). With a custom frustum, the frame renders (no throw), TAA composites, and exactly
one warn fires per effect lifetime.

### Traps

1. **Do not silently disable TAA for the whole scene** — disable jitter for the un-jitterable frustum
   ONLY. Other (standard) contributing frustums in the same frame keep their jitter.
2. **Principle 9 corollary:** full jitter support for arbitrary custom frustums would require the custom
   frustum to expose a convention-aware `getProjectionMatrix` — that is genuinely missing functionality
   on user-supplied objects, not something the renderer can synthesize (it cannot know a stranger
   frustum's clip-space convention). Name this in the ledger: the fallback is correct and complete for
   the crash; "jitter-on-custom-frustum" is a documented-unsupported capability, not a silent no-op.
3. **The `finally` restore block** reads `this._projectionJitterRestore`/`_infiniteProjectionJitterRestore`
   — when the fallback skips the jitter, `projection` stays `undefined` and the restore guards
   (`if (projection !== undefined …)`) already no-op. Verify the skip path leaves those guards correct
   (they do at HEAD — the restore is conditioned on `projection !== undefined`).
4. **Snapshot/frozen mode** already zeroes jitter via `taa.resetJitter()` (Scene.js driver) and
   `_snapshotMode?.isFrozen !== true` in the gate — do not regress that interaction.

### Verification recipe

- **New/extended probe** `probe-taa-custom-frustum-fallback.mjs`: RED (throws) at pinned HEAD → GREEN
  (renders + one warn) after the fix; assert frame pixels are non-degenerate (not black) and the warn
  count is exactly 1 over N frames.
- **Regression:** `probe-taa-jitter.mjs` (standard perspective — byte-identical jitter),
  `probe-taa-resolve.mjs`, `diag-taa-black.mjs` (TAA still composites, no black),
  `probe-taa-morph-prevvp.mjs` (ortho/morph frusta unaffected). All GREEN, zero device errors.
- **capture-and-diff:** any TAA-on scene band unchanged vs baseline (standard frustum path is untouched).
- **On/off oracle:** revert the fix → probe throws again (proves causality).

### Model tier + effort

**opus-or-sol** — well-specified, bounded, the fallback contract is fully named. **S** (1 batch). The only
judgment (debug-vs-production polarity of the throw) is decided by CLAUDE.md logging rules, not ambiguity.

---

## 2. `C9-24-RTE-PRODUCER-CONSUMER-INVENTORY / FAR-305` — P1 · M · R0 FOUNDATION · **opus-or-sol** (sol-class judgment)

### What + why (evidence trail)

- C9Q §7 row 40 (verified): "One reviewed helper, machine-readable shader/CPU inventory, and GPU numeric
  oracle assert `(positionHigh-cameraHigh)+(positionLow-cameraLow)` or CPU-double relative origin for all
  current/previous consumers." Register §7 P1: "Prerequisite for C9-25/26/27/28 + Gate E." Priority tier
  R0/R2.
- This is the keystone. It produces (a) the ONE reviewed RTE-subtract helper the fleet should converge on,
  (b) a machine-readable inventory of every producer/consumer classifying each as RTE-safe or an
  absolute-ECEF-`f32` offender, and (c) a GPU numeric oracle that measures actual reconstruction error so
  `C9-25`/`C9-26` can prove their conversions correct. Without it, the conversions have no acceptance
  instrument.

### Architecture today (verified at HEAD `c643516c04`)

The surface is fragmented — this is exactly why the inventory is needed:

- **The one true shared helper:** `packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_translateRelativeToEye.wgsl`
  → `fn csm_translateRelativeToEye(positionHigh, positionLow, encodedCameraPositionMCHigh,
  encodedCameraPositionMCLow) -> vec4<f32>` (subtract-camera-in-split-domain + zero-length NaN guard).
  **But only ~6 files `#import` it** (`Generated/EllipsoidPrimitive.wgsl`, the three
  `Collections/Buffer*Material.wgsl`, `PhongLighting.wgsl`, plus the chunk).
- **The shared struct:** `chunks/structs/CameraUniforms.wgsl` → `struct CameraUniforms` with
  `encodedCameraPositionMCHigh`/`encodedCameraPositionMCLow` (vec4), `modelViewRelativeToEye`,
  `modelViewProjectionRelativeToEye`. **No `previousViewProjection` and no short-name
  `encodedCameraHigh`** in the shared struct — those live only in per-shader inline struct copies.
- **A second independent copy** of the RTE subtract: `chunks/functions/csm_polylineCommon.wgsl` →
  `csm_polylineRTE(high, low, camHigh, camLow)` + `csm_computePolylinePosition(...)` (uses short-name
  `camera.encodedCameraHigh/Low`).
- **The dominant reality: ~85 shaders each define a LOCAL `fn translateRelativeToEye`** (copy-paste), in
  two divergent signatures: `(posHigh, posLow, camHigh, camLow) -> vec3<f32>` (collections, globe, sun,
  sky, shadow) and `(high, low) -> vec4<f32>` (~60 `Primitive/Primitive*` + `Primitive/PolylineMat*`,
  reading the encoded camera from a bound uniform).
- **The CPU-side validators already exist:** `packages/engine/Source/Renderer/WebGPU/WebGPURTEAssertions.ts`
  → `export function assertCameraRTERoundTrip(high, low, expected, label)` and
  `export function assertMVTranslationZeroed(mv, label)` (debug-only; guard the classic swapped-high/low
  and translation-zeroed-after-projection packer bugs). Called from `WebGPUUniformGroupManager.ts` and
  `WebGPUBufferPrimitiveRenderer.ts` (`packCameraUniforms`).
- **CPU packers (previousViewProjection producers, all read `UniformState`):** the DP-H41 tail-writer in
  `WebGPUPrimitiveCommands.ts`; `WebGPUGlobeSurfaceCameraUB.ts` (`createCameraUniformBuffer` writes
  `previousViewProjection` at float offsets 100–115); plus ~19 renderers (Billboard/Label/Point/Polyline/
  Model/Ellipsoid/GroundPrimitive/GroundPolyline/PointCloud/GaussianSplat/Cloud/ComputeInstance/FlowField/
  Ocean/Vector3DTile×3/ProceduralCloud/VolumetricFog).
- **The precision-correct source of truth:** `packages/engine/Source/Renderer/UniformState.js` fields
  `_previousViewProjectionRelativeToEye` (getter `previousViewProjectionRelativeToEye`, IDENTITY frame 0)
  and `_previousCameraPosition` (getter `previousCameraPosition`), plus `encodedCameraPositionMCHigh/Low`,
  `modelViewProjectionRelativeToEye`. **No `previousEncodedCameraHigh/Low` / `previousCameraHigh` exists
  anywhere in the tree** (grep negative) — this is the missing plumbing `C9-25` must add (§3).
- **Adjacent deferred debt (register line 265):** `WGF-4` (P3, FI §D.8+§C.7) — "RTE camera-packer
  assertions still pending in 5 of 8 packers (Cloud/Ellipsoid/Splat/PointCloud/Voxel)." `C9-24` should
  fold these five into its assertion coverage so the inventory is complete.

### Implementation walkthrough

**Step 0 — premise.** Confirm nothing landed on the RTE surface past B703 (`git log --oneline -5 --
packages/engine/Source/Shaders/WebGPU/chunks packages/engine/Source/Renderer/WebGPU/WebGPURTEAssertions.ts`).
Reproduce the two existing RTE probes green as a baseline: `probe-ellipsoid-rte.mjs`, `probe-cloud-rte.mjs`.

1. **The one reviewed helper (deliverable a).** Do NOT rewrite 85 shaders in this slice. Instead:
   (i) ratify `csm_translateRelativeToEye` as the canonical current-frame subtract and document the
   two-signature reality in its docstring; (ii) define the canonical **previous-frame** subtract contract
   (the missing half) as a reviewed spec — the recommended shape (see §3, but `C9-24` blesses it):
   `previousViewProjectionRelativeToEye * vec4(csm_translateRelativeToEye(prevPosHigh, prevPosLow,
   encodedCameraHigh, encodedCameraLow) + cameraDelta, 1.0)` where `cameraDelta = currentCameraWC -
   previousCameraWC` (FP64 on CPU, small). This reuses the CURRENT encoded camera + a delta instead of
   introducing a full previous encoded-camera pair — the same trick the TAA post-process resolve already
   uses correctly (`WebGPUTAAEffect.updateMotionVectorParams` + `TAA.wgsl` comment "World-space
   reconstruction is deliberately avoided"). `C9-24` must WRITE THIS DOWN and get it reviewed; `C9-25`
   implements it. (Alternative: a true `previousEncodedCameraHigh/Low` pair in `UniformState` + camera
   UB. `C9-24` picks one; the delta approach is strongly recommended for its smaller surface and existing
   precedent.)
2. **Machine-readable inventory (deliverable b).** Produce a committed table (JSON or MD table under
   `Tools/visual-regression/` or `migration_doc/`) enumerating every RTE producer/consumer: file, symbol,
   signature, classification `{RTE-safe | absolute-ECEF-offender | doc-comment-only}`, and for offenders
   the exact expression. Seed it from this guide's §3 findings (6 confirmed offenders) + the ~85 local
   helpers + the compliant `Buffer*Material.wgsl` / `PolylineMat*.wgsl` counter-examples. Make it
   regenerable (a small grep-driven script) so it does not rot — a drifted inventory is worse than none.
3. **GPU numeric oracle (deliverable c).** Build a probe/spec that renders a known point at high altitude
   / far camera (where `f32` ECEF reconstruction visibly quantizes) and asserts, per consumer, that the
   reconstructed eye-relative position matches the CPU-double relative origin within a tight tolerance
   (sub-pixel NDC). This oracle is the acceptance instrument for `C9-25` (previous-frame) and `C9-26`
   (visibility). Extend `assertCameraRTERoundTrip` coverage to the 5 missing packers (WGF-4 fold-in).
   **This is where the "deliberately accepted" annotations get adjudicated:** the oracle MEASURES the
   pixel drift during an orbital fly-to; per the charter (rule 4) any offender is a defect to convert,
   and the oracle quantifies exactly how bad each is so `C9-25` can sequence worst-first.
4. **No behavior change in this slice.** `C9-24` ships the helper spec + inventory + oracle + the
   extended assertions — zero shader math changes. It is a written-artifact-and-tooling slice (like
   FAR-107 in the pick cluster).

**Invariant:** rendering is byte-identical after `C9-24` (assertions are debug-only; the oracle is a
probe; the inventory is a doc). The deliverable is TRUTH + an acceptance instrument, not a fix.

### Traps

1. **Do not start converting shaders here** — that is `C9-25`. Scope discipline: `C9-24` is the contract
   + oracle; if you convert even one shader, you have started `C9-25` without its acceptance instrument
   existing yet (circular).
2. **The two-signature split is load-bearing** — the `(high, low) -> vec4` primitive variant reads the
   encoded camera from a bound uniform; the `(posHigh, posLow, camHigh, camLow)` collection variant passes
   it. The inventory must record which signature each consumer uses so `C9-25` knows whether it needs a
   new UB field or can reuse a bound one.
3. **The oracle must run at far camera / high altitude** — a default-camera oracle will show ZERO drift
   (eye-relative magnitudes stay small near the surface). The whole point is the orbital-fly-to regime
   where `f32` ECEF has ~0.76 m ULP (per the `TAA.wgsl` comment). Match the `probe-ellipsoid-rte.mjs`
   camera regime or push further out.
4. **`assertCameraRTERoundTrip`/`assertMVTranslationZeroed` are stripped in production** (debug pragma) —
   the oracle probe must run on an UNMINIFIED build for the assertions to fire.

### Verification recipe

- **Oracle probe** (new, e.g. `probe-rte-numeric-oracle.mjs`): renders a fiducial point per consumer
  family at far camera; asserts reconstructed-vs-CPU-double agreement within tolerance; RED for the 6
  known offenders (documents their measured drift as the `C9-25` baseline), GREEN for the compliant
  precedents. This probe SURVIVES as the `C9-25`/`C9-26` gate.
- `probe-ellipsoid-rte.mjs` + `probe-cloud-rte.mjs` stay green (existing RTE coverage).
- `npx tsc --noEmit` (the helper spec + any TS assertion-coverage additions type-clean, no `any`).
- Inventory committed + cross-referenced from `DEFERRED_WORK.md` / `FEATURE_INVENTORY.md`.
- **Promotion stance:** this is a foundation slice — the bar is "oracle reproduces the known offenders'
  drift + inventory is complete + helper contract reviewed," NOT a perf/pixel delta.

### Model tier + effort

**opus-or-sol** — well-specified authoring; **sol-class judgment** is valuable for the helper-contract
API taste and the delta-vs-previous-encoded-camera decision. **M** (1–2 batches). The scheme decision in
Step 1 is the one judgment call; it is bounded by the two named options + the in-tree TAA-resolve precedent.

---

## 3. `C9-25-PREVIOUS-FRAME-RTE / FAR-306` — P1 · L · dep `C9-24` · **fable** (scheme) → **opus-or-sol** (conversion)

### What + why (evidence trail)

- C9Q §7 row 41 (verified): "Convert Billboard, SDF, Point, Polyline, ComputeInstance, and Model velocity
  to matching previous-frame high/low camera-relative math; test camera/object motion, teleports, negative
  coordinates, poles, and antimeridian." Register §7 P1: "temporal shaders currently reconstruct absolute
  ECEF f32. W8/C10-09 landed only the prev-buffer upload economics, not this conversion."
- **This is the rule-4 charter-violation fix.** Six velocity vertex shaders reconstruct an absolute
  world position (`prevPosHigh + prevPosLow`, or `previousModelMatrix * prevPositionMC` for models) and
  multiply by the full-magnitude `camera.previousViewProjection`. The CURRENT-frame leg of each is already
  RTE-safe (`camera.mvpRelativeToEye * rte`). The asymmetry produces motion vectors that drift by multiple
  pixels during orbital fly-to (per `TAA.wgsl`'s own reasoning) → ghosting/smearing on animated content
  under camera motion.

### Architecture today (verified at HEAD `c643516c04`)

**The six offenders (all verified by direct grep — the expression is the anchor):**

| Shader | Offending previous-frame expression |
| --- | --- |
| `Shaders/WebGPU/Collections/BillboardCollection.wgsl` `fn vertexVelocityMain` | `prevWorldPos = vec4(prevPosHigh + prevPosLow, 1.0); prevCenterClip = camera.previousViewProjection * prevWorldPos` (attrs `@location(11/12) prevPosHighAndScale / prevPosLowAndRotation`) |
| `Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl` (SDF labels) `fn vertexVelocityMain` | same `prevPosHigh + prevPosLow` → `previousViewProjection *` (attrs `@location(13/14)`) |
| `Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl` `fn vertexVelocityMain` | `prevWorldPos = vec4(prevPosHigh + prevPosLow, 1.0); prevCenterClip = camera.previousViewProjection * prevWorldPos` (attrs `@location(7/8)`) |
| `Shaders/WebGPU/Collections/PolylineCollection.wgsl` `fn vertexVelocityMain` | `prevStartWorld = vec4(prevStartHigh + prevStartLow, 1.0)` + `prevEndWorld` → both `* camera.previousViewProjection`; current leg uses `translateRelativeToEye(...) * mvpRelativeToEye` |
| `Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl` `fn vertexVelocityMain` | `prevWorld = vec4(prev.positionHigh + prev.positionLow, 1.0); prevCenterClip = camera.previousViewProjection * prevWorld` (prev SSBO `@binding(3)` ping-pong; comment even states "previousViewProjection is a plain world-space matrix, not RTE") |
| `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` VS velocity | rebuilds `prevPositionMC` via full morph→skin→instance with prev data, then `worldPosPrevious = material.previousModelMatrix * vec4(prevPositionMC, 1.0); output.previousClipPos = camera.previousViewProjection * worldPosPrevious` (DP-H36 comment: prev path "multiplies by previousModelMatrix (full-magnitude, non-RTE)"). Model-space, not high+low, but the same absolute-`f32` compromise. |

**The in-tree RTE-correct precedent (copy this pattern):**
`Shaders/WebGPU/Collections/BufferPolylineMaterial.wgsl` computes BOTH current and previous positions via
`csm_translateRelativeToEye(input.prevPositionHigh, input.prevPositionLow, camera.encodedCamera…High,
…Low)` then `camera.projectionMatrix * vec4(prevEC, 1.0)` — no absolute reconstruction. Same for
`Primitive/PolylineMat*.wgsl` via `csm_computePolylinePosition(prevPositionHigh, prevPositionLow, …)`.

**The CPU velocity-command emit sites (each stamps `.velocityCommand` on the color/draw command, gated on
`frameState.taaEnabled`; the scene velocity pass walks the frustum list):**

| Renderer | Emit symbol | Descriptor / pipeline symbol |
| --- | --- | --- |
| `WebGPUBillboardRenderer.js` | `_updateWebGPUBillboardsInner` (`cache.colorCommand.velocityCommand = cache.velocityCommand`) | `buildBillboardVelocityDescriptor` |
| `WebGPUPointPrimitiveRenderer.js` | `_updateWebGPUPointPrimitivesInner` | `buildPointVelocityDescriptor` |
| `WebGPUPolylineRenderer.js` | `_updateWebGPUPolylinesInner` | `buildPolylineVelocityDescriptor` / `getOrCreatePolylineVelocityPipelineEntry` |
| `WebGPULabelRenderer.js` (SDF) | `_updateWebGPULabelsInner` (`sdfCommand.velocityCommand = sdfVelocityCommand`) | `buildSDFVelocityDescriptor` |
| `WebGPUComputeInstanceRenderer.ts` | `attachVelocityCommand` | `tryResolveVelocityPipeline` |
| `WebGPUModelRenderer.ts` | `updateWebGPUModel` (`webgpuCmd.velocityCommand = velocityCmd`) | `pipelineCache.getVelocityPipeline(alphaMode, isDoubleSided, materialDefines)` |

**Missing plumbing (Principle 9 — net-new):** there is **no `previousEncodedCameraHigh/Low` in
`UniformState` or any camera UB.** The per-object velocity path receives only the full-`f32`
`previousViewProjection`. `C9-25` must introduce the previous-frame RTE inputs (per the `C9-24`-blessed
contract). The prev buffers already hold `prevPosHigh`/`prevPosLow` (B694), so no buffer-content change —
only shader math + camera-UB fields change.

### Implementation walkthrough

**Step 0 — premise + gate.** (a) Confirm `C9-24` has landed its blessed previous-frame contract + numeric
oracle (hard dep — do not start otherwise). (b) Reproduce the drift: run the `C9-24` oracle at far camera
against each of the 6 offenders and record the measured per-shader NDC drift as the BEFORE baseline.
(c) Confirm B694's revision-skip guard (`instanceDataRevision` vs `prevBufferRevision`) is green
(`probe-c10-09-prev-buffer-upload.mjs`) — you must not regress it.

**Step 1 — the scheme decision (fable; this is the ambiguous part).** Adopt the `C9-24`-recommended
delta contract for the COLLECTION offenders (billboard/SDF/point/polyline/compute-instance), all of which
hold `prevPosHigh`/`prevPosLow`:
```
prevEyeRelToPrevCam = csm_translateRelativeToEye(prevPosHigh, prevPosLow,
                        camera.encodedCameraHigh, camera.encodedCameraLow)   // rel to CURRENT camera
                      + camera.cameraDelta;                                  // + (currentCam - prevCam), FP64→f32
prevClip = camera.previousViewProjectionRelativeToEye * vec4(prevEyeRelToPrevCam, 1.0);
```
This requires adding `previousViewProjectionRelativeToEye` (exists in `UniformState`) + `cameraDelta`
(vec3; `UniformState.cameraPosition - previousCameraPosition`, FP64 on CPU) to each velocity path's camera
UB — a DP-H41-style add-only tail extension. It reuses the current encoded camera + a small delta, so no
new previous-camera encoding is needed. **The MODEL offender is a separate sub-case:** its prev position
is `previousModelMatrix * prevPositionMC`, not high/low — so it needs a per-primitive
`previousModelViewProjectionRelativeToEye` (previous MVP with the previous view translation zeroed),
analogous to the current `mvpRelativeToEye`. This is more involved (per-primitive matrix vs shared camera
field). If `C9-24`'s inventory left the model scheme open, this sub-decision is the fable call; if the
delta contract cleanly covers models too, it is mechanical.

**Step 2 — convert one family per commit (opus-or-sol).** Convert Billboard → SDF → Point → Polyline →
ComputeInstance → Model, each its own batch, each verified against the oracle + the visual velocity probe
before moving on. Prefer routing through the shared `csm_translateRelativeToEye` chunk (kill a copy of the
duplicated local helper as you go, per the ES6-modernization incremental rule — but only in files you are
already editing). Keep the CURRENT-frame leg byte-identical.

**Step 3 — camera-UB field addition.** Add `previousViewProjectionRelativeToEye` + `cameraDelta` (or the
per-primitive `previousMvpRelativeToEye` for models) to the affected velocity paths' camera UBs. Extend
`assertCameraRTERoundTrip`-style validation to the previous-frame packer (assert `cameraDelta` cancels the
6.37M magnitude cleanly). Reuse the DP-H41 tail-writer pattern in `WebGPUPrimitiveCommands.ts` where
applicable.

**Invariant / oracle:** after conversion, the `C9-24` numeric oracle reports previous-frame reconstruction
matching CPU-double within tolerance for ALL six families; velocity magnitudes at far camera drop from
multi-pixel drift to sub-pixel; on a STATIC scene (no camera/object motion) velocity is exactly zero
(the prev buffer aliases the current, and `cameraDelta = 0`, so the reconstruction is identity).

### Traps

1. **Do NOT weaken rule 4 by keeping any offender** "because the annotation says it's acceptable." The
   charter is explicit; `C9-24`'s oracle measured the real drift; the conversion is the fix. If a family
   genuinely cannot be converted (e.g. a third-party prev-matrix path), surface it as an explicit named
   deferral with the measured drift — do not leave a silent absolute-ECEF reconstruction.
2. **B694 economics must survive.** The prev buffers still hold high/low (unchanged); the revision-skip
   guard is orthogonal to shader math. But the model velocity path (`getVelocityPipeline`) gets a NEW
   pipeline variant if you change its define set — verify the pipeline cache key includes any new define
   so you don't alias the old variant (BUG-GLOBE-PIPELINE-NAME-AXES lesson from standing-reds).
3. **`cameraDelta` on the teleport frame:** the Scene driver already invalidates TAA history on
   `|cameraDelta| > 50 km` (teleport) and on morph/projection-flip. A per-object `cameraDelta` must be
   the SAME frame's delta the TAA resolve uses — source it from `UniformState`, not a per-renderer
   recompute, so the object velocity and the camera reprojection agree. On the teleport/history-invalid
   frame, velocity output is irrelevant (history is dropped) but must not NaN — guard `cameraDelta`
   finiteness.
4. **Model prev-skinning/morph is already re-run** with `previousJointMatrices` (`@binding(4)`) +
   `previousMorphWeights` (Audit A.5) to avoid phantom velocity on animated characters — do NOT regress
   that; the RTE conversion is orthogonal to the prev-skinning reconstruction. Only the final
   world→clip step changes.
5. **Static-instancing alias:** for static instanced content the prev buffer aliases the current one, so
   the instancing contribution to velocity is zero regardless of RTE-safety — verify the conversion keeps
   that zero (a spurious non-zero here would ghost static instances).
6. **Antimeridian / poles / negative coordinates** (register acceptance list): the eye-relative delta math
   is coordinate-origin-independent by construction, but TEST it — these are exactly where absolute-`f32`
   reconstruction breaks worst and where a subtraction-order bug hides.
7. **Particles are OUT OF SCOPE here** — there is no WebGPU particle velocity path to convert (see §6;
   the only WebGPU particle path is weather-compute, whose `velocity` is physics state, not a screen-space
   motion vector). Adding one is TAA-DESIGN Slice 3, net-new, not this conversion.

### Verification recipe

- **Primary oracle:** the `C9-24` `probe-rte-numeric-oracle.mjs` flips each converted family from RED
  (measured drift) to GREEN (sub-pixel) — the acceptance instrument.
- **Visual velocity probes:** `probe-taa-velocity-emission.mjs`, `probe-taa-model-skinned-velocity.mjs`,
  `probe-taa-disocclusion.mjs`, `probe-i3dm-instance-jitter.mjs` (instanced), plus a new far-camera
  moving-object leg (propose `probe-taa-velocity-far-camera.mjs`): high-contrast animated object at high
  altitude with camera in orbital motion — the smear/ghost is visible BEFORE, gone AFTER; read the PNGs.
- **capture-and-diff:** TAA-on scenes — the conversion is byte-identical on a STATIC scene (velocity=0);
  on a moving scene the diff should REDUCE ghosting vs baseline (record the improvement, not a byte-band).
- **On/off/restored:** temporary in-build toggle reverting a family's prev leg to the old absolute path;
  A (converted) vs B (reverted) shows the drift returning — proves causality.
- **Regression:** `probe-c10-09-prev-buffer-upload.mjs` green (B694 economics intact);
  `probe-motion-blur.mjs` (shares the velocity infrastructure).

### Model tier + effort

**fable** for Step 1 (the scheme decision, esp. the model per-primitive-matrix sub-case) if `C9-24` leaves
it open; **opus-or-sol** for the per-family mechanical conversion (Steps 2–3). **L** (5–6 batches: one per
family + the camera-UB plumbing). Do not batch families together — each needs its own oracle pass.

---

## 4. `C9-26-GPU-VISIBILITY-RTE-CLOSURE` — P1 · L · Gate-E half · **opus-or-sol** (fable audit)

### What + why (evidence trail)

- C9Q §7 row 42 (verified): "Store Hi-Z/SoA bounds camera-relative or high/low, expand conservative radius
  margin, and tag frame/camera/view/natural-frustum/depth/device generations. Point-cloud GPU LOD follows
  the same identity; auto use stays contained." Register §7 P1: "Precision prerequisite for ever restoring
  auto GPU cull/Hi-Z/sort/indirect (FAR-003/T7 tail)."
- The GPU-driven visibility feed stores **absolute ECEF `f32`** bounding-sphere centers and lacks
  view/depth/frame identity, so contained-off it is latent, and it can NEVER be safely un-contained
  (Gate E) until both are fixed. This is a rule-4 violation in the compute/culling data path.

### Architecture today (verified at HEAD `c643516c04`)

**Absolute-ECEF-`f32` offenders (two feeds; sort feed is clean):**

- **Frustum-cull feed** — `WebGPUSceneRenderer.gpuCullCommands()`:
  `const sphereData = new Float32Array(count * 4); sphereData[off] = bv.center.x; …y; …z; …radius;` then
  `culler.uploadBoundingSpheres(sphereData)`. `bv.center` is a `BoundingSphere` center = **absolute
  ECEF**, cast to `f32`, NO camera subtraction. Buffer: `WebGPUGPUCuller._sphereBuffer`; WGSL struct
  `BoundingSphereData.centerAndRadius: vec4<f32>` in `Shaders/WebGPU/Compute/FrustumCull.wgsl`
  (`fn isSphereInFrustum(center, radius)`, tested with world-space planes `dot(plane.xyz, center) +
  plane.w` — planes are also raw world-space `f32`). Culler class: `WebGPUGPUCuller.ts`
  (`uploadBoundingSpheres`, `uploadFrustumPlanes`, `dispatch`, `readResults`).
- **Hi-Z occlusion feed** — `WebGPUSceneRenderer._dispatchHiZOcclusion()` builds an SOA:
  `soa.centerX[valid] = c.x; soa.centerY = c.y; soa.centerZ = c.z;` from `bv.center` — raw ECEF `f32`,
  uploaded into `WebGPUHiZOcclusionDispatcher` (`sphereCenterX/Y/ZBuffer`, struct `BoundingSphereSOA`).
  `Shaders/WebGPU/Compute/OcclusionTest.wgsl` `fn computeMain` → `projectToNDC` computes
  `params.viewProjectionMatrix * vec4(worldPos, 1.0)` — a full `f32` world→clip of an absolute-ECEF center.
  `OcclusionParams.viewProjectionMatrix` is packed directly from `uniformState.viewProjection` with no
  eye-relative rebasing. Pyramid: `HiZPyramid.wgsl` / `HiZPyramidFromDepth.wgsl`.
- **Sort feed (NOT a violation — for contrast):** the sort SOA uses
  `getCommandDistanceSquaredForSort(cmd, camPos)` → a camera-RELATIVE scalar, not a world center;
  `Shaders/WebGPU/Compute/GPUSortKeys.wgsl` writes `sortKeysHigh`/`sortKeysLow` which are the **high/low
  words of a u64 SORT KEY** (distance + layer + priority) — NOT position high/low. Do not conflate.
  `WebGPUGPUSortKeysDispatcher.ts` + `BitonicSortU64.wgsl`.

**Missing identity tagging (verified — grep negative for `generation`/`frameNumber`/`revision` in the
culler):** cull results carry `objectCount` ONLY. `WebGPUGPUCuller.CullResults = {visibilityFlags,
visibleCount, objectCount}`; the consumer guard in `gpuCullCommands` is `prev.objectCount === count` (a
count match). Results are keyed per frustum in `_lastCullResultsByFrustum` and applied one frame stale
with NO verification the camera/view/frustum planes are unchanged. `WebGPUHiZOcclusionDispatcher`'s
`frameId` dedupes the pyramid rebuild only (`_lastBuiltFrameId`), never validated against the visibility
buffer. No device-generation stamping of in-flight result buffers.

**FAR-003 containment (keeps it off by default — verified):** `WebGPUContext._gpuCullingHint` default
`"never"` (setter `setGpuCullingHint`, mirrors `Scene.gpuCullingHint`). Per-frame gate:
`WebGPUSceneRenderer` reads `scene.gpuCullingHint ?? "never"`, `const forceOff = hint === "never"`
short-circuits all three activation gates (`_updateActivationGate`, hysteresis maps
`_gpuCullActiveByFrustum` / `_hiZActiveByFrustum` / `_gpuSortActiveByFrustum`). Separate consumer gates,
both default OFF: `_hiZConsumeEnabled = false` (`setHiZConsumeEnabled`), `_gpuSortConsumeMode = "never"`
(`setGpuSortConsumeMode`); command-drop gated inside `_filterByHiZVisibility` / `_applySortedOrder`.
Thresholds: `GPU_CULL_THRESHOLD_HI = 384` / `_LO = 192`; `HI_Z_THRESHOLD_HI = 2400` / `_LO = 1600`;
`GPU_SORT_KEYS_THRESHOLD_HI = 6000` / `_LO = 4000`. Diagnostics: `getContainmentStats()` reports
`"contained-unsafe-path"`. Pool: `WebGPUContextCullerPool.ts` (`getGpuCullerForOpaqueFrustum`,
`getGpuCullerForCascade`, `reapAllAuxCullers`).

### Implementation walkthrough

**Step 0 — premise.** Confirm `C9-24`'s oracle exists (the acceptance instrument for the visibility
reconstruction too). Confirm the path is still contained (`_gpuCullingHint === "never"` default; the
`high-density-5k-spheres` scene forces `gpuCullingHint='always'` and is a STANDING RED in the
standing-reds cluster — use `CesiumDebug.highDensityCull()` counters, NOT that scene's pixel gate).
Reproduce with the existing consumer probes: `probe-gpu-culler-consumers.mjs`,
`probe-hiz-occlusion-consumer.mjs`, `probe-hiz-occlusion-control.mjs`, `probe-hiz-tile-occlusion.mjs`,
`probe-culler-pool-decomp.mjs`.

1. **Camera-relative bounds (deliverable 1).** Convert both feeds to store camera-relative centers:
   either high/low split (`EncodedCartesian3` per center) or the CPU-double relative origin (subtract
   `uniformState.cameraPosition` in FP64 before the `f32` cast). For the frustum-cull feed the planes must
   be rebased to match (translate the frustum planes into the same eye-relative origin). For Hi-Z, pack
   `OcclusionParams.viewProjectionMatrix` as the eye-relative VP (`modelViewProjectionRelativeToEye`-class
   matrix) so `projectToNDC` operates on eye-relative positions. Verify against the `C9-24` oracle at far
   camera.
2. **Conservative radius margin (deliverable 2).** The `f32` quantization that remains after rebasing is
   sub-meter near the camera but grows with eye-relative distance; EXPAND the bounding radius by a
   conservative margin (proportional to eye-relative distance × `f32` ULP) so the rebased test never
   FALSE-CULLS a visible object (a Rule-1 violation delivered by an optimization — the worst failure
   mode). Over-culling is the only unacceptable direction; over-keeping is safe.
3. **Generation identity tagging (deliverable 3).** Tag every cull/Hi-Z result buffer with
   `{frame, camera, view, natural-frustum, depth, device}` generations and REFUSE to consume a result
   whose tags do not match the current frame's (replace the `objectCount === count` guard with a full
   identity match). Point-cloud GPU LOD (`PointCloudLOD.wgsl`, `WebGPUPointCloudRenderer`) follows the
   same identity — fold it in or file it as the immediate rider.
4. **Auto use STAYS CONTAINED.** This slice makes the path SAFE to un-contain; it does NOT flip the
   default. Un-containing is Gate E (needs `C9-29` too) and is a maintainer-reserved lever. Keep
   `_gpuCullingHint` default `"never"`, `_hiZConsumeEnabled = false`, `_gpuSortConsumeMode = "never"`.

**Invariant / oracle:** with the path force-enabled in a probe (`gpuCullingHint='always'` locally), the
rebased cull/Hi-Z produces a visible-set that is a SUPERSET of the CPU cull (never drops a visible object)
at far camera; the `C9-24` numeric oracle confirms eye-relative reconstruction is exact; identity tags
reject stale results across a forced camera jump.

### Traps

1. **Over-culling = missing geometry = Rule-1 violation.** The conservative radius margin is mandatory and
   must be proven at far camera (where quantization is worst). Add a debug-pragma'd cross-check comparing
   GPU-cull visible set vs CPU cull on sampled frames; ANY object CPU-visible but GPU-culled fails.
2. **Sort keys are NOT positions.** `sortKeysHigh`/`sortKeysLow` are u64 key words — do not "fix" them as
   if they were RTE position high/low. The sort feed is already camera-relative (distance scalar); leave it.
3. **Gate E is a hard correctness gate, not a perf gate.** Do not let a perf argument ("cull would win
   10%") pull un-containment ahead of `C9-29`. This slice's landing bar is "the contained path is now
   RTE-safe + identity-tagged," proven with the oracle — NOT a route p95.
4. **Clustered lighting is a DIFFERENT subsystem** (`WebGPUClusteredLightingDispatcher`,
   `ClusterBounds.wgsl`) — its `ClusterBounds` are view-space cluster AABBs, not visibility culling. Do
   not touch it here.
5. **Multi-context / device loss:** the device-generation tag must invalidate in-flight buffers on
   recovery (the pool nulls culler instances via `onDeviceInvalidated`, but result buffers aren't
   generation-stamped today — that is exactly deliverable 3).

### Verification recipe

- `probe-gpu-culler-consumers.mjs` + `probe-hiz-occlusion-consumer.mjs` + `probe-hiz-occlusion-control.mjs`
  + `probe-hiz-tile-occlusion.mjs` GREEN with the path FORCE-enabled at far camera; the superset invariant
  asserted via the debug cross-check counter.
- `C9-24` numeric oracle confirms eye-relative reconstruction for the cull/Hi-Z feed.
- Identity-tag test: force a camera teleport between dispatch and consume → stale result is REJECTED
  (not applied), no black flash.
- `CesiumDebug.highDensityCull()` stats before/after (counter evidence; the `high-density-5k-spheres`
  scene is a standing RED — do NOT use its pixel gate, coordinate with standing-reds cluster).
- **Promotion stance:** landing bar = RTE-safe + tagged + superset-proven (correctness). The perf payoff
  (auto cull restoration) is DEFERRED behind Gate E — no p95 claim in this slice.

### Model tier + effort

**opus-or-sol** for the mechanical rebasing + tagging (well-specified with these anchors); **fable audit**
for the conservative-radius-margin derivation (the one place a wrong constant silently over-culls). **L**
(2–3 batches: frustum-cull feed, Hi-Z feed, identity tagging + point-cloud LOD rider).

---

## 5. `NEW-TAA-MULTIFRUSTUM-DEPTH-REPROJECTION-CONTRACT / C9-29` — P1 · L · Gate-E half · **opus-or-sol** (fable audit)

### What + why (evidence trail)

- C9Q §5 row 15 (verified): "Give every contributing natural frustum exact current/previous depth,
  projection, jitter, and history identity. Moving high-contrast near/far oracle must distinguish TAA
  on/off, camera/object motion, clears, and teleports." Register §7 P1: "the confirmed natural-frustum
  TAA mismatch owner." Gate E (C9 line 249) includes this contract.
- The TAA resolve is a SINGLE fullscreen pass reading ONE depth texture + ONE `previousVpRte`, but the
  scene is rendered in multiple **natural frusta** (near/far depth bands), each with its own projection,
  jitter, and depth range. The single-matrix resolve cannot correctly reproject pixels from a frustum
  whose projection differs from the one baked into `previousVpRte` → misreprojection / ghosting at band
  boundaries.

### Architecture today (verified at HEAD `c643516c04`)

- **The resolve is single-matrix (verified):** `Shaders/WebGPU/PostProcess/TAA.wgsl` `struct TAAParams`
  carries ONE `currentVpRte`, ONE `previousVpRte`, ONE `inverseCurrentVpRte`, ONE `cameraDelta`. The
  resolve (`fn reprojectUV` / `fn fragmentMain`) samples ONE `depthTex` (`@binding(2)`). It is RTE-safe
  (unprojects to eye-relative, translates by `cameraDelta`, reprojects — deliberately NO world-space
  reconstruction) — **the RTE math is correct; the MULTI-FRUSTUM identity is what is missing.**
- **The driver is single-matrix (verified):** `Scene.js` (`if (scene.taaEnabled) { … }` block) calls
  `taa.computeJitter(frameState.frameNumber, …)` ONCE per frame and
  `taa.updateMotionVectorParams(us.viewProjectionRelativeToEye, us.previousViewProjectionRelativeToEye,
  deltaX, deltaY, deltaZ, valid)` ONCE — using the WHOLE-view VP, not per-frustum. History invalidation is
  frame-global (`isTeleport` on `|cameraDelta| > 50 km`; `isMorphing`; `projectionFlipped` ortho↔persp).
- **The jitter IS applied per-frustum:** `WebGPUSceneRenderer` clones the frustum per band and calls
  `applyProjectionJitterToScratch` per contributing frustum (the §1 loop). So the SCENE is jittered
  per-frustum but the RESOLVE reprojects with a single whole-view matrix — the mismatch.
- **B693 shrank the default exposure:** default 3D = ONE frustum (`probe-frustum-count-3d.mjs` guards it),
  so the single-matrix resolve is EXACT at 3D defaults. The mismatch now bites only in: 2D/CV (up to ~16
  bands), ortho-3D (3 bands), custom near/far, and the 2-frustum sky-only fallback. `probe-pick-multifrustum.mjs`
  / `probe-clustered-multifrustum.mjs` exercise multi-frustum paths.
- **B697 interaction:** demand-driven scene-color resolve — the TAA depth binding (`@binding(2)`) reads
  the scene depth; per-frustum depth handling here must ensure the resolve sees the correct
  (packed/per-band) depth, and that TAA's demand forces the right resolve (kill switch
  `_sceneColorResolveElisionEnabled` for A/B). Attachment-topology cluster owns the per-frustum depth PACK
  (C9-10 / S7-2) — **coordinate, do not collide:** `C9-29` owns the TAA-side per-frustum depth/projection/
  jitter/history IDENTITY; the depth-pack economics belong to the attachment-topology guide.

### Implementation walkthrough

**Step 0 — premise + acceptance oracle FIRST (probe-first, this IS the deliverable).** Build the register's
acceptance instrument: propose `probe-taa-multifrustum-oracle.mjs` — a moving high-contrast near/far scene
(object near the camera + object at the far band) that distinguishes: TAA on vs off, camera motion vs
object motion, clears, and teleports, across 2D / ortho / custom-near-far / sky-fallback frustum counts.
Assert the CURRENT mismatch (ghosting at band boundaries under motion) as the RED baseline. Verify
`numFrustums` in the probe so you know which mode you are exercising (per §1's `frustumCommandsList`).

1. **Design the per-frustum identity (fable audit — the ambiguous core).** Decide the contract: each
   contributing natural frustum needs its OWN `{currentVpRte, previousVpRte, jitter, depth-range, history
   identity}`. Options: (a) resolve per-frustum (N TAA passes, one per band, each reading its band's
   depth + matrices) — clean but N× resolve cost; (b) a single resolve consuming a per-frustum matrix
   array + a band-index depth lookup — cheaper but more complex WGSL. B693 makes the default N=1, so option
   (a)'s cost is paid only in the multi-band modes (2D/CV/ortho) that are already off the perf-critical
   route. Recommend option (a) for correctness clarity unless a probe shows the 2D 16-band cost is
   prohibitive. `C9-24` discipline applies (all matrices RTE).
2. **Thread per-frustum current/previous matrices + jitter.** `updateMotionVectorParams` becomes
   per-frustum (the driver already loops frusta for jitter; extend it to publish per-frustum VP RTE +
   jitter to the resolve). `previousVpRte` per frustum must be the SAME frustum's prior-frame matrix —
   store a per-frustum history (band identity) so a band that appears/disappears frame-to-frame
   invalidates its own history, not the whole frame.
3. **Per-frustum depth.** Ensure the resolve reads the depth belonging to the band it is reprojecting
   (coordinate with attachment-topology's per-frustum depth pack — consume its contract, do not
   re-implement it). The RTE unproject/reproject math in `TAA.wgsl` is unchanged; only the matrices +
   depth source become per-frustum.
4. **History identity across teleports/clears/morph.** Preserve the frame-global invalidation
   (`isTeleport`/`isMorphing`/`projectionFlipped`) AND add per-band invalidation (a band whose near/far
   changed materially, or that was empty last frame, drops its own history). The acceptance oracle's
   clears/teleports legs verify this.

**Invariant / oracle:** the multi-frustum oracle shows NO band-boundary ghosting under camera or object
motion; TAA on/off is distinguishable; a teleport invalidates cleanly (one-frame passthrough, no smear);
default 3D (N=1) is byte-identical to today (single-matrix resolve is the N=1 special case).

### Traps

1. **Do NOT regress the N=1 default path** — `probe-frustum-count-3d.mjs` guards B693's one-frustum
   invariant; the per-frustum contract must reduce to today's single-matrix resolve exactly when N=1
   (byte-identical). Assert it.
2. **Gate E:** this contract is the OTHER half (with `C9-26`) gating auto-visibility restoration. It is a
   correctness deliverable; the landing bar is the acceptance oracle passing, not a perf number.
3. **Attachment-topology collision:** the per-frustum depth PACK (C9-10 / S7-2, XL, DEFERRED-BLOCKED) is a
   different owner. `C9-29` consumes whatever per-frustum depth contract exists; if it does not exist yet,
   `C9-29`'s scope is the TAA-side identity (matrices/jitter/history) and it must FLAG the depth-pack
   dependency to the orchestrator (see OPEN QUESTIONS) rather than build the pack itself (one concern per
   slice).
4. **DP-H41 every frame:** camera-only reuse tiers (frame-delta cluster S1-6) must still advance
   `previousViewProjection`/`previousViewProjectionRelativeToEye` every frame — the per-frustum history
   assumes a fresh prior matrix each frame. Do not let a future frame-delta optimization stale it.
5. **B697 resolve elision:** verify TAA's per-frustum depth demand forces the correct scene-color/depth
   resolve; use `_sceneColorResolveElisionEnabled` A/B to isolate any TAA-black regression.

### Verification recipe

- **Acceptance oracle** (new `probe-taa-multifrustum-oracle.mjs`): the register's moving high-contrast
  near/far test across 2D/ortho/custom-near-far/sky-fallback; RED (band-boundary ghosting) → GREEN.
  Read the PNGs.
- **N=1 byte-identity:** `probe-frustum-count-3d.mjs` green; `probe-taa-jitter.mjs` +
  `probe-taa-resolve.mjs` byte-identical on default 3D (single frustum).
- **Multi-frustum regression:** `probe-pick-multifrustum.mjs`, `probe-clustered-multifrustum.mjs`,
  `probe-taa-morph-prevvp.mjs` (morph/ortho flip) green.
- **capture-and-diff:** 2D + ortho TAA scenes — ghosting reduced vs baseline (record improvement);
  default 3D band unchanged.
- **On/off/restored:** temp toggle reverting to single-matrix resolve → multi-frustum ghosting returns.

### Model tier + effort

**opus-or-sol** for the threading + resolve changes; **fable audit** for the per-frustum-identity design
(option a vs b) and the history-invalidation-per-band correctness. **L** (2–4 batches). Sequence after (or
alongside) `C9-24`; coordinate the depth-pack dependency with attachment-topology BEFORE opening.

---

## 6. `TAA-DESIGN Slices 2b+3` — P2 · L · parity · **opus-or-sol**

### What + why (evidence trail)

- FEATURE_INVENTORY §C.7 (verified bullets 844–846) + TAA_DESIGN.md Slice 2b/3 table: "Per-model MRT
  motion vectors for skinned/morphed/instanced prims (2b); YCoCg 3×3 variance clipping; particle
  `previousPositionWC` (3) — animated content ghosts/smears under TAA until these land." Register §7 P2.
- These are the PARITY improvements that make TAA correct for animated content: the depth-only
  reprojection treats skinned/morphed/instanced geometry as static (ghosts it), and the tonemap-space RGB
  AABB clamp is weaker than YCoCg variance clipping.

### Architecture today (verified at HEAD `c643516c04`)

- **Slice 2b — model MRT velocity is PLUMBED but GATED OFF.** `Model/ModelPBRComplete.wgsl`:
  `computeMotionVectorScreenSpace(input)` exists and is gated `if (material.motionFlags.x < 0.5) { return
  vec2(0.0); }` — the per-model velocity math (via `previousClipPos`/`currentClipPosForVelocity` at
  `@location(8/9)`) is present but the `@location(1)` MRT velocity OUTPUT is disabled because it requires
  a second color attachment on model pipelines ("turning it on requires the second color attachment to be
  added to model pipelines, which is a follow-up slice" — the shader's own comment). Prev-skinning is
  ready (`previousJointMatrices` `@binding(4)`, `previousMorphWeights`). So Slice 2b = ENABLE the MRT
  output (add the second attachment to `getVelocityPipeline` variants + the model pipeline format) —
  cross-cluster with attachment-topology (the MRT/normal-G-buffer topology work, C9-10 / Phase-8a).
- **The TAA resolve already CONSUMES the motion texture:** `TAA.wgsl` `@binding(5) motionTex` +
  `sampleMotionTexture` — "Per-pixel velocity correctly handles skinned/morphed/instanced/animated
  geometry that depth-reprojection treats as static." Bound to a 1×1 zero placeholder when no velocity
  pass populated it (`WebGPUTAAEffect._motionPlaceholderView`). So the CONSUMER is ready; Slice 2b lights
  up the PRODUCER for models (and, via `C9-25`, collections already emit velocity commands).
- **Slice 3 YCoCg — current clamp is RGB tonemap-space AABB (verified):** `TAA.wgsl`
  `fn computeNeighborhoodAABB` builds a 3×3 min/max in `tonemapWeight` (RGB) space, `clampToAABB` clamps
  to it. Slice 3 upgrades this to YCoCg 3×3 variance clipping (mean ± γ·stddev in YCoCg space) — a
  contained change to the resolve shader.
- **Slice 3 particle `previousPositionWC` — NET-NEW, not a conversion (verified):** there is NO
  `previousPositionWC` anywhere in the tree and NO WebGPU particle velocity path. `ParticleSystem.js` is
  the CPU/BillboardCollection-driven WebGL path (no WebGPU renderer). The only WebGPU particle path is
  weather-compute (`Compute/WeatherParticles.wgsl` sim + `Compute/WeatherParticleRender.wgsl` draw), whose
  `velocity` field is PHYSICS state (m/s), not a screen-space motion vector — `WeatherParticleRender.wgsl`
  has only `vertexMain`/`fragmentMain`, no velocity entry point, no prev binding. So particle
  `previousPositionWC` is a **Principle-9 missing-functionality** item: adding it means adding a
  previous-position path to whichever particle path is in scope. Flag as gated.

### Implementation walkthrough

**Step 0 — premise.** Confirm the model MRT plumbing is still present + gated (`motionFlags.x` gate in
`computeMotionVectorScreenSpace`) and the resolve motion binding is live (`probe-taa-velocity-emission.mjs`
shows the placeholder path today). Confirm the attachment-topology MRT topology status (does the model
pipeline already have a second color attachment slot from the normal-G-buffer work? — coordinate at intake).

1. **Slice 2b — enable model MRT velocity output.** Add the `@location(1)` velocity output to the model
   FS (write `computeMotionVectorScreenSpace(input)`), add the second color attachment to the model
   velocity pipeline variants (`getVelocityPipeline`), and flip `motionFlags.x` on for animated model
   primitives. This is cross-cluster: the second attachment IS the MRT topology surface owned by
   attachment-topology (C9-10 / Phase-8a normal-G-buffer). Sequence AFTER the MRT topology can carry a
   velocity slot — do not add a bespoke second attachment that collides with the normal-G-buffer slot.
   **Depends on `C9-25` for correctness:** the velocity the model FS writes uses `previousClipPos` built
   from the (currently absolute-`f32`) previous-frame path — enabling MRT velocity BEFORE `C9-25` converts
   the model prev leg would ship pixel-drifting velocity at far camera. Sequence 2b after `C9-25`'s model
   family, or accept the far-camera drift as a documented interim (flag it).
2. **Slice 3 — YCoCg variance clipping.** Replace `computeNeighborhoodAABB` + `clampToAABB` with a YCoCg
   3×3 variance-clip (compute mean + variance in YCoCg, clip history to mean ± γ·stddev). Contained to
   `TAA.wgsl`. This is the standard "variance clipping" upgrade; keep the disocclusion gates (motion
   magnitude, depth, normal-divergence) unchanged.
3. **Slice 3 — particle `previousPositionWC` (gated).** Only if a WebGPU particle velocity path is in
   scope: add a `previousPositionWC` to the particle simulation state (weather-compute or a new particle
   renderer) and emit a velocity command like the collection renderers. If no WebGPU particle renderer
   exists to carry it, this sub-item is BLOCKED on that renderer — surface as such (do not fabricate a
   half-path).

### Traps

1. **Slice 2b is cross-cluster.** The second color attachment is attachment-topology's MRT topology — do
   NOT add a model-only second attachment that the topology work later has to reconcile. Coordinate
   sequencing with the attachment-topology guide owner.
2. **2b depends on `C9-25` for far-camera correctness.** Enabling model velocity output while the model
   prev leg is still absolute-`f32` ships drifting velocity — sequence after `C9-25`'s model conversion or
   document the interim drift explicitly.
3. **YCoCg must not regress the disocclusion gates.** The variance clip REPLACES the AABB clamp only; the
   motion-magnitude / depth / normal-divergence rejections in `reprojectUV` stay.
4. **Particle path is genuinely missing** — do not synthesize a fake `previousPositionWC` on a path that
   has no previous-position storage. Name the missing renderer.

### Verification recipe

- `probe-taa-model-skinned-velocity.mjs` + `probe-taa-velocity-emission.mjs`: with 2b enabled, a skinned/
  morphed model under a STATIC camera shows correct per-vertex velocity (no ghost) vs the depth-only
  reprojection baseline; read the PNGs.
- `probe-model-taa-msaa.mjs`, `verify-hdr-taa.mjs`: MRT velocity output composes correctly under MSAA/HDR.
- `probe-taa-disocclusion.mjs`: YCoCg variance clip suppresses ghosting at least as well as the AABB
  (record the improvement); `capture-and-diff` TAA scenes.
- **On/off/restored:** toggle `motionFlags.x` / the YCoCg path; A/B shows animated-content ghosting return.

### Model tier + effort

**opus-or-sol** — well-specified, mostly contained (YCoCg) + one cross-cluster enable (2b MRT). **L**
(2b: 1–2 batches gated on attachment-topology; YCoCg: 1 batch; particle: gated/blocked). Particle
`previousPositionWC` may not be schedulable until a WebGPU particle renderer exists — flag to orchestrator.

---

## 7. `TAA-DESIGN Slice 4` — P2 · L · correctness · dep Slices 2b+3 · **opus-or-sol** (dossier)

### What + why (evidence trail)

- FEATURE_INVENTORY §C.7 (verified bullets 847–848, 791, 826) + TAA_DESIGN.md Slice 4 row: "3D Tiles tile
  pop-in sets NaN motion for disocclusion reject. Picking un-jitters depth readback. Verify CSM + TAA
  compose (shadow edges need motion-correct reprojection). WebGL backend TAA via MRT + GLSL accumulate.
  Visual verification pass." Register §7 P2 (FI §C.7+§C.2+§C.5), blocker: Slices 2b+3.
- These are the correctness INTERACTIONS between TAA and the rest of the engine — each a small, separable
  concern; together they close the TAA parity story.

### Architecture today (verified at HEAD `c643516c04`) — dossier anchors

- **Pick depth-readback un-jittering:** the scene is rendered with the JITTERED projection (the §1 loop),
  so the depth the pick path reads is jitter-offset. `pickPosition` depth consumers must UN-jitter (offset
  the readback by the current jitter, or read from an un-jittered depth). Coordinate with the `pick`
  cluster (G1) — the pickPosition-convergence anchor (`NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION`) is
  a STANDING RED; do NOT open pick-depth-un-jitter work until that is diagnosed (changing pick depth
  economics under an undiagnosed pick red destroys the repro).
- **3D Tiles pop-in MV NaN reject:** when a tile pops in (no prior-frame representation), its velocity is
  undefined; the design sets NaN motion so the resolve's disocclusion path (`reprojectUV` out-of-bounds /
  motion-magnitude guards) rejects the history. The TAA resolve already rejects on `w<=0` / out-of-bounds
  / motion>0.1 — Slice 4 adds the explicit NaN-on-pop-in producer side.
- **CSM + TAA shadow-edge:** `Shaders/WebGPU/Shadow/ShadowMap.wgsl` / `ShadowReceiveCSM.wgsl` — shadow
  edges are high-contrast and jitter+reproject must not shimmer them; the IGN jitter already matches
  `csm_stochasticDither` (Batch 192/195, `WebGPUTAAEffect.ignJitter` comment) — Slice 4 VERIFIES the
  compose (a verification pass, not new math) that shadow edges reproject motion-correctly.
- **WebGL parity path:** the WebGL backend has no TAA (this is a WebGPU-only effect today). Slice 4's
  "WebGL TAA via MRT + GLSL accumulate" is the largest sub-item — a full WebGL TAA implementation (MRT
  motion + GLSL accumulate). This is L on its own and may be out of P2 scope for C11; flag it.

### Implementation walkthrough (dossier-level — each sub-item is separable)

**Step 0 — premise + sequencing.** Slice 4 depends on Slices 2b+3 (needs the model MRT velocity +
YCoCg). Confirm those landed. For the pick sub-item, confirm the pick cluster's pickPosition red is
DIAGNOSED (G1 A1) before touching pick depth.

1. **NaN-on-pop-in (3D Tiles):** producer-side — set NaN velocity for newly-visible tile primitives (no
   prior frame); the resolve already rejects NaN/out-of-bounds. Small, self-contained. Verify a tile
   streaming in does not ghost.
2. **Pick depth un-jitter:** offset the pick depth readback by the current jitter (or read un-jittered
   depth). GATED on the pick cluster's pickPosition diagnosis — coordinate, do not collide.
3. **CSM+TAA verification pass:** a probe that moves the camera over a hard shadow edge under TAA and
   asserts no shimmer/ghost. Verification, not new code (unless it surfaces a real bug).
4. **WebGL TAA parity (large, flag):** MRT motion + GLSL accumulate for the WebGL backend. This is the
   only NON-small sub-item; scope it separately and confirm with the orchestrator whether it is in C11 P2
   scope or a deferred parity item.

### Traps

1. **Pick sub-item is gated on the standing pickPosition red** (G1) — do not open it blind.
2. **WebGL TAA is a full backend implementation**, not a small interaction fix — do not let it inflate the
   Slice 4 estimate; separate it.
3. **CSM+TAA is verification-first** — if the compose is already correct (the shared IGN noise suggests
   it may be), the deliverable is a passing probe, not a change.
4. **Depends on 2b+3** — NaN-reject and un-jitter assume model velocity + YCoCg exist; do not open ahead.

### Verification recipe

- 3D-Tiles streaming scene under TAA: tile pop-in does not ghost (new probe or extend
  `probe-taa-disocclusion.mjs`).
- Pick-under-TAA: `pickPosition` returns the same depth with TAA on/off (GATED on G1's pickPosition
  diagnosis).
- CSM+TAA: camera over a shadow edge, no shimmer (`capture-and-diff` + read PNGs).
- WebGL TAA (if in scope): WebGL vs WebGPU TAA parity band.

### Model tier + effort

**opus-or-sol** for the small interactions (NaN-reject, CSM verify); **fable** for the pick-depth
un-jitter IF the pick red complicates it. **L** overall, but MOSTLY because of the WebGL-parity sub-item —
the correctness interactions alone are S–M each. Recommend splitting: land NaN-reject + CSM-verify as
small C11 slices; defer WebGL-TAA-parity as its own item (flag).

---

## OPEN QUESTIONS FOR THE ORCHESTRATOR

The RTE arc is a correctness spine, not a perf wave, and it has three sequencing dependencies the
orchestrator must resolve before opening the W5 items. **(1) `C9-24` is a hard gate for `C9-25`/`C9-26`
and the whole RTE conversion — it must land before any velocity-shader or visibility-feed conversion,
because it produces the numeric oracle those conversions are accepted against; do not parallelize the
inventory with the conversions.** **(2) `C9-25`'s previous-frame RTE contract needs NET-NEW plumbing —
there is no `previousEncodedCameraHigh/Low` in the tree; the recommended fix adds
`previousViewProjectionRelativeToEye` + a `cameraDelta` vec3 to the velocity paths' camera UBs (reusing the
in-tree TAA-resolve trick), but the model family additionally needs a per-primitive
`previousMvpRelativeToEye`; `C9-24` must bless the exact contract, so its scheme decision is on the
critical path.** **(3) Cross-cluster couplings:** `C9-29` (multi-frustum TAA depth) consumes the
per-frustum depth PACK owned by attachment-topology (C9-10 / S7-2, currently DEFERRED-BLOCKED) — `C9-29`'s
TAA-side identity work can proceed but must flag the depth-pack dependency rather than build it;
`TAA-DESIGN Slice 2b` (model MRT velocity output) needs the second color attachment that IS the
attachment-topology MRT/normal-G-buffer topology (C9-10 / Phase-8a), so it must sequence after that
topology can carry a velocity slot AND after `C9-25` converts the model prev leg (else it ships
far-camera-drifting velocity); `TAA-DESIGN Slice 4`'s pick-depth-un-jitter is gated on the `pick` cluster's
standing `NEW-WEBGPU-PICKPOSITION-CONVERGENCE-REGRESSION` diagnosis (G1). **Gate E (correctness, not perf)
gates un-containing auto GPU cull on BOTH `C9-26` AND `C9-29` landing — no perf argument may pull cull
restoration ahead of it.** **Maintainer decisions requested:** (a) confirm the `cameraDelta` vs
`previousEncodedCameraHigh/Low` scheme for `C9-25` (the guide recommends delta); (b) confirm whether
`C9-29` resolves per-frustum (N passes) or via a per-frustum matrix array (the guide recommends per-frustum
passes given B693's N=1 default); (c) rule whether the WebGL-TAA-parity sub-item of `TAA-DESIGN Slice 4` is
in C11 P2 scope or a deferred parity item (the guide recommends deferring it — it is a full backend
implementation, not a small interaction fix); (d) confirm whether a WebGPU particle renderer is in scope so
`TAA-DESIGN Slice 3`'s particle `previousPositionWC` can be scheduled (currently BLOCKED — no WebGPU
particle velocity path exists). No premise in this cluster is UNVERIFIED — all seven items' code anchors
were confirmed at HEAD `c643516c04`; the only judgment items are the two scheme decisions above, which
`C9-24` is designed to settle.
