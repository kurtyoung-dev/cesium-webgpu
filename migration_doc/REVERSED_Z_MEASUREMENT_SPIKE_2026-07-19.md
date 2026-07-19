# C11-GT-01 — Reversed-Z Measurement Spike

**Date:** 2026-07-19
**Item:** `C11-GT-01` / `C10-13-REVERSED-Z-EARLYZ-SPIKE`
**HEAD:** Batch 716 (`3e552026d6`), tree clean
**Mode:** MEASUREMENT-ONLY, static analysis. No build, no browser, no writes.

## VERDICT: **STAY-LOG-DEPTH**

The WebGPU path remains on logarithmic depth. The log-depth pick fleet (`C11-IC-01`) is **cleared to keep growing** — it is not a trap that a later migration must rip out; it is the load-bearing mechanism that makes single-texture WebGPU `pickPosition` reconstruction possible at all.

Per the reconciliation contract in `DEFERRED_WORK.md:5425-5429`, this NO-GO must be recorded in three sinks: the `NEW-WEBGPU-PICK-FLEET-LOG-DEPTH` ledger row, the FAR-707 brief, and `DEFERRED_WORK.md`.

---

## 1. The decisive finding

**Reversed-Z buys precision only on a float depth buffer. This fork does not have one, and does not ask for one.**

Reversed-Z works by pairing the 1/z projection (dense near the near plane) with float32's mantissa density near 0.0, so the two distributions cancel. On a **fixed-point** buffer the code levels are uniformly spaced, and reversing simply mirrors a uniform ladder — the resolvable Δz is *identical* to the forward case. The gain is mathematically zero.

The scene depth attachment is:

```
packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts:370
  private _depthFormat: GPUTextureFormat = "depth24plus-stencil8";
```

`grep -n "_depthFormat *="` over that file returns **zero** hits. The field is never reassigned; it is a compile-time constant exposed read-only at `:2387-2389`. The scene framebuffer hardcodes the same literal independently (`WebGPUSceneFramebuffer.ts:330,341`), as does GlobeDepth (`WebGPUGlobeDepth.ts:300,310`) and ~60 pipeline sites across 47 renderer files.

`depth32float-stencil8` — the format a migration would require — is an **optional** WebGPU feature and is **absent from `DESIRED_FEATURES`** (`WebGPUFeatureFlags.ts:40-66`, which lists only `float32-filterable`, `clip-distances`, `dual-source-blending`, `rg11b10ufloat-renderable`, `timestamp-query`, `shader-f16`, `indirect-first-instance`, `subgroups`, `bgra8unorm-storage`, and three texture-compression formats). It appears in the codebase only as a defensive has-stencil string test at `WebGPUModelPipelineCache.ts:1521,1612`.

**Worse: the current format's backing is not observable.** `depth24plus-stencil8` maps to `D24_UNORM_S8` on D3D12 (reversed-Z gain = **0×**) and to `D32_SFLOAT_S8` on Vulkan (gain ≈ **10×**). WebGPU exposes no query. Migrating today ships a precision result that is driver-determined and untestable — a coin flip.

---

## 2. Depth infrastructure (measured)

| Surface | Count | Anchor |
|---|---|---|
| Scene depth attachment | `depth24plus-stencil8` | `WebGPUContext.ts:370` (never assigned) |
| Pick depth attachment | `depth24plus-stencil8` | `WebGPUPickFramebuffer.ts:417`, docstring `:6` |
| Pick *readable* side-target | `depth32float`, lazy, not populated by ordinary picks | `WebGPUPickFramebuffer.ts:1185-1196` |
| What `pickPosition` reads | packed `rgba8unorm` (≤24 bits of real info) | `WebGPUGlobeDepth.ts:309,319,328,516,570` |
| WGSL files writing `@builtin(frag_depth)` | **82** | `grep -rl` over `Shaders/WebGPU/**/*.wgsl` |
| `csm_writeLogDepth` call sites | **182** | ditto |
| Renderer files referencing `frag_depth` | **28** | `Renderer/WebGPU/**` |
| Files carrying `depthCompare` | **47** (165 occurrences) | ditto |
| `depthCompare` histogram | 74 `less-equal`, 19 `always`, 2 `greater`, 1 `less`, 1 `equal` | ditto |
| `depthClearValue` histogram | 14× literal `1.0` + 3 variable-driven | ditto |

The encode primitive is a single function every one of the 182 sites routes through:

```wgsl
// Shaders/WebGPU/Globe/GlobeTerrain.wgsl:269-270
fn csm_writeLogDepth(depthFromNearPlusOne: f32, oneOverLog2FarDepthFromNearPlusOne: f32) -> f32 {
  return log2(depthFromNearPlusOne) * oneOverLog2FarDepthFromNearPlusOne;
}
```

> **Stale-figure correction.** `DEFERRED_WORK.md:5425-5426` cites a "71-file color surface" for `C10-GT-REVERSED-Z-SLICE-B`. The measured surface is **82 WGSL + 28 Renderer files**. Record the correction.

The only two `depthCompare: "greater"` sites (`WebGPUPrimitiveCommands.ts:3190`, `:4630`) are intentional **depth-FAIL** variants, not a reversed-Z beachhead — under migration their meaning inverts, making them the highest-risk silent-flip sites in the whole surface.

---

## 3. Multi-frustum: log depth *replaces* it, and it adds nothing to reversed-Z

The split lives in `Scene/View.js:523-579` (called from `:424`). The ratio is **log-depth-dependent**:

```js
// View.js:526-528
const farToNearRatio = useLogDepth
  ? scene.logarithmicDepthFarToNearRatio   // 1e9  — Scene.js:616
  : scene.farToNearRatio;                  // 1000 — Scene.js:603
```
```js
// View.js:553
numFrustums = Math.ceil(Math.log(far / near) / Math.log(farToNearRatio));
// View.js:569-570
curNear = Math.max(near, Math.pow(farToNearRatio, m) * near);
curFar  = Math.min(far, farToNearRatio * curNear);
```

With near = 0.1 m, far = 1e9 m:

- **log path** (ratio 1e9): `ceil(ln(1e10)/ln(1e9))` = **2 frustums** → `[0.1, 1e8]`, `[1e8, 1e9]`. Every distance in the decision table falls in slice 0.
- **hyperbolic path** (ratio 1000): `ceil(ln(1e10)/ln(1000))` = **4 frustums** → `[0.1,100]`, `[100,1e5]`, `[1e5,1e8]`, `[1e8,1e9]`.

At near = 1.0 the log path collapses to exactly **1** frustum. So log depth is doing essentially all the precision work by itself; the split is a residual.

WebGPU goes further and uses a **full-frustum** (not per-slice) encode — `PickDepth.js:198-201`: *"every WebGPU depth producer encodes against the full camera frustum since Batch 251."* Per-frustum scalars are packed into reserved `.w` lanes (floats 51/55/59) by `WebGPULogDepth.ts:124-146`, factor = `1/log2(far − near + 1)` (`:140-141`).

**And multi-frustum contributes exactly zero to reversed-Z float.** Reversed-Z NDC is `d ≈ n/z`, so `dd/dz = −n/z²` and `Δz = ε_rel·z` — the slice near/far **cancel**. The "reversed-Z + multi-frustum" compounding the spike was asked to evaluate does not exist.

---

## 4. Pick-fleet coupling — all-or-nothing, ~24 producers

The shared pick FBO owns **one** depth attachment. `WebGPULogDepth.ts:88-93` states the invariant plainly: the fleet must be uniformly hyperbolic **or** uniformly log, because *"a log producer at ~0.4 over-occludes a hyperbolic producer at ~0.999 over the entire disk."* `WebGPUSceneRendererPickPass.ts:52-82` records the same as INV-1/INV-2, and documents the Run-1 (2026-07-16) failure where a log depth-plane over a hyperbolic fleet over-occluded every pick cohort across the globe disk.

Master switch: `WebGPUContext.ts:616` — `public _pickLogDepthWriteEnabled: boolean = true;` (flipped TRUE by C10-11, Batch 709). Gate: `WebGPULogDepth.ts:105-110`. Depth-plane gate: `WebGPUSceneRendererPickPass.ts:82` `PICK_DEPTH_PLANE_ENABLED = true`.

Fleet (per `DEFERRED_WORK.md` ~:5400-5420, ~24 entries / ~20 files): globe `GlobeTerrain.wgsl:3081`; model ×3 `ModelPBRComplete.wgsl:{3828,3758,3983}`; ellipsoid `WebGPUEllipsoidPrimitiveRenderer.ts:281`; splat `WebGPUGaussianSplatRenderer.ts:393` (+ JS module swap `:710-734`); buffer ×3; billboard `BillboardCollectionPick.wgsl:246`; point `PointPrimitivePick.wgsl:201`; polyline `PolylineCollectionPick.wgsl:190`; primitive ×6; ground/vector-tile via `WebGPUDerivedCommand`; voxel ×2; compute-instance `ComputeInstanceRender.wgsl:215`.

Each renderer additionally mirrors the master switch into its own pipeline cache (`WebGPUModelPipelineCache.ts:1886,2150,3116-3142`; `WebGPUGlobeSurfaceRenderer.ts:327,1112-1114`; `WebGPUPrimitiveCommands.ts:338,2888,2918,5088-5090`; `WebGPUGaussianSplatRenderer.ts:97,1130-1137,1259`; the three Buffer\* renderers; `WebGPUModelRenderer.ts:4208,4310`). **All must flip in one coordinated change or the pick FBO is incoherent.**

> **Doc drift found.** `WebGPULogDepth.ts:94-103` still says the pick master switch "defaults FALSE and stays there until EVERY native pick producer writes log frag_depth." That is stale — `WebGPUContext.ts:616` defaults **TRUE** since C10-11. Worth a one-line correction in a future doc pass.

---

## 5. Precision math

### Assumptions

| Symbol | Value | Source |
|---|---|---|
| Depth format | `depth24plus-stencil8` | `WebGPUContext.ts:370` |
| q — 24-bit UNORM quantum | 2⁻²⁴ = 5.96046e-8 | D24 backing |
| ε_rel — float32 ULP (relative, worst case in a binade) | 2⁻²³ = 1.19209e-7 | IEEE-754 binary32 |
| n — camera near | 0.1 m | back-derived (below) |
| f — camera far | 1e9 m | back-derived (below) |
| log / hyp ratio | 1e9 / 1000 | `Scene.js:616` / `:603` |
| frustum count | 2 (log) / 4 (hyp) | `View.js:553,569-570` |

Camera default near is 1.0 (`Core/PerspectiveFrustum.js:70`); the operative (0.1, 1e9) pair is back-derived from the fork's own recorded figures and used because it reproduces them exactly.

### Formulas

- **Log** (full-frustum, `GlobeTerrain.wgsl:269-270`): `d = log2(z−n+1)/log2(f−n+1)` ⟹ **`Δz = q·(z−n+1)·ln(f−n+1)`**
- **Hyperbolic, or reversed-Z on FIXED-POINT**: `d = (f/(f−n))(1−n/z)` ⟹ **`Δz = q·z²·(f−n)/(f·n)`**. Reversed-Z on UNORM mirrors a uniform ladder, so Δz is identical to forward.
- **Reversed-Z on FLOAT32**: `d ≈ n/z`, `Δd = ε_rel·d` ⟹ **`Δz = ε_rel·z`** — independent of n, f, and of any frustum split.

### Validation against numbers the fork already recorded

`WebGPULogDepth.ts:12-15` records, at a 350 km surface: hyperbolic **~73 km/quantum**, log **~0.42 m/quantum**.

- Hyperbolic, z = 3.5e5: `5.96046e-8 × 1.225e11 / 0.1` = **73,015 m = 73.0 km** ✓
- Log, z = 3.5e5: `5.96046e-8 × 3.5e5 × ln(1e9)=20.7233` = **0.432 m** ✓

Both reproduce to three significant figures, which is what *fixes* (n = 0.1, f = 1e9) as the fork's operative assumption set rather than a guess.

### Resolvable Δz in world metres

| z | (a) **CURRENT** log + real split, depth24plus | (b) reversed-Z, single frustum, **actual depth24plus** | (b′) reversed-Z, single frustum, depth32float *(not available)* | (c) reversed-Z + 4-slice split, **actual depth24plus** | (c′) reversed-Z + split, depth32float |
|---|---|---|---|---|---|
| 1 m | 2.35 µm | 0.60 µm | **0.12 µm** | 0.60 µm | **0.12 µm** |
| 100 m | 0.125 mm | 5.96 mm | **11.9 µm** | 5.95 µm – 5.95 mm ‡ | **11.9 µm** |
| 1 km | 1.24 mm | 0.60 m | **0.12 mm** | 0.60 mm | **0.12 mm** |
| 100 km | 12.4 cm | 5.96 km | **1.19 cm** | 5.95 mm – 5.95 m ‡ | **1.19 cm** |
| 10,000 km | 12.4 m | 59,600 km ✗ | **1.19 m** | 59.5 m | **1.19 m** |

✗ exceeds the far plane — depth fully saturated, unresolvable.
‡ slice-boundary range: low = fragment entering a slice at its near edge, high = fragment at the previous slice's far edge. Relative precision degrades **1000× across every slice** (Δz/z runs q → 999q), which is exactly the seam z-fighting log depth was adopted to eliminate.

### Reading the table

1. **(b) is the honest apples-to-apples migration result on today's format, and it is catastrophic** — 5.96 km at 100 km against the current 12.4 cm, a ~48,000× regression. Reversed-Z on fixed-point buys nothing; it merely discards the log encode.
2. **(b′) and (c′) are unreachable** without first changing the depth format and securing an optional device feature.
3. **(c) beats (a) at short range but loses at planetary range** (59.5 m vs 12.4 m at 10,000 km) and reintroduces the 1000× intra-slice cliff.
4. **(b′) = (c′) exactly.** No compounding win from multi-frustum.
5. **Best case is ~10.4×, not orders of magnitude.** For z ≫ 1: `Δz_log/Δz_revZfloat = q·ln(f−n+1)/ε_rel = (5.96046e-8 × 20.7233)/1.19209e-7` = **10.4×** (20.7× using the optimistic 2⁻²⁴ ULP).
6. **The current baseline is not the constraint.** 12.4 cm at 100 km and 12.4 m at 10,000 km sit below the geometric scale of anything rendered at those distances. No standing campaign red is attributed to scene-depth quantisation.

---

## 6. Blast radius

Migration is a ~110-file, all-or-nothing change. Summary by phase (full `file:line` enumeration is in the spike's structured record):

1. **Depth format** — `WebGPUContext.ts:370`; add `depth32float-stencil8` to `WebGPUFeatureFlags.ts:40-66` **plus a new no-feature fallback** (depth32float has no stencil, and stencil is load-bearing for classification / invert-classification / OIT); `WebGPUSceneFramebuffer.ts:330,341`; `WebGPUGlobeDepth.ts:300,310`; `WebGPUPickFramebuffer.ts:417`; ~60 pipeline sites across 47 files; and the silent auto-upgrade logic at `WebGPUPipelineDescriptorBuilder.ts:134,171,178-179` / `WebGPURenderPipelineCache.ts:601,611-616` which would otherwise defeat the migration.
2. **Direction — compares** — 74 `less-equal` → `greater-equal`; `WebGPUEdgeVisibilityEmitter.ts:1181`; and the two meaning-inverting depth-FAIL sites `WebGPUPrimitiveCommands.ts:3190,4630`. `RenderStateToPipelineVariant.ts` must flip WebGPU **without** flipping WebGL.
3. **Direction — clears** — 14 literal `1.0` → `0.0` + 3 variable sites. **Coupling hazard:** `QUEUE_2026-07-15_CAMPAIGN9.md:131` records that C9-07's demand-open canvas depth logic is load-bearing against *"WebGPU lazy-zero 0.0 vs historical 1.0"*. Under reversed-Z the lazy-zero value becomes the **correct** clear, silently masking the bug that logic guards.
4. **frag_depth removal** — all 82 WGSL files / 182 call sites; delete `csm_writeLogDepth`, `csm_vertexLogDepth`, `csm_updatePositionDepth` and the varying from ~82 VS/FS pairs. The `LOG_DEPTH` `ShaderDefine` bit must be **retired in place** with a deprecation marker — per CLAUDE.md the registry is add-only and never renumbered.
5. **Uniform plumbing** — the whole `WebGPULogDepth.ts` module; `WebGPUContext.ts:616`, `:1744`; `GraphicsContext.ts:999`; `WebGPUSceneRendererFrustumState.ts`; every cached module key in `WebGPUShaderModuleCache.ts` shifts.
6. **Pick fleet** — the ~24 producers and their per-renderer cache mirrors, in one coordinated change.
7. **CPU-side reconstruction (hardest, least obvious)** — `SceneTransforms.js:452-456`; `Picking.js:778-791` and the `:801` sentinel test; `PickDepth.js:198-201`; `Scene.js:141,310,603,616,2793-2797`; `View.js:526-528` (the split reverts 2 → 4 frustums, moving frustum-count parity oracles campaign-wide).
8. **Depth consumers** — 28 post-process/effect WGSL files; `DepthResolveMSAA.wgsl:5,53` (its min/near-wins resolve inverts); CSM (`WebGPUCSMRenderer.ts:460,965` — cascade convention is independent and must **not** be flipped by accident); TAA/motion vectors; classification blit; and `WebGPUHiZOcclusionDispatcher.ts:412`, where a Hi-Z pyramid built with `max()` must become `min()` — getting this backwards silently over-culls.

**The one genuine upside** is not precision: removing all 82 `frag_depth` writes restores early-Z / hierarchical-Z rejection, which writing `frag_depth` disables on essentially all hardware. That is a real performance argument and the honest reason the item was ever called an "EARLY-Z spike." It should be pursued, if at all, **as a separate perf item with its own measured lane** — not bundled with a precision claim it does not support.

---

## 7. Interactions

**`C11-163` CELESTIAL-WATER-REFLECTION — NOT depth-coupled. Confirmed.**
`CELESTIAL_WATER_REFLECTION_RESEARCH.md:24`: *"Cheap path does NOT touch depth ⇒ NOT reversed-Z-coupled. A pure specular-highlight moonglade/glint..."*; restated at `:414`. Echoed in `QUEUE_2026-07-18_CAMPAIGN11.md:413`. Colour-only specular. **Safe to schedule independently of this verdict.**

**`C11-158` ENHANCED-OCEAN toggle — does not change depth direction; the ocean shader is on the migration surface only as one of the 82 writers.**
`Ocean/OceanSurface.wgsl:129` declares `@builtin(frag_depth)` guarded by `//>>ifdef LOG_DEPTH` (varying set `:120`, position fixup `:121`) — i.e. it participates in the log encode exactly like every other producer, and a migration would *remove* that write rather than reinterpret it. The `ENHANCED_OCEAN` define **does not yet exist** (grep over `packages/engine/Source` returns zero hits); `C11-158` is blocked on `C11-149` define-width per `QUEUE_2026-07-18_CAMPAIGN11.md:408`. It is a colour/material toggle. **No depth-direction coupling.**

**`C11-01` pickPosition red — UNRELATED to depth precision.** See §8.

---

## 8. `C11-01` — negative result

The standing `scene.pickPosition` red is an **async-readback liveness / scene-not-rendering** failure, not a depth-precision symptom. Reversed-Z would not fix it; migrating would make the surrounding code harder.

1. **The failure mode is categorically wrong for a precision bug.** The red is recorded as *"never converges"* (`CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md:382-387`). Quantisation yields a **converged but inaccurate** `Cartesian3` — it cannot yield non-convergence. Non-convergence means `undefined` was returned, which happens only at `Picking.js:789/790/802/827`, none a precision path.
2. **The WebGPU branch is a one-frame-stale async cache with hard staleness gates.** `Picking.js:778` enters `!context.supportsSynchronousReadback`; its comment at `:773-777` and `PickDepth.js:189-193` both state the first query returns `undefined` and *arms* the readback, converging 1-2 frames later. Two gates reject the cache: coordinate drift > `ASYNC_DEPTH_COORD_TOLERANCE = 4` px (`PickDepth.js:23`, checked `:215-218`) and staleness > `ASYNC_DEPTH_MAX_STALE_FRAMES = 4` (`PickDepth.js:30`, checked `:222-225`). Under `requestRenderMode` — the fork's default, and the documented cause of prior probe artifacts — no further frames render, `_updateCount` never advances, the readback never re-arms, and `getDepth` returns `undefined` **forever**. That is literally "never converges."
3. **The co-reported symptom proves no depth was ever written there.** The same row pairs the pick failure with a *"bare-globe black-interior bimodal repro (center avgRGB 2,2,2, `tilesLoaded=true`, zero errors)"*. Nothing rasterised ⟹ depth retains the clear value 1.0 ⟹ `Picking.js:801` (`depthValue <= 0.0 || depthValue >= 1.0`) rejects and returns `undefined` at `:803`. Upstream of any encoding. Consistently, the queue's own remediation is an **environment ruling**, not a depth change (`QUEUE_2026-07-18_CAMPAIGN11.md:949`).
4. **Reversed-Z is direction-agnostic w.r.t. all of it.** The cache, the 4-px/4-frame gates, `_updateCount`, and the "nothing rendered" condition are unaffected. Reversed-Z only flips which sentinel means empty (`>= 1.0` becomes `<= 0.0`); the non-convergence behaviour is bit-for-bit identical.
5. **Migration would actively regress this area.** `Picking.js:778-791` refuses to reconstruct unless `frameState.useLogDepth && context.pickDepthFullFrustumLogEncode`, with the rationale at `:784-788` that per-slice hyperbolic depth has *"NO consistent single-texture reconstruction — keep the SAFE undefined → ray-pick fallback rather than a garbage position."* The full-frustum log encode is the **only** reason single-texture WebGPU `pickPosition` works. Removing it without a reversed-Z replacement takes `pickPosition` from "converges in 1-2 frames" to "permanently unavailable."
6. **The one real precision symptom is already solved.** `WebGPULogDepth.ts:12-15` attributes banded classification UVs and imprecise far-picking to the 24-bit hyperbolic 73 km/quantum, and records log depth's redistribution to ~0.42 m/quantum. Closed. `C11-01` is a different animal.

**Consequence for scheduling:** `C11-01` stays a W1 diagnosis-only item (`QUEUE_2026-07-18_CAMPAIGN11.md:678`). This spike contributes a **negative result** — `C11-01` must not be cited as evidence for reversed-Z GO.

---

## 9. Consequences

**Unblocked:**
- `C11-IC-01` pick-fleet log depth is **PERMANENT**, per the `DEFERRED_WORK.md:5425-5429` contract. Keep converting producers to log `frag_depth`.
- `C11-131` OCEAN_PLANAR_REFLECT ocean depth — proceed on log depth.
- `C11-45` / `C11-46` RGBA8 pack optimizers — proceed on log depth.
- `C11-163`, `C11-158` — never coupled; unaffected.

**Closed / redirected:**
- `C11-GT-02` (reversed-Z slice) → **NO-GO**, remains gated. Do not schedule.
- `C11-48` stencil-less-depth sub-slice (G3 Q3c) — the "may be throwaway if `C11-GT-02` activates" caveat at `QUEUE_2026-07-18_CAMPAIGN11.md:~836` is **resolved**: `C11-GT-02` will not activate, so the D24S8 surface is stable and the sub-slice is **not** throwaway. Decide it on its own merits.
- The 82-file `frag_depth` surface is **not** a liability to be minimised. It is the mechanism.

**Re-open triggers** (any one warrants a fresh spike, none is currently met):
1. `depth32float-stencil8` becomes baseline-available across target adapters **and** the fork adopts it for an unrelated reason.
2. A measured GPU-time lane attributes ≥10% frame cost specifically to early-Z loss from `frag_depth` writes — in which case pursue **early-Z restoration as a perf item**, decoupled from any precision claim.
3. A reproducible artifact is attributed to scene-depth quantisation at the log-depth resolutions in §5 (12.4 cm @ 100 km, 12.4 m @ 10,000 km). None exists today.

**Doc corrections to fold into a future pass:**
- `DEFERRED_WORK.md:5425-5426` — "71-file color surface" is stale; measured 82 WGSL + 28 Renderer.
- `WebGPULogDepth.ts:94-103` — says the pick master switch defaults FALSE; `WebGPUContext.ts:616` defaults TRUE since C10-11.

---

## 10. Method / limits

Static only: no build, no browser, no dev server, no writes. Every claim above carries a `file:line` read in this session. Precision formulas were derived independently and then validated against two figures the fork had already recorded (`WebGPULogDepth.ts:12-15`), both reproducing to three significant figures.

**UNVERIFIED (explicitly):**
- The 24-bit UNORM backing of `depth24plus-stencil8` is a platform-mapping inference (D3D12 D24S8 / Vulkan D32S8). It is **not** API-observable — which is itself part of the argument, not a gap in it.
- The `requestRenderMode` mechanism for `C11-01` (§8.2) is code-supported inference; `probe-pickposition-webgpu.mjs` was not run, as browser use is out of scope for a measurement-only static spike.
- `ε_rel = 2⁻²³` is the worst-case ULP within a binade. Best case is 2⁻²⁴, which would double columns (b′)/(c′) in the fork's favour and raise the best-case ratio to 20.7×. The conservative value is used throughout; the verdict does not turn on the difference.