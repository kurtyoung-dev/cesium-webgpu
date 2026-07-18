# WebGPU OIT Default-Flip Evidence Package (2026-07-18)

**Task:** `M-OIT-COVERAGE-AND-FLIP-EVIDENCE` (maintainer-directed, Batch 700).
**Verdict:** **NO-GO** on defaulting WebGPU MRT-OIT on for WebGL default-parity — the
gate is **not** the blocker; the WebGPU MRT-OIT path is **architecturally unreachable for
standard translucent geometry** at HEAD (Batch 699, `5b98ab9698`). Flipping the containment
flag is a **visual no-op** for standard transparency. This slice **flips nothing** — the
maintainer ratifies.

Evidence artifacts (all reproduced live, Edge/WebGPU, offline deterministic boot):
- Probe: `Tools/visual-regression/probe-oit-transparency.mjs` (oracles a–d + c-splat, **GREEN**).
- Report JSON: `Tools/visual-regression/output/oit-transparency-report.json`.
- PNGs read: `oit-webgl-on.png`, `oit-webgl-off.png`, `oit-webgpu-default.png`, `oit-webgpu-on.png`.
- Sandcastle: `packages/sandcastle/gallery/order-independent-translucency/`.

---

## 0. The scene

Three mutually-intersecting translucent ellipsoids (red/green/blue, α≈0.5) + a translucent
yellow polygon slicing through them, viewed obliquely. At the interpenetration lines a
per-object back-to-front sort is provably wrong; OIT resolves those fragments per-fragment, so
OIT-on and sorted-alpha visibly differ. This is the maintainer-specified reproduction and the
`FAR-003` re-enable acceptance case ("before/after translucent-intersection visual probe",
QUEUE_2026-07-15_CAMPAIGN9.md §3.3 item 1).

---

## 1. (i) WHY the FAR-003 OIT containment exists — and whether each reason is still live

**Ratification.** WebGPU MRT-OIT default-off was **RATIFIED** on 2026-07-16 as `FAR-003`
containment (QUEUE_2026-07-15_CAMPAIGN9.md §3.3 item 1), after the Sol audit (P0-6) flagged the
default-off state as a shipped-behavior reversal vs WebGL's default-on OIT. The public
`scene.orderIndependentTranslucency` option stays a *request*; the renderer-owned
`_webgpuOITEnabled` gate (default `false`) controls whether the contained MRT implementation may
execute. `CesiumDebug.webgpuOIT(t/f)` reads/flips it with requested-vs-active semantics. Owning
row: `FAR-003` / `T7` (Wave 6). Re-enable acceptance is *this probe*.

**Recorded containment/adjacency reasons and their status at HEAD:**

| Reason | Source | Status at HEAD |
| --- | --- | --- |
| Composite pipeline pinned to `rgba8unorm`, failed format validation every frame | `NEW-OIT-COMPOSITE-FORMAT`, Batch 222 | **FIXED** — `executeComposite` rebuilds on target-format mismatch; verified 0 validation errors this run. |
| OIT accumulation ignored per-index `bindGroupResolvers` (stale per-slice camera UB) | WEBGPU_DEBUGGING_LOG:1264 | **FIXED** (defensive) — `executeOITCommand` mirrors `WebGPUDrawCommand.execute()`. No OIT-enabled translucent collection exists to exercise it. |
| Deferred-splat canvas resume draws under the later PP blit → invisible splats under OIT+splats | `NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME`, DEFERRED_WORK §C9-07 latent | **LIVE** (contained-off ⇒ no default impact). Needs a splats+OIT visual probe before redirect to `_resumeScenePass`. |
| MSAA×OIT resolve ordering: a later frustum's MSAA scene-color resolve overwrites the mid-frame OIT composite | `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`, DEFERRED_WORK (filed C10-03) | **LIVE** (pre-existing FAR-003 family; contained-off ⇒ no default impact). Fix: composite into a dedicated non-MSAA accum target, or defer composite to post-frustum. |

**The excavation's more fundamental finding (supersedes the reasons above for flip purposes):**
Even with every adjacency fixed, flipping the gate would **not** restore WebGL parity, because the
WebGPU MRT-OIT accumulation path is **not wired to standard translucent primitives at all** (§2).

---

## 2. THE HEADLINE FINDING — WebGPU MRT-OIT is unreachable for standard translucency

`executeTranslucentPass` (`WebGPUSceneRendererTranslucentPass.ts`) enters the MRT-OIT
accumulation path only when `hasOITPipelines` is true, which requires a **`Pass.TRANSLUCENT`**
command carrying `_shaderCode` (auto-built into an `_oitPipeline`) or a pre-built `_oitPipeline`.

Exhaustive grep of `packages/engine/Source`: the **only** producers of `_shaderCode` on a WebGPU
draw command are:
- `WebGPUGaussianSplatRenderer.ts:1506` — `cmd._shaderCode = SPLAT_WGSL` → **`Pass.GAUSSIAN_SPLATS`**.
- `WebGPUGlobeSurfaceShaders.ts:85` — `host._shaderCode = code` → the **opaque** globe (`Pass.GLOBE`).

Neither lands in `Pass.TRANSLUCENT`. **No primitive, model, or collection sets `_shaderCode`.**
Therefore the `Pass.TRANSLUCENT` bucket never contains a `_shaderCode`/`_oitPipeline` carrier,
`hasOITPipelines` is **always false**, and the accumulation path (incl. the Batch-697
`_ensureSceneColorResolved` composite line at ~L268) is **effectively dead code at HEAD** for
standard translucent geometry.

**Empirical confirmation (oracle c):** `CesiumDebug.webgpuOIT(true)` on the intersecting-primitive
scene reports `requested=true, capable=true, safetyGateEnabled=true, active=FALSE,
fallbackReason="inactive-or-resources-not-ready"`. OIT-on is **pixel-identical** to WebGPU-default
(mismatch 382 px @ maxΔ6 = the dither noise floor of 343 px @ maxΔ6). WebGPU translucency renders
like **WebGL-OIT-OFF**, not WebGL-OIT-ON:

| Compare | diff % @ intersections | reading |
| --- | --- | --- |
| WebGL OIT-on vs WebGL OIT-off (oracle a) | **9.80 %** | OIT genuinely active on WebGL |
| WebGPU default vs WebGL OIT-off (oracle b) | **0.69 %** | WebGPU ≈ WebGL sorted alpha |
| WebGPU OIT-*on* vs WebGL OIT-on (oracle c parity) | **10.33 %** | WebGPU stays at the OIT-*off* look even with the gate on |
| WebGPU OIT-on vs WebGPU default (no-op check) | **0 px** (beyond noise floor) | gate flip has no visual effect |

**Even the one `_shaderCode` carrier cannot reach the composite (oracle c-splat):** with a synthetic
Gaussian splat present and **both** `_webgpuOITEnabled` and `_splatOITDeferral` armed,
`_webgpuOITActiveThisFrame` **never became true** across 40 frames (0 device errors). Splats are
`Pass.GAUSSIAN_SPLATS`; they are folded into OIT accumulation only *after* `hasOITPipelines` is
derived from the (empty) `Pass.TRANSLUCENT` bucket, so with zero qualifying translucent commands the
deferred splats fall through to the inline seatbelt. The **Batch-697 `_ensureSceneColorResolved`
composite call has still never executed at HEAD** — it has no reachable caller.

**PNG readings (honest, incl. known WBOIT artifacts):**
- `oit-webgl-on.png` (OIT active): overlaps are **desaturated / washed** — the classic McGuire-Bavoil
  weighted-blended look. The deep-overlap center (all three shells + polygon) goes muddy gray-green
  because the weight function averages many layers and loses saturation. This is a *known property* of
  weighted-blended OIT (halo/desaturation at high depth-complexity), not a bug — described, not hidden.
- `oit-webgl-off.png` (sorted alpha): overlaps are **more saturated/vivid** (bright orange-yellow at
  red+green+polygon), but the interpenetration is resolved by whole-object order → wrong at the seams.
- `oit-webgpu-default.png` and `oit-webgpu-on.png`: **indistinguishable from each other** and match the
  saturated WebGL-OIT-*off* look — confirming WebGPU does sorted alpha regardless of the gate.

---

## 3. (ii) Correctness verdict — oracle (c)/(d)

- **No regression from a flip.** The gate flips cleanly (requested/capable/safetyGateEnabled true),
  with **0 uncaptured GPU errors, 0 validation errors, 0 device loss** across the whole on→off cycle
  (the 2 console lines the raw run first showed were benign `reason=destroyed` teardown from the
  probe's own viewer recreation — filtered; the real GPU gate is clean).
- **Containment restores (oracle d).** `webgpuOIT(false)` returns to the pre-toggle default within the
  renderer's intrinsic dither noise floor (restore 365 px @ maxΔ6 vs a no-toggle control floor of
  343 px @ maxΔ6). Byte-identity-modulo-dither holds. (Weak proof, because nothing engaged either way.)
- **No correctness benefit either.** Because the accumulation path never runs, a flip changes nothing.

---

## 4. (iii) Perf spot — OIT-on vs OIT-off, WebGPU, the translucency scene (2 reps)

Per-render CPU cost, back-to-back `scene.render()` (no rAF idle), 150 samples/measure, 2 reps,
same device, warmed:

| rep | OIT-off median (min) ms | OIT-on median (min) ms | onActive |
| --- | --- | --- | --- |
| 1 | 0.6 (0.4) | 0.5 (0.4) | false |
| 2 | 0.5 (0.3) | 0.4 (0.3) | false |

**Cost shape: NULL.** OIT-on is statistically identical to OIT-off (the small deltas are within
run-to-run noise and even favor "on", i.e. pure noise). There is **no MRT accumulation pass, no
composite pass, no extra render-target allocation** because `hasOITPipelines` stays false and the
path is never entered. Caveats: CPU-only wall-clock (no GPU timestamp), one machine (32 GB), small
fixed scene, request-render idle excluded by design.

---

## 5. (iv) Recommendation — NO-GO for parity-by-flip; the real work is wiring

**Do NOT default `_webgpuOITEnabled` on to chase WebGL parity.** It would be a visual no-op for
standard transparency (WebGPU stays at the OIT-*off* look; the ~10.3 % intersection gap vs WebGL-OIT-on
does not move) and would not achieve default-parity. The containment gate is *not* the blocker.

**The actual prerequisite** (a separate, multi-batch effort — ledgered as
`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING` in DEFERRED_WORK):
1. Make translucent primitive/model/collection commands that land in `Pass.TRANSLUCENT` carry an OIT
   pipeline variant — either populate `_shaderCode` with their WGSL (so the auto-build in
   `executeTranslucentPass` produces `_oitPipeline`) or pre-build `_oitPipeline` where the WGSL is
   generated. This is the McGuire-Bavoil dual-MRT injection (`WebGPUOIT.injectOITOutput`) applied to
   the real translucent producers, not just splats.
2. Close the two live FAR-003 adjacencies first or in tandem:
   `NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME` and `NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`.
3. Only after (1)+(2) does a gate flip meaningfully move parity; re-run this probe's oracle (c) and
   expect `active=true` + the parity delta to collapse toward the oracle (a) magnitude (i.e. WebGPU
   matches WebGL-OIT-*on*, not -off).

**Conditional alternative:** if the maintainer wants the *containment posture* documented as
"capability present, off by default, and known-narrow (splats-only, and even that unreached)", this
package is the record; no code changes are required to keep the status quo, which is already
correct and safe.

---

## 6. Standard-transparency regression net (oracle e) + a NEW pre-existing finding

The four existing translucency probes (the "standard transparencies still work" half). This slice adds
**zero engine code** (probe + Sandcastle demo + docs only), so none of these can regress *from this
slice*; the results characterize Batch-699 HEAD:

| Probe | Result | Note |
| --- | --- | --- |
| `probe-ellipsoidprim-translucent.mjs` | **PASS** | Standard translucent primitive, single-blend ratio 0.499 both backends. |
| `probe-globe-translucency.mjs` | **PASS** (3/3 legs) | off-default 0.50 %, translucent-space 3.35 %, translucent-terrain **0.46 %** — the DEBUGGING_GUIDE "standing 25.49 % FAIL" is **RESOLVED** (stale note; corrected). |
| `translucent-classification-debug.mjs` | **clean** (diagnostic) | 3 console events, exit 0, no fault. |
| `probe-custom-shader-translucency.mjs` | **RED** (deterministic) | **NEW pre-existing finding**, not caused by this slice. See below. |

**`NEW-WEBGPU-CUSTOMSHADER-TRANSLUCENCYMODE-ALPHA-UNDERAPPLIED`** (surfaced by the regression net,
2026-07-18): the native-WGSL `CustomShader` with `translucencyMode=TRANSLUCENT` + body
`(*material).alpha = 0.35` on the CesiumMilkTruck (authored OPAQUE) **routes to the blend pass**
(the truck becomes faintly see-through — PNGs read: `cs-trans-translucent.png` vs `cs-trans-inherit.png`)
but the customShader **alpha value is under-applied** — the model stays near-opaque (center blue
66.6 vs inherit 66.1; the gate needs +30). Deterministic across 2 runs (identical means). Independent
of M-OIT (no OIT involved; standard translucent model pass). Temporal note only: Batch 699
(`C10-02-TILES-STYLE-COMMAND-ECONOMICS`, "phantom translucent twin gated on styleCommandsNeeded") is
the most recent batch and touches translucent-command gating — a *possible* correlate to investigate,
not a confirmed cause. Ledgered in DEFERRED_WORK for a dedicated triage; NOT fixed here (out of M-OIT
scope, and this slice must not expand into unrelated engine changes).
