# Campaign 12 — Celestial Appearance: from "present" to "photographic"

**Status: ✅ LAUNCHED 2026-07-23** (LD-1/LD-2 answered — see §6g). Runs under the orchestrator pattern (Opus + Fable subagents, model-matched per task) interleaved with C11 (certification HELD; body continues) and C13 (in-flight Sol work taken over by the orchestrator).

**Source of truth for every claim here:** [CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md](CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md) — 8 research lanes, every load-bearing claim adversarially verified (20 of 20 heavy claims refuted and dropped; what remains survived attack).

---

## 1. Theme

> Close the last default-ON WebGPU-only celestial divergences, replace flat-disc point-source rendering with a physically-motivated glare PSF **on both backends**, upgrade the star map **to the SVS 3572 t5 variant — cleared for this project's scope per §6f and shipped under its own documented terms in `LICENSE.md`'s Bundled Engine Assets section (never under the blanket MIT grant)**, and make the Sun and Moon photometrically honest.

⚠ **Corrected 2026-07-19.** This theme originally read *"upgrade the star map within the licence we already hold."* **That was wrong and is withdrawn.** We hold no licence for the current star map. `LICENSE.md:1042` was, at authoring, an **attribution record** — a heading, two source URLs, and a pointer to *NASA's* terms — not a grant; the only grant language in `LICENSE.md` was the Apache-2.0 boilerplate covering Cesium's own code. *(Since Batch 730 the entry is the `# Bundled Engine Assets` section at `LICENSE.md:1024-1044`, which states the assets' own terms and carves them out of the blanket grant; the old stub location carries a "Moved." tombstone at `LICENSE.md:1066`.)* The shipped `t3` faces and the proposed `t5` are the **same SVS 3572 product rendered from the same two ESA catalogues, so their legal status is identical** (see §6d). The difference between them is not rights but posture: `t3` is an inherited upstream condition predating any examination of the chain, whereas `t5` would be a new deliberate download-derive-ship **after** we documented that we understand the test. Do not let the presence of an attribution entry be read as clearance for anything.

Two hard bounds:

- **(a) Everything shader-side lands on BOTH backends** (Principle 5). The "white blobs" symptom is **shared code**, not a parity defect — `StarFieldFS.glsl:18-21` and `StarField.wgsl:140-143` are character-identical and both consume `StarFieldMath.ts`. Fixing one alone would *create* a parity gap.
- **(b) No asset enters the repo whose terms are not stated exactly** in `LICENSE.md`'s **Bundled Engine Assets** section (Batch 730), carved out of the blanket MIT grant. Under the §6f scope ruling a non-commercially-licensed asset is acceptable for THIS project; the §6f reopen triggers (redistribution, commercial use, third-party grant, downstream consumer) bind every asset admitted under this bound.

---

## 2. What already landed (do not re-scope)

| Item | Status |
|---|---|
| **`C11-176` skybox star-map fade** | ✅ **FIXED, Batch 722.** WebGPU-only `enableStarBrightnessModulation` shipped ON, halving the star map whenever the Sun was ≥ ~23.6° above the camera's local horizon. WebGL's `SkyBoxFS.glsl` (9 lines) has no such term. Measured `0.493 → 1.001` mean, star pixels `4.01% → 21.20%`. Default flipped; **capability preserved** (forcing it true still dims — the gate asserts this). Also fixed the `{0.3,4.0}` fallback curve that would have caused a **total blackout**, and annotated `enableNightSkyDimming` (zero consumers). |
| **`SkyBox.Variant` selection** | ✅ **SHIPPED, Batch 728; T5 ASSET/DEFAULT COMPLETE in Batches 742/744.** `TYCHO_T3`/`TYCHO_T5` plus the descriptor table landed first; the reproducible C12-10 bake then installed six bundled 2048 JPEG faces and made T5 the default. **C12-11 completed the seam on 2026-08-06** (Edge acceptance owed): a third variant `TYCHO_T5_DIFFUSE` is now the default, carrying diffuse Milky Way light only, while the sprite catalog owns every resolved star per DR-01. The unblurred `TYCHO_T5` faces remain bundled as the ratified reversal artifact, and `TYCHO_T3` stays available offline. |
| **`LICENSE.md` Bundled Engine Assets** | ✅ **SHIPPED, Batch 730.** Carves the skybox faces out of the blanket MIT grant (`LICENSE.md:1024-1044`) with full provenance, both credits, and the terms-position analysis; its Files line (`LICENSE.md:1030`) already covers future variants of the same SVS product. **Re-scopes `C12-13` to an extension of this section.** Note: this queue's live-section `LICENSE.md:1042` citations describe the PRE-Batch-730 stub — treat them as historical line references, not current content. |

**Consequence for C12:** the fade is closed. C12 inherits the *asset* problem (the map is genuinely sparse) and the *blob* problem (shared code), which are different defects.

### 2026-07-28 status overlay for append-only rows below

This overlay is current where older row prose still says “worker complete /
pending landing or Edge”:

- `C11-176b` landed in Batch 755 and its moon-phase browser artifact passes.
- `C12-G1F1`'s environment-frustum root fix landed in Batch 761; the broader
  environment-command ownership/canonicalization work is in Batch 770 and its
  targeted gates pass.
- `C12-20`, `C12-23`, and `C12-30` landed as the Batch-756 moon wave; the
  moon-atmosphere appearance gate passes.
- `C12-15`, `C12-16`, and `C12-17` landed in Batch 766; the targeted solar
  appearance gates pass.
- LD-1 is resolved. `C11-80` is complete through Batch 770;
  `C11-79` remains partial until its full lifecycle matrix is certified.
- `C12-29` S3 has one canonical owner: **`C13-41`**. It is **blocked on C13
  Gate B** (and retains the dependencies recorded on that C13 row).
  `C13-39` is **closed as a negative result**: it proved that runtime-gated
  cloud WGSL can still raise static register pressure and therefore informs
  S3's variant/occupancy design. It is not S3's owner and is not a dependency
  blocker. This supersedes the historical C12-29 row's “after C13-39” wording.
- `C12-29` S6 is landed. S5 is integrated with its
  targeted pixel and causal moving-route instrumentation gates passing, and its
  per-fragment lunar-shadow uniforms plus GLSL/WGSL globe twins **landed as
  Batches 777/780 on 2026-08-01**; its final-certification matrix stays open.
  The last certified 2026-07-28 validation counts were: S6 Node **51/51**; S5 RTE **18/18**; visual
  source **4/4**; recovery **7/7**; protected eclipse/recovery Node set
  **145/145**; core S1/S2/S5/S6 Node set **134/134**; manager Edge/Karma
  **11/11**; performance contract **23/23**. These are historical certification
  counts, not a claim about the later changeset that landed as Batches 772-781.
- The 2026-07-28 selected-terrain browser lane passes on both renderers. From
  one fixed orbital camera, the outside target has 81/81 globe rays, exactly
  36 stable skirted meshes, gate 3, and zero body inverse ranges. The S2-only
  negative control is non-vacuous; correction matches identity exactly on
  WebGL and within one code value on WebGPU. The first inside frame is gate 2
  with 25 meshes. On the reverse transition, two conservative root fallbacks
  remain gate 2 on the first frame, then settle to the exact 36-mesh gate-3
  selection. WebGPU correction and local lanes each cost exactly one
  allocation over gate 0, independent of selected-tile count. Report:
  `Tools/visual-regression/output/eclipse-globe-shadow-report.json`.
- The renderer-wide WebGL shader follow-ups exposed by S5 now have separate
  Campaign-11 owners. `C11-180` is **PARTIAL**: the async program lifecycle and
  measured bounded final-program/fog-companion policy **landed as Batch 773
  (2026-08-01)**, taking the causal route from
  seven blocking `LINK_STATUS` waits/long tasks to four — avoided work, not a
  certified timing win — while leaving four
  structural first-use stalls and broader shadow/HDR/translucent work open.
  `C11-181` is **IMPLEMENTED / VERIFIED / LANDED (Batch 773, 2026-08-01)**:
  displaced globe
  shader references are balanced and stale shared wrappers cannot return
  released programs. Landing is not completion, and neither status closes the
  C12-29 final-certification matrix.
- C12-29 remains open. NASA-SVS geospatial comparison, real
  terrain/exaggeration/fill/provider transitions, behavioral pick/capture,
  dense timing, custom-ellipsoid runtime, generic multi-View/stereo, and a
  genuine replacement-device browser lane are not certified.

### 2026-07-31 audit overlay

- Local `main` and `origin/main` were equal at Batch 771 (`fe990ab335`) when
  this overlay was written; the changeset it audits **landed as Batches 772-781
  on 2026-08-01** (`origin/main` = `3900608bb9`). Any
  older row that says Batch-755/756/761/766/770 work is “pending landing” is
  historical prose; the 2026-07-28 overlay above is authoritative.
- `C12-31` is the canonical owner of the broad false atmospheric aureole in the
  maintainer screenshot. Its audited cause is the shared legacy atmosphere
  `NONE` path substituting local up for the astronomical Sun, not generic bloom
  and not a WebGPU-only RTE defect. `C12-18` remains the separate owner for the
  direct Sun billboard/screen-space halo integration.
  **2026-08-01: the sky-shell half is IMPLEMENTED** (new
  `czm_getSkyAtmosphereLightDirection` builtin + its WGSL twin, plus the named
  `DynamicAtmosphereLightingType.LEGACY_OVERHEAD = 3` compatibility mode), with
  the enum value and both day/night alpha gates deliberately unchanged so the
  `C12-29` suites stay 138/138. The model ground-atmosphere/fog and IBL
  radiance-bake consumers are explicitly still on the legacy direction —
  `C12-31-FOLLOWUP-A/B/C` in `DEFERRED_WORK.md`. First browser probes green 2026-08-01 (aureole anchor PASS; G1 m2b into band); the full acceptance sweep remains open.
  **2026-08-01 (later) — `probe-model-ibl` fallout, resolved as an INSTRUMENT
  defect, no engine change.** A five-round bisect convicted this changeset for
  that gate's red and proposed, hunk-level, that C12-31 had moved the WebGPU IBL
  cubemap onto the astronomical sun while WebGL's bake kept local up. **Refuted:**
  the cubemap's only C12-31 hunk is add-only for `LEGACY_OVERHEAD` and NONE is
  bit-for-bit unchanged on BOTH backends; the shipped contract test that asserts
  exactly this is green on the convicted tree. What actually happened is that
  `probe-model-ibl` never isolated its model — hiding the globe force-enables the
  sky shell (`Scene.updateEnvironment`), so a full-screen shell was counted as
  model pixels and this row's legitimate, twinned shell change moved a
  sky-dominated metric. The probe now damps the sky and proves its own isolation
  every run; its historical numbers are not comparable and `PARITY_MAX` is owed a
  re-derivation.
  **LANDING RECORD — corrected 2026-08-07 (docs-reconciliation pass). This row did
  NOT land cleanly at Batch 786; it landed as a defective 785 + 786 SPLIT.**
  - Batch **785** (`e748181065`) carries **every C12-31 ENGINE edit** — both GLSL
    call sites (`SkyAtmosphereVS.glsl:42`, `SkyAtmosphereFS.glsl:107`), the WGSL twin
    (`SkyAtmosphere.wgsl` `isLegacyOverhead`), the **public enum member**
    `DynamicAtmosphereLightingType.LEGACY_OVERHEAD = 3` and the documented semantic
    change to the existing public `NONE`, plus `Atmosphere.js`, `SkyAtmosphere.js`,
    `WebGPUSkyAtmosphereRenderer.js`, `WebGPUAtmosphereUniforms.ts`,
    `getDynamicAtmosphereLightDirection.glsl` and `Model/AtmosphereStageFS.glsl` —
    **under a commit subject naming only C13-06 / C13-07, with a body that never
    mentions C12-31.** A reviewer auditing 786 (the commit whose subject claims this
    fix) cannot see that a public API addition shipped at all.
  - Batch **786** (`34965a2b21`, 38 s later) carries exactly **4** files: the builtin
    `Builtin/Functions/getSkyAtmosphereLightDirection.glsl` (+63),
    `probe-sky-aureole-anchor.mjs`, `sky-light-direction.spec.mjs`, and this queue
    doc. Its message describes the WGSL twin and the enum — **content that is in its
    parent.**
  - ⛔ **Consequence: `e748181065` is a BROKEN INTERMEDIATE COMMIT on WebGL.** The
    split cuts between a shader **call site** and its **builtin definition**: both
    GLSL sites invoke `czm_getSkyAtmosphereLightDirection` unconditionally inside
    `main()` while `git grep "vec3 czm_getSkyAtmosphereLightDirection" e748181065`
    is empty. `ShaderSource.js:70` silently skips unknown `czm_` tokens, so the
    undeclared function reaches the driver and the sky program fails to compile at
    `ShaderProgram.js:461`. `CzmBuiltins.js` cannot mask it — it is build-generated
    from a disk glob and gitignored, so checking out 785 *deletes* the stale copy.
    **WebGPU at 785 is unaffected** (feature-renderer early return).
    **Anyone bisecting a WebGL regression across this window must `git bisect skip`
    785** — full mechanism, trigger and lesson recorded under
    "BISECT HAZARD — Batch 785" in `WEBGPU_DEBUGGING_LOG.md`.
  - **Evidence-pointer caveat:** this row's `sky-light-direction.spec.mjs` **16/16**
    citation names a file that **does not exist at 785**. It is valid for the
    combined 785 + 786 tree only — which IS self-consistent, so 786's probe/spec
    evidence stands and HEAD is healthy. Only the intermediate commit is broken.
  - The mis-split is also why the `probe-model-ibl` bisect window above could not
    separate 785 from 786. See `IBL-PARITY-GATE-ATTRIBUTION` in `DEFERRED_WORK.md`.
- Generic bloom remains radiance-driven and may spread any legitimate bright
  source. The fix is to remove the false atmosphere radiance source and align
  all atmosphere lighting consumers to one per-View astronomical Sun direction,
  while preserving an explicit legacy-overhead compatibility mode.
- The pure eclipse/globe/atmosphere Node set passes
  **138/138** (measured pre-landing; the same suites are part of the 195/195
  Node contracts re-run at the Batch-781 tip). Focused Edge/Karma execution is presently unavailable because
  the documented `EdgeHeadlessCI` run timed out before executing a test; that
  is a blocker, not a new pass count.

### 2026-08-02 Codex audit overlay

- `C12-24` is **IMPLEMENTED / LANDED / PROBE-VERIFIED (Batch 801)**. Its older
  "pending orchestrator landing + Edge run" wording is historical.
- `C12-25` is **IMPLEMENTED / LANDED (Batch 811) / EDGE-VERIFIED (Batch 813)**.
  Its older pending wording is historical.
- `C12-09` is **COMPLETE / LANDED (Batch 804)**: 2,868 independently ordered
  records through vmag 5.5, with only RA/Dec/Vmag/B−V factual fields sourced
  from NASA HEASARC. Older 263-record/provenance-decision wording is historical.
- `C12-35` below is **COMPLETE / GATE PASS — LANDED Batch 819 (2026-08-02)**.
  The "unstaged 2026-08-02 worktree" framing is historical: the audited Codex
  Sol pass landed on `main` at Batch 819 with the orchestrator's four Edge gates
  (including moon lifecycle L5) re-run green. It remains the regression
  prerequisite of `C12-33`, which is **IMPLEMENTED and LANDED at the same batch
  with its ACCEPTANCE STILL OPEN**, in three bounded lanes: Moon-local WebGL
  mips, frame-owned WebGPU texture-mip generation, and the lockstep Moon
  shader/LOD correction. Landed ≠ accepted — see the `C12-33` section below for
  the gates that have still not executed.
- The post-Batch-804 star-census red was an incomplete `C12-11` seam, not a new
  design decision. DR-01 already ratified diffuse cubemap light plus
  sprite-owned resolved stars. The unblurred `C12-10` faces are the deliberate
  reversal artifact; regenerated diffuse faces were to be installed only from
  the hash-pinned 16K source. **That switch LANDED at Batch 833 → see the
  `C12-11` row: the diffuse faces are bundled and default, regenerated from the
  re-downloaded SHA-256-verified source, and `probe-stars-catalog`'s check (A)
  was re-expressed as a resolved-POINT CENSUS (a brightness count would still be
  dominated by the cubemap, because Sirius sits only ~9° off the galactic plane)
  with a new check (G) asserting the cubemap alone yields no resolved stars.**
  The instruction "keep catalog check (A) red until that switch lands" is
  therefore discharged; what is still owed is the Edge RUN of that probe plus
  G3 diffuse/reversal visual review and the moving-camera alias/frame-cost lane.
  See
  [`C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md`](C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md).

### 2026-08-06 appearance-tail overlay

- ⛔ **STALE-WORDING CORRECTION (added 2026-08-07 by the docs-reconciliation
  pass) — read this before believing any "pending orchestrator landing" text in
  this document.** Five rows carried that wording written by the *same commit
  that landed them*, which is the exact stale-wording class the `C11-176b`
  refutation below was filed to kill. Corrected status:
  - `C12-21` **phase-dependent earthshine** and `C12-22` **soft terminator** —
    **LANDED Batch 858 (`2cb7d29fec`)**, which carries `MoonPhaseAppearance.js`,
    `Moon.js`, `EllipsoidFS.glsl` and `Moon.wgsl` on `main`. **Edge acceptance
    OWED.** Ruling **R5** also flipped `enableEarthshine` to default **ON**, so
    `C12-21` is no longer inert at engine defaults.
  - `C12-27` **angular solar glare**, `C12-14` **samplable star cubemap** and the
    `C12-13` **LICENSE residual** — **LANDED Batch 865 (`193393790c`)**, which
    carries `SolarGlareAppearance.js`, `SolarDiscModel.js`, `SkyBox.js`,
    `StarCubeMapResource.js`, `CubeMapPanorama.js`, both star renderers,
    `SkyBoxFS.glsl` and `LICENSE.md`. **Edge acceptance OWED** where each row
    states it. The bullet immediately below is superseded on the landing question
    only; its three premise corrections stand unchanged.
  - **Nothing in the C12 moon-phase or appearance-tail cluster is sitting in an
    unlanded worktree.** If you are scoping open C12 work, "pending orchestrator
    landing" in this file means *Edge acceptance owed*, not *code unlanded*.
- ~~`C12-27`, `C12-14` and the `C12-13` residual are~~ **IMPLEMENTED (worker,
  2026-08-06) — pending orchestrator landing + Edge run**. *(Landing superseded
  above — LANDED Batch 865.)* Their rows below
  carry the full record; three premise corrections came out of the batch and
  are recorded there rather than only here:
  - `C12-27`'s instruction to reuse "the `C12-05` Stiles–Holladay math" is
    **REFUTED**. C12-05 landed, but `STAR_PSF_BETA = 2.0` makes its Moffat wing
    inverse-FOURTH-power; the landed inverse-SQUARE veiling form is `C12-16`'s
    Lorentzian in `Scene/SolarDiscModel.js`, which is now the single home for
    both parameterisations of that one curve.
  - `C12-13`'s recorded residual was already two-thirds delivered, and its
    remaining third (the KTX2 derivation chain) is **vacuous** — no compressed
    face exists, because `C12-12` has not landed.
  - `C12-14` discharges `C11-163`'s named blocker, but the DEFAULT cube map
    carries **no resolved stars** (DR-01), which is a decision `C11-163` now
    has to make rather than a gap this row can close.

#### C12-33 — Moon mip/LOD and moving-seam acceptance

**Status:** IMPLEMENTED / LANDED Batch 819 / INDEPENDENT CODE GO / ACCEPTANCE
IN PROGRESS / P0 QUALITY + RESOURCE LIFETIME. Do not promote this row until the
focused browser tests and the calibrated moving Edge lane execute. The
2026-08-02 product usage cap prevented the fresh EdgeHeadless/Jasmine launch;
this is an unexecuted gate, not a waiver. Nothing in Batches 820-828 executed
it, so the gate is still owed at the 2026-08-06 tip.

The implementation corrects the earlier design note in three ways:

1. WebGL mip realization is Moon-local. C12-35 bypasses the shared Material URL
   loader, so the fork does not change generic/translucent Image materials.
   WebGL2 receives a full trilinear chain. WebGL1 does so only for POT textures
   when derivatives plus the texture-LOD extension are present; NPOT and
   lower-capability contexts retain their legal single-level LINEAR fallback.
2. Both shaders compute longitude-unwrapped `dFdx`/`dFdy`/`dpdx`/`dpdy` before
   the fragment-varying miss discard and sample with `textureGrad` /
   `textureSampleGrad`. Reusing the same normalized UV gradients does not couple
   albedo and normal-map LOD: hardware scales them by each texture's dimensions.
   The CPU-computed single LOD and implicit-post-discard prescriptions are
   superseded. WebGPU's opaque ray/ellipsoid path shades one selected hit.
3. WebGPU uses the context's coalesced, exact `(GPUDevice,
   resourceGeneration)` frame-preparation mip queue. It never adds a Moon-owned
   submit. Encode/finish/synchronous-submit failures requeue valid jobs;
   candidate destruction cancels before native destruction; compatibility
   devices retain authored chains and cube/depth behavior even when layered
   auto-generation is unavailable.

The generalized queue audit also closed external-image usage, compatibility
binding-view, copy-order, teardown, and model-allocation transaction defects.
It removed a proposed per-texture WeakMap cache that would have retained
`O(layers × mips)` one-shot views/bind groups for every resident streamed
texture. Reusable shader, sampler, layout, and per-format pipelines remain
cached.

Current evidence: package TypeScript, engine build, focused formatting and diff
checks pass; focused Moon + queue Node contracts pass 171/171. The Node/Edge
probe covers close, seam-centred, seam-at-limb, and ~16 px moving routes in both
backends plus a real `force-lod0` sensitivity control. Its threshold schema is
lane/backend keyed and fail-closed; `{}` cannot certify. Numeric thresholds
remain deliberately null until at least five paired normal/control repetitions
separate, and seam PNG inspection is mandatory. Therefore the probe remains
`CALIBRATION_PENDING`, honestly exit 2, until real runs and image review occur.

#### C12-35 — Moon texture request/device-generation lifecycle

**Status:** COMPLETE / LANDED Batch 819 (2026-08-02) / INDEPENDENT GO / P0
CORRECTNESS + RESOURCE LIFETIME / effort M. All L0-L5 phases passed in the
2026-08-02 worktree and the orchestrator re-ran the moon-lifecycle L5 Edge gate
before landing. The schema-v2 real Edge gate, exact nonzero Jasmine lanes,
focused and full Node fleets, type/build, and teardown gates are green.
`C12-33` is unblocked. Rider recorded at landing: the fleet-wide cubemap mip
pre-allocation (+~33% memory on generator-supported formats) rides this row, and
`MoonDecodedSourceCache` is the bounded/lease-pinned design, **not** the
rejected replay journal.

The complete evidence, corrected duplicate-work model, architecture, and test
matrix are in
[`C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md`](C12_MOON_TEXTURE_LIFECYCLE_AUDIT_2026-08-02.md).
A single WebGPU Moon does **not** also fetch/allocate WebGL Moon textures: its
feature-renderer return precedes the Material/WebGL upload path. Duplicate
fetch/decode occurs across the independent split-scene Moon owners, with a
possible extra WebGPU `ImageBitmap` conversion; the legacy
`EllipsoidPrimitive`/`Material` CPU frontend remains a separate, smaller tax.

**Execution phases:**

1. **L0 — COMPLETE FOR THE CURRENT BOUNDED SLICE:** finite nonnegative relief
   strength/common demand policy plus immutable request and realization tuple
   contracts are implemented. Request identity is
   `{owner, pair/variant, exactUrl, channel, requestSerial}`; GPU identity adds
   `{backend, context, device, resourceGeneration, cacheSerial}`.
2. **L1 — COMPLETE / REVIEWED GO:** the
   renderer-neutral cache returns immediate ref-counted leases, coalesces exact
   canonical URL + decode axes, bounds retained decoded memory, pins active and
   pending ownership, permits last-waiter cancellation, rejects Resource
   objects whose headers/request authority cannot fit the key, and makes every
   late cancelled settlement cleanup-only. Focused cache contracts pass 16/16.
   WebGPU now acquires the lease synchronously, holds it through active source
   preparation/upload, never closes the shared source directly, and releases
   exactly once on success, failure, supersession, or teardown. A stale pending
   decode still aborts immediately; retirement during asynchronous preparation
   defers lease release only until that reader settles. The two-consumer
   retirement case is mutation-covered. WebGL now consumes the same leases,
   realizes only during the current `Moon.update`, and bypasses Material's URL
   loader. Real Edge proves one shared fetch/decode per exact source and real
   Resource cancellation/teardown across both backends.
3. **L2 — BOUNDED WEBGPU SLICE COMPLETE / REVIEWED GO:** tuple-keyed cache retirement, independent
   albedo/normal request serials, pre/post-upload identity checks, exact stale
   or failed candidate destruction, and transactional bind-group/bundle swap.
   Publication revalidates the full tuple before and after candidate
   finalization; raw/prepared/candidate ownership is exact-once; placeholder
   transactions roll back; late closeable sources are released; teardown is
   detach-first; and async settlement requests a render wakeup.
4. **L3 — COMPLETE / REVIEWED GO:** current-context WebGL realization,
   drain-time serial checks, retained-but-unbound normal resources while off,
   and no new normal work before relief can contribute.
5. **L4 — COMPLETE:** frozen resource-free exact-pair diagnostics; allocation-
   free WebGPU steady reconciliation; focused Moon Node 75/75; full Node
   1,227/1,227; WebGL/WebGPU lifecycle Jasmine 8/8 + 9/9; type/build green.
6. **L5 — COMPLETE / INDEPENDENT GO:** schema-v2 real Edge 151 split
   certification passes with exact source sharing, request-render wake,
   distinct-B visible pixels, canceled-C final-pixel stability, queue drain,
   pending-D owner destruction, zero remaining leases, and zero console/page/
   GPU faults. **Gate amendment:** moving-camera seam/shimmer is reassigned to
   C12-33 because mips/samplers/derivatives are changed there; C12-35 owns
   static final-pixel and lifecycle integrity. This is not a waiver.

**Hard gates:** destroy during load; destroy after candidate creation; upload
rejection; every A→B→A settlement order; URL→undefined; replacement device;
same-device generation bump; off-before-first-use; off/on retention; invalid,
negative, NaN, and infinite strengths; old render-bundle key invalidated before
texture retirement; bounded-source-cache eviction/lease safety; request-render
wakeup; and no duplicate split-scene fetch/decode. A destroyed or superseded
cache must never be mutated by a late callback. All six phases now pass;
`C12-33` must retain these gates and use frame-owned submission, never a private
`queue.submit`.

### 2026-08-07 CO-3 gate-lane overlay (G1 Lane A re-scope + G2 lane construction)

**FIRST EDGE RESULTS (2026-08-07, tip `c810dbace2`, orchestrator machine lane — same session the lane landed):**

- **G2: PASS on its FIRST RUN EVER, identically on both backends (exit 0).** PSF certifies (composite ratio clears the C12-G2-DEF `>= 4` bar with agreeing slopes); delivered magnitude range **21.02:1** vs the `>= 15:1` bar (faintest peak 0.0476, brightest clipped at 1.125, clippedPixels 1 vs budget 25); C12-27 glare sub-lane: near-field energy drop **8.198%** (bar 1%), 73,288 changed px (bar 1,000), **0 brightened px**, far field (>90 deg) **byte-identical** (0 differing px) with the A/A control non-vacuous, `onSunVisibleFraction` 1 (the veil had a source). Evidence: `output/celestial-g2.json` + PNGs. **Consequences: C12-02's M4/M5 are now BOUND AND PASSING; C12-27's Edge acceptance is DISCHARGED** (its row updated below).
- **G1: exit 1 — and the red is exactly the KNOWN Lane B.** The RE-SCOPED Lane A **passes** (per-mode criteria incl. the DR-01 zero-census assertion and its positive controls) and `cubemapParity` **passes** (differingFraction 0.0019875 at maxChannelDelta 1 — quantization-level). The only failures are `in-column-star-modulation:modulationEngaged_on_both_backends` + `starEnergyRatio_in_band` — the lane the standing rule forbids attributing until `NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA` is decided (its starEnergyRatio currently measures the shell's alpha, not the modulation term). **The re-scope is therefore VALIDATED at pixels; G1 stays honestly red pending the shell-extent measurement + decision.**
- **probe-sky-twilight-range: exit 3 STRUCTURAL, honestly.** ENGINE leg **PASS** (all four lanes reproduce the shipped derivation to six decimals on BOTH backends; control lane exactly 1.0; render-time verified). The star-pixel leg is STRUCTURAL: the positional reachability control found the target box **completely black** (vmag 2.14 at (370,203), census 0, box peak luma 0.0, both backends, sun −20 deg) — an instrument gap filed as `TWILIGHT-STAR-REACHABILITY-BLACK-BOX` in DEFERRED_WORK, NOT a product verdict.

Batch group **CO-3** of `CLOSEOUT_PLAN_2026-08-07.md` Lane B. **Instruments
only — zero engine files touched.** Read this before any G1/G2 claim below.

- **`C12-01` residual DISCHARGED IN CODE, Edge acceptance OWED.** That row's last
  line reads *"OWED on this row: re-scope Lane A's star thresholds for the DR-01
  sprite-only world, exactly as Batch 848 did for `probe-stars-catalog.mjs`."*
  Done. **The zero census became the assertion, not the blindness.** Lane A now
  builds a different criterion set per mode (`MODE_ROLE` in
  `lib/celestial-g1-gate.mjs`):
  - `cubemap-only` → `cubemapOnly_dr01_resolvedSources_le_2` (the DR-01 seam
    evaluated on a live frame — a re-bake that reintroduces resolved stars, or a
    default flipped back to the un-blurred faces, now FAILS here), plus
    `litPixelRatio_in_band` and `peakLuminance_within_quantization` as the
    POSITIVE CONTROL, because a black frame also censuses zero.
  - `sprites-only` → lit-extent parity, `maxChannelDelta <= 2`,
    `differingFraction <= 5e-4` (the bounded form of the Batch-873 bit-identity
    finding), and the chroma ratio **re-pointed** from "HSV saturation at the M1
    detections" (an empty set at HEAD) to "over the brightest sprite pixels",
    which is well defined precisely because that mode switches the cube map off.
  - `default` → M2a / M2b / M2e unchanged, plus lit-extent parity, which is what
    now catches the one-sided darkness the M1 count ratio used to catch.
  - Blindness routes on `modeIsBlank` (lit pixels, bar exactly zero), not on
    `modeIsBlind` (the count). `modeIsBlind` is retained, exported and pinned so
    the supersession is auditable rather than a silent deletion.
  - **The census floor was NOT lowered.** A source-text tripwire in
    `celestial-g1-gate.spec.mjs` fails if any celestial caller passes a
    `threshold` / `peakRatio` / `minPeak` / `minContrast` override.
  `probe-sky-twilight-range.mjs` got the same treatment: its fitted
  `starAddedPixels >= 50` reachability floor is now a POSITIONAL, zero-barred
  claim against the shipped `BrightStarCatalog`.
- **`C12-02`'s M4/M5 are now BOUND.** That row shipped them "as DIAGNOSTIC until
  G2/G4 bind them (per wave structure)". G2 binds M4 (`psf_ratio1e3_ge_4`, the
  two slope criteria) and M5 (`mag_renderedRange_ge_15`, `mag_spearman_ge_0_90`).
- ⚠ **THE BRACKET STITCH WAS WRONG AND IS NOW LINEARIZED.** C12-02 stitched
  `L = (v/255)/f` on the stated assumption that the display transform is locally
  linear. The shipped HDR chain is `exposure → czm_pbrNeutralTonemapping →
  czm_inverseGamma`: the gamma step is `pow(x, 1/2.2)`, and PBR Neutral's black
  offset leaves `6.25·x²` for a neutral pixel below 0.08 — it SQUARES the faint
  end, which is exactly the halo a PSF gate measures. Measured through a
  simulation of the shipped chain at the telescope framing, the naive stitch
  reports the shipped PSF's core **2.5× too wide** and its two log-log slopes as
  **−1.910 / −6.783** — straddling the [−5,−2] band in opposite directions for a
  profile that is a single power law. **Three of the four PSF criteria would go
  red on a healthy renderer.** `lib/celestial-g2-gate.mjs` inverts the chain
  exactly (`displayToLinear`), round-tripped in the spec against a forward model
  transcribed from the shader sources. **Consequence:** the `--bracket`
  diagnostic's historical M4/M5 numbers (`ratio1e3 = 9.27`) are NOT comparable to
  what it prints now. They were diagnostic and certified nothing, so nothing is
  invalidated — but do not diff them.
- **G2 LANE EXISTS** (`node Tools/visual-regression/probe-celestial-gates.mjs --g2`),
  three sub-lanes per backend, and it must PASS IDENTICALLY ON BOTH — a
  WebGPU-only pass is a FAIL (campaign principle 5; the PSF is shared code).
  Pre-registered predicate list: `psf_rangeExtended`, `psf_ratio1e3_ge_4`,
  `psf_slopeInner_in_band`, `psf_slopeOuter_in_band`, `psf_slopes_agree`,
  `mag_renderedRange_ge_15`, `mag_spearman_ge_0_90`, `mag_clippedPixels_le_25`,
  `glare_farField_byteIdentical`, `glare_nearField_energyDrop_ge_bound`,
  `glare_nearField_changedPixels_ge_bound`, `glare_nearField_noPixelBrightened`,
  plus the cross-backend `psf_ratio1e3_parity`.
  - The `psf` sub-lane uses a **TELESCOPE framing (`fovX = 6°`)**. At the default
    60° the star's core is SUB-PIXEL (analytic HWHM 0.47 px) and M4's slope
    windows — anchored at multiples of `r_core` — contain fewer than two integer
    radii, so "two agreeing log-log slopes" is literally unmeasurable. The PSF is
    defined in angle, so narrowing the FOV samples the identical profile better;
    nothing about the profile changes.
  - The `glare` sub-lane is **C12-27's own acceptance criterion**, both halves,
    with BOTH legs on the SUNLIT side so `eclipseState.sunVisibleFraction` is 1
    and the veil has a source (an anti-sunward camera would resolve strength 0
    and every criterion would pass vacuously). An **A/A control** proves the
    byte-identity claim is falsifiable on this renderer before it is made.
- **Gates at authoring:** `celestial-g1-gate.spec.mjs` **62/62** (was 49/49; +4
  re-scope mutants incl. "the census loosened toward a brightness threshold
  (EXPLICITLY PROHIBITED)"), new `celestial-g2-gate.spec.mjs` **41/41** (14
  mutants, incl. the naive stitch), celestial family **200/200**. Prettier +
  per-file eslint clean. No engine file touched.
- **OWED — Edge acceptance, none of it has executed:**
  `probe-celestial-gates.mjs` (G1 re-run at HEAD post-re-scope),
  `probe-celestial-gates.mjs --g2` (first G2 run ever),
  `probe-sky-twilight-range.mjs` (first run since its Batch-869 repair AND the
  CO-3 re-scope). Every threshold introduced is either exactly zero, derived from
  8-bit quantization, or explicitly marked **⚠ FIRST-PASS DERIVED** in the source
  and owed a re-derivation from the first run: `SPRITE_DIFFERING_FRACTION_MAX`,
  `SPRITE_MAX_CHANNEL_DELTA`, `MAGNITUDE_SPEARMAN_MIN`,
  `GLARE_NEAR_FIELD_MIN_ENERGY_DROP_FRACTION`,
  `GLARE_NEAR_FIELD_MIN_CHANGED_PIXELS`,
  `PSF_CROSS_BACKEND_MAX_RELATIVE_SPREAD`. **They are not measurements until
  Edge runs.**
- **Filed en route, deliberately NOT fixed** (Principle 9):
  `NEW-M1-CENSUS-STRICT-LOCAL-MAX-PLATEAU` in `DEFERRED_WORK.md` — the celestial
  `m1PointSourceCensus` still uses the STRICT local-maximum test that Batch 848
  replaced in its sibling `pointSourceCensus`, so a source centred on a pixel
  boundary censuses 0. Exposure is bounded and stated in the entry; the G2 psf
  sub-lane sidesteps it by taking the brightest pixel near the AIM POINT.

---

### 2026-08-07 CO-24 gate-lane overlay (G3 lane construction)

**FIRST EDGE RUN (2026-08-07, tip `4f6d3c9751`, Batch 934): the pre-registration hit on 4 of 5 — exit 1 with the four asset/format/fidelity predicates red IDENTICALLY on both backends (`asset_arcminPerPixel_le_2_0`, `asset_faceSize_ge_2700`, `format_medianChroma_ge_0_20`, `fidelity_dustLaneIQR_ratio_ge_3`) and every split/catalogue/band predicate green. The fifth red is the instrument's own honesty: `motion_control_isolatesSubPixelPhase` — the alias-twinkle peak-vs-sum control flags imperfect sub-pixel isolation (bright-star box sum moved 1220x = the star crossed the box during the sweep), so the measured twinkle (4.758x = 1.69 mag, vs the 3.77x prediction and the 1.2 first-pass bound) reads TRIGGERED but its amplitude carries an instrument caveat until the box tracking is fixed (S follow-up: track the box with the projected star, per-frame). Reversal triggers on both backends: smearedMilkyWay NOT triggered (0.928 vs 0.60), spriteDensity TRIGGERED (0.174x of t3), aliasTwinkle TRIGGERED-with-caveat. THE MAINTAINER DECISION NOW HAS LIVE NUMBERS: re-bake at 4096 (clears both angular arms by the spec's own pin) vs re-derive the chroma/dust bars vs accept-as-written — plus whether two triggered reversal conditions warrant revisiting DR-01 (noting the smear trigger, the one DR-01 was most worried about, did NOT fire).**

Batch group **CO-24** of `CLOSEOUT_PLAN_2026-08-07.md` Lane B, following the CO-3
house pattern. **Instruments only — zero engine files touched.** Read this before
any G3 claim.

- **G3 LANE EXISTS** (`node Tools/visual-regression/probe-celestial-gates.mjs --g3`),
  five sub-lanes per backend, and it must PASS IDENTICALLY ON BOTH. New files:
  `lib/celestial-g3-gate.mjs` (pure metrics + verdict) and
  `celestial-g3-gate.spec.mjs` (59 tests). The four §5 criteria are bound as:
  - **(1) angular sampling** → `asset_arcminPerPixel_le_2_0` +
    `asset_faceSize_ge_2700`, measured on the SERVED faces of the variant the
    ENGINE resolved (`SkyBox.createEarthSkyBox(v).sources`, fetched over HTTP and
    decoded off-browser), plus a supplementary `asset_angularSampling_beats_t3`
    — an "asset UPGRADE" gate must at minimum beat the asset it replaces, and
    that predicate is what the t3 adversarial arm turns on.
  - **(2) sources/steradian ≥10× t3** → **SUPERSEDED AS CERTIFYING BY DR-01 and
    re-pointed**, exactly as Batch 848 re-pointed `probe-stars-catalog.mjs` and
    CO-3 re-pointed G1 Lane A. The cube map carries no resolved sources BY
    RULING, so a cube-map density bar is unmeasurable on the shipped asset. It
    becomes `split_diffuseFaces_resolvedSources_le_2` +
    `split_unblurredFaces_resolvedSources_ge_bound` (the detector's positive
    control) + `split_liveCubemapOnly_resolvedSources_le_2` +
    `catalogue_records_ge_shipped` / `catalogue_limitingMagnitude_ge_shipped` /
    `catalogue_liveResolvedSources_present`. **The literal ratio is still
    computed every run** and reported as reversal trigger `spriteDensity`.
  - **(3) median chroma ≥ 0.20** → `format_medianChroma_ge_0_20` (re-pointed from
    "HSV saturation at the M1 detections", an empty set on a diffuse face, onto
    the band pixels — the top decile by luminance) **plus
    `format_chromaSubsampling_is_444`, read out of the served JPEG's own SOF
    marker.** The header is the fact; the pixel level is the inference. No decode
    is needed for the header arm, so `celestial-g3-gate.spec.mjs` asserts it
    against all 18 REAL bundled files under `node --test`.
  - **(4) dust-lane structure ≥3× current** → `fidelity_dustLaneIQR_ratio_ge_3`,
    with the t3 baseline **measured in the same run** rather than read from a
    stored constant, plus `fidelity_bandStructure_retained` at the SHIPPED
    `DR01_LIMITS.diffuseMinBandRatio` (0.60).
- ⚠ **PRE-REGISTERED RED — AND THE RED IS THE ASSET, NOT THE INSTRUMENT.**
  Derived offline from the bundled bytes (18 JPEGs decoded, metrics run by the
  shipped lib; recorded as `BUNDLED_ASSET_DERIVATION`):

  | measurement | t3 (legacy) | t5 (un-blurred) | **t5-diffuse (SHIPPED)** | bar |
  |---|---|---|---|---|
  | face size / arcmin per px | 1024 / **5.273** | 2048 / **2.637** | 2048 / **2.637** | ≥2700 / ≤2.0 |
  | resolved sources (sky) | 16,474 | 43,673 | **0** (by ruling) | — |
  | sources per steradian | 1,311 | 3,475 | **0** | ≥10× t3 |
  | dust-lane IQR (σ 0.703°) | 2.996 | 1.940 | **1.753** | ≥3× t3 |
  | granularity IQR | 5.411 | 3.505 | **0.4215** | — |
  | band std-dev | 2.409 | 1.603 | **1.488** | ≥0.60× t5 |
  | median chroma | 0.000 | 0.000 | **0.000** | ≥0.20 |
  | chroma subsampling | **4:2:0** | 4:4:4 | **4:4:4** | 4:4:4 |

  **Three of the four ratified criteria are missed by the UN-BLURRED t5 as
  well**, so (1), (3) and (4) were never reachable with the SVS product Q1
  selected at the size C12-10 encoded — this is not a consequence of DR-01, and
  reversing DR-01 would not turn any of them green. Specifically: the encode
  chose **2048/face** where the criterion asks for **≥2700** (`skybox-manifest.json`
  records a 4096 master lanczos3-downsampled to 2048 — a 4096 encode clears both
  angular arms, and the spec pins that so "the bar is missed" cannot be misread
  as "the bar is impossible"); the SVS render is **near-neutral in 8 bits** at
  every tier, including at its own star cores (median saturation 0.048 on t5's
  censused sources), so the 0.20 chroma level has no candidate anywhere in the
  product family; and the t5 bake's diffuse swing is **lower** than t3's in
  stored 8-bit (0.648×), so the "≥3× current" ratio is inverted rather than
  short. The scale-invariant form (IQR/median) reads 1.21× — still not 3×.
  **The research text's own caveat — "the σ and 3× need one calibration pass
  against the chosen asset" — is hereby discharged, and the answer is that the
  bar is missed.** Bars marked RATIFIED are NOT moved to clear this; the
  maintainer decision (re-bake at 4096, re-derive the two constants against the
  chosen asset, or accept G3 as unreachable-as-written) is filed, not taken.
- **THE DISCRIMINATOR IS PROVEN, NOT ASSUMED.** `adversarial` is a real sub-lane,
  not only a spec fixture: the probe pushes the LEGACY t3 faces through the
  identical metrics every run and requires them to FAIL on format (4:2:0),
  angular sampling and the DR-01 seam (t3's faces carry 1,097-4,801 resolved
  sources per face). A t3 that came back clean is a gate FAILURE, because the
  gate would then be unable to tell an upgrade from the thing it replaced. The
  spec runs the fabricated clean-t3 mutant to prove that arm has teeth.
- **DR-01 REVERSAL TRIGGERS ARE MEASURED, NOT RULED ON** — printed in their own
  labelled block and explicitly NON-CERTIFYING, because DR-01 is a ratified
  decision whose own instruction is to "decide on evidence, not impression":
  - `smearedMilkyWay` — band-structure retention diffuse-vs-un-blurred, measured
    **0.928** against the shipped 0.60 bound (**NOT triggered**); grain retention
    0.120, i.e. the low-pass removed the granularity it was supposed to remove
    and kept the degree-scale structure it was supposed to keep.
  - `spriteDensity` — delivered **228/sr** (2,868 catalogue rows over 4π) against
    t3's measured **1,311/sr** = **0.174×**, against the ratified ≥10×
    (**TRIGGERED**). This is DR-01 reversal trigger #2 and it is also what
    criterion (2) becomes once the cube map is out of the resolved-star business.
  - `aliasTwinkle` — a **moving-camera** leg (motion-is-mandatory charter):
    24 frames, camera-only rotation at 0.37 px/frame under the PINNED clock, so
    the only thing changing is sub-pixel sampling phase. **Analytic prediction
    from the shipped PSF at the lane's framing** (`STAR_PSF_SIGMA` 0.12 × quad
    half-extent 3.667 px = core σ **0.440 px**): a faint star's sampled PEAK
    swings **3.77×** (1.44 mag) while its box SUM swings only 1.226×, and the
    brightest star (quad scale 2.909, core σ 1.28 px) swings just 1.18×. So the
    trigger is predicted **MET for faint sprites** — exactly the failure DR-01
    named ("sub-pixel sprites are the classic failure"). The certifying control
    is **peak-versus-sum on the SAME star**: resampling moves energy between
    pixels without creating it, so a sweep whose peak and sum swing together is
    modulating flux and says nothing about aliasing.
  - Cross-backend: the trigger STATES must agree (`StarField.wgsl` and
    `StarFieldFS.glsl` are character-identical), and so must the asset
    FINGERPRINT (sha256 over the resolved URLs + served bytes, taken per
    backend). A backend-dependent twinkle is a parity defect regardless of how
    DR-01 is eventually ruled.
- **Frame cost** is captured as an INTERLEAVED A/B (sprites off/on inside each
  sweep step) and reported as **DIAGNOSTIC ONLY**, unbound — a wall-clock CPU
  delta on one machine is not a GPU cost measurement. It exists so `C12-09`'s
  parked magnitude-6.0 deepen has a number to argue from.
- **Gates at authoring:** new `celestial-g3-gate.spec.mjs` **59/59** (synthetic
  ground truth for both structure metrics + their orthogonality, the REAL 18-file
  header assertion, the t3 adversarial in both directions, a pixel-fixed-sigma
  mutant, a clean-t3 mutant, a flattened-band mutant, a peak-equals-sum mutant,
  and a MUTATION-FOLD that deletes the cross-backend arms from a copy of the
  module and requires the defect it catches to come back); celestial family
  **254/254** including `probe-fleet-contract.spec.mjs` **32/32** with **no
  allowlist entry added**. Prettier + per-file eslint clean. No engine file
  touched. One instrument edit outside the new files: `celestial-g2-gate.spec.mjs`
  pinned `HARD_LIMIT_MS` by exact text, so it now pins the same expression with
  the G3 arm in front — the G2 (1,200,000 ms) and default (600,000 ms) budgets
  are unchanged.
- **Thresholds by kind.** RATIFIED (unmoved, §5's own): 2.0 arcmin/px, 2700
  px/face, 0.20 chroma, 3× dust-lane ratio, 10× source density. SHIPPED (reused,
  nothing invented): `DR01_LIMITS.diffuseMinBandRatio` 0.60,
  `DR01_LIMITS.unblurredMinPointSources` 200, `DR01_LIVE_MAX_RESOLVED_SOURCES` 2,
  catalogue 2,868 records / vmag 5.5, 4:4:4. DERIVED: `DUST_LANE_SIGMA_DEG`
  0.703125 (the research text's 16 px expressed as an ANGLE so both tiers get the
  same kernel — a pixel-fixed σ would low-pass t3 twice as hard and make the
  ratio measure the kernel), `DUST_LANE_MARGIN_FRACTION` 0.10,
  `CHROMA_BAND_PERCENTILE` 0.90, `MOTION_MIN_CHANGED_PIXELS` exactly 0-barred.
  ⚠ **FIRST-PASS DERIVED, owed a re-derivation from the first Edge run:**
  `TWINKLE_TRIGGER_PEAK_RATIO` 1.20 (0.2 mag by Pogson — a perceptual anchor, not
  a fit; the analytic model omits the LDR clamp, the premultiplied additive blend
  and any MSAA the real pipeline applies).
- **OWED — Edge acceptance, none of it has executed:**
  `probe-celestial-gates.mjs --g3` (first G3 run ever). Expected exit **1
  (FAIL)** with `asset_arcminPerPixel_le_2_0`, `asset_faceSize_ge_2700`,
  `format_medianChroma_ge_0_20` and `fidelity_dustLaneIQR_ratio_ge_3` red on BOTH
  backends and every other predicate green; `spriteDensity` and `aliasTwinkle`
  triggered, `smearedMilkyWay` not. **Anything else is news** — in particular a
  STRUCTURAL exit means a control did not come back (a black cubemap-only frame,
  a chroma detector that cannot see a known swatch, a sweep that never moved, or
  no faint target in frame) and is NOT a product verdict. G3 needs `sharp`, a
  declared repo dependency, to decode the served faces off-browser.

### 2026-08-09 G4 SECOND RUN (Batch 946) — aim repair PROVEN (appliedResidual 0, round-trip 0.1797° as predicted); FIX-5 validated on the DEFAULT heap; and the unmasked WebGL sun is REALLY BROKEN

Exit 1. Moon half green again (full:quarter 3.014). Both limb-ratio reds
returned CERTIFYING as pre-registered (webgl 0.7181 / webgpu 0.7140 vs §5
[0.3,0.5]) — the maintainer item now has clean-aim numbers matching CO-28's
predicted composite 0.733. **NEW CERTIFYING PRODUCT FINDINGS (WebGL only;
WebGPU green on all):** disc diameter **0.2907° vs nominal 0.5334°**,
trueSizeRatio **2.224 vs √2**, limb shape does not match the shipped law,
limb does not vanish at centre; halo lane structural with the NEW
discriminating note — ephemeris projection 0 px off while the brightest
pixel sits 63.9 px away: **the drawn Sun and the ephemeris disagree**;
haloBandMean 0.00041 vs webgpu 0.05144 (~125× deficit, correctly excluded
from parity by FIX-2's structural gating). FILED:
**WEBGL-SUN-APPEARANCE-STACK-DISENGAGED** — one-cause hypothesis: the
C12-15/16/18/B906 appearance stack is not engaged on the WebGL sun path in
this scene (undersized disc + no limb law + missing screen halo cohere);
DISCRIMINATOR OWED: the queued C12-19 Edge-delta run pre-registered WebGL
HDR disc 250.3 codes — running it separates a B937 regression from a
pre-existing gap. Investigation dispatched (CO-30).

### 2026-08-08 G4 FIRST RUN (Batch 941 stamp) — exit 1, and the reds DECOMPOSE: one probe aiming defect + two bound derivations; the MOON HALF CERTIFIED GREEN

**Run facts (`output/celestial-g4.json`, 12 GB heap — the first attempt OOM'd
the default ~3.6 GB Node heap at 31 min, an instrument finding in itself):**
both pre-registration upgrades fired — the C12-19 arm went **ACTIVE** on both
backends (bake clamp ABSENT + discPeakLinear 4.18/3.51 > 1.8708, the two
discriminators AGREE), and the full-moon epoch resolved **REACHABLE** (phase
angle 2.068° ≤ 5°), so every criterion certified. webgpu 33/35 green, webgl
19/21 green (its disc+halo lanes went structural, so fewer evaluated).

**✅ CERTIFIED GREEN — the C12-21/22 owed Edge acceptance is DISCHARGED:**
earthshine lights the unlit limb at crescent (median delta 0.0348 vs bar
0.005), tints blue-over-red/green-over-red in band, scales with the LIVE
resolved Earth-phase complement, terminator softness = the solar angular
radius on the LIVE uniform (and exactly 0.0 OFF), band exists/local/no pixel
darkened, phase ordering full>quarter>crescent, **full:quarter 3.013 ≥ 3.0 at
a REACHABLE 2.07° epoch** (surge multiplier 1.196 live). Policy lane 7/7 with
the SDR positive control flipping both ways. **`halo_deltaPeak_at_11_Rsun`
GREEN on WebGPU — B906's derivation confirmed live.** Lorentzian tail shape,
slope band, one-halo-source truth table: green (webgpu).

**❌ The 7 reds, decomposed (NONE is yet a product verdict):**

1. **ROOT INSTRUMENT DEFECT — the sun aim misses by ~0.35° on BOTH backends.**
   Disc-lane limb centroid 112.6 px (webgl) / 111.7 px (webgpu) off the crop
   centre at the 2° telescope fov (tolerance 8), and the webgl halo lane's
   brightest pixel is 11.77 px off at 22° fov — **the same angular error
   scaled by the fov ratio** (0.35° ≈ 12.7 px at 22°/800 px). One aiming bug,
   fov-scaling-consistent, backend-independent. The disc lanes went
   structural exactly as the lane's own pre-registration anticipated
   ("mis-projected centre ... is NOT a product verdict").
2. **The 3 cross-backend parity reds are FALSE reds from a fold-gating gap:**
   `discDiameterDeg` / `trueSizeRatio` / `haloBandMean` parity compared
   scalars HARVESTED FROM STRUCTURAL LANES (webgl's 0.292° "disc" is the
   mis-aimed crop, not a rendered disc). Parity must be gated on BOTH sides'
   source lanes being non-structural — per-lane scoping applies to the fold
   too.
3. **The 2 `limb_absoluteRatio_I095_over_I0_in_band` reds (0.679/0.714 vs
   ratified [0.3, 0.5]) were measured on the SAME mis-aimed disc captures**,
   so they are not interpretable this run — AND the arm has a named confound
   to resolve before its next certifying read: the C12-18 screen halo sits
   over the disc (its amplitude now also ×2 under C12-19), lifting the
   composite ratio above the disc-only law the §5 band was ratified for. The
   two backends agreeing (0.68 vs 0.71) says whatever this is, it is not a
   backend defect. Goes to the maintainer pack WITH the radiance-tradeoff
   ask; the bars are §5's and are NOT moved here.
4. **The 2 `earthshine_inert_at_full_moon` reds are a bound-derivation error:**
   3 × the phase-scaled crescent delta = 3 × 0.000327 × 0.0348 ≈ 3.4e-5
   luminance — BELOW the 8-bit capture quantum (1/255 ≈ 3.9e-3). The bound is
   unmeasurable by construction; it needs a floor at the instrument
   resolution (re-derivation, not widening: the criterion still rejects the
   pre-C12-21 CONSTANT term, whose full-moon delta is the full 0.035).

**FILED (this stamp is the filing): G4-FIRSTRUN-FIX-1** sun aim (~0.35°, find
the frame vs ephemeris mismatch; suspect list starts at aim-time vs
settled-clock sun position and billboard-quad vs disc-centre), **-FIX-2**
parity fold gating on non-structural sources, **-FIX-3** earthshine inertness
bound floored at the capture quantum, **-FIX-4** limb-arm reads gated on the
disc lane being non-structural, **-FIX-5** probe memory retention (holds all
captures + f64 decodes + base64 transfer strings live → >3.6 GB; release per
lane). Rerun after fixes; the moon half needs no rerun to stand — its lanes
were aimed (moonAimDistancePx 4.9–10.3 px) and non-structural throughout.

#### 2026-08-08 CO-28 correction note (the five fixes, as built — appended, the stamp above stands)

Batch group **CO-28**. **Instruments only** (`Tools/visual-regression/**` +
this note); zero engine files touched. Three corrections to the filing above
come first, because each changes what the fix had to be.

- **CORRECTION 1 — the aim error is 0.1745°, not ~0.35°, and it is ONE angle
  both sun lanes agree on.** The filing scaled the disc offset with the wrong
  pixel scale. Correct: 111.65 px ÷ 639.93 px/deg = **0.17447°** (disc, fovX 2)
  and the LIVE `frameState.sunHalo` centre (637.6122, 362.3878) vs the canvas
  centre = 3.3768 px ÷ 19.35 px/deg = **0.17470°** (halo, fovX 60, the DEFAULT
  framing — not 22°). Four significant figures apart.
- **CORRECTION 2 — neither filed suspect is the cause.** It is not aim-time vs
  settled-clock (no ephemeris motion is needed to produce the number) and not
  billboard-quad vs disc-centre. **ROOT CAUSE: `Camera.setView({orientation:
  {direction, up}})` does not keep the basis it is handed.** It converts
  direction/up to heading/pitch/roll in the local ENU frame at `destination`
  and rebuilds from the angles, and `getHeading` has a **gimbal-lock branch**
  (`CameraInternals.js`) that fires when `|direction.z|` in that frame is
  within `EPSILON3 = 1e-3` of 1 — where it takes the azimuth from the **UP**
  vector, 90° away from the direction's own. Every lane that parks on a body's
  ray and looks along it is inside that branch, and the direction is not
  *exactly* the local vertical because the geodetic normal deviates from the
  radial by `eps = f·sin(2φ)` (0.12299° at the Sun's 19.80° declination). The
  reconstruction keeps the pitch and swaps the azimuth, so the applied
  direction lands `2·sin(45°)·eps = √2·eps = 0.17393°` away, at exactly 135° in
  screen space. **Reproduced OFFLINE against the shipped `Camera`/`Transforms`
  source, no browser:** predicted 111.30 px vs measured 111.65 (disc);
  predicted (−2.38, +2.38) px vs the live halo centre's (−2.3878, +2.3878);
  and the three moon epochs predicted **4.98 / 7.85 / 10.37 px** against
  measured **4.91 / 7.92 / 10.33**. The same script puts `sunlit` and `sirius`
  at residual **exactly 0** — only `sun-facing`, `anti-sun` and the moon lanes
  are displaced.
- **CORRECTION 3 — the moon half was never aimed either; its tolerance is just
  wider than the defect.** `MOON_AIM_TOLERANCE_PX` is 16 and the defect is
  ≤10.4 px at fovX 22. The moon half still stands: no moon predicate or
  threshold was touched, and every reading it certified was taken on a disc
  whose mask it did cover. But "its lanes were aimed" in the stamp above is
  wrong, and after FIX-1 they are.

What each fix changed:

- **FIX-1 (root fix + mandatory instrumentation).** `setupScene` now aims
  through ONE `aimCamera(position, direction, up)` helper used by all three aim
  modes; it calls `setView` (which owns position + transform) and then writes
  the REQUESTED basis back into `camera.direction/up/right`. `setupMoonScene`
  carries the same repair. In the non-degenerate lanes the write-back is an
  identity, so **G1's `sunlit` and G1/G2/G3's `sirius` lanes are provably
  unchanged**; **G2's `sun-facing`/`anti-sun` glare lanes move by 3.4 px at
  their framing** (they were mis-aimed by the same 0.1745°). Instrumentation,
  reported every run whether or not it is needed: `aimDiagnostics`
  (requested vs HPR-round-trip vs applied direction, the residual in degrees
  read **before** the repair so the defect's own magnitude stays on the record,
  and `localVerticalSeparationDeg` — the `eps` whose √2 multiple IS the
  residual), plus `sunProjectionCropPx` (the ephemeris projection of
  `sunPositionWC` in the crop's own pixel coordinates) threaded into both sun
  measurements. `buildAimDiagnostic` + `describeAimMiss` turn that into a
  structural note that **discriminates**: ephemeris and measured light on the
  same spot ⇒ camera aim (instrument); apart ⇒ the Sun is not drawn where the
  ephemeris says (product). The halo lane's brightest-pixel search widened
  6→**64 px** (`HALO_AIM_SEARCH_RADIUS_PX`); the certifying bound stays 6.
  Batch 941's `11.7686` was the old 12-px search hitting its own wall — a
  floor, not a measurement.
- **FIX-2.** `PARITY_SCALAR_SOURCE_LANE` declares the sub-lane behind every
  parity scalar, `evaluateG4Backend` publishes `subLaneStructural`, and
  `foldG4Verdict` compares a scalar only when its source lane is non-structural
  on BOTH backends. Otherwise it reports `cross-backend:<key>_parity —
  STRUCTURAL: …  MEASURED ANYWAY: webgl …, webgpu …, relative spread …` — by
  name, never skipped. A scalar with no declared source lane is itself
  structural (it cannot be silently trusted). Non-finite on one side is
  structural too, not agreement.
- **FIX-3 — re-derivation, and the derivation is now the CAPTURE'S, not a
  constant.** The filing's premise needed sharpening: the relevant quantum is
  not `1/255` but the value of ONE 8-bit code step **at the pixel that produced
  the reading**, pushed back through the shipped `exposure → PBR-Neutral →
  gamma` chain — 3.8e-3 at code 128 and 3.3e-1 at code 250. Re-running the
  census offline against the run's own PNGs reproduces its numbers exactly
  (webgl 0.008876, webgpu 0.016449; `darkenedPixels` 8 and 4) and puts the peak
  pixels at codes `(230,231,227)` and `(236,237,232)` on the 1× leg, where one
  step is worth 0.009804 / 0.019237 — so **`peakDelta / quantum` is 0.91 and
  0.86: both readings are BELOW ONE QUANTUM.** Two independent confirmations
  that this was readback noise: the backends differ by 1.85× on a term resolved
  CPU-side before the backend branch, and the census counted pixels that got
  **darker** when earthshine was switched ON. New:
  `captureCodeQuantumLinear`, `chooseBracketLeg` (pinned by a validator against
  `stitchBracketLinear`'s own pick), `bracketQuantumAt`; `discDeltaCensus` now
  returns `peakIndex`; the bound is `max(3 × phase-scaled, 1.5 × quantum)`.
  **The 1.5 is capped from above, not chosen:** the bound must still reject the
  pre-C12-21 constant term (0.0348), which caps the factor at
  `0.0348 / 0.019237 = 1.81`. Rejection margins 2.37× (webgl) and 1.20×
  (webgpu). And the cap is enforced rather than assumed — if the instrument
  floor ever reaches the constant term's own amplitude the criterion reports
  **STRUCTURAL** ("a bound that cannot see its own target does not certify")
  instead of certifying a weaker one. A missing quantum is structural too.
- **FIX-4.** New `ARM_STATE.PENDING_AIM`; `evaluateLimbAbsoluteArm` takes
  `discLaneStructural` (injected by `evaluateG4Backend`, the only place that
  knows) and reports `STRUCTURAL-pending-aim` with the ratio still printed. A
  cross-backend arm-state difference caused by an aim gate is structural rather
  than a content-disagreement FAILURE; a real discriminator disagreement still
  fails. **The confound is now a NUMBER, not a hypothesis** —
  `expectedCompositeLimbRatio(model, {discRadiance, haloAmplitude,
  haloCoreRadii})` evaluates `[D·I(x) + H·P(x)] / [D·I(0) + H·P(0)]` from the
  shipped laws against the LIVE-resolved scalars, and is carried on
  `limbAbsolute.expectedComposite` in every arm state. At the shipped defaults
  (D = 2.0, H = 1.5, core = 4.278 R_sun) it gives **compositeRatio 0.73298** —
  within **2.6%** of Batch 941's measured 0.7138 on WebGPU — with the halo
  contributing **55.7%** of the signal at 0.95R and 42.9% at centre. **AND A
  SECOND FINDING FOR THE PACK: `discOnlyRatio = 0.56797`, i.e. the shipped limb
  law at x = 0.95 is ABOVE §5's 0.5 ceiling BEFORE any halo.** §5's `[0.3,0.5]`
  is satisfied at the EXTREME limb, where `I(1)/I(0) = a0 = 0.30` exactly. **§5's
  band is NOT moved here** — both numbers go to the maintainer with the
  radiance-tradeoff ask.
- **FIX-5.** Root retention was `data: Array.from(full.data)` — a plain JS
  `Array` of `1000·640·4 = 2,560,000` numbers, 20.5 MB per capture at 8 bytes
  an element, ×28 per backend ×2 = **1.15 GB held live to the end of the run**,
  because `runG4` captured BOTH backends fully before reducing anything.
  `runBackendLanes` now takes an optional `onLane` hook and nulls
  `lane.captures` after it; `runG4` writes each lane's PNGs and reduces it to
  scalars inside that hook, and `moonEpochMetrics` was split into
  `moonEpochLaneMetrics` (per lane) + `assembleMoonPhase` (scalars only), which
  is what made per-lane release possible. Peak retention drops to one lane's
  bracket (6 captures, ~123 MB) plus its stitched composites, ~15× under the
  default heap. Permanent sentinel `findRetainedImageBuffers` walks the report
  before serialization and `console.error`s any TypedArray or >4,096-element
  array, naming the path. **NOT taken, and recorded as the next lever if the
  rerun is still tight:** moving the capture transport from a JSON number array
  to base64 → `Uint8ClampedArray` would cut the per-capture footprint another
  8× (20.5 MB → 2.56 MB) and the CDP payload from ~10 MB to 3.4 MB, but it
  changes a function all four gates share and could not be validated here
  without a browser.

**Gates, all green, no allowlisting:** `node --test celestial-g4-gate.spec.mjs`
**82/82** (was 64; +18 covering all five fixes, with mutants — an ungated parity
fold, a below-quantum bound, a certifying limb read on a structural disc lane, a
retained capture, and the old 12-px aim cap); the celestial family +
`probe-fleet-contract.spec.mjs` **278/278**; `celestial-metrics` +
`celestial-uniform-offsets` + `moon-phase-terminator` + `moon-phase-gate` +
`sun-halo-composition` + `sun-hdr-radiance` + `hdr-display-default` **136/136**;
`prettier --check` clean; `eslint Tools/visual-regression/` clean; watchdog
(2,400 s in `--g4`) untouched.

⚠ **PRE-REGISTERED RERUN EXPECTATION.** Replaying Batch 941's OWN report through
the fixed lib (with the offline-derived quanta injected) is recorded here so the
rerun is scored against a prediction, not against hindsight:

1. **All seven reds clear**, and the AS-RUN pixels now fold to **exit 3
   STRUCTURAL, zero failures** — 2 inertness reds go GREEN, 2 limb reds become
   `STRUCTURAL-pending-aim`, 3 parity reds become STRUCTURAL-by-name.
2. **With the aim repaired the expected verdict is FAIL (exit 1), and the
   remaining reds are NEW and REAL**, not residue: `webgl:halo_tail_present_
   beyond_billboard`, `webgl:halo_tail_shape_is_lorentzian`,
   `webgl:halo_tail_slope_in_band` and `cross-backend:haloBandMean_parity`.
   Batch 941 measured `screenBandMean` **0.000295 (webgl) vs 0.051480
   (webgpu)** — a **175×** deficit — with webgl's shape samples reading
   `[0, 0, 0, 0.003]` against webgpu's `[0.1002, 0.0657, 0.0427, 0.0299]`,
   which match the shipped Lorentzian to 0.07%. That band is an annulus about
   the CROP CENTRE, so a 3.4 px aim error cannot explain it; the raw PNGs agree
   (webgl's 1× halo frame peaks at luminance 26/255 against webgpu's 253). **The
   C12-18 screen halo appears to be absent or ~175× weak on WebGL at the default
   framing** — a genuine cross-backend defect the structural aim was masking. If
   the rerun shows it, it is a C12-18 product row, not an instrument one.
3. **Both `limb_absoluteRatio_I095_over_I0_in_band` reds will RETURN as
   certifying failures** once the disc lane is non-structural (~0.71–0.73 vs
   `[0.3,0.5]`), by design: FIX-4 gates the read, it does not excuse it. The
   report will now carry `expectedComposite` so the red reads as the ratified-
   bar question it is.
4. The sun lanes should report `hprRoundTripResidualDeg ≈ 0.174`,
   `appliedResidualDeg ≈ 0`, `localVerticalSeparationDeg ≈ 0.123`, and
   `aim.ephemerisVsMeasuredPx` ≈ 0 with `measuredOffsetPx` inside tolerance.
   **If `appliedResidualDeg` is not ~0 the repair did not take; if
   `ephemerisVsMeasuredPx` is large the defect is the renderer, not the aim.**

### 2026-08-07 CO-27 gate-lane overlay (G4 lane construction — the LAST missing C12 gate lane)

Batch group **CO-27**, following the CO-3 / CO-24 house pattern.
**Instruments only — zero engine files touched.** Read this before any G4 claim.

- **G4 LANE EXISTS** (`node Tools/visual-regression/probe-celestial-gates.mjs --g4`),
  six sub-lanes per backend, and it must PASS IDENTICALLY ON BOTH — every term it
  measures is resolved CPU-side and published on `frameState` BEFORE the backend
  branch (`SunDiscAppearance`, `SunHaloAppearance`, `MoonPhaseAppearance`), which
  is precisely why a one-backend pass is a FAIL rather than a partial pass. New
  files: `lib/celestial-g4-gate.mjs` (pure metrics + measurement composition +
  verdict) and `celestial-g4-gate.spec.mjs` (**64 tests, 11 mutants**). **41
  bound predicates per backend** at this commit — 8 disc, 14 halo, 7 policy,
  6 earthshine, 4 terminator, 2 phase — plus the two gated arms (the C12-19
  pending arm and §5's reachability-gated full:quarter bar) and 8 cross-backend
  fold predicates (5 photometric scalars at 15%, 2 pixel counts at 40%, and the
  pending arm's state). All four C12 gate lanes now exist.
- **THE MEASUREMENT COMPOSITION LIVES IN THE LIB, NOT THE PROBE.** G2 and G3 keep
  `psfMetrics` / `glareMetrics` in the probe, where no `node --test` can reach
  them. G4's `measureDiscDifferential` and `measureHaloProfile` are exported from
  the gate lib and the spec runs them over SYNTHETIC frames built from the shipped
  laws — frames whose true disc radius, true size ratio, true tint and true band
  width are known in closed form. The probe keeps only capture, stitching and live
  state. Two defects were caught by that arrangement before any browser ran; both
  are recorded below.
- **SUN HALF — what is bound, and to what.**
  - **`C12-18` disc size.** `disc_angularDiameter_within_5pct_of_nominal`
    (§5's ratified 0.5334° ± 5%) **plus** `disc_angularDiameter_matches_ephemeris`
    (± 3% of `2·asin(SOLAR_RADIUS / |camera − sun|)` measured in the same frame —
    the honest reference, since 0.5334° is a mean and the real disc breathes
    ±1.7%), **plus the B906 regression pin `disc_trueSizeRatio_is_sqrt2`**:
    1.4142135 ± 5%, measured at PIXELS as the ratio of the two edges the
    `enableTrueSolarDiscSize` toggle produces. A regression to a single edge reads
    1.000, which is 29% away; the pixel-quantization bound on the pair is 1.4%.
  - **`C12-15` limb darkening — PRESENCE AND SHAPE, by a differential.** The OFF
    position passes `(a0,a1,a2) = (1,0,0)`, i.e. `I ≡ 1`, so `flat − limb` is
    exactly `(1 − I(x)) · discContribution` and the C12-18 screen halo — a
    function of screen geometry alone, identical in both legs — **CANCELS
    EXACTLY**. Same trick G1 Lane B uses on the sky-atmosphere shell. Four
    predicates: a measurable drop at `x = 0.95`, a shape match against the
    SHIPPED `solarLimbIntensity` (≤ 20% max relative deviation; a LINEAR limb law
    is rejected at four of five samples), and vanishing at disc centre and
    outside the disc (which is what rejects a "limb darkening as an overall
    multiplier" mutant).
  - **`C12-16`/`C12-18` halo.** Measured between **16 and 30 R_sun** — past the
    billboard's own corner at `sqrt(2)·11 = 15.56 R_sun`, so nothing baked (disc,
    halo, or lens-flare burst) can reach the band, and the BAKE leg is the
    positive control that the band is EMPTY without the post-process chain.
    Shape against `solarScreenHaloProfile` (≤ 25%; a Gaussian halo is rejected at
    three of four samples), tail slope in [−2.5, −1.3] (the shipped value is
    −1.922, and the band deliberately EXCLUDES the star PSF's −4 Moffat wing —
    G2 and G4 measure two different laws). The **one-halo-source invariant is
    read LIVE** off `frameState.sunHalo` as an exhaustive truth table
    (`screenHalo ⟹ bakeHaloGain === 0 ∧ haloIntensity > 0`;
    `¬screenHalo ⟹ bakeHaloGain === 1 ∧ haloIntensity === 0`), so both the
    DOUBLE-halo and the NO-halo failure modes are named criteria.
    **`halo_deltaPeak_at_11_Rsun` carries B906's derivation itself**, swept over
    the shipped module at 0.005 R_sun: the peak sits at **exactly 11.0** because
    that is where the pedestal-subtracted bake reaches 0 while the screen profile
    is still 0.1314. A displaced halo core moves it and is rejected.
  - **Eclipse alpha chain.** `sunVisibleFraction`, `sunEclipseAlpha` and
    `sunHalo.eclipseFactor` are asserted **exactly 1** on the sunlit side — the
    identity claim, not a tolerance (0.999999 fails).
  - **`C12-28` SDR leg, made non-vacuous.** The row itself records that the SDR
    readings "would pass identically with the feature reverted". The lane adds a
    **LIVE POSITIVE CONTROL**: it forces `Scene._hdrDisplayIsHdr = true`, re-runs
    the shipped `_applyHdrDisplayDefault()`, requires the flag to FLIP, then
    restores the real detection and requires it to flip BACK and to leave the
    user-set flags untouched. It runs FIRST, before any capture pins the HDR flag
    as user-set. An HDR display makes the leg STRUCTURAL (that is the row's OWED
    manual hardware check), never a failure.
- **MOON HALF — this lane IS `C12-21`'s and `C12-22`'s owed Edge acceptance.**
  Three epochs solved in-page with the moon-appearance demo's own
  `findTimeForPhase` over its own window (`2026-07-01`, 32 days), at the demo's
  own targets 0.12 / 0.5 — with the FULL target raised to 1.0 because the demo's
  0.98 framing sits 16.3° from opposition, where the shipped surge contributes
  3.5%. Framing is `probe-moon-lola-relief.mjs`'s standoff (2.0e7 m) at
  **fovX 22°**, which is what makes the C12-22 band 2.7 px wide instead of 1.0.
  **The moon is NOT resized and libration/angular size are untouched** (explicit
  non-goals, `C12-30`). Ten predicates; see the `C12-21` and `C12-22` rows.
- ⚠ **TWO INSTRUMENT DEFECTS CAUGHT BY THE SPEC BEFORE ANY BROWSER RAN.** Both
  are the vacuity class this repo keeps paying for, and both are recorded rather
  than quietly fixed:
  1. **The full-moon inertness criterion could not be evaluated on the unlit-limb
     mask** — at full moon that mask is EMPTY by geometry and its median is NaN,
     so a HEALTHY renderer would have scored red. It is now censused over the
     WHOLE DISC on `peakDelta`, which is always defined and strictly stronger.
  2. **`profileAt(profile, 0)` reads NaN at the disc centre.** Aiming a camera at
     a source puts it at NDC (0,0), which for an even-sized crop is a pixel
     CORNER, so the radius-0 bin is empty — the same trap
     `C12-STAR-POINT-CENSUS-LIVE-CALIBRATION` root-caused in the sibling
     detector. The NaN would have propagated into the pending arm's measured
     ratio and made every band comparison false, i.e. the arm would have looked
     like it had measured something when it had not. The centre value is now an
     annulus mean.
  A third distinction is deliberate rather than a repair: a limb differential
  with **no signal at all** is reported as a named FAILURE
  (`limb_differential_has_signal`), not as blindness, because the reference leg
  is a flat disc that always renders — filing the headline C12-15 defect under
  "could not see its subject" is exactly the scope error the Batch-859 repair was
  itself caught making. Blindness keeps its own separate guard on the SHIPPED
  leg's lit-pixel count.
- ⚠ **ONE CRITERION IS A PENDING ARM, AND IT REPORTS ITSELF BY NAME.** §5's
  `I(0.95R)/I(0) ∈ [0.3,0.5]` is not measurable as an ABSOLUTE ratio until
  **`C12-19`** removes the `clamp(...,0,1)` from both sun bakes — `SunTextureFS.glsl`
  says so in its own comment ("with the 0..1 clamp in place, limb darkening is
  arithmetically invisible in the default bake"), and after C12-18 what sits over
  the disc is a 0.75-amplitude screen veil the absolute ratio cannot be separated
  from without modelling it away. The arm is neither failed nor skipped: it
  self-activates from **two independent live discriminators** — the served bake's
  clamp text, and the measured peak disc radiance against a bound the clamped
  build cannot exceed (`1.0 + SOLAR_HALO_AMPLITUDE = 1.75`, bar 4.0) — reports
  `STRUCTURAL-pending-content:C12-19` in its own printed block, and MEASURES and
  prints the ratio every run so the number is on the record before the content
  lands. **A DISAGREEMENT between the two discriminators is STRUCTURAL, not a
  guess**, and an arm resolving differently on the two backends is a cross-backend
  FAIL. The spec's own source anchor fails if the bake's clamp text moves for any
  reason other than C12-19 landing, so the arm cannot silently activate.
- ⚠ **§5's MOON HEADLINE IS REACHABILITY-GATED, and that is a finding.** The
  `C12-20` row states the >3:1 bar "is exceeded by LS + `C12-23` surge TOGETHER
  (≈4.2:1) — gate the pair, not LS alone". The shipped surge is
  `1 + 0.6/(1 + tan(α/2)/0.00873)`, which contributes ≥10% only within **α ≤ 5.0°**
  of opposition (the spec derives that bound from the shipped constants, not from
  a run). Outside it the criterion would be measuring Lommel-Seeliger alone —
  ~2.65:1 by the same row, BELOW the bar — for a reason that is epoch selection,
  not product behaviour. So the arm certifies when `α ≤ 5.0°` and otherwise
  reports STRUCTURAL **with the measured ratio printed**. A REACHABLE epoch below
  the bar is still a FAIL; the gate is not toothless. The always-certifying
  fallback is the phase ORDERING (full > quarter > crescent at ≥ 1.3× each),
  which holds under every disc law this campaign has shipped and rejects a
  phase-INDEPENDENT disc — the C11-176b blackout's inverse.
- **BINDING GATES, all green:** `node --test celestial-g4-gate.spec.mjs` **64/64**;
  the celestial family + `probe-fleet-contract.spec.mjs` +
  `moon-phase-terminator.spec.mjs` + `sun-halo-composition.spec.mjs` +
  `hdr-display-default.spec.mjs` **364/364**; `prettier --check` clean; `eslint`
  clean per file. **No allowlist entry was added or needed** — the lane lives
  inside the existing `probe-celestial-gates.mjs`, which already satisfies the
  fleet contract. One sibling assertion was relaxed *in form only*:
  `celestial-g2-gate.spec.mjs`'s watchdog test pinned the whole `HARD_LIMIT_MS`
  ternary and therefore broke when a fourth arm was added; it now pins
  `G2 ? 1200000 : 600000` per-arm, so **both G2 budgets remain pinned at exactly
  their previous values**.
- **OWED — Edge acceptance, none of it has executed:**
  `node Tools/visual-regression/probe-celestial-gates.mjs --g4` (first G4 run
  ever). **Pre-registered expectation: exit 3 (STRUCTURAL), not 0 and not 1** —
  the C12-19 pending arm is expected `STRUCTURAL-pending-content` on both
  backends, and §5's full:quarter arm is expected structural-unreachable unless
  the phase search lands inside 5° of opposition. Every OTHER predicate is
  expected GREEN on both backends; **any red among them is news**, and the two
  most likely are `disc_angularDiameter_matches_ephemeris` (if the ALPHA_BLEND
  chain B906 landed puts the disc edge somewhere other than where the bake says)
  and `terminator_band_exists` (if the real lunar albedo puts the 1.6e-3 delta
  under the census epsilon even at 64×). A STRUCTURAL exit for any OTHER reason
  means a control did not come back — a blank sun frame, a mis-projected lunar
  centre, an SDR positive control that did not flip, or a phase search that
  missed its target — and is NOT a product verdict. Watchdog 2,400 s in `--g4`
  mode; the run pays **seven settled setups and 28 settled captures per backend**
  (disc 3 legs × 2 exposures, halo 2 × 2, three moon epochs 2 × 2, terminator
  2 × 3), each preceded by a discarded warm-up capture.

---

## 3. Split — C11 tail vs C12

**These belong in C11's W9 tail, not here.** One-line defaults and comment corrections with an existing P1 home; they should not wait for a new campaign. **⚠ 2026-07-23: that home does not exist — no `C11-176b`/`C11-176c` rows were ever appended to the C11 queue, and C11 is now PAUSED, so as filed these WILL wait indefinitely, defeating the rationale. Decision at C12 launch (LD-2): pull them in as C12 W1 riders, IDs retained (recommended — `C11-176b` is open in code at HEAD (`Moon.wgsl:345-346`), gates `C12-21`/`C12-22` per the research dep table (`CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md:353-354`), and edits the same `Moon.wgsl` phase region W5 touches, so landing it BEFORE `C12-20..23` re-baselines the Batch-517 crescent probe once, not twice; Batch 730 already discharged the `LICENSE.md:1042` dead-URL bullet of `C11-176c`) — or explicitly accept they sleep until C11 resumes.**

| ID | Item | Effort |
|---|---|---|
| `C11-176b` | **Moon `phaseGate` deletion** (`Moon.wgsl:345-346`) — **the same class of bug as the skybox fade**: `enableMoonPhase` defaults **true**, and `phaseFraction`/`earthshine` appear in **no GLSL file**. It is also a physical double-count — N·L against the real Simon1994 sun direction already yields the correct terminator and phase, while the extra `smoothstep(0,0.3,phaseFraction)` additionally blacks out real crescents. ✅ **IMPLEMENTATION DONE (worker, 2026-07-24) — pending orchestrator landing + Edge run** of new `probe-moon-phase-gate.mjs` + `moon-phase-gate.spec.mjs`; full status in the C11 queue row + `WEBGPU_DEBUGGING_LOG.md`. Batch-517 re-baseline turned out UNNEEDED (its crescent lane's illumFrac ≈0.43 > 0.3 ⇒ old gate exactly 1.0 there ⇒ deletion byte-identical; Edge re-run = no-drift confirmation). ✅ **LANDED Batch 755 (`9974c59179` "C11-176b delete the moon phaseGate double-count"), Edge artifact passes** — see the overlay at the top of this queue. **Status re-verified at HEAD 2026-08-06 by the C12-21/C12-22 worker, and the recorded premise that this row is still OPEN and must "land first" is REFUTED:** the gate is already gone (`Moon.wgsl` carries the deletion rationale as a comment, `Tools/visual-regression/moon-phase-gate.spec.mjs` pins its absence, and `phaseFraction` survives in code exactly once — the UB declaration). The dep `C12-21`/`C12-22` carry is therefore **DISCHARGED, not pending**; the phase terms cannot compound because C12-21 introduces no shader-side `phaseFraction` term at all (the Earth-phase complement is resolved on the CPU and arrives as its own uniform). No code change was needed for this row; only this status correction. | XS + re-baseline (both discharged) |
| `C11-176c` | **Stale-comment corrections** that actively mislead diagnosis: four comments asserting a float target + bloom that are **off by default** (`StarField.wgsl:14-16,145-146`, `StarFieldFS.glsl:23-24`, `StarFieldMath.ts:118-119`); `StarField.js:63` says "~0.34°" for `0.0042` rad (actual **0.2406°**); `SkyBox.js:49-55` (phrase at :52) calls StarField "an inert no-op" on WebGL, falsified by the WebGL twin at `Renderer/Context.js:766-789`. *(The `LICENSE.md:1042` dead-URL sub-item was discharged by Batch 730 — live URLs at `LICENSE.md:1034-1035`, the dead JPL URL kept as a provenance note at `:1036`.)* | XS |
| `C11-SEED-07` | Fold `NEW-SUN-MOON-FIDELITY` into `C11-179` — duplicate scope. | XS |

---

## 4. Waves

### W1 — Foundation and measurement (nothing visual ships; everything depends on it)

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-01` | **Celestial gate harness** — implement metrics M1/M2/M2e/M3/M6 on the existing probe scene; emit the 14-field manifest; baseline both backends for all four gates. **ABSORBS `C11-176a`** (never appended to the C11 queue — research-doc row only, `CELESTIAL_APPEARANCE_RESEARCH_2026-07-19.md:297`). Already landed de facto in `probe-skybox-star-modulation.mjs` (Batches 722/724): sunlit-side + night cameras, default-pair assertion, RMS-contrast + top-0.1% metrics. Still missing and owed here: M1 source census, M2e sky floor, wiring `brightPct` + the default-pair assertion into `probe-env-skybox-stars.mjs` (camera there is still NOT sun-relative, `:83-86`; `brightPct` computed at `:154` but absent from pass criteria `:293-300`), and HARD exit-code gating (`probe-skybox-star-modulation.mjs:267` exits 0 unconditionally, even on GATE FAIL). | M | ✅ **LANDED Batch 745** — `celestial-metrics.mjs` (M1-M5 pure lib, 12/12 synthetic trust-anchor spec) + `probe-celestial-gates.mjs` (M6 splits, 14-field manifest, hard exit codes, all Batch-744 probe rules) + `probe-env-skybox-stars` retrofits. **FIRST G1 RUN = RED, and the instrument is right:** default pair healthy (M1 54/53=0.981, m2b 1.023, m3 1.007) but (1) `cubemap-only` split shows **WebGL 55 vs WebGPU 0 sources — `starField.show=false` kills the ENTIRE sky on WebGPU** (binned-copy/skybox-injection coupling, `Scene.js:3740-3765` region) → filed `C12-G1F1`; (2) default-pair RMS-contrast ratio **1.488** out of band → filed `C12-G1F2` (diagnose). G1 goes green when both are fixed — do NOT tune the gate. ⚠ **THE TWO SIBLING PROBES THIS ROW RETROFITTED WERE REPAIRED 2026-08-07** (both filed under `NEW-PROBE-VACUOUS-REACHABILITY-ASSERTION`; see the RESOLVED entries in `DEFERRED_WORK.md`). **`probe-env-skybox-stars.mjs` — BLOCKING false green, closed.** Its `framingReached` asserted `sunElevationDeg >= 25` — the exact proxy Batch 859 deleted next door — over the same `5.0e7` m camera, where `skyBrightness` is identically 0 and the C11-176 modulation factor is exactly 1.0 at ANY solar elevation; it was a `pass` conjunct and the probe had **no structural tier**, so a scene that cannot host the subject reported a certifying exit 0. Now: the proxy conjunct is gone from `pass`; `starModulationReachable` names the driving variable (`skyBrightness > 0.5`, read from BOTH backends' gated frames) and is REPORTED with a "do not cite this run about star modulation" banner; the `sunlit` lane is relabelled **sun-aligned orbital** for the default-pair cube-map + sprite parity it genuinely certifies; and a structural tier (exit 3) fires when the WebGL REFERENCE produced no signal — `rat()` returns 0 on a zero denominator and `pearson` returns 0 on a flat grid, so a blank reference would otherwise score as a confident FAIL. **No fitted floor was invented: every bound in the new tier is zero**, and `correlate` now returns `varianceA`/`varianceB` to make the degenerate case observable. **`probe-skybox-star-modulation.mjs` — INVERTED gate + A/A control, closed.** Its `optInOk` (`gpuOn.meanLum / gpuDefault.meanLum < 0.85`) could never be satisfied for TWO independent reasons — `AtmosphericConditions.js:616` now ships the flag TRUE so the ON leg was A/A against the default, and the `5.0e7` m camera pins `skyBrightness` to 0 so no leg can dim at all — and the probe emitted `FAIL … optIn:false` at exit 1 over a scene the engine deliberately exempts. `reachedFailingState` already named the right variable but was in neither `GATE` nor `structural`, so it could not route the run anywhere. Now: the opt-in arm compares the EXPLICITLY-ON leg against the EXPLICITLY-OFF leg (no dependence on a default that has already flipped once), `causationProven` is re-pointed the same way and returns `null` rather than `false` when unreachable, `defaultMatchesExplicitOn` records the default's identity as a separate REPORTED fact, and the gate is three-tiered with `foldG1Verdict`'s precedence — a measurable parity failure outranks blindness, blindness outranks a clean sheet — so an unreachable run now **exits 3 STRUCTURAL, not 1**. `predictedDimFactor` no longer restates `(inflection 0.5, steepness 1.0)`: it reads the shipped curve off the panorama's own `_starModulation` uniform. **Three stale header citations corrected and one premise reversed:** the default is `AtmosphericConditions.js:616` (not `:368`); the `=== true` fail-safe is `CubeMapPanorama.js:511-514` and ANDs a THIRD conjunct, `frameState.skyAtmosphereVisible === true`; the constants are `STAR_MODULATION_INFLECTION = 0.0` / `STEEPNESS = 23.0` (`StarFieldMath.ts:439,442`), so at `skyBrightness = 1` the factor is exactly **0** — the whole star contribution, not "a 50% dim"; and **`SkyBoxFS.glsl` now carries the same term** (C12-29 S6 / ruling E3), so "WebGL has NO such term" is no longer true and "default ON is a parity break" is no longer the claim. **NOT done, filed as the remaining step:** moving this probe's camera INSIDE the atmospheric column so it can certify the subject itself. Until then the C11-176 subject is owned solely by `probe-celestial-gates.mjs`'s `in-column-star-modulation` lane, and this probe will legitimately exit 3.  ★ **FIRST REAL EXERCISE OF THE REPAIRED IN-COLUMN LANE — Edge, 2026-08-07 at `1c3778072d` (Batch 873). Verdict FAIL, and the headline reading is WRONG in both directions.** Lane B reached its subject (`skyBrightness` exactly 1.0 and `skyAtmosphereVisible` true on BOTH backends — the repair works) and reported `glModulationEngaged: true`, `gpuModulationEngaged: false`, `starEnergyRatio 0.794`. **(1) "WebGPU's modulation is dead" is a THRESHOLD ARTIFACT.** The energies are WebGL 3.1026e-4 and WebGPU 2.4645e-4 against a bar of `srgbToLinear(1/255)` = 3.0349e-4 — WebGL clears it by 2.2%, WebGPU misses it by 19%. Both terms are LIVE; the boolean split landed between them. **(2) The 0.794 is NOT the star modulation at all.** Root-caused to the pixel offline from the committed PNGs: the star cube map renders **bit-identically** on both backends at the orbital camera (mean sumRGB 6.5282 both), the in-column frames agree to 4 dp over `x < 840`, and they diverge only in the anti-solar band `x ≥ 850`, where WebGL's capture is **bit-identical to the no-atmosphere reference** (transmission exactly 1.000) while WebGPU's is 0.30–0.50. The sky-atmosphere shell's emitted COLOUR is identical there (both `(0,0,0)`, and the modulation-ON legs agree to 3e-7); only its **ALPHA** differs — which is invisible over the black backgrounds every prior celestial gate used, and Lane B is the first instrument in the fleet to put non-black content behind the shell. The boundary is a fixed-distance clip (`sin α · cos β` constant to 0.7% across the frame height, solving to ≈4.13e6 m), NOT a day/night terminator (excluded: the terminator sits at 134.4° from the Sun and the frame only spans to 114.3°). Filed as `NEW-WEBGPU-SKYATMOSPHERE-SHELL-EXTENT-ALPHA` in `DEFERRED_WORK.md` + `WEBGPU_DEBUGGING_LOG.md`; deliberately NOT "fixed by making WebGPU match", because that would encode a WebGL far-plane clip as the contract without establishing which coverage is canonical — that needs a browser frustum measurement. **Until that row is decided, `starEnergyRatio` in this lane measures the shell's alpha, not the modulation term, and the lane's FAIL must not be re-attributed to C11-176.** The star-modulation packing was audited byte by byte and is CORRECT on both backends; it is now pinned offset-by-offset by `Tools/visual-regression/celestial-uniform-offsets.spec.mjs` (5/5, three offset mutants rejected). **Lane A censused 0 sources in all three modes on both backends and correctly reported STRUCTURAL** — see the C12-27 row for the attribution (C12-11 / DR-01 made the default cube map diffuse-only at Batch 833; the M1 bar is a pre-DR-01 calibration). **OWED on this row: re-scope Lane A's star thresholds for the DR-01 sprite-only world, exactly as Batch 848 did for `probe-stars-catalog.mjs`.** |
| `C12-02` | **Exposure-bracket capture** (1×/8×/64× stitch). **An 8-bit readback cannot measure a halo to 1e-3 of peak — the halo is exactly what the current capture discards.** Required by every PSF gate. | M | ✅ **LANDED Batch 745** — `--bracket` mode (1×/8×/64×, HDR-lane recorded in manifest, per-pixel unclipped stitch ≈4 decades); M4/M5 wired as DIAGNOSTIC until G2/G4 bind them (per wave structure). Off-browser stitch smoke recovered a Moffat composite at M4 ratio 9.27. |
| `C12-03` | **Adapter provenance — COMPLETE 2026-07-28 (`C11-175` alias discharged).** `powerPreference:"high-performance"` was already the WebGPU default. Every performance-run record now carries one structured `gpuProvenance` object containing the resolved backend, `context.getRendererString()`, and WebGPU `adapter.info`; a run cannot PASS when its backend-specific physical-GPU identity is absent. Node coverage is `performance-workloads.spec.mjs` (**24/24 PASS**). Browser smoke `output/performance/adapter-provenance-smoke.json` passes both backends and identifies WebGL as **ANGLE / NVIDIA GeForce GTX 1080 Ti / D3D11** while WebGPU reports **vendor `nvidia`, architecture `pascal`, subgroup 32..128**. This does not assert that opaque WebGPU device IDs will always be exposed; it records every field the browser provides and requires at least one adapter identity field. | XS | ✅ complete |
| `C12-04` | **Sequencing audit vs `C11-79`/`C11-80`** (starfield single-submission retains star commands). C12 edits the same renderer; confirm no conflict. ✅ LD-1 ANSWERED (2026-07-23): `C11-79`/`C11-80` TRANSFERRED into C12 — this row now sequences them (audit first, then C11-80 → C11-79 → the W2 renderer edits). | XS | LD-1 (answered) |
| `C12-G1F1` | **NEW-WEBGPU-ENV-PASS-DROP (WIDENED; originally NEW-WEBGPU-CUBEMAP-ONLY-SKY-BLACK, found by G1's first run, Batch 745):** with `skyBox.show=true, starField.show=false`, WebGPU renders NO sky at all (M1: WebGL 55 vs WebGPU 0) while the default pair renders 53. **WIDENED at Batch 756** by new evidence from `probe-moon-atmosphere-appearance`: in the no-atmosphere control scene (atmosphere/skybox/sun/globe off, starField at its DEFAULT visible) the WebGPU moon rendered ZERO pixels in day-mid + horizon but rendered fine at night-full (litFrac 0.97) — recorded as `BLOCKED-C12-G1F1-FAMILY` markers. **ROOT-CAUSED + FIXED — implementation done, pending landing (2026-07-24).** *Mechanism (one cause, both manifestations):* WebGPU cannot execute environment commands outside a render pass, so `SceneRenderer.js:336-338` injects them into the FARTHEST frustum and skips entirely when `frustumCommandsList.length === 0`; `WebGPUSceneRenderer.ts:1591` then drops the frame. Frustum count comes from `View.createPotentiallyVisibleSet` → near/far accumulated over `frameState.commandList`, and **only SkyAtmosphere (`SkyAtmosphere.js:322`), Sun (`Sun.js:188-190`) and StarField (`StarField.js:242-247`) ever push a binned copy** — StarField only while `computeStarDayFade` ≠ 0 (`StarFieldMath.ts:243-270` returns exactly 0 once the sun is ≳3° up below 100 km). SkyBox is inject-only; Moon hides itself behind a scratch command list (`Moon.js:324-328`). With no other geometry the accumulators stay at their `±MAX_VALUE` sentinels, the C10-01 sky-only fallback (`View.js:412`, keyed on `sawEnvironmentNoBV` = *a BV-less env command was seen in commandList*) does not fire, `updateFrustums` collapses `near === far` → **0 frustums → black canvas**. That is why day differed from night in the Batch-756 evidence: at night the star field still emitted a binned copy; in daylight it self-muted and the moon went with it. *Fix (shared-predicate altitude, no per-element workaround, no `isWebGPU` branch):* new `Scene/EnvironmentFrustumDemand.ts` — `hasInjectedEnvironmentContent(scene)` (mirrors the injector's own `defined(cmd) && typeof cmd.execute === "function"` test over skyBox/starField/atmosphere/sun/moon/panoramas, gated on `_alternateSceneRenderer` + `passes.render`) + `needsEnvironmentOnlyFrustum(near, far, sawEnvironmentNoBV, scene)` consumed at `View.js:412`. Byte-identical for WebGL, for pick/offscreen frames, and for every frame that already has geometry (`near > far` short-circuits first). Principle 7 checked: `git log -S sawEnvironmentNoBV` → single origin `b156079da8` (Batch 693 C10-01) — the same mechanism, WIDENED not replaced; StarField's binned copy is KEPT (it is the only sprite draw when no cubemap exists). *Net:* new `probe-env-pass-matrix.mjs` (11 cells × 2 Simon1994-derived lanes, per-element presence parity + the night source-ordering contract) + `env-frustum-demand.spec.mjs` (11 node tests, full 2^6 subset matrix) + `EnvironmentFrustumDemandSpec.js` + `env-matrix-shape.spec.mjs` (9 synthetic detector anchors). **Orchestrator PRE-fix run (2026-07-24) confirmed the mechanism** — night `skybox-only`/`moon-only`/`skybox+moon` and day `moon-only`/`skybox+moon` all reproduced `webgl=true, webgpu=false` on the moon element — and surfaced probe defect **D1**: the moon detector used ABSOLUTE ROI luminance and false-positived on the WebGL reference in `day skybox-only`/`day skybox+starfield`, because the TYCHO_T5 skybox (Batch-742 default) puts bright Milky Way pixels inside the 3° ROI; the probe's own reference-disagreement guard caught it (exit 2 instead of RED exit 1). Moon detector rebuilt SHAPE-based (ring-annulus background distribution → lit threshold `max(ringP99+20, ringMean+25, 30)` → largest contiguous 4-connected lit component + ring-lit-fraction ratio); the atmosphere predicate gained a median arm; the star census was audited and left unchanged (already background-relative). Synthetic anchors prove absolute luminance fails BOTH ways for the moon: no-body-plus-band gives a +37 disc/ring mean step, a real daylight crescent reads ~20 LSB DARKER than its ring. **Second PRE run (2026-07-24)** confirmed all six defect cells and surfaced probe defect **D2**: the ring-relative bar INVERTS on the sun — its glare floods its own annulus, `ringP99` saturates, the bar rises above the disc and `litFrac` collapses to ~0, so `day sun-only` read gl=false/gpu=true (WebGL alpha-blended sun under the self-raised bar; WebGPU additive saturating to 255 and clearing it — an instrument defeating itself, not a renderer divergence). Sun predicate now uses NO ring-derived threshold: fixed bar 180 plus the scale-free `discMean ≥ ringMean+20 && discMax ≥ 200 && absLitFrac ≥ 0.10 && absMaxComponentFrac ≥ 0.5`. The asymmetry is principled — the sun is the brightest object in any scene (a fixed floor has no false-negative mode); the moon is not (D1). `env-matrix-shape.spec.mjs` covers an alpha-blended sun under a radially-falling glare halo (ring bar 239 > discMean 227.8, ring-relative litFrac 0.099, new arms all hold) and a bright-flat-sky non-leak case (absLitFrac 1.0 but mean step −0.02 → correctly ABSENT). **Third PRE run** cleared the sun and listed the five moon/stars cells RED, leaving probe defect **D3**: the night source contract demanded `spritesOnly ≥ 3` but WebGL's own catalog star field registers only **2** census points at this vantage (at default brightness the Yale-catalog sprites sit below `pointThreshold = median+25` — known t3/t5 behavior, expected). Contract recalibrated to what the reference supports and extracted as the pure `evaluateNightSourceContract`: reference sanity (structural) = `webgl.cubemapOnly ≥ 200 && webgl.both ≥ webgl.cubemapOnly`; gate (exit 1) = `webgpu/webgl cubemapOnly ≥ 0.5` (**pre-fix 0** — WebGPU 0 vs WebGL 1094 — post-fix ~1); `spritesOnly` recorded informationally with NO ok arm (the sprite path stays gated by the per-cell `starfield-only`/`skybox+starfield` presence rows). Spec now 15 cases, pinning the measured pre-fix pair, the expected post-fix pair, a partial-recovery reject (0.27 < 0.5), a `spritesOnly` sweep that must never move `referenceOk`, and broken-reference → structural. **Fourth PRE run** left two last instrument defects, both parity-intact: **E1** `night/starfield-only` asserted stars=true but WebGL censuses only ~2 sprite points at default brightness — fixed in the CELL (`starField.intensity = 40` there only; a public backend-neutral knob both renderers consume via the same `_effectiveIntensityScale`, default captured once and restored by every other cell, droppable when the star-brightness default-flip lands); **E2** `night/atmosphere-only` asserted stars=false but both backends read true — `SkyAtmosphere.wgsl` draws NO point sources (its only "star" hits are the demo name "Star Burst"), so the home-grown census was at fault: it had no prominence arm and counted the twilight gradient's dither. Census replaced with the fleet's trust-anchored `m1PointSourceCensus` algorithm (annulus-median background, `v−bg ≥ 12`, `v ≥ 1.6·bg`), pinned by synthetic anchors (lit dithered sky → 0 sources at levels 30/60/120; 25 planted stars → 25/25 on black and over a lit sky). Spec now 18 anchors across four extractable regions. **All four probe defects (D1/D2/D3/E1+E2) were caught by the same guard — reference disagreement is STRUCTURAL, never a gate failure** — which is what kept every one of them from being mistaken for a WebGPU parity bug and buying a speculative engine fix. The Batch-756 soft-gate was DELETED from `probe-moon-atmosphere-appearance.mjs` — `controlSane`/`extinctionDims` gate hard again. Unblocks the G1 cubemap-only split. | S | — |
| `C12-G1F2` | ✅ **ATTRIBUTED — the row's premise was void; the real finding was in the metric's construction. Instrument repair LANDED; the re-measure this row's own Deps column requires is STILL OWED.** *Original filing:* "G1 default-pair RMS-contrast divergence 1.488 (band [0.85,1.15]) — DIAGNOSE-FIRST. M1/m2b/m3 all in band, so this is contrast-specific; earlier star-modulation runs at a similar view measured stddev ratio 1.045. Attribute before fixing (sprite AA? capture timing? a real shading divergence)." ⛔ **THE 1.045 COMPARISON IS STRUCK — it is not the same quantity as the 1.488 and never was.** `m2aRatio` (`probe-celestial-gates.mjs`) and `gpuOverGl_stddev` (`probe-skybox-star-modulation.mjs`) differ on **four independent axes**, any one of which disqualifies the comparison: (1) m2a is RMS *contrast*, i.e. sigma **divided by mu**; the star-modulation figure is a bare sigma; (2) m2a measures **sRGB-decoded linear luminance**; the other measures **raw 8-bit code values**; (3) m2a reads a **1000×640 crop of a bare star field** (globe/sun/moon/atmosphere all off); the other reads the **whole canvas of a scene that still renders sun + moon + skyAtmosphere**; (4) `computeAtmosphericColumnFactor` (Batch 770, `0679b0e456`) **redefined the driving quantity between the two runs**. *Current state:* 1.488 no longer reproduces — `output/celestial-g1.json` reads `m2aRatio: 1`, `default_m2a_in_band: true`. The move itself is UNATTRIBUTED with a named three-point bisect; see the corrected attribution block in the `C12-31` cell. ⚠ **FOUR INSTRUMENT DEFECTS FOUND AND FIXED (2026-08-06):** (1) **m2a was unattributable by construction** — it is a ratio of ratios, and neither factor reached the printed summary, so a failure could not be split between a mean/pedestal shift and a sigma excess. `meanLumRatio` and a new `stddevRatio` now travel with it in every mode; that single omission is the entire reason this row existed. (2) **M2e, the pedestal discriminator, was computed, reported and gated by nothing.** It now certifies, **absolutely rather than as a ratio**: `abs(skyFloor_gpu − skyFloor_gl) <= srgbToLinear(1/255) ≈ 3.04e-4`, a bound derived from 8-bit quantization and explicitly not from any measured value. (3) **G1 WAS VACUOUS FOR ITS OWN HEADLINE DEFECT.** `framingReached` asserted `sunElevationDeg >= 25`, a PROXY; the star-modulation term is driven by `frameState.skyBrightness`, which is identically 0 at G1's camera for **two independent reasons** — the camera sits at 5.0e7 m (height ~43,600 km), far above `ATMOSPHERIC_COLUMN_FADE_END = 111000.0` (`SkyBrightness.js:60`, applied at `:563`), and `CubeMapPanorama.js:433` additionally gates the whole term on `frameState.skyAtmosphereVisible === true` while G1 sets `skyAtmosphere.show = false`. Both recorded runs confirm it (`skyBrightness {webgl:0, webgpu:0}` at `sunElevationDeg: 90`), and `AtmosphericConditions.js` states the first as DESIGN ("that camera gets factor 1.0 and is byte-identical to today"). `framingReached` now asserts `skyBrightness > 0.5` — `probe-skybox-star-modulation.mjs`'s own predicate — and a **second lane inside the atmospheric column** (30 km, `skyAtmosphere.show = true`, `enableStarBrightnessModulation` OFF/ON A/B) genuinely exercises the C11-176 path; the orbital lane is retained and renamed `orbital-cubemap-parity` for what it actually measures. A lane that cannot see its subject now exits **3 (STRUCTURAL)**, never 0 and never 1. (4) **Capture ordering and settle were structurally deficient** — a 32-**frame** settle (~530 ms) against a measured 2674 ms async pipeline compile, no discarded warm-up capture, and a fixed mode order that always captured the only certifying mode (`default`) FIRST against the coldest cache while its siblings inherited a warm one — the same ordered-contamination shape found in the weather-probe fleet, biased in the direction the gate scored. Now a ≥3000 ms wall-clock readiness budget with `setTimeout` yields, a discarded warm-up capture per mode, and `G1_MODE_CAPTURE_ORDER = [cubemap-only, sprites-only, default]`. *Guard:* new `Tools/visual-regression/lib/celestial-g1-gate.mjs` (pure verdict logic, browser-free) + `celestial-g1-gate.spec.mjs` — 40 node tests, 25 rules run against the real implementation and **15 adversarial mutants** (M2e as a ratio / loosened to two code values / fitted to a measurement / reported-not-gated; `framingReached` on the elevation proxy / satisfied by either backend / absent-treated-as-reached; structural reported as PASS and as FAIL; no non-vacuity control; ON-state-ratio-only certification; blind mode scored as a defect; summary omitting the sigma factor / the mean factor / the floor delta), each individually rejected. *Still owed:* the Edge re-measure this row's Deps column already requires, now on the repaired two-lane instrument. ⚠ **TWO MORE INSTRUMENT DEFECTS — IN THE BATCH-859 REPAIR ITSELF. Found by adversarial audit of the repair, fixed 2026-08-07 in `lib/celestial-g1-gate.mjs`. Both are the same mistake in opposite directions: a blindness rule applied at the wrong SCOPE.** (5) **The repaired star-modulation lane could not report its own headline defect.** Its non-vacuity control was `abs(glDelta) >= floor && abs(gpuDelta) >= floor` and `structural = !framingReached \|\| !modulationEngaged`, so a modulation term LIVE on one backend and INERT on the other — the C11-176 shape verbatim, and the exact thing the lane was rebuilt to catch — was downgraded from FAIL to STRUCTURAL. `foldG1Verdict` only walks `sm.criteria` in the NON-structural branch, so the failing `starEnergyRatio_in_band` never reached `failures[]`, and the probe printed "G1 STRUCTURAL — a lane ran but could not see its subject; this is **NOT a pass and NOT a defect**" over a shipped one-sided regression. Reproduced before the fix: `glDelta 0.02 / gpuDelta 0` gives `starEnergyRatio 0`, `criteria.starEnergyRatio_in_band false`, VERDICT STRUCTURAL exit 3 `failures []` — indistinguishable from genuine blindness. **The polarity contrast is what makes this unambiguous:** the sibling `modeIsBlind` ANDs the two ZERO conditions (correct — blindness needs BOTH sides dead), while this control ANDed the two ENGAGED conditions (wrong — EITHER side dead declared blindness). **Fixed:** non-vacuity is per backend (`glModulationEngaged` / `gpuModulationEngaged`); BOTH dead ⇒ STRUCTURAL, ONE dead ⇒ FAIL under a NAMED criterion `modulationEngaged_on_both_backends` so the report says which side went inert rather than leaving it implied by an out-of-band ratio; a capture that produced no usable mean on a backend is separated as `modulationUnmeasured` (an instrument failure, not a one-sided defect) with its own structural string; and both per-backend flags travel in `buildG1Summary`. (6) **The blindness guard covered the secondary count modes but NOT the CERTIFYING `default` mode.** All five of the lane's certifying criteria are measured on `default`, and each reads a ratio that `ratio()` returns `null` for on a zero WebGL denominator — `null >= 0.9` and `inBand(null)` are both false — so a mode where BOTH backends censused zero sources would have produced four confident FALSE criteria and **exit 1, a phantom defect** over a scene in which nothing could be observed. `probe-celestial-gates.mjs` deliberately excludes `default` from `G1_COUNT_MODES`, so the one mode whose blindness voids the WHOLE lane was the one mode the rule never reached. **Fixed:** `certifyingModeBlind` routes the lane to STRUCTURAL with a message that says the certifying mode certified nothing; `pass` is explicitly `!certifyingModeBlind && …` because `{}.every(Boolean)` is vacuously TRUE and would otherwise have converted the phantom FAIL into a false GREEN; one-sided blindness on `default` remains a FAIL; the probe now forwards `certifyingMode` into `laneInput` so the name has one home. *Guard:* `celestial-g1-gate.spec.mjs` grows from 40 tests / 15 mutants to **49 tests / 20 mutants**, all green. Four new rules (one-sided modulation death is a FAIL in BOTH directions and must be NAMED; the per-backend flags distinguish blindness from a one-sided defect; a doubly-blind certifying mode is STRUCTURAL; a one-sided-blind certifying mode is a FAIL) and five new mutants — the shipped pre-repair AND, an over-correction that keeps the FAIL but drops the attribution, the pre-repair unconditional-default-criteria shape, a blind certifying mode reported as PASS, and the opposite over-correction where ANY zero count declares blindness. **Attribution verified**: each new mutant is caught by its intended new rule and by no pre-existing rule, so the rules genuinely constrain rather than piggy-backing. | S (diagnosis) → instrument repair LANDED | `C12-G1F1` (re-measure after — STILL OWED) |
| `C12-G2-DEF` | **G2 r_core DEFINITION PIN (orchestrator ruling at Batch 748):** the analytic spec proves r_1e-3/r_core = **11.7 ≥ 8** on the CORE-COMPONENT HWHM definition; on the measurable COMPOSITE-HWHM definition the expected value is ~5.7 and **no in-range constants under the 1° glare cap can exceed ~6-7** (worker derivation). RULING: the Edge G2 gate binds on **composite HWHM ≥ 4** (old truncated-Gaussian composite ≈1.7-2, so ≥4 separates with margin both ways); the analytic ≥8 core-component proof remains the math-layer guard in `starfield-psf.spec.mjs`. Recorded so nobody reads the change as gate-weakening: it is a definitional calibration from new information, with both numbers preserved. Also recorded: catalogue truly spans mag −1.46…5.0 (263 stars, not "~230 to 3.6"); the 3.6–5.0 tail renders below the census floor — `C12-09` re-derives `MAG_CUTOFF`+anchors together (spec fails loudly if the catalogue deepens). | — | — |
| `C12-29` | **NEW-ECLIPSE-OCCLUSION-EFFECTS (maintainer, 2026-07-24 — DEEP RESEARCH **COMPLETE — Batch 749**, `ECLIPSE_EFFECTS_RESEARCH_2026-07-24.md` is the gate artifact; 13/14 load-bearing claims verified, 1 refuted-and-corrected [corona falloff = Baumbach −17/−7/−2.5]).** VERDICT: not a bug — a MISSING SUBSYSTEM. WebGL binary-culls the whole glow billboard (`Occluder.isBoundingSphereVisible`, BV = SOLAR_RADIUS×(1+glowLengthTS) ≈ 6 R_sun); WebGPU has NO cull at all — per-pixel depth clip with bloom unwired; the moon is not an occluder anywhere (zero `eclipse` hits in Source). ARCHITECTURE: one CPU `EclipseState` (f64, ~250 flops/frame, limb-darkened circle-overlap using C12-15's coefficients) → one scalar through 8 verified injection points (sun billboard ALPHA — invariant to the C11-115 blend flip; lightColorHdr; atmosphere ×3 sites; skyBrightness — byte-inert at defaults; clouds+IBL C13-owned; PP bloom; per-fragment globe umbra). SLICES: S1 EclipseState+fade [S, kills the pop, lands BEFORE C12-18/C11-160 as their regression gate] → S2 scene-light+atmosphere dimming [S, ~5-lux twilight floor, never black] → S3 clouds+IBL [M, C13 rider — the IBL debounce is direction-keyed and would stay stale-bright through totality without a quantized eclipse input] → S4 orbital-sunrise limb glow [M; probe the EXISTING Sun.js extinction integrator first — it may already be the reddening ramp, currently unobservable behind the cull] → S5 umbra ellipse on the globe vs NASA SVS 2024 shapefiles (public domain) [M, the from-orbit money shot] → S6 totality corona (Baumbach) + 360° twilight + ratified star reveal [L]. ACCEPTANCE SCENES: real eclipses — 2026-08-12 Iceland/Spain, 2027-08-02 Luxor, 2024-04-08 orbital-umbra vs shapefiles. **MAINTAINER RE-ASK (2026-07-24, second directive): "make an eclipse look more like an actual solar eclipse both in atmosphere and in orbit, triggered by the moon actually eclipsing the sun; the earth can also eclipse the sun in orbit; we need the actual eye effects and dimming" — CONFIRMS the epic scope and PROMOTES the visual slices: S2 (scene-light + atmosphere dimming, the eye-effect core) is the NEXT eclipse dispatch after S1 lands, with S6 (totality look) and S4 (orbital limb glow) following; S5 (umbra ellipse) completes the from-orbit look. S1 implements exactly the requested triggering: real Simon1994 moon ephemeris + Earth-limb dual-cone occlusion, in-atmosphere and orbital.** SIX DECISIONS ANSWERED (maintainer 2026-07-24, rulings recorded in report §6a, Batch 758): S2 default-on+`enableEclipse`; human-eye darkness DEFAULT with a togglable camera-AE alternative mode (C12-19 interaction); S6 star reveal rides the EXISTING star-brightness machinery whose default flips ON at a countryside level (routed through the exit-gate audit); S3 as C13 rider after C13-39 under single ownership; S1-first pin CONFIRMED; analytic dual-cone. **S1 — IMPLEMENTATION DONE, PENDING LANDING (2026-07-24, worktree `agent-a1835f3f20ebc326c`).** New `Scene/EclipseState.js` + `Scene/computeSolarObscuration.js` publish `frameState.eclipseState` = `{enabled, valid, sunVisibleFraction, earthOcclusionFraction, moonObscuration, moonPositionWC, sunAngularRadius, earthAngularRadius, moonAngularRadius, earthSeparation, moonSeparation, eclipseMagnitude}` once per frame in f64 from `Scene.js` `render()` (right after `uniformState.update`): limb-darkened (C12-15 law) circle-circle overlap against the Earth limb AND the lunar disc, 16-point Gauss-Legendre split at the coverage kinks, exact 0.0/1.0 endpoints, all `acos` args clamped. The Earth occluder radius is read off `frameState.occluder.radius` — the SAME sphere the legacy binary cull uses — so the fade and the cull cannot disagree and every `SceneUtilities.getOccluder` guard (2D/CV, hidden globe, underground, translucent) plus `sunVisibleThroughGlobe` is reproduced for free. ONE consumer in S1: the sun billboard ALPHA on both backends (`SunFS.glsl` `u_eclipseAlpha`; the sun WGSL's `eclipseAlpha` reusing the former `_p2` pad at byte 124 — no layout/BGL delta, **no new ShaderDefine bit**), published as `frameState.sunEclipseAlpha` before the FR branch so both backends read one scalar. Alpha-only ⇒ invariant to the C11-115 blend flip. **The legacy binary cull is deliberately untouched** — it can only fire in frames where `sunVisibleFraction` is already exactly 0 (BV ⊃ disc; at a 400 km vantage the fade band is sun-elevation −20.42°..−19.88° and the cull boundary is −21.75°), so the pop dies from the fade alone and the off-toggle stays trivially byte-identical. Toggle `atmosphericConditions.lighting.enableEclipse` **default TRUE** (ruling E1) gates only APPLICATION; `getEclipseSunFactor` returns EXACTLY 1.0 when off/absent/invalid (`x * 1.0 === x`). Gates run by the worker: `tsc --noEmit` clean, `eslint` clean, `eclipse-state.spec.mjs` **28/28** (incl. the near-totality headline — limb-darkened survivor is 0.51x the uniform-disc survivor at 99% geometric obscuration, inside the measured 0.22-0.67 ACP 19:4703 band — and the real 2024-04-08 Dallas eclipse reaching exact totality inside the published window), `node --check` on the probe. **ORCHESTRATOR EDGE RUN (main tree, full build, both backends, 2026-07-24): THE FEATURE IS GREEN.** Lane (a) all-pass both backends — **WebGL sweep `maxStepDelta` 0.03 with the effect ON, i.e. the pop is dead**; WebGPU `firstNorm` 1 → `lastNorm` 0, `maxStepDelta` 0.078 (the backend that never dimmed now fades to nothing); `alphaTracksFraction` exact on all 121 steps. Lane (b) all-pass — Iceland derivation at obscuration 0.647, `moonIsTheOccluder`, `alphaIsLinear`, `offToggleIsIdentity`. Two lane-(c) checks failed and were both CHECK-DESIGN flaws, **not engine defects**; the probe was redesigned (no engine change): (C1) `legacyBehaviourRestored` asked the luminance metric to show WebGL's binary pop, which is geometrically unobservable — the cull boundary sits 1.3° of sun elevation BELOW the end of the fade band, so the limb already covers the glow annulus when it fires (measured WebGL OFF `maxStepDelta` 0.03, WebGPU OFF `lastNorm` 0) → replaced by a STATE-level proof reading `scene.environmentState.isSunVisible` per step (WebGL: the cull still fires at the deep tail and only where `fraction === 0`; WebGPU: never fires, `sunDrawCommand.boundingVolume` absent) plus `cullBoundaryUnchanged` (ON vs OFF flip step ±1 — the true "S1 did not move the cull" pin); (C2) `byteIdenticalWhereUnoccluded` compared canvas hashes across two separate runs, which frame-count-driven animation (`czm_frameNumber`) makes non-deterministic → replaced by a per-step metric comparison `abs(on−off)/max(off,1) ≤ 0.02` where `fraction === 1` (bit-identity is already carried analytically by the spec's exact-1.0 pin) plus `eclipseVisiblyApplied` (partial-band ratio < 0.8). Also fixed: the `EclipseState.js` provenance marker was not bundle-stable (esbuild rewrites `1.0` → `1`) — now the numeral-free substring `- earthOcclusion) * (1`. **ADVERSARIAL VERIFY FLEET (2026-07-24), five findings, all folded in:** V1 MAJOR (two independent checkers) — the lunar memo was keyed on `JulianDate` alone while its value depends on whether `Transforms` used the TEME fallback or true ICRF (~0.3-0.4° apart in 2026, **larger than the 0.53° solar disc**); under a pinned clock it would pin the TEME moon forever while `Moon.update`/`UniformState` switch to ICRF, so the rendered moon and the fade could disagree by more than a solar diameter → the rotation branch is now part of the memo key (new `computeIcrfToFixedBranch`, re-probe on fallback-sourced hits, latch once ICRF-sourced), with a spec test that stubs the `Transforms` seam and drives the whole transition. V2 — outside SCENE3D the camera is in projected-map coordinates while sun/moon are ECEF, so the MOON term ran on mixed frames (~1.5° error) → new `options.active` from `frameState.mode === SceneMode.SCENE3D`, full identity elsewhere (legacy had no sun occlusion there). V3 — the per-frame options literal contradicted the allocation-free claim → hoisted to a module scratch. V4 — the quadrature comment overclaimed "< 1e-9"; the sqrt-type derivative singularities sit AT the sub-interval endpoints, measured worst error **2.8e-5** in obscuration (fleet independently: ~2.0e-5) → comment restated honestly with the caveat. V5 — probe provenance: `FrameState.js`/`WebGPUShaderDefines.ts` added to the mtime gate; the token/marker search restricted to the most recent build window with an `entryFresh` requirement (stale content-hashed chunks previously satisfied it); bounded `globe.tilesLoaded` settles added. Verified clean by the fleet: GL construction reproduced, update order proven, byte-124 pad reuse dead, off-identity exact, `page.evaluate` callbacks scanned identifier-by-identifier. Spec now **32/32**. **SECOND EDGE RUN (v3): lanes (a)+(b) GREEN both backends, engine landable; four more lane-(c) MEASUREMENT bugs, again none of them engine defects.** F1 — the `isSunVisible` read was an artifact (raw steps read false everywhere on WebGL, which cannot be engine behaviour: WebGL executes the sun ONLY under that gate, so lane (a)'s bright sun proves it was true; the sun-hidden background render was corrupting it) → capture via a `scene.postRender` listener that ignores sun-hidden frames. F2/F3 — the two-sweep shape was itself the defect: identity read 0.027 vs 0.02 because 60-78 of 121 steps ran on unsettled tiles, and the saturation mask could not be shared across two `page.evaluate` calls so WebGPU's additive clamp pushed its band ratio to ≥0.8 while WebGL read 0.515 → **collapsed to ONE sweep measuring BOTH toggle positions per step** (4 renders/step, `{off,on}`×`{shown,hidden}`), deleting the cross-run axis entirely at zero extra render cost; per-step tile settle 6→30 frames and the identity check restricted to settled steps (≥5 required, 0.05 fallback recorded, structural if none). F4 — initial settle 180→400 frames. **Premise corrected:** the v2 check demanded WebGL's cull FIRE, but the sun's 4.2e9-m glow BV against a 6.4e6-m occluder sends `Occluder.isBoundingSphereVisible` down its "occludee larger than occluder" branch and it may never report full occlusion at 1 AU — gating on that would have repeated the v1 mistake, so the gate is now `cullStateUnchanged` (identical per-step cull state on vs off, the actual regression claim) + `cullNonVacuous` + `boundingVolumeShape`, with firing REPORTED not gated. **THIRD EDGE RUN: WebGL FULLY GREEN** (`identityWorstRelDelta` exactly 0; `bandRatioMeasured` 0.491 == `bandRatioExpected` 0.491; and the legacy cull DOES fire — `visibleStepCount` 77, `onFlipStep == offFlipStep == 77`, so the withdrawn −21.75° estimate was directionally right and the invariance gate covers it either way, which is why it was written not to depend on the answer). One WebGPU measurement bug left: `eclipseVisiblyApplied` with a null ratio, because WebGPU's ADDITIVE blend clamps the un-faded inner glow at 255 and the saturation mask then discards precisely the sun-bearing pixels, leaving only globe pixels whose ON−OFF difference is exactly 0 → `sumOff === 0`. Fixed with a **three-tier, non-vacuous-by-construction** band gate: T1 `primary-masked` (ratio < 0.8 over partial-band steps with ≥300 unsaturated px inside 1.5×..6×, ≥5 steps — where WebGL lands), T2 `wide-masked` (same gate, mask sourced from a wider 1.5×..10× annulus; ROI widened 6.5×→10.5× to fit, glow falls off radially so the outer ring keeps unsaturated sun-bearing pixels), T3 `raw-strict` (over the UNMASKED annulus require `glowOnRaw < glowOffRaw` at every partial-band step — saturation can only understate dimming, so the one-sided count can never manufacture a pass). Asymmetry is mask SOURCING only: within a step both sums always run over the identical pixel set; `bandTier`+`bandTierReason` recorded so a fallback can never pass silently; the PRIMARY annulus is unchanged so lane (a) and the identity check keep their calibration. New manifest diagnostics: `partialStepsOverFloor{Primary,Wide}`, `partialMaskedPx{,Wide}{Min,Max}`, `bandStrictSteps`/`Total`, and a 4-bin radial saturation profile across 1.5×..10×. **FOURTH EDGE RUN: WebGL laneC ALL EIGHT GREEN** (primary-masked tier, 0.491 == expected, 13 steps). WebGPU 7/8 — and the per-step data settled it: `glowOnRaw == glowOffRaw == 0` at ALL 15 partial steps (fraction 0.990 → 0.001), effect off AND on. **That is a PRE-EXISTING backend sun-RENDERING divergence, not S1 and not saturation:** the fade band IS the limb crossing, WebGL has a measurable band only because its ~6 R_sun glow billboard extends above the limb, and the WebGPU glow does not survive the limb at all — filed as measured evidence on the `C12-15`/`C12-16`/`C12-17` rows. Final check shape: laneC `eclipseVisiblyApplied` is now backend-aware — WebGL unchanged (band tiers), WebGPU detects the condition BY MEASUREMENT (`partialGlowOffRawMax === 0`, recorded), reports `bandTier: "NA-geometric-limb"`, and **formally requires laneB's `alphaIsLinear` + `partialEclipse`** so the eclipse-alpha proof is delegated to the open-sky moon-eclipse lane explicitly rather than exempted silently (verified: laneB red ⇒ laneC fails; non-zero glow ⇒ normal raw-strict; WebGL never takes the NA arm). S2-S6 unchanged. S1 is DISPATCH-READY. **S1 LANDED as Batch 760 (2026-07-24).** **S2 — IMPLEMENTATION DONE, PENDING LANDING (2026-07-24, worktree `agent-a406c693ee57b9e8c`): scene-light + atmosphere dimming, the maintainer-promoted eye-effect core.** `Scene.render` publishes ONE scalar `frameState.eclipseSceneLightFactor`; four JS uniform sources multiply by it so BOTH backends inherit one change and **no shader was edited**: (1) `UniformState` `_lightColorHdr` **and** `_lightColor`, **after** the LDR clamp and gated on `light instanceof SunLight` → `czm_lightColor`/`czm_lightColorHdr` (GlobeFS diffuse, phong, model PBR) + `csm_lightColor`/`csm_lightColorHdr` + `WebGPUGlobeSurfaceCameraUB`'s `lightColor` slot [pre-clamp would be swallowed until the factor dropped below 1/intensity = 0.5 at the default SunLight intensity, then apply at double rate]; (2) the sky-atmosphere shell on both backends — `SkyAtmosphere.js` `_eclipseLightFactor` (set FIRST in `update()`, before both the FR branch and the draw-time closure) × `u_atmosphereLightIntensity`, and `WebGPUSkyAtmosphereRenderer` `uniformData[39]` → `SkyAtmosphere.wgsl` `u.intensity` (the DEFAULT inline-march path; both LUT fast-paths are off at defaults); (3) the globe ground atmosphere **and its fog** through the single `tileProvider.atmosphereLightIntensity` mirror in `Globe.beginFrame` — WebGL reads it via `GlobeSurfaceTileProviderRendering` → `AtmosphereCommon.glsl`'s `computeAtmosphereColor`, whose result **is** `GlobeFS`'s fog colour, WebGPU via `WebGPUGlobeSurfaceCameraUB`/`TileUB` → `GlobeTerrain.wgsl`; (4) `frameState.skyBrightness` (byte-inert at defaults). **STRUCTURAL DISAGREEMENT WITH THE RESEARCH TABLE, TAKEN DELIBERATELY:** the scene factor is derived from `moonObscuration` ALONE, never `sunVisibleFraction`. That fraction folds in `earthOcclusionFraction`, which is exactly 1 for every night frame and saturates a few degrees into twilight (the occluder uses `ellipsoid.minimumRadius`, so from the ground it subtends ~85-86° with its limb several degrees below the true horizon) — using it would black out **every sunset, all of civil twilight, and the day side of the globe seen from a night-side orbital camera**, and would double-count what N·L and the day/night terminator already model per fragment. S1's billboard fade correctly keeps using it. Pinned by a 24-hour Dallas day/night spec sweep that walks the Earth term 0 → partial → 1 and demands the scene factor be **exactly 1.0** at all 360 samples. **CURVE + FLOOR:** `flux = f + 5e-5·(1−f)` with `f = 1 − moonObscuration` (linear in the limb-darkened flux fraction — no smoothstep, no magnitude-keyed darkening, Stellarium issue #3720's documented mistake), then `render = flux^(1/3)`. `ECLIPSE_RADIOMETRIC_FLOOR = 5/100000` is the published totality/full-sun illuminance ratio (AAS; Optica) standing in for the umbral sky lit from OUTSIDE the umbra, which a camera-anchored scalar cannot compute. The `1/3` is the CIE L*/Stevens brightness exponent, and it is load-bearing rather than decorative: ruling E2 makes the human-eye impression the DEFAULT, i.e. no auto-exposure, i.e. nothing else performs the adaptation the eye performs between 1e5 lux and 5 lux — shipping the raw 5e-5 renders a **pure-black** frame, the one outcome the research forbids. Carried through, it reproduces all three documented anchors (50%→0.794 "no visible change until ~75%", 75%→0.630, 99%→0.216 "overcast day") and keeps the plunge (~5.9× from 99% to a `ECLIPSE_TWILIGHT_FLOOR = pow(5e-5,1/3) ≈ 0.03684` totality — civil twilight, never black). **RULING E2 IMPLEMENTED:** new `atmosphericConditions.lighting.eclipseAutoExposure` (**default false**) switches the transfer function, not whether dimming happens — `true` hands the LINEAR radiometric flux to the exposure chain and leaves re-metering to it (exactly a camera; with `highDynamicRange` + the AutoExposure stage on it genuinely compensates, and without an exposure stage it renders the true radiometric plunge, which is what a fixed-exposure camera shows). **C12-19 SEAM (Principle 9):** C12-19's AE lanes have not landed, so there is no eclipse-aware metering window, no AE clamp and no eclipse term in the AE debounce — this flag is the switch they read, the `false` path must stay AE-exempt/clamped and the `true` path must feed eclipse-dimmed luminance in. The default path is complete and shipped. **ORDERING CHANGE TO S1's LANDED CODE (necessary):** the eclipse publish MOVED from after `uniformState.update(frameState)` to before it, because `UniformState` is now a consumer and `uniformState.update` is re-entered several times per frame from `Picking`/`ViewportExecutor`/`SceneRenderer`, each re-entry recomputing the light colour from scratch; the sun's world position is therefore derived inside `EclipseState` from `frameState.time` using `setSunAndMoonDirections`' own call pair, memoised on the same ICRF-vs-TEME rotation-branch key as the moon (reading `uniformState.sunPositionWC` at the new position would give the PREVIOUS frame's sun — a whole step wrong under the stepped clocks every probe uses). **IDENTITY:** `getEclipseSceneLightFactor` early-returns exactly `1.0` when absent/invalid/off/no-obscuration, `UniformState` additionally short-circuits on `!== 1.0` so the no-eclipse path does not execute the multiply at all, and the other three sites multiply by exactly `1.0` (bit-exact). **DELIBERATELY NOT DIMMED, filed for S3/C13 rather than hacked (Principle 9):** (a) the WebGPU sky-atmosphere **LUT bake** — both LUT paths are off at defaults and the bake is debounced on sun DIRECTION, which barely moves across an eclipse, so a dimmed bake would latch at an arbitrary factor and stay wrong long after totality; carrying it needs S3/C13's quantised-eclipse debounce input (research §5); (b) `UniformState._atmosphereLightIntensity`/`czm_atmosphereLightIntensity` — it feeds the model aerial-perspective stage **and** the WebGL IBL radiance-map bake (`ComputeRadianceMapFS.glsl`), whose refresh has the same latch hazard, so a stale dark IBL would persist ~70 s past totality; IBL is S3's. Models still dim through site 1 (the dominant term); only their distance haze waits. **Gates run by the worker:** `tsc --noEmit` clean, `eslint` clean on all eight touched engine files, new `eclipse-scene-dimming.spec.mjs` **31/31**, `eclipse-state.spec.mjs` still **32/32** (its CONTRACT_KEYS gained `autoExposure` + `sunPositionWC`), `node --check` on the probe, prettier-stable. New `probe-eclipse-scene-dimming.mjs`: anti-solar ground vantage (the S1 sun billboard is NOT in frame, so nothing measured can be its alpha fade), horizon row found by binary-searching `camera.pickEllipsoid`, five-rung obscuration ladder derived in-page from Simon1994 (0 / ~0.35 / ~0.65 / ~0.85 / max), THREE renders per rung ({off}, {on}, {on+AE}) with the metric a WITHIN-STEP ratio so both the sun-elevation confound and the cross-run axis are deleted; gates identity/monotonicity/the `f`..`f^(1/2.2)` physical bracket/the floor/never-black/the E2 lane, with the CPU factor parity-gated at 1e-9 and the measured dim series REPORTED not gated. Edge run is the orchestrator's. **ADVERSARIAL VERIFY FLEET (2026-07-24), five findings, all folded:** M1 **ENGINE** — the forbidden cross-backend class: `ModelPBRComplete.wgsl` reads NO `csm_lightColor*` (its direct term is `light.sunColor * light.sunIntensity * NdotL`, packed raw from `frameState.light` by `WebGPUModelRenderer.packLightUniforms`), so during an eclipse WebGPU glTF + 3D-Tiles models stayed full-bright over a dimmed globe while WebGL models dimmed via `czm_lightColorHdr` → **new injection site 5**: multiply `data[4..6]` (colour, so `data[7]` keeps the user's `light.intensity` and one change covers all four WGSL direct terms) and the sky-irradiance ambient `data[8..10]` by `frameState.eclipseSceneLightFactor` under the SAME `instanceof SunLight` gate as site 1 — which also covers the aerial-perspective derived light, since `Scene._atmosphereDerivedLight` is itself a `SunLight`; the non-physical 0.2 ambient fallback is deliberately NOT dimmed (it would drive models to black at totality); the `UniformState` comment that overclaimed both-backend coverage now names the exception. M2 **PROBE** — the floor gate fired at obscuration ≥ 0.995 demanding `factor == floor`, but the curve reaches the floor only at obscuration exactly 1.0 (0.995 → 0.171563, 0.9999 → 0.053132, both re-derived numerically) and that zone is reachable (uniform-disc locator vs limb-darkened engine, off-centreline vantages, 10-s stepping straddling second contact) → replaced by `curveMatchesPrediction`, a SECOND implementation of the S2 curve evaluated at the MEASURED obscuration at every rung in BOTH E2 modes, with `floorRespected` as a bound everywhere and `floorExactAtTotality` firing only at obscuration 1.0. M3 **PROBE** — the `f^(1/2.2)+0.06` sky bound ignored the Khronos PBR-Neutral tonemap + inverse gamma both backends apply unconditionally on the default LDR path; the compressive shoulder puts the measured ratio ABOVE that bound at bright rungs (worked example, reproduced numerically: scene-linear 2.0 with f=0.216 measures **0.666** vs a **0.558** bound — a guaranteed false FAIL exactly where the gate matters) → the bound is now derived THROUGH the shoulder (`predictDim` inverts gamma, inverts PBR-Neutral by bisection, scales by the factor, re-applies the transform) with tolerance bands absorbing the mean-vs-per-pixel approximation, plus a new UPPER sanity bound (band mean < 0.99) so a band pinned against white cannot pass vacuously on a degenerate prediction. N1 **PROBE** — `eclipsed = o>0.01` / `clear = o<=1e-6` left (1e-6, 0.01] unclassified → now detected (`rungsPartition`) and escalated to STRUCTURAL, since such a rung is a broken fixture rather than a verdict. N2 **PROBE** — `factorParity < 1e-9` across two browser contexts can diverge legitimately when one resolves ICRF and the other stays on the TEME fallback (~0.3-0.4° apart in 2026, LARGER than the solar disc; the settle loop only demands the sun direction STOP MOVING, which a stuck TEME frame satisfies perfectly — the same trap S1's V1 found in the lunar memo, one layer out) → the branch is recorded per rung per context and must match before the factors are compared, else STRUCTURAL with a reason string. Added while in there: `lightUniformCarriesFactor`, an end-to-end numeric check on BOTH backends that `uniformState.lightColorHdr === light.color * light.intensity * factor` at every rung. **Verified clean by the fleet:** post-clamp ordering, SunLight gating, publish-before-all-consumers including the picking paths, the sun/moon memo branch keys, the camera-anchored orbital dimming case, the floor algebra anchors, and 2D/CV identity via the SCENE3D gate. **Site-5 verification depth, stated plainly:** sites 1-4 are proven end to end by the probe; site 5 is pinned at source + provenance + WGSL-premise level only (the probe scene contains no model), so a model lane is the honest follow-up and is the right shape for S3. **MEASURED EVIDENCE FROM THE S2 EDGE CYCLE (2026-07-24), filed here as C12 queue notes — NOT S2 blockers and deliberately not chased in S2:** *(obs-1) SKY/STAR COMPOSITING PARITY AT LOW LUMINANCE.* In the deepest-rung PNGs (`output/eclipse-scene-dimming-webgl-deepestOn.png` vs `output/eclipse-scene-dimming-webgpu-deepestOn.png`) WebGL's darkened sky shows the STAR FIELD through the dimmed atmosphere shell while WebGPU renders NO stars at all at the same pinned state, camera and factor. Plausible locus: the WGSL sky alpha path vs GLSL's `mix(color.b, 1, heightOpacity)` — the shell alpha is luminance-dependent, so at low shell luminance WebGL reveals the cubemap behind it and WebGPU apparently does not. Relevant to S6 (totality star reveal) and to the C11-176 star-modulation default flip (ruling E3), since both assume the two backends composite the star field comparably. *(obs-2) GROUND-LIGHTING BRIGHTNESS PARITY.* At the same 2026-08-12 Iceland ground vantage with `globe.enableLighting = true` and the eclipse OFF, the WebGPU ground band measures ~3x darker than WebGL (`offGroundMean` 0.113 vs 0.324). Pre-existing, unrelated to S2 (it is the OFF state), and unchanged by the eclipse factor — recorded because it is a clean, reproducible numeric handle on a globe-lighting divergence that no current row owns. Both observations are backed by the probe manifest `output/eclipse-scene-dimming-report.json` and the four deepest-rung PNGs. S3-S6 unchanged. Two screenshots recorded the defect: the sun is BINARY-CULLED behind Earth's limb (frame N: nothing; frame N+1: full glow pop-in) and lunar occlusion has NO effect at all. Wanted: eclipse-grade effects in orbit AND in atmosphere — partial-occlusion sun fade, orbital-sunrise limb glow progression, moon-shadow (umbra/penumbra) on the globe, scene-light + skyBrightness + IBL dimming by eclipse fraction, totality phenomena. Sequencing: interacts with `C12-15..19` (sun), `C11-160`/`C11-115` (transferred sun PP items), and `frameState.skyBrightness`. Research report gates the design. ✅ **SLICE S4 (orbital-sunrise limb glow) — VERDICT: ALREADY WORKING. Verification + wiring landed (worker, 2026-07-25), pending orchestrator landing + Edge run; NO new limb-glow physics was written, and none is needed.** S4's brief said to probe the EXISTING `Sun.js` extinction integrator first. Measured in pure Node (`Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs`), 400 km vantage, sweeping tangent height: **exactly (1,1,1) above the 111 km shell** (so non-occultation frames stay byte-identical), then a monotone ~5-decade ramp — blue 0.886 at 50 km, 0.227 at 25 km, 9.55e-4 at 10 km, 8.33e-12 at 0 km — with the **red/blue ratio climbing 1.0 -> 2.0e6** (3.3 at 25 km, 25 at 15 km, 209 at 10 km), and ~0 for rays passing below the surface. That IS the orbital-sunrise reddening ramp, per-channel, already published to BOTH backends and already multiplied into the sun's RGB in `SunFS.glsl` and the sun WGSL. The gate is `skyAtmosphere.show` with **no altitude term**, so it runs from orbit; it was invisible only because the legacy binary cull removed the billboard first — which **S1 already replaced with a continuous fade**. **The research report's §3.4 suspicion is confirmed and the `Sun.js` comment that contradicted it was a DOC BUG, now corrected:** it claimed "the physics yields exactly Cartesian3.ONE from orbit (the ray never crosses the shell)", which is false in exactly S4's geometry — from 400 km the shell subtends 73.1 deg from nadir and the solid Earth 70.2 deg, so a **2.9-deg-wide annulus** of directions produces limb-grazing rays that traverse the whole atmosphere. **Sampling adequacy settled by an EQUIVALENCE gate, not a model** (S2 doctrine): `EXTINCTION_STEPS = 16` over a ~2,400 km limb chord reproduces a 40,000-sample midpoint reference of the same integrand to **5.2e-6 absolute** (worst case, at 45 km; gate pinned at 5e-5) — the chord's density profile is near-Gaussian with sigma = sqrt(r_t*H) ~ 250 km against a ~150 km step, so midpoint sampling converges by Poisson summation rather than by step-size ratio. **WHAT IS ACTUALLY MISSING (Principle 9, the only real S4 gap):** the integral is evaluated on the camera->sun-**centre** ray only, so the whole billboard gets ONE uniform tint. A real setting sun is graded ACROSS its 0.53-deg disc — at this vantage the sun's 0.5327-deg diameter maps to a 21.33 km span in tangent height, and the upper-limb/lower-limb transmittance ratio measured with the shipped integrator is strongly altitude- AND channel-dependent — red/green/blue 1.02/1.05/1.12 at 60 km, 1.18/1.47/2.33 at 40 km, 2.27/6.16/4.8e1 at 25 km, 5.03/2.6e1/7.7e2 at 20 km, 5.1e1/7.7e2/2.0e5 at 15 km, 1.7e5/1.4e7/1.2e11 at 10 km, 2.6e9/9.7e11/1.9e17 at 0 km. (An earlier revision quoted "~5.6x in blue" as if it were the figure; it is reached only in a ~31.75-34.25 km band and understated the gap by many orders of magnitude across 0-15 km, exactly where an orbital sunset is visually interesting. The table is now asserted by `sun-orbital-limb-extinction.spec.mjs` so it cannot rot.) **Differential extinction across the disc** now sits beside refraction lift/flattening as deferred polish; neither is implemented. **S4's remaining blocker is OBSERVABILITY, not physics:** the ramp cannot be seen on WebGPU while `probe-eclipse-sun-fade` measures zero sun contribution above the earth limb, and the C12-15/16/17 wave is NOT the cause of that zero (both banked co-suspects refuted arithmetically — see the C12-16 row). `probe-sun-glow-profile.mjs` is the diagnostic that names the real cause. ⛔ **S1 EVIDENCE NOTE CORRECTED (round 3, 2026-07-25).** The S1 probe's `NA-geometric-limb` tier is still the RIGHT tier — nothing measurable lives in that annulus — but its stated REASON ('the WebGPU sun's glow does not extend above the earth limb', 'a pre-existing backend sun-RENDERING divergence') is now known to be **WRONG**. Measured: `frameState.sunAtmosphereExtinction` is byte-identical on both backends at every near-limb step and reaches `[0,0,0]` below −19.0°, so **the sun is fully extinguished there on BOTH backends and WebGPU's zero is the physics executing correctly**. WebGL's residual at those same steps is the anomaly; the leading mechanism is that a BLACK billboard under `ALPHA_BLEND` darkens the sky by `a·dst` while the same black billboard under WebGPU's additive blend is an exact identity. At the one non-extinguished step WebGPU measures **120% of WebGL**, and the Batch-760 open-sky 77% asymmetry does not reproduce (0.06% agreement per radial bin). **The C12-15/16/17 wave was never the blocker for this, and lane (c)'s deferral to lane (b) should be re-derived on the corrected premise.** 📌 **TWO SECONDARY FINDINGS FILED (do not fix here):** **(i) `NEW-WEBGPU-SUN-COMMAND-NO-BOUNDING-VOLUME`** — WebGPU's sun draw command carries NO bounding volume (`sunCommandHasBV` false at every step, all vantages), so `Scene.isVisible` early-returns true and the legacy `Occluder.isBoundingSphereVisible` horizon cull can NEVER fire on WebGPU. Measured divergence: at −22.6° WebGL culled (`isSunVisible` false) while WebGPU reported visible at all five steps. Benign today because extinction is already 0 there, but it is an unconditional cull-path divergence and it also means the S1 comment's reasoning about the cull boundary applies to only one backend. **(ii) `NEW-WEBGPU-NEAR-LIMB-GLOBE-ABSENT` (obs-2 territory, hand to that owner with the data)** — in WebGPU's near-limb ROI the globe does not render AT ALL, and it is **shell-independent**: `globeFrac` is exactly 0 and `bgMeanNoGlobe` (155.254) is bit-for-bit identical to `bgMean` (155.254) — hiding the globe changes NOTHING — while with the SHELL hidden the same ROI reads **1.701 (black)** against WebGL's **36.94**. A shell cannot cause an absence that persists after the shell is removed, so this is NOT shell opacity covering the globe; the 155.254 is the shell's own brightness (the run measures the shell as BRIGHT). WebGL has **67–84% globe coverage** in the same ROI (`globeFrac` 0.7725). Corroborating from the other direction: at 400 km `altitudeOpacity → 0`, so the shell should be TRANSPARENT there — which is exactly why WebGL's globe correctly shows through. This is the largest divergence in the entire measurement. | L (epic; slices TBD by research) | research report |
| `C12-30` | **NEW-MOON-IN-ATMOSPHERE-APPEARANCE (maintainer, 2026-07-24, screenshot: daytime sky, moon renders as a small DARK blob beside the sun glow).** **SIZE/DISTANCE HALF: MEASURED AND CLOSED (Batch 752)** — at the screenshot instant the ephemeris gives 405,067 km and 29.49′ expected angular diameter (real-world apogee ≈29.4′ ✓); the rendered disc measures ≈5.3 px radius vs 4.83 px predicted from projecting the true `LUNAR_RADIUS` — **the viewer is accurate; the moon just genuinely subtends ~0.5°** (the physical-radius intuition ≈1/3 Earth ≈27% is correct but distance dominates on screen; also an explicit verified non-goal at `FEATURE_INVENTORY.md:1076-1078`). Do NOT resize. **APPEARANCE HALF (the real defect):** a daytime moon must read BRIGHT on its sunlit side and partially sky-washed (atmospheric in-scattering in front of it), not a dark hole. Suspects: (1) `C11-176b` phaseGate blackout — **RESOLVED (implementation done 2026-07-24, pending orchestrator landing):** the `Moon.wgsl` whole-disc `smoothstep(0.0, 0.3, phaseFraction)` multiplier is deleted; mechanism confirmed as THE blackout driver for this screenshot's geometry (daytime moon near the sun ⇒ elongation < ~66° ⇒ phaseFraction < 0.3 ⇒ disc multiplied toward 0; ~0.07 at phaseFraction 0.05). Gate probe: `probe-moon-phase-gate.mjs` day-crescent lane. Re-assess this row's residual after the Edge run; (2) no atmospheric extinction/scattering applied to the moon inside the atmosphere — **note the extinction/darkening half exists** (`Moon.js` NS-MOON-ATMOSPHERE-EXTINCTION, C9-06 shared integrator) but the IN-SCATTERING (sky-wash in front of the disc) half does not — ✅ **IMPLEMENTATION DONE (moon-wave worker, 2026-07-24) — pending orchestrator landing + Edge run**: `computeAtmosphereInscatter` CPU integral (mirrors the sky shader's own scattering model incl. tonemap/alpha chain) → `disc = disc × extinction + inscatter` on BOTH backends (`ATMOSPHERE_INSCATTER` / WGSL `inscatter` UB tail member), toggle `lighting.enableMoonSkyWash` default ON, exactly (0,0,0) from orbit/night/hidden; (3) tie-in to `C12-20` Lommel-Seeliger (Lambert sphere reads dark at partial phases) — ✅ **IMPLEMENTATION DONE with `C12-20` (same batch)**. Do NOT close this row on (1) alone — **close it when the Edge run of `probe-moon-atmosphere-appearance.mjs` passes all 3 lanes** (day-mid dark-cutout detector, horizon extinction+reddening, night-full stays-bright; spec `moon-atmosphere-appearance.spec.mjs` 14/14 offline). Sequencing: with the W5 moon wave. Probe: pinned-clock daytime-moon scene, brightness-vs-sky assertion + PNG review. **UPDATE 2026-08-07 (close-out docs reconciliation): the two "pending orchestrator landing" clauses in this cell are STALE on the landing question.** Per this document's own trust order — the dated overlays supersede row prose where the prose still says "worker complete / pending landing or Edge" — the **2026-07-28 status overlay** records `C12-20`, `C12-23` and `C12-30` as **landed in the Batch-756 moon wave with the moon-atmosphere appearance gate PASSING**. Verified rather than inherited: Batch 756 is `89dcd0da08` and carries `Scene/Moon.js`, `Scene/computeAtmosphereExtinction.js`, `Scene/computeLunarOppositionSurge.js`, `Scene/EllipsoidPrimitive.js`, `Scene/AtmosphericConditions.js`, `Shaders/EllipsoidFS.glsl` and `Shaders/WebGPU/Environment/Moon.wgsl` on `main`; suspect (1)'s `C11-176b` dependency landed earlier still at Batch 755. **Nothing in this row is sitting in an unlanded worktree.** One honest caveat on the recorded gate pass, so it is not over-read: `probe-moon-atmosphere-appearance.mjs` is repair **item 5** of the vacuous-probe sweep in `DEFERRED_WORK.md` (its inscatter assertion is listed as latent) and that item is recorded there as UNTOUCHED — so treat the pass as landed-and-gated, not as an audited gate. | M | ~~`C11-176b`~~ (resolved), w/ W5 |

| `C12-31` | **NEW-NATURAL-SOLAR-ATMOSPHERE-AUREOLE (maintainer screenshot, 2026-07-28) — ROOT CAUSE AUDITED; SKY-SHELL FIX IMPLEMENTED (worker, 2026-08-01), ORCHESTRATOR-REVIEWED + FIRST BROWSER PROBES GREEN (2026-08-01, see end of cell); full acceptance sweep still owed. See the status block at the end of this cell for exactly what shipped, what was deliberately left, and what the acceptance sweep below still owes.** The broad white patch seen while looking up is **not the Sun billboard, ordinary post-process bloom, or an RTE failure**. It is the shared legacy `DynamicAtmosphereLightingType.NONE` path: default `Globe.enableLighting === false` makes `Scene` force the sky atmosphere to `NONE`, and both GLSL and WGSL then substitute `normalize(positionWC/skyPoint)` — a different local “Sun directly overhead” at every sample — for the astronomical Sun. The default Mie anisotropy `g = 0.9` makes that fake forward-scattering lobe about **4,870×** its 90° value, producing a bright zenith/view lobe even when the visible Sun is elsewhere or below the horizon. WebGPU faithfully mirrors WebGL here, so this is a shared inherited defect, not a backend-parity defect. The current optional WebGPU multiple-scattering add is also internally inconsistent in `NONE`: primary scattering uses the fake local-up light while the MS contribution uses the real `sunDirectionWC`. **BLOOM CONTRACT:** not every bloom effect should be hard-wired to the Sun. The dedicated WebGL `SunPostProcess`, the rendered Sun billboard/glare, WebGPU lens flare, and god rays are anchored to the real Sun; generic bloom intentionally spreads any legitimate bright radiance (solar aureole, ocean glint, snow, clouds, emissive material, etc.) and must remain radiance-driven. Generic bloom can amplify this false atmospheric source but does not create its center. Direct `scene.sunBloom` semantics are still unwired on WebGPU and remain owned by `C12-18`; do not duplicate that work here. **REQUIRED ARCHITECTURE:** (1) decouple natural sky lighting from terrain `globe.enableLighting`; disabling terrain lighting must not silently replace the sky's astronomical Sun; (2) make the production/default natural-atmosphere path consume the one authoritative per-View astronomical Sun direction on both backends, consistently across inline scattering, LUTs, multiple scattering, ground atmosphere/fog, extinction, eclipse, and any future cloud/IBL consumers; (3) preserve `SCENE_LIGHT` and a named, explicit legacy-overhead/`NONE` compatibility mode — do not delete a feature or silently redefine an opt-in mode; (4) keep the existing RTE design: atmosphere vertices/positions remain high/low where needed, while the normalized world-space solar direction needs no high/low split; (5) do not add a render pass, per-frame allocation, duplicate ephemeris calculation, or default shader variant solely for this fix. Coordinate the radiance/halo boundaries with `C12-18`, `C12-19`, `C12-27`, and `C12-29`, and cross-reference rather than duplicate `NEW-ORBIT-PER-LAYER-REFLECTIVE-BLOOM`. **ACCEPTANCE:** add directional pixel coverage absent from current `SkyAtmosphereSpec`: at one pinned clock/camera, hide the Sun billboard and disable every PP stage to isolate the shell; sweep time by 6/12 hours and rotate the camera; the Mie peak must remain world/Sun-anchored and follow projected solar azimuth/elevation, with no stationary zenith/view hotspot and no direct white aureole when the Sun is below the local horizon. Then run the effect-isolation matrix (`mieScattering=0`, generic bloom on/off, `sun.show` on/off, `sunBloom` on/off, glare/lens-flare/god-rays on/off), and prove that bloom changes only the spread/intensity of a real bright source, never its angular origin. Require synchronized-clock WebGL/WebGPU angular-centroid and luminance parity at ground/horizon/orbit, longitude/pole cameras, RTE altitude tracks, HDR/SDR, per-fragment and LUT/MS paths, eclipse/extinction/occlusion, `SCENE_LIGHT`, and explicit legacy `NONE`. **STATUS 2026-08-01 — SKY-SHELL FIX IMPLEMENTED (worker), PENDING ORCHESTRATOR REVIEW + BROWSER PROBES.** *Shipped:* new shared builtin `czm_getSkyAtmosphereLightDirection` (`Builtin/Functions/getSkyAtmosphereLightDirection.glsl`) called from BOTH `SkyAtmosphereVS.glsl` and `SkyAtmosphereFS.glsl` — the per-vertex path is the DEFAULT whenever a globe is visible, so fixing only the FS would have left the defect standing; WGSL twin = the `isLegacyOverhead` block in `SkyAtmosphere.wgsl`. NONE and SUNLIGHT → the astronomical Sun, SCENE_LIGHT unchanged, and requirement (3) is met by a NEW named enum member `DynamicAtmosphereLightingType.LEGACY_OVERHEAD = 3` (add-only; 0/1/2 keep their values) that reproduces the historical appearance exactly. Requirement (1) is met WITHOUT touching `fromGlobeFlags`: `globe.enableLighting = false` still resolves NONE, and NONE no longer replaces the sky's Sun. Requirement (4): no RTE change (a normalized world-space direction needs no high/low split). Requirement (5): no new pass, allocation, ephemeris or shader variant — `czm_sunDirectionWC` was already a dependency of the sky program and `u.sunDirectionWC` was already packed (its NONE-path value was a documented placeholder and is now load-bearing). *Deliberately NOT done, and why it is not a half-implementation:* the enum VALUE stays NONE rather than being remapped to SUNLIGHT, because both backends key the day/night alpha ramp on `enum != 0` (`SkyAtmosphereCommon.glsl:109`, WGSL `isDynamic`) — remapping would have changed the shell's OPACITY, i.e. star/skybox occlusion and the `C12-29` S6 totality reveal. LUT eligibility is byte-identical for enums 0/1/2. The model ground-atmosphere/fog stage and the IBL radiance bake keep the legacy direction (`C12-31-FOLLOWUP-A/B` in `DEFERRED_WORK.md`; migrating them breaks upstream Jasmine contracts that assert the NONE env map is non-directional and that NONE ≠ SUNLIGHT, and needs a WebGL IBL re-bake trigger the WebGPU side already has). A bonus fix falls out: the WebGPU MS add was internally inconsistent in NONE (primary on fake local-up, MS on the real Sun) — the two now agree. *Evidence:* new pure-Node contract `Tools/visual-regression/sky-light-direction.spec.mjs` **16/16** (4869.9× Mie ratio derived independently and pinned against the shipped expression; Mie argmax anchored to the Sun across 20 sweep positions; below-horizon Sun leaves < 5% of the forward peak at ≤ 4° elevation on the Sun's azimuth; non-vacuous negative controls where the legacy selector reproduces the stationary zenith peak; twin-lockstep + naga). Two mutation runs (WGSL predicate, GLSL call site) each fail it. `C12-29` eclipse suites **138/138** unchanged; full Node set 484/487 with the same 3 pre-existing failures the worktree base already had; `npx tsc --noEmit` clean. *Orchestrator probe run (2026-08-01):* `probe-sky-aureole-anchor.mjs` PASS first execution, both backends — L1 toward/anti 1.688 (>=1.25) with toward brightest of four headings, L2 centroid flips sides with the +/-60 offset (0.620/0.379), L3 night mean 0.000 of day with no pixel above 40, 0 console errors. `probe-celestial-gates.mjs`: the default AND cubemap pairs are now FULLY in band including m2b=1.0; the only red is sprites-only where BOTH backends census 0 (parity intact; the documented E1 instrument class — census threshold vs default sprite brightness — filed for probe recalibration, not an engine defect). ⛔ **ATTRIBUTION CORRECTED (2026-08-06, C12-G1F2 repair).** This cell originally read "the fix pulled the open `C12-G1F2` RMS-contrast divergence (1.488) into band". **That claim is withdrawn: this fix cannot have done it.** C12-31 changes `SkyAtmosphereVS/FS.glsl`, `SkyAtmosphere.wgsl` and the new `getSkyAtmosphereLightDirection.glsl` builtin (`34965a2b21`, with the shader halves physically in `e748181065` per the mis-split note above) — and **the G1 scene sets `scene.skyAtmosphere.show = false`**, so not one of those files executes in the scene that produced 1.488. The 1.488 → 1.0 move is recorded as **UNATTRIBUTED**; substituting a new guess would repeat the original error. Two candidates, both of which DO touch the G1 scene: **Batch 761** (`9f4c7b9c2f`, `EnvironmentFrustumDemand.ts` + `View.js` — the C12-G1F1 env-frustum root fix, which changed whether the environment pass ran at all in exactly this globe-off/atmosphere-off configuration) and **Batch 770** (`0679b0e456`, which rewrote `SkyBrightness.js`, `CubeMapPanorama.js`, `StarField.js`, `StarFieldMath.ts`, `CubeMapPanorama.wgsl` and both star renderers — i.e. it redefined the driving quantity between the two runs). **Three-point bisect that settles it**, cheap because `probe-celestial-gates.mjs --lane orbital` needs no engine change: build and run G1 at (a) `9f4c7b9c2f^`, (b) `9f4c7b9c2f`, (c) `0679b0e456`; a 1.488→~1.0 step between (a) and (b) attributes it to 761, a step between (b) and (c) to 770, and no step at either attributes it to something outside both — in which case widen to the 761..770 window by halves. Record the answer here rather than in a probe output file. `probe-limb-halo-width.mjs`: WebGL rim measured (mean 10.75), WebGPU detector returned STRUCTURAL 'too few rows' (2 samples) — the sun-anchored light legitimately redistributes limb brightness azimuthally and the rim detector needs a dim-side-tolerant rebuild; recorded as part of the owed acceptance sweep, not a conviction. *Still owed by this row:* every browser-side item of the ACCEPTANCE sweep above — the effect-isolation matrix, synchronized-clock WebGL/WebGPU angular-centroid + luminance parity, HDR/SDR, LUT/MS paths, and the `C12-18`/`C12-19`/`C12-27`/`C12-29` sequencing re-test. | M | — (sequence/regression-test with `C12-18`, `C12-19`, `C12-27`, `C12-29`) |
| `C12-32` | **NEW-SHARED-CELESTIAL-EPHEMERIS-STATE (2026-07-31 performance audit; collision-verified append).** A changing SCENE3D frame currently computes Simon1994 Sun/Moon positions redundantly: `EclipseState` computes both plus the inertial-to-fixed transform; `UniformStateComputations` immediately recomputes Sun and Moon; a visible `Moon` computes lunar ephemeris again. Replace this with one backend-neutral, per-Scene/per-time/per-transform-branch `CelestialEphemerisState`, prepared once and consumed by EclipseState, UniformState, Moon, tides, atmosphere, and future cloud/IBL jobs. Preserve the TEME-fallback versus resolved-ICRF branch in the cache key so an async transform-availability transition can never reuse a stale position. This is a shared CPU architecture fix, not the cause of the WebGPU-only resident gap and not permission to change any celestial result. **ACCEPTANCE:** instrument exactly one Sun and one Moon Simon call per unique time/branch across render, pick, and multi-view; prove fallback→ICRF transition, direction/phase/eclipse/tide numeric identity, viewer destruction, and both backends. | M | sequence with `C12-29`; feeds C14 tides |

**Append accounting:** `C12-32` was absent repository-wide before this append;
the numbered Campaign-12 range is now `C12-01..32` (non-numbered G1 rows are
unchanged).

> **C12-29 S6 SKY HALF — integrated and executor-validated
> (2026-07-26).** This supersedes the in-flight StarField wiring, 100 km
> catalogue cutoff, stale-Moon, panorama-wide modulation, and capture prose
> inside the large C12-G1F1/C12-29 rows above.
>
> - **Environment ownership:** WebGPU and WebGL each return one cached star
>   command through `environmentState.starFieldCommand`. The WebGPU star field,
>   sky atmosphere, and sun are return-only: they do not also push a binned
>   command-list copy that can bypass Scene visibility. Batch 761's
>   environment-demand predicate preserves sky-only frustum creation.
> - **No feature spill:** only `SkyBox` constructs its panorama with
>   `isStarMap: true`. Generic `CubeMapPanorama` and Google Street View imagery
>   receive exact-identity star modulation and cloud attenuation.
> - **Current celestial state:** `Moon.update` publishes direction and phase
>   before `frameState.skyBrightness` is computed, so a single
>   request-render-mode clock step cannot retain the prior frame's moonlight.
>   Scene passes `camera.positionCartographic.height`; cubemap and catalogue
>   stars share one continuous 60–111 km atmospheric-column law, with no hard
>   100 km pop and no hard-coded Earth-radius subtraction.
> - **Stable sun resources:** WebGPU keeps immutable quad geometry and caches
>   its vertex buffer, bind group, and draw command across clock ticks. The
>   moving ECEF center is high/low encoded in the per-frame uniform update;
>   texture/bind/command rebuilds occur only on real bake, format, pipeline, or
>   device invalidation.
> - **Probe contract:** render plus live-canvas PNG freeze is synchronous in one
>   task; decoding the frozen bytes may await. The shared Acorn validator
>   rejects unawaited direct/alias calls and floating `Promise.all`/`.then`
>   chains, while `settleThen` rechecks readiness after the final animation
>   frame. B4 now counts command publication directly, and D uses an offline
>   globe with explicit atmosphere readiness instead of equating sparse sprite
>   and cubemap visibility.
>
> The S6 provenance list has seven valid rename-proof slices. At this
> integration checkpoint, 49/49 S6 Node tests, syntax, and Prettier were clean.
> Targeted Karma, both-backend Edge probes, and PNG inspection on the final
> main-tree integration were also complete; results follow. The current
> overlay above supersedes this historical checkpoint with **51/51** after the
> later custom-ellipsoid correctness gates.
>
> **Final targeted executor result (later 2026-07-26): PASS.** The repaired
> `probe-eclipse-scene-dimming.mjs` now boots both derivation and measurement
> with `offline=true`, requires non-empty rendered tiles, and proves that its
> ground mask contains terrain by differencing white-vs-black
> `globe.baseColor` captures before accepting any ground result. WebGPU
> responded on the full mask (`responsiveFraction = 1.0`,
> `meanAbsoluteResponse = 0.3388469`); WebGL responded on the full mask at
> `0.9857331`. Both backends pass every S2 identity, curve, monotonicity,
> auto-exposure, manual-equivalence, and parity arm with zero console errors.
> `skyBrightness` is captured immediately after its matching render. S6 horizon
> twilight is disabled only around the S2 manual-equivalence twin and restored
> afterward; the dedicated S6 totality gate continues to exercise the shipped
> default-on horizon effect, so this isolation does not trade away coverage.
>
> The final environment integration also replaces prepend-and-hope background
> injection with allocation-free, in-place canonicalization. An already
> canonical `skyBox -> starField` prefix is an idempotent fast path; otherwise
> a stable compaction removes all repeated/legacy copies before prepending each
> identity once. This closes repeated-frustum/stereo-shaped duplicate
> submission without per-frame arrays or closures. It is hardening for repeated
> execution, **not** a claim that WebGPU WebVR is available:
> `supportsStereoViewport` remains false until per-eye
> `passState.viewport` reaches the WebGPU scene renderer. This result
> discharges the targeted S6/S2 integration gate only; Campaign 12's other
> rows and full §5 exit criteria remain open.

> **C12-29 S5 GLOBE UMBRA — integrated; targeted browser gates pass and the
> diagnostic moving route is complete; final certification still open
> (2026-07-28).** This supersedes
> the parked S5 patch's independently rounded body vectors, Scene-global
> observer state, and per-tile camera-UB growth. It does **not** mark S5 or
> C12-29 complete: the NASA-SVS geospatial comparison, isolated active/inactive
> S5 cost, real terrain/exaggeration/fill/provider, behavioral pick/capture,
> custom-ellipsoid runtime, multi-View/stereo, and replacement-device lanes
> remain.
>
> - **Logical-view ownership:** every `View` owns its stable
>   `EclipseState`, scene-light scalar, horizon-twilight scalar, and S5 globe
>   block. `Scene.updateFrameState()` calls `prepareLogicalViewEclipse()` to
>   prepare and publish S1/S2/S6 before `UniformState.update(frameState)`, then
>   clears the transient S5 alias and memo. Retained capture, the main globe,
>   and pick each prepare S5 once against their exact owned terrain selection
>   before emitting commands. Capture-face and other pass cameras deliberately
>   reuse that owner-prepared, pass-camera-independent body-ray payload.
> - **Planet-scale RTE:** CPU f64 publishes a geocentric common Sun ray plus
>   the small Moon-minus-Sun direction differential and both inverse ranges.
>   Both shaders consume the direct exaggerated ECEF `positionMC` varying,
>   whose f32 quantization is sub-metre, and scale it by the inverse
>   astronomical ranges before subtraction:
>   `s = uS - P*a`, `D = dU + P*(a-b)`, `m = s + D`. Separation uses
>   `atan2(length(cross(s,D)), dot(s,m))`; there is no mutable pass-camera
>   reconstruction and no `acos(dot)` of independently rounded near-parallel
>   unit vectors. The f32 emulator covers surface, elevated terrain, LEO, GEO,
>   poles, and the antimeridian without a classification disagreement.
> - **Surface activation and horizon:** terrain activation is two-stage. A
>   provider-wide resource envelope is updated once when each realized mesh is
>   published, using a `WeakSet`, raw height extrema, fill-skirt allowance,
>   current exaggeration, and provider-reset invalidation. That supplies the
>   O(1) globe-wide reject without ordinary per-tile command-path work. Only
>   when the global bound can intersect the penumbra does the frame scan
>   selected rendered meshes using skirt-inclusive scaled-ENU spheres, a
>   proven no-skirt fallback, exaggeration expansion, and conservative-active
>   malformed metadata. Main rendering, pick, and retained environment capture
>   share the refined View-owned block by selection revision. The local shader
>   then uses an exact algebraic disc-support reject and the stable ellipsoid
>   cross-product closest-distance test. S6 horizon twilight now derives
>   geodetic up from the active ellipsoid on both backends.
> - **Exact-owner preparation (2026-07-28):** Scene no longer performs a
>   consumerless coarse S5 preparation before the command owners. That removes
>   one duplicate O(1) globe-wide test for each rendered-globe logical
>   `View`/frame and a repeated
>   limb-darkening fit on active intersecting frames. Provider selection
>   revisions and every conservative fallback remain intact. This is a bounded
>   eclipse-path CPU cleanup, not an FPS claim.
> - **Backend carriers and ownership:** WebGL exposes one packed `mat4`
>   command-local uniform. WebGPU uses a dedicated 64-byte group-0/binding-2
>   dynamic UBO: ordinary frames bind one renderer-owned inert slice without a
>   ring allocation/upload; an active logical View prepares one allocation-
>   epoch-memoized slice reused by tile, imagery, wireframe, pick, and capture
>   commands. `CameraUniforms` remains 232 floats / 928 bytes. Capture flushes
>   staged uniform bytes before its private submit, and device recovery
>   destroys the allocator plus retained capture/environment resources before
>   a new device generation can reuse them.
> - **Surface law and WebGL ordinary path:** both fragments share analytic
>   circle overlap, the CPU-fitted limb-darkening cubic, and S2-aware
>   absolute/relative composition, including correction-only gates 3/4.
>   Those gates remain active carriers: WebGPU uses one memoized 64-byte View
>   slice and WebGL uses the bit-33 active shader plus packed `mat4`. Their body
>   inverse ranges are zero and the common-ray, ellipsoid-horizon, overlap, and
>   limb-fit ALU is skipped; carrier work must never grow per tile or pass.
>   WebGL now keys a bit-33 inactive/active globe variant. Inactive programs
>   omit the S5 uniform, helper IR, surface composition, and atmosphere
>   correction; direct timeline scrubs still select and synchronously finish
>   the correct active program on their first frame.
> - **Evidence now:** `eclipse-globe-umbra-rte.spec.mjs` **18/18**;
>   `eclipse-globe-shadow-visual.spec.mjs` **4/4**; S6 **51/51**;
>   recovery **7/7**; protected eclipse/recovery Node set **145/145**;
>   core S1/S2/S5/S6 Node set **134/134**; manager Edge/Karma lane **11/11**;
>   performance contract **23/23**; full build and targeted engine lint PASS.
>   The earlier terrain-provider
>   Edge lane was 4/4;
>   its requested current-tree rerun was blocked before launch by the executor
>   approval-usage cap, not by a failing test.
>   `probe-eclipse-globe-shadow.mjs` passes both backends and its no-eclipse
>   controls: WebGL/WebGPU changed coverage differs by 0.00747, strong-core
>   coverage by 0.00259, mean darkening by 0.01741, and footprint edges by
>   3 px; both controls have zero changed pixels. Its selected-terrain lane
>   additionally proves the fixed-camera 81/81-ray, exact 36-skirted-mesh
>   correction state; non-vacuous S2-only control; first-frame 25-mesh local
>   activation; conservative two-root reverse frame followed by exact gate-3
>   recovery; and WebGPU's one-allocation correction/local carrier. Report:
>   `Tools/visual-regression/output/eclipse-globe-shadow-report.json`.
> - **Measured performance result:** the explicit moving-camera API lane proved
>   all seven WebGL long tasks contain exactly one synchronous
>   `getProgramParameter(LINK_STATUS)` wait. Before the static variant those
>   waits consumed 889.9 ms of 981 ms total long-task time; afterwards they
>   consumed 753.9 ms and total long tasks fell to 845 ms at the same measured
>   55.56 Hz refresh. This is a one-run directional proof, not final
>   certification. Renderer-wide asynchronous compilation through
>   `KHR_parallel_shader_compile` needs a pending-program lifecycle and derived
>   log-depth/HDR/shadow prewarm; it is queued separately rather than faked by
>   moving the same blocking status query.
>   **2026-07-28 supersession:** the separate owners are `C11-180` and
>   `C11-181`. `C11-180` has landed the core lifecycle plus a measured bounded
>   final-program/fog-companion slice and remains PARTIAL; `C11-181` has closed
>   the globe replacement-reference leak. The broader structural variant
>   matrix remains outside C12-29.
> - **Current-build repeated performance gate:** six fresh-process
>   counterbalanced pairs completed **12/12 PASS** with valid active/inactive
>   S5 evidence and no page, device, or external-request failure. Median
>   WebGL/WebGPU CPU average was 3.667/3.363 ms; CPU p95 was 5.273/5.500 ms;
>   CPU p99 was 8.850/7.320 ms. WebGPU GPU average/p95 was 2.056/3.105 ms.
>   Median FPS and 1%-low were 54.27/42.69 (WebGL) and 56.50/48.70
>   (WebGPU). WebGL retained nine synchronous compile/link long tasks per run;
>   WebGPU retained none. This certifies current renderer parity and rejects
>   an obvious S5 regression. The banked pre-spatial baseline is single-run,
>   so no stable before/after speedup or isolated S5 cost is claimed.
>
> **C12-S5-FINAL-CERTIFICATION-MATRIX (still open):**
>
> - real terrain/exaggeration, fill transitions, and provider swaps at the
>   footprint edge;
> - behavioral pick and retained-capture refinement against their exact
>   retained selections;
> - dense selected-terrain timing plus a controlled active/inactive S5 cost
>   comparison while the global gate is possible;
> - custom-ellipsoid runtime coverage;
> - NASA-SVS geospatial comparison with projection, ephemeris, and terrain-mask
>   provenance;
> - generic multi-View/stereo-shaped execution; and
> - a genuine replacement-device browser run. `GPUDevice.destroy()` is
>   terminal (`reason === "destroyed"`) and is not replacement-device evidence.
>
> **Adjacent work exposed, not fixed by S5:** `UniformState.update()` still
> snapshots previous view-projection/camera state on every re-entrant call, so
> pick/offscreen or repeated-view work can collapse or contaminate TAA history.
> Temporal-history commit must become per-View and once per presented logical
> frame. Also, View-owned state is a correctness foundation, not proof of a
> generic multi-view scheduler: split-screen scheduling and exact per-eye
> WebGPU stereo remain separately uncertified/unsupported.

### W2 — Bright-star appearance model (the "white blobs" fix) — shader + data only, no framebuffer risk

**The mechanism, quantified:** output is `rgb = color * alpha` with `color` peaking at `HI × intensityScale = 2.0`, so it clips wherever `alpha ≥ 0.5`. With the shipped profile that is `dist ≤ ~0.53` — **the inner ~53% of the sprite radius (~28% of its area) is a flat, colourless, fully-saturated white plateau.** That is the blob. The code's own escape valve does not exist: `Scene.js:1458` `highDynamicRange = false` and `PostProcessStageCollection.js:56` `bloom.enabled = false`, so the intended overflow is destroyed by the ROP and the bloom that would have made it a halo never runs.

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-05` | **Moffat core+wing PSF**, paired WGSL + GLSL. `I(r) = I₀[1+(r/α)²]^(−β)` — a power-law wing with constant log–log slope, which is the analytic description of "wide smooth halo over many core radii". **Includes moving the AA window from `smoothstep(1.0,0.45)` to `(1.0,0.92)` — without which the new wing is multiplied to zero and the change is inert.** Use **β ≈ 2.0–2.6**, not the ground-based-seeing 4.765: in vacuum the halo is instrument/ocular response, so the Stiles–Holladay inverse-square glare model is the right regime. | S | `C12-02` ✅ LANDED Batch 748 — Moffat core+wing (σ=0.12, α=0.15, β=2.0, K=0.08), AA window 0.45→0.92. |
| `C12-06` | **Quad enlargement** driven through the existing `sizeBoost` plumbing as **halo extent, not core size**; clamp total glare diameter to 1°. Today the sprite is only ~7.5 px, of which ~4 px is plateau — the Polaris reference look is **geometrically unreachable** without this. | S | `C12-05` ✅ LANDED Batch 748 — sizeBoost=√I−1 capped at 0.833° glare; core px-invariant via coreScale varying (σ inversely scaled, α quad-relative — the only reading under which the item does anything; deviation recorded). |
| `C12-07` | **Amplitude restructure** — stop the core saturating across half the sprite; chroma-preserving split so the core may clip white while the halo stays below 1.0 and keeps blackbody hue. **This is the increment that actually kills the blob, and it needs no HDR.** ⚠ Adding a wing to a still-clipping core makes a *bigger* blob; **do not raise `HI`** (that widens the white disc). | S | `C12-05` ✅ LANDED Batch 748 — chroma-preserving split, haloIntensity 0.470<1 by construction; clip radius 1.21 px ≈4.6 clipped px (Sirius only). |
| `C12-08` | **Dynamic-range restoration** — remove the baked `FLUX_GAMMA=0.5`, keep flux linear (Pogson), move compression into an explicit exposure term. Today the true 38.4:1 flux range across rendered stars is pre-crushed to **2.70:1**, then clipped — Sirius and a 2nd-magnitude star arrive nearly identical. | M | `C12-07` ✅ LANDED Batch 748 — linear Pogson, EXPOSURE anchored at mag 3.6→15.3/255; math-layer range 383.7:1 (was 4:1); FLUX_GAMMA/LO/HI retired w/ ledger comment. |
| `C12-09` | **✅ COMPLETE / LANDED Batch 804 — catalogue depth to vmag 5.5.** The shared catalog now contains 2,868 independently ordered records. The ingest satisfied DR-02 without a licence shortcut: source NASA HEASARC, vendor only factual RA/Dec/Vmag/B−V fields, and emit under the fork's own schema/order rather than V/50 row order. Both renderers consume the same table and cutoff. Magnitude-6.0/5,058 remains a separate one-flag deepen, parked until C12-11 moving-camera alias and frame-cost evidence. | M | `C12-08`; C12-11 acceptance follows |
| `C12-27` | **Angular solar glare star-washout** — full definition §6 (Q2b). ✅ **LANDED Batch 865 (`193393790c`) — EDGE ACCEPTANCE OWED.** *(Wording stamped 2026-08-07, close-out docs reconciliation. This cell read "IMPLEMENTATION DONE (worker, 2026-08-06) — pending orchestrator landing" — text written by the very commit that landed it, which is the stale-wording class the `C11-176b` refutation in this document was filed to kill. `193393790c` carries `Scene/SolarGlareAppearance.js`, `Scene/SolarDiscModel.js`, `Scene/SkyBox.js`, `Scene/StarCubeMapResource.js`, `Scene/CubeMapPanorama.js`, both star renderers, `Shaders/SkyBoxFS.glsl` and `LICENSE.md` on `main`. See the "2026-08-06 appearance-tail overlay" stale-wording correction near the top of this file — **in this document "pending orchestrator landing" means EDGE ACCEPTANCE OWED, not code unlanded.**)* ❌ **THE ROW'S OWN PRESCRIPTION IS REFUTED, and the refutation is what set the design.** This row says to reuse "the `C12-05` Stiles–Holladay math (`Lv(θ) ∝ 1/θ²`)". Both halves of that sentence cannot be true of one curve: `C12-05` DID land (Batch 748) but its Moffat wing is `(1 + (r/α)²)^(−β)` with `STAR_PSF_BETA = 2.0`, i.e. a log-log slope of **−4** — an inverse-FOURTH-power point-spread function for one unresolved star, correctly so. The landed **inverse-square** veiling form in this fork is `C12-16`'s pedestal-subtracted Lorentzian at `Scene/SolarDiscModel.js:172` (`solarGlareProfile`, the CIE stray-light form), which is what the row's parenthetical actually describes. **`SolarDiscModel.js` is therefore the single constants source** and now carries ONE curve in two parameterisations (`pedestalLorentzian`: over bake radius for C12-16, over radians for C12-27); `solarGlareProfile` is proven **bit-identical** after the extraction against a frozen copy of its pre-C12-27 body over 20,001 samples, with a reordered-expression control proving that check has teeth. Reusing C12-05's β=2 wing instead is shipped as an explicit REJECTED mutant. **Curve:** half-amplitude at `√(1×30) = 5.477°`, the geometric centre of the Stiles–Holladay validity band (derived, not dialled); support exactly **90°** — that is the acceptance criterion, not physics, and it is stated as such; pedestal follows from the two. **Measured multipliers:** 0.0324 at 1°, 0.5019 at 5.477°, 0.7721 at 10°, 0.9337 at 20°, 0.9713 at 30°, and **exactly 1.0** at and beyond 90° (`x * 1.0 === x`) — an identity, not an approximation, reached by three mutually redundant guards (the redundancy is measured and pinned, together with the proof it is CONDITIONAL on support = 90°). **Both backends, both passes, five shader texts, one function:** `StarField.wgsl`, `StarFieldVS.glsl`, `CubeMapPanorama.wgsl`, its JS-embedded production copy, and `SkyBoxFS.glsl` all carry an identical `solarGlareVeil` and **no numeric copy of the constants** (the C12-15/16 uniform convention). Resolved ONCE per frame in new `Scene/SolarGlareAppearance.js`, called from `Scene.updateEnvironment` before both `skyBox.update` and `starField.update`, published as `frameState.solarGlareAppearance` with the Sun direction in the **TEME** frame — the frame all four consumers already hold their star direction in, so one published vector serves all of them and the sprite VS deliberately dots the RAW `directionFixed` attribute rather than the rotated `dirFixed`. Toggle `lighting.enableAngularSolarGlare`, **default ON**, OFF passes strength exactly 0.0 which every shader reads as "skip the block". **Composes with, does not fight, the existing machinery:** it is an independent multiply alongside `computeStarBrightnessModulation`, and it is **deliberately NOT gated by `computeAtmosphericColumnFactor`** (which correctly zeroes the sky-glow modulation above 111 km) — sky glow needs a column, veiling glare needs an observer, and orbit is exactly the viewpoint Q2b was reported from. Stated in the module docstring, in `AtmosphericConditions.js`, in `SHADER_PAIRS_LOCKSTEP.md` and asserted by the spec, because it is the first thing an auditor comparing the two terms will ask. UB growth is ADD-ONLY at the tail on both backends (star UB 112→144 bytes inside its unchanged 256-byte allocation; panorama UB 256→288 with every prior offset frozen and byte-offset comments updated); no BGL churn, no new `ShaderDefine` bit. ⚠ **HONEST LIMITS, disclosed per the C12-15 precedent.** (1) The effect is measurable only near the Sun: −0.28 mag at 10°, −0.03 mag at 30°. (2) **The brightest stars show NO core change beyond ~2.365°** — Sirius' profile peak is 6.341 linear and stays clipped at 255 until the multiplier drops it under 1.0 (veil > 0.84229); its halo moves at 10°, its clipped core does not, so a probe metering Sirius' core at 10° will correctly measure zero. (3) The cube map's diffuse band peaks at 8–28 code values, so its absolute movement is small (6.4 cv at 10°, 0.8 cv at 30°) — the sprite lane carries the headline number and the cube-map lane is corroboration. ⚠ **Found + fixed en route:** escaped backticks in the JS-embedded WGSL comment truncated the slice that `eclipse-sky-totality.spec.mjs` naga-validates (it scans for the first backtick followed by a semicolon), turning that gate green on a fragment; caught by running the spec, fixed, and recorded as a standing watch item in `SHADER_PAIRS_LOCKSTEP.md`. ★ **UPDATE 2026-08-07 (Batch 873) — the FILED sun-visibility gap is DISCHARGED, and the Edge sweep re-attributed two instruments that were blamed on this row.** **(a) VISIBILITY GATE LANDED.** The row shipped with a self-filed defect: the veil had no notion of whether the Sun delivers any flux to the observer, so a camera at night or in Earth's shadow still washed out every star within 90° of the Sun's SKY POSITION — glare with no glare source. Fixed with the one multiply the filing prescribed, `strength = SOLAR_GLARE_STRENGTH × eclipseState.sunVisibleFraction`, in the shared CPU resolver, so all five shader texts and both backends inherit it with **no shader change** (the strength uniform already carries it, and strength 0 skips every consumer's whole block). The publication-order coupling the filing flagged is resolved and verified: `frameState.eclipseState` is published by `prepareLogicalViewEclipse` at the tail of `Scene.updateFrameState`, which runs before `Scene.updateEnvironment`. Identity preserved when the state is absent, `valid === false`, or `enabled === false`. **(b) THE VEIL IS NOT WHY G1 AND THE TWILIGHT PROBE CENSUS ZERO STARS — REFUTED ARITHMETICALLY.** G1's orbital camera sits ON the sun ray and aims PERPENDICULAR to it, so the Sun lies on the camera's −right axis at exactly 90°; over the 1000×640 crop the minimum angular separation from the Sun anywhere in frame is **65.72°** and the maximum veil is **0.00322** (minimum multiplier 0.99678 — a 0.32% dim). The M1 census bar is `P − B ≥ 12/255` in linear light; a 0.32% dim cannot take 55 sources to 0 — the hypothesis is out by three orders of magnitude. **(c) THE ACTUAL CAUSE IS C12-11 / DR-01, and it is a SEMANTICS change, not a defect.** `SkyBox.defaultVariant` became `TYCHO_T5_DIFFUSE` at Batch 833 (2026-08-06 13:51), whose every face **censuses to 0 resolved point sources by construction** (peak luminance 8–28 vs 251–255) — resolved stars belong to the sprite catalogue by DR-01. G1's M1 baseline ("55 sources", filed Batch 745) was calibrated against the UN-blurred cube map. Measured on the committed captures: the archived 2026-08-01 `cubemap-only` PNG peaks at code **225**, tonight's peaks at code **7**, identically on both backends. The sprites are present and bit-identical across backends (the two `sprites-only` PNGs share a SHA-256) but peak at code **36**, below the census bar of ≈61 — the known E1 threshold issue, same class. **G1 Lane A therefore correctly reported STRUCTURAL, not a defect.** This is exactly the re-scope Batch 848 already applied to `probe-stars-catalog.mjs` ("counting pixels against a pre-DR-01 floor measures the REMOVED CUBEMAP, not the catalogue"); `probe-celestial-gates.mjs` and `probe-sky-twilight-range.mjs` still carry pre-DR-01 star thresholds and OWE the same re-scope. **The instruments were not wrong — the scene changed under them when C12-11 landed default-ON.** **Gate now: `solar-glare-star-washout.spec.mjs` 41/41** (7 new visibility tests; deleting the multiply fails 4 of them, dropping the `frameState.eclipseState` argument fails 1). **Gate:** new `Tools/visual-regression/solar-glare-star-washout.spec.mjs` **34/34** — five-way cross-language extraction agreeing to 1e-15 (plus a non-shipped parameter set, so an implementation that ignores its arguments is caught), seven adversarial mutants ALL REJECTED (C12-05's Moffat wing, un-subtracted pedestal, Gaussian, the deleted elevation-keyed global dim, degrees-for-radians, chord parameterisation, sign flip), a live in-tree mutation sweep across all five shaders, the C12-16 bit-identity regression, the resolver's inverse-rotation check, and the Edge predictions. **OWED:** the Edge acceptance run. | M | `C12-05` (premise corrected — see above; the real dep is `C12-16`, LANDED Batch 766)  **EDGE ACCEPTANCE DISCHARGED 2026-08-07 (first G2 run, tip `c810dbace2`): near-field dim 8.198% energy / 73,288 px / 0 brightened; far field byte-identical with a non-vacuous A/A control — the row's own criterion verbatim, on both backends.** |
| **Gate** | **G2** — must pass identically on **both** backends (shared code), **including the `C12-27` criterion: stars at small angular separation from the Sun dim measurably while stars at >90° separation are byte-identical to the no-Sun frame.** | | |

### W3 — Star-map asset (Q1 ANSWERED: t5; licence RESOLVED per §6f; runs parallel to W2)

**The single cheapest high-value finding in the whole sweep: the fork ships the *faintest* variant of its own star map.** SVS 3572 publishes three: `t3` — *"the Milky Way is very faint"* (**what we ship**, at 1024/face), `t4` — *"fainter"*, and `t5` — ***"the Milky Way is very bright and bright stars are large"*** at **16384×8192**. Same NASA product, same creators, same attribution entry (now `# Bundled Engine Assets`, `LICENSE.md:1024-1044`, Batch 730 — whose Files line already covers additional `SkyBox.Variant` entries derived from the same SVS product). **Licence history: §6d ruled this wave BLOCKED (retracted), §6e revised to CONDITIONAL GO, §6f RESOLVED it 2026-07-19 — t5 is cleared for this project's scope and W3 is UNBLOCKED.** The Batch-728 `SkyBox.Variant` plumbing already registers `TYCHO_T5` (NOT YET BUNDLED — jpg-hardcoded descriptor; selecting it 404s until `C12-10` lands).

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-10` | **✅ COMPLETE / LANDED Batches 742/744 — reproducible T5 bake and installed reversal artifact.** The hash-pinned 16K SVS source pipeline performs gamma-1.8→sRGB correction, 4096 reprojection, 2048 downsample, and wrapped-equirect Gaussian diffuse generation. Six 2048 unblurred JPEG faces (4.355 MB total) are bundled and T5 is the default; 4096 and diffuse outputs remain reproducible from `Tools/skybox-bake/bake-tycho-t5.mjs`. Installing unblurred faces before the deeper catalog was deliberate reversal sequencing, not C12-11 completion. | L | — |
| `C12-12` | **VRAM/streaming policy** — 2048/face default, 4096 opt-in, KTX2 compressed (4096/face RGBA8 uncompressed ≈ 402 MB). ✅ **POLICY HALF IMPLEMENTED 2026-08-07 (Batch group CO-22); KTX2 HALF STAYS TOOLING-BLOCKED; 4096 TIER IS NOT BAKED.** New leaf module `Scene/SkyBoxResolutionPolicy.ts` owns the tier table, the pure `resolveSkyBoxResolution()` and the VRAM model; `SkyBox.js` gains `SkyBox.Resolution` + `SkyBox.defaultResolution` (following the existing `SkyBox.Variant` / `SkyBox.defaultVariant` shape) and a second `createEarthSkyBox(variant, options)` argument (`{ resolution, maximumCubeMapSize }`), plus `skyBox.resolution` / `faceSize` / `estimatedVramBytes` accessors. Backend-agnostic by construction — the policy picks URLs, which both loaders consume identically; no shader, define bit or renderer change. ⚠ **The row's premise needed correcting in two places.** (1) **"2048/face default" is not what every variant ships**: `TYCHO_T3` is bundled at **1024**/face (upstream's faces), only `TYCHO_T5` and `TYCHO_T5_DIFFUSE` are 2048. The policy therefore serves the DEFAULT request (2048) as a documented step-down on `T3` rather than pretending a 2048 t3 exists. (2) **No 4096 face exists anywhere in the tree** — `Tools/skybox-bake/` reprojects to a 4096 master and lanczos3-downsamples to 2048 (`skybox-manifest.json`: `encode.masterSize = 4096`, `encode.faceSize = 2048`), so the opt-in tier is *reproducible but not bundled*. What landed is the **seam**: an explicit `SIZE_4096` request resolves DOWN to what is on disk and reports `fallback: true` + reason `tier-not-bundled` — it never fabricates a URL that would 404 the sky — and installing the tier later is a data-only change (add a `"4096"` row with `prefixSuffix: "_4096"` and the six `<prefix>_4096_<face>.jpg` files). Filed as `C12-12-SKYBOX-4096-TIER-NOT-BAKED`. **VRAM numbers are re-derived from the loaders, not from this row:** both backends upload the faces as `rgba8unorm` with **ONE mip level** (WebGPU `WebGPUCubeMapPanoramaRenderer.js` `createTexture` has no `mipLevelCount`; WebGL `loadCubeMap.js` uses the `CubeMap` constructor defaults and never calls `generateMipmap()`), so the cost is exactly `6 × faceSize² × 4` — **1024 → 25,165,824 B (24 MiB)**, **2048 → 100,663,296 B (96 MiB)**, **4096 → 402,653,184 B (384 MiB / 403 MB decimal**, which is the row's "≈ 402 MB"**)**. The JPEG's on-disk size does not enter into it. **KTX2 remains out of scope and blocked** — no KTX2/Basis encoder exists in this repo or on the machine (`C12-12-KTX2-SKYBOX-NOT-BUNDLED`, `MOON-ALBEDO-KTX2`), and neither consumer path transcodes KTX2 today; the spec pins the absence so the `C12-13` LICENSE clause cannot silently go stale. **Gate:** `Tools/visual-regression/skybox-resolution-policy.spec.mjs` — 27 assertions, browser-free: the tier table is checked against `Assets/Textures/SkyBox/` **in both directions** (every promised face exists; all 18 faces on disk are accounted for, so an unregistered bake fails), the 4096 seam is proven to work via an injected table while the tree is proven to contain no `_4096_` face, the VRAM constants are re-derived AND the two loaders are re-read to prove the single-mip `rgba8unorm` premise still holds, and no compressed-texture face is bundled. **OWED:** Edge acceptance that the default sky still renders identically (the URLs are byte-identical by construction and the spec pins the filename shape, but no pixel run has been made). | S | `C12-10` ✅ |
| `C12-11` | **✅ IMPLEMENTED 2026-08-06 — DR-01 seam LANDED; Edge acceptance OWED (do not self-promote).** The default cube map is now `SkyBox.Variant.TYCHO_T5_DIFFUSE` (six new 2048 q90 4:4:4 faces, **0.36 MB total**), leaving the 2,868-record sprite catalog as the sole source of resolved stars on both backends. Faces were regenerated from the hash-pinned 16K SVS source (re-downloaded; SHA-256 verified) — **not** by blurring the six shipped JPEGs. Reproducibility is proven: the same run's un-blurred faces came out **byte-identical (SHA-256) to the six already in the tree**, so the diffuse set is a genuine artifact of the documented pipeline. `TYCHO_T5` (un-blurred) and `TYCHO_T3` stay bundled; the un-blurred bytes are untouched. ⚠ **The bake's diffuse path was doubly broken and had never been consumed** — (1) `.blur()` was chained onto a `sharp.composite()` pipeline, and sharp applies `composite` LAST, so the blur hit an empty base and the un-blurred strips were pasted over it: a total no-op; (2) `composite()` returns RGBA, which the caller read with a 3-byte stride, making the map ~29× too bright. Both fixed (explicit `Buffer.copy` wrap-padding + channel/length sentinels). **A mean is invariant under blur and could not see either defect** — only a peak/point metric can. Measured seam (`skybox-manifest.json`, SHA-bound to the shipped bytes): diffuse **points = 0 on all six faces** (peak lum 8–28 vs 251–255 un-blurred) while retaining **83–95%** of each face's own band structure. Gates: new `skybox-diffuse-seam.spec.mjs` 24/24 (SYNTHETIC ground-truth + 3 MUTATION tests), package tsc non-TS2307 = 0, root tsc 0, prettier/eslint clean. `probe-stars-catalog` check (A) is now a REAL gate (point census, not a brightness count) plus a new check (G) asserting the cubemap alone yields no resolved stars. **OWED:** the Edge run of `probe-stars-catalog.mjs` (A/G/B/C/D/E/F), G3 diffuse/reversal visual review, and the moving-camera alias/frame-cost lane. See `C12_STARFIELD_SEAM_DISPOSITION_2026-08-02.md`. ✅ **TWO OF THOSE THREE OWED ITEMS NOW HAVE A MECHANICAL INSTRUMENT (CO-24, 2026-08-07) — `probe-celestial-gates.mjs --g3`; the Edge run is still owed, and the visual review is narrowed rather than discharged.** What the lane MEASURES so it need not be eyeballed: (a) **the "diffuse/reversal visual review"** — band-structure retention diffuse-vs-un-blurred (offline: **0.928** against the shipped 0.60 bound) and granularity retention (**0.120**, i.e. the low-pass removed the grain and kept the degree-scale structure), reported as DR-01 reversal trigger `smearedMilkyWay` — **NOT triggered**; and the seam re-asserted on a LIVE cubemap-only frame with a lit-pixel positive control, so a runtime variant flip cannot hide behind innocent bytes. (b) **the "moving-camera alias/frame-cost lane"** — a 24-frame camera-only sweep at 0.37 px/frame under the pinned clock, measuring a faint sprite's box PEAK against its box SUM (reversal trigger `aliasTwinkle`, bar 0.2 mag; **analytically predicted TRIGGERED at 3.77× / 1.44 mag** from the shipped `STAR_PSF_SIGMA` at the lane's framing, with the brightest star at only 1.18× — the sub-pixel failure DR-01 named), plus an INTERLEAVED A/B sprites-on/off frame-cost delta reported as **DIAGNOSTIC ONLY**. What is **NOT** discharged: the trigger readings are deliberately NON-CERTIFYING — DR-01 is a ratified decision and G3 measures its reversal conditions rather than ruling on them — and no G3 run has executed on Edge, so every number above is offline-derived or analytic. The `probe-stars-catalog.mjs` Edge run remains owed in full and is not covered by this lane. | M | `C12-09` ✅, `C12-10` ✅ |
| `C12-12` | **VRAM/streaming policy** — 2048/face default, 4096 opt-in, KTX2 compressed (4096/face RGBA8 uncompressed ≈ 402 MB). | S | `C12-10` |
| `C12-13` | **`LICENSE.md` refresh** — ✅ **LANDED Batch 865 (`193393790c`) — EDGE ACCEPTANCE OWED.** *(Wording stamped 2026-08-07, close-out docs reconciliation. This cell read "IMPLEMENTATION DONE (worker, 2026-08-06) — pending orchestrator landing" — text written by the very commit that landed it, which is the stale-wording class the `C11-176b` refutation in this document was filed to kill. `193393790c` carries `Scene/SolarGlareAppearance.js`, `Scene/SolarDiscModel.js`, `Scene/SkyBox.js`, `Scene/StarCubeMapResource.js`, `Scene/CubeMapPanorama.js`, both star renderers, `Shaders/SkyBoxFS.glsl` and `LICENSE.md` on `main`. See the "2026-08-06 appearance-tail overlay" stale-wording correction near the top of this file — **in this document "pending orchestrator landing" means EDGE ACCEPTANCE OWED, not code unlanded.**)* ❌ **THE RECORDED RESIDUAL WAS ALREADY TWO-THIRDS DISCHARGED, AND ITS LAST THIRD IS VACUOUS — verified against `LICENSE.md` at HEAD and against the 18 files actually on disk.** (a) "extend the **Files** line with the baked t5 faces" — ALREADY DONE: the line covered `tycho2t5_80_*` and `tycho2t5_80_diffuse_*` before this batch. (b) "a t5 variant description sentence" — ALREADY DONE, including the diffuse paragraph. (c) "record the KTX2 bake derivation chain" — **VACUOUS: no KTX2 or Basis asset exists anywhere in the tree and `Tools/skybox-bake/` has no KTX2 path, because `C12-12` has not landed.** What this batch actually adds is the real residual the row did not anticipate: a per-variant **Files table** with the measured face resolution, encode and byte cost (t3 **1024²**, JPEG **4:2:0**, 867,538 B — inherited from upstream; t5 and t5-diffuse **2048²**, JPEG q90 **4:4:4** mozjpeg, 4,566,954 B and 379,927 B; **total 5,814,419 B**, verified against disk by the spec); the full ordered derivation chain for the baked faces (pinned source SHA-256 + byte count → SMPTE gamma-1.8→linear→sRGB 256→256 LUT → longitude-wrapped bilinear reprojection to six GL cube faces at 4096 → lanczos3 downsample to 2048 → JPEG q90 4:4:4 mozjpeg, source TIFF not bundled); an explicit statement that **no compressed-texture form is bundled**, so the C12-12 clause reads as a fact rather than an omission; and a correction that the **t3 reprojection is upstream CesiumJS's**, not this project's — `Tools/skybox-bake/` pins the `t5` source and does not reproduce `t3`, which the previous wording could be read as implying. Filed as `C12-13-T3-PROVENANCE-GAP` and `C12-12-KTX2-SKYBOX-NOT-BUNDLED` in `DEFERRED_WORK.md`; note the t3 faces' 4:2:0 chroma is what the `G3` gate criterion says fails immediately. **Gate:** `solar-glare-star-washout.spec.mjs` enumerates the 18 shipped faces, requires each variant prefix to appear in the entry, requires the recorded total to equal the bytes on disk, requires each derivation step by name, and asserts BOTH halves of the KTX2 claim — so the day a compressed face ships without the entry being extended, the spec fails. | XS | `C12-10` ✅ |
| `C12-14` | *(opportunistic)* Expose the baked cubemap as a **samplable star texture**, discharging the `C11-163` celestial-water-reflection blocker for free. ✅ **LANDED Batch 865 (`193393790c`) — EDGE ACCEPTANCE OWED.** *(Wording stamped 2026-08-07, close-out docs reconciliation. This cell read "IMPLEMENTATION DONE (worker, 2026-08-06) — pending orchestrator landing" — text written by the very commit that landed it, which is the stale-wording class the `C11-176b` refutation in this document was filed to kill. `193393790c` carries `Scene/SolarGlareAppearance.js`, `Scene/SolarDiscModel.js`, `Scene/SkyBox.js`, `Scene/StarCubeMapResource.js`, `Scene/CubeMapPanorama.js`, both star renderers, `Shaders/SkyBoxFS.glsl` and `LICENSE.md` on `main`. See the "2026-08-06 appearance-tail overlay" stale-wording correction near the top of this file — **in this document "pending orchestrator landing" means EDGE ACCEPTANCE OWED, not code unlanded.**)* New pure `Scene/StarCubeMapResource.js` owns a backend-neutral descriptor (`available`, `backend`, `faceSize`, `orientation`, plus the WebGL `CubeMap` **or** the WebGPU `GPUTexture` + cube `GPUTextureView`), refreshed once per `CubeMapPanorama.update` on BOTH backends and reachable three ways: `skyBox.starCubeMap`, `CubeMapPanorama#samplableCubeMap`, and `frameState.starCubeMap` (published for star maps only, so generic and Street View panoramas never claim the frame-wide slot). WebGPU is reached through a new `getResource` entry on the `CUBE_MAP_PANORAMA` feature renderer, so scene code still imports nothing from `Renderer/WebGPU/` (Principle 2). ⚠ **Principle 7 — nothing samples it yet, deliberately.** `CELESTIAL_WATER_REFLECTION_RESEARCH.md` names "samplable STAR cubemap" as `C11-163`'s **biggest gap** (its `sampleStarField()` had no texture: `StarField.wgsl` is un-samplable point sprites and `ProceduralSkyCubemap.wgsl` is atmosphere-only); that row is the recorded consumer, and every module header says so before a future dead-code audit reaches it. Three consumer contracts are stated as data and in prose: the lookup direction is **TEME, not Earth-fixed** (both backends apply `temeToPseudoFixed` on the way to clip space); `available` is false until the six faces load asynchronously and can go false again on a `sources` swap or teardown; and the handles are **borrowed** — the panorama owns and destroys them. ⚠ **Found en route, and load-bearing for `C11-163` rather than for this row:** under the default `TYCHO_T5_DIFFUSE` the cube map carries the diffuse galactic band and **zero resolved stars** (DR-01; `skybox-manifest.json` measures 0 point sources on all six faces), so "stars reflected on water" cannot be built from this texture alone — `C11-163` must choose between sampling the un-blurred `TYCHO_T5`, accepting a Milky-Way-only reflection, or adding a sprite-derived term. To make that decidable at runtime the sky box now also reports **`skyBox.variant`** (set by `createEarthSkyBox`, cleared when `sources` are replaced so it can never go stale). Filed as `C11-163-CUBEMAP-HAS-NO-RESOLVED-STARS` in `DEFERRED_WORK.md`. **Gate:** `solar-glare-star-washout.spec.mjs` — descriptor lifecycle including the loading/destroyed transitions, both realization sites in the correct ORDER (WebGPU after `fr.update`, WebGL before the "no cube map yet" early-out), star-map-only publication, teardown clearing, and the Principle-2 seam. | S | `C12-10` ✅ |
| **Gate** | **G3**, both backends. | | |

### W4 — Sun (depends on already-queued PP wiring)

| ID | Item | Effort | Deps |
|---|---|---|---|
| `C12-15` | **Limb darkening** in both bakes (`a₀=0.3, a₁=0.93, a₂=−0.23`; limb ≈ 30% of centre). WebGL's bake is `step(radius, u_radiusTS)` — a **binary, perfectly flat disc**. Cheapest realism win in this lane; start from the existing prototype in the unreferenced `Environment/Sun.wgsl`. **MEASURED (see the C12-16 row): C12-29 S1's probe found the WebGPU glow contributes 0 above the earth limb across all 15 fade-band steps while WebGL measures 0.491 — this wave is the blocker for observing earth-limb sun dimming on WebGPU at all.** The limb-darkening coefficients themselves are already live on the CPU side: `Scene/computeSolarObscuration.js` (C12-29 S1) consumes the same `a₀=0.3, a₁=0.93, a₂=−0.23` triple, so both consumers must read one constants source when this lands. ✅ **IMPLEMENTATION DONE (worker, 2026-07-25) — pending orchestrator landing + Edge run** of new `probe-sun-glow-profile.mjs`. **The consolidation is now STRUCTURAL, not a convention:** new pure `Scene/SolarDiscModel.js` owns the triple + `solarLimbIntensity(x)` + the C12-16 glare parameters; `computeSolarObscuration.js` imports them (re-exporting the old names for its existing importers), `SunTextureFS.glsl` receives them as `u_limbDarkening`/`u_glareProfile` **uniforms** so the GLSL holds no numeric copy at all, and the WebGPU CPU bake imports the resolved payload. Resolution happens once in `Scene/SunDiscAppearance.js`, called from `Sun.update` BEFORE the feature-renderer branch and published as `frameState.sunDiscAppearance` (the C7-SUN-STARS-EXTINCTION convention), so both bakes provably consume identical numbers. Toggle `atmosphericConditions.lighting.enableSolarLimbDarkening`, **default ON**, with an EXACT identity position — `(1, 0, 0)` makes `I(mu) == 1` for every mu, i.e. the historical flat `step()` disc, not an approximation of it. ⚠ **PRINCIPLE-9 SURFACE — this row is arithmetically INERT at SDR defaults and the row's own premise needs C12-19 to pay off.** The bake writes `alpha = surface + 0.75*glare + burst` and clamps to 1; over the disc the glare term alone is ~0.735, so alpha at the extreme limb is `0.30 + 0.735 = 1.035` and still clamps to 1.0. Limb darkening therefore changes NO pixel until **C12-19** removes that clamp (or **C12-18** separates the halo into the PP chain). It ships now at the radiance level so C12-19 is a one-line unclamp rather than a re-derivation; it was deliberately NOT made visible by scaling the glare down, because that dims the whole sun on both backends and is exactly the reconciliation C12-18/C12-19 own. ❌ **The measured-evidence clause on this row is REFUTED:** this wave is NOT what unblocks earth-limb dimming on WebGPU — see the C12-16 row. **ROUND 2 (2026-07-25):** BUILD BLOCKER fixed — `packages/engine/index.js` is generated and emits `export { default as X }` for every `Source/**/*.js`, so both new modules needed `export default` (`npx tsc --noEmit` does NOT catch this; **a gulp build is the only gate for this class**). `npx gulp build` now passes end-to-end and all ten provenance markers are present in the built bundle. Minors fixed: the WebGPU `appearance === undefined` fallback key 3 → **0** (it would have pinned a legacy bake against a "both ON" cache signature permanently); the `SolarDiscModel` table's "worst inside 6x" row relocated to the TRUE extremum **rho = 3.2313 (radius 0.2077), delta −0.09805** (the magnitude was right, the location was not, and three files cite this table); the public `lighting` JSDoc registry in `AtmosphericConditions.js` updated with both toggles; and the "C12-19 is a one-line unclamp" claim restated as **one line GLSL / SIX sites in the WebGPU CPU twin** (four half-float, two 8-bit — and the 8-bit branch cannot carry >1 at all, so C12-19 must force the float format there). ⛔ **RECORD CORRECTED (round 3, 2026-07-25) — THE MEASURED EVIDENCE ON THIS ROW WAS MISREAD, AND THE ZERO IS NOT A WEBGPU DEFECT.** `probe-sun-glow-profile` measured `frameState.sunAtmosphereExtinction` — computed BACKEND-AGNOSTICALLY in `Sun.js` before the branch point — as **BYTE-IDENTICAL on both backends at all five near-limb steps**: `[0.723, 0.467, 0.190]` at −19.0° and `[0, 0, 0]` (< 5e-4/channel) at every step below. Both backends multiply the billboard's RGB by it (`SunFS.glsl` `out_FragColor.rgb *= u_atmosphereExtinction`; `WebGPUEnvironmentRenderer.js:116` `color.rgb * u.extinction`, fed from the same field). **Extinction 0 ⇒ a black billboard ⇒ delta 0. WebGPU's zero IS the physics executing correctly — the sun is genuinely extinguished at those elevations on BOTH backends.** WebGL's non-zero at the SAME extinction-0 steps is therefore the anomaly, not WebGPU's zero, and it cannot be billboard radiance. Leading mechanism (arithmetic, from source): WebGL's sun blends with `BlendingState.ALPHA_BLEND`, so `out = src.rgb·src.a + dst·(1−src.a)`, and with `src.rgb == 0` that is `out = dst·(1−a)` — **a black billboard DARKENS the sky by `a·dst`**, which is not a no-op; WebGPU blends additively (`src-alpha`/`one`), where `src.rgb == 0` is an EXACT identity. That single fact reproduces every observation: the residual appears exactly where the billboard is black, its magnitude tracks `bgMean`, it collapses to 0 at −22.6° (the one step where no billboard is drawn at all), and at the one NON-extinguished step (−19.0°) it makes **WebGPU read 1,176,861 vs WebGL 982,022 — 120% of WebGL, brighter, not absent**. The Batch-760 'open-sky WebGPU = 77% of WebGL' asymmetry **DOES NOT REPRODUCE**: at this geometry the two suns agree to **0.06% across every radial bin**. Batch 760 compared WebGPU's extinguished billboard against WebGL's extinguished billboard *plus* whatever else `scene.sun.show` toggles on WebGL. **This wave was therefore never the blocker for earth-limb sun dimming, and there is nothing for it to unblock — there is no visible sun there to dim on either backend.** C12-15/16/17 stand on their own merits (limb darkening, a non-terminating glare profile, bake parity), all three verified green by the round-2 Edge run. | S | — |
| `C12-16` | **Inverse-square glare falloff** replacing `1-smoothstep(0,0.55,r)`, which reaches **exactly zero at 0.55 and stays there** — real glare never terminates. **MEASURED EVIDENCE (C12-29 S1 probe, round-4 Edge run 2026-07-24):** the WebGPU sun's glow does not survive the earth limb at all — `probe-eclipse-sun-fade` lane (a) measured `glowOffRaw == glowOnRaw == 0` over the annulus at ALL 15 partial-band steps (fraction 0.990 → 0.001, effect off AND on) from a 400 km vantage, while WebGL measured a clean band there (`bandRatioMeasured` 0.491 == expected) because its ~6 R_sun glow billboard reaches above the limb. The terminating falloff is a prime suspect. Until this wave lands, visible earth-limb sun dimming is unobservable on WebGPU and `probe-eclipse-sun-fade` reports `bandTier: "NA-geometric-limb"`, deferring that proof to its open-sky moon-eclipse lane. ✅ **IMPLEMENTATION DONE (worker, 2026-07-25) — pending orchestrator landing + Edge run.** Falloff is now a pedestal-subtracted Lorentzian `(1/(1+(r/0.275)^2) - P)/(1 - P)` — a `1/theta^2` veiling-glare tail (the CIE stray-light form) — with `P` taken at the billboard's INSCRIBED CIRCLE so the profile reaches **exactly** zero there; a residual pedestal would paint a hard circular edge, and terminating on the inscribed circle keeps the termination circular so the square quad's edges never show. Measured: support **8.556 -> 11.0 R_sun**, 8-bit-visible tail **8.19 -> 10.79 R_sun**, worst in-band cost **-0.098 profile units (-0.074 alpha) at 3.23 R_sun**. The core is anchored to the legacy curve's own half-amplitude point, not a free parameter. A genuinely non-terminating tail is impossible on a finite quad and remains **C12-18's** screen-space halo. Lens-flare bursts keep their original envelope (aperture diffraction, not veiling glare). Toggle `enableSolarGlareFalloff`, **default ON**, off = the historical expression verbatim. ❌ **THE BANKED CO-SUSPECT CLAIM ON THIS ROW IS REFUTED — arithmetically, before any probe run** (pinned in `Tools/visual-regression/solar-disc-model.spec.mjs`, derived in `SolarDiscModel.js`). The bake's `radius` maps to solar radii as `rho = radius * sqrt(2) * 11` at the default glowFactor, so the legacy falloff terminates at **8.556 R_sun** — 43% BEYOND the outer edge of the 1.5x..6x annulus that measured zero — while inside that annulus the billboard's alpha runs **0.689 (1.5 R_sun) down to 0.161 (6 R_sun)**, 8-bit codes 176..41. Reshaping a falloff that is already at alpha 0.16..0.69 cannot turn a measured zero into a non-zero. Same for C12-17: the `rgba8unorm` 1/255 floor bites only beyond **8.199 R_sun** (a 4.2% radial loss) and 256 texels already oversample a ~370 px quad. **The zero has a different cause**; under WebGPU's additive `src-alpha`/`one` blend a zero difference over a whole annulus means either the background was already 255 or the sun contributed no fragments there. New `probe-sun-glow-profile.mjs` discriminates by measurement (globe-shown vs globe-hidden difference profiles, per-bin background saturation, open-sky control) with the full hypothesis table in its header and in `WEBGPU_DEBUGGING_LOG.md`. **`probe-eclipse-sun-fade`'s `NA-geometric-limb` deferral therefore stands after this wave** and must not be assumed closed by it. **ROUND 2 (2026-07-25):** the refutation is now CORROBORATED BY MEASUREMENT, not only by arithmetic — the executor's clean-main run measured the WebGPU sun at **open-sky glowOff 1,732,142 vs WebGL 2,241,410 (77%)** while contributing exactly 0 near the limb, which excludes any geometry-, falloff- or bit-depth-based cause (none of them can be geometry-selective at the limb). A concurrent fleet additionally ELIMINATED the opaque-sky-shell candidate from source: **the sun is binned AFTER the atmosphere** (`SceneRenderer.js:348-357`), so the shell cannot occlude it. What remains is absence vs depth-clip vs **saturation of the annulus by the sunlit Earth limb itself** — and `probe-sun-glow-profile` was rebuilt to separate exactly those (state-level absence check; saturation tested BEFORE occlusion; three lanes each varying one knob). Its round-1 constants were also unsatisfiable and never produced a measurement; fixed and pinned by three new spec tests. ⛔ **RECORD CORRECTED (round 3, 2026-07-25) — THE MEASURED EVIDENCE ON THIS ROW WAS MISREAD, AND THE ZERO IS NOT A WEBGPU DEFECT.** `probe-sun-glow-profile` measured `frameState.sunAtmosphereExtinction` — computed BACKEND-AGNOSTICALLY in `Sun.js` before the branch point — as **BYTE-IDENTICAL on both backends at all five near-limb steps**: `[0.723, 0.467, 0.190]` at −19.0° and `[0, 0, 0]` (< 5e-4/channel) at every step below. Both backends multiply the billboard's RGB by it (`SunFS.glsl` `out_FragColor.rgb *= u_atmosphereExtinction`; `WebGPUEnvironmentRenderer.js:116` `color.rgb * u.extinction`, fed from the same field). **Extinction 0 ⇒ a black billboard ⇒ delta 0. WebGPU's zero IS the physics executing correctly — the sun is genuinely extinguished at those elevations on BOTH backends.** WebGL's non-zero at the SAME extinction-0 steps is therefore the anomaly, not WebGPU's zero, and it cannot be billboard radiance. Leading mechanism (arithmetic, from source): WebGL's sun blends with `BlendingState.ALPHA_BLEND`, so `out = src.rgb·src.a + dst·(1−src.a)`, and with `src.rgb == 0` that is `out = dst·(1−a)` — **a black billboard DARKENS the sky by `a·dst`**, which is not a no-op; WebGPU blends additively (`src-alpha`/`one`), where `src.rgb == 0` is an EXACT identity. That single fact reproduces every observation: the residual appears exactly where the billboard is black, its magnitude tracks `bgMean`, it collapses to 0 at −22.6° (the one step where no billboard is drawn at all), and at the one NON-extinguished step (−19.0°) it makes **WebGPU read 1,176,861 vs WebGL 982,022 — 120% of WebGL, brighter, not absent**. The Batch-760 'open-sky WebGPU = 77% of WebGL' asymmetry **DOES NOT REPRODUCE**: at this geometry the two suns agree to **0.06% across every radial bin**. Batch 760 compared WebGPU's extinguished billboard against WebGL's extinguished billboard *plus* whatever else `scene.sun.show` toggles on WebGL. **This wave was therefore never the blocker for earth-limb sun dimming, and there is nothing for it to unblock — there is no visible sun there to dim on either backend.** C12-15/16/17 stand on their own merits (limb darkening, a non-terminating glare profile, bake parity), all three verified green by the round-2 Edge run. | S | — |
| `C12-17` | **WebGPU sun-texture format/size parity** — WebGPU hardcodes `rgba8unorm` at 256², WebGL selects HALF_FLOAT under HDR and sizes from the drawing buffer. 8-bit quantization of a smooth glow ramp bands visibly. **MEASURED (see the C12-16 row): the WebGPU glow contributes 0 above the earth limb across the entire fade band (15/15 steps) where WebGL measures a clean 0.491 band ratio — the fixed 256² 8-bit bake is a co-suspect with C12-16's terminating falloff.** ✅ **IMPLEMENTATION DONE (worker, 2026-07-25) — pending orchestrator landing + Edge run.** Bake size now follows WebGL's own rule `2^(ceil(log2(max(dbW, dbH))) - 2)` instead of a hardcoded 256 (capped at 1024: WebGL bakes on the GPU, WebGPU bakes in a JS double loop, and an uncapped 8K canvas would ask for a 2048^2 = 4.2 Mpx main-thread loop on every resize). Format is `rgba16float` when `frameState.useHDR`, mirroring WebGL's HALF_FLOAT selection, with an explicit binary32->binary16 packer (`Float16Array` is too new for the target browsers). Rebuild set now covers glowFactor + size + format + the C12-15/16 toggle key. **Measured honesty:** resolution is NOT the visual lever — the billboard is ~95 px wide at 1080p/60 deg, so even 256^2 was ~2.7x oversampled; the FORMAT half is the real content, and it only pays off once C12-19 removes the 0..1 clamp (half-float currently buys precision in the glare tail, where 8-bit truncated the profile at 8.199 instead of 8.556 R_sun). ❌ **The banked co-suspect claim on this row is REFUTED — see the C12-16 row for the arithmetic.** **ROUND 2 (2026-07-25):** build blocker + fallback-key minor fixed with C12-15 (same commit); `npx gulp build` green. The C12-17 acceptance arm (`c12_17_bake`, both backends 512² at 1280x720) is unchanged and now measurable, because the probe's ROI geometry was made satisfiable. ⛔ **RECORD CORRECTED (round 3, 2026-07-25) — THE MEASURED EVIDENCE ON THIS ROW WAS MISREAD, AND THE ZERO IS NOT A WEBGPU DEFECT.** `probe-sun-glow-profile` measured `frameState.sunAtmosphereExtinction` — computed BACKEND-AGNOSTICALLY in `Sun.js` before the branch point — as **BYTE-IDENTICAL on both backends at all five near-limb steps**: `[0.723, 0.467, 0.190]` at −19.0° and `[0, 0, 0]` (< 5e-4/channel) at every step below. Both backends multiply the billboard's RGB by it (`SunFS.glsl` `out_FragColor.rgb *= u_atmosphereExtinction`; `WebGPUEnvironmentRenderer.js:116` `color.rgb * u.extinction`, fed from the same field). **Extinction 0 ⇒ a black billboard ⇒ delta 0. WebGPU's zero IS the physics executing correctly — the sun is genuinely extinguished at those elevations on BOTH backends.** WebGL's non-zero at the SAME extinction-0 steps is therefore the anomaly, not WebGPU's zero, and it cannot be billboard radiance. Leading mechanism (arithmetic, from source): WebGL's sun blends with `BlendingState.ALPHA_BLEND`, so `out = src.rgb·src.a + dst·(1−src.a)`, and with `src.rgb == 0` that is `out = dst·(1−a)` — **a black billboard DARKENS the sky by `a·dst`**, which is not a no-op; WebGPU blends additively (`src-alpha`/`one`), where `src.rgb == 0` is an EXACT identity. That single fact reproduces every observation: the residual appears exactly where the billboard is black, its magnitude tracks `bgMean`, it collapses to 0 at −22.6° (the one step where no billboard is drawn at all), and at the one NON-extinguished step (−19.0°) it makes **WebGPU read 1,176,861 vs WebGL 982,022 — 120% of WebGL, brighter, not absent**. The Batch-760 'open-sky WebGPU = 77% of WebGL' asymmetry **DOES NOT REPRODUCE**: at this geometry the two suns agree to **0.06% across every radial bin**. Batch 760 compared WebGPU's extinguished billboard against WebGL's extinguished billboard *plus* whatever else `scene.sun.show` toggles on WebGL. **This wave was therefore never the blocker for earth-limb sun dimming, and there is nothing for it to unblock — there is no visible sun there to dim on either backend.** C12-15/16/17 stand on their own merits (limb darkening, a non-terminating glare profile, bake parity), all three verified green by the round-2 Edge run. | S–M | — |
| `C12-18` | **Reconcile bake vs screen-space halo** once `C11-160` lands: disc at true 0.53°, all halo from the PP chain. ✅ **IMPLEMENTATION DONE (CO-6 worker, 2026-08-07) — pending orchestrator landing + Edge run.** The row is self-contained: it ABSORBED both deps and shipped them in sequence inside one batch. **(a) `C11-115` FIRST (the ratified ALPHA_BLEND direction, §7.0):** `WebGPUEnvironmentRenderer.js` sun pipeline now blends `src-alpha`/`one-minus-src-alpha` + `one`/`one-minus-src-alpha`, the exact twin of the `BlendingState.ALPHA_BLEND` `Sun.js` sets on the WebGL command. This closes the C12-29-round-3 divergence by construction: under the old additive pair a BLACK billboard (extinction → 0 near the horizon) was an EXACT identity on WebGPU while WebGL darkened the sky by `a·dst`. Both the S1 eclipse fade and this row's halo hand-off scale ALPHA, so both are invariant to the flip. **(b) THE DISC WAS UNDERSIZED BY EXACTLY sqrt(2) — on BOTH backends, which is why no WebGL-vs-WebGPU diff could ever see it.** Derived, not measured: both bakes compare the CORNER-normalised `radius = |uv-0.5| * lengthScalar` against `radiusTS = 0.5/(1+2·glowLengthTS)`, but `radiusTS` is a fraction of the quad's HALF-EXTENT, so the shipped limb sat at **0.70711 R_sun** — **0.3767° of diameter instead of 0.5327°**. `solarBakeRadiusToSolarRadii` (landed at C12-16) already said so in one line. Fixed by resolving the disc edge in `Scene/SunHaloAppearance.js`; the shipped edge maps to **exactly 1.0 R_sun** at every glowFactor. Toggle `lighting.enableTrueSolarDiscSize`, **default ON**, OFF returns `0.5/(1+2·glowLengthTS)` **bit-for-bit**. **(c) THE HALO MOVED TO THE PP CHAIN ON BOTH BACKENDS, with `C11-160` built to do it.** New `SolarHalo.glsl` (stage 6 of `SunPostProcess`, runs LAST) + new `SolarHalo.wgsl` + new `WebGPUSunHaloEffect.ts` (runs BEFORE Bloom, mirroring WebGL where `SunPostProcess` writes into the scene FB). The profile is the SAME C12-16 Lorentzian **without the pedestal subtraction and without the support clamp** — which is precisely what `SOLAR_GLARE_SUPPORT`'s own doc comment named as C12-18's job ("the screen-space halo… has no quad to fall off"). Half-amplitude at **4.27800 R_sun = 1.1397°**, derived from `SOLAR_GLARE_CORE` through the bake's own radius→R_sun map, so screen and bake are one curve. **EXACTLY ONE HALO SOURCE IS LIVE AT A TIME by construction:** `bakeHaloGain` is DERIVED from the screen-halo decision (single assignment, `screenHalo ? 0.0 : 1.0`), never set beside it, so both a double halo and a silently glow-less sun are unrepresentable. Toggle `lighting.enableScreenSpaceSunHalo`, **default ON**; it additionally requires `scene.sunBloom` (default true) — with sun bloom off the BAKED halo is kept rather than the sun losing its glow. **(d) `C11-160` was VACUOUS before this, and the spec now pins it:** `scene.sunBloom` had NO WebGPU consumer at all (`WebGPUContext.supportsLegacySunBloom` returns `false`, so `FramebufferOrchestrator` skips the WebGL allocation, and nothing replaced it — `GraphicsContext.ts:955-965`, `WebGPUContext.ts:1866-1874`). **(e) CLT-C4 SATISFIED, with the second multiply deliberately ABSENT:** the eclipse factor multiplies the synthesised halo's amplitude (`haloIntensity = 0.75 × sunVisibleFraction`), and the DERIVED bloom paths (WebGL's bright-pass chain, WebGPU's global `BloomEffect`) inherit it for free because what they bloom is the billboard whose ALPHA `Sun.update` already scaled — adding a second multiply there would SQUARE the fade. The spec asserts the absence. **No new ShaderDefine bit** (C12 exit condition 5) — runtime uniforms only. **NUMBERS FOR THE EDGE RUN (pre-registered):** disc angular radius **×1.41421** (area ×2), so at 1080p/60° the disc goes ~3.04 px → ~4.30 px radius while the 95 px quad is unchanged; halo brightening vs the old bake peaks at **+25.1/255 at exactly 11 R_sun (2.93°)**, is +14.5/255 at 4.28 R_sun and +8.4/255 at 20 R_sun, and drops below one 8-bit code beyond **~57 R_sun (~15°)**; the bake's lens-flare bursts and glare ring DISAPPEAR from the billboard texture (they are now screen-space/absent). ⚠ **NOT claimed:** C12-15 limb darkening does NOT become visible — the screen halo re-adds ~0.71 over the disc, so the SDR clamp still masks it and C12-19 remains the row that unmasks it. **Gates:** offline `tsc` clean (only the known TS2307 generated-shader class), prettier clean, eslint clean, `sun-halo-composition.spec.mjs` **21/21**, full Node fleet **2138/2142** (the four known environmental failures only). ⚠ **`npx gulp build` COULD NOT BE RUN TO GREEN IN A LINKED WORKTREE** — the repo-root `node_modules/@cesium/engine` symlink resolves to the MAIN tree's `packages/engine`, so esbuild reads main's barrel and reports the three new exports missing. Verified directly instead: the worktree's generated `packages/engine/index.js` DOES carry `SunHaloAppearance`, `_shadersSolarHalo` and `_shadersPostProcess_SolarHalo`, and all three default exports import cleanly in Node. **The orchestrator must re-run `npx gulp build` on main after landing** — that is the only gate for the generated-barrel class. | M | `C11-160`, `C11-115` (both ABSORBED — see above) |
| `C12-19` | **True HDR sun radiance** — remove the `clamp(...,0,1)` in both bakes, retune BrightPass. ⚠ **Must be probed against both AE-on and AE-off lanes** — introducing ~10⁵ energy without that re-creates the inverse of the Batch-364 failure (the sun crushes everything else). | L | `C12-17`, `C12-18`, `C11-161` ✅ **IMPLEMENTED 2026-08-07 (CO-26) — pending orchestrator landing + the owed Edge run.** Four deviations from this definition, all deliberate and all evidenced (`FEATURE_INVENTORY.md` §B; `DEFERRED_WORK.md` 2026-08-07 C12-19 section): **(a) the clamp is SPLIT, not removed.** After C12-18 the bake's saturation binds on blue (a WHITE POINT — `+0.2` is the hue term) and, on the legacy-halo path, on alpha (the ALPHA_BLEND destination weight since C11-115 — above 1 it makes `1 - a` negative and the sun subtracts the sky). Both halves stay, componentwise bit-for-bit, and are mutant-pinned; the radiance ships as an explicit linear scale in both sun fragment shaders instead. **(b) B906's 'C12-19 is C12-15's unmasking row' is REFUTED — C12-18 already unmasked it** (default `bakeHaloGain = 0` leaves alpha `= limb(x)`, which never clamps; measured 255→76.5 codes SDR / 239.2→138.2 HDR at HEAD), and raising the radiance MASKS the law rather than unmasking it: centre-vs-limb contrast is strictly decreasing in radiance (101 codes at L=1 → 54 at L=2 → 2 at L=10 → ~0 at 10⁵). The shipped radiance is 2.0, DERIVED as `light.intensity * max(light.color)` (the `czm_lightColorHdr`/`czm_lightColor` factor), which agrees with the independently-solved half-power ceiling 2.0148 to 0.74%. The 'is half the law the right stopping rule' question is filed as a maintainer decision. **(c) a VACUITY BLOCKER was found and closed first:** `SunPostProcess` built every stage at `UNSIGNED_BYTE` and passed no `hdr` to its own `SceneFramebuffer`, so `sunBloom = true` (default) clamped the entire HDR scene to 8 bits — the radiance, the C12-18 halo and this row's bright pass were ALL unreachable above white on WebGL until fixed. **(d) the AE-on/AE-off lanes are OWED, not run** — they are a browser measurement and this batch had no Edge; every banked number is the AE-off lane. Also landed: the derived BrightPass pair (foot exactly on display white, knee exactly on `sqrt(L)`, `L≤1` → historical (0.25, 0.1) bit-for-bit) and B906's owed halo re-derivation (`haloAmplitude = 0.75 × discRadiance`). Toggle `lighting.enableTrueSolarRadiance` (default ON), exact identity OFF in both ranges; SDR safety is structural (radiance ≡ 1.0 outside HDR). Gate: `sun-hdr-radiance.spec.mjs`, 27 tests, 6 mutants rejected. |
| `C12-28` | **HDR default on HDR-capable displays** — full definition §6 (Q3). Lands AFTER `C12-07`; app-overridable; do NOT switch default tonemap to ACES. ✅ **IMPLEMENTED 2026-08-07 (Batch group CO-22) — RESOLVER SPEC GREEN; MANUAL HDR-HARDWARE CHECK OWED.** New leaf module `Scene/HdrDisplayCapability.ts` carries the whole falsifiable half: `queryHdrDisplay()` (both `(dynamic-range: high)` and `(video-dynamic-range: high)`, with `media === "not all"` treated as UNKNOWN rather than SDR), `observeHdrDisplay()` (the `change` subscription — a window dragged to another monitor re-resolves; legacy `addListener` supported; disposer returned), and the pure `resolveHdrDefault()`. `Scene.js` holds only the plumbing: constructor runs `_initializeHdrDisplayDetection()`, both public setters record an override (`_hdrUserSet` / `_useHDRCanvasOutputUserSet`, the latter recorded BEFORE the no-change early return), the detection write restores those flags so it cannot masquerade as an app assignment, and `destroy()` detaches via `removeCallback("_hdrDisplayUnsub")`. **BOTH backends in one slice** — the gate is the existing `highDynamicRangeSupported` (depth texture + float/half-float colour buffer), which WebGL2 and `WebGPUContext` both publish, and no shader, define bit or tonemap default was touched (C12 exit condition 5 respected: this feature adds ZERO ShaderDefine bits — it is pure JS state). New `Scene#hdrDisplayPolicy` (`'off'` \| `'scene'` (default) \| `'scene-and-canvas'`) is the escape hatch and the seam for the canvas half: `'scene-and-canvas'` additionally defaults `useHDRCanvasOutput`, gated on the context exposing `setHDRCanvasOutput` (WebGPU only — WebGL has no canvas-colour-space API, so forwarding >1.0 into an 8-bit canvas is refused rather than shipped as a regression) and on the EFFECTIVE scene-HDR value, so an app that pinned `highDynamicRange = false` can never end up with an extended-range canvas over an SDR framebuffer. It is opt-in deliberately — see `C12-28-CANVAS-EXTENDED-RANGE-OPT-IN` in `DEFERRED_WORK.md`. ⚠ **Acceptance is the spec, not a probe, and that is a finding rather than a shortcut:** the headline flip fires only on a display reporting `(dynamic-range: high)`; headless Edge reports the opposite and there is no CDP override for `dynamic-range` (unlike `prefers-color-scheme`), so a probe could only ever exercise the SDR leg — which is the leg REQUIRED to be byte-identical to the old behaviour, i.e. it would pass identically with the feature reverted. **Gate:** `Tools/visual-regression/hdr-display-default.spec.mjs` — 37 assertions over all five resolver inputs plus the Scene wiring, including the three named mutants (user-set wins in BOTH directions; a non-HDR display flips nothing on; eight `matchMedia`-less/malformed hosts neither throw nor decide) and a negative pin that no ACES default crept in. One incidental finding is pinned there too: `Specs/createScene.js:35` already assigned `highDynamicRange = false` immediately after construction, and under the new detect-only-until-touched rule that assignment now *sticks*, so the ~17k-assertion Jasmine suite stays display-independent when `gulp test` runs on a maintainer's HDR monitor — the spec fails if that line is ever removed. **STILL OWED:** a maintainer check on real HDR hardware — open the viewer on an HDR display and confirm `scene.highDynamicRange === true` untouched, then that `hdrDisplayPolicy = 'scene-and-canvas'` produces a correct extended-range image on WebGPU. | M | `C12-07` ✅ (landed Batch 748) |
| **Gate** | **G4** sun half, **plus the `C12-28` check: byte-identical behaviour on SDR displays.** | | |

### W5 — Moon (almost entirely shader one-liners)

| ID | Item | Effort |
|---|---|---|
| `C12-20` | **Lommel-Seeliger reflectance** — the Moon is currently a **pure Lambert sphere** (`specularStrength = 0.0`), which is why the full moon reads as a shaded ball instead of a flat bright disc. Replace `rawNdotL` with `2·NdotL/(NdotL+NdotV+ε)`; `toEyeMC` is already computed. ✅ **IMPLEMENTATION DONE (moon-wave worker, 2026-07-24) — pending orchestrator landing + Edge run.** Character-identical `2.0 * mu0 / (mu0 + mu + 1.0e-4)` on BOTH backends (`EllipsoidFS.glsl` `LUNAR_BRDF` define / `Moon.wgsl` runtime `lunarBRDF` uniform — no ShaderDefine bit), diffuse-only, respects onlySunLighting; toggle `lighting.enableLunarBRDF` default ON. NOTE for the G4 gate: LS alone gives full:quarter ≈ 2.65:1 (< Lambert's 3.14:1); the >3:1 gate is exceeded by LS + `C12-23` surge together (≈ 4.2:1) — gate the pair, not LS alone. Spec + probe shared with `C12-30` (`moon-atmosphere-appearance`). | XS |
| `C12-21` | **Phase-dependent earthshine** — currently a **constant** with no phase term, which is physically backwards: Earth's phase from the Moon is the exact complement of the Moon's phase from Earth, so earthshine should peak at new moon and vanish at full. Multiply by `(1 − phaseFraction)`, already in the uniform block. **Dep: `C11-176b` (phaseGate deletion) — land it first or the phase terms compound.** ✅ **LANDED Batch 858 (`2cb7d29fec`) — Edge acceptance OWED.** *(Wording corrected 2026-08-07: this cell read "IMPLEMENTATION DONE (worker, 2026-08-06) — pending orchestrator landing + Edge run" — written by the very commit that landed it. `2cb7d29fec` carries `MoonPhaseAppearance.js`, `Moon.js`, `EllipsoidFS.glsl` and `Moon.wgsl` on `main`; nothing is sitting in a worktree. Only the Edge run is outstanding. Ruling **R5** additionally flipped `enableEarthshine` to default **ON** the same day, so this row is no longer inert at engine defaults.)* **Dep REFUTED as pending: `C11-176b` landed in Batch 755 (`9974c59179`) and was re-verified at HEAD — nothing to land first.** The compounding risk is also structurally removed rather than merely avoided: the Earth-phase complement is resolved **CPU-side** in `Scene/MoonPhaseAppearance.js` and arrives as its own uniform, so `phaseFraction` still appears exactly ONCE in `Moon.wgsl` code (the UB declaration `moon-phase-gate.spec.mjs` pins) and never as a shader term. ⚠ **Found + fixed en route: earthshine existed in NO GLSL file at all** — a WebGPU-only celestial term, exactly the Principle-5 gap the `C11-176b` row itself flagged in passing and that nobody had closed. C12-21 therefore ships earthshine's **first GLSL implementation** (`EARTHSHINE` define + `u_earthshinePhaseScale` in `EllipsoidFS.glsl`) alongside the phase factor, making this a real lockstep pair; `computeEllipsoidColor` was given a **single exit** in the same edit (the three lighting laws returned independently, which had already forced three identical copies of the `C12-23` surge multiply — now one). Toggle `lighting.enableEarthshinePhase` default ON; OFF passes scale **exactly 1.0**, the historical constant bit-for-bit. `enableMoonPhase = false` is handled explicitly: it forces `phaseFraction` to the 1.0 sentinel, and `1 − 1 = 0` would have silently DELETED earthshine, so the resolver falls back to the constant. ✅ **RULED 2026-08-06 same evening (R5, `DEFERRED_WORK.md` ruling block): `enableEarthshine` now DEFAULTS ON.** Both stated reasons for the historical false default (the term was WebGPU-only, and it was phase-wrong) were removed by this batch, and the maintainer flipped the default the same day. C12-21 is live at engine defaults on BOTH backends; apps opt out via `lighting.enableEarthshine = false`. Verified by `Tools/visual-regression/moon-phase-terminator.spec.mjs` (27 tests): the complement law is adversarially validated against `phaseFraction` (un-complemented), a quarter-peaking tent, and the unclamped complement — **all three REJECTED**. **Numbers for the Edge run** (now the DEFAULT configuration, post-R5): unlit-limb blue goes 0.056 linear at new moon → 0.028 at quarter → **exactly 0.0 at full**; red 0.032 → 0, green 0.040 → 0. ✅ **THE OWED EDGE ACCEPTANCE NOW HAS A LANE, AND IT IS G4 (`--g4`, `earthshine` sub-lane, built 2026-08-07 CO-27) — the run is still OWED, but it is no longer un-schedulable.** Six predicates bind this row: `earthshine_lights_unlit_limb_at_crescent` (median ON−OFF delta over a GEOMETRIC unlit mask, intersected with "dark in the OFF leg" so the mask is not defined by the thing under test), `earthshine_changedPixels_at_crescent`, `earthshine_tint_blue_over_red` + `earthshine_tint_green_over_red` (scale-free, so they survive any downstream multiply — a WHITE earthshine is rejected on both), `earthshine_scales_with_earth_phase_complement` (crescent:quarter median ratio against the ratio of the **LIVE resolved `frameState.moonEarthshinePhaseScale`** values, so the criterion reads "the pixels follow the resolved scale" and cannot drift if the epochs move), and `earthshine_inert_at_full_moon`. The row's own numbers above are what the bars are derived from: the crescent bar is 0.005 against a modelled LUMINANCE delta of 0.0347 (blue 0.0493), 7× of margin. ⚠ **One correction the lane forced, found by its spec before any browser ran:** the inertness criterion CANNOT be evaluated on the unlit-limb mask, because at full moon that mask is EMPTY by geometry and its median is NaN — a healthy renderer would have gone red. It is censused over the WHOLE DISC on `peakDelta` instead. **The pre-C12-21 CONSTANT term is the named mutant and is rejected by BOTH the scaling and the inertness predicates.** | XS |
| `C12-22` | **Soft terminator** from the Sun's finite ~0.5° disc (±0.0044 in N·L). One `smoothstep`. **Dep: `C11-176b`.** ✅ **LANDED Batch 858 (`2cb7d29fec`) — Edge acceptance OWED.** *(Wording corrected 2026-08-07; see the note on `C12-21` — the "pending orchestrator landing" text was written by the commit that landed it.)* Dep discharged (see `C12-21`). ⚠ **TWO SUB-PREMISES CORRECTED.** (1) **"One `smoothstep`" is wrong, and a mutant proves it:** `smoothstep(-w, w, N·L)` returns a 0..1 GATE, not an irradiance — multiplying `max(N·L, 0)` by it leaves the dark side at exactly 0 (no softening whatever) while DARKENING the lit side, i.e. it makes the terminator harder. Shipped instead is the standard C1 quadratic wrap `f(c) = (c+w)²/(4w)` inside the band, `max(c,0)` outside: exact value AND slope match at both seams, so `w = 0` is a true identity, and the peak excess is exactly `w/4` at `c = 0`. It is high by ~18% against the exact disc integral (`w/4` vs `2w/3π`), an error of 2.7e-4 in μ0. (2) **"±0.0044" is the half-angle of a solar diameter rounded to 0.5°**; the unrounded figure is `asin(SOLAR_RADIUS/d)` = **4.64915e-3 rad = 0.26638°**, 6.6% larger, and it is measured per frame from the TRUE Sun→Moon distance (±1.7% annual swing), not hard-coded. Applied in the Lommel-Seeliger branch **only**, on BOTH backends: the WebGL phong fallbacks run inside `czm_private_phong` / `czm_phong`, shared builtins that must not grow a moon term, so leaving the fallback hard-clipped on both backends is what preserves parity. Toggle `lighting.enableSoftTerminator` default ON; OFF passes softness exactly 0.0. Lockstep pair: `SOFT_TERMINATOR` define + `u_terminatorSoftness` ↔ `Moon.wgsl` `softTerminatorMu0` + `u.terminatorSoftness` (UB grows add-only into the slot `C12-25` already opened — **352 bytes unchanged**, no BGL churn). The spec **extracts `softTerminatorMu0` from both shader texts, compiles each body as JavaScript, and requires all three implementations to agree to 1e-15** — a real cross-language equivalence check, live-verified by mutating each shader body independently. Five mutants REJECTED: bare smoothstep gate, swapped smoothstep edges, width in DEGREES, mirrored quadratic, and no-softening-at-all. ⚠ **HONEST DISCLOSURE — physically real but SUB-PIXEL at rendered disc sizes.** The band spans `2·R·w` screen px at a face-on terminator: **0.883 px at the ~190 px zoomed disc, 0.074 px at the default ~16 px disc**. What it removes is a hard binary edge, not a visibly wide penumbra — the real Moon's soft-looking terminator is TOPOGRAPHY (`C12-25`'s LOLA relief), not the Sun's angular size. **Numbers for the Edge run:** peak μ0 excess **exactly 1.16229e-3 at N·L = 0**; through Lommel-Seeliger at a representative μ ≈ 0.5 that is ΔLS ≈ **4.637e-3**, ≈ **1.62e-3 in linear radiance** at a mid-grey lunar albedo (~0.35) — a few LSB on the single terminator pixel row, zero elsewhere. If the probe measures a change wider than ~1 px at a 190 px disc, the width uniform is wrong. ✅ **THE OWED EDGE ACCEPTANCE NOW HAS A LANE, AND IT IS G4 (`--g4`, `terminator` sub-lane, built 2026-08-07 CO-27) — the run is still OWED.** Four predicates bind this row: `terminator_softness_is_solar_angular_radius` (the LIVE `frameState.moonTerminatorSoftness` in [4.4e-3, 4.9e-3] rad — the shipped mean ±1.7% of orbital eccentricity, ~3× margin — and EXACTLY 0.0 in the OFF leg, asserted as the byte-identical identity the module documents), `terminator_band_exists`, `terminator_no_pixel_darkened` (bar EXACTLY 0: `softTerminatorMu0(c,w) ≥ max(c,0)` for every c, proven pointwise in the spec over 4,001 samples, so this is the model's own property and not a tightened bound — it is what rejects the `smoothstep` GATE mutant the module's docstring names, which DARKENS the lit side), and `terminator_band_is_local` (changed ÷ disc ≤ 10% against a modelled 0.6%, which rejects a softness applied to the whole disc). **This row's "~1 px at a 190 px disc" is the reason the lane overrides the field of view to 22°:** the band is `2wR` pixels wide, i.e. 1.0 px at the default framing (unmeasurable) against **2.7 px at the lane's 289 px disc**, and the lane brackets that leg at 1×/8×/**64×** so a 1.6e-3 linear delta is ~46 code values rather than ~6. Nothing is resized — the same disc is sampled onto more pixels, exactly as G2's telescope framing does for the star PSF. | XS |
| `C12-23` | **Opposition surge** — lunar brightness rises >40% between phase angles 4° and 0°, beyond anything Lambert or Lommel-Seeliger predicts. Cheap here: for a distant decorative moon α is effectively constant across the disc, so compute once CPU-side and pass one uniform. **Zero per-pixel cost.** ✅ **IMPLEMENTATION DONE (moon-wave worker, 2026-07-24) — pending orchestrator landing + Edge run.** New `Scene/computeLunarOppositionSurge.js`: Hapke (1986) SHOE `B(α)=1+B0/(1+tan(α/2)/h)`, B0=0.6, h=tan(0.5°) ⇒ B(0)/B(4°)≈1.43 (spec-pinned ≥ 1.4, Buratti 1996), <1% by α=90°; true Sun–Moon–observer angle CPU-side, one uniform on BOTH backends (`OPPOSITION_SURGE` define / `oppositionSurge` UB member, 1.0 identity); toggle `lighting.enableOppositionSurge` default ON. | S |
| `C12-24` | **NASA CGI Moon Kit albedo swap** (1k/2k). `moonSmall.jpg` is **256×128**, so the visible hemisphere is 128 texels over a ~190 px disc = **0.67 texels/px, under-resolved**. Re-opens `C4-CELESTIAL-HIRES-MOON` on corrected premises — **drop its altitude-blend half** (that would open a parity gap). ✅ **IMPLEMENTATION DONE (worker, 2026-08-01) — pending orchestrator landing + Edge run.** Ships SVS 4720 `lroc_color_poles_2k.tif` (2048×1024, sha256 `13b7974…52c4a`) as `Assets/Textures/Moon/lroc_color_poles_2k.jpg` (JPEG q90 4:4:4, 563,276 B) behind a new `Moon.Variant` / `Moon.defaultVariant` switch mirroring `SkyBox.Variant`; `moonSmall.jpg` retained as `Moon.Variant.SMALL`. Reproducible bake + hash pin at `Tools/moon-albedo-bake/`; `LICENSE.md` → Bundled Engine Assets entry added. **Alignment was verified computationally, not by an Edge run** (the row's premise that only Edge could confirm it was wrong): five named lunar-landmark checks (`Tools/moon-albedo-bake/lunar-landmarks.mjs`) pin the 0°-centred / east-right / north-top convention the shared `atan2/asin` unwrap requires, and are **adversarially validated** — all five of `shift180`/`mirrorLon`/`mirrorLat`/`mirrorBoth`/`rot180` are REJECTED. Swap is **texture-only, no shader change**, so no lockstep row. ⚠ **Found + fixed en route: the WebGPU moon albedo was rendering vertically MIRRORED against WebGL** — WebGL's `Texture` defaults `flipY:true`, `copyExternalImageToTexture` defaults `false`, and both backends share `v = asin(n.z)/π + 0.5`; invisible on the soft 256×128 map, obvious at 2K. Fixed at the upload layer (holds for user-supplied `textureUrl` too). ⚠ **Open risk for the Edge run: mip aliasing.** Neither backend mipmaps the moon (WebGL `Material.js` never calls `generateMipmap`; WebGPU is `mipLevelCount` 1 + `textureSampleLevel(…, 0.0)`). At the ~16 px default-camera disc this is ~64:1 minification at mip 0 vs the old map's ~8:1 — a pre-existing shimmer made worse. See `C12-26`. | S |
| `C12-33` | **IMPLEMENTED / LANDED Batch 819 — ACCEPTANCE OWED, do NOT mark complete. C12-35 PREREQUISITE PASSED / design corrected 2026-08-02.** Execution began 2026-08-02 in three independently reviewable lanes: Moon-local WebGL mips, the canonical frame-owned WebGPU texture-mip queue and Moon realization, and the lockstep shader/implicit-LOD correction. Neither backend mipmaps Moon textures at the starting point, so the 2K albedo minifies ~64:1 at the default camera. C12-35 moved WebGL Moon realization out of generic Material loading: generate mips Moon-locally after direct `Texture` creation, use trilinear sampling, and retain the WebGL1 NPOT single-level fallback. WebGPU allocates the exact mip count on each lifecycle candidate, queues generation through the context's frame-owned shared texture-mip lane (generalize the existing imagery-named enqueue; no private submit), cancels any same-frame destroyed texture job, and uses a trilinear sampler. Flatten the opaque Moon fragment's front/back selection to one `computeEllipsoidColor` call, then compute longitude-unwrapped `dFdx`/`dFdy`/`dpdx`/`dpdy` BEFORE the fragment-varying miss discard and sample albedo and normal with explicit `textureGrad` / `textureSampleGrad` — the shipped design; see point 2 of the 2026-08-02 corrective overlay above (§"The implementation corrects the earlier design note"), which supersedes this row's earlier implicit-`textureSample` and CPU-single-LOD prescriptions. Sharing the same normalized UV gradients does not couple the two maps' LOD (hardware scales them by each texture's dimensions), while one CPU LOD scalar would oversmooth one map. Pin opacity and test the equirectangular seam/limb/close views. Land mips before the optional 2K normal rebake. Shader change ⇒ lockstep row plus Naga and moving Edge shimmer/parity/seam evidence. | M |
| `C12-25` | **LOLA-derived normal map** for terminator relief (NASA ships displacement, not normals — offline derivation step). ✅ **IMPLEMENTATION DONE (worker, 2026-08-02) — pending orchestrator landing + Edge run.** Ships `Assets/Textures/Moon/ldem_normal_1k.png` (1024×512, 8-bit RGB PNG, 679,782 B, sha256 `5e215ee…a87e9`) derived from SVS 4720 `ldem_16.tif` (5760×2880 float32 km, sha256 `1ea42bf…d796`); reproducible bake + hash pin at `Tools/moon-albedo-bake/bake-lola-normals.mjs`, `LICENSE.md` → Bundled Engine Assets entry added. Paired with `Moon.Variant.LROC_COLOR_2K` (default ON via `lighting.enableLunarNormalMap`); `Moon.Variant.SMALL` ships **no** map, preserving the legacy flat look. ⚠ **PREMISE CORRECTED: SVS publishes no 2K displacement map** — verified by HEAD request, `ldem_2k/1k/512.tif` all 404 while the six real members (4/16/64 px per degree, float32 + uint16) all 200. `ldem_4` (1440×720) was rejected as the source because it is COARSER than the output grid. ⚠ **Output is 1024×512, not 2048×1024, deliberately:** neither backend mipmaps the moon (`C12-33`), so at the default ~16 px disc a 2048-wide map is ~64:1 minification off mip 0 — and normal aliasing flickers the *lighting*, not the colour. 1K still leaves ~2.7 texels/px at the ~190 px zoomed disc, and costs 664 KB against 2.92 MB. `--width 2048` re-bakes in one flag once `C12-33` lands. **Encoding measured, not assumed:** JPEG q90 4:4:4 costs **1.26° mean / 9.47° max** normal-tilt error against a signal whose own mean tilt is 2.73° — rejected; 8-bit lossless PNG costs 0.173°/0.347°; 16-bit PNG is 1.9× the size to remove an error already 14× below the median signal. **Derivation:** area-average the height field to the shipped grid *then* central-difference (an area filter cannot ring, and the next step differentiates); longitude stencil widened to `round(1/cos(lat))` texels so the east baseline stays a constant GROUND distance (10,660.6 m, equal to the north baseline at W=2H); rows past a pole wrap ACROSS to the antipodal longitude rather than clamping. Measured p99 tilt 10.53° — which is the whole point, since near the terminator N·L≈0 and a 10° facet flips lit/unlit, while at full phase the same facet changes brightness ~1.6%. **Both backends wired, and this one IS a lockstep pair** (unlike C12-24's texture-only swap): `EllipsoidFS.glsl` `LUNAR_NORMAL_MAP` ↔ `Moon.wgsl` `@binding(3)` + `u.normalStrength`, both rebuilding the east/north/up basis in MODEL space from the same expression; UB 336→352 add-only. Strength resolved ONCE in `Moon.update` and published as `frameState.moonNormalMapStrength`, so the backends cannot disagree. Verified computationally by `Tools/visual-regression/moon-normal-map-asset.spec.mjs` (19 tests): crater-bowl polarity at Tycho + Copernicus, independently signed in red and green, adversarially validated against `flipGreen`/`flipRed`/`swapChannels`/`mirrorLat`/`mirrorLon`/`flatten` (**all six REJECTED**, and a flipped-Y map fails `craterNorthSouthPolarity` + the end-to-end illumination check while leaving the east/west check untouched); plus direct pins on the derivation math (a constant east GROUND slope reproduces exactly at lat 0/30/60/80) and a no-polar-ring assertion (pole bands measure 0.86× / 1.42× the global mean tangential tilt). ⚠ **Found en route: the `Moon.wgsl` row in `SHADER_PAIRS_LOCKSTEP.md` was WRONG** — it claimed WebGL has no moon shader and renders the moon "through a CZML/Entity path". WebGL renders it through `EllipsoidPrimitive` → `EllipsoidFS.glsl`, which has been `Moon.wgsl`'s lockstep twin since C12-20/C12-23. Corrected, and `Moon` removed from the doc's fork-only list. **Historical readiness notes (superseded):** Readiness notes now recorded in `Tools/moon-albedo-bake/README.md` §7: `ldem_*.tif` sits on the **same SVS 4720 page with the same 0°-centred projection**, so `lunar-landmarks.mjs` and its coordinate helpers apply unchanged and a derived normal map should be alignment-checked with the same geometry (plus a slope-sign check — a mirrored green channel is exactly the silent error class those checks exist for). Units: float32 km on a 1737.4 km sphere (or uint16 half-metres on 1727400 m); the longitude step must be divided by cos(lat) or relief shears toward the poles. **The binding is still the gate:** WebGL needs a material extension (`Material.ImageType` has one image slot; `EllipsoidFS.glsl` already computes `tangentToEyeMatrix` and discards it), WebGPU needs `@binding(3)` in `Moon.wgsl` (3 is free — 0/1/2 are UB/albedo/sampler) reusing the binding-2 sampler, plus matching BGL + bind-group entries; the 336-byte UB has no spare 16-byte slot, so any new scalar extends it add-only at the tail. Both must use the same `flipY:true` upload `C12-24` established, or relief lights from the wrong side on one backend only. Ship as a second variant-gated asset. **EDGE RUN 2026-08-02 (Batch 813, `probe-moon-lola-relief.mjs`): GATE PASS, 8 lanes, 0 errors.** Terminator (half-phase) relief ON-vs-OFF moves 1.30% of the center crop on BOTH backends — PNGs show a crater-serrated terminator ON vs a smooth arc OFF, exactly where N·L grazes; cross-backend parity 0.00% ON and OFF (twin shaders sub-threshold identical). Full-phase ON-vs-OFF reads 1.46% — larger than half-phase on the pixel-COUNT metric because the predicted ~1.6% whole-disc brightness movement hovers at the diff threshold across the whole lit disc, while half-phase change concentrates at the terminator; magnitude-wise it is the flat-cosine regime the design predicts, not a visible texture. | M |
| **Gate** | **G4** moon half — gate the **phase curve**, not a single frame: a single image cannot distinguish Lambertian from Hapke, the full:quarter brightness ratio can. | |

**Do NOT spend effort on** libration (already exact — IAU 2000 E1–E13 series supplies physical libration implicitly and optical libration falls out of the real ephemeris) or angular size (real radius at real ephemeris distance, 32.9′ perigee / 29.5′ apogee). Libration is an explicit non-goal at `FEATURE_INVENTORY.md:1078`; angular size is a non-goal by construction (already exact — real radius at real ephemeris distance; the inventory carries no entry for it).

### W6 — Adjacent: file, don't fold

| ID | Item | Effort |
|---|---|---|
| `C12-26` | **`NEW-EARTH-LIMB-AIRGLOW-EMISSION`.** The green band in the maintainer's ISS reference is O I 557.7 nm nightglow (~90–105 km); the red-orange band above is O I 630.0 nm from the F region. These are **emissive and sun-independent**. `SkyAtmosphere` is a *scattering* model whose `nightAlpha` drives the shell to zero opacity on the dark side — **there is no code path in which it could produce a limb band at night.** This is a new emissive limb shell. **File as its own row; do NOT expand `C11-176..179` to cover it.** | M–L |
| `C12-34` | **`NEW-SKY-BRIGHTNESS-ESTIMATOR-NO-TWILIGHT-RANGE` (filed by C12-29 S6, 2026-07-25 — Principle 9, surfaced rather than routed around; originally numbered `C12-S6F1` in the parked S6 worktree, renumbered on extraction 2026-08-01 because `C12-33` was taken).** `Scene/SkyBrightness.js`'s sun term is `smoothstep(-0.1, 0.4, sunAlt)` (`:168`, verified still live on main), which reaches EXACTLY 0 once the sun is below **−5.74°** and saturates at 1 above **+23.6°**. It therefore carries **no dynamic range at all across the twilight decade**, where the naked-eye star count actually changes: civil twilight, nautical twilight and astronomical night all map to the same input value, 0. Two measured consequences shipped with the E3 default flip and are recorded in `StarFieldMath.ts` rather than tuned away, because the modulation curve has two parameters and cannot separate states the ESTIMATOR has already collapsed: a full moon overhead lands at factor **0.01818 (−4.35 mag, NELM ≈ 2.2** against a published full-moon ≈ 4.5 — the Milky Way correctly vanishes, but ~2.3 mag too deep), and mid civil twilight (sun −2°) lands at **exactly 0**, where real observers still have Venus and one or two first-magnitude stars. **FIX SHAPE:** replace the double-smoothstep with a **log-luminance** estimate (published twilight sky-brightness vs solar depression — e.g. Patat et al. 2006 / standard twilight photometry curves) and re-derive the two curve constants against it, keeping the totality anchor. Both consumers already read one shared pair of constants (`STAR_MODULATION_INFLECTION` / `STAR_MODULATION_STEEPNESS`), and `eclipse-sky-totality.spec.mjs` re-derives them from the totality anchor, so **the re-derivation has a gate waiting for it**. Also worth folding in: the moon term is a flat 4% perceptual constant with no photometric derivation. ✅ **IMPLEMENTED (worker, 2026-08-02; LANDED Batch 823) — ENGINE-LEG EDGE ACCEPTANCE **PASSED** at Batch 824, star-PIXEL leg still OWED as an instrument gap; not COMPLETE. See the EDGE ACCEPTANCE paragraph at the end of this row.** The double-smoothstep is replaced by a log-luminance model in `SkyBrightness.js`: the sun term is the published zenith twilight-photometry ladder (μ in V mag/arcsec² — sunset 8.0, end of civil −6° 14.0, end of nautical −12° 19.7, astronomical night −18° 21.9, day 4.0 saturating at the SAME +23.6° the old smoothstep did), the moon term is the published full-moon zenith brightness (18.0, i.e. `10^(0.4·3.9) − 1 = 35.31` night-sky luminances) scaled by a `p^3.64` phase-flux law (`0.5^3.64 = 0.0802`, the published quarter-moon ≈8% of full-moon illuminance) instead of a flat 4% with LINEAR phase, the two sum in **linear** luminance, and the combined log-luminance passes through a perceptual transfer derived from the Crumey/Schaefer NELM relation at 0.5 mag NELM per mag/arcsec². **The curve constants are CONFIRMED, not moved:** the transfer is built so `modulation(B(μ))` IS the NELM chain `10^(−0.4·0.5·(21.9 − μ))` throughout the star window, which pins the pair at the shipped (inflection 0, steepness 23.0) and keeps the S2 totality anchor bit-exact. **MEASURED:** ≤ −18° and ≥ +23.6° are BYTE-IDENTICAL (exactly 0 and exactly 1). Across −18°→−6° the old star-factor span was **exactly 0.000000**; it is now **0.973697** (−15° 1.000000→0.604705, −12° →0.363078, −9° →0.098257, −6° →0.026303). Civil twilight: −3° 0.370549→0.006619, and −2° goes from **exactly 0** to 0.004175 — NELM 0.55, the row's "Venus and one or two first-magnitude stars". Full moon overhead 0.018176→**0.165959** (9.13×, −4.35 mag → −1.95 mag, NELM 2.15 → **4.55** against the published ≈4.5 — the row's headline defect, closed). High-sun totality is unmoved at 0.062810 (−3.00 mag); low-sun totality 0.5246→0.664912 (−0.44 mag). **Second finding, fixed en route:** `computeStarDayFade` and the estimator each carried their OWN normalize-and-dot of the camera position. They are now one exported `computeCelestialElevationSine` — the single home C15's aurora night-gate is to reuse — and the spec fails if a second one reappears. **Third finding, fixed:** the log-luminance model's "no sun" value is the DARK end, so a non-finite input would have inverted the module's documented "misconfigured scene → full bright" policy into a bright starry midnight; one degenerate-input policy is now stated and pinned. **Fourth finding, corrected:** `eclipse-sky-totality.spec.mjs`'s off-anchor test asserted the old numbers through an INLINE COPY of the deleted sun term — it would have stayed green while describing an estimator that no longer exists. It now runs the real `computeSkyBrightness` (51/51). **NO SHADER CHANGED** — the scalar travels on the existing `u_skyBrightness` / `params.w` uniform — so no `SHADER_PAIRS_LOCKSTEP.md` row and no naga run is owed; the spec asserts the four modulation implementations stay byte-identical and that neither backend grew a copy of the photometry. **Gate:** `node --test Tools/visual-regression/sky-brightness-twilight.spec.mjs` **27/27**, executing the real `SkyBrightness.js` + `StarFieldMath.ts` (no re-implementation), every metric banded or pointwise, with five MUTATION tests that feed the checks the exact legacy estimator, a binary day/night gate, a 1e-6 epsilon floor, a linear moon phase and a re-inlined second elevation derivation, and require each check to REJECT them. ⚠ **Edge acceptance still owed, and one known downstream effect to measure:** `FIXTURE_NIGHT_MAX_SUN_ELEV_DEG = −8°` in `lib/eclipse-fixture-constraints.mjs` was derived when the estimator saturated to 0 below −5.74°; the star modulation factor at that fixture instant is now **0.063390 (NELM 3.51), a ~16× dim**, not 1.0. `dayFade` is still exactly 1 so the constraint and threshold stand and `probe-eclipse-sky-totality`'s gated verdicts are unaffected (B4 counts command ownership; lane D's sprite/cubemap deltas are reported diagnostics), but the prose has been corrected and any future lane needing factor === 1 must ask for ≤ −18° explicitly.  **EDGE ACCEPTANCE 2026-08-06 (orchestrator, `probe-sky-twilight-range.mjs`): ENGINE + CONTROL legs PASS.** The SHIPPED SkyBrightness module, imported from the served source tree and driven at clock-SOLVED solar elevations, reproduces the derivation EXACTLY to six decimals on BOTH backends: -20deg 1.000000 (control, byte-identical end), -15deg 0.604705, -9deg 0.098257, -3deg 0.006619, webgl == webgpu bit-for-bit, 0 console/device errors. The probe's star-PIXEL leg reports STRUCTURAL (not FAIL): the star field drew nothing at the darkest lane in that configuration, so the leg measured an empty sky and its verdict is meaningless either way - an owed instrument gap, NOT a product verdict. Three earlier probe rounds were orchestrator instrument defects worth recording because the first presented exactly like a feature that never shipped: an object-literal call (the signature is POSITIONAL) hit the module's documented misconfigured-scene guard and returned a uniform 1.000000 on every lane; then sky BRIGHTNESS was compared against STAR-MODULATION predictions; then the pixel leg used a synthesized sun while the renderer drew with the clock's sun, so the two legs described different scenes. ⛔ **THAT LAST CORRECTION IS ITSELF INVERTED, AND THE STRUCTURAL PIXEL LEG ABOVE WAS AN INSTRUMENT DEFECT — root-caused and repaired 2026-08-07.** The landed probe does the OPPOSITE of what this row and commit `43caae0589` record: the ENGINE leg is clock-SOLVED, and the PIXEL leg rendered at the **WALL CLOCK**. `probe-sky-twilight-range.mjs:77` sets `useDefaultRenderLoop = false`, which kills `CesiumWidget.render()` — the only caller that passes `clock.tick()` into `Scene.render` — and every render in the file was then a bare `s.render()`, which `Scene.js` answers with `JulianDate.now()`; `SceneUtilities` stamps that onto `frameState.time` and `UniformStateComputations` derives `sunDirectionWC` from it, so `v.clock.currentTime = jd` reached no pixel. The commit landed at 15:31 UTC = ~08:31 local solar at the probe's site (lon −105 / lat 40), i.e. **full daylight** — which is precisely why "the star field drew nothing at the darkest lane". **The recorded `starPx` numbers from that run are VOID and must not be carried forward.** The file was byte-identical from `43caae0589` to HEAD, so it was unfixed for the whole interval. **REPAIR (2026-08-07):** every render now passes `at()` (= `v.clock.currentTime`, read per call so it tracks the current lane); the capture is same-task (`renderAndGrab` renders, reads `uniformState.sunDirectionWC`, and `drawImage`s with no intervening await, closing the separate rule-2 violation); and a new **RENDER-TIME leg** reads the sun back OUT of the rendered frame and requires each lane's rendered solar elevation to sit within `RENDERED_ELEVATION_TOL_DEG = 1.0°` of the elevation its clock was solved for AND the four lanes to be ≥ `RENDERED_ELEVATION_MIN_SPREAD_DEG = 2.0°` apart — so a wall-clock substitution, which collapses all four lanes onto ONE sun, cannot recur silently. The in-file comment claiming the sun is "synthesized … rather than solved from a clock" (the fingerprint of a clock solve retrofitted without touching the render call) is corrected. **Exit codes changed: 0 PASS \| 1 FAIL \| 3 STRUCTURAL.** The ENGINE-leg acceptance recorded above is UNCHANGED and unweakened — it never depended on the render call — but an exit 0 could not distinguish "both legs certified" from "one leg measured nothing", and this row is the case for the distinction. **Re-run owed:** the ENGINE/CONTROL numbers should reproduce bit-for-bit; the PIXELS leg is now measuring for the first time. | M |

---

## 5. Gates and exit

**Acceptance is measured, never eyeballed — and never by mean luminance.** Convolution with any normalized kernel preserves the mean exactly, so mip-averaging, bilinear magnification, MSAA resolve and JPEG smoothing all move **zero** on a mean diff. A tonemap shoulder is worse than mean-neutral: it can *raise* the mean while flattening the highlight tail. Every gate below is second-order.

| Gate | Covers | Headline criterion |
|---|---|---|
| **G1** | Skybox fade | Camera **on the sunlit side, Sun ≥ 25° above local horizon** — the only framing that reaches the failure state. M1 source-count ratio ≥ 0.90; RMS-contrast and P99.9−P50 ratios ∈ [0.85, 1.15]. **Mean luminance is diagnostic only and explicitly non-certifying.** *Expected already-green at HEAD: Batch 722 landed the fix and the §6 Q2 measurements are effectively this gate passing — G1 is held as a REGRESSION gate, baselined by `C12-01` in W1.* |
| **G2** | White blobs | **`r_1e-3 / r_core ≥ 8`** — a Gaussian truncated at `d=1.0` cannot exceed ~1.8, so this one number separates blob from star. Plus: two agreeing log-log slopes in [−5,−2]; <25 clipped px/star; rendered brightest:faintest ≥ 15:1 (today **4:1** by construction). ✅ **BROWSER LANE BUILT 2026-08-07 (CO-3) — `probe-celestial-gates.mjs --g2`; Edge acceptance OWED (first run ever).** Per ruling `C12-G2-DEF` the browser gate binds the ratio on the **composite-HWHM** definition at **≥ 4** (analytic core-component ≥ 8 stays in `starfield-psf.spec.mjs`); simulated through the shipped display chain at the lane's telescope framing the shipped PSF scores **7.20** and the OLD truncated Gaussian **1.79**, so the bar separates with 1.8× margin both ways. "<25 clipped px/star" is evaluated in **linear scene radiance against the LDR white point of 1.0**, not against 8-bit code 250 — under PBR Neutral radiance 1.0 renders as code 239 and code 250 is radiance ~1.91, so the two definitions differ by ~1.9×. "Rendered brightest:faintest" is `min(peak_brightest, 1.0) / peak_faintest`, exactly the quantity `StarFieldMath.ts` anchors the exposure against (16.7:1). **C12-27's acceptance criterion is carried verbatim as the third sub-lane.** See the 2026-08-07 CO-3 overlay above for the full predicate list. |
| **G3** | Asset upgrade | ≤ 2.0 arcmin/px; ≥10× sources/steradian vs the t3 baseline; median chroma ≥ 0.20 (**fails immediately under 4:2:0 JPEG**, so it doubles as the format gate); **dust-lane structure** via low-pass residual IQR ≥ 3× current. ✅ **BROWSER LANE BUILT 2026-08-07 (CO-24) — `probe-celestial-gates.mjs --g3`; Edge acceptance OWED (first run ever).** Five sub-lanes per backend (`asset`, `split`, `catalogue`, `adversarial`, `motion`), 18 bound predicates, must pass IDENTICALLY on both. **⚠ PRE-REGISTERED RED, and the red is in the ASSET, not the instrument:** measured offline from the bundled bytes, the shipped `TYCHO_T5_DIFFUSE` faces score **2.637 arcmin/px** (2048/face against the ≥2700 bar), **median chroma 0.000** (against 0.20), and a dust-lane IQR ratio of **0.585×** t3 (against 3×) — and the **un-blurred t5 misses the same three**, so criteria (1)/(3)/(4) were never reachable with the SVS product Q1 selected at the size C12-10 encoded. **This is not a DR-01 consequence.** Criterion (2) is superseded as certifying by DR-01 (the cube map carries no resolved sources by ruling) and re-pointed onto the split + catalogue arms, with the literal ratio still measured and reported as reversal trigger `spriteDensity` (delivered **228/sr** vs t3's **1,311/sr** = 0.174×). Bars marked RATIFIED are held unmoved; the research text's own "the σ and 3× need one calibration pass against the chosen asset" is now discharged — **that pass says the bar is missed.** See the 2026-08-07 CO-24 overlay above. |
| **G4** | Sun + Moon | Sun: `r_1e-3/r_core ≥ 10`; angular diameter within 5% of 0.5334°; `I(0.95R)/I(0)` ∈ [0.3,0.5]. Moon: full:quarter integrated-brightness ratio must exceed the Lambertian ~3:1. ✅ **BROWSER LANE BUILT 2026-08-07 (CO-27) — `probe-celestial-gates.mjs --g4`; Edge acceptance OWED (first run ever), and that first run IS `C12-21`/`C12-22`'s owed acceptance.** Six sub-lanes per backend (`policy`, `disc`, `halo`, `earthshine`, `terminator`, `phase`), **41 bound predicates per backend** at this commit (43 counting the two gated arms), plus 8 cross-backend fold predicates, must pass IDENTICALLY on both. Three §5 clauses are re-pointed or gated and each says so in its own row below: **(a)** `r_1e-3/r_core ≥ 10` is the STAR PSF and is already bound by G2 under ruling `C12-G2-DEF` — it is not re-measured on the Sun, whose profile is a limb-darkened disc plus a veiling-glare halo, not a point spread function; **(b)** `I(0.95R)/I(0) ∈ [0.3,0.5]` is a **PENDING ARM on `C12-19`** — both sun bakes still `clamp(...,0,1)`, which their own comments say makes limb darkening arithmetically invisible in the default bake, so the ABSOLUTE ratio is dominated by the C12-18 screen halo. The arm self-activates from two independent live discriminators, reports `STRUCTURAL-pending-content:C12-19` BY NAME, and the ratio is measured and printed every run. Limb darkening's PRESENCE and SHAPE are certified meanwhile by a differential (`limbDarkening` OFF passes `(1,0,0)`, i.e. `I ≡ 1`, so the halo cancels EXACTLY); **(c)** the moon full:quarter bar is **REACHABILITY-GATED** on the phase angle — the C12-20 row requires the LS + C12-23 surge PAIR to be gated together, and the shipped surge contributes ≥10% only within 5.0° of opposition (derived from its own `h = tan(0.5°)`), so outside that the arm reports STRUCTURAL and prints the number rather than failing the gate for a framing it could not reach. Adds the B906 pin `disc_trueSizeRatio_is_sqrt2` (1.41421 ± 5%, measured at PIXELS from the two toggle positions) and the C12-28 SDR leg with a LIVE positive control. See the 2026-08-07 CO-27 overlay above. |

**C12 closes when all four gates pass on both backends at HEAD, with:**

1. Every manifest attributable to a commit **and a recorded adapter pairing** (`C12-03`/`C11-175`).
2. **Zero default-ON WebGPU-only celestial multipliers remaining** — an audit asserting that for every celestial uniform gate (`enableStarBrightnessModulation`, cloud-cover occlusion, `enableMoonPhase`, `enableEarthshine`, `enableNightSkyDimming`) either a GLSL consumer exists **or** the default is off. **The exit gate closes the CLASS, not the instance** — this bug family has now produced three separate defects. **C13 coordination note (2026-07-23): the cloud-cover-occlusion half of this audit inspects code now owned by Campaign 13 — run it read-only against C13's HEAD and route any fix to C13; do not double-schedule.**
3. `FEATURE_INVENTORY.md` updated (celestial WIP §C → §B; airglow added to §D).
4. `LICENSE.md` third-party attributions current with live URLs and exact credit strings.
5. **No new `ShaderDefine` bits consumed** — the registry is exhausted, so any C12 quality toggle uses a **runtime uniform float** (the pattern `C11-163` already mandates). (Consequence: `C11-149` define-width is NOT a C12 dependency; needing it would itself be a scope violation.)

---

## 6. MAINTAINER DECISIONS — ANSWERED 2026-07-19

**Q1 — Gaia-derived imagery → ANSWERED: take the t5 path.** SVS 3572 `TychoSkymapII.t5_16384x08192`. Sidesteps the CC BY-NC 3.0 IGO incompatibility entirely; same product family, already covered by the `# Bundled Engine Assets` entry (`LICENSE.md:1024-1044`, Batch 730 — its Files line at `LICENSE.md:1030` explicitly extends coverage to any `SkyBox.Variant` derived from the same SVS product). **NASA SVS 4851 Deep Star Maps is DISQUALIFIED — do not revisit.**

**Q2 — Where observed → ANSWERED: "Both while in orbit."** This is load-bearing and it *re-scopes the symptom*:

- **Measured at HEAD (post-Batch-722), WebGPU and WebGL are at parity on BOTH sides.** Night lane (`skyBrightness = 0`, so the fixed modulation is inert by construction): mean **1.002**, star pixels **0.999**, contrast 1.033, brightest-0.1% 1.064. **`secondCausePresent: false`.** Sunlit lane: mean 1.002. Evidence: `probe-skybox-star-modulation.mjs`, night + sunlit lanes.
- **Therefore the residual "faded" impression on the night side is NOT a WebGPU-vs-WebGL defect — it is ABSOLUTE faintness that both backends share**, and its cause is already identified: the fork ships **t3, the variant SVS itself describes as *"the Milky Way is very faint"***. That is exactly what `C12-10` (t5 re-bake) fixes. Two different defects were being reported as one symptom; the parity half is closed, the asset half is not.

**Q2b — NEW REQUIREMENT surfaced by the same answer:** *"I understand that looking towards the sun should dim stars near it but I am not seeing that effect either."* **This is correct physics and the fork implements the wrong model for it.** The removed `enableStarBrightnessModulation` was a **global** dim keyed to the Sun's *elevation above the camera's local horizon* — it dimmed the entire sky uniformly, including stars 180° away from the Sun. In orbit there is no atmosphere, so there is no sky glow and no global dim; what genuinely washes out stars near the Sun is **ocular / instrument glare, which is ANGULAR** — a function of each star's angular separation from the Sun, not of the Sun's elevation. So the maintainer is asking for a feature the codebase never had, while the thing that *was* there was a physically wrong stand-in for it. Filed as `C12-27`.

**Q3 — HDR default → ANSWERED: on by default only where the browser/display actually reports HDR.** Not a blanket flip. Filed as `C12-28`.

**Q4 — Seam magnitude → ANSWERED: option (a) implemented via (c) — DECISION RECORD DR-01 (§6c), decided 2026-07-19 by the maintainer, with a documented reversal plan. Its licensing condition was discharged by §6f. `C12-10`/`C12-11` carry the implementation obligations; `C12-09` is promoted to load-bearing.**

### New items from these answers

| ID | Item | Effort | Wave |
|---|---|---|---|
| `C12-27` | **`NEW-ANGULAR-SOLAR-GLARE-STAR-WASHOUT`.** Dim/wash stars as a function of **angular separation from the Sun**, replacing the deleted global elevation-keyed model. Physically this is the same glare-spread function as `C12-05` (Stiles–Holladay inverse-square, `Lv(θ) ∝ 1/θ²`) applied to the *sky* rather than to a single sprite — so it should reuse that math, not invent a second curve. Must land on **both** backends (the deleted model was WebGPU-only; re-adding a WebGPU-only version would recreate the exact parity bug just fixed). Applies to both the cubemap and the sprite pass. Gate: stars at small angular separation dim measurably while stars at >90° separation are byte-identical to the no-Sun frame. | M | W2 (with the PSF work) |
| `C12-28` | **`NEW-HDR-DEFAULT-ON-HDR-CAPABLE-DISPLAYS`.** Default `highDynamicRange` from actual display capability rather than a hardcoded `false` — `window.matchMedia("(dynamic-range: high)")` (and/or `(video-dynamic-range: high)`), with the WebGPU canvas configured for extended range where supported. **Constraints:** must remain explicitly overridable by the app; must not change behaviour on SDR displays (byte-identical); and because enabling HDR engages PBR Neutral's highlight compression, `C12-07` (the chroma-preserving profile that fixes the blob **without** HDR) stays the first increment and this lands **after** it. ⚠ Do NOT switch the default tonemap operator to ACES as part of this — `acesTonemap` ends in a per-channel `clamp(0,1)` that maximizes hue-shift-to-white on exactly these pixels. ✅ **IMPLEMENTED 2026-08-07 (CO-22)** — see the `C12-28` row in §5 for the full record. Three deviations from this definition, all deliberate: (a) the `(video-dynamic-range: high)` clause is implemented as a **fallback**, not an OR-equal peer — it is consulted only when `(dynamic-range: high)` is not understood by the browser, which is what the "and/or" was hedging; (b) **unknown ≠ SDR** — a host with no `matchMedia` (Node, jsdom, `node --test`) yields `displayIsHdr === undefined` and the resolver applies NOTHING, which is the mechanism that delivers the "byte-identical on SDR displays" constraint rather than merely intending it; (c) "with the WebGPU canvas configured for extended range where supported" ships as the **opt-in** `Scene#hdrDisplayPolicy = 'scene-and-canvas'` rather than as part of the default flip, because it is unverifiable without HDR hardware and has no WebGL counterpart — recorded as `C12-28-CANVAS-EXTENDED-RANGE-OPT-IN` so the absence reads as a decision, not an omission. | M | W4 (after `C12-07`) |

---

## 6g. LAUNCH DECISIONS — ANSWERED 2026-07-23 (maintainer)

**LD-1 — paused-C11 dependencies → TRANSFER (as recommended).** `C11-79`, `C11-80`, `C11-160`, the `C11-115` implementation (direction stays RESOLVED: ALPHA_BLEND), `C11-161`, and `C11-175` transfer into C12 with IDs retained as aliases (C13 precedent). Slotting: `C11-175`→`C12-03`; `C11-79`/`C11-80`→`C12-04` (C11-80 lands before C11-79 — it retains star commands); `C11-160`+`C11-115`-impl→`C12-18`; `C11-161`→`C12-19`. The C11 ledger rows are closed as TRANSFERRED.

**LD-2 — §3 split items → PULL IN (as recommended).** `C11-176b` and `C11-176c` become C12 W1 riders (IDs retained; 176c is in flight with the Phase-1 trio worker at time of ruling; 176b lands BEFORE `C12-20..23` so the Batch-517 crescent probe re-baselines once). `C11-SEED-07` folded into `C11-179` in the C11 queue; `C11-177`/`C11-179` deep design is C12-owned per the 2026-07-23 audit.

**LD-3 — DR-02 relaxation:** unanswered; safe default stands (the three DR-02 conditions BIND for `C12-09`: HEASARC sourcing, factual fields only, own schema).

**C12-10 STATUS: ✅ COMPLETE + VISUALLY VERIFIED (Batches 742/744).** t5 baked, bundled beside t3, default flipped; serial-Edge verification: gate PASS (backend parity mean 1.002 / contrast 1.045 / starPct identical 5.587; opt-in modulation dims to 0.477; night lane 1.002), PNGs read on both sides (crisp colored stars, true blacks, no seams). During verification a LATENT PROBE DEFECT was root-caused and fixed (Batch 744): bare `scene.render()` renders at wall-clock NOW while the widget's default loop renders at the pinned clock — two suns interleaving; exposed by Batch 734's cloud frame-demand. Probe now kills the default loop, renders at pinned time, and captures same-task. ⚠ FLEET NOTE: any probe that pins a clock AND calls bare `scene.render()` has the same latent defect — audit at next probe touch.

**C12-10 amendment (maintainer, 2026-07-23): "Yes but we want T3 available offline too."** The t5 bake must NOT displace t3: **both variants stay bundled in the repo** (t3 faces remain at `Assets/Textures/SkyBox/tycho2t3_80_*`; t5 lands beside them), both selectable via `SkyBox.Variant` with no network fetch, and `defaultVariant` flips to `TYCHO_T5` only once the t5 faces are in-tree. The Bundled Engine Assets LICENSE.md entry already covers both (its Files line spans variants of the same SVS product).

**Context ruling recorded with these:** C11 certification is **HELD** (maintainer 2026-07-23) — the body executes before any certification; and C13 execution transferred from Sol 5.6 (out of capacity) to the orchestrator, who takes over the in-flight C13-37 tree.

## 6b. Original decision text (retained for context)

### MAINTAINER DECISIONS REQUIRED BEFORE LAUNCH

**Q1 — Gaia-derived NASA imagery: acceptable or disqualified?** *(blocks `C12-10`, therefore all of W3)*
NASA SVS 4851 "Deep Star Maps 2020" is technically the best asset available (1.7 B stars, native OpenEXR, pre-split diffuse-vs-bright) — but two of its three layers are **Gaia DR2-derived**, and ESA states verbatim that Gaia data are **CC BY-NC 3.0 IGO**. Non-commercial is **incompatible with MIT**. NASA redistributes the result as public domain without marking it third-party-copyrighted; the counter-argument (raw astrometry is arguably uncopyrightable under *Feist*) is **not something engineering should rely on** — a rendered image is a creative work. **Recommendation: take the SVS 3572 t5 path instead** — same product family, same attribution, already covered by `LICENSE.md:1042`, and it directly delivers the dense Milky Way requested. **Default if unanswered: t5.**

**Q2 — Where exactly was the fade observed?** *(determines whether the Batch-722 fix is the whole answer)*
The fixed mechanism only fires when the Sun is **above the camera's local horizon** (50% dim at ≥ ~24° elevation, **zero dim at night**). If the WebGL-vs-WebGPU comparison was made on the **night side**, that bug contributed nothing and there is a second cause still at large. A saved-view URL or a rough description (day side / night side / terminator; altitude) settles it.

**Q3 — HDR default: hold at off, or opt in for celestial scenes?** *(determines whether `C12-07` is the destination or a stepping stone)*
`highDynamicRange` is false by default on both backends, which is *why* bright stars clip to an 8-bit plateau. The chroma-preserving profile (`C12-07`) fixes the blob **without** HDR — recommended first increment. The physically correct end state (halo from real HDR energy through bloom) needs HDR on, which engages PBR Neutral's highlight compression and has a broad parity blast radius across the whole PP chain. ⚠ Related trap: **do not switch the default tonemap operator to ACES to "fix the sun"** — `acesTonemap` ends in a per-channel `clamp(0,1)`, maximizing hue-shift-to-white on exactly these pixels.

**Q4 — Star-map / sprite seam magnitude.** *(blocks `C12-09` and `C12-11`)*
Either (a) bake a **bright-star-free** cubemap — more work, requires custom rendering rather than using an SVS product as-shipped, but architecturally correct and what makes "thousands of resolved stars" reachable; or (b) accept a small overlap and compensate in sprite intensities. **Recommendation: (a).**


---

## 6c. DECISION RECORD DR-01 — star-map / sprite seam (answers Q4)

**Decided 2026-07-19 by the maintainer: option (a), implemented via (c).** The cubemap carries **diffuse light only**; **every resolved star comes from the sprite catalogue**. Explicitly **CONDITIONAL ON LICENSING** — maintainer's words: *"if there are no license restrictions to doing this and shipping it."* See §6d (since retracted by §6e). **That condition is DISCHARGED: §6f resolved the licence question for this project's scope on 2026-07-19. DR-01 is now unconditional unless a §6f reopen trigger fires.**

### What was chosen

| Option | Description | Chosen |
|---|---|---|
| (a) | Bright-star-free texture; sprites are the sole source of resolved stars | ✅ **YES** |
| (b) | Keep stars in the texture, accept the double-draw, compensate sprite intensity | ❌ fallback — see reversal plan |
| (c) | Practical implementation of (a): low-pass the t5 bake to destroy point sources, keeping only the diffuse Milky Way | ✅ **the method** |

### Why (not just "it's cleaner")

1. **Painted stars are dead pixels.** They cannot receive *any* of the work C12 exists to do — no Moffat halo (`C12-05`), no B−V blackbody colour, and critically **no angular sun-glare** (`C12-27`), because a baked texel cannot respond to sun angle. Leaving bright stars in the texture would produce a visibly inconsistent sky: sprite stars with halos beside painted blobs without them.
2. **The double-draw over-brightens exactly the stars reported as blobs.** The texture contains every star; the sprite pass redraws the 92 brightest on top (measured at HEAD: vmag ≤ 2.5 across the 263-entry catalog). t5 makes this worse — SVS describes it as *"bright stars are large"*.
3. **(b) is more fragile than it looks.** SVS deliberately non-linearizes the magnitude→intensity curve (boosting faint stars for visibility). A compensation factor would be reverse-engineering a curve we do not control and which differs per variant.

### Binding scope consequence (maintainer-stated)

> *"This means we need to have the same bright star effects for WebGL & WebGPU."*

**Confirmed and binding.** This is natural rather than costly — `StarFieldFS.glsl` and `StarField.wgsl` are already character-identical and share `StarFieldMath.ts`. But it makes three things non-negotiable: every new uniform/attribute is plumbed on **both** backends in the **same** slice; **G2 must pass identically on both**; and no sprite feature may be WebGPU-only. Re-introducing a WebGPU-only celestial effect would recreate the exact bug class `C11-176` just closed (three instances and counting).

### Cost accepted

`C12-09` (catalogue extension toward mag ~6, ~5,000 stars) is **promoted from optional to load-bearing**. With the texture no longer supplying point sources, the catalogue is the *only* source of star density — the ISS-reference look now depends on it. `BrightStarCatalog.js` currently holds 263 entries (measured at HEAD: `data.length` 1052 / `STRIDE` 4; the file's own docblock still says "~230") and the full 9,110-entry BSC5 is **not vendored**, so this is a real data ingest.

### REVERSAL PLAN — how to fall back to (b) after seeing results

The design is **deliberately reversible**, and the reversal is cheap because the blur is the *last* stage of the bake pipeline.

1. **Keep both bake artifacts.** `C12-10` must emit **the un-blurred cube faces as well as the blurred ones** and check in both (or make the blur a documented one-command re-run). This is the single most important reversibility requirement — **if only the blurred artifact survives, reversal costs a full re-bake.**
2. Ship the un-blurred faces; restore `MAG_CUTOFF` to the overlap value.
3. Apply a compensation factor to sprite intensity across the overlap band.
4. **Do NOT revert `C12-05/06/07`** (PSF, quad extent, amplitude restructure). Those are independent of the seam decision and improve option (b) as well.
5. **Do NOT revert `C12-27`** (angular sun-glare) for sprites; accept that texture-painted stars will not participate — that asymmetry is precisely the cost of (b).
6. Cap sprite magnitude at the texture's threshold so the extended catalogue does not double-draw faint stars.

### What would justify reversing (decide on evidence, not impression)

- The blurred Milky Way reads as a **smear** rather than granular structure — i.e. `G3`'s dust-lane metric passes but the result still looks wrong to the eye. *(Capture both bakes through G3 to compare.)*
- Sprite count required for ISS-reference density proves **prohibitive** at low altitude / wide FOV.
- The `C12-09` catalogue ingest proves materially harder than budgeted.
- Faint-star sprites **alias or twinkle** unacceptably under camera motion (sub-pixel sprites are the classic failure).

### Evidence to capture during W3 so this is decidable

- `G3` dust-lane + source-density metrics on **blurred vs un-blurred** bakes, side by side.
- The `M6` split (sprites-only vs texture-only) — already specified, and it directly measures where density comes from.
- Frame-cost delta from ~5,000 sprites on both backends.

---

## 6f. ✅ RESOLVED — project scope makes this moot (2026-07-19, maintainer)

**Read this before §6e or §6d. The licence question is closed for this project's actual scope, and the earlier analysis is retained only for the case where that scope changes.**

**Maintainer-stated scope as of 2026-07-19:** a personal side project; **not affiliated with Cesium GS**; **not redistributing the fork or the code**; non-commercial.

**Under that scope both readings converge on GO:**

- **Permissive reading (§6e):** the NC term never attaches, because CC BY-NC 3.0 IGO §1 licenses a database only as to selection and arrangement, §2 disclaims reaching uses free from copyright, and the SVS rendering takes neither.
- **Most restrictive reading** (assume NC fully attaches): **personal, non-commercial, non-redistributed use is precisely what CC BY-NC affirmatively grants.** That is the licence operating as designed, not an exception carved out of it.

Substantially all of the §6e risk analysis was driven by **redistribution** and the **onward MIT grant** — CC §4(a) *"You may not sublicense the Work"*, the propagated-defective-grant problem, and the affirmative representation that a blanket MIT grant makes to downstream consumers. **With no downstream, none of those have anything to attach to.**

**The one residual wrinkle is already handled.** A public GitHub repository is arguably publication, and this repo carries an MIT licence file. The `# Bundled Engine Assets` section added to `LICENSE.md` (Batch 730) explicitly carves the skybox assets **out** of that blanket grant and states their own terms, so even the nominal onward grant does not sweep them in.

**Consequences:**

- **t5 is cleared to proceed** for this project. `C12-10` is unblocked; `W3` is no longer licence-blocked.
- **Keep the attribution** (`Credit: ESA` + NASA/GSFC SVS). It costs nothing, honours the BY term under either reading, and concedes nothing on NC.
- **Do NOT send the `data.licences@esa.int` email.** It was recommended only against commercial exposure that does not exist here; sending it would invite an adverse written record for no benefit.
- **§6e's mitigations 1, 2, 3 and 5 are already done** (credits, engine-section filing, analysis written into the repo, swappable asset path via `SkyBox.Variant`). Mitigation 6 (filing an upstream issue at CesiumGS) remains optional and is a courtesy, not a need.

**⚠ WHAT WOULD REOPEN THIS.** The scope statement above is the load-bearing fact. If **any** of the following becomes true, **stop and re-read §6e in full before shipping further**: the fork is redistributed or published as a package; it is used commercially or by an employer; a third party is granted rights to it; or it acquires a licensee or downstream consumer. The analysis in §6e is intact and directly applicable to that situation — it was not wrong, it was answering a harder question than this project actually poses.

---

## 6e. ⚠ THE §6d NO-GO IS RETRACTED — revised ruling: CONDITIONAL GO (2026-07-19, later same day)

**§6d below is superseded. Its reasoning was wrong and is formally retracted; read this section first.** Triggered by the maintainer's question: *"if upstream is already using t3 there must be a reason it can right? which should mean we can also use t5?"* A re-examination steelmanning **both** sides overturned the analysis.

### Where §6d went wrong

It reasoned "ESA states CC BY-NC → SVS 3572 names those catalogues → therefore encumbered" — **moving from a licence _statement_ to a legal _right_ without ever asking whether the licensor owns the thing being licensed.** It never engaged *Feist*, never read the licence text ESA itself chose, never checked the sui generis term, and never noticed that CC 3.0 does not license sui generis rights at all.

### The decisive finding — on ESA's own words, not contested doctrine

**CC BY-NC 3.0 IGO §2, verbatim:** *"Nothing in this License is intended to reduce, limit, or restrict any uses free from copyright protection."*
**§1**, defining the licensed object for databases: a database is a Work *"by reason of the selection and arrangement of its contents constitut[ing] an intellectual creation."*

ESA's instrument therefore claims exactly one thing about a catalogue — the intellectual creation in its **selection and arrangement** — and expressly disclaims reaching anything else. **The SVS rendering takes neither:** it plots ~2.4M of Tycho-2's ~2.5M stars (a take-everything, archetypally *unoriginal* selection), arranged by **physical sky position** in plate carrée (dictated by nature, not by ESA's table order), with every expressive choice NASA's own (gaussian PSFs, B−V → effective temperature → CIE tristimulus → RGB).

### Supporting findings, all fetched and verified

- **ESA's operative terms are archive-scoped** (data *"contained in the ESA Space Science Archives"*) and a targeted extraction for any derived-works, visualization, third-party or redistribution clause returned **ABSENT**.
- **NASA did not take Tycho from ESA.** SVS 3572 cites `archive.eso.org` — the European Southern Observatory, a different organisation. No privity with ESA's terms, which form only on archive access.
- **Sui generis right has EXPIRED.** Directive 96/9/EC Art. 10(2) gives 15 years from 1 Jan following publication: Hipparcos (1997) expired **2013-01-01**; Tycho-2 (2000) expired **2016-01-01**.
- **CC 3.0 IGO is silent on sui generis rights** (verified by direct fetch) — so even a live database right would not carry the NC condition. _This cuts both ways: it also means CC 3.0 grants no sui generis rights to anyone; only expiry confers permission._
- **EU copyright limb closes via CJEU C-604/10 _Football Dataco_**: *"the significant labour and skill required for setting up that database cannot as such justify such a protection if they do not express any originality in the selection or arrangement."* The EU's functional analogue to *Feist*.
- **Timing:** CC 3.0 IGO did not exist until 2013-12-06; SVS 3572 is dated 2009-01-26. Wayback places the CC BY-NC sentence's appearance on ESA's Hipparcos page between **2025-01-06 and 2025-05-26**. _Stated fairly: this is a fact about ESA's web publishing, not about ESA's rights — there is no notice formality — and our conduct would be prospective._

### The maintainer's inference — half falsified, half correct

- **"Upstream must have had a reason" → AFFIRMATIVELY FALSIFIED.** A controlled search of CesiumGS (control query "skybox" returned 25 issues, proving the index works) found **zero** issues, PRs, commits or discussions on Tycho/Hipparcos licensing. What exists: a one-line 2012 commit (`4c8b32dc7e` "Added images for sky box"); an attribution stub naming **no licence**, filed under the heading *"Example Applications"* despite the asset shipping from `packages/engine/Source/Assets/Textures/SkyBox/` **inside the published npm package**; a provenance URL that now 404s. Cesium's own `CONTRIBUTING.md:84` requires opening an issue before adding third-party material — **no such issue exists. The reason upstream can ship it is that nobody looked.**
- **"t3 fine ⇒ t5 fine" → CORRECT, and the step is legally EMPTY.** Same SVS 3572 product at different resolution tiers, identical provenance, no resolution-dependent term anywhere. So the real question was never t3-vs-t5; it was *"is either clear?"* — answered above, on the merits.
- **Consequence: §6d's "pre-existing condition" framing was also wrong.** Status quo is **not** the cautious option. If t5 were unshippable, so is the t3 already shipping. That option has no coherent rationale.

### The honest counterweight — the thing to sit with

The permissive case's own weakest point, found while *verifying* it rather than attacking it: **the sui generis analysis is weaker for Tycho-2 specifically than for Hipparcos**, because Tycho-2 expressly merges star-mapper data with ~144 pre-existing ground-based catalogues, which looks like qualifying *"obtaining"* investment under CJEU C-203/02 *BHB*. The ruling does **not** rely on BHB — expiry carries that limb on its own — but a careful reader should know the fallback is thinner than the headline.

**Still UNCONFIRMED:** whether ESA's sentence even nominally reaches Tycho-2 (a Copenhagen Obs./USNO/ARI/ESO product, not an ESA SP-1200 issue; ESA's own Tycho-2 page carries no licence statement at all); and whether any Art. 10(3) substantial-change event reset the term (no evidence found, absence not affirmatively verified).

### Calibrated risk

Only **ESA** could assert. They would have to claim copyright in a *rendering they did not make*, of *facts they cannot own*, against a party that **never accepted their terms**, under an instrument whose §2 disclaims exactly that reach — and for the sui generis limb, under an **expired** right. Likelihood of assertion: **very low**. Realistic consequence: a request to stop, an asset swap, a `LICENSE.md` correction. **Not damages.** Six JPEGs behind `SkyBox.createEarthSkyBox` is not a load-bearing dependency — and `SkyBox.Variant` (Batch 728) already makes replacement a config change.

**Scienter, stated plainly:** commissioning this review means proceeding *knowingly*. Cesium added t3 in 2012 in an innocent-inheritance posture; we would not be. That does not make a weak claim strong, but it converts an inherited exposure into an elected one.

### RECOMMENDATION — ship t5 under "option 2", ESA email in parallel (not as a gate)

**Decouple the asset from the blanket MIT grant.** Ship the skybox under its own documented terms in `LICENSE.md` — attribution + full provenance — rather than sweeping it into MIT's `sublicense`/`sell` grant. This costs a paragraph and removes the CC §4(a) *"You may not sublicense the Work"* exposure and the propagated-defective-grant problem **without conceding that NC ever attached**. It strictly dominates shipping it under blanket MIT.

Mitigations, all cheap, all worth doing whether or not the analysis is right:

1. Credit *"Credit: ESA"* and *"NASA/Goddard Space Flight Center Scientific Visualization Studio"*. **Do not conflate BY with NC** — only NC conflicts with MIT; the BY half is free to honour.
2. File under the **engine** section of `LICENSE.md` (not "Example Applications"), with the full provenance chain and its own terms line.
3. **Write this analysis and its gaps into the repo** — upstream's failure to do so is the concrete defect this research actually found; repeating it would be the real mistake.
4. Send the `data.licences@esa.int` email. A non-answer is itself informative.
5. Keep the texture behind the swappable asset path (`SkyBox.Variant` — already done).
6. Consider filing an upstream issue at CesiumGS so the t3 gap is documented rather than silently inherited by thousands more users.

**What flips this back to NO-GO:** any ESA response asserting rights; discovery of an Art. 10(3) term reset for Tycho-2; retrieval of 2009-era ESO/ESA terms showing NASA acquired under a restrictive grant; or the fork gaining a commercial licensee whose counsel wants documented clearance rather than a defensible theory. Substituting a clean-provenance skymap remains **an afternoon away** if any of those land.

**What must NOT be recorded:** the framing *"upstream does it, so we can."* That is the one justification the evidence positively rules out. Record this as **"we assessed a low residual risk on stated grounds and accepted it"** — never as *"it is clear."*

Confidence: high on US copyright, moderate-to-high on EU, moderate on contract. **Not legal advice; not counsel.** If the fork carries meaningful commercial exposure, route to a lawyer rather than acting on this analysis.

---

## 6d. ~~LICENSING RULING — NO-GO for the t5 path~~ (2026-07-19) — **SUPERSEDED BY §6e, REASONING RETRACTED**

**The maintainer's condition was *"if there are no license restrictions to doing this and shipping it."* There are. DR-01's asset half is BLOCKED.** Verified by a 4-lane primary-source review with independent confirmation; nothing was downloaded or baked.

### The blocker

SVS 3572 declares exactly two source datasets — **"Hipparcos Catalogue" and "Tycho 2 Catalogue"** ([svs.gsfc.nasa.gov/3572/](https://svs.gsfc.nasa.gov/3572/)) — and ESA states verbatim on its own catalogues page: **"The Hipparcos and Tycho Catalogues are distributed under the CC BY-NC 3.0 IGO licence"** ([cosmos.esa.int/web/hipparcos/catalogues](https://www.cosmos.esa.int/web/hipparcos/catalogues)).

That is the **identical licence instrument, from the identical rights holder**, that this project already used to disqualify SVS 4851. The operative precedent was never "Gaia is bad" — it was *"an ESA catalogue under CC BY-NC 3.0 IGO anywhere in the derivation chain is disqualifying."* **SVS 3572 fails that test on Hipparcos alone**, independently of any Tycho-1/Tycho-2 ambiguity. CC BY-NC's bar on use "primarily intended for or directed toward commercial advantage" cannot be reconciled with MIT's grant to "use, copy, modify, merge, publish, distribute, sublicense, and/or sell."

### Two defences that do NOT work

1. **Blurring does not launder it.** SVS 3572 has no separate diffuse layer — the Milky Way band _is_ the plotted catalogue stars: _"Stars fainter than the threshold magnitude… have their magnitude-intensity curve adjusted so they appear brighter than they really are. This makes the band of the Milky Way more visible."_ Low-passing **aggregates** catalogue content rather than destroying it, and the download step copies the full image verbatim regardless. **This invalidates option (c) as a _licensing_ strategy** — it remains sound as an image-processing technique for whatever source we are cleared to use.
2. **"NASA publishes it as public domain" does not reach the inputs.** NASA's guidelines carve out material where NASA has incorporated third-party content, and NASA neither indemnifies nor warrants. §105 is separately shaky for 3572 itself — both credited animators are non-civil-servants.

### Status of each asset

| Asset | Verdict |
| --- | --- |
| SVS 3572 t5 image | **ENCUMBERED via its declared source catalogues.** A hard stop, not a judgement call — an express contrary statement from the rights holder, not silence to interpret. |
| Hipparcos / Tycho-2 data | **ENCUMBERED.** CC BY-NC 3.0 IGO; ESA requires prior written authorisation (`data.licences@esa.int`) for any use generating financial gain. |
| Yale BSC5 (already vendored, ~230 stars) | **UNCONFIRMED — not cleared, and not prohibited either.** No licence instrument exists in either direction. See DR-02. |

### Routes forward, in cost order

1. **Drop 3572; source the Milky Way from a provider whose terms affirmatively permit commercial redistribution and derivatives.** Recommended. ⚠ **ESO GigaGalaxy Zoom (CC BY 4.0) was rejected earlier on _technical_ grounds only — it is licence-clean and should be re-evaluated now that licensing is the binding constraint.** Any replacement must be cleared by checking the licence of **every declared source dataset**, not by keyword-scanning for the mission name that burned us last time.
2. Email `data.licences@esa.int` for written clearance — must permit onward sublicensing by downstream MIT consumers, which is a high bar.
3. Obtain a written statement from NASA/GSFC SVS that 3572 is distributed free of third-party restriction.

### ⚠ Pre-existing condition — surfaced, NOT introduced by this work

**The fork already ships `tycho2t3_80_{px,py,pz,mx,my,mz}.jpg`, derived from the same SVS 3572 product**, attributed at `LICENSE.md:1042`. Established by `git log`: these files are **inherited from upstream CesiumJS** (present in `upstream/main`, first committed 2022-11-01 by a Cesium developer). Upstream ships them under Apache 2.0 — the same commercial grant as MIT. **This is an upstream condition the fork inherits, and it is a maintainer/counsel decision, not an engineering one.** Recorded because the analysis above makes it known; taking no action is a legitimate choice, but it should be a _chosen_ one.

### DR-02 — BSC5 provenance claim corrected (action already taken)

`BrightStarCatalog.js` is **fork-added** and its docblock asserted BSC5 _"is in the PUBLIC DOMAIN"_. **That claim was unsupported and has been withdrawn in code**, replaced with what is actually established: freely available but with no licence instrument in either direction; §105 inapplicable (Hoffleit = Yale, a private university; Warren = ST Systems Corporation, a contractor — federal hosting confers nothing); the vendored fields are uncopyrightable _facts_ under _Feist_ in the US; no ESA-catalogue encumbrance; higher exposure in the EU under the Database Directive.

**Consequences for `C12-09`** (extend to ~5,000 stars) — **gated, not blocked**. Required conditions: source from **NASA HEASARC**, not VizieR (removes EU sui-generis database-right exposure for what would be a substantial extract of 9,110 records); vendor only RA/Dec/Vmag/B−V, dropping remarks/notes/spectral commentary; re-sort under our own schema rather than shipping V/50's row order. Cheapest conversion from UNCONFIRMED to defensible is a one-line written confirmation from CDS (`cds-question@unistra.fr`) and/or Yale.

**Excluded substitutes — do not reach for these:** Hipparcos, Tycho, Tycho-2, any ESA Space Science Archive product (all CC BY-NC 3.0 IGO); HYG (CC BY-SA copyleft _and_ embeds Hipparcos); AT-HYG (Gaia DR3). "Use a Hipparcos-derived subset instead" walks straight back into the SVS-4851 failure mode.

### Effect on the campaign

- **W3 (`C12-10..14`) is BLOCKED** pending a cleared Milky Way source. Do not download or bake 3572.
- **W2 (`C12-05..08`) is UNAFFECTED and becomes the lead wave** — the PSF, quad-extent, amplitude and dynamic-range work operates on the _already-vendored_ catalogue and delivers most of the visible improvement with no new asset.
- **`C12-09` is gated** on the DR-02 conditions above.
- **DR-01's reversal plan is unaffected** — option (b) is now _more_ likely, since it requires no new asset at all.

---

## 7. Cross-campaign dependencies (do NOT double-schedule)

| Already-queued C11 ID | Interaction |
|---|---|
| **`C11-160`** sunBloom → PP wiring | **The single largest contributor to "the sun looks like a blob."** `sunBloom` defaults **true** and drives the full `SunPostProcess` chain on WebGL, but is gated off on WebGPU. WebGL ships a wide blurred halo by default; WebGPU ships the bare quad. It is a **routing** task against existing tested WGSL, not new authoring. C12 W4 depends on it. |
| **`C11-115`** sun blend → ALPHA_BLEND | RESOLVED-as-decision. Additive over a bright sky independently pushes the sun core to flat white. Do not re-open. |
| **`C11-161`** AutoExposure demand-gate | A **perf** item, not a parity fix. Do not re-scope it as a celestial cause. |
| **`C11-79` / `C11-80`** celestial retained resources / starfield single submission | **NOT STARTED and DORMANT — C11 is PAUSED (2026-07-23), "imminent" no longer holds** (`QUEUE_2026-07-18_CAMPAIGN11.md:690`). `C11-80` retains star commands and must land before `C11-79`. **LAUNCH DECISION (LD-1):** transfer both into C12 W1 with IDs retained (C13 precedent), or ratify C12-edits-first with a written rebase contract for the paused rows. Until decided, `C12-04` and every W2 renderer edit is blocked. |
| **`C11-163`** celestial water reflection | `C12-14` would discharge its documented biggest blocker (no samplable star cubemap) for free. |

**⚠ Launch precondition (2026-07-23, LD-1):** Campaign 11 is PAUSED. Every C11 row this queue depends on — `C11-79`/`C11-80` (C12-04 + W2 sequencing), `C11-160` (C12-18), `C11-161` (C12-19), `C11-175` (C12-03) — is NOT STARTED there (`QUEUE_2026-07-18_CAMPAIGN11.md:690,706,707,721`); `C11-115` is resolved-as-decision only (ALPHA_BLEND direction ratified, implementing code NOT STARTED). Maintainer must choose before launch: (i) execute these rows as C12-hosted prerequisites retaining their C11 IDs as aliases (the C13 transfer pattern — they are all celestial-scoped), or (ii) launch with `C12-03`/`C12-04` degraded and W4's `C12-18`/`C12-19` blocked until C11 resumes, which leaves G4's sun half unreachable at campaign close and requires re-scoping the exit criteria. Under either choice, schedule W4 as `C12-15/16/17` first (dependency-free today). Also note `C12-14` discharges the `C11-163` blocker into a paused campaign — still worth doing; the payoff waits on C11.

---

## 8. Scaffolding notice (Principle 7 — do NOT delete)

`Shaders/WebGPU/Environment/Sun.wgsl` is **not** the production shader (the renderer compiles an inline `SUN_SHADER_WGSL` string), but it already contains a **limb-darkening prototype**, a corona term, and a `generateSunTexture` compute entry point that would replace the CPU bake — it is a starting point for `C12-15`/`C12-17`, not dead code. The same trap applies to `Shaders/WebGPU/CubeMapPanorama.wgsl`, which has drifted from the production embedded string and still carries a "TODO: decode sRGB → linear" that **is already implemented** in the renderer. **Anyone diagnosing from the `.wgsl` files will chase already-fixed bugs.**
