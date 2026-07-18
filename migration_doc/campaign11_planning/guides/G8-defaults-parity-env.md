# C11 Cluster Guide G8 — Shadows/Lighting (5) · Atmosphere/Sky (6) · Water (2) + the DEFAULTS-PARITY environment/lighting/water flip candidates

**Author sweep HEAD: `9204647535` (Batch 701, `main`).** Every anchor below marked "verified" was
re-checked at that hash on 2026-07-18. **Load-bearing fact for this whole guide:** Batches 700 and
701 touched **NO engine source** — B700 = OIT evidence (sandcastle + probe + doc), B701 = planning
docs. The last engine-changing batch is **B699 (C10-02)** at `5b98ab9698`. So every engine anchor
here is byte-identical to the state the G1/G5 sibling guides verified, and the register's B698 sweep
drifted only by the doc-only 700/701. Line numbers are hints; **anchor by symbol** — a C10 worker is
concurrently editing engine boot files, so if any file reads mid-edit, re-verify via
`git show 9204647535:path`. The working tree was clean at guide time (`git status` = 0 dirty).

Register: `migration_doc/campaign11_planning/CANDIDATE_REGISTER.md` clusters **14 (`shadows-lighting`)**,
**15 (`atmosphere-sky`)**, **18 (`water`)**. House format per
`migration_doc/CAMPAIGN10_EXECUTION_GUIDE_2026-07-16.md` H1–H3 and the G1/G5 sibling guides. Items
are referred to ONLY by their existing register names — **the orchestrator assigns C11 numbers at
assembly; do not invent a C11-XX number anywhere.**

**This is the DEFAULTS-PARITY guide.** Beyond the 13 cluster rows, it owns the environment/lighting/
water half of `migration_doc/DEFAULT_PARITY_MATRIX_2026-07-18.md` — the deliberate/accidental default
divergences between a default WebGL Viewer and a default WebGPU Viewer. Part D folds in the four
flip-candidate rows that live in these subsystems (**enhanced-ocean — the #1 default-pixel
divergence in the fork**, night-lights-armed, AutoExposure-always-on, canvas-background) plus the
sun-bloom parity gap. **The WebGPU-OIT default-flip is RESOLVED NO-GO by Batch 700** — it is NOT in
scope; see §0.3 and do not re-litigate it.

---

## 0. MANDATORY INTAKE — read before scheduling ANY item in this guide

### 0.1 Landed-batch interaction map (B693–701) — what these clusters must not regress

| Landed change | Interaction with G8 clusters |
| --- | --- |
| **B695 C10-10 shadow single-sweep** (`probe-c10-10-shadow-single-sweep.mjs`) | **Directly relevant to `shadows-lighting`.** Cast-candidate collection is now folded into the SINGLE backend-agnostic PVS walk. Every shadow fix here (SHADOW-LAYOUT-QUANTIZED, C-R10, CSM) is **pipeline/variant-side, NOT caster-collection-side** — do not touch the sweep. Run this probe after any PVS-adjacent edit. |
| **B693 C10-01 1-frustum default** (`probe-frustum-count-3d.mjs` 1/1/1) | Any new atmosphere/shadow/water probe must assert `numberOfFrustums===1` on default 3D scenes — never assume 2 frusta. Multi-frustum interactions (planar-reflect capture, CSM cascades) must FORCE the frustum count they need. |
| **B697 C10-03 demand-driven scene-color resolve** (`_sceneColorResolveElisionEnabled`) | Scene-COLOR resolves on demand via `_ensureSceneColorResolved`. Any new scene-color consumer here (planar reflection capture, night-bright composite) must DECLARE demand, never assume a resolved texture exists. Kill switch exists for A/B isolation. |
| **B698 C10-05 model texture mip-chain** | Unrelated to these clusters except that the mip-unlock touched sampler defaults — irrelevant to globe/atmosphere/ocean shaders (separate sampler paths). No action. |
| **B699 C10-02 translucent-twin gate** | Model/tile only; irrelevant to globe atmosphere/water/shadow. No action. |
| **B700 M-OIT NO-GO** (docs/probe/sandcastle only) | The OIT default-flip is closed NO-GO (§0.3). No engine change. |

### 0.2 C10 UNKNOWNS that gate items here — re-sweep the C10 ledger at intake

Cross-reference `CANDIDATE_REGISTER.md` "UNKNOWNS" table + the live C10 §3.2 ledger before cutting any brief:

- **C10-11 / C10-12 (pick-fleet log-depth + depth-plane gate)** — do NOT touch pick depth. None of the G8 items read the pick FBO, so the only interaction is: **do not open a shadow-cast-depth or planar-reflect-depth change in the same window a 14-file WGSL pick-fleet conversion is landing** (collision risk on shared depth-encode helpers). Confirm C10-11 state at intake.
- **C10-13 reversed-Z spike / C10-GT** — reversed-Z would retire the LOG_DEPTH producer surface. `OceanSurface.wgsl` and `GlobeTerrain.wgsl` are LOG_DEPTH producers (verified `//>>ifdef LOG_DEPTH` blocks). If C10-13 recorded **GO**, do not add NEW log-depth surface in C6-PLANAR-REFLECT-REFRACT or any water shader without reading the C10-GT reconciliation decision first (the pick fleet and reversed-Z pull the same 71-file surface opposite ways).
- **C10-30 perf checkpoint** — its attribution decides whether `C9-14B-ATMOSPHERE-LUT-CONSUMPTION` opens: it is a PERF item (per-fragment double ray-march), so it only earns a slice if C10-30 (or a C11 checkpoint) names ground-atmosphere fragment cost. If the checkpoint does NOT implicate it, it stays a documented-but-unscheduled perf row.

### 0.3 OIT default-flip — RESOLVED NO-GO (do not re-open)

`migration_doc/OIT_DEFAULT_FLIP_EVIDENCE_2026-07-18.md` (Batch 700, task `M-OIT-COVERAGE-AND-FLIP-EVIDENCE`)
is the maintainer-ratified record. Verdict: **NO-GO.** The WebGPU MRT-OIT accumulation path is
**architecturally unreachable for standard translucent geometry** at HEAD (only `_shaderCode`
carriers are the opaque globe and Gaussian splats — neither lands in `Pass.TRANSLUCENT`), so flipping
`_webgpuOITEnabled` is a **visual no-op** (`webgpuOIT(true)` measured pixel-identical to default;
parity vs WebGL-OIT-on stays 10.33%). The real prerequisite is a separate multi-batch wiring effort
(`NEW-WEBGPU-OIT-TRANSLUCENT-PRIMITIVE-WIRING`, ledgered). **G8 references this only to state it is
closed** — no G8 water/atmosphere item touches OIT except via the two OIT latent adjacencies owned by
the FAR-003 lane (`NEW-WEBGPU-OIT-MSAA-RESOLVE-ORDERING`, `NEW-WEBGPU-OIT-DEFERRED-SPLAT-CANVAS-RESUME`),
both in other clusters. Do not price any OIT restoration into these clusters.

### 0.4 The premise-verify-first table (READ THIS — five of these 13 rows are stale at HEAD)

The register clusters 14/15/18 draw heavily on `FEATURE_INVENTORY §C` (100–300 batches stale) and
`LQ` (~160 batches stale). I re-verified each at HEAD; the drift is material:

| Item | Register premise | HEAD reality (verified `9204647535`) | Disposition |
| --- | --- | --- | --- |
| **SHADOW-LAYOUT-QUANTIZED** | quantized terrain layouts (stride-8 u16 / stride-12 f16) MISSING; quantized-mesh terrain can't cast shadows | `SHADOW_CAST_VARIANTS.quantized12` (stride-16 BITS12) + `terrainUncompressed` EXIST; `GlobeSurfaceTileProviderRendering.js:1096` assigns them by `isQuantized`; `_inferShadowLayoutKey` warns+skips only genuinely-unknown strides | **PREMISE-STALE** — likely closed-by-evolution for terrain; real residual (if any) = quantized MODEL attributes |
| **C-R10-GLOBE-POINT-LIGHT** | globe terrain does NOT receive cube/point-light shadows on WebGPU | `C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108)` receive infra present in `GlobeTerrain.wgsl:489-575` (pointLightControl UB, cube depth target, `>0.5` gate) | **PREMISE-PARTIALLY-STALE** — verify Batch-108 receive path end-to-end |
| **C9-14B-ATMOSPHERE-LUT-CONSUMPTION** | inscatter-LUT fast path hard-disabled (useLut=0 since B247) | Fog-color path DOES sample the LUT (`GlobeTerrain.wgsl:4093-4109`, `sampleAtmosphereFogLut`); per-vertex march is debug-only (C9-14); per-fragment ground march (:4159) is ungated | **PREMISE-EVOLVED** — perf half (ungated per-frag march) REAL; "hard-disabled" wording stale |
| **C6-LTC-AREA-LIGHTS** | one-line `evalLTCAreaLights` in 21 Primitive*Lit/Phong shaders deferred | LTC lives only in `ModelPBRComplete.wgsl` + `chunks/structs/ClusteredLighting.wgsl`; **zero** hits in `Shaders/WebGPU/Primitive/` | **PREMISE-VERIFIED** — Primitive shaders genuinely lack it |
| **C6-PLANAR-REFLECT-REFRACT** | no code; analytic gradient is the fallback | `OceanSurface.wgsl:153-155` = analytic `reflect(-viewDir, worldNormal)` sky-brighten only; no reflection-texture binding | **PREMISE-VERIFIED** — analytic-only, no planar path |

**Rule for stale rows:** the first slice is a premise-reconciliation (fable), not a fix. Do not
promise a fix in a brief cut against a stale row. Fix `FEATURE_INVENTORY` in the same commit that
resolves the row (Principle 6 — the inventory is load-bearing).

### 0.5 Charter constants that bind every item here (never weaken)

No feature removal / default-off / visual degradation for a metric (Rule 1 — **this is the crux of
every Part-D flip decision**); Rule-3 conservatism; probe-first (Principle 8 — reproduce in a
`Tools/visual-regression/probe-*.mjs` and READ the PNGs before claiming a fix); one concern per slice;
moving-altitude route only for perf evidence (idle-soak invalid); premise-verify-first; RTE precision
(no absolute ECEF f32 before camera subtraction — binds the planar-reflect mirror camera and the
atmosphere per-fragment march); surface missing functionality as the next work item (Principle 9 —
binds every maintainer-decision item below).

---

## PART A — `shadows-lighting` cluster (5 items)

### A1. SHADOW-LAYOUT-QUANTIZED (P1, S) — **PREMISE-STALE; reconcile first**

#### What + why (evidence trail)

Register (FI §C.6): "Quantized terrain vertex layouts (stride-8 u16, stride-12 f16) missing from the
shadow-cast variant table — terrain from quantized-mesh providers (the common production case) cannot
cast shadows on WebGPU." Classed P1/correctness because silently-non-casting terrain is a visible
parity break (WebGL casts terrain shadows; a default `shadows:true` scene over Cesium World Terrain
would show no terrain self/onto-model shadows).

#### Architecture today (verified at HEAD `9204647535`)

The row is **stale**. The shadow-cast variant registry is now comprehensive:

- `WebGPUShadowMapRenderer.js` `SHADOW_CAST_VARIANTS` (:133) contains `rte24`, `p12`, `modelP12`,
  `modelSkinned`, `modelInstancedSB`, `modelInstanced`, **`quantized12`** (:407), **`terrainUncompressed`**
  (:514) — verified by symbol.
- **`quantized12`** (:407-496) reads `compressed0: vec4<f32>` (arrayStride **16**), decodes 2×12-bit
  via `decompressTC`, applies `scaleAndBias`, RTE-encodes, and matches the color pass's exaggeration.
  This is the `TerrainQuantization.BITS12` path — i.e. exactly quantized-mesh terrain.
- `GlobeSurfaceTileProviderRendering.js:1096` assigns
  `_shadowCastLayout: cmdDesc.isQuantized ? "quantized12" : "terrainUncompressed"` and exposes the
  actual `vertexStride` so `_getOrCreateCastPipeline(..., overrideStride)` builds a matching pipeline
  (uncompressed strides 24/28/32/36/40/44 per feature flags — DP-H25 geodetic sentinel removed).
- `_inferShadowLayoutKey` (:608) is the fall-through: strides 24→`rte24`, 12→`p12`, 16→`quantized12`;
  **any other stride** → one-time `console.warn("[WebGPUShadowMap] No shadow cast pipeline registered
  for vertex stride N. Commands with this layout will be skipped. See SHADOW-LAYOUT in the migration
  backlog.")` (:635) → returns `null` → command skipped.

So the register's literal "stride-8 u16 / stride-12 f16" does NOT describe how BITS12 terrain reaches
the GPU (it arrives as `float32x4`, stride 16, handled by `quantized12`). The named formats would
only appear from a DIFFERENT source — most plausibly **quantized MODEL attributes** (KHR_mesh_quantization
SHORT/BYTE positions, e.g. a stride-8 `SHORT4` or stride-12 `HALF3`), which models CAN produce and
which would fall through `_inferShadowLayoutKey` → `null` → silently non-casting.

#### Implementation walkthrough

0. **Premise reconciliation (the whole first slice — fable):** build `probe-shadow-quantized-terrain.mjs`
   (new — no shadow-cast terrain probe exists): default Viewer + `shadows:true` + Cesium World Terrain
   (or the offline quantized-mesh fixture) + a model on the ground; assert the terrain casts a shadow
   onto the model (or self-shadows a ridge) on BOTH backends, cross-backend diff < a small band. Also
   grep-instrument: hook the `_shadowLayoutWarned` warn and record every vertex stride that reaches
   `_inferShadowLayoutKey` → `null` on a representative model+terrain scene. **This tells you the truth
   the register can't:** which real layout, if any, is actually being skipped.
1. **If terrain casts correctly** (most likely) → the terrain half is CLOSED-BY-EVOLUTION. Close the
   FI §C.6 row (doc-only) with the probe as evidence. If the stride-scan surfaced a real skipped
   layout (e.g. a quantized model attribute), **re-scope the row** to that exact format and file it as
   the residual (`SHADOW-CAST-QUANTIZED-MODEL-ATTRIBUTES` or similar — orchestrator names it).
2. **If a real gap remains:** add the missing `SHADOW_CAST_VARIANTS` entry mirroring `quantized12`'s
   structure (decode → RTE → `lightVP` → depthBias), register it via `registerShadowCastVariant`
   (:789), and set `_shadowCastLayout` at the producing renderer. Reuse the existing UB plumbing
   (`_shadowCastTerrainUB`/model UBs) — do not invent a new binding scheme.

#### Traps

1. **B695 shadow single-sweep**: the caster COLLECTION is C10-10's landed surface — the fix here is in
   the variant/pipeline registry ONLY. Do not touch the PVS walk (same lesson as G5's POINTS residual 4).
2. **Do not add a variant for a stride nothing produces** — the register's "stride-8 u16/stride-12 f16"
   may be a phantom from an old design. Prove a real producer via the stride-scan before writing WGSL.
3. **overrideStride cache keying** (:697-723): a new variant that varies stride must go through the
   `overrideStride` path or it aliases pipelines. Read `_getOrCreateCastPipeline` before adding one.
4. **Exaggeration parity**: any terrain variant must apply the exact exaggeration math the color pass
   uses (`quantized12`/`terrainUncompressed` both do, gated `g.sceneMode > 2.5`) or shadows detach from
   the stretched surface.

#### Verification recipe

| # | Check | PASS means |
| --- | --- | --- |
| 1 | `probe-shadow-quantized-terrain.mjs` (new), both backends | quantized-mesh terrain casts; cross-backend diff within band; read PNGs |
| 2 | Stride-scan instrumentation on a model+terrain scene | enumerated: which strides (if any) hit the `null`/skip path |
| 3 | FI §C.6 reconciled | row closed OR re-scoped to the proven-real residual with a producing renderer named |
| 4 | If a variant added: `probe-c10-10-shadow-single-sweep.mjs` + `probe-csm-globe-receive-trace.mjs` | unchanged (caster collection + globe receive not regressed) |

**Model tier: fable** (premise reconciliation + stride archaeology is the work; a real WGSL variant is
mechanical opus if step 1 proves a gap). **Effort: S** (likely doc-only close) — **PREMISE-STALE flag
stands until step 0 runs.**

---

### A2. C-R10-GLOBE-POINT-LIGHT (P2, M) — **PREMISE-PARTIALLY-STALE; verify Batch-108 receive path**

#### What + why

Register (FI §C.6): "Globe terrain does not receive cube/point-light shadows on WebGPU — night-city /
indoor-outdoor scenes show lit terrain where WebGL darkens it." WIP, parity.

#### Architecture today (verified at HEAD)

The receive infrastructure **already landed** as `C-R10-POINT-LIGHT-RECEIVE-GLOBE (Batch 108)`:

- `GlobeTerrain.wgsl:489-575` — `pointLightControl: vec4<f32>` (offset 272, `.x = pointLightActive`
  flag; matches the model shader's `pointLightControl` at offset 304) + `pointLightPositionWC:
  vec4<f32>` (offset 320). The comment (:570-575): "cube depth target… cleared to depth=1.0 when no
  point light is active so the bind group always validates; the `effects.pointLightControl.x > 0.5`
  [gate]". So the WGSL has a point-light cube-shadow SAMPLE path, gated on a uniform.

This is a classic Principle-7 **scaffolding-vs-shipped** question: the receive plumbing (UB fields +
gated sample + always-validating cube depth) exists, but the register says globe terrain does not
actually darken under a point light. Either (a) the sample is wired but a producer (the point-light
cube shadow cast pass writing the cube depth) is missing, or (b) the whole path is live and the
register row is stale.

#### Implementation walkthrough

0. **Premise verify (fable):** build `probe-globe-point-light-receive.mjs` (new): a scene with a
   `pointLight`/cube shadow-caster near terrain + a shadow-blocking object between the light and a
   terrain patch; assert the shadowed terrain patch is darker than the unshadowed patch on WebGPU, and
   compare to WebGL. Read `CesiumDebug.snapshot()` for whether `pointLightControl.x > 0.5` (is the
   feature even armed?) and whether the cube depth target is being WRITTEN (not just cleared to 1.0).
   `probe-csm-globe-receive-trace.mjs` is the adjacent CSM-receive probe — clone its receive-trace
   mechanics.
1. **If the sample gate is armed but the cube depth is all-1.0** → the CAST half is missing (Principle
   9: name it — `GLOBE-POINT-LIGHT-CAST` or fold into the point-light shadow-map producer). Surface as
   the next item; do not fake-darken inline.
2. **If armed and cube depth is written but terrain still not darkening** → the receive SAMPLE math is
   the bug (coordinate transform / cube-face selection / bias). Fix in `GlobeTerrain.wgsl` behind the
   existing gate.
3. **If it works** → close the FI §C.6 row (doc-only).

#### Traps

1. **B695 single-sweep**: point-light cube casting (if that's the gap) is a caster-collection question
   — coordinate with the single PVS walk, do NOT add a parallel cast traversal.
2. **The cube depth is deliberately cleared to 1.0 when inactive** (Batch 108 note) — a "no shadow
   here" reading of 1.0 is EXPECTED when no light; don't mistake the always-validate clear for a bug.
3. **Effects BGL saturation** (see CSM moon dual-light, A3): the effects bind-group is near-full; a fix
   needing a NEW binding must audit BGL capacity first, not assume a free slot.
4. RTE: point-light position is `pointLightPositionWC` (world) — the sample must reconstruct the
   fragment position camera-relative, not absolute f32 (charter).

#### Verification recipe

`probe-globe-point-light-receive.mjs` (new) shows terrain darkening under the point light on WebGPU,
matching WebGL within band; `probe-scene-lights.mjs` + `probe-khr-lights-punctual.mjs` unchanged (model
point-light receive not regressed); `probe-csm-globe-receive-trace.mjs` green (CSM receive independent).
On/off oracle: disable the point light → terrain uniformly lit both backends.

**Model tier: fable** (scaffolding-vs-shipped diagnosis), then **opus** for the WGSL/cast fix if real.
**Effort: M.** **PREMISE-PARTIALLY-STALE.**

---

### A3. CSM-DESIGN Slices 3-4 (P2, L) — design-doc slices, well-specified

#### What + why

Register (FI §C.6 + LQ §4.6 ×3 + `migration_doc/CSM_DESIGN.md`): remaining Cascaded Shadow Map work —
**altitude-adaptive splits** (λ=0.7 wastes 3/4 cascades at orbit; collapse above ~500 km),
**moon dual-light cascades**, **VSM rg32float soft shadows**, **3D-Tiles per-tile cascade culling**,
**snapshot-mode freezable contract**, **WebGL parity path**. Merged from three LQ slices + the VSM row.

#### Architecture today (verified — infra present)

CSM cast + receive already ship (probes prove it): `probe-csm-cast-dispatch.mjs`,
`probe-csm-globe-receive-trace.mjs`, `probe-csm-soft-shadow.mjs`, `probe-contact-shadows.mjs` all exist
and are in the standing battery. `CSM_DESIGN.md` is the canonical design doc (read it in full before
any slice — the split scheme, cascade UB layout, and the deferred-slice list are there). B695's single
PVS sweep is the caster source; cascade cast lists derive from it.

#### Implementation walkthrough (one slice per concern — these are INDEPENDENT)

Each sub-slice is separately schedulable; do NOT bundle. Recommended order (cheapest correctness win
first):

1. **Altitude-adaptive splits** (S-M, opus): above ~500 km the practical-split λ=0.7 packs all detail
   into cascade 0 while 1-3 cover empty near-range — collapse the far cascades (or widen split 0) above
   an altitude threshold. Pure JS split-computation change; oracle = cascade-coverage visualization
   (`CesiumDebug.showFrustums()`-style) + a shadow-crispness diff at 500 km/orbit. No shader change.
2. **Moon dual-light cascades** (M, opus — but **BLOCKED on BGL capacity**): the register + CSM_DESIGN
   flag the effects BGL as SATURATED; the recommended path is Option C (night-only light-direction
   switch, reusing the sun cascade slot for the moon rather than adding a second cascade set + bindings).
   **This is a maintainer-adjacent design call** — a second light needs either a BGL slot (audit first)
   or the switch. Surface the BGL-capacity finding as a gate before implementing.
3. **VSM rg32float soft shadows** (L, opus-or-sol): variance shadow maps for soft edges — new
   rg32float target + moment computation + Chebyshev bound in the receive shaders. Opt-in, default-off
   (do not change the default PCF look without ratification — Rule 1). `probe-csm-soft-shadow.mjs`
   extends.
4. **3D-Tiles per-tile cascade culling** + **snapshot-mode freezable contract** + **WebGL parity path**
   — later, lower-leverage; dossier-grade until the above land.

#### Traps

1. **Rule 1 on the default shadow look**: altitude-adaptive splits must not visibly degrade the
   near-ground shadow at defaults — the win is at orbit where cascades were wasted. Prove near-ground
   parity.
2. **B695 single-sweep**: per-tile cascade culling is a caster-classification question — extend the
   single walk's per-cascade assignment, don't add a walk.
3. **Effects BGL** (moon dual-light): the hard blocker — audit capacity before promising a second
   light; the register's Option-C recommendation exists precisely because a slot isn't free.
4. **RTE**: cascade view-projection matrices are camera-relative (previousViewProjection tail contract
   — CLAUDE.md); moon light-direction switch must preserve it.

#### Verification recipe

Per sub-slice: the matching `probe-csm-*.mjs` extended with the new case; on/off/restored oracle; PNGs
read; cross-backend where a WebGL parity path exists (else WebGPU-only opt-in, byte-identical off).
`capture-and-diff` shadow scenes unchanged for the default-look slices.

**Model tier: opus** per slice (design is well-specified in CSM_DESIGN.md); **moon dual-light = maintainer-
adjacent** (BGL/Option-C decision). **Effort: L total, S-M per slice.** Premise VERIFIED (infra +
probes present; slices are additive).

---

### A4. C6-LTC-AREA-LIGHTS follow-ups (P2, M) — **PREMISE-VERIFIED; 6 independent pieces**

#### What + why

Register (DW ~5171): LTC (Linearly-Transformed Cosines) area lights v1 SHIPPED; six independent
follow-ups deferred: (1) one-line `evalLTCAreaLights` in the 21 `Primitive*Lit`/`Phong` shaders
(chunk+bindings prepended); (2) line lights; (3) clean-roomed textured emitters (must be clean-roomed
from the paper — licence hygiene); (4) froxel clustering past 8 lights; (5) WebGL2 port; (6) Sandcastle
night demo. Feature-class, opt-in default-off.

#### Architecture today (verified at HEAD)

**Confirmed:** `evalLTCAreaLights` / LTC lives ONLY in `Shaders/WebGPU/Model/ModelPBRComplete.wgsl` and
`Shaders/WebGPU/chunks/structs/ClusteredLighting.wgsl` — **zero hits** in `Shaders/WebGPU/Primitive/`
(grep verified). So piece (1) is real: primitive lit/phong shaders don't consume LTC. `probe-ltc-area-light.mjs`
is the standing acceptance probe (models). The v1 is WebGPU-only, default-off (Rule-21 opt-in surface).

#### Implementation walkthrough

Piece (1) is the highest-value, well-specified follow-up:

1. **Premise re-verify:** confirm the LTC chunk + bindings exist and are prependable (read how
   `ModelPBRComplete.wgsl` includes them). Confirm the Primitive shaders share a lighting-chunk include
   mechanism.
2. **Piece (1) — Primitive LTC:** prepend the LTC chunk + LUT bindings to the 21 `Primitive*Lit`/Phong
   shaders and add the `evalLTCAreaLights` call in each lighting accumulation. **This is genuinely
   ~one line per shader** IF the chunk/binding infra is shared — but 21 shaders means a bindings-budget
   check per shader (the LTC LUT textures need bind slots; some primitive shaders may be near-full).
3. Pieces (2)-(6) are separate slices; (3) textured emitters has a **licence-hygiene gate** (clean-room
   from the paper, not the reference implementation) — surface that as a constraint, not a code task.

#### Traps

1. **Default-off, byte-identical**: area lights are opt-in; a default Viewer with no area lights must be
   byte-identical (the `//>>else`/zero-light path). Do not regress the non-area-light primitive look.
2. **Bindings budget**: 21 shaders × LTC LUT bindings — audit each shader's BGL headroom; a primitive
   shader that's full needs the shared-slot approach, not a new binding.
3. **Licence** (piece 3): textured emitters MUST be clean-roomed — record provenance in the batch
   message; do not copy the paper's shader.
4. **froxel clustering** (piece 4) interacts with `ClusteredLighting.wgsl` (the LTC home) — coordinate
   with the clustered-lighting path, don't fork it.

#### Verification recipe

`probe-ltc-area-light.mjs` extended with a lit-PRIMITIVE leg (an area light over a box/polygon
primitive); WebGPU shows the area-light contribution, default-off byte-identical; models unchanged.
On/off oracle. PNGs read (area lights are a visual feature).

**Model tier: opus-or-sol** (well-specified; piece 1 is mechanical-but-wide). **Effort: M total, S per
piece.** **PREMISE-VERIFIED.**

---

### A5. FEAT-GAP-06 — bent-normal AO (terrain) (P3, M) — dossier, GATED

Register (LQ §11): terrain-only bent-normal AO that must live in `GlobeTerrain.wgsl` (not post-process).
**Gated behind `FEAT-GAP-01` (normal G-buffer + depth prepass producer hardening)** — which is itself a
P2 FUTURE item in the `attachment-topology` cluster (G3's territory). This is RESEARCH/GATED — do not
open in C11 unless FEAT-GAP-01 lands and the maintainer prioritizes terrain AO. Dossier only: when
unblocked, it's a `GlobeTerrain.wgsl` fragment-side term consuming the G-buffer normal + a bent-normal
cone, default-off, opt-in. **Model tier: opus** post-unblock. **Effort: M. PREMISE-UNVERIFIED (research
row; depends on a G3 producer that doesn't exist yet).**

---

## PART B — `atmosphere-sky` cluster (6 items)

### B1. C9-14B-ATMOSPHERE-LUT-CONSUMPTION (P1, M) — **PREMISE-EVOLVED; perf half real, gated on C10-30**

#### What + why (evidence trail)

Register (PR §4 S3-2): "The 16×4 Nishita double ray-march runs per-FRAGMENT on every globe fragment
whenever fog or ground atmosphere is on (both default): ~75M exp/frame near ground, ~430M at limb,
~500× WebGL's per-vertex gate; the inscatter-LUT fast path is hard-disabled (useLut=0 since B247)
though `AtmosphereLUT.wgsl` is already dispatched. Reintroduce the distance gate + revive LUT
consumption." Perf class. Sun-relative LUT re-bake deferred as `NEW-ATMOSPHERE-LUT-SUN-RELATIVE`.

#### Architecture today (verified at HEAD `9204647535`)

The premise is **partly evolved**:

- **Fog color DOES consume the LUT already** (`GlobeTerrain.wgsl:4093-4109`): when
  `effects.atmosphereLutControl.x > 0.5`, the fog branch samples `sampleAtmosphereFogLut(fragmentWorldPos,
  cameraWC)` and uses the LUT inscatter directly (falling back to the inline `computeAtmosphereColor`
  only when the LUT returns zero — the placeholder-texture case). So "the inscatter-LUT fast path is
  hard-disabled" is STALE for the fog path — the LUT delivery landed.
- **The ungated per-fragment ground-atmosphere march is REAL** (:4121-4169): the comment (:4130-4135)
  confirms "We always do per-fragment here for parity at orbit… the per-vertex path now runs ONLY when
  the per-vertex debug visualizers are active (`tile.time ∈ [13.5e9,15.5e9]`)". The march
  `computeAtmosphereScatteringGround(positionWC, lightDir)` (:4159) runs for every fragment whenever
  `camera.atmosphereParams.w > 0.5` (ground atmosphere active — a default) with **no distance gate** —
  this is the 75M-exp/frame cost. Crucially, the ground-atmosphere SCATTERING term (:4159) does NOT use
  the LUT — it's an independent fresh march, distinct from the fog-color LUT sample above it.

So the real C9-14B work: (a) **distance-gate the per-fragment ground march** (near-ground fragments
gain nothing from the full double march — WebGL's per-vertex gate is the parity precedent), and
(b) **route the ground-scattering term through the already-dispatched LUT** (extend the fog-path LUT
consumption to the ground-atmosphere color, sharing `atmosphereLutControl`).

#### Implementation walkthrough (perf slice — opens only if C10-30/checkpoint names it, §0.2)

0. **Premise re-verify:** run `probe-ground-atmosphere.mjs` + `probe-atmosphere-orbit.mjs` at HEAD and
   confirm current visual parity; grep-confirm the march is ungated. **This is a PERF item** — do not
   open it without checkpoint attribution (§0.2). If opened: instrument the fragment cost via
   `CesiumDebug.gpuPassCost(true)` on a near-ground vs limb view (API-instrumented lane, labelled).
1. **Distance gate:** add the near/far distance gate the register asks for — below the gate, use the
   cheaper approximation (or the LUT sample); above it, the full march for limb parity. The gate MUST
   be a smooth blend (no visible pop — the existing fog/LUT paths already share a `fogAmount` mix to
   avoid popping; mirror that).
2. **LUT consumption:** feed the ground-scattering color from `sampleAtmosphereFogLut` (already wired
   for fog) instead of a fresh `computeAtmosphereScatteringGround` where the LUT is valid; keep the
   inline march as the `//>>else`/placeholder fallback (the LUT is sun-direction-baked — the
   `NEW-ATMOSPHERE-LUT-SUN-RELATIVE` re-bake is the deferred correctness prerequisite for wide-angle
   accuracy; note it).
3. **Off-oracle:** the LUT-off path (`atmosphereLutControl.x < 0.5`, or the placeholder-zero fallback)
   must render byte-identical to today's inline march — so a device without compute, or a cold frame
   before the LUT dispatches, is unchanged.

#### Traps

1. **This is PERF, not correctness** — a "fix" that changes the atmosphere LOOK at defaults is a
   feature change (forbidden). The invariant is: same pixels, fewer exp calls. Prove pixel-parity
   (`capture-and-diff` atmosphere scenes within the byte-band) AND a measured exp/dispatch reduction.
2. **Sun-relative LUT staleness**: the LUT is baked for the current sun direction; at wide view angles
   or fast sun motion the LUT can lag the true scattering. The register defers the re-bake as a
   separate item — do NOT silently accept LUT error as "good enough"; gate LUT consumption to the
   accuracy envelope and fall back to the march outside it.
3. **Both fog AND ground-atmosphere default on** — the gate must handle both being active without
   double-counting (the fog path and ground path already coexist at :4171+; read the full mix before
   editing).
4. **Debug visualizers**: the per-vertex march path is alive only in the `tile.time` debug window
   (:4132) — do not delete it (Principle 7, it feeds `CesiumDebug.globeFragmentDebug`).
5. **Promotion bar**: moving-altitude route only; ≥5% named-stage or >3× noise; the structural claim
   (exp/frame ↓) is the landing bar, not a wall-clock banner (B699 honest-partial precedent).

#### Verification recipe

`probe-ground-atmosphere.mjs`, `probe-atmosphere-orbit.mjs`, `probe-atmo-luts.mjs`, `probe-atmo-lut-off.mjs`,
`probe-fog-state.mjs` all unchanged in PIXELS; `probe-atmo-lut-no-device-error.mjs` clean; exp/dispatch
counter on/off/restored via `gpuPassCost`; `capture-and-diff` full battery within byte-band; PNGs read
at near-ground AND limb. Off-oracle: LUT-disabled path byte-identical to pre-slice.

**Model tier: opus-or-sol** (well-specified perf transform with a hard pixel-parity invariant; fable
only if the distance-gate blend proves visually finicky). **Effort: M.** **PREMISE-EVOLVED — gated on
C10-30 attribution.**

---

### B2. C6-HIGHER-ORDER-SCATTER-LUT (reframed diagnostic) (P2, S) — diagnostic increment

#### What + why

Register (LQ C7 §4): MS (multiple-scattering) LUT already ships (Hillaire f_ms, B429). The REAL
increment is **DIAGNOSTIC**: verify that shadowed/night TERRAIN consumers actually sample the MS-LUT
and wire them if not. Correctness class, S effort.

#### Architecture today (verified)

MS-LUT infrastructure present: `probe-sky-ms.mjs`, `probe-sky-ms-azimuth.mjs`, `probe-sky-ms-directional.mjs`,
`probe-ms-lut-azimuth.mjs` all exist (the sky MS-LUT is exercised). The open question is the TERRAIN
consumer: does `GlobeTerrain.wgsl`'s ground-atmosphere / shadowed-terrain path sample the MS-LUT, or
only the sky dome? (This is adjacent to B1 — the ground march at :4159 is where an MS term would land.)

#### Implementation walkthrough

0. **Diagnostic first (this IS the item):** trace whether the shadowed/night terrain color includes an
   MS-LUT term. Grep `GlobeTerrain.wgsl` for the MS-LUT sampler binding; if absent, the terrain isn't
   consuming it. Build/extend a probe: a night-side or shadowed terrain view; compare WebGPU terrain
   ambient to WebGL (which computes MS differently) — the signature is terrain that's too dark in shadow
   (no MS ambient) vs WebGL.
1. **If unwired:** add the MS-LUT sample to the terrain ground-atmosphere ambient term (shares the
   atmosphere UB/LUT infra from B1 — **coordinate with B1**; ideally sequence B1 first so the LUT
   consumption seam exists, then B2 adds the MS term on the same seam).
2. **If already wired:** close the row (doc-only) with the diagnostic evidence.

#### Traps

1. **Overlaps B1** — both touch the ground-atmosphere term. Sequence: B1 (LUT consumption + gate)
   first, then B2 (MS term on the same seam). Do not open both blind in parallel (collision on
   `computeAtmosphereScatteringGround`).
2. **Correctness, not perf** — the MS term is a visual ambient contribution; prove it against WebGL's
   look, not a metric.

#### Verification recipe

`probe-sky-ms*.mjs` unchanged (sky MS not regressed); new/extended shadowed-terrain leg shows the MS
ambient on WebGPU matching WebGL within band; PNGs read. On/off oracle if a flag gates it.

**Model tier: fable** (diagnostic-then-maybe-fix). **Effort: S.** Premise VERIFIED (MS-LUT ships; the
increment is the terrain-consumer check).

---

### B3. NS-SUN-BLEND-MODE-DIVERGENCE (P2, M) — **PREMISE-VERIFIED; maintainer-direction item**

#### What + why

Register (DW ~5211): Sun/moon flare composites **ALPHA_BLEND on WebGL but ADDITIVE on WebGPU** (additive
can only brighten — an extinguished horizon sun fades to a pale glow instead of going dark). Parity
class. Bright-sun case must stay byte-identical.

#### Architecture today (verified at HEAD)

Confirmed: `WebGPUEnvironmentRenderer.js:99` ("additive blend turns the white texel * alpha into a
glowing sun over the sky") and `:227` ("lives in alpha (and blue), so additive blending paints a
glowing sun") — WebGPU uses **additive** for the sun/moon flare. The register's two directions:
**(a)** switch WebGPU flare → ALPHA_BLEND matching WebGL (WGSL halo-in-alpha rework + moon recheck),
or **(b)** ratify additive as the WebGPU look + retune the WebGL path. This is a **direction decision**
(same class as WIRE-MODEL-SILHOUETTE / NS-SUN-BLEND is explicitly "doc-only, independently schedulable").

#### Implementation walkthrough

0. **Evidence for the decision ask (fable):** regenerate both PNGs (bright noon sun AND an
   extinguished-horizon sun) on both backends via `probe-sun-lens-glare.mjs` / `probe-sun-glowfactor.mjs`
   / `probe-sun-pixel-check.mjs`; quantify the horizon-sun divergence (WebGPU pale-glow vs WebGL dark).
   Attach to the maintainer ask.
1. **STOP-AND-CONFIRM the direction** (Principle 9): additive-vs-alpha is a visual-policy call the
   maintainer owns. Do not implement before the decision.
2. **If (a) — match WebGL alpha-blend:** rework the WGSL so the halo/glow lives in alpha and composites
   ALPHA_BLEND; the flare texture's glow-in-alpha (currently additive-assumed) must be re-authored;
   **recheck the moon** (same additive assumption at :227). The bright-sun case MUST stay byte-identical
   (the hard invariant).
3. **If (b) — ratify additive:** doc-only for WebGPU; retune WebGL is a separate WebGL-side slice
   (touches `EnvironmentRenderer.js`/`Sun.js` — coordinate with the parity report methodology note).

#### Traps

1. **Bright-sun byte-identity** is the invariant either direction — the divergence is only visible at
   horizon/extinction. Prove noon-sun parity holds before/after.
2. **Moon shares the additive assumption** (:227) — any alpha-blend switch must handle the moon or the
   moon regresses (moon phase/earthshine is NEW-SUN-MOON-FIDELITY territory, B6 — don't conflate, but
   don't break it).
3. **Sun extinction is already computed once** (`Sun.js` extinction, consumed by both backends per the
   matrix parity appendix) — the divergence is purely the COMPOSITE blend, not the extinction math.
   Don't re-derive extinction.

#### Verification recipe

Both-backend PNG pair at noon (byte-identical) + horizon-extinction (divergence quantified, then
resolved per the chosen direction); `probe-sun-*.mjs` battery + `probe-moon-atmosphere.mjs` +
`probe-skybox-stars-sun.mjs` unchanged where not the target; on/off oracle.

**Model tier:** decision = **maintainer**; execution **opus-or-sol** (S if doc-only, M if the WGSL
alpha rework). **Effort: M.** **PREMISE-VERIFIED (additive confirmed at HEAD).**

---

### B4. NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT (P2, unknown) — **PREMISE-NEEDS-RUNTIME; visual**

#### What + why

Register (DW ~5209): "Fork renders a bright/opaque surface skyAtmosphere even at the anti-solar nadir —
night sky not dark, washes out the additive catalog stars." Sibling `NS-SKYBOX-CUBEMAP-EXTINCTION`
independently schedulable. Parity, unknown effort (un-expanded).

#### Architecture today (verified — with tension)

`SkyAtmosphere.wgsl:1025` carries a PRIOR fix: "a night sky was pure black. When `atmosControl.y > 0.5`
[…]" — i.e. an earlier session made the night sky NOT pure black (via `atmosControl.y`). The current
complaint is the OPPOSITE end: at the anti-solar nadir the surface skyAtmosphere is now TOO bright and
washes out the additive stars. So there may be a calibration tension between the "not-pure-black" fix
and the "dark-enough-for-stars" requirement — a runtime visual check is required to characterize it.
This overlaps the sun-facing star probes (`probe-skybox-stars-sun.mjs`, `probe-sun-stars-extinction.mjs`)
and the star-extinction path.

#### Implementation walkthrough

0. **Premise-needs-runtime (fable):** build/extend a night-nadir probe (`probe-night-nadir-skyatmosphere.mjs`
   — no anti-solar-nadir probe exists): camera at the anti-solar point looking up at the night sky;
   assert (a) the sky is dark enough that catalog stars are visible (sample star pixel vs background),
   (b) compare WebGPU vs WebGL night-sky brightness. Read the PNGs — this is a pure visual/parity item.
1. **If WebGPU night sky is measurably brighter than WebGL** → tune the surface skyAtmosphere
   night-side opacity/brightness (the `atmosControl.y` path) so stars show, WITHOUT reintroducing the
   pure-black regression (:1025's fix). This is a calibration walk — bracket between "stars visible"
   and "not pure black".
2. **Coordinate with `NS-SKYBOX-CUBEMAP-EXTINCTION`** (the sibling — skybox star extinction) so the two
   don't fight over star visibility.

#### Traps

1. **Do not reintroduce the pure-black night sky** (:1025's fix) — the fix is a NARROW brightness
   reduction at nadir, not a revert.
2. **Additive stars** (matrix parity appendix: StarField renders on both backends) — the target is
   stars VISIBLE against a dark-but-not-black sky; verify the star catalog isn't itself the thing being
   washed (it's additive, so a bright sky floor swamps it).
3. Visual/parity — no metric; WebGL is the reference look.

#### Verification recipe

`probe-night-nadir-skyatmosphere.mjs` (new): night stars visible on WebGPU, night-sky brightness within
band of WebGL; `probe-skybox-stars-sun.mjs` + `probe-sun-stars-extinction.mjs` + `probe-env-skybox-stars.mjs`
unchanged (day/sun-facing not regressed); PNGs read. On/off/restored calibration oracle.

**Model tier: fable** (visual calibration + the black-vs-bright tension). **Effort: unknown → likely
S-M once the runtime check bounds it.** **PREMISE-NEEDS-RUNTIME.**

---

### B5. FUT-MULTI-BODY-ATMOSPHERE (P3, M-L) — dossier, FUTURE

Register (DW ~5233 + LQ §9.3): generalize atmosphere to arbitrary bodies (Mars first, airless gate).
Research complete, zero code. The LUT chain is ~80% per-body parameterized; the real work is a short
hardcoded-Earth constants list (`ATMOSPHERE_THICKNESS` in TWO parity-critical sites, `outerEllipsoidScale`,
ozone tent, `groundAlbedo`, Mie SSA). **Land as a frozen-preset `BodyAtmosphereProfile` (EARTH
byte-identical)** — the EARTH preset must reproduce today's pixels exactly (the hard invariant), Mars
as a second preset. Dossier-only for C11 unless the maintainer prioritizes non-Earth. **Model tier:
opus-or-sol** (well-specified, byte-identical-EARTH invariant is the discipline). **Effort: M-L. Premise
VERIFIED (research complete; the constants are enumerable).**

---

### B6. NEW-SUN-MOON-FIDELITY (P3, M) — dossier, stranded

Register (LQ §9.3): physical sun disc + limb darkening + atmosphere-coupled glow + geometry lens-glare;
moon phase-correct PBR regolith + earthshine. Feature-class, stranded (no DW/C9/C10 row). Overlaps B3
(sun/moon flare blend) and the existing `probe-moon-sunlit.mjs` / `probe-moon-atmosphere.mjs` /
`probe-env-moon.mjs` / `probe-sun-lens-glare.mjs`. **Dossier-only for C11** — this is a fidelity
enhancement, not a parity bug; opt-in default-off if pursued (WebGL-parity look must remain default
unless ratified — Rule 1). Sequence AFTER B3 (the blend-mode decision changes how the disc/glow
composite). **Model tier: opus-or-sol** post-scoping. **Effort: M. PREMISE-UNVERIFIED (feature request,
not a defect; needs a maintainer priority + scope).**

---

## PART C — `water` cluster (2 items)

### C1. C6-PLANAR-REFLECT-REFRACT (P2, L) — **PREMISE-VERIFIED; unblocked-but-deferred**

#### What + why

Register (DW ~5225, C9 W7-2): planar reflection for the FFT ocean (three.js Reflector, MIT) — mirror
camera across the ocean tangent plane + Lengyel oblique clip, render globe/sky into one reflection
target, projectively sample in `OceanSurface.wgsl` behind an add-only ShaderDefine (analytic gradient
as `//>>else`). Refractor/Water2 flow-map refraction is a second increment. Gate C6-FFT-OCEAN shipped
B654. Feature-class, L. **Structural blocker (register):** the ocean FR emits a DEFERRED command, so the
reflection needs a reflected-camera re-render hooked into the ~4500-line `WebGPUSceneRenderer`
orchestration (mirror `runSceneCapture` snapshot/repoint/restore).

#### Architecture today (verified at HEAD)

- `OceanSurface.wgsl:153-155` — the reflection today is **analytic only**: `reflect(-viewDir,
  worldNormal)` → sky-up brighten. **No reflection-texture binding, no projective sample** (grep
  confirmed the file's only reflect/planar hits are this analytic block + the LOG_DEPTH ifdefs). So the
  `//>>else` analytic path the register wants to preserve ALREADY EXISTS — the planar path is purely
  additive.
- The FFT ocean itself ships (B654; `probe-fft-ocean.mjs` exists). The reflected-camera re-render
  precedent is `runSceneCapture` (env-capture) inside `WebGPUSceneRenderer` — the register names it as
  the mirror-target pattern.

#### Implementation walkthrough (feature slice — opt-in, default-off, byte-identical off)

0. **Premise verify:** run `probe-fft-ocean.mjs`; confirm the analytic reflection is the current look.
   Read `runSceneCapture` fully (the snapshot/repoint/restore orchestration is the reusable spine).
1. **Slice 1 — reflected-camera capture:** add a reflected camera (mirror across the ocean tangent
   plane) + Lengyel oblique near-clip; render globe + sky into ONE reflection target via a
   `runSceneCapture`-style pass. **RTE:** the mirror camera position/matrices must stay camera-relative
   (no absolute ECEF f32 — charter); the reflection plane is defined in camera-relative space.
   **Frustum:** this is inherently a SECOND render pass — coordinate with the 1-frustum default (B693)
   and the demand-resolve (B697): the reflection capture must declare scene-color demand, not assume a
   resolved texture.
2. **Slice 2 — projective sample:** in `OceanSurface.wgsl`, add `//>>ifdef OCEAN_PLANAR_REFLECT`
   projectively sampling the reflection target; keep the analytic `reflect()` block as `//>>else`
   (add-only ShaderDefine — never reorder/renumber the registry; note the registry is near-full per
   C10-08b, so confirm a free bit or reuse mechanism before allocating).
3. **Slice 3 (second increment) — Water2 flow-map refraction:** separate slice, do not bundle.

#### Traps

1. **ShaderDefine registry near-exhausted** (bits 0-30 occupied; C10-08b widens it, gated on C10-08) —
   an add-only `OCEAN_PLANAR_REFLECT` bit needs a free slot OR the reuse/widening mechanism. Confirm
   before coding (same blocker class as the parked Model Slice-C varyings).
2. **Reversed-Z reconciliation (§0.2):** the reflection pass writes depth (LOG_DEPTH producer). If
   C10-13 recorded GO, do NOT add new LOG_DEPTH surface without the C10-GT reconciliation — the mirror
   pass's depth encoding must match whatever the fleet is converging on.
3. **Default-off byte-identical:** the analytic `//>>else` path is the default — a default Viewer's
   ocean must be pixel-identical to today (the ShaderDefine off). Prove it.
4. **Deferred-command ordering:** the ocean FR emits a deferred command; the reflection capture must run
   BEFORE the ocean surface samples it — sequence the capture in the frame graph ahead of the deferred
   ocean draw (mirror how env-capture sequences).
5. **Private submit:** `runSceneCapture` may private-submit — the FAR-200 family rule prefers the main
   encoder; check whether the reflection capture can ride the main frame encoder (the register's
   `runSceneCapture` mirror note; coordinate with the submit-consolidation seed).

#### Verification recipe

New `probe-planar-reflect-ocean.mjs`: opt-in flag ON shows sky/terrain reflected in the FFT ocean
surface (WebGPU-only; no WebGL twin — feature-flagged); flag OFF byte-identical to `probe-fft-ocean.mjs`
baseline; `capture-and-diff` default-globe within byte-band (default off); on/off/restored; PNGs read
(reflection is a visual feature). Perf: the extra pass cost measured on the moving route (opt-in, so no
default-path regression — verify the OFF path adds zero passes).

**Model tier: opus-or-sol** (well-specified against `runSceneCapture`; the RTE mirror math + oblique
clip is the risk, not ambiguity). **Effort: L (multi-slice).** **PREMISE-VERIFIED (analytic-only at
HEAD; structural re-render blocker real).**

---

### C2. WATER-PHASES-1-9 (P3, XL) — dossier, UNBUILT (design-locked)

Register (LQ §10.1, `migration_doc/WATER_RENDERING_DESIGN.md` v2): Phases 1-9 beyond the GlobeWater
facade + B636 lake-mask seed + separately-shipped FFT ocean v1 — Gerstner + type LUT, bathymetry/
Beer-Lambert/refraction, foam+caustics, rivers, underwater/god-rays, WaterRegion, quantized-mesh 0x05.
~8.5 sessions est. **Phase-3 depth sampling now UNBLOCKED (log-depth B251); rest no hard blockers.**

**C11 disposition: dossier + one entry-slice candidate.** This is an XL multi-session epic — do NOT
open the whole thing. But it is entangled with the **enhanced-ocean flip (D1)** and the OPEN
**water-bugs-2026-07-06** lane (ocean bright / no waves): a worker resolving the water bugs and the
enhanced-ocean flip should read WATER_RENDERING_DESIGN.md so the flip doesn't foreclose a design phase.
Existing water probes: `probe-lake-water-mask.mjs`, `probe-large-lake-water.mjs`, `probe-water-mask-coast-aa.mjs`,
`probe-river-water-intensity.mjs`, `probe-daytime-ocean-brightness.mjs`, `probe-webgpu-ocean-waves.mjs`,
`probe-exag-water-streaks.mjs`, `probe-ssr-water.mjs`. **If an entry-slice is wanted:** Phase-1 Gerstner
+ type LUT is the design's foundation slice (the water-bug fix may naturally seed it). **Model tier:
opus-or-sol** per phase, **fable** for the design-reconciliation entry. **Effort: XL. PREMISE VERIFIED
(design-locked, unbuilt; Phase-3 unblocked).**

---

## PART D — DEFAULTS-PARITY FLIP CANDIDATES (maintainer-GATED)

These are the environment/lighting/water rows of `DEFAULT_PARITY_MATRIX_2026-07-18.md` §(a) shortlist.
**Every one is a maintainer GO/NO-GO decision, NOT a unilateral code action** — the charter's Rule 1
(never default-disable/degrade a feature for a metric or "parity") means flipping a default-on
enhancement to off is a VISUAL-POLICY change the maintainer owns. Each slice below is written as: the
divergence, the evidence a **runtime Edge/Playwright pass must gather** (the matrix's §(b) plan is
still PENDING — no runtime diff has run), and a **GO/NO-GO recommendation** with the reasoning. The
worker's deliverable for each is the EVIDENCE + a recommendation, not a landed flip — the flip lands
only after ratification.

**Sequencing note:** all Part-D runtime evidence should be gathered in ONE Edge session (the matrix
§(b) runtime pass) — batch the captures. **First assert `context.rendererType` per lane** (matrix row
10: a silent WebGPU→WebGL fallback inverts every result).

### D1. Enhanced ocean default-on (matrix row 2) — **THE #1 default-pixel divergence; the fork's highest-impact parity call**

#### What + why (evidence trail)

`Globe.js:382 this.enableEnhancedOcean = true` (verified) — a WebGPU-only, **silent** (no
containment/ratification ID), **reverse-direction** (WebGPU-ON, WebGL-not-possible) enhancement that is
the **largest default-pixels divergence over open water** in the fork. WebGL renders classic GlobeFS
water (specular + oceanNormalMap waves under `showWaterEffect`, default true); WebGPU additionally
applies Fresnel, GGX specular, multi-octave wave normals, foam/whitecaps, subsurface scattering, deep-
water color, AND darkens imagery ×0.6 (`oceanDarkening`). Entangled with the OPEN
**water-bugs-2026-07-06** lane (ocean bright / no waves). Matrix §(a) ranks it the **strongest flip
candidate**: default `false`, keep as documented opt-in until the water bugs close and the maintainer
ratifies a default-on look.

#### Architecture today (verified at HEAD `9204647535`) — WHY THIS IS NOT A ONE-LINE FLIP

- `Globe.js:365-421` — `enableNightLights`, `nightIntensity`, `enableEnhancedOcean`, and the five ocean
  dials, all default-on, under a comment (:352-356) that calls them "opt-in and only take effect in the
  WebGPU renderer… no effect on the WebGL path" — **yet they default to `true`** (the exact
  contradiction: "opt-in" but default-armed).
- `Globe.js:1225-1239` — the flags are pushed to the tile provider each frame; when `enableEnhancedOcean`
  is false, the dials are pushed as `undefined` (`this.enableEnhancedOcean ? this.oceanDeepColor :
  undefined`, etc.).
- **The enhanced ocean is UNIFORM-DRIVEN, NOT ShaderDefine-gated** (verified): `GlobeTerrain.wgsl` packs
  the dials into `oceanParams`/`nightOceanParams` UB fields (:336-339) consumed by `getFresnelPower()`
  (:701), `fresnelSchlick` (:2171), GGX (:2175), foam (:2239), subsurface (:2250), and `computeWaterColor`
  (Batch 58, :2268). There is **no `ENHANCED_OCEAN` define** — the WGSL always runs `computeWaterColor`
  on water-masked tiles (gated by `hasWaterMask`, flag `.x` at :333); only the dial VALUES distinguish
  "enhanced" from "classic." The packer (`WebGPUGlobeSurfaceTileUB.ts`) supplies the fallback when the
  dials arrive `undefined`.
- **Consequence:** flipping `enableEnhancedOcean = false` alone does NOT cleanly produce WebGL classic
  water — it sets the dials to whatever the packer defaults `undefined` to. A TRUE parity flip requires
  EITHER (a) an add-only `ENHANCED_OCEAN` ShaderDefine gating the enhanced terms with a classic
  GlobeFS-parity `//>>else`, OR (b) proof that the dials-off packer defaults reproduce WebGL's
  `computeWaterColor` exactly. This is a genuine architecture decision, not a default toggle.
- **Scope:** enhanced ocean only affects **water-masked tiles** (`_createWaterOceanMaterialBindGroupInner`,
  `WebGPUGlobeSurfaceRenderer.ts:2088`) — oceans/lakes, same surface as the classic water effect. So the
  "largest default-pixels divergence" is bounded to water pixels (not the whole globe), but water pixels
  are a huge fraction of any ocean-in-frame view.

#### The GO/NO-GO decision framework (maintainer-gated)

**Runtime evidence the Edge pass MUST gather (matrix §(b) item 3):**
1. Open-ocean saved view (specular sun angle + coastline), WebGL vs WebGPU split-screen — quantify the
   default mismatch % (this IS the "largest divergence" claim's proof; it has never been measured).
2. Repeat with `enableEnhancedOcean=false` on WebGPU — does the flip restore classic-water PARITY vs
   WebGL, or does it just change the WebGPU look (proving point (a)/(b) above)? **This is the decisive
   experiment** — if `false` does NOT match WebGL, the flip is not a parity flip and a define-gate is
   required.
3. Cross-reference the water-bugs-2026-07-06 lane: capture the "ocean bright / no waves" symptom on the
   default (enhanced) path — is the enhanced look BROKEN (a bug) or just DIFFERENT (a policy choice)?
   `probe-daytime-ocean-brightness.mjs` + `probe-webgpu-ocean-waves.mjs` are the instruments.

**Recommendation: NO-GO on a naive default-flip; GO on a define-gated parity path — MAINTAINER DECIDES.**
- A naive `enableEnhancedOcean=false` is **NOT RECOMMENDED as-is**: (i) it likely doesn't yield WebGL
  parity (uniform-driven, no define), (ii) it default-disables a shipped feature purely for "parity"
  which Rule 1 forbids without ratification, (iii) it's entangled with an OPEN bug lane — flipping
  before the water bugs close would mask, not resolve, them.
- The **RECOMMENDED** path is a two-part maintainer choice: **(A)** add an `ENHANCED_OCEAN` ShaderDefine
  (default reflecting the maintainer's chosen default look) with a verified classic-GlobeFS `//>>else`,
  making enhanced-vs-classic a clean, ratified toggle; then **(B)** the maintainer ratifies which is the
  DEFAULT (keep enhanced default-on as a deliberate fork enhancement WITH a ratification ID — closing
  the "silent" gap — OR default to classic for WebGL parity). Either way the silent-divergence is
  resolved by getting a ratification ID onto the row.
- **Do NOT flip silently.** The deliverable is the runtime evidence + this framework + a maintainer ask;
  the water-bugs-2026-07-06 fix should land FIRST (or jointly) so the ratified default look is the
  correct one, not a buggy one.

#### Traps

1. **Rule 1**: default-disabling enhanced ocean "for parity" is exactly the metric-driven feature
   degradation the charter forbids — it needs ratification, not a unilateral flip.
2. **Uniform-driven, not define-gated** — the flip is architecturally deeper than the row implies;
   don't promise a one-line change.
3. **water-bugs-2026-07-06 entanglement** — resolve or sequence with the bug lane; a flip on top of a
   bug is a masked bug.
4. **OCEANNORMAL-reupload adjacency** (G2's `NEW-WEBGPU-OCEANNORMAL-PER-CALL-REUPLOAD`): the ocean
   normal map re-upload (`_createWaterOceanMaterialBindGroupInner` + `_oceanNormalMapCache`,
   WebGPUGlobeSurfaceRenderer.ts:261/2088) is a SEPARATE (G2/terrain-imagery) perf item on the same
   consumer — coordinate; a define-gate that skips the enhanced path when off should also skip the
   normal-map upload (a free perf win on the off path). Cross-cluster; G2 owns the reupload fix.
5. **`showWaterEffect` vs `enableEnhancedOcean`** are independent flags (both default true) — the
   classic water effect and enhanced ocean are not mutually exclusive today; the define-gate design must
   decide their relationship (enhanced REPLACES classic on WebGPU water-masked tiles).

**Model tier:** evidence + framework = **fable** (the runtime experiment + architecture-tension read is
the work); the `ENHANCED_OCEAN` define implementation = **opus-or-sol** post-ratification. **Effort:
S for evidence, M for the define-gate.** **The decision itself = MAINTAINER.**

### D2. Night-lights armed default (matrix row 17) — **flip candidate, one-flag-away divergence**

#### What + why + architecture (verified)

`Globe.js:365 enableNightLights = true`, `:373 nightIntensity = 2.5` (verified) — armed by default but
GATED on `globe.enableLighting` (default false), so INERT at pure defaults. The moment a user enables
the standard upstream `enableLighting` flag, WebGPU additionally boosts night-side imagery (nightAlpha
> dayAlpha emissive city lights); WebGL does not. Silent (no containment ID), same unratified-
enhancement family as D1.

#### GO/NO-GO framework

**Runtime evidence (matrix §(b) item 11):** `enableLighting=true` night-hemisphere view, WebGL vs
WebGPU — divergence expected (WebGPU brighter city lights); repeat with `enableNightLights=false` —
parity expected. This flip is CLEANER than D1: night-lights is a discrete boost, likely more separable
than the uniform-blended ocean (verify whether it's define- or uniform-gated in `GlobeTerrain.wgsl`'s
night path — `nightOceanParams.x = nightIntensity` shares the ocean UB, so it may be uniform-driven
too; check before promising a clean flip).

**Recommendation: GO on ratify-or-flip, LOW urgency.** Inert at strict defaults, so it doesn't affect a
default-Viewer diff — but it's a one-common-flag-away visible divergence. Recommend the maintainer
either (a) default `enableNightLights=false` for parity, or (b) ratify it as a deliberate WebGPU
enhancement default WITH an ID (closing the silent gap). Because it's inert until `enableLighting`, this
can ride the D1 decision (same enhancement family, same Globe.js block, likely same UB) — **bundle the
D1+D2 ratification ask** so the maintainer rules on the whole "Enhanced rendering configuration (WebGPU)"
block at once.

**Traps:** (1) inert-at-defaults means the default-Viewer gate won't catch it — the evidence needs
`enableLighting=true` explicitly; (2) shares `nightOceanParams` UB with the ocean dials — a flip
mechanism may be coupled to D1; (3) Rule 1 — ratify, don't silently degrade. **Model tier: fable**
(evidence) → **opus** (flip). **Effort: S. MAINTAINER decision, bundle with D1.**

### D3. AutoExposure always-on compute (matrix row 14) — **flip candidate, perf-parity at zero visual cost**

#### What + why + architecture (verified at HEAD)

`WebGPUAutoExposure.ts:132 enabled = true`, `:146 altitudeGateOrbitFloor default 0.75`;
`WebGPUSceneRendererEnsureResources.ts:504` calls `host._postProcess.addAutoExposure(...)`
**unconditionally** at pipeline init (the comment at `WebGPUPostProcessStageCollection.ts:620`:
"`addAutoExposure` is wired unconditionally on WebGPU (B.14)"). So 2 compute passes + a readback ring
run every WebGPU frame, but the Tonemap consumer is disabled at SDR defaults (`highDynamicRange` false)
→ **the exposure result is UNCONSUMED at defaults.** Silent (in-code AUDIT_2026_05_02 B.14 comment
only — "SDR day/night moon transitions need adaptive exposure"; predates the containment-policy era; no
FAR/queue row). The B.14 justification concerns transitions the SDR default path can't even express
while tonemap is off.

#### GO/NO-GO framework

**Runtime evidence (matrix §(b) item 9):** `CesiumDebug.gpuPassCost(true)` / pass-cost dump — count
autoexposure dispatches at SDR defaults (expect >0 on WebGPU, 0 on WebGL); confirm ZERO pixel delta
with the stage force-disabled (proves the result is unconsumed).

**Recommendation: GO — demand-gate the dispatch (this is a clean win, NOT a Rule-1 violation).** Unlike
D1/D2, this is **not degrading a feature** — the autoexposure result is unconsumed at SDR defaults, so
gating the dispatch when no consumer (Tonemap/HDR) is enabled removes pure waste at zero visual cost
(perf parity). The fix: demand-gate `addAutoExposure`/the dispatch on `highDynamicRange` (or an active
Tonemap consumer), mirroring the C9-09 attachment-demand-registry pattern (unknown demand → conservative
= keep running, per Rule 3). **Separately**, the HDR-mode altitude-gate behavior (WebGPU adapts exposure
with an altitude gate WebGL lacks — a real visual policy difference in non-default HDR) should be
**ratified** as a deliberate WebGPU enhancement. Two deliverables: (a) demand-gate the SDR dispatch
(schedulable, opus, S), (b) file the tracking row + ratify the HDR altitude-gate (maintainer).

**Traps:** (1) Rule 3 — if the consumer-demand signal is UNKNOWN (e.g. a user enables tonemap mid-
session), keep the dispatch (conservative); the gate must react to demand, not hard-disable; (2) don't
break the HDR path — when HDR IS on, autoexposure must still run (the altitude gate is a real feature
there); (3) the readback ring lifecycle — gating the dispatch must not leave a stale readback consumer
(clean teardown); (4) this is the one Part-D item with a clear "just fix it" character (demand-gate) —
but the HDR altitude-gate half still needs ratification, so don't close the whole row on the perf gate
alone.

**Model tier:** demand-gate = **opus** (well-specified, C9-09 precedent); HDR-altitude-gate ratification
= **maintainer**. **Effort: S** for the gate. **File a tracking row (Principle 9) — this is currently
SILENT with no ledger entry.**

### D4. Empty-scene canvas background color (matrix row 4 = NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY)

#### What + why + architecture (verified at HEAD)

`WebGPUContext.ts:989 this._clearColor = new Color(0.0, 0.0, 0.0, 0.0)` (transparent black) and `:3714`
explicit comment: "[backgroundColor] deliberately NOT copied into `_clearColor` here — that would change
[behavior]". The `_clearColor` feeds the endFrame/untouched-canvas fallback (:2069-2072). So an empty
WebGPU scene (or `globe.show=false` + custom `backgroundColor`) presents transparent black where WebGL
clears to `scene.backgroundColor`. **Nuance verified:** `WebGPUSceneRendererPassRedirect.ts:159-171`
DOES honor `config.backgroundColor` for the SCENE-framebuffer clear when the scene pass opens — so the
bug is NARROWLY the **demand-deferred / no-scene-pass path** (C9-07 demand-open-canvas made the canvas
pass open only on first demand; untouched-canvas frames fall to the `_clearColor` fallback). The C9-07
slice deliberately preserved the bytes (empty-scene byte-identity gate) rather than fixing it. Queued as
`NEW-WEBGPU-CANVAS-BACKGROUND-COLOR-PARITY` (DW ~5300, C9-07 latent). Silent/accidental, the ONLY silent
divergence with default-path VISUAL exposure.

#### GO/NO-GO framework

**Runtime evidence (matrix §(b) item 5):** `globe.show=false` + non-black `scene.backgroundColor`;
assert WebGPU canvas pixels = transparent black (bug present) vs WebGL = backgroundColor.

**Recommendation: GO — fix the silent divergence (it's a bug, not a policy).** This is not a
feature-degradation trade-off — it's an accidental behavior gap. Fix: adopt `cmd.color` (the background
`_clearColorCommand`'s color) into the C9-07 deferred first-open clear / the endFrame fallback, so the
untouched-canvas path clears to `backgroundColor` instead of transparent black. **Because it's a visible
behavior change, it needs a dedicated `probe-canvas-background-parity.mjs`** (no such probe exists) — the
C9-07 slice's byte-identity gate must be updated to expect the corrected clear (the empty-scene bytes
CHANGE, intentionally). Coordinate with the C9-07 demand-open slice notes (`WebGPUSceneRendererPassRedirect.ts:17-27`).

**Traps:** (1) the C9-07 empty-scene BYTE-IDENTITY gate will FAIL by design after this fix — update it,
don't revert the fix (the bytes SHOULD change to backgroundColor); (2) don't break the scene-FB clear
that already honors backgroundColor (PassRedirect:159) — the fix is the FALLBACK/deferred path only;
(3) `_clearColor` alpha: WebGL background alpha semantics vs WebGPU premultiplied canvas — verify the
alpha channel (transparent vs opaque background) matches WebGL, especially for `contextOptions.alpha`
cases; (4) probe-first (Principle 8) — build the background probe BEFORE the fix, capture the bug, then
verify the fix moves it.

**Model tier: opus** (well-scoped, single seam, dedicated probe). **Effort: S.** Already queued —
schedulable now. **GO.**

### D5. Sun bloom inert on WebGPU (matrix row 3) — parity-restore, NOT a flip

#### What + why + architecture (verified at HEAD)

`Scene.js:556 sunBloom = true` (default), but on WebGPU the legacy path is OFF and the flag is INERT:
`WebGPUContext.ts:1654 supportsLegacySunBloom` returns false → SunPostProcess never allocated; `scene.sunBloom`
is read nowhere under `Renderer/WebGPU`. The substitute is a disc + glow halo + six lens-flare bursts
BAKED into the procedural sun texture (`WebGPUEnvironmentRenderer.js:96-99,224-229` — the additive-blend
sun of B3). The documented replacement (WebGPU PP Bloom/LensFlare) defaults OFF. Documented
(AUDIT_2026_05_02 C.12 guard) but NO parity-gap tracking row despite being a default-ON visual feature.

#### GO/NO-GO framework

**Runtime evidence (matrix §(b) item 4):** sun-in-frame view; WebGL `sunBloom` true/false A/B (delta
expected) vs WebGPU `sunBloom` true/false A/B (delta expected ZERO — proves the flag is inert). Quantify
the sun-in-frame appearance delta (WebGL screen-space bloom spill beyond the sun quad + horizon partial-
occlusion glow vs WebGPU baked-texture glow).

**Recommendation: GO on parity-restore (wire the flag), NOT a flip.** This is the matrix's "honorable
mention" — the divergence isn't a default-on enhancement to flip OFF; it's a default-ON WebGL feature
(`sunBloom`) that's silently INERT on WebGPU while its baked substitute doesn't match. The parity-
restoring move is to **wire `scene.sunBloom` to the WebGPU PP Bloom/LensFlare stages** so the flag
actually controls a screen-space bloom on WebGPU (matching WebGL's behavior), and **file the missing
parity-gap tracking row** (Principle 9 — it has none). This is more involved than a flip (it's a
feature-wiring), overlaps B3 (the additive baked sun) and the WebGPU PP bloom stages. Sequence AFTER B3
(the blend-mode decision changes the baked sun the bloom would composite over).

**Traps:** (1) the AUDIT C.12 guard exists to stop WebGL FB/shader resource LEAKS on every WebGPU viewer
— do NOT re-enable the legacy `supportsLegacySunBloom` path (that's the leak); wire the WebGPU PP stages
instead; (2) the capability comment's claim that PP Bloom/LensFlare "handles it" is FALSE at defaults
(they default off) — that's the gap; (3) overlaps B3 — the baked additive sun is what the bloom
composites over; sequence after B3's blend decision; (4) file the tracking row first (currently no
ledger entry). **Model tier: opus-or-sol** (feature-wiring). **Effort: M.** GO on parity-restore +
file the row.

---

## Model-tier + effort summary

| Item | Cluster | Tier | Effort | Gate / disposition |
| --- | --- | --- | --- | --- |
| SHADOW-LAYOUT-QUANTIZED | shadows | fable | S | **PREMISE-STALE** — reconcile first; likely doc-close |
| C-R10-GLOBE-POINT-LIGHT | shadows | fable → opus | M | **PREMISE-PARTIALLY-STALE** — verify Batch-108 receive path |
| CSM-DESIGN Slices 3-4 | shadows | opus (moon = maintainer) | L (S-M/slice) | infra present; additive slices; moon BGL-blocked |
| C6-LTC-AREA-LIGHTS follow-ups | shadows | opus-or-sol | M (S/piece) | **PREMISE-VERIFIED**; piece 3 licence-gated |
| FEAT-GAP-06 bent-normal AO | shadows | opus | M | **GATED** on FEAT-GAP-01 (G3); dossier |
| C9-14B-ATMOSPHERE-LUT-CONSUMPTION | atmosphere | opus-or-sol | M | **PREMISE-EVOLVED**; perf — gated on C10-30 |
| C6-HIGHER-ORDER-SCATTER-LUT | atmosphere | fable | S | diagnostic; sequence after B1 |
| NS-SUN-BLEND-MODE-DIVERGENCE | atmosphere | maintainer → opus | M | **PREMISE-VERIFIED** (additive); direction decision |
| NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT | atmosphere | fable | S-M | **PREMISE-NEEDS-RUNTIME** |
| FUT-MULTI-BODY-ATMOSPHERE | atmosphere | opus-or-sol | M-L | FUTURE; dossier; EARTH byte-identical |
| NEW-SUN-MOON-FIDELITY | atmosphere | opus-or-sol | M | **PREMISE-UNVERIFIED** (feature); after B3 |
| C6-PLANAR-REFLECT-REFRACT | water | opus-or-sol | L | **PREMISE-VERIFIED**; define-registry + reversed-Z gates |
| WATER-PHASES-1-9 | water | fable → opus | XL | dossier; entangled with D1 + water-bugs |
| **D1 enhanced-ocean flip** | flip | fable → opus | S+M | **MAINTAINER**; not a one-line flip (uniform-driven) |
| **D2 night-lights flip** | flip | fable → opus | S | **MAINTAINER**; bundle with D1 |
| **D3 AutoExposure demand-gate** | flip | opus (HDR = maintainer) | S | **GO** (demand-gate) + ratify HDR gate; file row |
| **D4 canvas-background** | flip | opus | S | **GO**; queued; needs dedicated probe |
| **D5 sun-bloom parity-restore** | flip | opus-or-sol | M | **GO** (wire flag, not flip); after B3; file row |

---

## OPEN QUESTIONS FOR THE ORCHESTRATOR

1. **Enhanced-ocean is the fork's highest-impact parity call and it is NOT a one-line flip.** The
   register/matrix frame it as "default `false` for parity," but at HEAD it is uniform-driven (no
   `ENHANCED_OCEAN` define), so flipping the JS default doesn't yield WebGL parity — it just changes the
   WebGPU look via packer-default dials. The real decision is a **two-part maintainer ask**: (A) add a
   define-gated classic-vs-enhanced toggle with a verified GlobeFS `//>>else`, then (B) ratify the
   default look (keep-enhanced-with-an-ID vs default-classic). **This must land jointly with (or after)
   the OPEN water-bugs-2026-07-06 fix** so the ratified default look isn't a buggy one. Recommend
   scheduling the D1 runtime-evidence slice + the water-bug diagnosis together in one water/ocean wave,
   with the ratification ask as the gate. **Needs a maintainer decision before any flip lands.**

2. **The runtime-diff pass is still PENDING** (matrix §B). Five Part-D items (D1-D5) plus the
   premise-needs-runtime B4 all depend on the ONE Edge/Playwright split-screen pass the matrix plans but
   hasn't run. Recommend the orchestrator schedule that runtime pass FIRST (as a dedicated tooling
   slice, fable) so every flip decision cuts against measured mismatch %, not static-sweep inference.
   The pass must assert `context.rendererType` per lane (silent-fallback inverts every row) and record
   results into a companion `RUNTIME_DIFF_RESULTS.md` keyed by matrix row.

3. **Bundle the "Enhanced rendering configuration (WebGPU)" ratification (D1+D2+the HDR half of D3).**
   All three are the same unratified-enhancement family in the same `Globe.js`/exposure block, none has a
   ratification ID. A single maintainer ruling on "which WebGPU-only enhancements are deliberate defaults
   (with IDs) vs parity flips" resolves the silent-divergence class in one pass rather than three.

4. **Five stale/evolved premises in these 13 rows** (SHADOW-LAYOUT-QUANTIZED, C-R10, C9-14B are stale/
   evolved; LTC + planar-reflect verified). Recommend a cheap "cluster-14/15/18 reconciliation" fable
   slice at wave start (mirror G5's proposed cluster-12 reconciliation) so later briefs cut against
   corrected `FEATURE_INVENTORY` rows. SHADOW-LAYOUT-QUANTIZED in particular is probably a doc-close, not
   an S-effort fix.

5. **C10-30 attribution gates C9-14B.** The atmosphere per-fragment march is a real ungated perf cost,
   but it only earns a slice if C10-30 (or a C11 checkpoint) names ground-atmosphere fragment cost. If
   the checkpoint doesn't implicate it, it stays a documented-but-unscheduled perf row. Confirm the
   checkpoint outcome before scheduling B1.

6. **Reversed-Z reconciliation (C10-13 GO/NO-GO) redirects C1.** The planar-reflect ocean pass writes
   LOG_DEPTH; if C10-13 recorded GO, the mirror-pass depth encoding must follow the reversed-Z
   reconciliation, and a new `OCEAN_PLANAR_REFLECT` ShaderDefine needs a free registry bit (the registry
   is near-exhausted; C10-08b widens it, gated on C10-08). Sequence C1 after the C10-08b/reversed-Z
   dispositions are recorded.

7. **CSM moon dual-light is BGL-blocked.** The effects bind-group is near-saturated; the register's
   Option-C (night-only light-direction switch) exists because a second-light BGL slot isn't free. This
   is a maintainer-adjacent design call — flag it before scheduling that CSM sub-slice.

8. **Maintainer-decision items to queue touchpoints for:** NS-SUN-BLEND direction (additive vs
   alpha-blend), D1/D2 enhanced-config ratification, D3 HDR-altitude-gate ratification, D5 sun-bloom
   parity-restore scope, and (if pursued) B5/B6/WATER-PHASES prioritization. Each stalls at
   done-but-unlandable without a ratification touchpoint — schedule them, or the workers produce
   evidence packages that sit unmerged.

9. **B3 sequences D5 and B6.** The sun/moon flare blend-mode decision (B3) changes the baked additive
   sun that both the sun-bloom parity-restore (D5) composites over and the sun-moon fidelity (B6)
   rebuilds. Sequence B3 first within the atmosphere wave.

---

*Anchor tally: 20 distinct file:symbol anchor clusters verified against HEAD `9204647535` for this
guide (all engine anchors byte-identical to B699 — Batches 700/701 are doc-only). Premise status per
item: SHADOW-LAYOUT-QUANTIZED (STALE — quantized12/terrainUncompressed exist), C-R10 (PARTIALLY STALE —
Batch-108 receive infra present), C9-14B (EVOLVED — fog LUT landed, ground march ungated), C6-LTC
(VERIFIED — absent from Primitive shaders), C6-PLANAR-REFLECT (VERIFIED — analytic-only), NS-SUN-BLEND
(VERIFIED — additive), enhanced-ocean/night-lights/AutoExposure/canvas-background/sun-bloom (all VERIFIED
at HEAD). PREMISE-NEEDS-RUNTIME: NS-SURFACE-SKYATMOSPHERE-NIGHT-BRIGHT + all Part-D flip magnitudes (the
matrix runtime pass has not run). PREMISE-UNVERIFIED: NEW-SUN-MOON-FIDELITY (feature request),
FEAT-GAP-06 (research, G3-gated).*
